# Kurry Up : deux directions artistiques (phase 3, étape 1)

Document de choix, pas un contrat. Rien n'est construit : `site/theme.css`, `site/fonts.ts` et `site/layout.ts` restent ceux du boilerplate. La piste choisie sera recopiée et figée dans `site/ART_DIRECTION.md`.

Sources lues : `BRIEF.md` (sections 2, 3, 4, 8, 9), `AGENTS.md` (règles du salon : tutoiement, franchise au pied seulement, aucun « halal », aucun montant), `METHODE_SITE_PROSPECT.md`, l'en-tête de `site/theme.css`, `templates/README.md` du boilerplate, le DOM de la carte du moteur (`app/(storefront)/menu/_components/MenuContent.tsx`), et les `ART_DIRECTION.md` de Chamas Tacos, Krousty Factory, O'Crousti Poulet, Chicken Street, LÜKS, O'Tasty et ENJOYYY.

## Ce que les deux pistes partagent (non négociable)

- **Le monde réel de la marque, pas l'Inde des affiches.** La refonte d'octobre 2023 (Toute la Franchise, 2023-10-08) a posé au restaurant de la rue de la Boétie : graffiti, tuk-tuks, turbans, épices, four tandoor, tenues et emballages redessinés. La carte nomme ses épices : curcuma, coriandre, fenugrec, garam massala, piment. On part de là. Jamais d'éléphant, de mandala, de paon, de motif cachemire générique, de police pseudo-devanagari (barre de tête imitée), de Taj Mahal, de sitar ou de « Bollywood ».
- **Couleurs de la marque** (relevées dans le CSS de kurryup.fr) : crème `#fdf3da`, crème d'en-tête `#faf0d6`, orange épice `#ea5800`, charbon `#373737`, gris `#676767`, vert très foncé `#233929`, ocre `#e49142`, sauge `#9fb388`, noir du logo `#010000`.
- **Fait mesuré qui contraint les deux pistes : un libellé blanc sur l'orange `#ea5800` donne 3,56:1**, sous le 4,5:1 d'un bouton. Chaque piste règle ce point à sa manière (A : encre sombre sur l'orange de la marque ; B : orange grillé plus profond sous un libellé crème).
- **Logo** : aucun logo inventé. Au centre de l'en-tête, un emplacement neutre « Kurry Up » composé dans la police de titre, marqué « logo à fournir » dans `site/A_COMPLETER.md`, remplacé par le SVG de la marque après accord écrit.
- **En-tête** : une seule rangée, logo sur l'axe (hors flux, `left: 50%`), rubriques réparties de part et d'autre, aucun slogan à côté du logo, aucune perle ni séparateur en points. Rubriques : à gauche « La carte », « Votre création », « Restaurants » ; à droite « Notre histoire », « Contact », puis le bouton « Commander » et le panier. Franchise absente de l'en-tête.
- **Pied de page** : la seule porte vers la franchise (« Ouvrir un Kurry Up », lien discret), aucun montant.
- **Images** : jamais plus de 62 svh sur téléphone, 70 svh sur tablette. Illustrations générées en phase 5, aucune photo de kurryup.fr.
- **Pas de cadres** autour des éléments ronds ordinaires ; des dalles sur un fond chaud ; tout cadre restant est entier (rien coupé au ras de sa boîte).
- **3D avec modération** : au plus une scène courte par page, titres à plat, survols en couleur et en quelques pixels.
- **Mouvement** : animations CSS liées au défilement (`animation-timeline: view()`), déclarées APRÈS le raccourci `animation` ; `@media (prefers-reduced-motion: reduce)` pose l'état final sans mouvement ; Safari ancien voit l'état final.
- **Carte du moteur, ce qu'on sait du DOM** : les familles sont des puces qui filtrent par URL (`?category=slug`), pas des ancres ; la page a de la pagination ; la racine de la carte porte `overflow-x-hidden`, ce qui tue `position: sticky`. Les onglets collants demandent donc `overflow-x: clip` sur cette racine, limité à `.storefront-theme`. Le texte en dur du moteur (« Affichage : », « Trier par : ») se restyle, ne se change pas.
- **Ton** : tutoiement (règle du salon), guillemets « », espaces insécables avant `: ; ? ! €`, pas de tiret cadratin dans le texte lu.

---

## Piste A : « La Fresque »

**L'idée en une phrase.** Le mur peint du restaurant de la rue de la Boétie devient la page : chaque section est un aplat de peinture frais posé sur un badigeon crème, et le défilement est le pinceau du peintre.

### Matière et motif signature

- **Matière** : un mur de badigeon à la chaux, crème, avec un grain de truelle à peine visible (bruit SVG à 3 % d'opacité, jamais un papier). Dessus, des aplats mats de peinture murale dans les couleurs de la marque, superposés comme des couches posées l'une sur l'autre.
- **Motif signature : « la passe »**. Un seul coup de brosse large, horizontal, qui peint un aplat de couleur derrière un titre ou un groupe de plats. Le bord d'attaque et le bord de fin portent la trace sèche d'une brosse (masque SVG). La trace est toujours DANS la boîte de l'aplat, avec une marge : aucun bord coupé au ras.
- **Deuxième motif : « le chiffre peint »**. Les nombres qui comptent pour la marque (10 minutes, 1 heure, 6 familles, les arrondissements des restaurants) sont peints très grands, comme une adresse sur un mur, jamais comme un cadran ou un afficheur.
- **Ce qui vient du lieu** : graffiti (les aplats et la lettre peinte), épices (les couleurs), tandoor (l'orange chaud de la passe principale). Les tuk-tuks et les turbans restent ce qu'ils sont dans le restaurant : des choses qu'on voit sur les photos de la salle, jamais une mascotte dessinée.

### Palette et contrastes (calculés, WCAG 2.1, luminance relative)

Mode clair « Badigeon » (par défaut) :

| Jeton | Hex | Rôle | Contraste vérifié |
| --- | --- | --- | --- |
| `--background` | `#fdf3da` | le mur (crème de la marque) | |
| `--card` | `#fff9ec` | dalles de lecture | |
| `--muted` / `--secondary` | `#f6e6bf` | badigeon plus chargé | |
| `--foreground` | `#373737` | texte (charbon de la marque) | 10,78 sur fond ; 11,34 sur carte ; 9,63 sur muted |
| `--muted-foreground` | `#5f5850` | texte secondaire | 6,34 / 6,67 / 5,67 |
| `--primary` | `#ea5800` | la passe principale, le bouton (orange de la marque, intact) | 3,22 contre le fond (≥ 3) |
| `--primary-foreground` | `#1f1712` | libellé du bouton, encre sombre | 4,96 sur `#ea5800` |
| `--primary-hover` | `#ff6a12` | survol | libellé 6,16 |
| `--primary-ink` | `#a94000` | un mot écrit en orange | 5,56 fond ; 5,85 carte ; 4,97 muted ; 4,94 accent |
| `--accent` | `#fbe3c4` | puce active, fond de survol | |
| `--accent-foreground` | `#7a2e00` | texte sur accent | 7,61 |
| `--accent-solid` | `#233929` | la passe verte | 11,26 contre le fond |
| `--input` | `#8f7c57` | bord des champs | 3,66 contre le fond (≥ 3) |
| `--ring` | `#c24a00` | focus | 4,45 contre le fond (≥ 3) |
| `--border` | `#e8d4a6` | filet décoratif seulement | non requis |
| aplat vert | `#233929` | passe verte, texte crème `#fdf3da` dessus | 11,26 |
| aplat ocre | `#e49142` | passe ocre, texte `#1f1712` dessus | 7,08 |
| aplat sauge | `#9fb388` | passe sauge, texte `#1f1712` dessus | 7,80 |
| logo | `#010000` | emplacement du logo | 18,98 sur le fond |

Mode sombre « Mur vert » (derrière l'interrupteur) : le mur passe au vert très foncé de la marque, les aplats gardent leurs couleurs.

| Jeton | Hex | Contraste vérifié |
| --- | --- | --- |
| `--background` | `#1c2e22` | |
| `--card` | `#233929` (vert de la marque) | |
| `--muted` | `#2d4634` | |
| `--foreground` | `#fdf3da` | 12,99 fond ; 11,26 carte ; 9,33 muted |
| `--muted-foreground` | `#cfc6ab` | 8,42 / 7,29 / 6,05 |
| `--primary` | `#ea5800`, libellé `#1f1712` | 4,03 contre le fond ; libellé 4,96 |
| `--primary-ink` | `#ff9a5c` | 6,85 fond ; 5,94 carte ; 4,92 muted ; 4,65 accent |
| `--accent` / `--accent-foreground` | `#2f4a37` / `#f5c99a` | 6,36 |
| `--accent-solid` | `#e49142` (ocre) | 5,76 contre le fond |
| `--input` | `#86a08d` | 5,08 contre le fond |
| `--ring` | `#ff8a3d` | 6,12 contre le fond |

Règle d'emploi : orange, vert, ocre et sauge se partagent la page en aplats entiers ; jamais de dégradé entre deux couleurs ; une passe orange par écran au plus.

### Polices (Google Fonts, présentes dans `next/font`)

- **Titres : Bungee** (David Jonathan Ross), exposée en `--font-poppins`. Dessinée pour la signalétique urbaine : capitales franches, lisibles de loin, la lettre d'un mur peint ou d'une enseigne de rue, sans imiter une écriture indienne. Une seule graisse : réservée aux titres de 28 px et plus, interlignage 0,95, à plat (aucune variante « Shade » ou ombrée).
- **Texte : Mukta** (Ek Type, Mumbai), exposée en `--font-inter`. Une famille dessinée en Inde pour le latin et le devanagari : l'origine est réelle, le dessin reste neutre, sept graisses, très lisible en 16 à 18 px. Noms de plats en Mukta 800, prix en Mukta 700 à chiffres tabulaires.
- Pourquoi mieux que Montserrat : Montserrat est géométrique et sans voix ; Bungee donne la lettre peinte que la refonte de 2023 a mise sur les murs, Mukta porte la lecture longue de 60 références mieux qu'une géométrique large.

### En-tête et pied de page

- **En-tête** : barre crème `#faf0d6` (le crème d'en-tête de la marque), une rangée. Rubriques en Mukta 700 capitales, interlettrage +0,04 em. La rubrique active reçoit une mini-passe orange sous le mot (une trace de brosse, pas un soulignement fin). « Commander » : bouton orange à encre sombre, coins vifs légèrement rognés par la brosse. Sur téléphone : menu à gauche, logo sur l'axe, panier à droite ; le menu plein écran est une grande passe verte où les rubriques arrivent en Bungee.
- **Pied de page** : un grand aplat vert `#233929` dont le bord haut est une trace de brosse entière. Le chiffre peint « 10 min » et « 1 h » en ocre, la promesse de la marque écrite en entier dessous. Colonnes : La carte (6 familles), Restaurants, Maison (Notre histoire, Contact), Légal, puis une ligne discrète « Ouvrir un Kurry Up » (franchise) et les réseaux.

### Grammaire de mouvement

1. **La passe** (signature, toutes les pages) : l'aplat se peint de gauche à droite (`mask-size` 0 → 100 % sur un masque de brosse), lié à `view()` de `entry 10%` à `entry 55%`, courbe `cubic-bezier(.22,.8,.16,1)`. Reduced motion : aplat posé.
2. **Le jet** : les lignes d'un titre arrivent l'une après l'autre (translation 0,35 em, opacité), 70 ms d'écart, 520 ms, même courbe. Le contenu au-dessus de la ligne de flottaison n'est jamais caché.
3. **Le recouvrement** (ordinateur ≥ 1024 px seulement) : deux aplats superposés glissent l'un sur l'autre de 6 svh au défilement, comme deux couches de peinture décalées. Aucune perspective.
4. **La couche suivante** (survol) : un aplat ou une carte change de couleur d'une couche (ocre vers orange, sauge vers vert), 160 ms, aucune inclinaison, aucun saut.
5. **Reduced motion et vieux Safari** : tous les aplats peints, titres visibles, aucun décalage ; la page se lit pareil.

### Hero cinématique (waouh) et alternative statique

- **Cinématique** (CSS au chargement, 1,4 s, puis rien) : le mur crème est vide une fraction de seconde ; une passe orange traverse derrière la première ligne « FRESH INDIAN » (0 à 500 ms), une passe verte part de la droite derrière le plat (300 à 800 ms), le plat signature (butter chicken et riz basmati, illustration détourée) se pose sur la passe verte (700 à 1 100 ms), une bande ocre peint la promesse « Retrait en 10 minutes, livraison en 1 heure max » (900 à 1 300 ms). Le titre passe en crème là où il croise l'orange (deux couches du même texte, la seconde découpée par l'aplat). Au défilement : les deux passes s'écartent de 6 svh, le plat reste.
- **Alternative statique** : la même composition, passes déjà peintes, aucun délai, une seule image. C'est aussi l'état reduced motion et l'état sans JS.
- Téléphone : le plat sous le titre, plafonné à 42 svh ; les passes pleine largeur avec 1 rem de mur crème de chaque côté pour que la trace de brosse reste entière.

```
┌──────────────────────────────────────────────────────────────────────┐
│  La carte  Votre création  Restaurants   [ KURRY UP ]   Notre histoire  Contact  (Commander) 🛍 │
├──────────────────────────────────────────────────────────────────────┤
│ badigeon crème                                                       │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒░  ← passe orange                       │
│  ▓ FRESH INDIAN ▓▓▓▓▓▓▓▓▓▓▓▓▓▒░          ░▒██████████████████████   │
│    STREET FOOD                           ░▒███  (plat détouré)  ███   │
│    À PARIS                               ░▒███  butter chicken  ███   │
│                                          ░▒██████████████████████   │
│  Compose ton bowl en 2 minutes,             passe verte →           │
│  ou prends un classique.                                            │
│  (Commander)   Voir la carte                                        │
│  ░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░  │
│   ocre :  10 MIN  retrait sur place      1 H MAX  livraison          │
└──────────────────────────────────────────────────────────────────────┘
```

### La carte (60 références, 6 familles)

- **Tête de page** : une passe orange pleine largeur, « LA CARTE » en Bungee crème sur encre, la promesse en Mukta dessous.
- **Onglets collants** : les puces du moteur deviennent six échantillons de peinture (Entrées ocre, Plats orange, Biryanis vert, Naans crème sur charbon, Desserts sauge, Boissons ocre clair), collés sous l'en-tête grâce à `overflow-x: clip` sur la racine de la carte. L'échantillon actif est peint pleinement, les autres sont des traces légères. Sur téléphone, défilement horizontal avec accroche, la puce active ramenée au centre.
- **Bento des plats signature** (accueil « Les plus populaires » et « Pour les connaisseurs ») : une grande tuile sur une passe verte (poulet tikka massala), une tuile large (butter chicken), deux petites (poulet tikka, poulet korma). Photos entières, coins doux, nom et prix sur une étiquette crème mate ; pas de cadre, pas de voile sombre sur la photo. À vérifier avant de construire : quelles cartes produits réelles le moteur sort sur l'accueil (le DOM ne se complète pas).
- **Cartes produits de la carte** : dalles crème `#fff9ec` posées sur le mur, ombre douce, aucun filet ; au survol, la dalle prend la couche suivante (ocre pâle), pas d'agrandissement de la photo.
- **« Votre création »** (bowl 12,40 €, sandwich 10,90 €, menu 14,90 € au catalogue) : trois passes successives, une par étape, « 1 protéine », « 3 légumes », « 3 toppings » (puis naan et boisson pour le menu). Une étape terminée est peinte ; le compteur de l'étape (« 2 sur 3 ») est un chiffre peint. Construit sur les formules du moteur (`formule-card`) si leur DOM le permet ; sinon route `// SITE-SPECIFIC` à décider en phase 6.

```
┌ en-tête ─────────────────────────────────────────────────────────────┐
├ onglets collants ────────────────────────────────────────────────────┤
│ [▓ENTRÉES▓] [░plats░] [░biryanis░] [░naans░] [░desserts░] [░boissons░]│
├──────────────────────────────────────────────────────────────────────┤
│ ▓▓▓▓▓▓▓▓ passe ocre ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒░              │
│ ▓  6  ENTRÉES   à partager ou pas            ▓▒░                     │
│ ┌────────────┐ ┌────────────┐ ┌────────────┐   dalles crème,         │
│ │  (photo)   │ │  (photo)   │ │  (photo)   │   ombre douce,          │
│ │ Samossa    │ │ Pakora     │ │ Samoussa   │   aucun filet           │
│ │ 2 pièces   │ │ 4 pièces   │ │ chaat      │                         │
│ │ 4,90 €  +  │ │ 4,90 €  +  │ │ 5,90 €  +  │                         │
│ └────────────┘ └────────────┘ └────────────┘                         │
└──────────────────────────────────────────────────────────────────────┘
```

### Page Restaurants : « Le mur des adresses »

Chaque restaurant est un aplat portant son chiffre peint très grand (« 8e », « 17e », « 2e », « 9e », puis Lyon, Neuilly-sur-Seine, Rennes, Massy, Saint-Denis de La Réunion), en mosaïque de tailles variées comme des couches sur un mur. Paris Washington (boutique du moteur) porte le bouton « Commander ici » et ses horaires relevés (11 h à 22 h 30, 7 j sur 7) ; les autres viennent de `site/components/network.ts` avec « Horaires à confirmer ». Une passe par aplat au défilement, rien de plus.

### Ce que la piste ne fait pas

Pas de coulures de peinture, pas de bombe aérosol dessinée, pas de faux tag signé, pas de mascotte tuk-tuk, pas de traits de crayon ni de doodles, pas d'autocollants, pas de fond noir par défaut, pas de bandeau défilant de mots, pas d'ornement indien.

### En quoi elle diffère des voisins

- **Chamas Tacos « La Coupe »** : pas de planche d'architecte, d'axe vertical, de légendes fines ni de mono ; nos aplats sont peints à la brosse, pas des strates en coupe.
- **Krousty Factory** : pas de chaîne de production, de bord déchiré ni de ruban de chantier ; le violet est absent.
- **O'Crousti Poulet « Le Décompte »** : pas de cadran ni d'heure par section, pas de noir et jaune ; nos chiffres sont des adresses peintes, pas un compte à rebours.
- **Chicken Street « La rue, la nuit »** : de jour sur un mur crème, pas une rue de nuit ; aucune lumière ou enseigne lumineuse, aucune marche vers une porte.
- **LÜKS « Après minuit »** : pas de lookbook noir, de projecteurs, de numérotation de pièces ni de mot barré.
- **O'Tasty « La Boîte »** : pas de kraft, de case cochée, de tampon ni de ruban adhésif ; le geste est le pinceau, pas le feutre.
- **ENJOYYY « La Joie »** : pas d'autocollants inclinés, de doodles au trait, de mots en contour empilés, de titres penchés ni de formes en blob.

---

## Piste B : « Le Dabba »

**L'idée en une phrase.** Le masala dabba, la boîte ronde d'inox où toute cuisine indienne range ses épices, sert de sommaire au site : six coupelles autour pour les six familles de la carte, la coupelle du centre pour « Votre création ».

### Matière et motif signature

- **Matière** : le plan de travail du cuisinier, crème clair ; l'inox brossé du couvercle (seulement dans l'illustration du hero, jamais en bordure d'interface) ; les poudres mates en tas, avec leur grain. La page est rangée, précise, comme une cuisine avant le service.
- **Motif signature : « la pincée »**. Une tache de poudre irrégulière, mate, sans contour, posée derrière le mot ou l'élément actif (un titre, une puce, un prix). Elle remplace le soulignement, la pastille et le cadre.
- **Couleurs des familles = épices nommées sur la carte** : curcuma (samossa), piment, garam massala (aubergine, biryani crevettes), palak (palak paneer), farine (naans), menthe (« mangue et menthe ciselée », topping menthe).
- **Garde-fou** : les coupelles se dessinent comme des disques de poudre SANS bord d'inox. Un anneau d'inox autour d'un disque serait un cadre autour d'un élément rond : interdit. La disposition en couronne n'existe qu'au hero ; partout ailleurs la grille est droite (pas de mandala par accumulation).

### Palette et contrastes (calculés, WCAG 2.1, luminance relative)

Mode clair « Plan de travail » (par défaut) :

| Jeton | Hex | Rôle | Contraste vérifié |
| --- | --- | --- | --- |
| `--background` | `#faf0d6` | plan de travail (crème d'en-tête de la marque) | |
| `--card` | `#fffbf2` | dalles | |
| `--muted` / `--secondary` | `#f1e5c6` | | |
| `--foreground` | `#23211f` | fonte | 14,14 fond ; 15,54 carte ; 12,81 muted |
| `--muted-foreground` | `#5c564e` | | 6,39 / 7,02 / 5,79 |
| `--primary` | `#b84300` | piment grillé, bouton | 4,82 contre le fond |
| `--primary-foreground` | `#fff7e6` | libellé crème | 5,13 sur `#b84300` |
| `--primary-hover` | `#a33b00` | | libellé 6,19 |
| `--primary-ink` | `#a63c00` | mot en orange | 5,66 fond ; 6,22 carte ; 5,13 muted ; 4,94 accent |
| `--accent` / `--accent-foreground` | `#f3dfc0` / `#6e2a10` | | 8,06 |
| `--accent-solid` | `#233929` (palak) | | 10,95 contre le fond |
| `--input` | `#8a7f6a` | bord des champs | 3,47 contre le fond |
| `--ring` | `#b84300` | focus | 4,82 contre le fond |
| `--border` | `#e2d3ad` | filet décoratif | non requis |
| épice curcuma | `#e49142` | texte `#23211f` dessus | 6,44 |
| épice piment | `#ea5800` | grandes poudres, texte `#1a0f08` dessus | 5,28 |
| épice massala | `#7a3b1d` | texte crème dessus, ou mot brun sur le fond | 7,49 |
| épice palak | `#233929` | texte crème dessus | 10,95 |
| épice menthe | `#9fb388` | texte `#23211f` dessus | 7,09 |
| épice farine | `#fdf3da` | sur charbon pour les naans | voir sombre |
| inox | `#cfd1cc` / `#8d918c` | illustration seulement, jamais du texte | décoratif |

Mode sombre « Tawa » (derrière l'interrupteur) : la plaque de fonte chaude, brun-charbon, pas un noir pur.

| Jeton | Hex | Contraste vérifié |
| --- | --- | --- |
| `--background` | `#1f1c1a` | |
| `--card` | `#292522` | |
| `--muted` | `#332e2a` | |
| `--foreground` | `#faf0d6` | 14,93 fond ; 13,39 carte ; 11,82 muted |
| `--muted-foreground` | `#c9bfac` | 9,31 / 8,34 / 7,37 |
| `--primary` | `#ea5800`, libellé `#1a0f08` | 4,76 contre le fond ; libellé 5,28 |
| `--primary-ink` | `#ff9455` | 7,76 fond ; 6,96 carte ; 6,15 muted ; 6,28 accent |
| `--accent` / `--accent-foreground` | `#3a2a20` / `#f4b98a` | 7,93 |
| `--accent-solid` | `#e49142` (curcuma) | 6,80 contre le fond |
| `--input` | `#8c8378` | 4,55 contre le fond |
| `--ring` | `#ff8a3d` | 7,23 contre le fond |
| menthe en texte | `#9fb388` | 7,49 sur le fond |

Règle d'emploi : le crème domine (70 % de la surface), une épice par section en grande nappe, le piment n'est que l'action.

### Polices (Google Fonts, présentes dans `next/font`)

- **Titres : Rozha One** (Indian Type Foundry), exposée en `--font-poppins`. Un didone de titrage très contrasté, dessiné en Inde pour le devanagari et le latin : le ton d'une étiquette d'épicier ou d'une affiche, net, gourmand, sans pastiche d'écriture. Une seule graisse : titres de 32 px et plus, interlignage 1, chiffres de prix en grand.
- **Texte : Biryani** (Dan Reynolds), exposée en `--font-inter`. Une linéale géométrique latin et devanagari, sept graisses (200 à 900), très claire dans l'interface et les listes de suppléments. Le nom n'est jamais cité sur le site, c'est un clin d'œil interne.
- Pourquoi mieux que Montserrat : le contraste de Rozha One donne la lettre « pour les connaisseurs » ; Biryani garde la clarté géométrique de Montserrat avec un dessin plus ouvert et moins répandu.

### En-tête et pied de page

- **En-tête** : barre crème, une rangée. Rubriques en Biryani 600, minuscules, 15 px ; la rubrique active est posée sur une pincée de curcuma (tache de poudre, pas un point, pas une ligne). « Commander » : bouton piment grillé, libellé crème, coins de 10 px. Téléphone : menu à gauche, logo sur l'axe, panier à droite ; le menu plein écran est la grille des six épices, chaque rubrique sur sa nappe.
- **Pied de page** : nappe palak `#233929`. Six petites nappes d'épices (une par famille, liens vers la carte), la promesse de la marque en Rozha One crème, colonnes Restaurants, Maison, Légal, puis « Ouvrir un Kurry Up » discret et les réseaux.

### Grammaire de mouvement

1. **Le couvercle** (la seule scène de l'accueil, environ 1,2 écran) : le couvercle d'inox du dabba glisse et tourne dans le plan (rotation de 0 à 24°, translation vers la droite), lié à `scroll()` de la section ; les six coupelles apparaissent avec leur nom. Aucune perspective, aucune inclinaison 3D. Reduced motion : boîte ouverte, noms visibles.
2. **La pincée** : la tache de poudre derrière l'élément actif passe de 0,6 à 1 en échelle et de 6 px à 0 de flou, 420 ms, `cubic-bezier(.2,.75,.2,1)`.
3. **Le tamis** : les photos entrent par un fondu granuleux (masque de bruit qui se remplit), lié à `view()` de `entry 0%` à `entry 40%` ; la photo est toujours entière à la fin.
4. **La nappe** : le fond d'une section se teinte légèrement vers l'épice de la famille qu'on lit (crème vers curcuma pâle, vers menthe pâle), lié au défilement, jamais au-delà de 12 % de mélange.
5. **Reduced motion et vieux Safari** : couvercle ouvert, photos entières, nappes posées.

### Hero cinématique (waouh) et alternative statique

- **Cinématique** : vue de dessus, le dabba fermé sur le plan de travail crème, à droite (illustration générée, inox brossé, poudres réelles). À gauche « Fresh Indian street food » en Rozha One, la promesse en Biryani, « Commander » et « Composer mon bowl ». Au défilement, le couvercle glisse et révèle les six coupelles : curcuma « Entrées », piment « Plats », garam massala « Biryanis », farine « Naans », menthe « Desserts », palak « Boissons », et au centre « Votre création ». Chaque nom est un vrai lien vers sa famille (`/menu?category=...`), posé en HTML par-dessus l'image, pas une image cliquable.
- **Alternative statique** : la boîte déjà ouverte, une image, les sept liens visibles.
- Téléphone : la boîte sous le titre, plafonnée à 46 svh ; en dessous, les sept liens en grille 2 colonnes de nappes (pas de couronne sur petit écran).

```
┌──────────────────────────────────────────────────────────────────────┐
│ la carte  votre création  restaurants   [ Kurry Up ]   notre histoire  contact  (Commander) 🛍 │
├──────────────────────────────────────────────────────────────────────┤
│ plan de travail crème                        ╭───────────────╮       │
│                                            ╱  ●curcuma ●piment ╲     │
│  Fresh Indian                             │ ●menthe (création) ●massala│
│  street food                              │   ●palak   ●farine   │   │
│  à Paris.                                  ╲   couvercle →→     ╱     │
│                                              ╰───────────────╯       │
│  Retrait en 10 minutes, livraison en 1 heure max.                    │
│  (Commander)   Composer mon bowl                                     │
│                         ▒ pincée de curcuma sous « à Paris »         │
└──────────────────────────────────────────────────────────────────────┘
   (illustration : boîte vue de dessus ; les noms sont des liens HTML)
```

### La carte (60 références, 6 familles)

- **Tête de page** : nappe de l'épice de la famille active (curcuma par défaut), « La carte » en Rozha One, nombre de plats.
- **Onglets collants** : six puces, chacune avec sa pincée d'épice à gauche (disque de poudre de 14 px sans bord), collées sous l'en-tête (`overflow-x: clip` sur la racine). La puce active est posée sur sa nappe pleine. Téléphone : rangée horizontale avec accroche.
- **Bento des plats signature** : grille droite de cinq tuiles sur une nappe piment pâle ; la grande tuile porte le butter chicken, la large le poulet tikka massala, les petites poulet tikka, poulet korma, naan fromage. « Pour les connaisseurs » : même grille sur nappe massala (agneau karahi, biryani agneau, lassi). Photos entières, nom en Rozha One, prix en Biryani 800. Même réserve qu'en A sur les cartes réelles du moteur.
- **Cartes produits** : dalles `#fffbf2`, ombre douce, la pincée de la famille dans un coin derrière le prix ; aucun filet.
- **« Votre création »** : la coupelle du centre se remplit. Trois tas de poudre grossissent à chaque choix (protéine 1 sur 1, légumes 3 sur 3, toppings 3 sur 3), le prix se met à jour en Rozha One. Même réserve qu'en A sur les formules du moteur.

```
┌ onglets collants ────────────────────────────────────────────────────┐
│ ●Entrées  [●Plats]  ●Biryanis  ●Naans  ●Desserts  ●Boissons          │
├──────────────────────────────────────────────────────────────────────┤
│ nappe piment pâle                                                    │
│ ┌──────────────────────────┐ ┌─────────────────────────────────────┐ │
│ │                          │ │ Poulet tikka massala        15 €    │ │
│ │  Butter chicken          │ │ (photo large)                       │ │
│ │  (grande tuile)          │ ├─────────────────┬───────────────────┤ │
│ │  15 €                    │ │ Poulet tikka    │ Poulet korma      │ │
│ │                          │ │ 5,90 €          │ 15 €              │ │
│ └──────────────────────────┘ └─────────────────┴───────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

### Page Restaurants : « Les étiquettes »

Chaque restaurant est une dalle-étiquette : arrondissement ou ville en Rozha One (« 8e », « 17e », « Lyon »), rue, métro, état d'ouverture, posée sur la nappe de l'épice de sa ville (Paris curcuma, Lyon menthe, Rennes palak, La Réunion piment). Filtre collant par ville en haut. Paris Washington porte le bouton « Commander ici » ; les autres viennent de `network.ts`, « Horaires à confirmer ».

### Ce que la piste ne fait pas

Pas de mandala, pas de couronne ailleurs qu'au hero, pas d'anneau d'inox autour des disques, pas de bocaux étiquetés façon épicerie vintage, pas de cuillère ou de poudre qui vole partout, pas de 3D au-delà du couvercle, pas de serif italique, pas de fond noir par défaut.

### En quoi elle diffère des voisins

- **Chamas Tacos « La Coupe »** : pas de coupe, d'axe ni de légendes d'architecte ; le seul mouvement fort est un couvercle qui glisse, vu de dessus.
- **Krousty Factory** : pas de tapis, d'usine ni de plateau qui change de sauce ; une boîte de cuisine, pas une chaîne.
- **O'Crousti Poulet « Le Décompte »** : la boîte est ronde mais ne compte rien (aucune graduation, aucune heure) ; pas de sceaux inclinés.
- **Chicken Street « La rue, la nuit »** : intérieur de cuisine en plein jour, aucune lumière d'enseigne, aucune largeur de lettre extrême.
- **LÜKS « Après minuit »** : pas de didone italique en accent ni de noir violet ; Rozha One est un titrage droit, la page est crème.
- **O'Tasty « La Boîte »** : la boîte est en inox et vue de dessus, pas un carton kraft qu'on ouvre ; pas de tampon, de case ni de ruban.
- **ENJOYYY « La Joie »** : pas de violet-jaune, d'autocollants, de doodles ni d'écriture manuscrite ; une grille calme et précise.

---

## Comparaison rapide

| | A « La Fresque » | B « Le Dabba » |
| --- | --- | --- |
| Monde | le mur du restaurant (graffiti de la refonte 2023) | la cuisine (épices nommées sur la carte) |
| Énergie | forte, colorée, « street » | posée, précise, « pour les connaisseurs » |
| Structure | aplats horizontaux superposés | une couronne au hero, puis une grille droite |
| Lettre | Bungee capitales + Mukta | Rozha One contrasté + Biryani |
| Bouton | orange de la marque intact, encre sombre | orange grillé plus profond, libellé crème |
| Sombre | mur vert `#1c2e22` | fonte « tawa » `#1f1c1a` |
| Scène unique | la passe au chargement (2D) | le couvercle au défilement (2D) |
| Risque principal | Bungee et graffiti peuvent tirer vers le « street food » générique si les passes sont trop timides | page crème calme : risque « fade » (déjà reproché à Chamas v1) ; la couronne frôle le mandala si on la répète |

## Recommandation

**Piste A, « La Fresque ».** Le patron reconnaîtra ses murs : la refonte de 2023 a mis le graffiti au restaurant pilote, et la méthode demande de partir du lieu réel. La passe donne de la couleur, de l'échelle et du mouvement à chaque page intérieure sans 3D, ce qui répond d'avance aux reproches « fade » et « trop d'animation » des projets voisins. Elle garde aussi l'orange `#ea5800` intact sur les boutons grâce à l'encre sombre (4,96:1), alors que B doit l'assombrir. B reste une bonne piste de secours si la marque veut un ton plus « connaisseur » ; dans ce cas il faudra deux nappes d'épices pleines par page pour éviter l'effet fade.

## Ce qui n'est pas vérifié

- Aucune photo des restaurants n'a été regardée (consigne du brief) : on ne sait pas quelles couleurs dominent réellement les murs peints de la rue de la Boétie, ni si un vert ou un ocre y occupe plus de place que l'orange. À vérifier sur des photos fournies par l'utilisateur avant de figer la piste.
- Rendu réel de Bungee, Mukta, Rozha One et Biryani avec les accents français et les capitales accentuées : non testé dans le navigateur (noms et graisses vérifiés dans `font-data.json` de `next/font` seulement).
- Contrastes calculés par script sur les valeurs hex ; `pnpm design:check` n'a pas tourné (aucun thème écrit).
- Cartes réelles du moteur sur l'accueil (plats populaires, formules « Votre création ») et faisabilité du parcours de composition sur `formule-card` : à vérifier dans le DOM en phase 6.
- Le masque de brosse (A) et le masque granuleux (B) liés au défilement : principe connu, non prototypé ici.
