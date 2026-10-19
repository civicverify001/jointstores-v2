// Parses the text of the NRS Merchant Portal Store Report and Shift Report
// (Print -> PDF -> text). This is the ONLY place tender lines come from; the CSV
// export carries no tender split. Verified on Fortville 10/17/2026.
//
// Every label is matched verbatim. A tender label we have not seen is returned
// in `unmapped` so the close can raise `unmapped_tender` instead of guessing.

import type { Cents } from "./csv.ts";
import { money } from "./csv.ts";

/** Tender labels NRS printed on 10/17/2026 and the app account each posts to. */
export const TENDER_MAP = {
  Cash: "net_cash_receipts",
  "Credit/Debit (Net)": "net_card_receipts",
  Check: "check_receipts",
  "EBT SNAP": "ebt_receipts",
  "EBT CASH": "ebt_receipts",
  "Pay with Points": "loyalty_redemption", // any "(N points)" tier
  "Cash Rounding": "cash_rounding",
} as const;

export type TenderField = (typeof TENDER_MAP)[keyof typeof TENDER_MAP];

export interface TenderLine {
  label: string; // as printed, tiers folded ("Pay with Points (50 points)" -> "Pay with Points")
  tier: string | null; // "50 points"
  baskets: number;
  amount: Cents;
  field: TenderField | null; // null => unmapped
}

export interface StoreReport {
  baskets: number;
  items: number;
  netSales: Cents;
  taxableSales: Cents;
  salesTax: Cents;
  paymentsTotal: Cents;
  tenders: TenderLine[];
  unmapped: string[];
  cashDrops: { count: number; amount: Cents };
  vendorPayouts: { count: number; amount: Cents };
  refunds: Cents;
  instorePromos: Cents;
  instoreDiscounts: Cents;
  counters: Record<string, number>; // No Sales, Canceled Baskets, Voided Items, ...
  deptSales: { department: string; items: number; amount: Cents }[];
  /** false when the print was cut off before the department "Total" line */
  deptTableComplete: boolean;
}

export interface Shift {
  name: string;
  started: string; // "10/17/2026 02:05 PM"
  closed: string; // "10:01 PM"
  cashIn: Cents; // opening float
  cashGrossSales: Cents;
  vendorPayouts: { count: number; amount: Cents };
  cashDrops: { count: number; amount: Cents };
  cashOnHand: Cents;
}

const sq = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The PDF text wraps long labels onto 2-3 lines ("Pay with" / "Points (100" /
 * "points)"). Join a label's continuation lines back onto the row that holds
 * the numbers. A row "holds numbers" when it has 2+ money/percent tokens.
 */
function joinWrapped(lines: string[]): string[] {
  const out: string[] = [];
  const TENDER_ROW = /^(\S.*?\S)(\s{2,})(\d+\s+\d+%\s+-?\$-?[\d,]+\.\d{2}\s+\d+%)\s*$/;
  let inPayments = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (/^Method\s+Baskets #/.test(sq(line))) inPayments = true;
    if (inPayments && /^\s*Total\s+\d+\s+\d+%/.test(line)) inPayments = false;
    const prev = out[out.length - 1];
    // Inside the Payments table a label can wrap onto 1-2 short lines that carry
    // no $ or %. Fold them back into the label of the previous tender row.
    if (inPayments && prev && !/\$|%/.test(line) && line.trim().length < 20) {
      const m = TENDER_ROW.exec(prev);
      if (m) {
        out[out.length - 1] = `${m[1]} ${line.trim()}${m[2]}${m[3]}`;
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

function countAmount(lines: string[], label: string): { count: number; amount: Cents } {
  // Layout: label on one line, then a count line, then an amount line (or "None").
  const i = lines.findIndex((l) => sq(l).startsWith(label));
  if (i < 0) return { count: 0, amount: 0 };
  const rest = lines.slice(i, i + 4).map(sq);
  const tail = rest[0].slice(label.length).trim();
  if (tail === "None" || rest[1] === "None") return { count: 0, amount: 0 };
  const nums = rest
    .flatMap((l) => l.match(/-?\$?[\d,]+(?:\.\d{2})?/g) ?? [])
    .filter((t) => t !== "");
  const count = nums.find((t) => !t.includes("$") && !t.includes("."));
  const amt = nums.find((t) => t.includes("$"));
  return { count: count ? parseInt(count.replace(/,/g, ""), 10) : 0, amount: amt ? money(amt) : 0 };
}

export function parseStoreReport(text: string): StoreReport {
  const lines = joinWrapped(text.split("\n"));
  const grab = (re: RegExp, from = lines): string | null => {
    for (const l of from) {
      const m = re.exec(sq(l));
      if (m) return m[1];
    }
    return null;
  };

  // Header KPI block prints label row then value row; fall back to regexes on both.
  const kpiLabels = lines.findIndex((l) => /Baskets\s+Items\s+Net Sales/.test(sq(l)));
  const kpiVals = kpiLabels >= 0 ? sq(lines[kpiLabels + 1]).split(" ") : [];
  const baskets = kpiVals[0] ? parseInt(kpiVals[0], 10) : 0;
  const items = kpiVals[1] ? parseInt(kpiVals[1], 10) : 0;
  const netSales = kpiVals[2] ? money(kpiVals[2]) : 0;

  // Payments table: rows like "Cash   38   35%   $870.30   24%"
  const pStart = lines.findIndex((l) => /^Method\s+Baskets #/.test(sq(l)));
  const tenders: TenderLine[] = [];
  const unmapped: string[] = [];
  let paymentsTotal = 0;
  if (pStart >= 0) {
    for (let i = pStart + 1; i < lines.length; i++) {
      const s = sq(lines[i]);
      if (/^Total\s/.test(s)) {
        const m = /\$(-?[\d,]+\.\d{2})/.exec(s);
        paymentsTotal = m ? money(m[1]) : 0;
        break;
      }
      const m = /^(.+?)\s+(\d+)\s+\d+%\s+(-?\$-?[\d,]+\.\d{2})\s+\d+%$/.exec(s);
      if (!m) continue;
      let label = m[1].trim();
      let tier: string | null = null;
      const pm = /^Pay with Points \((.+?)\)$/.exec(label);
      if (pm) {
        tier = pm[1];
        label = "Pay with Points";
      }
      const field = (TENDER_MAP as Record<string, TenderField>)[label] ?? null;
      if (!field) unmapped.push(m[1].trim());
      tenders.push({ label, tier, baskets: parseInt(m[2], 10), amount: money(m[3].replace("$-", "-$").replace("$", "")), field });
    }
  }

  const sMoney = (label: string): Cents => {
    const v = grab(new RegExp(`^${label.replace(/[()]/g, "\\$&")}\\s+(-?\\$[\\d,]+\\.\\d{2})$`));
    return v ? money(v) : 0;
  };
  const promos = grab(/Instore Promos\s+\d+ baskets totaling (\$[\d,]+\.\d{2})/);
  const discounts = grab(/Instore Discounts\s+\d+ items (?:in|on) \d+ baskets (?:for total|totaling) (\$[\d,]+\.\d{2})/);
  const refundsRaw = grab(/^Refunds\s+(.+)$/);

  const counters: Record<string, number> = {};
  for (const name of ["Total No Sales", "Total Canceled Baskets", "Total Cancelled Baskets", "Total Voided Items", "Total Discounted Lines", "Price Overridden Items"]) {
    const i = lines.findIndex((l) => sq(l) === name || sq(l).startsWith(name + " "));
    if (i >= 0) {
      const inline = /(\d+|None)$/.exec(sq(lines[i]).slice(name.length).trim())?.[1];
      const next = sq(lines[i + 1] ?? "");
      const v = inline ?? (/^(\d+|None)$/.test(next) ? next : null);
      if (v !== null) counters[name.replace("Cancelled", "Canceled")] = v === "None" ? 0 : parseInt(v, 10);
    }
  }

  const deptSales: StoreReport["deptSales"] = [];
  let deptTableComplete = false;
  const dStart = lines.findIndex((l) => /^Net Product Sales/.test(sq(l)));
  if (dStart >= 0) {
    for (let i = dStart + 1; i < lines.length; i++) {
      const s = sq(lines[i]);
      if (/^Total\s+\d+\s+\$/.test(s)) {
        deptTableComplete = true;
        break;
      }
      const m = /^(.+?)\s+(\d+)\s+(\$[\d,]+\.\d{2})$/.exec(s);
      if (m && m[1] !== "Department") deptSales.push({ department: m[1], items: parseInt(m[2], 10), amount: money(m[3]) });
    }
  }

  return {
    baskets,
    items,
    netSales,
    taxableSales: sMoney("Taxable Sales"),
    salesTax: sMoney("Sales Tax (Tax)"),
    paymentsTotal,
    tenders,
    unmapped,
    cashDrops: countAmount(lines, "Cash Drops"),
    vendorPayouts: countAmount(lines, "Vendor Payouts"),
    refunds: refundsRaw && refundsRaw !== "None" ? money(refundsRaw) : 0,
    instorePromos: promos ? money(promos) : 0,
    instoreDiscounts: discounts ? money(discounts) : 0,
    counters,
    deptSales,
    deptTableComplete,
  };
}

export function parseShiftReport(text: string): Shift[] {
  const lines = text.split("\n");
  const shifts: Shift[] = [];
  // Each shift block: "<Name>" line, then "<start> - <end>" line, then Cash Summary.
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2} [AP]M) - (\d{2}:\d{2} [AP]M)\s*$/.exec(lines[i]);
    if (!m) continue;
    const name = sq(lines[i - 1] ?? "");
    const block = lines.slice(i, i + 40);
    const val = (label: string): Cents => {
      const l = block.find((x) => sq(x).startsWith(label));
      const v = l ? /(-?\$[\d,]+\.\d{2})\s*$/.exec(l)?.[1] : null;
      return v ? money(v) : 0;
    };
    shifts.push({
      name,
      started: m[1],
      closed: m[2],
      cashIn: val("Cash In"),
      cashGrossSales: val("Cash Gross Sales"),
      vendorPayouts: countAmount(block, "Vendor Payouts"),
      cashDrops: countAmount(block, "Cash Drops"),
      cashOnHand: val("Cash on Hand"),
    });
  }
  return shifts;
}

// ---------- verification (Part B.1 consistency checks) ----------

export type CheckName = "tender_sum" | "net_plus_tax" | "dept_sum" | "drawer_balance" | "csv_matches_report" | "unmapped_tender";
export interface CheckResult {
  check: CheckName;
  ok: boolean;
  expected: Cents;
  actual: Cents;
  note?: string;
}

export function verifyStoreReport(r: StoreReport, shifts: Shift[] = [], csvNetSales?: Cents): CheckResult[] {
  const out: CheckResult[] = [];
  const tenderSum = r.tenders.reduce((a, t) => a + t.amount, 0);
  out.push({ check: "tender_sum", ok: tenderSum === r.paymentsTotal, expected: r.paymentsTotal, actual: tenderSum });
  out.push({ check: "net_plus_tax", ok: r.netSales + r.salesTax === r.paymentsTotal, expected: r.paymentsTotal, actual: r.netSales + r.salesTax });
  const deptSum = r.deptSales.reduce((a, d) => a + d.amount, 0);
  if (r.deptTableComplete) out.push({ check: "dept_sum", ok: deptSum === r.netSales, expected: r.netSales, actual: deptSum });
  else out.push({ check: "dept_sum", ok: true, expected: r.netSales, actual: deptSum, note: "department table cut off in the print; department sales taken from deptsales_by_day.csv" });
  out.push({ check: "unmapped_tender", ok: r.unmapped.length === 0, expected: 0, actual: r.unmapped.length, note: r.unmapped.join("; ") || undefined });
  if (shifts.length) {
    // Cash − payouts − drops should equal what stayed in the drawers above float.
    const cash = r.tenders.filter((t) => t.field === "net_cash_receipts").reduce((a, t) => a + t.amount, 0);
    const left = cash - r.vendorPayouts.amount - r.cashDrops.amount;
    const drawers = shifts.reduce((a, s) => a + (s.cashOnHand - s.cashIn), 0);
    out.push({ check: "drawer_balance", ok: Math.abs(left - drawers) <= 500, expected: drawers, actual: left, note: "tolerance $5.00; a gap is a drawer_variance prompt, not a failure" });
  }
  if (csvNetSales !== undefined) {
    out.push({ check: "csv_matches_report", ok: csvNetSales === r.netSales, expected: r.netSales, actual: csvNetSales });
  }
  return out;
}
