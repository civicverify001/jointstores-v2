-- JointStores v2 — Release 1 (Fortville pilot)
-- Money & custody ledger. Isolated project; nothing here touches the old app.
--
-- Conventions
--   * money is bigint CENTS, never numeric/float
--   * timestamps are timestamptz; business_date is a DATE in the store's zone
--   * money_moves is APPEND-ONLY: corrections are reversal + replacement (B.5)
--   * every imported row carries a stable source_id so re-imports are no-ops (B.6)
--   * RLS on every table; helpers live in schema `private` (not exposed)

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Reference: entities, stores, banks, people
-- ---------------------------------------------------------------------------

create table public.entities (
  id          bigint generated always as identity primary key,
  name        text not null unique,                 -- "Peru Smoke Shop LLC"
  created_at  timestamptz not null default now()
);

create table public.stores (
  id               bigint generated always as identity primary key,
  entity_id        bigint not null references public.entities(id),
  name             text not null unique,            -- "Fortville"
  address          text,
  city             text,
  state            text,
  zip              text,
  nrs_terminal_id  text unique,                     -- "60230"
  timezone         text not null default 'America/Indiana/Indianapolis',
  drawer_float_cents bigint not null default 25000 check (drawer_float_cents >= 0),
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

create table public.bank_accounts (
  id          bigint generated always as identity primary key,
  entity_id   bigint not null references public.entities(id),
  bank        text not null check (bank in ('first_merchants','old_national')),
  nickname    text not null,                         -- "First Merchants …1551"
  last4       text check (last4 ~ '^[0-9]{4}$'),
  shared      boolean not null default true,         -- B.4: balance is snapshot-only
  created_at  timestamptz not null default now()
);

-- One row per app user (auth.users on Supabase; plain id locally)
create table public.profiles (
  id          uuid primary key,                      -- = auth.users.id
  full_name   text not null,
  role        text not null check (role in ('owner','manager','employee')),
  pin_hash    text,                                  -- store-phone PIN, verified server-side only
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.user_stores (
  user_id       uuid not null references public.profiles(id) on delete cascade,
  store_id      bigint not null references public.stores(id) on delete cascade,
  can_close     boolean not null default true,
  can_collect   boolean not null default false,      -- safe collection (Chelsea)
  can_deposit   boolean not null default false,
  can_verify    boolean not null default false,
  can_view_bank boolean not null default false,      -- D3
  primary key (user_id, store_id)
);
create index user_stores_store_idx on public.user_stores (store_id);

-- ---------------------------------------------------------------------------
-- Ledger accounts (B.2) — custody chain, with opening cutoff (B.3)
-- ---------------------------------------------------------------------------

create table public.accounts (
  id               bigint generated always as identity primary key,
  code             text not null unique,            -- "drawer:fortville"
  kind             text not null check (kind in (
                     'drawer','safe','collected','in_transit','card_clearing',
                     'bank','variance','loyalty','rounding','external')),
  store_id         bigint references public.stores(id),
  owner_entity_id  bigint references public.entities(id),
  custodian        text,                             -- "store", "chelsea", "processor", "bank"
  bank_account_id  bigint references public.bank_accounts(id),
  opening_at       timestamptz,                      -- B.3: moves at/before this do not post
  opening_balance_cents bigint not null default 0,
  opening_counted_by uuid references public.profiles(id),
  created_at       timestamptz not null default now(),
  check (kind <> 'bank' or bank_account_id is not null)
);
create index accounts_store_idx on public.accounts (store_id);

-- ---------------------------------------------------------------------------
-- Daily closes
-- ---------------------------------------------------------------------------

create table public.daily_closes (
  id               bigint generated always as identity primary key,
  store_id         bigint not null references public.stores(id),
  business_date    date not null,
  status           text not null default 'submitted'
                   check (status in ('submitted','verified','rejected')),
  revision_no      integer not null default 1,
  submitted_by     uuid not null references public.profiles(id),
  submitted_at     timestamptz not null default now(),
  register_closed_at timestamptz,                    -- from NRS shift report when known
  verified_by      uuid references public.profiles(id),
  verified_at      timestamptz,
  -- figures as read from the NRS Store Report (cents)
  net_sales_cents        bigint not null default 0,
  sales_tax_cents        bigint not null default 0,
  payments_total_cents   bigint not null default 0,
  tenders               jsonb not null default '[]'::jsonb,  -- [{label,tier,amount_cents,field}]
  cash_drops_cents       bigint not null default 0,   -- as printed; informational (drops are their own moves)
  vendor_payouts         jsonb not null default '[]'::jsonb, -- [{amount_cents,reason}]
  refunds_cents          bigint not null default 0,
  counters               jsonb not null default '{}'::jsonb,
  -- drawer
  expected_drawer_cents  bigint,
  counted_drawer_cents   bigint,
  -- evidence + timing (C-18)
  z_report_path          text,
  seconds_entering       integer,
  seconds_verifying      integer,
  unique (store_id, business_date)
);
create index daily_closes_status_idx on public.daily_closes (store_id, status);

create table public.close_exceptions (
  id          bigint generated always as identity primary key,
  close_id    bigint not null references public.daily_closes(id) on delete cascade,
  code        text not null check (code in (
                'unmapped_tender','tender_mismatch','net_plus_tax','drawer_variance',
                'before_cutoff','dept_sum','csv_mismatch')),
  detail      jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);
create index close_exceptions_close_idx on public.close_exceptions (close_id) where resolved_at is null;

-- Tender map (B.1): per terminal, versioned, owner-edited
create table public.tender_map (
  id            bigint generated always as identity primary key,
  store_id      bigint not null references public.stores(id),
  nrs_label     text not null,                       -- verbatim, tiers folded
  field         text not null check (field in (
                  'net_cash_receipts','net_card_receipts','check_receipts',
                  'ebt_receipts','loyalty_redemption','cash_rounding')),
  active_from   date not null default current_date,
  active_to     date,
  unique (store_id, nrs_label, active_from)
);

-- ---------------------------------------------------------------------------
-- Revisions (B.5) — idempotent, atomic
-- ---------------------------------------------------------------------------

create table public.revisions (
  id               bigint generated always as identity primary key,
  idempotency_key  text not null unique,
  close_id         bigint references public.daily_closes(id),
  reason           text not null,
  created_by       uuid not null references public.profiles(id),
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- The ledger (append-only)
-- ---------------------------------------------------------------------------

create table public.money_moves (
  id               bigint generated always as identity primary key,
  kind             text not null check (kind in (
                     'cash_sale','card_sale','check_sale','ebt_sale',
                     'loyalty_redemption','cash_rounding',
                     'cash_paid_out','cash_drop','cash_collect','cash_deposit',
                     'deposit_cleared','card_settlement','card_fee',
                     'drawer_over','drawer_short','safe_over','safe_short',
                     'float_change','reversal','opening')),
  from_account_id  bigint not null references public.accounts(id),
  to_account_id    bigint not null references public.accounts(id),
  amount_cents     bigint not null check (amount_cents > 0),
  event_at         timestamptz not null,
  business_date    date not null,
  store_id         bigint references public.stores(id),
  close_id         bigint references public.daily_closes(id),
  revision_id      bigint references public.revisions(id),
  reverses_move_id bigint references public.money_moves(id),
  created_by       uuid references public.profiles(id),
  note             text,
  photo_path       text,
  meta             jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  check (from_account_id <> to_account_id),
  check (kind <> 'reversal' or reverses_move_id is not null)
);
create index money_moves_from_idx on public.money_moves (from_account_id, event_at);
create index money_moves_to_idx   on public.money_moves (to_account_id, event_at);
create index money_moves_close_idx on public.money_moves (close_id) where close_id is not null;
create index money_moves_store_date_idx on public.money_moves (store_id, business_date);
create unique index money_moves_reversal_once on public.money_moves (reverses_move_id) where reverses_move_id is not null;

-- Append-only: no UPDATE/DELETE from any app role.
create or replace function private.deny_change() returns trigger
language plpgsql as $$
begin
  raise exception 'money_moves is append-only; use a reversal (B.5)';
end $$;
create trigger money_moves_no_update before update or delete on public.money_moves
  for each row execute function private.deny_change();

-- Opening cutoff (B.3): a move that touches an account at/before its opening_at is rejected.
create or replace function private.enforce_cutoff() returns trigger
language plpgsql as $$
declare oa timestamptz;
begin
  select max(opening_at) into oa from public.accounts
   where id in (new.from_account_id, new.to_account_id) and opening_at is not null;
  if oa is not null and new.event_at <= oa and new.kind <> 'opening' then
    raise exception 'before_cutoff: event_at % is not after opening_at %', new.event_at, oa
      using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger money_moves_cutoff before insert on public.money_moves
  for each row execute function private.enforce_cutoff();

-- Balances: opening + in − out, only for moves after opening_at
create view public.account_balances as
select a.id as account_id, a.code, a.kind, a.store_id, a.owner_entity_id,
       a.opening_balance_cents
       + coalesce((select sum(m.amount_cents) from public.money_moves m
                   where m.to_account_id = a.id
                     and (a.opening_at is null or m.event_at > a.opening_at)), 0)
       - coalesce((select sum(m.amount_cents) from public.money_moves m
                   where m.from_account_id = a.id
                     and (a.opening_at is null or m.event_at > a.opening_at)), 0)
       as balance_cents
from public.accounts a;

-- ---------------------------------------------------------------------------
-- Deposits, bank lines, snapshots (B.4)
-- ---------------------------------------------------------------------------

create table public.deposits (
  id               bigint generated always as identity primary key,
  store_id         bigint not null references public.stores(id),
  bank_account_id  bigint not null references public.bank_accounts(id),
  move_id          bigint not null references public.money_moves(id),  -- cash_deposit move
  amount_cents     bigint not null check (amount_cents > 0),
  deposited_at     timestamptz not null,
  slip_path        text,
  status           text not null default 'in_transit' check (status in ('in_transit','cleared','voided')),
  cleared_move_id  bigint references public.money_moves(id),
  cleared_bank_line_id bigint,                        -- fk added below
  cleared_by       uuid references public.profiles(id),
  cleared_at       timestamptz,
  created_by       uuid not null references public.profiles(id)
);
create index deposits_store_status_idx on public.deposits (store_id, status);

create table public.import_batches (
  id              bigint generated always as identity primary key,
  source          text not null check (source in (
                    'nrs_store_report','nrs_shift_report','nrs_cc_report',
                    'nrs_csv_sales','nrs_csv_dept','nrs_csv_items','nrs_csv_hourly','nrs_csv_baskets',
                    'bank_statement')),
  store_id        bigint references public.stores(id),
  bank_account_id bigint references public.bank_accounts(id),
  file_hash       text not null,
  file_path       text,
  coverage_start  date,
  coverage_end    date,
  received_at     timestamptz not null default now(),
  rows_total      integer not null default 0,
  rows_posted     integer not null default 0,
  rows_skipped    integer not null default 0,
  rows_corrected  integer not null default 0,
  weak_ids        boolean not null default false,
  duplicate_of    bigint references public.import_batches(id),
  uploaded_by     uuid references public.profiles(id)
);
create unique index import_batches_hash_idx on public.import_batches (source, coalesce(store_id,0), coalesce(bank_account_id,0), file_hash);

create table public.bank_lines (
  id               bigint generated always as identity primary key,
  bank_account_id  bigint not null references public.bank_accounts(id),
  batch_id         bigint not null references public.import_batches(id),
  source_id        text not null,                    -- bank|date|desc|amount|ordinal
  posted_date      date not null,
  description      text not null,
  amount_cents     bigint not null,                  -- +credit / −debit
  kind             text not null check (kind in (
                     'merchant_deposit','merchant_fees','cash_deposit','nrs_subscription',
                     'overdraft_fee','returned_item','other')),
  matched_deposit_id bigint references public.deposits(id),
  matched_move_id    bigint references public.money_moves(id),
  unique (bank_account_id, source_id)
);
create index bank_lines_acct_date_idx on public.bank_lines (bank_account_id, posted_date);
alter table public.deposits add constraint deposits_cleared_line_fk
  foreign key (cleared_bank_line_id) references public.bank_lines(id);

create table public.bank_snapshots (
  id               bigint generated always as identity primary key,
  bank_account_id  bigint not null references public.bank_accounts(id),
  balance_cents    bigint not null,
  as_of            timestamptz not null,
  entered_by       uuid not null references public.profiles(id),
  created_at       timestamptz not null default now()
);
create index bank_snapshots_latest_idx on public.bank_snapshots (bank_account_id, as_of desc);

-- Source rows from POS files, keyed for idempotency (B.6)
create table public.source_rows (
  id          bigint generated always as identity primary key,
  batch_id    bigint not null references public.import_batches(id),
  source      text not null,
  store_id    bigint references public.stores(id),
  source_id   text not null,
  row_hash    text not null,
  payload     jsonb not null,
  superseded_by bigint references public.source_rows(id),
  created_at  timestamptz not null default now()
);
create unique index source_rows_identity_idx on public.source_rows (source, coalesce(store_id,0), source_id) where superseded_by is null;

create table public.audit_log (
  id         bigint generated always as identity primary key,
  actor      uuid,
  action     text not null,
  target     text,
  detail     jsonb not null default '{}'::jsonb,
  at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Recurring bills (minimal, for the 7-day projection on Cash Position)
-- ---------------------------------------------------------------------------

create table public.recurring_bills (
  id            bigint generated always as identity primary key,
  store_id      bigint not null references public.stores(id),
  payee         text not null,
  amount_cents  bigint not null check (amount_cents >= 0),
  due_day       integer check (due_day between 1 and 31),
  cadence       text not null default 'monthly' check (cadence in ('monthly','weekly','semimonthly')),
  category      text not null,
  related_party boolean not null default false,
  active        boolean not null default true
);

-- ---------------------------------------------------------------------------
-- Atomic close revision (B.5, C-10, C-11, C-12)
--   Reverses ONLY moves that came from the close (close_id set, kinds in list),
--   inserts replacements, bumps revision_no. Idempotent on idempotency_key.
-- ---------------------------------------------------------------------------

create or replace function public.revise_close(
  p_idempotency_key text,
  p_close_id        bigint,
  p_reason          text,
  p_actor           uuid,
  p_replacements    jsonb   -- [{kind, from_account_id, to_account_id, amount_cents, event_at, note}]
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rev_id bigint;
  v_close  public.daily_closes%rowtype;
  m        record;
  r        jsonb;
begin
  -- idempotent retry: return the finished revision
  select id into v_rev_id from public.revisions where idempotency_key = p_idempotency_key;
  if found then return v_rev_id; end if;

  select * into v_close from public.daily_closes where id = p_close_id for update;
  if not found then raise exception 'close % not found', p_close_id; end if;

  -- who may revise (B.5): employee same business day, manager within 7 days, owner any time
  perform 1 from public.profiles pr where pr.id = p_actor and pr.active
    and (pr.role = 'owner'
      or (pr.role = 'manager' and v_close.business_date >= current_date - 7
          and v_close.store_id in (select us.store_id from public.user_stores us where us.user_id = p_actor))
      or (pr.role = 'employee' and v_close.business_date = current_date and v_close.submitted_by = p_actor));
  if not found then raise exception 'not_allowed: % may not revise close %', p_actor, p_close_id; end if;

  insert into public.revisions (idempotency_key, close_id, reason, created_by)
  values (p_idempotency_key, p_close_id, p_reason, p_actor) returning id into v_rev_id;

  -- reversal of every live close-derived move (not drops/collections/deposits: C-11)
  for m in
    select mm.* from public.money_moves mm
    where mm.close_id = p_close_id
      and mm.kind in ('cash_sale','card_sale','check_sale','ebt_sale','loyalty_redemption',
                      'cash_rounding','cash_paid_out','drawer_over','drawer_short')
      and not exists (select 1 from public.money_moves x where x.reverses_move_id = mm.id)
  loop
    insert into public.money_moves (kind, from_account_id, to_account_id, amount_cents, event_at,
      business_date, store_id, close_id, revision_id, reverses_move_id, created_by, note)
    values ('reversal', m.to_account_id, m.from_account_id, m.amount_cents, m.event_at,
      m.business_date, m.store_id, p_close_id, v_rev_id, m.id, p_actor, p_reason);
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p_replacements, '[]'::jsonb)) loop
    insert into public.money_moves (kind, from_account_id, to_account_id, amount_cents, event_at,
      business_date, store_id, close_id, revision_id, created_by, note)
    values (r->>'kind', (r->>'from_account_id')::bigint, (r->>'to_account_id')::bigint,
      (r->>'amount_cents')::bigint, (r->>'event_at')::timestamptz, v_close.business_date,
      v_close.store_id, p_close_id, v_rev_id, p_actor, r->>'note');
  end loop;

  update public.daily_closes
     set revision_no = revision_no + 1,
         status = case when status = 'verified' then 'submitted' else status end
   where id = p_close_id;

  insert into public.audit_log (actor, action, target, detail)
  values (p_actor, 'revise_close', 'daily_closes:' || p_close_id,
          jsonb_build_object('revision_id', v_rev_id, 'reason', p_reason));
  return v_rev_id;
end $$;
revoke execute on function public.revise_close(text, bigint, text, uuid, jsonb) from public;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

create or replace function private.uid() returns uuid
language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
                                           nullif(current_setting('app.uid', true), '')::uuid) $$;

create or replace function private.my_role() returns text
language sql stable security definer set search_path = '' as $$
  select p.role from public.profiles p where p.id = private.uid() and p.active $$;

create or replace function private.my_store_ids() returns setof bigint
language sql stable security definer set search_path = '' as $$
  select s.id from public.stores s where (select private.my_role()) = 'owner'
  union
  select us.store_id from public.user_stores us where us.user_id = private.uid()
$$;

create or replace function private.can_view_bank(p_store bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select private.my_role()) = 'owner'
      or exists (select 1 from public.user_stores us
                  where us.user_id = private.uid() and us.store_id = p_store and us.can_view_bank)
$$;
-- The helpers only ever reveal the caller's own role/stores, so any logged-in role may call them.
grant usage on schema private to public;

alter table public.entities        enable row level security;
alter table public.stores          enable row level security;
alter table public.bank_accounts   enable row level security;
alter table public.profiles        enable row level security;
alter table public.user_stores     enable row level security;
alter table public.accounts        enable row level security;
alter table public.daily_closes    enable row level security;
alter table public.close_exceptions enable row level security;
alter table public.tender_map      enable row level security;
alter table public.revisions       enable row level security;
alter table public.money_moves     enable row level security;
alter table public.deposits        enable row level security;
alter table public.import_batches  enable row level security;
alter table public.bank_lines      enable row level security;
alter table public.bank_snapshots  enable row level security;
alter table public.source_rows     enable row level security;
alter table public.audit_log       enable row level security;
alter table public.recurring_bills enable row level security;

-- owner: everything
create policy owner_all_entities on public.entities for all using ((select private.my_role()) = 'owner');
create policy owner_all_bank_accounts on public.bank_accounts for all using ((select private.my_role()) = 'owner');
create policy owner_all_profiles on public.profiles for all using ((select private.my_role()) = 'owner');
create policy owner_all_user_stores on public.user_stores for all using ((select private.my_role()) = 'owner');
create policy owner_all_tender_map on public.tender_map for all using ((select private.my_role()) = 'owner');
create policy owner_all_audit on public.audit_log for select using ((select private.my_role()) = 'owner');
create policy owner_all_bills on public.recurring_bills for all using ((select private.my_role()) = 'owner');
create policy owner_all_import on public.import_batches for all using ((select private.my_role()) = 'owner');
create policy owner_all_source_rows on public.source_rows for all using ((select private.my_role()) = 'owner');

-- everyone: own profile, own store list, stores they belong to
create policy self_profile on public.profiles for select using (id = (select private.uid()));
create policy self_user_stores on public.user_stores for select using (user_id = (select private.uid()));
create policy my_stores on public.stores for select using (id in (select private.my_store_ids()));
create policy my_tender_map on public.tender_map for select using (store_id in (select private.my_store_ids()));

-- accounts: employees never see bank accounts; managers see bank only with can_view_bank
create policy accounts_read on public.accounts for select using (
  (select private.my_role()) = 'owner'
  or (kind <> 'bank' and store_id in (select private.my_store_ids()))
  or (kind = 'bank' and exists (select 1 from public.stores s where s.entity_id = accounts.owner_entity_id
                                   and (select private.can_view_bank(s.id))))
);

-- closes: managers/owner all for their stores; employees only their own submissions
create policy closes_read on public.daily_closes for select using (
  store_id in (select private.my_store_ids())
  and ((select private.my_role()) in ('owner','manager') or submitted_by = (select private.uid()))
);
create policy closes_insert on public.daily_closes for insert with check (
  submitted_by = (select private.uid())
  and exists (select 1 from public.user_stores us where us.user_id = (select private.uid())
               and us.store_id = daily_closes.store_id and us.can_close)
  or (select private.my_role()) = 'owner'
);
create policy closes_update on public.daily_closes for update using (
  store_id in (select private.my_store_ids()) and (select private.my_role()) in ('owner','manager')
);
create policy exceptions_read on public.close_exceptions for select using (
  close_id in (select c.id from public.daily_closes c)   -- RLS on daily_closes applies
);
create policy exceptions_insert on public.close_exceptions for insert with check (
  close_id in (select c.id from public.daily_closes c)
);
create policy exceptions_resolve on public.close_exceptions for update using (
  (select private.my_role()) in ('owner','manager')
  and close_id in (select c.id from public.daily_closes c)
);
-- owner sets opening counts (B.3); nobody else edits accounts
create policy accounts_owner_write on public.accounts for update using ((select private.my_role()) = 'owner');

-- money moves: employees see drawer/safe traffic for their store; collections/deposits/bank are manager+ (C-17)
create policy moves_read on public.money_moves for select using (
  store_id in (select private.my_store_ids())
  and ((select private.my_role()) in ('owner','manager')
       or kind in ('cash_sale','card_sale','check_sale','ebt_sale','loyalty_redemption','cash_rounding',
                   'cash_paid_out','cash_drop','drawer_over','drawer_short','reversal'))
);
create policy moves_insert on public.money_moves for insert with check (
  store_id in (select private.my_store_ids())
  and created_by = (select private.uid())
  and (
    kind in ('cash_sale','card_sale','check_sale','ebt_sale','loyalty_redemption','cash_rounding',
             'cash_paid_out','cash_drop','drawer_over','drawer_short')
    or (kind in ('cash_collect','safe_over','safe_short') and exists
          (select 1 from public.user_stores us where us.user_id = (select private.uid())
             and us.store_id = money_moves.store_id and us.can_collect))
    or (kind = 'cash_deposit' and exists
          (select 1 from public.user_stores us where us.user_id = (select private.uid())
             and us.store_id = money_moves.store_id and us.can_deposit))
    or (select private.my_role()) = 'owner'
  )
);
create policy revisions_read on public.revisions for select using (
  (select private.my_role()) in ('owner','manager')
);

create policy deposits_read on public.deposits for select using (
  store_id in (select private.my_store_ids()) and (select private.my_role()) in ('owner','manager')
);
create policy deposits_insert on public.deposits for insert with check (
  created_by = (select private.uid()) and (
    (select private.my_role()) = 'owner' or exists
      (select 1 from public.user_stores us where us.user_id = (select private.uid())
         and us.store_id = deposits.store_id and us.can_deposit))
);
create policy deposits_update on public.deposits for update using ((select private.my_role()) = 'owner');

-- bank: owner, or manager with can_view_bank on a store of that entity
-- account NAMES are visible to anyone who may deposit (they must pick one);
-- balances, lines and snapshots stay behind can_view_bank (D3)
create policy bank_accounts_read on public.bank_accounts for select using (
  exists (select 1 from public.stores s where s.entity_id = bank_accounts.entity_id
            and ((select private.can_view_bank(s.id))
                 or exists (select 1 from public.user_stores us where us.user_id = (select private.uid())
                              and us.store_id = s.id and us.can_deposit)))
);
create policy bank_lines_read on public.bank_lines for select using (
  exists (select 1 from public.bank_accounts b join public.stores s on s.entity_id = b.entity_id
           where b.id = bank_lines.bank_account_id and (select private.can_view_bank(s.id)))
);
create policy bank_lines_write on public.bank_lines for all using ((select private.my_role()) = 'owner');
create policy bank_snapshots_read on public.bank_snapshots for select using (
  exists (select 1 from public.bank_accounts b join public.stores s on s.entity_id = b.entity_id
           where b.id = bank_snapshots.bank_account_id and (select private.can_view_bank(s.id)))
);
create policy bank_snapshots_insert on public.bank_snapshots for insert with check (
  entered_by = (select private.uid()) and exists
    (select 1 from public.bank_accounts b join public.stores s on s.entity_id = b.entity_id
      where b.id = bank_snapshots.bank_account_id and (select private.can_view_bank(s.id)))
);
create policy bills_read on public.recurring_bills for select using (
  store_id in (select private.my_store_ids()) and (select private.my_role()) in ('owner','manager')
);
create policy import_batches_read on public.import_batches for select using (
  (store_id in (select private.my_store_ids()) and (select private.my_role()) in ('owner','manager'))
);
create policy import_batches_insert on public.import_batches for insert with check (
  uploaded_by = (select private.uid()) and store_id in (select private.my_store_ids())
);
create policy source_rows_read on public.source_rows for select using (
  store_id in (select private.my_store_ids()) and (select private.my_role()) in ('owner','manager')
);
