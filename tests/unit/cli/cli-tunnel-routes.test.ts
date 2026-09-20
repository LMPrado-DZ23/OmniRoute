import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

// Load first: blocks the network before any route/open-sse module is imported.
import { installRouteBackedFetch, type RoutedCall } from "./_helpers/routeBackedFetch.ts";
import {
  registerTunnel,
  runTunnelListCommand,
  runTunnelStatusCommand,
  runTunnelStopCommand,
} from "../../../bin/cli/commands/tunnel.mjs";

// Every tunnel subcommand addressed a generic collection — GET/POST /api/tunnels,
// GET/DELETE /api/tunnels/{id}, /{id}/status, /{id}/logs, /{id}/rotate — and none
// of those exist. The server has one tunnel per provider:
// /api/tunnels/{cloudflared,ngrok,tailscale}. `logs` and `rotate` are gone (no
// route serves either; cloudflared's log path is part of its status), and
// `cloudflare` now maps to the real provider key `cloudflared`.
//
// The enable paths spawn binaries and open real tunnels, so only the read paths
// and the (no-op in a fresh DATA_DIR) disable are exercised here.

function quiet(t: test.TestContext): string[] {
  const out: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => out.push(args.map(String).join(" ")));
  t.mock.method(console, "error", (...args: unknown[]) => out.push(args.map(String).join(" ")));
  return out;
}

function unimplemented(calls: RoutedCall[]): string[] {
  return calls
    .filter((c) => c.status === 404 || c.status === 405)
    .map((c) => `${c.method} ${c.pathname} → ${c.status}`);
}

test("tunnel offers only the subcommands the provider routes support", () => {
  const program = new Command();
  program.exitOverride();
  registerTunnel(program);
  const names =
    program.commands.find((c) => c.name() === "tunnel")?.commands.map((c) => c.name()) ?? [];
  assert.deepEqual(names.sort(), ["create", "info", "list", "status", "stop"]);
  assert.equal(names.includes("logs"), false, "no route serves tunnel logs");
  assert.equal(names.includes("rotate"), false, "no route rotates a tunnel URL");
});

test("tunnel list fans out over the three provider status routes", async (t) => {
  const calls = installRouteBackedFetch(t);
  const out = quiet(t);

  assert.equal(await runTunnelListCommand({ output: "json" }), 0);

  const paths = calls.filter((c) => c.method === "GET").map((c) => c.pathname);
  assert.ok(paths.includes("/api/tunnels/cloudflared"));
  assert.ok(paths.includes("/api/tunnels/ngrok"));
  assert.ok(paths.includes("/api/tunnels/tailscale"));
  assert.equal(
    calls.some((c) => c.pathname === "/api/tunnels"),
    false,
    "there is no tunnel collection route"
  );
  const text = out.join("");
  const rows: unknown = JSON.parse(text.slice(text.indexOf("[\n")));
  assert.ok(Array.isArray(rows) && rows.length === 3);
  assert.deepEqual(
    rows.map((r) => r.type),
    ["cloudflared", "ngrok", "tailscale"]
  );
  assert.deepEqual(unimplemented(calls), []);
});

test("tunnel status cloudflare reads the cloudflared provider route", async (t) => {
  const calls = installRouteBackedFetch(t);
  const out = quiet(t);

  assert.equal(await runTunnelStatusCommand("cloudflare", { output: "json" }), 0);

  const status = calls.find((c) => c.method === "GET" && c.pathname.startsWith("/api/tunnels/"));
  assert.ok(status);
  assert.equal(status.pathname, "/api/tunnels/cloudflared", "cloudflare → cloudflared");
  assert.equal(status.routeFile, "src/app/api/tunnels/cloudflared/route.ts");
  assert.equal(status.status, 200);
  const statusText = out.join("");
  const row: unknown = JSON.parse(statusText.slice(statusText.indexOf("{\n")));
  assert.ok(typeof row === "object" && row !== null && "active" in row && "url" in row);
  assert.deepEqual(unimplemented(calls), []);
});

test("tunnel stop posts the disable action the provider route expects", async (t) => {
  const calls = installRouteBackedFetch(t);
  quiet(t);

  assert.equal(await runTunnelStopCommand("cloudflare", { yes: true }), 0);

  const disable = calls.find((c) => c.method === "POST");
  assert.ok(disable, "stop posts to the provider route");
  assert.equal(disable.pathname, "/api/tunnels/cloudflared");
  assert.deepEqual(disable.body, { action: "disable" });
  assert.equal(disable.status, 200, "the real handler accepts the body");
  assert.deepEqual(unimplemented(calls), []);
});
