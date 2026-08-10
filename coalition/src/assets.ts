/**
 * Static branding assets served by the coalition.
 *
 * The coalition is a plain `http.createServer` with no static-file layer, so the
 * console/launcher pages had no favicon at all — browsers just showed the default
 * blank tab icon (and logged a 404 for /favicon.ico). These are the SAME files the
 * FluxHub web app publishes from `apps/web/public`, copied into `coalition/public`
 * so an operator's console tab carries the identical FluxHub icon.
 *
 * Only this fixed allowlist is reachable — there is no path-joining from the request,
 * so no traversal surface. Files are read once and held in memory (all are small).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

/** URL path -> [file name, content-type]. Mirrors `metadata.icons` in the web app's layout.tsx. */
const ASSETS: Record<string, [string, string]> = {
  "/favicon.ico": ["favicon.ico", "image/x-icon"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
  "/icon-512.png": ["icon-512.png", "image/png"],
};

const cache = new Map<string, Buffer | null>();

export type StaticAsset = { body: Buffer; contentType: string };

/** The asset for `url`, or null if it isn't one we publish (or is missing on disk). */
export function getStaticAsset(url: string): StaticAsset | null {
  const entry = ASSETS[url];
  if (!entry) return null;
  const [file, contentType] = entry;
  if (!cache.has(url)) {
    try {
      cache.set(url, readFileSync(path.join(PUBLIC_DIR, file)));
    } catch {
      // Missing asset must never take the console down — cache the miss and 404 on.
      console.warn(`[coalition] static asset not found: ${file}`);
      cache.set(url, null);
    }
  }
  const body = cache.get(url);
  return body ? { body, contentType } : null;
}
