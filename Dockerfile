FROM node:22-alpine

# better-sqlite3 需要 build 工具
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# SQLite 数据目录
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "server.js"]
