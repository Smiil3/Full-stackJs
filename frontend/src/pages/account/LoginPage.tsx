import { useState, type SubmitEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { useResendVerification } from '../../api/hooks/account';
import { errorMessage, isApiError } from '../../api/errors';
import { useAuth } from '../../auth/AuthContext';
import { safeRedirectPath } from '../../auth/safeRedirect';
import { Field } from '../../components/Field';
import { lookup } from '../../lib/lookup';

const NOTICES: Record<string, string> = {
  verified: 'Votre adresse email est confirmée. Vous pouvez vous connecter.',
  reset: 'Votre mot de passe a été modifié. Connectez-vous avec le nouveau.',
  changed: 'Mot de passe modifié : vos sessions ont été fermées par sécurité. Reconnectez-vous.',
  expired: 'Votre session a expiré. Merci de vous reconnecter.',
};

export function LoginPage() {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeRedirectPath(params.get('next'));
  const notice = lookup(NOTICES, params.get('info'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const resend = useResendVerification();

  // Arrivée depuis une action qui ferme la session (info=…) : pas de redirection automatique.
  if (status === 'authenticated' && !pending && !notice) return <Navigate to={next} replace />;

  const submit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    resend.reset();
    try {
      await login(email.trim(), password);
      await navigate(next, { replace: true });
    } catch (err) {
      setError(err);
      setPassword('');
    } finally {
      setPending(false);
    }
  };

  const notVerified = isApiError(error) && error.code === 'EMAIL_NOT_VERIFIED';

  return (
    <section className="page narrow">
      <h1>Connexion</h1>
      {notice ? (
        <p className="alert alert--success" role="status">
          {notice}
        </p>
      ) : null}
      {notVerified ? (
        <div className="alert alert--warning stack" role="alert">
          <h2 className="alert__title">Vérifiez votre email</h2>
          <p>Votre adresse n’est pas encore confirmée. Ouvrez le lien reçu par email, puis reconnectez-vous.</p>
          <button type="button" className="btn btn--secondary" disabled={resend.isPending || resend.isSuccess} onClick={() => resend.mutate(email.trim())}>
            {resend.isSuccess ? 'Lien renvoyé — consultez votre boîte mail' : resend.isPending ? 'Envoi…' : 'Renvoyer le lien'}
          </button>
        </div>
      ) : error ? (
        <p className="alert alert--error" role="alert">
          {errorMessage(error)}
        </p>
      ) : null}
      <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
        <Field label="Adresse email" type="email" name="email" autoComplete="username" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field label="Mot de passe" type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit" className="btn btn--block" disabled={pending || !email || !password}>
          {pending ? 'Connexion…' : 'Se connecter'}
        </button>
      </form>
      <p>
        <Link to="/forgot-password">Mot de passe oublié ?</Link>
      </p>
      <p>
        Pas encore de compte ? <Link to="/register">Créer un compte</Link>
      </p>
    </section>
  );
}
