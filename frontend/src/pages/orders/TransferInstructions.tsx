import type { Order, TransferInstructions as TI } from '../../api/types';
import { CopyButton } from '../../components/CopyButton';
import { Icon } from '../../components/Icon';
import { formatCents } from '../../lib/money';
import { formatLongDate, formatTime } from '../../lib/time';

const groupIban = (iban: string) => iban.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();

/**
 * Paiement par virement (HANDOFF § 6.1.3) : ton rassurant, AUCUN compte à rebours — l'échéance est une
 * date. Une seule liste de valeurs à copier, la référence mise en avant.
 */
export function TransferInstructions({ order, t }: { order: Order; t: TI }) {
  const rows: { label: string; value: string; copy: string; copyLabel: string; mono?: boolean; highlight?: boolean; help?: string }[] = [
    { label: 'Montant exact', value: formatCents(t.amountCents), copy: (t.amountCents / 100).toFixed(2).replace('.', ','), copyLabel: 'le montant' },
    { label: 'Référence', value: t.reference, copy: t.reference, copyLabel: 'la référence', mono: true, highlight: true, help: 'Elle nous permet de reconnaître votre virement.' },
    { label: 'Bénéficiaire', value: t.beneficiary, copy: t.beneficiary, copyLabel: 'le bénéficiaire' },
    { label: 'IBAN', value: groupIban(t.iban), copy: t.iban.replace(/\s+/g, ''), copyLabel: 'l’IBAN', mono: true },
    { label: 'BIC', value: t.bic, copy: t.bic, copyLabel: 'le BIC', mono: true },
  ];
  return (
    <section className="stack" aria-labelledby="titre-virement">
      <h2 id="titre-virement" className="visually-hidden">
        Instructions de virement
      </h2>
      <dl className="copy-list">
        {rows.map((r) => (
          <div key={r.label} className={`copy-row${r.highlight ? ' copy-row--highlight' : ''}`}>
            <div className="copy-row__body">
              <dt>{r.label}</dt>
              <dd className={r.mono ? 'mono' : undefined}>{r.value}</dd>
              {r.help ? <dd className="field__hint">{r.help}</dd> : null}
            </div>
            <CopyButton value={r.copy} label={r.copyLabel} />
          </div>
        ))}
      </dl>
      <p className="notice">
        <Icon name="calendar" />
        <span>
          Vos places vous attendent jusqu’au <strong>{formatLongDate(t.deadline, order.eventTimezone)}</strong> ({formatTime(t.deadline, order.eventTimezone)}). Si le virement n’est pas fait d’ici là, la
          réservation s’annule simplement, sans aucun frais.
        </span>
      </p>
      <section className="stack stack--sm" aria-labelledby="titre-ensuite">
        <h2 id="titre-ensuite">Et ensuite ?</h2>
        <ol className="stack stack--sm">
          <li>Faites le virement depuis votre banque, avec la référence ci-dessus dans le libellé.</li>
          <li>Dès que le virement arrive (souvent quelques jours), le collectif le valide.</li>
          <li>Vos billets vous sont envoyés par e-mail et apparaissent dans « Mes billets ».</li>
        </ol>
      </section>
    </section>
  );
}
