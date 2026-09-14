"""Server-Sent Events decoding for OpenAI-compatible streams."""

from __future__ import annotations

from typing import Iterable, Iterator, List

DONE_SENTINEL = "[DONE]"


def iter_sse_data(lines: Iterable[bytes]) -> Iterator[str]:
    """Yield the data payload of each SSE event until ``[DONE]`` or the end of input.

    ``lines`` is any iterable of raw lines (an ``http.client.HTTPResponse`` iterates by line).
    Comment lines and data-less events are skipped; multi-line data is joined with newlines.
    """
    data_lines: List[str] = []
    for raw in lines:
        line = raw.decode("utf-8").rstrip("\r\n")
        if line == "":
            if data_lines:
                data = "\n".join(data_lines)
                data_lines = []
                if data == DONE_SENTINEL:
                    return
                yield data
            continue
        if line.startswith("data:"):
            value = line[5:]
            data_lines.append(value[1:] if value.startswith(" ") else value)
    if data_lines:
        data = "\n".join(data_lines)
        if data != DONE_SENTINEL:
            yield data
