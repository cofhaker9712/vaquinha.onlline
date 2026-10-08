import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from api.pix.create import handler as pix_create_handler

ROOT = Path(__file__).resolve().parent


def load_local_env():
    env_file = ROOT / '.env'
    if not env_file.exists():
        return

    for raw_line in env_file.read_text(encoding='utf-8').splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        name, value = line.split('=', 1)
        os.environ.setdefault(name.strip(), value.strip().strip('"').strip("'"))


load_local_env()
PORT = int(os.environ.get('PORT', '3000'))


class StaticFileHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ('/', '/index.html'):
            file_path = ROOT / 'index.html'
            self.serve_file(file_path)
            return

        if parsed.path.startswith('/assets/'):
            file_path = ROOT / parsed.path.lstrip('/')
            if file_path.exists():
                self.serve_file(file_path)
                return

        self.send_error(404, 'Arquivo ou rota não encontrada.')

    def do_POST(self):
        if urlparse(self.path).path == '/api/pix/create':
            pix_create_handler.do_POST(self)
            return
        self.send_error(404, 'Arquivo ou rota não encontrada.')

    def serve_file(self, file_path):
        try:
            data = file_path.read_bytes()
            mime = 'text/html; charset=utf-8'
            if file_path.suffix == '.css':
                mime = 'text/css; charset=utf-8'
            elif file_path.suffix in ('.js', '.mjs'):
                mime = 'application/javascript; charset=utf-8'
            elif file_path.suffix == '.png':
                mime = 'image/png'
            elif file_path.suffix == '.jpg' or file_path.suffix == '.jpeg':
                mime = 'image/jpeg'
            elif file_path.suffix == '.svg':
                mime = 'image/svg+xml'

            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except FileNotFoundError:
            self.send_error(404, 'Arquivo não encontrado.')


def main():
    server = ThreadingHTTPServer(('0.0.0.0', PORT), StaticFileHandler)
    print(f'Servidor rodando em http://localhost:{PORT}')
    server.serve_forever()


if __name__ == '__main__':
    main()
