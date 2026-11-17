import { useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import type { TwoFactorSetup, TwoFactorStatus } from '../shared/two-factor.js';
import { api, errorMessage } from './api.js';
import './TwoFactorSettings.css';

type Operation = 'setup' | 'enable' | 'disable';
type Result = TwoFactorSetup | { enabled: true; recoveryCodes: string[] } | { enabled: false };
const queryKey = ['local-two-factor'];

export function TwoFactorSettings() {
  const id = useId(), client = useQueryClient();
  const error = useRef<HTMLDivElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const recoveryInput = useRef<HTMLTextAreaElement>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [enrollment, setEnrollment] = useState<TwoFactorSetup | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const status = useQuery({ queryKey, queryFn: () => api<TwoFactorStatus>('/auth/two-factor'), retry: false });
  const change = useMutation({
    gcTime: 0,
    mutationFn: ({ operation, currentPassword, code }: { operation: Operation; currentPassword: string; code: string }) =>
      api<Result>(`/auth/two-factor/${operation}`, { method: 'POST', body: { currentPassword, ...(operation !== 'setup' ? { code } : {}) } }),
    onSuccess: result => {
      setPassword(''); setCode('');
      if ('secret' in result) { setEnrollment(result); requestAnimationFrame(() => passwordInput.current?.focus()); }
      else {
        setEnrollment(null);
        setRecoveryCodes(result.enabled ? result.recoveryCodes : null);
        client.setQueryData<TwoFactorStatus>(queryKey, { available: true, enabled: result.enabled, pending: false, recoveryCodesRemaining: result.enabled ? result.recoveryCodes.length : 0 });
        if (result.enabled) requestAnimationFrame(() => recoveryInput.current?.focus());
      }
      void client.invalidateQueries({ queryKey, exact: true });
    },
    onError: () => { setCode(''); requestAnimationFrame(() => error.current?.focus()); },
  });
  const enabled = status.data?.enabled ?? false;
  const operation: Operation = enabled ? 'disable' : enrollment ? 'enable' : 'setup';
  const clearError = () => { if (change.isError) change.reset(); };

  return <section className="surface details-card central-settings two-factor-settings" aria-labelledby={`${id}-heading`}>
    <div className="card-heading"><ShieldCheck size={19} aria-hidden="true" /><h2 id={`${id}-heading`}>Two-factor authentication</h2></div>
    <p id={`${id}-help`}>Protect local password sign-in with an authenticator app. Central sign-in uses your identity provider's authentication settings.</p>
    {status.isPending ? <p role="status">Loading authenticator settings...</p> : status.error ? <div className="error-notice" role="alert">{errorMessage(status.error)}</div> : !status.data?.available ? <p>Sign in with your local password to manage this authenticator.</p> : <>
      <p role="status">{enabled ? `Enabled. ${status.data.recoveryCodesRemaining} recovery codes remain.` : 'Not enabled.'}</p>
      {recoveryCodes ? <div>
        <p id={`${id}-recovery-help`}>Each code works once if your authenticator is unavailable. These codes are shown only now. Save them in a secure place before closing this section.</p>
        <label htmlFor={`${id}-recovery`}>Save your recovery codes<textarea ref={recoveryInput} id={`${id}-recovery`} rows={10} value={recoveryCodes.join('\n')} readOnly aria-describedby={`${id}-recovery-help`} spellCheck={false} /></label>
        <button type="button" className="button" onClick={() => { setRecoveryCodes(null); change.reset(); }}>I saved my recovery codes</button>
      </div> : null}
      {enrollment ? <div className="two-factor-setup">
        <p>Add this account to your authenticator app, then enter a code below. Setup expires at {new Date(enrollment.expiresAt).toLocaleTimeString()}.</p>
        <label htmlFor={`${id}-secret`}>Manual setup key<input id={`${id}-secret`} value={enrollment.secret} readOnly spellCheck={false} aria-describedby={`${id}-secret-help`} /></label>
        <p id={`${id}-secret-help`}>Use time-based codes, six digits and a 30-second interval.</p>
        <label htmlFor={`${id}-uri`}>Authenticator setup URI<textarea id={`${id}-uri`} value={enrollment.uri} rows={3} readOnly spellCheck={false} /></label>
      </div> : null}
      <form className="local-password-form" method="post" action={`/api/v1/auth/two-factor/${operation}`} aria-labelledby={`${id}-heading`} aria-describedby={`${id}-help`} onSubmit={event => {
        event.preventDefault(); change.mutate({ operation, currentPassword: password, code });
      }}>
        <label htmlFor={`${id}-password`}>Current password (required)<input ref={passwordInput} id={`${id}-password`} name="currentPassword" type="password" value={password} onChange={event => { setPassword(event.target.value); clearError(); }} autoComplete="current-password" maxLength={128} required disabled={change.isPending} /></label>
        {operation !== 'setup' ? <>
          <label htmlFor={`${id}-code`}>{enabled ? 'Authenticator or recovery code (required)' : 'Six-digit authenticator code (required)'}<input id={`${id}-code`} name="code" type="text" value={code} onChange={event => { setCode(event.target.value); clearError(); }} inputMode={enabled ? 'text' : 'numeric'} autoComplete="one-time-code" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={enabled ? 64 : 6} pattern={enabled ? undefined : '[0-9]{6}'} required disabled={change.isPending} /></label>
        </> : null}
        {change.error ? <div ref={error} className="error-notice" role="alert" tabIndex={-1}>{errorMessage(change.error)}</div> : null}
        <div className="heading-actions"><button type="submit" className={`button ${enabled ? 'button-danger' : 'button-primary'}`} disabled={change.isPending}>
          {change.isPending ? 'Saving...' : enabled ? 'Disable two-factor authentication' : enrollment ? 'Enable authenticator' : 'Set up authenticator'}
        </button>
        {enrollment ? <button type="button" className="button" disabled={change.isPending} onClick={() => { setEnrollment(null); setPassword(''); setCode(''); change.reset(); }}>Cancel setup</button> : null}</div>
      </form>
    </>}
  </section>;
}
