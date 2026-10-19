// PIN login for the store phone + owner/manager. PIN hashes are scrypt and are
// only ever compared server-side (asSystem). The session is an HMAC-signed cookie.
import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";
import { checkPin } from "./pin.ts";
import { redirect } from "next/navigation";
import { asSystem } from "./db.ts";

export interface Session {
  uid: string;
  name: string;
  role: "owner" | "manager" | "employee";
  stores: { id: number; name: string; can_collect: boolean; can_deposit: boolean; can_verify: boolean; can_view_bank: boolean }[];
}

const COOKIE = "js2_session";
const secret = () => process.env.SESSION_SECRET ?? "dev";


function sign(uid: string): string {
  const mac = createHmac("sha256", secret()).update(uid).digest("hex");
  return `${uid}.${mac}`;
}
function verify(token: string | undefined): string | null {
  if (!token) return null;
  const [uid, mac] = token.split(".");
  if (!uid || !mac) return null;
  const expect = createHmac("sha256", secret()).update(uid).digest("hex");
  return mac.length === expect.length && timingSafeEqual(Buffer.from(mac), Buffer.from(expect)) ? uid : null;
}

export async function login(name: string, pin: string): Promise<boolean> {
  const row = await asSystem(async (sql) => {
    const r = await sql<{ id: string; pin_hash: string | null }>(
      "select id, pin_hash from public.profiles where lower(full_name) = lower($1) and active", [name]);
    return r[0];
  });
  if (!row || !checkPin(pin, row.pin_hash)) return false;
  (await cookies()).set(COOKIE, sign(row.id), { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 14 });
  return true;
}

export async function logout() {
  (await cookies()).delete(COOKIE);
}

export async function session(): Promise<Session | null> {
  const uid = verify((await cookies()).get(COOKIE)?.value);
  if (!uid) return null;
  return asSystem(async (sql) => {
    const p = (await sql<{ id: string; full_name: string; role: Session["role"] }>(
      "select id, full_name, role from public.profiles where id = $1 and active", [uid]))[0];
    if (!p) return null;
    const stores = await sql<Session["stores"][number]>(
      p.role === "owner"
        ? "select id, name, true as can_collect, true as can_deposit, true as can_verify, true as can_view_bank from public.stores where active order by name"
        : "select s.id, s.name, us.can_collect, us.can_deposit, us.can_verify, us.can_view_bank from public.user_stores us join public.stores s on s.id = us.store_id where us.user_id = $1 order by s.name",
      p.role === "owner" ? [] : [uid]);
    return { uid: p.id, name: p.full_name, role: p.role, stores };
  });
}

export async function requireSession(): Promise<Session> {
  const s = await session();
  if (!s) redirect("/login");
  return s;
}
