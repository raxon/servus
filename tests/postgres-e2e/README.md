# PostgreSQL end-to-end test

This test starts the API, worker and agent against a separate Colima Swarm. It creates a local administrator and a PostgreSQL service, kills the agent after its deployment target is recorded, and checks recovery, authentication and data retention. It leaves Docker resources in the test profile for inspection.

Use Node.js 24 or later, Docker, Colima and OpenSSL. Run these commands from the repository root on macOS. The profile must be new and disposable. Its contents will be deleted by the final command.

```bash
profile="servus-pg-e2e-$(openssl rand -hex 8)"
if test ! -e "$HOME/.colima/$profile" && test ! -L "$HOME/.colima/$profile"; then
  colima start "$profile" --activate=false --ssh-config=false --cpus 2 --memory 2 --disk 12 --mount none &&
  docker --context "colima-$profile" swarm init > /dev/null &&
  SERVUS_PG_E2E_PROFILE="$profile" ./node_modules/.bin/tsx tests/postgres-e2e/verify.ts &&
  colima delete "$profile" --force --data
else
  printf 'The profile already exists. Choose a new name.\n' >&2
fi
```

The script checks the profile name, Docker socket, manager identity, node count and absence of existing services, containers, volumes, secrets, configs and custom networks before starting the test. It does not delete the profile itself. If a command fails, inspect the disposable profile and delete it with the last command when finished.

The test covers recovery after recording a deployment target. It does not cover a crash before that point, migration of older databases or data loss caused by an external Docker operator.
