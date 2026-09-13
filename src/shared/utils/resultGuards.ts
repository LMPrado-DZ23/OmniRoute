import type { IpcFailure } from "../../../electron/types";

/**
 * Type guards for `{ ok: true, ... } | { ok: false, ... }` result unions.
 *
 * The API and dashboard typecheck projects run with `strictNullChecks: false`. Without
 * that flag TypeScript does not narrow a union on a boolean literal discriminant, so
 * `if (!result.ok) result.error` fails with TS2339 even though the runtime check is
 * correct. A type predicate narrows under both settings, which is why the open-sse
 * executors already declare local `result is Extract<T, { ok: false }>` guards.
 * This is the shared form of that guard.
 */
export function isOkFailure<T extends { ok: boolean }>(
  result: T
): result is Extract<T, { ok: false }> {
  return result.ok === false;
}

/**
 * Same guard for `{ success: true, ... } | { success: false, ... }` unions, such as
 * `ValidatedJsonBodyResult` from `@/shared/validation/helpers` or
 * `ObsidianSyncEnableResult`. `ValidationResult` keeps its own `isValidationFailure`.
 */
export function isSuccessFailure<T extends { success: boolean }>(
  result: T
): result is Extract<T, { success: false }> {
  return result.success === false;
}

/**
 * Guard for an Electron invoke result that is either the requested value (a path, a boolean)
 * or the `IpcFailure` a privileged channel resolves to when the main process refuses a remote
 * sender (electron/lib/ipcOriginGuard.js). Truthiness cannot tell them apart: the failure is an
 * object, so it is truthy.
 */
export function isIpcFailure(value: unknown): value is IpcFailure {
  return (
    typeof value === "object" && value !== null && "success" in value && value.success === false
  );
}
