import type { NextFunction, Request, RequestHandler, Response } from 'express';
import Joi from 'joi';
import { getEnv } from '../config/env.js';
import { errors, ResponseContractError, type FieldError } from '../lib/errors.js';
import { HTTP_STATUS, MAX_INPUT_DEPTH } from '../config/http.js';

export interface RequestSchemas<P, Q, B, H> {
  params?: Joi.ObjectSchema<P>;
  query?: Joi.ObjectSchema<Q>;
  body?: Joi.ObjectSchema<B>;
  /** En-têtes : seuls ceux déclarés sont validés et transmis (les navigateurs en envoient beaucoup d'autres). */
  headers?: Joi.ObjectSchema<H>;
}

export interface ValidatedInput<P, Q, B, H> {
  params: P;
  query: Q;
  body: B;
  headers: H;
}

type Empty = Record<string, never>;

const EMPTY = Joi.object({});

/** Recherche d'un caractère NUL à n'importe quelle profondeur (Postgres le refuse : jamais jusqu'à la base). */
function findNul(value: unknown, path: string[] = [], depth = 0): string | null {
  if (depth > MAX_INPUT_DEPTH) return null;
  if (typeof value === 'string') return value.includes('\u0000') ? path.join('.') : null;
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const hit = findNul(v, [...path, String(i)], depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (k.includes('\u0000')) return [...path, k].join('.');
      const hit = findNul(v, [...path, k], depth + 1);
      if (hit !== null) return hit;
    }
  }
  return null;
}

function toFields(error: Joi.ValidationError): FieldError[] {
  return error.details.map((d) => ({ path: d.path.join('.'), message: d.message }));
}

/**
 * Valide params, query, body (et en-têtes déclarés) avec Joi.
 * - champs inconnus refusés (`allowUnknown: false`) → 400 VALIDATION_ERROR ;
 * - toutes les erreurs remontées (`abortEarly: false`) ;
 * - conversion de types uniquement pour params / query (chaînes d'URL) ; le body JSON est validé
 *   sans conversion (un "5" n'est pas un nombre).
 * L'entrée validée est rangée dans `res.locals.input` ; le contrôleur n'utilise jamais `req.body` directement.
 */
export function validate<P = Empty, Q = Empty, B = Empty, H = Empty>(schemas: RequestSchemas<P, Q, B, H>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const fields: FieldError[] = [];
    for (const source of [req.params, req.query, req.body as unknown]) {
      const hit = findNul(source);
      if (hit !== null) {
        next(errors.validation([{ path: hit, message: 'Caractère NUL interdit.' }]));
        return;
      }
    }
    const run = <T>(schema: Joi.ObjectSchema<T> | undefined, value: unknown, convert: boolean, prefix: string): T => {
      const result = (schema ?? EMPTY).validate(value ?? {}, {
        abortEarly: false,
        allowUnknown: false,
        convert,
        stripUnknown: false,
      });
      if (result.error) {
        for (const f of toFields(result.error)) fields.push({ path: prefix ? `${prefix}.${f.path}` : f.path, message: f.message });
      }
      return result.value as T;
    };

    const params = run(schemas.params, req.params, true, '');
    const query = run(schemas.query, req.query, true, '');
    const body = run(schemas.body, req.body, false, '');
    let headers: H = {} as H;
    if (schemas.headers) {
      const result = schemas.headers.validate(req.headers, {
        abortEarly: false,
        allowUnknown: true,
        stripUnknown: true,
        convert: true,
      });
      if (result.error) for (const f of toFields(result.error)) fields.push({ path: `headers.${f.path}`, message: f.message });
      const value: unknown = result.value;
      headers = value as H;
    }
    if (fields.length > 0) {
      next(errors.validation(fields));
      return;
    }
    res.locals['input'] = { params, query, body, headers } satisfies ValidatedInput<P, Q, B, H>;
    next();
  };
}

/**
 * Valide une réponse avant envoi.
 * - test / développement : un champ en trop ou manquant lève une erreur (le test échoue) ;
 * - production : les champs non déclarés sont retirés, un champ manquant donne une 500 journalisée.
 * Dans tous les cas, seuls les champs du contrat peuvent sortir.
 */
export function checkResponse<T>(schema: Joi.Schema<T>, data: unknown): T {
  const strict = getEnv().nodeEnv !== 'production';
  const result = schema.validate(data, {
    abortEarly: false,
    allowUnknown: false,
    stripUnknown: strict ? false : { arrays: false, objects: true },
    convert: false,
    presence: 'required',
  });
  // Chemins et types d'erreur Joi seulement : un message Joi peut citer la valeur fautive (donnée personnelle).
  if (result.error) throw new ResponseContractError(result.error.details.map((d) => `${d.path.join('.')}: ${d.type}`));
  return result.value;
}

export interface EndpointSpec<P, Q, B, H> extends RequestSchemas<P, Q, B, H> {
  /** Schéma de la réponse ; `null` = 204 sans corps. */
  response: Joi.Schema | null;
  status?: number;
}

/**
 * Déclare un endpoint : validation de l'entrée, appel du contrôleur typé, validation de la sortie.
 */
export function endpoint<P = Empty, Q = Empty, B = Empty, H = Empty>(
  spec: EndpointSpec<P, Q, B, H>,
  handler: (input: ValidatedInput<P, Q, B, H>, req: Request, res: Response) => Promise<unknown>,
): RequestHandler[] {
  const run: RequestHandler = async (req, res) => {
    const input = res.locals['input'] as ValidatedInput<P, Q, B, H>;
    const result: unknown = await handler(input, req, res);
    if (spec.response === null) {
      res.status(spec.status ?? HTTP_STATUS.NO_CONTENT).end();
      return;
    }
    const body: unknown = checkResponse(spec.response, result);
    const override: unknown = res.locals['status'];
    res.status(typeof override === 'number' ? override : (spec.status ?? HTTP_STATUS.OK)).json(body);
  };
  return [validate(spec), run];
}
