import { useState, type SubmitEvent } from 'react';
import { useParams } from 'react-router';
import { errorMessage, isApiError } from '../../api/errors';
import { useMemberMutations, useMembers } from '../../api/hooks/org';
import type { Member, OrgRole } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { membershipFor, ROLE_LABELS } from '../../auth/roles';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Field } from '../../components/Field';
import { PageLoader } from '../../components/PageLoader';
import { lookup } from '../../lib/lookup';

const ROLES: OrgRole[] = ['OWNER', 'MANAGER', 'SCANNER'];

function memberError(error: unknown, context: 'add' | 'change'): string {
  if (isApiError(error) && error.code === 'NOT_FOUND' && context === 'add') return 'Aucun compte confirmé n’utilise cette adresse : la personne doit d’abord créer son compte.';
  if (isApiError(error) && error.code === 'CONFLICT') return context === 'add' ? 'Cette personne est déjà membre du collectif.' : 'Le collectif doit garder au moins un propriétaire.';
  return errorMessage(error);
}

export function MembersPage() {
  const { orgId = '' } = useParams();
  const { user } = useAuth();
  const owner = membershipFor(user, orgId)?.role === 'OWNER';
  const { data, error, isPending } = useMembers(orgId);
  const m = useMemberMutations(orgId);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('SCANNER');
  const [removing, setRemoving] = useState<Member | null>(null);

  const add = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!email.trim() || m.add.isPending) return;
    m.add.mutate({ email: email.trim(), role }, { onSuccess: () => setEmail('') });
  };

  if (isPending) return <PageLoader />;
  return (
    <section className="page">
      <h1>Membres</h1>
      <ErrorAlert error={error} />
      {!owner ? <p className="alert alert--info">Lecture seule : seuls les propriétaires gèrent les membres.</p> : null}
      <ul className="list-reset stack">
        {data?.items.map((mb) => (
          <li key={mb.userId} className="card stack">
            <p className="m-0">
              <strong>{mb.displayName}</strong> <span className="muted">{mb.email}</span>
            </p>
            {owner ? (
              <div className="row">
                <div className="field m-0">
                  <label htmlFor={`role-${mb.userId}`}>Rôle</label>
                  <select id={`role-${mb.userId}`} value={mb.role} disabled={m.setRole.isPending} onChange={(e) => m.setRole.mutate({ userId: mb.userId, role: e.target.value as OrgRole })}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                </div>
                <button type="button" className="btn btn--secondary btn--small" onClick={() => setRemoving(mb)}>
                  Retirer
                </button>
              </div>
            ) : (
              <p className="m-0">{lookup(ROLE_LABELS, mb.role) ?? 'Rôle inconnu'}</p>
            )}
          </li>
        ))}
      </ul>
      {m.setRole.error ? (
        <p className="alert alert--error" role="alert">
          {memberError(m.setRole.error, 'change')}
        </p>
      ) : null}
      {owner ? (
        <form className="card stack" onSubmit={add} noValidate>
          <h2 className="m-0">Ajouter un membre</h2>
          <Field label="Adresse email du compte" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <div className="field">
            <label htmlFor="new-role">Rôle</label>
            <select id="new-role" value={role} onChange={(e) => setRole(e.target.value as OrgRole)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn" disabled={m.add.isPending || !email.trim()}>
            Ajouter
          </button>
          {m.add.error ? (
            <p className="alert alert--error" role="alert">
              {memberError(m.add.error, 'add')}
            </p>
          ) : null}
          {m.add.isSuccess ? (
            <p className="alert alert--success" role="status">
              Membre ajouté : la personne est prévenue par email.
            </p>
          ) : null}
        </form>
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title="Retirer ce membre ?"
        confirmLabel="Retirer"
        danger
        busy={m.remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) m.remove.mutate(removing.userId, { onSettled: () => setRemoving(null) });
        }}
      >
        <p>{removing?.displayName} n’aura plus accès au collectif.</p>
      </ConfirmDialog>
      {m.remove.error ? (
        <p className="alert alert--error" role="alert">
          {memberError(m.remove.error, 'change')}
        </p>
      ) : null}
    </section>
  );
}
