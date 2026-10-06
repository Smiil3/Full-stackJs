import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { apiPath } from '../../api/client';
import { errorMessage, isApiError } from '../../api/errors';
import { useEventMutations, useExportAttendees, useOrgEvent, useOrgSettings } from '../../api/hooks/org';
import { useAuth } from '../../auth/AuthContext';
import { membershipFor } from '../../auth/roles';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorAlert } from '../../components/ErrorAlert';
import { EventTime } from '../../components/EventTime';
import { PageLoader } from '../../components/PageLoader';
import { EVENT_STATUS_LABELS } from '../../lib/labels';
import { lookup } from '../../lib/lookup';
import { EventEditor } from './EventEditor';
import { TicketTypesEditor } from './TicketTypesEditor';

/** Titre recopié : tolère composition Unicode (NFC), espaces multiples et bords. */
const normalizeTitle = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();
const sameTitle = (typed: string, title: string) => normalizeTitle(typed) !== '' && normalizeTitle(typed) === normalizeTitle(title);

export function EventAdminPage() {
  const { orgId = '', eventId = '' } = useParams();
  const { user } = useAuth();
  const role = membershipFor(user, orgId)?.role ?? 'MANAGER';
  const { data: event, error, isPending, refetch } = useOrgEvent(orgId, eventId);
  const settings = useOrgSettings(orgId);
  const m = useEventMutations(orgId, eventId);
  const { data: titleData } = useOrgEvent(orgId, eventId);
  const exportCsv = useExportAttendees(orgId, eventId, titleData?.title);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState('');
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState(false);
  // Réinitialisé à chaque changement d'événement.
  const [stateFor, setStateFor] = useState(eventId);
  if (stateFor !== eventId) {
    setStateFor(eventId);
    setConfirmTitle('');
    setReason('');
    setCancelOpen(false);
    setEditing(false);
  }
  const closeCancel = () => {
    setCancelOpen(false);
    setConfirmTitle('');
    setReason('');
  };

  if (isPending) return <PageLoader />;
  if (!event) return <ErrorAlert error={error} />;
  const cancelled = event.status === 'CANCELLED';
  const base = apiPath`/org/${orgId}/events/${eventId}`;

  return (
    <section className="page">
      <p>
        <Link to={apiPath`/org/${orgId}`}>← Événements</Link>
      </p>
      <h1>{event.title}</h1>
      <p className="row">
        <span className={`badge badge--${event.status === 'PUBLISHED' ? 'available' : event.status === 'DRAFT' ? 'low' : 'sold_out'}`}>{lookup(EVENT_STATUS_LABELS, event.status)}</span>
      </p>
      <EventTime iso={event.startsAt} timezone={event.timezone} />

      <div className="row">
        <Link className="btn btn--secondary" to={`${base}/dashboard`}>
          Ventes en temps réel
        </Link>
        <Link className="btn btn--secondary" to={`${base}/orders`}>
          Commandes et virements
        </Link>
        <button type="button" className="btn btn--secondary" disabled={exportCsv.isPending} onClick={() => exportCsv.mutate()}>
          {exportCsv.isPending ? 'Export…' : 'Exporter les participants (CSV)'}
        </button>
      </div>
      <ErrorAlert error={exportCsv.error} />

      {event.status === 'DRAFT' ? (
        <div className="card stack">
          <p>Brouillon : l’événement n’est pas visible du public.</p>
          <button type="button" className="btn" disabled={m.publish.isPending} onClick={() => m.publish.mutate()}>
            {m.publish.isPending ? 'Publication…' : 'Publier l’événement'}
          </button>
          {m.publish.error ? (
            <p className="alert alert--error" role="alert">
              {isApiError(m.publish.error) && m.publish.error.code === 'CONFLICT'
                ? 'Publication impossible : ajoutez au moins un type de place et vérifiez que la fin des ventes est dans le futur.'
                : errorMessage(m.publish.error)}
            </p>
          ) : null}
        </div>
      ) : null}

      <TicketTypesEditor orgId={orgId} event={event} readOnly={cancelled} />

      {!cancelled ? (
        <section className="stack" aria-labelledby="titre-infos">
          <h2 id="titre-infos">Informations et règles de vente</h2>
          {editing ? (
            <EventEditor
              key={event.updatedAt}
              event={event}
              settings={settings.data}
              role={role}
              submitLabel="Enregistrer les modifications"
              pending={m.update.isPending}
              error={m.update.error}
              refreshEvent={async () => (await refetch()).data}
              onUpdate={async (patch) => {
                if (Object.keys(patch).length > 0) await m.update.mutateAsync(patch);
                setEditing(false);
              }}
            />
          ) : (
            <button type="button" className="btn btn--secondary" onClick={() => setEditing(true)}>
              Modifier l’événement
            </button>
          )}
        </section>
      ) : null}

      {role === 'OWNER' && !cancelled ? (
        <section className="stack card" aria-labelledby="titre-annulation">
          <h2 id="titre-annulation" className="m-0">
            Annuler l’événement
          </h2>
          <p>Toutes les commandes payées seront remboursées intégralement et les acheteurs prévenus par email. Action irréversible.</p>
          <button type="button" className="btn btn--danger" onClick={() => setCancelOpen(true)}>
            Annuler l’événement…
          </button>
        </section>
      ) : null}

      <ConfirmDialog
        open={cancelOpen}
        title="Annuler définitivement l’événement ?"
        confirmLabel="Annuler l’événement"
        cancelLabel="Ne rien faire"
        danger
        busy={m.cancel.isPending}
        confirmDisabled={!sameTitle(confirmTitle, event.title) || reason.trim().length < 1 || reason.length > 500}
        onCancel={closeCancel}
        onConfirm={() => m.cancel.mutate(reason.trim(), { onSuccess: closeCancel })}
      >
        <p>
          Les <strong>commandes payées seront remboursées intégralement</strong>, les autres annulées, et tous les acheteurs prévenus. Cette action est <strong>irréversible</strong>.
        </p>
        <div className="field">
          <label htmlFor="cancel-reason">Motif (communiqué aux acheteurs)</label>
          <textarea id="cancel-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="cancel-title">Pour confirmer, recopiez le titre : « {event.title} »</label>
          <input id="cancel-title" value={confirmTitle} onChange={(e) => setConfirmTitle(e.target.value)} autoComplete="off" />
        </div>
        <ErrorAlert error={m.cancel.error} />
      </ConfirmDialog>
    </section>
  );
}
