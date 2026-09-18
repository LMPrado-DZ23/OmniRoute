"use client";

interface PayloadPreviewProps {
  payload: Record<string, unknown> | null;
  label?: string;
}

export function PayloadPreview({ payload, label }: PayloadPreviewProps) {
  if (!payload) return null;
  return (
    <div className="space-y-1">
      {label && (
        <p className="text-xs font-medium uppercase tracking-wider text-text-muted">{label}</p>
      )}
      {/* tabIndex: a horizontally scrollable region must be keyboard-reachable (axe). */}
      <pre
        tabIndex={0}
        className="overflow-x-auto rounded-lg bg-sidebar p-3 text-xs text-text-main"
      >
        {JSON.stringify(payload, null, 2)}
      </pre>
    </div>
  );
}
