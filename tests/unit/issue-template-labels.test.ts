/**
 * Audit C L8 — issue forms may only apply labels that exist in the repository. GitHub drops
 * unknown labels silently, so `regression` / `compatibility` / `provider` / `test` /
 * `coverage` never reached triage filters. REPOSITORY_LABELS is the label set of
 * LMPrado-DZ23/OmniRoute on 2026-09-18 (`gh label list`); creating a label is repository
 * configuration, so add it here in the same change that starts using it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";

const REPOSITORY_LABELS = new Set([
  "accessibility",
  "bug",
  "documentation",
  "duplicate",
  "enhancement",
  "good first issue",
  "help wanted",
  "invalid",
  "question",
  "wontfix",
]);

const dir = path.join(process.cwd(), ".github", "ISSUE_TEMPLATE");
const forms = fs.readdirSync(dir).filter((f) => f.endsWith(".yml") && f !== "config.yml");

type FormField = { id?: unknown; validations?: { required?: unknown } };

function readForm(file: string): { labels: unknown; body: FormField[] } {
  const doc: unknown = load(fs.readFileSync(path.join(dir, file), "utf8"));
  assert.ok(doc && typeof doc === "object", `${file} is not a YAML mapping`);
  const labels = "labels" in doc ? doc.labels : undefined;
  const body = "body" in doc && Array.isArray(doc.body) ? doc.body : [];
  return { labels, body };
}

describe("issue forms", () => {
  for (const file of forms) {
    it(`${file} only uses existing repository labels`, () => {
      const { labels } = readForm(file);
      if (labels === undefined) return;
      assert.ok(Array.isArray(labels), "labels must be a list");
      for (const label of labels) {
        assert.ok(REPOSITORY_LABELS.has(String(label)), `unknown label "${label}" in ${file}`);
      }
    });
  }

  for (const file of ["regression.yml", "compatibility.yml"]) {
    it(`${file} does not force provider/model for non-provider problems`, () => {
      const { body } = readForm(file);
      for (const id of ["provider", "model"]) {
        const field = body.find((b) => b.id === id);
        assert.ok(field, `${id} field present`);
        assert.equal(field.validations?.required, false);
      }
    });
  }
});
