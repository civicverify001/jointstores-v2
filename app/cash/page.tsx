import { redirect } from "next/navigation";
import { requireSession } from "../../lib/app/auth.ts";
import { asUser } from "../../lib/app/db.ts";
import { cashPosition, bal, addSnapshot, setOpening } from "../../lib/app/ledger.ts";
import { Tabs, Top, usd, todayLocal, nowLocalIso, cents } from "../../lib/app/ui.tsx";

export default async function CashPage({ searchParams }: { searchParams: Promise<{ msg?: string; err?: string }> }) {
  const s = await requireSession();
  const store = s.stores[0];
  if (s.role === "employee") redirect("/");
  const sp = await searchParams;
  const today = todayLocal();
  const d = await asUser(s.uid, async (sql) => {
    const cp = await cashPosition(sql, store.id, today);
    const banks = await sql<{ id: number; nickname: string }>(
      "select b.id, b.nickname from public.bank_accounts b join public.stores st on st.entity_id=b.entity_id where st.id=$1", [store.id]);
    const opening = (await sql<{ opening_at: string | null }>("select opening_at::text from public.accounts where code=$1", [cp.codes.drawer]))[0];
    return { ...cp, banks, openingAt: opening?.opening_at ?? null };
  });

  async function snapshot(fd: FormData) {
    "use server";
    const s2 = await requireSession();
    try { await asUser(s2.uid, (sql) => addSnapshot(sql, s2.uid, Number(fd.get("bank")), cents(fd.get("balance")), String(fd.get("asOf")))); }
    catch (e) { redirect(`/cash?err=${encodeURIComponent((e as Error).message)}`); }
    redirect("/cash?msg=Bank+snapshot+saved");
  }
  async function opening(fd: FormData) {
    "use server";
    const s2 = await requireSession();
    const st = s2.stores[0];
    try {
      await asUser(s2.uid, async (sql) => {
        const cp = await cashPosition(sql, st.id, todayLocal());
        await setOpening(sql, s2.uid, st.id, String(fd.get("at")), {
          [cp.codes.drawer]: cents(fd.get("drawer")), [cp.codes.safe]: cents(fd.get("safe")),
          [cp.codes.collected]: cents(fd.get("collected")), [cp.codes.inTransit]: cents(fd.get("inTransit")),
          [cp.codes.cardClearing]: cents(fd.get("clearing")), [cp.codes.variance]: 0,
        });
      });
    } catch (e) { redirect(`/cash?err=${encodeURIComponent((e as Error).message)}`); }
    redirect("/cash?msg=Opening+counts+set");
  }

  const c = d.codes, r = d.rows;
  const lines: [string, string, string?][] = [
    ["Drawer", c.drawer], ["Safe", c.safe], ["Chelsea holding (Fortville)", c.collected],
    ["Deposits in transit", c.inTransit], ["Card clearing (not yet in bank)", c.cardClearing],
    ["Variance to date", c.variance, "var"], ["Loyalty points given (cost)", c.loyalty, "cost"],
  ];
  const fortvilleCash = bal(r, c.drawer) + bal(r, c.safe) + bal(r, c.collected) + bal(r, c.inTransit);
  return (
    <main>
      <Top title="Cash Position" s={s} help="Where every Fortville dollar is right now, and what the bank will look like after this week’s bills." />
      {sp.err && <div className="notice bad">{sp.err}</div>}
      {sp.msg && <div className="notice ok">{sp.msg}</div>}
      <div className="stamp" style={{ marginBottom: 8 }}>
        covers through <b>{d.coverage.d ?? "—"}</b> · received <b>{d.coverage.r?.slice(0, 16) ?? "—"}</b>
      </div>

      <div className="card">
        <div className="row"><span className="k">Fortville cash outside the bank</span><span className="v big">{usd(fortvilleCash)}</span></div>
        {lines.map(([label, code, kind]) => {
          const v = bal(r, code);
          return <div className="row" key={code}><span className="k">{label}</span>
            <span className={`v ${kind === "var" ? (v === 0 ? "pos" : "warn") : kind === "cost" ? "mut" : ""}`}>{usd(v)}</span></div>;
        })}
      </div>

      {store.can_view_bank && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Bank — snapshot, not computed</h2>
          {d.snapshot ? (
            <>
              <div className="row"><span className="k">{d.snapshot.nickname}</span><span className="v big">{usd(d.snapshot.balance_cents)}</span></div>
              <div className="stamp">as of {d.snapshot.as_of.slice(0, 16)}</div>
            </>
          ) : <div className="mut">No snapshot yet — enter one below.</div>}
          {d.projection.projected !== null && (
            <>
              <div className="row" style={{ marginTop: 10 }}><span className="k">+ in transit + card clearing − bills due in 7 days</span>
                <span className={`v big ${d.projection.lowest! < 0 ? "neg" : d.projection.lowest! < 100000 ? "warn" : "pos"}`}>{usd(d.projection.projected)}</span></div>
              {d.projection.dueInWindow.map((b, i) => <div className="row" key={i}><span className="k">{b.dueDate} · {b.payee}</span><span className="v neg">−{usd(b.amount)}</span></div>)}
              {d.projection.lowest! < 0 && <div className="notice bad">Projected to go negative in the next 7 days.</div>}
            </>
          )}
          <form action={snapshot}>
            <label>Bank</label>
            <select name="bank">{d.banks.map((b) => <option key={b.id} value={b.id}>{b.nickname}</option>)}</select>
            <div className="grid2">
              <div><label>Balance in bank app</label><input name="balance" inputMode="decimal" required /></div>
              <div><label>As of</label><input type="datetime-local" name="asOf" defaultValue={nowLocalIso()} required /></div>
            </div>
            <button className="secondary">Save snapshot</button>
          </form>
        </div>
      )}

      {s.role === "owner" && (
        <details className="card">
          <summary>{d.openingAt ? `Opening set ${d.openingAt.slice(0, 16)} — change` : "Set opening counts (cutoff night)"}</summary>
          <form action={opening}>
            <p className="mut" style={{ fontSize: 14 }}>Count on the last night before the pilot. Moves dated before this instant never post.</p>
            <label>Cutoff instant</label><input type="datetime-local" name="at" defaultValue={nowLocalIso()} required />
            <div className="grid2">
              <div><label>Drawer (float)</label><input name="drawer" inputMode="decimal" defaultValue="250.00" /></div>
              <div><label>Safe</label><input name="safe" inputMode="decimal" defaultValue="0" /></div>
              <div><label>Chelsea holding for Fortville</label><input name="collected" inputMode="decimal" defaultValue="0" /></div>
              <div><label>Deposits not yet in bank</label><input name="inTransit" inputMode="decimal" defaultValue="0" /></div>
              <div><label>Card sales not yet settled</label><input name="clearing" inputMode="decimal" defaultValue="0" /></div>
            </div>
            <button className="danger">Set opening</button>
          </form>
        </details>
      )}

      <h2>Corrections</h2>
      <div className="card">
        {d.corrections.length === 0 && <div className="mut">None.</div>}
        {d.corrections.map((x) => <div className="row" key={x.id}><span className="k">{x.created_at.slice(0, 16)} · close {x.business_date}</span><span className="v">{x.reason}</span></div>)}
      </div>
      <Tabs active="/cash" s={s} />
    </main>
  );
}
