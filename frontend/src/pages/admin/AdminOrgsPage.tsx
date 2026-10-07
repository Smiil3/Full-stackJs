import { useState, type SubmitEvent } from 'react';
import { errorMessage, fieldErrors, isApiError } from '../../api/errors';
import { useAdminOrgs, useCreateOrg } from '../../api/hooks/org';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Field } from '../../components/Field';
import { PageLoader } from '../../components/PageLoader';
import { slugify } from '../../lib/slug';
import { formatDate, userTimeZone } from '../../lib/time';
import { AdminNav } from './AdminNav';

export function AdminOrgsPage() {
  const [page, setPage] = useState(1);
  const { data, error, isPending } = useAdminOrgs(page);
  const create = useCreateOrg();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [owner, setOwner] = useState('');
  const [local, setLocal] = useState<Partial<Record<'name' | 'slug' | 'owner', string>>>({});
  const server = fieldErrors(create.error);
  const effectiveSlug = slugTouched ? slug : slugify(name);

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const errs = {
      name: name.trim().length < 2 || name.length > 80 ? 'Entre 2 et 80 caractères.' : undefined,
      slug: /^[a-z0-9-]{2,40}$/.test(effectiveSlug) ? undefined : 'Minuscules, chiffres et tirets (2 à 40).',
      owner: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner.trim()) ? undefined : 'Adresse email invalide.',
    };
    setLocal(errs);
    if (Object.values(errs).some(Boolean) || create.isPending) return;
    create.mutate(
      { name: name.trim(), slug: effectiveSlug, ownerEmail: owner.trim() },
      {
        onSuccess: () => {
          setName('');
          setSlug('');
          setSlugTouched(false);
          setOwner('');
        },
      },
    );
  };

  const apiMessage = (() => {
    if (!create.error || Object.keys(server).length) return null;
    if (isApiError(create.error) && create.error.code === 'NOT_FOUND') return 'Aucun compte confirmé n’utilise cette adresse : le futur propriétaire doit d’abord créer son compte.';
    if (isApiError(create.error) && create.error.code === 'CONFLICT') return 'Cet identifiant (slug) est déjà utilisé.';
    return errorMessage(create.error);
  })();

  return (
    <section className="page">
      <h1>Administration — collectifs</h1>
      <AdminNav />
      {isPending ? <PageLoader /> : null}
      <ErrorAlert error={error} />
      <ul className="list-reset stack">
        {data?.items.map((o) => (
          <li key={o.id} className="card row row--between">
            <span>
              <strong>{o.name}</strong> <span className="muted mono">{o.slug}</span>
            </span>
            <span className="muted">créé le {formatDate(o.createdAt, userTimeZone())}</span>
          </li>
        ))}
      </ul>
      {data && data.total > data.pageSize ? (
        <nav className="row" aria-label="Pagination">
          <button type="button" className="btn btn--secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Précédent
          </button>
          <span>
            Page {page} / {Math.ceil(data.total / data.pageSize)}
          </span>
          <button type="button" className="btn btn--secondary" disabled={page * data.pageSize >= data.total} onClick={() => setPage((p) => p + 1)}>
            Suivant
          </button>
        </nav>
      ) : null}
      <form className="card stack" onSubmit={submit} noValidate>
        <h2 className="m-0">Créer un collectif</h2>
        <Field label="Nom" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} error={local.name ?? server.name} />
        <Field
          label="Identifiant (slug)"
          hint="Utilisé dans les adresses ; minuscules, chiffres et tirets."
          maxLength={40}
          value={effectiveSlug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
          error={local.slug ?? server.slug}
        />
        <Field label="Email du propriétaire (compte existant et confirmé)" type="email" value={owner} onChange={(e) => setOwner(e.target.value)} error={local.owner ?? server.ownerEmail} />
        {apiMessage ? (
          <p className="alert alert--error" role="alert">
            {apiMessage}
          </p>
        ) : null}
        {create.isSuccess ? (
          <p className="alert alert--success" role="status">
            Collectif « {create.data.name} » créé.
          </p>
        ) : null}
        <button type="submit" className="btn" disabled={create.isPending}>
          Créer le collectif
        </button>
      </form>
    </section>
  );
}
