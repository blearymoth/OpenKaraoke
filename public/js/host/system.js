// Settings → About → "On this computer" (desktop app only, through window.okDesktop.system): how
// this copy is installed, Install (an AppImage run straight from its file), Uninstall, starting
// at login, and server mode — the party keeps running when the window is closed.
import { html, useEffect, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { Switch } from '../lib/components.js';
import { toast } from './state.js';

const bridge = () => window.okDesktop?.system || null;

const WHERE = {
  user: (s) => `Installed for you in ${s.where}.`,
  portable: (s) => (s.installedCopy
    ? `Installed in ~/.local/share/OpenKaraoke — this window still runs from ${s.where}. Next time, start OpenKaraoke from your applications menu.`
    : `Running straight from ${s.where}, without installing.`),
  deb: (s) => `Installed for everyone on this computer (a .deb package, in ${s.where}).`,
  rpm: (s) => `Installed for everyone on this computer (an .rpm package, in ${s.where}).`,
  source: () => 'Running from the source code.',
  unknown: () => 'Not installed by OpenKaraoke’s installer.',
};

export function SystemBlock() {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    bridge()?.get().then((r) => r?.ok && setS(r.state), () => {});
  }, []);
  if (!bridge() || !s) return null;

  const call = async (name, arg, ok) => {
    setBusy(true);
    try {
      const r = await bridge()[name](arg);
      if (!r?.ok) {
        if (!r?.cancelled) toast(r?.error || 'That didn’t work', 'error');
        return false;
      }
      if (r.state) setS(r.state);
      if (ok) toast(ok, 'ok');
      return true;
    } catch (e) {
      toast(e.message || 'That didn’t work', 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  return html`
    <h3 class="section-title">On this computer</h3>
    <div class="setting">
      <div class="setting-text"><b>OpenKaraoke ${s.version}</b><p class="hint">${(WHERE[s.how] || WHERE.unknown)(s)}</p></div>
      <div class="setting-control btn-row">
        ${s.canInstall && !s.installedCopy && html`<button class="btn primary" disabled=${busy} onClick=${() => call('install', undefined, 'Installed: OpenKaraoke is in your applications menu now')}><${Icon} name="download" size=${16} /> Install on this computer</button>`}
        ${s.canUninstall && html`<button class="btn ghost danger" disabled=${busy} onClick=${() => call('uninstall')}><${Icon} name="trash" size=${16} /> Uninstall…</button>`}
      </div>
    </div>
    <div class="setting bool">
      <div class="setting-text"><b>Start OpenKaraoke when I log in</b><p class="hint">${s.canAtLogin ? 'Handy on a computer that is mostly for karaoke.' : 'Not for a copy that runs from the source code.'}</p></div>
      <div class="setting-control"><${Switch} checked=${s.atLogin} disabled=${!s.canAtLogin || busy} label="Start OpenKaraoke when I log in" onChange=${(on) => call('set', { atLogin: on })} /></div>
    </div>
    <div class="setting bool">
      <div class="setting-text"><b>Keep the party running when this window is closed</b>
        <p class="hint">Server mode: the TV window and the guests’ phones carry on, and you run the party from a phone or tablet (set a host PIN in Settings → Party). Open OpenKaraoke from your applications menu to see this window again; quit it here.</p></div>
      <div class="setting-control"><${Switch} checked=${s.background} disabled=${busy} label="Keep the party running when this window is closed" onChange=${(on) => call('set', { background: on })} /></div>
    </div>
    <div class="setting">
      <div class="setting-text"><b>Quit OpenKaraoke</b><p class="hint">Saves the party and stops it: the TV window and the guests’ phones too.</p></div>
      <div class="setting-control"><button class="btn" disabled=${busy} onClick=${() => call('quit')}><${Icon} name="logout" size=${16} /> Quit OpenKaraoke</button></div>
    </div>`;
}
