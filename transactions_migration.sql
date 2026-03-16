-- ─────────────────────────────────────────────────────────────────
-- WealthLens — Transactions Table Migration
-- Run this in Supabase → SQL Editor → Run
-- ─────────────────────────────────────────────────────────────────

create table if not exists transactions (
  id          text primary key,
  holding_id  text not null references holdings(id) on delete cascade,
  txn_type    text not null default 'BUY',   -- BUY or SELL
  units       numeric not null,
  price       numeric not null,              -- price per unit at time of txn
  txn_date    date not null,
  notes       text default '',
  created_at  timestamptz default now()
);

-- Disable RLS (family app)
alter table transactions disable row level security;

-- Index for fast lookups by holding
create index if not exists transactions_holding_id_idx on transactions(holding_id);
