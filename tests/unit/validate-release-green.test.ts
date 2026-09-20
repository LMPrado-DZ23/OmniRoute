import test from "node:test";
import assert from "node:assert/strict";

// Pure helpers of the release-green validator (Solution C). The orchestration is
// guarded behind a direct-run check, so importing the module here is side-effect-free.
const mod = await import("../../scripts/quality/validate-release-green.mjs");
const {
  firstFailureLine,
  eslintCounts,
  evaluateEslintRun,
  parseEslintJson,
  parseCognitiveCount,
  isDrift,
  computeVerdict,
  classifyRunError,
  extractCiGates,
  FULL_CI_SKIP,
  fullCiTimeoutFor,
  curatedEquivalentId,
  fullCiKindFor,
  ESLINT_TIMEOUT_MS,
  runSlowWave,
  parseSlowGates,
  parseShard,
  mergeSlowReports,
  flagValue,
  SLOW_GATE_IDS,
  parseUnmeasured,
} = mod;

const extract = extractCiGates as (
  yamlText: string,
  opts?: { jobs?: string[]; skip?: Set<string>; envMap?: Record<string, Record<string, string>> }
) => { id: string; job: string; args: string[]; env?: Record<string, string> }[];

test("eslintCounts sums errors + warnings across files", () => {
  const parsed = [{ errorCount: 2, warningCount: 5 }, { errorCount: 0, warningCount: 3 }, {}];
  assert.deepEqual(eslintCounts(parsed), { errors: 2, warnings: 8 });
});

test("parseEslintJson tolerates a leading non-JSON banner", () => {
  const out = 'npm warn something\n[{"errorCount":0,"warningCount":1}]';
  assert.deepEqual(parseEslintJson(out), [{ errorCount: 0, warningCount: 1 }]);
  assert.equal(parseEslintJson("no json here"), null);
});

test("parseEslintJson tolerates ESLint's trailing unpruned-suppressions stderr sentence (#7837)", () => {
  // ESLint 9.x's `--suppressions-location` feature prints the valid `--format json` report to
  // stdout first, then — if the suppressions file has stale/"unpruned" entries — appends this
  // exact sentence to stderr and exits 2. The gate concatenates stdout+stderr, so
  // parseEslintJson() must recover the JSON report even with this trailing text glued on.
  const eslintJsonReport = JSON.stringify([
    { filePath: "open-sse/executors/example.ts", errorCount: 0, warningCount: 0, messages: [] },
  ]);
  const stderrTail =
    "There are suppressions left that do not occur anymore. Consider re-running the command with `--prune-suppressions`.\n";
  assert.deepEqual(parseEslintJson(eslintJsonReport + stderrTail), [
    { filePath: "open-sse/executors/example.ts", errorCount: 0, warningCount: 0, messages: [] },
  ]);
});

test("evaluateEslintRun preserves an ESLint timeout instead of misreporting invalid JSON", () => {
  const timedOut = classifyRunError({ killed: true, code: "ETIMEDOUT" }, 30 * 60 * 1000);

  assert.deepEqual(evaluateEslintRun(timedOut, 0), [
    {
      id: "lint",
      label: "ESLint",
      kind: "hard",
      ok: false,
      detail:
        "gate exceeded its 1800s ceiling and was killed — treat as a hung/failed gate (e.g. an unreleased DB handle in the unit suite); does NOT pass",
    },
  ]);
  assert.equal(ESLINT_TIMEOUT_MS, 60 * 60 * 1000, "cold release lint needs >30m headroom");
});

test("parseCognitiveCount reads the gate's count (en + pt)", () => {
  assert.equal(
    parseCognitiveCount("[cognitive-complexity] 797 function(s) exceed the threshold (15)."),
    797
  );
  assert.equal(
    parseCognitiveCount("[cognitive-complexity] REGRESSÃO — 801 violações > baseline 797"),
    801
  );
  assert.equal(parseCognitiveCount("no number"), null);
});

test("parseCognitiveCount ignores the cyclomatic count in the combined ratchets output (#7009)", () => {
  // `check:complexity-ratchets` runs ONE shared ESLint walk and prints BOTH ratchets.
  // The cyclomatic "N violações" summary is emitted FIRST, so a bare `\\d+ violações`
  // regex captured 2056 (cyclomatic) instead of 890 (cognitive) — a phantom drift in
  // every pre-flight report. Prefer the unambiguous machine-readable `cognitiveComplexity=N`.
  const combined = [
    "complexity=2056",
    "cognitiveComplexity=890",
    "[complexity] OK — 2056 violações (baseline 2056)",
    "[cognitive-complexity] OK — 890 violações (baseline 890)",
  ].join("\n");
  assert.equal(parseCognitiveCount(combined), 890);
});

test("isDrift flags only growth past the committed baseline (down-direction ratchets)", () => {
  assert.equal(isDrift(3900, 3867), true); // grew → drift
  assert.equal(isDrift(3867, 3867), false); // equal → ok
  assert.equal(isDrift(3800, 3867), false); // improved → ok
  assert.equal(isDrift(10, null), false); // no baseline → never drift
  assert.equal(isDrift(null, 10), false); // unparsed → never drift
});

test("firstFailureLine surfaces the meaningful failure, not boilerplate", () => {
  const out = [
    "> omniroute@3.8.34 typecheck:core",
    "src/x.ts(10,5): error TS2322: Type 'string' is not assignable to 'number'.",
    "done",
  ].join("\n");
  assert.match(firstFailureLine(out), /error TS2322/);
});

test("computeVerdict: releaseGreen iff zero HARD failures (drift never blocks)", () => {
  const onlyDrift = computeVerdict([
    { kind: "hard", ok: true },
    { kind: "drift", ok: false },
  ]);
  assert.equal(onlyDrift.releaseGreen, true);
  assert.equal(onlyDrift.drift.length, 1);

  const hardFail = computeVerdict([
    { kind: "hard", ok: false },
    { kind: "drift", ok: false },
  ]);
  assert.equal(hardFail.releaseGreen, false);
  assert.equal(hardFail.hardFailures.length, 1);

  const allGreen = computeVerdict([
    { kind: "hard", ok: true },
    { kind: "drift", ok: true },
  ]);
  assert.equal(allGreen.releaseGreen, true);
});

test("computeVerdict: full-coverage classification — ratchets are drift, defects are hard", () => {
  // Mirrors the expanded check set: the ratchets that historically surfaced in
  // layers on the release PR (complexity/openapi/zizmor/…) are DRIFT → never block;
  // the new real-defect gates (docs-all, integration) are HARD → block.
  const results = [
    { id: "complexity", kind: "drift", ok: false },
    { id: "openapi-coverage", kind: "drift", ok: false },
    { id: "workflow-lint", kind: "drift", ok: false },
    { id: "dead-code", kind: "drift", ok: true },
    { id: "codeql-ratchet", kind: "drift", ok: true },
    { id: "docs-all", kind: "hard", ok: true },
    { id: "integration", kind: "hard", ok: true },
  ];
  const v = computeVerdict(results);
  // Three ratchets drifted but NONE block — release is still green, all reported.
  assert.equal(v.releaseGreen, true);
  assert.equal(v.drift.length, 3);

  // A hard gate (integration assertion regression) flips it red.
  const withHardFail = computeVerdict([...results, { id: "integration", kind: "hard", ok: false }]);
  assert.equal(withHardFail.releaseGreen, false);
  assert.equal(withHardFail.hardFailures.length, 1);
});

test("classifyRunError: a killed gate under a timeout surfaces as a visible non-zero failure (not an infinite hang)", () => {
  // execFileSync kills the child on timeout → err.killed === true. The unit suite wedged on an
  // unreleased SQLite handle must become a reported failure, never an infinite block that gets
  // the pre-flight killed before it surfaces the unit reds (the v3.8.42 miss).
  const r = classifyRunError({ killed: true, signal: "SIGTERM" }, 45 * 60 * 1000);
  assert.equal(r.code, 124);
  assert.match(r.out, /ceiling/);
  assert.match(r.out, /hung\/failed gate/);
});

test("classifyRunError: Node's ETIMEDOUT shape is reported as a timeout", () => {
  const r = classifyRunError({ code: "ETIMEDOUT", signal: "SIGTERM" }, 10 * 60 * 1000);
  assert.equal(r.code, 124);
  assert.match(r.out, /600s ceiling/);
});

test("fullCiTimeoutFor gives test-masking enough time without weakening other gates", () => {
  assert.equal(fullCiTimeoutFor("check:test-masking"), 30 * 60 * 1000);
  assert.equal(fullCiTimeoutFor("check:file-size"), 10 * 60 * 1000);
});

test("classifyRunError: a normal non-zero exit keeps its status + combined output", () => {
  const r = classifyRunError({ status: 1, stdout: "boom-out", stderr: "boom-err" }, undefined);
  assert.equal(r.code, 1);
  assert.equal(r.out, "boom-outboom-err");
});

test("classifyRunError: a kill WITHOUT a configured timeout is not misreported as a timeout", () => {
  // No timeout set → a killed/odd error falls through to the generic branch (code 1), so we never
  // claim a hang ceiling that was not actually configured.
  const r = classifyRunError({ killed: true }, undefined);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, /ceiling/);
});

test("pre-flight wires the test-masking PR-context gate against origin/main (v3.8.43 gap fix)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(
    new URL("../../scripts/quality/validate-release-green.mjs", import.meta.url),
    "utf8"
  );
  // The gate must run check:test-masking, pin the base to main, and be classified HARD —
  // it caught a real net-assert reduction that only surfaced on the release PR before.
  assert.match(src, /check:test-masking/, "test-masking gate must be wired into the pre-flight");
  assert.match(src, /GITHUB_BASE_REF:\s*"main"/, "test-masking must diff against origin/main");
  assert.match(
    src,
    /id:\s*"test-masking"[\s\S]*?kind:\s*"hard"/,
    "test-masking must be a HARD gate (non-allowlisted weakening blocks the release)"
  );
  // run() must honor a per-gate env override so GITHUB_BASE_REF actually reaches the child
  // (routed through buildGateEnv since the --hermetic scrub was added).
  assert.match(
    src,
    /env:\s*buildGateEnv\(opts\.env\)/,
    "run() must merge opts.env into the child env"
  );
  assert.match(
    src,
    /\.\.\.\(extra \|\| \{\}\)/,
    "buildGateEnv must spread the per-gate env override"
  );
});

test("pre-flight --hermetic scrubs the live-test trigger vars (2026-07-05 false-positive fix)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(
    new URL("../../scripts/quality/validate-release-green.mjs", import.meta.url),
    "utf8"
  );
  // A dev machine with OMNIROUTE_API_KEY set runs 17+ live tests that CI skips —
  // the pre-flight must be able to reproduce the CI env exactly.
  assert.match(src, /HERMETIC_SCRUB\s*=\s*\["OMNIROUTE_API_KEY",\s*"OMNIROUTE_URL"\]/);
  assert.match(src, /args\.has\("--hermetic"\)/, "--hermetic flag must be parsed");
  // Per-gate logs: a red must be diagnosable from _artifacts/release-green/<gate>.log
  // without re-running the gate.
  assert.match(src, /saveGateLog/, "per-gate output must be persisted");
  assert.match(src, /_artifacts[/", ]+release-green/, "logs must land in _artifacts/release-green");
});

test("pre-flight runs the slow suites CONCURRENTLY (v3.8.45 perf — was ~1h serial)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(
    new URL("../../scripts/quality/validate-release-green.mjs", import.meta.url),
    "utf8"
  );
  // main() must be async and the slow suites (unit/vitest/integration/pack-artifact)
  // must run as one wave over runAsync — not four sequential hardCmd calls. The wave is
  // concurrent unless --serial-slow asks for the hosted-runner mode.
  assert.match(src, /async function main\(\)/, "main must be async to await the parallel wave");
  assert.match(src, /const execFileAsync = promisify\(execFile\)/, "async runner must exist");
  // `selected` is `slow` filtered by --slow-gates (all of it when the flag is absent).
  assert.match(
    src,
    /await runSlowWave\(\s*selected,\s*\(g\) =>\s*runAsync\(/,
    "slow suites must run as one wave over runAsync"
  );
  assert.match(
    src,
    /const selected = SLOW_GATES \? slow\.filter\(\(g\) => SLOW_GATES\.has\(g\.id\)\) : slow;/,
    "the whole wave must run when no --slow-gates selection was made"
  );
  assert.match(
    src,
    /export async function runSlowWave[\s\S]*?if \(!serial\) return Promise\.all\(gates\.map\(/,
    "the wave must stay concurrent by default"
  );
  assert.match(
    src,
    /\{ serial: SERIAL_SLOW \}/,
    "only --serial-slow may switch the wave to serial"
  );
  // The four slow-gate ids must all be present in the parallel wave.
  for (const id of ["unit", "vitest", "integration", "pack-artifact"]) {
    assert.ok(src.includes(`id: "${id}"`), `slow gate ${id} must be in the parallel wave`);
  }
  // Each still saves its per-gate log for red diagnosis without a re-run.
  assert.match(
    src,
    /selected\.forEach\([\s\S]*?saveGateLog\(gateId\(g\)/,
    "each slow gate persists its log"
  );
});

test("pre-flight runs tarball boot only after the package artifact builder completes", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(
    new URL("../../scripts/quality/validate-release-green.mjs", import.meta.url),
    "utf8"
  );
  const parallelWave = src.indexOf("const slowResults = await runSlowWave");
  const packBoot = src.indexOf('id: "pack-boot"');

  assert.ok(parallelWave >= 0, "the slow-gate wave must exist");
  assert.ok(
    packBoot > parallelWave,
    "pack-boot must be declared after the parallel artifact build"
  );
  assert.match(
    src,
    /packArtifactResult[\s\S]*?check:pack-boot/,
    "pack-boot must be explicitly sequenced from the package-artifact result"
  );
});

// ─── --full-ci gate extraction (P0, v3.8.46 post-mortem) ─────────────────────

const CI_FIXTURE = `
name: CI
jobs:
  lint:
    steps:
      - run: npm ci
      - run: npm run lint
      - run: npm run check:route-validation:t06
  quality-extended:
    steps:
      - name: Bundle size
        run: npm run check:bundle-size -- --ratchet
      - name: Build
        run: npm run build
  docs-sync-strict:
    steps:
      - run: |
          npm run check:docs-all
          npm run check:docs-symbols
  pr-test-policy:
    steps:
      - run: npm run check:test-masking
      - run: npm run check:pr-evidence
  quality-gate:
    steps:
      - run: npm run check:codeql-ratchet
  test-unit:
    steps:
      - run: npm run test:unit
`;

test("extractCiGates: pulls npm-run gate steps from the ci.yml gate jobs only", () => {
  const gates = extract(CI_FIXTURE);
  const ids = gates.map((g) => g.id);
  // gate scripts from the target jobs are present…
  assert.ok(ids.includes("lint"), "lint gate");
  assert.ok(ids.includes("check:route-validation:t06"), "colon-suffixed gate id survives");
  assert.ok(ids.includes("check:bundle-size"), "quality-extended gate");
  assert.ok(ids.includes("check:test-masking"), "pr-test-policy gate");
  // …a `run: |` multi-line block is scanned line-by-line…
  assert.ok(ids.includes("check:docs-all") && ids.includes("check:docs-symbols"), "multi-line run");
  // …and NON-gate steps + jobs outside the gate set are ignored.
  assert.ok(!ids.includes("build") && !ids.some((i) => i.startsWith("test:")), "no build/test-run");
  assert.equal(
    gates.find((g) => g.job === "test-unit"),
    undefined,
    "test-unit job is not scanned"
  );
});

test("extractCiGates: preserves `-- <args>` so ratchet flags reach the script", () => {
  const g = extract(CI_FIXTURE).find((x) => x.id === "check:bundle-size");
  assert.deepEqual(g?.args, ["run", "check:bundle-size", "--", "--ratchet"]);
  const plain = extract(CI_FIXTURE).find((x) => x.id === "lint");
  assert.deepEqual(plain?.args, ["run", "lint"], "no `--` when the step has no extra args");
});

test("extractCiGates: skips the non-local gates (pr-evidence, codeql-ratchet)", () => {
  const ids = extract(CI_FIXTURE).map((g) => g.id);
  assert.ok(!ids.includes("check:pr-evidence"), "pr-evidence needs a PR body — skipped");
  assert.ok(
    !ids.includes("check:codeql-ratchet"),
    "codeql-ratchet is a remote-main check — skipped"
  );
  assert.ok(FULL_CI_SKIP.has("check:pr-evidence") && FULL_CI_SKIP.has("check:codeql-ratchet"));
});

test("extractCiGates: attaches GITHUB_BASE_REF=main env to test-masking + de-dups", () => {
  const gates = extract(CI_FIXTURE + "\n  lint2:\n    steps:\n      - run: npm run lint\n", {
    jobs: [
      "lint",
      "lint2",
      "quality-extended",
      "docs-sync-strict",
      "pr-test-policy",
      "quality-gate",
    ],
  });
  const tm = gates.find((g) => g.id === "check:test-masking");
  assert.deepEqual(tm?.env, { GITHUB_BASE_REF: "main" }, "test-masking compares against main");
  // `lint` declared in two jobs appears once (dedup by script id).
  assert.equal(gates.filter((g) => g.id === "lint").length, 1, "de-duplicated across jobs");
});

test("extractCiGates: the REAL ci.yml yields the base-reds that leaked in v3.8.46", async () => {
  const fs = await import("node:fs");
  const yaml = fs.readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const ids = new Set(extract(yaml).map((g) => g.id));
  // The exact gates that leaked to the v3.8.46 release PR because the pre-flight
  // never ran them — --full-ci now reproduces every one.
  for (const g of [
    "check:route-validation:t06",
    // openapi-routes + docs-symbols collapsed into one FS walk (#6716).
    "check:api-docs-refs",
    "check:bundle-size",
    "check:test-masking",
    "check:file-size",
  ]) {
    assert.ok(ids.has(g), `real ci.yml must expose ${g} to --full-ci`);
  }
  assert.ok(ids.size >= 20, "the real gate set is substantial (>= 20 static gates)");
});

// ─── Verdict accuracy (review of the #9985 release-green verdict) ────────────

test("firstFailureLine never blames a PASSING line whose test FILE NAME contains 'fail' (#9985)", () => {
  // Observed in the 2026-08-23 verdict: the reported "cause" of the unit red was
  //   ✓ …fail-fast-concurrency-gate.test.ts (4 tests) 203ms
  // i.e. a GREEN line, matched only because the unanchored /FAIL/i marker hit the
  // substring "fail" inside the file name. The real ✖ line was three lines below.
  const out = [
    "> omniroute@3.8.50 test:unit",
    " ✓ tests/unit/runtime/fail-fast-concurrency-gate.test.ts (4 tests) 203ms",
    " ✓ tests/unit/router/failover-budget.test.ts (9 tests) 41ms",
    " ✖ tests/unit/router/pricing.test.ts > picks the cheapest candidate",
    "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 2 !== 3",
  ].join("\n");
  const hit = firstFailureLine(out);
  assert.doesNotMatch(hit, /fail-fast-concurrency-gate/, "a green line is never the failure cause");
  assert.doesNotMatch(hit, /failover-budget/, "a green line is never the failure cause");
  assert.match(hit, /pricing\.test\.ts/, "the real failing line must be reported instead");
});

test("firstFailureLine still recognises every legitimate failure marker", () => {
  const cases: [string, RegExp][] = [
    ["ok 1 - warms up\nnot ok 2 - routes to the cheapest key\n", /not ok 2/],
    ["Test Files 1 failed\nFAIL tests/unit/router/pricing.test.ts\n", /^FAIL /],
    ["src/x.ts(10,5): error TS2322: Type 'string' is not assignable.", /error TS2322/],
    ["✗ db-rules: raw sqlite handle left open", /db-rules/],
    ["Error: ENOENT: no such file or directory, open 'dist/server.js'", /ENOENT/],
    ["[cognitive-complexity] REGRESSÃO — 801 violações > baseline 797", /REGRESS/],
    ["[file-size] REGRESSED: open-sse/router.ts 1204 > cap 1100", /REGRESSED/],
  ];
  for (const [out, expected] of cases) {
    assert.match(firstFailureLine(out), expected, `marker lost for: ${out.slice(0, 40)}`);
  }
});

test("firstFailureLine falls back to the last line when nothing matches", () => {
  assert.equal(firstFailureLine("warming up\nall quiet\n"), "all quiet");
  assert.equal(firstFailureLine(""), "failed");
});

test("curatedEquivalentId maps a ci.yml gate script onto the curated pass id (#9985)", () => {
  assert.equal(curatedEquivalentId("check:file-size"), "file-size");
  assert.equal(curatedEquivalentId("check:compression-budget"), "compression-budget");
  // Curated ids that are NOT just the script name minus "check:".
  assert.equal(curatedEquivalentId("check:workflows"), "workflow-lint");
  assert.equal(curatedEquivalentId("check:complexity-ratchets"), "complexity");
  assert.equal(curatedEquivalentId("lint"), "lint-errors");
  // An uncurated gate keeps a stable, non-colliding identity.
  assert.equal(curatedEquivalentId("check:route-validation:t06"), "route-validation:t06");
});

test("fullCiKindFor honours the curated classification of an already-known gate (#9985)", () => {
  const curated = [
    { id: "file-size", kind: "drift", ok: false },
    { id: "compression-budget", kind: "drift", ok: false },
    { id: "workflow-lint", kind: "drift", ok: false },
    { id: "docs-all", kind: "hard", ok: true },
    { id: "lint-errors", kind: "hard", ok: true },
  ];
  // Ratchets curated as DRIFT must stay drift when --full-ci re-runs them from ci.yml...
  assert.equal(fullCiKindFor("check:file-size", curated), "drift");
  assert.equal(fullCiKindFor("check:compression-budget", curated), "drift");
  assert.equal(fullCiKindFor("check:workflows", curated), "drift");
  // ...real-defect gates stay hard...
  assert.equal(fullCiKindFor("check:docs-all", curated), "hard");
  assert.equal(fullCiKindFor("lint", curated), "hard");
  // ...and a gate the curated pass never ran defaults to hard (the --full-ci contract).
  assert.equal(fullCiKindFor("check:bundle-size", curated), "hard");
  assert.equal(fullCiKindFor("check:route-validation:t06", curated), "hard");
});

test("one gate can never land in BOTH verdict buckets of the same report (#9985)", () => {
  // The 2026-08-23 verdict listed file-size and compression-budget as hard failures
  // AND as drift, in the same table, because the --full-ci pass re-recorded every
  // ci.yml gate as kind:"hard" and the dedupe only compared raw ids.
  const curated = [
    { id: "file-size", kind: "drift", ok: false },
    { id: "compression-budget", kind: "drift", ok: false },
  ];
  const fromCiYaml = ["check:file-size", "check:compression-budget"].map((id) => ({
    id,
    kind: fullCiKindFor(id, curated),
    ok: false,
  }));
  const v = computeVerdict([...curated, ...fromCiYaml]);
  const hardGates = new Set(v.hardFailures.map((r) => curatedEquivalentId(r.id)));
  const contradictions = v.drift
    .map((r) => curatedEquivalentId(r.id))
    .filter((id) => hardGates.has(id));
  assert.deepEqual(
    contradictions,
    [],
    "a gate reported as hard must not also be reported as drift"
  );
  assert.equal(
    v.releaseGreen,
    true,
    "a curated-drift ratchet must not block the release via the --full-ci path"
  );
});

test("the --full-ci loop classifies from the curated results, not a hardcoded kind (#9985)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(
    new URL("../../scripts/quality/validate-release-green.mjs", import.meta.url),
    "utf8"
  );
  assert.match(
    src,
    /kind:\s*fullCiKindFor\(g\.id,\s*results\)/,
    "--full-ci must classify each ci.yml gate through fullCiKindFor()"
  );
});

// ---- Slow-suite wave: serial mode for GitHub-hosted runners ------------------------------
//
// The nightly full sweep ran unit + vitest + integration + pack-artifact concurrently. On a
// 16 GB hosted runner that exhausted memory and the runner was shut down mid-run (exit 143)
// on every scheduled run. `--serial-slow` must never let two suites overlap.

function trackedRunner(delayMs: number) {
  let active = 0;
  let maxActive = 0;
  const started: string[] = [];
  const runGate = async (g: { id: string }) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    started.push(g.id);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    active -= 1;
    return { id: g.id, code: 0 };
  };
  return { runGate, stats: () => ({ maxActive, started }) };
}

const WAVE = [{ id: "unit" }, { id: "vitest" }, { id: "integration" }, { id: "pack-artifact" }];

test("runSlowWave serial mode never runs two suites at once and keeps gate order", async () => {
  const { runGate, stats } = trackedRunner(5);
  const results = await runSlowWave(WAVE, runGate, { serial: true });
  assert.equal(stats().maxActive, 1);
  assert.deepEqual(stats().started, ["unit", "vitest", "integration", "pack-artifact"]);
  assert.deepEqual(
    results.map((r: { id: string }) => r.id),
    ["unit", "vitest", "integration", "pack-artifact"]
  );
});

test("runSlowWave defaults to the concurrent wave", async () => {
  const { runGate, stats } = trackedRunner(5);
  const results = await runSlowWave(WAVE, runGate);
  assert.equal(stats().maxActive, WAVE.length);
  assert.deepEqual(
    results.map((r: { id: string }) => r.id),
    ["unit", "vitest", "integration", "pack-artifact"]
  );
});

test("runSlowWave serial mode still runs every gate after a failing one", async () => {
  const seen: string[] = [];
  const results = await runSlowWave(
    WAVE,
    async (g: { id: string }) => {
      seen.push(g.id);
      return { id: g.id, code: g.id === "vitest" ? 1 : 0 };
    },
    { serial: true }
  );
  assert.deepEqual(seen, ["unit", "vitest", "integration", "pack-artifact"]);
  assert.deepEqual(
    results.map((r: { code: number }) => r.code),
    [0, 1, 0, 0]
  );
});

// ─── Sharding the sweep across CI jobs (#9533) ──────────────────────────────
//
// A GitHub-hosted runner stops at ~60 minutes and the slow suites sum to ~155 serial,
// so the sweep runs as several jobs and the aggregator merges their reports. The whole
// risk of that shape is a job reporting green while measuring nothing, which is why a
// typo'd suite name throws and a missing report is a HARD failure rather than silence.

const slowGates = parseSlowGates as (argv: string[]) => Set<string> | null;
const shardOf = parseShard as (
  argv: string[]
) => { index: number; total: number; spec: string } | null;
const merge = mergeSlowReports as (
  reports: { name: string; json: unknown }[],
  expected: string[]
) => { id: string; kind: string; ok: boolean; detail: string }[];

test("flagValue reads --name=value and returns null when the flag is absent", () => {
  assert.equal(flagValue(["--json", "--shard=2/4"], "shard"), "2/4");
  assert.equal(flagValue(["--json"], "shard"), null);
  // An empty value is a value, not an absence — the caller decides what to do with it.
  assert.equal(flagValue(["--slow-gates="], "slow-gates"), "");
});

test("parseSlowGates: absent means the whole wave, 'none' means no suites", () => {
  assert.equal(slowGates(["--json"]), null);
  assert.deepEqual([...(slowGates(["--slow-gates=none"]) as Set<string>)], []);
});

test("parseSlowGates selects the named suites", () => {
  assert.deepEqual(
    [...(slowGates(["--slow-gates=vitest,integration"]) as Set<string>)],
    ["vitest", "integration"]
  );
  // whitespace around the commas is a human typing a matrix entry, not an error
  assert.deepEqual(
    [...(slowGates(["--slow-gates= unit , vitest "]) as Set<string>)],
    ["unit", "vitest"]
  );
});

test("parseSlowGates THROWS on an unknown suite instead of selecting nothing", () => {
  // The failure this guards: `--slow-gates=unit-tests` silently matching no suite, the
  // job running zero tests, and the aggregate reporting release-green on an unmeasured
  // branch. Every id in the workflow matrix must exist or the run must not start.
  assert.throws(() => slowGates(["--slow-gates=unit-tests"]), /unknown suite 'unit-tests'/);
  assert.throws(() => slowGates(["--slow-gates=unit,typo"]), /unknown suite 'typo'/);
  assert.throws(() => slowGates(["--slow-gates="]), /empty list/);
});

test("SLOW_GATE_IDS does not offer pack-boot — it follows pack-artifact", () => {
  assert.deepEqual(SLOW_GATE_IDS, ["unit", "vitest", "integration", "pack-artifact"]);
});

test("parseShard reads i/N and rejects out-of-range or malformed specs", () => {
  assert.deepEqual(shardOf(["--shard=2/4"]), { index: 2, total: 4, spec: "2/4" });
  assert.equal(shardOf(["--json"]), null);
  assert.throws(() => shardOf(["--shard=2"]), /expected <index>\/<total>/);
  assert.throws(() => shardOf(["--shard=0/4"]), /out of range/);
  assert.throws(() => shardOf(["--shard=5/4"]), /out of range/);
});

test("mergeSlowReports folds every shard's checks into one list", () => {
  const merged = merge(
    [
      {
        name: "unit-1.json",
        json: { checks: [{ id: "unit#1/2", kind: "hard", ok: true, detail: "pass" }] },
      },
      {
        name: "unit-2.json",
        json: { checks: [{ id: "unit#2/2", kind: "hard", ok: true, detail: "pass" }] },
      },
    ],
    ["unit"]
  );
  assert.deepEqual(
    merged.map((c) => c.id),
    ["unit#1/2", "unit#2/2"]
  );
  assert.ok(merged.every((c) => c.ok));
});

test("mergeSlowReports keeps a shard's red red", () => {
  const merged = merge(
    [
      {
        name: "i.json",
        json: { checks: [{ id: "integration", kind: "hard", ok: false, detail: "3 failing" }] },
      },
    ],
    ["integration"]
  );
  assert.equal(merged[0].ok, false);
  assert.equal(merged[0].detail, "3 failing");
});

test("a suite with NO report is a HARD failure, not an absence of failures", () => {
  // The core invariant. A cancelled shard, a matrix that produced no job, or an upload
  // that silently dropped its artifact must not let the aggregate read as green.
  const merged = merge(
    [
      {
        name: "unit.json",
        json: { checks: [{ id: "unit", kind: "hard", ok: true, detail: "pass" }] },
      },
    ],
    ["unit", "integration"]
  );
  const missing = merged.find((c) => c.id === "slow-missing:integration");
  assert.ok(missing, "expected a check standing in for the suite that never reported");
  assert.equal(missing?.kind, "hard");
  assert.equal(missing?.ok, false);
  assert.match(missing?.detail ?? "", /did not run/);
});

test("a report that is not a valid gate report is a HARD failure", () => {
  const merged = merge(
    [{ name: "truncated.json", json: { parseError: "Unexpected end of JSON" } }],
    []
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].kind, "hard");
  assert.equal(merged[0].ok, false);
  assert.match(merged[0].detail, /no `checks` array/);
});

test("merged drift stays drift so a shard's ratchet never flips the exit code", () => {
  const merged = merge(
    [
      {
        name: "u.json",
        json: { checks: [{ id: "type-coverage", kind: "drift", ok: false, detail: "-0.2%" }] },
      },
    ],
    []
  );
  assert.equal(merged[0].kind, "drift");
  const { releaseGreen } = computeVerdict(merged) as { releaseGreen: boolean };
  assert.equal(releaseGreen, true);
});

test("the aggregator expects EXACTLY the shard ids the matrix produces", async () => {
  // The merge is only as honest as this list. `--expect-slow` is what turns a shard that
  // produced no report into a HARD failure, so if the matrix and the list drift apart, a
  // whole suite can disappear from a "release-green" verdict. Derive the ids from the
  // matrix and compare — the workflow is the source of truth for both halves.
  const fs = await import("node:fs");
  const yaml = await import("yaml");
  const wf = yaml.parse(
    fs.readFileSync(
      new URL("../../.github/workflows/nightly-release-green.yml", import.meta.url),
      "utf8"
    )
  ) as {
    jobs: Record<
      string,
      {
        strategy?: { matrix?: { include?: { name: string; flags: string }[] } };
        steps?: { run?: string }[];
      }
    >;
  };

  const include = wf.jobs["slow-suite"]?.strategy?.matrix?.include ?? [];
  assert.ok(include.length > 0, "the slow-suite matrix must declare its shards");

  const fromMatrix = include.map((m) => {
    const suite = /--slow-gates=([\w-]+)/.exec(m.flags)?.[1];
    const shard = /--shard=(\d+\/\d+)/.exec(m.flags)?.[1];
    assert.ok(suite, `matrix entry ${m.name} must select a suite`);
    return shard ? `${suite}#${shard}` : (suite as string);
  });

  const aggregatorRun = (wf.jobs["release-green"]?.steps ?? [])
    .map((s) => s.run ?? "")
    .find((r) => r.includes("--expect-slow="));
  assert.ok(aggregatorRun, "the aggregator must pass --expect-slow");
  const fromExpect = [...aggregatorRun.matchAll(/EXPECT="(?:\$EXPECT,)?([^"]+)"/g)]
    .flatMap((m) => m[1].split(","))
    .map((s) => s.trim())
    .filter(Boolean);

  assert.deepEqual([...fromExpect].sort(), [...fromMatrix].sort());
});

test("every slow-suite shard stays under the runner's ~60-minute ceiling", async () => {
  // A shard budgeted at 60+ would be killed by the runner before its own timeout fires,
  // which is exactly the opaque exit 143 this split exists to eliminate.
  const fs = await import("node:fs");
  const yaml = await import("yaml");
  const wf = yaml.parse(
    fs.readFileSync(
      new URL("../../.github/workflows/nightly-release-green.yml", import.meta.url),
      "utf8"
    )
  ) as { jobs: Record<string, { "timeout-minutes"?: number }> };

  // main-green is included even though it is off by default and still carries the
  // suites in one job: if someone enables it, a stated timeout beats a silent 143.
  for (const job of ["slow-suite", "release-green", "main-green"]) {
    const budget = wf.jobs[job]?.["timeout-minutes"];
    assert.equal(typeof budget, "number", `${job} must declare a timeout`);
    assert.ok(
      (budget as number) < 60,
      `${job} is budgeted ${budget}min — the runner stops at ~60, so it would never report its own timeout`
    );
  }
});

// ─── A gate this environment cannot run is stated, never omitted ───────────

const unmeasured = parseUnmeasured as (
  argv: string[]
) => { id: string; label: string; kind: string; ok: boolean; detail: string }[];

test("an unmeasured gate is recorded as a HARD failure carrying its reason", () => {
  // Not a defect and not drift — unmeasured. The one thing it must never be is absent:
  // a sweep missing a required gate is not release-green and must not read as if it were.
  const [record] = unmeasured(["--unmeasured=pack-artifact:a full next build does not fit"]);
  assert.equal(record.id, "unmeasured:pack-artifact");
  assert.equal(record.kind, "hard");
  assert.equal(record.ok, false);
  assert.equal(record.detail, "a full next build does not fit");
  assert.match(record.label, /not measured here/);
});

test("an unmeasured gate makes the verdict NOT release-green", () => {
  const { releaseGreen } = computeVerdict(unmeasured(["--unmeasured=pack-artifact:reason"])) as {
    releaseGreen: boolean;
  };
  assert.equal(releaseGreen, false);
});

test("several may be stated, and a reason may contain colons", () => {
  // The remedy is the useful half of the message and it contains URLs and colons.
  const records = unmeasured([
    "--unmeasured=pack-artifact:does not fit; set USE_VPS_RUNNER=true: see build.yml",
    "--unmeasured=pack-boot:skipped with pack-artifact",
  ]);
  assert.equal(records.length, 2);
  assert.equal(records[0].detail, "does not fit; set USE_VPS_RUNNER=true: see build.yml");
  assert.equal(records[1].id, "unmeasured:pack-boot");
});

test("a malformed --unmeasured THROWS rather than recording nothing", () => {
  // Recording nothing would be the silent-omission failure this flag exists to prevent.
  assert.throws(() => unmeasured(["--unmeasured=pack-artifact"]), /expected <id>:<reason>/);
  assert.throws(() => unmeasured(["--unmeasured=:a reason with no id"]), /expected <id>:<reason>/);
  assert.throws(() => unmeasured(["--unmeasured=trailing:"]), /expected <id>:<reason>/);
});

test("absent, it records nothing at all", () => {
  assert.deepEqual(unmeasured(["--json", "--full-ci"]), []);
});

test("the sweep states pack-artifact as unmeasured on a hosted runner", async () => {
  // The workflow half of the same contract: if the hosted branch ever stops saying so,
  // the sweep would silently drop the artifact gate and still print a verdict.
  const fs = await import("node:fs");
  const wf = fs.readFileSync(
    new URL("../../.github/workflows/nightly-release-green.yml", import.meta.url),
    "utf8"
  );
  assert.match(wf, /--unmeasured=pack-artifact:/);
  assert.match(wf, /--unmeasured=pack-boot:/);
  assert.match(
    wf,
    /if \[ "\$\{USE_VPS_RUNNER:-\}" = "true" \]/,
    "the artifact gate must run when a runner that fits the build is selected"
  );
});
