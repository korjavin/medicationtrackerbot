"""Tests for the sandboxed runner.

Validates the contract from Task 8:

- timeout kills the script
- stdout/stderr truncation
- env scrubbed (no host secrets reach the user script)
- single-output enforcement
- proxy URL is the only network knob (only MEDTRACKER_* env vars survive)

Tests use real subprocesses because the runner's correctness is about real
sandbox semantics; mocking subprocess would defeat the purpose.
"""

from __future__ import annotations

import json
import os
import textwrap

import pytest

from runner import limits
from runner.runner import (
    EXIT_COMPLETED,
    EXIT_RESULT_TOO_LARGE,
    EXIT_SCRIPT_ERROR,
    EXIT_TIMEOUT,
    RunConfig,
    run,
    scrub_env,
    truncate_bytes,
)


def _config(script: str, **overrides) -> RunConfig:
    defaults: dict = {
        "script": textwrap.dedent(script).lstrip("\n"),
        "proxy_url": "http://proxy.local:9000/",
        "run_token": "secret-run-token",
        "timeout_s": 10.0,
    }
    defaults.update(overrides)
    return RunConfig(**defaults)


class TestScrubEnv:
    def test_strips_unrelated_secrets(self):
        parent = {
            "AWS_SECRET_ACCESS_KEY": "very-secret",
            "GITHUB_TOKEN": "ghs_xxx",
            "DATABASE_URL": "postgres://...",
            "PATH": "/usr/bin:/bin",
        }
        env = scrub_env(parent, "http://proxy/", "tok")
        assert "AWS_SECRET_ACCESS_KEY" not in env
        assert "GITHUB_TOKEN" not in env
        assert "DATABASE_URL" not in env

    def test_passes_through_required_host_vars(self):
        parent = {
            "PATH": "/usr/bin",
            "PYTHONPATH": "/app/python",
            "HOME": "/home/runner",
            "LANG": "en_US.UTF-8",
            "TMPDIR": "/tmp",
            "UNRELATED": "x",
        }
        env = scrub_env(parent, "http://proxy/", "tok")
        assert env["PATH"] == "/usr/bin"
        # PYTHONPATH gets the medtracker package root prepended so the child
        # interpreter can import the helper; the caller's value is preserved
        # after it.
        assert env["PYTHONPATH"].endswith("/app/python")
        assert env["HOME"] == "/home/runner"
        assert env["LANG"] == "en_US.UTF-8"
        assert env["TMPDIR"] == "/tmp"
        assert "UNRELATED" not in env

    def test_injects_proxy_url_and_run_token(self):
        env = scrub_env({}, "http://proxy.local:9000/", "the-token")
        assert env["MEDTRACKER_PROXY_URL"] == "http://proxy.local:9000/"
        assert env["MEDTRACKER_RUN_TOKEN"] == "the-token"


class TestTruncateBytes:
    def test_below_limit_unchanged(self):
        out, truncated = truncate_bytes(b"hello", 100)
        assert out == b"hello"
        assert truncated is False

    def test_at_limit_unchanged(self):
        out, truncated = truncate_bytes(b"abcde", 5)
        assert out == b"abcde"
        assert truncated is False

    def test_above_limit_truncated(self):
        out, truncated = truncate_bytes(b"abcdefghij", 4)
        assert out == b"abcd"
        assert truncated is True


class TestRunSuccess:
    def test_records_output_value(self):
        config = _config("""
            from medtracker import output
            output({"hello": "world"})
        """)
        result = run(config)
        assert result["status"] == "ok"
        assert result["exit_reason"] == EXIT_COMPLETED
        assert result["result"] == {"hello": "world"}
        assert result["output_set"] is True
        assert result["warnings"] == []

    def test_no_output_call_returns_none_with_output_set_false(self):
        config = _config("""
            x = 1 + 1
        """)
        result = run(config)
        assert result["status"] == "ok"
        assert result["result"] is None
        assert result["output_set"] is False

    def test_stdout_captured(self):
        config = _config("""
            print("hello stdout")
        """)
        result = run(config)
        assert result["status"] == "ok"
        assert "hello stdout" in result["stdout"]

    def test_stderr_captured(self):
        config = _config("""
            import sys
            print("hello stderr", file=sys.stderr)
        """)
        result = run(config)
        assert result["status"] == "ok"
        assert "hello stderr" in result["stderr"]

    def test_duration_ms_present(self):
        config = _config("""
            from medtracker import output
            output(1)
        """)
        result = run(config)
        assert isinstance(result["duration_ms"], int)
        assert result["duration_ms"] >= 0


class TestTimeoutKillsScript:
    def test_infinite_loop_killed(self):
        config = _config(
            """
            import time
            while True:
                time.sleep(0.05)
            """,
            timeout_s=0.5,
        )
        result = run(config)
        assert result["status"] == "error"
        assert result["exit_reason"] == EXIT_TIMEOUT
        assert "0.5" in result["error_message"]

    def test_timeout_does_not_collect_output(self):
        config = _config(
            """
            import time
            from medtracker import output
            output("partial")
            while True:
                time.sleep(0.05)
            """,
            timeout_s=0.5,
        )
        result = run(config)
        assert result["exit_reason"] == EXIT_TIMEOUT
        assert result["result"] is None


class TestStdoutStderrTruncation:
    def test_stdout_truncated_when_limit_exceeded(self, monkeypatch):
        monkeypatch.setattr(limits, "STDOUT_LIMIT_BYTES", 256)
        config = _config(
            """
            print("x" * 1024)
            print("y" * 1024)
            """
        )
        result = run(config)
        assert result["status"] == "ok"
        assert "stdout truncated" in result["warnings"]
        assert len(result["stdout"].encode("utf-8")) <= 256

    def test_stderr_truncated_when_limit_exceeded(self, monkeypatch):
        monkeypatch.setattr(limits, "STDERR_LIMIT_BYTES", 128)
        config = _config(
            """
            import sys
            sys.stderr.write("e" * 4096)
            sys.stderr.flush()
            """
        )
        result = run(config)
        assert "stderr truncated" in result["warnings"]
        assert len(result["stderr"].encode("utf-8")) <= 128

    def test_no_truncation_warning_when_within_limits(self):
        config = _config(
            """
            print("short")
            """
        )
        result = run(config)
        assert "stdout truncated" not in result["warnings"]
        assert "stderr truncated" not in result["warnings"]


class TestEnvScrubbed:
    def test_user_script_sees_only_proxy_and_run_token(self, monkeypatch):
        monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "leak-me-pls")
        monkeypatch.setenv("GITHUB_TOKEN", "ghs_xxxxxxxx")
        monkeypatch.setenv("DATABASE_URL", "postgres://prod/...")
        config = _config("""
            import json, os
            from medtracker import output
            output(sorted(os.environ.keys()))
        """)
        result = run(config)
        assert result["status"] == "ok"
        assert set(result["result"]) == {
            "MEDTRACKER_PROXY_URL",
            "MEDTRACKER_RUN_TOKEN",
        }

    def test_proxy_url_and_token_visible(self):
        config = _config("""
            import os
            from medtracker import output
            output({
                "proxy": os.environ.get("MEDTRACKER_PROXY_URL"),
                "token": os.environ.get("MEDTRACKER_RUN_TOKEN"),
            })
        """)
        result = run(config)
        assert result["status"] == "ok"
        assert result["result"]["proxy"] == "http://proxy.local:9000/"
        assert result["result"]["token"] == "secret-run-token"

    def test_runner_internal_env_not_visible_to_script(self):
        config = _config("""
            import os
            from medtracker import output
            output({
                "out": os.environ.get("__RUNNER_OUTPUT_PATH__"),
                "src": os.environ.get("__RUNNER_SCRIPT_PATH__"),
            })
        """)
        result = run(config)
        assert result["status"] == "ok"
        assert result["result"] == {"out": None, "src": None}


class TestSingleOutputEnforced:
    def test_second_output_call_raises_runtime_error(self):
        config = _config("""
            from medtracker import output
            output(1)
            output(2)
        """)
        result = run(config)
        assert result["status"] == "error"
        assert result["exit_reason"] == EXIT_SCRIPT_ERROR
        assert result["error_type"] == "RuntimeError"
        assert "once" in result["error_message"]

    def test_single_output_call_succeeds(self):
        config = _config("""
            from medtracker import output
            output(42)
        """)
        result = run(config)
        assert result["status"] == "ok"
        assert result["result"] == 42


class TestProxyUrlIsOnlyNetworkKnob:
    def test_no_http_proxy_or_other_network_vars_present(self, monkeypatch):
        monkeypatch.setenv("HTTP_PROXY", "http://attacker:8080")
        monkeypatch.setenv("HTTPS_PROXY", "http://attacker:8080")
        monkeypatch.setenv("NO_PROXY", "localhost")
        config = _config("""
            import os
            from medtracker import output
            output({
                "http_proxy": os.environ.get("HTTP_PROXY"),
                "https_proxy": os.environ.get("HTTPS_PROXY"),
                "no_proxy": os.environ.get("NO_PROXY"),
                "medtracker_proxy": os.environ.get("MEDTRACKER_PROXY_URL"),
            })
        """)
        result = run(config)
        assert result["status"] == "ok"
        assert result["result"]["http_proxy"] is None
        assert result["result"]["https_proxy"] is None
        assert result["result"]["no_proxy"] is None
        assert result["result"]["medtracker_proxy"] == "http://proxy.local:9000/"


class TestScriptErrors:
    def test_uncaught_exception_returns_script_error(self):
        config = _config("""
            raise ValueError("bad input")
        """)
        result = run(config)
        assert result["status"] == "error"
        assert result["exit_reason"] == EXIT_SCRIPT_ERROR
        assert result["error_type"] == "ValueError"
        assert "bad input" in result["error_message"]
        assert "ValueError" in result.get("traceback", "")

    def test_syntax_error_returns_script_error(self):
        config = _config("def broken(:\n    pass\n")
        result = run(config)
        assert result["status"] == "error"
        assert result["exit_reason"] == EXIT_SCRIPT_ERROR
        assert result["error_type"] == "SyntaxError"

    def test_non_serializable_output_returns_serialization_error(self):
        config = _config("""
            from medtracker import output
            output(object())
        """)
        result = run(config)
        assert result["status"] == "error"
        assert result["error_type"] == "SerializationError"


class TestResultSizeLimit:
    def test_oversized_result_rejected(self, monkeypatch):
        monkeypatch.setattr(limits, "RESULT_SIZE_LIMIT_BYTES", 64)
        config = _config("""
            from medtracker import output
            output({"data": "x" * 1024})
        """)
        result = run(config)
        assert result["status"] == "error"
        assert result["exit_reason"] == EXIT_RESULT_TOO_LARGE


class TestRunConfigFromDict:
    def test_minimal_payload(self):
        cfg = RunConfig.from_dict({
            "script": "from medtracker import output\noutput(1)",
            "proxy_url": "http://proxy/",
        })
        assert cfg.mode == "read_only"
        assert cfg.timeout_s == limits.WALL_CLOCK_TIMEOUT_S
        assert cfg.max_api_calls == limits.MAX_API_CALLS
        assert cfg.run_token == ""
        assert cfg.topic_allowlist is None

    def test_full_payload(self):
        cfg = RunConfig.from_dict({
            "script": "x",
            "proxy_url": "http://p/",
            "run_token": "tok",
            "mode": "write",
            "timeout_s": 5,
            "max_api_calls": 7,
            "topic_allowlist": ["workouts"],
        })
        assert cfg.mode == "write"
        assert cfg.timeout_s == 5.0
        assert cfg.max_api_calls == 7
        assert cfg.run_token == "tok"
        assert list(cfg.topic_allowlist) == ["workouts"]

    def test_missing_script_raises(self):
        with pytest.raises(ValueError, match="script"):
            RunConfig.from_dict({"proxy_url": "http://p/"})

    def test_missing_proxy_url_raises(self):
        with pytest.raises(ValueError, match="proxy_url"):
            RunConfig.from_dict({"script": "x"})


class TestSandboxStartupFailure:
    def test_bad_python_executable_returns_startup_failure(self):
        config = _config("""
            from medtracker import output
            output(1)
        """)
        result = run(config, python_executable="/nonexistent/python/binary")
        assert result["status"] == "error"
        assert result["exit_reason"] in {"sandbox_startup_failure"}
