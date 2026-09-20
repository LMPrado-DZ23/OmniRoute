import { apiFetch } from "../api.mjs";
import { emit } from "../output.mjs";
import { t } from "../i18n.mjs";

/**
 * `omniroute policy` — login-lockout administration.
 *
 * `/api/policies` is the login-lockout endpoint (src/domain/lockoutPolicy):
 *   GET  → { lockedIdentifiers: [{ identifier, lockedUntil, remainingMs }] }
 *   POST → { action: "unlock", identifier } force-unlocks one identifier.
 *
 * There is no policy CRUD / evaluate API. Model blocking, provider preference,
 * token limits and budgets are configured through their real features (per-key
 * blocked models, combos, per-key limits, `omniroute usage budget`), which the
 * command help points to.
 */

function fmtTs(v) {
  if (!v) return "-";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

function fmtRemaining(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "-";
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

const lockedSchema = [
  { key: "identifier", header: "Identifier", width: 36 },
  { key: "lockedUntil", header: "Locked until", formatter: fmtTs },
  { key: "remainingMs", header: "Remaining", formatter: fmtRemaining },
];

export async function runPolicyList(opts, cmd) {
  const res = await apiFetch("/api/policies");
  if (!res.ok) {
    process.stderr.write(`Error: ${res.status}\n`);
    process.exit(1);
    return;
  }
  const data = await res.json();
  const locked = Array.isArray(data?.lockedIdentifiers) ? data.lockedIdentifiers : [];
  emit(locked, cmd.optsWithGlobals(), lockedSchema);
}

export async function runPolicyUnlock(identifier, opts, cmd) {
  const res = await apiFetch("/api/policies", {
    method: "POST",
    body: { action: "unlock", identifier },
  });
  if (!res.ok) {
    process.stderr.write(`Error: ${res.status}\n`);
    process.exit(1);
    return;
  }
  emit(await res.json(), cmd.optsWithGlobals());
}

export function registerPolicy(program) {
  const policy = program
    .command("policy")
    .description(t("policy.description"))
    .addHelpText("after", `\n${t("policy.relatedFeatures")}\n`);

  policy.command("list").description(t("policy.list.description")).action(runPolicyList);

  policy
    .command("unlock <identifier>")
    .description(t("policy.unlock.description"))
    .action(runPolicyUnlock);
}
