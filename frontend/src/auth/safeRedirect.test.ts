import { describe, expect, it } from 'vitest';
import { loginPathWithNext, safeRedirectPath } from './safeRedirect';

describe('safeRedirectPath (anti open-redirect)', () => {
  it.each([
    ['/me/tickets', '/me/tickets'],
    ['/orders/123?payment=success', '/orders/123?payment=success'],
    ['/events/abc#types', '/events/abc#types'],
    ['/a/../b', '/b'],
  ])('accepte le chemin interne %s', (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected);
  });

  it.each([
    'https://evil.example',
    'http://evil.example/me',
    '//evil.example',
    '///evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '%2F%2Fevil.example',
    '/%2F%2Fevil.example',
    '/%5Cevil.example',
    '%252F%252Fevil.example',
    '/\tevil',
    ' /me',
    'me/tickets',
    '',
    '%E0%A4%A',
    `/${'a'.repeat(600)}`,
  ])('refuse %s', (input) => {
    expect(safeRedirectPath(input)).toBe('/');
  });

  it('refuse null / undefined et utilise le repli fourni', () => {
    expect(safeRedirectPath(null, '/me/tickets')).toBe('/me/tickets');
    expect(safeRedirectPath(undefined)).toBe('/');
  });

  it('loginPathWithNext encode le chemin courant et ignore les valeurs externes', () => {
    expect(loginPathWithNext('/orders/1?payment=success')).toBe('/login?next=%2Forders%2F1%3Fpayment%3Dsuccess');
    expect(loginPathWithNext('//evil.example')).toBe('/login');
    expect(loginPathWithNext('/login')).toBe('/login');
  });
});
