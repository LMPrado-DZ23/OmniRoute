/**
 * Routing types shared by src/ and open-sse/ are declared once, in src/shared/contracts/routing.ts.
 * Before this contract existed, RoutingFactor was declared twice with the same fields
 * (src/lib/a2a/routingLogger.ts and open-sse/mcp-server/schemas/audit.ts) and the circuit state
 * union lived only in the adaptive scorer. This test fails if a look-alike copy comes back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
const CONTRACT = "src/shared/contracts/routing.ts";

test("the routing contract declares RoutingFactor and RoutingCircuitState", () => {
  const contract = read(CONTRACT);
  assert.match(contract, /export interface RoutingFactor \{/);
  for (const field of [
    "name: string;",
    "value: number;",
    "weight: number;",
    "contribution: number;",
  ]) {
    assert.ok(contract.includes(field), `RoutingFactor must keep the field ${field}`);
  }
  assert.match(contract, /export type RoutingCircuitState = "closed" \| "open" \| "half_open";/);
  assert.doesNotMatch(contract, /^import (?!type )/m, "the contract has no runtime imports");
});

const CONSUMERS: Array<{ file: string; typeName: string; contractName: string }> = [
  {
    file: "src/lib/a2a/routingLogger.ts",
    typeName: "RoutingFactor",
    contractName: "RoutingFactor",
  },
  {
    file: "open-sse/mcp-server/schemas/audit.ts",
    typeName: "RoutingFactor",
    contractName: "RoutingFactor",
  },
  {
    file: "src/lib/routing/adaptiveRouting.ts",
    typeName: "CircuitState",
    contractName: "RoutingCircuitState",
  },
];

test("routing consumers reuse the contract types instead of redeclaring them", () => {
  for (const { file, typeName, contractName } of CONSUMERS) {
    const source = read(file);
    assert.doesNotMatch(
      source,
      new RegExp(`export interface ${typeName} \\{`),
      `${file} must not redeclare ${typeName}`
    );
    assert.doesNotMatch(
      source,
      new RegExp(`export type ${typeName} = "`),
      `${file} must not redeclare the ${typeName} union`
    );
    assert.match(
      source,
      new RegExp(
        `import type \\{[^}]*\\b${contractName}\\b[^}]*\\} from "@/shared/contracts/routing"`
      ),
      `${file} must import ${contractName} from the routing contract`
    );
  }
});

test("the MCP schemas index still exports RoutingFactor for its consumers", () => {
  assert.match(read("open-sse/mcp-server/schemas/index.ts"), /type RoutingFactor/);
});
