#!/usr/bin/env python3
"""OpenQoder's loopback-only web server and local router proxy."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, unquote
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from urllib.error import HTTPError, URLError
import argparse
import json
import mimetypes
import socket
import threading
import webbrowser

ROOT = Path(__file__).resolve().parent
MAX_BODY = 2 * 1024 * 1024
STATIC_EXTENSIONS = {'.html', '.css', '.js', '.svg', '.png', '.ico', '.woff', '.woff2'}

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

OPENER = build_opener(ProxyHandler({}), NoRedirect())

class LocalServer(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR can allow unrelated listeners on the same port.
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

def make_server(port):
    # Only the default port falls back; an explicitly requested port stays exact.
    candidates = range(8765, 8796) if port is None else (port,)
    for candidate in candidates:
        try:
            return LocalServer(('127.0.0.1', candidate), Handler)
        except OSError as exc:
            if port is not None or candidate == 8795 or exc.errno not in (48, 98, 10048):
                raise

def router_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError('Enter a valid local router URL.')
    try:
        parts = urlsplit(value.strip())
        port = parts.port
    except ValueError:
        raise ValueError('Enter a valid local router URL.')
    if (parts.scheme != 'http' or parts.hostname not in ('localhost', '127.0.0.1', '::1')
        or parts.username or parts.password or parts.query or parts.fragment
        or parts.path.rstrip('/') not in ('', '/v1') or not port or not 1 <= port <= 65535):
        raise ValueError('Use a local HTTP router URL such as http://localhost:20128/v1.')
    host = '[::1]' if parts.hostname == '::1' else parts.hostname
    return f'http://{host}:{port}/v1'

class Handler(BaseHTTPRequestHandler):
    server_version = 'OpenQoder/1.0'

    def log_message(self, format, *args):
        # Never log request bodies or keys.
        super().log_message(format, *args)

    def _json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(body)

    def _host_is_local(self):
        host = self.headers.get('Host', '')
        return host in (f'localhost:{self.server.server_port}', f'127.0.0.1:{self.server.server_port}')

    def _check_request(self):
        if not self._host_is_local():
            self._json(403, {'error': 'Invalid host.'})
            return False
        origin = self.headers.get('Origin')
        if origin and origin not in (f'http://localhost:{self.server.server_port}', f'http://127.0.0.1:{self.server.server_port}'):
            self._json(403, {'error': 'Invalid origin.'})
            return False
        return True

    def do_GET(self):
        if not self._check_request():
            return
        path = unquote(urlsplit(self.path).path)
        if path == '/':
            path = '/index.html'
        candidate = (ROOT / path.lstrip('/')).resolve()
        if not candidate.is_relative_to(ROOT) or candidate.suffix.lower() not in STATIC_EXTENSIONS or not candidate.is_file():
            self.send_error(404)
            return
        data = candidate.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', mimetypes.guess_type(candidate.name)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if not self._check_request():
            return
        if self.path not in ('/api/models', '/api/chat'):
            self._json(404, {'error': 'Unknown endpoint.'})
            return
        try:
            if self.headers.get_content_type() != 'application/json':
                raise ValueError('Expected application/json.')
            size = int(self.headers.get('Content-Length', '0'))
            if size <= 0 or size > MAX_BODY:
                raise ValueError('Request body is empty or too large.')
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict):
                raise ValueError('Expected a JSON object.')
            base = router_url(data.get('baseUrl'))
            key = data.get('apiKey', '')
            if not isinstance(key, str) or len(key) > 4096 or '\n' in key or '\r' in key:
                raise ValueError('Invalid API key.')
            headers = {'Accept': 'application/json', 'Content-Type': 'application/json'}
            if key:
                headers['Authorization'] = 'Bearer ' + key
            if self.path == '/api/models':
                request = Request(base + '/models', headers=headers)
            else:
                model, messages = data.get('model'), data.get('messages')
                if not isinstance(model, str) or not model.strip() or not isinstance(messages, list) or not messages:
                    raise ValueError('Select a model and enter a message.')
                if len(model) > 512:
                    raise ValueError('Invalid model identifier.')
                stream = data.get('stream') is True
                payload = json.dumps({'model': model, 'messages': messages, 'stream': stream}).encode('utf-8')
                request = Request(base + '/chat/completions', data=payload, headers=headers, method='POST')
            with OPENER.open(request, timeout=120) as upstream:
                self.send_response(upstream.status)
                self.send_header('Content-Type', upstream.headers.get('Content-Type', 'application/json'))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Connection', 'close')
                self.end_headers()
                self.close_connection = True
                while True:
                    chunk = upstream.read1(4096) if hasattr(upstream, 'read1') else upstream.read(4096)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except (ValueError, json.JSONDecodeError) as exc:
            self._json(400, {'error': str(exc)})
        except HTTPError as exc:
            body = exc.read(65536)
            try:
                error = json.loads(body)
            except (ValueError, UnicodeDecodeError):
                error = {'error': f'Router returned HTTP {exc.code}.'}
            self._json(exc.code, error)
        except (URLError, TimeoutError, socket.timeout, OSError) as exc:
            # Client disconnects during streaming cannot receive another response.
            if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
                return
            self._json(502, {'error': 'Could not reach the local router. Check that it is running and the URL is correct.'})

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Run OpenQoder locally')
    parser.add_argument('--port', type=int, help='Use this exact port (default: first available from 8765 to 8795)')
    parser.add_argument('--open', action='store_true', help='Open the app in your browser')
    args = parser.parse_args()
    server = make_server(args.port)
    print(f'OpenQoder is available at http://127.0.0.1:{server.server_port}', flush=True)
    if args.open:
        threading.Timer(0.5, webbrowser.open, args=(f'http://127.0.0.1:{server.server_port}',)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
