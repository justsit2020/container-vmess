"use strict";

const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const http = require("node:http");
const { spawn } = require("node:child_process");

const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const express = require("express");
const httpProxy = require("http-proxy");
const AdmZip = require("adm-zip");

/**
 * =========================
 * 可配置项（环境变量）
 * =========================
 * PORT                 : HTTP 监听端口（平台一般自动注入）
 * UUID                 : VMess UUID（不填就随机生成，每次重启会变，建议必填）
 * WS_PATH              : WebSocket 路径，默认 /ws
 * PUBLIC_HOST          : 你的域名（不填则从请求 Host 推断）
 * PUBLIC_PORT          : 客户端连接端口，默认 443
 * NODE_NAME            : 节点名字，默认 vmess-ws
 * INFO_USER / INFO_PASS: /info 和 /sub 的 Basic Auth（强烈建议设置）
 * XRAY_LOCAL_PORT      : xray 本地端口，默认 10000
 * XRAY_ZIP_URL         : 指定 xray zip 下载地址（不填按架构自动选择）
 *
 * 访问：
 *   GET  /healthz  健康检查
 *   GET  /info     返回 JSON + vmess:// 链接
 *   GET  /sub      返回 base64 订阅（一行一个链接再 base64）
 *   WS   /ws       WS 入口（反代给本地 xray）
 */

const DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), "vmess-ws");
const BIN_DIR = path.join(DATA_DIR, "bin");
const XRAY_DIR = path.join(BIN_DIR, "xray");
const XRAY_ZIP = path.join(XRAY_DIR, "xray.zip");
const XRAY_BIN = path.join(XRAY_DIR, "xray");
const XRAY_CONFIG = path.join(DATA_DIR, "config.json");

const HTTP_PORT = Number(process.env.PORT || 3000);
const XRAY_LOCAL_PORT = Number(process.env.XRAY_LOCAL_PORT || 10000);

const WS_PATH = normalizePath(process.env.WS_PATH || "/ws");

const UUID = process.env.UUID || crypto.randomUUID();
const NODE_NAME = process.env.NODE_NAME || "vmess-ws";

const PUBLIC_PORT = Number(process.env.PUBLIC_PORT || 443);
const PUBLIC_HOST = (process.env.PUBLIC_HOST || "").trim();

const INFO_USER = (process.env.INFO_USER || "").trim();
const INFO_PASS = (process.env.INFO_PASS || "").trim();

const XRAY_ZIP_URL = (process.env.XRAY_ZIP_URL || defaultXrayZipUrl()).trim();

let xrayProc = null;
let xrayStatus = {
  ok: false,
  phase: "init",
  error: "",
  zipUrl: XRAY_ZIP_URL,
  localPort: XRAY_LOCAL_PORT,
  wsPath: WS_PATH
};

function normalizePath(p) {
  if (!p.startsWith("/")) p = "/" + p;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function basicAuthOK(req) {
  if (!INFO_USER || !INFO_PASS) return true;
  const h = req.headers["authorization"] || "";
  if (!h.startsWith("Basic ")) return false;
  const raw = Buffer.from(h.slice(6), "base64").toString("utf8");
  const idx = raw.indexOf(":");
  if (idx < 0) return false;
  const u = raw.slice(0, idx);
  const p = raw.slice(idx + 1);
  return u === INFO_USER && p === INFO_PASS;
}

function requireAuth(req, res, next) {
  if (basicAuthOK(req)) return next();
  res.setHeader("WWW-Authenticate", 'Basic realm="info"');
  res.status(401).send("Auth required");
}

function getPublicHost(req) {
  const xfHost = (req.headers["x-forwarded-host"] || "")
    .toString()
    .split(",")[0]
    .trim();

  const host = PUBLIC_HOST || xfHost || (req.headers["host"] || "").toString();
  return host.replace(/:\d+$/, "");
}

function buildVmessLink(host) {
  const obj = {
    v: "2",
    ps: NODE_NAME,
    add: host,
    port: String(PUBLIC_PORT),
    id: UUID,
    aid: "0",
    scy: "auto",
    net: "ws",
    type: "none",
    host: host,
    path: WS_PATH,
    tls: "tls"
  };
  return "vmess://" + Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

function buildSub(host) {
  const raw = [buildVmessLink(host)].join("\n");
  return Buffer.from(raw, "utf8").toString("base64");
}

/**
 * 关键修复点：
 * Node 20 的 fetch Response.body 是 Web ReadableStream（不是 Node Readable）
 * 所以不能 res.body.pipe(...)。
 * 这里优先用 Readable.fromWeb + pipeline；如果不可用则走 getReader 手动写文件。
 */
async function writeWebStreamToFile(webStream, filepath) {
  await ensureDir(path.dirname(filepath));

  // 优先：Readable.fromWeb（Node 文档提供这个转换 API）:contentReference[oaicite:3]{index=3}
  if (typeof Readable.fromWeb === "function") {
    const nodeReadable = Readable.fromWeb(webStream);
    const ws = fssync.createWriteStream(filepath);
    await pipeline(nodeReadable, ws); // pipeline 是官方推荐的 Promise 写法 :contentReference[oaicite:4]{index=4}
    return;
  }

  // 兜底：手动 reader
  const ws = fssync.createWriteStream(filepath);
  const reader = webStream.getReader();

  await new Promise((resolve, reject) => {
    ws.on("error", reject);

    const pump = () => {
      reader.read().then(({ done, value }) => {
        if (done) {
          ws.end();
          resolve();
          return;
        }
        const buf = Buffer.from(value);
        if (!ws.write(buf)) {
          ws.once("drain", pump);
        } else {
          pump();
        }
      }).catch(reject);
    };

    pump();
  });
}

async function downloadToFile(url, filepath) {
  const res = await fetch(url, { redirect: "follow" });

  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  if (!res.body) {
    // 极少数情况下 body 为空，兜底用 arrayBuffer
    const ab = await res.arrayBuffer();
    await ensureDir(path.dirname(filepath));
    await fs.writeFile(filepath, Buffer.from(ab));
    return;
  }

  // 注意：Response.body 是 ReadableStream（MDN）:contentReference[oaicite:5]{index=5}
  await writeWebStreamToFile(res.body, filepath);
}

function findFileRecursive(dir, filename) {
  const entries = fssync.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === filename) return full;
    if (e.isDirectory()) {
      const r = findFileRecursive(full, filename);
      if (r) return r;
    }
  }
  return null;
}

async function ensureXray() {
  await ensureDir(XRAY_DIR);

  if (fssync.existsSync(XRAY_BIN)) return;

  xrayStatus.phase = "download";
  xrayStatus.zipUrl = XRAY_ZIP_URL;
  console.log(`[init] Xray not found, downloading...`);
  console.log(`[init] XRAY_ZIP_URL=${XRAY_ZIP_URL}`);

  await downloadToFile(XRAY_ZIP_URL, XRAY_ZIP);

  xrayStatus.phase = "unzip";
  const zip = new AdmZip(XRAY_ZIP);
  zip.extractAllTo(XRAY_DIR, true);

  if (!fssync.existsSync(XRAY_BIN)) {
    const found = findFileRecursive(XRAY_DIR, "xray");
    if (!found) throw new Error("xray binary not found after unzip");
    await fs.copyFile(found, XRAY_BIN);
  }

  await fs.chmod(XRAY_BIN, 0o755);
  console.log(`[init] Xray ready: ${XRAY_BIN}`);
}

async function writeXrayConfig() {
  const cfg = {
    log: { loglevel: "warning" },
    inbounds: [
      {
        listen: "127.0.0.1",
        port: XRAY_LOCAL_PORT,
        protocol: "vmess",
        settings: {
          clients: [{ id: UUID, alterId: 0 }]
        },
        streamSettings: {
          network: "ws",
          wsSettings: { path: WS_PATH }
        }
      }
    ],
    outbounds: [{ protocol: "freedom" }]
  };

  await ensureDir(path.dirname(XRAY_CONFIG));
  await fs.writeFile(XRAY_CONFIG, JSON.stringify(cfg, null, 2), "utf8");
  console.log(`[init] Wrote Xray config: ${XRAY_CONFIG}`);
}

function startXray() {
  xrayStatus.phase = "run";
  console.log(`[start] starting xray on 127.0.0.1:${XRAY_LOCAL_PORT} ws:${WS_PATH}`);

  const p = spawn(XRAY_BIN, ["run", "-config", XRAY_CONFIG], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  p.stdout.on("data", (d) => process.stdout.write(`[xray] ${d}`));
  p.stderr.on("data", (d) => process.stderr.write(`[xray] ${d}`));

  p.on("spawn", () => {
    xrayStatus.ok = true;
    xrayStatus.error = "";
    console.log("[xray] spawned");
  });

  p.on("exit", (code, signal) => {
    xrayStatus.ok = false;
    xrayStatus.error = `xray exited code=${code} signal=${signal}`;
    console.error(`[xray] exited code=${code} signal=${signal}`);
    // 不强制退出：让 /info 仍可访问，方便你从域名看状态/拿配置
  });

  return p;
}

function defaultXrayZipUrl() {
  // 从 GitHub Releases 下载预编译 ZIP（官方发布方式）:contentReference[oaicite:6]{index=6}
  const arch = process.arch; // x64 / arm64
  if (arch === "arm64") {
    return "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-arm64-v8a.zip";
  }
  return "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip";
}

async function bootXrayAsync() {
  try {
    xrayStatus.phase = "prepare";
    await ensureDir(DATA_DIR);
    await ensureDir(BIN_DIR);

    await ensureXray();
    await writeXrayConfig();
    xrayProc = startXray();
  } catch (e) {
    xrayStatus.ok = false;
    xrayStatus.phase = "error";
    xrayStatus.error = String(e?.stack || e?.message || e);
    console.error("[xray] boot failed:", xrayStatus.error);
  }
}

function createApp() {
  const app = express();

  app.get("/healthz", (req, res) => res.status(200).send("ok"));

  app.get("/", (req, res) => {
    res.type("html").send(`
      <h3>Service is running</h3>
      <ul>
        <li><a href="/status">/status</a> (xray status)</li>
        <li><a href="/info">/info</a> (node info)</li>
        <li><a href="/sub">/sub</a> (subscription)</li>
      </ul>
      <p>WS endpoint: <code>${WS_PATH}</code></p>
    `);
  });

  app.get("/status", (req, res) => {
    res.json({
      ...xrayStatus,
      node: { port: HTTP_PORT, arch: process.arch, platform: process.platform }
    });
  });

  app.get("/info", requireAuth, (req, res) => {
    const host = getPublicHost(req);
    res.json({
      name: NODE_NAME,
      host,
      publicPort: PUBLIC_PORT,
      wsPath: WS_PATH,
      uuid: UUID,
      vmess: buildVmessLink(host),
      note: INFO_USER && INFO_PASS ? "protected" : "public"
    });
  });

  app.get("/sub", requireAuth, (req, res) => {
    const host = getPublicHost(req);
    res.type("text/plain").send(buildSub(host));
  });

  return app;
}

async function main() {
  // 先把 HTTP 服务起起来，避免“xray 下载失败 -> 整个域名不可用”
  const app = createApp();
  const server = http.createServer(app);

  // WS 反代到本地 xray
  const proxy = httpProxy.createProxyServer({
    target: `http://127.0.0.1:${XRAY_LOCAL_PORT}`,
    ws: true
  });

  proxy.on("error", (err, req, res) => {
    console.error("[proxy] error:", err?.message || err);
    try {
      if (res && !res.headersSent) res.writeHead(502);
      res && res.end("Bad gateway");
    } catch (_) {}
  });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url || !req.url.startsWith(WS_PATH)) {
      socket.destroy();
      return;
    }
    proxy.ws(req, socket, head);
  });

  server.listen(HTTP_PORT, () => {
    console.log(`[http] listening on :${HTTP_PORT}`);
    console.log(`[http] ws path: ${WS_PATH}`);
    if (INFO_USER && INFO_PASS) {
      console.log(`[http] /info & /sub are protected by Basic Auth`);
    } else {
      console.warn(`[http] WARNING: /info & /sub are PUBLIC. Set INFO_USER/INFO_PASS to protect them.`);
    }

    const placeholderHost = PUBLIC_HOST || "YOUR_DOMAIN";
    console.log(`[node] vmess link (placeholder):\n${buildVmessLink(placeholderHost)}\n`);
    console.log(`[node] Tip: set PUBLIC_HOST to print a real link immediately.`);
  });

  // 后台启动 xray（失败也不影响 info 页可用）
  bootXrayAsync();

  // 优雅退出
  const shutdown = () => {
    try {
      if (xrayProc) xrayProc.kill("SIGTERM");
    } catch (_) {}
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
