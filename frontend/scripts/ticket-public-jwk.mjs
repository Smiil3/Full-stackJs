#!/usr/bin/env node
/**
 * Affiche la clé publique Ed25519 des billets au format JWK, à placer dans VITE_TICKET_PUBLIC_KEY_JWK
 * (clé PUBLIQUE uniquement : non sensible). Usage : npm run ticket-key [-- chemin/vers/public.pem]
 * Par défaut : ../backend/keys/ticket-signing-public.pem
 */
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? new URL('../../backend/keys/ticket-signing-public.pem', import.meta.url);
const jwk = createPublicKey(readFileSync(path)).export({ format: 'jwk' });
if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
  console.error('Clé inattendue : une clé publique Ed25519 est attendue.');
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x })}\n`);
