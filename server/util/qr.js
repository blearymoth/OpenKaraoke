import qrcode from '../vendor/qrcode.mjs';

/** Renders text as a crisp SVG QR code. */
export function qrSvg(text, { ecc = 'M', margin = 2, dark = '#000000', light = '#ffffff', radius = 0 } = {}) {
  const qr = qrcode(0, ecc);
  qr.addData(unescape(encodeURIComponent(text)), 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const size = n + margin * 2;
  let d = '';
  for (let y = 0; y < n; y++) {
    let run = 0;
    for (let x = 0; x <= n; x++) {
      const on = x < n && qr.isDark(y, x);
      if (on) run++;
      if ((!on || x === n) && run) {
        d += `M${x - run + margin} ${y + margin}h${run}v1h-${run}z`;
        run = 0;
      }
    }
  }
  const bg = light === 'transparent' ? '' : `<rect width="${size}" height="${size}" rx="${radius}" fill="${light}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">${bg}<path d="${d}" fill="${dark}"/></svg>`;
}

function escWifi(s) {
  return String(s).replace(/([\\;,:"])/g, '\\$1');
}

/** Standard "join Wi-Fi" QR payload understood by iOS and Android cameras. */
export function wifiPayload({ ssid, password = '', security = 'WPA', hidden = false }) {
  const t = password ? (security || 'WPA') : 'nopass';
  return `WIFI:T:${t};S:${escWifi(ssid)};${password ? `P:${escWifi(password)};` : ''}${hidden ? 'H:true;' : ''};`;
}
