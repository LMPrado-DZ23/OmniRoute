// @vitest-environment jsdom
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

// The layout's own drawer contract is under test; its children are replaced by minimal
// stand-ins (the mobile Sidebar instance is the one rendered with an onClose prop).
vi.mock("@/shared/components/Sidebar", () => ({
  default: ({ onClose }: { onClose?: () => void }) => (
    <nav data-sidebar-instance={onClose ? "mobile" : "desktop"}>
      <input aria-label="Filter navigation" />
      <button type="button" onClick={onClose}>
        Close menu
      </button>
    </nav>
  ),
}));
vi.mock("@/shared/components/Header", () => ({
  default: ({ onMenuClick }: { onMenuClick: () => void }) => (
    <button type="button" onClick={onMenuClick}>
      Open menu
    </button>
  ),
}));
vi.mock("@/shared/components/NotificationToast", () => ({ default: () => null }));
vi.mock("@/shared/components/CommandPalette", () => ({ default: () => null }));
vi.mock("@/shared/components/NavigationProgress", () => ({ default: () => null }));
vi.mock("@/shared/components/MaintenanceBanner", () => ({ default: () => null }));
vi.mock("@/shared/components/Breadcrumbs", () => ({ default: () => null }));
vi.mock("@/shared/hooks/useElectron", () => ({ useIsElectron: () => false }));
vi.mock("@/shared/utils/dashboardCsrf", () => ({
  installDashboardCsrfFetch: () => () => {},
  prefetchDashboardCsrfToken: async () => {},
}));
vi.mock("@/shared/utils/basePathFetch", () => ({
  installBasePathFetch: () => () => {},
}));

const { default: DashboardLayout } = await import("@/shared/components/layouts/DashboardLayout");

function mobileDrawer(): HTMLElement {
  const nav = document.querySelector('[data-sidebar-instance="mobile"]');
  if (!nav?.parentElement) throw new Error("mobile sidebar drawer not rendered");
  return nav.parentElement;
}

async function renderLayout() {
  const user = userEvent.setup();
  await act(async () => {
    render(
      <DashboardLayout>
        <p>Page body</p>
      </DashboardLayout>
    );
  });
  return { user, menuButton: screen.getByRole("button", { name: "Open menu" }) };
}

describe("DashboardLayout mobile drawer a11y contract", () => {
  it("keeps the closed off-canvas drawer out of the tab order and accessibility tree", async () => {
    await renderLayout();

    const drawer = mobileDrawer();
    expect(drawer).toHaveAttribute("inert");
    expect(drawer).not.toHaveAttribute("role", "dialog");
  });

  it("opens as a named modal dialog and moves focus inside", async () => {
    const { user, menuButton } = await renderLayout();

    await user.click(menuButton);

    const dialog = screen.getByRole("dialog", { name: "mainNavigation" });
    expect(dialog).toBe(mobileDrawer());
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).not.toHaveAttribute("inert");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it("traps Tab inside the open drawer", async () => {
    const { user, menuButton } = await renderLayout();
    await user.click(menuButton);
    const dialog = screen.getByRole("dialog", { name: "mainNavigation" });
    const filter = screen
      .getAllByRole("textbox", { name: "Filter navigation" })
      .find((el) => dialog.contains(el));
    const close = screen
      .getAllByRole("button", { name: "Close menu" })
      .find((el) => dialog.contains(el));
    // Let the deferred initial focus land first so it cannot race the manual focus below.
    await waitFor(() => expect(filter).toHaveFocus());

    close!.focus();
    await user.tab();
    expect(filter).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
  });

  it("closes on Escape and returns focus to the menu button", async () => {
    const { user, menuButton } = await renderLayout();
    await user.click(menuButton);
    expect(screen.getByRole("dialog", { name: "mainNavigation" })).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mobileDrawer()).toHaveAttribute("inert");
    expect(menuButton).toHaveFocus();
  });

  it("still closes when the backdrop is clicked", async () => {
    const { user, menuButton } = await renderLayout();
    await user.click(menuButton);

    const backdrop = document.querySelector<HTMLElement>(".fixed.inset-0.bg-black\\/20");
    expect(backdrop).not.toBeNull();
    expect(backdrop).toHaveAttribute("aria-hidden", "true");
    await user.click(backdrop!);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
