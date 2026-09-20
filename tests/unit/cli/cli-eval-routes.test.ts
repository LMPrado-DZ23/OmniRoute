import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

// Load first: blocks the network before any route/open-sse module is imported.
import { installRouteBackedFetch } from "./_helpers/routeBackedFetch.ts";
import { registerEval, runEvalList, runEvalSuitesList } from "../../../bin/cli/commands/eval.mjs";

// `eval suites list` GET /api/evals/suites (POST-only) and `eval cancel`
// POSTed /api/evals/{runId} — which is the single-SUITE route, so cancel could
// only ever 404/405. Runs finish inside POST /api/evals, so there is nothing to
// poll or cancel: the overview route carries suites, recent runs and the
// scorecard, and that is what the commands read now.

const jsonCmd = { optsWithGlobals: () => ({ output: "json", quiet: true }) };

function evalCommand(): Command {
  const program = new Command();
  program.exitOverride();
  registerEval(program);
  const evalCmd = program.commands.find((c) => c.name() === "eval");
  assert.ok(evalCmd);
  return evalCmd;
}

test("eval offers only the commands the routes support", () => {
  const names = evalCommand().commands.map((c) => c.name());
  assert.deepEqual(names.sort(), ["list", "run", "scorecard", "suites"]);
  for (const gone of ["get", "results", "cancel"]) {
    assert.equal(names.includes(gone), false, `${gone} has no run-by-id route`);
  }
  const run = evalCommand().commands.find((c) => c.name() === "run");
  const longs = run?.options.map((o) => o.long) ?? [];
  assert.equal(longs.includes("--watch"), false, "runs complete synchronously");
  assert.equal(longs.includes("--concurrency"), false, "the schema has no concurrency");
  assert.equal(longs.includes("--tag"), false, "the schema has no tag");
});

test("eval suites list and eval list read the real overview route", async (t) => {
  const calls = installRouteBackedFetch(t);
  t.mock.method(process.stdout, "write", () => true);
  t.mock.method(process.stderr, "write", () => true);

  await runEvalSuitesList({}, jsonCmd);
  assert.equal(calls[0].pathname, "/api/evals");
  assert.equal(calls[0].routeFile, "src/app/api/evals/route.ts");
  assert.equal(calls[0].status, 200);

  await runEvalList({}, jsonCmd);
  assert.equal(calls[1].pathname, "/api/evals");
  assert.equal(calls[1].status, 200);

  assert.deepEqual(
    calls.filter((c) => c.status === 404 || c.status === 405),
    []
  );
});

test("eval suites list prints the suites the server ships", async (t) => {
  installRouteBackedFetch(t);
  const out: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });

  await runEvalSuitesList({}, jsonCmd);

  const text = out.join("");
  const suites: unknown = JSON.parse(text.slice(text.indexOf("[\n")));
  assert.ok(Array.isArray(suites), "the suites array is printed, not the whole overview");
});
