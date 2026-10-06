import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { requireCsrfHeaders } from '../../middlewares/csrf.js';
import type { Limiters } from '../../middlewares/rateLimit.js';
import { endpoint } from '../../middlewares/validate.js';
import * as c from './controller.js';
import * as s from './schemas.js';

export function authRouter(limiters: Limiters): Router {
  const r = Router();
  r.post('/register', limiters.register, ...endpoint({ body: s.registerBody, response: s.messageResponse, status: 202 }, c.register));
  r.post('/verify-email', limiters.emailActions, ...endpoint({ body: s.tokenBody, response: null }, c.verifyEmail));
  r.post('/resend-verification', limiters.emailActions, ...endpoint({ body: s.emailBody, response: s.messageResponse, status: 202 }, c.resendVerification));
  r.post('/login', limiters.login, ...endpoint({ body: s.loginBody, response: s.authSessionResponse }, c.login));
  r.post('/refresh', limiters.refresh, requireCsrfHeaders, ...endpoint({ response: s.authSessionResponse }, c.refresh));
  r.post('/logout', limiters.refresh, requireCsrfHeaders, ...endpoint({ response: null }, c.logout));
  r.post('/forgot-password', limiters.emailActions, ...endpoint({ body: s.emailBody, response: s.messageResponse, status: 202 }, c.forgotPassword));
  r.post('/reset-password', limiters.emailActions, ...endpoint({ body: s.resetBody, response: null }, c.resetPassword));
  r.post('/change-password', limiters.login, requireAuth, ...endpoint({ body: s.changePasswordBody, response: null }, c.changePassword));
  r.get('/me', requireAuth, ...endpoint({ response: s.userResponse }, c.me));
  return r;
}
