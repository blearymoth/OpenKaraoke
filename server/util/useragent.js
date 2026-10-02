// A short, fixed-list name for a device from its User-Agent ("Chrome · Android", "LG TV"), for
// the host's Devices list. Only literal-substring patterns (linear time on any input); never the
// raw string, so nothing a client writes there reaches another page.

const TVS = [
  [/SMART-TV|Tizen/i, 'Samsung TV'],
  [/Web0S|webOS/i, 'LG TV'],
  [/BRAVIA/i, 'Sony TV'],
  [/\bAFT[A-Z]/, 'Fire TV'],
  [/CrKey/, 'Chromecast'],
  [/GoogleTV|Android TV/i, 'Android TV'],
  [/HbbTV/i, 'Smart TV'],
];
const BROWSERS = [
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Edg(?:e|A|iOS)?\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Version\/.*Safari\//, 'Safari'],
];
const SYSTEMS = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
];

const first = (list, ua) => list.find(([re]) => re.test(ua))?.[1] || '';

/** "Chrome · Android", "Safari · iPhone", "OpenKaraoke app", "LG TV", … or "Browser". */
export function deviceLabel(ua) {
  const s = String(ua ?? '').slice(0, 300);
  if (/Electron\//.test(s)) return 'OpenKaraoke app';
  const tv = first(TVS, s);
  if (tv) return tv;
  const browser = first(BROWSERS, s);
  const system = first(SYSTEMS, s);
  if (browser && system) return `${browser} · ${system}`;
  return browser || system || 'Browser';
}
