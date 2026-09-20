import { apiFetch, isServerUp } from "../api.mjs";
import { t } from "../i18n.mjs";

export function registerQuota(program) {
  const quota = program
    .command("quota")
    .description(t("quota.description"))
    .option("--provider <id>", "Filter by provider")
    .option("--json", "Output as JSON")
    .action(async (opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const exitCode = await runQuotaCommand({ ...opts, output: globalOpts.output });
      if (exitCode !== 0) process.exit(exitCode);
    });

  quota
    .command("status")
    .description("Show truthful OmniRoute gateway, quota, pool, and circuit state")
    .action(async (opts, cmd) => runBoundedJson("/api/omniroute/status", cmd.optsWithGlobals()));

  quota
    .command("preview")
    .description("Preview allocation enforcement without an upstream request")
    .requiredOption("--api-key-id <id>", "API key id")
    .requiredOption("--pool-id <id>", "quota pool id")
    .option("--tokens <n>", "estimated token usage")
    .action(async (opts, cmd) => {
      const params = new URLSearchParams({ apiKeyId: opts.apiKeyId, poolId: opts.poolId });
      if (opts.tokens != null) params.set("estimatedTokens", opts.tokens);
      await runBoundedJson(`/api/quota/preview?${params}`, cmd.optsWithGlobals());
    });

  quota
    .command("ensure <json>")
    .description("Idempotently create or update a quota pool from a JSON object")
    .action(async (json, opts, cmd) => {
      let body;
      try {
        body = JSON.parse(json);
      } catch {
        console.error("Invalid pool JSON");
        process.exit(2);
      }
      await runBoundedJson("/api/quota/pools?ensure=true", cmd.optsWithGlobals(), {
        method: "POST",
        body,
      });
    });
}

async function runBoundedJson(path, opts, request = {}) {
  const started = performance.now();
  const res = await apiFetch(path, {
    ...request,
    retry: false,
    timeout: Math.min(opts.timeout ?? 5000, 5000),
    acceptNotOk: true,
  });
  const elapsed = Math.round(performance.now() - started);
  if (process.env.OMNIROUTE_DEBUG === "1") {
    console.error(`[omniroute] ${request.method ?? "GET"} ${path} completed in ${elapsed}ms`);
  }
  const payload = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    console.error(JSON.stringify(payload));
    process.exit(res.exitCode ?? 1);
  }
  console.log(JSON.stringify(payload, null, 2));
}

export async function runQuotaCommand(opts = {}) {
  const serverUp = await isServerUp();
  if (!serverUp) {
    console.error(t("quota.noServer"));
    return 1;
  }

  // /api/quota is the quota-sharing pool tree (pools/groups/plans) and there
  // is no /api/v1/providers list. Provider quota lives in GET /api/usage/quota
  // (src/shared/contracts/quota.ts), the same route the dashboard and
  // `omniroute usage quota` read.
  let quotaData = null;

  try {
    const params = opts.provider ? `?provider=${encodeURIComponent(opts.provider)}` : "";
    const res = await apiFetch(`/api/usage/quota${params}`, {
      retry: false,
      timeout: 5000,
      acceptNotOk: true,
    });
    if (res.ok) {
      const payload = await res.json();
      quotaData = {
        providers: (payload.providers ?? []).map((entry) => ({
          provider: entry.name || entry.provider,
          used: entry.quotaUsed ?? 0,
          quota: entry.quotaTotal ?? null,
          percentRemaining: entry.percentRemaining ?? null,
          reset: entry.resetAt ?? null,
        })),
      };
    }
  } catch {
    // reported as "no quota information" below
  }

  if (opts.json || opts.output === "json") {
    console.log(JSON.stringify(quotaData || { error: "No quota data" }, null, 2));
    return 0;
  }

  if (!quotaData?.providers) {
    console.log(t("quota.noData"));
    return 0;
  }

  const providers = quotaData.providers;

  console.log(`\n\x1b[1m\x1b[36mProvider Quota Usage\x1b[0m\n`);
  console.log(
    "\x1b[36m" +
      "  Provider".padEnd(25) +
      "Used".padEnd(15) +
      "Remaining".padEnd(20) +
      "Reset\x1b[0m"
  );
  console.log(
    "\x1b[2m  " +
      "─".repeat(24) +
      " " +
      "─".repeat(14) +
      " " +
      "─".repeat(19) +
      " " +
      "─".repeat(15) +
      "\x1b[0m"
  );

  for (const p of providers) {
    const provider = (p.provider || "unknown").slice(0, 23).padEnd(25);
    const used = String(p.used || 0).padEnd(15);
    const remainingValue =
      p.quota != null ? Math.max(0, p.quota - (p.used ?? 0)) : (p.percentRemaining ?? null);
    const remaining = String(
      p.quota != null ? remainingValue : remainingValue != null ? `${remainingValue}%` : "N/A"
    )
      .slice(0, 18)
      .padEnd(20);
    const reset = p.reset || "N/A";
    console.log(`  ${provider}${used}${remaining}${reset}`);
  }

  console.log(`\n  \x1b[32mTotal: ${providers.length} providers\x1b[0m`);
  return 0;
}
