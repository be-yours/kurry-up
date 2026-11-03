// SITE-SPECIFIC
// /restaurants, « Le mur des adresses » (Kurry Up). Content: site/components/restaurants/. Registered in site/routes.ts
// (header). The network is hand-written data (site/components/network.ts); only Paris Washington takes orders.
import type { Metadata } from 'next'

import { buildSeoMetadata } from '@/lib/seo'
import { COPY } from '@/site/components/restaurants/copy'
import { RestaurantsPage } from '@/site/components/restaurants/RestaurantsPage'

export async function generateMetadata(): Promise<Metadata> {
  return buildSeoMetadata({
    pathname: '/restaurants',
    fallbackTitle: COPY.meta.title,
    fallbackDescription: COPY.meta.description,
  })
}

export default function Page() {
  return <RestaurantsPage />
}
