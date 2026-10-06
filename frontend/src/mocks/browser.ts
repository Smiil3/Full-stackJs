import { setupWorker } from 'msw/browser';
import { clearFaults, control, injectFault, mock, resetMockDb } from './core';
import { handlers } from './handlers';
import { mockOutbox } from './handlers/auth';

export async function startMockWorker(): Promise<void> {
  const worker = setupWorker(...handlers);
  await worker.start({ onUnhandledRequest: 'bypass', quiet: true });
  // Outils de démonstration (mode mock uniquement) : pannes, latence, mails simulés.
  Object.assign(window, { __nuitsMock: { mock, injectFault, clearFaults, control, resetMockDb, outbox: mockOutbox } });
  console.warn('[mock] MSW actif — API simulée. Comptes : voir README (mot de passe demo-nuits-2026).');
}
