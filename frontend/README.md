# Frontend — Billetterie « Les Nuits de la Garonne »

Application web mobile-first : catalogue et achat de billets, espace acheteur, back-office des
collectifs, administration de la plateforme et **scanner d'entrée** (PWA installable).

React 19 · Vite 8 · TypeScript strict (`strict`, `noUncheckedIndexedAccess`) · React Router 8 ·
TanStack Query 5 · vite-plugin-pwa · IndexedDB (`idb`) · `@zxing/browser` · `qrcode` · MSW ·
Vitest + Testing Library · Playwright.

Le contrat d'API commun est [`../docs/api-contract.md`](../docs/api-contract.md) ; les choix propres
au front sont tracés dans [`DECISIONS.md`](./DECISIONS.md).

## Installation

Prérequis : Node.js ≥ 24 (`.nvmrc`), npm ≥ 11.

```bash
npm ci
cp .env.example .env      # variables publiques uniquement (voir ci-dessous)
```

## Deux façons de lancer

| Commande | API | Usage |
|---|---|---|
| `npm run dev:mock` | **simulée** dans le navigateur (MSW) | démonstration et développement sans backend |
| `npm run dev` | **réelle** : proxy Vite `/api` → `http://localhost:4000` | intégration (backend, worker, PSP simulé et Mailpit démarrés, voir [`../README.md`](../README.md)) |

Application : http://localhost:5173.

**Mode simulé** — comptes de démonstration (mot de passe `demo-nuits-2026`) :

| Email | Rôle |
|---|---|
| `acheteur@example.test` | acheteur |
| `nonverifie@example.test` | acheteur, email non vérifié (connexion refusée) |
| `owner@nuits.test` | OWNER des Nuits, MANAGER de Rive Droite |
| `manager@nuits.test` | MANAGER des Nuits |
| `scanner@nuits.test` | SCANNER des Nuits |
| `admin@plateforme.test` | admin plateforme |

Le paiement par carte passe par une page simulée interne, le « webhook » arrive 3 s plus tard.
La console expose `window.__nuitsMock` (pannes, latence, mails simulés). Le mode simulé n'existe
**qu'en développement** : `vite build --mode mock` échoue et aucun code de simulation n'est dans `dist/`.

**Mode réel** — comptes du seed backend (mot de passe = `SEED_PASSWORD` de `../.env.e2e`) : voir
[`../backend/README.md`](../backend/README.md).

## Variables d'environnement

Uniquement des variables `VITE_*` **non sensibles** : tout ce qu'elles contiennent est public.

| Variable | Défaut | Rôle |
|---|---|---|
| `VITE_API_BASE_URL` | `/api/v1` | base de l'API, **chemin relatif obligatoire** (même origine) ; une URL absolue fait échouer le démarrage |
| `VITE_PSP_ORIGIN` | `http://localhost:4001` en dev | seule origine externe vers laquelle le front redirige (paiement) ; **https obligatoire en production** : sinon `npm run build` est refusé (et l'application refuserait de démarrer) |

Le mot de passe des comptes de démonstration pour les tests de bout en bout est lu dans
`../.env.e2e` (`SEED_PASSWORD`, fichier ignoré par git), jamais dans le dépôt.

## Scripts

| Script | Rôle |
|---|---|
| `dev` / `dev:mock` | serveur de développement (API réelle / simulée) |
| `build` / `preview` | build de production / aperçu du build (mêmes en-têtes de sécurité qu'en production) |
| `test` | tests unitaires et de composants (Vitest, MSW) |
| `lint` / `typecheck` | ESLint typé (sécurité, accessibilité) / TypeScript |
| `e2e` | Playwright mobile **contre l'API réelle** (`e2e/real`) |
| `e2e:mock` | Playwright mobile contre l'API simulée (`e2e/mock`) |
| `e2e:pwa` | Playwright sur le **build de production** : service worker, rechargement sans réseau (`e2e/pwa`) |

### Tests de bout en bout

```bash
npx playwright install chromium      # une fois
npm run e2e:mock                     # aucun service requis
npm run e2e                          # backend :4000, worker, PSP simulé :4001, Mailpit :8025 démarrés ; ../.env.e2e présent
npm run e2e:pwa                      # idem ; construit puis sert le build sur :5173 (arrêter `npm run dev` avant)
```

Les tests réels créent leurs propres données (acheteurs vérifiés via Mailpit, événements de test) :
ils sont rejouables. Parcours couverts : inscription et vérification d'email, achat carte (PSP simulé)
et virement validé, mail des billets, QR, scan OK puis « déjà utilisé », scanner en mode secours hors-ligne
puis resynchronisation, billet remboursé refusé à l'entrée, liste d'attente jusqu'au billet, annulation
d'événement, back-office et administration.

## Direction visuelle « Miroir d'eau »

Source de vérité : [`../docs/design-kit/HANDOFF.md`](../docs/design-kit/HANDOFF.md) (maquettes de référence,
rapport de contrastes, licences des polices). Polices auto-hébergées (`src/assets/fonts`), variables Nuit / Jour
posées par `data-theme` (`src/styles/tokens.css`), classes du kit (`src/styles/components.css`), icônes en sprite
local (`public/icons.svg`, composant `Icon`). Aucun style en ligne : une valeur dynamique passe par un attribut
SVG, un élément natif ou une classe. Thème Nuit par défaut, Jour pour le paiement et le back-office, choix du
visiteur mémorisé (seule clé localStorage autorisée : `ndg-theme`), scanner toujours sombre.
Captures de revue : [`../docs/design-kit/captures`](../docs/design-kit/captures/README.md)
(`npx playwright test -c playwright.captures.config.ts`, API simulée).

## Architecture

```
src/
  api/        client unique (client.ts), types du contrat, erreurs → messages FR, horloge serveur, hooks TanStack Query
  auth/       jeton en mémoire, AuthProvider, gardes de routes, anti open-redirect
  pages/      public/ (catalogue, événement), account/, orders/, tickets/, org/ (back-office), admin/
  scanner/    stockage IndexedDB, vérification Ed25519, moteur de scan, synchro, écrans
  offline/    billets de l'acheteur conservés pour l'affichage hors-ligne
  components/ composants partagés accessibles ; lib/ (fuseaux, argent, IBAN, …)
  mocks/      faux serveur MSW couvrant tout le contrat (dev:mock et tests)
e2e/          real/ (API réelle), mock/, pwa/
deploy/       nginx.conf.example + nuits-security-headers.conf
```

## Sécurité (résumé)

- **Jeton d'accès en mémoire uniquement** ; session restaurée par le cookie HttpOnly de refresh.
  Refresh partagé (une seule requête pour N 401), sérialisé entre onglets (Web Locks), génération de session.
- Client API unique : chemins encodés et validés, `credentials: 'include'`, en-tête anti-CSRF, pas de
  redirection suivie, délais bornés, réponses critiques vérifiées à l'exécution.
- Aucune injection HTML possible (règles ESLint), redirections internes validées, redirection vers le
  prestataire limitée à son origine, aucun prix envoyé par le client, clé d'idempotence par tentative.
- Cache vidé et données hors-ligne purgées à la déconnexion ou au changement de compte ; pages d'un
  collectif remontées à chaque changement de collectif.
- **Contrôle d'accès en ligne par défaut** (sans réponse du serveur, personne n'entre) ; mode secours
  hors-ligne seulement si le propriétaire l'active pour l'événement.
- CSP stricte, en-têtes de sécurité : `security-headers.ts` (dev / aperçu) et `deploy/`.

Détails et limites : [`../SECURITY.md`](../SECURITY.md) et [`DECISIONS.md`](./DECISIONS.md).

## Déploiement

1. `VITE_PSP_ORIGIN=https://<prestataire> npm run build` (Node ≥ 24) ⇒ `dist/` statique.
2. Servir `dist/` avec la configuration [`deploy/nginx.conf.example`](./deploy/nginx.conf.example) :
   même origine pour l'API (`/api/` → backend), TLS 1.2/1.3, en-têtes de
   [`deploy/nuits-security-headers.conf`](./deploy/nuits-security-headers.conf) (à copier dans
   `/etc/nginx/snippets/`) inclus dans chaque bloc, `X-Forwarded-For` écrasé par l'adresse réelle,
   service worker / `index.html` / manifeste servis sans cache long, application monopage (`try_files … /index.html`).
3. Vérifier que l'origine du site correspond à `FRONT_URL` côté backend (CORS, cookie, liens des mails).
