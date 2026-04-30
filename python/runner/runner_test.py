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
import sys
import textwrap
import time

import pytest

from runner import limits
from runner.runner import (
    EXIT_COMPLETED,
    EXIT_RESULT_TOO_LARGE,
    EXIT_SCRIPT_ERROR,
    EXIT_TIMEOUT,
    RunConfig,
    _enable_child_subreaper,
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
        assert "output() was not called" in result["warnings"]

    def test_output_none_does_not_warn(self):
        # output(None) is a deliberate signal that the script ran to completion
        # with no payload; it must NOT trigger the missing-output warning.
        config = _config("""
            from medtracker import output
            output(None)
        """)
        result = run(config)
        assert result["status"] == "ok"
        assert result["result"] is None
        assert result["output_set"] is True
        assert "output() was not called" not in result["warnings"]

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


class TestDescendantCleanup:
    @pytest.fixture(autouse=True)
    def _ensure_subreaper(self):
        # The CLI entrypoint (runner.runner.main) sets PR_SET_CHILD_SUBREAPER
        # before spawning the bootstrap so escaped grandchildren reparent to
        # the runner instead of init. These tests call run() directly, so they
        # must claim subreaper status themselves; otherwise _kill_descendants's
        # /proc walk from os.getpid() can't find a process whose parent has
        # been reaped to PID 1.
        _enable_child_subreaper()

    @pytest.mark.skipif(not sys.platform.startswith("linux"),
                        reason="descendant sweep relies on /proc + PR_SET_CHILD_SUBREAPER")
    def test_session_subprocess_killed_after_run(self, tmp_path):
        # A user script can call subprocess.Popen(start_new_session=True) which
        # creates a process in a new session — escaping the runner's PGID
        # cleanup. With the subreaper + /proc sweep in place, the runner must
        # still kill that process before returning, otherwise the wall-clock
        # bound is unenforceable for misbehaving scripts.
        marker = tmp_path / "alive.pid"
        config = _config(
            f"""
            import os, subprocess, sys, time
            from medtracker import output

            child = subprocess.Popen(
                [sys.executable, "-c",
                 "import os, time; open({str(marker)!r}, 'w').write(str(os.getpid())); time.sleep(60)"],
                start_new_session=True,
            )
            # Give the grandchild a moment to write its PID before output().
            for _ in range(50):
                if os.path.exists({str(marker)!r}):
                    break
                time.sleep(0.05)
            output({{"child_pid": child.pid}})
            """
        )
        result = run(config)
        assert result["status"] == "ok"
        assert os.path.exists(str(marker)), "test setup failed: marker never written"
        pid = int(marker.read_text().strip())

        # Poll briefly: the sweep runs in run()'s finally block but the kernel
        # may take a few ms to fully tear down the process.
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.05)
        # Final attempt: if still alive, the sweep failed. Try to clean up the
        # leak so the test machine doesn't accumulate background sleepers.
        try:
            os.kill(pid, 9)
        except ProcessLookupError:
            return
        pytest.fail(f"escaped subprocess pid={pid} survived the runner cleanup")

    @pytest.mark.skipif(not sys.platform.startswith("linux"),
                        reason="descendant sweep relies on /proc + PR_SET_CHILD_SUBREAPER")
    def test_timeout_returns_promptly_when_escaped_child_inherits_pipes(self):
        # An escaped subprocess (start_new_session=True) that inherits the
        # child interpreter's stdout/stderr keeps those pipes open after the
        # user-script PGID is killed. Without sweeping descendants before the
        # pipe-reader joins, the runner would block the full 5s join budget
        # twice — pushing total cleanup past the Go-side backstop and turning
        # a timeout into spawn_failed. Verify the timeout envelope still comes
        # back well within the wall-clock margin.
        config = _config(
            """
            import subprocess, sys, time
            from medtracker import output
            output("partial")
            # New-session subprocess inherits this process's stdout/stderr by
            # default, so it would keep the runner's pipe readers blocked.
            subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(60)"],
                start_new_session=True,
            )
            while True:
                time.sleep(0.05)
            """,
            timeout_s=0.5,
        )
        started = time.monotonic()
        result = run(config)
        elapsed = time.monotonic() - started
        assert result["exit_reason"] == EXIT_TIMEOUT
        # Worst case without the descendant sweep: 5s + 5s of blocked joins on
        # top of timeout_s. Allow generous slack for slow CI but still well
        # under the unfixed worst case.
        assert elapsed < 6.0, f"runner took {elapsed:.2f}s to surface timeout"


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
        # Helper-raised exceptions are reported with the fully-qualified type
        # so the executor can distinguish them from same-name user classes.
        assert result["error_type"] == "medtracker.exceptions.SerializationError"


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

    def test_oversized_envelope_rejected_before_load(self, monkeypatch):
        # Cap the value limit aggressively so a moderately-sized envelope
        # trips the pre-read size check in _read_envelope rather than the
        # post-load json.dumps cap. Without the pre-read guard, the runner
        # parent would json.load the entire file into memory before noticing
        # the value exceeds the cap.
        monkeypatch.setattr(limits, "RESULT_SIZE_LIMIT_BYTES", 256)
        config = _config("""
            from medtracker import output
            output({"data": "x" * (4 * 1024 * 1024)})
        """)
        result = run(config)
        assert result["status"] == "error"
        assert result["exit_reason"] == EXIT_RESULT_TOO_LARGE


class TestStrictJSONOutput:
    def test_nan_output_rejected_at_validation(self):
        # Default json.dumps allows NaN/Infinity but Go's encoding/json does
        # not. The script-side validation must reject these at output() so the
        # failure surfaces as a clean SerializationError instead of an
        # invalid_runner_envelope on the executor.
        config = _config("""
            from medtracker import output
            output(float('nan'))
        """)
        result = run(config)
        assert result["status"] == "error"
        assert result["error_type"] == "medtracker.exceptions.SerializationError"

    def test_infinity_output_rejected_at_validation(self):
        config = _config("""
            from medtracker import output
            output(float('inf'))
        """)
        result = run(config)
        assert result["status"] == "error"
        assert result["error_type"] == "medtracker.exceptions.SerializationError"


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
