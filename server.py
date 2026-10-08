import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent


def load_env_file():
    env_path = ROOT / '.env'
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding='utf-8').splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file()

PORT = int(os.environ.get('PORT', '3000'))
APP_URL = os.environ.get('APP_URL', f'http://localhost:{PORT}')
FIREBOT_API_URL = os.environ.get('FIREBOT_API_URL', 'https://firebotbr.com/api/v1/pix/create')
FIREBOT_STATUS_URL = os.environ.get('FIREBOT_STATUS_URL', 'https://firebotbr.com/api/v1/pix/status')
FIREBOT_API_KEY = os.environ.get('FIREBOT_API_KEY', '')

DEDUP_TTL_SECONDS = 600
recent_operations = {}


def json_response(handler, status, payload):
    data = json.dumps(payload).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Access-Control-Allow-Origin', '*')
    handler.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    handler.send_header('Access-Control-Allow-Headers', 'Content-Type, x-api-key')
    handler.send_header('Content-Length', str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def parse_json_body(handler):
    length = int(handler.headers.get('Content-Length', '0'))
    raw = handler.rfile.read(length) if length else b''
    if not raw:
        return {}
    try:
        text = raw.decode('utf-8', errors='replace')
        return json.loads(text)
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}


def normalize_customer(payload):
    customer = payload.get('customer') or {}
    return {
        'name': str(customer.get('name') or 'Cliente').strip(),
        'email': str(customer.get('email') or 'contato@exemplo.com').strip(),
        'cpf': str(customer.get('cpf') or '').strip(),
        'phone': str(customer.get('phone') or '').strip(),
        'address': str(customer.get('address') or 'Endereço não informado').strip(),
    }


def dedupe_key(payload):
    normalized = normalize_customer(payload)
    text = f"{payload.get('amount')}-{payload.get('description')}-{normalized['cpf']}-{normalized['email']}-{normalized['phone']}"
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def normalize_firebot_response(response_body):
    if not isinstance(response_body, dict):
        return response_body
    if 'data' in response_body and isinstance(response_body['data'], dict):
        return response_body['data']
    return response_body


def call_firebot(url, payload):
    if not FIREBOT_API_KEY:
        raise RuntimeError('FIREBOT_API_KEY ausente. Configure a variável de ambiente FIREBOT_API_KEY.')

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'Origin': 'https://firebotbr.com',
            'Referer': 'https://firebotbr.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            'x-api-key': FIREBOT_API_KEY,
        },
        method='POST',
    )

    with urllib.request.urlopen(req, timeout=30) as response:
        body = response.read().decode('utf-8')
        if not body:
            return {'status': 'PENDING', 'message': 'Resposta vazia da FireBot.'}
        return normalize_firebot_response(json.loads(body))


def build_firebot_payload(data):
    customer = normalize_customer(data)
    amount = float(data.get('amount', 0) or 0)
    description = str(data.get('description') or 'Pagamento de apoio').strip() or 'Pagamento de apoio'

    if amount <= 0:
        raise ValueError('O valor do pagamento deve ser maior que zero.')
    if not customer['cpf']:
        raise ValueError('CPF do cliente é obrigatório para a cobrança FireBot.')
    if not customer['name']:
        raise ValueError('Nome do cliente é obrigatório para a cobrança FireBot.')
    if not customer['email']:
        raise ValueError('E-mail do cliente é obrigatório para a cobrança FireBot.')
    if not customer['phone']:
        raise ValueError('Telefone do cliente é obrigatório para a cobrança FireBot.')
    if not customer['address']:
        raise ValueError('Endereço do cliente é obrigatório para a cobrança FireBot.')

    return {
        'productType': 'DIGITAL',
        'storeUrl': str(data.get('storeUrl') or APP_URL),
        'amount': amount,
        'description': description,
        'customer': customer,
    }


def parse_status_result(payload):
    normalized = payload or {}
    if isinstance(normalized, dict):
        if 'status' in normalized:
            return normalized['status']
        if 'data' in normalized and isinstance(normalized['data'], dict) and 'status' in normalized['data']:
            return normalized['data']['status']
    return 'PENDING'


class PaymentHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, x-api-key')
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/api/health':
            json_response(self, 200, {'status': 'ok', 'firebotConfigured': bool(FIREBOT_API_KEY)})
            return

        if parsed.path in ('/', '/index.html'):
            file_path = ROOT / 'index.html'
            self.serve_file(file_path)
            return

        if parsed.path.startswith('/assets/'):
            file_path = ROOT / parsed.path.lstrip('/')
            if file_path.exists():
                self.serve_file(file_path)
                return

        json_response(self, 404, {'message': 'Arquivo ou rota não encontrada.'})

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == '/api/pix/create':
            payload = parse_json_body(self)
            try:
                firebot_payload = build_firebot_payload(payload)
                operation_key = dedupe_key(payload)
                current = recent_operations.get(operation_key)
                if current and (time.time() - current['created_at']) < DEDUP_TTL_SECONDS:
                    json_response(self, 200, {
                        'message': 'Cobrança já existente para esta operação.',
                        **current['response'],
                        'duplicate': True,
                    })
                    return

                response = call_firebot(FIREBOT_API_URL, firebot_payload)
                recent_operations[operation_key] = {
                    'created_at': time.time(),
                    'response': response,
                }

                status_value = str(parse_status_result(response)).upper()
                json_response(self, 200, {
                    'status': status_value,
                    'transactionId': response.get('transactionId') or response.get('id') or response.get('transaction_id'),
                    'pixCopiaECola': response.get('pixCopiaECola') or response.get('pix_copy_paste') or response.get('pixCopyPaste'),
                    'qrCodeUrl': response.get('qrCodeUrl') or response.get('qr_code_url') or response.get('qrCode'),
                    'amount': response.get('amount') or firebot_payload.get('amount'),
                    'pending': status_value in ('PENDING', 'PROCESSING'),
                    'message': 'Cobrança criada com sucesso.',
                })
                return
            except ValueError as exception:
                json_response(self, 400, {'message': str(exception)})
                return
            except RuntimeError as exception:
                json_response(self, 500, {'message': str(exception)})
                return
            except urllib.error.HTTPError as exc:
                error_body = exc.read().decode('utf-8', 'ignore')
                json_response(self, exc.code, {'message': 'Erro ao criar cobrança na FireBot.', 'details': error_body})
                return
            except Exception as exc:
                json_response(self, 500, {'message': 'Erro inesperado ao criar a cobrança.', 'details': str(exc)})
                return

        if parsed.path == '/api/pix/status':
            payload = parse_json_body(self)
            transaction_id = payload.get('transactionId') or payload.get('transaction_id') or payload.get('id')
            if not transaction_id:
                json_response(self, 400, {'message': 'transactionId obrigatório para consultar o status da cobrança.'})
                return

            try:
                status_url = os.environ.get('FIREBOT_STATUS_URL', 'https://firebotbr.com/api/v1/pix/status')
                response = call_firebot(status_url, {'transactionId': transaction_id})
                status_value = str(parse_status_result(response)).upper()
                json_response(self, 200, {
                    'status': status_value,
                    'transactionId': transaction_id,
                    'confirmed': status_value in ('PAID', 'APPROVED', 'CONFIRMED'),
                    'pending': status_value in ('PENDING', 'PROCESSING'),
                    'data': response,
                })
                return
            except RuntimeError as exception:
                json_response(self, 500, {'message': str(exception)})
                return
            except urllib.error.HTTPError as exc:
                error_body = exc.read().decode('utf-8', 'ignore')
                json_response(self, exc.code, {'message': 'Erro ao consultar status na FireBot.', 'details': error_body})
                return
            except Exception as exc:
                json_response(self, 500, {'message': 'Erro inesperado ao consultar status.', 'details': str(exc)})
                return

        json_response(self, 404, {'message': 'Rota de pagamento não encontrada.'})

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
            json_response(self, 404, {'message': 'Arquivo não encontrado.'})


def main():
    server = ThreadingHTTPServer(('0.0.0.0', PORT), PaymentHandler)
    print(f'Servidor rodando em http://localhost:{PORT}')
    print('Configure FIREBOT_API_KEY antes de usar a cobrança real da FireBot.')
    server.serve_forever()


if __name__ == '__main__':
    main()
