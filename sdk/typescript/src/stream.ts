import type { AttemptController } from "./attempt.ts";
import {
  CLIENT_ERROR_CODES,
  OmniRouteError,
  abortedError,
  errorFromBody,
  invalidResponseError,
  isRecord,
  parseJson,
} from "./errors.ts";
import { parseSseData } from "./sse.ts";
import type { ChatCompletionChunk } from "./types.ts";

export interface ChatCompletionStreamInit {
  body: ReadableStream<Uint8Array>;
  status: number;
  headers: Headers;
  requestId: string;
  clientRequestId: string;
  attempt: AttemptController;
}

/**
 * An established chat completion stream. Iterate it once with `for await`; call `abort()`
 * to stop early. Errors after the first byte are never retried: a failure mid-stream
 * surfaces as an `OmniRouteError` (an `error` event, `stream_error`, or `aborted`).
 */
export class ChatCompletionStream implements AsyncIterable<ChatCompletionChunk> {
  readonly status: number;
  readonly headers: Headers;
  readonly requestId: string;
  readonly clientRequestId: string;
  readonly #body: ReadableStream<Uint8Array>;
  readonly #attempt: AttemptController;
  #consumed = false;

  constructor(init: ChatCompletionStreamInit) {
    this.status = init.status;
    this.headers = init.headers;
    this.requestId = init.requestId;
    this.clientRequestId = init.clientRequestId;
    this.#body = init.body;
    this.#attempt = init.attempt;
  }

  abort(): void {
    this.#attempt.abort();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ChatCompletionChunk, void, undefined> {
    if (this.#consumed) {
      throw new OmniRouteError({
        status: this.status,
        code: CLIENT_ERROR_CODES.streamConsumed,
        type: CLIENT_ERROR_CODES.streamConsumed,
        message: "This stream has already been consumed",
        requestId: this.requestId,
      });
    }
    this.#consumed = true;
    const signal = this.#attempt.signal;
    try {
      for await (const data of parseSseData(this.#body, signal)) {
        const parsed = parseJson(data);
        if (!parsed.ok || !isRecord(parsed.value)) {
          throw invalidResponseError(this.status, this.requestId, "Stream event is not a JSON object");
        }
        if (parsed.value.error !== undefined) {
          throw errorFromBody(this.status, parsed.value, this.requestId);
        }
        // Response boundary: the chunk shape is defined by docs/openapi.yaml; unknown fields pass through.
        yield parsed.value as ChatCompletionChunk;
      }
      if (signal.aborted) throw abortedError(this.requestId);
    } catch (cause) {
      if (cause instanceof OmniRouteError) throw cause;
      if (signal.aborted) throw abortedError(this.requestId, cause);
      throw new OmniRouteError({
        status: this.status,
        code: CLIENT_ERROR_CODES.streamError,
        type: CLIENT_ERROR_CODES.streamError,
        message: "The stream was interrupted before completion",
        requestId: this.requestId,
        cause,
      });
    } finally {
      this.#attempt.dispose();
    }
  }
}
