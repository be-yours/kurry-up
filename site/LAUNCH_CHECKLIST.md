# Checklist de mise en ligne : Kurry Up (démo salon Street Food 2026)

Ce site est une démo. Rien n'est publié, aucun paiement réel, aucun envoi. Direction artistique « La Fresque » (voir `site/ART_DIRECTION.md`).

## Avant de montrer la démo

- [ ] `pnpm design:check`, `pnpm lint`, `pnpm typecheck` verts.
- [ ] Convex local lancé (3300 / 3301), seed rejoué (`node site/seed/run.mjs`), page rechargée après le seed.
- [ ] Web sur http://localhost:3500 (jamais 127.0.0.1).
- [ ] Tester la commande jusqu'à la confirmation **pendant les heures d'ouverture** (11 h à 22 h 30, horaire de la page Adresses de la marque, à confirmer) : hors horaires le moteur refuse la validation.
- [ ] Parcourir `/`, `/menu`, `/menu?category=formules`, un produit, `/restaurants`, `/store-selector`, `/about`, `/blog`, `/franchise`, `/checkout` à 375, 768 et 1440, clair et sombre.
- [ ] Mouvement réduit activé : tout reste lisible et complet.

## Règles à vérifier une dernière fois

- [ ] Aucun montant de franchise affiché (les chiffres 25 000 € HT du site de la marque et 12 000 € HT de l'Observatoire se contredisent).
- [ ] Le mot « halal » n'apparaît nulle part (non confirmé par la marque, la carte vend de la bière).
- [ ] Franchise : lien dans le pied de page seulement, jamais dans l'en-tête, aucune bannière sur l'accueil, la carte ou la commande.
- [ ] Aucun appel au site ou aux adresses de la marque (kurryup.fr, order.kurryup.fr).
- [ ] Mention visible « Illustrations générées par IA » dans le pied de page et la notice légale.

## Ce que la marque doit confirmer

Détail dans `site/A_COMPLETER.md`. Les points qui bloquent une vraie mise en ligne :

- [ ] Entité légale à afficher (Kurry Up Washington, RCS Paris 838 057 065, ou le franchiseur Kurry Up Développement), hébergeur, mentions légales, CGV, confidentialité.
- [ ] Prix de référence : la carte sur place et le catalogue en ligne ne concordent pas (ex. poulet tikka massala 15 € contre 15,20 €). Boutique à laquelle s'applique la carte.
- [ ] Logo : le SVG fourni par l'utilisateur est en place (noir). À confirmer : version claire pour fonds sombres, charte 2023, icône carrée du favicon.
- [ ] Vidéo du hero : extraite du film de la marque (kurryup.fr), retravaillée. Droits d'utilisation et droit à l'image des personnes filmées à confirmer par la marque.
- [ ] Téléphone et e-mail de la marque (aucun trouvé, l'adresse de contact des mentions légales est une adresse personnelle non reprise).
- [ ] Liste complète des restaurants (adresses, horaires, téléphones) : seules 2 adresses complètes dans cette démo (Washington, Boétie), le reste est marqué « À confirmer ». Nombre de restaurants et de franchisés à confirmer.
- [ ] Zone, frais et minimum de livraison (la livraison est désactivée dans la démo).
- [ ] Allergènes (non publiés).
- [ ] Statut halal (alcool servi).
- [ ] Compositions des formules (le moteur limite à « jusqu'à 3 », pas « exactement 3 ») et règles du lundi et du vendredi du bowl.
- [ ] Moyens de paiement affichés, contrat DOOD et Shopify (Comeleon) : ce qui peut être remplacé.
- [ ] Photos réelles à la place des illustrations (plusieurs plats n'ont pas de visuel chez la marque).

## Avant toute vraie mise en ligne

- [ ] Brancher la réception du formulaire de contact et du formulaire franchise (destinataire + mention RGPD) : aujourd'hui le contact écrit dans la base locale et la franchise n'envoie rien.
- [ ] Faire corriger côté moteur : vouvoiement en dur (carte, newsletter, pages de compte), tirets cadratins du bandeau fermé, clés i18n, 404 racine hors thème (`app/not-found.tsx`), noms accessibles des boutons « + » et cœur de la carte produit.
- [ ] Connecter AWS, un vrai moyen de paiement, un domaine, puis Lighthouse et Core Web Vitals sur le site déployé.
- [ ] Tester sur un vrai iPhone et un vrai Android.
- [ ] Générer la vidéo du héros si l'utilisateur le veut (non fait : solde Gateway de 10 USD requis, accord demandé).
- [ ] Rejouer une commande en espèces jusqu'à la confirmation pendant les horaires (11 h à 22 h 30) : le contournement `site/components/chrome/checkout-scroll.ts` n'a pas été rejoué après le dernier correctif, le serveur refuse hors horaires.
- [ ] Obtenir de la marque les droits d'usage de sa vidéo et les droits à l'image des personnes filmées, et la version claire du logo.
