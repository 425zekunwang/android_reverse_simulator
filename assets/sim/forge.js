/* ==========================================================================
   Forge —— 靶场产物生成器（引擎）
   --------------------------------------------------------------------------
   FORGE.build(spec, seed) -> Artifact

   三条硬要求（PRACTICE-SPEC.md §5.1）：
     ① 纯函数：同 seed + 同 spec ⇒ images 逐字节相同。禁用 Math.random。
     ② truth 只进闭包，不进 DOM。
     ③ images 必须真：生成的 .so 是结构合法的 ELF64。

   本文件只有引擎。关卡定义（spec / objective / 参考解法）在 missions.js。
   挂到 window.FORGE
   ========================================================================== */
(function (global) {
  'use strict';

  const enc = s => new TextEncoder().encode(s);

  /* ---------------- 确定性 PRNG（mulberry32） ---------------- */
  /* 唯一允许的随机来源。任何地方出现 Math.random() 都是 bug。 */
  function makeRng(seed) {
    let a = (seed >>> 0) || 1;
    const next = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      next,
      int: n => Math.floor(next() * n),
      next32: () => (next() * 4294967296) >>> 0,
      bytes: n => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = Math.floor(next() * 256); return b; },
      pick: arr => arr[Math.floor(next() * arr.length)]
    };
  }

  /* ---------------- 通用派生器 ---------------- */
  /* 「魔改摘要初始状态字」：改 1 个标准 IV 字，小端写进常量区 */
  const MD5_STD_IV = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];

  const DERIVERS = {
    'md5-iv-mutate': (rng, opts) => {
      const base = (opts && opts.base) || MD5_STD_IV;
      const words = base.slice();
      const which = rng.int(words.length);
      let nv;
      do { nv = rng.next32(); } while (nv === words[which] || nv === 0);
      words[which] = nv >>> 0;
      const bytes = new Uint8Array(words.length * 4);
      const dv = new DataView(bytes.buffer);
      words.forEach((w, i) => dv.setUint32(i * 4, w, true));
      return { constant: bytes, truth: { ivWords: words, mutatedIndex: which, standardIv: base.slice() } };
    },

    /* 「原样常量」：把给定字节直接放进常量区（用于不需要魔改的关卡） */
    'raw': (rng, opts) => ({
      constant: Uint8Array.from((opts && opts.bytes) || []),
      truth: (opts && opts.truth) || {}
    })
  };

  /* ---------------- 内部：装载映像 ----------------
     ★ 必须**拷一份**再交给 SIMNATIVE.load。

     原因：SIMNATIVE.load 拿到的那个数组，就是它 patch 时直接改的那个数组
     （simmative.js 的 `bytes` 字段是 `elf.bytes` 本身，patch 做的是 `bytes.set(...)`）。
     不拷的话 `imgs[p].bytes` 与 `images[p]` **是同一个数组** ——
     玩家在 Hook 控制台 patch 一下，就同时改掉了「原始映像」。

     这不是理论风险，是实测出来的（2026-10-16）：
       img.patch(0x1020, 'deadbeef') 之后
         art.images[soPath][0x1020] = de ad be ef   ← 原始映像被改了
         reference.solve(art).words = 0xefbeadde …   ← "官方答案"跟着变了
     于是作者答案成了**路线历史的函数**，不再是 (关卡, seed) 的函数；
     而 art.images 还被用来落盘供外部 readelf 复核 —— 那会复核到另一个文件。

     拷了之后两边各司其职：
       images = 生成产物（只读、真相、参考解法、落盘复核）
       imgs   = 可变工作副本（设备读它，所以 patch 在设备上看得见）
     注意 truth.constant / truth.rodata 当初就做了 .slice()，唯独这里漏了。 */
  function loadImages(images) {
    const out = {};
    for (const [p, bytes] of Object.entries(images)) out[p] = global.SIMNATIVE.load(bytes.slice());
    return out;
  }

  /* =====================================================================
     build
     ===================================================================== */
  function build(spec, seed) {
    const rng = makeRng(seed);
    const id = spec.id;

    /* ---- ① 关卡产出常量 + 真相 ---- */
    const dv = DERIVERS[spec.so.derive];
    if (!dv) throw new Error('未知的派生器：' + spec.so.derive);
    const derived = dv(rng, spec.so.deriveOpts);
    const constant = derived.constant;

    /* ---- ② 摆放常量区：常量藏在噪声里，不是文件头 16 字节 ---- */
    const padBefore = spec.so.padBefore === undefined ? 16 + rng.int(3) * 16 : spec.so.padBefore;
    const padAfter = spec.so.padAfter === undefined ? 16 + rng.int(3) * 16 : spec.so.padAfter;
    const rodataOff = padBefore;
    const rodata = new Uint8Array(padBefore + constant.length + padAfter);
    rodata.set(rng.bytes(padBefore), 0);
    rodata.set(constant, padBefore);
    rodata.set(rng.bytes(padAfter), padBefore + constant.length);

    /* ---- ③ 真的生成 ELF ---- */
    const pkg = spec.app.pkg;
    const table = global.SIMNATIVE.writeTable(1);
    global.SIMNATIVE.writeEntry(table, 0, spec.so.op, constant.length, rodataOff);

    const elf = global.SIMELF;
    const elfBytes = elf.build({
      text: table,
      rodata,
      symbols: [
        { name: 'JNI_OnLoad', section: '.text', off: 0, size: global.SIMNATIVE.TABLE_HEAD, type: elf.STT.FUNC },
        { name: 'Java_' + pkg.replace(/\./g, '_') + '_Native_check', section: '.text',
          off: global.SIMNATIVE.TABLE_HEAD, size: 16, type: elf.STT.FUNC },
        { name: 'g_const', section: '.rodata', off: rodataOff, size: constant.length, type: elf.STT.OBJECT }
      ]
    });

    /* ---- ④ 设备世界 ---- */
    const dev = Object.assign({ model: 'Pixel 6', sdk: 31, abi: 'arm64-v8a', serial: 'SIM' + String(seed).padStart(5, '0') }, spec.device);
    const soPath = spec.so.path;
    const appInput = enc(spec.app.input);

    const files = {};
    files[soPath] = elfBytes;
    files['/data/local/tmp/README.txt'] = enc(
      '这是一台【模拟设备】，不是真 Android。\n' +
      '它由本站的 SimDevice 驱动：文件系统是虚拟的，命令表是有限的（输入 help 看支持哪些）。\n' +
      '但里面的 libtarget.so 是结构合法的真 ELF，native 计算也是真算的。\n'
    );

    const images = {};
    images[soPath] = elfBytes;
    const imgs = loadImages(images);

    /* ★ 设备侧（终端里的 strings / hexdump / cat）读的必须是**工作副本**，
       而不是生成产物：玩家在 Hook 控制台改写的是"设备上那个文件"，
       读文件就得看得见改写。两份数据各司其职：
         images  生成产物：参考解法、ELF 布局、落盘供外部复核 —— 只读
         imgs    工作副本：Hook 控制台改写它、设备读它、am start 用它真算

       两边接错的样子都出现过，且都是实测打出来的：
         · 指向同一个数组（原来的写法）→ 改一下原始映像也变了，
           reference.solve 给出的"官方答案"跟着变（成了路线历史的函数）
         · 拷了但没把设备接过来 → 改了之后终端里 hexdump 出来还是原样，
           而界面上明写着"改一个字节，输出就会变，可以在终端里自己验证" */
    files[soPath] = imgs[soPath].bytes;

    const artifact = {
      missionId: id,
      seed,
      device: dev,
      images: images,
      layout: { [soPath]: imgs[soPath].elf },
      imgs: imgs,
      world: {
        device: dev,
        files,
        props: Object.assign({
          'ro.product.model': dev.model,
          'ro.build.version.sdk': String(dev.sdk),
          'ro.product.cpu.abi': dev.abi,
          'ro.debuggable': '1'
        }, spec.props),
        bootTrace: (spec.bootTrace || ['init: 模拟设备启动', 'Zygote: 就绪', 'SystemServer: 就绪']).slice(),
        apps: [{
          pkg,
          label: spec.app.label || pkg,
          apkPath: spec.app.apkPath || null,
          soPath,
          native: { op: spec.so.op, input: appInput, tag: spec.app.logTag || 'Native', fmt: spec.app.logFmt }
        }]
      },
      /* ---- ⑤ 真相：只有校验器与复盘用，UI 不得渲染 ---- */
      truth: Object.assign({
        op: spec.so.op,
        constOffset: rodataOff,
        constant: constant.slice(),
        rodata: rodata.slice(),
        soPath,
        appPkg: pkg,
        appInput
      }, derived.truth)
    };

    /* ---- ⑥ 复盘数据：参考解法要用的、可公开的量（不含答案本身） ---- */
    artifact.public = {
      op: spec.so.op,
      soPath,
      appPkg: pkg,
      appInput,                      // 应用喂给 native 例行的那串输入，本来就写在 App 里
      device: dev,
      rodataSize: rodata.length,
      textSize: table.length,
      elfSize: elfBytes.length
    };

    return artifact;
  }

  global.FORGE = { build, makeRng, DERIVERS, MD5_STD_IV };
})(window);
