// @vitest-environment jsdom
/**
 * CompatibleModelsSection renders a PassthroughModelRow for each OpenAI/Anthropic-compatible model,
 * and each row carries a ModelCompatPopover whose param-filter editor loads and saves
 * `/api/providers/<providerId>/param-filters`. The section never passed the provider id down (the
 * row's `provider` prop was missing), so for compatible providers the popover called
 * `/api/providers/undefined/param-filters`: model-level parameter filters could not be loaded or
 * saved. The request must target the provider id the section was rendered for.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CompatibleModelsSection from "../../../src/app/(dashboard)/dashboard/providers/[id]/components/CompatibleModelsSection";

const PROVIDER_ID = "openai-compatible-acme";

let container: HTMLDivElement;
let root: Root;

async function flushEffects(rounds = 40) {
  await act(async () => {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  });
}

describe("CompatibleModelsSection param filter provider", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("loads param filters for the provider the section belongs to", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return {
          ok: true,
          json: async () => ({ block: [], allow: [], models: {}, autoLearn: false }),
        } as Response;
      })
    );

    const noopAsync = vi.fn(async () => {});
    await act(async () => {
      root.render(
        <CompatibleModelsSection
          {...({ providerId: PROVIDER_ID } as Record<string, unknown>)}
          providerStorageAlias="acme-compat"
          providerDisplayAlias="acme"
          modelAliases={{}}
          customModels={[{ id: "model-x" }]}
          fallbackModels={[]}
          allowImport={false}
          description=""
          inputLabel=""
          inputPlaceholder=""
          onCopy={vi.fn()}
          onSetAlias={noopAsync}
          onDeleteAlias={vi.fn()}
          connections={[]}
          onImportWithProgress={noopAsync}
          t={(key: string) => key}
          effectiveModelNormalize={() => false}
          effectiveModelPreserveDeveloper={() => false}
          getUpstreamHeadersRecord={() => ({})}
          saveModelCompatFlags={noopAsync}
          isModelHidden={() => false}
          onToggleHidden={noopAsync}
          onBulkToggleHidden={noopAsync}
        />
      );
    });
    await flushEffects();

    const trigger = container.querySelector(
      'button[title="compatAdjustmentsTitle"]'
    ) as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    await act(async () => trigger!.click());
    await flushEffects();

    const paramFilterUrls = urls.filter((url) => url.includes("/param-filters"));
    expect(paramFilterUrls.length).toBeGreaterThan(0);
    expect(
      paramFilterUrls.every((url) => url === `/api/providers/${PROVIDER_ID}/param-filters`)
    ).toBe(true);
  });
});
