// usage: DATABASE_URL=… node --experimental-strip-types scripts/set-pin.ts "Chelsea" 4321
import { Pool } from "pg";
import { hashPin } from "../lib/app/pin.ts";
const [name, pin] = process.argv.slice(2);
if (!name || !pin) { console.error("usage: set-pin <name> <pin>"); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const r = await pool.query("update public.profiles set pin_hash=$2 where lower(full_name)=lower($1) returning full_name", [name, hashPin(pin)]);
console.log(r.rowCount ? `PIN set for ${r.rows[0].full_name}` : "no such user");
await pool.end();
