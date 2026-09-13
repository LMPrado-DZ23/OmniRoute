/**
 * Shared JSONC-tolerant config reader for CLI-tools settings routes.
 *
 * Background: several upstream CLI tools (opencode, kilo, droid, cline, etc.)
 * ship config files that are JSON with the occasional trailing comma or a
 * stray comment — valid JSONC, but `JSON.parse()` rejects them with a
 * `SyntaxError`. Until this helper, every `readSettings`/`readConfig` helper
 * only caught `ENOENT` and re-threw, surfacing as a 500 that the dashboard
 * misread as "tool not installed".
 *
 * Behaviour:
 *  - strip trailing commas before parsing so JSONC files load cleanly;
 *  - on ANY read or parse failure, return the caller-supplied fallback
 *    (typically `null` or `{}`) instead of throwing, so the dashboard shows
 *    "installed but not configured" rather than "not installed".
 *
 * Ported from upstream `decolua/9router@6c10edf8`. Co-authored-by: Zireael.
 */
import { promises as fs } from "node:fs";

/**
 * Parse a JSON/JSONC string, returning `null` on syntax errors instead of
 * throwing. Trailing commas before `}` or `]` are stripped before parsing.
 */
export function parseJsoncOrNull<T = unknown>(content: string): T | null {
  try {
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped) as T;
  } catch {
    return null;
  }
}

/**
 * Read a JSON/JSONC config file. Returns `fallback` (default: `null`) on any
 * filesystem or parse error so callers can render an "installed but not
 * configured" state instead of crashing with a 500.
 */
export async function readJsoncConfig<T = unknown>(
  path: string,
  fallback: T | null = null
): Promise<T | null> {
  let content: string;
  try {
    content = await fs.readFile(path, "utf-8");
  } catch {
    return fallback;
  }
  const parsed = parseJsoncOrNull<T>(content);
  return parsed ?? fallback;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type JsoncObjectRead =
  { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/**
 * Read a JSON/JSONC config file that the caller will merge into and write back.
 *
 * Unlike `readJsoncConfig` (display reads, where any failure may degrade to a fallback), a
 * merge-and-write must distinguish "nothing there yet" from "something there we cannot read":
 * turning an unreadable, invalid or non-object file into `{}` makes the write replace everything
 * the user had in it (finding F-14). So a missing or empty file is `{}`, and every other failure
 * is reported with a message naming `label`, so the route can refuse without writing.
 */
export async function readJsoncObjectForMerge(
  path: string,
  label: string
): Promise<JsoncObjectRead> {
  let content: string;
  try {
    content = await fs.readFile(path, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { ok: true, value: {} };
    }
    return { ok: false, error: `existing ${label} could not be read` };
  }
  if (content.trim() === "") return { ok: true, value: {} };

  const parsed = parseJsoncOrNull(content);
  if (!isJsonObject(parsed)) {
    return {
      ok: false,
      error: `existing ${label} is not a valid JSON object; fix it before applying OmniRoute settings`,
    };
  }
  return { ok: true, value: parsed };
}
