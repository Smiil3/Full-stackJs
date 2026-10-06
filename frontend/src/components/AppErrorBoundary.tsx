import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Dernier filet : une erreur de rendu hors du routeur affiche un message neutre
 * (jamais la pile ni le message technique) au lieu d'une page blanche.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Erreur d’affichage', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <GenericError />;
  }
}

export function GenericError() {
  return (
    <section className="page" role="alert">
      <h1>Un problème est survenu</h1>
      <p>Cette page n’a pas pu s’afficher. Rechargez-la ; si le problème persiste, réessayez un peu plus tard.</p>
      <p>
        <a href="/">Retour à l’accueil</a>
      </p>
    </section>
  );
}
