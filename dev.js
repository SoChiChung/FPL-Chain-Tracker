/* npm run dev：先抓取最新 FPL 数据，成功后再启动本地预览服务器。
 *
 * 用法：npm run dev
 *
 * 可选环境变量：
 *   FPL_PYTHON  指定 Python 解释器路径（默认自动探测，优先已装 tzdata 的隔离环境）
 *   PORT        覆盖预览服务器端口（默认 8000）
 */
'use strict';
const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

function isFile(p) {
  try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
}

// 候选 Python 解释器（按优先级；会逐一验证能否加载 Asia/Shanghai 时区）
function pythonCandidates() {
  const home = os.homedir();
  const base = path.join(home, '.workbuddy', 'binaries', 'python');
  const list = [];
  if (process.env.FPL_PYTHON) list.push(process.env.FPL_PYTHON);
  if (process.platform === 'win32') {
    list.push(
      path.join(base, 'envs', 'default', 'Scripts', 'python.exe'),
      path.join(base, 'versions', '3.13.12', 'python.exe'),
      'C:\\Python314\\python.exe',
      'python',
    );
  } else {
    list.push(
      path.join(base, 'envs', 'default', 'bin', 'python'),
      'python3',
      'python',
    );
  }
  return list;
}

function canLoadTz(py) {
  const r = spawnSync(py, ['-c', 'from zoneinfo import ZoneInfo; ZoneInfo("Asia/Shanghai")'],
    { stdio: 'ignore' });
  return r.status === 0;
}

function findPython() {
  for (const c of pythonCandidates()) {
    if (path.isAbsolute(c) && !isFile(c)) continue;
    if (canLoadTz(c)) return c;
  }
  return null;
}

const py = findPython();
if (!py) {
  console.error('[dev] 未找到可用的 Python（需能加载 Asia/Shanghai 时区）。');
  console.error('[dev] 可用 FPL_PYTHON 环境变量指定解释器路径。');
  process.exit(1);
}
console.log(`[dev] 使用 Python: ${py}`);

console.log('[dev] 正在抓取最新 FPL 数据...');
const crawl = spawnSync(py, ['crawler/run.py'], { stdio: 'inherit' });
if (crawl.status !== 0) {
  console.error(`[dev] 数据抓取失败（退出码 ${crawl.status}），未启动服务器，保留旧数据。`);
  process.exit(crawl.status || 1);
}

console.log('[dev] 数据已更新，启动预览服务器...');
require('./server.js');
