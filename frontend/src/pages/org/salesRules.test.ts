import { describe, expect, it } from 'vitest';
import type { EventAdmin, OrgSettings } from '../../api/types';
import { NO_OVERRIDES } from '../../mocks/state';
import { buildEventBody, convertDatesToTimezone, diffPatch, initialEventForm, isReschedule } from './eventForm';
import { initialRulesState, parseRule, RULE_DEFS, rulesToOverrides } from './salesRules';
import { draftToBody } from './ticketTypeDraft';

const settings = {
  cardHoldMinutes: 15, transferHoldHours: 72, transferEnabled: true, cancellationDeadlineHours: 48, selfCancellationEnabled: true,
  refundPercent: 100, serviceFeeRefundable: false, maxPerOrder: 6, maxPerUser: 6, waitlistOfferMinutes: 120, waitlistEnabled: true,
  serviceFeeFixedCents: 50, serviceFeeBasisPoints: 250, defaultTimezone: 'Europe/Paris', contactEmail: null,
  bank: { beneficiary: null, ibanMasked: null, bic: null },
} satisfies OrgSettings;
const def = (k: string) => RULE_DEFS.find((d) => d.key === k) ?? (() => { throw new Error(k); })();

describe('règles de vente : hérite / personnalisé', () => {
  it('par défaut tout hérite du collectif (null envoyé)', () => {
    const { overrides, errors } = rulesToOverrides(initialRulesState(null, settings), settings);
    expect(errors).toEqual({});
    expect(Object.values(overrides).every((v) => v === null)).toBe(true);
  });

  it('valeurs personnalisées converties sans flottant (euros ⇒ centimes, % ⇒ points de base)', () => {
    const state = initialRulesState(null, settings);
    state.serviceFeeFixedCents = { mode: 'custom', text: '0,29' };
    state.serviceFeeBasisPoints = { mode: 'custom', text: '2,55' };
    state.transferEnabled = { mode: 'custom', text: 'false' };
    const { overrides } = rulesToOverrides(state, settings);
    expect(overrides.serviceFeeFixedCents).toBe(29);
    expect(overrides.serviceFeeBasisPoints).toBe(255);
    expect(overrides.transferEnabled).toBe(false);
  });

  it('bornes du plan et cohérence plafond personne ≥ commande (valeur effective)', () => {
    expect(parseRule(def('cardHoldMinutes'), '4').ok).toBe(false);
    expect(parseRule(def('serviceFeeBasisPoints'), '15,01').ok).toBe(false);
    expect(parseRule(def('serviceFeeFixedCents'), '10,01').ok).toBe(false);
    const state = initialRulesState(null, settings);
    state.maxPerOrder = { mode: 'custom', text: '10' }; // maxPerUser hérité = 6
    expect(rulesToOverrides(state, settings).errors.maxPerUser).toMatch(/au moins égal/);
  });
});

describe('types de places : euros ⇒ centimes (F3)', () => {
  const ev = { timezone: 'Europe/Paris', salesEndAt: '2026-11-14T19:00:00.000Z' };
  it.each([
    ['19,99', 1999],
    ['0,29', 29],
    ['1 234,56', 123456],
    ['25', 2500],
  ])('« %s » € ⇒ %d centimes', (price, cents) => {
    const r = draftToBody({ name: 'Fosse', description: '', capacity: '100', price, early: false, earlyPrice: '', earlyUntil: '' }, ev);
    expect(r.body?.priceCents).toBe(cents);
  });
  it('early : inférieur au prix, date avant la fin des ventes, saisie dans le fuseau de l’événement', () => {
    const ok = draftToBody({ name: 'F', description: '', capacity: '10', price: '25', early: true, earlyPrice: '18,50', earlyUntil: '2026-11-01T23:59' }, ev);
    expect(ok.body).toMatchObject({ earlyPriceCents: 1850, earlyUntil: '2026-11-01T22:59:00.000Z' });
    expect(draftToBody({ name: 'F', description: '', capacity: '10', price: '25', early: true, earlyPrice: '25', earlyUntil: '2026-11-01T23:59' }, ev).errors.earlyPrice).toBeDefined();
    expect(draftToBody({ name: 'F', description: '', capacity: '10', price: '25', early: true, earlyPrice: '10', earlyUntil: '2026-11-20T10:00' }, ev).errors.earlyUntil).toMatch(/fin des ventes/);
  });
});

describe('formulaire d’événement', () => {
  const event: EventAdmin = {
    id: 'e', orgId: 'o', title: 'Concert', description: null, venue: 'Salle', address: null, isOnline: false,
    startsAt: '2026-11-14T19:00:00.000Z', endsAt: '2026-11-14T23:00:00.000Z', timezone: 'Europe/Paris', status: 'PUBLISHED',
    salesStartAt: '2026-10-01T08:00:00.000Z', salesEndAt: '2026-11-14T19:00:00.000Z', overrides: { ...NO_OVERRIDES }, offlineCheckinEnabled: false, cancellationPendingOrders: 0,
    effectiveRules: { maxPerOrder: 6, maxPerUser: 6, transferEnabled: true, cardHoldMinutes: 15, transferHoldHours: 72, selfCancellationEnabled: true, cancellationDeadlineHours: 48, refundPercent: 100, serviceFeeFixedCents: 50, serviceFeeBasisPoints: 250, waitlistEnabled: true },
    ticketTypes: [{ id: 't', name: 'Fosse', description: null, capacity: 100, sold: 3, held: 0, remaining: 97, priceCents: 2500, earlyPriceCents: null, earlyUntil: null, sortOrder: 0 }],
    createdAt: '', updatedAt: '',
  };

  it('dates saisies dans le fuseau de l’événement ⇒ UTC', () => {
    const f = initialEventForm(event, settings);
    expect(f.startsAt).toBe('2026-11-14T20:00');
    const r = buildEventBody({ ...f, startsAt: '2026-07-10T20:30', endsAt: '2026-07-10T23:00', salesStartAt: '2026-06-01T10:00', salesEndAt: '2026-07-10T20:00' }, settings);
    expect(r.body?.startsAt).toBe('2026-07-10T18:30:00.000Z');
  });

  it('PATCH minimal : rien de modifié ⇒ objet vide ; titre seul ⇒ titre seul (pas de faux report)', () => {
    const f = initialEventForm(event, settings);
    const body = buildEventBody(f, settings).body;
    if (!body) throw new Error('body');
    expect(diffPatch(event, f, f, body)).toEqual({});
    const f2 = { ...f, title: 'Concert 2' };
    const body2 = buildEventBody(f2, settings).body;
    if (!body2) throw new Error('body');
    const p = diffPatch(event, f, f2, body2);
    expect(p).toEqual({ title: 'Concert 2' });
    expect(isReschedule(event, p)).toBe(false);
  });

  it('H3 : changement de fuseau en « conservant l’instant » ⇒ seul le fuseau est envoyé, pas de report', () => {
    const f = initialEventForm({ ...event, startsAt: '2026-11-14T19:00:42.123Z' }, settings);
    const converted = { ...f, timezone: 'America/New_York', ...convertDatesToTimezone(f, 'Europe/Paris', 'America/New_York') };
    expect(converted.startsAt).toBe('2026-11-14T14:00');
    const body = buildEventBody(converted, settings).body;
    if (!body) throw new Error('body');
    const p = diffPatch({ ...event, startsAt: '2026-11-14T19:00:42.123Z' }, f, converted, body);
    expect(p).toEqual({ timezone: 'America/New_York' });
    expect(isReschedule(event, p)).toBe(false);
  });

  it('H3 : changement de fuseau en « conservant les heures saisies » ⇒ dates déplacées = report', () => {
    const f = initialEventForm(event, settings);
    const moved = { ...f, timezone: 'America/New_York' };
    const body = buildEventBody(moved, settings).body;
    if (!body) throw new Error('body');
    const p = diffPatch(event, f, moved, body);
    expect(p.startsAt).toBe('2026-11-15T01:00:00.000Z');
    expect(isReschedule(event, p)).toBe(true);
  });

  it('H3 : comparaison en instants — même instant écrit autrement ⇒ rien envoyé', () => {
    const f = initialEventForm(event, settings);
    const body = buildEventBody({ ...f, startsAt: '2026-11-14T20:00' }, settings).body;
    if (!body) throw new Error('body');
    expect(diffPatch({ ...event, startsAt: '2026-11-14T19:00:00Z' }, f, { ...f, startsAt: '2026-11-14T20:00' }, body)).toEqual({});
  });

  it('dates modifiées avec ventes ⇒ report', () => {
    const f = initialEventForm(event, settings);
    const f2 = { ...f, startsAt: '2026-11-21T20:00', endsAt: '2026-11-21T23:59', salesEndAt: '2026-11-21T19:00' };
    const body = buildEventBody(f2, settings).body;
    if (!body) throw new Error('body');
    const p = diffPatch(event, f, f2, body);
    expect(isReschedule(event, p)).toBe(true);
  });

  it('heure inexistante (passage à l’heure d’été) signalée', () => {
    const f = { ...initialEventForm(event, settings), startsAt: '2027-03-28T02:30', endsAt: '2027-03-28T05:00', salesEndAt: '2027-03-28T01:00' };
    expect(buildEventBody(f, settings).notes.startsAt).toMatch(/n’existe pas/);
  });
});
