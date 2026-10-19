import { redirect } from "next/navigation";
import { requireSession } from "../../lib/app/auth.ts";
import { asUser } from "../../lib/app/db.ts";
import { accountsFor, bal, recordDrop, collectSafe } from "../../lib/app/ledger.ts";
import { Tabs, Top, usd, nowLocalIso, cents } from "../../lib/app/ui.tsx";

export default async function SafePage({ searchParams }: { searchParams: Promise<{ msg?: string; err?: string }> }) {
  const s = await requireSession();
  const store = s.stores[0];
  const sp = await searchParams;
  const data = await asUser(s.uid, async (sql) => {
    const { codes, rows } = await accountsFor(sql, store.id);
    const recent = await sql<{ kind: string; amount_cents: string; event_at: string; note: string | null; full_name: string }>(
      `select m.kind, m.amount_cents::text, m.event_at::text, m.note, p.full_name from public.money_moves m join public.profiles p on p.id = m.created_by
        where m.store_id=$1 and m.kind in ('cash_drop','cash_collect','safe_over','safe_short') order by m.event_at desc limit 12`, [store.id]);
    return { safe: bal(rows, codes.safe), drawer: bal(rows, codes.drawer), collected: bal(rows, codes.collected), recent };
  });

  async function drop(fd: FormData) {
    "use server";
    const s2 = await requireSession();
    const amt = cents(fd.get("amount"));
    if (amt <= 0) redirect("/safe?err=Enter+an+amount");
    try {
      await asUser(s2.uid, (sql) => recordDrop(sql, s2.uid, s2.stores[0].id, amt, String(fd.get("at")), String(fd.get("note") ?? "")));
    } catch (e) { redirect(`/safe?err=${encodeURIComponent((e as Error).message)}`); }
    redirect("/safe?msg=Drop+recorded");
  }
  async function collect(fd: FormData) {
    "use server";
    const s2 = await requireSession();
    try {
      const r = await asUser(s2.uid, (sql) => collectSafe(sql, s2.uid, s2.stores[0].id, cents(fd.get("counted")), String(fd.get("at"))));
      const d = r.counted - r.expected;
      redirect(`/safe?msg=${encodeURIComponent(`Collected ${usd(r.counted)} · expected ${usd(r.expected)} · ${d === 0 ? "exact" : (d > 0 ? "over " : "short ") + usd(Math.abs(d))}`)}`);
    } catch (e) {
      if ((e as Error).message?.startsWith("NEXT_REDIRECT")) throw e;
      redirect(`/safe?err=${encodeURIComponent((e as Error).message)}`);
    }
  }

  return (
    <main>
      <Top title="Safe" s={s} />
      {sp.err && <div className="notice bad">{sp.err}</div>}
      {sp.msg && <div className="notice ok">{sp.msg}</div>}
      <div className="card">
        <div className="row"><span className="k">Expected in safe</span><span className="v big">{usd(data.safe)}</span></div>
        <div className="row"><span className="k">Drawer now</span><span className="v">{usd(data.drawer)}</span></div>
        {store.can_collect && <div className="row"><span className="k">Chelsea holding (Fortville)</span><span className="v">{usd(data.collected)}</span></div>}
      </div>

      <form action={drop} className="card">
        <h2 style={{ marginTop: 0 }}>Drop cash into the safe</h2>
        <label>Amount</label><input name="amount" inputMode="decimal" placeholder="346.55" required />
        <label>When</label><input type="datetime-local" name="at" defaultValue={nowLocalIso()} required />
        <label>Note (optional)</label><input name="note" placeholder="end of shift" />
        <button>Record drop</button>
      </form>

      {store.can_collect && (
        <form action={collect} className="card">
          <h2 style={{ marginTop: 0 }}>Collect the safe (Chelsea)</h2>
          <p className="mut" style={{ fontSize: 14 }}>Count everything in the safe. The difference from expected is recorded as over/short — never hidden.</p>
          <label>Counted</label><input name="counted" inputMode="decimal" required />
          <label>When</label><input type="datetime-local" name="at" defaultValue={nowLocalIso()} required />
          <button>Record collection</button>
        </form>
      )}

      <h2>Recent safe activity</h2>
      <div className="card">
        {data.recent.length === 0 && <div className="mut">Nothing yet.</div>}
        {data.recent.map((m, i) => (
          <div className="row" key={i}>
            <span className="k">{m.event_at.slice(0, 16)} · {m.kind.replace("_", " ")} · {m.full_name}</span>
            <span className={`v ${m.kind === "safe_short" ? "neg" : m.kind === "safe_over" ? "warn" : ""}`}>{usd(m.amount_cents)}</span>
          </div>
        ))}
      </div>
      <Tabs active="/safe" s={s} />
    </main>
  );
}
