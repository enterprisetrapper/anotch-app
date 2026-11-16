const { mkdirSync, realpathSync } = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const headers = path.resolve(path.dirname(realpathSync(process.execPath)), '..', 'include', 'node');
mkdirSync(path.join(root, '.build'), { recursive: true });
execFileSync('/usr/bin/xcrun', ['clang++', '-arch', 'arm64', '-mmacosx-version-min=15.0', '-O2', '-shared', '-fobjc-arc',
  '-install_name', '@rpath/anotch-glass.node', '-undefined', 'dynamic_lookup', '-I', headers,
  '-framework', 'AppKit', '-framework', 'QuartzCore',
  path.join(__dirname, 'glass.mm'), '-o', path.join(root, '.build', 'anotch-glass.node')], { stdio: 'inherit' });
