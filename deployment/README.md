# VPS installation

The default installer verifies and starts a published signed Servus image. An
explicit `--source` or `--ref` installation builds from source instead.

The intended public command is:

```sh
curl -fsSL https://servus.run/install.sh | sudo bash
```

The command becomes usable after the website serves the installer and the selected GitHub revision contains this monorepo. Preparing these files does not publish either endpoint.

## Requirements

Use a systemd VPS with Ubuntu 22.04, 24.04 or 26.04, or Debian 12 or 13, on amd64 or arm64. Run the script as root. Docker is installed from its official apt repository when absent. Existing Docker packages are retained, and an existing daemon must have the Compose plugin and the system socket at `/var/run/docker.sock`.

Allow time for verification and image download, or the source build when
selected. The installer creates a single-node Swarm on an inactive Docker daemon
and accepts an existing manager, but it refuses to take over a panel ingress
service or Compose project belonging to another installation. Use a fresh VPS
for the first install.

## Terminal wizard and network selection

When a terminal is available, the installer offers the current ports, custom
ports, help and cancellation. It reads `/dev/tty`, so the menu also works when
the script arrives through `curl | sudo bash`. Use `--interactive` to require
the wizard or `--non-interactive` (`--yes`) for automation. A dry run never asks
questions.

Before creating a Swarm, the installer lists the host's IPv4 addresses. It
selects a single address automatically and asks you to choose when several are
available. Docker bridges and link-local addresses are excluded. An existing
Swarm keeps its current configuration.

For a server with both public and private addresses, an automated installation
must select the address explicitly:

```sh
curl -fsSL https://raw.githubusercontent.com/raxon/servus/main/scripts/install.sh | \
  sudo bash -s -- --non-interactive --swarm-advertise-addr YOUR_SERVER_IPV4
```

After a successful installation, both signed bootstrap and source installation
print the panel origin, the SSH tunnel command, first-administrator instructions,
service status, recent-log commands and configuration paths. They never print
passwords, keys or session tokens.

## Install from a local checkout

From the monorepo root:

```sh
bash scripts/install.sh --dry-run --source "$PWD"
sudo bash scripts/install.sh --source "$PWD"
```

Dry run checks the platform, options and source layout. It writes no installation files and does not install packages.

By default, the management panel listens on `127.0.0.1:4180` on the VPS. Application HTTP ingress uses port 80 and is separate from the management panel. To select other ports:

```sh
sudo bash scripts/install.sh --source "$PWD" --port 4280 --ingress-port 28080
```

Both ports must be free for a first install. On rerun, keep the same ports and data directory. The installer accepts ports already held by its own API or ingress and leaves other listeners untouched.

Existing installations retain their configured bind address on rerun. An update does not automatically close a panel that was already exposed on all interfaces.

## First administrator

On your computer, forward the panel port over SSH. Keep this terminal open:

```sh
ssh -N -L 127.0.0.1:4180:127.0.0.1:4180 YOUR_USER@YOUR_SERVER
```

Open <http://127.0.0.1:4180> on your computer. On a new installation, create the first local administrator with an email address and a password of at least 8 characters. On a rerun, sign in with your existing account. If you selected another panel port, use that same port on both sides of the SSH tunnel and in the browser address.

Restrict network access to the panel until setup is complete. Anyone who can reach an unconfigured instance can create its first administrator account. Configure HTTPS before entering credentials over an untrusted network.

## Files and service management

The installer owns these paths:

| Path | Contents |
| --- | --- |
| `/opt/servus/releases/` | Source snapshots used for image builds |
| `/opt/servus/current` | Symlink to the last healthy installed source |
| `/etc/servus/servus.env` | Generated Compose settings, mode 0600 |
| `/var/lib/servus` | SQLite databases, local keys, agent socket and managed files |

API, worker and agent share the data directory. Only the agent mounts the Docker socket. The data path is identical inside the containers and on the host, so files mounted into application containers resolve to the expected host files.

Check services or logs:

```sh
sudo docker compose --env-file /etc/servus/servus.env \
  -f /opt/servus/current/deployment/compose.yaml -p servus ps

sudo docker compose --env-file /etc/servus/servus.env \
  -f /opt/servus/current/deployment/compose.yaml -p servus logs --tail=100
```

Custom installation, configuration and data paths can be set with `SERVUS_INSTALL_DIR`, `SERVUS_CONFIG_DIR` and `SERVUS_DATA_DIR`. Use separate absolute directories without symlink ancestors. Existing data ownership is left unchanged. The container processes use UID 1000, and the installer assigns that ownership when it creates a new data directory.

## Hostnames and HTTPS

`servus.run` serves the project website and installer. A customer installation uses its own IP address or panel hostname:

```sh
sudo bash scripts/install.sh --hostname panel.example.com
```

This sets the allowed HTTP origin. It does not create DNS records or certificates, and the panel still listens on localhost by default. Configure HTTPS before entering credentials over an untrusted network. The Cloudflare website deployment is separate from customer VPS installations.

If an HTTPS reverse proxy is already configured, specify its exact public origin:

```sh
curl -fsSL https://servus.run/install.sh | \
  sudo SERVUS_PUBLIC_URL=https://panel.example.com bash
```

An HTTPS origin enables secure session cookies. TLS still terminates at your reverse proxy, which can connect to the panel on `127.0.0.1:4180`. Keep the proxy inaccessible to others until the first administrator account has been created. The installer rejects a public bind on a first installation. On rerun, it keeps the existing bind address.

## Updates and failures

If a fresh signed installation stops after verification but before its first
generation starts, retain the reported operation ID. The updated host helper
supports an explicit recovery command:

```sh
sudo python3 -I /usr/local/libexec/servus/bootstrap-initial.py \
  --recover --operation THE_REPORTED_OPERATION_ID --ssh-host YOUR_SERVER_IPV4
```

Recovery checks the verified operation, approved policy, protected markers and
runtime state. It resumes a prepared handoff before any generation started, or
finalizes an already completed and authenticated healthy generation. Uncertain
starts remain blocked. Keep the markers and journal intact for investigation.
This command requires the updated host helper; older installations may need an
operator to install the reviewed helper changes first.

For a published revision, select a commit or tag with `--ref` or `SERVUS_REF`. The default is `main`.

```sh
curl -fsSL https://servus.run/install.sh | sudo bash -s -- --ref YOUR_RELEASE_TAG
```

A rerun builds a new image before changing the running containers. A failed source download or build leaves the existing environment and data in place. If the new panel fails to start or pass its readiness check, the installer reports the saved previous configuration path and requires manual recovery. It does not start the previous image or undo database migrations.

Source snapshots and old images are retained. Back up `/etc/servus`, `/var/lib/servus` and your application volumes before upgrading. The script never deletes application volumes or unrelated Docker resources.

## Verification

Run the installer tests without changing the host:

```sh
node --test tests/install/*.test.mjs
```

They cover platform and argument validation, path ownership, occupied ports, archive extraction, lock contention, and build failures with preserved configuration and database bytes. A real installation also needs a dedicated Linux VM test with Docker, followed by an administrator setup and runtime check.
