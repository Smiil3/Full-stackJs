import { ipKeyGenerator } from 'express-rate-limit';
import { sha256Hex } from './crypto.js';

/**
 * Empreinte d'une adresse IP pour le verrouillage de connexion (audit M7) : IPv6 ramenée à son sous-réseau
 * (une machine change facilement d'adresse dans son /56), puis hachée (aucune IP en clair en base).
 */
export function ipFingerprint(ip: string | undefined): string {
  return sha256Hex(`ip:${ipKeyGenerator(ip ?? '0.0.0.0')}`);
}

/** Ré-authentification d'un utilisateur déjà connecté (changement de mot de passe, coordonnées bancaires). */
export const SESSION_FINGERPRINT = sha256Hex('authenticated-session');
