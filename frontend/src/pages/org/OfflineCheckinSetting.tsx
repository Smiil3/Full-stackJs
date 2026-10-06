import { useState } from 'react';
import { errorMessage } from '../../api/errors';
import { useEventMutations } from '../../api/hooks/org';
import type { EventAdmin } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';

/**
 * Mode secours hors-ligne du contrôle d'accès (contrat v1.13) : désactivé par défaut, modifiable par
 * l'OWNER seul (lecture pour le MANAGER), avec avertissement et confirmation à l'activation.
 */
export function OfflineCheckinSetting({ orgId, event, canEdit }: { orgId: string; event: EventAdmin; canEdit: boolean }) {
  const m = useEventMutations(orgId, event.id);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const set = (value: boolean) => {
    m.update.mutate({ offlineCheckinEnabled: value }, { onSettled: () => setConfirmOpen(false) });
  };
  return (
    <section className="card stack" aria-labelledby="titre-secours">
      <h2 id="titre-secours" className="m-0">
        Contrôle d’accès
      </h2>
      <p className="m-0">
        Par défaut, chaque billet est vérifié <strong>en ligne</strong> : sans réponse du serveur, personne n’entre.
      </p>
      <p className="alert alert--warning m-0">
        Le <strong>mode secours hors-ligne</strong> permet de valider les billets sans réseau à partir d’une liste téléchargée, au risque d’une double entrée si plusieurs
        appareils contrôlent en même temps (un seul appareil par porte).
      </p>
      {canEdit ? (
        <label className="row">
          <input
            type="checkbox"
            checked={event.offlineCheckinEnabled}
            disabled={m.update.isPending}
            onChange={(e) => (e.target.checked ? setConfirmOpen(true) : set(false))}
          />
          Mode secours hors-ligne du contrôle d’accès
        </label>
      ) : (
        <p className="m-0">
          Mode secours hors-ligne : <strong>{event.offlineCheckinEnabled ? 'activé' : 'désactivé'}</strong> (modifiable par un propriétaire du collectif)
        </p>
      )}
      {m.update.error ? (
        <p className="alert alert--error" role="alert">
          {errorMessage(m.update.error)}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmOpen}
        title="Activer le mode secours hors-ligne ?"
        confirmLabel="Activer le mode secours"
        danger
        busy={m.update.isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => set(true)}
      >
        <p>Les contrôleurs pourront valider des billets sans réseau. Si plusieurs appareils contrôlent hors-ligne en même temps, un même billet pourra entrer deux fois.</p>
        <p>Recommandation : un seul appareil par porte, et une synchronisation dès que le réseau revient.</p>
      </ConfirmDialog>
    </section>
  );
}
