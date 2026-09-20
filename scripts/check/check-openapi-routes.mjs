#!/usr/bin/env node
// scripts/check/check-openapi-routes.mjs
// Gate anti-alucinação (docs): toda `path` documentada em docs/openapi.yaml
// deve resolver para um route.ts real em src/app/api/. Pega endpoint INVENTADO/obsoleto
// na spec (a IA escreve docs descrevendo rota que não existe). Complementa
// check-openapi-coverage.mjs (que mede a direção inversa: % de rotas documentadas).
// Stale-enforcement (6A.3): entrada em KNOWN_STALE_SPEC que não suprime nenhum path
// órfão real → gate falha com instrução de remoção (evita furo de regressão silencioso).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as yaml from "js-yaml";
import { reportStaleEntries } from "./lib/allowlist.mjs";
import { apiRoot, collectApiRouteUrlPaths } from "./lib/apiRoutes.mjs";

const ROOT = process.cwd();
const OPENAPI_PATH = path.join(ROOT, "docs", "openapi.yaml");

// Entradas da spec sem rota real, congeladas para triagem (catraca: bloqueia NOVAS).
export const KNOWN_STALE_SPEC = new Set([
  // openapi.yaml documenta um state por-agente, mas a rota real é o state GLOBAL
  // (/api/tools/agent-bridge/state); por-agente só há /{id}, /{id}/detect, /mappings, /dns.
]);

/** Normaliza qualquer {param} para {} para casar independente do nome do parâmetro. */
export function normalizeParams(p) {
  return p.replace(/\{[^}]+\}/g, "{}");
}

/** Paths da spec que não casam com nenhuma rota implementada (param-insensitive). */
export function findSpecPathsWithoutRoute(specPaths, implPaths) {
  const impl = new Set(implPaths.map(normalizeParams));
  return specPaths.filter((p) => !impl.has(normalizeParams(p)));
}

/**
 * Paths que só diferem no NOME da variável de template — pela OpenAPI 3.x são o
 * MESMO endpoint e não podem coexistir ("Templated paths with the same hierarchy
 * but different templated names MUST NOT exist"). Uma spec assim é inválida:
 * `oasdiff` recusa a diff inteira com `duplicate endpoint`, então
 * `check:openapi-breaking` deixa de medir qualquer coisa e passa como SKIP —
 * um verde que não significa nada.
 *
 * Este gate era cego para isso justamente porque compara param-insensitive: as
 * duas grafias resolvem para a mesma rota real, então ambas passavam.
 *
 * @param {string[]} specPaths
 * @returns {Array<{ normalized: string, paths: string[] }>}
 */
export function findDuplicateNormalizedPaths(specPaths) {
  const byNormalized = new Map();
  for (const p of specPaths) {
    const key = normalizeParams(p);
    if (!byNormalized.has(key)) byNormalized.set(key, []);
    byNormalized.get(key).push(p);
  }
  return [...byNormalized.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([normalized, paths]) => ({ normalized, paths }));
}

/**
 * @param {{ root?: string, openapiPath?: string, implPaths?: string[] }} [opts]
 * @returns {{ ok: boolean, exitCode: number, message: string }}
 */
export function runOpenapiRoutesCheck(opts = {}) {
  const root = opts.root || ROOT;
  const openapiPath = opts.openapiPath || path.join(root, "docs", "openapi.yaml");
  if (!fs.existsSync(openapiPath)) {
    return {
      ok: false,
      exitCode: 1,
      message: `[openapi-routes] FAIL — openapi.yaml não encontrado: ${openapiPath}`,
    };
  }
  if (!fs.existsSync(apiRoot(root))) {
    return {
      ok: false,
      exitCode: 1,
      message: `[openapi-routes] FAIL — API root not found: ${apiRoot(root)}`,
    };
  }

  const raw = yaml.load(fs.readFileSync(openapiPath, "utf-8"));
  const specPaths = Object.keys(raw.paths || {}).filter((p) => p.startsWith("/api"));
  const implPaths = opts.implPaths || collectApiRouteUrlPaths(root);

  const liveOrphans = findSpecPathsWithoutRoute(specPaths, implPaths);
  const stale = reportStaleEntries(KNOWN_STALE_SPEC, liveOrphans, "openapi-routes");
  const orphans = liveOrphans.filter((p) => !KNOWN_STALE_SPEC.has(p));

  const duplicates = findDuplicateNormalizedPaths(specPaths);

  const parts = [];
  if (duplicates.length) {
    parts.push(
      `[openapi-routes] ${duplicates.length} endpoint(s) documentado(s) mais de uma vez ` +
        `(mesmo path, nome de parâmetro diferente):\n` +
        duplicates
          .map(
            ({ normalized, paths }) =>
              `  ✗ ${normalized}\n` + paths.map((p) => `      ${p}`).join("\n")
          )
          .join("\n") +
        `\n  → pela OpenAPI 3.x são o MESMO endpoint; oasdiff recusa a spec inteira` +
        `\n    com "duplicate endpoint" e check:openapi-breaking para de medir.` +
        `\n  → funda os blocos num só, usando o nome do parâmetro da rota real.`
    );
  }
  if (stale.length) {
    parts.push(
      `[openapi-routes] ${stale.length} entrada(s) obsoleta(s) na allowlist ` +
        `— a violação foi corrigida; REMOVA a entrada para travar a correção:\n` +
        stale.map((e) => `  ✗ ${e}`).join("\n")
    );
  }
  if (orphans.length) {
    parts.push(
      `[openapi-routes] ${orphans.length} path(s) documentado(s) sem rota real:\n` +
        orphans.map((p) => "  ✗ " + p).join("\n") +
        `\n  → crie a rota, corrija/remova a entrada na spec, ou adicione a KNOWN_STALE_SPEC com justificativa.`
    );
  }
  if (parts.length) {
    return { ok: false, exitCode: 1, message: parts.join("\n") };
  }
  return {
    ok: true,
    exitCode: 0,
    message: `[openapi-routes] OK — ${specPaths.length} paths na spec, todos com rota real (${implPaths.length} rotas)`,
  };
}

function main() {
  // Keep assertNoStale side-effect path for CLI parity with other gates when
  // runOpenapiRoutesCheck is not used alone — here we print structured result.
  const result = runOpenapiRoutesCheck();
  if (result.ok) console.log(result.message);
  else console.error(result.message);
  process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
