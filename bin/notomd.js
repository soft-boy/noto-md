#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer } from '../src/server.js';

const HELP = `
  notomd — a Notion-style editor for a folder of Markdown files

  Usage
    notomd [path] [options]

  Arguments
    path            Folder (or a single .md file) to open. Defaults to the current folder.

  Options
    -p, --port <n>  Port to listen on (default 4242, or the next free one)
    --no-open       Don't open the browser automatically
    -h, --help      Show this help
    -v, --version   Show the version
`;

function parseArgs(argv) {
  const opts = { target: '.', port: 4242, strictPort: false, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a === '--no-open') opts.open = false;
    else if (a === '-p' || a === '--port' || a.startsWith('--port=')) {
      const v = a.includes('=') ? a.split('=')[1] : argv[++i];
      opts.port = Number(v);
      opts.strictPort = true;
      if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) fail(`Invalid port: ${v}`);
    } else if (a.startsWith('-')) fail(`Unknown option: ${a}`);
    else opts.target = a;
  }
  return opts;
}

function fail(msg) {
  console.error(`notomd: ${msg}`);
  process.exit(1);
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
      : ['xdg-open', [url]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.log(`  Open ${url} in your browser.`));
  child.unref();
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}
if (opts.version) {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

const target = path.resolve(opts.target);
let stat;
try {
  stat = fs.statSync(target);
} catch {
  fail(`No such file or folder: ${opts.target}`);
}
const root = stat.isDirectory() ? target : path.dirname(target);
const initial = stat.isDirectory() ? '' : path.basename(target);

try {
  const server = await startServer({ root, port: opts.port, strictPort: opts.strictPort });
  const url = server.url + (initial ? `#/${encodeURI(initial)}` : '');
  console.log(`\n  noto-md is editing ${server.root}\n\n  ➜  ${url}\n\n  Press Ctrl+C to stop.\n`);
  if (opts.open) openBrowser(url);
  const stop = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (err) {
  fail(err.code === 'EADDRINUSE' ? `Port ${opts.port} is already in use.` : err.message);
}
