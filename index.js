const fs = require('fs');
const { spawn, execSync } = require('child_process');
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');

// --- 配置区域 ---
const PORT = process.env.PORT || 3000;
const UUID = process.env.UUID || uuidv4();
const NESTED_PATH = process.env.VMESS_PATH || '/vmess';
const XRAY_URL = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-64.zip';
const XRAY_DIR = '/tmp';
const XRAY_BIN = path.join(XRAY_DIR, 'xray');
const CONFIG_FILE = path.join(XRAY_DIR, 'config.json');

console.log(`[Init] 准备启动... UUID: ${UUID}`);

// --- 1. 核心文件检查与下载 ---
if (!fs.existsSync(XRAY_BIN)) {
  console.log(`[Init] 核心文件不存在，正在从 GitHub 下载...`);
  try {
    // 使用 curl 下载到临时文件
    const zipPath = path.join(XRAY_DIR, 'xray.zip');
    execSync(`curl -L -o "${zipPath}" "${XRAY_URL}"`, { stdio: 'inherit' });
    
    console.log(`[Init] 下载完成，正在解压...`);
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(XRAY_DIR, true);
    
    // 赋予执行权限
    execSync(`chmod +x "${XRAY_BIN}"`);
    console.log(`[Init] 核心安装成功: ${XRAY_BIN}`);
    
    // 清理压缩包
    fs.unlinkSync(zipPath);
  } catch (error) {
    console.error(`[Fatal] 下载或安装核心失败: ${error.message}`);
    process.exit(1);
  }
}

// --- 2. 生成配置文件 ---
const config = {
  "log": { "loglevel": "warning" },
  "inbounds": [{
    "port": 10000,
    "listen": "127.0.0.1",
    "protocol": "vmess",
    "settings": { "clients": [{ "id": UUID, "alterId": 0 }] },
    "streamSettings": {
      "network": "ws",
      "wsSettings": { "path": NESTED_PATH }
    }
  }],
  "outbounds": [{ "protocol": "freedom", "settings": {} }]
};
fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

// --- 3. 启动 Xray ---
console.log(`[Start] 正在启动 Xray 核心...`);
const xray = spawn(XRAY_BIN, ['-c', CONFIG_FILE]);

xray.stdout.on('data', (data) => console.log(`[Xray] ${data}`));
xray.stderr.on('data', (data) => console.error(`[Xray Err] ${data}`));
xray.on('close', (code) => {
  console.log(`[Xray] 进程退出，代码 ${code}`);
  process.exit(code);
});

// --- 4. 启动 HTTP 代理服务器 ---
const proxy = httpProxy.createProxyServer({});
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Service is Running! (Xray loaded in /tmp)');
  } else if (req.url.startsWith(NESTED_PATH)) {
    proxy.web(req, res, { target: 'http://127.0.0.1:10000' });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith(NESTED_PATH)) {
    proxy.ws(req, socket, head, { target: 'ws://127.0.0.1:10000' });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`[Server] 监听端口 ${PORT} 成功`);
});
