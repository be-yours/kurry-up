# Customizing a client site

## The zone contract

The repo is split into two zones. That split is what makes conflict-free
updates possible:

**CLIENT zone — yours, never overwritten:**

| Location | Contents |
| --- | --- |
| `site.config.ts` | Build-time identity: name, description, title template, default locale, color scheme, allowed image hosts, browser-tab icons (`icons`) |
| `site/theme.css` | Design token overrides (loaded after `app/globals.css`) |
| `site/fonts.ts` | Fonts (`next/font`), exposed through `fontVariables` |
| `site/layout.ts` | The layout half of the identity: one value per family (`nav`, `hero`, `menu`, `btn`, `tex`, `foot`, `up`), from `lib/layout-families.ts` |
| `site/routes.ts` | The pages this site adds beside the engine's: one entry per page, read by `sitemap.xml`, the route-tree test and the header and footer links (see "Add a custom page") |
| `site/DESIGN_BRIEF.md` | What the client asked for, written at creation by `--design-prompt` (absent on a site created without one) |
| `site/components/` | Components specific to this site |
| `site/components/SiteEffects.tsx` | The site's own browser-side code, mounted once for the whole site: smooth scrolling, a custom pointer, page transitions. Ships empty (`return null`); see "Run code in the browser" below. The template never edits it after it first arrives |
| `public/` | Logos, static images, and the icon files `site.config.ts` → `icons` points at |
| `.env.local`, `.env.convex` | Client secrets and endpoints (gitignored) |
| `.beindigital-site.json` | Init sentinel (site metadata) |
| `mobile/` | Expo app ("web + app" setup) — a client zone for as long as the engine ships no mobile product |

**ENGINE zone — synced, do not edit:**

`app/`, `components/`, `lib/`, `hooks/`, `cms/`, `convex/`, root configs
(`tsconfig.json`, `postcss.config.mjs`, `eslint.config.mjs`,
`playwright.config.ts`, `vitest.config.ts`, `components.json`).

Two engine files carry a deliberate boilerplate patch (with a
`PATCH BOILERPLATE` header): `app/layout.tsx` (wires up the site zone: metadata,
fonts, theme, layout, and the `SiteEffects` mount) and `next.config.ts`
(transpilePackages + images from `site.config.ts`).

## Runtime customization (admin dashboard)

A large part of the customization does NOT go through code: the CMS and the
settings (`globalSettings`, languages, promotions, emails, and so on) live in
Convex and are edited from the `(admin)` dashboard. Rule of thumb: if the
restaurant owner has to be able to change it on their own, it belongs in the
dashboard; if it is set once when the site is created, it belongs in the
client zone.

## Recipes

**Start from a design template** — five ready-made vertical directions
(pizzeria, fast-food, food-truck, poulet, asiatique) lay down colors, fonts
and shapes in the client zone:

```bash
pnpm template:list             # catalogue (aperçu : templates/preview.html)
pnpm template:apply pizzeria   # écrase site/theme.css + site/fonts.ts
pnpm template:apply default    # restaure le thème d'origine
```

You can also pick one at creation time (`beindigital create … --template
pizzeria`, or the `pnpm setup` wizard question). After that, tune the client's
colors directly in `site/theme.css`, following the "Adapting to the client"
section of `templates/<slug>/DESIGN.md` (keep the AA contrast ratios).

**Start from scratch** — no catalogue design, every package. Create the site
with `--blank` (or answer `0` in the `pnpm setup` wizard); pass the client's wish
with `--design-prompt "…"` or `--design-prompt-file brief.txt` and it is recorded
in `site/DESIGN_BRIEF.md`, together with the contract the design has to meet. A
brief given with no `--template` implies `--blank`.

```bash
beyours create client-luigi --name "Chez Luigi" --blank \
  --design-prompt "Bistrot lyonnais, bois et cuivre, titres en serif"
```

Then compose `site/theme.css`, `site/fonts.ts` and `site/layout.ts` from the
brief — by hand, or by opening the repository in a coding agent, which reads
`AGENTS.md` and `site/DESIGN_BRIEF.md` — and run:

```bash
pnpm design:check   # AA contrast of site/theme.css, layout values, font variables
```

The AA contrast ratios are the same ones the catalogue is held to
(`templates/README.md`, "Catalogue rules"). A catalogue design stays one command
away: `pnpm template:apply <slug>` overwrites the three files.

**Change the colors** — `site/theme.css`:

```css
:root {
  --primary: 8 76% 45%;      /* HSL sans hsl() */
  --ring: 8 76% 45%;
}
.dark {
  --primary: 8 80% 55%;
}
```

**Choose the color scheme** — the storefront header has a button that steps
through light, dark and "system", which is the visitor's own device setting.
The choice is stored in the visitor's browser, so it survives a reload, and it
applies before the first paint. `site.config.ts` decides what a visitor sees
before they have chosen, and whether the button exists:

```ts
theme: {
  default: "light", // "light", "dark" or "system" (omitted: "system")
  toggle: true,     // false removes the button from the storefront header
},
```

Both fields are optional. A site without the entry behaves as it did before:
it follows the visitor's device and shows the button.

`default` is a first impression, not a lock. A choice the visitor has already
made wins over it. It applies to the whole app, so the admin opens in the same
scheme until its own toggle is used; the admin and the storefront share the one
browser setting. `toggle: false` removes the storefront button and nothing else.

A site that styles both modes in `site/theme.css` needs nothing more: the button
switches the `dark` class on `<html>`, which the `.dark` selectors already read.
To restyle the button itself, target `.storefront-theme-toggle`.

An existing site receives the button through `pnpm update:template`. Its
`site.config.ts` is never overwritten, so add the entry by hand if the defaults
do not suit it.

**Change the fonts** — `site/fonts.ts`: swap Inter/Poppins for any
`next/font`, keeping the CSS variables `--font-inter` and `--font-poppins`
(they are referenced by the engine theme).

**Run code in the browser** — smooth scrolling, a custom pointer, page
transitions: edit `site/components/SiteEffects.tsx` and nothing else. The root
layout mounts that component once, for the whole site, through the engine's
`SiteEffectsSlot`. It ships as `return null`, so a site that never opens the
file renders exactly what it rendered before.

What the slot guarantees:

- The component renders **after hydration**, never on the server. Reading
  `window`, `document` or `matchMedia` while it renders cannot cause a
  hydration mismatch, and nothing it draws shows up before its effects have run.
- It is **not rendered in the administration** (`app/(admin)`). Navigating into
  the dashboard unmounts it, so effect cleanups run; navigating out mounts it
  again. Everywhere else it is rendered: storefront, sign-in, QR game, wall
  display. If an effect must be narrower, test `usePathname()` inside it.
- It adds **no element of its own** and sits after the page, at the end of
  `<body>`. Return `null`, or an overlay that is `position: fixed` (or
  `absolute`) with `pointer-events: none`, and the layout cannot shift.
- It sits **outside** the engine's providers (`app/providers.tsx`): no Convex
  hook, no `useTheme()`, no toast in there. Read the DOM instead (the dark theme
  is the `dark` class on `<html>`), or ask for a slot inside the providers.

What it asks of you:

- Undo everything in the cleanup of your effect. The development server mounts
  every effect twice on purpose.
- Honour `prefers-reduced-motion`. The stylesheet and framer-motion cannot reach
  motion you drive from JavaScript; `useReducedMotion()` from `framer-motion`,
  already installed, answers it.
- Keep `'use client'` as the first line of the file.

Smooth scrolling, with [Lenis](https://github.com/darkroomengineering/lenis).
The one step outside the file is `pnpm add lenis`, which adds the dependency to
`package.json`; the code stays in `SiteEffects.tsx`. Lenis switches its own
smoothing off under `prefers-reduced-motion`:

```tsx
'use client'

import { useEffect } from 'react'
import Lenis from 'lenis'
import 'lenis/dist/lenis.css'

export function SiteEffects() {
  useEffect(() => {
    const lenis = new Lenis({ autoRaf: true })
    return () => lenis.destroy()
  }, [])

  return null
}
```

Cross-page view transitions need **no option in `next.config.ts` or
`site.config.ts`**. The Next 16.3 this template pins no longer has
`experimental.viewTransition` (its config schema rejects the key), and React's
`<ViewTransition>` works in the App Router as it is. From `SiteEffects`, a
boundary keyed by the pathname makes React run a view transition on every
navigation:

```tsx
'use client'

import { ViewTransition } from 'react'
import { usePathname } from 'next/navigation'
import './site-effects.css'

export function SiteEffects() {
  const pathname = usePathname()

  return (
    <ViewTransition key={pathname}>
      <div
        aria-hidden
        style={{ position: 'fixed', top: 0, left: 0, width: 1, height: 1, pointerEvents: 'none' }}
      />
    </ViewTransition>
  )
}
```

By default the browser fades the old page out over 250 ms. Restyle the
page-wide pair in a stylesheet next to the component, `site/components/site-effects.css`
(not in `site/theme.css`: `pnpm template:apply` overwrites that file), and switch
it off for visitors who asked for no motion: the universal rule of
`app/globals.css` does not reach `::view-transition-*`.

```css
@keyframes site-out { to { opacity: 0; } }
@keyframes site-in { from { opacity: 0; } }

::view-transition-old(root) { animation: site-out 300ms ease both; }
::view-transition-new(root) { animation: site-in 300ms ease both; }

@media (prefers-reduced-motion: reduce) {
  ::view-transition-old(*),
  ::view-transition-new(*),
  ::view-transition-group(*) {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
  }
}
```

`SiteEffects` sits **beside** the page, not around it. It can listen, measure,
animate the document and draw overlays. It cannot wrap engine components in a
provider or in a named `<ViewTransition>` (to morph one page's image into the
next page's), and rewriting text that React renders — splitting a heading into
words, say — can break React's next update of that node. A need of that kind is
an engine change: ask for a slot.

**Add a custom page** — a page the engine ships (`/about`, `/menu`) is not yours
to change: its content is the CMS's, and a missing slot is a request to the
engine. A page that is entirely outside the product (an events landing page, a
catering menu) takes a NEW route file and one registry entry. A brand-new file
cannot cause a merge conflict, and `site/routes.ts` is how the engine learns the
page exists. Everything else under `app/` stays the engine's.

1. Create the route, for example `app/(storefront)/evenements/page.tsx`. Start the
   file with a `// SITE-SPECIFIC` comment and import the content from
   `site/components/`. Export `generateMetadata` built with `buildSeoMetadata`
   from `lib/seo.ts`, and pass the page's `pathname`: the suite requires a
   canonical on every public page.
2. Register the page in `site/routes.ts`:

```ts
import type { SitePublicRoute } from "@/lib/site-routes"

export const sitePublicRoutes: SitePublicRoute[] = [
  {
    path: "/evenements",
    changeFrequency: "monthly",
    priority: 0.6,
    nav: { label: "Événements", placement: "header", order: 45 },
  },
]
```

That one entry does three things. `tests/seo/sitemap-robots.test.ts` accepts the
page, `/sitemap.xml` lists it, and the header (or the footer) links it. Without
the entry the page gets none of the three, and the suite fails until you register
the page or delete it. Remove the entry later and the page leaves all three.

| Field | Meaning |
| --- | --- |
| `path` | The URL, as the route tree resolves it. A fixed path made of letters, digits, `-`, `_`, `.` and `~`: no query, no trailing slash, no dynamic segment such as `[slug]`, and not `/`. |
| `changeFrequency`, `priority` | The sitemap hints. `priority` runs from 0 to 1. |
| `nav` | Optional. Leave it out for a page that is indexed and linked from nowhere. |
| `nav.label` | The text of the link. It is not translated: the engine's own links follow the language switch, this one does not. |
| `nav.placement` | `"header"` (the default) or `"footer"`. A footer link is one of the defaults of « Liens utiles »: links the owner types for that column in the admin replace it, and hiding the column hides it. |
| `nav.order` | The position among the links of the same placement. The engine's links count 10, 20, 30… in reading order, so `45` falls between the fourth and the fifth. Without it, the link comes last. |

Things to know before you add one:

- A mistake in an entry does not break the site. The engine ignores that entry,
  `next dev` prints why, and `pnpm test` fails with the same sentence.
- The engine owns its own paths. An entry for `/about`, or for any other page the
  engine ships, is ignored and flagged by the suite.
- `robots.txt` matches by prefix. A path that starts like a back-office route
  (`/products-promo`, `/stores-locator`) is blocked, and the suite names it.
  Rename the route.
- Prefer the footer once you pass one or two links. The header already holds five
  links, the language and store pickers, the cart and the account menu.
- The footer has its own editor in the admin (see below). Use `placement: "footer"`
  for a link the site must ship with, and the admin for links the owner changes.
- The registry lists public pages only. A page of your own that must stay private
  still fails the suite, because `robots.txt` is the engine's: ask the engine for
  a rule.

**Legal pages are the engine's, not a site route.** `/mentions-legales`, `/cgv`
and `/confidentialite` ship with every site and are linked from the footer and
the checkout. Do not add your own at those paths. The establishment's identity is
entered in the admin (Paramètres → Facturation, and Paramètres → Mentions
légales, which also lists what is still missing); the clauses that differ from
one restaurant to the next (delivery, cancellation, extras) are edited in
Contenu → Pages → Informations légales. The template wording must be validated by the
client's counsel before go-live.

**Allow a new image CDN** — `site.config.ts` → `images.remoteHosts`.

**Put the site's own icon on the browser tab** — drop the files in `public/`
(for example `public/brand/favicon.png`) and name them in `site.config.ts`:

```ts
icons: { icon: "/brand/favicon.png", apple: "/brand/apple-touch-icon.png" },
```

The engine ships no icon file. `app/favicon.ico` used to, and Next.js gives a
file-based icon priority over `metadata` and over `public/`, so a site's own
could never win. Without `icons`, a browser asks `/favicon.ico` as it always
does, which `public/favicon.ico` answers. The favicon set in the admin
(Contenu → Pages → Layout du storefront → Identité visuelle) still replaces whichever
is declared here, once the page has loaded.

**Change the footer, the social networks, the contact page's promise** — all in
the admin, under Contenu → Pages → Layout du storefront and Contenu → Pages → Contact:

| Block | What it does |
| --- | --- |
| *Pied de page* → *Slogan* | A sentence under the restaurant's name. Empty by default: the engine no longer prints one (it used to promise delivery on every site). |
| *Pied de page — colonne Navigation* / *Liens utiles* | Up to six links of your own per column (`/evenements` for a page of the site, `https://…` for another site). The engine's links show until you add one; adding one replaces them. The column can be hidden. « Nos restaurants » appears only on a deployment with several establishments. |
| *Réseaux sociaux* | One address per network: Facebook, Instagram, TikTok, Snapchat, YouTube, X, LinkedIn. An icon appears only when its address is entered (`https://` only). |
| Contact → *Engagement de réponse* | A card under the contact details. Absent until you fill it in: only promise a delay you keep. |

The labels of the engine's own links, the cards' « Prix » and « Lire la suite »,
and the category counts come from the language catalogue; reword them in the
admin, on the Languages screen, « Traductions UI » tab.

## What NOT to do

- Modifying a component in `components/` "just for this client" → a silent
  fork: the next template update overwrites it or conflicts with it. If the
  need is legitimate, it goes up into the engine (feature flag, prop, slot)
  and comes back down through `pnpm update:engine`.
- Adding `app/(storefront)/template.tsx`, a `<Script>` tag or a provider under
  `app/` to run browser code. `site/components/SiteEffects.tsx` is the mount
  point; what it cannot do (wrap the pages) is an engine change: ask for a slot.
- Listing a page of your own in `lib/crawler-policy.ts`, or linking it from
  `storefront-header.tsx` or `storefront-footer.tsx` → the same silent fork, in
  the three files that a registry entry already reaches. Register the page in
  `site/routes.ts` instead.
- Writing business logic in `convex/` (thin wrappers only).
- Committing `.env.local`, `.env.convex`, or a `package.json` in engine-link
  mode (`link:`) — CI blocks it.
