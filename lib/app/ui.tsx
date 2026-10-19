import Link from "next/link";
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

export function Tabs({ active, s }: { active: string; s: Session }) {
  const mgr = s.role !== "employee";
  const items = [
    ["/", "🏠", "Home"], ["/close", "🧾", "Close"], ["/safe", "🔐", "Safe"],
    ...(mgr ? [["/deposit", "🏦", "Deposit"], ["/cash", "💵", "Cash"]] : []),
  ];
  return (
    <nav className="tabs">
      {items.map(([href, icon, label]) => (
        <Link key={href} href={href} className={active === href ? "on" : ""}><span>{icon}</span>{label}</Link>
      ))}
    </nav>
  );
}

export function Top({ title, s }: { title: string; s: Session }) {
  return (
    <div className="top">
      <h1>{title}</h1>
      <div className="who">{s.name} · {s.role}<br /><Link href="/login?out=1">sign out</Link></div>
    </div>
  );
}
