'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const https = require('https');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

/** ====== 你需要改的配置 ====== **/
const UUID = 'e0d103e8-a108-407f-9ec9-1c5368128833'; // 改成你自己的 UUID
const NAME = 'cf-vless';                             // 节点名称
const WS_PATH = '/ws-node';                               // WS 路径（保持以 / 开头）
/** ============================ **/

// 面板给你的唯一端口
const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || '7681', 10);

// 订阅路径
const SUB_PATH = '/sub';        // Base64（V2RayN风格）
const RAW_PATH = '/sub.txt';    // 明文
const CLASH_PATH = '/clash';    // Clash.Meta YAML

// cloudflared 位置与下载源（amd64）
const BIN_DIR = path.join(process.cwd(), 'bin');
const CLOUDFLARED_PATH = path.join(BIN_DIR, 'cloudflared');
const CLOUDFLARED_URL =
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('UUID 格式不正确');
  return Buffer.from(hex, 'hex');
}
const UUID_BYTES = uuidToBytes(UUID);

function safeMkdirp(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function downloadWithRedirect(url, outPath, maxRedirect = 5) {
  return new Promise((resolve, reject) => {
    const doReq = (u, left) => {
      const req = https.get(u, { headers: { 'User-Agent': 'node' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (left <= 0) return reject(new Error('下载重定向次数过多'));
          res.resume();
          return doReq(res.headers.location, left - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`下载失败，HTTP ${res.statusCode}`));
        }
        const tmp = outPath + '.tmp';
        const file = fs.createWriteStream(tmp, { mode: 0o755 });
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            fs.renameSync(tmp, outPath);
            fs.chmodSync(outPath, 0o755);
            resolve();
          });
        });
        file.on('error', (e) => {
          try { fs.unlinkSync(tmp); } catch {}
          reject(e);
        });
      });
      req.on('error', reject);
      req.setTimeout(20000, () => req.destroy(new Error('下载超时')));
    };
    doReq(url, maxRedirect);
  });
}

async function ensureCloudflared() {
  safeMkdirp(BIN_DIR);
  if (fs.existsSync(CLOUDFLARED_PATH)) return;
  console.log(`[init] downloading cloudflared -> ${CLOUDFLARED_PATH}`);
  await downloadWithRedirect(CLOUDFLARED_URL, CLOUDFLARED_PATH);
}

function parseTryCloudflareHost(line) {
  const m = String(line).match(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/i);
  return m ? `${m[1]}.trycloudflare.com` : null;
}

/**
 * VLESS header minimal parse:
 * ver(1)=0x00 | uuid(16) | optLen(1) | opt | cmd(1) | port(2) | addrType(1) | addr | payload
 * response: ver(1)=0x00 | addLen(1)=0x00
 */
function tryParseVlessHeader(buf) {
  if (buf.length < 1 + 16 + 1 + 1 + 2 + 1) return null;

  let p = 0;
  const ver = buf[p++];

  if (ver !== 0x00) throw new Error('VLESS version 不支持');

  const id = buf.subarray(p, p + 16); p += 16;
  if (!id.equals(UUID_BYTES)) throw new Error('UUID 不匹配');

  const optLen = buf[p++]; 
  if (buf.length < p + optLen + 1 + 2 + 1) return null;
  p += optLen;

  const cmd = buf[p++]; // 0x01 TCP
  const port = buf.readUInt16BE(p); p += 2;
  const addrType = buf[p++];

  let host;
  if (addrType === 0x01) { // ipv4
    if (buf.length < p + 4) return null;
    host = `${buf[p++]}.${buf[p++]}.${buf[p++]}.${buf[p++]}`;
  } else if (addrType === 0x02) { // domain
    if (buf.length < p + 1) return null;
    const len = buf[p++]; 
    if (buf.length < p + len) return null;
    host = buf.subarray(p, p + len).toString('utf8');
    p += len;
  } else if (addrType === 0x03) { // ipv6
    if (buf.length < p + 16) return null;
    const raw = buf.subarray(p, p + 16); p += 16;
    const parts = [];
    for (let i = 0; i < 16; i += 2) parts.push(raw.readUInt16BE(i).toString(16));
    host = parts.join(':');
  } else {
    throw new Error('addrType 不支持');
  }

  const payload = buf.subarray(p);
  return { cmd, host, port, payload };
}

function buildVlessUri(host) {
  // 关键：把 host + sni 都补齐；path 必须 URL encode
  const tag = encodeURIComponent(NAME);
  const p = encodeURIComponent(WS_PATH);
  return `vless://${UUID}@${host}:443?encryption=none&security=tls&type=ws&host=${host}&sni=${host}&path=${p}#${tag}`;
}

function buildV2RayNBase64(lines) {
  // v2rayN：把各行用 \n 拼起来，再 base64（不强制 base64url）
  const joined = lines.join('\n') + '\n';
  return Buffer.from(joined, 'utf8').toString('base64');
}

function buildClashMetaYaml(host) {
  // Clash.Meta 文档要求：servername（SNI）与 ws-opts.headers.Host :contentReference[oaicite:5]{index=5}
  const name = NAME.replace(/"/g, '\\"');
  return `mixed-port: 7890
allow-lan: true
mode: rule
log-level: info

proxies:
  - name: "${name}"
    type: vless
    server: ${host}
    port: 443
    uuid: ${UUID}
    tls: true
    servername: ${host}
    network: ws
    udp: true
    ws-opts:
      path: "${WS_PATH}"
      headers:
        Host: ${host}

proxy-groups:
  - name: "PROXY"
    type: select
    proxies:
      - "${name}"

rules:
  - MATCH,PROXY
`;
}

async function main() {
  let currentHost = null;

  const server = http.createServer((req, res) => {
    if (!currentHost) {
      // Tunnel 还未建立：返回提示
      if ([SUB_PATH, RAW_PATH, CLASH_PATH].includes(req.url)) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Tunnel 尚未就绪，请等待控制台出现 trycloudflare 域名。\n');
        return;
      }
    }

    if (req.url === RAW_PATH) {
      const uri = buildVlessUri(currentHost);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(uri + '\n');
      return;
    }

    if (req.url === SUB_PATH) {
      const uri = buildVlessUri(currentHost);
      const b64 = buildV2RayNBase64([uri]);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(b64);
      return;
    }

    if (req.url === CLASH_PATH) {
      const yaml = buildClashMetaYaml(currentHost);
      res.writeHead(200, { 'content-type': 'text/yaml; charset=utf-8' });
      res.end(yaml);
      return;
    }

    // 伪装成普通站点响应
    res.writeHead(204);
    res.end();
  });

  const wss = new WebSocketServer({
    server,
    path: WS_PATH,
    perMessageDeflate: false,
    maxPayload: 16 * 1024 * 1024
  });

  wss.on('connection', (ws) => {
    let buffer = Buffer.alloc(0);
    let remote = null;
    let ready = false;

    function cleanup() {
      try { ws.close(); } catch {}
      if (remote) {
        try { remote.destroy(); } catch {}
        remote = null;
      }
    }

    ws.on('message', (data) => {
      try {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);

        if (!ready) {
          buffer = Buffer.concat([buffer, chunk]);
          const parsed = tryParseVlessHeader(buffer);
          if (!parsed) return;

          const { cmd, host, port, payload } = parsed;
          if (cmd !== 0x01) throw new Error('仅支持 TCP（cmd=0x01）');

          remote = net.connect({ host, port }, () => {
            ws.send(Buffer.from([0x00, 0x00])); // 最小响应头
            if (payload.length) remote.write(payload);
            ready = true;
          });

          remote.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
          remote.on('error', cleanup);
          remote.on('close', cleanup);
          return;
        }

        if (remote && remote.writable) remote.write(chunk);
      } catch {
        cleanup();
      }
    });

    ws.on('close', () => { if (remote) try { remote.destroy(); } catch {} });
    ws.on('error', () => { if (remote) try { remote.destroy(); } catch {} });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[http] listening on :${PORT}  ws=${WS_PATH}`);
  });

  // 必须 cloudflared 才能有 tunnel（无公网 IP 场景）
  await ensureCloudflared();

  const cf = spawn(CLOUDFLARED_PATH, [
    'tunnel',
    '--no-autoupdate',
    '--protocol', 'http2',
    '--url', `http://127.0.0.1:${PORT}`
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const onLine = (line) => {
    const host = parseTryCloudflareHost(line);
    if (host && host !== currentHost) {
      currentHost = host;
      const uri = buildVlessUri(host);

      console.log('');
      console.log('==================== 连接信息 ====================');
      console.log(`[VLESS URI] ${uri}`);
      console.log(`[V2RayN订阅] https://${host}${SUB_PATH}   (Base64 换行链接列表)`);
      console.log(`[明文订阅]  https://${host}${RAW_PATH}`);
      console.log(`[Clash.Meta] https://${host}${CLASH_PATH} (YAML)`);
      console.log('=================================================');
      console.log('');
    }
  };

  cf.stdout.on('data', (d) => String(d).split('\n').forEach(onLine));
  cf.stderr.on('data', (d) => String(d).split('\n').forEach(onLine));

  cf.on('exit', (code, sig) => {
    console.error(`[cloudflared] exited code=${code} sig=${sig}`);
    process.exit(1);
  });
}

main().catch((e) => {
  console.error('[fatal]', e && e.stack ? e.stack : e);
  process.exit(1);
});
