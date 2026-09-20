// @vitest-environment jsdom
/**
 * Proves `{{baseOrigin}}` against the REAL substitution.
 *
 * tests/unit/cli-base-origin.test.ts proves the composition — origin + what
 * @google/genai appends resolves to the route this app serves. That is a claim
 * about the helper. This file closes the other half: that DefaultToolCard's own
 * `replaceVars` actually renders the origin form into the block the user copies.
 *
 * A placeholder that reads correctly in the source but renders a malformed base
 * URL in the copied config is precisely the failure this pair of tests exists to
 * make impossible, so nothing here reads cliTools.ts for the expected string —
 * the assertions are against the rendered DOM.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_TOOLS } from "@/shared/constants/cliTools";

// cliTools.ts calls getClaudeCodeDefaultModels() at import time, which pulls the
// whole open-sse provider registry into this jsdom worker and stalls it. Only the
// `claude` entry's default model values come from it, and nothing here asserts
// those — every entry under test is read from the real catalog.
vi.mock("@omniroute/open-sse/config/providerRegistry", () => ({
  getClaudeCodeDefaultModels: () => ({}),
}));

vi.mock("@/shared/components", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  ModelSelectModal: () => null,
}));
vi.mock("@/shared/components/ProviderIcon", () => ({ default: () => <span /> }));
vi.mock("@/shared/hooks/useTheme", () => ({ useTheme: () => ({ isDark: false }) }));

const GATEWAY = "http://localhost:20128";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // The card probes runtime status on expand; keep it from touching the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`unexpected fetch in test: ${String(input)}`);
    })
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderCard(toolId: string, baseUrl: string): Promise<string> {
  const { default: DefaultToolCard } =
    await import("@/app/(dashboard)/dashboard/cli-code/components/DefaultToolCard");
  await act(async () => {
    root.render(
      <DefaultToolCard
        toolId={toolId}
        tool={CLI_TOOLS[toolId]}
        isExpanded
        onToggle={() => {}}
        baseUrl={baseUrl}
        apiKeys={[{ id: "k1", name: "test", key: "sk-omniroute-test" }]}
        activeProviders={[]}
        cloudEnabled={false}
      />
    );
  });
  return container.textContent ?? "";
}

describe("DefaultToolCard renders the origin form for clients that append their own path", () => {
  it("substitutes {{baseOrigin}} as the gateway origin, with no /v1", async () => {
    const text = await renderCard("gemini", `${GATEWAY}/v1`);

    expect(text).toContain(`GOOGLE_GEMINI_BASE_URL="${GATEWAY}"`);
    // The whole point: the rendered value must not carry /v1, or @google/genai
    // would compose /v1/v1beta/... and the request would miss the Gemini route.
    expect(text).not.toContain(`${GATEWAY}/v1"`);
    expect(text).not.toContain("{{baseOrigin}}");
    expect(text).not.toContain("{{baseUrl}}");
  });

  it("gives the same origin whether the configured base already carries /v1 or not", async () => {
    for (const configured of [GATEWAY, `${GATEWAY}/v1`, `${GATEWAY}/v1/`, `${GATEWAY}/`]) {
      const text = await renderCard("gemini", configured);
      expect(text, `base ${configured} must still render the bare origin`).toContain(
        `GOOGLE_GEMINI_BASE_URL="${GATEWAY}"`
      );
      // No doubled slash, no stray suffix.
      expect(text).not.toContain(`${GATEWAY}//`);
    }
  });

  it("still renders the /v1 form for an OpenAI-compatible entry", async () => {
    // Guards the other direction: adding baseOrigin must not have changed
    // {{baseUrl}}, which the majority of entries rely on.
    const text = await renderCard("aider", GATEWAY);
    expect(text).toContain(`${GATEWAY}/v1`);
    expect(text).not.toContain("{{baseUrl}}");
  });

  it("renders the origin form for goose, whose OPENAI_HOST is a host not a base", async () => {
    const text = await renderCard("goose", `${GATEWAY}/v1`);
    expect(text).toContain(`OPENAI_HOST: "${GATEWAY}"`);
    expect(text).toContain('OPENAI_BASE_PATH: "v1/chat/completions"');
    expect(text).not.toContain(`OPENAI_HOST: "${GATEWAY}/v1"`);
  });

  it("leaves no unsubstituted placeholder in any rendered guide entry", async () => {
    const guideEntries = Object.entries(CLI_TOOLS)
      .filter(([, t]) => t.configType === "guide" && t.baseUrlSupport !== "none")
      .map(([id]) => id);

    expect(guideEntries.length).toBeGreaterThan(5);

    for (const id of guideEntries) {
      const text = await renderCard(id, `${GATEWAY}/v1`);
      expect(text, `${id} rendered an unsubstituted placeholder`).not.toMatch(/\{\{\w+\}\}/);
    }
  });
});
