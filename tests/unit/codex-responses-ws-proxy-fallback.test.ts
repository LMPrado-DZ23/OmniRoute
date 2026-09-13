/**
 * Finding F-12: when the proxy registry could not be resolved, the Codex Responses WebSocket
 * bridge's `resolveCodexProxy` logged through `logger.warn(...)`. `logger` is the tag factory
 * (`logger(tag) => TaggedLogger`), not a logger, so that call threw a TypeError from inside the
 * catch and the whole `prepare` step failed instead of continuing without a proxy. The resolver is
 * injected here so no real proxy settings or database are involved.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveCodexProxy } from "../../src/app/api/internal/codex-responses-ws/route.ts";

test("a proxy registry failure degrades to a direct connection instead of throwing", async () => {
  const result = await resolveCodexProxy("codex", async () => {
    throw new Error("proxy registry unavailable");
  });
  assert.equal(result, undefined);
});

test("no configured proxy resolves to undefined", async () => {
  assert.equal(await resolveCodexProxy("codex", async () => null), undefined);
});

test("a configured proxy URL is passed through to the bridge", async () => {
  const result = await resolveCodexProxy("codex", async () => "http://proxy.internal:3128");
  assert.equal(typeof result, "string");
  assert.match(String(result), /proxy\.internal:3128/);
});

test("the resolver receives the provider id", async () => {
  const seen: unknown[] = [];
  await resolveCodexProxy("codex", async (providerId) => {
    seen.push(providerId);
    return null;
  });
  assert.deepEqual(seen, ["codex"]);
});
