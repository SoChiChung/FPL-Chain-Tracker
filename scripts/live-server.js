/* 本地预览「Vercel 部署后的行为」：静态站点 + 实时数据接口挂载在同一端口
 *
 * 用法：npm run live        （端口可用环境变量 PORT 覆盖，默认 8001）
 *
 * 与 npm start 的差别：
 *   npm start  只抓一次数据，页面读 data/*.json 静态快照
 *   npm run live 挂载 api/fpl-live 到 /api/fpl-live，页面像线上一样按 GW 阶段自动刷新
 */
'use strict';

const http = require('http');
const handleStatic = require('../server.js').handleStatic;
const liveHandler = require('../api/fpl-live.js');

const PORT = process.env.PORT || 8001;
const API_PREFIX = '/api/fpl-live';

const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  if (pathname === API_PREFIX || pathname === `${API_PREFIX}/`) {
    Promise.resolve(liveHandler(req, res)).catch((err) => {
      if (res.headersSent) return;
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'live_handler_failed', message: String(err && err.message) }));
    });
    return;
  }
  handleStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`FPL Chain Tracker（含实时接口）已启动: http://localhost:${PORT}`);
  console.log(`实时接口: http://localhost:${PORT}${API_PREFIX}?file=summary.json`);
});
