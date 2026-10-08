// The setup window (desktop/setup.mjs): install OpenKaraoke for this person, update or repair
// the installed copy, or take it away again — like a Windows installer, every step a button.
// window.okSetup (desktop/setup/preload.cjs) does the work.
import { html, render, useEffect, useState } from '/js/vendor/preact.js';
import { Icon } from '/js/lib/icons.js';
import { THEMES, normalizeTheme } from '/shared/themes.js';

const setup = window.okSetup;

/** -1, 0, 1 for "1.2.3" versions (an empty or odd one counts as the oldest). */
function compare(a, b) {
  const p = (v) => (/^\d+\.\d+\.\d+$/.test(v || '') ? v.split('.').map(Number) : [0, 0, 0]);
  const x = p(a);
  const y = p(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

function Head({ info }) {
  return html`<header class="setup-head">
    <img src=${THEMES[normalizeTheme(info.theme)].icon} alt="" />
    <div><b>OpenKaraoke</b><span>Version ${info.version} · Setup</span></div>
  </header>`;
}

function Option({ checked, onChange, title, sub }) {
  return html`<label class="option">
    <span><b>${title}</b>${sub && html`<small>${sub}</small>`}</span>
    <span class="switch"><input type="checkbox" checked=${checked} aria-label=${title} onChange=${(e) => onChange(e.currentTarget.checked)} /><span></span></span>
  </label>`;
}

/** The first page: what will happen, two choices, Install. */
function Welcome({ info, go }) {
  const [shortcut, setShortcut] = useState(true);
  const [atLogin, setAtLogin] = useState(info.atLogin);
  const installed = info.installed;
  const order = installed ? compare(info.version, installed.version) : 1;
  let title = 'Install OpenKaraoke';
  let button = 'Install';
  let text = null;
  if (installed && order > 0) {
    title = 'Update OpenKaraoke';
    button = 'Update';
    text = html`<p class="lead">Version ${installed.version || '(older)'} is installed on this computer. This is version ${info.version}: updating keeps your songs, settings and party.</p>`;
  }
  const install = () => go('install', { shortcut, atLogin });
  return html`
    <h1>${title}</h1>
    ${text || html`<p class="lead">Karaoke parties with your own songs: lyrics on the TV, song requests from your guests’ phones, party games.</p>`}
    <ul class="facts">
      <li><${Icon} name="check" size=${18} /><span>Everything OpenKaraoke needs is inside this one file — nothing else to download, no terminal.</span></li>
      <li><${Icon} name="check" size=${18} /><span>Installs just for you (${info.user}): no password needed.</span></li>
      <li><${Icon} name="check" size=${18} /><span>Your songs stay where they are.</span></li>
    </ul>
    <div class="options">
      <${Option} checked=${shortcut} onChange=${setShortcut} title="Put a shortcut on the desktop" />
      <${Option} checked=${atLogin} onChange=${setAtLogin} title="Start OpenKaraoke when I log in" sub="Handy on a computer that is mostly for karaoke." />
    </div>
    ${info.system && html`<p class="note">OpenKaraoke is also installed for everyone on this computer (as a system package). You don’t need both: this copy is just for you.</p>`}
    <div class="actions">
      <button class="btn primary large" autofocus onClick=${install}><${Icon} name="download" /> ${button}</button>
      ${installed && html`<button class="btn large" onClick=${() => go('launch', 'installed')}>Start the installed version</button>`}
      ${!installed && html`<button class="btn ghost" onClick=${() => go('runHere')}>Run it without installing</button>`}
    </div>
    <p class="where">It goes to ${info.dir} (about ${info.sizeMb} MB). Uninstall it any time: right-click OpenKaraoke in your applications menu, or Settings → About in the app.</p>`;
}

/** Already installed (the same or a newer version): start it, or repair, or remove. */
function Installed({ info, go }) {
  const installed = info.installed;
  const newer = compare(installed.version, info.version) > 0;
  return html`
    <h1>${newer ? 'A newer OpenKaraoke is installed' : 'OpenKaraoke is installed'}</h1>
    <p class="lead">${newer
      ? `Version ${installed.version} is installed on this computer; this file has version ${info.version}, an older one.`
      : `Version ${installed.version || info.version} is installed on this computer. Start it from your applications menu${installed.shortcut ? ' or with the icon on your desktop' : ''}.`}</p>
    ${info.running && html`<p class="note">OpenKaraoke is open right now.</p>`}
    <div class="actions">
      <button class="btn primary large" autofocus onClick=${() => go('launch', 'installed')}><${Icon} name="play" /> Start OpenKaraoke</button>
    </div>
    <div class="links">
      <button onClick=${() => go('welcome-again')}>${newer ? 'Install this older version anyway' : 'Install again (repair)'}</button>
      <button onClick=${() => go('runHere')}>Run this file without installing</button>
      <button class="danger" onClick=${() => go('ask-uninstall')}>Uninstall OpenKaraoke…</button>
    </div>`;
}

/** A .deb or .rpm copy is installed for everyone, and none just for this person. */
function SystemCopy({ info, go }) {
  return html`
    <h1>OpenKaraoke is already installed</h1>
    <p class="lead">It is installed for everyone on this computer (as a system package). Start it from your applications menu — there is nothing else to do.</p>
    <div class="actions">
      <button class="btn primary large" autofocus onClick=${() => go('launch', 'system')}><${Icon} name="play" /> Start OpenKaraoke</button>
    </div>
    <div class="links"><button onClick=${() => go('welcome-again')}>Install a copy just for me anyway</button></div>`;
}

function Working({ title, progress, text }) {
  return html`
    <h1>${title}</h1>
    <div class="bar" role="progressbar" aria-label=${title} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(progress * 100)}><i style=${{ width: `${Math.round(progress * 100)}%` }}></i></div>
    <p class="where">${text}</p>`;
}

function Done({ info, result, go }) {
  return html`
    <div class="done-mark"><${Icon} name="check" /></div>
    <h1>OpenKaraoke is installed</h1>
    <p class="lead">Start it from your applications menu${result.shortcut ? ' or with the OpenKaraoke icon on your desktop' : ''}. The first time, choose the folder with your karaoke songs.</p>
    ${info.running && html`<p class="note">OpenKaraoke is open right now: it uses the new version once you quit it and start it again.</p>`}
    <div class="actions">
      <button class="btn primary large" autofocus onClick=${() => go('launch', 'installed')}><${Icon} name="play" /> Start OpenKaraoke</button>
      <button class="btn large" onClick=${() => go('close')}>Close</button>
    </div>
    <p class="where">You can delete “${info.fromName}” from your Downloads folder now — or keep it to install OpenKaraoke on another computer.</p>`;
}

function AskUninstall({ info, go }) {
  const [removeData, setRemoveData] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const quit = async () => {
    setQuitting(true);
    await go('quit-running');
    setQuitting(false);
  };
  return html`
    <h1>Uninstall OpenKaraoke?</h1>
    <p class="lead">OpenKaraoke, its menu entry and its desktop shortcut are removed from this computer. Your songs are never touched.</p>
    <label class="check-row"><input type="checkbox" checked=${removeData} onChange=${(e) => setRemoveData(e.currentTarget.checked)} /> Also delete what OpenKaraoke saved — settings, playlists, favourites, history, song index and pictures (they go to the Trash)</label>
    ${info.running && html`<div class="note warn">OpenKaraoke is open right now: it has to quit first (the party is saved).
      <div class="actions"><button class="btn" disabled=${quitting} onClick=${quit}>${quitting ? 'Quitting…' : 'Quit OpenKaraoke for me'}</button></div></div>`}
    <div class="actions">
      <button class="btn large danger" disabled=${info.running} onClick=${() => go('uninstall', { removeData })}><${Icon} name="trash" /> Uninstall</button>
      <button class="btn ghost large" autofocus onClick=${() => go('back')}>Cancel</button>
    </div>`;
}

function Removed({ go }) {
  return html`
    <div class="done-mark"><${Icon} name="check" /></div>
    <h1>OpenKaraoke has been removed</h1>
    <p class="lead">It is no longer on this computer. To install it again, open “Install OpenKaraoke” any time.</p>
    <div class="actions"><button class="btn primary large" autofocus onClick=${() => go('close')}>Close</button></div>`;
}

function Failed({ error, go }) {
  return html`
    <h1>That didn’t work</h1>
    <div class="error-box">${error}</div>
    <div class="actions">
      <button class="btn primary large" autofocus onClick=${() => go('back')}>Try again</button>
      <button class="btn large" onClick=${() => go('close')}>Close</button>
    </div>`;
}

function App() {
  const [info, setInfo] = useState(null);
  const [page, setPage] = useState({ name: 'loading' });
  const [progress, setProgress] = useState(0);

  const first = (i) => {
    // An older copy installed: the Update page; the same or a newer one: Start / Repair / Uninstall.
    if (i.installed) return compare(i.version, i.installed.version) > 0 ? { name: 'welcome' } : { name: 'installed' };
    if (i.system) return { name: 'system' };
    return { name: 'welcome' };
  };
  const reload = async () => {
    const i = await setup.info();
    setInfo(i);
    if (i.theme) document.documentElement.dataset.theme = i.theme;
    return i;
  };
  useEffect(() => {
    reload().then((i) => setPage(first(i)), (e) => setPage({ name: 'failed', error: e.message }));
    return setup.onProgress(setProgress);
  }, []);

  const go = async (what, arg) => {
    if (what === 'welcome-again') return setPage({ name: 'welcome', again: true });
    if (what === 'ask-uninstall') {
      await reload(); // (whether OpenKaraoke is open right now)
      return setPage({ name: 'ask-uninstall' });
    }
    if (what === 'back') return setPage(first(await reload()));
    if (what === 'close') return setup.close();
    if (what === 'quit-running') {
      const i = await setup.quitRunning();
      setInfo(i);
      return undefined;
    }
    if (what === 'runHere') {
      const r = await setup.runHere();
      if (!r?.ok) setPage({ name: 'failed', error: r?.error || 'OpenKaraoke could not start.' });
      return undefined;
    }
    if (what === 'launch') {
      const r = await setup.launch(arg);
      if (!r?.ok) setPage({ name: 'failed', error: r?.error || 'OpenKaraoke could not start.' });
      return undefined;
    }
    if (what === 'install') {
      setProgress(0);
      setPage({ name: 'installing' });
      const r = await setup.install(arg);
      if (!r?.ok) return setPage({ name: 'failed', error: r?.error || 'The installation failed.' });
      await reload();
      return setPage({ name: 'done', result: arg });
    }
    if (what === 'uninstall') {
      setProgress(0.5);
      setPage({ name: 'uninstalling' });
      const r = await setup.uninstall(arg);
      if (!r?.ok) return setPage({ name: 'failed', error: r?.error || 'OpenKaraoke could not be removed.' });
      await reload();
      return setPage({ name: 'removed' });
    }
    return undefined;
  };

  if (!info && page.name !== 'failed') return html`<div class="spinner"></div>`;
  let body;
  switch (page.name) {
    case 'installed': body = html`<${Installed} info=${info} go=${go} />`; break;
    case 'system': body = html`<${SystemCopy} info=${info} go=${go} />`; break;
    case 'installing': body = html`<${Working} title="Installing OpenKaraoke…" progress=${progress} text=${progress < 1 ? 'Copying OpenKaraoke…' : 'Adding it to the applications menu…'} />`; break;
    case 'uninstalling': body = html`<${Working} title="Removing OpenKaraoke…" progress=${progress} text="Removing the program, its menu entry and its shortcut…" />`; break;
    case 'done': body = html`<${Done} info=${info} result=${page.result} go=${go} />`; break;
    case 'ask-uninstall': body = html`<${AskUninstall} info=${info} go=${go} />`; break;
    case 'removed': body = html`<${Removed} go=${go} />`; break;
    case 'failed': body = html`<${Failed} error=${page.error} go=${go} />`; break;
    default: body = html`<${Welcome} info=${page.again ? { ...info, installed: null } : info} go=${go} />`;
  }
  return html`${info && html`<${Head} info=${info} />`}${body}`;
}

if (setup) render(html`<${App} />`, document.getElementById('app'));
else document.getElementById('app').textContent = 'Open “Install OpenKaraoke” to install OpenKaraoke.';
