/* 第 30 章数据 —— 逆向工作环境与关键代码定位 */
/* ---------------------------------------------------------------------------
   本章自带两个「真的会算」的引擎，都挂在 window.CH30X 上：
     ① 七条线索的成本-收益选型器（线索库 + 事实识别 + 打分排序）
     ② 调用栈判读器（帧解析 + 分层 + 业务边界/入口/代理帧定位 + 栈质量诊断）
   为什么挂在 window 而不是写顶层 const：同一台校验器沙箱里会连续装载几十章，
   顶层词法声明会跨章冲突（Identifier already declared）。挂全局对象最安全。
   --------------------------------------------------------------------------- */
window.CH30X = {

  /* ======================================================================
     一、七条线索的成本-收益模型
     成本 = 启动这条线索要付的代价（base + 情境修正，下限 1）
     收益 = 它能把搜索空间缩小到什么程度（gain，1–4，用证据强度近似）
     效益 = 收益 / 成本。排序先看效益，再看收益，再看成本，最后按固定序号。
     被情境「结构性排除」的线索（例如界面不是原生 View 树时的 UI 反推）直接置底。
     ====================================================================== */
  CLUES: [
    {
      id: 'str', no: 1, name: '字符串搜索', base: 1, gain: 1,
      note: '在 dex / so / 资源里搜明文：URL、错误提示、日志 TAG、算法常量、密钥前缀。',
      fail: '搜不到，通常意味着三件事之一：这段文字在运行时才被拼出来、它由服务端下发、或者代码里的原话和界面上看到的不是同一个词。',
      whyAny: ['明文', '常量', '字符串', '搜索', '关键字', '文案', '资源', 'strings.xml'],
      rules: [
        { f: 'literal', cost: -1, gain: 1, why: '手里有可以直接当搜索词的明文' },
        { f: 'uiText', cost: -1, why: '界面文字本身就是明文常量，通常落在 strings.xml 或布局里' },
        { f: 'serverText', cost: 3, gain: -1, why: '文案由服务端下发，本地根本没有这个常量' },
        { f: 'cipher', cost: 3, why: '你手上只有密文，密文在代码里不存在' },
        { f: 'packed', cost: 3, why: '加固/字符串加密之后，静态搜索命中率骤降' },
        { f: 'flutter', gain: 1, why: '界面不是原生 View 树，但 Dart 的字符串常量通常仍落在 AOT 快照里，字符串这条线并没有一起失效' }
      ]
    },
    {
      id: 'static', no: 2, name: '静态结构', base: 2, gain: 1,
      note: '从 manifest 的组件与权限、import 与类型引用、方法调用图、注解与泛型残留里找结构。',
      fail: '结构读不出来时，你要区分两件事：是「结构被壳拿走了」，还是「你看的结构层级不对」（Java 层调用链 vs so 的导入表）。',
      whyAny: ['静态', 'manifest', '组件', '权限', '调用图', '导入表', '交叉引用', '结构', '符号'],
      rules: [
        { f: 'manifest', cost: -1, gain: 1, why: 'manifest 是最便宜的一层结构信息，入口与权限都写在那里' },
        { f: 'jniReg', cost: -1, gain: 1, why: 'JNI 动态注册会留下一张名字与地址的对应表' },
        { f: 'native', cost: -1, gain: 1, why: 'native 侧有导入表和常量池，这是一张免费的地图，证据强度比 Java 层的名字更高' },
        { f: 'packed', cost: 1, why: '加固会打散 Java 层结构，静态阅读收益下降' },
        { f: 'stripped', cost: 1, why: '符号被剥离后，函数名这条线没了，要靠结构与交叉引用反推' }
      ]
    },
    {
      id: 'stack', no: 4, name: '调用栈', base: 2, gain: 1,
      note: '顺着调用链走：谁调用了谁、业务边界在哪一帧、栈上还能看到什么。',
      fail: '拿不到栈或栈被内联/混淆之后，你剩下的只有「第一个业务帧的类名」，而那个名字大概率是 a.a.a。',
      whyAny: ['调用栈', '栈', '帧', '调用链', '业务边界', 'backtrace', '谁调用了'],
      rules: [
        { f: 'crash', cost: -1, gain: 2, why: '崩溃日志直接给出了事发帧，这是最便宜的栈' },
        { f: 'cipher', gain: 1, why: '有已知的输入输出当锚点，顺序回溯能一路收敛' },
        { f: 'native', cost: 1, why: 'native 栈要自己 unwind，没有 Java 栈那么规整' },
        { f: 'stripped', cost: 1, why: '符号被剥离后，栈上的地址需要额外映射回模块' },
        { f: 'hookReady', cost: -1, gain: 1, why: '有注入能力就能在关键点直接打栈' }
      ]
    },
    {
      id: 'ui', no: 5, name: 'UI 组件反推', base: 2, gain: 1,
      note: '从界面元素反查 Activity / 布局 / 资源 id，再从资源 id 反查绑定函数。',
      fail: '反推失效时你会发现：界面不是原生 View 树（Flutter/自绘/游戏引擎），控件根本没有 resource-id 这个东西。',
      whyAny: ['界面', '控件', '资源 id', '布局', 'activity', 'uiautomator', '反推', 'onClick'],
      rules: [
        { f: 'uiText', cost: -1, gain: 1, why: '原生界面上每一个控件都能被 dump 出资源 id' },
        { f: 'packed', cost: 1, why: '加固一般不动布局，但会让人怀疑资源 id 还能不能对上代码' },
        { f: 'flutter', blocked: true, why: '界面不是原生 View 树，控件没有 resource-id，这一条从根上不成立' }
      ]
    },
    {
      id: 'log', no: 7, name: '日志线索', base: 2, gain: 1,
      note: 'logcat / 崩溃栈 / 框架日志 / 自己的插入日志，把「发生过什么」变成可读记录。',
      fail: '日志被加固清掉、或关键字全被改成无意义 TAG 时，你至少还能拿到「进程在什么时刻做了什么」这一层信息。',
      whyAny: ['日志', 'logcat', 'tag', '打印', '崩溃日志', '输出'],
      rules: [
        { f: 'logLine', cost: -1, gain: 1, why: '已经有日志线索，等于已经有一个入口' },
        { f: 'crash', cost: -1, gain: 1, why: '崩溃栈本身就是一份日志' },
        { f: 'packed', cost: 2, why: '加固/反调试常顺手清理或伪造日志' }
      ]
    },
    {
      id: 'trace', no: 6, name: 'Profiling / Trace', base: 4, gain: 1,
      note: '采样或插桩执行流：按钮点下去之后，到底有哪些方法被调用过。',
      fail: '采样会丢方法（太短、太深、被内联），拿到的是「可能相关的候选集」，不是证据链；它需要和别的线索交叉验证。',
      whyAny: ['profiling', 'trace', '采样', '执行流', '插桩', 'stalker', 'method tracing'],
      rules: [
        { f: 'uiText', gain: 1, why: '有一个明确的用户操作当起点，采样的范围可以被压得很小' },
        { f: 'packed', cost: 1, why: '加固与反调试常把这类采集变成噪音' },
        { f: 'noroot', cost: 2, why: '多数采样手段要注入或重编译，没有 root 就很贵' },
        { f: 'hookReady', cost: -1, gain: 1, why: '有注入能力就能按需开 trace' }
      ]
    },
    {
      id: 'debug', no: 3, name: '动态调试', base: 4, gain: 1,
      note: 'Smali 断点 / IDA attach so：让程序停在你想看的那一行，看寄存器、内存、参数。',
      fail: '挂不上调试器时先分清两类原因：环境没配对（debuggable/JDWP/权限），还是对方主动检测并退出。两者处理方式完全不同。',
      whyAny: ['动态调试', '断点', '调试器', 'ida', 'jdb', '单步', '寄存器', 'attach'],
      rules: [
        { f: 'literal', cost: -1, why: '有明确的观察对象时，一个断点就能顶掉大量猜测' },
        { f: 'cipher', cost: -1, gain: 1, why: '密文是天然的内存锚点，断在那里比什么都直接' },
        { f: 'stripped', cost: -1, why: '没有符号时，动态观察比静态阅读省力' },
        { f: 'native', gain: 1, why: '算法沉到 native 之后，寄存器与内存是唯一的第一手现场' },
        { f: 'noroot', cost: 3, why: '没有 root、又不能重打包时，注入与调试基本没有落脚点' },
        { f: 'hookReady', cost: -1, gain: 1, why: '环境已经就绪，只剩选点问题' }
      ]
    }
  ],

  /* 事实识别：把一段自然语言情境翻译成事实集合。
     这是「真实规则判定」的入口——同一段文字，谁的规则都能算出同一个结果。 */
  FACTS: [
    { id: 'literal', re: /文字|文案|提示|报错|错误信息|字符串|日志行/, label: '有明文文本可以直接当搜索词' },
    { id: 'uiText', re: /按钮|界面|页面|控件|图标|弹窗|列表|布局|点击/, label: '有原生界面元素（控件/资源）' },
    { id: 'serverText', re: /服务端|服务器|后端|下发|接口返回|远程/, label: '文本来自服务端' },
    { id: 'cipher', re: /密文|加密参数|\bhex\b|\bsign\b|签名串|报文|响应的\s*body|抓到的包/i, label: '手上只有一个密文/加密参数' },
    { id: 'crash', re: /崩溃|闪退|\bcrash\b|堆栈|调用栈|tombstone|\banr\b/i, label: '有崩溃栈可用' },
    { id: 'logLine', re: /logcat|日志|打印/i, label: '有日志线索' },
    { id: 'native', re: /native|\bso\b|\bjni\b|\bndk\b/i, label: '目标在 native/so 里' },
    { id: 'stripped', re: /strip|剥离|去符号|无符号|符号被删|符号没了|混淆/i, label: '符号被剥离或混淆' },
    { id: 'packed', re: /加固|加壳|\b壳\b|\bvmp\b|ollvm/i, label: '目标被加固' },
    { id: 'flutter', re: /flutter|dart|自绘|非原生|游戏引擎/i, label: '界面不是原生 View 树' },
    { id: 'noroot', re: /没\s*root|无\s*root|不能\s*root|未\s*root|没有\s*root/i, label: '设备没有 root' },
    { id: 'hookReady', re: /hook\s*环境已就绪|已经能\s*hook|hook\s*环境就绪|能挂\s*hook|有注入能力|注入能力/, label: 'Hook 环境已就绪' },
    { id: 'jniReg', re: /动态注册|registernatives/i, label: '存在 JNI 动态注册' },
    { id: 'manifest', re: /manifest|组件|权限|入口\s*activity/i, label: '有 manifest/组件线索' }
  ],

  detect: function (text) {
    const t = String(text || '');
    const hits = [];
    (this.FACTS || []).forEach(function (f) {
      if (f.re.test(t)) hits.push(f.id);
    });
    return hits;
  },

  factLabels: function (ids) {
    const self = this;
    return (ids || []).map(function (id) {
      const hit = self.FACTS.filter(function (x) { return x.id === id; })[0];
      return hit ? hit.label : id;
    });
  },

  score: function (facts) {
    const set = {};
    (facts || []).forEach(function (f) { set[f] = true; });
    const out = this.CLUES.map(function (c) {
      let cost = c.base, gain = c.gain, blocked = false;
      const why = [];
      (c.rules || []).forEach(function (r) {
        if (!set[r.f]) return;
        if (r.cost) cost += r.cost;
        if (r.gain) gain += r.gain;
        if (r.blocked) blocked = true;
        if (r.why) why.push(r.why);
      });
      cost = Math.max(1, cost);
      gain = Math.max(1, Math.min(4, gain));
      return {
        id: c.id, no: c.no, name: c.name,
        cost: cost, gain: gain,
        eff: blocked ? 0 : Math.round(gain / cost * 100) / 100,
        blocked: blocked, why: why,
        note: c.note, fail: c.fail, whyAny: c.whyAny
      };
    });
    out.sort(function (a, b) {
      if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
      if (b.eff !== a.eff) return b.eff - a.eff;
      if (b.gain !== a.gain) return b.gain - a.gain;
      if (a.cost !== b.cost) return a.cost - b.cost;
      return a.no - b.no;
    });
    return out;
  },

  matchClue: function (s) {
    const t = String(s || '').trim();
    if (!t) return null;
    const self = this;
    const num = /^[1-7]$/.exec(t);
    if (num) {
      const hit = self.CLUES.filter(function (x) { return x.no === parseInt(num[0], 10); })[0];
      if (hit) return hit.id;
    }
    let found = null;
    self.CLUES.forEach(function (c) {
      if (found) return;
      if (t === c.id || t.indexOf(c.name) >= 0) found = c.id;
      else if (window.AKKC_hasConcept && window.AKKC_hasConcept(t, c.whyAny)) found = c.id;
    });
    return found;
  },

  /* 把排序结果渲染成一张可读的表 */
  rankHtml: function (ranked, factIds) {
    const labels = this.factLabels(factIds);
    let h = '';
    if (!labels.length) {
      h += '<div class="lab-msg warn"><b>没有识别到任何已知特征</b><br>' +
           '<span class="lab-note">情境描述里至少要包含一个可判定的事实，比如「有崩溃日志」「只有密文」「界面是 Flutter」。' +
           '你可以把界面上看到的、手上拿到的东西直接写进去。</span></div>';
    } else {
      h += '<div class="lab-msg key"><b>识别到的事实（' + labels.length + ' 项）</b><div class="lab-note">' +
           labels.map(function (x) { return '<span class="pill acc">' + x + '</span>'; }).join(' ') +
           '</div></div>';
    }
    h += '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
         '<th>优先</th><th>线索</th><th>启动成本</th><th>收益</th><th>效益</th><th>算出来的依据</th></tr></thead><tbody>';
    ranked.forEach(function (c, i) {
      const blocked = c.blocked ? '<span class="pill bad">结构性排除</span> ' : '';
      h += '<tr><td>' + (c.blocked ? '—' : (i + 1)) + '</td>' +
           '<td>' + blocked + '<b>' + c.no + '. ' + c.name + '</b></td>' +
           '<td class="center">' + c.cost + '</td>' +
           '<td class="center">' + c.gain + '</td>' +
           '<td class="center">' + (c.blocked ? '0' : c.eff) + '</td>' +
           '<td>' + (c.why.length ? c.why.join('；') : '<span class="muted">本情境没有额外修正，取基准值</span>') + '</td></tr>';
    });
    h += '</tbody></table></div>';
    const top = ranked.filter(function (c) { return !c.blocked; })[0];
    if (top) {
      const second = ranked.filter(function (c) { return !c.blocked; })[1];
      h += '<div class="lab-msg pass"><b>首选：' + top.no + '. ' + top.name + '</b>' +
           '<div class="lab-note">' + top.note + '</div>' +
           (second ? '<div class="lab-note">排第二的是 <b>' + second.no + '. ' + second.name +
             '</b>（效益 ' + second.eff + '）。首选失败时，第二条就是你的下一个动作，而不是从头乱试。</div>' : '') +
           '<div class="lab-note"><b>首选失败时你能得到什么：</b>' + top.fail + '</div></div>';
    }
    return h;
  },

  /* ======================================================================
     二、调用栈判读器
     帧解析 → 分层（系统/框架 · 业务 · 代理/合成） → 三个坐标：
       业务边界：从栈顶往下第一帧业务代码（离事发点最近的那一帧）
       进入入口：从栈底往上第一帧业务代码（系统框架第一次把控制权交给 App）
       代理帧：真正的无业务语义帧（反射 / 合成 lambda / 动态代理）
     再算一份「栈质量诊断」：无行号比例、单字母名、重复帧 → 判断栈是否退化。
     ====================================================================== */
  SYS_RE: /^(java\.|javax\.|android\.|androidx\.|com\.android\.|dalvik\.|libcore\.|sun\.|kotlin\.|kotlinx\.)/,
  WRAP_RE: /(\$\$ExternalSyntheticLambda|ExternalSyntheticLambda|\$\$Lambda\$|\$Proxy|GeneratedMethodAccessor|MethodAccessor|(^|\.)reflect\.|Lambda\$)/,
  SYS_SO_RE: /^(libc|libm|libdl|libart|libandroid|libbinder|libutils|liblog|libnativehelper|libc\+\+_shared|libcutils|libhwui|libgui)\.so$/,

  parseStack: function (text) {
    const lines = String(text || '').split(/\r?\n/);
    const frames = [];
    lines.forEach(function (line) {
      const s = String(line).replace(/\t/g, ' ').trim();
      if (!s) return;
      let m = /^at\s+([\w$.]+)\.([\w$<>]+)\(([^)]*)\)/.exec(s);
      if (m) {
        frames.push({ kind: 'java', raw: s, cls: m[1], method: m[2], loc: m[3], mod: '' });
        return;
      }
      m = /^#?(\d+)?\s*pc\s+([0-9a-fA-F]+)\s+(\S+)/.exec(s);
      if (m) {
        const path = m[3];
        frames.push({ kind: 'native', raw: s, cls: '', method: '', loc: m[2], mod: path.split('/').pop() || path });
        return;
      }
      m = /^(0x[0-9a-fA-F]+)\s+(\S+?\.so)(?:!|\+)(0x[0-9a-fA-F]+)?/.exec(s);
      if (m) {
        frames.push({ kind: 'native', raw: s, cls: '', method: '', loc: m[3] || '0x?', mod: m[2].split('/').pop() });
        return;
      }
      frames.push({ kind: 'header', raw: s, cls: '', method: '', loc: '', mod: '' });
    });
    return frames;
  },

  classify: function (fr) {
    if (fr.kind === 'native') {
      const mod = fr.mod || '';
      if (this.SYS_SO_RE.test(mod)) return 'system';
      if (/libapp\.so|libflutter\.so/.test(mod)) return 'app';
      return 'app';
    }
    if (this.SYS_RE.test(fr.cls) && !this.WRAP_RE.test(fr.cls)) return 'system';
    if (this.WRAP_RE.test(fr.cls) || this.WRAP_RE.test(fr.method || '')) return 'wrapper';
    return 'app';
  },

  judgeStack: function (frames) {
    const self = this;
    const numbered = [];
    (frames || []).forEach(function (f) {
      if (f.kind !== 'java' && f.kind !== 'native') return;
      const copy = {
        kind: f.kind, raw: f.raw, cls: f.cls, method: f.method, loc: f.loc, mod: f.mod,
        idx: numbered.length + 1
      };
      copy.layer = self.classify(copy);
      copy.name = copy.kind === 'native' ? (copy.mod || 'native') : (copy.cls + '.' + copy.method);
      numbered.push(copy);
    });

    const counts = { app: 0, system: 0, wrapper: 0 };
    numbered.forEach(function (f) { counts[f.layer]++; });

    let boundary = null, proxy = null, nearBoundary = null, entry = null;
    for (let i = 0; i < numbered.length; i++) {
      if (numbered[i].layer === 'app') { boundary = numbered[i]; break; }
    }
    for (let i = numbered.length - 1; i >= 0; i--) {
      if (numbered[i].layer === 'app') { entry = numbered[i]; break; }
    }
    for (let i = 0; i < numbered.length; i++) {
      if (numbered[i].layer === 'wrapper') { proxy = numbered[i]; break; }
    }
    if (boundary) {
      for (let i = boundary.idx - 2; i >= 0; i--) {
        if (numbered[i].layer !== 'app') { nearBoundary = numbered[i]; break; }
      }
    }

    let noLine = 0, shortName = 0;
    const seen = {};
    let dup = 0;
    numbered.forEach(function (f) {
      const loc = String(f.loc || '');
      if (/Native Method|Unknown Source|^SourceFile/.test(loc)) noLine++;
      if (f.kind === 'java') {
        const seg = f.cls.split('.').pop() || '';
        if (seg.length <= 2 || String(f.method || '').length <= 1) shortName++;
      }
      const key = f.name;
      if (seen[key]) dup++;
      seen[key] = true;
    });
    const total = numbered.length || 1;
    const reasons = [];
    if (noLine / total >= 0.5) reasons.push('超过一半的帧没有行号（Native Method / Unknown Source / SourceFile）');
    if (shortName >= 2) reasons.push('出现多个单字母类名或方法名，说明名字已被混淆');
    if (dup > 0) reasons.push('有 ' + dup + ' 处同名帧重复出现，调用链被折叠或递归展开');
    if (counts.app === 0) reasons.push('整条栈里没有任何业务帧，几乎全部是系统与框架');
    const degraded = reasons.length > 0;

    return {
      numbered: numbered, counts: counts,
      boundary: boundary, entry: entry, proxy: proxy, nearBoundary: nearBoundary,
      dup: dup, noLineRatio: Math.round(noLine / total * 100) / 100,
      reasons: reasons, degraded: degraded
    };
  },

  framesHtml: function (j) {
    if (!j.numbered.length) {
      return '<div class="lab-msg warn"><b>没有解析出任何栈帧</b><div class="lab-note">' +
             '把崩溃日志或 backtrace 原样粘进来即可：Java 帧要形如 <span class="mono">at com.a.B.c(B.java:12)</span>，' +
             'native 帧要形如 <span class="mono">#00 pc 00000000001a4c10 /data/app/.../libtarget.so</span>。' +
             '异常名那一行会被忽略，它不算帧。</div></div>';
    }
    let h = '<div class="lab-msg key"><b>解析结果：共 ' + j.numbered.length + ' 帧</b>' +
            '<div class="lab-note">帧号按解析顺序排列（异常名那一行不计入）。' +
            '左列只给出<b>语法层</b>能看到的东西——它属于哪一层，要你自己判断。</div></div>' +
            '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
            '<th>#</th><th>帧</th><th>模块 / 类</th><th>位置</th><th>语法特征</th></tr></thead><tbody>';
    j.numbered.forEach(function (f) {
      const flags = [];
      if (/Native Method/.test(String(f.loc))) flags.push('<span class="pill warn">native 方法</span>');
      if (/Unknown Source|^SourceFile/.test(String(f.loc))) flags.push('<span class="pill warn">无行号</span>');
      if (j.dup && j.numbered.filter(function (x) { return x.name === f.name; }).length > 1) {
        flags.push('<span class="pill warn">同名帧</span>');
      }
      h += '<tr><td class="center">' + f.idx + '</td>' +
           '<td class="mono small">' + f.name + '</td>' +
           '<td class="mono small">' + (f.kind === 'native' ? (f.mod || '—') : f.cls.split('.').slice(0, 3).join('.')) + '</td>' +
           '<td class="mono small">' + f.loc + '</td>' +
           '<td>' + (flags.length ? flags.join(' ') : '<span class="muted">—</span>') + '</td></tr>';
    });
    h += '</tbody></table></div>';
    h += '<div class="lab-msg ' + (j.degraded ? 'fail' : 'pass') + '"><b>栈质量诊断：' +
         (j.degraded ? '这条栈已经退化了' : '这条栈信息量正常') + '</b>' +
         '<div class="lab-note">业务帧 ' + j.counts.app + ' 帧 / 系统与框架 ' + j.counts.system +
         ' 帧 / 代理与合成 ' + j.counts.wrapper + ' 帧；无行号帧占比 ' + Math.round(j.noLineRatio * 100) + '%。</div>' +
         (j.reasons.length ? '<div class="lab-note">' + j.reasons.map(function (r) { return '· ' + r; }).join('<br>') + '</div>'
                           : '<div class="lab-note">行号齐全、名字完整、没有重复帧——可以放心按三个坐标去读。</div>') +
         '</div>';
    return h;
  },

  judgeHtml: function (j) {
    if (!j.numbered.length) return '';
    const f = function (x) { return x ? ('#' + x.idx + ' <span class="mono small">' + x.name + '</span>') : '<span class="muted">（这条栈里没有）</span>'; };
    let h = '<div class="lab-msg model"><b>三个坐标</b><ul style="margin:8px 0 0 18px">' +
            '<li><b>业务边界</b>（从栈顶往下第一帧业务代码）：' + f(j.boundary) + '</li>' +
            '<li><b>进入入口</b>（从栈底往上第一帧业务代码）：' + f(j.entry) + '</li>' +
            '<li><b>无业务语义的代理/合成帧</b>：' + f(j.proxy) + '</li>' +
            '<li><b>紧贴业务边界之上的框架帧</b>：' + f(j.nearBoundary) + '</li>' +
            '</ul></div>';
    if (j.boundary && /Native Method/.test(String(j.boundary.loc))) {
      h += '<div class="lab-note"><b>注意这一帧的形态：</b>' + j.boundary.name +
           ' 标着 <span class="mono">(Native Method)</span>。它同时是「业务边界」和「Java→native 的交接点」——' +
           '再往里一步就不在 Java 栈上了，你需要的是 so 里的地址（转到 IDA / backtrace）。</div>';
    }
    return h;
  },

  /* 两段真实形状的栈：A 是信息完整的，B 是退化之后的对照组 */
  DEMO_A: [
    'java.lang.IllegalStateException: sign verify failed (code=4031)',
    '    at com.target.pay.CryptoBridge.nativeSign(Native Method)',
    '    at com.target.pay.SignProxy.invoke(SignProxy.java:37)',
    '    at java.lang.reflect.Method.invoke(Native Method)',
    '    at com.target.pay.PayActivity.doPay(PayActivity.java:203)',
    '    at com.target.pay.PayActivity$2.onClick(PayActivity.java:88)',
    '    at android.view.View.performClick(View.java:7792)',
    '    at android.os.Handler.handleCallback(Handler.java:942)',
    '    at android.os.Looper.loop(Looper.java:274)',
    '    at android.app.ActivityThread.main(ActivityThread.java:8456)'
  ].join('\n'),

  DEMO_B: [
    'java.lang.RuntimeException: decrypt failed',
    '    at com.target.a.a.a(Native Method)',
    '    at com.target.a.a.b(SourceFile:2)',
    '    at com.target.a.a.a(SourceFile:1)',
    '    at android.os.Handler.handleCallback(Handler.java:942)'
  ].join('\n')
};

window.CHAPTER = {
  no: 30,
  title: '逆向工作环境与关键代码定位',
  lede: '前面二十多章把方法散在各处：环境怎么配、代码怎么找、栈怎么读，都是顺带讲的。' +
        '这一章把它们收成一套可以照着走的流程——<strong>先把环境搭起来，再用七条线索去定位关键代码</strong>。' +
        '本章的立场很明确：<strong>环境是成本，定位是收益</strong>；每一次投入都应该换来一个更小的搜索空间。',
  meta: [
    '核心问题：<b>在 hook 之前，你怎么知道该 hook 哪里？</b>',
    '关键机制：<b>环境依赖链 / 七条线索的成本-收益 / 调用栈三坐标</b>',
    '对手：<b>加固、反调试、混淆，以及你自己的时间</b>'
  ],

  sections: [
    /* ============================================================ 30.1 */
    {
      h: '30.1', title: '先要一张地图：五块拼图，以及它们之间的依赖',
      intuition: {
        tag: '直觉模型 · 装修一间工作室',
        body:
          '<p>把逆向环境想成装修一间工作室。设备是房子，root 是电闸，抓包证书是门禁卡，' +
          'Hook 框架是墙上那排插座，调试器是那台能随时暂停画面的监视器。</p>' +
          '<p>关键不在清单，在<b>依赖</b>：没有电闸，插座和门禁都装不上；' +
          '但没有监视器，你照样能进屋干活，只是慢。</p>' +
          '<p>所以「环境没配好」从来不是一个是非题，而是一句<b>程度描述</b>：' +
          '你缺的是哪一块，它让你的哪一类观测手段直接失效。这就是本章第一节要给的地图。</p>'
      },
      html:
        T.note('key', '🔑 先把判断立在这里',
          '<p style="margin-bottom:0">配环境的目的不是「把网上教程的清单打勾」，而是<b>买到观测能力</b>。' +
          '买不到 root，你就买不到系统证书库；买不到注入，你就买不到运行时参数。' +
          '所以每一步都要问一句：<b>这一步失败，我会失去哪种观测？</b>——失去的那种观测，就是我接下来必须绕着走的地方。</p>') +
        '<p>下面是本章的骨架地图。先看它，再看后面的细节：</p>' +
        T.tbl(
          ['拼图', '它解决什么问题', '不装它，你会失去什么', '它依赖谁'],
          [
            ['<b>① 设备</b>（真机 / 模拟器）',
             '让目标 App 真实跑起来，并决定它「看到的环境」长什么样',
             '什么都做不了；或者被环境的差异误导（模拟器特征、隐藏 API 差异）',
             '——（这是底座）'],
            ['<b>② root 能力</b>',
             '读写系统分区、向别的进程注入、把证书放进系统信任库',
             '只能走「改 APK 重打包」这条更重、更容易被完整性校验抓到的路',
             '设备的 bootloader 可解锁（真机），或模拟器自带（模拟器）'],
            ['<b>③ 抓包证书</b>',
             '让你的中间人证书被目标接受，从「只有 CONNECT」变成「能看内容」',
             'HTTPS 的正文全部看不见，只剩域名与连接时序',
             '<b>依赖 ②</b>（走系统库路线时）；不依赖 root 的替代方案是重打包'],
            ['<b>④ Hook 框架</b>',
             '在运行时改行为、看参数、打调用栈',
             '只能静态读代码；参数、密钥、随机数都只能靠推理',
             '<b>依赖 ②</b>（frida-server 形态）；gadget 形态依赖重打包'],
            ['<b>⑤ 调试器</b>',
             '断点、单步、看寄存器与内存（唯一的第一手现场）',
             '只能靠打印与猜测；native 算法基本没法读',
             '目标可调试（JDWP 可达 / debuggable）；<b>不依赖 root</b>'],
            ['<b>⑥ 观测层</b>（logcat / Profiling / trace）',
             '把「发生过什么」变成可读记录，把偶发变成可复现',
             '每次都要重新触发，且无法做时间维度的对比',
             '几乎不依赖别的东西——这也是它总该被先试的原因']
          ]) +
        T.note('warn', '⚠️ 这张表的读法：不是「先做①再做②」的流水线',
          '<p style="margin-bottom:0">它是<b>依赖图</b>，不是<b>工序表</b>。' +
          '上表最后一列才是顺序信息；中间那列才是价值信息。<br>' +
          '很多人的时间浪费在「按教程从第 1 步做到第 7 步」，而正确做法是：' +
          '<b>先确定这次任务需要哪种观测，再只配那一块。</b>抓一个 HTTP 接口不需要 Hook 框架；' +
          '读一个 native 算法不需要抓包证书。</p>') +
        T.note('key', '📐 与其它章的分工（本章不重复讲原理）',
          '<p style="margin-bottom:0">' +
          '<b>Frida 的注入原理与脚本写法</b> → 第 1 章；' +
          '<b>Frida 的特征与对抗、改名换端口、maps 过滤</b> → 第 10 章；' +
          '<b>objection / r0capture / r0tracer / ModuleMap</b> → 第 21 章；' +
          '<b>LSPosed 的注入链路与模块开发</b> → 第 22 章；' +
          '<b>HTTPS、Android 7 的信任变化、抓包安装与诊断</b> → 第 23 章；' +
          '<b>Magisk systemless 与启动链路</b> → 第 18 章。<br>' +
          '本章只做两件事：<b>把「怎么搭起来」和「每步失败长什么样」说明白</b>，' +
          '以及<b>把散在各章的定位方法收成七条线索</b>。</p>'),
      stage: {
        title: '环境总览 · 五块拼图与依赖链',
        speed: 1900,
        render:
          '<div class="flow-col" style="gap:9px">' +
            '<div class="flow-row"><span class="pill mono">底座</span>' +
              '<span class="blk" id="blk-dev">① 设备：真机 / 模拟器</span>' +
              '<span class="muted small">决定「App 看到的世界」</span></div>' +
            '<div class="flow-row" style="margin-left:22px"><span class="arrow">↓ 真机需解锁 bootloader</span></div>' +
            '<div class="flow-row"><span class="pill mono">能力</span>' +
              '<span class="blk" id="blk-root">② root（Magisk systemless）</span>' +
              '<span class="muted small">系统分区 / 注入 / 信任库</span></div>' +
            '<div class="flow-row" style="margin-left:22px"><span class="arrow">↓ 有 root 才能做这两件事</span></div>' +
            '<div class="flow-row"><span class="pill mono">观测</span>' +
              '<span class="blk" id="blk-cert">③ 抓包证书进系统库</span>' +
              '<span class="blk" id="blk-hook">④ Hook 框架（按需 / 常驻）</span></div>' +
            '<div class="flow-row" style="margin-left:22px"><span class="arrow">↓ 与上面两条并列，不依赖 root</span></div>' +
            '<div class="flow-row"><span class="pill mono">现场</span>' +
              '<span class="blk" id="blk-dbg">⑤ 调试器（JDWP / IDA attach）</span></div>' +
            '<div class="flow-row" style="margin-left:22px"><span class="arrow">↓ 所有动作最终都落到这一层</span></div>' +
            '<div class="flow-row"><span class="pill mono">记录</span>' +
              '<span class="blk" id="blk-ob">⑥ 观测层：logcat / Profiling / trace</span></div>' +
            '<div class="flow-row" style="margin-top:6px;padding-top:10px;border-top:1px dashed var(--line)">' +
              '<span class="pill bad" id="mark">🎯 缺哪一块，就等于少了一种观测</span></div>' +
            '<div class="note" id="diag"><div class="note-h">缺口诊断</div>' +
              '<p style="margin-bottom:0">点「播放」，逐块点亮，并看清每一块缺了之后你会失去什么。</p></div>' +
          '</div>',
        reset: () => {
          ['blk-dev', 'blk-root', 'blk-cert', 'blk-hook', 'blk-dbg', 'blk-ob'].forEach(i => S(i, ''));
          CLS('mark', 'pill bad');
          SET('mark', '🎯 缺哪一块，就等于少了一种观测');
          SET('diag', '<div class="note-h">缺口诊断</div><p style="margin-bottom:0">点「播放」，逐块点亮，并看清每一块缺了之后你会失去什么。</p>');
        },
        steps: [
          { run: () => S('blk-dev', 'active'),
            note: '<b>① 设备：一切的底座。</b>真机与模拟器的差别不在性能，在<b>「它让 App 看到什么」</b>：' +
                  '属性、传感器、指令特征、缺失的内核启动痕迹，全都是可检测的差异（第 15、16 章）。' +
                  '<span class="hit">选设备的真正判据是：这台机器像不像一台真实的手机。</span>' },
          { run: () => { S('blk-dev', 'done'); S('blk-root', 'active'); },
            note: '<b>② root：买到「系统级权限」这一大类观测。</b>它的三种用途分别是：' +
                  '读写系统分区（装证书、换配置）、向别的进程注入（Hook）、' +
                  '以及观测别的进程（读别人的 maps / 内存）。<br>' +
                  '<span class="miss">代价在三十章之前就该知道：解锁 bootloader 会清数据、可能熔断、影响保修。</span>' },
          { run: () => { S('blk-root', 'done'); S('blk-cert', 'active');
                         SET('diag', '<div class="note-h">缺口诊断 · 没有 root</div><p>装系统证书这条路直接断掉。你剩下两个选择：<b>重打包 APK</b>（把信任用户证书的声明写进 manifest），或者<b>让抓包工具走别的观测面</b>（socket / SSL 层 hook，第 21、23 章）。<br><b>先想清楚你能否接受重打包的代价</b>：签名变了，完整性校验、第三方 SDK 校验、升级都会受影响。</p>'); },
            note: '<b>③ 抓包证书：依赖 root 的那一半。</b>Android 7 之后用户证书默认不被 App 信任，' +
                  '所以「把证书塞进系统库」成了标准动作（第 23 章有完整原理与安装步骤）。<br>' +
                  '<b>这里只记一句：</b>没 root 不等于抓不到包，只是路线从「装证书」变成「改 APK 声明」。' },
          { run: () => { S('blk-cert', 'done'); S('blk-hook', 'active');
                         SET('diag', '<div class="note-h">缺口诊断 · 有 root，但不想常驻</div><p>这正是 <b>frida-server（按需注入）</b>与 <b>LSPosed（常驻）</b>的分界线：前者每次开工都要重建现场，后者装好就一直生效。<b>取舍一句话：按需注入适合一次性深挖，常驻适合长期值守与批量观测。</b>细节在第 21、22 章。</p>'); },
            note: '<b>④ Hook 框架：两种形态。</b>frida-server 是独立进程 + 你主动连接（按需注入）；' +
                  'LSPosed 挂在 Zygote 上，每个 App 进程一出生就带着模块（常驻）。<br>' +
                  '<span class="hit">它们的部署差异会直接改变你的工作节奏，而不只是改变检测面。</span>' },
          { run: () => { S('blk-hook', 'done'); S('blk-dbg', 'active');
                         SET('diag', '<div class="note-h">缺口诊断 · 调试器挂不上</div><p>先分清两类原因：<b>环境没配对</b>（没开 USB 调试、目标不是 debuggable、JDWP 没转发到），还是<b>对方检测到调试器并主动退出</b>。<br>前者是配置问题，五分钟能修；后者是设计好的对抗，要靠抢时序或换观测面。<b>把它当成同一类问题处理，就是浪费一下午的开始。</b></p>'); },
            note: '<b>⑤ 调试器：唯一能看到「现场」的东西。</b>寄存器、内存、栈上的局部变量，' +
                  '这些东西在 hook 里都只能猜。而它<b>不依赖 root</b>——依赖的是目标可调试。<br>' +
                  '所以「没 root」从来不是放弃动态调试的理由；「目标不是 debuggable」才是。' },
          { run: () => { S('blk-dbg', 'done'); S('blk-ob', 'active');
                         SET('mark', 'pill warn'); SET('mark', '⚠️ 五块都亮了——现在的问题变成「先付哪一笔成本」'); },
            note: '<b>⑥ 观测层：所有动作的最终产物。</b>logcat、Method Profiling、指令级 trace——' +
                  '它们把「我看到了」变成「我能拿着它对比」。<br>' +
                  '<span class="hit">这一层是唯一「几乎零依赖」的层：不 root、不注入、不改包，也可能拿到关键线索。</span>' +
                  '所以它在下一节的七条线索里排得很靠前。' },
          { run: () => { CLS('mark', 'pill ok'); SET('mark', '✅ 地图建好了：现在开始逐块谈代价');
                         SET('diag', '<div class="note-h">地图的用法</div><p style="margin-bottom:0">拿到一个任务，先问：<b>这次我需要哪种观测？</b>需要看明文 → ③；需要看参数 → ④；需要看寄存器 → ⑤；需要看「谁调用了谁」 → ⑥。<br>然后只配那一块。<b>配环境应该由任务驱动，而不是由教程驱动。</b></p>'); },
            note: '<b>收尾：把地图变成配额。</b>真实项目里时间有限，你不可能每次都把五块配齐。' +
                  '所以每次开工前花两分钟做一次「观测需求 → 拼图」的映射，比盲目折腾环境划算得多。<br>' +
                  '<b>下一节开始逐块讲代价：root、证书、Hook 环境、DEBUG 环境。</b>' }
        ]
      },
      quiz: {
        id: 'q30-1', chapter: 30, answer: 2,
        stem: '你接到的任务是：<b>把一个 App 里「本地计算出来的签名参数」还原来</b>，' +
              '而这个计算发生在 so 里。设备是一台已经 root 的测试机，但抓包证书还没装。' +
              '按本章的「观测需求 → 拼图」思路，<b>最该先配的是哪一块？</b>',
        options: [
          { t: '先把抓包证书装进系统库——没有抓包就没有输入输出，什么都做不了',
            why: '抓包能把请求和响应拿到，但它回答不了「这个签名是怎么算出来的」。目标是本地计算，观测点应该在计算发生的地方，而不是网络边界。证书这件事对你的任务不是瓶颈。' },
          { t: '先把调试环境配好（am start -D / JDWP），因为调试器不依赖 root，看起来最省事',
            why: '调试器确实是这五块里唯一不依赖 root 的，但它解决的是「停在哪一行」。你连函数在哪都还没定位，此时配调试器没有观察对象——它会在七条线索的后半段才真正值钱。' },
          { t: '先确认 Hook 环境可用（能注入、能拿到 so 的基址与符号信息），因为参数与寄存器信息只能从运行时拿',
            why: '正确。目标在 so 里做本地计算，这类任务的核心观测是「运行时参数、内存、寄存器」。有了注入能力，你才有资格去谈字符串搜索、调用栈、Profiling 这些线索；证书与调试器都可以等。' },
          { t: '五块一起配齐最稳妥，缺一块都会在某个环节卡住',
            why: '「全配齐」听起来稳妥，实际是把成本乘以五。本章反复强调的判据是：环境的每一块都要对应一个具体的观测需求，没有需求的那一块就是纯支出。' }
        ],
        explain: '<b>这道题考的是「由观测需求反推环境」，而不是背清单。</b><br>' +
                 '任务的关键信息有两条：<b>① 计算发生在 so 里</b>（本地计算，不走网络）；' +
                 '<b>② 你要还原的是参数</b>（要的是输入输出与中间状态）。<br>' +
                 '能同时满足这两条的只有运行时注入这一类能力，对应拼图 ④（以及它依赖的 ②）。' +
                 '抓包证书服务于网络观测，调试器服务于「停下来看」——它们都是好工具，但都不是这个任务的第一笔支出。<br>' +
                 '<span class="hit">环境配置没有标准答案，只有「针对这次任务的最优支出」。</span>'
      },
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">你拿到了一张依赖图，并且知道了它的正确读法：' +
        '<b>「缺哪一块」等于「少哪种观测」</b>，而不是「没按顺序做」。<br>' +
        '接下来三节把 root、证书、Hook 与 DEBUG 环境逐个讲清——只讲代价与失败现象，principle 全部指回对应的章节。</p>')
    },

    /* ============================================================ 30.2 */
    {
      h: '30.2', title: '真机 root：先算代价，再动手，而且 root 本身就是信号',
      html:
        '<p>先说结论：<b>root 是本章所有能力里唯一一笔「不可逆」的支出</b>。' +
        '别的东西配错了可以重来，解锁 bootloader 带来的后果往往跟着这台机器一辈子。' +
        '所以这一节把代价放在最前面。</p>' +
        T.tbl(
          ['代价', '具体表现', '为什么不可逆 / 难逆转'],
          [
            ['<b>清空用户数据</b>', '解锁那一步会触发一次全盘擦除（相当于恢复出厂）',
             '这是安全设计，不是可以绕过的步骤：解锁的前提就是「证明这台机器的主人愿意放弃数据」'],
            ['<b>熔断（部分机型）</b>', '某些安全特性一旦解锁就永久失效，之后即使刷回官方系统也不会恢复',
             '实现方式通常写死在硬件/安全启动链的存储位上，属于「一次性」标记'],
            ['<b>保修与售后</b>', '不少厂商把解锁状态当作拒保依据；有些机型会改开机提示',
             '厂商策略，随机型与地区变化 —— 这一条<b>必须按你自己的机型了解当期政策</b>'],
            ['<b>部分 App 直接拒绝运行</b>', '风控、支付、金融、部分游戏会在 root 环境里拒绝启动或降级功能',
             '这正是本节后半段要讲的：<b>root 自己就是一个可被观测的特征</b>'],
            ['<b>系统更新变麻烦</b>', 'OTA 通常需要先恢复原状；跨版本升级常常要重新走一遍流程',
             'root 方案与系统版本强耦合（第 12 章讲过 ART 结构逐版本变化，同一件事在不同版本代价不同）']
          ]) +
        T.note('key', '🔑 systemless：Magisk 的关键词，但原理不在这里讲',
          '<p>Magisk 的核心思路是 <b>systemless（不碰系统分区）</b>：把定制内容放在一个被挂载/覆盖上去的层里，' +
          '系统分区本身保持「和官方一模一样」。这样做的收益有三条：</p>' +
          '<ul>' +
          '<li><b>OTA 与完整性校验更容易过</b>——系统分区的镜像没被改过。</li>' +
          '<li><b>卸载干净</b>——移除覆盖层，系统回到出厂状态，不像改分区那样留下永久修改。</li>' +
          '<li><b>模块化</b>——证书、Hook 模块都以「模块」的形式叠加上去，彼此独立、可分别开关。</li>' +
          '</ul>' +
          '<p style="margin-bottom:0">它具体怎么改 ramdisk、怎么实现挂载覆盖、Zygisk 又插在哪一层，' +
          '<b>第 18 章讲得很细，本节不复述</b>。这里只需要记住一个推论：' +
          '<span class="hit">因为它是「挂载层」的定制，所以它的痕迹也是「挂载层」的痕迹</span>——' +
          '这正是部分风控会去读 mount 信息的原因。</p>') +
        '<h4>root 之后：能做什么，不能做什么</h4>' +
        T.grid(2, [
          T.card('✅ root 能给你的',
            '<ul>' +
            '<li>把证书放进<b>系统信任库</b>（或用模块把证书库替换掉）</li>' +
            '<li>向目标进程<b>注入</b>（frida-server / gadget / 内核模块）</li>' +
            '<li>读别的进程的 <span class="mono">/proc/&lt;pid&gt;/maps</span>、内存、fd</li>' +
            '<li>改系统属性、换 hosts、装系统级 App</li>' +
            '<li>用<b>内核态</b>的手段观测（第 11、13 章的 eBPF / 内核模块路线）</li>' +
            '</ul>'),
          T.card('❌ root 不能给你的',
            '<ul>' +
            '<li>它<b>不能让你看懂代码</b>——root 只是权限，不是理解</li>' +
            '<li>它<b>不能让反调试失效</b>：TracerPid、调试标志、时序检测与 root 无关</li>' +
            '<li>它<b>不能绕过服务端风控</b>：设备指纹、行为模型都在服务端</li>' +
            '<li>它<b>不能隐藏自己</b>：root 的存在本身就是一组可读特征（见下）</li>' +
            '<li>它<b>不能替代静态分析</b>：很多结论仍然要从代码结构里读出来</li>' +
            '</ul>')
        ]) +
        T.note('warn', '⚠️ 风控视角：root 是一次「自我举报」',
          '<p>站在检测方的角度，一个 root 设备会同时给出下面这些信号（它们互相独立，但都指向同一件事）：</p>' +
          '<ul>' +
          '<li><b>su 可执行文件与它的调用痕迹</b>——最经典的一条。</li>' +
          '<li><b>挂载信息异常</b>：systemless 的覆盖层会在 mount 表里留下与官方不同的条目。</li>' +
          '<li><b>系统分区校验失败</b>：部分完整性校验会去比对分区内容或 dm-verity 状态。</li>' +
          '<li><b>属性与文件系统痕迹</b>：Magisk 相关目录、属性、App 包名。</li>' +
          '<li><b>可注入性本身</b>：能注入意味着任何人都能改这个进程的行为——这才是风控真正在意的东西。</li>' +
          '</ul>' +
          '<p style="margin-bottom:0"><span class="hit">所以「root 之后如何不被发现」是个独立课题</span>，' +
          '它的主战场不在本章（第 10、13、18、21 章分别从 Frida 特征、内核绕过、容器环境、去特征四个角度讲）。' +
          '本章的立场是：<b>先把 root 当成一笔明码标价的支出，再决定这次任务值不值得付。</b></p>') +
        T.note('warn', '📌 版本与命令的时效性',
          '<p style="margin-bottom:0">解锁 bootloader、修补镜像、刷入、验证 root 这一整套动作，' +
          '<b>命令名、分区名、参数名在厂商之间、在 Android 大版本之间都不统一</b>' +
          '（例如 Android 13 之后出现了 init_boot 分区，修补对象随之变化）。<br>' +
          '本节下面终端里出现的命令是<b>形状示意</b>，都标了 <span class="pill warn">待核实</span>——' +
          '<b>一律以你的机型的官方说明与工具当期文档为准</b>，不要照抄。</p>'),
      term: {
        title: 'root 判定链：从解锁到「确认真的拿到了 root」',
        lines: [
          { t: 'd', s: '# 判定链共四段：设备可见 → 进入可刷写模式 → 完成解锁 → 验证权限真的到手' },
          { t: 'p', s: 'adb devices',
            note: '先确认设备对主机可见。<b>这一步失败就是驱动 / 授权 / 线材问题</b>，与 root 无关——' +
                  '但它是后面所有步骤的前提，所以永远从它开始。' },
          { t: 'o', s: 'List of devices attached\n0A1B2C3D4E    device',
            note: '看到 <span class="mono">device</span> 才算通。若是 <span class="mono">unauthorized</span>，' +
                  '去设备上确认「允许 USB 调试」弹窗；若是 <span class="mono">offline</span>，先重启 adb 服务。' },
          { t: 'p', s: 'adb reboot bootloader',
            note: '进入 bootloader / fastboot 模式。' +
                  '<span class="pill warn">待核实</span>：不同厂商进入方式不同（按键组合、专用工具、甚至需要在系统设置里先打开某个开关），' +
                  '以机型说明为准。' },
          { t: 'p', s: 'fastboot devices',
            note: '确认此时主机能看到处于可刷写模式的设备。<b>看不到就停在这里</b>，' +
                  '不要往下试解锁命令——那只会让你以为是「解锁被拒绝」。' },
          { t: 'p', s: 'fastboot flashing unlock   （或 fastboot oem unlock）',
            note: '<span class="pill warn">待核实</span>：<b>这条命令的名字是最不该照抄的东西。</b>' +
                  '不同厂商、不同年代用的是不同的子命令；有的机型还要先在系统里做一次「允许解锁」。<br>' +
                  '<b>真正需要你带走的判断是：执行它之前，先确认「这台机器的数据可以被清空」。</b>' },
          { t: 'o', s: '(bootloader) Start unlock flow\nOKAY [  0.032s]',
            note: '看到解锁流程启动。<b>接下来设备通常会自动清空数据并重启</b>——' +
                  '这一步没有回头路（想恢复锁定状态一般还要再走一次同样的擦除）。' },
          { t: 'e', s: 'FAILED (remote: Flashing Unlock is not allowed)',
            note: '<b>这是最常见的一种「此路不通」。</b>含义是：这台设备在服务端/固件层就没有开放解锁。' +
                  '通常是运营商定制机、部分企业机型或特定地区版本。<br>' +
                  '<span class="hit">它给出的信息很有价值：你不需要再折腾工具链了，换设备是唯一解。</span>' },
          { t: 'p', s: '(重启进系统 → 用 Magisk 修补官方 boot / init_boot 镜像 → 刷回该分区)',
            note: '这一段是「形状」，不是步骤清单。<b>细节全部省略的理由是它随版本变化太快</b>：' +
                  '修补对象（boot 还是 init_boot）、刷入方式（fastboot 还是 recovery 还是专用工具）' +
                  '都取决于机型与系统版本。<span class="pill warn">待核实</span>——以官方安装说明为准。<br>' +
                  '第 18 章讲过 systemless 的原理，这里只要知道：<b>你改的是「被挂载的镜像」，不是系统分区本身。</b>' },
          { t: 'p', s: 'adb shell "su -c id"',
            note: '<b>唯一有效的验证方式：让 su 真的执行一条命令，看它返回什么身份。</b>' +
                  '不要用「Magisk App 里显示已安装」当证据——那只证明模块装上了，不证明你的 shell 能拿到 root。' },
          { t: 'o', s: 'uid=0(root) gid=0(root)',
            note: '看到 <span class="mono">uid=0</span> 才算真的通了。' +
                  '如果这里报 <span class="mono">permission denied</span> 或 <span class="mono">not found</span>，' +
                  '说明 root 授权没准备好（授权弹窗没点、或权限没给到这个 App）。' },
          { t: 'w', s: '⚠️ 到这一步，任务刚刚开始：你同时也变成了一台「可被判定为 root 的设备」',
            note: '<b>把这句话记住。</b>验证成功的同一秒钟，你在风控眼里也从一个普通设备变成了高风险管理对象。' +
                  '接下来决定要不要做隐藏、隐藏到什么程度，取决于你的目标 App；' +
                  '而那部分内容属于第 10、13、21 章。<b>本节只负责让你知道：这笔账在配环境时就已经记上了。</b>' }
        ]
      },
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">root 的代价清单、systemless 的收益与痕迹、' +
        '以及「root 本身就是信号」这个立场。<br>' +
        '更重要的是终端里那条判定链：<b>每一步的失败都能被翻译成一句明确的话</b>——' +
        '看不清设备、进不了刷写模式、解锁被服务端拒绝、su 拿不到身份。它们对应完全不同的处理，不会互相混淆。</p>')
    },

    /* ============================================================ 30.3 */
    {
      h: '30.3', title: '抓包证书：Android 7 那道线，三种过线方式与各自的代价',
      html:
        '<p>抓包这件事的原理在第 23 章：HTTPS 握手、信任链、证书固定、五道门的对抗分层。' +
        '本节只回答一个问题：<b>要让一个 App 接受你的中间人证书，有哪几条路，各要付什么代价。</b></p>' +
        T.note('key', '🔑 那道线的准确表述',
          '<p style="margin-bottom:0">从 Android 7.0 开始，<b>App 默认不再信任用户安装的 CA</b>，' +
          '只信任系统信任库里的证书（除非 App 自己显式声明信任用户 CA）。<br>' +
          '所以「浏览器能抓、App 抓不到」这个现象有一个非常朴素、也非常确定的解释：' +
          '<b>你的证书只在用户库里，而 App 按默认策略不去看用户库。</b><br>' +
          '这条线的完整来龙去脉与判定顺序在第 23.7 与 23.8，<b>本节不重复</b>。</p>') +
        '<h4>三种过线方式：不是「哪个更好」，而是「你更怕哪种代价」</h4>' +
        T.tbl(
          ['做法', '它做了什么', '代价与适用边界', '什么时候它是对的'],
          [
            ['<b>A. 改系统分区，把证书放进系统信任库</b>',
             '把证书按系统库要求的命名放进系统证书目录，让 App 的默认策略直接命中',
             '<b>系统分区通常只读</b>：要重新挂载，而现代设备上挂载常被分区只读、验证启动、动态分区挡住；' +
             '改过的分区会让完整性校验更容易出问题；系统升级后可能被覆盖。<br>' +
             '<span class="pill warn">待核实</span>：证书目录位置与命名规则随版本变化（新版证书库在 Conscrypt 模块内），以目标机实际目录为准',
             '老设备、可写系统的模拟器、或者你只是临时试一下'],
            ['<b>B. 用 Magisk 模块把证书（或证书库）叠加上去</b>',
             '不改系统分区，用 systemless 的覆盖层让系统「看到」多了一张证书',
             '<b>依赖 root</b>，而且依赖这个模块与你的系统版本兼容；' +
             '挂载层本身会留下痕迹（上一节刚讲过）；证书库被替换后要留意它与系统更新的关系。<br>' +
             '这是当前<b>最通用的路线</b>，代价是「你必须先有一台能 root 的机器」',
             '真机 + 已 root + 需要长期、稳定地抓多个 App'],
            ['<b>C. 重打包 APK，声明信任用户证书</b>',
             '在 manifest 里加上信任用户 CA 的网络配置，然后把包重签回来',
             '<b>不需要 root</b>，但代价在别处：签名变了 → 完整性校验、第三方 SDK 校验、' +
             '与官方包共存的升级链路都可能出问题；加固包的修改本身也困难。' +
             '换句话说：<b>你用一个「改客户端」的代价，换掉了「拿 root」的代价</b>',
             '没有 root、又只针对这一个 App 做一次性分析'],
            ['<b>D. 根本不走代理这条路</b>（对照项）',
             '在 socket / SSL 层 hook，直接取明文',
             '不是「装证书」，而是绕开整个证书信任问题；代价是要自己处理明文边界与字节流（第 21、23 章）',
             'App 自带网络栈、或证书路线被 pinning 彻底堵死时']
          ]) +
        T.note('warn', '⚠️ 一条纪律：先确认「证书这一层通了没有」，再去怀疑别的',
          '<p>「装了证书还是抓不到」这句话里藏着三个完全不同的状态，必须先把它们分开：</p>' +
          '<ol>' +
          '<li><b>证书根本没进系统库</b>——文件在，但位置/命名/格式不对。' +
          '典型现象：一个 App 都抓不到、浏览器能抓。</li>' +
          '<li><b>证书进了，但目标不认</b>——固定校验（pinning）或双向认证。' +
          '典型现象：其它 App 能抓到明文，这个 App 只有 CONNECT。' +
          '<b>注意：这恰好证明了你的证书这一层是通的。</b></li>' +
          '<li><b>证书通了，但内容仍然不可读</b>——握手成功、headers 正常、body 是密文。' +
          '这不是证书问题，是应用层自己又加密了一层。</li>' +
          '</ol>' +
          '<p style="margin-bottom:0"><span class="hit">「别的 App 能抓到明文」这一条信息，' +
          '价值高于任何配置检查</span>——它一次性证明代理、证书、网络三层都没问题，' +
          '把范围直接压到「目标 App 自己这一侧」。这就是第 23.8 那张诊断表的用法。</p>'),
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一 · 证书装上了，只有部分接口抓不到',
            scenario: '<b>情境：</b>你已经把抓包工具的根证书装进了系统信任库（并且验证过：<b>其它 App、包括系统浏览器，都能抓到完整明文</b>）。' +
                      '现在打开目标 App，操作了一遍：<b>首页的列表接口、登录接口都抓到了完整 JSON</b>，' +
                      '但那个「支付前算签名」的接口，抓包工具里只有一条 <span class="mono">CONNECT</span>，之后什么都没有。' +
                      '<span class="small muted">（补充：这个 App 没有被加固的迹象，反编译出来能看到正常的业务类。）</span>',
            q: '这一现象属于哪一类问题，你下一步最该做什么？',
            choices: [
              { t: 'A. 说明证书没装好——重新装一遍，或者换一个抓包工具再试', next: 'na' },
              { t: 'B. 先对「抓到的」和「抓不到的」做分层取证：看失败请求是「没有 CONNECT」「有 CONNECT 无内容」还是「有内容但 body 是密文」，再按对应的层级处理', next: 'nb' },
              { t: 'C. 直接判定它做了 SSL Pinning，写一个绕过脚本挂上去', next: 'nc' },
              { t: 'D. 判定这个 App 有反抓包能力（检测代理就断网），开始做反检测对抗', next: 'nd' }
            ]
          },
          na: {
            label: '选 A', terminal: true, verdict: 'bad',
            verdictTitle: '「部分成功」恰恰证明证书这一层是通的',
            result: '<b>认知根源：把「有东西抓不到」自动归因到最熟悉的那一步上。</b><br>' +
                    '证书信任是<b>按进程、按默认策略</b>生效的，它不会「对首页接口有效、对支付接口无效」。' +
                    '既然同一个 App 的其它接口抓到了完整明文，那这个 App 的 TLS 栈、你的证书、代理链路，' +
                    '<b>三者全部成立</b>。<br>' +
                    '把「部分失败」当成「证书没装好」，代价是你会花时间在一个已经被证明没问题的环节上反复折腾，' +
                    '而真正的差异（某条请求走了另一条代码路径）始终没被看见。<br>' +
                    '<span class="hit">判据要记牢：能抓到一部分，就说明基础链路没问题；问题一定在「那条请求本身」。</span>' },
          nb: {
            label: '选 B', terminal: true, verdict: 'good',
            verdictTitle: '正确：先分清失败发生在哪一层',
            result: '<b>这是唯一能把范围收敛的做法。</b>对那条抓不到的请求，按顺序看三件事：<br>' +
                    '<b>① 抓包工具里有没有 CONNECT？</b><br>' +
                    '· 没有 → 这条请求<b>没走系统代理</b>。可能它自己实现了网络栈、设了 ' +
                    '<span class="mono">Proxy.NO_PROXY</span>、走的是原生 socket，或者根本不是 HTTP 类请求（例如 WebSocket、UDP/QUIC）。<br>' +
                    '<b>② 有 CONNECT，但没有后续数据？</b><br>' +
                    '· 失败点在 <b>TLS 校验</b>：这一条连接被客户端拒绝了。注意它<b>可能只对某个域名/某个连接生效</b>，' +
                    '所以完全可以是「首页没事、支付被拒」——这正是 pinning 的典型形态。<br>' +
                    '<b>③ 有内容，但 body 是密文？</b><br>' +
                    '· 传输层没问题，<b>应用层自己又加密了一层</b>。此时你要找的是加密函数，而不是证书。<br>' +
                    '<b>为什么这个顺序最有效：</b>它把「一个模糊的失败」拆成三个互斥的层级，' +
                    '每一层对应一套有限的手段。第 23.8 与 23.12 分别是这套诊断与后续溯源的完整展开。' },
          nc: {
            label: '选 C', terminal: true, verdict: 'bad',
            verdictTitle: '方向可能是对的，但你现在还缺一个证据',
            result: '<b>认知根源：把「最可能的解释」直接当成「已确认的结论」。</b><br>' +
                    'Pinning 确实是「部分接口抓不到」的常见原因之一，而且它天然可以是「按域名/按连接」生效的——' +
                    '所以你的猜测并不离谱。<br>' +
                    '问题在于：<b>同样的现象还有另外两种成因</b>（走了非代理路径、或 body 另有加密），' +
                    '而它们要用的手段完全不同。<br>' +
                    '直接写 bypass 脚本的风险是：你会得到一个「脚本挂了但没生效」或「脚本生效了但仍然看不懂」的状态，' +
                    '而这两种状态都<b>不会告诉你方向对不对</b>。<br>' +
                    '<span class="hit">先花三十秒看 CONNECT，再决定要不要写脚本。</span>' +
                    '判据一旦拿到（有 CONNECT 无内容），C 就从猜测变成了一个明确动作。' },
          nd: {
            label: '选 D', terminal: true, verdict: 'bad',
            verdictTitle: '用一个高级解释覆盖了还没做的取证',
            result: '<b>认知根源：把「对抗」当成了第一解释。</b><br>' +
                    '真正的反抓包（检测代理、检测 VPN、拒绝走系统代理）有一个很硬的判据：' +
                    '<b>它表现为「一条都没有」，而且往往在很早的阶段就断掉</b>——' +
                    '因为检测到就干脆不发请求，或者立刻切到直连。<br>' +
                    '而现在你手上是「大部分接口正常、个别接口异常」，这个形态与「检测到代理」不符：' +
                    '检测是有状态的，它不会只对某一个接口生效。<br>' +
                    '<b>另一层代价：</b>反检测对抗是会改变环境的（改属性、hook 检测点、换 ROM），' +
                    '一旦你在没有结论的情况下改动环境，后面所有观测的<b>可信度都会下降</b>——' +
                    '你不再确定某个现象是 App 的行为，还是你改动造成的。<br>' +
                    '<span class="small muted">补充：这个 App 没有被加固的迹象，' +
                    '这进一步降低了「它有一套复杂的自研反抓包」的可能性——加固与风控通常是一起上的。</span>' }
        }
      },
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">三种过线方式的代价对照（改分区 / systemless 模块 / 重打包），' +
        '以及最重要的那一条纪律：<b>先把「证书没通」「证书通了但目标不认」「证书通了但内容加密」</b>三件事分开。<br>' +
        '这三件事对应三个完全不同的下一步，混在一起处理就是时间黑洞。</p>')
    },
    /* ============================================================ 30.4 */
    {
      h: '30.4', title: 'Hook 环境：两种形态的取舍，以及「怎么算真的就绪」',
      html:
        '<p>Hook 框架在 Android 上有两种主流形态，它们不是「新旧关系」，而是<b>两种工作节奏</b>：</p>' +
        T.tbl(
          ['', '<b>frida-server（按需注入）</b>', '<b>LSPosed（常驻）</b>'],
          [
            ['<b>进程模型</b>', '一个独立进程，你主动连上去、主动注入目标', '挂在 Zygote 上，每个 App 进程一出生就带着模块'],
            ['<b>生效时机</b>', '由你决定：spawn 抢跑，或 attach 事后进场', '由系统决定：比 App 的第一行 Java 还早，你只能选作用域'],
            ['<b>持久性</b>', '会话级。重启、断连就要重建现场', '装好就一直生效，重启仍在'],
            ['<b>能力上限</b>', '运行时能力更强：Stalker 指令级 trace、完整调用栈、动态构造参数', '受 ART hook 接口限制，拿不到指令级执行流'],
            ['<b>迭代成本</b>', '改脚本即可，代价是每次都要重新连接', '改模块要重装，但改完对所有目标 App 生效'],
            ['<b>暴露面</b>', '进程侧：注入线程、agent 映射、端口、被改写的函数头（第 10、21 章）', '环境侧：Zygote 注入链路、模块 so、Zygisk 痕迹（第 22 章）']
          ]) +
        T.note('key', '🔑 取舍一句话（细节全部在第 21、22 章）',
          '<p style="margin-bottom:0"><b>按需注入（Frida）适合一次性深挖：需要运行时能力、需要抢时序、需要临时改主意；' +
          '常驻（LSPosed）适合长期值守：装一次、每次启动自动生效、批量覆盖所有进程。</b><br>' +
          '选错形态的典型症状是「效果差一点」变成「形态上不成立」：' +
          '想让它无人值守自动生效，Frida 就得每次重建现场；想要 Stalker 级 trace，LSPosed 的接口根本提供不了。<br>' +
          '<b>至于怎么把 frida-server 推上去、改名、换端口、怎么装 LSPosed 模块 —— 分别是第 10.9、21.11 与第 22.2 的内容，本节不复述。</b></p>') +
        T.note('warn', '⚠️ 一个反直觉的经验：环境「就绪」不能靠「脚本没报错」来判断',
          '<p style="margin-bottom:0">Frida 脚本最常见的两种「假成功」：<br>' +
          '<b>① 注入成功但没进目标进程</b>——脚本在，目标其实是另一个进程（多进程 App、插件化、被拉起的新进程）。<br>' +
          '<b>② hook 挂上了但代码路径没走到</b>——hook 点选得太深（在某个未被执行的条件分支里），或者目标方法被内联。' +
          '此时你的控制台一片安静，而你会误以为「这个函数没被调用」。<br>' +
          '所以下面这个步进器的重点不是命令，而是<b>每一步的判据</b>：<span class="hit">你要能说出「凭什么认为这一步成立了」。</span></p>'),
      stepper: {
        title: '环境就绪判定链：从「能连上」到「hook 真的生效」',
        lines: [
          { code: '<span class="c"># 0. 先选形态：按需，还是常驻？</span>\n' +
                  '一次性深挖 → frida-server ；长期值守 → LSPosed',
            note: '<b>这一步之后所有命令都不同，所以它必须排在第一位。</b>' +
                  '判据：你能不能接受「每次开工都要重建现场」。不能接受就选常驻；' +
                  '但如果任务需要 Stalker 级执行流，那没得选——只能按需注入。',
            state: { '任务形态': '一次性深挖', '选择': 'frida-server', '理由': '需要运行时改主意 + 指令级 trace' } },
          { code: '<span class="c"># 1. 设备可达</span>\n' +
                  'adb devices → device',
            note: '<b>判据：设备状态是 <span class="mono">device</span>。</b>' +
                  '这一步失败与 Hook 无关，但它会让后面每一步都表现为「莫名其妙地失败」。' +
                  '把它单独列出来，是为了让失败有唯一的解释。',
            state: { 'adb': 'device', '结论': '底座可用' } },
          { code: '<span class="c"># 2. 注入能力存在（不要自证，要反证）</span>\n' +
                  'hook 一个「必然会被调用」的函数，看它是否命中\n' +
                  '<span class="c">// 例如目标进程自己会打的某条日志、或 Activity 的 onCreate</span>',
            note: '<b>这是本节最重要的一步：用一个必然命中的点做探针。</b><br>' +
                  '为什么要反证：如果一上来就 hook 你的目标函数，<b>「没命中」有两种含义</b>' +
                  '（注入没成功 / 函数没被调用），你分不出来。<br>' +
                  '探针命中 → 注入链路成立；探针不命中 → 问题在环境，与你的目标无关。' +
                  '<span class="hit">这一步把「注入问题」和「选点问题」彻底分开了。</span>',
            state: { '探针': '命中', '结论': '注入链路成立', '排除': '环境问题' } },
          { code: '<span class="c"># 3. 确认脚本真的在「那个」进程里</span>\n' +
                  '打印当前进程名 / pid，与目标进程核对',
            note: '<b>判据：脚本报告的进程名与 pid，就是你想要的那个。</b><br>' +
                  '多进程 App（例如独立推送进程、独立 WebView 进程）里，attach 错了进程是很常见的事，' +
                  '表现和「hook 不生效」一模一样。',
            state: { '进程': 'com.target.app', 'pid': '12345', '结论': '目标进程正确' } },
          { code: '<span class="c"># 4. 确认 hook 点真的被执行（而不是挂上了）</span>\n' +
                  'hook 里加计数器 + 打印参数；重复触发三次操作',
            note: '<b>判据：计数器随操作增长。</b>这是「挂上了」与「被执行了」的分界线。<br>' +
                  '如果挂上却没有计数，按顺序怀疑三件事：' +
                  '<b>① 代码路径没走到</b>（换一个更靠外的调用点试试）；' +
                  '<b>② 方法被内联</b>（编译器把函数体展开，调用点根本不存在）；' +
                  '<b>③ 你 hook 的是同名的另一个重载/另一个类加载器里的类</b>。',
            state: { '计数器': '0 → 3', '结论': 'hook 点有效' } },
          { code: '<span class="c"># 5. 先记录基线，再开始改行为</span>\n' +
                  '原样跑一遍，把「输入 → 输出」存下来',
            note: '<b>判据：你手上有一份未修改状态下的输入输出对照。</b><br>' +
                  '这一步经常被跳过，代价在后面：当你改了行为、绕过某个校验之后，' +
                  '你再也无法回答「这个结果是我改出来的，还是它本来就这样」。' +
                  '<span class="hit">基线是后面所有结论的参照系。</span>',
            state: { '基线': '已保存', '结论': '可以开始干预' } },
          { code: '<span class="c"># 6. 环境自检通过，但别忘了它的代价</span>\n' +
                  '<span class="c">// 你现在同时拥有：观测能力 与 被观测的特征</span>',
            note: '<b>最后一步不是技术动作，是记账。</b>' +
                  '注入能力给你观测，同时也给检测方证据（第 10 章的八个检测点、第 21 章的六层暴露面）。' +
                  '所以「环境就绪」这句话的完整版是：<b>我已经能看了，并且我知道我现在有多显眼。</b>',
            state: { '观测能力': '✅', '暴露面': '已知（第 10 / 21 章）' } }
        ]
      },
      quiz: {
        id: 'q30-2', chapter: 30, answer: 1,
        stem: '你的任务是「连续两周，每天盯着一个 App 在启动时读了哪些文件」，' +
              '并要求<strong>它每次自动启动都被记录下来，不需要你手动连上去</strong>。' +
              '设备已 root，两种 Hook 形态都装得上。选哪一个，理由是什么？',
        options: [
          { t: 'frida-server：它更灵活，随时可以改脚本重新观察',
            why: '灵活是真的，但「每天自动记录、不用手动连」这个需求指向的是「常驻」这个形态本身。用按需注入去做无人值守，是实现层面的硬伤，不是效果差一点。' },
          { t: 'LSPosed：需求的关键词是「长期 + 自动生效」，这正是常驻形态的定义',
            why: '正确。常驻模块在进程一出生就在场，不需要你维持一个会话，天然满足「每次自动启动都被记录」。代价是改逻辑要重装模块，但在这个需求里它完全不是瓶颈。' },
          { t: '两个都装：Frida 负责写逻辑，LSPosed 负责常驻，互相配合',
            why: '同时上两套注入链路会让暴露面叠加一倍，而收益（把脚本塞进常驻形态）用 LSPosed 单独就能拿到。多一套链路只会让「出了问题是谁造成的」变得难以判断。' },
          { t: '取决于目标是否检测：它检测就用 LSPosed，不检测就用 Frida',
            why: '这条判据本身没错（常驻方案的暴露面在环境侧，按需在进程侧），但「检测」是你两周之后才会知道的事。在需求是「长期自动」的前提下，先用需求定形态，再处理检测，顺序不能反。' }
        ],
        explain: '<b>先按需求定形态，再按检测调策略。</b><br>' +
                 '需求里有三个关键词：<b>长期</b>（两周）、<b>自动</b>（不手动连）、<b>批量</b>（每次启动）。' +
                 '这三条全都指向常驻形态。frida-server 的能力上限更高（Stalker、完整调用栈），' +
                 '但这个任务并不需要那些能力——它需要的是「一直在场」。<br>' +
                 '<span class="hit">环境选型的第一判据永远是任务形态，而不是工具强弱。</span>'
      },
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">两种 Hook 形态的取舍判据，以及六步「就绪判定链」——' +
        '其中最值钱的是第 2 步：<b>用一个必然命中的探针，把「注入问题」与「选点问题」分开</b>。<br>' +
        '这条纪律会在后面每一步复用：任何一次「hook 没反应」，先问它是哪一类失败。</p>')
    },

    /* ============================================================ 30.5 */
    {
      h: '30.5', title: 'DEBUG 环境：debuggable 的两个层次，以及为什么它会被检测',
      html:
        '<p>调试环境这一块，概念上只有四个东西，但它们是四种完全不同的「权限来源」：</p>' +
        T.tbl(
          ['概念', '它是什么', '谁决定它', '它意味着什么'],
          [
            ['<b>开发者选项 + USB 调试</b>',
             '设备侧的开关，允许 adb 与调试协议接入',
             '你在设备上手动打开',
             '只是「允许调试协议进来」，<b>并不等于 App 可以被断点</b>'],
            ['<b><span class="mono">android:debuggable</span></b>',
             '<b>每个 App 自己</b>在 manifest 里的标志位',
             '构建方（debug 构建为 true，release 一般为 false）',
             '这一条是「这个 App 能不能被 JDWP 附加」的关键。<b>它是 per-app 的。</b>'],
            ['<b><span class="mono">ro.debuggable</span></b>',
             '<b>系统级</b>属性，表示这台设备的系统镜像本身是 debuggable 构建',
             'ROM / 系统镜像的构建方（工程机、部分模拟器为 1）',
             '<b>它是 per-device 的</b>。系统 debuggable 时，很多进程的可调试性会被整体放宽'],
            ['<b>JDWP</b>',
             'Java 调试线协议：调试器与被调试 JVM/ART 之间的通信通道',
             '由运行时提供，通过一个调试控制接口暴露',
             '它是「断点」这条路的实际承载者；<b>能不能连上它，是调试环境是否就绪的唯一判据</b>']
          ]) +
        T.note('key', '🔑 两个 debuggable 的分工，一定要分清',
          '<p style="margin-bottom:0"><b><span class="mono">android:debuggable</span> 是应用级开关，' +
          '<span class="mono">ro.debuggable</span> 是系统级属性。</b><br>' +
          '「我打开了 USB 调试，为什么断点打不上」——大概率是你把设备开关当成了应用开关。' +
          'USB 调试打开的是<b>通道</b>，而<b>门</b>在 App 自己的 debuggable 标志上。<br>' +
          '反过来，系统 <span class="mono">ro.debuggable=1</span> 的设备（工程机、部分模拟器）会放宽整体策略，' +
          '所以「同一份 APK 在我这里能调、在你那里不能调」是很常见的事——<b>差异来自设备，不来自 APK。</b></p>') +
        '<h4>把调试器「请进门」的两个动作</h4>' +
        T.grid(2, [
          T.card('① <span class="mono">am start -D</span>：让 Activity 停在起跑线上',
            '<p>这个参数的作用是<b>让目标组件启动后先暂停、等待调试器挂上</b>，而不是直接跑完。</p>' +
            '<p>它的价值在于<b>时序</b>：很多初始化逻辑（注册、解密、自检）发生得极早，' +
            '你事后 attach 只能看到结果。先让它等，你才有机会在第一条指令前就把断点摆好。</p>' +
            '<p class="muted small">具体参数形态与等待行为随版本变化，' +
            '<span class="pill warn">待核实</span>：以 adb 当期文档为准。</p>'),
          T.card('② <span class="mono">adb forward</span> 与 JDWP：把通道接到主机上',
            '<p>可调试进程会暴露一个调试控制接口，主机的调试器要访问它，' +
            '就要用端口转发把它接到本地。</p>' +
            '<p>常见形态是「查询目标进程的调试接口编号 → 把某个本地端口转发到它」。</p>' +
            '<p class="muted small">接口编号通常由系统分配、不是固定值；<b>端口号与查询方式都随版本变化</b>，' +
            '<span class="pill warn">待核实</span>：照抄网上的固定端口是常见的第一个坑。</p>')
        ]) +
        T.note('warn', '⚠️ 为什么很多 App 会主动检测这些',
          '<p style="margin-bottom:0">站在检测方的角度，「被调试」与「被 hook」是同一类风险：' +
          '<b>有人在运行时看我的内部状态</b>。而调试留下的痕迹比 Hook 更集中、更容易判定：</p>' +
          '<ul>' +
          '<li><b>被追踪标记</b>：进程的追踪者字段非空（被 ptrace 附加的通用痕迹）。</li>' +
          '<li><b>调试接口存在</b>：可调试进程会暴露 JDWP 通道，扫一遍就能发现。</li>' +
          '<li><b>调试相关线程 / 握手行为</b>：附加之后进程里会多出调试相关的线程与通信。</li>' +
          '<li><b>耗时特征</b>：断点会让某段代码的执行时间出现人类不可能产生的量级。</li>' +
          '</ul>' +
          '<p style="margin-bottom:0"><span class="hit">这些判据的共同点是：它们不关心你用什么工具，只关心「有没有人在旁边看」。</span>' +
          '所以第 10 章讲的<b>抢时序</b>思路在这里同样成立——' +
          '检测代码本身也要被执行，谁先动手谁说了算。具体对抗手段见第 10、13 章，本节不重复。</p>'),
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境二 · 一挂调试器就退出',
            scenario: '<b>情境：</b>你按流程用 <span class="mono">am start -D</span> 让目标停住，' +
                      '主机的调试器也连上了那个 JDWP 通道。' +
                      '<b>结果：只要一附加，App 就在一两秒内退出</b>，logcat 里只留下一句与本任务无关的空指针异常，' +
                      '看起来像是「启动失败」。不附加调试器时，App 一切正常。<br>' +
                      '<span class="small muted">（你手上还有：静态反编译出来的代码、一份能跑通的抓包环境、' +
                      '以及一台已 root 的测试机。）</span>',
            q: '下一步最合理的是：',
            choices: [
              { t: 'A. 先取证：确认它是「检测到调试就退出」，还是「被调试之后自己跑崩了」。用不改调试标志的方式观察它读了什么、退在哪一步', next: 'na' },
              { t: 'B. 放弃动态调试，回去做静态分析——反正静态也能看逻辑', next: 'nb' },
              { t: 'C. 直接上反调试绕过脚本：把常见的检测函数（ptrace、调试标志检查、JDWP 探测）通通 hook 掉', next: 'nc' },
              { t: 'D. 换一台设备或换一个模拟器重试，可能是这个环境不兼容', next: 'nd' }
            ]
          },
          na: {
            label: '选 A', terminal: true, verdict: 'good',
            verdictTitle: '正确：先分清「它检测到了」还是「它被调试搞崩了」',
            result: '<b>这个区分决定了后面所有工作的方向。</b>两种成因的表现完全不同：<br>' +
                    '<b>① 主动检测后退出：</b>退出是<b>有意图的</b>——通常伴随一条被清理过的假异常、' +
                    '或在退出前有一段可疑的耗时（它在做判断）。此时正确的动作是<b>抢时序</b>：' +
                    '把观测点提前到它的检测代码之前（spawn 类手段、启动早期注入），' +
                    '而不是在退出之后研究现场。<br>' +
                    '<b>② 被调试拖崩：</b>退出是<b>副作用</b>——目标逻辑对时序/线程状态敏感，' +
                    '断点一停，超时、锁等待、看门狗就把进程带走了。此时要换的是调试方式：' +
                    '改用日志或 hook 打点（不暂停线程），或只在内核/驱动之外做被动观测。<br>' +
                    '<b>为什么「取证」排在「绕过」之前：</b>绕过脚本是有副作用的（它改变目标行为），' +
                    '一旦挂上去，你就再也分不清「它退出了」是因为检测、还是因为你的脚本。' +
                    '<span class="hit">在拿到「它到底检测了什么」之前动手，等于亲手污染了现场。</span>' },
          nb: {
            label: '选 B', terminal: true, verdict: 'bad',
            verdictTitle: '放弃得太早了——而且你是放弃了一整类观测',
            result: '<b>认知根源：把「这一次调试失败」当成了「调试这条路不通」。</b><br>' +
                    '调试器是本章五块拼图里<b>唯一能给你第一手现场</b>的东西（寄存器、内存、局部变量）。' +
                    '在还没确认失败原因的情况下放弃它，等于主动放弃了后面所有「停下来看」的机会。' +
                    '静态分析当然有用，但它回答不了「运行时的这个值是多少」。<br>' +
                    '更重要的是：<b>很多静态疑惑本来就要靠调试来确认</b>' +
                    '（例如某分支到底走不走、某个字段是不是 null）。丢掉的不是一条备用路线，是主要手段之一。<br>' +
                    '<b>什么情况下「换手段」确实是对的：</b>当你已经确认检测发生在启动极早期、' +
                    '且你没有能力在那一层注入时——这属于「拿到证据后的决定」，' +
                    '与「一遇到挫折就换路」是两回事。' },
          nc: {
            label: '选 C', terminal: true, verdict: 'bad',
            verdictTitle: '在不知道检测点的情况下，这是赌博，而且大概率赌不赢',
            result: '<b>认知根源：把「常见检测点清单」当成了「这个 App 的检测点清单」。</b><br>' +
                    '反调试检测点的形态差异极大：有的读进程状态、有的比对函数开头的字节、' +
                    '有的比较耗时、有的在 native 层直接发系统调用（第 13 章）。' +
                    '把所有常见点都挂一遍，实际效果经常是：<b>脚本挂上了，App 还是退出</b>——' +
                    '因为你压根没挂到它真正用的那一个。<br>' +
                    '还有一个更隐蔽的代价：<b>hook 本身留下痕迹。</b>' +
                    '如果它的检测恰好包含「检查函数序言有没有被改」，你的绕过脚本会直接触发它，' +
                    '于是你得到一个「越绕越死」的闭环，并且完全不知道是自己造成的。<br>' +
                    '<span class="hit">正确顺序永远是：先确定它在哪一层做判断，再选择在不改内存的前提下观测，最后才谈绕过。</span>' },
          nd: {
            label: '选 D', terminal: true, verdict: 'bad',
            verdictTitle: '换环境会改变现象，但不会告诉你原因',
            result: '<b>认知根源：用「换一个变量」代替「理解一个变量」。</b><br>' +
                    '换设备/换模拟器确实可能让 App 不再退出——但你无法解释为什么，' +
                    '于是这个「成功」是不可复现的：下一次遇到同类问题，你还是没有方法。<br>' +
                    '而且环境差异本身会引入新的混淆项：模拟器有它自己的可检测特征（属性、传感器、指令翻译痕迹，第 15、16 章），' +
                    '换过去之后你的观测结果里混进了「模拟器」这个变量，可信度反而下降。<br>' +
                    '这个选项唯一合理的版本是：<b>把它当作对照实验来用</b>——' +
                    '在真机上退出、在模拟器上不退出，这个差异本身就是一条证据（说明检测依赖某个设备特征）。' +
                    '但前提是你先有一个假设，而不是碰运气。' }
        }
      },
      quiz: {
        id: 'q30-3', chapter: 30, answer: 0,
        stem: '下面哪一句对 <span class="mono">android:debuggable</span> 与 <span class="mono">ro.debuggable</span> 的描述是<b>正确</b>的？',
        options: [
          { t: '前者是应用级标志，决定「这个 App 能不能被 JDWP 附加」；后者是系统级属性，决定「这台设备的系统镜像是不是 debuggable 构建」',
            why: '正确。一个是 per-app（写在这个 App 的 manifest 里），一个是 per-device（写在系统镜像的属性里）。分清它们，才能解释「同一份 APK 在不同设备上可调试性不同」这种现象。' },
          { t: '两者都是全局开关，打开任意一个就足以让所有 App 都能被调试',
            why: '把 per-app 的标志说成了全局开关。android:debuggable 只作用于声明它的那一个 App，它不会让别的 App 变得可调试。' },
          { t: '前者由系统在安装时根据签名自动设置，后者由开发者在 manifest 里声明',
            why: '两者说反了，而且设置主体也不对：应用级标志来自构建配置，系统级属性来自系统镜像的构建方。' },
          { t: '两者都已经在 Android 新版本中被移除，现代调试依赖别的机制',
            why: '这两个概念至今仍是 Android 调试与检测的基础；说它们被移除，会导致你把「调试环境为什么配不上」归因到错误的地方。' }
        ],
        explain: '<b>记住这两句话就够了：</b><br>' +
                 '<b>① <span class="mono">android:debuggable</span> 是「门」，属于 App 自己</b>——' +
                 '它决定了这个进程愿不愿意对外暴露调试接口。<br>' +
                 '<b>② <span class="mono">ro.debuggable</span> 是「整栋楼的物业政策」，属于设备</b>——' +
                 '系统镜像是 debuggable 构建时，很多进程的可调试性会被整体放宽。<br>' +
                 '而开发者选项里的「USB 调试」只是「允许调试协议进来」的通道开关，' +
                 '<span class="hit">通道打开不等于门打开</span>——这是新手最常见的混淆。'
      },
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">四个概念（USB 调试 / android:debuggable / ro.debuggable / JDWP）的分工，' +
        '两个动作（让程序等着、把通道接过来），以及「为什么这些会被检测」的四条判据。<br>' +
        '<b>最关键的一条是决策演练里的区分：</b>「检测到调试后退出」与「被调试拖崩」是两种病，' +
        '开错药会浪费一整天，还会污染现场。</p>')
    },

    /* ============================================================ 30.6 */
    {
      h: '30.6', title: '定位方法论总纲：七条线索，以及它们的成本排序',
      intuition: {
        tag: '直觉模型 · 七种找钥匙的办法',
        body:
          '<p>钥匙丢在一个很大的房间里。你有七种办法：</p>' +
          '<ul>' +
          '<li><b>看标签</b>（字符串搜索）——最快，前提是钥匙上写着字。</li>' +
          '<li><b>看房间结构</b>（静态结构）——从家具怎么摆推断它可能掉在哪一类角落。</li>' +
          '<li><b>装监控回放</b>（Profiling / Trace）——看它掉的全过程，代价是装设备、而且画面会丢帧。</li>' +
          '<li><b>问在场的人</b>（日志）——前提是有人看见了，并且愿意说。</li>' +
          '<li><b>看脚印</b>（调用栈）——从它经过的路径倒推。</li>' +
          '<li><b>看监控画面</b>（UI 反推）——从「它最后出现在哪个位置」反推。</li>' +
          '<li><b>把房间冻结住逐寸搜</b>（动态调试）——最彻底，也最贵。</li>' +
          '</ul>' +
          '<p>本章要建立的判断力是：<b>面对一个具体现象，先付哪一笔成本。</b>' +
          '排错顺序的原则只有一条——<span class="hit">先做那个「即使失败也几乎不花钱」的动作。</span></p>'
      },
      html:
        T.note('key', '🔑 全章骨架：七条线索与它们的成本',
          '<p style="margin-bottom:0">下面这张表是本章的地图。' +
          '<b>成本不是难度，是「启动这条线索要付的代价」</b>：要不要环境、要不要复现、要不要中断程序、需不需要知道具体位置。</p>') +
        T.tbl(
          ['线索编号', '线索', '启动成本', '它回答什么问题', '它最容易死在什么地方'],
          [
            ['<b>1</b>', '<b>字符串搜索</b>', '<span class="pill ok">最低</span>',
             '「这个功能相关的代码在哪」——URL、提示语、日志 TAG、算法常量、密钥前缀',
             '字符串被加密、被拼接、或来自服务端；搜到的词不唯一（几十处命中）'],
            ['<b>2</b>', '<b>静态结构</b>', '<span class="pill acc">中</span>',
             '「系统是怎么把它拉起来的」——入口组件、权限、调用图、导入表、交叉引用',
             '被壳打散；符号被剥离；VMP 化之后调用图不再反映真实执行'],
            ['<b>3</b>', '<b>动态调试</b>', '<span class="pill bad">最高</span>',
             '「这一行执行时，寄存器/内存/参数到底是什么」——第一手现场',
             '环境没配对（debuggable/JDWP）；或对方检测到调试就退出'],
            ['<b>4</b>', '<b>调用栈</b>', '<span class="pill acc">中</span>',
             '「谁调用了它」以及「业务边界在哪一帧」',
             '栈被内联/混淆折叠；native 侧拿不到 unwind 信息'],
            ['<b>5</b>', '<b>UI 组件反推</b>', '<span class="pill acc">中</span>',
             '「这个界面元素背后的代码在哪」——Activity、布局、资源 id、绑定函数',
             '界面不是原生 View 树（Flutter / 自绘 / 游戏引擎）时结构性失效'],
            ['<b>6</b>', '<b>Profiling / Trace</b>', '<span class="pill warn">高</span>',
             '「这一串操作里到底跑了哪些方法」——候选集，而不是证据',
             '采样丢方法；内联导致调用关系缺失；反调试把 trace 变成噪音'],
            ['<b>7</b>', '<b>日志线索</b>', '<span class="pill ok">低</span>',
             '「刚才发生了什么」——崩溃栈、框架日志、业务打印、时序',
             '日志被加固清理；TAG 被改成无意义字符串；release 包关掉了日志']
          ]) +
        T.note('key', '📖 这张表的读法：编号是「身份」，不是「顺序」',
          '<p style="margin-bottom:0">上表的行序就是线索编号，它与后面七节（30.7 – 30.13）一一对应，' +
          '是你和别人对齐说法时用的名字（「线索 5 出局了」）。<br>' +
          '<b>但编号不代表优先级</b>——优先级只看「启动成本」那一列，以及下面三条排序判据。' +
          '所以你完全可能先用线索 7（日志，成本低）再用线索 2（静态结构，成本中），' +
          '把最贵的线索 3（动态调试）留到范围最小的时候。<br>' +
          '<span class="hit">30.14 那张决策图里用的是「尝试顺序」，与这里的编号是两回事——' +
          '那里按成本排，这里按身份排。</span></p>') +
        T.note('warn', '⚠️ 排序原则：不是「从 1 到 7 依次做」，而是「按失败代价排序」',
          '<p>三条判据，按优先级排：</p>' +
          '<ol>' +
          '<li><b>失败时是否几乎不花钱？</b>搜一个字符串，搜不到只需三十秒；' +
          '挂一次 IDA 调试，配环境加断点可能是一小时。<b>便宜的先行，是为了让贵的用在确定的地方。</b></li>' +
          '<li><b>它是否需要「具体位置」才能开始？</b>动态调试需要你先知道断在哪一行——' +
          '所以它天然排在定位类线索之后。反过来，字符串搜索不需要任何前提。</li>' +
          '<li><b>它是否会被目标「结构性排除」？</b>界面是 Flutter 时 UI 反推直接出局；' +
          '加固+字符串加密时静态搜索出局。<b>被排除的线索不是「效果差」，而是「逻辑上不成立」——' +
          '要直接划掉，不要浪费一轮去验证。</b></li>' +
          '</ol>' +
          '<p style="margin-bottom:0"><span class="hit">这七条线索不是七个独立的工具，是一条「成本递增、精度递增」的梯子。</span>' +
          '你要做的是每次只往上爬一级，并且清楚「爬到这一级失败时，我手里多了什么信息」。</p>') +
        T.card('每条线索失败时，你能拿到什么（这一栏比成功更有用）',
          T.tbl(
            ['线索失败', '你得到的信息', '它把可能性砍掉了什么'],
            [
              ['字符串搜索无命中', '这段文字不是「代码里的静态常量」',
               '排除了「明文硬编码」；指向运行时拼接 / 服务端下发 / 加密字符串（第 8、19 章）'],
              ['日志无有效信息', '这条路径上没有人留下可读记录',
               '说明要么被清理过，要么它压根没走这条路径——两者都缩小了范围'],
              ['静态结构读不出调用关系', '结构被处理过（壳 / 混淆 / VMP）',
               '这是<b>加固的证据</b>，直接把你推向脱壳或运行时观测（第 19 章）'],
              ['拿不到调用栈 / 栈退化', '调用关系被内联或折叠',
               '说明目标经过了编译期优化或混淆；同时否定了「靠名字读栈」这条路'],
              ['UI 反推失效', '界面不是原生 View 树',
               '排除了「从控件反查 Activity」；指向 Flutter / 自绘 / 引擎（字符串搜索仍可能有效）'],
              ['Trace 只有候选集', '你有一份「可能相关」的方法列表',
               '这是很好的<b>假设来源</b>，但需要别的手段把它变成证据'],
              ['动态调试挂不上', '要么环境问题，要么对方在检测',
               '<b>最有价值的一次失败</b>：确认了「有人不希望被调试」，于是转向抢时序或换观测层']
            ]))
        ,
      stage: {
        title: '七条线索 · 成本阶梯（从最便宜爬到最贵）',
        speed: 1700,
        render:
          '<div class="flow-col" style="gap:9px">' +
            '<div class="flow-row"><span class="pill ok mono">成本 1</span>' +
              '<span class="blk" id="c1">① 字符串搜索</span>' +
              '<span class="blk" id="c5">⑤ 日志线索</span>' +
              '<span class="muted small">零环境依赖，随时可做，先做这个</span></div>' +
            '<div class="flow-row" style="margin-left:22px"><span class="arrow">↓ 无命中 / 信息不足时往下走</span></div>' +
            '<div class="flow-row"><span class="pill acc mono">成本 2</span>' +
              '<span class="blk" id="c2">② 静态结构</span>' +
              '<span class="blk" id="c3">③ 调用栈</span>' +
              '<span class="blk" id="c4">④ UI 组件反推</span>' +
              '<span class="muted small">需要工具或运行环境，但不用中断程序</span></div>' +
            '<div class="flow-row" style="margin-left:22px"><span class="arrow">↓ 结构读不出来 / 需要「谁被调用了」时往下走</span></div>' +
            '<div class="flow-row"><span class="pill warn mono">成本 4</span>' +
              '<span class="blk" id="c6">⑥ Profiling / Trace</span>' +
              '<span class="blk" id="c7">⑦ 动态调试</span>' +
              '<span class="muted small">要注入、要采样、要中断程序——用在确定的地方</span></div>' +
            '<div class="flow-row" style="margin-top:6px;padding-top:10px;border-top:1px dashed var(--line)">' +
              '<span class="pill bad" id="mark">🎯 每次只往上爬一级，并且记住失败时得到了什么</span></div>' +
            '<div class="note" id="mk"><div class="note-h">现在这一步</div>' +
              '<p style="margin-bottom:0">点「播放」：每一步点亮一条线索，并说明「什么时候必须换下一条」。</p></div>' +
          '</div>',
        reset: () => {
          ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'].forEach(i => S(i, ''));
          CLS('mark', 'pill bad');
          SET('mark', '🎯 每次只往上爬一级，并且记住失败时得到了什么');
          SET('mk', '<div class="note-h">现在这一步</div><p style="margin-bottom:0">点「播放」：每一步点亮一条线索，并说明「什么时候必须换下一条」。</p>');
        },
        steps: [
          { run: () => S('c1', 'active'),
            note: '<b>成本 1 · 字符串搜索。</b>你要搜的东西包括：URL 与域名、错误提示、日志 TAG、' +
                  '加解密算法的常量（S 盒、IV、K 表）、密钥前缀、配置项名。<br>' +
                  '<b>什么时候换下一条：</b>搜不到，或者命中太多（几十处）。' +
                  '搜不到说明它不是静态明文；命中太多说明这个词太通用，换一个更独特的词再试一次——' +
                  '<span class="hit">换词仍然是成本 1，不要急着升级手段。</span>' },
          { run: () => { S('c1', 'done'); S('c5', 'active'); },
            note: '<b>成本 1 · 日志线索。</b>它同样零环境依赖：崩溃栈、框架日志、' +
                  '以及 App 自己打的业务日志。<br>' +
                  '<b>什么时候换下一条：</b>logcat 里只有噪音、或 TAG 全被改成无意义字符串。' +
                  '注意：<b>崩溃栈本身就是一份「高质量的调用栈」</b>——如果你的目标恰好会崩，' +
                  '那么「调用栈」这条线索的成本会瞬间从「中」掉到「低」（下面会看到）。' },
          { run: () => { S('c5', 'done'); S('c2', 'active'); },
            note: '<b>成本 2 · 静态结构。</b>从 manifest 的组件与权限、import 与类型引用、' +
                  '方法调用图、注解与泛型残留里找。<br>' +
                  '它比字符串搜索贵在「要读」：你要把一堆符号关系在脑子里连成一张图。' +
                  '<b>什么时候换下一条：</b>结构被壳打散、或符号被剥离到读不出语义（第 19 章）。' },
          { run: () => { S('c2', 'done'); S('c3', 'active'); },
            note: '<b>成本 2 · 调用栈。</b>它的成本取决于<b>你已经有什么</b>：' +
                  '有一份崩溃日志 → 几乎免费；<br>' +
                  '要靠注入打栈 → 成本抬到与 Hook 环境同价；<br>' +
                  '要在 native 侧 unwind → 再贵一档。<br>' +
                  '<b>什么时候换下一条：</b>栈被内联/混淆折叠成了 a.a.a，读不出业务边界。' },
          { run: () => { S('c3', 'done'); S('c4', 'active'); },
            note: '<b>成本 2 · UI 组件反推。</b>当你的起点是「界面上某个元素」时，这条线索极其有效：' +
                  'dump 出资源 id → 反查布局 → 反查绑定函数。' +
                  '<b>什么时候换下一条：</b>界面不是原生 View 树。' +
                  '<span class="miss">这是本章唯一的「结构性排除」——遇到 Flutter / 自绘 / 游戏引擎，' +
                  '直接划掉它，不要试着验证。</span>' },
          { run: () => { S('c4', 'done'); S('c6', 'active');
                         SET('mk', '<div class="note-h">到这里，你已经花了多少？</div><p>前五条线索的共同点是：<b>都不需要中断程序、都不需要精确知道位置。</b>它们给你的是「范围」和「候选」。<br>下面两条要付更高的成本，所以它们应该被用在<b>范围已经很小</b>的时候。</p>'); },
            note: '<b>成本 4 · Profiling / Trace。</b>它回答的是「这一串操作里跑了哪些方法」——' +
                  '给的是<b>候选集</b>，不是证据链。<br>' +
                  '<b>什么时候换下一条：</b>采样把目标方法丢了（太短、太深），或内联导致调用关系缺失。' +
                  '<span class="hit">它最大的价值是「在没有字符串可搜、结构也读不出来时，给你第一批假设」。</span>' },
          { run: () => { S('c6', 'done'); S('c7', 'active');
                         SET('mark', 'pill warn'); SET('mark', '⚠️ 最贵的一级：它要求你先知道「断在哪」'); },
            note: '<b>成本 4 · 动态调试。</b>它是唯一能给出第一手现场的手段（寄存器、内存、局部变量），' +
                  '所以它必须被用在<b>最确定的地方</b>。<br>' +
                  '<b>它的成本有一半不在技术上，在环境上</b>：debuggable、JDWP 通道、' +
                  '以及「目标是否检测调试」。<b>这也是为什么它排在最后：先用它前面的六条把范围压小，再动手。</b>' },
          { run: () => { CLS('mark', 'pill ok'); SET('mark', '✅ 顺序不是死的：任何一步拿到强证据都可以直接跳到第 7 级');
                         SET('mk', '<div class="note-h">阶梯的正确用法</div><p style="margin-bottom:0">这不是「必须从 1 走到 7」。<b>任何一步拿到强证据，都可以直接跳到最贵的那一级</b>——' +
                           '比如崩溃日志直接给出了类名与行号（③命中），你就可以立刻在那里下断点（⑦）。<br>' +
                           '阶梯真正的用途是回答一个问题：<b>「我现在这一步失败了，下一步该往哪走？」</b></p>'); },
            note: '<b>收尾：阶梯的价值在于「决定下一步」，而不是「规定顺序」。</b><br>' +
                  '强证据可以让你跳级；弱证据（比如 Trace 给的候选集）则必须回到便宜的那几级去交叉验证。<br>' +
                  '<span class="hit">判断力体现在：知道自己现在手里的东西是「强证据」还是「候选集」。</span>' }
        ]
      },
      quiz: {
        id: 'q30-4', chapter: 30, answer: 3,
        stem: '下面关于七条线索的排序，哪一条判断是<b>正确</b>的？',
        options: [
          { t: '七条线索应该从 1 到 7 依次尝试，这样才能保证不遗漏任何一种可能',
            why: '依次尝试忽略了「成本差异」。一次动态调试的启动成本可能等于几十次字符串搜索；更糟的是，把最贵的手段用在一个还没缩小范围的目标上，得到的往往是无效结论。' },
          { t: '动态调试最精确，所以应该优先使用，避免在便宜的线索上浪费时间',
            why: '把「精确」当成了「优先」。动态调试需要你先知道断在哪里——没有前六条给出的范围，你连下断点的位置都选不出来。' },
          { t: '只要字符串搜索命中，就应该停止使用其它线索，避免节外生枝',
            why: '字符串搜索命中给你的是「候选位置」，不是结论。混淆命名、工具类复用、多份相似代码都会让命中指向错误的函数，仍然需要调用栈或调试来确认。' },
          { t: '被「结构性排除」的线索要直接划掉：界面是 Flutter 时，UI 反推不是效果差，而是逻辑上不成立',
            why: '正确。这正是本章对七条线索排序的关键补充：成本排序管的是「先试哪个」，结构性排除管的是「哪个根本不用试」。两者一起用，才能既不遗漏也不浪费。' }
        ],
        explain: '<b>把这两件事分开看，排序才不会变成教条：</b><br>' +
                 '<b>① 成本排序</b>决定「先付哪一笔钱」——便宜的先做，因为失败几乎不花钱，' +
                 '而且它给出的信息（不是明文常量 / 结构被处理过 / 栈退化了）本身就能砍掉一大片可能性。<br>' +
                 '<b>② 结构性排除</b>决定「哪个逻辑上不成立」——Flutter 界面没有原生 View 树，' +
                 '所以 UI 反推不是「弱」，而是「错」；加固+字符串加密时静态搜索不是「慢」，而是「空」。<br>' +
                 '<span class="hit">判断力 = 知道哪条线索便宜（先做） + 知道哪条线索不成立（别做）。</span>'
      },
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">七条线索、一张成本表、三条排序判据，以及最重要的那张「失败时得到什么」的表。<br>' +
        '下面七节逐条展开。<b>读每一条时请始终带着同一个问题：它失败时，我会得到什么信息？</b></p>')
    },

    /* ============================================================ 30.7 */
    {
      h: '30.7', title: '线索一 · 字符串搜索：搜什么，以及搜不到时说明了什么',
      html:
        '<p>字符串搜索是整章最便宜的动作，也是<b>最容易做错的动作</b>——' +
        '大多数人的问题是「不知道搜什么词」，而不是「不会搜」。</p>' +
        T.card('值得优先试的六类搜索词（按命中率排序）',
          '<ol>' +
          '<li><b>URL 与域名</b>：接口路径、CDN 域名、埋点地址。字符串搜索里命中率最高的一类，' +
          '因为域名几乎不会被混淆掉（它必须是真的域名才能通信）。</li>' +
          '<li><b>错误提示与业务文案</b>：界面上看到的每一句话都可能是一个明文常量。' +
          '注意「可能」——下一段会讲它的三种例外。</li>' +
          '<li><b>日志 TAG</b>：业务代码的 TAG 往往直接写着模块名或功能名，是天然的索引。</li>' +
          '<li><b>加解密算法的常量</b>：标准表的初始向量、轮常量、编码表。<b>魔改算法恰恰会留下这些改过的常量</b>，' +
          '所以这是识别「这是什么算法」最直接的入口（第 8、9 章的主战场）。</li>' +
          '<li><b>密钥 / 盐的前缀与格式特征</b>：例如形如固定前缀加随机串的 key、固定长度的 hex 串。' +
          '搜前缀往往能定位到密钥派生的代码。</li>' +
          '<li><b>配置项名与协议字段名</b>：参数名、header 名、固定字段。<b>字段名是被双方约定死的</b>，' +
          '所以它通常老老实实躺在协议解析代码里。</li>' +
          '</ol>') +
        T.note('key', '🔑 什么时候该怀疑「这条线索不成立」',
          '<p>界面上的文案有三种情况，搜不到时按顺序排查：</p>' +
          '<ol>' +
          '<li><b>运行时拼出来的</b>：文案由多个片段拼接，你搜整句当然搜不到。' +
          '对策：<b>换成搜其中的独特片段</b>，或者去搜「格式化」的痕迹（拼接点附近）。</li>' +
          '<li><b>服务端下发的</b>：本地只有一个错误码。<b>这是最常见的「搜不到」</b>。' +
          '判据：抓包能看到这句原文，而本地搜不到任何片段。</li>' +
          '<li><b>被加密的</b>：字符串在 dex / so 里以密文或编码后的形式存在，运行时才解密（第 19 章）。' +
          '判据：搜不到；而且你能看到成片的、看起来像随机数据的高熵区域。</li>' +
          '</ol>' +
          '<p style="margin-bottom:0"><span class="hit">无论哪一种，你都拿到了一个明确的信息：' +
          '「这个功能不是靠明文常量驱动的」</span>——这本身就是一条把范围缩小了的结论。' +
          '而它的下一站是明确的：拼接 → 顺调用栈；服务端 → 抓包与协议分析；加密 → 脱壳与字符串解密（第 8、19 章）。</p>') +
        T.acc('为什么「搜不到」反而常常是有价值的信号',
          '<p>很多人把「搜不到」当成一次失败，然后换下一个词、再换下一个词，' +
          '最后得出结论「这个 App 没法分析」。</p>' +
          '<p>正确的读法是：<b>搜索的命中与否，是在给这段代码做分类。</b></p>' +
          '<ul>' +
          '<li>命中了 → 这段逻辑是<b>静态可读</b>的，继续用静态手段。</li>' +
          '<li>该搜的词都搜遍了都不中 → 这段逻辑是<b>运行时构造</b>的，' +
          '继续静态搜索是浪费，应该转向调用栈、Trace 或动态调试。</li>' +
          '</ul>' +
          '<p style="margin-bottom:0">换句话说：<span class="hit">字符串搜索真正的产出不是「那个字符串」，' +
          '而是「这份代码是静态型还是运行时型」这个判断</span>。它决定了你接下来该走静态还是动态——' +
          '这是本章最早、最便宜的一次分岔。</p>'),
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">六类高价值搜索词，以及「搜不到」的三种成因（拼接 / 服务端 / 加密）与各自的下一站。<br>' +
        '记住这条线索的真正产出：<b>它给代码做了一次「静态型 / 运行时型」的分类。</b></p>')
    },

    /* ============================================================ 30.8 */
    {
      h: '30.8', title: '线索二 · 静态结构：Java 看调用链，Native 看导入表与交叉引用',
      html:
        '<p>静态结构这条线索听起来很虚，其实它有四个非常具体的抓手。按「从外到内」的顺序：</p>' +
        T.tbl(
          ['抓手', '具体看什么', '它能直接回答的问题'],
          [
            ['<b>① manifest（最外层）</b>',
             '入口 Activity 与 intent-filter、Service / Receiver / Provider 声明、权限、' +
             '<span class="mono">android:debuggable</span>、网络配置、<span class="mono">extractNativeLibs</span> 之类的开关',
             '「程序从哪里开始跑」「它有没有对外暴露的组件」「它声明了哪些能力」'],
            ['<b>② import 与类型引用</b>',
             '某个类引用了哪些框架类型：加密相关、网络相关、反射相关、动态加载相关',
             '<b>「它在用什么能力」</b>——比读方法体便宜得多，且不受混淆影响（框架类名不会被混淆）'],
            ['<b>③ 方法调用图</b>',
             '谁调用谁：从入口向外展开，或从可疑点向内回溯',
             '「这条业务链路经过哪些类」；也是判断「哪些方法是死代码」的依据'],
            ['<b>④ 注解与泛型残留</b>',
             '注解（含运行时注解）、泛型签名、异常表、内部类名字',
             '<b>混淆最难抹掉的一层</b>：注解与泛型签名是结构化元数据，' +
             '经常能还原出「这个类原本叫什么、处理什么数据」']
          ]) +
        T.note('key', '🔑 Java 与 Native 的静态阅读，盯的不是同一样东西',
          '<p style="margin-bottom:0">这是本节最该带走的一句话：</p>' +
          '<ul>' +
          '<li><b>静态看 Java：盯「调用链」。</b>Java 层有完整的类型信息、方法引用、' +
          '甚至行号与注解——所以你的工作是<b>沿着引用关系把链路连起来</b>，' +
          '从「界面触发的入口」走到「真正干活的那个方法」。混淆会改名字，但改不了调用关系的<b>形状</b>。' +
          '<span class="hit">名字被混淆时，形状就是你的地图。</span></li>' +
          '<li><b>静态看 Native：盯「导入表 + 常量 + 交叉引用」。</b>' +
          'so 里没有类型系统可依赖，符号还可能被剥离，所以你只能靠三样东西：' +
          '<b>它调用了哪些外部函数</b>（导入表——即使符号被剥离，导入表依然存在，' +
          '因为动态链接必须靠它）、<b>它用了哪些常量</b>（算法常量、错误字符串、配置键）、' +
          '以及<b>谁引用了这段代码</b>（交叉引用：从 JNI 注册点、从导出函数、从字符串引用反查）。</li>' +
          '</ul>' +
          '<p style="margin-bottom:0">这一节的推论很实用：<b>符号被剥离不等于 native 不可读。</b>' +
          '导入表告诉你它「会做什么」，常量告诉你它「用的是什么算法」，' +
          '交叉引用告诉你「从哪进来」——三条合起来已经足够画出一张草图。</p>') +
        T.grid(2, [
          T.card('静态结构的五个「高价值锚点」',
            '<ul>' +
            '<li><b>JNI 动态注册表</b>：名字与函数指针的对应关系，等于一份免费的符号表。' +
            '哪怕 so 被剥离，注册表里也写着名字（第 20 章）。</li>' +
            '<li><b>导出函数表</b>：被外部调用的入口；如果它是 JNI 静态注册，函数名本身就是签名信息。</li>' +
            '<li><b>字符串引用点</b>：从「搜到的那个常量」反查「谁引用了它」，' +
            '这是把「字符串」变成「代码位置」的标准动作。</li>' +
            '<li><b>导入表</b>：网络、加密、文件、反射——四类导入几乎能勾勒出模块的功能轮廓。</li>' +
            '<li><b>异常与断言字符串</b>：调试期留下的信息，往往直接说明「这里在检查什么」。</li>' +
            '</ul>'),
          T.card('静态结构最容易误判的三种情况',
            '<ul>' +
            '<li><b>把「引用」当成「执行」</b>：一段代码被引用，不代表它会被跑到。' +
            '很多诱导性代码就是这样设计的。<b>静态给的是可能性，不是事实。</b></li>' +
            '<li><b>把「死代码」当成主线</b>：混淆会插入大量不可达分支。' +
            '判据：在调用图上找不到从入口过来的路径。</li>' +
            '<li><b>把「壳的结构」当成业务结构</b>：如果反编译出来只有一个巨大的 Application ' +
            '和一堆看不懂的类，先考虑「这是壳」，而不是「这个 App 逻辑很奇怪」（第 19 章）。</li>' +
            '</ul>')
        ]) +
        T.note('warn', '📌 一个纪律：静态结论必须用动态或数据流交叉验证',
          '<p style="margin-bottom:0">静态分析给出的是<b>读代码得到的推理</b>，' +
          '而推理会被三件事欺骗：不可达代码、被替换的方法（壳在运行时换实现）、以及编译器优化。<br>' +
          '所以任何一条静态结论，只要它足够关键（例如「密钥是这里派生的」），' +
          '就应该用一个便宜的动作去验证：加一条日志、打一个栈、或者对一次输入输出。' +
          '<b>验证的成本通常远低于推理错误的代价。</b></p>'),
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">四个抓手（manifest / 类型引用 / 调用图 / 注解与泛型残留），' +
        '以及 Java 与 Native 静态阅读的分工：<b>Java 盯调用链的形状，Native 盯导入表、常量与交叉引用。</b></p>')
    },

    /* ============================================================ 30.9 */
    {
      h: '30.9', title: '线索三 · 动态调试：Smali 断点与 IDA attach，重点在「观察什么」',
      html:
        '<p>动态调试的操作细节（用哪个 IDE、怎么配端口、点哪个按钮）随工具版本变化，' +
        '而且网上一搜一大把。<b>本节刻意不写按键序列</b>，只写两件事：' +
        '两条调试路线各自适合什么场景，以及停下来的那一刻你应该看什么。</p>' +
        T.grid(2, [
          T.card('路线 A：Smali 层断点（<span class="mono">am start -D</span> + 主机调试器）',
            '<p><b>适合：</b>目标逻辑在 Java 层；你要确认「某个分支走不走」「某个字段是不是 null」' +
            '「某个方法收到的参数到底是什么」。</p>' +
            '<p><b>它的独特价值是「变量可见」</b>：在 Java 层，你能直接看到对象内容、字符串、集合，' +
            '不需要自己做内存解析。</p>' +
            '<p><b>它的短板：</b>Java 层看到的东西可能是「已经被 native 处理过的结果」。' +
            '如果算法在 so 里，Java 断点只能看到输入和输出，看不到中间过程。</p>' +
            '<p class="muted small">前置条件与失败形态见 30.5；具体操作以当前工具文档为准。</p>'),
          T.card('路线 B：IDA attach so（原生层）',
            '<p><b>适合：</b>算法 / 校验 / 加解密在 so 里；你要看寄存器、内存布局、' +
            '以及「这个函数被谁调用」。</p>' +
            '<p><b>它的独特价值是「唯一的第一手现场」</b>：寄存器里的中间值、栈上的临时缓冲、' +
            '堆上那块被 XOR 过的数据，只有在这一层才看得到。</p>' +
            '<p><b>它的短板：</b>需要so 已加载（attach 时机）、需要地址（基址 + 偏移）、' +
            '符号被剥离时定位困难。所以它天然排在静态结构与调用栈之后。</p>' +
            '<p class="muted small">attach 模式与断点方式随 IDA 版本与目标架构变化，以当期文档为准。</p>')
        ]) +
        T.tbl(
          ['停下来的那一刻，先看这四样', '为什么先看它', '常见误判'],
          [
            ['<b>① 参数（寄存器和栈上的入参）</b>',
             '参数决定了这次调用「在算什么」。先确认自己停在了正确的那一次调用上，再做别的',
             '只看了第一次命中就下结论——很多函数会被调用几十次，第一次可能只是初始化'],
            ['<b>② 返回地址（谁调用了它）</b>',
             '返回地址直接告诉你上一层是谁，这是把「孤立函数」接回调用链的最快方式',
             '把返回地址当成了「函数内某个常量地址」；或者忘了减掉指令长度（架构相关）'],
            ['<b>③ 关键内存（输入缓冲、输出缓冲、密钥区）</b>',
             '算法的真相在内存里：读一次输入缓冲、读一次输出缓冲，就能确认数据流方向',
             '只看寄存器不看内存——数据结构的指针在寄存器里，内容在内存里'],
            ['<b>④ 这一段的执行轨迹（谁改了它）</b>',
             '当你要回答「这个值是谁写进来」时，断点比读代码有效得多',
             '在没有缩小范围时就开指令级 trace：数据量大到你读不完']
          ]) +
        T.note('warn', '⚠️ 一条经验：调试器的成本有一半花在「选点」上',
          '<p style="margin-bottom:0">新手常以为动态调试的难点是「怎么挂上去」。' +
          '实际上挂上去只是入场券，<b>贵的是「断在哪里」</b>：' +
          '断点太多 → 你要处理的命中数爆炸；断点太浅 → 看到的是无关的框架代码；' +
          '断点太深 → 可能永远不命中（那个分支根本没走到）。<br>' +
          '<span class="hit">所以六条更便宜的线索的真正用途，就是帮你把「断在哪」这件事从猜测变成选择。</span></p>'),
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">两条调试路线的适用边界（Java 层看变量、native 层看现场），' +
        '以及停下来要看的四样东西：参数、返回地址、关键内存、执行轨迹。<br>' +
        '<b>本节刻意不给按键序列</b>——那些随版本变化；而「观察什么」不会过期。</p>')
    },
    /* ============================================================ 30.10 */
    {
      h: '30.10', title: '线索四 · 调用栈：栈的三段、业务边界，以及栈退化之后长什么样',
      intuition: {
        tag: '直觉模型 · 一张收据',
        body:
          '<p>调用栈像一张打印出来的收据：从下往上，记录着「是谁把钱交给了谁」。</p>' +
          '<p>最底下几行是银行和收单机构（系统与框架），中间可能有几行是转接行（库与代理），' +
          '最上面那几行才是真正花钱的人（业务代码）。</p>' +
          '<p>你关心两件事：<b>最上面的业务痕迹从哪一行开始</b>（事发点），' +
          '以及<b>最下面那笔交易是怎么被发起的</b>（入口）。</p>' +
          '<p>如果这张收据上所有的名字都被涂成了「a、b、c」，那你手里的纸还在，信息已经没了——' +
          '这就是栈退化。</p>'
      },
      html:
        '<p>调用栈之所以被单独列为一条线索，是因为它有一种别的线索没有的性质：' +
        '<b>它同时给出了「位置」和「关系」</b>。字符串搜索给你一个位置，调用栈给你一条路径。</p>' +
        T.note('key', '🔑 栈的三段：先学会分层，再谈读法',
          '<p>拿到一条栈，第一步不是找目标，而是<b>把它切成三段</b>：</p>' +
          '<ul>' +
          '<li><b>① 系统与框架段</b>（栈底）：<span class="mono">android.*</span>、' +
          '<span class="mono">java.*</span>、<span class="mono">androidx.*</span>、' +
          '<span class="mono">com.android.*</span>，以及运行时的 so（libc / libart / libandroid）。' +
          '<b>这一段告诉你「这次调用是被什么机制触发的」</b>——是 UI 事件、是消息循环、是 Binder 回调、还是线程池。</li>' +
          '<li><b>② 业务框架段</b>（中间）：第三方 SDK、网络库、加解密封装库、插件框架、你自己的基础库。' +
          '它们的特征是「名字看起来像公司，但不像这个 App 的业务」。' +
          '<b>这一段是噪音的主要来源</b>，也是「无意义包装」最常出现的地方。</li>' +
          '<li><b>③ 业务逻辑段</b>（栈顶）：目标 App 自己的包名。' +
          '<b>这才是你要读的部分。</b></li>' +
          '</ul>' +
          '<p style="margin-bottom:0"><span class="hit">分层靠的是包名与模块名，不是靠「哪个名字看起来重要」。</span>' +
          '这也是为什么它是一条可靠的、可以交给别人复核的判断。</p>') +
        T.note('key', '🎯 业务边界：第一次出现「你的目标」的那一帧',
          '<p>业务边界有两种等价的说法：</p>' +
          '<ul>' +
          '<li><b>从栈顶往下数：</b>第一帧属于<b>应用自己包名</b>、并且<b>不是代理/合成/反射帧</b>的代码。</li>' +
          '<li><b>从你的目标倒着数：</b>你要找的那个字符串、那个密文、那个错误码，' +
          '<b>第一次出现在哪一帧</b>——那一帧就是业务边界。</li>' +
          '</ul>' +
          '<p>两种说法为什么等价：因为它们都在回答同一个问题——<b>「控制权是从哪一帧开始进入业务的」</b>。<br>' +
          '找到它之后，你的动作是明确的：<b>把断点/日志/计数器放到那一帧</b>，' +
          '而不是放在它上面那一堆框架代码里。</p>' +
          '<p style="margin-bottom:0"><b>反方向的用法同样重要：</b>从栈底往上数，第一帧业务代码是' +
          '<b>业务入口</b>——它回答的是「用户的一次操作是从哪里进入这个 App 的代码的」。' +
          '一个栈，两个方向，分别对应「事发点」与「入口点」。</p>') +
        T.tbl(
          ['栈上的形态', '它意味着什么', '你的下一步'],
          [
            ['<b>代理 / 合成帧</b>（反射调用、合成的 lambda、动态代理）',
             '控制权经过了「通用入口」，这一帧本身<b>不携带业务语义</b>——' +
             '你不可能从 <span class="mono">Method.invoke</span> 看出它在调谁',
             '不要在这一帧下功夫；<b>穿过它</b>，去看它下面的实际目标，或者去 hook 反射 API 拿名字（第 20 章）'],
            ['<b>库的包装帧</b>（名字像库、调用层次很深）',
             '第三方库在做转发；业务逻辑还在更上面或更下面',
             '同样穿过它。判断依据是包名归属，不是调用深度'],
            ['<b>同一帧名重复出现</b>',
             '递归，或者调用链被折叠/内联之后的假重复',
             '先确认是真递归还是假重复——假重复意味着这个栈的<b>关系信息已经不可信</b>'],
            ['<b>帧上只有模块名和偏移，没有符号</b>（native 侧）',
             '符号被剥离，或这是系统库（系统库本来就只有偏移）',
             '把偏移映回模块基址，再用静态分析的地址去对应（下面单独讲）'],
            ['<b>栈里一帧业务代码都没有</b>',
             '崩溃/断点发生在框架层；或者你的目标进程不对',
             '先怀疑「是不是 attach 错了进程」，再怀疑「业务代码不在这条路径上」']
          ]) +
        T.card('native 侧的栈：为什么更难读，怎么读',
          '<p>Java 栈是「有名字的列表」，native 栈是「一块内存 + 一些约定」——' +
          '要自己沿着帧指针/展开信息往回走，所以它天生更容易断。读的时候盯三件事：</p>' +
          '<ul>' +
          '<li><b>模块归属</b>：每个地址落在哪个 so 里（libc / libart / App 自带的 libxxx）。' +
          '这一条即使在符号被剥离时也成立，因为模块映射关系是内核给的。</li>' +
          '<li><b>模块内偏移</b>：把绝对地址减掉模块基址，得到偏移；' +
          '这个偏移才是可以拿去静态分析里对照的稳定量（基址每次运行都变）。</li>' +
          '<li><b>有没有 unwind 信息</b>：部分 so 带展开信息，能给出完整的 native 栈；' +
          '没有的时候你只能拿到当前帧附近的地址，需要自己分段确认。</li>' +
          '</ul>' +
          '<p style="margin-bottom:0"><b>结论：</b>native 栈给你的不是「函数名列表」，' +
          '而是「一组（模块, 偏移）坐标」。<span class="hit">它的用法与 Java 栈相同——' +
          '先分层（哪些是系统库、哪个是 App 自带），再把坐标交给静态分析。</span>' +
          '第 1 章讲过 native hook 的地址问题，第 21 章的 ModuleMap 则是「几十个 so 里锁定那一个」的工程化做法。</p>') +
        T.note('warn', '⚠️ 栈退化：三种表现，以及它给你的结论',
          '<p style="margin-bottom:0">当你看到下面三种表现时，不要再试图从这条栈里读出业务关系——' +
          '它已经在编译期被抹掉了：</p>' +
          '<ul>' +
          '<li><b>大量无行号帧</b>（Unknown Source / SourceFile:1）：说明行号信息被剥掉了，' +
          '你无法再从「行」回到「源码」。</li>' +
          '<li><b>名字全是单字母</b>（a.a.a）：混淆不仅让名字失去语义，也让「同名帧重复」变得无法解释。</li>' +
          '<li><b>帧数骤减、调用关系断裂</b>：内联把函数体展开到调用处，<b>这一帧在栈上从来不存在</b>。' +
          '你看到的调用关系会直接跳过被内联的函数。</li>' +
          '</ul>' +
          '<p style="margin-bottom:0"><span class="hit">退化的结论不是「这条线索没用」，而是：' +
          '「名字与行号这条路被关掉了，我需要一个不依赖名字的观测」</span>——' +
          '于是转向运行时打点、指令级 trace，或者直接用地址做动态调试。</p>'),
      lab: {
        title: '实验：调用栈判读器（真实解析 + 分层 + 三坐标定位）',
        goal: '标出三个坐标 + 说出理由',
        intro:
          '<p>下面有一段<b>真实形状</b>的崩溃栈（异常类型被改写得无害，但形态是真的）。' +
          '点「解析这条栈」会得到每一帧的<b>语法特征</b>——注意：<b>它不会告诉你哪一帧是业务帧</b>，' +
          '那一层判断要你自己做。</p>' +
          '<p>你要填三个帧号与一段理由。<b>帧号就是解析结果里的 # 编号</b>（异常名那一行不计数）。' +
          '判分用的是规则：包名归属、代理/合成帧特征、以及「从栈顶/栈底两个方向的第一帧业务代码」。<br>' +
          '做完后可以把输入框里的栈换成<b>第二段（退化版）</b>再跑一次——那是同一套规则遇到混淆时的表现。</p>',
        inputs: [
          { key: 'stack', label: '调用栈原文', hint: '可直接替换成你手上的真实栈',
            type: 'textarea', rows: 11, value: window.CH30X.DEMO_A },
          { key: 'boundary', label: '① 业务边界在哪一帧？', hint: '填帧号', value: '' },
          { key: 'wrapper', label: '② 哪一帧没有业务语义（代理 / 合成 / 紧贴边界的框架帧）？', hint: '填帧号；若确实没有填 0', value: '' },
          { key: 'follow', label: '③ 要找到「业务入口」，顺哪一帧最有效？', hint: '填帧号', value: '' },
          { key: 'why', label: '理由：你凭什么区分系统帧、框架帧、业务帧？', hint: '至少说两点',
            type: 'textarea', rows: 3, value: '' }
        ],
        runLabel: '🔍 解析这条栈',
        autorun: true,
        run: v => window.CH30X.framesHtml(window.CH30X.judgeStack(window.CH30X.parseStack(v.stack))),
        expected: v => {
          const j = window.CH30X.judgeStack(window.CH30X.parseStack(v.stack));
          if (!j.numbered.length) {
            return { ok: false, detail: '还没有解析出任何帧。把崩溃日志原样粘进第一个框，Java 帧要形如 <span class="mono">at com.a.B.c(B.java:12)</span>。' };
          }
          const num = function (s) {
            const m = /(\d+)/.exec(String(s || ''));
            return m ? parseInt(m[1], 10) : null;
          };
          const wantBoundary = j.boundary ? j.boundary.idx : null;
          const wantEntry = j.entry ? j.entry.idx : null;
          const wrapOk = [];
          if (j.proxy) wrapOk.push(j.proxy.idx);
          if (j.nearBoundary) wrapOk.push(j.nearBoundary.idx);
          const b = num(v.boundary), w = num(v.wrapper), f = num(v.follow);
          const okB = b !== null && b === wantBoundary;
          const okF = f !== null && f === wantEntry;
          const okW = wrapOk.length
            ? (w !== null && wrapOk.indexOf(w) >= 0)
            : window.AKKC_hasConcept(v.wrapper || '', ['0', '无', '没有', '不存在']);
          const hits = ['业务', '包名', '系统', '框架', '代理', '反射', '内联', '入口', '行号', 'native', '混淆', '栈顶', '栈底']
            .filter(function (k) { return window.AKKC_hasConcept(v.why || '', [k]); });
          const okWhy = hits.length >= 2;
          const ok = okB && okW && okF && okWhy;
          let detail = '<b>逐项核对</b><ul style="margin:6px 0 0 18px">' +
            '<li>① 业务边界：你填 ' + (b === null ? '（空）' : '#' + b) + '，规则算出 ' +
              (wantBoundary === null ? '（这条栈里没有业务帧）' : '#' + wantBoundary + ' <span class="mono small">' + j.boundary.name + '</span>') +
              (okB ? ' <span class="hit">✔</span>' : ' <span class="miss">?</span>') + '</li>' +
            '<li>② 无业务语义帧：你填 ' + (w === null ? '（空）' : '#' + w) + '，规则算出 ' +
              (wrapOk.length ? wrapOk.map(function (x) { return '#' + x; }).join(' 或 ') : '（这条栈里没有，应填 0）') +
              (okW ? ' <span class="hit">✔</span>' : ' <span class="miss">?</span>') + '</li>' +
            '<li>③ 业务入口：你填 ' + (f === null ? '（空）' : '#' + f) + '，规则算出 ' +
              (wantEntry === null ? '（无）' : '#' + wantEntry + ' <span class="mono small">' + j.entry.name + '</span>') +
              (okF ? ' <span class="hit">✔</span>' : ' <span class="miss">?</span>') + '</li>' +
            '<li>理由：命中 ' + hits.length + ' 个判据点' + (okWhy ? ' <span class="hit">✔</span>' : '（至少要说两点）') + '</li>' +
            '</ul>';
          if (j.degraded) {
            detail += '<div class="lab-note"><b>顺带提示：</b>这条栈的规则判定是「已退化」——' +
              j.reasons.join('；') + '。退化栈的正确处理是<b>换一个不依赖名字与行号的观测</b>，' +
              '而不是继续在这里找语义。</div>';
          }
          return { ok: ok, detail: detail };
        },
        showAnswer:
          '<p><b>对上面第一段栈（DEMO_A）：</b></p>' +
          '<ul>' +
          '<li><b>① 业务边界 = #1</b> <span class="mono">com.target.pay.CryptoBridge.nativeSign</span>。' +
          '从栈顶往下，它是最接近事发点的业务帧；而且它标着 <span class="mono">(Native Method)</span>，' +
          '说明这里同时是 <b>Java → native 的交接点</b>——再往里一步就要去 so 里找地址了。</li>' +
          '<li><b>② 无业务语义帧 = #3</b> <span class="mono">java.lang.reflect.Method.invoke</span>。' +
          '反射是「通用入口」，它不携带业务语义。<br>' +
          '<b>陷阱在 #2</b>：<span class="mono">com.target.pay.SignProxy.invoke</span> 名字里带 Proxy，' +
          '但它属于应用自己的包名，是<b>业务侧的代理层</b>，不是框架包装——' +
          '<span class="hit">判断依据永远是包名归属，不是名字里有没有 Proxy。</span></li>' +
          '<li><b>③ 业务入口 = #5</b> <span class="mono">com.target.pay.PayActivity$2.onClick</span>。' +
          '从栈底往上数，它是系统框架第一次把控制权交给 App 的那一帧。' +
          '注意它是<b>匿名内部类</b>（$2），这正是「按钮点击监听器」的典型形态——' +
          '顺着它可以找到 <span class="mono">setOnClickListener</span> 的注册点。</li>' +
          '</ul>' +
          '<p><b>碰到第二段栈（退化版）时应该得出什么结论：</b>规则会判它「已退化」——' +
          '无行号帧超过一半、单字母类名、同名帧重复。此时栈上唯一有用的信息是' +
          '「#1 是一个 native 方法」这个事实，而连它的类名都是 <span class="mono">com.target.a.a.a</span>。' +
          '<b>正确动作是换观测：用运行时打点或指令级 trace，而不是继续读这条栈。</b></p>',
        hint: '<b>三个规则，照着做就行：</b><br>' +
              '① <b>分层</b>：包名以 <span class="mono">java. / javax. / android. / androidx. / com.android.</span> 开头 → 系统与框架；' +
              '含 <span class="mono">reflect / $Proxy / $$ExternalSyntheticLambda / Lambda$</span> → 代理或合成帧；' +
              '其余属于应用包名 → 业务帧。<br>' +
              '② <b>业务边界</b>：从 <b>#1 往下</b>数，第一帧业务帧。<br>' +
              '③ <b>业务入口</b>：从 <b>最后一帧往上</b>数，第一帧业务帧。<br>' +
              '别被名字骗：叫 Proxy 的可能是业务代码，叫 invoke 的一定是通用入口。',
        after: T.note('ok', '实验做完了，收获是什么',
          '<p style="margin-bottom:0">你现在有一条可复核的判栈规则：<b>按包名分层 → 两个方向各取第一帧业务代码 → ' +
          '代理帧穿过不看</b>。<br>而且你见过它的退化形态：当名字和行号都没了，规则给出的结论是' +
          '<b>「换观测」</b>，而不是「再仔细看看」。</p>')
      },
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">栈的三段分法、两个方向的业务坐标（边界与入口）、' +
        '代理帧的处理方式、native 栈的「模块 + 偏移」读法，以及退化的三种表现与它的结论。<br>' +
        '与第 1、21 章的呼应关系：本章只讲<b>怎么读栈</b>；' +
        '<b>怎么在 Frida 里打出这条栈、怎么在几十个 so 里锁定模块</b>，分别在第 1 章与第 21.13。</p>')
    },

    /* ============================================================ 30.11 */
    {
      h: '30.11', title: '线索五 · UI 组件定位：从「现象」反推「代码」的最快一条路',
      html:
        '<p>如果你手里的线索是「这个界面上的某个按钮 / 某个列表 / 某个弹窗」，' +
        '那么 UI 反推往往是<b>所有线索里最快的一条</b>——因为它把「找代码」变成了「找 id」。</p>' +
        '<p>这条线索依赖一个前提：<b>界面元素与代码之间有一条稳定的桥</b>。' +
        '在原生 Android 上，这座桥就是 <b>资源 id</b>。</p>' +
        T.tbl(
          ['你的起点', '要拿到什么', '拿到之后做什么'],
          [
            ['界面上的一个控件（按钮、输入框、列表项）',
             '它所属的 <b>Activity / Fragment</b>，以及<b>布局文件</b>',
             '在布局里找到这个控件的 <b>资源 id</b>，然后去代码里搜这个 id'],
            ['一个资源 id（例如 <span class="mono">0x7f0b0056</span>）',
             '<b>它的名字</b>（<span class="mono">R.id.xxx</span>）与使用它的代码位置',
             '搜名字 → 命中 <span class="mono">findViewById</span> / 视图绑定 → 顺着找到<b>绑定的回调函数</b>'],
            ['一次点击行为（不知道控件在哪）',
             '当前界面的<b>控件树</b>与每个控件的属性',
             '按控件属性筛出那个控件 → 取它的 id / 文字 / 类名 → 回到上一步'],
            ['一个弹窗 / 提示（文案是动态的）',
             '<b>是谁弹的</b>',
             '界面层拿不到静态常量时，就用控件类型（对话框 / Toast / 自定义 View）去缩范围，再配合日志或 hook']
          ]) +
        T.card('三件工具，各自解决什么（命令形态随版本变化，<span class="pill warn">待核实</span>）',
          '<ul>' +
          '<li><b>系统侧的界面状态查询</b>：查询当前前台窗口与 Activity 归属，' +
          '回答「我现在看到的这个界面是哪个 Activity / 哪个进程」。<br>' +
          '<span class="small muted">输出字段名随版本变化，以目标机实测为准。</span></li>' +
          '<li><b>控件树导出</b>：把当前界面的控件树连同属性（文本、id、类名、可点击性）导出成结构文件，' +
          '回答「这个元素是什么、它的 id 是什么」。<br>' +
          '<span class="small muted">输出路径与是否需要额外权限随版本/ROM 变化，以实测为准。</span></li>' +
          '<li><b>布局检查器</b>：连接调试进程，直接看运行时的视图层级与属性，' +
          '回答「为什么这个控件是这个样子」。<b>它要求进程可调试</b>（回到 30.5）。</li>' +
          '</ul>' +
          '<p style="margin-bottom:0"><b>共同点：</b>它们三个都在回答「界面由什么组成」，' +
          '而不回答「代码为什么这么写」。<span class="hit">所以 UI 反推的产出永远是「一个切入点」，' +
          '不是「一个结论」。</span></p>') +
        T.note('key', '🔑 从资源 id 反查绑定函数：这条链的每一步都要说清',
          '<p>常见的两种绑定方式，决定你从 id 出发会遇到什么：</p>' +
          '<ul>' +
          '<li><b>动态绑定</b>：代码里显式注册点击回调。' +
          '从 id 出发能搜到注册那一行，<b>回调函数就在同一处（常常是匿名内部类或 lambda）</b>——链路最短。</li>' +
          '<li><b>静态绑定</b>：在布局里声明「点击时调用哪个方法」。' +
          '从 id 出发会先到布局，再从布局里的声明跳到方法名，<b>链接同样明确</b>。</li>' +
          '</ul>' +
          '<p style="margin-bottom:0">两种方式都说明同一件事：' +
          '<b>「界面元素 → 绑定函数」这条链是有限且可枚举的。</b>' +
          '在原生界面上，你几乎总能从「我点了这个按钮」走到「它执行了哪段代码」。' +
          '<br>而这条链会断的唯一情况，是界面元素根本不存在这个意义上——见下。</p>') +
        T.note('warn', '⚠️ 结构性排除：Flutter / 自绘 / 游戏引擎',
          '<p style="margin-bottom:0">当界面由 Flutter、自绘框架或游戏引擎渲染时，' +
          '你在屏幕上看到的一切都是<b>画出来的像素</b>：没有原生控件树、没有 resource-id、' +
          '没有 View 层级。<br>' +
          '此时 UI 反推不是「效果差一点」，而是<b>从概念上不成立</b>——' +
          '控件树导出的结果通常只有一个空白的大容器。' +
          '<span class="hit">正确反应是立刻划掉这条线索，改从别处入手</span>：' +
          '字符串搜索（Dart 的字符串常量通常仍落在 AOT 快照里）、' +
          '或者对渲染/通信层做动态观测。<b>不要在这里花第二个小时。</b></p>'),
      case: {
        source: 'kanxue',
        title: '[原创]Android逆向0基础入门-APK全面解析,动调与脱壳',
        date: '2025-03-07',
        author: 'rufeng12',
        target: '入门体系整理 + 配合练习题（如攻防世界「基础 Android」、BUU「简单注册器」）',
        background:
          '<p>这是一篇「把入门动作串成体系」的长文：从工具链、APK 结构，到' +
          '<b>怎么找出程序入口点</b>、<b>怎么识别加固并简单脱壳</b>、' +
          '<b>怎么定位一个界面的布局文件</b>、<b>怎么确定按钮绑定了哪个函数</b>、' +
          '最后到 Java 层与 Native 层的逆向分工。</p>' +
          '<p>把它放进本章的理由很直接：它演示的正是<b>线索五（UI 组件定位）</b>的标准范式——' +
          '<b>从一个看得见的界面元素，一步一步走到那段看不见的代码。</b></p>',
        points: [
          '从 manifest 的 <span class="mono">MAIN</span> / <span class="mono">LAUNCHER</span> 声明定位入口 Activity（静态结构的最外层抓手）',
          '在入口 Activity 的 <span class="mono">onCreate</span> 里，用 <span class="mono">setContentView</span> 的参数（资源 id）定位布局文件',
          '用 <span class="mono">findViewById</span> 的资源 id 找到具体控件，再看它如何被绑定',
          '区分<b>动态绑定</b>（代码里 <span class="mono">setOnClickListener</span>）与<b>静态绑定</b>（布局里声明点击方法）两条路',
          '资源文件在 APK 中的组织方式，以及「从 id / 名称反查资源」的做法',
          '壳的识别与简单的脱壳（<span class="mono">frida-dexdump</span> 一类的工具路线），让静态分析能继续'
        ],
        method: [
          '先熟悉工具链与 adb（作者原话：工具部分可以掠过）',
          '解析 APK 基本结构：manifest、classes.dex、resources.arsc、assets、lib、res、META-INF',
          '定位入口点：manifest → 入口 Activity → <span class="mono">onCreate</span>',
          '定位按钮绑定：先在 <span class="mono">onCreate</span> 里找动态绑定，再回到布局文件看静态绑定',
          '定位布局与资源：从 <span class="mono">setContentView</span> 的资源 id 与控件 id 双向对上',
          '再看 Java 层与 Native 层各自的逆向步骤，最后用四大组件与系统体系收尾'
        ],
        result:
          '<p>作者把「找入口 → 找界面 → 找控件 → 找绑定函数」整理成了一条可重复的流程，' +
          '并在若干练习题上走通（含简单加固样本的脱壳）。' +
          '文中对 manifest 字段、资源 id 在代码中的形态（如 <span class="mono">setContentView(0x7f04001a)</span>、' +
          '<span class="mono">findViewById(0x7f0b0056)</span>）都给了实际反编译截图与注释。</p>',
        terms: ['MAIN/LAUNCHER', 'setContentView', '资源 id', 'findViewById', 'setOnClickListener', '静态绑定', 'frida-dexdump'],
        limits:
          '<p>作者自述这是一篇入门体系整理：<b>工具部分「可以掠过，只做了工具的下载地址和简单介绍」</b>；' +
          '壳的部分是「简单分析梆梆免费加固」，属于入门强度的对抗；' +
          '示例以 CTF / 练习题为主，<b>没有涉及商业 App 的加固与风控强度</b>。' +
          '文章篇幅很长、覆盖面广，因此每一处的深度都有限。</p>',
        analysis:
          '<p><b>用本课方法论拆解：</b>这篇案例的每一步，都能对应到本章的一张表。</p>' +
          '<ul>' +
          '<li><b>它的起点是「现象」而不是「代码」</b>——这正是线索五的定义：' +
          '从看得见的界面出发。案例里最值钱的一句话是「锁定入口 Activity 的 <span class="mono">onCreate</span>」，' +
          '因为那是一个<b>确定的锚点</b>：界面→Activity→onCreate→布局→控件→绑定函数，每一步都有明确依据。</li>' +
          '<li><b>它示范了资源 id 为什么是好锚点。</b>资源 id 是编译期分配的，' +
          '在代码里以常量形式出现（案例截图里的 <span class="mono">0x7f…</span>），' +
          '所以它同时满足「可搜索」与「唯一」——这是 30.7 讲的搜索词质量标准。</li>' +
          '<li><b>它同时用到了线索二（静态结构）。</b>manifest 是「最便宜的一层结构信息」，' +
          '案例把它放在第一步，正是 30.6 排序判据一（失败几乎不花钱）的体现。</li>' +
          '<li><b>它没有碰到的边界，恰好是本章强调的边界。</b>案例全程在原生 View 树上工作；' +
          '如果换成 Flutter 界面，这条路径从第二步（控件树）就会断掉——' +
          '<span class="hit">所以学这条路径时，一定要同时记住它的失效条件。</span></li>' +
          '</ul>' +
          '<p>最后一点：案例里「简单加固 + 脱壳」这一段，也说明了本章的一条纪律——' +
          '<b>当静态结构被壳拿走后，正确的动作是先恢复可读性（脱壳），而不是硬读</b>（第 19 章）。</p>',
        link: 'https://bbs.kanxue.com/thread-285906-1.htm',
        linkNote: '看雪论坛 Android 安全版；正文较长（含大量截图），建议按小标题跳读。'
      },
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">UI 反推的四条起点、三件工具的分工、两条绑定路径，' +
        '以及唯一的「结构性排除」条件。<br>' +
        '这条线索的真正价值在于：<b>它把「找一个函数」变成了「找一个 id」</b>——' +
        '而 id 是可枚举、可搜索、可复核的。</p>')
    },

    /* ============================================================ 30.12 */
    {
      h: '30.12', title: '线索六 · Method Profiling / Trace：给你候选集，不给你证据',
      html:
        '<p>这条线索回答的问题是：<b>「按钮点下去之后，到底哪些方法被调用了？」</b>' +
        '在没有任何字符串可搜、结构也读不出来的情况下，它往往是你唯一的假设来源。</p>' +
        T.tbl(
          ['', '采样型（Profiling）', '插桩型（Instrument / Trace）'],
          [
            ['做法', '周期性抓取调用栈，统计热点', '在每个方法出入口插桩，记录完整的调用序列'],
            ['产出', '「哪些方法花的时间多」——<b>统计信息</b>', '「按时间顺序发生了哪些调用」——<b>序列信息</b>'],
            ['成本', '相对低（不逐方法插桩）', '高：改写字节码 / 重编译，且会显著拖慢程序'],
            ['主要漏洞', '<b>短方法会被丢掉</b>：采样间隔内跑完的方法根本不出现', '开销本身会改变程序行为；并且可能触发耗时类反调试'],
            ['适合', '先摸清「这段操作里的热点在哪」', '需要确认「这条链是不是真的走过」']
          ]) +
        T.note('key', '🔑 用它的正确姿势：当假设生成器，不当证据',
          '<p style="margin-bottom:0">Trace 的输出有一个容易上头的特点：<b>它看起来非常「全」</b>——' +
          '密密麻麻几千行方法调用。但请记住两件事：</p>' +
          '<ul>' +
          '<li><b>没出现 ≠ 没调用。</b>短方法、被内联的方法、采样窗口之外的方法，都可能不出现在结果里。' +
          '所以「目标方法没上 trace」不能推出「它没被执行」。</li>' +
          '<li><b>出现了 ≠ 起作用。</b>一个方法被调用，不代表它就是你要找的那一环；' +
          '很多框架方法会被调用几百次。</li>' +
          '</ul>' +
          '<p style="margin-bottom:0"><span class="hit">正确的用法是「先缩范围，再换手段验证」</span>：' +
          '用 Trace 把可能的候选压到个位数，然后回到便宜的那几条线索' +
          '（字符串搜索、调用栈、日志）去确认其中一个。<br>' +
          '第 21.5 的 r0tracer 与第 21.15 的 trace 过滤实验，讲的就是「怎么把几万行压成几个候选」——' +
          '那是这条线索真正的工程价值所在。</p>') +
        T.note('warn', '⚠️ 两个必须知道的盲区',
          '<p style="margin-bottom:0"><b>① 内联造成的静默缺失。</b>' +
          '编译器把函数体展开到调用处之后，那个函数<b>在运行时的调用关系里不存在了</b>——' +
          '你在 trace 里既看不到它，也看不到「谁调用了它」（这一点与 30.10 的栈退化是同一个根因）。<br>' +
          '<b>② 采样丢失与「越短越容易丢」。</b>恰恰是加密、签名这类短小密集的计算，' +
          '最容易被采样漏掉；而它们往往正是你的目标。' +
          '<span class="hit">所以用 Trace 时要主动问一句：我的目标如果很短，它会被漏掉吗？</span></p>'),
      quiz: {
        id: 'q30-5', chapter: 30, answer: 2,
        stem: '你用采样型 Profiling 采集了「点击登录按钮之后的方法调用」，' +
              '得到的列表里出现了一堆网络、序列化、UI 相关的方法，' +
              '<strong>但你怀疑的那个签名方法没有出现</strong>。下面哪个判断最站得住？',
        options: [
          { t: '可以确定签名方法没有被调用，说明签名是在别的地方（或别的进程）算的',
            why: '把「没出现」当成了「没调用」。采样会丢短方法，内联会让函数在调用关系里消失——这两条都足以让一个确实被执行的方法不出现在结果里。这是这条线索最经典的误判。' },
          { t: '把 Profiling 换成指令级 trace，把这段操作完整记录下来，就不会漏了',
            why: '方向部分正确（换更强的手段），但这是个昂贵的跳跃：指令级 trace 会显著拖慢程序，可能触发耗时类反调试，而且产出量巨大到需要额外一套过滤。在还不知道「是不是被采样漏掉」之前，先做更便宜的验证更好。' },
          { t: '先做一个便宜的验证：在目标方法上加一个计数打点，看它到底被调用几次；如果被调用却不出现，就确认是采样/内联造成的盲区',
            why: '正确。这个动作成本极低，而且它的两种结果都有明确含义：计数为零 → 假设错了，换方向；计数不为零但 trace 里没有 → 确认了盲区，此时再决定要不要上更重的 trace。用一个便宜动作把一个模糊状态变成二值判断，是本章反复强调的思路。' },
          { t: '说明这个 App 检测到了 Profiling 并隐藏了相关方法',
            why: '把「工具的能力边界」当成了「对手的主动行为」。反 Profiling 确实存在，但它的表现通常是「整体采集失效或被拖慢」，而不是「精准地少了一个方法」。用对抗解释工具缺陷，会让你在一个不存在的问题上开始写脚本。' }
        ],
        explain: '<b>这道题的核心是「没出现 ≠ 没调用」。</b><br>' +
                 '采样型 Profiling 的产出是<b>统计</b>，它天然会丢掉短方法；' +
                 '而内联会让一个方法在运行时的调用关系里彻底消失（30.10 讲过同一个根因）。<br>' +
                 '所以当你怀疑某个方法应该在、却没有出现时，正确的动作是：' +
                 '<b>用一个独立的、便宜的观测去验证「它到底有没有被调用」</b>——' +
                 '加一个计数打点、或者一个日志。这个动作会把「工具说没有」变成「我知道它有没有」。<br>' +
                 '<span class="hit">Trace 是假设生成器，不是证据；把它当证据是这条线索最常见的翻车方式。</span>'
      },
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">采样与插桩的分工、两条判据（没出现 ≠ 没调用、出现了 ≠ 起作用），' +
        '以及两个盲区（内联缺失、短方法被采样丢掉）。<br>' +
        '<b>它与逐行 hook 的成本对比也很清楚：</b>trace 一次采集覆盖全部调用，' +
        '而逐行 hook 需要你先知道勾哪里——所以 trace 的定位价值在于「生成假设」，而不是「证明结论」。</p>')
    },

    /* ============================================================ 30.13 */
    {
      h: '30.13', title: '线索七 · 日志线索：最便宜的记录，以及被清理后怎么找回',
      html:
        '<p>日志这条线索常被低估，因为它「看起来不像技术」。但它是唯一一条' +
        '<b>零环境依赖、零注入风险、并且天然带时间维度</b>的线索：不 root、不改包，也可能拿到关键信息。</p>' +
        T.card('四条实用的过滤思路（命令细节随版本变化，<span class="pill warn">待核实</span>）',
          '<ul>' +
          '<li><b>按进程过滤，而不是按全设备。</b>设备上同时有几十个进程在打日志；' +
          '不锁定进程，你读到的 99% 都是噪音。判据是「这条日志的进程号是不是目标进程」。</li>' +
          '<li><b>按 TAG 过滤，再用「排除法」去看没有 TAG 的行。</b>' +
          'TAG 是开发者留的索引，但真正关键的日志经常没有 TAG（框架输出、native 输出）。' +
          '所以「先按 TAG 定位模块，再放开看时间窗」比一直按 TAG 过滤更有效。</li>' +
          '<li><b>按时间窗过滤。</b>先记下「我按下按钮」的瞬间，只看那个窗口前后的日志。' +
          '<span class="hit">这一步能把几万行压到几十行，是所有过滤技巧里收益最高的。</span></li>' +
          '<li><b>按级别与关键字过滤。</b>错误与警告优先；关键字用业务词（订单、签名、支付）' +
          '而不是工具词。</li>' +
          '</ul>') +
        T.note('key', '🔑 崩溃栈为什么是「最高质量的一条日志」',
          '<p style="margin-bottom:0">一份崩溃日志一次给你四样东西：' +
          '<b>① 异常类型与消息</b>（它自己在说什么）、' +
          '<b>② 调用栈</b>（30.10 的完整入口）、' +
          '<b>③ 触发它的那条操作</b>（你可以复现）、' +
          '<b>④ 发生时刻</b>（可以对齐抓包与其它日志）。<br>' +
          '所以「目标会不会崩」这件事很有价值：<b>一个会崩的目标，等于自带了一个免费的调用栈来源</b>。' +
          '这也是 30.6 的成本阶梯里，调用栈那条线索的成本会因为「有崩溃日志」而从「中」掉到「低」的原因。</p>') +
        T.note('warn', '⚠️ 日志被加固清理之后，怎么把它找回来',
          '<p style="margin-bottom:0">加固方清理日志的手法很直接，找回的思路同样直接——' +
          '<b>从「谁在输出」出发，而不是从「输出了什么」出发</b>：</p>' +
          '<ul>' +
          '<li><b>换观测点</b>：日志被删了，但「写日志」这个动作还在。' +
          '在日志系统的入口（系统的日志接口、或者它自己封装的日志类）挂观测，' +
          '比去读已被清理的输出更可靠。</li>' +
          '<li><b>换输出目标</b>：很多日志框架支持重定向。' +
          '如果它写文件、写 socket、或者只在 debug 构建里启用，' +
          '那你的任务就从「读日志」变成「让它愿意写」或「找到它写的那个地方」。</li>' +
          '<li><b>换信息载体</b>：如果日志整条路都被堵死，那么「打印」这个行为本身还能被别的手段替代——' +
          '打调用栈（30.10）、打方法调用序列（30.12）、或者在关键 API 上直接取参数（第 24 章的自吐沙箱）。' +
          '<b>「我要的是一个观测点」，日志只是观测点的一种实现。</b></li>' +
          '</ul>' +
          '<p style="margin-bottom:0">第 19 章有一张加固与反制的全景图，日志清理在其中属于「降低对手可观测性」这一类；' +
          '第 24 章则把「让算法自己招供」做到了系统化。<b>本节只负责给你一个判断：日志这条线索失效时，' +
          '失效的是「输出」，不是「输出这个动作」。</b></p>'),
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">四条过滤思路（进程 / TAG + 放开 / 时间窗 / 级别与关键字）、' +
        '崩溃栈为什么质量最高，以及「日志被清理」之后的三个换向：' +
        '<b>换观测点、换输出目标、换信息载体。</b></p>')
    },
    /* ============================================================ 30.14 */
    {
      h: '30.14', title: '收口：给你一个 App 和一句话需求，按什么顺序试这七条',
      html:
        '<p>前面七节把七条线索分别讲了一遍。现在把它们装回一台机器：' +
        '<b>决策图</b>——每一步失败时你得到什么、下一步往哪走。</p>' +
        T.note('key', '🔑 决策图的三条元规则',
          '<p style="margin-bottom:0"><b>① 从最便宜的、失败也不花钱的动作开始</b>（字符串搜索、日志）。<br>' +
          '<b>② 任何一步拿到强证据，都可以直接跳到最贵的那一级</b>（例如崩溃栈给了类名与行号，直接下断点）。<br>' +
          '<b>③ 每一步失败都要能说出一句「我因此知道了什么」</b>——' +
          '说不出来，说明这一步白做了，换一个更有判别力的动作。</p>') +
        '<p>下表按<b>尝试顺序</b>排列——它与 30.6 的线索编号不是一回事：' +
        '编号是线索的身份（线索 3 永远是动态调试），而这里的顺序由成本决定（便宜的排前面）。' +
        '两者一起用，才不会把「线索几」和「第几步」混起来。</p>' +
        T.tbl(
          ['尝试顺序', '动作', '成功时你得到', '失败时你得到（<b>这一栏才是重点</b>）'],
          [
            ['<b>1</b>', '字符串搜索（URL / 提示语 / TAG / 算法常量 / 字段名）',
             '一个可读的入口：某个类、某个方法、某段配置',
             '「这段逻辑不是静态常量驱动的」→ 指向运行时拼接 / 服务端下发 / 字符串加密'],
            ['<b>2</b>', '日志与崩溃栈（含时间窗过滤）',
             '一次发生的完整记录；崩溃栈还能直接给出类名与行号',
             '「这条路径上没有留下可读记录」→ 换观测点，或确认自己没走在这条路径上'],
            ['<b>3</b>', '静态结构（manifest / 类型引用 / 调用图 / 注解）',
             '一张从入口到目标的结构草图',
             '「结构被处理过」（壳 / 混淆 / VMP）→ 这是加固的证据，转脱壳或运行时观测'],
            ['<b>4</b>', '调用栈（顺数据流或顺调用链）',
             '业务边界、业务入口、以及一条可复核的路径',
             '「关系被内联或折叠」→ 停用依赖名字的观测，改用地址与运行时打点'],
            ['<b>5</b>', 'UI 反推（控件树 / 资源 id / 绑定函数）',
             '界面元素与代码位置的直接对应',
             '「界面不是原生 View 树」→ 这条线索出局，字符串与运行时观测顶上'],
            ['<b>6</b>', 'Profiling / Trace（按操作窗口采集）',
             '一批候选方法（假设来源）',
             '「采样丢了 / 内联缺失 / 全是框架噪音」→ 候选不可靠，回到 1–4 去交叉验证'],
            ['<b>7</b>', '动态调试（Smali 断点 / IDA attach）',
             '第一手现场：寄存器、内存、真实参数',
             '「环境配不上 或 对方在检测」→ 抢时序，或把观测点下沉一层'],
            ['<b>8</b>', '<b>七条都没成：换观测层，而不是再试一遍</b>',
             '把观测点下沉：内核 / syscall / 自吐沙箱 / 模拟执行',
             '——（到这一步，问题往往已经不是「工具不够」，而是「目标定义错了」，见下面的决策演练）']
          ]),
      stage: {
        title: '决策图 · 拿到一个 App 和一句话需求，按这个顺序试',
        speed: 1900,
        render:
          '<div class="flow-col" style="gap:9px">' +
            '<div class="flow-row"><span class="pill ok mono">①</span>' +
              '<span class="blk" id="f1">字符串搜索</span>' +
              '<span class="muted small">搜不到 → 知道「不是静态常量」</span></div>' +
            '<div class="flow-row"><span class="pill ok mono">②</span>' +
              '<span class="blk" id="f2">日志 / 崩溃栈</span>' +
              '<span class="muted small">没记录 → 换观测点，或确认路径不对</span></div>' +
            '<div class="flow-row"><span class="pill acc mono">③</span>' +
              '<span class="blk" id="f3">静态结构</span>' +
              '<span class="muted small">读不出结构 → 这是加固的证据</span></div>' +
            '<div class="flow-row"><span class="pill acc mono">④</span>' +
              '<span class="blk" id="f4">调用栈</span>' +
              '<span class="muted small">栈退化 → 停用依赖名字的观测</span></div>' +
            '<div class="flow-row"><span class="pill acc mono">⑤</span>' +
              '<span class="blk" id="f5">UI 反推</span>' +
              '<span class="muted small">非原生界面 → 这条线索出局</span></div>' +
            '<div class="flow-row"><span class="pill warn mono">⑥</span>' +
              '<span class="blk" id="f6">Profiling / Trace</span>' +
              '<span class="muted small">只有候选集 → 回 1–4 交叉验证</span></div>' +
            '<div class="flow-row"><span class="pill bad mono">⑦</span>' +
              '<span class="blk" id="f7">动态调试</span>' +
              '<span class="muted small">挂不上 → 抢时序，或下沉观测层</span></div>' +
            '<div class="flow-row" style="margin-top:6px;padding-top:10px;border-top:1px dashed var(--line)">' +
              '<span class="pill bad" id="mark">🎯 每一步的失败都要能说出一句「我因此知道了什么」</span></div>' +
            '<div class="note" id="fb"><div class="note-h">每一步失败时，你会得到什么</div>' +
              '<p style="margin-bottom:0">点「播放」：每点亮一条线索，下面这块就换成它失败时的信息产出。</p></div>' +
          '</div>',
        reset: () => {
          ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'].forEach(i => S(i, ''));
          CLS('mark', 'pill bad');
          SET('mark', '🎯 每一步的失败都要能说出一句「我因此知道了什么」');
          SET('fb', '<div class="note-h">每一步失败时，你会得到什么</div><p style="margin-bottom:0">点「播放」：每点亮一条线索，下面这块就换成它失败时的信息产出。</p>');
        },
        steps: [
          { run: () => { S('f1', 'active');
                         SET('fb', '<div class="note-h">① 字符串搜索失败</div><p style="margin-bottom:0">你得到：<b>这段逻辑不是静态常量驱动的</b>。<br>它把可能性砍成三支：运行时拼接（顺调用栈）、服务端下发（抓包与协议）、字符串加密（脱壳与解密）。<b>三支的下一步完全不同，但都比「继续换词搜」有价值。</b></p>'); },
            note: '<b>第一步永远从它开始。</b>理由只有一个：搜不到的代价是三十秒。' +
                  '<span class="hit">它是唯一一条「失败也比不做更有信息」的线索。</span>' },
          { run: () => { S('f1', 'done'); S('f2', 'active');
                         SET('fb', '<div class="note-h">② 日志与崩溃栈失败</div><p style="margin-bottom:0">你得到：<b>这条路径上没有留下可读记录</b>。<br>两种可能，都必须区分：是<b>被清理了</b>（加固在降低你的可观测性），还是<b>你压根没走在这条路径上</b>（操作没触发、进程不对）。<b>两者的处理方式完全相反：前者要换观测点，后者要换触发方式。</b></p>'); },
            note: '<b>② 与 ① 同级便宜，但它的独特价值是「时间」。</b>' +
                  '日志能对齐「我做了什么」与「程序做了什么」，这是别的线索都给不了的维度。' +
                  '如果有崩溃栈，这一步的收益会直接顶到最高——它是完整调用栈的免费来源。' },
          { run: () => { S('f2', 'done'); S('f3', 'active');
                         SET('fb', '<div class="note-h">③ 静态结构失败</div><p style="margin-bottom:0">你得到：<b>结构被处理过</b>。<br>注意这个结论的分量——它不只是「静态不好读」，而是「有人在系统性地隐藏结构」。<br>下一步是明确的：<b>先恢复可读性</b>（脱壳，第 19 章），或者接受它、转而做运行时观测。<b>硬读被壳打散的结构是最亏的一种做法。</b></p>'); },
            note: '<b>③ 的成本是「要读」。</b>它需要的不是环境，是耐心：把一堆符号关系连成一张图。' +
                  '它的产出是一张<b>从入口到目标的结构草图</b>，这张草图后面每一步都要用。' },
          { run: () => { S('f3', 'done'); S('f4', 'active');
                         SET('fb', '<div class="note-h">④ 调用栈失败（或退化）</div><p style="margin-bottom:0">你得到：<b>调用关系被内联或折叠了</b>。<br>这条信息的价值在于它<b>否定了一整类手段</b>：所有「靠名字读关系」的办法（读栈、按名字筛选、按类名搜索）都会一起失效。<br>于是你转向不依赖名字的观测：<b>地址、偏移、运行时打点、指令级 trace</b>。</p>'); },
            note: '<b>④ 的成本取决于你手上有什么。</b>有崩溃日志 → 几乎免费；' +
                  '要靠注入打栈 → 与 Hook 环境同价；native 侧 unwind → 再贵一档。' +
                  '<span class="hit">所以「先做②，让④变便宜」是一个很实际的策略。</span>' },
          { run: () => { S('f4', 'done'); S('f5', 'active');
                         SET('fb', '<div class="note-h">⑤ UI 反推失败</div><p style="margin-bottom:0">你得到：<b>界面不是原生 View 树</b>（Flutter / 自绘 / 引擎）。<br>这是唯一一条「结构性排除」的线索——<b>它不是弱，是不成立</b>，所以不要做第二次尝试。<br>有意思的是：它同时提示了另一条线索仍然有效——<b>字符串搜索</b>（Dart 的字符串常量通常仍落在 AOT 快照里）。</p>'); },
            note: '<b>⑤ 是「从现象反推代码」最快的一条路</b>，前提是现象发生在原生界面上。' +
                  '它的产出通常不是结论，而是<b>一个精确的切入点</b>：一个资源 id、一个 Activity。' },
          { run: () => { S('f5', 'done'); S('f6', 'active');
                         SET('fb', '<div class="note-h">⑥ Profiling / Trace 不够用</div><p style="margin-bottom:0">你得到：<b>一批候选，但没有证据</b>。<br>此时最危险的动作是「在候选里挑一个最像的，当成结论」——<br>正确动作是<b>回到 1–4 去验证它</b>：搜它的名字、看它的调用栈、加一条打点日志。<b>候选必须被验证成证据，否则它只是一张可能性清单。</b></p>'); },
            note: '<b>⑥ 是「假设生成器」。</b>它的价值在「没有字符串可搜、结构也读不出来」时最明显——' +
                  '它是你从零到有的第一份候选清单。<br>' +
                  '<b>但请记住它的两个盲区：短方法会被采样丢掉、被内联的方法根本不在调用关系里。</b>' },
          { run: () => { S('f6', 'done'); S('f7', 'active');
                         SET('mark', 'pill warn'); SET('mark', '⚠️ 最贵的一级：它要求你先知道「断在哪」');
                         SET('fb', '<div class="note-h">⑦ 动态调试失败</div><p style="margin-bottom:0">你得到的是本章最有价值的一次失败：<b>确认了「有人不希望被调试」</b>（或者你的环境确实没配通，两者要先分清，见 30.5）。<br>接下来的路只有两条：<b>抢时序</b>（在它的检测之前就位），或者<b>把观测点下沉一层</b>（syscall / 内核 / 自吐沙箱，第 13、11、24 章）。</p>'); },
            note: '<b>⑦ 是唯一能给出第一手现场的手段，所以它必须被用在最确定的地方。</b><br>' +
                  '它的成本有一半在环境上（debuggable、JDWP、反调试），' +
                  '一半在选点上（断在哪一行）。<span class="hit">前六条线索的真正用途，就是替你付掉「选点」这一半的成本。</span>' },
          { run: () => { CLS('mark', 'pill ok');
                         SET('mark', '✅ 七条都不是「试一遍」，而是「每一步都把范围砍一半」');
                         SET('fb', '<div class="note-h">收口</div><p style="margin-bottom:0">把这张图压缩成一句话：<br><b>从最便宜的、失败也不花钱的动作开始；每一步失败都要产出一条能把范围砍小的信息；' +
                           '拿到强证据就跳级；被结构性排除的线索直接划掉；七条都试过还没定位到，就换的是「观测层」或「目标定义」，而不是再试一遍。</b></p>'); },
            note: '<b>收尾：这张图不是流程，是「信息产出的账本」。</b><br>' +
                  '每一次尝试都要记一笔：<b>我付出了什么成本，换回了哪一条能砍范围的信息。</b><br>' +
                  '记不出来，就说明你在原地转圈——这是本章能给你的最实用的一条自检。' }
        ]
      },
      lab: {
        title: '实验：七条线索的选型器（真实成本-收益规则表）',
        goal: '算出首选 + 说清理由与失败后果',
        intro:
          '<p>下面六条情境是真实任务里最常见的六种起点。<b>把其中一条复制到第一个输入框</b>' +
          '（也可以写你自己的情境，规则会从文字里识别事实）。</p>' +
          T.tbl(
            ['#', '情境（可直接复制）'],
            [
              ['1', '只知道界面上一个按钮，按钮文字是「立即支付」，界面是原生的。'],
              ['2', '只知道一句报错提示「签名校验失败」，它由服务端返回，App 用一个弹窗把它显示出来；APK 已加固，本地搜不到这句文案。'],
              ['3', '只有一个抓到的密文参数：请求 body 里的 sign 是一串 hex，其它什么都不知道。'],
              ['4', '只有一份崩溃日志：NullPointerException，栈顶是 com.target.pay.SignUtil.buildSign。'],
              ['5', '界面完全是 Flutter 画的，没有任何原生 View 树；你只知道某个按钮的位置。'],
              ['6', '目标是一个 native 里的算法，so 已经 strip，符号被剥离了。']
            ]) +
          '<p>规则从情境里识别 <b>事实</b>（有明文文本 / 只有密文 / 有崩溃栈 / 界面非原生 / 没有 root …），' +
          '再按每条线索自己的<b>成本修正与收益修正</b>算出效益，最后排序。' +
          '<span class="hit">你不需要猜评委的想法——规则全写在选型器下面那张表里，可以先自己算一遍。</span></p>',
        inputs: [
          { key: 'scene', label: '情境描述（复制上面任意一条，或写你自己的）',
            hint: '规则会从文字里识别事实', type: 'textarea', rows: 3,
            value: '只知道界面上一个按钮，按钮文字是「立即支付」，界面是原生的。' },
          { key: 'pick', label: '你决定最先试哪一条线索？', hint: '填编号或名字，如「1」或「字符串搜索」', value: '' },
          { key: 'why', label: '理由 + 失败后果', hint: '两件事都要写：为什么先试它；它失败时你会得到什么信息、下一步去哪',
            type: 'textarea', rows: 3, value: '' }
        ],
        runLabel: '🔍 让规则算一遍',
        autorun: true,
        run: v => window.CH30X.rankHtml(window.CH30X.score(window.CH30X.detect(v.scene || '')), window.CH30X.detect(v.scene || '')),
        expected: v => {
          const factIds = window.CH30X.detect(v.scene || '');
          const ranked = window.CH30X.score(factIds);
          const best = ranked[0] ? ranked[0].eff : 0;
          const acceptable = ranked.filter(c => !c.blocked && c.eff === best);
          const pickId = window.CH30X.matchClue(v.pick);
          const picked = pickId ? ranked.filter(c => c.id === pickId)[0] : null;
          const okPick = !!picked && acceptable.some(c => c.id === picked.id);
          const reasonOk = picked ? window.AKKC_hasConcept(v.why || '', picked.whyAny) : false;
          const failOk = window.AKKC_hasConcept(v.why || '',
            ['失败', '搜不到', '不命中', '没有命中', '得不到', '后果', '代价', '下一步', '换一条', '换线索', '退一步', '出局', '排除']);
          const ok = okPick && reasonOk && failOk;
          const want = acceptable.map(c => '#' + c.no + ' ' + c.name).join(' 或 ');
          let detail = '<b>规则算出的首选：</b>' + (want || '（无）') +
                       '<span class="muted small">（效益 ' + best + '；并列的任何一条都算对）</span><br>' +
                       '<b>你选的是：</b>' + (picked ? ('#' + picked.no + ' ' + picked.name) : '（没填或没认出来）') +
                       (okPick ? ' <span class="hit">✔ 在并列集合里</span>' : ' <span class="miss">✘ 不是效益最高的那一条</span>') + '<br>' +
                       '<b>理由：</b>' + (reasonOk ? '<span class="hit">✔ 说到了这条线索的适用判据</span>' : '<span class="miss">✘ 还没说清「为什么是它」</span>') + '<br>' +
                       '<b>失败后果：</b>' + (failOk ? '<span class="hit">✔ 写了失败时会得到什么</span>' : '<span class="miss">✘ 缺这一半——这一栏比理由更值钱</span>');
          if (picked && picked.why.length) {
            detail += '<div class="lab-note"><b>本情境下这条线索的修正项：</b>' + picked.why.join('；') + '</div>';
          }
          if (picked) {
            detail += '<div class="lab-note"><b>它失败时你会得到：</b>' + picked.fail + '</div>';
          }
          return { ok: ok, detail: detail };
        },
        showAnswer:
          '<p><b>规则表（和引擎里跑的是同一张）</b>：每条线索有一个基准成本与基准收益，' +
          '情境里识别到的事实会加减它们，<b>效益 = 收益 / 成本</b>，按效益排序；' +
          '被结构性排除的线索（例如非原生界面上的 UI 反推）直接置底。</p>' +
          '<p><b>六条预设情境下，规则算出的首选是</b>（编号与 30.6 的线索编号一致）：</p>' +
          '<ul>' +
          '<li><b>情境 1（按钮文字）</b>：效益最高的是 <b>线索 1 字符串搜索</b> 与 <b>线索 5 UI 反推</b>（并列）。' +
          '明文文案可以直接搜；而界面是原生的，资源 id 这条路也成立。</li>' +
          '<li><b>情境 2（服务端提示 + 已加固 + 弹窗）</b>：<b>线索 5 UI 反推</b>。' +
          '文案本地搜不到（服务端下发）、加固又压低了静态收益，' +
          '于是从「弹窗这个控件」反查「谁弹的」成了效益最高的一步。</li>' +
          '<li><b>情境 3（只有密文参数）</b>：<b>线索 4 调用栈</b>。' +
          '密文是天然的锚点——从「谁写入了这串字节」出发，顺着调用链往上找，' +
          '比漫无目的地搜字符串有效得多。</li>' +
          '<li><b>情境 4（崩溃日志）</b>：<b>线索 4 调用栈</b> 与 <b>线索 7 日志</b>（并列）。' +
          '崩溃栈本身就是一份高质量调用栈：它把这条线索的成本压到了最低。</li>' +
          '<li><b>情境 5（Flutter 界面）</b>：<b>线索 1 字符串搜索</b>。' +
          'UI 反推（线索 5）被<b>结构性排除</b>；而 Dart 的字符串常量通常仍落在 AOT 快照里，' +
          '所以「搜字符串」这条最便宜的路并没有一起失效。</li>' +
          '<li><b>情境 6（native 算法 + 已 strip）</b>：<b>线索 2 静态结构</b> 与 <b>线索 1 字符串搜索</b>（并列）。' +
          '符号被剥离会压低「按名字读」的收益，但 <b>导入表、常量与交叉引用不受影响</b>——' +
          '这三样恰好是 native 静态结构的核心抓手。</li>' +
          '</ul>' +
          '<p><b>这张表真正想教你的不是答案，而是「修正项」这个概念</b>：' +
          '同一个线索在不同情境下的效益完全不同。<span class="hit">' +
          '会做定位的人，脑子里装的是这张修正表，而不是一句「先搜字符串」。</span></p>',
        hint: '<b>先看规则算出的表，再回来填。</b>填的时候记住三件事：<br>' +
              '① <b>效益并列的都算对</b>——例如情境 1 里字符串搜索和 UI 反推效益相同，选哪个都对；<br>' +
              '② <b>理由是「为什么这条线索在这个情境下便宜」</b>，要用情境里的词（明文 / 服务端 / 原生界面 / 崩溃 / 密文 / Flutter / strip / native）；<br>' +
              '③ <b>失败后果</b>是必答项：写清「它失败时我因此知道了什么」。',
        after: T.note('ok', '实验做完了，收获是什么',
          '<p style="margin-bottom:0">你手上现在有一张可复算的表：<b>情境 → 事实 → 成本修正 → 效益排序</b>。<br>' +
          '换一个真实任务时，你不需要凭感觉选线索——把手上有什么写下来，' +
          '让同一套规则算一遍，再核对它和你的直觉是否一致。<b>不一致的地方，就是你要补的认知。</b></p>')
      },
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境三 · 七条线索全试过，还是没定位到',
            scenario: '<b>情境：</b>你已经做了下面这些事，并且每一步都保留了记录：<br>' +
                      '· 字符串搜索：把 URL、界面文案、日志 TAG、常见算法常量都搜过，<b>没有可用命中</b>；<br>' +
                      '· 静态结构：反编译出来的类全是壳的代码，调用图对不上；<br>' +
                      '· 日志：logcat 里只有系统噪音，业务 TAG 一条都没有；<br>' +
                      '· 调用栈：能打出来的栈全是框架帧，业务帧名字是单字母；<br>' +
                      '· UI 反推：界面是自绘的，控件树里只有一个空白容器；<br>' +
                      '· Trace：开了采样，得到几千行候选，逐个看下来没有一个是「签名」相关的；<br>' +
                      '· 动态调试：一附加就退出（已确认是主动检测，不是环境问题）。<br>' +
                      '<span class="small muted">你的需求原话是：「找出 App 本地计算签名参数的代码」。</span>',
            q: '下一步最该做的是：',
            choices: [
              { t: 'A. 把这七条线索各再试一遍，但力度加大：搜更多关键词、开全量 trace、上更强的反调试绕过', next: 'na' },
              { t: 'B. 回到需求本身，把「定位某个函数」拆成「可观测的输入输出」：先确定签名参数的输入（哪些字段）与输出（长度/字符集/是否随输入变化），再决定用哪一层的手段去观测', next: 'nb' },
              { t: 'C. 直接把观测点下沉到内核：上 eBPF / 内核模块记录所有 syscall 与内存操作', next: 'nc' },
              { t: 'D. 结论是这个 App 无法分析，向项目方报告失败', next: 'nd' }
            ]
          },
          na: {
            label: '选 A', terminal: true, verdict: 'bad',
            verdictTitle: '这不是「力度不够」，是「同一层次的手段已经被穷尽」',
            result: '<b>认知根源：把「没有结果」当成了「尝试得不够狠」。</b><br>' +
                    '请注意你这七次尝试有一个共同点：<b>它们全部发生在「用户态、运行时的同一个层次」上</b>。' +
                    '在这个层次里，你已经把可用的观测方式几乎穷尽了。<br>' +
                    '「加大力度」的三种形式各有硬伤：<br>' +
                    '· <b>搜更多关键词</b>：搜索失败的结论已经明确（不是静态常量），再多关键词不会改变这个结论；<br>' +
                    '· <b>开全量 trace</b>：候选集从几千行变成几万行，只会让筛选更难，而且耗时会触发耗时类检测；<br>' +
                    '· <b>上更强的绕过</b>：在不知道检测点的情况下绕过，往往触发新的检测，越绕越死（30.5 决策演练）。<br>' +
                    '<span class="hit">当同一层次的手段被穷尽时，正确的动作是「换层次」或「换问题」，不是「重复」。</span>' },
          nb: {
            label: '选 B', terminal: true, verdict: 'good',
            verdictTitle: '正确：先检查「定位目标」这件事本身是不是可执行的',
            result: '<b>七条线索全部失败时，最可疑的往往不是工具，而是目标定义。</b><br>' +
                    '你现在的需求是「找出本地计算签名的代码」——这是一个<b>位置型目标</b>，' +
                    '它要求你必须先看到代码、或者看到运行中的执行者。而你已经确认：' +
                    '代码被壳拿走了、运行时行为被反调试挡着。<b>在这个前提不变的情况下，位置型目标不可达。</b><br>' +
                    '<b>正确的做法是把它降级成「行为型目标」：</b><br>' +
                    '① <b>先确定输入</b>：签名参数依赖哪些字段（时间戳？订单号？设备信息？）——' +
                    '这些可以通过<b>改动输入、观察输出</b>来确定，完全不需要看代码；<br>' +
                    '② <b>再确定输出特征</b>：长度、字符集、是否随同一输入稳定、是否与某个已知算法（第 8、9 章的指纹库）相似；<br>' +
                    '③ <b>然后选观测层</b>：如果只需要「同样的输入得到同样的输出」，' +
                    '那你要的其实是<b>可复现的调用能力</b>，而不是源码——' +
                    '第 7 章的模拟执行、第 24 章的自吐沙箱都是为这一目标设计的；' +
                    '如果必须要看到算法内部，才谈得上第 13 章的内核观测或第 6 章更下层的手段。<br>' +
                    '<b>为什么这个顺序是对的：</b>它把「一个做不到的位置型目标」换成了' +
                    '「一组做得到的行为型目标」，而且<b>换完之后你立刻知道该用哪一层工具</b>——' +
                    '因为需求已经说明了你要的是「输入输出」还是「内部过程」。<br>' +
                    '<span class="small muted">这也解释了一个现象：经验丰富的人遇到硬目标时，' +
                    '第一反应常常是「你到底要什么」，而不是「再试个工具」。</span>' },
          nc: {
            label: '选 C', terminal: true, verdict: 'bad',
            verdictTitle: '下沉是对的，但现在下沉是盲目的',
            result: '<b>认知根源：把「更底层」等同于「更强」。</b><br>' +
                    '内核观测确实是本章决策图的第 8 步，也确实是打破用户态对抗的正当路线（第 11、13 章）。' +
                    '但它有一个前提：<b>你得知道要观测什么。</b><br>' +
                    '内核层给你的是「所有 syscall / 所有内存操作」——' +
                    '数据量比用户态 trace 又大了一个数量级。在你还不知道「签名的输入是什么、' +
                    '它是不是一定要发系统调用、它的输出长什么样」的时候，' +
                    '你只是把「几千行候选」换成了「几百万行候选」。<br>' +
                    '<b>更实际的一点：</b>签名的核心计算很可能全在用户态完成（纯数学运算，不涉及 syscall）。' +
                    '如果它不发系统调用，内核层根本看不到它——你会得到一个「什么都抓到了，就是没有它」的结果。' +
                    '<span class="hit">下沉的价值取决于「目标行为是否经过那一层」，' +
                    '而判断这一点，恰恰要先用行为型目标去试探。</span>' },
          nd: {
            label: '选 D', terminal: true, verdict: 'bad',
            verdictTitle: '把「当前方法不可达」当成了「目标不可达」',
            result: '<b>认知根源：用「我这套方法失败了」代替了「目标本身无法达成」。</b><br>' +
                    '这两件事之间有巨大的距离。你验证过的是：<b>在用户态、用这七类线索、' +
                    '在当前的对抗强度下，位置型目标不可达。</b>' +
                    '这是一个有边界、有前提的结论——它甚至是一份很有价值的报告结论。<br>' +
                    '而「无法分析」是一个无边界的结论，它需要排除：换观测层（第 11、13 章）、' +
                    '换执行环境（第 7 章的模拟执行、第 24 章的自吐沙箱）、' +
                    '换等价目标（行为复现代替源码还原）——<b>这些都还没试。</b><br>' +
                    '<b>报告的正确写法是分级的：</b>' +
                    '「已完成的尝试与结论 → 失败的确切层次 → 若要继续需要的条件（设备/时间/权限）→ ' +
                    '以及一个降级目标是否可接受」。这比一句「做不了」有用得多，' +
                    '也是第 29 章审计视角里「结论要能被复核」的要求。' }
        }
      },
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">一张八行的决策图（七条线索 + 第 8 步「换观测层」），' +
        '以及每个决策演练里被反复强调的那句话：<b>失败时要产出一条能把范围砍小的信息。</b><br>' +
        '最后那个演练的结论值得单独记住：<b>当所有用户态线索都穷尽时，先检查目标定义，再考虑下沉观测层。</b></p>')
    },

    /* ============================================================ 30.15 */
    {
      h: '30.15', title: '实战案例：不靠符号，靠「函数形状」筛出 VMP 入口',
      html:
        '<p>下面这篇案例几乎是本章方法论的实物版：<b>它没有一行符号可以用</b>，' +
        '却靠「函数的形状 + 交叉引用」把虚拟机入口从成千上万个函数里筛了出来，' +
        '再用 Frida 做具体确认。</p>' +
        T.note('key', '🔑 读案例时盯三件事',
          '<p style="margin-bottom:0"><b>① 他把「经验判据」写成了可执行的条件</b>（这一步是本章最想教的技能）；' +
          '<b>② 他的收敛依据是交叉引用</b>（很多调用者指向同一个被调用者）；' +
          '<b>③ 他的 trace 被拆成了采集 / 查看 / 分析三段</b>——' +
          '说明原始 trace 本身不是结论，这与 30.12 的立场一致。<br>' +
          '<span class="pill warn">说明</span>：VMP 本身的原理在第 6 章，' +
          '本案例在这里只作为「定位方法论」的样本，<b>不展开讲虚拟化保护本身</b>。</p>'),
      case: {
        source: 'kanxue',
        title: '[原创] VMP攻略笔记',
        date: '2026-03-02',
        author: 'Whoami默',
        target: '某 VMP 保护样本（ARM64 so）· 作者环境：Python 3.11 / IDA 9.2 / Frida hluda-server 16.0.10',
        background:
          '<p>作者记录了一次围绕 VMP 样本的完整逆向过程：<b>从入口定位开始</b>，' +
          '再到混淆对抗、执行路径还原、关键机制理解，最后基于这些结论自己做了一个虚拟化加固。</p>' +
          '<p>其中与本章最相关的是第一部分：<b>虚拟机入口</b>。' +
          '作者的原话是「VMP 的入口函数特征确实不太好找」——' +
          '因为这正是 VMP 的设计目标之一：<b>让「从哪进去」这件事无法靠名字判断</b>。' +
          '于是他转向了「形状」。</p>',
        points: [
          '入口定位不依赖任何符号：改用 <b>Wrapper 函数形态</b>作为判据',
          '六条形态判据（作者原文）：指令数极少（一般少于 20 条）、只存在一条跳转指令、' +
          '存在一条固定目标跳转（BL 指令）、以 <span class="mono">ret</span> 结束、' +
          'CALL 与 RET 之间指令数很少（一般小于 3）、CALL 之后不修改 <span class="mono">X0/W0</span>',
          '用 IDAPython 遍历全部函数，按上述条件自动筛选 Wrapper，' +
          '再按「<b>至少 15 个 Wrapper 指向同一个被调用者</b>」收敛出候选入口（原文阈值：<span class="mono">MIN_WRAPPER_COUNT = 15</span>）',
          '混淆对抗三件套：BL 混淆还原、F5 干扰处理、BR 跳转还原（按指令 pattern 搜索 + 分段验证后 patch 回 IDA，再重新加载分析）',
          '跟踪工具链拆成三段：Trace 工具、Trace 查看工具、Trace 分析工具',
          '机制整理阶段落到具体结构：VmState 数据结构与管理、ByteCode 与 ReTable 的重定位、' +
          'ByteCode 解析、不定参数与 ABI 约定、<b>符号与 RTTI 泄露的信息</b>、虚拟寄存器机制'
        ],
        method: [
          '先列出可复现的环境（IDA / Frida 版本 / Python 版本）',
          '把「什么样的函数像 VM 入口的包装器」写成六条可判定的条件',
          '用脚本遍历函数集合做特征筛选，得到 (被调用者 → 调用者列表) 的映射',
          '用「多个 Wrapper 指向同一目标」做阈值收敛，输出候选入口',
          '再用 Frida 对候选地址做具体确认（动态侧验证静态结论）',
          '还原混淆（BL / BR / F5 干扰）并重新加载分析，让结构可读',
          '采集并分析 trace，理解执行路径',
          '逐项整理 VM 机制（状态、字节码、ABI、符号泄露、寄存器模型）'
        ],
        result:
          '<p>作者筛出了 VM Entry 候选地址（脚本会打印每个候选及其对应的 Wrapper 列表），' +
          '并在此基础上完成了混淆还原与执行路径分析，' +
          '最后把整理出的机制用在了自己的虚拟化实现上：' +
          '离线把函数翻译成虚拟指令载荷、运行时接管导出符号并路由到解释执行。</p>',
        terms: ['VMP', 'Wrapper 函数', '交叉引用', 'IDAPython', 'BL / BR 混淆', 'Trace', 'RTTI', '虚拟寄存器'],
        limits:
          '<p>作者自述与本文可核实的信息：</p>' +
          '<ul>' +
          '<li><b>样本未公开</b>：帖中写的是「金罡大佬同款」，项目与样本地址以加密字符串给出。</li>' +
          '<li><b>脚本与 IDA 版本绑定</b>：代码使用了 IDA 9.2 的接口（例如函数指令迭代器），' +
          '换版本可能需要改写。</li>' +
          '<li><b>六条形态判据是经验性的</b>：作者用「至少 15 个 Wrapper 指向同一目标」来降低误报，' +
          '这相当于承认单条判据不足以定案——<b>它给出的是候选集，不是唯一答案</b>。</li>' +
          '<li>文章是「笔记」体裁，机制部分为要点式记录，未逐条给出完整推导。</li>' +
          '</ul>',
        analysis:
          '<p><b>用本课方法论拆解：这篇案例几乎是 30.8 与 30.14 的实物演示。</b></p>' +
          '<ul>' +
          '<li><b>它示范了「把经验判据写成可执行条件」。</b>「VM 入口不好找」是一句经验，' +
          '而作者把它翻译成了六条机器可判定的条件（指令条数、跳转条数、是否以 ret 结束、' +
          '调用后是否修改返回值寄存器）。<span class="hit">这正是 30.8 讲的「静态结构」该有的样子：' +
          '不是盯着反汇编猜，而是先把「像什么」定义成可枚举的形状。</span></li>' +
          '<li><b>它的收敛依据是交叉引用。</b>「多个 Wrapper 指向同一个被调用者」——' +
          '这条规则的逻辑是：一个被大量薄包装器调用的函数，几乎一定是<b>统一入口</b>。' +
          '这正是 30.8 里 native 静态结构的第三个抓手（谁引用了这段代码）被自动化之后的样子。</li>' +
          '<li><b>它印证了 30.6 的成本排序。</b>作者没有一上来就 attach 调试，' +
          '而是先用 IDA 脚本做了一次<b>批量静态筛选</b>：成本低、可重复、结果可复核。' +
          '动态侧（Frida）只用来「对候选做具体确认」——<b>先用便宜的筛，再用贵的定</b>。</li>' +
          '<li><b>它对 trace 的处理印证了 30.12 的立场。</b>' +
          '作者把跟踪拆成「采集 / 查看 / 分析」三段工具，' +
          '这等于承认「原始 trace 不是结论」：<b>采集只是原料，分析才是产出。</b>' +
          '这也是为什么本章把 Profiling 的产出定义为「候选集」。</li>' +
          '<li><b>它还给了一个本章没强调但很重要的信号：</b>' +
          '作者在机制整理阶段专门列了一项「符号与 RTTI 泄露信息」——' +
          '<b>在符号被剥离的目标里，RTTI 与异常相关的元数据往往会残留</b>，' +
          '这是 30.8「注解与泛型残留」在 native 侧的对应物。</li>' +
          '</ul>' +
          '<p><b>边界说明：</b>本案例的目标是 VMP，' +
          '所以它演示的是「最难的一类静态结构」；' +
          '普通 App 里的定位远比这简单——但<b>方法论完全相同</b>：' +
          '先定义形状，再批量筛选，最后用动态手段确认。</p>',
        link: 'https://bbs.kanxue.com/thread-290148-1.htm',
        linkNote: '看雪论坛 Android 安全版；正文含 IDAPython 代码与机制整理，篇幅较长。'
      },
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">一个把「经验」变成「可执行条件」的真实样本，' +
        '以及它展示的三条纪律：<b>先定义形状、用交叉引用收敛、动态只用来确认候选。</b><br>' +
        '这三条与本章的七条线索并不冲突——它们是「静态结构」和「调用栈」在极端条件下的具体打法。</p>')
    },

    /* ============================================================ 30.16 */
    {
      h: '30.16', title: '本章自测：把环境与定位串起来',
      html:
        '<p>这一章的内容横跨「环境」与「方法论」两半，' +
        '所以最后一道题是一道综合题：<b>把需求、环境、线索选择与失败处理串成一条链。</b></p>',
      quiz: {
        id: 'q30-6', chapter: 30, answer: 1,
        stem: '需求是「把一个 App 在<strong>启动阶段</strong>做的完整性自检还原出来」。' +
              '已知：设备未 root；APK 未加固、能正常反编译；抓包环境可用；' +
              '目标 App <strong>一 attach 调试器就退出</strong>。' +
              '下面哪一条路线最符合本章的方法论？',
        options: [
          { t: '先想办法 root 这台设备，然后装 Hook 框架，用 Frida 把启动阶段所有方法都打一遍日志',
            why: '把「先配环境」当成了默认动作。这个任务的关键信息是「未加固、能反编译」，也就是说静态与日志线索都还完好；在没确认它们不够用之前就去做最贵的一件事（解锁+root+注入），是把成本顺序搞反了。' },
          { t: '先用静态结构找出启动链路与可疑的自检点，再用日志/打点这类不需要 root 的手段去确认；调试器挂不上这件事先记为「有人不希望被调试」，等确认需要断点再说',
            why: '正确。三步都在本章的框架内：① 未加固 → 静态结构可用（线索三，成本中）；② 用日志/打点确认（线索二/七，成本低，且不需要 root）；③ 把「调试器被拒」当成一条信息而不是一个障碍——它同样印证了「启动阶段有主动检测」，而这正是你要找的东西之一。' },
          { t: '既然一 attach 就退出，说明有强反调试，应该立刻上反调试绕过（改属性、hook 检测函数、换 ROM），先把调试器挂稳',
            why: '在不知道检测点的情况下做绕过，是 30.5 决策演练里已经否掉的路径：绕过动作本身会污染现场，而且「启动阶段的自检」很可能就是那个检测——你为了调试而绕过它，恰恰把要研究的目标改掉了。' },
          { t: '未 root 且调试器被拒，说明这个任务在当前条件下不可行，应该先申请一台已 root 的工程机',
            why: '「不可行」的结论需要先排除便宜的路。这个任务有完好的静态结构与可用的抓包环境，而且「自检」往往会在日志、网络、时序上留下痕迹——在试过这些之前申请资源，是把可行性判断建立在工具清单上，而不是建立在证据上。' }
        ],
        explain: '<b>把这一章的两半接起来看这道题：</b><br>' +
                 '<b>① 环境这一半</b>：题目给了三个环境事实——未 root、未加固、抓包可用。' +
                 '它们不是「条件不足」，而是<b>提前告诉你哪几条线索可用</b>：' +
                 '未加固 → 静态结构与字符串搜索可用；未 root → 动态调试与 Hook 很贵；' +
                 '抓包可用 → 如果自检上报，那么它的行为会在网络上留下痕迹。<br>' +
                 '<b>② 方法论这一半</b>：从最便宜的、失败也不花钱的动作开始（静态结构 → 日志 → 抓包对齐），' +
                 '每一步都换回一条能砍范围的信息。<br>' +
                 '<b>③ 关于「挂不上调试器」</b>：它是这条链上的一次失败，而它的产出非常明确——' +
                 '<span class="hit">「启动阶段有人在检测调试环境」</span>。' +
                 '这本身就是关于自检的一个重要线索，甚至可能就是你要找的那个自检。<br>' +
                 '所以正确的心态不是「先解决它」，而是「先记下它，继续用便宜的手段推进」。'
      },
      after: T.note('ok', '✅ 本章的收束',
        '<p style="margin-bottom:0">环境是成本，定位是收益。' +
        '每一次投入——root、证书、Hook、调试器——都应该换来一种具体的观测能力；' +
        '每一次尝试——七条线索中的任何一条——都应该换来一条能把范围砍小的信息。<br>' +
        '<b>这一章真正想留下的，是这两个「都应该」。</b></p>')
    },
/* @@CHUNK3B@@ */
  ],

  glossary: [
    { t: 'bootloader 解锁', d: '解除设备对「刷入非官方镜像」的限制。代价通常是清空用户数据，部分机型还会永久熔断某些安全特性；它是 root 的<b>前置条件</b>，且属于不可逆操作。' },
    { t: 'systemless', d: '「不碰系统分区」的定制思路：把改动放在一个被挂载/覆盖上去的层里，系统分区本身保持与官方一致。收益是卸载干净、OTA 更容易过；代价是痕迹留在挂载层（第 18 章）。' },
    { t: '用户证书库 / 系统信任库', d: 'Android 的两级信任存储。从 Android 7.0 起，App 默认只信任系统库；用户库里的证书需要在应用里显式声明才会被信任。' },
    { t: '重打包声明信任', d: '不依赖 root 的替代路线：在 manifest 里加入信任用户 CA 的网络配置后重新签名打包。代价是签名变化引发的完整性校验与 SDK 校验问题。' },
    { t: 'frida-server', d: 'Frida 的「按需注入」形态：一个独立进程，由你主动连接并向目标进程注入。会话级生效，重启或断连后需要重建现场（第 1、10、21 章）。' },
    { t: 'LSPosed', d: 'Xposed 路线的现代实现，属于「常驻」形态：挂在 Zygote 上，每个 App 进程一出生就带着模块。装一次长期生效，但改逻辑要重装模块（第 22 章）。' },
    { t: 'USB 调试', d: '设备侧的开发者选项开关，作用是「允许调试协议接入」。它打开的是<b>通道</b>，不等于「这个 App 可以被断点」。' },
    { t: 'android:debuggable', d: '应用级标志（写在 App 自己的 manifest 里），决定这个进程是否对外暴露调试接口。<b>它是 per-app 的。</b>' },
    { t: 'ro.debuggable', d: '系统级属性，表示这台设备的系统镜像本身是 debuggable 构建。<b>它是 per-device 的</b>，会整体放宽可调试性——这解释了「同一份 APK 在不同设备上可调试性不同」。' },
    { t: 'JDWP', d: 'Java 调试线协议，调试器与被调试运行时之间的通信通道。能不能连上它，是「调试环境是否就绪」的唯一判据。' },
    { t: '业务边界', d: '调用栈上「控制权第一次进入业务代码」的那一帧。两种等价描述：从栈顶往下第一帧应用包名且非代理/合成的代码；或你的目标字符串第一次出现的那一帧。' },
    { t: '调用栈退化', d: '栈上的语义信息在编译期被抹掉的状态：大量无行号帧、单字母名、帧数骤减且关系断裂（内联导致某些帧在栈上从未存在）。结论是「换一种不依赖名字的观测」，而不是「再仔细看看」。' },
    { t: '代理 / 合成帧', d: '反射调用、编译器生成的 lambda、动态代理等「通用入口」帧。它们本身不携带业务语义，读栈时应穿过它们，而不是在它们身上找线索。' },
    { t: '结构性排除', d: '某条线索在当前情境下<b>逻辑上不成立</b>（而不是效果差）：例如界面由 Flutter/自绘渲染时，UI 反推没有资源 id 可反查。被结构性排除的线索要直接划掉，不要再花一轮去验证。' },
    { t: '成本-收益选型', d: '本章的核心方法：给每条线索一个启动成本与一个收益（能缩小多少范围），按效益排序决定先试哪一条。成本不是难度，而是「启动它要付的代价」。' },
    { t: '时间窗过滤', d: '日志排查里收益最高的一招：先记下「我做了这个操作」的时刻，只看窗口前后的日志，把几万行压到几十行。' },
    { t: 'Method Profiling', d: '按采样或插桩方式采集方法调用。产出是<b>候选集</b>而非证据：短方法会被采样丢掉，被内联的方法根本不在调用关系里。正确用法是当「假设生成器」。' },
    { t: '交叉引用', d: '「谁引用了这段代码」的关系。在符号被剥离的 native 目标里，它和导入表、常量并列为三大抓手（第 21.13 的 ModuleMap 是它的工程化形态）。' },
    { t: '导入表', d: 'ELF 模块声明「我用到哪些外部函数」的表。它必须存在（动态链接依赖它），所以**符号被剥离也不会消失**——这是 native 静态分析最稳的一张地图。' },
    { t: '基线', d: '在动手改行为之前记录下的「未干预状态下的输入输出」。没有基线，你无法判断后面的现象是目标的真实行为还是你的干预造成的。' }
  ],

  teacher: {
    id: 't30', chapter: 30,
    name: '定位教官',
    sub: '我不问你会不会用工具，我只问你「凭什么这么选」',
    intro:
      '<p>这一章的内容谁都能看懂，但<b>判断力不是看懂就能获得的</b>。' +
      '所以我只会问你四类问题：<b>这笔成本的价签在哪、这条线索凭什么排前面、' +
      '失败时你到底得到了什么、以及这个结论能不能被别人复核。</b></p>' +
      '<p>答不上来没关系，我会给你提示——但提示不算过关。</p>',
    questions: [
      {
        id: 'c30q1', depth: 1, threshold: 0.7,
        q: '有人跟你说：「先解锁 root 再说，反正现在都这么干。」<br>' +
           '请你把 <b>root 这笔账</b>算清楚：代价是什么、systemless 为什么值这个价、' +
           '以及为什么说「root 本身就是一次自我举报」。',
        concepts: [
          { label: '解锁 bootloader 会清空数据，部分机型还会熔断安全特性、影响保修，属于不可逆操作',
            hint: '先说不可逆的那部分代价',
            any: ['清空', '清数据', '擦除', '恢复出厂', '熔断', '保修', '不可逆', '一次性', '拒保'] },
          { label: 'systemless 不改系统分区，靠挂载/覆盖层叠加，所以卸载干净、OTA 与完整性校验更容易过',
            hint: '它换来了什么',
            any: ['systemless', '系统分区', '挂载', '覆盖', 'overlay', '叠加', '卸载', 'OTA', '镜像', '分区校验'] },
          { label: 'root 会留下可被读取的特征：su 痕迹、挂载信息异常、属性与目录痕迹、可注入性本身',
            hint: '风控会读什么',
            any: ['su', '挂载', 'mount', '属性', '目录', '可注入', '特征', '检测', '风控', '暴露', '痕迹'] },
          { label: '它是环境依赖链上的一环：证书进系统库、frida-server 注入都依赖它',
            hint: '它买到了哪几种观测能力',
            any: ['依赖', '证书', '系统库', '注入', 'frida', '前提', '链条', '观测', '权限'] },
          { label: 'root 只是权限：它不能让你看懂代码，也不能让反调试失效，更不能绕过服务端风控',
            hint: '它的边界在哪',
            any: ['权限', '看不懂', '不是理解', '反调试', '无关', '不能绕过', '风控', '边界', '服务端'] }
        ],
        hints: [
          '分三层说：设备层的不可逆代价、系统层的收益（为什么要 systemless）、以及检测层的暴露面。',
          '再补一句边界：root 让你「能做」，但不让你「看懂」。'
        ],
        probes: [
          '追问：如果这台机器只是临时借来的测试机，你的答案会不会变？哪一条代价会消失，哪一条不会？',
          '追问：假设目标 App 只检测 su 与挂载信息，你有哪些不改 root 状态就能降低暴露面的做法？（提示：第 10、13 章的思路）'
        ],
        model: '<b>把 root 当成一笔有价签的支出，而且这笔支出是三条独立成本。</b><br><br>' +
               '<b>① 设备层的不可逆代价。</b>解锁 bootloader 会触发全盘擦除（安全设计，不是可绕过的步骤）；' +
               '部分机型还会熔断某些安全特性，之后即使刷回官方也不再恢复；' +
               '不少厂商把解锁状态当作拒保依据。这一层的特点是<b>不可逆</b>——' +
               '所以它必须排在所有技术讨论之前：先确认「这台机器的数据可以不要」。<br><br>' +
               '<b>② 系统层的收益，也就是 systemless 为什么值这个价。</b>' +
               'Magisk 的思路是不碰系统分区，把定制内容放在一个被挂载/覆盖上去的层里，' +
               '系统分区本身保持与官方一致。收益有三条：OTA 与完整性校验更容易过、' +
               '卸载干净（移除覆盖层即可回到原状）、模块化（证书与 Hook 各自独立）。' +
               '<b>换句话说：systemless 用「多一层挂载」换掉了「永久改分区」。</b><br><br>' +
               '<b>③ 检测层的暴露面。</b>站在风控角度，一台 root 设备同时给出多个独立信号：' +
               'su 文件与调用痕迹、挂载信息异常（这一条恰恰是 systemless 的副产品）、' +
               '属性与目录痕迹、以及最根本的一条——<b>可注入性本身</b>。' +
               '风控真正在意的不是「你装了 Magisk」，而是「这个进程的行为可以被别人改」。<br><br>' +
               '<b>④ 最后必须说边界：root 只是权限。</b>它不能让你看懂代码（那是分析能力），' +
               '不能让反调试失效（TracerPid、调试标志、时序与 root 无关），' +
               '也不能绕过服务端风控（设备指纹与行为模型都在服务端）。' +
               '<b>能说出边界，才算把账算清。</b>',
        after: '<p>补充一句：本章的立场不是「不要 root」，而是<b>「先知道它贵在哪，再决定这次任务值不值」</b>。' +
               '抓一个 HTTP 接口不需要它；读一个 native 算法很可能需要它。</p>'
      },
      {
        id: 'c30q2', depth: 1, threshold: 0.7,
        q: '「抓包证书我装上了，但还是抓不到。」<br>' +
           '请你说清三件事：<b>这条线上到底发生了什么变化</b>（Android 7 那条线）、' +
           '<b>让 App 接受你的证书有哪几条路、各自代价是什么</b>、' +
           '以及<b>「部分接口抓不到」该被归到哪一类问题</b>。',
        concepts: [
          { label: 'Android 7.0 起 App 默认只信任系统信任库，不再信任用户安装的 CA',
            hint: '那条线的准确表述',
            any: ['android 7', '7.0', '用户证书', '系统信任库', '系统证书', '默认不信任', '用户 ca', '信任库'] },
          { label: '装进系统库：要 root，并且会碰到分区只读、完整性校验、证书目录与命名随版本变化等代价',
            hint: '第一条路',
            any: ['系统库', '系统证书', 'root', '只读', '挂载', '完整性', '目录', '命名', '哈希', 'conscrypt'] },
          { label: '重打包声明信任用户证书：不需要 root，但签名变了，完整性校验、第三方 SDK 校验、升级链路都会受影响',
            hint: '第二条路',
            any: ['重打包', '重签', '签名', 'manifest', '完整性', 'sdk 校验', '升级', '不需要 root', '改包'] },
          { label: '还有一条不下证书的路：在 socket / SSL 层取明文，绕开整个证书信任问题',
            hint: '第三、四条路',
            any: ['socket', 'ssl', 'ssl_write', 'ssl_read', 'hook', '明文', '绕过证书', '不走代理', 'r0capture'] },
          { label: '「部分接口抓不到」说明证书这一层是通的，问题在那条请求自身（走了别的网络栈 / 单独的校验 / body 另有加密）',
            hint: '归类',
            any: ['部分', '其它接口', '证书没问题', '证书是通的', '走了别的', '网络栈', '单独', 'pinning', '应用层加密', 'con 连接'] }
        ],
        hints: [
          '先说清「默认信任策略」这条线，再说三种过线方式的代价——注意代价不在同一种资源上（有的是权限，有的是签名）。',
          '最后用「能抓到一部分」这个事实去反推：如果证书真没生效，为什么别的接口能抓到明文？'
        ],
        probes: [
          '追问：如果这台设备不能 root、目标又必须用官方包（不能重打包），你还有什么办法拿到明文？代价是什么？',
          '追问：怎么用一次三十秒的检查，区分「证书没进系统库」与「目标不接受证书」？'
        ],
        model: '<b>先讲清那条线，再谈路线，最后做归类。</b><br><br>' +
               '<b>① 变化是什么：</b>从 Android 7.0 开始，App 默认<b>不再信任用户安装的 CA</b>，' +
               '只看系统信任库（除非应用自己声明信任用户证书）。' +
               '所以「浏览器能抓、App 抓不到」有一个非常确定的解释：<b>你的证书在用户库里，而 App 按默认策略不看那里。</b><br><br>' +
               '<b>② 让 App 接受证书的几条路与代价（代价不在同一种资源上）：</b><br>' +
               '· <b>装进系统库（改分区）</b>：要重新挂载只读分区，现代设备上常被分区只读、验证启动、动态分区挡住；' +
               '改过的分区影响完整性校验；系统升级可能覆盖。代价是<b>系统完整性</b>。<br>' +
               '· <b>systemless 模块</b>：不改分区，靠覆盖层叠加。代价是<b>必须 root</b>，而且痕迹在挂载层。' +
               '这是当前最通用的路线。<br>' +
               '· <b>重打包声明信任用户证书</b>：不需要 root。代价是<b>签名变化</b>——' +
               '完整性校验、第三方 SDK 校验、与官方包共存的升级链路都可能出问题。<br>' +
               '· <b>不下证书，直接在 socket/SSL 层取明文</b>：这不是「装证书」，' +
               '而是绕开整个信任问题；代价是你自己要处理明文边界与字节流。<br><br>' +
               '<b>③ 归类：</b>「部分接口抓不到」的关键证据是——<b>同一个 App 的其它接口能抓到完整明文</b>。' +
               '这直接证明了代理、证书、网络三层都没问题（证书信任是按进程的默认策略生效的，' +
               '不会对首页接口有效、对支付接口无效）。' +
               '所以它属于「那条请求自身的问题」，典型有三种：<b>它没走系统代理</b>（自带网络栈）、' +
               '<b>它单独做了固定校验</b>（pinning 可以按域名/连接生效）、' +
               '或者<b>它的 body 另有应用层加密</b>（握手成功但内容是密文）。<br>' +
               '<span class="hit">归类的价值：三种成因对应三套完全不同的手段，而「证书装没装好」已经被证据排除了。</span>',
        after: '<p>这道题是第 23.7 / 23.8 的压缩版。两者的分工：<b>第 23 章讲整条链路的原理与诊断顺序，' +
               '本章只要求你能在「证书 / 校验 / 应用层加密」之间做出正确归类。</b></p>'
      },
      {
        id: 'c30q3', depth: 2, threshold: 0.7,
        q: '有个人说：「我已经打开了 USB 调试，为什么断点还是打不上？」<br>' +
           '请把 <b>debuggable 的两个层次</b>说清楚，说明<b>为什么调试器这条路本身会被 App 主动检测</b>，' +
           '并给出「一 attach 就退出」时你的处理顺序。',
        concepts: [
          { label: 'android:debuggable 是应用级标志（per-app），决定这个 App 能不能被 JDWP 附加',
            hint: '第一个层次',
            any: ['android:debuggable', '应用级', 'per-app', '每个应用', 'manifest', 'jdwp', '附加', '门'] },
          { label: 'ro.debuggable 是系统级属性（per-device），debuggable 构建的系统会整体放宽可调试性',
            hint: '第二个层次',
            any: ['ro.debuggable', '系统级', 'per-device', '设备', '属性', '工程机', '模拟器', '放宽', '镜像'] },
          { label: 'USB 调试只是「允许调试协议接入」的通道，通道打开不等于目标可被调试',
            hint: '为什么开了还是不行',
            any: ['usb 调试', '通道', '通道打开', '不等于', '开关', '协议', '允许'] },
          { label: '检测判据：被追踪标记、JDWP 通道/调试线程的存在、以及断点导致的耗时异常',
            hint: 'App 怎么发现你',
            any: ['tracerpid', 'ptrace', '被追踪', 'jdwp', '调试线程', '耗时', '时间', '标记', '检测'] },
          { label: '「一 attach 就退出」要先分清「主动检测后退出」还是「被调试拖崩」，再决定抢时序还是换观测方式',
            hint: '处理顺序',
            any: ['主动检测', '检测到', '拖崩', '副作用', '抢时序', 'spawn', '提前', '日志', '打点', '分清', '取证'] }
        ],
        hints: [
          '先把两个同名但层次不同的东西分开：一个是 App 自己的标志，一个是设备的属性。',
          '再想想：为什么「有人在旁边看内部状态」这件事本身值得检测——它和 Hook 是同一类风险。'
        ],
        probes: [
          '追问：如果目标在启动的最早期就完成检测并退出，而你只能在它之后注入，这时你的选择是什么？',
          '追问：不附加调试器、不改调试标志的前提下，你还能用什么方式确认「它到底读取了什么」？'
        ],
        model: '<b>第一步是把两个 debuggable 分开。</b><br><br>' +
               '<b>android:debuggable</b> 写在 App 自己的 manifest 里，是<b>应用级</b>开关：' +
               '它决定这个进程愿不愿意暴露调试接口。<b>ro.debuggable</b> 是<b>系统级</b>属性，' +
               '由系统镜像的构建方决定；系统是 debuggable 构建时，很多进程的可调试性会被整体放宽。' +
               '这就解释了「同一份 APK 在我这里能调、在你那里不能调」——差异来自设备，不来自 APK。<br>' +
               '而开发者选项里的 <b>USB 调试</b>只是「允许调试协议进来」的<b>通道</b>：' +
               '<span class="hit">通道打开不等于门打开</span>，门在 App 自己的 debuggable 标志上。' +
               '这就是「USB 调试开了还是打不上断点」的标准答案。<br><br>' +
               '<b>第二步：为什么这条路会被检测。</b>站在检测方角度，「被调试」与「被 Hook」是同一类风险——' +
               '<b>有人在运行时看我的内部状态</b>。而调试留下的痕迹比 Hook 更集中：' +
               '进程的追踪者标记非空（被附加的通用痕迹）、可调试进程会暴露 JDWP 通道、' +
               '附加后进程里会多出调试相关线程、以及断点会让某段代码出现人类不可能产生的耗时。' +
               '这些判据的共同点是：<b>它们不关心你用什么工具，只关心「有没有人在旁边看」。</b><br><br>' +
               '<b>第三步：一 attach 就退出时的处理顺序。</b>' +
               '① <b>先取证</b>：确认是「主动检测后退出」还是「被调试拖崩」。' +
               '前者退出是有意图的（常伴随被清理过的假异常、或退出前一段可疑耗时）；' +
               '后者是副作用（断点让超时、锁等待、看门狗把进程带走）。<br>' +
               '② <b>再决定</b>：主动检测 → <b>抢时序</b>（把观测点提前到它的检测之前，或用 spawn 类手段）；' +
               '被拖崩 → <b>换不暂停线程的观测方式</b>（打点日志、hook 取参数）。<br>' +
               '③ <b>最后才谈绕过</b>：绕过是有副作用的，一旦挂上去，你就再也分不清' +
               '「它退出了」是因为检测还是因为你的脚本——<b>在没有证据之前动手，等于亲手污染现场。</b>',
        after: '<p>关联：第 10 章的八个检测点讲的是「Frida 被怎么发现」，本章问的是「调试被怎么发现」——' +
               '两者的应对逻辑是同一套：<b>能改配置就改配置，改不了就篡改观察管道，再不行就抢时序。</b></p>'
      },
      {
        id: 'c30q4', depth: 2, threshold: 0.7,
        q: '请把「七条线索」的排序依据说清楚：<b>凭什么字符串搜索排在动态调试前面？</b><br>' +
           '并解释<b>「结构性排除」和「成本高」有什么区别</b>——为什么前者要直接划掉，后者只是先放后面。',
        concepts: [
          { label: '排序的第一判据是失败代价：便宜的先做，因为搜不到只花三十秒，而调试环境加断点可能是一小时',
            hint: '第一条判据',
            any: ['失败', '代价', '成本', '便宜', '三十秒', '不花钱', '先试', '代价小', '试错'] },
          { label: '第二条判据是「是否需要先知道位置」：动态调试要先知道断在哪，所以它天然排在定位类线索之后',
            hint: '第二条判据',
            any: ['位置', '断在哪', '前提', '先知道', '选点', '断点', '定位之后', '依赖'] },
          { label: '第三条判据是「是否被情境结构性排除」：例如界面不是原生 View 树时，UI 反推没有资源 id 可反查',
            hint: '结构性排除是什么',
            any: ['结构性', '排除', '不成立', '逻辑上', 'flutter', '自绘', '资源 id', '控件树', '概念上'] },
          { label: '被结构性排除的线索不是效果差，而是逻辑上做不到，所以不要再花一轮去验证',
            hint: '为什么要直接划掉',
            any: ['划掉', '不要试', '不用试', '浪费', '一轮', '直接排除', '逻辑上不成立', '验证'] },
          { label: '成本高的线索只是排在后面，一旦前面拿到强证据就可以跳级使用',
            hint: '两者的区别',
            any: ['跳级', '强证据', '直接跳到', '后面', '顺序', '不冲突', '可以先', '排在'] }
        ],
        hints: [
          '把「成本」拆开看：它不只是难度，还包括要不要环境、要不要复现、要不要中断程序、要不要先知道位置。',
          '再想一个反例：如果界面是 Flutter 画的，你会「先试试 UI 反推，效果不好再换」吗？'
        ],
        probes: [
          '追问：举一个「虽然最贵，但应该第一个做」的真实场景，并说明为什么此时成本判据会让位。',
          '追问：Trace 给出了一份几千行的候选清单。按本章的规则，你接下来该做什么、不该做什么？'
        ],
        model: '<b>三条判据，按优先级说。</b><br><br>' +
               '<b>① 失败代价最小者优先。</b>搜一个字符串，搜不到只花三十秒，' +
               '而且「搜不到」本身就是一条结论（不是静态常量）。' +
               '而动态调试的启动成本包括：环境是否就绪（debuggable、JDWP、反调试）、' +
               '断点选在哪、命中后要处理多少次调用——<b>一次等于几十次搜索。</b>' +
               '所以顺序的本质是：<b>让便宜的失败为贵的成功铺路。</b><br><br>' +
               '<b>② 需要「先知道位置」的线索排在后面。</b>动态调试回答的是' +
               '「这一行执行时寄存器/内存是什么」——它必须建立在「断在哪一行」之上。' +
               '前六条线索的真正用途，就是替你付掉「选点」这一半的成本。<br><br>' +
               '<b>③ 是否被结构性排除。</b>这是与前两条性质完全不同的一种判据。' +
               '「成本高」意味着<b>做了会有收获，只是贵</b>；' +
               '「结构性排除」意味着<b>再怎么努力也不可能成立</b>——' +
               '例如界面是 Flutter/自绘时，没有原生控件树、没有 resource-id，' +
               'UI 反推从概念上就没有输入。<br>' +
               '<span class="hit">所以前者是「排在后面」，后者是「直接划掉」。</span>' +
               '对前者你还需要准备备用方案；对后者你连验证都不该做——' +
               '因为它给出的失败信息是零（你早就知道它不成立）。<br><br>' +
               '<b>最后补一句顺序的正确用法：</b>它不是流程，是梯子。' +
               '任何一步拿到<b>强证据</b>（例如崩溃栈直接给出类名与行号），' +
               '都可以直接跳到最贵的那一级；而拿到<b>弱证据</b>（例如 Trace 给的候选集）' +
               '则必须回到便宜的那几级去交叉验证。' +
               '<b>判断力就体现在：知道自己手里的是强证据还是候选集。</b>',
        after: '<p>把这道题和 30.14 的决策图对读：图里每一行都写了「失败时你得到什么」——' +
               '那一栏才是这张梯子的真正内容。</p>'
      },
      {
        id: 'c30q5', depth: 3, threshold: 0.7,
        q: '<b>综合题。</b>给你一个任务：<br>' +
           '目标 App 未加固、能正常反编译；设备未 root；抓包环境可用；' +
           '需求是「还原出本地计算的签名参数」。<br>' +
           '请完整说出你的<b>定位顺序</b>，并且——<b>每一步都要说清「如果这一步失败，我因此知道了什么」</b>。' +
           '最后说明：什么情况下你会放弃「定位到那个函数」这个目标。',
        concepts: [
          { label: '从最便宜且失败也不花钱的动作开始：字符串搜索（URL / 提示语 / TAG / 算法常量 / 字段名）',
            hint: '第一步',
            any: ['字符串', '搜索', '关键词', 'url', '提示', 'tag', '常量', '字段名', '最便宜'] },
          { label: '未加固意味着静态结构可用：从 manifest、类型引用、调用图里画出从入口到目标的结构草图',
            hint: '第二步',
            any: ['静态', 'manifest', '调用图', '结构', '未加固', '反编译', '草图', '入口'] },
          { label: '用日志与打点做低成本验证：崩溃栈、框架日志、时间窗过滤，必要时自己插一条观测',
            hint: '低成本验证',
            any: ['日志', 'logcat', '打点', '计数', '崩溃栈', '时间窗', '验证', '观测'] },
          { label: '顺着抓到的请求反推：把「输入输出」对起来（改一个字段看输出怎么变），确定签名的输入集合',
            hint: '利用可用的抓包环境',
            any: ['抓包', '输入输出', '字段', '改参数', '对比', '请求', '响应', '差分'] },
          { label: '每一步失败都能产出一条缩小范围的信息：不是静态常量 / 结构被处理过 / 关系被内联 / 路径没走到',
            hint: '这一栏是重点',
            any: ['失败', '得到', '缩小', '范围', '不是静态常量', '信息', '砍掉', '排除', '结论'] },
          { label: '当「定位函数」不可达时，把目标降级成行为型：确定输入输出、可复现调用，或转向模拟执行 / 自吐沙箱',
            hint: '什么时候放弃位置型目标',
            any: ['降级', '行为', '输入输出', '复现', '模拟执行', 'unidbg', '自吐', '沙箱', '换目标', '黑盒'] }
        ],
        hints: [
          '先按「便宜 → 贵」把顺序排出来，然后逐步说明每一步的失败信号。注意题目给了三个环境事实，它们等于提前告诉你哪几条线索可用。',
          '最后那个问题才是重点：当所有用户态线索都穷尽时，要动的是「目标定义」，而不是再试一遍工具。'
        ],
        probes: [
          '追问：抓包环境可用这个条件，除了「看请求」之外，还能怎么用？（提示：想想它能不能当锚点、能不能做差分）',
          '追问：如果目标把签名结果再做一次变换（例如再哈希一次）才发出，你的「输入输出对照」还成立吗？怎么修正？'
        ],
        model: '<b>先读环境事实，再排顺序，最后给每一步的失败信号。</b><br><br>' +
               '<b>环境事实的读法（这一步很多人会跳过）：</b>未加固 → 静态结构与字符串搜索可用；' +
               '未 root → 动态调试与 Hook 类手段都很贵（但抓包可用，所以网络侧观测没问题）。' +
               '<b>换句话说：题目已经把「哪几条线索便宜」告诉你了。</b><br><br>' +
               '<b>顺序与每一步的失败产出：</b><br>' +
               '<b>① 字符串搜索</b>（URL、字段名、提示语、常见算法常量）。' +
               '失败 → 「签名不是由静态常量驱动的」：指向运行时拼接、服务端下发（那它就不是本地计算）、或字符串加密。<br>' +
               '<b>② 静态结构</b>（manifest → 入口 → 调用图；从未加固这一点上吃满收益）。' +
               '失败 → 结构被处理过；但本题未加固，所以更可能是<b>你的入口选错了</b>——这是一条很有用的自我怀疑。<br>' +
               '<b>③ 抓包对齐</b>（这个条件必须用上）：把请求参数当<b>输入</b>、把签名当<b>输出</b>，' +
               '做差分——改一个字段，看签名怎么变；不改任何字段重复发，看是否稳定。' +
               '失败 → 说明签名不（只）依赖你改的那些字段，或者它掺入了时间/随机量——' +
               '这本身就在缩小输入集合。<br>' +
               '<b>④ 日志与打点</b>：崩溃栈优先；没有就在嫌疑点插一条很轻的观测（打点、计数）。' +
               '失败 → 这条路径没有可读记录，或你没走在这条路径上（两者要分清）。<br>' +
               '<b>⑤ 调用栈</b>：从「谁写入了这串字节」出发向上回溯，找业务边界。' +
               '失败 → 调用关系被内联/折叠，或目标在 native 侧（那就转 native 的静态 + 动态）。<br>' +
               '<b>⑥ Profiling / Trace</b>（按「点一次按钮」这个窗口采集）。' +
               '失败 → 只有候选集：内联缺失、短方法被采样丢掉、或全是框架噪音。<b>候选必须回去验证。</b><br>' +
               '<b>⑦ 动态调试</b>：设备未 root，所以这一步的成本极高；' +
               '除非能拿到达成条件的设备，否则考虑用「不需要 root 的观测」（重打包 + 打点、socket 层观测）替代。' +
               '失败 → 要么环境不成立，要么目标在检测。<br><br>' +
               '<b>什么时候放弃「定位到那个函数」：</b>' +
               '当你在<b>当前可用的观测层次</b>里已经把手段穷尽、且失败信息收敛到同一个结论时——' +
               '例如「代码不在可读范围内 + 运行时行为被挡住 + 网络只给出密文」。' +
               '此时正确的动作不是再试一遍，而是<b>把目标降级</b>：<br>' +
               '· 如果你真正需要的是「能复现这个签名」，那就把目标改成<b>行为型</b>：' +
               '确定输入集合、确定输出特征、拿到可稳定复现的调用能力（第 7 章的模拟执行、第 24 章的自吐沙箱都是为这个目标设计的）；<br>' +
               '· 如果你确实需要看算法内部，才谈得上把观测点<b>下沉一层</b>（第 13、11 章），' +
               '而且下沉之前必须先知道「要观测什么」，否则你只是把几千行候选换成几百万行。<br>' +
               '<span class="hit">一句话：先换问题，再换层次，最后才换设备。</span>',
        after: '<p>这道题没有标准答案的唯一性——<b>它的评分点是「每一步的失败信号」</b>。' +
               '如果你能对七步中的五步说清失败产出，说明这套方法论已经进你的脑子了。</p>'
      },
      {
        id: 'c30q6', depth: 3, threshold: 0.7,
        q: '<b>综合题。</b>下面是一段真实的栈（异常类型被改写）：<br>' +
           '<span class="mono small">at com.target.pay.CryptoBridge.nativeSign(Native Method)</span><br>' +
           '<span class="mono small">at com.target.pay.SignProxy.invoke(SignProxy.java:37)</span><br>' +
           '<span class="mono small">at java.lang.reflect.Method.invoke(Native Method)</span><br>' +
           '<span class="mono small">at com.target.pay.PayActivity.doPay(PayActivity.java:203)</span><br>' +
           '<span class="mono small">at com.target.pay.PayActivity$2.onClick(PayActivity.java:88)</span><br>' +
           '<span class="mono small">at android.view.View.performClick(View.java:7792)</span><br>' +
           '请回答四件事：<b>① 业务边界在哪一帧、为什么；② 哪一帧没有业务语义、为什么；' +
           '③ 要找「业务入口」该往哪个方向数；④ 如果同样的栈上名字全变成 a.a.a、行号全没了，你会怎么做。</b>',
        concepts: [
          { label: '业务边界是第一帧（CryptoBridge.nativeSign）：从栈顶往下第一帧属于应用包名且非代理/合成的代码',
            hint: '①',
            any: ['第一帧', '栈顶', 'nativeSign', 'cryptobridge', '业务边界', '应用包名', '往下数', '最接近'] },
          { label: '反射帧（java.lang.reflect.Method.invoke）没有业务语义：它是通用入口，看不出调用了谁',
            hint: '②',
            any: ['反射', 'reflect', 'method.invoke', '通用入口', '没有业务语义', '穿过', '代理'] },
          { label: 'SignProxy 是陷阱：名字带 Proxy，但它属于应用自己的包名，是业务侧的代理层而不是框架包装',
            hint: '②的陷阱',
            any: ['signproxy', '陷阱', '名字', '包名', '业务侧', '不是框架', '误判', 'com.target'] },
          { label: '找业务入口要从栈底（系统框架侧）往上数，第一帧业务代码就是入口（PayActivity$2.onClick）',
            hint: '③',
            any: ['栈底', '往上', '入口', 'onclick', 'payactivity', '第一帧业务', '方向', '从下往上'] },
          { label: '退化的表现：大量无行号帧、单字母名、帧数骤减/同名重复（内联导致该帧在栈上从未存在）',
            hint: '④',
            any: ['无行号', 'unknown source', 'sourcefile', '单字母', '混淆', '同名', '重复', '内联', '骤减', '退化'] },
          { label: '退化的结论是换观测：改用不依赖名字与行号的运行时打点、地址偏移、指令级 trace',
            hint: '④的结论',
            any: ['换观测', '打点', '地址', '偏移', 'trace', '运行时', '不依赖名字', '放弃读名字', '换手段'] }
        ],
        hints: [
          '先按包名把五帧分成三类：应用包名、java.*（含反射）、android.*。分类做完，答案就出来一大半。',
          '注意第二帧的名字：它在逗你。判断依据是包名归属，不是名字里有没有 Proxy。'
        ],
        probes: [
          '追问：第一帧标着 (Native Method)，这对你下一步的动作意味着什么？（提示：再往里一步就不在 Java 栈上了）',
          '追问：如果这条栈里一帧业务代码都没有，你最先怀疑的两件事是什么？'
        ],
        model: '<b>① 业务边界 = 第一帧</b> <span class="mono">com.target.pay.CryptoBridge.nativeSign</span>。' +
               '规则：从栈顶往下数，第一帧属于应用包名、且不是代理/合成的代码。' +
               '它同时标着 <span class="mono">(Native Method)</span>，' +
               '所以它还是 <b>Java → native 的交接点</b>——再往里一步就不在 Java 栈上了，' +
               '你需要的是 so 里的地址（转 IDA / native backtrace）。<br><br>' +
               '<b>② 没有业务语义的是第三帧</b> <span class="mono">java.lang.reflect.Method.invoke</span>：' +
               '反射是「通用入口」，这一帧本身不携带任何业务信息——你不可能从它看出它在调谁。' +
               '处理方式是<b>穿过它</b>（去看它下面的实际目标，或去 hook 反射 API 拿名字）。<br>' +
               '<b>陷阱在第二帧：</b><span class="mono">com.target.pay.SignProxy.invoke</span> 名字带 Proxy，' +
               '但它属于应用自己的包名，是<b>业务侧的代理层</b>，不是框架包装。' +
               '<span class="hit">判断依据永远是包名归属 + 是否合成/反射，而不是名字里有没有 Proxy。</span><br><br>' +
               '<b>③ 业务入口要从栈底往上数</b>：最底下是 <span class="mono">android.view.View.performClick</span>（系统框架），' +
               '往上一帧进入应用包名的就是 <span class="mono">com.target.pay.PayActivity$2.onClick</span>。' +
               '注意它是<b>匿名内部类</b>（$2），这正是「按钮点击监听器」的典型形态——' +
               '顺着它可以找到注册监听的那一行。' +
               '<b>一个栈，两个方向：栈顶往上是「事发点」，栈底往下是「入口点」。</b><br><br>' +
               '<b>④ 名字全变 a.a.a、行号全没了的时候：</b>先做一次栈质量判断——' +
               '无行号帧占比、单字母类名数量、同名帧是否重复。' +
               '如果三项都命中，说明这条栈<b>已经退化</b>：行号信息被剥掉、名字被混淆、' +
               '调用关系可能被内联折叠（内联的函数在栈上从来不存在）。' +
               '此时正确的结论是：<b>「名字与行号这条路被关掉了，我需要一个不依赖它们的观测」</b>——' +
               '转向运行时打点、模块 + 偏移、指令级 trace。<br>' +
               '<span class="miss">最常见的错误是继续盯着这条栈找语义，' +
               '试图从 a.a.a 里猜出业务含义——那是在信息已经不存在的地方找信息。</span>',
        after: '<p>这道题的三个坐标（边界 / 代理帧 / 入口）是可以自动化判定的，' +
               '本章 30.10 的实验就是这个规则的可运行版本。</p>'
      }
    ]
  }
};
