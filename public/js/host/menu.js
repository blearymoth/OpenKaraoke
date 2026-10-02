// A small pop-up menu of actions (queue items, guests in the Devices tab).
import { html, useEffect, useRef } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';

export function Menu({ items, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const off = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => document.addEventListener('mousedown', off));
    document.addEventListener('keydown', esc);
    ref.current?.querySelector('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', off);
      document.removeEventListener('keydown', esc);
    };
  }, []);
  return html`<div class="menu" ref=${ref} role="menu">
    ${items.filter(Boolean).map((it) => html`<button role="menuitem" class=${it.danger ? 'danger' : ''} onClick=${() => { onClose(); it.run(); }}>
      <${Icon} name=${it.icon} size=${16} /> ${it.label}
    </button>`)}
  </div>`;
}
