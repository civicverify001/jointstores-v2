-- Fortville pilot seed. Safe to run once on a fresh database.
-- PINs here are for the LOCAL PREVIEW ONLY and must be replaced before any real use.

-- local app role (Supabase has `authenticated` already; this mirrors it)
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user nologin;
  end if;
end $$;
-- the connecting role (postgres on Supabase) must be able to SET ROLE app_user
do $$ begin execute format('grant app_user to %I', current_user); end $$;
grant usage on schema public, private to app_user;
grant select, insert, update on all tables in schema public to app_user;
grant select on public.account_balances to app_user;
grant usage on all sequences in schema public to app_user;
grant execute on function public.revise_close(text, bigint, text, uuid, jsonb) to app_user;

insert into public.entities (name) values ('Peru Smoke Shop LLC'), ('Lebanon Tobacco Hub LLC');

insert into public.stores (entity_id, name, address, city, state, zip, nrs_terminal_id, drawer_float_cents)
values ((select id from public.entities where name='Peru Smoke Shop LLC'),
        'Fortville', '325 W Broadway St Suite B', 'Fortville', 'IN', '46040', '60230', 25000);

insert into public.bank_accounts (entity_id, bank, nickname, last4, shared)
values ((select id from public.entities where name='Peru Smoke Shop LLC'), 'first_merchants', 'First Merchants …1551', '1551', true);

-- people (pin_hash = scrypt, set by the app's `npm run set-pin`; preview values below)
insert into public.profiles (id, full_name, role) values
  ('11111111-1111-1111-1111-111111111111', 'Sam',     'owner'),
  ('22222222-2222-2222-2222-222222222222', 'Chelsea', 'manager'),
  ('33333333-3333-3333-3333-333333333333', 'Jessi',   'employee'),
  ('44444444-4444-4444-4444-444444444444', 'Rylie',   'employee');

insert into public.user_stores (user_id, store_id, can_close, can_collect, can_deposit, can_verify, can_view_bank)
select p.id, s.id,
       true,
       p.role = 'manager', p.role = 'manager', p.role = 'manager',
       false
from public.profiles p cross join public.stores s where p.role <> 'owner';

-- ledger accounts (opening_at is set by the owner on cutoff night via Cash Position → "Set opening")
with e as (select id from public.entities where name='Peru Smoke Shop LLC'),
     s as (select id from public.stores where name='Fortville'),
     b as (select id from public.bank_accounts where last4='1551')
insert into public.accounts (code, kind, store_id, owner_entity_id, custodian, bank_account_id, opening_balance_cents)
select * from (values
  ('drawer:fortville',            'drawer',        (select id from s), (select id from e), 'store',     null::bigint, 25000),
  ('safe:fortville',              'safe',          (select id from s), (select id from e), 'store',     null, 0),
  ('collected:chelsea:fortville', 'collected',     (select id from s), (select id from e), 'chelsea',   null, 0),
  ('in_transit:fortville',        'in_transit',    (select id from s), (select id from e), 'slip',      null, 0),
  ('card_clearing:fortville',     'card_clearing', (select id from s), (select id from e), 'processor', null, 0),
  ('variance:fortville',          'variance',      (select id from s), (select id from e), null,        null, 0),
  ('loyalty:fortville',           'loyalty',       (select id from s), (select id from e), null,        null, 0),
  ('rounding:fortville',          'rounding',      (select id from s), (select id from e), null,        null, 0),
  ('bank:first_merchants',        'bank',          null,               (select id from e), 'bank',      (select id from b), 0),
  ('external:customers',          'external',      null, null, null, null, 0),
  ('external:vendors',            'external',      null, null, null, null, 0),
  ('external:fees',               'external',      null, null, null, null, 0)
) v(code, kind, store_id, owner_entity_id, custodian, bank_account_id, opening_balance_cents);

-- tender map from the real 10/17/2026 Store Report (B.1)
insert into public.tender_map (store_id, nrs_label, field, active_from)
select s.id, v.label, v.field, '2026-10-01' from public.stores s, (values
  ('Cash','net_cash_receipts'), ('Credit/Debit (Net)','net_card_receipts'), ('Check','check_receipts'),
  ('EBT SNAP','ebt_receipts'), ('EBT CASH','ebt_receipts'), ('Pay with Points','loyalty_redemption'),
  ('Cash Rounding','cash_rounding')) v(label, field)
where s.name='Fortville';

-- recurring bills seen on the September statement (H.2) — amounts are last-seen, owner edits
insert into public.recurring_bills (store_id, payee, amount_cents, due_day, cadence, category, related_party)
select s.id, v.payee, v.amt, v.day, 'monthly', v.cat, v.rp from public.stores s, (values
  ('325 Holdings LLC (rent)',        228651, 1,  'rent',        false),
  ('NRS subscription',                 5345, 2,  'software',    false),
  ('NRS Pay merchant fees (approx)', 216355, 2,  'card_fees',   false),
  ('Duke Energy',                     23287, 8,  'utilities',   false),
  ('Hancock Rural Telephone',         23053, 24, 'utilities',   false),
  ('Rajmane CPA',                     21000, 1,  'professional',false),
  ('Chelsea pay (1st)',                   0, 1,  'payroll',     false),
  ('Chelsea pay (15th)',                  0, 15, 'payroll',     false)
) v(payee, amt, day, cat, rp) where s.name='Fortville';
