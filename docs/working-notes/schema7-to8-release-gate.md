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

Before releasing, run the signed installer/updater path from a published schema
7 image to the final candidate and test failure recovery using the pre-upgrade
snapshot. Replacing only the image with schema 7 code after schema 8 has opened
the data is unsupported. Preserve the complete database, vault key and encrypted
files together, and keep application database contents outside panel snapshot
rollback semantics.

The full P0-P3 parity goal remains open. The standalone installation backup has
administrator API authorization, a protected host queue, Settings controls and
explicit root recovery for interrupted operations. Earlier frozen-runtime host
fixtures passed capture/restart/isolated restore and recovery of an unverified
capture. Current-code reproduction and a wider interruption matrix remain open,
along with history, retention and signed-release acceptance. See
`installation-backup-acceptance.md` for evidence and outstanding checks.
