# Trademaxxing

AI-assisted **paper-trading** platform for forex/commodities, starting with
**XAU/USD**. This repository is the **foundation phase**: the database schema,
the shared type vocabulary, and the swappable provider interfaces that later
parallel agents build on. No trading logic yet (no indicators, setup detection,
risk rules, dashboard, or LLM prompts).

## Stack & key decisions

- **Next.js** (TypeScript, App Router, Tailwind)
- **Prisma** ORM
- **SQLite** for local dev — chosen so contributors and downstream agents can
  clone, install, migrate, and run with **zero database setup**. The schema is
  kept **Postgres-compatible** (no native enums, no scalar lists, `Json` for
  arrays/objects, `Float` for prices), so switching is a one-line datasource
  change + re-migrate. Concretely: no native enums (String columns validated by
  the shared TS union types), no scalar lists / `Json` columns (Prisma's SQLite
  connector supports neither — JSON is stored in `String` columns as serialized
  JSON), and `Float` for prices. See the header comment in
  `prisma/schema.prisma`.

## Layout

```
prisma/schema.prisma              # 13 models; SQLite, Postgres-compatible
src/lib/types/                    # shared vocabulary (Candle, Setup, Signal, …)
src/lib/db.ts                     # Prisma client singleton
src/lib/providers/
  market-data/{provider,twelve-data}.ts
  llm/{provider,anthropic}.ts
  notifications/{provider,console}.ts
scripts/seed.ts                   # mock XAU/USD candles (multi-timeframe)
scripts/pull-real-candles.ts      # real Twelve Data fetch -> DB
src/app/                          # minimal Next.js shell
```

### Provider interfaces (the swap-later contract)

Each interface has exactly one concrete implementation today. Consumers depend
on the interface, not the implementation.

- **`MarketDataProvider`** — `getCandles(symbol, timeframe, from, to)`,
  `getLatestPrice(symbol)`. Impl: **`TwelveDataProvider`** (reads
  `TWELVE_DATA_API_KEY`, normalizes responses into our `Candle` type, and
  rate-limits to the free tier's ~8 req/min with retry on 429).
- **`LLMProvider`** — `complete(request)`. Impl: **`AnthropicProvider`** (reads
  `ANTHROPIC_API_KEY`; defaults to the latest Haiku, overridable per request).
- **`NotificationProvider`** — `send(message)`. Impl:
  **`ConsoleNotificationProvider`** (logs; Telegram comes later).

Import from the barrels: `@/lib/types` and `@/lib/providers`.

## Getting started

### 1. Install

```bash
npm install
```

### 2. Configure env

```bash
cp .env.example .env.local
```

Then edit `.env.local` and fill in real keys (these stay out of git):

- `TWELVE_DATA_API_KEY` — https://twelvedata.com/ (free tier works)
- `ANTHROPIC_API_KEY` — https://console.anthropic.com/

`DATABASE_URL` already defaults to SQLite (`file:./dev.db`) in the committed
`.env`; you only need to set it in `.env.local` to override.

> Secrets live in `.env.local`, which is gitignored. Never commit real keys.

### 3. Migrate (creates the SQLite DB + schema)

```bash
npm run db:migrate
```

This generates the Prisma client and applies the initial migration. (Prisma is
configured to run the seed automatically after `migrate dev`.)

### 4. Seed mock data

```bash
npm run seed
```

Creates a demo user, the XAU/USD instrument, and realistic mock candles across
`1min / 5min / 15min / 1h / 4h / 1day`. Idempotent — safe to re-run.

### 5. (Optional) Pull real candles — proves the Twelve Data integration

```bash
npm run pull:candles
# options: npm run pull:candles -- --timeframe=1h --days=10
```

Requires `TWELVE_DATA_API_KEY`. Fetches recent XAU/USD candles via
`TwelveDataProvider` and upserts them (tagged `source: "twelve_data"`).

### 6. Run the app

```bash
npm run dev      # http://localhost:3000
```

## Useful scripts

| Command               | What it does                                  |
| --------------------- | --------------------------------------------- |
| `npm run dev`         | Next.js dev server                            |
| `npm run build`       | Production build                              |
| `npm run typecheck`   | `tsc --noEmit`                                |
| `npm run db:migrate`  | Apply migrations (dev) + regenerate client    |
| `npm run db:studio`   | Prisma Studio (browse the DB)                 |
| `npm run seed`        | Seed mock data                                |
| `npm run pull:candles`| Fetch real candles from Twelve Data           |

## Switching to Postgres later

1. In `prisma/schema.prisma`, change `provider = "sqlite"` to
   `provider = "postgresql"`.
2. Set `DATABASE_URL` to a `postgresql://…` connection string.
3. `npm run db:migrate`.

The schema avoids SQLite/Postgres divergences, so nothing else changes. (For
real-money trading later, also consider switching price columns from `Float` to
`Decimal`.)

## Out of scope for this phase

Indicators, setup detection, risk rules, the dashboard, and LLM prompts —
those are the next agents. The relevant tables/fields exist as scaffolding
(e.g. `Feature.payload`, `Signal.setup` as serialized-JSON `String` columns).
