process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "cli-keys-route-test-secret";

import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

// Load first: blocks the network before any route/open-sse module is imported.
import { installRouteBackedFetch, type RoutedCall } from "./_helpers/routeBackedFetch.ts";
import {
  registerKeys,
  runKeysAddCommand,
  runKeysListCommand,
  runKeysPolicySetCommand,
  runKeysPolicyShowCommand,
  runKeysRegenerateCommand,
  runKeysRemoveCommand,
  runKeysUsageCommand,
} from "../../../bin/cli/commands/keys.mjs";

// Nine `keys` calls went to /api/v1/providers/keys and /api/v1/registered-keys/
// {id}/{policy,reveal,usage,regenerate,rotate} — none of which exist. Provider
// credentials are provider connections (/api/providers), and per-key limits,
// regeneration and history belong to OmniRoute API keys (/api/keys,
// /api/usage/call-logs). Every command below runs against the real handlers.

function quiet(t: test.TestContext): string[] {
  const out: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => out.push(args.map(String).join(" ")));
  t.mock.method(console, "error", (...args: unknown[]) => out.push(args.map(String).join(" ")));
  t.mock.method(process.stdout, "write", () => true);
  t.mock.method(process.stderr, "write", () => true);
  return out;
}

function unimplemented(calls: RoutedCall[]): string[] {
  return calls
    .filter((c) => c.status === 404 || c.status === 405)
    .map((c) => `${c.method} ${c.pathname} → ${c.status}`);
}

async function createTestApiKey(): Promise<{ id: string; name: string }> {
  // POST /api/keys derives a machine id from the host; create the row directly
  // so the fixture does not depend on that.
  const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
  const created = await createApiKey("cli-keys-test", "cli-test-machine", ["manage"]);
  return { id: String(created.id), name: "cli-keys-test" };
}

test("keys add, list and remove drive provider connections", async (t) => {
  const calls = installRouteBackedFetch(t);
  quiet(t);

  assert.equal(await runKeysAddCommand("openai", "sk-cli-test-value", {}), 0);
  const create = calls.find((c) => c.method === "POST" && c.pathname === "/api/providers");
  assert.ok(create, "a new credential is created through POST /api/providers");
  assert.equal(create.routeFile, "src/app/api/providers/route.ts");
  assert.equal(create.status, 201);

  assert.equal(await runKeysListCommand({ json: true }), 0);
  const list = calls.find((c) => c.method === "GET" && c.pathname === "/api/providers");
  assert.ok(list);
  assert.equal(list.status, 200);

  // A second add updates the existing connection instead of duplicating it.
  assert.equal(await runKeysAddCommand("openai", "sk-cli-test-rotated", {}), 0);
  const update = calls.find(
    (c) => c.method === "PATCH" && c.pathname.startsWith("/api/providers/")
  );
  assert.ok(update, "an existing credential is updated in place");
  assert.equal(update.routeFile, "src/app/api/providers/[id]/route.ts");
  assert.equal(update.status, 200);

  assert.equal(await runKeysRemoveCommand("openai", { yes: true }), 0);
  const remove = calls.find(
    (c) => c.method === "DELETE" && c.pathname.startsWith("/api/providers/")
  );
  assert.ok(remove, "removal deletes the connection by id");
  assert.equal(remove.status, 200);
  assert.deepEqual(unimplemented(calls), []);
});

test("keys regenerate, usage and policy act on a real API key", async (t) => {
  const calls = installRouteBackedFetch(t);
  const out = quiet(t);
  const apiKey = await createTestApiKey();

  assert.equal(await runKeysRegenerateCommand(apiKey.id, { yes: true }), 0);
  const regenerate = calls.find((c) => c.pathname.endsWith("/regenerate"));
  assert.ok(regenerate);
  assert.equal(regenerate.routeFile, "src/app/api/keys/[id]/regenerate/route.ts");
  assert.equal(regenerate.status, 200);

  assert.equal(await runKeysUsageCommand(apiKey.id, { limit: "5" }), 0);
  const logs = calls.find((c) => c.pathname === "/api/usage/call-logs");
  assert.ok(logs, "history comes from the call log");
  assert.equal(logs.search.get("apiKey"), apiKey.name, "the log filters by key name");
  assert.equal(logs.status, 200);

  assert.equal(
    await runKeysPolicySetCommand(apiKey.id, {
      rateLimit: 30,
      maxCost: 2.5,
      allowedModels: "gpt-4o-mini,gpt-4o",
    }),
    0
  );
  const patch = calls.find((c) => c.method === "PATCH" && c.pathname === `/api/keys/${apiKey.id}`);
  assert.ok(patch, "limits are written to the key record");
  assert.equal(patch.status, 200, "the real schema must accept the body");
  assert.deepEqual(patch.body, {
    rateLimits: [{ limit: 30, window: 60 }],
    usageLimitEnabled: true,
    dailyUsageLimitUsd: 2.5,
    allowedModels: ["gpt-4o-mini", "gpt-4o"],
    modelAccessMode: "restricted",
  });

  assert.equal(await runKeysPolicyShowCommand(apiKey.id, { json: true }), 0);
  const shown: unknown = JSON.parse(out.filter((line) => line.startsWith("{")).at(-1) ?? "null");
  assert.ok(typeof shown === "object" && shown !== null);
  assert.deepEqual(shown, {
    rateLimits: [{ limit: 30, window: 60 }],
    modelAccessMode: "restricted",
    allowedModels: ["gpt-4o-mini", "gpt-4o"],
    blockedModels: [],
    dailyUsageLimitUsd: 2.5,
    weeklyUsageLimitUsd: null,
    monthlyUsageLimitUsd: null,
  });
  assert.deepEqual(unimplemented(calls), []);
});

test("keys no longer offers reveal or a grace-period rotate", () => {
  const program = new Command();
  program.exitOverride();
  registerKeys(program);
  const keys = program.commands.find((c) => c.name() === "keys");
  assert.ok(keys);
  const names = keys.commands.map((c) => c.name());
  assert.equal(names.includes("reveal"), false, "a stored key is never revealed again");
  assert.equal(names.includes("rotate"), false, "no route rotates with a grace period");
  assert.ok(names.includes("regenerate"), "regenerate is the real replacement");
});
