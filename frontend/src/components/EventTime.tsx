import { describeEventTime } from '../lib/time';

/** Horaire sans ambiguïté : ligne 1 en gras dans le fuseau de l'événement, ligne 2 l'heure locale si elle diffère. */
export function EventTime({ iso, timezone, className }: { iso: string; timezone: string; className?: string }) {
  const d = describeEventTime(iso, timezone);
  return (
    <span className={['event-time', className].filter(Boolean).join(' ')}>
      <time dateTime={iso} className="event-time__main">
        {d.event}
      </time>
      {d.local ? <span className="event-time__local">{d.local}</span> : null}
    </span>
  );
}
