import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../mocks/server';
import { apiRequest } from './client';
import { recordServerDate, serverNow, serverOffsetMs } from './serverClock';

describe('horloge serveur (revue F2.1 — H3)', () => {
  it('médiane glissante : une valeur aberrante ne fausse pas le décalage', () => {
    const local = Date.parse('2026-11-14T19:00:00.000Z');
    const at = (iso: string) => new Date(iso).toUTCString();
    recordServerDate(at('2026-11-14T19:05:00Z'), local);
    recordServerDate(at('2026-11-14T19:05:01Z'), local + 1000);
    recordServerDate(at('2026-11-14T22:00:00Z'), local + 2000); // aberrante
    expect(serverOffsetMs()).toBe(300_500);
  });

  it('ignore les en-têtes absents ou invalides', () => {
    recordServerDate(null);
    recordServerDate('n’importe quoi');
    expect(serverOffsetMs()).toBe(0);
  });

  it('le client API alimente l’horloge avec l’en-tête Date des réponses', async () => {
    const tenMinutesAhead = new Date(Date.now() + 600_000).toUTCString();
    server.use(http.get('*/api/v1/events', () => HttpResponse.json({ items: [], page: 1, pageSize: 20, total: 0 }, { headers: { Date: tenMinutesAhead } })));
    await apiRequest('/events', { auth: false });
    expect(Math.abs(serverNow() - Date.now() - 600_000)).toBeLessThan(2000);
  });
});
