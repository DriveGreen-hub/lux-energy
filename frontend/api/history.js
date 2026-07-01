// api/history.js
// Time-range query for charting. Example:
//   /api/history?series=price&from=2026-06-01&to=2026-07-01
//   /api/history?series=generation&from=2026-06-25T00:00Z&to=2026-06-26T00:00Z

import pg from "pg";
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const TABLES = {
  price: { table: "prices", value: "price_eur_mwh", extraCols: "bidding_zone" },
  generation: { table: "generation", value: "value_mw", extraCols: "production_type" },
  flows: { table: "cross_border_flows", value: "flow_mw", extraCols: "neighbor" },
};

export default async function handler(req, res) {
  const { series, from, to } = req.query;
  const cfg = TABLES[series];

  if (!cfg) {
    return res.status(400).json({ error: `series must be one of: ${Object.keys(TABLES).join(", ")}` });
  }
  if (!from || !to) {
    return res.status(400).json({ error: "from and to query params are required (ISO date/datetime)" });
  }

  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=300");

  try {
    const { rows } = await pool.query(
      `SELECT ts, ${cfg.extraCols}, ${cfg.value} AS value
       FROM ${cfg.table}
       WHERE ts BETWEEN $1 AND $2
       ORDER BY ts ASC`,
      [from, to]
    );
    res.status(200).json({ series, from, to, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
