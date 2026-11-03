import type { PageDefinition } from "@be-yours/cms"

export const checkoutPage: PageDefinition = {
  slug: "checkout",
  label: "Commande",
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
      key: "sections",
      label: "Sections",
      fields: {
        orderSummaryTitle: {
          type: "text",
          label: "Titre résumé commande",
          maxLength: 100,
          hasCodeFallback: true,
        },
        paymentTitle: {
          type: "text",
          label: "Titre section paiement",
          maxLength: 100,
          hasCodeFallback: true,
        },
        deliveryTitle: {
          type: "text",
          label: "Titre section livraison",
          maxLength: 100,
          hasCodeFallback: true,
        },
      },
    },
    {
      key: "actions",
      label: "Actions",
      fields: {
        submitLabel: {
          type: "text",
          label: "Texte bouton confirmer",
          maxLength: 50,
          hasCodeFallback: true,
        },
        backLabel: {
          type: "text",
          label: "Texte bouton retour",
          maxLength: 50,
          hasCodeFallback: true,
        },
      },
    },
  ],
}
