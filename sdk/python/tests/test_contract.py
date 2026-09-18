"""Runs the shared sdk/contract/fixtures/*.json against the Python SDK and a local fake server."""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from omniroute_sdk import OPERATIONS, OmniRouteClient, OmniRouteError, RetryConfig
from tests._fake_server import FakeOmniRoute

FIXTURES_DIR = Path(__file__).resolve().parents[2] / "contract" / "fixtures"

FIXTURE_OPERATION_TO_SDK = {
    "chatCompletions": "chatCompletions",
    "chatCompletionsStream": "chatCompletions",
    "listModels": "listModels",
    "health": "health",
    "quota": "quota",
    "routePreview": "routePreview",
}

ERROR_FIELDS = {
    "status": "status",
    "message": "message",
    "code": "code",
    "type": "type",
    "reason": "reason",
    "requestId": "request_id",
    "retryAfterMs": "retry_after_ms",
}


def load_cases() -> List[Tuple[str, Dict[str, Any]]]:
    cases: List[Tuple[str, Dict[str, Any]]] = []
    for path in sorted(FIXTURES_DIR.glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        for case in document["cases"]:
            cases.append((path.name, case))
    return cases


def retry_from_fixture(retry: Dict[str, Any]) -> RetryConfig:
    defaults = RetryConfig()
    return RetryConfig(
        max_retries=retry.get("maxRetries", defaults.max_retries),
        base_delay_ms=retry.get("baseDelayMs", defaults.base_delay_ms),
        max_delay_ms=retry.get("maxDelayMs", defaults.max_delay_ms),
        retry_on=tuple(retry.get("retryOn", defaults.retry_on)),
    )


def _meta(response: Any) -> Dict[str, Any]:
    return {
        "status": response.status,
        "requestId": response.request_id,
        "clientRequestId": response.client_request_id,
        "data": response.data,
    }


def invoke(client: OmniRouteClient, case: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], List[Any], Optional[OmniRouteError]]:
    operation = case["operation"]
    payload = case.get("input") or {}
    chunks: List[Any] = []
    try:
        if operation == "chatCompletions":
            return _meta(client.chat_completions(payload)), chunks, None
        if operation == "chatCompletionsStream":
            stream = client.stream_chat_completions(payload)
            for chunk in stream:
                chunks.append(chunk)
            meta = {"status": stream.status, "requestId": stream.request_id, "clientRequestId": stream.client_request_id}
            return meta, chunks, None
        if operation == "listModels":
            return _meta(client.list_models()), chunks, None
        if operation == "health":
            return _meta(client.health()), chunks, None
        if operation == "quota":
            return _meta(client.quota()), chunks, None
        if operation == "routePreview":
            return _meta(client.route_preview(payload)), chunks, None
    except OmniRouteError as exc:
        return None, chunks, exc
    raise AssertionError(f"unknown fixture operation: {operation}")


class ContractFixtureTest(unittest.TestCase):
    def test_fixtures_cover_every_operation(self) -> None:
        cases = load_cases()
        covered = {FIXTURE_OPERATION_TO_SDK[case["operation"]] for _, case in cases}
        self.assertEqual(covered, set(OPERATIONS))
        for file_name, case in cases:
            method, path, _ = OPERATIONS[FIXTURE_OPERATION_TO_SDK[case["operation"]]]
            for request in case["expectedRequests"]:
                self.assertEqual((request["method"], request["path"]), (method, path), f"{file_name}: {case['name']}")

    def test_contract_cases(self) -> None:
        cases = load_cases()
        self.assertGreater(len(cases), 0)
        for file_name, case in cases:
            with self.subTest(fixture=file_name, case=case["name"]):
                self._run_case(case)

    def _run_case(self, case: Dict[str, Any]) -> None:
        delays: List[int] = []
        client_cfg = case["client"]
        with FakeOmniRoute(case["responses"]) as server:
            client = OmniRouteClient(
                server.base_url,
                client_cfg.get("apiKey"),
                management_key=client_cfg.get("managementKey"),
                retry=retry_from_fixture(client_cfg["retry"]),
                request_id_factory=lambda: client_cfg["requestId"],
                sleep=lambda seconds: delays.append(int(round(seconds * 1000))),
                timeout_ms=5_000,
                use_env_proxies=False,
            )
            result, chunks, error = invoke(client, case)

        expected_requests = case["expectedRequests"]
        self.assertEqual(len(server.requests), len(expected_requests), "request count")
        for index, (recorded, expected) in enumerate(zip(server.requests, expected_requests)):
            self.assertEqual(recorded["method"], expected["method"], f"request #{index} method")
            self.assertEqual(recorded["path"], expected["path"], f"request #{index} path")
            for name, value in expected.get("headers", {}).items():
                self.assertEqual(recorded["headers"].get(name), value, f"request #{index} header {name}")
            for name in expected.get("absentHeaders", []):
                self.assertNotIn(name, recorded["headers"], f"request #{index} must not send {name}")
            if "body" in expected:
                if expected["body"] is None:
                    self.assertEqual(recorded["body"], b"", f"request #{index} body")
                else:
                    self.assertEqual(json.loads(recorded["body"].decode("utf-8")), expected["body"], f"request #{index} body")

        self.assertEqual(delays, case.get("expectedDelaysMs", []), "backoff delays")

        outcome = case["expected"]
        if "chunks" in outcome:
            self.assertEqual(chunks, outcome["chunks"], "chunks")
        if "error" in outcome:
            self.assertIsInstance(error, OmniRouteError)
            for key, value in outcome["error"].items():
                self.assertEqual(getattr(error, ERROR_FIELDS[key]), value, f"error.{key}")
            return
        self.assertIsNone(error, repr(error))
        assert result is not None
        expected_result = outcome["result"]
        for key in ("status", "requestId", "clientRequestId"):
            self.assertEqual(result[key], expected_result[key], f"result.{key}")
        if "data" in expected_result:
            self.assertEqual(result["data"], expected_result["data"], "result.data")


if __name__ == "__main__":
    unittest.main()
