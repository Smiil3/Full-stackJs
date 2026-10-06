import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <section className="page">
      <h1>Page introuvable</h1>
      <p>Cette page n’existe pas ou n’est plus disponible.</p>
      <p>
        <Link to="/">Voir les événements</Link>
      </p>
    </section>
  );
}
