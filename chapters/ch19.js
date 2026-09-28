/* 第 19 章 · 加固技术全景与壳的判定
   分多次写入：本文件由 write + 多次 edit 拼装而成。
   事实纪律：
     · 厂商产品线、特征 so 名、字符串特征、版本号一律标注「待核实」，绝不编造；
     · 判定结论由 pack19Judge() 的真实规则表算出，不写死结论字符串；
     · 案例只收可访问、可复现来源（本文件收的是 GitHub 公开仓库，看雪帖子需登录+验证码，
       无法在未登录状态取到正文，因此不作为案例来源，具体说明见 19.11/19.14 正文）。 */

/* ==========================================================================
   判定引擎 A —— /proc/self/maps 逐行分类
   逐行给出「正常 / 可疑 / 有价值」判定与理由。
   19.12 的判定器与 19.13 的实验都调用它，判分依据来自同一个函数。
   ========================================================================== */
function pack19Maps(text) {
  var rows = [];
  var lines = String(text == null ? '' : text).split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var s = lines[i].replace(/\s+$/, '');
    if (!s.trim()) continue;
    var m = /^([0-9a-fA-F]+)-([0-9a-fA-F]+)\s+(\S{4})\s+(\S+)\s+(\S+)\s+(\d+)\s*(.*)$/.exec(s.trim());
    if (!m) {
      rows.push({ ln: i + 1, raw: s, perm: '-', path: '', kind: 'bad', label: '格式不合法', suspicious: false,
        why: '这不是一行标准 maps 记录。标准格式是 <code>起址-止址 权限 偏移 dev inode 路径</code>，最后一段路径可以为空（匿名映射）。' });
      continue;
    }
    var perm = m[3];
    var rawPath = (m[7] || '').replace(/\s+$/, '');
    var deleted = /\(deleted\)$/.test(rawPath);
    var path = rawPath.replace(/\s*\(deleted\)$/, '');
    var isAnon = (path === '' || path.charAt(0) === '[');
    var r = { ln: i + 1, raw: s, perm: perm, path: path, deleted: deleted, kind: 'other',
              label: '普通映射', suspicious: false, why: '没有命中任何已知的可疑模式，按正常映射处理。' };

    if (isAnon && /dalvik|jit|zygote|region space|main space|non moving|rosalloc|art::|binder|stack|libc_malloc|scudo/.test(path)) {
      r.kind = 'art'; r.label = 'ART / 系统运行时映射';
      r.why = 'ART 为 JIT 代码缓存、GC 空间、线程栈、分配器建立的匿名映射。<b>其中 JIT 代码缓存常见 rwx 权限</b> —— 这是完全合法的来源，把它当壳是最常见的误报。';
    } else if (/w/.test(perm) && /x/.test(perm)) {
      r.kind = 'rwx'; r.suspicious = true; r.label = '可写可执行段（rwx）';
      r.why = '同时具备写与执行权限。<b>正常的映射几乎不会这样</b>：它意味着这块内存可以在运行时被改写再执行 —— 自修改代码、跳转表热补丁、或壳把解密后的代码页直接标成可执行。';
    } else if (/memfd:/.test(path)) {
      r.kind = 'memfd'; r.suspicious = true; r.label = 'memfd 匿名内存文件';
      r.why = '内核提供的匿名文件，不需要在磁盘上落地。把解密结果写进 memfd 再 <code>dlopen</code>，是内存加载型壳的常见做法 —— 你在文件系统里永远找不到那个 so。';
    } else if (deleted && /\.so$/.test(path)) {
      r.kind = 'deleted'; r.suspicious = true; r.label = 'so 已被删除但映射仍在';
      r.why = '<b>最强的内存加载痕迹之一</b>：文件先被加载，随后被删除（或本来就是从内存造出来的），映射却还留着。正常安装的 APK 自带 so 不会处于这个状态。';
    } else if (/\.dex$/.test(path) || /classes[0-9]*\.dex$/.test(path)) {
      r.kind = 'dex'; r.label = '内存中被映射的 dex';
      r.why = '路径直指一份 dex —— 它不算「可疑」，它是<b>你的 dump 目标</b>。这一段的起止地址之差就是这份 dex 的量级，可以直接拿来估算 dump 长度。';
    } else if (/^\/(system|system_ext|apex|vendor|product|odm)\//.test(path)) {
      r.kind = 'sys'; r.label = '系统 / 框架库';
      r.why = '系统分区或 APEX 里的库。加固方改不动它们，出现这些映射属于进程的正常形态。';
    } else if (/^\/data\/app\//.test(path)) {
      r.kind = 'applib'; r.label = 'APK 自带 so';
      r.why = '位于 <code>/data/app/</code> 下，是安装时由包管理器从 APK 解出来的 so。属正常分布 —— <b>注意它和 /data/data/ 下的 so 是两回事</b>。';
    } else if (/^\/data\/(data|user|local|misc)\//.test(path) && /\.so$/.test(path)) {
      r.kind = 'dataso'; r.suspicious = true; r.label = '数据目录里的 so';
      r.why = 'so 出现在 App 的数据目录：说明它是运行时解密后落地、再加载进来的。系统库与 APK 自带 so 都不会落在这里。';
    } else if (/^\/dev\//.test(path) && /x/.test(perm)) {
      r.kind = 'dev'; r.suspicious = true; r.label = '/dev 下的可执行映射';
      r.why = '从设备节点直接映射出可执行段，不符合普通 App 的加载方式。（<code>/dev/ashmem</code> 这类只读/可写映射很常见，属于正常，只有带 <code>x</code> 权限时才需要解释。）';
    } else if (isAnon && /x/.test(perm)) {
      if (path === '') {
        r.kind = 'anonExec'; r.suspicious = true; r.label = '无名的可执行匿名段';
        r.why = '<b>没有路径、没有名字，却有执行权限。</b>正常的库加载总会留下路径；ART 自己的匿名可执行段一般带 <code>[anon:...]</code> 名字。既无名又可执行，要么是运行时生成的代码，要么是有人手工造了一块可执行内存。';
      } else {
        r.kind = 'anonNamed'; r.suspicious = true; r.label = '具名匿名段（可执行）';
        r.why = '带 <code>[anon:名字]</code> 且有执行权限。先看名字：dalvik / jit 相关属于运行时正常行为，其它名字需要人工确认是谁建的。';
      }
    }
    rows.push(r);
  }
  return rows;
}

/* 判定引擎 A 的聚合统计 */
function pack19MapsStat(text) {
  var rows = pack19Maps(text);
  var st = { rows: rows, total: 0, suspicious: [], anonExec: 0, rwx: 0, deleted: 0, memfd: 0,
             dataso: 0, dex: 0, dev: 0, art: 0, normal: 0, bad: 0 };
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    st.total++;
    if (r.suspicious) st.suspicious.push(r);
    if (r.kind === 'anonExec' || r.kind === 'anonNamed') st.anonExec++;
    if (r.kind === 'rwx') st.rwx++;
    if (r.kind === 'deleted') st.deleted++;
    if (r.kind === 'memfd') st.memfd++;
    if (r.kind === 'dataso') st.dataso++;
    if (r.kind === 'dex') st.dex++;
    if (r.kind === 'dev') st.dev++;
    if (r.kind === 'art') st.art++;
    if (r.kind === 'sys' || r.kind === 'applib' || r.kind === 'other') st.normal++;
    if (r.kind === 'bad') st.bad++;
  }
  return st;
}

/* ==========================================================================
   判定引擎 B —— 观测值 → 壳类型假设的真实打分
   输入：读者填的 6 项观测（多 dex 数 / class_defs_size / dex 魔数命中数 /
        attachBaseContext 是否被覆写 / 有无 native 注册 / maps 片段）
   输出：每个假设的分数、触发的证据、下一步动作。
   评的是「证据组合」，不是单个现象 —— 这是本章最想教的东西。
   ========================================================================== */
function pack19Judge(v) {
  v = v || {};
  var num = function (x) { var n = parseInt(String(x == null ? '' : x).replace(/[^0-9]/g, ''), 10); return isNaN(n) ? 0 : n; };
  var yep = function (x) { return /^\s*(y|yes|true|1|是|有|被|已|覆写|覆盖|存在)/i.test(String(x == null ? '' : x)); };
  var dexCount = num(v.dexCount);
  var classDefs = num(v.classDefs);
  var magicHits = num(v.magicHits);
  var attach = yep(v.attach);
  var nativ = yep(v.nativeReg);
  var ms = pack19MapsStat(v.maps || '');

  var H = [
    { id: 'none', name: '未见明显加壳（更像轻量混淆 / 签名校验 / 普通 App）', score: 0, ev: [],
      next: '不急着脱壳。先把这个结论坐实：用特征工具（apkid / ApkCheckPack 一类）交叉验证一次，再把「方法体是否完整」当成判据重新看一遍静态结果。' },
    { id: 'gen1', name: '一代壳：整份 dex 整体加密 / 文件重定向', score: 0, ev: [],
      next: '找 dump 时机。确认「真 dex 已被解密进内存、且 ART 已经接管（结构完整）」的那个时刻，抓内存里的 dex 区间；同时确认它落地了还是只在内存里。' },
    { id: 'gen2', name: '二代壳：抽取壳（结构保留，方法体被抽走、运行时回填）', score: 0, ev: [],
      next: '上主动调用。遍历所有 DexFile × 类 × 方法强制触发回填，再逐方法 dump；脱壳前先把 App 每个功能点都点一遍。' },
    { id: 'gen3', name: '三代壳：DEX2C / Java2C / native 化', score: 0, ev: [],
      next: '先去 native 侧定位入口。在 JNI_OnLoad / RegisterNatives 处记录「Java 方法 → native 地址」的绑定关系，判断关键函数是被 native 重写还是被翻译成 C，再决定 Trace 还是读汇编。' },
    { id: 'vmp', name: 'VMP：自定义字节码 + 解释器', score: 0, ev: [],
      next: '先量清 VMP 的边界：找到分发循环与 handler 表，估一下自定义指令集的规模。多数情况下「黑盒调用拿结果」比「完整还原指令集」性价比高。' },
    { id: 'rt', name: '（附加维度）运行时防护强化：反调试 / 反 Hook / 环境检测', score: 0, ev: [],
      next: '同步处理防护：先判断它挡在哪一层（Java / native / 内核），再决定是改环境、抢时序，还是换观测层。' }
  ];
  var add = function (id, n, why) {
    for (var i = 0; i < H.length; i++) if (H[i].id === id) { H[i].score += n; H[i].ev.push(why); }
  };

  /* ---- 静态侧规则 ---- */
  if (dexCount >= 2) add('gen2', 1, 'APK 里有 <b>' + dexCount + ' 份 dex</b>：多 dex 是抽取壳与多 dex 加固的常见形态（但它本身不是判决性证据，正常的大 App 也会分包）');
  if (classDefs === 0 && dexCount > 0) add('gen1', 3, '<code>class_defs_size = 0</code>：静态看进去<b>一个类定义都没有</b> → 这份 dex 要么整体被加密，要么只是个占位文件');
  if (classDefs > 0) {
    add('none', 1, '<code>class_defs_size = ' + classDefs + '</code>：dex 结构完整可见');
    add('gen2', 2, '结构完整（' + classDefs + ' 个类定义）却仍需要脱壳 → 典型形态是「结构留着、方法体被抽走」，也就是抽取壳');
    if (classDefs >= 200) add('gen2', 1, '类数量级正常（' + classDefs + ' 个），说明你看到的是完整结构而不是残片 —— 这排除了「dex 被截断」的可能');
  }
  if (magicHits === 0) {
    add('gen1', 2, '内存里搜不到任何 dex 魔数：要么真 dex 还没被解密加载，要么它的头部已经被改成非标准形态（CompactDex / 魔改魔数）');
    add('gen3', 1, '内存中搜不到标准 dex 魔数，也符合「方法被搬进 native、Java 层不再有完整 dex」的形态');
  } else {
    add('none', 1, '内存里至少有 1 处明文 dex 魔数：dex 确实被解密进内存了');
  }
  if (magicHits >= 2) add('gen2', 2, '命中 <b>' + magicHits + ' 处</b> dex 魔数：内存里同时存在多份明文 dex（运行时加载），是抽取壳与多 dex 加固的常见组合');
  if (magicHits >= 1 && classDefs === 0) add('gen1', 2, '「APK 里没有类定义 + 内存里却有明文 dex」这一组合，直接说明静态那份是假的、真 dex 由壳在运行时解密加载');
  if (attach) {
    add('gen1', 2, '<code>attachBaseContext</code> 被覆写：入口在 Application 层就被壳接管了 —— 这是所有壳的第一招，也是启动期解密与加载的发生地');
    add('gen2', 2, '入口被覆写说明壳需要在进程早期动手（解密、自定义 ClassLoader、替换 mClassLoader），这是抽取壳与一代壳共同的前置动作');
    add('rt', 1, '入口被覆写也常伴随环境检测（很多加固在这里做 root / 模拟器 / 多开检查）');
  } else {
    add('none', 1, '<code>attachBaseContext</code> 未见覆写：入口层没有明显的壳接管痕迹');
  }

  /* ---- native / SO 侧规则 ---- */
  if (nativ) {
    add('gen3', 2, '存在 native 动态注册（JNI_OnLoad + RegisterNatives 一类）：关键逻辑被搬进 so 并在运行时绑定，是 native 化的强特征');
    add('vmp', 1, 'native 注册是 VMP 的前置条件之一（解释器与 handler 通常都在 so 里），但它本身只能说明「有 native」，不能直接判 VMP');
  }

  /* ---- maps 侧规则（全部来自 pack19Maps 的真实解析结果） ---- */
  if (ms.total === 0) {
    add('none', 0, 'maps 片段为空：这一路的证据暂时缺失，结论只能由静态现象支撑');
  } else {
    if (ms.anonExec > 0) {
      add('gen1', 2, 'maps 里有 <b>' + ms.anonExec + ' 个可执行匿名段</b>：运行时才产生的代码页，常见于「解密器把加载逻辑造在内存里执行」或 JIT');
      add('gen3', 1, '可执行匿名段也可能是 native 层的代码生成（DEX2C / 自解密 stub），需要与 native 注册证据合看');
    }
    if (ms.rwx > 0) {
      add('vmp', 2, '有 <b>' + ms.rwx + ' 个 rwx（可写可执行）段</b>：VMP 解释器常需要自修改代码或热补丁跳转表（注意 ART 的 JIT 缓存也是 rwx，必须靠名字区分，别误报）');
      add('gen3', 1, 'rwx 段同样可能来自 native 化的代码生成');
    }
    if (ms.deleted > 0) {
      add('gen3', 2, '有 <b>' + ms.deleted + ' 个「已删除却仍在映射」的 so</b>：内存加载的典型痕迹 —— 加载完就把落地点删掉，抹掉磁盘证据');
      add('gen1', 1, '自删 so 也常见于一代壳：解密 → 落地 → 加载 → 删除，一条龙做完不留文件');
    }
    if (ms.memfd > 0) {
      add('gen1', 2, '存在 <b>memfd 匿名内存文件</b>映射：把解密结果塞进内存文件再 <code>dlopen</code>，全程不落地 —— 内存加载型壳的标准动作');
      add('gen3', 2, 'memfd + dlopen 也说明 native 侧有完整的自定义加载逻辑，与 DEX2C / native 化高度相关');
    }
    if (ms.dataso > 0) add('gen2', 1, '数据目录里出现了 so 映射：解密落地后加载，多与抽取壳的 native 解密器相关');
    if (ms.dex > 0) add('gen2', 2, 'maps 里直接能看到 <b>.dex 映射</b>：内存中已经有可 dump 的明文 dex，主动调用之后就在这里取货');
    if (ms.suspicious.length === 0) add('none', 2, 'maps 里没有命中任何可疑模式（全是系统库 / APK 自带 so / ART 自身的匿名段）—— 这是正常进程的形态');
  }

  /* ---- 组合规则：多条证据同时指向「其实没加壳」 ---- */
  if (!attach && !nativ && classDefs > 0 && magicHits === 1 && ms.total > 0 && ms.suspicious.length === 0) {
    add('none', 3, '组合证据（结构完整 + 内存里只有一处明文 dex + 入口未覆写 + maps 干净）同时成立 → 更像「没加壳」或只有轻量混淆，而不是壳');
  }
  /* ---- 组合规则：抽取壳的「教科书组合」 ---- */
  if (attach && classDefs > 0 && ms.dex > 0 && nativ) {
    add('gen2', 2, '组合证据（入口被覆写 + 结构完整 + 内存里有 dex 映射 + native 注册）同时成立 → 抽取壳的教科书组合：Java 层解密器 + native 回填');
  }

  /* ---- 排序与归一 ---- */
  H.sort(function (a, b) { return b.score - a.score; });
  var sum = 0;
  for (var k = 0; k < H.length; k++) sum += H[k].score;
  for (var k2 = 0; k2 < H.length; k2++) H[k2].pct = sum > 0 ? Math.round(H[k2].score / sum * 100) : 0;
  var top = H[0], second = H[1];
  var tight = !!top && !!second && top.score > 0 && (top.score - second.score) <= 1;
  return { rank: H, sum: sum, top: top, second: second, tight: tight, ms: ms,
           obs: { dexCount: dexCount, classDefs: classDefs, magicHits: magicHits, attach: attach, nativ: nativ } };
}

/* 「结论关键词」表：判分时用读者写下的结论去匹配当前算出来的 top 假设 */
var PACK19_KEYS = {
  none: { type: ['没加壳', '未加壳', '无壳', '没有加壳', '未见加壳', '不像加壳', '混淆', '轻度'],
          next: ['交叉验证', 'apkid', '特征库', '再确认', '确认', '静态', '方法体完整'] },
  gen1: { type: ['一代', '整体加密', '文件重定向', '重定向', '整体', '整份加密'],
          next: ['dump', '内存', '时机', '解密', '加载', '脱'] },
  gen2: { type: ['抽取', '抽取壳', '二代', '回填', '方法体', 'code_item', 'insns'],
          next: ['主动调用', '调用', '遍历', '跑一遍', '点一遍', '功能', '触发', '回填'] },
  gen3: { type: ['三代', 'native', 'native化', 'dex2c', 'java2c', 'so', 'jni', '翻译'],
          next: ['注册', 'registernatives', 'jni_onload', 'trace', 'hook', '定位', '动态', '绑定'] },
  vmp: { type: ['vmp', '虚拟机', '字节码', '解释器', '自定义指令', '分发'],
         next: ['handler', '分发', '黑盒', 'unidbg', 'trace', '边界', '指令集'] },
  rt: { type: ['反调试', '反frida', '反 frida', '运行时防护', '检测', '强度', '对抗'],
        next: ['内核', '时序', 'spawn', '改环境', '观测', '绕过'] }
};

/* 教学用的 maps 片段：格式与真实 /proc/self/maps 一致，内容为构造样本（含 3 条「看着可疑其实正常」的对照行） */
var PACK19_MAPS_SAMPLE =
  '7f9c100000-7f9c104000 r--p 00000000 fd:00 4321  /system/lib64/libc.so\n' +
  '7f9c104000-7f9c114000 r-xp 00001000 fd:00 4321  /system/lib64/libc.so\n' +
  '7f9c200000-7f9c204000 r--p 00000000 fd:00 9876  /apex/com.android.art/lib64/libart.so\n' +
  '7f9c300000-7f9c302000 rwxp 00000000 00:00 0      [anon:dalvik-jit-code-cache]\n' +
  '7f9c400000-7f9c406000 r-xp 00000000 00:00 0\n' +
  '7f9c500000-7f9c508000 r-xp 00000000 fd:00 5555  /data/app/~~abc==/com.example.app-1/lib/arm64/libnative.so\n' +
  '7f9c600000-7f9c604000 rw-p 00000000 00:00 0      [anon:libc_malloc]\n' +
  '7f9c700000-7f9c711000 r-xp 00000000 fd:00 6666  /data/data/com.example.app/files/libpayload.so (deleted)\n' +
  '7f9c800000-7f9c803000 rwxp 00000000 00:00 0\n' +
  '7f9c900000-7f9c906000 r--p 00000000 fd:00 7777  /data/data/com.example.app/cache/00000000.dex\n' +
  '7f9ca00000-7f9ca02000 r-xp 00000000 00:00 0      /memfd:payload (deleted)\n' +
  '7f9cb00000-7f9cb01000 rw-p 00000000 00:00 0      [anon:dalvik-main space]\n' +
  '7f9cc00000-7f9cc04000 r--p 00000000 fd:00 8888  /dev/ashmem';

window.CHAPTER = {
  no: 19,
  title: '加固技术全景与壳的判定',
  lede: '第 2、4、10、12 章直接开讲 FART、ART 源码和 fdex2——它们默认你已经知道<strong>加固这张地图长什么样</strong>。' +
        '这一章把地图补上：加固方在防谁、加固分成哪几个层次、壳已经演进到第几代，' +
        '最后给你一套<strong>半小时内判定手里这个 App 用了哪类壳</strong>的流程。',
  meta: [
    '核心问题：<b>拿到一个从没见过的加壳 App，你怎么用最便宜的手段判出它属于哪一类？</b>',
    '关键机制：<b>威胁模型 → 四个层次 → 三代壳 → 静态/动态特征 → 判定表 → 下一步动作</b>',
    '对手：<b>不是一个「更强的壳」，而是一组工程取舍——加固方在防护强度、兼容性、体积、启动耗时之间的平衡</b>',
    '读法：<b>本章是第 2 章的前置地图。先在这里把壳分类判清楚，再回去看 FART 会顺得多</b>'
  ],

  sections: [
    /* ============================================================ 19.1 */
    {
      h: '19.1', title: '先问加固方在防谁：三个威胁模型',
      intuition: {
        tag: '直觉模型 · 保险柜、保安和假门牌',
        body:
          '<p>把 App 想成一间办公室，里面有一份值钱的文件（业务代码）。加固方要做的事只有三类，每一类对应一种完全不同的手段：</p>' +
          '<ul>' +
          '<li><strong>防你翻文件柜</strong>（静态分析）→ 把文件锁进保险柜：加密、抽取、混淆。<em>你拿到的是一个打不开或者开了也没内容的柜子。</em></li>' +
          '<li><strong>防你蹲在办公室里看</strong>（动态调试）→ 装监控、贴封条、雇保安：反调试、反 Hook、环境检测。<em>你要么进不去，要么进去就被发现。</em></li>' +
          '<li><strong>防你把文件复印一份带走重印</strong>（二次打包）→ 给每份文件盖一个和门牌绑定的钢印：签名校验、完整性校验。<em>文件一离开这间办公室就作废。</em></li>' +
          '</ul>' +
          '<p>记住这张三分类的意义在于：<strong>后面看到任何一个防护手段，你都能立刻回答「它属于哪一类、挡在哪一步」</strong>。' +
          '判定壳类型之所以难，一半原因就是初学者把这三类混在一起看，于是看到什么现象都觉得「像是加壳了」。</p>'
      },
      html:
        T.note('key', '🔑 本章主线',
          '<p style="margin-bottom:0">为什么加固方要这么做（<b>威胁模型</b>）→ 加固铺在哪几层（<b>四个层次</b>）→ ' +
          '壳怎么一步步演进（<b>三代壳 + 混合型</b>）→ 每一代在静态和动态各留什么痕迹（<b>观测清单</b>）→ ' +
          '把这些痕迹组合成结论（<b>判定表与判定器</b>）→ 结论决定下一步动作（<b>决策演练</b>）。</p>') +
        T.tbl(['威胁模型', '加固方的核心手段', '它在什么地方动手', '对逆向者的直接后果'],
          [
            ['<b>防静态分析</b>', 'dex 整体加密、方法体抽取、DEX2C / VMP、so 加密、字符串加密',
             'APK 文件本身与 dex 结构', 'jadx 打不开、或者打开了也只有类名没有方法体、或者方法体是看不懂的跳转'],
            ['<b>防动态调试</b>', '反调试（TracerPid / 断点检测）、反 Hook（函数序言校验）、反 Frida（端口 / 线程名 / maps / 字符串）、root / 模拟器 / 多开检测',
             '进程运行时的 Java 层、native 层，部分下沉到内核层', 'Frida 挂不上、挂了就闪退、能挂上但一读关键内存就被检测'],
            ['<b>防二次打包</b>', '签名校验（Java 层 + native 层双份）、dex / so 完整性校验、资源校验',
             '启动早期到关键功能前', '改一行 smali 重打包后 App 直接拒绝运行——<b>这是很多加固产品的「默认开启项」</b>']
          ]) +
        T.note('', '🧭 为什么「防二次打包」值得单列一类',
          '<p>因为它改变了加固的<b>目标</b>。前两类威胁的目标是「不让你看懂」，第三类的目标是「不让你改完还能用」。</p>' +
          '<p style="margin-bottom:0">这也解释了一个常见困惑：<i>为什么有的 App 明明代码不难，却非要上加固？</i>' +
          '因为对方要防的不是你分析，而是竞品改一改就上架、黑产加个广告 SDK 就分发。' +
          '<span class="hit">理解了这一点，你就不会再把「加固强度」当成单一维度去比较——防护目标和取舍完全不同。</span></p>') +
        T.grid(2, [
          '<div class="card"><div class="card-title">🛡️ 加固方真正在算的账</div>' +
          '<p>加固不是一个「越强越好」的选择题，而是四条曲线的交点：<b>防护强度</b>、<b>兼容性</b>（不能把正常机型跑崩）、' +
          '<b>体积与启动耗时</b>（每多一层解密就多一次启动开销）、<b>维护成本</b>（厂商要为每个安卓大版本、每个 ABI 重新适配）。</p>' +
          '<p>所以同一个厂商的不同产品线、甚至同一个 App 的不同版本，用的方案强度都可能不一样。' +
          '<span class="pill warn">待核实</span> 具体到某个产品线的强度档位，以其官方文档和实测为准。</p></div>',
          '<div class="card"><div class="card-title">🔍 你要算的账</div>' +
          '<p>你面对的是同样的取舍：<b>半小时判定 + 一条可行路线</b>，比「把已知的所有脱壳工具都试一遍」便宜得多。</p>' +
          '<p>判定之所以成立，是因为加固方为了兼容性和启动耗时，<b>必然要在某些地方留下结构性的痕迹</b>——' +
          '它可以让痕迹很难读，但很难让痕迹不存在。<span class="hit">这些痕迹就是本章的判定依据。</span></p></div>'
        ]),
      quiz: {
        id: 'q19-1', chapter: 19, answer: 2,
        stem: '「防二次打包」之所以要和「防静态分析」「防动态调试」并列成第三类威胁模型，最根本的原因是？',
        options: [
          { t: '因为它用到的技术（签名校验）比前两类更复杂', why: '签名校验本身并不复杂，一行 Java 代码就能做。复杂度不是它单列的理由。' },
          { t: '因为它是所有加固产品的默认开启项，强度最高', why: '「默认开启」是现象不是原因；而且它的强度并不比抽取壳、VMP 更高，只是目标不同。' },
          { t: '因为它防的不是「被看懂」，而是「被改完还能用」——防护目标本身不同', why: '正确。前两类目标是提高理解成本，第三类目标是让篡改后的产物直接失效，因此它必须和「完整性」绑定，而不只是混淆。' },
          { t: '因为它只在 Android 平台存在，iOS 没有对应手段', why: 'iOS 同样有签名与完整性校验（且更严格）。这与它是否单列无关。' }
        ],
        explain: '<b>三类威胁模型的差别不在技术强度，而在「防住什么算成功」。</b><br><br>' +
          '防静态分析成功的标准是：你打开 APK 看不到有意义的方法体。<br>' +
          '防动态调试成功的标准是：你没法在运行时安静地观察它。<br>' +
          '防二次打包成功的标准是：<b>你把代码改完、重新签名、装上去，它拒绝运行</b>——注意这里的关键词是「改完还能用」。<br><br>' +
          '所以这一类必须依赖<b>完整性校验</b>（签名摘要、dex/so 校验和）而不是混淆：混淆只让你难读，不影响你改完之后跑起来。' +
          '<span class="hit">判定壳类型时，这一条会反复出现：只要你看到「双份签名校验（Java + native）」，' +
          '基本可以确定对方的产品目标里有反二次打包这一项。</span>'
      }
    },

    /* ============================================================ 19.2 */
    {
      h: '19.2', title: '加固的四个层次：DEX / SO / 资源 / 运行时防护',
      html:
        '<p>「加固」不是一个动作，而是<b>四个可以独立开关的层次</b>。理解这一点，你在判定时就能把观察到的现象分别归位，' +
        '而不是笼统地说「这个 App 加固了」。</p>' +
        T.tbl(['层次', '加固方在这里做什么', '你看到的现象', '对应后续章节'],
          [
            ['<b>DEX 层</b>', '整份加密、方法体抽取、DEX2C 翻译、VMP 字节码化、字符串加密、名字混淆',
             'jadx 打不开 / 方法体为空 / 方法体是跳转与数据 / 字符串全是乱码',
             '第 2 章（脱壳）、第 12 章（版本适配）、第 5 章（混淆）'],
            ['<b>SO 层</b>', 'so 整体加密 + 内存加载、导出表抹除、JNI 动态注册、控制流平坦化（OLLVM）、反调试',
             '<code>lib/</code> 下的 so 用 IDA 打开是乱码或没有导出符号；Java 层只剩 native 声明',
             '第 4 章（RegisterNatives）、第 10 章（反 Frida）、第 5、6 章'],
            ['<b>资源层</b>', '资源加密与运行时解密、资源名混淆、assets 里藏真 dex（或分片）',
             '<code>assets/</code> 里有体积异常、命名无语义的文件；<code>res/</code> 打开是乱码',
             '本章 19.11（静态特征）'],
            ['<b>运行时防护层</b>', '反调试、反注入、反 Hook、root/模拟器/多开检测、完整性校验、反 Frida',
             '启动就退、挂上调试器就闪退、重打包后拒绝运行',
             '第 13 章（内核层绕过）、第 10 章（反 Frida）、第 15、16 章（环境检测）']
          ]) +
        T.note('key', '🔑 四个层次是「可组合」的，不是「四选一」',
          '<p style="margin-bottom:0">一个真实的商用壳通常是：<b>DEX 层做抽取 + SO 层做整体加密与动态注册 + 资源层藏几个配置/证书 + ' +
          '运行时防护层挂上反调试和签名校验</b>。所以「这是几代壳」和「有没有运行时防护」是两个独立的问题——' +
          '<span class="hit">判定时要分开回答，混在一起就会得出「它既是二代壳又是三代壳」这类没法操作的结论。</span></p>') +
        T.acc('为什么资源层也值得单独列一层（很多人会漏掉它）',
          '<p>因为<b>它是壳的「行李箱」</b>。dex 太大、太显眼，所以壳常把真 dex、解密密钥、配置、证书塞进 <code>assets/</code> 或资源表，' +
          '用无语义的名字藏起来（例如一个 8MB 的 <code>.bin</code>、一组分片文件）。</p>' +
          '<p>你在静态侦察阶段看到「<code>assets/</code> 里有个体积远大于正常资源的文件」，这条线索的价值在于：' +
          '<b>它同时指出了一代壳的存在和它的解密输入</b>。反过来，如果 <code>assets/</code> 干干净净、dex 又是空壳，' +
          '那真 dex 更可能是从服务端下发或在 so 里生成的 —— 这是一个重要的方向分歧。</p>' +
          '<p style="margin-bottom:0"><span class="pill warn">待核实</span> 具体的命名习惯（用 <code>.bin</code>、<code>.dat</code> 还是伪装成图片）每个厂商不同且会变，' +
          '不要用文件名当判据，用<b>体积与熵值是否像加密数据</b>当判据。</p>') +
        '<p>下面把四个层次摊到一张图上，看清它们各自拦在逆向流程的哪一步。这张图后面在 19.3 讲代际演进时还会用到。</p>',
      stage: {
        title: '加固四层 × 逆向流程：每层拦在哪一步',
        speed: 1500,
        render:
          '<div class="flow-col" style="gap:10px">' +
            '<div class="flow-row"><span class="pill mono">你的动作</span>' +
              '<span class="blk" id="q1">反编译 APK</span><span class="arrow">→</span>' +
              '<span class="blk" id="q2">读 dex 结构</span><span class="arrow">→</span>' +
              '<span class="blk" id="q3">跑起来观察</span><span class="arrow">→</span>' +
              '<span class="blk" id="q4">改代码重打包</span></div>' +
            '<div class="flow-row"><span class="pill bad">DEX 层</span>' +
              '<span class="blk" id="l1">加密 / 抽取 / DEX2C / VMP</span></div>' +
            '<div class="flow-row"><span class="pill bad">SO 层</span>' +
              '<span class="blk" id="l2">so 加密 / 抹导出表 / 动态注册</span></div>' +
            '<div class="flow-row"><span class="pill bad">资源层</span>' +
              '<span class="blk" id="l3">藏真 dex / 密钥 / 证书</span></div>' +
            '<div class="flow-row"><span class="pill bad">运行时防护层</span>' +
              '<span class="blk" id="l4">反调试 / 反 Hook / 完整性校验</span></div>' +
            '<div style="margin-top:8px;padding-top:10px;border-top:1px dashed var(--line)">' +
              '<span class="pill" id="concl">点「单步」看每一层拦住了你哪一步</span></div>' +
          '</div>',
        reset: function () {
          ['q1','q2','q3','q4','l1','l2','l3','l4'].forEach(function (i) { S(i, ''); });
          CLS('concl', 'pill'); SET('concl', '点「单步」看每一层拦住了你哪一步');
        },
        steps: [
          { run: function () { S('q1', 'active'); S('l1', 'hot'); },
            note: '<b>DEX 层拦你的第一步：反编译。</b>整份加密的壳让 jadx 连类名都看不到；抽取壳让你看得到类名、看不到方法体。<b>它挡的是「读懂静态代码」。</b>' },
          { run: function () { S('q1', 'done'); S('q2', 'active'); S('l1', 'done'); S('l3', 'hot'); },
            note: '<b>资源层拦你的第二步：找真 dex。</b>真 dex 藏在 <code>assets/</code> 里、还被加密或分片，' +
              '你在 dex 结构里找不到任何线索——因为那份 dex 本来就不是真的。' },
          { run: function () { S('q2', 'done'); S('q3', 'active'); S('l3', 'done'); S('l2', 'hot'); },
            note: '<b>SO 层拦你的第三步：跑起来观察。</b>解密器、回填逻辑、关键算法都在 so 里。' +
              'so 被整体加密 + 内存加载 + 导出表抹除 → 你在磁盘上拿到的是一个「加密的壳」，' +
              '能看的东西只剩一堆没有符号的可执行段。' },
          { run: function () { S('l2', 'done'); S('l4', 'hot'); },
            note: '<b>运行时防护层拦你的第三步的后半段。</b>就算你成功挂上去，反调试、反 Hook、反 Frida 也在同一时刻工作。' +
              '<span class="hit">注意差别：SO 层挡的是「你读不到代码」，运行时防护挡的是「你读不到内存」。</span>' },
          { run: function () { S('q3', 'done'); S('q4', 'active'); S('l4', 'hot'); CLS('concl', 'pill bad'); SET('concl', '⚠️ 前三层还能靠技术硬啃，第四层常常直接让你「技术上做不到」'); },
            note: '<b>最后一关：完整性校验。</b>你改完 smali 重新签名，装上去 App 直接拒绝运行。' +
              '这一步通常发生在<b>启动早期</b>（Application 初始化时）或<b>关键功能之前</b>。' },
          { run: function () { S('q4', 'done'); S('l1', 'cool'); S('l2', 'cool'); S('l3', 'cool'); S('l4', 'cool'); CLS('concl', 'pill ok'); SET('concl', '✅ 四层各自独立：判定时要把它们分开回答'); },
            note: '<b>看清这张图的意义：</b>四层是<b>独立的开关</b>。你可以遇到「只做了一代壳、没有任何运行时防护」的样本' +
              '（最好啃），也可以遇到「抽取壳 + so 加密 + 全套反调试」的样本（最难啃）。' +
              '<span class="hit">判定壳类型只是第一问，第二问永远是：运行时防护开到了什么程度。</span>' }
        ]
      }
    },

    /* ============================================================ 19.3 */
    {
      h: '19.3', title: '壳的代际演进：本章的骨架',
      html:
        '<p>「一代壳 / 二代壳 / 三代壳」不是厂商的营销分类，而是<b>加固方针对「静态分析」不断加码的三个阶段</b>。' +
        '每一代都在解决上一代的漏洞，而这个「解决方式」正好就是判定它的依据。</p>' +
        T.tbl(['', '一代壳', '二代壳（抽取壳）', '三代壳（DEX2C / VMP）'],
          [
            ['<b>藏什么</b>', '整份 dex 文件', '方法体的字节码（<code>code_item</code> / <code>insns</code>）', '方法本身：字节码被翻译成 C 或自定义指令'],
            ['<b>静态能看到什么</b>', '只有壳的代码，业务类完全不可见', '<b>完整的类名、方法名、字段、签名</b>，方法体为空', '类名方法名可能完整，方法体是 native 声明或「读数据 + 跳进循环」'],
            ['<b>运行时做什么</b>', '解密 → 加载', '加载后，方法<b>首次被调用时</b>才把字节码回填进去', '调用时进入 so 里的解释器/翻译后代码'],
            ['<b>破解的关键动作</b>', '<b>找 dump 时机</b>（解密完成 + ART 接管）', '<b>主动调用</b>，逼壳回填', '动态 Trace 找映射关系；或黑盒调用拿结果'],
            ['<b>对应章节</b>', '第 2 章的 dex dump 部分', '第 2、12 章（FART 全套）', '第 6 章（VMP）、第 4 章（ART 插桩）'],
            ['<b>在判定器里的假设</b>', '<code>gen1</code>', '<code>gen2</code>', '<code>gen3</code> / <code>vmp</code>']
          ]) +
        T.note('', '🧭 「混合型」不是第四代',
          '<p style="margin-bottom:0">真实的商用壳常常是<b>组合</b>：多份 dex（其中一部分是抽取的、一部分是 native 化的）、' +
          '多个 so（有一个负责解密、一个负责业务）、甚至「壳里还套一层壳」（外层壳负责解密，内层壳负责抽取）。' +
          '把混合型单独放一节（19.7），是因为它<b>不是代际的延续，而是同一代技术在不同部位的重复使用</b>——' +
          '判定时的处理方式完全不同：你要先<b>排顺序</b>，而不是先<b>定代际</b>。</p>') +
        '<p>下面把五代形态（含 VMP 与混合型）逐个点亮。每一步都注意三件事：<b>它藏什么、你看到什么、该做什么</b>。</p>',
      stage: {
        title: '壳的代际演进 · 五代形态一轮过',
        speed: 2400,
        render:
          '<div class="flow-row" style="flex-wrap:wrap;gap:8px;align-items:center">' +
            '<span class="blk" id="b1">一代壳<br><span class="small">整体加密</span></span><span class="arrow">→</span>' +
            '<span class="blk" id="b2">二代壳<br><span class="small">抽取 + 回填</span></span><span class="arrow">→</span>' +
            '<span class="blk" id="b3">三代·DEX2C<br><span class="small">翻译成 native</span></span><span class="arrow">→</span>' +
            '<span class="blk" id="b4">三代·VMP<br><span class="small">自定义指令集</span></span><span class="arrow">+</span>' +
            '<span class="blk" id="b5">混合型<br><span class="small">多 dex / 多 so / 壳中壳</span></span>' +
          '</div>' +
          '<div style="margin-top:12px"><span class="pill" id="mark">点「单步」逐个展开</span></div>' +
          '<div class="grid3" style="margin-top:12px">' +
            '<div><div class="card-title">它藏什么</div><div class="small" id="c1" style="line-height:1.9;color:var(--fg-2)">—</div></div>' +
            '<div><div class="card-title">你会看到什么</div><div class="small" id="c2" style="line-height:1.9;color:var(--fg-2)">—</div></div>' +
            '<div><div class="card-title">下一步做什么</div><div class="small" id="c3" style="line-height:1.9;color:var(--fg-2)">—</div></div>' +
          '</div>',
        reset: function () {
          ['b1','b2','b3','b4','b5'].forEach(function (i) { S(i, ''); });
          CLS('mark', 'pill'); SET('mark', '点「单步」逐个展开');
          SET('c1', '—'); SET('c2', '—'); SET('c3', '—');
        },
        steps: [
          { run: function () { S('b1', 'active'); SET('c1', '整份 <code>classes.dex</code>（可能还有其它 dex）被加密或整体搬走'); SET('c2', 'jadx 只看到壳的代码；<code>assets/</code> 里可能有个体积异常的文件'); SET('c3', '找 dump 时机：解密完成、ART 已接管结构的那一刻抓内存'); },
            note: '<b>一代壳：整体加密 / 文件重定向。</b>最朴素的做法——把真 dex 加密后换个位置存，' +
              '启动时解密到内存再加载。<span class="hit">它的漏洞很明确：内存里一定会出现一份完整的明文 dex。</span>' },
          { run: function () { S('b1', 'done'); S('b2', 'active'); SET('c1', '只抽走方法体的字节码（<code>insns</code>），结构全留着'); SET('c2', '<b>完整的类名/方法名/字段/签名</b>，但方法体是空的或只有 <code>return</code>'); SET('c3', '主动调用：遍历所有方法强制触发回填，再逐方法 dump'); },
            note: '<b>二代壳（抽取壳）：静态抽取 + 动态回填。</b>针对的就是一代壳的漏洞——' +
              '既然你总能 dump 到内存里的明文，那就<b>让内存里的那份本来就不完整</b>：实体结构给你，字节码等你要用时才给。' },
          { run: function () { S('b2', 'done'); S('b3', 'active'); SET('c1', '方法体的执行逻辑被翻译成 C 再编译进 so'); SET('c2', 'Java 层可能只剩一个 native 声明，或者方法体是一小段「读参数 → 调用 native」的胶水代码'); SET('c3', '在 <code>JNI_OnLoad</code> / <code>RegisterNatives</code> 处记录绑定关系，再做动态 Trace'); },
            note: '<b>三代壳第一支：DEX2C / Java2C。</b>针对的是二代壳的漏洞——既然你总能「主动调用逼它回填」，' +
              '那就<b>干脆不在 Java 层准备字节码</b>：把字节码翻译成等价的 C 代码编进 so。回填这件事从根上不存在了。' },
          { run: function () { S('b3', 'done'); S('b4', 'active'); SET('c1', '字节码被换成厂商自定义的指令集，配一个解释器'); SET('c2', '方法体不是空的，而是「读一串数据 + 跳进一个循环」；一段代码看不出语义'); SET('c3', '先找到分发循环与 handler 表，量清指令集规模；多数情况黑盒调用更划算'); },
            note: '<b>三代壳第二支：VMP。</b>DEX2C 的编码量太大（每个方法都要翻），VMP 把这一步变成「换一套指令集 + 写一个解释器」，' +
              '<span class="hit">保护强度更高、体积代价更小，代价是运行变慢。</span>这一支的深入内容在第 6 章，本章只要求你<b>能认出来</b>。' },
          { run: function () { S('b4', 'done'); S('b5', 'active'); SET('c1', '同一份 APK 里多种保护并存：部分 dex 抽取、部分 native 化、多个 so 分工、甚至壳中壳'); SET('c2', '现象互相矛盾：某些类方法体正常、某些为空、某些是 native 声明'); SET('c3', '<b>先排顺序</b>：哪一层在最外面（决定你能拿到什么），哪一层在最里面（决定你最终能读什么）'); },
            note: '<b>混合型：多 dex / 多 so / 壳中壳。</b>这不是第四代，而是<b>把前几代的技术在不同部位重复用了一遍</b>。' +
              '判定它的难点不是「认不出」，而是「认出太多」——<span class="hit">这时候要问的不是「这是几代壳」，而是「先啃哪一层」。</span>' },
          { run: function () { S('b5', 'cool'); CLS('mark', 'pill ok'); SET('mark', '✅ 五代形态的共同点：它们都必须让代码最终可执行'); },
            note: '<b>收束到一句判定的底层逻辑：</b>无论哪一代壳，代码最终都要被 CPU 执行。' +
              '要么以字节码形式（一代、二代 → 内存里一定有明文 dex），要么以机器码形式（三代 → 内存里一定有可执行代码）。' +
              '<span class="hit">所以判定壳类型，本质上是在问：<b>它把「可执行的真相」放在了哪一层？</b>' +
              '而你的每一种观测手段，都是在某一层找这个真相。</span>' }
        ]
      },
      after:
        T.note('ok', '✅ 这一节要带走的一句话',
          '<p style="margin-bottom:0">后面所有判定规则，都是从这张代际表推出来的：' +
          '<b>结构完整但方法体空 → 二代；连结构都看不到 → 一代；方法体是 native 或天书 → 三代；' +
          '现象互相矛盾 → 混合，先排顺序。</b></p>')
    },

    /* ============================================================ 19.4 */
    {
      h: '19.4', title: '一代壳的完整启动链路：文件重定向到底改了什么',
      html:
        '<p>一代壳最容易被误解的一点是：<b>它通常不「加密」一个大文件藏起来，而是把 APK 本身的结构改掉</b>。' +
        '典型做法是：把原始 <code>classes.dex</code> 换成一个只做引导的壳 dex，真 dex 加密后放在 <code>assets/</code> 或另起名字；' +
        '再把 <code>AndroidManifest.xml</code> 里的入口 Application 换成壳的 Application。<b>这套动作叫文件重定向。</b></p>' +
        T.tbl(['重定向的对象', '改成了什么', '你静态看到的后果'],
          [
            ['<code>classes.dex</code>', '壳自己的引导 dex（几百 KB 量级）', 'jadx 里只有壳的代码，业务包名下一个类都没有'],
            ['真 dex', '加密后放进 <code>assets/</code> 或改名/分片', '反编译看不到；但 <code>unzip -l</code> 能看到体积异常的文件'],
            ['<code>AndroidManifest.xml</code> 的 <code>application:name</code>', '壳的 Application（或一个继承自它的 Stub）', '你在 Manifest 里找不到业务方自己的 Application 类'],
            ['组件（Activity/Service/Provider）', '部分情况下改成壳的代理组件，运行时再转发', '<span class="pill warn">待核实</span> 是否代理、代理到什么程度随厂商与版本变化']
          ]) +
        T.note('warn', '⚠️ 「重定向」和「加密」是两件事，别混着讲',
          '<p style="margin-bottom:0">重定向只负责<b>换掉入口和文件位置</b>，加密负责<b>让你读不懂内容</b>。' +
          '有些一代壳甚至不加密（只做重定向 + 混淆），你仍然能在 <code>assets/</code> 里直接捞到明文 dex，' +
          '只是名字不叫 <code>classes.dex</code> 而已。<span class="hit">所以「看不到业务代码」不等于「内容被加密了」——' +
          '这是判定时第一个要分清的岔路：<b>是找不到，还是读不懂？</b></span></p>') +
        '<p>把一次完整的启动过程走一遍。注意第 5 步之后，<b>你已经在内存里拥有过一份完整的明文 dex 了</b>——这就是一代壳无法回避的窗口。</p>',
      stepper: {
        title: '一代壳启动链路：从点击图标到业务代码跑起来',
        lines: [
          { code: '<span class="c">// 1. 系统按 Manifest 拉起 Application</span>',
            note: '<b>入口已经被换过了。</b>系统读到 <code>application:name</code>，实例化的是<b>壳的 Application</b>（或它的子类）。' +
              '业务方自己的 Application 此刻还没出生——它要等信息从解密后的 dex 里被加载出来。<br>这是所有壳的共同起点。',
            state: { '进程': 'com.example.app', 'Application': '壳的 Stub', '业务代码': '尚未加载' } },
          { code: '<span class="k">@Override</span> <span class="k">protected void</span> <span class="f">attachBaseContext</span>(Context base) {',
            note: '<b>★ 壳的动手点。</b><code>attachBaseContext</code> 早于 <code>onCreate</code>，是进程里最早能拿到 <code>Context</code> 的位置。' +
              '壳在这里完成：读配置 → 解密 → 加载 → 替换。<b>判定时的含义：只要这个方法被覆写，就说明入口层被接管了。</b>',
            state: { '调用时机': 'Application.onCreate 之前', '可用资源': 'Context / AssetManager', '脱壳阶段': '① 入口接管' } },
          { code: '  <span class="f">super</span>.<span class="f">attachBaseContext</span>(base);',
            note: '先调 super，保证 Context 正常初始化。<b>顺序本身也是特征</b>：如果解密逻辑写在 super 之前，往往说明它需要尽早拿到路径、或不想依赖父类初始化——' +
              '这类细节在读逆向后壳源码时会看到，但<span class="pill warn">待核实</span>不能当成通用判据。',
            state: { '脱壳阶段': '① 入口接管' } },
          { code: '  <span class="k">byte</span>[] enc = <span class="f">readAsset</span>(<span class="s">"assets/xxxx.bin"</span>);',
            note: '<b>读出加密数据。</b>数据源可能来自 <code>assets/</code>、<code>res/</code>、或另一个 <code>.dex</code>，' +
              '也可能根本不在 APK 里（服务端下发 / 从 so 里生成）。<span class="hit">这一步的线索价值极高：它决定你后面能不能离线拿到密文。</span>',
            state: { '密文来源': 'assets/xxxx.bin', '大小': '数 MB（量级与真 dex 相称）', '脱壳阶段': '② 取密文' } },
          { code: '  <span class="k">byte</span>[] dex = <span class="f">decrypt</span>(enc, <span class="f">getKey</span>());',
            note: '<b>★ 关键瞬间：明文 dex 出现在内存里。</b>此刻它还是一块裸数据，没被 ART 接管，所以没有 DexFile 对象、没有类定义。' +
              '<span class="hit">这正是「dump 早了拿到密文、dump 晚了被壳藏回去」的那个窗口。</span>' },
          { code: '  <span class="f">loadDex</span>(dex);   <span class="c">// 自造 DexClassLoader / InMemoryDexClassLoader</span>',
            note: '<b>把明文交给自己造的加载器。</b>低版本常见「先落地成文件再 <code>DexClassLoader</code>」，高版本可用 <code>InMemoryDexClassLoader</code> 直接吃内存。' +
              '<span class="pill warn">待核实</span> 具体用哪个 API 与该壳适配的 minSdk 有关，两种都能见到。',
            state: { '加载器': '壳自定义（不是 PathClassLoader）', '落地与否': '可能落地也可能纯内存', '脱壳阶段': '③ 加载' } },
          { code: '  <span class="f">replaceClassLoader</span>();   <span class="c">// 反射替换</span>',
            note: '<b>替换掉系统的加载器引用。</b>社区通行做法是反射改掉 <code>ActivityThread</code> 持有的包信息里的 <code>mClassLoader</code>，' +
              '并把新加载器的 <code>dexElements</code> 合并进原有列表。<br>' +
              '<span class="pill warn">待核实</span> 具体字段名（<code>mPackages</code> / <code>mClassLoader</code> / <code>pathList</code> / <code>dexElements</code>）随安卓版本变化，' +
              '高版本还受 hidden API 策略限制——<b>记机制，不要记字段名</b>。',
            state: { '目标': '让系统后续加载业务类时走壳的加载器', '副作用': 'Java.use 用默认加载器看不到业务类', '脱壳阶段': '④ 接管' } },
          { code: '}', note: '<b>attachBaseContext 结束。</b>此时壳已经把「业务代码这条路」修好了，接下来系统会继续走正常的 Application 生命周期。',
            state: { '脱壳阶段': '④ 接管完成' } },
          { code: '<span class="c">// 2. 壳在 onCreate 里把真正的 Application 唤起</span>',
            note: '<b>业务 Application 被反射创建出来并接手。</b>常见做法是反射 <code>newInstance</code> 真 Application，再依次调用它的 <code>attachBaseContext</code> / <code>onCreate</code>。' +
              '<b>这解释了一个高频困惑：为什么在真 Application 的 onCreate 里下断点，断到的时候「壳的东西早就跑完了」。</b>',
            state: { '真 Application': '已实例化并接管', '脱壳阶段': '⑤ 接力' } },
          { code: '<span class="f">launchMainActivity</span>();  <span class="c">// 业务逻辑开始执行</span>',
            note: '<b>业务代码终于跑起来。</b>回到判定视角：如果你到这里才发现「原来真 dex 早就在内存里」，那说明你要的观测点应该在更早——' +
              '<b>Application 初始化阶段，而不是业务逻辑阶段</b>。<span class="hit">脱壳的时机永远比你的直觉更早。</span>',
            state: { '内存中': '存在完整明文 dex', '窗口状态': '可能仍然打开，也可能已被清理', '脱壳阶段': '✅ 结束' },
            mem: '一代壳在内存里留下的两个窗口\n\n① attachBaseContext 中：解密后的裸 dex\n   特征：没有 DexFile 结构，只有一块数据\n   风险：这里 dump 要靠特征扫描，容易误判\n\n② 加载器接管之后：ART 眼中的完整 dex\n   特征：有 DexFile、有类定义、方法表齐全\n   优点：dump 出来直接可用（结构完整）\n   这就是「一次到位」的那个点（第 2 章 s5/s6）' }
        ]
      },
      after:
        T.note('ok', '✅ 这一节的判定产出',
          '<p style="margin-bottom:0">看完这条链路，你应该能回答三个问题：<b>①</b> 入口层有没有被接管（看 <code>attachBaseContext</code> 与 Manifest 的 ' +
          '<code>application:name</code>）；<b>②</b> 密文在不在 APK 里（看 <code>assets/</code>）；' +
          '<b>③</b> 你有没有可能在启动早期就把明文 dex 拿到手。<b>这三问就是一代壳的全部判定内容。</b></p>')
    },

    /* ============================================================ 19.5 */
    {
      h: '19.5', title: '二代壳：抽取壳的「静态抽取 + 动态回填」',
      intuition: {
        tag: '直觉模型 · 图书馆把书页抽走，借书时才还给你',
        body:
          '<p>一代壳的漏洞太明显：内存里总会有一份完整的书。于是加固方换了个思路——<strong>不藏整本书，改抽书页</strong>。</p>' +
          '<p>目录、章节名、页码全部照常印（这部分是「结构」），但每一章的正文被抽走了，只留一行「此页待补」。' +
          '你想借哪一章，它当场把那一章的正文补印上去 —— <strong>你没借过的章节，永远是空的</strong>。</p>' +
          '<p>这个类比的每一处都对应真实机制：<b>目录 = dex 的类/方法/字段表</b>（完整保留，所以 ART 能正常加载和链接类）、' +
          '<b>正文 = 方法体的 <code>code_item</code></b>（被抽走）、<b>「借书时才补印」= 方法首次被调用时才回填</b>。</p>' +
          '<p>而它的直接推论就是脱壳的全部难度：<strong>脱壳完整度 = 你触发过的代码路径覆盖度</strong>。这不是技巧，是机制决定的下限。</p>'
      },
      html:
        '<p>抽取壳（二代壳）要解决的核心问题是：<b>如何在「结构必须完整」的前提下让「内容不可读」</b>。' +
        'dex 的类定义、方法签名、字段表必须真实存在，否则 ART 无法链接类、无法调用方法；' +
        '但方法体可以是一段「待回填」的占位。</p>' +
        T.tbl(['环节', '抽取壳做了什么', '你观测到什么'],
          [
            ['<b>静态抽取</b>', '编译期/加固期把每个 <code>code_item</code> 的 <code>insns</code> 抽走，替换为空或 nop 填充；原始指令加密后另存',
             'jadx 反编译成功、类名方法名齐全，方法体为空或只有 <code>return null</code>'],
            ['<b>结构保留</b>', '类/方法/字段/字符串表原样保留（否则类加载会崩）',
             '<code>class_defs_size</code> 正常（几百到几千）；你甚至能看到完整的调用关系'],
            ['<b>运行时回填</b>', '方法首次被执行（或首次被解析）时，壳的解密逻辑把真指令写回该方法的 code item',
             '调用过的方法有代码了；冷门分支/未走过的路径仍是空的'],
            ['<b>native 解密器</b>', '回填逻辑与密钥通常在 so 里（配合 19.8 的 SO 加固）',
             '你在 Java 层找不到「回填」这件事的代码；native 注册痕迹明显']
          ]) +
        T.note('key', '🔑 判定抽取壳的三个独立证据（凑齐两个就够用）',
          '<p>① <b>结构完整但方法体空</b>——最直接的现象，jadx 里一眼可见；<br>' +
          '② <b>跑过功能之后，某些方法「自己长出来了」</b>——同一个 dex 前后 dump 两次，非空方法数会变多；<br>' +
          '③ <b>native 侧有解密/回填逻辑</b>——JNI 动态注册、可执行匿名段、或某个 so 在方法调用前后被访问。</p>' +
          '<p style="margin-bottom:0"><span class="hit">第 ② 条是把「抽取壳」和「dex 本来就残缺」区分开的关键：' +
          '抽取壳的缺失是<b>可变的</b>（随调用而减少），残缺是<b>恒定的</b>。</span></p>') +
        T.acc('为什么「主动调用」是这件事的自然解法（衔接第 2 章）',
          '<p>既然回填由「方法被执行」触发，那么最笨也最彻底的办法就摆在那里了：<b>把所有方法都执行一遍</b>。' +
          '这正是 FART 主动调用的全部逻辑——遍历所有 DexFile × 所有类 × 所有方法，构造默认参数强行调用，' +
          '让壳认为「这个方法要被用了」，从而完成回填，然后立刻把 code item dump 下来。</p>' +
          '<p style="margin-bottom:0">这也解释了第 2 章那个反直觉的细节：<b>调用抛异常没关系</b>，' +
          '因为你要的不是返回值，是「回填」这个副作用。<span class="pill warn">待核实</span> 更高版本的 ART 上，' +
          '回填的触发点是「首次执行」还是「首次解析/验证」，随结构与实现变化——<b>但只要你把方法真的调用到，两种情况下它都必须给出真指令。</b></p>') +
        '<p>最后分清一件事：抽取壳与「字符串加密」是两种独立保护，经常同时出现。方法体完整但字符串全是乱码，那是字符串加密（第 5 章）；' +
        '方法体本身为空，才是抽取。</p>',
      quiz: {
        id: 'q19-2', chapter: 19, answer: 1,
        stem: '你脱壳得到两份 dex：第一次 dump 时 <code>Crypto.a()</code> 是空的，' +
              '点了一遍 App 所有界面再 dump，同一个类里 <code>Crypto.b()</code> 变成了有内容的、但 <code>Crypto.a()</code> 仍然是空的。' +
              '最合理的解释是？',
        options: [
          { t: '<code>Crypto.a()</code> 属于 VMP 保护，<code>Crypto.b()</code> 属于抽取壳保护', why: '同一个类里混用两种代际保护技术上可能，但用这个现象无法推出——空方法本身就是抽取壳的特征，不需要引入 VMP。' },
          { t: '抽取壳只回填「被调用过」的方法，<code>a()</code> 所在的代码路径没有被你的操作触发', why: '正确。回填由调用触发，完整度 = 触发覆盖度。' },
          { t: '第二次 dump 覆盖了第一次的结果，<code>a()</code> 的内容被写坏了', why: '抽取壳的缺失是可变的（调用过才有），不是 dump 覆盖造成的；而且你也无法解释 b() 恢复。' },
          { t: '<code>a()</code> 是一个从未被编译进 dex 的方法，本来就不存在', why: '方法在 dex 里存在（你能看到它的方法名和签名），只是 code item 为空——存在与有内容是两件事。' }
        ],
        explain: '抽取壳的回填发生在方法被真正执行（或被执行前必须解析）的时候。<b>你没走过的代码路径，它的方法体就还锁着。</b><br><br>' +
          '所以脱壳前那一轮「把 App 每个界面、每个按钮都点一遍」不是玄学，它是在<b>提高触发覆盖度</b>。' +
          '而如果某条路径没法自然触发（需要特定参数、特定服务端状态、特定分支条件），就只剩人工触发一条路：' +
          '用 Frida 主动调用它一次（第 2 章讲过这个补触发手法）。<br><br>' +
          '<b>注意这道题的判据价值：</b>「同一个 dex 前后两次 dump，非空方法数变多」——这个现象本身就是抽取壳的指认，' +
          '而不是「壳没脱干净」这类模糊说法。<span class="hit">可变的缺失 = 抽取；恒定的缺失 = 残缺。</span>'
      }
    },

    /* ============================================================ 19.6 */
    {
      h: '19.6', title: '三代壳：DEX2C / Java2C 与 VMP',
      html:
        '<p>二代壳的漏洞是「只要我调用，你就得给我真指令」。三代壳的应对是釜底抽薪：<b>Java 层干脆不再放字节码</b>。' +
        'DEX2C 把字节码翻译成等价的 C 再编译进 so；VMP 把字节码换成一套自定义指令，再配一个解释器。' +
        '<span class="hit">两者的共同点是：<b>回填这个动作从根上不存在了——没有东西可以回填。</b></span></p>' +
        T.tbl(['', 'DEX2C / Java2C', 'VMP'],
          [
            ['<b>做什么</b>', '逐方法把 dalvik 字节码翻译成 C 源码（或直接生成机器码），编译进 so，Java 侧改成 native 声明', '把字节码转成厂商自定义的指令序列存在数据里，运行时由解释器逐条执行'],
            ['<b>Java 层看到什么</b>', '一个 <code>native</code> 声明，或一小段「存参数、调 native」的胶水代码', '方法体有内容，但是「读一串数据 → 跳进一个循环」，看不出业务语义'],
            ['<b>代价</b>', '每个方法都要翻一遍，so 体积与编译时间随方法数线性增长，<b>编码量大</b>', '体积小得多，但要自己写解释器；<b>运行变慢</b>（每条指令都要解码+分发）'],
            ['<b>破解思路</b>', '先定位 JNI 绑定关系，再判断是「翻译后代码」还是「手写 native」；能 Trace 就 Trace', '找分发循环与 handler 表，还原「自定义 opcode → 原始操作」的映射（第 6 章）'],
            ['<b>判定器里的假设</b>', '<code>gen3</code>', '<code>vmp</code>']
          ]) +
        T.note('warn', '⚠️ 三个易混现象，分清它们',
          '<p>① <b>方法体为空</b> → 抽取壳（二代）。<br>' +
          '② <b>方法体是 <code>native</code> 声明</b> → 要么这个 App 本来就用 NDK 写的（无害），要么是 DEX2C 的产物。<b>区分办法：</b>' +
          '看它是不是「所有业务方法都变成 native」，以及是否存在 native 动态注册——只有少数几个 native 方法是正常工程，成片的才是加固。<br>' +
          '③ <b>方法体有代码但语义不通</b>（读数据 + 大循环 + 表跳转）→ VMP。</p>' +
          '<p style="margin-bottom:0"><span class="pill warn">待核实</span> 各厂商对这三条路线的取舍细节（翻多少方法、VMP 的指令集如何设计）属于内部实现，' +
          '公开资料只能给出路线，不能给出参数。凡是你没实测过的，都别当结论用。</p>') +
        T.card('为什么三代壳把「判定」和「还原」彻底分成了两件事',
          '<p>对一代/二代壳，「脱壳」本身就是全部工作：拿到明文 dex，一切就结束了。<br>' +
          '到三代壳，脱壳只是起点：你拿到了 so，但 so 里是一个由工具生成的、被混淆过的翻译结果或解释器。' +
          '<span class="hit">这时候决定成败的不再是「你能不能 dump」，而是「你能不能读懂 native 代码」——也就是第 3、4、5、6 章的内功。</span></p>' +
          '<p style="margin-bottom:0">这也是本课程把第 3～7 章放在脱壳之后的原因：<b>脱壳的下限靠工具，上限靠你能不能读汇编与源码。</b></p>'),
      quiz: {
        id: 'q19-3', chapter: 19, answer: 3,
        stem: '下面哪一条现象组合最能区分「DEX2C 翻译」和「VMP 保护」？',
        options: [
          { t: '有没有 so 文件', why: '两者都会用到 so，这不是区分点。' },
          { t: '方法体是不是空的', why: '空的属于抽取壳（二代）；DEX2C 与 VMP 的方法体都不是空的。' },
          { t: 'AndroidManifest 里的 application:name 是否被替换', why: '入口被替换是几乎所有壳的共同前置动作，区分不了代际。' },
          { t: 'Java 侧看到的是 native 声明/胶水代码，还是「读数据 + 跳进一个大循环」', why: '正确。DEX2C 把逻辑变成 native 代码（Java 侧退回声明）；VMP 保留了 Java 侧的执行入口，但执行的是自定义指令，因此表现为数据 + 解释循环。' }
        ],
        explain: '<b>关键差别在于「执行发生在哪里」。</b><br><br>' +
          'DEX2C 走的是正常 JNI 路径：Java 调用 → native 函数 → 机器码。<b>Java 层的那个方法已经被 native 方法取代</b>，' +
          '所以你在反编译里看到的是 <code>native</code> 声明或极小的一层胶水。<br><br>' +
          'VMP 走的是自定义解释器路径：Java 层那个方法<b>仍然是一个普通方法</b>，只是它的字节码被换成了「加载一个数据指针 + 进入解释循环」，' +
          '真正的指令序列存放在数据段里。<b>所以你看到的是「有代码、但读不出业务语义」。</b><br><br>' +
          '顺带记住两者的还原代价差异：DEX2C 的产物是<b>正常编译出的机器码</b>，能用常规逆向手段（字符串、常量、调用关系）啃；' +
          'VMP 需要先还原指令集映射，工作量高一个量级。<span class="hit">判定顺序上：先分清是哪一支，再决定投入多少时间。</span>'
      },
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境三',
            scenario: '<b>情境：</b>一个 App 里同时出现两种现象：<code>com.a.*</code> 这一片类的方法体是空的（跑过一遍后部分恢复），' +
                      '<code>com.b.Pay</code> 这个类的方法体有代码，但内容全是「读取一个 int 数组 + 跳进一个两百行的 switch 循环」。' +
                      '你只有一周时间，要拿到支付签名算法的逻辑。',
            q: '先啃哪一块？',
            choices: [
              { t: '先啃 VMP——它最难，必须最早开始', next: 'n1' },
              { t: '先啃抽取壳，把 Java 层恢复完整，拿到完整的调用图，再决定 VMP 那块值不值得啃', next: 'n2' },
              { t: '两条线并行，两边同时开工以节省时间', next: 'n3' },
              { t: '放弃还原代码，直接用 unidbg 这类方案黑盒调用支付签名函数', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'bad',
            verdictTitle: '排序依据错了：该先看依赖关系，而不是难度',
            result: '<b>「最难所以要最早开始」听起来合理，但在逆向里通常不成立。</b><br><br>' +
              '你现在啃 VMP，缺的是<b>坐标系</b>：<code>com.b.Pay</code> 是谁调用的？入参从哪来？那个 int 数组什么时候被初始化？' +
              '这些答案全在 <code>com.a.*</code> 那批<b>方法体为空</b>的类里。<br><br>' +
              '你会花掉三天，建立一堆「这个 handler 大概在做异或」的猜测，然后在第四天发现真正的入口是一个你还没恢复的方法。<br><br>' +
              '<span class="hit">正确的问题是：<b>哪一块的产出能降低另一块的难度？</b>答案几乎总是「先把可恢复的那层恢复掉」。</span>'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'good',
            verdictTitle: '正确：先建立坐标系，再决定投入',
            result: '<b>这是一条正确的排序。</b>抽取壳那一块虽然「不得不做」，但它的产出是确定的：' +
              '跑功能 + 主动调用 → 回填 → dump → 修复，你能拿到一份完整的 Java 层调用图。<br><br>' +
              '拿到之后你才能回答关键问题：<b><code>com.b.Pay</code> 的调用者是谁、入参怎么构造、返回值怎么用。</b>' +
              '很多情况下这一步做完，你会发现真正需要还原的 VMP 函数只有一两个，而不是整个类。<br><br>' +
              '<b>还有一层现实收益：</b>抽取壳的恢复工作可以脚本化、可以复用，而 VMP 的还原是纯脑力活。' +
              '<span class="hit">先做能规模化的部分，把脑力留给真正硬的部分。</span>'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '并行在这里是成本翻倍，不是时间减半',
            result: '<b>逆向工作的并行成本远高于普通开发。</b><br><br>' +
              '两条线的上下文都需要长时间驻留（一堆类名、一组 handler、一套寄存器约定），切一次上下文就要重新加载一次。' +
              '而且抽取壳这条线本身是<b>有状态</b>的：你每次重新脱壳，产物都可能不同（回填取决于你触发了哪些路径）。' +
              '两条线同时跑，你很容易分不清「这个差异是壳的行为还是我的操作顺序造成的」。<br><br>' +
              '<b>如果真要并行，正确做法是拆人而不是拆脑：</b>一个人专做脱壳流水线（可脚本化），一个人专做 VMP 静态分析。' +
              '自己一个人两条线同时开工，通常两头都做不深。'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'good',
            verdictTitle: '可能是性价比最高的一条路——但有前提',
            result: '<b>如果你的目标只是「拿到支付签名的输入输出关系」，这条路确实可能最省时间。</b>' +
              '在 PC 上模拟执行 so 里的目标函数、直接构造输入拿输出，绕开整套还原工作（第 7 章的方法）。<br><br>' +
              '<b>但前提必须说清，缺一条这条路的成本就会反超：</b><br>' +
              '① 目标函数能<b>独立复现</b>——它的输入输出不依赖大量 Java 层状态（否则你要补的「环境」比脱壳还贵）；<br>' +
              '② 你能拿到函数的<b>入口地址或调用锚点</b>——在动态注册被隐藏的情况下，这本身需要一次运行时观测；<br>' +
              '③ 你的目标允许「黑盒」——如果最终需要理解算法逻辑（而不是只调用它），黑盒调用给不了你逻辑。<br><br>' +
              '<span class="hit">所以 D 不是一个偷懒选项，而是一个需要先验证前提的工程选择。先花半天验证这三条，再决定要不要投入。</span>'
          }
        }
      }
    },

    /* ============================================================ 19.7 */
    {
      h: '19.7', title: '混合型壳：多 dex、多 so、壳中壳',
      html:
        '<p>混合型不是「第四代」，而是<b>同一批技术在不同部位的重复使用</b>。它出现的动机很实在：' +
        '一个壳要同时满足「防护强」和「启动快、兼容好」，就得<b>分级保护</b>——核心算法上 VMP，普通业务用抽取，' +
        '壳自身的引导代码只做加密。</p>' +
        T.tbl(['混合形态', '典型现象', '处理顺序'],
          [
            ['<b>多 dex 分代保护</b>', '<code>classes.dex</code> 是壳、<code>classes2.dex</code> 是抽取过的业务、还有运行时动态加载的第三份',
             '先把所有 dex 都枚举出来（含运行时加载的），再逐个判代际——<b>不要假设「业务代码只在某一个 dex 里」</b>'],
            ['<b>多 so 分工</b>', '一个 so 负责解密与加载（壳 so），另一个 so 是业务 native 库，可能有第三个 so 做反调试',
             '按 maps 里的加载时机区分角色：壳 so 出现得早、业务 so 出现得晚；先弄清谁加载了谁'],
            ['<b>壳中壳</b>', '外层壳解密出内层壳，内层壳再解密业务 dex；表现为「脱一层还是壳」',
             '<b>逐层验证</b>：每脱一层就问「这份 dex 里有业务类吗」——用类名/包名判断，不要用体积判断'],
            ['<b>保护分级</b>', '同一个 App 里，登录流程是抽取壳、支付算法是 VMP、普通页面完全不保护',
             '按<b>业务重要性</b>排优先级：你要分析的往往只是其中一小块，别把它当成「整个 App 都要脱」']
          ]) +
        T.note('key', '🔑 混合型的第一原则：先排顺序，不要先定代际',
          '<p style="margin-bottom:0">面对混合型样本，「这是几代壳」这个问题本身就没有答案，也不重要。' +
          '你要问的是：<b>哪一层在最外面（决定我现在能拿到什么）、哪一层在最里面（决定我最终能读到什么）、中间还隔着几层？</b><br>' +
          '<span class="hit">一个实用的自检：如果你连续两次「脱壳成功」拿到的都是壳代码，那你面对的是壳中壳——' +
          '此时正确的动作是回到判定流程，而不是换工具。</span></p>') +
        T.card('一个反直觉但很重要的推论',
          '<p>混合型把「判定」的价值放大了。<b>如果对手只有一种保护，你可以靠工具莽过去；有多种保护时，莽的代价是成倍的。</b></p>' +
          '<p style="margin-bottom:0">因为不同保护对应的工具链、观测层、失败模式都不同：拿主动调用工具去啃 VMP 只会得到一堆看不懂的 native；' +
          '拿静态反混淆工具去啃抽取壳只会看到空方法。<span class="hit">判定不是「为了严谨」，它是省时间的手段。</span></p>')
    },

    /* ============================================================ 19.8 */
    {
      h: '19.8', title: 'SO 加固：从加固方视角看它为什么必须做',
      intuition: {
        tag: '直觉模型 · 把说明书撕掉，再把门牌号码涂掉',
        body:
          '<p>你有一台进口设备（so），操作全靠一份说明书（导出符号表）。想阻止别人修它，有两个层次的手段：</p>' +
          '<p><strong>第一种：把整台设备焊死在箱子里</strong>——so 整体加密，运行时才在内存里解出真正的 so 并加载。' +
          '这就是「so 加固」的第一层。对手拿到的磁盘文件是一堆密文。</p>' +
          '<p><strong>第二种：把门牌号码涂掉</strong>——设备还能用，但所有按钮都不标名字（抹除导出表），' +
          '只有厂家的图纸（<code>RegisterNatives</code> 那几行）知道哪个按钮是哪个功能。' +
          '这就是「JNI 动态注册」为什么是加固的标配。</p>' +
          '<p>关键区别：第一种让你<strong>读不到代码</strong>，第二种让你<strong>读得到代码、但找不到入口</strong>。' +
          '很多人的困惑「我拿到了 so，为什么全是没有符号的函数」就是第二种造成的。</p>'
      },
      html:
        '<p>下面只讲<b>加固方在这里图什么、以及它这么做完之后留下什么特征</b>——具体的 ART/JNI 机制在第 4 章、反 Frida 细节在第 10 章，这里不重复。</p>' +
        T.tbl(['SO 侧手段', '加固方图什么', '留下的特征（你的判定依据）', '深入章节'],
          [
            ['<b>so 整体加密</b>', '磁盘上不出现可分析的机器码。密钥与解密逻辑放在更早的一层（通常是另一个 so 或壳 dex 里）',
             '<code>lib/</code> 下的 so 打开没有 ELF 魔数或没有节表；或者 so 体积正常但静态读不出任何有意义内容；运行时 maps 里出现自删/内存加载痕迹',
             '第 10 章（脱壳进阶）'],
            ['<b>自定义 Linker / 内存加载</b>', '不走系统 <code>dlopen</code>，自己把 so 映射进内存并修补重定位，让「加载」这件事不留下文件痕迹',
             'maps 里出现无名可执行段、<code>memfd:</code>、<code>(deleted)</code> 的 so——这三条在 19.13 的实验里会被逐条对照',
             '第 4 章（ART/加载流程）'],
            ['<b>导出表抹除</b>', '让静态分析找不到函数入口：<code>JNI_OnLoad</code> 也不导出，或符号名被改成无意义串',
             '<code>readelf -s</code> 几乎为空；IDA 里只有 <code>sub_xxxx</code>；但 .text 段依然有大量代码',
             '第 3 章（汇编）、第 4 章'],
            ['<b>JNI 动态注册</b>', '把「Java 方法名 → native 函数地址」的绑定关系从符号表挪到运行时，静态无从下手',
             'Java 侧只剩 <code>native</code> 声明；so 里存在 <code>RegisterNatives</code> 的调用痕迹；绑定关系只在运行时存在',
             '<b>第 4 章（本章的重要呼应点）</b>'],
            ['<b>控制流平坦化 / 字符串加密</b>', '让即使拿到 so 也难以读懂：把控制流压成一个分发循环，把字符串加密',
             '函数里出现统一的分发器结构；字符串引用指向一段密文再解密使用',
             '第 5 章（OLLVM）'],
            ['<b>so 内反调试</b>', '把检测放到 native 层，让你 hook Java 层的检测函数没有意义',
             'so 里读 <code>/proc/self/status</code>、调 <code>ptrace</code>、扫描自身内存',
             '第 10、13 章']
          ]) +
        T.note('key', '🔑 一句话记住 SO 加固的判定逻辑',
          '<p style="margin-bottom:0">「SO 层加固」不是一个开关，而是<b>两条独立的能力</b>：' +
          '<b>① 让我读不到你的代码</b>（加密 + 内存加载 + 混淆）；' +
          '<b>② 让我找不到你的入口</b>（抹导出表 + 动态注册）。<br>' +
          '判定时分别看：<span class="hit">so 文件本身是否可解析（决定 ① 的强度），以及 Java 侧 native 方法与 so 导出表是否对得上（决定 ② 的强度）。</span></p>') +
        T.acc('为什么「导出表抹除」常常被误解成「so 坏了」',
          '<p>最常见的误会：<i>我用 readelf 看符号表几乎是空的，是不是 so 被加密了？</i></p>' +
          '<p>不是。<b>加密是「内容读不出来」，抹符号是「名字读不出来」</b>，两者完全不同。一个正常的、用 <code>-fvisibility=hidden</code> 编译' +
          '并且 strip 过的 so，符号表一样可以是空的——它照样能正常加载运行。<br>' +
          '<b>区分办法：</b>看 ELF 头是否合法、节表是否存在、<code>.text</code> 段里是否有成规模的代码。' +
          '如果这些都正常，那只是「没名字」，不是「没内容」。</p>' +
          '<p style="margin-bottom:0">这条区分的价值在于：<b>「没名字」时你的工作重心是动态观测（找绑定、找调用点）；' +
          '「没内容」时你的工作重心是先拿到内存里解密后的那份。</b>方向完全不同。</p>'),
      quiz: {
        id: 'q19-4', chapter: 19, answer: [1, 3],
        stem: '（多选）一个 so 的导出符号表被彻底清空，<code>JNI_OnLoad</code> 也不再导出。下面哪些说法是对的？',
        options: [
          { t: '说明这个 so 一定是被整体加密了', why: '错误。符号表为空只说明「没有名字」，与内容是否加密无关；strip + 隐藏可见性就能做到同样效果。' },
          { t: '静态分析找不到入口，但运行时仍必须存在「Java 方法 → native 地址」的绑定过程，那里就是新的观测点', why: '正确。绑定关系无法被抹掉——虚拟机执行时必须知道地址；动态注册只是把它从静态符号表挪到了运行时。' },
          { t: '用 IDA 打开只能看到 sub_xxxx，说明这个 so 无法分析', why: '错误。没有符号名不等于没有代码。可以从交叉引用、字符串、常量、JNI 调用约定入手重建语义。' },
          { t: '它同时提高了静态分析成本与「找入口」成本，但换来的是运行时观测点的价值上升', why: '正确。这是加固的固有取舍：把信息从静态挪到动态，于是动态观测成为唯一可行的路径。' }
        ],
        explain: '<b>这道题考的是「信息守恒」这个判断。</b>加固能把信息藏起来、搬走，但很难真的消灭它——因为机器最终必须执行。<br><br>' +
          '符号表可以清空，但 <code>RegisterNatives</code> 那个调用<b>必须在运行时发生</b>，否则 Java 层的方法根本找不到实现。' +
          '所以你丢掉的是<b>静态可读的入口</b>，换来的是<b>运行时必然存在的绑定事件</b>。<br><br>' +
          '<span class="hit">第 4 章做的事，正是把插桩点放在这个绑定事件上——这不是巧合，而是「判定出入口被隐藏」之后的必然下一步。</span>'
      }
    },

    /* ============================================================ 19.9 */
    {
      h: '19.9', title: '运行时防护：五类防线分别挡在哪一层',
      html:
        '<p>运行时防护和「壳的代际」是两个独立维度：<b>一个 App 可以是二代壳 + 零运行时防护（最好啃），' +
        '也可以是一代壳 + 全套防护（最难啃）。</b>这一节解决的是第二个维度。</p>' +
        '<p>下面逐个点亮五类防线。注意每一步都问同一个问题：<b>它为什么要放在这一层，而不是上一层？</b></p>',
      stage: {
        title: '运行时防护 × 它挡在哪一层',
        speed: 1700,
        render:
          '<div class="flow-col" style="gap:10px">' +
            '<div class="card"><div class="card-title">① Java 层 —— 最容易写，也最容易被 hook</div>' +
              '<div class="flow-row"><span class="blk" id="p1">环境检测：root / 模拟器 / 多开</span>' +
              '<span class="blk" id="p2">签名校验（Java 侧）</span></div></div>' +
            '<div class="card"><div class="card-title">② Native 层 —— 壳的主战场</div>' +
              '<div class="flow-row"><span class="blk" id="p3">反调试</span>' +
              '<span class="blk" id="p4">反 Hook / 完整性校验</span>' +
              '<span class="blk" id="p5">反 Frida</span>' +
              '<span class="blk" id="p6">JNI 动态注册（隐藏入口）</span></div></div>' +
            '<div class="card"><div class="card-title">③ 内核层 / 绕过 libc —— 让用户态方案整体失效</div>' +
              '<div class="flow-row"><span class="blk" id="p7">直接 SVC 系统调用</span>' +
              '<span class="blk" id="p8">下沉到内核的观测与对抗</span></div></div>' +
            '<div style="margin-top:6px"><span class="pill" id="mark">点「单步」，逐个看它挡在哪一层、绕它需要动哪一层</span></div>' +
          '</div>',
        reset: function () {
          ['p1','p2','p3','p4','p5','p6','p7','p8'].forEach(function (i) { S(i, ''); });
          CLS('mark', 'pill'); SET('mark', '点「单步」，逐个看它挡在哪一层、绕它需要动哪一层');
        },
        steps: [
          { run: function () { S('p1', 'active'); },
            note: '<b>环境检测（Java 层为主）。</b>读 <code>Build</code> 属性、检查包名/文件是否存在（su、magisk、常见模拟器路径）、查是否多开。' +
              '<b>为什么放 Java 层：</b>写得快、覆盖大多数人的"随手改环境"；<b>代价：</b>纯 Java 检测是最容易被 hook 的一类——改一个返回值就过。' },
          { run: function () { S('p1', 'done'); S('p2', 'active'); },
            note: '<b>签名校验（Java 侧）。</b>读自身签名摘要与内置值比对。它防的是「改完重打包」，' +
              '所以它必须在<b>启动早期</b>跑一遍——晚了你改的代码已经开始执行了。<span class="hit">这也是为什么它总是出现在 Application 初始化阶段。</span>' },
          { run: function () { S('p2', 'done'); S('p3', 'active'); },
            note: '<b>反调试（Native 层）。</b>读 <code>/proc/self/status</code> 的 TracerPid、尝试 <code>ptrace</code> 附加自己、检测断点。' +
              '<b>为什么下沉到 native：</b>Java 层的检测函数会被 hook 掉，native 层的直接系统调用不会（除非你也下沉）。' },
          { run: function () { S('p3', 'done'); S('p4', 'active'); },
            note: '<b>反 Hook / 完整性校验（Native 层）。</b>校验关键函数的序言字节有没有被改成跳转、扫描 <code>/proc/self/maps</code> 找可疑注入模块、' +
              '重新计算 dex/so 摘要。<br><span class="hit">这是最难缠的一类：它不是"检测你的工具"，而是"检测你的动作留下的物理痕迹"。</span>' },
          { run: function () { S('p4', 'done'); S('p5', 'active'); },
            note: '<b>反 Frida（Native 层）。</b>扫端口、遍历线程名、在 maps 里找 agent、在内存里搜特征字符串。' +
              '<b>注意区分：</b>反 Frida 不等于加壳——很多不加壳的 App 也会做。它是<b>独立能力</b>，判定时要单独记一笔（第 10 章有完整对照表）。' },
          { run: function () { S('p5', 'done'); S('p6', 'active'); },
            note: '<b>JNI 动态注册（不是检测，是隐藏）。</b>它本身不拦你，但它把入口从静态挪到动态，' +
              '让「读代码」这条路先断掉一半。<b>放在 native 层的原因：</b>它本来就是 native 的机制，成本为零。' },
          { run: function () { S('p6', 'done'); S('p7', 'active'); CLS('mark', 'pill bad'); SET('mark', '⚠️ 到这一层，用户态 hook 整体失效'); },
            note: '<b>直接 SVC（内核层 / 绕过 libc）。</b>用内联汇编直接发系统调用，不经过 libc 的封装函数。' +
              '你以为 <code>open</code> 已经被你 hook 了，其实它走了另一条路。<span class="hit">第 13 章整章都在处理这一类对手。</span>' },
          { run: function () { S('p7', 'done'); S('p8', 'active'); },
            note: '<b>下沉到内核的观测与对抗。</b>用内核模块、eBPF，或借助虚拟化层做观测与拦截（第 11、15 章）。' +
              '<b>为什么这是最后一道：</b>到了这一层，胜负不再取决于「你的脚本写得好不好」，而取决于<b>你有没有能力进入被观测目标之下的那一层</b>。' },
          { run: function () { S('p8', 'cool'); CLS('mark', 'pill ok'); SET('mark', '✅ 五类防线分层独立：绕过一层 ≠ 绕过全部'); },
            note: '<b>收束：判定运行时防护只需要回答三个问题。</b><br>' +
              '① <b>有没有</b>（启动就退、改包就不跑，说明有）；<br>' +
              '② <b>在哪一层</b>（Java 层好办，native 层要动真格，内核层要换武器）；<br>' +
              '③ <b>和壳是什么关系</b>（是壳自带的，还是业务方另外买的 SDK —— 这两者绕过方式往往不同）。<br>' +
              '<span class="hit">把这三个问题答完，你就知道该带什么武器上场，而不是把工具轮流试一遍。</span>' }
        ]
      },
      after:
        T.note('warn', '⚠️ 研发与安全边界',
          '<p style="margin-bottom:0">本章所有内容面向<b>合法授权的安全研究、自有产品加固评估与教学</b>。' +
          '不要针对未经授权的线上产品做绕过与篡改；<b>「技术上能做到」和「现在就该做」是两件事</b>——' +
          '这个区分在本章最后的决策演练里会反复出现。</p>')
    },

    /* ============================================================ 19.10 */
    {
      h: '19.10', title: '市面加固方案简析：读路线，不读特征字符串',
      html:
        '<p>这一节的内容有一个硬约束：<b>厂商产品线变动频繁、具体特征（so 名、类名、字符串）会随版本变化</b>，' +
        '任何写死在教材里的「特征表」都会在半年内变成误导。所以这里只讲<b>可以长期成立的东西：技术路线的差异</b>。</p>' +
        T.note('bad', '🚫 为什么本章不给厂商特征字符串',
          '<p>三个理由，每一条都是实战教训：</p>' +
          '<p>① <b>会变。</b>同一个厂商的不同版本、不同产品档位，so 名和类名都可能不同；你按特征去匹配，遇到新版本就是零命中。<br>' +
          '② <b>会互相抄。</b>社区流传的特征表被大量转载，其中相当一部分从未被验证过，但你无法区分哪条是真的。<br>' +
          '③ <b>会误导判定。</b>命中一个特征字符串只能说明「像某家的做法」，<b>它不能告诉你方法体是不是被抽走了、so 是不是在内存里加载的</b>——' +
          '而后者才是决定你下一步动作的东西。</p>' +
          '<p style="margin-bottom:0"><span class="hit">正确做法是：用特征库做<b>交叉验证</b>（它命中什么厂商），' +
          '用<b>结构观测</b>做<b>判定</b>（它属于哪一代、防护开到什么程度）。两者不可互换。</span></p>') +
        T.tbl(['厂商 / 产品（公开可查的名称）', '技术路线（可长期成立的观察）', '本章的判定提示'],
          [
            ['360 加固保', '历史悠久、覆盖面广，一代到三代方案都在演进，客户端与服务端能力并重',
             '<span class="pill warn">待核实</span> 具体版本所用的代际与强度档位'],
            ['腾讯乐固（后整合为御安全相关产品线）', '与自家生态结合紧密，签名校验与运行时防护是重点',
             '<span class="pill warn">待核实</span> 产品线名称与归属变动频繁，以官方文档为准'],
            ['梆梆安全', 'Native 保护见长，VMP 类方案是其重点方向',
             '<span class="pill warn">待核实</span> 具体 VMP 覆盖范围与指令集形态'],
            ['爱加密', '抽取壳与 DEX2C 路线都有公开讨论，多 dex 保护较常见',
             '<span class="pill warn">待核实</span> 不同档位产品的差异'],
            ['娜迦（Nagain）', '业内常见于金融/游戏类 App，运行时防护与完整性校验较完整',
             '<span class="pill warn">待核实</span> 具体检测项清单'],
            ['顶象', '风控与设备指纹方向与加固能力结合',
             '<span class="pill warn">待核实</span> 加固模块与风控模块的边界'],
            ['阿里聚安全 / 阿里云加固', '早期广泛使用，与阿里系生态绑定',
             '<span class="pill warn">待核实</span> 当前在售形态与支持范围'],
            ['百度加固', '早期产品，公开样本较多、社区分析资料相对丰富',
             '<span class="pill warn">待核实</span> 新版是否仍在维护']
          ]) +
        '<p>把上表读成一条结论：<b>厂商之间的差别主要在三个维度上</b>——① 代际覆盖（做不做 VMP / DEX2C）；' +
        '② native 保护强度（so 是否整体加密、是否自定义 Linker）；③ 运行时防护的完整度（检测项多少、是否下沉到内核）。' +
        '<span class="hit">这三个维度恰好就是本章判定流程要回答的问题，所以你不需要背厂商表——你需要会读现象。</span></p>' +
        T.grid(2, [
          '<div class="card"><div class="card-title">🧰 特征库工具有没有用？有，但是「交叉验证」的用法</div>' +
          '<p>社区有专门做加固特征检查的开源工具（本章案例里会拆一个），它们把「so 名 / 路径 / 类名 / 正则」做成规则库，' +
          '命中率高、上手快。<b>它们擅长回答「这是谁家的」，不擅长回答「我该怎么办」。</b></p>' +
          '<p style="margin-bottom:0">正确的用法：先用它拿到一个<b>厂商先验</b>，再用结构观测去验证。' +
          '两者矛盾时，<b>永远信你自己观测到的结构</b>——因为你采的是现场证据，它采的是历史规则。</p></div>',
          '<div class="card"><div class="card-title">📉 加固方其实也在权衡</div>' +
          '<p>加固强度不是越高越好：<b>每加一层解密就多一次启动开销，每多一个 so 就多一份 ABI 适配成本</b>，' +
          '而且一旦和某个定制 ROM 冲突，损失的是真实用户。</p>' +
          '<p style="margin-bottom:0">所以同一个厂商的<b>不同 App 可能用不同档位</b>。你分析的这个样本用的方案，' +
          '不代表这个厂商的「最强能力」，只代表<b>在这个 App 的约束下它选了哪一档</b>。</p></div>'
        ]),
      quiz: {
        id: 'q19-5', chapter: 19, answer: [0, 2],
        stem: '（多选）关于「用厂商特征字符串来判定壳类型」，下面哪些说法是对的？',
        options: [
          { t: '特征字符串能给出厂商先验，但不能替代结构观测——因为它无法回答「方法体是否被抽走」这类问题', why: '正确。特征匹配回答的是「像谁」，判定要回答的是「属于哪一代、防护到什么程度」。' },
          { t: '只要特征库足够全，就可以完全依赖它来判定壳类型', why: '错误。规则库本质上是对历史样本的总结，新版本、定制版、以及「同一厂商不同档位」都会漏。' },
          { t: '同一个厂商的不同产品档位、不同版本可能使用不同方案，因此「命中某厂商」不足以推出技术路线', why: '正确。厂商内部也有分级保护，且会随版本迭代调整。' },
          { t: '因为特征会变，所以特征库工具没有使用价值', why: '错误。它作为交叉验证手段很有价值（快速确认方向），只是不能当唯一判据。' }
        ],
        explain: '<b>这道题要建立的判断是：区分「先验」与「证据」。</b><br><br>' +
          '厂商特征库是<b>先验</b>——它来自别人对历史样本的总结，命中率高但会过期，而且不携带结构信息。<br>' +
          '你自己的结构观测是<b>证据</b>——<code>class_defs_size</code> 是多少、方法体空不空、maps 里有什么，这些是你当场采到的。' +
          '证据永远优先于先验。<br><br>' +
          '<span class="hit">这条原则在真实工作里的价值：当特征库说「A 厂商」、而你的观测（结构完整、方法体空、有 native 注册）指向抽取壳时，' +
          '你要按抽取壳的流程走，而不是去搜「A 厂商怎么脱」——因为后者可能对应的是它三年前的方案。</span>'
      }
    },

    /* ============================================================ 19.11 */
    {
      h: '19.11', title: 'dex 壳的静态特征、动态特征与判定表',
      html:
        '<p>到这里，判定所需的所有零件都齐了。这一节把它们拼成<b>可执行的观察清单 + 判定表</b>：先看能零成本拿到的静态特征，' +
        '再上需要跑起来的动态特征，最后把现象组合成结论。</p>' +
        T.tbl(['静态侧观测（不装 App、不 root，成本最低）', '怎么拿', '它意味着什么'],
          [
            ['<b>APK 结构异常</b>：多 dex、<code>classes.dex</code> 异常小、<code>assets/</code> 里有体积异常的文件、<code>lib/</code> 下 so 数量与业务不符',
             '<code>unzip -l</code> / 解包看目录', '存在壳的可能性很高；<code>assets/</code> 里那个大文件往往就是加密的真 dex 或密钥'],
            ['<b>dex 体积与类数不符</b>：文件几 MB，<code>class_defs_size</code> 却是 0 或个位数',
             '读 dex 头偏移 <code>0x60</code>（第 2 章的实验给过完整解析）', '整份 dex 是密文或占位文件 → 一代壳的强特征'],
            ['<b>多 dex 且其中一份明显是引导性质</b>：类名带 <code>Stub</code> / <code>Proxy</code> / <code>Wrapper</code> 之类的语义，方法极少',
             'jadx 打开逐个 dex 看', '壳的引导 dex；业务代码还在别处或还没解密'],
            ['<b><code>AndroidManifest.xml</code> 的 <code>application:name</code> 被替换</b>，且该类不是业务方命名规范',
             '<code>apktool d</code> 后看 Manifest', '入口层被壳接管——几乎所有壳的共同特征，<b>但它区分不了代际</b>'],
            ['<b><code>attachBaseContext</code> 被覆写</b>，里面出现解密/加载/反射替换的调用',
             '在入口类里搜这个方法名', '判定加固存在的第二强证据（仅次于「方法体空」）'],
            ['<b>Java 层成片的 <code>native</code> 声明</b>，且方法名语义完整',
             'jadx 里搜 <code>native</code>', 'native 化 / DEX2C 的方向；少量 native 是正常工程，成片才是保护'],
            ['<b>字符串大面积不可读</b>（但方法体完整）',
             'jadx 里翻任意一个业务类', '字符串加密（第 5 章），<b>不是壳</b>——别把它当脱壳任务'],
            ['<b>so 无法解析</b>：没有合法 ELF 头或节表异常',
             '<code>readelf -h</code> / <code>file</code>', 'so 被整体加密 → 需要先解决「怎么拿到内存里的明文 so」']
          ]) +
        T.note('key', '🔑 静态侧的三条最强证据（其余都是辅助）',
          '<p style="margin-bottom:0">① <b>方法体空但结构完整</b> → 抽取壳（二代），最典型、最容易确认；<br>' +
          '② <b>类数为 0 或 dex 不可解析</b> → 整体加密（一代）；<br>' +
          '③ <b>Java 层成片 native + 无导出符号</b> → native 化（三代）。<br>' +
          '<span class="hit">把这三条记牢，静态侦察这一步就已经能给出主要方向了——剩下的动态观测只是用来确认和量化。</span></p>') +
        T.tbl(['动态侧观测（要跑起来，但不需要 root 的部分先做）', '怎么拿', '它意味着什么'],
          [
            ['<b><code>class_defs_size</code> 与实际可加载类数不符</b>',
             '运行时枚举 ClassLoader 里能加载的类，与静态读到的数量比', '差异大说明有运行时加载的 dex（多 dex / 动态加载 / 壳中壳）'],
            ['<b>方法体为空的比例</b>（抽取比例）',
             'dump 后统计非空方法数 ÷ 总方法数；或跑功能前后各 dump 一次做对比', '空的比例高 = 抽取壳；<b>前后对比有变化 = 抽取壳的铁证</b>'],
            ['<b><code>/proc/self/maps</code> 里的异常映射</b>：无名可执行段、<code>memfd:</code>、<code>(deleted)</code> 的 so、数据目录下的 so',
             '读 maps 并逐行分类（19.13 的实验就是把这件事做成流程）', 'native 侧有自定义加载行为 → SO 层加固；三类痕迹指向的方案还不一样'],
            ['<b>内存里的 dex 魔数命中数</b>：搜 <code>dex\\n035</code> 这类魔数（版本三位数字随系统变）',
             '扫描目标进程内存（需要 root 或注入能力）', '命中 0 处：dex 可能还没加载 / 头部被魔改；命中 1 处：一份明文 dex；命中多处：多 dex 运行时加载'],
            ['<b><code>cdex001</code> 一类的 CompactDex 魔数</b>',
             '同一轮内存扫描里一并搜', '命中说明系统在用 CompactDex（数据与指令分离），<b>你 dump 到的可能是"半份"</b>（第 12 章展开）'],
            ['<b>native 注册痕迹</b>：<code>JNI_OnLoad</code> / <code>RegisterNatives</code> 被调用',
             'hook 这两个 API（第 4 章的方法）', '关键逻辑在 native，且入口被隐藏 → 三代壳方向']
          ]) +
        T.note('warn', '⚠️ 三条采样纪律（不遵守会得出错误结论）',
          '<p>① <b>先跑功能再 dump。</b>抽取壳的完整度取决于你触发过的路径，不跑功能就 dump，等于测了个下限。<br>' +
          '② <b>同一观测至少采两次。</b>「前后对比」是区分抽取壳与残缺 dex 的唯一手段；单次采样下这两者长得一模一样。<br>' +
          '③ <b>把「可疑」和「有价值」分开记。</b>maps 里的 <code>.dex</code> 映射是<b>你的 dump 目标</b>（有价值），' +
          '<code>(deleted)</code> 的 so 是<b>壳的痕迹</b>（可疑）。<span class="hit">混在一起记，判定就会糊掉。</span></p>') +
        '<p>下面是把整套判定压缩成一条可执行流水线。八步走完，你应该能写出结论：<b>哪一代壳 + 运行时防护到什么程度 + 下一步做什么</b>。</p>',
      stage: {
        title: '半小时判定法 · 八步流水线',
        speed: 1900,
        render:
          '<div class="flow-row" style="flex-wrap:wrap;gap:7px;align-items:center">' +
            '<span class="blk" id="s1">① unzip -l</span><span class="arrow">→</span>' +
            '<span class="blk" id="s2">② jadx 看结构</span><span class="arrow">→</span>' +
            '<span class="blk" id="s3">③ 读 dex 头</span><span class="arrow">→</span>' +
            '<span class="blk" id="s4">④ 看 assets / lib</span>' +
            '<div style="width:100%;height:0"></div>' +
            '<span class="blk" id="s5">⑤ 读 Manifest 入口</span><span class="arrow">→</span>' +
            '<span class="blk" id="s6">⑥ 跑起来读 maps / 搜魔数</span><span class="arrow">→</span>' +
            '<span class="blk" id="s7">⑦ 特征库交叉验证</span><span class="arrow">→</span>' +
            '<span class="blk" id="s8">⑧ 写出结论 + 下一步</span>' +
          '</div>' +
          '<div style="margin-top:12px"><span class="pill" id="mark">点「单步」走完整条流水线</span></div>' +
          '<div class="grid3" style="margin-top:12px">' +
            '<div><div class="card-title">这一步在问什么</div><div class="small" id="c1" style="line-height:1.9;color:var(--fg-2)">—</div></div>' +
            '<div><div class="card-title">看到什么说明什么</div><div class="small" id="c2" style="line-height:1.9;color:var(--fg-2)">—</div></div>' +
            '<div><div class="card-title">这一步排除了什么</div><div class="small" id="c3" style="line-height:1.9;color:var(--fg-2)">—</div></div>' +
          '</div>',
        reset: function () {
          ['s1','s2','s3','s4','s5','s6','s7','s8'].forEach(function (i) { S(i, ''); });
          CLS('mark', 'pill'); SET('mark', '点「单步」走完整条流水线');
          SET('c1', '—'); SET('c2', '—'); SET('c3', '—');
        },
        steps: [
          { run: function () { S('s1', 'active'); SET('c1', 'APK 里到底装了什么？（文件层面的结构）'); SET('c2', '多 dex / <code>assets/</code> 下体积异常的文件 / <code>lib/</code> 下与业务不符的 so'); SET('c3', '排除了「这是一个干净的原生 APK」这个可能（但还不能定性）'); },
            note: '<b>步骤一：<code>unzip -l</code>。</b>零成本、零风险，先看目录结构。' +
              '重点不是「有什么」，而是<b>「什么不该在这儿」</b>——<span class="hit">一个 8MB 的 .bin 出现在 assets 里，比任何字符串特征都更能说明问题。</span>' },
          { run: function () { S('s1', 'done'); S('s2', 'active'); SET('c1', '静态能读到多少业务代码？'); SET('c2', '只有壳代码 / 类名齐全但方法体空 / 成片 native / 代码完整但字符串乱码'); SET('c3', '这一步直接定主要方向：一代、二代、三代，或「不是壳」'); },
            note: '<b>步骤二：jadx 看结构。</b>这是整条流水线里<b>信息量最大的一步</b>，一次点击就能定方向。' +
              '判读口诀：<b>看不到类 → 一代；看到类看不到方法体 → 二代；看到 native 或天书 → 三代；都正常只是字符串乱 → 不是壳。</b>' },
          { run: function () { S('s2', 'done'); S('s3', 'active'); SET('c1', 'dex 头怎么说？（把现象量化）'); SET('c2', '<code>class_defs_size</code> 是多少、<code>magic</code> 版本、<code>file_size</code> 与体积是否相符'); SET('c3', '排除了「文件损坏」这个借口——数字不会骗人'); },
            note: '<b>步骤三：读 dex 头（第 2 章的 112 字节实验）。</b>这一步的价值在于<b>把印象变成数字</b>：' +
              '「好像是空的」和「<code>class_defs_size = 0</code>」是两种证据强度。' +
              '<span class="hit">写报告、和别人对齐结论时，数字是唯一不会吵架的东西。</span>' },
          { run: function () { S('s3', 'done'); S('s4', 'active'); SET('c1', '密文和密钥在哪？（决定你能不能离线拿数据）'); SET('c2', '<code>assets/</code> 里的大文件、<code>lib/</code> 下的可疑 so、<code>res/</code> 里的异常资源'); SET('c3', '排除了「真 dex 必须联网才能拿到」这个最麻烦的分支（如果密文就在包里）'); },
            note: '<b>步骤四：看 <code>assets/</code> 和 <code>lib/</code>。</b>这一步决定你的<b>可行性判断</b>：' +
              '密文在包里 → 可以离线、可以反复试；密文来自服务端或由设备信息生成 → 你的脱壳流程必须能联网/能复现环境。' },
          { run: function () { S('s4', 'done'); S('s5', 'active'); SET('c1', '入口被谁接管了？'); SET('c2', '<code>application:name</code> 指向一个非业务命名的类；<code>attachBaseContext</code> 被覆写'); SET('c3', '排除了「无壳」的可能——入口被替换是加固的第二强证据'); },
            note: '<b>步骤五：读 Manifest 入口。</b>这一步的作用是<b>交叉确认</b>：如果步骤二看到方法体空、这里又看到入口被替换，' +
              '那「加固存在」这个结论就有两条独立证据支撑了。<span class="hit">判定要的不是单条铁证，而是相互独立的证据链。</span>' },
          { run: function () { S('s5', 'done'); S('s6', 'active'); SET('c1', '运行时到底把什么放进了内存？'); SET('c2', 'maps 里的异常映射 / dex 魔数命中数 / native 注册痕迹'); SET('c3', '排除了「纯静态可解」的幻想，同时给出 SO 层的判定'); },
            note: '<b>步骤六：跑起来看内存。</b>到这一步才需要设备。三件事：读 maps 并逐行分类（19.13 的实验）、' +
              '搜 dex 魔数命中数、观察 native 注册。<b>注意采样纪律：先跑功能，再采集。</b>' },
          { run: function () { S('s6', 'done'); S('s7', 'active'); SET('c1', '像谁家的做法？（先验，不是证据）'); SET('c2', '特征库命中的厂商/方案名，以及你此前未考虑过的方向'); SET('c3', '排除了「我漏看了某个已知方案」的可能——但<b>不能排除版本差异</b>'); },
            note: '<b>步骤七：特征库交叉验证。</b>用 apkid / ApkCheckPack 这类工具跑一遍。' +
              '<b>它的作用是提醒你「还有这种可能」</b>，而不是给你结论。' +
              '<span class="hit">与本步骤并列的是「搜一搜」——但要记住搜到的是别人的样本结论，你的样本未必一样。</span>' },
          { run: function () { S('s7', 'done'); S('s8', 'cool'); CLS('mark', 'pill ok'); SET('mark', '✅ 八步走完：你手里应该有一句可执行的结论'); SET('c1', '结论怎么写才可执行？'); SET('c2', '写成三段：<b>壳类型 + 运行时防护程度 + 下一步第一个动作</b>'); SET('c3', '排除了一切「我觉得像是……」的模糊表述'); },
            note: '<b>步骤八：写结论。</b>结论必须是可执行的三段式，例如：' +
              '<b>「二代抽取壳（结构完整、方法体空、native 注册）；运行时防护中等（Java 侧环境检测 + native 反调试）；' +
              '下一步：跑遍功能 + 主动调用脱壳，先拿完整 Java 层调用图。」</b><br>' +
              '<span class="hit">这样写的好处是：明天换个人接手，他不需要重新判定一遍，也知道该做什么。</span>' }
        ]
      },
      case: {
        source: 'github',
        title: 'ApkCheckPack —— apk加固特征检查工具（GitHub 仓库描述照抄：汇总收集已知特征和手动收集大家提交的app加固特征，支持40+厂商的加固检测）',
        date: '2021-06-29（仓库创建，据 GitHub API；README 自述规则库更新于 20260618）',
        author: 'moyuwa（GitHub 仓库所有者）',
        target: 'ApkCheckPack（Go 实现，命令行 <code>ApkCheckPack.exe -f &lt;APK&gt;</code>）',
        background:
          '<p>这是本章「静态特征库」这条路线的一个完整实现：把已知加固方案的<b>特征 so 路径 / so 文件名 / 其它特征文件与字符串 / ' +
          '有版本号的 so 正则 / dex 内的类名</b>整理成规则库，编译进一个 Go 二进制，扫描 APK 目录树后输出命中了谁。</p>' +
          '<p>它同时做了几件与判定相关的事：加固检测、ROOT / 模拟器 / 反调试 / 代理等<b>反环境特征</b>检测、第三方 SDK 识别、' +
          '证书扫描、硬编码扫描，并支持递归扫描内嵌 APK（XAPK 一类）。<b>规则内置在二进制里，不需要外部配置。</b></p>',
        points: [
          '加固规则的四类形态（README 原文）：<code>sopath</code> 绝对路径的特征 so、<code>soname</code> 仅特征 so 文件名、<code>other</code> 其它特征文件与字符串、<code>soregex</code> 对有版本号的特征 so 用正则、<code>jclass</code> dex 内类名字符串匹配。',
          'README 自述支持检测的厂商（照录，未做删改）：360、百度、网易、盛大、CFCA、中国移动、通付盾、海云安、启明星辰、顶像科技、珊瑚灵御、瑞星、深盾安全、网秦、UU安全、蛮犀、能信安、DexProtect、Google Play、LIAPP 等 —— 厂商名后带「等」，说明列表本身是开放的。',
          'README 自述<b>加固规则更新时间 20260618</b>、第三方 SDK 规则更新时间 20260111 —— 也就是规则库有明确的时间戳，这意味着「命中」的结论天然带保质期。',
          '命令行参数覆盖了检测开关：<code>-root</code> / <code>-emu</code> / <code>-debug</code> / <code>-proxy</code> / <code>-sdk</code> / <code>-cert</code> 默认开启，<code>-hardcode</code> 默认关闭，<code>-maxsize</code> 默认 500（MB），<code>-r</code> 递归扫描内嵌 APK。',
          '仓库元数据（GitHub API，抓取时 HTTP 200）：创建于 2021-06-29，默认分支 <code>main</code>，语言 Go，未声明 license。'
        ],
        method: [
          '<b>第一步：收集特征。</b>作者的做法是「汇总已知特征 + 手动收集大家提交的 app 加固特征」——规则来自公开资料与社区投稿，而不是对每个厂商做完整逆向。',
          '<b>第二步：把特征分成可匹配的形态。</b>按「绝对路径 / 文件名 / 其它文件与字符串 / 带版本号的正则 / dex 内类名」五类落地，这样同一家厂商的多个版本可以共用一条正则。',
          '<b>第三步：编译进二进制。</b>规则不放在外部配置文件里，随程序一起分发，避免「规则和程序版本不匹配」这类问题。',
          '<b>第四步：扫描时同时输出「命中厂商」与「反环境特征」。</b>后者（ROOT / 模拟器 / 反调试 / 代理）是运行时防护那一维度的静态近似。',
          '<b>第五步：对未识别的样本开放投稿。</b>README 明确欢迎提交规则或提供无法识别的加固样本 —— 这等于承认「规则库的覆盖率是靠持续输入维持的」。'
        ],
        result:
          '<p>工具能对一份 APK 输出：命中的加固方案、反环境特征、第三方 SDK、证书信息，并支持批量目录与内嵌 APK 递归扫描。' +
          '对「这是谁家的加固」这个问题，它能给出一个快速的先验答案。</p>',
        terms: ['加固特征库', 'YARA / 正则匹配', 'so 特征名', 'dex 类名匹配', '反环境检测', 'XAPK 内嵌 APK', 'Go 单文件分发'],
        limits:
          '<p>作者在 README 结尾自述的局限只有一句话，但信息量很足，照录如下：</p>' +
          '<p><b>「工具只是辅助，新方式和厂商不断出现，特征查找方式可能遗漏，切勿完全依赖。」</b></p>' +
          '<p>与这句并列的两条自述性质的信息也照录：① README 写明「欢迎提交规则，或提供无法识别的加固样本，争取持续更新」——' +
          '说明规则覆盖率依赖社区投稿；② 规则库带明确更新时间（加固规则 20260618），<b>意味着任何「未命中」都不能当作「未加固」的证据</b>。</p>' +
          '<p>另需说明：仓库未声明开源许可证（GitHub API 的 <code>license</code> 字段为空），使用前应自行确认授权范围。</p>',
        analysis:
          '<p><b>用本章方法论拆解：这个项目恰好落在 19.10 讲的那条纪律上——特征库是「先验」，不是「证据」。</b></p>' +
          '<p>看它的规则形态就知道边界在哪：<code>sopath</code> / <code>soname</code> / <code>soregex</code> / <code>jclass</code> / <code>other</code> ' +
          '全部是<b>字符串与文件名层面的匹配</b>。这类匹配能回答「像谁」，但<b>无法回答结构问题</b>——' +
          '它不会告诉你 <code>class_defs_size</code> 是多少、方法体空的比例有多大、maps 里有没有 <code>(deleted)</code> 的 so。' +
          '<span class="hit">也就是说，它能给判定流程的<b>第 ⑦ 步</b>提供输入，但替代不了第 ②③④⑥ 步。</span></p>' +
          '<p>第二点值得学的是<b>作者对自己工具的定位</b>。他没有写「支持 40+ 厂商检测，可替代人工分析」，而是写「工具只是辅助……切勿完全依赖」。' +
          '对照 19.10 讲的三条理由（会变 / 会互相抄 / 会误导判定），这句话是把第一条和第二条直接承认下来了：' +
          '<b>规则库必然滞后于新版本，而且规则来源是社区投稿，质量参差</b>。教材里评价一个工具时，也应该照这个口径——' +
          '说清它在流程里的位置，而不是给它一个「准不准」的总评。</p>' +
          '<p>第三点是一个可以直接搬走的工程习惯：<b>给规则库打时间戳</b>。README 里「加固规则更新时间 20260618」这一行，' +
          '让你的每一条「命中」结论都自动带上保质期。<span class="hit">判定结论必须可回溯、可过期——这是做安全分析报告时的基本卫生。</span></p>',
        link: 'https://github.com/moyuwa/ApkCheckPack',
        linkNote: 'GitHub 仓库（收录时以 web_fetch 取到 README 全文，并另取 GitHub API 元数据核对创建时间与语言）'
      }
    },

    /* ============================================================ 19.12 */
    {
      h: '19.12', title: '动手实验：壳类型判定器',
      html:
        '<p>这一节把 19.11 的判定表做成一台机器：你填入 6 项观测值，它按<b>真实规则表</b>给每个壳类型假设打分、列出触发了哪些证据，' +
        '然后由你写出结论，系统用「结论关键词」判分。</p>' +
        T.note('key', '🔑 为什么不是「查表得答案」',
          '<p style="margin-bottom:0">因为真实的判定从来不是单条现象决定的：<b>同一个现象在不同组合下含义相反</b>。' +
          '比如「<code>class_defs_size = 0</code>」单独看只是「dex 不可解析」，配上「内存里却有一处明文 dex 魔数」就变成一代壳的强证据；' +
          '配上「内存里也搜不到任何 dex 魔数」则可能是「还没加载」或「头部被魔改」。' +
          '<span class="hit">这台机器评的是<b>证据组合</b>，所以它给的是分数排序 + 证据清单，而不是一句断言。</span></p>'),
      lab: {
        title: '实验：壳类型判定器（6 项观测 → 排序 + 证据链）',
        goal: '目标：按真实规则表推出壳类型与下一步',
        intro:
          '<p>下面已经预填了一组观测值（<b>你可以改，结论会跟着变</b>）：APK 里 2 份 dex、' +
          '<code>classes.dex</code> 的 <code>class_defs_size</code> 是 0、内存里搜到 1 处 dex 魔数、' +
          '入口 <code>attachBaseContext</code> 被覆写、未见 native 注册，maps 片段里藏了 4 条可疑映射。</p>' +
          '<p><b>任务：</b>① 点「运行」看规则表算出来的排序和证据链；② 在最后一栏写下<b>你的结论</b>——' +
          '要写清「这是哪一类壳」和「下一步第一个动作是什么」。</p>',
        inputs: [
          { key: 'dexCount', label: '① APK 里的 dex 份数', hint: 'unzip -l 数一下', ph: '例如 2', value: '2' },
          { key: 'classDefs', label: '② classes.dex 的 class_defs_size', hint: 'dex 头偏移 0x60（第 2 章实验给过解析）', ph: '例如 0 或 573', value: '0' },
          { key: 'magicHits', label: '③ 内存里搜 dex 魔数命中几处', hint: '搜 dex\\n035 一类魔数（需要 root 或注入能力）', ph: '例如 1', value: '1' },
          { key: 'attach', label: '④ attachBaseContext 是否被覆写（是/否）', hint: '看入口 Application 有没有覆写它', ph: '是 / 否', value: '是' },
          { key: 'nativeReg', label: '⑤ 有没有 native 动态注册痕迹（是/否）', hint: 'JNI_OnLoad / RegisterNatives（第 4 章）', ph: '是 / 否', value: '否' },
          { key: 'maps', label: '⑥ /proc/self/maps 片段（可留空，但强烈建议填）', hint: '格式：起址-止址 权限 偏移 dev inode 路径', type: 'textarea', rows: 7, value: PACK19_MAPS_SAMPLE },
          { key: 'verdict', label: '⑦ 你的结论：哪一类壳 + 下一步第一个动作', hint: '要能直接执行，不要写「疑似可能大概」', type: 'textarea', rows: 3, ph: '例如：这是一代……壳，下一步应该先……' }
        ],
        runLabel: '🔍 运行判定器',
        autorun: true,
        run: function (v) {
          var r = pack19Judge(v);
          var html = '<div class="lab-kv">' +
            '<span>观测：dex <b>' + r.obs.dexCount + '</b> 份</span>' +
            '<span>class_defs_size <b>' + r.obs.classDefs + '</b></span>' +
            '<span>魔数命中 <b>' + r.obs.magicHits + '</b> 处</span>' +
            '<span>attachBaseContext 覆写 <b>' + (r.obs.attach ? '是' : '否') + '</b></span>' +
            '<span>native 注册 <b>' + (r.obs.nativ ? '有' : '无') + '</b></span>' +
            '<span>maps 可疑行 <b>' + r.ms.suspicious.length + '</b> / 共解析 <b>' + r.ms.total + '</b> 行</span></div>';

          html += '<table class="lab-tbl"><tr><th>壳类型假设</th><th>分数</th><th>占比</th><th>触发的证据（规则命中）</th></tr>';
          for (var i = 0; i < r.rank.length; i++) {
            var h = r.rank[i];
            var cls = i === 0 && h.score > 0 ? ' class="diff"' : '';
            html += '<tr' + cls + '><td style="font-family:var(--sans);font-size:13px">' + h.name + '</td>' +
              '<td>' + h.score + '</td><td>' + h.pct + '%</td>' +
              '<td style="font-family:var(--sans);font-size:13px;line-height:1.75">' +
              (h.ev.length ? h.ev.map(function (e) { return '· ' + e; }).join('<br>') : '<span class="muted">未命中任何规则（证据不足）</span>') +
              '</td></tr>';
          }
          html += '</table>';

          if (r.top.score === 0) {
            html += '<div class="lab-msg warn"><b>⚠️ 没有任何假设拿到分数</b><div class="lab-note">' +
              '说明你的观测值互相矛盾或过于笼统。先把第 ②③ 两项填准（它们是权重最高的证据），再看排序。</div></div>';
          } else {
            html += '<div class="lab-msg key"><b>🎯 当前排序第一：' + r.top.name + '（' + r.top.pct + '%）</b>' +
              '<div class="lab-note"><b>下一步动作：</b>' + r.top.next + '</div>' +
              (r.tight ? '<div class="lab-note">⚠️ 第一名与第二名的分差只有 ' + (r.top.score - r.second.score) +
                ' 分（' + r.second.name + '）。这是<b>证据不足</b>的典型信号：别急着定路线，先补观测（maps、魔数扫描、native 注册三选二）。</div>' : '') +
              '</div>';
          }
          html += '<div class="lab-msg model"><b>📐 规则表是怎么算的（可复现）</b><div class="lab-note">' +
            '每一条规则都是「观测 → 假设 + 权重 + 理由」，权重是我按<b>判别力</b>定的（结构性证据 > 统计性证据 > 存在性证据）：' +
            '例如「类数为 0 却有明文 dex」是 3 分（强），「多 dex」是 1 分（弱，正常 App 也会分包）。' +
            '你把上表任何一条 <code>class_defs_size</code> 改成 500 再运行一次，能看到排序整体翻转 —— ' +
            '<b>这就是「同一现象在不同组合下含义相反」的现场演示。</b></div></div>';
          return html;
        },
        expected: function (v) {
          var r = pack19Judge(v);
          var text = String(v.verdict || '');
          var keys = PACK19_KEYS[r.top.id] || PACK19_KEYS.none;
          if (text.replace(/\s/g, '').length < 12) {
            return { ok: false, detail: '结论太短了。判定结论至少要说清两件事：<b>这是哪一类壳</b>，以及<b>下一步第一个动作</b>。' };
          }
          var typeOk = window.AKKC_hasConcept(text, keys.type);
          var nextOk = window.AKKC_hasConcept(text, keys.next);
          var ok = typeOk && nextOk;
          return {
            ok: ok,
            detail: '当前规则表算出的第一假设是：<b>' + r.top.name + '</b>（' + r.top.pct + '%，分差 ' +
              (r.second ? (r.top.score - r.second.score) : r.top.score) + '）。<br>' +
              (typeOk ? '✅ 壳类型判定正确。' : '❌ 壳类型没说对（或说得太笼统）。可以写：' + keys.type.slice(0, 3).join(' / ') + ' 一类表述。') + '<br>' +
              (nextOk ? '✅ 下一步动作说到了点子上。' : '❌ 下一步动作缺失或跑偏。这一类壳该做的第一件事是：' + r.top.next)
          };
        },
        showAnswer:
          '【判定原则（比答案更重要）】\n' +
          '  判定 = 证据组合，不是单条现象。权重排序：\n' +
          '    结构性证据（最高）：类数为 0 却有明文 dex / 结构完整但方法体空\n' +
          '    统计性证据（中）：魔数命中处数、maps 里可疑映射的条数\n' +
          '    存在性证据（最低）：多 dex、入口被覆写、有 native 注册\n\n' +
          '【预填场景的结论】\n' +
          '  观测：2 份 dex；class_defs_size = 0；内存里 1 处 dex 魔数；\n' +
          '        attachBaseContext 被覆写；无 native 注册；maps 里 4 条可疑行\n' +
          '  规则命中（按权重）：\n' +
          '    · class_defs_size = 0 且 APK 里有 dex        → gen1 +3\n' +
          '    · 类数为 0 但内存里存在明文 dex              → gen1 +2\n' +
          '    · attachBaseContext 被覆写                   → gen1 +2 / gen2 +2\n' +
          '    · maps 里有无名可执行段                      → gen1 +2 / gen3 +1\n' +
          '    · maps 里有 memfd 映射                       → gen1 +2 / gen3 +2\n' +
          '    · maps 里有 (deleted) 的 so                  → gen3 +2 / gen1 +1\n' +
          '    · 多 dex                                     → gen2 +1\n' +
          '    · maps 里有 .dex 映射                        → gen2 +2\n' +
          '  排序第一：一代壳（整体加密 / 文件重定向）\n' +
          '  下一步：找 dump 时机 —— 在「真 dex 已被解密进内存、且 ART 已经接管」\n' +
          '          的那一刻抓 dex 区间；同时确认它是纯内存加载还是落地后加载。\n\n' +
          '【把 ② 改成 500 再看一次】\n' +
          '  同样的 maps、同样的 attach 覆写，排序第一会变成抽取壳（二代）——\n' +
          '  因为「结构完整」这个事实把「整份加密」这个假设按了下去。\n' +
          '  这就是判定器存在的意义：它演示的是规则，不是答案。',
        hint:
          '<b>先看权重最高的两条结构性证据。</b><br>' +
          '① <code>class_defs_size</code>：0 说明静态那份 dex 里<b>没有类定义</b>（整体加密或占位）；几百以上说明<b>结构完整</b>（那就该往抽取壳方向想）。<br>' +
          '② 内存里的 dex 魔数命中数：<b>0 处</b>说明连明文 dex 都没有；<b>1 处</b>说明解密过一次；<b>多处</b>说明运行时加载了多份。<br><br>' +
          '把这两条组合起来看，方向基本就定了。maps 与 native 注册是<b>决定往哪条路走</b>的补充证据。',
        after:
          T.note('ok', '✅ 实验的收获',
            '<p style="margin-bottom:0">你现在拥有的不是一张对照表，而是一台<b>能解释自己判断依据</b>的机器：' +
            '每一条结论后面都拖着证据链。<span class="hit">这在实战里比结论本身更重要——' +
            '因为结论要给别人看、要经得起追问，而证据链是唯一能回答「你凭什么这么说」的东西。</span></p>')
      },
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一',
            scenario: '<b>情境：</b>你收到一个 APK：只有一份 <code>classes.dex</code>，<code>class_defs_size</code> 读到 <b>0</b>，' +
                      '但 APK 体积 30MB，其中 <code>assets/</code> 下有一个 8MB 的 <code>xxxx.bin</code>。' +
                      '用 jadx 打开只看到几个和业务无关的类。',
            q: '你第一步做什么？',
            choices: [
              { t: '判定「这个包的业务代码被删了/是个空包」，回去让业务方重新提供一个包', next: 'n1' },
              { t: '先确认 assets 里那个 .bin 是不是加密的 dex，然后用内存 dump 找解密后的明文 dex', next: 'n2' },
              { t: '直接上 FART 一类的主动调用工具，先把方法体 dump 出来', next: 'n3' },
              { t: '用 apktool 重新打包一份没有加固的 APK', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'bad',
            verdictTitle: '证据就在你手上，你却没读它',
            result: '<b>30MB 的包 + 8MB 的 assets 文件 + 类数为 0</b>，这三条放在一起已经是很清楚的信号了：' +
              '业务代码没被删，它被<b>换了个位置并且加了密</b>。<br><br>' +
              '判据很简单：如果业务代码真的被删了，谁会把一个 8MB 的无意义文件打进包里？' +
              '<span class="hit">「体积和类数不符」是一代壳最典型的指纹——内容有多重，说明它就在那里，只是你还没解开。</span><br><br>' +
              '回去要包只会浪费一轮沟通：对方给你的还是同一个加壳产物。'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'good',
            verdictTitle: '正确：先确认密文的性质，再决定在哪一层取货',
            result: '<b>这是正确顺序。</b>先做两件零成本的事：<br>' +
              '① 看 <code>xxxx.bin</code> 的头部有没有 <code>dex\\n</code> 魔数（有 → 没加密，只是重定向；没有 → 大概率被加密）；<br>' +
              '② 看它的熵值/字节分布像不像压缩或加密数据（这也决定你要不要去猜算法）。<br><br>' +
              '确认是加密数据之后，你的目标就从「找文件」变成「<b>找解密那一刻的内存</b>」——' +
              '这正是 19.4 那条启动链路里第 5 步的窗口。<br><br>' +
              '<b>注意这里的关键判断：</b>先别急着写脱壳脚本，先确认密文<b>在不在包里</b>。' +
              '如果在包里，你的整个流程可以离线、可重复；如果不在（服务端下发），你后面每一步都要多考虑一个环境变量。'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '工具用在了错误的代际上',
            result: '<b>主动调用解决的是「方法体为空」，不解决「整份加密」。</b><br><br>' +
              '主动调用的前提是：你手上已经有一个<b>被 ART 加载过的 DexFile</b>，里面有类、有方法，只是方法体被抽走了。' +
              '而现在的观测是 <code>class_defs_size = 0</code>——<span class="hit">连 DexFile 都不存在，你遍历什么？</span><br><br>' +
              '结果只会是：工具跑完、什么也没拿到，你还得回头做「找 dump 时机」这件事，白白花掉半天。<br><br>' +
              '这就是本章判定环节的直接价值：<b>先分类，再选工具。</b>'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '方向性误解：重打包不会解出加密内容',
            result: '<code>apktool</code> 做的是<b>解码 APK 的结构</b>（资源、Manifest、smali），' +
              '它不会、也无法解密壳在运行时才解开的密文。<br><br>' +
              '你重新打包出来的 APK 里，<code>assets/xxxx.bin</code> 还是那个 8MB 的密文，' +
              '而且因为签名变了 + smali 被重编，反而更容易触发完整性校验。<br><br>' +
              '<b>一个有用的区分：</b>apktool 能解开的只有「结构层」（资源、Manifest、明文的 dex）；' +
              '解密属于「运行时层」，必须在进程里解决。<span class="hit">工具的能力边界不清楚，就会把时间花在不可能成立的路径上。</span>'
          }
        }
      }
    },

    /* ============================================================ 19.13 */
    {
      h: '19.13', title: '动手实验：从 /proc/self/maps 里挑出可疑映射',
      html:
        '<p>maps 是动态判定里<b>性价比最高的一个观测点</b>：一次读取就能同时看到「壳的痕迹」和「你的目标」。' +
        '但它也是误报重灾区——ART 自己的 JIT 缓存就长得非常可疑（<code>rwx</code> + 匿名）。' +
        '这个实验把「逐行分类」这件事做一遍。</p>' +
        T.note('warn', '⚠️ 读 maps 前先记住三条对照关系',
          '<p style="margin-bottom:0">① <b>正常但极像可疑：</b><code>[anon:dalvik-jit-code-cache]</code> 是 <code>rwx</code> 的、' +
          '<code>[anon:libc_malloc]</code> 是无路径的 —— 它们都是 ART/分配器的合法映射，<b>看名字就能排除</b>；<br>' +
          '② <b>可疑但不是「壳」：</b><code>/data/app/</code> 下的 so 是 APK 自带的（正常），' +
          '<code>/data/data/</code> 下的 so 才是「运行时落地后加载」的（可疑）—— <b>只差一层路径，含义完全不同</b>；<br>' +
          '③ <b>有价值但不是「可疑」：</b>maps 里的 <code>.dex</code> 映射是你的 dump 目标，' +
          '<span class="hit">把它当「可疑」记下来，你的判定结论就会从「抽取壳」歪成「内存加载型壳」。</span></p>'),
      lab: {
        title: '实验：逐行判定 maps 片段（4 条可疑 + 3 条误报陷阱）',
        goal: '目标：按真实规则逐行分类',
        intro:
          '<p>下面是一段教学构造的 maps 片段（<b>格式与真实一致</b>，行数精简过）。里面混了：系统库、ART 自身的匿名映射、' +
          'APK 自带的 so、内存里被映射的 dex，以及 4 条真正可疑的映射。</p>' +
          '<p><b>任务：</b>① 点「运行」看逐行分类与依据；② 填出所有<b>可疑行的行号</b>；' +
          '③ 指出<b>哪一行最能说明「so 是从内存里加载的」</b>；④ 用一两句话说清这些痕迹指向什么加载方式。</p>',
        inputs: [
          { key: 'maps', label: 'maps 片段', hint: '可以直接改，判分会跟着变', type: 'textarea', rows: 13, value: PACK19_MAPS_SAMPLE },
          { key: 'lines', label: '① 可疑行的行号', hint: '逗号分隔，例如 5,8', ph: '例如 5,8,9,11', value: '' },
          { key: 'keyLine', label: '② 哪一行最能说明「so 是从内存里加载的」', hint: '给一个行号', ph: '例如 8', value: '' },
          { key: 'why', label: '③ 这些痕迹指向什么加载方式？为什么？', type: 'textarea', rows: 3, ph: '例如：说明它不走系统加载器，而是……', value: '' }
        ],
        runLabel: '🔍 逐行判定',
        autorun: false,
        run: function (v) {
          var rows = pack19Maps(v.maps || '');
          var st = pack19MapsStat(v.maps || '');
          if (!rows.length) return '<div class="lab-msg warn">先贴入一段 maps 内容。</div>';
          var html = '<div class="lab-kv"><span>解析 <b>' + st.total + '</b> 行</span>' +
            '<span>可疑 <b>' + st.suspicious.length + '</b> 行</span>' +
            '<span>ART 合法映射 <b>' + st.art + '</b></span>' +
            '<span>系统/APK 库 <b>' + st.normal + '</b></span>' +
            '<span>dex 映射 <b>' + st.dex + '</b></span>' +
            '<span>格式非法 <b>' + st.bad + '</b></span></div>';
          html += '<table class="lab-tbl"><tr><th>行</th><th>权限</th><th>路径</th><th>判定</th><th>依据</th></tr>';
          for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            html += '<tr' + (r.suspicious ? ' class="diff"' : '') + '><td>' + r.ln + '</td><td>' + r.perm + '</td>' +
              '<td style="font-family:var(--mono);font-size:11.5px">' + (r.path || '(无名)') + (r.deleted ? ' (deleted)' : '') + '</td>' +
              '<td style="font-family:var(--sans);font-size:12.5px">' + (r.suspicious ? '⚠️ ' : '') + r.label + '</td>' +
              '<td style="font-family:var(--sans);font-size:12.5px;line-height:1.7">' + r.why + '</td></tr>';
          }
          html += '</table>';
          html += '<div class="lab-msg key"><b>📊 这一类样本告诉你的三件事</b><div class="lab-note">' +
            '① <b>无名可执行段 ' + st.anonExec + ' 处</b>：运行时才产生的代码页 —— 可能来自壳，也可能来自 JIT，<b>要结合权限与相邻映射判断</b>；<br>' +
            '② <b>自删的 so ' + st.deleted + ' 处 + memfd ' + st.memfd + ' 处</b>：这两条是<b>内存加载</b>的强证据，' +
            '磁盘上找不到、文件系统里没有，只有进程自己知道；<br>' +
            '③ <b>被映射的 dex ' + st.dex + ' 处</b>：这是你的 dump 目标，不是「壳的痕迹」。' +
            '<span class="hit">把「可疑」和「有价值」分开记，是这一节最想让你养成的习惯。</span></div></div>';
          return html;
        },
        expected: function (v) {
          var rows = pack19Maps(v.maps || '');
          var truth = [];
          for (var i = 0; i < rows.length; i++) if (rows[i].suspicious) truth.push(rows[i].ln);
          var got = String(v.lines || '').split(/[^0-9]+/).filter(function (s) { return s !== ''; })
            .map(Number).filter(function (n, k, a) { return a.indexOf(n) === k; }).sort(function (a, b) { return a - b; });
          var miss = truth.filter(function (x) { return got.indexOf(x) < 0; });
          var extra = got.filter(function (x) { return truth.indexOf(x) < 0; });
          var setOk = got.length > 0 && miss.length === 0 && extra.length === 0;
          var key = parseInt(String(v.keyLine || '').replace(/[^0-9]/g, ''), 10);
          var keyFloor = null;
          for (var j = 0; j < rows.length; j++) {
            if (rows[j].kind === 'deleted' || rows[j].kind === 'memfd') { keyFloor = rows[j].ln; break; }
          }
          var keyOk = !isNaN(key) && keyFloor !== null && key === keyFloor;
          if (!isNaN(key) && !keyOk) {
            for (var k2 = 0; k2 < rows.length; k2++) {
              if (rows[k2].ln === key && (rows[k2].kind === 'deleted' || rows[k2].kind === 'memfd')) keyOk = true;
            }
          }
          var whyOk = window.AKKC_hasConcept(v.why, ['内存加载', '内存里加载', '自删', '删除', '匿名', 'memfd', '自定义', 'linker', '不落地', 'dlopen', '映射', '解密']);
          var ok = setOk && keyOk && whyOk;
          return {
            ok: ok,
            detail: (setOk ? '✅ 可疑行找全了：<code>' + truth.join(', ') + '</code>。'
                           : '❌ 可疑行不对。' + (miss.length ? '漏了：<code>' + miss.join(', ') + '</code>。' : '') +
                             (extra.length ? '多算了：<code>' + extra.join(', ') + '</code>（回去看它的判定与依据——多半是 ART 合法映射或你的 dump 目标）。' : '')) + '<br>' +
              (keyOk ? '✅ 关键那条抓准了。' : '❌ 第 ② 问：能说明「从内存里加载」的是 <code>(deleted)</code> 的 so（' +
                (keyFloor === null ? '本片段里没有' : keyFloor) + ' 行）或 <code>memfd</code> 那行——它们表示<b>文件系统里没有可回溯源</b>。') + '<br>' +
              (whyOk ? '✅ 加载方式说对了：不是走系统加载器从磁盘加载，而是运行时造内存/落地后自删再加载。'
                     : '❌ 第 ③ 问还差一点。关键词方向：<b>内存加载 / 自删 / memfd / 自定义 linker / 不落地 / dlopen</b>，任选一个说清即可。')
          };
        },
        showAnswer:
          '【① 可疑行】把每一行按「权限 + 路径 + 是否自删」三条一起看：\n\n' +
          '  第 4 行  rwxp  [anon:dalvik-jit-code-cache]     → 正常（ART 的 JIT 代码缓存，合法 rwx）\n' +
          '  第 5 行  r-xp  （无名）                          → 可疑：没有路径也没有名字，却有执行权限\n' +
          '  第 6 行  r-xp  /data/app/.../libnative.so        → 正常（APK 自带 so）\n' +
          '  第 7 行  rw-p  [anon:libc_malloc]                → 正常（分配器的匿名映射，且不可执行）\n' +
          '  第 8 行  r-xp  /data/data/.../libpayload.so (deleted) → ★可疑：数据目录 + 已删除却仍在映射\n' +
          '  第 9 行  rwxp  （无名）                          → 可疑：无名 + 同时可写可执行\n' +
          '  第 10 行 r--p  /data/data/.../00000000.dex       → 有价值（不是壳的痕迹，是你的 dump 目标）\n' +
          '  第 11 行 r-xp  /memfd:payload (deleted)          → 可疑：memfd 匿名内存文件\n' +
          '  第 12 行 rw-p  [anon:dalvik-main space]          → 正常（ART 的 GC 空间）\n' +
          '  第 13 行 r--p  /dev/ashmem                       → 正常（无执行权限）\n\n' +
          '  答案：5、8、9、11 四行。\n\n' +
          '【② 最能说明「从内存加载」的一行】\n' +
          '  第 8 行：/data/data/.../libpayload.so (deleted)\n' +
          '  理由：so 出现在数据目录（说明是运行时落地的），而且文件已被删除、映射仍然存在\n' +
          '        —— 文件系统里已经没有任何可回溯源。这不是系统加载器的行为。\n' +
          '  第 11 行（memfd）同样成立，而且更彻底：它从头到尾就没有落地过。\n\n' +
          '【③ 指向的加载方式】\n' +
          '  native 侧存在自定义加载逻辑：不走系统加载器从磁盘 dlopen，\n' +
          '  而是「解密到内存 → 落地后立即删除」或「写进 memfd → dlopen」。\n' +
          '  判定含义：SO 层做了整体加密或内存加载 → 需要先解决「怎么拿到内存里的明文 so」，\n' +
          '  再谈静态分析。两份被映射的 rwx/无名可执行段是它的执行痕迹。\n\n' +
          '【④ 别忘了排除误报】\n' +
          '  ART 的 JIT 代码缓存是 rwx 的、分配器映射是无名的 —— 这也是这份样本里\n' +
          '  第 4、7、12 行存在的意义：它们让你练习「先看名字再下判断」。',
        hint:
          '<b>三条判据按顺序过，一条不过就放下：</b><br>' +
          '① 这行有<b>执行权限</b>吗（权限串里有 <code>x</code>）？没有 → 基本可以放过。<br>' +
          '② 它有<b>名字或路径</b>吗？名字是 <code>[anon:dalvik...]</code> 一类 → 是 ART 自己建的，放过。<br>' +
          '③ 它的路径在<b>哪里</b>？<code>/system</code> / <code>/apex</code> / <code>/data/app</code> → 正常；' +
          '<code>/data/data</code> 或没有路径 → 可疑。<br><br>' +
          '另外注意行尾的 <code>(deleted)</code> 和 <code>memfd:</code> 前缀 —— 这两个词直接等于「文件系统里没有」。',
        after:
          T.note('ok', '✅ 实验的收获',
            '<p style="margin-bottom:0">你现在能拿着一份 maps 说清三件事：<b>哪些是壳的痕迹、哪些是 ART 的正常行为、哪一块是我的 dump 目标。</b><br>' +
            '这个能力在第 10 章（反 Frida 的 maps 过滤）和第 13 章（内核层观测）里会直接复用——' +
            '<span class="hit">过滤脚本写得好不好，取决于你能不能分清「该删的」和「不该动的」。</span></p>')
      },
      term: {
        title: '一次完整的静态侦察会话（命令 + 该看什么）',
        lines: [
          { t: 'd', s: '# ── 第一轮：静态看结构（零成本，先做） ──' },
          { t: 'p', s: 'unzip -l target.apk' },
          { t: 'o', s: '  classes.dex   classes2.dex   assets/xxxx.bin   lib/arm64/libxxx.so   res/...', note: '<b>看三件事：</b>dex 有几份、<code>assets/</code> 下有没有体积异常的文件、<code>lib/</code> 下的 so 数量与业务是否相称。<b>这一步不需要任何工具链，却常常给出最关键的方向。</b>' },
          { t: 'p', s: 'unzip -p target.apk classes.dex | xxd | head -2' },
          { t: 'o', s: '00000000: 6465 780a 3033 3900 0000 0000 ...', note: '<b>看魔数。</b><code>64 65 78 0a</code> 就是 <code>dex\\n</code>。是标准魔数 → 至少这份是明文 dex；不是 → 要么被加密，要么是 CompactDex/魔改（<code>cdex001</code> 一类）。<span class="pill warn">待核实</span> 三位版本数字与 CompactDex 魔数随安卓版本变化，以实测为准。' },
          { t: 'p', s: 'apkid target.apk' },
          { t: 'o', s: '[*] target.apk!classes.dex\n |-> compiler : dx\n |-> packer   : <命中某加固方案>', note: '<b>特征库交叉验证。</b>它靠 YARA 规则匹配编译器/壳/混淆器，输出格式就是「文件 → 命中项」。<b>记住它的定位：给先验，不给结论</b>（19.10 讲的三条理由）。命中的方案名随规则版本变化。' },
          { t: 'p', s: 'apktool d -f -o out target.apk && grep -o \'application[^>]*\' out/AndroidManifest.xml | head -3' },
          { t: 'o', s: 'android:name="com.xxxx.StubApplication"', note: '<b>入口被替换了。</b>业务方的 Application 类名不会长这样。<b>这是「加固存在」的第二强证据</b>（第一强是方法体为空）。' },
          { t: 'd', s: '' },
          { t: 'd', s: '# ── 第二轮：跑起来看内存（到这一步才需要设备） ──' },
          { t: 'p', s: 'adb shell "pidof com.target.app"' },
          { t: 'o', s: '12345', note: '<b>先拿到 pid。</b>注意：很多加固会做反调试/反注入，<b>用调试器附加本身就可能触发检测</b>——所以第二轮的前置问题往往不是"怎么读"，而是"怎么不被发现地读"（第 10、13 章）。' },
          { t: 'p', s: 'adb shell "cat /proc/12345/maps | grep -E \'(deleted|memfd|\\.dex)\'"' },
          { t: 'o', s: '7f9c700000-7f9c711000 r-xp ... /data/data/com.target.app/files/libpayload.so (deleted)' },
          { t: 'o', s: '7f9c900000-7f9c906000 r--p ... /data/data/com.target.app/cache/00000000.dex' },
          { t: 'o', s: '7f9ca00000-7f9ca02000 r-xp ... /memfd:payload (deleted)', note: '<b>三条证据同时到齐：</b>自删的 so、被映射的 dex、memfd。<br>· 自删 so + memfd → <b>SO 层做了内存加载</b>；<br>· 被映射的 dex → <b>你已经有一个可 dump 的目标</b>，注意它不是"壳的痕迹"而是"你的战利品"。' },
          { t: 'w', s: '↑ 内存搜索 dex 魔数需要 root 或注入能力（示意，不是单条命令能完成的事）', note: '<b>把这一条当成提醒：</b>凡是写着"扫一下内存就知道了"的说法，都要补一句前提——<b>你需要先有读那块内存的能力</b>。而这个能力本身，正是运行时防护要拦的东西。' },
          { t: 'd', s: '' },
          { t: 'd', s: '# ── 第三轮：把结论写下来（这一步最容易被跳过，却最值钱） ──' },
          { t: 'o', s: '结论：二代抽取壳（结构完整/方法体空/native 注册）；SO 层做了内存加载；运行时防护中等。下一步：先跑遍功能，再主动调用脱壳。', note: '<b>三段式结论：壳类型 + SO/防护程度 + 下一步第一个动作。</b>写成这样，明天换人接手不用重新判定。' }
        ]
      }
    },

    /* ============================================================ 19.14 */
    {
      h: '19.14', title: '壳的动态加载与 dump 后的修复：为什么「全空」不等于「脱不了」',
      html:
        '<p>19.4 讲了一代壳的加载链路（解密 → 加载 → 反射替换）。抽取壳的加载链路<b>多了两个动作</b>：' +
        '在「反射替换」之后还要挂上回填逻辑（通常是 native 侧拦截方法调用），并在方法首次执行时把指令写回 code item。' +
        '<span class="hit">判定时必须把这两条链路分开：<b>你拿到的 dex 是「加载时的那份」还是「回填后的那份」？</b></span></p>' +
        T.tbl(['dump 得到的东西', '它是什么', '你看到的现象', '该怎么办'],
          [
            ['解密后、加载前的原始数据', '壳的中间产物，没有 DexFile 结构', 'jadx 直接拒绝：没有合法魔数或结构损坏', '这不是失败的产物，是「dump 早了」——把观测点后移到加载完成之后'],
            ['加载后、回填前的 dex', 'ART 已接管，结构完整，方法体空', '<b>能打开、类名齐全、方法体全空</b>', '「dump 早了」的第二种形态：先触发回填（跑功能 / 主动调用），再 dump'],
            ['回填后的 dex', '方法体已被写回', '部分方法有内容，非空比例取决于你触发了多少路径', '✅ 这才是目标产物；接下来是修复（校验值、map 段）'],
            ['只有部分方法有内容', '回填覆盖率不足', '最关心的方法仍然是空的', '补触发：跑遍功能 → 主动调用 → 冷门方法手动调用（第 2 章的第 6 步）']
          ]) +
        T.note('key', '🔑 修复这一步为什么绕不开（与第 2 章的呼应）',
          '<p>dump 出来的 dex 必然要过修复：<b>checksum（Adler-32）与 signature（SHA-1）覆盖的是文件内容</b>，' +
          '而 dump 改变了内容（方法体被回填），这两个字段却还是旧值 → 校验必然失配。' +
          '此外还要注意 <code>map</code> 段是否完整、code item 的对齐是否正确。</p>' +
          '<p style="margin-bottom:0"><span class="hit">第 2 章已经推导过「为什么 jadx 会报 checksum 错误」，这里只补一句判定上的用法：' +
          '<b>「只有校验错」说明内容是对的；「连魔数都不对」才是没脱到东西。</b>这两句话决定了你该重脱还是该修复。</span></p>') +
        T.acc('一个容易被误判的形态：什么叫「全空」',
          '<p>如果连 <code>Application.onCreate</code>、构造函数这类<b>启动必跑</b>的方法都是空的，那通常不是「覆盖率不足」——' +
          '覆盖率不足的表现是<b>部分空、部分有</b>。</p>' +
          '<p style="margin-bottom:0"><b>「全空」更可能是这三种情况之一：</b>① 你 dump 的是加载前/回填前的那份内存；' +
          '② 你 dump 的对象不是 ART 正在用的那个 DexFile（多份 dex / 多加载器时很常见）；③ 壳的回填发生在另一个副本上，' +
          '你 dump 到的是它的「影子」。<span class="hit">判据是同一个：<b>对照 maps 找到那个真正被映射的 dex 区间，' +
          '并在触发前后各采一次，看 <code>insns_size</code> 有没有变化。</b></span></p>'),
      case: {
        source: 'github',
        title: 'BlackDex —— Android unpack(dexdump) tool（GitHub 仓库名：CodingGay/BlackDex）',
        date: '2021-05-21（仓库创建，据 GitHub API；README 对应的最近一次 push 为 2023-11-09）',
        author: 'CodingGay（GitHub 仓库所有者；LICENSE 署名为 Milk）',
        target: 'BlackDex（运行在 Android 手机上的脱壳工具，README 自述支持 5.0～12；32 位与 64 位是两个不同的 APK）',
        background:
          '<p>README 的自我定位很干脆：<b>「一个运行在 Android 手机上的脱壳工具，支持 5.0～12，无需依赖任何环境任何手机都可以使用，' +
          '包括模拟器。只需几秒，即可对已安装包括未安装的 APK 进行脱壳。」</b>环境要求一栏把 Xposed、Frida、Magisk、Root、定制系统全部划掉。</p>' +
          '<p>它把覆盖范围写成：<b>「本项目针对一（落地加载）、二（内存加载）、三（指令抽取）代壳」</b>——' +
          '这句话本身就值得单独讲，见下面的「局限」与方法论拆解。</p>',
        points: [
          '脱壳原理自述：<b>通过 DexFile cookie 进行脱壳，理论兼容 art 开始的所有版本</b>；作者同时注明「可能少数因设备而异，绝大部分是支持的」。',
          '产物分两类（照录 README）：<code>hook_xxxx.dex</code> 是 hook 系统 api 脱壳的 dex，<b>深度脱壳不修复</b>；<code>cookie_xxxx.dex</code> 是利用 dexFile cookie 脱壳的 dex，<b>深度脱壳时会修复此 dex</b>。',
          '深度脱壳自述：<b>「会自主修复被抽取的方法指令，将指向其他内存块的指令回填至 DEX 内，解决 nop 问题」</b>，但「不会确保一定会有用」。',
          '本节重点：README 对「深度脱壳」给了四条后果预告（脱壳时间大幅上升、可能闪退、失败几率增加、不一定 100% 还原），并明确说明<b>不包含任何解密与主动调用</b>。'
        ],
        method: [
          '<b>第一步：不依赖任何注入环境。</b>工具以普通 App 形式运行在手机上，用系统允许的方式拿到目标进程的 DexFile 信息，按 README 的说法是走 DexFile cookie 这条路。',
          '<b>第二步：区分两类产物。</b>一条路是 hook 系统 API 取 dex（对应 hook_ 前缀），另一条走 cookie（对应 cookie_ 前缀）——两条路的产物在「深度脱壳时是否被修复」上不同。',
          '<b>第三步：深度脱壳时做指令回填。</b>把「指向其他内存块」的指令搬回 DEX 内部，消除 nop；这一步是黑盒回填，不含解密、不含主动调用。',
          '<b>第四步：把边界写在明处。</b>README 主动列出四条副作用，并提示遇到问题提 issue（自述「资源有限无法大量测试」）。'
        ],
        result:
          '<p>对「结构化完整但指令被抽走（nop）」这一类样本，工具提供一个不依赖 root / Frida 的一次性脱壳路径，' +
          '产物按是否修复分成两类落在设备上。</p>',
        terms: ['DexFile cookie', '深度脱壳', '指令回填', 'nop', '落地加载', '内存加载', '指令抽取', '模拟器兼容'],
        limits: '<p>作者的局限交代是这份 README 里最有价值的部分，逐条照录：</p>' +
          '<p>① <b>项目声明：</b>「本项目并不针对任何加固，在遇到检测环境等均不处理，仅供安全领域分析用途。」<br>' +
          '② <b>测试覆盖：</b>「资源有限无法大量测试，遇到问题请提issues.」「可能少数因设备而异，绝大部分是支持的。」<br>' +
          '③ <b>深度脱壳的预告（原文四条）：</b>脱壳时间会大幅度上升，预计几分钟到十几分钟不等；脱壳期间有可能会出现应用闪退（遇到反检测等）；会增加脱壳失败几率；不一定能够 100% 还原。<br>' +
          '④ <b>深度脱壳的能力边界：</b>「并不包含任何解密、主动调用等操作」「例如：指令需要主动调用才解密等则无法回填或者说是无效回填」。<br>' +
          '⑤ <b>架构限制：</b>32 位与 64 位是两个不同的 app，安装列表里找不到目标应用说明该架构版本不支持。</p>',
        analysis:
          '<p><b>这份 README 一共给本章送了三件礼物。</b></p>' +
          '<p><b>礼物一：它把「运行时防护」显式排除在能力之外。</b>「本项目并不针对任何加固，在遇到检测环境等均不处理」——' +
          '这一句正好印证 19.9 的判定纪律：<b>壳的代际与运行时防护是两个独立维度</b>。' +
          '一个只看代际的工具，遇到「抽取壳 + 全套反调试」的样本会表现得很差，' +
          '<span class="hit">而这不是工具不行，是它从设计上就只覆盖了其中一个维度。</span>所以你做判定时必须分开问，选工具时也才知道自己在选什么。</p>' +
          '<p><b>礼物二：它诚实地写出了「回填」的成本结构。</b>「指令需要主动调用才解密等则无法回填或者说是无效回填」，' +
          '加上四条副作用（时间上升、可能闪退、失败率上升、不保证 100%），把 19.5 那条结论钉死了：' +
          '<b>不主动调用时，回填覆盖率存在上限；而主动调用本身要付出时间与稳定性代价。</b>' +
          '作者最后那句「愿世上再无nop」，是这句话最生动的注脚——nop 正是抽取壳留给你的空方法体。</p>' +
          '<p><b>礼物三（最值得记的一条）：代际命名在社区并不统一。</b>BlackDex 说的「一代（落地加载）/ 二代（内存加载）/ 三代（指令抽取）」，' +
          '与我们本章的分类<b>不是同一把尺子</b>：它的「一代/二代」区分的是<b>加载方式</b>（落不落地），' +
          '它的「三代」才是我们说的抽取壳（二代壳）。' +
          '<span class="hit">结论：引用任何资料时，先说清对方的「代际」口径，再谈技术路线。' +
          '判定表本身比代号重要得多——代号会撞车，结构现象不会。</span></p>' +
          '<p>最后一点方法论对照：BlackDex 的深度脱壳是「<b>把指向其他内存块的指令搬回 DEX</b>」（黑盒回填），' +
          'FART 的主动调用是「<b>逼壳自己回填，然后取走</b>」（白盒触发）。' +
          '两条路都在解决同一件事，但适用条件不同：前者不需要注入环境、覆盖面受回填机制限制；' +
          '后者需要能注入并遍历方法，但拿到的是一致的、可复现的产物。<b>这正是 19.12 判定器要教你的：先分类，再选路线。</b></p>',
        link: 'https://github.com/CodingGay/BlackDex',
        linkNote: 'GitHub 仓库（收录时以 web_fetch 取到 README 全文，并另取 GitHub API 元数据核对创建时间与 License）'
      },
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境二',
            scenario: '<b>情境：</b>静态特征（结构完整、方法体空、有 native 注册）指向抽取壳。' +
                      '你用某个通用 dump 工具抓到一份 dex，修复后 jadx 能正常打开，' +
                      '但<b>所有</b>方法体都是空的——连 <code>Application.onCreate</code> 和构造函数都空。',
            q: '下一步做什么？',
            choices: [
              { t: '换一个更强的脱壳工具再脱一次', next: 'n1' },
              { t: '先核对 dump 的时机与对象：确认抓的是 ART 已接管、方法已被调用过的那个 DexFile', next: 'n2' },
              { t: '判定这个壳无法脱壳，转向黑盒调用方案', next: 'n3' },
              { t: '先把空方法体的伪代码手工补上，凑一份能读的代码', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'bad',
            verdictTitle: '换工具换不掉错误的观测点',
            result: '<b>「全空」这个现象与工具强弱无关，它与你的观测点有关。</b><br><br>' +
              '抽取壳在内存里同时存在多个版本的 dex：解密后的原始数据、被 ART 加载的结构、回填后的实体、以及可能的副本。' +
              '工具只是「取哪一块内存」的实现，取错块，再强的工具也给你空方法。<br><br>' +
              '<span class="hit">在换工具之前，成本更低的一步是：对照 maps 找到那个真正的 dex 映射区间，' +
              '在触发功能前后各采一次，看 <code>insns_size</code> 有没有变化。</span>这一步十分钟，能直接告诉你「是不是取错了块」。'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'good',
            verdictTitle: '正确：把「全空」当成观测点问题来查',
            result: '<b>这条思路是对的，而且它是可验证的。</b>三个检查按顺序做：<br>' +
              '① <b>对象对不对：</b>maps 里有几处 <code>.dex</code> 映射？你 dump 的是哪一处？多加载器场景下很容易抓错。' +
              '（这也是为什么 19.13 的实验要把「被映射的 dex」单独标成<b>有价值</b>而不是可疑。）<br>' +
              '② <b>时机对不对：</b>先跑遍功能再 dump，然后在同样的位置再 dump 一次做对比——' +
              '如果非空方法数变多，说明你在正确的对象上、只是时机偏早。<br>' +
              '③ <b>回填是不是被触发了：</b>看 <code>insns_size</code> 是否从 0 变成非 0。' +
              '如果一直是 0，说明这个对象的回填逻辑没有跑，可能壳用的是另一个副本。<br><br>' +
              '<span class="hit">「全空」和「部分空」是两个不同的诊断结论：部分空 = 覆盖率不足（去补触发）；' +
              '全空 = 观测点错了（去核对对象与时机）。</span>'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '跳步了：现象还没有被解释',
            result: '<b>黑盒调用是一条真实路线，但现在转过去是「用一个未解释的失败换一个未验证的方案」。</b><br><br>' +
              '黑盒方案（模拟执行 so 里的目标函数）需要你先知道<b>目标函数在哪</b>——而你现在连 Java 层调用图都没有，' +
              '因为方法体全空。<b>你会从一个坑跳进另一个更深的坑。</b><br><br>' +
              '正确顺序是：先把「全空」解释掉（对象/时机），拿到至少一份部分可读的 Java 层；' +
              '如果那时发现关键函数确实在 native 里、且难以还原，再评估黑盒。<span class="hit">路线的排序依据是依赖关系，不是难度。</span>'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '最危险的一条：把猜测写成证据',
            result: '<b>手工补全的伪代码不是「可读性优化」，是伪造证据。</b><br><br>' +
              '你补出来的逻辑基于「这段代码大概应该是这样」，一旦后续同事或下游流程基于它做判断，' +
              '错误会被放大到无法追溯——因为最终没有人能分清哪一行是 dump 出来的、哪一行是你写的。<br><br>' +
              '如果确实需要临时沟通「逻辑大概长什么样」，正确做法是<b>写成独立的推测文档</b>，标注清楚依据，' +
              '而不是混进反编译产物里。<span class="hit">脱壳产物必须是可回溯的原始事实，这是这个工种的底线。</span>'
          }
        }
      }
    },

    /* ============================================================ 19.15 */
    {
      h: '19.15', title: '自己编译 AOSP 做脱壳机 / 沙箱：这是分水岭，但要先算账',
      intuition: {
        tag: '直觉模型 · 租房子和盖房子',
        body:
          '<p>用 Frida / Xposed 是在<strong>租来的房子里摆家具</strong>：你能改变的东西，受房东（ART 虚拟机）允许你改的东西限制。</p>' +
          '<p>自己编译 AOSP 是<strong>自己盖房子</strong>：你可以在承重墙里埋传感器。' +
          '方法的每一次注册、每一个 dex 的每一次加载，都从你写的代码里经过——<strong>你不需要去"发现"它，因为它就发生在你手里</strong>。</p>' +
          '<p>但盖房子有成本：地基很大（源码）、图纸要对得上（版本与机型匹配）、盖错一次要重来（刷机、变砖风险）。' +
          '所以这一节只回答一个问题：<strong>什么情况下值得盖，什么情况下租房更划算。</strong></p>'
      },
      html:
        '<p>本节与第 4 章直接呼应——第 4 章讲的是「怎么在 ART 源码里插桩」，这里只讲<b>选型与前提</b>：两者本质差别在哪、代价是什么、什么时候该上。</p>' +
        T.tbl(['维度', '用户态 hook（Frida / Xposed）', '源码层插桩（自己编译 AOSP）'],
          [
            ['<b>时序</b>', '必须比目标先到位。晚了就被反调试拦住，或者关键动作已经发生（<b>时序问题</b>）',
             '<b>没有时序问题</b>：插桩代码就在流程里，事件发生的那一刻你必然在场'],
            ['<b>隐蔽性</b>', '需要与检测对抗（端口、线程名、maps、函数序言校验），<b>你的存在本身是破绽</b>',
             '检测的是「进程有没有被注入」，而你<b>没有注入</b>——你就是那个进程。但同时：你得自己解决「改动是否被发觉」的问题（完整性校验）'],
            ['<b>覆盖面</b>', '只能拦截「有符号、可 hook」的调用。直接 SVC、内联、自实现加载器会绕过你',
             '覆盖到你插桩的那一层的<b>全部</b>调用，包括没有符号的内部函数'],
            ['<b>成本</b>', '低：装上就能用，脚本可迭代', '<b>高</b>：源码同步、编译、刷机、每个版本重新适配（第 12 章整章都在讲这件事）'],
            ['<b>适用判断</b>', '目标是「快速搞清一个 App 的行为」', '目标是「反复、批量、深入观测同类样本」，或要拿到的信息在用户态根本不可见']
          ]) +
        T.note('key', '🔑 一句话的选型判据',
          '<p style="margin-bottom:0">问自己一个问题：<b>我要观测的那个事实，在用户态能不能被观测到？</b><br>' +
          '能（比如某方法被调用、某个返回值为真）→ 用户态 hook 更快。<br>' +
          '不能（比如 JNI 绑定发生的那一刻、dex 被加载进 ART 的那一刻、没有符号的内部调用）→ 只有源码层。<br>' +
          '<span class="hit">这不是「谁的方案更高级」的问题，是「哪个观测点能看到你要的事实」的问题。</span></p>') +
        T.card('前提清单（缺一条都会让整件事变成消耗战）',
          '<p>① <b>版本与机型匹配</b>：要有与目标设备内核/驱动适配的源码分支，否则编译出来的镜像跑不起来。' +
          '<span class="pill warn">待核实</span> 具体分支、内核源码与设备的对应关系必须查该机型的官方/社区资料，不能用"同芯片通用"来猜。<br>' +
          '② <b>编译环境</b>：源码体积与编译时间随分支和机器差异极大，<span class="pill warn">待核实</span>具体数字，' +
          '但需要相当规模的磁盘与内存是共识。<br>' +
          '③ <b>刷机风险自担</b>：解锁 bootloader、anti-rollback、分区结构变化都可能让设备不可恢复——' +
          '这一点在第 2 章的案例里作者也专门强调过。<br>' +
          '④ <b>维护意识</b>：源码插桩不是一次性投入。目标一旦升级安卓大版本，插桩点就要重新定位（第 12 章）。<br>' +
          '⑤ <b>合法授权</b>：改系统镜像意味着你对自己手上的设备做研究；不要把这套能力用在未授权的目标与设备上。</p>' +
          '<p style="margin-bottom:0"><b>沙箱脱壳机的核心原理</b>只有一个：<b>让虚拟机自己招供</b>。' +
          '你不是在进程外面偷看，而是让 ART 在加载 dex、注册 JNI、编译方法时，主动把信息写到你指定的地方。' +
          '这套思路的延伸就是第 24 章的「自吐沙箱」——在算法 API 上插桩，让输入输出自己吐出来。</p>')
    },

    /* ============================================================ 19.16 */
    {
      h: '19.16', title: '收尾：遇到加壳 App，我该怎么走',
      html:
        '<p>把整章压成一棵决策树。它的每一次分支都在回答同一个问题：<b>我现在看到的这个现象，能排除掉哪些可能，剩下最该做的第一件事是什么。</b></p>' +
        '<p>请先自己走一遍再点选项——这棵树里的每一个错误分支，都对应真实工作里一种具体的浪费。</p>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '入口',
            scenario: '<b>情境：</b>你拿到一个 APK，手上只有半小时，还不知道它有没有加壳、是第几代。',
            q: '第一步做什么？',
            choices: [
              { t: '直接上 Frida / Xposed，先把业务类 hook 起来看看', next: 'n1' },
              { t: '先做静态侦察（unzip -l + jadx + 读 dex 头 + 看 Manifest 入口），用现象给壳分类', next: 'n2' },
              { t: '不管三七二十一，先跑一遍全量脱壳工具再说', next: 'n3' },
              { t: '先搜这个 App 用的是哪家加固，按厂商方案找攻略', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'bad',
            verdictTitle: '你在没有地图的情况下开车',
            result: '<b>两个必然的浪费。</b><br><br>' +
              '① 如果它加壳了，业务类由壳的自定义加载器加载，<code>Java.use</code> 用默认加载器<b>根本看不到</b>——' +
              '你会先花时间排查「类名是不是写错了」。<br>' +
              '② 如果它有运行时防护，你可能连进程都留不住（spawn 就被检测）。<br><br>' +
              '<span class="hit">静态侦察零成本、五分钟，却能让你在动手之前就知道该带什么武器。' +
              '跳过它省下的五分钟，通常会在后面变成一个下午。</span>'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'good',
            verdictTitle: '正确：先分类，再动手',
            result: '<b>这一步做对了，后面每一步都会便宜很多。</b>四件事，五分钟：<br>' +
              '① <code>unzip -l</code>：dex 几份、<code>assets/</code> 有没有体积异常的文件、<code>lib/</code> 下有几个 so；<br>' +
              '② jadx 打开：<b>看不到类 → 一代；看到类看不到方法体 → 二代；成片 native 或天书 → 三代；都正常只是字符串乱 → 不是壳</b>；<br>' +
              '③ 读 dex 头的 <code>class_defs_size</code>：把印象变成数字；<br>' +
              '④ 看 Manifest 的 <code>application:name</code> 与 <code>attachBaseContext</code>：确认入口有没有被接管。<br><br>' +
              '做完这四步，你就有了一个<b>可执行的结论</b>。继续往下走，看抽取壳这一支该怎么处理。'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '工具会在错误的假设下给你一个「看起来成功」的结果',
            result: '<b>这是最隐蔽的一种浪费。</b>全量脱壳工具跑完了、产物也有了，你以为成功了，' +
              '然后花两天分析一份不完整的 dex，最后发现关键方法全是空的。<br><br>' +
              '更糟的情况是：你用一个「针对整体加密」的工具去处理抽取壳，它给你一份结构完整但方法体全空的 dex——' +
              '<b>而这份产物看起来「能打开」，于是错误被带进了后续所有环节。</b><br><br>' +
              '<span class="hit">判定之所以要放在最前面，就是因为它能防止这种「静默的错误结论」。</span>'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '厂商信息是先验，不能当结论',
            result: '<b>搜一搜没错，但把它当成判定结果就错了。</b><br><br>' +
              '① <b>同一家厂商不同档位、不同版本可能完全不同</b>——你搜到的攻略可能对应它三年前的方案；<br>' +
              '② <b>多个方案混用很普遍</b>，一篇帖子说的「这家用抽取壳」不代表你手上这个样本也是；<br>' +
              '③ 最关键的：<b>厂商名不决定你下一步做什么，「结构现象」才决定。</b><br><br>' +
              '<span class="hit">正确用法：把搜索结果当<b>候选假设</b>，然后用你自己的观测去验证或推翻它。' +
              '验证的方向就是选项 B 那四步。</span>'
          }
        }
      }
    },

  ],

  /* ============================================================== 名词表 */
  glossary: [
    { t: 'App 加固', d: '在 APK 被分发之前对代码与资源做的保护性处理，目的有三：提高静态分析成本、提高动态调试成本、让篡改后的产物无法运行。注意这三类目标是独立的，可分别取舍。' },
    { t: '壳 / 加壳', d: '对 App 做加固的那一层代码与它带来的运行时机制。壳负责在启动早期接管入口、解密、加载真代码，并把「业务代码什么时候可见」控制在自己手里。' },
    { t: '威胁模型', d: '加固方在设计方案时假设的对手能力与攻击方式。本章把它分为三类：防静态分析、防动态调试、防二次打包。判定任何防护手段时先问「它属于哪一类」。' },
    { t: '一代壳（整体加密壳）', d: '把整份 dex 加密或整体搬移，运行时解密到内存再加载。静态看不到业务类（只有壳的代码）；破解关键是找 dump 时机。' },
    { t: '文件重定向', d: '把 APK 的结构改掉以接管入口：替换 <code>classes.dex</code>、把真 dex 加密后放进 <code>assets/</code>、把 Manifest 的 <code>application:name</code> 换成壳的类。<b>重定向不等于加密</b>——它只负责换位置和换入口。' },
    { t: '抽取壳（二代壳）', d: '保留 dex 完整结构（类名、方法名、字段、签名都在），只抽走方法体的字节码（<code>code_item</code> 里的 <code>insns</code>），运行时首次调用才回填。直接 dump 得到的是「结构完整、方法体空」的 dex。' },
    { t: 'code_item / insns', d: 'dex 中存放方法体的结构。核心字段是 <code>insns_size</code> 与 <code>insns</code>（dalvik 字节码指令数组）。抽取壳抽的就是它，回填的也是它——所以 <code>insns_size</code> 是不是 0，是判定回填有没有发生的直接证据。' },
    { t: '动态回填', d: '抽取壳在方法首次被执行（或首次必须被解析）时，把真指令写回该方法 code item 的过程。回填由「调用」触发，因此脱壳完整度 = 你触发过的代码路径覆盖度。' },
    { t: '主动调用（Active Call）', d: '遍历所有 DexFile × 所有类 × 所有方法，用默认参数强制调用每个方法，逼壳完成回填，然后立即 dump code item。FART 的核心机制（第 2 章）。调用抛异常不影响——要的是回填这个副作用。' },
    { t: '三代壳（DEX2C / Java2C）', d: '把 dalvik 字节码翻译成等价的 C 代码（或直接生成机器码）编译进 so，Java 侧退化成 <code>native</code> 声明或一层胶水代码。因为 Java 层不再有字节码，<b>「回填」这件事从根上不存在</b>。' },
    { t: 'VMP（虚拟机保护）', d: '把字节码转成厂商自定义的指令序列，运行时由解释器逐条执行。现象是「方法体有代码、但语义不通」（读一串数据 + 跳进一个分发循环）。比 DEX2C 保护强度更高、体积代价更小、运行更慢。' },
    { t: '混合型壳', d: '同一份 APK 里多种保护并存：多 dex 分代保护、多 so 分工、壳中壳。它不是「第四代」，而是把前几代技术在不同部位重复使用。判定时的第一原则是<b>先排顺序</b>，而不是先定代际。' },
    { t: 'attachBaseContext', d: 'Application 生命周期里早于 <code>onCreate</code> 的回调，是壳在进程早期拿到 <code>Context</code> 的标准位置。被覆写是「加固存在」的第二强证据（第一强是方法体为空）。' },
    { t: '内存加载（自定义 Linker）', d: '不走系统 <code>dlopen</code>，由壳自己把 so 映射进内存并修补重定位。观测特征是 maps 里出现无名可执行段、<code>memfd:</code> 映射、或 <code>(deleted)</code> 的 so。' },
    { t: '导出表抹除', d: '用隐藏可见性 + strip 让 so 的符号表变空，使静态分析找不到函数入口。<b>它是「名字没了」，不是「内容没了」</b>——代码照样能正常加载执行。' },
    { t: 'JNI 动态注册', d: '用 <code>JNI_OnLoad</code> + <code>RegisterNatives</code> 在运行时建立「Java 方法 → native 函数地址」的绑定，把入口从静态符号表挪到运行时。第 4 章的插桩点就选在这个绑定发生时。' },
    { t: '运行时防护', d: '与壳的代际<b>互相独立</b>的一个维度：反调试、反注入、反 Hook、root/模拟器/多开检测、完整性校验、反 Frida。判定时要单独回答「有没有、在哪一层、和壳是什么关系」。' },
    { t: '完整性校验', d: '校验自身签名摘要、dex/so 内容摘要或代码段字节，用于让「改完重新打包」的产物拒绝运行。这是「防二次打包」这一类威胁模型的技术落点。' },
    { t: '可执行匿名段', d: 'maps 里没有路径、却带执行权限的映射（<code>r-xp</code> / <code>rwxp</code>）。ART 的 JIT 代码缓存会合法地产生这种映射（名字形如 <code>[anon:dalvik-jit-code-cache]</code>），<b>无名的那种才最可疑</b>。' },
    { t: 'memfd', d: '内核提供的匿名内存文件，不需要在磁盘上落地。把解密结果写进 memfd 再 <code>dlopen</code>，是内存加载型壳的典型做法——文件系统里找不到任何来源。' },
    { t: '判定表', d: '把「观测到的现象组合」映射到「最可能的壳类型 + 下一步动作」的规则表。本章的判定器（19.12）是它的可执行版本：每一条结论都带分数与证据链，而不是一句断言。' }
  ],

  /* ============================================================== 严师 */
  teacher: {
    id: 't19', chapter: 19,
    name: '壳判定教官',
    sub: '分不清「像哪一家」和「是第几代」，我不放你走',
    intro: '<p style="margin:0">我不考你背厂商名单，也不考你记得住哪个 so 名——那些东西半年就过期。<br>' +
           '我考的是：<b>看到现象，你能不能推出它属于哪一类保护、你下一步该做什么、以及你凭什么这么说。</b><br>' +
           '答的时候把「观测」和「推论」分开说。含糊我会追问，追问三次我直接给答案——但那不算你过关。</p>',
    questions: [
      {
        id: 'c19q1', depth: 1, threshold: 0.7,
        q: '加固方到底在防谁？请说出三类威胁模型，并解释为什么「防二次打包」必须单独算一类。',
        concepts: [
          { label: '防静态分析：用加密、抽取、混淆提高「读懂代码」的成本', hint: '最直接的一类：不让你看懂代码。', any: ['静态', '反编译', 'jadx', '读代码', '看不懂', '混淆', '加密', '抽取'] },
          { label: '防动态调试：反调试、反注入、反 Hook、环境检测，提高「观察运行时」的成本', hint: '你在运行时观察它，它就在运行时发现你。', any: ['动态', '调试', '反调试', 'hook', 'frida', '注入', '环境检测', '反注入', 'root', '模拟器'] },
          { label: '防二次打包：签名校验 / 完整性校验，让篡改后的产物直接失效', hint: '改完重新签名装上去，它还跑得起来吗？', any: ['二次打包', '重打包', '重签名', '签名校验', '完整性', '篡改', '改包', '校验和'] },
          { label: '三类目标不同：前两类是「不让你看懂」，第三类是「不让你改完还能用」', hint: '成功的标准不一样。', any: ['目标不同', '目的不同', '标准不同', '失效', '拒绝运行', '不能用', '不是一回事', '不是混淆'] }
        ],
        hints: [
          '先从「加固方最怕什么后果」反推手段：怕被看懂、怕被观察、怕被改。',
          '第三类的成功标准不是「你看不懂」，而是「你改完就崩」。想想混淆能不能达到这个效果。'
        ],
        probes: [
          '追问：字符串混淆和签名校验都能提高逆向成本，为什么前者不能替代后者？',
          '再追问：如果一个 App 只做了资源加密、没做任何校验，它能不能防住「加个广告 SDK 重新分发」？'
        ],
        model: '<b>三类威胁模型，按「加固方怕什么」分：</b><br><br>' +
          '<b>① 防静态分析。</b>怕你打开 APK 就把业务逻辑读明白。手段是加密、抽取、混淆、native 化。成功标准：<b>你读不出有意义的方法体。</b><br><br>' +
          '<b>② 防动态调试。</b>怕你在运行时安静地观察它。手段是反调试（TracerPid、断点检测）、反注入、反 Hook、反 Frida、root/模拟器/多开检测。' +
          '成功标准：<b>你要么进不去，要么一进去就被发现。</b><br><br>' +
          '<b>③ 防二次打包。</b>怕你改一改就重新分发。手段是签名校验、dex/so 完整性校验、资源校验。' +
          '成功标准：<b>你把代码改完、重新签名、装上设备，它拒绝运行。</b><br><br>' +
          '<b>为什么第三类必须单算：</b>因为它的「成功」定义和前两类根本不同。混淆和加密是<b>提高理解成本</b>——它们让你读得慢、读得累，' +
          '但完全不阻止你修改并重新打包；你改完的包照样能启动，只是启动的是你改过的版本。' +
          '而第三类防的是「<b>篡改这件事本身</b>」，所以它必须依赖<b>完整性</b>这个概念：' +
          '把当前内容和一个预期值比对，比对失败就走失败分支。<br><br>' +
          '<span class="hit">这条区分在判定时的直接用途：只要你在 Java 和 native 两侧都看到签名摘要比对，' +
          '基本可以断定对方的产品目标里有反二次打包，那么你后面任何「改 smali 重打包验证」的做法都会先被这一关拦下——' +
          '要改就得连校验一起处理，或者换用不改包的方式。</span>'
      },
      {
        id: 'c19q2', depth: 2, threshold: 0.7,
        q: '一代壳和抽取壳，从「你能观测到什么」这一层怎么区分？为什么这个区分决定了完全不同的技术路线？',
        concepts: [
          { label: '一代壳：连 dex 结构都看不到（<code>class_defs_size</code> 为 0 / 只有壳代码 / dex 不可解析）', hint: '打开 APK，你能不能看到业务的类名？', any: ['一代', '整体加密', '结构看不到', 'class_defs_size', '类数为0', '打不开', '没有类', '重定向', '占位'] },
          { label: '抽取壳：结构完整（类名/方法名/字段都在），但方法体为空', hint: '能看到类名吗？能看到方法体里的指令吗？', any: ['抽取', '结构完整', '方法体', '空的', 'code_item', 'insns', '类名', '能打开'] },
          { label: '一代壳的解法是「找 dump 时机」：在解密完成 + ART 接管的那一刻抓内存', hint: '内存里一定会有一份完整的明文 dex，问题是何时抓。', any: ['dump', '时机', '内存', '解密', '加载', '窗口', '时刻'] },
          { label: '抽取壳的解法是「主动调用触发回填」：遍历方法强行调用，逼它给出真指令', hint: '光等没用，它只在你调用时才给。', any: ['主动调用', '回填', '触发', '遍历', '跑一遍', '点一遍', '调用'] },
          { label: '关键判据：抽取壳的缺失是「可变的」（随调用减少），残缺是「恒定的」', hint: '同一个 dex 前后 dump 两次，有什么会变？', any: ['可变', '恒定', '前后对比', '两次', '变多', '恢复', '长出来'] }
        ],
        hints: [
          '先问自己两个问题：打开 jadx 能看到业务类名吗？能看到方法体里的指令吗？这两个答案的组合就能定位代际。',
          '再问第三个问题：内存里到底有没有出现过一份完整的明文 dex？这决定了你要不要「抢时间」。'
        ],
        probes: [
          '追问：抽取壳的方法体是什么时候被回填的？这个时机怎么影响你的脱壳顺序？',
          '再追问：你把同一份 dex 前后 dump 两次，发现非空方法数变多了。这个现象排除了哪些可能？'
        ],
        model: '<b>先给观测层面的分界：</b><br><br>' +
          '<b>一代壳：你看不到结构。</b>jadx 打开只有壳的代码，业务包名下一个类都没有；或者 <code>classes.dex</code> 的 <code>class_defs_size</code> 读到 0、' +
          '魔数不是标准 dex。这是因为<b>整份文件被加密或整体搬走了</b>，静态那一份根本不是真代码。<br><br>' +
          '<b>抽取壳：你看得到结构，看不到内容。</b>类名、方法名、字段、签名全都在（所以 ART 能正常链接类），' +
          '但每个方法的 <code>code_item</code> 是空的、或只有 <code>return</code>。<b>原因在于加固方只抽走了字节码，保留了骨架。</b><br><br>' +
          '<b>为什么这个区分决定路线：</b><br>' +
          '· 一代壳的问题是<b>时间问题</b>——真 dex 必然会以明文形式出现在内存里，你要做的是把观测点放在「解密完成 + ART 接管」的那个窗口。' +
          '它是一个「抢时间」的问题。<br>' +
          '· 抽取壳的问题是<b>触发问题</b>——dex 早就在你手上了（结构完整），但光有它没用，因为方法体是空的，而回填只在方法被调用时发生。' +
          '你要做的是「逼它给」：跑遍功能、主动调用、必要时手动调用冷门方法。它是一个「覆盖度」的问题。<br><br>' +
          '<b>再加一条最实用的判据：可变的缺失 vs 恒定的缺失。</b>把同一份 dex 在「跑功能之前」和「跑功能之后」各 dump 一次：' +
          '如果非空方法数变多了，那就是抽取壳（缺失随调用减少）；如果两次完全一样地空着，那更可能是 dex 本身就残缺，或者你的观测点取错了对象。<br><br>' +
          '<span class="hit">这条判据的价值在于：它用一个可重复的实验，把「我猜是抽取壳」变成了「我证明它是抽取壳」。</span>'
      },
      {
        id: 'c19q3', depth: 2, threshold: 0.7,
        q: '「so 被整体加密」和「导出表被抹除」是两件不同的事。请分别说清：加固方图什么、你会观测到什么、下一步动作有什么不同。',
        concepts: [
          { label: '整体加密：内容读不出来——没有合法 ELF 结构 / 节表异常 / 静态看不到有意义的代码', hint: '用 readelf / file 看，它像不像一个正常 ELF？', any: ['整体加密', '加密', 'elf', '节表', '读不出来', '密文', '文件头', '不可解析'] },
          { label: '导出表抹除：内容可读但名字没了（隐藏可见性 / strip）', hint: '符号表空了，但代码段还在不在？', any: ['导出表', '符号表', '符号', 'strip', '隐藏', '名字', 'readelf', 'sub_'] },
          { label: '抹符号后的下一步：走动态——在 JNI 绑定发生时记录「Java 方法 → native 地址」', hint: '绑定关系只能在运行时存在，那里就是观测点。', any: ['动态', '注册', 'registernatives', 'jni_onload', '绑定', '调用点', 'hook', 'trace'] },
          { label: '加密后的下一步：先解决「怎么拿到内存里的明文 so」，必要时修复 dump 出来的 so', hint: '磁盘上没有可分析的东西，那就去内存里拿，拿到还可能要靠修复。', any: ['内存', 'dump', '明文', '修复', 'sofixer', '加载', '脱壳'] },
          { label: '区分办法：看 ELF 头 / 节表 / 代码段规模是否正常——「没名字」不等于「没内容」', hint: '这两件事的观测点完全不同。', any: ['elf头', '节表', 'text段', '代码段', '文件头', '正常', '规模'] }
        ],
        hints: [
          '先问：我拿到的是「一堆读不懂的字节」，还是「一段能读的代码但没有名字」？',
          '再去想：如果代码是完好的，只是没有名字，那我还能从哪里找到入口？'
        ],
        probes: [
          '追问：很多人看到符号表是空的就说「so 被加密了」。这个判断错在哪？',
          '再追问：如果 <code>JNI_OnLoad</code> 也不导出，你要怎么找到动态注册发生的位置？'
        ],
        model: '<b>先把两件事分开：一件是「内容没了」，一件是「名字没了」。</b><br><br>' +
          '<b>① so 整体加密。</b>加固方图的是：<b>磁盘上不存在可分析的机器码</b>。密钥和解密逻辑放在更早的一层（另一个 so、或壳的 dex 里）。<br>' +
          '你会观测到：<code>file</code> / <code>readelf</code> 识别不出正常 ELF 结构，节表异常或缺失，静态看不到成规模的代码。<br>' +
          '下一步：目标从「读它」变成「<b>拿内存里的那一份</b>」——也就是说，你要先解决内存加载/解密这件事（19.13 实验里那三类 maps 痕迹就是为它准备的），' +
          '拿到之后可能还要修复 dump 出来的 so（节表、重定位一类）。<br><br>' +
          '<b>② 导出表被抹除。</b>加固方图的是：<b>让你读得到代码、但找不到入口</b>。做法是隐藏符号可见性 + strip，' +
          '常见结果是 <code>JNI_OnLoad</code> 也不再是导出符号。<br>' +
          '你会观测到：符号表几乎为空，IDA 里全是 <code>sub_xxxx</code>，但 <code>.text</code> 段有大量代码、文件能正常加载运行。<br>' +
          '下一步：<b>走动态</b>。绑定关系（Java 方法 → native 地址）无法被永久隐藏——虚拟机执行时必须知道地址，' +
          '所以 <code>RegisterNatives</code> 一定会被调用。在那里记录映射，你就能把「一堆没有名字的函数」重新贴上标签。<br><br>' +
          '<b>区分办法（一条就够）：</b>看 ELF 头和节表是否正常。<b>正常 → 只是没名字；异常 → 内容被处理过。</b><br><br>' +
          '<span class="hit">为什么这个区分很关键：它决定了你的第一件事是「去内存里抢」还是「在运行时挂钩」。' +
          '判断错了，你会用一半时间去做根本不需要的事。</span>'
      },
      {
        id: 'c19q4', depth: 3, threshold: 0.7,
        q: '<b>综合题：</b>给你一个从没见过的加固样本。请完整说出你的判定流程（至少五步），并说清每一步「如果跳过或者做错，会导致什么后果」。',
        concepts: [
          { label: '先做零成本的静态侦察（unzip -l、jadx、读 dex 头）', hint: '最便宜的一步应该最先做。', any: ['静态', 'unzip', 'jadx', 'dex头', 'class_defs_size', '先看', '第一', '侦察'] },
          { label: '按现象给代际定性：看不到类→一代；方法体空→二代；native/天书→三代', hint: 'jadx 一打开就能定方向。', any: ['一代', '二代', '三代', '方法体', '空', 'native', 'vmp', '看不到'] },
          { label: '再看动态侧：maps 逐行分类、dex 魔数命中数、native 注册痕迹', hint: '到这一步才需要设备。', any: ['maps', '魔数', '内存', '注册', '动态', '设备'] },
          { label: '采样纪律：先跑功能再采、至少采两次做对比、把「可疑」与「有价值」分开记', hint: '抽取壳的缺失是可变的，只采一次看不出。', any: ['跑一遍', '功能', '两次', '对比', '采样', '分开', '可疑'] },
          { label: '特征库只做交叉验证（先验），结论以自己的结构观测为准', hint: '厂商表半年就过期，你的观测是现场证据。', any: ['特征库', 'apkid', '交叉', '先验', '以观测', '厂商', '验证'] },
          { label: '跳过判定的后果：用错工具，拿到一份「看起来能打开」的不完整产物，错误被带进后续所有环节', hint: '最贵的错误不是失败，是看起来成功。', any: ['不完整', '误判', '选错工具', '静默', '看起来成功', '浪费时间', '带进'] }
        ],
        hints: [
          '第一步不是脱壳，是「花五分钟把对手分类」。先想清楚：哪一步是零成本的、能排除最多可能的？',
          '再想：哪一步只做一次是不够的？（提示：与「可变性」有关）'
        ],
        probes: [
          '追问：如果你发现 maps 里有 <code>(deleted)</code> 的 so，但 jadx 里方法体是完整的，你该怎么解释这个组合？',
          '再追问：如果静态看到的是「结构完整 + 方法体完整」，但字符串全是乱码，你会把它列入脱壳任务吗？为什么？'
        ],
        model: '<b>完整流程（六步，每步都带失败后果）：</b><br><br>' +
          '<b>第一步：静态侦察（零成本，先做）。</b><code>unzip -l</code> 看目录结构（dex 几份、<code>assets/</code> 有没有体积异常的文件、<code>lib/</code> 下 so 数量）、' +
          'jadx 打开看能不能读到业务代码、读 dex 头把印象变成数字。<br>' +
          '<b>跳过的后果：</b>你不知道自己在对付什么，后面每一步都在猜。<br><br>' +
          '<b>第二步：按现象定性。</b>看不到类 → 一代（整体加密/重定向）；看得到类、方法体空 → 二代（抽取）；' +
          '成片 native 或方法体是「读数据 + 大循环」→ 三代（DEX2C / VMP）；都正常只是字符串乱 → 不是壳，是字符串加密。<br>' +
          '<b>做错的后果：</b>用主动调用工具去啃整体加密（遍历不到任何 DexFile），或用静态反混淆工具去啃抽取壳（只看到空方法）。<br><br>' +
          '<b>第三步：动态侧观测（这一步才需要设备）。</b>读 maps 并逐行分类、搜 dex 魔数命中数、观察 native 注册。' +
          '三件事分别回答：SO 层有没有做内存加载、内存里有几份明文 dex、关键逻辑是不是在 native。<br>' +
          '<b>跳过的后果：</b>你会漏掉 SO 层加固，直到在静态分析上卡住才发现「so 也是加密的」。<br><br>' +
          '<b>第四步：守住采样纪律。</b>先跑遍功能再采集；同一观测至少采两次做对比；把「可疑」和「有价值」分开记（<code>(deleted)</code> 的 so 是壳的痕迹，' +
          '被映射的 <code>.dex</code> 是你的 dump 目标）。<br>' +
          '<b>违反的后果：</b>只采一次时，抽取壳和「本身就残缺的 dex」长得一模一样，你会得出错误结论并据此选错路线。<br><br>' +
          '<b>第五步：交叉验证，但以观测为准。</b>用特征库工具给一个厂商先验，提醒你「还有这种可能」；' +
          '但如果它和你的结构观测矛盾，<b>永远信你自己的观测</b>——因为它采的是历史规则，你采的是现场证据。<br>' +
          '<b>做反的后果：</b>去搜「某厂商怎么脱」的攻略，结果按三年前的方案操作，浪费时间还怀疑工具。<br><br>' +
          '<b>第六步：写出可执行的三段式结论。</b>壳类型 + SO/运行时防护程度 + 下一步第一个动作，例如：' +
          '「二代抽取壳（结构完整、方法体空、native 注册）；SO 层做了内存加载；下一步先跑遍功能，再主动调用脱壳」。<br>' +
          '<b>不写的后果：</b>结论留在你脑子里，明天换人接手要从头再来一遍——<b>而判定这件事每次都要花半小时</b>。<br><br>' +
          '<span class="hit">整个流程的核心思想：<b>用最便宜的手段先分类，再选路线；每完成一步都用现象验证，' +
          '而不是靠「我觉得应该是」推进。</b>最贵的错误从来不是「脱不出来」，而是「拿着一份看起来成功的错误产物继续往下做」。</span>'
      },
      {
        id: 'c19q5', depth: 2, threshold: 0.7,
        q: '运行时防护可以分成几类？它们分别挡在哪一层？为什么说「绕过一层不等于绕过全部」？',
        concepts: [
          { label: 'Java 层：环境检测（root/模拟器/多开）、签名校验——写好写、也最容易被 hook', hint: '最容易被你改返回值的那一层是哪层？', any: ['java', '环境检测', '签名', 'root', '模拟器', '多开', '属性'] },
          { label: 'Native 层：反调试、反 Hook / 完整性校验、反 Frida——壳的主战场', hint: '检测下沉到 native，hook Java 就没用了。', any: ['native', '反调试', '反hook', '完整性', 'frida', 'so', '端口', '线程名', 'maps', '序言'] },
          { label: '内核层 / 绕过 libc：直接发 SVC 系统调用，让用户态 hook 整体失效', hint: '不经过 libc 的调用，你 hook libc 有什么用？', any: ['内核', 'svc', '系统调用', 'syscall', 'inline', '内核模块', 'ebpf', '硬件断点'] },
          { label: '各层相互独立：绕过一层不影响其它层，必须逐层判定与逐层处理', hint: '把五类检测当成一条链，还是五个独立的锁？', any: ['独立', '逐层', '每层', '分开', '不等于', '都要', '分别', '五个'] },
          { label: '绕过手段取决于所在层：Java 层改返回值；native 层抢时序或换观测层；内核层要换武器', hint: '同一招能不能打穿三层？', any: ['改返回', '时序', 'spawn', '观测层', '换武器', 'hook', '注入'] }
        ],
        hints: [
          '先按「它检测的是你的存在，还是你的动作留下的痕迹」把手段分一遍。',
          '再问：如果检测代码在 native 里直接发系统调用，你在 Java 层 hook 它的意义是什么？'
        ],
        probes: [
          '追问：反 Frida 和「加壳」是什么关系？一个不加壳的 App 能不能做反 Frida？',
          '再追问：如果一个 App 启动就退，你怎么判断是「反调试」还是「签名校验失败」还是「它真的崩了」？'
        ],
        model: '<b>五类，按所在层排：</b><br><br>' +
          '<b>① Java 层：环境检测 + 签名校验。</b>读 <code>Build</code> 属性、查 su/magisk/模拟器路径、看是否多开、比对签名摘要。' +
          '放这一层的原因很简单：写得快。代价是<b>最容易被 hook</b>——改个返回值就过去了。<br><br>' +
          '<b>② Native 层（壳的主战场）：反调试、反 Hook / 完整性校验、反 Frida。</b>' +
          '反调试读 TracerPid、尝试 ptrace、检测断点；反 Hook 校验函数序言字节、扫 maps 找注入模块、重算摘要；' +
          '反 Frida 扫端口、线程名、agent 模块、内存特征串。<b>下沉到 native 就是为了躲开你的 Java 层 hook。</b><br><br>' +
          '<b>③ 内核层 / 绕过 libc：直接 SVC 系统调用，或把观测与对抗下沉到内核（内核模块、eBPF、硬件断点）。</b>' +
          '到了这一层，胜负不再取决于你的脚本写得好不好，而取决于<b>你有没有能力进入被观测目标之下的那一层</b>。<br><br>' +
          '<b>为什么「绕过一层不等于绕过全部」：</b>因为这五类是<b>五个独立的锁</b>，不是一条链上的一环。' +
          '你把 Java 层的环境检测改掉了，native 层的 ptrace 检测照样能让你退出；你把 ptrace hook 掉了，' +
          '它直接发 SVC 让 libc hook 失效；你把注入藏好了，它算一遍 dex 摘要发现你改过。<br><br>' +
          '<b>所以判定时必须回答三个问题：</b>① 有没有（启动就退、改包不跑，说明有）；② 在哪一层（决定你带什么武器）；' +
          '③ 和壳是什么关系（壳自带的还是业务方另买的 SDK，绕过方式往往不同）。<br><br>' +
          '<span class="hit">最后一条要单独记住：反 Frida 与「加壳」是两个独立能力。很多不加壳的 App 也会做反 Frida——' +
          '所以「脱壳失败」和「挂不上 Frida」是两个问题，别混成一件事去排查。</span>'
      },
      {
        id: 'c19q6', depth: 3, threshold: 0.7,
        q: '<b>综合题：</b>什么时候值得自己编译 AOSP 做脱壳机 / 沙箱？请说清「源码层插桩」与「用户态 hook」的本质差别（至少三条），以及这个决定要付出什么代价。',
        concepts: [
          { label: '时序：源码插桩没有「迟到」问题；用户态 hook 必须抢在检测与关键动作之前', hint: '谁先到场？', any: ['时序', '迟到', '抢', 'spawn', '先到位', '那一刻', '顺序'] },
          { label: '隐蔽性与检测面：用户态方案的存在本身就是破绽；源码层不注入，但仍要面对完整性校验', hint: '一张是「藏好自己」，一张是「成为它的一部分」。', any: ['隐蔽', '检测', '注入', '破绽', '特征', '完整性', '没注入', '就是它'] },
          { label: '覆盖面：用户态只能拦有符号、可 hook 的调用；源码层能覆盖到内部调用，包括没有符号的函数', hint: '直接 SVC 和内部函数，用户态看到吗？', any: ['覆盖', '符号', '内部', '直接svc', '绕过', '全部', '没有符号'] },
          { label: '代价：源码/分支/机型匹配、编译与刷机成本、每个安卓大版本重新适配、设备风险自担', hint: '盖房子比租房子贵在哪里？', any: ['成本', '编译', '刷机', '适配', '版本', '机型', '维护', '变砖', '风险'] },
          { label: '选型判据：我要观测的那个事实，在用户态能不能被观测到', hint: '这不是「谁更高级」的问题。', any: ['判据', '能不能看到', '用户态', '观测点', '目标', '值不值得', '能不能观测'] }
        ],
        hints: [
          '把两种方案放在「时序、隐蔽性、覆盖面」三个维度上比，就能看出它们各自的天花板在哪。',
          '再想清楚：源码插桩解决了「你在场」的问题，但它有没有引入新的问题？'
        ],
        probes: [
          '追问：源码插桩之后，App 的完整性校验还能发现你吗？为什么？',
          '再追问：如果你的目标只是搞清一个 App 某个按钮背后的网络请求，你会为了它去编译 AOSP 吗？说说你的判断依据。'
        ],
        model: '<b>本质差别（三条）：</b><br><br>' +
          '<b>① 时序。</b>用户态 hook 必须「抢在目标之前到位」——晚一步，检测已经跑完、或者关键动作（比如 dex 加载、JNI 注册）已经发生。' +
          '源码层插桩没有这个问题：<b>插桩代码本身就是流程的一部分</b>，事件发生的那一刻你必然在场。' +
          '这是两条路线最不可替代的差别。<br><br>' +
          '<b>② 隐蔽性 / 检测面。</b>用户态方案要花大量精力「藏好自己」（改端口、改名、过滤 maps、反检测），' +
          '因为你的存在本身就是破绽。源码层方案不走注入那条路——<b>你就是那个进程</b>，所以「检测注入」这一类手段对你无效。' +
          '但要清楚它没有解决所有问题：<b>完整性校验仍然可能发现你改过系统或代码</b>，这是两回事。<br><br>' +
          '<b>③ 覆盖面。</b>用户态只能拦到「有符号、能 hook」的调用；对手只要直接发 SVC、把调用内联、或自实现加载器，就能绕过你。' +
          '源码层插桩覆盖到你插的那一层的<b>全部</b>调用，包括没有符号的内部函数——这正是第 4 章在 <code>RegisterNatives</code> 处插桩的意义。<br><br>' +
          '<b>代价（必须一起算）：</b>要有和目标设备匹配的源码分支与内核、要付出编译环境成本、刷机有不可恢复的风险（第 2 章案例里作者专门强调过 anti-rollback），' +
          '<b>而且这不是一次性投入</b>——每个安卓大版本来了都要重新定位插桩点（第 12 章整章都在讲这件事）。<br><br>' +
          '<b>选型判据（一句话）：</b>问自己「我要观测的那个事实，在用户态能不能被观测到？」' +
          '能 → 用户态 hook 更快更便宜；不能（JNI 绑定的那一刻、dex 被加载进 ART 的那一刻、没有符号的内部调用）→ 只有源码层。<br><br>' +
          '<span class="hit">这不是「谁的方案更高级」，而是「哪个观测点能看到你要的事实」。' +
          '把这句判据用熟了，你就不会在「该用脚本的时候去刷机、该刷机的时候死磕脚本」之间来回浪费。</span>',
        after: '<p style="margin-bottom:0">到这一题，你应该能把整章串起来了：<b>判定解决「对手是什么」，选型解决「我该站在哪里看」。</b>' +
               '两个问题都答完，脱壳这件事才从「碰运气」变成「有流程」。</p>'
      }
    ]
  }
};
