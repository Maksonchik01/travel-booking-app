.PHONY: help install up up-full down logs migrate lint format typecheck test test-integration e2e gen-types check

help:  ## Список команд
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-18s %s\n", $$1, $$2}'

install:  ## Встановити залежності (uv + npm)
	uv sync
	npm install

up:  ## Dev: бекенд у Docker з hot reload + web на хості (http://localhost:3000)
	docker compose up -d --build postgres redis migrate api worker
	npm run dev -w @tickets/web

up-full:  ## Увесь стек у Docker як у проді (web — standalone-збірка)
	docker compose -f docker-compose.yml up -d --build

down:  ## Зупинити стек
	docker compose down

logs:  ## Логи всіх сервісів
	docker compose logs -f

migrate:  ## Застосувати міграції до локальної БД
	uv run alembic -c apps/api/alembic.ini upgrade head

lint:  ## Лінтери (ruff, eslint, prettier)
	uv run ruff check .
	uv run ruff format --check .
	npm run lint

format:  ## Автоформатування
	uv run ruff check --fix .
	uv run ruff format .
	npm run format -w @tickets/web

typecheck:  ## Перевірка типів (mypy, tsc)
	uv run mypy apps/api/src apps/worker/src apps/api/tests apps/worker/tests apps/api/migrations/env.py
	npm run typecheck

test:  ## Юніт-тести (pytest, vitest)
	uv run pytest
	npm test

test-integration:  ## Інтеграційні тести проти Postgres і Redis з docker compose
	docker compose up -d postgres redis
	TEST_DATABASE_URL=postgresql+asyncpg://tickets:tickets@localhost:5432/tickets \
	TEST_REDIS_URL=redis://localhost:6379/0 uv run pytest -m integration

e2e:  ## Playwright smoke-тест (потребує збірки web)
	npm run build -w @tickets/web
	npm run test:e2e -w @tickets/web

gen-types:  ## Згенерувати TS-типи з OpenAPI в packages/shared
	npm run gen:types

check: lint typecheck test  ## Усе, що перевіряє CI
