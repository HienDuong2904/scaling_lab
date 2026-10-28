"""Shared plumbing for every Python service in the lab.

- JSON logs that carry the current request ID on every line,
- request-ID propagation (read or create ``x-request-id``, pass it on outbound calls),
- HTTP metrics with the names the shared Grafana dashboard queries.

FastAPI::

    from labcommon import configure_logging
    from labcommon.fastapi import instrument
    configure_logging()
    app = FastAPI()
    instrument(app)          # middleware + /metrics + /health

Django: see ``labcommon.django``.
"""

from labcommon.context import propagation_headers, request_id
from labcommon.logs import configure_logging, get_logger
from labcommon.metrics import (
    HTTP_DURATION,
    HTTP_IN_FLIGHT,
    HTTP_REQUESTS,
    QUEUE_OLDEST_MESSAGE_AGE,
    metrics_payload,
)

__all__ = [
    "HTTP_DURATION",
    "HTTP_IN_FLIGHT",
    "HTTP_REQUESTS",
    "QUEUE_OLDEST_MESSAGE_AGE",
    "configure_logging",
    "get_logger",
    "metrics_payload",
    "propagation_headers",
    "request_id",
]
