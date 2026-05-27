---
name: scraping
description: Patterns for building robust, polite scrapers for business-listing marketplaces (BizBuySell, BizQuest, Flippa, Empire Flippers, LoopNet). Covers Playwright vs requests, rate limiting per domain, User-Agent rotation, retry/backoff, cookie/session handling, and the canonical field-extraction contract.
---

# Scraping skill

## Tool selection

| Site | Tool | Why |
|---|---|---|
| BizBuySell | Playwright (headless) | JS-rendered listing pages |
| BizQuest | `httpx` + BS4 | Mostly server-rendered |
| Flippa | Playwright | Heavy JS + lazy-load |
| Empire Flippers | `httpx` + BS4 | Server-rendered with JSON in `<script>` |
| **BizScout** | **Playwright (auth required)** | Login + session cookie; pre-vetted listings — curated bonus in filter_score |
| LoopNet | Playwright | Requires browser context |

### BizScout specifics
- Requires login. Credentials in `.env`: `BIZSCOUT_EMAIL`, `BIZSCOUT_PASSWORD`, or a pre-extracted `BIZSCOUT_COOKIE`.
- On startup, Playwright logs in once and stores the session cookie to disk (`data/bizscout_session.json`, gitignored). Reuse across runs.
- If session invalidates (302 to /login), re-auth automatically with backoff.
- Mark every scraped row with `curated=true` metadata in `deal_events.new_value` so FilterAgent applies the curated-source bonus to `filter_score`.

Default to `httpx` + BS4 (cheap, fast). Escalate to Playwright only when JS rendering is required.

## Base scraper contract

`scrapers/base_scraper.py` exposes an abstract `BaseScraper` with:
- `async def search(self, state: Literal['TX','FL']) -> AsyncIterator[ListingRef]` — yields URLs + minimal metadata from search results.
- `async def parse(self, listing_ref: ListingRef) -> Deal` — fetches the detail page and returns a fully populated `Deal`.
- `rate_limit_seconds: float` and `interval_hours: int` come from `config.yaml`, not subclasses.

Each subclass overrides `search` and `parse`. Nothing else.

## Rate limiting

Use one `asyncio.Semaphore(1)` per domain + a `last_request_at` timestamp. Sleep `max(0, rate_limit - elapsed)` before each request. Per-domain — never global.

## User-Agent rotation

Pool of ~15 realistic UAs (Chrome / Safari / Firefox on macOS/Windows). Pick at random per request. Never use a UA that says "bot" or "scraper".

## Retry policy

`tenacity` with:
- `stop_after_attempt(3)`
- `wait_exponential(multiplier=2, min=2, max=60)`
- Retry on: `httpx.TimeoutException`, `httpx.RemoteProtocolError`, 502/503/504
- **Do NOT retry** on 403 or 429 — those mean "you're being throttled or blocked". Back off the entire source for `4 × rate_limit` and try the next cycle.

## Field extraction — canonical Deal

Every scraper must populate, in order of priority:

| Field | Required? | Notes |
|---|---|---|
| `source_url` | yes | UNIQUE; deduplicate before insert |
| `title` | yes | Trim, no HTML |
| `state` | yes | Two-letter, uppercase |
| `city` | yes | Title case |
| `asking_price` | yes | Parse `$1.2M`, `$1,200,000`, `1.2 million` → numeric |
| `reported_revenue` | preferred | NULL if not stated |
| `reported_sde` | preferred | NULL if not stated |
| `business_type` | yes | Use the site's own category if present |
| `years_operation` | preferred | Parse "established 2015" → 2026 - 2015 |
| `seller_financing` | yes | bool — default `false`, true only if explicitly stated |
| `sba_prequalified` | yes | bool — default `false`, true only if explicitly stated |
| `raw_description` | yes | Full text, stripped of HTML |
| `listing_date` | preferred | When the listing was first posted |

## Parsing heuristics

- **Asking price**: regex `(\$[\d,]+(?:\.\d+)?(?:\s*(?:M|million|K|thousand))?)`. Normalize suffixes.
- **Seller financing**: case-insensitive search for `seller financ`, `owner financ`, `seller carry`, `terms available`.
- **SBA**: `sba (pre)?qualified`, `sba eligible`, `sba financing`.
- **Years**: `established (\d{4})`, `since (\d{4})`, `(\d+)\s*years? in business`.

## Persistence flow

```
fetch → parse → validate (Pydantic) → dedupe by source_url
  → upsert into deals → publish `deal.scraped` to Redis
```

If dedupe finds an existing row with `pipeline_status != 'DESCARTADO'`, update `last_seen_at` and let MonitorAgent diff. If `asking_price` differs, MonitorAgent will trigger the price-drop event.

## Logging

`structlog.bind(source=..., url=...)` on entry. Log `scrape_ok` with parse duration, or `scrape_failed` with exception class + first 200 chars of error. Never log full HTML — too noisy.

## Testing

HTML fixtures in `tests/fixtures/scrapers/<source>/<case>.html`. Mock the HTTP layer with `respx`. Each scraper has at least: happy path, missing-SDE case, no-state-match case, malformed-price case.
