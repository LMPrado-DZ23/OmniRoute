import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

// Must be imported before anything that can load a route or open-sse.
import { assertNetworkGuarded, installRouteBackedFetch } from "./_helpers/routeBackedFetch.ts";

// The CLI route tests import real route handlers, which load
// open-sse/utils/proxyFetch.ts. That module re-patches globalThis.fetch and
// sends direct traffic through its own undici Agent — past a naive fetch stub
// and onto the network. These tests pin that the helper closes every path.

test("the guard is live before any route is imported", () => {
  assert.doesNotThrow(() => assertNetworkGuarded());
});

test("global fetch refuses any non-loopback URL", async (t) => {
  installRouteBackedFetch(t);
  await assert.rejects(fetch("https://api.anthropic.com/v1/messages"), /blocked outbound/);
});

test("proxyFetch's own exports cannot reach the network either", async (t) => {
  installRouteBackedFetch(t);
  const proxyFetchModule = await import("../../../open-sse/utils/proxyFetch.ts");
  await assert.rejects(proxyFetchModule.default("https://api.openai.com/v1/models"));
  await assert.rejects(proxyFetchModule.getOriginalFetch()("https://api.openai.com/v1/models"));
  assert.doesNotThrow(() => assertNetworkGuarded(), "importing proxyFetch must not unguard fetch");
});

test("raw TCP connects are blocked (covers undici Agents, node:https, SDK clients)", () => {
  assert.throws(() => net.connect({ host: "127.0.0.1", port: 9 }), /outbound TCP connect blocked/);
});

test("importing a real route keeps the guard in place", async (t) => {
  const calls = installRouteBackedFetch(t);
  const res = await fetch("http://localhost:20128/api/policies");
  assert.equal(res.status, 200);
  assert.equal(calls[0]?.routeFile, "src/app/api/policies/route.ts");
  assert.doesNotThrow(() => assertNetworkGuarded());
});
