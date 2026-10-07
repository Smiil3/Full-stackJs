import { getDb } from '../src/lib/db.js';
import { addMember, api, createOrg, loggedInUser, type LoggedIn } from './helpers.js';

export interface OrgFixture {
  id: string;
  slug: string;
  owner: LoggedIn;
  manager: LoggedIn;
  scanner: LoggedIn;
}

export async function orgWithStaff(slug: string): Promise<OrgFixture> {
  const org = await createOrg(slug);
  const [owner, manager, scanner] = await Promise.all([loggedInUser(), loggedInUser(), loggedInUser()]);
  await addMember(org.id, owner.id, 'OWNER');
  await addMember(org.id, manager.id, 'MANAGER');
  await addMember(org.id, scanner.id, 'SCANNER');
  return { id: org.id, slug, owner, manager, scanner };
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export function eventBody(overrides: Record<string, unknown> = {}) {
  const start = Date.now() + 30 * DAY;
  return {
    title: 'Nuit test',
    isOnline: false,
    venue: 'Hangar 14',
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 5 * HOUR).toISOString(),
    timezone: 'Europe/Paris',
    salesStartAt: new Date(Date.now() - DAY).toISOString(),
    salesEndAt: new Date(start).toISOString(),
    ...overrides,
  };
}

/** Dates d'un événement qui commence dans 2 h : dans la fenêtre de contrôle (startsAt − 12 h → endsAt + 24 h). */
export function soonBody() {
  const start = Date.now() + 2 * HOUR;
  return { startsAt: new Date(start).toISOString(), endsAt: new Date(start + 5 * HOUR).toISOString(), salesEndAt: new Date(start).toISOString() };
}

/** Crée un événement (DRAFT) via l'API, avec des types de places optionnels, puis le publie si demandé. */
export async function createEvent(
  org: OrgFixture,
  opts: { body?: Record<string, unknown>; ticketTypes?: Record<string, unknown>[]; publish?: boolean } = {},
) {
  // Surcharges (dont financières, réservées à l'OWNER — contrat 1.17 §7.2) : création par l'OWNER ; sinon par un MANAGER.
  const author = opts.body?.['overrides'] === undefined ? org.manager : org.owner;
  const res = await api().post(`/api/v1/orgs/${org.id}/events`).set(author.auth).send(eventBody(opts.body));
  if (res.status !== 201) throw new Error(`création d'événement KO ${res.status} ${JSON.stringify(res.body)}`);
  const eventId = res.body.id as string;
  const ticketTypeIds: string[] = [];
  for (const tt of opts.ticketTypes ?? []) {
    const r = await api().post(`/api/v1/orgs/${org.id}/events/${eventId}/ticket-types`).set(org.manager.auth).send(tt);
    if (r.status !== 201) throw new Error(`type de place KO ${r.status} ${JSON.stringify(r.body)}`);
    ticketTypeIds.push(r.body.id as string);
  }
  if (opts.publish) await api().post(`/api/v1/orgs/${org.id}/events/${eventId}/publish`).set(org.manager.auth).expect(200);
  return { eventId, ticketTypeIds };
}

/** Rapproche le début de l'événement (dans 1 h) pour ouvrir la fenêtre de contrôle ; les commandes gardent leurs droits figés. */
export async function openCheckinWindow(eventId: string) {
  await getDb().event.update({ where: { id: eventId }, data: { startsAt: new Date(Date.now() + 3600_000) } });
}

export async function setStock(ticketTypeId: string, sold: number, held = 0) {
  await getDb().ticketType.update({ where: { id: ticketTypeId }, data: { sold, held } });
}
