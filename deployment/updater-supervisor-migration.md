# Supervisor data directory requirements (work in progress)

This document describes the current prototype. The update path is not ready for
production use.

The supervisor checks data directory permissions more strictly than the current
installer. Every ancestor must be owned by root and must not be writable by its
group or by others. The data directory itself must be owned by UID 1000 and must
not be group or world writable. Symlinks are rejected. The path must also stay
clear of critical host and application paths, including the configured install,
lifecycle, control and credential paths.

An existing custom path can fail these checks even if the installer accepted it.
The supervisor stops in that case. It does not change permissions or move data.
A trusted configuration loader and a verified migration workflow are still
needed before this supervisor can be used for updates.

Plan a separate maintenance migration for an affected installation. Preserve
the original data and verify a backup before copying. Stop every writer before
the copy, then verify the copied database and other files before changing the
installation configuration through a reviewed procedure. Keep the original
available for rollback until the migrated installation has been verified. Do
not change permissions or ownership on existing ancestors merely to pass the
check, because those directories may be shared with other software.
