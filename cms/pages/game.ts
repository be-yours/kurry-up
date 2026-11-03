import type { PageDefinition } from "@be-yours/cms"

export const gamePage: PageDefinition = {
  slug: "game",
  label: "Jeu / Gamification",
  groupId: "games",
  /** Read by the storefront — see `PageDefinition.rendered`. */
  rendered: true,

  blocks: [
    {
      key: "hero",
      label: "Section hero",
      fields: {
        title: {
          type: "text",
          label: "Titre",
          required: true,
          maxLength: 100,
          hasCodeFallback: true,
        },
        subtitle: {
          type: "text",
          label: "Sous-titre",
          maxLength: 200,
          hasCodeFallback: true,
        },
        image: {
          type: "image",
          label: "Image de fond",
          translatable: false,
          hasCodeFallback: true,
        },
      },
    },
    {
      key: "instructions",
      label: "Instructions du jeu",
      fields: {
        title: {
          type: "text",
          label: "Titre des instructions",
          maxLength: 100,
          hasCodeFallback: true,
        },
        description: {
          type: "richtext",
          label: "Description des instructions",
          maxLength: 500,
          hasCodeFallback: true,
        },
      },
    },
    {
      key: "results",
      label: "Résultats",
      fields: {
        winTitle: {
          type: "text",
          label: "Titre en cas de gain",
          maxLength: 100,
          hasCodeFallback: true,
        },
        winDescription: {
          type: "text",
          label: "Description en cas de gain",
          maxLength: 200,
          hasCodeFallback: true,
        },
        loseTitle: {
          type: "text",
          label: "Titre en cas de perte",
          maxLength: 100,
          hasCodeFallback: true,
        },
        loseDescription: {
          type: "text",
          label: "Description en cas de perte",
          maxLength: 200,
          hasCodeFallback: true,
        },
      },
    },
  ],
}
