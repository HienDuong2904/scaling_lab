"""FastAPI / Starlette integration: ``instrument(app)``.

Pure ASGI middleware (no BaseHTTPMiddleware), so it adds almost nothing per request and
works with streaming responses.
"""

import asyncio
import logging
import time
import uuid

from labcommon.context import reset_request_id, set_request_id
from labcommon.metrics import HTTP_IN_FLIGHT, metrics_payload, observe, watch_event_loop

log = logging.getLogger("labcommon.http")
SKIP = {"/metrics", "/health"}


class LabMiddleware:
    def __init__(self, app):
        self.app = app
        self.loop_watch: asyncio.Task | None = None

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        if self.loop_watch is None:
            self.loop_watch = asyncio.get_running_loop().create_task(watch_event_loop())

        rid = dict(scope.get("headers") or []).get(b"x-request-id", b"").decode() or str(uuid.uuid4())
        token = set_request_id(rid)
        status = 500

        async def send_with_id(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                message["headers"] = [*message.get("headers", []), (b"x-request-id", rid.encode())]
            await send(message)

        try:
            if scope["path"] in SKIP:
                return await self.app(scope, receive, send_with_id)
            start = time.perf_counter()
            HTTP_IN_FLIGHT.inc()
            try:
                await self.app(scope, receive, send_with_id)
            finally:
                HTTP_IN_FLIGHT.dec()
                seconds = time.perf_counter() - start
                # The route pattern (/customers/{id}), never the raw URL, to keep cardinality bounded.
                route = getattr(scope.get("route"), "path", None) or "unmatched"
                observe(scope["method"], route, status, seconds)
                if status >= 500:
                    log.warning(
                        "request failed",
                        extra={
                            "method": scope["method"],
                            "path": scope["path"],
                            "status": status,
                            "ms": round(seconds * 1000),
                        },
                    )
        finally:
            reset_request_id(token)


def instrument(app) -> None:
    """Adds the request-ID + metrics middleware, GET /metrics and GET /health."""
    from starlette.responses import JSONResponse, Response

    async def metrics(_request):
        body, content_type = metrics_payload()
        return Response(body, media_type=content_type)

    async def health(_request):
        return JSONResponse({"ok": True})

    app.add_route("/metrics", metrics, include_in_schema=False)
    app.add_route("/health", health, include_in_schema=False)
    app.add_middleware(LabMiddleware)
