import { formatTime } from '../../lib/time';
import type { ScanOutcome } from '../engine';

type View = { tone: 'ok' | 'ko' | 'warn'; title: string; detail: string };

export function describeOutcome(o: ScanOutcome, timezone: string): View {
  switch (o.kind) {
    case 'OK':
      return { tone: 'ok', title: 'OK', detail: [o.ticketTypeName, o.holderInitials].filter(Boolean).join(' — ') };
    case 'ALREADY_USED':
      return { tone: 'ko', title: o.usedAt ? `DÉJÀ UTILISÉ à ${formatTime(o.usedAt, timezone)}` : 'DÉJÀ UTILISÉ', detail: [o.ticketTypeName, o.holderInitials].filter(Boolean).join(' — ') };
    case 'CANCELLED':
      return { tone: 'ko', title: 'BILLET ANNULÉ', detail: o.ticketTypeName ?? '' };
    case 'WRONG_EVENT':
      return { tone: 'warn', title: 'AUTRE ÉVÉNEMENT', detail: 'Ce billet est valable pour un autre événement.' };
    case 'UNKNOWN_AUTHENTIC':
      return { tone: 'warn', title: 'BILLET NON PRÉSENT DANS LA LISTE', detail: 'Billet authentique non présent dans la liste — vérifier en ligne si possible.' };
    default:
      return { tone: 'ko', title: 'INVALIDE', detail: 'QR code non reconnu ou falsifié.' };
  }
}
