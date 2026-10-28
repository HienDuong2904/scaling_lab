# Scaling lab commands. `make help` lists them.
SHELL := /bin/bash
.DEFAULT_GOAL := help

-include .env
POSTGRES_USER ?= lab
POSTGRES_DB ?= lab

# p=NN selects a project: its docker-compose.override.yml is added and `load` finds its scripts.
p ?=
t ?=
stack ?= fastapi
OVERRIDE := $(if $(p),$(firstword $(wildcard projects/$(p)-*/docker-compose.override.yml)))
DC := docker compose -f docker-compose.yml $(if $(OVERRIDE),-f $(OVERRIDE))
PSQL := $(DC) exec -T postgres psql -U $(POSTGRES_USER) -d $(POSTGRES_DB) -v ON_ERROR_STOP=1
K6 := $(DC) run --rm k6 run -o experimental-prometheus-rw
PARTNER := http://localhost:$(or $(FAKE_PARTNER_PORT),8080)
STAMP = $(shell date +%Y%m%d-%H%M%S)

.PHONY: help up down restart nuke ps logs urls psql redis-cli smoke load \
        seed-orders seed-products seed-messages seed-documents seed-all \
        partner partner-reset partner-stats new dev test lint fmt typecheck check partner-typecheck

help: ## Show this list
	@grep -hE '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@echo; echo "  Examples: make up · make smoke · make up p=01 · make load p=01 t=ramp · make seed-orders rows=50000000"

.env:
	cp .env.example .env

up: .env ## Start the lab. p=NN adds that project's services and nginx; n=5 runs 5 app replicas
	$(DC) $(if $(OVERRIDE),--profile lb) up -d --build --wait --remove-orphans $(if $(n),--scale app=$(n))
	@$(MAKE) --no-print-directory urls

down: ## Stop everything, keep data
	$(DC) --profile lb --profile tools down --remove-orphans

restart: down up ## Stop then start

nuke: ## Stop everything and DELETE all data volumes (Postgres, Redis, MinIO, Prometheus)
	$(DC) --profile lb --profile tools down --volumes --remove-orphans

ps: ## Show containers and health
	$(DC) ps

logs: ## Follow logs (s=service for one)
	$(DC) logs -f --tail=100 $(s)

urls: ## Print the lab's URLs
	@echo "  Grafana       http://localhost:$(or $(GRAFANA_PORT),3001)"
	@echo "  Prometheus    http://localhost:$(or $(PROMETHEUS_PORT),9090)/targets"
	@echo "  MinIO         http://localhost:$(or $(MINIO_UI_PORT),9001)  ($(or $(MINIO_ROOT_USER),lab) / $(or $(MINIO_ROOT_PASSWORD),lab-secret))"
	@echo "  Fake partner  $(PARTNER)/admin/config"
	@echo "  Hello         http://localhost:$(or $(HELLO_PORT),3100)/hello"
	@$(if $(OVERRIDE),echo "  Project $(p)    http://localhost:$(or $(NGINX_PORT),8000)  (nginx in front of every app replica)")
	@echo "  Postgres      postgresql://$(POSTGRES_USER):$(or $(POSTGRES_PASSWORD),lab)@localhost:$(or $(PG_PORT),5433)/$(POSTGRES_DB)"
	@echo "  Redis         redis://localhost:$(or $(REDIS_PORT),6379)"

psql: ## Open psql in the lab database
	$(DC) exec postgres psql -U $(POSTGRES_USER) -d $(POSTGRES_DB)

redis-cli: ## Open redis-cli
	$(DC) exec redis redis-cli

smoke: ## Project 0 check: 30 s of k6 against /hello (rate=200), then look at Grafana
	$(K6) --tag testid=smoke-$(STAMP) -e RATE=$(or $(rate),200) shared/k6-lib/hello.js

load: ## Run a project's load test: make load p=01 t=ramp  (runs projects/01-*/load/*ramp*.js)
	@test -n "$(p)" -a -n "$(t)" || { echo "usage: make load p=01 t=ramp"; exit 1; }
	$(eval SCRIPT := $(firstword $(wildcard projects/$(p)-*/load/*$(t)*.js)))
	@test -n "$(SCRIPT)" || { echo "no script matches projects/$(p)-*/load/*$(t)*.js"; exit 1; }
	$(K6) --tag testid=p$(p)-$(t)-$(STAMP) $(K6_ARGS) $(SCRIPT)

seed-orders: ## Seed tenants, customers, orders, order_items (rows=1000000; items=0 skips items)
	$(PSQL) $(if $(rows),-v rows=$(rows)) $(if $(items),-v items=$(items)) -f /seed/orders.sql

seed-products: ## Seed products (rows=100000)
	$(PSQL) $(if $(rows),-v rows=$(rows)) -f /seed/products.sql

seed-messages: ## Seed rooms and messages (rows=1000000)
	$(PSQL) $(if $(rows),-v rows=$(rows)) -f /seed/messages.sql

seed-documents: ## Seed documents and chunks with embeddings (rows=10000 chunks=10)
	$(PSQL) $(if $(rows),-v rows=$(rows)) $(if $(chunks),-v chunks=$(chunks)) -f /seed/documents.sql

seed-all: seed-orders seed-products seed-messages seed-documents ## All datasets at default sizes

partner: ## Show the fake partner's knobs, or change them: make partner set='{"latencyMs":100}'
	@$(if $(set),curl -sf -X POST $(PARTNER)/admin/config -H 'content-type: application/json' -d '$(set)',curl -sf $(PARTNER)/admin/config) | python3 -m json.tool

partner-reset: ## Fake partner back to defaults, counters cleared
	@curl -sf -X POST $(PARTNER)/admin/reset >/dev/null && echo "fake partner reset"

partner-stats: ## Fake partner counters: faults injected, webhooks, LLM tokens and cost
	@curl -sf $(PARTNER)/admin/stats | python3 -m json.tool

new: ## New project folder: make new p=01 name=high-traffic [stack=fastapi|django]
	@test -n "$(p)" -a -n "$(name)" || { echo "usage: make new p=01 name=high-traffic [stack=fastapi|django]"; exit 1; }
	@test -d projects/_template/app-$(stack) || { echo "stack must be fastapi or django"; exit 1; }
	@test ! -e projects/$(p)-$(name) || { echo "projects/$(p)-$(name) already exists"; exit 1; }
	mkdir -p projects/$(p)-$(name)
	cp -r projects/_template/README.md projects/_template/RESULTS.md projects/_template/docker-compose.override.yml projects/_template/load projects/$(p)-$(name)/
	cp -r projects/_template/app-$(stack) projects/$(p)-$(name)/app
	grep -rlE '__P__|__NAME__' projects/$(p)-$(name) | xargs sed -i 's/__P__/$(p)/g; s/__NAME__/$(name)/g'
	cd projects/$(p)-$(name)/app && uv lock -q
	@echo "created projects/$(p)-$(name) ($(stack)). Next: make up p=$(p), then http://localhost:8000"

# --- Python projects: lint and format cover the whole repo; the rest take p=NN ---

RUFF := uvx ruff@0.17.3
PROJECT_DIR = $(firstword $(wildcard projects/$(p)-*))
need-p = @test -n "$(PROJECT_DIR)" || { echo "usage: make $@ p=NN (no projects/$(p)-* folder)"; exit 1; }

dev: ## Run a project's app on your host with reload, against the lab: make dev p=01 (http://localhost:8100)
	$(need-p)
	@if [ -f $(PROJECT_DIR)/app/manage.py ]; then \
	  cd $(PROJECT_DIR)/app && uv run python manage.py runserver 8100; \
	else \
	  cd $(PROJECT_DIR) && uv run --project app uvicorn app.main:app --reload --port 8100; \
	fi

test: ## Run a project's tests (the lab must be up): make test p=01 [k=expr]
	$(need-p)
	cd $(PROJECT_DIR)/app && uv run pytest $(if $(k),-k "$(k)")

lint: ## Lint all Python with Ruff (fix=1 applies safe fixes)
	$(RUFF) check $(if $(fix),--fix) .

fmt: ## Format all Python with Ruff and sort imports
	$(RUFF) check --select I --fix .
	$(RUFF) format .

typecheck: ## Type-check a project with mypy: make typecheck p=01
	$(need-p)
	cd $(PROJECT_DIR)/app && uv run mypy .

check: ## Everything CI would run for a project: make check p=01
	$(need-p)
	$(RUFF) check $(PROJECT_DIR) shared/py-common
	$(RUFF) format --check $(PROJECT_DIR) shared/py-common
	@$(MAKE) --no-print-directory typecheck test p=$(p)

partner-typecheck: ## Type-check the fake partner (TypeScript)
	npx tsc -p tsconfig.json
