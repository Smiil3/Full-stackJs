# Frontend — Billetterie « Les Nuits de la Garonne »

React 19 + Vite + TypeScript strict, React Router, TanStack Query, PWA (scanner hors-ligne).

## Démarrer

```bash
npm ci
npm run dev:mock   # API simulée par MSW (aucun back nécessaire) — http://localhost:5173
npm run dev        # contre le back réel (proxy /api → http://localhost:4000)
```

Comptes de démonstration du mode mock (mot de passe `demo-nuits-2026`) :

| Email | Rôle |
|---|---|
| `acheteur@example.test` | acheteur |
| `nonverifie@example.test` | acheteur, email non vérifié |
| `owner@nuits.test` | OWNER des Nuits, MANAGER de Rive Droite |
| `manager@nuits.test` | MANAGER des Nuits |
| `scanner@nuits.test` | SCANNER des Nuits |
| `admin@plateforme.test` | admin plateforme |

En mode mock, la console du navigateur expose `window.__nuitsMock` (injection de pannes, latence, mails simulés).

## Scripts

| Script | Rôle |
|---|---|
| `dev` / `dev:mock` | serveur de dev (réel / mock) |
| `build` / `preview` | build de production / aperçu |
| `test` | Vitest + Testing Library (+ MSW) |
| `lint` / `typecheck` | ESLint (typé, a11y, règles de sécurité) / `tsc` |
| `e2e` | Playwright, viewport mobile, contre le back réel |

## Sécurité (résumé)

- Access token **en mémoire uniquement** (`src/auth/tokenStore.ts`) ; refresh par cookie HttpOnly.
- Client API unique (`src/api/client.ts`) : refresh silencieux avec une seule promesse partagée, rejeu unique.
- Redirections `?next=` limitées aux chemins internes (`src/auth/safeRedirect.ts`).
- Aucun `dangerouslySetInnerHTML` / `innerHTML` (règle ESLint), textes organisateurs affichés en texte.
- Cache TanStack Query et données hors-ligne purgés au logout / changement de compte.

Décisions et écarts : voir [`DECISIONS.md`](./DECISIONS.md).
