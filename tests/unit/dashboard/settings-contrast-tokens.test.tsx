// @vitest-environment jsdom
// Audit C L5 / settings color-contrast: on /dashboard/settings/general axe reported two
// `serious` color-contrast nodes in the light theme — the storage-driver Badge
// (success variant, green-600 on its 10% tint: 2.9:1) and the "Reset usage data"
// Button (danger variant, white on red-500: 3.8:1). The shared variants now use
// darker shades that clear WCAG AA 4.5:1 (green-800 on the tint 6.5:1, white on
// red-600 4.8:1); dark-theme overrides are unchanged.
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";

afterEach(() => cleanup());

describe("settings contrast — shared variants", () => {
  it("success Badge uses an AA-contrast light text shade", () => {
    render(<Badge variant="success">sqlite</Badge>);
    const badge = screen.getByText("sqlite");
    expect(badge.className).toContain("text-green-800");
    expect(badge.className).not.toMatch(/(^|\s)text-green-600(\s|$)/);
    expect(badge.className).toContain("dark:text-green-400");
  });

  it("danger Button uses an AA-contrast background for white text", () => {
    render(<Button variant="danger">Reset usage data</Button>);
    const button = screen.getByRole("button", { name: "Reset usage data" });
    expect(button.className).toContain("bg-red-600");
    expect(button.className).not.toMatch(/(^|\s)bg-red-500(\s|$)/);
    expect(button.className).toContain("text-white");
  });
});
