import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, hasAuth, resolveSettings } from '../src/auth-settings';

describe('resolveSettings', () => {
  it('defaults a fresh install to OAuth', () => {
    expect(resolveSettings(null).authMode).toBe('oauth');
    expect(resolveSettings({}).authMode).toBe('oauth');
  });

  it('keeps a saved method', () => {
    expect(resolveSettings({ authMode: 'app-password', appPassword: 'pw' }).authMode).toBe('app-password');
    expect(resolveSettings({ authMode: 'oauth', authDid: 'did:plc:x' }).authMode).toBe('oauth');
  });

  it('keeps an existing app-password user on app passwords when authMode is missing', () => {
    expect(resolveSettings({ identifier: 'me.test', appPassword: 'pw' }).authMode).toBe('app-password');
  });

  it('treats a saved OAuth session as OAuth when authMode is missing', () => {
    expect(resolveSettings({ authDid: 'did:plc:x', appPassword: 'stale' }).authMode).toBe('oauth');
  });
});

describe('hasAuth', () => {
  const s = { ...DEFAULT_SETTINGS, identifier: 'me.test', appPassword: 'pw', authDid: 'did:plc:x' };

  it('checks only the chosen method', () => {
    expect(hasAuth({ ...s, authMode: 'oauth', authDid: '' })).toBe(false);
    expect(hasAuth({ ...s, authMode: 'app-password', appPassword: '' })).toBe(false);
    expect(hasAuth({ ...s, authMode: 'oauth' })).toBe(true);
    expect(hasAuth({ ...s, authMode: 'app-password' })).toBe(true);
  });
});
