import { useMemo, useState, type SubmitEvent } from 'react';
import { errorMessage, fieldErrors } from '../../api/errors';
import type { EventAdmin, EventCreateBody, EventPatchBody, OrgRole, OrgSettings } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Field } from '../../components/Field';
import { listTimeZones, timeZoneLabel } from '../../lib/time';
import { buildEventBody, DATE_FIELDS, diffPatch, hasSales, initialEventForm, isReschedule, type DateField, type EventFormState, type FormErrors } from './eventForm';
import { SalesRulesEditor } from './SalesRulesEditor';

const DATE_LABELS: Record<DateField, string> = {
  startsAt: 'Début de l’événement',
  endsAt: 'Fin de l’événement',
  salesStartAt: 'Ouverture des ventes',
  salesEndAt: 'Fin des ventes',
};

type Props = {
  settings: OrgSettings | undefined;
  role: OrgRole;
  submitLabel: string;
  pending: boolean;
  error: unknown;
} & ({ event: null; onCreate: (body: EventCreateBody) => void } | { event: EventAdmin; onUpdate: (patch: EventPatchBody) => void });

const LOCKED_DATES: readonly DateField[] = ['startsAt', 'endsAt'];

export function EventEditor(props: Props) {
  const [initial] = useState<EventFormState>(() => initialEventForm(props.event, props.settings));
  const [form, setForm] = useState<EventFormState>(initial);
  const [pendingPatch, setPendingPatch] = useState<EventPatchBody | null>(null);
  const [reason, setReason] = useState('');
  const sold = hasSales(props.event);
  // Contrat v1.7 : report d'un événement vendu réservé à l'OWNER (le serveur renverrait 403).
  const datesLocked = sold && props.role !== 'OWNER';
  const [errors, setErrors] = useState<FormErrors>({});
  const zones = useMemo(() => listTimeZones(), []);
  const server = fieldErrors(props.error);
  const { notes } = buildEventBody(form, props.settings);
  const set = <K extends keyof EventFormState>(k: K, v: EventFormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const r = buildEventBody(form, props.settings);
    setErrors(r.errors);
    if (!r.body || props.pending) return;
    if (props.event === null) {
      props.onCreate(r.body);
      return;
    }
    const patch = diffPatch(props.event, initial, form, r.body);
    if (isReschedule(props.event, patch)) {
      setPendingPatch(patch); // confirmation forte + motif obligatoire
      return;
    }
    props.onUpdate(patch);
  };

  const confirmReschedule = () => {
    if (!pendingPatch || props.event === null || reason.trim().length < 1 || reason.length > 500) return;
    props.onUpdate({ ...pendingPatch, rescheduleReason: reason.trim() });
    setPendingPatch(null);
  };

  const ruleServerErrors = Object.fromEntries(
    Object.entries(server)
      .filter(([k]) => k.startsWith('overrides.'))
      .map(([k, v]) => [k.slice('overrides.'.length), v]),
  );

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <Field label="Titre" required maxLength={150} value={form.title} onChange={(e) => set('title', e.target.value)} error={errors.title ?? server.title} />
      <div className="field">
        <label htmlFor="ev-description">Description</label>
        <textarea id="ev-description" maxLength={5000} value={form.description} onChange={(e) => set('description', e.target.value)} aria-describedby="ev-description-hint" />
        <span id="ev-description-hint" className="field__hint">
          Texte simple : les retours à la ligne sont conservés, aucune mise en forme HTML.
        </span>
        {errors.description ?? server.description ? <span className="field__error">{errors.description ?? server.description}</span> : null}
      </div>
      <label className="row">
        <input type="checkbox" checked={form.isOnline} onChange={(e) => set('isOnline', e.target.checked)} />
        Événement en ligne
      </label>
      {!form.isOnline ? (
        <>
          <Field label="Lieu" maxLength={150} value={form.venue} onChange={(e) => set('venue', e.target.value)} error={server.venue} />
          <Field label="Adresse" maxLength={300} value={form.address} onChange={(e) => set('address', e.target.value)} error={server.address} />
        </>
      ) : null}

      <div className="field">
        <label htmlFor="ev-timezone">Fuseau horaire de l’événement</label>
        <select id="ev-timezone" value={form.timezone} disabled={datesLocked} onChange={(e) => set('timezone', e.target.value)}>
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
        <span className="field__hint">Les dates ci-dessous sont saisies en {timeZoneLabel(form.timezone)}.</span>
        {errors.timezone ?? server.timezone ? <span className="field__error">{errors.timezone ?? server.timezone}</span> : null}
      </div>
      {datesLocked ? (
        <p className="alert alert--info">Des places ont été vendues : seul le propriétaire du collectif peut reporter l’événement (dates de début et de fin, fuseau).</p>
      ) : null}
      <div className="grid-2">
        {DATE_FIELDS.map((k) => (
          <Field
            key={k}
            label={DATE_LABELS[k]}
            type="datetime-local"
            required
            value={form[k]}
            disabled={datesLocked && LOCKED_DATES.includes(k)}
            onChange={(e) => set(k, e.target.value)}
            hint={notes[k]}
            error={errors[k] ?? server[k]}
          />
        ))}
      </div>

      <SalesRulesEditor
        state={form.rules}
        settings={props.settings}
        errors={{ ...ruleServerErrors, ...errors.rules }}
        onChange={(key, field) => setForm((f) => ({ ...f, rules: { ...f.rules, [key]: field } }))}
      />

      {props.error && Object.keys(server).length === 0 ? (
        <p className="alert alert--error" role="alert">
          {errorMessage(props.error)}
        </p>
      ) : null}
      {Object.keys(errors).length ? (
        <p className="alert alert--error" role="alert">
          Certaines informations sont à corriger.
        </p>
      ) : null}
      <button type="submit" className="btn" disabled={props.pending}>
        {props.pending ? 'Enregistrement…' : props.submitLabel}
      </button>

      <ConfirmDialog
        open={pendingPatch !== null}
        title="Reporter l’événement ?"
        confirmLabel="Confirmer le report"
        danger
        busy={props.pending}
        confirmDisabled={reason.trim().length < 1 || reason.length > 500}
        onConfirm={confirmReschedule}
        onCancel={() => setPendingPatch(null)}
      >
        <p>
          Des places ont déjà été vendues. <strong>Tous les acheteurs seront prévenus par email</strong> et pourront se faire <strong>rembourser intégralement</strong>
          (frais compris) depuis leur compte.
        </p>
        <div className="field">
          <label htmlFor="ev-reschedule-reason">Motif du report (communiqué aux acheteurs)</label>
          <textarea id="ev-reschedule-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </ConfirmDialog>
    </form>
  );
}
