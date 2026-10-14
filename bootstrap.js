#!/usr/bin/env node
/**
 * Infrlo bootstrap: pure-Node (no curl/wget/python in this runtime).
 * Downloads sing-box + cloudflared from GitHub releases, starts a VLESS+WS node
 * behind a cloudflared tunnel, and (optionally) the Nezha v0 agent.
 *
 * Env: UUID, NAME, SUB_PATH, ARGO_DOMAIN, ARGO_AUTH, ARGO_PORT,
 *      NEZHA_SERVER, NEZHA_PORT, NEZHA_KEY, PORT
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const UUID = process.env.UUID || 'a88797dd-b408-4ca2-95ec-4259655a685e';
const NAME = process.env.NAME || 'infrlo-node';
const SUB_PATH = process.env.SUB_PATH || 'sub';
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const ARGO_AUTH = process.env.ARGO_AUTH || '';
const NEZHA_SERVER = process.env.NEZHA_SERVER || '';
const NEZHA_PORT = process.env.NEZHA_PORT || '';
const NEZHA_KEY = process.env.NEZHA_KEY || '';
const HTTP_PORT = Number(process.env.PORT) || 5000;
const WS_PORT = 8080;
const WORK = process.env.WORK_DIR || '/app/.node';
const BIN = path.join(WORK, 'bin');
const ARCH = os.arch() === 'arm64' ? 'arm64' : 'amd64';

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDirs() {
  for (const d of [WORK, BIN]) fs.mkdirSync(d, { recursive: true });
}

async function download(url, dest, { retries = 3, timeout = 180000 } = {}) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100000) {
    log(`cached: ${dest} (${fs.statSync(dest).size} bytes)`);
    return dest;
  }
  for (let i = 1; i <= retries; i++) {
    try {
      const ctl = AbortSignal.timeout(timeout);
      const res = await fetch(url, { redirect: 'follow', signal: ctl });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error(`too small: ${buf.length}`);
      fs.writeFileSync(dest, buf);
      log(`downloaded ${url} -> ${dest} (${buf.length} bytes)`);
      return dest;
    } catch (e) {
      log(`download attempt ${i}/${retries} failed for ${url}: ${e.message}`);
      await sleep(3000 * i);
    }
  }
  throw new Error(`download failed: ${url}`);
}

/** minimal zip extractor (stored/deflate) */
function unzipTo(zipPath, outDir) {
  const buf = fs.readFileSync(zipPath);
  fs.mkdirSync(outDir, { recursive: true });
  // locate End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const written = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    // local header
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + csize);
    const target = path.join(outDir, name);
    if (name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, method === 8 ? zlib.inflateRawSync(data) : data);
      written.push(target);
      log(`  unzipped ${name} (${method === 8 ? 'deflate' : 'stored'})`);
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return written;
}

async function getSingBox() {
  const bin = path.join(BIN, 'sing-box');
  if (fs.existsSync(bin)) return bin;
  const rel = 'v1.10.1';
  const url = `https://github.com/SagerNet/sing-box/releases/download/${rel}/sing-box-1.10.1-linux-${ARCH}.tar.gz`;
  const tgz = path.join(WORK, 'sing-box.tar.gz');
  await download(url, tgz);
  execFileSync('tar', ['-xzf', tgz, '-C', WORK], { stdio: 'inherit' });
  const src = path.join(WORK, `sing-box-1.10.1-linux-${ARCH}`, 'sing-box');
  fs.copyFileSync(src, bin);
  fs.chmodSync(bin, 0o755);
  log(`sing-box ready: ${execFileSync(bin, ['version'], { encoding: 'utf8' }).trim()}`);
  return bin;
}

async function getCloudflared() {
  const bin = path.join(BIN, 'cloudflared');
  if (fs.existsSync(bin)) return bin;
  await download(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}`, bin);
  fs.chmodSync(bin, 0o755);
  return bin;
}

async function getNezhaAgent() {
  const dest = path.join(BIN, 'nezha-agent');
  if (fs.existsSync(dest)) return dest;
  const zip = path.join(WORK, 'nezha-agent.zip');
  await download('https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_amd64.zip', zip);
  const files = unzipTo(zip, path.join(WORK, 'nezha'));
  const real = files.find((f) => f.endsWith('nezha-agent')) || files[0];
  fs.copyFileSync(real, dest);
  fs.chmodSync(dest, 0o755);
  log(`nezha agent ready: ${dest}`);
  return dest;
}

function writeSingBoxConfig() {
  const cfg = {
    log: { level: 'info', timestamp: true },
    inbounds: [
      {
        type: 'vless',
        tag: 'vless-ws',
        listen: '127.0.0.1',
        listen_port: WS_PORT,
        users: [{ uuid: UUID, flow: '' }],
        transport: { type: 'ws', path: '/ws' },
      },
    ],
    outbounds: [
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' },
    ],
  };
  const p = path.join(WORK, 'config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

function startProc(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const tag = `[${name}]`;
  child.stdout.on('data', (d) => process.stdout.write(`${tag} ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`${tag} ${d}`));
  child.on('exit', (code, sig) => log(`${name} exited code=${code} sig=${sig}`));
  return child;
}

async function main() {
  log('=== infrlo bootstrap ===');
  log(`arch=${ARCH} node=${process.version} cpus=${os.cpus().length} mem=${Math.round(os.totalmem() / 1024 / 1024)}MB uid=${process.getuid()}`);
  ensureDirs();

  // egress sanity
  try {
    const r = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(15000) });
    log('egress IP:', (await r.text()).trim());
  } catch (e) {
    log('egress test FAILED:', e.message);
  }

  const sbox = await getSingBox();
  const cfg = writeSingBoxConfig();
  let cfd = null;
  if (!ARGO_DOMAIN) {
    try { cfd = await getCloudflared(); } catch (e) { log('cloudflared unavailable:', e.message); }
  }
  let nezha = null;
  if (NEZHA_SERVER && NEZHA_KEY) {
    try { nezha = await getNezhaAgent(); } catch (e) { log('nezha agent unavailable:', e.message); }
  }

  startProc('sing-box', sbox, ['run', '-c', cfg]);
  await sleep(2000);

  let argoHost = ARGO_DOMAIN;
  if (cfd) {
    const args = ARGO_AUTH
      ? ['tunnel', '--no-autoupdate', '--edge-ip-version', 'auto', 'run', '--token', ARGO_AUTH]
      : ['tunnel', '--no-autoupdate', '--edge-ip-version', 'auto', '--url', `http://127.0.0.1:${WS_PORT}`];
    const p = spawn(cfd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => process.stdout.write(`[argo] ${d}`));
    p.stderr.on('data', (d) => {
      const s = d.toString();
      process.stdout.write(`[argo] ${s}`);
      const m = s.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i);
      if (m && !argoHost) {
        argoHost = m[1];
        log(`ARGO TUNNEL: https://${argoHost}`);
        printLink(argoHost);
      }
    });
    p.on('exit', (c) => log(`cloudflared exited ${c}`));
  }

  if (nezha) {
    const args = ['-s', NEZHA_SERVER.includes(':') ? NEZHA_SERVER : `${NEZHA_SERVER}:${NEZHA_PORT || 443}`, '-p', NEZHA_KEY];
    if (['443', '8443', '2096', '2087', '2083', '2053'].includes(String(NEZHA_PORT))) args.push('--tls');
    startProc('nezha', nezha, args);
  } else {
    log('nezha: skipped (NEZHA_SERVER/NEZHA_KEY not set)');
  }

  // subscription HTTP server (for reference / platform health checks)
  http
    .createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(argoHost ? `${link(argoHost)}\n` : 'bootstrap up, waiting for tunnel\n');
    })
    .listen(HTTP_PORT, '0.0.0.0', () => log(`subscription server on :${HTTP_PORT}/${SUB_PATH}`));

  if (argoHost) printLink(argoHost);

  let i = 0;
  for (;;) {
    await sleep(60000);
    i++;
    log(`alive ${i}m  rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`);
  }
}

function link(host) {
  return `vless://${UUID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=chrome&type=ws&host=${host}&path=%2Fws&allowInsecure=0#${encodeURIComponent(NAME)}`;
}
function printLink(host) {
  log('=== NODE LINK ===');
  log(link(host));
  try { fs.writeFileSync(path.join(WORK, 'list.txt'), link(host) + '\n'); } catch {}
}

main().catch((e) => {
  log('FATAL', e.stack || e.message);
  process.exit(1);
});
