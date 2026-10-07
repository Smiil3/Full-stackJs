/** Contrôles UX seulement (le serveur fait foi : longueur, octets, mots de passe courants). */
export function passwordProblem(password: string, confirm: string): string | undefined {
  if (password.length === 0) return 'Il manque votre mot de passe : 12 caractères au moins.';
  if (password.length < 12) return 'Au moins 12 caractères.';
  if (password.length > 128) return 'Au plus 128 caractères.';
  if (new TextEncoder().encode(password).length > 256) return 'Mot de passe trop long.';
  if (password !== confirm) return 'Les deux mots de passe ne correspondent pas.';
  return undefined;
}

/** Email ASCII (contrat v1.5) — contrôle UX. */
export function emailProblem(email: string): string | undefined {
  if (!email.trim()) return 'Il manque votre e-mail : c’est là que nous envoyons les billets.';
  if (!/^[\x21-\x7e]+@[\x21-\x7e]+\.[\x21-\x7e]+$/.test(email.trim())) return 'Cette adresse e-mail ne semble pas complète. Vérifiez-la (les caractères accentués ne sont pas acceptés).';
  return undefined;
}
