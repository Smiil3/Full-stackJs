# Kit de passation design — « Les Nuits de la Garonne »

Ce document s'adresse à Claude Code (ou à tout développeur) chargé d'appliquer la nouvelle direction visuelle **« Miroir d'eau »** au front existant. Le fonctionnel ne change pas : ce kit change l'apparence, les textes d'interface et quelques structures de composants.

> Stack cible : React 19 + TypeScript strict, Vite, React Router 8, TanStack Query 5, PWA (vite-plugin-pwa / Workbox). CSS natif uniquement : `src/styles/global.css` + `Layout.module.css`.

---

## 0. Règles non négociables

1. **CSP stricte** (`style-src 'self'`, `font-src 'self'`).
   - Aucun attribut `style="…"` dans le JSX, **et pas de prop `style={{…}}` non plus**. C'est la règle du projet, même si React passe par le CSSOM.
   - Aucune ressource externe : pas de Google Fonts, pas de CDN, pas d'`@import` distant.
   - Une valeur dynamique (largeur de jauge, avancement d'un compte à rebours) passe par des **attributs SVG** (`width="60%"`, `stroke-dashoffset`), par des éléments natifs (`<progress>`, `<meter>`) ou par des classes / `data-*` attributs. Voir `Gauge.tsx`.
2. **Couleurs de scan à sens fixe** : `--scan-ok` = entrer, `--scan-ko` = refuser, `--scan-warn` = décision humaine, `--scan-pending` = neutre.
   - Elles ne servent **nulle part ailleurs** : ni badges, ni alertes, ni décoration.
   - Le sens ne repose jamais sur la couleur seule : il y a toujours une icône de forme différente (cercle ✓, octogone ✕, triangle !) et un titre écrit.
3. **Accessibilité AA** : contrastes vérifiés dans `design/contrast-report.md`. Cibles d'au moins 44 px (`--tap`), 52 px pour les actions principales (`--tap-lg`). Focus toujours visible. `.visually-hidden` et `.skip-link` gardent le même comportement.
4. **Mobile d'abord**, marge latérale `--gutter: 16px`. Les actions principales sont en bas, à portée du pouce.
5. **Textes en français, pour un public non technique**. Jamais de code d'erreur ni de jargon. Chaque message dit ce qui s'est passé, ce qui n'est pas perdu, et quoi faire maintenant (§ 7).
6. **Ne pas copier les maquettes.** Les fichiers `design/mockups/*.dc.html` sont des **références visuelles** : ils utilisent des styles en ligne et Google Fonts, interdits ici. Il faut **traduire** chaque écran vers les composants et les classes du projet.

---

## 1. Contenu du kit

```
HANDOFF.md                          ← ce document
src/styles/fonts.css                ← @font-face, polices locales
src/styles/tokens.css               ← variables CSS (Nuit / Jour / scanner)
src/styles/components.css           ← retouches des classes existantes + nouvelles classes
src/components/Layout.module.css    ← en-tête, menu burger, pied de page, coque back-office
src/components/Icon.tsx             ← composant d'icône (sprite SVG local)
src/components/Gauge.tsx            ← jauge vendu / en attente, compatible CSP
src/assets/fonts/*.woff2            ← 14 fichiers, latin + latin-ext
src/assets/icons/*.svg              ← 41 icônes + 2 logos, fichiers séparés
public/icons.svg                    ← les mêmes icônes en sprite <symbol>
design/mockups/*.dc.html            ← maquettes de référence (ouvrir dans un navigateur)
design/contrast-report.md           ← contrastes vérifiés
design/licences/                    ← licences SIL OFL 1.1 des polices
```

---

## 2. Installation, dans cet ordre

1. **Polices** : copier `src/assets/fonts` dans le projet et ajouter `src/styles/fonts.css`.
2. **Tokens** : remplacer dans `global.css` le bloc `:root { … }` **et** le bloc `@media (prefers-color-scheme: dark) { … }` par le contenu de `tokens.css` (ou importer `tokens.css` et supprimer ces deux blocs).
3. **Composants** : fusionner `components.css` dans `global.css`.
   - Pour une classe qui existe déjà (`.btn`, `.card`, `.badge`…), **remplacer** les déclarations visuelles par celles du kit, mais **garder** les règles de comportement propres au projet si elles existent.
   - Ajouter les nouvelles classes (`.chip`, `.stepper`, `.poster`, `.copy-row`, `.notice`, `.gauge`, `.skeleton`, `.empty-state`…).
   - Le fichier dépassera les 230 lignes actuelles. C'est attendu ; on peut le découper en `@import` locaux, toujours compatibles CSP.
4. **Ordre d'import** dans `main.tsx` :
   ```ts
   import "./styles/fonts.css";
   import "./styles/global.css"; // contient tokens + components fusionnés
   ```
5. **Icônes** : copier `public/icons.svg` et `src/components/Icon.tsx`.
   - Si l'app n'est pas servie à la racine, préfixer le chemin du sprite avec `import.meta.env.BASE_URL`.
   - Les fichiers séparés de `src/assets/icons` servent si une icône doit être importée comme URL (favicon, manifeste…).
6. **PWA** :
   - Vérifier que `workbox.globPatterns` inclut `**/*.{woff2,svg}` : les polices et le sprite doivent marcher hors-ligne, notamment pour le QR code et le scanner.
   - Dans le manifeste : `theme_color: "#110F1F"`, `background_color: "#110F1F"`.
7. **`index.html`** :
   - `<meta name="theme-color" content="#110F1F">`
   - `<meta name="color-scheme" content="dark light">`
   - `<html lang="fr" data-theme="dark">`

### Correspondance des variables

| Variable existante | Nuit (défaut) | Jour | Remarque |
|---|---|---|---|
| `--color-bg` | `#110F1F` | `#F7F4EE` | |
| `--color-surface` | `#1B1830` | `#FFFFFF` | |
| `--color-surface-2` | `#252140` | `#F1EDE4` | |
| `--color-border` | `#36305A` | `#E3DED3` | filets décoratifs seulement |
| `--color-text` | `#F4EFE6` | `#1C1A2B` | |
| `--color-muted` | `#B9B2CF` | `#4A4660` | |
| `--color-primary` | `#F3C76B` (or) | `#2B2560` (indigo) | **remplace le violet `#5b2bd6`** |
| `--color-primary-strong` | `#FFDB94` | `#1E1A47` | survol |
| `--color-primary-soft` | `#352C1E` | `#E9E5F8` | fond d'élément sélectionné |
| `--color-danger` | `#F28BA8` | `#8E2442` | bordeaux, ≠ rouge du scanner |
| `--color-success` | `#8FD9B0` | `#1E6B48` | messages seulement, ≠ vert du scanner |
| `--radius` | `14px` | | + `--radius-sm`, `--radius-lg`, `--radius-pill` |
| `--font` | Atkinson Hyperlegible Next | | + `--font-display`, `--font-mono` |
| `--space-1…6` | 4 / 8 / 12 / 16 / 24 / 32 px | | + `--space-7` (48 px) |
| `--gutter` | `16px` | | inchangé |

**Nouvelles variables à connaître** :

- `--color-on-primary` : texte sur `--color-primary`. **Attention : en Nuit il est foncé, car le bouton est or.** Chercher dans le code tout `color: #fff` / `white` posé sur un fond primary et le remplacer par `var(--color-on-primary)`.
- `--color-border-strong` : bordures de champs et de boutons secondaires, contraste 3:1.
- `--color-link`, `--color-focus`, `--color-accent` (or lisible dans les deux thèmes), `--color-accent-fill`, `--color-on-accent`, `--color-on-danger`, `--color-warning`, `--color-info`, `--color-*-soft`.
- Échelles : `--text-xs` → `--text-3xl`, `--tap`, `--tap-lg`, `--shadow-1`, `--shadow-2`, `--color-overlay`.
- `--scan-*` : thème du scanner, toujours sombre.

---

## 3. Thèmes Nuit / Jour

Le thème ne dépend plus seulement de `prefers-color-scheme`. Il se pose avec **`data-theme="dark" | "light"`**, sur `<html>` ou sur **n'importe quel conteneur** : les variables se redéfinissent en cascade.

Règle de choix, à placer dans `Layout` :

```ts
// préférence explicite du visiteur (menu « Mode clair / sombre »), sinon défaut par zone
const theme = userPref ?? (isSoberRoute ? "light" : "dark");
document.documentElement.dataset.theme = theme;
```

- **Nuit par défaut** : catalogue, fiche événement, Mes billets, liste d'attente.
- **Jour par défaut** (`isSoberRoute`) : tunnel de paiement (virement, carte, confirmation), tout le back-office `org/` et `admin/`.
- Le choix du visiteur est mémorisé dans `localStorage` (`ndg-theme`) et l'emporte partout, sauf dans le scanner.
- **Le scanner et le QR plein écran restent toujours sombres**, quel que soit le thème.
- Un bloc peut forcer un thème localement. Exemple : le récapitulatif clair sur la fiche événement sombre se fait avec `<section className="card" data-theme="light">`.

---

## 4. Composants existants : ce qui change

| Composant | Changements |
|---|---|
| **Layout** | Nouvel en-tête : logo à gauche ; à droite, le lien « Mes billets » et le **bouton burger**. Le menu est un panneau sous l'en-tête avec : Événements, Mes billets, Les collectifs, Aide et contact, Mode clair/sombre, Espace organisateurs. Ajout d'un **pied de page** avec deux lignes de réassurance (carte ou virement ; billets disponibles hors-ligne), les liens Aide, Conditions de vente, Confidentialité et Espace organisateurs, et une mention. Coque back-office : `boShell` / `boNav` / `boMain`. Classes dans `Layout.module.css`. |
| **AvailabilityBadge** | Classes `.badge--available` (pastille + « Disponible »), `--low` (fond or, « Dernières places »), `--sold_out` (« Complet », ou « Complet · liste d'attente » si elle est ouverte). |
| **OrderStatusBadge** | « En attente de virement » → `.badge--pending` (contour or + icône `clock`). Payée → `.badge--available`. Annulée → `.badge--sold_out`. **Pas de vert ni de rouge.** |
| **EventTime** | Deux lignes. Ligne 1 en gras : `22:00 heure de Paris`. Ligne 2 en `.muted` : `16:00 chez vous, New York`. Si les deux fuseaux sont identiques, une seule ligne. Garder la logique actuelle. |
| **Countdown** | Réservé à l'**offre de liste d'attente** : anneau SVG `.countdown--ring`, progression via l'attribut `stroke-dashoffset`, chiffres en `.countdown__value`. **Ne plus l'utiliser sur la page de virement** (§ 6.1.3). |
| **CopyButton** | `.btn.btn--secondary.btn--small`. Libellé « Copier » qui devient « Copié » avec l'icône `check` pendant 2 s, plus une annonce `aria-live="polite"`. |
| **QrCode / QrFullscreen** | Structure `.qr-full` : barre du haut (fermer + pastille « Fonctionne sans réseau »), nom de l'événement, carte blanche `.qr-full__code`, type de place + initiales + code mono, navigation « Billet 1 sur 2 », conseil de luminosité. Fond toujours `#0B0A14`. |
| **ErrorAlert** | `.alert.alert--error` + icône `info`. Textes du § 7. |
| **PageLoader** | Remplacer le spinner par des squelettes `.skeleton` à la forme du contenu final : affiche et lignes de carte pour le catalogue, KPI et tableau pour le back-office. Ajouter `role="status"` et un texte `.visually-hidden` « Chargement… ». |
| **WaitlistOfferBanner** | `.waitlist-offer` : « Deux places se sont libérées pour vous », temps restant en `.waitlist-offer__time`, bouton « Accepter et payer 25,20 € ». Lien vers l'écran d'offre complet. |
| **ConfirmDialog** | `<dialog class="dialog">`. Icône dans `.dialog__icon`, titre-question, liste `.dialog__consequences` (ce qui va se passer, avec les chiffres), alternative moins radicale (« Reporter l'événement »), et pour les actions irréversibles un champ « Pour confirmer, écrivez ANNULER ». Le bouton prudent (« Garder l'événement ») est en `.btn` principal ; le bouton destructif en `.btn--danger`, désactivé tant que le mot n'est pas saisi. |
| **Field** | Hauteur 52 px, bordure `--color-border-strong`, police de 16 px minimum (évite le zoom iOS). Les erreurs ont une icône et du texte, jamais une simple bordure rouge. |
| **PwaUpdatePrompt** | `.pwa-update` : « Une nouvelle version est prête. » + bouton « Mettre à jour ». |

Nouveaux composants conseillés (CSS déjà fourni) :

- `Icon` (fourni) ;
- `Gauge` (fourni) ;
- `Poster` (`.poster`, affiche de date avec reflet) ;
- `QuantityStepper` (`.stepper`) ;
- `ChoiceCard` (`.choice`) ;
- `EmptyState` (`.empty-state`) ;
- `OfflineBanner` (`.offline-banner` / `.scan-banner`).

---

## 5. Le motif de la marque : le reflet

Le seul ornement du site : un trait d'horizon et, dessous, le même texte retourné et estompé, comme les façades dans le miroir d'eau.

```tsx
<div className={`poster poster--tone-${(event.id % 4) + 1}`} aria-hidden="true">
  <span className="poster__month">MARS</span>
  <span className="poster__day">12</span>
  <span className="poster__horizon" />
  <span className="poster__reflect">12</span>
</div>
```

- L'affiche est décorative (`aria-hidden`) : la date est déjà écrite en clair dans la carte.
- La couleur vient de `.poster--tone-1…4` et non d'un style en ligne.
- Sur la fiche événement : `.poster.poster--hero` avec `.poster__title`. Si l'organisateur fournit une image, elle remplace l'affiche, mais le titre et la date restent en texte.

Le logo est la même idée : une lune, l'horizon et deux traits de reflet (`src/assets/icons/logo-nuit.svg` / `logo-jour.svg`, ou les classes `brandMark*` du module).

---

## 6. Écrans

Pour chaque écran, ouvrir la maquette correspondante dans `design/mockups`. Les maquettes publiques font 390 px de large.

### 6.1 Public

#### 6.1.1 Catalogue (`Public-Catalogue.dc.html`)

- En-tête, puis photo d'ambiance qui s'efface dans le fond (à fournir par le collectif, avec les droits). Le titre « La nuit, côté Garonne. » chevauche le bas de la photo.
- Recherche dans un `<label>` avec icône `search` et libellé `.visually-hidden`.
- Filtres en `.chips` avec `aria-pressed`, défilement horizontal.
- Cartes `.card.event-card` : affiche, badge, titre, collectif, date + heure (icône `clock`), lieu (icône `map-pin`) ou « En ligne » (icône `globe`), « à partir de 15 € ». **Toute la carte est un lien.**
- États : squelettes, vide (« Rien de prévu avec ce filtre pour l'instant » + « Voir tous les événements »), erreur, hors-ligne (§ 6.4).

#### 6.1.2 Fiche événement et choix des places (`Public-Evenement.dc.html`)

- Affiche `--hero`, badge, titre, « Organisé par … ».
- Bloc date / horaire (`EventTime`) / lieu en `<dl>`, avec icônes or.
- Types de place en `.ticket-type` :
  - prix barré `.price-was`, avec « au lieu de » en `.visually-hidden` ;
  - ligne early : « Tarif early jusqu'au 28 févr., 23:59 » avec l'icône `tag` ;
  - `.stepper` dont les boutons ont des `aria-label` (« Ajouter une place Fosse ») et la valeur un `<output aria-live="polite">` ;
  - un type complet affiche « Complet » + le bouton « Liste d'attente ».
- Moyen de paiement en `.choice` (radio) :
  - « Carte bancaire — Billets reçus immédiatement. »
  - « Virement bancaire — Vos places sont gardées 48 h, le temps que le virement arrive. »
- Récapitulatif en **carte claire** (`data-theme="light"`) : lignes, frais de service détaillés (« 2 × 0,60 € »), total, puis la condition d'annulation en une phrase.
- `.action-bar` en bas, avec un bouton qui annonce le total (« Payer 31,20 € par carte »). Il est désactivé avec « Choisissez au moins une place » si la quantité est 0.

#### 6.1.3 Paiement par virement (`Public-Virement.dc.html`) — thème Jour

**Ton : rassurant, pas d'urgence.** Une première version avec un gros chronomètre « faisait peur » : il est supprimé.

- Ligne de confirmation (`check-circle`) « Réservation enregistrée », puis le titre « Il ne reste plus qu'à faire le virement ».
- Carte de rappel : événement, places, lien « Détails ».
- **Une seule liste `.copy-list`**, chaque ligne avec son bouton « Copier » :
  - Montant exact ;
  - **Référence** (`.copy-row--highlight`, en mono, avec l'aide « Elle nous permet de reconnaître votre virement. ») ;
  - Bénéficiaire, IBAN, BIC.
- Échéance en `.notice` avec l'icône `calendar` : « Vos places vous attendent jusqu'au **dimanche 7 mars**. Si le virement n'est pas fait d'ici là, la réservation s'annule simplement, sans aucun frais. » **C'est une date, pas un compte à rebours.**
- « Et ensuite ? » en 3 étapes, puis les boutons « Voir ma réservation » et « Payer plutôt par carte ».
- Le menu burger et le pied de page sont présents, comme sur toutes les pages publiques.

#### 6.1.4 Mes billets (`Public-MesBillets.dc.html`)

- Pastille « Disponibles hors-ligne » quand les billets sont en cache (service worker).
- Onglets `.segmented` « À venir (3) / Passés ».
- Carte de billet payé :
  - bouton « Afficher le QR code » + bouton « Annuler » ;
  - « Annuler » ouvre un panneau clair : montant remboursé en gros, frais non remboursés, date limite, puis les boutons « Garder mes billets » (principal) et « Oui, annuler » ;
  - après la date limite, le bouton « Annuler » disparaît au profit d'une phrase : « L'annulation n'est plus possible depuis le 5 mars. »
- Carte « En attente de virement » : `.badge--pending`, « Place gardée encore 41 h », lien « Revoir les coordonnées bancaires ». Le texte est figé et ne tourne pas en temps réel.
- Carte de liste d'attente : position « 4ᵉ », explication, « Voir le détail » et « Quitter la liste ».

#### 6.1.5 QR code plein écran (`Public-Billet-QR.dc.html`)

Voir le composant `QrFullscreen` (§ 4).
- Demander `navigator.wakeLock` si disponible.
- Le QR doit s'afficher **sans réseau** (données en cache via TanStack Query + service worker).

#### 6.1.6 Offre de liste d'attente (`Public-ListeAttente.dc.html`)

- Parcours en 3 lignes (inscription → position → offre).
- Titre « Deux places se sont libérées pour vous ».
- Anneau `Countdown` en mm:ss avec `role="timer"` et un `aria-label` mis à jour **chaque minute**, pas chaque seconde.
- Phrase : « Ces places sont réservées pour vous jusqu'à 18:50. »
- Récapitulatif, puis « Accepter et payer 25,20 € » et « Je laisse ma place ».
- État expiré ou refusé : « L'offre a expiré » / « C'est noté, merci ! », avec « Vous restez inscrit·e sur la liste ».

### 6.2 Back-office — thème Jour (`BO-Tableau-de-bord.dc.html`, `BO-Confirmation.dc.html`)

- Coque `boShell` :
  - menu latéral toujours sombre, avec le sélecteur d'**espace** (le collectif et ses deux partenaires) ;
  - compteurs or sur « Virements à valider » et « Remboursements ».
- En-tête d'événement : fil d'Ariane, titre, statut, puis les actions « Exporter les participants », « Modifier » et « Reporter ou annuler ».
- `.live` « En direct · mis à jour il y a 4 s ».
- `.kpis` ×5 : Vendues, En attente, Restantes, Scannées, Encaissé.
- Tableau par type de place dans `.table-wrap` (défilement horizontal sur téléphone). Colonne « Remplissage » = `Gauge`.
- Panneaux :
  - « Virements à valider » : référence en mono, nom, expiration, montant, bouton « Marquer comme reçu » ;
  - « Remboursements à effectuer » ;
  - « Règles de vente » : radio « Celles du collectif » / « Personnaliser pour cet événement » + résumé des valeurs ;
  - « Activité récente » (`.log`) avec un lien vers le journal d'audit.
- **Actions sensibles** (annuler ou reporter un événement, modifier l'IBAN, retirer un membre) : `ConfirmDialog` selon le modèle de `BO-Confirmation.dc.html`.
  - Pour l'IBAN, montrer l'ancien et le nouveau et demander une saisie de confirmation.
  - Pour retirer un membre, dire ce qu'il perd (« Marie ne pourra plus scanner les billets »).

### 6.3 Scanner (`Scanner-Etats.dc.html`)

**Retour du collectif : la première version (aplat de couleur plein écran) était « trop grosse, trop agressive ».** La version retenue garde l'écran caméra sombre. La couleur passe par :

1. le **cadre de visée** ;
2. une **pastille** contenant l'icône ;
3. le **titre** du panneau de résultat.

La taille reste calibrée pour une lecture à environ 1 m dans le noir (titre 40 px, ligne principale 26 px, pastille d'environ 120 px).

Structure attendue :

```tsx
<section className="scan-result scan-result--ok" role="status" aria-live="assertive">
  <header className="scan-topbar"><span>Quais Électriques · Entrée quai</span><span className="tabular">146 / 380</span></header>
  {offline && (
    <div className="scan-banner" role="status">
      <Icon name="wifi-off" /><span><strong>Mode secours hors-ligne</strong> · liste mise à jour à 21:30</span>
    </div>
  )}
  <div className="scan-result__view">
    <div className="scan-result__frame">
      <span className="scan-result__icon"><Icon name="check" /></span>
    </div>
  </div>
  <div className="scan-result__sheet">
    <p className="scan-result__title">OK — entrée</p>
    <p className="scan-result__line">Balcon · J.D.</p>
    <p className="scan-result__detail">Billet 1 sur 1</p>
    <button className="btn btn--secondary btn--block">Scanner le suivant</button>
    <p className="scan-result__foot">Retour à la caméra dans 3 s</p>
  </div>
</section>
```

| État | Classe | Icône | Titre | Ligne | Actions |
|---|---|---|---|---|---|
| Valide | `--ok` | `check` | OK — entrée | `Balcon · J.D.` | Scanner le suivant (retour auto 3 s) |
| Déjà utilisé | `--ko` | `x-octagon` | Déjà utilisé | `à 21:04` | Scanner le suivant · détail « scanné à l'Entrée quai par Sam » |
| Invalide | `--ko` | `x-octagon` | Billet invalide | Ce code n'est pas un billet | Scanner le suivant |
| Annulé | `--ko` | `x-octagon` | Billet annulé | Ne pas laisser entrer | Scanner le suivant · « Annulé et remboursé le 3 mars » |
| Autre événement | `--warn` | `alert-triangle` | À vous de décider | Billet pour « Nuit Bacalan Sound » | Laisser entrer / Refuser |
| Absent de la liste | `--warn` | `alert-triangle` | À vous de décider | Billet authentique, absent de la liste | Laisser entrer / Refuser · « Choix enregistré, vérifié au retour du réseau » |
| Vérification | `--pending` | `.scan-result__spinner` | Vérification en cours… | Gardez le billet devant la caméra | Saisir le code · lampe (`flashlight`) |

- Les refus utilisent `role="alert"`.
- Les états `--ok` et `--pending` utilisent `role="status"`.
- Ajouter une vibration courte (`navigator.vibrate`) différente par état : 1 pour ok, 3 pour ko, 2 pour warn. C'est un canal non visuel de plus.
- Le **bandeau hors-ligne reste affiché tant que le réseau n'est pas revenu**, sur tous les écrans du scanner.

### 6.4 États communs (`Etats.dc.html`)

Chaque écran prévoit : chargement (squelettes), vide, erreur, hors-ligne et complet. Le paiement refusé utilise le thème Jour.

---

## 7. Textes d'interface

Ton : chaleureux, direct, rassurant. On vouvoie. Écriture inclusive au point médian, avec parcimonie (« inscrit·e »).

| Situation | À écrire | À éviter |
|---|---|---|
| Erreur de chargement | « La page n'a pas pu se charger. Ça arrive, souvent à cause du réseau. Vos billets ne sont pas concernés. » + **Réessayer** | « Erreur 500 », « Une erreur est survenue » |
| Paiement refusé | « Le paiement n'est pas passé. Aucun montant n'a été débité. Vos places restent gardées 10 minutes. » | « Transaction declined » |
| Hors-ligne | « Pas de réseau. Vos billets restent disponibles. » | « Vous êtes déconnecté » |
| Vide | « Rien de prévu avec ce filtre pour l'instant. » | « Aucun résultat » |
| Complet | « Toutes les places sont parties, mais tout n'est pas perdu. » + liste d'attente | « SOLD OUT » |
| Échéance de virement | « Vos places vous attendent jusqu'au dimanche 7 mars. » | Chronomètre, « Temps restant » |
| Validation de formulaire | « Il manque votre e-mail : c'est là que nous envoyons les billets. » | « Champ requis » |

Formats :

- Dates : « ven. 12 mars » ou « vendredi 12 mars 2027 ».
- Heures : `22:00`, avec le fuseau en toutes lettres.
- Montants : « 31,20 € ».
- Prix ronds : « 15 € ».

---

## 8. Ordre d'intégration conseillé

Faire une PR par étape et vérifier à chaque fois :

1. Polices + tokens + base (§ 2). Vérifier que rien ne casse et que le focus reste visible.
2. `Layout` : en-tête, menu burger, pied de page, coque back-office, mécanique `data-theme`.
3. Composants partagés du § 4.
4. Catalogue → fiche événement → virement → Mes billets → QR → liste d'attente.
5. Scanner.
6. Back-office.

**Vérifications pour chaque PR :**

- Aucune occurrence de `style=` dans le JSX : `grep -R "style=" src` doit être vide.
- Aucune URL `http` dans les CSS.
- La console ne signale aucune violation CSP.
- Lighthouse Accessibilité ≥ 95. Navigation complète au clavier et à VoiceOver/TalkBack sur un écran du parcours.
- Mode avion : le QR, Mes billets et le scanner restent utilisables, avec les polices chargées.
- Affichage correct à 360 px et 390 px de large, sans défilement horizontal de page.

---

## 9. Données de maquette

Les événements, collectifs partenaires, prix, quantités et noms des maquettes sont **des exemples** : « Quais Électriques », « Collectif Rive Droite », « Bacalan Sound », « Camille D. »… Les règles de vente affichées (48 h, 30 min, 0,60 €, 7 jours) sont aussi des exemples : elles doivent venir de l'API. Les valeurs entre crochets (`[IBAN DU COLLECTIF]`, `[Prénom Nom]`, la description de l'événement) sont à fournir.
