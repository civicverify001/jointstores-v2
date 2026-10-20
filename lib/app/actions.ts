"use server";
import { redirect } from "next/navigation";
import { logout } from "./auth.ts";

/** Sign-out is a POST so a prefetched link can never log someone out. */
export async function signOut() {
  await logout();
  redirect("/login");
}
