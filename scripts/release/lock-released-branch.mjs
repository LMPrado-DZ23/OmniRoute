#!/usr/bin/env node
/**
 * Lock a released branch, by hand, with confirmation.
 *
 * `lock-released-branch.yml` is supposed to do this automatically when a Release is
 * published, but it needs a `BRANCH_LOCK_TOKEN` secret: `GITHUB_TOKEN` cannot be granted
 * the `Administration` scope, and only a PAT or fine-grained token can hold it. Until
 * that secret exists the workflow fails on every release and NO release branch is locked
 * — v3.8.54 shipped with its branch still writable.
 *
 * So this is the fallback, and it exists as a script rather than a line in a runbook for
 * one reason: the failure that Hard Rule #18 was written for was a SILENT one. In the
 * v3.8.3 incident six commits landed on an already-shipped version because nobody checked
 * that the lock had actually applied. A raw `gh api` call that half-works looks exactly
 * like one that worked.
 *
 * This script therefore always re-reads the protection afterwards and exits non-zero if
 * the lock is not confirmed. A green exit here means the branch is genuinely read-only.
 *
 * Usage:
 *   node scripts/release/lock-released-branch.mjs 3.8.54
 *   node scripts/release/lock-released-branch.mjs v3.8.54 --repo owner/name
 *   node scripts/release/lock-released-branch.mjs 3.8.54 --check     # verify only
 *   node scripts/release/lock-released-branch.mjs 3.8.54 --unlock    # reopen the branch
 *
 * Requires the `gh` CLI, authenticated as someone with admin on the repository.
 */
import { execFileSync } from "node:child_process";

const DEFAULT_REPO = "LMPrado-DZ23/OmniRoute";

/** The protection payload, identical to the one lock-released-branch.yml applies. */
export const PROTECTION = {
  required_status_checks: null,
  enforce_admins: true,
  required_pull_request_reviews: null,
  restrictions: null,
  lock_branch: true,
  allow_force_pushes: false,
  allow_deletions: false,
};

/** `3.8.54`, `v3.8.54` and `release/v3.8.54` all mean the same branch. */
export function branchForVersion(version) {
  const trimmed = String(version ?? "").trim();
  if (!trimmed) throw new Error("no version given");
  const bare = trimmed.replace(/^release\//, "").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+([.-][A-Za-z0-9.-]+)?$/.test(bare)) {
    throw new Error(`not a version: ${trimmed}`);
  }
  return `release/v${bare}`;
}

/** GitHub wants the slash in a branch name percent-encoded inside the path. */
export function protectionPath(repo, branch) {
  return `repos/${repo}/branches/${encodeURIComponent(branch)}/protection`;
}

function gh(args, { input } = {}) {
  return execFileSync("gh", args, {
    encoding: "utf-8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** True only when GitHub itself reports the branch as locked. */
export function readLockState(repo, branch, run = gh) {
  const out = run([
    "api",
    protectionPath(repo, branch),
    "--jq",
    "{lock:.lock_branch.enabled, admins:.enforce_admins.enabled}",
  ]);
  return JSON.parse(out);
}

function main(argv) {
  const args = argv.slice(2);
  const version = args.find((a) => !a.startsWith("--"));
  const repoFlag = args.indexOf("--repo");
  const repo = repoFlag >= 0 ? args[repoFlag + 1] : DEFAULT_REPO;
  const checkOnly = args.includes("--check");
  const unlock = args.includes("--unlock");

  if (!version) {
    console.error(
      "usage: lock-released-branch.mjs <version> [--repo owner/name] [--check|--unlock]"
    );
    process.exit(2);
  }

  const branch = branchForVersion(version);
  const path = protectionPath(repo, branch);

  if (unlock) {
    gh(["api", "-X", "DELETE", path]);
    console.log(`🔓 ${branch} reopened. Re-lock it before the next release.`);
    return;
  }

  if (!checkOnly) {
    console.log(`Locking ${branch} in ${repo}…`);
    gh(["api", "-X", "PUT", path, "--input", "-"], { input: JSON.stringify(PROTECTION) });
  }

  // Never trust the PUT. The whole point of this script is the read-back.
  const state = readLockState(repo, branch);
  if (state.lock !== true || state.admins !== true) {
    console.error(
      `::error::${branch} is NOT locked (lock_branch=${state.lock}, enforce_admins=${state.admins}). ` +
        `Do not consider the release closed until this reports true/true.`
    );
    process.exit(1);
  }
  console.log(`✅ ${branch} is locked and enforced for admins.`);
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("lock-released-branch.mjs")
) {
  main(process.argv);
}
