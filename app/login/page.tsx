import { redirect } from "next/navigation";
import { login, logout } from "../../lib/app/auth.ts";

export default async function Login({ searchParams }: { searchParams: Promise<{ out?: string; bad?: string }> }) {
  const sp = await searchParams;
  if (sp.out) { await logout(); redirect("/login"); }
  async function doLogin(fd: FormData) {
    "use server";
    const ok = await login(String(fd.get("name") ?? ""), String(fd.get("pin") ?? ""));
    redirect(ok ? "/" : "/login?bad=1");
  }
  return (
    <main>
      <h1 style={{ marginTop: 48 }}>JointStores</h1>
      <p className="mut">Fortville pilot · store phone sign-in</p>
      {sp.bad && <div className="notice bad">Name or PIN didn’t match.</div>}
      <form action={doLogin} className="card">
        <label>Name</label>
        <input name="name" autoComplete="username" placeholder="Jessi" required />
        <label>PIN</label>
        <input name="pin" type="password" inputMode="numeric" autoComplete="current-password" required />
        <button>Sign in</button>
      </form>
    </main>
  );
}
