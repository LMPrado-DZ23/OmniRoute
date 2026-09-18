// @vitest-environment jsdom
import React, { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import Toggle from "@/shared/components/Toggle";

function ControlledToggle(props: { label?: string; description?: string; ariaLabel?: string }) {
  const [checked, setChecked] = useState(false);
  return <Toggle {...props} checked={checked} onChange={setChecked} />;
}

describe("Toggle a11y contract", () => {
  it("exposes role=switch with aria-checked reflecting the state", async () => {
    const user = userEvent.setup();
    render(<ControlledToggle label="Auto retry" />);
    const toggle = screen.getByRole("switch", { name: "Auto retry" });

    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("is keyboard operable with Space and Enter", async () => {
    const user = userEvent.setup();
    render(<ControlledToggle label="Auto retry" />);
    const toggle = screen.getByRole("switch", { name: "Auto retry" });

    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("names the switch from its visible label and announces the description", () => {
    render(<ControlledToggle label="Auto retry" description="Retry failed requests once" />);
    const toggle = screen.getByRole("switch", { name: "Auto retry" });

    expect(toggle).toHaveAccessibleDescription("Retry failed requests once");
  });

  it("keeps an explicit ariaLabel as the name and still announces the description", () => {
    render(
      <ControlledToggle
        ariaLabel="Enable provider Acme"
        label="Enabled"
        description="Routes traffic to Acme"
      />
    );
    const toggle = screen.getByRole("switch", { name: "Enable provider Acme" });

    expect(toggle).toHaveAccessibleDescription("Routes traffic to Acme");
  });

  it("falls back to the description as the name when there is no label", () => {
    render(<ControlledToggle description="Compact mode" />);

    expect(screen.getByRole("switch", { name: "Compact mode" })).not.toHaveAttribute(
      "aria-describedby"
    );
  });

  it("does not change state while disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle label="Locked" checked={false} onChange={onChange} disabled />);
    const toggle = screen.getByRole("switch", { name: "Locked" });

    expect(toggle).toBeDisabled();
    await user.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });
});
