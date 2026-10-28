# Build from the repo root: docker build -f shared/hello/Dockerfile .
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.12.9 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1
WORKDIR /lab
COPY shared/py-common shared/py-common
COPY shared/hello shared/hello
WORKDIR /lab/shared/hello
RUN uv sync --locked --no-dev
ENV PATH="/lab/shared/hello/.venv/bin:$PATH"
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
