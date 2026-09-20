import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

// Load first: blocks the network before any route/open-sse module is imported.
import { installRouteBackedFetch, type RoutedCall } from "./_helpers/routeBackedFetch.ts";
import { runSkillsGet, runSkillsList } from "../../../bin/cli/commands/skills.mjs";
import { registerNodes } from "../../../bin/cli/commands/nodes.mjs";
import { runMemoryClear } from "../../../bin/cli/commands/memory.mjs";
import { runQuotaCommand } from "../../../bin/cli/commands/quota.mjs";

// Four commands that called routes or verbs the server does not export:
//   skills get   → GET /api/skills/{id}          (route has DELETE/PUT only)
//   nodes get    → GET /api/provider-nodes/{id}  (route has PUT/DELETE only)
//   nodes metrics→ GET /api/provider-nodes/{id}?metrics=true
//   memory clear → DELETE /api/memory            (route has GET/POST only)
//   quota        → GET /api/quota, GET /api/v1/providers (neither exists)
// Each now uses the route the dashboard uses; all are run against real handlers.

const jsonCmd = { optsWithGlobals: () => ({ output: "json", quiet: true }) };

function quiet(t: test.TestContext): string[] {
  const out: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  t.mock.method(process.stderr, "write", () => true);
  t.mock.method(console, "log", (...args: unknown[]) => out.push(args.map(String).join(" ")));
  t.mock.method(console, "error", () => {});
  return out;
}

function implemented(calls: RoutedCall[]): string[] {
  return calls
    .filter((c) => c.status === 404 || c.status === 405)
    .map((c) => `${c.method} ${c.pathname} → ${c.status}`);
}

function nodesProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--output <format>").option("--quiet");
  registerNodes(program);
  return program;
}

test("skills list and get read the catalog route", async (t) => {
  const calls = installRouteBackedFetch(t);
  quiet(t);

  await runSkillsList({}, jsonCmd);
  assert.equal(calls[0].pathname, "/api/skills");
  assert.equal(calls[0].routeFile, "src/app/api/skills/route.ts");
  assert.equal(calls[0].status, 200);

  const exits: number[] = [];
  t.mock.method(process, "exit", (code?: number) => {
    exits.push(code ?? 0);
  });
  await runSkillsGet("definitely-not-a-skill", {}, jsonCmd);
  assert.equal(calls[1].pathname, "/api/skills", "get reads the catalog, not /api/skills/{id}");
  assert.equal(calls[1].search.get("q"), "definitely-not-a-skill");
  assert.equal(calls[1].status, 200);
  assert.deepEqual(exits, [1], "an unknown id still exits 1");
  assert.deepEqual(implemented(calls), []);
});

test("nodes get, list and metrics use the list and metrics routes", async (t) => {
  const calls = installRouteBackedFetch(t);
  quiet(t);
  const exits: number[] = [];
  t.mock.method(process, "exit", (code?: number) => {
    exits.push(code ?? 0);
  });

  const created = await fetch("http://localhost:20128/api/provider-nodes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "openai-compatible",
      apiType: "chat",
      name: "cli test node",
      prefix: "cli-test-node",
      baseUrl: "http://127.0.0.1:1/v1",
    }),
  });
  assert.ok(created.ok, `node fixture must be created (HTTP ${created.status})`);
  const createdBody: unknown = await created.json();
  assert.ok(typeof createdBody === "object" && createdBody !== null && "node" in createdBody);
  const node: unknown = createdBody.node;
  assert.ok(typeof node === "object" && node !== null && "id" in node);
  const nodeId = String(node.id);

  await nodesProgram().parseAsync(["nodes", "get", nodeId, "--output", "json"], { from: "user" });
  const get = calls.at(-1);
  assert.equal(get?.pathname, "/api/provider-nodes");
  assert.equal(get?.routeFile, "src/app/api/provider-nodes/route.ts");
  assert.equal(get?.status, 200);

  await nodesProgram().parseAsync(["nodes", "metrics", nodeId, "--output", "json"], {
    from: "user",
  });
  const metrics = calls.at(-1);
  assert.equal(metrics?.pathname, "/api/provider-metrics");
  assert.equal(metrics?.routeFile, "src/app/api/provider-metrics/route.ts");
  assert.equal(metrics?.status, 200);
  assert.deepEqual(exits, [1], "a node with no traffic has no metrics yet");
  assert.deepEqual(implemented(calls), []);
});

test("memory clear lists and deletes through the real memory routes", async (t) => {
  const calls = installRouteBackedFetch(t);
  const out = quiet(t);

  const created = await fetch("http://localhost:20128/api/memory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: "cli clear fixture",
      key: "cli-clear-fixture",
      type: "factual",
    }),
  });
  assert.ok(created.ok, `memory fixture must be created (HTTP ${created.status})`);

  await runMemoryClear({ yes: true }, jsonCmd);

  const deletes = calls.filter((c) => c.method === "DELETE");
  assert.equal(deletes.length, 1, "the fixture must be deleted one entry at a time");
  assert.equal(deletes[0].routeFile, "src/app/api/memory/[id]/route.ts");
  assert.equal(deletes[0].status, 200);
  assert.match(out.join(""), /"deleted": 1/);

  const remaining = await fetch("http://localhost:20128/api/memory?limit=100");
  const body: unknown = await remaining.json();
  assert.ok(typeof body === "object" && body !== null && "data" in body);
  assert.deepEqual(body.data, []);
  assert.deepEqual(implemented(calls), []);
});

test("quota reads provider quota from /api/usage/quota", async (t) => {
  const calls = installRouteBackedFetch(t);
  const out = quiet(t);

  const exitCode = await runQuotaCommand({ output: "json" });

  assert.equal(exitCode, 0);
  const quota = calls.find((c) => c.pathname === "/api/usage/quota");
  assert.ok(quota, "quota must read the usage quota route");
  assert.equal(quota.routeFile, "src/app/api/usage/quota/route.ts");
  assert.equal(quota.status, 200);
  assert.equal(
    calls.some((c) => c.pathname === "/api/quota" || c.pathname === "/api/v1/providers"),
    false,
    "the phantom quota endpoints are gone"
  );
  assert.match(out.join(""), /"providers"/);
  assert.deepEqual(implemented(calls), []);
});
