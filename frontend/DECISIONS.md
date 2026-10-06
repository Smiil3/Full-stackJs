# Décisions frontend

Décisions non bloquantes prises côté front (option la plus sûre), avec leur justification.
Les points tranchés par le PO sont référencés par la version du contrat.

| # | Sujet | Décision | Pourquoi |
|---|---|---|---|
| D1 | Chemin du cookie de refresh | On suit le contrat : `Path=/api/v1/auth` (le plan disait `/api/auth`, corrigé par le PO). | Contrat = source de vérité. |
| D2 | TypeScript 6.0.x (et non 7) | Version épinglée à 6.0.3. | `typescript-eslint` ne supporte pas encore TS ≥ 6.1 ; le lint typé est indispensable pour l'audit. |
| D3 | ESLint 9 (et non 10) | Épinglé à 9.x. | `eslint-plugin-jsx-a11y` (accessibilité) ne déclare pas encore la compatibilité ESLint 10. |
| D4 | Worker MSW | Servi uniquement par le serveur de dev (`npm run dev:mock`) via un plugin Vite `apply: 'serve'`, jamais copié dans `dist/`. Le code de mock est importé dynamiquement derrière `import.meta.env.MODE === 'mock'` ⇒ éliminé du build. | Aucune infrastructure de mock en production. |
| D5 | Service worker PWA | Ne met en cache que la coquille applicative (JS/CSS/HTML/icônes). **Aucune réponse d'API** n'est mise en cache par le service worker. Le hors-ligne métier (billets, snapshot scanner) passe par IndexedDB avec purge à la déconnexion. | Une réponse d'API en cache HTTP survit au logout et ne se purge pas finement. |
| D6 | Démarrage hors-ligne | Un refresh en échec **réseau** (≠ 401) ne déconnecte pas : statut `offline`. Validé par le PO. | Scanner et billets doivent rester utilisables sans réseau. |
| D7 | Refresh proactif | En plus du refresh réactif sur 401 `UNAUTHENTICATED`, un refresh est planifié 60 s avant `expiresIn`. Les deux passent par la **même** promesse partagée. Validé par le PO. | Moins de 401 sur mobile, pas de tempête de refresh. |
| D8 | Messages d'erreur | Le front n'affiche jamais `error.message` du serveur : il traduit le `code` contractuel en message français (`src/api/errors.ts`). Seuls les messages de champ de `VALIDATION_ERROR` sont affichés (en texte). | Messages stables, compréhensibles, sans fuite technique. |
| D9 | Chemins d'API | Tout paramètre interpolé dans un chemin passe par `apiPath\`…\`` (encodage `encodeURIComponent`). | Un identifiant forgé ne peut pas changer de route. |
| D10 | Requêtes | `cache: 'no-store'` et `redirect: 'error'` sur tous les appels API, délai max 15 s. | Pas de données personnelles dans le cache HTTP ; une redirection inattendue n'est pas suivie silencieusement. |
| D11 | Admin plateforme pour un non-admin | Le mock répond 404 (le contrat ne précise pas le code). Le front traite 403 et 404 de la même façon (« Accès non autorisé »). | Robuste quel que soit le choix du back. |
| D12 | Liste d'attente désactivée | Le mock répond 409 `CONFLICT` (code non précisé au contrat) ; le front masque de toute façon le bouton si `rules.waitlistEnabled = false`. | UX ; le serveur fait foi. |
| D13 | Saisie des dates en back-office | Saisie dans le **fuseau de l'événement** ; une heure inexistante (passage à l'heure d'été) est décalée après le saut et signalée, une heure ambiguë (passage à l'heure d'hiver) prend la 1ʳᵉ occurrence et est signalée (`zonedInputToUtc`). | Aucune ambiguïté silencieuse pour l'organisateur. |
| D14 | Paiement en mode mock | En `dev:mock`, `redirectUrl` pointe vers une page interne `/mock-psp/:orderId` (chargée uniquement en mode mock) ; le « webhook » est appliqué après 3 s pour exercer le polling. En réel, seules les redirections vers l'origine du PSP configurée ou la nôtre sont suivies. | Le mock tourne dans la page : un rechargement perdrait l'état en mémoire. |
