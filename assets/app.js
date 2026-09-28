/* ==========================================================================
   安卓高级研修班 · 交互式模拟器  —— 共享运行时
   提供：导航 / 进度 / 代码步进器 / 苏格拉底严师 / 测验 / 决策树 / 动画 / 终端
   无依赖，可直接 file:// 打开（storage 自动降级）
   ========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------ 课程元数据 */
  const COURSE = {
    chapters: [
      { no: 1, title: '安卓应用基础模型：组件、生命周期与 IPC', file: 'ch01-android-model.html', track: 'A', tags: ['四大组件','生命周期','Handler','Binder','AIDL','存储沙箱'],
        desc: 'App 是怎么被系统拉起来的：四大组件、生命周期、消息循环、Binder 跨进程通信、存储沙箱与动态加载。后面一切的坐标系。' },
      { no: 2, title: 'Smali 汇编与重打包实战',                file: 'ch02-smali.html',      track: 'A', tags: ['Smali','Dalvik','改包','apktool','后门植入'],
        desc: '从字节码语法到改一行代码破解，再到反编译重打包工具链与后门植入的原理、手法和防范。' },
      { no: 3, title: 'APK / DEX / ELF 文件格式解析',          file: 'ch03-fileformat.html', track: 'A', tags: ['APK','DEX','ELF','程序头','节表','符号表'],
        desc: '把三种容器格式拆到字节级：APK 的 zip 布局、DEX 的索引区与 code_item、ELF 的头/程序头/节表/符号表。' },
      { no: 4, title: '安卓应用安全风险与审计',                file: 'ch04-appsec.html',     track: 'A', tags: ['重打包','组件越权','WebView','ContentProvider','Drozer','MobSF'],
        desc: '七类高频应用风险（越权、目录遍历、跨域、组件 DoS…）的原理、复现与检测点，以及 Drozer / MobSF 两款审计工具。' },
      { no: 5, title: '逆向工作环境与关键代码定位',            file: 'ch05-locate.html',     track: 'A', tags: ['root','抓包证书','Hook环境','调试','调用栈','Method Profiling'],
        desc: '先把环境配好（root / 证书 / Hook / DEBUG），再系统掌握「如何定位关键代码」的七条线索。' },
      { no: 6, title: '算法地图与 RSA 逆向',                   file: 'ch06-rsa.html',        track: 'A', tags: ['RSA','公钥','SPKI','填充','ECDHE','算法分类'],
        desc: '补齐密码学地图：对称 / 非对称 / 摘要 / 编码 / MAC 的分工，重点讲 RSA 的原理、公钥提取与逆向判断。' },
      { no: 7, title: 'AI 辅助逆向分析',                       file: 'ch07-ai.html',         track: 'A', tags: ['MCP','大模型','IDA','Ghidra','边界'],
        desc: '把 IDA / Ghidra 通过 MCP 接入大模型：能自动化什么、还原效果的真实边界在哪，以及分工为什么不能颠倒。' },
      { no: 8, title: '加固技术全景与壳的判定',                file: 'ch08-packer-map.html', track: 'B', tags: ['加固','一代壳','抽取壳','VMP壳','判定'],
        desc: '把市面加固方案摊成一张地图：从一代整体加密到抽取壳、VMP 壳，并学会在半小时内判定手里这个 App 是哪一类。' },
      { no: 9, title: 'JNI / NDK 开发详解',                   file: 'ch09-jni-ndk.html',  track: 'B', tags: ['JNI','NDK','动态注册','反射','JNIEnv'],
        desc: '从零写一个 NDK 项目：JNIEnv 函数表、类型签名、引用管理、JNI_OnLoad 与 RegisterNatives，直到反射与 onCreate Native 化。' },
      { no: 10, title: 'Frida 自动化与去特征',                  file: 'ch10-frida-auto.html', track: 'B', tags: ['objection','r0capture','r0tracer','hluda','Stalker'],
        desc: '把 Frida 从手写脚本升级成流水线：objection / r0capture / r0tracer 三件套开工，再编译 hluda 抹掉常规特征。' },
      { no: 11, title: 'Xposed / LSPosed 开发指南',            file: 'ch11-xposed-lsposed.html', track: 'B', tags: ['Xposed','LSPosed','Zygisk','Hook','模块'],
        desc: '模块开发全流程：Hook 构造函数与普通函数、主动调用、Hook 插件 dex 与壳 dex、Native Hook，以及被检测后的脱壳出路。' },
      { no: 12, title: '抓包全解与协议分析',                    file: 'ch12-sniff-protocol.html', track: 'B', tags: ['Charles','mitmproxy','SSL Pinning','socket','溯源'],
        desc: '从 HTTP/HTTPS 原理到抓包对抗：单向与双向校验、Java 层与 JNI 层 socket/SSL 溯源、自编译 OpenSSL 与协议枚举。' },
      { no: 13, title: '自吐沙箱与算法自监控',                  file: 'ch13-appmon.html',   track: 'B', tags: ['沙箱','APPMON','MessageDigest','Cipher','Mac'],
        desc: '基于 AOSP 源码打造一个会自己招供的沙箱：在 MessageDigest / Cipher / Mac 处插桩，让算法的输入输出自己吐出来。' },
      { no: 14, title: '白盒密码：白盒 AES 与 DFA 攻击',        file: 'ch14-whitebox.html', track: 'B', tags: ['白盒AES','DFA','差分故障','密钥提取'],
        desc: '识别白盒实现、从源码角度拆解白盒 AES 的表结构，再用差分故障分析（DFA）把嵌进去的密钥还原出来。' },
      { no: 15, legacy: true,  title: 'Frida 高级逆向',                       file: 'ch15-frida.html',  track: 'C', tags: ['Frida','Hook','OLLVM','Stalker'],
        desc: 'Hook Java 层与 Native 层的两条路径；用 Stalker 动态 Trace 绕过 OLLVM 静态混淆。' },
      { no: 16, legacy: true,  title: 'Frida + FART 全自动脱壳机',            file: 'ch16-fart.html',   track: 'C', tags: ['脱壳','ClassLoader','ART','FART'],
        desc: '双亲委派与 dex 加载瞬间的截胡；抽取壳与主动调用（Active Call）还原方法体。' },
      { no: 17, legacy: true,  title: 'ARM & C++ 算法还原原理 + Frida',       file: 'ch17-arm-cpp.html',track: 'C', tags: ['ARM','Thumb','AArch64','vtable'],
        desc: '把 C/C++ 语义映射到汇编：调用约定、虚表、RTTI、内联汇编与 syscall。' },
      { no: 18, legacy: true,  title: 'C++11 & ART 打造动态分析沙箱',         file: 'ch18-art-sandbox.html', track: 'C', tags: ['C++11','ART','JNI','RegisterNatives'],
        desc: '读懂 ART 的 C++11 源码，定制虚拟机在 RegisterNatives 处自动记录 JNI 绑定。' },
      { no: 19, legacy: true,  title: '彻底搞懂 OLLVM',                       file: 'ch19-ollvm.html',  track: 'C', tags: ['LLVM','Pass','-fla','-bcf','-sub'],
        desc: '从 LLVM Pass 机制出发，源码级拆解三大混淆与字符串加密，并学会反混淆。' },
      { no: 20, legacy: true,  title: '高级调试之 VMP',                       file: 'ch20-vmp.html',    track: 'C', tags: ['VMP','字节码','反调试','Hypervisor'],
        desc: '虚拟机保护的翻译-解释模型；把调试器藏到内核/Hypervisor 层级。' },
      { no: 21, legacy: true,  title: 'Unicorn / unidbg 模拟执行',            file: 'ch21-unidbg.html', track: 'C', tags: ['Unicorn','Capstone','JNI','补环境'],
        desc: '不启动 App、在 PC 上跑 so 加密函数；补环境与黑盒调用服务化。' },
      { no: 22, legacy: true,  title: '非标准算法还原（上）',                  file: 'ch22-algo1.html',  track: 'C', tags: ['魔改','常量特征','Base64','AES'],
        desc: '常量比对 + 动态 Trace 抓中间状态，识别魔改 Base64/MD5/RC4/AES。' },
      { no: 23, legacy: true,  title: '非标准算法还原（下）',                  file: 'ch23-algo2.html',  track: 'C', tags: ['OpenSSL','动态编码表','RPC'],
        desc: '动态编码表内存比对、加盐改常量组合变种、自动化黑盒调用收尾。' },
      { no: 24, legacy: true, title: 'Frida + FART 脱壳进阶',                file: 'ch24-fart2.html',  track: 'C', tags: ['fdex2','jadx','反Frida'],
        desc: 'fdex2 路线与高版本适配、定制 jadx、Frida 特征检测与对抗闭环。' },
      { no: 25, legacy: true, title: 'eBPF 环境搭建与源码赏析',              file: 'ch25-ebpf.html',   track: 'C', tags: ['eBPF','内核','tracepoint','kprobe'],
        desc: '内核态观测：BPF 程序加载、验证器、map 通信与安卓上的落地现状。' },
      { no: 26, legacy: true, title: 'FART 10 & 12 版本演进',                file: 'ch26-fart10.html', track: 'C', tags: ['Android 10','Android 14','DexProtector'],
        desc: '每个安卓大版本 ART 结构都变，脱壳点需要重新定位与移植。' },
      { no: 27, legacy: true, title: '内核模块绕过 Frida 检测',              file: 'ch27-svc.html',    track: 'C', tags: ['SVC','syscall','硬件断点','0r0env'],
        desc: '绕过 libc 的直接系统调用、内存动态释放、硬件断点分析 JNI 地址。' },
      { no: 28, legacy: true, title: 'iOS 设备指纹开发与逆向',               file: 'ch28-ios.html',    track: 'C', tags: ['ObjC','SSL Pinning','砸壳','FairPlay'],
        desc: 'objc_msgSend 消息机制 Hook、iOS 反调试绕过与 SSL Pinning bypass。' },
      { no: 29, legacy: true, title: '云手机核心原理与检测',                  file: 'ch29-cloud.html',  track: 'C', tags: ['Hypervisor','QEMU','NAT','风控'],
        desc: 'Type-1/2 虚拟化、QEMU 网络模式、虚拟化环境检测与对抗。' },
      { no: 30, legacy: true, title: '安卓模拟器环境与原理揭密',              file: 'ch30-emulator.html', track: 'C', tags: ['AOSP','GKI','Cuttlefish','指令翻译'],
        desc: 'x86 上跑安卓的指令翻译、GKI 内核替换与 Cuttlefish 云设备。' },
      { no: 31, legacy: true, title: '容器化核心原理',                       file: 'ch31-container.html', track: 'C', tags: ['namespace','cgroup','Docker','binfmt'],
        desc: 'namespaces 隔离 + cgroup 限额；手写一个迷你 Docker 运行时。' },
      { no: 32, legacy: true, title: '安卓容器化原理与核心点深度解析',        file: 'ch32-android-container.html', track: 'C', tags: ['Waydroid','Magisk','KVM','virtio'],
        desc: '全课程集大成：从内核、init、系统分区到虚拟 WiFi 的云端安卓环境。' }
    ],
    tracks: {
      A: { name: '第一程 · 入门地基（1w 计划）', color: '#a3e635' },
      B: { name: '第二程 · 基础技能补遗（2w 计划）', color: '#e879f9' },
      C: { name: '第三程 · 进阶与深水区（3w 计划）', color: '#4da3ff' }
    },
  };
  global.COURSE = COURSE;

  /* ------------------------------------------------------------ 存储（降级安全） */
  const KEY = 'akkc-progress-v1';
  let memStore = null;
  const store = {
    read() {
      if (memStore) return memStore;
      try {
        const raw = global.localStorage.getItem(KEY);
        return raw ? JSON.parse(raw) : { chapters: {}, soc: {}, quiz: {} };
      } catch (e) {
        memStore = { chapters: {}, soc: {}, quiz: {} };
        return memStore;
      }
    },
    write(d) {
      if (memStore) { memStore = d; return; }
      try { global.localStorage.setItem(KEY, JSON.stringify(d)); }
      catch (e) { memStore = d; }
    },
    get(path, dflt) {
      const d = store.read();
      return path.split('.').reduce((a, k) => (a == null ? a : a[k]), d) ?? dflt;
    },
    set(path, val) {
      const d = store.read();
      const ks = path.split('.');
      let cur = d;
      for (let i = 0; i < ks.length - 1; i++) { cur[ks[i]] = cur[ks[i]] || {}; cur = cur[ks[i]]; }
      cur[ks[ks.length - 1]] = val;
      store.write(d);
    },
    reset() { memStore = null; store.write({ chapters: {}, soc: {}, quiz: {} }); }
  };
  global.AKKC_STORE = store;

  /* ------------------------------------------------------------ 工具函数 */
  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s).toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[，。；：！？、“”‘’（）《》,.;:!?"'()<>\[\]{}]/g, ' ')
    .trim();

  /* 中文友好的"包含"判定：英文按词边界，中文按子串 */
  function hasConcept(text, alternatives) {
    const t = norm(text);
    const tRaw = String(text).toLowerCase();
    return alternatives.some(alt => {
      const a = norm(alt);
      if (!a) return false;
      // 含 CJK 的候选：直接子串匹配（压缩空格后）
      if (/[\u4e00-\u9fff]/.test(alt)) return t.replace(/ /g, '').includes(a.replace(/ /g, ''));
      // 纯 ASCII：多词短语按整体子串，单词按边界
      if (a.includes(' ')) return t.includes(a);
      return new RegExp('(^|[^a-z0-9_.])' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9_.]|$)', 'i').test(tRaw);
    });
  }
  global.AKKC_hasConcept = hasConcept;

  /* 去掉 HTML 标签，得到纯文本（用于相似度比较） */
  function stripTags(s) {
    return String(s)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|li|div|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
  global.AKKC_stripTags = stripTags;

  /* 文本相似度（0-1）：基于字符 bigram 的 Jaccard + 覆盖率
     用于检测"直接抄参考答案"，中文友好。 */
  function similarity(a, b) {
    const clean = s => String(s).replace(/[\s\u3000]+/g, '').replace(/[，。；：！？、“”‘’（）《》,.;:!?"'()<>\[\]{}·—\-]/g, '');
    const A = clean(a), B = clean(b);
    if (!A || !B) return 0;
    if (A.length < 8 || B.length < 8) return A === B ? 1 : 0;
    const grams = s => {
      const g = new Set();
      for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
      return g;
    };
    const ga = grams(A), gb = grams(B);
    let inter = 0;
    ga.forEach(x => { if (gb.has(x)) inter++; });
    const union = ga.size + gb.size - inter;
    const jaccard = union ? inter / union : 0;
    // 覆盖率：答案被参考覆盖的比例（抄短句也能被抓）
    const cover = ga.size ? inter / ga.size : 0;
    return Math.max(jaccard, cover * 0.85);
  }
  global.AKKC_similarity = similarity;

  /* ------------------------------------------------------------ 顶部导航 / 进度 */
  function mountTopbar() {
    const ch = document.body.dataset.chapter ? parseInt(document.body.dataset.chapter, 10) : null;
    const meta = ch ? COURSE.chapters.find(c => c.no === ch) : null;

    const bar = document.createElement('div');
    bar.className = 'topbar';
    bar.innerHTML =
      '<a class="brand" href="index.html">🛡️ <b>安卓高级研修班</b> · 模拟器</a>' +
      '<div class="spacer"></div>' +
      '<nav class="nav-links">' +
        (meta ? '<a class="tb-link" href="index.html">◀ 课程地图</a>' : '') +
        (meta && meta.no > 1  ? '<a class="tb-link" href="' + COURSE.chapters[meta.no - 2].file + '">上一章</a>' : '') +
        (meta && meta.no < COURSE.chapters.length ? '<a class="tb-link" href="' + COURSE.chapters[meta.no].file + '">下一章</a>' : '') +
        '<a class="tb-link" href="slides.html">📊 演示稿</a>' +
        '<a class="tb-link" href="toolbox.html">🧰 工具箱</a>' +
        '<a class="tb-link primary" href="index.html#progress">学习进度</a>' +
      '</nav>';
    document.body.insertBefore(bar, document.body.firstChild);

    const track = document.createElement('div');
    track.className = 'progress-track';
    document.body.insertBefore(track, document.body.firstChild);
    addEventListener('scroll', () => {
      const h = document.documentElement.scrollHeight - innerHeight;
      track.style.width = (h > 0 ? (scrollY / h) * 100 : 0) + '%';
    }, { passive: true });

    if (meta) markVisited(meta.no);
  }

  function markVisited(no) {
    const cur = store.get('chapters', {}) || {};
    if (!cur[no]) { cur[no] = { visited: true, at: Date.now() }; store.set('chapters', cur); }
  }
  function markComplete(no, extra) {
    const cur = store.get('chapters', {}) || {};
    cur[no] = Object.assign({}, cur[no], { done: true, at: Date.now() }, extra || {});
    store.set('chapters', cur);
    refreshBadge();
  }
  global.AKKC_markComplete = markComplete;
  global.AKKC_markVisited = markVisited;

  function refreshBadge() {
    const b = $('#floatBadge');
    if (!b) return;
    const done = Object.values(store.get('chapters', {}) || {}).filter(c => c && c.done).length;
    b.querySelector('b').textContent = done + ' / ' + COURSE.chapters.length;
  }

  function mountBadge() {
    if (document.body.dataset.noBadge) return;
    const ch = document.body.dataset.chapter ? parseInt(document.body.dataset.chapter, 10) : null;
    const done = Object.values(store.get('chapters', {}) || {}).filter(c => c && c.done).length;
    const b = document.createElement('div');
    b.className = 'float-badge'; b.id = 'floatBadge';
    b.innerHTML = '<span>已完成章节</span><b>' + done + ' / ' + COURSE.chapters.length + '</b>' +
      '<span class="fb-close" title="隐藏">✕</span>';
    b.querySelector('.fb-close').onclick = () => b.remove();
    document.body.appendChild(b);
  }

  /* ------------------------------------------------------------ 页脚章节导航 */
  function mountChapnav() {
    const holder = $('#chapnav');
    if (!holder) return;
    const no = parseInt(document.body.dataset.chapter, 10);
    const prev = COURSE.chapters.find(c => c.no === no - 1);
    const next = COURSE.chapters.find(c => c.no === no + 1);
    holder.className = 'chapnav';
    holder.innerHTML =
      (prev ? '<a href="' + prev.file + '"><div class="cn-dir">◀ 上一章</div><div class="cn-title">' + esc(prev.title) + '</div></a>'
            : '<a class="disabled"><div class="cn-dir">◀ 上一章</div><div class="cn-title">已是第一章</div></a>') +
      (next ? '<a class="next" href="' + next.file + '"><div class="cn-dir">下一章 ▶</div><div class="cn-title">' + esc(next.title) + '</div></a>'
            : '<a class="disabled next"><div class="cn-dir">下一章 ▶</div><div class="cn-title">已是最后一章</div></a>');
  }

  /* ==========================================================================
     组件 1：代码步进器  CodeStepper
     用法： new CodeStepper(el, { lines:[{code, note, state:{}, mem:''}], title })
     ========================================================================== */
  function CodeStepper(root, cfg) {
    const self = this;
    this.root = root; this.cfg = cfg; this.i = 0;
    const steps = cfg.lines || [];

    root.classList.add('stepper');
    root.innerHTML =
      '<div class="stepper-head"><span class="st-title">' + (cfg.title || '代码推演') + '</span>' +
        '<span class="pill acc mono">' + steps.length + ' 步</span></div>' +
      '<div class="stepper-body">' +
        '<div class="stepper-code"></div>' +
        '<div class="stepper-side">' +
          '<h5>这一步在做什么</h5><div class="stepper-explain"></div>' +
          '<h5>状态</h5><table class="state-table"></table>' +
          '<div class="stepper-mem" style="margin-top:12px"></div>' +
        '</div>' +
      '</div>' +
      '<div class="stepper-ctl">' +
        '<button class="btn" data-a="reset">↺ 重置</button>' +
        '<button class="btn" data-a="prev">◀ 上一步</button>' +
        '<button class="btn primary" data-a="next">下一步 ▶</button>' +
        '<button class="btn ghost" data-a="all">全部展开</button>' +
        '<div class="step-dots"></div>' +
      '</div>';

    const codeEl = $('.stepper-code', root);
    const dotsEl = $('.step-dots', root);

    steps.forEach((s, k) => {
      const d = document.createElement('span');
      d.className = 'ln'; d.dataset.ln = k + 1;
      d.innerHTML = s.code == null ? '&nbsp;' : s.code;
      codeEl.appendChild(d);
      const dot = document.createElement('i');
      dot.title = '第 ' + (k + 1) + ' 步';
      dot.onclick = () => self.go(k);
      dotsEl.appendChild(dot);
    });

    root.addEventListener('click', e => {
      const a = e.target.dataset && e.target.dataset.a;
      if (!a) return;
      if (a === 'next') self.go(self.i + 1);
      else if (a === 'prev') self.go(self.i - 1);
      else if (a === 'reset') self.go(0);
      else if (a === 'all') self.go(steps.length - 1);
    });

    document.addEventListener('keydown', e => {
      if (!root.dataset.kbd) return;
      if (e.key === 'ArrowRight') { self.go(self.i + 1); e.preventDefault(); }
      if (e.key === 'ArrowLeft')  { self.go(self.i - 1); e.preventDefault(); }
    });

    this.go(0);
  }
  CodeStepper.prototype.go = function (n) {
    const steps = this.cfg.lines || [];
    this.i = Math.max(0, Math.min(steps.length - 1, n));
    const s = steps[this.i] || {};
    $$('.stepper-code .ln', this.root).forEach((el, k) => {
      el.classList.toggle('active', k === this.i);
      el.classList.toggle('done', k < this.i);
    });
    $$('.step-dots i', this.root).forEach((el, k) => {
      el.classList.toggle('on', k === this.i);
      el.classList.toggle('past', k < this.i);
    });
    $('.stepper-explain', this.root).innerHTML = s.note || '<span class="muted">—</span>';
    const tbl = $('.state-table', this.root);
    const st = s.state || {};
    tbl.innerHTML = Object.keys(st).length
      ? Object.keys(st).map(k => '<tr><td>' + esc(k) + '</td><td>' + esc(st[k]) + '</td></tr>').join('')
      : '<tr><td colspan="2" class="muted">（本例无寄存器状态）</td></tr>';
    const mem = $('.stepper-mem', this.root);
    if (s.mem) { mem.style.display = ''; mem.innerHTML = s.mem; }
    else mem.style.display = 'none';
  };

  /* ==========================================================================
     组件 2：苏格拉底严师  SocraticTeacher
     —— 不断追问，直到学生把关键概念说全
     ========================================================================== */
  function SocraticTeacher(root, cfg) {
    const self = this;
    this.root = root; this.cfg = cfg;
    this.round = 0;            // 当前追问轮次
    this.attempts = 0;         // 本题尝试次数
    this.qIndex = 0;           // 第几个问题
    this.q = cfg.questions[0];
    this.log = [];
    this.forceModel = false;   // 是否处于"已给答案，等待复述"状态
    this.saved = store.get('soc', {}) || {};
    this.state = this.saved[cfg.id] || { cleared: [], scores: {}, attempts: 0, done: false };
    this.render();
  }

  SocraticTeacher.prototype.render = function () {
    const c = this.cfg, self = this;
    const cleared = this.state.cleared.length;
    const total = c.questions.length;
    const pct = Math.round(cleared / total * 100);

    this.root.className = 'teacher';
    this.root.innerHTML =
      '<div class="teacher-head">' +
        '<div class="avatar">🧑‍🏫</div>' +
        '<div><div class="t-name">' + esc(c.name || '追问老师') + '</div>' +
        '<div class="t-sub">' + esc(c.sub || '不把关键概念说全，我不会放你走') + '</div></div>' +
        '<div class="t-stat">通过 <b>' + cleared + '</b>/' + total +
          '　追问 <b>' + this.round + '</b> 轮<br>作答 <b>' + this.state.attempts + '</b> 次</div>' +
      '</div>' +
      '<div class="teacher-body">' +
        (c.intro ? '<div class="note key" style="margin-top:0"><div class="note-h">老师的开场白</div>' + c.intro + '</div>' : '') +
        '<div class="soc-round" id="socStage"></div>' +
        '<div class="soc-meter"><div class="bar"><i style="width:' + pct + '%"></i></div>' +
          '<span class="pct">' + pct + '%</span></div>' +
        '<div style="margin-top:14px;display:flex;gap:9px;flex-wrap:wrap">' +
          '<button class="btn ghost" data-soc="pick">🎲 随机换一题</button>' +
          '<button class="btn ghost" data-soc="list">📋 查看已通过</button>' +
          '<button class="btn ghost" data-soc="reset">↺ 重置本关</button>' +
        '</div>' +
      '</div>';

    this.stage = $('#socStage', this.root);
    this.root.addEventListener('click', e => {
      const a = e.target.dataset && e.target.dataset.soc;
      if (!a) return;
      if (a === 'pick')    self.pickRandom();
      else if (a === 'list') self.showList();
      else if (a === 'reset') { self.state = { cleared: [], scores: {}, attempts: 0, done: false }; self.persist(); self.qIndex = 0; self.q = c.questions[0]; self.round = 0; self.forceModel = false; self.log = []; self.render(); }
      else if (a === 'submit') self.submit();
      else if (a === 'hint')   self.hint();
      else if (a === 'model')  self.showModel();
      else if (a === 'next')   self.nextQuestion();
    });
    this.stage.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); self.submit(); }
    });

    this.drawQuestion();
  };

  SocraticTeacher.prototype.persist = function () {
    const s = store.get('soc', {}) || {};
    s[this.cfg.id] = this.state; store.set('soc', s);
    if (this.state.cleared.length === this.cfg.questions.length && !this.state.done) {
      this.state.done = true;
      const s2 = store.get('soc', {}) || {}; s2[this.cfg.id] = this.state; store.set('soc', s2);
      markComplete(this.cfg.chapter, { soc: true });
    }
  };

  SocraticTeacher.prototype.drawQuestion = function () {
    const q = this.q;
    this.stage.innerHTML =
      '<div class="soc-q">' +
        '<span class="qmark">Q' + (this.qIndex + 1) + '</span>' +
        '<div class="qtext">' + q.q +
          '<span class="depth">深度 ' + (q.depth || 1) + '/3</span></div>' +
      '</div>' +
      '<div class="soc-input-row">' +
        '<textarea class="soc-input" id="socAns" placeholder="用你自己的话回答。说得越具体，我越容易放你过关。&#10;（Ctrl + Enter 提交）"></textarea>' +
      '</div>' +
      '<div style="margin-top:11px;display:flex;gap:9px;flex-wrap:wrap">' +
        '<button class="btn primary" data-soc="submit">提交作答</button>' +
        '<button class="btn" data-soc="hint">💡 给点提示</button>' +
        '<button class="btn ghost" data-soc="model">🔓 直接看参考答案</button>' +
      '</div>' +
      '<div id="socFb"></div>' +
      (this.log.length ? '<details class="acc" style="margin-top:14px"><summary>本轮对话记录（' + this.log.length + ' 条）</summary><div class="acc-body">' + this.log.map(l => l).join('') + '</div></details>' : '');
  };

  SocraticTeacher.prototype.submit = function () {
    const ta = $('#socAns', this.root);
    if (!ta) return;
    const ans = ta.value.trim();
    if (!ans) { this.feedback('ask', '先别急着交白卷', '写点什么。哪怕只是猜——猜错了我才知道你的模型歪在哪。'); return; }

    const q = this.q;
    this.attempts++; this.state.attempts++;
    const concepts = q.concepts || [];
    const hits = [], misses = [];
    concepts.forEach(cp => (hasConcept(ans, cp.any) ? hits : misses).push(cp));

    const ratio = concepts.length ? hits.length / concepts.length : 0;
    const passMark = q.threshold != null ? q.threshold : 0.75;

    this.log.push('<div class="soc-feedback model" style="margin-bottom:10px"><div class="fb-h">你</div>' + esc(ans).replace(/\n/g, '<br>') + '</div>');

    /* ---- 复述关卡：参考答案已给出，必须用自己的话复述 ---- */
    if (this.forceModel) {
      // ① 抄袭检测：与参考答案高度重合 → 打回
      const copied = similarity(ans, stripTags(q.model || ''));
      if (ans.length > 40 && copied > 0.72) {
        this.feedback('ask', '🚫 这是抄的。',
          '<p style="margin-top:0">你和参考答案的重合度是 <b>' + Math.round(copied * 100) + '%</b>——' +
          '我给的答案你还没消化，只是搬运了一遍。</p>' +
          '<p style="margin-bottom:0"><b>换个方式：</b>把答案关掉，凭记忆写。' +
          '写得糙没关系，<span class="hit">用你自己的词、你自己的例子、你自己的顺序</span>——' +
          '哪怕只有三句话，只要是你的理解，我就认。</p>');
        return;
      }
      // ② 复述需要命中同样的关键概念（阈值略放宽，因为不求措辞完整）
      const rPass = concepts.length ? (hits.length / concepts.length) >= Math.max(0.5, passMark - 0.2) : ans.length > 40;
      if (!rPass) {
        const need = Math.max(1, Math.ceil(concepts.length * Math.max(0.5, passMark - 0.2)));
        this.feedback('partial', '🟡 复述得还不够',
          '<b>你已经说到的：</b><ul>' + (hits.length ? hits.map(h => '<li><span class="hit">✔</span> ' + h.label + '</li>').join('') : '<li class="muted">（还没有）</li>') + '</ul>' +
          '<b>还差这些要点：</b><ul>' + misses.map(m => '<li><span class="miss">?</span> ' + (m.hint || m.label) + '</li>').join('') + '</ul>' +
          '<div style="margin-top:10px;color:var(--fg-3)">至少要说到 <b>' + need + '</b> 个要点。' +
          '不用背原文——<span class="hit">说清"是什么、为什么"就行</span>。</div>');
        return;
      }
      // ③ 通过
      this.forceModel = false;
      if (this.state.cleared.indexOf(q.id) < 0) this.state.cleared.push(q.id);
      this.state.scores[q.id] = Math.max(this.state.scores[q.id] || 0, Math.round(ratio * 100));
      this.persist();
      this.feedback('pass', '✅ 复述通过——这次是你自己的话了',
        '<p style="margin-top:0">命中 <b>' + hits.length + '/' + concepts.length + '</b> 个要点，' +
        '且与参考答案的措辞重合度只有 <b>' + Math.round(copied * 100) + '%</b>。</p>' +
        '<div style="padding:12px 14px;background:rgba(55,214,122,.08);border:1px solid rgba(55,214,122,.3);border-radius:8px">' +
        hits.map(h => '<div><span class="hit">✔</span> ' + h.label + '</div>').join('') + '</div>' +
        '<p style="color:var(--fg-3);margin-bottom:0">复述检验的是<b>能否重建</b>，不是<b>能否辨认</b>。' +
        '能讲出来，才算真的进了你的知识体系。</p>' +
        (q.after ? '<div style="margin-top:12px;padding-top:12px;border-top:1px dashed var(--line)">' + q.after + '</div>' : '') +
        '<div style="margin-top:12px"><button class="btn ok" data-soc="next">下一题 ▶</button></div>');
      this.round = 0;
      this.syncStats();
      return;
    }

    const passed = ratio >= passMark;

    if (passed) {
      if (this.state.cleared.indexOf(q.id) < 0) this.state.cleared.push(q.id);
      this.state.scores[q.id] = Math.max(this.state.scores[q.id] || 0, Math.round(ratio * 100));
      this.persist();
      this.feedback('pass', '✅ 这一关你过了（命中 ' + hits.length + '/' + concepts.length + ' 个关键点）',
        '<b>你答对的核心：</b><ul>' + hits.map(h => '<li><span class="hit">✔</span> ' + h.label + '</li>').join('') + '</ul>' +
        (misses.length ? '<p style="margin-bottom:0"><b>顺带补一句：</b>还有 ' + misses.length +
          ' 个点你没提，但不是致命伤——' + misses.map(m => m.label).join('、') + '。</p>' : '') +
        (q.after ? '<div style="margin-top:12px;padding-top:12px;border-top:1px dashed var(--line)">' + q.after + '</div>' : '') +
        '<div style="margin-top:12px"><button class="btn ok" data-soc="next">下一题 ▶</button></div>');
      this.round = 0;
      this.syncStats();
      return;
    }

    // 未通过 —— 进入追问
    this.round++;
    const hint = (q.hints && q.hints[Math.min(this.round - 1, q.hints.length - 1)]) || '';
    const probe = (q.probes && q.probes[Math.min(this.round - 1, q.probes.length - 1)]) || '';

    let head, cls, body;
    if (this.round >= 3 && q.model) {
      cls = 'ask';
      head = '⛔ 第三次了。我直接告诉你 —— 但这一题还没结束。';
      body = '<div style="margin:10px 0;padding:12px 14px;background:rgba(0,0,0,.28);border-radius:8px;border:1px solid var(--line)">' +
             q.model + '</div>' +
             '<div style="padding:12px 14px;background:rgba(255,138,61,.1);border:1px solid rgba(255,138,61,.35);border-radius:8px">' +
             '<b>⚠️ 这一题现在标记为「待复述」。</b><br>' +
             '请你<b>关掉上面这段、凭记忆用你自己的话重写一遍</b>。<br>' +
             '<span style="color:var(--fg-3)">不许复制粘贴——我会比对重合度，抄的一眼就能看出来。' +
             '写得糙没关系，是你自己的理解就行。</span></div>';
      this.forceModel = true;
    } else {
      cls = hits.length ? 'partial' : 'ask';
      head = hits.length ? '🟡 沾边了，但还不够。' : '❌ 方向不对，我们退一步。';
      body =
        (hits.length ? '<b>你已经说到的：</b><ul>' + hits.map(h => '<li><span class="hit">✔</span> ' + h.label + '</li>').join('') + '</ul>' : '') +
        (misses.length ? '<b>还差这些关键点：</b><ul>' + misses.map(m => '<li><span class="miss">?</span> ' + (m.hint || m.label) + '</li>').join('') + '</ul>' : '') +
        (probe ? '<div style="margin-top:12px"><b>我来追问：</b>' + probe + '</div>' : '') +
        (hint ? '<div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--line);color:var(--fg-3)">💡 ' + hint + '</div>' : '');
    }
    this.feedback(cls, head, body);
    this.syncStats();
    this.persist();
  };

  /* 头部统计 + 进度条刷新（复述通过/普通通过都走这里） */
  SocraticTeacher.prototype.syncStats = function () {
    const st = this.root.querySelector('.t-stat');
    if (st) st.innerHTML = '通过 <b>' + this.state.cleared.length + '</b>/' + this.cfg.questions.length +
      '　追问 <b>' + (this.forceModel ? '待复述' : this.round) + '</b> 轮<br>作答 <b>' + this.state.attempts + '</b> 次';
    const pv = Math.round(this.state.cleared.length / this.cfg.questions.length * 100);
    const bar = this.root.querySelector('.soc-meter .bar i');
    const pc = this.root.querySelector('.soc-meter .pct');
    if (bar) bar.style.width = pv + '%';
    if (pc) pc.textContent = pv + '%';
  };

  SocraticTeacher.prototype.hint = function () {
    const q = this.q;
    const h = (q.hints && q.hints[0]) || '先想想：这一步的输入是什么，输出是什么，中间谁改了内存？';
    this.feedback('model', '💡 提示（不算通过）',
      h + (q.hints && q.hints[1] ? '<div style="margin-top:8px">再给一条：' + q.hints[1] + '</div>' : ''));
  };

  SocraticTeacher.prototype.showModel = function () {
    // 看了参考答案 → 必须复述才算过（这是"直接看答案"的代价）
    this.forceModel = true;
    this.feedback('model', '🔓 参考答案已给出 —— 现在轮到你了',
      (this.q.model || '—') +
      '<div style="margin-top:12px;padding-top:12px;border-top:1px dashed var(--line)">' +
      '<b>⚠️ 看答案不算过关。</b>我已经把这一题标记为<b>「待复述」</b>：' +
      '你必须<b>关掉答案、凭记忆用你自己的话重写一遍</b>，并且不能和上面高度重合。</div>' +
      '<div style="margin-top:8px;color:var(--fg-3)">提示我都收走了——现在检验的是你能不能重建它。</div>');
    this.syncStats();
  };

  SocraticTeacher.prototype.feedback = function (cls, head, body) {
    const box = $('#socFb', this.root);
    if (!box) return;
    box.innerHTML = '<div class="soc-feedback ' + cls + '"><div class="fb-h">' + head + '</div>' + body + '</div>';
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  SocraticTeacher.prototype.nextQuestion = function () {
    const qs = this.cfg.questions;
    // 优先跳到未通过的
    const idx = qs.findIndex(q => this.state.cleared.indexOf(q.id) < 0);
    this.qIndex = idx >= 0 ? idx : (this.qIndex + 1) % qs.length;
    this.q = qs[this.qIndex];
    this.round = 0;
    this.forceModel = false;
    this.drawQuestion();
    const ta = $('#socAns', this.root); if (ta) ta.focus();
  };

  SocraticTeacher.prototype.pickRandom = function () {
    const qs = this.cfg.questions;
    const pool = qs.map((q, i) => i).filter(i => qs[i].id !== this.q.id);
    this.qIndex = pool[Math.floor(Math.random() * pool.length)];
    this.q = qs[this.qIndex];
    this.round = 0;
    this.drawQuestion();
  };

  SocraticTeacher.prototype.showList = function () {
    const qs = this.cfg.questions;
    this.feedback('model', '📋 已通过的关卡',
      '<ul>' + qs.map((q, i) => {
        const ok = this.state.cleared.indexOf(q.id) >= 0;
        return '<li>' + (ok ? '<span class="hit">✔</span>' : '<span class="miss">○</span>') +
          ' 第 ' + (i + 1) + ' 题（深度 ' + (q.depth || 1) + '）' +
          (ok ? '　得分 ' + (this.state.scores[q.id] || 0) + '%' : '') + '</li>';
      }).join('') + '</ul>' +
      (this.state.cleared.length === qs.length ? '<p style="color:var(--ok);margin-bottom:0"><b>全部通关。</b>这一章的概念模型已经在你脑子里了。</p>' : ''));
  };

  /* ==========================================================================
     组件 3：测验  Quiz
     ========================================================================== */
  function Quiz(root, cfg) {
    const self = this;
    this.root = root; this.cfg = cfg;
    root.className = 'quiz';
    const opts = cfg.options.map((o, i) =>
      '<div class="opt" data-i="' + i + '">' +
        '<span class="mark">' + 'ABCDEF'[i] + '</span>' +
        '<span style="flex:1"><span class="ot">' + o.t + '</span>' +
          (o.why ? '<span class="why">' + o.why + '</span>' : '') + '</span>' +
      '</div>').join('');
    root.innerHTML =
      (cfg.stem ? '<div class="q-stem">' + cfg.stem + '</div>' : '') +
      opts +
      '<div style="margin-top:12px"><button class="btn" data-q="show">看解析</button></div>' +
      '<div class="q-exp">' + (cfg.explain || '') + '</div>';
    root.addEventListener('click', e => {
      const opt = e.target.closest('.opt');
      if (opt && !root.dataset.locked) self.choose(parseInt(opt.dataset.i, 10));
      if (e.target.dataset && e.target.dataset.q === 'show') {
        $$('.opt', root).forEach(o => o.classList.add('reveal'));
        $('.q-exp', root).classList.add('show');
      }
    });
  }
  Quiz.prototype.choose = function (i) {
    const self = this, c = this.cfg;
    const correct = Array.isArray(c.answer) ? c.answer : [c.answer];
    const ok = correct.indexOf(i) >= 0;
    this.root.dataset.locked = '1';
    $$('.opt', this.root).forEach((o, k) => {
      o.classList.add('locked', 'reveal');
      if (correct.indexOf(k) >= 0) o.classList.add('correct');
      else if (k === i) o.classList.add('wrong');
    });
    $('.q-exp', this.root).classList.add('show');
    const s = store.get('quiz', {}) || {};
    s[c.id] = { ok: ok, at: Date.now() }; store.set('quiz', s);
    if (ok && c.chapter) {
      const qs = Object.values(s).filter(x => x && x.ok).length;
      if (qs >= (c.completeAt || 3)) markComplete(c.chapter, { quiz: true });
    }
  };

  /* ==========================================================================
     组件 4：决策树 / 情境演练  Decision
     ========================================================================== */
  function Decision(root, cfg) {
    const self = this;
    this.root = root; this.cfg = cfg;
    root.className = 'decision';
    this.render(cfg.start);
  }
  Decision.prototype.render = function (nodeId) {
    const self = this;
    const node = this.cfg.nodes[nodeId];
    if (!node) return;
    this.path = (this.path || []).concat(node.label || nodeId);
    let html = '';
    if (node.scenario) html += '<div class="d-scenario">' + node.scenario + '</div>';
    if (node.q) html += '<div class="q-stem" style="margin-bottom:12px;font-weight:600;color:var(--fg)">' + node.q + '</div>';

    if (node.choices) {
      html += '<div class="d-choices">' + node.choices.map((c, i) =>
        '<button class="d-choice" data-go="' + i + '">' + c.t + '</button>').join('') + '</div>';
    }
    if (node.terminal) {
      const good = node.verdict === 'good';
      html += '<div class="d-result show ' + (good ? 'good' : 'bad') + '">' +
        '<div style="font-weight:700;margin-bottom:6px;color:' + (good ? 'var(--ok)' : 'var(--bad)') + '">' +
        (good ? '✅ ' : '⚠️ ') + (node.verdictTitle || (good ? '这是一条可行路径' : '这条路会踩坑')) + '</div>' +
        (node.result || '') + '</div>' +
        '<div class="d-path">决策路径：' + esc(this.path.join(' → ')) + '</div>' +
        '<div style="margin-top:12px"><button class="btn primary" data-restart="1">↺ 换个选择重来</button></div>';
    }
    this.root.innerHTML = html;
    this.root.onclick = e => {
      const go = e.target.dataset && e.target.dataset.go;
      if (go != null) {
        const c = node.choices[parseInt(go, 10)];
        self.path = self.path.slice(0, -1).concat((node.label || nodeId) + '·选' + 'ABCDEF'[parseInt(go, 10)]);
        self.render(c.next);
      }
      if (e.target.dataset && e.target.dataset.restart) { self.path = []; self.render(self.cfg.start); }
    };
  };

  /* ==========================================================================
     组件 5：终端模拟  Term
     ========================================================================== */
  function Term(root, cfg) {
    this.root = root; this.cfg = cfg; this.i = 0;
    root.classList.add('stage');
    root.innerHTML =
      '<div class="stage-head"><span class="sg-title">' + (cfg.title || '终端') + '</span>' +
      '<span class="pill mono">' + cfg.lines.length + ' 行</span></div>' +
      '<div class="stage-body" style="padding:0"><div class="term-box"></div></div>' +
      '<div class="stage-ctl">' +
        '<button class="btn primary" data-t="next">▶ 执行下一行</button>' +
        '<button class="btn" data-t="all">⏩ 全部执行</button>' +
        '<button class="btn ghost" data-t="reset">↺ 重来</button>' +
      '</div>' +
      '<div class="stage-caption"></div>';
    this.box = $('.term-box', root);
    this.cap = $('.stage-caption', root);
    const self = this;
    root.addEventListener('click', e => {
      const a = e.target.dataset && e.target.dataset.t;
      if (a === 'next') self.step();
      else if (a === 'all') { while (self.i < cfg.lines.length) self.step(); }
      else if (a === 'reset') { self.i = 0; self.box.innerHTML = ''; self.cap.innerHTML = ''; }
    });
  }
  Term.prototype.step = function () {
    const l = this.cfg.lines[this.i];
    if (!l) return;
    const div = document.createElement('div');
    div.innerHTML = (l.t === 'p' ? '<span class="p">$ </span>' : '') + '<span class="' + (l.t || 'o') + '">' + l.s + '</span>';
    this.box.appendChild(div);
    if (l.note) this.cap.innerHTML = l.note;
    this.box.scrollTop = this.box.scrollHeight;
    this.i++;
    if (this.i >= this.cfg.lines.length) {
      const c = document.createElement('div');
      c.innerHTML = '<span class="p">$ </span><span class="cur"></span>';
      this.box.appendChild(c);
    }
  };

  /* ==========================================================================
     组件 6：动画舞台  Stage
     用法：new Stage(el, { steps:[{run: function(ctx){...}, note:'...'}], render:'html' })
     ========================================================================== */
  function Stage(root, cfg) {
    const self = this;
    this.root = root; this.cfg = cfg; this.i = -1;
    root.classList.add('stage');
    root.innerHTML =
      '<div class="stage-head"><span class="sg-title">' + (cfg.title || '动画演示') + '</span>' +
        (cfg.legend || '') + '</div>' +
      '<div class="stage-body">' + (cfg.render || '') + '</div>' +
      '<div class="stage-caption">点击"播放"开始逐步演示。</div>' +
      '<div class="stage-ctl">' +
        '<button class="btn primary" data-s="play">▶ 播放</button>' +
        '<button class="btn" data-s="step">单步 ▶|</button>' +
        '<button class="btn" data-s="prev">|◀ 上一步</button>' +
        '<button class="btn ghost" data-s="reset">↺ 重置</button>' +
        '<span class="pill mono st-idx">0 / ' + cfg.steps.length + '</span>' +
        '<button class="btn ghost" data-s="auto" style="margin-left:auto">⏱ 自动播放</button>' +
      '</div>';
    this.ctx = { root: root, $: s => $(s, root), $$: s => $$(s, root), cap: s => this.caption(s), i: 0 };
    // 初始渲染：始终执行一次 reset，让面板呈现"起点"状态
    if (cfg.reset) cfg.reset(this.ctx);
    root.addEventListener('click', e => {
      const a = e.target.dataset && e.target.dataset.s;
      if (a === 'step') this.step();
      else if (a === 'prev') this.prev();
      else if (a === 'reset') this.reset();
      else if (a === 'play') { this.reset(); this.play(); }
      else if (a === 'auto') this.auto();
    });
    this.sync();
  }
  Stage.prototype.caption = function (html) { $('.stage-caption', this.root).innerHTML = html; };
  Stage.prototype.sync = function () {
    const el = $('.st-idx', this.root);
    if (el) el.textContent = Math.max(0, this.i + 1) + ' / ' + this.cfg.steps.length;
  };
  Stage.prototype.reset = function () {
    clearInterval(this.timer); this.timer = null;
    this.i = -1;
    if (this.cfg.reset) this.cfg.reset(this.ctx);
    this.caption('已重置。点击"单步"或"播放"。');
    this.sync();
  };
  Stage.prototype.step = function () {
    if (this.i >= this.cfg.steps.length - 1) return false;
    this.i++;
    const s = this.cfg.steps[this.i];
    if (s.run) s.run(this.ctx);
    if (s.note) this.caption(s.note);
    this.sync();
    return true;
  };
  Stage.prototype.prev = function () {
    if (this.i < 0) return;
    this.i--;
    if (this.cfg.reset) this.cfg.reset(this.ctx);
    for (let k = 0; k <= this.i; k++) { const s = this.cfg.steps[k]; if (s.run) s.run(this.ctx); }
    this.caption(this.i >= 0 ? (this.cfg.steps[this.i].note || '') : '已回到起点。');
    this.sync();
  };
  Stage.prototype.play = function () {
    const self = this;
    clearInterval(this.timer);
    this.timer = setInterval(() => { if (!self.step()) clearInterval(self.timer); }, this.cfg.speed || 1300);
  };
  Stage.prototype.auto = function () { this.reset(); this.play(); };

  /* ==========================================================================
     组件 7：PPT 幻灯片  Deck
     —— 把一章的知识骨架做成可翻页的演示稿（对应"ppt演示"教学形式）
     ========================================================================== */
  function Deck(root, cfg) {
    const self = this;
    this.root = root; this.cfg = cfg; this.i = 0;
    const slides = cfg.slides || [];

    root.classList.add('stage', 'deck');
    root.innerHTML =
      '<div class="stage-head">' +
        '<span class="sg-title">' + (cfg.title || '知识骨架演示稿') + '</span>' +
        '<span class="pill acc mono dk-idx">1 / ' + slides.length + '</span>' +
        '<button class="btn ghost" data-dk="full">⛶ 全屏</button>' +
      '</div>' +
      '<div class="deck-stage"><div class="deck-slide"></div></div>' +
      '<div class="stage-ctl">' +
        '<button class="btn" data-dk="prev">◀ 上一页</button>' +
        '<button class="btn primary" data-dk="next">下一页 ▶</button>' +
        '<div class="step-dots dk-dots"></div>' +
        '<span class="pill mono dk-progress"></span>' +
      '</div>';

    this.slideEl = $('.deck-slide', root);
    this.dotsEl = $('.dk-dots', root);

    slides.forEach((s, k) => {
      const d = document.createElement('i');
      d.title = '第 ' + (k + 1) + ' 页';
      d.onclick = () => self.go(k);
      this.dotsEl.appendChild(d);
    });

    root.addEventListener('click', e => {
      const a = e.target.dataset && e.target.dataset.dk;
      if (!a) return;
      if (a === 'next') this.go(this.i + 1);
      else if (a === 'prev') this.go(this.i - 1);
      else if (a === 'full') this.fullscreen();
    });

    // 键盘：左右翻页（悬停/聚焦在本组件内时生效）
    root.tabIndex = 0;
    root.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight') { self.go(self.i + 1); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { self.go(self.i - 1); e.preventDefault(); }
    });

    this.go(0);
  }
  Deck.prototype.go = function (n) {
    const slides = this.cfg.slides || [];
    this.i = Math.max(0, Math.min(slides.length - 1, n));
    const s = slides[this.i];
    this.slideEl.innerHTML =
      '<div class="dk-head">' +
        (s.kicker ? '<span class="dk-kicker">' + s.kicker + '</span>' : '') +
        '<h3 class="dk-title">' + s.title + '</h3>' +
      '</div>' +
      '<div class="dk-body">' + (s.body || '') + '</div>' +
      (s.foot ? '<div class="dk-foot">' + s.foot + '</div>' : '');
    // 翻页动画
    this.slideEl.classList.remove('dk-anim');
    void this.slideEl.offsetWidth;
    this.slideEl.classList.add('dk-anim');

    $$('.dk-dots i', this.root).forEach((el, k) => {
      el.classList.toggle('on', k === this.i);
      el.classList.toggle('past', k < this.i);
    });
    const idx = $('.dk-idx', this.root);
    if (idx) idx.textContent = (this.i + 1) + ' / ' + slides.length;
    const pr = $('.dk-progress', this.root);
    if (pr) pr.textContent = Math.round((this.i + 1) / slides.length * 100) + '%';
  };
  Deck.prototype.fullscreen = function () {
    const el = this.root;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  };

  /* ==========================================================================
     组件 9：交互实验室  Lab
     —— 与前 8 个组件最大的区别：**读者要动手算**，不是看动画。
     三种子模式：calc（输入→计算→对比）、check（可编辑代码，按预期校验）、
                sandbox(自由探索，实时反馈)
     ========================================================================== */
  function Lab(root, cfg) {
    const self = this;
    this.root = root; this.cfg = cfg;
    this.io = {};        // 记录读者填过的值，用于"检查我的答案"
    this.tries = 0;

    root.classList.add('lab');
    let h =
      '<div class="lab-head">' +
        '<span class="lab-badge">🧪 动手实验</span>' +
        '<span class="lab-title">' + (cfg.title || '') + '</span>' +
        (cfg.goal ? '<span class="pill acc mono lab-goal">' + cfg.goal + '</span>' : '') +
      '</div>';

    if (cfg.intro) h += '<div class="lab-intro">' + cfg.intro + '</div>';

    // ---- 输入区 ----
    h += '<div class="lab-inputs">';
    (cfg.inputs || []).forEach((inp, i) => {
      const id = 'lab-in-' + i + '-' + Math.floor(Math.random() * 1e6);
      inp._id = id;
      h += '<label class="lab-field">' +
        '<span class="lf-label">' + inp.label + (inp.hint ? '<em class="lf-hint">' + inp.hint + '</em>' : '') + '</span>' +
        (inp.type === 'textarea'
          ? '<textarea class="lab-in" id="' + id + '" rows="' + (inp.rows || 3) + '" placeholder="' + esc(inp.ph || '') + '">' + esc(inp.value || '') + '</textarea>'
          : '<input class="lab-in' + (inp.type === 'hex' ? ' mono' : '') + '" id="' + id + '" type="text" placeholder="' + esc(inp.ph || '') + '" value="' + esc(inp.value || '') + '">') +
        '</label>';
    });
    h += '</div>';

    // ---- 操作按钮 ----
    h += '<div class="lab-actions">' +
      (cfg.runLabel ? '<button class="btn primary" data-lab="run">' + cfg.runLabel + '</button>' : '') +
      (cfg.expected ? '<button class="btn ok" data-lab="check">✓ 检查我的答案</button>' : '') +
      (cfg.showAnswer ? '<button class="btn ghost" data-lab="answer">🔓 看正确答案</button>' : '') +
      '<button class="btn ghost" data-lab="reset">↺ 清空重来</button>' +
      (cfg.hint ? '<button class="btn ghost" data-lab="hint">💡 提示</button>' : '') +
      '</div>';

    // ---- 输出区 ----
    h += '<div class="lab-out" id="' + (cfg._outId = 'lab-out-' + Math.floor(Math.random() * 1e6)) + '">' +
      '<div class="lab-placeholder">' + (cfg.placeholder || '填好上面的内容，然后点左边的按钮。') + '</div></div>';

    if (cfg.footer) h += '<div class="lab-footer">' + cfg.footer + '</div>';
    root.innerHTML = h;
    this.outEl = document.getElementById(cfg._outId);

    root.addEventListener('click', e => {
      const a = e.target.dataset && e.target.dataset.lab;
      if (!a) return;
      if (a === 'run') this.run();
      else if (a === 'check') this.check();
      else if (a === 'answer') this.answer();
      else if (a === 'reset') this.reset();
      else if (a === 'hint') this.hint();
    });
    // 回车即运行
    root.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && e.target.classList && e.target.classList.contains('lab-in')) {
        e.preventDefault(); cfg.expected ? this.check() : this.run();
      }
    });

    // 初始值存在则先跑一次
    if (cfg.autorun && (cfg.inputs || []).some(i => i.value)) this.run();
  }

  Lab.prototype.vals = function () {
    const o = {};
    (this.cfg.inputs || []).forEach((inp, i) => { o[inp.key || i] = $('#' + inp._id, this.root).value; });
    return o;
  };
  Lab.prototype.reset = function () {
    (this.cfg.inputs || []).forEach(inp => { $('#' + inp._id, this.root).value = ''; });
    this.outEl.innerHTML = '<div class="lab-placeholder">已清空。重新来过。</div>';
  };
  Lab.prototype.hint = function () {
    this.outEl.innerHTML = '<div class="lab-msg warn"><b>💡 提示</b><br>' + this.cfg.hint + '</div>';
  };
  Lab.prototype.answer = function () {
    this.outEl.innerHTML = '<div class="lab-msg model"><b>🔓 正确答案</b><div class="lab-answer">' +
      (this.cfg.showAnswer || '—') + '</div>' +
      '<div class="lab-note">看懂不算会——关掉它，自己再算一遍。</div></div>';
  };
  Lab.prototype.check = function () {
    const v = this.vals();
    this.tries++;
    let ok = true, detail = '';
    try {
      const r = this.cfg.expected(v);
      ok = r.ok; detail = r.detail || '';
    } catch (e) { ok = false; detail = '检查时出错：' + e.message; }

    this.outEl.innerHTML =
      '<div class="lab-msg ' + (ok ? 'pass' : 'fail') + '">' +
        '<b>' + (ok ? '✅ 对了' : '❌ 还不对') + '</b>' +
        '<div class="lab-note">' + detail + '</div>' +
      '</div>' +
      (ok && this.cfg.after ? '<div class="lab-msg key">' + this.cfg.after + '</div>' : '') +
      (!ok && this.tries >= 2 && this.cfg.showAnswer
        ? '<div class="lab-note">试了 ' + this.tries + ' 次了。可以点「🔓 看正确答案」，但看完要自己重算一遍。</div>' : '');
  };
  Lab.prototype.run = function () {
    const v = this.vals();
    let html;
    try { html = this.cfg.run ? this.cfg.run(v, this) : '<div class="lab-note">（本实验没有计算输出）</div>'; }
    catch (e) { html = '<div class="lab-msg fail"><b>计算出错</b><div class="lab-note">' + esc(e.message) + '</div></div>'; }
    this.outEl.innerHTML = html;
  };

  /* ==========================================================================
     组件 10：实战案例  Case
     —— 把社区里的真实案例，用本课程的方法论拆开讲，并索引到原帖
     ========================================================================== */
  const CASE_SOURCE = {
    kanxue:   { label: '看雪',    cls: 'acc',  home: 'https://bbs.kanxue.com/forum-161-1.htm' },
    pojie:    { label: '52破解',  cls: 'ok',   home: 'https://www.52pojie.cn/forum-65-1.html' },
    bilibili: { label: 'B站',     cls: 'warn', home: 'https://www.bilibili.com/' },
    github:   { label: 'GitHub',  cls: 'cool', home: 'https://github.com/' }
  };

  function Case(root, cfg) {
    const src = CASE_SOURCE[cfg.source] || CASE_SOURCE.kanxue;
    root.classList.add('case');

    const li = (arr, cls) => (arr || []).map(x =>
      '<li' + (cls ? ' class="' + cls + '"' : '') + '>' + x + '</li>').join('');

    let h =
      '<div class="case-head">' +
        '<span class="case-badge">📁 实战案例</span>' +
        '<span class="case-title">' + cfg.title + '</span>' +
        '<span class="pill ' + src.cls + ' case-src">' + src.label + '</span>' +
      '</div>' +
      '<div class="case-meta">' +
        (cfg.date ? '<span>📅 ' + cfg.date + '</span>' : '') +
        (cfg.author ? '<span>✍️ ' + cfg.author + '</span>' : '') +
        (cfg.target ? '<span>🎯 ' + cfg.target + '</span>' : '') +
      '</div>';

    if (cfg.background) h += '<div class="case-sec"><h4>📌 背景</h4><div>' + cfg.background + '</div></div>';

    if (cfg.points && cfg.points.length) {
      h += '<div class="case-sec"><h4>🔧 技术要点</h4><ul class="case-list">' + li(cfg.points) + '</ul></div>';
    }

    if (cfg.method && cfg.method.length) {
      h += '<div class="case-sec"><h4>🧭 作者的方法论（照着走一遍）</h4><ol class="case-steps">' + li(cfg.method) + '</ol></div>';
    }

    if (cfg.result) h += '<div class="case-sec case-result"><h4>🏁 结果</h4><div>' + cfg.result + '</div></div>';

    if (cfg.terms && cfg.terms.length) {
      h += '<div class="case-sec"><h4>🔖 涉及知识点</h4><div class="case-terms">' +
        cfg.terms.map(t => '<span class="pill">' + t + '</span>').join('') + '</div></div>';
    }

    if (cfg.limits) {
      h += '<div class="case-sec case-limits"><h4>⚠️ 局限与未完成</h4><div>' + cfg.limits + '</div></div>';
    }

    /* —— 用本课方法论拆解 —— */
    if (cfg.analysis) {
      h += '<div class="case-sec case-analysis"><h4>🎓 用本课方法论拆解</h4><div>' + cfg.analysis + '</div></div>';
    }

    if (cfg.link) {
      h += '<div class="case-link">' +
        '<a class="btn primary" href="' + cfg.link + '" target="_blank" rel="noopener">🔗 阅读原帖（' + src.label + '）</a>' +
        (cfg.linkNote ? '<span class="case-linknote">' + cfg.linkNote + '</span>' : '') +
        '</div>';
    }

    root.innerHTML = h;
  }

  /* ==========================================================================
     组件 8：术语提示 / 表格 / 代码高亮（轻量）
     ========================================================================== */
  function initTerms() {
    $$('.term').forEach(el => { el.tabIndex = 0; });
  }

  /* 极简高亮：只对「完全未手工高亮」的代码块生效。
     重要：内容作者绝大多数情况下已经手工写了 <span class="k"> 等高亮标签，
     此时必须整体跳过——否则正则会把文字片段再包一层，甚至把 class 属性写坏。 */
  function highlight() {
    $$('pre[data-hl]').forEach(pre => {
      const code = pre.querySelector('code') || pre;
      // 已经处理过，或作者已手工高亮 → 一律跳过
      if (code.dataset.hlDone || code.querySelector('span')) {
        code.dataset.hlDone = '1';
        return;
      }
      const raw = code.innerHTML;
      // 含未转义的 < > 时风险太高（正则无法区分「标签」和「小于号」），直接跳过
      if (/[<>]/.test(raw.replace(/&lt;|&gt;/g, '')) || raw.includes('&lt;')) {
        code.dataset.hlDone = '1';
        return;
      }
      // 只在纯文本上做高亮：整体一次替换，不做标签切分
      code.innerHTML = raw
        .replace(/(\/\/[^\n]*)/g, '<span class="c">$1</span>')
        .replace(/(&#39;[^&]*?&#39;)/g, '<span class="s">$1</span>')
        .replace(/\b(0x[0-9a-fA-F]+|\d+)\b/g, '<span class="n">$1</span>');
      code.dataset.hlDone = '1';
    });
  }

  /* ==========================================================================
     组件 8：自测进度（章节完成按钮）
     ========================================================================== */
  function mountComplete() {
    const no = parseInt(document.body.dataset.chapter, 10);
    const holder = $('#completeBox');
    if (!holder || !no) return;
    const st = (store.get('chapters', {}) || {})[no] || {};
    holder.innerHTML =
      '<div class="card" style="border-color:' + (st.done ? 'rgba(55,214,122,.45)' : 'var(--line)') + '">' +
        '<div class="card-title">' + (st.done ? '✅ 本章已完成' : '🎯 学完了吗？') + '</div>' +
        '<p class="muted" style="margin-top:0">勾选表示你已经能独立复述本章的核心机制与决策依据。</p>' +
        '<button class="btn ' + (st.done ? 'ok' : 'primary') + '" id="btnDone">' +
          (st.done ? '✔ 已标记完成（点击取消）' : '标记本章完成') + '</button>' +
      '</div>';
    $('#btnDone').onclick = () => {
      const cur = store.get('chapters', {}) || {};
      cur[no] = Object.assign({}, cur[no], { done: !st.done, at: Date.now() });
      store.set('chapters', cur);
      mountComplete(); refreshBadge();
    };
  }

  /* ==========================================================================
     初始化
     ========================================================================== */
  function boot() {
    // 章节页：先把数据渲染成 DOM（chapter.js 提供），再装配导航与组件
    if (global.CHAPTER && global.AKKC_renderChapter) {
      global.AKKC_renderChapter(global.CHAPTER);
    }

    mountTopbar();
    mountBadge();
    mountChapnav();
    mountComplete();
    initTerms();
    highlight();

    // 章节页的组件由 chapter.js 渲染后装配
    if (global.CHAPTER && global.AKKC_mountAll) {
      global.AKKC_mountAll();
      if (global.AKKC_INIT_EXTRA) global.AKKC_INIT_EXTRA();
    }

    // 自动装配声明式组件（老式写法，保留兼容）
    $$('[data-stepper]').forEach(el => {
      const cfg = JSON.parse(el.dataset.stepper);
      new CodeStepper(el, cfg);
    });
    $$('[data-teacher]').forEach(el => {
      const cfg = JSON.parse(el.dataset.teacher);
      const t = new SocraticTeacher(el, cfg);
      global['teacher_' + cfg.id] = t;
    });
    $$('[data-quiz]').forEach(el => { new Quiz(el, JSON.parse(el.dataset.quiz)); });
    $$('[data-decision]').forEach(el => { new Decision(el, JSON.parse(el.dataset.decision)); });
    $$('[data-term]').forEach(el => { new Term(el, JSON.parse(el.dataset.term)); });
  }

  global.AKKC = { $, $, esc, norm, CodeStepper, SocraticTeacher, Quiz, Decision, Term, Stage, Deck, Lab, Case, store, COURSE };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
