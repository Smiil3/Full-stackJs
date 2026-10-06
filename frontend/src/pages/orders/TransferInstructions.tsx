import type { Order, TransferInstructions as TI } from '../../api/types';
import { CopyButton } from '../../components/CopyButton';
import { Countdown } from '../../components/Countdown';
import { EventTime } from '../../components/EventTime';
import { formatCents } from '../../lib/money';

const groupIban = (iban: string) => iban.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();

export function TransferInstructions({ order, t }: { order: Order; t: TI }) {
  return (
    <section className="card stack" aria-labelledby="titre-virement">
      <h2 id="titre-virement" className="card__title">
        Instructions de virement
      </h2>
      <p>
        Effectuez un virement du <strong>montant exact</strong> en recopiant la <strong>référence</strong> dans le libellé : c’est elle qui permet d’identifier votre commande.
      </p>
      <dl className="kv">
        <dt>Bénéficiaire</dt>
        <dd>{t.beneficiary}</dd>
        <dt>IBAN</dt>
        <dd className="row">
          <span className="mono">{groupIban(t.iban)}</span>
          <CopyButton value={t.iban.replace(/\s+/g, '')} label="l’IBAN" />
        </dd>
        <dt>BIC</dt>
        <dd className="mono">{t.bic}</dd>
        <dt>Référence</dt>
        <dd className="row">
          <strong className="mono reference">{t.reference}</strong>
          <CopyButton value={t.reference} label="la référence" />
        </dd>
        <dt>Montant</dt>
        <dd>
          <strong>{formatCents(t.amountCents)}</strong>
        </dd>
        <dt>Date limite</dt>
        <dd>
          <EventTime iso={t.deadline} timezone={order.eventTimezone} />
        </dd>
      </dl>
      <Countdown until={t.deadline} label="Temps restant pour effectuer le virement" />
      <p className="muted">Passé ce délai, la réservation est annulée et les places sont remises en vente. Vos billets vous sont envoyés dès réception du virement.</p>
    </section>
  );
}
