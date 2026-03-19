import express from "express";
import multer  from "multer";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

// ── Fail fast if required env vars are missing ───────────────────
const required = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "ANTHROPIC_KEY"];
const missing  = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`❌  Missing required environment variables: ${missing.join(", ")}`);
  console.error("    Add them in Render → Environment panel.");
  process.exit(1);
}

// ── Supabase admin client (service key — full DB access) ─────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "dist")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB max per file
});

// ── Auth middleware: verify Supabase JWT on every /api route ─────
async function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "Unauthorized" });
  // Optional: check allowed emails list
  const allowed = process.env.ALLOWED_EMAILS || "";
  if (allowed.trim()) {
    const list = allowed.split(",").map(e => e.trim().toLowerCase());
    if (!list.includes(user.email?.toLowerCase())) {
      return res.status(403).json({ error: `Access denied for ${user.email}` });
    }
  }
  req.user = user;
  next();
}

// ── PORTFOLIO: members, goals, alerts ────────────────────────────
app.get("/api/portfolio", auth, async (req, res) => {
  const { data, error } = await supabase
    .from("portfolio").select("*").eq("id", "family").single();
  if (error && error.code !== "PGRST116") return res.status(500).json({ error: error.message });
  res.json(data || null);
});

app.post("/api/portfolio", auth, async (req, res) => {
  const { members, goals, alerts } = req.body;
  const { error } = await supabase.from("portfolio").upsert({
    id: "family", members, goals, alerts,
    updated_at: new Date().toISOString(),
    updated_by: req.user.email,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Date sanitizer — convert empty strings to null ───────────────
function sanitizeDates(obj) {
  const dateFields = ["start_date", "maturity_date"];
  const result = { ...obj };
  for (const field of dateFields) {
    if (result[field] === "" || result[field] === undefined) {
      result[field] = null;
    }
  }
  return result;
}

// ── HOLDINGS ─────────────────────────────────────────────────────
app.get("/api/holdings", auth, async (req, res) => {
  // Try with transactions join first, fall back to without if it fails
  let { data, error } = await supabase
    .from("holdings")
    .select("*, artifacts(id,file_name,file_type,file_size,description,uploaded_at), transactions(id,txn_type,units,price,txn_date,notes,created_at)")
    .order("created_at", { ascending: true });

  // If join fails (e.g. transactions table not yet migrated), retry without it
  if (error) {
    console.warn("Holdings with transactions failed, retrying without:", error.message);
    ({ data, error } = await supabase
      .from("holdings")
      .select("*, artifacts(id,file_name,file_type,file_size,description,uploaded_at)")
      .order("created_at", { ascending: true }));
  }

  if (error) return res.status(500).json({ error: error.message });

  // Compute net_units and avg_cost from transactions for each holding
  const enriched = (data || []).map(h => {
    const txns = h.transactions || [];
    if (txns.length === 0) return h;
    const buys  = txns.filter(t => t.txn_type === "BUY");
    const sells = txns.filter(t => t.txn_type === "SELL");
    const buyUnits  = buys.reduce((s, t) => s + Number(t.units), 0);
    const sellUnits = sells.reduce((s, t) => s + Number(t.units), 0);
    const netUnits  = buyUnits - sellUnits;
    const avgCost   = buyUnits > 0
      ? buys.reduce((s, t) => s + Number(t.units) * Number(t.price), 0) / buyUnits
      : 0;
    return {
      ...h,
      net_units: netUnits,
      avg_cost:  avgCost,
      units:          netUnits,
      purchase_price: avgCost,
      purchase_nav:   avgCost,
      purchase_value: avgCost * netUnits,
      start_date: h.start_date || txns.sort((a,b) => new Date(a.txn_date)-new Date(b.txn_date))[0]?.txn_date || null,
    };
  });
  res.json(enriched);
});

app.post("/api/holdings", auth, async (req, res) => {
  const { first_transaction, ...holdingData } = req.body;
  const { error } = await supabase.from("holdings").insert(sanitizeDates(holdingData));
  if (error) return res.status(500).json({ error: error.message });

  // If a first transaction was provided, insert it too
  if (first_transaction && first_transaction.units && first_transaction.price) {
    await supabase.from("transactions").insert({
      id:         "t_" + Date.now() + Math.random().toString(36).slice(2,6),
      holding_id: holdingData.id,
      txn_type:   first_transaction.txn_type || "BUY",
      units:      Number(first_transaction.units),
      price:      Number(first_transaction.price),
      txn_date:   first_transaction.txn_date || holdingData.start_date || new Date().toISOString().slice(0,10),
      notes:      first_transaction.notes || "",
    });
  }
  res.json({ ok: true });
});

app.put("/api/holdings/:id", auth, async (req, res) => {
  // Strip computed / joined fields that are not real DB columns
  const { artifacts, transactions, net_units, avg_cost, purchase_nav, purchase_price, ...holdingData } = req.body;
  const { error } = await supabase.from("holdings").update(sanitizeDates(holdingData)).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete("/api/holdings/:id", auth, async (req, res) => {
  const { error } = await supabase.from("holdings").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── TRANSACTIONS ──────────────────────────────────────────────────
app.get("/api/transactions/:holdingId", auth, async (req, res) => {
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("holding_id", req.params.holdingId)
    .order("txn_date", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post("/api/transactions", auth, async (req, res) => {
  // price_usd is stored separately — extract it before insert
  const { price_usd, ...txnData } = req.body;
  const payload = {
    id: "t_" + Date.now() + Math.random().toString(36).slice(2,6),
    ...txnData,
    ...(price_usd ? { price_usd: Number(price_usd) } : {}),
  };
  const { error } = await supabase.from("transactions").insert(payload);
  // If price_usd column doesn't exist yet, retry without it
  if (error && error.message?.includes("price_usd")) {
    const { price_usd: _drop, ...safePayload } = payload;
    const { error: e2 } = await supabase.from("transactions").insert(safePayload);
    if (e2) return res.status(500).json({ error: e2.message });
    return res.json({ ok: true });
  }
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete("/api/transactions/:id", auth, async (req, res) => {
  const { error } = await supabase.from("transactions").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── FOREX RATE — live USD/INR ─────────────────────────────────────
app.get("/api/forex/usdinr", auth, async (req, res) => {
  const result = await fetchUsdInr();
  res.json({ ...result, fetched_at: new Date().toISOString() });
});

// ── SIP BATCH NAV — fetch NAVs for a date range for SIP import ───
app.post("/api/mf/sip-navs", auth, async (req, res) => {
  const { scheme_code, months } = req.body;
  // months = [{year, month, sip_date}] — array of {year:2024, month:1, sip_date:5}
  if (!scheme_code || !months?.length) return res.status(400).json({ error: "scheme_code and months required" });

  try {
    // Fetch full NAV history once
    const response = await timedFetch(`https://api.mfapi.in/mf/${scheme_code}`, {}, 10000);
    if (!response.ok) throw new Error("MFAPI unavailable");
    const data = await response.json();
    const navHistory = data?.data || []; // [{date: "05-01-2024", nav: "77.8900"}, ...]
    const meta = data?.meta || {};

    // Build a map of date string → nav for fast lookup
    // MFAPI returns dates as DD-MM-YYYY
    const navMap = {};
    for (const entry of navHistory) {
      navMap[entry.date] = parseFloat(entry.nav);
    }

    // For each requested month, find the NAV on or after the SIP date
    const results = months.map(({ year, month, sip_date }) => {
      const isFuture = new Date(year, month - 1, sip_date) > new Date();

      if (isFuture) {
        // For future months use latest available NAV as estimate
        const latestNav = navHistory[0] ? parseFloat(navHistory[0].nav) : null;
        return {
          year, month, sip_date,
          txn_date:  `${year}-${String(month).padStart(2,'0')}-${String(sip_date).padStart(2,'0')}`,
          nav:       latestNav,
          nav_date:  navHistory[0]?.date || null,
          is_future: true,
          is_estimated: true,
        };
      }

      // Search both forward and backward up to 7 days; pick whichever is closer
      const dateKey = (yr, mo, dy) => {
        const d = new Date(yr, mo - 1, dy);
        return {
          key: `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`,
          iso: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`,
        };
      };

      let fwdResult = null, bwdResult = null;

      for (let offset = 0; offset <= 7; offset++) {
        if (!fwdResult) {
          const { key, iso } = dateKey(year, month, sip_date + offset);
          if (navMap[key]) fwdResult = { offset, key, iso };
        }
        if (!bwdResult && offset > 0) {
          const { key, iso } = dateKey(year, month, sip_date - offset);
          if (navMap[key]) bwdResult = { offset, key, iso };
        }
        if (fwdResult && bwdResult) break;
      }

      // Exact match (offset 0) wins; otherwise pick the closer direction
      const best = fwdResult && bwdResult
        ? (fwdResult.offset <= bwdResult.offset ? fwdResult : bwdResult)
        : (fwdResult || bwdResult);

      if (best) {
        return {
          year, month, sip_date,
          txn_date:     best.iso,
          nav:          navMap[best.key],
          nav_date:     best.key,
          is_future:    false,
          is_estimated: best.offset > 0,
        };
      }

      return { year, month, sip_date, txn_date: null, nav: null, is_future: false, is_estimated: false };
    });

    res.json({ results, fund_house: meta.fund_house || "", scheme_name: meta.scheme_name || "" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── MF NAV — MFAPI → AMFI direct ────────────────────────────────
app.get("/api/mf/nav/:schemeCode", auth, async (req, res) => {
  const result = await fetchMfNav(req.params.schemeCode);
  if (!result) return res.json({ nav: null });
  res.json({
    nav:             result.nav,
    date:            result.date || null,
    fund_house:      result.meta?.fund_house || "",
    scheme_category: result.meta?.scheme_category || "",
    scheme_type:     result.meta?.scheme_type || "",
    source:          result.source,
  });
});

// ── MF SEARCH — AMFI master list → MFAPI supplement ─────────────
app.get("/api/mf/search", auth, async (req, res) => {
  const q = (req.query.q || "").trim();
  if (q.length < 2) return res.json([]);
  const qLower = q.toLowerCase();
  const qWords = qLower.split(/\s+/).filter(Boolean);

  // Primary: AMFI master list local fuzzy search (always populated from cache)
  const all = await getAmfiList();
  let results = all
    .map(f => ({ ...f, score: scoreMf(f.name, qLower, qWords) }))
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);

  // Supplement: MFAPI search — adds any results not already found
  if (results.length < 5) {
    try {
      const r = await timedFetch(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(q)}`, {}, 4000);
      if (r.ok) {
        const data = await r.json();
        const existing = new Set(results.map(x => x.scheme_code));
        for (const f of (data || [])) {
          const sc = String(f.schemeCode);
          if (!existing.has(sc)) {
            results.push({ scheme_code: sc, name: f.schemeName, score: scoreMf(f.schemeName, qLower, qWords) });
            existing.add(sc);
          }
        }
        results.sort((a, b) => (b.score || 0) - (a.score || 0));
      }
    } catch { /* fall through */ }
  }

  res.json(results.slice(0, 15).map(f => ({ scheme_code: f.scheme_code, name: f.name })));
});

// ── ETF SEARCH — Indian ETFs via Twelve Data → Yahoo ─────────────
app.get("/api/etf/search", auth, async (req, res) => {
  const q = req.query.q || "";
  if (q.length < 2) return res.json([]);
  try {
    const results = await stockSearch(q, "IN");
    const ETF_KW = /etf|bees|fund|gold|nifty|sensex|index|junior|midcap|smallcap|liquid|overnight|banking|silver|copper|nasdaq/i;
    res.json(results.filter(s => s.type === "ETF" || s.type === "Exchange Traded Fund" || ETF_KW.test(s.name)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── STOCK SEARCH — Twelve Data → Yahoo ───────────────────────────
app.get("/api/stock/search", auth, async (req, res) => {
  const { q, market } = req.query;
  if (!q || q.length < 2) return res.json([]);
  try {
    res.json(await stockSearch(q, market || "US"));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── STOCK INFO — Twelve Data → Yahoo (.NS then .BO for Indian) ───
app.get("/api/stock/info", auth, async (req, res) => {
  const { ticker, market } = req.query;
  if (!ticker) return res.status(400).json({ error: "ticker required" });
  const t = ticker.toUpperCase();

  // Twelve Data
  if (TWELVE_KEY) {
    const q = await twelveQuote(market === "IN" ? `${t}:NSE` : t);
    if (q?.price) return res.json({ found: true, ...q, symbol: t });
    if (market === "IN") {
      const q2 = await twelveQuote(`${t}:BSE`);
      if (q2?.price) return res.json({ found: true, ...q2, symbol: t });
    }
  }

  // Yahoo fallback — .NS then .BO for Indian
  for (const symbol of market === "IN" ? [`${t}.NS`, `${t}.BO`] : [t]) {
    const meta = await yahooChart(symbol);
    if (!meta) continue;
    const price = meta.regularMarketPrice ?? meta.chartPreviousClose;
    if (!price) continue;
    return res.json({
      found: true, name: meta.longName || meta.shortName || "",
      price, currency: meta.currency || (market === "IN" ? "INR" : "USD"),
      exchange: meta.exchangeName || "", symbol: meta.symbol || symbol,
    });
  }
  res.json({ found: false });
});

// ── ANTHROPIC PROXY — all Claude API calls go through here ───────
app.post("/api/ai/chat", auth, async (req, res) => {
  const key = process.env.ANTHROPIC_KEY;
  if (!key) return res.status(500).json({ error: "ANTHROPIC_KEY not set on server" });
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    // Log any Anthropic-level errors so they appear in Render logs
    if (!response.ok) {
      console.error("Anthropic error:", response.status, JSON.stringify(data));
      return res.status(response.status).json({ error: data?.error?.message || "Anthropic API error", detail: data });
    }
    res.json(data);
  } catch (e) {
    console.error("AI chat error:", e.message);
    res.status(500).json({ error: e.message });
  }
});
// ══════════════════════════════════════════════════════════════════
//  DATA SOURCE FALLBACK LAYER
//  MF:     AMFI master list → MFAPI.in
//  Stocks: Twelve Data → Yahoo Finance
//  FX:     exchangerate-api → Yahoo Finance → 83.5
// ══════════════════════════════════════════════════════════════════

const TWELVE_KEY = process.env.TWELVE_DATA_KEY || "";  // optional — set in Render env
const FX_FALLBACK = 83.5;

// ── Generic fetch with timeout ────────────────────────────────────
async function timedFetch(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(timer);
    return r;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ── YAHOO FINANCE helpers (dual-host, rate-limit aware) ───────────
const YAHOO_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function yahooFetch(path) {
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const r = await timedFetch(`https://${host}${path}`, { headers: { "User-Agent": YAHOO_UA, "Accept": "application/json" } });
      if (!r.ok) continue;
      const data = await r.json();
      if (data?.finance?.error?.code === "Too Many Requests") continue;
      return data;
    } catch { continue; }
  }
  return null;
}

async function yahooChart(symbol) {
  const data = await yahooFetch(`/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`);
  return data?.chart?.result?.[0]?.meta || null;
}

async function yahooSearch(q, count = 25) {
  const data = await yahooFetch(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=${count}&newsCount=0&enableFuzzyQuery=true`);
  return data?.quotes || [];
}

async function yahooPrice(symbol) {
  const meta = await yahooChart(symbol);
  return meta?.regularMarketPrice ?? meta?.chartPreviousClose ?? null;
}

// ── TWELVE DATA helpers ───────────────────────────────────────────
// Returns null if no key is configured so callers fall through to Yahoo.

async function twelveSearch(q, exchange = "") {
  if (!TWELVE_KEY) return null;
  try {
    const url = `https://api.twelvedata.com/symbol_search?symbol=${encodeURIComponent(q)}&outputsize=20${exchange ? "&exchange=" + exchange : ""}`;
    const r = await timedFetch(url, { headers: { "Authorization": `apikey ${TWELVE_KEY}` } });
    if (!r.ok) return null;
    const data = await r.json();
    if (data.status === "error") return null;
    return data.data || [];   // [{symbol, instrument_name, exchange, country, type}]
  } catch { return null; }
}

async function twelveQuote(symbol) {
  if (!TWELVE_KEY) return null;
  try {
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${TWELVE_KEY}`;
    const r = await timedFetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    if (data.status === "error" || !data.close) return null;
    return {
      name:     data.name || symbol,
      price:    parseFloat(data.close),
      exchange: data.exchange || "",
      currency: data.currency || "",
    };
  } catch { return null; }
}

// ── STOCK PRICE: Twelve Data → Yahoo ─────────────────────────────
async function stockPrice(symbol, marketSuffix = "") {
  // Twelve Data: symbol without suffix (uses exchange param or symbol directly)
  const tdSymbol = marketSuffix ? symbol.replace(/\.(NS|BO)$/, "") : symbol;
  if (TWELVE_KEY) {
    const q = await twelveQuote(tdSymbol + (marketSuffix ? `:${marketSuffix}` : ""));
    if (q?.price) return q;
  }
  // Yahoo fallback
  const meta = await yahooChart(symbol);
  if (!meta) return null;
  const price = meta.regularMarketPrice ?? meta.chartPreviousClose;
  if (!price) return null;
  return { name: meta.longName || meta.shortName || "", price, exchange: meta.exchangeName || "", currency: meta.currency || "" };
}

// ── STOCK SEARCH: Twelve Data → Yahoo ────────────────────────────
async function stockSearch(q, market = "US") {
  // Try Twelve Data
  if (TWELVE_KEY) {
    const exchange = market === "IN" ? "NSE,BSE" : "";
    const results = await twelveSearch(q, exchange);
    if (results?.length) {
      return results
        .filter(s => market === "IN"
          ? ["NSE","BSE"].includes(s.exchange)
          : !["NSE","BSE"].includes(s.exchange) && s.country === "United States")
        .filter(s => ["Common Stock","ETF","Equity"].includes(s.instrument_type || s.type))
        .slice(0, 12)
        .map(s => ({
          ticker:   market === "IN" ? s.symbol : s.symbol,
          symbol:   s.symbol,
          name:     s.instrument_name || s.symbol,
          exchange: s.exchange || "",
          type:     s.instrument_type || s.type || "EQUITY",
        }));
    }
  }
  // Yahoo fallback
  const quotes = await yahooSearch(q);
  const ETF_KW = /etf|bees|fund|gold|nifty|sensex|index|midcap|smallcap|liquid|overnight|banking|silver|copper|nasdaq/i;
  return quotes
    .filter(qt => {
      if (market === "IN") {
        const onIN = qt.symbol?.endsWith(".NS") || qt.symbol?.endsWith(".BO") || qt.exchange === "NSI" || qt.exchange === "BSE";
        return onIN && (qt.quoteType === "EQUITY" || qt.quoteType === "ETF" || ETF_KW.test(qt.longname || ""));
      }
      const notIN = !qt.symbol?.endsWith(".NS") && !qt.symbol?.endsWith(".BO") && qt.exchange !== "NSI" && qt.exchange !== "BSE";
      return notIN && (qt.quoteType === "EQUITY" || qt.quoteType === "ETF");
    })
    .slice(0, 12)
    .map(qt => ({
      ticker:   market === "IN" ? (qt.symbol?.replace(/\.(NS|BO)$/, "") || qt.symbol) : qt.symbol,
      symbol:   qt.symbol,
      name:     qt.longname || qt.shortname || qt.symbol,
      exchange: qt.exchange || "",
      type:     qt.quoteType || "EQUITY",
    }));
}

// ── MF NAV: AMFI direct → MFAPI fallback ─────────────────────────
async function fetchMfNav(schemeCode) {
  // Primary: AMFI NAVAll.txt (authoritative, updated daily)
  try {
    const r = await timedFetch("https://www.amfiindia.com/spages/NAVAll.txt", {}, 8000);
    if (r.ok) {
      const text = await r.text();
      // Format: SchemeCode;ISIN1;ISIN2;SchemeName;NAV;Date
      for (const line of text.split("\n")) {
        const parts = line.split(";");
        if (parts[0]?.trim() === String(schemeCode)) {
          const nav = parseFloat(parts[4]);
          if (!isNaN(nav)) return { nav, date: parts[5]?.trim() || null, meta: { fund_house: "" }, source: "amfi" };
        }
      }
    }
  } catch { /* fall through */ }

  // Fallback: MFAPI
  try {
    const r = await timedFetch(`https://api.mfapi.in/mf/${schemeCode}`, {}, 5000);
    if (r.ok) {
      const data = await r.json();
      const nav = parseFloat(data?.data?.[0]?.nav);
      if (!isNaN(nav)) return { nav, date: data?.data?.[0]?.date || null, meta: data?.meta || {}, source: "mfapi" };
    }
  } catch { /* fall through */ }

  return null;
}

// ── MF SEARCH: AMFI master list (primary) → MFAPI (fallback) ─────
let amfiCache = null;
let amfiCacheTime = 0;

async function getAmfiList() {
  if (amfiCache && Date.now() - amfiCacheTime < 6 * 3600_000) return amfiCache;
  // Primary: AMFI direct scheme list
  try {
    const r = await timedFetch("https://www.amfiindia.com/spages/NAVAll.txt", {}, 10000);
    if (r.ok) {
      const text = await r.text();
      const schemes = [];
      for (const line of text.split("\n")) {
        const parts = line.split(";");
        if (parts.length >= 5 && /^\d+$/.test(parts[0]?.trim())) {
          schemes.push({ scheme_code: parts[0].trim(), name: parts[3]?.trim() || "" });
        }
      }
      if (schemes.length > 100) {
        amfiCache = schemes;
        amfiCacheTime = Date.now();
        console.log(`📋 AMFI list cached from amfiindia.com: ${amfiCache.length} schemes`);
        return amfiCache;
      }
    }
  } catch { /* fall through */ }
  // Fallback: MFAPI all-schemes list
  try {
    const r = await timedFetch("https://api.mfapi.in/mf", {}, 10000);
    if (r.ok) {
      const data = await r.json();
      amfiCache = (data || []).map(f => ({ scheme_code: String(f.schemeCode), name: f.schemeName }));
      amfiCacheTime = Date.now();
      console.log(`📋 AMFI list cached from MFAPI: ${amfiCache.length} schemes`);
    }
  } catch { /* keep stale */ }
  return amfiCache || [];
}

function scoreMf(name, qLower, qWords) {
  const n = name.toLowerCase();
  if (n.startsWith(qLower)) return 100;
  if (n.includes(qLower)) return 80;
  const hits = qWords.filter(w => n.includes(w)).length;
  if (hits === qWords.length) return 60;
  return hits > 0 ? Math.round(40 * hits / qWords.length) : 0;
}

// ── FX RATE: exchangerate-api → Yahoo → 83.5 ─────────────────────
async function fetchUsdInr() {
  // Primary: exchangerate-api (free tier, 1500 req/month, no key needed for open endpoint)
  try {
    const r = await timedFetch("https://open.er-api.com/v6/latest/USD", {}, 5000);
    if (r.ok) {
      const data = await r.json();
      const rate = data?.rates?.INR;
      if (rate && rate > 50 && rate < 200) return { rate, source: "exchangerate-api" };
    }
  } catch { /* fall through */ }

  // Fallback 1: Yahoo Finance
  try {
    const rate = await yahooPrice("USDINR=X");
    if (rate && rate > 50 && rate < 200) return { rate, source: "yahoo" };
  } catch { /* fall through */ }

  // Fallback 2: hardcoded
  return { rate: FX_FALLBACK, source: "hardcoded" };
}

// ── AMFI NAV fallback for prices/refresh ─────────────────────────
async function mfNav(schemeCode) {
  const result = await fetchMfNav(schemeCode);
  return result?.nav ?? null;
}


// ── PRICES REFRESH — Twelve Data → Yahoo (.NS + .BO) + MFAPI + FX ─
app.post("/api/prices/refresh", auth, async (req, res) => {
  const { data: holdings } = await supabase
    .from("holdings")
    .select("id, type, ticker, scheme_code, usd_inr_rate");

  if (!holdings?.length) return res.json({ updated: 0 });

  // FX rate with full fallback chain
  const { rate: usdInr, source: fxSource } = await fetchUsdInr();

  const updates = [];
  for (const h of holdings) {
    let patch = null;
    try {
      if (h.type === "MF" && h.scheme_code) {
        const nav = await mfNav(h.scheme_code);
        if (nav) patch = { current_nav: nav, price_fetched_at: new Date().toISOString() };

      } else if ((h.type === "IN_STOCK" || h.type === "IN_ETF") && h.ticker) {
        // Twelve Data → Yahoo .NS → Yahoo .BO
        const q = await stockPrice(`${h.ticker.toUpperCase()}.NS`, "NSE");
        const price = q?.price ?? await yahooPrice(`${h.ticker.toUpperCase()}.BO`);
        if (price) patch = { current_price: price, price_fetched_at: new Date().toISOString() };

      } else if (h.type === "US_STOCK" && h.ticker) {
        const q = await stockPrice(h.ticker.toUpperCase());
        if (q?.price) patch = { current_price: q.price, usd_inr_rate: usdInr, price_fetched_at: new Date().toISOString() };
      }
    } catch { /* skip failed holding */ }

    if (patch) {
      await supabase.from("holdings").update(patch).eq("id", h.id);
      updates.push({ id: h.id, ...patch });
    }
  }
  res.json({ updated: updates.length, usdInr, fxSource, results: updates });
});

// ── ARTIFACTS ────────────────────────────────────────────────────
app.get("/api/artifacts/:holdingId", auth, async (req, res) => {
  const { data, error } = await supabase
    .from("artifacts")
    .select("*")
    .eq("holding_id", req.params.holdingId)
    .order("uploaded_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post("/api/artifacts/upload", auth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const { holdingId, description } = req.body;
  if (!holdingId) return res.status(400).json({ error: "holdingId required" });

  const id = "art_" + Date.now() + Math.random().toString(36).slice(2,6);
  const ext = req.file.originalname.split(".").pop();
  const storagePath = `holdings/${holdingId}/${id}.${ext}`;

  // Upload bytes to Supabase Storage
  const { error: upErr } = await supabase.storage
    .from("artifacts")
    .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
  if (upErr) return res.status(500).json({ error: upErr.message });

  // Save metadata to DB
  const { error: dbErr } = await supabase.from("artifacts").insert({
    id, holding_id: holdingId,
    file_name: req.file.originalname,
    storage_path: storagePath,
    file_type: req.file.mimetype,
    file_size: req.file.size,
    description: description || "",
  });
  if (dbErr) return res.status(500).json({ error: dbErr.message });
  res.json({ ok: true, id, file_name: req.file.originalname });
});

app.get("/api/artifacts/download/:id", auth, async (req, res) => {
  const { data, error } = await supabase
    .from("artifacts").select("storage_path, file_name").eq("id", req.params.id).single();
  if (error || !data) return res.status(404).json({ error: "Not found" });
  const { data: signed } = await supabase.storage
    .from("artifacts").createSignedUrl(data.storage_path, 300); // 5-min expiry
  res.json({ url: signed?.signedUrl, file_name: data.file_name });
});

app.delete("/api/artifacts/:id", auth, async (req, res) => {
  const { data } = await supabase
    .from("artifacts").select("storage_path").eq("id", req.params.id).single();
  if (data?.storage_path) {
    await supabase.storage.from("artifacts").remove([data.storage_path]);
  }
  await supabase.from("artifacts").delete().eq("id", req.params.id);
  res.json({ ok: true });
});

// ── Serve React app for all other routes ─────────────────────────
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "dist", "index.html")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅  WealthLens Pro running on port ${PORT}`);
  console.log(`📊  Price sources: Twelve Data → Yahoo Finance | MF: MFAPI → AMFI | FX: exchangerate-api → Yahoo → ${FX_FALLBACK}`);
  console.log(`🔐  Google Auth via Supabase`);
  console.log(`💾  Postgres DB + file storage via Supabase`);
});

// ══════════════════════════════════════════════════════════════════
//  BUDGET MODULE
// ══════════════════════════════════════════════════════════════════

import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const Papa = _require("papaparse");
const XLSX = _require("xlsx");
import crypto from "crypto";

// ── Encryption helpers (AES-256-GCM) ─────────────────────────────
const BUDGET_KEY = process.env.BUDGET_ENCRYPT_KEY
  ? Buffer.from(process.env.BUDGET_ENCRYPT_KEY, "hex")
  : crypto.randomBytes(32);
if (!process.env.BUDGET_ENCRYPT_KEY) {
  console.warn("⚠️  BUDGET_ENCRYPT_KEY not set — using ephemeral key. Transactions will lose decryption on restart. Set a 64-char hex key in Render env.");
}

function encrypt(text) {
  if (!text) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", BUDGET_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString("hex") + ":" + tag.toString("hex") + ":" + enc.toString("hex");
}

function decrypt(data) {
  if (!data || !data.includes(":")) return data || "";
  try {
    const [ivHex, tagHex, encHex] = data.split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", BUDGET_KEY, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]).toString("utf8");
  } catch { return "[encrypted]"; }
}

// ── Auto-categorise from keywords ────────────────────────────────
async function autoCategorise(description) {
  try {
    const { data: cats } = await supabase.from("budget_categories").select("id,name,keywords");
    const desc = description.toLowerCase();
    for (const cat of (cats || [])) {
      if (!cat.keywords) continue;
      for (const kw of cat.keywords.split(",").map(k => k.trim()).filter(Boolean)) {
        if (desc.includes(kw)) return cat.name;
      }
    }
  } catch { /* ignore */ }
  return "Other";
}

// ── Parser: detect bank format and parse CSV rows ─────────────────
function parseCSV(text) {
  const result = Papa.parse(text.trim(), { header: false, skipEmptyLines: true });
  const rows = result.data;
  if (!rows.length) return [];

  // Detect format by header row
  const headerRow = rows.find(r => r.some(c => /date|narration|description|particulars/i.test(c)));
  if (!headerRow) return genericCSV(rows);

  const h = headerRow.map(c => (c||"").toLowerCase().trim());
  const dataRows = rows.slice(rows.indexOf(headerRow) + 1);

  // HDFC Bank savings (Date, Narration, Chq/Ref, Value Date, Withdrawal, Deposit, Balance)
  if (h.includes("narration") && h.includes("withdrawal amt.") || h.includes("withdrawal amt")) {
    return dataRows.map(r => ({
      date: r[0], desc: r[1], debit: r[4], credit: r[5], balance: r[6], ref: r[2]
    })).filter(r => r.date && r.desc);
  }

  // ICICI Bank (S No., Value Date, Transaction Date, Cheque Number, Transaction Remarks, Withdrawal Amount, Deposit Amount, Balance)
  if (h.some(c => c.includes("transaction remarks"))) {
    return dataRows.map(r => ({
      date: r[2]||r[1], desc: r[4], debit: r[5], credit: r[6], balance: r[7], ref: r[3]
    })).filter(r => r.date && r.desc);
  }

  // Axis Bank (Tran Date, CHQNO, Particulars, Debit, Credit, Balance, Dr/Cr)
  if (h.some(c => c.includes("particulars"))) {
    return dataRows.map(r => ({
      date: r[0], desc: r[2], debit: r[3], credit: r[4], balance: r[5], ref: r[1]
    })).filter(r => r.date && r.desc);
  }

  // SBI (Txn Date, Value Date, Description, Ref No./Cheque No., Debit, Credit, Balance)
  if (h.some(c => c.includes("txn date")) || h.some(c => c.includes("value date"))) {
    return dataRows.map(r => ({
      date: r[0], desc: r[2], debit: r[4], credit: r[5], balance: r[6], ref: r[3]
    })).filter(r => r.date && r.desc);
  }

  // Kotak (Transaction Date, Value Date, Description, Debit, Credit, Balance)
  if (h.some(c => c.includes("transaction date"))) {
    const di = h.findIndex(c => c.includes("transaction date")||c.includes("date"));
    const descI = h.findIndex(c => c.includes("description")||c.includes("particular")||c.includes("narration"));
    const debI = h.findIndex(c => c.includes("debit")||c.includes("withdrawal"));
    const credI = h.findIndex(c => c.includes("credit")||c.includes("deposit"));
    const balI = h.findIndex(c => c.includes("balance"));
    return dataRows.map(r => ({
      date: r[di], desc: r[descI], debit: r[debI], credit: r[credI], balance: r[balI]
    })).filter(r => r.date && r.desc);
  }

  return genericCSV(rows);
}

function genericCSV(rows) {
  // Best-effort: find date-like, desc-like, amount-like columns
  const header = rows[0] || [];
  const h = header.map(c => (c||"").toLowerCase());
  const di  = h.findIndex(c => /date/i.test(c));
  const dsc = h.findIndex(c => /desc|narr|particular|remark/i.test(c));
  const deb = h.findIndex(c => /debit|withdrawal|dr/i.test(c));
  const crd = h.findIndex(c => /credit|deposit|cr/i.test(c));
  const amt = h.findIndex(c => /amount/i.test(c));
  if (di < 0 || (dsc < 0 && amt < 0)) return [];
  return rows.slice(1).map(r => ({
    date: r[di], desc: dsc >= 0 ? r[dsc] : r[1],
    debit: deb >= 0 ? r[deb] : (amt >= 0 ? r[amt] : ""),
    credit: crd >= 0 ? r[crd] : "",
    balance: "", ref: ""
  })).filter(r => r.date && r.desc);
}

function parseAmount(val) {
  if (!val) return 0;
  const n = parseFloat(String(val).replace(/[₹,\s]/g, "").trim());
  return isNaN(n) ? 0 : n;
}

function parseDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  // DD/MM/YYYY or DD-MM-YYYY
  const m1 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m1) {
    const y = m1[3].length === 2 ? "20" + m1[3] : m1[3];
    return `${y}-${m1[2].padStart(2,"0")}-${m1[1].padStart(2,"0")}`;
  }
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // DD MMM YYYY (01 Jan 2024)
  const months = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  const m2 = s.match(/^(\d{1,2})\s+([a-z]{3})\s+(\d{4})$/i);
  if (m2) {
    const mo = months[m2[2].toLowerCase()];
    if (mo) return `${m2[3]}-${String(mo).padStart(2,"0")}-${m2[1].padStart(2,"0")}`;
  }
  return null;
}

// ── BUDGET: Upload + Parse Statement ─────────────────────────────
app.post("/api/budget/upload", auth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const { source, statement_type, notes } = req.body;

  const id = "bst_" + Date.now() + Math.random().toString(36).slice(2,6);
  const ext = req.file.originalname.split(".").pop().toLowerCase();

  // ── Parse file ──
  let rawRows = [];
  try {
    if (ext === "csv" || ext === "txt") {
      rawRows = parseCSV(req.file.buffer.toString("utf8"));
    } else if (ext === "xlsx" || ext === "xls") {
      const wb = XLSX.read(req.file.buffer, { type: "buffer" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const csvText = XLSX.utils.sheet_to_csv(ws);
      rawRows = parseCSV(csvText);
    } else {
      return res.status(400).json({ error: "Unsupported format. Use CSV, XLS, or XLSX." });
    }
  } catch (e) {
    return res.status(400).json({ error: "Parse error: " + e.message });
  }

  if (!rawRows.length) return res.status(400).json({ error: "No transactions found. Check the file format." });

  // ── Build transactions ──
  const txns = [];
  let periodStart = null, periodEnd = null;

  for (const row of rawRows) {
    const date = parseDate(row.date);
    if (!date) continue;
    const debit = parseAmount(row.debit);
    const credit = parseAmount(row.credit);
    if (debit === 0 && credit === 0) continue;
    const amount = debit > 0 ? debit : credit;
    const type = debit > 0 ? "DEBIT" : "CREDIT";
    const desc = String(row.desc || "").trim();
    if (!desc) continue;
    const category = await autoCategorise(desc);
    if (!periodStart || date < periodStart) periodStart = date;
    if (!periodEnd || date > periodEnd) periodEnd = date;
    txns.push({
      id: "btx_" + Date.now() + Math.random().toString(36).slice(2,8),
      statement_id: id,
      txn_date: date,
      description: encrypt(desc),
      raw_desc: encrypt(desc),
      amount,
      txn_type: type,
      category,
      balance: row.balance ? encrypt(String(row.balance)) : null,
      ref_number: (row.ref || "").slice(0, 50),
    });
  }

  if (!txns.length) return res.status(400).json({ error: "Transactions parsed but none had valid dates/amounts." });

  // ── Purge statements older than 1 year ──
  await supabase.from("budget_statements")
    .delete()
    .lt("upload_date", new Date(Date.now() - 365 * 24 * 3600_000).toISOString());

  // ── Save statement record ──
  const { error: stErr } = await supabase.from("budget_statements").insert({
    id, source: source || "Unknown", statement_type: statement_type || "BANK",
    filename: req.file.originalname, file_size: req.file.size,
    period_start: periodStart, period_end: periodEnd,
    txn_count: txns.length, notes: notes || "",
  });
  if (stErr) return res.status(500).json({ error: stErr.message });

  // ── Batch insert transactions ──
  const batchSize = 100;
  for (let i = 0; i < txns.length; i += batchSize) {
    const { error: txErr } = await supabase.from("budget_transactions").insert(txns.slice(i, i + batchSize));
    if (txErr) { console.error("Batch insert error:", txErr.message); }
  }

  res.json({ ok: true, statement_id: id, txn_count: txns.length, period_start: periodStart, period_end: periodEnd });
});

// ── BUDGET: List statements ───────────────────────────────────────
app.get("/api/budget/statements", auth, async (req, res) => {
  const { data, error } = await supabase.from("budget_statements")
    .select("*").order("upload_date", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── BUDGET: Delete statement ──────────────────────────────────────
app.delete("/api/budget/statements/:id", auth, async (req, res) => {
  await supabase.from("budget_statements").delete().eq("id", req.params.id);
  res.json({ ok: true });
});

// ── BUDGET: Get transactions (with decryption) ────────────────────
app.get("/api/budget/transactions", auth, async (req, res) => {
  const { statement_id, category, month, search } = req.query;
  let q = supabase.from("budget_transactions").select("*").order("txn_date", { ascending: false });
  if (statement_id) q = q.eq("statement_id", statement_id);
  if (category && category !== "All") q = q.eq("category", category);
  if (month) { q = q.gte("txn_date", `${month}-01`).lte("txn_date", `${month}-31`); }
  q = q.limit(1000);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  // Decrypt descriptions
  const decrypted = (data || []).map(t => ({
    ...t,
    description: decrypt(t.description),
    balance: t.balance ? decrypt(t.balance) : null,
  }));
  // Client-side search filter after decryption
  const filtered = search
    ? decrypted.filter(t => t.description.toLowerCase().includes(search.toLowerCase()))
    : decrypted;
  res.json(filtered);
});

// ── BUDGET: Update transaction category ──────────────────────────
app.patch("/api/budget/transactions/:id", auth, async (req, res) => {
  const { category } = req.body;
  const { error } = await supabase.from("budget_transactions").update({ category }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── BUDGET: Bulk recategorise ─────────────────────────────────────
app.post("/api/budget/recategorise", auth, async (req, res) => {
  const { ids, category } = req.body;
  if (!ids?.length || !category) return res.status(400).json({ error: "ids and category required" });
  const { error } = await supabase.from("budget_transactions").update({ category }).in("id", ids);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, updated: ids.length });
});

// ── BUDGET: Categories CRUD ───────────────────────────────────────
app.get("/api/budget/categories", auth, async (req, res) => {
  const { data, error } = await supabase.from("budget_categories").select("*").order("name");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post("/api/budget/categories", auth, async (req, res) => {
  const id = "cat_" + Date.now().toString(36);
  const { error } = await supabase.from("budget_categories").insert({ id, ...req.body });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, id });
});

app.put("/api/budget/categories/:id", auth, async (req, res) => {
  const { error } = await supabase.from("budget_categories").update(req.body).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete("/api/budget/categories/:id", auth, async (req, res) => {
  await supabase.from("budget_categories").delete().eq("id", req.params.id);
  res.json({ ok: true });
});

// ── BUDGET: Analytics summary ─────────────────────────────────────
app.get("/api/budget/analytics", auth, async (req, res) => {
  const { month } = req.query; // YYYY-MM
  const from = month ? `${month}-01` : new Date(Date.now() - 30*24*3600_000).toISOString().slice(0,10);
  const to   = month ? `${month}-31` : new Date().toISOString().slice(0,10);

  const { data: txns } = await supabase.from("budget_transactions")
    .select("amount, txn_type, category, txn_date")
    .gte("txn_date", from).lte("txn_date", to);

  const byCategory = {};
  let totalDebit = 0, totalCredit = 0;
  for (const t of (txns || [])) {
    if (t.txn_type === "DEBIT") {
      totalDebit += t.amount;
      byCategory[t.category] = (byCategory[t.category] || 0) + t.amount;
    } else {
      totalCredit += t.amount;
    }
  }

  // Monthly trend (last 6 months)
  const { data: allTxns } = await supabase.from("budget_transactions")
    .select("amount, txn_type, txn_date")
    .gte("txn_date", new Date(Date.now() - 180*24*3600_000).toISOString().slice(0,10))
    .eq("txn_type", "DEBIT");

  const monthly = {};
  for (const t of (allTxns || [])) {
    const mo = t.txn_date.slice(0, 7);
    monthly[mo] = (monthly[mo] || 0) + t.amount;
  }

  res.json({ byCategory, totalDebit, totalCredit, monthly });
});

// ── BENCHMARK — Nifty 50 / Sensex historical data ─────────────────
app.get("/api/benchmark", auth, async (req, res) => {
  const { period = "1Y", index = "NIFTY" } = req.query;
  const symbol = index === "SENSEX" ? "^BSESN" : "^NSEI";
  const ranges = { "1Y": "1y", "3Y": "3y", "5Y": "5y", "ALL": "10y" };
  const range = ranges[period] || "1y";
  try {
    const data = await yahooFetch(`/v8/finance/chart/${symbol}?interval=1mo&range=${range}`);
    const result = data?.chart?.result?.[0];
    if (!result) return res.json({ prices: [] });
    const timestamps = result.timestamp || [];
    const closes = result.indicators?.adjclose?.[0]?.adjclose || result.indicators?.quote?.[0]?.close || [];
    const prices = timestamps
      .map((ts, i) => ({ date: new Date(ts * 1000).toISOString().slice(0, 7), value: closes[i] }))
      .filter(p => p.value != null);
    res.json({ prices, symbol });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
