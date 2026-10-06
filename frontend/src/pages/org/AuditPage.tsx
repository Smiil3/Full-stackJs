import { useState } from 'react';
import { useParams } from 'react-router';
import { useAuditLog } from '../../api/hooks/org';
import { ErrorAlert } from '../../components/ErrorAlert';
import { PageLoader } from '../../components/PageLoader';
import { formatDateTime, userTimeZone } from '../../lib/time';

const PREVIEW = 300;

/** Détails en TEXTE (jamais interprétés). */
function metaText(meta: unknown): string {
  if (meta === null || meta === undefined) return '';
  try {
    return JSON.stringify(meta);
  } catch {
    return '';
  }
}

function MetaCell({ meta }: { meta: unknown }) {
  const [open, setOpen] = useState(false);
  const text = metaText(meta);
  const long = text.length > PREVIEW;
  return (
    <>
      <code className="pre-line">{long && !open ? `${text.slice(0, PREVIEW)}…` : text}</code>
      {long ? (
        <button type="button" className="btn btn--secondary btn--small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Réduire' : 'Voir tout'}
        </button>
      ) : null}
    </>
  );
}

export function AuditPage() {
  const { orgId = '' } = useParams();
  const [page, setPage] = useState(1);
  const { data, error, isPending } = useAuditLog(orgId, page);
  const tz = userTimeZone();
  return (
    <section className="page">
      <h1>Journal d’audit</h1>
      {isPending ? <PageLoader /> : null}
      <ErrorAlert error={error} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Auteur</th>
              <th scope="col">Action</th>
              <th scope="col">Cible</th>
              <th scope="col">Détails</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((a) => (
              <tr key={a.id}>
                <td>{formatDateTime(a.createdAt, tz)}</td>
                <td>{a.actorEmail ?? 'Système'}</td>
                <td>{a.action}</td>
                <td className="mono">{a.target}</td>
                <td>
                  <MetaCell meta={a.meta} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.total > data.pageSize ? (
        <nav className="row" aria-label="Pagination">
          <button type="button" className="btn btn--secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Précédent
          </button>
          <span>
            Page {page} / {Math.min(1000, Math.ceil(data.total / data.pageSize))}
          </span>
          <button type="button" className="btn btn--secondary" disabled={page * data.pageSize >= data.total || page >= 1000} onClick={() => setPage((p) => p + 1)}>
            Suivant
          </button>
        </nav>
      ) : null}
    </section>
  );
}
