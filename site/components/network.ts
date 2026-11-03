/**
 * The Kurry Up network, off the engine. CLIENT ZONE, hand-written data.
 *
 * Source: BRIEF.md sections 1 and 5 (relevé du 2026-11-01). The brand's own address page lists only SIX addresses and the brief does not say
 * which six; Lyon, Neuilly-sur-Seine, Rennes, La Réunion, Massy and Fort-de-France come from other sources (registre des entreprises, press,
 * the brand's order pages). So every line carries a STATUS and the brief's own wording; nothing here is a verified address, except the one
 * that takes orders on this site.
 *
 * Rule: a street, a postcode, an opening time or a phone number is written ONLY when the brief gives it. Everything else is `undefined`
 * and shown as « À confirmer ». Phones are never filled: none was found for the brand.
 *
 * One restaurant takes orders on this site (engine establishment): it carries `storeSlug`.
 */

export type NetworkStatus =
  /** Takes orders on this site (engine establishment). */
  | 'commande-ici'
  /** Named by the brief as a restaurant of the network (restaurant company in the national register, or named by the brand). Address and hours to confirm. */
  | 'reseau'
  /** Comes from a source other than the brand's address page (press, register, order pages). Existence to confirm with the brand. */
  | 'autre-source'
  /** Announced, not open as far as the brief knows. */
  | 'annonce'

export interface NetworkRestaurant {
  slug: string
  /** « Paris Boétie », the name used by the brief. */
  name: string
  /** Where, as far as the brief says: « Paris 8e », « Lyon 2e », « La Réunion ». */
  area: string
  city: string
  /** Written only when the brief gives it. */
  street?: string
  postcode?: string
  /** Opening hours as the brief gives them; undefined = « À confirmer ». */
  hours?: string
  status: NetworkStatus
  /** The brief's wording for this line, kept to show where it comes from. */
  note: string
  /** Set when the restaurant takes orders on this site: the engine establishment's slug. */
  storeSlug?: 'paris-washington'
}

/** Read on this date (BRIEF.md, header and section 5). */
export const NETWORK_READ_ON = '2026-11-01'

/** The brand's own claim (page « qui sommes nous » / franchise, per the brief). NOT confirmed: say « selon la marque » wherever it is shown. */
export const NETWORK_CLAIM = {
  restaurants: 30,
  franchisees: 24,
  source: 'kurryup.fr, relevé du 2026-11-01',
  confirmed: false,
} as const

/** Addresses the brand's site actually lists (brief section 9: « page Adresses incomplète (6 adresses sur 24-30) »). */
export const NETWORK_LISTED_ON_BRAND_SITE = 6

export const NETWORK_STATUS_LABEL: Record<NetworkStatus, string> = {
  'commande-ici': 'Commande en ligne ici',
  reseau: 'Restaurant du réseau, adresse à confirmer',
  'autre-source': 'Cité par une autre source, à confirmer',
  annonce: 'Annoncé',
}

export const NETWORK: NetworkRestaurant[] = [
  {
    slug: 'paris-washington',
    name: 'Paris Washington',
    area: 'Paris 8e',
    city: 'Paris',
    street: '11 rue de Washington',
    postcode: '75008',
    hours: 'Tous les jours, 11 h à 22 h 30',
    status: 'commande-ici',
    note: 'Boutique pilote, métro Champs-Élysées Clemenceau (kurryup.fr/pages/adresses). Horaires à confirmer par la marque.',
    storeSlug: 'paris-washington',
  },
  {
    slug: 'paris-rennequin',
    name: 'Paris Rennequin',
    area: 'Paris 17e',
    city: 'Paris',
    street: 'rue Rennequin',
    status: 'reseau',
    note: 'Premier restaurant, ouvert en 2015. Numéro de rue, code postal et horaires : à confirmer.',
  },
  {
    slug: 'paris-choiseul',
    name: 'Paris Choiseul',
    area: 'Paris 2e',
    city: 'Paris',
    street: 'passage Choiseul',
    status: 'reseau',
    note: 'Passage Choiseul. Numéro de rue, code postal et horaires : à confirmer.',
  },
  {
    slug: 'paris-boetie',
    name: 'Paris Boétie',
    area: 'Paris 8e',
    city: 'Paris',
    street: '28 rue de la Boétie',
    postcode: '75008',
    status: 'reseau',
    note: 'Restaurant pilote du nouveau look d\'octobre 2023. Horaires : à confirmer.',
  },
  {
    slug: 'paris-seze',
    name: 'Paris Sèze',
    area: 'Paris 9e',
    city: 'Paris',
    status: 'reseau',
    note: 'Adresse et horaires : à confirmer.',
  },
  {
    slug: 'lyon-grand-hotel-dieu',
    name: 'Lyon Grand Hôtel-Dieu',
    area: 'Lyon 2e',
    city: 'Lyon',
    status: 'autre-source',
    note: 'Cité hors du site de la marque. Adresse et horaires : à confirmer.',
  },
  {
    slug: 'neuilly-sur-seine',
    name: 'Neuilly-sur-Seine',
    area: 'Neuilly-sur-Seine',
    city: 'Neuilly-sur-Seine',
    status: 'autre-source',
    note: 'Société du restaurant créée en 2025 (registre des entreprises). Adresse et horaires : à confirmer.',
  },
  {
    slug: 'rennes',
    name: 'Rennes',
    area: 'Rennes',
    city: 'Rennes',
    status: 'autre-source',
    note: 'Deuxième franchise, octobre 2025 (source de presse). Adresse et horaires : à confirmer.',
  },
  {
    slug: 'la-reunion-saint-denis',
    name: 'La Réunion Saint-Denis',
    area: 'La Réunion',
    city: 'Saint-Denis',
    status: 'autre-source',
    note: 'Page de commande dédiée de la marque (order-lareunion.kurryup.fr). Adresse et horaires : à confirmer.',
  },
  {
    slug: 'massy',
    name: 'Massy',
    area: 'Massy',
    city: 'Massy',
    status: 'autre-source',
    note: 'Franchisé cité par une autre source. Adresse et horaires : à confirmer.',
  },
  {
    slug: 'fort-de-france',
    name: 'Fort-de-France',
    area: 'Martinique',
    city: 'Fort-de-France',
    status: 'annonce',
    note: 'Annoncé. Date d\'ouverture, adresse et horaires : à confirmer.',
  },
]

/** The lines that take orders on this site, in the order of the engine. */
export const ORDERING_RESTAURANTS = NETWORK.filter((r) => r.storeSlug)

/** « À confirmer » for any field the brief does not give. */
export const TO_CONFIRM = 'À confirmer'
export const addressLine = (r: NetworkRestaurant): string =>
  [r.street, [r.postcode, r.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || TO_CONFIRM
