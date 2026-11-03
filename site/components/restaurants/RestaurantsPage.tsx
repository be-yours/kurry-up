/**
 * /restaurants, « Le mur des adresses ». CLIENT ZONE. Owner: agent « réseau + franchise ».
 * Contract: site/ART_DIRECTION.md § 13. Styles: site/pages/restaurants.css (`.ky-rs*`), primitives of shared.css.
 *
 * A server component: the only client piece is the « Commander ici » link (OrderHereLink).
 * Every restaurant is a field of paint carrying its painted mark (« 17e », « LYON »), in a mosaic of varied
 * sizes; Paris Washington, the only engine establishment, has its own field with the order button. Each
 * field paints itself once as it enters (shared.css § 12.4); nothing else moves.
 */
import type { CSSProperties } from 'react'

import { NETWORK, NETWORK_STATUS_LABEL, type NetworkRestaurant } from '@/site/components/network'

import { COPY, MUR, type Tuile } from './copy'
import { OrderHereLink } from './OrderHereLink'
import { typo } from './typo'

const BY_SLUG = new Map(NETWORK.map((r) => [r.slug, r]))
const WASHINGTON = NETWORK.find((r) => r.storeSlug === 'paris-washington')

function AConfirmer({ children }: { children?: string }) {
  return <span className="ky-rs-confirmer">{children ?? COPY.confirmer}</span>
}

function Marque({ lignes, ordinal, className }: { lignes: string[]; ordinal?: string; className?: string }) {
  // The mark is a picture of the name; the name itself is the tile's heading. Its size follows its longest
  // line (`--rs-len`), so « 8 » is enormous and « FORT-DE- » still fits its tile.
  const len = Math.max(...lignes.map((l) => l.length)) + (ordinal ? 0.6 : 0)
  return (
    <p className={`ky-rs-marque ${className ?? ''}`} aria-hidden="true" style={{ '--rs-len': len } as CSSProperties}>
      {lignes.map((l, i) => (
        <span key={i} className="ky-rs-marque__ligne">
          {l}
          {ordinal && i === lignes.length - 1 ? <span className="ky-rs-ordinal">{ordinal}</span> : null}
        </span>
      ))}
    </p>
  )
}

function TuileMur({ tuile, resto }: { tuile: Tuile; resto: NetworkRestaurant }) {
  const style = {
    '--rs-lg': tuile.lg,
    '--rs-md': tuile.md,
  } as CSSProperties
  const titreId = `ky-rs-${tuile.slug}`
  const reunion = tuile.slug === 'la-reunion-saint-denis'

  return (
    <article
      className={`ky-champ ky-champ--${tuile.peinture} ky-rs-tuile`}
      data-rs-taille={tuile.grande ? 'grande' : undefined}
      data-rs-forme={tuile.bandeau ? 'bandeau' : undefined}
      aria-labelledby={titreId}
      style={style}
    >
      <p className="ky-surtitre ky-rs-statut">{typo(NETWORK_STATUS_LABEL[resto.status])}</p>
      <Marque lignes={tuile.marque} ordinal={tuile.ordinal} />
      <h3 id={titreId} className="ky-rs-nom">
        {resto.name}
        <span className="ky-rs-lieu">{resto.area}</span>
      </h3>
      <p className="ky-rs-fait">{tuile.fait}</p>

      {reunion ? (
        <div className="ky-rs-acces">
          <p className="ky-rs-acces__titre">{COPY.mur.reunion.titre}</p>
          <ol className="ky-rs-acces__liste">
            {COPY.mur.reunion.acces.map((a, i) => (
              <li key={i}>
                <span className="ky-rs-acces__rang" aria-hidden="true">
                  {i + 1}
                </span>
                {a}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <dl className="ky-rs-infos">
        <div>
          <dt>{COPY.mur.adresse}</dt>
          <dd>
            {tuile.adresse ? (
              <>
                {tuile.adresse}
                {tuile.manque ? (
                  <>
                    {' '}
                    <AConfirmer>{typo(`${tuile.manque} à confirmer`)}</AConfirmer>
                  </>
                ) : null}
              </>
            ) : (
              <AConfirmer />
            )}
          </dd>
        </div>
        <div>
          <dt>{COPY.mur.horaires}</dt>
          <dd>{resto.hours ?? <AConfirmer />}</dd>
        </div>
        <div>
          <dt>{reunion ? COPY.mur.reunion.ici : COPY.mur.commande}</dt>
          <dd>{reunion ? <AConfirmer /> : COPY.mur.commandeAilleurs}</dd>
        </div>
      </dl>
    </article>
  )
}

export function RestaurantsPage() {
  const tuiles = MUR.flatMap((t) => {
    const resto = BY_SLUG.get(t.slug)
    return resto ? [{ t, resto }] : []
  })

  return (
    <div className="ky-rs ky-sous-entete">
      {/* ── Tête : le titre sur sa passe verte, peinte au chargement, et les trois chiffres du mur ── */}
      <header className="ky-mur ky-rs-tete">
        <div className="ky-rs-tete__texte">
          <p className="ky-surtitre">{COPY.tete.surtitre}</p>
          <h1 className="ky-titre ky-titre--l ky-rs-tete__titre">
            <span className="ky-passe ky-passe--vert ky-passe--charge" style={{ '--ky-d': '120ms' } as CSSProperties}>
              {COPY.tete.titre}
            </span>
          </h1>
          <p className="ky-lead">{COPY.tete.lead}</p>
        </div>
        <ul className="ky-rs-chiffres" aria-label="Le réseau en chiffres">
          <li className="ky-rs-chiffres__grand">
            <span className="ky-chiffre">{COPY.tete.compte.nombre}</span>
            <span className="ky-rs-chiffres__texte">
              {COPY.tete.compte.texte} <AConfirmer />
            </span>
          </li>
          <li>
            <span className="ky-chiffre ky-chiffre--m ky-rs-chiffres__mot">{NETWORK.length}</span>
            <span className="ky-rs-chiffres__texte">{COPY.tete.mur.texte}</span>
          </li>
          <li>
            <span className="ky-chiffre ky-chiffre--m ky-rs-chiffres__mot">{COPY.tete.ici.nombre}</span>
            <span className="ky-rs-chiffres__texte">{COPY.tete.ici.texte}</span>
          </li>
        </ul>
      </header>

      {/* ── Paris Washington : la seule adresse qui prend la commande sur ce site ── */}
      {WASHINGTON ? (
        <section className="ky-champ ky-champ--vert ky-rs-ici" aria-labelledby="ky-rs-ici-titre">
          <div className="ky-rs-ici__grille">
            <Marque lignes={['8']} ordinal="e" className="ky-rs-ici__marque" />
            <div className="ky-rs-ici__texte">
              <p className="ky-surtitre">{COPY.ici.surtitre}</p>
              <h2 id="ky-rs-ici-titre" className="ky-titre ky-titre--l">
                {COPY.ici.nom}
              </h2>
              <p className="ky-lead ky-rs-ici__adresse">{COPY.ici.adresse}</p>
              <dl className="ky-rs-infos ky-rs-infos--ici">
                {COPY.ici.lignes.map((l) => (
                  <div key={l.terme}>
                    <dt>{l.terme}</dt>
                    <dd>
                      {l.valeur}
                      {l.confirmer ? (
                        <>
                          {l.valeur ? ' ' : null}
                          <AConfirmer />
                        </>
                      ) : null}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="ky-rs-actions">
                <OrderHereLink storeSlug="paris-washington" className="ky-btn" aria-label={COPY.ici.commanderLabel}>
                  {COPY.ici.commander}
                </OrderHereLink>
                <a className="ky-lien" href="/menu">
                  {COPY.ici.carte}
                </a>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {/* ── Le mur : un aplat par restaurant, en mosaïque ── */}
      <section className="ky-mur ky-rs-reseau" aria-labelledby="ky-rs-mur-titre">
        <div className="ky-jet ky-rs-reseau__tete">
          <p className="ky-surtitre" style={{ '--i': 0 } as CSSProperties}>
            {COPY.mur.surtitre}
          </p>
          <h2 id="ky-rs-mur-titre" className="ky-titre ky-titre--l" style={{ '--i': 1 } as CSSProperties}>
            {COPY.mur.titre}
          </h2>
          <p className="ky-lead" style={{ '--i': 2 } as CSSProperties}>
            {COPY.mur.lead}
          </p>
        </div>
        <div className="ky-rs-mosaique">
          {tuiles.map(({ t, resto }) => (
            <TuileMur key={t.slug} tuile={t} resto={resto} />
          ))}
        </div>
      </section>

      {/* ── La suite : ce qui manque, et la commande ── */}
      <section className="ky-champ ky-champ--ocre ky-rs-suite" aria-labelledby="ky-rs-suite-titre">
        <div className="ky-rs-suite__grille">
          <h2 id="ky-rs-suite-titre" className="ky-titre ky-titre--m">
            {COPY.suite.titre}
          </h2>
          <p className="ky-rs-suite__texte">
            {COPY.suite.texte} <AConfirmer />
          </p>
          <div className="ky-rs-actions">
            <OrderHereLink storeSlug="paris-washington" className="ky-btn">
              {COPY.suite.commander}
            </OrderHereLink>
            <a className="ky-lien" href="/menu">
              {COPY.suite.carte}
            </a>
          </div>
        </div>
      </section>
    </div>
  )
}
