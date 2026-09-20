import test from "node:test";
import assert from "node:assert/strict";
import { makeMcpStreamFetch } from "./helpers/mcpStreamMock.ts";

test("combo suggest chama omniroute_best_combo_for_task via MCP", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = makeMcpStreamFetch({
    toolResult: {
      recommendedCombo: { id: "c1", name: "fast-combo", reason: "Best latency for coding" },
      alternatives: [],
      freeAlternative: null,
    },
  });
  const { mcpCallTool } = await import("../../bin/cli/mcpClient.mjs");
  const result = await mcpCallTool("omniroute_best_combo_for_task", { taskType: "coding" });
  globalThis.fetch = origFetch;
  const recommended = (result as any).recommendedCombo;
  assert.equal(recommended.name, "fast-combo");
  assert.equal(recommended.reason, "Best latency for coding");
});

test("combo suggest --max-cost/--max-latency-ms viram budget/latency constraints", async () => {
  const origFetch = globalThis.fetch;
  const captured: any[] = [];
  globalThis.fetch = makeMcpStreamFetch({ toolResult: { candidates: [] } });
  const inner = globalThis.fetch;
  globalThis.fetch = ((url: any, init: any) => {
    captured.push({ url: String(url), init });
    return inner(url, init);
  }) as any;
  const { mcpCallTool } = await import("../../bin/cli/mcpClient.mjs");
  await mcpCallTool("omniroute_best_combo_for_task", {
    taskType: "analysis",
    budgetConstraint: 0.001,
    latencyConstraint: 500,
  });
  globalThis.fetch = origFetch;
  const args = JSON.parse(
    captured.find((c) => /tools\/call/.test(String(c.init?.body || "")))?.init?.body || "{}"
  )?.params?.arguments;
  assert.equal(args.taskType, "analysis");
  assert.equal(args.budgetConstraint, 0.001);
  assert.equal(args.latencyConstraint, 500);
});

test("combo.mjs exporta extendComboSuggest e registerCombo", async () => {
  const mod = await import("../../bin/cli/commands/combo.mjs");
  assert.equal(typeof mod.registerCombo, "function");
  assert.equal(typeof mod.extendComboSuggest, "function");
});
