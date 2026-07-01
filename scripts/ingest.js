// scripts/ingest.js
//
// Pulls the four energy-charts.info series for Luxembourg and upserts
// into Postgres. Designed to run every 15 minutes via GitHub Actions.
// Safe to re-run: everything is an upsert keyed on timestamp.
//
// Required env: DATABASE_URL (Postgres connection string, e.g. Neon/Supabase)

import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const BASE = "https://api.energy-charts.info";
const COUNTRY = "lu";
const BIDDING_ZONE = "DE-LU"; // Luxembourg shares Germany's price zone

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "User-Agent": "lux-energy-dashboard (personal project)" },
  });
  if (!res.ok) {
    throw new Error(`${path} -> HTTP ${res.status}`);
  }
  return res.json();
}

function toTimestamp(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString();
}

async function logResult(client, series, status, detail = null) {
  await client.query(
    `INSERT INTO ingestion_log (series, status, detail) VALUES ($1, $2, $3)`,
    [series, status, detail]
  );
}

async function ingestPrices(client) {
  const data = await fetchJson(`/price?bzn=${BIDDING_ZONE}`);
  const rows = data.unix_seconds.map((s, i) => [
    toTimestamp(s),
    BIDDING_ZONE,
    data.price[i],
  ]);

  for (const [ts, zone, price] of rows) {
    if (price === null || price === undefined) continue;
    await client.query(
      `INSERT INTO prices (ts, bidding_zone, price_eur_mwh)
       VALUES ($1, $2, $3)
       ON CONFLICT (ts, bidding_zone) DO UPDATE SET price_eur_mwh = EXCLUDED.price_eur_mwh`,
      [ts, zone, price]
    );
  }
  return rows.length;
}

async function ingestGeneration(client) {
  const data = await fetchJson(`/public_power?country=${COUNTRY}`);
  let count = 0;

  for (const series of data.production_types) {
    for (let i = 0; i < data.unix_seconds.length; i++) {
      const value = series.data[i];
      if (value === null || value === undefined) continue;
      const ts = toTimestamp(data.unix_seconds[i]);
      await client.query(
        `INSERT INTO generation (ts, country, production_type, value_mw)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (ts, country, production_type) DO UPDATE SET value_mw = EXCLUDED.value_mw`,
        [ts, COUNTRY, series.name, value]
      );
      count++;
    }
  }
  return count;
}

async function ingestCrossBorderFlows(client) {
  // NOTE: verify exact endpoint name/shape against api.energy-charts.info
  // before relying on this in production — cross-border flow endpoints
  // have changed shape before. This assumes a `countries` array of
  // { name, data[] } aligned to unix_seconds, mirroring public_power.
  const data = await fetchJson(`/cbpf?country=${COUNTRY}`);
  let count = 0;

  for (const series of data.countries ?? []) {
    for (let i = 0; i < data.unix_seconds.length; i++) {
      const value = series.data[i];
      if (value === null || value === undefined) continue;
      const ts = toTimestamp(data.unix_seconds[i]);
      await client.query(
        `INSERT INTO cross_border_flows (ts, country, neighbor, flow_mw)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (ts, country, neighbor) DO UPDATE SET flow_mw = EXCLUDED.flow_mw`,
        [ts, COUNTRY, series.name, value]
      );
      count++;
    }
  }
  return count;
}

async function ingestInstalledCapacity(client) {
  // Installed capacity changes rarely — fine to just upsert current year.
  const year = new Date().getFullYear();
  const data = await fetchJson(`/installed_power?country=${COUNTRY}&time_step=yearly`);
  let count = 0;

  for (const series of data.production_types ?? []) {
    const latest = series.data?.[series.data.length - 1];
    if (latest === null || latest === undefined) continue;
    await client.query(
      `INSERT INTO installed_capacity (year, country, production_type, capacity_mw)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (year, country, production_type) DO UPDATE SET capacity_mw = EXCLUDED.capacity_mw`,
      [year, COUNTRY, series.name, latest]
    );
    count++;
  }
  return count;
}

async function main() {
  const client = await pool.connect();
  const jobs = [
    ["prices", ingestPrices],
    ["generation", ingestGeneration],
    ["cross_border_flows", ingestCrossBorderFlows],
    ["installed_capacity", ingestInstalledCapacity],
  ];

  let hadFailure = false;

  for (const [name, fn] of jobs) {
    try {
      const count = await fn(client);
      await logResult(client, name, "ok", `${count} rows`);
      console.log(`[ok] ${name}: ${count} rows`);
    } catch (err) {
      hadFailure = true;
      await logResult(client, name, "error", err.message);
      console.error(`[error] ${name}: ${err.message}`);
    }
  }

  client.release();
  await pool.end();

  // Non-zero exit fails the GitHub Actions run visibly rather than
  // silently serving stale data through the API.
  if (hadFailure) process.exit(1);
}

main();
