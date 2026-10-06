import { getEnv } from '../config/env.js';
import { aad, decryptString, encryptString } from './crypto.js';

/**
 * Point UNIQUE de chiffrement / déchiffrement des IBAN (service, seed, migrations de données) :
 * AES-256-GCM, trousseau courant, contexte AAD lié à la ligne propriétaire.
 */
export const bankCrypto = {
  encryptOrgIban: (orgId: string, iban: string) => encryptString(iban, getEnv().dataKeyring, aad.orgBankIban(orgId)),
  decryptOrgIban: (orgId: string, payload: string) => decryptString(payload, getEnv().dataKeyring, aad.orgBankIban(orgId)),
  encryptOrderIban: (orderId: string, iban: string) => encryptString(iban, getEnv().dataKeyring, aad.orderTransferIban(orderId)),
  decryptOrderIban: (orderId: string, payload: string) => decryptString(payload, getEnv().dataKeyring, aad.orderTransferIban(orderId)),
};
