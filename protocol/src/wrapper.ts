/**
 * The shell functions, emitted by the tool they wrap.
 *
 * `fh-toolkit` and `mt-agent` both run as containers, and both need a fiddly `docker run`
 * line to be useful: a bind mount that makes `$PWD` the operator directory, `-i` for the
 * prompts, a guarded `-t`, `/etc/hosts` so Proxmox hostnames resolve. Until now that line
 * lived only in the docs, and operators pasted it once — which meant it went stale
 * silently. It did, on 2026-09-06: the `mt-manifest` → `fh-toolkit` rename shipped and the
 * only operator saw nothing, because his shell still defined `mt-manifest()` against an
 * image name that no longer publishes.
 *
 * So the image emits the wrapper instead. The text lives beside the code that requires it,
 * a test asserts the docs still show the same bytes, and `--update-wrapper` re-installs it.
 *
 * Pure: every function here returns a string. Writing the file is the caller's job, and on
 * the `--update-wrapper` path it is the SHELL's job, because the CLI runs inside the
 * container and cannot see `~/.fh-toolkit.sh`.
 */
import { AGENT_IMAGE } from "./scaffold";
import { BuildInfo } from "./build-info";

/** The image this CLI ships as. */
export const TOOLKIT_IMAGE = "ghcr.io/w2vy/fh-toolkit:latest";

/**
 * Bumped whenever the emitted text changes in a way an operator needs to pick up.
 *
 * The wrapper passes it in as `FH_WRAPPER`, so the container can tell a current wrapper
 * from a stale one from one predating the handshake entirely (`undefined`). That is the
 * whole point of the exercise — a stale wrapper used to be undetectable from either side.
 */
export const WRAPPER_VERSION = 1;

/** Where `--update-wrapper` installs, unless the operator overrides it. */
export const WRAPPER_RC = "${FH_TOOLKIT_RC:-$HOME/.fh-toolkit.sh}";

/**
 * How long the toolkit may go without checking for a new image.
 *
 * Was 48h. Measured 2026-09-06 against both registries: `docker pull -q` on an image that
 * is already current costs ~1.0s (ghcr) / ~1.4s (Docker Hub) — it fetches the manifest,
 * matches the digest and downloads nothing. A redundant pull IS the cheap check, so there
 * is no separate check worth writing, and 15 minutes is affordable: once per session (the
 * interactive session pulls at the wrapper, not per command), ≤4/h, far under any limit.
 */
export const REFRESH_MINUTES = 15;

/** `find -mmin` wants minutes; keep the two in step. */
const STALE_MMIN = REFRESH_MINUTES;

export interface WrapperOptions {
  /** Stamped into the header so a pasted wrapper can be traced to a build. */
  build?: BuildInfo;
  /** Which functions to emit. Default: both. */
  only?: "toolkit" | "agent";
}

function header(build: BuildInfo | undefined): string {
  const from = build
    ? `fh-toolkit ${build.version}${build.sha ? ` (${build.sha.slice(0, 12)})` : ""}`
    : "fh-toolkit (source checkout)";
  return `# Shell functions for the Flux Hub operator tools — GENERATED, do not edit.
#
# Emitted by ${from}, wrapper format v${WRAPPER_VERSION}.
# Regenerate with:  fh-toolkit --update-wrapper
#
# Source it from your shell rc, with a line that never needs to change again:
#   [ -f ~/.fh-toolkit.sh ] && . ~/.fh-toolkit.sh
#
# bash/zsh — it uses \`local\`, so it is not POSIX \`sh\`.`;
}

/**
 * The `fh-toolkit` function.
 *
 * Four things in it are load-bearing and each has cost someone an afternoon: `-i` (without
 * it `init` prints one prompt and exits at EOF), the GUARDED `-t` (without the guard the
 * same function dies with "the input device is not a TTY" inside a script), the `$PWD`
 * mount (which is why every command takes no path argument), and the stamp file (`docker
 * run` never re-pulls, so without it you run your first-ever image forever).
 */
export function toolkitFunction(): string {
  return `fh-toolkit() {
  local img=${TOOLKIT_IMAGE}
  local stamp="\${XDG_CACHE_HOME:-$HOME/.cache}/fh-toolkit.pulled"
  # \`--refresh\` and \`--update-wrapper\` are consumed HERE and never passed on: the CLI runs
  # inside the container and can neither replace its own image nor write to your home
  # directory. Alone each does its job and stops; followed by a command it runs that too.
  if [ "$1" = "--refresh" ]; then
    shift
    docker pull "$img" || return 1
    mkdir -p "$(dirname "$stamp")" && touch "$stamp"
    [ $# -eq 0 ] && return 0
  fi
  if [ "$1" = "--update-wrapper" ]; then
    shift
    local rc="${WRAPPER_RC}"
    docker pull "$img" || return 1
    mkdir -p "$(dirname "$stamp")" && touch "$stamp"
    # Write a temp file and mv only on success. A bare \`> "$rc"\` truncates BEFORE docker
    # runs, so one failed pull would leave you with an empty wrapper and no way to
    # regenerate it — the one unrecoverable state this command could have had.
    local tmp
    tmp="$(mktemp "\${rc}.XXXXXX")" || return 1
    if docker run --rm "$img" wrapper > "$tmp" && [ -s "$tmp" ]; then
      mv "$tmp" "$rc" && echo "wrapper updated: $rc"
    else
      rm -f "$tmp"
      echo "error: could not generate the wrapper — $rc left as it was" >&2
      return 1
    fi
    # Redefining a function while it is running is fine: bash already parsed this body.
    # The new definitions take effect from the next call.
    . "$rc" || return 1
    [ $# -eq 0 ] && return 0
  fi
  # Refresh the image at most once every ${REFRESH_MINUTES} minutes, tracked by a stamp file.
  if [ ! -e "$stamp" ] || [ -n "$(find "$stamp" -mmin +${STALE_MMIN} 2>/dev/null)" ]; then
    if docker pull -q "$img" >/dev/null 2>&1; then
      mkdir -p "$(dirname "$stamp")" && touch "$stamp"
    else
      echo "note: could not refresh $img — using the cached image" >&2
    fi
  fi
  # -t only when both ends really are a terminal. With it, \`init\`'s prompts and the
  # interactive session behave; without the guard, the same function inside a script or
  # a pipeline dies with "the input device is not a TTY". Unquoted on purpose — quoted,
  # it would pass an empty argument to docker.
  local tty=""
  [ -t 0 ] && [ -t 1 ] && tty="-t"
  # FH_WRAPPER lets the container tell a current wrapper from a stale one; \`doctor\`
  # reports the mismatch. /etc/hosts read-only so hostnames resolve inside the container
  # as they do at your prompt — see operator-onboarding.md Step 0.5 for the loopback edge.
  docker run --rm -i $tty -e FH_WRAPPER=${WRAPPER_VERSION} -v "$PWD:/work" \\
    -v /etc/hosts:/etc/hosts:ro -u "$(id -u):$(id -g)" "$img" "$@"
}`;
}

/**
 * The `mt-agent` function — the ONE-SHOT invocations only.
 *
 * ⚠️ This is the one place a wrapper deliberately disagrees with the tool it wraps. The
 * image's own CLI is \`mt-agent [doctor]\`, where bare means "run the main loop in the
 * foreground". Through a wrapper that is a footgun: a loop is already running under
 * compose, and a second agent for one provider is a real failure mode. So bare refuses and
 * points at compose.
 *
 * It also never pulls. The toolkit's stamp is safe because the toolkit is the thing you are
 * invoking; pulling the agent would mean \`mt-agent doctor\` validates a build your running
 * loop is not on — passed here, fails in prod. Instead it compares digests and REPORTS.
 */
export function agentFunction(): string {
  return `mt-agent() {
  local img=${AGENT_IMAGE}
  # The bare case is answered BEFORE the directory guard: someone who types \`mt-agent\` in
  # the wrong directory needs to hear what the command is for, not where they are standing.
  if [ $# -eq 0 ]; then
    # Deliberate divergence from the image's own CLI, where bare means "run the main loop".
    # Through a wrapper that would start a SECOND agent for this provider, alongside the one
    # compose is already running.
    echo "the long-running agent runs under compose, not through this function:" >&2
    echo "  docker compose up -d              # start" >&2
    echo "  docker compose logs -f            # watch" >&2
    echo "  docker compose down               # stop" >&2
    echo "  docker compose pull && docker compose up -d --force-recreate   # take a new build" >&2
    echo "" >&2
    echo "one-shot checks:  mt-agent doctor   mt-agent dry-run" >&2
    return 1
  fi
  if [ ! -f .env.operator ]; then
    echo "error: no .env.operator here — run this from your operator directory." >&2
    echo "  (the directory that 'fh-toolkit init' wrote; you are in $PWD)" >&2
    return 1
  fi
  case "$1" in
    doctor)
      shift
      mt-agent-image-drift
      docker run --rm --env-file .env.operator -v "$PWD/data:/data:ro" "$img" doctor "$@"
      ;;
    dry-run)
      shift
      # The image takes this as an env var, not an argument — the whole reason it is worth
      # wrapping. Validates Flux Hub connectivity and auth WITHOUT touching Proxmox.
      docker run --rm --env-file .env.operator -v "$PWD/data:/data:ro" \\
        -e AGENT_DRY_RUN=1 "$img" "$@"
      ;;
    *)
      docker run --rm --env-file .env.operator -v "$PWD/data:/data:ro" "$img" "$@"
      ;;
  esac
}

# Is the agent you are running the newest one? Reports; never acts. All three images track
# :latest and nothing re-pulls on its own, so without this nothing ever tells you.
#
# Two questions, deliberately in this order:
#   1. Is the RUNNING container older than the image on this host?  No network, always
#      answerable, and the likelier mistake — \`docker compose pull\` without
#      \`--force-recreate\` downloads a build and keeps running the old one.
#   2. Is the image on this host older than the published tag?  Best effort.
#
# Silent whenever it cannot tell. A guess here is worse than nothing.
mt-agent-image-drift() {
  local img=${AGENT_IMAGE}
  local cid running_id local_id local_digest remote_digest
  # Match on the image NAME as recorded at creation, not \`--filter ancestor=\`: that filter
  # resolves the tag to its CURRENT id, so a container left behind by a pull — exactly the
  # case worth reporting — would not match it.
  cid="$(docker ps --format '{{.ID}} {{.Image}}' 2>/dev/null | awk -v i="$img" '$2 == i { print $1; exit }')"
  [ -z "$cid" ] && return 0
  running_id="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null)"
  local_id="$(docker image inspect --format '{{.Id}}' "$img" 2>/dev/null)"
  if [ -n "$running_id" ] && [ -n "$local_id" ] && [ "$running_id" != "$local_id" ]; then
    echo "note: a newer $img is ON THIS HOST than the one your agent is running." >&2
    echo "  running  \${running_id#sha256:}" >&2
    echo "  pulled   \${local_id#sha256:}" >&2
    echo "  take it with:  docker compose up -d --force-recreate" >&2
    return 0
  fi
  # \`docker manifest inspect\` is NOT usable here — it refuses an OCI index with
  # "unsupported manifest media type", which is what both of our tags now are.
  local_digest="$(docker image inspect --format '{{index .RepoDigests 0}}' "$img" 2>/dev/null)"
  remote_digest="$(docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$img" 2>/dev/null)"
  if [ -z "$local_digest" ] || [ -z "$remote_digest" ]; then
    return 0
  fi
  case "$local_digest" in
    *"$remote_digest") return 0 ;;
  esac
  echo "note: a newer $img is PUBLISHED than the one on this host." >&2
  echo "  yours     \${local_digest#*@}" >&2
  echo "  published $remote_digest" >&2
  echo "  take it with:  docker compose pull && docker compose up -d --force-recreate" >&2
}`;
}

/** The whole file, as it should land at `~/.fh-toolkit.sh`. */
export function wrapperScript(opts: WrapperOptions = {}): string {
  const parts = [header(opts.build)];
  if (opts.only !== "agent") parts.push(toolkitFunction());
  if (opts.only !== "toolkit") parts.push(agentFunction());
  return parts.join("\n\n") + "\n";
}

/**
 * What the container makes of the `FH_WRAPPER` it was (or was not) handed.
 *
 * Deliberately quiet about a current wrapper: this is checked on every `doctor` run and
 * shown in the session banner, and a line that says "fine" every time is a line nobody
 * reads.
 */
export function wrapperStatus(env: Record<string, string | undefined>):
  | { state: "current"; version: number }
  | { state: "stale"; version: number; message: string; fix: string }
  | { state: "unknown"; message: string; fix: string } {
  const fix = "fh-toolkit --update-wrapper";
  const raw = env.FH_WRAPPER?.trim();
  // A deliberate non-wrapper invocation — CI, a script, a one-off `docker run` — should
  // not be nagged about a wrapper it has chosen not to have. `FH_WRAPPER=none` says so.
  if (raw === "none") return { state: "current", version: 0 };
  const seen = raw ? Number(raw) : NaN;
  if (!raw || !Number.isInteger(seen)) {
    return {
      state: "unknown",
      message:
        "your shell wrapper predates the version handshake (or you are not using one) — " +
        "it may still name an image that no longer publishes",
      fix,
    };
  }
  if (seen < WRAPPER_VERSION) {
    return {
      state: "stale",
      version: seen,
      message: `your shell wrapper is v${seen}; this image expects v${WRAPPER_VERSION}`,
      fix,
    };
  }
  return { state: "current", version: seen };
}
