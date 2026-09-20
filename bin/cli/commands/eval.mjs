import { readFileSync } from "node:fs";
import { apiFetch } from "../api.mjs";
import { emit } from "../output.mjs";
import { t } from "../i18n.mjs";

function fmtTs(v) {
  if (!v) return "-";
  try {
    return new Date(v).toLocaleString();
  } catch {
    return String(v);
  }
}

const suiteSchema = [
  { key: "id", header: "Suite ID", width: 22 },
  { key: "name", header: "Name", width: 30 },
  { key: "samples", header: "Samples" },
  { key: "rubric", header: "Rubric", width: 16 },
  { key: "updatedAt", header: "Updated", formatter: fmtTs },
];

const runSchema = [
  { key: "id", header: "Run ID", width: 22 },
  { key: "suiteId", header: "Suite", width: 18 },
  { key: "status", header: "Status", width: 12 },
  { key: "model", header: "Model", width: 25 },
  { key: "score", header: "Score", formatter: (v) => (v != null ? v.toFixed(3) : "-") },
  {
    key: "duration",
    header: "Duration",
    formatter: (v) => (v != null ? `${(v / 1000).toFixed(1)}s` : "-"),
  },
  { key: "startedAt", header: "Started", formatter: fmtTs },
];

function renderScorecard(data) {
  const score = data.score ?? data.overallScore ?? null;
  const passed = data.passed ?? data.summary?.passed ?? null;
  const total = data.total ?? data.summary?.total ?? null;
  process.stdout.write("\n=== Scorecard ===\n");
  if (score != null) process.stdout.write(`Overall score: ${(score * 100).toFixed(1)}%\n`);
  if (passed != null && total != null) {
    process.stdout.write(`Passed: ${passed}/${total}\n`);
    const bar = "█".repeat(Math.round((passed / total) * 20)).padEnd(20, "░");
    process.stdout.write(`[${bar}] ${((passed / total) * 100).toFixed(0)}%\n`);
  }
  const metrics = data.metrics ?? data.breakdown ?? {};
  for (const [k, v] of Object.entries(metrics)) {
    process.stdout.write(`  ${k}: ${typeof v === "number" ? v.toFixed(3) : v}\n`);
  }
  process.stdout.write("\n");
}

/** GET /api/evals returns { suites, recentRuns, scorecard, targets, apiKeys }. */
async function fetchEvalOverview() {
  const res = await apiFetch("/api/evals");
  if (!res.ok) {
    process.stderr.write(`Error: ${res.status}\n`);
    process.exit(1);
    return {};
  }
  return res.json();
}

export async function runEvalSuitesList(opts, cmd) {
  const data = await fetchEvalOverview();
  emit(data.suites ?? [], cmd.optsWithGlobals(), suiteSchema);
}

export async function runEvalSuitesGet(id, opts, cmd) {
  const res = await apiFetch(`/api/evals/suites/${id}`);
  if (!res.ok) {
    process.stderr.write(`Not found: ${id}\n`);
    process.exit(1);
  }
  emit(await res.json(), cmd.optsWithGlobals());
}

export async function runEvalSuitesCreate(opts, cmd) {
  if (!opts.file) {
    process.stderr.write("--file required\n");
    process.exit(2);
  }
  const body = JSON.parse(readFileSync(opts.file, "utf8"));
  const res = await apiFetch("/api/evals/suites", { method: "POST", body });
  if (!res.ok) {
    process.stderr.write(`Error: ${res.status}\n`);
    process.exit(1);
  }
  emit(await res.json(), cmd.optsWithGlobals());
}

export async function runEvalRun(suiteId, opts, cmd) {
  const globalOpts = cmd.optsWithGlobals();
  // evalRunSuiteSchema: a target is {type: "model"|"combo"|"suite-default", id}.
  const body = { suiteId };
  if (opts.model) body.target = { type: "model", id: opts.model };
  else if (opts.combo) body.target = { type: "combo", id: opts.combo };
  if (opts.compareModel) body.compareTarget = { type: "model", id: opts.compareModel };
  if (opts.apiKeyId) body.apiKeyId = opts.apiKeyId;
  const res = await apiFetch("/api/evals", { method: "POST", body });
  if (!res.ok) {
    process.stderr.write(`Error: ${res.status}\n`);
    process.exit(1);
    return;
  }
  // The run completes inside the request; the answer carries every run.
  const result = await res.json();
  emit(result.runs ?? result, globalOpts, runSchema);
  if (result.scorecard && !globalOpts.quiet && globalOpts.output !== "json") {
    renderScorecard(result.scorecard);
  }
}

export async function runEvalList(opts, cmd) {
  // The route returns the 20 most recent runs and takes no filters.
  const data = await fetchEvalOverview();
  const runs = Array.isArray(data.recentRuns) ? data.recentRuns : [];
  const filtered = opts.suite ? runs.filter((run) => run.suiteId === opts.suite) : runs;
  emit(filtered, cmd.optsWithGlobals(), runSchema);
}

export async function runEvalScorecard(opts, cmd) {
  // The scorecard is the history the overview already computes.
  const data = (await fetchEvalOverview()).scorecard ?? {};
  const globalOpts = cmd.optsWithGlobals();
  if (globalOpts.output === "json") {
    emit(data, globalOpts);
  } else {
    renderScorecard(data);
  }
}

export function registerEval(program) {
  const evalCmd = program.command("eval").description(t("eval.description"));

  const suites = evalCmd.command("suites").description(t("eval.suites.description"));
  suites.command("list").description(t("eval.suites.list.description")).action(runEvalSuitesList);
  suites
    .command("get <suiteId>")
    .description(t("eval.suites.get.description"))
    .action(runEvalSuitesGet);
  suites
    .command("create")
    .description(t("eval.suites.create.description"))
    .option("--file <path>", t("eval.suites.create.file"))
    .action(runEvalSuitesCreate);

  evalCmd
    .command("run <suiteId>")
    .description(t("eval.run.description"))
    .option("-m, --model <id>", t("eval.run.model"))
    .option("--combo <name>", t("eval.run.combo"))
    .option("--compare-model <id>", t("eval.run.compareModel"))
    .option("--api-key-id <id>", t("eval.run.apiKeyId"))
    .action(runEvalRun);

  evalCmd
    .command("list")
    .description(t("eval.list.description"))
    .option("--suite <id>", t("eval.list.suite"))
    .action(runEvalList);

  evalCmd
    .command("scorecard")
    .description(t("eval.scorecard.description"))
    .action(runEvalScorecard);
}
