// WebSocket client shared by the host, TV and guest apps: hello handshake, automatic
// reconnect with back-off, request/response via `rid`, and a server clock estimate.

const RETRY_MS = [500, 1000, 2000, 3000, 5000];
const FINAL = new Set(['bad_room', 'banned', 'kicked', 'host_only', 'bad_role']);

export class Connection extends EventTarget {
  /**
   * @param {object} opts
   * @param {() => object} opts.hello builds the hello message (role, token, …) for each (re)connect
   */
  constructor({ hello, url } = {}) {
    super();
    this.buildHello = hello;
    this.url = url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.ws = null;
    this.rid = 0;
    this.pending = new Map();
    this.attempt = 0;
    this.status = 'connecting';
    this.offset = 0; // serverTime ≈ Date.now() + offset
    this.bestRtt = Infinity;
    this.stopped = false;
    this.welcome = null;
    this.outbox = []; // messages that must not be lost while reconnecting
  }

  connect() {
    this.stopped = false;
    this.open();
    this.pingTimer ||= setInterval(() => this.ping(), 10000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.status === 'closed' && !this.stopped) this.open();
    });
    return this;
  }

  open() {
    clearTimeout(this.retryTimer);
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.setStatus(this.attempt ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', ...this.buildHello() }));
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      for (const [, p] of this.pending) p.reject(new Error('Connection lost'));
      this.pending.clear();
      this.setStatus('closed');
      if (this.stopped) return;
      const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
      this.attempt++;
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
  }

  handle(msg) {
    if (msg.t === 'welcome') {
      this.attempt = 0;
      this.welcome = msg;
      this.adjustClock(msg.serverTime, 0);
      this.setStatus('open');
      this.ping();
      this.dispatchEvent(new CustomEvent(msg.t, { detail: msg }));
      this.dispatchEvent(new CustomEvent('message', { detail: msg }));
      const queued = this.outbox.splice(0);
      for (const m of queued) this.ws.send(JSON.stringify(m));
      return;
    } else if (msg.t === 'denied') {
      if (FINAL.has(msg.reason)) this.stopped = true;
    } else if (msg.t === 'res') {
      const p = this.pending.get(msg.rid);
      if (p) {
        this.pending.delete(msg.rid);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(Object.assign(new Error(msg.error || 'Request failed'), { code: msg.code }));
      }
      return;
    } else if (msg.t === 'pong') {
      const rtt = Date.now() - msg.c;
      if (rtt >= 0 && rtt < 5000) this.adjustClock(msg.s, rtt);
      return;
    }
    this.dispatchEvent(new CustomEvent(msg.t, { detail: msg }));
    this.dispatchEvent(new CustomEvent('message', { detail: msg }));
  }

  adjustClock(serverTime, rtt) {
    // Trust the lowest-latency sample the most.
    if (rtt <= this.bestRtt * 1.5 || rtt === 0) {
      if (rtt) this.bestRtt = Math.min(this.bestRtt, rtt);
      this.offset = serverTime + rtt / 2 - Date.now();
    }
  }

  serverNow() {
    return Date.now() + this.offset;
  }

  ping() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'ping', c: Date.now() }));
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: status }));
  }

  /** Sends a request and resolves with the server's `data` (rejects with its error message). */
  request(t, body = {}, { timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN || this.status !== 'open') {
        reject(new Error('Not connected — reconnecting…'));
        return;
      }
      const rid = ++this.rid;
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error('The server did not answer in time'));
      }, timeout);
      this.pending.set(rid, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ t, rid, ...body }));
    });
  }

  /** Fire-and-forget message (no reply expected); dropped while disconnected. */
  send(t, body = {}) {
    if (this.ws?.readyState === WebSocket.OPEN && this.status === 'open') this.ws.send(JSON.stringify({ t, ...body }));
  }

  /** Like send(), but kept and delivered after a reconnect (after the welcome). */
  sendReliable(t, body = {}) {
    if (this.ws?.readyState === WebSocket.OPEN && this.status === 'open') this.ws.send(JSON.stringify({ t, ...body }));
    else {
      this.outbox.push({ t, ...body });
      if (this.outbox.length > 20) this.outbox.shift();
    }
  }

  on(type, fn) {
    const h = (ev) => fn(ev.detail);
    this.addEventListener(type, h);
    return () => this.removeEventListener(type, h);
  }

  close() {
    this.stopped = true;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ws?.close();
  }
}
