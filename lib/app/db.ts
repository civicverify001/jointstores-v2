// Database access with the signed-in user's identity applied for RLS.
// Locally: pg against the throwaway Postgres, `set local role app_user` so
// policies are enforced exactly as Supabase's `authenticated` role will be.
import { Pool, type PoolClient } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __jsPool: Pool | undefined;
}

function pool(): Pool {
  if (!globalThis.__jsPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set");
    // Supabase (and any non-local host) requires TLS; the local throwaway Postgres has none.
    // Supabase's pooler certificate is signed by Supabase's own CA, so verification needs
    // that CA (PGSSL_CA, PEM text). Without it we still encrypt but cannot verify the chain.
    const local = /localhost|127\.0\.0\.1|host=\//.test(url);
    const ca = process.env.PGSSL_CA;
    globalThis.__jsPool = new Pool({
      connectionString: url,
      max: 5,
      ssl: local ? undefined : ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
    });
  }
  return globalThis.__jsPool;
}

export type Sql = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;

/** Run `fn` in one transaction as user `uid` (RLS enforced). Throws roll back. */
export async function asUser<T>(uid: string | null, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool().connect();
  try {
    await client.query("begin");
    if (uid) {
      await client.query("set local role app_user");
      await client.query("select set_config('app.uid', $1, true)", [uid]);
    }
    const sql: Sql = async (text, params = []) => (await client.query(text, params as unknown[])).rows;
    const out = await fn(sql);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Privileged query (login lookup, PIN hashes). Never exposed to a page directly. */
export async function asSystem<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  return asUser(null, fn);
}
