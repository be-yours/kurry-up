/**
 * Kurry Up: what the site says about itself. CLIENT ZONE.
 *
 * Every fact comes from `BRIEF.md` (sections 1, 4, 5, 7) of this project: the brand's site kurryup.fr (carte « sur place » and Shopify
 * catalogue, read on 2026-11-01), its address page and its legal notice. Anything unknown stays out and is listed in `site/A_COMPLETER.md`
 * and in `README.md` next to this file: no shop phone, no e-mail, no allergen, no delivery area or fee, no minimum order, no founder name,
 * no restaurant address the brief does not source, no franchise amount, no halal claim.
 *
 * ONE ORDERING SHOP. The engine's stores carry a carte, hours and a basket. Only « Kurry Up Paris Washington » (the pilot of the brief)
 * takes orders here. The rest of the network lives in `site/components/network.ts`, off the engine, each line with its own status.
 *
 * PRICES. The « carte (sur place) » column of the brief, in cents. The online catalogue (Shopify) disagrees on several lines and the brand must
 * choose (A_COMPLETER). Formules and supplements exist on the catalogue only: they carry the catalogue price. Desserts that exist on the
 * catalogue only are kept switched off (`active: false`).
 *
 * THIRD-PARTY BRANDS. Never named: the carte's sodas, waters, ice tea, juices, cookies, spread and ice creams are written with their common
 * name (« soda 33 cl », « cookie chocolat au lait »). The Ben & Jerry's ice creams are not seeded.
 *
 * VOICE. « Tu » (the show's rule, although the brand says « vous »), short sentences, no em dash, no « halal ». Prices are in cents.
 * French typography (non-breaking spaces before « : ; ? ! € ») is applied by `run.mjs`. Words between { braces } in a CMS title are
 * painted in the accent by the storefront.
 */

export const BRAND_SLUG = "kurry-up"

/* ── CATEGORY SLUGS: fixed once, reused by the imagery and the page agents. Order = order of the carte. ──
 *
 *   formules        Formules       (Menu Kurry Up, Bowl Kurry Up, Sandwich à composer, Salade Raja, Salade Rani)
 *   entrees         Entrées        plats-poulet   Plats de poulet     plats-agneau   Plats d'agneau
 *   legumes         Légumes        biryanis       Biryanis            naans          Naans et pains
 *   desserts        Desserts       boissons       Boissons
 *
 * Category picture: the packshot of one of its dishes (`FAMILY_IMAGE`). Product picture: `public/brand/products/<slug>.webp`
 * (variant `<slug>-sm.webp`), picked up by the seed when the file exists, silently skipped otherwise.
 */
export const CATEGORY_SLUGS = ["formules", "entrees", "plats-poulet", "plats-agneau", "legumes", "biryanis", "naans", "desserts", "boissons"]

const INSTAGRAM = "https://www.instagram.com/kurryup.fr"
const FACEBOOK = "https://facebook.com/kurryupparis"

/* ── the establishment ─────────────────────────────────────────────────── */

// SOURCED, TO CONFIRM: « tous les jours de 11 h à 22 h 30 » (kurryup.fr/pages/adresses, brief section 5). The engine REFUSES orders outside
// the hours it holds, so this week is what the demo takes orders in.
const WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "11:00", close: "22:30", isClosed: false }))

// No phone: none is published (brief sections 5 and 7). `stores.create` accepts a store without one, and writing « À confirmer » in the
// field would make a dead tel: link, so the Contact page says it instead.
export const STORES = [
  {
    slug: "paris-washington",
    name: "Kurry Up Paris Washington",
    place: "Paris Washington",
    description:
      "Kurry Up Paris Washington, 11 rue de Washington, Paris 8e, métro Champs-Élysées Clemenceau. Fresh Indian street food : curry, biryanis, naans et formules à composer. Retrait en 10 minutes sur place.",
    address: { street: "11 rue de Washington", city: "Paris", postalCode: "75008", country: "FR" },
    hours: WEEK,
  },
]

export const GLOBAL_SETTINGS = {
  currency: "EUR",
  timezone: "Europe/Paris",
  // TO CONFIRM with the accountant: 10 % is the engine's default for prepared food.
  taxRate: 10,
  // The brand sells on the spot, to take away and delivered. Delivery stays OFF: the engine needs a fee and a radius to take a delivery
  // order and the brief has neither (A_COMPLETER).
  services: { dineIn: true, takeaway: true, delivery: false, clickAndCollect: true },
  hours: WEEK,
  delivery: {},
  // PLACEHOLDER: no online payment connected. Orders placed on the demo are paid at the shop (cash only). The brand's real providers
  // (Adyen, Stripe, LyfPay, Lunchr) come from the code of its current app and are not confirmed.
  payments: { cardProvider: "none", paypal: false, cash: true },
  integrations: {},
  // Legal identity of the brief (section 1): the brand's legal notice and the national register. Legal form, share capital, VAT number: not
  // found, left out. The entity to display on the future site is TO CONFIRM (Washington or the franchisor).
  seller: {
    legalName: "Kurry Up",
    address: { street: "11 rue Washington", city: "Paris", postalCode: "75008", country: "FR" },
    siren: "838057065",
    siret: "83805706500024",
    rcs: "RCS Paris 838 057 065",
  },
  // Nothing sourced: no e-mail of the brand (the legal notice carries a personal mailbox, not reused), no phone, no host, no director.
  siteLegal: {},
}

export const LANGUAGES = [{ code: "fr", name: "French", nativeName: "Français", flagEmoji: "🇫🇷", isDefault: true }]

/* ── option groups (engine: `products.options`, `priceModifier` in cents) ── */

const slugify = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

const choice = (name, priceModifier = 0) => ({ id: slugify(name), name, priceModifier })
/** A group of choices at the same price. `max` is how many the diner may take (the engine cannot force an exact count). */
const pick = (id, name, names, { max = 1, required = true } = {}) => ({ id, name, required, maxSelections: max, choices: names.map((n) => choice(n)) })
/** A group of paid extras: `[name, cents]` pairs. */
const extras = (id, name, items) => ({ id, name, required: false, maxSelections: items.length, choices: items.map(([n, c]) => choice(n, c)) })

const p = (slug, name, price, description, extra = {}) => ({ slug, name, price, ...(description ? { description } : {}), ...extra })
const off = (product) => ({ ...product, active: false, imageFile: null })

/*
 * Composition of the products to compose (Menu Kurry Up, Bowl Kurry Up, Sandwich à composer): « 1 protéine + 3 légumes + 3 toppings »
 * (brief section 4). The brief does not list the BASE choices, only the supplements of the catalogue, so the choices below reuse the names of
 * those supplements and are DEMO choices (A_COMPLETER). Choices cost nothing; the supplements carry the catalogue prices:
 * proteins 3 € / 3 € / 2 € / 1,50 €, vegetables 1 €, toppings 0,50 €.
 */
const PROTEINES = ["Poulet tikka", "Plat du jour", "Samossa légumes", "Pakora"]
const LEGUMES = ["Haricots verts", "Poivrons", "Pommes de terre", "Palak", "Légumes du jour"]
const TOPPINGS = [
  "Oignons caramélisés",
  "Cacahuètes",
  "Menthe",
  "Coriandre",
  "Tomates",
  "Concombres",
  "Salade",
  "Sauce citronnelle",
  "Sauce douce raïta",
  "Sauce épicée",
]
const NAANS_MENU = ["Naan nature", "Naan à l'ail", "Naan fromage", "Chapati"]
const BOISSONS_MENU = ["Eau 33 cl", "Soda 33 cl", "Thé glacé 33 cl"]
const SUPPLEMENTS = [
  extras("proteine-en-plus", "Une protéine en plus", [
    ["Poulet tikka", 300],
    ["Plat du jour", 300],
    ["Samossa légumes", 200],
    ["Pakora", 150],
  ]),
  extras("legume-en-plus", "Un légume en plus", LEGUMES.map((n) => [n, 100])),
  extras("topping-en-plus", "Un topping en plus", TOPPINGS.map((n) => [n, 50])),
]
const composition = ({ naan = false, boisson = false } = {}) => ({
  options: [
    pick("proteine", "Ta protéine (1 au choix)", PROTEINES),
    pick("legumes", "Tes légumes (3 au choix)", LEGUMES, { max: 3 }),
    pick("toppings", "Tes toppings (3 au choix)", TOPPINGS, { max: 3 }),
    ...(naan ? [pick("naan", "Ton naan", NAANS_MENU)] : []),
    ...(boisson ? [pick("boisson", "Ta boisson", BOISSONS_MENU)] : []),
    ...SUPPLEMENTS,
  ],
})

/* ── the carte (brief section 4, « carte sur place » prices) ── */

const FORMULES = [
  p("menu-kurry-up", "Menu Kurry Up", 1490, "1 protéine, 3 légumes, 3 toppings, un naan et une boisson au choix. Compose ton plat préféré en 2 minutes.", composition({ naan: true, boisson: true })),
  p("bowl-kurry-up", "Bowl Kurry Up", 1240, "1 protéine, 3 légumes et 3 toppings, composés par toi en 2 minutes.", composition()),
  p("sandwich-a-composer", "Sandwich à composer", 1090, "1 protéine, 3 légumes et 3 toppings, composés par toi en 2 minutes.", composition()),
  p("salade-raja", "Salade Raja", 1090),
  p("salade-rani", "Salade Rani", 1090),
]

const ENTREES = [
  p("raita", "Raïta", 390, "Yaourt frais, concombre, carottes et épices."),
  p("samossa", "Samossa", 490, "2 pièces. Beignets farcis de légumes ou de viande, piment, coriandre, curcuma.", { options: [pick("garniture", "Ta garniture", ["Légumes", "Viande"])] }),
  p("pakora", "Pakora", 490, "4 pièces. Beignet de pomme de terre à la farine de pois."),
  p("poulet-tikka", "Poulet tikka", 590, "Brochette de blanc de poulet."),
  p("samossa-chaat", "Samossa chaat", 590, "Samossa aux légumes, oignon haché, pois chiches, massala et chutney maison."),
  p("soupe-de-lentilles", "Soupe de lentilles", 590, "Coriandre fraîche et fenugrec."),
]

const PLATS_POULET = [
  p("butter-chicken", "Butter chicken", 1500, "Poulet grillé au tandoor, sauce crémeuse, douce et onctueuse, riz basmati."),
  p("poulet-tikka-massala", "Poulet tikka massala", 1500, "Blanc de poulet grillé, sauce tikka aux poivrons et aux oignons, riz basmati."),
  p("poulet-karahi", "Poulet karahi", 1500, "Curry de poulet relevé, riz basmati."),
  p("poulet-korma", "Poulet korma", 1500, "Poulet à la crème fraîche, amandes et raisins, riz basmati."),
]

const PLATS_AGNEAU = [
  p("agneau-madras", "Agneau madras", 1600, "Curry d'agneau et riz basmati."),
  p("agneau-shahi-korma", "Agneau shahi korma", 1600, "Curry d'agneau à la crème fraîche, amandes et raisins, riz basmati."),
  p("agneau-karahi", "Agneau karahi", 1600, "Agneau mijoté aux épices, riz basmati."),
]

const LEGUMES_PLATS = [
  p("palak-paneer", "Palak paneer", 1300, "Curry d'épinards et de pommes de terre, riz basmati."),
  p("daal-tarka", "Daal tarka", 1300, "Curry de lentilles et de tomates, riz basmati."),
  p("aubergine-massala", "Aubergine massala", 1300, "Aubergine fumée, tomates, oignons et garam massala, riz basmati."),
  p("chana-massala", "Chana massala", 1300, "Pois chiches en sauce curry."),
]

const BIRYANIS = [
  p("biryani-poulet", "Biryani poulet", 1190, "Riz et poulet mariné."),
  p("biryani-legumes", "Biryani légumes", 1190, "Riz et légumes marinés."),
  p("biryani-agneau", "Biryani agneau", 1390, "Riz et agneau rôti mariné."),
  p("biryani-crevettes", "Biryani crevettes", 1390, "Riz et crevettes marinées au garam masala."),
]

const NAANS = [
  p("naan-nature", "Naan nature", 290),
  p("naan-ail", "Naan à l'ail", 390),
  p("naan-fromage", "Naan fromage", 390),
  p("chapati", "Chapati", 320, "Pain plat, vegan."),
  p("naan-ail-fromage", "Naan ail et fromage", 490),
]

// The sweet naan is listed « Naans / Desserts » in the brief: it sits with the desserts. The spread is named by its common name.
const DESSERTS = [
  p("naan-chocolat-noisette", "Naan chocolat noisette", 390, "Naan nappé de pâte à tartiner chocolat noisette."),
  p("cookie-chocolat-au-lait", "Cookie chocolat au lait", 250),
  p("cookie-caramel-cacahuete", "Cookie caramel cacahuète", 250, "Cookie au caramel et au beurre de cacahuète."),
  // Catalogue only (3,90 € online, not on the carte): kept, switched off, until the brand decides (A_COMPLETER).
  off(p("fromage-blanc-mangue-muesli", "Fromage blanc, coulis de mangue et muesli", 390)),
  off(p("mousse-au-chocolat", "Mousse au chocolat", 390)),
  off(p("mangue-menthe", "Mangue et menthe ciselée", 390)),
]

const BOISSONS = [
  p("eau-33-cl", "Eau 33 cl", 250, undefined, { options: [pick("eau", "Plate ou gazeuse", ["Plate", "Gazeuse"])] }),
  p("soda-33-cl", "Soda 33 cl", 250, undefined, {
    options: [pick("saveur", "Saveur", ["Cola", "Cola light", "Cola zéro", "Soda tropical", "Orange", "Pomme", "Soda citron-lime"])],
  }),
  p("the-glace-33-cl", "Thé glacé 33 cl", 250),
  p("the-glace-50-cl", "Thé glacé 50 cl", 390),
  p("eau-de-coco", "Eau de coco", 390),
  p("biere-indienne-33-cl", "Bière indienne 33 cl", 430, "L'abus d'alcool est dangereux pour la santé, à consommer avec modération."),
  p("the-indien", "Thé indien", 290),
  p("lassi", "Lassi", 390, "33 cl, fait maison.", { options: [pick("parfum", "Parfum", ["Nature", "Salé", "Mangue", "Rose"])] }),
  p("jus-indien-25-cl", "Jus indien 25 cl", 390, undefined, { options: [pick("parfum", "Parfum", ["Litchi", "Mangue"])] }),
  p("kombucha", "Kombucha", 390, undefined, { options: [pick("parfum", "Parfum", ["Grenade", "Mangue passion", "Gingembre"])] }),
]

const CATEGORY = {
  formules: { name: "Formules", description: "Compose ton menu, ton bowl ou ton sandwich en 2 minutes : 1 protéine, 3 légumes, 3 toppings.", products: FORMULES },
  entrees: { name: "Entrées", description: "Samossas, pakoras, raïta, poulet tikka et soupe de lentilles.", products: ENTREES },
  "plats-poulet": { name: "Plats de poulet", description: "Butter chicken, poulet tikka massala, karahi et korma, avec du riz basmati.", products: PLATS_POULET },
  "plats-agneau": { name: "Plats d'agneau", description: "Madras, shahi korma et karahi, avec du riz basmati.", products: PLATS_AGNEAU },
  legumes: { name: "Légumes", description: "Palak paneer, daal tarka, aubergine massala et chana massala.", products: LEGUMES_PLATS },
  biryanis: { name: "Biryanis", description: "Le riz mariné au poulet, aux légumes, à l'agneau ou aux crevettes.", products: BIRYANIS },
  naans: { name: "Naans et pains", description: "Nature, ail, fromage, ail et fromage, et le chapati.", products: NAANS },
  desserts: { name: "Desserts", description: "Le naan chocolat noisette et les cookies.", products: DESSERTS },
  boissons: { name: "Boissons", description: "Lassi, thé indien, kombucha, jus, sodas, eaux et bière indienne.", products: BOISSONS },
}

/** The picture of a family is the packshot of one of its dishes (no separate category art). */
const FAMILY_IMAGE = {
  formules: "menu-kurry-up",
  entrees: "samossa",
  "plats-poulet": "butter-chicken",
  "plats-agneau": "agneau-karahi",
  legumes: "palak-paneer",
  biryanis: "biryani-poulet",
  naans: "naan-fromage",
  desserts: "cookie-chocolat-au-lait",
  boissons: "lassi",
}
const family = (slug) => ({
  slug,
  ...CATEGORY[slug],
  imageFile: FAMILY_IMAGE[slug] ? `products/${FAMILY_IMAGE[slug]}.webp` : null,
})
const CARTE = CATEGORY_SLUGS.map(family)
const CARTES = Object.fromEntries(STORES.map((s) => [s.slug, CARTE]))

/** The carte of one store, in order: `[{ slug, name, description, imageFile, products }]`. */
export const carteFor = (storeSlug) => CARTES[storeSlug]

/** Every product has a picture slot, `products/<slug>.webp` (and `-sm.webp`), filled when the file exists in `public/brand`. */
export const productImageFile = (slug) => `products/${slug}.webp`

/** Ranked products on the home page: what the brief puts forward (« Les plus populaires »). */
const TRENDING = ["poulet-tikka-massala", "butter-chicken", "poulet-tikka", "poulet-korma"]
export const trendingFor = () => TRENDING

export const COUNTS = {
  categories: CATEGORY_SLUGS.length,
  products: Object.values(CATEGORY).reduce((n, c) => n + c.products.length, 0),
  active: Object.values(CATEGORY).reduce((n, c) => n + c.products.filter((x) => x.active !== false).length, 0),
}

/** The list the imagery agent works from (`node site/seed/run.mjs --image-list` writes it to `site/IMAGES_PRODUITS_LISTE.json`). */
export function imageList() {
  const out = []
  for (const slug of CATEGORY_SLUGS) {
    const c = CATEGORY[slug]
    for (const prod of c.products) {
      out.push({
        slug: prod.slug,
        nom: prod.name,
        categorie: slug,
        categorie_nom: c.name,
        description: prod.description ?? "",
        // Choices worth a mention to the illustrator: single-pick groups of a simple product (the composed formules are drawn from their description).
        choix: (prod.options ?? []).length > 2 ? [] : (prod.options ?? []).flatMap((g) => (g.maxSelections > 1 || g.choices.length > 6 ? [] : g.choices.map((x) => x.name))),
        actif: prod.active !== false,
        fichier: `/brand/products/${prod.slug}.webp`,
        fichier_sm: `/brand/products/${prod.slug}-sm.webp`,
      })
    }
  }
  return out
}

/* ── the shop's own words: UI overrides, per store ── */
const UI_WORDS = Object.fromEntries(
  STORES.map((s) => [
    s.slug,
    {
      fr: {
        "storefront.storeClosedTitle": "On a fermé la boutique",
        "storefront.storeClosedMessage": `Kurry Up ${s.place} ne prend pas de commande à cette heure-ci. Reviens dans un instant.`,
        // The engine calls the basket « Box ». Here it is the order.
        "cart.boxTitle": "Ma commande",
        "cart.boxTitleFull": "Ta commande",
        "cart.boxEmpty": "Ta commande est vide",
        "cart.boxEmptyMessage": "Rien dans ta commande pour l'instant. Choisis ton curry sur la carte.",
        "accessibility.openBox": "Ouvrir la commande",
        "accessibility.cartStatus": "Commande : {count} articles, total {total}",
        "accessibility.cartEmptied": "Ta commande est vide",
        "accessibility.openBoxWithCount": "Ouvrir la commande, {count} articles",
        "nav.menu": "Carte",
        "nav.about": "Notre histoire",
      },
    },
  ]),
)
export const uiWordsFor = (storeSlug) => UI_WORDS[storeSlug]

/* ── media the CMS points at (files in public/brand, built by the imagery agent) ──
 * CONTRACT with the imagery phase: these file names. A file that is not on disk is skipped and listed at the end of the run; rename
 * a key's file here if the imagery agent names it otherwise, then rerun `node site/seed/run.mjs --only=pages,blog`.
 * Every visual is an illustration generated by AI (the legal notice says so). */

const IA = "(illustration générée par IA)"
export const MEDIA = {
  logo: { file: "logo/kurry-up.svg", alt: "Kurry Up : le logo de la marque" },
  favicon: { file: "icon-192.png", alt: "Le logo Kurry Up" },
  og: { file: "og-default.jpg", alt: "Kurry Up : fresh Indian street food in Paris" },
  fallback: { file: "scenes/facade.webp", alt: `La façade d'un restaurant Kurry Up ${IA}` },
  heroStreetFood: { file: "hero/street-food.webp", alt: `Un repas de street food indienne ${IA}` },
  facade: { file: "scenes/facade.webp", alt: `La façade d'un restaurant Kurry Up ${IA}` },
  counter: { file: "scenes/counter.webp", alt: `Le comptoir d'un restaurant Kurry Up ${IA}` },
  tandoor: { file: "scenes/tandoor.webp", alt: `Le four tandoor d'un restaurant Kurry Up ${IA}` },
  samossa: { file: "products/samossa.webp", alt: `Des samossas ${IA}` },
  butterChicken: { file: "products/butter-chicken.webp", alt: `Un butter chicken avec du riz basmati ${IA}` },
  tikkaMassala: { file: "products/poulet-tikka-massala.webp", alt: `Un poulet tikka massala ${IA}` },
  agneauKarahi: { file: "products/agneau-karahi.webp", alt: `Un agneau karahi ${IA}` },
  biryani: { file: "products/biryani-poulet.webp", alt: `Un biryani au poulet ${IA}` },
  naanFromage: { file: "products/naan-fromage.webp", alt: `Un naan fromage ${IA}` },
  lassi: { file: "products/lassi.webp", alt: `Un lassi ${IA}` },
  bowl: { file: "products/bowl-kurry-up.webp", alt: `Un bowl Kurry Up ${IA}` },
  menuKurryUp: { file: "products/menu-kurry-up.webp", alt: `Un menu Kurry Up ${IA}` },
}

/* ── CMS pages ─────────────────────────────────────────────────────────── */

const t = (v) => ({ type: "text", textValue: v })
const rt = (v) => ({ type: "richtext", textValue: v })
const sel = (v) => ({ type: "select", textValue: v })
const media = (key, alt) => ({ type: "image", $media: key, ...(alt ? { altText: alt } : {}) })
const seo = (metaTitle, metaDescription) => ({
  metaTitle: t(metaTitle),
  metaDescription: t(metaDescription),
  ogImage: media("og"),
  robots: sel("index, follow"),
})

const LEGAL_GAPS =
  "<p><strong>À confirmer par la marque avant la mise en ligne.</strong> Faits relevés : Kurry Up, 11 rue Washington, 75008 Paris, immatriculée 838 057 065 RCS Paris, SIRET du siège 838 057 065 00024, d'après les mentions légales du site de la marque et le registre des entreprises. L'entité à afficher sur le futur site (la société du restaurant de Washington ou la société franchiseur), l'hébergeur de ce site, le responsable de la publication, la forme juridique, le capital social, le numéro de TVA et le médiateur de la consommation sont à renseigner. Téléphone et e-mail de la marque : à confirmer.</p>"

const DEMO_NOTICE =
  "<p><strong>Site de démonstration.</strong> Ce site est une démonstration réalisée par Be yours, ce n'est pas le site de Kurry Up. Les commandes passées ici sont des essais : rien n'est préparé, rien n'est livré et aucun paiement réel n'est enregistré.</p>"

/** The CMS pages of one store. */
export function pagesFor(storeSlug) {
  const s = STORES.find((x) => x.slug === storeSlug)
  const street = `${s.address.street}, ${s.address.postalCode} ${s.address.city}`

  return {
    homepage: {
      seo: seo(
        // the root layout appends « | Kurry Up » to the home's title: the brand is not written here
        `Fresh Indian street food à ${s.place}`,
        `Kurry Up ${s.place}, ${street}. Butter chicken, poulet tikka massala, biryanis, naans et formules à composer. Commande en ligne.`,
      ),
      hero: {
        badge: t("Retrait en 10\u00a0min, livraison en 1\u00a0h\u00a0max"),
        title: t("{Fresh Indian}\nstreet food\nà Paris"),
        subtitle: t("Compose ton bowl en 2\u00a0minutes, ou prends un classique."),
        image: media("heroStreetFood"),
        ctaLabel: t("Commander"),
        floatingBadge1Title: t("10\u00a0min"),
        floatingBadge1Subtitle: t("Retrait sur place"),
        floatingBadge2Title: t("1\u00a0h max"),
        floatingBadge2Subtitle: t("Livraison"),
      },
      features: {
        feature1Image: media("butterChicken"),
        feature1Label: t("La famille ouvre le restaurant Mahatma à Paris."),
        feature2Image: media("bowl"),
        feature2Label: t("Le premier Kurry Up ouvre rue Rennequin, Paris 17e."),
        feature3Image: media("tandoor"),
        feature3Label: t("Rue de la Boétie\u00a0: graffiti, tuk-tuk et tandoor."),
        feature4Image: media("facade"),
        feature4Label: t("11 rue de Washington, métro Champs-Élysées Clemenceau."),
        feature5Image: media("counter"),
        feature5Label: t("Tous les jours de 11\u00a0h à 22\u00a0h\u00a030, sur place ou à emporter."),
      },
      trendingMeals: {
        sectionTitle: t("Les {plus populaires}"),
        viewAllLabel: t("Toute la carte"),
      },
      categories: {
        badge: t("La carte"),
        sectionTitle: t("Choisis ton {curry}"),
        description: t("Entrées, plats de poulet et d'agneau, légumes, biryanis, naans, desserts et boissons, plus les formules à composer."),
      },
      cta: {
        badge: t("Ta création"),
        title: t("Compose ton {plat}\nen 2\u00a0minutes"),
        subtitle: t("Ton bowl à 12,40\u00a0€, ton sandwich à 10,90\u00a0€, ton menu à 14,90\u00a0€ avec un naan et une boisson\u00a0: 1 protéine, jusqu'à 3 légumes et jusqu'à 3 toppings, à ton goût."),
        buttonText: t("Composer ma création"),
        backgroundImage: media("bowl"),
      },
      blog: {
        sectionTitle: t("Pour les {connaisseurs}"),
        viewAllLabel: t("Tous les articles"),
      },
    },

    about: {
      seo: seo("Notre histoire | Kurry Up", "Kurry Up est né en 2015 rue Rennequin, à Paris, d'une famille qui tient le restaurant Mahatma depuis 1965."),
      hero: {
        badge: t("Notre histoire"),
        title: t("De Mahatma à {Kurry Up}"),
        subtitle: t("La cuisine indienne, plus rapide et plus accessible."),
      },
      story: {
        badge: t("Depuis 2015"),
        title: t("Une histoire de {famille}"),
        description: rt(
          "<p>Kurry Up est né en 2015 rue Rennequin (Paris 17e), d'une famille qui tient depuis 1965 le restaurant Mahatma et qui a voulu rendre la cuisine indienne plus rapide et plus accessible.</p>" +
            "<p>L'enseigne a changé d'identité en octobre 2023, avec un nouveau logo, un graffiti indien, un tuk-tuk et un tandoor au restaurant pilote de la rue de la Boétie, puis elle a lancé la franchise.</p>" +
            "<p>Le site de la marque annonce 24 franchisés et 30 restaurants en exploitation ou en développement, dont La Réunion et Rennes. Ces chiffres sont à confirmer par la marque.</p>",
        ),
        image: media("facade"),
      },
      values: {
        badge: t("Chez Kurry Up"),
        title: t("Trois {envies}"),
        value1Image: media("butterChicken"),
        value1Title: t("Les currys"),
        value1Description: t("Butter chicken, poulet tikka massala, karahi, korma : du poulet ou de l'agneau, avec du riz basmati."),
        value2Image: media("biryani"),
        value2Title: t("Les biryanis"),
        value2Description: t("Du riz mariné au poulet, aux légumes, à l'agneau ou aux crevettes."),
        value3Image: media("bowl"),
        value3Title: t("Ta création"),
        value3Description: t("1 protéine, 3 légumes, 3 toppings : compose ton bowl, ton sandwich ou ton menu en 2 minutes."),
      },
      // Only countable facts from the brief.
      stats: {
        stat1Value: t("1965"),
        stat1Label: t("Mahatma ouvre à Paris"),
        stat2Value: t("2015"),
        stat2Label: t("premier Kurry Up, rue Rennequin"),
        stat3Value: t("10 min"),
        stat3Label: t("retrait sur place, selon la marque"),
        stat4Value: t("7 j/7"),
        stat4Label: t("de 11 h à 22 h 30 à Paris Washington"),
      },
      cta: {
        title: t("Une envie de {curry} ?"),
        subtitle: t(`Jette un œil à la carte, puis passe nous voir : ${street}.`),
        buttonText: t("Voir la carte"),
      },
    },

    contact: {
      seo: seo(`Contact | Kurry Up ${s.place}`, `Kurry Up ${s.place}, ${street}. Écris-nous depuis le formulaire.`),
      hero: {
        badge: t("Contact"),
        title: t("Passe nous {voir}"),
        subtitle: t(`${street}, métro Champs-Élysées Clemenceau. Le téléphone et l'e-mail du restaurant sont à confirmer : en attendant, écris-nous depuis le formulaire.`),
      },
      form: {
        heading: t("Écris-nous"),
        description: t("Une question sur la carte ou sur le restaurant ? Dis-nous tout. Formulaire de démonstration."),
        submitLabel: t("Envoyer"),
      },
      info: {
        addressTitle: t("L'adresse"),
        hoursTitle: t("Les horaires"),
        contactTitle: t("Nous joindre"),
      },
      // `responseTime` stays empty: the brand promises an answer within 24 h on its own site, not on this demo.
    },

    blog: {
      seo: seo("Le blog | Kurry Up", "Choisir son curry, son naan, son biryani, sa boisson : le blog de Kurry Up, fresh Indian street food à Paris."),
      hero: {
        badge: t("Le blog"),
        title: t("Le blog {Kurry Up}"),
        subtitle: t("Currys, naans, biryanis, lassi : comment bien choisir."),
      },
      emptyState: {
        title: t("Ça arrive"),
        subtitle: t("Reviens vite : les prochains articles se préparent."),
      },
    },

    // The storefront does not read this page (`rendered: false`): filled so the admin is complete.
    menu: {
      seo: seo(`La carte | Kurry Up ${s.place}`, "La carte de Kurry Up : formules, entrées, plats de poulet et d'agneau, légumes, biryanis, naans, desserts et boissons."),
      header: { title: t(`La carte de ${s.place}`), subtitle: t("Formules, entrées, plats, biryanis, naans, desserts et boissons.") },
      emptyState: { title: t("La carte arrive"), subtitle: t("Reviens dans un instant.") },
    },

    "product-detail": {
      header: { title: t("Le produit") },
      sections: { descriptionTitle: t("Le détail"), optionsTitle: t("À ta façon"), similarTitle: t("Tu aimeras aussi") },
      actions: { addToCartLabel: t("Ajouter à ma commande"), outOfStockLabel: t("Momentanément indisponible") },
    },

    "storefront-layout": {
      seo: seo("Kurry Up | Fresh Indian street food in Paris", "Kurry Up : fresh Indian street food in Paris. Butter chicken, poulet tikka massala, biryanis, naans et formules à composer."),
      branding: { logo: media("logo"), favicon: media("favicon"), brandName: t("Kurry Up") },
      header: { menuLabel: t("La carte") },
      footer: { tagline: t("Fresh Indian street food in Paris") },
      // The franchise page is linked from the FOOTER only, never from the header.
      footerNav: {
        display: sel("show"),
        title: t("Kurry Up"),
        link1Label: t("La carte"),
        link1Url: t("/menu"),
        link2Label: t("Nos restaurants"),
        link2Url: t("/restaurants"),
        link3Label: t("Notre histoire"),
        link3Url: t("/about"),
        link4Label: t("Le blog"),
        link4Url: t("/blog"),
        link5Label: t("Contact"),
        link5Url: t("/contact"),
        link6Label: t("Ouvrir un Kurry Up"),
        link6Url: t("/franchise"),
      },
      footerUseful: {
        display: sel("show"),
        title: t("Informations"),
        link1Label: t("Mentions légales"),
        link1Url: t("/mentions-legales"),
        link2Label: t("Conditions de vente"),
        link2Url: t("/cgv"),
        link3Label: t("Confidentialité"),
        link3Url: t("/confidentialite"),
        link4Label: t("Ma commande"),
        link4Url: t("/cart"),
        link5Label: t("Mon compte"),
        link5Url: t("/account"),
        link6Label: t("Changer de restaurant"),
        link6Url: t("/store-selector"),
      },
      social: { instagram: t(INSTAGRAM), facebook: t(FACEBOOK) },
    },

    "legal-notice": {
      seo: seo("Mentions légales | Kurry Up", "Mentions légales du site de démonstration de Kurry Up."),
      content: {
        intellectualProperty: rt(
          DEMO_NOTICE +
            "<p>Le nom Kurry Up, son logo et ses textes appartiennent à leurs titulaires.</p>" +
            "<p>Illustrations générées par IA : les visuels de ce site (plats, boissons, façade, comptoir, tandoor) sont des illustrations générées par intelligence artificielle. Ce ne sont pas les photos de la marque et elles ne représentent pas les produits tels qu'ils sont servis.</p>",
        ),
        additional: rt(LEGAL_GAPS),
      },
    },
    "terms-of-sale": {
      seo: seo("Conditions générales de vente | Kurry Up", "Conditions générales de vente du site de démonstration de Kurry Up."),
      clauses: {
        ordering: rt(
          DEMO_NOTICE +
            "<p>Texte standard de démonstration. Un prix affiché est un prix TTC en euros. La commande est confirmée quand le restaurant l'accepte. Les conditions de vente réelles de Kurry Up sont à confirmer par la marque.</p>",
        ),
        delivery: rt(
          "<p><strong>À confirmer par la marque.</strong> La marque annonce un retrait en 10 minutes sur place et une livraison en 1 heure maximum sur son site. La zone de livraison, les frais et le minimum de commande ne sont pas renseignés, et la livraison n'est pas ouverte sur cette démonstration.</p>",
        ),
        cancellation: rt(
          "<p>Texte standard de démonstration. En règle générale, le droit de rétractation ne s'applique pas à un repas préparé sur commande ; la politique d'annulation et de réclamation de Kurry Up est à confirmer par la marque et son conseil.</p>",
        ),
        additional: rt(LEGAL_GAPS),
      },
    },
    "privacy-policy": {
      seo: seo("Politique de confidentialité | Kurry Up", "Politique de confidentialité du site de démonstration de Kurry Up."),
      content: {
        additional: rt(
          "<p><strong>Site de démonstration.</strong> Texte standard : aucune donnée réelle ne doit être saisie ici. Les informations que tu donnes en commandant ou depuis le formulaire (nom, e-mail, téléphone, contenu de la commande) servent uniquement à faire fonctionner la démonstration.</p>" +
            "<p><strong>À confirmer par la marque.</strong> Le responsable du traitement, la durée de conservation, les sous-traitants et le contact pour exercer tes droits seront renseignés avant toute mise en ligne.</p>" +
            LEGAL_GAPS,
        ),
      },
    },
  }
}

/* ── blog (the same slugs in every store, so a /blog link survives a store switch) ── */

export const BLOG_CATEGORIES = [
  { name: "La carte", description: "Les plats, les naans, les biryanis et les boissons de Kurry Up." },
  { name: "Notre histoire", description: "De Mahatma à Kurry Up." },
]

/** Articles this seed published once and no longer publishes (none yet). */
export const RETIRED_ARTICLES = []
