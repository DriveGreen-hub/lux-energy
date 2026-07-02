// api/live.js
// Latest snapshot of price + generation mix + cross-border flows.
// Cache for 5 min at the edge — this data doesn't change fast enough
// to justify hitting Postgres on every page load.

import pg from "pg";
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");

  try {
    const [price, generation, flows, carbon] = await Promise.all([
      pool.query(
        // Prices table holds past, today's, and (once published ~13:00 CET)
        // tomorrow's day-ahead rows all at once. "Current price" must mean
        // the latest row at-or-before now — without the ts <= now() bound,
        // ORDER BY ts DESC just grabs whichever row has the furthest-future
        // timestamp, which after 13:00 CET is tomorrow's last hour, not now.
        `SELECT ts, price_eur_mwh FROM prices WHERE ts <= now() ORDER BY ts DESC LIMIT 1`
      ),
      pool.query(
        `SELECT DISTINCT ON (production_type) production_type, value_mw, ts
         FROM generation ORDER BY production_type, ts DESC`
      ),
      pool.query(
        `SELECT DISTINCT ON (neighbor) neighbor, flow_mw, ts
         FROM cross_border_flows ORDER BY neighbor, ts DESC`
      ),
      pool.query(
        `SELECT ts, intensity_gco2_kwh, is_estimated
         FROM carbon_intensity ORDER BY ts DESC LIMIT 1`
      ),
    ]);

    res.status(200).json({
      price: price.rows[0] ?? null,
      generation: generation.rows,
      cross_border_flows: flows.rows,
      carbon_intensity: carbon.rows[0] ?? null,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
