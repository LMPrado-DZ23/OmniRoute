/**
 * Live tests must never run just because credentials happen to be exported.
 *
 * `npm run test:integration` and the PR integration job collect every `tests/integration/*.test.ts`
 * file. Several of those files send real traffic to a running OmniRoute (and, through it, to paid
 * providers) and used to decide whether to run only from `OMNIROUTE_API_KEY`. This inventory fails
 * if any file under tests/integration or tests/boundary (recursively) computes a skip from
 * credentials alone instead of going through tests/helpers/liveOptIn.ts, pins the known live files
 * to the helper, and pins the tests/integration/combo-live suites to their RUN_COMBO_LIVE gate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCANNED_DIRS = ["tests/integration", "tests/boundary"];

/** Every .ts file under `relDir`, recursively (B-10: live suites also live in subfolders). */
function listTsFiles(relDir: string): string[] {
  const abs = path.join(REPO_ROOT, relDir);
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) return listTsFiles(rel);
    return entry.isFile() && entry.name.endsWith(".ts") ? [rel] : [];
  });
}

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

// A skip decided from credentials alone, e.g. `!API_KEY ? "..." : undefined` or
// `!(process.env.OMNIROUTE_API_KEY && process.env.OMNIROUTE_URL) ? ...`.
const CREDENTIAL_ONLY_SKIP = [
  /\bskip\w*\s*=\s*!\s*API_KEY\s*\?/,
  /\bskip\w*\s*=\s*!\s*\(?\s*process\.env\.OMNIROUTE_API_KEY/,
];

test("no live test under tests/integration or tests/boundary skips on credentials alone", () => {
  const offenders: string[] = [];
  for (const dir of SCANNED_DIRS) {
    for (const rel of listTsFiles(dir)) {
      const source = read(rel);
      if (CREDENTIAL_ONLY_SKIP.some((pattern) => pattern.test(source))) offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "compute the skip with liveSkipReason() from tests/helpers/liveOptIn.ts"
  );
});

// Files that define their own live skip, and the flag each must require.
const LIVE_SKIP_OWNERS: Record<string, string | null> = {
  "tests/integration/live-gemini.test.ts": null,
  "tests/integration/gemini-live-429-classification.test.ts": null,
  "tests/integration/active-request-completion.test.ts": null,
  "tests/integration/historical-tool-call-leak.test.ts": null,
  "tests/integration/liveGeminiShared.ts": null,
  "tests/integration/liveDefaultComboShared.ts": null,
  "tests/boundary/gemini-double-escaping.live.test.ts": "RUN_BOUNDARY_LIVE",
  "tests/boundary/gemini-midstream-503-e2e.live.test.ts": "RUN_BOUNDARY_LIVE",
};

test("every known live skip goes through liveSkipReason with the right flag", () => {
  for (const [rel, flag] of Object.entries(LIVE_SKIP_OWNERS)) {
    const source = read(rel);
    assert.match(source, /from "\.\.\/helpers\/liveOptIn\.ts"/, `${rel} must import the helper`);
    assert.match(source, /liveSkipReason\(/, `${rel} must call liveSkipReason()`);
    if (flag)
      assert.match(source, new RegExp(`flag:\\s*"${flag}"`), `${rel} must require ${flag}=1`);
    else
      assert.doesNotMatch(source, /flag:\s*"/, `${rel} must use the default RUN_LIVE_TESTS flag`);
  }
});

test("tests that import a shared live skip get it from a helper that uses liveSkipReason", () => {
  const sharedHelpers = ["./liveGeminiShared.ts", "./liveDefaultComboShared.ts"];
  for (const rel of listTsFiles("tests/integration")) {
    const source = read(rel);
    const importsSharedSkip = sharedHelpers.some((helper) =>
      new RegExp(`\\bskip\\b[\\s\\S]*?from "${helper.replace(/\./g, "\\.")}"`).test(source)
    );
    if (!importsSharedSkip) continue;
    for (const helper of sharedHelpers) {
      if (!source.includes(`from "${helper}"`)) continue;
      const helperSource = read(`tests/integration/${helper.slice(2)}`);
      assert.match(
        helperSource,
        /liveSkipReason\(/,
        `${helper} (imported by ${rel}) must use liveSkipReason()`
      );
    }
  }
});

test("the recursive scan reaches the nested live suites", () => {
  const files = listTsFiles("tests/integration");
  assert.ok(files.includes("tests/integration/combo-live/_liveHarness.ts"));
  assert.ok(files.includes("tests/integration/combo-live/ordered.live.test.ts"));
});

// tests/integration/combo-live drives real providers through a running OmniRoute. Its own gate is
// RUN_COMBO_LIVE=1 (npm run test:combo:live), set in _liveHarness.ts; every top-level test must
// carry that skip so a plain `node --test` over the folder never sends traffic.
test("every combo-live suite is gated by RUN_COMBO_LIVE", () => {
  const harness = read("tests/integration/combo-live/_liveHarness.ts");
  assert.match(harness, /export const LIVE_ENABLED = process\.env\.RUN_COMBO_LIVE === "1";/);

  const suites = listTsFiles("tests/integration/combo-live").filter((f) =>
    f.endsWith(".live.test.ts")
  );
  assert.ok(suites.length > 0, "combo-live suites found");
  for (const rel of suites) {
    const source = read(rel);
    assert.match(source, /from "\.\/_liveHarness\.ts"/, `${rel} must use the live harness`);
    const topLevel = source.match(/^(?:test|describe|it)\(/gm) ?? [];
    const gated = source.match(/skip: !h\.LIVE_ENABLED && "RUN_COMBO_LIVE!=1"/g) ?? [];
    assert.ok(topLevel.length > 0, `${rel} has top-level tests`);
    assert.equal(gated.length, topLevel.length, `${rel}: every top-level test needs the gate`);
  }
});
