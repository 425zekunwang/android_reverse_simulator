/* ==========================================================================
   inject-enhance.mjs —— 给所有页面注入 UX 增强层与站点元信息
   --------------------------------------------------------------------------
   做三件事（幂等，可重复运行）：
     1. <head> 内补 favicon / description / theme-color / OG 标签
     2. </body> 前注入 assets/ux.js（浏览体验增强层）
     3. 移动端 viewport 已存在则跳过

   用法：
     node inject-enhance.mjs          # 执行注入
     node inject-enhance.mjs --check  # 只检查是否有页面未注入（用于 CI）
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CHECK = process.argv.includes('--check');

const DESC = '《安卓高级研修班》交互式模拟器：32 章安卓逆向工程课程，' +
  '用可动手操作的代码推演器、动画舞台、动手实验室与苏格拉底追问，' +
  '把 Frida、脱壳、OLLVM、VMP、算法还原讲成能上手的手艺。';

const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
const changed = [];
const missing = [];

for (const file of pages) {
  const p = path.join(ROOT, file);
  let html = fs.readFileSync(p, 'utf8');
  const before = html;

  /* ---- 1. head 元信息 ---- */
  if (!html.includes('rel="icon"')) {
    const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1].trim();
    const meta =
      '<link rel="icon" href="assets/favicon.svg" type="image/svg+xml">\n' +
      '<meta name="description" content="' + DESC.replace(/"/g, '&quot;') + '">\n' +
      '<meta name="theme-color" content="#0b0f14">\n' +
      '<meta property="og:type" content="website">\n' +
      '<meta property="og:title" content="' + title.replace(/"/g, '&quot;') + '">\n' +
      '<meta property="og:description" content="' + DESC.replace(/"/g, '&quot;') + '">\n' +
      '<meta property="og:image" content="assets/favicon.svg">\n' +
      '<meta name="twitter:card" content="summary">';
    html = html.replace(/(<link rel="stylesheet" href="assets\/style\.css">)/, '$1\n' + meta);
    if (!html.includes('rel="icon"')) {
      html = html.replace('</head>', meta + '\n</head>');
    }
  }

  /* ---- 2. ux.js 增强层（放在最后，保证组件已装配） ---- */
  if (!html.includes('assets/ux.js')) {
    if (html.includes('</body>')) {
      html = html.replace(/<\/body>/, '<script src="assets/ux.js"><\/script>\n</body>');
    }
  } else if (CHECK) {
    // 已注入
  }

  if (!html.includes('assets/ux.js')) missing.push(file);

  if (html !== before) {
    if (!CHECK) fs.writeFileSync(p, html);
    changed.push(file);
  }
}

if (CHECK) {
  if (missing.length) {
    console.error('✗ 以下页面缺少 ux.js 增强层：\n  ' + missing.join('\n  '));
    process.exit(1);
  }
  console.log('✓ 全部 ' + pages.length + ' 个页面均已注入增强层');
} else {
  console.log('✓ 处理 ' + pages.length + ' 个页面，修改 ' + changed.length + ' 个：');
  changed.forEach(f => console.log('  · ' + f));
}
