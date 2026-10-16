/* ==========================================================================
   validate-ui.mjs —— 界面这一侧的对账（Node 里跑，假 DOM）
   --------------------------------------------------------------------------
   为什么需要它：三轴的**规则**只有一份（assets/sim/simscore.js），但"谁记一步"
   在界面上是**另一份实现** —— 玩家点「转储」的时候，是 assets/practice.js 调的
   led.toolStep()。validate-missions.mjs 只重放路线，看不见界面。

   于是可能出现这种事，而所有 Node 侧的检查全是绿的：

       界面上写着"作者 1"，玩家照着作者路线点一遍却得到 2

   这里补上界面这一侧：用假 DOM 把 assets/practice.js **真的加载起来**，
   拿界面自己的手势走两条路线，把**屏幕上显示的三轴**与 SIMSCORE.replay 对账。

   ★ 判据是"屏幕上的数"，不是"账本里的数" —— 玩家看到的是屏幕上那个。
     instinct 上你会去读 wb.led.steps；但那样就漏掉了 paintScores 这一层
     （它完全可能把 1 画成 2）。所以数字从 #pr-scores 的 HTML 里抠。

   两条路线：
     ① 作者路线 —— 验收标准的字面意思："照着它走能得到它"
     ② 合成路线 —— 覆盖 ROUTE_OPS 里的每一个 op，包括作者路线没用到的那些。
        没有它，hook.read / hook.patch / shell 这些手势永远不会被走到。

   node validate-ui.mjs [--quiet]
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const QUIET = process.argv.includes('--quiet');

const problems = [];
const err = (where, msg) => problems.push({ level: 'error', where, msg });
const warn = (where, msg) => problems.push({ level: 'warn', where, msg });

/* ======================================================================
   假 DOM
   ----------------------------------------------------------------------
   只需要 practice.js 用到的那几样。关键点：**同一个选择器必须每次返回同一个元素**
   —— 听上去像细节，其实不是：paintScores 写 #pr-scores、paintRisk 读 .pr-risk，
   如果每次给你一个新对象，"界面上显示的数"就成了幻觉。
   ====================================================================== */
function makeDom(objectiveFields) {
  function mkEl(tag) {
    const e = {
      _tag: tag, _ev: {}, _subs: new Map(),
      className: '', innerHTML: '', textContent: '', value: '',
      dataset: {}, style: {}, children: [],
      scrollTop: 0, scrollHeight: 0,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild(c) { this.children.push(c); return c; },
      insertBefore(c) { this.children.push(c); return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
      remove() {}, setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
      addEventListener(t, f) { (this._ev[t] = this._ev[t] || []).push(f); },
      removeEventListener() {},
      dispatchEvent() { return true; },
      focus() {}, blur() {}, click() {}, closest: () => null,
      /* 同一个选择器 → 同一个元素（记忆化） */
      querySelector(sel) {
        if (!this._subs.has(sel)) this._subs.set(sel, mkEl(sel));
        return this._subs.get(sel);
      },
      querySelectorAll(sel) {
        const key = '#' + sel;
        if (!this._subs.has(key)) {
          /* [data-obj] 是唯一一个"按关卡字段列表展开"的选择器 */
          const list = sel === '[data-obj]'
            ? objectiveFields.map(f => { const x = mkEl('input'); x.dataset.obj = f; return x; })
            : [];
          list.forEach((x, i) => { x._idx = i; });
          this._subs.set(key, list);
        }
        return this._subs.get(key);
      }
    };
    return e;
  }

  const doc = mkEl('#document');
  doc.readyState = 'complete';
  doc.createElement = mkEl;
  doc.getElementById = () => null;        /* mount() 直接退回，我们不跑路由 */
  doc.body = mkEl('body');
  doc.body.appendChild = () => {};
  return { document: doc, mkEl };
}

/* ======================================================================
   沙箱：按 practice.html 的顺序加载（少一个就会在真实浏览器里也少一个）
   ====================================================================== */
const SCRIPTS = [
  'assets/labs.js',
  'assets/labx.js',
  'assets/sim/simelf.js',
  'assets/sim/simnative.js',
  'assets/sim/simdevice.js',
  'assets/sim/forge.js',
  'assets/sim/missions.js',
  'assets/sim/simscore.js'
];

function load(fields) {
  const { document, mkEl } = makeDom(fields);
  let sb;
  sb = vm.createContext({
    console: QUIET ? { log() {}, warn() {}, error() {} } : console,
    TextEncoder, TextDecoder,
    document,
    CustomEvent: function (t, o) { this.type = t; this.detail = (o || {}).detail; },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    addEventListener() {}, scrollTo() {}, innerHeight: 800, scrollY: 0,
    location: { hash: '' },
    localStorage: { getItem: () => null, setItem() {} },
    /* 进度存储：本检查不关心跨会话历史，但 onSolved 会写它 */
    AKKC_STORE: { get: () => null, set: () => {} }
  });
  sb.window = sb; sb.globalThis = sb; sb.self = sb;

  for (const f of SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f });
  }
  /* practice.js 末尾会立刻 mount()，根节点不存在就退化成 no-op —— 正是我们要的 */
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/practice.js'), 'utf8'), sb,
    { filename: 'assets/practice.js' });
  return sb;
}

/* ======================================================================
   op → 界面手势
   ----------------------------------------------------------------------
   这张表是**测试的期望值**，故意写死：界面上少一个按钮、按钮不再记一步、
   或者命令不再被识别，这里就会红。它不是"第二份规则" ——
   规则在引擎的 ROUTE_OPS 里，这里只是断言界面真的做到了它。

   ctrl  该手势在界面上的控件。null = 这个 op 在界面上**没有**手势（就该没有）。
   drive 用界面自己的入口做这件事（不是复制一份逻辑，是调用它的方法）。
   ====================================================================== */
const OP_GESTURE = {
  'shell': {
    ctrl: 'data-cmd="term"',
    drive: (wb, s) => wb.runShell(s.cmd)
  },
  'image.hexdump': {
    ctrl: 'data-pr="hex"',
    drive: (wb, s) => {
      wb.root.querySelector('[data-cmd="hxoff"]').value = '0x' + (s.addr >>> 0).toString(16);
      wb.root.querySelector('[data-cmd="hxlen"]').value = String(s.len);
      wb.showHex();
    }
  },
  'image.strings': { ctrl: 'data-pr="strings"', drive: wb => wb.showStrings() },
  'image.elf': { ctrl: 'data-pr="elf"', drive: wb => wb.showElf() },
  'hook.read': {
    ctrl: 'data-cmd="hook"',
    drive: (wb, s) => wb.runHook('read(0x' + (s.addr >>> 0).toString(16) + ', ' + s.len + ')')
  },
  'hook.list': { ctrl: 'data-cmd="hook"', drive: wb => wb.runHook('list()') },
  'hook.call': { ctrl: 'data-cmd="hook"', drive: (wb, s) => wb.runHook('call("' + s.name + '")') },
  'hook.patch': {
    ctrl: 'data-cmd="hook"',
    /* 界面收的是文本，引擎收的是数字/hex —— 各按自己的形态传，这样命令解析
       （去掉 0x、去掉引号的逻辑）也在被检查的范围内。 */
    drive: (wb, s) => wb.runHook('patch(0x' + (s.addr >>> 0).toString(16) + ', "' + s.hex + '")')
  },
  'note': { ctrl: null, drive: () => {} },
  'submit': {
    ctrl: 'data-pr="check"',
    /* 填表用的是**关卡自己的 format**，不是在这里拼十六进制 ——
       在这里拼的话，format 改成别的形状时这里还在按旧形状填，
       这个测试就会替玩家把谎圆上（它填得进、玩家填不进，而它却报绿）。 */
    drive: (wb, s, mission) => {
      const form = s.answer || mission.objective.format(mission.reference.solve(wb.art).words);
      const inputs = wb.root.querySelectorAll('[data-obj]');
      (mission.objective.fields || []).forEach((f, i) => { inputs[i].value = String(form[f]); });
      wb.check();
    }
  }
};

/* ======================================================================
   一条路线的三个数真的算一遍（引擎侧）
   ====================================================================== */
function axesOf(mission, route) {
  const sb = load(mission.objective.fields || []);
  const synthetic = Object.assign({}, mission, {
    reference: Object.assign({}, mission.reference, { route })
  });
  return sb.SIMSCORE.replay(synthetic);
}

/* ======================================================================
   把一条路线在**界面上**走一遍，返回过程中观察到的东西
   ====================================================================== */
const CONSOLES = { 'shell': '#pr-term', 'image': '#pr-img', 'hook': '#pr-hook' };

function walkUi(mission, route) {
  const sb = load(mission.objective.fields || []);
  const root = sb.document.createElement('div');
  const wb = new sb.AKKC_PRACTICE.Workbench(root, mission);
  const html = root.innerHTML;

  const obs = { html, perStep: [], ok: true, detail: '' };

  route.forEach((s, i) => {
    const g = OP_GESTURE[s.op];
    if (!g) { obs.ok = false; obs.detail = '第 ' + (i + 1) + ' 步的 op「' + s.op + '」在界面上没有对应手势'; return; }

    /* 这一步会往哪个控制台写东西 —— 用来抓"界面把它当成未知命令" */
    const tool = sb.SIMSCORE.ROUTE_OPS[s.op] ? sb.SIMSCORE.ROUTE_OPS[s.op].tool : null;
    const box = tool && CONSOLES[tool] ? root.querySelector(CONSOLES[tool]) : null;
    const before = box ? box.children.length : 0;

    const stepsBefore = wb.led.steps;
    let threw = '';
    try { g.drive(wb, s, mission); } catch (e) { threw = e.message; }
    const stepsAfter = wb.led.steps;

    const newLines = box ? box.children.slice(before).map(c => c.innerHTML).join('\n') : '';
    obs.perStep.push({
      i: i + 1, op: s.op,
      steps: stepsAfter - stepsBefore,
      out: newLines,
      err: threw,
      isErr: /pr-err/.test(newLines) || threw !== ''
    });
  });

  obs.scores = wb.scores();                       /* 账本里的数 */
  const box = root.querySelector('#pr-scores');
  const shown = [];
  const re = /pr-score-v[^>]*>(\d+)/g;
  let m;
  while ((m = re.exec(box.innerHTML)) !== null) shown.push(Number(m[1]));
  obs.shown = shown;                              /* 屏幕上的数 —— 这才是判据 */
  obs.verdict = root.querySelector('#pr-sub-out').innerHTML;
  return obs;
}

/* ======================================================================
   走起
   ====================================================================== */
const boot = load([]);
const MISSIONS = boot.SIM_MISSIONS_LIST || [];
const ROUTE_OPS = boot.SIMSCORE.ROUTE_OPS;

if (!MISSIONS.length) err('missions', '一个关卡都没有 —— 界面侧无从对账');

/* ----------------------------------------------------------------------
   ⑨-a 手势表自己先要完整：OP_GESTURE 必须覆盖 ROUTE_OPS 的每一个 op。
   少了谁就意味着"谁在界面上做这件事"没人回答 —— 那不是通过，是漏测。
   ---------------------------------------------------------------------- */
for (const op of Object.keys(ROUTE_OPS).sort()) {
  if (!(op in OP_GESTURE)) {
    err('OP_GESTURE', '⑨ 引擎的 ROUTE_OPS 里有「' + op + '」，但界面手势表没有它 —— ' +
      '没有人回答"玩家在界面上怎么发出这个操作"');
  }
}
for (const op of Object.keys(OP_GESTURE).sort()) {
  if (!(op in ROUTE_OPS)) {
    err('OP_GESTURE', '⑨ 界面手势表里的「' + op + '」引擎并不认识 —— 测了一个不存在的东西');
  }
}

for (const mission of MISSIONS) {
  const authorRoute = (mission.reference && mission.reference.route) || [];
  const tools = mission.tools || [];

  /* ------------------------------------------------------------------
     ⑨-b 界面必须真的提供这个 op 的手势（控件得在 render 出来的 HTML 里）
     ------------------------------------------------------------------ */
  const probeObs = walkUi(mission, authorRoute);
  for (const op of Object.keys(ROUTE_OPS).sort()) {
    const need = ROUTE_OPS[op].tool;
    if (need === null || tools.indexOf(need) < 0) continue;   /* 本关不该有这个面板 */
    const g = OP_GESTURE[op];
    if (g && g.ctrl && probeObs.html.indexOf(g.ctrl) < 0) {
      err(mission.id, '⑨ 本关开了「' + need + '」面板，但 HTML 里找不到 ' + op + ' 的手势 ' +
        g.ctrl + ' —— 作者路线里的这一步玩家按不出来');
    }
  }

  /* ------------------------------------------------------------------
     ⑨-c 作者路线：界面上走一遍，屏幕上的三个数必须等于引擎重放的三个数
     ------------------------------------------------------------------ */
  const want = axesOf(mission, authorRoute);
  const got = walkUi(mission, authorRoute);

  if (got.shown.length !== 3) {
    err(mission.id, '⑨ 屏幕上没画出三个轴（抠到 ' + got.shown.length + ' 个数）—— 界面对账无从谈起');
  } else {
    const three = [['注入面', want.inject, got.shown[0]], ['风控值', want.risk, got.shown[1]], ['步数', want.steps, got.shown[2]]];
    const bad = three.filter(t => t[1] !== t[2]);
    if (bad.length) {
      err(mission.id, '⑨ 作者路线在界面上走一遍，屏幕上的数 ≠ 引擎重放的数 —— ' +
        bad.map(t => t[0] + ' 引擎 ' + t[1] + ' / 界面 ' + t[2]).join('；') +
        '。玩家照着作者路线做，永远拿不到作者那个值');
    } else if (!QUIET) {
      console.log('  ✓ ' + mission.id + ' 作者路线在界面上走一遍：屏幕 ' +
        got.shown.join(' / ') + ' == 引擎 ' + want.inject + ' / ' + want.risk + ' / ' + want.steps +
        '（' + authorRoute.length + ' 步）');
    }
  }

  /* 账本与屏幕也必须一致 —— 否则上面那条只是"两个数碰巧相等" */
  if (got.scores.inject !== got.shown[0] || got.scores.risk !== got.shown[1] || got.scores.steps !== got.shown[2]) {
    err(mission.id, '⑨ 界面账本与它画出来的数不一致：账本 ' +
      [got.scores.inject, got.scores.risk, got.scores.steps].join(' / ') +
      '，屏幕 ' + got.shown.join(' / '));
  }

  /* 作者路线要是通的（不通说明走界面的方式不对，不是玩家的问题） */
  if (!/pr-msg pass/.test(got.verdict)) {
    err(mission.id, '⑨ 作者路线在界面上没走通 —— 提交结果：' +
      JSON.stringify(got.verdict.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90)));
  }

  /* ------------------------------------------------------------------
     ⑨-d 合成路线：把 ROUTE_OPS 的每个 op 都在界面上走一遍
     ------------------------------------------------------------------ */
  const synth = Object.keys(ROUTE_OPS).sort().map(op => {
    const g = OP_GESTURE[op];
    const spec = ROUTE_OPS[op];
    const args = typeof spec.probe === 'function' ? spec.probe(mission) : {};
    return Object.assign({ op }, args, { label: g && g.ctrl ? '合成路线' : '合成路线（界面上无手势）' });
  });
  /* 提交放最后：它靠作者答案，中途改写映像不该影响它 */
  synth.sort((a, b) => (a.op === 'submit' ? 1 : 0) - (b.op === 'submit' ? 1 : 0));

  const wantSyn = axesOf(mission, synth);
  const gotSyn = walkUi(mission, synth);

  if (gotSyn.shown.length === 3) {
    const three = [['注入面', wantSyn.inject, gotSyn.shown[0]], ['风控值', wantSyn.risk, gotSyn.shown[1]], ['步数', wantSyn.steps, gotSyn.shown[2]]];
    const bad = three.filter(t => t[1] !== t[2]);
    if (bad.length) {
      err(mission.id, '⑨ 合成路线（覆盖全部 ' + synth.length + ' 个 op）在界面上走一遍，屏幕上的数 ≠ 引擎重放的数 —— ' +
        bad.map(t => t[0] + ' 引擎 ' + t[1] + ' / 界面 ' + t[2]).join('；'));
    }
  } else {
    err(mission.id, '⑨ 合成路线没画出三个轴');
  }

  /* 逐步对账：每个 op 在界面上记几步，必须与该 op 是否产生工具操作一致。
     只看总数会漏掉"一个多记、一个少记、正好抵消"。 */
  synth.forEach((s, i) => {
    const o = gotSyn.perStep[i];
    if (!o) return;
    const spec = ROUTE_OPS[s.op];
    const expected = spec.tool === null ? 0 : 1;
    if (o.steps !== expected) {
      err(mission.id, '⑨ op「' + s.op + '」在界面上记了 ' + o.steps + ' 步，应当是 ' + expected +
        ' 步（tool=' + JSON.stringify(spec.tool) + '）');
    }
    if (o.err) {
      err(mission.id, '⑨ op「' + s.op + '」在界面上抛错：' + o.err);
    } else if (o.isErr) {
      err(mission.id, '⑨ op「' + s.op + '」在界面上报错了 —— 界面不认识它：' +
        JSON.stringify(o.out.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90)));
    } else if (spec.tool !== null && !o.out.trim()) {
      err(mission.id, '⑨ op「' + s.op + '」在界面上一步都没写输出 —— 它可能什么都没做');
    }
  });

  if (!QUIET && gotSyn.shown.length === 3) {
    console.log('  ✓ ' + mission.id + ' 合成路线（' + synth.length + ' 个 op 全覆盖）在界面上走一遍：屏幕 ' +
      gotSyn.shown.join(' / ') + ' == 引擎 ' + wantSyn.inject + ' / ' + wantSyn.risk + ' / ' + wantSyn.steps);
  }

  /* ------------------------------------------------------------------
     ⑨-e 反例：提交一个**错答案** —— 界面与引擎必须同样处理这次试错
     ------------------------------------------------------------------
     专门测这个，是因为这两条路在这一点上确实曾经不一致：
     界面的「提交并检查」会记一次风控，而引擎的 submit 当初不记。
     作者路线永远通过，所以那个分歧平时看不见 —— 但它意味着
     "屏幕上显示的三个数"和引擎算的**不是同一件事**。

     判据刻意有两层：先是"两边一样"，再是"两边都等于规则里的那个数"。
     只比两边的话，两边一起错是查不出来的。
     ------------------------------------------------------------------ */
  const obj = mission.objective;
  if (typeof obj.format === 'function') {
    const art = boot.FORGE.build(mission.spec, mission.seed);
    const wrong = mission.reference.solve(art).words.slice();
    wrong[0] = (wrong[0] ^ 1) >>> 0;                       /* 只错 1 位 */
    const wrongRoute = [{ op: 'submit', answer: obj.format(wrong), label: '交一个错答案' }];

    const wantW = axesOf(mission, wrongRoute);
    const gotW = walkUi(mission, wrongRoute);
    const RULE = boot.SIMSCORE.RULES.RISK_PER_WRONG_TRY;

    if (gotW.shown.length !== 3) {
      err(mission.id, '⑨ 反例（提交错答案）没画出三个轴');
    } else if (gotW.shown[0] !== wantW.inject || gotW.shown[1] !== wantW.risk || gotW.shown[2] !== wantW.steps) {
      err(mission.id, '⑨ 反例（提交错答案）屏幕上的数 ≠ 引擎重放的数 —— 界面 ' + gotW.shown.join(' / ') +
        ' vs 引擎 ' + wantW.inject + ' / ' + wantW.risk + ' / ' + wantW.steps +
        '。界面与引擎对"一次试错"的记账不一致');
    } else if (gotW.shown[1] !== RULE) {
      err(mission.id, '⑨ 提交错一次，两边都记了 ' + gotW.shown[1] + ' 风控，而不是规则里的 ' + RULE +
        ' —— 两边一起错就查不出来了，所以这一条要单独钉住');
    } else if (/pr-msg pass/.test(gotW.verdict)) {
      err(mission.id, '⑨ 提交了错答案，界面却说通过了');
    } else if (!QUIET) {
      console.log('  ✓ ' + mission.id + ' 反例（错 1 位的答案）：界面与引擎都记 ' + gotW.shown[1] +
        ' 风控、都不通过、都不计步');
    }
  }
}

/* ======================================================================
   报告
   ====================================================================== */
const errors = problems.filter(p => p.level === 'error');
const warns = problems.filter(p => p.level === 'warn');
for (const p of problems) {
  console.log((p.level === 'error' ? '✗ ' : '⚠ ') + '[' + p.where + '] ' + p.msg);
}
if (!QUIET && !problems.length) console.log('  ✓ 界面侧对账：手势表完整、屏上三轴与引擎重放逐项一致');
console.log('\n对账 ' + MISSIONS.length + ' 个关卡，' + (errors.length + warns.length) + ' 条问题：' +
  errors.length + ' 个错误，' + warns.length + ' 个警告');
process.exit(errors.length ? 1 : 0);
