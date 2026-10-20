// Enforces DESIGN_RULES.md: every page, each role, phone + laptop widths.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const BASE = process.env.BASE ?? "http://localhost:3100";
const OUT = process.env.OUT ?? new URL("./shots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const sizes = { phone: { width: 390, height: 844 }, laptop: { width: 1280, height: 800 } };
const roles = [["Rylie", "4444", ["/", "/close", "/safe"]], ["Chelsea", "2222", ["/", "/close", "/safe", "/deposit", "/cash"]], ["Sam", "1111", ["/", "/cash", "/deposit"]]];
const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium" });
const fails = [];
for (const [name, size] of Object.entries(sizes)) {
  const ctx = await b.newContext({ viewport: size, isMobile: name === "phone", hasTouch: name === "phone", deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  for (const [user, pin, pages] of roles) {
    await ctx.clearCookies(); await p.goto(`${BASE}/login`);
    await p.fill("input[name=name]", user); await p.fill("input[name=pin]", pin); await p.click("button"); await p.waitForURL(`${BASE}/`);
    for (const path of pages) {
      await p.goto(BASE + path); await p.waitForLoadState("networkidle");
      const r = await p.evaluate(() => {
        const de = document.documentElement;
        const nav = document.querySelector("nav.tabs"); const nr = nav?.getBoundingClientRect();
        const small = [...document.querySelectorAll("button, nav.tabs a, input, select")].filter((e) => { const h = e.getBoundingClientRect().height; return h > 0 && h < 44; }).map((e) => (e.textContent || e.getAttribute("name") || e.tagName).trim().slice(0, 30));
        const btns = [...document.querySelectorAll("main button")]; const last = btns[btns.length - 1];
        let covered = false;
        if (last && nr && innerWidth < 900) { last.scrollIntoView({ block: "end" }); const lr = last.getBoundingClientRect(); covered = lr.bottom > nr.top; }
        return { overflow: de.scrollWidth > innerWidth, navVisible: !!nr && nr.width > 0, sidebar: innerWidth >= 900 ? !!nr && nr.width < 300 && nr.height > 400 : true, small, covered };
      });
      const tag = `${name}-${user}${path.replace(/\//g, "_") || "_home"}`;
      await p.screenshot({ path: `${OUT}/${tag}.png`, fullPage: true });
      if (r.overflow) fails.push(`${tag}: horizontal overflow`);
      if (!r.navVisible) fails.push(`${tag}: nav missing`);
      if (!r.sidebar) fails.push(`${tag}: sidebar not applied at laptop width`);
      if (r.covered) fails.push(`${tag}: last button hidden under the tab bar`);
      if (r.small.length) fails.push(`${tag}: tap targets under 44px: ${r.small.join(", ")}`);
    }
  }
  await ctx.close();
}
await b.close();
if (fails.length) { console.log(fails.join("\n")); process.exit(1); }
console.log("RESPONSIVE RULES OK");
