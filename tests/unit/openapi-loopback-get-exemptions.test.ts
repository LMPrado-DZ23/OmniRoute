/**
 * `x-loopback-only` must mean what the guard enforces — including for the METHOD.
 *
 * `isLocalOnlyPath(path, method)` returns **false** for a safe method on a path in
 * `LOCAL_ONLY_API_GET_EXEMPTIONS`, so `GET /api/system/version` and
 * `GET /api/tunnels/cloudflared` are reachable from a non-loopback caller by design.
 * Both carried `x-loopback-only: true` anyway — the spec promising a restriction the
 * guard does not apply.
 *
 * `check-openapi-security-tiers` could not catch it: `coveredByLocalOnly()` took no
 * method and never read the exemption set. Worse, `extractArrayBody` matched only a
 * plain `\n];`, while that set is declared as `new Set([...])` ending in `\n]);` — so
 * even a method-aware check would have thrown rather than read it.
 *
 * Both were fixed together, because either alone leaves the gate structurally blind.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const ROOT = process.cwd();
const spec = yaml.load(fs.readFileSync(path.join(ROOT, "docs", "openapi.yaml"), "utf-8")) as {
  paths?: Record<string, Record<string, { "x-loopback-only"?: boolean } | undefined>>;
};
const guardSrc = fs.readFileSync(
  path.join(ROOT, "src", "server", "authz", "routeGuard.ts"),
  "utf-8"
);
const checkerSrc = fs.readFileSync(
  path.join(ROOT, "scripts", "check", "check-openapi-security-tiers.mjs"),
  "utf-8"
);

/** The exempted paths, read from the guard so the test cannot drift from it. */
function exemptedPaths(): string[] {
  const body = guardSrc.match(
    /export const LOCAL_ONLY_API_GET_EXEMPTIONS[\s\S]*?=\s*new Set\(\[([\s\S]*?)\n\]\);/
  )?.[1];
  assert.ok(body, "LOCAL_ONLY_API_GET_EXEMPTIONS must still be declared as a new Set([...])");
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test("no exempted safe method claims x-loopback-only", () => {
  const paths = exemptedPaths();
  assert.ok(paths.length > 0, "the exemption set must not be empty, or this test proves nothing");

  const overclaiming: string[] = [];
  for (const p of paths) {
    const operations = spec.paths?.[p] ?? {};
    for (const method of ["get", "head", "options"]) {
      if (operations[method]?.["x-loopback-only"] === true) {
        overclaiming.push(`${method.toUpperCase()} ${p}`);
      }
    }
  }

  assert.deepEqual(
    overclaiming,
    [],
    "the guard lets these through; annotating them promises a restriction that is not " +
      "enforced, which is worse than no annotation:\n" +
      overclaiming.join("\n")
  );
});

test("the unsafe methods on those same paths still claim it", () => {
  // The exemption is for safe methods only. If POST lost its annotation too, the fix
  // would have over-corrected and the spec would under-claim instead.
  for (const p of exemptedPaths()) {
    const post = spec.paths?.[p]?.post;
    if (!post) continue;
    assert.equal(post["x-loopback-only"], true, `POST ${p} is local-only and must still say so`);
  }
});

test("the checker reads the exemption set and honours the method", () => {
  assert.match(
    checkerSrc,
    /parsePrefixes\("LOCAL_ONLY_API_GET_EXEMPTIONS"\)/,
    "a checker that never reads the exemption set cannot see this class of mismatch"
  );
  assert.match(
    checkerSrc,
    /function coveredByLocalOnly\(pathStr, method\)/,
    "isLocalOnlyPath takes a method; its mirror must too"
  );
  assert.ok(
    checkerSrc.includes("(?:new Set\\\\()?"),
    "extractArrayBody must accept the `new Set([...])` form, or reading the exemption " +
      "set throws instead of returning it"
  );
});
