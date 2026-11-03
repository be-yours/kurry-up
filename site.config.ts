/**
 * Site configuration — CLIENT ZONE.
 *
 * This file belongs to the site: it is NEVER overwritten by a template or
 * engine update. It is the single entry point for the site's build-time
 * identity (metadata, default locale, color scheme, image hosts).
 *
 * Everything the restaurant owner can change in production (opening hours,
 * menus, copy, CMS section colors, and so on) lives in Convex (globalSettings /
 * CMS) and is edited from the admin dashboard — not here.
 */

export const siteConfig = {
  /** Public name of the restaurant / site. Used in <title>, OG tags, base emails. */
  name: "Kurry Up",

  /** Default description (SEO / Open Graph). */
  description: "Commande en ligne, click & collect et livraison.",

  /** Title template for inner pages. `%s` = the page title. */
  titleTemplate: "%s | Kurry Up",

  /**
   * Canonical site URL in production.
   * Locally, NEXT_PUBLIC_APP_URL takes precedence (set in .env.local).
   */
  url: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",

  /** Default locale before the visitor has picked one (beid_locale cookie). */
  defaultLocale: "fr",

  /**
   * The color scheme. Both fields are optional: leave the entry out and the
   * values below apply.
   *
   * `default` is what a visitor sees before they have chosen. "system" follows
   * their device, "light" and "dark" fix the first impression. It is not a
   * lock: a visitor who picks a scheme with the toggle in the header keeps
   * that pick, stored in their browser.
   *
   * `toggle: false` removes that toggle from the storefront header. The admin
   * keeps its own.
   */
  theme: {
    default: "system",
    toggle: true,
  },

  /**
   * Browser-tab icons: paths in `public/`, or `https:` URLs. Uncomment what the
   * site has.
   *
   * The engine ships no icon of its own — `app/favicon.ico` used to, and a
   * file-based icon outranks everything else Next.js reads, so it hid whatever
   * a site put in `public/`. Left empty, a browser asks `/favicon.ico` as it
   * always does, served from `public/favicon.ico` if there is one. The CMS
   * favicon (admin → Layout du storefront → Identité visuelle) still replaces
   * whichever is declared here once the page has loaded.
   *
   * Not importing a type here is deliberate: `next.config.ts` reads this file
   * before the `@/` alias exists.
   */
  icons: {
    // icon: "/brand/favicon.png",
    // apple: "/brand/apple-touch-icon.png",
  } as { icon?: string; shortcut?: string; apple?: string },

  images: {
    /**
     * Extra remote hosts allowed for next/image.
     *
     * The site's own S3 bucket does NOT belong here: it is private, and its
     * media is served same-origin by `/api/files`. If this site puts a CDN in
     * front of the bucket, declare it once in `AWS_S3_PUBLIC_BASE_URL` — the
     * host is allowed from there. This list is for third-party image hosts.
     */
    remoteHosts: [
      "images.unsplash.com",
      "i.pravatar.cc",
    ],
  },
} as const

export type SiteConfig = typeof siteConfig
