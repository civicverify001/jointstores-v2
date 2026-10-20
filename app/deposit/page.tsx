import { redirect } from "next/navigation";
import { requireSession } from "../../lib/app/auth.ts";
import { asUser } from "../../lib/app/db.ts";
import { accountsFor, bal, recordDeposit, verifyClose, clearDeposit, importStatement } from "../../lib/app/ledger.ts";
import { Tabs, Top, usd, nowLocalIso, cents } from "../../lib/app/ui.tsx";

export default async function DepositPage({ searchParams }: { searchParams: Promise<{ msg?: string; err?: string }> }) {
  const s = await requireSession();
  const store = s.stores[0];
  if (s.role === "employee") redirect("/");
  const sp = await searchParams;

  const data = await asUser(s.uid, async (sql) => {
    const { codes, rows } = await accountsFor(sql, store.id);
    const banks = await sql<{ id: number; nickname: string; bank: string }>(
      "select b.id, b.nickname, b.bank from public.bank_accounts b join public.stores st on st.entity_id = b.entity_id where st.id=$1", [store.id]);
    const pending = await sql<{ id: number; business_date: string; status: string; net_sales_cents: string; sales_tax_cents: string; payments_total_cents: string; expected_drawer_cents: string; counted_drawer_cents: string; codes: string | null }>(
      `select c.id, c.business_date::text, c.status, c.net_sales_cents::text, c.sales_tax_cents::text, c.payments_total_cents::text,
              c.expected_drawer_cents::text, c.counted_drawer_cents::text,
              (select string_agg(e.code, ', ') from public.close_exceptions e where e.close_id=c.id and e.resolved_at is null) as codes
         from public.daily_closes c where c.store_id=$1 and c.status='submitted' order by c.business_date`, [store.id]);
    const deposits = await sql<{ id: number; amount_cents: string; deposited_at: string; status: string; nickname: string }>(
      `select d.id, d.amount_cents::text, d.deposited_at::text, d.status, b.nickname from public.deposits d join public.bank_accounts b on b.id=d.bank_account_id
        where d.store_id=$1 order by d.deposited_at desc limit 15`, [store.id]);
    const unmatched = await sql<{ id: number; posted_date: string; description: string; amount_cents: string; kind: string }>(
      `select l.id, l.posted_date::text, l.description, l.amount_cents::text, l.kind from public.bank_lines l join public.bank_accounts b on b.id=l.bank_account_id
        join public.stores st on st.entity_id=b.entity_id where st.id=$1 and l.matched_deposit_id is null and l.kind in ('cash_deposit','merchant_deposit')
        order by l.posted_date desc limit 20`, [store.id]);
    return { collected: bal(rows, codes.collected), inTransit: bal(rows, codes.inTransit), banks, pending, deposits, unmatched };
  });

  async function deposit(fd: FormData) {
    "use server";
    const s2 = await requireSession();
    try {
      await asUser(s2.uid, (sql) => recordDeposit(sql, s2.uid, s2.stores[0].id, Number(fd.get("bank")), cents(fd.get("amount")), String(fd.get("at"))));
    } catch (e) { redirect(`/deposit?err=${encodeURIComponent((e as Error).message)}`); }
    redirect("/deposit?msg=Deposit+recorded+(in+transit)");
  }
  async function verify(fd: FormData) {
    "use server";
    const s2 = await requireSession();
    const r = await asUser(s2.uid, (sql) => verifyClose(sql, s2.uid, Number(fd.get("close"))));
    redirect(r.ok ? "/deposit?msg=Close+verified" : `/deposit?err=${encodeURIComponent("Cannot verify: " + r.blocking.join(", "))}`);
  }
  async function clear(fd: FormData) {
    "use server";
    const s2 = await requireSession();
    try {
      await asUser(s2.uid, (sql) => clearDeposit(sql, s2.uid, Number(fd.get("deposit")), fd.get("line") ? Number(fd.get("line")) : null, String(fd.get("at"))));
    } catch (e) { redirect(`/deposit?err=${encodeURIComponent((e as Error).message)}`); }
    redirect("/deposit?msg=Deposit+marked+cleared");
  }
  async function statement(fd: FormData) {
    "use server";
    const s2 = await requireSession();
    try {
      const r = await asUser(s2.uid, (sql) => importStatement(sql, s2.uid, Number(fd.get("bank")), String(fd.get("bankKind")) as "first_merchants" | "old_national", Number(fd.get("year")), String(fd.get("text"))));
      redirect(`/deposit?msg=${encodeURIComponent(`Statement: ${r.posted} new lines, ${r.skipped} already known${r.duplicateOf ? " (same file as before)" : ""}`)}`);
    } catch (e) {
      if ((e as Error).message?.startsWith("NEXT_REDIRECT")) throw e;
      redirect(`/deposit?err=${encodeURIComponent((e as Error).message)}`);
    }
  }

  return (
    <main>
      <Top title="Deposit & Verify" s={s} help="Record bank deposits from the cash you collected, and verify each day\u2019s close against the NRS report." />
      {sp.err && <div className="notice bad">{sp.err}</div>}
      {sp.msg && <div className="notice ok">{sp.msg}</div>}

      <h2>Closes waiting for verification</h2>
      <div className="card">
        {data.pending.length === 0 && <div className="mut">Nothing waiting.</div>}
        {data.pending.map((c) => {
          const diff = Number(c.counted_drawer_cents) - Number(c.expected_drawer_cents);
          return (
            <div key={c.id} style={{ paddingBottom: 10, marginBottom: 10, borderBottom: "1px solid var(--line)" }}>
              <div className="row"><span className="k">{c.business_date}</span><span className="v">net {usd(c.net_sales_cents)} · tax {usd(c.sales_tax_cents)} · tendered {usd(c.payments_total_cents)}</span></div>
              <div className="row"><span className="k">Drawer</span><span className={`v ${diff === 0 ? "pos" : "warn"}`}>{diff === 0 ? "exact" : usd(diff)}</span></div>
              {c.codes && <div className="notice bad">Flags: {c.codes}</div>}
              <form action={verify}><input type="hidden" name="close" value={c.id} /><button className={c.codes ? "secondary" : ""}>Verify {c.business_date}</button></form>
            </div>
          );
        })}
      </div>

      <div className="card">
        <div className="row"><span className="k">Chelsea holding (Fortville)</span><span className="v">{usd(data.collected)}</span></div>
        <div className="row"><span className="k">Deposits in transit</span><span className="v">{usd(data.inTransit)}</span></div>
      </div>

      {store.can_deposit && (
        <form action={deposit} className="card">
          <h2 style={{ marginTop: 0 }}>Record a bank deposit</h2>
          <label>Bank</label>
          <select name="bank">{data.banks.map((b) => <option key={b.id} value={b.id}>{b.nickname}</option>)}</select>
          <label>Amount on the slip</label><input name="amount" inputMode="decimal" required />
          <label>When</label><input type="datetime-local" name="at" defaultValue={nowLocalIso()} required />
          <button>Record deposit</button>
        </form>
      )}

      <h2>Deposits</h2>
      <div className="card">
        {data.deposits.length === 0 && <div className="mut">None yet.</div>}
        {data.deposits.map((d) => (
          <div key={d.id} className="row" style={{ flexWrap: "wrap" }}>
            <span className="k">{d.deposited_at.slice(0, 10)} · {d.nickname}</span>
            <span className="v">{usd(d.amount_cents)} <span className={`tag ${d.status === "cleared" ? "ok" : "warn"}`}>{d.status}</span></span>
            {d.status === "in_transit" && s.role === "owner" && (
              <form action={clear} style={{ width: "100%" }}>
                <input type="hidden" name="deposit" value={d.id} />
                <div className="grid2">
                  <div><label>Bank line (optional)</label>
                    <select name="line"><option value="">— none —</option>
                      {data.unmatched.filter((l) => Number(l.amount_cents) === Number(d.amount_cents)).map((l) => <option key={l.id} value={l.id}>{l.posted_date} {l.description.slice(0, 24)} {usd(l.amount_cents)}</option>)}
                    </select></div>
                  <div><label>Cleared on</label><input type="datetime-local" name="at" defaultValue={nowLocalIso()} /></div>
                </div>
                <button className="secondary">Mark cleared from statement</button>
              </form>
            )}
          </div>
        ))}
      </div>

      {s.role === "owner" && (
        <form action={statement} className="card">
          <h2 style={{ marginTop: 0 }}>Import bank statement (owner)</h2>
          <p className="mut" style={{ fontSize: 14 }}>Open the statement PDF, select all, copy, paste. Lines you already imported are skipped automatically.</p>
          <label>Bank</label>
          <select name="bank">{data.banks.map((b) => <option key={b.id} value={b.id} data-kind={b.bank}>{b.nickname}</option>)}</select>
          <input type="hidden" name="bankKind" value={data.banks[0]?.bank ?? "first_merchants"} />
          <label>Statement year</label><input name="year" inputMode="numeric" defaultValue={new Date().getFullYear()} />
          <label>Statement text</label><textarea name="text" required />
          <button className="secondary">Import</button>
        </form>
      )}
      <Tabs active="/deposit" s={s} />
    </main>
  );
}
