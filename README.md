# 💰 WealthLens Pro

Family portfolio dashboard with Google Sign-In, Postgres database, live market prices, and document attachments.

---

## What's new vs the simple version

| Feature | Simple | Pro |
|---------|--------|-----|
| Storage | JSON file (fragile) | Supabase Postgres (robust) |
| Auth | PIN | Google Sign-In |
| Indian stock prices | Manual | Auto via Yahoo Finance |
| MF NAV | Manual | Auto via api.mfapi.in |
| US stock prices | Manual | Auto via Yahoo Finance |
| USD/INR rate | Manual | Auto via Yahoo Finance |
| File attachments | No | Yes (PDFs, images, statements) |
| Concurrent users | Unsafe | Safe (ACID transactions) |

---

## Setup (one time, ~20 minutes)

### Step 1 — Supabase project

1. Go to [supabase.com](https://supabase.com) → New project
2. Name: `wealthlens` · Region: South Asia (Mumbai) · Set a DB password → Create
3. Wait ~2 minutes for the project to spin up

### Step 2 — Database schema

1. In Supabase: left sidebar → **SQL Editor** → New query
2. Paste the entire contents of `database.sql` → **Run**
3. You should see "Success" — tables and storage bucket are created

### Step 3 — Google Auth

1. In Supabase: **Authentication → Providers → Google → Enable**
2. You need a Google OAuth Client ID and Secret:
   - Go to [console.cloud.google.com](https://console.cloud.google.com)
   - APIs & Services → Credentials → Create Credentials → OAuth Client ID
   - Application type: Web application
   - Authorised redirect URI: copy from Supabase (shown on the Google provider page)
   - Create → copy Client ID and Client Secret
3. Paste both into Supabase → Save

### Step 4 — Get your Supabase keys

In Supabase: **Settings → API**

You need:
- `Project URL` → this is your `SUPABASE_URL`
- `anon public` key → this is your `VITE_SUPABASE_ANON_KEY`
- `service_role secret` key → this is your `SUPABASE_SERVICE_KEY` (keep this private)

### Step 5 — Deploy on Replit

1. replit.com → Create Repl → Node.js → upload this folder
2. Click 🔒 **Secrets** and add:

| Key | Value |
|-----|-------|
| `SUPABASE_URL` | your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | your service_role key |
| `VITE_SUPABASE_URL` | same as SUPABASE_URL |
| `VITE_SUPABASE_ANON_KEY` | your anon key |
| `ALLOWED_EMAILS` | `avinash@gmail.com,priya@gmail.com` |
| `VITE_ANTHROPIC_KEY` | your Anthropic key (for AI PDF reports) |

3. In Supabase: **Authentication → URL Configuration**
   - Site URL: your Replit URL (e.g. `https://wealthlens.yourusername.repl.co`)
   - Redirect URLs: same URL

4. Click **Run** → done

---

## Using live prices

When adding a holding, fill in the ticker/scheme code field:

| Asset type | Field | Example |
|------------|-------|---------|
| Indian Stocks | NSE Ticker | `RELIANCE`, `HDFCBANK`, `TCS` |
| US Stocks | US Ticker | `AAPL`, `NVDA`, `MSFT` |
| Mutual Funds | AMFI Scheme Code | `119551` (Mirae Asset Large Cap) |

Find AMFI scheme codes at: [mfapi.in](https://api.mfapi.in)

Then click **⟳ Live Prices** in the header to fetch all prices at once.

---

## Attaching documents

Click the 📎 button on any holding to open the documents panel. You can attach:
- Contract notes (from your broker)
- FD receipts
- MF account statements
- Property documents
- Any PDF, image, or Excel file

Files are stored securely in Supabase Storage (private bucket, only accessible with a valid signed URL that expires after 5 minutes).

---

## Project structure

```
wealthlens-pro/
├── server.js        ← Express: auth, CRUD, price fetching, artifact upload
├── database.sql     ← Run once in Supabase SQL Editor
├── src/
│   ├── main.jsx     ← React entry point
│   ├── supabase.js  ← Supabase client (auth only)
│   └── App.jsx      ← Full app UI
├── index.html
├── vite.config.js
├── package.json
└── .replit
```
