import type { PageDefinition } from "@be-yours/cms"

export const orderTrackingPage: PageDefinition = {
  slug: "order-tracking",
  label: "Suivi de commande",
  groupId: "order",
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
      key: "statuses",
      label: "Labels de statut",
      fields: {
        pendingLabel: {
          type: "text",
          label: "En attente",
          maxLength: 50,
          hasCodeFallback: true,
        },
        preparingLabel: {
          type: "text",
          label: "En préparation",
          maxLength: 50,
          hasCodeFallback: true,
        },
        readyLabel: {
          type: "text",
          label: "Prête",
          maxLength: 50,
          hasCodeFallback: true,
        },
        deliveredLabel: {
          type: "text",
          label: "Livrée",
          maxLength: 50,
          hasCodeFallback: true,
        },
      },
    },
  ],
}
