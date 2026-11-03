import type { Metadata } from 'next'
import { PRIVATE_PAGE_METADATA } from '@/lib/crawler-policy'
import { readReturnState } from '../../_components/reservation-payment'
import PaymentContent from './_components/PaymentContent'

/**
 * Where a guest pays the deposit or secures the card guarantee of their booking, by the
 * booking's opaque token: the page the booking form sends them to, and the page the
 * payment provider sends them back to.
 *
 * The token is the whole authorisation, so — like the booking's manage page — the page
 * must not be indexed, and `robots.txt` disallows the path. It is reachable whatever the
 * restaurant's switch says: a guest who has already booked must still be able to pay,
 * or to read that the table was released.
 *
 * `?return=success` and `?return=cancelled` are the two addresses the server gives the
 * provider. They record nothing and prove nothing: the page asks the server to read the
 * payment back from the provider, and shows what the server then holds.
 */
export const metadata: Metadata = {
  title: 'Paiement de votre réservation',
  description: 'Réglez ou garantissez votre réservation de table.',
  robots: PRIVATE_PAGE_METADATA,
}

export default async function ReservationPaymentPage({
  searchParams,
}: {
  searchParams: Promise<{ return?: string | string[] }>
}) {
  const { return: returned } = await searchParams
  return <PaymentContent returned={readReturnState(returned)} />
}
