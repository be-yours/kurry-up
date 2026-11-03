import type { PageDefinition } from "@be-yours/cms"

export const accountPage: PageDefinition = {
  slug: "account",
  label: "Mon compte",
  groupId: "account",
  /** NOT read by anything (#630) — see `PageDefinition.rendered`. */
  rendered: false,

  blocks: [
    {
      key: "header",
      label: "En-tête",
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
      },
    },
    {
      key: "navigation",
      label: "Navigation du compte",
      fields: {
        ordersLabel: {
          type: "text",
          label: "Lien historique commandes",
          maxLength: 50,
          hasCodeFallback: true,
        },
        addressesLabel: {
          type: "text",
          label: "Lien adresses",
          maxLength: 50,
          hasCodeFallback: true,
        },
        favoritesLabel: {
          type: "text",
          label: "Lien favoris",
          maxLength: 50,
          hasCodeFallback: true,
        },
        logoutLabel: {
          type: "text",
          label: "Texte déconnexion",
          maxLength: 50,
          hasCodeFallback: true,
        },
      },
    },
  ],
}
