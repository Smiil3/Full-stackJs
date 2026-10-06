import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { __resetClientForTests } from '../api/client';
import { runSessionCleanups } from '../auth/sessionCleanup';
import { __resetServerClock } from '../api/serverClock';
import { __resetCheckoutLaunched } from '../api/hooks/orders';
import { __resetUrlTokens } from '../pages/account/useUrlToken';
import { resetMockDb } from '../mocks/core';
import { server } from '../mocks/server';

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
// jsdom n'implémente pas le canvas : contexte 2D minimal pour le rendu des QR codes.
if (typeof HTMLCanvasElement !== 'undefined') HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: () => undefined,
    clearRect: () => undefined,
  } as unknown as CanvasRenderingContext2D;
} as unknown as typeof HTMLCanvasElement.prototype.getContext;

afterEach(async () => {
  cleanup();
  await runSessionCleanups(); // clés d'idempotence, billets hors-ligne…
  server.resetHandlers();
  resetMockDb();
  __resetClientForTests();
  __resetServerClock();
  __resetCheckoutLaunched();
  __resetUrlTokens();
});
afterAll(() => {
  server.close();
});
