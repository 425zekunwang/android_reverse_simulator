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

  /* ======================================================== 路线 op 词汇表 */
  /* ★ 路线里能写哪些 op、每种需要哪个工具面板、怎么执行、要不要记步 —— **只有这一份**。
     表本身就是词汇表：validate-missions 直接读它，不再另抄一份；而且它会**逐个执行**
     每个条目，证明"登记了"和"实现了"是同一件事。

     为什么非做成数据表不可：这一轮的教训。原先 op 分散在 replay() 的 switch 里，
     工具映射写在校验器里 —— 两张表各自演化，谁也不知道对方少了哪一条。
     现在加 op 只有一种做法：在这张表里加一条。忘了加？路线里写它就报"未知操作"。

     字段：
       tool   需要哪个面板才做得到；null = 不需要（工单与提交面板永远在）
       desc   给玩家看的白话（也是路线步骤的默认标签）
       probe  校验器用来"真的执行一遍"的最小参数集 —— 从关卡派生，不写死
       run    真的执行。返回 { note, fail?, submitted? }
              note  这一步实际发生了什么（日志与排查用）
              fail  没做成时给玩家的一句话原因；有它就判路线走不通 */
  const ROUTE_OPS = {
    'shell': {
      tool: 'shell',
      desc: '终端敲一条命令',
      probe: () => ({ cmd: 'uname -a' }),
      run: (ctx, s) => {
        ctx.led.toolStep();
        const r = ctx.dev.shell(s.cmd);
        return r.code === 0
          ? { note: r.out }
          : { note: '失败：' + r.err, fail: '的命令失败了：' + s.cmd };
      }
    },

    'image.hexdump': {
      tool: 'image',
      desc: '映像面板转储一段',
      probe: () => ({ addr: 0x1000, len: 64 }),
      run: (ctx, s) => {
        ctx.led.toolStep();
        const at = '0x' + (s.addr >>> 0).toString(16);
        const r = ctx.dev.shell('hexdump ' + ctx.soPath + ' ' + at + ' ' + s.len);
        return r.code === 0
          ? { note: '转储 ' + s.len + ' 字节 @ ' + at }
          : { note: '失败：' + r.err, fail: '的转储失败了' };
      }
    },

    'image.strings': {
      tool: 'image',
      desc: '映像面板看字符串',
      probe: () => ({}),
      run: ctx => {
        ctx.led.toolStep();
        const r = ctx.dev.shell('strings ' + ctx.soPath);
        return r.code === 0 ? { note: '已列出' } : { note: '失败：' + r.err, fail: '的 strings 失败了' };
      }
    },

    'image.elf': {
      tool: 'image',
      desc: '映像面板看节表',
      probe: () => ({}),
      run: ctx => {
        ctx.led.toolStep();
        return ctx.elf.ok
          ? { note: ctx.elf.sections.length + ' 个节' }
          : { note: '解析失败：' + ctx.elf.err, fail: '的 ELF 解析失败了' };
      }
    },

    'hook.read': {
      tool: 'hook',
      desc: 'Hook 读一段内存',
      probe: () => ({ addr: 0x1020, len: 16 }),
      run: (ctx, s) => {
        ctx.led.toolStep();
        const b = ctx.img.read(s.addr, s.len);
        return b.length
          ? { note: b.length + ' 字节 @ 0x' + (s.addr >>> 0).toString(16) }
          : { note: '越界', fail: '的读取越界了' };
      }
    },

    'hook.list': {
      tool: 'hook',
      desc: 'Hook 列算子与符号',
      probe: () => ({}),
      run: ctx => {
        ctx.led.toolStep();
        return { note: ctx.img.ops.length + ' 个算子 / ' + ctx.elf.dynsyms.length + ' 个导出符号' };
      }
    },

    'hook.call': {
      tool: 'hook',
      desc: 'Hook 调一次算子',
      /* 算子名从关卡本身派生 —— 不把某一关的算子名写进引擎 */
      probe: m => ({ name: m.spec.so.op }),
      run: (ctx, s) => {
        ctx.led.toolStep();
        try {
          return { note: '→ ' + ctx.img.call(s.name, ctx.art.public.appInput, { instrumented: true }) };
        } catch (e) {
          return { note: '失败：' + e.message, fail: '调用算子失败：' + e.message };
        }
      }
    },

    'hook.patch': {
      tool: 'hook',
      desc: 'Hook 改写映像',
      probe: () => ({ addr: 0x1020, hex: 'deadbeef' }),
      run: (ctx, s) => {
        ctx.led.toolStep();
        const bytes = C.fromHex(s.hex);
        if (!ctx.img.patch(s.addr, bytes)) return { note: '越界', fail: '的改写越界了' };
        ctx.led.patch();
        return { note: '改写 ' + bytes.length + ' 字节 @ 0x' + (s.addr >>> 0).toString(16) };
      }
    },

    'note': {
      tool: null,
      desc: '纯人工判断，不产生工具操作',
      probe: () => ({}),
      /* 人在脑子里的判断：不产生工具操作，不记步数 —— 这正是它和"敲命令"的区别。
         它也是作者路线能做到 1 步的原因。 */
      run: () => ({ note: '人工判断，不产生工具操作' })
    },

    'submit': {
      tool: null,
      desc: '提交',
      probe: () => ({}),
      run: ctx => {
        /* 提交不算工具操作（界面里也是这么算的）。
           这里用作者解法算出答案再走一遍**真实判定** ——
           于是"这条路线确实能通关"本身也成了被验证的事。 */
        const sol = ctx.mission.reference.solve(ctx.art);
        const r = ctx.mission.objective.run(sol.words, ctx.art);
        return r.ok
          ? { note: '通过', submitted: true }
          : { note: '未通过：' + r.detail, fail: '提交未通过：' + r.detail, submitted: true };
      }
    }
  };

  /* ------------------------------------------------------------ 路线重放 */
  /* 把 mission.reference.route 真的执行一遍，用上面这套规则计数。
     返回的三轴是"照着这条路线做一遍会得到什么"，不是谁手写的数字。

     路线里每一项都是**可执行的操作**：{ op, ...该 op 要的参数, label }。
     label 是给玩家看的白话；没有 label 就用词汇表里的 desc。

     ★ 这里刻意自己建一套靶场，不复用玩家正在操作的那套 ——
       路线里若含 patch，也不会污染玩家的映像。 */
  function replay(mission) {
    const art = global.FORGE.build(mission.spec, mission.seed);
    const dev = global.SIMDEVICE.boot(art.world, art.imgs);
    const soPath = art.public.soPath;
    const img = art.imgs[soPath];
    /* 解析的是**原始**映像字节（与改写后的 img 视图不同）——
       这与原来每次现解析的行为一致：改写不会让节表跟着变。 */
    const elf = global.SIMELF.parse(art.images[soPath]);
    const led = new Ledger();
    const log = [];
    const route = mission.reference.route || [];
    const ctx = { led, dev, img, art, elf, soPath, mission };
    let ok = true, detail = '', submitted = false;

    for (let i = 0; i < route.length; i++) {
      const s = route[i];
      const at = '路线第 ' + (i + 1) + ' 步';
      const spec = ROUTE_OPS[s.op];
      let note = '';

      if (!spec) {
        ok = false;
        note = '未知操作';
        detail = at + '是未知操作「' + s.op + '」—— 路线必须写成可执行的操作，不能是描述';
      } else {
        const r = spec.run(ctx, s);
        if (r.submitted) submitted = true;
        note = r.note || '';
        if (r.fail) { ok = false; detail = at + r.fail; }
      }

      log.push({ i: i + 1, op: s.op, label: s.label || (spec ? spec.desc : s.op), note: note });
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
      route: route.map(s => s.label || (ROUTE_OPS[s.op] ? ROUTE_OPS[s.op].desc : s.op)),
      inject: led.inject(img),
      risk: led.risk,
      steps: led.steps
    };
  }

  global.SIMSCORE = {
    RULES: RULES,
    Ledger: Ledger,
    ROUTE_OPS: ROUTE_OPS,
    replay: replay
  };
})(window);
