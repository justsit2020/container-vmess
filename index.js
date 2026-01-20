/* eslint-disable no-console */
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");

const httpProxy = require("http-proxy");
const AdmZip = require("adm-zip");

// ====== Platform ports ======
const HTTP_PORT = Number(process.env.PORT || 3000);          // 平台注入 PORT=7682
const XRAY_LOCAL_PORT = Number(process.env.XRAY_LOCAL_PORT || 10000); // 容器内部端口
const WS_PATH = process.env.WS_PATH || "/ws";

// Basic-auth protect /info & /sub (optional)
const INFO_USER = process.env.INFO_USER || "";
const INFO_PASS = process.env.INFO_PASS || "";

// ====== Runtime dirs (must be writable) ======
const BASE_DIR = process.env.BASE_DIR || path.join(os.tmpdir(), "vmess-ws");
const BIN_DIR = path.join(BASE_DIR, "bin");
const XRAY_DIR = path.join(BIN_DIR, "xray");
const CF_DIR = path.join(BIN_DIR, "cloudflared");

// ====== IDs ======
const UUID = process.env.UUID || crypto.randomUUID();
const ALTER_ID = 0;

// Runtime state
let publicHost = process.env.PUBLIC_HOST || ""; // 会被 cloudflared 自动抓取覆盖
let xrayReady = false;
let cloudflaredUrl = "";

// ---------- helpers ----------
async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}
async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}
function now() {
  return new Date().toISOString();
}
function log(...args) {
  console.log(...args);
}
function warn(...args) {
  console.warn(...args);
}
function fatal(...args) {
  console.error(...args);
  process.exit(1);
}

function basicAuthOk(req) {
  if (!INFO_USER || !INFO_PASS) return true; // 未设置就不保护（会打印警告）
  const h = req.headers["authorization"] || "";
  if (!h.startsWith("Basic ")) return false;
  const raw = Buffer.from(h.slice(6), "base64").toString("utf8");
  const [u, p] = raw.split(":");
  return u === INFO_USER && p === INFO_PASS;
}

async function downloadToFile(url, filePath) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  if (!res.body) throw new Error(`Empty body downloading ${url}`);

  await ensureDir(path.dirname(filePath));

  // Node fetch => Web ReadableStream; convert to Node stream before pipeline
  const nodeReadable = Readable.fromWeb(res.body);
  const ws = fs.createWriteStream(filePath);
  await pipeline(nodeReadable, ws);
}

function archTagXray() {
  // Xray release assets naming
  // We only map common cases; you can override with XRAY_ZIP_URL
  const a = process.arch;
  if (a === "arm64") return "Xray-linux-arm64-v8a.zip";
  if (a === "x64") return "Xray-linux-64.zip";
  return "Xray-linux-64.zip";
}

function archTagCloudflared() {
  // cloudflared release assets
  const a = process.arch;
  if (a === "arm64") return "cloudflared-linux-arm64";
  if (a === "x64") return "cloudflared-linux-amd64";
  return "cloudflared-linux-amd64";
}

function makeVmessLink(hostname) {
  // Client connects to Cloudflare edge with TLS, so tls=true, port=443.
  // Origin behind tunnel is plain http->ws.
  const obj = {
    v: "2",
    ps: "vmess-ws",
    add: hostname || "YOUR_TRYCLOUDFLARE_HOST",
    port: "443",
    id: UUID,
    aid: String(ALTER_ID),
    scy: "auto",
    net: "ws",
    type: "none",
    host: hostname || "YOUR_TRYCLOUDFLARE_HOST",
    path: WS_PATH,
    tls: "tls"
  };
  const b64 = Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
  return `vmess://${b64}`;
}

function textInfo() {
  const host = publicHost || "YOUR_TRYCLOUDFLARE_HOST";
  return [
    `time: ${now()}`,
    `http_port: ${HTTP_PORT}`,
    `ws_path: ${WS_PATH}`,
    `uuid: ${UUID}`,
    `public_host: ${publicHost || ""}`,
    `cloudflared_url: ${cloudflaredUrl || ""}`,
    ``,
    `vmess:`,
    makeVmessLink(host),
    ``
  ].join("\n");
}

// ---------- Xray ----------
async function ensureXray() {
  await ensureDir(XRAY_DIR);

  const xrayBin = path.join(XRAY_DIR, "xray");
  if (await exists(xrayBin)) return xrayBin;

  log(`[init] Xray not found, downloading...`);
  const zipName = archTagXray();
  const url = process.env.XRAY_ZIP_URL ||
    `https://github.com/XTLS/Xray-core/releases/latest/download/${zipName}`;
  log(`[init] XRAY_ZIP_URL=${url}`);

  const zipPath = path.join(BASE_DIR, "xray.zip");
  await downloadToFile(url, zipPath);

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(XRAY_DIR, true);

  // Some zips extract to "xray" directly; ensure chmod +x
  await fsp.chmod(xrayBin, 0o755).catch(() => {});
  log(`[init] Xray ready: ${xrayBin}`);
  return xrayBin;
}

async function writeXrayConfig() {
  await ensureDir(BASE_DIR);
  const cfgPath = path.join(BASE_DIR, "config.json");

  const cfg = {
    log: { loglevel: "warning" },
    inbounds: [
      {
        listen: "127.0.0.1",
        port: XRAY_LOCAL_PORT,
        protocol: "vmess",
        settings: {
          clients: [{ id: UUID, alterId: ALTER_ID }]
        },
        streamSettings: {
          network: "ws",
          security: "none",
          wsSettings: { path: WS_PATH }
        }
      }
    ],
    outbounds: [{ protocol: "freedom", settings: {} }]
  };

  await fsp.writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  log(`[init] Wrote Xray config: ${cfgPath}`);
  return cfgPath;
}

function spawnXray(xrayBin, cfgPath) {
  log(`[start] starting xray on 127.0.0.1:${XRAY_LOCAL_PORT} ws:${WS_PATH}`);
  const p = spawn(xrayBin, ["run", "-c", cfgPath], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  const onLine = (line) => {
    process.stdout.write(`[xray] ${line}\n`);
    if (!xrayReady && /started/i.test(line)) {
      xrayReady = true;
      log(`[xray] ready.`);
    }
  };

  p.stdout.setEncoding("utf8");
  p.stderr.setEncoding("utf8");
  p.stdout.on("data", (d) => d.toString().split("\n").filter(Boolean).forEach(onLine));
  p.stderr.on("data", (d) => d.toString().split("\n").filter(Boolean).forEach(onLine));

  p.on("exit", (code) => {
    xrayReady = false;
    warn(`[xray] exited: ${code}`);
  });

  return p;
}

// ---------- cloudflared Quick Tunnel ----------
async function ensureCloudflared() {
  await ensureDir(CF_DIR);
  const bin = path.join(CF_DIR, "cloudflared");
  if (await exists(bin)) return bin;

  log(`[init] cloudflared not found, downloading...`);
  const name = archTagCloudflared();
  const url = process.env.CLOUDFLARED_URL ||
    `https://github.com/cloudflare/cloudflared/releases/latest/download/${name}`;

  const tmpPath = path.join(CF_DIR, "cloudflared.download");
  await downloadToFile(url, tmpPath);
  await fsp.rename(tmpPath, bin);
  await fsp.chmod(bin, 0o755);
  log(`[init] cloudflared ready: ${bin}`);
  return bin;
}

function spawnCloudflared(bin) {
  // Quick Tunnel: will print https://xxxx.trycloudflare.com
  // Point it to our HTTP server (which serves /ws and /info)
  const origin = `http://127.0.0.1:${HTTP_PORT}`;
  log(`[start] starting cloudflared quick tunnel -> ${origin}`);

  const p = spawn(bin, ["tunnel", "--url", origin, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  const rx = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i;

  const onLine = (line) => {
    process.stdout.write(`[cf] ${line}\n`);
    const m = line.match(rx);
    if (m) {
      cloudflaredUrl = `https://${m[1]}`;
      publicHost = m[1];
      log(`[node] trycloudflare url: ${cloudflaredUrl}`);
      log(`[node] vmess link:`);
      log(makeVmessLink(publicHost));
    }
  };

  p.stdout.setEncoding("utf8");
  p.stderr.setEncoding("utf8");
  p.stdout.on("data", (d) => d.toString().split("\n").filter(Boolean).forEach(onLine));
  p.stderr.on("data", (d) => d.toString().split("\n").filter(Boolean).forEach(onLine));

  p.on("exit", (code) => warn(`[cf] exited: ${code}`));
  return p;
}

// ---------- HTTP server (platform port) ----------
function startHttpServer() {
  const proxy = httpProxy.createProxyServer({
    target: `http://127.0.0.1:${XRAY_LOCAL_PORT}`,
    ws: true
  });

  proxy.on("error", (err, req, res) => {
    // Don’t crash; keep server alive
    warn(`[proxy] ${err?.code || err?.message || err}`);
    if (res && !res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res?.end?.("bad gateway");
  });

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (u.pathname === "/kaithhealth") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end("ok");
    }

    if (u.pathname === "/info" || u.pathname === "/sub") {
      if (!basicAuthOk(req)) {
        res.writeHead(401, { "WWW-Authenticate": "Basic realm=\"info\"" });
        return res.end("auth required");
      }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(textInfo());
    }

    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      `alive\n` +
      `ws: ${WS_PATH}\n` +
      `xray_ready: ${xrayReady}\n` +
      `trycloudflare: ${cloudflaredUrl || ""}\n`
    );
  });

  server.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (u.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }

    // If xray not ready yet, refuse upgrade (prevents platform/probes from killing you)
    if (!xrayReady) {
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\n" +
        "Connection: close\r\n" +
        "Content-Type: text/plain\r\n" +
        "\r\n" +
        "xray not ready\n"
      );
      socket.destroy();
      return;
    }

    proxy.ws(req, socket, head);
  });

  server.listen(HTTP_PORT, "0.0.0.0", () => {
    log(`[http] listening on :${HTTP_PORT}`);
    log(`[http] ws path: ${WS_PATH}`);
    if (!INFO_USER || !INFO_PASS) {
      warn(`[http] WARNING: /info & /sub are PUBLIC. Set INFO_USER/INFO_PASS to protect them.`);
    }
  });

  return server;
}

// ---------- main ----------
async function main() {
  await ensureDir(BASE_DIR);
  await ensureDir(BIN_DIR);

  // 先把 HTTP 起起来（平台需要活着）
  startHttpServer();

  // 再准备 xray（下载/写配置/启动）
  const xrayBin = await ensureXray();
  const cfgPath = await writeXrayConfig();
  spawnXray(xrayBin, cfgPath);

  // 再起 cloudflared（会输出 trycloudflare 域名）
  const cfBin = await ensureCloudflared();
  spawnCloudflared(cfBin);

  log(`[node] (placeholder) vmess link (will be updated when trycloudflare URL appears):`);
  log(makeVmessLink(publicHost || "YOUR_TRYCLOUDFLARE_HOST"));
}

main().catch((e) => fatal("[fatal]", e));
