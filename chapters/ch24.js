/* 第 24 章 · Frida + FART 脱壳进阶
   数据文件：window.CHAPTER
   本文件是浏览器数据脚本（纯声明式 window.CHAPTER 赋值）。
   所有交互组件在 sections 里按顺序挂载。 */
window.CHAPTER = {
  no: 24,
  title: 'Frida + FART 脱壳进阶',
  lede: '第 16 章已经把“壳怎么加载、FART 怎么主动调用”讲透了，本章不重复。这里只补新的东西：<strong>fdex2 的另一条路线</strong>、<strong>高版本 ART 的适配坑</strong>、<strong>定制版 jadx</strong>、<strong>Hook ART 解释器引擎</strong>、<strong>JNI 动态绑定对抗</strong>，以及本章真正的重点——<strong>Frida 特征检测与反检测的完整攻防对照</strong>。',
  meta: [
    '核心问题：<b>“dex 加载完成”和“方法体可用”是两件事</b>——混淆它们，你就会 dump 出一堆空骨架',
    '关键工具：<b>fdex2 · FART · 定制版 jadx · Frida Interceptor / Stalker · frida-gadget</b>',
    '对手：<b>抽取壳 · CompactDex · 被 OLLVM 混淆过的 Frida 检测</b>'
  ],

  sections: [
    /* ================= 24.1 回望与定位 ================= */
    {
      h: '24.1',
      title: '回望：位置对齐，然后立刻向前',
      intuition: {
        tag: '直觉模型 · 壳与“回填”',
        body: '<p>把 dex 想象成一本<b>活页书</b>。一代壳是把整本书锁进保险箱，开箱那一刻书就是完整的；抽取壳则是把每一页的<b>正文</b>撕走，只留下页码和标题——你查目录，目录齐全；你翻到某一页，那一页是空的。<b>只有当程序真的执行到那个方法，正文才会被现场贴回来。</b>所以“书已经开箱了”和“这一页有字”完全是两件事。这条分界线，是本章所有技术的岔路口。</p>'
      },
      html: T.note('key', '🔑 本章主线', '<p>第 16 章回答的是<b>“怎么把 dex 从内存里抠出来”</b>。本章回答三个更靠后的问题：<b>①</b> 除了 FART 的主动调用，还有没有别的路线（fdex2），它的边界在哪；<b>②</b> 抠出来的 dex 打不开怎么办（定制版 jadx）；<b>③</b> 工具本身被目标 App 检测了怎么办（Frida 检测与对抗）。</p>')
        + T.tbl(['壳的类型', '静态文件里有什么', '内存里什么时候完整', '本路线是否够用'], [
          ['不加密 / 仅混淆', '完整 dex', '一直都是', '直接 jadx'],
          ['一代壳（整体加密）', '加密 blob', 'dex 映射进内存的那一刻', '<b>fdex2 足够</b>'],
          ['抽取壳（抽走方法体）', '结构完整、code_item 空', '每个方法<b>首次执行</b>后才补上', '<b>必须主动调用</b>']
        ])
        + T.note('', '📌 本章不重复的部分', '<p>ClassLoader 双亲委派、dex 加载全流程、FART 主动调用的实现细节，都在第 16 章。这里默认你已经有那套骨架，只做位置对齐。</p>'),
      after: '<p>下面两节先把 fdex2 这条“另一条路线”讲完，再用一个对照舞台把它和 FART 的差异钉死。</p>'
    },

    /* ================= 24.2 fdex2 原理 ================= */
    {
      h: '24.2',
      title: 'fdex2 原理：在 dex 映射进内存的那一刻落盘',
      html: '<p>fdex2 的路线一句话就能说完：<b>不主动调用任何方法，而是 Hook ART 里 DexFile 的加载／构造流程，在 dex 被映射进内存的那一瞬间把它整块写出来。</b></p>'
        + T.grid(2, [
          T.card('它的优势', '<p>实现简单，一个 Frida 脚本就能跑；不遍历方法、不执行目标代码，<b>对一代壳几乎是“脚本一跑就出结果”</b>；对带反调试的 App 也更温和——你不需要让它把业务逻辑全跑一遍。</p>'),
          T.card('它的死穴', '<p>抽取壳在“映射完成”那一刻，方法体的 <span class="term" data-def="dex 中描述一个方法的代码单元，含寄存器数、insns 指令数组等字段">code_item</span> 还是空的。<b>dump 得再早、再完整，拿到的也只是一副骨架。</b>因为它锚定的是 ' + T.term('映射时机', 'dex 被映射进进程内存的那个瞬间——fdex2 唯一关心的坐标') + '，而抽取壳的内容要等到 ' + T.term('回填时机', '壳把解密后的方法体写回 code_item 的时刻，由方法首次执行触发') + ' 才存在。</p>')
        ])
        + T.note('warn', '⚠️ 一句话记住差异', '<p>FART 走<b>“主动调用 → 触发回填”</b>；fdex2 走<b>“Hook 加载流程 → 抢在回填之前 dump”</b>。前者慢但全，后者快但浅。<b>它们不是替代关系，是按壳型选工具的关系。</b>' + T.term('一代壳', '整体加密 dex 文件的加固方式：文件落地时是密文，一旦解密映射进内存，内容就是完整的') + ' 用前者，' + T.term('抽取壳', '保留 dex 完整结构、只抽走方法体指令的加固方式：内容要等方法首次执行时才回填') + ' 必须用后者。</p>')
        + T.code('<span class="c">// fdex2 的核心只有三步：定位 DexFile → Hook 构造/Open → 把内存写出</span>\n<span class="c">// 下面用 Frida 伪代码走一遍，重点看“dump 发生在哪一行”</span>'),
      stepper: {
        title: 'fdex2 执行流程（注意右侧“方法体回填”这一列）',
        lines: [
          {
            code: '<span class="f">Java.perform</span>(<span class="k">function</span> () {',
            note: '<b>第一步永远是等 VM 就绪。</b>Java.perform 的回调在 Java VM 起来之后执行，此时才有条件做 Java 层 Hook。它解决的是“时序”问题，不解决“隐蔽性”问题。',
            state: { '当前阶段': '等待 VM', '内存中的 dex': '—', '方法体回填': '—', '已落盘': '0' }
          },
          {
            code: '  <span class="k">var</span> DexFile = <span class="f">Java.use</span>(<span class="s">&#39;dalvik.system.DexFile&#39;</span>);',
            note: '<b>定位目标类。</b>在 Android 5/6 上，DexFile 是 Java 层可以直接 use 的类，构造函数接收文件路径。<b>高版本这条路会变</b>——见 24.3。',
            state: { '当前阶段': '定位 DexFile', '内存中的 dex': '尚未加载', '方法体回填': '—', '已落盘': '0' }
          },
          {
            code: '  DexFile.<span class="f">$init</span>.<span class="f">overload</span>(<span class="s">&#39;java.lang.String&#39;</span>, <span class="s">&#39;java.lang.ClassLoader&#39;</span>)',
            note: '<b>挑对重载是关键。</b>DexFile 的构造重载在不同版本上签名不同 <span class="pill warn">待核实</span>，选错了 hook 不会触发——这是“脚本跑了但什么都没 dump 到”的头号原因。',
            state: { '当前阶段': '选重载', '内存中的 dex': '尚未加载', '方法体回填': '—', '已落盘': '0' }
          },
          {
            code: '    .<span class="f">implementation</span> = <span class="k">function</span> (path, loader) {',
            note: '<b>替换实现，等待触发。</b>注意：这里换掉的是一个正常业务函数，任何异常都会直接让 App 在这个点上崩掉，所以实现里必须 try/catch。',
            state: { '当前阶段': '已挂钩，等待 App 加载 dex', '内存中的 dex': '尚未加载', '方法体回填': '—', '已落盘': '0' }
          },
          {
            code: '    <span class="k">var</span> df = <span class="k">this</span>.<span class="f">$init</span>(path, loader);',
            note: '<b>先调用原实现。</b>这一步让 dex 正常完成 mmap、校验、注册到 ClassLoader。<b>不要把原逻辑吞掉</b>——吞掉的结果是 App 加载不到类，你 dump 到的也只是一坨没被 ART 认可的字节。',
            state: { '当前阶段': '原实现执行中', '内存中的 dex': '映射进行中', '方法体回填': '未开始', '已落盘': '0' }
          },
          {
            code: '    <span class="f">dumpMem</span>(df);   <span class="c">// ← 关键时刻：dex 已在内存里</span>',
            note: '<b>这就是 fdex2 的全部价值所在。</b>函数返回时 dex 已经被映射进内存，此刻整块拷出来就是一份可读的 dex。<b>但请盯住右边两列</b>：dex 是完整的，方法体却是空的。',
            state: { '当前阶段': 'dump', '内存中的 dex': '✅ 已映射完成', '方法体回填': '❌ 全部为空', '已落盘': '1' }
          },
          {
            code: '    <span class="k">return</span> df;',
            note: '<b>把原对象还回去。</b>对 App 来说什么都没发生——这是 fdex2 相对温和的原因，也是它不容易被“行为异常检测”抓到的地方。',
            state: { '当前阶段': '返回', '内存中的 dex': '✅ 已映射完成', '方法体回填': '❌ 全部为空', '已落盘': '1' }
          },
          {
            code: '  };  });',
            note: '<b>挂钩常驻。</b>App 后续每加载一个 dex（插件化、多 dex、动态下发）都会再触发一次，这是 fdex2 对“动态加载的 dex”天然友好的原因。',
            state: { '当前阶段': '挂钩常驻', '内存中的 dex': '按需触发', '方法体回填': '依旧为空', '已落盘': '随加载递增' }
          },
          {
            code: '<span class="c">// dumpMem 内部：读 dex 起始地址 + header.file_size，整块写出</span>',
            note: '<b>怎么知道拷多少字节？</b>读 dex 头的 <span class="mono">file_size</span> 字段最直接；也可以在内存里按魔数 <span class="mono">dex\\n035\\0</span> 向后搜索、按头部长度截取。高版本要额外认 <span class="mono">cdex001\\0</span> 魔数（见 24.3）。',
            state: { '当前阶段': '定位起始与长度', '内存中的 dex': '✅ 已映射完成', '方法体回填': '❌ 全部为空', '已落盘': '1' }
          },
          {
            code: '<span class="c">// 结果：一代壳 → 完整 dex；抽取壳 → 结构完整、方法体全空</span>',
            note: '<b>同一份脚本，两种命运。</b>这正是 FART 主动调用存在的全部意义——它不抢时间点，它<b>制造执行</b>，把还没被回填的方法主动喂给 ART 跑一遍，逼回填发生。',
            state: { '当前阶段': '收尾', '内存中的 dex': '✅ 已映射完成', '方法体回填': '取决于壳型', '已落盘': 'N' }
          }
        ]
      },
      after: '<p>fdex2 不是“过时的技术”，它是<b>按壳型选工具</b>这个思路的第一个实例。下面的舞台会把两条路线并排跑给你看。</p>'
    },

    /* ================= 24.3 高版本适配 ================= */
    {
      h: '24.3',
      title: '高版本 Fdex2 实现：为什么老脚本在新系统上“找不到类”',
      html: '<p>把 Android 5/6 上跑得飞起的 fdex2 脚本拿到 Android 9 的机器上，最常见的现象不是报错，而是<b>静默失败</b>：脚本加载成功、App 正常运行、dump 目录里什么都没有。原因只有一个——<b>你要 hook 的那个东西，在高版本上已经不是那个样子了</b>。</p>'
        + T.card('Android 8.0 之后 ART 变了什么', '<ul><li><b>DexFile 的构造与字段布局改变</b>：针对旧版写死的构造函数签名与偏移，在新版上对不上号。</li><li><b>引入 CompactDex</b>：一种为省内存而优化的 dex 变体，指令操作数被重编码，魔数与标准 dex 不同。</li><li><b>加载逻辑搬家</b>：部分版本把 dex 加载挪进了 <span class="mono">ClassLinker</span> / <span class="mono">DexFileLoader</span> 这类内部组件，Java 层看到的东西只是壳。</li></ul><p>结论：<b>不是脚本写错了，是坐标系换了。</b></p>')
        + T.note('key', '🔑 适配方法论（比记具体函数名重要得多）', '<p>不要背函数名，要背<b>定位流程</b>：<b>①</b> 确定目标机型的 Android 版本与 ART 实现；<b>②</b> 找到该版本对应的 AOSP 源码（或直接反编译设备上的 <span class="mono">libart.so</span>）；<b>③</b> 在源码里搜索 “dex 完成映射”的那个点——通常围绕 <span class="mono">DexFile::Open</span> / <span class="mono">DexFileLoader</span> 一类的入口；<b>④</b> 把 hook 目标改到那个点上。<b>换了版本就重跑一遍这个流程，这是常态，不是返工。</b></p>')
        + T.tbl(['适配层面', '低版本（5/6）常见做法', '高版本上的变化', '应对策略'], [
          ['Java 层', 'Hook <span class="mono">dalvik.system.DexFile</span> 构造', '实现下沉，Java 层可能只剩转发', '改 Hook <span class="mono">DexPathList</span> / <span class="mono">BaseDexClassLoader</span> <span class="pill warn">各版本差异待核实</span>'],
          ['Native 层', 'Hook <span class="mono">DexFile::DexFile</span> 构造', '构造与字段布局变动', '按 AOSP 源码重新定位入口'],
          ['数据格式', '标准 dex 魔数 <span class="mono">dex\\n035\\0</span>', '可能出现 <span class="mono">cdex001\\0</span>', 'dump 时同时认两种魔数'],
          ['加载路径', '集中在 DexFile 里', '部分版本拆分到 <span class="mono">DexFileLoader</span> / <span class="mono">ClassLinker</span>', '在拆分后的入口处下钩']
        ])
        + T.note('warn', '⚠️ 一个更稳的兜底思路：不 Hook，改扫描', '<p>既然“加载点”会随版本漂移，那就退一步——<b>不关心它是怎么加载的，只关心内存里出现了没有</b>。周期性扫描进程可读内存，搜索 dex / cdex 魔数，找到就按头部 <span class="mono">file_size</span> 截取落盘。优点：<b>几乎不受 ART 版本影响</b>；缺点：扫描开销大、可能命中缓存里的残缺副本，需要去重与合法性校验。</p>')
        + T.note('bad', '🚫 两个高版本上的实际坑', '<p><b>坑一：dump 出来的是“加速过的 dex”。</b>ART 运行时会把部分指令替换成内部 quick 形式，直接落盘后反编译器可能不认，需要先做还原（FART 系工具里有对应处理）。<b>坑二：CompactDex 不是标准 dex。</b>拿到 cdex 别急着骂工具，先确认魔数，再决定是找转换手段还是换支持它的分析链。<span class="pill warn">转换细节待核实</span></p>'),
      after: '<p>记住这一节的方法论：<b>版本变了，就回到源码里重新找“dex 完成映射”那个点。</b>下一节我们把这条路线和第 16 章的 FART 并排跑一遍。</p>'
    },

    /* ================= 24.4 路线对比 stage ================= */
    {
      h: '24.4',
      title: '路线对比：fdex2 与 FART 对同一目标的效果差异',
      html: '<p>下面这个舞台把两条路线并排跑。目标是一个<b>抽取壳</b>的 App（结构完整、方法体被抽走）。<b>请重点看第 5 步之后两条路的分岔。</b></p>',
      stage: {
        title: 'fdex2（Hook 加载） vs FART（主动调用）',
        speed: 1900,
        render: '<div class="grid2">'
          + '<div class="card"><div class="card-title">路线 A · fdex2：抢在回填之前 dump</div>'
          + '<div class="flow-col">'
          + '<span class="blk" id="fx1">① App 启动</span>'
          + '<span class="blk" id="fx2">② ClassLoader 加载 dex</span>'
          + '<span class="blk" id="fx3">③ dex 映射进内存</span>'
          + '<span class="blk" id="fx4">④ 立刻 dump 落盘</span>'
          + '<span class="blk" id="fx5">⑤ 检查方法体</span>'
          + '</div><p id="fxp" class="pill">等待开始</p></div>'
          + '<div class="card"><div class="card-title">路线 B · FART：制造执行，逼回填</div>'
          + '<div class="flow-col">'
          + '<span class="blk" id="fr1">① App 启动</span>'
          + '<span class="blk" id="fr2">② 枚举 DexFile 里的全部方法</span>'
          + '<span class="blk" id="fr3">③ 逐个主动调用（Invoke）</span>'
          + '<span class="blk" id="fr4">④ ART 回填 code_item</span>'
          + '<span class="blk" id="fr5">⑤ 再 dump</span>'
          + '</div><p id="frp" class="pill">等待开始</p></div>'
          + '</div>'
          + '<div class="note" id="cnc" style="margin-top:10px"><div class="note-h">结论区</div><p class="muted">跟着步骤走，结论会在最后一步给出。</p></div>',
        reset: () => {
          ['fx1','fx2','fx3','fx4','fx5','fr1','fr2','fr3','fr4','fr5'].forEach((i) => S(i, ''));
          CLS('fxp', 'pill'); SET('fxp', '等待开始');
          CLS('frp', 'pill'); SET('frp', '等待开始');
          CLS('cnc', 'note'); SET('cnc', '<div class="note-h">结论区</div><p class="muted">跟着步骤走，结论会在最后一步给出。</p>');
        },
        steps: [
          { run: () => { S('fx1', 'active'); S('fr1', 'active'); },
            note: '<b>起点相同。</b>同一个抽取壳 App，同一个时刻。此时内存里的 dex 结构完整，但每个方法的 <span class="mono">code_item</span> 都是空壳——<b>方法还没被执行过，正文还没贴回来。</b>' },
          { run: () => { S('fx1', 'done'); S('fx2', 'active'); S('fr1', 'done'); S('fr2', 'hot'); },
            note: '<b>第一个分岔点。</b>fdex2 在等“加载完成”这个<b>时间点</b>；FART 在干一件完全不同的事——<b>枚举 dex 里的所有方法</b>。一个盯着事件，一个盯着对象集合。' },
          { run: () => { S('fx2', 'done'); S('fx3', 'hot'); },
            note: '<b>fdex2 到达它的黄金时刻。</b>dex 被 mmap 进内存，整块字节都在那里，随时可以拷走。<b>此刻 FART 那边还没产生任何输出</b>——这正是很多人第一次看 FART 时的困惑：“它怎么这么慢？”' },
          { run: () => { S('fx3', 'done'); S('fx4', 'active'); CLS('fxp', 'pill ok'); SET('fxp', 'dump 成功：文件结构完整 ✓'); },
            note: '<b>fdex2 dump 完成，而且“看起来非常成功”。</b>文件头正常、类列表正常、方法名正常。<b>陷阱就在这里</b>——如果你只用文件大小和类数量判断成败，你会以为已经脱壳完成。' },
          { run: () => { S('fx4', 'done'); S('fx5', 'hot'); S('fr2', 'done'); S('fr3', 'active'); },
            note: '<b>第二个分岔点，也是本章的核心。</b>fdex2 开始检查方法体，发现<b>全是空的</b>；FART 同时进入正题——<b>主动调用</b>。注意 FART 不是在“猜”哪些方法需要回填，它是<b>无差别地把所有方法都跑一遍</b>，因为壳不会告诉你它抽了哪些。' },
          { run: () => { S('fx5', 'hot'); CLS('fxp', 'pill bad'); SET('fxp', '❌ 方法体全空（抽取壳）'); S('fr3', 'done'); S('fr4', 'active'); },
            note: '<b>FART 的主动调用触发了 ART 的回填机制。</b>方法一旦被执行，ART 就必须把它的 <span class="mono">code_item</span> 补全——<b>这是个副作用，壳拦不住</b>。所以 FART 拿到的不是“抢来的时间差”，而是“被逼出来的完整性”。' },
          { run: () => { S('fr4', 'done'); S('fr5', 'active'); CLS('frp', 'pill ok'); SET('frp', 'dump 成功：方法体完整 ✓'); },
            note: '<b>FART 在回填之后再 dump。</b>同样一块内存，同样一次 dump 操作，结果却完全不同——<b>差异不在 dump 技术，而在 dump 时机。</b>这就是“为什么需要主动调用”的全部答案。' },
          { run: () => { S('fr5', 'done'); S('fx5', 'done'); CLS('frp', 'pill ok'); CLS('cnc', 'note ok'); SET('cnc', '<div class="note-h">✅ 结论：一句话记住两条路线</div><p>fdex2 抢的是<b>时间点</b>（dex 映射进内存的那一刻），所以它天然只能拿到“那一刻已经存在的东西”；FART 制造的是<b>执行</b>（主动调用），所以它能让还不存在的东西<b>变成存在</b>。<br><b>一代壳 → fdex2 一行脚本搞定；抽取壳 → 必须主动调用，没有捷径。</b>而实战中你会两个都用：先用 fdex2 快速拿壳的骨架，再用 FART 补齐方法体。</p>'); },
            note: '<b>实战收尾：两条路线是互补的，不是互斥的。</b>fdex2 拿骨架快、隐蔽；FART 补齐方法体全、但慢且有执行风险。<b>成熟的做法是先 fdex2 摸清有几个 dex、壳类型是什么，再决定要不要上 FART。</b>' },
          { run: () => { CLS('cnc', 'note key'); SET('cnc', '<div class="note-h">🔑 顺着这条线再想一步</div><p>FART 的主动调用只能覆盖“<b>被调用过的方法</b>”。所以实战里有一个看起来很土但极有效的技巧：<b>把 App 的每个功能都点一遍</b>——按钮、菜单、次级页面、设置项。你点到的功能，它的方法才会被执行、才会被回填、才会出现在你 dump 出来的 dex 里。<br><b>脱壳的完整度，等于你触发的执行路径的覆盖度。</b>（这也是 24.6 节 Hook 解释器的直接用处：它告诉你哪些方法真的跑过了。）</p>'); },
            note: '<b>把这一步和 24.6 连起来看。</b>“点遍所有按钮”不是玄学，它是<b>在人工制造回填覆盖</b>。下一节先解决 dump 完打不开的问题，再回头讲解释器。' }
        ]
      }
    },

    /* ================= 24.5 定制版 jadx ================= */
    {
      h: '24.5',
      title: 'FART 与定制版 jadx：dump 出来的 dex 为什么打不开',
      html: '<p>第一次用 FART 成功 dump 之后，绝大多数人的下一个动作是把 dex 拖进 jadx，然后收到一句冷冰冰的 <span class="mono">Invalid dex file</span>。<b>这不是你 dump 错了，这是 FART 产物的常态。</b></p>'
        + T.card('FART dump 出来的 dex 常见的结构缺陷', '<ul><li><b>校验字段不符</b>：文件头的 <span class="term" data-def="dex 头部的 Adler-32 校验值，覆盖除 magic 与 checksum 自身之外的整个文件">checksum</span>（Adler-32）与 <span class="term" data-def="dex 头部的 SHA-1 签名，覆盖除 magic、checksum、signature 之外的整个文件">signature</span>（SHA-1）与实际内容对不上——因为内容被改过（回填），但头部没重算。</li><li><b>map 段问题</b>：<span class="mono">map_off</span> 指向的 map 段可能缺失、错位或与实际区块不一致。</li><li><b>指令长度不一致</b>：被抽取的 code_item 回填后，<span class="mono">insns_size</span> 与实际指令数可能对不齐。</li><li><b>跨 dex 引用断裂</b>：多个 dex 之间的类型/方法引用关系可能断掉。</li></ul>')
        + T.grid(2, [
          T.card('jadx 的反应：直接拒绝', '<p>jadx 对 dex 结构有严格校验。遇到 checksum 不匹配或 map 段异常，它的选择是<b>拒绝加载</b>并报 <span class="mono">Invalid dex file</span> / <span class="mono">checksum mismatch</span>。<br>从工程角度这是对的——<b>静默接受损坏输入会产出更难排查的错误结果</b>。</p>'),
          T.card('定制版 jadx 在做什么', '<p>把校验<b>放宽</b>：跳过 checksum 验证、容忍 map 段异常、在结构字段不一致时尽量按“能读到什么就用什么”的方式继续解析。<br><b>代价</b>：可能产出不完整的伪代码；<b>收益</b>：总比完全看不到强。</p>')
        ])
        + T.note('key', '🔑 三条路，按顺序试', '<p><b>① 修</b>：用 FART 自带的修复组件先修 dex（重算 checksum / signature、重建 map 段），再喂给原版 jadx——<b>能得到质量最好的结果，优先走这条</b>。<b>② 忍</b>：直接用定制版 jadx，接受伪代码可能缺失。<b>③ 换</b>：用 <span class="mono">baksmali</span> 反汇编成 smali 看。smali 是逐条指令的展开，对结构问题的容忍度通常比 jadx 高——<b>结构坏了，jadx 直接罢工，baksmali 往往还能吐出大部分内容。</b></p>')
        + T.note('', '📌 判断顺序：先确认是“结构问题”还是“内容问题”', '<p>打不开 = 结构问题 → 修头 / 换工具。<br>打得开但方法体是空的 = 内容问题（回填没发生）→ <b>回到 24.4，去补主动调用和功能覆盖</b>，修文件头是没用的。</p>'),
      quiz: {
        id: 'q10-1', chapter: 10, answer: 1,
        stem: '你用 FART dump 出若干 dex，jadx 报 <span class="mono">checksum mismatch</span> 拒绝加载。最合理的第一步是？',
        options: [
          { t: '把 dex 拖进十六进制编辑器，手工把 checksum 字段改成 0，让 jadx 不再报错', why: '把校验值清零并不能让文件变正确，只会让后续解析在更靠后的位置出问题——而且 checksum 是内容算出来的，改字段改不掉内容的不一致。' },
          { t: '先用 FART 自带的修复组件重算头部（checksum / signature）并修复 map 段，再用原版 jadx 打开', why: '正确。先修再解，能拿到质量最好的结果。定制版 jadx 是“修不了时”的退路，不是首选。' },
          { t: '放弃 jadx，改用十六进制编辑器人工阅读字节码', why: 'dex 字节码人工阅读的成本高到不现实，只在定位极个别疑难方法时才值得，不能作为常规流程。' },
          { t: '重新跑一次 FART，多 dump 几次，总有一次文件头是对的', why: '回填必然改变内容、必然导致头部校验失配，这是结构性问题，重跑不会自愈。' }
        ],
        explain: '<b>关键是分清“结构问题”和“内容问题”。</b>checksum / signature 失配、map 段错位属于<b>结构问题</b>——文件本身的内容是对的，只是描述它的元数据没跟上，所以<b>修元数据</b>（①）优先级最高，其次是<b>放宽校验的定制版 jadx</b>（②），再次是<b>换容忍度更高的反汇编器 baksmali</b>（③）。<br>而如果 dex 能打开、类和方法都在、方法体却是空的，那是<b>内容问题</b>——回填根本没发生，此时修文件头毫无意义，必须回到主动调用与执行覆盖上。'
      }
    },
    /* ================= 24.6 Trace ART 解释器 ================= */
    {
      h: '24.6',
      title: '编写 Frida 脚本 Trace ART 解释器引擎',
      html: '<p>前面几节我们一直在问“方法体什么时候被回填”。要回答得更精确，你需要一个能告诉你<b>“到底哪些 dex 指令真的被执行了”</b>的观察点。这个观察点就在 ART 的解释器入口。</p>'
        + T.card('为什么解释器入口是最贴近 Java 语义的观察点', '<p><span class="term" data-def="ART 中逐条取指、译码、执行的组件，是未被 JIT/AOT 编译的 dex 字节码的实际执行者">ART 解释器</span>是 dex 字节码的实际执行者。<b>你在 Native 层 hook 一个 so 函数，看到的是机器指令和寄存器；你 hook 解释器入口，看到的是“哪条 dex 指令、在哪个方法里、在第几个字节偏移”。</b>后者离 Java 层语义近得多——你要脱壳、要还原控制流、要理解被混淆的检测逻辑，这个层级的可读性完全是另一个量级。</p>')
        + T.tbl(['实现', '形态', '特点', '对 Hook 的影响'], [
          ['C++ 解释器（SwitchImpl）', '一个巨大的 <span class="mono">switch (inst)</span> 分发循环', '可读性好，便于理解与下钩', '结构清晰，容易定位入口'],
          ['汇编解释器（Mterp）', '为每种字节码生成汇编 handler', '性能高，<b>是默认实现</b>', '入口是汇编，需要按符号或偏移定位 <span class="pill warn">具体版本实现细节待核实</span>']        ])
        + T.code('<span class="c">// Hook 思路骨架（示意，非可直接运行脚本）</span>\n'
          + '<span class="c">// 1) 定位解释器入口符号（可用 Module.enumerateSymbols 按关键字筛）</span>\n'
          + '<span class="k">var</span> m = <span class="f">Process.getModuleByName</span>(<span class="s">&#39;libart.so&#39;</span>);\n'
          + '<span class="c">// 2) 在入口处 Interceptor.attach，读取当前方法 / dexPC / 字节码</span>\n'
          + '<span class="c">// 3) 用 Map 去重，只记录“本方法第一次被执行”，避免日志爆炸</span>\n'
          + '<span class="c">// 4) 记录下来的方法集合 = 回填已经发生的集合 = 可以安全 dump 的集合</span>')
        + T.note('key', '🔑 解释器 Trace 在脱壳里的真正价值', '<p>抽取壳的方法体是在<b>首次执行时</b>回填的。所以你在解释器入口记录“哪些方法被执行过”，等价于拿到了<b>一份“已回填清单”</b>。<br>它直接解释了一个实战技巧：<b>跑一遍 App 的所有功能（点遍所有按钮、进所有二级页面），能让 FART 的回填覆盖更全。</b>这不是经验之谈——每一功能点击都在把新方法推进解释器，每一次进解释器都在触发一次回填。<b>你的点击覆盖率，就是脱壳完整度的上界。</b></p>')
        + T.note('warn', '⚠️ 性能警告：这是最热的代码路径', '<p>解释器入口被执行的频率是“每条字节码一次”。<b>挂上 hook 会让 App 慢几十倍，甚至直接卡死（ANR）。</b>三条纪律：<b>①</b> 只挂很短时间，采完样本立刻 detach；<b>②</b> 加条件判断，只记录你关心的类或包名；<b>③</b> 绝不在回调里做重活（字符串拼接、写文件、console.log 都要少做），先塞进内存缓冲区，最后统一导出。</p>')
        + T.note('', '📌 出问题往哪查', '<p>Hook 完全没触发 → 先确认解释器实现是 Mterp 还是 SwitchImpl，入口定位错了；<br>App 一挂就崩 → 参数读取方式与该版本调用约定不符，或符号定位到了相邻函数；<br>日志量大到卡死 → 没做去重，或没做条件过滤。</p>'),
      after: '<p>解释器 Trace 是“从执行侧看壳”的手段。接下来换到“从绑定侧看 native”——JNI 动态注册的对抗。</p>'
    },

    /* ================= 24.7 JNI 绑定 ================= */
    {
      h: '24.7',
      title: 'JNI 函数地址绑定奇技淫巧：对抗动态注册',
      html: '<p><span class="term" data-def="通过 RegisterNatives 在运行时把 Java 方法与 native 函数地址关联起来，而不是靠命名约定静态导出">动态注册</span>让加固方可以在运行时决定“哪个 Java 方法指向哪段 native 代码”，甚至可以注册多次、中途换地址。<b>你的静态分析在这里会彻底失效：so 里根本没有 <span class="mono">Java_com_xxx_Method</span> 这样的符号名。</b></p>'
        + T.tbl(['手段', '做法', '隐蔽性', '代价 / 风险'], [
          ['① Hook <span class="mono">RegisterNatives</span> 本身', '在 <span class="mono">JNIEnv</span> 函数表里找到 <span class="mono">RegisterNatives</span> 槽位，替换成自己的实现，调用原函数前打印 <span class="mono">JNINativeMethod</span> 数组（name / signature / fnPtr）', '低', '<b>改了 JNIEnv 函数表，容易被检测</b>；也可能因 Frida 本身被检测而失效'],
          ['② Hook <span class="mono">JNI_OnLoad</span>', '更早介入：so 加载时先拿到 <span class="mono">JavaVM</span>，自己 <span class="mono">GetEnv</span> 拿 <span class="mono">JNIEnv</span>，再去 hook <span class="mono">RegisterNatives</span>', '中', '需要抢在目标 so 的 JNI_OnLoad 之前完成挂钩，时序敏感'],
          ['③ 扫描内存找 mapping', '不 hook，直接读 ART 内部数据结构（<span class="mono">ArtMethod</span> 的 <span class="mono">entry_point_from_quick_compiled_code_</span>，或 <span class="mono">mirror::Class</span> 方法表），读出“Java 方法 → Native 地址”映射', '<b>最高</b>（只读不写，不触发任何 hook 检测）', '需要理解该版本 ART 的内存布局；字段偏移随版本变化'],
          ['④ Hook <span class="mono">art::JNI::RegisterNatives</span>', 'Hook ART 内部实现（不是 JNIEnv 表里的那个转发表项）', '中高', '需要知道该函数的符号或地址 <span class="pill warn">符号随版本变化，待核实</span>']
        ])
        + T.note('key', '🔑 “奇技淫巧”这四个字的含义', '<p>不是指某一招特别神，而是指<b>这些手段各有适用场景，实战中常常组合使用</b>，并要针对目标 App 的检测手段做取舍：<b>目标检测 hook 痕迹 → 走 ③ 只读扫描；目标在很早的阶段就注册 → 走 ② 抢时序；只是想快速看一眼 → 走 ① 最省事。</b>没有“最优解”，只有“对当前目标最优解”。</p>')
        + T.note('', '📌 手段 ③ 的另一层意义', '<p>“直接读 ART 内部数据结构拿映射”，本质上是<b>“定制 ART”思路的用户态版本</b>——定制 ROM 里那些脱壳组件做的也是同一件事，只不过它们能改源码、能拿到最准确的字段偏移。你在用户态用 Frida 做，受限但不需要刷机（第 26 章会展开）。</p>'),
      stepper: {
        title: '手段 ①：Hook RegisterNatives，逐个捕获 JNI 绑定',
        lines: [
          {
            code: '<span class="c">// 目标：拿到 JNINativeMethod 数组里的每一条 name / signature / fnPtr</span>',
            note: '<b>先明确要采集什么。</b><span class="mono">JNINativeMethod</span> 是一个结构体数组，每项包含三个字段：<b>方法名</b>、<b>签名</b>、<b>函数指针</b>。拿到这三样，你就重建了“Java 方法 ↔ native 代码”的完整映射——<b>这正是静态分析给不了你的东西。</b>',
            state: { '已捕获绑定': '0 条', '最近一条': '—', '函数表是否已改': '否' }
          },
          {
            code: '<span class="k">var</span> env = <span class="f">getJNIEnv</span>();',
            note: '<b>拿到 JNIEnv 指针。</b>JNIEnv 是“指向函数表的指针的指针”。<b>这里就是隐蔽性的第一个代价</b>——你必须在某个时机把这个值抓出来，常见做法是从 <span class="mono">JNI_OnLoad</span> 的第一个参数拿，或从已注册的 native 方法调用现场取。',
            state: { '已捕获绑定': '0 条', '最近一条': '—', '函数表是否已改': '否' }
          },
          {
            code: '<span class="k">var</span> table = env.<span class="f">readPointer</span>();   <span class="c">// JNIEnv → 函数表首地址</span>',
            note: '<b>解引用得到函数表。</b>JNIEnv 的布局是固定的：它自身指向一张函数指针数组，数组的每一项对应一个 JNI 函数。<b>这个布局由 JNI 规范定义，跨版本相对稳定</b>——这也是这一招能跨 Android 版本使用的原因。',
            state: { '已捕获绑定': '0 条', '函数表首地址': '0x7f...（运行时确定）', '函数表是否已改': '否' }
          },
          {
            code: '<span class="k">var</span> slot = <span class="f">idxOf</span>(<span class="s">&#39;RegisterNatives&#39;</span>);  <span class="c">// 找到槽位</span>',
            note: '<b>确定 RegisterNatives 在表里的下标。</b>这个下标由 JNI 规范固定（属于 JNINativeInterface 的固定序号）<span class="pill warn">具体数值请查 JNI 规范确认，不要凭记忆写死</span>。<b>写死下标的风险</b>：某些加固会自己造一张“影子函数表”来欺骗扫描者，此时你改的表和它实际用的表不是同一张。',
            state: { '已捕获绑定': '0 条', 'RegisterNatives 槽位': '已定位', '函数表是否已改': '否' }
          },
          {
            code: '<span class="k">var</span> orig = table.<span class="f">add</span>(slot * Process.pointerSize).<span class="f">readPointer</span>();',
            note: '<b>先备份原函数地址。</b><b>这一行是不能省的。</b>你必须保留原实现，在打印完之后转调它——否则 App 的 native 方法全部注册失败，程序立刻崩，你也拿不到后续的绑定信息。',
            state: { '已捕获绑定': '0 条', '原函数地址': '已备份', '函数表是否已改': '否' }
          },
          {
            code: 'table.<span class="f">add</span>(slot * Process.pointerSize).<span class="f">writePointer</span>(myImpl);',
            note: '<b>替换函数表项——隐蔽性正式归零。</b>从这一刻起，<b>如果 App 检查 JNIEnv 函数表、或者检查 RegisterNatives 开头的指令字节，就会发现异常。</b>这就是为什么 ③ 号方案（只读扫描）在对抗场景下更受青睐。',
            state: { '已捕获绑定': '0 条', '原函数地址': '已备份', '函数表是否已改': '<span class="miss">是（高风险）</span>' }
          },
          {
            code: '<span class="c">// myImpl(JNIEnv* env, jclass clazz, JNINativeMethod* methods, jint n)</span>',
            note: '<b>进入自己的实现。</b>参数是标准 JNI 签名：<span class="mono">env</span>、<span class="mono">clazz</span>、<span class="mono">methods</span> 数组指针、<span class="mono">n</span> 条目数。<b>注意 methods 是 Native 内存，不是 Java 对象</b>，要用 <span class="mono">Memory</span> 读取，不能直接当 Java 数组用。',
            state: { '已捕获绑定': '0 条', '条目数 n': '待读取', '函数表是否已改': '是（高风险）' }
          },
          {
            code: '<span class="k">for</span> (<span class="k">var</span> i = <span class="n">0</span>; i &lt; n; i++) { <span class="f">dumpOne</span>(methods, i); }',
            note: '<b>遍历数组。</b>每个 <span class="mono">JNINativeMethod</span> 占固定字节数（两个指针 + 一个字符串指针，<b>具体大小按架构与实现确认</b> <span class="pill warn">待核实</span>），按步长偏移依次读 name / signature / fnPtr。',
            state: { '已捕获绑定': '<b>0 → n 条（逐条增加）</b>', '最近一条': '读取中…', '函数表是否已改': '是（高风险）' }
          },
          {
            code: '<span class="f">log</span>(name + <span class="s">&#39; &#39;</span> + sig + <span class="s">&#39; -&gt; &#39;</span> + fnPtr + <span class="s">&#39; @ &#39;</span> + <span class="f">modName</span>(fnPtr));',
            note: '<b>落盘时把三个信息拼齐。</b><span class="mono">name</span> 告诉你 Java 方法名，<span class="mono">signature</span> 告诉你参数与返回类型，<span class="mono">fnPtr</span> 是 native 地址。<b>再加一步：把 fnPtr 反查所属模块并算出模块内偏移</b>——因为 so 每次加载基址都不同，<b>只有“模块名 + 偏移”才是可复用、可写进笔记的坐标。</b>',
            state: { '已捕获绑定': 'n 条', '最近一条': 'checkSign (Ljava/lang/String;)Z → 0x… @ libnative.so+0x4a2c', '函数表是否已改': '是（高风险）' }
          },
          {
            code: '<span class="k">return</span> <span class="f">orig</span>(env, clazz, methods, n);',
            note: '<b>转调原实现，把控制权还回去。</b>App 的行为完全不变，绑定正常生效。<b>至此你拿到了一份完整的映射表，而 App 只多了一次几乎不可感知的函数转发。</b>',
            state: { '已捕获绑定': 'n 条（完整）', 'App 行为': '正常', '函数表是否已改': '是（高风险）' }
          },
          {
            code: '<span class="c">// 同一个方法被反复注册 / 中途换地址的情况也能全部抓下来</span>',
            note: '<b>这是 hook 方案相对静态分析的另一个优势。</b>加固方可能先注册一份“人畜无害”的实现用于过检，运行到关键路径时再重新注册成真正的逻辑。<b>每次都打印，你就能看到地址的变化轨迹</b>——而只读扫描只能看到某一时刻的快照。',
            state: { '已捕获绑定': 'n 条（含多次注册）', '地址变化': '已记录轨迹', '函数表是否已改': '是（高风险）' }
          },
          {
            code: '<span class="c">// 采集完成后：恢复原函数表项，降低被后续检测命中的概率</span>',
            note: '<b>收尾动作常被忽略。</b>采集完立刻还原槽位，能显著降低“事后被检测”的概率；如果 App 在你 hook 期间做了自检，那就只能靠 24.8 的手段去挡检测本身了。',
            state: { '已捕获绑定': '已导出', '函数表是否已改': '<span class="hit">已恢复</span>', '下一步': '分析映射表 / 转 unidbg'}
          }
        ]
      },
      after: '<p>注意这条 stepper 里反复出现的权衡：<b>越方便的手段越容易被检测</b>。这正好引出本章的重点——Frida 检测与对抗。</p>'
    },

    /* ================= 24.7L 动手实验 ================= */
    {
      h: '24.7L', title: '动手实验：配置你的隐蔽方案，看还剩几处暴露',
      html:
        '<p>检测手段和对抗手段不是一一对应的，而是<b>一张网</b>。' +
        '改一个端口只能挡住一处，但换成 gadget 能同时挡住好几处。' +
        '这个实验让你亲手算这笔账。</p>',
      lab: {
        title: '实验：对抗手段的覆盖度推演',
        goal: '目标：找出最短的对抗组合',
        intro:
          '<p>右侧是 9 项常见的 Frida 检测。下面有 8 种对抗手段，<b>勾选你要启用的</b>，' +
          '系统会告诉你哪些检测被挡住了、哪些还暴露着。</p>' +
          '<p><b>任务：用尽量少的手段，把 9 项检测全部挡住。</b></p>' +
          '<p class="small muted">输入格式：把手段编号用空格分隔，例如 <code>1 3 5</code>。' +
          '也可以直接写名称关键词（如 <code>gadget</code>、<code>hwbp</code>）。</p>',
        inputs: [
          { key: 'pick', label: '① 你要启用的对抗手段（填编号）',
            hint: '1=改端口 2=gadget 3=hook open 4=hook strstr 5=硬件断点 6=限制 trace 7=换目录改名 8=spawn',
            ph: '例如 1 3 5', value: '2' }
        ],
        runLabel: '🔍 推演覆盖度',
        autorun: true,
        run: (v) => {
          const L = window.LABX;
          const nums = String(v.pick || '').match(/\d+/g) || [];
          const byIdx = nums.map(n => L.EVA_OPTIONS[parseInt(n, 10) - 1]).filter(Boolean);
          // 也支持名称关键词
          const kw = String(v.pick || '').toLowerCase();
          const byName = L.EVA_OPTIONS.filter(o => kw.includes(o.id.toLowerCase().split('-')[0]) && o.id.includes('-'));
          const enabled = [...new Set([...byIdx, ...byName].map(o => o.id))];

          const sweep = L.evaSweep(enabled);
          const blocked = sweep.filter(d => d.blocked).length;

          let html = '<div class="lab-kv"><span>已启用 <b>' + enabled.length + '</b> 种手段</span>'
            + '<span>挡住 <b>' + blocked + '</b> / ' + sweep.length + ' 项检测</span>'
            + '<span>剩余暴露 <b>' + (sweep.length - blocked) + '</b></span></div>';

          html += '<table class="lab-tbl"><tr><th>检测手段</th><th>状态</th><th>为什么</th></tr>';
          sweep.forEach(d => {
            html += '<tr class="' + (d.blocked ? 'same' : 'diff') + '">'
              + '<td><b>' + d.name + '</b></td>'
              + '<td>' + (d.blocked ? '✅ 已挡住' : '❌ 仍暴露') + '</td>'
              + '<td style="font-size:12px">' + d.why
              + (d.blocked ? '' : '<br><b>需要：</b>' +
                  d.needs.map(n => (L.EVA_OPTIONS.find(o => o.id === n) || {}).name || n).join('、'))
              + '</td></tr>';
          });
          html += '</table>';

          if (blocked === sweep.length) {
            html += '<div class="lab-msg pass"><b>✅ 全部挡住（用了 ' + enabled.length + ' 种手段）</b>'
              + '<div class="lab-note">完整遮蔽需要：<b>gadget + hook-open + hook-str + hwbp + limit-trace + relocate + spawn + change-port</b> —— ' +
              '基本上就是全部 8 种。<br><br>'
              + '<b>这不是巧合，而是本章最重要的认知：</b>没有"一招鲜"的隐蔽方案。' +
              '检测方只要找到一个你没堵的口子就够了，而你必须堵住<b>所有</b>口子。' +
              '<span class="miss">这就是攻防的不对称性——防守方成本远高于进攻方。</span></div></div>';
          } else {
            html += '<div class="lab-msg warn"><b>还有 ' + (sweep.length - blocked) + ' 项暴露</b>'
              + '<div class="lab-note">试着想想：哪一项手段能<b>同时</b>挡住多项检测？<br>'
              + '提示：<code>gadget</code>（编号 2）能一次挡住"线程名"和"D-Bus"两项——' +
              '因为它让 Frida 以库的形式嵌入 App，<b>根本不存在独立的 server 进程</b>。<br>'
              + '这种"一个改动覆盖多个检测点"的手段，性价比最高。</div></div>';
          }

          html += '<div class="lab-msg key"><b>🔑 从实验推出一条实践原则</b>'
            + '<div class="lab-note"><b>对抗手段要按"覆盖面"排序，不是按"好实现"排序。</b><br><br>'
            + '优先做那些<b>能同时消除多个特征</b>的改动：<br>'
            + '① <b>gadget 化</b> —— 消除独立进程带来的端口/线程名/D-Bus 三类特征<br>'
            + '② <b>hook 过滤类</b>（open / strstr）—— 消除所有"读文件找特征"和"比字符串找特征"的检测<br>'
            + '③ <b>换目录改名</b> —— 消除路径类检测<br><br>'
            + '而 <code>spawn</code> 模式、<code>硬件断点</code>属于<b>换维度</b>的思路：' +
            '它们不消除特征，而是让你<b>在对手检查之前就已经完成替换</b>，或者<b>根本不留下痕迹</b>。' +
            '这类手段不能省。</div></div>';
          return html;
        },
        expected: (v) => {
          const L = window.LABX;
          const nums = String(v.pick || '').match(/\d+/g) || [];
          const enabled = nums.map(n => L.EVA_OPTIONS[parseInt(n, 10) - 1]).filter(Boolean).map(o => o.id);
          const sweep = L.evaSweep([...new Set(enabled)]);
          const blocked = sweep.filter(d => d.blocked).length;
          const ok = blocked === sweep.length;
          return {
            ok,
            detail: ok
              ? '<b>全覆盖达成。</b>你用了 ' + new Set(enabled).size + ' 种手段挡住全部 ' + sweep.length + ' 项检测。<br>' +
                '注意一个规律：<b>能一次挡住多项的手段（如 gadget）性价比最高</b>，' +
                '而像"改端口"这种只挡一项的，应该最后才做。'
              : '<b>还有 ' + (sweep.length - blocked) + ' 项暴露：</b>' +
                sweep.filter(d => !d.blocked).map(d => d.name).join('、') + '。<br>' +
                '提示：<code>gadget</code>（编号 2）能同时挡住两项；' +
                '<code>hook-open</code>（3）挡 maps 检测；<code>hook-str</code>（4）挡字符串扫描。'
          };
        },
        showAnswer:
          '【检测项 ← 对应的对抗手段】\n' +
          '  端口扫描 27042/27043        ← 改端口（1）\n' +
          '  线程名 gum-js-loop          ← gadget（2）\n' +
          '  /proc/self/maps 找 agent    ← hook open/read（3）\n' +
          '  内存特征字符串扫描           ← hook strstr（4）\n' +
          '  D-Bus 通信检测              ← gadget（2）\n' +
          '  校验函数序言（inline hook）  ← 硬件断点（5）\n' +
          '  耗时检测（Stalker 拖慢）     ← 限制 trace 范围（6）\n' +
          '  查找 /data/local/tmp 文件    ← 换目录改名（7）\n' +
          '  TracerPid 非 0              ← spawn 抢先（8）\n\n' +
          '【要全覆盖，需要 8 种手段全上】\n' +
          '  gadget + hook-open + hook-str + hwbp\n' +
          '  + limit-trace + relocate + spawn + change-port\n\n' +
          '【关键认知】\n' +
          '  这不是"漏了一个"，而是攻防的本质不对称：\n' +
          '    检测方：找到一个口子就算成功\n' +
          '    对抗方：必须堵住所有口子\n\n' +
          '【因此的实践策略】\n' +
          '  ① 按【覆盖面】排序，不按【好实现】排序\n' +
          '     gadget 一次挡 2 项 → 优先做\n' +
          '     改端口只挡 1 项 → 最后做\n\n' +
          '  ② 区分两类手段\n' +
          '     消除特征类：gadget / hook 过滤 / 改名换目录\n' +
          '     换维度类：spawn（抢在检测前）/ 硬件断点（不留痕）\n' +
          '     后一类不能省，因为它们解决的是时序和痕迹问题，\n' +
          '     而不是"特征被看到"的问题。\n\n' +
          '  ③ 记住第 24 章的元原则：\n' +
          '     混淆保护的是逻辑，保护不了副作用。\n' +
          '     同理，隐藏做得再好，也挡不住"时序"上的抢先检测。',
        hint:
          '先别急着勾。按这个顺序想：<br>' +
          '① <b>哪些手段能一次挡住多项检测？</b>比如让 Frida 不再是独立进程，' +
          '是不是端口、线程名、D-Bus 这几项就一起没了？<br>' +
          '② <b>哪些检测根本不看"特征"，而是看"时序"或"内存痕迹"？</b>' +
          '这类必须用专门的思路（抢先注入 / 不改内存）才能解决。<br><br>' +
          '试试只勾 <code>2</code>（gadget），看能挡住几项。',
        after:
          T.note('key', '🔑 这个实验的真正价值',
            '<p style="margin-bottom:0">它不是让你背"哪个手段对应哪个检测"——<b>那张表会过期</b>。<br>' +
            '它要建立的是一条<b>决策直觉</b>：<br><br>' +
            '<b>攻防是不对称的。</b>对手只要找到一个你没堵的口子就赢了；' +
            '而你必须堵住所有口子。<br>' +
            '所以实践中<b>不要追求"完美的隐藏"</b>——那是做不到的——' +
            '而要追求<b>"在对手检查的那一刻，我已经完成了我要做的事"</b>。<br><br>' +
            '<span class="hit">这就是为什么 spawn 模式和硬件断点这么重要：' +
            '它们把问题从"如何不被发现"转化成了"如何抢在发现之前"和"如何不留痕迹"——' +
            '换了个维度，问题就变得可解了。</span></p>')
      }
    },

    /* ================= 24.8C 实战案例 ================= */
    {
      h: '24.8C', title: '实战案例：某学习 App 的 Frida 检测绕过',
      case: {
        source: 'kanxue',
        title: '[原创]对某学习APP的frida检测绕过',
        date: '2026-8-16',
        author: 'wes1meanon',
        target: '某学习 APP（包名打码，版本 6.7.7 → 6.7.8）；libDexHelper.so、libmsaoaidsec.so',
        background:
          '<p>2026 年的一篇看雪原创帖。目标是一个学习类 App，作者把包名打了码，只说明版本从 <b>6.7.7 走到 6.7.8</b>；' +
          '样本里有两个关键 so：<code>libDexHelper.so</code> 和 <code>libmsaoaidsec.so</code>。</p>' +
          '<p>整个过程很有意思：作者一开始按常规思路 dump，被壳自 hook 的 <code>open</code>/<code>write</code> 反制（<code>Permission denied</code>），' +
          '换成<b>纯 syscall dump</b> 才成功；随后一路从「frida 死在 JNI_OnLoad 里面」追到两个 so 的检测原语，' +
          '最后发现真凶是一段运行时解密出来的 <b>28 字节内联 shellcode</b>。</p>',
        points: [
          '常规 dump 被壳自身 hook 的 <code>open</code>/<code>write</code> 反制，返回 <code>Permission denied</code>；改成<b>纯 syscall</b> dump 后成功。',
          '关键判断是「<b>frida 就是死在 JNI_OnLoad 里面</b>」⇒ 把 dump 时机卡在 <b>JNI_OnLoad 入口</b>这个最晚时机。',
          '两个 so 都带 SMC（自修改代码），用 SoFixer 修复之后才能正常反编译。',
          '两个初始化位点：DT_INIT 在 <code>libDexHelper.so+0x128098</code>，DT_INIT_ARRAY 在 <code>+0x2f650</code>。',
          'AI 辅助报告的结论：反调试总入口是 <code>sub_436bb8</code>；核心 hook 检测原语 <code>sub_432774</code>（<code>0x32774</code>）被 <b>4 处复用</b> ⇒ <b>让它恒返回 0，就能绕过所有 hook 检测</b>。',
          'kill/上报原语 <code>sub_431bc4(category, magic, 0xfff)</code> 读全局位图 <code>*(*(0x502de0)+0x164)</code>；当 <code>(flags&amp;category)==0</code> 时，清 sp/lr 后 <code>jump((magic&amp;0xfff)&amp;0xfffffffc)</code> 跳到非法低地址，直接崩溃。',
          'category 位映射：<code>0x1</code> root、<code>0x80</code> xposed、<code>0x100</code> frida、<code>0x200</code> hook、<code>0x400</code> integrity、<code>0x800</code> signature、<code>0x1000</code> debug。',
          '<code>sub_452944</code> 用 <code>process_vm_readv</code>（syscall <code>0x10e</code>）读符号开头字节，再与磁盘上的 ELF 比对。',
          '<code>sub_448f14</code> 是 IO-hook/PLT 替换框架 + 反 heap-dump，并且会把 <code>g_signal_pipe_fds</code> 写成 -1。',
          '<b>libmsaoaidsec.so 才是真凶</b>：运行时解密的 <b>28 字节内联 shellcode <code>movz x8,#94 ; svc #0 ; ret</code></b>（AArch64 的 <code>__NR_exit_group=94</code>），由 4 个执行器 <code>sub_234E0</code>/<code>sub_26334</code>/<code>sub_269AC</code>/<code>sub_260B0</code> mmap RWX 后直接执行，<b>完全不经过 libc 符号 ⇒ 符号级 hook 全部扑空</b>。',
          '绕过时机 = 该 so <b>首次调用 <code>pthread_create</code></b> 时做一次性 patch：P0 把 4 个执行器 + 统一杀点 <code>sub_11FA4</code> 全部 no-op。',
          '验证标志：日志里出现业务库 <code>libframework-connectivity-jni.so</code> / <code>libforcedarkimpl.so</code> / <code>libDWIMECore.so</code> / <code>libfntvcrash.so</code> / <code>libsecuritylib.so</code>。'
        ],
        method: [
          '先活下来：常规 dump 被反制后改纯 syscall 读内存，把 dump 时机压在 <code>JNI_OnLoad</code> 入口 —— 因为 frida 正是死在那里。',
          '修复 so 再做静态分析：两个 so 都有 SMC，先过 SoFixer，然后从 DT_INIT（<code>+0x128098</code>）与 DT_INIT_ARRAY（<code>+0x2f650</code>）两个初始化位点切入。',
          '顺着 AI 辅助报告把检测体系摸清：总入口 <code>sub_436bb8</code>、kill 原语 <code>sub_431bc4</code>、内存比对 <code>sub_452944</code>、IO-hook 框架 <code>sub_448f14</code>。',
          '找到收敛点：核心 hook 检测原语 <code>sub_432774</code> 被 4 处复用，<b>把它改成恒返回 0</b>，所有 hook 检测一起失效。',
          '定位真凶：<code>libmsaoaidsec.so</code> 里 4 个执行器 mmap RWX 后直接跑内联 shellcode，符号 hook 无效 ⇒ 放弃符号级思路。',
          '换维度收口：在 <code>libmsaoaidsec.so</code> <b>首次调用 <code>pthread_create</code></b> 时一次性 patch，把 4 个执行器与统一杀点 <code>sub_11FA4</code> 全 no-op。',
          '验证：看日志里那一串业务库（<code>libframework-connectivity-jni.so</code> 等）是否正常加载。'
        ],
        result:
          '<p>按「首次 <code>pthread_create</code> 时一次性 patch」这套方案处理后，App 正常跑起来了，' +
          '验证标志是日志里出现了一串本该被拦住的业务库：<code>libframework-connectivity-jni.so</code>、' +
          '<code>libforcedarkimpl.so</code>、<code>libDWIMECore.so</code>、<code>libfntvcrash.so</code>、<code>libsecuritylib.so</code>。</p>' +
          '<p>回看整条链，真正起作用的两处改动都不在「看懂检测逻辑」上：<b>一处是让 <code>sub_432774</code> 恒返回 0</b>，' +
          '<b>一处是把 4 个 shellcode 执行器和 <code>sub_11FA4</code> 一起 no-op</b>。</p>',
        terms: ['JNI_OnLoad', 'SMC', 'SoFixer', 'DT_INIT', 'DT_INIT_ARRAY', 'process_vm_readv', '内联 shellcode', 'mmap RWX', 'pthread_create', 'no-op patch'],
        limits:
          '<p>几点必须如实标注：</p>' +
          '<p>① <b>包名被打码</b>，样本无法自行复现验证；' +
          '② <code>libmsaoaidsec.so</code> 的厂商归属<b>存在矛盾，待核实</b> —— 作者正文称它是「字节 anti-frida 库」，' +
          '而作者粘进来的 AI 报告依据 <code>NagaLinker v8.83</code> 判定为娜迦，<b>两处说法冲突，本文不替任何一方下结论</b>；' +
          '③ 绕过脚本需要按本机 <code>linker64</code> 中 <code>call_constructors</code> 的实际位点改写，<b>不通用</b>。</p>',
        analysis:
          '<p><b>本课第 24 章的元原则是：混淆保护的是逻辑，保护不了副作用。</b>这个案例是它最好的注脚 —— ' +
          '厂商把检测逻辑摊进 <code>sub_436bb8</code> 的一大堆分支里，但无论怎么摊，' +
          '<b>最后必然要落到具体的系统调用上</b>：读内存要 <code>process_vm_readv</code>（syscall <code>0x10e</code>）、' +
          '杀进程要 <code>svc #0</code>、装 hook 要改 PLT。<b>从副作用反推逻辑，所以作者不需要读懂检测分支，只需要找到那个副作用必经的节点。</b></p>' +
          '<p>这个案例真正精彩的是<b>两个层次的收敛</b>：</p>' +
          '<p><b>第一层，把分散的杀点收敛成一处返回值。</b>kill 点散在多线程里、category 有 7 个位（<code>0x1</code> root / <code>0x80</code> xposed / ' +
          '<code>0x100</code> frida / <code>0x200</code> hook / <code>0x400</code> integrity / <code>0x800</code> signature / <code>0x1000</code> debug），' +
          '按点硬堵是个无底洞；但核心原语 <code>sub_432774</code> 被 4 处复用，<b>让这 1 个函数恒返回 0，等于一次性关掉全部 hook 检测</b>。' +
          '这就是「找最小充分改动点」在检测对抗里的形态 —— 和本课实验里「一个手段覆盖多项检测」是同一种性价比思维。</p>' +
          '<p><b>第二层，符号 hook 失效后改用时机收敛。</b><code>libmsaoaidsec.so</code> 那段 28 字节 shellcode（<code>movz x8,#94 ; svc #0 ; ret</code>）' +
          '是运行时解密、mmap RWX 后直接执行的，<b>不经过 libc 符号，你 hook <code>exit</code>、hook <code>write</code> 全部扑空</b>。' +
          '这时唯一的抓手是<b>「首次 <code>pthread_create</code>」这个时机</b>——Shellcode 还没开始跑，一次性把执行器与统一杀点全 no-op。' +
          '<span class="hit">这正是本章讲的「换维度」：不消除特征，而是抢在对手动手之前完成替换。</span></p>' +
          '<p>最后是这个案例展示的新工作流：<b>AI 辅助分析 + 人工验证</b>。' +
          'AI 报告帮着快速铺开了检测体系（总入口、kill 原语、位图映射），价值是<b>省掉大量读汇编的时间</b>；' +
          '风险同样明显 —— 报告里对 <code>libmsaoaidsec.so</code> 的厂商归属就与作者正文冲突，' +
          '<b>这类结论必须人工回二进制核实，绝不能直接采信。</b>AI 负责提出假设，验证永远是人的活。</p>',
        link: 'https://bbs.kanxue.com/thread-292547.htm',
        linkNote: '看雪论坛原创帖'
      }
    },

    /* ================= 24.8 检测 vs 对抗 stage ================= */
    {
      h: '24.8',
      title: 'Frida 检测点 vs 对抗手段：一张必须刻进脑子的对照表',
      html: '<p>前面所有技术都有一个共同前提：<b>你的 Frida 得先活下来。</b>这一节把检测点和对抗手段并排列出来，逐步演示“这个检测被这个手段挡住了”。<b>请一边看一边在脑子里建表——实战时你要靠这张表做决策，而不是靠记忆某个脚本。</b>整张表其实只有三种解法：' + T.term('隐藏自己', '改名、换端口、换 gadget、换路径——让自己不具备被识别的特征') + '、' + T.term('观察管道篡改', 'Hook 文件读取与字符串比较，让目标读到被处理过的结果') + '、' + T.term('抢时序', '在检测代码执行之前完成注入与替换，让检测从一开始就失效') + '。</p>',
      stage: {
        title: '攻防对照：左列检测点 → 右列对抗手段',
        speed: 2100,
        render: '<div class="grid2">'
          + '<div class="card"><div class="card-title">左：App 侧的检测点</div><div class="flow-col">'
          + '<span class="blk" id="d1">① 端口探测（27042 / 27043）</span>'
          + '<span class="blk" id="d2">② 进程 / 线程名（frida、gum-js-loop）</span>'
          + '<span class="blk" id="d3">③ /proc/self/maps 字符串扫描</span>'
          + '<span class="blk" id="d4">④ 内存特征 / 导出符号扫描</span>'
          + '<span class="blk" id="d5">⑤ D-Bus 通信特征</span>'
          + '<span class="blk" id="d6">⑥ inline hook 痕迹（函数头字节）</span>'
          + '<span class="blk" id="d7">⑦ 性能 / 耗时异常（Stalker 拖慢）</span>'
          + '<span class="blk" id="d8">⑧ 文件系统路径（/data/local/tmp）</span>'
          + '</div></div>'
          + '<div class="card"><div class="card-title">右：我们的对抗手段</div><div class="flow-col">'
          + '<span class="blk" id="c1">A 改名 + --listen 换非默认端口</span>'
          + '<span class="blk" id="c2">B 改用 frida-gadget（进程内，无 server）</span>'
          + '<span class="blk" id="c3">C Hook open/read 过滤 maps 内容</span>'
          + '<span class="blk" id="c4">D Hook strstr/strcmp/memmem 过滤关键词</span>'
          + '<span class="blk" id="c5">E Spawn 模式抢跑（-f 包名）</span>'
          + '<span class="blk" id="c6">F 硬件断点 / hook 掉检查函数</span>'
          + '<span class="blk" id="c7">G 避免长开 Stalker + 伪造时间</span>'
          + '<span class="blk" id="c8">H 换路径 / 减少落盘痕迹</span>'
          + '</div></div></div>'
          + '<div class="note" id="dsc" style="margin-top:10px"><div class="note-h">对照说明</div><p class="muted">逐步播放，每一步会点亮一组「检测 → 被挡住」。</p></div>',
        reset: () => {
          const ids = ['d1','d2','d3','d4','d5','d6','d7','d8','c1','c2','c3','c4','c5','c6','c7','c8'];
          ids.forEach((i) => S(i, ''));
          CLS('dsc', 'note'); SET('dsc', '<div class="note-h">对照说明</div><p class="muted">逐步播放，每一步会点亮一组「检测 → 被挡住」。</p>');
        },
        steps: [
          { run: () => { S('d1', 'hot'); },
            note: '<b>检测点 ①：端口探测。</b>默认 <span class="mono">frida-server</span> 监听 <b>27042</b> 与 <b>27043</b>。App 可以遍历 <span class="mono">/proc/net/tcp</span> 看有没有进程占着这两个端口，也可以直接尝试连接。<b>这是最古老也最省事的检测——很多加固的第一道关就是它。</b>' },
          { run: () => { S('d1', 'done'); S('c1', 'cool'); S('c2', 'cool'); CLS('dsc', 'note ok'); SET('dsc', '<div class="note-h">① → A + B</div><p><b>改名 + 换端口（A）</b>：把 <span class="mono">frida-server</span> 重命名成随便什么名字，启动时用 <span class="mono">--listen</span> 指定一个非默认端口。<b>这是最基本的第一步，成本几乎为零。</b><br><b>改用 gadget（B）</b>：gadget 是注入进 App 进程内部的一个 so，<b>不需要额外的 server 进程</b>——没有 27042、没有 frida-server 进程名。代价是需要重打包 APK 把 gadget 塞进去，或在已 root 设备上用 ptrace 注入。</p>'); },
            note: '<b>被 A + B 挡下。</b>注意这两者的层次不同：<b>A 是“让默认特征不成立”，B 是“从架构上消除这一类特征”。</b>面对只做端口探测的低强度检测，A 就够了；面对会遍历进程列表的检测，必须上 B。' },
          { run: () => { S('c1', 'done'); S('c2', 'done'); S('d2', 'hot'); },
            note: '<b>检测点 ②：进程 / 线程名。</b>读 <span class="mono">/proc/self/task/*/comm</span>，或遍历 <span class="mono">/proc</span> 找进程名，匹配 <span class="mono">frida</span>、<span class="mono">gum-js-loop</span>、<span class="mono">gmain</span>、<span class="mono">gdbus</span>、<span class="mono">linjector</span>、<span class="mono">pool-frida</span> 这些特征名。<b>注意其中一些是 Frida 内部线程名——即使你改了二进制文件名，这些线程名依然存在。</b>' },
          { run: () => { S('d2', 'done'); S('c2', 'cool'); S('c3', 'active'); CLS('dsc', 'note ok'); SET('dsc', '<div class="note-h">② → B + C</div><p><b>gadget（B）</b>消除了 server 进程名，但 <span class="mono">gum-js-loop</span> 这类<b>内部线程名仍在</b>。<br>所以要靠 <b>Hook 文件读取（C）</b>：在 <span class="mono">open</span>/<span class="mono">read</span> 层面把 <span class="mono">/proc/self/task/*/comm</span> 的内容做过滤，或者干脆让遍历 <span class="mono">/proc</span> 的结果里看不到可疑线程。<b>这是“让它读到的东西不真实”，而不是“让自己不存在”。</b></p>'); },
            note: '<b>核心思路转变。</b>从这一步开始，对抗方式从“隐藏自己”变成“<b>篡改对方的观察结果</b>”。<b>后者的天花板高得多</b>——因为你不需要真的不存在，你只需要让它以为你不存在。' },
          { run: () => { S('c3', 'done'); S('d3', 'hot'); },
            note: '<b>检测点 ③：/proc/self/maps 扫描。</b>读取自身内存映射，查找包含 <span class="mono">frida</span>、<span class="mono">frida-agent</span>、<span class="mono">frida-gadget</span>、<span class="mono">linjector</span>、<span class="mono">gum-js-loop</span>、<span class="mono">re.frida</span> 等字符串的映射项。<b>这是最常用的检测手段之一——因为注入必然留下映射，而映射很难彻底消除。</b>' },
          { run: () => { S('d3', 'done'); S('c3', 'cool'); CLS('dsc', 'note ok'); SET('dsc', '<div class="note-h">③ → C（最常用的对抗手段）</div><p><b>Hook <span class="mono">fopen</span>/<span class="mono">open</span>/<span class="mono">openat</span>/<span class="mono">read</span></b>，发现读取的是 <span class="mono">/proc/self/maps</span>（或 <span class="mono">/proc/&lt;pid&gt;/maps</span>）时，<b>返回一份“干净”的内容</b>——把含 frida 相关字符串的行删掉，其余原样返回。<br><b>这就是最常用的对抗手段。</b>它之所以有效，是因为 App 读到的永远是经过你手的副本，而不是内核给的真实映射。</p>'); },
            note: '<b>被 C 挡下，而且这是性价比最高的一招。</b>要注意两个细节：<b>①</b> 路径判断要宽——<span class="mono">/proc/self/maps</span>、<span class="mono">/proc/&lt;pid&gt;/maps</span>、软链接路径都要覆盖；<b>②</b> 要处理<b>分块读</b>的情况，如果 App 用小缓冲多次 read，你要保证过滤逻辑在多行跨块时也正确。' },
          { run: () => { S('d4', 'hot'); },
            note: '<b>检测点 ④：内存特征扫描。</b>App 自己扫描已加载模块的代码段，查找 Frida 的特征字节序列——比如 <span class="mono">gum</span> 相关字符串、trampoline 指令模式、Frida 的导出符号。<b>这比读 maps 更进一步：它不看“你叫什么名字”，而看“你的代码长什么样”。</b>' },
          { run: () => { S('d4', 'done'); S('c4', 'cool'); S('c6', 'cool'); CLS('dsc', 'note ok'); SET('dsc', '<div class="note-h">④ → D + F</div><p><b>字符串层面（D）</b>：Hook <span class="mono">strstr</span>/<span class="mono">strcmp</span>/<span class="mono">strcasecmp</span>/<span class="mono">memmem</span>，当参数命中 <span class="mono">frida</span>、<span class="mono">gum</span>、<span class="mono">gadget</span> 等关键词时<b>直接返回“未找到”</b>。<br><b>指令层面（F）</b>：如果它比对的是字节序列而不是字符串，字符串 hook 就没用了，得改用<b>硬件断点</b>（第 27 章）或<b>hook 掉那个检查函数本身</b>。</p>'); },
            note: '<b>被 D 挡下，但如果它扫的是字节序列，就要换 F。</b>这里有个重要判断：<b>先确认对方的比较方式，再选工具。</b>字符串检测 → hook 字符串函数；字节比对 → hardware breakpoint 或直接改检查函数返回值。' },
          { run: () => { S('d5', 'hot'); },
            note: '<b>检测点 ⑤：D-Bus 通信检测。</b>Frida 内部用 D-Bus 做通信，App 可以检测 D-Bus 端口或协议特征。<b>这一类检测的层次更深</b>——它不看文件名、不看字符串，看的是通信行为本身。' },
          { run: () => { S('d5', 'done'); S('c2', 'cool'); CLS('dsc', 'note ok'); SET('dsc', '<div class="note-h">⑤ → B（架构层面的解法）</div><p>换 <b>frida-gadget</b> 是最直接的方向：gadget 在进程内直接加载脚本，<b>通信路径与 server 模式不同</b>，暴露面更小。再配合 C/D 把相关的文件与字符串观察一起挡掉。<br><b>这一类检测没有“一招制胜”，要靠组合降低暴露面。</b></p>'); },
            note: '<b>⑤ 是最难完全消除的一类。</b>能做的通常是<b>降低暴露面 + 篡改观察结果</b>的组合，而不是彻底隐身。这一点要提前有心理预期。' },
          { run: () => { S('d6', 'hot'); },
            note: '<b>检测点 ⑥：inline hook 痕迹检测。</b>读取关键函数（<span class="mono">open</span>、<span class="mono">read</span>、<span class="mono">strcmp</span>）开头的几个字节，检查是否被改成了跳转指令。<b>注意：这是通用的 hook 检测，不只针对 Frida</b>——任何 inline hook 都会改函数头，所以它对 Xposed、定制 ART、甚至你自己的 hook 一视同仁。' },
          { run: () => { S('d6', 'done'); S('c6', 'cool'); S('c5', 'active'); CLS('dsc', 'note ok'); SET('dsc', '<div class="note-h">⑥ → F + E</div><p><b>F：硬件断点。</b>硬件断点靠 CPU 调试寄存器实现，<b>不改函数头字节</b>，所以字节比对检测不到它（第 27 章展开）。另一条路是 <b>hook 掉那个检查函数本身</b>——但这就变成递归对抗了：hook 检查函数又留下新的 hook 痕迹。<br><b>E：Spawn 模式抢跑。</b>用 <span class="mono">frida -f &lt;包名&gt;</span> 而不是 attach。<b>spawn 会在 App 的 main 之前注入脚本</b>，抢在反调试初始化之前把检测函数 hook 掉。</p>'); },
            note: '<b>⑥ 被 F + E 组合挡下。</b><b>时序在这里第一次成为武器</b>：不是“我的 hook 更隐蔽”，而是“我的 hook 比你的检测先执行”。<b>很多检测只要晚一步执行就彻底失效，因为它依赖的那些函数已经被你换掉了。</b>' },
          { run: () => { S('c5', 'done'); S('d7', 'hot'); },
            note: '<b>检测点 ⑦：性能 / 耗时检测。</b>指令级 Stalker 会让执行时间异常——<b>慢几十倍</b>。App 可以用耗时监控（关键函数前后打点、或外部计时）发现“有人在 trace 我”。<b>这类检测不读文件、不比字符串，前面的手段全都挡不住它。</b>' },
          { run: () => { S('d7', 'done'); S('c7', 'cool'); CLS('dsc', 'note ok'); SET('dsc', '<div class="note-h">⑦ → G</div><p><b>首先：避免长时间开 Stalker。</b>把 trace 范围限制到具体函数、具体线程，采完样本立刻停。<br><b>其次：必要时 hook <span class="mono">clock_gettime</span>/<span class="mono">gettimeofday</span>，让时间“看起来正常”。</b><br><b>但请注意</b>：伪造时间是有副作用的——App 自己的逻辑、超时判断、动画时序都可能被搞坏，<b>这是一把双刃剑，只在确实需要时用。</b></p>'); },
            note: '<b>⑦ 被 G 挡下。</b>这一类对抗的本质是<b>“减少自己的可观测痕迹”</b>，而不是欺骗观察者。<b>能用范围控制解决，就不要用伪造时间解决。</b>' },
          { run: () => { S('d8', 'hot'); },
            note: '<b>检测点 ⑧：文件系统检测。</b>查找 <span class="mono">/data/local/tmp/frida-server</span>、<span class="mono">/data/local/tmp/re.frida.server</span> 这类路径。<b>这是最“便宜”的检测——一次 stat 调用就能做完，所以加固方很爱加。</b>' },
          { run: () => { S('d8', 'done'); S('c8', 'cool'); S('c1', 'cool'); CLS('dsc', 'note ok'); SET('dsc', '<div class="note-h">⑧ → H + A</div><p><b>H：换路径、减少落盘痕迹。</b>不要把工具放在 <span class="mono">/data/local/tmp</span> 这种人尽皆知的目录；跑完清掉。<br><b>A：配合改名。</b>文件名不叫 frida-server，路径扫描的字符串匹配自然失效。<br><b>代价</b>：这些都是“卫生习惯”，能降低被发现概率，但挡不住决心强的检测。</p>'); },
            note: '<b>⑧ 被 H + A 挡下。</b>这两招都是“卫生习惯”级别的对抗——<b>成本几乎为零，但也不是铜墙铁壁。</b>它们的价值，是把“随手一查就能发现”变成“必须专门花成本去查”。<b>真正的硬仗，还是要靠篡改观察管道和抢时序。</b>' },
          { run: () => { S('c8', 'done'); S('c1', 'done'); CLS('dsc', 'note key'); SET('dsc', '<div class="note-h">🔑 把这张表带走</div><p><b>① 端口</b>（27042/27043）→ 改名 + <span class="mono">--listen</span>；<b>② 线程名</b>→ gadget + hook 文件读取；<b>③ maps</b> → hook <span class="mono">open</span>/<span class="mono">read</span> 过滤（<b>最常用</b>）；<b>④ 内存特征</b>→ hook <span class="mono">strstr</span> 系列（字符串）/ 硬件断点（字节）；<b>⑤ D-Bus</b> → gadget 架构 + 组合降低暴露面；<b>⑥ hook 痕迹</b>→ 硬件断点 / spawn 抢先；<b>⑦ 耗时</b>→ 控制 Stalker 范围，慎用伪造时间；<b>⑧ 文件路径</b>→ 换目录 + 清理。<br><br><b>一句话总结这张表的骨架：</b>能改自己就改自己（改名、换端口、换 gadget），改不了自己就去<b>改对方的观察管道</b>（hook 文件读取、字符串比较），两者都不行就<b>抢时序</b>（spawn）。</p>'); },
            note: '<b>收尾：把这张表变成决策顺序。</b>实战顺序永远是——<b>①</b> 先用最便宜的（改名、换端口、换路径）；<b>②</b> 不够就上观察管道篡改（maps 过滤、字符串过滤）；<b>③</b> 还不够就抢时序（spawn）+ 架构替换（gadget）；<b>④</b> 最后才考虑硬件断点这种重武器。<b>永远从成本最低的一招开始试。</b>' }
        ]
      },
      quiz: {
        id: 'q10-2', chapter: 10, answer: 2,
        stem: 'App 一启动就崩溃，你怀疑它有反调试。用 attach 模式挂上去，脚本还没来得及执行 App 就已经死了。最应该先换成哪种做法？',
        options: [
          { t: '把 frida-server 重命名并换一个非默认端口，然后重新 attach', why: '改名换端口解决的是“被扫描发现”，解决不了“检测在我的脚本生效之前就已经执行完了”。这是时序问题，不是特征问题。' },
          { t: '关掉所有 hook，只保留 Interceptor，减少对 App 的干扰', why: '减少 hook 不会让注入提前。崩溃发生在脚本生效之前，问题出在时序，不在于 hook 多少。' },
          { t: '改用 spawn 模式（frida -f 包名），让脚本在 App 的 main 之前注入并完成 hook', why: '正确。spawn 会在 App 主逻辑开始前注入，抢在反调试初始化之前把检测函数 hook 掉——这是解决“抢跑”类问题的标准手段。' },
          { t: '把 App 装到模拟器里跑，绕开真机上的反调试', why: '换环境有时确实有效，但模拟器本身极易被检测（属性、传感器、指令特征），而且这没有解释“为什么 attach 会输”，问题会以另一种形式回来。' }
        ],
        explain: '<b>先分清两类问题：特征问题 vs 时序问题。</b><br>App 能发现 Frida 的“存在”，是<b>特征问题</b>——对应改名、换端口、maps 过滤、字符串过滤这些手段。<br>App 在你的脚本生效前就完成了自检并退出，是<b>时序问题</b>——此时再好的隐藏也没用，因为你根本还没上场。<b>spawn 模式（<span class="mono">frida -f</span>）会在 App 的 main 之前注入脚本</b>，让你有机会先把检测函数换掉。这是“抢跑”思路的第一次登场，也是后面面对 OLLVM 混淆检测时的关键前提之一。'
      }
    },
    /* ================= 24.9 实操 term ================= */
    {
      h: '24.9',
      title: '实操：改名改端口，以及 maps 过滤前后长什么样',
      html: '<p>这一节全是动手内容。<b>先记住实战顺序：能用改配置解决的，绝不上 hook。</b>下面这套流程是遇到疑似 Frida 检测时的第一轮处理。</p>',
      term: {
        title: 'frida-server 改名改端口 + maps 过滤对照',
        lines: [
          { t: 'd', s: '# ── 阶段一：推上去、改名、换端口 ──' },
          { t: 'p', s: 'adb push frida-server-16.x.x-android-arm64 /data/local/tmp/fsx' },
          { t: 'o', s: '/data/local/tmp/fsx: 1 file pushed, 0 skipped.', note: '<b>改名从 push 那一刻就开始了。</b>落地文件名不叫 <span class="mono">frida-server</span>，针对 <span class="mono">/data/local/tmp/frida-server</span> 的路径检测直接失效。<b>注意端口检测依然成立</b>——文件名和端口是两件独立的事。' },
          { t: 'p', s: 'adb shell "su -c \'chmod 755 /data/local/tmp/fsx\'"' },
          { t: 'd', s: '/data/local/tmp/fsx: permissions set to 755' },
          { t: 'p', s: 'adb shell "su -c \'/data/local/tmp/fsx --listen 127.0.0.1:6666 &\'\'"' },
          { t: 'o', s: 'Frida server listening on 127.0.0.1:6666', note: '<b>关键一步：--listen 换掉默认端口。</b>默认的 27042/27043 不再被监听，遍历 <span class="mono">/proc/net/tcp</span> 找这两个端口的检测会一无所获。<br><span class="pill warn">具体参数名与写法请以你所用的 frida-server 版本 --help 为准</span>' },
          { t: 'p', s: 'adb shell "su -c \'netstat -tlnp | grep fsx\'"' },
          { t: 'o', s: 'tcp  0  0  127.0.0.1:6666  0.0.0.0:*  LISTEN  1234/fsx' },
          { t: 'd', s: '# 本地用 frida -H 127.0.0.1:6666 连接；端口被占时可先用 adb forward 转发' },
          { t: 'd', s: '' },
          { t: 'd', s: '# ── 阶段二：/proc/self/maps 过滤前后对照 ──' },
          { t: 'p', s: 'adb shell "su -c \'cat /proc/$(pidof com.target.app)/maps | grep -i frida\'"' },
          { t: 'o', s: '7f8a100000-7f8a104000 r-xp 00000000 00:00 0  [anon:frida-agent]' },
          { t: 'o', s: '7f8a200000-7f8a210000 rw-p 00000000 00:00 0  [anon:gum-js-loop]' },
          { t: 'o', s: '7f9c000000-7f9c020000 r-xp 00000000 fd:00 1234  /data/local/tmp/fsx' },
          { t: 'w', s: '↑ 这就是 App 执行同样命令时能看到的“证据”', note: '<b>看清楚这里暴露了什么。</b>三行里有两行是 <b>Frida 内部匿名映射</b>（<span class="mono">frida-agent</span>、<span class="mono">gum-js-loop</span>），<b>改名根本改不掉它们</b>——这是线程名与模块名层面的暴露。<b>所以只改名是不够的，必须做 maps 过滤。</b>' },
          { t: 'd', s: '' },
          { t: 'd', s: '# ── 阶段三：注入过滤脚本（示意） ──' },
          { t: 'p', s: '# frida -H 127.0.0.1:6666 -f com.target.app -l maps_filter.js' },
          { t: 'o', s: 'Spawned `com.target.app`. Resuming main thread!', note: '<b>注意这里用的是 -f（spawn）而不是 attach。</b>过滤脚本必须在 App 的检测代码执行之前就位，否则它已经把 maps 读完了。<b>这就是 24.8 里 E 的实战形态。</b>' },
          { t: 'd', s: '[maps_filter.js] hook open/openat/fopen + read' },
          { t: 'd', s: '[maps_filter.js] 命中 /proc/self/maps → 按行过滤含 frida/gum/gadget 的行' },
          { t: 'd', s: '[maps_filter.js] 注意：需处理分块读取，跨块的多行匹配不能漏' },
          { t: 'd', s: '' },
          { t: 'p', s: '# 过滤生效后，App 内部读到的是：' },
          { t: 'o', s: '7f8a300000-7f8a304000 r-xp 00000000 00:00 0  [anon:libc_malloc]' },
          { t: 'o', s: '7f9b000000-7f9b021000 r-xp 00000000 fd:00 999   /system/lib64/libc.so' },
          { t: 'o', s: '(原有内容全部保留，仅含特征字符串的行被移除)' },
          { t: 'o', s: '↑ App 找不到 frida 痕迹，检测通过', note: '<b>对比一下前后的差别。</b>过滤不是让 maps 变空——<b>变空本身就是异常</b>。正确做法是<b>只删掉暴露自己的那几行，其余原样保留</b>，让内容看起来跟正常进程一样。这是很多人第一次写过滤脚本时会踩的坑。' },
          { t: 'd', s: '' },
          { t: 'd', s: '# ── 阶段四：收尾卫生 ──' },
          { t: 'p', s: 'adb shell "su -c \'rm -f /data/local/tmp/fsx\'"' },
          { t: 'o', s: '已清理', note: '<b>跑完就删。</b>不留二进制文件，针对 <span class="mono">/data/local/tmp</span> 的路径扫描也就失去了目标。<b>这是零成本的卫生习惯，没有任何理由不做。</b>' }
        ]
      },
      quiz: {
        id: 'q10-3', chapter: 10, answer: [0, 2],
        stem: '（多选）App 读 <span class="mono">/proc/self/maps</span> 做 Frida 检测。关于“hook open/read 返回一份干净 maps”这个做法，下面哪些说法是对的？',
        options: [
          { t: '过滤时应该只移除含 frida / gum / gadget 等特征字符串的行，其余内容原样保留', why: '正确。返回空文件或明显异常的内容本身就是破绽——检测方会对比 maps 的完整性、进程自身的映射是否齐全。' },
          { t: '把 maps 内容整体清空是最彻底的做法，检测方无从下手', why: '错误且危险。一个正常进程的 maps 不可能为空，这比暴露 frida 更可疑，属于自曝。' },
          { t: '如果 App 分块读取 maps，过滤逻辑必须能正确处理跨块的多行匹配', why: '正确。这是实际写脚本时最常见的 bug：按行过滤时假设一次 read 拿到完整行，分块后就会漏掉特征行。' },
          { t: 'hook 了 open/read 之后，App 就无法再用任何方式发现 Frida 了', why: '错误。maps 只是众多检测点之一，端口、线程名、内存特征、耗时、hook 痕迹都还在。这是典型的“一招通吃”误解。' }
        ],
        explain: '<b>这道题的核心是“篡改观察结果”这个思路的两条纪律：</b><br><b>① 保持自洽。</b>你要让 App 看到的是一份<b>看起来正常</b>的 maps，而不是一份明显被处理过的 maps。删掉可疑行是对的，清空是自曝。<br><b>② 实现要经得起真实调用模式。</b><span class="mono">/proc</span> 下的文件常被分块读取，逐行过滤必须在缓冲区边界处也成立。<br>同时要清楚：<b>maps 过滤只解决 ①②③⑧ 里的第 ③ 项</b>，它不能替代改名换端口，也不能挡住内存特征扫描和耗时检测。<b>对抗永远是组合拳。</b>'
      }
    },

    /* ================= 24.10 决策一 ================= */
    {
      h: '24.10',
      title: '决策演练一：dump 出来的 dex 方法体是空的',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一 · 空方法体',
            scenario: '<b>情境：</b>你对一个电商 App 用 fdex2 脚本脱壳，成功 dump 出 3 个 dex。jadx 能正常打开，类名、方法名、字段都在，<b>但所有方法体显示为空或只有一行 throw</b>。你确认脚本没有报错，dump 文件大小也和预期相符。<br><b>下一步你做什么？</b>',
            choices: [
              { t: '换一个版本的 fdex2 脚本重试，可能是 hook 点选错了', next: 'n1' },
              { t: '判断这是抽取壳，改用 FART 主动调用遍历所有方法，触发回填后再 dump', next: 'n2' },
              { t: '用定制版 jadx 或 baksmali 重新反编译，可能是反编译器没解析出来', next: 'n3' },
              { t: '把 dex 拖进十六进制编辑器，看方法体区域到底有没有字节', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：这不是 hook 点的问题',
            result: '<b>认知根源：把“内容缺失”误判成了“采集失败”。</b><br>fdex2 脚本跑通、文件完整、类结构齐全，<b>说明 hook 点是正确的，采集过程完全成功</b>。方法体为空不是“没抓到”，而是“<b>那个时刻它本来就还没有内容</b>”。<br>换脚本、换版本、换 hook 点，都只会在同一个时间点上再 dump 一次同样的空骨架。<b>问题不在采集，在于采集得太早。</b><br><b>正确做法：</b>识别出这是抽取壳（结构完整 + 方法体空 = 抽取壳的典型指纹），切换到 FART 主动调用路线。'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'good',
            verdictTitle: '正确：结构完整 + 方法体空 = 抽取壳，必须主动调用',
            result: '<b>你识别出了抽取壳的指纹。</b>抽取壳的特征就是<b>保留 dex 的完整结构（类、方法、字段、签名全在），只抽走 code_item 里的指令数据</b>。它的运行机制决定了：方法体在<b>首次执行时</b>由壳解密并回填到内存。<br>FART 的做法是<b>枚举 DexFile 里的所有方法，逐个主动调用</b>——不关心它原本会不会被执行，先跑一遍。每跑一个，ART 就必然要为它准备可执行的指令，<b>回填被强制触发</b>。<br><b>这就是“为什么需要主动调用”的全部答案：它不是在抢时间，它是在制造回填的触发条件。</b><br><b>配套动作：</b>dump 之前把 App 的功能点一遍，覆盖更多执行路径，回填覆盖度更高。'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：反编译器不是万能放大镜',
            result: '<b>认知根源：把“内容不存在”当成了“解析不出来”。</b><br>定制版 jadx 放宽的是<b>结构校验</b>（checksum、map 段），它<b>不能让不存在的字节凭空出现</b>。方法体在内存里就是空的，任何反编译器都变不出指令。<br><b>怎么区分这两种情况？</b>看症状：<br>· jadx <b>拒绝加载</b>、报 checksum / Invalid dex → <b>结构问题</b>，定制版 jadx 或修复工具有效；<br>· jadx <b>正常打开</b>、类结构完整、方法体空 → <b>内容问题</b>，必须回到主动调用。<br>你现在是第二种，所以换工具这条路是死的。'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '验证手段没错，但它不能解决问题',
            result: '<b>这个动作本身是对的——而且值得表扬。</b>用十六进制编辑器确认 <span class="mono">code_item</span> 区域确实是空的（或只有壳填充的占位指令），能让你<b>用证据</b>而不是猜测来断定壳型。<br><b>但它的定位是“诊断”，不是“治疗”。</b>当你确认方法体为空之后，你还是要回到同一个结论：这是抽取壳，必须触发回填。<br><b>把它当作正确的第一步：</b>先确认是“结构完整、内容为空”还是“文件本身损坏”，两者后续路线完全不同。<b>诊断对了，才谈得上选对路线。</b>'
          }
        }
      }
    },

    /* ================= 24.11 决策二 + strstr stepper ================= */
    {
      h: '24.11',
      title: '决策演练二：从副作用反推被 OLLVM 混淆的检测逻辑',
      html: '<p>这是本章标题里那句话要解决的问题。<b>检测逻辑被 OLLVM 混淆后，你静态找不到特征字符串，也读不懂控制流。</b>下面这条 stepper 演示正确的切入方式——<b>不硬看代码，从副作用反推。</b></p>',
      stepper: {
        title: 'Hook strstr：让检测行为自己暴露出来',
        lines: [
          {
            code: '<span class="c">// 错误示范：先去 IDA 里找 &quot;frida&quot; 字符串、看交叉引用</span>',
            note: '<b>先说清楚为什么这条路走不通。</b>OLLVM 把字符串加密了、控制流平坦化了、虚假分支塞满了。<b>你在静态里既找不到明文字符串，也看不懂那张分发状态机。</b>花三天硬啃，收益极不确定。',
            state: { '策略': '静态硬看', '已定位检测点': '0', '耗时': '持续累积' }
          },
          {
            code: '<span class="c">// 换思路：混淆保护的是逻辑，保护不了副作用</span>',
            note: '<b>这是本章最重要的一句话。</b>无论控制流被搅成什么样，<b>检测终究要产生可观测的行为</b>：要读 <span class="mono">/proc</span> 就得调 <span class="mono">open</span>；要比字符串就得调 <span class="mono">strstr</span>/<span class="mono">strcmp</span>；要连端口就得调 <span class="mono">socket</span>/<span class="mono">connect</span>。<b>这些调用是壳改不掉的——它们是检测的“必经之路”。</b>',
            state: { '策略': '动态 Trace 副作用', '已定位检测点': '0', '耗时': '几分钟' }
          },
          {
            code: '<span class="k">var</span> strstr = <span class="f">Module.getExportByName</span>(<span class="k">null</span>, <span class="s">&#39;strstr&#39;</span>);',
            note: '<b>选第一个观察点：strstr。</b>为什么从它开始？因为<b>字符串检测是绝大多数 Frida 检测的公共环节</b>——不管是检测 maps 内容、线程名还是文件路径，最终都要把读到的内容跟某个特征串比对。<b>盯住这个公共环节，等于一次覆盖多种检测。</b>',
            state: { '策略': '动态 Trace 副作用', '已挂钩': 'strstr', '已定位检测点': '0' }
          },
          {
            code: '<span class="f">Interceptor.attach</span>(strstr, {',
            note: '<b>挂 onEnter 和 onLeave 两个回调。</b>onEnter 拿参数（谁在比什么），onLeave 拿返回值（比中了没有）。<b>返回值是关键</b>——它直接告诉你这次比较是不是“命中”。',
            state: { '策略': '动态 Trace 副作用', '已挂钩': 'strstr', '已定位检测点': '0' }
          },
          {
            code: '  <span class="f">onEnter</span>: <span class="k">function</span> (args) {',
            note: '<b>进入时先做过滤，这是保命的一步。</b>strstr 是全进程高频调用的函数，如果不加条件就全量打印，<b>日志会瞬间淹掉一切，App 也会被拖死</b>（回看 24.6 的性能警告：热路径上的 hook 必须过滤）。',
            state: { '策略': '动态 Trace 副作用', '已挂钩': 'strstr', '已定位检测点': '0', '日志量': '可接受' }
          },
          {
            code: '    <span class="k">var</span> hay = args[<span class="n">0</span>].<span class="f">readCString</span>();',
            note: '<b>读第一个参数：被搜索的大字符串。</b>在检测场景里，这通常就是刚才从 <span class="mono">/proc/self/maps</span> 读出来的整块内容。<b>读它的时候要小心：不是所有指针都指向可读的 C 字符串</b>，必须 try/catch，否则随时崩。',
            state: { '策略': '动态 Trace 副作用', '已挂钩': 'strstr', '已定位检测点': '0', '日志量': '可接受' }
          },
          {
            code: '    <span class="k">if</span> (hay &amp;&amp; hay.<span class="f">indexOf</span>(<span class="s">&#39;/proc/&#39;</span>) &gt;= <span class="n">0</span>) <span class="f">log</span>(hay.<span class="f">slice</span>(<span class="n">0</span>, <span class="n">80</span>), args[<span class="n">1</span>]);',
            note: '<b>只记录“看起来像检测”的调用。</b>条件是内容里含 <span class="mono">/proc/</span>——<b>这类调用量极小，但信息量极大</b>。日志里剩下的每一条都值得逐个看。日志先塞内存缓冲，别直接写文件。',
            state: { '策略': '动态 Trace 副作用', '已挂钩': 'strstr', '已定位检测点': '0', '日志量': '已过滤，极少' }
          },
          {
            code: '  },  <span class="c">// onEnter 结束</span>',
            note: '<b>onEnter 的职责到此为止：只做筛选和记录。</b>绝不要在 onEnter 里改参数或返回值——那是 onLeave 的活，而且 onEnter 做重活会放大性能问题。',
            state: { '策略': '动态 Trace 副作用', '已挂钩': 'strstr', '已定位检测点': '0' }
          },
          {
            code: '  <span class="f">onLeave</span>: <span class="k">function</span> (retval) {',
            note: '<b>onLeave 才是真正的判决时刻。</b>返回值 != 0 表示<b>找到了</b>，== 0 表示没找到。<b>把 onEnter 记下的参数和 onLeave 的返回值配起来看，检测逻辑就等于摊开在你面前。</b>',
            state: { '策略': '动态 Trace 副作用', '已挂钩': 'strstr', '已定位检测点': '0' }
          },
          {
            code: '    <span class="k">if</span> (!retval.<span class="f">isNull</span>()) <span class="f">flag</span>(<span class="s">&#39;命中！这是一处检测&#39;</span>);',
            note: '<b>非空返回 = 检测命中。</b>在正常业务代码里，针对 <span class="mono">/proc/</span> 内容的 strstr 很少会返回非空——所以<b>每一个非空返回都高度可疑</b>。<b>注意：此时返回非空恰恰说明你被检测到了</b>，所以这一步通常用于“定位”，定位完立刻改用过滤策略。',
            state: { '策略': '动态 Trace 副作用', '已挂钩': 'strstr', '已定位检测点': '<b>1 处（frida 关键字命中）</b>' }
          },
          {
            code: '<span class="c">// 输出示例：</span>',
            note: '<b>看这条日志怎么读。</b>hay 是被搜索内容、needle 是特征串、返回值告诉你结果。<b>三个信息合起来，你就知道：谁在读 /proc、它在找什么、找到没有。</b>——<b>而这些信息你完全没看一行混淆代码就拿到了。</b>',
            state: { '策略': '动态 Trace 副作用', '已定位检测点': '1 处' },
            mem: '[strstr] hay="/proc/self/maps\\n7f8a...frida-agent..."\n         needle="frida"\n         retval=0x7f8a1234  ← 非空：命中\n\n[结论] 存在针对 maps 的 frida 字符串检测\n[动作] 改为在 open/read 层过滤 maps（24.9）'
          },
          {
            code: '<span class="c">// 同类必经之路：open / fopen / socket / connect / memmem</span>',
            note: '<b>把同一个套路复制到其他“必经之路”。</b>读文件类检测 → hook <span class="mono">open</span>/<span class="mono">fopen</span>；字符串类 → <span class="mono">strstr</span>/<span class="mono">strcmp</span>/<span class="mono">memmem</span>；端口类 → <span class="mono">socket</span>/<span class="mono">connect</span>。<b>OLLVM 能混淆判断逻辑，改不掉这些调用本身。</b>',
            state: { '策略': '动态 Trace 副作用', '已定位检测点': '1 处 + 待扩展', '下一步': '扩大必经之路覆盖' }
          },
          {
            code: '<span class="c">// 需要看清路径时：Stalker 追踪该函数（务必限制范围）</span>',
            note: '<b>最后一步才是 Stalker。</b>当你已经<b>定位到</b>那个检测函数，但想看清它的执行路径时，才用 Stalker 追踪它——<b>而且只追踪这一个函数、这一个线程</b>。<br><b>千万不要全局开 Stalker</b>：它会慢几十倍，立刻触发 24.8 里的⑦耗时检测，等于自曝。<b>先定位再追踪，而不是用追踪去定位。</b>',
            state: { '策略': '定位 → 定向追踪', '已定位检测点': '1 处', 'Stalker 范围': '<span class="hit">仅目标函数</span>' }
          }
        ]
      },
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境二 · 混淆检测',
            scenario: '<b>情境：</b>目标 App 有 Frida 检测，so 被 OLLVM 混淆。你在 IDA 里翻了两个小时：字符串是加密的，控制流平坦化，交叉引用全是虚假分支。<b>你确认检测一定存在（attach 后几秒 App 就退出了），但找不到它。</b><br><b>下一步你做什么？</b>',
            choices: [
              { t: '继续静态分析，重点啃那个最大的控制流平坦化函数，它最可疑', next: 'n1' },
              { t: '用动态 Trace 挂 open/strstr/socket 这些必调函数，从副作用反推检测点', next: 'n2' },
              { t: '先上 Stalker 全局 trace 整个 App，把所有执行路径都录下来慢慢分析', next: 'n3' },
              { t: '放弃这个 App，换一个没加壳的目标练手', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：混淆正是为了让静态分析不划算',
            result: '<b>认知根源：把“看不懂”当成“再花点时间就能看懂”。</b><br>OLLVM 的设计目标就是<b>让静态分析的边际收益趋近于零</b>：控制流平坦化把一个清晰的 if-else 变成状态机分发，虚假分支让交叉引用失去意义，字符串加密让特征搜索失效。<b>“最大的那个函数”往往只是壳的通用保护框架，未必是检测本体——你很可能啃完发现跟检测无关。</b><br><b>更关键的是：静态分析根本没有利用你手上的优势。</b>检测逻辑<b>必须运行</b>才能生效，一运行就会产生系统调用。你有 Frida，你能观察运行中的它——<b>为什么要在最不利的战场上打？</b>'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'good',
            verdictTitle: '正确：混淆保护逻辑，保护不了副作用',
            result: '<b>你抓住了本章的核心洞察。</b><br><b>无论控制流被混淆成什么样，检测终究要调用这些函数：</b>读 <span class="mono">/proc</span> 要 <span class="mono">open</span>/<span class="mono">fopen</span>，比字符串要 <span class="mono">strstr</span>/<span class="mono">strcmp</span>/<span class="mono">memmem</span>，连端口要 <span class="mono">socket</span>/<span class="mono">connect</span>。<b>这些调用点是检测的“必经之路”，混淆改不掉它们。</b><br><b>具体操作：</b>在 <span class="mono">strstr</span> 的 onEnter 记参数、onLeave 看返回值。某个调用返回非空、而参数含可疑字符串 → <b>那就是检测点</b>。<br><b>注意两个纪律：①</b> 热路径 hook 必须加条件过滤，否则日志爆炸；<b>②</b> 这一步先做<b>定位</b>，定位完转成过滤/绕过策略。<br><b>再进一步：</b>定位到具体函数后，才用 Stalker 定向追踪它（只追这一个函数、这一个线程）。'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：全局 Stalker 等于自己举手',
            result: '<b>认知根源：把 Stalker 当成了“录下来慢慢看”的录像机。</b><br>Stalker 是<b>指令级</b>追踪，它会把每条指令都过一遍。<b>全局开的结果是：</b>App 慢几十倍、日志体积爆炸、你自己都读不完。<b>更致命的是——它会立刻触发 24.8 里的⑦耗时检测。</b>App 只要在任何关键路径前后打个时间戳，就能发现“有人在 trace 我”，<b>你等于主动举手。</b><br><b>正确用法：</b>先用手工 hook（open/strstr）<b>定位</b>到可疑函数，再<b>定向</b>用 Stalker 追踪那一个函数、那一个线程，采完立刻停。<b>先定位，再追踪；不要用追踪去定位。</b>'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '绕开了问题，也绕开了能力',
            result: '<b>这个选择很诚实，但代价很大。</b>换目标确实能让你继续练手，<b>但你正好跳过了这个领域最有价值的一段训练</b>——OLLVM 混淆 + Frida 检测是当前加固的主流组合，<b>躲开它，等于放弃了实战中最常见的一类目标。</b><br><b>换个角度看：</b>你现在面对的困难，恰恰说明<b>静态分析这条路在当前目标是低效的</b>，而不是说目标无法攻克。<b>把工具换掉（动态 Trace），而不是把目标换掉</b>——这才是能力增长的路径。<br>实在需要降低难度的过渡方案：<b>先找一个只做简单字符串检测、没上 OLLVM 的 App 把 24.8 那张对照表跑熟，再回来打这个目标。</b>'
          }
        }
      }
    },
    /* ================= 24.12 决策三 ================= */
    {
      h: '24.12',
      title: '决策演练三：Android 9 上的静默失败',
      html: T.note('warn', '⚠️ 这一题的正确答案可能和你的第一反应相反', '<p>下面这个情境里，<b>最“专业”的那个选项恰恰是最容易让你绕远路的</b>。请先想清楚“我现在掌握的<b>证据</b>是什么”，再选。</p>'),
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境三 · 静默失败',
            scenario: '<b>情境：</b>你有一个在 Android 6 上工作良好的 fdex2 脚本。现在拿它去脱一个 Android 9 真机上的 App，现象是：<b>脚本加载正常、没有任何报错、App 也照常运行，但 dump 目录始终是空的。</b><br>你知道 Android 8.0 之后 ART 内部结构变了，DexFile 的构造与字段布局都改了。<br><b>下一步你做什么？</b>',
            choices: [
              { t: '去翻 Android 9 对应的 AOSP 源码，重新定位“dex 完成映射”的点，把 hook 目标改过去，重写脚本', next: 'n1' },
              { t: '先加最小可观测性：脚本里加一个 hook 命中计数器 + 在内存里搜一下 dex 魔数，确认失败到底发生在哪一环', next: 'n2' },
              { t: '把 DexFile 所有构造函数重载穷举一遍全 hook 上，总有一个会命中', next: 'n3' },
              { t: '既然脚本不报错却拿不到东西，说明是抽取壳，直接上 FART 主动调用', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'bad',
            verdictTitle: '方向对，但顺序错了：你在盲改',
            result: '<b>这是最容易被老手选中的错误答案，因为它“听起来最专业”。</b><br>回 AOSP 源码重新定位 hook 点<b>确实是正确的最终手段</b>（24.3 讲的就是它）。但你现在的问题是——<b>你根本不知道失败发生在哪一环</b>：<br>· 是脚本挂钩了、但那个重载根本没被 App 走？<br>· 是 App 压根没在 Java 层加载 dex（走的是 oat / 直接从内存加载）？<br>· 还是 hook 命中了、dump 也执行了，但内存拷贝的长度算错写了个 0 字节文件？<br><b>“静默失败”这个症状，对这四种原因一视同仁。</b>你带着零证据去改代码，改三版可能还是空的，而且每一版你都说不清为什么失败——<b>这不是在调试，是在碰运气。</b><br><b>正确顺序：先测量，再修改。</b>'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'good',
            verdictTitle: '正确：先用最小成本确认失败发生在哪一环',
            result: '<b>你选了一个“看起来不够硬核”但工程上唯一正确的动作。</b><br><b>静默失败是逆向里最贵的一类故障</b>，因为它把“没找到目标”和“找到了但处理错了”混在一起。破解它的唯一办法是<b>往流程里插观测点，把黑盒切成白盒</b>：<br><b>① hook 命中计数</b>——在替换的实现第一行打一个计数。<b>不增加就是没命中</b>（hook 点选错 / 实现下沉到了 Native 层）；<b>增加了但没文件</b>，问题就在 dump 那一侧。<br><b>② 内存搜魔数</b>——直接扫描进程内存找 <span class="mono">dex\\n035\\0</span> 与 <span class="mono">cdex001\\0</span>。找到了说明 dex 确实在内存里，只是你的 hook 没在正确的位置；<b>一个都找不到</b>，那才轮到怀疑加载路径。<br><b>这两步加起来不到十分钟，却能把搜索空间从“整个 ART”缩小到“某一环”。</b><br>确认之后再去做 A 选项那件事，<b>你会知道自己在改什么、也知道改对了没有。</b>'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：穷举不是适配，是放弃定位',
            result: '<b>认知根源：把“覆盖得越多越保险”当成了通用法则。</b><br>穷举所有重载有三个问题：<br><b>① 高版本上，目标可能压根不在 Java 层。</b>你穷举得再全，也覆盖不到一个已经下沉到 <span class="mono">ClassLinker</span> / <span class="mono">DexFileLoader</span> 的实现。<b>穷举解决的是“不知道哪个重载对”，解决不了“这一层根本没有”。</b><br><b>② 每个 hook 都是一次崩溃风险。</b>某些重载的内部状态不允许在特定时机被替换实现，挂上去就可能让 App 在启动阶段直接挂掉——<b>而你现在最需要的是让 App 活着跑完。</b><br><b>③ 就算歪打正着命中了，你也不知道是哪一个起的作用，下次换版本还得重来。</b><br><b>正确姿态：</b>穷举只适合“数量有限、成本极低、且能明确区分”的场景。<b>当你连失败在哪一环都不知道时，先做 B。</b>'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：用一个未经验证的假设去解释一个未知的故障',
            result: '<b>认知根源：把“拿不到方法体”和“方法体是空的”这两个症状混为一谈。</b><br><b>抽取壳的指纹是“能 dump 出文件、但方法体为空”。而你现在连文件都没有——dump 目录是空的。</b>这两个症状指向完全不同的原因：<br>· <b>有文件、方法体空</b> → 采集成功、内容缺失 → <b>壳型问题（抽取壳），上 FART</b>；<br>· <b>完全没有文件</b> → <b>采集根本没发生</b> → <b>hook 问题（版本适配）</b>，上 FART 一样拿不到东西，因为 FART 的 dump 组件同样要能在这个版本上正确读出 dex。<br><b>更现实的顺序问题：</b>FART 的主动调用会执行目标 App 的全部方法，<b>成本高、有崩溃风险、还可能触发反调试</b>。在一个你连“dex 到底在不在内存里”都没确认的目标上直接上重武器，是拿最贵的工具去赌一个没验证的猜想。<br><b>先把 B 做完，再决定要不要上 FART。</b>'
          }
        }
      },
      after: '<p>三个情境到这里结束。<b>它们的共同点不是某个工具，而是一种工作方式：先分清症状属于哪一类问题，再选工具。</b>下面用四道题把本章的技术点收一遍。</p>'
    },

    /* ================= 24.13 自测 ================= */
    {
      h: '24.13',
      title: '本章自测',
      html: '<p>最后一道题会把 fdex2 与 FART 的差异、以及<span class="term" data-def="篡改目标程序的观察结果，让它看到的世界与真实情况不一致——比隐藏自己更可靠的一类对抗思路">观察管道篡改</span>这条主线串起来。</p>',
      quiz: {
        id: 'q10-4', chapter: 10, answer: 1,
        stem: '关于 fdex2 与 FART 对<b>抽取壳</b>的效果差异，下面哪个说法是准确的？',
        options: [
          { t: 'fdex2 因为 dump 得更早，抓住的 dex 状态更“新鲜”，所以拿到的方法体比 FART 更完整', why: '把“更早”当成了“更好”。抽取壳的方法体在“更早”的那个时刻恰恰是空的——越早 dump，缺失越多。' },
          { t: '两者的 dump 技术本身没有本质差别，真正的差别在于 FART 通过主动调用制造了方法的执行，从而触发了方法体回填', why: '正确。同样一块内存、同样一次写出操作，差别在于 dump 之前有没有发生回填，而回填需要执行来触发。' },
          { t: 'fdex2 擅长抽取壳，FART 擅长一代壳，两者按壳型互补使用', why: '把两者擅长的壳型说反了。一代壳整体加密、在映射进内存时就是完整的，fdex2 足够；抽取壳必须主动调用。' },
          { t: 'FART 能拿到完整方法体，是因为它用了更底层的内存读取方式，能读到 fdex2 读不到的区域', why: '两者的内存读取能力没有本质差别，都只是读进程内的可读内存。差别不在“读的能力”，而在“读的时机和读之前发生了什么”。' }
        ],
        explain: '<b>这道题要钉死一个因果链：</b>抽取壳把方法体抽走 → 方法体在<b>首次执行时</b>由壳解密并回填 → 所以要拿到完整方法体，就必须<b>先让它执行</b> → FART 的做法是枚举所有方法并逐个主动调用，<b>人为制造执行</b>。<br><b>反过来看 fdex2：</b>它 hook 的是 dex 加载流程，在 dex 映射进内存的<b>那一刻</b>落盘。对一代壳，那一刻 dex 就是完整的，所以又快又好；对抽取壳，那一刻方法体还没回填，<b>你 dump 得越早，拿到的空洞越多。</b><br><b>所以这两条路线的差别不在“dump 技术”，而在“dump 之前发生了什么”</b>——一个是等事件，一个是造事件。<br>由此还能推出一个实战结论：<b>FART 的完整性上限，取决于你触发了多少方法的执行。</b>把 App 的每个功能都点一遍，不是玄学，是在提高回填覆盖率。'
      }
    },
     ],
     glossary: [
       { t: 'fdex2', d: '一类基于 Hook dex 加载流程的脱壳思路。在 ART 把 dex 映射进内存的那一刻整块 dump 落盘，实现简单、对一代壳效果好，但对抽取壳只能拿到方法体为空的结构骨架。' },
       { t: '抽取壳', d: '保留 dex 完整结构（类、方法、字段、签名），只把方法体指令数据抽走的加固方式。方法体在首次执行时由壳解密并回填，因此必须触发执行才能拿到完整内容。' },
       { t: 'code_item', d: 'dex 中描述单个方法代码的单元，包含寄存器数量、入参信息与 insns 指令数组。抽取壳抽走的就是它内部的指令数据，留下的是一副空壳。' },
       { t: '回填', d: '抽取壳在方法首次执行时把解密后的指令写回 code_item 的过程。它是执行的副作用，壳无法阻止，这正是主动调用能够脱壳的根本原因。' },
       { t: 'CompactDex', d: 'Android 8.0 之后引入的一种为节省内存而优化的 dex 变体，指令操作数被重编码，魔数与标准 dex 不同。dump 高版本目标时需要同时识别它。' },
       { t: 'checksum 与 signature', d: 'dex 头部的两个完整性字段，checksum 是 Adler-32，signature 是 SHA-1。FART 回填后内容变了但头部没重算，jadx 会因此拒绝加载。' },
       { t: '定制版 jadx', d: '放宽了 dex 结构校验（跳过 checksum 验证、容忍 map 段异常）的 jadx 分支。作用是让结构受损但仍可解析的 dex 也能反编译，代价是伪代码可能不完整。' },
       { t: 'ART 解释器', d: '逐条取指、译码并执行 dex 字节码的组件。有 C++ 的 SwitchImpl 与汇编的 Mterp 两种实现。Hook 它的入口可以拿到最贴近 Java 语义的执行轨迹。' },
       { t: 'Mterp', d: 'ART 的汇编解释器实现，为每种字节码生成独立的汇编 handler，性能高于 C++ 解释器，是默认实现。因入口是汇编，hook 时需要按符号或偏移定位。' },
       { t: 'RegisterNatives', d: 'JNI 中用于动态注册的函数，通过 JNINativeMethod 数组把 Java 方法与 native 函数地址关联起来，使 so 中不出现 Java_ 前缀的导出符号。' },
       { t: 'frida-gadget', d: '注入进目标进程内部的一个 so，不需要额外的 server 进程即可加载脚本。因此没有默认端口的监听，也没有 frida-server 进程名，是规避端口与进程名检测的架构级手段。' },
       { t: '观察管道篡改', d: '不隐藏自己的存在，而是 Hook open/read、strstr 等函数，让目标程序读到被处理过的内容。比隐藏自身更可靠，是 Frida 对抗中使用频率最高的一类思路。' }
     ],

  teacher: {
    id: 'ch10',
    chapter: 10,
    name: '追问老师 · 第 24 章',
    sub: '壳型决定路线，副作用暴露逻辑——这两句话你能扛住几轮追问？',
    intro: '<p style="margin:0">这一章的技术点不难，难在<b>判断</b>：什么时候用 fdex2、什么时候必须上 FART、被检测了第一刀切哪里。我会顺着你的答案往下追，追到你答不上来，再把完整答案给你。</p>',
    questions: [
      {
        id: 'c10q1', depth: 1, threshold: 0.7,
        q: '用你自己的话说：fdex2 和 FART 都在做“把内存里的 dex 抠出来”，<b>它们的根本差别到底在哪？</b>为什么这个差别决定了它们各自适合什么壳？',
        concepts: [
          { label: 'fdex2 是 Hook dex 的加载流程，在映射进内存那一刻 dump',
            hint: 'fdex2 不调用任何方法，它盯的是什么？在哪个时间点落盘？',
            any: ['hook 加载', 'hook加载', 'Hook dex', 'Hook DexFile', 'DexFile', '加载流程', '映射', 'mmap', 'map 进内存', '加载的那一刻', '构造函数', 'Open', 'dex 加载', '加载完成', '时机', '时间点', '最早期', '抢在'] },
          { label: '抽取壳的方法体在首次执行时才回填',
            hint: '抽取壳抽走的是什么？它什么时候才把内容还回来？',
            any: ['抽取壳', '抽走', '抽空', '方法体', 'code_item', 'codeitem', 'insns', '指令数组', '首次执行', '第一次执行', '执行的时候', '运行时才', '懒加载', '回填', '补回来', '还原回来'] },
          { label: 'FART 通过主动调用制造执行，触发回填',
            hint: 'FART 不是等事件，它干了什么？',
            any: ['主动调用', '主动invoke', 'invoke', '反射调用', '遍历所有方法', '枚举方法', '遍历方法', '制造执行', '强制执行', '触发执行', 'trigger', '回填', '逼'] },
          { label: '壳型决定选型：一代壳用 fdex2，抽取壳必须主动调用',
            hint: '那到底什么时候用哪个？',
            any: ['一代壳', '整体加密', '整体壳', 'dex加密', '一代', 'fdex2 够', 'fdex2就够', '简单壳', '两者互补', '组合使用', '配合使用', '看壳型', '壳的类型', '按壳选'] }
        ],
        hints: [
          '先别看工具，先问一句：内存里的 dex，在什么时刻“内容才算齐全”？',
          'fdex2 在等一个事件，FART 在制造一个事件——分别是什么事件？'
        ],
        probes: [
          '你说 FART 是主动调用。那它为什么不挑几个关键方法调用，而是把所有方法都跑一遍？',
          '如果目标是一代壳，你还会上 FART 吗？为什么？'
        ],
        model: '两条路线最根本的差别，是<b>“等事件”还是“造事件”</b>。<br><br><b>fdex2 是等事件。</b>它 Hook ART 中 DexFile 相关的加载流程（构造函数、Open 系列方法，或 ClassLoader 加载 dex 的入口），在 dex 被映射进内存的<b>那一刻</b>触发 dump，把内存中的 dex 整块写出。它不调用任何业务方法，所以实现简单、速度快、对 App 干扰小，而且对动态下发的 dex 天然友好（每加载一个就触发一次）。<br><br><b>FART 是造事件。</b>它枚举 DexFile 里的所有方法，逐个主动调用，用执行去<b>逼出回填</b>。它做的动作多、慢、还可能崩，但换来的是完整性。<br><br>为什么这个差别决定了壳型适配？因为<b>“dex 映射完成”和“方法体可用”是两件独立的事</b>。一代壳整体加密，dex 一旦被解密映射进内存就是完整的，fdex2 在那一刻 dump 正好拿到全部内容。而抽取壳保留了 dex 的完整结构（类、方法、字段、签名都在），<b>只抽走了 code_item 里的指令数据</b>，这些内容要等方法<b>首次执行时</b>才由壳解密回填。<br><br>所以在抽取壳上，fdex2 dump 得越早、拿到的空洞越多——文件头正常、类列表正常，唯独方法体是空的。这正是 FART 主动调用存在的全部意义：<b>回填是执行的副作用，壳拦不住。</b><br><br>实战里两者是互补的：先用 fdex2 快速摸清有几个 dex、什么壳型，再决定要不要上 FART 补齐方法体。',
        after: '<p>顺着这个答案再推一步：FART 的完整性上限，等于你触发了多少方法的执行。</p>'
      },
      {
        id: 'c10q2', depth: 1, threshold: 0.7,
        q: '你用 FART 成功 dump 出几个 dex，拖进 jadx 却报 <span class="mono">Invalid dex file</span> / <span class="mono">checksum mismatch</span>。<b>为什么会这样？</b>你有哪些处理路径，按什么顺序试？',
        concepts: [
          { label: '回填改了内容，但文件头的 checksum / signature 没重算',
            hint: 'dump 出来的字节被人改过，但描述它的元数据呢？',
            any: ['checksum', '校验', '校验和', 'adler', 'adler-32', 'adler32', 'signature', 'sha1', 'sha-1', '签名', '文件头', '头部', 'hash', '哈希', '没重算', '对不上', '不一致', '失配', '不匹配'] },
          { label: 'map 段缺失或错位、insns_size 与实际不符、跨 dex 引用断裂',
            hint: '除了头部两个字段，dex 内部还有哪些描述性结构可能坏掉？',
            any: ['map', 'map_off', 'map段', 'map 段', 'insns_size', '指令数', '指令长度', '引用', '跨dex', '跨 dex', '结构', '错位', '缺失', '断裂', '布局'] },
          { label: '定制版 jadx 放宽校验，让损坏的 dex 也能反编译',
            hint: '有一个专门为这种场景改过的分析工具，它放宽了什么？',
            any: ['定制版jadx', '定制版 jadx', '定制jadx', '改过的jadx', 'jadx魔改', '魔改jadx', '放宽', '跳过校验', '忽略校验', '不校验', '绕过校验', '容忍', 'patch jadx', 'jadx'] },
          { label: '先用修复组件修好头部再反编译 / 或改用 baksmali',
            hint: '除了“忍”，还有“修”和“换”——分别是什么？',
            any: ['修复', '修复组件', 'repair', '重算', '重建', '修好', '先修', 'baksmali', 'smali', '反汇编', 'fart自带', 'fart 自带', 'FART 修复'] }
        ],
        hints: [
          'jadx 拒绝加载，是因为它不信这个文件。它不信的具体是哪几个字段？',
          '如果内容是坏的，修头没用；如果头是坏的、内容是对的，那该修什么？'
        ],
        probes: [
          '如果 dex 能正常打开、类结构完整，只是方法体是空的，此时换定制版 jadx 有用吗？为什么？',
          '你为什么把“先修”排在定制版 jadx 前面？'
        ],
        model: '<b>FART 的产物天然是“结构受损但内容正确”的。</b>回填改写了内容，但文件头的两个完整性字段没跟着重算：<b>checksum</b>（Adler-32）与 <b>signature</b>（SHA-1）都与实际内容不符。此外常有三类问题：<span class="mono">map_off</span> 指向的 map 段可能缺失或错位；回填后 <span class="mono">insns_size</span> 与实际指令数可能对不齐；多个 dex 之间的引用关系可能断裂。<br><br><b>jadx 的选择是直接拒绝加载</b>：它对 dex 结构有严格校验，遇到这些情况报 <span class="mono">Invalid dex file</span> / <span class="mono">checksum mismatch</span>。从工程角度这是对的——静默接受损坏输入，只会产出更难排查的错误结果。<br><br><b>三条处理路径，按性价比排序：</b><br><b>① 修</b>——用 FART 自带的修复组件重算 checksum / signature、重建 map 段，再喂给原版 jadx。<b>结果质量最好，优先走这条。</b><br><b>② 忍</b>——用定制版 jadx，它放宽了校验（跳过 checksum 验证、容忍 map 段问题），让损坏的 dex 也能反编译。<b>代价是伪代码可能不完整，但总比看不到强。</b><br><b>③ 换</b>——用 <span class="mono">baksmali</span> 反汇编成 smali。smali 是逐条指令的展开，对结构问题的容忍度通常比 jadx 高：<b>结构坏了 jadx 直接罢工，baksmali 往往还能吐出大部分内容。</b><br><br><b>最后必须分清两类问题：</b>打不开 = 结构问题 → 修头 / 换工具；打得开但方法体空 = 内容问题（回填没发生）→ <b>回到主动调用，修文件头毫无意义。</b>'
      },
      {
        id: 'c10q3', depth: 2, threshold: 0.7,
        q: '有人提出：<b>“Hook ART 解释器的入口，就能 trace 到每一条被执行的 dex 指令。”</b>这句话对吗？这件事对脱壳具体有什么价值？<b>做的时候最大的风险是什么？</b>',
        concepts: [
          { label: '解释器是 dex 字节码的实际执行者，比 Native 层 trace 更贴近 Java 语义',
            hint: '为什么不去 hook so 函数，而要去 hook 解释器？两者看到的层级差在哪？',
            any: ['解释器', 'interpreter', 'SwitchImpl', 'switchimpl', 'Mterp', 'mterp', '字节码', 'dex 指令', 'dex指令', 'Java语义', 'java 语义', 'java层', 'Java 层', '语义', '执行者', '更贴近', '高层'] },
          { label: '解释器入口能记录当前方法 / dex PC / 字节码',
            hint: '挂上去之后，你具体能读到哪三样东西？',
            any: ['当前方法', '方法名', 'method', 'ArtMethod', 'dex pc', 'dexpc', 'pc', '字节偏移', '当前指令', '字节码', 'opcode', '操作码', '指令'] },
          { label: '抽取壳的方法体在首次执行时回填，记录“哪些方法执行过”等于拿到已回填清单',
            hint: '这件事跟“方法体什么时候才有内容”有什么联系？',
            any: ['首次执行', '第一次执行', '回填', '已回填', '执行过', '被执行', '清单', '列表', '覆盖', '触发', 'dump 时机', 'dump时机', '知道哪些方法'] },
          { label: '解释器入口是最热路径，hook 会让 App 慢几十倍甚至卡死，必须限时/限条件',
            hint: '这个入口每秒会被执行多少次？挂上去会发生什么？',
            any: ['性能', '热路径', '最热', '慢', '几十倍', '卡死', '卡顿', 'anr', 'ANR', '影响性能', '开销', '高频', '每条指令', '崩', '限时', '条件过滤', '只记录特定', '范围控制', 'detach', '去掉hook'] }
        ],
        hints: [
          'ART 有两种解释器实现，它们的形态差别很大——你能说出各自的特点吗？',
          '“哪些方法被执行过”这个信息，和“哪些方法已经回填了”是不是同一件事？'
        ],
        probes: [
          '为什么实战里有一个技巧叫“把 App 的每个按钮都点一遍”？用解释器 trace 解释一下它为什么有效。',
          '你会怎么控制这个 hook 的开销？说说你的三条纪律。'
        ],
        model: '这句话<b>基本正确，但要加两个限定</b>。ART 解释器确实是 dex 字节码的实际执行者：<b>你在 Native 层 hook 一个 so 函数，看到的是机器指令和寄存器；你 hook 解释器入口，看到的是“哪条 dex 指令、在哪个方法里、在第几个字节偏移”。</b>后者离 Java 层语义近得多。<br><br><b>限定一：实现形态。</b>ART 有两种解释器实现 <span class="pill warn">具体版本实现细节待核实</span>：<b>C++ 解释器（SwitchImpl）</b>是一个巨大的 <span class="mono">switch (inst)</span> 分发循环，可读性好，便于 Hook；<b>汇编解释器（Mterp）</b>为每种字节码生成汇编 handler，性能高，是默认实现，入口是汇编，需要按符号或偏移定位。<b>Hook 思路一样：</b>找到入口函数，用 <span class="mono">Interceptor.attach</span> 挂上去，记录当前方法、当前 dex PC、当前字节码。<br><br><b>限定二：不是“每条指令都无条件拿得到”。</b>未被执行的方法不会进解释器；被 JIT/AOT 编译过的代码也可能不走解释器。<br><br><b>对脱壳的价值：</b>抽取壳的方法体在<b>首次执行时</b>回填，所以“哪些方法被执行过”等价于一份<b>“已回填清单”</b>。这也解释了那个实战技巧：<b>跑一遍 App 的所有功能、点遍所有按钮，能让 FART 的回填覆盖更全。</b>每次点击都在把新方法推进解释器，每次进解释器都在触发回填——<b>你的点击覆盖率，就是脱壳完整度的上界。</b><br><br><b>最大风险是性能。</b>解释器入口是<b>最热的代码路径</b>，挂上 hook 会让 App 慢几十倍甚至卡死。三条纪律：<b>①</b> 只挂很短时间，采完立刻 detach；<b>②</b> 加条件判断，只记录关心的类；<b>③</b> 回调里不做重活，先塞内存缓冲，最后统一导出。'
      },
      {
        id: 'c10q4', depth: 2, threshold: 0.7,
        q: '加固用 <span class="mono">RegisterNatives</span> 动态注册 JNI 函数，so 里没有 <span class="mono">Java_</span> 前缀的导出符号。<b>你有哪些手段把“Java 方法 → native 地址”的映射拿到？</b>说说各自的隐蔽性取舍。',
        concepts: [
          { label: 'Hook JNIEnv 函数表里的 RegisterNatives，打印 JNINativeMethod 数组',
            hint: '最直接的一招是什么？你要改哪里？',
            any: ['RegisterNatives', 'register natives', 'JNIEnv', '函数表', '函数指针表', 'JNINativeMethod', 'native方法数组', '槽位', 'slot', '替换', 'hook 表', '改表'] },
          { label: '改 JNIEnv 函数表容易被检测 / Hook JNI_OnLoad 更早介入',
            hint: '这一招的弱点在哪？有没有介入更早的位置？',
            any: ['JNI_OnLoad', 'onload', '更早', '抢时序', '时序', 'JavaVM', 'GetEnv', '容易被检测', '被检测', '风险', '/proc/self/maps', '暴露'] },
          { label: '扫描内存直接读 ART 内部结构（ArtMethod 的 entry_point / mirror::Class 方法表），只读不写最隐蔽',
            hint: '有没有一种办法完全不 hook，只读内存就能拿到映射？',
            any: ['扫描内存', '读内存', '内存扫描', 'ArtMethod', 'entry_point', 'entrypoint', 'quick', 'mirror::Class', 'mirror class', '方法表', '只读', '不写', '最隐蔽', '偏移', '结构体', '数据结构'] },
          { label: '各有适用场景，实战中组合使用并针对目标检测手段取舍',
            hint: '这几种手段之间是什么关系？',
            any: ['组合', '配合', '取舍', '看场景', '各有', '没有最优', '因目标而异', '结合', '多管齐下', '一起用', '叠加'] }
        ],
        hints: [
          '如果你连 JNIEnv 指针都还没拿到，第一步要做什么？',
          '有一种做法完全不需要修改任何函数表——它读的是什么？'
        ],
        probes: [
          '改 JNIEnv 函数表这一招，最可能被对方用什么方式发现？',
          '为什么“把 fnPtr 换算成模块名 + 偏移”比直接记地址更有用？'
        ],
        model: '<b>四条路，隐蔽性和便利性正好成反比。</b><br><br><b>① Hook RegisterNatives 本身。</b>在 <span class="mono">JNIEnv</span> 函数表里找到 <span class="mono">RegisterNatives</span> 槽位，替换成自己的实现，调用原函数前打印 <span class="mono">JNINativeMethod</span> 数组（name / signature / fnPtr）。<b>最省事，但最不隐蔽</b>——你改动了 JNIEnv 函数表，App 检查表项或函数头字节就能发现。必须<b>备份并转调原实现</b>，否则 native 方法全部注册失败，App 立刻崩。<br><br><b>② Hook JNI_OnLoad。</b>更早介入：so 加载时先拿到 <span class="mono">JavaVM</span>，自己 <span class="mono">GetEnv</span> 拿 <span class="mono">JNIEnv</span>，再去 hook <span class="mono">RegisterNatives</span>。<b>时序敏感</b>——必须抢在目标 so 的 JNI_OnLoad 之前完成挂钩。<br><br><b>③ 扫描内存找 mapping。</b>不 hook，直接读 ART 内部数据结构（<span class="mono">ArtMethod</span> 的 <span class="mono">entry_point_from_quick_compiled_code_</span> 字段，或 <span class="mono">mirror::Class</span> 的方法表）读出映射。<b>最隐蔽</b>——只读不写，不触发任何 hook 检测。<b>代价</b>是要理解该版本 ART 的内存布局，字段偏移随版本变化。它本质上是<b>“定制 ART”思路的用户态版本</b>。<br><br><b>④ Hook art::JNI::RegisterNatives</b>（ART 内部实现，而非 JNIEnv 表里的转发表项）。介于两者之间，需要知道该函数的符号或地址 <span class="pill warn">符号随版本变化，待核实</span>。<br><br><b>“奇技淫巧”指的就是这个取舍：</b>目标检测 hook 痕迹就走 ③；目标很早就注册就走 ② 抢时序；只想快速看一眼就走 ①。<b>没有最优解，只有对当前目标最优解。</b>'
      },
      {
        id: 'c10q5', depth: 3, threshold: 0.75,
        q: '<b>综合题。</b>目标 App 有 Frida 检测，检测逻辑被 OLLVM 混淆：静态找不到特征字符串、控制流平坦化看不懂。<b>请完整讲一遍你的处理流程</b>——从第一次 attach 开始，到你定位并绕过检测为止。中间要说清：为什么你选这个顺序、以及每一步的代价和风险。',
        concepts: [
          { label: '先做成本最低的隐蔽性处理：改名、换非默认端口、换路径',
            hint: '真正动手之前，有没有零成本就能减少暴露的动作？',
            any: ['改名', '重命名', '换端口', '--listen', 'listen', '非默认端口', '27042', '换路径', '清理', '卫生', '低成本', '第一步', '先改', 'frida-server 名'] },
          { label: 'Spawn 模式抢跑，在 main 之前注入，抢在反调试初始化前去 hook 检测函数',
            hint: 'attach 模式下你经常还没动手 App 就已经退出了。怎么解决？',
            any: ['spawn', '-f', 'frida -f', '抢跑', '抢在', 'main 之前', 'main之前', '提前注入', '启动时注入', '抢先', '时序', '早点挂', '比检测早'] },
          { label: '不硬看混淆代码，改为动态 trace 检测的必经之路：open/fopen、strstr/strcmp、socket/connect',
            hint: 'OLLVM 能改掉控制流，但有一样东西它改不掉——是什么？',
            any: ['动态', 'trace', 'hook open', 'open', 'fopen', 'read', 'strstr', 'strcmp', 'memmem', 'socket', 'connect', '系统调用', '库函数', '必经之路', '副作用', '不硬看', '不静态'] },
          { label: '在 onLeave 看 strstr 返回值定位检测点：返回非空且参数可疑即为检测点',
            hint: '挂上 strstr 之后，你怎么判断哪一次调用才是检测？',
            any: ['onleave', 'onLeave', '返回值', 'retval', '非空', '非零', '命中', '找到了', '参数', '可疑字符串', '定位', '判断'] },
          { label: '核心洞察：混淆保护的是逻辑，保护不了副作用',
            hint: '为什么这条路在理论上一定成立？用一句话概括。',
            any: ['副作用', '观察', '可观测', '必须调用', '改不掉', '拦不住', '逻辑', '保护逻辑', '反推', '从副作用'] },
          { label: '定位后逐项对抗：maps 过滤、字符串过滤、硬件断点、控制 Stalker 范围',
            hint: '找到检测点之后，你用什么手段把它挡下来？',
            any: ['maps', '过滤', 'hook open', '字符串过滤', 'Hook 字符串', '硬件断点', 'hardware breakpoint', 'hwbp', 'stalker', '范围', '限时', '条件', '绕过', '篡改', '伪造', '时钟', 'clock_gettime'] }
        ],
        hints: [
          '把顺序想清楚：先做什么、后做什么。为什么“抢时序”要排在“隐藏自己”前面？',
          'OLLVM 混淆的是判断逻辑。但判断之前，数据从哪来？判断的时候，字符串怎么比？'
        ],
        probes: [
          '你为什么一开始就跳过静态分析？如果对方根本没有 OLLVM，你的流程会不会不同？',
          '定位到检测点之后，你是去改检测函数的返回值，还是去伪造它读到的数据？两种做法各自的代价是什么？'
        ],
        model: '<b>第一步：零成本的隐蔽性处理。</b>改名 frida-server、用 <span class="mono">--listen</span> 换非默认端口（默认 27042 / 27043）、换掉 <span class="mono">/data/local/tmp</span> 这种人人皆知的路径，跑完清理。<b>这些动作几乎不花时间，却能一次性挡掉端口探测、路径扫描这两类最廉价的检测。</b>没有理由不做。<br><br><b>第二步：用 spawn 抢时序。</b>用 <span class="mono">frida -f &lt;包名&gt;</span> 而不是 attach，让脚本在 App 的 main 之前注入。<b>这一步是后面所有工作的前提</b>——attach 模式下 App 往往在你脚本生效前就自检完并退出了。<b>关键认知：很多检测只要晚一步执行就彻底失效</b>，因为它依赖的那些函数已经被你换掉了。<br><br><b>第三步：不硬看混淆代码，改为动态 trace“必经之路”。</b>这是本题的核心。OLLVM 能混淆判断逻辑、加密字符串、平坦化控制流，<b>但改不掉检测行为产生的副作用</b>：读 <span class="mono">/proc</span> 必须调 <span class="mono">open</span>/<span class="mono">fopen</span>，比字符串必须调 <span class="mono">strstr</span>/<span class="mono">strcmp</span>/<span class="mono">memmem</span>，连端口必须调 <span class="mono">socket</span>/<span class="mono">connect</span>。<b>先挂 strstr：onEnter 读参数（谁在被比、在比什么），onLeave 看返回值（比中没有）。某个调用返回非空、而参数含可疑字符串 —— 那就是检测点。</b>注意热路径 hook 必须加条件过滤（比如只在 hay 含 <span class="mono">/proc/</span> 时记录），否则日志爆炸、App 被拖死。<br><br><b>核心洞察：混淆保护的是逻辑，保护不了副作用。</b>检测行为必然产生可观测的系统调用与内存访问，<b>从副作用反推逻辑，是绕过混淆检测的通用思路。</b><br><br><b>第四步：定位后逐项对抗。</b>若是读 maps 的字符串检测 → 在 <span class="mono">open</span>/<span class="mono">read</span> 层返回一份过滤后的干净内容（<b>只删含特征字符串的行，其余原样保留——返回空反而是自曝</b>，还要处理分块读取的跨块匹配）；若是比字符串 → hook <span class="mono">strstr</span> 系列直接返回未找到；若对方比对的是字节序列而非字符串 → 用<b>硬件断点</b>（不改函数头，字节比对检测不到）或 hook 掉那个检查函数本身；若担心耗时检测 → <b>避免长时间开 Stalker</b>，必要时才 hook 时钟函数。<br><br><b>第五步：只在定位之后定向用 Stalker。</b>想看清检测函数的执行路径时，<b>只追踪这一个函数、这一个线程</b>，采完立刻停。<b>全局开 Stalker 会让执行慢几十倍，直接触发耗时检测，等于主动举手。</b><br><br><b>贯穿全程的原则：</b>从成本最低的一招开始试，能改自己就改自己，改不了就篡改对方的观察管道，都不行才抢时序、上重武器。',
        after: '<p>这道题没有唯一的标准答案，但有一条硬线：<b>你有没有一个明确的顺序，以及每一步说得清代价。</b>顺序清楚，说明你脑子里有模型；只会背招，遇到新检测就会卡住。</p>'
      }
    ]
  }
};
