// End-to-end walk of the real Fortville 10/17/2026 day, phone-sized.
// Jessi closes (paste of the Store Report + Rylie's drop), Chelsea collects and
// deposits, Sam snapshots the bank, imports the statement, clears the deposit.
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3100";
const OUT = process.env.OUT ?? "/tmp/claude-0/-home-claude/8f3dd13f-3a6c-564b-8306-588f0573c53e/scratchpad/shots";
mkdirSync(OUT, { recursive: true });
const FX = new URL("../fixtures/fortville-2026-10-17/", import.meta.url).pathname;
const report = readFileSync(FX + "store_report.txt", "utf8");
const csv = readFileSync(FX + "sales_by_day.csv", "utf8");
const statement = readFileSync(new URL("../fixtures/bank-2026-09/first_merchants_fortville.txt", import.meta.url).pathname, "utf8");

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium/chrome-linux/chrome" });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });
const text = async () => (await page.locator("main").innerText()).replace(/\s+/g, " ");
const go = async (loc) => {
  const before = page.url();
  await loc.click();
  await page.waitForFunction((b) => location.href !== b, before, { timeout: 15000 });
  await page.waitForLoadState("networkidle");
  const err = new URL(page.url()).searchParams.get("err");
  if (err) throw new Error(`server error on ${page.url()}: ${err}`);
};
const must = async (s) => { const t = await text(); if (!t.includes(s)) throw new Error(`expected "${s}" on ${page.url()}\n--- page: ${t.slice(0, 600)}`); };
async function login(name, pin) {
  await page.goto(`${BASE}/login?out=1`);
  await page.goto(`${BASE}/login`);
  await page.fill("input[name=name]", name);
  await page.fill("input[name=pin]", pin);
  await page.click("button");
  await page.waitForURL(`${BASE}/`);
}

// 1. Owner sets opening counts on cutoff night (10/16 23:59)
await login("Sam", "1111");
await page.goto(`${BASE}/cash`);
await page.click("summary");
await page.fill("input[name=at]", "2026-10-16T23:59");
await page.fill("input[name=drawer]", "250.00");
await page.fill("input[name=clearing]", "1800.00");
await go(page.locator("button.danger"));
await must("Opening counts set");
await shot("01-owner-opening");

// 2. Jessi: drop at end of her shift (523.30 at 1:57 PM) — POS recorded it, she records it here
await login("Jessi", "3333");
await page.goto(`${BASE}/safe`);
await page.fill("input[name=amount]", "523.30");
await page.fill("input[name=at]", "2026-10-17T13:57");
await page.fill("input[name=note]", "Jessi shift drop");
await go(page.locator("form[action] button").first());
await must("Drop recorded");
await must("$523.30");
await shot("02-jessi-drop");
// employee must not see the manager tabs
if ((await page.locator("nav.tabs a").count()) !== 3) throw new Error("employee should see 3 tabs");
const r = await page.goto(`${BASE}/cash`);
if (!page.url().endsWith("/")) throw new Error("employee reached /cash");

// 3. Rylie: her drop then the close with the pasted Store Report
await login("Rylie", "4444");
await page.goto(`${BASE}/safe`);
await page.fill("input[name=amount]", "346.55");
await page.fill("input[name=at]", "2026-10-17T22:01");
await go(page.locator("form[action] button").first());
await must("$869.85"); // expected in safe
await shot("03-rylie-drop");

await page.goto(`${BASE}/close?date=2026-10-17`);
await page.fill("textarea[name=report]", report);
await page.locator("details").nth(1).locator("summary").click();
await page.fill("textarea[name=csv]", csv);
await page.fill("input[name=closedAt]", "2026-10-17T22:01");
await page.waitForTimeout(300);
await must("Read: net $3,408.94");
await must("Expected drawer $250.43"); // 250 + 870.30 − 0.02 − 869.85
await page.fill("input[name=counted]", "250.45");
await page.waitForTimeout(200);
await must("Over $0.02");
await shot("04-rylie-close-preview");
await go(page.locator("form[action] > button"));
await must("Close saved");
await must("$3,408.94");
await must("$238.65");
await must("$3,647.59");
await must("Pay with Points");
await shot("05-close-saved");

// 4. Chelsea: collects the safe (counted 864.85 → $5 short), deposits it
await login("Chelsea", "2222");
await page.goto(`${BASE}/safe`);
await must("$869.85");
const forms = page.locator("form[action]");
await forms.nth(1).locator("input[name=counted]").fill("864.85");
await forms.nth(1).locator("input[name=at]").fill("2026-10-18T10:00");
await go(forms.nth(1).locator("button"));
await must("short $5.00");
await shot("06-chelsea-collect");

await page.goto(`${BASE}/deposit`);
await must("2026-10-17");
await must("Chelsea holding (Fortville) $864.85");
await page.fill("input[name=amount]", "864.85");
await page.fill("input[name=at]", "2026-10-18T11:00");
await go(page.locator("form[action]").filter({ hasText: "Record deposit" }).locator("button"));
await must("Deposit recorded");
await must("Deposits in transit $864.85");
// verify the close
await go(page.locator("form[action]").filter({ hasText: "Verify 2026-10-17" }).locator("button"));
await must("Close verified");
await shot("07-chelsea-deposit-verify");
// Chelsea has no bank visibility (D3 default): Cash page shows no bank card
await page.goto(`${BASE}/cash`);
if ((await text()).includes("Bank — snapshot")) throw new Error("manager without can_view_bank saw the bank card");
await shot("08-chelsea-cash");

// 5. Sam: snapshot, statement import, clear the deposit, see the position
await login("Sam", "1111");
await page.goto(`${BASE}/cash`);
await page.fill("input[name=balance]", "4705.59");
await page.fill("input[name=asOf]", "2026-10-18T09:00");
await go(page.locator("form[action]").filter({ hasText: "Save snapshot" }).locator("button"));
await must("Bank snapshot saved");
await must("$4,705.59");
await must("bills due in 7 days");
await shot("09-owner-cash-position");

await page.goto(`${BASE}/deposit`);
await page.fill("input[name=year]", "2026");
await page.fill("textarea[name=text]", statement);
await go(page.locator("form[action]").filter({ hasText: "Import" }).locator("button"));
await must("Statement: 57 new lines");
// re-import is a no-op
await page.fill("input[name=year]", "2026");
await page.fill("textarea[name=text]", statement);
await go(page.locator("form[action]").filter({ hasText: "Import" }).locator("button"));
await must("0 new lines, 57 already known");
await shot("10-owner-statement-import");

await page.locator("form[action]").filter({ hasText: "Mark cleared" }).locator("input[name=at]").fill("2026-10-19T09:00");
await go(page.locator("form[action]").filter({ hasText: "Mark cleared" }).locator("button"));
await must("Deposit marked cleared");
await must("cleared");
await shot("11-owner-deposit-cleared");

await page.goto(`${BASE}/cash`);
await must("Deposits in transit $0.00");
await must("Variance to date $4.98"); // 5.00 short − 0.02 over
await must("Card clearing (not yet in bank) $4,479.81"); // 1,800 + 2,679.81
await shot("12-owner-cash-final");

await page.goto(`${BASE}/`);
await must("+$0.02 verified");
await shot("13-home-after");
await browser.close();
console.log("WALKTHROUGH PASSED");
