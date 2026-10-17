/* ==========================================================================
   audit-lab-details.mjs —— 导出全部「失败详情」，供人工审计泄漏
   --------------------------------------------------------------------------
   配套 validate-labs.mjs 用。机械扫描只能挡住"构造得出来"的白嫖，而
   "失败详情里印答案"这类泄漏要靠人读一遍才能发现（答案值五花八门，
   穷举不出通用的字面规则）。这个工具把审计所需的原料一次性导出：

     对每个带判分器（expected）的 lab，喂三种"没做出来"的提交，
     把失败详情（去 HTML、折行、截断）打印出来：
       S1 全空      —— 学生一上来直接点检查
       S2 原样预填   —— 只填了题面给的东西
       S3 全 X      —— 每个"要自己产出"的字段填 X

   审计时看两件事：
     ① 详情里有没有答案值 / 答案清单 / 逐项判定（= 漏洞，修掉后进 PINS 钉住）；
     ② 有没有提交居然判成"通过"（= 白嫖口子，交给 validate-labs.mjs 报错）。
   已标注的揭示通道（run 的输出表 / 💡提示 / 🔓看正确答案）里有答案不算泄漏。

   用法：
     node audit-lab-details.mjs                 # 输出到 audit-lab-details.out.txt
     node audit-lab-details.mjs <输出路径>       # 输出到指定路径（别提交这个文件）
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

/* 注意：不能用 new URL(import.meta.url).pathname —— 本仓库路径里有中文。 */
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || path.join(ROOT, 'audit-lab-details.out.txt');

if (!fs.existsSync(path.join(ROOT, 'assets', 'app.js'))) {
  console.error('请在仓库根目录运行（需要 assets/app.js 与 chapters/）。');
  process.exit(1);
}

const fakeEl = () => ({
  style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, dataset: {},
  setAttribute() {}, appendChild() {}, addEventListener() {}, innerHTML: '', textContent: '',
  children: [], value: '', placeholder: '', checked: false, getContext: () => null,
  insertBefore() {}, removeChild() {}, remove() {}, focus() {}, click() {}, querySelector: () => fakeEl(),
  querySelectorAll: () => [], closest: () => null, onclick: null
});
function makeContext() {
  const sb = vm.createContext({
    window: {}, console, TextEncoder, TextDecoder,
    document: {
      body: fakeEl(), documentElement: { scrollHeight: 0 }, createElement: fakeEl,
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, readyState: 'complete'
    },
    localStorage: { getItem: () => null, setItem() {} },
    addEventListener() {}, innerHeight: 800, scrollY: 0
  });
  sb.window = sb; sb.globalThis = sb;
  return sb;
}
function loadChapter(n) {
  const pad = String(n).padStart(2, '0');
  const f = 'chapters/ch' + pad + '.js';
  if (!fs.existsSync(path.join(ROOT, f))) return null;
  const sb = makeContext();
  for (const g of ['assets/app.js', 'assets/labs.js', 'assets/labx.js', 'assets/chapter.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, g), 'utf8'), sb, { filename: g });
  }
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f });
  return sb;
}

const sb0 = makeContext();
vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/app.js'), 'utf8'), sb0, { filename: 'assets/app.js' });
const COURSE = sb0.COURSE;

const pad = n => String(n).padStart(2, '0');
const dehtml = s => String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const out = [
  '=== 失败详情审计（node audit-lab-details.mjs）===',
  '每个 lab 三种"没做出来"的提交；盯两件事：① 详情里的答案痕迹；② 意外判成通过。', ''
];
let labs = 0, passed = 0;
for (const meta of COURSE.chapters) {
  const n = meta.n != null ? meta.n : meta.no;
  const sb = loadChapter(n);
  if (!sb || !sb.CHAPTER) continue;
  for (const sec of (sb.CHAPTER.sections || [])) {
    if (!sec) continue;
    const L = sec.lab;
    if (!L || typeof L.expected !== 'function') continue;
    labs++;
    const keys = (L.inputs || []).map((inp, i) => inp.key || i);
    const pre = {};
    (L.inputs || []).forEach((inp, i) => { pre[inp.key || i] = inp.value != null ? String(inp.value) : ''; });
    const empty = {}; keys.forEach(k => { empty[k] = ''; });
    const junk = Object.assign({}, pre);
    (L.inputs || []).forEach((inp, i) => {
      const k = inp.key || i;
      if (!(inp.value != null && String(inp.value).trim() !== '')) junk[k] = 'X';
    });
    const subs = [['S1 全空', empty], ['S2 预填', pre], ['S3 全 X', junk]];
    const lines = [];
    for (const [tag, sub] of subs) {
      let d = '';
      try {
        const r = L.expected(sub);
        if (!r || typeof r !== 'object') d = '(返回了非对象：' + JSON.stringify(r) + ')';
        else if (r.ok === true) { d = '(通过 ✅ —— 这个提交居然过了！)'; passed++; }
        else d = dehtml(r.detail);
      } catch (e) { d = '(抛错：' + e.message + ')'; }
      if (lines.length && lines[lines.length - 1][1] === d) continue;   // 去掉重复
      lines.push([tag, d]);
    }
    if (sec.lab) out.push('');
    out.push('===== CH' + pad(n) + ' §' + (sec.h || '?') + '  ' + (L.title || ''));
    for (const [tag, d] of lines) out.push('  [' + tag + '] ' + d.slice(0, 300));
  }
}
out.push('');
out.push('=== 合计 ' + labs + ' 个判分器，' + passed + ' 处"没做出来却通过"（应为 0，多余处交给 validate-labs.mjs 定性）===');

fs.writeFileSync(OUT, out.join('\n') + '\n', 'utf8');
console.log('已写出 ' + OUT + '，' + out.length + ' 行（' + labs + ' 个判分器，意外通过 ' + passed + ' 处）');
