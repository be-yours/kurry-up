import type { Metadata } from 'next'
import { PRIVATE_PAGE_METADATA } from '@/lib/crawler-policy'
import WaitlistContent from './_components/WaitlistContent'

/**
 * A guest's own waitlist request, by opaque token: where they stand, the table
 * they are offered, and the way to leave.
 *
 * The token is the whole authorisation, so — like the booking's manage page — the
 * page must not be indexed, and `robots.txt` disallows the path. It stays reachable
 * when the restaurant switches reservations off: a guest who was offered a table
 * must still be able to read that it is gone.
 */
export const metadata: Metadata = {
  title: "Ma liste d'attente",
  description: "Consultez ou retirez votre demande d'être prévenu.",
  robots: PRIVATE_PAGE_METADATA,
}

export default function WaitlistPage() {
  return <WaitlistContent />
}
