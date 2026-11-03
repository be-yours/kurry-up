import type { BlockDefinition, FieldDefinition, PageDefinition } from "@be-yours/cms"
import { seoBlock } from "@be-yours/cms"

/**
 * How many links of their own an owner can give each footer column.
 *
 * The CMS has no list field, so a list is a run of numbered fields — the same
 * shape the homepage's five advantages use. Six fills a column without letting
 * it outgrow the newsletter beside it. `lib/footer-links.ts` reads these slots
 * and `tests/storefront/footer-cms-fields.test.ts` fails when the two disagree.
 */
export const FOOTER_LINK_SLOTS = 6

/** `link1Label`, `link1Url` … `link6Url`, each pair a card of its own in the editor. */
function footerLinkFields(): Record<string, FieldDefinition> {
  const fields: Record<string, FieldDefinition> = {}
  for (let n = 1; n <= FOOTER_LINK_SLOTS; n++) {
    fields[`link${n}Label`] = {
      type: "text",
      label: "Texte",
      maxLength: 40,
      // No sample link: an empty slot is an absent link, never a placeholder.
      hasCodeFallback: false,
      group: `Lien ${n}`,
    }
    fields[`link${n}Url`] = {
      type: "text",
      label: "Adresse",
      placeholder: "/evenements ou https://…",
      maxLength: 300,
      translatable: false,
      hasCodeFallback: false,
      group: `Lien ${n}`,
    }
  }
  return fields
}

/**
 * One footer link column.
 *
 * The footer used to carry a fixed set of links — « Box », « Mes commandes »,
 * « Nos restaurants » — that no site could change, so a restaurant with one
 * location and a page of its own (`/evenements`) had a column of links it did
 * not want and no way to add the one it did. A column now shows the engine's
 * links until the owner gives it a link of their own, and can be hidden.
 */
function footerColumnBlock(key: string, label: string): BlockDefinition {
  return {
    key,
    label,
    description:
      "Si vous renseignez au moins un lien, il remplace les liens proposés par défaut dans cette colonne. L'adresse commence par / pour une page du site (par exemple /evenements) ou par https:// pour un autre site.",
    fields: {
      display: {
        type: "select",
        label: "Affichage de la colonne",
        options: [
          { value: "show", label: "Afficher la colonne" },
          { value: "hide", label: "Masquer la colonne" },
        ],
        translatable: false,
        hasCodeFallback: true,
      },
      title: {
        type: "text",
        label: "Titre de la colonne",
        maxLength: 40,
        hasCodeFallback: true,
      },
      ...footerLinkFields(),
    },
  }
}

export const storefrontLayoutPage: PageDefinition = {
  slug: "storefront-layout",
  label: "Layout du storefront",
  description: "En-tête et pied de page communs à toutes les pages du storefront",
  groupId: "storefront",
  /** Read by the storefront — see `PageDefinition.rendered`. */
  rendered: true,

  blocks: [
    seoBlock,
    {
      key: "branding",
      label: "Identité visuelle",
      fields: {
        logo: {
          type: "image",
          label: "Logo du restaurant",
          description: "Utilisé dans l'en-tête du storefront et le tableau de bord admin. Recommandé : PNG/SVG transparent, 200x60px minimum.",
          hasCodeFallback: true,
        },
        favicon: {
          type: "image",
          label: "Favicon",
          description: "Icône du navigateur. Recommandé : PNG carré 32x32px ou 64x64px.",
          hasCodeFallback: true,
        },
        brandName: {
          type: "text",
          label: "Nom de la marque",
          description: "Affiché si aucun logo n'est défini. Utilisé aussi comme alt text du logo.",
          required: true,
          maxLength: 50,
          hasCodeFallback: true,
        },
      },
    },
    {
      key: "header",
      label: "En-tête du site",
      fields: {
        /* LEGACY, AND SAID SO (#613). Two fields called « Nom de la marque »
           sat one accordion apart, and the header read the other one — so an
           owner filled this in, saw it saved, and their customers were served
           the vendor's name. It is kept, and read second by
           `resolveBrandName`, because every site seeded before the fix has its
           name here and nowhere else; blanking those headers would be a worse
           defect than the one this replaces. Fill « Identité visuelle » above. */
        brandName: {
          type: "text",
          label: "Nom de la marque (hérité)",
          description:
            "Ancien emplacement. Utilisé uniquement si « Nom de la marque » dans « Identité visuelle » est vide. Renseignez plutôt celui-ci.",
          maxLength: 50,
          hasCodeFallback: true,
        },
        menuLabel: {
          type: "text",
          label: "Texte lien menu",
          maxLength: 30,
          hasCodeFallback: true,
        },
        cartLabel: {
          type: "text",
          label: "Texte lien panier",
          maxLength: 30,
          hasCodeFallback: true,
        },
        accountLabel: {
          type: "text",
          label: "Texte lien mon compte",
          maxLength: 30,
          hasCodeFallback: true,
        },
        signinLabel: {
          type: "text",
          label: "Texte lien connexion",
          maxLength: 30,
          hasCodeFallback: true,
        },
      },
    },
    {
      key: "footer",
      label: "Pied de page",
      fields: {
        /* NO CODE FALLBACK, ON PURPOSE. The footer used to print « Commandez
           en ligne, retirez en magasin ou faites-vous livrer directement chez
           vous » on every site, whether or not the establishment delivers, and
           nothing in the editor could remove it. A sentence about what the
           establishment offers is the establishment's to write. */
        tagline: {
          type: "text",
          label: "Slogan",
          description:
            "Affichée sous le nom du restaurant, en tête du pied de page. Rien n'est affiché tant qu'elle est vide : une phrase sur la livraison, par exemple, n'a sa place que si vous livrez.",
          maxLength: 200,
          hasCodeFallback: false,
        },
        poweredBy: {
          type: "text",
          label: "Texte Powered by",
          maxLength: 100,
          hasCodeFallback: true,
        },
        copyrightText: {
          type: "text",
          label: "Texte de copyright",
          maxLength: 200,
          hasCodeFallback: true,
        },
      },
    },
    footerColumnBlock("footerNav", "Pied de page — colonne Navigation"),
    footerColumnBlock("footerUseful", "Pied de page — colonne Liens utiles"),
    {
      key: "social",
      label: "Réseaux sociaux",
      description:
        "L'icône d'un réseau n'apparaît dans le pied de page que si son adresse est renseignée (https:// obligatoire).",
      fields: {
        facebook: {
          type: "text",
          label: "Page Facebook",
          placeholder: "https://www.facebook.com/…",
          maxLength: 300,
          translatable: false,
          hasCodeFallback: false,
        },
        instagram: {
          type: "text",
          label: "Compte Instagram",
          placeholder: "https://www.instagram.com/…",
          maxLength: 300,
          translatable: false,
          hasCodeFallback: false,
        },
        tiktok: {
          type: "text",
          label: "Compte TikTok",
          placeholder: "https://www.tiktok.com/@…",
          maxLength: 300,
          translatable: false,
          hasCodeFallback: false,
        },
        snapchat: {
          type: "text",
          label: "Compte Snapchat",
          placeholder: "https://www.snapchat.com/add/…",
          maxLength: 300,
          translatable: false,
          hasCodeFallback: false,
        },
        youtube: {
          type: "text",
          label: "Chaîne YouTube",
          placeholder: "https://www.youtube.com/@…",
          maxLength: 300,
          translatable: false,
          hasCodeFallback: false,
        },
        twitter: {
          type: "text",
          label: "Compte X (Twitter)",
          placeholder: "https://x.com/…",
          maxLength: 300,
          translatable: false,
          hasCodeFallback: false,
        },
        linkedin: {
          type: "text",
          label: "Page LinkedIn",
          placeholder: "https://www.linkedin.com/company/…",
          maxLength: 300,
          translatable: false,
          hasCodeFallback: false,
        },
      },
    },
  ],
}
