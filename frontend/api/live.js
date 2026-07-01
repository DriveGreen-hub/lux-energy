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
    const [price, generation, flows] = await Promise.all([
      pool.query(
        `SELECT ts, price_eur_mwh FROM prices ORDER BY ts DESC LIMIT 1`
      ),
      pool.query(
        `SELECT DISTINCT ON (production_type) production_type, value_mw, ts
         FROM generation ORDER BY production_type, ts DESC`
      ),
      pool.query(
        `SELECT DISTINCT ON (neighbor) neighbor, flow_mw, ts
         FROM cross_border_flows ORDER BY neighbor, ts DESC`
      ),
    ]);

    res.status(200).json({
      price: price.rows[0] ?? null,
      generation: generation.rows,
      cross_border_flows: flows.rows,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
