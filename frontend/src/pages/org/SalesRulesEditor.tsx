import type { OrgSettings } from '../../api/types';
import { formatRule, orgValue, parseRule, RULE_DEFS, type RuleKey, type RulesState } from './salesRules';

/**
 * « Règles de vente » d'un événement : pour chaque paramètre, réglage du collectif (valeur affichée)
 * ou valeur personnalisée, avec la valeur effective.
 */
export function SalesRulesEditor(props: {
  state: RulesState;
  settings: OrgSettings | undefined;
  errors: Partial<Record<RuleKey, string>>;
  onChange: (key: RuleKey, field: RulesState[RuleKey]) => void;
  /** Règles en lecture seule (règles financières pour un MANAGER). */
  locked?: ReadonlySet<RuleKey>;
}) {
  const { state, settings, errors, onChange, locked } = props;
  return (
    <fieldset className="stack card">
      <legend>Règles de vente</legend>
      {!settings ? <p className="muted">Chargement des réglages du collectif…</p> : null}
      {RULE_DEFS.map((def) => {
        const f = state[def.key];
        const inherited = settings ? orgValue(settings, def.key) : undefined;
        const parsed = f.mode === 'custom' ? parseRule(def, f.text) : null;
        const effective = f.mode === 'inherit' ? inherited : parsed?.ok ? parsed.value : undefined;
        const name = `regle-${def.key}`;
        const inputId = `${name}-valeur`;
        const errorId = `${name}-erreur`;
        if (locked?.has(def.key)) {
          return (
            <div key={def.key} className="rule" role="group" aria-labelledby={`${name}-titre`}>
              <p id={`${name}-titre`} className="rule__title">
                {def.label}
              </p>
              <p className="rule__effective">
                {f.mode === 'inherit' ? 'Réglage du collectif' : 'Personnalisé'} : <strong>{effective !== undefined ? formatRule(def, effective) : '—'}</strong>
              </p>
              <p className="muted rule__effective">Réservé au propriétaire du collectif (règle financière).</p>
            </div>
          );
        }
        return (
          <div key={def.key} className="rule" role="group" aria-labelledby={`${name}-titre`}>
            <p id={`${name}-titre`} className="rule__title">
              {def.label}
            </p>
            <div className="row">
              <label className="row">
                <input type="radio" name={name} checked={f.mode === 'inherit'} onChange={() => onChange(def.key, { ...f, mode: 'inherit' })} />
                Réglage du collectif{inherited !== undefined ? ` (${formatRule(def, inherited)})` : ''}
              </label>
              <label className="row">
                <input type="radio" name={name} checked={f.mode === 'custom'} onChange={() => onChange(def.key, { ...f, mode: 'custom' })} />
                Personnalisé
              </label>
            </div>
            {f.mode === 'custom' ? (
              def.kind === 'bool' ? (
                <label className="row">
                  <input type="checkbox" checked={f.text === 'true'} onChange={(e) => onChange(def.key, { ...f, text: e.target.checked ? 'true' : 'false' })} />
                  Activé
                </label>
              ) : (
                <div className="field">
                  <label htmlFor={inputId}>
                    Valeur{def.unit ? ` (${def.unit})` : ''}
                  </label>
                  <input
                    id={inputId}
                    inputMode="decimal"
                    value={f.text}
                    aria-invalid={errors[def.key] ? true : undefined}
                    aria-describedby={errors[def.key] ? errorId : undefined}
                    onChange={(e) => onChange(def.key, { ...f, text: e.target.value })}
                  />
                  {def.hint ? <span className="field__hint">{def.hint}</span> : null}
                </div>
              )
            ) : null}
            {errors[def.key] ? (
              <span id={errorId} className="field__error">
                {errors[def.key]}
              </span>
            ) : null}
            <p className="muted rule__effective">Valeur appliquée : {effective !== undefined ? formatRule(def, effective) : '—'}</p>
          </div>
        );
      })}
    </fieldset>
  );
}
