'use client'

import Link from 'next/link'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { useCmsPage } from '@/lib/cms/useCmsPage'
import {
  LegalClause,
  LegalLine,
  LegalLoading,
  LegalPage,
  LegalSection,
  MediatorLine,
  SellerIdentity,
} from './legal-parts'

/** Code fallback of the « Propriété intellectuelle » clause. */
const DEFAULT_INTELLECTUAL_PROPERTY =
  "<p>L'ensemble des contenus de ce site (textes, photographies, logos, marques) est protégé par le droit de la propriété intellectuelle. Toute reproduction ou représentation, totale ou partielle, sans l'autorisation de l'éditeur est interdite.</p>"

/**
 * Mentions légales (LCEN art. 6-III): who publishes the site, who directs the
 * publication, who hosts it. Every identity line comes from the owner's
 * settings through `legalPages.getPublic`; see `legal-parts.tsx`.
 */
export function LegalNoticeContent() {
  const info = useQuery(api.legalPages.getPublic)
  const { block } = useCmsPage('legal-notice')
  const content = block('content')
  const intellectualProperty =
    content.field('intellectualProperty').text ?? DEFAULT_INTELLECTUAL_PROPERTY
  const additional = content.field('additional').text

  return (
    <LegalPage
      title="Mentions légales"
      intro="Informations prévues par l'article 6-III de la loi n° 2004-575 du 21 juin 2004 pour la confiance dans l'économie numérique."
    >
      {info === undefined ? (
        <LegalLoading />
      ) : (
        <>
          <LegalSection title="Éditeur du site">
            <SellerIdentity info={info} />
          </LegalSection>

          <LegalSection title="Directeur de la publication">
            <LegalLine label="Directeur de la publication" value={info.site.publicationDirector} />
          </LegalSection>

          <LegalSection title="Hébergeur">
            <LegalLine label="Nom" value={info.site.host?.name} />
            <LegalLine label="Adresse" value={info.site.host?.address} />
            <LegalLine label="Téléphone" value={info.site.host?.phone} />
          </LegalSection>

          <LegalSection title="Médiation de la consommation">
            <p>
              En cas de litige non résolu avec l&apos;établissement, vous pouvez recourir
              gratuitement au médiateur de la consommation dont il relève (articles L612-1 et
              suivants du Code de la consommation).
            </p>
            <MediatorLine info={info} />
          </LegalSection>
        </>
      )}

      <LegalSection title="Propriété intellectuelle">
        <LegalClause html={intellectualProperty} />
      </LegalSection>

      <LegalSection title="Données personnelles">
        <p>
          Le traitement de vos données est décrit dans notre{' '}
          <Link href="/confidentialite" className="underline underline-offset-4">
            politique de confidentialité
          </Link>
          . Les conditions de vente en ligne figurent dans nos{' '}
          <Link href="/cgv" className="underline underline-offset-4">
            conditions générales de vente
          </Link>
          .
        </p>
      </LegalSection>

      {additional ? (
        <LegalSection title="Informations complémentaires">
          <LegalClause html={additional} />
        </LegalSection>
      ) : null}
    </LegalPage>
  )
}
