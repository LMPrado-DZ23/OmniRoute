import { createInterface } from "node:readline";
import { apiFetch } from "../api.mjs";
import { emit } from "../output.mjs";
import { t } from "../i18n.mjs";

function fmtTs(v) {
  if (!v) return "-";
  return new Date(typeof v === "number" ? v * 1000 : v).toLocaleString();
}

async function confirm(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${q} [y/N] `, (a) => {
      rl.close();
      resolve(a.trim().toLowerCase() === "y");
    });
  });
}

function parseHeader(kv) {
  const eq = kv.indexOf("=");
  if (eq < 0) return { name: kv, value: "" };
  return { name: kv.slice(0, eq), value: kv.slice(eq + 1) };
}

function getRootCommand(cmd) {
  let curr = cmd;
  while (curr.parent) curr = curr.parent;
  return curr;
}

function resolveNodeEndpoint(opts, cmd) {
  if (opts.endpoint) {
    return { endpoint: opts.endpoint, apiFetchOpts: cmd.optsWithGlobals() };
  }
  if (opts.nodeUrl) {
    return { endpoint: opts.nodeUrl, apiFetchOpts: cmd.optsWithGlobals() };
  }

  // Check if --base-url, --endpoint, or --node-url was explicitly passed after the subcommand
  const root = getRootCommand(cmd);
  const rawArgs = root.rawArgs || process.argv;
  const cmdName = cmd.name();

  let subArgsStart = -1;
  for (let i = 0; i < rawArgs.length - 1; i++) {
    if (rawArgs[i] === "nodes" || rawArgs[i] === "provider-nodes") {
      if (rawArgs[i + 1] === cmdName) {
        subArgsStart = i + 2;
        break;
      }
    }
  }

  let explicitSubcommandBaseUrl = undefined;
  let serverBaseUrl = undefined;

  if (subArgsStart !== -1) {
    const preArgs = rawArgs.slice(0, subArgsStart);
    for (let i = 0; i < preArgs.length; i++) {
      if (preArgs[i] === "--base-url" && i + 1 < preArgs.length) {
        serverBaseUrl = preArgs[i + 1];
      } else if (preArgs[i].startsWith("--base-url=")) {
        serverBaseUrl = preArgs[i].slice("--base-url=".length);
      }
    }

    const subArgs = rawArgs.slice(subArgsStart);
    for (let i = 0; i < subArgs.length; i++) {
      const arg = subArgs[i];
      if (
        (arg === "--base-url" || arg === "--endpoint" || arg === "--node-url") &&
        i + 1 < subArgs.length
      ) {
        explicitSubcommandBaseUrl = subArgs[i + 1];
      } else if (
        arg.startsWith("--base-url=") ||
        arg.startsWith("--endpoint=") ||
        arg.startsWith("--node-url=")
      ) {
        explicitSubcommandBaseUrl = arg.slice(arg.indexOf("=") + 1);
      }
    }
  }

  if (explicitSubcommandBaseUrl !== undefined) {
    const globals = cmd.optsWithGlobals?.() ?? {};
    const apiFetchOpts = { ...globals };
    if (serverBaseUrl) {
      apiFetchOpts.baseUrl = serverBaseUrl;
    } else {
      delete apiFetchOpts.baseUrl;
    }
    return { endpoint: explicitSubcommandBaseUrl, apiFetchOpts };
  }

  return { endpoint: undefined, apiFetchOpts: cmd.optsWithGlobals() };
}

const nodeSchema = [
  { key: "id", header: "Node ID", width: 22 },
  { key: "provider", header: "Provider", width: 16 },
  { key: "name", header: "Name", width: 24 },
  { key: "baseUrl", header: "Base URL", width: 38 },
  { key: "region", header: "Region", width: 14 },
  { key: "weight", header: "Weight" },
  { key: "enabled", header: "Enabled", formatter: (v) => (v ? "✓" : "✗") },
  { key: "lastLatencyMs", header: "Latency", formatter: (v) => (v ? `${v}ms` : "-") },
];

/**
 * Reads the node list. GET /api/provider-nodes answers { nodes, total } and
 * accepts only offset/limit (paginationSchema), so provider/enabled filtering
 * and single-node lookups happen here, as the dashboard does it
 * (src/app/(dashboard)/…/useProviderConnections.ts).
 */
async function fetchNodes(apiFetchOpts = {}) {
  const res = await apiFetch("/api/provider-nodes?limit=200", apiFetchOpts);
  if (!res.ok) {
    process.stderr.write(`Error: ${res.status}\n`);
    process.exit(1);
    return [];
  }
  const data = await res.json();
  const nodes = data.nodes ?? data;
  return Array.isArray(nodes) ? nodes : [];
}

export function registerNodes(program) {
  const nodes = program
    .command("nodes")
    .alias("provider-nodes")
    .description(t("nodes.description"));

  nodes
    .command("list")
    .option("--provider <p>", t("nodes.list.provider"))
    .option("--enabled", t("nodes.list.enabled"))
    .action(async (opts, cmd) => {
      const nodes = await fetchNodes();
      const filtered = nodes
        .filter((node) => !opts.provider || node.provider === opts.provider)
        .filter((node) => !opts.enabled || node.enabled !== false);
      emit(filtered, cmd.optsWithGlobals(), nodeSchema);
    });

  nodes.command("get <nodeId>").action(async (id, opts, cmd) => {
    const node = (await fetchNodes()).find((entry) => entry.id === id);
    if (!node) {
      process.stderr.write(`Not found: ${id}\n`);
      process.exit(1);
      return;
    }
    emit(node, cmd.optsWithGlobals(), nodeSchema);
  });

  nodes
    .command("add")
    .requiredOption("--provider <p>", t("nodes.add.provider"))
    .option("--endpoint <url>", t("nodes.add.baseUrl"))
    .option("--base-url <url>", t("nodes.add.baseUrl"))
    .option("--name <n>", t("nodes.add.name"))
    .option("--weight <w>", t("nodes.add.weight"), parseInt, 100)
    .option("--region <r>", t("nodes.add.region"))
    .option(
      "--auth-header <kv>",
      t("nodes.add.authHeader"),
      (v, prev = []) => [...prev, parseHeader(v)],
      []
    )
    .action(async (opts, cmd) => {
      const { endpoint, apiFetchOpts } = resolveNodeEndpoint(opts, cmd);
      if (!endpoint) {
        process.stderr.write(
          `error: required option '--endpoint <url>' or '--base-url <url>' not specified\n`
        );
        process.exit(1);
      }
      const body = {
        provider: opts.provider,
        baseUrl: endpoint,
        name: opts.name,
        weight: opts.weight,
        region: opts.region,
        enabled: true,
        headers: opts.authHeader?.length ? opts.authHeader : undefined,
      };
      const res = await apiFetch("/api/provider-nodes", {
        ...apiFetchOpts,
        method: "POST",
        body,
      });
      if (!res.ok) {
        process.stderr.write(`Error: ${res.status}\n`);
        process.exit(1);
      }
      emit(await res.json(), apiFetchOpts);
    });

  nodes
    .command("update <nodeId>")
    .option("--endpoint <url>", t("nodes.update.baseUrl"))
    .option("--base-url <url>", t("nodes.update.baseUrl"))
    .option("--name <n>", t("nodes.update.name"))
    .option("--weight <w>", t("nodes.update.weight"), parseInt)
    .option("--region <r>", t("nodes.update.region"))
    .option("--enabled <b>", t("nodes.update.enabled"), (v) => v === "true")
    .action(async (id, opts, cmd) => {
      const { endpoint, apiFetchOpts } = resolveNodeEndpoint(opts, cmd);
      const body = {};
      if (endpoint !== undefined) body.baseUrl = endpoint;
      for (const k of ["name", "weight", "region", "enabled"]) {
        if (opts[k] !== undefined) body[k] = opts[k];
      }
      const res = await apiFetch(`/api/provider-nodes/${id}`, {
        ...apiFetchOpts,
        method: "PUT",
        body,
      });
      if (!res.ok) {
        process.stderr.write(`Error: ${res.status}\n`);
        process.exit(1);
      }
      emit(await res.json(), apiFetchOpts);
    });

  nodes
    .command("remove <nodeId>")
    .option("--yes", t("nodes.remove.yes"))
    .action(async (id, opts, cmd) => {
      if (!opts.yes) {
        const ok = await confirm(`Remove node ${id}?`);
        if (!ok) return;
      }
      const res = await apiFetch(`/api/provider-nodes/${id}`, { method: "DELETE" });
      if (!res.ok) {
        process.stderr.write(`Error: ${res.status}\n`);
        process.exit(1);
      }
      process.stdout.write("Removed\n");
    });

  nodes
    .command("validate")
    .option("--endpoint <url>", t("nodes.validate.baseUrl"))
    .option("--base-url <url>", t("nodes.validate.baseUrl"))
    .requiredOption("--provider <p>", t("nodes.validate.provider"))
    .action(async (opts, cmd) => {
      const { endpoint, apiFetchOpts } = resolveNodeEndpoint(opts, cmd);
      if (!endpoint) {
        process.stderr.write(
          `error: required option '--endpoint <url>' or '--base-url <url>' not specified\n`
        );
        process.exit(1);
      }
      const res = await apiFetch("/api/provider-nodes/validate", {
        ...apiFetchOpts,
        method: "POST",
        body: { baseUrl: endpoint, provider: opts.provider },
      });
      if (!res.ok) {
        process.stderr.write(`Error: ${res.status}\n`);
        process.exit(1);
      }
      emit(await res.json(), apiFetchOpts);
    });

  nodes
    .command("test <nodeId>")
    .description(t("nodes.test.description"))
    .action(async (id, opts, cmd) => {
      const node = (await fetchNodes()).find((entry) => entry.id === id);
      if (!node) {
        process.stderr.write(`Not found: ${id}\n`);
        process.exit(1);
        return;
      }
      const body = { baseUrl: node.baseUrl };
      for (const field of ["type", "apiType", "compatMode", "chatPath", "modelsPath"]) {
        if (node[field] != null) body[field] = node[field];
      }
      const res = await apiFetch("/api/provider-nodes/validate", { method: "POST", body });
      if (!res.ok) {
        process.stderr.write(`Error: ${res.status}\n`);
        process.exit(1);
      }
      emit(await res.json(), cmd.optsWithGlobals());
    });

  nodes
    .command("metrics <nodeId>")
    .description(t("nodes.metrics.description"))
    .action(async (id, opts, cmd) => {
      const res = await apiFetch("/api/provider-metrics");
      if (!res.ok) {
        process.stderr.write(`Error: ${res.status}\n`);
        process.exit(1);
      }
      const data = await res.json();
      const metrics = data.metrics?.[id];
      if (!metrics) {
        process.stderr.write(`${t("nodes.metrics.none", { id })}\n`);
        process.exit(1);
        return;
      }
      emit({ node: id, ...metrics }, cmd.optsWithGlobals());
    });
}
