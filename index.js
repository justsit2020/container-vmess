const fs = require('fs');
const https = require('https');
const { spawn, execSync } = require('child_process');
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');

const PORT = process.env.PORT || 3000;
const UUID = process.env.UUID || uuidv4();
const NESTED_PATH = process.env.VMESS_PATH || '/vmess';
const TMP_DIR = '/tmp';
const CONFIG_FILE = path.join(TMP_DIR, 'config.json');

// 定义两种可能的架构下载地址
const URL_X64 = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-64.zip';
const URL_ARM = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-arm64-v8a.zip';

console.log(`[Init] 准备启动... UUID: ${UUID}`);

// --- 下载工具 ---
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (link) => {
      https.get(link, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) return get(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`Status ${res.statusCode}`));
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    };
    get(url);
  });
}

// --- 安装并测试指定架构 ---
async function installAndTest(archName, url) {
  const zipPath = path.join(TMP_DIR, `xray-${archName}.zip`);
  const binPath = path.join(TMP_DIR, 'xray'); // 始终解压为 /tmp/xray

  console.log(`[Try] 正在尝试架构: ${archName}`);
  
  // 1. 清理旧文件
  if (fs.existsSync(binPath)) fs.unlinkSync(binPath);
  
  // 2. 下载
  try {
    console.log(`[Try] 下载中...`);
    await downloadFile(url, zipPath);
  } catch (e) {
    console.error(`[Try] 下载失败: ${e.message}`);
    return false;
  }

  // 3. 解压
  try {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(TMP_DIR, true);
    fs.chmodSync(binPath, 0o755);
    fs.unlinkSync(zipPath); // 清理 zip
  } catch (e) {
    console.error(`[Try] 解压失败: ${e.message}`);
    return false;
  }

  // 4. 测试运行 (关键步骤)
  try {
    console.log(`[Try] 测试运行二进制文件...`);
    const versionCheck = execSync(`${binPath} -version`).toString();
    console.log(`[Success] 成功! 检测到版本:\n${versionCheck.split('\n')[0]}`);
    return true; // 成功！
  } catch (e) {
    console.error(`[Fail] 该架构无法运行 (Exec format error).`);
    return false; // 失败
  }
}

// --- 主流程 ---
async function start() {
  let success = false;

  // 1. 先试 x64 (最常见)
  if (await installAndTest('x64', URL_X64)) {
    success = true;
  } 
  // 2. 如果失败，再试 arm64
  else if (await installAndTest('arm64', URL_ARM)) {
    success = true;
  }

  if (!success) {
    console.error(`[Fatal] 所有架构尝试均失败，无法在此环境运行。`);
    process.exit(1);
  }

  // 3. 生成配置
  const config = {
    "log": { "loglevel": "warning" },
    "inbounds": [{
      "port": 10000,
      "listen": "127.0.0.1",
      "protocol": "vmess",
      "settings": { "clients": [{ "id": UUID, "alterId": 0 }] },
      "streamSettings": { "network": "ws", "wsSettings": { "path": NESTED_PATH } }
    }],
    "outbounds": [{ "protocol": "freedom", "settings": {} }]
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

  // 4. 正式启动
  const xray = spawn(path.join(TMP_DIR, 'xray'), ['-c', CONFIG_FILE]);
  xray.stdout.on('data', d => console.log(`[Xray] ${d}`));
  xray.stderr.on('data', d => console.error(`[Xray] ${d}`));

  // 5. 启动 HTTP 代理
  const proxy = httpProxy.createProxyServer({});
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200);
      res.end('Service Running');
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
}

start();
