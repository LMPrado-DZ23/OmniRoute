/**
 * toComboLike is the normalizer resolveNestedComboTargets applies to every nested combo. The combo
 * test route and the combo forecast/health modules now apply it to the top combo as well, so a stored
 * row resolves to the same targets as the equivalent well-formed combo.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-to-combo-like-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { resolveNestedComboTargets, toComboLike } = await import("../../open-sse/services/combo.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("toComboLike keeps a well-formed stored combo's fields", () => {
  const stored: Record<string, unknown> = {
    id: "combo-1",
    name: "primary",
    strategy: "priority",
    models: ["openai/gpt-4o"],
    config: { maxRetries: 1 },
    autoConfig: null,
  };
  const combo = toComboLike(stored);
  assert.equal(combo.id, "combo-1");
  assert.equal(combo.name, "primary");
  assert.equal(combo.strategy, "priority");
  assert.deepEqual(combo.models, ["openai/gpt-4o"]);
  assert.deepEqual(combo.config, { maxRetries: 1 });
  assert.equal(combo.autoConfig, null);
});

test("toComboLike normalizes malformed fields the way nested combos already are", () => {
  const combo = toComboLike({ name: "  padded  ", models: "not-a-list", config: "bad" });
  assert.equal(combo.name, "padded");
  assert.deepEqual(combo.models, []);
  assert.equal(combo.config, null);
});

test("a normalized stored row resolves to the same targets as the equivalent combo", () => {
  const stored: Record<string, unknown> = { name: "primary", models: ["openai/gpt-4o"] };
  const fromRow = resolveNestedComboTargets(toComboLike(stored), [stored]);
  const direct = resolveNestedComboTargets({ name: "primary", models: ["openai/gpt-4o"] }, [
    stored,
  ]);
  assert.deepEqual(fromRow, direct);
  assert.equal(fromRow.length, 1);
  assert.equal(fromRow[0].modelStr, "openai/gpt-4o");
});
