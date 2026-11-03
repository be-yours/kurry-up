// SITE-SPECIFIC
// /franchise, « Ouvrir un Kurry Up » (Kurry Up). Content: site/components/franchise/. Registered in site/routes.ts
// with a FOOTER link only: never the header, never a banner on a customer page. No franchise amount anywhere.
import type { Metadata } from 'next'

import { buildSeoMetadata } from '@/lib/seo'
import { FR } from '@/site/components/franchise/copy'
import { FranchisePage } from '@/site/components/franchise/FranchisePage'

export async function generateMetadata(): Promise<Metadata> {
  return buildSeoMetadata({
    pathname: '/franchise',
    fallbackTitle: FR.meta.title,
    fallbackDescription: FR.meta.description,
  })
}

export default function Page() {
  return <FranchisePage />
}
