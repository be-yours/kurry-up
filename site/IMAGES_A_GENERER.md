# Images de Kurry Up (piste « La Fresque »)

Phase 5, 2026-11-03. Tous les visuels sont des **illustrations générées par IA** (`openai/gpt-image-2` via le MCP studio, taille explicite). Aucune image, aucun logo ni aucune photo de la marque n'a été téléchargé, regardé ou copié.

**Mention visible à porter (pied de page, mentions légales, crédit) : « Illustrations générées par IA »** (au singulier dans une légende : « Illustration générée par IA »). L'alt des images du seed la porte déjà.

Maîtres (jamais servis) : `site/source/gen/<nom>/*.png`, avec le prompt exact de chaque génération dans le `.json` voisin. `site/source/ref-*.webp` sont les références de style envoyées au modèle (un détail de la sortie, pas des images de la marque). Construction : `node site/tools/images.mjs` (WebP, variantes `-sm`) vers `public/brand/`. Le script écrit aussi le logo provisoire, l'icône et la carte de partage, puis vérifie le contrat du seed (`MEDIA` de `site/seed/data.mjs`).

## Style commun

Photographie culinaire d'éditorial, vue à environ 40 degrés, lumière du jour chaude venant du haut gauche, ombre de contact courte. Vaisselle : bols en céramique mate **vert profond `#233929`**, plateaux en inox brossé, verres clairs. Fond des produits : badigeon **crème `#F4EADA`** (tous les planches sont ramenées à ce fond). Scènes : même lumière, mur crème avec aplats orange, vert, ocre et sauge de la Fresque. Aucun texte, aucune lettre, aucun logo, aucun emballage imprimé, aucun visage (seulement les avant-bras d'un cuisinier sur la scène du tandoor), aucun éléphant ni mandala, aucun mot « halal ».

## Rôles et fichiers (`public/brand/`)

| Rôle | Fichier | Taille | Maître |
| --- | --- | --- | --- |
| Héros : butter chicken, riz basmati et naan sur plateau inox, **détouré (alpha)** | `hero/street-food.webp` (+ `-sm` 602 px de large) | 1203x762, transparent | `gen/hero` (fond sauge uni `#9FB388` retiré par remplissage depuis les bords) |
| Scène façade (mur peint orange, vert, ocre, sauge, piments et feuilles) | `scenes/facade.webp` (+ `-sm` 960x540) | 1920x1080 | `gen/facade` |
| Scène comptoir (bac chaud, curries, toppings, bols verts, arches peintes) | `scenes/counter.webp` (+ `-sm`) | 1920x1080 | `gen/counter` |
| Scène tandoor (four en terre, naan plaqué, brochettes tikka) | `scenes/tandoor.webp` (+ `-sm`) | 1920x1080 | `gen/tandoor` |
| Produits (47, un par produit de `IMAGES_PRODUITS_LISTE.json`) | `products/<slug>.webp` | 800x800 | `gen/sheet-1` à `sheet-8` |
| Variantes produit | `products/<slug>-sm.webp` | 400x400 | idem |
| Bonus : trio de chutneys et naan (hors contrat, pas de produit) | `products/extra-chutneys.webp` (+ `-sm`) | 800x800 | `gen/sheet-8` |
| Logo **provisoire** | `logo/kurry-up.svg` | vectoriel | dessiné dans `images.mjs` |
| Icône **provisoire** | `icon-192.png` | 192x192 | dessinée dans `images.mjs` |
| Carte de partage | `og-default.jpg` | 1200x630, aucun texte | recadrage de `gen/facade` |

### Logo à fournir

`logo/kurry-up.svg` n'est **pas** le logo de la marque : ce sont les lettres « KURRY UP » en traits géométriques noirs `#010000`, un marqueur sobre. Le titre accessible du SVG dit « logo provisoire, à fournir par la marque ». `icon-192.png` est un carré orange `#EA5800` avec un K en encre `#1F1712`, tout aussi provisoire. **Le logo de la marque est à fournir** (ligne à ajouter dans `site/A_COMPLETER.md` par l'orchestrateur) ; l'en-tête du site rend le nom en Bungee tant que le logo du CMS n'est pas posé.

## Planches produits (3 colonnes x 2 lignes, ordre de lecture)

| Planche | Produits |
| --- | --- |
| 1 | butter-chicken, poulet-tikka-massala, poulet-korma, poulet-karahi, agneau-karahi, palak-paneer |
| 2 | menu-kurry-up, bowl-kurry-up, biryani-poulet, samossa, naan-fromage, lassi |
| 3 | poulet-tikka, cookie-chocolat-au-lait, pakora, samossa-chaat, raita, soupe-de-lentilles |
| 4 | salade-raja, salade-rani, agneau-madras, agneau-shahi-korma, daal-tarka, aubergine-massala |
| 5 | chana-massala, biryani-legumes, biryani-agneau, biryani-crevettes, naan-nature, naan-ail |
| 6 | naan-ail-fromage, chapati, naan-chocolat-noisette, cookie-caramel-cacahuete, fromage-blanc-mangue-muesli, sandwich-a-composer |
| 7 | mousse-au-chocolat, mangue-menthe, the-indien, eau-de-coco, kombucha, jus-indien-25-cl |
| 8 | eau-33-cl, soda-33-cl, the-glace-33-cl, the-glace-50-cl, biere-indienne-33-cl, extra-chutneys |

Découpe (`images.mjs`) : masque du sujet par écart au fond de la planche, coupes dans les vides entre cellules, carré centré sur le sujet avec 16 % de marge (660 à 1000 px de côté), tout ce qui sort de la cellule repeint au fond crème, redimensionné à 800 px. Chaque sujet est centré avec au moins 9 % de marge : un recadrage 4:3 (`.ky-cap--plat`) ou 1:1 le supporte sans couper le plat.

### Produits inventés ou approximatifs (à valider avec la marque)

- Salade Raja (poulet tikka tranché) et Salade Rani (variante végétarienne : samossa émietté, pois chiches) : la marque n'a pas de description, les compositions sont inventées.
- Menu Kurry Up : un curry, riz, naan, deux samossas et un lassi mangue sur un plateau ; Bowl Kurry Up : poulet tandoori, riz, haricots verts, poivron, oignons caramélisés, raïta, cacahuètes, menthe.
- Sandwich à composer : galette grillée garnie de poulet tikka, une interprétation.
- Boissons : bouteilles et canettes volontairement **sans étiquette** (aucune marque). Eau 33 cl sans distinction plate ou gazeuse ; thé glacé 33 et 50 cl se distinguent par la taille du verre seulement.
- Biryanis, desserts, jus : les trois desserts inactifs (fromage blanc mangue muesli, mousse au chocolat, mangue menthe) ont aussi une image, au cas où la marque les réactive.

## Plafonds et recadrage

Les scènes sont en 16:9 : le sujet principal est au centre (façade : la vitrine et la porte ; comptoir : les bacs et les arches ; tandoor : l'ouverture du four). Un recadrage `object-fit: cover` en 4:3 ou 1:1 garde le sujet. Le héros détouré est large (1,58:1) : le plafonner par `.ky-cap--hero` avec `object-fit: contain`. Aucune image ne doit remplir un écran de téléphone ou de tablette : c'est le travail du CSS (`svh`).

## Non faits

- Vidéo (non demandée, solde du Gateway non vérifié : pas de test).
- Images de catégories distinctes : le seed utilise le plat d'un produit par famille (`FAMILY_IMAGE`).
- Images de couverture du blog : ce sont les produits du contrat (`samossa`, `butter-chicken`, `poulet-tikka-massala`, `agneau-karahi`, `biryani-poulet`, `naan-fromage`, `lassi`, `bowl-kurry-up`, `menu-kurry-up`).
- Logo de la marque (à fournir).

## Contrôles faits

Contrôle visuel de toutes les planches, du héros sur fond crème, des trois scènes et du logo : aucun texte lisible, aucun filigrane, aucune marque. Contrat du seed : tous les chemins existent.
