"use client";
// Live "expected vs counted" before submit (Part I, screen 1). Uses the same
// parser as the server; the server recomputes everything on submit anyway.
import { useEffect, useState } from "react";
import { parseStoreReport } from "../../lib/nrs/report.ts";

const toCents = (v: string) => Math.round(Number(v.replace(/[$,]/g, "")) * 100) || 0;
const usd = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

export function LivePreview({ drawerNow }: { drawerNow: number }) {
  const [counted, setCounted] = useState("");
  const [expected, setExpected] = useState(drawerNow);
  const [parsed, setParsed] = useState<string | null>(null);
  const [started] = useState(() => Date.now());

  useEffect(() => {
    const form = document.getElementById("close-form") as HTMLFormElement | null;
    if (!form) return;
    const recompute = () => {
      const fd = new FormData(form);
      const report = String(fd.get("report") ?? "");
      let cash = 0, rounding = 0;
      if (report.trim()) {
        try {
          const r = parseStoreReport(report);
          cash = r.tenders.filter((t) => t.field === "net_cash_receipts").reduce((a, t) => a + t.amount, 0);
          rounding = r.tenders.filter((t) => t.field === "cash_rounding").reduce((a, t) => a + t.amount, 0);
          setParsed(`Read: net ${usd(r.netSales)} · tax ${usd(r.salesTax)} · cash ${usd(cash)} · card ${usd(r.tenders.filter((t) => t.field === "net_card_receipts").reduce((a, t) => a + t.amount, 0))}${r.unmapped.length ? ` · UNMAPPED: ${r.unmapped.join(", ")}` : ""}`);
        } catch {
          setParsed("Could not read the pasted text yet.");
        }
      } else {
        setParsed(null);
        cash = toCents(String(fd.get("cash") ?? ""));
        rounding = toCents(String(fd.get("rounding") ?? ""));
      }
      const po = [1, 2, 3].reduce((a, i) => a + toCents(String(fd.get(`po${i}`) ?? "")), 0);
      setExpected(drawerNow + cash + rounding - po);
      const secs = form.querySelector<HTMLInputElement>("#secs");
      if (secs) secs.value = String(Math.round((Date.now() - started) / 1000));
    };
    form.addEventListener("input", recompute);
    recompute();
    return () => form.removeEventListener("input", recompute);
  }, [drawerNow, started]);

  const c = toCents(counted);
  const diff = c - expected;
  return (
    <div>
      {parsed && <div className="notice">{parsed}</div>}
      <div className="row"><span className="k">Expected drawer</span><span className="v">{usd(expected)}</span></div>
      <label>Counted drawer (everything in the drawer)</label>
      <input name="counted" inputMode="decimal" placeholder="250.00" value={counted} onChange={(e) => setCounted(e.target.value)} required />
      {counted !== "" && (
        <div className={`big ${diff === 0 ? "pos" : Math.abs(diff) < 500 ? "warn" : "neg"}`} style={{ marginTop: 8 }}>
          {diff === 0 ? "Exact" : `${diff > 0 ? "Over" : "Short"} ${usd(Math.abs(diff))}`}
        </div>
      )}
    </div>
  );
}
