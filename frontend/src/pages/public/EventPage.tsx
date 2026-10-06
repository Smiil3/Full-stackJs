import { useParams } from 'react-router';
import { useEvent } from '../../api/hooks/catalog';
import { ErrorAlert } from '../../components/ErrorAlert';
import { EventTime } from '../../components/EventTime';
import { PageLoader } from '../../components/PageLoader';
import { formatTime } from '../../lib/time';
import { OrderForm } from './OrderForm';

export function EventPage() {
  const { eventId } = useParams();
  const { data: event, error, isPending, refetch } = useEvent(eventId);

  if (isPending) return <PageLoader />;
  if (!event) return <ErrorAlert error={error} />;

  return (
    <article className="page">
      <p className="muted">{event.orgName}</p>
      <h1>{event.title}</h1>
      <dl className="kv">
        <dt>Début</dt>
        <dd>
          <EventTime iso={event.startsAt} timezone={event.timezone} />
        </dd>
        <dt>Fin</dt>
        <dd>{formatTime(event.endsAt, event.timezone)} (heure de l’événement)</dd>
        <dt>Lieu</dt>
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
