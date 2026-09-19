#!/usr/bin/env node
// scripts/check/check-lockfile.mjs
// Gate de política de lockfile (CLAUDE.md — extensão Hard Rule #1).
//
// Objetivo: detectar supply-chain poisoning no package-lock.json antes que código
// malicioso entre no repo. Verifica:
//   --validate-https       → toda URL "resolved" deve usar HTTPS (bloqueia http://)
//   --validate-integrity   → todo pacote deve ter hash de integridade sha512
//   --allowed-hosts npm    → apenas registry.npmjs.org é host permitido
//   npm ls --workspaces    → entradas do lockfile satisfazem cada workspace
//
// Complementa check-deps (Fase 2 / allowlist de nomes): aquele garante que só
// nomes aprovados entram; este garante que os pacotes instalados vieram do registry
// legítimo com integridade verificável.
//
// Referência: PLANO-QUALITY-GATES-FASE7.md, Task 7.7.
// Tool: lockfile-lint v5 (node_modules/.bin/lockfile-lint).

import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();

/** Longest a lockfile-lint run may take before the gate calls it stuck rather than violating. */
const LOCKFILE_LINT_TIMEOUT_MS = 120_000;

/** Rewrites a native path with forward slashes, which every platform accepts and globs do not escape. */
export function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

/**
 * Returns the canonical lockfile-lint configuration used by this gate.
 * Exporting this object makes the policy auditable and unit-testable without
 * spawning a child process.
 *
 * @returns {{
 *   lockfilePath: string,
 *   type: string,
 *   validateHttps: boolean,
 *   validateIntegrity: boolean,
 *   allowedHosts: string[],
 * }}
 */
export function getLockfileLintConfig() {
  return {
    // lockfile-lint resolves --path as a glob, where a backslash is an escape character. An
    // absolute Windows path (C:\...\package-lock.json) therefore matches nothing and the tool
    // walks the tree looking for it instead of failing, so the gate hangs. Forward slashes are a
    // valid absolute path on Windows too, and are a no-op on POSIX.
    lockfilePath: toPosixPath(path.join(ROOT, "package-lock.json")),
    type: "npm",
    validateHttps: true,
    validateIntegrity: true,
    // Only the official npm registry is permitted.
    // registry.npmjs.org resolves to the "npm" shorthand in lockfile-lint.
    // If the project ever adopts a scoped/private registry, add its hostname here
    // and document the justification.
    allowedHosts: ["npm"],
  };
}

/**
 * Builds the argv array to pass to the lockfile-lint binary, derived from
 * the config returned by getLockfileLintConfig().
 *
 * @param {ReturnType<typeof getLockfileLintConfig>} cfg
 * @returns {string[]}
 */
export function buildLockfileLintArgs(cfg) {
  const args = ["--path", cfg.lockfilePath, "--type", cfg.type];
  if (cfg.validateHttps) args.push("--validate-https");
  if (cfg.validateIntegrity) args.push("--validate-integrity");
  if (cfg.allowedHosts.length) {
    args.push("--allowed-hosts", ...cfg.allowedHosts);
  }
  return args;
}

/**
 * Resolves how to invoke the lockfile-lint CLI.
 *
 * `node_modules/.bin/lockfile-lint` is an extensionless shell shim: on Windows `execFileSync`
 * cannot spawn it and raises ENOENT, which the gate used to report as "lockfile-lint found policy
 * violations" with empty output — pointing at supply-chain poisoning that does not exist. The
 * package's own JS entry point is run with the current Node binary instead, on every platform.
 *
 * @param {string} [root]
 * @returns {{ command: string | null, args: string[], entry: string | null }}
 */
export function getLockfileLintCommand(root = ROOT) {
  const unavailable = { command: null, args: [], entry: null };
  const packageDir = path.join(root, "node_modules", "lockfile-lint");
  const manifestPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(manifestPath)) return unavailable;

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return unavailable;
  }
  const declared =
    typeof manifest.bin === "string" ? manifest.bin : (manifest.bin?.["lockfile-lint"] ?? null);
  if (typeof declared !== "string" || declared.length === 0) return unavailable;

  const entry = path.join(packageDir, declared);
  if (!fs.existsSync(entry)) return unavailable;
  return { command: process.execPath, args: [entry], entry };
}

/**
 * Runs lockfile-lint against `cfg`.
 *
 * `kind` separates the two failures the gate used to merge into one message:
 *   - "violation"     — lockfile-lint ran and rejected the lockfile (a real policy finding)
 *   - "not-runnable"  — the runner itself never started (ENOENT, or the package is missing),
 *                       which says nothing at all about the lockfile
 *
 * @param {ReturnType<typeof getLockfileLintConfig>} cfg
 * @param {{ execFile?: typeof execFileSync, command?: ReturnType<typeof getLockfileLintCommand> }} [options]
 * @returns {{ ok: boolean, kind: "ok" | "violation" | "not-runnable", stdout: string, stderr: string, detail: string }}
 */
export function runLockfileLint(cfg, options = {}) {
  const { execFile = execFileSync, command = getLockfileLintCommand() } = options;
  if (command.command === null) {
    return {
      ok: false,
      kind: "not-runnable",
      stdout: "",
      stderr: "",
      detail: `lockfile-lint entry point not found under ${path.join(ROOT, "node_modules", "lockfile-lint")}`,
    };
  }

  try {
    const stdout = execFile(command.command, [...command.args, ...buildLockfileLintArgs(cfg)], {
      encoding: "utf8",
      timeout: LOCKFILE_LINT_TIMEOUT_MS,
    });
    return { ok: true, kind: "ok", stdout: stdout ?? "", stderr: "", detail: "" };
  } catch (err) {
    if (err.code === "ENOENT") {
      return {
        ok: false,
        kind: "not-runnable",
        stdout: "",
        stderr: "",
        detail: `could not spawn ${command.command} ${command.args.join(" ")}`,
      };
    }
    if (err.code === "ETIMEDOUT") {
      return {
        ok: false,
        kind: "not-runnable",
        stdout: "",
        stderr: "",
        detail: `lockfile-lint did not finish within ${LOCKFILE_LINT_TIMEOUT_MS}ms`,
      };
    }
    return {
      ok: false,
      kind: "violation",
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      detail: "",
    };
  }
}

/**
 * Returns the cross-platform npm command that verifies direct workspace
 * dependencies from package-lock.json, independent of the installed tree.
 *
 * @param {NodeJS.Platform} [platform]
 * @param {string | undefined} [comSpec]
 * @returns {{ command: string, args: string[] }}
 */
export function getWorkspaceDependencyCheckCommand(
  platform = process.platform,
  comSpec = process.env.ComSpec
) {
  const npmArgs = ["ls", "--workspaces", "--depth=0", "--package-lock-only"];
  if (platform === "win32") {
    return {
      command: comSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", ...npmArgs],
    };
  }

  return {
    command: "npm",
    args: npmArgs,
  };
}

/**
 * Executes the workspace dependency consistency check while keeping the process
 * boundary injectable for deterministic success and failure tests.
 *
 * @param {{
 *   platform?: NodeJS.Platform,
 *   comSpec?: string,
 *   execFile?: typeof execFileSync,
 * }} [options]
 * @returns {{ ok: true } | { ok: false, stdout: string, stderr: string }}
 */
export function runWorkspaceDependencyCheck(options = {}) {
  const {
    platform = process.platform,
    comSpec = process.env.ComSpec,
    execFile = execFileSync,
  } = options;
  const workspaceCheck = getWorkspaceDependencyCheckCommand(platform, comSpec);

  try {
    execFile(workspaceCheck.command, workspaceCheck.args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

function main() {
  const cfg = getLockfileLintConfig();

  if (!fs.existsSync(cfg.lockfilePath)) {
    console.error(
      `[check-lockfile] FAIL — lockfile not found: ${cfg.lockfilePath}\n` +
        "  → Run `npm install` to generate package-lock.json"
    );
    process.exit(1);
  }

  const result = runLockfileLint(cfg);

  if (result.kind === "not-runnable") {
    console.error(
      "[check-lockfile] FAIL — lockfile-lint could not be started, so the lockfile was NOT checked.\n" +
        `  ${result.detail}\n` +
        "  This is a runner problem, not a lockfile policy violation.\n" +
        "  → Run `npm install` to install dev dependencies"
    );
    process.exit(1);
  }

  if (result.kind === "violation") {
    console.error("[check-lockfile] FAIL — lockfile-lint found policy violations:");
    if (result.stdout) console.error(result.stdout);
    if (result.stderr) console.error(result.stderr);
    console.error(
      "\n  Possible causes:\n" +
        "  • A package was resolved from a non-HTTPS URL (http:// poisoning attempt)\n" +
        "  • A package is missing its integrity hash (tampered or legacy entry)\n" +
        "  • A package was resolved from a host other than registry.npmjs.org\n" +
        "    If a scoped/private registry is intentionally used, add its hostname\n" +
        "    to getLockfileLintConfig().allowedHosts in scripts/check/check-lockfile.mjs"
    );
    process.exit(1);
  }

  // lockfile-lint outputs a green ✔ message on success
  console.log("[check-lockfile] OK —", result.stdout.trim());

  const workspaceResult = runWorkspaceDependencyCheck();
  if (workspaceResult.ok) {
    console.log("[check-lockfile] OK — workspace lock entries match their manifests");
  } else {
    console.error("[check-lockfile] FAIL — workspace lock entries are inconsistent:");
    if (workspaceResult.stdout) console.error(workspaceResult.stdout);
    if (workspaceResult.stderr) console.error(workspaceResult.stderr);
    console.error("\n  → Regenerate the affected lock entries and verify with a clean `npm ci`");
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
