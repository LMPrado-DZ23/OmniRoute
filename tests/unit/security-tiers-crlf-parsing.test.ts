/**
 * `check:openapi-security-tiers` cross-references the `x-loopback-only` annotations in
 * `docs/openapi.yaml` against `routeGuard.ts`. It reads the guard's arrays out of the
 * source, and its pattern parser stripped line comments with:
 *
 *   raw.replace(/\/\/.*$/, "")
 *
 * `.` does not match `\r`, and `$` without `/m` anchors at end-of-string — so on a CRLF
 * checkout (`core.autocrlf=true`, the Windows default) the comment survived, the token
 * no longer ended in `/`, and the entry was silently dropped. The only
 * `LOCAL_ONLY_API_PATTERNS` entry with a trailing comment is the volcengine-plan one, so
 * the gate reported six "has x-loopback-only but is NOT covered" mismatches that do not
 * exist, and could not be run on Windows at all.
 *
 * The sibling `parsePrefixes` was always immune: it uses `stripLineComments`, whose regex
 * is global and bounded by a newline character class rather than by an end-of-string
 * anchor. A security gate that fails red for a parser artifact is a gate people learn to
 * ignore, so both halves must behave the same on both line endings.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SCRIPT = path.join(process.cwd(), "scripts", "check", "check-openapi-security-tiers.mjs");
const source = fs.readFileSync(SCRIPT, "utf8");

/** One `LOCAL_ONLY_API_PATTERNS` entry, exactly as routeGuard.ts writes it. */
const ENTRY =
  "  /^\\/api\\/providers\\/volcengine-plan\\/connect(\\/.*)?$/, // launches Playwright";

test("the end-of-string comment strip is gone from the pattern parser", () => {
  assert.ok(
    !source.includes('.replace(/\\/\\/.*$/, "")'),
    "/\\/\\/.*$/ cannot strip a comment on a CRLF line: `.` stops at \\r and `$` anchors " +
      "at end-of-string, so the entry is dropped and the routes it covers are reported " +
      "as unprotected"
  );
  assert.ok(
    source.includes('const stripLineComments = (s) => s.replace(/\\/\\/[^\\n]*/g, "");'),
    "the shared, line-ending-agnostic stripper must stay as it is"
  );
  assert.ok(
    source.includes("const t = stripLineComments(raw)"),
    "parsePatterns must use the same stripper parsePrefixes already used"
  );
});

test("the broken strip really would drop the entry, and the shared one does not", () => {
  const tidy = (s: string) => s.trim().replace(/,\s*$/, "").trim();

  const broken = (line: string) => tidy(line.replace(/\/\/.*$/, ""));
  const fixed = (line: string) => tidy(line.replace(/\/\/[^\n]*/g, ""));

  const isRegexLiteral = (t: string) => t.length > 2 && t.startsWith("/") && t.endsWith("/");

  // LF: both strippers cope.
  assert.ok(isRegexLiteral(broken(ENTRY)), "on LF the old strip worked, which is why it survived");
  assert.ok(isRegexLiteral(fixed(ENTRY)));

  // CRLF: only the shared one does. This is the whole defect, in one assertion.
  assert.ok(
    !isRegexLiteral(broken(`${ENTRY}\r`)),
    "the old strip must be shown to fail on CRLF, or this test proves nothing"
  );
  assert.ok(
    isRegexLiteral(fixed(`${ENTRY}\r`)),
    "the shared stripper must keep the entry intact on a CRLF checkout"
  );
  assert.equal(fixed(`${ENTRY}\r`), fixed(ENTRY), "a \\r must not change what the parser sees");
});
