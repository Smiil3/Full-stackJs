import { Icon } from './Icon';

/** Sélecteur de quantité − n + : boutons étiquetés, valeur annoncée (<output aria-live>). */
export function QuantityStepper({ name, value, max, onChange }: { name: string; value: number; max: number; onChange: (value: number) => void }) {
  return (
    <div className="stepper" role="group" aria-label={`Nombre de places « ${name} »`}>
      <button type="button" className="stepper__btn" aria-label={`Retirer une place ${name}`} disabled={value <= 0} onClick={() => onChange(value - 1)}>
        <Icon name="minus" />
      </button>
      <output className="stepper__value" aria-live="polite">
        {value}
      </output>
      <button type="button" className="stepper__btn stepper__btn--plus" aria-label={`Ajouter une place ${name}`} disabled={value >= max} onClick={() => onChange(value + 1)}>
        <Icon name="plus" />
      </button>
    </div>
  );
}
