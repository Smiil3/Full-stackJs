/**
 * Règles ESLint de sécurité du frontend, testées par eslint.security.test.ts.
 * Chaque API sensible n'est autorisée que dans le module qui en a la charge.
 */

const GLOBALS = {
  localStorage: 'Stockage persistant interdit (aucun token ni donnée personnelle en storage).',
  sessionStorage: 'sessionStorage interdit (aucun token en storage).',
  indexedDB: 'IndexedDB uniquement dans src/offline/ et src/scanner/db.ts.',
  fetch: 'Appels réseau uniquement via src/api/client.ts (apiRequest).',
  // Autres canaux réseau / stockage : aucun usage justifié dans l'application à ce jour.
  XMLHttpRequest: 'Appels réseau uniquement via src/api/client.ts (apiRequest).',
  WebSocket: 'Canal réseau non prévu : appels uniquement via src/api/client.ts.',
  EventSource: 'Canal réseau non prévu : appels uniquement via src/api/client.ts.',
  caches: 'Cache Storage interdit : aucune réponse d’API mise en cache (le service worker ne précache que l’application).',
};
const IDB_MESSAGE = 'idb uniquement dans src/offline/ et src/scanner/db.ts (stockage local maîtrisé).';
const HOLDERS = ['window', 'globalThis', 'self'];

/** Configuration des règles, en retirant éventuellement des API autorisées pour un fichier précis. */
export function restrictedApiRules(allow = []) {
  const names = Object.keys(GLOBALS).filter((n) => !allow.includes(n));
  const idbAllowed = allow.includes('indexedDB');
  return {
    'no-restricted-globals': ['error', ...names.map((name) => ({ name, message: GLOBALS[name] }))],
    'no-restricted-properties': [
      'error',
      ...HOLDERS.flatMap((object) => names.map((property) => ({ object, property, message: GLOBALS[property] }))),
      { object: 'document', property: 'cookie', message: 'document.cookie interdit : le refresh token est un cookie HttpOnly.' },
      { object: 'navigator', property: 'sendBeacon', message: 'navigator.sendBeacon interdit : appels uniquement via src/api/client.ts.' },
    ],
    'no-restricted-imports': idbAllowed ? 'off' : ['error', { paths: [{ name: 'idb', message: IDB_MESSAGE }], patterns: [{ group: ['idb/*'], message: IDB_MESSAGE }] }],
    'no-restricted-syntax': [
      'error',
      { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'dangerouslySetInnerHTML interdit.' },
      { selector: "MemberExpression[property.name='innerHTML']", message: 'innerHTML interdit.' },
      { selector: "MemberExpression[property.name='outerHTML']", message: 'outerHTML interdit.' },
      { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: 'insertAdjacentHTML interdit.' },
      { selector: "CallExpression[callee.object.name='document'][callee.property.name='write']", message: 'document.write interdit.' },
    ],
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
  };
}

/** Blocs de configuration à insérer dans eslint.config.js (après la config générale). */
export const securityConfigs = [
  // Code applicatif uniquement (les outils de test e2e tournent sous Node, hors navigateur).
  { files: ['src/**/*.{ts,tsx}'], rules: restrictedApiRules() },
  { files: ['src/api/client.ts'], rules: restrictedApiRules(['fetch']) },
  { files: ['src/offline/**/*.{ts,tsx}', 'src/scanner/db.ts'], rules: restrictedApiRules(['indexedDB']) },
  // Les tests inspectent justement les storages / cookies pour prouver qu'aucun token n'y est écrit.
  { files: ['src/**/*.test.{ts,tsx}', '*.test.ts'], rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' } },
];
