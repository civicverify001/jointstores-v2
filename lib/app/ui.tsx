import Link from "next/link";
import { signOut } from "./actions.ts";
import type { Session } from "./auth.ts";

export const usd = (c: number | string | null | undefined) => {
  const n = Number(c ?? 0) / 100;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
};
export const todayLocal = () => new Date(new Date().toLocaleString("en-US", { timeZone: "America/Indiana/Indianapolis" })).toISOString().slice(0, 10);
export const nowLocalIso = () => {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Indiana/Indianapolis" }));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const cents = (v: FormDataEntryValue | null) => Math.round(Number(String(v ?? "0").replace(/[$,]/g, "")) * 100) || 0;

/** One nav for every screen size: bottom tabs on phones, left sidebar from 900px (see DESIGN_RULES.md). */
export function Tabs({ active, s }: { active: string; s: Session }) {
  const mgr = s.role !== "employee";
  const items = [
    ["/", "🏠", "Home", "Today at a glance"],
    ["/close", "🧾", "Close", "End of day: report + drawer count"],
    ["/safe", "🔐", "Safe", "Drops in, collections out"],
    ...(mgr ? [["/deposit", "🏦", "Deposit", "Bank deposits + verify closes"], ["/cash", "💵", "Cash", "Where every dollar is"]] : []),
  ];
  return (
    <nav className="tabs" aria-label="Sections">
      <div className="brand">JointStores<small>{s.stores[0]?.name}</small></div>
      {items.map(([href, icon, label, hint]) => (
        <Link key={href} href={href} className={active === href ? "on" : ""} aria-current={active === href ? "page" : undefined}>
          <span className="ic" aria-hidden="true">{icon}</span><span className="lb">{label}</span><small className="hint">{hint}</small>
        </Link>
      ))}
      <div className="navwho">{s.name} · {s.role}<br /><form action={signOut} className="signout"><button type="submit">sign out</button></form></div>
    </nav>
  );
}

/** Page header. `help` is the one sentence a first-time user needs to know about this page. */
export function Top({ title, s, help }: { title: string; s: Session; help?: string }) {
  return (
    <div className="top">
      <div>
        <h1>{title}</h1>
        {help && <p className="help">{help}</p>}
      </div>
      <div className="who">{s.name} · {s.role}<br /><form action={signOut} className="signout"><button type="submit">sign out</button></form></div>
    </div>
  );
}

/** The whole Release 1 flow in four steps, shown on Home so nobody has to remember it. */
export function HowItWorks({ role }: { role: Session["role"] }) {
  const steps = [
    ["1", "Drop", "Cash above the float goes into the safe. Record each drop here."],
    ["2", "Close", "At the end of the day paste the NRS Store Report and count the drawer. The app tells you over or short."],
    ["3", "Collect & deposit", "Chelsea counts the safe, takes the cash, and records the bank deposit."],
    ["4", "Verify", "Chelsea checks the close against the report. The owner sees where every dollar is on Cash."],
  ];
  const cards = steps.map(([n, t, d]) => (
    <div className={`step ${role === "employee" && Number(n) > 2 ? "dim" : ""}`} key={n}>
      <span className="n">{n}</span><b>{t}</b><span>{d}</span>
    </div>
  ));
  return (
    <>
      {/* Phone: one row of numbered titles, full text behind a tap. Laptop: four cards. */}
      <details className="howmini">
        <summary>
          {steps.map(([n, t]) => <span className={role === "employee" && Number(n) > 2 ? "dim" : ""} key={n}><i>{n}</i>{t}</span>)}
          <small>How it works ▾</small>
        </summary>
        <div className="how">{cards}</div>
      </details>
      <div className="how howfull">{cards}</div>
    </>
  );
}
