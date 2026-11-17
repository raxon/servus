# Signed release installation and update acceptance

This is an internal destructive test procedure for an exclusively owned VM.
Run `bash tests/signed-update-e2e/run.sh` from the repository root with Node.js
24, Colima, Docker, Python, Git, OpenSSL and Playwright Chromium available.
The runner creates a new systemd VM without host mounts. It does not use the
default Docker context or modify the public VPS.

## Frozen releases and trust boundary

The defaults are published v0.1.52, commit
`8f137758abdb7dbece6657201c0667bbb99d1918`, schema 5, and published v0.1.53,
commit `b21b37119145e7cf5e0bc38680f3044814adb27c`, schema 8. The runner resolves
and records both registry manifest digests before creating a VM, then checks
the same digest and source revision in the installed image and updater journal.

The initial host source is a Git archive of the baseline. Two fixture-only
selection changes are applied: the installer may enter signed bootstrap with
that local source tree, and discovery filters the normal tag listing to the
baseline tag. Repository identity, tag/commit validation, registry retrieval,
attestation verification, bootstrap, extraction and host orchestration remain
unchanged. No verified journal record is injected. The exact original discovery
component is restored before selecting the beta channel and requesting the update.

This tests the signed bootstrap with a deterministic source/tag selector. It
does not establish that an unmodified public installer can select an older tag.
The separate local `install.sh --release` change still needs its own publication
and end-to-end acceptance.

## Checks and evidence

The browser creates a synthetic administrator, project and nginx application
with a writable named volume and encrypted environment secret. It uses the real
terminal and update confirmation dialog. Existing accounts can be used to resume
a failed fixture, with new project, service and domain names on each attempt.

The guest verifies schema migration, retained installation key, secret decryption,
exact application file bytes and HTTP routing. It checks that the workload
container survives the control-plane update and that the pre-upgrade snapshot
remains at its original schema with unchanged manifest and file digests.

The security fixture runs real HTTP checks for project roles, database and volume
backups, Compose, API token scopes, membership changes, token/session revocation,
CSRF and administrator-only settings. It creates additional owned resources in
the disposable VM. The final VM restart checks the installed release, systemd
services, stored snapshot and application data again.

Safe JSON evidence is written to `artifacts/signed-update/`. Proof files contain
identities and hashes, never credentials or secret values. Normal cleanup deletes
only the VM created by the run and records its deletion. Set
`SERVUS_SIGNED_UPDATE_KEEP_FAILED=1` only while diagnosing a failure. It retains
the owned failed VM for inspection; delete that specific VM after the resumed
checks and record cleanup in the exported report.

Success here does not close post-migration candidate-failure recovery, interruption
at every capture/switch/start/restore boundary, corrupt-snapshot recovery refusal,
public ACME renewal or VPS database restore acceptance.
