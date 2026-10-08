import json
import logging
import os
import re
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse

FIREBOT_API_URL = 'https://firebotbr.com/api/v1/pix/create'
ALLOWED_AMOUNTS = frozenset({
    5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 100,
})


def send_json(handler, status, payload):
    body = json.dumps(payload).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('Content-Length', str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def is_json_content_type(content_type):
    media_type = content_type.split(';', 1)[0].strip().lower()
    return media_type == 'application/json' or media_type.endswith('+json')


def safe_error_body(body, api_key, customer=None):
    message = body.decode('utf-8', errors='replace')
    sensitive_values = [api_key] if api_key else []
    if customer:
        sensitive_values.extend(customer.values())
    for value in sensitive_values:
        if value:
            message = message.replace(value, '[REDACTED]')
    return message


def redact_sensitive_text(value, api_key, customer):
    message = str(value or '')
    sensitive_values = [api_key, *customer.values()]
    for sensitive_value in sensitive_values:
        if sensitive_value:
            message = message.replace(sensitive_value, '[REDACTED]')
    return message


def gateway_response_message(body, content_type, api_key, customer):
    if is_json_content_type(content_type):
        try:
            payload = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            payload = None
        if isinstance(payload, dict):
            if isinstance(payload.get('data'), dict):
                payload = payload['data']
            for field in ('message', 'error', 'detail', 'errors'):
                value = payload.get(field)
                if value:
                    if not isinstance(value, str):
                        value = json.dumps(value, ensure_ascii=False)
                    return redact_sensitive_text(value, api_key, customer)[:2000]

    text = body.decode('utf-8', errors='replace').strip()
    return redact_sensitive_text(text, api_key, customer)[:2000]


def relevant_response_headers(headers):
    relevant_names = {
        'content-type',
        'date',
        'retry-after',
        'x-request-id',
        'request-id',
    }
    return {
        name: value
        for name, value in headers.items()
        if name.lower() in relevant_names
    }


def log_gateway_response(status, headers, body, api_key, customer):
    logging.error(
        'FireBot response status=%s headers=%s body=%s',
        status,
        relevant_response_headers(headers),
        safe_error_body(body, api_key, customer),
    )


def is_valid_cpf(cpf):
    if len(cpf) != 11 or len(set(cpf)) == 1:
        return False

    digits = [int(digit) for digit in cpf]
    first_check = (sum(
        digit * weight
        for digit, weight in zip(digits[:9], range(10, 1, -1))
    ) * 10) % 11
    first_check = 0 if first_check == 10 else first_check
    if digits[9] != first_check:
        return False

    second_check = (sum(
        digit * weight
        for digit, weight in zip(digits[:10], range(11, 1, -1))
    ) * 10) % 11
    second_check = 0 if second_check == 10 else second_check
    return digits[10] == second_check


def normalize_response(payload):
    if isinstance(payload, dict) and isinstance(payload.get('data'), dict):
        payload = payload['data']
    if not isinstance(payload, dict):
        return {}

    pix_code = (
        payload.get('pixCopiaECola')
        or payload.get('pix_copy_paste')
        or payload.get('pixCopyPaste')
    )
    transaction_id = (
        payload.get('transactionId')
        or payload.get('id')
        or payload.get('transaction_id')
    )
    qr_code_url = (
        payload.get('qrCodeUrl')
        or payload.get('qr_code_url')
        or payload.get('qrCode')
    )
    if qr_code_url:
        parsed_qr_url = urlparse(str(qr_code_url))
        if parsed_qr_url.scheme != 'https' or not parsed_qr_url.netloc:
            qr_code_url = None

    return {
        'pixCopiaECola': str(pix_code or '').strip(),
        'transactionId': str(transaction_id or '').strip(),
        'qrCodeUrl': qr_code_url,
        'status': str(payload.get('status') or 'PENDING').strip(),
    }


def get_store_url(handler, requested_url):
    configured_url = (
        os.environ.get('APP_URL')
        or os.environ.get('VERCEL_PROJECT_PRODUCTION_URL')
        or os.environ.get('VERCEL_URL')
        or requested_url
        or handler.headers.get('Origin', '')
    ).strip()
    if configured_url and '://' not in configured_url:
        configured_url = 'https://' + configured_url

    parsed_url = urlparse(configured_url)
    if (
        parsed_url.scheme != 'https'
        or not parsed_url.hostname
        or parsed_url.username
        or parsed_url.password
    ):
        return None
    return configured_url


def gateway_error_message(status):
    if status in (401, 403):
        return 'O serviço de pagamento está temporariamente indisponível. Tente novamente mais tarde.'
    if status == 400:
        return 'Não foi possível validar os dados informados. Confira os campos e tente novamente.'
    if status == 429:
        return 'Muitas tentativas em pouco tempo. Aguarde um instante e tente novamente.'
    return 'Não foi possível criar a cobrança agora. Tente novamente mais tarde.'


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        api_key = os.environ.get('FIREBOT_API_KEY', '').strip()
        if not api_key:
            send_json(self, 503, {
                'message': 'O serviço de pagamento ainda não está configurado.',
            })
            return

        try:
            content_length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            send_json(self, 400, {'message': 'Dados da contribuição inválidos.'})
            return

        if content_length <= 0 or content_length > 16384:
            send_json(self, 400, {'message': 'Dados da contribuição inválidos.'})
            return

        try:
            data = json.loads(self.rfile.read(content_length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            send_json(self, 400, {'message': 'Dados da contribuição inválidos.'})
            return
        if not isinstance(data, dict):
            send_json(self, 400, {'message': 'Dados da contribuição inválidos.'})
            return

        if data.get('productType') != 'DIGITAL':
            send_json(self, 400, {
                'message': 'Tipo de oferta inválido. O tipo deve ser DIGITAL.',
            })
            return

        try:
            amount = float(data.get('amount', 0))
        except (TypeError, ValueError):
            send_json(self, 400, {'message': 'Selecione um valor permitido.'})
            return
        if amount not in ALLOWED_AMOUNTS:
            send_json(self, 400, {'message': 'Selecione um valor permitido.'})
            return
        amount = int(amount)

        customer_data = data.get('customer')
        if not isinstance(customer_data, dict):
            send_json(self, 400, {'message': 'Preencha os dados do comprador.'})
            return

        customer = {
            field: str(customer_data.get(field) or '').strip()
            for field in ('name', 'email', 'cpf', 'phone', 'address')
        }
        customer['cpf'] = re.sub(r'\D', '', customer['cpf'])
        if any(not customer[field] for field in customer):
            send_json(self, 400, {'message': 'Preencha todos os dados do comprador.'})
            return
        if not is_valid_cpf(customer['cpf']):
            send_json(self, 400, {'message': 'Informe um CPF válido.'})
            return
        if not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', customer['email']):
            send_json(self, 400, {'message': 'Informe um e-mail válido.'})
            return
        phone_digits = re.sub(r'\D', '', customer['phone'])
        if phone_digits.startswith('55') and len(phone_digits) in (12, 13):
            phone_digits = phone_digits[2:]
        if (
            len(phone_digits) not in (10, 11)
            or not 11 <= int(phone_digits[:2]) <= 99
            or phone_digits[2] not in '23456789'
        ):
            send_json(self, 400, {'message': 'Informe um telefone válido com DDD.'})
            return
        customer['phone'] = phone_digits

        description = str(data.get('description') or '').strip()
        if not description:
            send_json(self, 400, {'message': 'A descrição da oferta é obrigatória.'})
            return

        store_url = get_store_url(self, str(data.get('storeUrl') or '').strip())
        if not store_url:
            send_json(self, 503, {
                'message': 'A URL HTTPS do checkout ainda não está configurada.',
            })
            return

        firebot_payload = {
            'productType': 'DIGITAL',
            'storeUrl': store_url,
            'amount': amount,
            'description': description,
            'customer': customer,
        }
        request = urllib.request.Request(
            FIREBOT_API_URL,
            data=json.dumps(firebot_payload).encode('utf-8'),
            headers={
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            method='POST',
        )
        request.add_unredirected_header('x-api-key', api_key)

        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                status_code = response.status
                response_headers = response.headers
                content_type = response_headers.get('Content-Type', '')
                response_body = response.read()
        except urllib.error.HTTPError as error:
            response_body = error.read()
            response_headers = error.headers
            content_type = response_headers.get('Content-Type', '')
            log_gateway_response(
                error.code,
                response_headers,
                response_body,
                api_key,
                customer,
            )
            send_json(self, 502, {
                'message': gateway_error_message(error.code),
                'gatewayStatus': error.code,
                'gatewayMessage': gateway_response_message(
                    response_body,
                    content_type,
                    api_key,
                    customer,
                ),
            })
            return
        except (urllib.error.URLError, TimeoutError) as error:
            logging.error('FireBot connection error: %s', str(error)[:500])
            send_json(self, 502, {
                'message': 'Não foi possível conectar ao serviço de pagamento. Tente novamente.',
            })
            return

        if not 200 <= status_code < 300:
            log_gateway_response(
                status_code,
                response_headers,
                response_body,
                api_key,
                customer,
            )
            send_json(self, 502, {
                'message': gateway_error_message(status_code),
                'gatewayStatus': status_code,
                'gatewayMessage': gateway_response_message(
                    response_body,
                    content_type,
                    api_key,
                    customer,
                ),
            })
            return
        if not is_json_content_type(content_type):
            log_gateway_response(
                status_code,
                response_headers,
                response_body,
                api_key,
                customer,
            )
            send_json(self, 502, {
                'message': 'O serviço de pagamento retornou uma resposta inválida.',
                'gatewayStatus': status_code,
                'gatewayMessage': gateway_response_message(
                    response_body,
                    content_type,
                    api_key,
                    customer,
                ),
            })
            return

        try:
            gateway_payload = json.loads(response_body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            log_gateway_response(
                status_code,
                response_headers,
                response_body,
                api_key,
                customer,
            )
            send_json(self, 502, {
                'message': 'O serviço de pagamento retornou uma resposta inválida.',
                'gatewayStatus': status_code,
                'gatewayMessage': gateway_response_message(
                    response_body,
                    content_type,
                    api_key,
                    customer,
                ),
            })
            return

        result = normalize_response(gateway_payload)
        if not result['pixCopiaECola']:
            log_gateway_response(
                status_code,
                response_headers,
                response_body,
                api_key,
                customer,
            )
            send_json(self, 502, {
                'message': 'O serviço não retornou os dados para concluir o pagamento.',
                'gatewayStatus': status_code,
                'gatewayMessage': gateway_response_message(
                    response_body,
                    content_type,
                    api_key,
                    customer,
                ),
            })
            return

        result['amount'] = amount
        send_json(self, 200, result)

    def do_GET(self):
        send_json(self, 405, {'message': 'Método não permitido.'})

    def log_message(self, format, *args):
        return
