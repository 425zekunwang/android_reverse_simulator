/* ==========================================================================
   build-cases.mjs —— 从各章数据文件自动生成 cases.html
   --------------------------------------------------------------------------
   为什么必须自动生成：案例散在 24 个章节数据文件里，手工维护索引页必然不同步。
   这个脚本把每章的 case 组件抽出来，按来源分组渲染成索引页。

   用法：
     node build-cases.mjs            # 生成 cases.html
     node build-cases.mjs --check    # 只检查 cases.html 是否为最新（不写文件）
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CHECK_ONLY = process.argv.includes('--check');

const SOURCES = {
  kanxue:   { label: '看雪',   cls: 'acc',  icon: '📁' },
  github:   { label: 'GitHub', cls: 'cool', icon: '🐙' },
  pojie:    { label: '52破解', cls: 'ok',   icon: '📁' },
  bilibili: { label: 'B站',    cls: 'warn', icon: '📺' }
};
const GROUP_ORDER = ['kanxue', 'github', 'pojie', 'bilibili'];

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ------------------------------------------------------------ 装载运行时 */
function makeSandbox() {
  const fakeEl = () => ({
    className: '', style: {}, dataset: {}, innerHTML: '', textContent: '',
    appendChild() {}, addEventListener() {}, querySelector: () => fakeEl(), querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {} }
  });
  const sb = { console, setTimeout, clearInterval, setInterval, TextEncoder, TextDecoder };
  sb.window = sb;
  sb.document = {
    readyState: 'loading', addEventListener() {},
    querySelector: () => fakeEl(), querySelectorAll: () => [],
    getElementById: () => fakeEl(), createElement: fakeEl,
    body: Object.assign(fakeEl(), { firstChild: null })
  };
  sb.addEventListener = () => {};
  vm.createContext(sb);
  for (const f of ['assets/app.js', 'assets/labs.js', 'assets/labx.js', 'assets/chapter.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f });
  }
  return sb;
}

/* ---------------------------------------------------------------- 采集 */
const sb = makeSandbox();
const COURSE = sb.COURSE;
const entries = [];

for (const meta of COURSE.chapters) {
  const dataFile = `chapters/ch${String(meta.no).padStart(2, '0')}.js`;
  if (!fs.existsSync(path.join(ROOT, dataFile))) continue;
  vm.runInContext(fs.readFileSync(path.join(ROOT, dataFile), 'utf8'), sb, { filename: dataFile });
  const ch = sb.CHAPTER;
  if (!ch) continue;
  (ch.sections || []).forEach(s => {
    if (!s.case) return;
    entries.push({
      no: meta.no,
      file: meta.file,
      h: s.h || '',
      sectionTitle: s.title || '',
      c: s.case
    });
  });
  delete sb.CHAPTER;
}

/* 第 1 章是早期内联格式，案例无法从数据文件抽取。
   这里按同样口径手工登记一条，并标注来源，避免索引页漏掉它。 */
entries.push({
  no: 1, file: 'ch01-frida.html', h: '1.5C',
  sectionTitle: '实战案例：一个银行 App 的三层 Hook 递进',
  c: {
    source: 'kanxue',
    title: '[原创]某金融App 登录请求逆向实战：从梆梆加固反 Frida 自毁到 Go 业务层明文抓包',
    date: '2026-9-7', author: 'xiao_qi_lin',
    target: '某银行 App v1.0.4（梆梆 DexHelper 抽取式壳 + Go 业务层）',
    terms: ['Interceptor.attach', 'inline hook', 'trampoline', 'AAPCS64']
  },
  manual: true
});

entries.sort((a, b) => a.no - b.no);
entries.forEach(e => { e.c._no = e.no; e.c._h = e.h; e.c._st = e.sectionTitle; });

/* ---------------------------------------------------------------- 统计 */
const bySource = {};
entries.forEach(e => {
  const k = SOURCES[e.c.source] ? e.c.source : 'kanxue';
  (bySource[k] = bySource[k] || []).push(e);
});
const total = entries.length;
const chaptersCovered = new Set(entries.map(e => e.no)).size;
const dates = entries.map(e => e.c.date).filter(d => /^\d{4}-\d{1,2}-\d{1,2}$/.test(d));
const latest = dates.sort((a, b) => {
  const p = s => s.split('-').map(Number);
  const [ay, am, ad] = p(a), [by, bm, bd] = p(b);
  return (ay - by) || (am - bm) || (ad - bd);
}).pop() || '—';

/* ---------------------------------------------------------------- 渲染 */
function renderItem(e) {
  const c = e.c;
  const src = SOURCES[c.source] || SOURCES.kanxue;
  const terms = (c.terms || []).slice(0, 6)
    .map(t => `<span class="pill" style="font-size:11px">${esc(t)}</span>`).join(' ');
  return `<a class="caseidx-item" href="${e.file}#sec-${c._h}">
  <div class="ci-top">
    <span class="pill ${src.cls}">${src.label}</span>
    <span class="pill mono">第 ${c._no} 章 · ${esc(c._h)}</span>
  </div>
  <div class="ci-title">${esc(c._st || c.title)}</div>
  <div class="ci-meta" style="margin-top:6px;color:var(--fg-3)">原帖：${esc(c.title)}</div>
  ${c.target ? `<div class="ci-meta">🎯 ${esc(c.target)}</div>` : ''}
  <div class="ci-meta">📅 ${esc(c.date || '日期未标注')} ｜ ✍️ ${esc(c.author || '作者未标注')}</div>
  ${terms ? `<div class="ci-meta" style="margin-top:8px">${terms}</div>` : ''}
</a>`;
}

const groups = GROUP_ORDER
  .filter(k => bySource[k] && bySource[k].length)
  .map(k => `  <div class="caseidx-group">
    <h3>${SOURCES[k].icon} ${SOURCES[k].label}（${bySource[k].length} 条）</h3>
    <div class="caseidx">${bySource[k].map(renderItem).join('\n')}</div>
  </div>`).join('\n\n');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>实战案例库 | 安卓高级研修班模拟器</title>
<link rel="stylesheet" href="assets/style.css">
</head>
<body data-no-badge>
<div class="wrap">

  <div class="chapter-hero">
    <span class="ch-no">CASE LIBRARY</span>
    <h1>实战案例库</h1>
    <p class="lede">
      从<strong>看雪论坛</strong>与<strong>GitHub 公开仓库</strong>采集的真实逆向案例，每条都<strong>用本课程的方法论做了拆解</strong>，
      并链接到原始来源。案例的日期尽量取新——这个行业的对抗强度变化很快，两年前的"最佳实践"今年可能已经失效。
    </p>
    <div class="hero-meta">
      <span>共 <b>${total}</b> 条案例</span>
      <span>覆盖 <b>${chaptersCovered}</b> 章</span>
      <span>最新 <b>${esc(latest)}</b></span>
    </div>
  </div>

  <div class="note warn">
    <div class="note-h">⚠️ 关于案例来源的四点说明</div>
    <ul style="margin-bottom:0">
      <li><b>只收录实际抓取到内容并有可验证 URL 的案例。</b>看雪论坛部分帖子有「登录后可查看完整内容」门控，
        这类帖子只收录其<em>公开可见部分</em>，无法确证正文的一律不收录。</li>
      <li><b>验证墙是按帖命中的，不是全站行为。</b>本站实测：同一批看雪链接里，有的能取到完整正文，
        有的只返回人机验证页。所以采集时必须逐帖验证，不能凭站点印象下结论。</li>
      <li><b>案例里的技术结论属于原作者</b>，本站做的是「用本课知识体系重新拆解」。
        凡原作者自己标注为不确定的地方，我们照样标注为<span class="pill warn">待核实</span>，不代其下结论。</li>
      <li><b>52破解（52pojie.cn）当前无法抓取</b>（返回空内容或需登录），因此本库暂无该来源的案例。
        这属于采集能力的限制，不代表该站没有优质内容。</li>
    </ul>
  </div>

  <div class="note key">
    <div class="note-h">🔑 怎么用这个案例库</div>
    <ol style="margin-bottom:0">
      <li><b>学完一章后</b>，找到该章的案例，试着在点开原帖之前<b>自己先想一遍</b>：如果是我，第一步查什么？</li>
      <li>然后对照案例里的「作者的方法论」和「用本课方法论拆解」，看你的思路差在哪。</li>
      <li><b>重点读「局限与未完成」。</b>公开的案例往往只讲成功路径，但真正的经验藏在"哪里没做成、为什么"里。</li>
    </ol>
  </div>

${groups}

  <div class="chapnav">
    <a href="index.html"><div class="cn-dir">◀ 返回</div><div class="cn-title">课程地图</div></a>
    <a class="next" href="toolbox.html"><div class="cn-dir">工具箱 ▶</div><div class="cn-title">40+ 真实开源项目</div></a>
  </div>

  <p class="muted center" style="margin-top:40px">
    本页由 <code>node build-cases.mjs</code> 从各章数据文件自动生成，请勿手工编辑
  </p>
</div>
</body>
</html>
`;

/* ---------------------------------------------------------------- 输出 */
const target = path.join(ROOT, 'cases.html');
const old = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';

if (CHECK_ONLY) {
  if (old === html) {
    console.log(`✅ cases.html 是最新的（${total} 条案例，覆盖 ${chaptersCovered} 章）`);
  } else {
    console.log(`❌ cases.html 已过期，请运行 node build-cases.mjs 重新生成`);
    process.exit(1);
  }
} else {
  fs.writeFileSync(target, html);
  console.log(`✅ 已生成 cases.html：${total} 条案例，覆盖 ${chaptersCovered} 章，最新 ${latest}`);
  const manual = entries.filter(e => e.manual).length;
  if (manual) console.log(`   其中 ${manual} 条为手工登记（第 1 章为早期内联格式，无法自动抽取）`);
  Object.keys(bySource).forEach(k => console.log(`   ${SOURCES[k].label}: ${bySource[k].length} 条`));
}
