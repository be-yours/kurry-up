import type { CmsGroupDefinition } from "@be-yours/cms"

export const cmsGroups: CmsGroupDefinition[] = [
  { id: "storefront", label: "Vitrine", order: 1 },
  { id: "catalog", label: "Catalogue", order: 2 },
  { id: "order", label: "Commande", order: 3 },
  { id: "account", label: "Compte", order: 4 },
  { id: "auth", label: "Authentification", order: 5 },
  { id: "games", label: "Jeux", order: 6 },
  // Not « Pages légales »: the pages list heading is « Pages », and a second
  // heading containing that word breaks every `getByRole("heading", { name: "Pages" })`.
  { id: "legal", label: "Informations légales", order: 7 },
]
