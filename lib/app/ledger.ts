// Server-side use cases. Each runs inside asUser() so RLS is enforced; the
// posting rules come from lib/ledger/posting.ts and nothing here invents money.
import type { Sql } from "./db.ts";
import { parseStoreReport, parseShiftReport, verifyStoreReport, type StoreReport, type TenderField } from "../nrs/report.ts";
import { parseSalesByDay } from "../nrs/csv.ts";
import { parseBankLines, type Bank } from "../nrs/bank.ts";
import {
  movesForClose, tenderMismatch, drawerVariance, collectionMoves, nextDue, projectedBalance, UnmappedTender,
  type Move, type StoreAccounts, type Paidout,
} from "../ledger/posting.ts";

export interface AcctRow { id: number; code: string; kind: string; balance_cents: string }

export async function accountsFor(sql: Sql, storeId: number): Promise<{ codes: StoreAccounts; ids: Map<string, number>; rows: AcctRow[] }> {
  const rows = await sql<AcctRow>(
    `select account_id as id, code, kind, balance_cents::text from public.account_balances
      where store_id = $1 or kind in ('external','bank') order by kind`, [storeId]);
  const ids = new Map(rows.map((r) => [r.code, r.id]));
  const byKind = (k: string) => rows.find((r) => r.kind === k && r.code.endsWith(":" + storeSlug(rows)))?.code ?? rows.find((r) => r.kind === k)?.code ?? "";
  const codes: StoreAccounts = {
    drawer: byKind("drawer"), safe: byKind("safe"), collected: byKind("collected"), inTransit: byKind("in_transit"),
    cardClearing: byKind("card_clearing"), variance: byKind("variance"), loyalty: byKind("loyalty"), rounding: byKind("rounding"),
    customers: "external:customers", vendors: "external:vendors",
    bank: rows.find((r) => r.kind === "bank")?.code ?? "bank:none",
  };
  return { codes, ids, rows };
}
function storeSlug(rows: AcctRow[]): string {
  const d = rows.find((r) => r.kind === "drawer")?.code ?? "";
  return d.split(":")[1] ?? "";
}

export const bal = (rows: AcctRow[], code: string): number => Number(rows.find((r) => r.code === code)?.balance_cents ?? 0);

async function insertMoves(sql: Sql, uid: string, storeId: number, businessDate: string, ids: Map<string, number>, moves: Move[], closeId: number | null) {
  for (const m of moves) {
    const from = ids.get(m.from), to = ids.get(m.to);
    if (from === undefined || to === undefined) throw new Error(`account missing: ${m.from} / ${m.to}`);
    await sql(
      `insert into public.money_moves (kind, from_account_id, to_account_id, amount_cents, event_at, business_date, store_id, close_id, created_by, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [m.kind, from, to, m.amount, m.eventAt, businessDate, storeId, closeId, uid, m.note ?? null]);
  }
}

export interface CloseForm {
  storeId: number;
  businessDate: string; // YYYY-MM-DD
  reportText: string; // pasted/printed Store Report text (optional if typed)
  typed: { netSales: number; salesTax: number; cash: number; card: number; points: number; rounding: number; check: number; ebt: number } | null;
  paidouts: Paidout[];
  countedDrawer: number; // cents
  registerClosedAt: string; // ISO local
  salesCsv: string | null;
  secondsEntering: number;
}

export async function submitClose(sql: Sql, uid: string, f: CloseForm) {
  const { codes, ids, rows } = await accountsFor(sql, f.storeId);
  const mapRows = await sql<{ nrs_label: string; field: string }>(
    "select nrs_label, field from public.tender_map where store_id = $1 and active_to is null", [f.storeId]);
  const map = Object.fromEntries(mapRows.map((r) => [r.nrs_label, r.field]));

  let report: StoreReport;
  if (f.reportText.trim()) {
    report = parseStoreReport(f.reportText);
    // apply the store's own map (DB), not the code constant
    report.tenders = report.tenders.map((t) => ({ ...t, field: (map[t.label] as typeof t.field) ?? null }));
    report.unmapped = report.tenders.filter((t) => !t.field).map((t) => t.label);
  } else if (f.typed) {
    const t = f.typed;
    report = {
      baskets: 0, items: 0, netSales: t.netSales, taxableSales: t.netSales, salesTax: t.salesTax,
      paymentsTotal: t.cash + t.card + t.points + t.rounding + t.check + t.ebt,
      tenders: [
        { label: "Cash", tier: null, baskets: 0, amount: t.cash, field: "net_cash_receipts" as TenderField },
        { label: "Credit/Debit (Net)", tier: null, baskets: 0, amount: t.card, field: "net_card_receipts" as TenderField },
        { label: "Pay with Points", tier: null, baskets: 0, amount: t.points, field: "loyalty_redemption" as TenderField },
        { label: "Cash Rounding", tier: null, baskets: 0, amount: t.rounding, field: "cash_rounding" as TenderField },
        { label: "Check", tier: null, baskets: 0, amount: t.check, field: "check_receipts" as TenderField },
        { label: "EBT SNAP", tier: null, baskets: 0, amount: t.ebt, field: "ebt_receipts" as TenderField },
      ].filter((x) => x.amount !== 0),
      unmapped: [], cashDrops: { count: 0, amount: 0 }, vendorPayouts: { count: f.paidouts.length, amount: f.paidouts.reduce((a, p) => a + p.amount, 0) },
      refunds: 0, instorePromos: 0, instoreDiscounts: 0, counters: {}, deptSales: [], deptTableComplete: false,
    };
  } else throw new Error("Paste the Store Report or type the figures");

  const exceptions: { code: string; detail: unknown }[] = [];
  let moves: Move[] = [];
  try {
    moves = movesForClose(codes, { report, paidouts: f.paidouts, registerClosedAt: f.registerClosedAt });
  } catch (e) {
    if (e instanceof UnmappedTender) exceptions.push({ code: "unmapped_tender", detail: { labels: e.labels } });
    else throw e;
  }
  const mism = tenderMismatch(report);
  if (mism !== null) exceptions.push({ code: "tender_mismatch", detail: { diff_cents: mism } });
  for (const c of verifyStoreReport(report)) if (!c.ok && c.check === "net_plus_tax") exceptions.push({ code: "net_plus_tax", detail: c });
  if (f.salesCsv) {
    try {
      const { meta, rows: days } = parseSalesByDay(f.salesCsv);
      const day = days.find((d) => d.date === f.businessDate);
      if (!day || day.netSales !== report.netSales) exceptions.push({ code: "csv_mismatch", detail: { csv: day?.netSales ?? null, report: report.netSales, store: meta.city } });
    } catch (e) {
      exceptions.push({ code: "csv_mismatch", detail: { error: String(e) } });
    }
  }

  // expected drawer = drawer balance now (float carried + today's drops already posted) + close moves touching the drawer
  const drawerNow = bal(rows, codes.drawer);
  let expected = drawerNow;
  for (const m of moves) {
    if (m.to === codes.drawer) expected += m.amount;
    if (m.from === codes.drawer) expected -= m.amount;
  }
  const variance = drawerVariance(codes, expected, f.countedDrawer, f.registerClosedAt);
  if (variance && variance.amount >= 500) exceptions.push({ code: "drawer_variance", detail: { expected, counted: f.countedDrawer } });

  const close = (await sql<{ id: number }>(
    `insert into public.daily_closes (store_id, business_date, submitted_by, register_closed_at, net_sales_cents, sales_tax_cents,
       payments_total_cents, tenders, cash_drops_cents, vendor_payouts, refunds_cents, counters, expected_drawer_cents, counted_drawer_cents, seconds_entering)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
    [f.storeId, f.businessDate, uid, f.registerClosedAt, report.netSales, report.salesTax, report.paymentsTotal,
      JSON.stringify(report.tenders.map((t) => ({ label: t.label, tier: t.tier, amount_cents: t.amount, field: t.field }))),
      report.cashDrops.amount, JSON.stringify(f.paidouts.map((p) => ({ amount_cents: p.amount, reason: p.reason }))),
      report.refunds, JSON.stringify(report.counters), expected, f.countedDrawer, f.secondsEntering]))[0];

  if (!exceptions.some((e) => e.code === "unmapped_tender")) {
    await insertMoves(sql, uid, f.storeId, f.businessDate, ids, [...moves, ...(variance ? [variance] : [])], close.id);
  }
  for (const e of exceptions) {
    await sql("insert into public.close_exceptions (close_id, code, detail) values ($1,$2,$3)", [close.id, e.code, JSON.stringify(e.detail)]);
  }
  return { closeId: close.id, expected, counted: f.countedDrawer, exceptions, moves };
}

export async function recordDrop(sql: Sql, uid: string, storeId: number, amount: number, at: string, note: string) {
  const { codes, ids } = await accountsFor(sql, storeId);
  await insertMoves(sql, uid, storeId, at.slice(0, 10), ids, [{ kind: "cash_drop", from: codes.drawer, to: codes.safe, amount, eventAt: at, note }], null);
}

export async function collectSafe(sql: Sql, uid: string, storeId: number, counted: number, at: string) {
  const { codes, ids, rows } = await accountsFor(sql, storeId);
  const expected = bal(rows, codes.safe);
  const moves = collectionMoves(codes, expected, counted, at);
  await insertMoves(sql, uid, storeId, at.slice(0, 10), ids, moves, null);
  return { expected, counted, moves };
}

export async function recordDeposit(sql: Sql, uid: string, storeId: number, bankAccountId: number, amount: number, at: string) {
  const { codes, ids } = await accountsFor(sql, storeId);
  await insertMoves(sql, uid, storeId, at.slice(0, 10), ids, [{ kind: "cash_deposit", from: codes.collected, to: codes.inTransit, amount, eventAt: at }], null);
  const mv = (await sql<{ id: number }>("select max(id) as id from public.money_moves where created_by = $1 and kind = 'cash_deposit'", [uid]))[0];
  await sql(
    `insert into public.deposits (store_id, bank_account_id, move_id, amount_cents, deposited_at, created_by) values ($1,$2,$3,$4,$5,$6)`,
    [storeId, bankAccountId, mv.id, amount, at, uid]);
}

export async function clearDeposit(sql: Sql, uid: string, depositId: number, bankLineId: number | null, clearedAt: string) {
  const d = (await sql<{ id: number; store_id: number; amount_cents: string; status: string }>(
    "select id, store_id, amount_cents::text, status from public.deposits where id = $1", [depositId]))[0];
  if (!d || d.status !== "in_transit") throw new Error("deposit not in transit");
  const { codes, ids } = await accountsFor(sql, d.store_id);
  await insertMoves(sql, uid, d.store_id, clearedAt.slice(0, 10), ids,
    [{ kind: "deposit_cleared", from: codes.inTransit, to: codes.bank, amount: Number(d.amount_cents), eventAt: clearedAt }], null);
  const mv = (await sql<{ id: number }>("select max(id) as id from public.money_moves where kind = 'deposit_cleared' and created_by = $1", [uid]))[0];
  await sql(
    `update public.deposits set status='cleared', cleared_move_id=$2, cleared_bank_line_id=$3, cleared_by=$4, cleared_at=$5 where id=$1`,
    [depositId, mv.id, bankLineId, uid, clearedAt]);
  if (bankLineId) await sql("update public.bank_lines set matched_deposit_id=$1, matched_move_id=$2 where id=$3", [depositId, mv.id, bankLineId]);
}

export async function verifyClose(sql: Sql, uid: string, closeId: number) {
  const open = await sql<{ code: string }>("select code from public.close_exceptions where close_id = $1 and resolved_at is null", [closeId]);
  const blocking = open.filter((e) => ["unmapped_tender", "tender_mismatch", "net_plus_tax", "csv_mismatch"].includes(e.code));
  if (blocking.length) return { ok: false, blocking: blocking.map((b) => b.code) };
  await sql("update public.daily_closes set status='verified', verified_by=$2, verified_at=now() where id=$1", [closeId, uid]);
  await sql("update public.close_exceptions set resolved_at=now() where close_id=$1 and resolved_at is null", [closeId]);
  return { ok: true, blocking: [] as string[] };
}

export async function addSnapshot(sql: Sql, uid: string, bankAccountId: number, balance: number, asOf: string) {
  await sql("insert into public.bank_snapshots (bank_account_id, balance_cents, as_of, entered_by) values ($1,$2,$3,$4)", [bankAccountId, balance, asOf, uid]);
}

export async function importStatement(sql: Sql, uid: string, bankAccountId: number, bank: Bank, year: number, text: string) {
  const lines = parseBankLines(text, bank, year);
  const hash = await sha(text);
  const existing = await sql<{ id: number }>("select id from public.import_batches where source='bank_statement' and bank_account_id=$1 and file_hash=$2", [bankAccountId, hash]);
  const dates = lines.map((l) => l.date).sort();
  const batch = (await sql<{ id: number }>(
    `insert into public.import_batches (source, bank_account_id, file_hash, coverage_start, coverage_end, rows_total, uploaded_by, duplicate_of)
     values ('bank_statement',$1,$2,$3,$4,$5,$6,$7) returning id`,
    [bankAccountId, hash + (existing[0] ? ":" + Date.now() : ""), dates[0] ?? null, dates[dates.length - 1] ?? null, lines.length, uid, existing[0]?.id ?? null]))[0];
  let posted = 0, skipped = 0;
  for (const l of lines) {
    const r = await sql(
      `insert into public.bank_lines (bank_account_id, batch_id, source_id, posted_date, description, amount_cents, kind)
       values ($1,$2,$3,$4,$5,$6,$7) on conflict (bank_account_id, source_id) do nothing returning id`,
      [bankAccountId, batch.id, l.sourceId, l.date, l.description, l.amount, l.kind]);
    if (r.length) posted++; else skipped++;
  }
  await sql("update public.import_batches set rows_posted=$2, rows_skipped=$3 where id=$1", [batch.id, posted, skipped]);
  return { posted, skipped, total: lines.length, duplicateOf: existing[0]?.id ?? null };
}

export async function setOpening(sql: Sql, uid: string, storeId: number, at: string, counts: Record<string, number>) {
  for (const [code, cents] of Object.entries(counts)) {
    await sql("update public.accounts set opening_at=$2, opening_balance_cents=$3, opening_counted_by=$4 where code=$1 and store_id=$5",
      [code, at, cents, uid, storeId]);
  }
}

export async function cashPosition(sql: Sql, storeId: number, today: string) {
  const { codes, rows } = await accountsFor(sql, storeId);
  const snap = (await sql<{ balance_cents: string; as_of: string; nickname: string; id: number }>(
    `select s.balance_cents::text, s.as_of::text, b.nickname, b.id from public.bank_snapshots s join public.bank_accounts b on b.id = s.bank_account_id
      join public.stores st on st.entity_id = b.entity_id where st.id = $1 order by s.as_of desc limit 1`, [storeId]))[0];
  const bills = await sql<{ payee: string; amount_cents: string; due_day: number }>(
    "select payee, amount_cents::text, due_day from public.recurring_bills where store_id=$1 and active and due_day is not null", [storeId]);
  const proj = projectedBalance({
    snapshot: snap ? { balance: Number(snap.balance_cents), asOf: snap.as_of } : null,
    inTransit: bal(rows, codes.inTransit),
    cardClearing: bal(rows, codes.cardClearing),
    bills: bills.map((b) => ({ payee: b.payee, amount: Number(b.amount_cents), dueDate: nextDue(today, b.due_day) })),
    from: today, days: 7,
  });
  const coverage = (await sql<{ d: string | null; r: string | null }>(
    "select max(business_date)::text as d, max(submitted_at)::text as r from public.daily_closes where store_id=$1", [storeId]))[0];
  const corrections = await sql<{ id: number; reason: string; created_at: string; business_date: string }>(
    `select r.id, r.reason, r.created_at::text, c.business_date::text from public.revisions r join public.daily_closes c on c.id = r.close_id
      where c.store_id = $1 order by r.created_at desc limit 10`, [storeId]);
  return { codes, rows, snapshot: snap ?? null, projection: proj, coverage, corrections };
}

async function sha(text: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
}

export { parseShiftReport };
