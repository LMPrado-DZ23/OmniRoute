import { Argument } from "commander";
import { apiFetch, isServerUp } from "../api.mjs";
import { t } from "../i18n.mjs";

/**
 * Tunnels are per provider, not a generic list of tunnel objects with ids.
 * The server exposes exactly one tunnel per provider:
 *   GET  /api/tunnels/cloudflared            → CloudflaredTunnelStatus
 *   POST /api/tunnels/cloudflared {action}    → enable | disable
 *   GET  /api/tunnels/ngrok                   → NgrokTunnelStatus
 *   POST /api/tunnels/ngrok {action, authToken?}
 *   GET  /api/tunnels/tailscale               → TailscaleTunnelStatus
 *   POST /api/tunnels/tailscale/enable|disable
 * There is no /api/tunnels collection, no per-tunnel id, no logs route and no
 * URL rotation, so `list` fans out over the three providers and `logs`/`rotate`
 * are gone (cloudflared's log file path is part of its status).
 */
const PROVIDERS = {
  cloudflare: "cloudflared",
  cloudflared: "cloudflared",
  tailscale: "tailscale",
  ngrok: "ngrok",
};
const VALID_TUNNEL_TYPES = ["cloudflare", "tailscale", "ngrok"];

function resolveProvider(type) {
  return PROVIDERS[String(type || "").toLowerCase()] ?? null;
}

/** One shape for three different status payloads. */
function normalizeStatus(provider, status) {
  return {
    type: provider,
    active: status.running === true || status.enabled === true,
    url: status.publicUrl ?? status.tunnelUrl ?? null,
    phase: status.phase ?? null,
    installed: status.installed ?? null,
    lastError: status.lastError ?? null,
    logPath: status.logPath ?? null,
  };
}

// Each provider is its own route file, so every path here is spelled out:
// a computed `/api/tunnels/${provider}` would not resolve to anything.
async function fetchStatus(provider, opts = {}) {
  const init = { retry: false, timeout: 8000, acceptNotOk: true, ...opts };
  const res =
    provider === "cloudflared"
      ? await apiFetch("/api/tunnels/cloudflared", init)
      : provider === "ngrok"
        ? await apiFetch("/api/tunnels/ngrok", init)
        : await apiFetch("/api/tunnels/tailscale", init);
  if (!res.ok) return null;
  return res.json();
}

async function postProviderAction(provider, action, extra = {}) {
  const enable = action === "enable";
  if (provider === "tailscale") {
    // tailscale has no {action} body: enable and disable are separate routes.
    const init = { body: extra, retry: false, timeout: 60000, acceptNotOk: true };
    return enable
      ? apiFetch("/api/tunnels/tailscale/enable", { ...init, method: "POST" })
      : apiFetch("/api/tunnels/tailscale/disable", { ...init, method: "POST" });
  }
  const init = {
    body: { action: enable ? "enable" : "disable", ...extra },
    retry: false,
    timeout: 60000,
    acceptNotOk: true,
  };
  return provider === "cloudflared"
    ? apiFetch("/api/tunnels/cloudflared", { ...init, method: "POST" })
    : apiFetch("/api/tunnels/ngrok", { ...init, method: "POST" });
}

export function registerTunnel(program) {
  const tunnel = program.command("tunnel").description(t("tunnel.title"));

  tunnel
    .command("list")
    .description(t("tunnel.listDescription"))
    .option("--json", t("common.jsonOpt"))
    .action(async (opts, cmd) => {
      const globalOpts = cmd.parent.optsWithGlobals();
      const exitCode = await runTunnelListCommand({ ...opts, output: globalOpts.output });
      if (exitCode !== 0) process.exit(exitCode);
    });

  tunnel
    .command("create")
    .description(t("tunnel.createDescription"))
    .addArgument(
      new Argument("[type]", "Tunnel type").choices(VALID_TUNNEL_TYPES).default("cloudflare")
    )
    .option("--auth-token <token>", t("tunnel.authTokenOpt"))
    .action(async (type, opts, cmd) => {
      const globalOpts = cmd.parent.optsWithGlobals();
      const exitCode = await runTunnelCreateCommand(type, { ...opts, output: globalOpts.output });
      if (exitCode !== 0) process.exit(exitCode);
    });

  tunnel
    .command("stop <type>")
    .description(t("tunnel.stopDescription"))
    .option("--yes", t("common.yesOpt"))
    .action(async (type, opts, cmd) => {
      const globalOpts = cmd.parent.optsWithGlobals();
      const exitCode = await runTunnelStopCommand(type, { ...opts, output: globalOpts.output });
      if (exitCode !== 0) process.exit(exitCode);
    });

  tunnel
    .command("status <type>")
    .description(t("tunnel.statusDescription"))
    .option("--json", t("common.jsonOpt"))
    .action(async (type, opts, cmd) => {
      const globalOpts = cmd.parent.optsWithGlobals();
      const exitCode = await runTunnelStatusCommand(type, { ...opts, output: globalOpts.output });
      if (exitCode !== 0) process.exit(exitCode);
    });

  tunnel
    .command("info <type>")
    .description(t("tunnel.infoDescription"))
    .option("--json", t("common.jsonOpt"))
    .action(async (type, opts, cmd) => {
      const globalOpts = cmd.parent.optsWithGlobals();
      const exitCode = await runTunnelInfoCommand(type, { ...opts, output: globalOpts.output });
      if (exitCode !== 0) process.exit(exitCode);
    });
}

export async function runTunnelListCommand(opts = {}) {
  if (!(await isServerUp())) {
    console.error(t("common.serverOffline"));
    return 1;
  }

  const rows = [];
  for (const provider of ["cloudflared", "ngrok", "tailscale"]) {
    const status = await fetchStatus(provider);
    if (status) rows.push(normalizeStatus(provider, status));
  }

  if (opts.json || opts.output === "json") {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }

  console.log(`\n\x1b[1m\x1b[36m${t("tunnel.title")}\x1b[0m\n`);
  if (rows.length === 0) {
    console.log(t("tunnel.notAvailable"));
    return 0;
  }
  for (const row of rows) {
    const state = row.active ? "\x1b[32m● active\x1b[0m" : "\x1b[2m○ inactive\x1b[0m";
    console.log(`  ${row.type.padEnd(12)} ${row.url || "N/A"} ${state}`);
  }
  return 0;
}

export async function runTunnelCreateCommand(type = "cloudflare", opts = {}) {
  const provider = resolveProvider(type);
  if (!provider) {
    console.error(t("tunnel.typeRequired"));
    return 1;
  }
  if (!(await isServerUp())) {
    console.error(t("common.serverOffline"));
    return 1;
  }

  const extra = provider === "ngrok" && opts.authToken ? { authToken: opts.authToken } : {};
  const res = await postProviderAction(provider, "enable", extra);
  if (!res.ok) {
    console.error(t("common.error", { message: `HTTP ${res.status}` }));
    return 1;
  }
  const result = await res.json();
  const status = result.status ?? result;
  const url = status.publicUrl ?? status.tunnelUrl ?? result.tunnelUrl ?? null;
  console.log(url ? t("tunnel.created", { url }) : t("tunnel.createdPending", { type: provider }));
  return 0;
}

export async function runTunnelStopCommand(type, opts = {}) {
  const provider = resolveProvider(type);
  if (!provider) {
    console.error(t("tunnel.typeRequired"));
    return 1;
  }
  if (!(await isServerUp())) {
    console.error(t("common.serverOffline"));
    return 1;
  }

  const res = await postProviderAction(provider, "disable");
  if (!res.ok) {
    console.error(t("common.error", { message: `HTTP ${res.status}` }));
    return 1;
  }
  console.log(t("tunnel.stopped"));
  return 0;
}

export async function runTunnelStatusCommand(type, opts = {}) {
  const provider = resolveProvider(type);
  if (!provider) {
    console.error(t("tunnel.typeRequired"));
    return 1;
  }
  if (!(await isServerUp())) {
    console.error(t("common.serverOffline"));
    return 1;
  }

  const status = await fetchStatus(provider);
  if (!status) {
    console.log(t("tunnel.notAvailable"));
    return 0;
  }
  const row = normalizeStatus(provider, status);

  if (opts.json || opts.output === "json") {
    console.log(JSON.stringify(row, null, 2));
    return 0;
  }

  console.log(`\n\x1b[1m\x1b[36m${t("tunnel.infoTitle", { type: provider })}\x1b[0m\n`);
  console.log(`  active:    ${row.active ? "yes" : "no"}`);
  console.log(`  url:       ${row.url ?? "N/A"}`);
  console.log(`  phase:     ${row.phase ?? "N/A"}`);
  console.log(`  installed: ${row.installed === null ? "N/A" : row.installed ? "yes" : "no"}`);
  if (row.logPath) console.log(`  log file:  ${row.logPath}`);
  if (row.lastError) console.log(`  error:     ${row.lastError}`);
  return 0;
}

export async function runTunnelInfoCommand(type, opts = {}) {
  const provider = resolveProvider(type);
  if (!provider) {
    console.error(t("tunnel.typeRequired"));
    return 1;
  }
  if (!(await isServerUp())) {
    console.error(t("common.serverOffline"));
    return 1;
  }

  const status = await fetchStatus(provider);
  if (!status) {
    console.log(t("tunnel.notAvailable"));
    return 0;
  }

  if (opts.json || opts.output === "json") {
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }

  console.log(`\n\x1b[1m\x1b[36m${t("tunnel.infoTitle", { type: provider })}\x1b[0m\n`);
  for (const [key, value] of Object.entries(status)) {
    if (value === null || value === undefined || typeof value === "object") continue;
    console.log(`  ${key.padEnd(18)} ${value}`);
  }
  return 0;
}
