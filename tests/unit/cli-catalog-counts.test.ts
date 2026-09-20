/**
 * F1: cli-catalog-counts.test.ts
 * Assert catalog cardinality per plan 14 D15 / §3.1-§3.2.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { CLI_TOOLS } = await import("../../src/shared/constants/cliTools.ts");
const { EXPECTED_CODE_COUNT, EXPECTED_AGENT_COUNT } =
  await import("../../src/shared/schemas/cliCatalog.ts");

const all = Object.values(CLI_TOOLS);
const codeAll = all.filter((t) => t.category === "code");
const agentAll = all.filter((t) => t.category === "agent");
const codeVisible = codeAll.filter((t) => t.baseUrlSupport !== "none");

test(`CLI_TOOLS has exactly ${EXPECTED_CODE_COUNT} code entries with baseUrlSupport !== 'none'`, () => {
  assert.equal(
    codeVisible.length,
    EXPECTED_CODE_COUNT,
    `Expected ${EXPECTED_CODE_COUNT} visible code entries, got ${codeVisible.length}: ${codeVisible.map((t) => t.id).join(", ")}`
  );
});

test(`CLI_TOOLS has exactly ${EXPECTED_AGENT_COUNT} agent entries`, () => {
  assert.equal(
    agentAll.length,
    EXPECTED_AGENT_COUNT,
    `Expected ${EXPECTED_AGENT_COUNT} agent entries, got ${agentAll.length}: ${agentAll.map((t) => t.id).join(", ")}`
  );
});

test("CLI_TOOLS total code entries (including none) equals 31 (26 visible + 5 none)", () => {
  // code-none entries: antigravity, kiro, cursor (app), hermes, and zcode.
  const codeNone = codeAll.filter((t) => t.baseUrlSupport === "none");
  assert.equal(
    codeNone.length,
    5,
    `Expected 5 code entries with baseUrlSupport='none', got ${codeNone.length}: ${codeNone.map((t) => t.id).join(", ")}`
  );
  assert.equal(codeAll.length, 31, `Expected 31 total code entries, got ${codeAll.length}`);
});

test("CLI_TOOLS total (code + agent) = 47", () => {
  assert.equal(all.length, 47, `Expected 47 total entries, got ${all.length}`);
});

test("All code-none entries have configType mitm OR are legacy excluded entries", () => {
  const codeNone = codeAll.filter((t) => t.baseUrlSupport === "none");
  const allowedIds = new Set(["antigravity", "kiro", "cursor", "hermes", "zcode"]);
  for (const entry of codeNone) {
    assert.ok(
      allowedIds.has(entry.id),
      `Unexpected code entry with baseUrlSupport='none': ${entry.id}`
    );
  }
});

test("All agent entries have baseUrlSupport 'full' or 'partial' (no agent is 'none')", () => {
  for (const entry of agentAll) {
    assert.notEqual(
      entry.baseUrlSupport,
      "none",
      `Agent entry '${entry.id}' has unexpected baseUrlSupport='none'`
    );
  }
});

test("The 26 visible code entries include Qwen Code's rebuilt integration", () => {
  const d15List = new Set([
    "claude",
    "codex",
    "cline",
    "kilo",
    "roo",
    "continue",
    "aider",
    "forge",
    "jcode",
    "deepseek-tui",
    "codewhale",
    "opencode",
    "droid",
    "copilot",
    "cursor-cli",
    "smelt",
    "pi",
    "custom",
    "crush",
    "grok-build",
    "qwen",
    // cliToolsExtra.ts — verified custom-base-URL terminal assistants
    "aichat",
    "shell-gpt",
    "mods",
    "llm",
    "fabric",
  ]);
  const visibleIds = new Set(codeVisible.map((t) => t.id));
  for (const id of d15List) {
    assert.ok(visibleIds.has(id), `D15 entry '${id}' not found in visible code list`);
  }
  for (const id of visibleIds) {
    assert.ok(d15List.has(id), `Visible code entry '${id}' not in D15 list`);
  }
});

test("The 16 agent entries match D15 list exactly (+ omp + letta #6318, + prime-agent #11166, + 5dive #11578, + 6 from cliToolsExtra.ts)", () => {
  const d15Agents = new Set([
    "hermes-agent",
    "openclaw",
    "goose",
    "interpreter",
    "warp",
    "agent-deck",
    "omp",
    "letta",
    "prime-agent",
    "5dive",
    // cliToolsExtra.ts — verified custom-base-URL autonomous agents
    "openhands",
    "plandex",
    "gptme",
    "trae",
    "octofriend",
    "raaid",
  ]);
  const agentIds = new Set(agentAll.map((t) => t.id));
  for (const id of d15Agents) {
    assert.ok(agentIds.has(id), `D15 agent '${id}' not found in agent entries`);
  }
  for (const id of agentIds) {
    assert.ok(d15Agents.has(id), `Agent entry '${id}' not in D15 agent list`);
  }
});

// ─── Entry integrity ─────────────────────────────────────────────────────────
// A half-filled entry renders a blank card instead of failing, so assert the
// fields the CLI cards actually read. Added with the cliToolsExtra.ts batch.

test("every CLI_TOOLS entry satisfies the published catalog schema", async () => {
  const { CliCatalogSchema } = await import("../../src/shared/schemas/cliCatalog.ts");
  const result = CliCatalogSchema.safeParse(CLI_TOOLS);
  assert.ok(
    result.success,
    `CLI_TOOLS failed schema validation: ${result.success ? "" : JSON.stringify(result.error.issues, null, 2)}`
  );
});

test("every CLI_TOOLS entry carries the fields the cards render", () => {
  for (const [key, entry] of Object.entries(CLI_TOOLS)) {
    assert.equal(entry.id, key, `CLI_TOOLS["${key}"] must have id "${key}", got "${entry.id}"`);
    assert.ok(entry.name.trim(), `${key}: name must not be blank`);
    assert.ok(entry.description.trim(), `${key}: description must not be blank`);
    assert.ok(entry.vendor.trim(), `${key}: vendor must not be blank`);
    assert.ok(entry.docsUrl.trim(), `${key}: docsUrl must not be blank`);
    assert.ok(
      /^(https:\/\/|\/)/.test(entry.docsUrl),
      `${key}: docsUrl must be an https URL or an in-app path, got "${entry.docsUrl}"`
    );
    // A logo is optional — DefaultToolCard.renderIcon falls back to
    // <ProviderIcon providerId={toolId} /> (this is how zcode renders). But a
    // declared asset path must not be blank, or the slot renders empty.
    for (const field of ["image", "imageLight", "imageDark", "icon"] as const) {
      const value = entry[field];
      if (value !== undefined) {
        assert.ok(value.trim(), `${key}: ${field} is declared but blank`);
      }
    }
  }
});

test("guide entries give the user a real guide, and templates use known placeholders", () => {
  const KNOWN_PLACEHOLDERS = new Set(["baseUrl", "apiKey", "model"]);

  for (const [key, entry] of Object.entries(CLI_TOOLS)) {
    if (entry.configType === "guide") {
      assert.ok(
        entry.guideSteps && entry.guideSteps.length > 0,
        `${key}: configType "guide" requires at least one guideStep`
      );
      for (const step of entry.guideSteps ?? []) {
        assert.ok(step.title.trim(), `${key}: guideStep ${step.step} must have a non-blank title`);
        assert.ok(
          step.desc?.trim() || step.value?.trim() || step.type,
          `${key}: guideStep ${step.step} ("${step.title}") renders nothing — needs desc, value, or type`
        );
      }
    }

    // DefaultToolCard.replaceVars only substitutes {{baseUrl}}, {{apiKey}} and
    // {{model}}. Anything else would be copied to the user's shell verbatim.
    const templated = [
      entry.codeBlock?.code ?? "",
      ...(entry.guideSteps ?? []).flatMap((s) => [s.value ?? "", s.desc ?? ""]),
    ].join("\n");
    for (const match of templated.matchAll(/\{\{(\w+)\}\}/g)) {
      assert.ok(
        KNOWN_PLACEHOLDERS.has(match[1]),
        `${key}: unknown placeholder {{${match[1]}}} — DefaultToolCard only substitutes ${[...KNOWN_PLACEHOLDERS].join(", ")}`
      );
    }
  }
});

test("catalog ids, names and colors are unique and well-formed", () => {
  const names = new Map<string, string>();
  for (const [key, entry] of Object.entries(CLI_TOOLS)) {
    assert.match(entry.color, /^#[0-9A-Fa-f]{6}$/, `${key}: color must be #RRGGBB`);
    const previous = names.get(entry.name.toLowerCase());
    assert.equal(
      previous,
      undefined,
      `${key}: display name "${entry.name}" already used by "${previous}"`
    );
    names.set(entry.name.toLowerCase(), key);
  }
});

test("a placeholder inside a guideStep desc needs an i18n guide key to be substituted", async () => {
  // DefaultToolCard runs replaceVars over codeBlock.code and step.value, but a
  // step's `desc` only goes through translateOrFallback, which returns the raw
  // fallback when no key exists. A {{...}} left in an untranslated desc renders
  // literally to the user. Only a few guides carry ICU keys today.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const en = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "src/i18n/messages/en.json"), "utf8")
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
