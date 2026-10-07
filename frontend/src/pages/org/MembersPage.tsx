import { useState, type SubmitEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { errorMessage, isApiError } from '../../api/errors';
import { useMemberMutations, useMembers } from '../../api/hooks/org';
import type { Member, OrgRole } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { membershipFor, ROLE_LABELS, roleAtLeast } from '../../auth/roles';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Field } from '../../components/Field';
import { PageLoader } from '../../components/PageLoader';
import { lookup } from '../../lib/lookup';

const ROLES: OrgRole[] = ['OWNER', 'MANAGER', 'SCANNER'];
/** Ce qu'un propriétaire peut faire (affiché avant toute promotion en OWNER). */
const OWNER_POWERS = [
  'pourra modifier les coordonnées bancaires qui reçoivent les virements.',
  'pourra changer les règles financières (remboursement, frais, annulation) et reporter ou annuler les événements.',
  'pourra ajouter, promouvoir ou retirer des membres, y compris des propriétaires.',
];

function memberError(error: unknown, context: 'add' | 'change'): string {
  if (isApiError(error) && error.code === 'NOT_FOUND' && context === 'add') return 'Aucun compte confirmé n’utilise cette adresse : la personne doit d’abord créer son compte.';
  if (isApiError(error) && error.code === 'CONFLICT') return context === 'add' ? 'Cette personne est déjà membre du collectif.' : 'Le collectif doit garder au moins un propriétaire.';
  return errorMessage(error);
}

export function MembersPage() {
  const { orgId = '' } = useParams();
  const { user, reloadUser } = useAuth();
  const navigate = useNavigate();
  const owner = membershipFor(user, orgId)?.role === 'OWNER';
  const [pendingRole, setPendingRole] = useState<{ member: Member; role: OrgRole } | null>(null);
  const isSelf = (mb: Member) => mb.userId === user?.id;

  /** Action sur son propre compte : adhésions rechargées, retour au sélecteur de collectif. */
  const afterSelfChange = async () => {
    await reloadUser().catch(() => undefined);
    await navigate('/org', { replace: true });
  };

  const requestRole = (mb: Member, role: OrgRole) => {
    if (role === mb.role) return;
    // Rétrogradation, promotion en propriétaire (audit B17-e) ou modification de son propre rôle : confirmation explicite.
    if (!roleAtLeast(role, mb.role) || role === 'OWNER' || isSelf(mb)) setPendingRole({ member: mb, role });
    else m.setRole.mutate({ userId: mb.userId, role });
  };

  const applyRole = () => {
    if (!pendingRole) return;
    const { member, role } = pendingRole;
    m.setRole.mutate(
      { userId: member.userId, role },
      {
        onSuccess: () => {
          if (isSelf(member)) void afterSelfChange();
        },
        onSettled: () => setPendingRole(null),
      },
    );
  };
  const { data, error, isPending } = useMembers(orgId);
  const m = useMemberMutations(orgId);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('SCANNER');
  const [removing, setRemoving] = useState<Member | null>(null);

  const [confirmOwnerAdd, setConfirmOwnerAdd] = useState(false);
  const sendAdd = () => {
    setConfirmOwnerAdd(false);
    m.add.mutate({ email: email.trim(), role }, { onSuccess: () => setEmail('') });
  };
  const add = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!email.trim() || m.add.isPending) return;
    if (role === 'OWNER') setConfirmOwnerAdd(true); // nouveau propriétaire : confirmation explicite
    else sendAdd();
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
                  <select id={`role-${mb.userId}`} value={mb.role} disabled={m.setRole.isPending} onChange={(e) => requestRole(mb, e.target.value as OrgRole)}>
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
        icon="users"
        confirmLabel="Retirer"
        cancelLabel="Garder ce membre"
        danger
        consequences={
          removing && !isSelf(removing)
            ? [
                removing.role === 'SCANNER'
                  ? `${removing.displayName} ne pourra plus contrôler les billets à l’entrée.`
                  : removing.role === 'MANAGER'
                    ? `${removing.displayName} ne pourra plus gérer les événements, les ventes ni les virements.`
                    : `${removing.displayName} ne pourra plus gérer les réglages, les membres ni les coordonnées bancaires.`,
                'Ses actions passées restent dans le journal.',
              ]
            : undefined
        }
        busy={m.remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return;
          const self = isSelf(removing);
          m.remove.mutate(removing.userId, {
            onSuccess: () => {
              if (self) void afterSelfChange();
            },
            onSettled: () => setRemoving(null),
          });
        }}
      >
        {removing && isSelf(removing) ? (
          <p className="alert alert--warning">
            <strong>Attention : il s’agit de VOTRE compte.</strong> Vous perdrez immédiatement l’accès à ce collectif.
          </p>
        ) : (
          <p>{removing?.displayName} n’aura plus accès au collectif.</p>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmOwnerAdd}
        title="Ajouter un propriétaire ?"
        icon="users"
        confirmLabel="Oui, ajouter comme propriétaire"
        cancelLabel="Annuler"
        danger
        busy={m.add.isPending}
        consequences={OWNER_POWERS.map((p) => `${email.trim()} ${p}`)}
        onCancel={() => setConfirmOwnerAdd(false)}
        onConfirm={sendAdd}
      />
      <ConfirmDialog
        open={pendingRole !== null}
        title={pendingRole?.role === 'OWNER' ? 'Nommer propriétaire ?' : 'Modifier ce rôle ?'}
        confirmLabel="Confirmer"
        danger
        consequences={pendingRole?.role === 'OWNER' && !isSelf(pendingRole.member) ? OWNER_POWERS.map((p) => `${pendingRole.member.displayName} ${p}`) : undefined}
        busy={m.setRole.isPending}
        onCancel={() => setPendingRole(null)}
        onConfirm={applyRole}
      >
        {pendingRole && isSelf(pendingRole.member) ? (
          <p className="alert alert--warning">
            <strong>Attention : il s’agit de VOTRE compte.</strong> Vous passerez de « {lookup(ROLE_LABELS, pendingRole.member.role)} » à « {lookup(ROLE_LABELS, pendingRole.role)} » et
            pourrez perdre l’accès à certaines pages.
          </p>
        ) : pendingRole ? (
          <p>
            {pendingRole.member.displayName} passera de « {lookup(ROLE_LABELS, pendingRole.member.role)} » à « {lookup(ROLE_LABELS, pendingRole.role)} ».
          </p>
        ) : null}
      </ConfirmDialog>
      {m.remove.error ? (
        <p className="alert alert--error" role="alert">
          {memberError(m.remove.error, 'change')}
        </p>
      ) : null}
    </section>
  );
}
