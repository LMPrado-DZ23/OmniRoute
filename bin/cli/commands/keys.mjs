import { printHeading } from "../io.mjs";
import {
  ensureProviderSchema,
  getProviderApiKey,
  listProviderConnections,
  removeProviderConnectionByProvider,
  upsertApiKeyProviderConnection,
} from "../provider-store.mjs";
import { openOmniRouteDb } from "../sqlite.mjs";
import { loadAvailableProviders } from "../provider-catalog.mjs";
import { apiFetch, isServerUp, isRouteUnavailableStatus } from "../api.mjs";
import { t } from "../i18n.mjs";

function getValidProviderIds() {
  try {
    return new Set(loadAvailableProviders().map((p) => p.id));
  } catch {
    return null;
  }
}

function maskKey(raw) {
  if (!raw || raw.length <= 8) return "***";
  return raw.slice(0, 6) + "***" + raw.slice(-4);
}

export function registerKeys(program) {
  const keys = program
    .command("keys")
    .description(t("keys.title"))
    .addHelpText("after", `\n${t("keys.idSpaces")}\n`);

  keys
    .command("add <provider> [apiKey]")
    .description(t("keys.addDescription"))
    .option("--stdin", t("keys.stdinOpt"))
    .action(async (provider, apiKey, opts, cmd) => {
      const globalOpts = cmd.parent.optsWithGlobals();
      const exitCode = await runKeysAddCommand(provider, apiKey, { ...opts, ...globalOpts });
      if (exitCode !== 0) process.exit(exitCode);
    });

  keys
    .command("list")
    .description(t("keys.listDescription"))
    .option("--json", t("common.jsonOpt"))
    .action(async (opts, cmd) => {
      const globalOpts = cmd.parent.optsWithGlobals();
      const exitCode = await runKeysListCommand({ ...opts, ...globalOpts });
      if (exitCode !== 0) process.exit(exitCode);
    });

  keys
    .command("remove <provider>")
    .description(t("keys.removeDescription"))
    .option("--yes", t("common.yesOpt"))
    .action(async (provider, opts, cmd) => {
      const globalOpts = cmd.parent.optsWithGlobals();
      const exitCode = await runKeysRemoveCommand(provider, { ...opts, ...globalOpts });
      if (exitCode !== 0) process.exit(exitCode);
    });

  keys
    .command("regenerate <id>")
    .description(t("keys.regenerateDescription"))
    .option("--yes", t("common.yesOpt"))
    .action(async (id, opts, cmd) => {
      const globalOpts = cmd.parent.optsWithGlobals();
      const exitCode = await runKeysRegenerateCommand(id, { ...opts, ...globalOpts });
      if (exitCode !== 0) process.exit(exitCode);
    });

  keys
    .command("revoke <id>")
    .description(t("keys.revokeDescription"))
    .option("--yes", t("common.yesOpt"))
    .action(async (id, opts, cmd) => {
      const globalOpts = cmd.parent.optsWithGlobals();
      const exitCode = await runKeysRevokeCommand(id, { ...opts, ...globalOpts });
      if (exitCode !== 0) process.exit(exitCode);
    });

  keys
    .command("usage <id>")
    .description(t("keys.usageDescription"))
    .option("--limit <n>", t("keys.usageLimitOpt"), "20")
    .action(async (id, opts, cmd) => {
      const globalOpts = cmd.parent.optsWithGlobals();
      const exitCode = await runKeysUsageCommand(id, { ...opts, ...globalOpts });
      if (exitCode !== 0) process.exit(exitCode);
    });

  const policy = keys.command("policy").description(t("keys.policy.title"));

  policy
    .command("show <id>")
    .description(t("keys.policy.showDescription"))
    .action(async (id, opts, cmd) => {
      const globalOpts = cmd.parent.parent.optsWithGlobals();
      const exitCode = await runKeysPolicyShowCommand(id, { ...opts, ...globalOpts });
      if (exitCode !== 0) process.exit(exitCode);
    });

  policy
    .command("set <id>")
    .description(t("keys.policy.setDescription"))
    .option("--rate-limit <n>", t("keys.policy.rateLimitOpt"), parseInt)
    .option("--max-cost <n>", t("keys.policy.maxCostOpt"), parseFloat)
    .option("--allowed-models <list>", t("keys.policy.allowedModelsOpt"))
    .action(async (id, opts, cmd) => {
      const globalOpts = cmd.parent.parent.optsWithGlobals();
      const exitCode = await runKeysPolicySetCommand(id, { ...opts, ...globalOpts });
      if (exitCode !== 0) process.exit(exitCode);
    });

  const expiration = keys.command("expiration").description(t("keys.expiration.title"));

  expiration
    .command("list")
    .description(t("keys.expiration.listDescription"))
    .option("--days <n>", t("keys.expiration.daysOpt"), "30")
    .option("--json", t("common.jsonOpt"))
    .action(async (opts, cmd) => {
      const globalOpts = cmd.parent.parent.optsWithGlobals();
      const exitCode = await runKeysExpirationListCommand({ ...opts, ...globalOpts });
      if (exitCode !== 0) process.exit(exitCode);
    });
}

/**
 * Provider credentials are provider CONNECTIONS: /api/providers (list/create),
 * /api/providers/{id} (PATCH/DELETE). There is no /api/v1/providers/keys.
 */
async function fetchApiKeyConnections(provider) {
  const options = { retry: false, acceptNotOk: true };
  const res = provider
    ? await apiFetch(`/api/providers?provider=${encodeURIComponent(provider)}`, options)
    : await apiFetch("/api/providers", options);
  if (!res.ok) return null;
  const data = await res.json();
  const connections = data.connections ?? data;
  if (!Array.isArray(connections)) return null;
  return connections.filter((connection) => connection.authType === "apikey");
}

export async function runKeysAddCommand(provider, apiKey, opts = {}) {
  if (!provider) {
    console.error(t("keys.providerRequired"));
    return 1;
  }

  let key = apiKey;
  if (opts.stdin) {
    key = await readStdin();
    if (!key) {
      console.error(t("keys.stdinEmpty"));
      return 1;
    }
  }

  if (!key) {
    console.error(t("keys.keyRequired"));
    return 1;
  }

  const providerLower = provider.toLowerCase();
  const validIds = getValidProviderIds();
  if (validIds && !validIds.has(providerLower)) {
    console.error(t("keys.unknownProvider", { provider: providerLower }));
    return 1;
  }

  const serverUp = await isServerUp();
  if (serverUp) {
    try {
      // Update the provider's existing api-key connection if it has one,
      // otherwise create it — the CLI's offline path upserts the same way.
      const existingRemote = await fetchApiKeyConnections(providerLower);
      const target = existingRemote?.[0];
      const res = target
        ? await apiFetch(`/api/providers/${encodeURIComponent(target.id)}`, {
            method: "PATCH",
            body: { apiKey: key },
            retry: false,
            acceptNotOk: true,
          })
        : await apiFetch("/api/providers", {
            method: "POST",
            body: { provider: providerLower, name: providerLower, apiKey: key },
            retry: false,
            acceptNotOk: true,
          });
      if (res.ok) {
        console.log(t("keys.added", { provider: providerLower }));
        return 0;
      }
      // A missing route means this server does not implement the endpoint —
      // fall through to the local SQLite path below rather than stranding the
      // user. Real client errors still abort.
      if (res.status >= 400 && res.status < 500 && !isRouteUnavailableStatus(res.status)) {
        console.error(t("common.error", { message: `HTTP ${res.status}` }));
        return 1;
      }
    } catch {}
  }

  const { db } = await openOmniRouteDb();
  try {
    const existing = listProviderConnections(db).find(
      (c) => c.provider === providerLower && c.authType === "apikey"
    );
    upsertApiKeyProviderConnection(db, {
      provider: providerLower,
      name: existing?.name || providerLower,
      apiKey: key,
    });
    console.log(t("keys.added", { provider: providerLower }));
    return 0;
  } finally {
    db.close();
  }
}

export async function runKeysListCommand(opts = {}) {
  const serverUp = await isServerUp();

  if (serverUp) {
    try {
      const connections = await fetchApiKeyConnections();
      if (connections) {
        return _printKeysList(connections, opts);
      }
    } catch {}
  }

  const { db } = await openOmniRouteDb();
  try {
    ensureProviderSchema(db);
    const connections = listProviderConnections(db).filter(
      (c) => c.authType === "apikey" && c.apiKey
    );
    return _printKeysList(connections, opts);
  } finally {
    db.close();
  }
}

function _printKeysList(connections, opts) {
  if (opts.json || opts.output === "json") {
    const rows = connections.map((c) => ({
      id: c.id,
      provider: c.provider,
      name: c.name,
      isActive: c.isActive !== false,
      maskedKey: maskKey(c.apiKey || c.maskedKey || ""),
    }));
    console.log(JSON.stringify({ keys: rows }, null, 2));
    return 0;
  }

  printHeading(t("keys.title"));
  if (connections.length === 0) {
    console.log(t("keys.noKeys"));
    return 0;
  }

  for (const c of connections) {
    let masked = c.maskedKey || "";
    if (!masked && c.apiKey) {
      try {
        masked = maskKey(getProviderApiKey(c));
      } catch {
        masked = maskKey(c.apiKey);
      }
    }
    const status = c.isActive !== false ? "\x1b[32m● enabled\x1b[0m" : "\x1b[33m○ disabled\x1b[0m";
    console.log(`  ${(c.provider || "").padEnd(20)} ${masked.padEnd(22)} ${status}`);
  }

  console.log(`\n${t("keys.listed", { count: connections.length })}`);
  return 0;
}

export async function runKeysRemoveCommand(provider, opts = {}) {
  if (!provider) {
    console.error(t("keys.providerRequired"));
    return 1;
  }

  const providerLower = provider.toLowerCase();

  if (!opts.yes) {
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) =>
      rl.question(t("keys.confirmRemove", { id: providerLower }) + " [y/N] ", resolve)
    );
    rl.close();
    if (!/^y(es)?$/i.test(answer)) {
      console.log(t("common.cancelled"));
      return 0;
    }
  }

  const serverUp = await isServerUp();
  if (serverUp) {
    try {
      // DELETE takes a connection id, so resolve the provider's connections first.
      const connections = await fetchApiKeyConnections(providerLower);
      if (connections && connections.length > 0) {
        let removed = 0;
        for (const connection of connections) {
          const res = await apiFetch(`/api/providers/${encodeURIComponent(connection.id)}`, {
            method: "DELETE",
            retry: false,
            acceptNotOk: true,
          });
          if (res.ok) removed += 1;
        }
        if (removed > 0) {
          console.log(t("keys.removed"));
          return 0;
        }
      }
    } catch {}
  }

  const { db } = await openOmniRouteDb();
  try {
    const changes = removeProviderConnectionByProvider(db, providerLower);
    if (changes > 0) {
      console.log(t("keys.removed"));
      return 0;
    }
    console.log(t("keys.noKeys"));
    return 0;
  } finally {
    db.close();
  }
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

export async function runKeysRegenerateCommand(id, opts = {}) {
  if (!opts.yes) {
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((r) =>
      rl.question(t("keys.confirmRegenerate", { id }) + " [y/N] ", r)
    );
    rl.close();
    if (!/^y(es)?$/i.test(answer)) {
      console.log(t("common.cancelled"));
      return 0;
    }
  }
  if (!(await isServerUp())) {
    console.error(t("common.serverOffline"));
    return 1;
  }
  try {
    const res = await apiFetch(`/api/keys/${encodeURIComponent(id)}/regenerate`, {
      method: "POST",
      retry: false,
    });
    if (!res.ok) {
      console.error(t("common.error", { message: `HTTP ${res.status}` }));
      return 1;
    }
    const data = await res.json();
    console.log(t("keys.regenerated", { key: data.key || data.apiKey || "(see dashboard)" }));
    return 0;
  } catch (err) {
    console.error(t("common.error", { message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }
}

export async function runKeysRevokeCommand(id, opts = {}) {
  if (!opts.yes) {
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((r) =>
      rl.question(t("keys.confirmRevoke", { id }) + " [y/N] ", r)
    );
    rl.close();
    if (!/^y(es)?$/i.test(answer)) {
      console.log(t("common.cancelled"));
      return 0;
    }
  }
  if (!(await isServerUp())) {
    console.error(t("common.serverOffline"));
    return 1;
  }
  try {
    const res = await apiFetch(`/api/v1/registered-keys/${encodeURIComponent(id)}/revoke`, {
      method: "POST",
      retry: false,
    });
    if (!res.ok) {
      console.error(t("common.error", { message: `HTTP ${res.status}` }));
      return 1;
    }
    console.log(t("keys.revoked", { id }));
    return 0;
  } catch (err) {
    console.error(t("common.error", { message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }
}

export async function runKeysUsageCommand(id, opts = {}) {
  if (!(await isServerUp())) {
    console.error(t("common.serverOffline"));
    return 1;
  }
  const limit = opts.limit || "20";
  try {
    // Request history lives in the call log, which filters by key NAME
    // (src/app/api/usage/call-logs/route.ts), so resolve the key first.
    const keyRes = await apiFetch(`/api/keys/${encodeURIComponent(id)}`, {
      retry: false,
      acceptNotOk: true,
    });
    if (!keyRes.ok) {
      console.error(t("common.error", { message: `HTTP ${keyRes.status}` }));
      return 1;
    }
    const key = await keyRes.json();
    const params = new URLSearchParams({ limit: String(limit) });
    if (key.name) params.set("apiKey", key.name);
    const res = await apiFetch(`/api/usage/call-logs?${params}`, { retry: false });
    if (!res.ok) {
      console.error(t("common.error", { message: `HTTP ${res.status}` }));
      return 1;
    }
    const data = await res.json();
    const rows = Array.isArray(data) ? data : (data.logs ?? data.data ?? []);
    if (rows.length === 0) {
      console.log(t("keys.noUsage"));
      return 0;
    }
    for (const r of rows) {
      const ts = r.timestamp || r.createdAt || "";
      const path = r.path || r.endpoint || "";
      const status = r.status || r.statusCode || "";
      console.log(`  ${ts}  ${String(status).padEnd(4)}  ${path}`);
    }
    return 0;
  } catch (err) {
    console.error(t("common.error", { message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }
}

export async function runKeysPolicyShowCommand(id, opts = {}) {
  if (!(await isServerUp())) {
    console.error(t("common.serverOffline"));
    return 1;
  }
  try {
    // The per-key limits live on the key record itself: GET /api/keys/{id}.
    const res = await apiFetch(`/api/keys/${encodeURIComponent(id)}`, {
      acceptNotOk: true,
      retry: false,
    });
    if (!res.ok) {
      console.error(t("common.error", { message: `HTTP ${res.status}` }));
      return 1;
    }
    const data = await res.json();
    const rateLimits = Array.isArray(data.rateLimits) ? data.rateLimits : [];
    const policy = {
      rateLimits,
      modelAccessMode: data.modelAccessMode ?? "all",
      allowedModels: data.allowedModels ?? [],
      blockedModels: data.blockedModels ?? [],
      dailyUsageLimitUsd: data.dailyUsageLimitUsd ?? null,
      weeklyUsageLimitUsd: data.weeklyUsageLimitUsd ?? null,
      monthlyUsageLimitUsd: data.monthlyUsageLimitUsd ?? null,
    };
    if (opts.output === "json" || opts.json) {
      console.log(JSON.stringify(policy, null, 2));
      return 0;
    }
    console.log(t("keys.policy.title") + ` (${id}):`);
    const rateText = rateLimits.map((entry) => `${entry.limit}/${entry.window}s`).join(", ");
    console.log(`  rate_limits:     ${rateText || "(unset)"}`);
    console.log(`  daily_max_usd:   ${policy.dailyUsageLimitUsd ?? "(unset)"}`);
    console.log(`  model_access:    ${policy.modelAccessMode}`);
    console.log(`  allowed_models:  ${policy.allowedModels.join(", ") || "(all)"}`);
    console.log(`  blocked_models:  ${policy.blockedModels.join(", ") || "(none)"}`);
    return 0;
  } catch (err) {
    console.error(t("common.error", { message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }
}

export async function runKeysPolicySetCommand(id, opts = {}) {
  // updateKeyPermissionsSchema shape: rate limits are {limit, window} pairs
  // (window in seconds), a spend cap is dailyUsageLimitUsd + usageLimitEnabled,
  // and an allow-list only applies with modelAccessMode "restricted".
  const body = {};
  if (opts.rateLimit != null) {
    body.rateLimits = [{ limit: Number(opts.rateLimit), window: 60 }];
  }
  if (opts.maxCost != null) {
    body.usageLimitEnabled = true;
    body.dailyUsageLimitUsd = Number(opts.maxCost);
  }
  if (opts.allowedModels) {
    body.allowedModels = opts.allowedModels.split(",").map((s) => s.trim());
    body.modelAccessMode = "restricted";
  }

  if (Object.keys(body).length === 0) {
    console.error(t("keys.policy.nothingToSet"));
    return 1;
  }
  if (!(await isServerUp())) {
    console.error(t("common.serverOffline"));
    return 1;
  }
  try {
    const res = await apiFetch(`/api/keys/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
      acceptNotOk: true,
      retry: false,
    });
    if (!res.ok) {
      console.error(t("common.error", { message: `HTTP ${res.status}` }));
      return 1;
    }
    console.log(t("keys.policy.updated"));
    return 0;
  } catch (err) {
    console.error(t("common.error", { message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }
}

export async function runKeysExpirationListCommand(opts = {}) {
  if (!(await isServerUp())) {
    console.error(t("common.serverOffline"));
    return 1;
  }
  const days = Number(opts.days || 30);
  try {
    const res = await apiFetch(`/api/v1/registered-keys?expiring=true&days=${days}`, {
      acceptNotOk: true,
      retry: false,
    });
    if (!res.ok) {
      console.error(t("common.error", { message: `HTTP ${res.status}` }));
      return 1;
    }
    const data = await res.json();
    const rows = data.keys || data.items || data;
    if (!Array.isArray(rows) || rows.length === 0) {
      console.log(t("keys.expiration.none", { days }));
      return 0;
    }
    if (opts.json || opts.output === "json") {
      console.log(JSON.stringify(rows, null, 2));
      return 0;
    }
    console.log(t("keys.expiration.listTitle", { days }));
    for (const k of rows) {
      const exp = k.expiresAt || k.expires_at || "(unknown)";
      console.log(`  ${(k.id || "").padEnd(24)} ${(k.name || "").padEnd(20)} expires: ${exp}`);
    }
    return 0;
  } catch (err) {
    console.error(t("common.error", { message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }
}
