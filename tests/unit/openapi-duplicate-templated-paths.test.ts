/**
 * `docs/openapi.yaml` documented two endpoints twice, under different template
 * variable names:
 *
 *   /api/tools/agent-bridge/agents/{agentId}/dns       (hand-written, full schemas)
 *   /api/tools/agent-bridge/agents/{id}/dns            (generated stub)
 *
 * OpenAPI 3.x is explicit that templated paths differing only in the variable
 * name are the same endpoint and must not coexist. The consequence was not
 * cosmetic: `oasdiff` refuses the whole document with `duplicate endpoint`, so
 * `check:openapi-breaking` could not diff anything and reported a graceful skip.
 * The contract gate had been producing a green that meant nothing.
 *
 * `check-openapi-routes` was blind to it by construction — it compares
 * param-insensitively, so both spellings matched the one real route and both
 * passed. These tests cover the detector added there and pin the live spec.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import {
  findDuplicateNormalizedPaths,
  normalizeParams,
} from "../../scripts/check/check-openapi-routes.mjs";

test("two spellings of the same templated path are reported as one endpoint", () => {
  const dupes = findDuplicateNormalizedPaths([
    "/api/tools/agent-bridge/agents/{agentId}/dns",
    "/api/tools/agent-bridge/agents/{id}/dns",
    "/api/health",
  ]);

  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].normalized, normalizeParams("/api/tools/agent-bridge/agents/{id}/dns"));
  assert.deepEqual(dupes[0].paths.sort(), [
    "/api/tools/agent-bridge/agents/{agentId}/dns",
    "/api/tools/agent-bridge/agents/{id}/dns",
  ]);
});

test("paths that genuinely differ are not reported", () => {
  // Same prefix, different depth and different literal segments — these are
  // distinct endpoints and flagging them would make the gate unusable.
  assert.deepEqual(
    findDuplicateNormalizedPaths([
      "/api/agents/{id}",
      "/api/agents/{id}/dns",
      "/api/agents/{id}/mappings",
      "/api/agents",
    ]),
    []
  );
});

test("the shipped spec documents no endpoint twice", () => {
  const specPath = path.join(process.cwd(), "docs", "openapi.yaml");
  const spec = yaml.load(fs.readFileSync(specPath, "utf-8")) as { paths?: Record<string, unknown> };
  const dupes = findDuplicateNormalizedPaths(Object.keys(spec.paths ?? {}));

  assert.deepEqual(
    dupes,
    [],
    "a duplicated endpoint makes oasdiff refuse the document, which silently disables " +
      `check:openapi-breaking — found: ${JSON.stringify(dupes)}`
  );
});
