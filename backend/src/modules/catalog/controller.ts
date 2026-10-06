import type { ValidatedInput } from '../../middlewares/validate.js';
import * as service from './service.js';
import type { CatalogQuery } from './schemas.js';

type Empty = Record<string, never>;

export const list = ({ query }: ValidatedInput<Empty, CatalogQuery, Empty, Empty>) => {
  const filter: { orgSlug?: string; from?: string; to?: string } = {};
  if (query.orgSlug) filter.orgSlug = query.orgSlug;
  if (query.from) filter.from = query.from;
  if (query.to) filter.to = query.to;
  return service.listEvents(filter, query.page, query.pageSize);
};
export const get = ({ params }: ValidatedInput<{ eventId: string }, Empty, Empty, Empty>) => service.getEvent(params.eventId);
