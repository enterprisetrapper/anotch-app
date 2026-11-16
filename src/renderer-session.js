const path = require('node:path');
const fs = require('node:fs/promises');

const SCHEME = 'anotch';
const START_URL = SCHEME + '://workspace/index.html';
const SETTINGS_URL = SCHEME + '://workspace/settings.html';
const ASSETS = new Set(['index.html', 'styles.css', 'app.js', 'audio.js', 'settings.html', 'settings.css', 'settings.js', 'shared.js', 'answer-view.js', 'notch-view.js', 'logo.png']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function setupRendererSession(session, getWorkspace, logoPath) {
  session.protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const file = url.pathname.slice(1);
    if ((request.method !== 'GET' && request.method !== 'HEAD') || url.host !== 'workspace'
        || url.username || url.password || url.search || !ASSETS.has(file)) {
      return new Response('Not found', { status: 404 });
    }
    const filePath = file === 'shared.js' ? path.join(__dirname, file) : path.join(__dirname, 'renderer', file);
    const headers = { 'Content-Type': TYPES[path.extname(file)], 'X-Content-Type-Options': 'nosniff' };
    if (file.endsWith('.html')) headers['Content-Security-Policy'] = CSP;
    try { return new Response(request.method === 'HEAD' ? null : await fs.readFile(file === 'logo.png' ? logoPath : filePath), { headers }); }
    catch { return new Response('Not found', { status: 404 }); }
  });

  const inWorkspace = (contents) => contents && contents === getWorkspace()?.webContents && contents.getURL() === START_URL;
  session.setPermissionCheckHandler((contents, permission, _origin, details) =>
    Boolean(inWorkspace(contents) && permission === 'media' && details.mediaType === 'audio'));
  session.setPermissionRequestHandler((contents, permission, respond, details) =>
    respond(Boolean(inWorkspace(contents) && permission === 'media' && details.isMainFrame !== false
      && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio')));
}

module.exports = { SCHEME, START_URL, SETTINGS_URL, setupRendererSession };
