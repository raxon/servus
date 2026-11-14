import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { api, errorMessage } from "./api.js";

export function LocalPasswordSettings() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
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
    onSuccess: () => { setCurrentPassword(""); setNewPassword(""); },
  });
  if (!status.data?.available && !status.error) return null;
  return (
    <section className="surface details-card central-settings">
      <div className="card-heading"><ShieldCheck size={19} aria-hidden="true" /><h2>Local password</h2></div>
      {status.error ? <div className="error-notice" role="alert">{errorMessage(status.error)}</div> : (
        <>
          <p>Change the password you use to sign in to this installation.</p>
          <form className="local-password-form" onSubmit={(event) => { event.preventDefault(); change.mutate(); }}>
            <label>Current password
              <input type="password" value={currentPassword} onChange={(event) => { setCurrentPassword(event.target.value); change.reset(); }} autoComplete="current-password" maxLength={128} disabled={change.isPending} required />
            </label>
            <label>New password
              <input type="password" value={newPassword} onChange={(event) => { setNewPassword(event.target.value); change.reset(); }} autoComplete="new-password" minLength={8} maxLength={128} aria-describedby="local-password-help" disabled={change.isPending} required />
              <small id="local-password-help">Use at least 8 characters.</small>
            </label>
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
