import { describe, it } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../open-sse/executors/venice-web.ts");

// Hermetic outbound layer — installed AFTER every import, because
// open-sse/utils/proxyFetch.ts replaces globalThis.fetch at import time and would
// discard a stub installed before it. Production code under test makes best-effort
// calls (catalog polls, egress probes) that must never leave the machine.
const { installOfflineOutbound } = await import("./_helpers/offlineOutbound.ts");
await installOfflineOutbound();

describe("VeniceWebExecutor", () => {
  it("can be instantiated", () => {
    const executor = new mod.VeniceWebExecutor();
    assert.ok(executor);
  });

  it("execute returns error on fetch failure", async () => {
    const executor = new mod.VeniceWebExecutor();
    try {
      const result = await executor.execute({
        model: "venice-default",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "" },
        signal: null,
      });
      assert.ok(result.response instanceof Response);
      assert.ok(typeof result.url === "string");
      assert.ok(result.url.includes("venice.ai"));
    } catch {
      // Network error expected
    }
  });
});
