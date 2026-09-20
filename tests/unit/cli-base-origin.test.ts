/**
 * Origin-form base URL: composition proof.
 *
 * The bug this guards against is not "the placeholder failed to render" — it is
 * "the placeholder rendered fine and the resulting URL 404s". A card can only be
 * verified by composing what the CLI card hands the user with what that client
 * appends, and resolving the result against the routes this app actually serves.
 *
 * So these tests resolve real paths through the real Next.js rewrite table and the
 * real app-router file tree, rather than comparing strings to strings.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { toGatewayOriginUrl, toGatewayV1Url } = await import("../../src/shared/utils/cliBaseUrl.ts");
const { CLI_TOOLS } = await import("../../src/shared/constants/cliTools.ts");

const ROOT = process.cwd();
const GATEWAY = "http://localhost:20128";

// ─── The rewrite table, read from next.config.mjs rather than assumed ────────

/**
 * Pull the literal `{ source, destination }` rewrite pairs out of next.config.mjs.
 * Importing the config would drag in the plugin chain; the point here is only to
 * prove the rule exists in the committed config, so it is read as text and the
 * assertions below fail loudly if the shape ever changes.
 */
function readRewriteRules(): Array<{ source: string; destination: string }> {
  const config = fs.readFileSync(path.join(ROOT, "next.config.mjs"), "utf8");
  const rules: Array<{ source: string; destination: string }> = [];
  const re = /source:\s*"([^"]+)"\s*,\s*destination:\s*"([^"]+)"/g;
  for (const m of config.matchAll(re)) rules.push({ source: m[1], destination: m[2] });
  return rules;
}

/** Apply a `/prefix/:path*` style rewrite. Returns the pathname unchanged if none match. */
function applyRewrites(pathname: string, rules: ReturnType<typeof readRewriteRules>): string {
  for (const { source, destination } of rules) {
    const m = source.match(/^(.*)\/:path\*$/);
    if (!m) {
      if (source === pathname) return destination;
      continue;
    }
    const prefix = m[1];
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      const rest = pathname.slice(prefix.length).replace(/^\//, "");
      return destination.replace(/\/:path\*$/, rest ? `/${rest}` : "");
    }
  }
  return pathname;
}

/**
 * Resolve an /api pathname against the app-router tree on disk, honouring dynamic
 * (`[x]`) and catch-all (`[...x]`) segments. Returns the route.ts path, or null.
 */
function resolveAppRoute(pathname: string): string | null {
  const segments = pathname.replace(/^\//, "").split("/").filter(Boolean);

  const walk = (dir: string, rest: string[]): string | null => {
    if (rest.length === 0) {
      const file = path.join(dir, "route.ts");
      return fs.existsSync(file) ? path.relative(ROOT, file).replace(/\\/g, "/") : null;
    }
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());

    // Exact segment wins over a dynamic one, as Next.js resolves it.
    const exact = entries.find((e) => e.name === rest[0]);
    if (exact) {
      const hit = walk(path.join(dir, exact.name), rest.slice(1));
      if (hit) return hit;
    }
    const catchAll = entries.find((e) => /^\[\.\.\..+\]$/.test(e.name));
    if (catchAll) {
      const file = path.join(dir, catchAll.name, "route.ts");
      if (fs.existsSync(file)) return path.relative(ROOT, file).replace(/\\/g, "/");
    }
    const dynamic = entries.find((e) => /^\[[^.].*\]$/.test(e.name));
    if (dynamic) return walk(path.join(dir, dynamic.name), rest.slice(1));
    return null;
  };

  return walk(path.join(ROOT, "src/app"), segments);
}

/**
 * What @google/genai composes, per js-genai src/_api_client.ts
 * (`getRequestUrlInternal` joins `{baseUrl}/{apiVersion}`, stripping one trailing
 * slash) and src/models.ts (`{model}:generateContent`). Model names are normalised
 * to the `models/<id>` resource form for the Gemini API.
 */
function composeGenAiUrl(base: string, model: string, stream = false): string {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  const action = stream ? ":streamGenerateContent?alt=sse" : ":generateContent";
  return `${trimmed}/v1beta/models/${model}${action}`;
}

// ─── The helpers ─────────────────────────────────────────────────────────────

test("toGatewayOriginUrl strips /v1 and trailing slashes; toGatewayV1Url adds /v1", () => {
  assert.equal(toGatewayOriginUrl("http://localhost:20128/v1"), GATEWAY);
  assert.equal(toGatewayOriginUrl("http://localhost:20128/v1/"), GATEWAY);
  assert.equal(toGatewayOriginUrl("http://localhost:20128/"), GATEWAY);
  assert.equal(toGatewayOriginUrl(GATEWAY), GATEWAY);
  assert.equal(toGatewayOriginUrl("https://gw.example.com/v1"), "https://gw.example.com");

  assert.equal(toGatewayV1Url(GATEWAY), `${GATEWAY}/v1`);
  assert.equal(toGatewayV1Url(`${GATEWAY}/v1`), `${GATEWAY}/v1`);
  // Trailing slash must not produce a doubled separator.
  assert.equal(toGatewayV1Url(`${GATEWAY}/`), `${GATEWAY}/v1`);

  // A path that merely contains "v1" is not a suffix and must survive.
  assert.equal(toGatewayOriginUrl("http://host/api/v1beta"), "http://host/api/v1beta");
});

// ─── The composition proof ───────────────────────────────────────────────────

test("the rewrite that carries /v1beta to the API route is present in next.config.mjs", () => {
  const rules = readRewriteRules();
  const rule = rules.find((r) => r.source === "/v1beta/:path*");
  assert.ok(
    rule,
    "next.config.mjs must rewrite /v1beta/:path* — the Gemini CLI entry depends on it"
  );
  assert.equal(rule.destination, "/api/v1beta/:path*");
});

test("origin form + what @google/genai appends resolves to the real generateContent route", () => {
  const rules = readRewriteRules();
  const origin = toGatewayOriginUrl(`${GATEWAY}/v1`);

  for (const stream of [false, true]) {
    const url = new URL(composeGenAiUrl(origin, "gemini-3-flash", stream));
    assert.equal(url.origin, GATEWAY);
    assert.equal(
      url.pathname,
      "/v1beta/models/gemini-3-flash" + (stream ? ":streamGenerateContent" : ":generateContent"),
      "the composed path must be the canonical Gemini resource path"
    );

    const rewritten = applyRewrites(url.pathname, rules);
    assert.equal(
      rewritten,
      `/api${url.pathname}`,
      "the rewrite must carry it under /api without altering the resource path"
    );

    const route = resolveAppRoute(rewritten);
    assert.equal(
      route,
      "src/app/api/v1beta/models/[...path]/route.ts",
      `composed URL ${url.href} must resolve to the Gemini route that this app serves`
    );
  }
});

test("the /v1 form misroutes into the OpenAI catch-all — the bug baseOrigin prevents", () => {
  const rules = readRewriteRules();
  const wrong = new URL(composeGenAiUrl(toGatewayV1Url(GATEWAY), "gemini-3-flash"));

  assert.equal(
    wrong.pathname,
    "/v1/v1beta/models/gemini-3-flash:generateContent",
    "handing the /v1 base to @google/genai doubles the version prefix"
  );

  const landsOn = resolveAppRoute(applyRewrites(wrong.pathname, rules));

  assert.notEqual(
    landsOn,
    "src/app/api/v1beta/models/[...path]/route.ts",
    "the doubled-prefix path must not reach the Gemini route"
  );
  // Worth stating precisely, because it is worse than a 404: the request is not
  // rejected, it is absorbed by the OpenAI-compatible catch-all under /v1, which
  // then has to make sense of a Gemini-shaped body. The user sees a confusing
  // upstream error rather than "no such endpoint".
  assert.equal(
    landsOn,
    "src/app/api/v1/[...omnirouteCatchAll]/route.ts",
    "the doubled-prefix path is swallowed by the /v1 catch-all"
  );
});

// ─── Entry-level locks ───────────────────────────────────────────────────────

test("Gemini CLI is catalogued with the origin form and the verified env var names", () => {
  const gemini = CLI_TOOLS.gemini;
  assert.ok(gemini, "gemini must be in the CLI catalog");
  assert.equal(gemini.category, "code");
  assert.equal(gemini.baseUrlSupport, "full");

  const code = gemini.codeBlock?.code ?? "";
  assert.match(code, /GOOGLE_GEMINI_BASE_URL="\{\{baseOrigin\}\}"/);
  assert.match(code, /GEMINI_API_KEY="\{\{apiKey\}\}"/);
  assert.ok(
    !code.includes("{{baseUrl}}"),
    "Gemini CLI must never be handed the /v1 form — @google/genai appends /v1beta itself"
  );
});

test("clients that append their own versioned path use {{baseOrigin}}, never {{baseUrl}}", () => {
  // Each of these was verified against the tool's own docs or source:
  //   gemini — @google/genai appends /v1beta/...
  //   goose  — appends OPENAI_BASE_PATH, default v1/chat/completions
  //   5dive  — points Claude seats at the Anthropic surface, which appends /v1/messages
  for (const id of ["gemini", "goose", "5dive"] as const) {
    const entry = CLI_TOOLS[id];
    assert.ok(entry, `${id} must be in the CLI catalog`);

    const surfaces = [
      entry.codeBlock?.code ?? "",
      ...(entry.guideSteps ?? []).map((s) => s.value ?? ""),
    ].join("\n");

    assert.ok(
      surfaces.includes("{{baseOrigin}}"),
      `${id} appends its own versioned path, so it must use {{baseOrigin}}`
    );
    assert.ok(
      !surfaces.includes("{{baseUrl}}"),
      `${id} must not be handed the /v1 form — it would produce a doubled version prefix`
    );
  }
});

test("a placeholder inside a guideStep desc needs an i18n guide key to ever be substituted", async () => {
  // DefaultToolCard runs replaceVars over codeBlock.code and step.value, but a
  // step's `desc` only goes through translateOrFallback — which returns the raw
  // fallback when no key exists. A {{...}} left in an untranslated desc therefore
  // renders literally to the user.
  const en = JSON.parse(
    fs.readFileSync(path.join(ROOT, "src/i18n/messages/en.json"), "utf8")
  ) as Record<string, unknown>;
  const guides =
    ((en.cliTools as Record<string, unknown> | undefined)?.guides as
      Record<string, { steps?: Record<string, { desc?: string }> }> | undefined) ?? {};

  const offenders: string[] = [];
  for (const [id, entry] of Object.entries(CLI_TOOLS)) {
    for (const step of entry.guideSteps ?? []) {
      if (!step.desc?.includes("{{")) continue;
      if (!guides[id]?.steps?.[String(step.step)]?.desc) {
        offenders.push(`${id} step ${step.step}: ${step.desc}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "these descs carry a {{placeholder}} that will render literally — move it to the step's `value` or the codeBlock, or add the ICU guide key"
  );
});
