/* ==========================================================================
   实战区 —— 工单收件箱 + 工作台
   --------------------------------------------------------------------------
   设计母版：深圳 I/O 的"上班"。这里是本站的收件箱与 IDE。

   三件事必须是真的：
     ① 靶场产物由 FORGE 现场生成，不是预录
     ② 终端与映像面板走的是同一套 shell 命令（SIMDEVICE.shell），
        不是"另写一份把结果画出来"
     ③ logcat 里的摘要是程序真跑出来的

   与全站共用：AKKC_STORE（进度）、app.js 的顶栏与样式变量。
   挂到 window.AKKC_PRACTICE
   ========================================================================== */
(function (global) {
  'use strict';

  const MISSIONS = global.SIM_MISSIONS_LIST || [];
  const findMission = id => MISSIONS.find(m => m.id === id);

  const TYPE_NAME = { 0: 'NULL', 1: 'PROGBITS', 2: 'SYMTAB', 3: 'STRTAB', 4: 'RELA', 8: 'NOBITS', 11: 'DYNSYM' };
  const SHF_A = 0x2, SHF_X = 0x4, SHF_W = 0x1;
  const hex = n => '0x' + Number(n).toString(16);
  const pad = (s, n) => String(s).padEnd(n);

  /* ------------------------------------------------------------ 进度存储 */
  /* 与全站共用同一份 storage（key: akkc-progress-v1），新增 missions 段 */
  function progress() { return global.AKKC_STORE.get('missions', {}) || {}; }
  function progressOf(id) { return progress()[id] || null; }
  function saveProgress(id, rec) { const all = progress(); all[id] = rec; global.AKKC_STORE.set('missions', all); }

  /* ------------------------------------------------------------ 控制台 */
  function mkConsole(box) {
    return {
      push(html, cls) {
        const d = document.createElement('div');
        d.className = 'pr-line' + (cls ? ' ' + cls : '');
        d.innerHTML = html;
        box.appendChild(d);
        box.scrollTop = box.scrollHeight;
      },
      hr() { this.push('<span class="pr-dim">─────────────────────────────</span>'); },
      clear() { box.innerHTML = ''; }
    };
  }

  /* ======================================================================
     工作台
     ====================================================================== */
  function Workbench(root, mission) {
    this.root = root;
    this.m = mission;
    this.seed = mission.seed || 2201;
    this.reset();
  }

  /* 重建靶场：等于把设备重新开一次机。风险、步数、注入面一起清零。 */
  Workbench.prototype.reset = function () {
    const m = this.m;
    if (this.lockIt) { clearInterval(this.lockIt); this.lockIt = null; }

    this.art = global.FORGE.build(m.spec, this.seed);
    this.dev = global.SIMDEVICE.boot(this.art.world, this.art.imgs);
    this.soPath = this.art.public.soPath;
    this.img = this.art.imgs[this.soPath];
    this.elf = global.SIMELF.parse(this.art.images[this.soPath]);

    /* 作者解法只跑一次。它是纯静态的 —— 不碰目标，所以产物不会变。 */
    const sol = m.reference.solve(this.art);
    this.author = {
      inject: 0,
      risk: 0,
      steps: (m.reference.route || []).length,
      route: m.reference.route || [],
      sol: sol
    };

    this.steps = 0;
    this.risk = 0;
    this.tries = 0;
    this.locked = false;
    this.solved = false;
    this.best = progressOf(m.id);

    this.render();
    this.wire();
    this.refreshDevice();
    this.refreshImage();
    this.paintRisk();
    this.paintScores();
  };

  /* 离开本关时调用：清掉计时器，避免旧的锁定倒计时打到已经不在的 DOM 上 */
  Workbench.prototype.destroy = function () {
    if (this.lockIt) { clearInterval(this.lockIt); this.lockIt = null; }
  };

  /* ------------------------------------------------------------ 渲染 */
  Workbench.prototype.render = function () {
    const m = this.m;
    const tools = m.tools || ['device', 'shell', 'image'];
    const has = t => tools.indexOf(t) >= 0;

    let h = '';
    h += '<div class="pr-head">' +
      '<a class="pr-back" href="practice.html">◀ 工单收件箱</a>' +
      '<div class="pr-head-main">' +
        '<span class="pr-kicker">工单 ' + m.id.toUpperCase() + ' · 第 ' + m.chapter + ' 章</span>' +
        '<h1>' + m.title + '</h1>' +
      '</div>' +
      '<button class="btn ghost" data-pr="reset">↻ 重新开始</button>' +
    '</div>';

    h += '<div class="pr-grid">';

    /* ---- 工单 ---- */
    h += '<section class="pr-pane pr-brief" style="grid-area:brief">' +
      '<div class="pr-pane-h">📋 工单</div>' +
      '<ul class="pr-brief-list">' + m.brief.map(x => '<li>' + x + '</li>').join('') + '</ul>' +
      '<div class="pr-accept"><b>验收标准</b><div>' + m.acceptance + '</div></div>' +
      (has('hook')
        ? '<div class="pr-caveat">⚠ 本设备是<b>模拟器</b>，不是真 Android。文件系统是虚拟的，命令表是有限的（终端里输入 <code>help</code>）。但 libtarget.so 是结构合法的真 ELF，native 计算也是真算的。</div>'
        : '') +
    '</section>';

    /* ---- 提交 ---- */
    h += '<section class="pr-pane pr-submit" style="grid-area:submit">' +
      '<div class="pr-pane-h">📮 提交与评分</div>' +
      '<div class="pr-obj-prompt">' + m.objective.prompt + '</div>' +
      '<div class="pr-obj-fields">' +
        (m.objective.fields || []).map((f, i) =>
          '<label class="pr-field"><span>' + f + '</span>' +
          '<input class="pr-in mono" data-obj="' + f + '" type="text" placeholder="' + (i === 0 ? '例如 67452301' : '') + '"></label>'
        ).join('') +
      '</div>' +
      '<div class="pr-acts">' +
        '<button class="btn ok" data-pr="check">✓ 提交并检查</button>' +
        '<button class="btn ghost" data-pr="hint">💡 提示</button>' +
      '</div>' +
      '<div class="pr-out" id="pr-sub-out"></div>' +
      '<div class="pr-risk"><span class="pr-risk-label">🛡 风控值</span>' +
        '<span class="lr-bar"><i></i></span><span class="pr-risk-val">0%</span></div>' +
      '<div class="pr-scores" id="pr-scores"></div>' +
    '</section>';

    /* ---- 设备 ---- */
    if (has('device')) {
      h += '<section class="pr-pane pr-device" style="grid-area:device">' +
        '<div class="pr-pane-h">📱 设备</div>' +
        '<div class="pr-devinfo" id="pr-devinfo"></div>' +
        '<div class="pr-apps">' +
          (this.art.world.apps || []).map(a =>
            '<div class="pr-app"><span class="pr-app-label">' + a.label + '</span>' +
            '<span class="pr-app-pkg mono">' + a.pkg + '</span>' +
            '<button class="btn primary" data-pr="launch" data-pkg="' + a.pkg + '">▶ 启动应用</button></div>'
          ).join('') +
        '</div>' +
        '<div class="pr-sub-h">logcat</div>' +
        '<div class="pr-console pr-console-s" id="pr-logcat"></div>' +
      '</section>';
    }

    /* ---- 终端 ---- */
    if (has('shell')) {
      h += '<section class="pr-pane pr-shell" style="grid-area:shell">' +
        '<div class="pr-pane-h">⌨️ 终端 <span class="pr-pane-sub">受控命令表，输入 help 查看</span></div>' +
        '<div class="pr-console" id="pr-term"></div>' +
        '<div class="pr-cmdline"><span class="pr-prompt">$</span>' +
          '<input class="pr-cmd mono" data-cmd="term" type="text" placeholder="ls /data/local/tmp" autocomplete="off"></div>' +
        '<div class="pr-chips">' +
          ['help', 'uname -a', 'pm list packages', 'am start ' + this.art.world.apps[0].pkg, 'logcat -s vault-native']
            .map(c => '<button class="pr-chip" data-chip="' + c + '">' + c + '</button>').join('') +
        '</div>' +
      '</section>';
    }

    /* ---- 映像 ---- */
    if (has('image')) {
      h += '<section class="pr-pane pr-image" style="grid-area:image">' +
        '<div class="pr-pane-h">🔎 映像 <span class="pr-pane-sub">静态分析，不碰目标</span></div>' +
        '<div class="pr-imginfo" id="pr-imginfo"></div>' +
        '<div class="pr-cmdline"><span class="pr-prompt">hexdump</span>' +
          '<input class="pr-cmd mono" data-cmd="hxoff" type="text" value="0x1000" size="8" title="偏移">' +
          '<input class="pr-cmd mono" data-cmd="hxlen" type="text" value="128" size="5" title="长度">' +
          '<button class="btn" data-pr="hex">转储</button>' +
          '<button class="btn ghost" data-pr="elf">节表 / 符号表</button>' +
          '<button class="btn ghost" data-pr="strings">strings</button>' +
        '</div>' +
        '<div class="pr-console" id="pr-img"></div>' +
      '</section>';
    }

    /* ---- Hook ---- */
    if (has('hook')) {
      h += '<section class="pr-pane pr-hook" style="grid-area:hook">' +
        '<div class="pr-pane-h">🪝 Hook 控制台 <span class="pr-pane-sub">会动到目标 —— 计入「注入面」</span></div>' +
        '<div class="pr-console" id="pr-hook"></div>' +
        '<div class="pr-cmdline"><span class="pr-prompt">▶</span>' +
          '<input class="pr-cmd mono" data-cmd="hook" type="text" placeholder="list()" autocomplete="off"></div>' +
        '<div class="pr-chips">' +
          ['list()', 'help'].map(c => '<button class="pr-chip" data-chip="' + c + '">' + c + '</button>').join('') +
        '</div>' +
      '</section>';
    }

    h += '</div>';

    this.root.innerHTML = h;
  };

  /* ------------------------------------------------------------ 事件装配 */
  Workbench.prototype.wire = function () {
    const self = this;
    const root = this.root;

    this.term = mkConsole(root.querySelector('#pr-term'));
    this.hook = mkConsole(root.querySelector('#pr-hook'));
    this.imgLog = mkConsole(root.querySelector('#pr-img'));
    this.logcatBox = root.querySelector('#pr-logcat');

    root.addEventListener('click', e => {
      const chip = e.target.closest && e.target.closest('[data-chip]');
      if (chip) {
        const box = chip.closest('.pr-pane');
        const input = box.querySelector('.pr-cmd');
        input.value = chip.dataset.chip;
        input.focus();
        return;
      }
      const a = e.target.dataset && e.target.dataset.pr;
      if (!a) return;
      if (a === 'reset') { self.seed = self.m.seed || 2201; self.reset(); return; }
      if (a === 'launch') { self.launch(e.target.dataset.pkg); return; }
      if (a === 'check') { self.check(); return; }
      if (a === 'hint') { self.showHint(); return; }
      if (a === 'hex') { self.showHex(); return; }
      if (a === 'elf') { self.showElf(); return; }
      if (a === 'strings') { self.showStrings(); return; }
    });

    root.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const cmd = e.target.dataset && e.target.dataset.cmd;
      if (!cmd) return;
      e.preventDefault();
      const v = e.target.value.trim();
      e.target.value = '';
      if (!v) return;
      if (cmd === 'term') self.runShell(v);
      else if (cmd === 'hook') self.runHook(v);
    });

    /* 首次提示 */
    this.term.push('<span class="pr-dim">这是一台模拟设备。输入 <b>help</b> 看支持哪些命令。</span>');
    this.term.push('<span class="pr-dim">目标应用会调用 libtarget.so 里的摘要例行。先让它跑一次，看看它输出什么。</span>');
    this.hook.push('<span class="pr-dim">Hook 控制台直接操作装载进内存的映像。输入 <b>help</b>。</span>');
    this.imgLog.push('<span class="pr-dim">输入偏移后点「转储」，或直接看节表 / 符号表。.rodata 从 0x1000 开始。</span>');
  };

  /* ------------------------------------------------------------ 设备 */
  Workbench.prototype.refreshDevice = function () {
    const d = this.dev.meta;
    const info = this.root.querySelector('#pr-devinfo');
    if (info) {
      info.innerHTML =
        '<span>' + d.model + '</span><span>Android ' + d.sdk + '</span>' +
        '<span class="mono">' + d.abi + '</span><span class="mono">' + d.serial + '</span>' +
        '<span class="pr-dim">（模拟设备）</span>';
    }
    this.paintLogcat();
  };

  Workbench.prototype.paintLogcat = function () {
    if (!this.logcatBox) return;
    const logs = this.dev.logcat();
    const tail = logs.slice(-40);
    this.logcatBox.innerHTML = tail.map(r =>
      '<div class="pr-line"><span class="pr-lt">' + String(r.t).padStart(5, '0') + '</span>' +
      '<span class="pr-ltag">' + r.tag + '</span>' +
      '<span class="pr-lmsg">' + r.msg + '</span></div>').join('') ||
      '<span class="pr-dim">（logcat 为空）</span>';
    this.logcatBox.scrollTop = this.logcatBox.scrollHeight;
  };

  Workbench.prototype.launch = function (pkg) {
    const r = this.dev.shell('am start ' + pkg);
    this.term.push('<span class="pr-prompt">$</span> am start ' + pkg);
    this.term.push(r.code === 0 ? r.out : '<span class="pr-err">' + r.err + '</span>');
    this.refreshDevice();
  };

  /* ------------------------------------------------------------ 终端 */
  Workbench.prototype.runShell = function (line) {
    this.steps++;
    this.term.push('<span class="pr-prompt">$</span> ' + esc(line));
    const r = this.dev.shell(line);
    if (r.out) this.term.push('<pre class="pr-pre">' + esc(r.out) + '</pre>');
    /* 终端报错是"命令不支持"，不是"你答错了" —— 不计风控 */
    if (r.err) this.term.push('<span class="pr-err">' + esc(r.err) + '</span>');
    this.refreshDevice();
    this.paintScores();
  };

  /* ------------------------------------------------------------ 映像 */
  Workbench.prototype.refreshImage = function () {
    const box = this.root.querySelector('#pr-imginfo');
    if (!box) return;
    const ro = this.elf.section('.rodata');
    box.innerHTML =
      '<span class="mono">' + this.soPath + '</span>' +
      '<span class="pr-dim">' + this.art.images[this.soPath].length + ' 字节 · AArch64 共享对象 · ' +
      (ro ? '.rodata 0x' + ro.addr.toString(16) + ' 起 ' + ro.size + ' 字节' : '') + '</span>';
  };

  Workbench.prototype.showHex = function () {
    const off = this.root.querySelector('[data-cmd="hxoff"]').value.trim();
    const len = this.root.querySelector('[data-cmd="hxlen"]').value.trim();
    this.steps++;
    const r = this.dev.shell('hexdump ' + this.soPath + ' ' + off + ' ' + len);
    this.imgLog.hr();
    this.imgLog.push('<span class="pr-prompt">hexdump</span> ' +
      '<span class="mono">' + esc(this.soPath) + ' ' + esc(off) + ' ' + esc(len) + '</span>');
    this.imgLog.push('<pre class="pr-pre">' + (r.err ? '<span class="pr-err">' + esc(r.err) + '</span>' : esc(r.out)) + '</pre>');
    this.paintScores();
  };

  Workbench.prototype.showStrings = function () {
    this.steps++;
    const r = this.dev.shell('strings ' + this.soPath);
    this.imgLog.hr();
    this.imgLog.push('<span class="pr-prompt">strings</span> <span class="mono">' + esc(this.soPath) + '</span>');
    this.imgLog.push('<pre class="pr-pre">' + (r.err ? esc(r.err) : esc(r.out)) + '</pre>');
    this.paintScores();
  };

  Workbench.prototype.showElf = function () {
    const e = this.elf;
    this.steps++;
    this.imgLog.hr();
    this.imgLog.push('<b>ELF 头</b> — ' +
      e.header.machineName + ' · ' + e.header.typeName +
      ' · 节 ' + e.sections.length + ' · 段 ' + e.phdrs.length);

    let t = '<div class="pr-tbl-wrap"><table class="pr-tbl"><thead><tr>' +
      '<th>节</th><th>类型</th><th>地址</th><th>偏移</th><th>大小</th><th>标志</th></tr></thead><tbody>';
    e.sections.forEach(s => {
      if (!s.name || s.name === '(NULL)') return;
      const f = (s.flags & SHF_A ? 'A' : '') + (s.flags & SHF_X ? 'X' : '') + (s.flags & SHF_W ? 'W' : '');
      t += '<tr><td class="mono">' + s.name + '</td><td>' + (TYPE_NAME[s.type] || s.type) + '</td>' +
        '<td class="mono">' + hex(s.addr) + '</td><td class="mono">' + hex(s.offset) + '</td>' +
        '<td class="mono">' + hex(s.size) + '</td><td>' + (f || '-') + '</td></tr>';
    });
    t += '</tbody></table></div>';
    this.imgLog.push(t);

    t = '<div class="pr-tbl-wrap"><table class="pr-tbl"><thead><tr>' +
      '<th>符号</th><th>类型</th><th>地址</th><th>所在节</th></tr></thead><tbody>';
    e.dynsyms.forEach(s => {
      t += '<tr><td class="mono">' + esc(s.name) + '</td><td>' +
        (['NOTYPE', 'OBJECT', 'FUNC'][s.type] || s.type) + '</td>' +
        '<td class="mono">' + hex(s.value) + '</td><td class="mono">' + esc(s.section) + '</td></tr>';
    });
    t += '</tbody></table></div>';
    this.imgLog.push(t);
    this.imgLog.push('<span class="pr-dim">.text 里放的不是 ARM 指令，而是算子表 —— 本站不反汇编 ARM。</span>');
    this.paintScores();
  };

  /* ------------------------------------------------------------ Hook 控制台 */
  /* 命令集刻意做小：只有四种动作。阅读类的是安全的，动手类计入注入面。 */
  Workbench.prototype.runHook = function (line) {
    this.steps++;
    this.hook.push('<span class="pr-prompt">▶</span> ' + esc(line));
    this.hookExec(line);
    /* 每敲一条都要重绘分数 —— 否则「步数」会停在最后一次动手命令上（help / list 提前 return） */
    this.paintScores();
  };

  /* 真正执行一条 Hook 命令。括号可省：help 与 list 都不带参数，不该被当成语法错误。 */
  Workbench.prototype.hookExec = function (line) {
    const m = /^(\w+)\s*(?:\(([^)]*)\))?\s*;?$/.exec(line);
    if (!m) {
      this.hook.push('<span class="pr-err">语法不认。形如 <code>list()</code> / <code>read(0x1020, 16)</code> / <code>call("md5-iv")</code> / <code>patch(0x1020, "deadbeef")</code></span>');
      return;
    }
    const cmd = m[1];
    const argv = (m[2] || '').split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(x => x !== '');
    const img = this.img;

    if (cmd === 'help') {
      this.hook.push('<pre class="pr-pre">' +
        'list()                    列出映像里的算子与符号\n' +
        'read(地址, 长度)           读映像内存，按小端给出 32 位字\n' +
        'call("算子名")             调用 native 算子（用 App 的输入）\n' +
        'patch(地址, "十六进制")     改写映像 —— 会明显增加注入面</pre>');
      return;
    }

    if (cmd === 'list') {
      let t = '<pre class="pr-pre">算子表（来自 .text）:\n';
      img.ops.forEach(o => {
        t += '  ' + pad(o.name, 14) + '常量偏移 ' + hex(this.img.rodataAddr + o.rodataOff) +
             '  常量 ' + o.constSize + ' 字节  ' + (o.known ? '' : '（不在白名单）') + '\n';
      });
      t += '\n导出符号:\n';
      this.elf.dynsyms.forEach(s => { t += '  ' + hex(s.value) + '  ' + s.name + '\n'; });
      t += '</pre>';
      this.hook.push(t);
      return;
    }

    if (cmd === 'read') {
      const addr = parseInt(argv[0], 0), len = argv[1] ? parseInt(argv[1], 0) : 16;
      if (!isFinite(addr) || !isFinite(len) || len <= 0 || len > 256) {
        this.hook.push('<span class="pr-err">参数不对：read(0x1020, 16)</span>');
        return;
      }
      const b = img.read(addr, len);
      if (!b.length) { this.hook.push('<span class="pr-err">越界：映像只有 ' + img.bytes.length + ' 字节</span>'); return; }
      let t = '<pre class="pr-pre">' + hex(addr) + '  ' +
        Array.from(b).map(x => x.toString(16).padStart(2, '0')).join(' ') + '\n小端 32 位字: ';
      for (let i = 0; i + 4 <= b.length; i += 4) {
        t += '0x' + global.SIMNATIVE.le32(b, i).toString(16).padStart(8, '0') + ' ';
      }
      t += '</pre>';
      this.hook.push(t);
      return;
    }

    if (cmd === 'call') {
      const op = argv[0];
      if (!op) { this.hook.push('<span class="pr-err">call("算子名")</span>'); return; }
      try {
        const out = img.call(op, this.art.public.appInput, { instrumented: true });
        this.hook.push('<pre class="pr-pre">' + esc(op) + '(appInput) → ' + esc(String(out)) + '</pre>');
      } catch (e) {
        this.hook.push('<span class="pr-err">' + esc(e.message) + '</span>');
      }
      return;
    }

    if (cmd === 'patch') {
      const addr = parseInt(argv[0], 0);
      const hx = (argv[1] || '').replace(/[^0-9a-fA-F]/g, '');
      if (!isFinite(addr) || !hx.length || hx.length % 2) {
        this.hook.push('<span class="pr-err">patch(0x1020, "deadbeef")</span>');
        return;
      }
      const bytes = new Uint8Array(hx.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hx.substr(i * 2, 2), 16);
      if (!img.patch(addr, bytes)) { this.hook.push('<span class="pr-err">越界，写不进去</span>'); return; }
      this.risk = Math.min(100, this.risk + 25);
      this.hook.push('<span class="pr-warn">已改写 ' + bytes.length + ' 字节 @ ' + hex(addr) +
        ' —— 目标文件完整性被破坏，风控 +25</span>');
      this.refreshImage();
      return;
    }

    this.hook.push('<span class="pr-err">未知命令「' + esc(cmd) + '」，输入 help</span>');
  };

  /* ------------------------------------------------------------ 评分三轴 */
  /* 对应深圳 I/O 的成本 / 功耗 / 行数（PRACTICE-SPEC §5.8）
       注入面 —— 你从外部插进目标多少次、改了它多少字节
       风控值 —— 试错与破坏目标的代价
       步数   —— 你在工作台里发起的工具操作次数 */
  Workbench.prototype.scores = function () {
    const st = this.img.stats;
    return {
      inject: st.hookCount + st.patchBytes * 10,
      risk: this.risk,
      steps: this.steps
    };
  };

  /* 作者解法：只做静态分析，一次都不碰目标（数值在 reset() 里算好，避免每次重绘都重扫 .rodata） */

  Workbench.prototype.paintScores = function () {
    const box = this.root.querySelector('#pr-scores');
    if (!box) return;
    const s = this.scores();
    const a = this.author;
    const row = (label, mine, auth, unit) => {
      const better = mine <= auth;
      return '<div class="pr-score"><span class="pr-score-l">' + label + '</span>' +
        '<span class="pr-score-v ' + (better ? 'good' : 'bad') + '">' + mine + (unit || '') + '</span>' +
        '<span class="pr-score-a">作者 ' + auth + (unit || '') + '</span></div>';
    };
    box.innerHTML =
      '<div class="pr-sub-h">三轴评分（越小越好）</div>' +
      row('注入面', s.inject, a.inject) +
      row('风控值', s.risk, a.risk) +
      row('步数', s.steps, a.steps) +
      '<div class="pr-dim pr-score-note">「注入面」= 从外部调用算子次数 + 改写字节数×10；' +
      '应用自己跑自己的例行不算。作者路线：' + esc((this.author.route || []).join(' → ')) +
      '，一次都不碰目标，所以是 0 / 0 / ' + this.author.steps + '。' +
      '这不是难度，是取向 —— 真实环境里动得越少越安全。</div>';
  };

  Workbench.prototype.paintRisk = function () {
    const el = this.root.querySelector('.pr-risk');
    if (!el) return;
    const bar = el.querySelector('.lr-bar i');
    const val = el.querySelector('.pr-risk-val');
    if (bar) bar.style.width = this.risk + '%';
    if (val) val.textContent = this.risk + '%';
    el.classList.toggle('warn', this.risk >= 40 && this.risk < 80);
    el.classList.toggle('danger', this.risk >= 80);
  };

  Workbench.prototype.showHint = function () {
    const out = this.root.querySelector('#pr-sub-out');
    out.innerHTML = '<div class="pr-msg warn"><b>💡 提示</b><div>' +
      (this.m.hint || '把数据从设备上自己挖出来——正文不会喂给你。') + '</div></div>';
  };

  /* ------------------------------------------------------------ 判定 */
  Workbench.prototype.check = function () {
    if (this.locked) return;
    const self = this;
    const out = this.root.querySelector('#pr-sub-out');
    const vals = {};
    this.root.querySelectorAll('[data-obj]').forEach(el => { vals[el.dataset.obj] = el.value; });

    const words = this.m.objective.parse(vals);
    this.tries++;
    let r;
    try { r = this.m.objective.run(words, this.art); }
    catch (e) { r = { ok: false, detail: '检查时出错：' + e.message }; }

    if (r.ok) { this.solved = true; }
    else {
      this.risk = Math.min(100, this.risk + 34);
      this.paintRisk();
      if (this.risk >= 100) this.lock();
    }

    out.innerHTML = '<div class="pr-msg ' + (r.ok ? 'pass' : 'fail') + '">' +
      '<b>' + (r.ok ? '✅ 通过了' : '❌ 还不对') + '</b>' +
      '<div class="pr-note">' + esc(r.detail) + '</div></div>';

    if (r.ok) this.onSolved();
    this.paintScores();
  };

  Workbench.prototype.onSolved = function () {
    const self = this;
    const out = this.root.querySelector('#pr-sub-out');
    const s = this.scores();
    const a = this.author;

    /* 记账：每个轴都保留历史最好 */
    const prev = progressOf(this.m.id);
    const best = {
      inject: prev && prev.best ? Math.min(prev.best.inject, s.inject) : s.inject,
      risk:   prev && prev.best ? Math.min(prev.best.risk, s.risk) : s.risk,
      steps:  prev && prev.best ? Math.min(prev.best.steps, s.steps) : s.steps
    };
    saveProgress(this.m.id, { ok: true, at: Date.now(), best: best, last: s });
    this.best = { ok: true, best: best };

    out.innerHTML +=
      '<div class="pr-msg key"><b>📦 复盘</b>' +
      '<div class="pr-note">你还原的 IV <code class="mono">' +
        this.art.truth.ivWords.map(w => '0x' + w.toString(16).padStart(8, '0')).join(' ') +
      '</code> —— 被魔改的是第 ' + (this.art.truth.mutatedIndex + 1) + ' 个字（下标 ' + this.art.truth.mutatedIndex + '）。</div>' +
      '<div class="pr-note">它藏在 .rodata 偏移 <code class="mono">' + hex(this.art.truth.constOffset) +
        '</code>，前面是噪声。作者解法就是逐字节滑动，找与标准 MD5 IV 最像的那个 16 字节窗口。</div>' +
      '<div class="pr-note">对拍验证的是<b>行为一致性</b>，不代表你的实现和真实目标逐字节相同。</div>' +
      '</div>' +
      '<div class="pr-msg ' + (s.inject <= a.inject && s.risk <= a.risk && s.steps <= a.steps ? 'pass' : '') + '">' +
        '<b>🏁 你 vs 作者</b>' +
        '<div class="pr-note">注入面 ' + s.inject + ' / 作者 ' + a.inject +
        ' · 风控 ' + s.risk + ' / ' + a.risk +
        ' · 步数 ' + s.steps + ' / ' + a.steps + '</div>' +
        '<div class="pr-note">' + (s.inject === 0
          ? '你全程没碰过目标 —— 这是最干净的解法。'
          : '你动了目标 ' + s.inject + ' 次。真机上这些动作都可能留下痕迹；试试纯静态路线能不能做到 0。') + '</div>' +
      '</div>';

    /* 上报全站进度：与章节页共用 ackc:done 通道 */
    this.root.dispatchEvent(new CustomEvent('akkc:done', {
      bubbles: true, detail: { kind: 'mission', mission: this.m.id, chapter: this.m.chapter }
    }));
  };

  Workbench.prototype.lock = function () {
    const self = this;
    const sec = 15;
    this.locked = true;
    const out = this.root.querySelector('#pr-sub-out');
    let left = sec;
    out.innerHTML = '<div class="pr-msg warn"><b>🛡 被风控拦下，' + left + ' 秒后可再试</b>' +
      '<div class="pr-note">真实环境里，连续试错会触发风控/验证码甚至封号。这次的代价就是这 ' + sec + ' 秒。' +
      '别反复猜 —— 先用 <code>hexdump</code> 把 .rodata 读出来，静态比对比猜快得多。</div></div>';
    const it = setInterval(() => {
      left--;
      if (left <= 0) {
        clearInterval(it);
        self.lockIt = null;
        self.locked = false;
        self.risk = 45;
        self.paintRisk();
        out.innerHTML = '<div class="pr-msg warn"><b>🔓 解锁了</b>' +
          '<div class="pr-note">想清楚再提交。静态分析一遍通常比猜十次快。</div></div>';
      } else {
        const b = out.querySelector('b');
        if (b) b.textContent = '🛡 被风控拦下，' + left + ' 秒后可再试';
      }
    }, 1000);
    this.lockIt = it;
  };

  /* ======================================================================
     工单收件箱
     ====================================================================== */
  function renderInbox(root) {
    const prog = progress();
    const byCh = {};
    MISSIONS.forEach(m => { (byCh[m.chapter] = byCh[m.chapter] || []).push(m); });

    let h = '<div class="pr-head"><div class="pr-head-main">' +
      '<span class="pr-kicker">PRACTICE</span><h1>实战区 · 工单收件箱</h1>' +
      '<p class="pr-lede">这里是"上班"的地方。每个工单给你一台模拟设备、一套工具和一条验收标准 —— ' +
      '<b>数据要你自己挖，结论要你自己验。</b>正文不再把答案喂到你面前。</p>' +
      '</div></div>';

    const done = MISSIONS.filter(m => prog[m.id] && prog[m.id].ok).length;
    h += '<div class="pr-inbox-stats">' +
      '<span><b>' + MISSIONS.length + '</b> 个工单</span>' +
      '<span><b>' + done + '</b> 已完成</span>' +
      '</div>';

    const chs = Object.keys(byCh).map(Number).sort((a, b) => a - b);
    chs.forEach(no => {
      h += '<div class="pr-group"><div class="pr-group-h">第 ' + no + ' 章</div>';
      byCh[no].forEach(m => {
        const rec = prog[m.id];
        const ok = rec && rec.ok;
        h += '<a class="pr-ticket' + (ok ? ' done' : '') + '" href="practice.html#' + m.id + '">' +
          '<span class="pr-ticket-id mono">' + m.id.toUpperCase() + '</span>' +
          '<span class="pr-ticket-main"><b>' + m.title + '</b>' +
            '<span class="pr-ticket-sub">' + m.brief[0] + '</span></span>' +
          '<span class="pr-ticket-state">' + (ok
            ? '✅ 已交付 <span class="pr-dim">注入 ' + (rec.best ? rec.best.inject : '?') +
              ' · 风控 ' + (rec.best ? rec.best.risk : '?') + ' · 步数 ' + (rec.best ? rec.best.steps : '?') + '</span>'
            : '待开始 →') + '</span>' +
        '</a>';
      });
      h += '</div>';
    });

    h += '<div class="pr-foot">' +
      '<p>共 ' + MISSIONS.length + ' 个工单。其余实验仍以原来的「动手实验」形式留在各章正文里 —— ' +
      '那些题目的本质是"看规则表填结论"，套上工作台只是形式主义，所以没搬过来。</p>' +
      '<p class="pr-dim">本区的设备、文件系统与命令表都是模拟的，不是真 Android。' +
      '但生成的 libtarget.so 是结构合法的真 ELF，native 计算是真算的 —— ' +
      '可以在终端里自己验证：改一个字节，输出就会变。</p>' +
      '</div>';

    root.innerHTML = h;
  }

  /* ------------------------------------------------------------ 小工具 */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ------------------------------------------------------------ 入口 */
  let current = null;

  /* hash 路由：#m22-1 进工作台，空则回收件箱。
     每次挂载都换一个全新的容器 —— 监听器随旧容器一起丢弃，
     否则在收件箱和工作台之间来回切会把 click 监听器叠成 N 份。 */
  function mount() {
    const root = document.getElementById('practice-root');
    if (!root) return;
    if (current && current.destroy) current.destroy();

    root.innerHTML = '';
    const view = document.createElement('div');
    view.className = 'pr-view';
    root.appendChild(view);

    const id = (global.location.hash || '').replace(/^#/, '');
    const m = id ? findMission(id) : null;
    if (m) {
      current = new Workbench(view, m);
      global.scrollTo(0, 0);
    } else {
      renderInbox(view);
      current = null;
    }
  }

  global.AKKC_PRACTICE = { mount: mount, Workbench: Workbench, renderInbox: renderInbox };

  /* 与 app.js 的 boot 用同一套 readyState 判断，保证顺序确定 */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  global.addEventListener('hashchange', mount);
})(window);
