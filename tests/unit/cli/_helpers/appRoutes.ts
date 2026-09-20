/**
 * The App Router's route table, as the CLI sees it.
 *
 * Shared by the static CLI↔route contract (cli-endpoints-exist.test.ts) and by
 * the route-backed fetch used to run CLI commands against the real handlers
 * (routeBackedFetch.ts), so both agree on which file serves which URL.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const API_DIR = path.join(ROOT, "src", "app", "api");

// The two catch-alls exist only to turn unknown paths into a JSON 404
// (#6405 / #6424); resolving to them means "no such route".
const NOT_FOUND_CATCH_ALLS = new Set([
  "src/app/api/[...omnirouteApiCatchAll]/route.ts",
  "src/app/api/v1/[...omnirouteCatchAll]/route.ts",
]);

export type RouteParams = Record<string, string | string[]>;
export type RouteMatch = { file: string; params: RouteParams };

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

export function relativeToRoot(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

const routeFiles = walk(API_DIR)
  .filter((f) => /[\\/]route\.tsx?$/.test(f))
  .map(relativeToRoot)
  .filter((f) => !NOT_FOUND_CATCH_ALLS.has(f));

function segmentsOf(routeFile: string): string[] {
  return routeFile
    .replace(/^src\/app\//, "")
    .replace(/\/route\.tsx?$/, "")
    .split("/");
}

function matchSegments(route: string[], target: string[], params: RouteParams): boolean {
  if (route.length === 0) return target.length === 0;
  const [head, ...rest] = route;
  const optionalCatchAll = head.match(/^\[\[\.\.\.(.+)\]\]$/);
  if (optionalCatchAll) {
    if (rest.length !== 0) return false;
    if (target.length > 0) params[optionalCatchAll[1]] = target;
    return true;
  }
  const catchAll = head.match(/^\[\.\.\.(.+)\]$/);
  if (catchAll) {
    if (rest.length !== 0 || target.length === 0) return false;
    params[catchAll[1]] = target;
    return true;
  }
  if (target.length === 0) return false;
  const dynamic = head.match(/^\[(.+)\]$/);
  if (dynamic) params[dynamic[1]] = decodeURIComponent(target[0]);
  else if (head !== target[0]) return false;
  return matchSegments(rest, target.slice(1), params);
}

function specificity(segs: string[]): number {
  return segs.reduce(
    (s, seg) =>
      s + (seg.startsWith("[...") || seg.startsWith("[[...") ? 0 : seg.startsWith("[") ? 1 : 2),
    0
  );
}

/** Most specific route for a concrete /api pathname (static > [param] > catch-all). */
export function matchRoute(pathname: string): RouteMatch | null {
  const target = pathname.replace(/^\//, "").replace(/\/$/, "").split("/");
  const matches: Array<RouteMatch & { score: number }> = [];
  for (const file of routeFiles) {
    const params: RouteParams = {};
    const segs = segmentsOf(file);
    if (matchSegments(segs, target, params))
      matches.push({ file, params, score: specificity(segs) });
  }
  matches.sort((a, b) => b.score - a.score);
  const best = matches[0];
  return best ? { file: best.file, params: best.params } : null;
}

/** next.config.mjs rewrites /v1/* to /api/v1/*; everything else is served as-is. */
export function toApiPathname(pathname: string): string | null {
  if (pathname.startsWith("/api/")) return pathname;
  if (pathname === "/v1" || pathname.startsWith("/v1/")) return `/api${pathname}`;
  return null;
}
