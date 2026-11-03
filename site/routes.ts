/**
 * Site routes — CLIENT ZONE.
 *
 * The pages THIS site adds to the storefront, beside the ones the engine ships.
 * Empty as shipped. An update never touches this file, so what is written here
 * survives `pnpm update:template`.
 *
 * Adding a page takes two files: the route, `app/(storefront)/<name>/page.tsx`
 * (prefix it with a `// SITE-SPECIFIC` comment and import its content from
 * `site/components/`), and one entry here. The entry is what puts the page in
 * `sitemap.xml`, lets `tests/seo/sitemap-robots.test.ts` accept it, and links it
 * from the header or the footer. Delete the entry and the page leaves all three.
 *
 *   {
 *     path: "/evenements",
 *     changeFrequency: "monthly",
 *     priority: 0.6,
 *     nav: { label: "Événements", placement: "header", order: 45 },
 *   }
 *
 * `nav` is optional: leave it out for a page that should be indexed but not
 * linked. The fields, and what becomes of an invalid entry, are documented in
 * `lib/site-routes.ts`; the walkthrough is in `docs/CUSTOMIZATION.md`.
 *
 * Kurry Up (owner of this file: agent « réseau + franchise »; other agents ask through the orchestrator).
 * The engine's header links count 10 (/), 20 (/menu), 30 (/about), 40 (/blog), 50 (/contact). The header
 * of site/ART_DIRECTION.md § 10 reads, by address: left « La carte », « Votre création », « Restaurants »;
 * right « Notre histoire », « Contact ». So /restaurants takes 25 (after the carte, before the about page),
 * leaving 21 to 24 for « Votre création » if it becomes a route of the site.
 */

import type { SitePublicRoute } from '@/lib/site-routes'

export const sitePublicRoutes: SitePublicRoute[] = [
  // « Le mur des adresses »: the network, and Paris Washington, the one restaurant that takes orders here.
  {
    path: '/restaurants',
    changeFrequency: 'monthly',
    priority: 0.8,
    nav: { label: 'Restaurants', placement: 'header', order: 25 },
  },
  // Franchise: a page apart from ordering, linked from the FOOTER only (salon rule), never from the header.
  // The CMS footer column « Kurry Up » also carries « Ouvrir un restaurant » → /franchise (site/seed/data.mjs);
  // this entry joins the « Liens utiles » defaults, which the seed's own links replace, and puts the page in
  // sitemap.xml.
  {
    path: '/franchise',
    changeFrequency: 'monthly',
    priority: 0.5,
    nav: { label: 'Ouvrir un Kurry Up', placement: 'footer', order: 90 },
  },
]
