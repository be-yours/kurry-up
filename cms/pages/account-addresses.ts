import type { PageDefinition } from "@be-yours/cms"

export const accountAddressesPage: PageDefinition = {
  slug: "account-addresses",
  label: "Adresses sauvegardées",
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
      key: "emptyState",
      label: "Aucune adresse",
      fields: {
        title: {
          type: "text",
          label: "Titre aucune adresse",
          maxLength: 100,
          hasCodeFallback: true,
        },
        subtitle: {
          type: "text",
          label: "Description aucune adresse",
          maxLength: 200,
          hasCodeFallback: true,
        },
      },
    },
  ],
}
