-- Database-level acceptance tests for Release 1. Run with:
--   psql -d js2 -v ON_ERROR_STOP=1 -f test/sql/release1.sql
-- Every block ends in an ASSERT; the script fails loudly on the first miss.

begin;

-- ---- seed Fortville ------------------------------------------------------
insert into public.entities (name) values ('Peru Smoke Shop LLC');
insert into public.stores (entity_id, name, address, city, state, zip, nrs_terminal_id)
values (1, 'Fortville', '325 W Broadway St Suite B', 'Fortville', 'IN', '46040', '60230');
insert into public.bank_accounts (entity_id, bank, nickname, last4) values (1, 'first_merchants', 'First Merchants …1551', '1551');

insert into public.profiles (id, full_name, role) values
  ('00000000-0000-0000-0000-000000000001', 'Sam (owner)', 'owner'),
  ('00000000-0000-0000-0000-000000000002', 'Chelsea', 'manager'),
  ('00000000-0000-0000-0000-000000000003', 'Jessi', 'employee');
insert into public.user_stores (user_id, store_id, can_close, can_collect, can_deposit, can_verify, can_view_bank) values
  ('00000000-0000-0000-0000-000000000002', 1, true, true, true, true, false),
  ('00000000-0000-0000-0000-000000000003', 1, true, false, false, false, false);

-- accounts with opening cutoff 2026-10-16 23:59 (pilot starts 10/17)
insert into public.accounts (code, kind, store_id, owner_entity_id, custodian, bank_account_id, opening_at, opening_balance_cents) values
  ('drawer:fortville',        'drawer',        1, 1, 'store',     null, '2026-10-16 23:59-04', 25000),
  ('safe:fortville',          'safe',          1, 1, 'store',     null, '2026-10-16 23:59-04', 0),
  ('collected:chelsea:fortville','collected',  1, 1, 'chelsea',   null, '2026-10-16 23:59-04', 0),
  ('in_transit:fortville',    'in_transit',    1, 1, 'slip',      null, '2026-10-16 23:59-04', 0),
  ('card_clearing:fortville', 'card_clearing', 1, 1, 'processor', null, '2026-10-16 23:59-04', 180000),
  ('variance:fortville',      'variance',      1, 1, null,        null, '2026-10-16 23:59-04', 0),
  ('loyalty:fortville',       'loyalty',       1, 1, null,        null, null, 0),
  ('rounding:fortville',      'rounding',      1, 1, null,        null, null, 0),
  ('bank:first_merchants',    'bank',       null, 1, 'bank',      1,    null, 0),
  ('external:customers',      'external',   null, null, null,     null, null, 0),
  ('external:vendors',        'external',   null, null, null,     null, null, 0),
  ('external:fees',           'external',   null, null, null,     null, null, 0);

create temp table acct as select code, id from public.accounts;
create or replace function pg_temp.a(c text) returns bigint language sql as $$ select id from acct where code = c $$;

-- ---- C-6 opening cutoff: a move dated before opening_at is rejected ------
do $$
begin
  insert into public.money_moves (kind, from_account_id, to_account_id, amount_cents, event_at, business_date, store_id, created_by)
  values ('cash_sale', pg_temp.a('external:customers'), pg_temp.a('drawer:fortville'), 100, '2026-10-16 20:00-04', '2026-10-16', 1, '00000000-0000-0000-0000-000000000003');
  raise exception 'C-6 FAILED: move before cutoff was accepted';
exception when others then
  if sqlerrm not like 'before_cutoff%' then raise; end if;
end $$;
do $$ begin assert (select count(*) from public.money_moves) = 0, 'C-6: no moves expected'; end $$;

-- ---- the real 10/17 close (figures from the NRS Store Report) -----------
insert into public.daily_closes (store_id, business_date, submitted_by, register_closed_at,
  net_sales_cents, sales_tax_cents, payments_total_cents, cash_drops_cents, counted_drawer_cents, expected_drawer_cents, tenders)
values (1, '2026-10-17', '00000000-0000-0000-0000-000000000003', '2026-10-17 22:01-04',
  340894, 23865, 364759, 86985, 25045, 25045,
  '[{"label":"Cash","amount_cents":87030,"field":"net_cash_receipts"},
    {"label":"Credit/Debit (Net)","amount_cents":267981,"field":"net_card_receipts"},
    {"label":"Pay with Points","amount_cents":9750,"field":"loyalty_redemption"},
    {"label":"Cash Rounding","amount_cents":-2,"field":"cash_rounding"}]');

insert into public.money_moves (kind, from_account_id, to_account_id, amount_cents, event_at, business_date, store_id, close_id, created_by) values
  ('cash_sale',  pg_temp.a('external:customers'), pg_temp.a('drawer:fortville'),        87030,  '2026-10-17 22:01-04', '2026-10-17', 1, 1, '00000000-0000-0000-0000-000000000003'),
  ('card_sale',  pg_temp.a('external:customers'), pg_temp.a('card_clearing:fortville'), 267981, '2026-10-17 22:01-04', '2026-10-17', 1, 1, '00000000-0000-0000-0000-000000000003'),
  ('loyalty_redemption', pg_temp.a('loyalty:fortville'), pg_temp.a('external:customers'), 9750, '2026-10-17 22:01-04', '2026-10-17', 1, 1, '00000000-0000-0000-0000-000000000003'),
  ('cash_rounding', pg_temp.a('drawer:fortville'), pg_temp.a('rounding:fortville'),    2,      '2026-10-17 22:01-04', '2026-10-17', 1, 1, '00000000-0000-0000-0000-000000000003');
-- the two NRS-recorded drops (shift report): Jessi 523.30, Rylie 346.55
insert into public.money_moves (kind, from_account_id, to_account_id, amount_cents, event_at, business_date, store_id, created_by) values
  ('cash_drop', pg_temp.a('drawer:fortville'), pg_temp.a('safe:fortville'), 52330, '2026-10-17 13:57-04', '2026-10-17', 1, '00000000-0000-0000-0000-000000000003'),
  ('cash_drop', pg_temp.a('drawer:fortville'), pg_temp.a('safe:fortville'), 34655, '2026-10-17 22:01-04', '2026-10-17', 1, '00000000-0000-0000-0000-000000000003');

-- C-3/C-7: expected drawer = float 250.00 + 870.30 − 0.02 − 869.85 = 250.43 ; counted 250.45 → over 0.02
do $$ begin
  assert (select balance_cents from public.account_balances where code='drawer:fortville') = 25043,
    format('drawer expected 25043, got %s', (select balance_cents from public.account_balances where code='drawer:fortville'));
  assert (select balance_cents from public.account_balances where code='safe:fortville') = 86985, 'safe should hold the two drops';
  assert (select balance_cents from public.account_balances where code='card_clearing:fortville') = 180000 + 267981, 'C-8 clearing = opening + day card';
end $$;
insert into public.money_moves (kind, from_account_id, to_account_id, amount_cents, event_at, business_date, store_id, close_id, created_by)
values ('drawer_over', pg_temp.a('variance:fortville'), pg_temp.a('drawer:fortville'), 2, '2026-10-17 22:01-04', '2026-10-17', 1, 1, '00000000-0000-0000-0000-000000000003');
do $$ begin assert (select balance_cents from public.account_balances where code='drawer:fortville') = 25045, 'drawer = counted after variance post'; end $$;

-- ---- append-only ---------------------------------------------------------
do $$
begin
  update public.money_moves set amount_cents = 1 where kind = 'cash_sale';
  raise exception 'append-only FAILED: update went through';
exception when others then
  if sqlerrm not like 'money_moves is append-only%' then raise; end if;
end $$;

-- ---- C-4 collection with $5 short: expected safe 869.85, counted 864.85 --
insert into public.money_moves (kind, from_account_id, to_account_id, amount_cents, event_at, business_date, store_id, created_by) values
  ('cash_collect', pg_temp.a('safe:fortville'), pg_temp.a('collected:chelsea:fortville'), 86485, '2026-10-18 10:00-04', '2026-10-18', 1, '00000000-0000-0000-0000-000000000002'),
  ('safe_short',   pg_temp.a('safe:fortville'), pg_temp.a('variance:fortville'),            500, '2026-10-18 10:00-04', '2026-10-18', 1, '00000000-0000-0000-0000-000000000002');
do $$ begin
  assert (select balance_cents from public.account_balances where code='safe:fortville') = 0, 'C-4 safe back to 0';
  assert (select balance_cents from public.account_balances where code='collected:chelsea:fortville') = 86485, 'C-4 collected';
  assert (select balance_cents from public.account_balances where code='variance:fortville') = 500 - 2, 'C-4 variance shows the $5 short net of the 2c over';
end $$;

-- ---- C-5 deposit then clear ---------------------------------------------
insert into public.money_moves (kind, from_account_id, to_account_id, amount_cents, event_at, business_date, store_id, created_by)
values ('cash_deposit', pg_temp.a('collected:chelsea:fortville'), pg_temp.a('in_transit:fortville'), 86485, '2026-10-18 11:00-04', '2026-10-18', 1, '00000000-0000-0000-0000-000000000002');
insert into public.deposits (store_id, bank_account_id, move_id, amount_cents, deposited_at, created_by)
values (1, 1, currval('public.money_moves_id_seq'), 86485, '2026-10-18 11:00-04', '00000000-0000-0000-0000-000000000002');
insert into public.import_batches (source, bank_account_id, file_hash, coverage_start, coverage_end, uploaded_by)
values ('bank_statement', 1, 'abc', '2026-10-01', '2026-10-31', '00000000-0000-0000-0000-000000000001');
insert into public.bank_lines (bank_account_id, batch_id, source_id, posted_date, description, amount_cents, kind)
values (1, 1, 'first_merchants|2026-10-19|DEPOSIT|86485|1', '2026-10-19', 'DEPOSIT', 86485, 'cash_deposit');
insert into public.money_moves (kind, from_account_id, to_account_id, amount_cents, event_at, business_date, store_id, created_by)
values ('deposit_cleared', pg_temp.a('in_transit:fortville'), pg_temp.a('bank:first_merchants'), 86485, '2026-10-19 09:00-04', '2026-10-19', 1, '00000000-0000-0000-0000-000000000001');
update public.deposits set status='cleared', cleared_move_id=currval('public.money_moves_id_seq'), cleared_bank_line_id=1,
  cleared_by='00000000-0000-0000-0000-000000000001', cleared_at=now() where id=1;
do $$ begin
  assert (select balance_cents from public.account_balances where code='in_transit:fortville') = 0, 'C-5 in_transit cleared';
  assert (select status from public.deposits where id=1) = 'cleared', 'C-5 deposit cleared';
end $$;

-- ---- C-10 reversal exactness: the 2c "over" was wrong → counted = expected
do $$
declare before_cnt int; rev bigint;
begin
  select count(*) into before_cnt from public.money_moves;
  -- a revision that replaces nothing: only the variance move should flip... but revise_close
  -- reverses ALL close-derived moves, so we pass the sale/card/loyalty/rounding back as replacements.
  rev := public.revise_close('rev-c10', 1, 'variance entered wrong', '00000000-0000-0000-0000-000000000002',
    jsonb_build_array(
      jsonb_build_object('kind','cash_sale','from_account_id',pg_temp.a('external:customers'),'to_account_id',pg_temp.a('drawer:fortville'),'amount_cents',87030,'event_at','2026-10-17 22:01-04'),
      jsonb_build_object('kind','card_sale','from_account_id',pg_temp.a('external:customers'),'to_account_id',pg_temp.a('card_clearing:fortville'),'amount_cents',267981,'event_at','2026-10-17 22:01-04'),
      jsonb_build_object('kind','loyalty_redemption','from_account_id',pg_temp.a('loyalty:fortville'),'to_account_id',pg_temp.a('external:customers'),'amount_cents',9750,'event_at','2026-10-17 22:01-04'),
      jsonb_build_object('kind','cash_rounding','from_account_id',pg_temp.a('drawer:fortville'),'to_account_id',pg_temp.a('rounding:fortville'),'amount_cents',2,'event_at','2026-10-17 22:01-04')
    ));
  -- 5 close-derived moves reversed + 4 replacements = 9 new rows
  assert (select count(*) from public.money_moves) = before_cnt + 9, 'C-10: expected 9 new rows';
  assert (select balance_cents from public.account_balances where code='drawer:fortville') = 25043, 'C-10 drawer back to expected (no variance)';
  assert (select balance_cents from public.account_balances where code='variance:fortville') = 500, 'C-10 variance only the safe short remains';
  -- C-11: drops, collection, deposit untouched
  assert (select count(*) from public.money_moves where kind='reversal' and reverses_move_id in
            (select id from public.money_moves where kind in ('cash_drop','cash_collect','safe_short','cash_deposit','deposit_cleared'))) = 0,
         'C-11: non-close moves must never be reversed by a close revision';
  assert (select revision_no from public.daily_closes where id=1) = 2, 'revision_no bumped';
  -- C-12: retry with the same key returns the same revision and adds nothing
  assert public.revise_close('rev-c10', 1, 'retry', '00000000-0000-0000-0000-000000000002', '[]'::jsonb) = rev, 'C-12 same revision id';
  assert (select count(*) from public.money_moves) = before_cnt + 9, 'C-12: retry added no moves';
end $$;

-- ---- C-16 entity + custody: Lebanon cash in Chelsea's bag is a different account
insert into public.entities (name) values ('Lebanon Tobacco Hub LLC');
insert into public.stores (entity_id, name) values (2, 'Lebanon');
insert into public.accounts (code, kind, store_id, owner_entity_id, custodian) values
  ('safe:lebanon','safe',2,2,'store'), ('collected:chelsea:lebanon','collected',2,2,'chelsea');
insert into public.user_stores (user_id, store_id, can_close, can_collect, can_deposit, can_verify) values
  ('00000000-0000-0000-0000-000000000002', 2, true, true, true, true);
insert into public.money_moves (kind, from_account_id, to_account_id, amount_cents, event_at, business_date, store_id, created_by)
values ('opening', pg_temp.a('external:customers'), (select id from public.accounts where code='safe:lebanon'), 30000, '2026-10-18 09:00-04', '2026-10-18', 2, '00000000-0000-0000-0000-000000000001');
insert into public.money_moves (kind, from_account_id, to_account_id, amount_cents, event_at, business_date, store_id, created_by)
values ('cash_collect', (select id from public.accounts where code='safe:lebanon'), (select id from public.accounts where code='collected:chelsea:lebanon'), 30000, '2026-10-18 12:00-04', '2026-10-18', 2, '00000000-0000-0000-0000-000000000002');
do $$ begin
  assert (select balance_cents from public.account_balances where code='collected:chelsea:fortville') = 0, 'C-16 Fortville sub-balance unaffected';
  assert (select balance_cents from public.account_balances where code='collected:chelsea:lebanon') = 30000, 'C-16 Lebanon sub-balance';
end $$;

-- ---- C-17 access as Jessi (employee) via RLS ----------------------------
do $$ begin if not exists (select 1 from pg_roles where rolname='app_user') then create role app_user nologin; end if; end $$;
grant usage on schema public to app_user;
grant select, insert, update on all tables in schema public to app_user;
grant select on public.account_balances to app_user;
grant usage on all sequences in schema public to app_user;
set role app_user;
set local app.uid = '00000000-0000-0000-0000-000000000003';
do $$ begin
  assert (select count(*) from public.bank_accounts) = 0, 'C-17 employee sees no bank accounts';
  assert (select count(*) from public.bank_snapshots) = 0, 'C-17 employee sees no bank snapshots';
  assert (select count(*) from public.bank_lines) = 0, 'C-17 employee sees no bank lines';
  assert (select count(*) from public.deposits) = 0, 'C-17 employee sees no deposits';
  assert (select count(*) from public.money_moves where kind in ('cash_collect','safe_short','cash_deposit','deposit_cleared')) = 0, 'C-17 employee sees no collection/deposit moves';
  assert (select count(*) from public.money_moves where kind='cash_drop') = 2, 'employee sees drops at her store';
  assert (select count(*) from public.stores) = 1, 'C-17 employee sees only Fortville';
  assert (select count(*) from public.accounts where kind='bank') = 0, 'C-17 employee sees no bank account rows';
end $$;
-- employee cannot insert a collection
do $$
begin
  insert into public.money_moves (kind, from_account_id, to_account_id, amount_cents, event_at, business_date, store_id, created_by)
  values ('cash_collect', pg_temp.a('safe:fortville'), pg_temp.a('collected:chelsea:fortville'), 1, now(), current_date, 1, '00000000-0000-0000-0000-000000000003');
  raise exception 'C-17 FAILED: employee inserted a collection';
exception when insufficient_privilege or others then
  if sqlerrm like 'C-17 FAILED%' then raise; end if;
end $$;
-- Chelsea without can_view_bank: no bank, but sees deposits and collections
set local app.uid = '00000000-0000-0000-0000-000000000002';
do $$ begin
  assert (select count(*) from public.bank_accounts) = 1, 'manager with can_deposit sees the bank NAME';
  assert (select count(*) from public.bank_snapshots) = 0, 'C-9/D3 manager without can_view_bank sees no balances';
  assert (select count(*) from public.bank_lines) = 0, 'C-9/D3 manager without can_view_bank sees no bank lines';
  assert (select count(*) from public.deposits) = 1, 'manager sees deposits';
  assert (select count(*) from public.stores) = 2, 'manager sees both her stores';
end $$;
-- RLS must never silently drop a legitimate write (the e2e walkthrough caught this once)
set local app.uid = '00000000-0000-0000-0000-000000000001';
do $$
declare n int;
begin
  update public.accounts set opening_balance_cents = 180000 where code = 'card_clearing:fortville';
  get diagnostics n = row_count;
  assert n = 1, 'owner update on accounts must affect 1 row under RLS';
end $$;
set local app.uid = '00000000-0000-0000-0000-000000000002';
do $$
declare n int;
begin
  insert into public.close_exceptions (close_id, code, detail) values (1, 'drawer_variance', '{}');
  update public.close_exceptions set resolved_at = now() where close_id = 1 and resolved_at is null;
  get diagnostics n = row_count;
  assert n = 1, 'manager must be able to resolve exceptions under RLS';
end $$;
reset role;

select 'ALL SQL ACCEPTANCE TESTS PASSED' as result;
rollback;
