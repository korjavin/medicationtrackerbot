import json
import socket
import urllib.error
from io import BytesIO
from unittest.mock import patch

import pytest

import medtracker.api as api
import medtracker.exceptions as exc

PROXY_URL = "http://proxy.local:9000/"


class _MockResponse:
    """Minimal stub for the urllib.request.urlopen context manager result."""

    def __init__(self, data: dict):
        self._body = json.dumps(data).encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def _http_error(
    status: int,
    message: str = "error",
    headers: dict = None,
) -> urllib.error.HTTPError:
    from email.message import Message

    hdrs = Message()
    if headers:
        for k, v in headers.items():
            hdrs[k] = v
    return urllib.error.HTTPError(
        url=PROXY_URL,
        code=status,
        msg=message,
        hdrs=hdrs,
        fp=BytesIO(message.encode()),
    )


@pytest.fixture(autouse=True)
def set_proxy_env(monkeypatch):
    monkeypatch.setenv("MEDTRACKER_PROXY_URL", PROXY_URL)
    monkeypatch.delenv("MEDTRACKER_RUN_TOKEN", raising=False)


class TestCallSuccess:
    def test_returns_parsed_response(self):
        response = {"status": 200, "body": {"groups": ["push", "pull"]}, "duration_ms": 5}
        with patch("urllib.request.urlopen", return_value=_MockResponse(response)):
            result = api.call("workouts.groups.list")
        assert result["status"] == 200
        assert result["body"]["groups"] == ["push", "pull"]

    def test_sends_operation_id(self):
        response = {"status": 200, "body": {}, "duration_ms": 1}
        with patch("urllib.request.urlopen", return_value=_MockResponse(response)) as mock_open:
            api.call("workouts.groups.list")
        req = mock_open.call_args[0][0]
        payload = json.loads(req.data)
        assert payload["operation_id"] == "workouts.groups.list"

    def test_sends_params(self):
        response = {"status": 200, "body": {}, "duration_ms": 1}
        with patch("urllib.request.urlopen", return_value=_MockResponse(response)) as mock_open:
            api.call("workouts.sessions.list", params={"limit": "10"})
        req = mock_open.call_args[0][0]
        payload = json.loads(req.data)
        assert payload["params"] == {"limit": "10"}

    def test_sends_body(self):
        response = {"status": 200, "body": {}, "duration_ms": 1}
        with patch("urllib.request.urlopen", return_value=_MockResponse(response)) as mock_open:
            api.call("workouts.exercises.update", body={"name": "squat"})
        req = mock_open.call_args[0][0]
        payload = json.loads(req.data)
        assert payload["body"] == {"name": "squat"}

    def test_no_params_or_body_key_when_absent(self):
        response = {"status": 200, "body": {}, "duration_ms": 1}
        with patch("urllib.request.urlopen", return_value=_MockResponse(response)) as mock_open:
            api.call("workouts.groups.list")
        req = mock_open.call_args[0][0]
        payload = json.loads(req.data)
        assert "params" not in payload
        assert "body" not in payload

    def test_sends_run_token_header(self, monkeypatch):
        monkeypatch.setenv("MEDTRACKER_RUN_TOKEN", "secret-run-token")
        response = {"status": 200, "body": {}, "duration_ms": 1}
        with patch("urllib.request.urlopen", return_value=_MockResponse(response)) as mock_open:
            api.call("workouts.groups.list")
        req = mock_open.call_args[0][0]
        # urllib.request.Request normalizes headers: "X-Run-Token" → stored as "X-run-token"
        assert req.get_header("X-run-token") == "secret-run-token"

    def test_sends_content_type_header(self):
        response = {"status": 200, "body": {}, "duration_ms": 1}
        with patch("urllib.request.urlopen", return_value=_MockResponse(response)) as mock_open:
            api.call("workouts.groups.list")
        req = mock_open.call_args[0][0]
        assert req.get_header("Content-type") == "application/json"

    def test_uses_post_method(self):
        response = {"status": 200, "body": {}, "duration_ms": 1}
        with patch("urllib.request.urlopen", return_value=_MockResponse(response)) as mock_open:
            api.call("workouts.groups.list")
        req = mock_open.call_args[0][0]
        assert req.get_method() == "POST"


class TestCallErrors:
    def test_proxy_denied_when_outcome_header_set(self):
        # Local proxy rejection (write_blocked, unknown_operation, etc.) sets
        # X-MCP-Outcome: proxy_denied; the helper raises ProxyDenied so the
        # script can distinguish policy denials from backend failures.
        with patch(
            "urllib.request.urlopen",
            side_effect=_http_error(
                403, "write blocked", headers={"X-MCP-Outcome": "proxy_denied"}
            ),
        ):
            with pytest.raises(exc.ProxyDenied) as exc_info:
                api.call("workouts.exercises.update")
        assert exc_info.value.status_code == 403
        assert "403" in str(exc_info.value)

    def test_backend_error_on_4xx_without_outcome_header(self):
        # Backend validation errors are forwarded as 4xx without the proxy
        # denial marker; the helper raises BackendError so callers don't
        # mistake them for policy denials.
        with patch("urllib.request.urlopen", side_effect=_http_error(400, "invalid input")):
            with pytest.raises(exc.BackendError) as exc_info:
                api.call("workouts.exercises.update")
        assert exc_info.value.status_code == 400

    def test_backend_error_on_500(self):
        with patch("urllib.request.urlopen", side_effect=_http_error(500, "internal error")):
            with pytest.raises(exc.BackendError) as exc_info:
                api.call("workouts.groups.list")
        assert exc_info.value.status_code == 500

    def test_backend_error_on_502(self):
        with patch("urllib.request.urlopen", side_effect=_http_error(502, "bad gateway")):
            with pytest.raises(exc.BackendError) as exc_info:
                api.call("workouts.groups.list")
        assert exc_info.value.status_code == 502

    def test_backend_transport_error_when_outcome_header_set(self):
        # Bridge unreachable / bridge config error: the executor sets
        # X-MCP-Outcome: backend_transport_error so the helper can raise a
        # distinct BackendTransportError rather than conflating it with a real
        # upstream 5xx.
        with patch(
            "urllib.request.urlopen",
            side_effect=_http_error(
                502,
                "bridge transport error: connection refused",
                headers={"X-MCP-Outcome": "backend_transport_error"},
            ),
        ):
            with pytest.raises(exc.BackendTransportError) as exc_info:
                api.call("workouts.groups.list")
        assert exc_info.value.status_code == 502

    def test_backend_transport_error_is_medtracker_error(self):
        with patch(
            "urllib.request.urlopen",
            side_effect=_http_error(
                502,
                "bridge transport error",
                headers={"X-MCP-Outcome": "backend_transport_error"},
            ),
        ):
            with pytest.raises(exc.MedtrackerError):
                api.call("workouts.groups.list")

    def test_backend_response_truncated_when_outcome_header_set(self):
        # Bridge truncated the upstream response at its per-call cap. The
        # executor signals this with X-MCP-Outcome: backend_response_truncated
        # so the helper raises BackendResponseTruncated, letting the script
        # retry with a smaller window instead of acting on partial data.
        with patch(
            "urllib.request.urlopen",
            side_effect=_http_error(
                502,
                "backend response exceeded the per-call size cap and was truncated",
                headers={"X-MCP-Outcome": "backend_response_truncated"},
            ),
        ):
            with pytest.raises(exc.BackendResponseTruncated) as exc_info:
                api.call("health.bp.list")
        assert exc_info.value.status_code == 502
        assert "truncated" in str(exc_info.value).lower()

    def test_missing_proxy_url_raises_runtime_error(self, monkeypatch):
        monkeypatch.delenv("MEDTRACKER_PROXY_URL", raising=False)
        with pytest.raises(RuntimeError, match="MEDTRACKER_PROXY_URL"):
            api.call("workouts.groups.list")

    def test_socket_timeout_raises_medtracker_timeout(self):
        with patch("urllib.request.urlopen", side_effect=socket.timeout("timed out")):
            with pytest.raises(exc.TimeoutError):
                api.call("workouts.groups.list")

    def test_builtin_timeout_raises_medtracker_timeout(self):
        with patch("urllib.request.urlopen", side_effect=TimeoutError("timed out")):
            with pytest.raises(exc.TimeoutError):
                api.call("workouts.groups.list")

    def test_proxy_denied_is_medtracker_error(self):
        with patch(
            "urllib.request.urlopen",
            side_effect=_http_error(
                403, "denied", headers={"X-MCP-Outcome": "proxy_denied"}
            ),
        ):
            with pytest.raises(exc.MedtrackerError):
                api.call("workouts.groups.list")

    def test_backend_error_is_medtracker_error(self):
        with patch("urllib.request.urlopen", side_effect=_http_error(500, "oops")):
            with pytest.raises(exc.MedtrackerError):
                api.call("workouts.groups.list")

    def test_empty_2xx_body_returns_none(self):
        # Upstream HTTP 204 No Content (or any other empty 2xx body) is a
        # legitimate "no value" result; the helper must surface it as None
        # rather than tripping json.loads on an empty string.
        class _Empty:
            def read(self):
                return b""

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

        with patch("urllib.request.urlopen", return_value=_Empty()):
            assert api.call("medications.next_intake") is None
