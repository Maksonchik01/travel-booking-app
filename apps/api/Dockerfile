# Контекст збірки — корінь репозиторію (uv workspace).
FROM python:3.12-slim AS base
COPY --from=ghcr.io/astral-sh/uv:0.12.24 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"
WORKDIR /app

# Спершу лише залежності — кешуються, поки не змінився uv.lock.
COPY pyproject.toml uv.lock ./
COPY apps/api/pyproject.toml apps/api/pyproject.toml
COPY apps/worker/pyproject.toml apps/worker/pyproject.toml
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-workspace --package tickets-api

COPY apps/api apps/api
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --package tickets-api

RUN useradd --create-home --uid 10001 app
USER app
WORKDIR /app/apps/api
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"
CMD ["uvicorn", "tickets_api.asgi:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
