// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { default: LoginPage } = await import("@/app/login/page");

type FetchHandler = (url: string) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const REQUIRE_LOGIN = {
  requireLogin: true,
  hasPassword: true,
  setupComplete: true,
  oidcEnabled: false,
  oidcDisablePasswordLogin: false,
};

function stubFetch(handler: FetchHandler) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => handler(String(input)))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Login page a11y contract", () => {
  it("announces the initial loading state", () => {
    stubFetch(() => new Promise<Response>(() => {}));
    render(<LoginPage />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading");
  });

  it("associates the visible password label with the password input", async () => {
    stubFetch(async () => jsonResponse(REQUIRE_LOGIN));
    render(<LoginPage />);

    const input = await screen.findByLabelText("Password");
    expect(input).toHaveAttribute("type", "password");
  });

  it("announces a failed sign-in through an alert", async () => {
    const user = userEvent.setup();
    stubFetch(async (url) =>
      url.includes("/api/auth/login")
        ? jsonResponse({ error: "Invalid password" }, 401)
        : jsonResponse(REQUIRE_LOGIN)
    );
    render(<LoginPage />);

    const input = await screen.findByLabelText("Password");
    await user.type(input, "wrong-password{Enter}");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Invalid password");
  });

  it("hides decorative glyphs from assistive technology", async () => {
    stubFetch(async () => jsonResponse(REQUIRE_LOGIN));
    const { container } = render(<LoginPage />);
    await screen.findByLabelText("Password");

    for (const glyph of container.querySelectorAll(".material-symbols-outlined")) {
      expect(glyph).toHaveAttribute("aria-hidden", "true");
    }
  });
});
