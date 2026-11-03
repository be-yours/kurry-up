import type { PageDefinition } from "@be-yours/cms"
import { seoBlock } from "@be-yours/cms"

export const aboutPage: PageDefinition = {
  slug: "about",
  label: "À propos",
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
      key: "story",
      label: "Notre histoire",
      fields: {
        badge: {
          type: "text",
          label: "Badge section",
          maxLength: 50,
          hasCodeFallback: true,
        },
        title: {
          type: "text",
          label: "Titre",
          maxLength: 120,
          hasCodeFallback: true,
        },
        description: {
          type: "richtext",
          label: "Description",
          maxLength: 1000,
          hasCodeFallback: true,
        },
        image: {
          type: "image",
          label: "Image",
          translatable: false,
          hasCodeFallback: true,
        },
      },
    },
    {
      key: "values",
      label: "Nos valeurs",
      fields: {
        badge: {
          type: "text",
          label: "Badge section",
          maxLength: 50,
          hasCodeFallback: true,
        },
        title: {
          type: "text",
          label: "Titre",
          maxLength: 120,
          hasCodeFallback: true,
        },
        value1Image: {
          type: "image",
          label: "Icône",
          translatable: false,
          hasCodeFallback: true,
          group: "Valeur 1",
        },
        value1Title: {
          type: "text",
          label: "Titre",
          maxLength: 60,
          hasCodeFallback: true,
          group: "Valeur 1",
        },
        value1Description: {
          type: "text",
          label: "Description",
          maxLength: 200,
          hasCodeFallback: true,
          group: "Valeur 1",
        },
        value2Image: {
          type: "image",
          label: "Icône",
          translatable: false,
          hasCodeFallback: true,
          group: "Valeur 2",
        },
        value2Title: {
          type: "text",
          label: "Titre",
          maxLength: 60,
          hasCodeFallback: true,
          group: "Valeur 2",
        },
        value2Description: {
          type: "text",
          label: "Description",
          maxLength: 200,
          hasCodeFallback: true,
          group: "Valeur 2",
        },
        value3Image: {
          type: "image",
          label: "Icône",
          translatable: false,
          hasCodeFallback: true,
          group: "Valeur 3",
        },
        value3Title: {
          type: "text",
          label: "Titre",
          maxLength: 60,
          hasCodeFallback: true,
          group: "Valeur 3",
        },
        value3Description: {
          type: "text",
          label: "Description",
          maxLength: 200,
          hasCodeFallback: true,
          group: "Valeur 3",
        },
      },
    },
    {
      key: "stats",
      label: "Chiffres clés",
      fields: {
        stat1Value: {
          type: "text",
          label: "Valeur",
          maxLength: 20,
          hasCodeFallback: true,
          group: "Statistique 1",
        },
        stat1Label: {
          type: "text",
          label: "Libellé",
          maxLength: 50,
          hasCodeFallback: true,
          group: "Statistique 1",
        },
        stat2Value: {
          type: "text",
          label: "Valeur",
          maxLength: 20,
          hasCodeFallback: true,
          group: "Statistique 2",
        },
        stat2Label: {
          type: "text",
          label: "Libellé",
          maxLength: 50,
          hasCodeFallback: true,
          group: "Statistique 2",
        },
        stat3Value: {
          type: "text",
          label: "Valeur",
          maxLength: 20,
          hasCodeFallback: true,
          group: "Statistique 3",
        },
        stat3Label: {
          type: "text",
          label: "Libellé",
          maxLength: 50,
          hasCodeFallback: true,
          group: "Statistique 3",
        },
        stat4Value: {
          type: "text",
          label: "Valeur",
          maxLength: 20,
          hasCodeFallback: true,
          group: "Statistique 4",
        },
        stat4Label: {
          type: "text",
          label: "Libellé",
          maxLength: 50,
          hasCodeFallback: true,
          group: "Statistique 4",
        },
      },
    },
    {
      key: "cta",
      label: "Appel à l'action",
      fields: {
        title: {
          type: "text",
          label: "Titre",
          maxLength: 120,
          hasCodeFallback: true,
        },
        subtitle: {
          type: "text",
          label: "Sous-titre",
          maxLength: 300,
          hasCodeFallback: true,
        },
        buttonText: {
          type: "text",
          label: "Texte bouton",
          maxLength: 50,
          hasCodeFallback: true,
        },
      },
    },
  ],
}
