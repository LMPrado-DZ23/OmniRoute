// @vitest-environment jsdom
// Audit NEW-MEDIUM-2: SlackConfigForm/DiscordConfigForm/TelegramConfigForm render
// `t(`<kind>.tutorialStep${n}`)`, but `tutorialStep*` existed in NO locale catalog — not
// even en.json. next-intl falls back to the key path, so the "How to create a Slack
// webhook" tutorial displayed literal `webhooks.slack.tutorialStep1` … to the user, in
// every language, plus one `IntlError: MISSING_MESSAGE` per step.
//
// This test uses a REAL next-intl translator with next-intl's own default fallback (the
// dotted key path), so a missing key surfaces exactly as it did in the product.
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createTranslator } from "use-intl/core";
import { SlackConfigForm } from "../components/steps/integrations/SlackConfigForm";
import { DiscordConfigForm } from "../components/steps/integrations/DiscordConfigForm";
import { TelegramConfigForm } from "../components/steps/integrations/TelegramConfigForm";

/** A next-intl fallback looks like `webhooks.slack.tutorialStep1`. */
const RAW_KEY_RE = /^[a-z]+(\.[a-zA-Z0-9]+)+$/;

const MESSAGES_DIR = path.resolve(process.cwd(), "src/i18n/messages");

/** Steps rendered per integration — must track the loops in the three forms. */
const TUTORIAL_STEPS: Record<string, number> = { slack: 4, discord: 3, telegram: 4 };

function loadCatalog(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, `${locale}.json`), "utf8"));
}

function translatorFor(locale: string) {
  // No `getMessageFallback` override: next-intl's default renders the dotted key path,
  // which is precisely the defect this test guards against.
  return createTranslator({
    locale,
    messages: loadCatalog(locale) as Parameters<typeof createTranslator>[0]["messages"],
    namespace: "webhooks",
    onError: () => {},
  });
}

function textNodesOf(root: HTMLElement): string[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: string[] = [];
  let node = walker.nextNode();
  while (node) {
    const text = (node.textContent ?? "").trim();
    if (text) out.push(text);
    node = walker.nextNode();
  }
  return out;
}

afterEach(() => {
  cleanup();
});

describe("webhook wizard integration tutorials", () => {
  for (const locale of ["en", "pt-BR", "vi"]) {
    it(`renders no raw i18n key anywhere in the ${locale} integration forms`, () => {
      const t = translatorFor(locale);
      const noop = () => {};

      const { container } = render(
        <div>
          <SlackConfigForm value={{ webhookUrl: "" }} onChange={noop} t={t} />
          <DiscordConfigForm value={{ webhookUrl: "" }} onChange={noop} t={t} />
          <TelegramConfigForm value={{ botToken: "", chatId: "" }} onChange={noop} t={t} />
        </div>
      );

      const raw = textNodesOf(container).filter((text) => RAW_KEY_RE.test(text));
      expect(raw, `raw i18n keys rendered in ${locale}`).toEqual([]);
    });
  }

  it("every locale catalog carries the tutorial steps the forms request", () => {
    const gaps: string[] = [];
    for (const file of fs.readdirSync(MESSAGES_DIR).filter((f) => f.endsWith(".json"))) {
      const catalog = loadCatalog(file.replace(/\.json$/, ""));
      const webhooks = catalog.webhooks as Record<string, Record<string, string>> | undefined;
      for (const [kind, steps] of Object.entries(TUTORIAL_STEPS)) {
        for (let n = 1; n <= steps; n += 1) {
          const value = webhooks?.[kind]?.[`tutorialStep${n}`];
          if (typeof value !== "string" || !value.trim() || /__(MISSING|TODO)__/i.test(value)) {
            gaps.push(`${file}: webhooks.${kind}.tutorialStep${n}`);
          }
        }
      }
    }
    expect(gaps, "locales missing webhook tutorial copy").toEqual([]);
  });
});
