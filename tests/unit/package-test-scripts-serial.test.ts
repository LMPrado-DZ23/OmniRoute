/**
 * `npm test` is the command CONTRIBUTING.md asks contributors to run, and `npm run check` runs it
 * after lint. CI runs the unit suite through `test:unit:ci:shard`, which ends with the serialized
 * suite (`tests/unit/serial`, --test-concurrency=1). If `npm test` skips that suite, a local run can be
 * green while CI fails, so both local entry points must reach it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scripts: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
).scripts;

/** Expands `npm run <name>` references so a script is checked by what it actually runs. */
function expand(name: string, seen = new Set<string>()): string {
  const body = scripts[name];
  assert.ok(body, `package.json has no "${name}" script`);
  if (seen.has(name)) return body;
  seen.add(name);
  return body.replace(/npm run ([\w:.-]+)/g, (_match, ref: string) =>
    scripts[ref] ? expand(ref, seen) : _match
  );
}

test("the serialized unit suite script exists and targets tests/unit/serial", () => {
  assert.match(scripts["test:unit:serial"], /tests\/unit\/serial\//);
});

test("npm test runs the serialized unit suite", () => {
  assert.match(expand("test"), /tests\/unit\/serial\//);
});

test("npm run check runs lint and the serialized unit suite", () => {
  const check = expand("check");
  assert.match(check, /\beslint\b/);
  assert.match(check, /tests\/unit\/serial\//);
});

test("the CI unit shard script still ends with the serialized suite", () => {
  assert.match(expand("test:unit:ci:shard"), /tests\/unit\/serial\//);
});
