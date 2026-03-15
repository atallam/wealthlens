-- ─────────────────────────────────────────────────────────────────
-- WealthLens Pro — Supabase Database Schema
-- Run this entire file in: Supabase Dashboard → SQL Editor → Run
-- ─────────────────────────────────────────────────────────────────

-- Portfolio config: family members, goals, alerts (stored as JSON arrays)
create table if not exists portfolio (
  id        text primary key default 'family',
  members   jsonb not null default '[]',
  goals     jsonb not null default '[]',
  alerts    jsonb not null default '[]',
  updated_at  timestamptz default now(),
  updated_by  text
);

-- Holdings: one row per investment, proper columns for price tracking
create table if not exists holdings (
  id              text primary key,
  member_id       text not null,
  type            text not null,
  name            text not null,
  ticker          text,
  scheme_code     text,
  units           numeric,
  purchase_price  numeric,
  current_price   numeric,
  purchase_nav    numeric,
  current_nav     numeric,
  principal       numeric,
  interest_rate   numeric,
  start_date      date,
  maturity_date   date,
  purchase_value  numeric,
  current_value   numeric,
  usd_inr_rate    numeric default 83.2,
  price_fetched_at timestamptz,
  created_at      timestamptz default now()
);

-- Artifacts: files attached to holdings (contract notes, statements, receipts)
create table if not exists artifacts (
  id            text primary key,
  holding_id    text not null references holdings(id) on delete cascade,
  file_name     text not null,
  storage_path  text not null,
  file_type     text,
  file_size     integer,
  description   text default '',
  uploaded_at   timestamptz default now()
);

-- ── Storage bucket ──────────────────────────────────────────
-- Run this in Supabase → Storage → New Bucket
-- Name: artifacts
-- Public: NO (private bucket)
-- Or run via SQL:
insert into storage.buckets (id, name, public)
values ('artifacts', 'artifacts', false)
on conflict (id) do nothing;

-- ── Disable RLS (family app — all authenticated users share data) ──
alter table portfolio disable row level security;
alter table holdings  disable row level security;
alter table artifacts disable row level security;
