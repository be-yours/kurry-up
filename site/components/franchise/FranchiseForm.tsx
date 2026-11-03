'use client'

/**
 * The franchise application form of /franchise: a DEMONSTRATION. CLIENT ZONE. Owner: agent « réseau + franchise ».
 *
 * It validates in the browser and confirms on screen. It sends NOTHING and stores NOTHING: no fetch, no server
 * action, no storage API, no `action` attribute (submit is prevented). The values live in React state only and
 * are dropped when the visitor leaves the page or presses « Remplir à nouveau ». No money field, on purpose.
 *
 * Accessibility: native labels, `aria-invalid` + `aria-describedby` (hint and error) on each field, an error
 * summary announced on submit with links to the fields, focus on the first invalid field, and focus on the
 * confirmation heading once it shows.
 */
import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react'

import { typo } from '@/site/components/restaurants/typo'

import { FR } from './copy'

type Field = 'nom' | 'email' | 'telephone' | 'ville' | 'message' | 'accord'
type Values = { nom: string; email: string; telephone: string; ville: string; message: string; accord: boolean }
type Errors = Partial<Record<Field, string>>

const ORDER: Field[] = ['nom', 'email', 'telephone', 'ville', 'message', 'accord']
const EMPTY: Values = { nom: '', email: '', telephone: '', ville: '', message: '', accord: false }
const MESSAGE_MAX = 1000
const E = FR.form.erreurs
const C = FR.form.champs

function validate(v: Values): Errors {
  const e: Errors = {}
  if (v.nom.trim().length < 2) e.nom = E.nom
  const email = v.email.trim()
  if (!email) e.email = E.emailVide
  else if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[^\s@.]{2,}$/.test(email)) e.email = E.emailFaux
  const tel = v.telephone.replace(/[\s.\-()]/g, '')
  if (!tel) e.telephone = E.telVide
  else if (!/^(0[1-9]\d{8}|\+[1-9]\d{7,14})$/.test(tel)) e.telephone = E.telFaux
  if (v.ville.trim().length < 2) e.ville = E.ville
  if (v.message.length > MESSAGE_MAX) e.message = E.message
  if (!v.accord) e.accord = E.accord
  return e
}

export function FranchiseForm() {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const id = (f: string) => `ky-fr-${uid}-${f}`

  const [values, setValues] = useState<Values>(EMPTY)
  const [errors, setErrors] = useState<Errors>({})
  const [tried, setTried] = useState(false)
  const [done, setDone] = useState<null | { prenom: string; ville: string }>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const summaryRef = useRef<HTMLDivElement>(null)
  const thanksRef = useRef<HTMLHeadingElement>(null)

  const onChange = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target
    const checked = (e.target as HTMLInputElement).checked
    const next = { ...values, [name]: type === 'checkbox' ? checked : value } as Values
    setValues(next)
    if (tried) setErrors(validate(next))
  }

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setTried(true)
    const found = validate(values)
    setErrors(found)
    const first = ORDER.find((f) => found[f])
    if (first) {
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>(`#${id(first)}`)?.focus())
      return
    }
    setDone({ prenom: values.nom.trim().split(/\s+/)[0] ?? '', ville: values.ville.trim() })
    setValues(EMPTY)
    requestAnimationFrame(() => thanksRef.current?.focus())
  }

  const reset = () => {
    setDone(null)
    setTried(false)
    setErrors({})
    requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>(`#${id('nom')}`)?.focus())
  }

  if (done) {
    return (
      <div className="ky-fr-merci" role="status">
        <h3 ref={thanksRef} tabIndex={-1} className="ky-fr-merci__titre">
          {done.prenom ? typo(`${FR.form.merci.titre} ${done.prenom} !`) : typo(`${FR.form.merci.titre} !`)}
        </h3>
        <p>{FR.form.merci.texte.replace('{ville}', done.ville)}</p>
        <p>
          {FR.form.merci.suite} <span className="ky-fr-confirmer">{FR.confirmer}</span>
        </p>
        <button type="button" className="ky-lien ky-fr-merci__retour" onClick={reset}>
          {FR.form.merci.recommencer}
        </button>
      </div>
    )
  }

  const listed = ORDER.filter((f) => errors[f])
  const describedBy = (f: Field, hint: boolean) =>
    [hint ? id(`${f}-aide`) : null, errors[f] ? id(`${f}-erreur`) : null].filter(Boolean).join(' ') || undefined

  const text = (f: Exclude<Field, 'accord' | 'message'>, type: string, autoComplete: string, inputMode?: 'email' | 'tel') => {
    const hint = C[f].aide
    return (
      <div className="ky-fr-champ" data-invalide={errors[f] ? '' : undefined}>
        <label htmlFor={id(f)}>{C[f].label}</label>
        {hint ? (
          <p id={id(`${f}-aide`)} className="ky-fr-aide">
            {hint}
          </p>
        ) : null}
        <input
          id={id(f)}
          name={f}
          type={type}
          inputMode={inputMode}
          autoComplete={autoComplete}
          value={values[f]}
          onChange={onChange}
          aria-invalid={errors[f] ? true : undefined}
          aria-describedby={describedBy(f, Boolean(hint))}
          required
        />
        {errors[f] ? (
          <p id={id(`${f}-erreur`)} className="ky-fr-erreur">
            {errors[f]}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <form ref={formRef} className="ky-fr-form" noValidate onSubmit={onSubmit}>
      {tried && listed.length > 0 ? (
        <div ref={summaryRef} className="ky-fr-resume" role="alert">
          <p className="ky-fr-resume__titre">{E.titre}</p>
          <ul>
            {listed.map((f) => (
              <li key={f}>
                <a href={`#${id(f)}`}>{errors[f]}</a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="ky-fr-form__grille">
        {text('nom', 'text', 'name')}
        {text('email', 'email', 'email', 'email')}
        {text('telephone', 'tel', 'tel', 'tel')}
        {text('ville', 'text', 'address-level2')}

        <div className="ky-fr-champ ky-fr-champ--large" data-invalide={errors.message ? '' : undefined}>
          <label htmlFor={id('message')}>{C.message.label}</label>
          <p id={id('message-aide')} className="ky-fr-aide">
            {C.message.aide}
          </p>
          <textarea
            id={id('message')}
            name="message"
            rows={5}
            maxLength={MESSAGE_MAX + 200}
            value={values.message}
            onChange={onChange}
            aria-invalid={errors.message ? true : undefined}
            aria-describedby={describedBy('message', true)}
          />
          {errors.message ? (
            <p id={id('message-erreur')} className="ky-fr-erreur">
              {errors.message}
            </p>
          ) : null}
        </div>

        <div className="ky-fr-champ ky-fr-champ--large ky-fr-accord" data-invalide={errors.accord ? '' : undefined}>
          <input
            id={id('accord')}
            name="accord"
            type="checkbox"
            checked={values.accord}
            onChange={onChange}
            aria-invalid={errors.accord ? true : undefined}
            aria-describedby={errors.accord ? id('accord-erreur') : undefined}
          />
          <label htmlFor={id('accord')}>{C.accord.label}</label>
          {errors.accord ? (
            <p id={id('accord-erreur')} className="ky-fr-erreur">
              {errors.accord}
            </p>
          ) : null}
        </div>
      </div>

      <button type="submit" className="ky-btn ky-fr-envoyer">
        {FR.form.envoyer}
      </button>
    </form>
  )
}
