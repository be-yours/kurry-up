import { Suspense } from 'react'
import type { Metadata } from 'next'
import { generateCmsMetadata } from '@/lib/cms/seo'
import { PrivacyPolicyContent } from '@/components/storefront/legal'

export async function generateMetadata(): Promise<Metadata> {
  return generateCmsMetadata({
    pageSlug: 'privacy-policy',
    pathname: '/confidentialite',
    fallbackTitle: 'Politique de confidentialité',
    fallbackDescription: 'Données collectées, durées de conservation et exercice de vos droits.',
  })
}

export default function PrivacyPolicy() {
  return (
    <Suspense>
      <PrivacyPolicyContent />
    </Suspense>
  )
}
