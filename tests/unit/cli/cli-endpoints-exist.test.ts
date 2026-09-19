import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { routeExportsMethod } from "../../../scripts/check/check-fetch-targets.mjs";
import { ROOT, matchRoute, relativeToRoot as rel, toApiPathname } from "./_helpers/appRoutes.ts";

// Class of bug guarded here: a CLI command calling a route (or a verb on a
// route) that the server does not implement. Such a call can only ever fail
// with the /api catch-all's 404 or with a 405. `omniroute policy` shipped
// eight subcommands against a policy CRUD API that never existed.
//
// Every `apiFetch("<literal path>", { method: "<literal>" })` in
// bin/cli/commands/** and every generated command in bin/cli/api-commands/*
// is resolved against the real App Router tree (src/app/api/**/route.ts,
// honouring [param], [...catchAll] and [[...optional]] segments and the
// /v1 → /api/v1 rewrite in next.config.mjs) and must hit a route file that
// exports that HTTP method. Calls whose path or method is computed at runtime
// are out of reach of a static scan and are skipped.
//
// KNOWN_BROKEN freezes the mismatches that pre-date this test (2026-09-19).
// Entries may only be REMOVED: fixing a command without deleting its entry
// fails as stale, and a new mismatch fails outright.

const KNOWN_BROKEN = new Set([
  "bin/cli/commands/context-eng.mjs::DELETE /api/context/rtk/filters/{}",
  "bin/cli/commands/context-eng.mjs::POST /api/context/rtk/filters",
  "bin/cli/commands/eval.mjs::GET /api/evals/suites",
  "bin/cli/commands/eval.mjs::POST /api/evals/{}",
  "bin/cli/commands/keys.mjs::DELETE /api/v1/providers/keys/{}",
  "bin/cli/commands/keys.mjs::GET /api/v1/providers/keys",
  "bin/cli/commands/keys.mjs::GET /api/v1/registered-keys/{}/policy",
  "bin/cli/commands/keys.mjs::GET /api/v1/registered-keys/{}/reveal",
  "bin/cli/commands/keys.mjs::GET /api/v1/registered-keys/{}/usage",
  "bin/cli/commands/keys.mjs::PATCH /api/v1/registered-keys/{}/policy",
  "bin/cli/commands/keys.mjs::POST /api/v1/providers/keys",
  "bin/cli/commands/keys.mjs::POST /api/v1/registered-keys/{}/regenerate",
  "bin/cli/commands/keys.mjs::POST /api/v1/registered-keys/{}/rotate",
  "bin/cli/commands/mcp.mjs::POST /api/mcp/restart",
  "bin/cli/commands/memory.mjs::DELETE /api/memory",
  "bin/cli/commands/nodes.mjs::GET /api/provider-nodes/{}",
  "bin/cli/commands/oauth.mjs::POST /api/providers/{}/auth/apply",
  "bin/cli/commands/oauth.mjs::POST /api/providers/{}/auth/start",
  "bin/cli/commands/oneproxy.mjs::PUT /api/settings/oneproxy",
  "bin/cli/commands/pricing.mjs::PUT /api/pricing/defaults",
  "bin/cli/commands/quota.mjs::GET /api/quota",
  "bin/cli/commands/quota.mjs::GET /api/v1/providers",
  "bin/cli/commands/sessions.mjs::DELETE /api/sessions",
  "bin/cli/commands/skills.mjs::GET /api/skills/{}",
  "bin/cli/commands/sync.mjs::POST /api/db-backups/exportAll",
  "bin/cli/commands/tags.mjs::DELETE /api/tags",
  "bin/cli/commands/tags.mjs::POST /api/tags",
  "bin/cli/commands/tunnel.mjs::DELETE /api/tunnels/{}",
  "bin/cli/commands/tunnel.mjs::GET /api/tunnels",
  "bin/cli/commands/tunnel.mjs::GET /api/tunnels/{}",
  "bin/cli/commands/tunnel.mjs::GET /api/tunnels/{}/logs",
  "bin/cli/commands/tunnel.mjs::GET /api/tunnels/{}/status",
  "bin/cli/commands/tunnel.mjs::POST /api/tunnels",
  "bin/cli/commands/tunnel.mjs::POST /api/tunnels/{}/rotate",
  "bin/cli/commands/usage.mjs::DELETE /api/usage/budget",
]);

type Call = { file: string; method: string; apiPath: string };

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

/** Most specific route file for a concrete path (see _helpers/appRoutes.ts). */
function resolveRouteFile(apiPath: string): string | null {
  return matchRoute(apiPath)?.file ?? null;
}

/** Normalises a CLI literal path: `${x}`/{x} → placeholder, drops the query, maps /v1 → /api/v1. */
function normalisePath(raw: string): string | null {
  const noQuery = raw.replace(/[?#].*$/, "");
  const concrete = noQuery.replace(/\$\{[^}]*\}/g, "{}").replace(/\{[^}]+\}/g, "{}");
  return toApiPathname(concrete);
}

function callArgs(src: string, from: number): string {
  let depth = 1;
  let quote: string | null = null;
  let i = from;
  for (; i < src.length && depth > 0; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
  }
  return src.slice(from, i - 1);
}

/** Hand-written commands: apiFetch("<literal>", { method: "<literal>" }). */
function handWrittenCalls(file: string): Call[] {
  const src = fs.readFileSync(file, "utf8");
  const calls: Call[] = [];
  const re = /\bapiFetch\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const args = callArgs(src, m.index + m[0].length);
    const lit = args.match(/^\s*(["'`])(\/[^"'`]*)\1/);
    if (!lit) continue;
    const apiPath = normalisePath(lit[2]);
    if (!apiPath) continue;
    const rest = args.slice(lit[0].length);
    const literalMethod = rest.match(/\bmethod:\s*["'`]([A-Z]+)["'`]/);
    if (!literalMethod && /\bmethod\s*[:,}]/.test(rest)) continue; // runtime-computed method
    calls.push({ file: rel(file), method: literalMethod?.[1] ?? "GET", apiPath });
  }
  return calls;
}

/** Generated commands: one `let url = "…"` + `method: "…"` per tag.command block. */
function generatedCalls(file: string): Call[] {
  const src = fs.readFileSync(file, "utf8");
  return src
    .split(/\n\s*tag\.command\(/)
    .slice(1)
    .flatMap((block) => {
      const url = block.match(/let url = "([^"]+)"/);
      const method = block.match(/\bmethod:\s*"([A-Z]+)"/);
      const apiPath = url ? normalisePath(url[1]) : null;
      return apiPath && method ? [{ file: rel(file), method: method[1], apiPath }] : [];
    });
}

function collectCalls(): Call[] {
  const handWritten = walk(path.join(ROOT, "bin", "cli", "commands"))
    .filter((f) => f.endsWith(".mjs"))
    .flatMap(handWrittenCalls);
  const generated = walk(path.join(ROOT, "bin", "cli", "api-commands"))
    .filter((f) => f.endsWith(".mjs"))
    .flatMap(generatedCalls);
  return [...handWritten, ...generated];
}

function brokenKeys(calls: Call[]): Set<string> {
  const broken = new Set<string>();
  for (const call of calls) {
    const routeFile = resolveRouteFile(call.apiPath);
    const ok =
      routeFile !== null &&
      routeExportsMethod(fs.readFileSync(path.join(ROOT, routeFile), "utf8"), call.method);
    if (!ok) broken.add(`${call.file}::${call.method} ${call.apiPath}`);
  }
  return broken;
}

test("resolver honours static, [param], catch-all and the JSON-404 fallbacks", () => {
  assert.equal(resolveRouteFile("/api/policies"), "src/app/api/policies/route.ts");
  assert.equal(
    resolveRouteFile("/api/provider-nodes/{}"),
    "src/app/api/provider-nodes/[id]/route.ts"
  );
  assert.equal(
    resolveRouteFile("/api/provider-nodes/validate"),
    "src/app/api/provider-nodes/validate/route.ts"
  );
  assert.equal(resolveRouteFile("/api/policies/evaluate"), null, "catch-all 404 is not a route");
  assert.equal(resolveRouteFile("/api/v1/no/such/thing"), null);
});

test("the scan sees the CLI calls it is meant to guard", () => {
  const calls = collectCalls();
  const policyCalls = calls.filter((c) => c.file === "bin/cli/commands/policy.mjs");
  assert.deepEqual(policyCalls.map((c) => `${c.method} ${c.apiPath}`).sort(), [
    "GET /api/policies",
    "POST /api/policies",
  ]);
  assert.ok(
    calls.some((c) => c.file.startsWith("bin/cli/api-commands/")),
    "generated api-commands must be scanned too"
  );
  assert.ok(
    calls.length > 300,
    `expected hundreds of statically resolvable calls, got ${calls.length}`
  );
});

test("every CLI call targets a route and verb the server implements", () => {
  const broken = brokenKeys(collectCalls());
  const fresh = [...broken].filter((k) => !KNOWN_BROKEN.has(k)).sort();
  const stale = [...KNOWN_BROKEN].filter((k) => !broken.has(k)).sort();
  assert.deepEqual(
    fresh,
    [],
    "CLI command(s) call a route/verb that no src/app/api route exports — fix the client or implement the route"
  );
  assert.deepEqual(
    stale,
    [],
    "KNOWN_BROKEN entries no longer reproduce — delete them from the list (it may only shrink)"
  );
});
