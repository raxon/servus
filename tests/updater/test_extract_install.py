import importlib.util
import io
import json
import os
import pathlib
import shutil
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

MODULE = pathlib.Path(__file__).resolve().parents[2] / 'apps/updater/extract-install.py'
spec = importlib.util.spec_from_file_location('servus_extract_install', MODULE)
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)


def make_archive(mutation=None):
    entries = []
    folders = set()
    for name, mode in extractor.FILES.items():
        parts = name.split('/')[:-1]
        for end in range(1, len(parts) + 1):
            folders.add('/'.join(parts[:end]))
    for name in ['.'] + sorted(folders):
        item = tarfile.TarInfo('./' + name if name != '.' else '.')
        item.type = tarfile.DIRTYPE
        item.mode = 0o755
        entries.append((item, b''))
    for name, mode in extractor.FILES.items():
        item = tarfile.TarInfo('./' + name)
        item.mode = mode
        data = ('fixture:' + name).encode()
        item.size = len(data)
        entries.append((item, data))
    if mutation:
        mutation(entries)
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w') as archive:
        for item, data in entries:
            archive.addfile(item, io.BytesIO(data) if item.isfile() else None)
    return out.getvalue()


class ArchiveTest(unittest.TestCase):
    def test_static_allowlist_matches_release_manifest(self):
        manifest = MODULE.parents[2] / 'scripts/release-install-files.txt'
        entries = {}
        for line in manifest.read_text().splitlines():
            mode, name = line.split(' ', 1)
            self.assertNotIn(name, entries)
            self.assertIn(mode, ('100644', '100755'))
            entries[name] = int(mode[-3:], 8)
        self.assertEqual(entries, extractor.FILES)

    def test_exact_archive_preserves_content(self):
        result = extractor._read_archive(make_archive())
        self.assertEqual(set(result), set(extractor.FILES))
        self.assertEqual(result['scripts/install.sh'], b'fixture:scripts/install.sh')

    def test_rejects_missing_duplicate_extra_and_traversal(self):
        def extra(name):
            def mutate(entries):
                item = tarfile.TarInfo(name)
                item.mode = 0o644
                entries.append((item, b''))
            return mutate
        for mutation in (lambda entries: entries.pop(), lambda entries: entries.append(entries[-1]),
                         extra('./unknown'), extra('../scripts/install.sh'), extra('/scripts/install.sh'),
                         extra('./apps/../scripts/install.sh'), extra('./apps//panel/package.json')):
            with self.subTest(mutation=mutation), self.assertRaises(extractor.ExtractionError):
                extractor._read_archive(make_archive(mutation))

    def test_rejects_link_modes_owner_pax_and_large_files(self):
        for change in (
            lambda item: setattr(item, 'type', tarfile.SYMTYPE),
            lambda item: setattr(item, 'type', tarfile.LNKTYPE),
            lambda item: setattr(item, 'mode', 0o777),
            lambda item: setattr(item, 'uid', 1000),
            lambda item: setattr(item, 'gid', 1000),
            lambda item: item.pax_headers.update({'comment': 'unexpected'}),
        ):
            with self.subTest(change=change), self.assertRaises(extractor.ExtractionError):
                extractor._read_archive(make_archive(lambda entries: change(entries[-1][0])))
        with mock.patch.object(extractor, 'MAX_FILE', 3):
            with self.assertRaises(extractor.ExtractionError):
                extractor._read_archive(make_archive())
        with mock.patch.object(extractor, 'MAX_ARCHIVE', 8):
            with self.assertRaises(extractor.ExtractionError):
                extractor._read_archive(make_archive())

    def test_rejects_truncated_archive(self):
        with self.assertRaises(extractor.ExtractionError):
            extractor._read_archive(make_archive()[:700])
        with self.assertRaises(extractor.ExtractionError):
            extractor._read_archive(make_archive() + b'x' * 512)


@unittest.skipUnless(os.geteuid() == 0, 'requires root-owned private staging')
class ExtractTest(unittest.TestCase):
    def setUp(self):
        self.parent = tempfile.mkdtemp(prefix='servus-extract-test-', dir='/run')
        os.chmod(self.parent, 0o700)
        self.image = 'sha256:' + 'a' * 64
        self.cid = 'b' * 64
        self.commands = []
    def tearDown(self):
        shutil.rmtree(self.parent)

    def docker(self, *args, **_kwargs):
        self.commands.append(args)
        if args[:2] == ('image', 'inspect'):
            return (json.dumps({'Id': self.image, 'Os': 'linux', 'Architecture': 'amd64', 'Config': {}}).encode()
                    if '{{json .}}' in args else (self.image + '\n').encode())
        if args[0] == 'create': return (self.cid + '\n').encode()
        if args[0] == 'inspect': return (self.image + ' created\n').encode()
        if args[0] == 'cp': return make_archive()
        if args[0] == 'rm': return b''
        raise AssertionError(args)

    def test_publishes_only_after_exact_probe_removed(self):
        with mock.patch.object(extractor, '_docker', side_effect=self.docker):
            result = extractor.extract(self.image, self.parent)
        self.assertEqual(pathlib.Path(result, 'scripts/install.sh').read_bytes(), b'fixture:scripts/install.sh')
        self.assertEqual(stat_mode(pathlib.Path(result, 'scripts/install.sh')), 0o755)
        self.assertEqual(self.commands[-1], ('rm', '-v', self.cid))
        self.assertNotIn('--platform=linux/amd64', self.commands[0])
        self.assertIn('--platform=linux/amd64', self.commands[1])
        self.assertIn('--network=none', self.commands[2])
        self.assertIn('--platform=linux/amd64', self.commands[2])
        self.assertIn('--pull=never', self.commands[2])
        self.assertEqual(self.commands[2][-1], self.image)
        self.assertFalse(any(args[0] in ('run', 'start') for args in self.commands))

    def test_bad_tar_and_inspect_cleanup_by_id(self):
        for failing in ('cp', 'inspect'):
            self.commands = []
            def broken(*args, **kwargs):
                if args[0] == failing:
                    self.commands.append(args)
                    return b'bad'
                return self.docker(*args, **kwargs)
            with self.subTest(failing=failing), mock.patch.object(extractor, '_docker', side_effect=broken):
                with self.assertRaises(extractor.ExtractionError):
                    extractor.extract(self.image, self.parent)
            self.assertEqual(self.commands[-1], ('rm', '-v', self.cid))
            self.assertEqual(os.listdir(self.parent), [])

    def test_rejects_extra_volumes_and_no_probe_created(self):
        def volumes(*args, **kwargs):
            if '{{json .}}' in args: return json.dumps({'Id':self.image,'Os':'linux','Architecture':'amd64','Config':{'Volumes':{'/data':{}}}}).encode()
            return self.docker(*args, **kwargs)
        with mock.patch.object(extractor, '_docker', side_effect=volumes):
            with self.assertRaises(extractor.ExtractionError): extractor.extract(self.image, self.parent)
        self.assertFalse(any(args[0] == 'create' for args in self.commands))

    def test_index_accepts_only_the_platform_selected_by_docker(self):
        child = 'sha256:' + 'c' * 64
        def index(*args, **kwargs):
            if args[:2] == ('image', 'inspect') and '{{json .}}' in args:
                return json.dumps({'Id':child,'Os':'linux','Architecture':'amd64','Config':{}}).encode()
            if args[0] == 'inspect': return (child + ' created\n').encode()
            return self.docker(*args, **kwargs)
        with mock.patch.object(extractor, '_docker', side_effect=index):
            result = extractor.extract(self.image, self.parent, verified_platform_ids=(child,))
        self.assertTrue(pathlib.Path(result).is_dir())
        shutil.rmtree(result)
        def foreign(*args, **kwargs):
            if args[0] == 'inspect': return ('sha256:' + 'd' * 64 + ' created\n').encode()
            return index(*args, **kwargs)
        with mock.patch.object(extractor, '_docker', side_effect=foreign), self.assertRaises(extractor.ExtractionError):
            extractor.extract(self.image, self.parent, verified_platform_ids=(child,))
        with mock.patch.object(extractor, '_docker', side_effect=index), self.assertRaises(extractor.ExtractionError):
            extractor.extract(self.image, self.parent)

    def test_fails_closed_if_probe_removal_fails(self):
        def bad_rm(*args, **kwargs):
            if args[0] == 'rm': raise extractor.ExtractionError('failed')
            return self.docker(*args, **kwargs)
        with mock.patch.object(extractor, '_docker', side_effect=bad_rm):
            with self.assertRaises(extractor.ExtractionError): extractor.extract(self.image, self.parent)
        self.assertEqual(os.listdir(self.parent), [])

    def test_rejects_invalid_id_and_insecure_parent(self):
        with self.assertRaises(extractor.ExtractionError): extractor.extract('image:latest', self.parent)
        os.chmod(self.parent, 0o777)
        with self.assertRaises(extractor.ExtractionError): extractor.extract(self.image, self.parent)

    def test_named_probe_is_labeled_and_verified_before_copy(self):
        name = 'servus-extract-' + 'e'*32
        def named(*args, **kwargs):
            if args[0] == 'inspect' and '{{json .}}' in args:
                return json.dumps({'Name':'/' + name,'Config':{'Labels':{'io.servus.updater.extraction':name}}}).encode()
            return self.docker(*args, **kwargs)
        with mock.patch.object(extractor, '_docker', side_effect=named):
            result = extractor.extract(self.image, self.parent, probe_name=name)
        created = next(item for item in self.commands if item[0] == 'create')
        self.assertIn(name, created)
        self.assertIn('io.servus.updater.extraction=' + name, created)
        shutil.rmtree(result)
        with self.assertRaises(extractor.ExtractionError): extractor.extract(self.image, self.parent, probe_name='not-a-probe')

    def test_rejects_untrusted_root_before_traversing_parent(self):
        actual_fstat = os.fstat
        for owner, mode in ((1000, 0o755), (0, 0o775), (0, 0o757)):
            calls = 0
            def root_fstat(fd):
                nonlocal calls
                calls += 1
                return SimpleNamespace(st_uid=owner, st_mode=mode) if calls == 1 else actual_fstat(fd)
            with self.subTest(owner=owner, mode=mode), mock.patch.object(extractor.os, 'fstat', side_effect=root_fstat):
                with self.assertRaises(extractor.ExtractionError):
                    extractor.extract(self.image, self.parent)
                self.assertEqual(calls, 1)

    @unittest.skipUnless(os.environ.get('SERVUS_EXTRACT_IMAGE_ID'), 'requires isolated Docker fixture')
    def test_real_docker_never_starts_probe(self):
        image = os.environ['SERVUS_EXTRACT_IMAGE_ID']
        result = extractor.extract(image, self.parent)
        self.assertEqual(set(str(p.relative_to(result)) for p in pathlib.Path(result).rglob('*') if p.is_file()), set(extractor.FILES))
        self.assertEqual(pathlib.Path(result, 'scripts/install.sh').read_bytes(), b'fixture:scripts/install.sh')


def stat_mode(path):
    return path.stat().st_mode & 0o7777


if __name__ == '__main__':
    unittest.main()
