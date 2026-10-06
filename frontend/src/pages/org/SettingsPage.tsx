import { useMemo, useState, type SubmitEvent } from 'react';
import { useParams } from 'react-router';
import { errorMessage, fieldErrors, isApiError } from '../../api/errors';
import { useOrgSettings, useUpdateOrgSettings } from '../../api/hooks/org';
import type { OrgSettings, OrgSettingsPatch } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { membershipFor } from '../../auth/roles';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Field } from '../../components/Field';
import { PageLoader } from '../../components/PageLoader';
import { bicProblem, ibanProblem, normalizeIban } from '../../lib/iban';
import { listTimeZones } from '../../lib/time';
import { formatRule, parseRule, RULE_DEFS, toInput, type RuleKey } from './salesRules';

function ReadOnlySettings({ s }: { s: OrgSettings }) {
  return (
    <dl className="kv card">
      {RULE_DEFS.map((d) => (
        <div key={d.key} className="kv__row">
          <dt>{d.label}</dt>
          <dd>{formatRule(d, s[d.key])}</dd>
        </div>
      ))}
      <dt>Frais de service remboursés à l’annulation</dt>
      <dd>{s.serviceFeeRefundable ? 'oui' : 'non'}</dd>
      <dt>Fuseau horaire par défaut</dt>
      <dd>{s.defaultTimezone}</dd>
      <dt>Email de contact</dt>
      <dd>{s.contactEmail ?? '—'}</dd>
    </dl>
  );
}

function BankInfo({ s }: { s: OrgSettings }) {
  return (
    <dl className="kv card">
      <dt>Titulaire</dt>
      <dd>{s.bank.beneficiary ?? '—'}</dd>
      <dt>IBAN</dt>
      <dd className="mono">{s.bank.ibanMasked ?? 'non renseigné'}</dd>
      <dt>BIC</dt>
      <dd className="mono">{s.bank.bic ?? '—'}</dd>
    </dl>
  );
}

function SettingsForm({ orgId, s }: { orgId: string; s: OrgSettings }) {
  const update = useUpdateOrgSettings(orgId);
  const initial = useMemo(() => Object.fromEntries(RULE_DEFS.map((d) => [d.key, toInput(d, s[d.key])])) as Record<RuleKey, string>, [s]);
  const [values, setValues] = useState(initial);
  const [refundable, setRefundable] = useState(s.serviceFeeRefundable);
  const [tz, setTz] = useState(s.defaultTimezone);
  const [contact, setContact] = useState(s.contactEmail ?? '');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const zones = useMemo(() => listTimeZones(), []);
  const server = fieldErrors(update.error);

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const patch: OrgSettingsPatch = {};
    for (const d of RULE_DEFS) {
      const r = parseRule(d, values[d.key]);
      if (!r.ok) errs[d.key] = r.error;
      else if (r.value !== s[d.key]) Object.assign(patch, { [d.key]: r.value });
    }
    const perOrder = patch.maxPerOrder ?? s.maxPerOrder;
    const perUser = patch.maxPerUser ?? s.maxPerUser;
    if (!errs.maxPerUser && !errs.maxPerOrder && perUser < perOrder) errs.maxPerUser = `Doit être au moins égal au maximum par commande (${perOrder}).`;
    if (contact.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.trim())) errs.contactEmail = 'Adresse email invalide.';
    if (refundable !== s.serviceFeeRefundable) patch.serviceFeeRefundable = refundable;
    if (tz !== s.defaultTimezone) patch.defaultTimezone = tz;
    if ((contact.trim() || null) !== s.contactEmail) patch.contactEmail = contact.trim() || null;
    setErrors(errs);
    if (Object.keys(errs).length === 0 && Object.keys(patch).length > 0 && !update.isPending) update.mutate(patch);
  };

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <fieldset className="stack card">
        <legend>Règles de vente par défaut</legend>
        <p className="muted">Appliquées à tous les événements, sauf réglage personnalisé dans un événement. Les commandes déjà passées ne changent pas.</p>
        {RULE_DEFS.map((d) =>
          d.kind === 'bool' ? (
            <label key={d.key} className="row">
              <input type="checkbox" checked={values[d.key] === 'true'} onChange={(e) => setValues((v) => ({ ...v, [d.key]: e.target.checked ? 'true' : 'false' }))} />
              {d.label}
            </label>
          ) : (
            <Field
              key={d.key}
              label={`${d.label}${d.unit ? ` (${d.unit})` : ''}`}
              inputMode="decimal"
              hint={d.hint ?? `Entre ${formatRule(d, d.min)} et ${formatRule(d, d.max)}`}
              value={values[d.key]}
              onChange={(e) => setValues((v) => ({ ...v, [d.key]: e.target.value }))}
              error={errors[d.key] ?? server[d.key]}
            />
          ),
        )}
        <label className="row">
          <input type="checkbox" checked={refundable} onChange={(e) => setRefundable(e.target.checked)} />
          Rembourser aussi les frais de service lors d’une annulation
        </label>
      </fieldset>
      <div className="field">
        <label htmlFor="org-tz">Fuseau horaire par défaut des événements</label>
        <select id="org-tz" value={tz} onChange={(e) => setTz(e.target.value)}>
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </div>
      <Field label="Email de contact affiché aux acheteurs" type="email" value={contact} onChange={(e) => setContact(e.target.value)} error={errors.contactEmail ?? server.contactEmail} />
      {update.error && Object.keys(server).length === 0 ? (
        <p className="alert alert--error" role="alert">
          {errorMessage(update.error)}
        </p>
      ) : null}
      {update.isSuccess ? (
        <p className="alert alert--success" role="status">
          Réglages enregistrés.
        </p>
      ) : null}
      <button type="submit" className="btn" disabled={update.isPending}>
        {update.isPending ? 'Enregistrement…' : 'Enregistrer les réglages'}
      </button>
    </form>
  );
}

/** Coordonnées bancaires : ressaisie COMPLÈTE + mot de passe actuel (contrat v1.7). L'IBAN n'est jamais pré-rempli. */
function BankForm({ orgId, onDone }: { orgId: string; onDone: () => void }) {
  const update = useUpdateOrgSettings(orgId, { sensitive: true });
  // L'erreur est conservée à part : la mutation est réinitialisée aussitôt (IBAN + mot de passe effacés du cache).
  const [lastError, setLastError] = useState<unknown>(null);
  const [beneficiary, setBeneficiary] = useState('');
  const [iban, setIban] = useState('');
  const [bic, setBic] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Partial<Record<'beneficiary' | 'iban' | 'bic' | 'password', string>>>({});
  const server = fieldErrors(lastError);
  const wrongPassword = isApiError(lastError) && lastError.code === 'INVALID_CREDENTIALS';

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLastError(null);
    const errs = {
      beneficiary: beneficiary.trim().length < 1 || beneficiary.length > 140 ? 'Titulaire requis.' : undefined,
      iban: ibanProblem(iban),
      bic: bicProblem(bic),
      password: password ? undefined : 'Saisissez votre mot de passe pour confirmer.',
    };
    setErrors(errs);
    if (Object.values(errs).some(Boolean) || update.isPending) return;
    update.mutate(
      { bank: { beneficiary: beneficiary.trim(), iban: normalizeIban(iban), bic: bic.trim().toUpperCase() }, currentPassword: password },
      {
        onSuccess: () => {
          onDone();
        },
        onError: (err) => {
          setLastError(err);
          setIban(''); // à ressaisir : rien de sensible ne reste en mémoire plus que nécessaire
        },
        onSettled: () => {
          setPassword('');
          update.reset();
        },
      },
    );
  };

  return (
    <form className="card stack" onSubmit={submit} noValidate autoComplete="off">
      <p className="muted">Ressaisissez l’ensemble des coordonnées. Tous les propriétaires du collectif seront prévenus par email de ce changement.</p>
      <Field label="Titulaire du compte" value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} error={errors.beneficiary ?? server['bank.beneficiary']} />
      <Field label="IBAN complet" className="mono" autoComplete="off" spellCheck={false} value={iban} onChange={(e) => setIban(e.target.value)} error={errors.iban ?? server['bank.iban']} />
      <Field label="BIC" className="mono" autoComplete="off" spellCheck={false} value={bic} onChange={(e) => setBic(e.target.value)} error={errors.bic ?? server['bank.bic']} />
      <Field
        label="Votre mot de passe (confirmation)"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={errors.password ?? (wrongPassword ? 'Mot de passe incorrect.' : server.currentPassword)}
      />
      {lastError && !wrongPassword && Object.keys(server).length === 0 ? (
        <p className="alert alert--error" role="alert">
          {errorMessage(lastError)}
        </p>
      ) : null}
      <div className="row">
        <button type="submit" className="btn" disabled={update.isPending}>
          {update.isPending ? 'Enregistrement…' : 'Enregistrer les coordonnées'}
        </button>
        <button type="button" className="btn btn--secondary" onClick={onDone}>
          Annuler
        </button>
      </div>
    </form>
  );
}

export function SettingsPage() {
  const { orgId = '' } = useParams();
  const { user } = useAuth();
  const owner = membershipFor(user, orgId)?.role === 'OWNER';
  const { data, error, isPending } = useOrgSettings(orgId);
  const [editingBank, setEditingBank] = useState(false);
  if (isPending) return <PageLoader />;
  if (!data) return <ErrorAlert error={error} />;
  return (
    <section className="page">
      <h1>Réglages du collectif</h1>
      {owner ? (
        <SettingsForm key={orgId} orgId={orgId} s={data} />
      ) : (
        <>
          <p className="alert alert--info">Lecture seule : seuls les propriétaires du collectif peuvent modifier ces réglages.</p>
          <ReadOnlySettings s={data} />
        </>
      )}
      <h2>Coordonnées bancaires (virements)</h2>
      <BankInfo s={data} />
      {owner ? (
        editingBank ? (
          <BankForm orgId={orgId} onDone={() => setEditingBank(false)} />
        ) : (
          <button type="button" className="btn btn--secondary" onClick={() => setEditingBank(true)}>
            Modifier les coordonnées bancaires
          </button>
        )
      ) : null}
    </section>
  );
}
