/**
 * Génère la paire Ed25519 de signature des billets dans `keys/` (dossier gitignoré).
 * Refuse d'écraser une paire existante : changer de clé invaliderait tous les QR déjà émis.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import 'dotenv/config';

const privatePath = process.env['TICKET_SIGNING_PRIVATE_KEY_FILE'] ?? 'keys/ticket-signing-private.pem';
const publicPath = process.env['TICKET_SIGNING_PUBLIC_KEY_FILE'] ?? 'keys/ticket-signing-public.pem';

if (existsSync(privatePath) || existsSync(publicPath)) {
  process.stderr.write(`Une clé existe déjà (${privatePath}). Supprimez-la explicitement pour en générer une nouvelle.\n`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
mkdirSync(dirname(privatePath), { recursive: true, mode: 0o700 });
mkdirSync(dirname(publicPath), { recursive: true, mode: 0o700 });
writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644, flag: 'wx' });
process.stdout.write(`Paire Ed25519 générée : ${privatePath} / ${publicPath}\n`);
