import express from "express";
import multer  from "multer";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

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

// ── HOLDINGS ─────────────────────────────────────────────────────
app.get("/api/holdings", auth, async (req, res) => {
  const { data, error } = await supabase
    .from("holdings")
    .select("*, artifacts(id,file_name,file_type,file_size,description,uploaded_at)")
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post("/api/holdings", auth, async (req, res) => {
  const { error } = await supabase.from("holdings").insert(req.body);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.put("/api/holdings/:id", auth, async (req, res) => {
  const { error } = await supabase.from("holdings").update(req.body).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete("/api/holdings/:id", auth, async (req, res) => {
  const { error } = await supabase.from("holdings").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── REAL-TIME PRICE FETCHING ──────────────────────────────────────
// Yahoo Finance (server-side to bypass CORS)
async function yahooPrice(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    const json = await res.json();
    return json?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
  } catch { return null; }
}

// AMFI MF NAV (free, no key needed)
async function mfNav(schemeCode) {
  try {
    const res = await fetch(`https://api.mfapi.in/mf/${schemeCode}`);
    const json = await res.json();
    const nav = parseFloat(json?.data?.[0]?.nav);
    return isNaN(nav) ? null : nav;
  } catch { return null; }
}

app.post("/api/prices/refresh", auth, async (req, res) => {
  const { data: holdings } = await supabase
    .from("holdings")
    .select("id, type, ticker, scheme_code, usd_inr_rate");

  if (!holdings?.length) return res.json({ updated: 0 });

  // Fetch USD/INR rate once for all US stocks
  const usdInr = await yahooPrice("USDINR=X") || 83.2;

  const updates = [];
  for (const h of holdings) {
    let patch = null;
    if (h.type === "MF" && h.scheme_code) {
      const nav = await mfNav(h.scheme_code);
      if (nav) patch = { current_nav: nav, price_fetched_at: new Date().toISOString() };
    } else if (h.type === "IN_STOCK" && h.ticker) {
      const price = await yahooPrice(`${h.ticker.toUpperCase()}.NS`);
      if (price) patch = { current_price: price, price_fetched_at: new Date().toISOString() };
    } else if (h.type === "US_STOCK" && h.ticker) {
      const price = await yahooPrice(h.ticker.toUpperCase());
      if (price) patch = { current_price: price, usd_inr_rate: usdInr, price_fetched_at: new Date().toISOString() };
    }
    if (patch) {
      await supabase.from("holdings").update(patch).eq("id", h.id);
      updates.push({ id: h.id, ...patch });
    }
  }
  res.json({ updated: updates.length, usdInr, results: updates });
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

app.listen(PORT, () => {
  console.log(`✅  WealthLens Pro running on port ${PORT}`);
  console.log(`📊  Real-time price fetching: Yahoo Finance + MFAPI`);
  console.log(`🔐  Google Auth via Supabase`);
  console.log(`💾  Postgres DB + file storage via Supabase`);
});
