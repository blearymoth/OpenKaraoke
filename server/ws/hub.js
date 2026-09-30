// WebSocket transport: hello handshake, heartbeat, JSON messages and
// request/response (`rid`) handling. Party logic lives in the Room.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from '../vendor/ws.mjs';
import { logger } from '../util/log.js';
import { sameOrigin } from '../util/net.js';

export class WsError extends Error {
  constructor(message, code = 'error') {
    super(message);
    this.code = code;
  }
}

export class Client {
  constructor(ws, req) {
    this.id = crypto.randomBytes(6).toString('base64url');
    this.ws = ws;
    this.ip = req.socket.remoteAddress || '';
    this.host = String(req.headers.host || '');
    this.origin = req.headers.origin || '';
    this.userAgent = String(req.headers['user-agent'] || '').slice(0, 200);
    this.role = null;
    this.deviceId = null;
    this.meta = {};
    this.alive = true;
    this.connectedAt = Date.now();
    this.bucket = { tokens: 60, at: Date.now() };
  }

  get open() { return this.ws.readyState === WebSocket.OPEN; }

  send(msg) {
    if (this.open) this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  /** Simple token bucket: 60 burst, 30 messages/second sustained. */
  allow() {
    const now = Date.now();
    const b = this.bucket;
    b.tokens = Math.min(60, b.tokens + ((now - b.at) / 1000) * 30);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

export class Hub extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('node:http').Server} o.server
   * @param {(client: Client, msg: object) => object|Promise<object>} [o.onHello] returns extra welcome fields or throws
   */
  constructor({ server, path = '/ws', log = logger('ws'), heartbeatMs = 20000, maxPayload = 512 * 1024, helloTimeoutMs = 15000 } = {}) {
    super();
    this.log = log;
    this.path = path;
    this.clients = new Map();
    this.handlers = new Map();
    this.onHello = null;
    this.helloTimeoutMs = helloTimeoutMs;
    this.wss = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false });
    this._onUpgrade = (req, socket, head) => {
      let pathname = '';
      try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* bad url */ }
      if (pathname !== this.path) { socket.destroy(); return; }
      // Web pages from other sites must not drive the party through the owner's browser.
      if (!sameOrigin(req.headers.origin, req.headers.host)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this._connect(ws, req));
    };
    if (server) server.on('upgrade', this._onUpgrade);
    this.server = server;
    this._beat = setInterval(() => this._heartbeat(), heartbeatMs);
    this._beat.unref?.();
  }

  /** Registers a message handler. `roles` limits who may send it. */
  handle(type, fn, { roles = null } = {}) {
    this.handlers.set(type, { fn, roles: roles ? new Set(roles) : null });
    return this;
  }

  _connect(ws, req) {
    const client = new Client(ws, req);
    this.clients.set(client.id, client);
    const helloTimer = setTimeout(() => { if (!client.role) ws.close(4000, 'hello timeout'); }, this.helloTimeoutMs);
    ws.on('pong', () => { client.alive = true; });
    ws.on('message', (data, isBinary) => {
      client.alive = true;
      if (isBinary) return;
      if (!client.allow()) {
        client.send({ t: 'toast', level: 'error', text: 'Slow down!' });
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
      this._message(client, msg).catch((e) => this.log.error('handler crashed', e));
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.clients.delete(client.id);
      if (client.role) this.emit('leave', client);
    });
    ws.on('error', (e) => this.log.debug('socket error', e.message));
  }

  async _message(client, msg) {
    if (msg.t === 'ping') {
      client.send({ t: 'pong', c: msg.c, s: Date.now() });
      return;
    }
    if (msg.t === 'hello') {
      try {
        const extra = this.onHello ? await this.onHello(client, msg) : { role: msg.role };
        if (!client.open) return;
        const first = !client.role;
        client.role = extra.role;
        client.send({ t: 'welcome', clientId: client.id, serverTime: Date.now(), ...extra });
        if (first) this.emit('join', client);
        else this.emit('rejoin', client);
      } catch (e) {
        client.send({ t: 'denied', reason: e.message || 'Not allowed', code: e.code || 'denied' });
        if (!client.role) setTimeout(() => client.ws.close(4001, 'denied'), 200);
      }
      return;
    }
    const reply = (ok, payload) => {
      if (msg.rid == null) return;
      client.send(ok ? { t: 'res', rid: msg.rid, ok: true, data: payload ?? null } : { t: 'res', rid: msg.rid, ok: false, error: payload });
    };
    if (!client.role) { reply(false, 'Say hello first'); return; }
    const h = this.handlers.get(msg.t);
    if (!h) { reply(false, `Unknown message ${msg.t}`); return; }
    if (h.roles && !h.roles.has(client.role)) { reply(false, 'Not allowed'); return; }
    try {
      const data = await h.fn(client, msg);
      reply(true, data);
    } catch (e) {
      if (!(e instanceof WsError)) this.log.error(`${msg.t} failed`, e);
      reply(false, e instanceof WsError ? e.message : 'Something went wrong');
    }
  }

  _heartbeat() {
    for (const c of this.clients.values()) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* closed */ }
    }
  }

  /** Sends one message to every client matching `filter` (serialised once). */
  broadcast(msg, filter = null) {
    const data = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (!c.role) continue;
      if (filter && !filter(c)) continue;
      c.send(data);
    }
  }

  byRole(role) {
    return [...this.clients.values()].filter((c) => c.role === role);
  }

  close() {
    clearInterval(this._beat);
    this.server?.off('upgrade', this._onUpgrade);
    for (const c of this.clients.values()) c.ws.terminate();
    this.clients.clear();
    this.wss.close();
  }
}
