import { readFileSync } from "node:fs";
import { apiFetch } from "../api.mjs";
import { emit } from "../output.mjs";
import { t } from "../i18n.mjs";

const filterSchema = [
  { key: "id", header: "Filter", width: 28 },
  { key: "category", header: "Category", width: 16 },
  { key: "description", header: "Description", width: 48 },
];

export function registerContextEng(program) {
  const ctx = program.command("context-eng").alias("ctx").description(t("context.description"));

  ctx
    .command("analytics")
    .option("--period <p>", t("context.analytics.period"), "7d")
    .action(async (opts, cmd) => {
      const res = await apiFetch(`/api/context/analytics?period=${opts.period}`);
      if (!res.ok) {
        process.stderr.write(`Error: ${res.status}\n`);
        process.exit(1);
      }
      emit(await res.json(), cmd.optsWithGlobals());
    });

  const caveman = ctx.command("caveman").description(t("context.caveman.description"));
  const cmCfg = caveman.command("config").description(t("context.caveman.config.description"));

  cmCfg.command("show").action(async (opts, cmd) => {
    const res = await apiFetch("/api/context/caveman/config");
    if (!res.ok) {
      process.stderr.write(`Error: ${res.status}\n`);
      process.exit(1);
    }
    emit(await res.json(), cmd.optsWithGlobals());
  });

  cmCfg
    .command("set")
    .option("--aggressiveness <n>", t("context.caveman.config.aggressiveness"), parseFloat)
    .option("--max-shrink-pct <n>", t("context.caveman.config.maxShrinkPct"), parseInt)
    .option("--preserve-tags <list>", t("context.caveman.config.preserveTags"), (v) => v.split(","))
    .action(async (opts, cmd) => {
      const body = {};
      if (opts.aggressiveness !== undefined) body.aggressiveness = opts.aggressiveness;
      if (opts.maxShrinkPct !== undefined) body.maxShrinkPct = opts.maxShrinkPct;
      if (opts.preserveTags) body.preserveTags = opts.preserveTags;
      const res = await apiFetch("/api/context/caveman/config", { method: "PUT", body });
      if (!res.ok) {
        process.stderr.write(`Error: ${res.status}\n`);
        process.exit(1);
      }
      emit(await res.json(), cmd.optsWithGlobals());
    });

  const rtk = ctx.command("rtk").description(t("context.rtk.description"));
  const rtkCfg = rtk.command("config").description(t("context.rtk.config.description"));

  rtkCfg.command("show").action(async (opts, cmd) => {
    const res = await apiFetch("/api/context/rtk/config");
    if (!res.ok) {
      process.stderr.write(`Error: ${res.status}\n`);
      process.exit(1);
    }
    emit(await res.json(), cmd.optsWithGlobals());
  });

  rtkCfg
    .command("set")
    .option("--token-budget <n>", t("context.rtk.config.tokenBudget"), parseInt)
    .option("--reserve-pct <n>", t("context.rtk.config.reservePct"), parseInt)
    .action(async (opts, cmd) => {
      const body = {};
      if (opts.tokenBudget) body.tokenBudget = opts.tokenBudget;
      if (opts.reservePct) body.reservePct = opts.reservePct;
      const res = await apiFetch("/api/context/rtk/config", { method: "PUT", body });
      if (!res.ok) {
        process.stderr.write(`Error: ${res.status}\n`);
        process.exit(1);
      }
      emit(await res.json(), cmd.optsWithGlobals());
    });

  // RTK filters are declared in a filters.toml bundle, not created one flag at a
  // time: GET /api/context/rtk/filters lists the loaded catalog and
  // POST /api/context/rtk/import validates or installs a bundle. There is no
  // per-filter create/delete route.
  const filters = rtk.command("filters").description(t("context.rtk.filters.description"));

  filters
    .command("list")
    .description(t("context.rtk.filters.list.description"))
    .action(async (opts, cmd) => {
      const res = await apiFetch("/api/context/rtk/filters");
      if (!res.ok) {
        process.stderr.write(`Error: ${res.status}\n`);
        process.exit(1);
      }
      const data = await res.json();
      emit(data.filters ?? data, cmd.optsWithGlobals(), filterSchema);
    });

  filters
    .command("import <file>")
    .description(t("context.rtk.filters.import.description"))
    .option("--install", t("context.rtk.filters.import.install"))
    .option("--overwrite", t("context.rtk.filters.import.overwrite"))
    .action(async (file, opts, cmd) => {
      const body = {
        action: opts.install ? "install" : "validate",
        content: readFileSync(file, "utf8"),
        ...(opts.install && opts.overwrite ? { overwrite: true } : {}),
      };
      const res = await apiFetch("/api/context/rtk/import", { method: "POST", body });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        process.stderr.write(`Error: ${payload?.error?.message ?? res.status}\n`);
        process.exit(1);
      }
      emit(await res.json(), cmd.optsWithGlobals());
    });

  rtk
    .command("test")
    .requiredOption("--file <path>", t("context.rtk.test.file"))
    .action(async (opts, cmd) => {
      const body = JSON.parse(readFileSync(opts.file, "utf8"));
      const res = await apiFetch("/api/context/rtk/test", { method: "POST", body });
      if (!res.ok) {
        process.stderr.write(`Error: ${res.status}\n`);
        process.exit(1);
      }
      emit(await res.json(), cmd.optsWithGlobals());
    });

  rtk.command("raw-output <id>").action(async (id, opts, cmd) => {
    const res = await apiFetch(`/api/context/rtk/raw-output/${id}`);
    if (!res.ok) {
      process.stderr.write(`Error: ${res.status}\n`);
      process.exit(1);
    }
    emit(await res.json(), cmd.optsWithGlobals());
  });

  const combos = ctx.command("combos").description(t("context.combos.description"));

  combos.command("list").action(async (opts, cmd) => {
    const res = await apiFetch("/api/context/combos");
    if (!res.ok) {
      process.stderr.write(`Error: ${res.status}\n`);
      process.exit(1);
    }
    emit(await res.json(), cmd.optsWithGlobals());
  });

  combos.command("get <id>").action(async (id, opts, cmd) => {
    const res = await apiFetch(`/api/context/combos/${id}`);
    if (!res.ok) {
      process.stderr.write(`Error: ${res.status}\n`);
      process.exit(1);
    }
    emit(await res.json(), cmd.optsWithGlobals());
  });

  combos.command("assignments <id>").action(async (id, opts, cmd) => {
    const res = await apiFetch(`/api/context/combos/${id}/assignments`);
    if (!res.ok) {
      process.stderr.write(`Error: ${res.status}\n`);
      process.exit(1);
    }
    emit(await res.json(), cmd.optsWithGlobals());
  });
}
