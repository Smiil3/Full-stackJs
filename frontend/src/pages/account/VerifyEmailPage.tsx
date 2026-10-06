import { useState, type SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { dropSession } from '../../api/client';
import { useResendVerification, useVerifyEmail } from '../../api/hooks/account';
import { errorMessage, isApiError } from '../../api/errors';
import { useAuth } from '../../auth/AuthContext';
import { Field } from '../../components/Field';
import { useUrlToken } from './useUrlToken';

/**
 * Confirmation d'email. Action par BOUTON (pas automatique au chargement) : certains antivirus de
 * messagerie ouvrent les liens et consommeraient le jeton à usage unique.
 */
export function VerifyEmailPage() {
  const token = useUrlToken();
  const navigate = useNavigate();
  const { status } = useAuth();
  const verify = useVerifyEmail();
  const resend = useResendVerification();
  const [email, setEmail] = useState('');

  const confirm = () => {
    if (!token || verify.isPending) return;
    verify.mutate(token, {
      onSuccess: () => {
        // Contrat v1.5 : la vérification révoque toutes les sessions ⇒ fin de session locale puis connexion.
        if (status === 'authenticated') dropSession('logout');
        void navigate('/login?info=verified', { replace: true });
      },
    });
  };

  const resendSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (email.trim()) resend.mutate(email.trim());
  };

  const invalidLink = !token || (isApiError(verify.error) && verify.error.code === 'VALIDATION_ERROR');

  return (
    <section className="page narrow">
      <h1>Confirmer mon adresse email</h1>
      {!invalidLink ? (
        <>
          <p>Cliquez sur le bouton pour confirmer votre adresse.</p>
          <button type="button" className="btn btn--block" onClick={confirm} disabled={verify.isPending}>
            {verify.isPending ? 'Confirmation…' : 'Confirmer mon adresse'}
          </button>
          {verify.error ? (
            <p className="alert alert--error" role="alert">
              {errorMessage(verify.error)}
            </p>
          ) : null}
        </>
      ) : (
        <div className="stack">
          <p className="alert alert--error" role="alert">
            Ce lien est invalide ou a expiré (il n’est valable que 30 minutes et une seule fois).
          </p>
          {resend.isSuccess ? (
            <p className="alert alert--success" role="status">
              Si un compte non confirmé correspond à cette adresse, un nouveau lien vient d’être envoyé.
            </p>
          ) : (
            <form className="stack" onSubmit={resendSubmit} noValidate>
              <Field label="Adresse email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              <button type="submit" className="btn btn--secondary" disabled={resend.isPending}>
                Recevoir un nouveau lien
              </button>
            </form>
          )}
        </div>
      )}
      <p>
        <Link to="/login">Retour à la connexion</Link>
      </p>
    </section>
  );
}
