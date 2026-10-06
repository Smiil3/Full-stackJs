import { useState, type SubmitEvent } from 'react';
import { useNavigate } from 'react-router';
import { dropSession } from '../../api/client';
import { useChangePassword } from '../../api/hooks/account';
import { errorMessage, fieldErrors, isApiError } from '../../api/errors';
import { useAuth } from '../../auth/AuthContext';
import { ROLE_LABELS } from '../../auth/roles';
import { Field } from '../../components/Field';
import { passwordProblem } from './passwordRules';

export function AccountPage() {
  const { user, setSessionEndRedirect } = useAuth();
  const navigate = useNavigate();
  const change = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const problem = passwordProblem(next, confirm);
  const server = fieldErrors(change.error);
  if (!user) return null;

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setTouched(true);
    if (problem || !current || change.isPending) return;
    // Le serveur révoque toutes les sessions : quelle que soit la requête qui le constate en premier,
    // la fin de session mène à la connexion avec ce message.
    setSessionEndRedirect('/login?info=changed');
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: () => {
          // Contrat : toutes les sessions sont révoquées et le cookie effacé ⇒ fin de session locale.
          dropSession('logout');
          void navigate('/login?info=changed', { replace: true });
        },
        onError: () => {
          setSessionEndRedirect(null);
          setCurrent('');
        },
      },
    );
  };

  return (
    <section className="page narrow">
      <h1>Mon compte</h1>
      <dl className="kv card">
        <dt>Nom</dt>
        <dd>{user.displayName}</dd>
        <dt>Email</dt>
        <dd>{user.email}</dd>
        {user.memberships.map((m) => (
          <div key={m.orgId} className="kv__row">
            <dt>{m.orgName}</dt>
            <dd>{ROLE_LABELS[m.role]}</dd>
          </div>
        ))}
      </dl>
      <h2>Changer de mot de passe</h2>
      <form className="stack" onSubmit={submit} noValidate>
        <Field label="Mot de passe actuel" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} error={server.currentPassword} />
        <Field label="Nouveau mot de passe" type="password" autoComplete="new-password" required hint="12 caractères minimum." value={next} onChange={(e) => setNext(e.target.value)} error={server.newPassword} />
        <Field label="Confirmer le nouveau mot de passe" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} error={touched ? problem : undefined} />
        {change.error && Object.keys(server).length === 0 ? (
          <p className="alert alert--error" role="alert">
            {isApiError(change.error) && change.error.code === 'INVALID_CREDENTIALS' ? 'Mot de passe actuel incorrect.' : errorMessage(change.error)}
          </p>
        ) : null}
        <button type="submit" className="btn" disabled={change.isPending}>
          {change.isPending ? 'Enregistrement…' : 'Changer le mot de passe'}
        </button>
        <p className="muted">Par sécurité, toutes vos sessions (sur tous vos appareils) seront fermées.</p>
      </form>
    </section>
  );
}
