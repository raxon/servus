import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { api, errorMessage } from "./api.js";

export function LocalPasswordSettings() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordMismatch, setPasswordMismatch] = useState(false);
  const confirmation = useRef<HTMLInputElement>(null);
  const status = useQuery({
    queryKey: ["local-password"],
    queryFn: () => api<{ available: boolean }>("/auth/password"),
    retry: false,
  });
  const change = useMutation({
    mutationFn: () => api<{ success: boolean }>("/auth/password", {
      method: "POST",
      body: { currentPassword, newPassword },
    }),
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      if (confirmation.current) confirmation.current.value = "";
    },
  });
  if (!status.data?.available && !status.error) return null;
  return (
    <section className="surface details-card central-settings">
      <div className="card-heading"><ShieldCheck size={19} aria-hidden="true" /><h3>Local password</h3></div>
      {status.error ? <div className="error-notice" role="alert">{errorMessage(status.error)}</div> : (
        <>
          <p>Confirm the change with your current password.</p>
          <form className="local-password-form" onSubmit={(event) => {
            event.preventDefault();
            if (confirmation.current?.value !== newPassword) {
              change.reset();
              setPasswordMismatch(true);
              confirmation.current?.focus();
              return;
            }
            change.mutate();
          }}>
            <label>Current password
              <input name="currentPassword" type="password" value={currentPassword} onChange={(event) => { setCurrentPassword(event.target.value); change.reset(); }} autoComplete="current-password" maxLength={128} disabled={change.isPending} required />
            </label>
            <div className="local-password-field">
              <label>New password
                <input name="newPassword" type="password" value={newPassword} onChange={(event) => { setNewPassword(event.target.value); setPasswordMismatch(false); change.reset(); }} autoComplete="new-password" minLength={8} maxLength={128} aria-describedby="local-password-help" disabled={change.isPending} required />
              </label>
              <small id="local-password-help">Use at least 8 characters.</small>
            </div>
            <label>Confirm new password
              <input name="passwordConfirmation" ref={confirmation} type="password" onChange={() => { setPasswordMismatch(false); change.reset(); }} autoComplete="new-password" maxLength={128} aria-invalid={passwordMismatch} aria-describedby={passwordMismatch ? "local-password-mismatch" : undefined} disabled={change.isPending} required />
            </label>
            <div id="local-password-mismatch" className="local-password-mismatch" role="status">{passwordMismatch ? "New passwords do not match." : null}</div>
            {change.error ? <div className="error-notice" role="alert">{errorMessage(change.error)}</div> : null}
            {change.isSuccess ? <p role="status">Password updated. Other sessions have been signed out.</p> : null}
            <button type="submit" className="button button-primary" disabled={change.isPending}>
              {change.isPending ? "Updating..." : "Update password"}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
