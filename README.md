# JointStores v2 — Fortville pilot (Release 1)

Money & custody ledger for the stores. NRS is the system of record for sales; this app is the
record for **where the cash is** (drawer → safe → Chelsea → in transit → bank) and for verifying
each day's close against the NRS Store Report.

## Run locally
```
npm install
# Postgres 16: create a database, then
psql -d <db> -f supabase/migrations/0001_fortville_release1.sql
psql -d <db> -f supabase/seed/fortville.sql
DATABASE_URL=postgres://… node --experimental-strip-types scripts/set-pin.ts Chelsea 1234
npm run dev      # http://localhost:3100
```
`.env.local` needs `DATABASE_URL` and `SESSION_SECRET`.

## Tests
```
npm test                 # parsers + posting rules (23)
bash test/sql/run.sh     # schema, RLS, revisions on a fresh DB (C-4…C-17)
CHROME=<chromium> node test/e2e/walkthrough.mjs   # real 10/17/2026 day through every screen
```

## Layout
- `lib/nrs/` — parsers: Store/Shift/CC Report text, the five CSV exports, both banks' statements
- `lib/ledger/posting.ts` — Part B rules as pure functions
- `supabase/migrations/0001_…sql` — schema, append-only ledger, `revise_close()`, RLS
- `lib/app/` — db (RLS context), auth (PIN), use cases
- `app/` — Close, Safe, Deposit & Verify, Cash Position

## Not in Release 1 (own gates)
schedules, hours, pay, bills beyond the 7-day projection, inventory, other stores.
Nothing deploys without the owner's go on Supabase Pro / Vercel Pro. The old Supabase project is never touched.
