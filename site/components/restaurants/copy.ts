/**
 * /restaurants, « Le mur des adresses »: the visitor copy and the wall's layout. CLIENT ZONE.
 * Owner: agent « réseau + franchise » (site/ART_DIRECTION.md § 13).
 *
 * Facts come from BRIEF.md (sections 1, 5) through `site/components/network.ts`. Nothing here adds an address,
 * a postcode, an opening time or a phone the brief does not give; what is missing is written « À confirmer »
 * and listed in site/A_COMPLETER.md. The network total is only ever shown with « selon la marque ».
 *
 * Tutoiement, « » quotes, no em dash. Non-breaking spaces are put by `typoDeep` (typo.ts).
 */
import { typoDeep } from './typo'

export type Peinture = 'orange' | 'vert' | 'ocre' | 'sauge' | 'creme'

export interface Tuile {
  /** Slug of the line in `NETWORK` (site/components/network.ts). */
  slug: string
  peinture: Peinture
  /** The painted mark, line by line (« 17 », or « SAINT- » / « DENIS »). */
  marque: string[]
  /** The ordinal after a district number (« e » of « 17e »). */
  ordinal?: string
  /** Columns on the 12-column wall (≥ 1024 px) and on the 6-column tablet wall. */
  lg: number
  md: number
  /** A lead tile: its painted mark may grow larger (`data-rs-taille="grande"`). */
  grande?: boolean
  /** A full-width band on the 12-column wall: mark on the left, text on the right (`data-rs-forme`). */
  bandeau?: boolean
  /** What the brief says about this restaurant, in one or two sentences. */
  fait: string
  /** The address line as far as the brief gives it; `undefined` = « À confirmer ». */
  adresse?: string
  /** Part of the address still missing, shown beside a partial address. */
  manque?: string
}

/*
 * The wall, in reading order. The spans tile the 12 columns without holes (≥ 1024 px), one row per line and
 * no tile spanning two rows: a tile two rows high was stretched to the height of the two rows beside it and
 * stood half empty (QA défaut 22). Scale comes from the widths and the lead tiles' larger marks instead:
 *   r1    Rennequin 7 (grande) | Boétie 5
 *   r2    Choiseul 5 | Sèze 3 | Neuilly 4
 *   r3    Lyon 5 | Rennes 7
 *   r4    La Réunion 12, a band (mark left, text right)
 *   r5    Massy 6 | Fort-de-France 6
 * Paints were chosen so that no two touching tiles share a colour, at every width (phone stack, 6-col
 * tablet, 12-col desktop), and the wall holds ONE orange tile (the first restaurant, 2015).
 */
export const MUR: Tuile[] = typoDeep<Tuile[]>([
  {
    slug: 'paris-rennequin',
    peinture: 'orange',
    marque: ['17'],
    ordinal: 'e',
    lg: 7,
    md: 6,
    grande: true,
    fait: 'Le premier Kurry Up, ouvert en 2015. C\'est ici que la famille de Mahatma a voulu rendre la cuisine indienne plus rapide et plus accessible.',
    adresse: 'Rue Rennequin, Paris 17e',
    manque: 'Numéro de rue',
  },
  {
    slug: 'paris-boetie',
    peinture: 'sauge',
    marque: ['8'],
    ordinal: 'e',
    lg: 5,
    md: 3,
    fait: 'Le restaurant pilote du nouveau décor d\'octobre 2023 : graffiti, tuk-tuks et four tandoor.',
    adresse: '28 rue de la Boétie, 75008 Paris',
  },
  {
    slug: 'paris-choiseul',
    peinture: 'ocre',
    marque: ['2'],
    ordinal: 'e',
    lg: 5,
    md: 3,
    fait: 'Dans le passage Choiseul.',
    adresse: 'Passage Choiseul, Paris 2e',
    manque: 'Numéro',
  },
  {
    slug: 'paris-seze',
    peinture: 'creme',
    marque: ['9'],
    ordinal: 'e',
    lg: 3,
    md: 2,
    fait: 'Paris 9e.',
  },
  {
    slug: 'neuilly-sur-seine',
    peinture: 'vert',
    marque: ['NEUILLY'],
    lg: 4,
    md: 2,
    fait: 'Neuilly-sur-Seine, aux portes de Paris.',
  },
  {
    slug: 'lyon-grand-hotel-dieu',
    peinture: 'creme',
    marque: ['LYON'],
    lg: 5,
    md: 2,
    fait: 'Au Grand Hôtel-Dieu, Lyon 2e.',
  },
  {
    slug: 'rennes',
    peinture: 'sauge',
    marque: ['RENNES'],
    lg: 7,
    md: 4,
    fait: 'La deuxième franchise du réseau, ouverte en octobre 2025 d\'après la presse.',
  },
  {
    slug: 'la-reunion-saint-denis',
    peinture: 'ocre',
    marque: ['SAINT-', 'DENIS'],
    lg: 12,
    md: 6,
    bandeau: true,
    fait: 'Kurry Up de l\'autre côté de l\'océan, à Saint-Denis de La Réunion.',
  },
  {
    slug: 'massy',
    peinture: 'vert',
    marque: ['MASSY'],
    lg: 6,
    md: 2,
    fait: 'Massy, au sud de Paris.',
  },
  {
    slug: 'fort-de-france',
    peinture: 'sauge',
    marque: ['FORT-DE-', 'FRANCE'],
    lg: 6,
    md: 6,
    fait: 'Fort-de-France, en Martinique : une ouverture annoncée.',
  },
])

export const COPY = typoDeep({
  meta: {
    title: 'Nos restaurants | Kurry Up',
    description:
      'Le mur des adresses de Kurry Up : Paris Washington prend ta commande en ligne, et le réseau de Paris à La Réunion, avec ce que l\'on sait de chaque restaurant.',
  },
  confirmer: 'À confirmer',
  tete: {
    surtitre: 'Le mur des adresses',
    titre: 'Nos restaurants',
    lead: 'Une adresse prend ta commande en ligne : Paris Washington. Le reste du réseau est peint ici, restaurant par restaurant, avec ce que l\'on sait de chacun.',
    compte: {
      nombre: '30',
      texte: 'restaurants en exploitation ou en développement, selon la marque',
    },
    mur: { texte: 'restaurants peints sur ce mur' },
    ici: { nombre: '1', texte: 'prend ta commande en ligne ici' },
  },
  ici: {
    surtitre: 'Commande en ligne ici',
    nom: 'Paris Washington',
    adresse: '11 rue de Washington, 75008 Paris',
    lignes: [
      { terme: 'Métro', valeur: 'Champs-Élysées Clemenceau' },
      { terme: 'Horaires', valeur: 'Tous les jours, 11 h à 22 h 30', confirmer: true },
      { terme: 'Sur place et à emporter', valeur: 'Retrait en 10 minutes' },
      { terme: 'Livraison', valeur: '', confirmer: true },
    ],
    commander: 'Commander ici',
    commanderLabel: 'Commander ici, à Paris Washington',
    carte: 'Voir la carte',
  },
  mur: {
    surtitre: 'Tout le réseau',
    titre: 'De Paris à La Réunion',
    lead: 'Dix restaurants relevés à ce jour, dont un annoncé. Pour chacun : ce que dit la marque, ce que l\'on sait de l\'adresse, et ce qui reste à confirmer.',
    adresse: 'Adresse',
    horaires: 'Horaires',
    commande: 'Commande en ligne',
    commandeAilleurs: 'Pas encore sur ce site',
    reunion: {
      titre: 'Deux accès chez la marque',
      acces: [
        'Le sélecteur France / La Réunion de son site.',
        'Une page de commande propre au restaurant de Saint-Denis.',
      ],
      ici: 'Sur ce site, la commande de La Réunion',
    },
  },
  suite: {
    titre: 'Le mur va s\'agrandir',
    texte: 'La marque annonce d\'autres adresses que celles peintes ici. Elles rejoindront le mur avec leur adresse et leurs horaires dès qu\'elles seront confirmées.',
    commander: 'Commander à Paris Washington',
    carte: 'Voir la carte',
  },
})
