// @vitest-environment jsdom
// Audit C M1: the `slo` settings key (alerts toggle + thresholds) had no dashboard UI and was
// only settable through PATCH /api/settings. Settings → Resilience now has an SLO card that
// loads the resolved settings (alerts OFF by default), validates the numbers against the
// API schema, and saves the full `slo` object through the existing settings API.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import SloSettingsCard from "@/app/(dashboard)/dashboard/settings/components/SloSettingsCard";
import { parseSloForm, toSloForm } from "@/app/(dashboard)/dashboard/settings/components/sloForm";
import { resolveSloSettings } from "@/lib/monitoring/sloSettings";

type Call = { url: string; method: string; body: unknown };

function stubFetch(
  settings: Record<string, unknown>,
  patch: (body: unknown) => { status: number; body: unknown } = () => ({ status: 200, body: {} })
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url, method, body });
      const r = method === "PATCH" ? patch(body) : { status: 200, body: settings };
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  return calls;
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sloForm", () => {
  it("round-trips the defaults, editing ratios as percentages", () => {
    const defaults = resolveSloSettings(undefined);
    const form = toSloForm(defaults);
    expect(form.availabilityTarget).toBe("99");
    expect(form.errorRateMax).toBe("5");
    expect(form.windowMinutes).toBe("15");
    expect(parseSloForm(form, false)).toEqual({ ok: true, value: defaults });
  });

  it("rejects out-of-range and non-integer values with the offending keys", () => {
    const form = { ...toSloForm(resolveSloSettings(undefined)) };
    form.windowMinutes = "120";
    form.availabilityTarget = "40";
    form.minSamples = "2.5";
    const result = parseSloForm(form, true);
    expect(result).toEqual({
      ok: false,
      invalid: ["availabilityTarget", "windowMinutes", "minSamples"],
    });
  });

  it("accepts decimal percentages (99.5% → 0.995)", () => {
    const form = { ...toSloForm(resolveSloSettings(undefined)), availabilityTarget: "99.5" };
    const result = parseSloForm(form, true);
    expect(result.ok && result.value.availabilityTarget).toBe(0.995);
  });
});

describe("SloSettingsCard", () => {
  it("shows alerts OFF by default and labelled threshold fields", async () => {
    stubFetch({});
    render(<SloSettingsCard />);
    await flush();
    expect(screen.getByText("Service level objectives (SLO)")).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: /send slo alerts/i }).getAttribute("aria-checked")
    ).toBe("false");
    expect(screen.getByLabelText("Evaluation window (minutes)")).toHaveProperty("value", "15");
  });

  it("enables alerts and saves the full slo object via PATCH /api/settings", async () => {
    const calls = stubFetch({ slo: { windowMinutes: 10 } });
    render(<SloSettingsCard />);
    await flush();
    fireEvent.click(screen.getByRole("switch", { name: /send slo alerts/i }));
    fireEvent.change(screen.getByLabelText("Latency p95 (ms)"), { target: { value: "20000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save SLO settings" }));
    await flush();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("/api/settings");
    expect(patch?.body).toEqual({
      slo: {
        ...resolveSloSettings({ windowMinutes: 10 }),
        alertsEnabled: true,
        latencyP95Ms: 20000,
      },
    });
    expect(screen.getByRole("status").textContent).toBe("SLO settings saved.");
  });

  it("blocks invalid input client-side and marks the field", async () => {
    const calls = stubFetch({});
    render(<SloSettingsCard />);
    await flush();
    const windowInput = screen.getByLabelText("Evaluation window (minutes)");
    fireEvent.change(windowInput, { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Save SLO settings" }));
    await flush();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(windowInput.getAttribute("aria-invalid")).toBe("true");
    expect(document.body.textContent).toContain("Enter a value between 1 and 60.");
  });

  it("renders a server validation error as readable text", async () => {
    stubFetch({}, () => ({
      status: 400,
      body: {
        error: {
          message: "Invalid request",
          details: [{ field: "slo.windowMinutes", message: "Too big" }],
        },
      },
    }));
    render(<SloSettingsCard />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Save SLO settings" }));
    await flush();
    expect(screen.getByRole("status").textContent).toBe(
      "Invalid request: slo.windowMinutes: Too big"
    );
  });
});
