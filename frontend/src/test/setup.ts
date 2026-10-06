import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { __resetClientForTests } from '../api/client';
import { resetMockDb } from '../mocks/core';
import { server } from '../mocks/server';

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetMockDb();
  __resetClientForTests();
});
afterAll(() => {
  server.close();
});
