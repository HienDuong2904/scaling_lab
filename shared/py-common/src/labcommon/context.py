import uuid
from contextvars import ContextVar

_request_id: ContextVar[str | None] = ContextVar("request_id", default=None)


def request_id() -> str | None:
    """The current request's ID, or None outside a request."""
    return _request_id.get()


def set_request_id(value: str | None):
    """Sets the request ID (a new UUID if value is empty) and returns the reset token."""
    return _request_id.set(value or str(uuid.uuid4()))


def reset_request_id(token) -> None:
    _request_id.reset(token)


def propagation_headers() -> dict[str, str]:
    """Headers to pass on outbound calls so one request ID follows the whole chain:
    ``httpx.get(url, headers=propagation_headers())``."""
    rid = _request_id.get()
    return {"x-request-id": rid} if rid else {}
