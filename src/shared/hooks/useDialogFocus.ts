"use client";

import { useEffect, type RefObject } from "react";

// Disabled controls cannot receive focus, so leaving them in the list made the trap
// "wrap" onto an element that silently refused focus and let Tab escape the dialog.
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

const INITIAL_FOCUS_DELAY_MS = 50;

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

function trapTabKey(dialog: HTMLElement, event: KeyboardEvent) {
  if (event.key !== "Tab") return;
  const focusable = getFocusableElements(dialog);
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Keyboard contract shared by every modal surface (centered Modal, slide-over drawer):
 *  - Escape closes;
 *  - the first focusable control receives focus when the dialog opens;
 *  - Tab / Shift+Tab stay inside the dialog;
 *  - focus returns to the opener on close (only if the opener is still in the DOM).
 */
export function useDialogFocus(
  dialogRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
  onClose: () => void
) {
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  // Declared before the focus effect so the opener is captured before focus moves.
  useEffect(() => {
    if (!isOpen) return;
    const activeElement = document.activeElement;
    const opener = activeElement instanceof HTMLElement ? activeElement : null;
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!isOpen || !dialog) return;

    const firstFocusable = getFocusableElements(dialog)[0];
    const focusTimer = firstFocusable
      ? window.setTimeout(() => firstFocusable.focus(), INITIAL_FOCUS_DELAY_MS)
      : undefined;
    const handleTab = (event: KeyboardEvent) => trapTabKey(dialog, event);

    dialog.addEventListener("keydown", handleTab);
    return () => {
      if (focusTimer !== undefined) window.clearTimeout(focusTimer);
      dialog.removeEventListener("keydown", handleTab);
    };
  }, [isOpen, dialogRef]);
}
