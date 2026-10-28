"""Metric names shared with the dashboard. Prometheus adds the `service` and `instance`
labels from the container, so the metrics themselves only carry method/route/status.

Multiple worker processes (gunicorn -w 4, uvicorn --workers 4): set PROMETHEUS_MULTIPROC_DIR
to an empty directory before the workers start, and /metrics merges every worker's numbers.
"""

import asyncio
import os
import time
from collections import deque

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    REGISTRY,
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)

HTTP_REQUESTS = Counter("http_requests", "HTTP requests handled", ["method", "route", "status"])
HTTP_DURATION = Histogram(
    "http_request_duration_seconds",
    "HTTP request duration",
    ["method", "route", "status"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10),
)
HTTP_IN_FLIGHT = Gauge("http_requests_in_flight", "HTTP requests currently being handled", multiprocess_mode="livesum")

# Projects with queues set this so the dashboard's "oldest message age" panel has data:
#   QUEUE_OLDEST_MESSAGE_AGE.labels(queue="emails").set(age_seconds)
QUEUE_OLDEST_MESSAGE_AGE = Gauge(
    "lab_queue_oldest_message_age_seconds",
    "Age of the oldest message waiting in a queue",
    ["queue"],
    multiprocess_mode="max",
)

EVENT_LOOP_LAG = Gauge(
    "lab_event_loop_lag_seconds",
    "Worst asyncio event-loop delay over the last 5 seconds. Blocking code in an async handler shows up here.",
    multiprocess_mode="max",
)


def observe(method: str, route: str, status: int, seconds: float) -> None:
    labels = (method, route, str(status))
    HTTP_REQUESTS.labels(*labels).inc()
    HTTP_DURATION.labels(*labels).observe(seconds)


def metrics_payload() -> tuple[bytes, str]:
    """(body, content type) for a /metrics response."""
    if os.environ.get("PROMETHEUS_MULTIPROC_DIR"):
        from prometheus_client import multiprocess

        registry = CollectorRegistry()
        multiprocess.MultiProcessCollector(registry)
        return generate_latest(registry), CONTENT_TYPE_LATEST
    return generate_latest(REGISTRY), CONTENT_TYPE_LATEST


async def watch_event_loop(interval: float = 0.1, window: int = 50) -> None:
    """Sleeps `interval` over and over; anything beyond it is time the loop could not run."""
    samples: deque[float] = deque(maxlen=window)
    while True:
        start = time.perf_counter()
        await asyncio.sleep(interval)
        samples.append(max(0.0, time.perf_counter() - start - interval))
        EVENT_LOOP_LAG.set(max(samples))
