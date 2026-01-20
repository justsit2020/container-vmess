const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');

// --- 配置 ---
const PORT = process.env.PORT || 3000;
const UUID = process.env.UUID || uuidv4();
const NESTED_PATH = process.env.VMESS_PATH || '/vmess';
const DOWNLOAD_URL = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-64.zip';
const TMP_DIR = '/tmp';
const XRAY_BIN = path.join(TMP_DIR, 'xray');
const CONFIG_FILE = path.join(TMP_DIR, 'config.json');

console.log(`[Init] 准备启动... UUID: ${UUID}`);

// --- 核心修复：支持重定向的下载函数 ---
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (link) => {
      console.log(`[Download] 正在请求: ${link}`);
      https.get(link, (res) => {
        // 处理 302/301 重定向 (关键修复)
        if (res.statusCode === 302 || res.statusCode === 301) {
          if (res.headers.location) {
            console.log(`[Download] 检测到跳转，正在跟随...`);
            return get(res.headers.location);
          }
        }
        
        if (res.statusCode !== 200) {
          return reject(new Error(`下载失败，状态码: ${res.statusCode}`));
        }

        const file = fs.createWriteStream(dest);
        res.pipe(file);
        
        file.on('finish', () => {
          file.close(() => {
            console.log(`[Download] 文件写入完成`);
            resolve();
          });
        });
      }).on('error', (err) => {
        fs.unlink(dest, () => {}); // 删除下载失败的文件
        reject(err);
      });
    };
    
    get(url);
  });
}

// --- 主程序 ---
async function startServer() {
  try {
    // 1. 安装 Xray
    if (!fs.existsSync(XRAY_BIN)) {
      console.log(`[Init] 开始下载 Xray...`);
      const zipPath = path.join(TMP_DIR, 'xray.zip');
      
      // 使用修复后的下载函数
      await downloadFile(DOWNLOAD_URL, zipPath);
      
      console.log(`[Init] 正在解压...`);
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(TMP_DIR, true); // 解压到 /tmp
      
      fs.chmodSync(XRAY_BIN, 0o755); // 赋予执行权限
      console.log(`[Init] 安装成功！`);
      
      fs.unlinkSync(zipPath); // 清理
    }

    // 2. 写入配置
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

    // 3. 启动 Xray
    console.log(`[Start] 启动 Xray 进程...`);
    const xray = spawn(XRAY_BIN, ['-c', CONFIG_FILE]);

    xray.stdout.on('data', (data) => console.log(`[Xray] ${data}`));
    xray.stderr.on('data', (data) => console.error(`[Xray Err] ${data}`));
    xray.on('close', (code) => {
      console.error(`[Xray] 进程退出，代码: ${code}`);
      process.exit(code);
    });

    // 4. HTTP 代理服务
    const proxy = httpProxy.createProxyServer({});
    const server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200);
        res.end('Leapcell Service Running!');
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
      console.log(`[Server] 监听端口 ${PORT}`);
    });

  } catch (err) {
    console.error(`[Fatal] 发生错误:`, err);
    process.exit(1);
  }
}

startServer();
