"""Compare host-collected Servus control-plane state before a possible update.

This module has no CLI or filesystem, Docker, IPC, or database access.  A future
privileged supervisor must collect every input from trusted local sources, under
an installation-wide lock and with the required writer/startup fencing.  Values
received from an updater IPC request must never be used as these inputs.

A matching result is evidence of structural consistency only.  It is NOT update
approval, a verified image attestation, proof of quiescence, a complete writer
inventory, or a backup/restore guarantee.  Docker observations can change after
comparison, and Docker administrators are outside this function's trust scope.
Do not integrate this checker as an execution gate until those controls exist.
"""

from dataclasses import dataclass
import posixpath
import re
from typing import Mapping, Sequence

_HEX = re.compile(r'^[0-9a-f]{64}$')
_IMAGE = re.compile(r'^sha256:[0-9a-f]{64}$')
_REF = re.compile(r'^ghcr\.io/raxon/servus@sha256:[0-9a-f]{64}$')
_SERVICES = frozenset(('api', 'worker', 'agent'))


class InconsistentState(ValueError):
    """Raised without echoing attacker-controlled values or secrets."""


@dataclass(frozen=True)
class ExpectedMount:
    kind: str
    source: str
    destination: str
    writable: bool


@dataclass(frozen=True)
class ExpectedService:
    config_hash: str
    mounts: tuple[ExpectedMount, ...]
    health_required: bool
    environment: Mapping[str, str]


@dataclass(frozen=True)
class ExpectedState:
    """Values must come from protected local configuration, not IPC payloads."""
    registry_reference: str
    image_id: str
    data_dir: str
    services: Mapping[str, ExpectedService]


def _fail():
    raise InconsistentState('The installation state could not be verified')


def _mount_key(kind, source, destination, writable):
    if kind not in ('bind', 'volume') or not isinstance(source, str) or not source or not isinstance(destination, str) or not destination.startswith('/') or type(writable) is not bool:
        _fail()
    return (kind, source, destination, writable)


def compare_fixture(expected: ExpectedState, image: Mapping, containers: Sequence[Mapping],
                    jobs: Sequence[str], agent_operations: Sequence[str]) -> None:
    """Reject mismatches in a normalized, fixture-compatible Docker inspection.

    The caller supplies the image inspection for `registry_reference`, the full
    set of relevant Compose container inspections, and complete status lists
    collected from both durable journals.  No list may be filtered to merely
    active entries, because unknown future states must fail closed.  The function
    compares the complete effective Config.Env but never emits its values.
    Expected environment must be derived by a trusted collector from the
    pinned image and protected Compose configuration, not a request.
    Even when it returns normally,
    callers must not infer that writes are fenced or an update is safe.
    """
    if not isinstance(expected, ExpectedState) or not isinstance(expected.registry_reference, str) or not _REF.fullmatch(expected.registry_reference) or not isinstance(expected.image_id, str) or not _IMAGE.fullmatch(expected.image_id):
        _fail()
    data_dir = expected.data_dir
    if not isinstance(data_dir, str) or not re.fullmatch(r'/[A-Za-z0-9._/-]+', data_dir) or data_dir == '/' or '..' in data_dir or data_dir.endswith('/') or posixpath.normpath(data_dir) != data_dir or data_dir == '/var/run/docker.sock':
        _fail()
    if not isinstance(expected.services, Mapping) or set(expected.services) != _SERVICES:
        _fail()
    if not isinstance(image, Mapping) or image.get('Id') != expected.image_id:
        _fail()
    repo_digests = image.get('RepoDigests')
    if not isinstance(repo_digests, list) or not all(isinstance(item, str) for item in repo_digests) or expected.registry_reference not in repo_digests:
        _fail()
    if not isinstance(containers, (tuple, list)) or len(containers) != len(_SERVICES):
        _fail()
    seen = set()
    container_ids = set()
    for container in containers:
        if not isinstance(container, Mapping):
            _fail()
        config, state, mounts = container.get('Config'), container.get('State'), container.get('Mounts')
        if not isinstance(config, Mapping) or not isinstance(state, Mapping) or not isinstance(mounts, list):
            _fail()
        labels = config.get('Labels')
        if not isinstance(labels, Mapping) or labels.get('com.docker.compose.project') != 'servus':
            _fail()
        service = labels.get('com.docker.compose.service')
        if not isinstance(service, str) or service not in _SERVICES or service in seen or labels.get('com.docker.compose.container-number') != '1' or labels.get('com.docker.compose.oneoff') != 'False':
            _fail()
        seen.add(service)
        container_id = container.get('Id')
        if not isinstance(container_id, str) or not _HEX.fullmatch(container_id) or container_id in container_ids:
            _fail()
        container_ids.add(container_id)
        policy = expected.services[service]
        if not isinstance(policy, ExpectedService) or not isinstance(policy.config_hash, str) or not _HEX.fullmatch(policy.config_hash) or labels.get('com.docker.compose.config-hash') != policy.config_hash:
            _fail()
        if container.get('Image') != expected.image_id or config.get('Image') != expected.registry_reference:
            _fail()
        if config.get('Cmd') != ['node', 'dist/' + ('server' if service == 'api' else service) + '/index.js'] or config.get('Entrypoint') != ['docker-entrypoint.sh'] or config.get('WorkingDir') != '/app' or config.get('User') != 'node':
            _fail()
        env = config.get('Env')
        if not isinstance(env, list) or not isinstance(policy.environment, Mapping) or not all(isinstance(entry, str) and '=' in entry for entry in env):
            _fail()
        env_map = {}
        for entry in env:
            key, value = entry.split('=', 1)
            if not key or key in env_map:
                _fail()
            env_map[key] = value
        if env_map != policy.environment or env_map.get('PANEL_DATA_DIR') != data_dir:
            _fail()
        if state.get('Status') != 'running' or state.get('Running') is not True or state.get('Paused') is not False or state.get('Restarting') is not False or state.get('Dead') is not False:
            _fail()
        if type(policy.health_required) is not bool or (service in ('api', 'agent') and not policy.health_required):
            _fail()
        health = state.get('Health')
        if policy.health_required and (not isinstance(health, Mapping) or health.get('Status') != 'healthy'):
            _fail()
        if health is not None and (not isinstance(health, Mapping) or health.get('Status') not in ('healthy',)):
            _fail()
        if not isinstance(policy.mounts, tuple):
            _fail()
        expected_mounts = []
        for mount in policy.mounts:
            if not isinstance(mount, ExpectedMount):
                _fail()
            expected_mounts.append(_mount_key(mount.kind, mount.source, mount.destination, mount.writable))
        required_mounts = {('bind', data_dir, data_dir, True)}
        if service == 'agent':
            required_mounts.add(('bind', '/var/run/docker.sock', '/var/run/docker.sock', True))
        if set(expected_mounts) != required_mounts:
            _fail()
        actual_mounts = []
        for mount in mounts:
            if not isinstance(mount, Mapping):
                _fail()
            actual_mounts.append(_mount_key(mount.get('Type'), mount.get('Source'), mount.get('Destination'), mount.get('RW')))
        if len(set(expected_mounts)) != len(expected_mounts) or len(set(actual_mounts)) != len(actual_mounts) or set(expected_mounts) != set(actual_mounts):
            _fail()
    if seen != _SERVICES:
        _fail()
    # Every row must be present; a trusted adapter is responsible for proving
    # query completeness. Failed rows also block until a future recovery protocol
    # proves their effects reconciled; terminal failure alone is not proof.
    for statuses in (jobs, agent_operations):
        if not isinstance(statuses, (list, tuple)) or any(status != 'succeeded' for status in statuses):
            _fail()
