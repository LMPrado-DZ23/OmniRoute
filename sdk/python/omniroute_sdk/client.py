"""OmniRoute HTTP client built on the standard library (urllib)."""

from __future__ import annotations

import http.client
import json
import socket
import time
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlsplit
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Tuple, Union

from ._sse import iter_sse_data
from .errors import OmniRouteError, client_error, error_from_body, error_from_http, parse_retry_after_ms

DEFAULT_BASE_URL = "http://localhost:20128"
DEFAULT_TIMEOUT_MS = 60_000
REQUEST_ID_HEADER = "x-request-id"

#: name -> (method, path, auth). Identical to OPERATIONS in the TypeScript SDK and asserted
#: against docs/openapi.yaml by tests/unit/sdk-openapi-drift.test.ts.
OPERATIONS: Dict[str, Tuple[str, str, str]] = {
    "chatCompletions": ("POST", "/api/v1/chat/completions", "api_key"),
    "listModels": ("GET", "/api/v1/models", "api_key"),
    "health": ("GET", "/api/health", "none"),
    "quota": ("GET", "/api/v1/me/status", "api_key"),
    "routePreview": ("POST", "/api/omniroute/route/preview", "management"),
}

_SENSITIVE_HEADERS = frozenset({"authorization", "x-api-key", "cookie", "proxy-authorization"})
_NETWORK_ERRORS = (OSError, http.client.HTTPException)


def redact_headers(headers: Mapping[str, str]) -> Dict[str, str]:
    """Copy of ``headers`` with credentials replaced by ``[REDACTED]``."""
    return {k: ("[REDACTED]" if k.lower() in _SENSITIVE_HEADERS else v) for k, v in headers.items()}


def _origin(url: str) -> Tuple[str, str, Optional[int]]:
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    return scheme, (parts.hostname or "").lower(), parts.port or {"http": 80, "https": 443}.get(scheme)


class _CredentialSafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Follows redirects like urllib, but never forwards credentials to another origin.

    The stock handler copies every header (``Authorization`` included) to any redirect target.
    Here an ``https`` -> ``http`` downgrade is refused (raised as the redirect's own HTTP error)
    and a change of scheme, host or port drops every credential-bearing header.
    """

    def redirect_request(self, req: urllib.request.Request, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Optional[urllib.request.Request]:
        source, target = _origin(req.full_url), _origin(newurl)
        if source[0] == "https" and target[0] != "https":
            raise urllib.error.HTTPError(req.full_url, code, "Refusing a redirect from https to a non-https URL", headers, fp)
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None and target != source:
            for name, _ in list(redirected.header_items()):
                if name.lower() in _SENSITIVE_HEADERS:
                    redirected.remove_header(name)
        return redirected


@dataclass(frozen=True)
class RetryConfig:
    """Retries apply to network errors, timeouts and ``retry_on`` statuses, never mid-stream."""

    max_retries: int = 2
    base_delay_ms: int = 500
    max_delay_ms: int = 8_000
    retry_on: Tuple[int, ...] = (408, 429, 500, 502, 503, 504)


_NO_RETRY = RetryConfig(max_retries=0, base_delay_ms=0, max_delay_ms=0, retry_on=())
RetryArg = Union[RetryConfig, bool, None]


@dataclass
class ApiResponse:
    data: Dict[str, Any]
    status: int
    #: ``x-request-id`` returned by the server, or ``client_request_id`` when absent.
    request_id: str
    #: The ``x-request-id`` the SDK sent.
    client_request_id: str
    headers: Dict[str, str] = field(default_factory=dict)


def _lower_headers(message: Any) -> Dict[str, str]:
    if message is None:
        return {}
    return {str(k).lower(): str(v) for k, v in message.items()}


def _is_timeout(exc: BaseException) -> bool:
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return True
    return isinstance(getattr(exc, "reason", None), (socket.timeout, TimeoutError))


def _close_quietly(resource: Any) -> None:
    try:
        resource.close()
    except Exception:  # noqa: BLE001 - closing must never mask the original outcome
        pass


def _read_text_quietly(resource: Any) -> str:
    try:
        raw = resource.read()
    except Exception:  # noqa: BLE001 - an unreadable error body falls back to the status text
        return ""
    finally:
        _close_quietly(resource)
    return raw.decode("utf-8", errors="replace") if raw else ""


class ChatCompletionStream:
    """An established chat completion stream. Iterate once; ``close()`` stops early."""

    def __init__(self, response: Any, status: int, headers: Dict[str, str], request_id: str, client_request_id: str) -> None:
        self.status = status
        self.headers = headers
        self.request_id = request_id
        self.client_request_id = client_request_id
        self._response = response
        self._consumed = False
        self._closed = False

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            _close_quietly(self._response)

    def __enter__(self) -> "ChatCompletionStream":
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()

    def __iter__(self) -> Iterator[Dict[str, Any]]:
        if self._consumed:
            raise client_error("stream_consumed", "This stream has already been consumed", status=self.status, request_id=self.request_id)
        self._consumed = True
        return self._iterate()

    def _iterate(self) -> Iterator[Dict[str, Any]]:
        try:
            for data in iter_sse_data(self._response):
                try:
                    payload = json.loads(data)
                except ValueError:
                    payload = None
                if not isinstance(payload, dict):
                    raise client_error("invalid_response", "Stream event is not a JSON object", status=self.status, request_id=self.request_id)
                if payload.get("error") is not None:
                    raise error_from_body(self.status, payload, self.request_id)
                yield payload
            if self._closed:
                raise client_error("aborted", "The stream was closed", request_id=self.request_id)
        except OmniRouteError:
            raise
        except _NETWORK_ERRORS + (ValueError,) as exc:
            if self._closed:
                raise client_error("aborted", "The stream was closed", request_id=self.request_id) from exc
            raise client_error("stream_error", "The stream was interrupted before completion", status=self.status, request_id=self.request_id) from exc
        finally:
            self.close()


class OmniRouteClient:
    """Minimal OmniRoute client: chat, streaming, models, health, quota and route preview."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        api_key: Optional[str] = None,
        *,
        management_key: Optional[str] = None,
        timeout_ms: float = DEFAULT_TIMEOUT_MS,
        retry: RetryArg = None,
        request_id_factory: Optional[Callable[[], str]] = None,
        headers: Optional[Mapping[str, str]] = None,
        on_request: Optional[Callable[[Dict[str, Any]], None]] = None,
        sleep: Optional[Callable[[float], None]] = None,
        use_env_proxies: bool = True,
    ) -> None:
        if not base_url.startswith(("http://", "https://")):
            raise ValueError("base_url must be an http(s) URL")
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._management_key = management_key
        self._timeout_ms = timeout_ms
        self._retry = retry
        self._request_id_factory = request_id_factory or (lambda: str(uuid.uuid4()))
        self._default_headers = {k.lower(): v for k, v in (headers or {}).items()}
        self._on_request = on_request
        self._sleep = sleep or time.sleep
        handlers: List[urllib.request.BaseHandler] = [_CredentialSafeRedirectHandler()]
        if not use_env_proxies:
            handlers.append(urllib.request.ProxyHandler({}))
        self._opener = urllib.request.build_opener(*handlers)

    def __repr__(self) -> str:
        key = "<redacted>" if self._api_key else None
        return f"OmniRouteClient(base_url={self.base_url!r}, api_key={key})"

    # -- public API -------------------------------------------------------------------------

    def chat_completions(self, request: Mapping[str, Any], *, request_id: Optional[str] = None, timeout_ms: Optional[float] = None, retry: RetryArg = None, headers: Optional[Mapping[str, str]] = None) -> ApiResponse:
        """POST /api/v1/chat/completions with ``stream: false``."""
        body = dict(request)
        body["stream"] = False
        return self._request_json("chatCompletions", body, request_id, timeout_ms, retry, headers)

    def stream_chat_completions(self, request: Mapping[str, Any], *, request_id: Optional[str] = None, timeout_ms: Optional[float] = None, retry: RetryArg = None, headers: Optional[Mapping[str, str]] = None) -> ChatCompletionStream:
        """POST /api/v1/chat/completions with ``stream: true``; iterate the result for chunks."""
        body = dict(request)
        body["stream"] = True
        response, client_request_id, _ = self._execute("chatCompletions", body, "text/event-stream", request_id, timeout_ms, retry, headers)
        response_headers = _lower_headers(response.headers)
        request_id_out = response_headers.get(REQUEST_ID_HEADER) or client_request_id
        return ChatCompletionStream(response, response.status, response_headers, request_id_out, client_request_id)

    def list_models(self, *, request_id: Optional[str] = None, timeout_ms: Optional[float] = None, retry: RetryArg = None, headers: Optional[Mapping[str, str]] = None) -> ApiResponse:
        """GET /api/v1/models."""
        return self._request_json("listModels", None, request_id, timeout_ms, retry, headers)

    def health(self, *, request_id: Optional[str] = None, timeout_ms: Optional[float] = None, retry: RetryArg = None, headers: Optional[Mapping[str, str]] = None) -> ApiResponse:
        """GET /api/health (unauthenticated; the API key is never sent)."""
        return self._request_json("health", None, request_id, timeout_ms, retry, headers)

    def quota(self, *, request_id: Optional[str] = None, timeout_ms: Optional[float] = None, retry: RetryArg = None, headers: Optional[Mapping[str, str]] = None) -> ApiResponse:
        """GET /api/v1/me/status: usage and quota of the API key (``self:usage`` scope)."""
        return self._request_json("quota", None, request_id, timeout_ms, retry, headers)

    def route_preview(self, request: Mapping[str, Any], *, request_id: Optional[str] = None, timeout_ms: Optional[float] = None, retry: RetryArg = None, headers: Optional[Mapping[str, str]] = None) -> ApiResponse:
        """POST /api/omniroute/route/preview (management credential; falls back to the API key)."""
        return self._request_json("routePreview", dict(request), request_id, timeout_ms, retry, headers)

    # -- transport --------------------------------------------------------------------------

    @staticmethod
    def _resolve_retry(base: RetryArg, override: RetryArg) -> RetryConfig:
        if override is False or (override is None and base is False):
            return _NO_RETRY
        if isinstance(override, RetryConfig):
            return override
        if isinstance(base, RetryConfig):
            return base
        return RetryConfig()

    def _build_headers(self, auth: str, accept: str, has_body: bool, client_request_id: str, extra: Optional[Mapping[str, str]]) -> Dict[str, str]:
        result = dict(self._default_headers)
        for key, value in (extra or {}).items():
            result[key.lower()] = value
        result["accept"] = accept
        if has_body:
            result["content-type"] = "application/json"
        result[REQUEST_ID_HEADER] = client_request_id
        if auth == "management":
            credential = self._management_key or self._api_key
        elif auth == "api_key":
            credential = self._api_key
        else:
            credential = None
        if credential:
            result["authorization"] = f"Bearer {credential}"
        return result

    def _backoff(self, attempt: int, retry_after_ms: Optional[int], cfg: RetryConfig) -> None:
        exponential = cfg.base_delay_ms * (2 ** attempt)
        delay_ms = min(retry_after_ms if retry_after_ms is not None else exponential, cfg.max_delay_ms)
        self._sleep(delay_ms / 1000.0)

    def _execute(self, operation: str, body: Optional[Dict[str, Any]], accept: str, request_id: Optional[str], timeout_ms: Optional[float], retry: RetryArg, extra_headers: Optional[Mapping[str, str]]) -> Tuple[Any, str, float]:
        method, path, auth = OPERATIONS[operation]
        client_request_id = request_id or self._request_id_factory()
        cfg = self._resolve_retry(self._retry, retry)
        effective_timeout_ms = self._timeout_ms if timeout_ms is None else timeout_ms
        timeout_s = effective_timeout_ms / 1000.0 if effective_timeout_ms and effective_timeout_ms > 0 else None
        url = self.base_url + path
        payload = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
        attempt = 0
        while True:
            headers = self._build_headers(auth, accept, payload is not None, client_request_id, extra_headers)
            if self._on_request is not None:
                self._on_request({"method": method, "url": url, "attempt": attempt, "client_request_id": client_request_id, "headers": redact_headers(headers)})
            request = urllib.request.Request(url, data=payload, headers=headers, method=method)
            try:
                if timeout_s is None:
                    response = self._opener.open(request)
                else:
                    response = self._opener.open(request, timeout=timeout_s)
            except urllib.error.HTTPError as exc:
                response_headers = _lower_headers(exc.headers)
                retry_after_ms = parse_retry_after_ms(response_headers.get("retry-after"), time.time())
                if exc.code in cfg.retry_on and attempt < cfg.max_retries:
                    _close_quietly(exc)
                    self._backoff(attempt, retry_after_ms, cfg)
                    attempt += 1
                    continue
                text = _read_text_quietly(exc)
                raise error_from_http(exc.code, text, response_headers, client_request_id, retry_after_ms) from None
            except _NETWORK_ERRORS as exc:
                if _is_timeout(exc):
                    error = client_error("timeout", f"The request timed out after {effective_timeout_ms}ms", request_id=client_request_id)
                else:
                    error = client_error("network", "The request failed before a response was received", request_id=client_request_id)
                if attempt >= cfg.max_retries:
                    raise error from exc
                self._backoff(attempt, None, cfg)
                attempt += 1
                continue
            return response, client_request_id, effective_timeout_ms

    def _request_json(self, operation: str, body: Optional[Dict[str, Any]], request_id: Optional[str], timeout_ms: Optional[float], retry: RetryArg, headers: Optional[Mapping[str, str]]) -> ApiResponse:
        response, client_request_id, effective_timeout_ms = self._execute(operation, body, "application/json", request_id, timeout_ms, retry, headers)
        status = response.status
        response_headers = _lower_headers(response.headers)
        request_id_out = response_headers.get(REQUEST_ID_HEADER) or client_request_id
        try:
            raw = response.read()
        except _NETWORK_ERRORS as exc:
            if _is_timeout(exc):
                raise client_error("timeout", f"The request timed out after {effective_timeout_ms}ms", request_id=client_request_id) from exc
            raise client_error("network", "The response body could not be read", status=status, request_id=client_request_id) from exc
        finally:
            _close_quietly(response)
        try:
            data = json.loads(raw.decode("utf-8")) if raw else None
        except ValueError:
            data = None
        if not isinstance(data, dict):
            raise client_error("invalid_response", "Response body is not a JSON object", status=status, request_id=request_id_out)
        return ApiResponse(data=data, status=status, request_id=request_id_out, client_request_id=client_request_id, headers=response_headers)
