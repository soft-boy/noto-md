import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MD_EXT = /\.(md|markdown|mdown|mkd)$/i;
const IGNORED_DIRS = new Set(['node_modules', 'bower_components', '__pycache__']);
const MAX_ENTRIES = 20000;
const MAX_BODY = 20 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

const APP_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob: http: https:",
  "media-src 'self' http: https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isIgnored = (name) => name.startsWith('.') || IGNORED_DIRS.has(name);
const toPosix = (p) => p.split(path.sep).join('/');

export async function startServer({ root, port = 4242, strictPort = false, host = '127.0.0.1' }) {
  root = await fsp.realpath(root);
  const clients = new Set();
  let allowedHosts = new Set();

  // Resolve a workspace-relative path, refusing anything that escapes the root
  // (including through symlinks).
  async function resolve(rel, { mustExist = true } = {}) {
    if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new HttpError(400, 'Invalid path');
    const abs = path.resolve(root, ...rel.replace(/^\/+/, '').split('/'));
    const inside = (p) => p === root || p.startsWith(root + path.sep);
    if (!inside(abs)) throw new HttpError(403, 'Path is outside the workspace');
    let probe = abs;
    while (true) {
      try {
        const real = await fsp.realpath(probe);
        if (!inside(real)) throw new HttpError(403, 'Path is outside the workspace');
        if (probe !== abs && mustExist) throw new HttpError(404, 'Not found');
        return abs;
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (err.code !== 'ENOENT') throw err;
        if (mustExist) throw new HttpError(404, 'Not found');
        probe = path.dirname(probe);
      }
    }
  }

  async function buildTree() {
    let count = 0;
    async function walk(dir, rel) {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      const folders = [];
      const files = [];
      for (const e of entries) {
        if (isIgnored(e.name) || ++count > MAX_ENTRIES) continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          const children = await walk(path.join(dir, e.name), childRel);
          if (children.length) folders.push({ type: 'dir', name: e.name, path: childRel, children });
        } else if (MD_EXT.test(e.name) && (e.isFile() || e.isSymbolicLink())) {
          files.push({ type: 'file', name: e.name, path: childRel });
        }
      }
      const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      return [...folders.sort(byName), ...files.sort(byName)];
    }
    return walk(root, '');
  }

  function flatten(nodes, out = []) {
    for (const n of nodes) {
      if (n.type === 'file') out.push(n.path);
      else flatten(n.children, out);
    }
    return out;
  }

  async function search(q) {
    const needle = q.toLowerCase();
    const results = [];
    for (const rel of flatten(await buildTree())) {
      if (results.length >= 100) break;
      if (rel.toLowerCase().includes(needle)) results.push({ path: rel, line: 0, text: '' });
      let content;
      try {
        const abs = path.join(root, ...rel.split('/'));
        if ((await fsp.stat(abs)).size > 2 * 1024 * 1024) continue;
        content = await fsp.readFile(abs, 'utf8');
      } catch {
        continue;
      }
      if (!content.toLowerCase().includes(needle)) continue;
      let hits = 0;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && hits < 3; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          results.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
          hits++;
        }
      }
    }
    return results;
  }

  function broadcast(event) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(data);
  }

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(body);
  };
  const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': MIME['.json'] });

  async function readJson(req) {
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Expected JSON');
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, 'Body too large');
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
  }

  function requireMarkdown(rel) {
    if (!MD_EXT.test(rel)) throw new HttpError(400, 'Only Markdown files can be edited');
  }

  async function serveFile(res, abs, headers = {}) {
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) throw new HttpError(404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    fs.createReadStream(abs).pipe(res);
  }

  async function handle(req, res) {
    // Only answer requests addressed to this machine (blocks DNS rebinding),
    // and only state-changing requests from our own origin.
    if (!allowedHosts.has(req.headers.host)) throw new HttpError(403, 'Forbidden host');
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) {
      throw new HttpError(403, 'Forbidden origin');
    }

    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    const q = url.searchParams;

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), { 'Content-Security-Policy': APP_CSP });
    }
    if (req.method === 'GET' && p.startsWith('/static/')) {
      const abs = path.resolve(PUBLIC_DIR, decodeURIComponent(p.slice('/static/'.length)));
      if (!abs.startsWith(PUBLIC_DIR)) throw new HttpError(403, 'Forbidden');
      return serveFile(res, abs);
    }
    if (req.method === 'GET' && p.startsWith('/raw/')) {
      // Workspace assets (images etc). Sandboxed so an HTML/SVG file can never run script here.
      const abs = await resolve(decodeURIComponent(p.slice('/raw/'.length)));
      return serveFile(res, abs, { 'Content-Security-Policy': 'sandbox' });
    }

    if (p === '/api/info' && req.method === 'GET') {
      return json(res, 200, { name: path.basename(root), root });
    }
    if (p === '/api/tree' && req.method === 'GET') {
      return json(res, 200, await buildTree());
    }
    if (p === '/api/search' && req.method === 'GET') {
      const term = (q.get('q') || '').trim();
      return json(res, 200, term ? await search(term) : []);
    }
    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/file' && req.method === 'GET') {
      const rel = q.get('path');
      requireMarkdown(rel || '');
      const abs = await resolve(rel);
      const [content, st] = await Promise.all([fsp.readFile(abs, 'utf8'), fsp.stat(abs)]);
      return json(res, 200, { path: rel, content, mtime: st.mtimeMs });
    }
    if (p === '/api/file' && req.method === 'PUT') {
      const { path: rel, content, baseMtime, force } = await readJson(req);
      requireMarkdown(rel || '');
      if (typeof content !== 'string') throw new HttpError(400, 'Missing content');
      const abs = await resolve(rel, { mustExist: false });
      const before = await fsp.stat(abs).catch(() => null);
      if (!force && before && baseMtime != null && Math.abs(before.mtimeMs - baseMtime) > 1) {
        return json(res, 409, { error: 'File changed on disk', mtime: before.mtimeMs });
      }
      await fsp.writeFile(abs, content, 'utf8');
      const st = await fsp.stat(abs);
      return json(res, 200, { mtime: st.mtimeMs });
    }
    if (p === '/api/files' && req.method === 'POST') {
      const { path: rel, content = '' } = await readJson(req);
      requireMarkdown(rel || '');
      const abs = await resolve(rel, { mustExist: false });
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      try {
        await fsp.writeFile(abs, content, { encoding: 'utf8', flag: 'wx' });
      } catch (err) {
        if (err.code === 'EEXIST') throw new HttpError(409, 'A page with that name already exists');
        throw err;
      }
      broadcast({ type: 'tree' });
      return json(res, 201, { path: rel, mtime: (await fsp.stat(abs)).mtimeMs });
    }
    if (p === '/api/rename' && req.method === 'POST') {
      const { from, to } = await readJson(req);
      requireMarkdown(from || '');
      requireMarkdown(to || '');
      const src = await resolve(from);
      const dest = await resolve(to, { mustExist: false });
      if (fs.existsSync(dest) && src.toLowerCase() !== dest.toLowerCase()) {
        throw new HttpError(409, 'A page with that name already exists');
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(src, dest);
      broadcast({ type: 'tree' });
      return json(res, 200, { path: to });
    }

    throw new HttpError(404, 'Not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: err.message });
      else res.end();
    });
  });

  port = await listen(server, port, host, strictPort);
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  const watcher = watchWorkspace(root, broadcast);
  const ping = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25000);

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    root,
    close() {
      clearInterval(ping);
      watcher?.close();
      for (const res of clients) res.end();
      server.close();
    },
  };
}

function listen(server, port, host, strictPort) {
  return new Promise((resolve, reject) => {
    const attempt = (p, triesLeft) => {
      const onError = (err) => {
        if (err.code === 'EADDRINUSE' && !strictPort && triesLeft > 0) attempt(p + 1, triesLeft - 1);
        else reject(err);
      };
      server.once('error', onError);
      server.listen(p, host, () => {
        server.off('error', onError);
        resolve(server.address().port);
      });
    };
    attempt(port, 20);
  });
}

// Push file and tree changes to the browser so edits made elsewhere show up live.
function watchWorkspace(root, broadcast) {
  let watcher;
  try {
    watcher = fs.watch(root, { recursive: true });
  } catch {
    return null;
  }
  const fileTimers = new Map();
  let treeTimer;
  watcher.on('error', () => {});
  watcher.on('change', (type, filename) => {
    if (!filename) return;
    const rel = toPosix(filename.toString());
    if (rel.split('/').some(isIgnored)) return;
    if (type === 'rename' || !MD_EXT.test(rel)) {
      clearTimeout(treeTimer);
      treeTimer = setTimeout(() => broadcast({ type: 'tree' }), 250);
    }
    if (!MD_EXT.test(rel)) return;
    clearTimeout(fileTimers.get(rel));
    fileTimers.set(rel, setTimeout(async () => {
      fileTimers.delete(rel);
      const st = await fsp.stat(path.join(root, ...rel.split('/'))).catch(() => null);
      broadcast({ type: 'file', path: rel, mtime: st ? st.mtimeMs : null });
    }, 100));
  });
  return watcher;
}
