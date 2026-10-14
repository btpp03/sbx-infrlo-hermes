#!/usr/bin/env node
/**
 * Infrlo bootstrap — pure Node (this gVisor runtime has no curl/wget/python/git/unzip
 * and no system CA store, so everything is fetched with Node's bundled CA + own unzip).
 *
 * Brings up:  Xray-core (VLESS + WS)  ->  cloudflared quick tunnel  ->  optional Nezha v0 agent
 *
 * Env: UUID NAME SUB_PATH ARGO_DOMAIN ARGO_AUTH NEZHA_SERVER NEZHA_PORT NEZHA_KEY PORT
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
const X64 = os.arch() !== 'arm64';

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHILD_ENV = () => ({ ...process.env, SSL_CERT_FILE: CACERT, PATH: `${BIN}:${process.env.PATH}` });
let CACERT = path.join(WORK, 'cacert.pem');

function ensureDirs() { for (const d of [WORK, BIN]) fs.mkdirSync(d, { recursive: true }); }

async function download(url, dest, { retries = 3, timeout = 240000, minSize = 1000 } = {}) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > minSize) { log(`cached: ${path.basename(dest)}`); return dest; }
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeout) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < minSize) throw new Error(`too small: ${buf.length}`);
      fs.writeFileSync(dest, buf);
      log(`downloaded ${path.basename(dest)} (${buf.length} bytes) from ${new URL(url).host}`);
      return dest;
    } catch (e) {
      log(`download ${i}/${retries} failed ${url}: ${e.message}`);
      await sleep(3000 * i);
    }
  }
  throw new Error(`download failed: ${url}`);
}

/** minimal zip extractor (stored + deflate), uses the central directory */
function unzipTo(zipPath, outDir) {
  const buf = fs.readFileSync(zipPath);
  fs.mkdirSync(outDir, { recursive: true });
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
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + csize);
    const target = path.join(outDir, name);
    if (name.endsWith('/')) fs.mkdirSync(target, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, method === 8 ? zlib.inflateRawSync(data) : data);
      log(`  + ${name}`);
      written.push(target);
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return written;
}

function chmodX(p) { fs.chmodSync(p, 0o755); return p; }

async function getCacert() {
  await download('https://curl.se/ca/cacert.pem', CACERT, { minSize: 50000 });
  return CACERT;
}

async function getXray() {
  const dest = path.join(BIN, 'xray');
  if (fs.existsSync(dest)) return dest;
  const zip = path.join(WORK, 'xray.zip');
  await download(`https://github.com/XTLS/Xray-core/releases/latest/download/${X64 ? 'Xray-linux-64' : 'Xray-linux-arm64-v8a'}.zip`, zip);
  const files = unzipTo(zip, path.join(WORK, 'xray'));
  const real = files.find((f) => f.endsWith('/xray')) || files[0];
  fs.copyFileSync(real, dest); chmodX(dest);
  log('xray ready:', execFileSync(dest, ['version'], { encoding: 'utf8', env: CHILD_ENV() }).split('\n')[0]);
  return dest;
}

async function getCloudflared() {
  const dest = path.join(BIN, 'cloudflared');
  if (fs.existsSync(dest)) return dest;
  await download(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${X64 ? 'amd64' : 'arm64'}`, dest, { minSize: 1000000 });
  return chmodX(dest);
}

async function getNezhaAgent() {
  const dest = path.join(BIN, 'nezha-agent');
  if (fs.existsSync(dest)) return dest;
  const zip = path.join(WORK, 'nezha-agent.zip');
  // pin the v0 agent line (last tag v0.20.5): panel is nezha v0.17.9
  const ver = process.env.NEZHA_AGENT_VERSION || 'v0.20.5';
  const archAgent = os.arch() === 'arm64' ? 'arm64' : 'amd64';
  for (const url of [
    `https://github.com/nezhahq/agent/releases/download/${ver}/nezha-agent_linux_${archAgent}.zip`,
    `https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_${archAgent}.zip`,
  ]) {
    try {
      await download(url, zip);
      break;
    } catch (e) { log('nezha download failed:', url, e.message); }
  }
  const files = unzipTo(zip, path.join(WORK, 'nezha'));
  const real = files.find((f) => f.endsWith('nezha-agent')) || files[0];
  fs.copyFileSync(real, dest); chmodX(dest);
  fs.copyFileSync(real, path.join(BIN, 'nezha-agent.pinned')); chmodX(path.join(BIN, 'nezha-agent.pinned'));
  return dest;
}

function writeXrayConfig() {
  const cfg = {
    log: { loglevel: 'warning' },
    inbounds: [{
      listen: '127.0.0.1', port: WS_PORT, protocol: 'vless',
      settings: { clients: [{ id: UUID, level: 0 }], decryption: 'none' },
      streamSettings: { network: 'ws', security: 'none', wsSettings: { path: '/ws' } },
      sniffing: { enabled: true, destOverride: ['http', 'tls'] },
    }],
    outbounds: [{ protocol: 'freedom', tag: 'direct' }],
  };
  const p = path.join(WORK, 'xray.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

function startProc(name, cmd, args) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: CHILD_ENV() });
  const tag = `[${name}]`;
  child.stdout.on('data', (d) => process.stdout.write(`${tag} ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`${tag} ${d}`));
  child.on('exit', (c, s) => log(`${name} exited code=${c} sig=${s}`));
  return child;
}

function link(host) {
  return `vless://${UUID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=chrome&type=ws&host=${host}&path=%2Fws&allowInsecure=0#${encodeURIComponent(NAME)}`;
}

/** Nezha agent.
 *  The panel here is a v0 (0.17.9) box -> needs the v0 agent line (last tag v0.20.5),
 *  which still takes the classic "-s server:port -p secret [--tls]" flags.
 *  If the agent rejects those flags we fall back to the v1+ config-file interface.
 *  The agent force-updates itself on start, so we keep a pinned copy and re-copy it
 *  before every (re)spawn. */
function extractAgent() {
  const pinned = path.join(BIN, 'nezha-agent.pinned');
  const dest = path.join(BIN, 'nezha-agent');
  fs.copyFileSync(pinned, dest);
  chmodX(dest);
  return dest;
}

function writeNezhaConfig() {
  const { srv, tls } = nezhaTarget();
  const yaml = [
    'debug: false',
    `server: ${srv}`,
    `client_secret: ${NEZHA_KEY}`,
    `tls: ${tls}`,
    'insecure_tls: false',
    'disable_auto_update: true',
    'disable_force_update: true',
    'disable_command_execute: false',
    'disable_nat: false',
    'disable_send_query: false',
    'use_gitee_to_upgrade: false',
    'report_delay: 3',
    '',
  ].join('\n');
  const p = path.join(WORK, 'nezha-config.yaml');
  fs.writeFileSync(p, yaml);
  return p;
}

function nezhaTarget() {
  const srv = NEZHA_SERVER.includes(':') ? NEZHA_SERVER : `${NEZHA_SERVER}:${NEZHA_PORT || 443}`;
  const tls = ['443', '8443', '2096', '2087', '2083', '2053'].includes(String(NEZHA_PORT));
  return { srv, tls };
}

function startNezhaSupervised() {
  const { srv, tls } = nezhaTarget();
  let mode = process.env.NEZHA_ARG_MODE || 'flags';
  let tries = 0;
  log(`nezha target ${srv} tls=${tls} mode=${mode}`);
  const boot = () => {
    let bin;
    try { bin = extractAgent(); } catch (e) { log('nezha extract failed:', e.message); return; }
    const args = mode === 'flags' ? ['-s', srv, '-p', NEZHA_KEY, ...(tls ? ['--tls'] : [])] : ['-c', writeNezhaConfig()];
    const env = {
      ...CHILD_ENV(),
      NZ_SERVER: srv, NZ_CLIENT_SECRET: NEZHA_KEY, NZ_TLS: tls ? 'true' : 'false',
      NZ_DISABLE_AUTO_UPDATE: 'true', NZ_DISABLE_FORCE_UPDATE: 'true', NZ_REPORT_DELAY: '3',
    };
    log(`starting nezha: ${mode} ${args.join(' ').replace(NEZHA_KEY, '***')}`);
    const startedAt = Date.now();
    const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: WORK });
    c.stdout.on('data', (d) => process.stdout.write(`[nezha] ${d}`));
    c.stderr.on('data', (d) => process.stdout.write(`[nezha] ${d}`));
    c.on('exit', (code) => {
      if (mode === 'flags' && Date.now() - startedAt < 8000) {
        log('nezha: flag interface rejected -> switching to config-file mode');
        mode = 'config';
        setTimeout(boot, 2000);
        return;
      }
      tries++;
      if (tries <= 10) {
        log(`nezha exited code=${code} -> respawn #${tries} in 6s`);
        setTimeout(boot, 6000);
      } else {
        log('nezha: giving up after 10 restarts');
      }
    });
  };
  boot();
}

async function main() {
  log('=== infrlo bootstrap v2 (xray) ===');
  log(`arch=${os.arch()} node=${process.version} cpus=${os.cpus().length} mem=${Math.round(os.totalmem() / 1048576)}MB uid=${process.getuid()} work=${WORK}`);
  ensureDirs();
  try {
    const r = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(15000) });
    log('egress IP:', (await r.text()).trim());
  } catch (e) { log('egress FAILED:', e.message); }

  await getCacert();
  const xray = await getXray();
  const cfg = writeXrayConfig();
  let cfd = null;
  if (!ARGO_DOMAIN) {
    try { cfd = await getCloudflared(); } catch (e) { log('cloudflared unavailable:', e.message); }
  }
  let nezha = null;
  if (NEZHA_SERVER && NEZHA_KEY) {
    try { nezha = await getNezhaAgent(); } catch (e) { log('nezha agent unavailable:', e.message); }
  }

  startProc('xray', xray, ['-c', cfg]);
  await sleep(2500);

  let argoHost = ARGO_DOMAIN;
  if (cfd) {
    const args = ARGO_AUTH
      ? ['tunnel', '--no-autoupdate', '--edge-ip-version', 'auto', 'run', '--token', ARGO_AUTH]
      : ['tunnel', '--no-autoupdate', '--edge-ip-version', 'auto', '--url', `http://127.0.0.1:${WS_PORT}`];
    const p = spawn(cfd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: CHILD_ENV() });
    p.stdout.on('data', (d) => process.stdout.write(`[argo] ${d}`));
    p.stderr.on('data', (d) => {
      const s = d.toString();
      process.stdout.write(`[argo] ${s}`);
      for (const line of s.split('\n')) {
        if (line.includes('ERR') || line.includes('failed')) continue;
        const m = line.match(/https:\/\/([a-z0-9][a-z0-9-]*\.trycloudflare\.com)/i);
        if (m && m[1] !== 'api.trycloudflare.com' && !argoHost) {
          argoHost = m[1];
          log(`=== ARGO TUNNEL: https://${argoHost} ===`);
          log('=== NODE LINK: ' + link(argoHost));
          try { fs.writeFileSync(path.join(WORK, 'list.txt'), link(argoHost) + '\n'); } catch {}
        }
      }
    });
    p.on('exit', (c) => log(`cloudflared exited ${c}`));
  }

  if (nezha) {
    startNezhaSupervised();
  } else {
    log('nezha: skipped (NEZHA_SERVER/NEZHA_KEY not set)');
  }

  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end((argoHost ? link(argoHost) : 'bootstrap up, no tunnel yet') + '\n');
  }).listen(HTTP_PORT, '0.0.0.0', () => log(`sub server on :${HTTP_PORT}${SUB_PATH ? '/' + SUB_PATH : ''}`));

  let i = 0;
  for (;;) {
    await sleep(60000);
    i++;
    log(`alive ${i}m rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`);
  }
}

main().catch((e) => { log('FATAL', e.stack || e.message); process.exit(1); });
