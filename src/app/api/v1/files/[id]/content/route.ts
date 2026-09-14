import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { getFile, getFileContent } from "@/lib/db/files";
import { NextResponse } from "next/server";
import { getApiKeyRequestScope } from "@/app/api/v1/_helpers/apiKeyScope";

export async function OPTIONS() {
  return handleCorsOptions();
}

function isArrayBufferBacked(buffer: Buffer): buffer is Buffer<ArrayBuffer> {
  return buffer.buffer instanceof ArrayBuffer;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const scope = await getApiKeyRequestScope(request);
  if (scope.rejection) return scope.rejection;
  const apiKeyId = scope.apiKeyId;

  const { id } = await params;
  const file = getFile(id);

  if (!file || (file.apiKeyId !== null && file.apiKeyId !== apiKeyId && !scope.isSessionAuth)) {
    return NextResponse.json(
      { error: { message: "File not found", type: "invalid_request_error" } },
      { status: 404, headers: CORS_HEADERS }
    );
  }

  const content = getFileContent(id);
  if (!content) {
    return NextResponse.json(
      { error: { message: "File content not found", type: "invalid_request_error" } },
      { status: 404, headers: CORS_HEADERS }
    );
  }

  const sanitizedFilename = file.filename.replace(/[^\w.\-()\[\] ]/g, "_").slice(0, 255);
  const encodedFilename = encodeURIComponent(file.filename);

  const body = isArrayBufferBacked(content) ? content : new Uint8Array(content);
  return new Response(body, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": file.mimeType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${sanitizedFilename}"; filename*=UTF-8''${encodedFilename}`,
    },
  });
}
