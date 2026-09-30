// WebSocket transport on /ws (vendored `ws`): hello handshake, heartbeat, JSON messages,
// request/response via `rid`. Party logic lives in the Room, which plugs into
// `hub.onHello` and `hub.onRequest`.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { WebSocketServer } from '../vendor/ws.mjs';
import { isLocalAddress } from '../util/net.js';
import { logger } from '../util/log.js';

const log = logger('ws');
const MAX_BUFFERED = 4 * 1024 * 1024; // drop broadcasts for a client that stopped reading

export class Client {
  constructor(ws, req) {
    this.id = crypto.randomBytes(5).toString('hex');
    this.ws = ws;
    this.ip = req.socket.remoteAddress;
    this.isLocal = isLocalAddress(this.ip);
    this.userAgent = String(req.headers['user-agent'] || '').slice(0, 200);
    this.role = null;
    this.alive = true;
    this.connectedAt = Date.now();
    this.lastSeen = this.connectedAt;
    this.data = {}; // room-specific info (deviceId, display kind…)
  }

  get open() {
    return this.ws.readyState === 1;
  }

  send(msg) {
    if (this.open) this.ws.send(JSON.stringify(msg));
  }

  sendRaw(text) {
    if (this.open && this.ws.bufferedAmount < MAX_BUFFERED) this.ws.send(text);
  }

  close(code = 1000, reason = '') {
    try {
      this.ws.close(code, reason);
    } catch { /* already closed */ }
  }
}

export class Hub extends EventEmitter {
  constructor({ path = '/ws', heartbeatMs = 20000, helloTimeoutMs = 10000, maxPayload = 512 * 1024 } = {}) {
    super();
    this.path = path;
    this.heartbeatMs = heartbeatMs;
    this.helloTimeoutMs = helloTimeoutMs;
    this.maxPayload = maxPayload;
    this.clients = new Map();
    /** (client, helloMsg) => { ok: true, role, welcome } | { ok: false, reason } */
    this.onHello = async () => ({ ok: false, reason: 'not ready' });
    /** (client, msg) => data | throws UserError */
    this.onRequest = async (client, msg) => {
      throw Object.assign(new Error(`Unknown message type: ${msg.t}`), { expose: true });
    };
  }

  attach(server) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.maxPayload, perMessageDeflate: false });
    server.on('upgrade', (req, socket, head) => {
      let pathname = '';
      try {
        pathname = new URL(req.url, 'http://localhost').pathname;
      } catch { /* bad url */ }
      if (pathname !== this.path) {
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.connection(ws, req));
    });
    this.timer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.timer.unref?.();
  }

  connection(ws, req) {
    const client = new Client(ws, req);
    this.clients.set(client.id, client);
    const helloTimer = setTimeout(() => {
      if (!client.role) client.close(4000, 'hello expected');
    }, this.helloTimeoutMs);
    ws.on('message', (data, isBinary) => {
      if (!isBinary) this.message(client, data).catch((e) => log.error('message handler', e));
    });
    ws.on('pong', () => { client.alive = true; });
    ws.on('error', (e) => log.debug(`client ${client.id} error`, e.message));
    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.clients.delete(client.id);
      if (client.role) this.emit('leave', client);
    });
  }

  async message(client, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    client.alive = true;
    client.lastSeen = Date.now();
    if (msg.t === 'ping') {
      client.send({ t: 'pong', c: msg.c, s: Date.now() });
      return;
    }

    if (!client.role) {
      if (msg.t !== 'hello') {
        client.send({ t: 'denied', reason: 'hello_expected' });
        client.close(4000, 'hello expected');
        return;
      }
      let result;
      try {
        result = await this.onHello(client, msg);
      } catch (e) {
        log.error('hello failed', e);
        result = { ok: false, reason: 'server_error' };
      }
      if (!client.open) return;
      if (!result?.ok) {
        client.send({ t: 'denied', reason: result?.reason || 'denied', ...(result?.extra || {}) });
        // Leave the socket open briefly so the client reads the reason; displays waiting for
        // pairing keep it open (result.keepOpen).
        if (!result?.keepOpen) setTimeout(() => client.close(4001, 'denied'), 50);
        return;
      }
      client.role = result.role;
      client.send({ t: 'welcome', clientId: client.id, role: result.role, serverTime: Date.now(), ...(result.welcome || {}) });
      this.emit('join', client);
      return;
    }

    const rid = msg.rid;
    try {
      const out = await this.onRequest(client, msg);
      if (rid !== undefined) client.send({ t: 'res', rid, ok: true, data: out ?? null });
    } catch (e) {
      if (!e?.expose) log.error(`request ${msg.t} failed`, e);
      if (rid !== undefined) client.send({ t: 'res', rid, ok: false, error: e?.expose ? e.message : 'Something went wrong', code: e?.code });
      else if (e?.expose) client.send({ t: 'toast', level: 'error', text: e.message });
    }
  }

  heartbeat() {
    for (const c of this.clients.values()) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch { /* closing */ }
    }
  }

  /** Sends `msg` to every joined client for which `filter(client)` is true. */
  broadcast(msg, filter) {
    let text = null;
    for (const c of this.clients.values()) {
      if (!c.role || (filter && !filter(c))) continue;
      text ??= JSON.stringify(msg);
      c.sendRaw(text);
    }
  }

  list(filter) {
    return [...this.clients.values()].filter((c) => c.role && (!filter || filter(c)));
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    for (const c of this.clients.values()) c.close(1001, 'server shutting down');
    this.wss?.close();
  }
}
