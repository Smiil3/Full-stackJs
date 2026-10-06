import Joi from 'joi';
import { isoDateOutput, nullable, uuid, uuidStrict } from '../../lib/schemas.js';

export const orgParams = Joi.object<{ orgId: string }>({ orgId: uuid.required() });

export const checkinEventsResponse = Joi.object({
  items: Joi.array().items(Joi.object({
    id: uuidStrict, title: Joi.string(), venue: nullable(Joi.string()), isOnline: Joi.boolean(),
    startsAt: isoDateOutput, endsAt: isoDateOutput, timezone: Joi.string(), status: Joi.string().valid('PUBLISHED'),
    offlineCheckinEnabled: Joi.boolean(),
  })),
});

export const eventParams = Joi.object<{ orgId: string; eventId: string }>({ orgId: uuid.required(), eventId: uuid.required() });

const qrPayload = Joi.string().max(256).pattern(/^[\x21-\x7E]+$/).messages({ 'string.pattern.base': '{{#label}} est invalide' });
const isoInput = Joi.string().max(40).isoDate();

export interface ScanBody { qrPayload: string; deviceId: string; scanId: string }
export const scanBody = Joi.object<ScanBody>({ qrPayload: qrPayload.required(), deviceId: uuid.required(), scanId: uuid.required() });

export interface SyncBody { deviceId: string; scans: { scanId: string; qrPayload: string; scannedAt: string }[] }
export const syncBody = Joi.object<SyncBody>({
  deviceId: uuid.required(),
  scans: Joi.array()
    .items(Joi.object({ scanId: uuid.required(), qrPayload: qrPayload.required(), scannedAt: isoInput.required() }))
    .min(1).max(500).unique('scanId').required(),
});

const scanResult = Joi.string().valid('OK', 'ALREADY_USED', 'INVALID', 'CANCELLED', 'WRONG_EVENT');
const ticketBrief = Joi.object({ publicId: Joi.string(), ticketTypeName: Joi.string(), holderInitials: Joi.string() });

export const scanResponse = Joi.object({ result: scanResult, ticket: nullable(ticketBrief), usedAt: nullable(isoDateOutput) });
export const syncResponse = Joi.object({
  results: Joi.array().items(Joi.object({
    scanId: uuidStrict,
    result: Joi.string().valid('ACCEPTED', 'ALREADY_USED', 'INVALID', 'CANCELLED', 'WRONG_EVENT'),
    usedAt: nullable(isoDateOutput),
  })),
});
export const snapshotResponse = Joi.object({
  eventId: uuidStrict,
  generatedAt: isoDateOutput,
  publicKeyJwk: Joi.object({ kty: Joi.string().valid('OKP'), crv: Joi.string().valid('Ed25519'), x: Joi.string() }),
  tickets: Joi.array().items(Joi.object({
    publicId: Joi.string(), ticketTypeName: Joi.string(), holderInitials: Joi.string(),
    status: Joi.string().valid('VALID', 'USED', 'CANCELLED'), usedAt: nullable(isoDateOutput),
  })),
});
