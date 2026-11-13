#!/usr/bin/env python3
"""OpenQoder's loopback-only web server, local router proxy, and autonomous workspace agent API."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, unquote
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from urllib.error import HTTPError, URLError
import argparse
import base64
import difflib
import fnmatch
import json
import mimetypes
import os
import re
import socket
import subprocess
import threading
import time
import webbrowser

ROOT = Path(__file__).resolve().parent
MAX_BODY = 20 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_TEXT_BYTES = 1024 * 1024
STATIC_EXTENSIONS = {'.html', '.css', '.js', '.svg', '.png', '.ico', '.woff', '.woff2'}
IMAGE_EXTENSIONS = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
}
IGNORED_DIRS = {'.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', '.cache'}


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


def resolve_workspace_root(raw_path):
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError('Select or enter a workspace folder path first.')
    root = Path(raw_path.strip()).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        raise ValueError(f'Workspace folder does not exist: {raw_path}')
    return root


def resolve_workspace_path(root, rel_path):
    if not isinstance(rel_path, str):
        raise ValueError('Path must be a string.')
    cleaned = rel_path.strip().replace('\\', '/')
    if not cleaned or cleaned == '.':
        return root, '.'
    candidate = (root / cleaned).resolve()
    if candidate != root and not candidate.is_relative_to(root):
        raise ValueError('Path escapes the active workspace folder.')
    rel = '.' if candidate == root else candidate.relative_to(root).as_posix()
    return candidate, rel


def collect_tree(root, start_dir, max_depth=4, max_entries=300):
    entries = []

    def walk(current_dir, depth):
        if len(entries) >= max_entries or depth > max_depth:
            return
        try:
            items = sorted(current_dir.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            return
        for item in items:
            if len(entries) >= max_entries:
                return
            name = item.name
            if name in IGNORED_DIRS or (name.startswith('.') and name not in ('.env.example', '.gitignore')):
                continue
            rel = item.relative_to(root).as_posix()
            is_dir = item.is_dir()
            entries.append({
                'path': rel,
                'name': name,
                'type': 'dir' if is_dir else 'file',
                'isImage': (not is_dir and item.suffix.lower() in IMAGE_EXTENSIONS),
            })
            if is_dir and depth < max_depth:
                walk(item, depth + 1)

    walk(start_dir, 1)
    return entries


def compute_diff(rel_path, old_text, new_text):
    old_lines = old_text.splitlines(keepends=True)
    new_lines = new_text.splitlines(keepends=True)
    diff_lines = list(difflib.unified_diff(
        old_lines,
        new_lines,
        fromfile=f'a/{rel_path}',
        tofile=f'b/{rel_path}',
        n=3,
    ))
    added = sum(1 for line in diff_lines if line.startswith('+') and not line.startswith('+++'))
    removed = sum(1 for line in diff_lines if line.startswith('-') and not line.startswith('---'))
    diff_text = ''.join(diff_lines)
    if len(diff_text) > 40000:
        diff_text = diff_text[:40000] + '\n... (diff truncated)\n'
    return added, removed, diff_text


def pick_directory_dialog():
    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError:
        return {'supported': False, 'error': 'Tkinter folder dialog is unavailable.'}

    result = {'path': None, 'error': None}

    def run():
        try:
            root = tk.Tk()
            root.withdraw()
            root.attributes('-topmost', True)
            selected = filedialog.askdirectory(title='Open OpenQoder Workspace Folder')
            root.destroy()
            result['path'] = selected or None
        except Exception as exc:
            result['error'] = str(exc)

    # Tkinter works best on main or dedicated STA thread on Windows
    t = threading.Thread(target=run)
    t.start()
    t.join(timeout=120)
    if result['error']:
        return {'supported': False, 'error': result['error']}
    return {'supported': True, 'path': result['path']}


class Handler(BaseHTTPRequestHandler):
    server_version = 'OpenQoder/2.0'

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

    def _read_json(self):
        if self.headers.get_content_type() != 'application/json':
            raise ValueError('Expected application/json.')
        size = int(self.headers.get('Content-Length', '0'))
        if size <= 0 or size > MAX_BODY:
            raise ValueError('Request body is empty or too large.')
        data = json.loads(self.rfile.read(size))
        if not isinstance(data, dict):
            raise ValueError('Expected a JSON object.')
        return data

    def _host_is_local(self):
        host = self.headers.get('Host', '')
        return host in (f'localhost:{self.server.server_port}', f'127.0.0.1:{self.server.server_port}')

    def _check_request(self):
        if not self._host_is_local():
            self._json(403, {'error': 'Invalid host.'})
            return False
        origin = self.headers.get('Origin')
        if origin and origin not in (
            f'http://localhost:{self.server.server_port}',
            f'http://127.0.0.1:{self.server.server_port}',
        ):
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
        mime = mimetypes.guess_type(candidate.name)[0] or 'application/octet-stream'
        if candidate.suffix.lower() in ('.html', '.css', '.js', '.svg'):
            mime = f'{mime}; charset=utf-8'
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def _handle_workspace(self, endpoint, data):
        if endpoint == '/api/workspace/pick':
            res = pick_directory_dialog()
            if not res.get('supported'):
                self._json(200, {'supported': False, 'error': res.get('error')})
                return
            picked = res.get('path')
            if not picked:
                self._json(200, {'supported': True, 'cancelled': True})
                return
            root = resolve_workspace_root(picked)
            entries = collect_tree(root, root)
            self._json(200, {'supported': True, 'root': str(root), 'name': root.name, 'entries': entries})
            return

        root = resolve_workspace_root(data.get('workspaceRoot'))

        if endpoint == '/api/workspace/info':
            subpath = data.get('path', '.')
            target, _ = resolve_workspace_path(root, subpath)
            if not target.is_dir():
                raise ValueError('Target path is not a directory.')
            max_depth = int(data.get('maxDepth', 4))
            max_depth = max(1, min(max_depth, 8))
            entries = collect_tree(root, target, max_depth=max_depth)
            self._json(200, {'ok': True, 'root': str(root), 'name': root.name, 'entries': entries})
            return

        if endpoint == '/api/workspace/read':
            target, rel = resolve_workspace_path(root, data.get('path', ''))
            if not target.is_file():
                raise ValueError(f'File not found: {rel}')
            ext = target.suffix.lower()
            if ext in IMAGE_EXTENSIONS:
                raw = target.read_bytes()
                if len(raw) > MAX_IMAGE_BYTES:
                    raise ValueError(f'Image exceeds 10 MB limit ({len(raw)} bytes).')
                mime = IMAGE_EXTENSIONS[ext]
                encoded = base64.b64encode(raw).decode('ascii')
                self._json(200, {
                    'ok': True,
                    'type': 'image',
                    'path': rel,
                    'mime': mime,
                    'size': len(raw),
                    'dataUrl': f'data:{mime};base64,{encoded}',
                })
                return

            size = target.stat().st_size
            if size > MAX_TEXT_BYTES:
                raise ValueError(f'File exceeds 1 MB text read limit ({size} bytes).')
            raw = target.read_bytes()
            if b'\x00' in raw[:8192]:
                raise ValueError(f'Cannot read binary file as text: {rel}')
            text = raw.decode('utf-8', errors='replace')
            lines = text.splitlines()
            total_lines = len(lines)
            start_line = data.get('startLine')
            end_line = data.get('endLine')
            s = max(1, int(start_line)) if start_line is not None else 1
            e = min(total_lines, int(end_line)) if end_line is not None else min(total_lines, s + 399)
            if total_lines == 0:
                snippet = ''
                s, e = 1, 0
            else:
                snippet = '\n'.join(f'{i}: {lines[i - 1]}' for i in range(s, e + 1))
            self._json(200, {
                'ok': True,
                'type': 'text',
                'path': rel,
                'totalLines': total_lines,
                'startLine': s,
                'endLine': e,
                'truncated': e < total_lines,
                'content': snippet,
            })
            return

        if endpoint == '/api/workspace/search':
            query = data.get('query', '')
            if not isinstance(query, str) or not query:
                raise ValueError('Search query is required.')
            glob_pat = data.get('glob') or '*'
            case_sensitive = bool(data.get('caseSensitive', False))
            flags = 0 if case_sensitive else re.IGNORECASE
            try:
                pattern = re.compile(query, flags) if data.get('regex') else re.compile(re.escape(query), flags)
            except re.error as exc:
                raise ValueError(f'Invalid regex pattern: {exc}')

            matches = []
            for entry in collect_tree(root, root, max_depth=6, max_entries=1000):
                if entry['type'] != 'file' or entry['isImage']:
                    continue
                if glob_pat != '*' and not fnmatch.fnmatch(entry['path'], glob_pat) and not fnmatch.fnmatch(entry['name'], glob_pat):
                    continue
                fpath = root / entry['path']
                try:
                    if fpath.stat().st_size > MAX_TEXT_BYTES:
                        continue
                    raw = fpath.read_bytes()
                    if b'\x00' in raw[:4096]:
                        continue
                    text = raw.decode('utf-8', errors='replace')
                except OSError:
                    continue
                for line_no, line in enumerate(text.splitlines(), 1):
                    if pattern.search(line):
                        matches.append({
                            'path': entry['path'],
                            'line': line_no,
                            'text': line[:240],
                        })
                        if len(matches) >= 80:
                            break
                if len(matches) >= 80:
                    break
            self._json(200, {'ok': True, 'matches': matches, 'truncated': len(matches) >= 80})
            return

        if endpoint == '/api/workspace/write':
            target, rel = resolve_workspace_path(root, data.get('path', ''))
            if rel == '.':
                raise ValueError('Specify a file path inside the workspace.')
            content = data.get('content')
            if not isinstance(content, str):
                raise ValueError('File content must be a string.')
            existed = target.exists()
            if existed and target.is_dir():
                raise ValueError(f'Target is a directory: {rel}')
            old_text = target.read_text(encoding='utf-8', errors='replace') if existed else ''
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding='utf-8')
            added, removed, diff_text = compute_diff(rel, old_text, content)
            self._json(200, {
                'ok': True,
                'path': rel,
                'existed': existed,
                'previousContent': old_text if existed and len(old_text) <= MAX_TEXT_BYTES else None,
                'added': added,
                'removed': removed,
                'diff': diff_text,
            })
            return

        if endpoint == '/api/workspace/edit':
            target, rel = resolve_workspace_path(root, data.get('path', ''))
            if not target.is_file():
                raise ValueError(f'File not found: {rel}')
            old_snippet = data.get('oldText')
            new_snippet = data.get('newText')
            if not isinstance(old_snippet, str) or not old_snippet or not isinstance(new_snippet, str):
                raise ValueError('Both oldText and newText strings are required.')
            old_text = target.read_text(encoding='utf-8', errors='replace')
            count = old_text.count(old_snippet)
            if count == 0:
                raise ValueError(f'Target text was not found in {rel}.')
            if count > 1:
                raise ValueError(f'Target text matched {count} times in {rel}; provide more surrounding context.')
            updated = old_text.replace(old_snippet, new_snippet, 1)
            target.write_text(updated, encoding='utf-8')
            added, removed, diff_text = compute_diff(rel, old_text, updated)
            self._json(200, {
                'ok': True,
                'path': rel,
                'existed': True,
                'previousContent': old_text if len(old_text) <= MAX_TEXT_BYTES else None,
                'added': added,
                'removed': removed,
                'diff': diff_text,
            })
            return

        if endpoint == '/api/workspace/delete':
            target, rel = resolve_workspace_path(root, data.get('path', ''))
            if not target.is_file():
                raise ValueError(f'File not found: {rel}')
            old_text = target.read_text(encoding='utf-8', errors='replace')
            target.unlink()
            added, removed, diff_text = compute_diff(rel, old_text, '')
            self._json(200, {
                'ok': True,
                'path': rel,
                'existed': True,
                'previousContent': old_text if len(old_text) <= MAX_TEXT_BYTES else None,
                'added': added,
                'removed': removed,
                'diff': diff_text,
            })
            return

        if endpoint == '/api/workspace/restore':
            snapshots = data.get('snapshots')
            if not isinstance(snapshots, list):
                raise ValueError('Snapshots list is required.')
            restored = []
            for snap in reversed(snapshots):
                if not isinstance(snap, dict):
                    continue
                target, rel = resolve_workspace_path(root, snap.get('path', ''))
                if snap.get('existed'):
                    prev = snap.get('previousContent')
                    if isinstance(prev, str):
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_text(prev, encoding='utf-8')
                        restored.append(rel)
                else:
                    if target.is_file():
                        target.unlink()
                        restored.append(rel)
            self._json(200, {'ok': True, 'restored': restored})
            return

        if endpoint == '/api/workspace/exec':
            command = data.get('command')
            if not isinstance(command, str) or not command.strip():
                raise ValueError('Command must be a non-empty string.')
            timeout = data.get('timeoutSeconds', 30)
            try:
                timeout = max(1, min(int(timeout), 120))
            except (TypeError, ValueError):
                timeout = 30
            start = time.monotonic()
            try:
                proc = subprocess.run(
                    command,
                    shell=True,
                    cwd=str(root),
                    capture_output=True,
                    text=True,
                    encoding='utf-8',
                    errors='replace',
                    timeout=timeout,
                )
                duration_ms = int((time.monotonic() - start) * 1000)
                stdout = proc.stdout or ''
                stderr = proc.stderr or ''
                if len(stdout) > 24000:
                    stdout = stdout[:24000] + '\n... (stdout truncated)'
                if len(stderr) > 12000:
                    stderr = stderr[:12000] + '\n... (stderr truncated)'
                self._json(200, {
                    'ok': True,
                    'command': command,
                    'cwd': str(root),
                    'exitCode': proc.returncode,
                    'stdout': stdout,
                    'stderr': stderr,
                    'timedOut': False,
                    'durationMs': duration_ms,
                })
            except subprocess.TimeoutExpired as exc:
                duration_ms = int((time.monotonic() - start) * 1000)
                self._json(200, {
                    'ok': True,
                    'command': command,
                    'cwd': str(root),
                    'exitCode': None,
                    'stdout': (exc.stdout or '')[:12000] if isinstance(exc.stdout, str) else '',
                    'stderr': (exc.stderr or '')[:12000] if isinstance(exc.stderr, str) else '',
                    'timedOut': True,
                    'durationMs': duration_ms,
                })
            return

        self._json(404, {'error': 'Unknown workspace endpoint.'})

    def do_POST(self):
        if not self._check_request():
            return
        try:
            data = self._read_json()
            if self.path.startswith('/api/workspace/'):
                self._handle_workspace(self.path, data)
                return

            if self.path not in ('/api/models', '/api/chat'):
                self._json(404, {'error': 'Unknown endpoint.'})
                return

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
                body_obj = {'model': model, 'messages': messages, 'stream': stream}
                tools = data.get('tools')
                if isinstance(tools, list) and tools:
                    body_obj['tools'] = tools
                    if data.get('tool_choice') is not None:
                        body_obj['tool_choice'] = data['tool_choice']
                payload = json.dumps(body_obj).encode('utf-8')
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
