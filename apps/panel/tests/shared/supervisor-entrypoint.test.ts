import { describe, expect, it } from 'vitest';
import { supervisorConfig } from '../../src/shared/supervisor-entrypoint.js';

describe('supervisor entrypoint configuration', () => {
  it('keeps supervisor control disabled when both settings are absent', () => {
    expect(supervisorConfig({})).toBeUndefined();
  });

  it('rejects partial, empty, identical, relative or missing settings', () => {
    for (const environment of [
      { PANEL_SUPERVISOR_SOCKET: '/socket' },
      { PANEL_SUPERVISOR_SECRET_FILE: '/secret' },
      { PANEL_SUPERVISOR_SOCKET: '', PANEL_SUPERVISOR_SECRET_FILE: '/secret' },
      { PANEL_SUPERVISOR_SOCKET: '/socket', PANEL_SUPERVISOR_SECRET_FILE: '' },
      { PANEL_SUPERVISOR_SOCKET: '/same', PANEL_SUPERVISOR_SECRET_FILE: '/same' },
      { PANEL_SUPERVISOR_SOCKET: 'socket', PANEL_SUPERVISOR_SECRET_FILE: '/secret' },
      { PANEL_SUPERVISOR_SOCKET: '/missing-socket', PANEL_SUPERVISOR_SECRET_FILE: '/missing-secret' },
    ]) expect(() => supervisorConfig(environment)).toThrow('Invalid supervisor configuration');
  });
});
