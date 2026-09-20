import { describe, it } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../open-sse/executors/poe-web.ts");

// Hermetic outbound layer — installed AFTER every import (proxyFetch replaces
// globalThis.fetch at import time). See tests/unit/_helpers/offlineOutbound.ts.
await (await import("./_helpers/offlineOutbound.ts")).installOfflineOutbound();

describe("PoeWebExecutor", () => {
  it("can be instantiated", () => {
    const executor = new mod.PoeWebExecutor();
    assert.ok(executor);
  });

  it("execute returns error on fetch failure", async () => {
    const executor = new mod.PoeWebExecutor();
    try {
      const result = await executor.execute({
        model: "poe-default",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "" },
        signal: null,
      });
      assert.ok(result.response instanceof Response);
      // Parse the host instead of substring-matching the URL: a bare
      // `.includes("poe.com")` would also accept hostile URLs like
      // `https://evil.com/?x=poe.com` (CodeQL js/incomplete-url-substring-sanitization).
      const host = new URL(result.url).hostname;
      assert.ok(host === "poe.com" || host.endsWith(".poe.com"), `unexpected host: ${host}`);
    } catch {
      // Network error expected
    }
  });
});
