-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "instruments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "basePrecision" INTEGER NOT NULL DEFAULT 2,
    "quotePrecision" INTEGER NOT NULL DEFAULT 2,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "candles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "openTime" DATETIME NOT NULL,
    "open" REAL NOT NULL,
    "high" REAL NOT NULL,
    "low" REAL NOT NULL,
    "close" REAL NOT NULL,
    "volume" REAL NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "features" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "openTime" DATETIME NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "signals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "setup" TEXT NOT NULL,
    "confidence" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "signal_reviews" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "signalId" TEXT NOT NULL,
    "reviewer" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "rationale" TEXT,
    "raw" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "signal_reviews_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "signals" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "paper_trades" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "entry" REAL NOT NULL,
    "stopLoss" REAL NOT NULL,
    "target" REAL NOT NULL,
    "size" REAL NOT NULL DEFAULT 0,
    "riskReward" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "exitPrice" REAL,
    "pnl" REAL,
    "signalId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "paper_trades_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "paper_trades_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "signals" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "trade_screenshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tradeId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "caption" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trade_screenshots_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "paper_trades" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "trade_notes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tradeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trade_notes_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "paper_trades" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "trade_notes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "daily_reviews" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "summary" TEXT,
    "stats" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "daily_reviews_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "risk_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tradeId" TEXT,
    "type" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reasons" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "news_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT,
    "title" TEXT NOT NULL,
    "impact" TEXT NOT NULL DEFAULT 'LOW',
    "eventTime" DATETIME NOT NULL,
    "source" TEXT,
    "raw" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'console',
    "level" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "instruments_symbol_key" ON "instruments"("symbol");

-- CreateIndex
CREATE INDEX "candles_symbol_timeframe_openTime_idx" ON "candles"("symbol", "timeframe", "openTime");

-- CreateIndex
CREATE UNIQUE INDEX "candles_symbol_timeframe_openTime_key" ON "candles"("symbol", "timeframe", "openTime");

-- CreateIndex
CREATE INDEX "features_symbol_timeframe_openTime_idx" ON "features"("symbol", "timeframe", "openTime");

-- CreateIndex
CREATE UNIQUE INDEX "features_symbol_timeframe_openTime_key" ON "features"("symbol", "timeframe", "openTime");

-- CreateIndex
CREATE INDEX "signals_symbol_timeframe_createdAt_idx" ON "signals"("symbol", "timeframe", "createdAt");

-- CreateIndex
CREATE INDEX "signal_reviews_signalId_idx" ON "signal_reviews"("signalId");

-- CreateIndex
CREATE INDEX "paper_trades_userId_status_idx" ON "paper_trades"("userId", "status");

-- CreateIndex
CREATE INDEX "paper_trades_symbol_idx" ON "paper_trades"("symbol");

-- CreateIndex
CREATE INDEX "trade_screenshots_tradeId_idx" ON "trade_screenshots"("tradeId");

-- CreateIndex
CREATE INDEX "trade_notes_tradeId_idx" ON "trade_notes"("tradeId");

-- CreateIndex
CREATE INDEX "daily_reviews_userId_date_idx" ON "daily_reviews"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_reviews_userId_date_key" ON "daily_reviews"("userId", "date");

-- CreateIndex
CREATE INDEX "risk_events_tradeId_idx" ON "risk_events"("tradeId");

-- CreateIndex
CREATE INDEX "risk_events_createdAt_idx" ON "risk_events"("createdAt");

-- CreateIndex
CREATE INDEX "news_events_symbol_eventTime_idx" ON "news_events"("symbol", "eventTime");

-- CreateIndex
CREATE INDEX "news_events_eventTime_idx" ON "news_events"("eventTime");

-- CreateIndex
CREATE INDEX "notifications_userId_idx" ON "notifications"("userId");

-- CreateIndex
CREATE INDEX "notifications_status_idx" ON "notifications"("status");
