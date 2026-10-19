// Acceptance tests against the real Fortville 10/17/2026 export set.
// Every expected number below is read off the printed NRS Store Report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSalesByDay,
  parseDeptSalesByDay,
  parseItemSalesByDay,
  parseHourly,
  parseBaskets,
  summarizeBaskets,
  money,
  unexcel,
} from "../lib/nrs/csv.ts";
import { parseStoreReport, parseShiftReport, verifyStoreReport } from "../lib/nrs/report.ts";

const F = join(import.meta.dirname, "fixtures", "fortville-2026-10-17");
const read = (n: string) => readFileSync(join(F, n), "utf8");

const NET_SALES = 340894;
const SALES_TAX = 23865;
const PAYMENTS = 364759;

test("money + unexcel helpers", () => {
  assert.equal(money("$1,126.79"), 112679);
  assert.equal(money("-$0.02"), -2);
  assert.equal(money(""), 0);
  assert.equal(unexcel('="VAPES"'), "VAPES");
  assert.equal(unexcel("Papers, Cones, Tips"), "Papers, Cones, Tips");
  assert.throws(() => money("abc"));
});

test("sales_by_day: metadata identifies the store; net sales ties", () => {
  const { meta, rows } = parseSalesByDay(read("sales_by_day.csv"));
  assert.equal(meta.city, "Fortville");
  assert.equal(meta.zip, "46040");
  assert.equal(meta.address, "325 W Broadway St Suit B");
  assert.equal(rows[0].date, "2026-10-17");
  assert.equal(rows[0].netSales, NET_SALES);
  assert.equal(rows[0].baskets, 110);
  assert.equal(rows[0].items, 308);
  assert.equal(rows[1].netSales, 0); // the "To" date is empty
});

test("deptsales_by_day sums to net sales", () => {
  const { rows } = parseDeptSalesByDay(read("deptsales_by_day.csv"));
  assert.equal(rows.length, 20);
  assert.equal(rows.reduce((a, r) => a + r.netSales, 0), NET_SALES);
  assert.equal(rows.find((r) => r.department === "CIGARETTES")?.netSales, 112679);
});

test("itemsales_by_day sums to net sales; blank-UPC rows are the no-barcode report", () => {
  const { rows } = parseItemSalesByDay(read("itemsales_by_day.csv"));
  assert.equal(rows.reduce((a, r) => a + r.netSales, 0), NET_SALES);
  const noUpc = rows.filter((r) => r.upc === "");
  assert.equal(noUpc.reduce((a, r) => a + r.netSales, 0), 23279);
  assert.equal(noUpc.find((r) => r.department === "DELTA/CBD")?.netSales, 8627);
});

test("periodic_sales_by_day: 24 hours, sums to net sales, store hours visible", () => {
  const h = parseHourly(read("periodic_sales_by_day.csv"));
  assert.equal(h.length, 24);
  assert.equal(h.reduce((a, r) => a + r.netSales, 0), NET_SALES);
  const active = h.filter((r) => r.baskets > 0).map((r) => r.hour);
  assert.equal(Math.min(...active), 8);
  assert.equal(Math.max(...active), 21);
});

test("baskets.csv: line items reconcile to the report and to themselves", () => {
  const lines = parseBaskets(read("baskets.csv"));
  const s = summarizeBaskets(lines);
  assert.equal(s.baskets, 110);
  assert.equal(s.items, 308);
  assert.equal(s.lines, 162);
  assert.equal(s.netSales, NET_SALES);
  assert.equal(s.discounts, 1565); // "Instore Discounts ... totaling $15.65"
  assert.equal(s.promos, 1620); // "Instore Promos 6 baskets totaling $16.20"
  assert.deepEqual(s.mismatched, []);
  assert.equal(s.noBarcode.lines, 28);
  assert.equal(s.noBarcode.netSales, 23279);
  assert.equal(s.firstSale, "2026-10-17T08:33");
  assert.equal(s.lastSale, "2026-10-17T21:05");
  assert.equal(lines[0].department, "VAPES"); // ="VAPES" unescaped
  assert.equal(lines[0].verifiedAge, 21);
});

test("Store Report: tender map covers every printed line", () => {
  const r = parseStoreReport(read("store_report.txt"));
  assert.equal(r.baskets, 110);
  assert.equal(r.items, 308);
  assert.equal(r.netSales, NET_SALES);
  assert.equal(r.taxableSales, NET_SALES);
  assert.equal(r.salesTax, SALES_TAX);
  assert.equal(r.paymentsTotal, PAYMENTS);
  assert.deepEqual(r.unmapped, []);
  const by = (label: string) => r.tenders.filter((t) => t.label === label).reduce((a, t) => a + t.amount, 0);
  assert.equal(by("Cash"), 87030);
  assert.equal(by("Credit/Debit (Net)"), 267981);
  assert.equal(by("Pay with Points"), 9750);
  assert.equal(r.tenders.filter((t) => t.label === "Pay with Points").length, 4);
  assert.equal(by("Cash Rounding"), -2);
  assert.equal(by("Check"), 0);
  assert.deepEqual(r.cashDrops, { count: 2, amount: 86985 });
  assert.deepEqual(r.vendorPayouts, { count: 0, amount: 0 });
  assert.equal(r.instorePromos, 1620);
  assert.equal(r.instoreDiscounts, 1565);
  assert.equal(r.counters["Total No Sales"], 6);
  assert.equal(r.counters["Total Canceled Baskets"], 8);
  assert.equal(r.counters["Total Voided Items"], 1);
  // The browser print cut the department table off after "Tobacco"; the parser must say so.
  assert.equal(r.deptTableComplete, false);
  assert.equal(r.deptSales.length, 16);
  assert.equal(r.deptSales.find((d) => d.department === "CIGARETTES")?.amount, 112679);
});

test("Store Report: a complete department table must sum to net sales", () => {
  const txt = read("store_report.txt") + "\nTUBES 4 $11.17\nVAPE JUICE 2 $32.28\nVAPES 33 $911.35\nWraps 38 $65.92\nTotal 308 $3,408.94\n";
  const r = parseStoreReport(txt);
  assert.equal(r.deptTableComplete, true);
  assert.equal(r.deptSales.length, 20);
  assert.equal(verifyStoreReport(r).find((c) => c.check === "dept_sum")?.ok, true);
});

test("Shift Report: float in, drops out, drawer back to float", () => {
  const shifts = parseShiftReport(read("shift_report.txt"));
  assert.equal(shifts.length, 1); // this print only expanded Rylie's shift
  const s = shifts[0];
  assert.equal(s.name, "Rylie");
  assert.equal(s.cashIn, 25000);
  assert.equal(s.cashGrossSales, 34680);
  assert.deepEqual(s.cashDrops, { count: 1, amount: 34655 });
  assert.equal(s.cashOnHand, 25025);
  assert.equal(s.cashIn + s.cashGrossSales - s.vendorPayouts.amount - s.cashDrops.amount, s.cashOnHand);
});

test("verification: all four B.1 identities hold on the real day", () => {
  const r = parseStoreReport(read("store_report.txt"));
  const { rows } = parseSalesByDay(read("sales_by_day.csv"));
  const results = verifyStoreReport(r, [], rows[0].netSales);
  for (const c of results) assert.ok(c.ok, `${c.check}: expected ${c.expected} got ${c.actual} ${c.note ?? ""}`);
});

test("verification: an unknown tender label blocks, it never guesses", () => {
  const txt = read("store_report.txt").replace(/^(\s*)Check(\s+0\s+0%\s+\$0\.00\s+0%)/m, "$1Gift Card$2");
  const r = parseStoreReport(txt);
  assert.deepEqual(r.unmapped, ["Gift Card"]);
  const bad = verifyStoreReport(r).find((c) => c.check === "unmapped_tender");
  assert.equal(bad?.ok, false);
});
