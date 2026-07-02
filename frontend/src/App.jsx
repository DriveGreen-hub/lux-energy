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

const RENEWABLE_TYPES = new Set([
  "Solar",
  "Wind onshore",
  "Wind offshore",
  "Hydro Run-of-River",
  "Hydro water reservoir",
  "Hydro pumped storage",
  "Biomass",
]);

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
  const [genHistory, setGenHistory] = useState([]);
  const [dailyPriceRows, setDailyPriceRows] = useState([]);
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

        // Generation history: 48h back, used for both today's import/domestic
        // summary (filtered client-side to just today) and the demand trend chart.
        const genFrom = new Date(Date.now() - 48 * 60 * 60 * 1000);
        const genRes = await fetch(
          `${API_BASE}/api/history?series=generation&from=${genFrom.toISOString()}&to=${new Date().toISOString()}`
        );
        if (!genRes.ok) throw new Error(`generation history: HTTP ${genRes.status}`);
        const genData = await genRes.json();
        setGenHistory(genData.rows);

        // Multi-day price trend: as far back as we have history, plus
        // tomorrow once published. Day-ahead prices don't exist further
        // than 1 day out — this isn't a forecast, just the actual window
        // the market publishes.
        const dailyFrom = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
        const dailyRes = await fetch(
          `${API_BASE}/api/history?series=price&from=${dailyFrom.toISOString()}&to=${to.toISOString()}`
        );
        if (!dailyRes.ok) throw new Error(`daily price history: HTTP ${dailyRes.status}`);
        const dailyData = await dailyRes.json();
        setDailyPriceRows(dailyData.rows);

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
  const priceEurKwh = price !== undefined && price !== null ? price / 1000 : null;
  const isNegative = price !== undefined && price !== null && price < 0;

  const generation = (live?.generation ?? [])
    .filter((g) => g.production_type !== "Load" && g.production_type !== "Residual load")
    .filter((g) => !g.production_type.startsWith("Renewable share"))
    .sort((a, b) => Math.abs(b.value_mw) - Math.abs(a.value_mw));

  const maxGenValue = Math.max(...generation.map((g) => Math.abs(g.value_mw)), 1);

  const flows = live?.cross_border_flows ?? [];

  // Daily import vs domestic production, integrated from 15-min generation
  // samples (energy_mwh ≈ power_mw × 0.25h per sample — approximate, since
  // it assumes uniform sampling rather than true interval integration).
  const dailySummary = useMemo(() => {
    const todayKey = new Date().toDateString();
    let importedMwh = 0;
    let domesticMwh = 0;
    let renewableMwh = 0;
    for (const row of genHistory) {
      if (new Date(row.ts).toDateString() !== todayKey) continue;
      const energyMwh = (row.value ?? 0) * 0.25;
      if (row.production_type === "Cross border electricity trading") {
        importedMwh += Math.max(energyMwh, 0); // only count net-import hours, not export hours
      } else if (
        row.production_type !== "Load" &&
        row.production_type !== "Residual load" &&
        !row.production_type?.startsWith("Renewable share")
      ) {
        domesticMwh += Math.max(energyMwh, 0);
        if (RENEWABLE_TYPES.has(row.production_type)) {
          renewableMwh += Math.max(energyMwh, 0);
        }
      }
    }
    const total = importedMwh + domesticMwh;
    return {
      importedMwh,
      domesticMwh,
      renewableMwh,
      importPct: total > 0 ? (importedMwh / total) * 100 : 0,
      domesticPct: total > 0 ? (domesticMwh / total) * 100 : 0,
      domesticRenewablePct: domesticMwh > 0 ? (renewableMwh / domesticMwh) * 100 : 0,
    };
  }, [genHistory]);

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

  // All remaining hours from now onward (rest of today + tomorrow, once
  // published ~13:00 CET) — this is what actually matters for deciding
  // when to charge, unlike hourlyToday which includes hours already past.
  const upcomingHourly = useMemo(() => {
    const now = new Date();
    const buckets = {};
    for (const row of history) {
      const d = new Date(row.ts);
      if (d < now) continue;
      const hourStart = new Date(d);
      hourStart.setMinutes(0, 0, 0);
      const key = hourStart.toISOString();
      if (!buckets[key]) buckets[key] = { sum: 0, count: 0, hourStart };
      buckets[key].sum += row.price;
      buckets[key].count += 1;
    }
    return Object.values(buckets)
      .map(({ sum, count, hourStart }) => ({
        hourStart,
        price: sum / count,
        label: hourStart.toLocaleDateString("en-GB", { weekday: "short" }) +
          " " + String(hourStart.getHours()).padStart(2, "0") + ":00",
      }))
      .sort((a, b) => a.hourStart - b.hourStart);
  }, [history]);

  const cheapestHours = useMemo(() => {
    return [...upcomingHourly].sort((a, b) => a.price - b.price).slice(0, 3);
  }, [upcomingHourly]);

  // Power demand (Load) trend — same 48h window as genHistory, just one
  // production_type pulled out and reshaped for a line chart.
  const demandHistory = useMemo(() => {
    return genHistory
      .filter((row) => row.production_type === "Load")
      .sort((a, b) => new Date(a.ts) - new Date(b.ts))
      .map((row) => ({
        time: new Date(row.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
        demand: row.value,
      }));
  }, [genHistory]);

  // Daily average price, past ~9 days through tomorrow. Chronological order
  // naturally puts today in the middle once enough history has accumulated —
  // right after deploy this will be mostly empty going backward and fill in
  // day by day as the ingestion cron keeps running.
  const dailyPriceTrend = useMemo(() => {
    const todayKey = new Date().toDateString();
    const buckets = {};
    for (const row of dailyPriceRows) {
      const d = new Date(row.ts);
      const dayKey = d.toDateString();
      if (!buckets[dayKey]) buckets[dayKey] = { sum: 0, count: 0, date: new Date(d.setHours(0, 0, 0, 0)) };
      buckets[dayKey].sum += row.value;
      buckets[dayKey].count += 1;
    }
    return Object.entries(buckets)
      .map(([dayKey, { sum, count, date }]) => ({
        label: date.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "2-digit" }),
        price: sum / count,
        isToday: dayKey === todayKey,
        date,
      }))
      .sort((a, b) => a.date - b.date);
  }, [dailyPriceRows]);

  const dailyTrendPrices = dailyPriceTrend.map((d) => d.price);
  const dailyTrendMin = dailyTrendPrices.length ? Math.min(...dailyTrendPrices) : 0;
  const dailyTrendMax = dailyTrendPrices.length ? Math.max(...dailyTrendPrices) : 0;

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
            {priceEurKwh !== null ? `${fmt(priceEurKwh, 3)}€` : "—"}
          </span>
          <span className="ticker-unit">/kWh · DE-LU day-ahead, current</span>
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
                  itemStyle={{ color: "var(--text)" }}
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
                    value: "€/kWh",
                    angle: -90,
                    position: "insideLeft",
                    fill: "var(--text-faint)",
                    fontSize: 11,
                  }}
                  tickFormatter={(v) => fmt(v / 1000, 2)}
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
                  itemStyle={{ color: "var(--text)" }}
                  formatter={(value) => [`${fmt(value / 1000, 3)}€/kWh`, "price"]}
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

        <section className="card card-full">
          <div className="card-label">Daily average price — past days, today &amp; tomorrow</div>
          {dailyPriceTrend.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={dailyPriceTrend}>
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
                      value: "€/kWh",
                      angle: -90,
                      position: "insideLeft",
                      fill: "var(--text-faint)",
                      fontSize: 11,
                    }}
                    tickFormatter={(v) => fmt(v / 1000, 2)}
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
                    itemStyle={{ color: "var(--text)" }}
                    formatter={(value) => [`${fmt(value / 1000, 3)}€/kWh`, "avg price"]}
                  />
                  <Bar dataKey="price" radius={[4, 4, 0, 0]}>
                    {dailyPriceTrend.map((d) => (
                      <Cell
                        key={d.label}
                        fill={priceColorScale(d.price, dailyTrendMin, dailyTrendMax)}
                        stroke={d.isToday ? "var(--text)" : "none"}
                        strokeWidth={d.isToday ? 2 : 0}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div className="daily-summary-footnote">
                Day-ahead prices only exist one day out — "tomorrow" is the latest this can show, not a forecast further ahead. Past days fill in as history accumulates.
              </div>
            </>
          ) : (
            <div className="empty-state">No daily price data yet.</div>
          )}
        </section>

        <section className="card card-half">
          <div className="card-label">Best hours to charge</div>
          {cheapestHours.length > 0 ? (
            cheapestHours.map((h, i) => (
              <div className="flow-row" key={h.hourStart.toISOString()}>
                <span className="flow-name">
                  {i === 0 ? "★ " : ""}
                  {h.label}
                </span>
                <span className="flow-value" style={{ color: "var(--teal)" }}>
                  {fmt(h.price / 1000, 3)}€/kWh
                </span>
              </div>
            ))
          ) : (
            <div className="empty-state">No upcoming price data yet.</div>
          )}
        </section>

        <section className="card card-half">
          <div className="card-label">Cross-border flow</div>
          {flows.length > 0 ? (
            flows.map((f) => (
              <div className="flow-row" key={f.neighbor}>
                <span className="flow-name">{f.neighbor}</span>
                {/* Positive flow_mw = flow INTO Luxembourg (import). Confirmed against
                    the raw energy-charts.info cbpf response: LU's imports from Belgium
                    + Germany sum closely to the aggregate "Cross border electricity
                    trading" import figure from public_power, which is only consistent
                    if positive = import here. */}
                <span className={`flow-value ${f.flow_mw >= 0 ? "import" : "export"}`}>
                  {f.flow_mw >= 0 ? "← " : "→ "}
                  {fmt(Math.abs(f.flow_mw), 0)} MW
                </span>
              </div>
            ))
          ) : (
            <div className="empty-state">No flow data yet.</div>
          )}
        </section>

        <section className="card card-full">
          <div className="card-label">Today so far — imported vs. produced</div>
          {dailySummary.importedMwh + dailySummary.domesticMwh > 0 ? (
            <>
              <div className="daily-summary-row">
                <div className="daily-summary-stat">
                  <div className="daily-summary-value" style={{ color: "var(--blue)" }}>
                    {fmt(dailySummary.importedMwh, 0)} MWh
                  </div>
                  <div className="daily-summary-label">Imported from abroad</div>
                </div>
                <div className="daily-summary-stat">
                  <div className="daily-summary-value" style={{ color: "var(--amber)" }}>
                    {fmt(dailySummary.domesticMwh, 0)} MWh
                  </div>
                  <div className="daily-summary-label">Produced in Luxembourg</div>
                </div>
                <div className="daily-summary-stat">
                  <div className="daily-summary-value" style={{ color: "var(--teal)" }}>
                    {fmt(dailySummary.domesticRenewablePct, 0)}%
                  </div>
                  <div className="daily-summary-label">Renewable share of domestic output</div>
                </div>
              </div>
              <div className="daily-summary-bar">
                <div
                  className="daily-summary-bar-segment"
                  style={{ width: `${dailySummary.importPct}%`, background: "var(--blue)" }}
                />
                <div
                  className="daily-summary-bar-segment"
                  style={{ width: `${dailySummary.domesticPct}%`, background: "var(--amber)" }}
                />
              </div>
              <div className="daily-summary-footnote">
                {fmt(dailySummary.importPct, 0)}% imported · {fmt(dailySummary.domesticPct, 0)}% domestic — approximate, integrated from 15-min samples since midnight local time. Renewable share reflects domestic generation only, not the mix of what's imported.
              </div>
            </>
          ) : (
            <div className="empty-state">No generation data for today yet.</div>
          )}
        </section>

        <section className="card card-full">
          <div className="card-label">Power demand — last 48h</div>
          {demandHistory.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={demandHistory}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis
                  dataKey="time"
                  stroke="var(--text-faint)"
                  tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }}
                  interval={Math.floor(demandHistory.length / 6)}
                />
                <YAxis
                  stroke="var(--text-faint)"
                  tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }}
                  width={50}
                  label={{
                    value: "MW",
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
                  itemStyle={{ color: "var(--text)" }}
                  formatter={(value) => [`${fmt(value, 0)} MW`, "demand"]}
                />
                <Line type="monotone" dataKey="demand" stroke="var(--blue)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-state">No demand data yet.</div>
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
