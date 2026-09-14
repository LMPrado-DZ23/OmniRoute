"""Error type and error-envelope parsing shared by every SDK call."""

from __future__ import annotations

import json
import re
from datetime import timezone
from email.utils import parsedate_to_datetime
from typing import Any, Mapping, Optional

CLIENT_ERROR_CODES = {
    "network": "network_error",
    "timeout": "timeout",
    "aborted": "aborted",
    "invalid_response": "invalid_response",
    "stream_error": "stream_error",
    "stream_consumed": "stream_consumed",
}

_NUMERIC = re.compile(r"^\d+(\.\d+)?$")


class OmniRouteError(Exception):
    """The single error type raised by the SDK. ``status`` is 0 when no HTTP response arrived."""

    def __init__(
        self,
        message: str,
        *,
        status: int = 0,
        code: Optional[str] = None,
        error_type: Optional[str] = None,
        reason: Optional[str] = None,
        request_id: Optional[str] = None,
        retry_after_ms: Optional[int] = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.type = error_type
        self.reason = reason
        self.request_id = request_id
        self.retry_after_ms = retry_after_ms
        self.body = body

    def __repr__(self) -> str:
        return (
            f"OmniRouteError(status={self.status!r}, code={self.code!r}, "
            f"message={self.message!r}, request_id={self.request_id!r})"
        )


def client_error(kind: str, message: str, *, status: int = 0, request_id: Optional[str] = None) -> OmniRouteError:
    code = CLIENT_ERROR_CODES[kind]
    return OmniRouteError(message, status=status, code=code, error_type=code, request_id=request_id)


def parse_retry_after_ms(value: Optional[str], now_s: float) -> Optional[int]:
    """Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds."""
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    if _NUMERIC.match(text):
        return int(round(float(text) * 1000))
    try:
        parsed = parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError):
        return None
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return max(0, int(round((parsed.timestamp() - now_s) * 1000)))


def _optional_str(value: Any) -> Optional[str]:
    if isinstance(value, str) and value:
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return None


def error_from_body(
    status: int, body: Any, request_id: str, retry_after_ms: Optional[int] = None
) -> OmniRouteError:
    """Build an error from ``{"error": {...}}``, ``{"error": "text"}`` or the management envelope."""
    message = error_type = code = reason = None
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, str) and error:
            message = error
        elif isinstance(error, dict):
            message = _optional_str(error.get("message"))
            error_type = _optional_str(error.get("type"))
            code = _optional_str(error.get("code"))
            reason = _optional_str(error.get("reason"))
        if message is None:
            message = _optional_str(body.get("message"))
    return OmniRouteError(
        message or f"HTTP {status}",
        status=status,
        code=code,
        error_type=error_type,
        reason=reason,
        request_id=request_id,
        retry_after_ms=retry_after_ms,
        body=body,
    )


def error_from_http(
    status: int,
    text: str,
    headers: Mapping[str, str],
    client_request_id: str,
    retry_after_ms: Optional[int],
) -> OmniRouteError:
    body: Any
    try:
        body = json.loads(text) if text else None
    except ValueError:
        body = text
    body_request_id = _optional_str(body.get("requestId")) if isinstance(body, dict) else None
    request_id = headers.get("x-request-id") or body_request_id or client_request_id
    return error_from_body(status, body, request_id, retry_after_ms)
