/** Jetons aléatoires opaques (refresh, liens mail) : 256 bits. */
export const RANDOM_TOKEN_BYTES = 32;
/** AES-256-GCM : nonce de 96 bits (NIST SP 800-38D) et étiquette d'authentification de 128 bits. */
export const GCM_IV_BYTES = 12;
export const GCM_TAG_BYTES = 16;
/** Chiffré sérialisé `v1.<kid>.<iv>.<tag>.<ciphertext>` : nombre de parties. */
export const ENCRYPTED_PARTS = 5;
/** Valeurs possibles d'un octet (tirage sans biais par rejet). */
export const BYTE_VALUES = 256;
/** Octets tirés par caractère voulu lors d'un tirage par rejet (marge pour les rejets). */
export const REJECTION_SAMPLING_OVERDRAW = 2;
/** Empreinte SHA-256 en hexadécimal : 64 caractères. */
export const SHA256_HEX_LENGTH = 64;
/** Fichier de clé privée : bits de permission groupe / autres interdits en production (0600 / 0400). */
export const KEY_FILE_FORBIDDEN_MODE_BITS = 0o077;
