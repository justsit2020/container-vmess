const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const UUID = process.env.UUID || uuidv4();
const NESTED_PATH = process.env.VMESS_PATH || '/vmess';

console.log(`[Info] 启动配置: 端口=${PORT}, UUID=${UUID}, 路径=${NESTED_PATH}`);

// 1. 检查核心文件是否存在 (关键调试步骤)
if (!fs.existsSync('./xray')) {
  console.error('[Error] 找不到 ./xray 文件！请检查 package.json 的 postinstall 脚本是否执行成功。');
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
    "streamSettings": {
      "network": "ws",
      "wsSettings": { "path": NESTED_PATH }
    }
  }],
  "outbounds": [{ "protocol": "freedom", "settings": {} }]
};

const configPath = path.join('/tmp', 'config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

// 3. 启动 Xray (注意这里加了 ./)
const v2ray = spawn('./xray', ['-c', configPath]);

v2ray.stdout.on('data', (data) => console.log(`[Xray] ${data}`));
v2ray.stderr.on('data', (data) => console.error(`[Xray Err] ${data}`));
v2ray.on('close', (code) => {
  console.log(`[Xray] 进程退出，代码 ${code}`);
  process.exit(code);
});

// 4. 启动代理服务
const proxy = httpProxy.createProxyServer({});
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Leapcell Service is Running!');
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
  console.log(`[Server] Listening on port ${PORT}`);
});
