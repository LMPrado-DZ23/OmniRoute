"use client";

/**
 * Buzz Hub page — relay URL card: draft input, "Save relay" and the ConfirmModal that
 * gates the PUT (nothing is sent until the operator confirms). The parent keys this
 * card by the server value, so a saved URL re-seeds the draft while a rejected draft
 * stays editable.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";

import { ConfirmModal } from "@/shared/components/Modal";

interface RelayUrlCardProps {
  relayUrl: string;
  saving: boolean;
  onSave: (relayUrl: string) => Promise<boolean>;
}

export function RelayUrlCard({ relayUrl, saving, onSave }: RelayUrlCardProps) {
  const t = useTranslations("buzzHub");
  const [draft, setDraft] = useState(relayUrl);
  const [confirming, setConfirming] = useState(false);
  const trimmed = draft.trim();
  const dirty = trimmed !== relayUrl;

  const confirm = async () => {
    setConfirming(false);
    await onSave(trimmed);
  };

  return (
    <div data-testid="buzz-relay-card" className="rounded-xl border border-border bg-card p-4">
      <label htmlFor="buzz-relay-url" className="text-sm font-medium text-text-primary">
        {t("relayUrlLabel")}
      </label>
      <p className="mt-0.5 text-xs text-text-muted">
        {t.rich("relayUrlHint", {
          code: (chunks) => <code className="font-mono">{chunks}</code>,
        })}
      </p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          id="buzz-relay-url"
          type="text"
          data-testid="buzz-relay-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("relayUrlPlaceholder")}
          className="flex-1 rounded-lg border border-border bg-bg-subtle px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
        />
        <button
          type="button"
          data-testid="buzz-save-relay"
          onClick={() => setConfirming(true)}
          disabled={saving || !dirty}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
        >
          {saving ? t("savingRelay") : t("saveRelay")}
        </button>
      </div>
      {confirming && (
        <div data-testid="buzz-save-relay-confirm">
          <ConfirmModal
            isOpen
            onClose={() => setConfirming(false)}
            onConfirm={() => void confirm()}
            title={t("saveRelayConfirmTitle")}
            message={
              trimmed
                ? t("saveRelayConfirmMessage", { url: trimmed })
                : t("clearRelayConfirmMessage")
            }
            confirmText={t("saveRelay")}
            variant="primary"
            loading={saving}
          />
        </div>
      )}
    </div>
  );
}
