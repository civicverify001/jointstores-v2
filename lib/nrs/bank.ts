// Parsers for (1) the NRS CC Report text and (2) the transaction lines of the
// two banks' PDF statements (First Merchants, Old National). Verified on
// Fortville 10/17/2026 CC Report and both September 2026 statements.
//
// Bank lines are classified, never interpreted: the app decides what a
// `merchant_deposit` means (card_clearing -> bank) via posting rules; this
// file only says "this line is a merchant deposit of N cents on date D".

import type { Cents } from "./csv.ts";
import { money } from "./csv.ts";

export interface CcReport {
  from: string; // "10/16/2026 10:30 PM"
  to: string; // "10/17/2026 10:30 PM"
  byBrand: Record<string, Cents>;
  total: Cents;
}

export function parseCcReport(text: string): CcReport {
  const lines = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const range = /^From (.+?) To (.+)$/.exec(lines.find((l) => l.startsWith("From ")) ?? "");
  const byBrand: Record<string, Cents> = {};
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(-?\$[\d,]+\.\d{2})$/.exec(lines[i]);
    if (!m) continue;
    const label = lines[i - 1];
    if (/^Credit Card TOTAL$/i.test(label)) total = money(m[1]);
    else if (/^[A-Z][A-Z ]+$/.test(label) && label !== "Amount") byBrand[label] = money(m[1]);
  }
  return { from: range?.[1] ?? "", to: range?.[2] ?? "", byBrand, total };
}

export type BankLineKind =
  | "merchant_deposit" // NRS Pay card settlement, gross
  | "merchant_fees" // monthly processor fee debit
  | "cash_deposit" // branch/ATM deposit
  | "nrs_subscription" // NATIONAL RETAIL ACH
  | "overdraft_fee"
  | "returned_item"
  | "other";

export interface BankLine {
  date: string; // YYYY-MM-DD (year from the statement period)
  description: string;
  amount: Cents; // positive = credit, negative = debit
  kind: BankLineKind;
  /** stable per-statement key: bank + date + description + amount + ordinal */
  sourceId: string;
}

export type Bank = "first_merchants" | "old_national";

const MONTHS: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

function classify(desc: string): BankLineKind {
  const d = desc.toUpperCase();
  if (/MERCH DEP/.test(d)) return "merchant_deposit";
  if (/MERCH FEES/.test(d)) return "merchant_fees";
  if (/NATIONAL RETAIL/.test(d)) return "nrs_subscription";
  if (/OVERDRAFT|INSUFFICIENT FUNDS/.test(d)) return "overdraft_fee";
  if (/RETURN CHECK|RETURNED/.test(d)) return "returned_item";
  if (/^\s*\d*\s*DEPOSIT\s*$/.test(d) || /\bDEPOSIT$/.test(d.trim())) return "cash_deposit";
  return "other";
}

/**
 * First Merchants: "Sep 02   M MERCHANT/MERCH DEP THE JOINT SMOKE SHOP   2,453.29"
 * Credits and debits are in separate sections; sign comes from the section.
 * Old National: "09/02   1245 M MERCHANT    MERCH DEP   $992.xx" with the
 * merchant name on the following line; debits carry an explicit "-$".
 */
export function parseBankLines(text: string, bank: Bank, year: number): BankLine[] {
  const out: BankLine[] = [];
  const seen = new Map<string, number>();
  const push = (date: string, description: string, amount: Cents) => {
    const key = `${bank}|${date}|${description}|${amount}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    out.push({ date, description, amount, kind: classify(description), sourceId: `${key}|${n}` });
  };
  // Statement PDFs carry a vertical barcode in the left margin that pdftotext
  // emits as 20+ letter tokens (e.g. "AKGMFLOPJPEOLEPMLKGOKOKK"), sometimes on
  // their own line and sometimes glued to the front of a transaction line.
  const BARCODE = /\b[A-Z]{20,}\b/g;
  const lines = text
    .split("\n")
    .map((l) => l.replace(BARCODE, "").trim())
    .filter((l) => l !== "");
  let sign = 1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const s = raw.replace(/\s+/g, " ").trim();
    if (/^(DEPOSITS AND OTHER CREDITS|MISCELLANEOUS CREDITS)/.test(s)) sign = 1;
    else if (/^(WITHDRAWALS AND OTHER DEBITS|MISCELLANEOUS DEBITS|CHECKS)/.test(s)) sign = -1;
    else if (/^DAILY BALANCE/.test(s)) sign = 0;
    if (sign === 0) continue;

    if (bank === "first_merchants") {
      const m = /^([A-Z][a-z]{2}) (\d{2}) (.+?) (-?[\d,]+\.\d{2})$/.exec(s);
      if (!m || !MONTHS[m[1]]) continue;
      push(`${year}-${MONTHS[m[1]]}-${m[2]}`, m[3], sign * money(m[4]));
    } else {
      const m = /^(\d{2})\/(\d{2}) (?:\d+ )?(.+?) (-?\$[\d,]+\.\d{2})$/.exec(s);
      if (!m) continue;
      let desc = m[3];
      const next = (lines[i + 1] ?? "").replace(/\s+/g, " ").trim();
      if (/MERCH DEP|MERCH FEES/.test(desc) && /^[A-Z][A-Z ]+$/.test(next)) desc += " " + next;
      const amt = money(m[4].replace("-$", "-"));
      push(`${year}-${m[1]}-${m[2]}`, desc, amt < 0 ? amt : sign * amt);
    }
  }
  return out;
}

export function bankSummary(lines: BankLine[]) {
  const by = (k: BankLineKind) => lines.filter((l) => l.kind === k);
  const sum = (ls: BankLine[]) => ls.reduce((a, l) => a + l.amount, 0);
  return {
    merchantDeposits: { count: by("merchant_deposit").length, total: sum(by("merchant_deposit")) },
    merchantFees: sum(by("merchant_fees")),
    cashDeposits: { count: by("cash_deposit").length, total: sum(by("cash_deposit")) },
    nrsSubscription: sum(by("nrs_subscription")),
    overdraftFees: sum(by("overdraft_fee")),
    returnedItems: sum(by("returned_item")),
  };
}
