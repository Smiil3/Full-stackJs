import { describeEventTime } from '../lib/time';

/** Horaire sans ambiguïté : fuseau de l'événement (nom + décalage) puis heure locale si différente. */
export function EventTime({ iso, timezone, className }: { iso: string; timezone: string; className?: string }) {
  const d = describeEventTime(iso, timezone);
  return (
    <span className={className}>
      <time dateTime={iso}>{d.event}</time>
      {d.local ? <span className="event-time__local">{d.local}</span> : null}
    </span>
  );
}
