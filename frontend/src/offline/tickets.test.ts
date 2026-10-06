import { describe, expect, it } from 'vitest';
import type { Ticket } from '../api/types';
import { __markPurgePendingForTests, clearTickets, loadTickets, ownerHash, saveTickets } from './tickets';

const ticket = (id: string) => ({ id, publicId: 'p', status: 'VALID', qrPayload: `NG1.e.${id}.sig` }) as unknown as Ticket;

describe('billets hors-ligne (revue F2.1 — M1)', () => {
  it('liés au compte : un autre compte ne les voit pas (et ils sont purgés)', async () => {
    await saveTickets('user-a', [ticket('1')]);
    expect((await loadTickets('user-a'))?.tickets).toHaveLength(1);
    expect(await loadTickets('user-b')).toBeNull();
    expect(await loadTickets('user-a')).toBeNull(); // purgés
  });

  it('démarrage hors-ligne (compte inconnu) : affichés seulement si un seul compte depuis la dernière purge', async () => {
    await saveTickets('user-a', [ticket('1')]);
    expect((await loadTickets(null))?.tickets).toHaveLength(1);
    await saveTickets('user-b', [ticket('2')]); // 2e compte sur l'appareil, sans purge entre les deux
    expect(await loadTickets(null)).toBeNull();
    await clearTickets();
    await saveTickets('user-b', [ticket('2')]);
    expect((await loadTickets(null))?.tickets[0]?.id).toBe('2');
  });

  it('purge interrompue (marqueur en attente) ⇒ reprise au prochain accès', async () => {
    await saveTickets('user-a', [ticket('1')]);
    await __markPurgePendingForTests();
    expect(await loadTickets('user-a')).toBeNull();
    expect(await loadTickets(null)).toBeNull();
  });

  it('l’identifiant du compte n’est jamais stocké en clair', async () => {
    await saveTickets('user-a-identifiant', [ticket('1')]);
    const h = await ownerHash('user-a-identifiant');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('user-a');
  });

  it('F6-B5 : session terminée ou changée avant l’écriture ⇒ rien n’est enregistré', async () => {
    await saveTickets('user-a', [ticket('1')], () => false);
    expect(await loadTickets('user-a')).toBeNull();
    expect(await loadTickets(null)).toBeNull();
  });
});
