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


class TimeoutError(MedtrackerError):
    """Raised when the proxy call times out."""


class SerializationError(MedtrackerError):
    """Raised when the output value cannot be serialized to JSON."""
