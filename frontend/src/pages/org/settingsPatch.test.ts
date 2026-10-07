import { describe, expect, it } from 'vitest';
import type { OrgSettings } from '../../api/types';
import { settingsPatch } from './settingsPatch';

const base = {
  cardHoldMinutes: 15,
  transferHoldHours: 72,
  transferEnabled: true,
  cancellationDeadlineHours: 48,
  selfCancellationEnabled: true,
  refundPercent: 100,
  serviceFeeRefundable: false,
  maxPerOrder: 6,
  maxPerUser: 6,
  waitlistOfferMinutes: 120,
  waitlistEnabled: true,
  serviceFeeFixedCents: 50,
  serviceFeeBasisPoints: 250,
  defaultTimezone: 'Europe/Paris',
  contactEmail: null,
} as unknown as Omit<OrgSettings, 'bank'>;

describe('réglages : patch contre l’état initial (audit M6)', () => {
  it('seuls les champs modifiés par l’utilisateur sont envoyés', () => {
    expect(settingsPatch(base, base, { ...base, refundPercent: 50 })).toEqual({ patch: { refundPercent: 50 }, conflicts: [] });
  });

  it('champ changé par un autre propriétaire mais pas ici ⇒ jamais renvoyé à l’ancienne valeur', () => {
    const current = { ...base, cardHoldMinutes: 30 }; // modifié ailleurs pendant l'édition
    const { patch, conflicts } = settingsPatch(base, current, { ...base, refundPercent: 50 });
    expect(patch).toEqual({ refundPercent: 50 });
    expect(patch).not.toHaveProperty('cardHoldMinutes');
    expect(conflicts).toEqual([]);
  });

  it('même champ modifié ici ET ailleurs (valeurs différentes) ⇒ conflit, rien d’envoyé pour ce champ', () => {
    const current = { ...base, refundPercent: 80 };
    expect(settingsPatch(base, current, { ...base, refundPercent: 50 })).toEqual({ patch: {}, conflicts: ['refundPercent'] });
  });

  it('même champ amené à la même valeur des deux côtés ⇒ pas de conflit', () => {
    const current = { ...base, refundPercent: 50 };
    expect(settingsPatch(base, current, { ...base, refundPercent: 50 }).conflicts).toEqual([]);
  });
});
