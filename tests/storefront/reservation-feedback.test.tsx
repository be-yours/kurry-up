// @vitest-environment jsdom

/**
 * What a guest meets at the link in the thank-you e-mail.
 *
 * What is held here, because each is the kind of rule that breaks quietly:
 *
 *  1. the page tells the truth about each state — unknown link, a visit that has not
 *     happened, no answer yet, an answer that can still be changed, one that is locked;
 *  2. a score that arrives from the e-mail link is PRESELECTED and nothing is sent until
 *     the guest confirms: following a link records nothing;
 *  3. the five scores are one radio group the keyboard can move through, each with its
 *     number and its words;
 *  4. the answer is described as private, the note's version travels with it, and the
 *     establishment's own review link is offered only when the server sends one — which it
 *     does only for a 4 or a 5 — never in place of the private answer;
 *  5. the server's own refusal is shown, in its words.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  page: undefined as unknown,
  submit: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ token: 'tok-feedback-1' }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))
vi.mock('convex/react', () => ({
  useQuery: (ref: string, args: unknown) => {
    if (args === 'skip') return undefined
    return ref === 'f.getByToken' ? state.page : undefined
  },
  useMutation: () => state.submit,
}))
vi.mock('@/convex/_generated/api', () => ({
  api: {
    reservationFeedback: { getByToken: 'f.getByToken', submit: 'f.submit' },
  },
}))

const { default: FeedbackContent } =
  await import('@/app/(storefront)/reservation/feedback/[token]/_components/FeedbackContent')

const NOTICE = {
  version: 'fr-2026-10',
  label: "Votre réponse est lue par l'équipe de Chez Luigi, et par personne d'autre.",
  detail: [
    "Chez Luigi utilise votre réponse pour améliorer son service. Elle n'est jamais publiée sur son site et n'est pas transformée en note affichée publiquement.",
    'Elle est conservée avec votre réservation, 3 ans après le repas, puis supprimée.',
  ],
}

const OPEN = {
  storeName: 'Chez Luigi',
  timezone: 'Europe/Paris',
  reference: 'RES-2026-00031',
  startsAt: Date.UTC(2026, 10, 3, 18, 30),
  partySize: 2,
  open: true,
  answer: null as unknown,
  reviewUrl: null as string | null,
  commentMax: 1000,
  notice: NOTICE,
}

const ANSWER = {
  score: 5,
  comment: 'Un accueil formidable',
  answeredAt: Date.now() - 3_600_000,
  updatedAt: Date.now() - 3_600_000,
  noticeVersion: 'fr-2026-10',
  editableUntil: Date.now() + 23 * 3_600_000,
  editable: true,
}

const mounted: Array<{ root: Root; container: HTMLElement }> = []

beforeEach(() => {
  state.page = { ...OPEN }
  state.submit = vi.fn(async () => ({ score: 5, editableUntil: 0, reviewUrl: null }))
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
})

async function mount(initialScore: number | null = null): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(<FeedbackContent initialScore={initialScore} />)
  })
  return container
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const radios = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
]
const send = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].find((b) =>
    /^(Envoyer|Enregistrer) ma réponse$/.test(b.textContent?.trim() ?? ''),
  ) as HTMLButtonElement

describe('the states of the page', () => {
  it('says plainly that a link is unknown', async () => {
    state.page = null
    const container = await mount()
    expect(container.querySelector('h1')?.textContent).toBe('Lien introuvable')
    expect(container.querySelector('[role="radiogroup"]')).toBeNull()
  })

  it('says the visit has not happened yet, and offers no form', async () => {
    state.page = { ...OPEN, open: false }
    const container = await mount()
    expect(container.querySelector('h1')?.textContent).toBe('Pas encore')
    expect(container.textContent).toContain('une fois le repas terminé')
    expect(container.querySelector('[role="radiogroup"]')).toBeNull()
    expect(container.querySelector('a[href="/reservation/manage/tok-feedback-1"]')).not.toBeNull()
  })

  it('shows a skeleton while the page loads', async () => {
    state.page = undefined
    const container = await mount()
    expect(container.querySelector('h1')).toBeNull()
    expect(container.querySelector('[role="radiogroup"]')).toBeNull()
  })

  it('shows the form for a visit with no answer, naming the visit', async () => {
    const container = await mount()
    expect(container.querySelector('h1')?.textContent).toBe('Merci de votre visite')
    expect(container.textContent).toContain('Chez Luigi')
    expect(container.textContent).toContain('2 personnes')
    expect(radios(container)).toHaveLength(5)
  })
})

describe('a score that arrives from the e-mail link', () => {
  it('is preselected, and nothing is sent until the guest confirms', async () => {
    const container = await mount(4)
    const checked = radios(container).filter((r) => r.getAttribute('aria-checked') === 'true')
    expect(checked).toHaveLength(1)
    expect(checked[0]!.getAttribute('aria-label')).toBe('4 sur 5 : Bien')
    expect(state.submit).not.toHaveBeenCalled()
    expect(send(container).disabled).toBe(false)

    await click(send(container))
    expect(state.submit).toHaveBeenCalledWith({
      token: 'tok-feedback-1',
      score: 4,
      noticeVersion: 'fr-2026-10',
    })
  })

  it('is ignored when it is not a score, and then nothing can be sent', async () => {
    const container = await mount(null)
    expect(radios(container).every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(send(container).disabled).toBe(true)
    expect(container.textContent).toContain('Choisissez une note de 1 à 5')
    for (const bad of [0, 6, 99]) {
      const c = await mount(bad)
      expect(radios(c).every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true)
    }
  })
})

describe('the five scores', () => {
  it('carry their number and their words, and are one radio group', async () => {
    const container = await mount()
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe(
      'Votre note, de 1 à 5',
    )
    expect(radios(container).map((r) => r.getAttribute('aria-label'))).toEqual([
      '1 sur 5 : Très décevant',
      '2 sur 5 : Décevant',
      '3 sur 5 : Correct',
      '4 sur 5 : Bien',
      '5 sur 5 : Excellent',
    ])
    // Words on screen too: a colour or a star is never the only clue.
    expect(container.textContent).toContain('Très décevant')
    expect(container.textContent).toContain('Excellent')
  })

  it('have one tab stop, which follows the choice', async () => {
    const container = await mount(3)
    expect(radios(container).map((r) => r.tabIndex)).toEqual([-1, -1, 0, -1, -1])
    const empty = await mount(null)
    expect(radios(empty).map((r) => r.tabIndex)).toEqual([0, -1, -1, -1, -1])
  })

  it('move with the arrow keys, select as they go and wrap round', async () => {
    const container = await mount(5)
    const key = async (index: number, name: string) =>
      act(async () => {
        radios(container)[index]!.dispatchEvent(
          new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
        )
      })
    await key(4, 'ArrowRight')
    expect(radios(container)[0]!.getAttribute('aria-checked')).toBe('true')
    await key(0, 'ArrowLeft')
    expect(radios(container)[4]!.getAttribute('aria-checked')).toBe('true')
    await key(4, 'ArrowUp')
    expect(radios(container)[3]!.getAttribute('aria-checked')).toBe('true')
    await key(3, 'ArrowDown')
    expect(radios(container)[4]!.getAttribute('aria-checked')).toBe('true')
  })
})

describe('what the guest is told about their answer', () => {
  it('says it is read by the team alone, never published, and for how long it is kept', async () => {
    const container = await mount(4)
    expect(container.textContent).toContain(
      "lue par l'équipe de Chez Luigi, et par personne d'autre",
    )
    expect(container.textContent).toContain('jamais publiée sur son site')
    expect(container.textContent).toContain('3 ans après le repas')
  })

  it('takes a comment within its cap and shows how much is left', async () => {
    const container = await mount(4)
    const field = container.querySelector('textarea') as HTMLTextAreaElement
    expect(field.maxLength).toBe(1000)
    await type(field, 'Très bon accueil')
    expect(container.textContent).toContain('16 / 1000')
    await click(send(container))
    expect(state.submit).toHaveBeenCalledWith({
      token: 'tok-feedback-1',
      score: 4,
      comment: 'Très bon accueil',
      noticeVersion: 'fr-2026-10',
    })
  })

  it('shows the server’s own sentence when it refuses, and keeps the form', async () => {
    state.submit = vi.fn(async () => {
      throw {
        data: { code: 'feedback_locked', message: 'Votre réponse ne peut plus être modifiée.' },
      }
    })
    const container = await mount(4)
    await click(send(container))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'ne peut plus être modifiée',
    )
    expect(radios(container)).toHaveLength(5)
  })
})

describe('an answer that was given', () => {
  it('is shown back, with when it can still be changed and which note was read', async () => {
    state.page = { ...OPEN, answer: ANSWER }
    const container = await mount()
    expect(container.querySelector('h1')?.textContent).toBe('Votre réponse')
    expect(container.textContent).toContain('5 sur 5')
    expect(container.textContent).toContain('Un accueil formidable')
    expect(container.textContent).toContain("Vous pouvez la modifier jusqu'au")
    expect(container.textContent).toContain('Note lue : version « fr-2026-10 »')
    expect(
      [...container.querySelectorAll('button')].some(
        (b) => b.textContent === 'Modifier ma réponse',
      ),
    ).toBe(true)
  })

  it('can be changed within the day: the form comes back filled', async () => {
    state.page = { ...OPEN, answer: ANSWER }
    const container = await mount()
    await click(
      [...container.querySelectorAll('button')].find(
        (b) => b.textContent === 'Modifier ma réponse',
      )!,
    )
    expect(container.querySelector('h1')?.textContent).toBe('Modifier ma réponse')
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'Un accueil formidable',
    )
    expect(radios(container)[4]!.getAttribute('aria-checked')).toBe('true')
    await click(radios(container)[2]!)
    await click(send(container))
    expect(state.submit).toHaveBeenCalledWith({
      token: 'tok-feedback-1',
      score: 3,
      comment: 'Un accueil formidable',
      noticeVersion: 'fr-2026-10',
    })
  })

  it('is locked after 24 hours: shown, with no way to change it', async () => {
    state.page = { ...OPEN, answer: { ...ANSWER, editable: false } }
    const container = await mount()
    expect(container.textContent).toContain('Elle ne peut plus être modifiée')
    expect(
      [...container.querySelectorAll('button')].some(
        (b) => b.textContent === 'Modifier ma réponse',
      ),
    ).toBe(false)
  })

  it('says when it was reworded', async () => {
    state.page = {
      ...OPEN,
      answer: { ...ANSWER, updatedAt: ANSWER.answeredAt + 20 * 60_000 },
    }
    const container = await mount()
    expect(container.textContent).toContain('Modifiée le')
  })
})

describe('the establishment’s own review page', () => {
  it('is offered only when the server sent one, as an optional link that opens in a new tab', async () => {
    state.page = { ...OPEN, answer: ANSWER, reviewUrl: 'https://g.page/r/chez-luigi/review' }
    const container = await mount()
    const link = container.querySelector('a[href="https://g.page/r/chez-luigi/review"]')!
    expect(link.textContent).toContain('Laisser un avis public')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(container.textContent).toContain('Facultatif')
    // The private answer is said to stand in any case.
    expect(container.textContent).toContain("reste lue par l'équipe dans tous les cas")
  })

  it('is never offered without one: a low score is read the same and is offered nothing', async () => {
    state.page = { ...OPEN, answer: { ...ANSWER, score: 2 }, reviewUrl: null }
    const container = await mount()
    expect(container.querySelector('a[href^="https://"]')).toBeNull()
    expect(container.textContent).not.toContain('avis public')
    expect(container.textContent).not.toContain('Facultatif')
    expect(container.textContent).toContain('2 sur 5')
  })

  it('is not offered before an answer exists', async () => {
    state.page = { ...OPEN, reviewUrl: 'https://g.page/r/chez-luigi/review' }
    const container = await mount(5)
    expect(container.querySelector('a[href="https://g.page/r/chez-luigi/review"]')).toBeNull()
  })
})
