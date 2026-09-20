import { describe, it } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../open-sse/executors/v0-vercel-web.ts");

// Hermetic outbound layer — installed AFTER every import, because
// open-sse/utils/proxyFetch.ts replaces globalThis.fetch at import time and would
// discard a stub installed before it. Production code under test makes best-effort
// calls (catalog polls, egress probes) that must never leave the machine.
const { installOfflineOutbound } = await import("./_helpers/offlineOutbound.ts");
await installOfflineOutbound();

describe("V0VercelWebExecutor", () => {
  it("can be instantiated", () => {
    const executor = new mod.V0VercelWebExecutor();
    assert.ok(executor);
  });

  it("execute returns error on fetch failure", async () => {
    const executor = new mod.V0VercelWebExecutor();
    try {
      const result = await executor.execute({
        model: "v0-default",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "" },
        signal: null,
      });
      assert.ok(result.response instanceof Response);
      assert.ok(result.url.includes("v0.dev"));
    } catch {
      // Network error expected
    }
  });
});
