"""Project __P__: __NAME__ settings. Kept short on purpose; add apps with `uv run manage.py startapp`."""

import os
from urllib.parse import urlparse

from labcommon import configure_logging

DEBUG = os.environ.get("DEBUG", "0") == "1"
SECRET_KEY = os.environ.get("SECRET_KEY", "lab-only-not-a-secret")
ALLOWED_HOSTS = ["*"]
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
USE_TZ = True
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.auth",
]

MIDDLEWARE = [
    "labcommon.django.LabMiddleware",  # request ID + metrics, first so it times everything
    "django.middleware.common.CommonMiddleware",
]

# Inside Docker this comes from docker-compose.override.yml; the default works from the host.
_db = urlparse(os.environ.get("DATABASE_URL", "postgresql://lab:lab@localhost:5433/lab"))
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": _db.path.lstrip("/"),
        "USER": _db.username,
        "PASSWORD": _db.password,
        "HOST": _db.hostname,
        "PORT": _db.port or 5432,
        # 0 = a new connection per request. Count connections when you scale out:
        # instances x gunicorn workers must stay under max_connections (100).
        "CONN_MAX_AGE": int(os.environ.get("CONN_MAX_AGE", "0")),
    }
}

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
PARTNER_URL = os.environ.get("PARTNER_URL", "http://localhost:8080")

LOGGING_CONFIG = None  # labcommon owns logging: JSON lines with the request ID
configure_logging()
