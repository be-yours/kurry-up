import type { PageDefinition } from '@be-yours/cms'
import { seoBlock } from '@be-yours/cms'

/**
 * Mentions légales (LCEN art. 6-III).
 *
 * The identity itself is NOT editable here: it comes from Paramètres →
 * Facturation and Paramètres → Mentions légales through `legalPages.getPublic`,
 * so the notice and the invoices cannot name two different businesses. What an
 * owner may add is what varies from one site to the next.
 */
export const legalNoticePage: PageDefinition = {
  slug: 'legal-notice',
  label: 'Mentions légales',
  description:
    "L'identité vient de Paramètres → Facturation et Mentions légales. Ici, vos compléments. Textes types à faire valider par votre conseil juridique.",
  route: '/mentions-legales',
  groupId: 'legal',
  /** Read by the storefront — see `PageDefinition.rendered`. */
  rendered: true,

  blocks: [
    seoBlock,
    {
      key: 'content',
      label: 'Contenu',
      fields: {
        intellectualProperty: {
          type: 'richtext',
          label: 'Propriété intellectuelle et crédits',
          description:
            "Remplace le texte type. Citez ici les auteurs de vos photos s'ils doivent l'être.",
          maxLength: 3000,
          hasCodeFallback: true,
        },
        additional: {
          type: 'richtext',
          label: 'Informations complémentaires',
          description: "Facultatif : affiché en fin de page s'il est renseigné.",
          maxLength: 5000,
          hasCodeFallback: false,
        },
      },
    },
  ],
}
