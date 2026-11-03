'use client'

import type { ReactNode } from 'react'
import type { PublicLegalInfo } from '@be-yours/convex-functions/legalPages'
import { formatPrice } from '@be-yours/restaurant'
import { CmsRichText } from '@/components/storefront/cms-rich-text'
import { safeSocialUrl } from '@/lib/social-links'

/**
 * Shared pieces of the three engine-owned legal pages: mentions légales, CGV
 * and politique de confidentialité.
 *
 * THE ONE RULE: a statement about the establishment comes from what its owner
 * entered, or the page says it was not given. `LegalValue` is the only way a
 * value reaches the page, and its fallback is « non communiqué », never a
 * plausible example — CLAUDE.md: a figure about an establishment is the
 * establishment's to state.
 *
 * The wording itself is a template written by the engine, NOT reviewed legal
 * text: it is to be validated by counsel before a site goes live, and the
 * admin says so to the owner (Paramètres → Mentions légales).
 */

/** What the page prints in place of a statement the owner has not made. */
export const NOT_PROVIDED = "non communiqué par l'établissement"

export function LegalPage({
  title,
  intro,
  children,
}: {
  title: string
  intro?: ReactNode
  children: ReactNode
}) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 md:py-24">
      <h1 className="text-3xl font-black tracking-tight text-foreground md:text-4xl">{title}</h1>
      {intro ? (
        <div className="mt-4 text-sm leading-relaxed text-muted-foreground">{intro}</div>
      ) : null}
      <div className="mt-10 space-y-10">{children}</div>
    </main>
  )
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-foreground">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-foreground">{children}</div>
    </section>
  )
}

/** A value the owner entered, or the plain statement that they did not. */
export function LegalValue({ value }: { value: string | undefined | null }) {
  if (value && value.trim()) return <>{value}</>
  return (
    <span data-legal-missing="" className="italic text-muted-foreground">
      {NOT_PROVIDED}
    </span>
  )
}

/** One « label : value » line. */
export function LegalLine({ label, value }: { label: string; value: string | undefined | null }) {
  return (
    <p>
      <span className="font-semibold">{label} : </span>
      <LegalValue value={value} />
    </p>
  )
}

/** Renders a CMS richtext clause, or its code fallback. */
export function LegalClause({ html }: { html: string }) {
  return (
    <CmsRichText
      html={html}
      className="prose prose-sm max-w-none text-foreground dark:prose-invert"
    />
  )
}

export function formatSeat(seller: PublicLegalInfo['seller']): string | undefined {
  const a = seller.address
  if (!a) return undefined
  return [a.street, `${a.postalCode} ${a.city}`, a.country].filter(Boolean).join(', ')
}

/** « RCS Lyon 123 456 789 », « SIREN 123 456 789 », or both. */
export function formatRegistration(seller: PublicLegalInfo['seller']): string | undefined {
  const parts = [seller.rcs, seller.siren ? `SIREN ${seller.siren}` : undefined].filter(
    (part): part is string => Boolean(part),
  )
  return parts.length > 0 ? parts.join(' — ') : undefined
}

/** « SARL au capital de 10 000,00 € » — only what was entered. */
export function formatLegalForm(seller: PublicLegalInfo['seller']): string | undefined {
  if (!seller.legalForm) return undefined
  return seller.shareCapital != null
    ? `${seller.legalForm} au capital de ${formatPrice(seller.shareCapital)}`
    : seller.legalForm
}

/**
 * A retention window in words. Whole years and whole months read as such;
 * anything else stays in days rather than being rounded into a promise the
 * sweep does not keep.
 */
export function formatRetention(days: number): string {
  if (days % 365 === 0) {
    const years = days / 365
    return years === 1 ? '1 an' : `${years} ans`
  }
  if (days % 30 === 0) return `${days / 30} mois`
  return days === 1 ? '1 jour' : `${days} jours`
}

/** The seller's identity block, shared by the mentions légales and the CGV. */
export function SellerIdentity({ info }: { info: PublicLegalInfo }) {
  const { seller, site } = info
  return (
    <>
      <LegalLine label="Dénomination sociale" value={seller.legalName} />
      {seller.legalForm ? (
        <LegalLine label="Forme juridique" value={formatLegalForm(seller)} />
      ) : null}
      <LegalLine label="Siège social" value={formatSeat(seller)} />
      <LegalLine label="Immatriculation" value={formatRegistration(seller)} />
      {seller.siret ? <LegalLine label="SIRET" value={seller.siret} /> : null}
      {seller.vatNumber ? (
        <LegalLine label="N° de TVA intracommunautaire" value={seller.vatNumber} />
      ) : null}
      <LegalLine label="E-mail" value={site.contactEmail} />
      <LegalLine label="Téléphone" value={site.contactPhone} />
    </>
  )
}

/**
 * The mediator: its name, and its website as a link.
 *
 * Whatever was entered is shown — a name without a website is still the
 * establishment's statement, and the admin lists the missing half. The
 * website becomes an `href` only as an `https:` URL: it is owner-typed text
 * rendered on a public page, so `javascript:` and its cousins stay text.
 */
export function MediatorLine({ info }: { info: PublicLegalInfo }) {
  const mediator = info.site.mediator
  if (!mediator?.name && !mediator?.website) {
    return <LegalLine label="Médiateur de la consommation" value={undefined} />
  }
  const href = safeSocialUrl(mediator.website)
  return (
    <p>
      <span className="font-semibold">Médiateur de la consommation : </span>
      {mediator.name ?? <LegalValue value={undefined} />} —{' '}
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-4"
        >
          {href}
        </a>
      ) : mediator.website ? (
        mediator.website
      ) : (
        <LegalValue value={undefined} />
      )}
    </p>
  )
}

/** While the query is in flight: the title is already there, the rest is not. */
export function LegalLoading() {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      Chargement…
    </p>
  )
}
