/* FPL Chain Tracker 本地静态服务器（零依赖，Node 内置模块）
 *
 * 用法：
 *   npm run serve      只启动静态服务器（端口用环境变量 PORT 覆盖，默认 8000）
 *   npm start          先抓取最新数据再启动（见 dev.js）
 *
 * 也可作为模块被复用：require('./server.js').createStaticServer()
 * 或取用请求处理器 handleStatic（scripts/live-server.js 用它叠加实时接口）。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 8000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function handleStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      // 本地预览不做缓存，改完刷新即可见
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function createStaticServer() {
  return http.createServer(handleStatic);
}

function startStaticServer(port = PORT) {
  const server = createStaticServer();
  server.listen(port, () => {
    console.log(`FPL Chain Tracker 已启动: http://localhost:${port}`);
  });
  return server;
}

module.exports = { handleStatic, createStaticServer, startStaticServer, ROOT, PORT };

if (require.main === module) {
  startStaticServer();
}
