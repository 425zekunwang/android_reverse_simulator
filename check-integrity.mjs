/* 完整性检查：每个章节文件的内容是否与 COURSE 元数据一致
   （标题必须匹配 —— 这正是"重命名置换互相覆盖"事故会破坏的不变量） */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const fakeEl = () => ({
  style: {}, dataset: {}, className: '', innerHTML: '', textContent: '',
  classList: { add() {}, remove() {}, contains: () => false },
  appendChild() {}, insertBefore() {}, remove() {}, setAttribute() {}, getAttribute: () => null,
  addEventListener() {}, querySelector: () => fakeEl(), querySelectorAll: () => [], closest: () => null,
  focus() {}, onclick: null,
});
const sb = vm.createContext({
  window: {}, console,
  document: {
    body: fakeEl(), documentElement: { scrollHeight: 0 }, createElement: fakeEl,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, readyState: 'complete',
  },
  localStorage: { getItem: () => null, setItem() {} },
  addEventListener() {}, innerHeight: 800, scrollY: 0,
});
sb.window = sb; sb.globalThis = sb;

for (const f of ['assets/app.js', 'assets/labs.js', 'assets/labx.js', 'assets/chapter.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f });
}
const COURSE = sb.COURSE;

let bad = 0, seen = 0;
for (const meta of COURSE.chapters) {
  seen++;
  const df = `chapters/ch${String(meta.no).padStart(2, '0')}.js`;
  const p = path.join(ROOT, df);

  // 内联格式章（原第 1 章，现第 15 章）：没有数据文件，检查外壳
  if (!fs.existsSync(p)) {
    const shellPath = path.join(ROOT, meta.file);
    if (!fs.existsSync(shellPath)) { console.log(`✗ CH${meta.no}: ${df} 与外壳 ${meta.file} 都不存在`); bad++; continue; }
    const shell = fs.readFileSync(shellPath, 'utf8');
    const t = /<title>第 \d+ 章 · ([^|<]+)/.exec(shell);
    const okTitle = t && t[1].trim() === meta.title;
    const okNo = new RegExp(`data-chapter="${meta.no}"`).test(shell);
    if (!okTitle || !okNo) {
      console.log(`✗ CH${meta.no} (内联) 标题「${t ? t[1].trim() : '?'}」vs meta「${meta.title}」 data-chapter ok=${okNo}`);
      bad++;
    }
    continue;
  }

  vm.runInContext(fs.readFileSync(p, 'utf8'), sb, { filename: df });
  const ch = sb.CHAPTER;
  const okNo = ch && ch.no === meta.no;
  const okTitle = ch && ch.title === meta.title;
  if (!okNo || !okTitle) {
    console.log(`✗ CH${meta.no} ${df}`);
    console.log(`    meta: no=${meta.no} title=${meta.title}`);
    console.log(`    data: no=${ch ? ch.no : '?'} title=${ch ? ch.title : '?'}`);
    bad++;
  }
  delete sb.CHAPTER;
}

/* 外壳 HTML 三处必须自洽：文件名 == data-chapter == <title>第 N 章。
   历史教训：重排时 "第 N 章" 与 chNN- 链接被两条规则先后命中，
   会出现 "1 → 15 → 29" 这种二次改写，只有把三者对账才抓得到。 */
for (const f of fs.readdirSync(ROOT)) {
  const m = /^ch(\d{2})(-[a-z0-9-]+\.html)$/.exec(f);
  if (!m) continue;
  const fileNo = Number(m[1]);
  const shell = fs.readFileSync(path.join(ROOT, f), 'utf8');

  const t = /<title>第\s*(\d+)\s*章/.exec(shell);
  const titleNo = t ? Number(t[1]) : null;
  const d = /<body data-chapter="(\d+)"/.exec(shell);
  const dataNo = d ? Number(d[1]) : null;

  const problems = [];
  if (titleNo === null) problems.push('<title> 缺少「第 N 章」');
  else if (titleNo !== fileNo) problems.push(`<title> 写的是第 ${titleNo} 章，文件名是 ch${m[1]}`);
  if (dataNo === null) problems.push('缺少 data-chapter');
  else if (dataNo !== fileNo) problems.push(`data-chapter=${dataNo}，文件名是 ch${m[1]}`);

  // 外壳引用的数据文件也必须同号（内联格式章除外）
  const ds = /chapters\/ch(\d{2})\.js/.exec(shell);
  if (ds && Number(ds[1]) !== fileNo) problems.push(`引用 chapters/ch${ds[1]}.js，文件名是 ch${m[1]}`);

  if (problems.length) {
    console.log(`✗ ${f}: ${problems.join('；')}`);
    bad++;
  }
}
console.log(`检查 ${seen} 章；` + (bad === 0 ? '✅ 内容与元数据全部一致' : `❌ ${bad} 章不一致`));
process.exit(bad ? 1 : 0);
