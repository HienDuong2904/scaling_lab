"""Project 0's hello-world endpoint: the target of the smoke test that proves
load generator -> service -> Prometheus -> Grafana is wired end to end."""

import asyncio
import os
import random

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from labcommon import configure_logging
from labcommon.fastapi import instrument

configure_logging()
app = FastAPI(title="hello")
instrument(app)


@app.get("/hello")
async def hello(sleep: int = 0, fail: float = 0.0):
    """?sleep=ms adds latency, ?fail=0.1 fails that fraction with a 500: enough to see the
    latency and error panels move without touching another service."""
    if sleep > 0:
        await asyncio.sleep(min(sleep, 30_000) / 1000)
    if random.random() < fail:
        return JSONResponse({"error": "injected failure"}, status_code=500)
    return {"hello": "world", "instance": os.environ.get("HOSTNAME")}
