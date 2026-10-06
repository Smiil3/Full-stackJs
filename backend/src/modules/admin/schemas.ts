import Joi from 'joi';
import { email, isoDateOutput, pageOf, pageQuery, text, uuidStrict, type PageQuery } from '../../lib/schemas.js';
import { FIELD_LIMITS } from '../../config/fields.js';

export interface CreateOrgBody { name: string; slug: string; ownerEmail: string }
export const createOrgBody = Joi.object<CreateOrgBody>({
  name: text().min(FIELD_LIMITS.orgNameMin).max(FIELD_LIMITS.orgNameMax).required(),
  slug: Joi.string().pattern(/^[a-z0-9-]{2,40}$/).required().messages({ 'string.pattern.base': '{{#label}} : 2 à 40 caractères parmi a-z, 0-9 et -' }),
  ownerEmail: email.required(),
});

export const adminOrgResponse = Joi.object({ id: uuidStrict, name: Joi.string(), slug: Joi.string(), createdAt: isoDateOutput });
export const adminOrgList = pageOf(adminOrgResponse);
export const adminOrgsQuery = Joi.object<PageQuery>(pageQuery);
