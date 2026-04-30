class MedtrackerError(Exception):
    """Base class for all medtracker errors."""


class ProxyDenied(MedtrackerError):
    """Raised when the proxy rejects a call (unknown op, write blocked, auth failure)."""

    def __init__(self, message: str, status_code: int = None):
        super().__init__(message)
        self.status_code = status_code


class BackendError(MedtrackerError):
    """Raised when the backend returns a server-side error (5xx)."""

    def __init__(self, message: str, status_code: int = None):
        super().__init__(message)
        self.status_code = status_code


class BackendTransportError(MedtrackerError):
    """Raised when the executor cannot talk to the bridge or the bridge itself
    fails (HMAC mismatch, missing config, unknown operation). Distinct from
    BackendError so callers can tell a bot/bridge outage apart from an upstream
    application error."""

    def __init__(self, message: str, status_code: int = None):
        super().__init__(message)
        self.status_code = status_code


class BackendResponseTruncated(MedtrackerError):
    """Raised when the backend response exceeded the per-call size cap and
    was truncated by the bridge. Distinct from BackendTransportError so
    callers can pick a smaller window or pagination cursor and retry instead
    of acting on silently partial data."""

    def __init__(self, message: str, status_code: int = None):
        super().__init__(message)
        self.status_code = status_code


class TimeoutError(MedtrackerError):
    """Raised when the proxy call times out."""


class SerializationError(MedtrackerError):
    """Raised when the output value cannot be serialized to JSON."""
