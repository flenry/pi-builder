# PLAN.md — Polymarket Alpha Trading Data Pipeline
**Version:** 3.0 (Board-reviewed)  
**Date:** 2026-04-03  
**Status:** Final — addresses all Law findings, reconciles original spec scope  
**Supersedes:** v2.0 Vegapunk review draft

---

## Board Risk Resolution Summary

Law identified 2 CRITICAL, 4 MAJOR, and 2 MINOR findings. All are resolved before the first task runs.

| Finding | Severity | Resolution |
|---|---|---|
| Partitioned table PK excludes partition key | CRITICAL | Tasks 2.3–2.4: composite PK `(id, traded_at)` and `(id, captured_at)`; FK to `trades` replaced with app-layer index lookup |
| `avgTradeSize24h`/`stddevTradeSize24h` source undefined | CRITICAL | Task 1.8: explicit bootstrap via `data-api/trades` + rolling live accumulation; uncalibrated markets suppressed with flag |
| Scope contraction vs original spec | MAJOR | Phase 2 restores `WhaleDetector`, `SignalAggregator`, `AlertEmitter` to Phase 1; all four signal types present at MVP |
| App-layer-only dedup is race-prone | MAJOR | Task 2.6: unique index `(transaction_hash, token_id, proxy_wallet, traded_at, price_usdc, size_tokens)` + `ON CONFLICT DO NOTHING` |
| Watchlist misses emerging alpha | MAJOR | Task 1.7: lazy-on-miss path creates minimal market row + promotes token on activity threshold |
| Signal enum name drift | MAJOR | Types frozen in Task 2.1: `WHALE_TRADE`, `ORDER_BOOK_IMBALANCE`, `PRICE_IMPACT_ANOMALY`, `SENTIMENT_VELOCITY` |
| Reconnect mitigation layer mismatch | MINOR | Task 5.4: separate failure modes; Live-Data WS → time-window replay; CLOB WS → snapshot-only recovery |
| Fragile bootstrap confidence formulas | MINOR | Guards codified in Task 3.4: `tradeCount24h >= 30` for sigma confidence; `priceHistory >= 20 points` for velocity |

---

## Canonical Signal Type Enum (authoritative, do not drift)

```typescript
export type SignalType =
  | "WHALE_TRADE"
  | "ORDER_BOOK_IMBALANCE"
  | "PRICE_IMPACT_ANOMALY"
  | "SENTIMENT_VELOCITY";
```

These names are final. All code, tests, DB values, and docs use exactly these strings.

---

## Phase 0 — Pre-Conditions (before writing any code)

### Task 0.1 — Repo Scaffold
**Files created:** `package.json`, `tsconfig.json`, `drizzle.config.ts`, `.env.example`, `pnpm-lock.yaml`, `.gitignore`

**Acceptance test:**
```bash
pnpm install && pnpm tsc --noEmit   # zero errors
```

**Details:**
- `pnpm init`; add deps: `drizzle-orm`, `drizzle-kit`, `pg`, `ws`, `pino`, `zod`, `dotenv`
- Add devDeps: `vitest`, `@types/pg`, `@types/ws`, `@types/node`, `typescript`
- `tsconfig.json`: `strict: true`, `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`
- `.env.example`:
  ```
  DATABASE_URL=postgres://localhost:5432/polymarket_alpha
  WHALE_ABSOLUTE_MIN_USDC=10000
  WHALE_SIGMA_THRESHOLD=3
  WHALE_PCT_VOLUME_THRESHOLD=0.02
  SNAPSHOT_INTERVAL_MS=30000
  GAMMA_POLL_INTERVAL_MS=60000
  LOG_LEVEL=info
  ```
- `drizzle.config.ts`: schema `./src/db/schema.ts`, out `./drizzle`, dialect `postgresql`

---

## Phase 1 — Types, Schema, and Data Foundation

**Goal:** All tables in Postgres. Trades and book snapshots flowing. Market catalog seeded. Stats bootstrap complete. No crashes.

---

### Task 1.1 — Config Module
**File:** `src/config.ts`

**Acceptance test:** `pnpm vitest run src/config.test.ts` — all pass

**Implementation:**
```typescript
// All values read from process.env with typed defaults.
// Exported as a single frozen object: `export const config = { ... } as const`
```

Fields: `databaseUrl`, `absoluteMinUsdc (10_000)`, `sigmaThreshold (3.0)`, `pctVolumeThreshold (0.02)`, `snapshotIntervalMs (30_000)`, `gammaPollIntervalMs (60_000)`, `watchlistSize (200)`, `clobWsShardSize (150)`, `tradeBatchSize (100)`, `tradeBatchFlushMs (500)`, `reconnectBaseMs (1_000)`, `reconnectMaxMs (30_000)`, `walletEnrichRps (2)`, `minLiquidityUsdc (50_000)`, `imbalanceRatioThreshold (3.0)`, `priceImpactWindowSec (60)`, `priceImpactMinChangePct (2.0)`, `velocityZScoreThreshold (2.0)`

**Tests:**
- Default values apply when env vars absent
- Numeric env vars parsed to numbers (not strings)
- `databaseUrl` throws if unset

---

### Task 1.2 — Event Types
**File:** `src/events/types.ts`

**Acceptance test:** `pnpm tsc --noEmit` — compiles with zero errors

**This file is the single source of truth for all event shapes and signal names.** No other file may redefine these types.

Types to define:
- `TokenId`, `ConditionId`, `WalletAddress`, `TxHash` (branded strings)
- `PriceLevel`, `OrderBook`
- `TradeEvent` (fields: `tokenId`, `conditionId`, `side`, `sizeTokens`, `priceUsdc`, `valueUsdc`, `proxyWallet`, `transactionHash`, `tradedAt`, `outcome`, `marketSlug`, `eventSlug`, `marketTitle`, `traderPseudonym?`, `source`)
- `MarketStats` (`tokenId`, `volume24hr`, `avgTradeSize24h`, `stddevTradeSize24h`, `liquidityUsdc`, `tradeCount24h`, `calibrated: boolean`)
- `BookUpdateEvent`, `PriceChangeEvent`, `BestBidAskEvent`, `LastTradePriceEvent`
- `SignalType` (frozen enum as above)
- `SignalDirection = "BULLISH" | "BEARISH" | "NEUTRAL"`
- `BaseSignal`, `WhaleSignal`, `ImbalanceSignal`, `PriceImpactSignal`, `VelocitySignal`, `Signal` (union)
- `WhaleAlert`
- `PipelineConfig`
- `DedupKey` (composite of `transactionHash | tokenId | proxyWallet | tradedAt | priceUsdc | sizeTokens`)

**Key addition vs PRD:** `MarketStats.calibrated: boolean` — false when `tradeCount24h < 30`; `WhaleDetector` skips sigma branch when `calibrated = false`.

---

### Task 1.3 — Event Bus
**File:** `src/events/bus.ts`

**Acceptance test:** `pnpm vitest run src/events/bus.test.ts`

**Implementation:**
- Thin typed wrapper over Node's `EventEmitter`
- Typed `emit<K>(event: K, payload: EventMap[K])` and `on<K>(event: K, handler)`
- `EventMap` keys: `"trade"`, `"book_update"`, `"price_change"`, `"best_bid_ask"`, `"last_trade_price"`, `"whale_alert"`, `"signal"`

**Tests:**
- Handler receives correct typed payload
- Multiple handlers on same event all called
- `off()` deregisters handler

---

### Task 1.4 — Database Client
**File:** `src/db/client.ts`

**Acceptance test:** `pnpm vitest run src/db/client.test.ts` (mocked pg pool)

**Implementation:**
- `pg.Pool` singleton from `DATABASE_URL`
- Export `drizzle(pool)` instance as `db`
- `async function closeDb()` for graceful shutdown

**Tests:**
- `closeDb()` calls `pool.end()`

---

### Task 1.5 — Zod Schemas for External Payloads
**File:** `src/validation/schemas.ts`

**Acceptance test:** `pnpm vitest run src/validation/schemas.test.ts`

**Law risk mitigated:** All inbound data parsed with `safeParse`; unknown fields logged, never crash.

Schemas:
- `ZGammaMarket` — validates Gamma API market object; unknown fields stripped
- `ZLiveTradeEvent` — validates Live-Data WS trade payload
- `ZClobBookEvent` — validates CLOB WS `book` event
- `ZClobPriceChangeEvent`, `ZClobBestBidAskEvent`, `ZClobLastTradePriceEvent`
- `ZDataApiTrade` — for bootstrap and enrichment calls

**Tests:**
- Valid payload parses successfully
- Missing required field returns `{ success: false }` — no throw
- Extra unknown field is stripped, not rejected
- Numeric string fields are coerced (`z.coerce.number()`)

---

### Task 1.6 — Database Schema
**File:** `src/db/schema.ts`

**Acceptance test:** `pnpm tsc --noEmit` — zero errors

**CRITICAL fix (Law):** `trades` and `order_book_snapshots` must NOT have `PRIMARY KEY (id)` alone because they will be partitioned by a range column. The Drizzle schema declares them as **regular tables** (no partition DDL — Drizzle cannot express it). The partition migration (Task 1.7) re-creates them as partitioned tables. The Drizzle schema is the "template" shape; the migration owns the partition semantics.

**Schema tables (7 total):**
1. `markets` — PK `token_id`, standard table
2. `market_stats` — PK `token_id`, FK to `markets.token_id`; includes `calibrated boolean default false`, `bootstrap_trade_count integer default 0`
3. `trades` — declare as non-partitioned template (partition migration replaces it). Include `traded_at` column. **No PK in Drizzle schema** — PKs on partitioned tables must be defined in raw SQL and must include partition key. Comment this clearly.
4. `order_book_snapshots` — same pattern; `captured_at` is partition key
5. `price_history` — standard table, PK `id`
6. `whale_alerts` — standard table, PK `id`. **FK to trades removed** (Law: FK across partition boundary is unsupported). Use `trade_lookup_key` (composite string of dedup key) for app-layer join instead.
7. `signals` — standard table, PK `id`. FK to `whale_alerts.id` (non-partitioned, OK).
8. `wallet_profiles` — standard table, PK `proxy_wallet`

**Note on `whale_alerts.tradeId`:** replaced with `tradeLookupKey varchar(200)` storing the serialized dedup key `"txHash|tokenId|proxyWallet|tradedAt|priceUsdc|sizeTokens"`. Indexed. Used for app-layer join.

---

### Task 1.7 — Partition Migration (Raw SQL)
**Files:** `drizzle/0001_initial_schema.sql`, `drizzle/0002_partition_trades.sql`

**Acceptance test:** `psql $DATABASE_URL -f drizzle/0001_initial_schema.sql && psql $DATABASE_URL -f drizzle/0002_partition_trades.sql` exits 0; `\d+ trades` shows `PARTITION BY RANGE (traded_at)`

**0002 details:**
```sql
-- trades: convert to partitioned, PK includes partition key
ALTER TABLE trades RENAME TO trades_legacy;

CREATE TABLE trades (
  id bigint GENERATED ALWAYS AS IDENTITY,
  token_id varchar(80) NOT NULL,
  condition_id varchar(66) NOT NULL,
  outcome varchar(50) NOT NULL,
  side varchar(4) NOT NULL,
  size_tokens numeric(20,6) NOT NULL,
  price_usdc numeric(10,6) NOT NULL,
  value_usdc numeric(20,6) NOT NULL,
  proxy_wallet varchar(42) NOT NULL,
  transaction_hash varchar(66) NOT NULL,
  traded_at timestamptz NOT NULL,
  market_slug varchar(200),
  event_slug varchar(200),
  market_title text,
  trader_name varchar(100),
  trader_pseudonym varchar(100),
  source varchar(20) DEFAULT 'live_ws',
  created_at timestamptz DEFAULT NOW() NOT NULL,
  PRIMARY KEY (id, traded_at)    -- partition key included in PK
) PARTITION BY RANGE (traded_at);

-- Unique constraint for dedup — also includes traded_at (partition key required)
CREATE UNIQUE INDEX trades_dedup_idx ON trades
  (transaction_hash, token_id, proxy_wallet, traded_at, price_usdc, size_tokens);

-- Initial partition (month-based; partition manager creates daily ones)
CREATE TABLE trades_2026_04 PARTITION OF trades
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

INSERT INTO trades (id, token_id, condition_id, outcome, side, size_tokens,
  price_usdc, value_usdc, proxy_wallet, transaction_hash, traded_at,
  market_slug, event_slug, market_title, trader_name, trader_pseudonym, source, created_at)
SELECT id, token_id, condition_id, outcome, side, size_tokens,
  price_usdc, value_usdc, proxy_wallet, transaction_hash, traded_at,
  market_slug, event_slug, market_title, trader_name, trader_pseudonym, source, created_at
FROM trades_legacy;

DROP TABLE trades_legacy;

-- order_book_snapshots: same pattern
ALTER TABLE order_book_snapshots RENAME TO order_book_snapshots_legacy;

CREATE TABLE order_book_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY,
  token_id varchar(80) NOT NULL,
  condition_id varchar(66) NOT NULL,
  bids jsonb NOT NULL,
  asks jsonb NOT NULL,
  bid_depth_usdc numeric(20,2),
  ask_depth_usdc numeric(20,2),
  imbalance_ratio numeric(10,4),
  mid numeric(10,6),
  spread numeric(10,6),
  book_hash varchar(40),
  snapshot_trigger varchar(20),
  captured_at timestamptz NOT NULL,
  PRIMARY KEY (id, captured_at)    -- partition key included in PK
) PARTITION BY RANGE (captured_at);

CREATE TABLE order_book_snapshots_2026_04 PARTITION OF order_book_snapshots
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

INSERT INTO order_book_snapshots SELECT * FROM order_book_snapshots_legacy;
DROP TABLE order_book_snapshots_legacy;
```

---

### Task 1.8 — Partition Manager
**File:** `src/db/partition-manager.ts`

**Acceptance test:** `pnpm vitest run src/db/partition-manager.test.ts`

**Implementation:**
- `createTomorrowPartition(table: "trades" | "order_book_snapshots")` — idempotent DDL
- `dropExpiredPartitions(table, retentionDays)` — trades=90, snapshots=7
- Both use raw SQL via `db.execute(sql\`...\`)`
- Cron: run at midnight UTC via `setInterval` checking `Date.utc().getHours() === 0`

**Tests:**
- `createTomorrowPartition` generates correct `FOR VALUES FROM ... TO` bounds
- `dropExpiredPartitions` identifies correct partition names past cutoff
- Both are idempotent (second call is no-op)
- No partition created for neg_risk-filtered tokens (partition is table-level, not per-token — N/A)

---

### Task 1.9 — DB Query Layer
**Files:** `src/db/queries/markets.ts`, `trades.ts`, `snapshots.ts`, `signals.ts`, `whales.ts`

**Acceptance test:** `pnpm vitest run src/db/queries/*.test.ts`

**`trades.ts` — critical dedup fix (Law MAJOR):**
```typescript
// INSERT ... ON CONFLICT DO NOTHING (database-enforced dedup)
// Uses the unique index created in Task 1.7.
// Application-layer dedup removed entirely — races are now safe.
export async function insertTrade(trade: TradeEvent): Promise<{ inserted: boolean }> {
  const result = await db.execute(sql`
    INSERT INTO trades (token_id, condition_id, outcome, side, size_tokens,
      price_usdc, value_usdc, proxy_wallet, transaction_hash, traded_at, ...)
    VALUES (...)
    ON CONFLICT (transaction_hash, token_id, proxy_wallet, traded_at, price_usdc, size_tokens)
    DO NOTHING
  `);
  return { inserted: result.rowCount === 1 };
}
```

**`markets.ts`:**
- `upsertMarket(market)` — updates `updated_at`, preserves `watchlisted`
- `getWatchlistedTokenIds()` — returns non-neg-risk, watchlisted tokens
- `getNegRiskTokenIds()` — returns neg_risk token IDs (for filter set)
- `upsertMarketStats(stats)` — sets `calibrated = (tradeCount24h >= 30)`

**`snapshots.ts`:**
- `insertBookSnapshot(snap)` — no dedup needed (REST timer creates new rows)
- `getLatestBook(tokenId)` — latest snapshot by `captured_at DESC`

**`signals.ts`:**
- `insertSignal(signal)` — enforces `signalType IN (known values)` via Zod before insert

**`whales.ts`:**
- `insertWhaleAlert(alert)` — stores `trade_lookup_key` (not FK)
- `enrichWhaleAlert(id, enrichment)` — partial update for async wallet data

**Tests (mocked `db`):**
- `insertTrade`: first insert succeeds (returns `inserted: true`), duplicate returns `inserted: false`
- `insertTrade`: same tx hash, different `sizeTokens` → two rows (partial fill scenario)
- `upsertMarketStats`: sets `calibrated = false` when `tradeCount24h = 15`
- `upsertMarketStats`: sets `calibrated = true` when `tradeCount24h = 35`
- `insertSignal`: rejects unknown signal type via Zod

---

### Task 1.10 — Stats Bootstrap
**File:** `src/sources/stats-bootstrap.ts`

**This resolves Law CRITICAL finding: source for `avgTradeSize24h`/`stddevTradeSize24h` is now explicit.**

**Implementation:**
```typescript
// Called once per token on first watchlist inclusion (or after restart)
// 1. Fetch recent trades from data-api/trades?conditionId=X&limit=200
// 2. Compute mean and stddev of valueUsdc from the sample
// 3. Upsert market_stats with computed values + tradeCount24h
// 4. If sample < 30 trades: set calibrated=false (sigma branch suppressed)
// 5. After bootstrap: WhaleDetector uses live rolling accumulation to keep stats fresh

export async function bootstrapMarketStats(
  tokenId: TokenId,
  conditionId: ConditionId
): Promise<MarketStats>
```

Rolling update: on each new trade persisted, update a per-token in-memory ring buffer (last 24h of trades); recompute mean/stddev every 60s and upsert `market_stats`. This replaces the PRD's vague "GammaPoller upserts stats" approach.

**Acceptance test:** `pnpm vitest run src/sources/stats-bootstrap.test.ts`

**Tests:**
- With 200 sample trades: returns `calibrated = true`, mean and stddev correct
- With 10 sample trades: returns `calibrated = false`
- data-api returns 429: returns default uncalibrated stats, does not throw
- Rolling buffer: adding a trade older than 24h evicts it from the window

---

### Task 1.11 — GammaPoller
**File:** `src/sources/gamma-poller.ts`

**Acceptance test:** `pnpm vitest run src/sources/gamma-poller.test.ts`

**Implementation:**
- Polls `gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=200` every `gammaPollIntervalMs`
- Parses with `ZGammaMarket` (Task 1.5); unknown fields logged, not thrown
- Neg-risk markets: upserted to `markets` with `neg_risk=true`, `watchlisted=false`
- Non-neg-risk markets: upserted with `watchlisted=true`, added to watchlist set
- Emits `"markets_updated"` event with `{ tokenIds: TokenId[], negRiskIds: TokenId[] }`
- After upsert: triggers `statsBootstrap.bootstrapMarketStats()` for newly added tokens
- **Lazy-on-miss path (Law MAJOR fix):** `handleUnknownTrade(tokenId)` — if a trade arrives for a token not in watchlist, creates a minimal `markets` row and schedules stats bootstrap; promotes to watchlist when `tradeCount24h` crosses 5 (configurable)

**Tests:**
- Neg-risk market stored with `watchlisted = false`
- Non-neg-risk market stored with `watchlisted = true`
- `"markets_updated"` emitted with correct token ID sets
- Unknown field in Gamma response does not throw
- `handleUnknownTrade` creates minimal market row
- `handleUnknownTrade` promotes to watchlist after threshold activity

---

### Task 1.12 — LiveDataWsClient
**File:** `src/sources/live-data-ws-client.ts`

**Acceptance test:** `pnpm vitest run src/sources/live-data-ws-client.test.ts`

**Implementation:**
- Connects to `wss://ws-live-data.polymarket.com`
- Subscribes: `{ "subscriptions": [{ "topic": "activity", "type": "trades" }] }`
- Parse each message with `ZLiveTradeEvent.safeParse()`; log failures, do not crash
- Filter: skip trades where `asset` (tokenId) is in neg_risk set (passed in from GammaPoller)
- Compute `valueUsdc = sizeTokens * priceUsdc`
- Emit `TradeEvent` on bus
- Reconnect: exponential backoff (`reconnectBaseMs` → `reconnectMaxMs`), then re-subscribe
- **Reconnect gap recovery (Law MINOR fix for Live-Data layer):** on reconnect, fetch `data-api/trades?conditionId=X&since=<last_event_ts>` for all active watchlist condition IDs to back-fill missed trades

**Tests:**
- Valid trade event parsed and emitted as `TradeEvent`
- Neg-risk token ID filtered (no event emitted)
- Malformed JSON payload: logs error, does not crash, continues
- Disconnect triggers reconnect attempt after `reconnectBaseMs`
- Reconnect uses exponential backoff, capped at `reconnectMaxMs`
- On reconnect: back-fill fetch called for active conditionIds
- `valueUsdc` calculated correctly (`size × price`)

---

### Task 1.13 — ClobRestClient
**File:** `src/sources/clob-rest-client.ts`

**Acceptance test:** `pnpm vitest run src/sources/clob-rest-client.test.ts`

**Implementation:**
- `batchGetBooks(tokenIds: TokenId[]): Promise<OrderBook[]>` — POST `/books`
- `getSamplingMarkets(): Promise<SamplingMarket[]>` — GET `/sampling-markets`
- `getPricesHistory(tokenId, startTs, endTs, fidelity): Promise<PricePoint[]>` — GET `/prices-history`
- Rate limit: max 8 req/s (conservative of ~10 documented); queue if over
- 429 handling: back off 30s, retry once; on second 429 log and return empty

**Tests:**
- `batchGetBooks` sends POST with correct `token_ids` array body
- 429 response: backs off 30s, retries; logs error on second 429
- Response parsed with Zod; unknown fields stripped

---

### Task 1.14 — SnapshotWriter (REST mode)
**File:** `src/processors/snapshot-writer.ts`

**Acceptance test:** `pnpm vitest run src/processors/snapshot-writer.test.ts`

**Implementation:**
- On 30s timer: `ClobRestClient.batchGetBooks(watchlist)` for all watchlisted tokens
- Compute per-snapshot: `bidDepthUsdc`, `askDepthUsdc`, `imbalanceRatio`, `mid`, `spread`, `bookHash`
- Write to `order_book_snapshots` with `snapshotTrigger = "rest_timer"`
- Maintain in-memory book cache: `Map<TokenId, { book: OrderBook, capturedAt: Date }>`
- Export `getLatestBook(tokenId): { book, capturedAt } | null` for use by `WhaleDetector`

**Tests:**
- Timer fires at correct interval (mock `setInterval`)
- `batchGetBooks` called with current watchlist token IDs
- Computed aggregates are correct (bidDepth = sum of price×size for top-20 bids)
- In-memory cache updated after each snapshot
- `getLatestBook` returns null for unseen token ID

---

## Phase 2 — Signal Engine (MVP Scope Restored)

**Goal:** All four signal types, whale alerts on console within 1s, signals written to DB. This is the original Phase 1 MVP contract per the original spec.

**Scope note:** Per Law's MAJOR finding, whale detection and the full signal engine are MVP requirements, not Phase 2 items. The phases in this PLAN map to *implementation sequence*, not to a deferred roadmap.

---

### Task 2.1 — WhaleDetector
**File:** `src/processors/whale-detector.ts`

**Acceptance test:** `pnpm vitest run src/processors/whale-detector.test.ts` — all pass

**Algorithm:**
```typescript
evaluate(trade: TradeEvent, stats: MarketStats, book: OrderBook | null): WhaleAlert | null {
  // Gate 1: absolute minimum
  if (trade.valueUsdc < config.absoluteMinUsdc) return null;

  // Gate 2: relative (stats must be calibrated for sigma branch)
  const sigmasAboveMean = stats.calibrated
    ? (trade.valueUsdc - stats.avgTradeSize24h) / stats.stddevTradeSize24h
    : -Infinity;  // calibrated=false: skip sigma branch entirely

  const pctOfDailyVolume = trade.valueUsdc / stats.volume24hr;

  const isRelativeLarge =
    (sigmasAboveMean >= config.sigmaThreshold) ||
    (pctOfDailyVolume >= config.pctVolumeThreshold);

  if (!isRelativeLarge) return null;

  // Liquidity guard: persist trade but skip signal emission
  const emitSignal = stats.liquidityUsdc >= config.minLiquidityUsdc;

  // Price impact estimation
  const { priceImpact, depthConsumedPct, bookAgeMs } = estimatePriceImpact(trade, book);

  // Confidence: anchored at 3σ=0.5, 6σ=1.0; use pct-of-volume if uncalibrated
  const confidence = stats.calibrated
    ? Math.min(1.0, sigmasAboveMean / 6)
    : Math.min(1.0, (pctOfDailyVolume / config.pctVolumeThreshold) * 0.5);

  return { trade, stats, sigmasAboveMean, pctOfDailyVolume, confidence, emitSignal,
    priceImpact, depthConsumedPct, bookAgeMs };
}
```

**Tests:**
- Fires when `valueUsdc >= absoluteMin` AND `sigmas >= 3`
- Fires when `valueUsdc >= absoluteMin` AND `pctOfVolume >= 2%` (sigma fails)
- Does NOT fire when only absolute min passes
- Does NOT fire when below absolute min even if relative passes
- `calibrated = false`: sigma branch skipped; pct-of-volume branch still applies
- `stddevTradeSize24h = 0`: treated as `calibrated = false`
- Missing book snapshot: alert emitted with null impact fields
- BUY → `direction = BULLISH`; SELL → `direction = BEARISH`
- Confidence capped at 1.0
- `liquidityUsdc < minLiquidityUsdc`: `emitSignal = false` but alert object still returned
- `bookSnapshotAgeMs` annotated correctly from `capturedAt` delta
- Alert format matches expected output shape

---

### Task 2.2 — AlertEmitter
**File:** `src/alerts/alert-emitter.ts`

**Acceptance test:** `pnpm vitest run src/alerts/alert-emitter.test.ts`

**Requirement:** Whale alert on console within 1s of trade event (original spec P0).

**Implementation:**
- Listens on bus `"whale_alert"` event
- Formats stdout alert (see PRD §7.2 sample format)
- Structured JSON log via pino: `logger.info({ type: "whale_alert", ...alert })`
- Latency: `Date.now() - trade.tradedAt.getTime()` logged as `alertLatencyMs`; warn if > 1000ms

**Tests:**
- Alert formatted to stdout within same tick as event
- `alertLatencyMs` field present and correct
- Log level `warn` when latency > 1000ms
- Alert includes: market title, side, price, value, sigmas, pct-of-volume, wallet, tx hash

---

### Task 2.3 — Whale Alert DB Write
**File:** `src/db/queries/whales.ts` (extends Task 1.9)

**Acceptance test:** `pnpm vitest run src/db/queries/whales.test.ts`

**Implementation:**
- `insertWhaleAlert(alert: WhaleAlert): Promise<bigint>` — returns new alert ID
- Stores `tradeLookupKey` (not FK) — resolves Law CRITICAL finding
- `tradeLookupKey` format: `"${txHash}|${tokenId}|${proxyWallet}|${tradedAt.toISOString()}|${priceUsdc}|${sizeTokens}"`
- Only inserts if `alert.emitSignal = true` (liquidity guard respected)
- Returns the alert ID for downstream `insertSignal` linkage

**Tests:**
- `tradeLookupKey` serialized correctly
- Returns alert ID on success
- `emitSignal = false`: insert skipped, returns null

---

### Task 2.4 — SignalAggregator
**File:** `src/processors/signal-aggregator.ts`

**Acceptance test:** `pnpm vitest run src/processors/signal-aggregator.test.ts`

**Implementation:**
- Subscribes to bus events: `"whale_alert"`, `"signal"`
- On `whale_alert`: call `insertWhaleAlert` → `insertSignal` (WHALE_TRADE type)
- On `signal` (imbalance, price impact, velocity): call `insertSignal`
- Validates `signalType` against `SignalType` union before insert — unknown type is logged + rejected
- Enforces `confidence` is in [0, 1]
- Wraps both inserts in a transaction so whale_alert + signal either both commit or both roll back

**Tests:**
- WHALE_TRADE: whale_alert row + signal row created in same transaction
- Transaction rolled back if signal insert fails
- Unknown signal type logged and rejected (no DB write)
- Confidence out of range: clamped before insert, warning logged

---

### Task 2.5 — OrderBookImbalanceEngine
**File:** `src/processors/book-imbalance-engine.ts`

**Acceptance test:** `pnpm vitest run src/processors/book-imbalance-engine.test.ts`

**Algorithm (from PRD §10.2):**
- Called after each `SnapshotWriter` write (Phase 1: REST poll; Phase 2+: WS event)
- Uses top 10 levels per side
- `imbalanceRatio = bidDepthUsdc / askDepthUsdc`
- Bullish if `> 3.0`; bearish if `< 0.333`
- **Debounce:** no re-emit within 5 minutes for same token unless ratio shifted > 0.5

**Tests:**
- BULLISH when `bidDepth:askDepth > 3:1`
- BEARISH when ratio < 1:3
- No signal in normal range
- Debounces within 5-min window
- Re-emits after 5 min even if ratio unchanged
- Re-emits within window when ratio shifts > 0.5
- Depth computed correctly: `sum(price × size)` over top-10 levels

---

### Task 2.6 — PriceHistoryWriter
**File:** `src/processors/price-history-writer.ts`

**Acceptance test:** `pnpm vitest run src/processors/price-history-writer.test.ts`

**Implementation:**
- Subscribes to bus: `"last_trade_price"`, `"best_bid_ask"`
- Writes to `price_history` table
- Batches writes: flush every 500ms or 100 rows (same pattern as trades)
- `eventType`: `"last_trade"` | `"best_bid"` | `"best_ask"` | `"mid"`

**Tests:**
- `last_trade_price` event → `eventType = "last_trade"`
- `best_bid_ask` event → two rows: `best_bid` and `best_ask`
- Batch flush triggered at 100 rows or 500ms

---

### Task 2.7 — PriceImpactSignal
**File:** `src/signals/price-impact-signal.ts`

**Acceptance test:** `pnpm vitest run src/signals/price-impact-signal.test.ts`

**Algorithm (PRD §10.3):**
- Window: last `priceImpactWindowSec` (60s) from `price_history`
- Requires >= 2 data points
- `changePct = |priceEnd - priceStart| / priceStart * 100`
- Fire if `changePct >= priceImpactMinChangePct (2.0%)`
- Skip if `liquidityUsdc < minLiquidityUsdc`
- `confidence = min(1.0, changePct / 10)`

**Bootstrap guard (Law MINOR fix):** skip if `price_history` has < 2 points for the token in the window.

**Tests:**
- Returns null with < 2 price points
- Returns null when change < 2%
- Correct direction (BULLISH/BEARISH) based on price movement
- `confidence` computed and capped at 1.0
- Liquidity guard: null if under threshold
- `triggeringTradeValueUsdc` from max trade in window

---

### Task 2.8 — VelocitySignal
**File:** `src/signals/velocity-signal.ts`

**Acceptance test:** `pnpm vitest run src/signals/velocity-signal.test.ts`

**Algorithm (PRD §10.4):**
- 5-min scheduled scan over all watchlisted tokens
- 24h history bucketed at 5-min intervals
- Skip if `< 20 history points` (Law MINOR fix — hardcoded guard)
- z-score of 60-min return vs 24h baseline
- Fire if `|zScore| >= velocityZScoreThreshold (2.0)`
- Skip if `liquidityUsdc < minLiquidityUsdc`
- Bootstrap: markets < 2h old → use category-median baseline (stored in `market_stats`)

**Bootstrap guard (Law MINOR fix):** category-median baseline must exist in DB; if not, skip (no estimation).

**Tests:**
- Skips market with < 20 history points
- z-score computed correctly against 24h baseline
- Fires when `|z| >= 2.0`, not when `|z| < 2.0`
- Uses category-median when market < 2h old
- Does not crash when category-median missing — skips token with log

---

## Phase 3 — ClobWsPool (Phase 2 of PRD, now Phase 3 here)

**Goal:** Replace REST snapshot polling with real-time CLOB WS book events. REST poll becomes fallback only.

---

### Task 3.1 — ClobWsPool
**File:** `src/sources/clob-ws-pool.ts`

**Acceptance test:** `pnpm vitest run src/sources/clob-ws-pool.test.ts`

**Implementation:**
- Shards watchlist into batches of `clobWsShardSize` (default 150)
- Opens one WS connection per shard
- Each shard subscribes: `{ "type": "market", "assets_ids": [...], "initial_dump": true }`
- Keepalive: send `PING` every 50s per shard
- Per-shard reconnect: independent, exponential backoff
- On reconnect: **restore book state from in-memory cache + fetch missing book via REST** (no missed-trade recovery — CLOB WS is book-only; Law MINOR fix: separate failure modes)
- Emits: `book`, `price_change`, `best_bid_ask`, `last_trade_price`, `shard_reconnect`, `error`
- `addTokenIds(newIds)`: distribute new tokens into existing shards or open new shard if all full

**Tests:**
- `connect(200 tokenIds)` with `shardSize=150` → opens 2 connections
- Each shard subscribes with correct sub-array
- Shard 0 disconnect → only shard 0 reconnects; shard 1 unaffected
- Reconnect uses exponential backoff capped at `reconnectMaxMs`
- `addTokenIds` fills existing shards before opening new one
- `shard_reconnect` event emitted with correct index
- PING sent every 50s per shard
- Silent shard > 60s → `error` event with `"shard_silent"` message

---

### Task 3.2 — SnapshotWriter Upgrade (WS mode)
**File:** `src/processors/snapshot-writer.ts` (update)

**Acceptance test:** `pnpm vitest run src/processors/snapshot-writer.test.ts` — existing tests still pass

**Implementation:**
- Subscribe to `ClobWsPool` `"book"` events
- On `book` event: update in-memory cache + write snapshot with `snapshotTrigger = "ws_event"`
- REST timer continues for shards in reconnect state (fallback, not primary)
- `snapshotTrigger` clearly distinguishes source for debugging

**Tests:**
- WS book event → snapshot with `snapshotTrigger = "ws_event"`
- REST poll → snapshot with `snapshotTrigger = "rest_timer"`
- Shard in reconnect: REST poll still fires for those tokens

---

### Task 3.3 — WalletEnricher
**File:** `src/processors/wallet-enricher.ts`

**Acceptance test:** `pnpm vitest run src/processors/wallet-enricher.test.ts`

**Implementation:**
- In-memory FIFO queue, rate-limited to `walletEnrichRps (2 req/s)`
- On whale alert: `enqueue(proxyWallet, alertId)`
- Fetches `data-api/positions?user=X&limit=50`
- Updates `whale_alerts` row: `wallet_total_volume_usdc`, `wallet_trade_count`, `wallet_win_ratio`, `enriched_at`
- Upserts `wallet_profiles` row
- On 429: back off 30s, retry; on second 429: log and skip (graceful degradation)

**Tests:**
- Queue processes at max `walletEnrichRps` (no burst)
- 429 response: retries after 30s
- Two consecutive 429s: alert skipped, logged, no crash
- Enriched fields written to `whale_alerts` correctly

---

## Phase 4 — Pipeline Wiring and Hardening

**Goal:** All components wired together. Graceful shutdown. Observability. Docker Compose.

---

### Task 4.1 — Pipeline Orchestrator
**File:** `src/pipeline.ts`, `src/index.ts`

**Acceptance test:** `pnpm start` — no crash; after 60s: `trades` has > 0 rows, `order_book_snapshots` has > 0 rows

**Implementation (`pipeline.ts`):**
```
startup sequence:
1. db.connect()
2. partition-manager: ensure today + tomorrow partitions exist
3. gamma-poller.start() → populate watchlist + bootstrap stats
4. live-data-ws-client.connect()
5. clob-rest-client (snapshot-writer timer starts)
6. clob-ws-pool.connect(watchlist)
7. signal-aggregator wires bus listeners
8. book-imbalance-engine wires snapshot-writer events
9. velocity-signal scheduler starts (5-min interval)
```

**Graceful shutdown (SIGINT/SIGTERM):**
```
1. Stop accepting new WS events
2. Flush trade batch (wait up to 2s)
3. clob-ws-pool.disconnect()
4. live-data-ws-client.disconnect()
5. gamma-poller.stop()
6. velocity-signal scheduler stop
7. db.closeDb()
8. process.exit(0)
```

**Tests:**
- Shutdown sequence: trade batch flushed before DB close
- Components started in dependency order

---

### Task 4.2 — Structured Logging
**File:** `src/logger.ts`

**Acceptance test:** `LOG_LEVEL=debug pnpm start 2>&1 | head -20 | jq .` — valid JSON

**Implementation:**
- `pino` instance exported as `logger`
- All modules import and use `logger.{info,warn,error,debug}`
- Standard fields: `level`, `time`, `source` (module name), `tokenId?`, `latencyMs?`

---

### Task 4.3 — Docker Compose
**File:** `docker-compose.yml`

**Acceptance test:** `docker compose up -d && sleep 10 && docker compose ps` shows all services healthy

**Services:**
- `postgres`: `postgres:16`, port 5432, `POSTGRES_DB=polymarket_alpha`
- `app`: builds from `Dockerfile`, depends on `postgres`, passes `.env`
- `Dockerfile`: `node:22-alpine`, `COPY`, `pnpm install --frozen-lockfile`, `pnpm start`

---

### Task 4.4 — Integration Tests
**File:** `src/__tests__/pipeline.integration.test.ts`

**Acceptance test:** `DATABASE_URL=... pnpm test:integration` — all pass

**Tests (require live DATABASE_URL):**
- GammaPoller: neg_risk markets have `watchlisted = false`
- GammaPoller: non-neg-risk markets have `watchlisted = true`
- `insertTrade` + `insertTrade` (same dedup key): second is no-op
- `insertTrade` (same txHash, different size): two rows inserted
- WhaleAlert: fires on a synthetic trade exceeding both thresholds
- PartitionManager: `createTomorrowPartition` is idempotent
- `market_stats.calibrated` reflects trade count correctly

---

## Phase 5 — Test Fixtures and Coverage

### Task 5.1 — Test Fixtures
**Files:** `tests/fixtures/`

Files to create:
- `book-event.json` — real CLOB WS `book` event (validated shape from live data)
- `trade-event.json` — real Live-Data WS trade payload
- `gamma-market.json` — real Gamma market object (`negRisk: false`)
- `gamma-market-neg-risk.json` — neg-risk market
- `whale-trade.json` — synthetic: `valueUsdc=75000`, `sigmasAboveMean=4.2`, `pctOfDailyVolume=0.03`
- `data-api-trades.json` — sample `data-api/trades` response for bootstrap tests

All fixtures include a `// FROZEN: do not edit without updating consuming tests` comment in the test files.

---

### Task 5.2 — Dedup Edge Case Tests
**File:** `src/db/queries/__tests__/dedup.test.ts`

**Tests:**
- First insert of unique composite key → succeeds
- Exact duplicate (all 6 fields match) → rejected by DB unique index
- Same txHash, different `proxyWallet` → accepted (different fill)
- Same txHash, different `sizeTokens` → accepted (partial fill)
- Same txHash, different `tradedAt` → accepted
- Concurrent inserts of same key → only one committed (race safety)
- `insertTrade` returns `{ inserted: false }` on conflict

---

### Task 5.3 — Coverage Gate
**File:** `vitest.config.ts`

**Acceptance test:** `pnpm test:coverage` exits 0

Coverage thresholds:
```typescript
coverage: {
  thresholds: {
    "src/signals/**": { lines: 90, branches: 90 },
    "src/db/queries/**": { lines: 80, branches: 80 },
    "src/sources/**": { lines: 70 },
    "src/processors/**": { lines: 80 }
  }
}
```

---

## Implementation Order (dependency graph)

```
0.1 (scaffold)
  └─ 1.1 (config)
       ├─ 1.2 (types)
       │    └─ 1.3 (bus)
       │         └─ 1.4 (db client)
       │              ├─ 1.5 (zod schemas)
       │              ├─ 1.6 (schema.ts)
       │              │    └─ 1.7 (partition migration)
       │              │         └─ 1.8 (partition manager)
       │              └─ 1.9 (query layer)
       │                   └─ 1.10 (stats bootstrap)
       │                        ├─ 1.11 (gamma poller)
       │                        ├─ 1.12 (live-data ws)
       │                        ├─ 1.13 (clob rest)
       │                        └─ 1.14 (snapshot writer REST)
       │                              ├─ 2.1 (whale detector)
       │                              │    └─ 2.2 (alert emitter)
       │                              │         └─ 2.3 (whale alert DB write)
       │                              │              └─ 2.4 (signal aggregator)
       │                              ├─ 2.5 (imbalance engine)
       │                              ├─ 2.6 (price history writer)
       │                              │    ├─ 2.7 (price impact signal)
       │                              │    └─ 2.8 (velocity signal)
       │                              └─ 3.1 (clob ws pool)
       │                                   ├─ 3.2 (snapshot writer WS upgrade)
       │                                   └─ 3.3 (wallet enricher)
       └─ 4.1 (pipeline wiring)
            ├─ 4.2 (logging)
            ├─ 4.3 (docker)
            └─ 4.4 (integration tests)
                 └─ 5.1-5.3 (fixtures + coverage)
```

---

## Exit Criteria (MVP Complete)

These match the original spec Phase 1 must-haves exactly:

| Criterion | Verified by |
|---|---|
| Trades flowing into `trades` table within 5 min of start | Integration test 4.4 |
| Whale console alert within 1s of whale trade | `alertLatencyMs` field; unit test 2.2 |
| Dual-threshold calibrated per-market (not static $50k) | WhaleDetector tests 2.1 |
| Uncalibrated markets (< 30 trades) skip sigma branch | `calibrated` field; unit test 2.1 |
| `order_book_snapshots` has rows for all watchlist tokens within 60s | Integration test 4.4 |
| Neg-risk tokens have `watchlisted = false` in `markets` | Integration test 4.4 |
| All four `SignalType` values present in `signals` table | SQL query in §11 Phase 3 |
| No crash on WS reconnect | LiveDataWsClient test 1.12, ClobWsPool test 3.1 |
| Duplicate trade replay safe (DB-enforced dedup) | Dedup tests 5.2 |
| Pipeline shuts down cleanly on SIGINT | Pipeline test 4.1 |

---

## Deferred to Later Phases (out of MVP scope)

| Feature | Phase |
|---|---|
| Discord/Slack webhook alerts | Phase 3 (PRD 2.8) |
| Wallet enrichment history (WalletEnricher) | Phase 3 (PRD 2.7) |
| Backfill script (`/prices-history`) | Phase 5 (PRD 5.1) |
| Signal backtesting | Phase 5 (PRD 5.2–5.4) |
| Neg-risk market signals | Phase 6 (PRD 5.6) |
| Prometheus metrics endpoint | Phase 4 hardening (PRD 4.4) |
| Composite signals | Explicitly out of scope (PRD §10 note) |

---

## Open Questions (resolved or deferred)

| Question | Resolution |
|---|---|
| CLOB WS per-connection token limit | Default 150; reduce to 100 if rejections observed; `clobWsShardSize` is configurable |
| `avgTradeSize24h` source | **Resolved:** `data-api/trades` bootstrap + rolling live accumulation (Task 1.10) |
| `data-api` enrichment pagination depth | `limit=200` for bootstrap; `limit=50` for wallet enrichment; document as "representative sample" |
| Neg-risk signal design | Deferred to Phase 6 |
| Alert webhook payload schema | Deferred; Discord embed format preferred when implemented |

---

*PLAN.md v3.0 — synthesised from PRD.md v2.0, Vegapunk external research, Law board critique, and original spec. All Law findings addressed. Signal scope restored to match original Phase 1 contract. Ready for implementation.*
