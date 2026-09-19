// @vitest-environment jsdom
// Audit NEW-MEDIUM-3: `/login` probed `GET /api/settings/require-login` behind a 5 s
// AbortController and, on abort or any non-OK answer, assumed `hasPassword = true;
// setupComplete = true`. On a genuinely fresh install that endpoint is slow on its very
// first call (one-time database bootstrap: schema + every pending migration, plus route
// compilation in dev — the auditor measured 44.7 s, then 0.1 s), so a brand-new user was
// dropped on a sign-in form for a password that does not exist yet, with no way forward
// short of reloading.
//
// Contract asserted here: while the answer is unknown the page stays in its announced
// loading state, and if the probe genuinely fails it explains itself and offers a retry —
// it never renders a password prompt nobody can submit.
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { default: LoginPage } = await import("@/app/login/page");

const FRESH_INSTALL = {
  requireLogin: true,
  hasPassword: false,
  setupComplete: false,
  oidcEnabled: false,
  oidcDisablePasswordLogin: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function stubFetch(handler: (url: string) => Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => handler(String(input)))
  );
}

/**
 * A server that never answers, but honours the caller's AbortController the way
 * `fetch` does — so a too-short abort budget surfaces as a rejected promise.
 */
function stubNeverAnsweringFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
        })
    )
  );
}

async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
});

describe("/login first-run probe", () => {
  it("keeps the announced loading state while a slow require-login is still in flight", async () => {
    vi.useFakeTimers();
    stubNeverAnsweringFetch();
    render(<LoginPage />);

    // Well past the old 5 s abort, and past a naive 10 s one too.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });

    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("explains the failure and offers a retry instead of a dead password prompt", async () => {
    stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    render(<LoginPage />);
    await flush();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Setup check did not finish");
    expect(alert.textContent).toContain("try again");

    // The defect being guarded: no usable-looking sign-in form while the answer is unknown.
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("does not present a password prompt when the server answers non-OK", async () => {
    stubFetch(async () => jsonResponse({ error: "boom" }, 500));
    render(<LoginPage />);
    await flush();

    expect(await screen.findByRole("alert")).toHaveTextContent("Setup check did not finish");
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("recovers through the retry button once the server is warm — no page reload needed", async () => {
    let warm = false;
    stubFetch(async () => {
      if (!warm) throw new Error("ECONNREFUSED");
      return jsonResponse(FRESH_INSTALL);
    });
    render(<LoginPage />);
    await flush();

    const retry = await screen.findByRole("button", { name: "Try again" });
    warm = true;
    await act(async () => {
      fireEvent.click(retry);
    });
    await flush();

    // A fresh install must land on the wizard entry point, not on a sign-in form.
    expect(screen.getByRole("button", { name: "Start Onboarding" })).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });
});
