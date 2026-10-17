// The window the app shows while it starts (desktop/starting.mjs). A classic script, so the skin
// is set before the first paint: ?theme=<id> (base.css draws Studio for anything else). The app
// tells what it is doing through setStatus().
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') || 'studio';

window.setStatus = (text) => {
  const el = document.getElementById('status');
  if (el && typeof text === 'string') el.textContent = text;
};
