import type { IconName } from '../../components/Icon';
import { formatTime } from '../../lib/time';
import type { ScanOutcome } from '../engine';

/** Ton FIXE (couleurs du scanner) + icône de forme différente + titre écrit : le sens ne repose jamais sur la couleur. */
export type OutcomeView = { tone: 'ok' | 'ko' | 'warn'; icon: IconName; title: string; line: string; detail: string };

const holder = (o: { ticketTypeName?: string; holderInitials?: string }) => [o.ticketTypeName, o.holderInitials].filter(Boolean).join(' · ');

export function describeOutcome(o: ScanOutcome, timezone: string): OutcomeView {
  switch (o.kind) {
    case 'OK':
      return { tone: 'ok', icon: 'check', title: 'OK — entrée', line: holder(o) || 'Billet valide', detail: '' };
    case 'ALREADY_USED':
      return { tone: 'ko', icon: 'x-octagon', title: 'Déjà utilisé', line: o.usedAt ? `à ${formatTime(o.usedAt, timezone)}` : 'Ne pas laisser entrer', detail: holder(o) };
    case 'CANCELLED':
      return { tone: 'ko', icon: 'x-octagon', title: 'Billet annulé', line: 'Ne pas laisser entrer', detail: holder(o) };
    case 'WRONG_EVENT':
      return { tone: 'warn', icon: 'alert-triangle', title: 'Autre événement', line: 'Ce billet est valable pour un autre événement', detail: 'Ne pas laisser entrer ici.' };
    case 'UNKNOWN_AUTHENTIC':
      return { tone: 'warn', icon: 'alert-triangle', title: 'À vous de décider', line: 'Billet authentique, absent de la liste', detail: 'Vérifiez en ligne si possible. Le choix est enregistré et vérifié au retour du réseau.' };
    default:
      return { tone: 'ko', icon: 'x-octagon', title: 'Billet invalide', line: 'Ce code n’est pas un billet', detail: 'QR code non reconnu ou falsifié.' };
  }
}
