'use client'

import Link from 'next/link'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { formatPrice } from '@be-yours/restaurant'
import { useCmsPage } from '@/lib/cms/useCmsPage'
import {
  LegalClause,
  LegalLoading,
  LegalPage,
  LegalSection,
  MediatorLine,
  SellerIdentity,
} from './legal-parts'

/*
 * Code fallbacks of the owner-editable clauses. Deliberately neutral: they
 * describe how the engine's order path behaves and promise nothing on the
 * establishment's behalf — no delay, no refund, no cancellation window. Those
 * are the owner's to state, in the CMS.
 */
const DEFAULT_ORDERING =
  "<p>Vous choisissez vos produits sur le site, puis le mode de retrait ou de livraison. Avant de valider, un récapitulatif vous présente le détail de la commande et son prix total. La validation de la commande vaut acceptation des présentes conditions et obligation de paiement. La commande est ensuite transmise à l'établissement, qui la prépare.</p>"
const DEFAULT_DELIVERY =
  "<p>Le mode de remise (livraison, retrait ou sur place) est choisi au moment de la commande, parmi ceux que l'établissement propose. L'heure de retrait ou de livraison indiquée est une estimation.</p>"
const DEFAULT_CANCELLATION =
  "<p>Les plats étant préparés dès la réception de la commande, contactez l'établissement au plus vite pour toute demande concernant une commande en cours, aux coordonnées indiquées ci-dessus. Toute réclamation peut lui être adressée par e-mail ou par téléphone.</p>"

/**
 * Conditions générales de vente for online orders: the pre-contractual
 * information art. L221-5 Code de la consommation lists, prices including VAT,
 * the payment methods actually switched on, delivery terms as entered in
 * Paramètres, and the withdrawal-right exclusion for perishable food.
 */
export function TermsOfSaleContent() {
  const info = useQuery(api.legalPages.getPublic)
  const settings = useQuery(api.globalSettings.get)
  const { block } = useCmsPage('terms-of-sale')
  const clauses = block('clauses')
  const ordering = clauses.field('ordering').text ?? DEFAULT_ORDERING
  const delivery = clauses.field('delivery').text ?? DEFAULT_DELIVERY
  const cancellation = clauses.field('cancellation').text ?? DEFAULT_CANCELLATION
  const additional = clauses.field('additional').text

  const payments = settings?.payments
  const paymentMethods = [
    payments && payments.cardProvider !== 'none' ? 'carte bancaire' : null,
    payments?.paypal ? 'PayPal' : null,
    payments?.cash ? 'espèces, pour les commandes retirées ou servies sur place' : null,
  ].filter((method): method is string => Boolean(method))

  const fees = settings?.delivery
  const minimumOrder = settings?.minimumOrderAmount

  return (
    <LegalPage
      title="Conditions générales de vente"
      intro="Les présentes conditions s'appliquent aux commandes passées sur ce site auprès de l'établissement identifié ci-dessous."
    >
      {info === undefined ? (
        <LegalLoading />
      ) : (
        <LegalSection title="1. Vendeur">
          <SellerIdentity info={info} />
        </LegalSection>
      )}

      <LegalSection title="2. Produits">
        <p>
          Les caractéristiques essentielles des produits (composition, options, allergènes
          lorsqu&apos;ils sont renseignés) sont présentées sur leur fiche. Pour toute question sur
          les allergènes, contactez l&apos;établissement avant de commander.
        </p>
      </LegalSection>

      <LegalSection title="3. Prix">
        <p>
          Les prix sont indiqués en euros, toutes taxes comprises (TVA incluse). Le prix total,
          frais de livraison éventuels compris, est affiché avant la validation de la commande.
        </p>
        {minimumOrder ? <p>Montant minimum de commande : {formatPrice(minimumOrder)}.</p> : null}
      </LegalSection>

      <LegalSection title="4. Commande">
        <LegalClause html={ordering} />
      </LegalSection>

      <LegalSection title="5. Paiement">
        {settings === undefined ? (
          <LegalLoading />
        ) : paymentMethods.length > 0 ? (
          <p>
            Moyens de paiement acceptés : {paymentMethods.join(', ')}. Les paiements en ligne sont
            traités par des prestataires de paiement sécurisés ; l&apos;établissement n&apos;a pas
            accès à vos coordonnées bancaires.
          </p>
        ) : (
          <p>Les moyens de paiement acceptés sont indiqués lors de la commande.</p>
        )}
      </LegalSection>

      <LegalSection title="6. Livraison et retrait">
        {info?.delivers ? (
          <>
            <p>
              La livraison est proposée
              {fees?.radius
                ? ` dans un rayon de ${fees.radius} km autour de l'établissement`
                : ''}.{' '}
              {fees?.feeMode === 'percentage'
                ? 'Les frais de livraison dépendent de la distance et sont indiqués avant la validation de la commande.'
                : fees?.fee != null
                  ? `Frais de livraison : ${formatPrice(fees.fee)}${
                      fees.freeAbove
                        ? `, offerts dès ${formatPrice(fees.freeAbove)} de commande`
                        : ''
                    }.`
                  : 'Les frais de livraison éventuels sont indiqués avant la validation de la commande.'}
            </p>
          </>
        ) : null}
        <LegalClause html={delivery} />
      </LegalSection>

      <LegalSection title="7. Droit de rétractation">
        <p>
          Conformément à l&apos;article L221-28 du Code de la consommation, le droit de rétractation
          ne peut pas être exercé pour la fourniture de biens susceptibles de se détériorer ou de se
          périmer rapidement (4°), ni pour les prestations de restauration fournies à une date ou à
          une période déterminée (12°). Les commandes passées sur ce site, qui portent sur des repas
          préparés, n&apos;ouvrent donc pas droit à rétractation.
        </p>
      </LegalSection>

      <LegalSection title="8. Annulation et réclamations">
        <LegalClause html={cancellation} />
      </LegalSection>

      <LegalSection title="9. Médiation">
        <p>
          En cas de litige, vous pouvez recourir gratuitement au médiateur de la consommation dont
          relève l&apos;établissement, après avoir tenté de résoudre le différend directement avec
          lui.
        </p>
        {info === undefined ? <LegalLoading /> : <MediatorLine info={info} />}
      </LegalSection>

      <LegalSection title="10. Données personnelles">
        <p>
          Les données nécessaires à votre commande sont traitées comme décrit dans notre{' '}
          <Link href="/confidentialite" className="underline underline-offset-4">
            politique de confidentialité
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection title="11. Droit applicable">
        <p>Les présentes conditions sont soumises au droit français.</p>
      </LegalSection>

      {additional ? (
        <LegalSection title="12. Conditions particulières">
          <LegalClause html={additional} />
        </LegalSection>
      ) : null}
    </LegalPage>
  )
}
