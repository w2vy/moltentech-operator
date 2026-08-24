/**
 * Which build of the CLI is this?
 *
 * Operators run `ghcr.io/w2vy/mt-manifest:latest` through a shell function that refreshes
 * the image at most once every 48h, so a fresh publish is invisible for up to two days —
 * and nothing in any output said which build was answering. Measured 2026-08-24: a box
 * printed a `help` that predated a merged change, and the only way to tell was to diff
 * the text against the repo.
 *
 * The values are baked in at image build time (Dockerfile ARGs fed by the publish
 * workflow). Running from a source checkout leaves them unset, which is itself the right
 * answer — say "source checkout" rather than inventing a SHA.
 */
export interface BuildInfo {
  /** Package version from package.json — coarse, changes rarely. */
  version: string;
  /** The commit the image was built from, or undefined outside an image. */
  sha?: string;
  /** ISO 8601 build timestamp, or undefined outside an image. */
  builtAt?: string;
}

export function readBuildInfo(
  env: Record<string, string | undefined>,
  version: string
): BuildInfo {
  const clean = (v: string | undefined): string | undefined => {
    const t = v?.trim();
    return t ? t : undefined;
  };
  return { version, sha: clean(env.MT_BUILD_SHA), builtAt: clean(env.MT_BUILD_TIME) };
}

/**
 * One line per fact, because this output gets pasted into a bug report. The SHA is the
 * line that matters: it is what tells you whether a fix you merged is the code that just
 * ran, and it is greppable against `git log`.
 */
export function formatBuildInfo(info: BuildInfo): string {
  const lines = [`mt-manifest ${info.version}`];
  if (info.sha) {
    lines.push(`  build   ${info.sha}`);
  } else {
    lines.push("  build   source checkout — no image metadata (not the published CLI)");
  }
  if (info.builtAt) lines.push(`  built   ${info.builtAt}`);
  if (info.sha) {
    lines.push("");
    lines.push("Older than you expect? The documented shell function refreshes the image");
    lines.push("only every 48h: `docker pull ghcr.io/w2vy/mt-manifest:latest`.");
  }
  return lines.join("\n");
}
