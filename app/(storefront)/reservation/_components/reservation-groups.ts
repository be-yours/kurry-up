/**
 * Large parties, as a guest meets them: which way a party goes, what a request promises
 * (little, and said plainly) and what the guest reads at each step of its life.
 *
 * Pure, so it is tested without a browser. The server owns every rule — `getPublicConfig`
 * hands over the three numbers and `reservations.create` / `requestGroup` refuse what falls
 * outside them — and this file only reads those numbers the way `routeParty` does, so the
 * page and the server cannot disagree about where a party of twelve goes.
 *
 * Nothing here says a request is confirmed, or when it will be answered: the establishment
 * decides, and a request nobody answers expires and lets the room go.
 */

import { formatMoney } from '@be-yours/convex-schema'
import { formatReservationInstant } from './reservation-format'

/** The part of `getPublicConfig` that decides where a party goes. */
export interface PartyRoutingConfig {
  maxPartySize: number
  /** Absent on a deployment older than the groups: the ordinary form takes `maxPartySize`. */
  directMax?: number
  groups?: { minSize: number; maxSize: number; reviewHours: number } | null
}

export type PartyRoute = 'direct' | 'group' | 'contact'

/** The largest party the ordinary form takes. */
export function directLimit(config: PartyRoutingConfig): number {
  return config.directMax ?? config.maxPartySize
}

/** The largest party that can be sent online at all: a request, or an ordinary booking. */
export function partyCeiling(config: PartyRoutingConfig): number {
  return config.groups ? Math.max(config.groups.maxSize, directLimit(config)) : directLimit(config)
}

/**
 * Where a party of this size goes: the ordinary form, a request the host answers, or a
 * « contactez-nous » card. Never a dead end: the last band always carries a way on.
 */
export function routeFor(partySize: number, config: PartyRoutingConfig): PartyRoute {
  if (partySize <= directLimit(config)) return 'direct'
  const groups = config.groups
  if (groups && partySize >= groups.minSize && partySize <= groups.maxSize) return 'group'
  return 'contact'
}

/**
 * The sizes the selector offers: every size up to the ceiling, then ONE more that stands
 * for « more than that » and leads to the contact card — a guest with a larger party finds
 * the way on in the selector instead of a list that stops short.
 */
export function partyOptions(config: PartyRoutingConfig): { sizes: number[]; overflow: number } {
  const ceiling = partyCeiling(config)
  return { sizes: Array.from({ length: ceiling }, (_, i) => i + 1), overflow: ceiling + 1 }
}

/** « 2 personnes », « 1 personne ». */
export const peopleWord = (n: number) => `${n} ${n === 1 ? 'personne' : 'personnes'}`

/** The review window, said the way a person says it: « 2 heures », « 2 jours ». */
export function reviewWindowWords(hours: number): string {
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} jours`
  return `${hours} ${hours === 1 ? 'heure' : 'heures'}`
}

/** « tel:+33140506070 » from whatever the establishment typed. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`
}

export function mailtoHref(email: string, subject?: string): string {
  return subject ? `mailto:${email}?subject=${encodeURIComponent(subject)}` : `mailto:${email}`
}

/* ------------------------------------------------------------------ */
/* What a request says before it is sent                               */
/* ------------------------------------------------------------------ */

/**
 * The paragraph above the request form. It says what the guest is about to do and what it
 * does NOT do: nothing is confirmed, nothing is paid, the room is held while the host reads.
 */
export function requestIntro(input: {
  storeName: string
  partySize: number
  reviewHours: number
}): string[] {
  const name = input.storeName.trim() || 'Le restaurant'
  return [
    `Pour ${peopleWord(input.partySize)}, la réservation passe par une demande : ${name} doit l'accepter avant qu'elle soit confirmée. Rien n'est confirmé quand vous l'envoyez, et rien n'est à payer.`,
    `Votre demande est gardée ${reviewWindowWords(input.reviewHours)} pendant que le restaurant la lit. Il vous répond par e-mail ; sans réponse dans ce délai, la demande expire et la place est libérée.`,
  ]
}

/* ------------------------------------------------------------------ */
/* What the guest reads once it is sent, and on the manage page         */
/* ------------------------------------------------------------------ */

/** What `getByToken` says about a group request (the part this file reads). */
export interface GroupFacts {
  state: GroupState
  requestedStartsAt: number
  reviewExpiresAt: number | null
  hostMessage: string | null
  proposal: {
    startsAt: number
    expiresAt: number
    lapsed: boolean
    note: string | null
    terms: {
      kind: string
      depositCents: number
      noShowFeeCents: number
      freeCancellationHours: number
      currency: string
      lines: string[]
    } | null
  } | null
}

export type GroupState =
  | 'review'
  | 'review_lapsed'
  | 'proposal'
  | 'proposal_lapsed'
  | 'awaiting_payment'
  | 'approved'
  | 'declined'
  | 'expired'
  | 'cancelled'
  | 'closed'

/** The title of the page for each state of a request. */
export const GROUP_HEADLINES: Readonly<Record<GroupState, string>> = {
  review: 'Demande envoyée : pas encore confirmée',
  review_lapsed: 'Le délai de réponse est dépassé',
  proposal: 'Le restaurant propose un autre horaire',
  proposal_lapsed: 'Cette proposition a expiré',
  awaiting_payment: 'Demande acceptée : il reste à régler',
  approved: 'Votre groupe est confirmé',
  declined: "Le restaurant n'a pas pu accepter votre demande",
  expired: 'Cette demande a expiré',
  cancelled: 'Cette demande est annulée',
  closed: 'Cette demande est terminée',
}

/**
 * The sentence under the title. It states what is true now and nothing the establishment
 * has not done: a pending request is « not confirmed », a lapsed one no longer holds a place.
 */
export function groupStateCopy(
  group: GroupFacts,
  context: { storeName: string; timezone: string },
): string {
  const name = context.storeName.trim() || 'le restaurant'
  const at = (instant: number) => formatReservationInstant(instant, context.timezone)
  switch (group.state) {
    case 'review':
      return group.reviewExpiresAt === null
        ? `Votre demande n'est pas confirmée : ${name} doit l'accepter. Vous recevrez sa réponse par e-mail, et ici.`
        : `Votre demande n'est pas confirmée : ${name} doit l'accepter. Vous recevrez sa réponse par e-mail, et ici. La place est gardée pour vous jusqu'au ${at(group.reviewExpiresAt)} ; sans réponse avant, la demande expire et la place est libérée.`
    case 'review_lapsed':
      return `${name} n'a pas répondu dans le délai prévu : la place n'est plus gardée pour votre groupe et la demande va être close. Contactez directement le restaurant pour savoir où elle en est.`
    case 'proposal':
      return group.proposal
        ? `Votre demande n'est pas confirmée tant que vous n'avez pas répondu. La proposition est ouverte jusqu'au ${at(group.proposal.expiresAt)}.`
        : "Votre demande n'est pas confirmée tant que vous n'avez pas répondu."
    case 'proposal_lapsed':
      return `Le délai pour répondre à la proposition est dépassé : la place n'est plus gardée pour votre groupe. Vous pouvez contacter directement ${name} ou refaire une demande.`
    case 'awaiting_payment':
      return `${name} a accepté votre demande. Elle sera confirmée dès que le règlement demandé est reçu.`
    case 'approved':
      return `${name} a confirmé votre réservation. À bientôt !`
    case 'declined':
      return `${name} n'a pas pu accepter cette demande. Vous pouvez le contacter directement ou faire une autre demande.`
    case 'expired':
      return `Cette demande a expiré sans réponse de ${name} : la place a été libérée. Vous pouvez le contacter directement ou refaire une demande.`
    case 'cancelled':
      return 'Cette demande est annulée : la place a été libérée.'
    case 'closed':
      return 'Merci de votre visite.'
  }
}

/** The states with nothing left to do online: the page offers a way on, not a button. */
export function groupNeedsWayOn(state: GroupState): boolean {
  return (
    state === 'review_lapsed' ||
    state === 'proposal_lapsed' ||
    state === 'declined' ||
    state === 'expired'
  )
}

/**
 * The payment a counter-proposal carries, in a sentence, or `null` when it carries none.
 * Said before the guest accepts: accepting leads to the payment page.
 */
export function proposalPaymentSentence(
  terms: NonNullable<GroupFacts['proposal']>['terms'],
): string | null {
  if (!terms) return null
  const money = (cents: number) => formatMoney(cents, terms.currency)
  return terms.kind === 'deposit'
    ? `Cette proposition demande un acompte de ${money(terms.depositCents)}. En l'acceptant, vous passez à la page de paiement ; la réservation est confirmée quand il est reçu.`
    : `Cette proposition demande une garantie par carte : aucun débit maintenant, et des frais d'absence de ${money(terms.noShowFeeCents)} au plus peuvent être débités en cas d'absence. En l'acceptant, vous passez à la page où enregistrer votre carte.`
}
