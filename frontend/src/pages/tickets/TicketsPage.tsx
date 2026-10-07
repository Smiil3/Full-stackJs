import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { apiPath } from '../../api/client';
import { useCancelOrder, useOrders } from '../../api/hooks/orders';
import { useMyTickets } from '../../api/hooks/tickets';
import type { Order, Ticket } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ErrorAlert } from '../../components/ErrorAlert';
import { EventTime } from '../../components/EventTime';
import { Icon } from '../../components/Icon';
import { OrderStatusBadge } from '../../components/OrderStatusBadge';
import { PageLoader } from '../../components/PageLoader';
import { Poster } from '../../components/Poster';
import { QrFullscreen } from '../../components/QrFullscreen';
import { useNow } from '../../lib/hooks/useNow';
import { formatCents } from '../../lib/money';
import { formatDate, formatDateTime } from '../../lib/time';
import { canCancel } from '../orders/orderRules';
import { WaitlistSection } from './WaitlistSection';

/** Absence minimale (onglet masqué) avant de revérifier la session au retour sur « Mes billets ». */
const REVALIDATE_AFTER_HIDDEN_MS = 60_000;

type Group = { orderId: string; event: Ticket['event']; tickets: Ticket[] };

function groupByOrder(tickets: Ticket[]): Group[] {
  const map = new Map<string, Group>();
  for (const t of tickets) {
    const g = map.get(t.orderId) ?? { orderId: t.orderId, event: t.event, tickets: [] };
    g.tickets.push(t);
    map.set(t.orderId, g);
  }
  return [...map.values()];
}

/** « 2 billets · Fosse » / « 3 billets · Fosse, Balcon ». */
function ticketSummary(tickets: { ticketTypeName: string }[], count = tickets.length): string {
  const types = [...new Set(tickets.map((t) => t.ticketTypeName))].join(', ');
  return `${count} billet${count > 1 ? 's' : ''} · ${types}`;
}

export function TicketsPage() {
  const { status, revalidate, revalidating } = useAuth();
  const { data, error, isPending, refetch } = useMyTickets();
  // Commandes : uniquement pour l'annulation et les virements en attente (absentes hors-ligne).
  const { data: orders } = useOrders(1, status === 'authenticated');
  const now = useNow(60_000);
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [shown, setShown] = useState<{ orderId: string; index: number } | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // Page de QR redevenue visible APRÈS une vraie absence (appareil prêté, onglet repris longtemps après) :
  // session revérifiée, QR masqués entre-temps. Pas à chaque coup d'œil ailleurs (audit B17-g), ni sans réseau.
  useEffect(() => {
    let hiddenAt: number | null = null;
    const onVisible = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      if (away >= REVALIDATE_AFTER_HIDDEN_MS && navigator.onLine) void revalidate();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [revalidate]);

  const groups = useMemo(() => groupByOrder(data?.tickets ?? []), [data]);
  const ordersById = useMemo(() => new Map((orders?.items ?? []).map((o) => [o.id, o])), [orders]);
  const isPast = (g: { event: { endsAt: string } }) => Date.parse(g.event.endsAt) < now;
  const upcoming = groups.filter((g) => !isPast(g));
  const past = groups.filter(isPast);
  const pendingTransfers = (orders?.items ?? []).filter((o) => o.status === 'AWAITING_TRANSFER' && Date.parse(o.eventStartsAt) > now);

  // Toujours la version À JOUR des billets : un billet utilisé, annulé ou disparu quitte le plein écran.
  const shownGroup = shown ? groups.find((g) => g.orderId === shown.orderId) : undefined;
  const shownTickets = (shownGroup?.tickets ?? []).filter((t) => t.status === 'VALID');
  const shownIndex = shown ? Math.min(shown.index, shownTickets.length - 1) : 0;
  const fullscreen = shownGroup && shownTickets.length > 0 && !revalidating;
  const wasShown = useRef(false);
  useEffect(() => {
    if (fullscreen) {
      wasShown.current = true;
    } else if (wasShown.current) {
      wasShown.current = false;
      openerRef.current?.focus(); // retour du focus sur le bouton d'ouverture
    }
  }, [fullscreen]);

  const list = tab === 'upcoming' ? upcoming : past;
  return (
    <>
      {fullscreen ? (
        <QrFullscreen
          eventTitle={shownGroup.event.title}
          subtitle={formatDateTime(shownGroup.event.startsAt, shownGroup.event.timezone)}
          tickets={shownTickets}
          index={shownIndex}
          onNavigate={(index) => setShown((s) => (s ? { ...s, index } : s))}
          onClose={() => setShown(null)}
        />
      ) : null}
      {/* Liste gardée montée (inerte sous le plein écran) : le focus peut revenir sur le bouton d'ouverture. */}
      <section className="page" inert={fullscreen ? true : undefined}>
        <div className="row row--between">
          <h1>Mes billets</h1>
          {data && data.tickets.length > 0 ? (
            <span className="badge badge--info">
              <Icon name="wifi-off" size="sm" /> Disponibles hors-ligne
            </span>
          ) : null}
        </div>
        {data?.offline ? (
          <p className="alert alert--warning" role="status">
            <Icon name="wifi-off" />
            <span>
              Hors-ligne : billets enregistrés sur cet appareil{data.savedAt ? ` le ${formatDateTime(data.savedAt, Intl.DateTimeFormat().resolvedOptions().timeZone)}` : ''}. Leur statut peut avoir changé.
            </span>
          </p>
        ) : null}
        {isPending ? <PageLoader /> : null}
        {error instanceof Error && error.message === 'offline-empty' ? (
          <p className="alert alert--warning">
            <Icon name="wifi-off" />
            <span>Pas de réseau, et aucun billet n’est encore enregistré sur cet appareil.</span>
          </p>
        ) : (
          <ErrorAlert error={error} onRetry={() => void refetch()} />
        )}

        <div className="segmented" role="tablist" aria-label="Période">
          <button type="button" role="tab" id="tab-upcoming" aria-controls="panel-tickets" aria-selected={tab === 'upcoming'} onClick={() => setTab('upcoming')}>
            À venir ({upcoming.length + pendingTransfers.length})
          </button>
          <button type="button" role="tab" id="tab-past" aria-controls="panel-tickets" aria-selected={tab === 'past'} onClick={() => setTab('past')}>
            Passés
          </button>
        </div>

        <div id="panel-tickets" role="tabpanel" aria-labelledby={tab === 'upcoming' ? 'tab-upcoming' : 'tab-past'} className="stack">
          {list.map((g) => (
            <TicketGroupCard
              key={g.orderId}
              group={g}
              order={ordersById.get(g.orderId)}
              now={now}
              revalidating={revalidating}
              onShow={(opener) => {
                openerRef.current = opener;
                setShown({ orderId: g.orderId, index: 0 });
              }}
            />
          ))}
          {tab === 'upcoming' ? pendingTransfers.map((o) => <PendingTransferCard key={o.id} order={o} now={now} />) : null}
          {data && list.length === 0 && (tab === 'past' || pendingTransfers.length === 0) ? (
            tab === 'past' ? (
              <div className="empty-state">
                <Icon name="ticket" />
                <p className="empty-state__title">Pas encore de souvenirs ici</p>
                <p className="muted">Après chaque soirée, vos billets passent dans cet onglet.</p>
              </div>
            ) : (
              <div className="empty-state">
                <Icon name="ticket" />
                <p className="empty-state__title">Vous n’avez pas encore de billet</p>
                <Link className="btn" to="/">
                  Voir les événements
                </Link>
              </div>
            )
          ) : null}
          {tab === 'upcoming' && status === 'authenticated' ? <WaitlistSection /> : null}
        </div>
      </section>
    </>
  );
}

function TicketGroupCard({ group, order, now, revalidating, onShow }: { group: Group; order: Order | undefined; now: number; revalidating: boolean; onShow: (opener: HTMLElement) => void }) {
  const { event, tickets } = group;
  const valid = tickets.filter((t) => t.status === 'VALID');
  const [confirming, setConfirming] = useState(false);
  const cancel = useCancelOrder();
  const cancellable = order ? canCancel(order, now) && order.status === 'PAID' : false;
  const deadlinePassed = order?.status === 'PAID' && order.cancellableUntil !== null && now >= Date.parse(order.cancellableUntil);
  return (
    <article className="card stack ticket" aria-labelledby={`t-${group.orderId}`}>
      <div className="event-card">
        <Poster id={event.id} iso={event.startsAt} timeZone={event.timezone} />
        <div className="event-card__body">
          <h2 id={`t-${group.orderId}`} className="card__title">
            {event.title}
          </h2>
          <EventTime iso={event.startsAt} timezone={event.timezone} />
          <p className="event-card__meta">
            <Icon name={event.isOnline ? 'globe' : 'map-pin'} size="sm" />
            {event.isOnline ? 'En ligne' : (event.venue ?? '')}
          </p>
          <p className="muted">{ticketSummary(tickets)}</p>
        </div>
      </div>
      {tickets
        .filter((t) => t.status !== 'VALID')
        .map((t) =>
          t.status === 'USED' ? (
            <p key={t.id} className="badge badge--sold_out">
              Utilisé{t.usedAt ? ` le ${formatDateTime(t.usedAt, event.timezone)}` : ''}
            </p>
          ) : (
            <p key={t.id} className="badge badge--sold_out">
              Annulé
            </p>
          ),
        )}
      {valid.length > 0 ? (
        revalidating ? (
          <p className="muted" role="status">
            Vérification de la session…
          </p>
        ) : (
          <div className="row">
            <button type="button" className="btn" onClick={(e) => onShow(e.currentTarget)}>
              <Icon name="qr" /> Afficher le QR code
            </button>
            {cancellable && !confirming ? (
              <button type="button" className="btn btn--secondary" onClick={() => setConfirming(true)}>
                Annuler
              </button>
            ) : null}
          </div>
        )
      ) : null}
      {deadlinePassed && order.cancellableUntil ? <p className="muted">L’annulation n’est plus possible depuis le {formatDate(order.cancellableUntil, event.timezone)}.</p> : null}
      {confirming && order ? (
        <div className="card stack" data-theme="light" role="group" aria-labelledby={`c-${order.id}`}>
          <p id={`c-${order.id}`} className="card__title">
            Annuler {valid.length > 1 ? `ces ${valid.length} billets` : 'ce billet'} ?
          </p>
          <div className="summary">
            <p className="summary__total">
              <span>Remboursé {order.paymentMethod === 'CARD' ? 'sur votre carte' : 'par virement'}</span>
              <span className="summary__total-amount">{formatCents(order.refundPreviewCents ?? 0)}</span>
            </p>
            {order.totalCents - (order.refundPreviewCents ?? 0) > 0 ? (
              <p className="summary__line muted">
                <span>Non remboursé (frais de service, part non remboursable)</span>
                <span>{formatCents(order.totalCents - (order.refundPreviewCents ?? 0))}</span>
              </p>
            ) : null}
          </div>
          {order.cancellableUntil ? (
            <p className="muted">
              Possible jusqu’au {formatDateTime(order.cancellableUntil, event.timezone)}. L’argent arrive sous quelques jours, selon votre banque. Vos places seront proposées à la liste d’attente.
            </p>
          ) : null}
          <ErrorAlert error={cancel.error} />
          <div className="row">
            <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={cancel.isPending}>
              Garder mes billets
            </button>
            <button
              type="button"
              className="btn btn--danger"
              disabled={cancel.isPending}
              onClick={() =>
                cancel.mutate(order.id, {
                  onSuccess: () => {
                    setConfirming(false);
                  },
                })
              }
            >
              {cancel.isPending ? 'Patientez…' : 'Oui, annuler'}
            </button>
          </div>
        </div>
      ) : null}
      <Link to={apiPath`/orders/${group.orderId}`}>Voir la commande</Link>
    </article>
  );
}

function PendingTransferCard({ order, now }: { order: Order; now: number }) {
  const hours = order.expiresAt ? Math.max(0, Math.floor((Date.parse(order.expiresAt) - now) / 3_600_000)) : null;
  const count = order.items.reduce((s, i) => s + i.quantity, 0);
  return (
    <article className="card stack" aria-labelledby={`p-${order.id}`}>
      <div className="event-card">
        <Poster id={order.eventId} iso={order.eventStartsAt} timeZone={order.eventTimezone} />
        <div className="event-card__body">
          <OrderStatusBadge status={order.status} />
          <h2 id={`p-${order.id}`} className="card__title">
            {order.eventTitle}
          </h2>
          <EventTime iso={order.eventStartsAt} timezone={order.eventTimezone} />
          <p className="muted">
            {ticketSummary(order.items.map((i) => ({ ticketTypeName: i.name })), count)} · {formatCents(order.totalCents)}
          </p>
        </div>
      </div>
      <p>
        {hours !== null ? (
          <>
            Place gardée encore <strong>{hours < 1 ? 'moins d’1 h' : `${hours} h`}</strong>.{' '}
          </>
        ) : null}
        Vos billets apparaîtront ici dès la validation du virement.
      </p>
      <Link to={apiPath`/orders/${order.id}`}>Revoir les coordonnées bancaires</Link>
    </article>
  );
}
