const { readdirSync, readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

for (const folder of ['src', 'src/renderer', 'scripts']) {
  for (const file of readdirSync(folder).filter((entry) => entry.endsWith('.js'))) {
    execFileSync(process.execPath, ['--check', join(folder, file)], { stdio: 'inherit' });
  }
}
const renderer = 'src/renderer';
const page = readFileSync(join(renderer, 'index.html'), 'utf8');
const ids = [...page.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
if (new Set(ids).size !== ids.length) throw new Error('Renderer has duplicate element IDs');
for (const match of page.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
  const file = match[1] === 'shared.js' ? 'src/shared.js' : join(renderer, match[1]);
  if (!existsSync(file)) throw new Error('Missing renderer asset: ' + file);
}
console.log('Anotch syntax and renderer assets verified');
