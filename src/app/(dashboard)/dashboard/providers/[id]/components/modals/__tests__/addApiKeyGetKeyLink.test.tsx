// @vitest-environment jsdom
//
// "Add API key" shortcut to where the key actually comes from.
//
// Before this, an API-key provider's Add-connection dialog showed no link at
// all: the user was asked for a credential with no hint of where to obtain it,
// and had to leave and search for the provider's console. The dialog now links
// straight to the provider's API-key page when the catalog has one
// (`notice.apiKeyUrl`) and otherwise to the provider's site (`website`) — with
// copy that says which of the two it is, so a homepage is never dressed up as a
// key page.
//
// Every URL comes from the curated provider catalog; none is composed here. The
// https-only guard is the one thing the catalog cannot vouch for at runtime, so
// it is asserted against injected catalog entries.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AddApiKeyModal from "../AddApiKeyModal";

/**
 * Catalog entries the shipped catalog cannot supply: a provider with no link at
 * all, and providers whose curated URL is not https. Every other id falls
 * through to the real catalog, so the rendering tests assert against shipped
 * data rather than fixtures.
 */
const { INJECTED_ENTRIES } = vi.hoisted(() => ({
  INJECTED_ENTRIES: {
    "fixture-no-link": { id: "fixture-no-link", name: "Fixture No Link", color: "#000000" },
    "fixture-http-site": {
      id: "fixture-http-site",
      name: "Fixture Http Site",
      color: "#000000",
      website: "http://insecure.example.com",
    },
    "fixture-javascript-key": {
      id: "fixture-javascript-key",
      name: "Fixture Javascript Key",
      color: "#000000",
      website: "https://safe.example.com",
      notice: { apiKeyUrl: "javascript:alert(document.cookie)" },
    },
  } as Record<string, Record<string, unknown>>,
}));

vi.mock("@/lib/providers/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/catalog")>();
  return {
    ...actual,
    resolveStaticProviderCatalogEntry: (providerId: string) =>
      INJECTED_ENTRIES[providerId] ?? actual.resolveStaticProviderCatalogEntry(providerId),
  };
});

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "openai" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next-intl", () => ({
  useTranslations: (ns?: string) => (k: string) => (ns ? `${ns}.${k}` : k),
}));

const cleanups: Array<() => void> = [];

function renderModal(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

function renderAddModal(provider: string, providerName: string) {
  return renderModal(
    <AddApiKeyModal
      isOpen={true}
      provider={provider}
      providerName={providerName}
      isCompatible={false}
      onSave={vi.fn().mockResolvedValue(undefined)}
      onClose={vi.fn()}
    />
  );
}

function keySourceLink(container: HTMLElement): HTMLAnchorElement | null {
  return container.querySelector<HTMLAnchorElement>('[data-testid="provider-key-source-link"]');
}

/** Accessible name from contents: what a screen reader announces, decorative nodes dropped. */
function accessibleName(element: HTMLElement): string {
  const explicit = element.getAttribute("aria-label");
  if (explicit) return explicit.trim();
  const clone = element.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll("[aria-hidden='true']")) hidden.remove();
  return clone.textContent?.trim() ?? "";
}

describe("AddApiKeyModal — where does this key come from?", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: true, json: async () => ({}), text: async () => "" } as Response)
      )
    );
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    });
  });

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("links straight to the API-key page when the catalog has one", () => {
    // `together` carries notice.apiKeyUrl — the exact page that mints the key.
    const link = keySourceLink(renderAddModal("together", "Together AI"));
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://api.together.ai/settings/api-keys");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("falls back to the provider site, and says so, when there is no key page", () => {
    // `360ai` has only `website` — the copy must promise a site, not a key page.
    const link = keySourceLink(renderAddModal("360ai", "360 AI"));
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://ai.360.cn");
    expect(accessibleName(link as HTMLAnchorElement)).toBe("Open ai.360.cn to find your API key");
  });

  it("names the destination for screen readers and stays keyboard reachable", () => {
    const link = keySourceLink(renderAddModal("together", "Together AI"));
    // The accessible name says where the link goes; the icon is decorative.
    expect(accessibleName(link as HTMLAnchorElement)).toBe("Get your API key at api.together.ai");
    expect(link?.querySelector("[aria-hidden='true']")).not.toBeNull();
    // A real anchor with an href is in the tab order without a tabindex override.
    expect(link?.tagName).toBe("A");
    expect(link?.hasAttribute("tabindex")).toBe(false);
  });

  it("renders no link when the provider has neither a key page nor a site", () => {
    expect(keySourceLink(renderAddModal("fixture-no-link", "Fixture No Link"))).toBeNull();
  });

  it("refuses a non-https site URL", () => {
    expect(keySourceLink(renderAddModal("fixture-http-site", "Fixture Http Site"))).toBeNull();
  });

  it("refuses a javascript: key URL", () => {
    const container = renderAddModal("fixture-javascript-key", "Fixture Javascript Key");
    expect(keySourceLink(container)).toBeNull();
  });
});
