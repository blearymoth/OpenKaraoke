// Linux installers for the desktop app: `npm --prefix desktop run dist` → desktop/dist/
//   OpenKaraoke-<version>.AppImage   download, make it executable, run (no installation)
//   openkaraoke-<version>.x86_64.rpm  Fedora / openSUSE (sudo dnf install ./…rpm)
//   openkaraoke_<version>_amd64.deb   Ubuntu / Debian / Mint (sudo apt install ./…deb)
// The app is the repository itself (server/, public/, shared/ and desktop/), unpacked (no asar):
// the server reads its pages and media from ordinary files, exactly as with `node server/index.js`.
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const { version, description } = require(path.join(root, 'package.json'));
const electronVersion = require('./node_modules/electron/package.json').version;

module.exports = {
  appId: 'io.github.blearymoth.openkaraoke',
  productName: 'OpenKaraoke',
  electronVersion,
  // Electron is unpacked from the npm package (no second download while packaging).
  electronDist: path.join(__dirname, 'node_modules', 'electron', 'dist'),
  directories: { app: root, output: path.join(__dirname, 'dist'), buildResources: path.join(__dirname, 'build') },
  extraMetadata: {
    main: 'desktop/main.mjs',
    productName: 'OpenKaraoke',
    version,
    author: { name: 'OpenKaraoke', email: 'blearymoth@users.noreply.github.com' },
    homepage: 'https://github.com/blearymoth/OpenKaraoke',
  },
  files: [
    'package.json',
    'LICENSE',
    'server/**/*',
    'public/**/*',
    'shared/**/*',
    'desktop/main.mjs',
    'desktop/displays.mjs',
    'desktop/preload.cjs',
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
    synopsis: 'Karaoke parties with your own songs',
    description,
    maintainer: 'OpenKaraoke <blearymoth@users.noreply.github.com>',
    vendor: 'OpenKaraoke',
    desktop: {
      entry: {
        Name: 'OpenKaraoke',
        GenericName: 'Karaoke',
        Comment: 'Karaoke parties with your own songs: TV screen, phones as remotes, games',
        Keywords: 'karaoke;party;singing;cdg;mp3+g;',
        StartupWMClass: 'OpenKaraoke',
      },
    },
  },
  appImage: { artifactName: 'OpenKaraoke-${version}.${ext}' },
  rpm: { artifactName: 'openkaraoke-${version}.${arch}.${ext}', packageName: 'openkaraoke' },
  deb: { artifactName: 'openkaraoke_${version}_${arch}.${ext}', packageName: 'openkaraoke' },
  publish: null,
};
