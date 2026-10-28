"""Django integration.

settings.py::

    MIDDLEWARE = ["labcommon.django.LabMiddleware", *MIDDLEWARE]

urls.py::

    from labcommon.django import health_view, metrics_view
    urlpatterns = [path("metrics", metrics_view), path("health", health_view), ...]

With gunicorn's several workers, set PROMETHEUS_MULTIPROC_DIR (see the Django template's
gunicorn.conf.py) so /metrics adds up every worker instead of reporting a random one.
"""

import logging
import time

from django.http import HttpResponse, JsonResponse

from labcommon.context import request_id, reset_request_id, set_request_id
from labcommon.metrics import HTTP_IN_FLIGHT, metrics_payload, observe

log = logging.getLogger("labcommon.http")
SKIP = {"/metrics", "/health"}


class LabMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        token = set_request_id(request.headers.get("x-request-id"))
        try:
            if request.path in SKIP:
                response = self.get_response(request)
                response["x-request-id"] = request_id()
                return response
            start = time.perf_counter()
            HTTP_IN_FLIGHT.inc()
            status = 500
            try:
                response = self.get_response(request)
                status = response.status_code
                response["x-request-id"] = request_id()
                return response
            finally:
                HTTP_IN_FLIGHT.dec()
                seconds = time.perf_counter() - start
                match = getattr(request, "resolver_match", None)
                # The URL pattern ("/orders/<int:pk>"), never the raw path, to keep cardinality bounded.
                route = f"/{match.route}" if match else "unmatched"
                observe(request.method, route, status, seconds)
                if status >= 500:
                    log.warning(
                        "request failed",
                        extra={
                            "method": request.method,
                            "path": request.path,
                            "status": status,
                            "ms": round(seconds * 1000),
                        },
                    )
        finally:
            reset_request_id(token)


def metrics_view(_request):
    body, content_type = metrics_payload()
    return HttpResponse(body, content_type=content_type)


def health_view(_request):
    return JsonResponse({"ok": True})
