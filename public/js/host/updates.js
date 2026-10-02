// Updates of the desktop app (desktop/updater.mjs through desktop/preload.cjs): a pill in the top
// bar while one is on its way, and the Updates block in Settings → About. Only in the app — a
// browser has no window.okDesktop, and the server itself is updated with git pull.
import { html, useEffect, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { Switch } from '../lib/components.js';
import { toast } from './state.js';

const bridge = () => window.okDesktop?.updates || null;
const SELF_UPDATING = ['appimage', 'deb', 'rpm'];

let current = null;
const listeners = new Set();
let following = false;

function publish(state) {
  current = state;
  for (const fn of listeners) fn(state);
}

function follow() {
  if (following || !bridge()) return;
  following = true;
  bridge().onChange(publish);
  bridge().get().then((r) => r?.ok && publish(r.state), () => {});
}

/** The updater's state, live; null outside the desktop app. */
export function useUpdates() {
  const [state, setState] = useState(current);
  useEffect(() => {
    if (!bridge()) return undefined;
    follow();
    listeners.add(setState);
    if (current) setState(current);
    return () => listeners.delete(setState);
  }, []);
  return state;
}

/** Calls the updater; a problem becomes a toast. Resolves to the new state, or null. */
async function call(name, ...args) {
  try {
    const r = await bridge()[name](...args);
    if (r?.state) publish(r.state);
    if (!r?.ok) {
      if (r?.error) toast(r.error, 'error');
      return null;
    }
    return r.state;
  } catch (e) {
    toast(e.message || 'That didn’t work', 'error');
    return null;
  }
}

const percent = (u) => Math.round((u.progress || 0) * 100);

/** In the top bar: an update is available, on its way, or waiting for a restart. */
export function UpdatePill() {
  const u = useUpdates();
  if (!u) return null;
  const text = {
    available: `Update ${u.latest?.version || ''}`,
    downloading: `Downloading update ${percent(u)}%`,
    installing: 'Installing update',
    ready: 'Restart to update',
  }[u.status];
  if (!text) return null;
  const working = u.status === 'downloading' || u.status === 'installing';
  return html`<a class="pill neon" href="#/settings/about" title="Updates — Settings › About">
    ${working ? html`<span class="spinner tiny"></span>` : html`<${Icon} name="download" size=${14} />`} ${text}
  </a>`;
}

function ago(at) {
  if (!at) return '';
  const min = Math.round((Date.now() - at) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  return new Date(at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function statusLine(u) {
  const v = u.latest?.version;
  switch (u.status) {
    case 'checking': return 'Checking for a new version…';
    case 'current': return `This is the latest version (checked ${ago(u.checkedAt)}).`;
    case 'available': return `Version ${v} is available.`;
    case 'downloading': return `Downloading version ${v}… ${percent(u)}%`;
    case 'installing': return `Installing version ${v}… Your computer may ask for your password.`;
    case 'ready': return `Version ${v} is installed: restart OpenKaraoke to use it.`;
    case 'unavailable': return u.error || 'Updates can’t be checked right now.';
    default: return 'Not checked yet.';
  }
}

function TokenForm({ u }) {
  const [token, setToken] = useState('');
  const save = async (e) => {
    e.preventDefault();
    const s = await call('setToken', token.trim());
    if (s) {
      setToken('');
      toast('Token saved', 'ok');
    }
  };
  return html`<form class="inline-form" onSubmit=${save}>
    <input class="input" type="password" autocomplete="off" spellcheck="false" maxlength="255" aria-label="GitHub access token"
      placeholder=${u.hasToken ? 'Saved — paste to replace' : 'github_pat_…'} value=${token}
      onInput=${(e) => setToken(e.currentTarget.value)} />
    <button class="btn small primary" disabled=${!token.trim()}>Save</button>
    ${u.hasToken && html`<button type="button" class="btn small ghost danger" onClick=${() => call('setToken', '').then((s) => s && toast('Token removed', 'ok'))}>Remove</button>`}
  </form>`;
}

/** Settings → About in the desktop app: version, check, install, restart, automatic checks. */
export function UpdatesBlock() {
  const u = useUpdates();
  if (!u) return null;
  const busy = ['checking', 'downloading', 'installing'].includes(u.status);
  const canInstall = SELF_UPDATING.includes(u.kind);
  const showNotes = u.latest?.notes && ['available', 'downloading', 'installing', 'ready'].includes(u.status);
  return html`
    <h3 class="section-title">Updates</h3>
    <div class="setting column updates">
      <div class="setting-text">
        <b>OpenKaraoke ${u.version}</b>
        <p class=${u.status === 'unavailable' ? 'warn-text' : 'hint'}>${statusLine(u)}</p>
        ${u.error && u.status !== 'unavailable' && html`<p class="warn-text">${u.error}</p>`}
        ${u.status === 'available' && !canInstall && html`<p class="hint">${u.kind === 'source'
          ? 'This copy runs from the source code: update it with git pull.'
          : 'This copy can’t update itself: download the new version from the release page.'}</p>`}
      </div>
      ${u.status === 'downloading' && html`<div class="art-progress" role="progressbar" aria-label="Download" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${percent(u)}>
        <i class="found" style=${{ width: `${percent(u)}%` }}></i>
      </div>`}
      <div class="btn-row">
        ${u.status === 'ready' && html`<button class="btn primary" onClick=${() => call('restart')}><${Icon} name="restart" size=${16} /> Restart now</button>`}
        ${u.status === 'available' && canInstall && html`<button class="btn primary" onClick=${() => call('install')}><${Icon} name="download" size=${16} /> Download and install</button>`}
        ${u.status === 'available' && u.latest?.url && html`<a class="btn ghost" href=${u.latest.url} target="_blank" rel="noopener">Release page</a>`}
        ${!['ready', 'downloading', 'installing'].includes(u.status) && html`<button class="btn" disabled=${busy} onClick=${() => call('check')}><${Icon} name="refresh" size=${16} /> Check now</button>`}
      </div>
      ${showNotes && html`<details class="release-notes">
        <summary>What’s new in ${u.latest.version}</summary>
        <div class="release-notes-text">${u.latest.notes}</div>
      </details>`}
    </div>
    <div class="setting bool">
      <div class="setting-text"><b>Look for updates automatically</b><p class="hint">Soon after OpenKaraoke starts, then every 6 hours. Nothing is installed until you say so.</p></div>
      <div class="setting-control"><${Switch} checked=${u.autoCheck} label="Look for updates automatically" onChange=${(on) => call('setAutoCheck', on)} /></div>
    </div>
    ${(u.hasToken || u.needsToken) && html`<div class="setting column">
      <div class="setting-text"><b>GitHub access token</b>
        <p class="hint">Only needed while the repository (${u.repo}) is private. On GitHub: Settings › Developer settings › Fine-grained tokens › Generate new token, choose only this repository and give it read-only access to <b>Contents</b>. The token stays on this computer (readable only by you) and is only sent to GitHub.</p>
      </div>
      <${TokenForm} u=${u} />
    </div>`}`;
}
