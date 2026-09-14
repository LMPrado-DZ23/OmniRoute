"""Behaviour the shared fixtures cannot express: timeouts, network errors, redaction, SSE framing."""

from __future__ import annotations

import socket
import unittest
from email.utils import formatdate
from typing import Any, Dict, List

from omniroute_sdk import (
    CLIENT_ERROR_CODES,
    OmniRouteClient,
    OmniRouteError,
    RetryConfig,
    iter_sse_data,
    parse_retry_after_ms,
)
from tests._fake_server import FakeOmniRoute

CHAT = {"model": "auto", "messages": [{"role": "user", "content": "Hi"}]}
CHUNK = 'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n'


def _unused_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class ClientBehaviourTest(unittest.TestCase):
    def test_timeout_raises_timeout_code(self) -> None:
        with FakeOmniRoute([{"status": 200, "json": {"status": "ok"}, "delay_s": 1.0}]) as server:
            client = OmniRouteClient(server.base_url, timeout_ms=150, retry=False, use_env_proxies=False)
            with self.assertRaises(OmniRouteError) as ctx:
                client.health()
        self.assertEqual(ctx.exception.code, CLIENT_ERROR_CODES["timeout"])
        self.assertEqual(ctx.exception.status, 0)

    def test_network_errors_retry_with_exponential_backoff(self) -> None:
        delays: List[int] = []
        client = OmniRouteClient(
            f"http://127.0.0.1:{_unused_port()}",
            retry=RetryConfig(max_retries=2, base_delay_ms=100),
            sleep=lambda seconds: delays.append(int(round(seconds * 1000))),
            use_env_proxies=False,
        )
        with self.assertRaises(OmniRouteError) as ctx:
            client.list_models()
        self.assertEqual(ctx.exception.code, CLIENT_ERROR_CODES["network"])
        self.assertEqual(delays, [100, 200])

    def test_retry_after_is_capped_by_max_delay(self) -> None:
        delays: List[int] = []
        responses = [
            {"status": 429, "headers": {"retry-after": "120"}, "json": {"error": {"message": "slow down"}}},
            {"status": 200, "json": {"status": "ok", "timestamp": "t"}},
        ]
        with FakeOmniRoute(responses) as server:
            client = OmniRouteClient(
                server.base_url,
                retry=RetryConfig(max_retries=1, max_delay_ms=1_000),
                sleep=lambda seconds: delays.append(int(round(seconds * 1000))),
                use_env_proxies=False,
            )
            self.assertEqual(client.health().status, 200)
        self.assertEqual(delays, [1_000])

    def test_empty_retry_on_disables_status_retries(self) -> None:
        with FakeOmniRoute([{"status": 503, "json": {"error": {"message": "down"}}}]) as server:
            client = OmniRouteClient(server.base_url, retry=RetryConfig(max_retries=3, retry_on=()), use_env_proxies=False)
            with self.assertRaises(OmniRouteError) as ctx:
                client.health()
            self.assertEqual(len(server.requests), 1)
        self.assertEqual(ctx.exception.status, 503)

    def test_invalid_json_body_raises_invalid_response(self) -> None:
        with FakeOmniRoute([{"status": 200, "headers": {"content-type": "text/html"}, "text": "<html></html>"}]) as server:
            client = OmniRouteClient(server.base_url, retry=False, use_env_proxies=False)
            with self.assertRaises(OmniRouteError) as ctx:
                client.list_models()
        self.assertEqual(ctx.exception.code, CLIENT_ERROR_CODES["invalid_response"])

    def test_stream_close_stops_and_cannot_be_reused(self) -> None:
        sse = CHUNK * 3 + "data: [DONE]\n\n"
        with FakeOmniRoute([{"status": 200, "headers": {"content-type": "text/event-stream"}, "sse": sse}]) as server:
            client = OmniRouteClient(server.base_url, retry=False, use_env_proxies=False)
            with client.stream_chat_completions(CHAT) as stream:
                first = next(iter(stream))
                self.assertEqual(first["choices"][0]["delta"]["content"], "Hi")
            with self.assertRaises(OmniRouteError) as ctx:
                iter(stream)
            self.assertEqual(len(server.requests), 1)
        self.assertEqual(ctx.exception.code, CLIENT_ERROR_CODES["stream_consumed"])

    def test_debug_hook_and_repr_redact_credentials(self) -> None:
        seen: List[Dict[str, Any]] = []
        with FakeOmniRoute([{"status": 200, "json": {"object": "list", "data": []}}]) as server:
            client = OmniRouteClient(
                server.base_url,
                "sk-super-secret",
                management_key="mgmt-super-secret",
                on_request=seen.append,
                retry=False,
                use_env_proxies=False,
            )
            client.list_models()
        self.assertEqual(seen[0]["headers"]["authorization"], "[REDACTED]")
        dump = repr(client) + repr(seen)
        self.assertNotIn("sk-super-secret", dump)
        self.assertNotIn("mgmt-super-secret", dump)

    def test_base_url_is_validated_and_normalized(self) -> None:
        self.assertEqual(OmniRouteClient("http://gateway.test/omniroute///").base_url, "http://gateway.test/omniroute")
        with self.assertRaises(ValueError):
            OmniRouteClient("gateway.test")


class HelpersTest(unittest.TestCase):
    def test_parse_retry_after(self) -> None:
        now = 1_700_000_000.0
        self.assertEqual(parse_retry_after_ms("2", now), 2_000)
        self.assertEqual(parse_retry_after_ms("1.5", now), 1_500)
        self.assertEqual(parse_retry_after_ms(formatdate(now + 3, usegmt=True), now), 3_000)
        self.assertEqual(parse_retry_after_ms(formatdate(now - 60, usegmt=True), now), 0)
        self.assertIsNone(parse_retry_after_ms("soon", now))
        self.assertIsNone(parse_retry_after_ms("", now))
        self.assertIsNone(parse_retry_after_ms(None, now))

    def test_iter_sse_data_framing(self) -> None:
        lines = [
            b"data: line1\r\n",
            b"data: line2\r\n",
            b"\r\n",
            b": ping\n",
            b"\n",
            b'data: {"a":1}\n',
            b"\n",
            b"data: [DONE]\n",
            b"\n",
            b"data: after-done\n",
            b"\n",
        ]
        self.assertEqual(list(iter_sse_data(lines)), ["line1\nline2", '{"a":1}'])
        self.assertEqual(list(iter_sse_data([b"data: tail"])), ["tail"])


if __name__ == "__main__":
    unittest.main()
