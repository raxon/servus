# Schema 7 to 8 release gate - internal notes

Schema 8 is a protocol barrier for Redis restore. The panel table layout stays
the same as schema 7. A committed Redis restore now changes the database volume
through the agent's restore binding. Older agents cannot interpret that binding
and could otherwise redeploy the service using its original volume.

The current Store migrates 7 to 8 in a transaction. Current service-purpose and
database-root secret readers accept 8, while the frozen schema 7 readers reject
it. `tests/integration/schema-compatibility.mjs` checks the actual previous
executable, whose image ID is pinned in the fixture, against a disposable schema
8 database. The fixture reopens the same database with the new Store and removes
only its own volume.

The snapshot primitive accepts schemas 4-8. A schema 7 snapshot is checked without
migration, and only a separate restored copy is opened and migrated by Store.
For Redis, capture rejects unfinished switch/rollback plans. Completed restores
must have a matching encrypted recovery plan. The validator checks its service,
operation, runtime ownership and source/candidate volume identities.

The isolated Linux backup suite currently has 92 tests. No test was skipped in
the recorded schema 8 run. This is capture/validation evidence, not signed-release
upgrade acceptance.

The next installer revision adds `--release vMAJOR.MINOR.PATCH` for fresh signed
installations. Discovery resolves exactly that tag, commit and registry manifest,
without falling back to a newer tag. The bridge also rejects a candidate whose
tag differs from the request, before provisioning the host. Signature verification
still belongs to the unchanged protected bootstrap verifier. The host-safe
installer suite passed all 53 tests, the discovery suite passed all 18 tests, and
the isolated Linux bootstrap bridge passed exact-selection and mismatch checks.

The signed-update fixture uses a frozen v0.1.52 host source and filters its normal
discovery to that tag before updating to v0.1.53. A fixture-only installer branch
allows signed bootstrap from this frozen source. The production verifier,
bootstrap and downloaded release artifacts remain unchanged, and original
discovery is restored before the update. This avoids depending on publication of
the separate `--release` feature. Both registry digests are resolved before VM
creation. See `tests/signed-update-e2e/README.md` for the exact scope and cleanup.
These fixture changes are local follow-up work outside the v0.1.53 release commit.
A passing result must still be recorded, along with separate evidence for the
post-migration recovery and interruption scenarios below.

Before a stable release, run the signed installer/updater path from the actual
published baseline to the final candidate and record its database schema rather
than assuming schema 7. The published v0.1.52 Store accepts schemas through 5;
the frozen local schema 7 fixture is separate compatibility evidence. Test failure
recovery using the pre-upgrade snapshot. Replacing only the image with schema 7 code after schema 8 has opened
the data is unsupported. Preserve the complete database, vault key and encrypted
files together, and keep application database contents outside panel snapshot
rollback semantics.

The full P0-P3 parity goal remains open. The standalone installation backup has
administrator API authorization, a protected host queue, Settings controls and
explicit root recovery for interrupted operations. Earlier frozen-runtime host
fixtures passed capture/restart/isolated restore and recovery of an unverified
capture. The current-code host fixture also passed capability, cancellation,
capture/restart and isolated restore. A wider interruption matrix remains open,
along with history, retention and signed-release acceptance. See
`installation-backup-acceptance.md` for evidence and outstanding checks.
