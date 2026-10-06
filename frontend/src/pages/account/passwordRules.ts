/** Contrôles UX seulement (le serveur fait foi : longueur, octets, mots de passe courants). */
export function passwordProblem(password: string, confirm: string): string | undefined {
  if (password.length < 12) return 'Au moins 12 caractères.';
  if (password.length > 128) return 'Au plus 128 caractères.';
  if (new TextEncoder().encode(password).length > 256) return 'Mot de passe trop long.';
  if (password !== confirm) return 'Les deux mots de passe ne correspondent pas.';
  return undefined;
}

/** Email ASCII (contrat v1.5) — contrôle UX. */
export function emailProblem(email: string): string | undefined {
  if (!/^[\x21-\x7e]+@[\x21-\x7e]+\.[\x21-\x7e]+$/.test(email.trim())) return 'Adresse email invalide (caractères accentués non acceptés).';
  return undefined;
}
