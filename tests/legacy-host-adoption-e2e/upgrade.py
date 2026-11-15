#!/usr/bin/python3 -I
"""Update the disposable fixture through the real panel API."""
import http.cookiejar
import json
import sys
import time
import urllib.error
import urllib.request
import uuid

base='http://127.0.0.1:'+sys.argv[2];target='v'+sys.argv[1]
opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
csrf=None
def api(path,body=None):
    headers={'Origin':base,'Accept':'application/json'}
    if csrf:headers['X-CSRF-Token']=csrf
    if body is not None:headers['Content-Type']='application/json'
    request=urllib.request.Request(base+'/api/v1'+path,data=None if body is None else json.dumps(body).encode(),headers=headers)
    with opener.open(request,timeout=15) as response:return json.load(response)
login=api('/auth/login',{'email':'update-e2e@example.test','password':'update-e2e-password'});csrf=login['csrfToken']
deadline=time.monotonic()+1200
while time.monotonic()<deadline:
    result=api('/updates/discovery')['discovery']
    if result.get('status')=='candidate' and result.get('tag')==target:break
    time.sleep(10)
else:raise RuntimeError('Target release was not discovered')
operation=str(uuid.uuid4());api('/updates',{'operationId':operation,'tag':result['tag'],'commit':result['commit'],'digest':result['digest']})
while time.monotonic()<deadline:
    status=api('/updates/'+operation)['operation']['status']
    if status=='verified':break
    if status in ('verification_failed','recovery_required'):raise RuntimeError('Release verification failed: '+status)
    time.sleep(3)
else:raise RuntimeError('Release verification timed out')
while time.monotonic()<deadline:
    status=api('/updates/'+operation+'/prepare',{})['operation']['status']
    if status in ('prepared','completed'):break
    if status=='recovery_required':raise RuntimeError('Preparation requires recovery')
    time.sleep(10)
else:raise RuntimeError('Release preparation timed out')
api('/updates/'+operation+'/apply',{})
while time.monotonic()<deadline:
    try:
        status=api('/updates/'+operation+'/apply')['operation']['status']
        if status=='completed':break
        if status=='recovery_required':raise RuntimeError('Panel update requires recovery')
    except (urllib.error.URLError,TimeoutError,ConnectionError):pass
    time.sleep(5)
else:raise RuntimeError('Panel update timed out')
assert api('/health')['version']==sys.argv[1]
assert api('/auth/session')['user']['email']=='update-e2e@example.test'
assert any(item['name']=='update-e2e' for item in api('/projects'))
print('PASS signed panel update and retained account and project',flush=True)
