"""Gunicorn settings. Several worker processes share one /metrics through
PROMETHEUS_MULTIPROC_DIR, which must be emptied before the workers start."""

import os
import shutil

bind = "0.0.0.0:8000"
workers = int(os.environ.get("WEB_CONCURRENCY", "4"))
timeout = 30
accesslog = None


def on_starting(server):
    path = os.environ.get("PROMETHEUS_MULTIPROC_DIR")
    if path:
        shutil.rmtree(path, ignore_errors=True)
        os.makedirs(path, exist_ok=True)


def child_exit(server, worker):
    if os.environ.get("PROMETHEUS_MULTIPROC_DIR"):
        from prometheus_client import multiprocess

        multiprocess.mark_process_dead(worker.pid)
