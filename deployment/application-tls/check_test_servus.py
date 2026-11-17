#!/usr/bin/env python3
"""Check the public application certificate and its local renewal timer."""
import datetime
import http.client
import ssl
import subprocess
import sys

DOMAIN = 'test.servus.run'
MIN_REMAINING = datetime.timedelta(days=21)


def probe():
    conn = http.client.HTTPSConnection(DOMAIN, timeout=15, context=ssl.create_default_context())
    try:
        conn.connect()
        certificate = conn.sock.getpeercert()
        expiry = datetime.datetime.fromtimestamp(
            ssl.cert_time_to_seconds(certificate['notAfter']), datetime.timezone.utc
        )
        conn.request('GET', '/', headers={'User-Agent': 'servus-tls-monitor/1'})
        response = conn.getresponse()
        return expiry, response.status
    finally:
        conn.close()


def systemctl(*args):
    result = subprocess.run(['systemctl', *args], capture_output=True, text=True, timeout=10, check=False)
    return result.returncode, result.stdout.strip()


def check(now=None):
    errors = []
    now = now or datetime.datetime.now(datetime.timezone.utc)
    try:
        expiry, status = probe()
        if expiry - now < MIN_REMAINING:
            errors.append(f'Certificate expires at {expiry.isoformat()}, less than 21 days away')
        if status != 200:
            errors.append(f'Application returned HTTP {status}, expected 200')
    except (OSError, ValueError, KeyError, ssl.SSLError, http.client.HTTPException) as exc:
        errors.append(f'HTTPS certificate or application check failed: {exc}')

    try:
        if systemctl('is-enabled', '--quiet', 'servus-app-tls-renew.timer')[0] != 0:
            errors.append('Renewal timer is not enabled')
        if systemctl('is-active', '--quiet', 'servus-app-tls-renew.timer')[0] != 0:
            errors.append('Renewal timer is not active')
        code, result = systemctl('show', 'servus-app-tls-renew.service', '--property=Result', '--value')
        if code != 0 or result != 'success':
            errors.append(f'Last renewal service result is {result or "unavailable"}')
    except (OSError, subprocess.TimeoutExpired) as exc:
        errors.append(f'Could not inspect renewal service: {exc}')
    return errors


if __name__ == '__main__':
    problems = check()
    if problems:
        for problem in problems:
            print(f'ALERT {DOMAIN}: {problem}', file=sys.stderr)
        sys.exit(1)
    print(f'OK {DOMAIN}: HTTPS, certificate expiry and renewal service checks passed')
