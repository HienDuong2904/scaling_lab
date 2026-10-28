# scaling-lab

Twelve scaling projects on one shared lab. Each one: set the number, build it naive, break it,
fix one thing at a time, write the story.

The apps are Python: FastAPI or Django, with Celery for background work. Load tests are k6 (JavaScript,
the only language k6 runs), and the fake third-party API is a small Node service you call but never change.

## Quick start

```bash
sudo apt install -y make     # once, if `make` is missing (uv is needed too: https://docs.astral.sh/uv/)
make up                      # start the shared lab (creates .env from .env.example)
make smoke                   # 30 s of k6 against /hello
open http://localhost:3001   # Grafana: the "Scaling Lab" dashboard is the home page
```

Project 0 is done when the smoke test's traffic shows on the dashboard.

## What is running

| Service | URL / port | Notes |
| --- | --- | --- |
| Grafana | http://localhost:3001 | No login. One dashboard for every project |
| Prometheus | http://localhost:9090 | Also receives k6 results (remote write) |
| Postgres 16 | `localhost:5433`, `lab`/`lab`, db `lab` | pg_stat_statements, pgvector, pg_trgm; `max_connections = 100` |
| Redis 7 | `localhost:6379` | Cache, locks, pub/sub and the Celery broker. AOF on (fsync every second), 1 GB, `noeviction` |
| MinIO | `localhost:9000`, UI http://localhost:9001 (`lab`/`lab-secret`) | Buckets: uploads, exports, imports, documents |
| Toxiproxy | API `localhost:8474` | Proxies below |
| Fake partner | http://localhost:8080 | See below |
| Hello | http://localhost:3100/hello | FastAPI smoke-test target (`?sleep=ms`, `?fail=0.1`) |
| nginx | http://localhost:8000 | Started by `make up p=NN`, in front of every replica of that project's `app` |
| cAdvisor, exporters | | CPU/memory per container, Postgres, Redis |

Queues run on Redis (Celery's Redis broker) instead of RabbitMQ. Queue depth shows on the dashboard with no
app code for the default `celery` queue and **every queue named `q.<name>`** (e.g. `q.emails`, `q.urgent`), so
name your queues that way.

Host ports live in `.env`. Postgres uses 5433 because 5432 is usually taken by another local Postgres.
Inside the Docker network, use service names and container ports (`postgres:5432`, `redis:6379`, `fake-partner:8080`).

**Toxiproxy proxies** (point a service at these to inject faults):

| Proxy | Inside Docker | From the host | Upstream |
| --- | --- | --- | --- |
| partner | `toxiproxy:18080` | `localhost:18080` | fake-partner:8080 |
| minio | `toxiproxy:19000` | `localhost:19000` | minio:9000 |
| postgres | `toxiproxy:15432` | `localhost:15432` | postgres:5432 |
| redis | `toxiproxy:16379` | `localhost:16379` | redis:6379 |

```bash
curl -X POST localhost:8474/proxies/partner/toxics -d '{"name":"slow","type":"latency","attributes":{"latency":1000}}'
curl -X DELETE localhost:8474/proxies/partner/toxics/slow
curl -X POST localhost:8474/proxies/redis -d '{"enabled":false}'       # cut the connection (queue unreachable)
```

## The fake partner

Pretends to be Shopify, a CRM or an LLM provider. Every behaviour is a knob:

```bash
make partner                                        # show knobs
make partner set='{"latencyMs":100,"rateLimitRps":20,"failureRate":0.05}'
make partner-stats                                  # faults injected, webhooks, LLM tokens and cost
make partner-reset
```

| Knob | Default | Effect |
| --- | --- | --- |
| `latencyMs` / `p99LatencyMs` | 50 / 50 | Typical latency (±20%); 1% of requests take `p99LatencyMs` |
| `slowTenants` | `{}` | Extra latency per tenant, e.g. `{"tenant_7": 800}` (from `x-tenant-id` or `?tenant=`) |
| `rateLimitRps` | 0 (off) | Above it: 429 with `Retry-After` |
| `failureRate` | 0 | Fraction of requests that return 500 |
| `down` | `false` | `"503"` fails everything; `"hang"` never responds |
| `customersListRps` | 2 | Separate limit on `GET /customers` (the 1M-record sync) |
| `customerUpdatesPerMinute` | 0 | Background edits that incremental `updated_since` syncs should pick up |
| `webhookTarget` | `""` | Where to send webhooks, e.g. `http://app:8000/webhooks` or `http://host.docker.internal:8100/...` (an app on your host) |
| `webhooksPerMinute`, `duplicateRate`, `outOfOrderRate` | 0 | Signed `order.created`/`order.updated` events, some twice, some 2-5 s late |
| `webhookTimeoutMs`, `webhookMaxRetries` | 5000, 3 | Slow or failing handlers get retried after 1, 2, 4 s |
| `llmTtftMs`, `llmLatencyMs`, `llmTokensPerMinute` | 800, 4000, 0 | Fake LLM speed and quota ("mini"/"small" models: 40% of the time, cheaper) |
| `embeddingDims`, `embeddingMaxBatch` | 384, 100 | Fake embeddings (deterministic per text) |
| `pricing` | large/small/embedding | USD per 1M tokens, for the cost counter |

Endpoints: `GET /customers/:id` · `GET /customers?updated_since=&cursor=&limit=` (max 250, sorted by `updated_at, id`) ·
`POST /crm/contacts` · `POST /v1/chat/completions` (`"stream": true` for SSE) · `POST /v1/embeddings` ·
`GET /admin/webhooks/orders` (the true final state of every order the webhooks described, to count what your app got wrong).

**Verifying webhooks:** `x-partner-signature: sha256=<hex>` where hex = HMAC-SHA256(`PARTNER_WEBHOOK_SECRET`, `` `${x-partner-timestamp}.${rawBody}` ``). Event ID in `x-partner-event-id`.

## Seed data

Seeds run inside the Postgres container (no local `psql` needed). Each one drops and recreates its own tables.

| Command | Default | Tables |
| --- | --- | --- |
| `make seed-orders` | 1M orders, ~6 s (`rows=50000000` for the full set, ~5 min) | tenants (200), customers, orders, order_items; tenant 1 owns 40% |
| `make seed-products` | 100k | products (id 1 has stock 100 for the flash sale) |
| `make seed-messages` | 1M in 500 rooms | rooms, messages (per-room `seq`) |
| `make seed-documents` | 10k docs × 10 chunks | documents, chunks with `vector(384)` embeddings; 5 tenants, skewed |

Only primary keys are created, and `orders.amount` is `double precision`, both on purpose (Project 3).

## Running load tests

```bash
make load p=01 t=ramp             # runs projects/01-*/load/*ramp*.js
make load p=01 t=ramp K6_ARGS="-e RATE=500"
```

k6 runs in a container on the lab network, so scripts call services by name (`http://app:8000` for one replica, `http://nginx` to go through the load balancer).
Results go to Prometheus tagged with `testid`, and show in the dashboard's top row.
Shared helpers (thresholds, open-model ramps, partner knobs, Zipf keys) are in [shared/k6-lib/lib.js](shared/k6-lib/lib.js).

## Adding a project

```bash
make new p=01 name=high-traffic                # FastAPI (uvicorn), the default
make new p=03 name=database stack=django       # Django (gunicorn, 4 workers)
make up p=01                                   # lab + the project's app + nginx -> http://localhost:8000
make up p=01 n=5                               # 5 app replicas behind nginx
```

Each app is its own [uv](https://docs.astral.sh/uv/) project (`pyproject.toml`, `uv.lock`, `.venv`, Python pinned to
3.12 by `.python-version` to match the Docker images). FastAPI apps are an `app` package: imports are `from app...`
and uvicorn runs `app.main:app` from the project folder.

```bash
cd projects/01-high-traffic/app && uv add httpx redis   # add dependencies (commit uv.lock)
make dev p=01        # run on your host with reload, against the lab: http://localhost:8100
make test p=01       # pytest (tests use the lab's real Postgres, so the lab must be up)
make typecheck p=01  # mypy
make lint            # Ruff over every Python file in the repo (fix=1 to apply fixes)
make fmt             # Ruff format + import sorting
make check p=01      # lint + format check + typecheck + tests: run before every commit and tag
```

Ruff's rules live in one [ruff.toml](ruff.toml) at the root, including `ASYNC`, which flags blocking calls inside
`async def`. VS Code formats on save once you install the recommended Ruff extension (`.vscode/`). Deliberately naive
code in a "break it" step may need `# noqa: <rule>`; write why on the same line.

- [shared/py-common](shared/py-common/src/labcommon/) (`labcommon`) is already wired into both templates: JSON logs with the
  request ID on every line, `x-request-id` in and out (`propagation_headers()` for outbound `httpx` calls), and the metric
  names the dashboard expects (`http_requests_total`, `http_request_duration_seconds`, by `method`, `route`, `status`).
  FastAPI apps also report event-loop lag, so blocking code in an `async def` shows on the dashboard.
- Give every extra service (a Celery worker, a scheduler) the label `lab.metrics.port: "<port>"` if it serves `/metrics`,
  and Prometheus scrapes every replica automatically.
- One process per FastAPI container: scale with `n=`, not `--workers`, so each replica is visible on its own. Django runs
  several gunicorn workers per container; `PROMETHEUS_MULTIPROC_DIR` adds their metrics up.

**Keep the naive version without copying code:** build naive, tag `p01-naive`, commit each fix separately and tag it
(`p01-fix1-allsettled`, `p01-fix2-cache`, ...). Each row of `RESULTS.md` names its tag.

## Projects

| # | Project | Results |
| --- | --- | --- |
| 0 | Shared lab | this README |
| 1 | Customer lookup API under a 10x campaign | |
| 2 | Upload, import and export at gigabyte scale | |
| 3 | The 50-million-row orders table | |
| 4 | A job system you can trust | |
| 5 | Flash sale checkout | |
| 6 | Chaos lab | |
| 7 | Team chat with a live dashboard | |
| 8 | Next.js admin over a million orders | |
| 9 | Mini CDP ingestion | |
| 10 | RAG assistant, multi-tenant | |
| 11 | URL shortener and six paper designs | |
| 12 | Your CV projects at 10x | |

## Commands

`make help` lists everything. The ones you will use most: `up`, `down`, `nuke` (deletes all data), `ps`, `logs s=postgres`,
`psql`, `redis-cli`, `smoke`, `load`, `new`, `dev`, `test`, `check`, `partner`.

## Notes

- **MinIO:** the official `minio/minio` image no longer exists on Docker Hub, so the lab uses Chainguard's build
  (`chainguard/minio`). Their free tier only offers `:latest`, so it is the one unpinned image.
- **Celery on Redis:** with `task_acks_late=True`, a task taken by a worker that dies is redelivered only after the broker's
  `visibility_timeout` (1 hour by default). Lower it for the kill-9 tests, and keep it longer than your slowest task, or a
  slow task is handed to a second worker while the first is still running it.
- **The fake partner is TypeScript** (Node 24 runs it directly, no build step; `make partner-typecheck` checks it). It and
  [shared/node-common](shared/node-common/src/index.ts) exist only for it; nothing you build depends on them.
- **Not in Project 0 yet, by design:** PgBouncer (Project 3), OpenTelemetry + Jaeger (Project 1 stretch), Mailpit (Project 4),
  SFTP (Project 9), CSV and document generators (Projects 2 and 10), CI workflow.
