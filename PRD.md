# PRD: Polymarket Alpha Trading Data Pipeline

**Version:** 2.0  
**Date:** 2026-04-03  
**Status:** Board-approved — ready for implementation  
**Stack:** TypeScript · pnpm · PostgreSQL + Drizzle ORM · Vitest

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Goals and Non-Goals](#3-goals-and-non-goals)
4. [User Stories](#4-user-stories-prioritised)
5. [System Architecture](#5-system-architecture)
6. [Data Sources](#6-data-sources)
7. [Core Features](#7-core-features)
8. [Database Schema](#8-database-schema)
9. [API / Module Design](#9-api--module-design)
10. [Signal Algorithms](#10-signal-algorithms)
11. [Implementation Roadmap](#11-implementation-roadmap)
12. [Testing Strategy](#12-testing-strategy)
13. [Risks and Mitigations](#13-risks-and-mitigations)
14. [Open Questions](#14-open-questions)
15. [Success Metrics](#15-success-metrics)

---

## 1. Executive Summary

A real-time data pipeline that ingests Polymarket market data from three live sources — CLOB WebSocket, Live-Data WebSocket, and Gamma REST API — persists compressed snapshots in PostgreSQL, and runs a signal engine that surfaces alpha opportunities. The primary signal is whale trade detection: catching single trades that are statistically large relative to each market's recent liquidity profile, not just large in absolute dollar terms.

The system is personal-use infrastructure: one operator, one Postgres instance, one process. It is not a multi-tenant SaaS. Every design decision favours operational simplicity and signal quality over throughput maximisation.

### Business Value

| Signal | Value |
|---|---|
| Whale detection (adaptive threshold) | Follow smart money into position before price adjusts |
| Order book imbalance | Predict near-term price direction |
| Price impact anomaly | Catch thin-book momentum events |
| Sentiment velocity | Detect consensus shifts before volume confirms |

---

## 2. Problem Statement

Polymarket is the world's largest prediction market, with $482M+ in single-event volume (2026 FIFA World Cup alone). Its CLOB is fully public: order book depth, trade history, and wallet addresses are all available without authentication.

**The alpha opportunity:** informed traders move prices before the broader market reacts. A single $200k YES bet on a geopolitical event shifts the price 2–8%. Manual monitoring of hundreds of active markets is impossible; automated detection is not.

**The gap:** no off-the-shelf tool ingests the CLOB + Live-Data feeds together, applies per-market dynamic thresholds, and writes structured signal records suitable for backtesting. Building this pipeline creates a durable, compounding information edge.

---

## 3. Goals and Non-Goals

### Goals

- Ingest trade and order book events from all three Polymarket data sources in real time.
- Detect whale trades using a **dual-threshold model** calibrated per market, not a static dollar cutoff.
- Persist all trades, book snapshots, signals, and alerts to Postgres for offline analysis.
- Surface four signal types with confidence and direction scores.
- Operate continuously without manual intervention (reconnect, resubscribe, handle downtime).
- Skip `neg_risk` markets in Phase 1 with an explicit filter — not a silent gap.

### Non-Goals

- Order placement / trade execution — read-only at all times.
- Multi-tenant or API-server mode — this is a single-operator pipeline.
- Neg-risk market signal generation — deferred to Phase 4 (requires cross-book pricing model).
- Goldsky subgraph as a real-time signal source — used for async historical enrichment only.
- Financial advice or guarantee of alpha — signals are probabilistic heuristics.

---

## 4. User Stories (Prioritised)

Priority legend: **P0** = MVP blocker · **P1** = Phase 2 · **P2** = Phase 3+ 

| # | Priority | Story |
|---|---|---|
| US-01 | P0 | As an operator, I can start the pipeline and have trades flowing into Postgres within 5 minutes. |
| US-02 | P0 | As an operator, I receive a console alert within 1 second of any whale trade being detected. |
| US-03 | P0 | As an operator, whale alerts are calibrated per market — large trades on low-volume markets fire, small trades on mega-markets do not. |
| US-04 | P0 | As an operator, the pipeline reconnects automatically after a WebSocket drop, with no data loss beyond the outage window. |
| US-05 | P0 | As an operator, neg-risk markets are explicitly excluded from signal generation and labelled as such in the DB. |
| US-06 | P1 | As an operator, I receive order book imbalance signals for watched markets when depth skews > 3:1. |
| US-07 | P1 | As an operator, whale alerts include a wallet history summary (prior volume, win rate) within 5 seconds. |
| US-08 | P1 | As an operator, I can receive whale alerts in a Discord or Slack channel via webhook. |
| US-09 | P2 | As an analyst, I can query the `signals` table and see all four signal types with confidence scores and market context. |
| US-10 | P2 | As an analyst, I can run a backtest over historical price data and see signal precision/recall against resolved markets. |
| US-11 | P2 | As an analyst, I can view a wallet leaderboard ranked by win rate for identified whale wallets. |
| US-12 | P2 | As an operator, neg-risk markets produce directionally correct signals via a cross-book pricing model. |

---

## 5. System Architecture

### High-Level Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        POLYMARKET SOURCES                           │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────┐   │
│  │  CLOB WebSocket  │  │ Live-Data WS     │  │  Gamma REST API │   │
│  │ wss://ws-subs    │  │ wss://ws-live    │  │ gamma-api.poly  │   │
│  │ -clob.poly.com   │  │ -data.poly.com   │  │ market.com      │   │
│  │ /ws/market       │  │ topic: activity  │  │ /markets        │   │
│  │                  │  │ type: trades     │  │ /events         │   │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬────────┘   │
└───────────┼─────────────────────┼─────────────────────┼────────────┘
            │                     │                     │
            ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         INGESTION LAYER                             │
│                                                                     │
│  ┌───────────────────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │ ClobWsPool                │  │ LiveDataWs   │  │ GammaPoller │  │
│  │ N connections × 100-200   │  │ Client       │  │ 60s poll    │  │
│  │ token IDs per shard       │  │ trade feed   │  │ market cat. │  │
│  │ - book events             │  │ orders_      │  │ volume snap │  │
│  │ - price_change            │  │   matched    │  │             │  │
│  │ - best_bid_ask            │  │              │  │             │  │
│  │ - last_trade_price        │  │              │  │             │  │
│  └──────┬────────────────────┘  └──────┬───────┘  └──────┬──────┘  │
└─────────┼───────────────────────────────┼─────────────────┼────────┘
          │                               │                 │
          └───────────────────────────────┼─────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         EVENT BUS                                   │
│              (in-process EventEmitter / AsyncIterable)              │
│                                                                     │
│  TradeEvent │ BookUpdateEvent │ PriceChangeEvent │ SnapshotEvent    │
└──────────┬──────────────┬──────────────┬──────────────┬────────────┘
           │              │              │              │
           ▼              ▼              ▼              ▼
┌──────────────┐  ┌──────────────┐  ┌──────────┐  ┌────────────────┐
│  Whale       │  │  Order Book  │  │ Snapshot │  │  Signal        │
│  Detector    │  │  Imbalance   │  │ Writer   │  │  Aggregator    │
│  dual-thresh │  │  Engine      │  │ (Drizzle)│  │                │
└──────┬───────┘  └──────┬───────┘  └──────────┘  └───────┬────────┘
       │                 │                                  │
       └─────────────────┼──────────────────────────────────┘
                         │
                         ▼
              ┌────────────────────┐
              │   Signal Store     │
              │   (PostgreSQL)     │
              │                    │
              │   + Alert Emitter  │
              │   (stdout + hook)  │
              └────────────────────┘
```

### Data Flow

```
1. ClobWsPool manages N sharded connections to
   wss://ws-subscriptions-clob.polymarket.com/ws/market
   └─ watchlist bounded to top 200–500 active, non-neg-risk tokens
   └─ tokens sharded into batches of 100–200 per connection
   └─ each shard sends: { type: "market", assets_ids: [...shard], initial_dump: true }
   └─ receives: book | price_change | last_trade_price | best_bid_ask events
   └─ reconnects shard independently on failure

2. LiveDataWsClient connects to wss://ws-live-data.polymarket.com
   └─ subscribes: { topic: "activity", type: "trades" }
   └─ receives: Trade objects with proxyWallet, size, price, conditionId, txHash
   └─ filters: skip trades where tokenId is in neg_risk set

3. GammaPoller polls https://gamma-api.polymarket.com/markets every 60s
   └─ fetches: active=true, closed=false, order=volume24hr, limit=200
   └─ separates neg_risk markets into dedicated set (stored, not processed)
   └─ extracts: bestBid, bestAsk, spread, liquidity, volume24hr for watchlist

4. All events flow into the event bus (typed, in-process)

5. Processors consume from event bus:
   - WhaleDetector: dual-threshold check → emits WhaleAlert
   - OrderBookImbalanceEngine: bid/ask depth ratio → emits ImbalanceSignal
   - SnapshotWriter: timer-based REST snapshots (Phase 1) → WS-driven (Phase 2+)
   - PriceHistoryWriter: persists price series for velocity calculations
   - SignalAggregator: combines signals → writes SignalRecord to DB

6. Alerts emitted to stdout; webhook added in Phase 2
```

---

## 6. Data Sources

### 6.1 CLOB API (REST)

**Base URL:** `https://clob.polymarket.com`  
**Auth:** Public endpoints need no auth. Order/trade history via L2 key is out of scope.

| Endpoint | Method | Description | Key Fields |
|---|---|---|---|
| `/sampling-markets` | GET | Active markets accepting orders | `condition_id`, `tokens[].token_id`, `tokens[].price`, `accepting_orders`, `neg_risk` |
| `/markets` | GET | All CLOB markets (paginated) | `condition_id`, `tokens`, `minimum_order_size`, `minimum_tick_size`, `neg_risk` |
| `/book?token_id=` | GET | Full order book for one token | `bids[]`, `asks[]`, `timestamp`, `hash`, `last_trade_price` |
| `/books` | POST | Batch order books (Phase 1 snapshot source) | Array of `token_id` |
| `/midpoint?token_id=` | GET | Midpoint price | `mid` |
| `/spread?token_id=` | GET | Best bid-ask spread | `spread` |
| `/last-trade-price?token_id=` | GET | Last trade price + side | `price`, `side` |
| `/prices-history?market=&startTs=&endTs=&fidelity=` | GET | Price history | `history[].t`, `history[].p` (2-min buckets at fidelity=1) |

**Pagination:** cursor-based — `next_cursor` field, initial `MA==`, terminal `LTE=`, max `limit=1000`.

**Rate limits:** Undocumented. Community observation: ~10 req/s per IP on public endpoints. Use batch `/books` to minimise round trips.

---

### 6.2 CLOB WebSocket Feed

**URL:** `wss://ws-subscriptions-clob.polymarket.com/ws/market`  
**Auth:** None for market feed.

**Subscription message (per shard):**
```json
{
  "type": "market",
  "assets_ids": ["<token_id_1>", "...", "<token_id_200>"],
  "initial_dump": true
}
```

**Event types received:**

| Event Type | Key Fields | Notes |
|---|---|---|
| `book` | `asset_id`, `bids[]`, `asks[]`, `timestamp`, `hash` | Full order book snapshot |
| `price_change` | `asset_id`, `price`, `side` | Best bid or ask changed |
| `tick_size_change` | `asset_id`, `old_tick_size`, `new_tick_size` | Market parameter change |
| `last_trade_price` | `asset_id`, `price`, `side` | Trade executed |
| `best_bid_ask` | `asset_id`, `bid`, `ask` | Top of book update |
| `new_market` | `condition_id`, `tokens[]` | New market opened |
| `market_resolved` | `condition_id`, `outcome` | Market settled |

**Keepalive:** Send `PING` string every 50s.  
**Reconnect:** Re-subscribe the affected shard. Use exponential backoff: base 1s, cap 30s.

---

### 6.3 Live-Data WebSocket Feed

**URL:** `wss://ws-live-data.polymarket.com`  
**Auth:** Not required for `activity` topic.

**Subscription:**
```json
{
  "subscriptions": [
    { "topic": "activity", "type": "trades" }
  ]
}
```

**Trade event payload:**

| Field | Type | Description |
|---|---|---|
| `asset` | string | ERC1155 token ID (= CLOB `token_id`) |
| `conditionId` | string | Market condition ID |
| `side` | `BUY`/`SELL` | Trade direction |
| `size` | number | Token quantity (6 decimals) |
| `price` | number | Price in USDC (0.00–1.00) |
| `proxyWallet` | string | Trader's Polygon proxy wallet address |
| `transactionHash` | string | On-chain tx hash |
| `timestamp` | integer | Unix timestamp |
| `outcome` | string | `Yes` / `No` |
| `slug` | string | Market slug |
| `eventSlug` | string | Parent event slug |
| `title` | string | Event title |
| `pseudonym` | string | Auto-assigned username |

**USDC value:** `size × price`  
**Note:** trades with `tokenId` in the neg_risk set are filtered at the event bus boundary.

---

### 6.4 Gamma Markets API (REST)

**Base URL:** `https://gamma-api.polymarket.com`  
**Auth:** None required.

| Endpoint | Method | Key Query Params | Key Response Fields |
|---|---|---|---|
| `/markets` | GET | `active`, `closed`, `limit`, `offset`, `order`, `ascending` | `id`, `conditionId`, `clobTokenIds`, `question`, `category`, `bestBid`, `bestAsk`, `spread`, `lastTradePrice`, `volume`, `volume24hr`, `volume1wk`, `liquidity`, `oneDayPriceChange`, `negRisk` |
| `/markets/{id}` | GET | — | Full market object |
| `/events` | GET | same filters | `id`, `slug`, `title`, `markets[]`, `volume`, `volume24hr`, `openInterest`, `liquidity` |

**Alpha hunting filter:** `active=true&closed=false&order=volume24hr&ascending=false&limit=200`

---

### 6.5 Data API (REST)

**Base URL:** `https://data-api.polymarket.com`  
**Auth:** None (public endpoints sufficient for enrichment).

| Endpoint | Method | Key Params | Description |
|---|---|---|---|
| `/trades` | GET | `limit`, `conditionId`, `user`, `side` | Trade history |
| `/positions` | GET | `user`, `conditionId`, `limit` | User position sizes |
| `/activity` | GET | `user`, `conditionId`, `limit`, `type` | Mixed trade/position activity |

Used exclusively for async wallet enrichment. Rate-limited in-process to 2 req/s.

---

### 6.6 Goldsky GraphQL Subgraphs (On-Chain, Enrichment Only)

**Base:** `https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/`

| Subgraph | Path | Use Case |
|---|---|---|
| `orderbook-subgraph/0.0.1/gn` | On-chain order fills | `makerAmountFilled`, `takerAmountFilled` in raw 6-decimal USDC |
| `pnl-subgraph/0.0.14/gn` | P&L tracking | Per-wallet realized PnL |
| `positions-subgraph/0.0.7/gn` | Wallet positions | Token holdings per wallet |

**Important:** Goldsky subgraphs experience indexing lag during Polygon reorgs. They are **not** a real-time signal source — use them for offline historical enrichment only.

---

## 7. Core Features

### 7.1 Real-Time Market Data Streaming

**Subscription strategy:**
1. On startup, poll `GET /sampling-markets` (CLOB) and `GET /markets?active=true&limit=200` (Gamma).
2. Merge into a deduplicated watchlist; **filter out any market where `negRisk = true`**. Flag excluded markets in the `markets` table (`neg_risk = true`, `watchlisted = false`) so they are visible but not processed.
3. Bound watchlist to top 200–500 non-neg-risk tokens by `volume24hr`.
4. Shard token IDs into batches of 100–200. Open one CLOB WS connection per shard. These are managed by `ClobWsPool`.
5. Subscribe `LiveDataWsClient` to global `activity/trades` (no market filter needed).
6. GammaPoller refreshes every 60s, extending the watchlist with newly active markets and issuing re-subscriptions for new shards.

**Reconnect handling:**
- Each shard reconnects independently with exponential backoff (1s → 30s cap).
- On reconnect, re-fetch market list and re-subscribe that shard.
- Track `last_event_timestamp` per shard; log a warning if any shard is silent > 60s.

**Normalization:** All incoming events convert to internal types. USDC amounts from Goldsky (raw 6-decimal) divided by `1_000_000`. Token prices from WS are strings — cast to `number` immediately.

---

### 7.2 Whale Detection Engine

**Definition:** A single trade that exceeds **both** of the following thresholds (see §10 for algorithm detail):

1. `valueUsdc >= absoluteMinUsdc` (default `10_000`) — filters dust
2. `valueUsdc >= avgTradeSize24h + 3 × stddev24h` OR `valueUsdc >= volume24h × 0.02` — relative signal

This dual-threshold model is calibrated per market. A $10k trade on a niche $200k/day market fires; a $40k trade on the FIFA World Cup ($17M/day) does not.

**Detection flow:**
```
LiveDataWsClient emits TradeEvent (negRisk already filtered)
  → WhaleDetector.evaluate(trade, marketStats):
      if trade is whale: emit WhaleAlert {
        trade, usdcValue, marketStats snapshot,
        priceImpactEstimate, alertTimestamp
      }
      → walletEnricher.enqueue(trade.proxyWallet, alertId)  [async]
```

**Alert output:**
```
🐋 WHALE ALERT
Market: US forces enter Iran by April 30?
Side:   BUY YES @ $0.68
Value:  $124,500 USDC  (5.2σ above 24h mean, 3.1% of daily volume)
Wallet: 0xabc...def (seen 12 times, $1.2M total volume, 71% win rate)
Impact est.: +0.8¢ (book absorbed to $0.695)  [snapshot age: 12s]
Tx: 0xfff...
```

---

### 7.3 Market Snapshot Storage

**What it stores:**
1. **Market catalog** — Gamma market objects, upserted every 60s. `neg_risk` flag preserved.
2. **Order book snapshots** — Phase 1: REST `/books` batch-polled on a 30s timer. Phase 2+: driven by CLOB WS `book` events. Top 20 levels per side stored as JSONB; derived aggregates computed at write time.
3. **Trades** — every event from `LiveDataWsClient`, persisted immediately in 100-row batches flushed every 500ms.
4. **Price history** — `last_trade_price` and `best_bid_ask` events persisted for velocity calculations.

**Storage strategy (partitioning from day one):**
- `trades` and `order_book_snapshots` use daily partitions keyed on `traded_at` / `captured_at`.
- Retention enforced by dropping old partitions (`DROP TABLE trades_2026_01_01`), not by `DELETE`.
- Partition DDL is included in Phase 1 migrations, not deferred.

**Retention policy:**
| Table | Retention |
|---|---|
| `trades` | 90 days (drop partitions) |
| `order_book_snapshots` | 7 days (drop partitions) |
| `price_history` | 365 days |
| `markets` / `market_stats` | Permanent |
| `whale_alerts` / `signals` | Permanent |
| `wallet_profiles` | Permanent |

---

### 7.4 Alpha Signal Surfacing

Four signal types (detail in §10):

| Signal | Trigger | Output |
|---|---|---|
| `WHALE_TRADE` | Dual-threshold breach (§10.1) | WhaleAlert + WhaleSignal |
| `ORDER_BOOK_IMBALANCE` | Bid/ask depth ratio > 3:1 or < 1:3 | ImbalanceSignal |
| `PRICE_IMPACT_ANOMALY` | Mid price moves > 2% in 60s | PriceImpactSignal |
| `SENTIMENT_VELOCITY` | 60-min return z-score > 2σ vs 24h baseline | VelocitySignal |

All four types are recorded in the `signals` table with `confidence` and `direction`. Consumer query:
```sql
SELECT * FROM signals WHERE created_at > NOW() - INTERVAL '1 hour' ORDER BY confidence DESC;
```

---

## 8. Database Schema

Full Drizzle ORM schema — `src/db/schema.ts`.

**Design decisions vs v1:**
- `trades.transactionHash` is a **non-unique index** (a single tx can fill multiple trade records). Deduplication uses the composite key `(transactionHash, tokenId, proxyWallet, tradedAt, priceUsdc, sizeTokens)`.
- `signals.signalType` is typed to match the `SignalType` union — no orphan types.
- Partitioned tables are declared with `PARTITION BY RANGE` in the migration DDL (not in Drizzle schema, which does not natively support declarative partitioning — handled in raw SQL migrations).

```typescript
import {
  pgTable,
  text,
  integer,
  bigint,
  numeric,
  boolean,
  timestamp,
  jsonb,
  index,
  varchar,
  smallint,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────
// MARKETS — one row per outcome token (Yes/No = 2 rows per binary market)
// ─────────────────────────────────────────────────────────────────────
export const markets = pgTable(
  "markets",
  {
    tokenId: varchar("token_id", { length: 80 }).primaryKey(),
    conditionId: varchar("condition_id", { length: 66 }).notNull(),
    gammaMarketId: varchar("gamma_market_id", { length: 20 }),

    question: text("question").notNull(),
    slug: varchar("slug", { length: 200 }),
    eventSlug: varchar("event_slug", { length: 200 }),
    category: varchar("category", { length: 100 }),
    outcome: varchar("outcome", { length: 50 }).notNull(),
    outcomeIndex: smallint("outcome_index").notNull(),

    minimumOrderSize: numeric("minimum_order_size", { precision: 18, scale: 6 }),
    minimumTickSize: numeric("minimum_tick_size", { precision: 10, scale: 6 }),

    // negRisk: true → excluded from watchlist and signal processing in Phase 1
    negRisk: boolean("neg_risk").default(false),
    watchlisted: boolean("watchlisted").default(false),

    acceptingOrders: boolean("accepting_orders").default(false),
    active: boolean("active").default(true),
    closed: boolean("closed").default(false),

    endDate: timestamp("end_date", { withTimezone: true }),
    closedTime: timestamp("closed_time", { withTimezone: true }),
    winner: boolean("winner"),

    iconUrl: text("icon_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`NOW()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`NOW()`)
      .notNull(),
  },
  (t) => ({
    conditionIdx: index("markets_condition_id_idx").on(t.conditionId),
    activeWatchlistIdx: index("markets_active_watchlist_idx").on(t.active, t.watchlisted),
    negRiskIdx: index("markets_neg_risk_idx").on(t.negRisk),
    slugIdx: index("markets_slug_idx").on(t.slug),
  })
);

// ─────────────────────────────────────────────────────────────────────
// MARKET_STATS — latest aggregated stats per market (upserted on each Gamma poll)
// ─────────────────────────────────────────────────────────────────────
export const marketStats = pgTable(
  "market_stats",
  {
    tokenId: varchar("token_id", { length: 80 })
      .primaryKey()
      .references(() => markets.tokenId),
    conditionId: varchar("condition_id", { length: 66 }).notNull(),

    bestBid: numeric("best_bid", { precision: 10, scale: 6 }),
    bestAsk: numeric("best_ask", { precision: 10, scale: 6 }),
    mid: numeric("mid", { precision: 10, scale: 6 }),
    spread: numeric("spread", { precision: 10, scale: 6 }),
    lastTradePrice: numeric("last_trade_price", { precision: 10, scale: 6 }),

    volume24hr: numeric("volume_24hr", { precision: 20, scale: 6 }),
    volume1wk: numeric("volume_1wk", { precision: 20, scale: 6 }),
    volume1mo: numeric("volume_1mo", { precision: 20, scale: 6 }),
    volumeTotal: numeric("volume_total", { precision: 20, scale: 6 }),
    liquidityUsdc: numeric("liquidity_usdc", { precision: 20, scale: 6 }),
    openInterest: numeric("open_interest", { precision: 20, scale: 6 }),

    // Used by WhaleDetector dual-threshold: updated on each Gamma poll or trade batch
    avgTradeSize24h: numeric("avg_trade_size_24h", { precision: 20, scale: 6 }),
    stddevTradeSize24h: numeric("stddev_trade_size_24h", { precision: 20, scale: 6 }),

    oneDayPriceChange: numeric("one_day_price_change", { precision: 10, scale: 6 }),
    oneHourPriceChange: numeric("one_hour_price_change", { precision: 10, scale: 6 }),
    oneWeekPriceChange: numeric("one_week_price_change", { precision: 10, scale: 6 }),
    competitive: numeric("competitive", { precision: 10, scale: 4 }),

    refreshedAt: timestamp("refreshed_at", { withTimezone: true })
      .default(sql`NOW()`)
      .notNull(),
  },
  (t) => ({
    conditionIdx: index("market_stats_condition_id_idx").on(t.conditionId),
    volumeIdx: index("market_stats_volume_idx").on(t.volume24hr),
  })
);

// ─────────────────────────────────────────────────────────────────────
// TRADES — partitioned by traded_at (daily partitions via raw migration)
// ─────────────────────────────────────────────────────────────────────
export const trades = pgTable(
  "trades",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),

    tokenId: varchar("token_id", { length: 80 }).notNull(),
    conditionId: varchar("condition_id", { length: 66 }).notNull(),
    outcome: varchar("outcome", { length: 50 }).notNull(),

    side: varchar("side", { length: 4 }).notNull(), // "BUY" | "SELL"
    sizeTokens: numeric("size_tokens", { precision: 20, scale: 6 }).notNull(),
    priceUsdc: numeric("price_usdc", { precision: 10, scale: 6 }).notNull(),
    valueUsdc: numeric("value_usdc", { precision: 20, scale: 6 }).notNull(),

    proxyWallet: varchar("proxy_wallet", { length: 42 }).notNull(),

    // Non-unique: multiple trade rows can share a tx hash (partial fills).
    // Dedup key: (transactionHash, tokenId, proxyWallet, tradedAt, priceUsdc, sizeTokens)
    transactionHash: varchar("transaction_hash", { length: 66 }).notNull(),
    tradedAt: timestamp("traded_at", { withTimezone: true }).notNull(),

    marketSlug: varchar("market_slug", { length: 200 }),
    eventSlug: varchar("event_slug", { length: 200 }),
    marketTitle: text("market_title"),
    traderName: varchar("trader_name", { length: 100 }),
    traderPseudonym: varchar("trader_pseudonym", { length: 100 }),

    source: varchar("source", { length: 20 }).default("live_ws"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`NOW()`)
      .notNull(),
  },
  (t) => ({
    // Non-unique index on tx hash — dedup is via application-layer composite check
    txHashIdx: index("trades_tx_hash_idx").on(t.transactionHash),
    tokenTimeIdx: index("trades_token_time_idx").on(t.tokenId, t.tradedAt),
    conditionTimeIdx: index("trades_condition_time_idx").on(t.conditionId, t.tradedAt),
    walletIdx: index("trades_wallet_idx").on(t.proxyWallet),
    valueIdx: index("trades_value_idx").on(t.valueUsdc),
    timeIdx: index("trades_time_idx").on(t.tradedAt),
  })
);

// ─────────────────────────────────────────────────────────────────────
// ORDER_BOOK_SNAPSHOTS — partitioned by captured_at (daily)
// Phase 1: written by REST batch poller (30s timer)
// Phase 2+: written by ClobWsPool on book events
// ─────────────────────────────────────────────────────────────────────
export const orderBookSnapshots = pgTable(
  "order_book_snapshots",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),

    tokenId: varchar("token_id", { length: 80 }).notNull(),
    conditionId: varchar("condition_id", { length: 66 }).notNull(),

    // Top 20 levels per side: [{ price: string, size: string }]
    bids: jsonb("bids").notNull(),
    asks: jsonb("asks").notNull(),

    bidDepthUsdc: numeric("bid_depth_usdc", { precision: 20, scale: 2 }),
    askDepthUsdc: numeric("ask_depth_usdc", { precision: 20, scale: 2 }),
    imbalanceRatio: numeric("imbalance_ratio", { precision: 10, scale: 4 }),
    mid: numeric("mid", { precision: 10, scale: 6 }),
    spread: numeric("spread", { precision: 10, scale: 6 }),
    bookHash: varchar("book_hash", { length: 40 }),

    // "rest_timer" (Phase 1) | "ws_event" (Phase 2+)
    snapshotTrigger: varchar("snapshot_trigger", { length: 20 }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    tokenTimeIdx: index("obs_token_time_idx").on(t.tokenId, t.capturedAt),
    conditionIdx: index("obs_condition_idx").on(t.conditionId),
    imbalanceIdx: index("obs_imbalance_idx").on(t.imbalanceRatio),
  })
);

// ─────────────────────────────────────────────────────────────────────
// PRICE_HISTORY — lightweight price series for velocity calculations
// ─────────────────────────────────────────────────────────────────────
export const priceHistory = pgTable(
  "price_history",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),

    tokenId: varchar("token_id", { length: 80 }).notNull(),
    conditionId: varchar("condition_id", { length: 66 }).notNull(),

    price: numeric("price", { precision: 10, scale: 6 }).notNull(),
    side: varchar("side", { length: 4 }),
    eventType: varchar("event_type", { length: 30 }).notNull(), // "last_trade" | "best_bid" | "best_ask" | "mid"

    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    tokenTimeIdx: index("ph_token_time_idx").on(t.tokenId, t.recordedAt),
    conditionIdx: index("ph_condition_idx").on(t.conditionId),
    recentIdx: index("ph_recent_idx").on(t.recordedAt),
  })
);

// ─────────────────────────────────────────────────────────────────────
// WHALE_ALERTS — detected big bets (permanent retention)
// ─────────────────────────────────────────────────────────────────────
export const whaleAlerts = pgTable(
  "whale_alerts",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),

    tradeId: bigint("trade_id", { mode: "number" })
      .notNull()
      .references(() => trades.id),
    tokenId: varchar("token_id", { length: 80 }).notNull(),
    conditionId: varchar("condition_id", { length: 66 }).notNull(),

    usdcValue: numeric("usdc_value", { precision: 20, scale: 2 }).notNull(),

    // Threshold state at detection time (dual-threshold snapshot for auditability)
    absoluteMinUsdc: integer("absolute_min_usdc").notNull(),
    avgTradeSize24hAtAlert: numeric("avg_trade_size_24h_at_alert", { precision: 20, scale: 6 }),
    stddev24hAtAlert: numeric("stddev_24h_at_alert", { precision: 20, scale: 6 }),
    volume24hAtAlert: numeric("volume_24h_at_alert", { precision: 20, scale: 6 }),
    sigmasAboveMean: numeric("sigmas_above_mean", { precision: 8, scale: 4 }),
    pctOfDailyVolume: numeric("pct_of_daily_volume", { precision: 8, scale: 4 }),

    priceAtAlert: numeric("price_at_alert", { precision: 10, scale: 6 }),
    priceImpactEstimateUsdc: numeric("price_impact_estimate_usdc", { precision: 10, scale: 6 }),
    bookDepthConsumedPct: numeric("book_depth_consumed_pct", { precision: 6, scale: 2 }),
    bookSnapshotAgeMs: integer("book_snapshot_age_ms"), // staleness of the book used for impact est.

    // Wallet enrichment (filled async)
    walletTotalVolumeUsdc: numeric("wallet_total_volume_usdc", { precision: 20, scale: 2 }),
    walletTradeCount: integer("wallet_trade_count"),
    walletFirstSeenAt: timestamp("wallet_first_seen_at", { withTimezone: true }),
    walletWinRatio: numeric("wallet_win_ratio", { precision: 6, scale: 4 }),
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),

    alertedAt: timestamp("alerted_at", { withTimezone: true })
      .default(sql`NOW()`)
      .notNull(),
  },
  (t) => ({
    tokenTimeIdx: index("wa_token_time_idx").on(t.tokenId, t.alertedAt),
    valueIdx: index("wa_value_idx").on(t.usdcValue),
    conditionIdx: index("wa_condition_idx").on(t.conditionId),
  })
);

// ─────────────────────────────────────────────────────────────────────
// SIGNALS — all computed alpha signals (permanent retention)
// signalType is constrained to the four types defined in §9 types.
// ─────────────────────────────────────────────────────────────────────
export const signals = pgTable(
  "signals",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),

    tokenId: varchar("token_id", { length: 80 }).notNull(),
    conditionId: varchar("condition_id", { length: 66 }).notNull(),

    // Must be one of the four SignalType values — no composite signal in this version
    signalType: varchar("signal_type", { length: 40 }).notNull(),
    // "WHALE_TRADE" | "ORDER_BOOK_IMBALANCE" | "PRICE_IMPACT_ANOMALY" | "SENTIMENT_VELOCITY"

    direction: varchar("direction", { length: 10 }), // "BULLISH" | "BEARISH" | "NEUTRAL"
    confidence: numeric("confidence", { precision: 6, scale: 4 }).notNull(),
    strength: numeric("strength", { precision: 10, scale: 4 }),

    priceAtSignal: numeric("price_at_signal", { precision: 10, scale: 6 }),
    spreadAtSignal: numeric("spread_at_signal", { precision: 10, scale: 6 }),
    volumeAtSignal: numeric("volume_at_signal", { precision: 20, scale: 6 }),

    whaleAlertId: bigint("whale_alert_id", { mode: "number" })
      .references(() => whaleAlerts.id),
    orderBookSnapshotId: bigint("order_book_snapshot_id", { mode: "number" })
      .references(() => orderBookSnapshots.id),

    payload: jsonb("payload"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`NOW()`)
      .notNull(),
  },
  (t) => ({
    tokenTimeIdx: index("signals_token_time_idx").on(t.tokenId, t.createdAt),
    typeTimeIdx: index("signals_type_time_idx").on(t.signalType, t.createdAt),
    confidenceIdx: index("signals_confidence_idx").on(t.confidence),
    conditionIdx: index("signals_condition_idx").on(t.conditionId),
  })
);

// ─────────────────────────────────────────────────────────────────────
// WALLET_PROFILES — enriched whale wallet history
// ─────────────────────────────────────────────────────────────────────
export const walletProfiles = pgTable(
  "wallet_profiles",
  {
    proxyWallet: varchar("proxy_wallet", { length: 42 }).primaryKey(),

    totalVolumeUsdc: numeric("total_volume_usdc", { precision: 20, scale: 2 }),
    tradeCount: integer("trade_count").default(0),
    whaleTradeCount: integer("whale_trade_count").default(0),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),

    resolvedTradeCount: integer("resolved_trade_count").default(0),
    winCount: integer("win_count").default(0),
    winRatio: numeric("win_ratio", { precision: 6, scale: 4 }),

    displayName: varchar("display_name", { length: 100 }),
    pseudonym: varchar("pseudonym", { length: 100 }),

    lastEnrichedAt: timestamp("last_enriched_at", { withTimezone: true }),
    enrichmentVersion: smallint("enrichment_version").default(0),
  },
  (t) => ({
    volumeIdx: index("wp_volume_idx").on(t.totalVolumeUsdc),
    winRatioIdx: index("wp_win_ratio_idx").on(t.winRatio),
  })
);
```

### Drizzle Config

```typescript
// drizzle.config.ts
import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
} satisfies Config;
```

### Partition Migration (raw SQL, Phase 1)

```sql
-- drizzle/0002_partition_trades.sql
-- Convert trades to a partitioned table (run after initial schema migration)
ALTER TABLE trades RENAME TO trades_legacy;

CREATE TABLE trades (LIKE trades_legacy INCLUDING ALL)
  PARTITION BY RANGE (traded_at);

-- Seed initial partitions; partition manager script adds future ones daily
CREATE TABLE trades_2026_04 PARTITION OF trades
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

INSERT INTO trades SELECT * FROM trades_legacy;
DROP TABLE trades_legacy;

-- Same pattern for order_book_snapshots
ALTER TABLE order_book_snapshots RENAME TO order_book_snapshots_legacy;
CREATE TABLE order_book_snapshots (LIKE order_book_snapshots_legacy INCLUDING ALL)
  PARTITION BY RANGE (captured_at);
CREATE TABLE order_book_snapshots_2026_04 PARTITION OF order_book_snapshots
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
INSERT INTO order_book_snapshots SELECT * FROM order_book_snapshots_legacy;
DROP TABLE order_book_snapshots_legacy;
```

---

## 9. API / Module Design

### Module Boundaries

```
src/
├── db/
│   ├── schema.ts          # Drizzle schema (§8)
│   ├── client.ts          # drizzle(pool) singleton
│   ├── partition-manager.ts  # creates future partitions, drops expired ones
│   └── queries/
│       ├── markets.ts     # upsertMarket, getWatchlistedMarkets, getMarketStats
│       ├── trades.ts      # insertTrade (dedup check), getTradesByWallet
│       ├── snapshots.ts   # insertBookSnapshot, getLatestBook
│       ├── signals.ts     # insertSignal, getRecentSignals
│       └── whales.ts      # insertWhaleAlert, enrichWhaleAlert
│
├── sources/
│   ├── clob-ws-pool.ts         # ClobWsPool: N sharded connections
│   ├── live-data-ws-client.ts  # LiveDataWsClient: global trade feed
│   ├── gamma-poller.ts         # GammaPoller: REST market catalog
│   └── clob-rest-client.ts     # ClobRestClient: /books batch, /prices-history
│
├── events/
│   ├── types.ts           # All internal event types and SignalType union
│   └── bus.ts             # Typed EventEmitter bus
│
├── processors/
│   ├── whale-detector.ts         # Dual-threshold whale detection
│   ├── book-imbalance-engine.ts  # ORDER_BOOK_IMBALANCE signal
│   ├── snapshot-writer.ts        # REST-polled snapshots (Phase 1)
│   ├── price-history-writer.ts   # Price series persistence
│   ├── signal-aggregator.ts      # Writes Signal records to DB
│   └── wallet-enricher.ts        # Async data-api enrichment queue
│
├── signals/
│   ├── whale-signal.ts       # WHALE_TRADE algorithm
│   ├── imbalance-signal.ts   # ORDER_BOOK_IMBALANCE algorithm
│   ├── price-impact-signal.ts # PRICE_IMPACT_ANOMALY algorithm
│   └── velocity-signal.ts    # SENTIMENT_VELOCITY algorithm
│
├── config.ts              # Env-based config with defaults
├── pipeline.ts            # Wires all components
└── index.ts               # Entrypoint
```

### Core Types (`src/events/types.ts`)

```typescript
// ─── Primitive units ───────────────────────────────────────────────
export type TokenId = string;
export type ConditionId = string;
export type WalletAddress = string;
export type TxHash = string;

// ─── Order book ────────────────────────────────────────────────────
export interface PriceLevel {
  price: number;  // 0.00–1.00
  size: number;
}

export interface OrderBook {
  tokenId: TokenId;
  conditionId: ConditionId;
  bids: PriceLevel[];  // sorted desc
  asks: PriceLevel[];  // sorted asc
  timestamp: number;   // ms
  hash: string;
  capturedAt: Date;    // wall-clock time of capture (for staleness checks)
}

// ─── Trade event ───────────────────────────────────────────────────
export interface TradeEvent {
  tokenId: TokenId;
  conditionId: ConditionId;
  side: "BUY" | "SELL";
  sizeTokens: number;
  priceUsdc: number;
  valueUsdc: number;
  proxyWallet: WalletAddress;
  transactionHash: TxHash;
  tradedAt: Date;
  outcome: string;
  marketSlug: string;
  eventSlug: string;
  marketTitle: string;
  traderName?: string;
  traderPseudonym?: string;
  source: "live_ws" | "data_api";
}

// ─── Market stats snapshot (used by WhaleDetector) ─────────────────
export interface MarketStats {
  tokenId: TokenId;
  volume24hr: number;
  avgTradeSize24h: number;
  stddevTradeSize24h: number;
  liquidityUsdc: number;
}

// ─── CLOB WS events ────────────────────────────────────────────────
export interface BookUpdateEvent {
  type: "book";
  book: OrderBook;
}

export interface PriceChangeEvent {
  type: "price_change";
  tokenId: TokenId;
  price: number;
  side: "BUY" | "SELL";
  timestamp: number;
}

export interface BestBidAskEvent {
  type: "best_bid_ask";
  tokenId: TokenId;
  bid: number;
  ask: number;
  timestamp: number;
}

export interface LastTradePriceEvent {
  type: "last_trade_price";
  tokenId: TokenId;
  price: number;
  side: "BUY" | "SELL";
  timestamp: number;
}

// ─── Signal types ──────────────────────────────────────────────────
// Exactly four signal types — no composite signals in this version.
export type SignalType =
  | "WHALE_TRADE"
  | "ORDER_BOOK_IMBALANCE"
  | "PRICE_IMPACT_ANOMALY"
  | "SENTIMENT_VELOCITY";

export type SignalDirection = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface BaseSignal {
  signalType: SignalType;
  tokenId: TokenId;
  conditionId: ConditionId;
  direction: SignalDirection;
  confidence: number;  // 0.0–1.0
  strength: number;
  priceAtSignal: number;
  createdAt: Date;
  payload: Record<string, unknown>;
}

export interface WhaleSignal extends BaseSignal {
  signalType: "WHALE_TRADE";
  usdcValue: number;
  sigmasAboveMean: number;
  pctOfDailyVolume: number;
  proxyWallet: WalletAddress;
  transactionHash: TxHash;
  priceImpactEstimate: number;
  bookDepthConsumedPct: number;
  bookSnapshotAgeMs: number;
}

export interface ImbalanceSignal extends BaseSignal {
  signalType: "ORDER_BOOK_IMBALANCE";
  imbalanceRatio: number;
  bidDepthUsdc: number;
  askDepthUsdc: number;
}

export interface PriceImpactSignal extends BaseSignal {
  signalType: "PRICE_IMPACT_ANOMALY";
  priceChangePct: number;
  windowSeconds: number;
  triggeringTradeValueUsdc: number;
}

export interface VelocitySignal extends BaseSignal {
  signalType: "SENTIMENT_VELOCITY";
  velocityZScore: number;
  hourlyPriceChangePct: number;
  baselineStdDev: number;
}

export type Signal =
  | WhaleSignal
  | ImbalanceSignal
  | PriceImpactSignal
  | VelocitySignal;

// ─── Whale alert ───────────────────────────────────────────────────
export interface WhaleAlert {
  trade: TradeEvent;
  usdcValue: number;
  marketStats: MarketStats;
  priceAtAlert: number;
  priceImpactEstimateUsdc: number;
  bookDepthConsumedPct: number;
  bookSnapshotAgeMs: number;
  book: OrderBook | null;
  signal: WhaleSignal;
}

// ─── Config ────────────────────────────────────────────────────────
export interface PipelineConfig {
  // Whale detection (dual-threshold)
  absoluteMinUsdc: number;            // default: 10_000
  relativeStddevMultiplier: number;   // default: 3.0 (σ)
  relativePctOfVolume: number;        // default: 0.02 (2%)

  // Watchlist
  watchlistSize: number;              // default: 200 (non-neg-risk tokens by volume24hr)
  clobWsShardSize: number;            // default: 150 (token IDs per WS connection)

  // Polling & batching
  restSnapshotIntervalMs: number;     // default: 30_000
  gammaPollingIntervalMs: number;     // default: 60_000
  tradeBatchSize: number;             // default: 100
  tradeBatchFlushMs: number;          // default: 500

  // Signal thresholds
  imbalanceRatioThreshold: number;    // default: 3.0
  priceImpactWindowSeconds: number;   // default: 60
  priceImpactMinChangePct: number;    // default: 2.0
  velocityZScoreThreshold: number;    // default: 2.0

  // Reconnect
  reconnectBaseMs: number;            // default: 1_000
  reconnectMaxMs: number;             // default: 30_000

  // Enrichment
  walletEnrichmentRateLimitRps: number; // default: 2

  // Minimum liquidity for signal emission (guard against thin markets)
  minLiquidityForSignalUsdc: number;  // default: 50_000
}
```

### Key Interfaces

```typescript
// src/sources/clob-ws-pool.ts
export interface ClobWsPool {
  connect(tokenIds: TokenId[]): Promise<void>;
  addTokenIds(newIds: TokenId[]): Promise<void>;
  disconnect(): void;
  on(event: "book", handler: (e: BookUpdateEvent) => void): void;
  on(event: "price_change", handler: (e: PriceChangeEvent) => void): void;
  on(event: "best_bid_ask", handler: (e: BestBidAskEvent) => void): void;
  on(event: "last_trade_price", handler: (e: LastTradePriceEvent) => void): void;
  on(event: "shard_reconnect", handler: (shardIndex: number) => void): void;
  on(event: "error", handler: (err: Error, shardIndex: number) => void): void;
}

// src/processors/whale-detector.ts
export interface WhaleDetector {
  evaluate(trade: TradeEvent, stats: MarketStats, book: OrderBook | null): WhaleAlert | null;
}

// src/sources/gamma-poller.ts
export interface GammaPoller {
  start(): void;
  stop(): void;
  getWatchlist(): TokenId[];
  on(event: "markets_updated", handler: (tokenIds: TokenId[], negRiskIds: TokenId[]) => void): void;
}
```

---

## 10. Signal Algorithms

### 10.1 Whale Detection (`WHALE_TRADE`)

**Dual-threshold rule — both conditions must pass:**

```
usdcValue = trade.sizeTokens × trade.priceUsdc

// Gate 1: absolute minimum (filters dust)
if usdcValue < absoluteMinUsdc (default 10_000): return null

// Gate 2: relative to market (calibrates for liquidity)
stats = marketStats[trade.tokenId]

sigmasAboveMean = (usdcValue - stats.avgTradeSize24h) / stats.stddevTradeSize24h
pctOfDailyVolume = usdcValue / stats.volume24hr

isRelativeLarge =
  (sigmasAboveMean >= relativeStddevMultiplier)   // ≥ 3σ above mean
  OR (pctOfDailyVolume >= relativePctOfVolume)    // ≥ 2% of daily volume

if NOT isRelativeLarge: return null
```

Apply this rule everywhere whale detection is referenced — alert output, DB records, roadmap exit criteria. The old static `$50k` threshold is retired.

**Price impact estimate:**
```
book = getCurrentBookSnapshot(trade.tokenId)
bookSnapshotAgeMs = NOW - book.capturedAt
consumed = walkBook(
  side = trade.side,
  levels = trade.side === "BUY" ? book.asks : book.bids,
  totalUsdc = usdcValue
)
priceImpactEstimateUsdc = consumed.avgFillPrice - book.mid
bookDepthConsumedPct = consumed.totalFilled / book.totalDepth × 100
```
Estimates older than 30s are flagged in the alert output with a staleness note.

**Confidence:**
```
// Larger sigma = more confident. Anchored at 3σ → 0.5; 6σ → 1.0.
confidence = Math.min(1.0, sigmasAboveMean / 6)
```

**Liquidity guard:** skip signal emission (but still persist the trade) if `stats.liquidityUsdc < minLiquidityForSignalUsdc (50_000)`.

**Edge cases:**
- Book snapshot absent: emit alert, set `bookDepthConsumedPct = null`, note "no book data" in payload.
- `stddevTradeSize24h = 0` or `null` (market too new): skip relative-σ check; apply only the pct-of-volume check.
- SELL on NO outcome is directionally bullish on the underlying event — captured in `direction` field, not filtered.

---

### 10.2 Order Book Imbalance (`ORDER_BOOK_IMBALANCE`)

```
// Called on every BookUpdateEvent (Phase 2) or each REST snapshot write (Phase 1)
bids = snapshot.bids.slice(0, 10)
asks = snapshot.asks.slice(0, 10)

bidDepthUsdc = Σ (bid.price × bid.size)
askDepthUsdc = Σ (ask.price × ask.size)
imbalanceRatio = bidDepthUsdc / askDepthUsdc

if imbalanceRatio > THRESHOLD (3.0):
  direction = "BULLISH"
  confidence = Math.min(1.0, (imbalanceRatio - 1) / 4)
  emit ImbalanceSignal

if imbalanceRatio < 1/THRESHOLD (0.333):
  direction = "BEARISH"
  confidence = Math.min(1.0, (1 - imbalanceRatio) × 3)
  emit ImbalanceSignal
```

**Debounce:** Do not re-emit within 5 minutes for the same token, unless ratio has shifted by > 0.5.

**Note:** Polymarket's unified CLOB means a BUY YES at $0.60 is also a SELL NO at $0.40. Single-sided metrics are approximate directional heuristics, not authoritative depth measures.

---

### 10.3 Price Impact Anomaly (`PRICE_IMPACT_ANOMALY`)

```
windowMs = priceImpactWindowSeconds × 1000   // default 60s
priceWindow = getPriceHistory(tokenId, since: NOW - windowMs)

if priceWindow.length < 2: return null

priceStart = priceWindow[0].price
priceEnd   = priceWindow[priceWindow.length - 1].price
changePct  = |priceEnd - priceStart| / priceStart × 100

if changePct < priceImpactMinChangePct (2.0): return null
if stats.liquidityUsdc < minLiquidityForSignalUsdc: return null

windowTrades = getTradesInWindow(tokenId, windowMs)
triggeringTrade = max(windowTrades, by: valueUsdc)

direction  = priceEnd > priceStart ? "BULLISH" : "BEARISH"
confidence = Math.min(1.0, changePct / 10)
strength   = changePct
```

---

### 10.4 Sentiment Velocity (`SENTIMENT_VELOCITY`)

```
// Scheduled 5-min scan for all watchlisted markets
history24h = getPriceHistory(tokenId, since: NOW - 24h, bucketMinutes: 5)

if history24h.length < 20: return null   // < 100 min of history

returns = pairwise (a, b) → (b.price - a.price) / a.price
baselineMean   = mean(returns)
baselineStdDev = stdDev(returns)

recentHistory   = last(history24h, 12)   // 60 min
recentReturn    = (recentHistory.last - recentHistory.first) / recentHistory.first
hourlyChangePct = recentReturn × 100
zScore          = (recentReturn - baselineMean) / baselineStdDev

if |zScore| < velocityZScoreThreshold (2.0): return null
if stats.liquidityUsdc < minLiquidityForSignalUsdc: return null

direction  = zScore > 0 ? "BULLISH" : "BEARISH"
confidence = Math.min(1.0, |zScore| / 4)
strength   = zScore
```

**Bootstrap rule:** markets younger than 2 hours use category-median baseline stats.

---

> **Composite signals are out of scope for this version.** The `SignalAggregator` writes individual signal records; cross-signal correlation is a Phase 5 item. Do not add `COMPOSITE_SIGNAL` to `SignalType` until a `CompositeSignal` interface and roadmap tasks are added together.

---

## 11. Implementation Roadmap

### Phase 1 — Data Foundation (Week 1–2)

**Goal:** Trades, market catalog, and order book snapshots flow into Postgres. The pipeline runs without crashing.

- [ ] **1.1** Repo scaffold: `pnpm init`, `tsconfig.json`, Drizzle + `pg`, Vitest, `dotenv`
- [ ] **1.2** `src/db/schema.ts`: all 7 tables (§8)
- [ ] **1.3** Drizzle migrations (schema) + raw partition migration (`0002_partition_trades.sql`)
- [ ] **1.4** `GammaPoller`: fetch active markets, separate neg_risk set, build watchlist, upsert `markets` + `market_stats` (including `avgTradeSize24h`, `stddevTradeSize24h`)
- [ ] **1.5** `LiveDataWsClient`: connect, subscribe `activity/trades`, filter neg_risk token IDs, parse to `TradeEvent`, write to `trades` (with dedup composite-key check)
- [ ] **1.6** `ClobRestClient`: `batchGetBooks(tokenIds[])`, `getSamplingMarkets()`, `getPricesHistory()`
- [ ] **1.7** `SnapshotWriter` (REST mode): on 30s timer, call `ClobRestClient.batchGetBooks()` for all watchlisted tokens, compute aggregates, write to `order_book_snapshots` with `snapshotTrigger = "rest_timer"`
- [ ] **1.8** `PartitionManager`: `createTomorrowPartition()` cron, `dropExpiredPartitions()` cron

**Exit criteria:**
- After 10 minutes running: `trades` has > 100 rows; `order_book_snapshots` has rows for all watchlisted markets; all rows have `snapshotTrigger = "rest_timer"`.
- `markets` table shows neg_risk markets with `watchlisted = false`.
- No crash on WS reconnect.

---

### Phase 2 — CLOB WebSocket Pool + Whale Alerts (Week 3)

**Goal:** Real-time book updates from sharded WS pool. Dual-threshold whale alerts firing within 1 second.

- [ ] **2.1** `ClobWsPool`: shard watchlist into batches of `clobWsShardSize` (default 150), open N connections, implement per-shard independent reconnect
- [ ] **2.2** In-memory book cache: maintain current book state per `token_id`; updated by every `book` / `price_change` event from pool
- [ ] **2.3** `SnapshotWriter` upgrade: switch to WS-event-driven mode (`snapshotTrigger = "ws_event"`) — keep REST poller as fallback for shards in reconnect state
- [ ] **2.4** `WhaleDetector`: implement dual-threshold (§10.1), price impact estimation, emit `WhaleAlert`
- [ ] **2.5** `whaleAlerts` table writes: persist every detected alert with threshold snapshot
- [ ] **2.6** Console alerter: formatted whale alert to stdout (see §7.2 sample)
- [ ] **2.7** `WalletEnricher`: async data-api fetch queue, rate-limited to `walletEnrichmentRateLimitRps (2 req/s)`, enriches alert row on completion
- [ ] **2.8** Discord/Slack webhook: `fetch` POST to `ALERT_WEBHOOK_URL` env var if set

**Exit criteria:**
- A trade satisfying the dual threshold produces a console alert within 1s.
- Wallet enrichment completes within 5s when data-api is responsive.
- `ClobWsPool` survives a simulated disconnect: shard reconnects, re-subscribes, resumes book events within 30s.

---

### Phase 3 — Signal Engine (Week 4)

**Goal:** All four signal types computed and persisted.

- [ ] **3.1** `OrderBookImbalanceEngine`: §10.2, debounce, writes `ImbalanceSignal`
- [ ] **3.2** `PriceHistoryWriter`: consumes `LastTradePriceEvent` + `BestBidAskEvent`, persists to `price_history`
- [ ] **3.3** `PriceImpactSignal`: §10.3, rolling price window from DB
- [ ] **3.4** `VelocitySignal`: §10.4, 5-min scheduled scan
- [ ] **3.5** `SignalAggregator`: writes all signal types to `signals` table (enforces `SignalType` union — no unlisted types)

**Exit criteria:**
```sql
SELECT signal_type, count(*), round(avg(confidence)::numeric, 3)
FROM signals GROUP BY 1;
```
Shows all four types with reasonable distributions after 1 hour running.

---

### Phase 4 — Hardening & Observability (Week 5)

**Goal:** Pipeline runs 24/7 without intervention.

- [ ] **4.1** GammaPoller watchlist refresh propagates new token IDs to `ClobWsPool.addTokenIds()`
- [ ] **4.2** Stale shard detection: warn if any shard silent > 60s
- [ ] **4.3** Structured logging: `pino` JSON logs with `level`, `source`, `tokenId`, `latencyMs`
- [ ] **4.4** Prometheus metrics endpoint (optional): events/s, db write latency, alert count per hour
- [ ] **4.5** Graceful shutdown: `SIGINT` → flush trade batch → close WS pool → close DB pool
- [ ] **4.6** Docker Compose: `postgres:16`, `app` service, `.env` mapping

**Exit criteria:** Pipeline survives simulated WS disconnect, re-subscribes within 30s, no data gap.

---

### Phase 5 — Signal Backtesting & Tuning (Week 6+)

**Goal:** Signal quality validated against resolved markets. Neg-risk support designed.

- [ ] **5.1** Backfill script: fetch `/prices-history` for top 100 markets
- [ ] **5.2** Signal replay over historical data
- [ ] **5.3** Resolution join: match signals against `closed=true` Gamma markets
- [ ] **5.4** Threshold tuning: optimize `relativeStddevMultiplier`, `relativePctOfVolume`, `velocityZScoreThreshold` via precision/recall on backtest
- [ ] **5.5** Wallet leaderboard: win-rate ranking for enriched whale wallets
- [ ] **5.6** Neg-risk market design: cross-book pricing model spec for Phase 6

---

## 12. Testing Strategy

### Framework: Vitest

All tests in `src/**/*.test.ts`.

### Unit Tests

```typescript
// src/processors/__tests__/whale-detector.test.ts
describe("WhaleDetector (dual-threshold)", () => {
  it("fires when valueUsdc >= absoluteMin AND sigmas >= 3", () => { ... });
  it("fires when valueUsdc >= absoluteMin AND pctOfVolume >= 2%", () => { ... });
  it("does not fire when only absoluteMin passed (relative check fails)", () => { ... });
  it("does not fire when below absoluteMin even if relative check passes", () => { ... });
  it("handles stddevTradeSize24h = 0: falls back to pct-of-volume only", () => { ... });
  it("handles null book snapshot: emits alert with null impact fields", () => { ... });
  it("marks SELL as BEARISH", () => { ... });
  it("marks BUY as BULLISH", () => { ... });
  it("caps confidence at 1.0", () => { ... });
  it("skips signal emission when liquidityUsdc < minLiquidityForSignalUsdc", () => { ... });
  it("annotates bookSnapshotAgeMs correctly", () => { ... });
});

// src/processors/__tests__/book-imbalance-engine.test.ts
describe("OrderBookImbalanceEngine", () => {
  it("emits BULLISH when bid:ask > 3:1", () => { ... });
  it("emits BEARISH when bid:ask < 1:3", () => { ... });
  it("does not emit when ratio in normal range", () => { ... });
  it("debounces within 5 minutes unless ratio shifted > 0.5", () => { ... });
  it("correctly computes depth: price × size sum over top 10 levels", () => { ... });
});

// src/sources/__tests__/clob-ws-pool.test.ts
describe("ClobWsPool", () => {
  it("shards tokenIds into batches of clobWsShardSize", () => { ... });
  it("reconnects individual shard independently on disconnect", () => { ... });
  it("re-subscribes all shard token IDs on shard reconnect", () => { ... });
  it("addTokenIds: distributes new IDs to existing shards or opens new shard", () => { ... });
  it("emits shard_reconnect event with correct shard index", () => { ... });
});

// src/signals/__tests__/velocity-signal.test.ts
describe("VelocitySignal", () => {
  it("skips markets with < 20 history points", () => { ... });
  it("computes z-score correctly", () => { ... });
  it("fires only when |z| >= threshold", () => { ... });
  it("uses category-median baseline for markets < 2h old", () => { ... });
});

// src/db/__tests__/trades.test.ts
describe("insertTrade dedup", () => {
  it("inserts first occurrence", () => { ... });
  it("skips duplicate on (txHash, tokenId, proxyWallet, tradedAt, price, size)", () => { ... });
  it("allows two rows sharing same txHash when other fields differ", () => { ... });
});
```

### Integration Tests

```typescript
// src/__tests__/pipeline.integration.test.ts
describe("Pipeline integration (requires DATABASE_URL)", () => {
  it("GammaPoller: writes markets with negRisk flag, watchlisted=false for neg_risk", async () => { ... });
  it("TradeEvent: persists with correct valueUsdc", async () => { ... });
  it("WhaleAlert: fires on dual-threshold breach and persists threshold snapshot", async () => { ... });
  it("SnapshotWriter (REST): writes book snapshot with snapshotTrigger=rest_timer", async () => { ... });
  it("PartitionManager: creates tomorrow's partition if missing", async () => { ... });
});
```

### Fixtures

- `tests/fixtures/book-event.json` — real CLOB WS `book` event payload
- `tests/fixtures/trade-event.json` — real Live-Data WS `trades` payload
- `tests/fixtures/gamma-market.json` — real Gamma API market object (includes `negRisk: false`)
- `tests/fixtures/gamma-market-neg-risk.json` — neg_risk market for filter tests
- `tests/fixtures/whale-trade.json` — synthetic trade, `valueUsdc = 75_000`, `sigmasAboveMean = 4.2`

### Coverage Targets

| Layer | Target |
|---|---|
| Signal algorithms | 90%+ |
| DB queries | 80%+ |
| WS pool / clients | 70%+ (mock WS) |
| Integration | Critical path only |

### CI Commands

```bash
pnpm test               # unit tests
pnpm test:integration   # requires DATABASE_URL
pnpm test:coverage      # vitest --coverage
```

---

## 13. Risks and Mitigations

### Rate Limits

| Source | Observed Limit | Mitigation |
|---|---|---|
| CLOB REST public | ~10 req/s (undocumented) | Batch `/books`; memory-cached book state; WS as primary source in Phase 2 |
| Gamma REST | ~20 req/s (undocumented) | 60s polling, paginated top-200 only |
| data-api (enrichment) | Unknown | In-process queue; rate-limited to 2 req/s; graceful degradation on 429 |
| Live-Data WS | No documented limit | Single global connection, no per-market subscription needed |
| CLOB WS | Unknown per-shard token limit | Default shard size 150; reduce to 100 if rejections observed |

**429 handling:** back off 30s, retry. Do not crash the pipeline. Log all 429s for threshold tuning.

---

### WebSocket Scaling

| Risk | Impact | Mitigation |
|---|---|---|
| CLOB WS token limit per connection | Dropped events if limit exceeded | `ClobWsPool` shards at 150 tokens/connection; configurable via `clobWsShardSize` |
| Single shard failure | Loss of book events for that shard's tokens | Per-shard independent reconnect; REST poller provides snapshot fallback during gap |
| All shards silent (total WS outage) | No book updates | `SnapshotWriter` REST fallback auto-activates; alert logged |

---

### Data Quality

| Gap | Impact | Mitigation |
|---|---|---|
| WS reconnect gap | Missed trades | On reconnect, fetch last 50 trades from `data-api/trades` for all shard tokens |
| Book snapshot staleness | Inaccurate price impact estimate | Annotate `bookSnapshotAgeMs`; flag estimates > 30s old in alert output |
| `size × price` vs USDC | Token price is a probability; `valueUsdc` = USDC spent, not max payout | Document clearly; never call it "notional exposure" |
| Anonymous wallets | Enrichment may return sparse data | Store `proxyWallet`; Goldsky positions subgraph still yields position size |
| Goldsky indexing lag | Historical enrichment stale by minutes during reorgs | Use Goldsky only for offline enrichment; never real-time signal path |

---

### Market Manipulation False Positives

| Pattern | Risk | Mitigation |
|---|---|---|
| Wash trading | Same wallet inflates signal volume | Track round-trip pairs; flag if same wallet both sides within 60s |
| Thin-market manipulation | Small capital moves price > 10% | `minLiquidityForSignalUsdc` guard (default $50k) |
| Split whale clusters | ≥ 3 wallets, similar sizes, same market, within 30s | Heuristic flagging: `coordinated_cluster` tag on alerts; threshold = 3 trades summing > absolute min |
| Resolution gaming | Large bets seconds before resolution | Suppress signals if `endDate < NOW + 1 hour` |

---

### Operational Risks

| Risk | Mitigation |
|---|---|
| Polymarket API downtime | Exponential backoff, REST snapshot fallback, structured alerts |
| Postgres write saturation | Benchmark at 1000 trades/s; partitioned tables make bulk deletes cheap; add TimescaleDB if needed |
| Schema changes by Polymarket | `zod` `safeParse` on all inbound payloads; log unknown fields instead of crashing |
| Geo-blocking (US IPs) | Run pipeline on non-US infrastructure |
| Neg-risk events processed in error | Explicit `watchlisted = false` flag; filter at event bus boundary; covered by integration test |

---

## 14. Open Questions

1. **CLOB WS per-connection token ID limit.** The protocol accepts arbitrary-length `assets_ids` arrays, but the server's actual limit is undocumented. Default shard size set conservatively at 150. If the server rejects or silently drops subscriptions above a lower threshold, reduce to 100 and add a shard health check that verifies expected event rate post-subscribe.

2. **`data-api/trades` pagination depth for enrichment.** Current plan fetches `limit=50` per wallet. If a high-frequency whale has 5000+ trades, the 50-trade sample may not yield a representative win rate. Design question: should enrichment paginate fully (expensive) or sample the most recent 50 only (fast, possibly misleading)?

3. **`avgTradeSize24h` / `stddevTradeSize24h` computation source.** Phase 1 derives these from the Gamma API (which provides volume and trade counts) and live trade accumulation. For very new markets (< 24h), these stats are unreliable. Acceptable to skip relative-σ check and use pct-of-volume only until 24h of data accumulates?

4. **Neg-risk market signal design (Phase 5 input).** Neg-risk markets (e.g., "Which team wins Group A?") share a unified order book across outcomes. A BUY on one outcome is a synthetic SELL on all others. What pricing model should Phase 6 use — standard complementary probability normalization, or a full CTF (Conditional Token Framework) model?

5. **Alert webhook payload schema.** Phase 2 adds Discord/Slack webhook. Should the payload be a raw JSON blob (operator parses it in their webhook handler) or a pre-formatted Discord embed? Decision needed before 2.8 implementation.

---

## 15. Success Metrics

### Phase 1 (Data Foundation)

| Metric | Target |
|---|---|
| Time to first trade in DB | < 5 minutes from `pnpm start` |
| Trade ingestion completeness | > 99% of Live-Data WS events persisted (measured by WS event count vs DB row count) |
| Order book snapshot coverage | 100% of watchlisted tokens have a snapshot within 60s of startup |
| Neg-risk filter accuracy | 0 neg-risk tokens appear in `markets` with `watchlisted = true` |

### Phase 2 (Whale Detection)

| Metric | Target |
|---|---|
| Alert latency | < 1 second from trade event to console output |
| Dual-threshold false positive rate | < 5 alerts/hour on a normal trading day (to be tuned in Phase 5) |
| Wallet enrichment completion | > 90% of alerts enriched within 10 seconds |
| WS shard recovery time | < 30 seconds from disconnect to re-subscription |

### Phase 3 (Signal Engine)

| Metric | Target |
|---|---|
| Signal type coverage | All four `SignalType` values appear in `signals` table within 2 hours of a fresh start |
| Signal confidence distribution | Mean confidence > 0.4 across all types (guards against trivially fired signals) |

### Phase 5 (Backtesting)

| Metric | Target |
|---|---|
| `WHALE_TRADE` signal precision | > 55% (whale trade preceded a price move in the correct direction within 30 min) |
| `SENTIMENT_VELOCITY` precision | > 60% on markets with > $1M 24h volume |
| Backtest data coverage | > 90 days of price history for top 50 markets |

---

*Version 2.0 — Supersedes v1.0. Addresses all five MAJOR and both MINOR board findings. Ready for implementation by Zoro (backend), tests by Usopp.*
