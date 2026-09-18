// @vitest-environment jsdom
// Final-audit follow-up (settings a11y): on /dashboard/settings/general axe reported
// `label` (critical, retention/optimization/aggregation number inputs) and `select-name`
// (critical, auto-vacuum / scheduled-vacuum / granularity selects) because the visible
// captions were sibling <label>s not associated with their controls. Each control is now
// nested in its <label>, so every field has an accessible name from its caption.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import SystemStorageTab from "@/app/(dashboard)/dashboard/settings/components/SystemStorageTab";

const DATABASE_SETTINGS = {
  logs: { detailedLogsEnabled: true, callLogPipelineEnabled: false },
  backup: { autoBackupEnabled: false, autoBackupFrequency: "never", keepLastNBackups: 3 },
  cache: { semanticCacheEnabled: true },
  retention: {
    quotaSnapshots: 90,
    compressionAnalytics: 30,
    mcpAudit: 30,
    a2aEvents: 30,
    callLogs: 90,
    usageHistory: 365,
    memoryEntries: 180,
    xpAuditLog: 30,
    autoCleanupEnabled: true,
  },
  aggregation: { enabled: false, rawDataRetentionDays: 7, granularity: "daily" },
  optimization: {
    autoVacuumMode: "INCREMENTAL",
    scheduledVacuum: "weekly",
    vacuumHour: 2,
    pageSize: 4096,
    cacheSize: 16384,
    optimizeOnStartup: true,
  },
  location: { databasePath: "D:\data\storage.sqlite", dataDir: "D:\data" },
  stats: {
    databaseSizeBytes: 1024,
    pageCount: 1,
    freelistCount: 0,
    lastVacuumAt: null,
    lastOptimizationAt: null,
    integrityCheck: "ok",
  },
};

function jsonResponse(data: unknown, ok = true) {
  return new Response(JSON.stringify(data), {
    status: ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

function requestPath(input: RequestInfo | URL) {
  return typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (requestPath(input) === "/api/settings/database") return jsonResponse(DATABASE_SETTINGS);
      return jsonResponse({ error: "not in this test" }, false);
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderLoaded() {
  const view = render(<SystemStorageTab />);
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return view;
}

describe("SystemStorageTab — every settings control has an accessible name", () => {
  it("names each number input and select by its visible caption", async () => {
    const { container } = await renderLoaded();
    const controls = Array.from(
      container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        'input[type="number"], select'
      )
    );
    // 8 retention + vacuum hour, page size, cache size + raw retention + 3 selects
    expect(controls.length).toBeGreaterThanOrEqual(15);
    const unnamed = controls.filter((el) => {
      const labels = Array.from(el.labels ?? []);
      const labelText = labels.map((l) => l.textContent?.trim() ?? "").join("");
      return !labelText && !el.getAttribute("aria-label");
    });
    expect(unnamed.map((el) => el.outerHTML.slice(0, 80))).toEqual([]);
  });

  it("the auto-vacuum select is reachable by its label", async () => {
    await renderLoaded();
    const select = screen
      .getAllByRole("combobox")
      .find((el) => el.closest("label")?.textContent?.toLowerCase().includes("vacuum"));
    expect(select).toBeTruthy();
  });

  it("the 'integrity OK' text uses an AA shade in the light theme", async () => {
    const { container } = await renderLoaded();
    const ok = Array.from(container.querySelectorAll("span")).find((s) =>
      s.className.includes("text-green-700")
    );
    expect(ok).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/class="text-green-500"/);
  });
});
