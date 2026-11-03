import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { resolveReservationMode, type ReservationModeSource } from '@be-yours/convex-schema'
import { generateCmsMetadata } from '@/lib/cms/seo'
import { resolveStorefrontStore } from '@/lib/convex-server'
import ExperiencesSection from './_components/ExperiencesSection'
import ReservationContent from './_components/ReservationContent'

export async function generateMetadata(): Promise<Metadata> {
  return generateCmsMetadata({
    pageSlug: 'reservation',
    pathname: '/reservation',
    fallbackTitle: 'Réserver une table',
    fallbackDescription: 'Choisissez votre date, votre horaire et le nombre de convives.',
  })
}

/**
 * The booking page, which exists only while the establishment's switch is on.
 *
 * `resolveReservationMode` is the same answer the header button, the footer and
 * every server function ask, so a restaurateur who turns reservations off gets a
 * real 404 here — not a page that loads and explains itself. The server
 * functions refuse as well; this is the half a visitor sees.
 *
 * The establishment is the one `resolveStorefrontStore` picks for the request
 * (cookie, then the first published). A deployment with several establishments
 * and no cookie can therefore disagree with the browser's own choice for one
 * render; the client then follows the browser's, and the server functions refuse
 * an establishment whose switch is off.
 */
export default async function ReservationPage() {
  const store = await resolveStorefrontStore()
  if (!store || resolveReservationMode(store as ReservationModeSource) !== 'native') {
    notFound()
  }

  // The events section sits inside the page's own landmark, under the booking form.
  return <ReservationContent afterForm={<ExperiencesSection />} />
}
