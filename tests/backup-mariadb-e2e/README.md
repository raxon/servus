# MariaDB control-plane capture test

Run `bash tests/backup-mariadb-e2e/run.sh`. The test requires macOS, Node.js 24, Docker, Colima and OpenSSL. The script creates and deletes its own randomly named Colima profile. It builds the panel from the current Git commit and copies the local `apps/updater/backup.py` into a test-only image.

The test creates a MariaDB service through the panel, writes a marker, stops the panel processes and captures their data. The stopped source volume is mounted read-write. SQLite opens the databases with `mode=ro`. A read-only volume mount failed with `sqlite3.OperationalError` in this fixture, but its exact cause was not established. The test then starts the panel on a restored control-plane volume, signs in, verifies the stored database credentials and redeploys MariaDB against its existing Swarm secret and volume. It authenticates both accounts and reads the marker.

The test uses synthetic credentials and a disposable Swarm. It does not prove that production writers are excluded or that application volumes are backed up. Updates and automatic recovery are not tested.

## Cleanup after a killed runner

The script prints `Disposable fixture profile: ...` and `Temporary build directory: ...` before creating its VM. Normal exit or handled signals remove both. A `SIGKILL` or host crash can leave them behind. First confirm the runner has stopped. Find the exact profile name in that run's output and check it against `colima list`. Do not choose a profile by prefix alone: another test run may still be using it.

After confirming the exact name, replace the example below with the name from that run and inspect the profile before removing it:

```sh
fixture_profile='servus-backup-e2e-0123456789abcdef'
colima list
colima status "$fixture_profile"
colima delete "$fixture_profile" --force --data
```

Find the exact temporary directory in the same run's output and inspect that directory before removing it. Delete only that directory. Do not use a wildcard or remove other Colima profiles, Docker contexts, or volumes.
