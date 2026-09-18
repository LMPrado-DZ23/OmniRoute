"""Local, in-process fake OmniRoute server (http.server) that replays queued responses."""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional


class _Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, fake: "FakeOmniRoute") -> None:
        super().__init__(("127.0.0.1", 0), _Handler)
        self.fake = fake


class _Handler(BaseHTTPRequestHandler):
    server: _Server

    def _handle(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        spec = self.server.fake.record(
            {
                "method": self.command,
                "path": self.path,
                "headers": {k.lower(): v for k, v in self.headers.items()},
                "body": body,
            }
        )
        if spec is None:
            spec = {"status": 599, "text": "no response queued"}
        delay = spec.get("delay_s")
        if delay:
            time.sleep(delay)
        if "sse" in spec:
            payload = spec["sse"].encode("utf-8")
        elif "json" in spec:
            payload = json.dumps(spec["json"]).encode("utf-8")
        else:
            payload = str(spec.get("text", "")).encode("utf-8")
        headers = {k.lower(): v for k, v in spec.get("headers", {}).items()}
        headers.setdefault("content-type", "application/json")
        try:
            self.send_response(spec["status"])
            for key, value in headers.items():
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    do_GET = _handle
    do_POST = _handle

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - signature fixed by stdlib
        return


class FakeOmniRoute:
    def __init__(self, responses: List[Dict[str, Any]]) -> None:
        self._responses = list(responses)
        self._lock = threading.Lock()
        self.requests: List[Dict[str, Any]] = []
        self._server = _Server(self)
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def enqueue(self, *responses: Dict[str, Any]) -> None:
        """Queue more responses (e.g. a redirect whose Location needs ``base_url``)."""
        with self._lock:
            self._responses.extend(responses)

    def record(self, request: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        with self._lock:
            self.requests.append(request)
            return self._responses.pop(0) if self._responses else None

    def __enter__(self) -> "FakeOmniRoute":
        self._thread.start()
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)
