import json
import logging
import os
import sys
from datetime import UTC, datetime

from labcommon.context import request_id

_RESERVED = set(vars(logging.makeLogRecord({}))) | {"message", "asctime", "taskName", "color_message"}


class JsonFormatter(logging.Formatter):
    """One JSON object per line: time, level, service, requestId, message, and any `extra=` fields."""

    def __init__(self, service: str):
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        line = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "service": self.service,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        rid = request_id()
        if rid:
            line["requestId"] = rid
        line.update({k: v for k, v in vars(record).items() if k not in _RESERVED})
        if record.exc_info:
            line["exc"] = self.formatException(record.exc_info)
        return json.dumps(line, default=str)


def configure_logging(level: str | None = None, service: str | None = None) -> None:
    """Route all logging (yours, uvicorn's, Django's, Celery's) through one JSON handler on stdout."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(service or os.environ.get("SERVICE_NAME", "unknown")))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel((level or os.environ.get("LOG_LEVEL", "INFO")).upper())
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "gunicorn.error", "django"):
        logging.getLogger(name).handlers[:] = []
        logging.getLogger(name).propagate = True


def get_logger(name: str = "app") -> logging.Logger:
    return logging.getLogger(name)
