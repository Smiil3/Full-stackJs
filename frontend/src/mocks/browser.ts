import { setupWorker } from 'msw/browser';
import { clearFaults, control, injectFault, mock, resetMockDb } from './core';
import { handlers } from './handlers';
import { mockOutbox } from './handlers/auth';
import { seedDemoBuyer } from './demoSeed';

export async function startMockWorker(): Promise<void> {
  const worker = setupWorker(...handlers);
  await worker.start({ onUnhandledRequest: 'bypass', quiet: true });
  // Outils de démonstration (serveur de dev en mode mock uniquement) : pannes, latence, mails simulés.
  if (import.meta.env.DEV) {
    Object.assign(window, { __nuitsMock: { mock, injectFault, clearFaults, control, resetMockDb, outbox: mockOutbox, seedDemoBuyer } });
  }
  console.warn('[mock] MSW actif — API simulée. Comptes : voir README (mot de passe demo-nuits-2026).');
}
