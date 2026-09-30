// Horizontal "gallery" row of song cards (cover art, title, artist) used on home screens.
import { html, useState, useEffect, useRef } from '/js/vendor/preact.js';
import { Icon, Cover } from './ui.js';

/**
 * @param {object} p
 * @param {string} p.title
 * @param {(signal) => Promise<object[]>} p.load  resolves to song summaries
 * @param {any[]} [p.deps]
 * @param {(song) => void} p.onOpen   tap on a card
 * @param {(song) => void} [p.onAdd]  "+" button (omitted = no button)
 * @param {(song) => ('queued'|'sung'|null)} [p.mark]
 * @param {string} [p.moreHref] / p.onMore  "See all" link
 * @param {() => void} [p.onRefresh]
 * @param {number} [p.size] cover size in px
 */
export function Shelf({ title, subtitle, load, deps = [], onOpen, onAdd, mark, moreHref, onMore, onRefresh, size = 150, hideEmpty = true }) {
  const [items, setItems] = useState(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const track = useRef();
  useEffect(() => {
    const ctrl = new AbortController();
    setItems(null);
    Promise.resolve(load(ctrl.signal)).then((list) => { if (!ctrl.signal.aborted) setItems(list || []); }, () => { if (!ctrl.signal.aborted) setItems([]); });
    return () => ctrl.abort();
  }, deps);
  const updateEdges = () => {
    const el = track.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth > el.scrollWidth - 8 });
  };
  useEffect(updateEdges, [items]);
  if (items && !items.length && hideEmpty) return null;
  const scroll = (dir) => track.current?.scrollBy({ left: dir * track.current.clientWidth * 0.8, behavior: 'smooth' });
  return html`<section class="shelf" style=${{ '--card': `${size}px` }}>
    <div class="shelf-head">
      <div class="grow"><h2>${title}</h2>${subtitle && html`<div class="dim shelf-sub">${subtitle}</div>`}</div>
      ${onRefresh && html`<button class="btn icon small ghost" title="Shuffle" onClick=${onRefresh}><${Icon} name="refresh" size=${16} /></button>`}
      ${moreHref && html`<a class="btn small ghost" href=${moreHref}>See all</a>`}
      ${onMore && html`<button class="btn small ghost" onClick=${onMore}>See all</button>`}
      <span class="shelf-arrows">
        <button class="btn icon small" disabled=${edges.start} onClick=${() => scroll(-1)} aria-label="Scroll left"><${Icon} name="back" size=${16} /></button>
        <button class="btn icon small" disabled=${edges.end} onClick=${() => scroll(1)} aria-label="Scroll right"><${Icon} name="chevron" size=${16} /></button>
      </span>
    </div>
    <div class="shelf-track" ref=${track} onScroll=${updateEdges}>
      ${!items
        ? Array.from({ length: 8 }, (_, i) => html`<div key=${i} class="shelf-card skeleton"><div class="art"></div><div class="t"></div><div class="a"></div></div>`)
        : items.map((s) => {
          const m = mark?.(s);
          return html`<div key=${s.id} class="shelf-card" role="button" tabIndex="0" onClick=${() => onOpen(s)} onKeyDown=${(e) => { if (e.key === 'Enter') onOpen(s); }}>
            <div class="art">
              <${Cover} song=${s} size=${size} big=${size > 200} />
              ${m && html`<span class=${`shelf-mark ${m}`}>${m === 'queued' ? 'In queue' : 'Sung'}</span>`}
              ${s.duet ? html`<span class="shelf-mark duet">Duet</span>` : null}
              ${onAdd && html`<button class="add" title="Add to queue" onClick=${(e) => { e.stopPropagation(); onAdd(s); }}><${Icon} name="plus" size=${20} /></button>`}
            </div>
            <div class="t" title=${s.title}>${s.title}</div>
            <div class="a" title=${s.artist}>${s.artist}</div>
          </div>`;
        })}
    </div>
  </section>`;
}
