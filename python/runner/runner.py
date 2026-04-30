"""Sandboxed script runner.

The runner spawns a child Python process per run, applies a hard wall-clock
timeout, captures bounded stdout/stderr, scrubs the environment so that only
the proxy URL and run token reach the user script, and collects the final
``output(...)`` value through the ``medtracker`` helper package.

Runner-side prohibitions are enforced by the runner image and the limited
env passed to the script. In the long-term ``mcp-runner`` side-container
deployment they are full container-level boundaries; in the MVP in-process
executor they are operational shields and a script that breaks the
documented contract can still reach the parent's filesystem and network
namespace (see ``docs/mcp-python-executor.md`` § *Known MVP gap*).

- arbitrary HTTP: the env scrub leaves only ``MEDTRACKER_PROXY_URL`` (the
  local API proxy); the contract is that scripts must use
  ``medtracker.api.call`` to reach the backend. The runner image has no
  other documented network knob, but in the MVP in-process executor a
  script that imports ``urllib`` directly shares the parent's network.
- package installs: ``pip``/``setuptools`` write paths must be denied at
  the image level (read-only root FS in deployment); the runner does not
  invoke ``pip`` and the helper package is baked into the image.
- filesystem writes outside scratch: the runner provides a per-run scratch
  directory as ``cwd``; production deployment runs with read-only root.
- long-running loops: bounded by the wall-clock timeout (default 30 s);
  on expiry the runner sends SIGKILL to the process group. Subprocesses
  that escape the original PGID (``subprocess.Popen(start_new_session=True)``,
  ``os.setsid()``) are also caught: the runner sets
  PR_SET_CHILD_SUBREAPER on Linux so reparented grandchildren stay
  reachable via ``/proc``, then sweeps that tree on every cleanup path.
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
    # Record the fully-qualified type ("<module>.<qualname>") so the executor
    # can distinguish helper-raised exceptions (medtracker.exceptions.*) from
    # user-defined classes that happen to share a short name. Without the
    # module prefix, a script could `class ProxyDenied(Exception): pass` and
    # spoof the executor's status mapping.
    _et = type(_e)
    _et_module = getattr(_et, "__module__", "") or ""
    _et_qualname = getattr(_et, "__qualname__", "") or _et.__name__
    if _et_module and _et_module not in ("builtins", "__main__"):
        _qualified = _et_module + "." + _et_qualname
    else:
        _qualified = _et_qualname
    _envelope = {
        "ok": False,
        "error_type": _qualified,
        "error_message": str(_e),
        "traceback": traceback.format_exc(),
    }

try:
    with open(_runner_output_path, "w", encoding="utf-8") as _f:
        # allow_nan=False so a stray NaN/Infinity inside the envelope (from
        # the user value or any helper-recorded float) raises here instead
        # of being written as a non-standard JSON token that Go's
        # encoding/json would reject in the runner parent.
        json.dump(_envelope, _f, allow_nan=False)
except (TypeError, ValueError) as _e:
    with open(_runner_output_path, "w", encoding="utf-8") as _f:
        json.dump({
            "ok": False,
            "error_type": "SerializationError",
            "error_message": "output is not JSON-serializable: " + str(_e),
            "traceback": "",
        }, _f, allow_nan=False)

sys.exit(0 if _envelope.get("ok") else 1)
"""


_active_child_pgids: set = set()
_active_child_pgids_lock = threading.Lock()


def _register_active_pgid(pgid: int) -> None:
    with _active_child_pgids_lock:
        _active_child_pgids.add(pgid)


def _unregister_active_pgid(pgid: int) -> None:
    with _active_child_pgids_lock:
        _active_child_pgids.discard(pgid)


def _kill_all_active_pgids() -> None:
    with _active_child_pgids_lock:
        pgids = list(_active_child_pgids)
    for pgid in pgids:
        _kill_pgid(pgid)


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
    proc: Optional[subprocess.Popen] = None
    # PGID of the user-script process group. Captured immediately after Popen
    # because os.getpgid(pid) becomes unreliable once the child is reaped (the
    # pid may be reused). With start_new_session=True the child becomes session
    # leader, so its pgid equals its pid. Used by the finally block to ensure
    # any background subprocess the user script forked is reaped before the
    # runner returns.
    child_pgid: Optional[int] = None
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
                preexec_fn=_make_child_preexec(limits.MEMORY_LIMIT_BYTES),
            )
            child_pgid = proc.pid
            _register_active_pgid(child_pgid)
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
            _kill_pgid(child_pgid)
            try:
                proc.wait(timeout=5.0)
            except subprocess.TimeoutExpired:
                pass

        # Sweep descendants on every exit path (not just timeout) so any
        # subprocess that escaped the user-script PGID via
        # start_new_session=True / setsid is killed before the pipe-reader
        # joins below. A normally-exiting script can still leave a grandchild
        # holding stdout/stderr open; without this sweep both joins block for
        # their full 5s budget, pushing total runner cleanup past the Go-side
        # backstop. Reap killed descendants so they don't linger as zombies
        # owned by the runner (we hold subreaper status for the script's
        # session, so escaped grandchildren reparent here on script exit).
        _kill_descendants(os.getpid())
        _reap_subreaper_children()

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

        def _maybe_warn_no_output(env_dict: dict) -> None:
            # The MCP schema documents that scripts must call output() exactly
            # once. The runner still surfaces a status:ok result when the
            # script forgot to call it, but appends a warning so callers can
            # distinguish "output(None)" from "no output recorded".
            if not env_dict.get("output_set", False):
                warnings.append("output() was not called")

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

        if envelope.get("__envelope_too_large__"):
            # Pre-read size check tripped: the child wrote an envelope larger
            # than RESULT_SIZE_LIMIT_BYTES + frame overhead. Surface as a
            # result_too_large exit so the executor maps it to the same status
            # as the post-read per-value check.
            return {
                "status": "error",
                "exit_reason": EXIT_RESULT_TOO_LARGE,
                "result": None,
                "output_set": False,
                "stdout": stdout_text,
                "stderr": stderr_text,
                "warnings": warnings,
                "error_type": "ResultTooLarge",
                "error_message": envelope.get("error_message", "envelope size exceeds limit"),
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
            value_size = len(json.dumps(value, allow_nan=False).encode("utf-8"))
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

        _maybe_warn_no_output(envelope)
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
        # Kill the user-script process group on every exit path. The script's
        # bootstrap process has typically already exited by the time we get
        # here, but a script that spawned a background subprocess (via
        # subprocess.Popen, multiprocessing, fork, etc.) can leave grandchildren
        # alive. Without this they outlive the run, defeating the wall-clock
        # bound and leaking work into the parent's process namespace.
        if child_pgid is not None:
            _kill_pgid(child_pgid)
            _unregister_active_pgid(child_pgid)
        if proc is not None:
            try:
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                pass
        # PGID-only cleanup misses descendants the script forked into a new
        # session (subprocess.Popen(start_new_session=True), os.setsid()). When
        # the runner's main() has set itself as a child subreaper, those
        # grandchildren get reparented to the runner process instead of init,
        # so a /proc walk rooted at our PID can find and kill them too. Reap
        # zombies after SIGKILL so the runner doesn't accumulate dead PIDs that
        # /proc still surfaces as living descendants on the next run.
        _kill_descendants(os.getpid())
        _reap_subreaper_children()
        try:
            shutil.rmtree(workdir)
        except OSError:
            pass


def _make_child_preexec(memory_bytes: int):
    """Return a callable applied in the child after fork, before exec.

    Sets RLIMIT_AS so a memory-hungry script gets killed by the kernel before
    it can exhaust the parent process's address space. Best-effort: platforms
    or environments that reject the rlimit (e.g. existing soft limit lower
    than ``memory_bytes``) silently fall back to the wall-clock timeout as the
    only bound. Documented in docs/mcp-python-executor.md as the MVP shield.
    """

    def _apply() -> None:
        try:
            import resource

            resource.setrlimit(
                resource.RLIMIT_AS, (memory_bytes, memory_bytes)
            )
        except (ImportError, ValueError, OSError, AttributeError):
            # resource module unavailable, or kernel rejected the limit.
            # The wall-clock timeout still bounds the run.
            pass

    return _apply


def _kill_pgid(pgid: Optional[int]) -> None:
    """Best-effort SIGKILL to the user-script process group.

    Safe to call multiple times and after the original leader has been reaped.
    A no-op when ``pgid`` is None (the runner never managed to spawn the child)
    or when the group has already been torn down by the kernel.
    """

    if pgid is None:
        return
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass


def _enable_child_subreaper() -> None:
    """Mark this process as a child subreaper (Linux 3.4+).

    With the subreaper bit set, descendants whose direct parent exits get
    reparented to us instead of init/PID 1. The runner uses this to keep an
    ownership claim on grandchildren a user script forks via
    ``subprocess.Popen(..., start_new_session=True)`` or ``os.setsid()``;
    without subreaper status those processes would escape the runner's
    process group cleanup and outlive the wall-clock bound. Best-effort: on
    non-Linux platforms or older kernels the prctl call fails and we fall
    back to PGID-only cleanup.
    """

    try:
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        # PR_SET_CHILD_SUBREAPER == 36 on Linux. Hard-coded because there's no
        # portable Python constant; on non-Linux the prctl symbol is missing
        # and the AttributeError below catches it.
        libc.prctl(36, 1, 0, 0, 0)
    except (OSError, AttributeError):
        pass


def _kill_descendants(root_pid: int) -> None:
    """Best-effort SIGKILL to every descendant of ``root_pid``.

    Walks ``/proc`` (Linux only) to build a parent→children map and BFS from
    ``root_pid``. Catches descendants that escaped the runner's original PGID
    via ``subprocess.Popen(..., start_new_session=True)`` or ``os.setsid()``;
    when combined with PR_SET_CHILD_SUBREAPER it also catches grandchildren
    whose direct parent has already exited (and would otherwise be reparented
    to PID 1).

    No-op on platforms without ``/proc`` (Darwin, BSD, Windows) — production
    deployment is Linux. Errors reading ``/proc`` are swallowed because this
    is a teardown path that must not raise.
    """

    if not os.path.isdir("/proc"):
        return

    children: dict = {}
    try:
        entries = os.listdir("/proc")
    except OSError:
        return
    for entry in entries:
        if not entry.isdigit():
            continue
        try:
            with open("/proc/" + entry + "/stat", "rb") as f:
                data = f.read()
        except (OSError, ValueError):
            continue
        # /proc/<pid>/stat: "pid (comm) state ppid ..."  comm may contain
        # spaces and parens, so split on the last ')' rather than whitespace.
        try:
            rparen = data.rindex(b")")
            fields = data[rparen + 2:].split()
            ppid = int(fields[1])
            pid = int(entry)
        except (ValueError, IndexError):
            continue
        children.setdefault(ppid, []).append(pid)

    seen: set = set()
    queue = [root_pid]
    descendants: list = []
    while queue:
        parent = queue.pop()
        for child in children.get(parent, ()):
            if child in seen or child == os.getpid():
                continue
            seen.add(child)
            descendants.append(child)
            queue.append(child)

    for pid in descendants:
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass


def _reap_subreaper_children() -> None:
    """Best-effort reap of any zombies owned by this process.

    With PR_SET_CHILD_SUBREAPER set, descendants whose direct parent exits
    reparent to us. After ``_kill_descendants`` SIGKILLs them they linger as
    zombies until ``waitpid`` is called. Without this, a /proc walk (or a
    ``kill(pid, 0)`` probe) still finds the dead PID and treats the cleanup
    as failed. Loop with ``WNOHANG`` so we never block on a child that
    hasn't exited yet — a subsequent sweep iteration will catch it.
    """

    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except (ChildProcessError, OSError):
            return
        if pid == 0:
            return


def _read_envelope(path: str) -> Optional[dict]:
    if not os.path.exists(path):
        return None
    try:
        size = os.path.getsize(path)
    except OSError:
        return None
    # Guard against a script that writes a value far above
    # RESULT_SIZE_LIMIT_BYTES but below the child's RLIMIT_AS cap: without a
    # pre-read size check the parent would json.load the whole envelope into
    # memory before the per-value size check at run() rejects it. Allow a
    # small frame for envelope keys/traceback on top of the value cap.
    if size > limits.RESULT_SIZE_LIMIT_BYTES + _ENVELOPE_FRAME_OVERHEAD:
        return {
            "ok": False,
            "error_type": "ResultTooLarge",
            "error_message": (
                f"output envelope size {size} exceeds limit "
                f"{limits.RESULT_SIZE_LIMIT_BYTES + _ENVELOPE_FRAME_OVERHEAD}"
            ),
            "traceback": "",
            "__envelope_too_large__": True,
        }
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


# _ENVELOPE_FRAME_OVERHEAD is the slack we allow on top of
# RESULT_SIZE_LIMIT_BYTES for the envelope's own keys (ok, output_set,
# error_type, error_message, traceback). 1 MiB is generous: traceback strings
# from large stack dumps fit comfortably and the cap is still well below the
# child's RLIMIT_AS.
_ENVELOPE_FRAME_OVERHEAD: int = 1 * 1024 * 1024


def _install_termination_handlers() -> None:
    """Reap active child process groups on SIGTERM / SIGINT.

    The Go-side executor cancels the runner with SIGTERM (with a SIGKILL
    fallback after a grace period) so that runaway scripts and any background
    subprocesses they spawned are cleaned up rather than reparented to init
    when the runner itself is killed. SIGKILL is uncatchable, so this is
    best-effort: it covers controlled termination, while the Go side enforces
    descendant cleanup via process-group ID for the SIGKILL path.
    """

    def _handler(signum, _frame) -> None:
        _kill_all_active_pgids()
        # Sweep any descendants that escaped the original PGID via setsid /
        # start_new_session. Subreaper status (set in main()) keeps them
        # parented to the runner so /proc still finds them.
        _kill_descendants(os.getpid())
        # Re-raise as the default disposition so the parent exits promptly.
        signal.signal(signum, signal.SIG_DFL)
        os.kill(os.getpid(), signum)

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _handler)
        except (ValueError, OSError):
            # Not running on the main thread or signal not supported here.
            pass


def main() -> int:
    """CLI entrypoint: read a run config JSON from stdin, write result to stdout."""

    # Claim subreaper status before spawning the child so any grandchild the
    # user script forks into a new session reparents to us (not init) when
    # its direct parent exits. This is what makes the /proc walk in
    # _kill_descendants effective at enforcing the wall-clock bound against
    # subprocesses that called setsid / start_new_session.
    _enable_child_subreaper()
    _install_termination_handlers()
    payload = json.load(sys.stdin)
    config = RunConfig.from_dict(payload)
    result = run(config)
    # allow_nan=False so the envelope is always strict JSON. Go's
    # encoding/json rejects NaN/Infinity, so emitting a non-standard token
    # here would turn a script-level serialization issue into an
    # invalid_runner_envelope status on the executor instead of a clean
    # script_error.
    json.dump(result, sys.stdout, allow_nan=False)
    sys.stdout.write("\n")
    return 0 if result.get("status") == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
