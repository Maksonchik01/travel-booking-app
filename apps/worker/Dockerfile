# Контекст збірки — корінь репозиторію (uv workspace).
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.12.24 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"
WORKDIR /app

COPY pyproject.toml uv.lock ./
COPY apps/api/pyproject.toml apps/api/pyproject.toml
COPY apps/worker/pyproject.toml apps/worker/pyproject.toml
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-workspace --package tickets-worker

COPY apps/api apps/api
COPY apps/worker apps/worker
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --package tickets-worker

RUN useradd --create-home --uid 10001 app
USER app
CMD ["arq", "tickets_worker.settings.WorkerSettings"]
