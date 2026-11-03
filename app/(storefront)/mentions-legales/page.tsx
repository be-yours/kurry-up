import { Suspense } from 'react'
import type { Metadata } from 'next'
import { generateCmsMetadata } from '@/lib/cms/seo'
import { LegalNoticeContent } from '@/components/storefront/legal'

export async function generateMetadata(): Promise<Metadata> {
  return generateCmsMetadata({
    pageSlug: 'legal-notice',
    pathname: '/mentions-legales',
    fallbackTitle: 'Mentions légales',
    fallbackDescription: 'Éditeur, directeur de la publication et hébergeur du site.',
  })
}

export default function LegalNotice() {
  return (
    <Suspense>
      <LegalNoticeContent />
    </Suspense>
  )
}
