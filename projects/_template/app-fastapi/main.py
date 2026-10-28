"""Project __P__: __NAME__.

Run in the lab:   make up p=__P__     (http://localhost:8000, through nginx)
Run on the host:  make dev p=__P__    (http://localhost:8100, reloads on save)

`app` is a package: run it from the project folder as `app.main:app`, import with `from app...`.
"""

import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from labcommon import configure_logging, get_logger
from labcommon.fastapi import instrument

# Inside Docker these come from docker-compose.override.yml; the defaults work from the host.
DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://lab:lab@localhost:5433/lab")
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
PARTNER_URL = os.environ.get("PARTNER_URL", "http://localhost:8080")

configure_logging()
log = get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # Open connection pools here (asyncpg / psycopg pool, redis.asyncio, httpx.AsyncClient)
    # and close them after the yield.
    log.info("starting")
    yield


app = FastAPI(title="p__P__-__NAME__", lifespan=lifespan)
instrument(app)


@app.get("/")
async def index() -> dict[str, str]:
    return {"project": "__P__-__NAME__"}
