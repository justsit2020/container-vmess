FROM node:alpine

# 关键：安装 wget 和 unzip 以便在构建时下载核心
RUN apk add --no-cache curl wget unzip

WORKDIR /app

# 先拷贝 package.json 并安装依赖
COPY package.json .
RUN npm install

# 关键步骤：在构建镜像时就下载并安装好 Xray，不要留到 index.js 去做
RUN wget -q https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip && \
    unzip -q Xray-linux-64.zip && \
    mv xray /usr/bin/xray && \
    chmod +x /usr/bin/xray && \
    rm -f Xray-linux-64.zip *.dat *.json

# 拷贝剩余代码
COPY . .

CMD ["npm", "start"]
