const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');
const os = require('os');

// --- 基础配置 ---
const PORT = process.env.PORT || 3000;
const UUID = process.env.UUID || uuidv4();
const NESTED_PATH = process.env.VMESS_PATH || '/vmess';
const TMP_DIR = '/tmp';
const XRAY_BIN = path.join(TMP_DIR, 'xray');
const CONFIG_FILE = path.join(TMP_DIR, 'config.json');

console.log(`[Init] 系统架构: ${os.arch()} | 平台: ${os.platform()}`);
console.log(`[Init] 准备启动... UUID: ${UUID}`);

// --- 1. 智能获取下载链接 ---
function getDownloadUrl() {
  const arch = os.arch();
  let filename = '';
  
  if (arch === 'x64') {
    filename = 'Xray-linux-64.zip';
  } else if (arch === 'arm64') {
    filename = 'Xray-linux-arm64-v8a.zip'; // 适配 ARM 环境
  } else {
    console.error(`[Fatal] 不支持的架构: ${arch}`);
    process.exit(1);
  }
  
  const url = `https://github.com/XTLS/Xray-core/releases/download/v1.8.4/${filename}`;
  console.log(`[Init] 根据架构自动选择版本: ${filename}`);
  return url;
}

// --- 2. 支持重定向的下载函数 ---
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (link) => {
      https.get(link, (res) => {
        // 处理 302 重定向
        if (res.statusCode === 302 || res.statusCode === 301) {
          if (res.headers.location) {
            console.log(`[Download] 跟随跳转 -> ${res.headers.location.substring(0, 50)}...`);
            return get(res.headers.location);
          }
        }
        
        if (res.statusCode !== 200) {
          return reject(new Error(`下载失败 HTTP ${res.statusCode}`));
        }

        const file = fs.createWriteStream(dest);
        res.pipe(file);
        
        file.on('finish', () => {
          file.close(resolve);
        });
      }).on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    };
    get(url);
  });
}

// --- 主程序 ---
async function startServer() {
  try {
    // 检查并安装
    if (!fs.existsSync(XRAY_BIN)) {
      const downloadUrl = getDownloadUrl();
      const zipPath = path.join(TMP_DIR, 'xray.zip');
      
      console.log(`[Init] 正在下载核心...`);
      await downloadFile(downloadUrl, zipPath);
      
      console.log(`[Init] 下载完成，正在解压...`);
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(TMP_DIR, true);
      
      // 赋予执行权限
      fs.chmodSync(XRAY_BIN, 0o755);
      console.log(`[Init] 核心安装完毕！`);
      
      fs.unlinkSync(zipPath);
    }

    // 生成配置
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

    // 启动 Xray
    console.log(`[Start] 启动 Xray...`);
    const xray = spawn(XRAY_BIN, ['-c', CONFIG_FILE]);

    xray.stdout.on('data', (data) => console.log(`[Xray] ${data}`));
    xray.stderr.on('data', (data) => console.error(`[Xray Err] ${data}`));
    xray.on('close', (code) => {
      console.error(`[Xray] 进程退出，代码: ${code}`);
      process.exit(code);
    });

    // 启动代理服务
    const proxy = httpProxy.createProxyServer({});
    const server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200);
        res.end(`Service Running on ${os.arch()}`);
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
      console.log(`[Server] 服务已启动，端口 ${PORT}`);
    });

  } catch (err) {
    console.error(`[Fatal] 错误:`, err);
    process.exit(1);
  }
}

startServer();
