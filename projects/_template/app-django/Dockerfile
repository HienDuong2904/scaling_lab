# Built from the repo root by docker-compose.override.yml (it needs shared/py-common).
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.12.9 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1
WORKDIR /lab
COPY shared/py-common shared/py-common
COPY projects/__P__-__NAME__/app projects/__P__-__NAME__/app
WORKDIR /lab/projects/__P__-__NAME__/app
RUN uv sync --locked --no-dev
ENV PATH="/lab/projects/__P__-__NAME__/app/.venv/bin:$PATH" \
    DJANGO_SETTINGS_MODULE=config.settings \
    PROMETHEUS_MULTIPROC_DIR=/tmp/prometheus
EXPOSE 8000
CMD ["gunicorn", "config.wsgi", "-c", "gunicorn.conf.py"]
