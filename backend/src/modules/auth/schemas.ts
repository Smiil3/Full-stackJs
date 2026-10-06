import Joi from 'joi';
import { email, roleSchema, text, uuidStrict } from '../../lib/schemas.js';
import { checkPasswordPolicy, PASSWORD_MAX_BYTES } from '../../lib/passwordPolicy.js';

/**
 * Mot de passe d'un NOUVEAU secret : 12 à 128 points de code, ≤ 256 octets, pas un mot de passe courant
 * (pas de règle de composition, cf. recommandations ANSSI / NIST).
 */
export const password = text()
  .max(PASSWORD_MAX_BYTES)
  .custom((value: string, helpers) => {
    const problem = checkPasswordPolicy(value);
    return problem === null ? value : helpers.error(`password.${problem}`);
  })
  .messages({
    'password.too_short': '{{#label}} doit contenir au moins 12 caractères',
    'password.too_long': '{{#label}} doit contenir au plus 128 caractères',
    'password.too_many_bytes': '{{#label}} est trop long',
    'password.common': '{{#label}} fait partie des mots de passe les plus courants, choisissez-en un autre',
  });
/** Nom affiché : pas de caractères de contrôle. */
export const displayName = text().min(1).max(80);
/** Jeton reçu par mail : 32 octets base64url. */
const mailToken = Joi.string().pattern(/^[A-Za-z0-9_-]{43}$/).messages({ 'string.pattern.base': '{{#label}} est invalide' });

export interface RegisterBody { email: string; password: string; displayName: string }
export interface LoginBody { email: string; password: string }
export interface EmailBody { email: string }
export interface TokenBody { token: string }
export interface ResetBody { token: string; password: string }
export interface ChangePasswordBody { currentPassword: string; newPassword: string }

export const registerBody = Joi.object<RegisterBody>({ email: email.required(), password: password.required(), displayName: displayName.required() });
// Au login, aucune règle de longueur fine : on ne révèle pas la politique, on borne seulement la taille.
export const loginBody = Joi.object<LoginBody>({ email: email.required(), password: text().min(1).max(PASSWORD_MAX_BYTES).required() });
export const emailBody = Joi.object<EmailBody>({ email: email.required() });
export const tokenBody = Joi.object<TokenBody>({ token: mailToken.required() });
export const resetBody = Joi.object<ResetBody>({ token: mailToken.required(), password: password.required() });
export const changePasswordBody = Joi.object<ChangePasswordBody>({
  currentPassword: text().min(1).max(PASSWORD_MAX_BYTES).required(),
  newPassword: password.required(),
});

export const userResponse = Joi.object({
  id: uuidStrict,
  email: Joi.string(),
  displayName: Joi.string(),
  emailVerified: Joi.boolean(),
  isPlatformAdmin: Joi.boolean(),
  memberships: Joi.array().items(Joi.object({ orgId: uuidStrict, orgName: Joi.string(), orgSlug: Joi.string(), role: roleSchema })),
});

export const authSessionResponse = Joi.object({
  accessToken: Joi.string(),
  expiresIn: Joi.number().integer().valid(600),
  user: userResponse,
});

export const messageResponse = Joi.object({ message: Joi.string() });
