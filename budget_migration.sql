-- ── WealthLens Pro: Budget Module Migration ──────────────────────
-- Run in Supabase SQL Editor

-- Budget statements — one row per file upload
CREATE TABLE IF NOT EXISTS budget_statements (
  id            text PRIMARY KEY,
  user_id       text,
  source        text NOT NULL,          -- "HDFC Savings", "ICICI Credit Card", etc.
  statement_type text NOT NULL,          -- "BANK" | "CREDIT_CARD" | "UPI" | "OTHER"
  filename      text NOT NULL,
  file_size     integer,
  period_start  date,
  period_end    date,
  txn_count     integer DEFAULT 0,
  upload_date   timestamptz DEFAULT now(),
  notes         text DEFAULT ''
);

-- Budget transactions — parsed from statements
CREATE TABLE IF NOT EXISTS budget_transactions (
  id            text PRIMARY KEY,
  statement_id  text NOT NULL REFERENCES budget_statements(id) ON DELETE CASCADE,
  txn_date      date NOT NULL,
  description   text NOT NULL,           -- AES-256 encrypted
  amount        numeric NOT NULL,
  txn_type      text NOT NULL,           -- "DEBIT" | "CREDIT"
  category      text NOT NULL DEFAULT 'Uncategorised',
  raw_desc      text,                    -- encrypted original description
  balance       numeric,                 -- AES-256 encrypted
  ref_number    text,
  created_at    timestamptz DEFAULT now()
);

-- Budget categories — family-defined spending buckets
CREATE TABLE IF NOT EXISTS budget_categories (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  color         text DEFAULT '#c9a84c',
  icon          text DEFAULT '📁',
  monthly_limit numeric DEFAULT 0,
  keywords      text DEFAULT ''          -- comma-separated auto-match keywords
);

-- Disable RLS for simplicity (single-family app)
ALTER TABLE budget_statements  DISABLE ROW LEVEL SECURITY;
ALTER TABLE budget_transactions DISABLE ROW LEVEL SECURITY;
ALTER TABLE budget_categories  DISABLE ROW LEVEL SECURITY;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_budget_txns_statement ON budget_transactions(statement_id);
CREATE INDEX IF NOT EXISTS idx_budget_txns_date ON budget_transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_budget_txns_category ON budget_transactions(category);

-- Auto-expire statements older than 1 year (run as a scheduled function or cron)
-- DELETE FROM budget_statements WHERE upload_date < now() - interval '1 year';

-- Seed default categories
INSERT INTO budget_categories (id, name, color, icon, monthly_limit, keywords) VALUES
  ('cat_food',      'Food & Dining',      '#e07c5a', '🍽️',  15000, 'swiggy,zomato,restaurant,cafe,hotel,dining,food,pizza,burger'),
  ('cat_grocery',   'Groceries',          '#4caf9a', '🛒',  12000, 'bigbasket,blinkit,dmart,reliance fresh,more,grocery,supermarket,vegetables'),
  ('cat_transport', 'Transport',          '#5a9ce0', '🚗',  8000,  'uber,ola,rapido,metro,fuel,petrol,diesel,parking,fastag,toll'),
  ('cat_shopping',  'Shopping',           '#a084ca', '🛍️',  10000, 'amazon,flipkart,myntra,meesho,nykaa,ajio,mall,store'),
  ('cat_health',    'Health & Medical',   '#4caf9a', '🏥',  5000,  'pharmacy,hospital,clinic,doctor,medicine,apollo,medplus,netmeds'),
  ('cat_utility',   'Bills & Utilities',  '#c9a84c', '💡',  6000,  'electricity,water,gas,broadband,jio,airtel,bsnl,vi,tata,recharge'),
  ('cat_emi',       'EMIs & Loans',       '#e07c5a', '🏦',  0,     'emi,loan,housing,home loan,car loan,personal loan,hdfc,icici,sbi,axis'),
  ('cat_entertain', 'Entertainment',      '#f0a050', '🎬',  3000,  'netflix,amazon prime,hotstar,spotify,bookmyshow,inox,pvr,movie'),
  ('cat_travel',    'Travel',             '#5a9ce0', '✈️',  0,     'irctc,indigo,air india,spicejet,hotel,oyo,makemytrip,yatra,booking'),
  ('cat_education', 'Education',          '#a084ca', '📚',  0,     'school,college,course,udemy,coursera,byju,unacademy,tuition'),
  ('cat_invest',    'Investments',        '#c9a84c', '📈',  0,     'mutual fund,sip,zerodha,groww,upstox,stock,nse,bse,mf'),
  ('cat_transfer',  'Transfers',          '#6b6356', '↔️',  0,     'neft,rtgs,imps,upi,transfer,self transfer,own account'),
  ('cat_other',     'Other',              '#6b6356', '📦',  0,     '')
ON CONFLICT (id) DO NOTHING;
