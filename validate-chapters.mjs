/* ==========================================================================
   validate-chapters.mjs —— 章节数据文件结构与一致性校验
   --------------------------------------------------------------------------
   这个仓库里的章节正文是「数据文件」（chapters/chNN.js），
   结构错误（重复键、decision 断链、teacher 缺 model）不会在浏览器里报错，
   只会静默少渲染一块。所以必须有静态校验。

   用法：
     node validate-chapters.mjs            # 校验全部章节
     node validate-chapters.mjs 20 21      # 只校验指定章节
     node validate-chapters.mjs --quiet    # 只输出问题
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');
const only = args.filter(a => /^\d+$/.test(a)).map(Number);

/* ------------------------------------------------------------------ 报告 */
const problems = [];   // {level:'error'|'warn', chapter, msg}
const stats = [];
const err = (chapter, msg) => problems.push({ level: 'error', chapter, msg });
const warn = (chapter, msg) => problems.push({ level: 'warn', chapter, msg });

/* ------------------------------------------------------ 在沙箱里装载运行时 */
function makeSandbox() {
  /* 假元素：让 S / CLS / SET 以及动画里对 DOM 的直接访问都不会因为 null 而抛异常，
     这样校验脚本才能"真的执行"一遍动画与实验。 */
  const fakeEl = () => ({
    className: '', style: {}, dataset: {}, innerHTML: '', textContent: '', value: '',
    tabIndex: 0,
    appendChild() {}, insertBefore() {}, remove() {},
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {}, focus() {}, blur() {},
    scrollIntoView() {}, requestFullscreen() { return { catch() {} }; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    closest() { return fakeEl(); },
    offsetWidth: 0, scrollTop: 0, scrollHeight: 0
  });
  const doc = {
    readyState: 'loading',
    addEventListener() {},
    querySelector() { return fakeEl(); },
    querySelectorAll() { return []; },
    getElementById() { return fakeEl(); },
    createElement() { return fakeEl(); },
    body: Object.assign(fakeEl(), { firstChild: null }),
    fullscreenElement: null, exitFullscreen() {}
  };
  const sb = { console, setTimeout, clearInterval, setInterval };
  // 浏览器全局：算法库里用了 TextEncoder / TextDecoder
  sb.TextEncoder = TextEncoder;
  sb.TextDecoder = TextDecoder;
  sb.window = sb;
  sb.document = doc;
  sb.addEventListener = () => {};
  sb.innerHeight = 0; sb.scrollY = 0;
  vm.createContext(sb);
  const run = f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f });
  run('assets/app.js');
  run('assets/labs.js');
  run('assets/labx.js');
  run('assets/chapter.js');
  return sb;
}

/* --------------------------------------------------- 重复键扫描（行级+括号） */
/* 优点：不依赖解析器，能抓出 {a:1, a:2} 这种被 JS 静默覆盖的键。
   做法：逐行跟踪 {} 深度，把「当前深度上出现过的键」记在 open[depth]；
   当深度下降时，说明该层的对象已经闭合，检查这一层有没有重复键。 */
function findDuplicateKeys(src) {
  const lines = src.split(/\r?\n/);
  const open = new Map();          // depth -> Map(key -> lineNo)
  const dups = [];
  const st = { q: null, block: false };
  let depth = 0;

  const braceDelta = line => {
    let d = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i], n = line[i + 1];
      if (st.block) { if (c === '*' && n === '/') { st.block = false; i++; } continue; }
      if (st.q) {
        if (c === '\\') { i++; continue; }
        if (c === st.q) st.q = null;
        continue;
      }
      if (c === '/' && n === '/') break;
      if (c === '/' && n === '*') { st.block = true; i++; continue; }
      if (c === "'" || c === '"' || c === '`') { st.q = c; continue; }
      if (c === '{') d++;
      else if (c === '}') d--;
    }
    return d;
  };

  lines.forEach((ln, idx) => {
    const lineNo = idx + 1;
    const depthBefore = depth;
    const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(ln);
    if (m) {
      if (!open.has(depthBefore)) open.set(depthBefore, new Map());
      const map = open.get(depthBefore);
      if (map.has(m[1])) {
        dups.push({ key: m[1], line: lineNo, first: map.get(m[1]), depth: depthBefore });
      } else map.set(m[1], lineNo);
    }
    const d = braceDelta(ln);
    if (d !== 0) {
      const before = depth;
      depth += d;
      if (depth < before) for (let k = before; k > depth; k--) open.delete(k);
    }
  });
  return dups;
}

/* ------------------------------------------------------------ 组件级校验 */
const CASE_SOURCES = ['kanxue', 'pojie', 'bilibili', 'github'];

function checkStepper(ch, tag, s) {
  if (!s.lines || !s.lines.length) return err(ch, tag + ' stepper.lines 为空');
  s.lines.forEach((l, i) => {
    if (l.code == null || String(l.code).trim() === '') warn(ch, `${tag} stepper 第 ${i + 1} 步没有 code`);
    if (!l.note) warn(ch, `${tag} stepper 第 ${i + 1} 步没有 note`);
  });
}

function checkStage(ch, tag, s) {
  if (!s.render) err(ch, tag + ' stage 缺 render');
  if (!s.steps || !s.steps.length) return err(ch, tag + ' stage.steps 为空');
  s.steps.forEach((st, i) => {
    if (!st.run && !st.note) warn(ch, `${tag} stage 第 ${i + 1} 步既没有 run 也没有 note`);
    if (st.run && typeof st.run !== 'function') err(ch, `${tag} stage 第 ${i + 1} 步 run 不是函数`);
  });
}

function checkTerm(ch, tag, s) {
  if (!s.lines || !s.lines.length) return err(ch, tag + ' term.lines 为空');
  s.lines.forEach((l, i) => {
    // s:'' 是刻意的空行（分组留白），只有 s 完全缺失才算问题
    if (l.s == null) warn(ch, `${tag} term 第 ${i + 1} 行没有 s`);
    if (l.t && !'poewd'.includes(l.t)) err(ch, `${tag} term 第 ${i + 1} 行 t="${l.t}" 非法（只能是 p/o/e/w/d）`);
  });
}

function checkDecision(ch, tag, s) {
  const nodes = s.nodes || {};
  if (!s.start) return err(ch, tag + ' decision 缺 start');
  if (!nodes[s.start]) return err(ch, tag + ` decision.start="${s.start}" 不在 nodes 里`);
  const ids = Object.keys(nodes);
  const reachable = new Set();
  const queue = [s.start];
  let terminals = 0;
  while (queue.length) {
    const id = queue.shift();
    if (reachable.has(id)) continue;
    reachable.add(id);
    const n = nodes[id];
    if (!n) { err(ch, `${tag} decision 引用了不存在的节点 "${id}"`); continue; }
    if (n.terminal) { terminals++; if (!n.result) warn(ch, `${tag} decision 终节点 "${id}" 没有 result`); }
    else if (n.choices && n.choices.length) {
      n.choices.forEach((c, ci) => {
        if (!c.t) err(ch, `${tag} decision "${id}" 的选项 ${ci} 缺 t`);
        if (!c.next) err(ch, `${tag} decision "${id}" 的选项 ${ci} 缺 next`);
        else if (!nodes[c.next]) err(ch, `${tag} decision "${id}" → "${c.next}" 节点不存在`);
        else queue.push(c.next);
      });
    } else if (n.scenario || n.q) {
      err(ch, `${tag} decision 节点 "${id}" 既非 terminal 也没有 choices（死路）`);
    }
  }
  ids.forEach(id => { if (!reachable.has(id)) warn(ch, `${tag} decision 节点 "${id}" 从 start 不可达`); });
  if (!terminals) err(ch, `${tag} decision 没有任何 terminal 节点`);
}

function checkQuiz(ch, tag, s) {
  if (!s.id) err(ch, tag + ' quiz 缺 id');
  if (!s.stem) err(ch, tag + ' quiz 缺 stem');
  if (!s.options || s.options.length < 2) return err(ch, tag + ' quiz.options 少于 2 项');
  const answers = Array.isArray(s.answer) ? s.answer : [s.answer];
  answers.forEach(a => {
    if (typeof a !== 'number' || a < 0 || a >= s.options.length) {
      err(ch, `${tag} quiz "${s.id}" 的 answer=${a} 超出 options 范围`);
    }
  });
  s.options.forEach((o, i) => {
    if (!o.t) err(ch, `${tag} quiz "${s.id}" 选项 ${i} 缺 t`);
    if (!o.why) warn(ch, `${tag} quiz "${s.id}" 选项 ${i} 缺 why`);
  });
  if (!s.explain) err(ch, `${tag} quiz "${s.id}" 缺 explain`);
}

function checkLab(ch, tag, s) {
  if (!s.title) err(ch, tag + ' lab 缺 title');
  const inputs = s.inputs || [];
  if (!inputs.length) warn(ch, tag + ' lab 没有 inputs');
  const keys = inputs.map(i => i.key || '');
  const dupk = keys.filter((k, i) => k && keys.indexOf(k) !== i);
  if (dupk.length) err(ch, `${tag} lab 的 input key 重复：${[...new Set(dupk)].join(', ')}`);
  inputs.forEach((i, idx) => { if (!i.label) err(ch, `${tag} lab input ${idx} 缺 label`); });
  // 观察型实验（expected 恒返回 ok，目的是看现象）本来就不需要"正确答案"
  if (s.expected && !s.showAnswer) warn(ch, tag + ' lab 有 expected 但没有 showAnswer');
  if (s.expected && typeof s.expected !== 'function') err(ch, tag + ' lab.expected 不是函数');
  if (s.run && typeof s.run !== 'function') err(ch, tag + ' lab.run 不是函数');
  if (!s.run && !s.expected) err(ch, tag + ' lab 既没有 run 也没有 expected');
}

function checkCase(ch, tag, s) {
  if (!s.title) err(ch, tag + ' case 缺 title');
  if (!CASE_SOURCES.includes(s.source)) err(ch, `${tag} case.source="${s.source}" 非法（只能 ${CASE_SOURCES.join('/')}）`);
  if (!s.link) warn(ch, `${tag} case 缺 link（无法回溯原帖）`);
  else if (!/^https?:\/\//.test(s.link)) err(ch, `${tag} case.link 不是 http(s) URL：${s.link}`);
  if (!s.analysis) warn(ch, tag + ' case 缺 analysis（用本课方法论拆解）');
  if (!s.limits) warn(ch, tag + ' case 缺 limits（局限与未完成）');
}

function checkTeacher(ch, t) {
  if (!t.id) err(ch, 'teacher 缺 id');
  if (!t.questions || !t.questions.length) return err(ch, 'teacher.questions 为空');
  const ids = t.questions.map(q => q.id);
  const dup = ids.filter((k, i) => ids.indexOf(k) !== i);
  if (dup.length) err(ch, `teacher 题目 id 重复：${[...new Set(dup)].join(', ')}`);
  t.questions.forEach((q, i) => {
    const tag = `teacher 第 ${i + 1} 题(${q.id || '无 id'})`;
    if (!q.id) err(ch, tag + ' 缺 id');
    if (!q.q) err(ch, tag + ' 缺 q');
    if (!q.model) err(ch, tag + ' 缺 model（参考答案）');
    if (!q.concepts || q.concepts.length < 2) err(ch, tag + ' concepts 少于 2 条，判分会失去分辨度');
    (q.concepts || []).forEach((c, ci) => {
      if (!c.label) err(ch, `${tag} concepts[${ci}] 缺 label`);
      if (!c.any || !c.any.length) err(ch, `${tag} concepts[${ci}]("${c.label}") 缺 any 匹配词`);
    });
    if (!q.hints || !q.hints.length) warn(ch, tag + ' 没有 hints');
    if (!q.probes || !q.probes.length) warn(ch, tag + ' 没有 probes（追问）');
    if (q.threshold != null && (q.threshold <= 0 || q.threshold > 1)) err(ch, tag + ` threshold=${q.threshold} 应在 (0,1]`);
  });
}

/* ------------------------------------------- 真实执行：Lab 与动画必须跑得通 */
/* 结构对了不代表代码能跑。一个会抛异常的 Lab 在浏览器里只显示"计算出错"，
   一个会抛异常的 stage.run 会让动画中途卡住——两者都不会让页面报错到你能看见。
   所以这里用输入框的预填值真的跑一遍。 */
function execLab(ch, tag, cfg) {
  const vals = {};
  (cfg.inputs || []).forEach((inp, i) => {
    vals[inp.key != null ? inp.key : i] = inp.value != null ? inp.value : '';
  });

  if (typeof cfg.run === 'function') {
    let out;
    try { out = cfg.run(vals, {}); }
    catch (e) { err(ch, `${tag} lab.run 用预填值执行时抛异常：${e.message}`); out = undefined; }
    if (out !== undefined) {
      if (typeof out !== 'string') err(ch, `${tag} lab.run 应返回 HTML 字符串，实际返回 ${typeof out}`);
      else if (!out.trim()) err(ch, `${tag} lab.run 返回了空字符串（运行区会一片空白）`);
    }
  }

  if (typeof cfg.expected === 'function') {
    // ① 空输入：不能抛异常
    try {
      const empty = {};
      (cfg.inputs || []).forEach((inp, i) => { empty[inp.key != null ? inp.key : i] = ''; });
      const r = cfg.expected(empty);
      if (!r || typeof r !== 'object') err(ch, `${tag} lab.expected 空输入时没返回对象`);
      else if (typeof r.ok !== 'boolean') err(ch, `${tag} lab.expected 返回的 ok 不是布尔值`);
    } catch (e) { err(ch, `${tag} lab.expected 空输入时抛异常：${e.message}`); }
    // ② 预填值：同样不能抛
    try {
      const r = cfg.expected(vals);
      if (!r || typeof r.ok !== 'boolean') err(ch, `${tag} lab.expected 预填值下没返回 {ok:boolean}`);
    } catch (e) { err(ch, `${tag} lab.expected 预填值下抛异常：${e.message}`); }
  }

  // ③ 提示与答案必须存在且非空
  if (cfg.hint != null && !String(cfg.hint).trim()) warn(ch, `${tag} lab.hint 是空的`);
  if (cfg.showAnswer != null && !String(cfg.showAnswer).trim()) warn(ch, `${tag} lab.showAnswer 是空的`);
}

function execStage(ch, tag, cfg) {
  const fakeRoot = sb.document.createElement();
  const ctx = {
    root: fakeRoot,
    $: () => sb.document.createElement(),
    $$: () => [],
    cap: () => {},
    i: 0
  };
  if (typeof cfg.reset === 'function') {
    try { cfg.reset(ctx); } catch (e) { err(ch, `${tag} stage.reset 抛异常：${e.message}`); }
  }
  (cfg.steps || []).forEach((st, i) => {
    if (typeof st.run !== 'function') return;
    try { st.run(ctx); } catch (e) { err(ch, `${tag} stage.steps[${i}].run 抛异常：${e.message}`); }
  });
}

/* ------------------------------------- 渲染 + 装配冒烟测试（每个组件都真的构造一次） */
/* 结构校验只能证明"字段在"，不能证明"组件吃得下"。这里把这一章真的交给
   renderChapter + mountAll 跑一遍：9 个组件的构造函数全部会被执行，
   配置字段写错、id 对不上、类型不对，都会在这里炸出来。
   注意：chapter.js 的 pending 数组是累积的，所以每章必须用全新的沙箱。 */
function smokeRender(dataFile, label) {
  let s;
  try {
    s = makeSandbox();
    vm.runInContext(fs.readFileSync(path.join(ROOT, dataFile), 'utf8'), s, { filename: dataFile });
  } catch (e) {
    err(label, `渲染冒烟：装载失败 ${e.message}`);
    return;
  }
  if (!s.CHAPTER) return;
  try {
    s.AKKC_renderChapter(s.CHAPTER);
  } catch (e) {
    err(label, `渲染失败（renderChapter 抛异常）：${e.message}`);
    return;
  }
  try {
    s.AKKC_mountAll();
  } catch (e) {
    err(label, `组件装配失败（mountAll 抛异常）：${e.message}`);
  }
}

/* ------------------------------------------- 动画 id 一致性（浏览器才会暴露的坑） */
/* 为什么必须单独查：S('some-id') 在元素不存在时是**静默无操作**——
   浏览器里不报错、控制台干净、页面照常显示，只是这一步动画没有任何反应。
   假 DOM 沙箱里同样什么都不做，所以"能跑通"完全不能证明 id 是对的。
   做法：从 render 的 HTML 里抽出所有 id，再从 reset / steps[].run 的**函数源码**里
   抽出所有被引用的 id，两边对账。 */
function checkStageIds(ch, tag, cfg) {
  const renderSrc = String(cfg.render || '');
  const renderIds = new Set();
  for (const m of renderSrc.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) {
    renderIds.add(m[1]);
  }

  const staticRefs = new Set();   // 字面量 id，必须精确存在
  const dynamicRefs = new Map();  // 前缀 -> 出处，形如 SET('g' + i)：无法枚举，但前缀必须出现在 render 里
  const scan = fn => {
    if (typeof fn !== 'function') return;
    const src = String(fn);
    const pats = [
      /\b(?:S|CLS|SET)\s*\(\s*['"]([^'"]+)['"]/g,      // 本项目自带的三个动画助手
      /getElementById\s*\(\s*['"]([^'"]+)['"]/g,        // 直接操作 DOM
      /\$\(\s*['"]#([^'"]+)['"]/g,                      // jQuery 风格选择器
      /querySelector\s*\(\s*['"]#([^'"]+)['"]/g
    ];
    for (const p of pats) {
      for (const m of src.matchAll(p)) {
        const rest = src.slice(m.index + m[0].length);
        if (/^\s*\+/.test(rest)) dynamicRefs.set(m[1], true);  // 拼接出来的 id
        else staticRefs.add(m[1]);
      }
    }
  };
  scan(cfg.reset);
  (cfg.steps || []).forEach(s => scan(s.run));

  if (!renderIds.size && (staticRefs.size || dynamicRefs.size)) {
    err(ch, `${tag} stage.render 里没有任何 id，但 reset/steps 引用了 ` +
      `${[...staticRefs, ...dynamicRefs.keys()].join(', ')}——动画必然无效`);
    return;
  }

  const missing = [...staticRefs].filter(id => !renderIds.has(id));
  if (missing.length) {
    err(ch, `${tag} stage 引用了 render 里不存在的 id：${missing.join(', ')}（浏览器里会静默失效，不报错）`);
  }

  // 动态 id 只能退一步核对前缀：render 里必须出现过这个前缀字面量
  const badPrefix = [...dynamicRefs.keys()].filter(p => !renderSrc.includes(p));
  if (badPrefix.length) {
    err(ch, `${tag} stage 用拼接方式引用了前缀为 ${badPrefix.map(p => "'" + p + "'").join(', ')} 的 id，` +
      `但 render 里找不到这个前缀（两边用了不同的助记符，动画会对不上）`);
  }
}

/* ------------------------------------------------- CSS 类名存在性（防"无样式"） */
let CSS_CLASSES = null;
function loadCssClasses() {
  const set = new Set();
  if (!fs.existsSync(path.join(ROOT, 'assets/style.css'))) return set;
  const css = fs.readFileSync(path.join(ROOT, 'assets/style.css'), 'utf8');
  for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) set.add(m[1]);
  return set;
}
function checkClasses(label, dataFile, cssClasses) {
  const src = fs.readFileSync(path.join(ROOT, dataFile), 'utf8');
  const used = new Set();
  for (const m of src.matchAll(/class\s*=\s*\\?["']([^"'\\]+)\\?["']/g)) {
    m[1].split(/\s+/).forEach(c => {
      if (!c || c.length < 2) return;
      if (/[${}()+<>=]/.test(c)) return;            // 拼接/表达式片段，跳过
      used.add(c);
    });
  }
  const unknown = [...used].filter(c => !cssClasses.has(c)).sort();
  if (unknown.length) {
    warn(label, `用到了 style.css 里未定义的 class（会没有样式）：${unknown.join(', ')}`);
  }
}

/* 每个章节页实际会生成哪些小节锚点。
   注意：锚点是 chapter.js 在**运行时**写进 DOM 的（<h2 id="sec-<h>">），
   静态外壳 HTML 里没有——所以必须按章节数据的 h 值建立索引，不能去 grep 外壳文件。
   第 1 章是自包含格式，锚点直接写死在 HTML 里，单独抽取。 */
const sectionIndex = new Map();   // 章节页文件名 -> Set(小节号)
/* 本次真的被校验过的章节页文件。
   为什么要单独记：单章运行（node validate-chapters.mjs 30）时 sectionIndex 只装了
   被校验的那一章，下面「案例库深链」会把指向其它章的深链全报成"该章没有可索引的小节"——
   那是误报。只有"这一章本次校验过、但它一个小节都没有"才值得报错。 */
const validatedFiles = new Set();

/* ------------------------------------------------------------------ 主流程 */
const sb = makeSandbox();
CSS_CLASSES = loadCssClasses();
const COURSE = sb.COURSE;
if (!COURSE || !Array.isArray(COURSE.chapters)) {
  console.error('❌ 无法从 assets/app.js 读出 COURSE.chapters');
  process.exit(1);
}
if (QUIET === false) console.log(`课程元数据：${COURSE.chapters.length} 章，${Object.keys(COURSE.tracks).length} 个阶段\n`);

/* 元数据自身一致性 */
const nos = COURSE.chapters.map(c => c.no);
const dupNo = nos.filter((n, i) => nos.indexOf(n) !== i);
if (dupNo.length) err('COURSE', `章节编号重复：${[...new Set(dupNo)].join(', ')}`);
for (let i = 1; i < COURSE.chapters.length; i++) {
  if (COURSE.chapters[i].no !== COURSE.chapters[i - 1].no + 1) {
    err('COURSE', `章节编号不连续：${COURSE.chapters[i - 1].no} → ${COURSE.chapters[i].no}`);
  }
}
COURSE.chapters.forEach(c => {
  if (!COURSE.tracks[c.track]) err('COURSE', `第 ${c.no} 章的 track="${c.track}" 未在 tracks 中定义`);
  if (!c.tags || !c.tags.length) warn('COURSE', `第 ${c.no} 章没有 tags`);
  if (!c.desc) warn('COURSE', `第 ${c.no} 章没有 desc`);
});

/* 逐章校验 */
for (const meta of COURSE.chapters) {
  const no = meta.no;
  if (only.length && !only.includes(no)) continue;
  const label = `CH${String(no).padStart(2, '0')}`;

  // 外壳 HTML
  if (!fs.existsSync(path.join(ROOT, meta.file))) { err(label, `章节外壳不存在：${meta.file}`); continue; }
  const shell = fs.readFileSync(path.join(ROOT, meta.file), 'utf8');
  const dm = /data-chapter="(\d+)"/.exec(shell);
  if (!dm) err(label, `${meta.file} 缺少 data-chapter 属性`);
  else if (Number(dm[1]) !== no) err(label, `${meta.file} 的 data-chapter=${dm[1]}，与 COURSE 里的 ${no} 不一致`);

  // 数据文件
  const dataFile = `chapters/ch${String(no).padStart(2, '0')}.js`;
  if (!fs.existsSync(path.join(ROOT, dataFile))) {
    // 第 1 章是早期格式：整页 HTML 自包含，不引用 chapters/ 数据文件
    if (!/chapters\/ch/.test(shell)) {
      if (!QUIET) console.log(`CH${String(no).padStart(2, '0')}  自包含 HTML（早期格式），跳过数据文件校验`);
      const ids = new Set([...shell.matchAll(/\bid="sec-([^"]+)"/g)].map(m => m[1]));
      sectionIndex.set(meta.file, ids);
      validatedFiles.add(meta.file);
      continue;
    }
    err(label, `章节数据文件不存在：${dataFile}`);
    continue;
  }
  const src = fs.readFileSync(path.join(ROOT, dataFile), 'utf8');

  // 重复键
  findDuplicateKeys(src).forEach(d => {
    err(label, `${dataFile}:${d.line} 同一对象内重复键 "${d.key}"（首次出现在第 ${d.first} 行，后者会静默覆盖前者）`);
  });

  // 装载
  let ch;
  try {
    vm.runInContext(src, sb, { filename: dataFile });
    ch = sb.CHAPTER;
  } catch (e) {
    err(label, `${dataFile} 执行失败：${e.message}`);
    continue;
  }
  if (!ch) { err(label, `${dataFile} 没有设置 window.CHAPTER`); continue; }
  if (ch.no !== no) err(label, `CHAPTER.no=${ch.no}，与 COURSE 里的 ${no} 不一致`);
  delete sb.CHAPTER;

  // 头部
  if (!ch.title) err(label, 'CHAPTER.title 缺失');
  if (!ch.lede) warn(label, 'CHAPTER.lede 缺失');
  if (!ch.meta || !ch.meta.length) warn(label, 'CHAPTER.meta 缺失');

  const secs = ch.sections || [];
  if (!secs.length) { err(label, 'CHAPTER.sections 为空'); continue; }
  if (!ch.glossary || !ch.glossary.length) warn(label, 'CHAPTER.glossary 缺失');
  if (!ch.teacher) err(label, 'CHAPTER.teacher 缺失（严师是本项目的核心组件）');

  // 小节编号：格式 <章号>.x
  const hs = secs.filter(s => s.h).map(s => s.h);
  sectionIndex.set(meta.file, new Set(hs));
  validatedFiles.add(meta.file);
  const dupH = hs.filter((h, i) => hs.indexOf(h) !== i);
  if (dupH.length) err(label, `小节编号重复：${[...new Set(dupH)].join(', ')}`);
  hs.forEach(h => {
    if (!new RegExp(`^${no}\\.`).test(h)) err(label, `小节编号 "${h}" 不以 "${no}." 开头`);
  });
  const numeric = hs.filter(h => /^\d+\.\d+$/.test(h))
    .map(h => Number(h.split('.')[1])).sort((a, b) => a - b);
  for (let i = 1; i < numeric.length; i++) {
    if (numeric[i] === numeric[i - 1]) continue;
    if (numeric[i] !== numeric[i - 1] + 1) {
      warn(label, `小节编号跳号：${no}.${numeric[i - 1]} → ${no}.${numeric[i]}`);
    }
  }

  // 逐小节
  const counts = { stepper: 0, stage: 0, term: 0, decision: 0, quiz: 0, lab: 0, case: 0, intuition: 0, deck: 0 };
  secs.forEach((s, si) => {
    const tag = `[${s.h || '#' + (si + 1)}]`;
    if (!s.title && !s.html && !Object.keys(counts).some(k => s[k])) {
      warn(label, tag + ' 是空小节');
    }
    if (s.intuition) { counts.intuition++; if (!s.intuition.tag || !s.intuition.body) err(label, tag + ' intuition 缺 tag 或 body'); }
    if (s.stepper) { counts.stepper++; checkStepper(label, tag, s.stepper); }
    if (s.stage) { counts.stage++; checkStage(label, tag, s.stage); checkStageIds(label, tag, s.stage); execStage(label, tag, s.stage); }
    if (s.term) { counts.term++; checkTerm(label, tag, s.term); }
    if (s.decision) { counts.decision++; checkDecision(label, tag, s.decision); }
    if (s.quiz) { counts.quiz++; checkQuiz(label, tag, s.quiz); }
    if (s.lab) { counts.lab++; checkLab(label, tag, s.lab); execLab(label, tag, s.lab); }
    if (s.case) { counts.case++; checkCase(label, tag, s.case); }
    if (s.deck) counts.deck++;
  });

  if (ch.teacher) checkTeacher(label, ch.teacher);

  // 组件密度下限：只约束 CH19 之后新写的章节。
  // 现有 18 章是已验收的历史内容，密度本就参差，对它们报"低于下限"只是噪音。
  if (no >= 19) {
    const MIN = { stepper: 1, stage: 2, decision: 3, quiz: 3, lab: 1, case: 1, intuition: 2, term: 0 };
    Object.keys(MIN).forEach(k => {
      if (counts[k] < MIN[k]) err(label, `${k} 只有 ${counts[k]} 个，低于新章质量下限 ${MIN[k]}`);
    });
    if (secs.length < 10) err(label, `小节数只有 ${secs.length}，低于新章质量下限 10`);
    if ((ch.teacher ? ch.teacher.questions.length : 0) < 5) {
      err(label, '严师追问少于 5 题，低于新章质量下限 5');
    }
    if (!ch.glossary || ch.glossary.length < 8) err(label, '名词表少于 8 条，低于新章质量下限 8');
  }

  stats.push({ label, title: ch.title, secs: secs.length, ...counts, soc: (ch.teacher && ch.teacher.questions.length) || 0 });
  checkClasses(label, dataFile, CSS_CLASSES);
  smokeRender(dataFile, label);
}

/* 章节页文件名全集。
   注意：必须在「案例库深链」之前声明——那段代码的 !hs 分支会读它，
   而单章运行（node validate-chapters.mjs 30）时 sectionIndex 只装了被校验的章，
   深链到其它章就会走到那一步。原先声明在下方会触发 TDZ：
   "Cannot access 'allChapters' before initialization"，让单章自检直接崩掉。 */
const allChapters = new Set(COURSE.chapters.map(c => c.file));

/* --------------------------------------------- 案例库深链：锚点必须真的存在 */
/* 这也是全站级检查：单章运行时 sectionIndex 只装了被校验的那几章，
   其余章的深链会被误判成"没有可索引的小节"，所以只在全量运行时做。 */
if (!only.length && fs.existsSync(path.join(ROOT, 'cases.html'))) {
  const html = fs.readFileSync(path.join(ROOT, 'cases.html'), 'utf8');
  const links = [...html.matchAll(/href="([^"#]+)#(sec-[^"]+)"/g)];
  links.forEach(([, file, anchor]) => {
    const hs = sectionIndex.get(file);
    if (!hs) {
      if (allChapters.has(file) && validatedFiles.has(file)) {
        err('cases.html', `深链指向 ${file}，但该章没有可索引的小节`);
      }
      return;                                  // 非章节页、或本次没校验的章，锚点不归这里管
    }
    const h = anchor.replace(/^sec-/, '');
    if (!hs.has(h)) {
      err('cases.html', `深链 ${file}#${anchor} 指向的小节不存在（该章没有 h="${h}" 的小节）`);
    }
  });
  if (!QUIET) console.log(`cases.html：校验 ${links.length} 个案例深链锚点`);
}

/* ------------------------------------------------- 交叉链接：全站页面引用 */
/* allChapters 已在「案例库深链」之前声明（见上）。 */
for (const page of fs.readdirSync(ROOT).filter(f => f.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const refs = [...html.matchAll(/href="(ch\d+[^"#]*\.html)(#[^"]*)?"/g)];
  refs.forEach(m => {
    if (!fs.existsSync(path.join(ROOT, m[1]))) err(page, `引用了不存在的章节页 ${m[1]}`);
  });

  // 内联脚本语法检查：index / slides / toolbox / cases 都靠内联脚本驱动，
  // 一个语法错误会让整页的功能静默失效（HTML 照常显示，脚本不跑）。
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(x => x[1]);
  inline.forEach((src, i) => {
    if (!src.trim()) return;
    try { new vm.Script(src, { filename: `${page}#inline${i + 1}` }); }
    catch (e) { err(page, `第 ${i + 1} 段内联脚本有语法错误：${e.message}`); }
  });
}

/* --------------------------------------------- 演示稿：声明页数必须等于实际页数 */
if (fs.existsSync(path.join(ROOT, 'slides.html'))) {
  const html = fs.readFileSync(path.join(ROOT, 'slides.html'), 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(x => x[1]);
  const src = blocks.find(b => b.includes('const S ='));
  if (src) {
    let captured = null;
    const sb2 = {
      console,
      document: { getElementById: () => ({ innerHTML: '' }) },
      AKKC: { Deck: function (el, cfg) { captured = cfg; } }   // 必须是普通函数：要能被 new
    };
    sb2.window = sb2;
    vm.createContext(sb2);
    try {
      vm.runInContext(src, sb2, { filename: 'slides-inline.js' });
    } catch (e) {
      err('slides.html', `演示稿内联脚本执行失败：${e.message}`);
    }
    if (captured && Array.isArray(captured.slides)) {
      const real = captured.slides.length;
      // 文案里声明了几页？三种写法都要抓
      const declared = [...html.matchAll(/共 <b>(\d+)<\/b> 页|(\d+) 页幻灯片|演示稿 · (\d+) 页/g)]
        .map(x => Number(x[1] || x[2] || x[3]));
      declared.forEach(d => {
        if (d !== real) err('slides.html', `声明的页数是 ${d}，但实际有 ${real} 页幻灯片`);
      });
      if (!declared.length) warn('slides.html', '文案里没有声明页数，无法做一致性检查');

      // 「每章都要有演示页」是**全站级**检查：单章运行时不该报别的章没页，
      // 那只会给正在写单章的人制造噪音。
      if (!only.length) {
        const covered = new Set(
          captured.slides.map(s => /^CH\s*(\d+)/.exec(s.kicker || '')).filter(Boolean).map(m => Number(m[1]))
        );
        COURSE.chapters.forEach(c => {
          if (!covered.has(c.no)) warn('slides.html', `第 ${c.no} 章在演示稿里没有任何一页`);
        });
      }
    }
  }
}

/* ------------------------------------------------------------------ 输出 */
const errors = problems.filter(p => p.level === 'error');
const warns = problems.filter(p => p.level === 'warn');

if (!QUIET) {
  console.log('章节            小节  直觉 步进 动画 终端 决策 自测 实验 案例 严师');
  console.log('─'.repeat(74));
  stats.forEach(s => {
    console.log(
      s.label.padEnd(6) + ' ' +
      String(s.secs).padStart(4) + '  ' +
      String(s.intuition).padStart(4) + ' ' +
      String(s.stepper).padStart(4) + ' ' +
      String(s.stage).padStart(4) + ' ' +
      String(s.term).padStart(4) + ' ' +
      String(s.decision).padStart(4) + ' ' +
      String(s.quiz).padStart(4) + ' ' +
      String(s.lab).padStart(4) + ' ' +
      String(s.case).padStart(4) + ' ' +
      String(s.soc).padStart(4)
    );
  });
  console.log('─'.repeat(74));
  const sum = k => stats.reduce((a, s) => a + (s[k] || 0), 0);
  console.log(`合计：${stats.length} 章 / ${sum('secs')} 小节 / ${sum('intuition')} 直觉模型 / ` +
    `${sum('stepper')} 步进器 / ${sum('stage')} 动画 / ${sum('term')} 终端 / ${sum('decision')} 决策 / ` +
    `${sum('quiz')} 自测 / ${sum('lab')} 实验 / ${sum('case')} 案例 / ${sum('soc')} 严师追问\n`);
}

if (warns.length) {
  console.log(`⚠️  ${warns.length} 条提醒`);
  warns.forEach(w => console.log(`   [${w.chapter}] ${w.msg}`));
  console.log('');
}
if (errors.length) {
  console.log(`❌ ${errors.length} 条错误`);
  errors.forEach(e => console.log(`   [${e.chapter}] ${e.msg}`));
  process.exit(1);
}
console.log('✅ 结构校验全部通过');
