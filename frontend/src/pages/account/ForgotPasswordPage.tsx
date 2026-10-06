import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { useForgotPassword } from '../../api/hooks/account';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Field } from '../../components/Field';

export function ForgotPasswordPage() {
  const forgot = useForgotPassword();
  const [email, setEmail] = useState('');
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (email.trim() && !forgot.isPending) forgot.mutate(email.trim());
  };
  return (
    <section className="page narrow">
      <h1>Mot de passe oublié</h1>
      {forgot.isSuccess ? (
        <p className="alert alert--success" role="status">
          Si un compte correspond à cette adresse, un email contenant un lien de réinitialisation (valable 30 minutes) vient d’être envoyé.
        </p>
      ) : (
        <form className="stack" onSubmit={submit} noValidate>
          <Field label="Adresse email" type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <button type="submit" className="btn btn--block" disabled={forgot.isPending || !email.trim()}>
            Recevoir un lien
          </button>
          <ErrorAlert error={forgot.error} />
        </form>
      )}
      <p>
        <Link to="/login">Retour à la connexion</Link>
      </p>
    </section>
  );
}
