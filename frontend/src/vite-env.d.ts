/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base de l'API (non sensible). Défaut : /api/v1 via le proxy Vite. */
  readonly VITE_API_BASE_URL?: string;
  /** Origine du prestataire de paiement (seule destination externe autorisée). Ex. https://checkout.psp.example */
  readonly VITE_PSP_ORIGIN?: string;
  /** Clé publique Ed25519 des billets (JWK OKP, non sensible), épinglée pour le mode secours. Obligatoire en production. */
  readonly VITE_TICKET_PUBLIC_KEY_JWK?: string;
}

/** Version de l'application (package.json + date de build), affichée dans le scanner. */
declare const __APP_VERSION__: string;

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
