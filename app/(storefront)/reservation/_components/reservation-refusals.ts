/**
 * What a guest is told when the server refuses a request, in plain French.
 *
 * The server throws every refusal as a `ConvexError({ code, message })` whose message is
 * already a French sentence, so that sentence wins: it can name what is missing (« Il ne
 * reste pas assez de places… »). This table is the other half — the words for a code whose
 * message did not survive the trip — and the single place the groups and the events add
 * theirs, so a page never falls back to a generic sentence for a refusal it knows.
 */

import type { ConvexErrorPayload } from '@/lib/convex-error'

const REFUSAL_SENTENCES: Readonly<Record<string, string>> = {
  group_not_offered:
    'Cet établissement ne prend pas de demande de groupe pour cette taille de groupe. Contactez-le directement pour réserver.',
  party_contact_only:
    "Cette taille de groupe ne peut pas être réservée en ligne : contactez directement l'établissement.",
  group_request_closed:
    "Cette demande n'attend plus de réponse : elle a déjà été traitée, retirée ou elle a expiré.",
  proposal_unavailable:
    "Cette proposition n'est plus valable : le délai est passé ou elle a déjà reçu une réponse.",
  payment_consent_required: 'Cochez la case qui accepte les conditions de paiement pour continuer.',
  payment_unavailable:
    "Le paiement n'est pas disponible en ce moment. Réessayez plus tard ou contactez directement l'établissement.",
  experience_unavailable: "Cet événement n'est pas en vente en ce moment.",
  experience_sold_out: 'Cet événement est complet, ou il ne reste pas assez de places.',
  consent_required: 'Cochez la case qui accepte les conditions pour continuer.',
  slot_unavailable: "Ce créneau n'est plus disponible. Choisissez un autre horaire.",
  rate_limited: 'Trop de tentatives. Patientez une minute puis réessayez.',
}

/**
 * The sentence to show for a thrown refusal: the server's own words, else this page's words
 * for the code, else `fallback` (a value that was not a `ConvexError` has nothing left to say).
 */
export function refusalSentence(payload: ConvexErrorPayload | null, fallback: string): string {
  if (payload?.message) return payload.message
  if (payload) return REFUSAL_SENTENCES[payload.code] ?? fallback
  return fallback
}

/** The codes this module has words for, so a test can hold the table against the server's list. */
export const KNOWN_REFUSAL_CODES = Object.keys(REFUSAL_SENTENCES)
