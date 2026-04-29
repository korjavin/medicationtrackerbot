"""Sandboxed script runner.

The runner spawns a child Python process per run, applies a hard wall-clock
timeout, captures bounded stdout/stderr, scrubs the environment so that only
the proxy URL and run token reach the user script, and collects the final
``output(...)`` value through the ``medtracker`` helper package.

Runner-side prohibitions (enforced operationally by the runner image and the
limited env passed to the script):

- arbitrary HTTP: only ``MEDTRACKER_PROXY_URL`` (the local API proxy) is
  exposed; the script has no other network knob and must use
  ``medtracker.api.call`` to reach the backend.
- package installs: ``pip``/``setuptools`` write paths must be denied at
  the image level (read-only root FS in deployment); the runner does not
  invoke ``pip`` and the helper package is baked into the image.
- filesystem writes outside scratch: the runner provides a per-run scratch
  directory as ``cwd``; production deployment runs with read-only root.
- long-running loops: bounded by the wall-clock timeout (default 30 s);
  on expiry the runner sends SIGKILL to the process group.
"""

from __future__ import annotations

import dataclasses
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Iterable, Mapping, Optional

from runner import limits


@dataclasses.dataclass
class RunConfig:
    """Configuration for a single sandbox run."""

    script: str
    proxy_url: str
    run_token: str = ""
    mode: str = "read_only"
    timeout_s: float = limits.WALL_CLOCK_TIMEOUT_S
    max_api_calls: int = limits.MAX_API_CALLS
    topic_allowlist: Optional[Iterable[str]] = None

    @staticmethod
    def from_dict(payload: Mapping[str, Any]) -> "RunConfig":
        if "script" not in payload:
            raise ValueError("run config missing 'script'")
        if "proxy_url" not in payload:
            raise ValueError("run config missing 'proxy_url'")
        return RunConfig(
            script=payload["script"],
            proxy_url=payload["proxy_url"],
            run_token=payload.get("run_token", ""),
            mode=payload.get("mode", "read_only"),
            timeout_s=float(payload.get("timeout_s", limits.WALL_CLOCK_TIMEOUT_S)),
            max_api_calls=int(payload.get("max_api_calls", limits.MAX_API_CALLS)),
            topic_allowlist=payload.get("topic_allowlist"),
        )


# Exit reasons surfaced in the result envelope. The MCP execute tool maps these
# to user-facing failure codes.
EXIT_COMPLETED = "completed"
EXIT_TIMEOUT = "timeout"
EXIT_SCRIPT_ERROR = "script_error"
EXIT_SANDBOX_STARTUP_FAILURE = "sandbox_startup_failure"
EXIT_RESULT_TOO_LARGE = "result_too_large"


def scrub_env(
    parent_env: Mapping[str, str], proxy_url: str, run_token: str
) -> dict:
    """Return the environment passed to the child Python interpreter.

    The child process needs a few host vars (PATH for the interpreter,
    PYTHONPATH so the medtracker helper package is importable). The bootstrap
    code running inside the child further strips everything except
    ``MEDTRACKER_PROXY_URL`` / ``MEDTRACKER_RUN_TOKEN`` before exec'ing the
    user script, so user code can never read host secrets.
    """

    env: dict = {}
    for key in limits.PARENT_PASSTHROUGH_ENV_KEYS:
        if key in parent_env:
            env[key] = parent_env[key]
    env["PYTHONPATH"] = _build_pythonpath(env.get("PYTHONPATH", ""))
    env["MEDTRACKER_PROXY_URL"] = proxy_url
    env["MEDTRACKER_RUN_TOKEN"] = run_token
    return env


def _build_pythonpath(existing: str) -> str:
    """Ensure the medtracker helper package is importable in the child.

    pytest sets ``pythonpath`` via its ini config, which doesn't propagate
    into ``os.environ``. The runner introspects the installed location of
    ``medtracker`` and prepends its parent directory so the child interpreter
    can ``import medtracker`` regardless of how the parent was launched.
    """

    try:
        import medtracker

        medtracker_root = os.path.dirname(os.path.dirname(os.path.abspath(medtracker.__file__)))
    except Exception:
        return existing

    parts = [medtracker_root]
    if existing:
        parts.extend(p for p in existing.split(os.pathsep) if p and p != medtracker_root)
    return os.pathsep.join(parts)


def truncate_bytes(data: bytes, limit: int) -> tuple[bytes, bool]:
    """Truncate ``data`` to ``limit`` bytes. Returns (data, was_truncated)."""

    if len(data) <= limit:
        return data, False
    return data[:limit], True


def _read_bounded(stream, limit: int, sink: list) -> None:
    """Drain ``stream`` while keeping at most ``limit`` bytes.

    The full pipe must be drained or the child can block on a full buffer.
    Bytes beyond the limit are discarded; ``sink`` receives a tuple of
    (kept_bytes, truncated_flag) when the stream closes.
    """

    buf = bytearray()
    truncated = False
    try:
        while True:
            chunk = stream.read(8192)
            if not chunk:
                break
            space = limit - len(buf)
            if space > 0:
                if len(chunk) <= space:
                    buf.extend(chunk)
                else:
                    buf.extend(chunk[:space])
                    truncated = True
            else:
                truncated = True
    except (OSError, ValueError):
        # Stream closed under us (e.g. process killed); preserve what we have.
        pass
    sink.append((bytes(buf), truncated))


# Bootstrap script that runs inside the child interpreter. It pre-imports the
# medtracker helper modules, removes every env var except the two the script is
# allowed to see, executes the user source in an isolated namespace, then
# writes the structured envelope to the path given by the parent.
_CHILD_BOOTSTRAP = r"""
import json
import os
import sys
import traceback

# Pre-import medtracker helpers so the user script's "from medtracker import ..."
# resolves out of sys.modules — PYTHONPATH may have been removed by the time
# the user script runs.
import medtracker  # noqa: F401
import medtracker.api  # noqa: F401
import medtracker.exceptions  # noqa: F401
import medtracker.output  # noqa: F401
# `medtracker.__init__` does `from medtracker.output import output`, which
# overwrites the package attribute `output` with the function. Pull the module
# out of sys.modules to call its private hooks.
_mt_output = sys.modules["medtracker.output"]

_runner_output_path = os.environ.pop("__RUNNER_OUTPUT_PATH__")
_runner_script_path = os.environ.pop("__RUNNER_SCRIPT_PATH__")

_allowed = {"MEDTRACKER_PROXY_URL", "MEDTRACKER_RUN_TOKEN"}
for _k in list(os.environ.keys()):
    if _k not in _allowed:
        del os.environ[_k]

_mt_output._reset()

with open(_runner_script_path, "r", encoding="utf-8") as _f:
    _source = _f.read()

_envelope = {"ok": True, "value": None, "output_set": False}
try:
    _compiled = compile(_source, "<user_script>", "exec")
    _user_globals = {"__name__": "__main__", "__builtins__": __builtins__}
    exec(_compiled, _user_globals)
    _envelope["output_set"] = _mt_output._is_output_set()
    if _envelope["output_set"]:
        _envelope["value"] = _mt_output._get_output()
except SystemExit as _e:
    _code = _e.code
    if _code in (0, None):
        _envelope["output_set"] = _mt_output._is_output_set()
        if _envelope["output_set"]:
            _envelope["value"] = _mt_output._get_output()
    else:
        _envelope = {
            "ok": False,
            "error_type": "SystemExit",
            "error_message": str(_code),
            "traceback": "",
        }
except BaseException as _e:
    _envelope = {
        "ok": False,
        "error_type": type(_e).__name__,
        "error_message": str(_e),
        "traceback": traceback.format_exc(),
    }

try:
    with open(_runner_output_path, "w", encoding="utf-8") as _f:
        json.dump(_envelope, _f)
except (TypeError, ValueError) as _e:
    with open(_runner_output_path, "w", encoding="utf-8") as _f:
        json.dump({
            "ok": False,
            "error_type": "SerializationError",
            "error_message": "output is not JSON-serializable: " + str(_e),
            "traceback": "",
        }, _f)

sys.exit(0 if _envelope.get("ok") else 1)
"""


def run(
    config: RunConfig,
    parent_env: Optional[Mapping[str, str]] = None,
    python_executable: Optional[str] = None,
) -> dict:
    """Execute ``config.script`` in a sandboxed subprocess.

    Returns a structured result envelope. Never raises for script-level errors
    — those become ``status: "error"`` with ``exit_reason`` set.
    """

    if parent_env is None:
        parent_env = os.environ
    if python_executable is None:
        python_executable = sys.executable

    workdir = tempfile.mkdtemp(prefix="medtracker_runner_")
    started_at = time.monotonic()
    try:
        script_path = os.path.join(workdir, "user_script.py")
        bootstrap_path = os.path.join(workdir, "bootstrap.py")
        output_path = os.path.join(workdir, "output.json")

        with open(script_path, "w", encoding="utf-8") as f:
            f.write(config.script)
        with open(bootstrap_path, "w", encoding="utf-8") as f:
            f.write(_CHILD_BOOTSTRAP)

        env = scrub_env(parent_env, config.proxy_url, config.run_token)
        env["__RUNNER_OUTPUT_PATH__"] = output_path
        env["__RUNNER_SCRIPT_PATH__"] = script_path

        try:
            proc = subprocess.Popen(
                [python_executable, bootstrap_path],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=workdir,
                start_new_session=True,
            )
        except OSError as e:
            return {
                "status": "error",
                "exit_reason": EXIT_SANDBOX_STARTUP_FAILURE,
                "result": None,
                "output_set": False,
                "stdout": "",
                "stderr": "",
                "warnings": [],
                "error_type": type(e).__name__,
                "error_message": str(e),
                "duration_ms": 0,
            }

        stdout_sink: list = []
        stderr_sink: list = []
        t_out = threading.Thread(
            target=_read_bounded,
            args=(proc.stdout, limits.STDOUT_LIMIT_BYTES, stdout_sink),
            daemon=True,
        )
        t_err = threading.Thread(
            target=_read_bounded,
            args=(proc.stderr, limits.STDERR_LIMIT_BYTES, stderr_sink),
            daemon=True,
        )
        t_out.start()
        t_err.start()

        timed_out = False
        try:
            proc.wait(timeout=config.timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            _kill_process_group(proc)
            try:
                proc.wait(timeout=5.0)
            except subprocess.TimeoutExpired:
                pass

        t_out.join(timeout=5.0)
        t_err.join(timeout=5.0)

        stdout_bytes, stdout_truncated = (
            stdout_sink[0] if stdout_sink else (b"", False)
        )
        stderr_bytes, stderr_truncated = (
            stderr_sink[0] if stderr_sink else (b"", False)
        )

        warnings: list = []
        if stdout_truncated:
            warnings.append("stdout truncated")
        if stderr_truncated:
            warnings.append("stderr truncated")

        stdout_text = stdout_bytes.decode("utf-8", errors="replace")
        stderr_text = stderr_bytes.decode("utf-8", errors="replace")
        duration_ms = int((time.monotonic() - started_at) * 1000)

        if timed_out:
            return {
                "status": "error",
                "exit_reason": EXIT_TIMEOUT,
                "result": None,
                "output_set": False,
                "stdout": stdout_text,
                "stderr": stderr_text,
                "warnings": warnings,
                "error_type": "Timeout",
                "error_message": (
                    f"script killed after {config.timeout_s}s wall-clock timeout"
                ),
                "duration_ms": duration_ms,
            }

        envelope = _read_envelope(output_path)
        if envelope is None:
            return {
                "status": "error",
                "exit_reason": EXIT_SANDBOX_STARTUP_FAILURE,
                "result": None,
                "output_set": False,
                "stdout": stdout_text,
                "stderr": stderr_text,
                "warnings": warnings,
                "error_type": "SandboxError",
                "error_message": "no output envelope produced by sandbox",
                "duration_ms": duration_ms,
            }

        if not envelope.get("ok"):
            return {
                "status": "error",
                "exit_reason": EXIT_SCRIPT_ERROR,
                "result": None,
                "output_set": False,
                "stdout": stdout_text,
                "stderr": stderr_text,
                "warnings": warnings,
                "error_type": envelope.get("error_type", "ScriptError"),
                "error_message": envelope.get("error_message", ""),
                "traceback": envelope.get("traceback", ""),
                "duration_ms": duration_ms,
            }

        value = envelope.get("value")
        try:
            value_size = len(json.dumps(value).encode("utf-8"))
        except (TypeError, ValueError) as e:
            return {
                "status": "error",
                "exit_reason": EXIT_SCRIPT_ERROR,
                "result": None,
                "output_set": envelope.get("output_set", False),
                "stdout": stdout_text,
                "stderr": stderr_text,
                "warnings": warnings,
                "error_type": "SerializationError",
                "error_message": f"output is not JSON-serializable: {e}",
                "duration_ms": duration_ms,
            }

        if value_size > limits.RESULT_SIZE_LIMIT_BYTES:
            return {
                "status": "error",
                "exit_reason": EXIT_RESULT_TOO_LARGE,
                "result": None,
                "output_set": envelope.get("output_set", False),
                "stdout": stdout_text,
                "stderr": stderr_text,
                "warnings": warnings,
                "error_type": "ResultTooLarge",
                "error_message": (
                    f"result size {value_size} exceeds limit "
                    f"{limits.RESULT_SIZE_LIMIT_BYTES}"
                ),
                "duration_ms": duration_ms,
            }

        return {
            "status": "ok",
            "exit_reason": EXIT_COMPLETED,
            "result": value,
            "output_set": envelope.get("output_set", False),
            "stdout": stdout_text,
            "stderr": stderr_text,
            "warnings": warnings,
            "duration_ms": duration_ms,
        }
    finally:
        try:
            shutil.rmtree(workdir)
        except OSError:
            pass


def _kill_process_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass


def _read_envelope(path: str) -> Optional[dict]:
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def main() -> int:
    """CLI entrypoint: read a run config JSON from stdin, write result to stdout."""

    payload = json.load(sys.stdin)
    config = RunConfig.from_dict(payload)
    result = run(config)
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    return 0 if result.get("status") == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
