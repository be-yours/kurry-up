'use client'

import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { useCmsPage } from '@/lib/cms/useCmsPage'
import {
  formatRetention,
  formatSeat,
  LegalClause,
  LegalLine,
  LegalLoading,
  LegalPage,
  LegalSection,
  LegalValue,
} from './legal-parts'

/**
 * Politique de confidentialité (RGPD art. 13).
 *
 * Everything that is a fact of this deployment comes from
 * `legalPages.getPublic`: the controller's identity, the retention windows
 * `privacy.ts` enforces, and the processors actually configured. The rights
 * section describes what the engine really does with an erasure request —
 * paid orders are anonymised, invoices survive under art. 17.3.b — so the
 * policy and the operator's report (`privacy.ts`, `STEP_NOTES`) say the same
 * thing.
 */
export function PrivacyPolicyContent() {
  const info = useQuery(api.legalPages.getPublic)
  const { block } = useCmsPage('privacy-policy')
  const additional = block('content').field('additional').text

  return (
    <LegalPage
      title="Politique de confidentialité"
      intro="Cette page explique quelles données personnelles sont collectées lorsque vous utilisez ce site, pourquoi, combien de temps elles sont conservées et comment exercer vos droits (articles 12 à 14 du RGPD)."
    >
      {info === undefined ? (
        <LegalLoading />
      ) : (
        <>
          <LegalSection title="Responsable du traitement">
            <p>
              Le responsable du traitement de vos données est l&apos;établissement qui exploite ce
              site :
            </p>
            <LegalLine label="Dénomination" value={info.seller.legalName} />
            <LegalLine label="Adresse" value={formatSeat(info.seller)} />
            <LegalLine label="Contact" value={info.site.contactEmail} />
          </LegalSection>

          <LegalSection title="Données collectées et finalités">
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong>Votre commande</strong> : nom, adresse e-mail, téléphone, adresse de
                livraison le cas échéant, contenu de la commande et instructions. Finalité :
                préparer, livrer et suivre la commande, et vous en informer. Base légale :
                l&apos;exécution du contrat (art. 6.1.b du RGPD).
              </li>
              <li>
                <strong>Votre réservation de table</strong> : nom, adresse e-mail, téléphone, nombre
                de convives et, si vous l&apos;écrivez, une demande particulière (allergie, chaise
                haute). Finalité : gérer la réservation, la confirmer, vous prévenir d&apos;un
                changement et vous joindre si besoin. Le restaurant tient aussi une fiche par client
                (venues, absences, notes de l&apos;équipe) pour mieux vous accueillir. Si la journée
                est complète, vous pouvez demander à être prévenu quand une table se libère : vos
                coordonnées servent alors à vous écrire une fois si une table convient. Base légale
                : l&apos;exécution du contrat (art. 6.1.b du RGPD) ; pour la fiche client,
                l&apos;intérêt légitime de l&apos;établissement à connaître sa clientèle (art.
                6.1.f), auquel vous pouvez vous opposer.
              </li>
              <li>
                <strong>Votre compte client</strong>, si vous en créez un : identifiants, adresses
                enregistrées, historique et favoris. Base légale : l&apos;exécution du contrat.
              </li>
              <li>
                <strong>Le paiement</strong> : il est réalisé auprès du prestataire de paiement ;
                l&apos;établissement ne reçoit pas vos coordonnées bancaires. Les factures sont
                émises et conservées pour respecter les obligations comptables et fiscales. Base
                légale : l&apos;obligation légale (art. 6.1.c du RGPD).
              </li>
              <li>
                <strong>Le paiement d&apos;une réservation</strong>. Lorsqu&apos;un acompte ou une
                garantie est demandé pour une réservation, il est réglé auprès du prestataire de
                paiement que l&apos;établissement a choisi, et la page de paiement du site ne
                conserve aucun numéro de carte. L&apos;établissement garde le montant, les dates et
                l&apos;état du paiement (payé, remboursé, frais d&apos;absence débités), rattachés à
                votre réservation. Ces éléments restent dans sa comptabilité même si la réservation
                est effacée. Une carte enregistrée en garantie est libérée après votre venue ou si
                la réservation est annulée. Base légale : l&apos;exécution du contrat (art. 6.1.b du
                RGPD) et, pour la comptabilité, l&apos;obligation légale (art. 6.1.c).
              </li>
              <li>
                <strong>La lettre d&apos;information</strong>, si vous vous y inscrivez : votre
                adresse e-mail, confirmée par un lien. Base légale : votre consentement (art. 6.1.a
                du RGPD), que vous pouvez retirer à tout moment par le lien de désinscription.
              </li>
              <li>
                <strong>Les jeux</strong>, si vous y participez : les données demandées pour
                remettre un lot, avec votre accord enregistré au moment de jouer. Base légale :
                votre consentement.
              </li>
              <li>
                <strong>La mesure d&apos;audience</strong> : le nombre de visites et de pages vues,
                compté sans cookie, sans adresse IP et sans identifiant vous concernant. Base légale
                : l&apos;intérêt légitime de l&apos;établissement à connaître la fréquentation de
                son site.
              </li>
            </ul>
          </LegalSection>

          <LegalSection title="Durées de conservation">
            <p>
              Vos données de client sont conservées{' '}
              <strong>{formatRetention(info.retention.customerDataDays)}</strong> à compter de votre
              dernier contact avec l&apos;établissement
              {info.retention.automaticDeletion ? ', puis supprimées automatiquement' : ''}.
            </p>
            <p>
              Une réservation de table, la fiche client et la demande d&apos;être prévenu sont
              conservées <strong>{formatRetention(info.retention.reservationDays)}</strong> après le
              repas, puis supprimées. Votre demande particulière (allergie, chaise haute) est
              effacée {formatRetention(info.retention.reservationNoteDays)} après le repas, et
              n&apos;est jamais recopiée dans la fiche client. Une demande d&apos;être prévenu est
              supprimée une semaine après la date souhaitée.
            </p>
            <p>
              Lorsque l&apos;établissement a activé l&apos;e-mail de remerciement, vous recevez un
              seul message après un repas, avec une note de 1 à 5 et un champ libre. Votre réponse
              n&apos;est lue que par l&apos;équipe de l&apos;établissement : elle n&apos;est jamais
              publiée sur ce site et reste liée à votre réservation, pour la même durée. Vous pouvez
              la modifier pendant 24 heures.
            </p>
            <p>
              Une commande payée n&apos;est pas supprimée mais anonymisée : son contenu et son
              montant restent dans la comptabilité, sans votre nom ni vos coordonnées. Les factures
              sont conservées, avec le nom et l&apos;adresse de l&apos;acheteur, pendant la durée
              imposée par le droit comptable et fiscal (dix ans, article L123-22 du Code de
              commerce).
            </p>
            <p>
              Les statistiques d&apos;audience, qui ne vous identifient pas, sont conservées{' '}
              {formatRetention(info.retention.audienceDays)}.
            </p>
          </LegalSection>

          <LegalSection title="Destinataires et prestataires">
            <p>
              Vos données sont destinées à l&apos;établissement. Elles sont transmises, pour ce qui
              est nécessaire à chacun, aux prestataires suivants :
            </p>
            <ul className="list-disc space-y-1 pl-5">
              {info.processors.map((processor) => (
                <li key={processor.key}>
                  <strong>{processor.name}</strong> — {processor.purpose}
                </li>
              ))}
            </ul>
            <p>
              Certains de ces prestataires peuvent traiter des données en dehors de l&apos;Union
              européenne. Ces transferts doivent être encadrés par les garanties prévues aux
              articles 44 et suivants du RGPD.
            </p>
          </LegalSection>

          <LegalSection title="Vos droits">
            <p>
              Vous disposez d&apos;un droit d&apos;accès, de rectification, d&apos;effacement, de
              limitation et de portabilité de vos données, d&apos;un droit d&apos;opposition, du
              droit de retirer votre consentement à tout moment, et du droit de définir des
              directives relatives au sort de vos données après votre décès.
            </p>
            <p>
              Pour les exercer, écrivez à l&apos;établissement :{' '}
              <LegalValue value={info.site.contactEmail} />. Il vous répond dans un délai d&apos;un
              mois. En cas d&apos;effacement, les commandes payées sont anonymisées et les factures
              conservées comme indiqué ci-dessus ; la réponse vous précise ce qui a été conservé et
              pourquoi.
            </p>
            <p>Vous pouvez également introduire une réclamation auprès de la CNIL (www.cnil.fr).</p>
          </LegalSection>

          <LegalSection title="Cookies et stockage local">
            <p>
              Le site utilise des cookies et un stockage local nécessaires à son fonctionnement :
              votre panier, la langue choisie, l&apos;établissement sélectionné et la connexion à
              votre compte. La mesure d&apos;audience ne dépose aucun cookie. Les services tiers
              utilisés au moment du paiement ou de la saisie d&apos;une adresse peuvent déposer
              leurs propres cookies, nécessaires à leur fonctionnement.
            </p>
          </LegalSection>
        </>
      )}

      {additional ? (
        <LegalSection title="Informations complémentaires">
          <LegalClause html={additional} />
        </LegalSection>
      ) : null}
    </LegalPage>
  )
}
