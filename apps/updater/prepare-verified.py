#!/usr/bin/python3 -I
"""Prepare a verified image for a future, separately authorized update.

A trusted root coordinator supplies the journal and the root-owned extraction
module. This module never starts services or applies the staged installation.
Interrupted work requires explicit reconciliation before any further operation.
"""
import json
import os
import re
import sys

DIGEST = re.compile(r'^sha256:[a-f0-9]{64}$')
IMAGE = 'ghcr.io/raxon/servus'
LEGACY_V015 = ('v0.1.5', '7c2013b081b4c26244a52c75b51e6ca2226c8a5a',
               'sha256:32f7cccf97841716ffae6bbff4f4234d5c3575e3b3ad9daa61dcf5afba72a13c')


class PreparationError(Exception):
    """A prepared image could not be established safely."""


def prepare_verified(journal, operation_id, staging_parent, extractor, *, resolve_child=None):
    """Stage installation files for a durable, previously verified operation.

    The caller must provide trusted journal and extractor instances loaded from
    root-owned installation files. Docker and the host kernel are trusted.
    No caller-controlled tag, image name, digest or attempt is accepted here.
    """
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        raise PreparationError('An isolated Linux root coordinator is required')
    try:
        directory = extractor._trusted_parent(staging_parent)
        os.close(directory)
    except (OSError, extractor.ExtractionError) as error:
        raise PreparationError('A private staging directory is required') from error
    operation = journal.claim_preparation(operation_id)
    return prepare_claimed(journal, operation, staging_parent, extractor, resolve_child=resolve_child)


def prepare_claimed(journal, operation, staging_parent, extractor, *, resolve_child=None, defer_commit=False):
    """Execute a durable claim established by the trusted host coordinator."""
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        raise PreparationError('An isolated Linux root coordinator is required')
    journal.assert_preparation(operation)
    try:
        directory = extractor._trusted_parent(staging_parent)
        os.close(directory)
    except (OSError, extractor.ExtractionError) as error:
        raise PreparationError('A private staging directory is required') from error
    try:
        root_digest, config_digest = operation['digest'], operation['configDigest']
        if (not isinstance(root_digest, str) or not DIGEST.fullmatch(root_digest) or
                not isinstance(config_digest, str) or not DIGEST.fullmatch(config_digest)):
            raise PreparationError('Verified image identity is invalid')
        reference = IMAGE + '@' + root_digest
        # A timeout or interruption can leave daemon-side work in progress.
        # Journal recovery remains fail-closed until a coordinator reconciles it.
        extractor._docker('pull', '--platform=linux/amd64', reference, timeout=900, limit=4 * 1024 * 1024)
        raw = extractor._docker('image', 'inspect', '--format', '{{json .}}', reference)
        selected_raw = extractor._docker('image', 'inspect', '--platform=linux/amd64', '--format', '{{json .}}', reference)
        try:
            image = json.loads(raw)
            selected = json.loads(selected_raw)
        except (ValueError, UnicodeError, RecursionError) as error:
            raise PreparationError('Pulled image inspection failed') from error
        if not isinstance(image, dict) or not isinstance(selected, dict):
            raise PreparationError('Pulled image inspection failed')
        image_id, references = image.get('Id'), image.get('RepoDigests')
        if (image_id not in (root_digest, config_digest) or not isinstance(references, list) or
                reference not in references or not isinstance(selected.get('Id'), str) or
                not DIGEST.fullmatch(selected['Id']) or selected.get('Os') != 'linux' or selected.get('Architecture') != 'amd64'):
            raise PreparationError('Pulled image identity rejected')
        selected_id = selected['Id']
        verified_ids = {root_digest, config_digest}
        if selected_id not in verified_ids:
            if resolve_child is None:
                raise PreparationError('Verified platform manifest is required')
            child = resolve_child(root_digest, config_digest)
            if not isinstance(child, str) or not DIGEST.fullmatch(child) or child != selected_id:
                raise PreparationError('Platform image identity rejected')
            verified_ids.add(child)
        probe_name = journal.record_extraction_probe(operation, 'prepare')
        artifact_format = ('legacy-v0.1.5' if (operation['tag'], operation['commit'], root_digest) == LEGACY_V015
                           else 'manifest-v1')
        stage = extractor.extract(image_id, staging_parent, verified_platform_ids=tuple(sorted(verified_ids - {image_id})),
                                  probe_name=probe_name, artifact_format=artifact_format)
        journal.complete_extraction_probe(operation, probe_name)
        if defer_commit:
            journal.stage_preparation(operation, stage)
        else:
            journal.finish_preparation(operation, stage)
        return stage
    except BaseException:
        # This also covers uncertain cleanup, timeouts and a lost journal race.
        # If even this write fails, the earlier preparing intent remains durable.
        try:
            journal.finish_preparation(operation)
        except BaseException:
            pass
        raise
