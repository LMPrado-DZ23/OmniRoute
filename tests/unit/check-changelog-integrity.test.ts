// Guards the anti CHANGELOG-eat gate (scripts/check/check-changelog-integrity.mjs):
// a merge auto-resolve that drops sibling bullets must be detected by comparing
// the merge result against the base branch's CHANGELOG (incident 2026-07-05,
// PR #6193: 212 lines / 130 bullets eaten).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { extractBullets, findLostBullets } =
  await import("../../scripts/check/check-changelog-integrity.mjs");

const SCRIPT_PATH = fileURLToPath(
  new URL("../../scripts/check/check-changelog-integrity.mjs", import.meta.url)
);
const LEDGER_PATH = "config/release/changelog-reconciliations.json";

const BASE = `# Changelog

## [Unreleased]

### Bug Fixes

- **fix(a):** first bullet ([#1](https://x/1))
- **fix(b):** second bullet ([#2](https://x/2))

## [3.8.44] — TBD

- **feat(c):** shipped bullet ([#3](https://x/3))
`;

test("extractBullets collects trimmed bullet lines only", () => {
  const b = extractBullets(BASE);
  assert.equal(b.size, 3);
  assert.ok(b.has("- **fix(a):** first bullet ([#1](https://x/1))"));
});

test("no loss when head is a superset (normal additive merge)", () => {
  const head = BASE + "- **fix(d):** new bullet ([#4](https://x/4))\n";
  assert.deepEqual(findLostBullets(BASE, head), []);
});

test("detects an eaten sibling bullet", () => {
  const head = BASE.replace("- **fix(b):** second bullet ([#2](https://x/2))\n", "");
  const lost = findLostBullets(BASE, head);
  assert.deepEqual(lost, ["- **fix(b):** second bullet ([#2](https://x/2))"]);
});

test("detects a whole eaten version section (#6193 pattern)", () => {
  const head = BASE.split("## [3.8.44]")[0];
  const lost = findLostBullets(BASE, head);
  assert.deepEqual(lost, ["- **feat(c):** shipped bullet ([#3](https://x/3))"]);
});

test("detects one lost occurrence when an identical bullet still exists elsewhere", () => {
  const duplicate = "- **fix(repeated):** same rendered bullet ([#9](https://x/9))";
  const base = `${BASE}${duplicate}\n${duplicate}\n`;
  const head = `${BASE}${duplicate}\n`;

  assert.deepEqual(findLostBullets(base, head), [duplicate]);
});

test("bullets moved between sections are NOT reported (line content preserved)", () => {
  const head = BASE.replace("- **fix(a):** first bullet ([#1](https://x/1))\n", "").replace(
    "- **feat(c):** shipped bullet ([#3](https://x/3))",
    "- **feat(c):** shipped bullet ([#3](https://x/3))\n- **fix(a):** first bullet ([#1](https://x/1))"
  );
  assert.deepEqual(findLostBullets(BASE, head), []);
});

function makeCliRepo(baseText = BASE) {
  const root = mkdtempSync(join(tmpdir(), "changelog-integrity-cli-"));
  const script = join(root, "scripts/check/check-changelog-integrity.mjs");
  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(join(root, "changelog.d/features"), { recursive: true });
  mkdirSync(join(root, "changelog.d/fixes"), { recursive: true });
  mkdirSync(join(root, "changelog.d/maintenance"), { recursive: true });
  mkdirSync(join(root, "config/release"), { recursive: true });
  writeFileSync(script, readFileSync(SCRIPT_PATH, "utf8"));
  writeFileSync(join(root, "CHANGELOG.md"), baseText);
  writeLedger(root, []);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Changelog Integrity Test",
      "-c",
      "user.email=changelog-integrity@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "base",
    ],
    { cwd: root }
  );
  const baseRef = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  return { root, baseRef };
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function writeLedger(root, reconciliations) {
  writeFileSync(
    join(root, LEDGER_PATH),
    `${JSON.stringify({ schemaVersion: 1, reconciliations }, null, 2)}\n`
  );
}

function runCli(root, baseRef, extraEnv = {}) {
  return spawnSync(process.execPath, ["scripts/check/check-changelog-integrity.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CHANGELOG_BASE_REF: baseRef, ...extraEnv },
  });
}

test("CLI rejects an unledgered loss", () => {
  const { root, baseRef } = makeCliRepo();
  try {
    writeFileSync(
      join(root, "CHANGELOG.md"),
      BASE.replace("- **fix(b):** second bullet ([#2](https://x/2))\n", "")
    );

    const result = runCli(root, baseRef);

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /1 bullet\(s\).*MISSING/s);
    assert.doesNotMatch(result.stderr, /reporting only, not failing/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI fails closed when the removed legacy bypass is still configured", () => {
  const { root, baseRef } = makeCliRepo();
  try {
    const result = runCli(root, baseRef, { ALLOW_CHANGELOG_REMOVALS: "1" });

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /ALLOW_CHANGELOG_REMOVALS.*removed/);
    assert.match(result.stderr, /changelog-reconciliations\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI accepts only an exact, reviewable ledgered reconciliation", () => {
  const { root, baseRef } = makeCliRepo();
  try {
    const removed = "- **fix(b):** second bullet ([#2](https://x/2))";
    const added = "- **fix(b):** clarified replacement bullet ([#2](https://x/2))";
    const resultText = BASE.replace(removed, added);
    writeFileSync(join(root, "CHANGELOG.md"), resultText);
    writeLedger(root, [
      {
        id: "clarify-fix-b",
        reason: "Clarify the wording while preserving the original fix and pull request reference.",
        baseChangelogSha256: sha256(BASE),
        resultChangelogSha256: sha256(resultText),
        removedBullets: [removed],
        addedBullets: [added],
      },
    ]);

    const result = runCli(root, baseRef);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK.*ledgered reconciliation "clarify-fix-b"/s);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI keeps an additional loss RED after an approved result is tampered with", () => {
  const { root, baseRef } = makeCliRepo();
  try {
    const removed = "- **fix(b):** second bullet ([#2](https://x/2))";
    const added = "- **fix(b):** clarified replacement bullet ([#2](https://x/2))";
    const approvedResult = BASE.replace(removed, added);
    writeLedger(root, [
      {
        id: "clarify-fix-b",
        reason: "Clarify the wording while preserving the original fix and pull request reference.",
        baseChangelogSha256: sha256(BASE),
        resultChangelogSha256: sha256(approvedResult),
        removedBullets: [removed],
        addedBullets: [added],
      },
    ]);
    const tamperedResult = approvedResult.replace(
      "- **fix(a):** first bullet ([#1](https://x/1))\n",
      ""
    );
    writeFileSync(join(root, "CHANGELOG.md"), tamperedResult);

    const result = runCli(root, baseRef);

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /2 bullet\(s\).*MISSING/s);
    assert.doesNotMatch(result.stdout, /ledgered reconciliation/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI rejects exact file hashes when the ledger omits one removed occurrence", () => {
  const { root, baseRef } = makeCliRepo();
  try {
    const removedA = "- **fix(a):** first bullet ([#1](https://x/1))";
    const removedB = "- **fix(b):** second bullet ([#2](https://x/2))";
    const added = "- **fix(ab):** consolidated replacement ([#2](https://x/2))";
    const resultText = BASE.replace(`${removedA}\n${removedB}`, added);
    writeFileSync(join(root, "CHANGELOG.md"), resultText);
    writeLedger(root, [
      {
        id: "incomplete-removed-multiset",
        reason: "Deliberately incomplete fixture that must not authorize the full transition.",
        baseChangelogSha256: sha256(BASE),
        resultChangelogSha256: sha256(resultText),
        removedBullets: [removedB],
        addedBullets: [added],
      },
    ]);

    const result = runCli(root, baseRef);

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /2 bullet\(s\).*MISSING/s);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI rejects exact file hashes when the ledger omits one removed duplicate", () => {
  const duplicate = "- **fix(repeated):** same rendered bullet ([#9](https://x/9))";
  const baseText = `${BASE}${duplicate}\n${duplicate}\n`;
  const { root, baseRef } = makeCliRepo(baseText);
  try {
    const added = "- **fix(repeated):** consolidated duplicate ([#9](https://x/9))";
    const resultText = `${BASE}${added}\n`;
    writeFileSync(join(root, "CHANGELOG.md"), resultText);
    writeLedger(root, [
      {
        id: "incomplete-duplicate-multiset",
        reason: "Deliberately omit one identical occurrence from the declared transition.",
        baseChangelogSha256: sha256(baseText),
        resultChangelogSha256: sha256(resultText),
        removedBullets: [duplicate],
        addedBullets: [added],
      },
    ]);

    const result = runCli(root, baseRef);

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /2 bullet\(s\).*MISSING/s);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI rejects exact bullet deltas when the ledger base hash is wrong", () => {
  const { root, baseRef } = makeCliRepo();
  try {
    const removed = "- **fix(b):** second bullet ([#2](https://x/2))";
    const added = "- **fix(b):** clarified replacement bullet ([#2](https://x/2))";
    const resultText = BASE.replace(removed, added);
    writeFileSync(join(root, "CHANGELOG.md"), resultText);
    writeLedger(root, [
      {
        id: "wrong-base-hash",
        reason: "Deliberately stale base digest that must not authorize this transition.",
        baseChangelogSha256: "0".repeat(64),
        resultChangelogSha256: sha256(resultText),
        removedBullets: [removed],
        addedBullets: [added],
      },
    ]);

    const result = runCli(root, baseRef);

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /1 bullet\(s\).*MISSING/s);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI validates a new fragment without treating it as a reconciliation", () => {
  const { root, baseRef } = makeCliRepo();
  try {
    writeFileSync(
      join(root, "changelog.d/fixes/11326-new-valid-fragment.md"),
      "- **fix(kie):** preserve a newly added valid fragment ([#11326](https://x/11326)).\n"
    );

    const result = runCli(root, baseRef);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK — no base bullets lost/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI fails closed on a malformed reconciliation ledger", () => {
  const { root, baseRef } = makeCliRepo();
  try {
    writeFileSync(join(root, LEDGER_PATH), '{"schemaVersion":1,"reconciliations":"all"}\n');

    const result = runCli(root, baseRef);

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /invalid reconciliation ledger/);
    assert.match(result.stderr, /reconciliations must be an array/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI fails closed when an explicit base ref is unreadable", () => {
  const { root } = makeCliRepo();
  try {
    const result = runCli(root, "missing-explicit-base");

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /FAIL.*CHANGELOG\.md.*missing-explicit-base/s);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ─── The digest must not depend on who checked the file out ────────────────

test("changelogSha256 is line-ending independent", async () => {
  // The two sides of a reconciliation arrive differently: the base comes from
  // `git show <ref>:CHANGELOG.md`, which is always the stored LF content, while the result
  // is read from the WORKING TREE — CRLF on a Windows checkout with core.autocrlf=true.
  // Hashing raw bytes made a record written on Windows verifiable only on Windows: it
  // passed locally and failed in CI with no hint as to why. Measured on the real record:
  // the same file hashed 774e2524… as CRLF and 66e20f2a… as LF.
  const { changelogSha256 } = await import("../../scripts/check/check-changelog-integrity.mjs");
  const lf = "## [1.0.0]\n\n- **fix:** a bullet\n- **feat:** another\n";
  const crlf = lf.replace(/\n/g, "\r\n");

  assert.equal(
    changelogSha256(crlf),
    changelogSha256(lf),
    "a CRLF checkout must produce the same digest as the LF content git stores"
  );
  // Still a real digest of the content, not a constant: different text, different hash.
  assert.notEqual(changelogSha256(lf), changelogSha256(lf.replace("a bullet", "a different")));
});

test("every ledgered reconciliation is well formed", async () => {
  // NOT "the newest record still matches CHANGELOG.md". I wrote that first and it was
  // wrong by construction: a reconciliation is a HISTORICAL statement — "at this commit,
  // base X became result Y" — so the very next legitimate edit to CHANGELOG.md diverges
  // from it. The release aggregation proved it within the hour, folding 378 fragments in
  // and failing a test that was asserting a thing that must not stay true.
  //
  // What IS invariant is the record's shape, and that the gate consults it by CONTENT:
  // findLedgeredReconciliation matches on both hashes, so a record simply stops applying
  // once the file moves on — which is correct, because the bullet it explains is no longer
  // missing relative to the advanced base.
  const ledger = JSON.parse(
    readFileSync(
      new URL("../../config/release/changelog-reconciliations.json", import.meta.url),
      "utf8"
    )
  ) as {
    schemaVersion: number;
    reconciliations: {
      id: string;
      reason: string;
      baseChangelogSha256: string;
      resultChangelogSha256: string;
      removedBullets: string[];
      addedBullets: string[];
    }[];
  };

  assert.equal(ledger.schemaVersion, 1);
  assert.ok(ledger.reconciliations.length > 0, "the ledger must not be empty");

  const seen = new Set<string>();
  for (const record of ledger.reconciliations) {
    assert.match(record.id, /^[a-z0-9-]+$/, `${record.id}: id must be a slug`);
    assert.ok(!seen.has(record.id), `${record.id}: duplicate id`);
    seen.add(record.id);

    for (const field of ["baseChangelogSha256", "resultChangelogSha256"] as const) {
      assert.match(record[field], /^[0-9a-f]{64}$/, `${record.id}.${field} must be sha256 hex`);
    }
    assert.notEqual(
      record.baseChangelogSha256,
      record.resultChangelogSha256,
      `${record.id}: a reconciliation that changed nothing explains nothing`
    );

    // The reason is the whole point of the ledger: it is what a reviewer reads instead of
    // taking a hash on faith. A one-word reason is not a reviewed record.
    assert.ok(
      record.reason.trim().length >= 40,
      `${record.id}: reason must actually explain the rewrite`
    );
    assert.ok(
      record.removedBullets.length > 0,
      `${record.id}: a reconciliation exists to explain REMOVED bullets`
    );
    for (const bullet of [...record.removedBullets, ...record.addedBullets]) {
      assert.match(bullet, /^- /, `${record.id}: bullets must be recorded verbatim`);
    }
  }
});
