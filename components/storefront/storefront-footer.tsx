"use client"

import { resolveBrandName } from "@/lib/cms/brand-name"
import { useState, useId } from "react"
import Link from "next/link"
import { MapPin, Phone, Clock, Mail } from "lucide-react"
import { useMutation } from "convex/react"
import { z } from "zod"
import { Button, Input } from "@be-yours/ui"
import { useTranslation } from "@be-yours/restaurant"
import { resolveReservationMode, type ReservationModeSource } from "@be-yours/convex-schema"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { useStoreId } from "@/lib/hooks"
import { useCmsPage, type CmsBlockAccessor } from "@/lib/cms/useCmsPage"
import { SOCIAL_PLATFORMS, socialLinks } from "@/lib/social-links"
import {
  customFooterLinks,
  resolveFooterColumn,
  type FooterLink,
} from "@/lib/footer-links"
import { convexErrorCode } from "@/lib/convex-error"
import { mergeNavLinks, siteNavLinks } from "@/lib/site-routes"
import { toast } from "sonner"
import { SOCIAL_ICONS } from "./social-icons"

/**
 * The engine's own links for the two columns, by translation key.
 *
 * Labels are keys, not words: this was two arrays of French literals — « Box »
 * among them, in a French shop — that no language switch and no owner could
 * touch. A site that wants other links gives the column links of its own in the
 * CMS (`footerNav`, `footerUseful`), and these are what is shown until it does.
 *
 * `multiStoreOnly` marks a link that leads to a choice. « Nos restaurants » goes
 * to the selector, which is a dead end on a deployment with one establishment.
 */
interface DefaultFooterLink {
  href: string
  labelKey: string
  multiStoreOnly?: boolean
}

const DEFAULT_NAV_LINKS: readonly DefaultFooterLink[] = [
  { href: "/menu", labelKey: "nav.menu" },
  { href: "/cart", labelKey: "nav.cart" },
  { href: "/account/orders", labelKey: "footer.myOrders" },
  { href: "/account/favorites", labelKey: "footer.myFavorites" },
]

const DEFAULT_USEFUL_LINKS: readonly DefaultFooterLink[] = [
  { href: "/account", labelKey: "nav.account" },
  { href: "/account/addresses", labelKey: "footer.myAddresses" },
  { href: "/store-selector", labelKey: "footer.ourRestaurants", multiStoreOnly: true },
]

/**
 * Tailwind reads class names off the page's source, so the grid width for each
 * number of columns is written out rather than assembled. Two is the floor: the
 * brand column and the newsletter are not optional.
 */
const GRID_COLUMNS: Record<number, string> = {
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
}

/**
 * One link column, or null when it is not drawn: hidden by its owner, or empty.
 * The title is the owner's when they typed one, the catalogue's otherwise.
 */
function footerColumn(
  cmsBlock: CmsBlockAccessor,
  defaults: readonly FooterLink[],
  defaultTitle: string,
  dropNativeReservation: boolean,
): { title: string; links: readonly FooterLink[] } | null {
  const links = resolveFooterColumn({
    hidden: cmsBlock.field("display").text === "hide",
    custom: customFooterLinks((field) => cmsBlock.field(field).text),
    defaults,
    dropNativeReservation,
  })
  if (!links) return null
  return { title: cmsBlock.field("title").text?.trim() || defaultTitle, links }
}

/**
 * A column's defaults with the footer links the site registered in
 * `site/routes.ts`. They are defaults like the engine's own, so links an owner
 * types for the column replace all of them, and hiding the column draws none.
 * A registered link is a page of this site, hence `internal`.
 */
function withSiteFooterLinks(defaults: readonly FooterLink[]): FooterLink[] {
  return mergeNavLinks(defaults, siteNavLinks("footer")).map((link) =>
    "kind" in link ? link : { ...link, kind: "internal" as const },
  )
}

/**
 * The anchor for one link, by where it leads. It carries no colour of its own:
 * the caller passes the classes, so every `text-primary-foreground` in this file
 * stays inside the `<footer className="… bg-primary-hover …">` that paints it.
 * The contrast sweep resolves a text colour's ground by walking up the JSX it
 * sits in, and a colour in a helper outside that element has no ground to be
 * measured against — which is how this file briefly dropped out of the sweep
 * that once caught its copyright at 1.07:1.
 */
function FooterLinkItem({ link, className }: { link: FooterLink; className: string }) {
  if (link.kind === "internal") {
    return (
      <Link href={link.href} className={className}>
        {link.label}
      </Link>
    )
  }
  if (link.kind === "web") {
    return (
      <a href={link.href} target="_blank" rel="noopener noreferrer" className={className}>
        {link.label}
      </a>
    )
  }
  return (
    <a href={link.href} className={className}>
      {link.label}
    </a>
  )
}

/**
 * The engine-owned legal pages. Every page of the storefront links them: a
 * site that takes orders owes its mentions légales, CGV and privacy policy
 * from wherever the diner is, and the footer is the one place on all of them.
 */
const legalLinks = [
  { href: "/mentions-legales", labelKey: "footer.legalNotice" },
  { href: "/cgv", labelKey: "footer.termsOfService" },
  { href: "/confidentialite", labelKey: "footer.privacyPolicy" },
] as const

/**
 * The same shape the server enforces, checked here so a typo costs no round
 * trip and does not spend one of the visitor's five hourly signups.
 *
 * The server check is the real one — this form is not the only caller of a
 * public mutation — and both have to exist for the same reason a client-side
 * check alone is never enough.
 */
const newsletterEmailSchema = z
  .string()
  .trim()
  .min(1, "Renseignez votre adresse email.")
  .email("Vérifiez votre adresse email.")

export function StorefrontFooter() {
  const { storeId, store, storeCount } = useStoreId()
  const [email, setEmail] = useState("")
  const [subscribing, setSubscribing] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)
  const inputId = useId()
  const emailInputId = `${inputId}-newsletter-email`
  const emailErrorId = `${inputId}-newsletter-error`
  const subscribe = useMutation(api.emailSubscribers.subscribe)
  const { t } = useTranslation()
  const { block } = useCmsPage("storefront-layout")
  const social = block("social")
  // One field per network the engine knows (`SOCIAL_PLATFORMS`), so a network
  // added there is read here without a second list to keep in step.
  const socials = socialLinks(
    Object.fromEntries(SOCIAL_PLATFORMS.map((platform) => [platform, social.field(platform).text])),
  )

  // The engine's sentence about what the establishment offers is gone: it said
  // « faites-vous livrer » on every site, delivering or not. The owner writes
  // their own in « Pied de page », or the column opens on the contact lines.
  const tagline = block("footer").field("tagline").text?.trim() || null

  // `storeCount` is 0 while the list loads, so a deployment with one
  // establishment never flashes the selector link before its count arrives.
  const multiStore = storeCount > 1
  const defaultLinks = (links: readonly DefaultFooterLink[]): FooterLink[] =>
    links
      .filter((link) => multiStore || !link.multiStoreOnly)
      .map((link) => ({ href: link.href, label: t(link.labelKey), kind: "internal" as const }))
  // The reservation switch is the same answer the header reads. Off, a link the
  // owner typed to the booking page must not outlive the page.
  const dropNativeReservation =
    resolveReservationMode(store as ReservationModeSource | null) !== "native"
  const navigation = footerColumn(
    block("footerNav"),
    defaultLinks(DEFAULT_NAV_LINKS),
    t("footer.navigation"),
    dropNativeReservation,
  )
  const usefulLinks = footerColumn(
    block("footerUseful"),
    withSiteFooterLinks(defaultLinks(DEFAULT_USEFUL_LINKS)),
    t("footer.usefulLinks"),
    dropNativeReservation,
  )
  // Navigation first, then the useful links: the two columns the grid places
  // between the brand and the newsletter, whichever of them is drawn.
  const linkColumns: Array<{ key: string; title: string; links: readonly FooterLink[] }> = []
  if (navigation) linkColumns.push({ key: "navigation", ...navigation })
  if (usefulLinks) linkColumns.push({ key: "useful", ...usefulLinks })
  const gridColumns = GRID_COLUMNS[2 + linkColumns.length]

  /**
   * This form called no mutation at all.
   *
   * It read the address, discarded it, and showed "Vous êtes maintenant
   * inscrit" — so a visitor who signed up in the footer was never recorded
   * anywhere, in any state, and had no way of knowing. The two other signup
   * surfaces at least write a row.
   *
   * It then accepted anything shaped like text. `pas-un-email` was written to
   * the list and answered with the same "check your inbox" — a row SES can only
   * bounce, on the ratio AWS suspends the account over.
   */
  async function handleNewsletterSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (subscribing || !storeId) return

    const parsed = newsletterEmailSchema.safeParse(email)
    if (!parsed.success) {
      setEmailError(parsed.error.issues[0]?.message ?? "Vérifiez votre adresse email.")
      return
    }
    setEmailError(null)

    setSubscribing(true)
    try {
      await subscribe({ storeId: storeId as Id<"stores">, email: parsed.data })
      // Deliberately not "vous êtes inscrit": they are not, yet. The row is
      // `pending` until they open the link, and only `active` subscribers are
      // ever mailed.
      toast.success("Presque fini", {
        description:
          "Ouvrez le lien que nous venons de vous envoyer pour confirmer votre inscription.",
      })
      setEmail("")
    } catch (error) {
      // `subscribe` refuses with a ConvexError code, so each case gets the
      // answer that is true of it. Anything else genuinely failed to write, and
      // must not be reported as anything but that.
      const code = convexErrorCode(error)
      if (code === "already_subscribed") {
        toast.error("Cette adresse est déjà inscrite.")
      } else if (code === "invalid_email") {
        setEmailError("Vérifiez votre adresse email.")
      } else {
        toast.error("Votre inscription n'a pas pu être enregistrée.", {
          description: "Réessayez dans un instant.",
        })
      }
    } finally {
      setSubscribing(false)
    }
  }

  return (
    // `storefront-footer*` are hooks for the `foot` layout family (#507), not
    // styling. A template picks `columns`, `center` or `heavy`, and the rules
    // live in `app/globals.css` under `.storefront-theme` — Tailwind's generated
    // class names are not a contract, so the CSS needs names of its own. The
    // default here IS `columns`, so an unstyled footer is already correct.
    <footer className="storefront-footer bg-primary-hover pt-24 pb-12 px-6 md:px-12">
      <div className="max-w-7xl mx-auto">
        {/* Two to four columns: the brand, up to two link columns, the newsletter */}
        <div className={`storefront-footer-cols grid grid-cols-1 md:grid-cols-2 ${gridColumns} gap-16`}>

          {/* Column 1 — Brand + contact */}
          <div>
            <h2 className={`storefront-footer-brand text-2xl font-black tracking-tighter text-primary-foreground ${tagline ? "mb-4" : "mb-8"}`}>
              {/* The vendor was the fallback here too (#613). */}
              {resolveBrandName({ storeName: store?.name })}
            </h2>
            {tagline && (
              <p className="text-sm text-primary-foreground leading-relaxed mb-8">
                {tagline}
              </p>
            )}

            <div className="flex flex-col gap-4">
              <div className={`flex items-start gap-3 ${store?.address ? "" : "hidden"}`}>
                <MapPin className="h-4 w-4 text-primary-foreground flex-shrink-0 mt-0.5" />
                <span className="text-sm text-primary-foreground">
                  {store?.address ? `${store.address.street}, ${store.address.postalCode} ${store.address.city}` : ""}
                </span>
              </div>

              <div className={`flex items-center gap-3 ${store?.phone ? "" : "hidden"}`}>
                <Phone className="h-4 w-4 text-primary-foreground flex-shrink-0" />
                <span className="text-sm text-primary-foreground">{store?.phone ?? ""}</span>
              </div>

              <div className={`flex items-center gap-3 ${store?.email ? "" : "hidden"}`}>
                <Mail className="h-4 w-4 text-primary-foreground flex-shrink-0" />
                <span className="text-sm text-primary-foreground">{store?.email ?? ""}</span>
              </div>

              <div className="flex items-center gap-3">
                <Clock className="h-4 w-4 text-primary-foreground flex-shrink-0" />
                <span className="text-sm text-primary-foreground">Voir les horaires sur le menu</span>
              </div>
            </div>
          </div>

          {/* Columns 2 and 3 — Navigation and Liens utiles. Each is the engine's
              links, the owner's own, or absent (see `footerColumn`). */}
          {linkColumns.map((column) => (
            <div key={column.key}>
              <h3 className="text-lg font-black uppercase tracking-widest text-primary-foreground mb-8 border-b border-white/10 pb-4">
                {column.title}
              </h3>
              <nav aria-label={column.title} className="flex flex-col gap-3">
                {column.links.map((link, index) => (
                  <FooterLinkItem
                    key={`${index}:${link.href}`}
                    link={link}
                    className="text-primary-foreground font-bold text-sm transition-colors hover:underline hover:underline-offset-4"
                  />
                ))}
              </nav>
            </div>
          ))}

          {/* Column 4 — Newsletter */}
          <div>
            <h3 className="text-lg font-black uppercase tracking-widest text-primary-foreground mb-8 border-b border-white/10 pb-4">
              Newsletter
            </h3>
            <p className="text-sm text-primary-foreground mb-6 leading-relaxed">
              Recevez nos offres exclusives et nouveautés directement dans votre boîte mail.
            </p>

            <form onSubmit={handleNewsletterSubmit} noValidate>
              {/* A placeholder is not a label: it disappears on the first
                  keystroke and screen readers are not required to announce it. */}
              <label htmlFor={emailInputId} className="sr-only">
                Votre adresse email
              </label>
              <div className="relative">
                <Input
                  id={emailInputId}
                  type="email"
                  placeholder="Votre adresse email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    if (emailError) setEmailError(null)
                  }}
                  aria-invalid={emailError ? true : undefined}
                  aria-describedby={emailError ? emailErrorId : undefined}
                  className="bg-primary-hover border-white/20 h-14 rounded-xl text-primary-foreground placeholder:text-primary-foreground pr-28 focus-visible:ring-primary focus-visible:border-primary aria-invalid:border-destructive"
                  required
                />
                <Button
                  type="submit"
                  disabled={subscribing || !storeId}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 h-11 bg-primary-foreground hover:text-primary-hover font-black text-[10px] uppercase tracking-widest rounded-lg px-4 text-primary transition-colors"
                >
                  {subscribing ? "Envoi…" : "S'inscrire"}
                </Button>
              </div>
              {emailError && (
                <p
                  id={emailErrorId}
                  role="alert"
                  className="mt-2 pl-1 text-xs font-bold text-primary-foreground"
                >
                  {emailError}
                </p>
              )}
            </form>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="storefront-footer-note border-t border-white/10 pt-12 mt-16 flex flex-col sm:flex-row items-center justify-between gap-6">
          <p className="text-xs font-bold text-primary-foreground uppercase tracking-widest">
            &copy; {new Date().getFullYear()} {store?.name ?? "Restaurant"}. Tous droits réservés.
          </p>

          <nav aria-label="Informations légales" className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            {legalLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-xs font-bold text-primary-foreground transition-colors hover:underline hover:underline-offset-4"
              >
                {t(link.labelKey)}
              </Link>
            ))}
          </nav>

          {/* Social icons — only the networks the owner configured. They were
              three `href="#"` placeholders on every site (see social-links.ts). */}
          {socials.length > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-3">
              {socials.map(({ platform, href, label }) => {
                const Icon = SOCIAL_ICONS[platform]
                return (
                  <a
                    key={platform}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={label}
                    className="h-10 w-10 rounded-full bg-primary-hover text-primary-foreground flex items-center justify-center transition-colors"
                  >
                    <Icon className="h-4 w-4" />
                  </a>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </footer>
  )
}
