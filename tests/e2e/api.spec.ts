import { test, expect } from "@playwright/test";

test.describe("API Health Checks", () => {
  test("GET /api/monitoring/health returns OK", async ({ request }) => {
    const res = await request.get("/api/monitoring/health");
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as any;
    expect(body).toHaveProperty("status");
  });

  test("GET /api/v1/models returns model list or requires auth", async ({ request }) => {
    const res = await request.get("/api/v1/models");
    // Since #9320 the catalog requires auth whenever management auth is configured
    // (unless `requireAuthForModels` is explicitly false). The E2E harness boots with
    // INITIAL_PASSWORD set, so 401 is the correct, deliberate answer here — not a
    // failure. The shape assertion still runs whenever the catalog IS served, which
    // is what keeps this from degrading into a mere reachability check.
    if (res.ok()) {
      const body = (await res.json()) as any;
      expect(body).toHaveProperty("data");
      expect(Array.isArray(body.data)).toBe(true);
    } else {
      expect([401, 403, 307]).toContain(res.status());
      if (res.status() === 401) {
        // Positive anchor: it must be an auth gate answering, not some unrelated 401 from a
        // misrouted request. Either the catalog's own gate (`type: invalid_api_key`) or the client-API
        // authz policy in front of it (`code: AUTH_002`): since REQUIRE_API_KEY=false stopped meaning
        // "any caller", an anonymous /v1 request whose peer cannot be proven local — this harness
        // runs plain `next dev`, which stamps no peer — is refused by the policy first.
        const body = (await res.json()) as { error?: { type?: string; code?: string } };
        expect(String(body.error?.type ?? body.error?.code)).toMatch(/^(invalid_api_key|AUTH_002)$/);
      }
    }
  });

  test("GET /api/providers returns provider list or requires auth", async ({ request }) => {
    const res = await request.get("/api/providers");
    // In CI with auth enabled, 401 is acceptable — endpoint is reachable
    if (res.ok()) {
      const body = (await res.json()) as any;
      expect(body).toHaveProperty("connections");
      expect(Array.isArray(body.connections)).toBe(true);
    } else {
      expect([401, 403, 307]).toContain(res.status());
    }
  });
});
