import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(pin, salt, 32).toString("hex")}`;
}
export function checkPin(pin: string, stored: string | null): boolean {
  if (!stored) return false;
  const [, salt, hex] = stored.split("$");
  const a = scryptSync(pin, salt, 32);
  const b = Buffer.from(hex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
