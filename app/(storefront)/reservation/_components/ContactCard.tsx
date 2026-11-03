'use client'

/**
 * « Contactez-nous » — the way on for a party too large for the form, and for a request that
 * will not be answered online (declined, expired, a proposal that lapsed).
 *
 * It is never a dead end: it carries the establishment's phone and address when it has them,
 * and, when it has neither, says to use the contact page and the address printed on the site.
 */

import Link from 'next/link'
import { Mail, Phone } from 'lucide-react'
import { mailtoHref, telHref } from './reservation-groups'

export interface ContactCardProps {
  storeName?: string
  phone: string | null
  email: string | null
  /** The sentence that says why the guest is being sent here. */
  lead: string
  /** Heading level id, so two cards on one page keep distinct labels. */
  id?: string
  /** The subject of the e-mail the link opens, when there is one. */
  subject?: string
}

export function ContactCard({
  storeName,
  phone,
  email,
  lead,
  id = 'contact-card',
  subject,
}: ContactCardProps) {
  const name = storeName?.trim()
  return (
    <section
      aria-labelledby={`${id}-title`}
      data-testid="contact-card"
      className="space-y-3 rounded-2xl border border-border bg-card p-5"
    >
      <h2 id={`${id}-title`} className="text-lg font-semibold text-foreground">
        {name ? `Contacter ${name}` : 'Nous contacter'}
      </h2>
      <p className="text-foreground">{lead}</p>
      {phone || email ? (
        <ul className="space-y-2">
          {phone && (
            <li>
              <a
                href={telHref(phone)}
                className="inline-flex min-h-11 items-center gap-2 font-semibold text-foreground underline underline-offset-4"
              >
                <Phone className="h-4 w-4" aria-hidden="true" />
                <span>
                  <span className="sr-only">Appeler le </span>
                  {phone}
                </span>
              </a>
            </li>
          )}
          {email && (
            <li>
              <a
                href={mailtoHref(email, subject)}
                className="inline-flex min-h-11 items-center gap-2 font-semibold text-foreground underline underline-offset-4"
              >
                <Mail className="h-4 w-4" aria-hidden="true" />
                <span>
                  <span className="sr-only">Écrire à </span>
                  {email}
                </span>
              </a>
            </li>
          )}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          Utilisez la{' '}
          <Link
            href="/contact"
            className="font-semibold text-foreground underline underline-offset-4"
          >
            page de contact
          </Link>{' '}
          du site, ou l&apos;adresse indiquée en bas de page.
        </p>
      )}
    </section>
  )
}
