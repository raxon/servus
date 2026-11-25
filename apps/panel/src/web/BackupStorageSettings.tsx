import { useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud, HardDrive, Pencil, Plus, Trash2 } from "lucide-react";
import type { BackupStorageProfile } from "../shared/storage-target.js";
import { api } from "./api.js";
import { FeatureError, FeatureLoading, FeatureModal } from "./feature-ui.js";

type Draft = {
  id?: string;
  name: string;
  provider: "local" | "s3" | "r2";
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  storageClass: string;
  accessKeyId: string;
  secretAccessKey: string;
};

const blank: Draft = {
  name: "",
  provider: "s3",
  endpoint: "https://s3.us-east-1.amazonaws.com",
  region: "us-east-1",
  bucket: "",
  prefix: "backups",
  storageClass: "STANDARD",
  accessKeyId: "",
  secretAccessKey: "",
};

export function BackupStorageSettings() {
  const id = useId();
  const client = useQueryClient();
  const nameInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["backup-storage"],
    queryFn: () => api<{ profiles: BackupStorageProfile[] }>("/backup-storage"),
  });
  const refresh = () => { void client.invalidateQueries({ queryKey: ["backup-storage"] }); };
  const save = useMutation({
    gcTime: 0,
    mutationFn: ({ id: profileId, name, provider, endpoint, region, bucket, prefix, storageClass, accessKeyId, secretAccessKey }: Draft) =>
      api(`/backup-storage${profileId ? `/${profileId}` : ""}`, {
        method: profileId ? "PUT" : "POST",
        body: {
          name,
          destination: provider === "local" ? { type: "local" } : {
            type: "s3", provider, endpoint, region, bucket, prefix, storageClass,
            ...(accessKeyId ? { accessKeyId } : {}),
            ...(secretAccessKey ? { secretAccessKey } : {}),
          },
        },
      }),
    onSuccess: () => { save.reset(); setDraft(null); setSaved(true); refresh(); },
  });
  const remove = useMutation({
    mutationFn: (profileId: string) => api(`/backup-storage/${profileId}`, { method: "DELETE" }),
    onSuccess: () => { setRemoving(null); refresh(); },
  });

  function edit(profile: BackupStorageProfile) {
    const { destination } = profile;
    save.reset();
    setSaved(false);
    setDraft({
      ...blank, id: profile.id, name: profile.name,
      ...(destination.type === "s3" ? destination : { provider: "local" }),
    });
  }

  function update(values: Partial<Draft>) {
    setDraft((current) => current ? { ...current, ...values } : null);
    if (save.isError) save.reset();
  }

  const previous = draft?.id ? query.data?.profiles.find((profile) => profile.id === draft.id)?.destination : undefined;
  const keepCredentials = previous?.type === "s3" && previous.provider === draft?.provider && previous.endpoint === draft?.endpoint;
  const title = draft?.id ? "Edit storage profile" : "New storage profile";

  return (
    <section className="surface details-card backup-storage-settings" id="backup-storage" aria-labelledby={`${id}-heading`}>
      <div className="settings-card-header">
        <div className="settings-card-intro">
          <div className="card-heading"><HardDrive size={19} aria-hidden="true" /><h3 id={`${id}-heading`}>Backup storage</h3></div>
          <p>Manage storage profiles for database and volume backups.</p>
        </div>
        <button className="button button-primary" type="button" onClick={() => { save.reset(); setSaved(false); setDraft({ ...blank }); }}>
          <Plus size={16} aria-hidden="true" />Add storage
        </button>
      </div>
      <FeatureError error={query.error || remove.error} />
      {query.isPending ? <FeatureLoading label="Loading backup storage" /> : query.data?.profiles.length ? (
        <ul className="settings-list" aria-label="Storage profiles">
          {query.data.profiles.map((profile) => (
            <li className="settings-list-item" key={profile.id}>
              <span className="settings-list-icon">
                {profile.destination.type === "local" ? <HardDrive size={18} aria-hidden="true" /> : <Cloud size={18} aria-hidden="true" />}
              </span>
              <div className="settings-list-copy">
                <strong>{profile.name}</strong>
                <span>{profile.destination.type === "local" ? "Local server storage" : `${profile.destination.provider === "r2" ? "Cloudflare R2" : "S3 compatible"} · ${profile.destination.bucket}`}</span>
              </div>
              <div className="settings-list-actions">
                <button className="button button-small" type="button" onClick={() => edit(profile)} aria-label={`Edit ${profile.name}`}>
                  <Pencil size={15} aria-hidden="true" />Edit
                </button>
                <button className="button button-small" type="button" onClick={() => setRemoving(profile.id)} aria-label={`Remove ${profile.name}`}>
                  <Trash2 size={15} aria-hidden="true" />Remove
                </button>
              </div>
              {removing === profile.id ? (
                <div className="settings-inline-confirm">
                  <p>Remove this profile from the selector? Existing backup files remain accessible.</p>
                  <button className="button button-danger" type="button" disabled={remove.isPending} onClick={() => remove.mutate(profile.id)}>Remove profile</button>
                  <button className="button" type="button" disabled={remove.isPending} onClick={() => setRemoving(null)}>Cancel</button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : !query.error ? (
        <div className="settings-empty">
          <HardDrive size={23} aria-hidden="true" />
          <div><strong>No storage profiles yet</strong><p>Backups can already use this server. Add a profile to store copies in S3 or Cloudflare R2.</p></div>
        </div>
      ) : null}
      {saved ? <p className="settings-feedback" role="status">Storage profile saved.</p> : null}

      {draft ? (
        <FeatureModal title={title} description={draft.id ? "Update the destination or credentials for this storage profile." : "Add a destination you can select in backup settings."} dismissible={!save.isPending} initialFocus={nameInput} onClose={() => { save.reset(); setDraft(null); }}>
          <form className="settings-modal-form storage-profile-form" action={`/api/v1/backup-storage${draft.id ? `/${draft.id}` : ""}`} method="post" aria-label={title} onSubmit={(event) => {
            event.preventDefault();
            if (!save.isPending) save.mutate(draft);
          }}>
            <div className="storage-profile-fields">
              <fieldset className="settings-form-fields" disabled={save.isPending}>
                <label htmlFor={`${id}-name`}>Profile name
                  <input ref={nameInput} id={`${id}-name`} name="name" required maxLength={80} value={draft.name} onChange={(event) => update({ name: event.target.value })} placeholder="Production backups" />
                </label>
                <label htmlFor={`${id}-provider`}>Storage provider
                  <select id={`${id}-provider`} name="provider" value={draft.provider} onChange={(event) => {
                    const provider = event.target.value as Draft["provider"];
                    update({ provider, region: provider === "r2" ? "auto" : blank.region, endpoint: provider === "r2" ? "" : blank.endpoint, storageClass: blank.storageClass });
                  }}>
                    <option value="local">This server</option>
                    <option value="s3">Amazon S3 / compatible</option>
                    <option value="r2">Cloudflare R2</option>
                  </select>
                </label>
                {draft.provider !== "local" ? <>
                  <label htmlFor={`${id}-endpoint`}>Endpoint URL
                    <input id={`${id}-endpoint`} name="endpoint" type="url" required maxLength={512} value={draft.endpoint} onChange={(event) => update({ endpoint: event.target.value })} placeholder="https://account.r2.cloudflarestorage.com" spellCheck={false} autoCapitalize="none" />
                  </label>
                  <div className="settings-form-pair">
                    <label htmlFor={`${id}-bucket`}>Bucket
                      <input id={`${id}-bucket`} name="bucket" required minLength={3} maxLength={63} value={draft.bucket} onChange={(event) => update({ bucket: event.target.value })} spellCheck={false} autoCapitalize="none" />
                    </label>
                    <label htmlFor={`${id}-region`}>Region
                      <input id={`${id}-region`} name="region" required maxLength={64} value={draft.region} onChange={(event) => update({ region: event.target.value })} spellCheck={false} autoCapitalize="none" />
                    </label>
                    <label htmlFor={`${id}-prefix`}>Folder prefix (optional)
                      <input id={`${id}-prefix`} name="prefix" maxLength={200} value={draft.prefix} onChange={(event) => update({ prefix: event.target.value })} spellCheck={false} autoCapitalize="none" />
                    </label>
                    <label htmlFor={`${id}-class`}>Storage class
                      <select id={`${id}-class`} name="storageClass" value={draft.storageClass} onChange={(event) => update({ storageClass: event.target.value })}>
                        {(draft.provider === "r2" ? ["STANDARD", "STANDARD_IA"] : ["STANDARD", "STANDARD_IA", "ONEZONE_IA", "INTELLIGENT_TIERING", "GLACIER_IR"]).map((option) => <option key={option}>{option}</option>)}
                      </select>
                    </label>
                  </div>
                  <fieldset className="settings-form-fields storage-credentials">
                    <legend>Credentials</legend>
                    <label htmlFor={`${id}-access`}>Access key ID{keepCredentials ? " (leave blank to keep)" : ""}
                      <input id={`${id}-access`} name="accessKeyId" type="password" autoComplete="new-password" required={!keepCredentials} maxLength={256} value={draft.accessKeyId} onChange={(event) => update({ accessKeyId: event.target.value })} />
                    </label>
                    <label htmlFor={`${id}-secret`}>Secret access key{keepCredentials ? " (leave blank to keep)" : ""}
                      <input id={`${id}-secret`} name="secretAccessKey" type="password" autoComplete="new-password" required={!keepCredentials} maxLength={4096} value={draft.secretAccessKey} onChange={(event) => update({ secretAccessKey: event.target.value })} />
                    </label>
                    <p className="settings-form-note">{draft.id && !keepCredentials ? "Changing the endpoint or provider requires both credentials." : "Credentials are encrypted on this server."}</p>
                  </fieldset>
                </> : <p className="settings-form-note">Uses the private backup directory on this server.</p>}
                {draft.id ? <p className="settings-form-note">Select and save this profile again in each service to apply changes to future backups.</p> : null}
              </fieldset>
              <FeatureError error={save.error} />
            </div>
            <div className="settings-modal-actions">
              <button className="button" type="button" disabled={save.isPending} onClick={() => { save.reset(); setDraft(null); }}>Cancel</button>
              <button className="button button-primary" type="submit" disabled={save.isPending}>{save.isPending ? "Saving storage…" : "Save storage profile"}</button>
            </div>
          </form>
        </FeatureModal>
      ) : null}
    </section>
  );
}
