import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { apiPath } from '../../api/client';
import { useCheckinEvents } from '../../api/hooks/org';
import type { CheckinEvent } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { roleAtLeast } from '../../auth/roles';
import { ErrorAlert } from '../../components/ErrorAlert';
import { PageLoader } from '../../components/PageLoader';
import { useOnline } from '../../lib/hooks/useOnline';
import { formatDateTime, userTimeZone } from '../../lib/time';
import { ownerHash, setScannerAccess, type SnapshotMeta } from '../db';
import { prepareEvent } from '../snapshot';
import { scannerErrorMessage } from './scannerError';
import { useLocalSnapshots } from './useScannerData';

function OrgEvents({ orgId, snapshots, onPrepared }: { orgId: string; snapshots: SnapshotMeta[]; onPrepared: () => void }) {
  const { data, error, isPending } = useCheckinEvents(orgId);
  const [busy, setBusy] = useState<string | null>(null);
  const [prepError, setPrepError] = useState<unknown>(null);

  const prepare = async (e: CheckinEvent) => {
    setPrepError(null);
    setBusy(e.id);
    try {
      await prepareEvent(orgId, e);
    } catch (err) {
      setPrepError(err);
    } finally {
      setBusy(null);
      onPrepared();
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
            {e.offlineCheckinEnabled ? (
              <p className="m-0">
                Mode secours hors-ligne autorisé —{' '}
                {snap ? `liste de ${snap.ticketCount} billets téléchargée le ${formatDateTime(snap.savedAt, userTimeZone())}` : 'liste non préparée'}
              </p>
            ) : (
              <p className="muted m-0">Contrôle en ligne (mode secours hors-ligne non activé)</p>
            )}
            <div className="row">
              <Link className="btn" to={apiPath`/scan/${orgId}/${e.id}`}>
                Contrôler les entrées
              </Link>
              {e.offlineCheckinEnabled ? (
                <button type="button" className="btn btn--secondary" disabled={busy !== null} onClick={() => void prepare(e)}>
                  {busy === e.id ? 'Téléchargement…' : snap ? 'Mettre à jour la liste hors-ligne' : 'Préparer l’entrée hors-ligne'}
                </button>
              ) : null}
            </div>
          </li>
        );
      })}
      {prepError ? (
        <li className="alert alert--error" role="alert">
          {scannerErrorMessage(prepError)}
        </li>
      ) : null}
    </ul>
  );
}

/** Accueil du contrôle d'accès : en ligne par défaut ; préparation hors-ligne seulement si autorisée. */
export function ScannerHomePage() {
  const { user, status } = useAuth();
  const online = useOnline();
  const { data: snapshots = [], refetch } = useLocalSnapshots();
  const scannerOrgs = (user?.memberships ?? []).filter((m) => roleAtLeast(m.role, 'SCANNER'));

  // Accès validés en ligne, mémorisés pour un éventuel démarrage hors-ligne (garde de route).
  useEffect(() => {
    if (status !== 'authenticated' || !user) return;
    void ownerHash(user.id).then((h) => setScannerAccess({ ownerHash: h, orgIds: scannerOrgs.map((m) => m.orgId) }));
  }, [status, user, scannerOrgs]);

  return (
    <section className="page">
      <h1>Contrôle d’accès</h1>
      {!online || status === 'offline' ? (
        <div className="stack">
          <p className="alert alert--warning">Hors-ligne : seuls les événements préparés en mode secours sur cet appareil peuvent être contrôlés.</p>
          {snapshots.map((s) => (
            <Link key={s.eventId} className="btn" to={apiPath`/scan/${s.orgId}/${s.eventId}`}>
              Contrôler « {s.title} »
            </Link>
          ))}
          {snapshots.length === 0 ? <p>Aucun événement préparé : la vérification des billets nécessite le réseau.</p> : null}
        </div>
      ) : (
        scannerOrgs.map((m) => (
          <section key={m.orgId} className="stack" aria-label={m.orgName}>
            {scannerOrgs.length > 1 ? <h2>{m.orgName}</h2> : null}
            <OrgEvents orgId={m.orgId} snapshots={snapshots} onPrepared={() => void refetch()} />
          </section>
        ))
      )}
      {online && status === 'authenticated' && scannerOrgs.length === 0 ? <p>Votre compte n’a accès au contrôle d’aucun collectif.</p> : null}
    </section>
  );
}
