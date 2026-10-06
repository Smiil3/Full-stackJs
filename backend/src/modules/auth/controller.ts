import type { CookieOptions, Request, Response } from 'express';
import { getEnv } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { getAuth } from '../../middlewares/auth.js';
import type { ValidatedInput } from '../../middlewares/validate.js';
import * as service from './service.js';
import type { ChangePasswordBody, EmailBody, LoginBody, RegisterBody, ResetBody, TokenBody } from './schemas.js';

type Empty = Record<string, never>;
type In<B> = ValidatedInput<Empty, Empty, B, Empty>;

export const REFRESH_COOKIE = 'nuits_rt';

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: getEnv().refreshCookieSecure,
    sameSite: 'strict',
    path: '/api/v1/auth',
  };
}

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, { ...cookieOptions(), maxAge: service.REFRESH_TTL_MS });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, cookieOptions());
}

function readRefreshCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' ? value : undefined;
}

export async function register({ body }: In<RegisterBody>) {
  await service.register(body);
  return { message: service.GENERIC_ACCEPTED_MESSAGE };
}

export async function verifyEmail({ body }: In<TokenBody>) {
  await service.verifyEmail(body.token);
}

export async function resendVerification({ body }: In<EmailBody>) {
  await service.resendVerification(body.email);
  return { message: service.GENERIC_ACCEPTED_MESSAGE };
}

export async function login({ body }: In<LoginBody>, _req: Request, res: Response) {
  const result = await service.login(body.email, body.password);
  setRefreshCookie(res, result.refreshToken);
  return result.session;
}

export async function refresh(_input: In<Empty>, req: Request, res: Response) {
  try {
    const result = await service.refresh(readRefreshCookie(req));
    setRefreshCookie(res, result.refreshToken);
    return result.session;
  } catch (err) {
    // Cookie effacé UNIQUEMENT sur un refus explicite (401) : une erreur transitoire (5xx, réseau)
    // ne doit pas déconnecter l'utilisateur.
    if (err instanceof AppError && err.status === 401) clearRefreshCookie(res);
    throw err;
  }
}

export async function logout(_input: In<Empty>, req: Request, res: Response) {
  await service.logout(readRefreshCookie(req));
  clearRefreshCookie(res);
}

export async function forgotPassword({ body }: In<EmailBody>) {
  await service.forgotPassword(body.email);
  return { message: service.GENERIC_ACCEPTED_MESSAGE };
}

export async function resetPassword({ body }: In<ResetBody>) {
  await service.resetPassword(body.token, body.password);
}

export async function changePassword({ body }: In<ChangePasswordBody>, _req: Request, res: Response) {
  await service.changePassword(getAuth(res).userId, body.currentPassword, body.newPassword);
  clearRefreshCookie(res);
}

export function me(_input: In<Empty>, _req: Request, res: Response) {
  return service.me(getAuth(res).userId);
}
