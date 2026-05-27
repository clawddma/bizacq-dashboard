---
name: database
description: PostgreSQL + async SQLAlchemy + Alembic patterns for BizAcq. Covers the canonical schema (deals, deal_financials, deal_strategy, deal_events, deal_notes, token_usage), migration discipline, JSONB usage, indexing strategy, and the transaction patterns required by multi-agent writes.
---

# Database skill

## Stack

- PostgreSQL 16 (via Docker Compose)
- SQLAlchemy 2.0 with async engine (`asyncpg` driver)
- Alembic for migrations
- Redis as cache + queue (separate service — see `core/queue.py`)

## Canonical tables

See the project spec for the full DDL. Summary of what each table is for:

| Table | Purpose | Written by |
|---|---|---|
| `deals` | Master record per listing | ScoutAgent (insert), FilterAgent (status), RankingAgent (scores), MonitorAgent (price/last_seen) |
| `deal_financials` | One row per financial analysis run | FinancialAgent |
| `deal_strategy` | One row per strategy analysis run | StrategyAgent |
| `deal_events` | Append-only event log | All agents + API layer |
| `deal_notes` | Free-text user notes | API only (manual) |
| `token_usage` | Append-only LLM cost log | LLM client wrapper |

## Required indexes

```sql
CREATE INDEX idx_deals_pipeline_status ON deals(pipeline_status);
CREATE INDEX idx_deals_priority ON deals(priority) WHERE priority IS NOT NULL;
CREATE INDEX idx_deals_state ON deals(state);
CREATE INDEX idx_deals_source ON deals(source);
CREATE INDEX idx_deals_overall_score ON deals(overall_score DESC NULLS LAST);
CREATE INDEX idx_deal_events_deal_id_created_at ON deal_events(deal_id, created_at DESC);
CREATE INDEX idx_token_usage_called_at ON token_usage(called_at DESC);
CREATE INDEX idx_token_usage_agent_called_at ON token_usage(agent, called_at DESC);
```

The pipeline-count query is the most-hit query (sidebar counters every 30s). Make sure the planner uses `idx_deals_pipeline_status`.

## Migration discipline

- **Never modify a table manually.** Every change goes through Alembic.
- `alembic revision --autogenerate -m "<semantic message>"` then **review the diff** — autogenerate misses CHECK constraints and partial indexes.
- One concern per migration. Don't bundle "add column X" + "rename table Y".
- Migrations are reversible — write `downgrade()` even if you never use it.

## JSONB usage

`suggested_structure`, `projections` (in `deal_financials`), `old_value`/`new_value` (in `deal_events`) — JSONB.

Rules:
- Validate the JSON shape with Pydantic **before** insert. Don't trust JSONB to enforce structure.
- Don't query inside JSONB for hot paths. If you find yourself doing `WHERE projections->>'y3' > '100000'`, promote the field to a real column.

## Transaction patterns

Multi-table writes (e.g., update `deals` + insert `deal_financials` + insert `deal_events`) must be in a single transaction:

```python
async with db.begin():
    await db.execute(update(Deal).where(Deal.id == deal_id).values(...))
    await db.execute(insert(DealFinancials).values(...))
    await db.execute(insert(DealEvents).values(event_type='analyzed_financial', ...))
# commit happens on context exit, rollback on exception
```

Never leave a deal with a `deal_financials` row but no `analyzed_financial` event — they're the same transaction or nothing.

## Concurrency

Multiple agents may write to the same `deals` row (FilterAgent → status, MonitorAgent → asking_price, RankingAgent → overall_score). Use **row-level locking** for read-modify-write:

```python
deal = await db.execute(
    select(Deal).where(Deal.id == deal_id).with_for_update()
)
```

The `deals.updated_at` column has a trigger that bumps on any write. Don't update it manually.

## Connection pooling

`asyncpg` connection pool: min=5, max=20. Configure in `core/database.py`. Each agent worker creates its own session, never shares a session across `await` boundaries that span agent boundaries.

## Seeding for development

`scripts/seed_dev_data.py` inserts 20–30 representative deals across all pipeline states. Idempotent (deletes before inserting). **Never run in production** — guarded by `if settings.ENV != 'dev': raise`.

## Backups

Daily `pg_dump` to local disk (handled by docker-compose service). Retain 14 days. Not in scope for app code — just don't write code that assumes the DB is forever-stable; treat schema as recoverable from migrations.

## Anti-patterns

- Storing scores as VARCHAR or TEXT — always NUMERIC.
- Using `created_at` as an event marker — events go in `deal_events`.
- Truncating `deal_events` to "clean up" — it's the audit log, append-only forever.
- Cross-tenant assumptions — there is no tenant; this is a single-user system. If multi-user is ever added, it's a migration, not an inline fix.
