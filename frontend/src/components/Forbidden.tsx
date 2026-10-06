import { Link } from 'react-router';

export function Forbidden() {
  return (
    <section className="page">
      <h1>Accès non autorisé</h1>
      <p>Cette page n’est pas accessible avec votre compte.</p>
      <p>
        <Link to="/">Retour aux événements</Link>
      </p>
    </section>
  );
}
