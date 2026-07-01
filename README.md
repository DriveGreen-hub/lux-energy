# Lux Energy Dashboard — scaffold

Real-time-ish Luxembourg electricity dashboard: generation mix, cross-border
flows, installed capacity, and DE-LU day-ahead spot prices. Also feeds evcc's
custom tariff plugin so pricing data can drive wallbox charging decisions.

## Data source

[energy-charts.info](https://api.energy-charts.info) (Fraunhofer ISE) —
free, no API key, ~15-min resolution. **Not** data.public.lu directly — those
datasets are a daily crawl mirror of ENTSO-E, so they lag by up to a day.
data.public.lu is still worth using later for deep historical backfill if
energy-charts.info's own history doesn't go back far enough.

Luxembourg has almost no domestic generation — most of what shows up in
`public_power` will be `"Cross border electricity trading"`, not solar/wind/
hydro. Worth designing the dashboard's hero visual around imports/exports,
not generation mix.

## Architecture

```
GitHub Actions (cron, 15 min) → energy-charts.info
        │
        ▼
   Postgres (Neon/Supabase) ← single source of truth, full history
        │
        ▼
   Vercel serverless API (/api/live, /api/history, /api/tariff)
        │
        ├── React/Vite dashboard (browser)
        └── evcc custom tariff plugin (Raspberry Pi, polls hourly)
```

Nothing except the GitHub Actions cron talks to energy-charts.info directly.
Every other consumer — the web app, evcc, anything added later (Home
Assistant, mobile) — reads from your own `/api/*` endpoints. This avoids
hitting energy-charts.info's public rate limits from multiple devices, and
means your Pi's charging automation doesn't break if energy-charts.info has
a bad moment or your home connection drops.

## Repo layout

```
lux-energy/
├── db/schema.sql              # run once against your Postgres
├── scripts/ingest.js          # runs via GitHub Actions, writes to Postgres
├── .github/workflows/ingest.yml
├── package.json                # deps for the ingest script only
└── frontend/                   # <- this is the Vercel project root
    ├── src/App.jsx             # the dashboard
    ├── api/
    │   ├── live.js
    │   ├── history.js
    │   └── tariff.js            # not needed yet — for evcc later
    └── package.json             # deps for both the Vite app and the API
```

Two separate deploy targets: GitHub Actions runs the ingestion cron (writes
to Postgres), Vercel serves the frontend + read-only API (reads from
Postgres). Neither depends on the other being redeployed.

## Deploy steps

**1. Push to GitHub**

```bash
cd lux-energy
git init && git add . && git commit -m "initial scaffold"
git remote add origin https://github.com/<you>/lux-energy.git
git push -u origin main
```

**2. Create the database** — [neon.tech](https://neon.tech) free tier is
the easiest fit here (serverless Postgres, works well with Vercel). Create
a project, copy the connection string.

**3. Run the schema** — paste the contents of `db/schema.sql` into Neon's
SQL editor (or `psql "<connection string>" -f db/schema.sql` if you have
`psql` locally) and run it once.

**4. Wire up ingestion (GitHub Actions)**
- Repo → Settings → Secrets and variables → Actions → New repository secret
- Name: `DATABASE_URL`, value: the Neon connection string
- The workflow in `.github/workflows/ingest.yml` will now run every 15 min
  automatically. To test it immediately without waiting: Actions tab →
  "Ingest energy data" → Run workflow (this uses the `workflow_dispatch`
  trigger already in the file).
- Check the run logs — you want to see `[ok] prices: N rows` etc. If
  `cross_border_flows` or `installed_capacity` fail, that's the endpoint-shape
  caveat mentioned below — the other two series will still succeed
  independently.

**5. Deploy the frontend (Vercel)**
- [vercel.com/new](https://vercel.com/new) → import the GitHub repo
- **Root Directory**: set this to `frontend` — this is the one setting
  that isn't automatic, since the repo has the ingest script alongside it
- Framework preset: Vite (auto-detected once root directory is set)
- Environment variable: `DATABASE_URL` → same Neon connection string
- Deploy

**6. Check it's actually showing data**

Give the GitHub Action a few runs (or trigger it manually 2-3 times a few
minutes apart) before expecting to see a real price chart — `/api/history`
needs more than one data point to draw a line. Visit `/api/live` directly
on your deployed URL first as a sanity check; if that returns real numbers,
the frontend will too.

## Before you build further

I confirmed `price` and `public_power` response shapes directly against
energy-charts.info. I could not verify the exact cross-border flow endpoint
(`/cbpf`) or installed capacity endpoint against Luxembourg specifically —
worth a live curl before trusting those two ingest functions:

```bash
curl "https://api.energy-charts.info/cbpf?country=lu"
curl "https://api.energy-charts.info/installed_power?country=lu&time_step=yearly"
```

If field names differ from what's in `scripts/ingest.js`, it's a five-minute
fix — the rest of the pipeline doesn't depend on their internal shape.

## Not yet built

- Backfill script for deep history (same fetch logic as `ingest.js`, just
  with `start`/`end` params, one-time run)
- evcc tariff integration — `api/tariff.js` exists and is ready, but you
  said that's a later step
- Rate-limit/retry handling in `ingest.js` if energy-charts.info throttles

Happy to build any of these next — say which one.

