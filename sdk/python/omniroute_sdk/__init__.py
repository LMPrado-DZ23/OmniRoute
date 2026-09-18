"""Experimental, unpublished OmniRoute client. Standard library only (Python >= 3.9)."""

from ._sse import DONE_SENTINEL, iter_sse_data
from .client import (
    DEFAULT_BASE_URL,
    DEFAULT_TIMEOUT_MS,
    OPERATIONS,
    REQUEST_ID_HEADER,
    ApiResponse,
    ChatCompletionStream,
    OmniRouteClient,
    RetryConfig,
    redact_headers,
)
from .errors import CLIENT_ERROR_CODES, OmniRouteError, parse_retry_after_ms

__version__ = "0.0.0"

__all__ = [
    "CLIENT_ERROR_CODES",
    "DEFAULT_BASE_URL",
    "DEFAULT_TIMEOUT_MS",
    "DONE_SENTINEL",
    "OPERATIONS",
    "REQUEST_ID_HEADER",
    "ApiResponse",
    "ChatCompletionStream",
    "OmniRouteClient",
    "OmniRouteError",
    "RetryConfig",
    "iter_sse_data",
    "parse_retry_after_ms",
    "redact_headers",
]
