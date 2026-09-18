// @vitest-environment jsdom
// Audit C follow-up (axe on the webhook wizard, isolated dev server): the maintenance banner
// message used `text-amber-200` in both themes — light amber on the light theme's pale amber
// tint fails WCAG AA (axe color-contrast, serious). Light theme now uses amber-800; the dark
// theme keeps amber-200.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import MaintenanceBanner from "@/shared/components/MaintenanceBanner";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("MaintenanceBanner", () => {
  it("renders its message with an AA-contrast light-theme shade", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 }))
    );
    render(<MaintenanceBanner />);
    // Two failed checks (immediate + after 10 s) are required before the banner shows.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_500);
    });
    const message = screen.getByText(/server/i);
    expect(message.className).toContain("text-amber-800");
    expect(message.className).toContain("dark:text-amber-200");
    expect(message.className).not.toMatch(/(^|\s)text-amber-200(\s|$)/);
  });
});
