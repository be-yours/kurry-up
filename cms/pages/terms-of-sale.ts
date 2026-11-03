import type { PageDefinition } from '@be-yours/cms'
import { seoBlock } from '@be-yours/cms'

/**
 * Conditions générales de vente for online orders.
 *
 * The page states the facts the engine knows — prices including VAT, the
 * payment methods switched on, the delivery radius and fees entered in
 * Paramètres, the withdrawal-right exclusion for perishable food
 * (art. L221-28 Code de la consommation) — and leaves the clauses that differ
 * from one restaurant to the next to the owner, each with a neutral code
 * fallback that promises nothing on the establishment's behalf.
 */
export const termsOfSalePage: PageDefinition = {
  slug: 'terms-of-sale',
  label: 'Conditions générales de vente',
  description:
    "Vos clauses de commande, de livraison et d'annulation. Textes types à faire valider par votre conseil juridique.",
  route: '/cgv',
  groupId: 'legal',
  /** Read by the storefront — see `PageDefinition.rendered`. */
  rendered: true,

  blocks: [
    seoBlock,
    {
      key: 'clauses',
      label: 'Clauses propres à votre établissement',
      fields: {
        ordering: {
          type: 'richtext',
          label: 'Commande et préparation',
          description: "Remplace le texte type de l'article « Commande ».",
          maxLength: 3000,
          hasCodeFallback: true,
        },
        delivery: {
          type: 'richtext',
          label: 'Livraison et retrait',
          description:
            'Complète le rayon et les frais saisis dans Paramètres → Livraison : délais, zones exclues, conditions de remise…',
          maxLength: 3000,
          hasCodeFallback: true,
        },
        cancellation: {
          type: 'richtext',
          label: 'Annulation, réclamations et remboursements',
          description: "Votre politique d'annulation et la façon de vous adresser une réclamation.",
          maxLength: 3000,
          hasCodeFallback: true,
        },
        additional: {
          type: 'richtext',
          label: 'Conditions particulières',
          description: "Facultatif : affiché en fin de page s'il est renseigné.",
          maxLength: 5000,
          hasCodeFallback: false,
        },
      },
    },
  ],
}
