from django.http import JsonResponse
from django.urls import path

from labcommon.django import health_view, metrics_view


def index(_request):
    return JsonResponse({"project": "__P__-__NAME__"})


urlpatterns = [
    path("", index),
    path("metrics", metrics_view),
    path("health", health_view),
]
