import type { PageDefinition } from "@be-yours/cms"
import { seoBlock } from "@be-yours/cms"

export const contactPage: PageDefinition = {
  slug: "contact",
  label: "Contact",
  groupId: "storefront",
  /** Read by the storefront — see `PageDefinition.rendered`. */
  rendered: true,

  blocks: [
    seoBlock,
    {
      key: "hero",
      label: "Section hero",
      fields: {
        badge: {
          type: "text",
          label: "Badge en-tête",
          maxLength: 50,
          hasCodeFallback: true,
        },
        title: {
          type: "text",
          label: "Titre principal",
          maxLength: 120,
          hasCodeFallback: true,
        },
        subtitle: {
          type: "text",
          label: "Sous-titre",
          maxLength: 300,
          hasCodeFallback: true,
        },
      },
    },
    {
      key: "form",
      label: "Formulaire",
      fields: {
        heading: {
          type: "text",
          label: "Titre du formulaire",
          maxLength: 120,
          hasCodeFallback: true,
        },
        description: {
          type: "text",
          label: "Description",
          maxLength: 300,
          hasCodeFallback: true,
        },
        submitLabel: {
          type: "text",
          label: "Texte du bouton",
          maxLength: 50,
          hasCodeFallback: true,
        },
      },
    },
    {
      key: "info",
      label: "Informations de contact",
      fields: {
        addressTitle: {
          type: "text",
          label: "Titre adresse",
          maxLength: 50,
          hasCodeFallback: true,
        },
        hoursTitle: {
          type: "text",
          label: "Titre horaires",
          maxLength: 50,
          hasCodeFallback: true,
        },
        contactTitle: {
          type: "text",
          label: "Titre contact",
          maxLength: 50,
          hasCodeFallback: true,
        },
      },
    },
    {
      key: "responseTime",
      label: "Engagement de réponse",
      description:
        "Carte affichée sous les coordonnées. Elle n'apparaît que si vous la remplissez : ne promettez un délai que si vous le tenez.",
      fields: {
        /* NO CODE FALLBACK, ON PURPOSE. This card was typed into the page —
           « Réponse rapide · Nous répondons sous 24h en moyenne » — and
           printed on every site, a commitment no establishment had made and
           nothing could take down. A response time is a figure about the
           establishment, which is the establishment's to state. */
        title: {
          type: "text",
          label: "Titre",
          maxLength: 60,
          hasCodeFallback: false,
        },
        text: {
          type: "text",
          label: "Texte",
          maxLength: 120,
          hasCodeFallback: false,
        },
      },
    },
  ],
}
