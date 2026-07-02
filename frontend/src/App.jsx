import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

// Point this at your deployed API. During local dev with `vite`, the
// proxy in vite.config.js forwards /api/* to a locally running API
// (e.g. `vercel dev`). In production this stays empty since the API
// lives on the same Vercel deployment as the frontend.
const API_BASE = import.meta.env.VITE_API_BASE || "";

const GEN_COLORS = {
  "Cross border electricity trading": "var(--blue)",
  Solar: "var(--amber)",
  "Wind onshore": "var(--teal)",
  "Hydro Run-of-River": "var(--teal)",
  "Hydro water reservoir": "var(--teal)",
  "Hydro pumped storage": "var(--teal)",
  Nuclear: "var(--text-dim)",
  Others: "var(--text-faint)",
};

function colorFor(name) {
  return GEN_COLORS[name] || "var(--text-faint)";
}

function fmt(n, digits = 1) {
  if (n === null || n === undefined) return "—";
  return Number(n).toFixed(digits);
}

function carbonColor(gco2) {
  if (gco2 === null || gco2 === undefined) return "var(--text-faint)";
  if (gco2 < 150) return "var(--teal)";
  if (gco2 < 300) return "var(--amber)";
  return "var(--red)";
}

// Interpolates teal (cheap) -> amber (mid) -> red (expensive) relative to
// today's own min/max, so the scale is always meaningful regardless of
// the absolute price level that day.
function priceColorScale(value, min, max) {
  if (max === min) return "var(--teal)";
  const t = (value - min) / (max - min);
  if (t < 0.5) {
    return mixColor("#35d6b5", "#f0a93a", t / 0.5);
  }
  return mixColor("#f0a93a", "#f2696b", (t - 0.5) / 0.5);
}

function mixColor(hexA, hexB, t) {
  const a = parseInt(hexA.slice(1), 16);
  const b = parseInt(hexB.slice(1), 16);
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

function relativeTime(iso) {
  if (!iso) return "never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

export default function App() {
  const [live, setLive] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        const liveRes = await fetch(`${API_BASE}/api/live`);
        if (!liveRes.ok) throw new Error(`live: HTTP ${liveRes.status}`);
        setLive(await liveRes.json());

        const to = new Date(Date.now() + 24 * 60 * 60 * 1000); // include tomorrow's published day-ahead prices
        const from = new Date(Date.now() - 48 * 60 * 60 * 1000);
        const histRes = await fetch(
          `${API_BASE}/api/history?series=price&from=${from.toISOString()}&to=${to.toISOString()}`
        );
        if (!histRes.ok) throw new Error(`history: HTTP ${histRes.status}`);
        const histData = await histRes.json();
        setHistory(
          histData.rows.map((r) => ({
            ts: r.ts,
            time: new Date(r.ts).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
            }),
            price: r.value,
          }))
        );
        setError(null);
      } catch (err) {
        setError(err.message);
      }
    }

    load();
    const interval = setInterval(load, 5 * 60 * 1000); // refresh every 5 min
    return () => clearInterval(interval);
  }, []);

  const price = live?.price?.price_eur_mwh;
  const priceEurCentKwh = price !== undefined && price !== null ? price / 10 : null;
  const isNegative = price !== undefined && price !== null && price < 0;

  const generation = (live?.generation ?? [])
    .filter((g) => g.production_type !== "Load" && g.production_type !== "Residual load")
    .filter((g) => !g.production_type.startsWith("Renewable share"))
    .sort((a, b) => Math.abs(b.value_mw) - Math.abs(a.value_mw));

  const maxGenValue = Math.max(...generation.map((g) => Math.abs(g.value_mw)), 1);

  const flows = live?.cross_border_flows ?? [];

  const hourlyToday = useMemo(() => {
    const now = new Date();
    const todayKey = now.toDateString();
    const buckets = {};
    for (const row of history) {
      const d = new Date(row.ts);
      if (d.toDateString() !== todayKey) continue;
      const hour = d.getHours();
      if (!buckets[hour]) buckets[hour] = { sum: 0, count: 0 };
      buckets[hour].sum += row.price;
      buckets[hour].count += 1;
    }
    const currentHour = now.getHours();
    return Object.entries(buckets)
      .map(([hour, { sum, count }]) => ({
        hour: Number(hour),
        label: String(hour).padStart(2, "0"),
        price: sum / count,
        isNow: Number(hour) === currentHour,
      }))
      .sort((a, b) => a.hour - b.hour);
  }, [history]);

  const hourlyPrices = hourlyToday.map((h) => h.price);
  const hourlyMin = hourlyPrices.length ? Math.min(...hourlyPrices) : 0;
  const hourlyMax = hourlyPrices.length ? Math.max(...hourlyPrices) : 0;

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="brand-title">Lux Energy</div>
          <div className="brand-sub">Luxembourg grid — live generation, flows &amp; spot price</div>
        </div>
        <div className="ticker">
          <span className="ticker-dot" />
          <span className={`ticker-value ${isNegative ? "negative" : ""}`}>
            {priceEurCentKwh !== null ? fmt(priceEurCentKwh, 2) : "—"}
          </span>
          <span className="ticker-unit">ct/kWh · DE-LU day-ahead</span>
        </div>
        {live?.carbon_intensity && (
          <div className="ticker">
            <span
              className="ticker-dot"
              style={{ background: carbonColor(live.carbon_intensity.intensity_gco2_kwh) }}
            />
            <span
              className="ticker-value"
              style={{ color: carbonColor(live.carbon_intensity.intensity_gco2_kwh) }}
            >
              {fmt(live.carbon_intensity.intensity_gco2_kwh, 0)}
            </span>
            <span className="ticker-unit">
              gCO₂/kWh{live.carbon_intensity.is_estimated ? " · est." : ""}
            </span>
          </div>
        )}
      </header>

      <div className="grid">
        <section className="card card-wide">
          <div className="card-label">Spot price trend</div>
          {history.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={history}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis
                  dataKey="time"
                  stroke="var(--text-faint)"
                  tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }}
                  interval={Math.floor(history.length / 6)}
                />
                <YAxis
                  stroke="var(--text-faint)"
                  tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }}
                  width={50}
                  label={{
                    value: "EUR/MWh",
                    angle: -90,
                    position: "insideLeft",
                    fill: "var(--text-faint)",
                    fontSize: 11,
                  }}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--panel-raised)",
                    border: "1px solid var(--line)",
                    borderRadius: 8,
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "var(--text-dim)" }}
                />
                <Line
                  type="monotone"
                  dataKey="price"
                  stroke="var(--amber)"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-state">No price history yet — check back once ingestion has run a few times.</div>
          )}
        </section>

        <section className="card card-full">
          <div className="card-label">Price by hour — today</div>
          {hourlyToday.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={hourlyToday}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis
                  dataKey="label"
                  stroke="var(--text-faint)"
                  tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }}
                />
                <YAxis
                  stroke="var(--text-faint)"
                  tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }}
                  width={50}
                  label={{
                    value: "ct/kWh",
                    angle: -90,
                    position: "insideLeft",
                    fill: "var(--text-faint)",
                    fontSize: 11,
                  }}
                  tickFormatter={(v) => fmt(v / 10, 1)}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--panel-raised)",
                    border: "1px solid var(--line)",
                    borderRadius: 8,
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "var(--text-dim)" }}
                  formatter={(value) => [`${fmt(value / 10, 2)} ct/kWh`, "price"]}
                  labelFormatter={(label) => `${label}:00`}
                />
                <Bar dataKey="price" radius={[4, 4, 0, 0]}>
                  {hourlyToday.map((h) => (
                    <Cell
                      key={h.hour}
                      fill={priceColorScale(h.price, hourlyMin, hourlyMax)}
                      stroke={h.isNow ? "var(--text)" : "none"}
                      strokeWidth={h.isNow ? 2 : 0}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-state">No hourly data for today yet.</div>
          )}
        </section>

        <section className="card card-narrow">
          <div className="card-label">Cross-border flow</div>
          {flows.length > 0 ? (
            flows.map((f) => (
              <div className="flow-row" key={f.neighbor}>
                <span className="flow-name">{f.neighbor}</span>
                <span className={`flow-value ${f.flow_mw >= 0 ? "export" : "import"}`}>
                  {f.flow_mw >= 0 ? "→ " : "← "}
                  {fmt(Math.abs(f.flow_mw), 0)} MW
                </span>
              </div>
            ))
          ) : (
            <div className="empty-state">No flow data yet.</div>
          )}
        </section>

        <section className="card card-full">
          <div className="card-label">Generation &amp; trading mix</div>
          {generation.length > 0 ? (
            generation.map((g) => (
              <div className="gen-row" key={g.production_type}>
                <div className="gen-row-head">
                  <span className="gen-row-name">{g.production_type}</span>
                  <span className="gen-row-value">{fmt(g.value_mw, 0)} MW</span>
                </div>
                <div className="gen-bar-track">
                  <div
                    className="gen-bar-fill"
                    style={{
                      width: `${(Math.abs(g.value_mw) / maxGenValue) * 100}%`,
                      background: colorFor(g.production_type),
                    }}
                  />
                </div>
              </div>
            ))
          ) : (
            <div className="empty-state">No generation data yet.</div>
          )}
        </section>
      </div>

      <div className="status-bar">
        <span>Source: energy-charts.info (Fraunhofer ISE), CC BY 4.0</span>
        <span className={error ? "status-error" : ""}>
          {error ? `Fetch error: ${error}` : `Updated ${relativeTime(live?.generated_at)}`}
        </span>
      </div>
    </div>
  );
}
