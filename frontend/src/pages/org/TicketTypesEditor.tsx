import { useState, type SubmitEvent } from 'react';
import { errorMessage, fieldErrors, isApiError } from '../../api/errors';
import { useEventMutations } from '../../api/hooks/org';
import type { EventAdmin, TicketTypeAdmin, TicketTypeBody } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Field } from '../../components/Field';
import { centsToEurosInput, formatCents } from '../../lib/money';
import { formatDateTime, timeZoneLabel, utcToZonedInput } from '../../lib/time';
import { draftToBody, type Draft } from './ticketTypeDraft';


const NEW = '__nouveau__';
const empty: Draft = { name: '', description: '', capacity: '', price: '', early: false, earlyPrice: '', earlyUntil: '' };

function toDraft(t: TicketTypeAdmin, tz: string): Draft {
  return {
    name: t.name,
    description: t.description ?? '',
    capacity: String(t.capacity),
    price: centsToEurosInput(t.priceCents),
    early: t.earlyPriceCents !== null,
    earlyPrice: t.earlyPriceCents !== null ? centsToEurosInput(t.earlyPriceCents) : '',
    earlyUntil: t.earlyUntil ? utcToZonedInput(t.earlyUntil, tz) : '',
  };
}

function TicketTypeForm({ event, initial, submitLabel, pending, error, onSubmit, onCancel }: {
  event: EventAdmin;
  initial: Draft;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (b: TicketTypeBody) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState(initial);
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const server = fieldErrors(error);
  const set = (k: keyof Draft, v: string | boolean) => setD((x) => ({ ...x, [k]: v }));
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const r = draftToBody(d, event);
    setErrors(r.errors);
    if (r.body && !pending) onSubmit(r.body);
  };
  return (
    <form className="card stack" onSubmit={submit} noValidate>
      <Field label="Nom du type de place" maxLength={80} value={d.name} onChange={(e) => set('name', e.target.value)} error={errors.name ?? server.name} />
      <Field label="Description (facultative)" maxLength={500} value={d.description} onChange={(e) => set('description', e.target.value)} error={server.description} />
      <div className="grid-2">
        <Field label="Capacité (places)" inputMode="numeric" value={d.capacity} onChange={(e) => set('capacity', e.target.value)} error={errors.capacity ?? server.capacity} />
        <Field label="Prix (€)" inputMode="decimal" hint="Ex. 25 ou 19,99" value={d.price} onChange={(e) => set('price', e.target.value)} error={errors.price ?? server.priceCents} />
      </div>
      <label className="row">
        <input type="checkbox" checked={d.early} onChange={(e) => set('early', e.target.checked)} />
        Tarif early (réduit jusqu’à une date)
      </label>
      {d.early ? (
        <div className="grid-2">
          <Field label="Prix early (€)" inputMode="decimal" value={d.earlyPrice} onChange={(e) => set('earlyPrice', e.target.value)} error={errors.earlyPrice ?? server.earlyPriceCents} />
          <Field
            label="Fin du tarif early"
            type="datetime-local"
            hint={`En ${timeZoneLabel(event.timezone)}`}
            value={d.earlyUntil}
            onChange={(e) => set('earlyUntil', e.target.value)}
            error={errors.earlyUntil ?? server.earlyUntil}
          />
        </div>
      ) : null}
      {error && Object.keys(server).length === 0 ? (
        <p className="alert alert--error" role="alert">
          {isApiError(error) && error.code === 'CONFLICT' ? 'La capacité ne peut pas être inférieure aux places déjà vendues ou réservées.' : errorMessage(error)}
        </p>
      ) : null}
      <div className="row">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? 'Enregistrement…' : submitLabel}
        </button>
        <button type="button" className="btn btn--secondary" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </form>
  );
}

export function TicketTypesEditor({ orgId, event, readOnly }: { orgId: string; event: EventAdmin; readOnly: boolean }) {
  const m = useEventMutations(orgId, event.id);
  /** id du type en cours d'édition, NEW pour un ajout. */
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TicketTypeAdmin | null>(null);
  return (
    <section className="stack" aria-labelledby="titre-types">
      <h2 id="titre-types">Types de places</h2>
      {event.ticketTypes.length === 0 ? <p className="muted">Aucun type de place : ajoutez-en au moins un pour pouvoir publier.</p> : null}
      <ul className="list-reset stack">
        {event.ticketTypes.map((t) =>
          editing === t.id ? (
            <li key={t.id}>
              <TicketTypeForm
                event={event}
                initial={toDraft(t, event.timezone)}
                submitLabel="Enregistrer"
                pending={m.updateType.isPending}
                error={m.updateType.error}
                onSubmit={(body) => m.updateType.mutate({ id: t.id, body }, { onSuccess: () => setEditing(null) })}
                onCancel={() => setEditing(null)}
              />
            </li>
          ) : (
            <li key={t.id} className="card stack">
              <div className="row row--between">
                <h3 className="m-0">{t.name}</h3>
                <strong>{formatCents(t.priceCents)}</strong>
              </div>
              {t.earlyPriceCents !== null && t.earlyUntil ? (
                <p className="muted">
                  Early : {formatCents(t.earlyPriceCents)} jusqu’au {formatDateTime(t.earlyUntil, event.timezone)}
                </p>
              ) : null}
              <p>
                Capacité {t.capacity} · vendues {t.sold} · en attente de paiement {t.held} · restantes {t.remaining}
              </p>
              {!readOnly ? (
                <div className="row">
                  <button type="button" className="btn btn--secondary btn--small" onClick={() => setEditing(t.id)}>
                    Modifier
                  </button>
                  <button type="button" className="btn btn--secondary btn--small" onClick={() => setDeleting(t)}>
                    Supprimer
                  </button>
                </div>
              ) : null}
            </li>
          ),
        )}
      </ul>
      {!readOnly ? (
        editing === NEW ? (
          <TicketTypeForm
            event={event}
            initial={empty}
            submitLabel="Ajouter"
            pending={m.addType.isPending}
            error={m.addType.error}
            onSubmit={(body) => m.addType.mutate(body, { onSuccess: () => setEditing(null) })}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <button type="button" className="btn btn--secondary" onClick={() => setEditing(NEW)}>
            Ajouter un type de place
          </button>
        )
      ) : null}
      {m.deleteType.error ? (
        <p className="alert alert--error" role="alert">
          {isApiError(m.deleteType.error) && m.deleteType.error.code === 'CONFLICT'
            ? 'Impossible de supprimer ce type de place : des commandes existent déjà. Vous pouvez réduire sa capacité.'
            : errorMessage(m.deleteType.error)}
        </p>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        title="Supprimer ce type de place ?"
        confirmLabel="Supprimer"
        danger
        busy={m.deleteType.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) m.deleteType.mutate(deleting.id, { onSettled: () => setDeleting(null) });
        }}
      >
        <p>« {deleting?.name} » sera supprimé.</p>
      </ConfirmDialog>
    </section>
  );
}
