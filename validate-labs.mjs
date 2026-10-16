/* ==========================================================================
   validate-labs.mjs —— 实验判分自检：这个实验能不能"不做题就通过"？
   --------------------------------------------------------------------------
   为什么还要一个校验器：validate-chapters.mjs 只查结构（有没有 title/inputs/run、
   expected 会不会抛异常），它**看不出判分器的判据是否成立**。
   一个 expected 完全可以"结构合法、永远 ok:true"。

   判据只有一条：**不做实验的人，不该通过「检查我的答案」。**

   四组检查：

     ① 机械扫描（不看任何报告，直接对 expected() 喂"白嫖提交"）
        · 空提交      全部字段留空            → 必须不通过
        · 预填即过    原样提交题面预填值      → 必须不通过（预填值不得已经是答案）
        · 廉价猜测    单字段 / 双字段换成一   → 必须不通过
                      看就没做的值            （例外见 WIDE_OK）
     ② 有意功能（只统计，不算失败）
        · showAnswer 泄漏：答案能在「🔓 看正确答案」里找到。
          那是一个**有标注的**功能（按钮文字就是"看正确答案"，输出还写着"看懂不算会"），
          所以不计入失败。但必须**可见**：一旦数量异常上涨，说明有人把答案塞进了别的路径。
     ③ 逐条钉死的回归断言（每个被修过的洞一条）
        机械扫描只能发现"构造得出来"的白嫖手法。已经修过的洞要单独钉住：
        手法必须继续失败、而正确答案必须继续通过（后半句是防"修过头"）。
     ④ 覆盖自检
        逐章 lab 数与 validate-chapters.mjs 的「实验」列对账；expected 抛错的 lab 单独列出。
        抛错必须报出来 —— 那等于这一章没被验到。

   用法：
     node validate-labs.mjs              # 全部章节
     node validate-labs.mjs 2 19         # 只校验指定章节
     node validate-labs.mjs --quiet      # 只输出问题
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

/* 注意：不能用 new URL(import.meta.url).pathname —— 本仓库路径里有中文，
   它会把中文百分号编码成一个不存在的目录名。 */
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const QUIET = argv.includes('--quiet');
const only = argv.filter(a => /^\d+$/.test(a)).map(Number);

const errors = [];
const warns = [];
const err = (where, msg) => errors.push({ where, msg });
const warn = (where, msg) => warns.push({ where, msg });

/* ---------------------------------------------------------- 假 DOM 沙箱 */
const fakeEl = () => ({
  style: {}, dataset: {}, className: '', innerHTML: '', textContent: '', value: '',
  classList: { add() {}, remove() {}, contains: () => false, toggle() {}, toString: () => '' },
  appendChild() {}, insertBefore() {}, remove() {}, setAttribute() {}, getAttribute: () => null,
  addEventListener() {}, querySelector: () => fakeEl(), querySelectorAll: () => [], closest: () => null,
  focus() {}, onclick: null
});

function makeContext() {
  const sb = vm.createContext({
    window: {}, console,
    /* ★ 沙箱必须给 TextEncoder/TextDecoder。
       少了它们，用到这两个全局的 expected 会抛错；而在"能过就报"的判据里，
       抛错看起来跟"没通过"一模一样 —— 于是一个真的白嫖口子会被**静默漏掉**。
       这一条是被实测打出来的，不是想出来的。 */
    TextEncoder, TextDecoder,
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

/* 章节枚举的唯一来源：assets/app.js 里的 COURSE（不猜哪些章节存在） */
const COURSE = (() => {
  const sb = makeContext();
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/app.js'), 'utf8'), sb, { filename: 'assets/app.js' });
  return sb.COURSE;
})();
if (!COURSE || !Array.isArray(COURSE.chapters)) {
  console.error('❌ 无法从 assets/app.js 读出 COURSE.chapters');
  process.exit(2);
}

const sandboxCache = new Map();
function chapterFile(n) { return 'chapters/ch' + String(n).padStart(2, '0') + '.js'; }
function loadChapter(n) {
  if (sandboxCache.has(n)) return sandboxCache.get(n);
  /* 第 1 章是自包含格式、第 15 章是早期自包含 HTML —— 都没有 chapters/chNN.js。
     返回 null 而不是抛错：这是"覆盖不到的地方"，要写进报告，不是校验失败。 */
  if (!fs.existsSync(path.join(ROOT, chapterFile(n)))) return null;
  const sb = makeContext();
  for (const f of ['assets/app.js', 'assets/labs.js', 'assets/labx.js', 'assets/chapter.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f });
  }
  vm.runInContext(fs.readFileSync(path.join(ROOT, chapterFile(n)), 'utf8'), sb, { filename: chapterFile(n) });
  sandboxCache.set(n, sb);
  return sb;
}

/* ------------------------------------------------- 提交值构造函数 + 调用 */
const KEYS = lab => (lab.inputs || []).map((inp, i) => inp.key || i);
const PREFILL = lab => {
  const o = {};
  (lab.inputs || []).forEach((inp, i) => { o[inp.key || i] = inp.value == null ? '' : String(inp.value); });
  return o;
};
const BLANK = lab => { const o = {}; KEYS(lab).forEach(k => { o[k] = ''; }); return o; };
const isTextarea = (lab, k) => {
  const inp = (lab.inputs || []).find((x, i) => (x.key || i) === k);
  return !!inp && inp.type === 'textarea';
};

function ask(lab, vals) {
  /* 判据只看 expected() 返回的 ok。抛错既不算通过、也不算通过不了 —— 单独记进"覆盖缺口"。 */
  try {
    const r = lab.expected(vals);
    if (!r || typeof r !== 'object') return { ok: null, threw: 'expected 没有返回对象', detail: '' };
    return { ok: r.ok === true, threw: null, detail: String(r.detail || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() };
  } catch (e) {
    return { ok: null, threw: e.message, detail: '' };
  }
}

/* 一个没做实验的人会敲什么。刻意保持"最小公倍数"式的小集合：
   词汇越多，误报越多；这几条已经足够打穿"用平凡值糊过去"这一类。 */
const JUNK = ['', '0', '1', '9', 'x', '?', 'key', '不对', '随便', '不知道', '12345'];

/* 「接受面本来就宽」的例外。
   为什么不能干脆放宽判据：放宽之后，"新冒出来一个真的白嫖口子"也会被一起放过。
   所以每一条例外都必须写上理由，而且只豁免它自己那一种手法。 */
const WIDE_OK = [
  { no: 19, kind: '廉价猜测',
    why: 'witness 型任务：判据是"这一对能不能戳穿假等价式"，任何有进位的一对都应该通过 —— ' +
         '接受面宽是这个任务的性质，不是漏洞。泄漏类仍然照查（预填值不得已经是答案）。' }
];
const isWide = (no, kind) => WIDE_OK.find(w => w.no === no && kind.startsWith(w.kind));

/* ========================================================================== */
/* ① / ② 机械扫描                                                              */
/* ========================================================================== */
const findings = [];       // 每个"能不做题通过"的 lab
const leaks = [];          // showAnswer 泄漏（有意功能，只统计）
const gaps = [];           // expected 抛错的 lab（= 这一章没被验到）
const givenFields = [];    // 前提字段（题面已给值，判分器不必读）
const coverage = [];
let nLabs = 0, nWithExpected = 0, nLeakHits = 0;

for (const meta of COURSE.chapters) {
  const no = meta.no;
  if (only.length && !only.includes(no)) continue;
  let sb;
  try { sb = loadChapter(no); } catch (e) { err('CH' + no, '装载失败：' + e.message); continue; }
  if (!sb) { warn('CH' + no, '没有数据文件（早期自包含 HTML 章节）—— 本工具与 validate-chapters 都覆盖不到它'); continue; }
  const ch = sb.CHAPTER;
  if (!ch) { err('CH' + no, '数据文件没有挂载 CHAPTER'); continue; }
  const secs = ch.sections || [];
  let labsHere = 0;

  secs.forEach(sec => {
    const lab = sec.lab;
    if (!lab) return;
    labsHere++;
    nLabs++;
    if (!lab.expected) return;
    nWithExpected++;

    const keys = KEYS(lab);
    const pre = PREFILL(lab);
    const blank = BLANK(lab);
    const hits = [];
    const leakHits = [];
    let threw = null;
    const track = r => { if (r.threw && !threw) threw = r.threw; return r; };

    /* [空提交] —— 所有 lab 都必须挡住 */
    const b0 = track(ask(lab, blank));
    if (b0.ok === true) hits.push({ kind: '空提交', how: '（全部字段留空）' });

    /* [预填即过] —— 预填值不得已经是答案 */
    const asIs = track(ask(lab, pre));
    const preIsBlank = keys.every(k => !pre[k]);
    if (asIs.ok === true && !preIsBlank) hits.push({ kind: '预填即过', how: '（原样提交题面预填值）' });

    /* [廉价猜测] 单字段：其余=预填 与 其余=空 两套都试 */
    for (const k of keys) {
      for (const j of JUNK) {
        if (track(ask(lab, Object.assign({}, pre, { [k]: j }))).ok === true) {
          hits.push({ kind: '廉价猜测·单字段(其余=预填)', how: k + '="' + j + '"' });
        }
        if (track(ask(lab, Object.assign({}, blank, { [k]: j }))).ok === true) {
          hits.push({ kind: '廉价猜测·单字段(其余=空)', how: k + '="' + j + '"' });
        }
      }
    }

    /* [廉价猜测] 双字段跨积：字段多时是组合爆炸，6 个字段以内才做 */
    if (keys.length <= 6) {
      for (let a = 0; a < keys.length; a++) {
        for (let b = a + 1; b < keys.length; b++) {
          for (const ja of JUNK) {
            for (const jb of JUNK) {
              const v = Object.assign({}, pre, { [keys[a]]: ja, [keys[b]]: jb });
              if (track(ask(lab, v)).ok === true) {
                hits.push({ kind: '廉价猜测·双字段', how: keys[a] + '="' + ja + '" + ' + keys[b] + '="' + jb + '"' });
              }
            }
          }
        }
      }
    }

    /* [漏判字段] 题面问的每一问都必须被判分。
       做法：判分器的**函数源码**里必须出现每个输入框的 key 名。
       为什么可靠：读不到这个 key，就说明判分逻辑根本没碰它。
       为什么安全：key 名是标识符，不会"凭空"出现在源码里，所以只会漏报、不会误报。
       （数字 key 是编辑器给的索引，写法可以是 v[0] 也可以是 Object.values，不查。）

       但**不能一律算漏洞**：输入框分两种 ——
         · 前提字段：题面已经把值填在里面了（要分析的那份 smali / 那段密文），判分器不必读它
         · 作答字段：题面要你自己算出来填进去的，没判 = 这问题白问
       区分用"配置里有没有预填值"，因为这正是"题面给没给你"的同一件事。 */
    if (lab.expected) {
      const src = String(lab.expected);
      (lab.inputs || []).forEach((inp, i) => {
        const k = inp.key || i;
        if (/^\d+$/.test(String(k))) return;
        const esc2 = String(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp('(^|[^\\w$])' + esc2 + '([^\\w$]|$)').test(src)) return;
        const given = inp.value != null && String(inp.value).trim() !== '';
        if (given) givenFields.push({ no, sec: sec.h || sec.id || '(无编号)', key: String(k) });
        else hits.push({ kind: '漏判字段', how: k + '（题面要你自己产出它，判分器源码里却没有这个 key）' });
      });
    }

    /* [placeholder 泄漏] 题面里**可见的** placeholder 不得藏着能通过的值。
       它和 showAnswer 不是一回事：showAnswer 是学生主动点出来的，placeholder 是白送的。
       （只查 ph、不查 hint：hint 是长句子，从散文里抽词必然一堆误报。） */
    for (const k of keys) {
      const inp = (lab.inputs || []).find((x, i) => (x.key || i) === k);
      if (!inp || !inp.ph) continue;
      const cands = [String(inp.ph).trim(),
        ...(String(inp.ph).match(/0x[0-9a-fA-F]+|\d+(?:\.\d+)?/g) || [])];
      for (const c of [...new Set(cands)]) {
        if (!c) continue;
        if (track(ask(lab, Object.assign({}, pre, { [k]: c }))).ok === true) {
          hits.push({ kind: 'placeholder 泄漏', how: k + '.ph = "' + c + '"' });
        }
      }
    }

    /* [showAnswer 泄漏] ② 组：只统计。散文框跳过 —— 单个词条本来就过不了 */
    if (lab.showAnswer) {
      const toks = [...new Set(String(lab.showAnswer).match(/0x[0-9a-fA-F]+|\b\d{1,6}\b/g) || [])].slice(0, 40);
      for (const k of keys) {
        if (isTextarea(lab, k)) continue;
        for (const t of toks) {
          if (track(ask(lab, Object.assign({}, pre, { [k]: t }))).ok === true) {
            leakHits.push({ kind: 'showAnswer 泄漏', how: k + '="' + t + '"' });
          }
        }
      }
    }

    if (threw) gaps.push({ no, sec: sec.h || sec.id || '(无编号)', title: lab.title, keys, why: threw });

    const real = hits.filter(h => !isWide(no, h.kind));
    const wide = hits.filter(h => isWide(no, h.kind));
    if (real.length || wide.length || leakHits.length) {
      findings.push({
        no, sec: sec.h || sec.id || '(无编号)', title: lab.title, keys,
        real, wide: wide.map(h => Object.assign({ why: isWide(no, h.kind).why }, h)),
        leakHits
      });
    }
    nLeakHits += leakHits.length;
  });

  coverage.push({ no, labs: labsHere, withExpected: secs.filter(s => s.lab && s.lab.expected).length });
}

/* ========================================================================== */
/* ③ 逐条钉死的回归断言                                                        */
/*    每条 = 一次"提交" + 期望结果。want:false 的手法都来自真的抓到过的白嫖； */
/*    want:true 的那些是**防修过头** —— 改判据不能把正确答案一起判掉。            */
/* ========================================================================== */
const PINS = [
  /* ---- CH02 §2.12：预填值曾是答案；「② 留空」也曾被当成"注释掉这一行" ---- */
  { no: 2, lab: '实验：让 VIP 路径恒成立，并说明你为什么这么改', want: false, vals: { line: '5', newins: '' },
    why: '原来"② 空着"被当成"注释掉这一行"，于是只填对行号就算过' },
  { no: 2, lab: '实验：让 VIP 路径恒成立，并说明你为什么这么改', want: false, vals: { line: '5', newins: 'if-nez v0, :cond_notvip' },
    why: '把条件取反：只在非会员状态下成立，不满足"恒成立"' },
  { no: 2, lab: '实验：让 VIP 路径恒成立，并说明你为什么这么改', want: true, vals: { line: '4', newins: 'const/4 v0, 0x1' },
    why: '改事实（让 v0 恒为 1）—— 正确答案必须仍然通过' },
  { no: 2, lab: '实验：让 VIP 路径恒成立，并说明你为什么这么改', want: true, vals: { line: '5', newins: '#' },
    why: '删掉分支（显式写 # 注释掉）—— 另一个正确答案必须仍然通过' },

  /* ---- CH06 §6.6：解密往返判据在 m=0 时对任何 d 都成立 ---- */
  { no: 6, lab: '实验一：小参数 RSA 全流程（自己算 d → 真的解一次）', want: false, vals: { m: '0', d: '12345' },
    why: '判据曾是"解密往返"：m=0 → c=0 → 任何 d 都能把 0 解回 0' },
  { no: 6, lab: '实验一：小参数 RSA 全流程（自己算 d → 真的解一次）', want: false, vals: { m: '0', d: '1' },
    why: '同上，换最偷懒的 d=1 也一样' },
  { no: 6, lab: '实验一：小参数 RSA 全流程（自己算 d → 真的解一次）', want: false, vals: { d: '2752' },
    why: '2752 是 2753 的邻值：不是模逆元就该不通过' },
  { no: 6, lab: '实验一：小参数 RSA 全流程（自己算 d → 真的解一次）', want: true, vals: { d: '2753' },
    why: 'p=61/q=53/e=17 下 d 的模逆元就是 2753 —— 正确答案必须仍然通过' },

  /* ---- CH16 §16.4L：关键词表收了裸数字 '9' 和否定词 '不对' ---- */
  { no: 16, lab: '实验：解析 dex 文件头（112 字节）', want: false, vals: { ver: '9', why: '不对' },
    why: "修前这两个词就能通过：ver 只认裸数字 9，why 任选一个关键词" },
  { no: 16, lab: '实验：解析 dex 文件头（112 字节）', want: false, vals: { ver: '039', why: 'checksum' },
    why: '② 是复合判断：只说"哪个字段在管校验"、不说"它为什么对不上"，不算答对' },
  { no: 16, lab: '实验：解析 dex 文件头（112 字节）', want: false, vals: { hex: '', ver: '9.0', why: '内容变了但校验值没跟着更新' },
    why: '① 的判据要**对着那份文件头**算：前提被清空时不该判过（否则又能回到"背下 9.0 就能过"）' },
  { no: 16, lab: '实验：解析 dex 文件头（112 字节）', want: true, vals: { ver: '9.0', why: 'dump 后内容变了，但文件头里的 checksum/signature 还是旧值，没跟着更新' },
    why: '读懂 magic + 说清两个理由 —— 正确答案必须仍然通过' },

  /* ---- CH19 §19.5L：预填值本身就是 witness ---- */
  { no: 19, lab: '实验：指令替换的等价性验证', kind: 'asIs', want: false,
    why: '题面预填的那一对数不得已经是答案（原来 a=0xFFFFFFFF / b=0x00000001 就是 witness）' },
  { no: 19, lab: '实验：指令替换的等价性验证', want: true, vals: { a: '0x00000003', b: '0x00000003' },
    why: 'witness 型任务：任何有进位的一对都是合法答案（a&b=3≠0）' },

  /* ---- CH21 §21.5L：② 的结论一个字都不判；① 的 placeholder 就写着答案 ---- */
  { no: 21, lab: '实验：导入表依赖分类', want: false, vals: { jni: '7', verdict: '' },
    why: '只填① 就通过 = 第二问不存在（expected 原来只读 jni）' },
  { no: 21, lab: '实验：导入表依赖分类', want: false, vals: { jni: '7', verdict: 'jni 很难' },
    why: '② 要的是判断 + 依据：一句敷衍不算' },
  { no: 21, lab: '实验：导入表依赖分类', want: true,
    vals: { jni: '7', verdict: 'JNI 类占导入总数三分之一，说明这个 so 与 Java 层耦合很深，补环境成本高，优先考虑 Frida RPC' },
    why: '数对 + 说清占比与工具选择 —— 正确答案必须仍然通过' },

  /* ---- CH25 §25.4L：placeholder 就是答案；失败详情还把答案与逐段判定全列出来 ---- */
  { no: 25, lab: '实验：验证器会放行哪一段代码？', kind: 'noLeakDemo', vals: { reject: 'A' },
    notInDetail: ['正确答案是', 'B 和 C', 'A 有范围检查'],
    why: '修前：① 的 placeholder 写着"例如 B、C"，失败详情直接写"正确答案是 B 和 C"并把五段逐条判定' },

  /* ---- CH22 §22.3L2：不是判分器，是"输入非空即通过"的形式 ---- */
  { no: 22, lab: '实验二：亲手算出魔改 Base64 的编码结果', kind: 'noExpected',
    why: '观察型实验（输入任意明文看两张表的输出差异）：结论由 run 给出，不该挂一个无条件通过的"检查我的答案"' },

  /* ---- CH29 §29.8L：count 只判 ≥4；worst 根本不判 ---- */
  { no: 29, lab: '实验：环境快照的一致性审计', want: false, vals: { count: '4', worst: '传感器列表为空' },
    why: '题面已改成"全部找出来"，填题面给过的最小值不再通过' },
  { no: 29, lab: '实验：环境快照的一致性审计', want: false, vals: { count: '9', worst: '' },
    why: '② 必须也判（原来"检查我的答案"完全不看 worst）' },
  { no: 29, lab: '实验：环境快照的一致性审计', want: false, vals: { count: '9', worst: '传感器列表为空，因为要伪造合理噪声' },
    why: '② 问的是"最难靠改返回值补上"的那一处，答传感器不对（那是能靠注入补的）' },
  { no: 29, lab: '实验：环境快照的一致性审计', want: true,
    vals: { count: '9', worst: '出口 IP 落在云服务商数据中心段 —— 这不在我的系统里，改代码补不了' },
    why: '数量全对 + 指出唯一的外部资源问题 —— 正确答案必须仍然通过' },

  /* ---- CH17/25/27/31/32：题面问的每一问都必须判 ----
     这 5 个 lab 修前都有"作答字段一个字都不判"：填对了别的问题，这一问空着也能通过。
     每条两半：留空必须不过（证明判分器真的读了它）+ 正确答案必须过（证明没判过头）。 */
  { no: 17, lab: '实验：ARM32 / AArch64 地址换算', want: false,
    vals: { arm: '0x1A4D', a64: '0x1A4C', why: '' },
    why: '修前 ①② 填对、③ 留空就直接通过（expected 只读 v.arm / v.a64）' },
  { no: 17, lab: '实验：ARM32 / AArch64 地址换算', want: true,
    vals: { arm: '0x1A4D', a64: '0x1A4C', why: 'ARM32 用地址最低位标记 Thumb 指令集，AArch64 定长所以不用改' },
    why: '①② 对 + ③ 说清最低位与 AArch64 定长 —— 正确答案必须通过' },
  { no: 25, lab: '实验：验证器会放行哪一段代码？', want: false,
    vals: { reject: 'B、C', reason: '' },
    why: '修前 ① 填对、② 留空就直接通过（expected 只读 v.reject）' },
  { no: 25, lab: '实验：验证器会放行哪一段代码？', want: true,
    vals: { reject: 'B、C', reason: '验证器不做运行时测试，只在加载时静态证明程序不会出事：不越界、一定会终止' },
    why: '① 对 + ② 说清"加载时静态证明"与安全性质 —— 正确答案必须通过' },
  { no: 27, lab: '实验：解码内联 SVC', want: false,
    vals: { arch: 'a64', name: 'openat', reason: '' },
    why: '修前 ①② 填对、③ 留空就直接通过（expected 只读 v.arch / v.name）' },
  { no: 27, lab: '实验：解码内联 SVC', want: true,
    vals: { arch: 'a64', name: 'openat',
      reason: '它只读打开 /proc/self/maps 检查自己的内存映射，是反调试；而且是内联 SVC，绕过 libc，hook open 看不到' },
    why: '①② 对 + ③ 说清读哪个文件、为什么、绕过了什么 —— 正确答案必须通过' },
  { no: 31, lab: '实验：给需求配 namespace', want: false,
    vals: { flags: 'PID MNT UTS NET', forkbomb: '' },
    why: '修前 ① 选对、② 留空就直接通过（expected 只读 v.flags）' },
  { no: 31, lab: '实验：给需求配 namespace', want: true,
    vals: { flags: 'PID MNT UTS NET', forkbomb: '靠 cgroup 的 pids 控制器（pids.max），不是 namespace' },
    why: '① 不多不少 + ② 答出 cgroup —— 正确答案必须通过' },
  { no: 32, lab: '实验：Android 启动链路排序 + 容器化差异', want: false,
    vals: { order: 'D F G B A E C', skip: 'D F', why: '' },
    why: '修前 ①② 填对、③ 留空就直接通过（expected 只读 v.order / v.skip）' },
  { no: 32, lab: '实验：Android 启动链路排序 + 容器化差异', want: true,
    vals: { order: 'D F G B A E C', skip: 'D F',
      why: '容器里 PID 1 由容器运行时承担，Android 自己的 init 体系被挂进 PID 命名空间' },
    why: '①② 对 + ③ 说清谁当 PID 1 —— 正确答案必须通过' }
];

let pinned = 0;
function pickLab(no, wanted) {
  const sb = sandboxCache.get(no);
  if (!sb || !sb.CHAPTER) return { err: 'CH' + no + ' 没装进沙箱' };
  const withLab = (sb.CHAPTER.sections || []).filter(x => x.lab);
  if (!wanted) return withLab.length ? { lab: withLab[0].lab, sec: withLab[0] } : { err: 'CH' + no + ' 没有任何 lab' };
  /* 用 **lab 的标题**定位，不用小节号：小节号有 '22.3L2' 这种子块（没有 h 字段），
     而标题在一章里唯一、且改标题时错误信息会直接把现存的标题列出来。 */
  const s = withLab.find(x => x.lab.title === wanted);
  if (!s) {
    return { err: 'CH' + no + ' 里找不到标题为「' + wanted + '」的 lab；现存的 lab 标题：' +
      withLab.map(x => '「' + x.lab.title + '」').join('、') };
  }
  return { lab: s.lab, sec: s };
}

for (const p of PINS) {
  if (only.length && !only.includes(p.no)) continue;
  const pick = pickLab(p.no, p.lab);
  if (pick.err) { err('CH' + String(p.no).padStart(2, '0') + ' [钉死断言]', pick.err + '（断言表写错了？）'); continue; }
  const where = 'CH' + String(p.no).padStart(2, '0') + ' §' + (pick.sec.h || pick.sec.id || '(无编号)') + ' [钉死断言]';
  const lab = pick.lab;

  if (p.kind === 'noExpected') {
    if (typeof lab.expected === 'function') err(where, '期望"故意没有判分器"，但它有 expected —— ' + p.why);
    else pinned++;
    continue;
  }
  /* 「失败时不许把答案说出去」：这份提交必须被判错，而且失败详情里不得出现答案痕迹。
     这是"判分器泄漏"那一类唯一的机械守卫 —— 它靠人读代码是查不干净的。 */
  if (p.kind === 'noLeakDemo') {
    const vals = Object.assign(PREFILL(lab), p.vals || {});
    const r = ask(lab, vals);
    if (r.threw) { err(where, 'expected 抛错：' + r.threw + ' —— ' + p.why); continue; }
    if (r.ok === true) { err(where, '这份提交本该被判错，却通过了（钉不住泄漏）—— ' + p.why); continue; }
    const bad = (p.notInDetail || []).filter(s => r.detail.replace(/\s+/g, '').includes(s.replace(/\s+/g, '')));
    if (bad.length) {
      err(where, '失败详情里出现了答案痕迹：' + bad.map(s => '「' + s + '」').join('、') + ' —— ' + p.why);
    } else {
      pinned++;
    }
    continue;
  }
  if (typeof lab.expected !== 'function') { err(where, '这个 lab 没有 expected，钉不住：' + p.why); continue; }

  /* 默认以"预填值"为底、再盖上断言里的字段；断言里显式写 hex:'' 之类的值就是"清空这一项"。 */
  const base = p.base === 'blank' ? BLANK(lab) : PREFILL(lab);
  const vals = Object.assign(base, p.vals || {});
  const r = ask(lab, vals);
  if (r.threw) { err(where, 'expected 抛错：' + r.threw + ' —— ' + p.why); continue; }
  const shown = p.kind === 'asIs' ? '（原样提交题面预填值）'
    : JSON.stringify(p.vals || {}) + (p.base === 'blank' ? '（其余=空）' : '（其余=预填）');
  if (r.ok !== p.want) {
    err(where, '提交 ' + shown + ' 期望' + (p.want ? '通过' : '不通过') + '，实际' + (r.ok ? '通过' : '不通过') +
      (r.detail ? '（判分器说：' + r.detail.slice(0, 60) + '…）' : '') + ' —— ' + p.why);
  } else {
    pinned++;
  }
}

/* ========================================================================== */
/* 报告                                                                        */
/* ========================================================================== */
const pad = s => String(s).padStart(2, '0');
const realFindings = findings.filter(f => f.real.length);

if (!QUIET) {
  console.log('=== 实验判分自检（不做题能不能通过）===');
  console.log(`扫描 ${coverage.length} 章 / ${nLabs} 个实验，其中 ${nWithExpected} 个带判分器（expected）；` +
    `钉死回归断言 ${pinned} 条。\n`);
}

if (realFindings.length) {
  for (const f of realFindings) {
    console.log(`CH${pad(f.no)} §${f.sec}  ${f.title}`);
    console.log('        字段: ' + f.keys.join(', '));
    const byKind = {};
    f.real.forEach(h => { (byKind[h.kind] = byKind[h.kind] || []).push(h); });
    for (const k of Object.keys(byKind)) {
      console.log('   ✗ ' + k + ' × ' + byKind[k].length);
      byKind[k].slice(0, 4).forEach(h => console.log('       ' + h.how));
      if (byKind[k].length > 4) console.log('       …（还有 ' + (byKind[k].length - 4) + ' 种）');
    }
    console.log('');
  }
}

/* 例外：接受面本来就宽的任务（只提示，不算失败） */
const wideAll = findings.filter(f => f.wide.length);
if (wideAll.length && !QUIET) {
  console.log('--- 已登记的"接受面本来就宽"（不算失败） ---');
  for (const f of wideAll) {
    console.log(`CH${pad(f.no)} §${f.sec}  ${f.wide[0].kind} × ${f.wide.length}：${f.wide[0].why}`);
  }
  console.log('');
}

/* 有意功能：答案能在「看正确答案」里找到 */
const leakAll = findings.filter(f => f.leakHits.length);
if (!QUIET) {
  console.log('--- 有意功能：「看正确答案」里能找到答案（不计入失败）---');
  console.log(leakAll.length
    ? '  ' + leakAll.map(f => 'CH' + pad(f.no) + '（' + f.leakHits.length + ' 处）').join('  ') +
      `  —— 共 ${nLeakHits} 处。按钮有标注、输出写着"看懂不算会"，这是自测功能。`
    : '  （无）');
  console.log('');
}

/* 前提字段：题面已经把值放在输入框里了（要分析的那份字节 / 那段日志），判分器不必读它 */
if (!QUIET) {
  console.log('--- 前提字段（题面已给定值，判分器不读它不算白问）---');
  if (!givenFields.length) console.log('  （无）');
  else {
    const byCh = {};
    givenFields.forEach(g => { (byCh['CH' + pad(g.no)] = byCh['CH' + pad(g.no)] || []).push(g); });
    Object.keys(byCh).forEach(ch => console.log('  ' + ch + '：' + byCh[ch].map(g => '§' + g.sec + ' ' + g.key).join('、')));
  }
  console.log('');
}

if (gaps.length) {
  console.log('--- 覆盖缺口：expected 一跑就抛错（= 这一类白嫖手法没验到）---');
  gaps.forEach(g => console.log(`  CH${pad(g.no)} §${g.sec}  ${g.title}\n        字段: ${g.keys.join(', ')}\n        抛错: ${g.why}`));
  console.log('');
}

if (!QUIET) {
  console.log('--- 逐章覆盖（章节 : 有判分器 / lab 数）---');
  console.log('  ' + coverage.filter(c => c.labs).map(c => 'CH' + pad(c.no) + ':' + c.withExpected + '/' + c.labs).join('  '));
  console.log(`  合计 lab ${nLabs}，有判分器 ${nWithExpected}`);
  console.log('');
}

if (warns.length) {
  console.log(`⚠️  ${warns.length} 条提醒`);
  warns.forEach(w => console.log(`   [${w.where}] ${w.msg}`));
  console.log('');
}
if (errors.length) {
  console.log(`❌ ${errors.length} 条判分问题`);
  errors.forEach(e => console.log(`   [${e.where}] ${e.msg}`));
}
if (realFindings.length) {
  /* 机械扫描发现的白嫖口子同样是失败，而且更该拦：钉死断言只覆盖"已经知道的那几个洞"，
     扫描覆盖全部 lab —— 新写的 lab 一进来就会被它过一遍。 */
  console.log(`❌ ${realFindings.length} 个实验可以不做题通过（见上文）`);
}
if (errors.length || realFindings.length) process.exit(1);
console.log('✅ 判分自检全部通过');
