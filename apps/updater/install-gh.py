#!/usr/bin/python3 -I
"""Install a pinned GitHub CLI for verifying Servus release attestations."""
import argparse
import hashlib
import importlib.util
import io
import os
import pathlib
import platform
import re
import secrets
import stat
import sys
import tarfile
import urllib.parse
import urllib.request

VERSION='2.104.0'
PINNED={
    'amd64':('98cb101ad87dbbd3f6b2f2bfcbd43197ccd07643140121d8a9cfaa91eadbc24e','fca7ac8a8386e3ad65c9a96a96cbf272d1dcc4f76de174dae91d54e50729e240',41083040),
    'arm64':('cb34cefc6f4e77b90731374a2b737516bb8f3033c6ca46aa949e5344f68069e3','f5ea822b80129fd841cce54df49f699e3a019dade3d70b48255807ca33a6eefa',38142112),
}
MAX_ARCHIVE=64*1024*1024
MAX_BINARY=64*1024*1024


class InstallError(Exception):
    pass


class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        if urllib.parse.urlsplit(newurl).scheme!='https':raise InstallError('Unsafe download redirect')
        return super().redirect_request(req,fp,code,msg,headers,newurl)


def download(arch):
    url=f'https://github.com/cli/cli/releases/download/v{VERSION}/gh_{VERSION}_linux_{arch}.tar.gz'
    request=urllib.request.Request(url,headers={'User-Agent':'servus-installer','Accept':'application/octet-stream'})
    opener=urllib.request.build_opener(HTTPSRedirect())
    with opener.open(request,timeout=90) as response:
        value=response.read(MAX_ARCHIVE+1)
    if len(value)>MAX_ARCHIVE:raise InstallError('CLI archive is too large')
    return value


def binary_from_archive(archive,arch,entry):
    archive_hash,binary_hash,size=entry
    if not isinstance(archive,bytes) or len(archive)>MAX_ARCHIVE or hashlib.sha256(archive).hexdigest()!=archive_hash:
        raise InstallError('CLI archive checksum mismatch')
    expected=f'gh_{VERSION}_linux_{arch}/bin/gh'
    with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as source:
        matches=[item for item in source.getmembers() if item.name==expected]
        if len(matches)!=1 or not matches[0].isfile() or matches[0].size!=size or size>MAX_BINARY:
            raise InstallError('Invalid CLI archive')
        stream=source.extractfile(matches[0])
        if stream is None:raise InstallError('CLI binary is unavailable')
        value=stream.read(MAX_BINARY+1)
    if len(value)!=size or hashlib.sha256(value).hexdigest()!=binary_hash:
        raise InstallError('CLI binary checksum mismatch')
    return value


def existing_binary(parent,expected,size):
    try:fd=os.open('gh',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
    except FileNotFoundError:return False
    try:
        before=os.fstat(fd);named=os.stat('gh',dir_fd=parent,follow_symlinks=False)
        if (not stat.S_ISREG(before.st_mode) or (before.st_uid,before.st_gid,stat.S_IMODE(before.st_mode),before.st_nlink)!=(0,0,0o755,1) or
            before.st_size!=size or (before.st_dev,before.st_ino)!=(named.st_dev,named.st_ino)):
            raise InstallError('Existing CLI is unsafe')
        digest=hashlib.sha256()
        while chunk:=os.read(fd,1024*1024):digest.update(chunk)
        after=os.fstat(fd)
        if ((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=
            (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or digest.hexdigest()!=expected):
            raise InstallError('Existing CLI differs')
        return True
    finally:os.close(fd)


def install(install_dir,host_dir,supervisor,policy,*,inherited_lock=None,arch=None,pinned=PINNED,fetch=download):
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated:raise InstallError('Isolated Linux root is required')
    arch=arch or {'x86_64':'amd64','aarch64':'arm64'}.get(platform.machine())
    if arch not in pinned:raise InstallError('Unsupported CLI architecture')
    entry=pinned[arch]
    if (not isinstance(entry,tuple) or len(entry)!=3 or not all(isinstance(value,str) and re.fullmatch(r'[a-f0-9]{64}',value) for value in entry[:2]) or
        type(entry[2]) is not int or not 0<entry[2]<=MAX_BINARY):raise InstallError('Invalid pinned CLI metadata')
    install_fd=supervisor._trusted_directory(install_dir,0o700);lock=host=bin_fd=None
    try:
        lock=policy._installation_lock(install_fd,supervisor,inherited_lock)
        host=supervisor._trusted_directory(host_dir,0o755)
        try:os.mkdir('bin',0o755,dir_fd=host)
        except FileExistsError:created=False
        else:created=True
        bin_fd=os.open('bin',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=host)
        if created:os.fchown(bin_fd,0,0);os.fchmod(bin_fd,0o755);os.fsync(bin_fd);os.fsync(host)
        info=os.fstat(bin_fd);named=os.stat('bin',dir_fd=host,follow_symlinks=False)
        if ((info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))!=(0,0,0o755) or
            (info.st_dev,info.st_ino)!=(named.st_dev,named.st_ino)):raise InstallError('Unsafe CLI directory')
        if existing_binary(bin_fd,entry[1],entry[2]):return
        data=binary_from_archive(fetch(arch),arch,entry)
        temporary='.gh-'+secrets.token_hex(16)
        fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o755,dir_fd=bin_fd)
        try:
            os.fchown(fd,0,0);os.fchmod(fd,0o755)
            with os.fdopen(fd,'wb',closefd=False) as target:target.write(data);target.flush();os.fsync(fd)
            try:os.link(temporary,'gh',src_dir_fd=bin_fd,dst_dir_fd=bin_fd,follow_symlinks=False)
            except FileExistsError:
                if not existing_binary(bin_fd,entry[1],entry[2]):raise InstallError('CLI publication failed')
            else:os.fsync(bin_fd)
        finally:os.close(fd);os.unlink(temporary,dir_fd=bin_fd);os.fsync(bin_fd)
    finally:
        for fd in (bin_fd,host,lock,install_fd):
            if fd is not None:os.close(fd)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--install-dir',default='/opt/servus');parser.add_argument('--install-lock-fd',type=int)
    args=parser.parse_args();os.umask(0o077)
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated:
        print('CLI installation requires isolated Linux root.',file=sys.stderr);return 1
    try:
        base=pathlib.Path(os.path.realpath(__file__)).parent;current=pathlib.Path('/')
        for part in base.parts[1:]:
            current/=part;info=current.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode & 0o022:raise InstallError('Untrusted module directory')
        path=base/'initial-generation.py';fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode),info.st_nlink)!=(0,0,0o644,1):raise InstallError('Untrusted module')
        finally:os.close(fd)
        spec=importlib.util.spec_from_file_location('servus_initial_generation',path)
        if not spec or not spec.loader:raise InstallError('Module unavailable')
        initial=importlib.util.module_from_spec(spec);spec.loader.exec_module(initial)
        supervisor,_,_,_,policy,_=initial.trusted_modules()
        install(args.install_dir,str(base),supervisor,policy,inherited_lock=args.install_lock_fd)
        return 0
    except Exception:
        print('GitHub CLI could not be installed safely.',file=sys.stderr);return 1


if __name__=='__main__':raise SystemExit(main())
