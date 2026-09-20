import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

// Load first: blocks the network before any route/open-sse module is imported.
import { installRouteBackedFetch } from "./_helpers/routeBackedFetch.ts";
import { registerCompression } from "../../../bin/cli/commands/compression.mjs";

// `compression rules add/remove` POSTed and DELETEd /api/compression/rules,
// which only exports GET: the rules are the engine's built-in caveman rules
// (open-sse/services/compression/cavemanRules.ts), so a user cannot create or
// delete one. Only the listing survives, and it is run against the real route.

function rulesCommand() {
  const program = new Command();
  program.exitOverride();
  program.option("--output <format>").option("--quiet");
  registerCompression(program);
  return program.commands
    .find((c) => c.name() === "compression")
    ?.commands.find((c) => c.name() === "rules");
}

test("compression rules offers only the read-only listing", () => {
  const rules = rulesCommand();
  assert.ok(rules);
  assert.deepEqual(
    rules.commands.map((c) => c.name()),
    ["list"]
  );
  assert.match(rules.helpInformation(), /built into the engine|built-in/i);
});

test("compression rules list reads the real GET /api/compression/rules", async (t) => {
  const calls = installRouteBackedFetch(t);
  const printed: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    printed.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });

  const program = new Command();
  program.exitOverride();
  program.option("--output <format>").option("--quiet");
  registerCompression(program);
  await program.parseAsync(["compression", "rules", "list", "--output", "json"], { from: "user" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].pathname, "/api/compression/rules");
  assert.equal(calls[0].routeFile, "src/app/api/compression/rules/route.ts");
  assert.equal(calls[0].status, 200);

  const out = printed.join("");
  const rules: unknown = JSON.parse(out.slice(out.indexOf("[\n")));
  assert.ok(Array.isArray(rules) && rules.length > 0, "the engine ships built-in rules");
  const first: unknown = rules[0];
  assert.ok(typeof first === "object" && first !== null);
  for (const field of ["name", "category", "minIntensity", "description"]) {
    assert.ok(field in first, `rule metadata must carry ${field}`);
  }
});
