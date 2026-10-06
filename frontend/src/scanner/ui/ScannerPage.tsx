import { useCallback, useEffect, useRef, useState, type SubmitEvent } from 'react';
import { Link, useParams } from 'react-router';
import { isApiError } from '../../api/errors';
import { useAuth } from '../../auth/AuthContext';
import { PageLoader } from '../../components/PageLoader';
import { useOnline } from '../../lib/hooks/useOnline';
import { formatDateTime, formatTime, userTimeZone } from '../../lib/time';
import { admitUnknown, scanTicket, type ScanOutcome } from '../engine';
import { syncEvent } from '../sync';
import { CameraScanner } from './CameraScanner';
import { signal } from './feedback';
import { ResultOverlay } from './ResultOverlay';
import { useScannerData } from './useScannerData';
import { scannerErrorMessage } from './scannerError';
import { EventNotAvailableError } from '../engine';
import { prepareEvent } from '../snapshot';
import { useLocalNow } from '../../lib/hooks/useLocalNow';
import { formatAgo } from '../../lib/time';

const AUTO_DISMISS_MS = 2500;
const AUTO_SYNC_MS = 15_000;
/** Au-delà, la liste locale est signalée comme ancienne. */
const STALE_LIST_MS = 2 * 3_600_000;
const CONFLICT_LABELS: Record<string, string> = {
  ALREADY_USED: 'déjà utilisé',
  INVALID: 'invalide',
  CANCELLED: 'annulé',
  WRONG_EVENT: 'autre événement',
};

export function ScannerPage() {
  const { orgId = '', eventId = '' } = useParams();
  const { status } = useAuth();
  const online = useOnline() && status === 'authenticated';
  const { meta, pending, conflicts, reload } = useScannerData(eventId);
  const [outcome, setOutcome] = useState<ScanOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [syncInfo, setSyncInfo] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const processing = useRef(false);
  const localNow = useLocalNow(30_000);
  const [refreshing, setRefreshing] = useState(false);

  const sync = useCallback(async () => {
    if (!online || syncing) return;
    setSyncing(true);
    try {
      const r = await syncEvent(orgId, eventId);
      if (r.accepted || r.conflicts) setSyncInfo(`Synchronisé : ${r.accepted} entrée(s) confirmée(s)${r.conflicts ? `, ${r.conflicts} conflit(s)` : ''}.`);
    } catch (e) {
      // Réseau instable : nouvelle tentative automatique plus tard. Événement fermé : on le signale.
      if (isApiError(e) && e.code === 'NOT_FOUND') setError(new EventNotAvailableError());
    } finally {
      setSyncing(false);
      await reload();
    }
  }, [online, syncing, orgId, eventId, reload]);

  // Synchronisation automatique : au retour du réseau et périodiquement tant qu'il reste des scans.
  useEffect(() => {
    if (!online || pending === 0) return;
    const first = setTimeout(() => void sync(), 0);
    const id = setInterval(() => void sync(), AUTO_SYNC_MS);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- relance seulement sur réseau / file
  }, [online, pending > 0]);

  // Fermeture automatique des résultats simples (pas de la décision « laisser entrer / refuser »).
  useEffect(() => {
    if (!outcome || outcome.kind === 'UNKNOWN_AUTHENTIC') return;
    const t = setTimeout(() => setOutcome(null), AUTO_DISMISS_MS);
    return () => {
      clearTimeout(t);
    };
  }, [outcome]);

  const handleCode = useCallback(
    async (qrPayload: string) => {
      if (processing.current) return;
      processing.current = true;
      setError(null);
      try {
        const o = await scanTicket({ orgId, eventId, qrPayload, online });
        setOutcome(o);
        signal(o.kind === 'OK' ? true : o.kind === 'WRONG_EVENT' || o.kind === 'UNKNOWN_AUTHENTIC' ? 'warn' : false);
      } catch (e) {
        setError(e);
        signal(false);
      } finally {
        processing.current = false;
        await reload();
      }
    },
    [orgId, eventId, online, reload],
  );

  const admit = async () => {
    if (outcome?.kind !== 'UNKNOWN_AUTHENTIC') return;
    setBusy(true);
    try {
      const o = await admitUnknown(outcome.pending);
      setOutcome(o);
      signal(o.kind === 'OK');
    } finally {
      setBusy(false);
      await reload();
    }
  };

  const submitManual = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = manual.trim();
    if (!v) return;
    setManual('');
    void handleCode(v);
  };

  /** Rafraîchit la liste (billets annulés / vendus depuis) — recommandé juste avant l'ouverture des portes. */
  const refreshList = async () => {
    if (!meta || refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      await prepareEvent(orgId, { id: eventId, title: meta.title, venue: null, isOnline: false, startsAt: '', endsAt: '', timezone: meta.timezone, status: 'PUBLISHED' });
    } catch (e) {
      setError(e);
    } finally {
      setRefreshing(false);
      await reload();
    }
  };

  if (meta === undefined) return <PageLoader />;
  if (meta === null) {
    return (
      <section className="page">
        <h1>Contrôle d’accès</h1>
        <p className="alert alert--warning">La liste hors-ligne de cet événement n’est pas préparée sur cet appareil.</p>
        <Link className="btn" to="/scan">
          Préparer l’entrée
        </Link>
      </section>
    );
  }

  return (
    <section className="page scanner">
      {outcome ? <ResultOverlay outcome={outcome} timezone={meta.timezone} busy={busy} onClose={() => setOutcome(null)} onAdmit={() => void admit()} /> : null}
      <div className="row row--between">
        <h1 className="m-0">{meta.title}</h1>
        <span className={`badge ${online ? 'badge--available' : 'badge--low'}`}>{online ? 'En ligne' : 'Hors-ligne'}</span>
      </div>
      <p className="muted m-0">
        Liste téléchargée {formatAgo(Date.parse(meta.savedAt), localNow)} ({formatDateTime(meta.savedAt, userTimeZone())}) · {meta.ticketCount} billets
      </p>
      {localNow - Date.parse(meta.savedAt) > STALE_LIST_MS ? (
        <p className="alert alert--warning m-0">Liste ancienne : mettez-la à jour avant l’ouverture des portes (billets annulés ou vendus depuis).</p>
      ) : null}
      {online ? (
        <button type="button" className="btn btn--secondary btn--small" disabled={refreshing || pending > 0} onClick={() => void refreshList()}>
          {refreshing ? 'Mise à jour…' : 'Mettre à jour la liste'}
        </button>
      ) : null}
      <div inert={outcome !== null}>
        <CameraScanner onCode={(t) => void handleCode(t)} paused={outcome !== null} />
        <form className="row" onSubmit={submitManual} aria-label="Saisie manuelle">
          <div className="field m-0 grow">
            <label htmlFor="manual-code">Saisie manuelle du code</label>
            <input id="manual-code" value={manual} onChange={(e) => setManual(e.target.value)} autoComplete="off" spellCheck={false} maxLength={256} />
          </div>
          <button type="submit" className="btn">
            Vérifier
          </button>
        </form>
      </div>
      {error ? (
        <p className="alert alert--error" role="alert">
          {scannerErrorMessage(error)}
        </p>
      ) : null}
      <div className="card stack" aria-live="polite">
        <p className="m-0">
          <strong>{pending}</strong> scan{pending > 1 ? 's' : ''} en attente de synchro
        </p>
        {pending > 0 ? (
          <button type="button" className="btn btn--secondary btn--small" disabled={!online || syncing} onClick={() => void sync()}>
            {syncing ? 'Synchronisation…' : online ? 'Synchroniser maintenant' : 'Synchronisation au retour du réseau'}
          </button>
        ) : null}
        {syncInfo ? <p className="m-0 muted">{syncInfo}</p> : null}
      </div>
      {conflicts.length > 0 ? (
        <section className="card stack" aria-labelledby="titre-conflits">
          <h2 id="titre-conflits" className="m-0">
            Conflits ({conflicts.length})
          </h2>
          <p className="muted m-0">Entrées acceptées hors-ligne mais refusées par le serveur (ex. billet déjà utilisé à une autre porte).</p>
          <ul className="list-reset stack">
            {conflicts.map((c) => (
              <li key={c.scanId}>
                {formatTime(c.scannedAt, meta.timezone)} — {c.ticketTypeName ?? 'Billet'} {c.holderInitials ?? ''} : <strong>{CONFLICT_LABELS[c.result] ?? c.result}</strong>
                {c.usedAt ? ` (déjà entré à ${formatTime(c.usedAt, meta.timezone)})` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p>
        <Link to="/scan">Changer d’événement</Link>
      </p>
    </section>
  );
}
