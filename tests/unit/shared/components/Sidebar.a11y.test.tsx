// @vitest-environment jsdom
import React from "react";
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Skip CloudSyncStatus (polls /api/sync/cloud and needs a router), as the search test does.
process.env.NEXT_PUBLIC_OMNIROUTE_E2E_MODE = "1";

vi.mock("next-intl", () => ({
  useTranslations: () => {
    const translate = (key: string) => key;
    translate.has = () => false;
    return translate;
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
}));

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select, textarea";

async function renderSidebar(props: { collapsed?: boolean } = {}) {
  const { default: Sidebar } = await import("@/shared/components/Sidebar");
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(<Sidebar onToggleCollapse={() => {}} {...props} />);
  });
  return view!;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response)
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Sidebar a11y contract", () => {
  it("never places a focusable control inside an aria-hidden subtree", async () => {
    const { container } = await renderSidebar();

    const hiddenFocusables = [...container.querySelectorAll('[aria-hidden="true"]')].flatMap(
      (hidden) => [...hidden.querySelectorAll(FOCUSABLE)]
    );
    expect(hiddenFocusables).toHaveLength(0);
    expect(screen.getByRole("button", { name: "collapseSidebar" })).toBeInTheDocument();
  });

  it("renders collapsible section headers as real buttons without nested interactive content", async () => {
    const { container } = await renderSidebar();

    expect(container.querySelector('[role="button"] button')).toBeNull();
    const nav = screen.getByRole("navigation", { name: "mainNavigation" });
    const headers = within(nav)
      .getAllByRole("button")
      .filter((button) => button.hasAttribute("aria-expanded"));
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) {
      expect(header.tagName).toBe("BUTTON");
      expect(header.querySelector("button")).toBeNull();
    }
  });

  it("names icon-only navigation links and footer actions by label, not by glyph ligature", async () => {
    const { container } = await renderSidebar({ collapsed: true });

    for (const glyph of container.querySelectorAll("nav .material-symbols-outlined")) {
      expect(glyph).toHaveAttribute("aria-hidden", "true");
    }
    const nav = screen.getByRole("navigation", { name: "mainNavigation" });
    for (const link of within(nav).getAllByRole("link")) {
      expect(link).toHaveAccessibleName();
      expect(link.getAttribute("aria-label")).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "restart" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "shutdown" })).toBeInTheDocument();
  });
});
