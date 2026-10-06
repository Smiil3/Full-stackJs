import { useParams } from 'react-router';
import { useEvent } from '../../api/hooks/catalog';
import { AvailabilityBadge } from '../../components/AvailabilityBadge';
import { ErrorAlert } from '../../components/ErrorAlert';
import { EventTime } from '../../components/EventTime';
import { Icon } from '../../components/Icon';
import { PageLoader } from '../../components/PageLoader';
import { Poster } from '../../components/Poster';
import { formatTime } from '../../lib/time';
import { OrderForm } from './OrderForm';

export function EventPage() {
  const { eventId } = useParams();
  const { data: event, error, isPending, refetch } = useEvent(eventId);

  if (isPending) return <PageLoader shape="text" />;
  if (!event) return <ErrorAlert error={error} onRetry={() => void refetch()} />;

  return (
    <article className="page">
      <Poster hero id={event.id} iso={event.startsAt} timeZone={event.timezone} title={event.title} />
      <div className="stack stack--sm">
        <AvailabilityBadge value={event.coverAvailability} waitlist={event.rules.waitlistEnabled} />
        <h1>{event.title}</h1>
        <p className="muted">Organisé par {event.orgName}</p>
      </div>
      <dl className="kv event-facts">
        <dt>
          <Icon name="calendar" /> <span className="visually-hidden">Début</span>
        </dt>
        <dd>
          <EventTime iso={event.startsAt} timezone={event.timezone} />
        </dd>
        <dt>
          <Icon name="clock" /> <span className="visually-hidden">Fin</span>
        </dt>
        <dd>Fin à {formatTime(event.endsAt, event.timezone)} (heure de l’événement)</dd>
        <dt>
          <Icon name={event.isOnline ? 'globe' : 'map-pin'} /> <span className="visually-hidden">Lieu</span>
        </dt>
        <dd>
          {event.isOnline ? 'En ligne — le lien vous sera envoyé par email' : (event.venue ?? '—')}
          {event.address ? <span className="event-time__local">{event.address}</span> : null}
        </dd>
      </dl>
      {/* Texte saisi par l'organisateur : rendu en TEXTE (jamais HTML), retours ligne conservés. */}
      {event.description ? <p className="pre-line">{event.description}</p> : null}
      <OrderForm event={event} onStale={() => void refetch()} />
    </article>
  );
}
