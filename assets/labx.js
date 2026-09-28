/* ==========================================================================
   实验库 —— 各章 Lab 的共享计算与渲染工具
   挂到 window.LABX，供 chapters/*.js 的 lab 配置调用
   ========================================================================== */
(function (global) {
  'use strict';
  const C = global.CRYPTO;

  /* 把十六进制串渲染成逐字节高亮块
     hex: 待比对串；ref: 参考串（可为 null）；mode: 'diff' 逐字节比对 */
  function hexDiff(hex, ref, unit) {
    const a = C.normHex(hex), b = ref ? C.normHex(ref) : null;
    if (!a.length) return '<span class="lab-placeholder">（等待输入）</span>';
    if (a.length % 2) return '<span class="lab-no">十六进制位数必须是偶数，当前 ' + a.length + ' 位</span>';
    unit = unit || 2;                     // 2 = 按字节；8 = 按 32 位字
    let out = '';
    for (let i = 0; i < a.length; i += unit) {
      const seg = a.substr(i, unit);
      const refSeg = b ? b.substr(i, unit) : null;
      let cls = '';
      if (refSeg !== null && refSeg.length === unit) {
        cls = seg === refSeg ? 'b-same' : 'b-diff';
      }
      out += '<span class="' + cls + '">' + seg + '</span>';
      if ((i / unit + 1) % (unit === 2 ? 16 : 4) === 0) out += '\n';
      else out += ' ';
    }
    return out;
  }

  /* 统计与参考串的差异 */
  function diffStat(hex, ref, unit) {
    const a = C.normHex(hex), b = C.normHex(ref);
    unit = unit || 2;
    let same = 0, diff = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i += unit) {
      if (a.substr(i, unit) === b.substr(i, unit)) same++; else diff++;
    }
    return { same, diff, total: same + diff };
  }

  /* 在候选算法里找最匹配的 —— 算法指纹识别的核心逻辑 */
  const FINGERPRINTS = {
    'MD5 IV':        '67452301efcdab8998badcfe10325476',
    'MD5 K[0..3]':   'd76aa478e8c7b756242070dbc1bdceee',
    'SHA-1 IV':      '67452301efcdab8998badcfe10325476c3d2e1f0',
    'SHA-256 IV':    '6a09e667bb67ae853c6ef372a54ff53a',
    'SHA-256 K[0..3]':'428a2f9871374491b5c0fbcfe9b5dba5',
    'CRC32 表[0..3]': '0000000077073096ee0e612c990951ba',
    'AES S盒[0..15]': '637c777bf26b6fc53001672bfed7ab76',
    'AES 逆S盒[0..3]':'52 09 6a d5'.replace(/ /g, '')
  };

  function identify(hex) {
    const a = C.normHex(hex);
    if (a.length < 8) return null;
    const hits = [];
    for (const [name, ref] of Object.entries(FINGERPRINTS)) {
      const n = Math.min(a.length, ref.length);
      let best = 0, bestOff = 0;
      // 允许在输入里滑动寻找（因为 dump 出的位置可能不对齐）
      for (let off = 0; off + n <= a.length; off += 2) {
        let same = 0;
        for (let i = 0; i < n; i += 2) if (a.substr(off + i, 2) === ref.substr(i, 2)) same++;
        if (same > best) { best = same; bestOff = off; }
      }
      const pct = Math.round(best / (n / 2) * 100);
      if (pct >= 50) hits.push({ name, pct, off: bestOff });
    }
    hits.sort((x, y) => y.pct - x.pct);
    return hits;
  }

  /* 从任意文本里抽出十六进制串（容错：支持 0x、空格、逗号、换行） */
  function extractHex(s) {
    const m = String(s).match(/(?:0x)?[0-9a-fA-F]{2}(?:[\s,]*[0-9a-fA-F]{2})+/g);
    if (!m) {
      const single = String(s).match(/^(?:0x)?[0-9a-fA-F]{2}$/);
      return single ? single[0] : '';
    }
    return m.join('');
  }

  /* 解析 C 数组字面量：{0x67,0x45,...} 或 "67 45 ..." */
  function parseCArray(s) {
    const hexes = String(s).match(/0x[0-9a-fA-F]{1,8}/g);
    if (hexes && hexes.length) {
      return hexes.map(h => {
        const v = parseInt(h, 16);
        return (v <= 0xff) ? v.toString(16).padStart(2, '0')
                           : v.toString(16).padStart(8, '0');
      }).join('');
    }
    return extractHex(s);
  }

  /* 解析 32 位常量列表 → 十六进制串（大端展示） */
  function parseWords32(s) {
    const hexes = String(s).match(/0x[0-9a-fA-F]{1,8}/g);
    if (!hexes) return extractHex(s);
    return hexes.map(h => (parseInt(h, 16) >>> 0).toString(16).padStart(8, '0')).join('');
  }

  /* ======================================================================
     以下为各章 Lab 的专用计算
     ====================================================================== */

  /* ---- 第 3 章：ARM 地址/Thumb 位/寄存器推断 ---- */
  const ARM32_ARGS = ['r0', 'r1', 'r2', 'r3'];
  const A64_ARGS   = ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7'];

  /* 解析 IDA 风格偏移，返回 { off, thumb, fridaAddr, mode } */
  function thumbDecode(input, arch) {
    let s = String(input).trim().replace(/^0x/i, '');
    const v = parseInt(s, 16);
    if (isNaN(v)) return null;
    if (arch === 'a64') {
      return { off: v, value: v, thumb: false, fridaAddr: v, mode: 'AArch64（全 4 字节定长，无 Thumb 位）' };
    }
    // ARM32：bit0 是标记位。IDA 显示的偏移通常是"偶数对齐"的真实入口，
    // 需要 +1 才能告诉 Frida 这是 Thumb。
    return {
      off: v,
      value: v,
      thumb: true,
      fridaAddr: v + 1,
      mode: 'ARM32 / Thumb'
    };
  }

  /* ---- 第 5 章：指令替换等价性 ---- */
  function sub32(a, b) { return (a + b) >>> 0; }
  function subVariant(a, b) { return ((a ^ b) + 2 * (a & b)) >>> 0; }
  function subVariant2(a, b) { return (a - (~b) - 1) >>> 0; }
  function subVariantSub(a, b) { return (a + (~b) + 1) >>> 0; }
  function subVariantXor(a, b) { return ((a | b) - (a & b)) >>> 0; }

  /* ---- 第 7 章：补环境依赖分类 ---- */
  const ENV_RULES = [
    { re: /^(malloc|calloc|realloc|free|memcpy|memmove|memset|memcmp|strlen|strcmp|strncmp|strcpy|strncpy|strstr|strcat)$/,
      cat: 'libc 库函数', how: '在 ELF 导入表里 Hook，或改写 GOT 表指向自己的实现' },
    { re: /^__android_log/, cat: 'liblog 日志', how: '直接返回 0（不实现日志，无副作用）' },
    { re: /^(pthread_|sem_|mutex)/, cat: 'pthread 线程原语', how: '单线程模拟时可直接返回 0；需要真并发才实现' },
    { re: /^(dlopen|dlsym|dlclose)/, cat: '动态链接', how: '由模拟器的模块加载器接管（unidbg 内置）' },
    { re: /^(open|openat|read|write|close|lseek|fstat|stat|access|unlink)$/,
      cat: '文件系统 syscall', how: '需要实现虚拟文件系统；检测类读取（/proc/self/maps 等）可返回伪造内容' },
    { re: /^(mmap|munmap|mprotect|brk)$/, cat: '内存 syscall', how: '映射到模拟器自己管理的内存区间' },
    { re: /^(gettimeofday|clock_gettime|time)$/, cat: '时间 syscall', how: '返回可控的固定值（也让耗时检测失效）' },
    { re: /^(JNI_OnLoad|RegisterNatives|FindClass|GetMethodID|CallObjectMethod|NewStringUTF|GetStringUTFChars|GetEnv|AttachCurrentThread)/,
      cat: '★ JNI 接口', how: '必须自己造 JNIEnv / JavaVM 函数表；回调 Java 层时还要伪造对应的类与方法' },
    { re: /^(getpid|getuid|gettid|sysconf|uname)$/, cat: '系统信息', how: '返回固定值；注意与设备指纹检测相关' },
    { re: /^(socket|connect|send|recv|bind|listen)$/, cat: '网络 syscall', how: '大多可直接返回失败；需要真实网络时才实现' },
  ];
  function classifyImport(name) {
    const n = String(name).trim();
    for (const r of ENV_RULES) if (r.re.test(n)) return { cat: r.cat, how: r.how };
    return { cat: '未知 / 自定义', how: '需要看它的实现或调用点，才能判断怎么补' };
  }

  /* ---- 第 13 章：SVC / syscall 解码 ---- */
  // 只收录教学中常用的、跨架构差异明显的调用号（注明以目标头文件为准）
  const SYSCALLS = {
    arm32: {
      3: 'read', 4: 'write', 5: 'open', 6: 'close', 20: 'getpid',
      33: 'access', 45: 'brk', 54: 'ioctl', 90: 'mmap', 91: 'munmap',
      125: 'mprotect', 146: 'writev', 192: 'mmap2', 197: 'fstat64',
      199: 'getuid32', 240: 'futex', 248: 'exit_group',
      // 注意：ARM 32 位下 open 是 5，openat 是 322
      322: 'openat'
    },
    a64: {
      56: 'openat', 57: 'close', 63: 'read', 64: 'write', 93: 'exit',
      94: 'exit_group', 96: 'set_tid_address', 98: 'futex', 160: 'uname',
      172: 'getpid', 174: 'getuid', 214: 'brk', 215: 'munmap',
      222: 'mmap', 226: 'mprotect', 48: 'faccessat'
    }
  };
  function decodeSyscall(arch, nr) {
    const t = SYSCALLS[arch === 'a64' ? 'a64' : 'arm32'];
    const name = t[nr];
    return name ? { name, known: true } : { name: '未收录（以目标平台头文件为准）', known: false };
  }

  /* ---- 第 2 章：dex 文件头解析（0x70 = 112 字节 header_item） ---- */
  // magic 形如 "dex\n035\0"（注意 0x0a 是换行、结尾是 0x00）
  const DEX_MAGIC = {
    'dex\n035\x00': 'Android 2.2–4.4（Dalvik 时代）',
    'dex\n036\x00': 'Android 6.0 预览',
    'dex\n037\x00': 'Android 5.0–6.0',
    'dex\n038\x00': 'Android 7.0–8.0',
    'dex\n039\x00': 'Android 9.0+',
    'dex\n040\x00': 'Android 10+（CompactDex 相关）'
  };
  function dexHeader(hex) {
    const h = normHexL(hex);
    if (h.length < 112 * 2) return { ok: false, err: 'dex 文件头是 112 字节（224 个十六进制字符），当前只有 ' + Math.floor(h.length / 2) + ' 字节' };
    const b = [];
    for (let i = 0; i < 224; i += 2) b.push(parseInt(h.substr(i, 2), 16));
    // magic: 前 8 字节，按原始字符（含控制字符）拼出来
    let magic = '';
    for (let i = 0; i < 8; i++) magic += String.fromCharCode(b[i]);
    const magicPretty = magic.replace(/\n/g, '\\n').replace(/\0/g, '\\0');
    const dv = new DataView(new Uint8Array(b).buffer);
    return {
      ok: true,
      magic,                                   // 原始（含 \n 与 \0）
      magicPretty,                             // 可显示形式 dex\n039\0
      versionLabel: DEX_MAGIC[magic] || '未知版本（可能是 CompactDex 或已被魔改）',
      checksum: dv.getUint32(8, true),         // Adler-32，小端
      signature: Array.from(b.slice(12, 32)).map(x => x.toString(16).padStart(2, '0')).join(''),
      fileSize: dv.getUint32(32, true),
      headerSize: dv.getUint32(36, true),
      endianTag: dv.getUint32(40, true),
      mapOff: dv.getUint32(52, true),
      stringIdsSize: dv.getUint32(56, true),
      typeIdsSize: dv.getUint32(64, true),
      protoIdsSize: dv.getUint32(72, true),
      fieldIdsSize: dv.getUint32(80, true),
      methodIdsSize: dv.getUint32(88, true),
      classDefsSize: dv.getUint32(96, true),
      dataSize: dv.getUint32(104, true)
    };
  }
  function normHexL(s) { return String(s).replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '').toLowerCase(); }

  /* ---- 第 4 章：ClassLoader 委托链推演 ---- */
  function classLoaderChain(target, loaderState) {
    /* loaderState: { boot: [..], path: [..], custom: [..] } 各加载器"认识"的类 */
    const chain = [
      { name: 'BootClassLoader', role: '系统核心类（java.*, android.*）', sees: loaderState.boot || [] },
      { name: 'PathClassLoader', role: 'APK 里原始的 dex（默认加载器）', sees: loaderState.path || [] },
      { name: 'DexClassLoader（壳的）', role: '运行时解密出来的真 dex', sees: loaderState.custom || [] }
    ];
    // 双亲委派：从 Boot 往下依次尝试，第一个命中即返回
    const order = ['BootClassLoader', 'PathClassLoader', 'DexClassLoader（壳的）'];
    const trace = [];
    let found = null;
    for (const nm of order) {
      const l = chain.find(x => x.name === nm);
      const hit = l.sees.includes(target);
      trace.push({ loader: nm, role: l.role, tried: true, hit });
      if (hit) { found = nm; break; }
      // 模拟"委托父加载器失败后，子加载器才自己动手"
    }
    return {
      trace,
      found,
      delegated: found === 'DexClassLoader（壳的）',
      // 用默认加载器（PathClassLoader）会怎样？
      defaultLoaderFound: loaderState.path.includes(target),
      solve: found === 'DexClassLoader（壳的）'
        ? '必须切换加载器：Java.enumerateClassLoaders 找到它 → Java.classFactory.loader = loader'
        : '用默认加载器即可'
    };
  }

  /* ---- 第 6 章：VMP 分发器/Hanlder 映射推演 ---- */
  // 一个教学用的迷你 VM：自定义字节码 → 原始操作
  const VM_OPS = {
    0x1A: { name: 'LOAD',  raw: 'MOV  Rd, [VmContext+off]', note: '从 VM 上下文取一个值' },
    0x2B: { name: 'STORE', raw: 'MOV  [VmContext+off], Rs', note: '把值写回 VM 上下文' },
    0x3C: { name: 'XOR',   raw: 'EOR  Rd, Rn, Rm',          note: '异或（加密核心）' },
    0x4D: { name: 'ADD',   raw: 'ADD  Rd, Rn, Rm',          note: '加法' },
    0x5E: { name: 'ROL',   raw: 'ROR  Rd, Rn, #imm',        note: '循环移位（注意方向！）' },
    0x6F: { name: 'JMP',   raw: 'B    target',              note: '跳转（改 pc）' },
    0x70: { name: 'CMP',   raw: 'CMP  Rn, Rm',              note: '比较，设置标志位' },
    0x81: { name: 'HLT',   raw: 'RET',                      note: '结束，返回结果' }
  };
  function vmDisasm(bytecode) {
    const h = normHexL(bytecode);
    const out = [];
    let i = 0;
    while (i + 1 < h.length && out.length < 64) {
      const op = parseInt(h.substr(i, 2), 16);
      const info = VM_OPS[op];
      out.push({
        offset: i / 2,
        opcode: '0x' + op.toString(16).padStart(2, '0').toUpperCase(),
        known: !!info,
        name: info ? info.name : '???（未在映射表中）',
        raw: info ? info.raw : '无对应原始指令',
        note: info ? info.note : '这个 opcode 不在已知映射里 —— 要么是分发器用的，要么映射表还没找全。'
      });
      i += 2;
    }
    return out;
  }
  // 分发器形态识别
  const VM_DISPATCH = {
    switch: { label: 'switch-case 分发（C 语言编译产物）', hint: '通常编译成跳转表 + 边界检查，<b>最容易自动化还原</b>。' },
    ifchain: { label: 'if-else 链分发', hint: '一串 <code>CMP</code> + 条件跳转，handler 少时常见。' },
    table: { label: '纯跳转表分发', hint: '一个基址 + opcode×4 索引，<code>LDR pc, [base, op, LSL #2]</code>。' },
    nested: { label: '嵌套分发（VM 里套 VM）', hint: '<b>最难</b>。外层 handler 又进入另一个分发循环，需要分层还原。' }
  };

  /* ---- 第 14 章：iOS 反调试检测与绕过配对 ---- */
  const IOS_ANTIDEBUG = [
    { id: 'ptrace', name: 'ptrace(PT_DENY_ATTACH)', bypass: 'hook-ptrace',
      why: '最常见的反调试。调用后调试器无法附加。' },
    { id: 'sysctl', name: 'sysctl 查 P_TRACED', bypass: 'hook-sysctl',
      why: '读取 kinfo_proc 结构里的标志位，判断是否被追踪。' },
    { id: 'getppid', name: 'getppid() 不是 launchd', bypass: 'hook-getppid',
      why: '正常启动的 App 父进程是 launchd（PID 1）；被调试时父进程会不同。' },
    { id: 'csops', name: 'csops 查 CS_DEBUGGED', bypass: 'hook-csops',
      why: '查询代码签名标志，被调试的进程会带 CS_DEBUGGED。' },
    { id: 'frida', name: '扫描 Frida 特征字符串', bypass: 'rename-frida',
      why: '在内存或端口里找 "frida"、"gum"、"LIBFRIDA" 等特征。' },
    { id: 'svc', name: '内联 SVC 直接调 ptrace', bypass: 'patch-svc',
      why: '<b>绕过符号 hook 的进阶手段</b>：不经过 libc，直接发系统调用。' }
  ];
  function iosSweep(enabled) {
    const set = new Set(enabled);
    return IOS_ANTIDEBUG.map(d => ({ ...d, blocked: set.has(d.bypass), missing: set.has(d.bypass) ? [] : [d.bypass] }));
  }
  const IOS_OPTIONS = [
    { id: 'hook-ptrace',   name: 'hook ptrace 直接返回 0' },
    { id: 'hook-sysctl',   name: 'hook sysctl，返回前清掉 P_TRACED 标志' },
    { id: 'hook-getppid',  name: 'hook getppid 返回 1' },
    { id: 'hook-csops',    name: 'hook csops 清掉 CS_DEBUGGED' },
    { id: 'rename-frida',  name: '重命名 Frida 相关文件/端口' },
    { id: 'patch-svc',     name: '内核级 hook 或 patch SVC 指令本身' }
  ];

  /* ---- 第 16 章：指令翻译模式对照 ---- */
  const TRANSLATION_MODES = [
    { id: 'full',     name: '全系统模拟（QEMU TCG）',
      how: '每条 guest 指令都被翻译成宿主指令',
      pros: ['兼容性最好，什么都能跑'], cons: ['慢，性能损失常达数倍到数十倍'],
      when: '需要完整系统（含内核）模拟，或跑非 Android 的 ARM Linux' },
    { id: 'applevel', name: '应用级翻译（libhoudini / libndk_translation）',
      how: 'x86 安卓原生速度跑，只有 App 里的 ARM so 被翻译',
      pros: ['快得多，接近原生体验'], cons: ['只翻译 so，对 native 有额外开销；兼容性略差'],
      when: 'x86 安卓设备上跑 ARM App（如部分安卓模拟器）' },
    { id: 'gki',      name: 'GKI（通用内核镜像）',
      how: 'Google 维护通用内核 + 厂商可加载模块，通过稳定 KMI 协作',
      pros: ['内核可独立升级修漏洞，厂商只管驱动'], cons: ['厂商需适配 KMI'],
      when: '这不是"翻译模式"，而是内核架构 —— 容易和上面两项混淆' }
  ];

  const DETECTIONS = [
    { id: 'port',   name: '扫描端口 27042 / 27043',        needs: ['change-port'], why: 'frida-server 默认监听这两个端口，TCP connect 一下就知道在不在。' },
    { id: 'thread', name: '遍历线程名找 gum-js-loop',       needs: ['gadget'],      why: 'frida-server 会建 gum-js-loop / gmain / pool-frida 等线程，读 /proc/self/task/*/comm 即可发现。' },
    { id: 'maps',   name: '读 /proc/self/maps 找 frida-agent', needs: ['hook-open'], why: '最常用的一招：内存映射表里直接写着 frida-agent-64.so 等路径。' },
    { id: 'strstr', name: '扫描内存特征字符串',              needs: ['hook-str'],    why: '在自身内存里搜 "frida"、"gum"、"LIBFRIDA" 等特征。' },
    { id: 'dbus',   name: '检测 D-Bus 通信',                 needs: ['gadget'],      why: 'frida-server 用 D-Bus 与客户端通信，会尝试连接或探测这条通道。' },
    { id: 'inline', name: '校验函数序言（查 inline hook）',   needs: ['hwbp'],        why: '读函数开头几字节，看有没有被改成跳转指令。内联 hook 会留下痕迹。' },
    { id: 'timing', name: '耗时检测（Stalker 拖慢）',         needs: ['limit-trace'], why: '某段代码执行时间异常变长，说明被 trace 了。' },
    { id: 'path',   name: '查找 /data/local/tmp 下的文件',    needs: ['relocate'],    why: 'frida-server 常被放在这个目录，直接 stat 一下就知道。' },
    { id: 'proc',   name: '读 /proc/self/status 的 TracerPid', needs: ['spawn'],      why: '被 ptrace 附加时 TracerPid 非 0。' },
  ];
  function evaSweep(enabled) {
    const set = new Set(enabled);
    return DETECTIONS.map(d => ({
      id: d.id, name: d.name, why: d.why, needs: d.needs,
      blocked: d.needs.every(n => set.has(n)),
      missing: d.needs.filter(n => !set.has(n))
    }));
  }  const EVA_OPTIONS = [
    { id: 'change-port', name: '改 frida-server 端口' },
    { id: 'gadget',      name: '改用 frida-gadget（嵌入 App，无独立进程）' },
    { id: 'hook-open',   name: 'hook open/read 过滤 /proc/self/maps 内容' },
    { id: 'hook-str',    name: 'hook strstr/strcmp 等字符串比较' },
    { id: 'hwbp',        name: '改用硬件断点（不改内存）' },
    { id: 'limit-trace', name: '限制 Stalker trace 范围' },
    { id: 'relocate',    name: '换目录 + 重命名 server 文件' },
    { id: 'spawn',       name: 'spawn 模式抢先注入' },
  ];

  /* ---- 第 12 章：ART 版本 → 关键结构变化 ---- */
  const ART_ERAS = [
    { v: 5,  label: 'Android 5.0（ART 取代 Dalvik）', years: '2014',
      keys: ['DexFile 结构初次定型', 'ArtMethod 含解释器入口', 'oat 文件为主'],
      note: '早期脱壳方案多基于这一代。' },
    { v: 7,  label: 'Android 7.x', years: '2016',
      keys: ['JIT + AOT 混合编译', 'ArtMethod 字段调整', '引入 VDex（验证用 dex 副本）'],
      note: 'VDex 意味着"同一个 dex 可能有两份"，脱壳时注意别脱错。' },
    { v: 8,  label: 'Android 8.0（结构大重构）', years: '2017',
      keys: ['DexFile 结构重构', 'ClassLinker 接口调整', 'DexCache 调整'],
      note: '<b>这是 FART 历史上的分水岭</b>——大量旧脚本在这一代失效。' },
    { v: 9,  label: 'Android 9', years: '2018',
      keys: ['引入 CompactDex（cdex）', '数据与指令分离存储', 'dex 版本号 039'],
      note: 'CompactDex 把 dex 拆成"指令 + 数据"两部分，脱壳要同时处理。' },
    { v: 10, label: 'Android 10', years: '2019',
      keys: ['hidden API 策略调整（灰/黑名单）', 'ArtMethod 相关改动', 'dex 版本号 040'],
      note: 'hidden API 限制会影响部分反射型 hook 脚本。' },
    { v: 11, label: 'Android 11', years: '2020',
      keys: ['CodeItemDataAccessor 等访问器抽象', '部分信息从 ArtMethod 移出', '分区存储'],
      note: '访问方式从"直接读字段"变成"通过访问器"，脚本要跟着改。' },
    { v: 12, label: 'Android 12', years: '2021',
      keys: ['动态分区（dynamic partitions）', 'ART 模块化（APEX）', 'boot 镜像结构变化'],
      note: 'ART 变成 APEX 模块后可独立升级，<b>系统版本不再等同于 ART 版本</b>。' },
    { v: 13, label: 'Android 13', years: '2022', keys: ['ART 继续模块化', 'dex 格式微调'], note: '' },
    { v: 14, label: 'Android 14', years: '2023', keys: ['init_boot 分区引入', 'ART 模块化延续'], note: '' },
  ];
  function artEra(v) {
    const num = parseInt(String(v).replace(/[^0-9]/g, '') || '0', 10);
    return ART_ERAS.find(e => e.v === num) || null;
  }

  /* ---- 第 18 章：Android 启动链路 ---- */
  const BOOT_STAGES = [
    { id: 'bootrom',    label: 'BootROM',                     note: '芯片内固化的第一段代码，只负责加载下一级' },
    { id: 'bootloader', label: 'Bootloader（abl / lk）',       note: '初始化 DDR，校验并加载 boot 分区' },
    { id: 'kernel',     label: '加载并启动 Linux 内核',         note: '解析 cmdline，挂载 ramdisk' },
    { id: 'init',       label: '执行 /init（在 ramdisk 里）',   note: '用户空间的第一个进程（PID 1）' },
    { id: 'initrc',     label: '解析 init.rc 启动各 service',   note: '按 rc 文件顺序拉起系统服务' },
    { id: 'zygote',     label: 'servicemanager / zygote 启动',  note: 'zygote 预加载类库并 fork App 进程' },
    { id: 'sysserver',  label: 'system_server → App 进程',      note: 'AMS/PMS 等系统服务就绪后 App 才能被拉起' },
  ];

  global.LABX = {
    hexDiff, diffStat, identify, extractHex, parseCArray, parseWords32, FINGERPRINTS,
    thumbDecode, ARM32_ARGS, A64_ARGS,
    sub32, subVariant, subVariant2, subVariantSub, subVariantXor,
    classifyImport, ENV_RULES,
    decodeSyscall, SYSCALLS,
    dexHeader, classLoaderChain,
    evaSweep, EVA_OPTIONS, DETECTIONS,
    artEra, ART_ERAS,
    BOOT_STAGES,
    vmDisasm, VM_OPS, VM_DISPATCH,
    iosSweep, IOS_OPTIONS, IOS_ANTIDEBUG,
    TRANSLATION_MODES
  };
})(window);
