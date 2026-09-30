/** An error whose message is safe to show to the user (HTTP response, WebSocket reply, toast). */
export class UserError extends Error {
  constructor(message, { code = 'bad_request', status = 400, extra } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
    this.expose = true;
  }
}

export class HttpError extends UserError {
  constructor(status, message, extra) {
    super(message, { status, code: codeFor(status), extra });
  }
}

function codeFor(status) {
  return { 400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed', 413: 'too_large', 416: 'range', 429: 'rate_limited', 503: 'unavailable' }[status] || 'error';
}
