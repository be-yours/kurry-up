#!/usr/bin/env node
/**
 * Page lint — the breakage detector of this site. CLIENT ZONE. Chamas Tacos (adapted from Chicken Street's).
 *
 * Opens the pages of the running site (`pnpm dev`, or `--base=` another origin) in a headless Chromium, at
 * several widths (light and dark schemes by default: the site opens light, dark sits behind the engine toggle), with every animation switched off (so each element is in its final
 * state), scrolls them end to end, and reports what a visitor would call « broken »:
 *   overflow   the page scrolls sideways, and which elements push it
 *   spill      text that runs out of its own button, badge or card
 *   clipped    text cut by an ancestor with overflow: hidden / clip (carousels and the pinned rail are skipped)
 *   contrast   text under WCAG AA against a solid background (gradients and photographs are not judged)
 *   underHeader content hidden under the fixed header at the top of a page
 *   broken     images that failed to load
 * Run it after any change to `site/theme.css` or `site/pages/*.css`, and after `pnpm update:engine`
 * or `pnpm update:template` (the rules there reach the engine's markup with attribute selectors).
 *
 *   node site/tools/page-lint.mjs                                   # http://localhost:3500, every page
 *   node site/tools/page-lint.mjs http://localhost:3500 --pages=/menu,/contact --vps=390x844
 *   node site/tools/page-lint.mjs --base=https://staging.example.test --schemes=light,dark
 *   node site/tools/page-lint.mjs --type=spill,overflow --json=lint.json
 *   node site/tools/page-lint.mjs --wait=9000        # a slow machine: more time per page before it is judged
 *
 * Needs Playwright's Chromium (`pnpm exec playwright install chromium`). Exit code 1 when anything is reported
 * under `overflow`, `spill` or `underHeader`.
 */
import { chromium } from "@playwright/test"
import { writeFileSync } from "node:fs"

const args = process.argv.slice(2)
// a bare first argument is the base URL (`node site/tools/page-lint.mjs http://localhost:3500`)
const bare = args.find((a) => /^https?:\/\//.test(a))
const opt = Object.fromEntries(
  args.map((s) => {
    const m = s.replace(/^--/, "").split("=")
    return [m[0], m.length > 1 ? m.slice(1).join("=") : true]
  }),
)
const BASE = String(opt.base || bare || "http://localhost:3500").replace(/\/$/, "")
const VPS = String(opt.vps || "1920x1080,1280x800,768x1024,360x740")
  .split(",")
  .map((s) => s.split("x").map(Number))
const SCHEMES = String(opt.schemes || "light,dark").split(",")
const TYPES = String(opt.type || "overflow,spill,clipped,underHeader,broken,contrast").split(",")
// On a loaded machine the dev server answers late and the reveals have not finished when a page is judged
// (an element still at opacity 0 reads as « white on white »): `--wait=9000` gives every page more time.
const WAIT = Number(opt.wait || 3200)
const CART = {
  state: {
    items: [
      { lineId: "l1", productId: "p1", name: "Menu Solo", price: 690, quantity: 2, options: [], imageUrl: "", vatRate: 10 },
      { lineId: "l2", productId: "p2", name: "Poulet entier", price: 850, quantity: 1, options: [], imageUrl: "", vatRate: 10 },
    ],
    orderType: "pickup",
    storeId: null,
  },
  version: 2,
}

/** The pages: the fixed ones, plus the first product and the first article the sitemap lists. */
async function pagesToCheck() {
  if (opt.pages) return String(opt.pages).split(",")
  const fixed = ["/", "/menu", "/about", "/contact", "/blog", "/cart", "/checkout", "/sign-in", "/sign-up", "/forgot-password", "/store-selector", "/restaurants", "/franchise", "/account", "/cgv", "/mentions-legales", "/confidentialite", "/this-page-does-not-exist"]
  try {
    const xml = await (await fetch(BASE + "/sitemap.xml")).text()
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname)
    const product = locs.find((p) => p.startsWith("/product/"))
    const article = locs.find((p) => p.startsWith("/blog/"))
    return [...fixed, ...[product, article].filter(Boolean)]
  } catch {
    return fixed
  }
}

const CHECK = () => {
  const res = { overflowX: 0, offenders: [], spill: [], clipped: [], contrast: [], underHeader: [], broken: [], unknownBg: 0 };
  const vw = innerWidth;
  res.overflowX = Math.max(0, document.documentElement.scrollWidth - vw);
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
  const parse = (s) => {
    if (!s || s === 'transparent') return [0, 0, 0, 0];
    let m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) { const p = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    m = s.match(/^color\(srgb ([^)]+)\)$/);
    if (m) { const p = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; }
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = s; cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255];
  };
  const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  const over = (top, bottom) => { const a = top[3]; return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1]; };
  const sel = (el) => {
    const t = el.tagName.toLowerCase();
    const c = (typeof el.className === 'string' ? el.className : '').split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    const slot = el.getAttribute && el.getAttribute('data-slot');
    return t + (slot ? '[' + slot + ']' : '') + (c ? '.' + c : '');
  };
  const path = (el) => { const parts = []; let e = el; for (let i = 0; i < 3 && e && e !== document.body; i++, e = e.parentElement) parts.unshift(sel(e)); return parts.join(' > '); };
  const visible = (el) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden'; };
  const hasBox = (el) => {
    const cs = getComputedStyle(el);
    const bg = parse(cs.backgroundColor);
    const b = ['Top', 'Right', 'Bottom', 'Left'].some(s => parseFloat(cs['border' + s + 'Width']) > 0 && cs['border' + s + 'Style'] !== 'none' && parse(cs['border' + s + 'Color'])[3] > 0.1);
    // a gradient or an image paints a box too: a card framed by a gradient border has a transparent border and no
    // background colour, and its text was then judged against the section around it (the pinned rail, off screen)
    return bg[3] > 0.08 || b || (cs.backgroundImage && cs.backgroundImage !== 'none');
  };
  const bgAt = (el) => {
    const layers = []; let e = el; let unknown = false;
    while (e && e.nodeType === 1) {
      const cs = getComputedStyle(e);
      // a band painted by a pseudo-element behind the text (an article's night band, the header's veil) cannot be judged
      let pseudoBand = false;
      for (const ps of ['::before', '::after']) {
        const pcs = getComputedStyle(e, ps);
        if (pcs.content !== 'none' && (pcs.backgroundImage !== 'none' || parse(pcs.backgroundColor)[3] > 0.5) && parseInt(pcs.zIndex) < 0) pseudoBand = true;
      }
      if (pseudoBand) { unknown = true; break; }
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        // an image or a gradient under the text: unknown, unless it is a mask pattern pseudo (not on the element itself)
        unknown = true; break;
      }
      const c = parse(cs.backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 0.99) break;
      e = e.parentElement;
    }
    let base = [255, 255, 255, 1];
    if (!layers.length || layers[layers.length - 1][3] < 0.99) {
      const hb = parse(getComputedStyle(document.documentElement).backgroundColor); base = hb[3] >= 0.99 ? hb : (document.documentElement.classList.contains('dark') ? [30, 12, 26, 1] : [255, 255, 255, 1]);
    }
    let col = layers.length && layers[layers.length - 1][3] >= 0.99 ? layers[layers.length - 1] : base;
    for (let i = layers.length - (layers[layers.length - 1] && layers[layers.length - 1][3] >= 0.99 ? 2 : 1); i >= 0; i--) col = over(layers[i], col);
    return { col, unknown };
  };
  const opacityChain = (el) => { let o = 1; let e = el; while (e && e.nodeType === 1) { o *= parseFloat(getComputedStyle(e).opacity); e = e.parentElement; } return o; };

  const header = document.querySelector('.storefront-theme > header');
  const hb = header ? header.getBoundingClientRect() : null;

  // text nodes
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  let node;
  const spillSeen = new Set(), clipSeen = new Set(), conSeen = new Set(), uhSeen = new Set();
  while ((node = walker.nextNode())) {
    const txt = node.textContent.replace(/\s+/g, ' ').trim();
    if (!txt) continue;
    const el = node.parentElement;
    if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|OPTION)$/.test(el.tagName)) continue;
    if (el.closest('[aria-hidden="true"], [hidden], .sr-only, [data-nextjs-toast], nextjs-portal, #__next-build-watcher')) continue;
    if (!visible(el)) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter(r => r.width > 1 && r.height > 1);
    if (!rects.length) continue;
    const cs = getComputedStyle(el);
    // 1. text spilling out of its own visible box
    let b = el, depth = 0;
    while (b && b !== document.body && depth < 5) { if (hasBox(b)) break; b = b.parentElement; depth++; }
    // a horizontal scroller (the carte's category rail) holds more than it shows on purpose
    const scroller = b && b !== document.body && /(auto|scroll)/.test(getComputedStyle(b).overflowX) && b.scrollWidth > b.clientWidth + 1;
    if (b && b !== document.body && hasBox(b) && !scroller) {
      const br = b.getBoundingClientRect();
      if (br.width > 20 && br.height > 14 && br.width < vw + 5) {
        let ox = 0; for (const r of rects) ox = Math.max(ox, r.right - br.right, br.left - r.left);
        const k = path(b) + txt.slice(0, 20);
        if (ox > 1.5 && !spillSeen.has(k)) { spillSeen.add(k); res.spill.push({ at: path(b), text: txt.slice(0, 50), px: Math.round(ox), boxW: Math.round(br.width), y: Math.round(br.top + scrollY) }); }
      }
    }
    // 2. text clipped by an overflow:hidden ancestor
    let a = el;
    let ellipsed = false;
    while (a && a !== document.body) {
      const acs = getComputedStyle(a);
      if (acs.textOverflow === 'ellipsis') ellipsed = true; // truncated on purpose
      if (ellipsed) break;
      if (acs.overflowX === 'auto' || acs.overflowX === 'scroll') break; // reachable by scrolling: not clipped
      if (a.matches('[data-slot="carousel-content"], [data-slot="carousel"], section[class*="-mt-16"]')) break; // carousels and the pinned rail slide on purpose
      if ((acs.overflowX === 'hidden' || acs.overflowX === 'clip') && !(acs.textOverflow === 'ellipsis') && !acs.webkitLineClamp.match(/^[1-9]/) && !/line-clamp/.test(a.className || '')) {
        const ar = a.getBoundingClientRect();
        if (ar.width > 8) {
          let cl = 0; for (const r of rects) cl = Math.max(cl, ar.left - r.left, r.right - ar.right);
          const k = path(a) + txt.slice(0, 20);
          if (cl > 2 && !clipSeen.has(k)) { clipSeen.add(k); res.clipped.push({ at: path(a), text: txt.slice(0, 50), px: Math.round(cl), y: Math.round(ar.top + scrollY) }); }
        }
      }
      a = a.parentElement;
    }
    // 3. contrast
    const fg = parse(cs.color);
    if (fg[3] > 0.05) {
      const { col: bgc, unknown } = bgAt(el);
      if (unknown) res.unknownBg++;
      else {
        const op = opacityChain(el);
        let f = [fg[0], fg[1], fg[2], fg[3] * op];
        const fgc = over(f, bgc);
        const r = ratio(fgc, bgc);
        const fs = parseFloat(cs.fontSize), fw = parseInt(cs.fontWeight) || 400;
        const large = fs >= 24 || (fs >= 18.66 && fw >= 700);
        const need = large ? 3 : 4.5;
        const k = path(el) + txt.slice(0, 16);
        if (r < need - 0.05 && !conSeen.has(k)) { conSeen.add(k); res.contrast.push({ at: path(el), text: txt.slice(0, 40), ratio: +r.toFixed(2), need, fg: fgc.slice(0, 3).map(Math.round).join(','), bg: bgc.slice(0, 3).map(Math.round).join(','), y: Math.round(rects[0].top + scrollY) }); }
      }
    }
    // 4. under the fixed header at the top of the page
    if (hb && scrollY < 2 && !el.closest('header, .storefront-theme > div[class*="z-50"][class*="h-10"]') && /^(H1|H2|H3|P|A|BUTTON|SPAN|LABEL|INPUT|LI)$/.test(el.tagName)) {
      const r0 = rects[0];
      if (r0.top < hb.bottom - 2 && r0.bottom > hb.top + 2 && getComputedStyle(el).position !== 'fixed') {
        const k = path(el) + txt.slice(0, 16);
        if (!uhSeen.has(k)) { uhSeen.add(k); res.underHeader.push({ at: path(el), text: txt.slice(0, 40), top: Math.round(r0.top), headerBottom: Math.round(hb.bottom) }); }
      }
    }
  }
  // elements poking out of the viewport (not clipped)
  if (res.overflowX > 0) {
    const all = document.querySelectorAll('body *');
    for (const e of all) {
      const r = e.getBoundingClientRect();
      if (r.right > vw + 1 && r.width > 0 && r.height > 0 && visible(e)) {
        let clipped = false, p = e.parentElement;
        while (p && p !== document.body) { const pc = getComputedStyle(p); if (['hidden', 'clip', 'auto', 'scroll'].includes(pc.overflowX)) { clipped = true; break; } p = p.parentElement; }
        const pos = getComputedStyle(e).position;
        if (!clipped && pos !== 'fixed' && res.offenders.length < 8) res.offenders.push({ at: path(e), right: Math.round(r.right), w: Math.round(r.width) });
      }
    }
  }
  // images
  for (const im of document.images) {
    if (!visible(im)) continue;
    const r = im.getBoundingClientRect();
    if (r.width < 4) continue;
    if (im.complete && im.naturalWidth === 0 && (im.currentSrc || im.src)) res.broken.push({ src: (im.currentSrc || im.src).slice(-60), at: path(im) });
  }
  return res;
};

async function run() {
  const pages = await pagesToCheck()
  const browser = await chromium.launch()
  const all = []
  for (const scheme of SCHEMES) {
    for (const [w, h] of VPS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: w < 700, hasTouch: w < 700, colorScheme: scheme })
      await ctx.addInitScript((c) => {
        try {
          localStorage.setItem("beindigital-cart", JSON.stringify(c))
          sessionStorage.setItem("ot-film", "1")
        } catch {}
      }, CART)
      for (const pth of pages) {
        const p = await ctx.newPage()
        const errs = []
        p.on("pageerror", (e) => errs.push(String(e).slice(0, 140)))
        try {
          await p.goto(BASE + pth, { waitUntil: "domcontentloaded", timeout: 90000 })
          await p.waitForTimeout(WAIT)
          await p.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}" })
          const H = await p.evaluate(() => document.documentElement.scrollHeight)
          for (let y = 0; y < H; y += Math.max(300, h - 100)) {
            await p.evaluate((yy) => window.scrollTo(0, yy), y)
            await p.waitForTimeout(Math.round(WAIT / 26))
          }
          // every reveal in its final state (the scroll above is faster than the observers): an element left at
          // opacity 0 would read as « fg == bg, ratio 1 » (SiteEffects sets data-ot-power / data-ot-on)
          await p.evaluate(() => document.querySelectorAll("[data-ot-power]").forEach((e) => e.setAttribute("data-ot-on", "")))
          await p.evaluate(() => window.scrollTo(0, 0))
          await p.waitForTimeout(Math.round(WAIT / 4.5))
          const r = await p.evaluate(CHECK)
          all.push({ path: pth, w, scheme, errs, ...r })
          process.stdout.write(".")
        } catch (e) {
          all.push({ path: pth, w, scheme, fail: String(e).slice(0, 120) })
          process.stdout.write("x")
        }
        await p.close()
      }
      await ctx.close()
    }
  }
  await browser.close()
  console.log("")
  if (opt.json) writeFileSync(String(opt.json), JSON.stringify(all))
  return summarise(all)
}

function summarise(data) {
  const groups = new Map()
  const add = (type, key, info, d) => {
    const k = type + "|" + key
    if (!groups.has(k)) groups.set(k, { type, info, where: [] })
    groups.get(k).where.push(`${d.path}@${d.w}${d.scheme === "dark" ? "d" : ""}`)
  }
  for (const d of data) {
    if (d.fail) {
      add("FAIL", d.path + d.w, d.fail, d)
      continue
    }
    if (TYPES.includes("overflow") && d.overflowX > 0) add("overflow", d.path + "|" + d.offenders.map((o) => o.at).join(";").slice(0, 80), `scrolls sideways by ${d.overflowX}px: ${JSON.stringify(d.offenders.slice(0, 3))}`, d)
    for (const k of ["spill", "clipped", "underHeader", "broken"]) if (TYPES.includes(k)) for (const s of d[k]) add(k, s.at + "|" + (s.text || s.src || ""), JSON.stringify(s), d)
    if (TYPES.includes("contrast")) for (const s of d.contrast) add("contrast", s.at + "|" + s.text, `${s.ratio}<${s.need} fg ${s.fg} on ${s.bg} «${s.text}»`, d)
  }
  const byType = {}
  for (const g of [...groups.values()].sort((a, b) => b.where.length - a.where.length)) (byType[g.type] = byType[g.type] || []).push(g)
  let hard = 0
  for (const t of Object.keys(byType)) {
    console.log(`\n=== ${t} (${byType[t].length})`)
    for (const g of byType[t].slice(0, 40)) {
      const where = [...new Set(g.where)]
      console.log(`- ${g.info.slice(0, 230)}\n    ${where.slice(0, 8).join(" ")}${where.length > 8 ? " +" + (where.length - 8) : ""}`)
    }
    if (["overflow", "spill", "underHeader", "FAIL"].includes(t)) hard += byType[t].length
  }
  if (!Object.keys(byType).length) console.log("Nothing reported.")
  return hard
}

run().then((hard) => process.exit(hard ? 1 : 0))
