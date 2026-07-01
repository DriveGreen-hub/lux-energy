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

const EM_BASE = "https://api.co2signal.com/v1";
const EM_ZONE = "LU";

async function fetchCarbonIntensity() {
  const res = await fetch(`${EM_BASE}/latest?countryCode=${EM_ZONE}`, {
    headers: { "auth-token": process.env.ELECTRICITYMAPS_API_KEY },
  });
  if (!res.ok) {
    throw new Error(`co2signal/latest -> HTTP ${res.status}`);
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
  // Confirmed live shape (2026-07-01): { unix_seconds, countries: [{name, data[]}] }
  // where values are in GW, not MW, and the API includes a "sum" series
  // alongside real neighbor names (e.g. "sum", "Belgium", "Germany") —
  // "sum" is the net aggregate, not a third country, and is excluded here.
  const data = await fetchJson(`/cbpf?country=${COUNTRY}`);
  let count = 0;

  for (const series of data.countries ?? []) {
    if (series.name.toLowerCase() === "sum") continue;

    for (let i = 0; i < data.unix_seconds.length; i++) {
      const valueGw = series.data[i];
      if (valueGw === null || valueGw === undefined) continue;
      const ts = toTimestamp(data.unix_seconds[i]);
      await client.query(
        `INSERT INTO cross_border_flows (ts, country, neighbor, flow_mw)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (ts, country, neighbor) DO UPDATE SET flow_mw = EXCLUDED.flow_mw`,
        [ts, COUNTRY, series.name, valueGw * 1000]
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

async function ingestCarbonIntensity(client) {
  // Home Assistant-tier tokens only work against the legacy co2signal.com
  // endpoint, not the newer api-access.electricitymaps.com path — confirmed
  // 2026-07-01. Response is nested under `data`:
  //   { countryCode, data: { carbonIntensity, datetime, fossilFuelPercentage }, status }
  const data = await fetchCarbonIntensity();
  if (data.status !== "ok" || !data.data || data.data.carbonIntensity === undefined) {
    throw new Error(`unexpected response shape: ${JSON.stringify(data)}`);
  }

  await client.query(
    `INSERT INTO carbon_intensity (ts, zone, intensity_gco2_kwh, is_estimated)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (ts, zone) DO UPDATE SET intensity_gco2_kwh = EXCLUDED.intensity_gco2_kwh`,
    [data.data.datetime, EM_ZONE, data.data.carbonIntensity, null]
  );
  return 1;
}

async function main() {
  const client = await pool.connect();
  const jobs = [
    ["prices", ingestPrices, true],
    ["generation", ingestGeneration, true],
    ["cross_border_flows", ingestCrossBorderFlows, true],
    ["installed_capacity", ingestInstalledCapacity, true],
    ["carbon_intensity", ingestCarbonIntensity, false], // best-effort: external free-tier API, can be flaky
  ];

  let hadCriticalFailure = false;

  for (const [name, fn, critical] of jobs) {
    try {
      const count = await fn(client);
      await logResult(client, name, "ok", `${count} rows`);
      console.log(`[ok] ${name}: ${count} rows`);
    } catch (err) {
      if (critical) hadCriticalFailure = true;
      await logResult(client, name, "error", err.message);
      console.error(`[${critical ? "error" : "warn"}] ${name}: ${err.message}`);
    }
  }

  client.release();
  await pool.end();

  // Only fail the Action for series that actually matter to the dashboard's
  // core function — a flaky best-effort API (carbon intensity) shouldn't
  // turn the whole pipeline red.
  if (hadCriticalFailure) process.exit(1);
}

main();
