// @vitest-environment jsdom
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import Modal from "@/shared/components/Modal";

function renderModal(onClose = vi.fn()) {
  render(
    <Modal
      isOpen
      onClose={onClose}
      title="Edit connection"
      footer={
        <>
          <button type="button">Save</button>
          <button type="button" disabled>
            Delete
          </button>
        </>
      }
    >
      <input aria-label="Connection name" />
    </Modal>
  );
  return onClose;
}

describe("Modal a11y contract", () => {
  it("is a modal dialog named by its title", () => {
    renderModal();
    const dialog = screen.getByRole("dialog", { name: "Edit connection" });

    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("gives the icon-only close button an accessible name and hides its glyph", () => {
    renderModal();
    const close = screen.getByRole("button", { name: "Close" });

    expect(close.querySelector(".material-symbols-outlined")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
  });

  it("moves focus into the dialog when it opens", async () => {
    renderModal();
    const dialog = screen.getByRole("dialog");

    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it("wraps Tab from the last enabled control back to the first, skipping disabled ones", async () => {
    const user = userEvent.setup();
    renderModal();
    const save = screen.getByRole("button", { name: "Save" });
    const close = screen.getByRole("button", { name: "Close" });
    // Let the deferred initial focus land first so it cannot race the manual focus below.
    await waitFor(() => expect(close).toHaveFocus());

    save.focus();
    await user.tab();
    expect(close).toHaveFocus();

    await user.tab({ shift: true });
    expect(save).toHaveFocus();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = renderModal();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
