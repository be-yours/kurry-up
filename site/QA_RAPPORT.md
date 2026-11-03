# QA Kurry Up : rapport du 2026-11-03

Serveur testé : `next dev` sur http://localhost:3500 (pas un build de production). Preuves : `Q=/private/tmp/claude-501/-Users-admin-Desktop-Dev-beyours-clients/5f05f1d7-cef9-4f2b-9ac9-24c33e92374b/scratchpad/qa` (captures par défilement dans `$Q/shots-light`, `$Q/shots-dark`, planches dans `$Q/sheets`, WebKit dans `$Q/shots-wk`).

## 0. Contrôles automatiques

- `pnpm design:check` : 2 fichiers, 6 tests passés.
- `pnpm lint` : 0 erreur, 93 avertissements (tous moteur, aucun dans `site/`).
- `pnpm typecheck` : propre (tsc app + convex, aucune sortie).
- `page-lint` complet (19 pages x 4 largeurs x clair/sombre = 152 vues, dont le produit « Menu Kurry Up ») : voir défauts 1, 2, 3, 14, 15. Un timeout (`/blog@1920d`) relancé avec `--wait=9000` : rien. Les deux articles du blog (`/blog/composer-ton-bol-en-2-minutes`, `/blog/de-mahatma-1965-a-kurry-up-2015`) : 16 vues, rien. Aucun « fg == bg » (machine peu chargée).
- Contrat des défauts vus par l'orchestrateur (point 1 de la demande) : NON REPRODUITS. À 1440x900, clair et sombre, chargement à froid (0,5 s, 1 s, 1,5 s, 3 s) : les chiffres peints « 10 MIN » et « 1 H MAX » sont en encre sur ocre (lisibles), le plat `hero/street-food.webp` s'affiche (417x468, opacité 1 dès 1 s), le badge « Retrait en 10 min, livraison en 1 h max » est lisible dans les deux modes. Preuves : `$Q/hero-light-0.png`, `$Q/hero-dark-0.png`, `$Q/cold-dark.jpg`. Aucun lien vers /franchise hors pied de page (13 pages testées).

## 1. Défauts

Gravité : B = bloquant, M = majeur, m = mineur. Aucun bloquant.

| # | Gr. | Page / largeur / mode | Défaut | Fichier probable et cause | Preuve |
|---|---|---|---|---|---|
| 1 | M | /checkout visiteur non connecté, 768 à 1920, clair et sombre | Le bouton « Se connecter » du haut sort de l'écran à droite (bord droit à 1021 px pour 768, 1791 px pour 1440, 2031 px pour 1920). La page est coupée sans barre de défilement, donc page-lint ne le voit pas. | `app/(storefront)/checkout/page.tsx:821` : rangée `flex sm:flex-row sm:items-end` autour du `<h1>` et du `SignInDialog`, le bouton prend toute la largeur du parent et pousse hors cadre. À corriger côté site : `site/pages/inner.css` §12b (largeur auto, `min-width: 0`, ou colonne). | `$Q/shots-light/checkout-1440-light-00.jpg` |
| 2 | M | /checkout visiteur, 360 à 1920, sombre | « Se connecter » (bouton dans l'encart crème du paiement espèces) : texte pêche `rgb(245,201,154)` sur fond sauge `rgb(218,223,207)`, contraste 1,13:1 (page-lint). | `site/pages/inner.css` §12b : l'encart garde le jeu crème en sombre mais le bouton prend les jetons sombres du moteur. Poser `--ky-texte` encre dans l'encart. | `$Q/sheets/checkout-1440-dark-s0.jpg` (tuile 2) |
| 3 | m | /checkout visiteur, 4 largeurs, clair et sombre | « Espèces » et « Connectez-vous pour payer en espèces » à 2,52:1 (`rgb(155,145,124)` sur `rgb(246,230,191)`). C'est l'état désactivé (exempté par WCAG) mais c'est le seul libellé qui explique pourquoi. | `site/pages/inner.css` §12b, opacité du bloc désactivé. | page-lint |
| 4 | M | Accueil, toutes largeurs, clair et sombre | 8 boutons sans nom accessible : le cœur et le « + » des 4 cartes « Les plus populaires ». Lighthouse accessibilité 94 (mobile et bureau), audit `button-name`, nœuds `div.bg-card > div.relative > div.absolute > button.h-10` (cœur) et `div.bg-card > div.p-8 > div.mt-auto > button.inline-flex` (+). La carte de /menu, elle, a les noms (« Ajouter Butter chicken au panier »). | Moteur : `components/website/favorite-button.tsx:57` (pas d'`aria-label`) et `components/website/meal-card.tsx:130` (idem, seul un Tooltip). Non corrigible depuis `site/` ; à faire remonter au moteur. | Lighthouse home mobile/bureau |
| 5 | M | Accueil, mesuré en bureau | CLS 0,516 (Lighthouse bureau) ; trace Fast 4G + CPU x4 : CLS 0,71, deux sauts du `<footer class="storefront-footer bg-primary-hover…">` à 8,6 s et 9,1 s (sections de l'accueil qui arrivent de Convex après hydratation, avec animations `ky-peint` et `pulse` non composées sur `clip-path`). Cible 0,1. Serveur de dev : à revérifier sur `pnpm build`. | `site/pages/home.css` (réserver la hauteur des sections « populaires » et « blog » avant l'arrivée des données : `min-height`/`contain-intrinsic-size`). | trace `NAVIGATION_0` (insight CLSCulprits) |
| 6 | m | Fiche produit « Menu Kurry Up » | Lighthouse CLS 1,009 (mobile) et 1,007 (bureau), alors que la trace donne 0,03 : incohérent, à revérifier en production. | `site/pages/menu.css` (fiche produit). | Lighthouse |
| 7 | m | Perf, serveur de dev, Fast 4G + CPU x4 | LCP : accueil 13,4 s, carte 9,7 s, fiche produit 8,5 s (délai de rendu 8 à 10 s, TTFB 0,3 à 2,7 s). Au-dessus de 2,5 s, mais mesuré sur `next dev` : non représentatif. À refaire sur build de production. | n/a | traces |
| 8 | m | Accueil mobile, SEO | Lighthouse mobile : `robots.txt` « non valide » (SEO 92). Bureau : SEO 100 et même fichier. Non reproduit, probablement lié au dev. | `app/robots.ts` / moteur. | Lighthouse home mobile |
| 9 | m | /menu bureau, clair | Lighthouse bureau : « POPULAIRE » (`span.bg-card/90`, 11 px gras) 2,41:1 (`#1f2a23` sur `#5b645a`). Passe à 100 en mobile : fond relevé pendant l'entrée animée de la carte, probablement un artefact. À surveiller. | `site/pages/menu.css`. | Lighthouse menu bureau |
| 10 | m | Accueil 1440 et 375, clair et sombre ; /restaurants, /franchise | Un trait de pinceau traverse la lettre F de « FRESH » (et le N de « NOS » sur /restaurants) : filet clair en clair, sombre en sombre, qui coupe le pied du F et déborde à gauche. | `site/pages/shared.css` §6 (la passe, `.ky-passe` ou pseudo-élément des titres peints) : décaler le départ du filet hors de la boîte du premier caractère. | `$Q/zoom-fresh.png` |
| 11 | M | /checkout, après « Confirmer la commande » (connecté, espèces), 1440 | La page reste défilée en bas : on voit le pied de page, la confirmation est au-dessus, hors écran. | Moteur `app/(storefront)/checkout/page.tsx` : pas de `scrollTo(0, 0)` à l'affichage de « Commande confirmée ». À poser dans `site/components/SiteEffects.tsx` (observer l'apparition du bloc de confirmation) en attendant. | `$Q/flow-confirm.jpg` |
| 12 | m | /checkout 375, clair | Le champ « Code promo » coupe son placeholder (« ENTREZ VOTR ») et le bouton « Appliquer » est écrasé. | Moteur `checkout/page.tsx` (rangée input + bouton) ; correction possible dans `site/pages/inner.css` §12b (taille du placeholder ou largeur du bouton). | `$Q/sheets/checkout-375-light-s0.jpg` (tuile 4) |
| 13 | m | /menu 375 et 390 (WebKit et Chromium), clair et sombre | Placeholder « Rechercher un plat… » coupé par le bouton « Rechercher » sur la ligne de recherche. | `site/pages/menu.css` (réduire le bouton ou passer le bouton sous le champ en dessous de 400 px). | `$Q/shots-dark/menu-375-dark-00.jpg` |
| 14 | m | /confidentialite 360, clair et sombre | page-lint « spill » : le titre « Politique de confidentialité » dépasse sa boîte de 11 px. | `site/pages/inner.css` (`overflow-wrap` / taille du `h1` des pages légales à 360 px). | page-lint |
| 15 | m | /account visiteur (formulaire de connexion), 1280, clair | « Adresse email » et « Mot de passe » 4,07:1, « Mot de passe oublié ? » 3,94:1 (sous 4,5). | `site/pages/inner.css` (jeton texte secondaire du formulaire d'auth). | page-lint |
| 16 | m | Fiches produit, toutes largeurs | Pas de `<h1>` : la hiérarchie commence à `<h2>` (le nom du produit). Les autres pages ont un seul h1. | Moteur `product-detail-client.tsx` : non corrigible depuis `site/`. | `$Q/shots-light/report.json` |
| 17 | m | Console, accueil | Avertissement Next à chaque chargement : « Image with src /brand/hero/street-food.webp has fill and parent element with invalid position. Provided static ». Aussi, côté moteur : `fill` sans `sizes` sur 6 images de l'accueil, et l'avertissement LCP sans `loading="eager"` sur `scenes/facade.webp` (/about, /blog) et `products/poulet-tikka.webp` (/menu). | `site/pages/home.css:148, 282, 289` (`position: static` sur le parent du `fill` du héros). Le reste vient du moteur. | `$Q/hero.cjs` (sortie) |
| 18 | m | Toutes pages, console | 27 clés `[i18n] Missing translation … in locale "fr"` (`nav.home`, `nav.menu`, `nav.about`, `nav.blog`, `nav.contact`, `nav.cart`, `nav.account`, `accessibility.openBox`, `accessibility.openMenu`, `accessibility.themeSystem`, `cart.boxTitle`, `cart.boxTitleFull`, `cart.itemSelected`, `cart.boxEmpty`, `cart.boxEmptyMessage`, `cart.browseMenu`, `footer.myOrders`, `footer.myFavorites`, `footer.navigation`, `footer.myAddresses`, `footer.usefulLinks`, `footer.legalNotice`, `footer.termsOfService`, `footer.privacyPolicy`, `store.openNow`, `store.closed`, `storefront.storeTempUnavailable`). L'affichage retombe sur le français en dur : aucun impact visible. | Moteur (catalogue de langue) ; le seed peut les surcharger. | `$Q/i18n.cjs` |
| 19 | m | Pages d'article du blog | Le sitemap ne liste aucun `/blog/<slug>` (les 5 articles existent : accueil et /blog les affichent). | Moteur `app/sitemap.ts` ; vérifier que le seed publie les articles. | `curl /sitemap.xml` |
| 20 | m | /product/<Menu Kurry Up>, 1440 et 375 | Le titre collant « ÉTAPE 1 SUR 5 » reste figé sur « 1 » quand on défile vers les étapes 4 et 5. | Moteur `product-detail-client.tsx` (indicateur d'étape) ; à confirmer. | `$Q/sheets/product_th7dykse41t1dq94bq3g130ets8hg9mw-1440-light-s0.jpg` |
| 21 | m | /checkout, /sign-up, /contact, tous modes | Les placeholders (« Jean Dupont », « jean@exemple.com ») sont aussi sombres que du texte saisi : on ne distingue pas un champ rempli d'un champ vide. | `site/pages/inner.css` (`::placeholder` en `--ky-texte-2`). | `$Q/shots-light/checkout-1440-light-00.jpg`, `$Q/flow-signup.jpg` |
| 22 | m | /restaurants 1440, clair | Les tuiles « Paris Rennequin » et « Saint-Denis » sont très hautes avec un grand vide orange sous le texte (bento étiré par la rangée voisine). | `site/pages/restaurants.css` (`align-items: start` sur la rangée ou `grid-auto-rows`). | `$Q/sheets/restaurants-1440-light-s0.jpg` |
| 23 | m | Visiteur, tout le site | Texte visiteur en vouvoiement ou tirets cadratins venant du seed ou du site (corrigeables, voir section 3). | `site/seed/data.mjs:417`, `site.config.ts:21`. | n/a |

## 2. Lighthouse (serveur de dev)

| Page | Mode | Access. | Bonnes pratiques | SEO | Note |
|---|---|---|---|---|---|
| / | mobile | 94 | 100 | 92 | `button-name` x8, robots.txt invalide |
| / | bureau | 94 | 100 | 100 | `button-name` x8, CLS 0,516 |
| /menu | mobile | 100 | 100 | 100 | |
| /menu | bureau | 96 | 100 | 100 | contraste « POPULAIRE » 2,41:1 |
| /restaurants | mobile et bureau | 100 | 100 | 100 | |
| /product/<Menu Kurry Up> | mobile et bureau | 100 | 100 | 100 | CLS 1,009 et 1,007 |

Traces (Fast 4G, CPU x4) : accueil LCP 13,4 s, CLS 0,71 ; carte LCP 9,7 s, CLS 0,00 ; fiche produit LCP 8,5 s, CLS 0,03. INP non mesuré (aucune interaction rejouée dans la trace). Émulation mouvement réduit + sombre sur l'accueil : page correcte (`$Q/` capture de la session devtools), zéro animation temporelle en cours et zéro animation liée au défilement avec `prefers-reduced-motion: reduce` sur /, /menu, /restaurants (30, 17 et 18 sans réduction).

## 3. Textes

### Corrigibles côté site (seed, config, CSS)
- `site/seed/data.mjs:417` : badge de l'accueil « Votre création » (vouvoiement). Devrait être « Ta création ».
- `site.config.ts:21` : `titleTemplate: "%s — Kurry Up"` fabrique un tiret cadratin dans l'onglet de l'accueil (« Kurry Up Paris Washington | Fresh Indian street food — Kurry Up »). Passer à `"%s | Kurry Up"`.
- Anglais de marque (assumé) : « FRESH INDIAN », « Fresh Indian street food in Paris » (signature du pied de page, `data.mjs:527`), `<title>` du seed (`data.mjs:524`, « Fresh Indian street food in Paris »).
- Aucun « halal », aucun montant de franchise, aucun lien /franchise hors pied de page. Les « À confirmer » de /restaurants et /franchise (8 points) correspondent à `site/A_COMPLETER.md`.

### Textes en dur du moteur (non corrigibles, listés)
Tirets cadratins :
- /menu : « 44 plats — Tout », « 5 plats — Formules » (pilule de filtre, `MenuContent.tsx`).
- /store-selector : « 11:00 — 22:30 ».
- /cgv et /mentions-legales : « RCS Paris 838 057 065 — SIREN 838057065 ».
- /confidentialite : deux cellules « — ».

Vouvoiement (échantillon, tout le pied de page et les pages moteur) :
- Pied de page : « Recevez nos offres exclusives… dans votre boîte mail », « Votre adresse email » (`components/storefront/storefront-footer.tsx:335,342,348`).
- /menu : « Découvrez notre menu », « Explorez notre sélection de plats préparés avec soin », « Besoin d'aide pour votre commande ? », « Notre équipe est disponible pour répondre à toutes vos questions », « Contactez-nous », « Consultez notre blog » (`MenuContent.tsx:527-534`).
- /contact : « Comment pouvons-nous vous aider ? » (`ContactContent.tsx:257`), « Écrivez-nous avec le formulaire, on vous répond vite. » (`ContactContent.tsx:400`), « Votre nom », « votre@email.com ».
- /blog : « Ne manquez rien », « Inscrivez-vous à notre newsletter… » (`BlogContent.tsx:232`).
- /cart : « Votre Box », « Articles dans votre panier » (`CartContent.tsx`).
- /checkout : « Finaliser commande », « Renseignez vos coordonnées », « Connectez-vous pour payer en espèces », « En validant votre commande, vous acceptez… », « Votre commande a bien été prise en compte. Vous recevrez une confirmation à … ».
- Toast fiche produit : « Veuillez sélectionner : Ta garniture ».
- /store-selector : « Sélectionnez le restaurant où vous souhaitez commander. ».
- /forgot-password : « Entrez votre adresse email… », « Vous vous souvenez ? ».
- Pages légales (CGV, mentions, confidentialité) : vouvoiement partout (normal pour du juridique, texte standard de démonstration).

Espaces insécables manquantes (espace simple avant `:`, `?`) :
- /menu : « Affichage : », « Trier par : », « Une question ? », « votre commande ? » (`MenuContent.tsx:339,392,527,531`).
- Libellé du bouton de thème : « Changer de thème (actuellement : système) » (partout).
- Panier : « TA GARNITURE: LÉGUMES » (aucun espace avant le deux-points, moteur).
- /sign-in : « Mot de passe oublié ? », « Pas encore de compte ? » ; /sign-up : « Déjà un compte ? » (sign-up affiche bien l'espace simple, à passer en insécable) ; /forgot-password : « oublié ? », « Vous vous souvenez ? ».
- /cgv : « Moyens de paiement acceptés : » et plusieurs phrases de /confidentialite.
- Le seed et les pages du site (`data.mjs`, accueil, restaurants, franchise, à-propos, blog) : aucune espace simple avant `: ; ? ! €` relevée.

## 4. Parcours (localhost, compte de test local, espèces)

Accueil, « Commander » → /menu (OK) ; carte, « Ajouter Butter chicken au panier » (OK) ; fiche Samossa : refus propre sans garniture (« Veuillez sélectionner : Ta garniture »), puis ajout avec « Légumes » (OK) ; fiche « Menu Kurry Up » composée (1 protéine, 3 légumes, 3 toppings, naan, boisson : 9 options, 14,90 €) ajoutée (OK) ; panier (3 articles, 34,80 €, OK) ; checkout connecté, espèces, confirmation « Commande confirmée ORD-2026-00002 » (OK, voir défaut 11 pour le défilement) ; page de commande et suivi (`/order/<id>?token=…` puis `/track/<token>`) corrects, clair 1440 et sombre 375. Aucun vrai paiement, console sans erreur sur tout le parcours.

Menu mobile : ouverture, focus sur « Fermer le menu », Tab reste dans le dialogue, Échap ferme et rend le focus au bouton « Ouvrir le menu », à 375 et 768 (et 1024, où la barre à burger reste en place). À 1280 : barre une rangée (logo centré, Carte et Restaurants à gauche, Notre histoire et Contact à droite, Connexion, Commander). Onglets de la carte collants sous l'en-tête à 375 et 1440 (OK). Focus visible sur 28 arrêts de Tab par page (accueil, carte, restaurants, clair et sombre) : tous ont un anneau (le champ de recherche le porte sur son enveloppe).

## 5. WebKit (Playwright `webkit`)

/, /menu, /restaurants, /franchise à 375 et 1440, clair et sombre : pas d'erreur, pas de débordement, une seule h1, mises en page correctes (animations liées au défilement ignorées sans dommage). Même avertissement `fill` que Chromium sur l'accueil.

## 6. Ce que je n'ai pas pu vérifier

- Performance de production : tout est mesuré sur `next dev`, LCP et CLS à refaire sur `pnpm build && next start` (défauts 5 à 7). INP non mesuré.
- Les pages `/order/<id>` et `/track/<token>` n'ont pas été passées au page-lint (jeton à usage unique) : seulement des captures à 1440 clair et 375 sombre. /account connecté (commandes, favoris, adresses) non repassé.
- Lighthouse en mode sombre et sur les pages /franchise, /about, /contact, /blog, articles : non lancé (accueil, carte, restaurants, fiche produit seulement).
- Safari réel et lecteur d'écran (VoiceOver) : non testés ; WebKit via Playwright uniquement.
- Contrastes sur photos et dégradés : page-lint ne juge que les fonds pleins ; je n'ai vérifié à l'œil que les étiquettes sur photos du bento (lisibles).
- Les captures de /cart et /checkout du balayage 3 largeurs utilisent un panier injecté dans le localStorage (images vides dans la liste), pas le vrai panier ; le vrai panier n'a été vu qu'à 1440 clair.
- Livraison, paiement en ligne et horaires d'ouverture de la boutique (le moteur refuse les commandes hors 11 h à 22 h 30) : hors périmètre, espèces seulement.
- Preuve du défaut 20 (étape collante) non refaite en lecture de l'état React : lecture visuelle seule.

Total : 23 défauts, 0 bloquant, 6 majeurs (1, 2, 4, 5, 11 et 6 à confirmer en prod), 17 mineurs.

---

# Tour 2 : rapport du 2026-11-03 (après correctifs, header « La façade », hero « le film peint »)

Serveur testé : `next dev` sur http://localhost:3500 (pas un build de production). Preuves : `Q2=/private/tmp/claude-501/-Users-admin-Desktop-Dev-beyours-clients/5f05f1d7-cef9-4f2b-9ac9-24c33e92374b/scratchpad/qa2` (`$Q2/lint.json` et `lint.log`, `$Q2/hdr/` en-tête 6 largeurs x 2 modes, `$Q2/menu/` menu mobile, `$Q2/hero/` film, `$Q2/shots-light` et `shots-dark` captures par défilement, `$Q2/shots-wk` et `shots-wk2` WebKit, `$Q2/sheets/` planches, `$Q2/flow/` parcours, `$Q2/zoom/` détails). Même `Q` que le tour 1 pour les anciennes preuves.

## T0. Contrôles automatiques

- `pnpm design:check` : 2 fichiers, 6 tests passés. `pnpm lint` : 0 erreur, 93 avertissements (tous moteur). `pnpm typecheck` : propre.
- `page-lint` complet (`--wait=4500`, seul sur la machine) : 20 pages x 4 largeurs x clair/sombre = 160 vues (les 18 pages fixes, la fiche « Menu Kurry Up », l'article du blog, la 404) : « Nothing reported » (`$Q2/lint.log`, `$Q2/lint.json`). Limite : page-lint coupe les animations, ne voit pas le bandeau « fermé », ni la vidéo, ni les états connecté, et ne juge pas les fonds en dégradé (82 éléments de fond inconnu sur l'accueil à 1920).
- Hydratation (« Hydration failed ») : 0 occurrence sur 120 chargements à froid (contexte neuf, cache vide, 3500 ms d'attente) : accueil 8 x 6 largeurs (375, 768, 1024, 1280, 1440, 1920) = 48 ; /menu, /restaurants, /about, /checkout 3 x 6 largeurs = 72. Aucune autre erreur console. Pas reproduit : le cas vu par l'agent suit un rebuild du thème (HMR), que je ne peux pas déclencher sans modifier un fichier ; à relancer par l'agent avec `bump-theme.mjs`. Le garde de `HeroFilm.tsx` (fibre React + `opacity` framer + repli à 5 s) est bien en place.
- Réseau : aucune requête hors localhost sur 10 pages (accueil, carte, restaurants, franchise, à-propos, contact, blog, connexion, paiement, confidentialité) ni pendant le parcours de commande. Logo et vidéo viennent de localhost. Les seuls liens externes sont Instagram et Facebook de la marque (pied de page), aucun lien kurryup.fr ni order.kurryup.fr. Aucun `href="#"`.

## T1. Statut des défauts du tour 1

| # | Statut | Preuve |
|---|---|---|
| 1 | Corrigé | « Se connecter » dans le cadre à 768 et 1440, clair et sombre : `$Q2/sheets/checkout-768.jpg`, `checkout-1440.jpg` |
| 2 | Corrigé | page-lint propre sur /checkout sombre ; bouton encre sur crème : `$Q2/sheets/checkout-375.jpg` (rangée sombre) |
| 3 | Corrigé | page-lint propre (4 largeurs, 2 modes) |
| 4 | Non corrigé (moteur) | Lighthouse accueil mobile et bureau : accessibilité 94, `button-name` x8, mêmes nœuds `div.bg-card > div.relative > div.absolute > button.h-10` (cœur) et `div.bg-card > div.p-8 > div.mt-auto > button.inline-flex` (+). Aussi à /cart un lien icône sans nom (`a.h-10.w-10.rounded-xl`) dans `$Q2/shots-light/report.json` |
| 5 | Corrigé sur l'accueil | CLS accueil : trace Fast 4G + CPU x4 = 0,00 (tour 1 : 0,71) ; Playwright cold 375 = 0,004, 1440 = 0,002. Mais voir N1 (la carte et la fiche produit) |
| 6 | Non corrigé | Lighthouse fiche produit mobile : CLS 1,028 ; cause trouvée, voir N1 |
| 7 | Non vérifiable (dev) | Trace Fast 4G + CPU x4 sur `next dev` : LCP accueil 18,3 s (délai de rendu 16,3 s), carte 9,1 s, restaurants 4,9 s. Au-dessus de 2,5 s mais dev ; à refaire sur `pnpm build && next start` |
| 8 | Corrigé (non reproduit) | Lighthouse accueil mobile : SEO 100, robots.txt valide |
| 9 | Non corrigé | Lighthouse /menu bureau : accessibilité 96, « POPULAIRE » (`div.storefront-menu-photo > div.absolute > span.bg-card/90`) 1,76:1 (`#c2bba9` sur `#fef5df`) pendant le fondu d'entrée ; une fois posé : `rgb(55,55,55)` sur `rgb(255,249,236)` (largement > 4,5). Artefact d'animation mais l'audit Lighthouse l'attrape encore. `site/pages/menu.css` : ne pas animer l'opacité du badge |
| 10 | Corrigé | Aucun filet sur le F de « FRESH » ni le N de « NOS » : `$Q2/zoom/home-h1-1440-light.png`, `rest-h1-375-light.png` |
| 11 | Corrigé | Après « Confirmer la commande » (espèces, compte de test) : `scrollY` 1238 avant, 0 après ; focus sur le `h1` « COMMANDE CONFIRMÉE » : `$Q2/flow/confirm-1440.png` |
| 12 | Corrigé | « ENTREZ VOTRE CODE » entier, bouton « APPLIQUER » lisible à 375 : `$Q2/sheets/checkout-375.jpg` |
| 13 | Corrigé | Placeholder « Rechercher un plat… » entier à 375, clair et sombre (bouton sous le champ) : `$Q2/sheets/menu-375.jpg`. WebKit idem |
| 14 | Corrigé | page-lint propre sur /confidentialite à 360 |
| 15 | Corrigé | page-lint propre sur /account à 1280 |
| 16 | Non corrigé (moteur) | Fiche produit : 0 `h1` (`$Q2/shots-light/report.json`, `product_…-375-light`) |
| 17 | Corrigé pour l'accueil, reste moteur | Console de l'accueil vide (plus d'avertissement `fill` du héros). Restent côté moteur : LCP sans `loading="eager"` sur `/brand/scenes/facade.webp` (/about, /blog) et `/brand/products/poulet-tikka.webp` (/menu) |
| 18 | Non corrigé (moteur) | 24 clés `[i18n] Missing translation` (tour 1 : 27) ; et les clés brutes `nav.menu`, `nav.about`, `nav.contact` sont dans le HTML serveur (voir N6) |
| 19 | Corrigé | `sitemap.xml` liste les 6 articles du blog |
| 20 | Non corrigé | Fiche « Menu Kurry Up » 1440 : « ÉTAPE 1 SUR 5 » reste figé alors que les étapes 3, 4 et 5 défilent : `$Q2/sheets/product_th7dykse41t1dq94bq3g130ets8hg9mw-1440.jpg` (tuiles 2 à 4) |
| 21 | Corrigé | Placeholders gris sur /checkout, /sign-in, /sign-up, /contact, clair et sombre |
| 22 | Corrigé | Tuiles /restaurants à hauteur de leur contenu à 1440 : `$Q2/sheets/restaurants-1440.jpg` |
| 23 | Corrigé pour le site, reste moteur | « Ta création » (badge accueil et seed) ; `titleTemplate` `"%s \| Kurry Up"` sans tiret cadratin. Reste moteur : « 44 plats — Tout » (/menu), « 11:00 — 22:30 » (/store-selector), deux « — » dans /confidentialite, vouvoiement du pied de page, des pages /menu, /contact, /blog, /cart, /checkout, espaces simples avant `:` et `?` (« Affichage : », « Trier par : », « Changer de thème (actuellement : … ») |

Titres d'onglet (HTML serveur) : `/` « Kurry Up Paris Washington | Fresh Indian street food | Kurry Up » (redondant, voir N8) ; `/menu` « La carte | Kurry Up Paris Washington » ; `/restaurants` « Nos restaurants | Kurry Up » ; `/franchise` « Ouvrir un Kurry Up | Franchise » ; `/about` « Notre histoire | Kurry Up » ; `/contact` « Contact | Kurry Up Paris Washington » ; `/blog` « Le blog | Kurry Up » ; `/confidentialite`, `/cgv`, `/mentions-legales` « … | Kurry Up » ; moteur sans suffixe : `/cart` « Votre panier », `/checkout` « Paiement » (devient « Paiement | Kurry Up » après hydratation), `/account` « Mon compte », `/store-selector` « Nos restaurants », `/sign-in`, `/sign-up`, `/forgot-password` « Kurry Up », article « Composer ton bol Kurry Up en 2 minutes ». Aucun tiret cadratin dans un titre d'onglet.

Textes du site : aucun « halal » ni montant de franchise dans le rendu (le mot n'apparaît que dans des commentaires et dans le garde du seed) ; franchise liée seulement depuis le pied de page (0 lien dans l'en-tête ni dans `main`, 10 pages) ; le badge de la franchise, de /restaurants et de /about ne contient aucune espace simple avant `: ; ? ! €` ; les « À confirmer » de /restaurants et /franchise correspondent à `site/A_COMPLETER.md` (non rouverts ce tour).

## T2. Header « La façade » (A)

- 6 largeurs (375, 768, 1024, 1280, 1440, 1920) x clair/sombre, au repos et défilé (1200 px) : barre 68 px (jusqu'à 1024) puis 84 px (dès 1280), identique au repos et défilé, aucun débordement horizontal, aucun lien franchise, console vide. Plaque sauge avec `img /brand/logo/kurry-up.svg` (chargée, 300x95 naturel, affichée 90x23 à 375, 119x28 à 768 et 1024, 145x34 dès 1280), visible en clair et en sombre ; auvent vert avec Carte / Restaurants / Notre histoire / Contact dès 1280 (ombre portée peinte, rubrique active sur passe ocre), plaque « Commander » orange à droite toujours visible. Sous 1280 : enseigne, auvent (panier, burger), plaque. Accueil et Blog absents de l'auvent, présents au menu mobile. Preuves : `$Q2/hdr/menu-<largeur>-<mode>-rest.png` et `-scrolled.png`, `$Q2/hdr/report.json`.
- Panier non vide : pastille ocre « 1 » sur l'auvent (`$Q2/flow/after-add-1440.png`) ; à 375 pastille « 1 » ou « 3 » sur l'icône (`$Q2/flow/closed-375-dark-conn.png`).
- Connecté (compte de test local créé pour l'occasion) : avatar rond crème avec initiale « Q » sur l'auvent, 44x44 (`$Q2/flow/connected-1440.png`).
- Menu mobile « le store », à 375, 768 et 1024, clair et sombre (`$Q2/menu/open-*.png`, sortie du script `menu.cjs`) : `role=dialog`, `aria-modal=true`, `aria-label="Menu"`, `aria-expanded=true` sur le burger ; le focus va sur « Fermer le menu » ; Tab et Maj+Tab restent dans le dialogue (16 Tab sans sortie) ; défilement verrouillé (`html[data-ky-menu]`, `overflow: hidden`, `scrollY` inchangé après une molette) ; Échap ferme et rend le focus au bouton « Ouvrir le menu », sans perte du défilement ; aucun lien franchise ; passes de peinture lisibles dans les deux modes ; plaque « Commander » dans la rangée du haut.
- Bandeau « fermé » (horloge simulée à 23 h 40, Europe/Paris) : texte rouge lisible sur fond opaque, en-tête descendu de 40 px, à 375, 768 et 1440, clair et sombre, connecté ou non. Défaut N2.
- Pied de page : logo complet crème (avec « INDIAN STREET FOOD ») dès 1024, mot seul en dessous, « 10 MIN » et « 1 H » ocre, lien « Ouvrir un Kurry Up » discret : `$Q2/sheets/checkout-1440.jpg`, `checkout-768.jpg`.
- Focus clavier : 16 premiers arrêts de Tab sur l'accueil à 375 et 1440, clair et sombre : tous ont un anneau (`outline` ou ombre). Le bouton pause du film a un anneau plein de 3 px (`rgb(194,74,0)`), s'active à la barre d'espace (nom accessible mis à jour, focus conservé).

## T3. Hero vidéo « le film peint » (B)

- Lecture : 375 (mp4 720), 768, 1440 et 1920 (mp4 1080), clair et sombre : `data-ky-film="joue"` dès 1,6 à 3,5 s selon la machine, fenêtre 3:2 exacte (343x229, 660x440, 493x329, 733x489), pause hors écran (`paused` vrai à 2500 px, relance au retour), bouton « Mettre la vidéo en pause » / « Relancer la vidéo » (44x44) fonctionnel, console vide (`$Q2/hero/*.png`, sortie `hero.cjs`).
- Poids réellement téléchargé : mobile `kurry-film-720.mp4` 1 012 668 octets (+ poster `.webp` 10 Ko) ; bureau, tablette et 1920 `kurry-film-1080.mp4` 2 024 730 octets (+ poster 17,9 Ko). Conforme (1 Mo et 2 Mo) ; à noter : la tablette 768 reçoit le 1080 (2 Mo).
- CLS à froid de l'accueil : 0,0045 (375), 0,0015 (768), 0,0019 (1440), 0,0010 (1920). Objectif < 0,1 tenu.
- Mouvement réduit : aucune balise `<video>`, aucune requête mp4/webm ; le plat est affiché (375 et 1440, clair et sombre). Sans JavaScript : la page est blanche (voir N6, moteur). Vidéo bloquée (requête mp4 abandonnée) : aucune vidéo, plat conservé, aucun bouton. Save-Data : aucune vidéo.
- WebKit (Playwright) 375 et 1440, clair et sombre : mp4 lu (`readyState` 4, `playsinline`), bouton pause correct, aucun débordement, CLS 0. Première passe 375 clair : erreurs Convex « Function execution timed out » (backend de dev chargé) et un `/restaurants` en timeout ; repassées seules : propres (`$Q2/shots-wk2/`). Artefact de charge.
- Contraste : titre, badge et boutons sont sur le mur (jamais sur la vidéo) ; le bouton pause est une touche crème avec icône encre sur la vidéo (lisible) ; « 10 MIN » et « 1 H MAX » en encre sur ocre, lisibles, à 375, 768, 1440 et 1920.
- 1920 : voir N5.

## T4. Parcours, WebKit, mouvement réduit, accents, Lighthouse

- Parcours de commande en espèces (compte de test local créé, aucun vrai paiement) : accueil, « Commander » de l'auvent vers /menu, « Ajouter Butter chicken au panier », pastille du panier, inscription (compte généré), panier (« 1 ARTICLE SÉLECTIONNÉ »), paiement, « Confirmer la commande » : « COMMANDE CONFIRMÉE », numéro `ORD-2026-00006`, page remontée en haut, focus sur le titre. Console : seulement `ERR_NETWORK_IO_SUSPENDED` et `WebSocket is already in CLOSING or CLOSED state` (sockets Convex coupés par les navigations de dev, sans effet visible).
- Captures 375, 768, 1440, clair et sombre, par défilement, des 12 pages demandées (/, /menu, fiche produit, /restaurants, /franchise, /checkout, /cart, /confidentialite, /sign-in, /about, /contact, /blog) : pas de débordement horizontal, un seul `h1` (sauf la fiche produit), aucune image plein écran sur téléphone ou tablette, aucun cadre cassé. Défauts relevés : N3, N4, N7, N9. Pages WebKit : /, /menu, /restaurants, /franchise, /checkout.
- Paires de familles de même couleur voisines (accueil) : à 375, « Plats d'agneau » et « Biryanis » (vert sombre, l'une sous l'autre) ; à 768, « Légumes » et « Desserts » (sauge, l'une sous l'autre, `$Q2/zoom/families-375-light.png`, `families-768-light.png`). Pas gênant : séparées par un jour de 14 px, avec photo et titre différents. Voir N9 pour la tuile « Plats de poulet » à 768.
- Accents Bungee : à line-height 1,0 à 1,02 (titres `xl` : « À PARIS », « GÉNÉRATION », « INDIEN ») ils ne mordent plus la ligne précédente (`$Q2/zoom/home-h1-1440-light.png`, `franchise-h1-1440-dark.png`). À 0,95 (titres de section) ils mordent encore : N3.
- Lighthouse (serveur de dev) : voir le tableau T5. Accessibilité 100 sur /menu mobile, /restaurants et fiche produit ; 94 sur l'accueil (défaut 4) ; 96 sur /menu bureau (défaut 9). Meilleures pratiques 100 et SEO 100 partout. Mouvement réduit + sombre émulés sur l'accueil : page correcte (le site ignore la préférence de schéma de l'OS, il reste clair tant que le bouton de thème n'est pas basculé : conforme à la conception).

## T5. Lighthouse et Core Web Vitals (dev, Fast 4G + CPU x4 pour les traces)

| Page | Mode | Access. | Bonnes prat. | SEO | Notes |
|---|---|---|---|---|---|
| / | mobile | 94 | 100 | 100 | `button-name` x8 |
| / | bureau | 94 | 100 | 100 | `button-name` x8 |
| /menu | mobile | 100 | 100 | 100 | |
| /menu | bureau | 96 | 100 | 100 | « POPULAIRE » 1,76:1 (fondu) |
| /restaurants | mobile et bureau | 100 | 100 | 100 | |
| fiche produit | mobile | 100 | 100 | 100 | CLS 1,028 |

Traces : accueil LCP 18,3 s, CLS 0,00 ; /menu LCP 9,1 s, CLS 0,56 ; /restaurants LCP 4,9 s, CLS 0,00. INP non mesuré (aucune interaction rejouée).

## T6. Nouveaux défauts

Gravité : B bloquant, M majeur, m mineur.

| # | Gr. | Page / largeur / mode | Défaut | Fichier probable et cause | Preuve |
|---|---|---|---|---|---|
| N1 | M | Fiche produit 375 (Lighthouse mobile 1,028) ; /menu en trace Fast 4G + CPU x4 (0,56) | Le pied de page saute. Fiche produit : `MAIN` passe de 583 à 812 px et `FOOTER.storefront-footer` de y = 623 à hors écran à 2,97 s (0,98). /menu : `FOOTER.storefront-footer.bg-primary-hover` à 6,3 s (0,56 ; « non-composited animation `ky-peint` », propriété `clip-path`). Accueil non touché (0,004). En local non bridé /menu = 0,018. | Pendant le chargement `main` est plus courte que l'écran : le pied est dans le premier écran puis repoussé. `site/pages/shared.css` : `.storefront-theme main { min-height: 100svh }` (ou réserver la hauteur des grilles de `menu.css`) | `$Q2/cls.cjs` (sortie), trace `NAVIGATION_0` /menu (insight CLSCulprits), Lighthouse fiche produit mobile |
| N2 | M | Accueil et /restaurants, 375 et 768, clair et sombre, boutique fermée (hors 11 h à 22 h 30) | Le bandeau « RESTAURANT ACTUELLEMENT FERMÉ » (40 px) s'ajoute à l'en-tête (68 px) : la première ligne du héros (« RETRAIT EN 10 MIN, LIVRAISON EN 1 H MAX » ; « LE MUR DES ADRESSES ») passe sous l'en-tête (accueil 375 : texte à 88 à 122 px pour un en-tête qui finit à 108 px ; seul « MAX » dépasse). OK à 1440. | `site/pages/home.css` (haut du héros) et `restaurants.css` : le `padding-top` du premier bloc ne compte que `--ky-entete-h`, pas les 40 px du bandeau ; ajouter la hauteur du bandeau via `.storefront-theme:has(> div.fixed.top-0.h-10)`. Cette case est fermée 12 h par jour, c'est l'état de la moitié des visiteurs | `$Q2/flow/closed-375-dark-conn.png`, `closed-375-light.png`, `closed-768-dark.png`, `closed2.cjs` |
| N3 | m | /franchise, /restaurants, 375 (et 768 où le titre passe à la ligne) | Les accents des titres de section (line-height 0,95) mordent la ligne précédente : le « É » de « RÉUNION » touche le « R » de « PARIS », celui de « RÉSEAU » touche « FAMILLE », l'accent de « À UN » touche « DE ». | `site/pages/shared.css` (`.ky-titre`, line-height 0,95 des titres `h2`) : passer à 1,0 comme les titres `xl` | `$Q2/zoom/reunion-x3.png`, `famille-x3.png` |
| N4 | m | /checkout visiteur, 375, sombre (clair identique) | Le libellé du bouton désactivé « CONNECTEZ-VOUS POUR CONTINUER » est plus large que sa touche de pinceau : « CO » sort à gauche (encre sombre sur fond sombre) et la flèche sort à droite. | `site/pages/inner.css` §12b (padding ou taille du libellé du bouton de paiement désactivé, retour à la ligne) | `$Q2/sheets/z-checkout-dark-btn.jpg` |
| N5 | m | Accueil 1440 et 1920 | La fenêtre du film déborde vers le bord droit : à 1920 le texte commence à x = 340 et la fenêtre finit à x = 1896 (24 px de marge à droite) ; l'en-tête, lui, est contenu entre 149 et 1800 px. Les bords gauche et droit ne s'alignent plus. | `site/pages/home.css` §1.1 (largeur de la colonne média ; plafonner la grille du héros comme l'en-tête) | `$Q2/hero/chromium-1920-light-6000.png` |
| N6 | m | Toutes pages, sans JavaScript ou lecture du HTML serveur | Le HTML serveur contient les clés brutes `nav.menu`, `nav.about`, `nav.contact`, `nav.home`, `nav.blog`, `nav.cart`, `nav.account` ; sans JS l'accueil est entièrement blanc (le conteneur du héros et les sections ont `opacity:0` écrit par framer). La description de l'« alternative statique » (§9 : le plat sans script) ne tient donc pas. | Moteur (catalogue de langue, défaut 18) et framer ; la cinématique doit être en CSS pur pour que le plat reste visible. Le seed peut surcharger les clés | `$Q2/hero/nojs-1440.png`, `curl /` |
| N7 | m | Accueil 375 et 768, clair et sombre | Le badge « RETRAIT EN 10 MIN, LIVRAISON EN 1 H MAX » laisse « MAX » seul sur la deuxième ligne à 375 (mot orphelin). | Texte du seed (`site/seed/data.mjs`) : espaces insécables entre « 1 », « H » et « MAX », ou taille du badge | `$Q2/hero/chromium-375-light-6000.png` |
| N8 | m | Titre d'onglet de l'accueil | « Kurry Up Paris Washington \| Fresh Indian street food \| Kurry Up » : « Kurry Up » trois fois. | `site/seed/data.mjs` (titre de l'accueil) ou `site.config.ts` `titleTemplate` : titre d'accueil sans le gabarit | `curl /` |
| N9 | m | Accueil 768 clair et sombre | La tuile « Plats de poulet » (rouille) a un grand vide entre la photo et le titre (la rangée voisine « Formules » est plus haute) ; « Légumes » et « Desserts » (sauge) sont l'une sous l'autre. Cosmétique. | `site/pages/home.css` (`align-self: start` ou photo en `flex: 1` dans la tuile) | `$Q2/zoom/families-768-light.png` |

## T7. Ce que je n'ai pas pu vérifier

- Le cas « Hydration failed » juste après un rebuild du thème : non reproduit (0 sur 120 chargements à froid) ; il faudrait toucher `site/theme.css` pour déclencher le HMR, ce que je n'ai pas le droit de faire.
- Performance de production : tout est mesuré sur `next dev` (LCP 4,9 à 18,3 s, CLS de la carte et de la fiche produit). À refaire sur `pnpm build && next start`. INP non mesuré.
- Lighthouse sur /franchise, /about, /contact, /blog, /checkout et en mode sombre : non lancé (accueil, carte, restaurants, fiche produit seulement).
- Safari réel, VoiceOver, appareil réel en économie d'énergie (lecture vidéo refusée) : non testés. Lecture WebKit via Playwright seulement.
- Les pages /order/<id> et /track/<token> n'ont pas été rejouées (preuves du tour 1). /account connecté non repassé.
- Le bandeau « fermé » a été simulé par l'horloge du navigateur (23 h 40) : le serveur de dev tourne à l'heure réelle (ouvert) ; la commande est donc restée possible côté simulation.
- Les crédits et droits de la vidéo (« droits à l'image à confirmer » dans `A_COMPLETER.md`) : non jugés.

Total tour 2 : 9 nouveaux défauts (2 majeurs : N1, N2 ; 7 mineurs : N3 à N9) ; défauts du tour 1 encore ouverts : 4 (majeur, moteur), 6 (fusionné avec N1), 9, 16, 18, 20 (mineurs), 23 et 17 (restes moteur), 7 non vérifiable. Corrigés : 1, 2, 3, 5 (accueil), 8, 10, 11, 12, 13, 14, 15, 17 (accueil), 19, 21, 22, 23 (site). Aucun bloquant. Ce n'est pas « zéro défaut » : Lighthouse accessibilité 100 n'est pas atteint sur l'accueil (94) et la carte bureau (96), CLS < 0,1 non tenu sur la fiche produit (1,03) et la carte (0,56 en trace bridée), LCP < 2,5 s non tenu (dev).


## Tour 3 (2026-11-03, `next dev` sur :3500)

Contrôles : `pnpm design:check` 6 tests passés, `pnpm lint` 0 erreur (93 avertissements, tous moteur), `pnpm typecheck` propre. Page-lint complet (20 pages, 4 largeurs, clair et sombre, 160 vues) : rien à signaler. Console : 0 erreur sur les 72 vues capturées. WebKit sur `/`, `/menu`, `/restaurants`, `/franchise` à 375 et 1440, clair et sombre : 0 erreur, 0 débordement.

Défauts du tour 2 : N2, N3, N4, N5, N7, N8, N9 corrigés. N1 tenu boutique ouverte, mais pas boutique fermée (voir N10).

| # | Gr. | Page / état | Défaut | Suite |
|---|---|---|---|---|
| N10 | M | `/menu` et fiche produit, boutique fermée (11 h à 22 h 30) | Le bandeau « fermé » arrive après l'hydratation et le padding du haut suivait sa présence : CLS 0,36 à 1440, 0,16 à 375 | Corrigé après le tour : les 40 px du bandeau sont réservés dès le premier rendu (`site/pages/menu.css` B.1 et D.1). Remesuré boutique fermée : `/menu` 0,032 (375), 0,063 (1440), 0,052 (768) ; fiche produit 0,011 (375), 0,006 (1440). Le reste est le déplacement de l'en-tête du moteur (0 vers 40 px). Boutique ouverte, le mur au-dessus de la tête de carte est 40 px plus haut. |

Restes moteur, inchangés : voir `A_COMPLETER.md` section « À corriger côté moteur ». Le bandeau fermé affiche « — Réouverture à 11:00 » (tiret cadratin, heure à l'anglaise).

Règles du salon vérifiées sur 18 pages : aucun « halal », aucun montant de franchise, lien /franchise seulement dans le pied de page, aucune requête hors localhost, aucun `href="#"`, aucune espace simple avant `: ; ? ! €` dans les textes du site.

Mouvement réduit sur `/` : 0 `<video>`, aucune requête mp4, aucune animation en cours, 375 et 1440, clair et sombre.

Non vérifié : confirmation de commande en espèces après le correctif de remontée (le serveur Convex refuse hors horaires, à rejouer après 11 h avec l'horloge réelle) ; Lighthouse (outil lié à Chrome, interdit ici) ; INP ; LCP de production ; Safari réel et VoiceOver ; `/order` et `/track`.
