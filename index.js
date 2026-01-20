const fs = require('fs');
const https = require('https');
const { spawn, execSync } = require('child_process');
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');

// --- 基础配置 ---
const PORT = process.env.PORT || 3000;
// 去除 UUID 两端空格，防止复制错误
const UUID = (process.env.UUID || uuidv4()).trim();
// 确保路径格式正确
let NESTED_PATH = (process.env.VMESS_PATH || '/vmess').trim();
if (!NESTED_PATH.startsWith('/')) NESTED_PATH = '/' + NESTED_PATH;

const TMP_DIR = '/tmp';
const CONFIG_FILE = path.join(TMP_DIR, 'config.json');
const URL_X64 = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-64.zip';
const URL_ARM = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-arm64-v8a.zip';

// --- 打印启动信息 ---
console.log(`------------------------------------------------`);
console.log(`[Init] 启动时间: ${new Date().toLocaleString()}`);
console.log(`[Init] UUID: ${UUID}`);
console.log(`[Init] Path: ${NESTED_PATH}`);
console.log(`------------------------------------------------`);

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (link) => {
      https.get(link, (res) => {
        if (res.statusCode >= 300 && res.headers.location) return get(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`Status ${res.statusCode}`));
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    };
    get(url);
  });
}

async function installAndTest(archName, url) {
  const binPath = path.join(TMP_DIR, 'xray');
  const zipPath = path.join(TMP_DIR, `xray-${archName}.zip`);
  
  // 如果已存在且能运行，直接跳过下载
  if (fs.existsSync(binPath)) {
    try {
      execSync(`${binPath} -version`);
      return true;
    } catch(e) { fs.unlinkSync(binPath); }
  }

  try {
    await downloadFile(url, zipPath);
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(TMP_DIR, true);
    fs.chmodSync(binPath, 0o755);
    fs.unlinkSync(zipPath);
    execSync(`${binPath} -version`);
    console.log(`[Success] 架构 ${archName} 已就绪`);
    return true;
  } catch (e) {
    return false;
  }
}

async function start() {
  let success = await installAndTest('x64', URL_X64);
  if (!success) success = await installAndTest('arm64', URL_ARM);

  if (!success) {
    console.error(`[Fatal] 核心启动失败`);
    process.exit(1);
  }

  // --- 生成配置 ---
  const config = {
    "log": { "loglevel": "warning" },
    "inbounds": [{
      "port": 10000,
      "listen": "127.0.0.1",
      "protocol": "vmess",
      "settings": { 
        "clients": [{ "id": UUID, "alterId": 0 }] 
      },
      "streamSettings": { 
        "network": "ws", 
        "wsSettings": { "path": NESTED_PATH } 
      }
    }],
    "outbounds": [{ "protocol": "freedom", "settings": {} }]
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

  // --- 关键修改：禁用 AEAD 强制验证 ---
  // 这能解决很多“invalid request header”的问题
  const env = Object.assign({}, process.env, {
    XRAY_VMESS_AEAD_FORCED: "false" 
  });

  const xray = spawn(path.join(TMP_DIR, 'xray'), ['-c', CONFIG_FILE], { env });
  xray.stdout.on('data', d => console.log(`[Xray] ${d}`));
  xray.stderr.on('data', d => console.error(`[Xray] ${d}`));

  // --- 代理服务 ---
  const proxy = httpProxy.createProxyServer({
    ws: true,
    xfwd: true
  });

  proxy.on('error', (err) => console.error(`[Proxy Error] ${err.message}`));

  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      const host = req.headers.host;
      const vmessInfo = {
        v: "2",
        ps: "Leapcell-Final",
        add: host,
        port: "443",
        id: UUID,
        aid: "0",
        scy: "auto",
        net: "ws",
        type: "none",
        host: host,
        path: NESTED_PATH,
        tls: "tls"
      };
      const link = 'vmess://' + Buffer.from(JSON.stringify(vmessInfo)).toString('base64');
      
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <h2>Vmess Serverless (兼容模式)</h2>
        <p>UUID: ${UUID}</p>
        <p>Path: ${NESTED_PATH}</p>
        <textarea style="width:100%; height:120px;">${link}</textarea>
        <p>已强制关闭 AEAD 验证，请确保客户端 <strong>AlterID = 0</strong>。</p>
      `);
    } else if (req.url.startsWith(NESTED_PATH)) {
      proxy.web(req, res, { target: 'http://127.0.0.1:10000' });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  // 监听 WebSocket 升级
  server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith(NESTED_PATH)) {
      // 打印请求头，确认路径是否正确
      console.log(`[WS] 收到连接: ${req.url}`); 
      proxy.ws(req, socket, head, { target: 'ws://127.0.0.1:10000' });
    } else {
      console.log(`[WS] 路径不匹配，拒绝连接: ${req.url}`);
      socket.destroy();
    }
  });

  server.listen(PORT, () => {
    console.log(`[Server] 服务运行在端口 ${PORT}`);
  });
}

start();
