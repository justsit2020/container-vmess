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

const HTTP_PORT = Number(process.env.PORT || 3000);
const XRAY_LOCAL_PORT = Number(process.env.XRAY_LOCAL_PORT || 10000);
const WS_PATH = process.env.WS_PATH || "/ws";

const INFO_USER = process.env.INFO_USER || "";
const INFO_PASS = process.env.INFO_PASS || "";

// /sub 是否输出 raw（不 base64），某些客户端更喜欢 raw
const SUB_RAW = process.env.SUB_RAW === "1";

const BASE_DIR = process.env.BASE_DIR || path.join(os.tmpdir(), "vmess-ws");
const BIN_DIR = path.join(BASE_DIR, "bin");
const XRAY_DIR = path.join(BIN_DIR, "xray");
const CF_DIR = path.join(BIN_DIR, "cloudflared");

const UUID = process.env.UUID || crypto.randomUUID();
const ALTER_ID = 0;

let xrayReady = false;
let publicHost = process.env.PUBLIC_HOST || ""; // cloudflared 会覆盖
let cloudflaredUrl = "";
let lastErr = "";

function now() { return new Date().toISOString(); }
async function ensureDir(p) { await fsp.mkdir(p, { recursive: true }); }
async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

function basicAuthOk(req) {
  if (!INFO_USER || !INFO_PASS) return true;
  const h = req.headers["authorization"] || "";
  if (!h.startsWith("Basic ")) return false;
  const raw = Buffer.from(h.slice(6), "base64").toString("utf8");
  const [u, p] = raw.split(":");
  return u === INFO_USER && p === INFO_PASS;
}

function makeVmessLink(hostname) {
  const host = hostname || "YOUR_TRYCLOUDFLARE_HOST";
  const obj = {
    v: "2",
    ps: "vmess-ws",
    add: host,
    port: "443",
    id: UUID,
    aid: String(ALTER_ID),
    scy: "auto",
    net: "ws",
    type: "none",
    host,
    path: WS_PATH,
    tls: "tls"
  };
  const b64 = Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
  return `vmess://${b64}`;
}

function infoText() {
  return [
    `time: ${now()}`,
    `http_port: ${HTTP_PORT}`,
    `ws_path: ${WS_PATH}`,
    `uuid: ${UUID}`,
    `xray_ready: ${xrayReady}`,
    `cloudflared_url: ${cloudflaredUrl || ""}`,
    `public_host: ${publicHost || ""}`,
    `last_error: ${lastErr || ""}`,
    ``,
    `vmess:`,
    makeVmessLink(publicHost || ""),
    ``
  ].join("\n");
}

function subTextRaw() {
  // 订阅里通常是一行一个节点链接
  return `${makeVmessLink(publicHost || "")}\n`;
}

function subText() {
  const raw = subTextRaw();
  return SUB_RAW ? raw : Buffer.from(raw, "utf8").toString("base64");
}

async function downloadToFile(url, filePath) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  if (!res.body) throw new Error(`Empty body downloading ${url}`);
  await ensureDir(path.dirname(filePath));
  const nodeReadable = Readable.fromWeb(res.body);
  const ws = fs.createWriteStream(filePath);
  await pipeline(nodeReadable, ws);
}

function archTagXray() {
  if (process.arch === "arm64") return "Xray-linux-arm64-v8a.zip";
  return "Xray-linux-64.zip";
}
function archTagCloudflared() {
  if (process.arch === "arm64") return "cloudflared-linux-arm64";
  return "cloudflared-linux-amd64";
}

async function ensureXray() {
  await ensureDir(XRAY_DIR);
  const xrayBin = path.join(XRAY_DIR, "xray");
  if (await exists(xrayBin)) return xrayBin;

  console.log(`[init] Xray not found, downloading...`);
  const zipName = archTagXray();
  const url = process.env.XRAY_ZIP_URL ||
    `https://github.com/XTLS/Xray-core/releases/latest/download/${zipName}`;
  console.log(`[init] XRAY_ZIP_URL=${url}`);

  const zipPath = path.join(BASE_DIR, "xray.zip");
  await downloadToFile(url, zipPath);

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(XRAY_DIR, true);
  await fsp.chmod(xrayBin, 0o755).catch(() => {});
  console.log(`[init] Xray ready: ${xrayBin}`);
  return xrayBin;
}

async function writeXrayConfig() {
  await ensureDir(BASE_DIR);
  const cfgPath = path.join(BASE_DIR, "config.json");
  const cfg = {
    log: { loglevel: "warning" },
    inbounds: [{
      listen: "127.0.0.1",
      port: XRAY_LOCAL_PORT,
      protocol: "vmess",
      settings: { clients: [{ id: UUID, alterId: ALTER_ID }] },
      streamSettings: {
        network: "ws",
        security: "none",
        wsSettings: { path: WS_PATH }
      }
    }],
    outbounds: [{ protocol: "freedom", settings: {} }]
  };
  await fsp.writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  console.log(`[init] Wrote Xray config: ${cfgPath}`);
  return cfgPath;
}

function spawnXray(xrayBin, cfgPath) {
  console.log(`[start] starting xray on 127.0.0.1:${XRAY_LOCAL_PORT} ws:${WS_PATH}`);
  const p = spawn(xrayBin, ["run", "-c", cfgPath], { stdio: ["ignore", "pipe", "pipe"] });

  const onLine = (line) => {
    process.stdout.write(`[xray] ${line}\n`);
    if (!xrayReady && /started/i.test(line)) {
      xrayReady = true;
      console.log(`[xray] ready.`);
    }
  };
  p.stdout.setEncoding("utf8");
  p.stderr.setEncoding("utf8");
  p.stdout.on("data", d => d.toString().split("\n").filter(Boolean).forEach(onLine));
  p.stderr.on("data", d => d.toString().split("\n").filter(Boolean).forEach(onLine));
  p.on("exit", code => {
    xrayReady = false;
    lastErr = `xray exited: ${code}`;
    console.warn(`[xray] exited: ${code}`);
  });
}

async function ensureCloudflared() {
  await ensureDir(CF_DIR);
  const bin = path.join(CF_DIR, "cloudflared");
  if (await exists(bin)) return bin;

  console.log(`[init] cloudflared not found, downloading...`);
  const name = archTagCloudflared();
  const url = process.env.CLOUDFLARED_URL ||
    `https://github.com/cloudflare/cloudflared/releases/latest/download/${name}`;

  const tmpPath = path.join(CF_DIR, "cloudflared.download");
  await downloadToFile(url, tmpPath);
  await fsp.rename(tmpPath, bin);
  await fsp.chmod(bin, 0o755);
  console.log(`[init] cloudflared ready: ${bin}`);
  return bin;
}

function spawnCloudflared(bin) {
  const origin = `http://127.0.0.1:${HTTP_PORT}`;
  console.log(`[start] starting cloudflared quick tunnel -> ${origin}`);

  const p = spawn(bin, ["tunnel", "--url", origin, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  const rx = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i;

  const onLine = (line) => {
    process.stdout.write(`[cf] ${line}\n`);
    const m = line.match(rx);
    if (m) {
      publicHost = m[1];
      cloudflaredUrl = `https://${m[1]}`;
      console.log(`[node] trycloudflare url: ${cloudflaredUrl}`);
      console.log(`[node] vmess: ${makeVmessLink(publicHost)}`);
    }
  };
  p.stdout.setEncoding("utf8");
  p.stderr.setEncoding("utf8");
  p.stdout.on("data", d => d.toString().split("\n").filter(Boolean).forEach(onLine));
  p.stderr.on("data", d => d.toString().split("\n").filter(Boolean).forEach(onLine));
  p.on("exit", code => {
    lastErr = `cloudflared exited: ${code}`;
    console.warn(`[cf] exited: ${code}`);
  });
}

function startHttpServer() {
  const proxy = httpProxy.createProxyServer({
    target: `http://127.0.0.1:${XRAY_LOCAL_PORT}`,
    ws: true
  });

  proxy.on("error", (err, req, res) => {
    lastErr = `proxy error: ${err?.code || err?.message || String(err)}`;
    console.warn(`[proxy] ${lastErr}`);
    if (res && !res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res?.end?.("bad gateway");
  });

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Leapcell 会轮询这个来判断启动完成
    if (u.pathname === "/kaithhealth") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end("ok");
    }

    if (u.pathname === "/info") {
      if (!basicAuthOk(req)) {
        res.writeHead(401, { "WWW-Authenticate": "Basic realm=\"info\"" });
        return res.end("auth required");
      }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(infoText());
    }

    if (u.pathname === "/sub") {
      if (!basicAuthOk(req)) {
        res.writeHead(401, { "WWW-Authenticate": "Basic realm=\"sub\"" });
        return res.end("auth required");
      }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(subText());
    }

    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(`alive\nws:${WS_PATH}\nxray_ready:${xrayReady}\ncloudflared:${cloudflaredUrl}\n`);
  });

  server.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (u.pathname !== WS_PATH) return socket.destroy();

    if (!xrayReady) {
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\n" +
        "Connection: close\r\n" +
        "Content-Type: text/plain\r\n\r\n" +
        "xray not ready\n"
      );
      return socket.destroy();
    }
    proxy.ws(req, socket, head);
  });

  server.listen(HTTP_PORT, "0.0.0.0", () => {
    console.log(`[http] listening on :${HTTP_PORT}`);
    console.log(`[http] ws path: ${WS_PATH}`);
    if (!INFO_USER || !INFO_PASS) {
      console.warn(`[http] WARNING: /info & /sub are PUBLIC. Set INFO_USER/INFO_PASS to protect them.`);
    }
  });
}

async function main() {
  await ensureDir(BASE_DIR);
  await ensureDir(BIN_DIR);

  // 先把 /kaithhealth 立刻提供出来（避免被平台判定未启动而重启）:contentReference[oaicite:7]{index=7}
  startHttpServer();

  // cloudflared 先起，尽快拿到 trycloudflare 域名
  ensureCloudflared()
    .then(bin => spawnCloudflared(bin))
    .catch(e => { lastErr = `cloudflared init failed: ${e.message}`; console.warn("[cf]", lastErr); });

  // xray 后起（失败也不直接退出，避免被平台拉起又拉起）
  try {
    const xrayBin = await ensureXray();
    const cfgPath = await writeXrayConfig();
    spawnXray(xrayBin, cfgPath);
  } catch (e) {
    lastErr = `xray init failed: ${e.message}`;
    console.warn("[xray]", lastErr);
    // 不 exit，让服务至少能活着输出 /info 看到错误
  }

  console.log(`[node] vmess (placeholder until trycloudflare appears): ${makeVmessLink(publicHost || "")}`);
}

main().catch(e => {
  lastErr = `fatal: ${e.message}`;
  console.error("[fatal]", e);
});
