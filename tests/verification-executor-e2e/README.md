# Verification executor end-to-end test

Run `bash tests/verification-executor-e2e/run.sh` from the repository root on an arm64 Mac with Colima, Docker, OpenSSL, curl and network access. The script downloads the official GitHub CLI v2.104.0 archive and checks its pinned SHA-256 before creating a disposable VM.

The VM runs the executor against the signed `v0.1.4` image. It checks a wrong commit, a non-root DynamicUser, the unit PATH, a polluted systemd manager environment and termination of a detached descendant after the verification timeout.

The helper then verifies the same image through its Unix socket, dedicated verifier group and per-attempt fence. The test also kills the helper while a test-only verifier is running, checks that recovery blocks retry, stops the test unit and verifies that the old nonce is revoked. Fixture-only diagnostic hooks log exception types and error codes without changing the helper's decisions.

The test removes the profile it creates on normal exit and on catchable signals. SIGKILL or a host crash can leave a profile named `servus-verify-e2e-<hex>` and a matching temporary directory. Inspect those resources before removing them. The test does not contact or modify the production VPS, apply an update or verify a backup.
