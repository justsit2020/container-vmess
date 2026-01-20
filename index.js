const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const http = require("node:http");

const express = require("express");
const httpProxy = require("http-proxy");
const AdmZip = require("adm-zip");

// -------------------------
// 基础配置（全部可用环境变量覆盖）
// -------------------------
const DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), "vmess-ws");
const BIN_DIR = path.join(DATA_DIR, "bin");
const XRAY_DIR = path.join(BIN_DIR, "xray");
const XRAY_ZIP = path.join(XRAY_DIR, "xray.zip");
const XRAY_BIN = path.join(XRAY_DIR, "xray");
const XRAY_CONFIG = path.join(DATA_DIR, "config.json");

const HTTP_PORT = Number(process.env.PORT || 3000); // 平台一般用 PORT
const XRAY_LOCAL_PORT = Number(process.env.XRAY_LOCAL_PORT || 10000); // xray 本地监听
const WS_PATH = normalizePath(process.env.WS_PATH || "/ws");

const UUID = process.env.UUID || crypto.randomUUID();
const NODE_NAME = process.env.NODE_NAME || "vmess-ws";
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT || 443);

// 信息页鉴权（强烈建议设置）
// 如果不设置 INFO_USER/INFO_PASS，则信息页公开
const INFO_USER = process.env.INFO_USER || "";
const INFO_PASS = process.env.INFO_PASS || "";

// 可选：手动指定公网域名（不指定则从请求 Host 推断）
const PUBLIC_HOST = process.env.PUBLIC_HOST || "";

// 可选：手动指定下载地址（不指定则按架构给默认）
const XRAY_ZIP_URL = process.env.XRAY_ZIP_URL || defaultXrayZipUrl();

// -------------------------
// 工具函数
// -------------------------
function normalizePath(p) {
  if (!p.startsWith("/")) p = "/" + p;
  // 去掉尾部多余 /
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function basicAuthOK(req) {
  if (!INFO_USER || !INFO_PASS) return true; // 未设置则不鉴权
  const h = req.headers["authorization"] || "";
  if (!h.startsWith("Basic ")) return false;
  const raw = Buffer.from(h.slice(6), "base64").toString("utf8");
  const [u, p] = raw.split(":");
  return u === INFO_USER && p === INFO_PASS;
}

function requireAuth(req, res, next) {
  if (basicAuthOK(req)) return next();
  res.setHeader("WWW-Authenticate", 'Basic realm="Node Info"');
  res.status(401).send("Auth required");
}

function getPublicHost(req) {
  // 优先 env，其次 x-forwarded-host，再次 host
  const xfHost = (req.headers["x-forwarded-host"] || "").toString().split(",")[0].trim();
  const host = PUBLIC_HOST || xfHost || (req.headers["host"] || "").toString();
  // 去端口
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
  const links = [buildVmessLink(host)];
  const raw = links.join("\n");
  // 兼容常见客户端订阅格式：base64(links)
  return Buffer.from(raw, "utf8").toString("base64");
}

async function downloadToFile(url, filepath) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  await ensureDir(path.dirname(filepath));
  const file = fssync.createWriteStream(filepath);
  await new Promise((resolve, reject) => {
    res.body.pipe(file);
    res.body.on("error", reject);
    file.on("finish", resolve);
    file.on("error", reject);
  });
}

async function ensureXray() {
  await ensureDir(XRAY_DIR);

  // 已存在就不重复下载
  if (fssync.existsSync(XRAY_BIN)) return;

  console.log(`[init] Xray not found, downloading...`);
  console.log(`[init] XRAY_ZIP_URL=${XRAY_ZIP_URL}`);

  await downloadToFile(XRAY_ZIP_URL, XRAY_ZIP);

  const zip = new AdmZip(XRAY_ZIP);
  zip.extractAllTo(XRAY_DIR, true);

  // 有的包解压出来叫 xray，有的可能在子目录里，兜底搜一下
  if (!fssync.existsSync(XRAY_BIN)) {
    const found = findFileRecursive(XRAY_DIR, "xray");
    if (!found) throw new Error("xray binary not found after unzip");
    await fs.copyFile(found, XRAY_BIN);
  }

  await fs.chmod(XRAY_BIN, 0o755);
  console.log(`[init] Xray ready: ${XRAY_BIN}`);
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
  console.log(`[start] starting xray on 127.0.0.1:${XRAY_LOCAL_PORT} ws:${WS_PATH}`);
  const p = spawn(XRAY_BIN, ["run", "-config", XRAY_CONFIG], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  p.stdout.on("data", (d) => process.stdout.write(`[xray] ${d}`));
  p.stderr.on("data", (d) => process.stderr.write(`[xray] ${d}`));
  p.on("exit", (code, signal) => {
    console.error(`[xray] exited code=${code} signal=${signal}`);
    // 让主进程退出，平台会重启
    process.exit(code || 1);
  });

  return p;
}

function defaultXrayZipUrl() {
  // 这些文件名在很多安装/解压文档与镜像中使用：Xray-linux-64.zip / Xray-linux-arm64-v8a.zip :contentReference[oaicite:1]{index=1}
  // 官方发布在 GitHub Releases。 :contentReference[oaicite:2]{index=2}
  const arch = process.arch; // x64 / arm64
  if (arch === "arm64") {
    return "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-arm64-v8a.zip";
  }
  // 默认 x64
  return "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip";
}

// -------------------------
// 主流程
// -------------------------
async function main() {
  // 全部写到 /tmp，避免 EACCES（你现在就是卡在 /root 写入权限）
  await ensureDir(DATA_DIR);
  await ensureDir(BIN_DIR);

  await ensureXray();
  await writeXrayConfig();
  startXray();

  // HTTP + WS 反代
  const app = express();

  app.get("/healthz", (req, res) => res.status(200).send("ok"));

  app.get("/", (req, res) => {
    res
      .status(200)
      .type("html")
      .send(`
        <h3>Service is running</h3>
        <ul>
          <li><a href="/info">/info</a> (JSON)</li>
          <li><a href="/sub">/sub</a> (base64 subscription)</li>
        </ul>
        <p>WS endpoint: <code>${WS_PATH}</code></p>
      `);
  });

  app.get("/info", requireAuth, (req, res) => {
    const host = getPublicHost(req);
    const vmess = buildVmessLink(host);
    res.json({
      name: NODE_NAME,
      host,
      publicPort: PUBLIC_PORT,
      wsPath: WS_PATH,
      uuid: UUID,
      vmess
    });
  });

  app.get("/sub", requireAuth, (req, res) => {
    const host = getPublicHost(req);
    const b64 = buildSub(host);
    res.type("text/plain").send(b64);
  });

  const server = http.createServer(app);

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
    // 只把 WS_PATH 的 upgrade 转给 xray，其他直接断开
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
      console.log(`[http] /info & /sub are protected by Basic Auth (INFO_USER/INFO_PASS)`);
    } else {
      console.warn(`[http] WARNING: /info & /sub are PUBLIC. Set INFO_USER/INFO_PASS to protect them.`);
    }
    // 启动时先打印一个“占位链接”（host 需要你真实域名或首次请求才能确定）
    const placeholderHost = PUBLIC_HOST || "YOUR_DOMAIN";
    console.log(`[node] vmess link (placeholder host):\n${buildVmessLink(placeholderHost)}\n`);
    console.log(`[node] open https://${placeholderHost}/info to get the real link (or set PUBLIC_HOST).`);
  });
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
