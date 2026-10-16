/* ==========================================================================
   SimScore —— 三轴评分的唯一规则来源（无 DOM）
   --------------------------------------------------------------------------
   为什么值得单独一个文件：这三个数字既要摆在玩家面前，又要能被校验器独立复算。
   规则一旦写在界面里，校验器就只能"相信界面报的数" —— 那是自证，不是验证。
   放在这里，工作台和 validate-missions.mjs 跑的是同一份代码、同一套计数。

   三轴对应《深圳 I/O》的成本 / 功耗 / 行数（PRACTICE-SPEC §5.8）：
     注入面 —— 从外部插进目标多少次、改了它多少字节
     风控值 —— 试错与破坏目标的代价
     步数   —— 工作台里发起的工具操作次数

   ★ 「作者基线」不是写死的常量，是 replay() 把作者路线**真的走一遍**算出来的。
     否则那三个数字只是文案，不是证据。

   挂到 window.SIMSCORE
   ========================================================================== */
(function (global) {
  'use strict';

  const C = global.CRYPTO;

  /* ---------------------------------------------------------------- 规则 */
  /* 改这里，工作台与校验器同时改 —— 不存在"两处规则"这回事 */
  const RULES = {
    INJECT_PER_PATCH_BYTE: 10,   /* 改写 1 字节 = 注入面 +10 */
    RISK_PER_PATCH: 25,          /* 改写目标文件一次 = 风控 +25 */
    RISK_PER_WRONG_TRY: 34,      /* 提交错一次 = 风控 +34（三次就触发拦截） */
    RISK_LOCK_AT: 100,           /* 到这个值被风控拦下 */
    RISK_AFTER_LOCK: 45          /* 解封后残留的风控值 */
  };

  /* -------------------------------------------------------------- 记账本 */
  /* 玩家每做一个动作就记一笔。三轴的加法只有这里一份。 */
  function Ledger() {
    this.steps = 0;
    this.risk = 0;
  }

  /* 发起一次工具操作：终端敲命令、映像面板查询、Hook 命令 —— 都算一次 */
  Ledger.prototype.toolStep = function () { this.steps++; };

  /* 改写了目标文件 */
  Ledger.prototype.patch = function () {
    this.risk = Math.min(RULES.RISK_LOCK_AT, this.risk + RULES.RISK_PER_PATCH);
  };

  /* 提交错一次 */
  Ledger.prototype.wrongTry = function () {
    this.risk = Math.min(RULES.RISK_LOCK_AT, this.risk + RULES.RISK_PER_WRONG_TRY);
  };

  Ledger.prototype.locked = function () { return this.risk >= RULES.RISK_LOCK_AT; };
  Ledger.prototype.unlock = function () { this.risk = RULES.RISK_AFTER_LOCK; };

  /* 注入面刻意不记在账本上，它记在映像自己身上（simmative 的 stats）——
     因为它衡量的是"目标被从外部动了多少次"，那是目标的属性，不是玩家的属性。 */
  Ledger.prototype.inject = function (img) {
    return img.stats.hookCount + img.stats.patchBytes * RULES.INJECT_PER_PATCH_BYTE;
  };

  Ledger.prototype.snapshot = function (img) {
    return { inject: this.inject(img), risk: this.risk, steps: this.steps };
  };

  /* ------------------------------------------------------------ 路线重放 */
  /* 把 mission.reference.route 真的执行一遍，用上面这套规则计数。
     返回的三轴是"照着这条路线做一遍会得到什么"，不是谁手写的数字。

     路线里每一项都是**可执行的操作**，不是描述：
       { op:'shell',        cmd }          终端敲一条命令
       { op:'image.hexdump', addr, len }   映像面板转储一段
       { op:'image.strings' }              映像面板看字符串
       { op:'image.elf' }                  映像面板看节表
       { op:'hook.read',    addr, len }    Hook 读一段内存
       { op:'hook.list' }                  Hook 列出算子与符号
       { op:'hook.call',    name }         Hook 调一次算子
       { op:'hook.patch',   addr, hex }    Hook 改写映像
       { op:'submit' }                     提交（提交本身不算步数）
       { op:'note' }                       纯人工判断，不产生工具操作

     每项都要带 label（给玩家看的白话）。带 label 而不带 cmd 的路线会立刻
     在 validate-missions 里报"未知操作" —— 这是故意的：描述性的路线不算路线。

     ★ 这里刻意自己建一套靶场，不复用玩家正在操作的那套 ——
       路线里若含 patch，也不会污染玩家的映像。 */
  function replay(mission) {
    const art = global.FORGE.build(mission.spec, mission.seed);
    const dev = global.SIMDEVICE.boot(art.world, art.imgs);
    const soPath = art.public.soPath;
    const img = art.imgs[soPath];
    const led = new Ledger();
    const log = [];
    const route = mission.reference.route || [];
    let ok = true, detail = '', submitted = false;

    for (let i = 0; i < route.length; i++) {
      const s = route[i];
      const at = '路线第 ' + (i + 1) + ' 步';
      let note = '';

      switch (s.op) {
        case 'note':
          /* 人在脑子里的判断：不产生工具操作，不记步数 —— 这正是它和"敲命令"的区别 */
          note = '人工判断，不产生工具操作';
          break;

        case 'shell': {
          led.toolStep();
          const r = dev.shell(s.cmd);
          note = r.code === 0 ? r.out : ('失败：' + r.err);
          if (r.code !== 0) { ok = false; detail = at + '的命令失败了：' + s.cmd; }
          break;
        }

        case 'image.hexdump': {
          led.toolStep();
          const r = dev.shell('hexdump ' + soPath + ' 0x' + (s.addr >>> 0).toString(16) + ' ' + s.len);
          note = r.code === 0 ? ('转储 ' + s.len + ' 字节 @ 0x' + (s.addr >>> 0).toString(16)) : ('失败：' + r.err);
          if (r.code !== 0) { ok = false; detail = at + '的转储失败了'; }
          break;
        }

        case 'image.strings': {
          led.toolStep();
          const r = dev.shell('strings ' + soPath);
          note = r.code === 0 ? '已列出' : ('失败：' + r.err);
          if (r.code !== 0) { ok = false; detail = at + '的 strings 失败了'; }
          break;
        }

        case 'image.elf': {
          led.toolStep();
          const e = global.SIMELF.parse(art.images[soPath]);
          note = e.ok ? (e.sections.length + ' 个节') : ('解析失败：' + e.err);
          if (!e.ok) { ok = false; detail = at + '的 ELF 解析失败了'; }
          break;
        }

        case 'hook.read': {
          led.toolStep();
          const b = img.read(s.addr, s.len);
          if (b.length) {
            note = b.length + ' 字节 @ 0x' + (s.addr >>> 0).toString(16);
          } else {
            note = '越界'; ok = false; detail = at + '的读取越界了';
          }
          break;
        }

        case 'hook.list': {
          led.toolStep();
          const e = global.SIMELF.parse(art.images[soPath]);
          note = img.ops.length + ' 个算子 / ' + e.dynsyms.length + ' 个导出符号';
          break;
        }

        case 'hook.call': {
          led.toolStep();
          try {
            note = '→ ' + img.call(s.name, art.public.appInput, { instrumented: true });
          } catch (e) {
            note = '失败：' + e.message;
            ok = false; detail = at + '调用算子失败：' + e.message;
          }
          break;
        }

        case 'hook.patch': {
          led.toolStep();
          const bytes = C.fromHex(s.hex);
          if (img.patch(s.addr, bytes)) {
            led.patch();
            note = '改写 ' + bytes.length + ' 字节 @ 0x' + (s.addr >>> 0).toString(16);
          } else {
            note = '越界'; ok = false; detail = at + '的改写越界了';
          }
          break;
        }

        case 'submit': {
          /* 提交不算工具操作（界面里也是这么算的）。这里用作者解法算出答案再走
             一遍真实判定 —— 于是"这条路线确实能通关"本身也成了被验证的事。 */
          const sol = mission.reference.solve(art);
          const r = mission.objective.run(sol.words, art);
          submitted = true;
          note = r.ok ? '通过' : ('未通过：' + r.detail);
          if (!r.ok) { ok = false; detail = at + '提交未通过：' + r.detail; }
          break;
        }

        default:
          ok = false;
          note = '未知操作';
          detail = at + '是未知操作「' + s.op + '」—— 路线必须写成可执行的操作，不能是描述';
      }

      log.push({ i: i + 1, op: s.op, label: s.label || s.op, note: note });
    }

    /* 一条没有提交步骤的"路线"描述了过程但没有终点，不算能通关 */
    if (ok && !submitted) {
      ok = false;
      detail = '这条路线没有提交步骤 —— 它描述了过程，但没有终点';
    }

    return {
      ok: ok,
      detail: detail,
      log: log,
      /* 给界面用的路线白话（按顺序） */
      route: route.map(s => s.label || s.op),
      inject: led.inject(img),
      risk: led.risk,
      steps: led.steps
    };
  }

  global.SIMSCORE = {
    RULES: RULES,
    Ledger: Ledger,
    replay: replay
  };
})(window);
