// Reconnecting WebSocket client with request/response (`rid`) and a server clock offset.

export class Connection {
  /**
   * @param {object} o
   * @param {() => object} o.hello builds the hello message (role, deviceId, token…)
   */
  constructor({ hello, url = defaultUrl() }) {
    this.url = url;
    this.buildHello = hello;
    this.ws = null;
    this.status = 'idle'; // connecting | open | closed | denied
    this.welcome = null;
    this.listeners = new Map();
    this.pending = new Map();
    this.rid = 0;
    this.retry = 0;
    this.offset = 0;
    this.samples = [];
    this.stopped = false;
    this._pingTimer = null;
  }

  on(type, fn) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  emit(type, msg) {
    for (const fn of this.listeners.get(type) || []) {
      try { fn(msg); } catch (e) { console.error(e); }
    }
    if (type !== '*') for (const fn of this.listeners.get('*') || []) fn(msg);
  }

  setStatus(s, detail) {
    this.status = s;
    this.emit('status', { status: s, detail });
  }

  connect() {
    this.stopped = false;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.setStatus('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', ...this.buildHello() }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.handle(msg);
    };
    ws.onclose = () => {
      clearInterval(this._pingTimer);
      for (const [, p] of this.pending) p.reject(new Error('Connection lost'));
      this.pending.clear();
      if (this.ws !== ws) return;
      if (this.status === 'denied' || this.stopped) return;
      this.setStatus('closed');
      const delay = Math.min(5000, 400 * 2 ** this.retry++) + Math.random() * 300;
      setTimeout(() => { if (!this.stopped && this.ws === ws) this.connect(); }, delay);
    };
    ws.onerror = () => {};
  }

  /** Re-sends hello on the open socket (e.g. after pairing or a profile change). */
  rehello() {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'hello', ...this.buildHello() }));
    else this.connect();
  }

  close() {
    this.stopped = true;
    clearInterval(this._pingTimer);
    this.ws?.close();
  }

  handle(msg) {
    switch (msg.t) {
      case 'welcome':
        this.retry = 0;
        this.welcome = msg;
        this.clientId = msg.clientId;
        this.offset = msg.serverTime - Date.now();
        this.samples = [];
        this.setStatus('open');
        clearInterval(this._pingTimer);
        this.ping();
        this._pingTimer = setInterval(() => this.ping(), 10000);
        break;
      case 'denied':
        this.setStatus('denied', msg);
        break;
      case 'pong': {
        const now = Date.now();
        const rtt = now - msg.c;
        this.samples.push({ rtt, offset: msg.s + rtt / 2 - now });
        if (this.samples.length > 8) this.samples.shift();
        const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        this.offset = best.offset;
        this.rtt = best.rtt;
        break;
      }
      case 'res': {
        const p = this.pending.get(msg.rid);
        if (!p) return;
        this.pending.delete(msg.rid);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error || 'Request failed'));
        return;
      }
      default:
        break;
    }
    this.emit(msg.t, msg);
  }

  ping() {
    this.send('ping', { c: Date.now() });
  }

  /** Server clock estimate (ms). */
  now() {
    return Date.now() + this.offset;
  }

  send(t, payload = {}) {
    if (this.ws?.readyState !== 1) return false;
    this.ws.send(JSON.stringify({ t, ...payload }));
    return true;
  }

  request(t, payload = {}, { timeout = 12000 } = {}) {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== 1 || this.status !== 'open') {
        reject(new Error('Not connected'));
        return;
      }
      const rid = ++this.rid;
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error('Request timed out'));
      }, timeout);
      this.pending.set(rid, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ t, rid, ...payload }));
    });
  }
}

function defaultUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/** Stable random id for this browser (guest identity, display id). */
export function deviceId(key = 'ok.device') {
  let id = null;
  try { id = localStorage.getItem(key); } catch { /* private mode */ }
  if (!id) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    id = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
    try { localStorage.setItem(key, id); } catch { /* ignore */ }
  }
  return id;
}

export function storage(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) ?? 'null');
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* ignore */ }
  return value;
}
