import { useMemo, useState, type SubmitEvent } from 'react';
import { errorMessage, fieldErrors, isApiError } from '../../api/errors';
import type { EventAdmin, EventCreateBody, EventPatchBody, OrgRole, OrgSettings } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Field } from '../../components/Field';
import { listTimeZones, timeZoneLabel } from '../../lib/time';
import { buildEventBody, convertDatesToTimezone, DATE_FIELDS, diffPatch, hasSales, initialEventForm, isReschedule, type DateField, type EventFormState, type FormErrors } from './eventForm';
import { SalesRulesEditor } from './SalesRulesEditor';
import { FINANCIAL_RULES } from './salesRules';

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
} & (
  | { event: null; onCreate: (body: EventCreateBody) => void }
  | {
      event: EventAdmin;
      /** Rejette avec l'ApiError en cas d'échec (permet d'ouvrir le dialogue de report si le serveur l'exige). */
      onUpdate: (patch: EventPatchBody) => Promise<unknown>;
      /** Recharge l'événement juste avant de décider s'il s'agit d'un report (ventes à jour). */
      refreshEvent: () => Promise<EventAdmin | undefined>;
    }
);
type TzChoice = { from: string; localDates: Pick<EventFormState, DateField>; mode: 'instant' | 'local' };

const LOCKED_DATES: readonly DateField[] = ['startsAt', 'endsAt'];

export function EventEditor(props: Props) {
  const [initial, setInitial] = useState<EventFormState>(() => initialEventForm(props.event, props.settings));
  const [form, setForm] = useState<EventFormState>(initial);
  // Version de l'événement à l'ouverture (audit B17-b) : une version plus récente (autre onglet, autre
  // membre, types de places) ne remonte plus l'éditeur en silence.
  const [openedVersion, setOpenedVersion] = useState(props.event?.updatedAt ?? null);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const reloadFromServer = (event: EventAdmin) => {
    const fresh = initialEventForm(event, props.settings);
    setInitial(fresh);
    setForm(fresh);
    setOpenedVersion(event.updatedAt);
    setTzChoice(null);
  };
  const current = props.event;
  const changedElsewhere = current !== null && openedVersion !== null && current.updatedAt !== openedVersion;
  // Garde de réentrance (audit B17-c) : un seul envoi à la fois, y compris pendant la revérification des ventes.
  const [submitting, setSubmitting] = useState(false);
  const [pendingPatch, setPendingPatch] = useState<EventPatchBody | null>(null);
  const [reason, setReason] = useState('');
  const [tzChoice, setTzChoice] = useState<TzChoice | null>(null);
  const [forbidden, setForbidden] = useState(false);
  if (changedElsewhere && !dirty) reloadFromServer(current); // rien à perdre : version à jour
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
    if (submitting) return;
    const patch = diffPatch(props.event, initial, form, r.body);
    setSubmitting(true);
    void decideAndSend(patch).finally(() => {
      setSubmitting(false);
    });
  };

  const send = async (patch: EventPatchBody) => {
    if (props.event === null) return;
    setForbidden(false);
    try {
      await props.onUpdate(patch);
    } catch (e) {
      // Le serveur exige un motif (ventes apparues entre-temps) : on ouvre le dialogue de report.
      if (isApiError(e) && e.code === 'VALIDATION_ERROR' && 'rescheduleReason' in fieldErrors(e)) setPendingPatch(patch);
      if (isApiError(e) && e.code === 'FORBIDDEN') setForbidden(true);
    }
  };

  const decideAndSend = async (patch: EventPatchBody) => {
    if (props.event === null) return;
    // Ventes revérifiées à l'instant de la décision (pas un cache de quelques secondes).
    const fresh = (await props.refreshEvent().catch(() => undefined)) ?? props.event;
    if (isReschedule(fresh, patch)) {
      setPendingPatch(patch); // confirmation forte + motif obligatoire
      return;
    }
    await send(patch);
  };

  const changeTimezone = (tz: string) => {
    if (props.event === null) {
      set('timezone', tz);
      return;
    }
    const from = tzChoice?.from ?? form.timezone;
    const localDates = tzChoice?.localDates ?? { startsAt: form.startsAt, endsAt: form.endsAt, salesStartAt: form.salesStartAt, salesEndAt: form.salesEndAt };
    if (tz === from) {
      setTzChoice(null);
      setForm((f) => ({ ...f, timezone: tz, ...localDates }));
      return;
    }
    const mode = tzChoice?.mode ?? 'instant';
    setTzChoice({ from, localDates, mode });
    setForm((f) => ({ ...f, timezone: tz, ...(mode === 'instant' ? convertDatesToTimezone({ ...f, ...localDates }, from, tz) : localDates) }));
  };

  const chooseTzMode = (mode: 'instant' | 'local') => {
    if (!tzChoice) return;
    setTzChoice({ ...tzChoice, mode });
    setForm((f) => ({ ...f, ...(mode === 'instant' ? convertDatesToTimezone({ ...f, ...tzChoice.localDates }, tzChoice.from, f.timezone) : tzChoice.localDates) }));
  };

  const confirmReschedule = () => {
    if (!pendingPatch || props.event === null || reason.trim().length < 1 || reason.length > 500) return;
    void send({ ...pendingPatch, rescheduleReason: reason.trim() });
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
        <select id="ev-timezone" value={form.timezone} disabled={datesLocked} onChange={(e) => changeTimezone(e.target.value)}>
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
        <span className="field__hint">Les dates ci-dessous sont saisies en {timeZoneLabel(form.timezone)}.</span>
        {errors.timezone ?? server.timezone ? <span className="field__error">{errors.timezone ?? server.timezone}</span> : null}
      </div>
      {tzChoice ? (
        <fieldset className="card stack">
          <legend>Changement de fuseau horaire</legend>
          <label className="row">
            <input type="radio" name="tz-mode" checked={tzChoice.mode === 'instant'} onChange={() => chooseTzMode('instant')} />
            Conserver l’instant : l’événement ne bouge pas, seules les heures affichées sont converties
          </label>
          <label className="row">
            <input type="radio" name="tz-mode" checked={tzChoice.mode === 'local'} onChange={() => chooseTzMode('local')} />
            Conserver les heures saisies : l’événement est DÉPLACÉ dans le temps (report si des places sont vendues)
          </label>
        </fieldset>
      ) : null}
      {forbidden ? (
        <p className="alert alert--error" role="alert">
          Seul le propriétaire du collectif peut reporter un événement qui a des ventes.
        </p>
      ) : null}
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

      {props.role !== 'OWNER' ? (
        <p className="alert alert--info">
          Les règles financières (remboursement, frais, virement, annulation par l’acheteur) sont réservées au propriétaire du collectif.
        </p>
      ) : null}
      <SalesRulesEditor
        state={form.rules}
        settings={props.settings}
        locked={props.role === 'OWNER' ? undefined : FINANCIAL_RULES}
        errors={{ ...ruleServerErrors, ...errors.rules }}
        onChange={(key, field) => setForm((f) => ({ ...f, rules: { ...f.rules, [key]: field } }))}
      />

      {props.error && Object.keys(server).length === 0 ? (
        <p className="alert alert--error" role="alert">
          {isApiError(props.error) && props.error.code === 'FORBIDDEN'
            ? 'Seul le propriétaire du collectif peut modifier les règles financières ou reporter l’événement. Vos autres modifications n’ont pas été enregistrées.'
            : errorMessage(props.error)}
        </p>
      ) : null}
      {Object.keys(errors).length ? (
        <p className="alert alert--error" role="alert">
          Certaines informations sont à corriger.
        </p>
      ) : null}
      {changedElsewhere && dirty ? (
        <div className="alert alert--warning" role="alert">
          <div className="stack stack--sm">
            <p>
              <strong>Cet événement a été modifié entre-temps</strong> (par une autre personne ou dans un autre onglet). Vos modifications non enregistrées sont conservées ;
              en enregistrant, seuls les champs que vous avez changés seront envoyés.
            </p>
            <p>
              <button type="button" className="btn btn--secondary btn--small" onClick={() => reloadFromServer(current)}>
                Abandonner mes modifications et recharger
              </button>
            </p>
          </div>
        </div>
      ) : null}
      <button type="submit" className="btn" disabled={props.pending || submitting}>
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
