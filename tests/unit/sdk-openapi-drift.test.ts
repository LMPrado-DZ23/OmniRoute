/**
 * Keeps both SDKs bound to docs/openapi.yaml: every operation the TypeScript SDK issues, every
 * operation declared by the Python SDK, and every request in the shared contract fixtures must be
 * a documented OpenAPI operation. The two SDKs must also declare the same operation table.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { load } from "js-yaml";

import { OPERATIONS } from "../../sdk/typescript/src/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PYTHON_CLIENT = join(ROOT, "sdk", "python", "omniroute_sdk", "client.py");
const FIXTURES_DIR = join(ROOT, "sdk", "contract", "fixtures");
const SDK_DOC = join(ROOT, "docs", "reference", "SDKS.md");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const spec: unknown = load(readFileSync(join(ROOT, "docs", "openapi.yaml"), "utf8"));

function isDocumented(method: string, path: string): boolean {
  if (!isRecord(spec) || !isRecord(spec.paths)) return false;
  const pathItem = spec.paths[path];
  return isRecord(pathItem) && isRecord(pathItem[method.toLowerCase()]);
}

function readPythonOperations(): Map<string, { method: string; path: string }> {
  const source = readFileSync(PYTHON_CLIENT, "utf8");
  const operations = new Map<string, { method: string; path: string }>();
  const entry = /"(\w+)":\s*\(\s*"(GET|POST|PUT|PATCH|DELETE)",\s*"([^"]+)"/g;
  for (const match of source.matchAll(entry)) {
    const [, name, method, path] = match;
    if (name && method && path) operations.set(name, { method, path });
  }
  return operations;
}

describe("SDK ↔ OpenAPI drift", () => {
  it("the spec parses and exposes paths", () => {
    assert.ok(isRecord(spec) && isRecord(spec.paths), "docs/openapi.yaml must have paths");
  });

  for (const [name, operation] of Object.entries(OPERATIONS)) {
    it(`TypeScript ${name} (${operation.method} ${operation.path}) is documented`, () => {
      assert.ok(
        isDocumented(operation.method, operation.path),
        `${operation.method} ${operation.path} is not an operation in docs/openapi.yaml`
      );
    });
  }

  it("the Python SDK declares exactly the TypeScript operation table", () => {
    const python = readPythonOperations();
    const typescript = new Map(
      Object.entries(OPERATIONS).map(([name, op]) => [name, { method: op.method, path: op.path }])
    );
    assert.deepEqual(Object.fromEntries(python), Object.fromEntries(typescript));
    for (const [name, op] of python) {
      assert.ok(isDocumented(op.method, op.path), `python ${name} is not documented`);
    }
  });

  it("every contract fixture request is a documented operation", () => {
    let checked = 0;
    for (const file of readdirSync(FIXTURES_DIR).filter((name) => name.endsWith(".json"))) {
      const document: unknown = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8"));
      assert.ok(isRecord(document) && Array.isArray(document.cases), `${file}: cases`);
      for (const testCase of document.cases) {
        assert.ok(
          isRecord(testCase) && Array.isArray(testCase.expectedRequests),
          `${file}: case shape`
        );
        for (const request of testCase.expectedRequests) {
          assert.ok(isRecord(request), `${file}: request shape`);
          const { method, path } = request;
          assert.ok(typeof method === "string" && typeof path === "string", `${file}: method/path`);
          assert.ok(isDocumented(method, path), `${file}: ${method} ${path} is not documented`);
          checked++;
        }
      }
    }
    assert.ok(checked > 0, "no fixture requests found");
  });

  it("docs/reference/SDKS.md names every SDK endpoint", () => {
    const doc = readFileSync(SDK_DOC, "utf8");
    for (const operation of Object.values(OPERATIONS)) {
      assert.ok(doc.includes(operation.path), `SDKS.md does not mention ${operation.path}`);
    }
  });
});
