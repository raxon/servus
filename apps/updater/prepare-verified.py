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


class PreparationError(Exception):
    """A prepared image could not be established safely."""


def prepare_verified(journal, operation_id, staging_parent, extractor):
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
    try:
        root_digest, config_digest = operation['digest'], operation['configDigest']
        if (not isinstance(root_digest, str) or not DIGEST.fullmatch(root_digest) or
                not isinstance(config_digest, str) or not DIGEST.fullmatch(config_digest)):
            raise PreparationError('Verified image identity is invalid')
        reference = IMAGE + '@' + root_digest
        # A timeout or interruption can leave daemon-side work in progress.
        # Journal recovery remains fail-closed until a coordinator reconciles it.
        extractor._docker('pull', '--platform=linux/amd64', reference, timeout=900, limit=4 * 1024 * 1024)
        raw = extractor._docker('image', 'inspect', '--platform=linux/amd64', '--format', '{{json .}}', reference)
        try:
            image = json.loads(raw)
        except (ValueError, UnicodeError, RecursionError) as error:
            raise PreparationError('Pulled image inspection failed') from error
        if not isinstance(image, dict):
            raise PreparationError('Pulled image inspection failed')
        image_id, references = image.get('Id'), image.get('RepoDigests')
        if (image_id not in (root_digest, config_digest) or not isinstance(references, list) or
                reference not in references or image.get('Os') != 'linux' or image.get('Architecture') != 'amd64'):
            raise PreparationError('Pulled image identity rejected')
        stage = extractor.extract(image_id, staging_parent)
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
