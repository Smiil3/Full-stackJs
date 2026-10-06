import { describe, expect, it } from 'vitest';
import {
  describeEventTime,
  formatAgo,
  formatDateTime,
  formatDuration,
  formatOffset,
  formatTime,
  isValidTimeZone,
  offsetMinutes,
  timeZoneLabel,
  utcToZonedInput,
  zonedInputToUtc,
} from './time';

describe('describeEventTime', () => {
  it('heure d’hiver à Paris, utilisateur à Paris : pas de ligne locale', () => {
    const d = describeEventTime('2026-11-14T19:00:00.000Z', 'Europe/Paris', 'Europe/Paris');
    expect(d.event).toBe('sam. 14 nov. 2026, 20:00 — heure de Paris (UTC+1)');
    expect(d.local).toBeNull();
  });

  it('heure d’été à Paris (UTC+2)', () => {
    const d = describeEventTime('2026-07-10T18:30:00.000Z', 'Europe/Paris', 'Europe/Paris');
    expect(d.event).toBe('ven. 10 juil. 2026, 20:30 — heure de Paris (UTC+2)');
  });

  it('utilisateur à New York : heure locale avec ville et décalage (signe moins typographique)', () => {
    const d = describeEventTime('2026-11-14T19:00:00.000Z', 'Europe/Paris', 'America/New_York');
    expect(d.local).toBe('soit 14:00 chez vous, New York (UTC−5)');
  });

  it('même décalage mais autre fuseau (Bruxelles) : pas de ligne locale superflue', () => {
    expect(describeEventTime('2026-11-14T19:00:00.000Z', 'Europe/Paris', 'Europe/Brussels').local).toBeNull();
  });

  it('jour différent chez l’utilisateur : la date est rappelée', () => {
    const d = describeEventTime('2026-11-14T19:00:00.000Z', 'Europe/Paris', 'Asia/Tokyo');
    expect(d.local).toBe('soit dim. 15 nov., 04:00 chez vous, Tokyo (UTC+9)');
  });

  it('événement en ligne à New York vu depuis Paris', () => {
    const d = describeEventTime('2026-11-20T00:30:00.000Z', 'America/New_York', 'Europe/Paris');
    expect(d.event).toBe('jeu. 19 nov. 2026, 19:30 — heure de New York (UTC−5)');
    expect(d.local).toBe('soit ven. 20 nov., 01:30 chez vous, Paris (UTC+1)');
  });

  it('décalage non entier (Inde, UTC+5:30)', () => {
    const d = describeEventTime('2026-11-14T19:00:00.000Z', 'Europe/Paris', 'Asia/Kolkata');
    expect(d.local).toBe('soit dim. 15 nov., 00:30 chez vous, Kolkata (UTC+5:30)');
  });

  it('semaine où l’Europe et les USA ne changent pas d’heure le même jour', () => {
    // 2026-03-10 : New York déjà en heure d'été (UTC−4), Paris encore en hiver (UTC+1) ⇒ 5 h d'écart.
    const d = describeEventTime('2026-03-10T19:00:00.000Z', 'Europe/Paris', 'America/New_York');
    expect(d.event).toContain('20:00 — heure de Paris (UTC+1)');
    expect(d.local).toBe('soit 15:00 chez vous, New York (UTC−4)');
  });

  it('fuseau d’événement inconnu ⇒ pas de plantage, UTC affiché explicitement (revue F1.1 — B1)', () => {
    const d = describeEventTime('2026-11-14T19:00:00.000Z', 'Mars/Olympus', 'Europe/Paris');
    expect(d.event).toBe('sam. 14 nov. 2026, 19:00 — heure UTC — fuseau de l’événement non reconnu (UTC)');
    expect(d.local).toBe('soit 20:00 chez vous, Paris (UTC+1)');
    expect(describeEventTime('2026-11-14T19:00:00.000Z', 'Europe/Paris', 'Nope/Nope').local).toBe('soit 19:00 chez vous, UTC (UTC)');
    expect(formatTime('2026-11-14T20:04:00Z', 'Nope/Nope')).toBe('20:04');
    expect(utcToZonedInput('2026-11-14T19:00:00.000Z', 'Nope/Nope')).toBe('2026-11-14T19:00');
  });

  it('rejette une date invalide', () => {
    expect(() => describeEventTime('pas une date', 'Europe/Paris', 'Europe/Paris')).toThrow(RangeError);
  });
});

describe('décalages et changements d’heure', () => {
  it('Paris : +60 en hiver, +120 en été, bascule exacte le 29/03/2026 à 01:00Z', () => {
    expect(offsetMinutes(Date.parse('2026-03-29T00:59:00Z'), 'Europe/Paris')).toBe(60);
    expect(offsetMinutes(Date.parse('2026-03-29T01:00:00Z'), 'Europe/Paris')).toBe(120);
    expect(offsetMinutes(Date.parse('2026-10-25T00:59:00Z'), 'Europe/Paris')).toBe(120);
    expect(offsetMinutes(Date.parse('2026-10-25T01:00:00Z'), 'Europe/Paris')).toBe(60);
  });

  it('formatOffset', () => {
    expect(formatOffset(0)).toBe('UTC');
    expect(formatOffset(60)).toBe('UTC+1');
    expect(formatOffset(-300)).toBe('UTC−5');
    expect(formatOffset(330)).toBe('UTC+5:30');
    expect(formatOffset(-570)).toBe('UTC−9:30');
  });

  it('formatTime / formatDateTime dans le fuseau demandé, indépendamment de la machine', () => {
    expect(formatTime('2026-11-14T20:04:00Z', 'Europe/Paris')).toBe('21:04');
    expect(formatDateTime('2026-11-14T23:30:00Z', 'Europe/Paris')).toBe('dim. 15 nov. 2026, 00:30');
  });

  it('libellés de fuseau', () => {
    expect(timeZoneLabel('Europe/Paris')).toBe('heure de Paris');
    expect(timeZoneLabel('Europe/Amsterdam')).toBe('heure d’Amsterdam');
    expect(timeZoneLabel('Europe/London')).toBe('heure de Londres');
    expect(timeZoneLabel('UTC')).toBe('heure UTC');
  });

  it('isValidTimeZone', () => {
    expect(isValidTimeZone('Europe/Paris')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('saisie back-office (datetime-local dans le fuseau de l’événement)', () => {
  it('aller-retour hiver et été', () => {
    expect(zonedInputToUtc('2026-11-14T20:00', 'Europe/Paris')).toEqual({ ok: true, iso: '2026-11-14T19:00:00.000Z', note: null });
    expect(zonedInputToUtc('2026-07-10T20:30', 'Europe/Paris')).toEqual({ ok: true, iso: '2026-07-10T18:30:00.000Z', note: null });
    expect(utcToZonedInput('2026-11-14T19:00:00.000Z', 'Europe/Paris')).toBe('2026-11-14T20:00');
    expect(utcToZonedInput('2026-11-14T19:00:00.000Z', 'America/New_York')).toBe('2026-11-14T14:00');
  });

  it('heure inexistante (02:30 le 29/03/2026 à Paris) : décalée après le saut et signalée', () => {
    expect(zonedInputToUtc('2026-03-29T02:30', 'Europe/Paris')).toEqual({ ok: true, iso: '2026-03-29T01:30:00.000Z', note: 'skipped' });
  });

  it('heure ambiguë (02:30 le 25/10/2026 à Paris) : 1re occurrence et signalée', () => {
    expect(zonedInputToUtc('2026-10-25T02:30', 'Europe/Paris')).toEqual({ ok: true, iso: '2026-10-25T00:30:00.000Z', note: 'ambiguous' });
  });

  it('heure ambiguë à New York (01:30 le 01/11/2026)', () => {
    expect(zonedInputToUtc('2026-11-01T01:30', 'America/New_York')).toEqual({ ok: true, iso: '2026-11-01T05:30:00.000Z', note: 'ambiguous' });
  });

  it('refuse formats et dates impossibles, fuseaux inconnus', () => {
    expect(zonedInputToUtc('2026-02-31T20:00', 'Europe/Paris')).toEqual({ ok: false, reason: 'format' });
    expect(zonedInputToUtc('14/11/2026 20:00', 'Europe/Paris')).toEqual({ ok: false, reason: 'format' });
    expect(zonedInputToUtc('2026-11-14T24:00', 'Europe/Paris')).toEqual({ ok: false, reason: 'format' });
    expect(zonedInputToUtc('2026-11-14T20:00', 'Nope/Nope')).toEqual({ ok: false, reason: 'timezone' });
    expect(zonedInputToUtc('0050-01-01T10:00', 'Europe/Paris')).toEqual({ ok: false, reason: 'format' }); // revue F3.1 — B3
  });
});

describe('durées', () => {
  it('formatDuration', () => {
    expect(formatDuration(-5)).toBe('0 s');
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(14 * 60_000 + 5_000)).toBe('14 min 05 s');
    expect(formatDuration(65 * 60_000)).toBe('1 h 05 min');
    expect(formatDuration(3 * 86_400_000 + 2 * 3_600_000)).toBe('3 j 2 h');
  });
  it('formatAgo', () => {
    expect(formatAgo(1000, 4000)).toBe('il y a 3 s');
    expect(formatAgo(0, 125_000)).toBe('il y a 2 min');
  });
});
