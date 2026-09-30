/* ==========================================================================
   serve.mjs —— 本地静态预览服务器（零依赖）
   --------------------------------------------------------------------------
   为什么需要：浏览器对 file:// 有诸多限制（剪贴板 API、部分 fetch、
   以及跨文件脚本在某些配置下会被拦），用 http:// 预览才能真实还原使用体验。

   用法：
     node serve.mjs            # 默认 http://127.0.0.1:8788
     node serve.mjs 9000       # 指定端口
   ========================================================================== */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv[2] || '8788', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';

  // 目录穿越防护
  const full = path.normalize(path.join(ROOT, p));
  if (!full.startsWith(ROOT)) {
    res.writeHead(403).end('403');
    return;
  }

  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + p);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log('preview server ready: http://127.0.0.1:' + PORT + '/');
  console.log('root: ' + ROOT);
});
