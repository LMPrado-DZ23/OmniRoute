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
