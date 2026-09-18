// @vitest-environment jsdom
import React, { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(dashboard)/dashboard/media-providers/components/LlmChatCard", () => ({
  LlmChatCard: () => <div>chat surface</div>,
}));
vi.mock("@/app/(dashboard)/dashboard/providers/hooks/useApiKey", () => ({
  useApiKey: () => ({ keys: [{ id: "k1", key: "key-one", name: "Primary" }] }),
}));
vi.mock("@/app/(dashboard)/dashboard/providers/hooks/useProviderModels", () => ({
  useProviderModels: () => ({ models: [{ id: "model-a" }, { id: "model-b" }] }),
}));
vi.mock("@/shared/components/ProviderIcon", () => ({ default: () => null }));

const { default: ProviderTestSlideOver } =
  await import("@/shared/components/ProviderTestSlideOver");

function Harness({ initialTab }: { initialTab?: "test" | "logs" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open test drawer
      </button>
      <ProviderTestSlideOver
        isOpen={open}
        onClose={() => setOpen(false)}
        providerId="acme"
        provider={{ name: "Acme", apiType: "openai" }}
        initialTab={initialTab}
      />
    </>
  );
}

async function openDrawer(initialTab?: "test" | "logs") {
  const user = userEvent.setup();
  render(<Harness initialTab={initialTab} />);
  const opener = screen.getByRole("button", { name: "Open test drawer" });
  await user.click(opener);
  return { user, opener, dialog: screen.getByRole("dialog", { name: "Test Acme" }) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ProviderTestSlideOver a11y contract", () => {
  it("is a modal dialog with an accessible name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {}))
    );
    const { dialog } = await openDrawer();

    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("names its model and key selects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {}))
    );
    const { dialog } = await openDrawer();

    expect(within(dialog).getByRole("combobox", { name: "Model" })).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "Key" })).toBeInTheDocument();
  });

  it("moves focus inside, traps Tab, closes on Escape and restores focus to the opener", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {}))
    );
    const { user, opener, dialog } = await openDrawer();

    const close = within(dialog).getByRole("button", { name: "Close" });
    await waitFor(() => expect(close).toHaveFocus());

    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab();
    expect(close).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("hides decorative glyphs from assistive technology", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {}))
    );
    const { dialog } = await openDrawer();

    for (const glyph of dialog.querySelectorAll(".material-symbols-outlined")) {
      expect(glyph).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("announces the logs loading state and a load failure", async () => {
    let failRequest: (error: Error) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            failRequest = reject;
          })
      )
    );
    const { dialog } = await openDrawer("logs");

    expect(within(dialog).getByRole("status")).toHaveTextContent("Loading logs…");

    failRequest(new Error("HTTP 500"));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load logs");
  });
});
