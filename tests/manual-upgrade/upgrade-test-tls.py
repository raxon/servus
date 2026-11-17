#!/usr/bin/python3 -I
"""HTTPS loopback fixture used only by the disposable CLI test VM."""
import socket
import ssl
import threading

context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain('/run/servus-upgrade-fixture/server.crt','/run/servus-upgrade-fixture/server.key')
listener=socket.socket();listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
listener.bind(('159.65.115.230',443));listener.listen(16)
def serve(raw):
    try:
        with context.wrap_socket(raw,server_side=True) as conn, socket.create_connection(('127.0.0.1',4180),timeout=5) as backend:
            conn.settimeout(10);request=b''
            while b'\r\n\r\n' not in request and len(request)<16384:request+=conn.recv(4096)
            backend.sendall(request)
            while chunk:=backend.recv(65536):conn.sendall(chunk)
    except (OSError,ssl.SSLError):pass
while True:
    sock,_=listener.accept();threading.Thread(target=serve,args=(sock,),daemon=True).start()
