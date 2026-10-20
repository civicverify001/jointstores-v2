import Link from "next/link";
import { requireSession } from "../lib/app/auth.ts";
import { asUser } from "../lib/app/db.ts";
import { accountsFor, bal } from "../lib/app/ledger.ts";
import { Tabs, Top, HowItWorks, usd, todayLocal } from "../lib/app/ui.tsx";

function nextStep(role: string, closed: boolean, status: string | undefined, safe: number): string {
  if (role === "employee") return closed ? "Done for today. Any more cash for the safe goes in the Safe tab." : "Record safe drops as you make them, then Close the register at the end of the day.";
  if (role === "manager") {
    if (closed && status === "submitted") return "A close is waiting: Deposit tab → Verify.";
    if (safe > 0) return "Cash is in the safe: Safe tab → Collect, then Deposit.";
    return "Nothing waiting. Cash tab shows today's position.";
  }
  return "Enter today's bank balance on Cash; mark deposits cleared when they show on the statement.";
}

export default async function Home() {
  const s = await requireSession();
  const store = s.stores[0];
  const today = todayLocal();
  const data = await asUser(s.uid, async (sql) => {
    const { codes, rows } = await accountsFor(sql, store.id);
    const closes = await sql<{ business_date: string; status: string; counted_drawer_cents: string; expected_drawer_cents: string; n_exc: string }>(
      `select c.business_date::text, c.status, c.counted_drawer_cents::text, c.expected_drawer_cents::text,
              (select count(*) from public.close_exceptions e where e.close_id = c.id and e.resolved_at is null)::text as n_exc
         from public.daily_closes c where c.store_id = $1 order by c.business_date desc limit 7`, [store.id]);
    const opening = await sql<{ opening_at: string | null }>("select opening_at::text from public.accounts where code = $1", [codes.drawer]);
    return { codes, rows, closes, openingAt: opening[0]?.opening_at ?? null };
  });
  const todayClose = data.closes.find((c) => c.business_date === today);
  return (
    <main>
      <Top title={store.name} s={s} help="Everything about today's cash in one place. Follow the four steps; the app does the math." />
      <HowItWorks role={s.role} />
      <div className="card next">
        <div className="row"><span className="k">Your next step</span>
          <span className="v" style={{ whiteSpace: "normal", textAlign: "right" }}>{nextStep(s.role, !!todayClose, todayClose?.status, bal(data.rows, data.codes.safe))}</span></div>
      </div>
      {!data.openingAt && s.role === "owner" && (
        <div className="notice">Opening counts not set yet. Go to <Link href="/cash">Cash</Link> → “Set opening” on cutoff night.</div>
      )}
      <div className="card">
        <div className="row"><span className="k">Today</span><span className="v">{today}</span></div>
        <div className="row"><span className="k">Close</span>
          <span className="v">{todayClose ? <span className={`tag ${todayClose.status === "verified" ? "ok" : "warn"}`}>{todayClose.status}</span> : <span className="tag">not submitted</span>}</span></div>
        <div className="row"><span className="k">Drawer (expected now)</span><span className="v">{usd(bal(data.rows, data.codes.drawer))}</span></div>
        <div className="row"><span className="k">Safe (expected)</span><span className="v">{usd(bal(data.rows, data.codes.safe))}</span></div>
      </div>
      <Link href="/close" className="btn">{todayClose ? "View / fix today’s close" : "Close the register"}</Link>
      <Link href="/safe" className="btn secondary">Safe drop</Link>

      <h2>Last 7 closes</h2>
      <div className="card">
        {data.closes.length === 0 && <div className="mut">No closes yet.</div>}
        {data.closes.map((c) => {
          const diff = Number(c.counted_drawer_cents) - Number(c.expected_drawer_cents);
          return (
            <div className="row" key={c.business_date}>
              <span className="k">{c.business_date}</span>
              <span className="v">
                <span className={diff === 0 ? "pos" : Math.abs(diff) < 500 ? "warn" : "neg"}>{diff === 0 ? "exact" : (diff > 0 ? "+" : "−") + usd(Math.abs(diff))}</span>
                {" "}<span className={`tag ${c.status === "verified" ? "ok" : Number(c.n_exc) ? "bad" : "warn"}`}>{c.status}{Number(c.n_exc) ? ` · ${c.n_exc} flag` : ""}</span>
              </span>
            </div>
          );
        })}
      </div>
      <Tabs active="/" s={s} />
    </main>
  );
}
