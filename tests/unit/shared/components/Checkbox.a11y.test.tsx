// @vitest-environment jsdom
import React, { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import Checkbox from "@/shared/components/Checkbox";

function ControlledCheckbox() {
  const [checked, setChecked] = useState(false);
  return (
    <Checkbox
      label="Enable cache"
      checked={checked}
      onChange={(event) => setChecked(event.target.checked)}
    />
  );
}

describe("Checkbox a11y contract", () => {
  it("explicitly associates the visible label with the native checkbox when no id is passed", () => {
    render(<Checkbox label="Enable cache" />);

    const box = screen.getByRole("checkbox", { name: "Enable cache" });
    const label = screen.getByText("Enable cache").closest("label");

    expect(box.id).not.toBe("");
    expect(label?.htmlFor).toBe(box.id);
  });

  it("keeps a caller-provided id for the label association", () => {
    render(<Checkbox id="cache-toggle" label="Enable cache" />);

    const box = screen.getByRole("checkbox", { name: "Enable cache" });
    expect(box.id).toBe("cache-toggle");
    expect(screen.getByText("Enable cache").closest("label")?.htmlFor).toBe("cache-toggle");
  });

  it("uses aria-label as the accessible name when rendered without a visible label", () => {
    render(<Checkbox aria-label="Select row 1" />);

    expect(screen.getByRole("checkbox", { name: "Select row 1" })).toBeInTheDocument();
  });

  it("is reachable with Tab and toggles its checked state with Space", async () => {
    const user = userEvent.setup();
    render(<ControlledCheckbox />);
    const box = screen.getByRole("checkbox", { name: "Enable cache" });

    await user.tab();
    expect(box).toHaveFocus();
    expect(box).not.toBeChecked();

    await user.keyboard(" ");
    expect(box).toBeChecked();
  });

  it("toggles when the label text is clicked", async () => {
    const user = userEvent.setup();
    render(<ControlledCheckbox />);

    await user.click(screen.getByText("Enable cache"));
    expect(screen.getByRole("checkbox", { name: "Enable cache" })).toBeChecked();
  });
});
