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
const UUID = process.env.UUID || uuidv4();
const NESTED_PATH = process.env.VMESS_PATH || '/vmess';
const TMP_DIR = '/tmp';
const CONFIG_FILE = path.join(TMP_DIR, 'config.json');

// 两个架构的下载地址 (穷举法，谁能用以谁为准)
const URL_X64 = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-64.zip';
const URL_ARM = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-arm64-v8a.zip';

console.log(`[Init] 准备启动... UUID: ${UUID}`);

// --- 下载辅助函数 ---
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

// --- 架构尝试函数 ---
async function installAndTest(archName, url) {
  const zipPath = path.join(TMP_DIR, `xray-${archName}.zip`);
  const binPath = path.join(TMP_DIR, 'xray');
  
  // 先清理
  if (fs.existsSync(binPath)) fs.unlinkSync(binPath);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  try {
    console.log(`[Try] 尝试架构: ${archName}`);
    await downloadFile(url, zipPath);
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(TMP_DIR, true);
    fs.chmodSync(binPath, 0o755);
    fs.unlinkSync(zipPath);
    
    // 关键：试运行一下，看报不报错
    execSync(`${binPath} -version`);
    console.log(`[Success] 架构 ${archName} 可用！`);
    return true;
  } catch (e) {
    console.log(`[Fail] 架构 ${archName} 不可用，尝试下一个...`);
    return false;
  }
}

// --- 核心启动逻辑 ---
async function start() {
  // 1. 尝试安装核心 (如果 x64 失败，自动试 arm64)
  let success = await installAndTest('x64', URL_X64);
  if (!success) success = await installAndTest('arm64', URL_ARM);

  if (!success) {
    console.error(`[Fatal] 所有架构都无法运行，请检查环境。`);
    process.exit(1);
  }

  // 2. 生成配置
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

  // 3. 启动 Xray
  const xray = spawn(path.join(TMP_DIR, 'xray'), ['-c', CONFIG_FILE]);
  xray.stdout.on('data', d => console.log(`[Xray] ${d}`));
  xray.stderr.on('data', d => console.error(`[Xray] ${d}`));

  // 4. 启动 Web 服务器 (带节点信息显示)
  const proxy = httpProxy.createProxyServer({});
  const server = http.createServer((req, res) => {
    // 如果访问根路径，显示节点信息
    if (req.url === '/') {
      const host = req.headers.host; // 自动获取当前域名
      const vmessConfig = {
        v: "2",
        ps: "Leapcell-Vmess", // 备注名
        add: host,            // 地址 (自动识别)
        port: "443",          // 端口 (Serverless 通常是 HTTPS 443)
        id: UUID,             // UUID
        aid: "0",
        scy: "auto",
        net: "ws",
        type: "none",
        host: host,           // 伪装域名
        path: NESTED_PATH,    // 路径
        tls: "tls",           // 开启 TLS
        sni: "",
        alpn: ""
      };
      // 生成 vmess:// 链接
      const vmessLink = 'vmess://' + Buffer.from(JSON.stringify(vmessConfig)).toString('base64');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.write(`
        <h1>Vmess Serverless 节点信息</h1>
        <p><strong>状态:</strong> 运行中 (Running)</p>
        <p><strong>UUID:</strong> ${UUID}</p>
        <p><strong>路径:</strong> ${NESTED_PATH}</p>
        <hr/>
        <h3>Vmess 链接 (点击复制):</h3>
        <textarea style="width:100%; height:100px;">${vmessLink}</textarea>
        <hr/>
        <h3>手动配置:</h3>
        <ul>
          <li>地址(Address): ${host}</li>
          <li>端口(Port): 443</li>
          <li>用户ID(UUID): ${UUID}</li>
          <li>传输协议(Network): ws</li>
          <li>伪装域名(Host): ${host}</li>
          <li>路径(Path): ${NESTED_PATH}</li>
          <li>传输层安全(TLS): tls</li>
        </ul>
      `);
      res.end();
    } else if (req.url.startsWith(NESTED_PATH)) {
      // 代理 WS 流量
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
    console.log(`[Server] 服务已就绪，请访问 https://${process.env.LEAPCELL_APP_URL || '你的域名'} 查看节点链接`);
  });
}

start();
