import copy
import importlib.util
import pathlib
import unittest

from test_verify_release import FakeRegistry, COMMIT, TAG, digest, packed, signed_result

PATH = pathlib.Path(__file__).resolve().parents[2] / 'apps/updater/verify-release.py'
spec = importlib.util.spec_from_file_location('image_id_verifier', PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Registry(FakeRegistry):
    def __init__(self, indexed=False):
        super().__init__()
        self.config = packed({'architecture': 'amd64', 'os': 'linux'})
        self.config_id = digest(self.config)
        self.child = packed({'schemaVersion': 2, 'mediaType': module.OCI_MANIFEST,
                             'config': {'mediaType': 'application/vnd.oci.image.config.v1+json',
                                        'digest': self.config_id, 'size': len(self.config)}})
        self.child_id = digest(self.child)
        self.image = (packed({'schemaVersion': 2, 'mediaType': module.OCI_INDEX,
                              'manifests': [{'mediaType': module.OCI_MANIFEST, 'digest': self.child_id,
                                             'size': len(self.child), 'platform': {'os': 'linux', 'architecture': 'amd64'}}]})
                      if indexed else self.child)
        self.image_digest = digest(self.image)
        self.artifact = packed({'schemaVersion': 2, 'mediaType': module.OCI_MANIFEST, 'artifactType': module.BUNDLE_MEDIA,
                                'subject': {'digest': self.image_digest, 'size': len(self.image), 'mediaType': module.OCI_INDEX if indexed else module.OCI_MANIFEST},
                                'layers': [{'mediaType': module.BUNDLE_MEDIA, 'digest': self.bundle_digest, 'size': len(self.bundle)}]})
        self.artifact_digest = digest(self.artifact)
        self.index = packed({'schemaVersion': 2, 'mediaType': module.OCI_INDEX,
                             'manifests': [{'mediaType': module.OCI_MANIFEST, 'artifactType': module.BUNDLE_MEDIA,
                                            'digest': self.artifact_digest, 'size': len(self.artifact)}]})
    def manifest(self, reference, limit=0):
        if reference == self.child_id: return self.child
        return super().manifest(reference, limit)
    def blob(self, reference):
        if reference == self.config_id: return self.config
        return super().blob(reference)


class ImageIdTests(unittest.TestCase):
    def test_id_follows_successful_attestation_for_single_and_multi_arch(self):
        for indexed in (False, True):
            registry = Registry(indexed)
            with self.subTest(indexed=indexed):
                result = module._verify_release(registry.image_digest, COMMIT, TAG, registry,
                    lambda *args: signed_result(registry.image_digest), include_config_digest=True)
                self.assertEqual(result['configDigest'], registry.config_id)

    def test_no_config_read_before_attestation(self):
        registry = Registry()
        reads = []
        original_blob = registry.blob
        def record_blob(reference):
            reads.append(reference)
            return original_blob(reference)
        registry.blob = record_blob
        with self.assertRaises(module.VerificationError):
            module._verify_release(registry.image_digest, COMMIT, TAG, registry, lambda *args: [], include_config_digest=True)
        self.assertNotIn(registry.config_id, reads)

    def test_rejects_ambiguous_platform_and_bad_descriptor(self):
        registry = Registry(True)
        image = module.decode_oci_json(registry.image)
        for mutate in (
            lambda x: x['manifests'].append(copy.deepcopy(x['manifests'][0])),
            lambda x: x['manifests'][0]['platform'].__setitem__('architecture', 'arm64'),
            lambda x: x['manifests'][0].__setitem__('size', 1),
            lambda x: x['manifests'][0].__setitem__('mediaType', module.OCI_INDEX),
        ):
            value = copy.deepcopy(image)
            mutate(value)
            with self.assertRaises(module.VerificationError): module.resolve_amd64_config_digest(registry, value)

    def test_rejects_bad_config_content_and_size(self):
        registry = Registry()
        image = module.decode_oci_json(registry.image)
        image['config']['size'] += 1
        with self.assertRaises(module.VerificationError): module.resolve_amd64_config_digest(registry, image)
        registry.config = packed({'os': 'linux', 'architecture': 'arm64'})
        registry.config_id = digest(registry.config)
        image['config']['digest'] = registry.config_id
        image['config']['size'] = len(registry.config)
        with self.assertRaises(module.VerificationError): module.resolve_amd64_config_digest(registry, image)

    def test_rejects_duplicate_json_keys(self):
        with self.assertRaises(module.VerificationError): module.decode_oci_json(b'{"os":"linux","os":"windows"}')
        with self.assertRaises(module.VerificationError): module.decode_oci_json(b'{"x":NaN}')

    def test_revalidation_binds_root_child_and_config(self):
        registry = Registry(True)
        self.assertEqual(module.revalidate_amd64_identity(registry, registry.image_digest, registry.config_id), registry.child_id)
        with self.assertRaises(module.VerificationError):
            module.revalidate_amd64_identity(registry, registry.image_digest, 'sha256:' + 'f'*64)
        original = registry.child
        registry.child = original + b' '
        with self.assertRaises(module.VerificationError):
            module.revalidate_amd64_identity(registry, registry.image_digest, registry.config_id)
        registry.child = original
        registry.config += b' '
        with self.assertRaises(module.VerificationError):
            module.revalidate_amd64_identity(registry, registry.image_digest, registry.config_id)
        direct = Registry(False)
        self.assertEqual(module.revalidate_amd64_identity(direct, direct.image_digest, direct.config_id), direct.image_digest)


if __name__ == '__main__':
    unittest.main()
