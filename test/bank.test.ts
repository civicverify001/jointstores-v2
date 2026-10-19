import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCcReport, parseBankLines, bankSummary } from "../lib/nrs/bank.ts";
import { parseStoreReport } from "../lib/nrs/report.ts";

const F = join(import.meta.dirname, "fixtures");
const read = (...p: string[]) => readFileSync(join(F, ...p), "utf8");

test("CC Report: brands sum to Credit/Debit (Net) on the Store Report", () => {
  const cc = parseCcReport(read("fortville-2026-10-17", "cc_report.txt"));
  assert.equal(cc.from, "10/16/2026 10:30 PM");
  assert.equal(cc.to, "10/17/2026 10:30 PM");
  assert.deepEqual(cc.byBrand, { DISCOVER: 5149, MASTERCARD: 98590, VISA: 164242 });
  assert.equal(Object.values(cc.byBrand).reduce((a, b) => a + b, 0), cc.total);
  const sr = parseStoreReport(read("fortville-2026-10-17", "store_report.txt"));
  const card = sr.tenders.filter((t) => t.field === "net_card_receipts").reduce((a, t) => a + t.amount, 0);
  assert.equal(cc.total, card); // 267981
});

test("First Merchants (Fortville): merchant deposits, fees, cash deposits classified", () => {
  const ls = parseBankLines(read("bank-2026-09", "first_merchants_fortville.txt"), "first_merchants", 2026);
  const s = bankSummary(ls);
  assert.equal(s.merchantDeposits.count, 30);
  assert.equal(ls.find((l) => l.date === "2026-09-02" && l.kind === "merchant_deposit")?.amount, 245329);
  assert.equal(s.merchantFees, -216355); // one monthly "MERCH FEES" on Sep 02
  assert.equal(s.cashDeposits.count, 5);
  assert.equal(s.cashDeposits.total, 347000 + 336500 + 700800 + 338200 + 432100);
  assert.equal(s.nrsSubscription, -5345);
  assert.equal(s.overdraftFees, -7400);
  assert.ok(ls.every((l) => l.kind !== "merchant_deposit" || l.amount > 0));
  // same date+desc+amount twice must get distinct ids (idempotent import)
  const ids = new Set(ls.map((l) => l.sourceId));
  assert.equal(ids.size, ls.length);
});

test("Old National (Lebanon): two-line merchant deposit descriptions, explicit negative debits", () => {
  const ls = parseBankLines(read("bank-2026-09", "old_national_lebanon.txt"), "old_national", 2026);
  const s = bankSummary(ls);
  assert.equal(s.merchantDeposits.count, 29);
  assert.equal(ls[0].description, "M MERCHANT MERCH DEP THE JOINT SMOKE SHOP");
  assert.equal(ls[0].amount, 98796);
  assert.equal(s.merchantFees, -120423);
  assert.equal(s.nrsSubscription, -5345);
  assert.ok(s.cashDeposits.count >= 4);
});
