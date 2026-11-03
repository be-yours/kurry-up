import type { Metadata } from 'next'
import { PRIVATE_PAGE_METADATA } from '@/lib/crawler-policy'
import FeedbackContent from './_components/FeedbackContent'

/**
 * A guest's own satisfaction answer, by opaque token: the link in the thank-you e-mail.
 *
 * The token is the whole authorisation, so — like the booking's manage page — the page
 * must not be indexed, and `robots.txt` disallows the path. It is reachable whatever the
 * restaurant's switch says: a guest who was thanked for a visit may answer it later.
 *
 * `?score=1..5` is the link behind each number in the e-mail. It PRESELECTS a score and
 * records nothing: a mail scanner follows every link it finds, and an answer given by a
 * link would be given by a robot. The guest confirms with the button.
 */
export const metadata: Metadata = {
  title: 'Votre avis sur votre visite',
  description: "Dites au restaurant comment s'est passée votre visite.",
  robots: PRIVATE_PAGE_METADATA,
}

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ score?: string | string[] }>
}) {
  const { score } = await searchParams
  const raw = Array.isArray(score) ? score[0] : score
  const parsed = raw !== undefined && /^[1-5]$/.test(raw) ? Number(raw) : null
  return <FeedbackContent initialScore={parsed} />
}
