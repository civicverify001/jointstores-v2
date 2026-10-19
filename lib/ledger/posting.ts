// Posting engine (Part B). Pure functions: a close + tender map in, money moves
// out. No I/O. The database is the record; this is the rule book, tested on
// its own so the rules can be read without reading SQL.

import type { Cents } from "../nrs/csv.ts";
import type { StoreReport, Shift } from "../nrs/report.ts";

export type AccountCode = string; // "drawer:fortville"

export interface StoreAccounts {
  drawer: AccountCode;
  safe: AccountCode;
  collected: AccountCode; // collected:chelsea:<store>
  inTransit: AccountCode;
  cardClearing: AccountCode;
  variance: AccountCode;
  loyalty: AccountCode;
  rounding: AccountCode;
  customers: AccountCode; // external:customers
  vendors: AccountCode; // external:vendors
  bank: AccountCode; // bank:<name>
}

export type MoveKind =
  | "cash_sale" | "card_sale" | "check_sale" | "ebt_sale" | "loyalty_redemption" | "cash_rounding"
  | "cash_paid_out" | "cash_drop" | "cash_collect" | "cash_deposit" | "deposit_cleared"
  | "card_settlement" | "card_fee" | "drawer_over" | "drawer_short" | "safe_over" | "safe_short";

export interface Move {
  kind: MoveKind;
  from: AccountCode;
  to: AccountCode;
  amount: Cents; // always > 0
  eventAt: string; // ISO
  note?: string;
}

export interface Paidout {
  amount: Cents;
  reason: string;
}

export interface CloseInput {
  report: StoreReport;
  paidouts: Paidout[]; // vendor payouts with reasons (register_paid_outs)
  registerClosedAt: string; // ISO
}

export class UnmappedTender extends Error {
  labels: string[];
  constructor(labels: string[]) {
    super(`unmapped_tender: ${labels.join(", ")}`);
    this.labels = labels;
  }
}

/** Close → close-derived moves only (B.2 move 1). Drops/collections/deposits are separate user actions. */
export function movesForClose(a: StoreAccounts, c: CloseInput): Move[] {
  const r = c.report;
  if (r.unmapped.length) throw new UnmappedTender(r.unmapped);
  const at = c.registerClosedAt;
  const sum = (field: string) => r.tenders.filter((t) => t.field === field).reduce((s, t) => s + t.amount, 0);
  const out: Move[] = [];
  const push = (kind: MoveKind, from: AccountCode, to: AccountCode, amount: Cents, note?: string) => {
    if (amount === 0) return;
    if (amount < 0) [from, to, amount] = [to, from, -amount];
    out.push({ kind, from, to, amount, eventAt: at, note });
  };
  push("cash_sale", a.customers, a.drawer, sum("net_cash_receipts"));
  push("card_sale", a.customers, a.cardClearing, sum("net_card_receipts"));
  push("check_sale", a.customers, a.drawer, sum("check_receipts")); // checks ride with cash to the bank
  push("ebt_sale", a.customers, a.cardClearing, sum("ebt_receipts")); // separate processor; pilot: same clearing, tagged
  // Points: store-funded. Nothing enters the drawer; the cost sits in loyalty.
  push("loyalty_redemption", a.loyalty, a.customers, sum("loyalty_redemption"));
  // Rounding: −0.02 on the report means the drawer took 2c less than the tendered total.
  push("cash_rounding", a.drawer, a.rounding, -sum("cash_rounding"));
  for (const p of c.paidouts) push("cash_paid_out", a.drawer, a.vendors, p.amount, p.reason);
  return out;
}

/** B.1 consistency: tendered total must equal net sales + tax (within 1c). */
export function tenderMismatch(r: StoreReport): Cents | null {
  const tendered = r.tenders.reduce((s, t) => s + t.amount, 0);
  const diff = tendered - (r.netSales + r.salesTax);
  return Math.abs(diff) <= 1 ? null : diff;
}

/** Expected drawer (B.2): carried float + cash in − paid out − rounding − drops. */
export function expectedDrawer(carriedFloat: Cents, moves: Move[], a: StoreAccounts): Cents {
  let bal = carriedFloat;
  for (const m of moves) {
    if (m.to === a.drawer) bal += m.amount;
    if (m.from === a.drawer) bal -= m.amount;
  }
  return bal;
}

/** Over/short → one variance move, or none when exact. */
export function drawerVariance(a: StoreAccounts, expected: Cents, counted: Cents, at: string): Move | null {
  const d = counted - expected;
  if (d === 0) return null;
  return d > 0
    ? { kind: "drawer_over", from: a.variance, to: a.drawer, amount: d, eventAt: at }
    : { kind: "drawer_short", from: a.drawer, to: a.variance, amount: -d, eventAt: at };
}

/** Collection (B.2 move 3): counted safe moves to Chelsea; difference to variance. */
export function collectionMoves(a: StoreAccounts, expectedSafe: Cents, countedSafe: Cents, at: string): Move[] {
  const out: Move[] = [];
  if (countedSafe > 0) out.push({ kind: "cash_collect", from: a.safe, to: a.collected, amount: countedSafe, eventAt: at });
  const d = countedSafe - expectedSafe;
  if (d < 0) out.push({ kind: "safe_short", from: a.safe, to: a.variance, amount: -d, eventAt: at });
  if (d > 0) out.push({ kind: "safe_over", from: a.variance, to: a.safe, amount: d, eventAt: at });
  return out;
}

/** Drops recorded on the POS (shift report) become one move each. */
export function dropsFromShifts(a: StoreAccounts, shifts: Shift[], businessDate: string): Move[] {
  const out: Move[] = [];
  for (const s of shifts) {
    if (s.cashDrops.amount <= 0) continue;
    // Shift report prints "10/17/2026 02:05 PM - 10:01 PM"; the drop is at shift close.
    const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s.started);
    const date = m ? `${m[3]}-${m[1]}-${m[2]}` : businessDate;
    const t = /(\d{2}):(\d{2}) (AM|PM)$/.exec(s.closed);
    let hh = t ? parseInt(t[1], 10) % 12 : 23;
    if (t && t[3] === "PM") hh += 12;
    const eventAt = `${date}T${String(hh).padStart(2, "0")}:${t ? t[2] : "59"}:00`;
    out.push({ kind: "cash_drop", from: a.drawer, to: a.safe, amount: s.cashDrops.amount, eventAt, note: `${s.name} shift drop (${s.cashDrops.count})` });
  }
  return out;
}

// ---------- balances & projection ----------

export interface Opening {
  code: AccountCode;
  openingAt: string | null;
  balance: Cents;
}

/** Balance per account from openings + moves after each account's cutoff (mirrors the SQL view). */
export function balances(openings: Opening[], moves: Move[]): Map<AccountCode, Cents> {
  const bal = new Map<AccountCode, Cents>();
  const open = new Map(openings.map((o) => [o.code, o]));
  for (const o of openings) bal.set(o.code, o.balance);
  const after = (code: AccountCode, at: string) => {
    const o = open.get(code);
    return !o?.openingAt || at > o.openingAt;
  };
  for (const m of moves) {
    if (after(m.to, m.eventAt)) bal.set(m.to, (bal.get(m.to) ?? 0) + m.amount);
    if (after(m.from, m.eventAt)) bal.set(m.from, (bal.get(m.from) ?? 0) - m.amount);
  }
  return bal;
}

export interface BillDue {
  payee: string;
  amount: Cents;
  dueDate: string; // YYYY-MM-DD
}

/**
 * Cash Position "projected balance" row (H.2): bank snapshot + deposits in transit
 * + card clearing expected to settle within the window − bills due within the window.
 * The snapshot is typed/imported, never computed (B.4).
 */
export function projectedBalance(opts: {
  snapshot: { balance: Cents; asOf: string } | null;
  inTransit: Cents;
  cardClearing: Cents;
  bills: BillDue[];
  from: string; // YYYY-MM-DD
  days: number;
}): { projected: Cents | null; dueInWindow: BillDue[]; lowest: Cents | null } {
  if (!opts.snapshot) return { projected: null, dueInWindow: [], lowest: null };
  const end = addDays(opts.from, opts.days);
  const due = opts.bills.filter((b) => b.dueDate >= opts.from && b.dueDate <= end).sort((x, y) => x.dueDate.localeCompare(y.dueDate));
  const start = opts.snapshot.balance + opts.inTransit + opts.cardClearing;
  let running = start;
  let lowest = start;
  for (const b of due) {
    running -= b.amount;
    if (running < lowest) lowest = running;
  }
  return { projected: running, dueInWindow: due, lowest };
}

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Next due date for a monthly bill on `dueDay`, on/after `from`. */
export function nextDue(from: string, dueDay: number): string {
  const [y, m] = from.split("-").map(Number);
  const mk = (yy: number, mm: number) => {
    const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    return `${yy}-${String(mm).padStart(2, "0")}-${String(Math.min(dueDay, last)).padStart(2, "0")}`;
  };
  const thisMonth = mk(y, m);
  if (thisMonth >= from) return thisMonth;
  return m === 12 ? mk(y + 1, 1) : mk(y, m + 1);
}
