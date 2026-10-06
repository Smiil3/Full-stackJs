import { json, route } from '../core';
import { adminHandlers } from './admin';
import { authHandlers } from './auth';
import { buyerHandlers } from './buyer';
import { orgHandlers } from './org';

export const handlers = [
  route('get', '/health', () => json({ status: 'ok' })),
  ...authHandlers,
  ...buyerHandlers,
  ...orgHandlers,
  ...adminHandlers,
];
