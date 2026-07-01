-- Lux Energy Dashboard schema
-- One table per energy-charts.info series, all keyed on UTC timestamp.
-- Upserts on (series-specific key, ts) so the 15-min cron can safely re-run
-- and backfill without creating duplicates.

CREATE TABLE IF NOT EXISTS prices (
  ts          TIMESTAMPTZ NOT NULL,
  bidding_zone TEXT NOT NULL DEFAULT 'DE-LU',
  price_eur_mwh DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (ts, bidding_zone)
);

CREATE TABLE IF NOT EXISTS generation (
  ts             TIMESTAMPTZ NOT NULL,
  country        TEXT NOT NULL DEFAULT 'lu',
  production_type TEXT NOT NULL,   -- e.g. 'Solar', 'Cross border electricity trading'
  value_mw       DOUBLE PRECISION,
  PRIMARY KEY (ts, country, production_type)
);

CREATE TABLE IF NOT EXISTS cross_border_flows (
  ts          TIMESTAMPTZ NOT NULL,
  country     TEXT NOT NULL DEFAULT 'lu',
  neighbor    TEXT NOT NULL,       -- e.g. 'de', 'fr', 'be'
  flow_mw     DOUBLE PRECISION,    -- positive = export, negative = import
  PRIMARY KEY (ts, country, neighbor)
);

CREATE TABLE IF NOT EXISTS installed_capacity (
  year           INT NOT NULL,
  country        TEXT NOT NULL DEFAULT 'lu',
  production_type TEXT NOT NULL,
  capacity_mw    DOUBLE PRECISION,
  PRIMARY KEY (year, country, production_type)
);

-- Ingestion bookkeeping so the cron can log failures without silently
-- serving stale data through the API.
CREATE TABLE IF NOT EXISTS ingestion_log (
  id          SERIAL PRIMARY KEY,
  ran_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  series      TEXT NOT NULL,
  status      TEXT NOT NULL,       -- 'ok' | 'error'
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_prices_ts ON prices (ts DESC);
CREATE INDEX IF NOT EXISTS idx_generation_ts ON generation (ts DESC);
CREATE INDEX IF NOT EXISTS idx_flows_ts ON cross_border_flows (ts DESC);
