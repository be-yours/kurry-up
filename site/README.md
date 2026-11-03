# `site/` — the client zone

Everything specific to THIS site lives here (plus `site.config.ts` and the
`.env*` files at the root). **Nothing in this directory is touched by template
or engine updates.** A file the template adds after your site exists, like
`routes.ts` or `components/SiteEffects.tsx`, arrives once, empty, and is never
edited again.

| File / directory    | Role                                                             |
| ------------------- | ---------------------------------------------------------------- |
| `../site.config.ts` | Build-time identity: name, SEO, default locale, color scheme, image hosts, tab icons |
| `theme.css`         | Design token overrides (colors, radius, and so on)                |
| `fonts.ts`          | Site fonts (next/font)                                            |
| `routes.ts`         | The pages this site adds: one entry per page (sitemap, header and footer links, route-tree test) |
| `components/`       | Custom components for this site                                   |
| `public/` (root)    | Logos, images, and the icon files `icons` in `site.config.ts` names |

`components/SiteEffects.tsx` is the mount for this site's own browser-side code
(smooth scrolling, a custom pointer, page transitions): the root layout renders
it once, after hydration and never in the administration. It ships empty and it
is yours. Recipes: `docs/CUSTOMIZATION.md`, "Run code in the browser".

## Golden rule

**Never** modify `app/`, `components/`, `lib/`, `hooks/`, `cms/` or
`convex/`: those areas belong to the engine and are overwritten or merged on
every update. If a customization looks impossible from `site/`, the admin
dashboard (CMS, settings) or `site.config.ts`, then it is an engine change —
open a ticket on `be-yours/beyours`.

Details: `docs/CUSTOMIZATION.md`.
