process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "cli-budget-route-test-secret";

import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

// Load first: blocks the network before any route/open-sse module is imported.
import { installRouteBackedFetch } from "./_helpers/routeBackedFetch.ts";
import { registerCommands } from "../../../bin/cli/commands/registry.mjs";
import {
  runBudgetClear,
  runBudgetGet,
  runBudgetList,
  runBudgetSet,
} from "../../../bin/cli/commands/usage.mjs";

// Subcommands whose endpoint never existed and whose capability lives nowhere
// else in the product are gone: mcp restart, oneproxy config set, sessions
// expire/expire-all, sync pull, pricing defaults set and the whole `tags`
// command (/api/tags is the Ollama model list, not resource tags).
// `usage budget` was rebuilt on the real per-API-key routes.

function program(): Command {
  const p = new Command();
  p.exitOverride();
  p.option("--output <format>").option("--quiet");
  registerCommands(p);
  return p;
}

function subcommands(...pathParts: string[]): string[] {
  let current: Command | undefined = program();
  for (const part of pathParts) {
    current = current?.commands.find((c) => c.name() === part);
  }
  assert.ok(current, `command ${pathParts.join(" ")} must exist`);
  return current.commands.map((c) => c.name());
}

const jsonCmd = { optsWithGlobals: () => ({ output: "json", quiet: true }) };

async function createTestApiKey(): Promise<string> {
  const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
  const created = await createApiKey("cli-budget-test", "cli-test-machine", ["manage"]);
  return String(created.id);
}

test("commands with no backing endpoint are no longer offered", () => {
  assert.equal(subcommands("mcp").includes("restart"), false);
  assert.equal(subcommands("oneproxy", "config").includes("set"), false);
  assert.equal(subcommands("sessions").includes("expire"), false);
  assert.equal(subcommands("sessions").includes("expire-all"), false);
  assert.equal(subcommands("sync").includes("pull"), false);
  assert.equal(subcommands("pricing", "defaults").includes("set"), false);
  assert.equal(
    program().commands.some((c) => c.name() === "tags"),
    false,
    "there is no resource-tag feature"
  );
  // what survives still exists
  assert.ok(subcommands("mcp").includes("status"));
  assert.ok(subcommands("sync").includes("bundle"));
  assert.ok(subcommands("pricing", "defaults").includes("show"));
});

test("usage budget set/get/list/clear run against the real budget routes", async (t) => {
  const calls = installRouteBackedFetch(t);
  const out: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  t.mock.method(process.stderr, "write", () => true);
  const apiKeyId = await createTestApiKey();

  await runBudgetSet(apiKeyId, { daily: 5, monthly: 50 }, jsonCmd);
  const set = calls.find((c) => c.method === "POST" && c.pathname === "/api/usage/budget");
  assert.ok(set);
  assert.equal(set.routeFile, "src/app/api/usage/budget/route.ts");
  assert.equal(set.status, 200, "setBudgetSchema must accept the body");
  assert.deepEqual(set.body, { apiKeyId, dailyLimitUsd: 5, monthlyLimitUsd: 50 });

  await runBudgetGet(apiKeyId, {}, jsonCmd);
  const get = calls.find((c) => c.method === "GET" && c.pathname === "/api/usage/budget");
  assert.ok(get);
  assert.equal(get.search.get("apiKeyId"), apiKeyId, "the route requires apiKeyId");
  assert.equal(get.status, 200);

  await runBudgetList({}, jsonCmd);
  const list = calls.find((c) => c.pathname === "/api/usage/budget/bulk");
  assert.ok(list, "the all-keys summary is the bulk route");
  assert.equal(list.status, 200);

  await runBudgetClear(apiKeyId, {}, jsonCmd);
  const clear = calls
    .filter((c) => c.method === "POST" && c.pathname === "/api/usage/budget")
    .at(-1);
  assert.deepEqual(clear?.body, {
    apiKeyId,
    dailyLimitUsd: 0,
    weeklyLimitUsd: 0,
    monthlyLimitUsd: 0,
  });
  assert.equal(clear?.status, 200);

  const after = await fetch(`http://localhost:20128/api/usage/budget?apiKeyId=${apiKeyId}`);
  const body: unknown = await after.json();
  assert.ok(typeof body === "object" && body !== null && "dailyLimitUsd" in body);
  assert.equal(Number(body.dailyLimitUsd), 0, "clearing lifts the limits for real");

  assert.deepEqual(
    calls.filter((c) => c.status === 404 || c.status === 405),
    []
  );
});
