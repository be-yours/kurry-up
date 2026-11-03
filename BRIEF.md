# 07. Kurry Up (rang 7)

Brief de création de site, relevé le 2026-11-01. Marque seule (franchise et multi-boutiques plus tard). Tout ce qui n'est pas confirmé est marqué « non trouvé » ou « non confirmé ».

## 0. Projet

- Slug : `kurry-up`
- Site actuel : https://kurryup.fr (Shopify, thème « troopthemes », apps Klaviyo et PowerfulForm, GTM ; mis en place par l'agence Comeleon d'après le pied de page ; sélecteur France / La Réunion). Pages : /pages/carte, /pages/adresses, /pages/qui-sommes-nous, /pages/franchise, /pages/contact, /pages/on-recrute, /policies/legal-notice, /policies/privacy-policy, /policies/terms-of-service.
- Outil de commande actuel : **deux systèmes en parallèle**. (1) Bouton « Commander » vers https://order.kurryup.fr/ (et https://order.kurryup.fr/fr/shops?setDistributionMode=click-and-collect) : application Angular de la plateforme DOOD (d'après g2 : appels à api.dood.com, paiements Adyen / Stripe / LyfPay / Lunchr, intégration Deliverect). La Réunion : https://order-lareunion.kurryup.fr/fr/shops/street-food/kurry-up-st-denis. (2) Un catalogue produits et un panier Shopify sur le même domaine (https://kurryup.fr/products.json liste 60 produits, https://kurryup.fr/cart).
- Dossiers de `/Users/admin/Desktop/Dev/agence/beyours-boilerplate/templates/` (`ls` du 2026-11-01) : asiatique, asiatique-bambou, -banhmi, -dragon, -hanoi, -matcha, -omakase, -sichuan, -tokyonight, -wokstreet ; default ; fast-food, fast-food-boxx, -dinerclassic, -drivein, -fermier, -grill77, -minuit, -prime, -stacked, -verte ; food-truck, food-truck-boheme, -braisenroute, -greenwheels, -lamarina, -nordique, -pitstop, -routier, -seoulstreet, -tacoloco ; pizzeria, pizzeria-basilico, -doppiozero, -fornonero, -golfo, -milano, -notte, -rustica, -verace, -vesuvio ; poulet, poulet-bouillon, -coqdor, -dimanche, -fermierchic, -hotcluck, -krispy, -piriwest, -seoulfried, -wingsclub.
- **Thème de départ recommandé : `asiatique-wokstreet`** (« High flame, a wok that cracks », signature orange brûlé hsl(16 85% 41%), Bricolage Grotesque + Archivo, hero image plein cadre, menu en onglets collants). Le fond crème et l'orange #ea5800 de Kurry Up rejoignent cette chaleur d'épices, et la carte de plus de 60 références en 6 catégories (entrées, plats, biryanis, naans, desserts, boissons) demande des onglets collants.
- **Thème de secours : `poulet-piriwest`** (« Piri-piri, embers and lemon », Staatliches + Be Vietnam Pro, hero diagonale couleur / photo, menu en bento). Il porte la même chaleur braisée et son bento met en avant les plats signature (butter chicken, poulet tikka, naans) au lieu d'une longue liste.

## 1. Marque

- **Nom officiel** : Kurry Up (écrit « Kurry Up » ; mentions légales : « Kurry Up »).
- **Raison sociale / SIRET** :
  - Mentions légales du site (https://kurryup.fr/policies/legal-notice) : « Kurry Up, 11 rue Washington 75008 Paris, immatriculée 838 057 065 RCS Paris », hébergeur Shopify. Registre (https://recherche-entreprises.api.gouv.fr/, 2026-11-01) : KURRY UP WASHINGTON, SIREN 838057065, SIRET siège 83805706500024, créée le 2018-02-15, 11 rue Washington, 75008 Paris, NAF 56.10C, gérant Muavia Malik Waqar (nommé « responsable de la publication » dans les mentions légales).
  - Franchiseur : KURRY UP DEVELOPPEMENT, SIREN 953463957, SIRET 95346395700019, créée le 2023-06-14, 177 rue de Courcelles, 75017 Paris, NAF 77.40Z, présidée par MAYFAIR HOLDINGS ; KURRY UP ACHAT, SIREN 953468535 (centrale d'achat).
  - Sociétés des restaurants (même gérant) : KURRY UP RENNEQUIN (SIREN 910782473, 2022), BOETIE (913203634, 2022), SEZE (920625274, 2022), CHOISEUL (982909871, 2023), NEUILLY (942671371, 2025).
  - Entité à afficher sur le futur site : à confirmer par la marque (exploitant Washington ou franchiseur).
- **Date de création** : 2015, premier restaurant rue Rennequin, Paris 17e ; franchise lancée en juin 2023 (Observatoire de la franchise : https://www.observatoiredelafranchise.fr/creation-entreprise/franchise-kurry-up-5315.htm).
- **Fondateurs** : « les enfants » de la famille qui a ouvert en 1965 le restaurant indo-pakistanais Mahatma à Paris ; ils ont étudié à Londres avant de créer Kurry Up en 2015. **Noms non trouvés** (Observatoire de la franchise ; Franchise Magazine). Stéphane Clément est directeur du développement franchise (g2, TLF du 2023-09-05).
- **Histoire en 3 phrases** : Kurry Up est né en 2015 rue Rennequin (Paris 17e), d'une famille qui tient depuis 1965 le restaurant Mahatma et qui a voulu rendre la cuisine indienne plus rapide et plus accessible. L'enseigne a changé d'identité en octobre 2023 (nouveau logo, graffiti indien, tuk-tuk et tandoor au restaurant pilote de la rue de la Boétie) puis a lancé la franchise. Le site annonce 24 franchisés et 30 restaurants en exploitation ou en développement, dont La Réunion et Rennes.
- **Positionnement** : street food indienne fast-casual, « fresh Indian street food », sur place, à emporter et en livraison, concept sans conduit d'extraction (Observatoire : « 1er réseau de franchise de street food indienne »).
- **Promesse** : « Retrait en 10 minutes sur place ou livraison en 1 heure max » ; produits frais, de qualité, carte régulièrement renouvelée (https://kurryup.fr/pages/qui-sommes-nous).
- **Cible** : actifs urbains en pause déjeuner (restaurants du quartier d'affaires de Paris 8e / 9e / 2e), amateurs de cuisine indienne, végétariens (plusieurs plats végétariens) ; déduit des horaires et de la carte.
- **Slogan** : « Fresh Indian street food in Paris » (bandeau du haut du site) ; « Street food indien nouvelle génération » (page franchise).
- **Halal** : **non trouvé**. Aucune mention sur le site, ni dans Observatoire de la franchise ; la carte vend de la bière (Cobra, Kingfisher) : ne pas afficher « halal » sans confirmation écrite.

## 2. Identité visuelle

- **Logo**
  - Logo principal : https://kurryup.fr/cdn/shop/files/logoKurryUp.svg (SVG, 555 x 176, un seul remplissage `#010000` donc quasi noir, **sans fond propre**, posé sur le crème du site).
  - Médaillon orange (icône du site) : https://kurryup.fr/cdn/shop/files/ICONE_MEDAILLON_ORANGE.png (PNG, hex précis non relevé car image).
  - Image de partage : https://kurryup.fr/cdn/shop/files/social-kurry.jpg (JPG).
- **Couleurs** (hex lus dans les variables CSS du HTML de https://kurryup.fr, 2026-11-01) :
  - Crème `#fdf3da` (fond de page, `--bg-color--body`).
  - Crème plus clair `#faf0d6` (fond de l'en-tête, règle `.header--root`).
  - Orange épice `#ea5800` (boutons, `--bg-color--button`, bordure de page `--bdr-color--page`, boutons d'en-tête).
  - Gris charbon `#373737` (texte, `--color--body`) et `#676767` (texte atténué).
  - Vert très foncé `#233929` (fond sombre `--bg-color--dark`, fenêtre pop-up de `custom.css`).
  - Ocre `#e49142` (`--color--accent-1`) et vert sauge `#9fb388` (`--color--accent-2`).
  - Rouge `#dd1d1d` (soulignement des liens), `#d32f2f` (erreur), `#4caf50` (succès), blanc `#ffffff`.
  - Noir du logo `#010000` (fichier SVG).
- **Polices** : Montserrat pour tout (titres, texte, accent : `--heading--family`, `--paragraph--family`, `--accent--family` valent « Montserrat, sans-serif » ; tailles de titres 38 / 28 / 20 px, texte 16 px). Police libre (Google Fonts, servie par Shopify).
- **Style de photographie** : aucune image téléchargée ni regardée (consigne) ; **non vérifié**. Relevé : photos produit au catalogue Shopify (série 2023, noms « KurryUp_PouletButter.jpg », etc.), plusieurs fiches avec un visuel de remplacement (« KurryUp_VisuelManquant »), visuels « restaurants » et « qui sommes nous » en WebP, vidéo d'accueil (vignette `preview_images`).
- **Ambiance** : chaleureuse, colorée, indienne moderne (article Toute la Franchise du 2023-10-08 : logo et typographie refaits, graffiti, tuk-tuks, turbans, épices, four tandoor, tenues et emballages redessinés).
- **Éléments graphiques récurrents** : médaillon orange, crème et orange, fond vert foncé pour les pop-up, bandeau d'annonce, cartes produit, sélecteur de pays.
- **À garder** : crème + orange + noir, nom Kurry Up et médaillon, ton d'épices, argument « retrait en 10 minutes ».
- **À refaire** : deux parcours de commande, photos manquantes, page Adresses incomplète (6 adresses sur 24-30), double catalogue (Shopify et DOOD), absence de page par restaurant.

## 3. Ton et textes

- **Langue** : français, quelques mots anglais (« Fresh Indian street food »), noms de plats indiens.
- **Tutoiement / vouvoiement** : vouvoiement (« Choisissez », « Contactez-nous », « Ouvrez un restaurant », « Suivez-nous »).
- **Expressions réelles** :
  1. « Fresh Indian street food in Paris » (https://kurryup.fr)
  2. « Retrait en 10 minutes sur place ou livraison en 1 heure max ! » (https://kurryup.fr)
  3. « composez votre plat préféré en 2 minutes » (https://kurryup.fr, bloc « Votre Création »)
  4. « Pour les connaisseurs » (https://kurryup.fr)
  5. « Spécialiste de la street food indienne » (https://kurryup.fr/pages/qui-sommes-nous)
  6. « Street food indien nouvelle génération. » (https://kurryup.fr/pages/franchise)
  7. « Ouvrez un restaurant sans extraction. » (https://kurryup.fr/pages/franchise)
  8. « Kurry Up s'adapte aux villes, pas l'inverse » (https://kurryup.fr/pages/franchise)
- **Mots-clés de recherche utiles** : street food indienne Paris, restaurant indien Paris 8, butter chicken, poulet tikka massala, naan fromage, biryani poulet, samossa chaat, restaurant indien rapide, déjeuner indien Paris, franchise restaurant indien, Kurry Up Paris.

## 4. Carte

Sources et dates : relevé le 2026-11-01 sur https://kurryup.fr/pages/carte (carte « sur place », avec prix) et sur le catalogue Shopify https://kurryup.fr/products.json (prix de la commande en ligne). **Les deux séries de prix ne concordent pas** (ex. poulet tikka massala 15 € sur la carte, 15,20 € en ligne ; plats végétariens 13 € sur la carte, 15,20 € en ligne ; agneau 16 € sur la carte, 18,20 € en ligne) : la marque doit trancher. La carte ne dit pas à quelle boutique elle s'applique. Pour la démo, boutique de référence : **Paris Washington**. Photos : base `https://cdn.shopify.com/s/files/1/0758/6771/7956/files/` (fichiers du catalogue Shopify), mêmes images que sur kurryup.fr/cdn/shop/files/.

| Catégorie | Produit | Description | Prix carte (sur place) | Prix en ligne (Shopify) | Photo (nom de fichier dans la base) |
|---|---|---|---|---|---|
| Entrées | Raïta | Yaourt frais, concombre, carottes et épices | 3,90 € | 3,90 € | KurryUp_Raita.jpg |
| Entrées | Samossa (2 pièces) | Beignets farcis de légumes ou de viande, piment, coriandre, curcuma | 4,90 € | 4,90 € (légumes x2) | KurryUp_SamoussaLegumes.jpg |
| Entrées | Pakora (4 pièces) | Beignet de pomme de terre à la farine de pois | 4,90 € | 4,90 € | KurryUp_Pakora.jpg |
| Entrées | Poulet tikka | Brochette de blanc de poulet | 5,90 € | 5,90 € | KurryUp_PouletTikkaMassala.jpg |
| Entrées | Samoussa chaat | Samoussa aux légumes, oignon haché, pois chiche, massala, chutney maison | 5,90 € | 5,90 € | KurryUp_SamoussaSalade.jpg |
| Entrées | Soupe de lentilles | Coriandre fraîche et fenugrec | 5,90 € | 5,90 € | KurryUp_SoupeLentilles.jpg |
| Plats agneau | Agneau madras | Curry d'agneau et riz basmati | 16 € | non trouvé (« Agneau Masala + riz » 18,20 €) | KurryUp_VisuelManquant_99c3e7db-cfbc-4516-a719-c7f7d0226398.jpg (visuel de remplacement) |
| Plats agneau | Agneau shahi korma | Riz basmati, curry d'agneau à la crème fraîche, amandes, raisins | 16 € | 18,20 € | KurryUp_VisuelManquant_d4a8a2ec-3d27-425e-b301-5d10b1a04dac.jpg (remplacement) |
| Plats agneau | Agneau karahi | Riz basmati, agneau mijoté aux épices | 16 € | 18,20 € | KurryUp_AgneauKarahi.jpg |
| Plats poulet | Butter chicken + riz | Riz basmati, poulet grillé au tandoor, sauce crémeuse, douce, onctueuse | 15 € | 15,20 € | KurryUp_PouletButter.jpg |
| Plats poulet | Poulet tikka massala + riz | Riz basmati, blanc de poulet grillé, sauce tikka aux poivrons et oignons | 15 € | 15,20 € | KurryUp_PouletTikkaMassalariz.jpg |
| Plats poulet | Poulet karahi + riz | Riz basmati, curry de poulet relevé | 15 € | 15,00 € | KurryUp_VisuelManquant_6a932011-5593-488a-bf43-7e451b92a01f.jpg (remplacement) |
| Plats poulet | Poulet korma + riz | Riz basmati, poulet à la crème fraîche, amandes, raisins | 15 € | 15,20 € | KurryUp_PouletKormaRiz.jpg |
| Légumes | Palak paneer | Riz basmati, curry d'épinards et de pommes de terre | 13 € | 15,20 € | KurryUp_PalakPaneerRiz.jpg |
| Légumes | Daal tarka | Riz basmati, curry de lentilles et tomates | 13 € | 15,20 € | KurryUp_VisuelManquant_ae8edad5-9970-4369-be31-cc69f2086a88.jpg (remplacement) |
| Légumes | Aubergine massala | Riz basmati, aubergine fumée, tomates, oignons, garam massala | 13 € | non trouvé au catalogue | non trouvé |
| Légumes | Chana massala | Pois chiche en sauce curry | 13 € | 15,20 € (avec riz) | KurryUp_17551.jpg |
| Biryanis | Biryani poulet | Poulet mariné | 11,90 € | prix 0,00 € au catalogue (à corriger) | KurryUp_BiruaniPoulet.jpg |
| Biryanis | Biryani légumes | Légumes marinés | 11,90 € | 0,00 € | KurryUp_BBiryaniLegumes.jpg |
| Biryanis | Biryani agneau | Agneau rôti mariné | 13,90 € | 0,00 € | KurryUp_BiryaniAgneau.jpg |
| Biryanis | Biryani crevettes | Crevettes marinées au garam masala | 13,90 € | 0,00 € | KurryUp_BiryaniAgneau_b00cfa39-217a-4f38-b3fb-f0b02976c596.jpg |
| Naans | Naan nature | | 2,90 € | 2,90 € | KurryUp_NaanNature.jpg |
| Naans | Naan à l'ail | | 3,90 € | 3,90 € | KurryUp_NaanAil.jpg |
| Naans | Naan fromage | | 3,90 € | 3,90 € | KurryUp_NaanFromage.jpg |
| Naans | Chapati (vegan) | | 3,20 € | 3,20 € | KurryUp_Chapati.jpg |
| Naans | Naan ail + fromage | | 4,90 € | 4,90 € | KurryUp_NaanFromage_36219fe7-33f3-4a98-8a3e-77776ec4e187.jpg |
| Naans / Desserts | Naan Nutella | | 3,90 € | 3,90 € | KurryUp_NaanNutella.jpg |
| Desserts | Cookie chocolat au lait ; cookie caramel cacahuète | | 2,50 € chacun | 2,50 € | La_Fabrique_chocolat_lait_bio.jpg ; LFC_caramel_beurre_de_cacahuetes.jpg |
| Desserts (catalogue seulement) | Fromage blanc coulis de mangue et muesli ; mousse au chocolat ; mangue et menthe ciselée | | non listés | 3,90 € chacun | KurryUp2_FromageBlanc.jpg ; KurryUp2_27951.jpg ; KurryUp2_27948.jpg |
| Desserts (catalogue seulement) | Glaces Ben & Jerry's (cookie dough, vanilla pecan, peanut butter, fudge brownie, vegan cookie on cookie dough) | | non listées | 3,50 € | CookieDoughLG.png ; Vanillapecan100mlLG.png ; peanut100mlLG.png ; FudgeBrownie100mlLG.png ; VeganCDLG.png |
| Boissons | Evian, Badoit (33 cl) | | 2,50 € | 2,50 € | Kurry-Up_evian.jpg ; KurryUp_17706.jpg |
| Boissons | Sodas 33 cl (Coca-Cola régulier, light, zéro ; Oasis Tropical ; Minute Maid orange ou pomme ; Sprite ; Seven Up) ; Lipton Ice Tea | | 2,50 € | 2,50 € (Coca, Coca zéro, Ice Tea) | KurryUp_17705.jpg ; KurryUp_17704.jpg ; KurryUp_IceTea.jpg |
| Boissons | Maya eau de coco ; thé glacé Arizona 50 cl | | 3,90 € | non trouvé | non trouvé |
| Boissons | Bière Cobra ou Kingfisher (33 cl) | | 4,30 € | 4,30 € | KurryUp_17685.jpg (Cobra) ; telechargement_1.jpg (Kingfisher) |
| Boissons | Thé indien | | 2,90 € | option à 1,00 € | non trouvé |
| Boissons | Lassi (33 cl, fait maison : nature, mangue, rose, salé ou sucré) | | 3,90 € | 3,90 € (mangue, rose) | KurryUp2_279901.jpg |
| Boissons | Jus Shezan (25 cl, litchi ou mangue) | | 3,90 € | 3,90 € | KurryUp_ShezanLitchi.jpg ; KurryUp_ShezanMangue.jpg |
| Boissons | Kombucha (grenade, mangue-passion, gingembre) | | 3,90 € | 3,90 € | KurryUp_KombuchaGrenade.jpg ; KurryUp_KombuchaManguePassion.jpg ; KurryUp_KombuchaGingembre.jpg |

- **Formules / menus (catalogue Shopify seulement)** : Menu Kurry Up 14,90 € (1 protéine + 3 légumes + 3 toppings + naan au choix + boisson au choix ; photo KurryUp_MenuKurryUp.jpg) ; Bowl Kurry Up 12,40 € (1 protéine + 3 légumes + 3 toppings ; KurryUp_Bowl.jpg) ; Sandwich à composer 10,90 € (1 protéine + 3 légumes + 3 toppings ; KurryUP-PA-MM-11mai2023_350.jpg) ; Salade Raja et Salade Rani 10,90 € (KurryUp2_SaladeRaja.jpg ; KurryUp2_SaladeRaniOK.jpg). Les jours lundi et vendredi ont une règle particulière dans la description du bowl (texte tronqué, à relever).
- **Suppléments (catalogue)** : protéines supplémentaires (poulet tikka 3 €, plat du jour 3 €, samoussa légumes 2 €, pakora 1,50 €) ; légumes supplémentaires 1 € (haricots verts, poivrons, pommes de terre, palak, légumes du jour) ; toppings 0,50 € (oignons caramélisés, cacahuètes, menthe, coriandre, tomates, concombres, salade, sauce citronnelle, sauce douce raïta, sauce épicée) ; riz basmati seul 5 €.
- **Allergènes** : non publiés. Plats « à composer » avec bloc « Votre Création » : à ouvrir en parcours de composition dans le nouveau site.
- **Date** : les photos et prix du catalogue Shopify datent de 2023 (paramètres `?v=` de 2023 dans les URLs) ; la carte HTML n'a pas de date.

## 5. Boutique pilote

- **Recommandation : Kurry Up Paris Washington**, 11 rue de Washington, 75008 Paris, métro Champs-Élysées Clemenceau (https://kurryup.fr/pages/adresses).
  - Horaires : tous les jours de 11 h à 22 h 30.
  - Modes : sur place, à emporter (retrait en 10 minutes), livraison (en 1 heure maximum) d'après le bandeau du site.
  - Zone de livraison : non trouvée (à lire dans la fiche DOOD).
  - Téléphone professionnel : **non trouvé** (aucun numéro sur le site, ni dans les mentions légales).
  - Raison du choix : horaires étendus 7 j sur 7, adresse de l'éditeur légal du site, société la plus ancienne (2018). Alternative : Paris Boétie (28 rue de la Boétie), restaurant pilote du nouveau look d'octobre 2023.
- **Autres adresses (une ligne)** : Paris Rennequin (17e), Paris Choiseul (2e, passage Choiseul), Paris Boétie (8e), Paris Sèze (9e), Lyon Grand Hôtel-Dieu (2e), Neuilly-sur-Seine (société créée en 2025), Rennes (2e franchise, octobre 2025), La Réunion Saint-Denis, Massy (franchisé Elior), Fort-de-France annoncé ; seules 6 adresses sont listées sur le site.

## 6. Commande

- **Système actuel** : DOOD (https://order.kurryup.fr/ ; https://www.dood.com) pour la commande et un panier Shopify en doublon (https://kurryup.fr/cart). Compte client Shopify (`/customer_authentication/redirect`) et compte DOOD séparés.
- **Ce que Be yours remplace** : le double parcours (Shopify et DOOD), les deux comptes clients, le sélecteur de pays qui mène à deux sous-domaines, la page Adresses incomplète. Frein possible : contrat avec DOOD à vérifier (g2).
- **Paiements acceptés** : Adyen, Stripe, LyfPay, Lunchr (titres-restaurant) d'après le code de l'app DOOD analysé dans g2 ; liste affichée au client : non vérifiée.
- **Retrait / livraison** : retrait en 10 minutes sur place, livraison en 1 heure maximum (bandeau) ; modes click & collect et livraison dans l'app DOOD.
- **Fidélité existante** : non trouvée. L'app mobile : non trouvée (g2). Inscription newsletter via Klaviyo.
- **Caisse / KDS connus** : intégration Deliverect citée dans l'app DOOD (g2) ; outil INPULSE cité dans l'annuaire franchise ; caisse des restaurants non confirmée.
- **Minimum de commande, frais de livraison** : non trouvés.

## 7. Réseaux et contacts publics

- Instagram : https://www.instagram.com/kurryup.fr (suivi non relevé)
- Facebook : https://facebook.com/kurryupparis
- TikTok : non trouvé
- Google Business : fiches par restaurant, non relevées
- E-mail professionnel : l'adresse de contact des mentions légales est une adresse Gmail de type personnelle, **non reprise ici** ; formulaire de contact sur https://kurryup.fr/pages/contact (réponse promise sous 24 h). Aucune adresse de domaine @kurryup.fr trouvée.
- Téléphone : non trouvé.

## 8. Plan du site Be yours

- **Pages** : Accueil, Carte, Commander, Boutique (Paris Washington pour la démo), Notre histoire (Mahatma 1965, Kurry Up 2015), Contact, Mentions légales / confidentialité / CGV, Franchise (lien externe vers l'existant).
- **Sections de l'accueil, dans l'ordre** :
  1. Bandeau « Retrait en 10 minutes sur place ou livraison en 1 heure max » + hero « Fresh Indian street food ».
  2. Catégories de la carte (entrées, plats, biryanis, naans, desserts, boissons).
  3. Les plus populaires (poulet tikka massala, butter chicken, poulet tikka, poulet korma).
  4. Votre création : composer son bowl, son sandwich ou son menu en 2 minutes.
  5. Pour les connaisseurs (agneau, biryanis, lassi).
  6. Notre histoire en 3 phrases + restaurant Washington.
  7. Où nous trouver (carte de la boutique).
  8. Suivez-nous (Instagram, Facebook) et inscription newsletter.
- **Fonctions Be yours** :
  - Commande : un seul parcours click & collect + livraison, compte client unique.
  - Fidélité : points sur les plats, récompense naan ou lassi (rien d'existant aujourd'hui).
  - Jeu QR : QR sur le sac, tirage d'un dessert ou d'un lassi.
  - KDS : écran cuisine relié à la caisse (caisse à identifier) pour suivre retrait et livraison.

## 9. Manques et risques

- **Non trouvé** : téléphone et e-mail de marque, halal, allergènes, TikTok, paiements affichés au client, minimum et frais de livraison, zone de livraison, fidélité, caisse, noms des fondateurs, liste complète des 24 à 30 restaurants, prix uniques (carte contre catalogue).
- **À demander à la marque** : prix de référence et boutique concernée ; liste des restaurants avec horaires et téléphones ; état du contrat DOOD et de Shopify (Comeleon) et ce qui peut être remplacé ; photos manquantes (visuels de remplacement sur plusieurs plats) ; allergènes ; statut halal (alcool servi) ; logo vectoriel et charte du refonte de 2023 ; contact marque (adresse de domaine) ; décisionnaire digital (Stéphane Clément, directeur développement franchise, d'après g2).
- **Ne pas copier tel quel** : photos du catalogue Shopify (série 2023, droits de l'agence Comeleon à confirmer) ; photos et logos des glaces Ben & Jerry's, cookies La Fabrique Cookies et boissons (marques tierces) ; textes des articles de presse (Toute la Franchise, Observatoire de la franchise, Franchise Magazine) ; prix à 0,00 € du catalogue ; adresse Gmail de contact ; chiffres de franchise contradictoires entre sources (droit d'entrée 25 000 € HT sur le site, 12 000 € HT sur l'Observatoire).

## 10. Sources

Consultées le 2026-11-01 sauf mention contraire.
- https://kurryup.fr , /pages/carte , /pages/adresses , /pages/qui-sommes-nous , /pages/franchise , /pages/contact , /policies/legal-notice , /products.json?limit=250
- https://kurryup.fr/cdn/shop/files/logoKurryUp.svg (SVG lu pour la couleur)
- https://order.kurryup.fr/fr/shops?setDistributionMode=click-and-collect (coquille Angular, rien de lisible sans navigateur)
- https://recherche-entreprises.api.gouv.fr/ (SIREN 838057065, 953463957 ; requêtes « kurry up »)
- https://www.observatoiredelafranchise.fr/creation-entreprise/franchise-kurry-up-5315.htm
- https://www.toute-la-franchise.com/news-kurry-up-se-metamorphose-devoile-son-nouveau-look-riche-en-couleurs (article du 2023-10-08)
- Dossier interne : salon-street-food-2026/sources/g2.md (section 4) et enseignes.csv (ligne 7)
