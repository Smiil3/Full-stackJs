import { useMutation } from '@tanstack/react-query';
import { apiRequest } from '../client';
import type { ChangePasswordBody, MessageResponse, RegisterBody, ResetPasswordBody } from '../types';

const publicPost = <T>(path: string, body: unknown) => apiRequest<T>(path, { method: 'POST', body, auth: false });

export const useRegister = () => useMutation({ mutationFn: (b: RegisterBody) => publicPost<MessageResponse>('/auth/register', b) });
export const useVerifyEmail = () => useMutation({ mutationFn: (token: string) => publicPost<undefined>('/auth/verify-email', { token }) });
export const useResendVerification = () => useMutation({ mutationFn: (email: string) => publicPost<MessageResponse>('/auth/resend-verification', { email }) });
export const useForgotPassword = () => useMutation({ mutationFn: (email: string) => publicPost<MessageResponse>('/auth/forgot-password', { email }) });
export const useResetPassword = () => useMutation({ mutationFn: (b: ResetPasswordBody) => publicPost<undefined>('/auth/reset-password', b) });
export const useChangePassword = () =>
  useMutation({ mutationFn: (b: ChangePasswordBody) => apiRequest<undefined>('/auth/change-password', { method: 'POST', body: b }) });
