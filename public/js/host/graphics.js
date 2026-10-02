// Settings → About → Graphics (desktop app only, through window.okDesktop.graphics): does this PC
// draw with its graphics card or in software, on which display system (native Wayland or
// XWayland), the screens and frame rates — and the two choices that help a slow PC.
import { html, useEffect, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { copyText } from '../lib/components.js';
import { toast } from './state.js';

const bridge = () => window.okDesktop?.graphics || null;

const KIND = {
  wayland: 'Native Wayland',
  xwayland: 'XWayland (X11 apps on a Wayland desktop)',
  'x11-session': 'X11',
  other: 'This system’s own',
};

function screensText(r) {
  return r.displays.map((d) => `${d.width}×${d.height}${d.hz ? ` at ${d.hz} Hz` : ''}${d.scaleFactor !== 1 ? `, scale ${d.scaleFactor}` : ''}${d.primary ? ' (main)' : ''}`).join(' · ') || '—';
}

function windowText(w, extra = '') {
  if (!w) return 'not open';
  return `${w.fps} frames a second, ${w.width}×${w.height}${w.dpr !== 1 ? ` × ${w.dpr}` : ''}${w.zoom && Math.abs(w.zoom - 1) > 0.01 ? `, zoom ${Math.round(w.zoom * 100)} %` : ''}${extra}`;
}

function cardsText(r) {
  if (r.gpuProblem) return r.gpuProblem;
  return r.devices.map((d) => `${d.vendorId.toString(16).padStart(4, '0')}:${d.deviceId.toString(16).padStart(4, '0')}${d.driverVendor ? ` ${d.driverVendor}` : ''}${d.driverVersion ? ` ${d.driverVersion}` : ''}${d.active ? ' (in use)' : ''}`).join(' · ') || '—';
}

/** The report as plain text, to paste into a message. */
export function reportText(r) {
  const f = r.features;
  return [
    `OpenKaraoke graphics — Electron ${r.versions.electron}, Chromium ${r.versions.chrome}`,
    `Verdict: ${r.verdict.text}`,
    `Display system: ${KIND[r.kind] || r.kind} (${r.why}); ozone ${r.ozone || '?'}; session ${r.session || '?'}${r.desktop ? `; ${r.desktop}` : ''}`,
    `Renderer: ${r.renderer || '(WebGL off)'}`,
    `Features: ${Object.entries(f).map(([k, v]) => `${k} ${v || '?'}`).join(', ')}`,
    `Graphics cards: ${cardsText(r)}${r.crashes ? `; the graphics process stopped ${r.crashes} time(s)` : ''}`,
    `Screens: ${screensText(r)}`,
    `Host window: ${windowText(r.windows.host)}`,
    `TV window: ${windowText(r.windows.tv, r.windows.tv?.fullscreen ? ', full screen' : '')}`,
    `Lighter effects: ${r.lighter ? 'on' : 'off'} (setting: ${r.settings.lighter}); display system setting: ${r.settings.backend}`,
  ].join('\n');
}

export function GraphicsBlock() {
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [restart, setRestart] = useState(false);
  const load = async () => {
    const r = await bridge().get().catch((e) => ({ ok: false, error: e.message }));
    if (r.ok) setReport(r.report);
    else setError(r.error || 'No answer from the app.');
  };
  useEffect(() => { if (bridge()) load(); }, []);
  if (!bridge()) return null;
  const set = async (patch) => {
    const r = await bridge().set(patch);
    if (!r.ok) return toast(r.error || 'Not saved', 'error');
    setRestart(!!r.restart);
    toast('Saved', 'ok', 1200);
    return load();
  };
  const restartNow = async () => {
    const r = await bridge().restart();
    if (!r.ok) toast('Not restarted.', 'info');
  };
  if (!report) return html`<h3 class="section-title">Graphics</h3><p class="muted">${error || 'Checking…'}</p>`;
  const v = report.verdict;
  const backend = report.settings.backend === 'x11' ? 'x11' : 'wayland';
  return html`<h3 class="section-title">Graphics</h3>
    <div class="gfx">
      <p class=${`gfx-verdict ${v.accelerated === false ? 'bad' : ''}`}><span class=${`dot ${v.accelerated ? 'on' : v.accelerated === false ? 'bad' : ''}`}></span> <b>${v.text}</b></p>
      ${v.accelerated === false && html`<p class="hint">The TV and these controls are drawn by the processor instead of the graphics card, which makes them slow.${report.kind === 'xwayland' ? ' Try the native Wayland display system below — Chrome uses it too.' : ''} Lighter effects (below) help meanwhile. “Copy report” gives the details to pass on.</p>`}
      <dl class="gfx-facts">
        <dt>Display system</dt><dd>${KIND[report.kind] || report.kind}</dd>
        <dt>Drawn by</dt><dd>${report.renderer || '(WebGL is off)'}</dd>
        <dt>Graphics card</dt><dd>${cardsText(report)}${report.crashes ? html` · <span class="warn-text">stopped ${report.crashes}×</span>` : ''}</dd>
        <dt>GPU features</dt><dd>${Object.entries(report.features).filter(([, val]) => val).map(([k, val]) => `${k.replace(/_/g, ' ')}: ${val.replace(/_/g, ' ')}`).join(' · ')}</dd>
        <dt>Screens</dt><dd>${screensText(report)}</dd>
        <dt>This window</dt><dd>${windowText(report.windows.host)}</dd>
        <dt>TV window</dt><dd>${windowText(report.windows.tv, report.windows.tv?.fullscreen ? ', full screen' : '')}</dd>
      </dl>
      ${report.canChooseBackend && html`<div class="setting column">
        <div class="setting-text"><b>Display system</b><p class="hint">Native Wayland draws like Chrome. Wayland doesn’t let apps place their windows, so you move the TV window to the TV once (Super+Shift+→, or drag it) and it goes full screen there by itself. XWayland places the TV window by itself, but draws slowly on some PCs.</p></div>
        <div class="setting-control"><select class="select" value=${backend} aria-label="Display system" onChange=${(e) => set({ backend: e.currentTarget.value })}>
          <option value="wayland">Native Wayland (smooth)</option>
          <option value="x11">XWayland (places the TV window)</option>
        </select></div>
      </div>`}
      ${restart && html`<div class="banner warn gfx-restart"><${Icon} name="refresh" /><div class="grow">The new display system is used after a restart. <button class="btn small primary" onClick=${restartNow}>Restart now</button></div></div>`}
      <div class="setting column">
        <div class="setting-text"><b>Lighter effects</b><p class="hint">Still backgrounds instead of drifting ones, no blur, a plain shadow under the lyrics — for a PC without graphics acceleration. Automatic switches them on when this PC draws in software (now: ${report.lighter ? 'on' : 'off'}).</p></div>
        <div class="setting-control"><select class="select" value=${report.settings.lighter} aria-label="Lighter effects" onChange=${(e) => set({ lighter: e.currentTarget.value })}>
          <option value="auto">Automatic</option>
          <option value="on">Always</option>
          <option value="off">Never</option>
        </select></div>
      </div>
      <div class="btn-row">
        <button class="btn small" onClick=${load}><${Icon} name="refresh" size=${14} /> Check again</button>
        <button class="btn small" onClick=${() => copyText(reportText(report)).then(() => toast('Graphics report copied', 'ok'))}><${Icon} name="link" size=${14} /> Copy report</button>
        <button class="btn small ghost" onClick=${() => bridge().gpuPage()}>Graphics details (chrome://gpu)</button>
      </div>
    </div>`;
}
