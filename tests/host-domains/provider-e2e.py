#!/usr/bin/env python3
"""Verify the release's generated routing and certificate with real Traefik."""
import hashlib,http.client,json,os,socket,ssl,subprocess,tempfile,time,uuid
from pathlib import Path
image=os.environ['SERVUS_HOST_IMAGE']
run_id=uuid.uuid4().hex
network='servus-host-test-'+run_id
host='abc123.host.servus.run'
containers=[]
def run(args,**kwargs):
    return subprocess.check_output(args,text=True,**kwargs).strip()
def docker(*args,**kwargs):return run(['docker',*args],**kwargs)
def inspect(name):return json.loads(docker('inspect',name))[0]
def port(name,number):return int(inspect(name)['NetworkSettings']['Ports'][str(number)+'/tcp'][0]['HostPort'])
with tempfile.TemporaryDirectory(prefix='servus-host-provider-') as temporary:
    root=Path(temporary)
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(root/'key.pem'),'-out',str(root/'cert.pem'),'-days','2','-subj','/CN='+host,'-addext','subjectAltName=DNS:'+host+',DNS:*.'+host],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    cert=(root/'cert.pem').read_text()
    expected=hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert)).hexdigest()
    program="""import {readFileSync} from 'node:fs';import{X509Certificate}from'node:crypto';import{installHostCertificateFiles}from'./dist/agent/host-domain.js';const certificate=readFileSync('/fixture/cert.pem','utf8');installHostCertificateFiles('/fixture',{hostname:'abc123.host.servus.run',certificate,privateKey:readFileSync('/fixture/key.pem','utf8'),expiresAt:new Date(new X509Certificate(certificate).validTo).toISOString(),staging:false});"""
    docker('run','--rm','--network','none','--user',str(os.getuid())+':'+str(os.getgid()),'--mount','type=bind,source='+temporary+',target=/fixture','--entrypoint','node',image,'--input-type=module','-e',program)
    try:
        docker('network','create','--label','servus.host-test='+run_id,network)
        backend='servus-host-backend-'+run_id
        containers.append(backend)
        docker('run','-d','--name',backend,'--label','servus.host-test='+run_id,'--network',network,'--network-alias','servus-panel-api','--entrypoint','node',image,'-e',"require('node:http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({status:'ok'}))}).listen(4180,'0.0.0.0')")
        ingress='servus-host-ingress-'+run_id
        containers.append(ingress)
        docker('run','-d','--name',ingress,'--label','servus.host-test='+run_id,'--network',network,'--mount','type=bind,source='+str(root/'host-domain')+',target=/servus-host,readonly','-p','127.0.0.1::8080','-p','127.0.0.1::8443','traefik:3.7.13','--providers.file.directory=/servus-host/dynamic','--providers.file.watch=true','--entrypoints.web.address=:8080','--entrypoints.websecure.address=:8443','--log.level=ERROR')
        context=ssl.create_default_context(cafile=str(root/'cert.pem'))
        error=None
        for attempt in range(30):
            try:
                with socket.create_connection(('127.0.0.1',port(ingress,8443)),timeout=3) as raw:
                    with context.wrap_socket(raw,server_hostname=host) as secure:
                        assert hashlib.sha256(secure.getpeercert(binary_form=True)).hexdigest()==expected
                        secure.sendall(('GET /api/v1/health HTTP/1.1\r\nHost: '+host+'\r\nConnection: close\r\n\r\n').encode())
                        response=http.client.HTTPResponse(secure);response.begin()
                        assert response.status==200
                        assert json.loads(response.read())=={'status':'ok'}
                break
            except (OSError,AssertionError,ValueError) as failure:
                error=failure
                if attempt==29:raise RuntimeError('Traefik did not load the generated host route and certificate') from error
                time.sleep(1)
        connection=http.client.HTTPConnection('127.0.0.1',port(ingress,8080),timeout=5)
        connection.request('GET','/api/v1/health',headers={'Host':host})
        response=connection.getresponse();assert response.status in (301,308);assert response.getheader('Location')=='https://'+host+'/api/v1/health';response.read();connection.close()
        print('PASS: real Traefik loaded generated provider file, exact TLS certificate, panel route and HTTPS redirect.')
    finally:
        for name in reversed(containers):
            try:
                if inspect(name)['Config']['Labels'].get('servus.host-test')==run_id:docker('rm','-f',name)
            except subprocess.CalledProcessError:pass
        try:
            if json.loads(docker('network','inspect',network))[0]['Labels'].get('servus.host-test')==run_id:docker('network','rm',network)
        except subprocess.CalledProcessError:pass
