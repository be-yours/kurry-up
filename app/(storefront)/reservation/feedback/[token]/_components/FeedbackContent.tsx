'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useRef, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { CheckCircle2, Clock, Star, XCircle } from 'lucide-react'
import {
  FEEDBACK_SCORES,
  FEEDBACK_SCORE_LABELS,
  frenchOrdinalDay,
  type FeedbackScore,
} from '@be-yours/convex-schema'
import { Button, Label, Skeleton, Textarea } from '@be-yours/ui'
import { api } from '@/convex/_generated/api'
import { convexErrorPayload } from '@/lib/convex-error'
import { formatReservationInstant } from '../../../_components/reservation-format'

const people = (n: number) => `${n} ${n === 1 ? 'personne' : 'personnes'}`

/** « jeudi 5 novembre, 14:30 » — when the answer stops being editable. */
function until(at: number, timezone: string): string {
  return frenchOrdinalDay(
    new Intl.DateTimeFormat('fr-FR', {
      timeZone: timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(at)),
  )
}

/**
 * The guest's satisfaction page.
 *
 * Five things can be true and the page says which, in words: the link is unknown, the
 * visit has not happened yet, there is no answer yet, the answer can still be changed, or
 * it is locked. It promises nothing the server does not hold: the answer is private to the
 * restaurant (nothing here, or anywhere on the site, shows it to anybody else), it can be
 * changed for 24 hours from the first time it was given, and the establishment's own
 * review page is offered after a 4 or a 5 and never in place of the private answer.
 */
export default function FeedbackContent({ initialScore }: { initialScore: number | null }) {
  const { token } = useParams<{ token: string }>()
  const page = useQuery(api.reservationFeedback.getByToken, { token })
  const submit = useMutation(api.reservationFeedback.submit)

  const [score, setScore] = useState<FeedbackScore | null>(
    initialScore !== null && initialScore >= 1 && initialScore <= 5
      ? (initialScore as FeedbackScore)
      : null,
  )
  const [comment, setComment] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  // What the server answered to the last submit: the review link belongs to that answer.
  const [justSent, setJustSent] = useState(false)

  if (page === undefined) {
    return (
      <Shell>
        <Skeleton className="mb-4 h-10 w-64" />
        <Skeleton className="h-48 w-full rounded-2xl" />
      </Shell>
    )
  }

  if (page === null) {
    return (
      <Shell>
        <XCircle className="mb-6 h-12 w-12 text-muted-foreground" aria-hidden="true" />
        <h1 className="mb-3 text-3xl font-bold text-foreground">Lien introuvable</h1>
        <p className="mb-8 text-muted-foreground">
          Ce lien n&apos;est plus valide : la réservation a pu être supprimée.
        </p>
        <Link href="/" className="font-semibold text-foreground underline underline-offset-4">
          Retour à l&apos;accueil
        </Link>
      </Shell>
    )
  }

  if (!page.open) {
    return (
      <Shell>
        <Clock className="mb-6 h-12 w-12 text-muted-foreground" aria-hidden="true" />
        <h1 className="mb-3 text-3xl font-bold text-foreground">Pas encore</h1>
        <p className="mb-8 text-muted-foreground">
          Vous pourrez donner votre avis sur {page.storeName || 'le restaurant'} une fois le repas
          terminé. Ce lien ne fonctionne pas avant.
        </p>
        <Link
          href={`/reservation/manage/${token}`}
          className="font-semibold text-foreground underline underline-offset-4"
        >
          Voir ma réservation
        </Link>
      </Shell>
    )
  }

  const answer = page.answer
  const showForm = answer === null || (editing && answer.editable)
  const currentScore: FeedbackScore | null =
    score ?? (answer ? (answer.score as FeedbackScore) : null)
  const text = comment ?? answer?.comment ?? ''

  async function send() {
    if (currentScore === null || busy) return
    setBusy(true)
    setError(null)
    try {
      await submit({
        token,
        score: currentScore,
        ...(text.trim() ? { comment: text.trim() } : {}),
        noticeVersion: page!.notice.version,
      })
      setEditing(false)
      setComment(null)
      setScore(null)
      setJustSent(true)
    } catch (failure) {
      setError(
        convexErrorPayload(failure)?.message ??
          "Votre réponse n'a pas pu être enregistrée. Veuillez réessayer.",
      )
    } finally {
      setBusy(false)
    }
  }

  if (!showForm && answer) {
    return (
      <Shell>
        <div role="status" className="rounded-2xl bg-card p-8">
          <CheckCircle2 className="mb-4 h-10 w-10 text-foreground" aria-hidden="true" />
          <h1 className="mb-2 text-3xl font-bold text-foreground">
            {justSent ? 'Merci pour votre réponse' : 'Votre réponse'}
          </h1>
          <p className="mb-1 text-foreground">
            Vous avez donné <strong>{answer.score} sur 5</strong> (
            {FEEDBACK_SCORE_LABELS[answer.score as FeedbackScore]}).
          </p>
          {answer.comment && (
            <p className="mt-2 whitespace-pre-line rounded-xl bg-background p-4 text-sm text-foreground">
              {answer.comment}
            </p>
          )}
          {answer.updatedAt > answer.answeredAt && (
            <p className="mt-2 text-sm text-muted-foreground">
              Modifiée le {until(answer.updatedAt, page.timezone)}.
            </p>
          )}
          <p className="mt-4 text-sm text-muted-foreground">
            {page.notice.label}{' '}
            {answer.editable
              ? `Vous pouvez la modifier jusqu'au ${until(answer.editableUntil, page.timezone)}.`
              : 'Elle ne peut plus être modifiée : le délai de 24 heures est passé.'}
            {answer.noticeVersion ? ` Note lue : version « ${answer.noticeVersion} ».` : ''}
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-4">
            {answer.editable && (
              <Button
                variant="outline"
                className="h-11 rounded-xl"
                onClick={() => {
                  setScore(answer.score as FeedbackScore)
                  setComment(answer.comment)
                  setEditing(true)
                  setJustSent(false)
                }}
              >
                Modifier ma réponse
              </Button>
            )}
            {page.reviewUrl && (
              <a
                href={page.reviewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-foreground underline underline-offset-4"
              >
                Laisser un avis public
                <span className="sr-only"> (s&apos;ouvre dans un nouvel onglet)</span>
              </a>
            )}
          </div>
          {page.reviewUrl && (
            <p className="mt-3 text-sm text-muted-foreground">
              Facultatif : vous pouvez aussi partager votre avis sur la page publique de{' '}
              {page.storeName || 'le restaurant'}. Votre réponse ci-dessus reste lue par
              l&apos;équipe dans tous les cas.
            </p>
          )}
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {page.storeName}
      </p>
      <h1 className="mb-2 text-3xl font-bold text-foreground">
        {answer ? 'Modifier ma réponse' : 'Merci de votre visite'}
      </h1>
      <p className="mb-6 text-foreground">
        Comment s&apos;est passée votre visite ?{' '}
        {formatReservationInstant(page.startsAt, page.timezone)} · {people(page.partySize)}
      </p>

      {error && (
        <p
          role="alert"
          className="mb-6 rounded-xl bg-destructive/10 p-4 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}

      <form
        className="space-y-6 rounded-2xl bg-card p-5"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <ScorePicker value={currentScore} onChange={setScore} />

        <div className="space-y-2">
          <Label htmlFor="feedback-comment">Un mot à ajouter ? (facultatif)</Label>
          <Textarea
            id="feedback-comment"
            rows={4}
            maxLength={page.commentMax}
            value={text}
            onChange={(e) => setComment(e.target.value)}
            aria-describedby="feedback-comment-count"
          />
          <p id="feedback-comment-count" className="text-right text-xs text-muted-foreground">
            {text.length} / {page.commentMax}
          </p>
        </div>

        <div className="space-y-2 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">{page.notice.label}</p>
          {page.notice.detail.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            className="h-12 rounded-xl"
            disabled={currentScore === null || busy}
          >
            {busy ? 'Envoi…' : answer ? 'Enregistrer ma réponse' : 'Envoyer ma réponse'}
          </Button>
          {answer && (
            <Button
              type="button"
              variant="outline"
              className="h-12 rounded-xl"
              disabled={busy}
              onClick={() => {
                setEditing(false)
                setScore(null)
                setComment(null)
                setError(null)
              }}
            >
              Annuler
            </Button>
          )}
        </div>
        {currentScore === null && (
          <p className="text-sm text-muted-foreground">
            Choisissez une note de 1 à 5 pour continuer.
          </p>
        )}
      </form>
    </Shell>
  )
}

/**
 * Five scores as one choice: a radio group in the way of the keyboard (arrows move and
 * select, one tab stop), each with its number AND its words, so nothing rests on colour
 * or on a star's shape.
 */
function ScorePicker({
  value,
  onChange,
}: {
  value: FeedbackScore | null
  onChange: (score: FeedbackScore) => void
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const select = (score: FeedbackScore, focus = false) => {
    onChange(score)
    if (focus) refs.current[score - 1]?.focus()
  }
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium text-foreground">Votre note, de 1 à 5</legend>
      <div role="radiogroup" aria-label="Votre note, de 1 à 5" className="grid grid-cols-5 gap-2">
        {FEEDBACK_SCORES.map((score, index) => {
          const checked = value === score
          return (
            <button
              key={score}
              ref={(el) => {
                refs.current[index] = el
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={`${score} sur 5 : ${FEEDBACK_SCORE_LABELS[score]}`}
              tabIndex={checked || (value === null && index === 0) ? 0 : -1}
              onClick={() => select(score)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                  event.preventDefault()
                  select(FEEDBACK_SCORES[(index + 1) % 5]!, true)
                } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  select(FEEDBACK_SCORES[(index + 4) % 5]!, true)
                }
              }}
              className={
                'flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border-2 px-1 py-2 text-center transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring ' +
                (checked
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border bg-background text-foreground hover:border-foreground')
              }
            >
              <span className="flex items-center gap-1 text-xl font-bold">
                {score}
                <Star
                  className="h-4 w-4"
                  aria-hidden="true"
                  fill={checked ? 'currentColor' : 'none'}
                />
              </span>
              <span className="text-[11px] leading-tight">{FEEDBACK_SCORE_LABELS[score]}</span>
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-xl px-4 pb-12 pt-32 sm:pb-16">{children}</div>
}
