// Part C acceptance tests that live in the posting rules (the DB-level ones are in test/sql).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStoreReport, parseShiftReport, type StoreReport } from "../lib/nrs/report.ts";
import {
  movesForClose, tenderMismatch, expectedDrawer, drawerVariance, collectionMoves, dropsFromShifts,
  balances, projectedBalance, nextDue, UnmappedTender, type StoreAccounts,
} from "../lib/ledger/posting.ts";

const A: StoreAccounts = {
  drawer: "drawer:fortville", safe: "safe:fortville", collected: "collected:chelsea:fortville",
  inTransit: "in_transit:fortville", cardClearing: "card_clearing:fortville", variance: "variance:fortville",
  loyalty: "loyalty:fortville", rounding: "rounding:fortville", customers: "external:customers",
  vendors: "external:vendors", bank: "bank:first_merchants",
};
const F = join(import.meta.dirname, "fixtures", "fortville-2026-10-17");
const read = (n: string) => readFileSync(join(F, n), "utf8");
const AT = "2026-10-17T22:01:00";

function report(over: Partial<StoreReport> = {}): StoreReport {
  return { ...parseStoreReport(read("store_report.txt")), ...over };
}

test("real 10/17 close: moves per the tender map", () => {
  const moves = movesForClose(A, { report: report(), paidouts: [], registerClosedAt: AT });
  const by = Object.fromEntries(moves.map((m) => [m.kind, m]));
  assert.equal(by.cash_sale.amount, 87030);
  assert.equal(by.card_sale.amount, 267981);
  assert.equal(by.card_sale.to, A.cardClearing);
  assert.equal(by.loyalty_redemption.amount, 9750);
  assert.equal(by.loyalty_redemption.from, A.loyalty); // store-funded, never cash
  assert.equal(by.cash_rounding.amount, 2);
  assert.equal(by.cash_rounding.from, A.drawer); // drawer took 2c less
  assert.equal(moves.length, 4);
  assert.equal(tenderMismatch(report()), null);
});

test("C-1 tender map with refunds and EBT", () => {
  const r = report({
    netSales: 100000 + 13000 - 13000, salesTax: 13000, paymentsTotal: 193000,
    tenders: [
      { label: "Cash", tier: null, baskets: 1, amount: 98000, field: "net_cash_receipts" }, // 1,000 − 20 refund
      { label: "Credit/Debit (Net)", tier: null, baskets: 1, amount: 90000, field: "net_card_receipts" },
      { label: "EBT SNAP", tier: null, baskets: 1, amount: 5000, field: "ebt_receipts" },
    ],
    unmapped: [],
  });
  const moves = movesForClose(A, { report: r, paidouts: [], registerClosedAt: AT });
  assert.equal(moves.find((m) => m.kind === "cash_sale")?.amount, 98000);
  assert.equal(moves.find((m) => m.kind === "card_sale")?.amount, 90000);
  assert.equal(moves.find((m) => m.kind === "ebt_sale")?.amount, 5000);
  assert.equal(tenderMismatch({ ...r, netSales: 180000 }), null); // 98000+90000+5000 = 193000 = 180000+13000
});

test("C-2 unmapped tender blocks posting, names the tender", () => {
  const r = report({ unmapped: ["House Acct"], tenders: [...report().tenders, { label: "House Acct", tier: null, baskets: 1, amount: 7500, field: null }] });
  assert.throws(() => movesForClose(A, { report: r, paidouts: [], registerClosedAt: AT }), (e: unknown) => e instanceof UnmappedTender && e.labels[0] === "House Acct");
});

test("C-3 / C-7 drops and float carry: expected drawer has no float field", () => {
  const day1 = movesForClose(A, { report: report(), paidouts: [], registerClosedAt: AT });
  const drops = dropsFromShifts(A, parseShiftReport(read("shift_report.txt")), "2026-10-17");
  assert.equal(drops.length, 1);
  assert.equal(drops[0].amount, 34655);
  assert.equal(drops[0].eventAt, "2026-10-17T22:01:00");
  // Only Rylie's shift was expanded in the print; add Jessi's drop by hand for the day total
  const allDrops = [...drops, { kind: "cash_drop" as const, from: A.drawer, to: A.safe, amount: 52330, eventAt: "2026-10-17T13:57:00" }];
  const exp = expectedDrawer(25000, [...day1, ...allDrops], A);
  assert.equal(exp, 25000 + 87030 - 2 - 86985); // 25043
  const v = drawerVariance(A, exp, 25045, AT);
  assert.equal(v?.kind, "drawer_over");
  assert.equal(v?.amount, 2);
  // C-7 numbers from the plan
  const d2 = expectedDrawer(15000, [
    { kind: "cash_sale", from: A.customers, to: A.drawer, amount: 50000, eventAt: AT },
    { kind: "cash_paid_out", from: A.drawer, to: A.vendors, amount: 3000, eventAt: AT },
    { kind: "cash_drop", from: A.drawer, to: A.safe, amount: 40000, eventAt: AT },
  ], A);
  assert.equal(d2, 22000);
  assert.equal(drawerVariance(A, 22000, 22000, AT), null);
});

test("C-4 collection: expected 800, counted 795 → collect 795 + safe_short 5", () => {
  const m = collectionMoves(A, 80000, 79500, "2026-10-18T10:00:00");
  assert.deepEqual(m.map((x) => [x.kind, x.amount]), [["cash_collect", 79500], ["safe_short", 500]]);
  const bal = balances([{ code: A.safe, openingAt: null, balance: 80000 }], m);
  assert.equal(bal.get(A.safe), 0);
  assert.equal(bal.get(A.collected), 79500);
  assert.equal(bal.get(A.variance), 500);
});

test("C-8 card clearing: opening 1,800 + day 900 − settlement 2,700 (fee billed monthly) = 0", () => {
  const moves = [
    { kind: "card_sale" as const, from: A.customers, to: A.cardClearing, amount: 90000, eventAt: "2026-10-17T22:00:00" },
    { kind: "card_settlement" as const, from: A.cardClearing, to: A.bank, amount: 270000, eventAt: "2026-10-20T09:00:00" },
  ];
  const bal = balances([{ code: A.cardClearing, openingAt: "2026-10-16T23:59:00", balance: 180000 }], moves);
  assert.equal(bal.get(A.cardClearing), 0);
});

test("C-6 cutoff in balances: a move dated before opening_at does not count", () => {
  const bal = balances([{ code: A.drawer, openingAt: "2026-10-16T23:59:00", balance: 25000 }], [
    { kind: "cash_sale", from: A.customers, to: A.drawer, amount: 100, eventAt: "2026-10-16T20:00:00" },
  ]);
  assert.equal(bal.get(A.drawer), 25000);
});

test("projected balance (Cash Position): snapshot + in transit + clearing − bills in 7 days", () => {
  const r = projectedBalance({
    snapshot: { balance: 470559, asOf: "2026-09-30T17:00:00" },
    inTransit: 86485,
    cardClearing: 267981,
    bills: [
      { payee: "325 Holdings (rent)", amount: 228651, dueDate: "2026-10-01" },
      { payee: "NRS", amount: 5345, dueDate: "2026-10-02" },
      { payee: "Merch fees", amount: 216355, dueDate: "2026-10-02" },
      { payee: "Duke Energy", amount: 23287, dueDate: "2026-10-08" },
      { payee: "later", amount: 999999, dueDate: "2026-10-20" },
    ],
    from: "2026-10-01",
    days: 7,
  });
  assert.equal(r.dueInWindow.length, 4);
  assert.equal(r.projected, 470559 + 86485 + 267981 - 228651 - 5345 - 216355 - 23287);
  assert.equal(r.lowest, r.projected);
  assert.equal(projectedBalance({ snapshot: null, inTransit: 1, cardClearing: 1, bills: [], from: "2026-10-01", days: 7 }).projected, null);
});

test("nextDue handles month ends and rollover", () => {
  assert.equal(nextDue("2026-10-18", 1), "2026-11-01");
  assert.equal(nextDue("2026-10-18", 31), "2026-10-31");
  assert.equal(nextDue("2026-11-05", 31), "2026-11-30");
  assert.equal(nextDue("2026-12-20", 15), "2027-01-15");
});
