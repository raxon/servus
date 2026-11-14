import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
SCRIPT=ROOT/'scripts/push-tested-image.sh'
IMAGE='ghcr.io/raxon/servus'
IMAGE_ID='sha256:'+'a'*64
DIGEST='sha256:'+'b'*64


class PushTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        bindir=self.root/'bin';bindir.mkdir()
        docker=bindir/'docker'
        docker.write_text('''#!/bin/sh
if [ "$1" = image ] && [ "$2" = inspect ]; then
  if [ "${FAKE_CHANGED:-0}" = 1 ] && [ -f "$FAKE_STATE" ]; then printf 'sha256:%064d\\n' 0; else printf '%s\\n' "$FAKE_IMAGE_ID"; fi
  exit 0
fi
if [ "$1" = push ]; then
  n=0; [ ! -f "$FAKE_STATE" ] || n=$(cat "$FAKE_STATE")
  n=$((n+1)); printf '%s' "$n" > "$FAKE_STATE"
  if [ "$n" -le "${FAKE_FAILURES:-0}" ]; then printf 'unknown blob\\n' >&2; exit 1; fi
  if [ "${FAKE_NO_DIGEST:-0}" != 1 ]; then printf 'latest: digest: %s size: 123\\n' "$FAKE_DIGEST"; fi
  exit 0
fi
exit 9
''');docker.chmod(0o755)
        sleep=bindir/'sleep';sleep.write_text('#!/bin/sh\nexit 0\n');sleep.chmod(0o755)
        self.output=self.root/'output';self.output.touch()
        self.env={**os.environ,'PATH':str(bindir)+os.pathsep+os.environ['PATH'],'GITHUB_OUTPUT':str(self.output),
                  'FAKE_STATE':str(self.root/'count'),'FAKE_IMAGE_ID':IMAGE_ID,'FAKE_DIGEST':DIGEST}

    def tearDown(self):self.temp.cleanup()

    def run_push(self,**extra):
        return subprocess.run(['bash',str(SCRIPT),IMAGE,'v1.2.3',IMAGE_ID,str(self.root/'push.log')],
                              env={**self.env,**extra},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)

    def test_transient_failure_retries_and_outputs_only_successful_digest(self):
        result=self.run_push(FAKE_FAILURES='1')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual((self.root/'count').read_text(),'2')
        self.assertEqual(self.output.read_text(),'digest='+DIGEST+'\n')

    def test_tag_change_during_retry_is_rejected(self):
        result=self.run_push(FAKE_FAILURES='1',FAKE_CHANGED='1')
        self.assertNotEqual(result.returncode,0)
        self.assertEqual((self.root/'count').read_text(),'1')
        self.assertEqual(self.output.read_text(),'')

    def test_exhausted_or_digestless_push_never_publishes_output(self):
        result=self.run_push(FAKE_FAILURES='3')
        self.assertNotEqual(result.returncode,0);self.assertEqual((self.root/'count').read_text(),'3')
        self.assertEqual(self.output.read_text(),'')
        (self.root/'count').unlink()
        result=self.run_push(FAKE_NO_DIGEST='1')
        self.assertNotEqual(result.returncode,0);self.assertEqual(self.output.read_text(),'')


if __name__=='__main__':unittest.main()
