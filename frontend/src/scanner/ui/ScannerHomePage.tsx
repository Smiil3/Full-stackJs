import { useState } from 'react';
import { Link } from 'react-router';
import { apiPath } from '../../api/client';
import { useCheckinEvents } from '../../api/hooks/org';
import type { CheckinEvent } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ErrorAlert } from '../../components/ErrorAlert';
import { PageLoader } from '../../components/PageLoader';
import { useOnline } from '../../lib/hooks/useOnline';
import { formatDateTime, userTimeZone } from '../../lib/time';
import { pendingCount, type SnapshotMeta } from '../db';
import { useLocalSnapshots } from './useScannerData';
import { prepareEvent } from '../snapshot';
import { scannerErrorMessage } from './scannerError';

function OrgEvents({ orgId, snapshots, onPrepared }: { orgId: string; snapshots: SnapshotMeta[]; onPrepared: () => void }) {
  const { data, error, isPending } = useCheckinEvents(orgId);
  const [busy, setBusy] = useState<string | null>(null);
  const [prepError, setPrepError] = useState<unknown>(null);
  const [warn, setWarn] = useState<string | null>(null);

  const prepare = async (e: CheckinEvent) => {
    setPrepError(null);
    setWarn(null);
    const others = snapshots.filter((s) => s.eventId !== e.id);
    for (const o of others) {
      if ((await pendingCount(o.eventId)) > 0) {
        setWarn(`Des entrées de « ${o.title} » ne sont pas encore synchronisées : synchronisez-les avant de changer d’événement.`);
        return;
      }
    }
    setBusy(e.id);
    try {
      await prepareEvent(orgId, e);
      onPrepared();
    } catch (err) {
      setPrepError(err);
    } finally {
      setBusy(null);
    }
  };

  if (isPending) return <PageLoader />;
  if (error) return <ErrorAlert error={error} />;
  return (
    <ul className="list-reset stack">
      {data.items.length === 0 ? <li className="muted">Aucun événement à contrôler.</li> : null}
      {data.items.map((e) => {
        const snap = snapshots.find((s) => s.eventId === e.id);
        return (
          <li key={e.id} className="card stack">
            <h2 className="card__title">{e.title}</h2>
            <p className="muted m-0">{formatDateTime(e.startsAt, e.timezone)}</p>
            <p className="m-0">
              {snap ? `Liste hors-ligne : ${snap.ticketCount} billets, téléchargée le ${formatDateTime(snap.savedAt, userTimeZone())}` : 'Liste hors-ligne non préparée'}
            </p>
            <div className="row">
              <button type="button" className="btn btn--secondary" disabled={busy !== null} onClick={() => void prepare(e)}>
                {busy === e.id ? 'Téléchargement…' : snap ? 'Mettre à jour la liste hors-ligne' : 'Préparer l’entrée hors-ligne'}
              </button>
              {snap ? (
                <Link className="btn" to={apiPath`/scan/${orgId}/${e.id}`}>
                  Contrôler les entrées
                </Link>
              ) : null}
            </div>
          </li>
        );
      })}
      {warn ? (
        <li className="alert alert--warning" role="alert">
          {warn}
        </li>
      ) : null}
      {prepError ? (
        <li className="alert alert--error" role="alert">
          {scannerErrorMessage(prepError)}
        </li>
      ) : null}
    </ul>
  );
}

/** Accueil du contrôle d'accès : choix de l'événement et préparation hors-ligne. */
export function ScannerHomePage() {
  const { user, status } = useAuth();
  const online = useOnline();
  const { data: snapshots = [], refetch } = useLocalSnapshots();
  const reload = () => {
    void refetch();
  };
  const orgs = user?.memberships ?? [];
  return (
    <section className="page">
      <h1>Contrôle d’accès</h1>
      {!online || status === 'offline' ? (
        <div className="stack">
          <p className="alert alert--warning">Hors-ligne : seuls les événements déjà préparés sur cet appareil sont disponibles.</p>
          {snapshots.map((s) => (
            <Link key={s.eventId} className="btn" to={apiPath`/scan/${s.orgId}/${s.eventId}`}>
              Contrôler « {s.title} »
            </Link>
          ))}
          {snapshots.length === 0 ? <p>Aucun événement préparé sur cet appareil.</p> : null}
        </div>
      ) : (
        orgs.map((m) => (
          <section key={m.orgId} className="stack" aria-label={m.orgName}>
            {orgs.length > 1 ? <h2>{m.orgName}</h2> : null}
            <OrgEvents orgId={m.orgId} snapshots={snapshots} onPrepared={reload} />
          </section>
        ))
      )}
      {online && status === 'authenticated' && orgs.length === 0 ? <p>Votre compte n’a accès au contrôle d’aucun collectif.</p> : null}
    </section>
  );
}
