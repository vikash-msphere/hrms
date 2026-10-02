#!/usr/bin/env node
// Drive the running dev SPA through every route at every breakpoint, screenshot each one, and MEASURE the
// rendered page for the things a source scan cannot see.
//
// `scripts/uiAudit.mjs` reads the source and can tell you a rule holds in the code. It cannot tell you that a
// row actually overflowed at 360px, that a control ended up 28px tall after everything cascaded, that a
// heading is clipped, or that the page threw in the console. This does, because it asks the layout engine.
//
// Requires the dev stack (scripts/start.sh) and puppeteer-core + system Chrome.
//   node scripts/uiShots.mjs                     # every route, every viewport
//   node scripts/uiShots.mjs --routes a,b        # just these
//   node scripts/uiShots.mjs --vp phone          # just this viewport
//   node scripts/uiShots.mjs --full              # full-page screenshots (default: above the fold)
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.UI_BASE ?? "http://localhost:5173";
const OUT = process.env.UI_OUT ?? "tmp/shots";

// Prism (the contract proxy the SPA reads through) enforces the OpenAPI security scheme before the request
// reaches the worker, and the worker's dev fake-auth never sees it. Any value satisfies the cookie lane; the
// identity still comes from DEV_FAKE_EMAIL in .dev.vars.
const AUTH_COOKIE = { name: "hrms_session", value: "dev", domain: "localhost", path: "/" };

const VIEWPORTS = {
  // The two phone widths that matter: the narrowest in real use, and the most common.
  phone360: { width: 360, height: 780, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  phone390: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  // A phone held sideways - where `short:` applies and fixed chrome costs a third of the screen.
  landscape: { width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  // The icon rail appears at md, the sidebar opens out at lg.
  tablet768: { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  laptop1024: { width: 1024, height: 768, deviceScaleFactor: 1 },
  desktop1440: { width: 1440, height: 900, deviceScaleFactor: 1 },
  // The wide-screen rules (docs/06-responsive-ui.md, "Wide screens"): `3xl` and its side columns and docked
  // detail at 1920; `<main>`'s 1920px cap binding at 2560, and centring with wide margins at an ultra-wide.
  desktop1920: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  desktop2560: { width: 2560, height: 1440, deviceScaleFactor: 1 },
  ultrawide3440: { width: 3440, height: 1440, deviceScaleFactor: 1 },
};

const ROUTES = [
  "dashboard", "employees", "leave-requests", "attendance", "approvals", "announcements", "boards",
  "tickets", "documents", "payslips", "reimbursements", "overtime", "expenses", "assets", "goals",
  "notifications", "holidays", "org-chart", "settings", "workflows", "activity", "profile",
  "leave-calendar", "timesheets", "candidates", "job-requisitions", "interviews", "offers",
  "compliance", "benefits", "loans", "tax-declarations", "check-ins", "reviews", "kudos",
  "suggestions", "referrals", "payroll-runs", "operations", "shifts", "stocktakes", "delegations",
];

const args = process.argv.slice(2);
const argOf = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const routes = argOf("--routes")?.split(",") ?? ROUTES;
const vpNames = argOf("--vp")?.split(",") ?? Object.keys(VIEWPORTS);
const fullPage = args.includes("--full");

// Runs INSIDE the page. Everything here is a question only the layout engine can answer.
function measure() {
  const out = { overflowX: 0, wideNodes: [], smallTargets: [], clipped: [], offscreen: [] };
  const vw = document.documentElement.clientWidth;
  const coarse = matchMedia("(pointer: coarse)").matches;
  const de = document.scrollingElement || document.documentElement;
  out.overflowX = Math.max(0, de.scrollWidth - vw);

  // What counts as on screen. Three exclusions, each for a thing that is off screen ON PURPOSE and would
  // otherwise be reported forever:
  //   - `.sr-only` is a 1px clipped box by design; it is *supposed* to be clipped and hidden.
  //   - the closed mobile drawer is translated off the left edge and marked `inert`; its forty nav links are
  //     not "offscreen controls", they are a closed menu. Same for any `aria-hidden` subtree.
  //   - an element with no intersection with the viewport at all is either that, or below the fold, and the
  //     fold is not a defect.
  const hiddenBySurface = (el) => el.closest('[inert],[aria-hidden="true"],.sr-only,[data-state="closed"]') !== null;
  const visible = (el) => {
    if (el.classList.contains("sr-only") || hiddenBySurface(el)) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    // Intersects the viewport horizontally at all? (Vertically we allow below-the-fold - that is what
    // scrolling is for; horizontally there is no such excuse.)
    return r.right > 0 && r.left < vw + 400;
  };
  const label = (el) => {
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
    const txt = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${el.tagName.toLowerCase()}${id}${cls} "${txt}"`;
  };

  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();

    // Something painting past the right edge that is not inside a declared horizontal scroller. A scroller is
    // allowed to be wider than the screen - that is the whole point of it - so walk up and skip those.
    if (r.right > vw + 1) {
      let inScroller = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ov = getComputedStyle(p).overflowX;
        if (ov === "auto" || ov === "scroll") { inScroller = true; break; }
      }
      if (!inScroller && out.wideNodes.length < 12) out.wideNodes.push({ el: label(el), right: Math.round(r.right), vw });
    }

    // Touch targets, measured after the cascade rather than inferred from a class list. `::before` hit-area
    // extensions (the checkbox trick) are counted by measuring the pseudo-element too.
    const interactive = el.matches('button,a[href],[role="button"],input:not([type="hidden"]),select,textarea,[role="menuitem"],[role="option"],[role="tab"],[role="radio"],[role="checkbox"],[role="switch"]');
    // The touch floor is a TOUCH rule. With a cursor the dense design is deliberate and correct - a 28px
    // row action next to a 24px one is how a data-dense table is supposed to look with a mouse - so
    // measuring targets on a fine pointer reports the design as a defect, several hundred times.
    if (interactive && coarse) {
      // The real target, not the painted box: two hit-area extensions in this app grow what a fingertip
      // lands on without touching layout (the checkbox's `::before`, and the `::after` on a control inside a
      // table cell). Measuring the box alone would report both as failures.
      let w = r.width, h = r.height;
      for (const pseudo of ["::before", "::after"]) {
        const ps = getComputedStyle(el, pseudo);
        if (!ps || ps.content === "none" || ps.position !== "absolute") continue;
        const inset = parseFloat(ps.inset || "0");
        if (!Number.isNaN(inset) && inset < 0) { w = Math.max(w, r.width + Math.abs(inset) * 2); h = Math.max(h, r.height + Math.abs(inset) * 2); }
      }
      // The app's own floors (docs/06-responsive-ui.md rule 1): 44px for a page's real actions, and a
      // deliberate 36px for the dense ones - a row-action cluster in a card, a small icon control in a
      // toolbar. So 36 is the line: at or above it the control is either fine or deliberately dense, and
      // below it nothing in this app is supposed to be.
      if (Math.min(w, h) < 36 && out.smallTargets.length < 25) {
        out.smallTargets.push({ el: label(el), w: Math.round(w), h: Math.round(h) });
      }
    }

    // Text cut off by its own box: the element clips and its content is wider/taller than the box. Catches a
    // heading truncated to nothing and a button whose label does not fit, which read as bugs on a screenshot.
    const s = getComputedStyle(el);
    if (s.webkitLineClamp && s.webkitLineClamp !== "none") continue; // a clamp is a deliberate cut with a way out
    if ((s.overflow === "hidden" || s.overflowY === "hidden") && el.children.length === 0 && el.textContent.trim()) {
      if (el.scrollHeight > el.clientHeight + 2 && out.clipped.length < 10) {
        out.clipped.push({ el: label(el), need: el.scrollHeight, have: el.clientHeight });
      }
    }

    // Anything a finger can hit that starts off the left edge or past the right one, having already excluded
    // the surfaces that are off screen deliberately - and excluding a declared horizontal scroller, whose
    // whole job is to hold content past the edge and bring it back with a swipe.
    if (interactive && (r.left < -1 || r.left > vw) && out.offscreen.length < 10) {
      let inScroller = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ov = getComputedStyle(p).overflowX;
        if (ov === "auto" || ov === "scroll") { inScroller = true; break; }
      }
      if (!inScroller) out.offscreen.push({ el: label(el), left: Math.round(r.left) });
    }
  }
  return out;
}

const results = [];
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
});

for (const vpName of vpNames) {
  const vp = VIEWPORTS[vpName];
  if (!vp) { console.error(`unknown viewport ${vpName}`); continue; }
  const page = await browser.newPage();
  await page.setViewport(vp);
  await page.setCookie(AUTH_COOKIE);

  for (const route of routes) {
    const errors = [];
    page.removeAllListeners("console");
    page.removeAllListeners("pageerror");
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
    page.on("pageerror", (e) => errors.push(`pageerror: ${String(e.message).slice(0, 160)}`));

    try {
      await page.goto(`${BASE}/${route}`, { waitUntil: "networkidle2", timeout: 30000 });
    } catch {
      // A route that never goes idle (polling) still renders; measure what is there.
    }
    // Let the route's own reads land and the layout settle.
    await new Promise((r) => setTimeout(r, 1200));

    const m = await page.evaluate(measure);
    const dir = path.join(OUT, vpName);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${route}.png`);
    await page.screenshot({ path: file, fullPage });

    results.push({ vp: vpName, route, ...m, errors, file });
    const flags = [
      m.overflowX > 0 ? `overflowX:${m.overflowX}px` : null,
      m.wideNodes.length ? `wide:${m.wideNodes.length}` : null,
      m.smallTargets.length ? `small:${m.smallTargets.length}` : null,
      m.clipped.length ? `clipped:${m.clipped.length}` : null,
      m.offscreen.length ? `offscreen:${m.offscreen.length}` : null,
      errors.length ? `console:${errors.length}` : null,
    ].filter(Boolean);
    console.log(`${vpName.padEnd(12)} ${route.padEnd(20)} ${flags.length ? flags.join(" ") : "ok"}`);
  }
  await page.close();
}
await browser.close();

fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));

// ---- summary -----------------------------------------------------------------
const bad = results.filter((r) => r.overflowX > 0 || r.wideNodes.length || r.smallTargets.length || r.clipped.length || r.offscreen.length || r.errors.length);
console.log(`\n${results.length} route×viewport renders, ${bad.length} with something to look at`);
for (const r of bad) {
  console.log(`\n${r.vp} · ${r.route}`);
  if (r.overflowX) console.log(`   page scrolls sideways by ${r.overflowX}px`);
  for (const w of r.wideNodes) console.log(`   past the right edge (${w.right} > ${w.vw}): ${w.el}`);
  for (const t of r.smallTargets) console.log(`   target ${t.w}×${t.h}: ${t.el}`);
  for (const c of r.clipped) console.log(`   clipped (needs ${c.need}px, has ${c.have}): ${c.el}`);
  for (const o of r.offscreen) console.log(`   offscreen at x=${o.left}: ${o.el}`);
  for (const e of r.errors) console.log(`   console: ${e}`);
}
