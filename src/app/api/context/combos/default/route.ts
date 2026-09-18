import { NextResponse } from "next/server";
import { deriveDefaultPlan } from "@omniroute/open-sse/services/compression/deriveDefaultPlan";
import { getCompressionSettings } from "@/lib/db/compression";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import { buildDeprecationHeaders, type DeprecationPolicy } from "@/lib/api/deprecationHeaders";

// The default compression pipeline is no longer editable here. It is DERIVED from the
// per-engine toggle map (see open-sse deriveDefaultPlan). This route is a read-only shim:
//   - GET  → returns the derived default plan for the live config.
//   - PUT/POST → rejected with a deprecation error (edit engines via /api/settings/compression).
const DEPRECATION_STATUS = 410;
const DEPRECATION_MESSAGE =
  "The default compression pipeline is now derived from the engines map. " +
  "Edit engines at /api/settings/compression.";

// PUT/POST became read-only in release v3.8.32 (2026-06-21). The sunset date must match
// `x-sunset` on both operations in docs/openapi.yaml (docs/architecture/API_GOVERNANCE.md).
const WRITE_DEPRECATION: DeprecationPolicy = {
  deprecatedAt: new Date("2026-06-21T00:00:00Z"),
  sunsetAt: new Date("2026-12-31T00:00:00Z"),
  infoUrl: "/docs/architecture/api_governance",
};

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const config = await getCompressionSettings();
  const plan = deriveDefaultPlan(config.engines ?? {}, config.enabled !== false);

  // Shape kept compatible with prior consumers: `pipeline` is the ordered list of
  // { engine, intensity? } steps, plus the effective `mode`.
  return NextResponse.json({
    mode: plan.mode,
    pipeline: plan.stackedPipeline,
    derived: true,
  });
}

function deprecationResponse() {
  return NextResponse.json(buildErrorBody(DEPRECATION_STATUS, DEPRECATION_MESSAGE), {
    status: DEPRECATION_STATUS,
    headers: buildDeprecationHeaders(WRITE_DEPRECATION),
  });
}

export async function PUT(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return deprecationResponse();
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return deprecationResponse();
}
