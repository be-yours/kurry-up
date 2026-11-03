import { Suspense } from 'react'
import type { Metadata } from 'next'
import { generateCmsMetadata } from '@/lib/cms/seo'
import { TermsOfSaleContent } from '@/components/storefront/legal'

export async function generateMetadata(): Promise<Metadata> {
  return generateCmsMetadata({
    pageSlug: 'terms-of-sale',
    pathname: '/cgv',
    fallbackTitle: 'Conditions générales de vente',
    fallbackDescription: 'Conditions applicables aux commandes passées en ligne.',
  })
}

export default function TermsOfSale() {
  return (
    <Suspense>
      <TermsOfSaleContent />
    </Suspense>
  )
}
