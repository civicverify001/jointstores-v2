// Parsers for the five CSV files the NRS Merchant Portal "Data" button exports
// from the Store Report. Verified against Fortville (terminal 60230) 10/17/2026.
//
// All money is returned in integer cents. Nothing here posts anything; these
// functions only turn files into typed rows that the close screen can verify.

export type Cents = number;

export interface StoreMeta {
  storeName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  from: string; // MM/DD/YYYY as printed
  to: string;
  runTime: string;
}

export interface SalesByDay {
  date: string; // YYYY-MM-DD
  baskets: number;
  items: number;
  netSales: Cents;
  scanSales: Cents;
  scanRate: number; // percent
}

export interface DeptSalesByDay extends SalesByDay {
  department: string;
}

export interface ItemSalesByDay extends DeptSalesByDay {
  upc: string; // "" when the line was rung without a barcode
  item: string;
}

export interface HourlySales {
  hour: number; // 0-23
  baskets: number;
  items: number;
  netSales: Cents;
}

export interface BasketLine {
  basketId: string;
  opened: string; // ISO local, no zone (NRS prints store-local time)
  closed: string;
  itemNo: number;
  department: string;
  upc: string;
  name: string;
  qty: number;
  itemTotal: Cents;
  discount: Cents; // discount_cents column
  promoAdj: Cents; // soldat_promoadj column (cents)
  refund: Cents;
  verifiedAge: number | null;
  basketTotal: Cents | null; // only on the basket's last line
}

// ---------- low-level ----------

/** Minimal RFC-4180 CSV splitter (quotes, embedded commas, CRLF). */
export function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** "$1,126.79" | "1126.79" | "" -> cents. Throws on garbage so bad files fail loudly. */
export function money(s: string): Cents {
  const t = (s ?? "").trim().replace(/[$,]/g, "");
  if (t === "") return 0;
  const neg = t.startsWith("-");
  const m = /^-?(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) throw new Error(`not money: ${JSON.stringify(s)}`);
  const c = parseInt(m[1], 10) * 100 + parseInt((m[2] ?? "0").padEnd(2, "0"), 10);
  return neg ? -c : c;
}

/** NRS escapes some text cells for Excel: ="VAPES"  -> VAPES */
export function unexcel(s: string): string {
  const t = (s ?? "").trim();
  const m = /^="?(.*?)"?$/.exec(t);
  return (m ? m[1] : t).trim();
}

function num(s: string): number {
  const t = (s ?? "").trim().replace(/,/g, "");
  return t === "" ? 0 : Number(t);
}

/**
 * The *_by_day files start with a 5-line metadata block, a blank line, then the
 * header. periodic_sales_by_day and baskets have no block. Returns meta (or
 * null) and the index of the header row.
 */
export function readMeta(rows: string[][]): { meta: StoreMeta | null; headerIdx: number } {
  if (rows[0]?.[0]?.trim() === "Store Name:") {
    const r = (i: number) => rows[i] ?? [];
    const addr = r(1);
    const meta: StoreMeta = {
      storeName: r(0)[1]?.trim() ?? "",
      address: addr[1]?.trim() ?? "",
      city: addr[3]?.trim() ?? "",
      state: addr[5]?.trim() ?? "",
      zip: addr[7]?.trim() ?? "",
      from: r(3)[1]?.trim() ?? "",
      to: r(3)[3]?.trim() ?? "",
      runTime: (r(4)[1] ?? "").trim() + " " + (r(4)[2] ?? "").trim(),
    };
    let i = 5;
    while (i < rows.length && rows[i].every((c) => c.trim() === "")) i++;
    return { meta, headerIdx: i };
  }
  return { meta: null, headerIdx: 0 };
}

function table(text: string): { meta: StoreMeta | null; header: string[]; body: string[][] } {
  const rows = splitCsv(text);
  const { meta, headerIdx } = readMeta(rows);
  const header = rows[headerIdx].map((h) => h.trim());
  const body = rows.slice(headerIdx + 1).filter((r) => r.some((c) => c.trim() !== "") && r.length >= header.length - 1);
  return { meta, header, body };
}

function col(header: string[], name: string): number {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`column "${name}" missing; have ${header.join(" | ")}`);
  return i;
}

// ---------- the five files ----------

export function parseSalesByDay(text: string): { meta: StoreMeta; rows: SalesByDay[] } {
  const { meta, header, body } = table(text);
  if (!meta) throw new Error("sales_by_day.csv: metadata block missing");
  const c = (n: string) => col(header, n);
  const rows = body.map((r) => ({
    date: r[c("Date")].trim(),
    baskets: num(r[c("# of Baskets")]),
    items: num(r[c("# of Items")]),
    netSales: money(r[c("Sales $")]),
    scanSales: money(r[c("Scan Sales")]),
    scanRate: num(r[c("Scan Rate")]),
  }));
  return { meta, rows };
}

export function parseDeptSalesByDay(text: string): { meta: StoreMeta; rows: DeptSalesByDay[] } {
  const { meta, header, body } = table(text);
  if (!meta) throw new Error("deptsales_by_day.csv: metadata block missing");
  const c = (n: string) => col(header, n);
  const rows = body.map((r) => ({
    date: r[c("Date")].trim(),
    department: unexcel(r[c("Department")]),
    baskets: num(r[c("# of Baskets")]),
    items: num(r[c("# of Items")]),
    netSales: money(r[c("Sales $")]),
    scanSales: money(r[c("Scan Sales")]),
    scanRate: num(r[c("Scan Rate")]),
  }));
  return { meta, rows };
}

export function parseItemSalesByDay(text: string): { meta: StoreMeta; rows: ItemSalesByDay[] } {
  const { meta, header, body } = table(text);
  if (!meta) throw new Error("itemsales_by_day.csv: metadata block missing");
  const c = (n: string) => col(header, n);
  const rows = body.map((r) => ({
    date: r[c("Date")].trim(),
    department: unexcel(r[c("Department")]),
    upc: unexcel(r[c("UPC")]),
    item: r[c("Item")].trim(),
    baskets: num(r[c("# of Baskets")]),
    items: num(r[c("# of Items")]),
    netSales: money(r[c("Sales $")]),
    scanSales: money(r[c("Scan Sales")]),
    scanRate: num(r[c("Scan Rate")]),
  }));
  return { meta, rows };
}

export function parseHourly(text: string): HourlySales[] {
  const { header, body } = table(text);
  const c = (n: string) => col(header, n);
  return body.map((r) => {
    const label = r[c("Hour of Day")].trim(); // "12 AM" .. "11 PM"
    const m = /^(\d{1,2})\s*(AM|PM)$/i.exec(label);
    if (!m) throw new Error(`bad hour label ${label}`);
    let h = parseInt(m[1], 10) % 12;
    if (m[2].toUpperCase() === "PM") h += 12;
    return {
      hour: h,
      baskets: num(r[c("# of Baskets")]),
      items: num(r[c("# of Items")]),
      netSales: money(r[c("Sales $")]),
    };
  });
}

export function parseBaskets(text: string): BasketLine[] {
  const { header, body } = table(text);
  const c = (n: string) => col(header, n);
  return body
    .filter((r) => r[c("basket")].trim() !== "") // trailing ,="" junk row
    .map((r) => {
      const va = r[c("verified_age")].trim();
      const bt = r[c("basket_total")].trim();
      return {
        basketId: r[c("basket")].trim(),
        opened: r[c("opened")].trim().replace(" ", "T"),
        closed: r[c("closed")].trim(),
        itemNo: num(r[c("itemno")]),
        department: unexcel(r[c("dept")]),
        upc: unexcel(r[c("upc_plu")]),
        name: r[c("name")].trim(),
        qty: num(r[c("qty")]),
        itemTotal: money(r[c("item_total")]),
        discount: num(r[c("discount_cents")]),
        promoAdj: num(r[c("soldat_promoadj")]),
        refund: money(r[c("refund")]),
        verifiedAge: va === "" ? null : num(va),
        basketTotal: bt === "" ? null : money(bt),
      };
    });
}

// ---------- derived ----------

export interface BasketSummary {
  baskets: number;
  lines: number;
  items: number;
  netSales: Cents;
  discounts: Cents;
  promos: Cents;
  noBarcode: { lines: number; netSales: Cents; byDept: Record<string, Cents> };
  firstSale: string;
  lastSale: string;
  /** baskets whose line sum != basket_total (should be empty) */
  mismatched: string[];
}

export function summarizeBaskets(lines: BasketLine[]): BasketSummary {
  const byBasket = new Map<string, BasketLine[]>();
  for (const l of lines) {
    const arr = byBasket.get(l.basketId) ?? [];
    arr.push(l);
    byBasket.set(l.basketId, arr);
  }
  const mismatched: string[] = [];
  for (const [id, ls] of byBasket) {
    const sum = ls.reduce((a, l) => a + l.itemTotal, 0);
    const last = ls[ls.length - 1].basketTotal;
    if (last === null || last !== sum) mismatched.push(id);
  }
  const nb = lines.filter((l) => l.upc === "");
  const byDept: Record<string, Cents> = {};
  for (const l of nb) byDept[l.department] = (byDept[l.department] ?? 0) + l.itemTotal;
  const closed = lines.map((l) => l.closed).sort();
  return {
    baskets: byBasket.size,
    lines: lines.length,
    items: lines.reduce((a, l) => a + l.qty, 0),
    netSales: lines.reduce((a, l) => a + l.itemTotal, 0),
    discounts: lines.reduce((a, l) => a + l.discount, 0),
    promos: lines.reduce((a, l) => a + l.promoAdj, 0),
    noBarcode: { lines: nb.length, netSales: nb.reduce((a, l) => a + l.itemTotal, 0), byDept },
    firstSale: closed[0] ?? "",
    lastSale: closed[closed.length - 1] ?? "",
    mismatched,
  };
}
