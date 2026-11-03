# `site/seed/`: Kurry Up's content

One ordering restaurant (`paris-washington`, the pilot of the brief), with the carte (9 categories, 47 products of which 44 active and 3 switched off),
the CMS pages and six blog articles. The other restaurants of the network are NOT stores: they live in `../components/network.ts`, each line with a
status (hand-written from the brief, no unsourced address).

## Files

| File | Role |
| --- | --- |
| `data.mjs` | store, global settings, the carte (brief section 4, « carte sur place » prices), UI words, media keys, CMS pages, blog categories |
| `articles.html` | the six articles (one marker line `<!-- article {json} -->` then the HTML body) |
| `run.mjs` | idempotent seed through the engine's own Convex functions (no engine file touched) |

## Local stack

| What | Where |
| --- | --- |
| Convex backend (anonymous local deployment) | cloud API `http://127.0.0.1:3300`, HTTP site `http://127.0.0.1:3301` |
| Next dev server | `http://localhost:3500` (use `localhost`, not `127.0.0.1`) |

```bash
node site/seed/run.mjs --dry-run                    # checks the data and prints the plan, writes nothing
node site/seed/run.mjs                              # everything, every store
node site/seed/run.mjs --only=pages,blog            # steps: settings, languages, ui, catalogue, pages, blog
node site/seed/run.mjs --only=catalogue --store=paris-washington
node site/seed/run.mjs --reset-ops                  # also rewrite identity, hours and global settings
node site/seed/run.mjs --image-list                 # rewrites ../IMAGES_PRODUITS_LISTE.json for the imagery agent
```

Rerun the seed after editing `data.mjs` or `articles.html`, and after new pictures land in `public/brand/`. A rerun never rewrites the store's
identity, hours or global settings without `--reset-ops`. Unknown flags, `--only` steps and `--store` slugs stop the run before anything is written.
`validate()` also stops it on a duplicate slug, a bad price, an em or en dash, the word « halal » or a third-party brand name in visitor text.

## Slugs (fixed once)

Categories, in the order of the carte: `formules`, `entrees`, `plats-poulet`, `plats-agneau`, `legumes`, `biryanis`, `naans`, `desserts`, `boissons`.
Category picture: the packshot of one of its dishes (`FAMILY_IMAGE` in `data.mjs`). Product picture: `public/brand/products/<product-slug>.webp`, variant
`<product-slug>-sm.webp` (the seed only wires the first; one slot per product, picked up when the file exists). Store: `paris-washington`.
Files expected by the CMS pages (logo, favicon, og, hero, three scenes, nine product shots): the `MEDIA` table of `data.mjs`.

## What is a placeholder

All of it is listed in `../A_COMPLETER.md`. In short:

- Hours: every day 11:00 to 22:30, from the brand's address page. Sourced but to confirm; the engine refuses orders outside the hours it holds.
- No phone, no e-mail (none found). Nothing is written in the store's `phone` field or in the legal settings.
- `taxRate` 10 %, payments cash only, delivery off (no zone, fee or minimum known), click & collect on.
- Seller identity: KURRY UP, 11 rue Washington, SIREN 838057065, SIRET 83805706500024, RCS Paris. Entity to display, host, director, legal form, capital, VAT
  number, mediator: À confirmer. CGV and privacy: demo text.
- Allergens empty on every product. Formules carry DEMO option groups (protein, 3 vegetables, 3 toppings, naan, drink) built from the supplements named in
  the brief, with the catalogue's supplement prices; the engine cannot force an exact count.
- Three catalogue-only desserts are kept with `active: false`.

## What is NOT seeded

- The Ben & Jerry's ice creams and any third-party brand name (drinks and cookies use their common name).
- Any franchise amount. The Franchise page (a component of `site/`, not a seed page) is linked from the footer only (`footerNav`, link 6).
- Any halal claim, any founder name, any restaurant address the brief does not give.
