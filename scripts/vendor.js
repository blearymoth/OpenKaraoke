// Rebuilds the vendored browser/server libraries from node_modules.
// Usage: npm install && npm run vendor
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = (p) => path.join(root, 'node_modules', p);

const preactEntry = path.join(root, 'scripts', '.preact-entry.js');
await fs.writeFile(preactEntry, `
export { h, render, Fragment, createContext, createRef, cloneElement, toChildArray, Component } from 'preact';
export { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useReducer, useContext, useErrorBoundary, useId } from 'preact/hooks';
import htm from 'htm';
import { h } from 'preact';
export const html = htm.bind(h);
`);
await build({ entryPoints: [preactEntry], bundle: true, format: 'esm', minify: true, outfile: path.join(root, 'public/js/vendor/preact.js') });
await fs.rm(preactEntry);

await build({
  entryPoints: [nm('ws/wrapper.mjs')], bundle: true, platform: 'node', format: 'esm',
  external: ['bufferutil', 'utf-8-validate'], outfile: path.join(root, 'server/vendor/ws.mjs'),
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
});
await fs.copyFile(nm('qrcode-generator/dist/qrcode.mjs'), path.join(root, 'server/vendor/qrcode.mjs'));
await fs.copyFile(nm('signalsmith-stretch/SignalsmithStretch.mjs'), path.join(root, 'public/js/vendor/signalsmith-stretch.mjs'));
console.log('Vendored libraries rebuilt.');
