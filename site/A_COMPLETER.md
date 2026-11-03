# À compléter

## Seed : boutique, réglages, contacts

- Seed, boutique : une seule boutique du moteur, « Kurry Up Paris Washington » (11 rue de Washington, 75008 Paris). Les 10 autres lignes du réseau sont dans `site/components/network.ts`, avec un statut chacune.
- Seed, horaires de Paris Washington : tous les jours de 11 h à 22 h 30 (page Adresses de la marque, brief section 5). À faire confirmer par la marque : le moteur refuse les commandes hors de ces horaires.
- Seed, téléphone de la boutique et de la marque : NON trouvé. Champ vide, la page Contact le dit. Aucun numéro inventé.
- Seed, e-mail de la marque : NON trouvé (l'adresse des mentions légales du site est une boîte personnelle, non reprise). Aucun e-mail dans les réglages légaux ni sur la page Contact. Le formulaire de contact de la démo ne tient que dans la base locale (`contactMessages`), aucun e-mail n'est envoyé.
- Seed, livraison : désactivée dans le moteur (zone, frais, rayon, minimum de commande : NON trouvés ; le moteur exige des frais et un rayon). La marque annonce « livraison en 1 heure max » sur son site : à brancher quand les règles sont connues.
- Seed, paiements : espèces seulement (démo). Fournisseurs de la marque (Adyen, Stripe, LyfPay, Lunchr d'après le code de son app DOOD) : non confirmés, rien n'est affiché au client.
- Seed, TVA 10 % : valeur par défaut du moteur pour la restauration, à confirmer avec l'expert-comptable.

## Seed : carte

- Prix, carte contre catalogue : le seed reprend les prix de la carte « sur place » (section 4 du brief). Le catalogue en ligne (Shopify) diffère : poulet tikka massala 15,20 € au lieu de 15 €, plats végétariens 15,20 € au lieu de 13 €, agneau 18,20 € au lieu de 16 €. La marque doit trancher, et dire à quelle boutique la carte s'applique.
- Prix des formules et des suppléments : ils n'existent que dans le catalogue en ligne (Menu Kurry Up 14,90 €, Bowl Kurry Up 12,40 €, Sandwich à composer 10,90 €, Salade Raja et Salade Rani 10,90 €, extras 1,50 à 3 € pour une protéine, 1 € pour un légume, 0,50 € pour un topping). Ils sont repris tels quels, à confirmer.
- Choix de base des formules (1 protéine, 3 légumes, 3 toppings) : le brief ne liste que les suppléments. Les choix du seed (protéines : poulet tikka, plat du jour, samossa légumes, pakora ; légumes : haricots verts, poivrons, pommes de terre, palak, légumes du jour ; toppings : les 10 du brief) sont des choix DE DÉMO. Le moteur ne peut pas imposer « exactement 3 » : il limite à 3 au plus. Vraie liste, vraies limites, choix du naan et de la boisson du Menu Kurry Up : à confirmer.
- Composition des deux salades (Raja, Rani) : non publiée, aucune description. Règle du lundi et du vendredi pour le bowl : texte tronqué dans le brief, à relever.
- Allergènes : non publiés par la marque. Champ vide sur tous les produits : À confirmer avant toute mise en ligne.
- Halal : non trouvé, rien n'est affirmé. La carte vend de la bière indienne. Le statut halal est à demander par écrit à la marque.
- Produits sans prix de carte, laissés inactifs : fromage blanc coulis de mangue et muesli, mousse au chocolat, mangue et menthe ciselée (3,90 € au catalogue seulement). À activer si la marque les confirme.
- Produits non repris : glaces de marque tierce (5 références à 3,50 € au catalogue), riz basmati seul à 5 € (catalogue seulement, à placer dans la carte si la marque le veut).
- Noms de marques tierces remplacés par le nom commun (soda 33 cl, eau 33 cl, thé glacé, eau de coco, jus indien, cookies, pâte à tartiner chocolat noisette, bière indienne). La marque servie pour chaque boisson, et la bière (marque, vente d'alcool, âge minimum à la commande) : à confirmer.
- Orthographe : « Samossa » partout (la carte écrit aussi « Samoussa chaat »). Les noms des plats suivent la carte. « Palak paneer » : la carte décrit un curry d'épinards et de pommes de terre, sans paneer ; à confirmer. Garniture du samossa (légumes ou viande) et parfums du lassi (nature, mangue, rose, salé) : lecture de la carte, à confirmer.
- Photos : les visuels sont des illustrations générées par IA (liste dans `site/IMAGES_PRODUITS_LISTE.json`). Photos du catalogue Shopify non reprises (série 2023, droits de l'agence Comeleon à confirmer). Plusieurs plats n'ont pas de vraie photo chez la marque.

## Seed : pages, mentions légales

- Entité à afficher : la société du restaurant de Washington (KURRY UP, SIREN 838 057 065, SIRET 838 057 065 00024, 11 rue Washington 75008 Paris, créée en 2018) ou le franchiseur KURRY UP DEVELOPPEMENT (SIREN 953 463 957) : à trancher par la marque. Le seed met la première, avec la mention visible « À confirmer par la marque ».
- Hébergeur du futur site, responsable de la publication, forme juridique, capital social, numéro de TVA, médiateur de la consommation : non trouvés, laissés vides, listés comme manques par le moteur sur la page.
- Exploitant de chaque restaurant : une société par restaurant (Rennequin, Boétie, Sèze, Choiseul, Neuilly) d'après le registre. À confirmer.
- CGV et confidentialité : texte standard de démonstration, aucune condition réelle de la marque. À remplacer avant toute mise en ligne.
- Fondateurs : noms NON trouvés (« les enfants » de la famille de Mahatma). Aucun nom dans les pages.
- Illustrations : la mention « Illustrations générées par IA » est dans les mentions légales ; le crédit visible en pied de page est à poser côté composant.
- Facebook (`kurryupparis`) et Instagram (`kurryup.fr`) : relevés au brief, suivi non relevé. TikTok : non trouvé.

## Réseau (`site/components/network.ts`)

- Le site de la marque ne liste que 6 adresses, le brief ne dit pas lesquelles. Seules deux adresses sont complètes : 11 rue de Washington (8e) et 28 rue de la Boétie (8e). Rennequin (17e, « rue Rennequin ») et Choiseul (2e, « passage Choiseul ») n'ont pas de numéro. Sèze (9e), Lyon Grand Hôtel-Dieu (2e), Neuilly-sur-Seine, Rennes, La Réunion Saint-Denis, Massy et Fort-de-France (annoncé) : ville seule. Adresses complètes, codes postaux et horaires : à demander à la marque. Aucun téléphone.
- Nombre exact de restaurants : le site annonce 24 franchisés et 30 restaurants en exploitation ou en développement. À confirmer, ne jamais l'afficher sans « selon la marque ».
- Boutiques qui prennent les commandes : seule Paris Washington. Les autres, plateforme de commande (DOOD) comprise : à confirmer.

## Franchise

- Montants (droit d'entrée, redevances, investissement) : aucun affiché. Les sources se contredisent (25 000 € HT sur le site de la marque, 12 000 € HT chez l'Observatoire de la franchise) : la marque doit publier le chiffre à jour.
- Le contenu de la page Franchise n'est pas dans le seed (la page vit dans un composant de `site/`, comme pour les autres sites). Citations autorisées : « Street food indien nouvelle génération », « Ouvrez un restaurant sans extraction », « Kurry Up s'adapte aux villes, pas l'inverse ».
- Interlocuteur des candidatures : seul le franchiseur KURRY UP DEVELOPPEMENT est cité au registre. Destinataire réel du formulaire à confirmer.

## Commande, fidélité

- Contrat avec DOOD et Shopify (agence Comeleon) : état et ce qui peut être remplacé, à vérifier. Fidélité, application mobile, caisse et KDS : non trouvés.

## Pages /restaurants et /franchise (agent réseau + franchise)

- /restaurants, Paris Washington : horaires « Tous les jours, 11 h à 22 h 30 » et métro Champs-Élysées Clemenceau affichés avec « À confirmer » ; livraison affichée « À confirmer » (désactivée dans le moteur).
- /restaurants, mur des adresses : chaque restaurant autre que Washington affiche « Adresse : À confirmer » (ou « Numéro à confirmer » pour Rennequin et Choiseul), « Horaires : À confirmer » et « Commande en ligne : pas encore sur ce site ». À remplacer par les vraies fiches quand la marque les donne.
- /restaurants, La Réunion : la page présente deux accès chez la marque (le sélecteur France / La Réunion de son site, la page de commande propre au restaurant de Saint-Denis), sans lien sortant. Branchement de La Réunion sur ce site : à confirmer.
- /restaurants et /franchise : « 30 restaurants en exploitation ou en développement » et « 24 franchisés » toujours affichés avec « selon la marque » et « À confirmer ».
- /restaurants : « Neuilly-sur-Seine, aux portes de Paris » et « Massy, au sud de Paris » sont de la géographie, pas un fait de la marque ; Rennes « ouverte en octobre 2025 d'après la presse ». À relire par la marque.
- /franchise : huit points « À confirmer » (droit d'entrée, redevances, apport et investissement, local et emplacement, formation et accompagnement, contrat, délai d'ouverture, interlocuteur). Aucun montant affiché.
- /franchise : « sans extraction » repris de la page franchise de la marque, présenté comme « la marque présente un concept qui se passe de conduit d'extraction ». Conditions techniques réelles à confirmer.
- /franchise, formulaire : démonstration, rien n'est envoyé ni enregistré. Destinataire réel des candidatures (Kurry Up Développement ou une personne) et champs voulus par la marque : à confirmer.

## Chrome (en-tête, menu, pied de page)

- Logo : le logo du site est le SVG fourni par l'utilisateur (mot-symbole noir `#010000`, `public/brand/logo/kurry-up.svg`, copie dans `site/source/brand/`). À confirmer avec la marque : version claire pour fonds sombres, charte 2023, icône carrée pour le favicon. En mode sombre, `site/pages/chrome.css` le peint en crème par masque.
- Promesse du pied de page : « 10 MIN » et « 1 H », « Retrait en 10 minutes sur place, livraison en 1 heure max. » reprennent l'annonce du site de la marque. La livraison est désactivée dans la démo : zone, frais et délai réels à confirmer avant toute mise en ligne.

## La carte et la fiche plat (agent carte)

- /menu : la tête, la recherche, « Une question ? » et l'aperçu du blog gardent les textes du moteur, au vouvoiement (« Découvrez Notre Menu », « Explorez notre sélection de plats préparés avec soin », « Besoin d'aide pour votre commande ? », « Contactez-nous », « Consultez notre Blog »). Ils sont écrits en dur dans le moteur : ils se restylent, ils ne se changent pas depuis le site. À tutoyer par le moteur ou par une clé de traduction si le moteur en ouvre une.
- /menu, état vide : « Aucun plat trouvé » et « Essayez de modifier votre recherche ou vos filtres. » viennent des clés `storefront.noDishesFound` et `storefront.noDishesMessage` (« Traductions UI » de l'administration) : à tutoyer là (« Essaie de modifier ta recherche ou tes filtres. »).
- Fiche plat : la couleur de la famille derrière le nom se lit sur le chemin de la photo (`/brand/products/<slug>.webp`). Un plat sans photo prend l'orange par défaut, ou la famille active de la carte quand la fiche s'ouvre depuis /menu.

## À corriger côté moteur (hors zone client, relevé par la QA)

- Boutons « + » et cœur des cartes plats de l'accueil sans nom accessible (`components/website/meal-card.tsx`, `favorite-button.tsx`).
- Fiches produit sans `<h1>`.
- Accueil, /about, /blog : `main` vide pendant le streaming (pas de repli de chargement). Un contournement CSS ne couvre que l'accueil.
- Page de confirmation de commande : remonter en haut et placer le focus sur le titre (contournement actuel dans `site/components/chrome/checkout-scroll.ts`, à supprimer une fois le moteur corrigé).
- Images `fill` sans `sizes`, image LCP sans `loading="eager"`.
- Compteur d'étapes de « Votre création » : pas de suivi au défilement sans état côté moteur.
- Vouvoiement et tirets cadratins en dur dans des textes du moteur (pied de page newsletter, panier, checkout, contact, blog, bandeau de fermeture), espaces insécables manquantes (« Affichage : », « Trier par : », etc.).
- `/blog/<slug>` absent de `sitemap.xml`.
- 27 clés i18n françaises manquantes (avertissements console).
- `app/not-found.tsx` racine hors thème.
- Accueil sans JavaScript : clés `nav.*` brutes dans le HTML serveur et accueil vide (N6, hors zone client).
- `/store-selector` : CLS 0,07 à 0,12.
- Bandeau de fermeture : tiret cadratin et heure « 11:00 » à l'anglaise.

## Reste à décider

- Deux paires de familles voisines de même teinte sur l'accueil (agneau/biryanis à 375 px, légumes/desserts à 768 px) : voir ART_DIRECTION §11.
- Performances (LCP, INP) à mesurer sur le site déployé : toutes les mesures sont faites sur `next dev`.

## Hero vidéo de l'accueil (agent accueil)

- Film du héros tiré de la vidéo de la marque (téléchargée avec l'accord de l'utilisateur, copie dans `site/source/video/`, fichiers servis dans `public/brand/video/`) : droits à l'image à confirmer par la marque (on y voit les mains et, de dos ou flous, des membres de l'équipe ; la cliente filmée de face n'est pas reprise).
