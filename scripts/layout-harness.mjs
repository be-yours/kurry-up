#!/usr/bin/env node
/**
 * Assembles the layout-family harness: one page per family value, in a real
 * browser's reach (#507).
 *
 * WHY. A layout family is CSS, and the question that decides whether its rule is
 * right — does this lay out the way it is meant to — cannot be answered by any
 * test here: jsdom parses CSS and does not lay it out. That is why `tex`, `up`
 * and `foot` shipped and `nav`, `hero` and `menu` did not; the first three do not
 * move boxes.
 *
 * Inputs: the fragments `__tests__/layout-harness.render.test.tsx` serialises
 * from the REAL components (a copied fixture would test the copy), plus
 * `app/globals.css` compiled against the classes those fragments actually carry.
 *
 * Usage:
 *   pnpm --filter @beyours/themes exec vitest run __tests__/layout-harness.render.test.tsx
 *   node scripts/layout-harness.mjs
 *   node scripts/layout-harness-serve.mjs   # then open http://localhost:4507
 *
 * Served over HTTP rather than opened as files: a linked stylesheet resolves,
 * nothing caps the page size, and the browser treats them as pages.
 *
 * `.layout-harness/` is gitignored: an instrument, not an output.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = path.join(ROOT, ".layout-harness");
const FRAGMENTS = path.join(HARNESS, "fragments");

/** Which fragment each family's rules act on, and the values to lay out. */
const CASES = [
  { family: "nav", fragment: "header-transparent", values: ["left", "center", "bar", "minimal"] },
  { family: "nav", fragment: "header-opaque", values: ["left", "center", "bar", "minimal"] },
  { family: "hero", fragment: "hero", values: ["split", "zen", "banner"] },
  { family: "menu", fragment: "menu", values: ["cards", "zen", "ledger", "tickets", "dotted"] },
  { family: "foot", fragment: "footer", values: ["columns", "center", "heavy"] },
  // `btn` twice, because its two kinds of control live in different fragments:
  // the hero carries a labelled CTA, the dish grid the icon-only add-to-cart
  // and the favourite heart. Reviewing one would leave the other unseen, and
  // the add button is the most pressed control on the shop.
  { family: "btn", fragment: "hero", values: ["soft", "pill", "square", "brutal", "underline"] },
  { family: "btn", fragment: "menu", values: ["soft", "pill", "square", "brutal", "underline"] },
  { family: "tex", fragment: "footer", values: ["none", "dots", "lines", "grain", "checker"] },
  { family: "up", fragment: "footer", values: ["0", "1"] },
];

function readFragment(name) {
  const file = path.join(FRAGMENTS, `${name}.html`);
  if (!fs.existsSync(file)) {
    console.error(`Missing ${path.relative(ROOT, file)} — run the render test first.`);
    process.exit(1);
  }
  return fs.readFileSync(file, "utf8");
}

/**
 * Every class name the fragments carry.
 *
 * Taken from the rendered markup rather than by scanning source: the fragments
 * ARE the markup being reviewed, so this set is exactly the utilities the pages
 * need and cannot be missing one.
 */
function candidatesFrom(htmls) {
  const found = new Set();
  for (const html of htmls) {
    for (const [, value] of html.matchAll(/class="([^"]*)"/g)) {
      for (const token of value.split(/\s+/)) if (token) found.add(token);
    }
  }
  return [...found];
}

const fragments = new Map();
for (const { fragment } of CASES) {
  if (!fragments.has(fragment)) fragments.set(fragment, readFragment(fragment));
}

const source = fs.readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
const compiled = await compile(source, {
  // The stylesheet's OWN directory, not the app root: every `@import` and
  // `@source` in globals.css is written relative to `app/`, so
  // `../node_modules/...` means `apps/themes/node_modules`.
  base: path.join(ROOT, "app"),
  loadStylesheet: async (id, base) => {
    // `@import "tailwindcss"` and the vendor sheets globals.css pulls in. A bare
    // specifier can name a package (a DIRECTORY, whose entry is index.css) or a
    // file inside one, so all three spellings are tried rather than assumed.
    const root = id.startsWith(".") ? path.resolve(base, id) : path.join(ROOT, "node_modules", id);
    const file = [root, `${root}.css`, path.join(root, "index.css")].find(
      (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    );
    if (!file) throw new Error(`Cannot resolve stylesheet "${id}" from ${base}`);
    return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
  },
  // `@plugin "@tailwindcss/typography"` — loaded for real. A stub would compile,
  // and every `prose-*` class in the fragments would silently resolve to nothing.
  loadModule: async (id, base) => {
    const mod = await import(id.startsWith(".") ? path.resolve(base, id) : id);
    return { path: id, base: ROOT, module: mod.default ?? mod };
  },
});

/*
 * One stylesheet PER FRAGMENT, not one for all of them.
 *
 * The pages inline their CSS — a linked sheet does not resolve in the reviewer's
 * static-snapshot mode — and a single sheet covering every fragment put the
 * homepage pages over the size a snapshot will open. Compiling per fragment
 * gives each page only the utilities its own markup uses.
 */
const sheets = new Map();
for (const [name, html] of fragments) {
  const built = compiled.build(candidatesFrom([html]));
  const count = (built.match(/\{/g) ?? []).length;
  if (count < 100) {
    console.error(`Refusing ${name}'s stylesheet at ~${count} rules: the compile found nothing.`);
    process.exit(1);
  }
  sheets.set(name, built);
  fs.writeFileSync(path.join(HARNESS, `${name}.css`), built);
}

const page = (family, value, fragment, html) => `<!doctype html>
<html lang="fr" data-${family}="${value}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${family}="${value}" — ${fragment}</title>
<link rel="stylesheet" href="${fragment}.css">
<style>
  /* The harness's own chrome, kept out of the way of what is being reviewed. */
  body { margin: 0; }
  .harness-label {
    position: fixed; bottom: 0; left: 0; z-index: 9999;
    font: 12px/1.4 ui-monospace, monospace;
    background: #111; color: #fff; padding: 4px 8px;
  }
  /* The header is position:fixed; without a body tall enough there is
     nothing to sit over and nothing to scroll. */
  .harness-bed { min-height: 220vh; }
</style>
</head>
<body>
<div class="storefront-theme harness-bed">
${html}
</div>
<div class="harness-label">${family}="${value}" · ${fragment}</div>
</body>
</html>
`;

const written = [];
for (const { family, fragment, values } of CASES) {
  for (const value of values) {
    const name = `${family}-${value}-${fragment}.html`;
    fs.writeFileSync(path.join(HARNESS, name), page(family, value, fragment, fragments.get(fragment)));
    written.push({ family, value, fragment, name });
  }
}

const index = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Layout family harness</title>
<style>body{font:14px/1.6 ui-sans-serif,system-ui;margin:2rem;max-width:44rem}
h2{margin-top:2rem;font-size:1rem}a{display:inline-block;margin:0 .5rem .25rem 0}</style>
</head><body>
<h1>Layout family harness (#507)</h1>
<p>Real components, serialised by the render test; globals.css compiled against the
classes they carry. Review each value at two viewports — jsdom cannot lay out, so
this is the instrument.</p>
${[...new Set(written.map((w) => `${w.family} · ${w.fragment}`))]
  .map((group) => {
    const rows = written.filter((w) => `${w.family} · ${w.fragment}` === group);
    return `<h2>${group}</h2>${rows.map((r) => `<a href="${r.name}">${r.value}</a>`).join("")}`;
  })
  .join("\n")}
</body></html>
`;
fs.writeFileSync(path.join(HARNESS, "index.html"), index);

for (const [name, sheet] of sheets) {
  console.log(`  ${name}: ${(sheet.length / 1024).toFixed(1)} KB of CSS`);
}
console.log(`${written.length} pages + index.html in .layout-harness/`);
