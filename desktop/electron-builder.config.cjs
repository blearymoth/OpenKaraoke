// Linux installers for the desktop app: `npm --prefix desktop run dist` → desktop/dist/
//   OpenKaraoke-<version>.AppImage   download, make it executable, run (no installation)
//   openkaraoke-<version>.x86_64.rpm  Fedora / openSUSE (sudo dnf install ./…rpm)
//   openkaraoke_<version>_amd64.deb   Ubuntu / Debian / Mint (sudo apt install ./…deb)
// The app is the repository itself (server/, public/, shared/ and desktop/), unpacked (no asar):
// the server reads its pages and media from ordinary files, exactly as with `node server/index.js`.
// OPENKARAOKE_VERSION overrides package.json's version (the release workflow numbers every build).
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const version = process.env.OPENKARAOKE_VERSION || pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`OPENKARAOKE_VERSION must look like 1.2.3, not "${version}"`);
const electronVersion = require('./node_modules/electron/package.json').version;
// Electron as `npm install` unpacked it (the postinstall: Electron 44 no longer downloads on its
// own); without it electron-builder downloads the same version.
const electronDist = path.join(__dirname, 'node_modules', 'electron', 'dist');

module.exports = {
  appId: 'io.github.blearymoth.openkaraoke',
  productName: 'OpenKaraoke',
  electronVersion,
  // Electron from the npm package (no second download while packaging).
  ...(fs.existsSync(path.join(electronDist, 'electron')) ? { electronDist } : {}),
  directories: { app: root, output: path.join(__dirname, 'dist'), buildResources: path.join(__dirname, 'build') },
  extraMetadata: {
    main: 'desktop/main.mjs',
    productName: 'OpenKaraoke',
    // The window's app id / WM_CLASS ("openkaraoke"): the desktop links the window to the menu
    // entry (dock icon, grouping) with it, and electron-builder writes the same StartupWMClass.
    desktopName: 'openkaraoke.desktop',
    version,
    author: { name: 'OpenKaraoke', email: 'blearymoth@users.noreply.github.com' },
    homepage: 'https://github.com/blearymoth/OpenKaraoke',
  },
  files: [
    'package.json',
    'LICENSE',
    'THIRD_PARTY_LICENSES.md',
    'server/**/*',
    'public/**/*',
    'shared/**/*',
    'desktop/main.mjs',
    'desktop/displays.mjs',
    'desktop/graphics.mjs',
    'desktop/preload.cjs',
    'desktop/update-logic.mjs',
    'desktop/updater.mjs',
    'desktop/build/icons/512x512.png',
    '!**/*.test.js',
  ],
  asar: false,
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  linux: {
    target: ['AppImage', 'rpm', 'deb'],
    category: 'AudioVideo',
    icon: path.join(__dirname, 'build', 'icons'),
    executableName: 'openkaraoke',
    syncDesktopName: true,
    synopsis: 'Karaoke parties with your own songs',
    // Also the menu entry's tooltip (Comment).
    description: 'Karaoke parties with your own songs: lyrics on the TV, song requests from guests’ phones, party games.',
    maintainer: 'OpenKaraoke <blearymoth@users.noreply.github.com>',
    vendor: 'OpenKaraoke',
    desktop: {
      entry: {
        Name: 'OpenKaraoke',
        GenericName: 'Karaoke',
        Keywords: 'karaoke;party;singing;cdg;mp3+g;',
      },
    },
  },
  appImage: { artifactName: 'OpenKaraoke-${version}.${ext}' },
  rpm: { artifactName: 'openkaraoke-${version}.${arch}.${ext}', packageName: 'openkaraoke' },
  deb: { artifactName: 'openkaraoke_${version}_${arch}.${ext}', packageName: 'openkaraoke' },
  publish: null,
};
