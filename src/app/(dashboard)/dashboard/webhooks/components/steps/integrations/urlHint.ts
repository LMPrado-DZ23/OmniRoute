/** Result of the live `/api/webhooks/validate-url` check shown under a webhook URL field. */
export type UrlState = "idle" | "checking" | "ok" | "blocked" | "invalid";

/**
 * Message key for the URL check hint (shared by the Slack, Discord and Custom forms), or null
 * when nothing should be shown. "invalid" is only reported once the user has typed something.
 */
export function urlHintKey(state: UrlState, hasValue: boolean): string | null {
  if (state === "checking") return "validateUrl.checking";
  if (state === "ok") return "validateUrl.ok";
  if (state === "blocked") return "validateUrl.blockedPrivate";
  return state === "invalid" && hasValue ? "validateUrl.invalidUrl" : null;
}
