import { describe, it, expect, afterEach, vi } from 'vitest';
import { redact, logger } from '../src/lib/logger.js';

describe('logger redaction — redact()', () => {
  it('masks token-like keys at the top level', () => {
    const out = redact({
      access_token: 'AT',
      refresh_token: 'RT',
      id_token: 'IT',
      client_secret: 'CS',
      authorization: 'Bearer x',
      password: 'p',
      code: 'c',
      code_verifier: 'cv',
      kek: 'k',
      ciphertext: 'ct',
      iv: 'iv',
      auth_tag: 'tag',
      authTag: 'tag2',
      safe: 'keep-me',
    }) as Record<string, string>;

    for (const k of ['access_token', 'refresh_token', 'id_token', 'client_secret', 'authorization', 'password', 'code', 'code_verifier', 'kek', 'ciphertext', 'iv', 'auth_tag', 'authTag']) {
      expect(out[k], `${k} should be redacted`).toBe('[REDACTED]');
    }
    expect(out.safe).toBe('keep-me');
  });

  it('masks token-like keys nested at depth', () => {
    const out = redact({
      level1: { level2: { accessToken: 'deep-secret', note: 'visible' } },
      list: [{ refreshToken: 'in-array' }],
    }) as any;
    expect(out.level1.level2.accessToken).toBe('[REDACTED]');
    expect(out.level1.level2.note).toBe('visible');
    expect(out.list[0].refreshToken).toBe('[REDACTED]');
  });

  it('scrubs token/code/client_secret/access_token query params in URL string values', () => {
    const out = redact({
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&code=SECRET&state=xyz',
      tokenUrl: 'https://oauth2.googleapis.com/token?access_token=AAA&token=BBB&client_secret=CCC&foo=bar',
    }) as Record<string, string>;

    expect(out.authorizeUrl).toContain('client_id=abc');
    expect(out.authorizeUrl).toContain('state=xyz');
    expect(out.authorizeUrl).not.toContain('SECRET');
    expect(out.authorizeUrl).toContain('code=%5BREDACTED%5D');

    expect(out.tokenUrl).not.toContain('AAA');
    expect(out.tokenUrl).not.toContain('BBB');
    expect(out.tokenUrl).not.toContain('CCC');
    expect(out.tokenUrl).toContain('foo=bar');
  });

  it('leaves non-URL strings untouched', () => {
    const out = redact({ msg: 'a normal message with a ? mark' }) as Record<string, string>;
    expect(out.msg).toBe('a normal message with a ? mark');
  });

  it('is cycle-safe', () => {
    const a: any = { name: 'a' };
    a.self = a;
    const out = redact(a) as any;
    expect(out.name).toBe('a');
    expect(out.self).toBe('[CIRCULAR]');
  });
});

describe('logger redaction — through logger.error', () => {
  afterEach(() => vi.restoreAllMocks());

  it('serialized output masks secret keys and URL params (LOG_LEVEL=error is active)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('oauth exchange', {
      refresh_token: 'should-not-appear',
      callbackUrl: 'http://localhost:3848/api/oauth/google/callback?code=LEAK&state=ok',
    });
    expect(spy).toHaveBeenCalledOnce();
    const line = spy.mock.calls[0]![0] as string;
    expect(line).not.toContain('should-not-appear');
    expect(line).not.toContain('LEAK');
    expect(line).toContain('[REDACTED]');
    expect(line).toContain('state=ok');
  });
});
