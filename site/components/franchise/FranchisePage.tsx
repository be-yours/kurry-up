/**
 * /franchise, « Ouvrir un Kurry Up ». CLIENT ZONE. Owner: agent « réseau + franchise ».
 * Contract: site/ART_DIRECTION.md § 14. Styles: site/pages/franchise.css (`.ky-fr*`), primitives of shared.css.
 *
 * Linked from the FOOTER only (site/routes.ts + the CMS footer column); never from the header, never from a
 * customer page. Same grammar as the rest of the site: a head on a green field painted at load, the story in
 * painted years, the brand's arguments on sage and ochre fields (painted numbers only where the number is
 * sourced), what is unknown on cream slabs marked « À confirmer », the demo form on a cream field.
 * NO AMOUNT anywhere.
 */
import type { CSSProperties } from 'react'

import { FR } from './copy'
import { FranchiseForm } from './FranchiseForm'

function AConfirmer() {
  return <span className="ky-fr-confirmer">{FR.confirmer}</span>
}

/* One paint per year, never twice the same side by side; no orange (the head's button is the screen's orange). */
const PASSES = ['sauge', 'ocre', 'vert'] as const

const i = (n: number) => ({ '--i': n }) as CSSProperties

export function FranchisePage() {
  const a = FR.arguments
  return (
    <div className="ky-fr ky-sous-entete">
      {/* ── Tête : un aplat vert peint au chargement ── */}
      <header className="ky-champ ky-champ--vert ky-passe--charge ky-fr-tete" style={{ '--ky-d': '80ms' } as CSSProperties}>
        <div className="ky-fr-tete__grille">
          <p className="ky-surtitre">{FR.tete.surtitre}</p>
          <h1 className="ky-titre ky-titre--xl ky-fr-tete__titre">{FR.tete.titre}</h1>
          <p className="ky-lead ky-fr-tete__lead">{FR.tete.lead}</p>
          <div className="ky-fr-actions">
            <a className="ky-btn" href="#candidature">
              {FR.tete.candidater}
            </a>
            <a className="ky-lien" href="#a-confirmer">
              {FR.tete.savoir}
            </a>
          </div>
        </div>
      </header>

      {/* ── L'histoire du concept, en années peintes ── */}
      <section className="ky-mur ky-fr-histoire" aria-labelledby="ky-fr-histoire-titre">
        <div className="ky-jet ky-fr-section-tete">
          <p className="ky-surtitre" style={i(0)}>
            {FR.histoire.surtitre}
          </p>
          <h2 id="ky-fr-histoire-titre" className="ky-titre ky-titre--l" style={i(1)}>
            {FR.histoire.titre}
          </h2>
        </div>
        <ol className="ky-fr-dates">
          {FR.histoire.dates.map((d, n) => (
            <li key={d.annee} className="ky-fr-date">
              <p className="ky-chiffre ky-chiffre--m ky-fr-date__annee">
                <span className={`ky-passe ky-passe--${PASSES[n % PASSES.length]} ky-fr-date__passe`}>{d.annee}</span>
              </p>
              <h3 className="ky-fr-date__titre">{d.titre}</h3>
              <p className="ky-fr-date__texte">{d.texte}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* ── Les arguments de la marque, en aplats sauge et ocre ── */}
      <section className="ky-mur ky-fr-arguments" aria-labelledby="ky-fr-arguments-titre">
        <div className="ky-jet ky-fr-section-tete">
          <p className="ky-surtitre" style={i(0)}>
            {a.surtitre}
          </p>
          <h2 id="ky-fr-arguments-titre" className="ky-titre ky-titre--l" style={i(1)}>
            {a.titre}
          </h2>
        </div>
        <div className="ky-fr-bento">
          <article className="ky-champ ky-champ--ocre ky-fr-bloc ky-fr-bloc--extraction">
            <h3 className="ky-titre ky-titre--m">{a.extraction.titre}</h3>
            <p className="ky-fr-bloc__texte">{a.extraction.texte}</p>
          </article>

          <article className="ky-champ ky-champ--sauge ky-fr-bloc ky-fr-bloc--promesse">
            <h3 className="ky-fr-bloc__surtitre">{a.promesse.titre}</h3>
            <p className="ky-fr-chiffre">
              <span className="ky-chiffre">
                {a.promesse.retrait.nombre}
                <span className="ky-chiffre__unite">{a.promesse.retrait.unite}</span>
              </span>
              <span className="ky-fr-chiffre__texte">{a.promesse.retrait.texte}</span>
            </p>
            <p className="ky-fr-chiffre">
              <span className="ky-chiffre">
                {a.promesse.livraison.nombre}
                <span className="ky-chiffre__unite">{a.promesse.livraison.unite}</span>
              </span>
              <span className="ky-fr-chiffre__texte">{a.promesse.livraison.texte}</span>
            </p>
          </article>

          <article className="ky-champ ky-champ--vert ky-fr-bloc ky-fr-bloc--reseau">
            <h3 className="ky-fr-bloc__surtitre">{a.reseau.titre}</h3>
            <p className="ky-fr-chiffre">
              <span className="ky-chiffre ky-chiffre--m">{a.reseau.restaurants.nombre}</span>
              <span className="ky-fr-chiffre__texte">{a.reseau.restaurants.texte}</span>
            </p>
            <p className="ky-fr-chiffre">
              <span className="ky-chiffre ky-chiffre--m">{a.reseau.franchises.nombre}</span>
              <span className="ky-fr-chiffre__texte">{a.reseau.franchises.texte}</span>
            </p>
            <p className="ky-fr-bloc__source">
              {a.reseau.source} <AConfirmer />
            </p>
          </article>

          <article className="ky-champ ky-champ--ocre ky-fr-bloc ky-fr-bloc--villes">
            <h3 className="ky-titre ky-titre--m">{a.villes.titre}</h3>
            <p className="ky-fr-bloc__texte">{a.villes.texte}</p>
            <a className="ky-lien" href="/restaurants">
              {a.villes.lien}
            </a>
          </article>
        </div>
      </section>

      {/* ── Ce que l'on ne sait pas encore : des dalles crème, marquées « À confirmer » ── */}
      <section id="a-confirmer" className="ky-mur ky-fr-inconnu" aria-labelledby="ky-fr-inconnu-titre">
        <div className="ky-fr-section-tete">
          <p className="ky-surtitre">{FR.inconnu.surtitre}</p>
          <h2 id="ky-fr-inconnu-titre" className="ky-titre ky-titre--l">
            <span className="ky-passe ky-passe--sauge">{FR.inconnu.titre}</span>
          </h2>
          <p className="ky-lead">{FR.inconnu.lead}</p>
        </div>
        <dl className="ky-fr-points">
          {FR.inconnu.points.map((p) => (
            <div key={p.terme} className="ky-dalle ky-fr-point">
              <dt>{p.terme}</dt>
              <dd>
                <AConfirmer />
                <span className="ky-fr-point__texte">{p.texte}</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {/* ── La candidature : démonstration sur un aplat crème ── */}
      <section id="candidature" className="ky-champ ky-champ--creme ky-fr-candidature" aria-labelledby="ky-fr-form-titre">
        <div className="ky-fr-candidature__grille">
          <div className="ky-fr-candidature__tete">
            <p className="ky-surtitre">{FR.form.surtitre}</p>
            <h2 id="ky-fr-form-titre" className="ky-titre ky-titre--l">
              {FR.form.titre}
            </h2>
            <p className="ky-lead">{FR.form.lead}</p>
          </div>
          <FranchiseForm />
        </div>
      </section>
    </div>
  )
}
