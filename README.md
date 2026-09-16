# CivicChain

A transparent civic-complaint tracking platform with a real backend, real
accounts, and a genuine hash-chained ledger (not a blockchain network, but a
tamper-evident append-only log — the same core idea, without the overhead of
running actual distributed nodes for a demo).

## Architecture

```
civicseva/
├── src/               Node.js + Express + PostgreSQL API
│   ├── server.js         App entry point (also serves frontend/ as static files)
│   ├── db.js              PostgreSQL connection pool
│   ├── schema.sql        Table definitions
│   ├── migrate.js        Applies schema.sql
│   ├── seed.js            Optional demo data
│   ├── middleware/auth.js
│   ├── routes/auth.js           /api/auth/register, /api/auth/login, /api/auth/me
│   ├── routes/complaints.js     /api/complaints/*
│   ├── routes/analytics.js      /api/analytics
│   ├── routes/resolutionPhotos.js
│   └── utils/
│       ├── blockchain.js  SHA-256 hash-chaining logic
│       └── images.js
└── frontend/
    └── index.html    The original UI, rewired to call the API instead of localStorage
```

**What changed from the original single-file prototype:**
- All data now lives in PostgreSQL, not `localStorage` — it survives a
  refresh, works across devices, and can't be edited by opening dev tools.
- Citizens and officers have real accounts (bcrypt-hashed passwords, JWT
  sessions). Only a logged-in citizen can file a complaint under their own
  name; only a logged-in officer can change a complaint's status.
- The "blockchain" is now a real hash chain: every event (filed, status
  change) stores `SHA256(previous_hash + this event's data)`. The public
  `/verify` endpoint recomputes every hash and reports whether the chain is
  intact — so it's actually checking something, not just displaying a
  random string.
- Verification and analytics stay public with no login, matching the
  original "anyone can audit" pitch.

## 1. Set up the database

You need a PostgreSQL server (local install, Docker, or a free hosted one —
Supabase, Neon, and Railway all offer free Postgres instances that work well
for this).

```bash
createdb civicchain          # or create it however your provider expects
```

## 2. Set up the backend

```bash
cp .env.example .env
# edit .env: set DATABASE_URL to your Postgres connection string,
# and set JWT_SECRET to a random string (the .env.example comment
# shows a one-liner to generate one)

npm install
npm run migrate     # creates the tables
npm run seed         # optional: adds a demo citizen, officer, and complaint
npm start            # starts the API on http://localhost:5000, also serving frontend/
```

Demo accounts created by `npm run seed`:
| Role    | Email                | Password    |
|---------|-----------------------|-------------|
| Citizen | citizen@example.com  | password123 |
| Officer | officer@example.com  | password123 |

## 3. Run the frontend

`npm start` already serves `frontend/index.html` as a static file from the
same Express server (http://localhost:5000), so there's usually nothing
extra to do — open that URL and go.

If you'd rather run the frontend as its own standalone static site (e.g. a
separate CDN/static host from the API), that still works:

```bash
cd frontend
python3 -m http.server 8080
# then open http://localhost:8080
```

By default it calls the API at `http://localhost:5000/api`. If the frontend
and backend aren't on the same origin, either edit `API_BASE` near the top
of the `<script>` tag in `index.html`, or add this line right before that
script tag:

```html
<script>window.CivicSeva_API_BASE = 'https://your-api.example.com/api';</script>
```

## Deploying (Render)

This repo includes a `render.yaml` for a one-service deploy (API + static
frontend together, since `server.js` serves `frontend/` itself):

1. Push this repo to GitHub, connect it in the Render dashboard
   ("New" → "Blueprint", point at this repo).
2. Render will read `render.yaml` and create one Web Service. Before the
   first deploy, set the `DATABASE_URL` env var to your Postgres connection
   string (Render generates `JWT_SECRET` for you automatically).
3. After the first successful deploy, run the migration once against that
   database — either locally with `DATABASE_URL` pointed at production
   (`npm run migrate`), or via a Render Shell on the service.
4. Optionally `npm run seed` the same way for demo accounts.

## 4. Using it

1. Open the site → "Choose Your Access Portal."
2. **Citizen** → sign up or log in → file a complaint → get a `CC-00N` ID.
3. **Officer** → sign up or log in → see pending complaints → mark
   In Progress / Resolved.
4. **Verify** (no login needed) → paste a `CC-00N` ID → see the full
   hash-chained history and an integrity check.
5. **Analytics** (no login needed) → city-wide totals, resolution rate,
   category breakdown.

## API summary

| Method | Endpoint                          | Auth            | Purpose |
|--------|-----------------------------------|-----------------|---------|
| POST   | `/api/auth/register`              | none            | Create a citizen or officer account |
| POST   | `/api/auth/login`                 | none            | Get a JWT |
| GET    | `/api/auth/me`                    | any logged-in   | Current user info |
| POST   | `/api/complaints`                 | citizen         | File a complaint |
| GET    | `/api/complaints/mine`            | citizen         | My complaints |
| GET    | `/api/complaints`                 | officer/admin   | All complaints (optional `?status=`) |
| PATCH  | `/api/complaints/:id/status`      | officer/admin   | Change status, appends a ledger event |
| GET    | `/api/complaints/verify/:code`    | none            | Public lookup + integrity check |
| GET    | `/api/analytics`                  | none            | City-wide stats |

## Feature update: images, priority, community, privacy

On top of the original filing/officer/verify/analytics flow, the platform now has:

- **Photo evidence** — citizens can attach photos when filing; officers can (must) attach a photo when marking a complaint Resolved. All photos are timestamped by the server (`uploaded_at = now()`), never by the client, so neither side can backdate or edit that timestamp.
- **Custom category** — the category dropdown has an "Other" option that reveals a free-text field, so a field type not on the list can still be captured.
- **Urgency flairs** — every complaint gets a Red (Urgent) / Orange (Medium) / Green (Low) priority, chosen by the citizen when filing.
- **Anonymity** — a complaint's filer is never exposed on any public endpoint (`/verify`, `/complaints/public`, `/complaints/:id/detail`) or in public comments. Officers still see the real citizen name in their dashboard (`GET /api/complaints`), since they need it to act on the complaint.
- **Duplicate detection by address** — filing at an address that already has an open complaint doesn't create a new one; the citizen is shown the existing complaint and can add their agreement to it instead. Matching is on a normalized (trimmed, lowercased) address string, not fuzzy matching, so "MG Road" and "M.G. Road" won't be recognized as the same address.
- **Community feed** — a new public portal (no login to browse) listing all complaints with photos, priority, and agree/comment counts. Opening one shows the full thread: images, comments (citizen commenters shown as "Anonymous Citizen", officers shown by name), an agree button, and — once resolved — the resolution photo with upvote/downvote and its own comment thread.
- **Read receipts** — a citizen's own complaint list shows "✓✓ Sent" (gray) until an officer's dashboard has loaded it, then flips to "✓✓ Seen" (blue). Seen-state is set server-side the moment `GET /api/complaints` (the officer list) runs.

**If you already ran `npm run migrate` before this update:** run it again. `schema.sql` uses `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` throughout, so re-running it against your existing database adds the new tables/columns without touching your existing data.

**Image storage note:** images are stored as base64 text directly in Postgres (per your setup choice), not in a separate object-storage service. This is the simplest option and fine for a demo, but every photo adds real weight to your database — keep an eye on Supabase's free-tier 500MB limit if you're testing with a lot of images.

## Known limitations (worth knowing for a demo/judging Q&A)

- **Complaint codes** (`CC-001`, `CC-002`, …) are generated from a row
  count, which is fine for a demo but can collide under heavy concurrent
  writes — a production version would use a sequence or UUID.
- **This is a hash chain, not a distributed blockchain.** There's one
  database, one server. The tamper-evidence (recomputing hashes to detect
  edits) is real; the decentralization the landing page talks about isn't
  implemented — that would mean replicating the ledger across independent
  nodes, which is a much bigger project. It's worth being upfront about
  this distinction if asked.
- **Admin accounts** aren't self-service by design — insert one directly
  into the `users` table if you want an admin role for a demo.
- No file/photo uploads, no email notifications, no rate limiting — all
  reasonable next features if you have time before the deadline.
