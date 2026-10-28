# Built from the repo root by docker-compose.override.yml (it needs shared/py-common).
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.12.9 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1
WORKDIR /lab
COPY shared/py-common shared/py-common
COPY projects/__P__-__NAME__/app projects/__P__-__NAME__/app
WORKDIR /lab/projects/__P__-__NAME__/app
RUN uv sync --locked --no-dev
ENV PATH="/lab/projects/__P__-__NAME__/app/.venv/bin:$PATH"
# Run from the project folder so `app` is the top-level package (imports are `from app...`).
WORKDIR /lab/projects/__P__-__NAME__
EXPOSE 8000
# One worker per container: scale with more containers (--scale app=N), so each replica
# is one process the dashboard and nginx can see.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
