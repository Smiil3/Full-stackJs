# Brief FRONTEND — Billetterie « Les Nuits de la Garonne »

Tu es le **développeur frontend** du projet. Je suis le **PO** (session agent-deck parente `fullstack-js`). Une autre session (`nuits-back`) développe l'API en parallèle dans `../backend/`.

## 0. À lire avant toute chose
1. `../docs/plan.md` — plan global validé. **Il fait autorité.**
2. `../docs/api-contract.md` — **contrat d'API**. Tu le consommes à la lettre. Le back ne sera pas prêt tout de suite : tu développes contre des **mocks MSW fidèles au contrat**, puis tu bascules sur la vraie API au fil des jalons back que je t'annoncerai.

## 1. Le client et ses utilisateurs
Collectif bordelais (concerts, soirées), ~15 événements/an, 80–600 places, au moins 2 types de places (fosse/balcon, standard/VIP), tarif early daté. Deux collectifs partenaires utilisent le même outil (chacun ne voit que ses données). Le client **n'est pas technique**.
Utilisateurs :
- **Acheteur** (grand public, surtout sur téléphone) : parcourt les événements, réserve, paie (carte via prestataire, ou virement), reçoit ses billets QR, s'inscrit en liste d'attente quand c'est complet, annule lui-même avant le délai. Certains participants à des événements **en ligne sont à l'étranger** ⇒ horaires sans ambiguïté.
- **Organisateur** (OWNER / MANAGER) : crée événements et types de places, règle les paramètres de vente, suit les ventes **en temps réel**, valide les virements, exporte la liste des participants, gère les membres.
- **Scanneur** (SCANNER) : à l'entrée d'une salle, **sur téléphone, souvent avec une mauvaise connexion**, scanne les QR ; un billet ne doit jamais passer deux fois.
- **Admin plateforme** : crée les collectifs.

**Contexte crucial** : une équipe adverse va auditer le code (failles, mauvaises pratiques, bugs). Chaque raccourci sera trouvé.

## 2. Périmètre et stack (imposés)
- Tu travailles **uniquement dans `frontend/`** (tu peux lire `../docs/`, jamais modifier `../backend/` ni `../docs/`).
- **React 19 + Vite + TypeScript strict** (`strict`, `noUncheckedIndexedAccess`), **React Router**, **TanStack Query**, **vite-plugin-pwa** (scanner hors-ligne), `idb` (IndexedDB), lib de scan caméra maintenue (`@zxing/browser` ou équivalent), `qrcode` (affichage QR), **MSW** pour les mocks, **Vitest + Testing Library** pour les tests, **Playwright** pour l'e2e (en fin de projet, viewport mobile). Style : CSS modules ou CSS simple bien organisé, **mobile-first**, accessible (labels, contrastes, navigation clavier, `aria-live` pour les résultats de scan).
- Dev : `http://localhost:5173`, proxy Vite `/api` → `http://localhost:4000`.
- Scripts npm : `dev`, `dev:mock` (MSW actif), `build`, `preview`, `test`, `lint`, `typecheck`, `e2e`.
- Variables : uniquement `VITE_*` non sensibles (aucun secret dans le front, tout ce qui est dans le bundle est public).

## 3. Règles de sécurité NON NÉGOCIABLES
1. **Access token en mémoire uniquement** (module/closure ou contexte React). **Jamais** localStorage / sessionStorage / IndexedDB / cookie lisible pour un token. Le refresh token est un cookie HttpOnly que tu ne vois jamais.
2. Client API unique (`src/api/client.ts`) : `credentials: 'include'`, en-tête `Authorization: Bearer`, en-tête `X-Requested-With: nuits-web` sur `/auth/refresh` et `/auth/logout`, **refresh silencieux sur 401 `UNAUTHENTICATED` avec une seule promesse de refresh partagée** (pas de tempête de refresh), rejeu unique de la requête, échec ⇒ déconnexion propre. Au chargement de l'app : tentative de refresh pour restaurer la session.
3. Typage strict des réponses (types alignés sur le contrat dans `src/api/types.ts`) ; gestion de **tous** les codes d'erreur du contrat avec messages français compréhensibles par des non-techniciens.
4. **Aucun `dangerouslySetInnerHTML`**, aucun `eval`, aucune construction d'URL / HTML à partir de données utilisateur sans encodage ; liens externes `rel="noopener noreferrer"`. Les descriptions d'événements sont affichées en **texte** (retours ligne via CSS `white-space: pre-line`).
5. Redirections après login / paiement : **uniquement vers des chemins internes** validés (anti open-redirect sur `?next=`).
6. **Le client n'envoie jamais de prix** ; il affiche ce que l'API renvoie. Toute validation front est UX ; le serveur fait foi.
7. `Idempotency-Key` (UUID via `crypto.randomUUID()`) générée **une fois par tentative de commande** et réutilisée si l'utilisateur re-clique / si la requête est rejouée ; bouton désactivé pendant l'envoi.
8. Après retour du prestataire (`?payment=success`), **ne jamais considérer la commande payée** sur la base de l'URL : poll `GET /orders/:id` (2 s, max 60 s) jusqu'à `PAID`.
9. Routes protégées par rôle côté front = confort UX uniquement ; ne jamais afficher ni mettre en cache des données d'un collectif après changement d'utilisateur (**vider le cache TanStack Query au logout / changement de compte**).
10. IndexedDB du scanner : ne stocke que `publicId`, type, initiales, statut, clé publique — **pas d'email, pas de nom complet, pas de token**. Purge des données d'un événement quand l'utilisateur se déconnecte ou change d'événement.
11. CSP compatible : pas de script inline, pas de style inline injecté dynamiquement à partir de données utilisateur. `npm audit --omit=dev` sans vulnérabilité haute/critique. Pas de `any` non justifié, pas de `@ts-ignore`, pas de `console.log` laissé.

## 4. Fonctionnel attendu
**Public / acheteur**
- Liste des événements (cartes : titre, collectif, date, lieu / « En ligne », prix « à partir de », disponibilité AVAILABLE / LOW « Dernières places » / SOLD_OUT « Complet »).
- Détail : description, types de places avec prix courant, prix barré + date de fin si early, disponibilité, sélecteur de quantité borné par `rules.maxPerOrder`, choix carte / virement (si `transferEnabled`), récapitulatif **frais de service et total affichés avant validation** (le total définitif vient de la réponse API), conditions d'annulation et délai de paiement écrits en clair.
- **Horaires** (exigence client) : toujours afficher l'heure **dans le fuseau de l'événement avec son nom et décalage** (« sam. 14 nov. 2026, 20:00 — heure de Paris (UTC+1) ») **et**, si différent, l'heure locale de l'utilisateur (« soit 14:00 chez vous, New York (UTC−5) »). Utilitaire unique `src/lib/time.ts` basé sur `Intl.DateTimeFormat`, testé (changements d'heure inclus).
- Inscription / connexion / vérification email / mot de passe oublié / réinitialisation / changement de mot de passe. Messages neutres (ne révèlent pas si un email existe).
- Commande : page avec **compte à rebours** jusqu'à `expiresAt`, bouton « Payer » (carte ⇒ `POST /checkout` puis redirection), ou instructions de virement (bénéficiaire, IBAN, BIC, **référence à recopier** avec bouton copier, montant, date limite). Gestion `ORDER_EXPIRED`.
- « Mes billets » : QR lisible plein écran (luminosité max conseillée), infos événement, statut (utilisé / annulé), **affichage hors-ligne** des billets déjà chargés (cache PWA du dernier résultat, pas du token).
- « Mes commandes », annulation avec confirmation explicite (montant remboursé affiché).
- Liste d'attente : bouton quand complet, position affichée, offre reçue ⇒ bandeau avec compte à rebours et bouton « Accepter » ⇒ commande.
**Back-office (OWNER / MANAGER)**
- Sélecteur de collectif si plusieurs adhésions.
- Événements : liste, création / édition (date + fuseau IANA sélectionnable, ventes début/fin), publication, annulation (OWNER, confirmation forte + motif), types de places (capacité, prix en euros saisis ⇒ convertis en centimes sans erreur d'arrondi, early).
- **Règles de vente** dans le formulaire d'événement : pour chaque paramètre, bascule « réglage du collectif (valeur X) / personnalisé » ; affichage de la valeur effective.
- **Réglages du collectif** (OWNER : édition ; MANAGER : lecture) : tous les paramètres du plan, coordonnées bancaires (IBAN affiché masqué, ressaisie complète pour modifier, validation de format côté UX).
- **Dashboard temps réel** par événement : poll 5 s de `/stats`, par type de place vendus / en attente / restants / scannés / encaissé, totaux, barre de remplissage, horodatage « mis à jour il y a Xs », indicateur hors-ligne.
- Commandes de l'événement avec filtre statut / recherche email ; **validation des virements** (saisie du montant reçu).
- Export CSV (téléchargement via fetch authentifié + Blob, pas de token dans l'URL).
- Membres (OWNER) : ajout par email, rôle, retrait ; journal d'audit (OWNER).
**Scanner (SCANNER+), PWA installable**
- Choix de l'événement ⇒ **téléchargement du snapshot** (bouton « Préparer l'entrée hors-ligne », date du dernier snapshot affichée).
- Scan caméra en continu ; résultat **plein écran très lisible** : vert « OK — Balcon — J.D. », rouge « DÉJÀ UTILISÉ à 21:04 », rouge « INVALIDE », orange « AUTRE ÉVÉNEMENT » ; son/vibration ; saisie manuelle de secours.
- En ligne : `POST /checkin/scan`. Hors-ligne (ou timeout 3 s) : vérification **signature Ed25519 locale** (WebCrypto `Ed25519`, avec fallback lib maintenue si non supporté) + statut local, marquage local, file d'attente IndexedDB ; **synchro automatique** au retour du réseau (`/checkin/sync`) avec affichage des conflits ; compteur « N scans en attente de synchro ».
- `deviceId` UUID généré une fois par appareil (seule donnée persistée hors snapshot).
**Admin plateforme** : liste + création de collectifs.

## 5. Jalons
| # | Contenu | Critères d'acceptation |
|---|---|---|
| F1 | Socle : Vite + TS strict + ESLint, routing, layout mobile-first, client API + auth (refresh partagé), types du contrat, handlers **MSW couvrant tout le contrat** (y compris erreurs), `time.ts` | tests : refresh unique sur N 401 simultanés ; token jamais en storage ; `time.ts` (fuseaux, DST) ; open-redirect bloqué |
| F2 | Parcours acheteur complet (catalogue → détail → commande → paiement/virement → billets → annulation → liste d'attente) + pages auth | tests composants des cas d'erreur (SOLD_OUT, LIMIT_EXCEEDED, ORDER_EXPIRED…) ; idempotency-key réutilisée sur double clic |
| F3 | Back-office : événements, types de places, règles de vente, réglages collectif, membres, audit, commandes, virements, export, dashboard temps réel, admin plateforme | conversion euros ⇒ centimes testée ; cache vidé au logout ; rôle MANAGER ne voit pas l'édition des réglages |
| F4 | Scanner PWA hors-ligne | tests : vérif signature locale (vrai/faux), file de synchro, double scan local ⇒ DÉJÀ UTILISÉ, purge IndexedDB |
| F5 | Bascule sur la vraie API (au fil de mes annonces), Playwright e2e mobile (achat carte → billet → scan OK puis DÉJÀ UTILISÉ ; scanner hors-ligne puis resync), `README` frontend | e2e verts contre le back réel |

## 6. Protocole de travail avec moi (PO)
- **Avant de coder F1**, envoie-moi une réponse courte : ta compréhension, l'arborescence prévue, les points ambigus du contrat. Puis enchaîne sans attendre sauf question bloquante.
- Question bloquante, besoin d'un endpoint / champ absent du contrat, ambiguïté métier ⇒ une ligne `NEED:` puis attends ma réponse. **Ne contourne jamais** un manque du contrat par une hypothèse silencieuse.
- Décision non bloquante ⇒ option la plus sûre + note dans `frontend/DECISIONS.md`.
- Fin de chaque jalon : commit(s) puis message `JALON Fx TERMINÉ` + écrans livrés + résultat `npm test` / `lint` / `typecheck` + écarts. Tu peux enchaîner pendant mon audit.
- Je t'enverrai des messages `[agent-deck from:…]` : annonces de jalons back disponibles, changements de contrat, corrections demandées.
- Quand **tout** est livré, termine par la ligne sentinelle de fin.

## 7. Git
- Repo à la racine (`../`), déjà initialisé. Ne commite **que** des fichiers de `frontend/`.
- Messages de commit **en français**, orientés métier. Petits commits cohérents.
- **Jamais** `git commit --amend`, `git push --force`, réécriture d'historique, ni `git add -A` à la racine.

Commence maintenant par la lecture des documents puis ton retour de compréhension.
