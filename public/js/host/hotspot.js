// The party hotspot on the host page (PLAN §20): its block in Settings → Party and the banner
// when it couldn't start or dropped. The server runs the checks; this page follows each step.
import { html, useEffect, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { useStore } from '../lib/store.js';
import { Switch } from '../lib/components.js';
import { store, act, toast } from './state.js';

// NetworkManager's automatic band is always a 2.4 GHz channel for a hotspot ('bg' is the same,
// shown only when it was chosen before).
const BANDS = [['auto', '2.4 GHz (automatic) — every phone sees it'], ['bg', '2.4 GHz'], ['a', '5 GHz — faster, newer phones only']];
const CHECK_ICON = { ok: 'check', warn: 'alert', fail: 'x' };

/** The status line: what the hotspot is doing right now. */
function statusText(hs) {
  switch (hs.state) {
    case 'starting': return 'Starting — checking this computer…';
    case 'stopping': return 'Switching off…';
    case 'on': return `On: “${hs.ssid}” at ${hs.address}`;
    case 'failed': return `Off: ${hs.reason}`;
    default: return hs.enabled ? 'Off' : 'Off — guests use the home Wi-Fi.';
  }
}

async function config(patch, done = 'Saved') {
  const r = await act('hotspot.config', patch);
  if (r) toast(done, 'ok', 1400);
  return r;
}

/** A phone or tablet with the PIN may cut itself off: asked before the hotspot comes up from there. */
function mayStart() {
  return store.get().local || confirm('Switch the party hotspot on?\n\nOn a computer with Wi-Fi only, it leaves the home Wi-Fi while the hotspot is on — this phone or tablet then loses the host controls until it joins the party Wi-Fi (step 1 on the TV).');
}

/** false when the person changed their mind (the switch then shows the old state again). */
function switchHotspot(on) {
  if (on && !mayStart()) return false;
  act('hotspot.set', { on });
  return true;
}

function retryHotspot(hs) {
  if (hs.state !== 'on' && !mayStart()) return;
  act('hotspot.retry');
}

function NameField({ hs }) {
  const [v, setV] = useState(hs.ssid);
  useEffect(() => setV(hs.ssid), [hs.ssid]);
  const commit = () => {
    const ssid = v.trim();
    if (!ssid || ssid === hs.ssid) return setV(hs.ssid); // emptied by mistake: the name stays
    return config({ ssid }).then((r) => r || setV(hs.ssid));
  };
  return html`<input class="input" value=${v} maxlength="32" aria-label="Hotspot network name"
    onInput=${(e) => setV(e.currentTarget.value)} onBlur=${commit} onKeyDown=${(e) => e.key === 'Enter' && e.currentTarget.blur()} />`;
}

function PasswordField({ hs }) {
  const [v, setV] = useState(hs.password);
  const [show, setShow] = useState(false);
  useEffect(() => setV(hs.password), [hs.password]);
  const commit = () => {
    if (v === hs.password) return;
    if (!v) return setV(hs.password); // emptied by mistake: "New password" makes one
    config({ password: v }).then((r) => r || setV(hs.password));
  };
  return html`<div class="inline-form">
    <input class="input mono" type=${show ? 'text' : 'password'} value=${v} maxlength="63" aria-label="Hotspot password"
      placeholder=${hs.password ? '' : 'Made up when you switch it on'}
      onInput=${(e) => setV(e.currentTarget.value)} onBlur=${commit} onKeyDown=${(e) => e.key === 'Enter' && e.currentTarget.blur()} />
    <button class="icon-btn small" aria-label=${show ? 'Hide the password' : 'Show the password'} onClick=${() => setShow(!show)}><${Icon} name="eye" size=${16} /></button>
    <button class="btn small" onClick=${() => confirm('Make up a new password? Phones that joined before have to scan step 1 again, and printed cards stop working.') && config({ password: '' }, 'New password')}><${Icon} name="refresh" size=${14} /> New</button>
  </div>`;
}

function Row({ label, help, children }) {
  return html`<div class="setting">
    <div class="setting-text"><b>${label}</b>${help && html`<p class="hint">${help}</p>`}</div>
    <div class="setting-control">${children}</div>
  </div>`;
}

/** The checks of §20.4 as they come in: ✓ / ⚠ / ✗, with the fix under each problem. */
function Checks({ checks }) {
  if (!checks?.length) return null;
  return html`<ul class="hs-checks" aria-label="Hotspot checks">${checks.map((c) => html`<li key=${c.id} class=${c.level}>
    <span class="hs-mark" aria-label=${c.level === 'ok' ? 'OK' : c.level === 'warn' ? 'Warning' : 'Problem'}><${Icon} name=${CHECK_ICON[c.level] || 'alert'} size=${14} /></span>
    <div><span>${c.text}</span>${c.fix && html`<p class="hint">${c.fix}</p>`}</div>
  </li>`)}</ul>`;
}

/** Settings → Party → Party hotspot. */
export function HotspotBlock({ state }) {
  const hs = state.hotspot;
  const [switchKey, setSwitchKey] = useState(0);
  if (!hs) return null;
  const busy = hs.state === 'starting' || hs.state === 'stopping';
  const dot = hs.state === 'on' ? 'on' : hs.state === 'failed' ? 'bad' : '';
  const adapters = hs.devices?.length > 1 || hs.ifname ? [...new Set([...(hs.devices || []), ...(hs.ifname ? [hs.ifname] : [])])] : [];
  return html`<div class="hotspot-block" id="hotspot">
    <div class="setting bool">
      <div class="setting-text"><b>Party hotspot</b>
        <p class="hint">This computer makes its own Wi-Fi for the party, so guests don’t need the home Wi-Fi: they join it first (step 1 on the TV), then open the party (step 2). Needs Linux with NetworkManager and a Wi-Fi adapter.</p>
        <p class=${`hs-status ${hs.state}`} role="status"><span class=${`dot ${dot}`}></span> ${busy && html`<span class="spinner tiny"></span> `}${statusText(hs)}</p>
        ${hs.state === 'failed' && hs.fix && html`<p class="hint hs-fix">${hs.fix}</p>`}
      </div>
      <div class="setting-control"><${Switch} key=${switchKey} checked=${!!hs.enabled} label="Party hotspot" onChange=${(on) => switchHotspot(on) || setSwitchKey(switchKey + 1)} /></div>
    </div>
    ${(hs.enabled || hs.state !== 'off') && html`<${Checks} checks=${hs.checks} />`}
    ${(hs.state === 'failed' || hs.state === 'on') && html`<div class="btn-row hs-actions">
      <button class="btn small" disabled=${busy} onClick=${() => retryHotspot(hs)}><${Icon} name="refresh" size=${14} /> ${hs.state === 'on' ? 'Restart the hotspot' : 'Try again'}</button>
    </div>`}
    <${Row} label="Hotspot name" help="What phones list under Wi-Fi."><${NameField} hs=${hs} /></${Row}>
    <${Row} label="Hotspot password" help="8 to 63 characters. Shown on the TV with step 1 (WPA2)."><${PasswordField} hs=${hs} /></${Row}>
    <${Row} label="Band" help="Older phones only see 2.4 GHz.">
      <select class="select" value=${hs.band} aria-label="Hotspot band" onChange=${(e) => config({ band: e.currentTarget.value })}>${BANDS.filter(([v]) => v !== 'bg' || hs.band === 'bg').map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>
    </${Row}>
    ${adapters.length > 0 && html`<${Row} label="Wi-Fi adapter" help="This computer has more than one.">
      <select class="select" value=${hs.ifname} aria-label="Hotspot Wi-Fi adapter" onChange=${(e) => config({ ifname: e.currentTarget.value })}>
        <option value="">Automatic</option>${adapters.map((d) => html`<option value=${d}>${d}</option>`)}
      </select>
    </${Row}>`}
    ${hs.enabled && (hs.state === 'failed' || hs.state === 'off') && html`<p class="hint hs-note">Changes apply the next time it starts (Try again).</p>`}
  </div>`;
}

/** On every host page while the hotspot is switched on but off: why, the fix, Try again. */
export function HotspotBanner() {
  const { state } = useStore(store);
  const hs = state?.hotspot;
  if (!hs?.enabled || hs.state !== 'failed') return null;
  return html`<section class="banner warn hs-banner" role="alert">
    <${Icon} name="wifi" />
    <div class="grow">
      <b>The party hotspot is off.</b> ${hs.reason}
      ${hs.fix && html`<p class="hs-banner-fix">${hs.fix}</p>`}
      <p class="hs-banner-fix">Meanwhile guests join over the home Wi-Fi: the TV and the invite show its QR code.</p>
      <div class="btn-row">
        <button class="btn small primary" onClick=${() => retryHotspot(hs)}><${Icon} name="refresh" size=${14} /> Try again</button>
        <button class="btn small ghost" onClick=${() => act('hotspot.set', { on: false })}>Turn the hotspot off</button>
        <a class="btn small ghost" href="#/settings/party">Details</a>
      </div>
    </div>
  </section>`;
}
