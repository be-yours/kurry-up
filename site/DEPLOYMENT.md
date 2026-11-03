# Démo en ligne (privée) : Kurry Up

Mise en ligne le 4 novembre 2026 pour les collègues, avant le Salon de la Street Food (7 et 8 novembre 2026). Démonstration : données fictives, aucun vrai paiement, aucun secret dans ce dépôt.

## Adresses

| Élément | Valeur |
| --- | --- |
| Site | https://kurry-up.vercel.app (aussi `kurry-up-beyours.vercel.app`) |
| Hébergement | Vercel, équipe « Be Yours » (`beyours`, offre Hobby), projet `kurry-up`, framework Next.js, Node 24. Aucun dépôt Git relié, aucun domaine personnalisé. |
| Backend | Convex, équipe `be-yours`, projet `kurry-up`, déploiement de développement dans le cloud `agile-warbler-213` (`https://agile-warbler-213.convex.cloud`). Aucune production Convex avant la signature. |
| Code | https://github.com/be-yours/kurry-up (dépôt public) |
| Poste local | Inchangé : backend anonyme sur 3300/3301, site sur http://localhost:3500. |

## Accès privé

La protection Vercel Authentication couvre tous les déploiements (`ssoProtection: all`). Sans session de l'équipe, chaque adresse répond 302 vers `vercel.com/sso-api`, images et `/api/*` compris.

Le lien de partage pour les collègues est le secret « Protection Bypass for Automation » du projet : `https://kurry-up.vercel.app/?x-vercel-protection-bypass=<secret>&x-vercel-set-bypass-cookie=true`. Il dépose le cookie `_vercel_jwt` (7 jours). Le secret ne figure dans aucun fichier : le demander au responsable du projet. Lire, recréer ou révoquer : Vercel, projet `kurry-up`, Settings, Deployment Protection. Révoquer après la démo.

Vérification : sans le lien, `curl -s -o /dev/null -w "%{http_code}" https://kurry-up.vercel.app/` doit répondre 302, jamais 200.

## Redéployer

Le site se construit sur le poste (les paquets `@be-yours/*` viennent de GitHub Packages). Depuis la racine :

```bash
cp .env.local /tmp/env.local.bak                    # vercel pull réécrit .env.local
vercel pull --yes --environment=production --scope beyours
cp /tmp/env.local.bak .env.local
SKIP_NODE_AUTH_TOKEN_CHECK=1 vercel build --prod --scope beyours
python3 - <<'PY'                                     # retirer les .env* tracés par Next
import json, glob, os
for f in glob.glob('.vercel/output/functions/**/.vc-config.json', recursive=True):
    if os.path.islink(f): continue
    d = json.load(open(f)); m = d.get('filePathMap') or {}
    bad = [k for k in m if os.path.basename(k).startswith('.env')]
    for k in bad: del m[k]
    if bad: json.dump(d, open(f, 'w'))
PY
vercel deploy --prebuilt --prod --scope beyours
```

Le projet Vercel doit avoir le framework « Next.js » : sans lui, `vercel build` ne produit aucune fonction.

Contenu : `CONVEX_DEPLOYMENT=dev:agile-warbler-213 node site/seed/run.mjs` (le seed vise le déploiement nommé par la variable, sans toucher `.env.local`). Fonctions Convex : `CONVEX_DEPLOYMENT=dev:agile-warbler-213 npx convex dev --once`.

## Variables d'environnement

Posées dans Vercel (Production) et dans Convex (`dev`). Les secrets (`BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `EMAIL_API_SECRET`, `ADMIN_BOOTSTRAP_TOKEN`) sont générés pour cette démo, différents de ceux du poste, stockés en « Secret » et jamais écrits dans le projet.

- AWS (S3, SES) : valeurs factices. Aucun e-mail ne part, aucun fichier ne s'envoie depuis l'administration.
- `OPENAI_API_KEY` et clés Stripe : valeurs factices. Aucun paiement hors espèces.
- `AUTH_ALLOW_UNVERIFIED_EMAIL=true` : un compte se crée sans e-mail de vérification. À remettre à `false` avec un vrai SES.
- `NODE_OPTIONS=--experimental-require-module` (Vercel) : sans elle, les articles du blog répondent 500 (`jsdom`, `ERR_REQUIRE_ESM`).
- `BID_APP_URL` : exigée par le moteur dès que les clés de facturation sont posées, sans effet ici.

Hors horaires d'ouverture (11 h à 22 h 30), le site affiche « Restaurant actuellement fermé » et refuse les commandes : c'est voulu.

## Avant une vraie ouverture

Voir `LAUNCH_CHECKLIST.md` et `A_COMPLETER.md`, puis : accord écrit de la marque (textes, illustrations IA, logo, vidéo), identité légale réelle, secrets régénérés, AWS du client, déploiement Convex de production après signature, domaine personnalisé, retrait de la protection Vercel et révocation du lien partageable, dépôt Git relié à Vercel.
