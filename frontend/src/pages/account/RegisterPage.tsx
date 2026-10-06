import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { useRegister } from '../../api/hooks/account';
import { errorMessage, fieldErrors } from '../../api/errors';
import { Field } from '../../components/Field';
import { emailProblem, passwordProblem } from './passwordRules';

export function RegisterPage() {
  const register = useRegister();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);

  const local = {
    email: emailProblem(email),
    displayName: displayName.trim().length < 1 ? 'Il manque votre nom.' : displayName.length > 80 ? 'Entre 1 et 80 caractères.' : undefined,
    password: passwordProblem(password, confirm),
  };
  const server = fieldErrors(register.error);
  const invalid = Object.values(local).some(Boolean);

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setTouched(true);
    if (invalid || register.isPending) return;
    register.mutate({ email: email.trim(), password, displayName: displayName.trim() });
  };

  if (register.isSuccess) {
    return (
      <section className="page narrow">
        <h1>Vérifiez votre boîte mail</h1>
        {/* Message neutre : ne révèle jamais si l'adresse avait déjà un compte. */}
        <p className="alert alert--success" role="status">
          Si cette adresse peut être utilisée, un email vient de vous être envoyé. Ouvrez le lien qu’il contient pour confirmer votre adresse, puis connectez-vous.
        </p>
        <p>
          <Link to="/login">Aller à la connexion</Link>
        </p>
      </section>
    );
  }

  return (
    <section className="page narrow">
      <h1>Créer un compte</h1>
      {register.error && Object.keys(server).length === 0 ? (
        <p className="alert alert--error" role="alert">
          {errorMessage(register.error)}
        </p>
      ) : null}
      <form className="stack" onSubmit={submit} noValidate>
        <Field label="Adresse email" type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={(touched ? local.email : undefined) ?? server.email} />
        <Field label="Nom affiché" autoComplete="name" required maxLength={80} value={displayName} onChange={(e) => setDisplayName(e.target.value)} error={(touched ? local.displayName : undefined) ?? server.displayName} />
        <Field
          label="Mot de passe"
          type="password"
          autoComplete="new-password"
          required
          hint="12 caractères minimum. Une phrase de passe est idéale."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={server.password}
        />
        <Field label="Confirmer le mot de passe" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} error={touched ? local.password : undefined} />
        <button type="submit" className="btn btn--block" disabled={register.isPending}>
          {register.isPending ? 'Création…' : 'Créer mon compte'}
        </button>
      </form>
      <p>
        Déjà inscrit·e ? <Link to="/login">Se connecter</Link>
      </p>
    </section>
  );
}
