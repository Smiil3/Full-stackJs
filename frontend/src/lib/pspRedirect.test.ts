import { describe, expect, it } from 'vitest';
import { resolvePspRedirect } from './pspRedirect';

const dev = { appOrigin: 'http://localhost:5173', pspOrigin: 'http://localhost:4001', isProd: false };
const prod = { appOrigin: 'https://billetterie.example.org', pspOrigin: 'https://pay.psp.example', isProd: true };

describe('resolvePspRedirect', () => {
  it('accepte la page du PSP configuré', () => {
    expect(resolvePspRedirect('http://localhost:4001/checkout/cs_1', dev)).toEqual({ kind: 'external', url: 'http://localhost:4001/checkout/cs_1' });
    expect(resolvePspRedirect('https://pay.psp.example/c/1', prod)).toEqual({ kind: 'external', url: 'https://pay.psp.example/c/1' });
  });
  it('navigation interne pour notre origine', () => {
    expect(resolvePspRedirect('http://localhost:5173/mock-psp/abc', dev)).toEqual({ kind: 'internal', path: '/mock-psp/abc' });
  });
  it.each([
    'javascript:alert(1)',
    'https://evil.example/checkout',
    'http://localhost:4001.evil.example/x',
    'http://user:pass@localhost:4001/x',
    'http://localhost:5173/.//evil.com',
    'data:text/html,x',
    '/relative/path',
    '',
  ])('refuse %s', (url) => {
    expect(resolvePspRedirect(url, dev)).toBeNull();
  });
  it('en production : refuse le http et l’absence de configuration', () => {
    expect(resolvePspRedirect('http://pay.psp.example/c/1', prod)).toBeNull();
    expect(resolvePspRedirect('https://pay.psp.example/c/1', { ...prod, pspOrigin: undefined })).toBeNull();
    expect(resolvePspRedirect('http://localhost:4001/c', { ...prod, pspOrigin: 'http://localhost:4001' })).toBeNull();
  });
});
