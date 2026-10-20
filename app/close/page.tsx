import { redirect } from "next/navigation";
import { requireSession } from "../../lib/app/auth.ts";
import { asUser } from "../../lib/app/db.ts";
import { accountsFor, bal, submitClose } from "../../lib/app/ledger.ts";
import { Tabs, Top, usd, todayLocal, nowLocalIso, cents } from "../../lib/app/ui.tsx";
import { LivePreview } from "./preview.tsx";

export default async function ClosePage({ searchParams }: { searchParams: Promise<{ date?: string; done?: string; err?: string }> }) {
  const s = await requireSession();
  const store = s.stores[0];
  const sp = await searchParams;
  const date = sp.date ?? todayLocal();

  const data = await asUser(s.uid, async (sql) => {
    const { codes, rows } = await accountsFor(sql, store.id);
    const existing = (await sql<{ id: number; status: string; revision_no: number; net_sales_cents: string; sales_tax_cents: string; payments_total_cents: string; tenders: unknown; expected_drawer_cents: string; counted_drawer_cents: string; submitted_at: string }>(
      "select id, status, revision_no, net_sales_cents::text, sales_tax_cents::text, payments_total_cents::text, tenders, expected_drawer_cents::text, counted_drawer_cents::text, submitted_at::text from public.daily_closes where store_id=$1 and business_date=$2",
      [store.id, date]))[0];
    const exc = existing ? await sql<{ code: string; detail: unknown; resolved_at: string | null }>("select code, detail, resolved_at from public.close_exceptions where close_id=$1 order by id", [existing.id]) : [];
    const drops = await sql<{ amount_cents: string; event_at: string; note: string | null }>(
      "select amount_cents::text, event_at::text, note from public.money_moves where store_id=$1 and business_date=$2 and kind='cash_drop' order by event_at", [store.id, date]);
    return { drawerNow: bal(rows, codes.drawer), existing, exc, drops };
  });

  async function submit(fd: FormData) {
    "use server";
    const s2 = await requireSession();
    const reportText = String(fd.get("report") ?? "");
    const typedAny = ["net", "tax", "cash", "card", "points", "rounding", "check", "ebt"].some((k) => String(fd.get(k) ?? "") !== "");
    const paidouts = [1, 2, 3].map((i) => ({ amount: cents(fd.get(`po${i}`)), reason: String(fd.get(`po${i}r`) ?? "") })).filter((p) => p.amount > 0);
    try {
      await asUser(s2.uid, (sql) => submitClose(sql, s2.uid, {
        storeId: s2.stores[0].id,
        businessDate: String(fd.get("date")),
        reportText,
        typed: !reportText.trim() && typedAny ? {
          netSales: cents(fd.get("net")), salesTax: cents(fd.get("tax")), cash: cents(fd.get("cash")), card: cents(fd.get("card")),
          points: cents(fd.get("points")), rounding: cents(fd.get("rounding")), check: cents(fd.get("check")), ebt: cents(fd.get("ebt")),
        } : null,
        paidouts,
        countedDrawer: cents(fd.get("counted")),
        registerClosedAt: String(fd.get("closedAt")),
        salesCsv: String(fd.get("csv") ?? "") || null,
        secondsEntering: Number(fd.get("secs") ?? 0),
      }));
    } catch (e) {
      redirect(`/close?date=${fd.get("date")}&err=${encodeURIComponent((e as Error).message)}`);
    }
    redirect(`/close?date=${fd.get("date")}&done=1`);
  }

  const ex = data.existing;
  return (
    <main>
      <Top title="Close" s={s} help="End of day. Paste the NRS Store Report, count the drawer, and the app shows over or short before you submit." />
      {sp.err && <div className="notice bad">{sp.err}</div>}
      {sp.done && <div className="notice ok">Close saved. Chelsea verifies it next.</div>}

      <form method="get" className="card">
        <label>Business date</label>
        <input type="date" name="date" defaultValue={date} onChange={undefined} />
        <button className="secondary">Open this date</button>
      </form>

      {ex ? (
        <div className="card">
          <div className="row"><span className="k">Status</span><span className="v"><span className={`tag ${ex.status === "verified" ? "ok" : "warn"}`}>{ex.status}</span> · rev {ex.revision_no}</span></div>
          <div className="row"><span className="k">Net sales</span><span className="v">{usd(ex.net_sales_cents)}</span></div>
          <div className="row"><span className="k">Sales tax</span><span className="v">{usd(ex.sales_tax_cents)}</span></div>
          <div className="row"><span className="k">Payments total</span><span className="v">{usd(ex.payments_total_cents)}</span></div>
          {(ex.tenders as { label: string; tier: string | null; amount_cents: number }[]).map((t, i) => (
            <div className="row" key={i}><span className="k">· {t.label}{t.tier ? ` (${t.tier})` : ""}</span><span className="v">{usd(t.amount_cents)}</span></div>
          ))}
          <div className="row"><span className="k">Expected drawer</span><span className="v">{usd(ex.expected_drawer_cents)}</span></div>
          <div className="row"><span className="k">Counted drawer</span><span className="v">{usd(ex.counted_drawer_cents)}</span></div>
          <div className="row"><span className="k">Over / short</span>
            <span className={`v ${Number(ex.counted_drawer_cents) === Number(ex.expected_drawer_cents) ? "pos" : "warn"}`}>{usd(Number(ex.counted_drawer_cents) - Number(ex.expected_drawer_cents))}</span></div>
          {data.exc.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {data.exc.map((e, i) => <div key={i} className={`notice ${e.resolved_at ? "ok" : "bad"}`}><b>{e.code}</b> {e.resolved_at ? "(resolved)" : ""}<br /><span className="stamp">{JSON.stringify(e.detail)}</span></div>)}
            </div>
          )}
          <div className="stamp">submitted {ex.submitted_at}</div>
        </div>
      ) : (
        <form action={submit} id="close-form">
          <input type="hidden" name="date" value={date} />
          <div className="card">
            <h2 style={{ marginTop: 0 }}>1 · Store Report</h2>
            <p className="mut" style={{ fontSize: 14 }}>On the NRS portal open the Store Report for this date, select all, copy, and paste here. Or type the figures below.</p>
            <label>Paste Store Report text</label>
            <textarea name="report" placeholder="Baskets  Items  Net Sales …" />
            <details>
              <summary className="mut">Type figures instead</summary>
              <div className="grid2">
                <div><label>Net Sales</label><input name="net" inputMode="decimal" placeholder="3408.94" /></div>
                <div><label>Sales Tax</label><input name="tax" inputMode="decimal" placeholder="238.65" /></div>
                <div><label>Cash</label><input name="cash" inputMode="decimal" /></div>
                <div><label>Credit/Debit (Net)</label><input name="card" inputMode="decimal" /></div>
                <div><label>Pay with Points (all tiers)</label><input name="points" inputMode="decimal" /></div>
                <div><label>Cash Rounding (±)</label><input name="rounding" inputMode="decimal" placeholder="-0.02" /></div>
                <div><label>Check</label><input name="check" inputMode="decimal" /></div>
                <div><label>EBT</label><input name="ebt" inputMode="decimal" /></div>
              </div>
            </details>
            <details>
              <summary className="mut">Optional: paste sales_by_day.csv to cross-check</summary>
              <textarea name="csv" placeholder="Store Name:,…" />
            </details>
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0 }}>2 · Paid-outs from the drawer</h2>
            {[1, 2, 3].map((i) => (
              <div className="grid2" key={i}>
                <div><label>Amount</label><input name={`po${i}`} inputMode="decimal" /></div>
                <div><label>Reason</label><input name={`po${i}r`} placeholder="vendor / supplies" /></div>
              </div>
            ))}
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0 }}>3 · Drawer</h2>
            <div className="row"><span className="k">Float carried into today</span><span className="v">{usd(data.drawerNow + data.drops.reduce((a, d) => a + Number(d.amount_cents), 0))}</span></div>
            <div className="row"><span className="k">Drops to safe today</span><span className="v">{data.drops.length} · −{usd(data.drops.reduce((a, d) => a + Number(d.amount_cents), 0))}</span></div>
            <LivePreview drawerNow={data.drawerNow} />
            <label>Register closed at</label>
            <input type="datetime-local" name="closedAt" defaultValue={nowLocalIso()} required />
            <input type="hidden" name="secs" id="secs" value="0" />
          </div>
          <button>Submit close</button>
        </form>
      )}
      <Tabs active="/close" s={s} />
    </main>
  );
}
