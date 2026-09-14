// @vitest-environment jsdom
import React, { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import SidebarSectionHeader from "@/shared/components/SidebarSectionHeader";

function Harness() {
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState(false);
  return (
    <SidebarSectionHeader
      title="Routing"
      isExpanded={expanded}
      isPinned={pinned}
      pinLabel={pinned ? "Unpin section" : "Pin section open"}
      onToggle={() => setExpanded((value) => !value)}
      onTogglePin={() => setPinned((value) => !value)}
    />
  );
}

describe("SidebarSectionHeader a11y contract", () => {
  it("renders the expand and pin controls as sibling buttons (no nested interactive content)", () => {
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "Routing" });
    const pin = screen.getByRole("button", { name: "Pin section open" });

    expect(toggle.contains(pin)).toBe(false);
    expect(pin.contains(toggle)).toBe(false);
    expect(toggle.querySelector("button, [role='button']")).toBeNull();
  });

  it("exposes the expanded state and toggles it from the keyboard", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "Routing" });

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("reaches the pin control with Tab and exposes its pressed state without toggling the section", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "Routing" });

    await user.tab();
    await user.tab();
    const pin = screen.getByRole("button", { name: "Pin section open" });
    expect(pin).toHaveFocus();
    expect(pin).toHaveAttribute("aria-pressed", "false");

    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Unpin section" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("hides the decorative glyphs from assistive technology", () => {
    const { container } = render(<Harness />);

    for (const glyph of container.querySelectorAll(".material-symbols-outlined")) {
      expect(glyph).toHaveAttribute("aria-hidden", "true");
    }
  });
});
