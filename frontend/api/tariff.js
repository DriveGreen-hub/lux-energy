// api/tariff.js
// Serves DE-LU day-ahead prices in the exact shape evcc's custom tariff
// plugin expects:
//   { "rates": [{ "start": "...", "end": "...", "value": <EUR/kWh> }, ...] }
//
// Point evcc at this instead of energy-charts.info directly — evcc polls
// hourly, and routing it through your own cached endpoint means a flaky
// Pi connection or an energy-charts.info hiccup doesn't break charging
// automation. Configure in evcc.yaml:
//
//   tariffs:
//     currency: EUR
//     grid:
//       type: custom
//       forecast:
//         source: http
//         uri: https://your-app.vercel.app/api/tariff

import pg from "pg";
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=300");

  try {
    // Serve from now through the furthest available day-ahead data.
    const { rows } = await pool.query(
      `SELECT ts, price_eur_mwh FROM prices
       WHERE ts >= now() - interval '1 hour'
       ORDER BY ts ASC`
    );

    const rates = rows.map((row, i) => {
      const start = new Date(row.ts);
      const end = new Date(start.getTime() + 15 * 60 * 1000); // 15-min slots
      return {
        start: start.toISOString(),
        end: end.toISOString(),
        value: row.price_eur_mwh / 1000, // EUR/MWh -> EUR/kWh
      };
    });

    res.status(200).json({ rates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
