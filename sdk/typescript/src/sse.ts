/** Server-Sent Events decoding for OpenAI-compatible streams. */

export const DONE_SENTINEL = "[DONE]";

const EVENT_BOUNDARY = /\r\n\r\n|\n\n|\r\r/;
const LINE_BREAK = /\r\n|\n|\r/;

/** Joins the `data:` lines of one raw SSE event. Returns null when the event carries no data. */
export function extractEventData(rawEvent: string): string | null {
  const data: string[] = [];
  for (const line of rawEvent.split(LINE_BREAK)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return data.length > 0 ? data.join("\n") : null;
}

/**
 * Yields the data payload of every SSE event until `[DONE]`, the end of the body,
 * or the signal aborts. Comment lines (`: keep-alive`) and data-less events are skipped.
 * The reader is always cancelled on exit so the underlying connection is released.
 */
export async function* parseSseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const onAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let match = EVENT_BOUNDARY.exec(buffer); match; match = EVENT_BOUNDARY.exec(buffer)) {
        const rawEvent = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = extractEventData(rawEvent);
        if (data === DONE_SENTINEL) return;
        if (data !== null) yield data;
      }
    }
    if (signal?.aborted) return;
    buffer += decoder.decode();
    const trailing = extractEventData(buffer);
    if (trailing !== null && trailing !== DONE_SENTINEL) yield trailing;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
