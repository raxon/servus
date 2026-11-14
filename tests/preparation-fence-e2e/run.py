#!/usr/bin/python3 -I
"""Run a disposable preparation unit on a systemd Linux host."""
import importlib.util
import os
import pathlib
import shutil
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
OP = '12345678-1234-4123-8123-123456789abc'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if os.geteuid() != 0 or pathlib.Path('/proc/1/comm').read_text().strip() != 'systemd':
        raise RuntimeError('A disposable Linux host with root and systemd is required')
    with tempfile.TemporaryDirectory(prefix='servus-preparation-e2e-', dir='/run') as tmp:
        base = pathlib.Path(tmp); lib = base / 'lib'; lib.mkdir(mode=0o700)
        state = base / 'state'; state.mkdir(mode=0o700); (state / 'staging').mkdir(mode=0o700)
        for name in ('servus-updater.py', 'extract-install.py', 'verify-release.py'):
            shutil.copy(ROOT / 'apps/updater' / name, lib / name)
        runner = (ROOT / 'apps/updater/preparation-fence.py').read_text().replace("BASE = pathlib.Path('/usr/local/libexec/servus')", f'BASE = pathlib.Path({str(lib)!r})')
        (lib / 'preparation-fence.py').write_text(runner)
        marker = base / 'marker'
        (lib / 'prepare-verified.py').write_text("import os,subprocess,time\ndef prepare_claimed(journal, operation, stage, extractor, **kwargs):\n    journal.assert_preparation(operation)\n    child = subprocess.Popen(['/bin/sleep','90'], start_new_session=True)\n    open(" + repr(str(marker)) + ",'w').write(str(child.pid))\n    time.sleep(90)\n")
        updater = load('fixture_updater', lib / 'servus-updater.py')
        fence = load('fixture_fence', lib / 'preparation-fence.py')
        fence.RUNNER = lib / 'preparation-fence.py'
        journal = updater.Journal(state)
        unit = None; process = None
        try:
            journal.submit(OP, 'a'*40, 'sha256:'+'b'*64, 'v1.2.3')
            attempt = journal.claim(); journal.finish(attempt, 'verified', 'sha256:'+'c'*64)
            operation = journal.claim_preparation(OP)
            # A delayed unit must observe a revoked claim before executing work.
            journal.finish_preparation(operation)
            delayed = subprocess.run(fence.command(state, OP, operation['preparationId']), env=ENV, cwd='/',
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
            if delayed.returncode == 0 or marker.exists():
                raise AssertionError('Delayed unit ran after the durable claim was revoked')
            journal.db.execute("DELETE FROM preparations WHERE operation_id=?", (OP,))
            operation = journal.claim_preparation(OP)
            unit = fence.unit_name(operation['preparationId'])
            process = subprocess.Popen(fence.command(state, OP, operation['preparationId']), env=ENV, cwd='/',
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + 20
            while not marker.exists() and time.monotonic() < deadline:
                if process.poll() is not None: raise AssertionError('Unit did not start')
                time.sleep(0.05)
            if not marker.exists(): raise AssertionError('Unit did not start')
            child = int(marker.read_text())
            journal.finish_preparation(operation)
            subprocess.run(['/usr/bin/systemctl', 'stop', unit], env=ENV, cwd='/', check=True, timeout=20)
            process.wait(timeout=20)
            deadline = time.monotonic() + 5
            while pathlib.Path('/proc', str(child)).exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            if pathlib.Path('/proc', str(child)).exists():
                raise AssertionError('A descendant survived the stopped cgroup')
            if journal.preparation_status(OP)['status'] != 'recovery_required':
                raise AssertionError('Interrupted preparation did not remain blocked')
            # A successful worker cannot publish prepared before systemd exits.
            marker.unlink()
            release = base / 'release'
            (lib / 'prepare-verified.py').write_text("import subprocess,time\ndef prepare_claimed(journal,operation,stage,extractor,**kwargs):\n    probe=journal.record_extraction_probe(operation,'prepare')\n    journal.complete_extraction_probe(operation,probe)\n    journal.stage_preparation(operation,stage+'/servus-install-'+('d'*32))\n    child=subprocess.Popen(['/bin/sleep','90'],start_new_session=True)\n    open(" + repr(str(marker)) + ",'w').write(str(child.pid))\n    while not __import__('os').path.exists(" + repr(str(release)) + "): time.sleep(0.05)\n")
            journal.db.execute("DELETE FROM preparations WHERE operation_id=?", (OP,))
            operation = journal.claim_preparation(OP)
            unit = fence.unit_name(operation['preparationId'])
            def launch(item):
                return subprocess.Popen(fence.command(state, OP, item['preparationId']), env=ENV, cwd='/',
                                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            worker = updater.PreparationWorker(journal, state, launch)
            worker.tick()
            deadline = time.monotonic() + 20
            while not marker.exists() and time.monotonic() < deadline:
                if worker.process.poll() is not None: raise AssertionError('Successful unit did not start')
                time.sleep(0.05)
            if not marker.exists(): raise AssertionError('Successful unit did not stage')
            success_child = int(marker.read_text())
            worker.tick()
            if journal.preparation_status(OP)['status'] != 'preparing':
                raise AssertionError('Preparation published before the unit exited')
            release.touch()
            deadline = time.monotonic() + 20
            while worker.process is not None and time.monotonic() < deadline:
                worker.tick(); time.sleep(0.05)
            if worker.process is not None or journal.preparation_status(OP)['status'] != 'prepared':
                raise AssertionError('Preparation was not published after the unit exited')
            if pathlib.Path('/proc', str(success_child)).exists():
                raise AssertionError('A descendant survived successful unit completion')
            print('Delayed unit rejected; stopped cgroup killed detached descendant; success published after exit')
        finally:
            if unit:
                subprocess.run(['/usr/bin/systemctl', 'stop', unit], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
            if process and process.poll() is None:
                process.kill(); process.wait(timeout=5)
            journal.close()


if __name__ == '__main__':
    main()
