import { useState, type SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { dropSession } from '../../api/client';
import { useResetPassword } from '../../api/hooks/account';
import { errorMessage, fieldErrors, isApiError } from '../../api/errors';
import { useAuth } from '../../auth/AuthContext';
import { Field } from '../../components/Field';
import { passwordProblem } from './passwordRules';
import { useUrlToken } from './useUrlToken';

export function ResetPasswordPage() {
  const token = useUrlToken();
  const navigate = useNavigate();
  const { status } = useAuth();
  const reset = useResetPassword();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const problem = passwordProblem(password, confirm);
  const server = fieldErrors(reset.error);

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setTouched(true);
    if (!token || problem || reset.isPending) return;
    reset.mutate(
      { token, password },
      {
        onSuccess: () => {
          if (status === 'authenticated') dropSession('logout'); // toutes les sessions sont révoquées
          void navigate('/login?info=reset', { replace: true });
        },
      },
    );
  };

  const invalidLink = !token || (isApiError(reset.error) && reset.error.code === 'VALIDATION_ERROR' && 'token' in server);

  return (
    <section className="page narrow">
      <h1>Nouveau mot de passe</h1>
      {invalidLink ? (
        <p className="alert alert--error" role="alert">
          Ce lien est invalide ou a expiré. <Link to="/forgot-password">Demander un nouveau lien</Link>
        </p>
      ) : (
        <form className="stack" onSubmit={submit} noValidate>
          <Field label="Nouveau mot de passe" type="password" autoComplete="new-password" required hint="12 caractères minimum." value={password} onChange={(e) => setPassword(e.target.value)} error={server.password} />
          <Field label="Confirmer" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} error={touched ? problem : undefined} />
          <button type="submit" className="btn btn--block" disabled={reset.isPending}>
            {reset.isPending ? 'Enregistrement…' : 'Enregistrer'}
          </button>
          {reset.error && Object.keys(server).length === 0 ? (
            <p className="alert alert--error" role="alert">
              {errorMessage(reset.error)}
            </p>
          ) : null}
        </form>
      )}
    </section>
  );
}
