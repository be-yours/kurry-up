import type { PageDefinition } from "@be-yours/cms"
import { seoBlock } from "@be-yours/cms"

export const productDetailPage: PageDefinition = {
  slug: "product-detail",
  label: "Détail produit",
  groupId: "catalog",
  /**
   * Its `seo` block is read (#630) — `product/[productId]/page.tsx` passes the
   * page to `buildSeoMetadata`, which is how « Noindex, nofollow » and the meta
   * title reach a crawler. Its OTHER blocks still have no reader; `rendered` is
   * per page, and a per-block marker is the next refinement.
   */
  rendered: true,

  blocks: [
    seoBlock,
    {
      key: "header",
      label: "En-tête",
      fields: {
        title: {
          type: "text",
          label: "Titre générique",
          maxLength: 100,
          hasCodeFallback: true,
        },
      },
    },
    {
      key: "sections",
      label: "Sections",
      fields: {
        descriptionTitle: {
          type: "text",
          label: "Titre section description",
          maxLength: 100,
          hasCodeFallback: true,
        },
        optionsTitle: {
          type: "text",
          label: "Titre section options",
          maxLength: 100,
          hasCodeFallback: true,
        },
        similarTitle: {
          type: "text",
          label: "Titre produits similaires",
          maxLength: 100,
          hasCodeFallback: true,
        },
      },
    },
    {
      key: "actions",
      label: "Actions",
      fields: {
        addToCartLabel: {
          type: "text",
          label: "Texte ajouter au panier",
          maxLength: 50,
          hasCodeFallback: true,
        },
        outOfStockLabel: {
          type: "text",
          label: "Texte rupture de stock",
          maxLength: 50,
          hasCodeFallback: true,
        },
      },
    },
  ],
}
