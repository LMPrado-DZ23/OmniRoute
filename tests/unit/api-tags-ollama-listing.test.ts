/**
 * `GET /api/tags` is the Ollama-compatible model listing: it is what `ollama list`
 * and every Ollama client calls to discover models, so its response shape is a
 * public contract, not an internal detail.
 *
 * It had no test of its own. The only file that referenced it was
 * `tests/unit/cli-tags-commands.test.ts`, which covered an unrelated CLI `tags`
 * command (label management the server never implemented). When that command was
 * removed, the route silently lost its only coverage — the API-governance gate is
 * what caught it. This test covers the route directly so the two are no longer tied.
 */
import test from "node:test";
import assert from "node:assert/strict";

const route = await import("../../src/app/api/tags/route.ts");

test("GET /api/tags answers the Ollama listing contract", async () => {
  const res = await route.GET();

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);

  const body = await res.json();
  assert.ok(Array.isArray(body.models), "an Ollama client reads `models` as an array");
  assert.ok(body.models.length > 0, "an empty listing would make every model undiscoverable");

  for (const model of body.models) {
    // The fields `ollama list` prints for each row. A missing one renders as
    // `undefined` in the client rather than failing loudly, so assert each.
    assert.equal(typeof model.name, "string");
    assert.ok(model.name.length > 0);
    assert.equal(typeof model.digest, "string");
    assert.equal(typeof model.size, "number", "size is formatted as bytes, not parsed from text");
    assert.ok(Number.isFinite(model.size) && model.size > 0);
    assert.ok(
      Number.isFinite(Date.parse(model.modified_at)),
      `modified_at must be a parseable timestamp, got ${JSON.stringify(model.modified_at)}`
    );
    assert.equal(typeof model.details?.format, "string");
    assert.equal(typeof model.details?.family, "string");
    assert.equal(typeof model.details?.parameter_size, "string");
    assert.equal(typeof model.details?.quantization_level, "string");
  }
});

test("the preflight advertises GET and leaves the origin to the middleware", async () => {
  const res = await route.OPTIONS();

  assert.match(res.headers.get("access-control-allow-methods") ?? "", /GET/);
  // `src/shared/utils/cors.ts` is explicit that the middleware is the single source
  // of truth for the allowed origin; a handler echoing one here would bypass the
  // allowlist in `src/server/cors/origins.ts`.
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});
