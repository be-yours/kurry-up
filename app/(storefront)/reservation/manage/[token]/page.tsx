import type { Metadata } from 'next'
import { PRIVATE_PAGE_METADATA } from '@/lib/crawler-policy'
import ManageReservationContent from './_components/ManageReservationContent'

/**
 * A guest's own booking, by opaque token.
 *
 * The token is the whole authorisation, so the page must not be indexed: a
 * manage link in a search result hands a stranger someone else's table. The
 * path is disallowed in `robots.txt` and the page repeats it here.
 *
 * Unlike the booking page it stays reachable when the restaurant switches
 * reservations off — a guest who already booked must still be able to see, and
 * cancel, their table.
 */
export const metadata: Metadata = {
  title: 'Ma réservation',
  description: 'Consultez ou annulez votre réservation.',
  robots: PRIVATE_PAGE_METADATA,
}

export default function ManageReservationPage() {
  return <ManageReservationContent />
}
