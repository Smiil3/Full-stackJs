import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { assertPspConfig } from './lib/pspRedirect';
import './styles/global.css';

async function bootstrap() {
  // `import.meta.env.DEV` / `MODE` sont remplacés à la compilation : en build, cette branche et tout le
  // code de mock sont éliminés du bundle (et vite.config.ts refuse de construire en mode mock).
  if (import.meta.env.DEV && import.meta.env.MODE === 'mock') {
    const { startMockWorker } = await import('./mocks/browser');
    await startMockWorker();
  }
  const root = document.getElementById('root');
  if (!root) throw new Error('#root introuvable');
  try {
    // Configuration de déploiement vérifiée au démarrage (échec explicite plutôt qu'un comportement dégradé).
    assertPspConfig({ pspOrigin: import.meta.env.VITE_PSP_ORIGIN, isProd: import.meta.env.PROD });
  } catch (e) {
    root.textContent = 'Application mal configurée. Contactez l’administrateur du site.';
    throw e;
  }
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
