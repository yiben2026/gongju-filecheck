FROM node:20-alpine

WORKDIR /app

# 复制依赖文件并安装
COPY package*.json ./
RUN npm install --production

# 复制源码和前端页面
COPY server.js .
COPY 文件核查.html .

# Sealos 会通过环境变量 PORT 指定端口
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
