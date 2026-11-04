# Direction artistique : « La Fresque »

Site démo de Kurry Up (fresh Indian street food, Paris), construit par Be yours pour le Salon de la Street Food 2026. Piste A de `site/ART_DIRECTION_PROPOSITIONS.md`, choisie par l'utilisateur, figée ici le 2026-11-03. La piste B « Le Dabba » est rejetée : rien n'en est repris (pas de boîte à épices, pas de couronne, pas de pincée de poudre, pas de Rozha One ni de Biryani).

Ce fichier est le **contrat des agents de pages**. Il dit ce que le site est, les noms à employer et les pièges du moteur. Sources de vérité des valeurs : `site/theme.css` (jetons) et `site/pages/shared.css` (primitives de la peinture et mouvement). En cas de désaccord entre ce texte et ces deux fichiers, les fichiers ont raison et ce texte se corrige.

## 1. L'idée

Le mur peint du restaurant de la rue de la Boétie (refonte d'octobre 2023 : graffiti, tuk-tuks, turbans, épices, four tandoor) devient la page. Le fond est un **badigeon à la chaux crème** ; chaque section est un **aplat de peinture murale** frais posé dessus, dans les couleurs de la marque ; **le défilement est le pinceau** : chaque aplat se peint de gauche à droite quand il entre. Les nombres qui comptent sont **peints très grands**, comme une adresse sur un mur.

Le site reste d'abord un site de vente : « Commander » domine chaque écran. La franchise est à part (lien de pied seulement).

Ce que le site n'est pas : l'Inde des affiches (éléphant, mandala, paon, cachemire, fausse barre de tête devanagari, Taj Mahal, « Bollywood »), un bistro, une rue de nuit, un fond noir, une usine, un carton kraft, un lookbook. Il diffère des voisins : pas de coupe d'architecte ni de mono (Chamas Tacos), pas de chaîne de production ni de bord déchiré (Krousty), pas de cadran ni de compte à rebours (O'Crousti), pas de nuit ni de néon (Chicken Street), pas de noir violet ni de mot barré (LÜKS), pas de kraft ni de tampon (O'Tasty), pas d'autocollants, doodles ni blobs (ENJOYYY).

## 2. Répartition des fichiers

| Fichier | Propriétaire | Contenu |
| --- | --- | --- |
| `site/ART_DIRECTION.md`, `site/theme.css`, `site/fonts.ts`, `site/layout.ts`, `site/pages/shared.css` | art director | contrat, jetons, polices, familles de mise en page, primitives (mur, grain, aplats, passe, chiffre peint, dalles, boutons, plafonds d'image, focus, mouvement) |
| `site/pages/chrome.css` | agent « chrome » | en-tête, menu mobile, pied de page, bandeau « fermé », panier latéral et boîtes de dialogue (portails) |
| `site/pages/home.css` + `site/components/home/*` | agent « accueil » | `/` : le héros cinématique, les familles, le bento, « Votre création », « Pour les connaisseurs », histoire, adresse |
| `site/pages/menu.css` | agent « carte » | `/menu`, `/product/[productId]`, **et la carte produit du moteur partout où elle sort** (accueil compris) |
| `site/pages/creation.css` + `site/components/creation/*` | agent « création » | « Votre création » (formules à composer), où qu'elle vive (bloc de l'accueil, catégorie `formules` de la carte, route du site si décidée en phase 6) |
| `site/pages/inner.css` | agent « pages intérieures » | `/about`, `/contact`, `/blog`, `/blog/[slug]`, légal, `/cart`, `/checkout`, `/order/*`, `/track/*`, `/account/*`, `/sign-in`, `/sign-up`, 404 |
| `site/pages/restaurants.css` + `site/components/restaurants/*` | agent « réseau » | `/restaurants` (route du site), `/store-selector` |
| `site/pages/franchise.css` + `site/components/franchise/*` | agent « franchise » | `/franchise` (route du site, lien dans le pied de page seulement) |

**Imports.** `theme.css` importe aujourd'hui `./pages/shared.css` seulement. Un agent qui crée son fichier de page ajoute **sa propre ligne** `@import` dans `theme.css`, juste sous les imports existants, dans cet ordre : shared, chrome, home, menu, creation, inner, restaurants, franchise. N'importe jamais un fichier qui n'existe pas encore (le build casse). C'est, avec le retour à la ligne final (section 17), la seule modification de `theme.css` permise aux autres agents.

**Sélecteurs.** Tout commence par `.storefront-theme` (l'administration n'est jamais touchée). Exception nommée : `body:has(.storefront-theme)` pour les portails Radix (panier, fiche plat, menus déroulants), rendus hors de la coquille. Une pièce commune qui manque se demande à l'art director : elle va dans `shared.css`, jamais copiée dans un fichier de page.

## 3. Couleurs

Couleurs de la marque relevées dans le CSS de kurryup.fr : crème `#fdf3da`, crème d'en-tête `#faf0d6`, orange `#ea5800`, charbon `#373737`, gris `#676767`, vert `#233929`, ocre `#e49142`, sauge `#9fb388`, noir du logo `#010000`. Ratios WCAG 2.1 calculés sur les valeurs HSL arrondies écrites dans `theme.css`.

### Clair « Badigeon » (par défaut)

| Rôle | Jeton moteur | Jeton du site | Hex | Contrastes |
| --- | --- | --- | --- | --- |
| Le mur | `--background` | `--ky-badigeon`, rôle `--ky-sol` | `#FDF3DA` | charbon 10,78 |
| Crème d'en-tête | | `--ky-badigeon-entete`, rôle `--ky-sol-entete` | `#FAF0D6` | charbon 10,49 ; gris 6,17 ; brique 5,41 |
| Dalle de lecture | `--card`, `--popover` | `--ky-dalle-claire`, rôle `--ky-dalle` | `#FFF9EC` | charbon 11,34 |
| Badigeon chargé | `--muted`, `--secondary` | `--ky-chaux`, rôle `--ky-sol-charge` | `#F6E6BF` | charbon 9,63 |
| Texte | `--foreground` | `--ky-charbon`, rôle `--ky-texte` | `#373737` | |
| Texte secondaire | `--muted-foreground` | `--ky-gris`, rôle `--ky-texte-2` | `#5F5850` | 6,34 mur ; 6,67 dalle ; 5,67 chaux |
| Orange (passe, bouton) | `--primary` | `--ky-orange` | `#EA5800` | 3,19 contre le mur (contrôle ≥ 3) |
| Libellé sur orange | `--primary-foreground` | `--ky-encre` | `#1F1712` | 5,01 sur orange |
| Survol orange | `--primary-hover` | `--ky-orange-vif` | `#FF6A12` | encre 6,12 |
| Mot en orange | `--primary-ink` | `--ky-brique`, rôle `--ky-mot` | `#A94000` | 5,52 mur ; 5,81 dalle ; 4,93 chaux ; 4,90 accent |
| Pêche (puce active, survol) | `--accent` | `--ky-peche` | `#FBE3C4` | libellé `#7A2E00` 7,56 ; encre 14,20 |
| Vert (passe verte) | `--accent-solid` | `--ky-vert` | `#233929` | crème dessus 11,26 ; 11,26 contre le mur |
| Bord de champ | `--input` | `--ky-champ` | `#8F7C57` | 3,66 contre le mur |
| Focus | `--ring` | `--ky-focus` | `#C24A00` | 4,45 mur ; 4,68 dalle |
| Filet décoratif | `--border` | `--ky-filet` | `#E8D4A6` | décoratif seulement |
| Ocre | | `--ky-ocre` | `#E49142` | encre dessus 7,08 ; `#3A2A1C` 5,52 |
| Sauge | | `--ky-sauge` | `#9FB388` | encre dessus 7,80 ; `#2B2A1F` 6,38 |
| Logo | | `--ky-logo` | `#010000` | 18,98 sur le mur |

### Sombre « Mur vert » (derrière l'interrupteur du moteur)

Le mur est un vert plus profond que le vert de la marque, pour deux raisons mesurées : les encres sémantiques du moteur (laissées intactes) doivent passer 4,5:1 sur toutes les surfaces sombres et sur leurs teintes /5 et /10 (`#E98181` faisait 3,90:1 sur un muted `#2D4634`), et le vert de la marque doit pouvoir devenir un aplat posé sur ce mur.

| Rôle | Jeton | Hex | Contrastes |
| --- | --- | --- | --- |
| Le mur | `--background`, `--ky-sol` | `#15241B` | crème 14,62 |
| Dalle | `--card`, `--ky-dalle` | `#1B2D21` | crème 13,16 |
| Badigeon chargé | `--muted`, `--secondary`, `--ky-sol-charge` | `#203427` | crème 12,02 |
| Texte | `--foreground`, `--ky-texte` | `#FDF3DA` | |
| Texte secondaire | `--muted-foreground`, `--ky-texte-2` | `#CFC6AB` | 9,48 ; 8,53 ; 7,79 |
| Orange | `--primary` (libellé `#1F1712`) | `#EA5800` | 4,53 contre le mur ; libellé 5,01 |
| Mot en orange | `--primary-ink`, `--ky-mot` | `#FF9A5C` | 7,71 ; 6,95 ; 6,34 ; 6,02 accent |
| Accent | `--accent` / `--accent-foreground` | `#22382A` / `#F5C99A` | 8,22 |
| Ocre relevé | `--accent-solid` (libellé `#1F1712`) | `#EFA45E` | 7,80 ; 7,02 ; 6,41 ; libellé 8,53 |
| Bord de champ / focus | `--input` / `--ring` | `#86A08D` / `#FF8A3D` | 5,71 / 6,89 |
| Aplat vert en sombre | `--ky-vert-champ` | `#2D4634` | crème 9,33 ; `#CFC6AB` 6,05 ; `#FF9A5C` 4,92 ; contre le mur 1,57 (décoratif) |

Les aplats orange, ocre, sauge, crème et charbon **gardent leur couleur** en sombre ; seul le vert passe à `#2D4634` pour se détacher du mur. Les deux modes sont contrôlés. `site.config.ts` garde `default: "system"` et l'interrupteur.

### Règles de couleur

- **Texte blanc sur `#EA5800` interdit** (3,56:1). Un libellé sur orange est l'encre `#1F1712` (5,01). Exception unique : un titre Bungee de **28 px et plus** peut être crème `#FDF3DA` sur orange (3,22:1, texte large) avec `.ky-passe--lettre-creme`.
- **L'orange n'est du texte que pour le chiffre peint** (`.ky-chiffre`, texte très large, 3,22:1 sur le mur). Un mot de marque dans un paragraphe prend `--ky-mot` (brique en clair, orange clair en sombre).
- Orange, vert, ocre et sauge se partagent la page en **aplats entiers** ; **jamais de dégradé** entre deux couleurs ; **une passe ou un aplat orange par écran au plus**.
- Les jetons sémantiques (`--success`, `--warning`, `--info`, `--destructive`, `--status-*`) restent ceux du moteur.
- Utilise les jetons de rôle (`--ky-sol`, `--ky-dalle`, `--ky-sol-charge`, `--ky-texte`, `--ky-texte-2`, `--ky-mot`, `--ky-filet-deco`, `--ky-focus`, `--ky-ombre`, `--ky-ombre-courte`) : ils basculent en sombre et sont redéclarés par chaque aplat. N'écris un hex en dur que pour une peinture fixe (`--ky-orange`, `--ky-ocre`…).
- La marque peut aussi pousser ses couleurs depuis l'administration (`StoreTheme`, couleurs de l'établissement) : si la seed en écrit, elles écrasent `--primary` et les autres sur la boutique. Ne mets aucune couleur de marque dans la seed.

### Les aplats (`.ky-champ--*`, `shared.css` §4)

| Classe | Fond (clair / sombre) | Texte | Secondaire | Mot de marque | Bouton `.ky-btn` dessus | Usage |
| --- | --- | --- | --- | --- | --- | --- |
| `.ky-champ--orange` | `#EA5800` / idem | encre `#1F1712` 5,01 | encre | encre | encre à libellé crème | le sommet de couleur de la page, **un seul par écran** |
| `.ky-champ--vert` | `#233929` / `#2D4634` | crème 11,26 / 9,33 | `#CFC6AB` 7,29 / 6,05 | `#FF9A5C` 5,94 / 4,92 | orange à libellé encre | pied de page, chiffres, « Pour les connaisseurs » |
| `.ky-champ--ocre` | `#E49142` / idem | encre 7,08 | `#3A2A1C` 5,52 | encre | encre à libellé crème | promesse (10 min, 1 h), entrées |
| `.ky-champ--sauge` | `#9FB388` / idem | encre 7,80 | `#2B2A1F` 6,38 | encre | encre à libellé crème | desserts, histoire, calme |
| `.ky-champ--creme` | `#F6E6BF` / idem (crème posée sur le mur vert) | charbon 9,63 | gris 5,67 | brique 4,93 | orange à libellé encre | formulaires, FAQ, mentions |
| `.ky-champ--charbon` | `#373737` / idem | crème 10,78 | `#CFC6AB` 6,98 | `#FF9A5C` 5,68 | orange à libellé encre | naans seulement, rare |

Chaque aplat redéclare pour son sous-arbre les jetons de rôle **et** les jetons texte du moteur (`--foreground`, `--muted-foreground`, `--primary-ink`) : tout ce qui est posé dedans se lit, en clair comme en sombre. Ne repose pas de couleur de texte par-dessus dans un fichier de page.

## 4. Polices (`site/fonts.ts`)

- **Bungee** 400 (David Jonathan Ross), variable `--font-poppins` : les titres. Capitales de signalétique urbaine, la lettre d'un mur peint. Une seule graisse, pas d'italique : `shared.css` met h1 et h2 en 400 et coupe la synthèse (`font-synthesis: none`), parce que le moteur écrit `font-black`, `italic` et `tracking-tighter`. **Réservée aux titres de 28 px et plus** : h1, h2, `.ky-titre`, `.ky-chiffre`. Jamais les coupes Shade, Inline, Outline, Spice, jamais d'ombre portée ni d'extrusion.
- **Mukta** 400, 500, 600, 700, 800 (Ek Type, Mumbai), variable `--font-inter` : le texte. 16 à 18 px courant ; h3 à h6 en Mukta 800 (`shared.css`) ; noms de plats Mukta 800 (`.ky-nom`) ; prix Mukta 700 à chiffres tabulaires (`.ky-prix`) ; libellés de boutons et de rubriques Mukta 800 capitales, approche 0,04 à 0,06 em.
- Sous-ensembles `latin` et `latin-ext` chargés pour les deux. Vérifié au rendu (Chromium sans tête, 2026-11-03) : É È Ê À Ç Œ é è ê à ç œ « » € ’ ô î ù sont dessinés par Bungee et par Mukta (400 et 800), pas par la police de repli.
- Échelle (`shared.css` §2) : `.ky-titre--xl` clamp(2,75 rem, 8,2 vw, 7,5 rem) pour le héros ; `.ky-titre--l` clamp(2,25 rem, 5,4 vw, 4,75 rem) pour une tête de page ou de section ; `.ky-titre--m` clamp(1,75 rem, 3 vw, 2,5 rem) pour un titre de dalle ; `.ky-chiffre` clamp(4,25 rem, 13 vw, 10,5 rem), `.ky-chiffre--m` clamp(3 rem, 7 vw, 5,5 rem) ; `.ky-lead` 17 à 20 px ; `.ky-surtitre` 13 px capitales 0,12 em.
- `layout.ts` : `up: "1"` (titres en capitales ; Bungee l'est déjà).

## 5. Matière et formes (vocabulaire de `shared.css`)

| Nom | Classe | Ce que c'est |
| --- | --- | --- |
| Le mur | automatique | badigeon crème (vert profond en sombre) avec un **grain de truelle** à environ 3 % (`--ky-grain`, bruit SVG de 240 px), posé sur la coquille et sur les enveloppes de page du moteur. Jamais sous une photo ni sur un aplat. `tex: "none"` dans `layout.ts` : le grain est celui du site |
| L'aplat | `.ky-champ` + couleur | une section entière peinte, masquée par la brosse de champ (`--ky-brosse-champ`), **en retrait de `--ky-marge-passe`** (12 à 24 px) des bords de l'écran : bord brossé toujours entier. Padding intérieur généreux |
| La passe | `.ky-passe` + couleur (`--bloc`, `--droite`, `--lettre-creme`) | un coup de brosse large derrière un titre, un mot, un groupe ou une puce (section 6) |
| La mini-passe | `.ky-trace` (`--survol`, `--defile`) | une trace de brosse de 0,32 em sous un mot : rubrique active, lien actif |
| Le chiffre peint | `.ky-chiffre`, `.ky-chiffre--m`, `.ky-chiffre__unite` | Bungee très grand, orange sur le mur, ocre sur vert, encre sur ocre et orange ; unité en Mukta 800 capitales à 0,3 em. Jamais un cadran, jamais un afficheur, jamais un compteur qui défile |
| La dalle | `.ky-dalle`, `.ky-dalle--survol` | crème `#FFF9EC` (vert `#1B2D21` en sombre), coins 14 px, ombre chaude courte, **aucune bordure, aucun filet, aucun cadre**. Au survol : la couche suivante (pêche en clair, vert de la marque en sombre), 160 ms, sans saut ni inclinaison |
| L'étiquette | `.ky-etiquette` | étiquette crème mate posée sur une photo du bento (nom `.ky-nom` + prix `.ky-prix`), coins 6 px, aucun voile sombre sur la photo |
| Le surtitre | `.ky-surtitre` | une touche de brosse ocre de 28 × 10 px puis une ligne Mukta 800 capitales. Ce n'est pas une perle ni un point |
| Le bouton | `.ky-btn` | « Commander » : 48 px de haut, orange de la marque à libellé encre, fond peint par une **touche de brosse courte** (`--ky-brosse-courte`) : coins rognés à la brosse, pas arrondis. Survol : orange vif. Sur aplat orange, ocre ou sauge : encre à libellé crème |
| Le lien d'action | `.ky-lien` | l'action secondaire (« Voir la carte ») : un mot Mukta 800 capitales sur une trace ocre qui s'épaissit au survol. Pas de bouton à contour |
| Le mot | `.ky-mot` | un mot de marque dans un texte : `--ky-mot` |
| Lecteur d'écran | `.ky-sr` | invisible à l'écran, lu par les lecteurs d'écran ; ne cache jamais un titre visible |
| Le mur centré | `.ky-mur` | largeur de contenu `min(1240px, 100% - 2rem)` (3 rem à partir de 768 px) |
| Sous l'en-tête | `.ky-sous-entete` | dégage l'en-tête fixe (`--ky-entete-h` : 68 px, 84 px à partir de 1280 px) |
| Le focus | automatique | contour 3 px décalé de 3 px en `--ky-focus` (brique-orange en clair, orange clair en sombre, encre sur les aplats clairs) |

Formes : coins de dalle 14 px (`--ky-r-dalle`), de photo 10 px (`--ky-r-photo`), de contrôle 6 px (`--ky-r-ctrl`, et `--radius: 0.375rem` pour le moteur). Les bords des aplats et des passes sont **brossés** (masque), jamais arrondis ni droits. Photos : coins à l'intérieur de leur dalle ou de leur aplat (marge d'au moins 12 px), jamais encadrées. Plats détourés : `.ky-cap--detoure`, sans coin ni fond propre, posés sur une passe.

## 6. La passe : technique CSS précise

La passe est un `::before` de l'élément hôte, en `position: absolute; inset: 0; z-index: -1` dans un hôte en `position: relative; isolation: isolate`. Deux opérations indépendantes :

1. **La forme (statique) : un masque SVG.** `mask: var(--ky-brosse) center / 100% 100% no-repeat` (et `-webkit-mask`). Le SVG (`viewBox 0 0 1000 100`, `preserveAspectRatio="none"`, opaque = peint) a une attaque irrégulière à gauche, des doigts de poils et trois stries sèches à droite (règle `evenodd`), un haut et un bas à peine ondulés. Il s'étire à n'importe quelle boîte. Les traces restent **dans** la boîte de l'hôte : rien n'est rogné, à condition que **l'hôte et ses parents ne soient pas en `overflow: hidden`** et que l'hôte ait son padding (0,18 em 0,55 em pour un mot, plus pour `--bloc`). Variantes : `--ky-brosse-champ` (une section, bords plus calmes, `viewBox 0 0 1000 1000`), `--ky-brosse-courte` (bouton, surtitre). Le sens droite-gauche : `.ky-passe--droite` retourne la forme (`transform: scaleX(-1)` sur le `::before`).
2. **Le geste (animé) : un `clip-path`.** Images-clés `ky-peint` : `clip-path: inset(0 100% 0 0)` vers `inset(0 0 0 0)` ; `ky-peint-droite` part de `inset(0 0 0 100%)`. Le masque donne le bord sec final, le `clip-path` balaie. Le texte de l'hôte n'est jamais masqué : seule la peinture se pose.

**Lié au défilement** (`shared.css` §12.4) : l'hôte porte `view-timeline: --ky-passe block` ; son `::before` lit cette timeline nommée (un pseudo-élément ne peut pas être son propre sujet `view()` de façon fiable, la timeline nommée de l'hôte est visible de ses pseudo-éléments).

```css
/* dans @supports (animation-timeline: view()) et @media (prefers-reduced-motion: no-preference) */
.storefront-theme .ky-passe::before {
  animation: ky-peint linear both;            /* le raccourci d'abord… */
  animation-timing-function: var(--ky-ease);  /* cubic-bezier(.22,.8,.16,1) */
  animation-timeline: --ky-passe;             /* …la timeline APRÈS */
  animation-range: entry 10% entry 55%;       /* un aplat .ky-champ : entry 0% entry 40% */
}
```

Ce qui est déjà à l'écran au chargement a déjà dépassé sa plage : il est peint. **Au chargement** (héros, tête de page dans le premier écran) : ajoute `.ky-passe--charge` et un délai `style="--ky-d: 300ms"` ; durée `--ky-t-passe` (500 ms), même courbe. **Immobile** : `.ky-passe--fixe` (puces, étiquettes, tout ce qui ne doit pas bouger).

**Replis.** Sans `animation-timeline` (Safari ancien, Firefox sans drapeau) : le bloc `@supports` ne s'applique pas, la passe est peinte d'emblée. `prefers-reduced-motion: reduce` : aucune règle de mouvement ne s'applique, tout est peint et visible. Sans script : rien ne dépend d'un script. **L'état par défaut de tout ce qui bouge est son état final.**

## 7. Grammaire de mouvement

Une seule grammaire pour tout le site. Images-clés nommées dans `shared.css` (ne pas les redéfinir) : `ky-peint`, `ky-peint-droite`, `ky-jet`, `ky-trace`, `ky-recouvre`, `ky-volet`. Courbe unique `--ky-ease` = `cubic-bezier(.22,.8,.16,1)` ; changement de couche `--ky-ease-couche` = `cubic-bezier(.4,0,.2,1)`.

| Nom | Classe | Où | Quoi | Durée ou plage |
| --- | --- | --- | --- | --- |
| **La passe** (signature) | `.ky-passe`, `.ky-champ` | toutes les pages | l'aplat se peint de gauche à droite (`--droite` : de droite à gauche) | défilement `entry 10%` à `entry 55%` (aplat : `entry 0%` à `entry 40%`) ; au chargement 500 ms + `--ky-d` |
| **Le jet** | `.ky-jet` (défilement), `.ky-jet--charge` (héros), enfants avec `style="--i: n"` | titres de section, groupes courts | chaque ligne monte de 0,35 em en fondu, l'une après l'autre | défilement : plage décalée de 4 % par rang ; chargement : 520 ms, 70 ms d'écart. Une ligne n'est jamais cachée plus de 300 ms ; rien n'est caché au-dessus de la ligne de flottaison en dehors du héros |
| **La trace** | `.ky-trace--survol`, `.ky-trace--defile` | rubriques, liens, mots qui entrent | une mini-passe pousse depuis la gauche sous le mot | 160 ms au survol ; défilement `entry 30%` à `entry 80%` |
| **Le recouvrement** | `.ky-recouvre` | ordinateur ≥ 1024 px seulement, un par page au plus | un aplat glisse de 6 svh (`--ky-recouvrement`) sur la couche précédente pendant qu'il traverse l'écran ; aucune perspective | `view()` `cover 0%` à `cover 100%` |
| **La couche suivante** | `.ky-dalle--survol`, `.ky-btn`, puces | cartes, boutons, puces | la couleur change d'une couche (crème vers pêche, orange vers orange vif, ocre vers orange, sauge vers vert) ; pas d'inclinaison, pas de saut, pas d'agrandissement de photo | 160 ms |
| **Le volet** | `ky-volet` | menu mobile | le grand aplat vert s'ouvre de gauche à droite (`clip-path`) | `--ky-t-menu` 380 ms |

Règles :

- Mouvement seulement dans `@media (prefers-reduced-motion: no-preference)` ; mouvement lié au défilement seulement dans `@supports (animation-timeline: view())`.
- Le raccourci `animation` réinitialise `animation-timeline` et `animation-range` : déclare-les **après** lui, dans la même règle. Une règle postérieure qui reprend le raccourci les efface.
- Deux animations sur un même élément ne touchent jamais la même propriété : `.ky-jet` et `.ky-recouvre` utilisent tous deux `translate`, ne les mets pas sur le même nœud.
- **3D avec modération** : au plus une scène courte par page (le héros de l'accueil est la seule scène de l'accueil), titres à plat, aucune inclinaison, aucune extrusion, aucune touche de clavier, aucune carte qui pivote.
- Aucun carrousel, aucune rotation automatique, aucun bandeau de mots défilant, rien qui clignote.
- Un mouvement piloté en JavaScript (dans `site/components/SiteEffects.tsx` seulement) lit `prefers-reduced-motion` et pose directement l'état final sous `reduce`.

## 8. Plafonds d'image

**Aucune image ne remplit un écran de téléphone ou de tablette.** Les images `fill` de Next vivent dans une boîte dont on plafonne la hauteur (`.ky-cap*`), jamais l'`<img>` elle-même.

| Boîte | Téléphone (< 768 px) | Tablette (768 à 1023 px) | Ordinateur (≥ 1024 px) |
| --- | --- | --- | --- |
| `.ky-cap--hero` (`--ky-cap-hero`) : le plat du héros | `min(42svh, 300px)` | `min(48svh, 440px)` | `min(64svh, 600px)` |
| `.ky-cap` (`--ky-cap-scene`) : photos de scène et de page | `min(40svh, 360px)` | `min(52svh, 520px)` | `min(70svh, 640px)` |
| `.ky-cap--plat` (`--ky-cap-plat`) : cartes et bento, ratio 4/3 | `min(30svh, 240px)` | `min(32svh, 280px)` | 300 px |

Plafond absolu (proposition A) : jamais plus de 62 svh au téléphone, 70 svh à la tablette, toutes images cumulées sur un même écran. Un plat détouré prend `.ky-cap--detoure` (`object-fit: contain`). Images générées en phase 5, aucune photo de kurryup.fr ; mention « Illustration générée par IA » dans les mentions légales et le crédit.

## 9. Le héros de l'accueil

### Cinématique (le « waouh », CSS au chargement, 1,4 s, puis rien)

Composition : mur crème ; à gauche le titre en trois lignes « FRESH INDIAN / STREET FOOD / À PARIS » (`.ky-titre--xl`), le chapeau « Compose ton bowl en 2 minutes, ou prends un classique. », « Commander » (`.ky-btn`) et « Voir la carte » (`.ky-lien`) ; à droite le plat signature détouré (butter chicken et riz basmati) ; en bas une bande ocre avec deux chiffres peints « 10 MIN retrait sur place » et « 1 H MAX livraison ».

| Temps | Ce qui se peint | Moyen |
| --- | --- | --- |
| 0 à 500 ms | une passe orange traverse derrière la première ligne « FRESH INDIAN » | `.ky-passe--orange.ky-passe--charge.ky-passe--lettre-creme`, `--ky-d: 0ms` |
| 0 à 450 ms | les trois lignes du titre arrivent | `.ky-jet--charge`, `--i` 0, 1, 2 |
| 300 à 800 ms | une passe verte part de la droite derrière le plat | `.ky-passe--vert.ky-passe--droite.ky-passe--charge.ky-passe--bloc`, `--ky-d: 300ms` |
| 700 à 1 100 ms | le plat se pose sur la passe verte | `ky-jet` sur le plat (opacité et 0,35 em), délai 700 ms |
| 900 à 1 400 ms | la bande ocre peint la promesse | `.ky-champ--ocre.ky-passe--charge`, `--ky-d: 900ms` |

- Le titre passe en crème là où il croise l'orange : la première ligne est dans la passe à lettre crème (titre large, 3,22:1).
- Au défilement (≥ 1024 px) : la passe verte et la bande ocre s'écartent de 6 svh (`.ky-recouvre` sur l'une des deux seulement), le plat reste.
- « Commander » est visible dès le premier affichage (jamais retardé) et reste l'action la plus forte de l'écran.
- Habillage du moteur : le héros est `section.storefront-hero` (en `bg-primary`, orange, avec `md:rounded-b-[6rem]`) ; `hero: "banner"` retire la courbe. L'agent accueil le repeint en mur crème (`background: transparent`) et y pose ses passes, ou le remplace par son composant si le DOM ne suffit pas.

### Alternative statique

La même composition, passes déjà peintes, aucun délai, une seule image (le plat détouré, image LCP, jamais retardée). C'est aussi l'état `prefers-reduced-motion`, l'état sans `animation-timeline` et l'état sans script.

### Téléphone et tablette

Le plat passe sous le titre, plafonné à `--ky-cap-hero` (42 svh au plus au téléphone) ; les passes pleine largeur gardent `--ky-marge-passe` (au moins 12 px) de mur de chaque côté pour que la trace de brosse reste entière.

### Hero vidéo : « le film peint »

- **L'idée** : le film de la marque est peint sur le mur. Une fenêtre 3:2 au bord de brosse (`--ky-brosse-champ`, entière, en retrait) remplace le plat ; elle se peint de gauche à droite par-dessus le plat (`ky-peint`, 900 ms) dès que la première image est prête, jamais avant 1,4 s (fin de la cinématique). Dans le film, chaque changement de plan est **une passe de pinceau** cuite dans la vidéo (front sec à poils, stries en avance, bord crème mouillé) ; la dernière passe repeint le premier plan, la boucle est sans couture. La passe verte glisse sous la fenêtre et devient la couche sur laquelle le film est peint (par `transform`, sans décalage de mise en page). Les chiffres « 10 MIN » et « 1 H MAX » restent peints sur la bande ocre.
- **Plans** (secondes de la source) : l'enseigne (plaque « INDIAN STREET FOOD » 9,96 à 11,12, « Feel good Vibes » 11,2 à 12,32, auvent vert « KURRY UP » 5,48 à 6,6) ; le poulet tikka à la pince (21,72 à 23,56, 26,0 à 28,24) ; le bol composé (28,32 à 29,64, 30,76 à 31,64, 31,72 à 33,28) ; le naan (42,24 à 42,72, 43,6 à 45,32, 45,4 à 46,9). Boucle de 12,4 s, étalonnage chaud léger, sans son.
- **Fichiers** : `site/tools/video.mjs` (reproductible, source `site/source/video/`, jamais servie) ; `public/brand/video/kurry-film-1080.{mp4,webm,webp}` (768 px et plus, 1,98 Mo) et `kurry-film-720.*` (téléphone, 0,99 Mo). Composant `site/components/home/HeroFilm.tsx`, monté par `SiteEffects.tsx`, portail dans `.storefront-hero-media` (case de grille déjà réservée : aucun CLS). Styles : `home.css` §1.1.
- **Replis** : le plat du moteur (image LCP) reste l'image du héros sans script, sous `prefers-reduced-motion`, avec Save-Data, si la lecture est refusée ou échoue. Pause hors écran et onglet caché ; bouton pause (WCAG 2.2.2) en touche de brosse crème. Droits à l'image à confirmer (`A_COMPLETER.md`).

## 10. Le chrome (`chrome.css`)

### Header v2 : « La façade » (enseigne, auvent, plaque)

Retour de l'utilisateur (2026-11-03) : l'en-tête v1 (barre crème, logo sur l'axe, rubriques réparties de part et d'autre) ressemblait à ceux des autres sites, et le vrai logo manquait. La v2 reprend la devanture réelle de la rue de Washington (film de la marque) : une enseigne, un auvent vert à lettres crème, une plaque.

Balisage moteur (`components/storefront/storefront-header.tsx`), inchangé : `header.fixed > div.storefront-nav > a.storefront-nav-brand (img), nav.storefront-nav-links, div.storefront-nav-actions, div.lg:hidden (panier, burger)`.

- **Le mur** : la barre est le badigeon d'en-tête (`--ky-sol-entete`, vert mur en sombre) avec le grain, opaque dans les deux états, même hauteur au repos et défilé (`--ky-entete-h` : 68 px, 84 px dès 1280 px). Pas de bordure ni d'ombre.
- **Deux surfaces peintes sur une seule rangée de grille** (`auto | 1fr | auto | auto`), de gauche à droite comme en passant devant la boutique :
  1. **L'enseigne** : une touche sauge (`--ky-brosse-courte`) qui porte le **vrai logo** en encre (`public/brand/logo/kurry-up.svg`, peint par un masque de `kurry-up-mot.svg`, le mot seul : la ligne « INDIAN STREET FOOD » ferait moins de 3 px). Encre sur sauge dans les deux modes. Aucun slogan à côté.
  2. **L'auvent** : le `::before` de la rangée (un pseudo-élément de grille est un élément de grille), une passe verte (`--ky-vert-champ`) au masque `--ky-brosse` avec une lèvre basse plus sombre de 8 px (le lambrequin). Dès 1280 px il porte les rubriques (Carte, Votre création si la route existe, Restaurants, Notre histoire, Contact ; accueil et blog restent au pied et au menu) en Mukta 800 capitales crème **à ombre portée peinte** (0,1 em, `#0B140E`), comme les lettres de l'auvent réel, puis les icônes crème (thème, panier, compte). Rubrique active : passe ocre derrière le mot, lettres encre (7,08:1). Survol : trace ocre sous le mot. Focus orange clair (6,2:1 sur le vert). Pastille du panier ocre à chiffres encre.
- **Pas de plaque** : le bouton « Commander » de la barre a été retiré à toutes les largeurs (demande du client, 2026-11-04). L'auvent court jusqu'au bout de la rangée ; la carte reste la première rubrique.
- **Sous 1280 px** : la même façade, compacte : enseigne, auvent (panier, burger). Rien n'est centré.
- **Menu mobile « le store »** : la rangée du haut répète la barre (enseigne, auvent avec la croix à la place du burger), puis le store se déroule depuis le haut (`clip-path`, `ky-chrome-store`, 380 ms) et découvre le mur, où chaque rubrique est un **essai de peinture** en Bungee : une passe au masque `--ky-brosse`, alternativement depuis la gauche et depuis la droite, en lavis de 34 % de sa couleur (ocre, sauge, vert, charbon). La rubrique où l'on est, et celle sous le doigt ou le focus, est peinte en plein. Les passes se peignent l'une après l'autre (55 ms). Fermeture : le store remonte. Focus piégé, Échap, défilement verrouillé : `menu-behaviour.ts`, inchangé. Sous `reduce` : aucune animation.
- **Pied de page** : le logo complet en crème (`kurry-up-creme.svg`) dès 1024 px, où sa ligne basse dépasse 7 px ; le mot seul (`kurry-up-mot-creme.svg`) en dessous. Les variantes et l'icône 192 px (le K du logo en encre sur l'orange) sortent de `site/tools/logo-variants.mjs`.
- **Ce qui la distingue des autres sites** : aucun logo centré ni rubriques réparties autour, aucune barre pleine d'une couleur, aucune pilule flottante, aucun verre flouté, aucun médaillon qui pend ; c'est une suite de surfaces peintes qui se chevauchent sur le mur, et un menu en nuancier qui se déroule du haut.

### Bandeau « restaurant fermé »

Moteur : `.storefront-theme > div.fixed.top-0.h-10` en `bg-destructive/5` **translucide** : au-dessus du héros orange, son texte rouge devient illisible (vu à l'écran le 2026-11-03). Le chrome lui donne un fond opaque `--ky-sol-entete` et garde le texte `--destructive` du moteur (`#C01111` sur `#FAF0D6` : 5,4:1 ; `#E98181` sur le mur sombre : 6,09:1).

### Pied de page

Moteur : `footer.storefront-footer.bg-primary-hover` (orange vif par défaut, libellés `text-primary-foreground`) > `div.max-w-7xl` > `div.storefront-footer-cols` (marque `h2.storefront-footer-brand`, phrase, coordonnées, colonnes `h3` + `nav`, newsletter `form`) puis `div.storefront-footer-note`.

- Un grand **aplat vert** (mêmes jetons que `.ky-champ--vert`) dont le bord haut est une trace de brosse entière, en retrait de `--ky-marge-passe`. Repose les `text-primary-foreground` en crème et `--muted-foreground` en `#CFC6AB`.
- Chiffres peints « 10 MIN » et « 1 H » en ocre, la promesse écrite en entier dessous (« Retrait en 10 minutes sur place, livraison en 1 heure max »).
- Colonnes : La carte (familles), Restaurants, Maison (Notre histoire, Contact), Légal ; puis une ligne discrète « Ouvrir un Kurry Up » (`a[href="/franchise"]`, entrée `nav` footer dans `site/routes.ts`) ; puis les réseaux (Instagram, Facebook) en icônes sans disque ni bordure, cible de 44 px. **Aucun montant de franchise.**
- Champ de newsletter à bord `#86A08D` (4,40 sur `#233929`, 3,65 sur `#2D4634` en sombre : ≥ 3 pour un bord de champ), bouton orange à libellé encre.

### Portails

Panier latéral, fiche plat, menus déroulants : rendus hors de `.storefront-theme`. Ils lisent les jetons de `:root` (déjà les nôtres). Vise-les par `body:has(.storefront-theme) [data-slot="sheet-content"]`, `body:has(.storefront-theme) [role="dialog"]`. Les peintures `--ky-*` ne sont définies que sur la coquille et sur `body:has(.storefront-theme)` pour les masques et le grain : écris toujours un repli (`var(--ky-orange, #ea5800)`). Panier : une dalle crème, total en `.ky-prix`, bouton orange à libellé encre.

## 11. La carte (`/menu`, `menu.css`)

DOM du moteur (`app/(storefront)/menu/_components/MenuContent.tsx`), à respecter :

- Racine `div.min-h-screen.overflow-x-hidden.pt-20`. **`shared.css` la passe déjà en `overflow-x: clip`** (toutes les enveloppes `main > div.min-h-screen`) : c'est ce qui rend `position: sticky` possible. Ne remets jamais `overflow: hidden` ni `auto` sur un ancêtre des onglets.
- Tête : `section.bg-primary` (orange, libellés encre) avec titre, badge, recherche. Devient **une passe orange pleine largeur** (`--ky-brosse` en masque, retrait `--ky-marge-passe`), « LA CARTE » en Bungee crème (`.ky-passe--lettre-creme`, titre large), la promesse en Mukta encre dessous. Les bulles floues décoratives du moteur sont masquées.
- **Familles = puces `<button>` qui filtrent par l'URL `?category=<slug>`** (`handleCategorySelect` → `updateSearchParams("category", slug)`), pas des ancres. Pas d'attribut de slug sur les boutons : la couleur de chaque puce se pose par rang (`:nth-child`), après vérification de l'ordre réel dans le DOM. Ordre attendu (seed, `CATEGORY_SLUGS`) : 1 « ✨ Tout » (masquer l'emoji `span`), 2 Formules, 3 Entrées, 4 Plats poulet, 5 Plats agneau, 6 Légumes, 7 Biryanis, 8 Naans, 9 Desserts, 10 Boissons. Échantillons : Tout charbon, Formules orange, Entrées ocre, Plats poulet orange, Plats agneau vert, Légumes sauge, Biryanis vert, Naans crème sur charbon, Desserts sauge, Boissons ocre. La puce active (`bg-primary` dans le DOM) est **peinte pleinement** (masque `--ky-brosse`, `.ky-passe--fixe` : pas d'animation), les autres sont une trace légère (même masque à 25 % d'opacité de leur couleur) ; aucune bordure (`border-2` du moteur à neutraliser).
- **Onglets collants** : la rangée des puces est `div.overflow-x-auto` dans `section.py-12` ; rends la `section` (ou un parent direct de la rangée) `position: sticky; top: var(--ky-entete-h)` avec le fond `--ky-sol` et le grain, et garde le défilement horizontal de la rangée (accroche `scroll-snap-type: x proximity`) au téléphone. Vérifie que rien entre la racine et la rangée n'est en `overflow` autre que `visible` ou `clip`.
- Textes en dur du moteur (« Affichage : », « Trier par : », « Filtres », « Disponible ») : se restylent, ne se changent pas.
- En-tête de chaque groupe : une passe de la couleur de la famille, le **chiffre peint** du nombre de plats (`.ky-chiffre--m`) et le nom en Bungee.
- **Cartes produits** : dalles `.ky-dalle` crème posées sur le mur, ombre douce, aucun filet ; photo `.ky-cap--plat` aux coins intérieurs ; nom `.ky-nom`, prix `.ky-prix` ; au survol la dalle prend la couche suivante (pêche), **sans agrandir la photo**, sans inclinaison. Bouton d'ajout orange à libellé encre.
- La page produit `/product/[productId]` : photo plafonnée `.ky-cap`, nom en Bungee, une passe de la couleur de sa famille derrière le titre, options en dalles crème.

## 12. « Votre création » (`creation.css`)

Les formules à composer de la marque : Bowl Kurry Up 12,40 €, Sandwich à composer 10,90 €, Menu Kurry Up 14,90 € (1 protéine, 3 légumes, 3 toppings ; plus naan et boisson pour le menu), prix du catalogue en ligne, à confirmer (`site/A_COMPLETER.md`). Dans la seed elles sont des produits à options de la catégorie `formules`.

- **Trois passes successives, une par étape** : « 1 protéine » (orange), « 3 légumes » (sauge), « 3 toppings » (ocre), puis « naan et boisson » (vert) pour le menu. Chaque étape est un aplat ; une étape terminée est peinte pleinement, l'étape en cours se peint, les suivantes sont une trace légère.
- Le compteur d'étape (« 2 sur 3 ») est un **chiffre peint** (`.ky-chiffre--m`), pas une barre de progression ni un cadran.
- Le prix se met à jour en `.ky-prix` grand format.
- Habillage d'abord sur le DOM réel (fiche produit à options, `formule-card` si les formules du moteur sont utilisées) ; vérifie le balisage avant d'écrire. Le moteur limite « 3 au plus », pas « exactement 3 » : le texte dit « jusqu'à 3 ». Si le DOM ne permet pas les étapes, une route `// SITE-SPECIFIC` est à décider en phase 6 (ne la crée pas sans accord).
- Accueil : le bloc « Votre création » reprend « composez votre plat préféré en 2 minutes » de la marque, tutoyé (« Compose ton plat en 2 minutes »), sur un aplat orange (le seul de son écran).

## 13. Restaurants (`restaurants.css`) : « Le mur des adresses »

Chaque restaurant est un aplat portant son **chiffre peint** très grand (« 8e », « 17e », « 2e », « 9e », puis Lyon, Neuilly-sur-Seine, Rennes, Massy, Saint-Denis de La Réunion), en mosaïque de tailles variées, comme des couches sur un mur (grille CSS à cellules de tailles différentes, jamais un carrousel ni une liste de mots). Couleurs tournantes ocre, sauge, vert, crème ; un seul orange par écran. Paris Washington (seule boutique du moteur) porte « Commander ici » (`.ky-btn`) et ses horaires relevés (11 h à 22 h 30, 7 j sur 7) ; les autres viennent de `site/components/network.ts` avec « Horaires à confirmer » et leur statut. Une passe par aplat au défilement, rien de plus. Le nombre total du réseau ne s'affiche qu'avec « selon la marque ». Carte géographique : aucune tuile tierce sans accord.

## 14. Franchise (`franchise.css`)

Lien **dans le pied de page seulement** (« Ouvrir un Kurry Up »), jamais dans l'en-tête, aucune bannière sur l'accueil, la carte ni la commande. **Aucun montant** (droit d'entrée, redevances, investissement). Citations autorisées : « Street food indien nouvelle génération », « Ouvrez un restaurant sans extraction » (à tutoyer : « Ouvre un restaurant sans extraction »), « Kurry Up s'adapte aux villes, pas l'inverse ». Même grammaire que le reste : une tête en passe verte, les arguments en aplats sauge et ocre avec chiffres peints quand un chiffre est sourcé, formulaire de démonstration sur un aplat crème (valide, confirme à l'écran, n'envoie rien).

## 15. Une ligne par type de page

| Page | Ligne |
| --- | --- |
| Accueil `/` | héros cinématique (section 9), puis les familles en échantillons de peinture, le bento des plats signature sur une passe verte (grande tuile poulet tikka massala, large butter chicken, petites poulet tikka et poulet korma ; **vérifier d'abord quelles cartes réelles le moteur sort**), « Votre création » sur l'aplat orange, « Pour les connaisseurs » sur aplat vert, l'histoire sur sauge (Mahatma 1965, Kurry Up 2015), Paris Washington, réseaux et newsletter |
| Carte `/menu`, produit | section 11 |
| Intérieures `/about`, `/contact`, `/blog`, article | tête de page en passe d'une couleur par page (histoire sauge, contact ocre, blog vert), titre Bungee, chapeau `.ky-lead`, corps en dalles crème sur le mur, un aplat de couleur au moins plus bas, `.ky-jet` sur les titres ; jamais une page crème plate |
| Commande `/cart`, `/checkout`, `/order/*`, `/track/*` | tête en mini-passe ocre, récapitulatif en dalle crème, total en chiffre peint moyen, « Commander » orange à libellé encre ; sobre, aucune animation qui retarde un champ |
| Compte et connexion `/account/*`, `/sign-in`, `/sign-up` | une passe verte derrière le titre, formulaire dans une dalle crème centrée, bords de champ `--input`, focus visible |
| Légal `/mentions-legales`, `/cgv`, `/confidentialite` | titre sur passe charbon, texte long en Mukta 17 px dans une dalle, sommaire collant à gauche sur ordinateur ; mention « Illustration générée par IA » |
| Réseau `/restaurants`, `/store-selector` | section 13 |
| Franchise `/franchise` | section 14 |
| 404 | le chiffre peint « 404 » très grand en orange, une passe verte « Cette page n'est pas sur le mur », « Voir la carte » |

Chaque page intérieure a de la couleur (au moins une passe et un aplat), de l'échelle (un titre Bungee de tête de page ou un chiffre peint) et du mouvement (passe et jet au défilement). Aucune page ne reste fade à côté de l'accueil.

## 16. Ce qu'on ne fait pas

- Pas de coulures de peinture, pas de bombe aérosol dessinée, pas de faux tag signé, pas de mascotte tuk-tuk, pas de turban dessiné, pas de traits de crayon ni de doodles, pas d'autocollants, pas de mots en contour empilés, pas de titres penchés.
- Pas d'ornement indien (mandala, cachemire, paon, éléphant, arches mogholes), pas de police pseudo-devanagari, pas de Bungee Shade ni d'ombre portée sur les titres.
- Pas de fond noir par défaut, pas de thème sombre comme look principal ; le sombre reste derrière l'interrupteur.
- Pas de dégradé entre deux couleurs, pas de plus d'un orange par écran, pas de texte blanc sur l'orange, pas d'orange en texte courant.
- **Pas de cadre** autour des éléments ronds ordinaires (boutons d'icône, pastilles, avatars) ; pas de filet ni de bordure sur les dalles ; aucun cadre coupé au ras de son contenant : tout bord brossé est entier, en retrait.
- Pas de perles, de chapelets ni de séparateurs en points (en-tête, listes, surtitres).
- Pas de slogan à côté du logo ; pas de logo inventé ; pas de photo de kurryup.fr.
- Pas de carrousel, pas de rotation automatique, pas de bandeau défilant, pas de 3D au-delà d'une scène courte par page, pas d'inclinaison au survol, pas d'agrandissement des photos au survol.
- Pas de « halal », pas de montant de franchise, pas de vouvoiement, pas de tiret cadratin dans le texte lu, pas de franchise dans l'en-tête.
- Aucune image qui remplit un écran de téléphone ou de tablette.

## 17. Pièges techniques connus

- **CSS de dev** : après chaque modification d'un fichier `site/pages/*.css`, bascule le retour à la ligne final de `site/theme.css` et attends environ 4 s : les fichiers importés ne reconstruisent pas le CSS de dev autrement.
- **Sticky** : `position: sticky` meurt sous un ancêtre en `overflow: hidden|auto`. Les enveloppes du moteur (`main > div.min-h-screen`) sont `overflow-x-hidden` ; `shared.css` les passe en `overflow-x: clip`. Un fichier de page ne remet jamais `hidden` sur un ancêtre d'élément collant ; pour rogner, utilise `clip`.
- **Onglets de la carte** : filtre par `?category=` (boutons, pas d'ancres) ; pas de slug dans le DOM des puces ; la rangée elle-même est `overflow-x-auto` (le collant va sur son parent). La page a de la pagination.
- **Timeline** : `animation` (raccourci) réinitialise `animation-timeline` et `animation-range` : déclare-les après. Une timeline nommée (`view-timeline: --ky-passe block`) est visible des descendants et des pseudo-éléments de l'hôte.
- **Masques** : écris toujours `mask` et `-webkit-mask` (Safari). Un hôte de passe ne doit pas être en `overflow: hidden` (la trace serait rognée) ; si une photo doit être rognée, rogne la boîte de la photo, pas l'aplat.
- **Polices** : le moteur écrit `font-black`, `italic`, `tracking-tighter`, `tracking-widest`, `uppercase` sur ses titres et libellés ; `shared.css` neutralise graisse, italique et approche des titres. Bungee n'a qu'une graisse.
- **En-tête transparent** : en haut de l'accueil le moteur écrit `text-white` sur le logo, les rubriques et les boutons ; sur un mur crème c'est invisible. Le chrome les repose en charbon.
- **Bandes `bg-primary` du moteur** (héros d'accueil, tête de carte, menu mobile, puce active) : orange à libellé encre, lisibles telles quelles ; les repeindre est un choix de page, pas une obligation.
- **Couleurs de l'établissement** : `StoreTheme` peut écraser les jetons depuis l'administration ; la seed n'écrit aucune couleur.
- **Hydratation** : ne touche pas au texte ni au `className` rendus par React depuis un script ; pose des attributs `data-ky-*` ou des classes sur tes propres composants.
- **Origine** : `http://localhost:3500`, jamais `127.0.0.1` (le serveur de dev bloque l'autre origine).

## 18. Contrôle

- `pnpm design:check` (via `rtk pnpm design:check`) passe : contrastes des jetons dans les quatre portées (admin et boutique, clair et sombre) et balayage du balisage du moteur sous `site/theme.css`. Un fichier de page qui change une couleur relance la commande.
- Page-lint aux quatre largeurs, en clair et en sombre, en phase 7 ; captures par défilement (une capture pleine page laisse les passes dans leur état « avant »).
- Un test WebKit : sans `animation-timeline`, toutes les passes sont peintes et la page se lit pareil.
