import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

// Load first: blocks the network before any route/open-sse module is imported.
import { installRouteBackedFetch } from "./_helpers/routeBackedFetch.ts";
import { extendComboSuggest, suggestRows } from "../../../bin/cli/commands/combo.mjs";

// `combo suggest --switch` POSTed /api/combos/switch, which never existed — and
// there is no "active combo" to switch to: a combo is selected per request by
// sending its name as the `model` (src/sse/services/model.ts → getComboByName).
// The command also sent `{task, weights, top}` to omniroute_best_combo_for_task,
// whose schema is `{taskType, budgetConstraint?, latencyConstraint?}` and whose
// answer is a recommendation with alternatives, not a scored candidate list.
// Exercised end to end against the real MCP and combo route handlers.

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--output <format>").option("--quiet");
  const combo = program.command("combo");
  extendComboSuggest(combo);
  return program;
}

function suggestCommand() {
  return buildProgram()
    .commands.find((c) => c.name() === "combo")
    ?.commands.find((c) => c.name() === "suggest");
}

test("combo suggest offers the real tool's arguments and no --switch", () => {
  const suggest = suggestCommand();
  assert.ok(suggest);
  const longs = suggest.options.map((o) => o.long);
  assert.equal(longs.includes("--switch"), false, "there is no switch endpoint");
  assert.equal(longs.includes("--weights"), false, "the tool takes no weights");
  assert.equal(longs.includes("--top"), false, "the tool takes no top-N");
  assert.deepEqual(longs.sort(), ["--max-cost", "--max-latency-ms", "--task-type"]);
});

test("suggestRows flattens recommendation, alternatives and free option", () => {
  const rows = suggestRows({
    recommendedCombo: { id: "a", name: "fast", reason: "lowest latency" },
    alternatives: [{ id: "b", name: "cheap", tradeoff: "slower" }],
    freeAlternative: { id: "c", name: "free-tier" },
  });
  assert.deepEqual(
    rows.map((r) => `${r.rank}:${r.name}:${r.kind}`),
    ["1:fast:recommended", "2:cheap:alternative", "3:free-tier:free"]
  );
});

test("combo suggest reaches the real MCP tool and prints how to use the winner", async (t) => {
  // Scopes come from the API key or the operator OMNIROUTE_MCP_SCOPES fallback
  // (open-sse/mcp-server/scopeEnforcement.ts); an unauthenticated loopback caller
  // has none, so grant the tool's scopes before the server module loads.
  process.env.OMNIROUTE_MCP_SCOPES = "read:combos,read:health";
  const calls = installRouteBackedFetch(t);
  const mcpOn = await fetch("http://localhost:20128/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mcpEnabled: true, mcpTransport: "streamable-http" }),
  });
  assert.ok(mcpOn.ok, `MCP must be enabled for suggest (HTTP ${mcpOn.status})`);
  const created = await fetch("http://localhost:20128/api/combos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "suggest-fast", models: ["openai/gpt-4o-mini"] }),
  });
  assert.ok(created.ok, `combo fixture must be created (HTTP ${created.status})`);

  const stderr: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  t.mock.method(process.stdout, "write", () => true);

  await buildProgram().parseAsync(
    ["combo", "suggest", "--task-type", "coding", "--output", "json"],
    {
      from: "user",
    }
  );

  const toolCall = calls.find(
    (c) =>
      c.pathname === "/api/mcp/stream" &&
      typeof c.body === "object" &&
      c.body !== null &&
      "method" in c.body &&
      c.body.method === "tools/call"
  );
  assert.ok(toolCall, "suggest must call the MCP tool");
  assert.equal(toolCall.status, 200, "the real MCP handler must accept the request");
  assert.ok(
    calls.every((c) => c.status !== 404 && c.status !== 405),
    `every request must reach an implemented route: ${calls
      .map((c) => `${c.method} ${c.pathname} ${c.status}`)
      .join(", ")}`
  );
  assert.equal(
    calls.some((c) => c.pathname.includes("/switch")),
    false
  );
  assert.match(stderr.join(""), /"model": "suggest-fast"/);
});
