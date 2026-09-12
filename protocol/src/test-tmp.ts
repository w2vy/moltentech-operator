import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `mkdtemp` for tests, with the half everyone forgets: the directory is removed when the
 * test process exits. A full `npm test` used to leave ~2,500 `mt-*`/`fh-*` directories in
 * /tmp per run (09-12). Cleanup is at process exit, not per test, so a failing test's
 * directory is still there while the run is being read.
 */
const made: string[] = [];

export function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
