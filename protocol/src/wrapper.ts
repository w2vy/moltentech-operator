/**
 * The shell functions, emitted by the tool they wrap.
 *
 * `fh-toolkit` and `fh-agent` both run as containers, and both need a fiddly `docker run`
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
import { AGENT_IMAGE, AGENT_IMAGE_STAGING } from "./scaffold";
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
export const WRAPPER_VERSION = 9;

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
  # \`--refresh\` and \`--update-wrapper\` are consumed HERE, never passed on: the CLI runs
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
 * The `fh-agent` function — one-shot checks, plus the loop's lifecycle as named verbs.
 *
 * ⚠️ This is the one place a wrapper deliberately disagrees with the tool it wraps. The
 * image's own CLI is \`fh-agent [doctor]\`, where bare means "run the main loop in the
 * foreground". Through a wrapper that is a footgun: a loop is already running under
 * compose, and a second agent for one provider is a real failure mode. So bare refuses and
 * lists the verbs; \`start\` is compose's \`up -d\`, which is idempotent.
 *
 * The lifecycle verbs (v5) exist so the operator docs speak ONE vocabulary. Before them the
 * docs said \`fh-agent doctor\` and then switched to raw compose for start/stop/logs, and
 * \`docker restart\` — the obvious word, which re-reads nothing — cost four separate
 * afternoons. \`fh-agent restart\` IS \`up -d --force-recreate\`, so the obvious word now
 * does the right thing.
 *
 * It also never pulls. The toolkit's stamp is safe because the toolkit is the thing you are
 * invoking; pulling the agent would mean \`fh-agent doctor\` validates a build your running
 * loop is not on — passed here, fails in prod. Instead it compares digests and REPORTS.
 */
export function agentFunction(): string {
  return `# Which agent image this directory runs.
#
# NOT \`${AGENT_IMAGE}\` unconditionally, which is what this wrapper assumed until
# 2026-09-10: \`init\` pins the image that matches the hub you chose, so on a staging
# onboarding compose runs \`${AGENT_IMAGE_STAGING}\` while every \`fh-agent\` subcommand
# ran the PRODUCTION image — a doctor that passes against a build your loop is not on.
# compose.yaml is the file compose itself reads, so it is the one to believe.
fh-agent-image() {
  local pinned=""
  if [ -f compose.yaml ]; then
    pinned="$(awk '$1 == "image:" { print $2; exit }' compose.yaml)"
  fi
  echo "\${pinned:-${AGENT_IMAGE}}"
}

# The old name, kept as a signpost rather than deleted.
#
# The \`mt-manifest\` -> \`fh-toolkit\` rename shipped on 2026-09-06 and the only operator
# saw nothing: his shell still defined the old function against an image name that no
# longer publishes. Renaming \`mt-agent\` -> \`fh-agent\` on 2026-09-10 has the same shape,
# and three lines is cheaper than the afternoon that cost.
mt-agent() {
  echo "mt-agent is now fh-agent (image ghcr.io/w2vy/fh-agent, was w2vy/mt-agent)." >&2
  echo "  same arguments: fh-agent $*" >&2
  return 1
}

# The verb list, in one place: bare \`fh-agent\` and an unknown word print the same thing.
fh-agent-usage() {
  echo "usage: fh-agent <doctor|dry-run|version|start|stop|restart|status|logs|update>" >&2
  echo "  doctor     the credentialed preflight (run before the first start)" >&2
  echo "  dry-run    Flux Hub connectivity and auth, without touching Proxmox" >&2
  echo "  version    running vs pulled vs published" >&2
  echo "  start      run the agent loop in the background   (docker compose up -d)" >&2
  echo "  stop       stop and remove it                       (docker compose down)" >&2
  echo "  restart    APPLY a settings change                  (up -d --force-recreate)" >&2
  echo "  status     is it running, and which version        (docker compose ps)" >&2
  echo "  logs       follow the log; 'logs --tail 50' for the recent lines" >&2
  echo "  update     pull the newest build and restart onto it" >&2
  echo "the loop itself runs under compose; this function never runs it in the foreground." >&2
}

# Is the wrapper FILE newer than the function bash is running?
#
# This is the 2026-09-13 failure, from a live operator directory: \`fh-toolkit
# --update-wrapper\` had rewritten ~/.fh-toolkit.sh, but the interactive shell had been
# open since 09-11, so bash still held the PREVIOUS \`fh-agent()\` — one with no
# \`restart\` branch. A stale function cannot know what it is missing, but it can read
# the header of the file that superseded it and say so.
#
# Only ever called on an error path: one \`sed\` over one local file, never on a good
# command, no docker and no network.
fh-agent-stale-note() {
  local rc="${WRAPPER_RC}"
  local on_disk
  [ -f "$rc" ] || return 0
  on_disk="$(sed -n 's/^# Emitted by .*wrapper format v\\([0-9][0-9]*\\)\\.$/\\1/p' "$rc" | head -n 1)"
  [ -n "$on_disk" ] || return 0
  [ "$on_disk" -le ${WRAPPER_VERSION} ] 2>/dev/null && return 0
  echo "note: $rc on disk is wrapper v$on_disk; the fh-agent() your shell has loaded is v${WRAPPER_VERSION}." >&2
  echo "  you upgraded fh-toolkit in a shell that was already open, so bash kept the old" >&2
  echo "  definition. Reload it and try again:" >&2
  echo "    . $rc          (or just open a new terminal)" >&2
}

fh-agent() {
  local img
  img="$(fh-agent-image)"
  # The bare case is answered BEFORE the directory guard: someone who types \`fh-agent\` in
  # the wrong directory needs to hear what the command is for, not where they are standing.
  if [ $# -eq 0 ]; then
    # Deliberate divergence from the image's own CLI, where bare means "run the main loop".
    # Through a wrapper that would start a SECOND agent for this provider, alongside the one
    # compose is already running.
    fh-agent-usage
    fh-agent-stale-note
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
      fh-agent-image-drift
      # \`npm run doctor\`, not a bare \`doctor\`: the image sets CMD but no ENTRYPOINT, so it
      # inherits node's, and a bare subcommand is handed to \`node\` — which dies
      # MODULE_NOT_FOUND /app/agent/doctor. \`doctor\` IS the image's CLI (index.ts reads
      # argv[2]); it is only unreachable as a bare docker argument.
      docker run --rm --env-file .env.operator -v "$PWD/data:/data:ro" "$img" npm run doctor "$@"
      ;;
    version)
      # Which agent is running, which is pulled, and whether a newer one is published.
      # No credentials, no network beyond the registry check. Flux Hub shows the running
      # version on your listing page (agent >= 0.11.11 reports it on every call).
      fh-agent-version
      fh-agent-image-drift
      ;;
    update)
      fh-agent-update
      ;;
    start)
      fh-agent-compose-dir || return 1
      # Pull first: a host that pulled the tag before keeps that copy, and a bare \`up -d\`
      # starts it. On 2026-09-26 a fresh staging onboarding started agent 0.11.31 although
      # :staging had moved to 0.11.34. When the image is current the pull costs ~1s; when
      # it cannot reach the registry, start anyway on what is here.
      docker compose pull || echo "note: could not pull — starting the image already on this host." >&2
      docker compose up -d
      ;;
    stop)
      fh-agent-compose-dir || return 1
      docker compose down
      ;;
    restart)
      # NOT \`docker compose restart\`: that re-reads nothing, and neither does
      # \`docker restart\`. The agent reads .env.operator only at container creation, so
      # the verb people reach for after editing it has to recreate.
      fh-agent-compose-dir || return 1
      docker compose up -d --force-recreate
      ;;
    status)
      fh-agent-compose-dir || return 1
      docker compose ps
      echo "running: $(fh-agent-running-version)"
      fh-agent-image-drift
      ;;
    logs)
      shift
      fh-agent-compose-dir || return 1
      # Bare follows; any argument is passed through as given (\`logs --tail 50\`).
      if [ $# -eq 0 ]; then
        docker compose logs -f
      else
        docker compose logs "$@"
      fi
      ;;
    dry-run)
      shift
      # The image takes this as an env var, not an argument — the whole reason it is worth
      # wrapping. Validates Flux Hub connectivity and auth WITHOUT touching Proxmox.
      docker run --rm --env-file .env.operator -v "$PWD/data:/data:ro" \\
        -e AGENT_DRY_RUN=1 "$img" "$@"
      ;;
    *)
      # An unrecognised bare word is NOT handed to the container.
      #
      # The image sets CMD and no ENTRYPOINT, so it inherits node's docker-entrypoint:
      # a first argument that is not an executable on PATH gets \`node\` prepended. So
      # \`fh-agent restart\` through a wrapper too old to have a \`restart\` branch did not
      # say "unknown command" — it printed
      #   Error: Cannot find module '/app/agent/restart'   MODULE_NOT_FOUND
      # from inside the container, which reads like a broken IMAGE. That is also why a
      # bare word can never reach the image's OWN cli (index.ts argv[2]): \`doctor\` is
      # spelled \`npm run doctor\` above for exactly this reason. Refusing bare words
      # therefore costs no working invocation.
      #
      # What still passes through is an explicit command: a program the image really has
      # on PATH, a path, or a flag. \`fh-agent npm run <script>\`, \`fh-agent node -p ...\`
      # and \`fh-agent sh -c '...'\` all work as they always did.
      case "$1" in
        npm|npx|node|tsx|sh|bash|env|python3|arcane-mage|/*|./*|*/*|-*)
          docker run --rm --env-file .env.operator -v "$PWD/data:/data:ro" "$img" "$@"
          ;;
        *)
          echo "fh-agent: unknown command '$1'" >&2
          fh-agent-usage
          echo "to run something else inside the image, name the command:" >&2
          echo "  fh-agent npm run <script>   fh-agent node -p '<expr>'   fh-agent sh -c '<cmd>'" >&2
          # Last, because the last line is the one that gets read — and when it fires it
          # is the whole answer.
          fh-agent-stale-note
          return 1
          ;;
      esac
      ;;
  esac
}

# THIS directory's agent container, by compose project — not the first container on the
# image. Two stacks on one tag (a staging pair on :staging, a prod pair on :latest) each
# have their own project, and matching on the image alone reported whichever came first:
# on 2026-09-13 the second directory's \`fh-agent update\` printed the sibling's version as
# its own "before". \`init\` writes \`name:\` into compose.yaml; a file without one gets
# compose's directory-derived project, which the working_dir label still identifies.
#
# The project + service labels make the container unique, so the image is NOT compared:
# once a pull has moved the tag, \`docker ps\` shows the still-running container's Image
# as a bare id rather than the tag, and an image match reports "not running" for a
# container that is up (the second directory of each pair, same day, wrapper v6).
fh-agent-cid() {
  local filter
  local project
  project="$(awk '$1 == "name:" { print $2; exit }' compose.yaml 2>/dev/null)"
  if [ -n "$project" ]; then
    filter="label=com.docker.compose.project=$project"
  else
    filter="label=com.docker.compose.project.working_dir=$(pwd -P)"
  fi
  docker ps --format '{{.ID}}' --filter "$filter" --filter label=com.docker.compose.service=agent 2>/dev/null | head -n 1
}

# The version of the agent container compose is running for this directory, or "not running".
fh-agent-running-version() {
  local cid
  cid="$(fh-agent-cid)"
  if [ -z "$cid" ]; then
    echo "not running"
    return 0
  fi
  docker exec "$cid" node -p 'require("/app/agent/package.json").version' 2>/dev/null || echo "unknown"
}

# Every lifecycle verb drives compose, so every one needs the file compose reads.
fh-agent-compose-dir() {
  if [ ! -f compose.yaml ]; then
    echo "error: no compose.yaml here — the loop is not run by compose in this directory." >&2
    echo "  (run this from your operator directory; you are in $PWD)" >&2
    return 1
  fi
}

# Fetch the tag and recreate the loop on it, printing the running version on either side so
# you can see whether anything moved. \`start\` also pulls (a first start should never run a
# stale cached tag); \`restart\` does not — it is for re-reading .env.operator, not for taking
# a new build. \`fh-agent doctor\` only ever reports (fh-agent-image-drift).
fh-agent-update() {
  fh-agent-compose-dir || return 1
  echo "before: $(fh-agent-running-version)"
  docker compose pull && docker compose up -d --force-recreate || return $?
  echo "after:  $(fh-agent-running-version)"
}

# Running vs pulled, by version. The digests underneath are fh-agent-image-drift's job.
fh-agent-version() {
  local img
  img="$(fh-agent-image)"
  echo "running: $(fh-agent-running-version)"
  echo "pulled:  $(docker run --rm --entrypoint node "$img" -p 'require("/app/agent/package.json").version' 2>/dev/null || echo "not pulled")   ($img)"
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
fh-agent-image-drift() {
  local img
  img="$(fh-agent-image)"
  local cid running_id local_id local_digest remote_digest
  # fh-agent-cid matches on the image NAME as recorded at creation, not \`--filter
  # ancestor=\`: that filter resolves the tag to its CURRENT id, so a container left behind
  # by a pull — exactly the case worth reporting — would not match it.
  cid="$(fh-agent-cid)"
  [ -z "$cid" ] && return 0
  running_id="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null)"
  local_id="$(docker image inspect --format '{{.Id}}' "$img" 2>/dev/null)"
  if [ -n "$running_id" ] && [ -n "$local_id" ] && [ "$running_id" != "$local_id" ]; then
    echo "note: a newer $img is ON THIS HOST than the one your agent is running." >&2
    echo "  running  \${running_id#sha256:}" >&2
    echo "  pulled   \${local_id#sha256:}" >&2
    echo "  take it with:  fh-agent update" >&2
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
  echo "  take it with:  fh-agent update" >&2
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
