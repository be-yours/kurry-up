import type { PageDefinition } from '@be-yours/cms'
import { seoBlock } from '@be-yours/cms'

/**
 * Politique de confidentialité (RGPD art. 13).
 *
 * The controller, the retention windows, the rights and the processors are
 * rendered from `legalPages.getPublic` — what the engine actually enforces in
 * `privacy.ts` — so the policy cannot promise a window the sweep does not keep.
 * The owner adds what only they know.
 */
export const privacyPolicyPage: PageDefinition = {
  slug: 'privacy-policy',
  label: 'Politique de confidentialité',
  description:
    'Durées, droits et prestataires viennent de vos réglages. Ici, vos compléments. Textes types à faire valider par votre conseil juridique.',
  route: '/confidentialite',
  groupId: 'legal',
  /** Read by the storefront — see `PageDefinition.rendered`. */
  rendered: true,

  blocks: [
    seoBlock,
    {
      key: 'content',
      label: 'Contenu',
      fields: {
        additional: {
          type: 'richtext',
          label: 'Informations complémentaires',
          description:
            'Facultatif : tout autre traitement propre à votre établissement (jeux concours, vidéosurveillance…).',
          maxLength: 5000,
          hasCodeFallback: false,
        },
      },
    },
  ],
}
