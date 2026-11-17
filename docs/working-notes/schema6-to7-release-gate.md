# Schema 6 to 7 release and recovery gate

Internal verification notes, 2026-11-17. This is an execution checklist, not a record of a completed signed upgrade.

## Evidence currently available

- `tests/signed-update-e2e/run.sh` creates a disposable systemd VM, installs through the public installer and checks a browser initiated update. Its defaults are 0.1.6 to 0.1.7. It checks account, session and project preservation, but does not inject a failed migration or restore a schema 6 snapshot.
- `tests/release-preparation-e2e/run.sh` verifies a real historical signed artifact and installer bundle. It does not test the current schema migration.
- `tests/updater/prepare-verified-docker-e2e.py` injects a synthetic verified journal row. Its Docker identity checks do not prove signature verification.
- The new `CaptureTest.test_standalone_v6_snapshot_remains_readable_and_migrates_only_its_copy` exercises a real schema 6 Store fixture, privileged quiescent capture, decryption after opening a copied snapshot as schema 7, and preservation of the original schema 6 snapshot. Its fresh Linux result must be recorded separately by the snapshot coordinator owner.

## Prerequisites before the full gate can run

1. Freeze the exact source revision and image config digest for the schema 6 baseline and schema 7 candidate. Record the platform, installation bundle inventory and dependency lockfile. A schema 6 database fixture alone does not provide a previous schema 6 executable.
2. Build and test both images locally. Do not use an arbitrary latest tag or the current public installer's default release as the baseline.
3. Select a new disposable systemd VM profile with an explicit run ID. Refuse an existing profile, occupied loopback port, default Docker context, or existing Servus installation. Do not reuse `panel-dev` or the HTTPS/Pebble fixture for host installation tests.
4. For the production signature path, provide two artifacts attested by the trusted GitHub release workflow, with matching tag, commit and immutable digest. `apps/updater/verify-release.py` pins that trust identity. An ephemeral local signature cannot satisfy it. Do not bypass `verify_release`, inject a verified row, alter the trusted workflow identity, or change the production registry to call the gate signed.

The local recovery mechanics can be tested before publication with local images and clearly marked synthetic verification. Closing the full signed release gate requires already authorized, trusted release artifacts. This checklist does not authorize publishing them.

## Isolated local recovery scenario

Adapt the disposable VM lifecycle and protected path checks from `tests/signed-update-e2e/run.sh`; prepare exact local images using `docker image save` / `docker image load` inside that VM. Use the real supervisor, maintenance admission, updater socket and snapshot coordinator rather than calling migration SQL directly.

1. Start the schema 6 baseline. Create an administrator, project and running image application with a named volume containing a random proof file. Configure a secret, API token, MFA recovery entry, database backup destination and Compose workload where supported by that baseline. Keep proof values private; record only digests, IDs and operation states.
2. Queue a normal update. Verify that runtime mutations stop being admitted, existing terminal/build/backup/Compose operations drain, and SQLite WAL checkpoints finish before capture. An active or uncertain journal must prevent capture.
3. Capture the standalone snapshot through the coordinator. Verify the manifest and protected ownership/modes. Record its manifest digest and schema version 6. Keep the snapshot immutable throughout migration and recovery.
4. Start the schema 7 candidate on a copied data directory. Confirm version 7, decrypt the original secret references, authenticate using the retained identity and check the original project, backup configuration and Compose ownership. Verify the application's named-volume proof and that the application continued serving during the control-plane transition.
5. Repeat from a fresh baseline and inject candidate failure after the migration transaction commits but before readiness. Recovery must keep writes fenced, stop the failed candidate, restore a new directory from the verified schema 6 snapshot, bind the baseline to that restored directory and verify readiness before reopening admission.
6. Restart the host coordinator at the capture, exchange, candidate startup and restoration boundaries. Retry the same operation ID. Require a single outcome and preserved journal ownership; conflicting IDs or a live process group must be refused.
7. Corrupt a copied manifest, encrypted secret, unexpected table and token hash in separate negative runs. Each must stop recovery before the protected live generation is replaced. Preserve the original snapshot and healthy application's volume.
8. Check the original snapshot is still schema 6 and its manifest digest is unchanged. Attempting to run the baseline directly against the migrated schema 7 directory must fail closed. An image rollback alone is not database recovery.
9. Remove only resources belonging to this run. Record fixture cleanup and the surviving application data proof before deleting the disposable VM.

## Full signed scenario after artifacts exist

Parameterize the existing signed runner with the frozen baseline/target release versions and baseline commit. First verify that its installer selects the intended baseline; the current runner's baseline variables only describe expected browser health and do not force the public installer to install that version.

Extend the runner to seed the data proof, assert schema versions and invoke the failure/recovery cases above. Keep the trusted verifier and signature checks intact. Run both successful update and post-migration candidate failure paths. Record the attested digest, matching source revision, platform, supervisor and updater operation IDs, snapshot manifest digest, before/after schema versions, decryption checks and application proof. Do not include cookies, recovery codes, private keys or secret values in artifacts.

Pass criteria: a trusted signed candidate upgrades successfully; the same trust path can recover from a committed migration with the baseline running against a verified restored schema 6 directory; workload data and identities survive; admission remains fenced whenever state is uncertain. A skipped signature check or mocked runtime leaves this gate open.
