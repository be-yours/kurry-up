import type { PageDefinition } from "@be-yours/cms"
import { seoBlock } from "@be-yours/cms"

export const homepagePage: PageDefinition = {
  slug: "homepage",
  label: "Page d'accueil",
  route: "/",
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
          required: true,
          maxLength: 120,
          hasCodeFallback: true,
        },
        subtitle: {
          type: "text",
          label: "Sous-titre",
          maxLength: 300,
          hasCodeFallback: true,
        },
        image: {
          type: "image",
          label: "Image hero",
          translatable: false,
          hasCodeFallback: true,
        },
        ctaLabel: {
          type: "text",
          label: "Texte bouton CTA",
          maxLength: 50,
          hasCodeFallback: true,
        },
        floatingBadge1Title: {
          type: "text",
          label: "Badge flottant 1 — titre",
          maxLength: 50,
          hasCodeFallback: true,
        },
        floatingBadge1Subtitle: {
          type: "text",
          label: "Badge flottant 1 — sous-titre",
          maxLength: 50,
          hasCodeFallback: true,
        },
        floatingBadge2Title: {
          type: "text",
          label: "Badge flottant 2 — titre",
          maxLength: 50,
          hasCodeFallback: true,
        },
        floatingBadge2Subtitle: {
          type: "text",
          label: "Badge flottant 2 — sous-titre",
          maxLength: 50,
          hasCodeFallback: true,
        },
      },
    },
    {
      key: "features",
      label: "Section avantages",
      fields: {
        feature1Image: {
          type: "image",
          label: "Icône",
          translatable: false,
          hasCodeFallback: true,
          group: "Avantage 1",
        },
        feature1Label: {
          type: "text",
          label: "Texte",
          maxLength: 60,
          hasCodeFallback: true,
          group: "Avantage 1",
        },
        feature2Image: {
          type: "image",
          label: "Icône",
          translatable: false,
          hasCodeFallback: true,
          group: "Avantage 2",
        },
        feature2Label: {
          type: "text",
          label: "Texte",
          maxLength: 60,
          hasCodeFallback: true,
          group: "Avantage 2",
        },
        feature3Image: {
          type: "image",
          label: "Icône",
          translatable: false,
          hasCodeFallback: true,
          group: "Avantage 3",
        },
        feature3Label: {
          type: "text",
          label: "Texte",
          maxLength: 60,
          hasCodeFallback: true,
          group: "Avantage 3",
        },
        feature4Image: {
          type: "image",
          label: "Icône",
          translatable: false,
          hasCodeFallback: true,
          group: "Avantage 4",
        },
        feature4Label: {
          type: "text",
          label: "Texte",
          maxLength: 60,
          hasCodeFallback: true,
          group: "Avantage 4",
        },
        feature5Image: {
          type: "image",
          label: "Icône",
          translatable: false,
          hasCodeFallback: true,
          group: "Avantage 5",
        },
        feature5Label: {
          type: "text",
          label: "Texte",
          maxLength: 60,
          hasCodeFallback: true,
          group: "Avantage 5",
        },
      },
    },
    {
      key: "trendingMeals",
      label: "Section plats tendance",
      fields: {
        sectionTitle: {
          type: "text",
          label: "Titre de section",
          maxLength: 120,
          hasCodeFallback: true,
        },
        viewAllLabel: {
          type: "text",
          label: "Texte lien tout voir",
          maxLength: 50,
          hasCodeFallback: true,
        },
      },
    },
    {
      key: "categories",
      label: "Section catégories",
      fields: {
        badge: {
          type: "text",
          label: "Badge section",
          maxLength: 50,
          hasCodeFallback: true,
        },
        sectionTitle: {
          type: "text",
          label: "Titre de section",
          maxLength: 120,
          hasCodeFallback: true,
        },
        description: {
          type: "text",
          label: "Description",
          maxLength: 300,
          hasCodeFallback: true,
        },
      },
    },
    {
      key: "cta",
      label: "Section appel à l'action",
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
        backgroundImage: {
          type: "image",
          label: "Image de fond",
          translatable: false,
          hasCodeFallback: true,
        },
      },
    },
    {
      key: "blog",
      label: "Section blog",
      fields: {
        sectionTitle: {
          type: "text",
          label: "Titre de section",
          maxLength: 120,
          hasCodeFallback: true,
        },
        viewAllLabel: {
          type: "text",
          label: "Texte lien tout voir",
          maxLength: 50,
          hasCodeFallback: true,
        },
      },
    },
  ],
}
