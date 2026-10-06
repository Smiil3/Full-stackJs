import { useCallback, useEffect, useRef, useState, type SubmitEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useCheckinEvents } from '../../api/hooks/org';
import { useAuth } from '../../auth/AuthContext';
import { PageLoader } from '../../components/PageLoader';
import { useLocalNow } from '../../lib/hooks/useLocalNow';
import { useOnline } from '../../lib/hooks/useOnline';
import { lookup } from '../../lib/lookup';
import { formatAgo, formatDateTime, formatTime, userTimeZone } from '../../lib/time';
import { markConflictsSeen, purgeEvent } from '../db';
import { admitUnknown, MAX_SNAPSHOT_AGE_MS, scanOnline, scanWithFallback, VerificationImpossibleError, type LocalReason, type ScanOutcome } from '../engine';
import { prepareEvent } from '../snapshot';
import { SyncForbiddenError, syncEvent } from '../sync';
import { CameraScanner } from './CameraScanner';
import { signal } from './feedback';
import { ResultOverlay } from './ResultOverlay';
import { scannerErrorMessage } from './scannerError';
import { useOwner, useScannerData } from './useScannerData';

const AUTO_DISMISS_MS = 2500;
const AUTO_SYNC_MS = 15_000;
/** Au-delà, la liste locale est signalée comme ancienne (refusée à 24 h). */
const STALE_LIST_MS = 2 * 3_600_000;
const CONFLICT_LABELS: Record<string, string> = { ALREADY_USED: 'déjà utilisé', INVALID: 'invalide', CANCELLED: 'annulé', WRONG_EVENT: 'autre événement' };
const REASON_LABELS: Record<LocalReason, string> = {
  offline: 'pas de réseau',
  network: 'réseau injoignable',
  timeout: 'serveur trop lent',
  server: 'serveur en difficulté',
  rate: 'trop de requêtes',
  session: 'session expirée',
};

type Failure = { qrPayload: string; scanId: string };

export function ScannerPage() {
  const { orgId = '', eventId = '' } = useParams();
  const { status } = useAuth();
  const online = useOnline() && status === 'authenticated';
  const owner = useOwner();
  const events = useCheckinEvents(orgId, status === 'authenticated');
  const eventInfo = events.data?.items.find((e) => e.id === eventId);
  const { meta, pending, otherPending, conflicts, reload } = useScannerData(eventId, owner);
  const [outcome, setOutcome] = useState<ScanOutcome | null>(null);
  const [checking, setChecking] = useState<false | 'first' | 'retry'>(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [admitting, setAdmitting] = useState(false);
  const [manual, setManual] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [syncInfo, setSyncInfo] = useState<string | null>(null);
  const [syncBlocked, setSyncBlocked] = useState<SyncForbiddenError | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [degraded, setDegraded] = useState<{ reason: LocalReason; count: number } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const processing = useRef(false);
  const admitGuard = useRef(false);
  const localNow = useLocalNow(30_000);

  // Mode secours seulement si la liste existe ET que l'événement l'autorise (vérifié en ligne quand possible).
  const rescue = Boolean(meta) && (eventInfo ? eventInfo.offlineCheckinEnabled : true);
  const title = meta?.title ?? eventInfo?.title ?? 'Contrôle d’accès';
  const timezone = meta?.timezone ?? eventInfo?.timezone ?? userTimeZone();

  // Mode secours désactivé entre-temps par l'organisateur : la liste locale est effacée (la file reste).
  useEffect(() => {
    if (meta && eventInfo && !eventInfo.offlineCheckinEnabled) {
      void purgeEvent(eventId).then(reload);
    }
  }, [meta, eventInfo, eventId, reload]);

  const sync = useCallback(async () => {
    if (!online || syncing || !owner || syncBlocked) return;
    setSyncing(true);
    try {
      const r = await syncEvent(orgId, eventId, owner);
      if (r.accepted || r.conflicts) setSyncInfo(`Synchronisé : ${r.accepted} entrée(s) confirmée(s)${r.conflicts ? `, ${r.conflicts} conflit(s)` : ''}.`);
    } catch (e) {
      if (e instanceof SyncForbiddenError) setSyncBlocked(e); // relances arrêtées
    } finally {
      setSyncing(false);
      await reload();
    }
  }, [online, syncing, owner, syncBlocked, orgId, eventId, reload]);

  useEffect(() => {
    if (!online || pending === 0 || syncBlocked) return;
    const first = setTimeout(() => void sync(), 0);
    const id = setInterval(() => void sync(), AUTO_SYNC_MS);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- relance seulement sur réseau / file
  }, [online, pending > 0, syncBlocked]);

  // Fermeture automatique UNIQUEMENT pour une entrée acceptée : un refus reste affiché jusqu'à un appui.
  useEffect(() => {
    if (outcome?.kind !== 'OK') return;
    const t = setTimeout(() => setOutcome(null), AUTO_DISMISS_MS);
    return () => {
      clearTimeout(t);
    };
  }, [outcome]);

  const show = (o: ScanOutcome) => {
    setOutcome(o);
    signal(o.kind === 'OK' ? true : o.kind === 'WRONG_EVENT' || o.kind === 'UNKNOWN_AUTHENTIC' ? 'warn' : false);
    if (o.offline) setDegraded((d) => ({ reason: o.reason, count: (d?.count ?? 0) + (o.kind === 'OK' ? 1 : 0) }));
    else setDegraded(null);
  };

  /** Renvoie false si une lecture est déjà en cours (la caméra ne mémorise alors pas ce code). */
  const handleCode = (qrPayload: string, scanId?: string): boolean => {
    if (processing.current) return false;
    processing.current = true;
    setError(null);
    setFailure(null);
    void (async () => {
      try {
        if (rescue && owner) {
          show(await scanWithFallback({ orgId, eventId, qrPayload, online, owner }));
        } else {
          setChecking('first');
          show(await scanOnline({ orgId, eventId, qrPayload, scanId, onRetry: () => setChecking('retry') }));
        }
      } catch (e) {
        if (e instanceof VerificationImpossibleError) setFailure({ qrPayload, scanId: e.scanId });
        else setError(e);
        signal(false);
      } finally {
        setChecking(false);
        processing.current = false;
        await reload();
      }
    })();
    return true;
  };

  const admit = async () => {
    if (outcome?.kind !== 'UNKNOWN_AUTHENTIC' || admitGuard.current) return;
    admitGuard.current = true;
    setAdmitting(true);
    try {
      show(await admitUnknown(outcome.pending, outcome.reason));
    } catch (e) {
      setOutcome(null);
      setError(e);
    } finally {
      admitGuard.current = false;
      setAdmitting(false);
      await reload();
    }
  };

  const submitManual = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = manual.trim();
    if (!v) return;
    setManual('');
    handleCode(v);
  };

  const refreshList = async () => {
    if (!eventInfo || refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      await prepareEvent(orgId, eventInfo);
    } catch (e) {
      setError(e);
    } finally {
      setRefreshing(false);
      await reload();
    }
  };

  if (meta === undefined || owner === undefined) return <PageLoader />;
  const overlayOpen = outcome !== null || checking !== false || failure !== null;
  const listAge = meta ? localNow - Date.parse(meta.savedAt) : 0;

  return (
    <section className="page scanner">
      {checking !== false ? (
        <div className="scan-result scan-result--pending" role="status" aria-live="assertive">
          <p className="scan-result__title">Vérification en cours…</p>
          {checking === 'retry' ? <p className="scan-result__detail">Réseau lent : nouvelle tentative</p> : null}
        </div>
      ) : null}
      {failure ? (
        <div className="scan-result scan-result--ko" role="alertdialog" aria-modal="true" aria-labelledby="scan-failure-title">
          <p id="scan-failure-title" className="scan-result__title">
            Vérification impossible — réessayez
          </p>
          <p className="scan-result__detail">Pas de réponse du serveur : ne laissez pas entrer.</p>
          <div className="scan-result__actions">
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- action principale de l'écran plein écran */}
            <button type="button" className="btn btn--block scan-result__btn" autoFocus onClick={() => handleCode(failure.qrPayload, failure.scanId)}>
              Réessayer
            </button>
            <button type="button" className="btn btn--block btn--secondary scan-result__btn" onClick={() => setFailure(null)}>
              Annuler
            </button>
          </div>
        </div>
      ) : null}
      {outcome ? <ResultOverlay outcome={outcome} timezone={timezone} busy={admitting} onClose={() => setOutcome(null)} onAdmit={() => void admit()} /> : null}

      <div className="row row--between">
        <h1 className="m-0">{title}</h1>
        <span className={`badge ${online ? 'badge--available' : 'badge--low'}`}>{online ? 'En ligne' : 'Hors-ligne'}</span>
      </div>

      {rescue ? (
        <p className="alert alert--warning m-0" role="note">
          <strong>Mode secours hors-ligne</strong> : risque de double entrée si plusieurs appareils — utilisez un seul appareil par porte.
        </p>
      ) : null}
      {degraded ? (
        <p className="alert alert--warning m-0" role="status">
          <strong>Vérification locale</strong> ({lookup(REASON_LABELS, degraded.reason)}) — {degraded.count} scan{degraded.count > 1 ? 's' : ''} local{degraded.count > 1 ? 'aux' : ''}
        </p>
      ) : null}
      {!rescue && !online ? (
        <p className="alert alert--error m-0" role="alert">
          Pas de réseau : les billets ne peuvent pas être vérifiés{eventInfo?.offlineCheckinEnabled === false ? ' (mode secours hors-ligne non activé pour cet événement)' : ''}. Ne laissez entrer personne.
        </p>
      ) : null}

      {meta ? (
        <>
          <p className="muted m-0">
            Liste téléchargée {formatAgo(Date.parse(meta.savedAt), localNow)} ({formatDateTime(meta.savedAt, userTimeZone())}) · {meta.ticketCount} billets
          </p>
          {listAge > MAX_SNAPSHOT_AGE_MS ? (
            <p className="alert alert--error m-0">Liste de plus de 24 h : contrôle local refusé, mettez-la à jour.</p>
          ) : listAge > STALE_LIST_MS ? (
            <p className="alert alert--warning m-0">Liste ancienne : mettez-la à jour avant l’ouverture des portes (billets annulés ou vendus depuis).</p>
          ) : null}
        </>
      ) : null}
      {online && eventInfo?.offlineCheckinEnabled ? (
        <button type="button" className="btn btn--secondary btn--small" disabled={refreshing || pending > 0} onClick={() => void refreshList()}>
          {refreshing ? 'Mise à jour…' : meta ? 'Mettre à jour la liste' : 'Préparer l’entrée hors-ligne'}
        </button>
      ) : null}

      <div inert={overlayOpen}>
        <CameraScanner onCode={(t) => handleCode(t)} paused={overlayOpen} />
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

      {rescue || pending > 0 ? (
        <div className="card stack" aria-live="polite">
          <p className="m-0">
            <strong>{pending}</strong> scan{pending > 1 ? 's' : ''} en attente de synchro
          </p>
          {pending > 0 && !syncBlocked ? (
            <button type="button" className="btn btn--secondary btn--small" disabled={!online || syncing} onClick={() => void sync()}>
              {syncing ? 'Synchronisation…' : online ? 'Synchroniser maintenant' : 'Synchronisation au retour du réseau'}
            </button>
          ) : null}
          {syncBlocked ? (
            <p className="alert alert--error m-0" role="alert">
              {scannerErrorMessage(syncBlocked)}
            </p>
          ) : null}
          {syncInfo ? <p className="m-0 muted">{syncInfo}</p> : null}
        </div>
      ) : null}
      {otherPending > 0 ? (
        <p className="alert alert--info m-0">
          {otherPending} scan{otherPending > 1 ? 's' : ''} d’un autre contrôleur en attente : ils seront transmis à sa prochaine connexion sur cet appareil.
        </p>
      ) : null}

      {conflicts.length > 0 ? (
        <section className="card stack" aria-labelledby="titre-conflits">
          <h2 id="titre-conflits" className="m-0">
            Conflits ({conflicts.length})
          </h2>
          <p className="muted m-0">Entrées acceptées hors-ligne mais refusées par le serveur (ex. billet déjà utilisé à une autre porte).</p>
          <ul className="list-reset stack">
            {conflicts.map((c) => (
              <li key={c.scanId}>
                {formatTime(c.scannedAt, timezone)} — {c.ticketTypeName ?? 'Billet'} {c.holderInitials ?? ''} : <strong>{lookup(CONFLICT_LABELS, c.result) ?? 'refusé'}</strong>
                {c.usedAt ? ` (déjà entré à ${formatTime(c.usedAt, timezone)})` : ''}
              </li>
            ))}
          </ul>
          {conflicts.some((c) => !c.seen) ? (
            <button type="button" className="btn btn--secondary btn--small" onClick={() => void markConflictsSeen(eventId).then(reload)}>
              J’ai pris connaissance
            </button>
          ) : null}
        </section>
      ) : null}

      <p className="row row--between">
        <Link to="/scan">Changer d’événement</Link>
        <span className="muted">Version {__APP_VERSION__}</span>
      </p>
    </section>
  );
}
