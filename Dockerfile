FROM node:alpine

# 安装基本工具
RUN apk add --no-cache curl unzip

# 设置工作目录
WORKDIR /app

# 复制项目文件
COPY . .

# 安装 Node 依赖
RUN npm install

# (可选) 提前下载并安装 Xray/V2Ray 核心，避免每次启动都下载
# 这里以 Xray 为例，逻辑通用
RUN wget https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip && \
    unzip Xray-linux-64.zip && \
    mv xray /usr/bin/xray && \
    rm -f Xray-linux-64.zip *.dat

# 赋予执行权限
RUN chmod +x /app/index.js

# 设置启动命令
CMD ["node", "index.js"]
