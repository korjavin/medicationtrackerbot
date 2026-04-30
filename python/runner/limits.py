"""Default sandbox limits for runner-executed scripts.

Mirrors the table in docs/mcp-python-executor.md ("Runtime Limits"). Server
configuration may cap or override these at run time, but the runner enforces
them as defaults when the caller does not provide explicit values.
"""

WALL_CLOCK_TIMEOUT_S: float = 30.0
MEMORY_LIMIT_BYTES: int = 1 * 1024 * 1024 * 1024
RESULT_SIZE_LIMIT_BYTES: int = 100 * 1024 * 1024
MAX_API_CALLS: int = 100

STDOUT_LIMIT_BYTES: int = 1 * 1024 * 1024
STDERR_LIMIT_BYTES: int = 256 * 1024

RESPONSE_BODY_LIMIT_BYTES: int = 10 * 1024 * 1024
REQUEST_BODY_LIMIT_BYTES: int = 1 * 1024 * 1024


SCRIPT_ALLOWED_ENV_KEYS: frozenset = frozenset(
    {"MEDTRACKER_PROXY_URL", "MEDTRACKER_RUN_TOKEN"}
)

PARENT_PASSTHROUGH_ENV_KEYS: tuple = (
    "PATH",
    "PYTHONPATH",
    "PYTHONHOME",
    "PYTHONIOENCODING",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "HOME",
    "TMPDIR",
)
