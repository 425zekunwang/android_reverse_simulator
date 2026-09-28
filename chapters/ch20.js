/* 第 20 章数据 —— JNI / NDK 开发详解 */
window.CHAPTER = {
  no: 20,
  title: 'JNI / NDK 开发详解',
  lede: '前面十几章都在"拆"别人写的 native 代码，这一章反过来：<strong>自己写一遍</strong>。' +
        '因为 JNI 的所有"逆向技巧"，本质上都是<strong>当初设计这套接口时就留下的缝</strong>——' +
        '你不亲手把 Java 声明和 native 函数绑一次，就永远只能背脚本、看不懂脚为什么这么写。',
  meta: [
    '核心问题：<b>Java 和 native 到底是怎么互相找到对方的？</b>',
    '关键机制：<b>JNIEnv 函数表 / 静态注册 / 动态注册 / 引用管理</b>',
    '对手：<b>用动态注册藏入口的加固壳</b>'
  ],

  sections: [
    /* ============================================================ 20.1 */
    {
      h: '20.1', title: '先建立直觉：JNI 是两个世界之间的翻译官',
      intuition: {
        tag: '直觉模型 · 两个国家与一位翻译官',
        body:
          '<p>Java 国说 Java 语，native 国说 C 语。两国要通商，但<strong>谁也不肯改自己的语言</strong>——' +
          'Java 不想为了调一个 C 函数变成 C，C 也不想为了被调变成 Java。</p>' +
          '<p>于是有了 JNI：一套<strong>翻译规范</strong>。它规定了两件事：<br>' +
          '① 语言怎么互换（类型映射、字符串编码、数组访问）；<br>' +
          '② 双方怎么<strong>互相找到对方</strong>（Java 怎么找到 native 函数、native 怎么回调 Java 方法）。</p>' +
          '<p>注意 JNI 是<strong>规范</strong>不是库。规范意味着"位置是写死的"——' +
          '哪张表里第几个槽位是 <span class="mono">FindClass</span>，是标准规定的，' +
          '跟你是 Android 还是桌面 JVM、是 ARM 还是 x86 都无关。</p>' +
          '<p><span class="hit">这个"位置写死"的性质，就是后面一切逆向技巧的根：' +
          '既然位置是固定的，那就能换一张表；既然能换表，就能整张替换成假的。</span></p>'
      },
      html:
        T.note('key', '🔑 本章要回答的三个问题',
          '<p style="margin-bottom:0">' +
          '① Java 声明了一个 <span class="mono">native</span> 方法，运行时<strong>凭什么</strong>知道该调 so 里哪个函数？<br>' +
          '② native 代码<strong>凭什么</strong>能反过来调 Java 的方法、读 Java 的字段？<br>' +
          '③ 加固壳把上面两条路都藏起来之后，你<strong>凭什么</strong>还能把它们挖出来？</p>') +
        '<p>三个问题对应三条技术线：<b>注册机制</b>、<b>JNIEnv 函数表</b>、<b>运行时追踪</b>。' +
        '下面这条主线把它们串起来。</p>' +
        T.card('Android 上 JNI 代码的三种来源（决定了你的分析方法）',
          T.tbl(['来源', '典型样子', '逆向时你要关心什么'],
            [
              ['<b>App 自己写的</b>', '业务 so，导出符号通常规范', '找业务入口，直接读逻辑'],
              ['<b>第三方 SDK</b>', '风控、加固、推送、支付 so', '它做了什么检测、上报了什么'],
              ['<b>加固壳</b>', '入口 so，常常没有可读的导出符号', '<b>它怎么隐藏了自己</b>——本章第 20.12 节']
            ])) +
        T.note('warn', '⚠️ 一个容易搞反的认知',
          '<p style="margin-bottom:0">很多人以为"JNI 就是 Java 调 C"。' +
          '实际上 JNI 是<b>双向</b>的，而且<b>反向的那一半（native 调 Java）才是加固和风控的重灾区</b>——' +
          '因为反调试、签名校验、上报埋点，几乎都要回调 Java 层拿信息。' +
          '只盯着"Java→native"这一半，你会漏掉一半的战场。</p>'),

      stepper: {
        title: '一次 native 方法调用，运行时到底走了几步',
        lines: [
          { code: '<span class="c">// ── Java 侧 ──</span>\n<span class="k">public class</span> <span class="f">Crypto</span> {\n    <span class="k">static</span> { System.<span class="f">loadLibrary</span>(<span class="s">"crypto"</span>); }\n    <span class="k">public static native</span> String <span class="f">sign</span>(String data);\n}',
            note: '<b>第 ① 步：声明。</b>关键字 <span class="mono">native</span> 告诉虚拟机：这个方法<b>没有 Java 实现</b>，去别处找。<br><b>注意这时候还什么都没发生</b>——只是 dex 里多了一个没有 code_item 的方法。<span class="pill warn">这也是为什么"native 方法"在静态分析里天然是个黑盒</span>',
            state: { '阶段': '声明', 'Java 侧': 'native 方法已声明', 'native 侧': '无' } },
          { code: 'System.<span class="f">loadLibrary</span>(<span class="s">"crypto"</span>)\n  → 找 libcrypto.so → dlopen',
            note: '<b>第 ② 步：加载 so。</b><span class="mono">loadLibrary("crypto")</span> 会被翻译成找 <span class="mono">libcrypto.so</span>（自动补 <span class="mono">lib</span> 前缀和 <span class="mono">.so</span> 后缀）。<br>它内部走的是 <span class="mono">android_dlopen_ext</span> 那一套——<b>这一步决定了 so 里哪些代码会被执行</b>（ELF 的构造函数先跑，见第 ④ 步）',
            state: { '阶段': '加载', 'Java 侧': 'loadLibrary 调用', 'native 侧': 'so 被映射进内存' } },
          { code: '<span class="c">// so 里的 .init_array / DT_INIT 依次执行</span>\n<span class="c">// 这里可以写任何代码，包括反调试</span>',
            note: '<b>第 ③ 步：ELF 构造函数。</b>只要 so 被 <span class="mono">dlopen</span>，<span class="mono">.init_array</span> 里的函数就会执行——<b>不需要 Java 调用任何一个 native 方法</b>。<br><span class="hit">这是加固方最喜欢的藏身点之一：你还没开始 hook，它的检测代码已经跑完了。</span>' +
              '第 4 章讲过这一点，这里从"写代码的人"视角再看一遍：<b>它就是普通 C 里的 <span class="mono">__attribute__((constructor))</span></b>',
            state: { '阶段': '初始化', 'Java 侧': '（未参与）', 'native 侧': '.init_array 执行完毕' } },
          { code: '<span class="c">// so 里的初始化入口（由虚拟机主动调用）</span>\njint <span class="f">JNI_OnLoad</span>(JavaVM* vm, <span class="k">void</span>* reserved) {\n    <span class="c">// ① 通常是拿 JNIEnv</span>\n    <span class="c">// ② 通常是 RegisterNatives</span>\n    <span class="k">return</span> JNI_VERSION_1_6;\n}',
            note: '<b>第 ④ 步：JNI_OnLoad。</b>虚拟机在 <span class="mono">dlopen</span> 成功之后、主动去 so 里查这个名字并调用它。<br><b>返回值必须是 JNI 版本号</b>——返回 0 或负数意味着"我不认这个虚拟机"，so 会被认为加载失败。<span class="pill warn">虚拟机会先找短名再找长名，静态链接库是 <span class="mono">JNI_OnLoad_L</span>，细节以 JNI 规范为准</span>',
            state: { '阶段': 'JNI_OnLoad', 'Java 侧': 'loadLibrary 尚未返回', 'native 侧': '注册表已就绪' } },
          { code: '<span class="c">// 路线 A：静态注册 —— 靠名字</span>\n<span class="c">// so 导出符号：Java_com_example_Crypto_sign</span>\n<span class="c">// 路线 B：动态注册 —— 靠表</span>\nenv-&gt;<span class="f">RegisterNatives</span>(clazz, methods, nMethods);',
            note: '<b>第 ⑤ 步：绑定（本章的核心）。</b>虚拟机要回答"<span class="mono">Crypto.sign</span> 对应哪段机器码"，有且只有两条路：<br>· <b>静态注册</b>——按 JNI 命名规范拼出符号名，去 so 的导出表里找（第 20.5 节）<br>· <b>动态注册</b>——代码自己把一张"方法名 + 签名 + 函数地址"的表交给虚拟机（第 20.6 节）<br><span class="hit">加固壳几乎只用第二条，因为第一条会在导出表里留下明晃晃的名字。</span>',
            state: { '阶段': '绑定', 'Java 侧': '方法已关联到地址', 'native 侧': '映射关系建立' } },
          { code: '<span class="c">// 调用发生时</span>\nCrypto.<span class="f">sign</span>(<span class="s">"data"</span>)\n  → 进入已绑定的 native 函数\n  → 参数按 ABI 摆好寄存器\n  → 返回值按 JNI 类型映射回 Java',
            note: '<b>第 ⑥ 步：真正调用。</b>绑定建立之后，调用就是一次普通的函数跳转——<b>虚拟机不再参与"找函数"这件事</b>。<br>参数布局遵循平台的调用约定：ARM64 上前两个位置固定是 <span class="mono">JNIEnv*</span> 和 <span class="mono">jclass/jobject</span>，业务参数从第三个开始。这一点第 7 章补环境时讲过，那时是"为了让模拟器跑通"，现在是"为了自己写对"',
            state: { '阶段': '调用', 'Java 侧': '拿到返回值', 'native 侧': '函数执行完毕' } }
        ]
      },

      after:
        T.note('ok', '✅ 这一节要记住的一句话',
          '<p style="margin-bottom:0">JNI 的全部复杂度，都来自一个矛盾：<b>两个语言要互相调用，但谁都不肯暴露自己内部的名字和布局</b>。' +
          'JNI 的解法是<b>把所有"找对方"的动作都做成显式的、可以通过固定接口完成的</b>——' +
          '而"显式"就意味着<b>可观测</b>。<span class="hit">你能追踪 JNI，正是因为它必须显式地注册、显式地调用。</span></p>')
    },

    /* ============================================================ 20.2 */
    {
      h: '20.2', title: 'JNIEnv 与 JavaVM：两张可以被整体替换的函数表',
      intuition: {
        tag: '直觉模型 · USB 接口',
        body:
          '<p>USB 规范规定了针脚的位置和数量，但<strong>不规定插上来的是键盘、鼠标还是硬盘</strong>。' +
          '设备驱动只要按规范去读第几个针脚，就能工作。</p>' +
          '<p><span class="mono">JNIEnv*</span> 就是那个 USB 接口：<strong>槽位位置由 JNI 规范写死</strong>，' +
          '但每个槽位里装的具体函数指针<strong>由环境决定</strong>。</p>' +
          '<p>在真机上，槽位指向 ART 的实现；在模拟器里，槽位指向你自己写的桩函数；' +
          '而在加固场景里，它还可能指向<strong>壳伪造的一张影子表</strong>——' +
          '这张表专门用来骗过那些"读函数表做检测"的工具。</p>'
      },
      html:
        '<p>先把结构说死。这两个对象都<b>不是结构体</b>，是<b>函数表</b>。</p>' +
        T.tbl(['对象', '字面类型', '实际是什么', '谁填的'],
          [
            ['<span class="mono">JNIEnv*</span>', '指向结构体的指针', '结构体只有一个成员：<b>指向函数指针数组的指针</b>（所以是二级指针）', '虚拟机制造并传入'],
            ['<span class="mono">JavaVM*</span>', '指向结构体的指针', '另一张函数表：<span class="mono">GetEnv</span> / <span class="mono">AttachCurrentThread</span> / <span class="mono">DetachCurrentThread</span> 等', '虚拟机制造并传入']
          ]) +
        '<p>所以 C 里写 <span class="mono">(*env)-&gt;FindClass(env, "...")</span> 要解两次引用：' +
        '第一次拿到结构体，第二次从数组里取出目标槽位的函数指针。' +
        'C++ 里因为 <span class="mono">JNIEnv</span> 被包装成一个类（成员就是那些函数指针），所以写成 ' +
        '<span class="mono">env-&gt;FindClass("...")</span>——<b>看起来像方法调用，其实还是一次函数指针跳转</b>。</p>' +
        T.note('key', '🔑 这个设计为什么重要',
          '<p style="margin-bottom:0">因为槽位位置固定，JNI 调用<strong>在编译后不再需要符号名</strong>——' +
          'native 代码按固定偏移取指针然后调用，<b>谁来接电话它不关心也不检查</b>。<br>' +
          '这带来两个直接后果：<br>' +
          '① <b>逆向方</b>：hook 一个 JNI 函数，本质就是改这张表里的一个槽位——<b>便宜、但留痕</b>；<br>' +
          '② <b>加固方</b>：它可以自己造一张表递给你的代码，你 hook 的那张和它实际用的那张<strong>根本不是同一张</strong>。</p>'),

      stage: {
        title: '从 JNIEnv* 到实际执行：一次函数指针的旅行',
        speed: 1500,
        render:
          '<div class="grid2">' +
            '<div class="card"><div class="card-title">内存里的三段结构</div>' +
              '<div class="blk" id="e-p1">JNIEnv*<br><span class="small">变量本身</span></div>' +
              '<div class="arrow">↓ 解引用 ①</div>' +
              '<div class="blk" id="e-p2">JNIEnv 结构体<br><span class="small">只有一个成员</span></div>' +
              '<div class="arrow">↓ 解引用 ②</div>' +
              '<div class="blk" id="e-p3">函数指针数组<br><span class="small">槽位 0..N</span></div>' +
            '</div>' +
            '<div class="card"><div class="card-title">槽位里装的是谁</div>' +
              '<div class="blk" id="e-s1">槽位 k</div>' +
              '<div class="arrow">↓ 指向</div>' +
              '<div class="blk" id="e-t1">实现 A：ART 真实实现</div>' +
              '<div class="blk" id="e-t2">实现 B：你自己的桩函数</div>' +
              '<div class="blk" id="e-t3">实现 C：壳伪造的影子表</div>' +
              '<div id="e-note" class="small muted" style="margin-top:10px">点「播放」开始。</div>' +
            '</div>' +
          '</div>',
        reset: () => {
          ['e-p1', 'e-p2', 'e-p3', 'e-s1', 'e-t1', 'e-t2', 'e-t3'].forEach(id => S(id, ''));
          SET('e-note', '<span class="muted">点「播放」开始。</span>');
        },
        steps: [
          { run: () => { S('e-p1', 'active'); }, note: '<b>① 变量只是一个指针。</b>它现在指向一块很小的内存，那块内存里只有一样东西：另一个指针。<b>"二级指针"就是这么来的。</b>' },
          { run: () => { S('e-p1', 'done'); S('e-p2', 'active'); }, note: '<b>② 第一次解引用拿到"结构体"。</b>说是结构体，其实里面只有一个成员——一个指向函数指针数组的指针。<b>这个绕的设计，正是 JNI 为"实现可替换"付出的代价。</b>' },
          { run: () => { S('e-p2', 'done'); S('e-p3', 'active'); }, note: '<b>③ 第二次解引用拿到函数指针数组。</b>从这一刻开始，一切都由<b>下标</b>决定。<span class="hit">哪个下标对应哪个 JNI 函数，是 JNI 规范写死的，跨版本、跨架构都一致。</span>' },
          { run: () => { S('e-p3', 'done'); S('e-s1', 'hot'); }, note: '<b>④ 选定一个槽位。</b>比如 <span class="mono">FindClass</span> 在某个固定下标上。native 代码要调它，就按这个下标取值——<b>没有名字，只有编号。</b>' },
          { run: () => { S('e-s1', 'done'); S('e-t1', 'ok'); }, note: '<b>⑤ 情况 A：真机。</b>槽位指向 ART 的 <span class="mono">FindClass</span> 实现——它真的会去 dex 里查类。native 代码对此毫无感知。' },
          { run: () => { S('e-t1', 'done'); S('e-t2', 'warn'); SET('e-note', '模拟执行时，接电话的是你自己写的桩。'); }, note: '<b>⑥ 情况 B：模拟执行。</b>你把整张表换成自己的桩，于是 JNI 调用被<b>降维成普通函数调用</b>。这就是第 7 章 unidbg 能成立的理论基础——<b>它不需要真的有一个 Java 虚拟机</b>。' },
          { run: () => { S('e-t2', 'done'); S('e-t3', 'bad'); SET('e-note', '加固场景：你改的那张表，可能不是它用的那张。'); }, note: '<b>⑦ 情况 C：加固伪造。</b>壳可以自己造一张结构完全相同的表递进来。你 hook 了"系统那张表"的槽位，而目标代码用的是它自己那张——<span class="hit">你的 hook 零命中，且完全没有报错。</span><b>这类静默失败是 JNI 对抗里最常见的坑，第 20.12 节会专门讲怎么发现它。</b>' },
          { run: () => { SET('e-note', '<b>结论：改表是"最省事但最不隐蔽"的一招。</b>'); }, note: '<b>⑧ 收口。</b>改表最省事，但它会同时带来两个代价：<b>容易被检测</b>（表项变了、函数头变了），以及<b>可能改错表</b>。' +
            '所以高对抗场景下，更稳的路线是"<b>只读不写</b>"——去读 ART 内部数据结构拿映射，而不是改接口（第 20.13 节）。' }
        ]
      },

      quiz: {
        id: 'q20-1', chapter: 20, answer: 2,
        stem: '为什么说 <span class="mono">JNIEnv*</span> 是一个"二级指针"？',
        options: [
          { t: '因为 C 语言的指针都需要两次解引用才能访问结构体成员', why: '❌ 这是把语法现象当成了设计原因。普通指针解一次就能访问成员。' },
          { t: '因为它指向一个结构体，而这个结构体里又只有一个指向函数指针数组的指针', why: '✅ 正确。第一次解引用拿到结构体，第二次从数组里取函数指针——<b>正是这个"多一层"，让整张函数表可以被整体替换</b>。' },
          { t: '因为 JNI 规定函数指针数组必须是二维的', why: '❌ 函数指针数组是一维的。多出来的那一层是"结构体包着数组指针"，不是数组本身的维度。' },
          { t: '因为 JavaVM* 是一级指针，JNIEnv* 为了区分就必须是二级', why: '❌ 两者都是指向"只有一个成员的结构体"的指针，形状同构。不存在"为了区分"这回事。' }
        ],
        explain: '<b>结构决定能力。</b><span class="mono">JNIEnv*</span> 是二级指针这件事，不是语法细节，而是设计选择：<br><br>' +
          '如果 JNIEnv 直接就是函数指针数组，那它的地址在编译期就固定了，"换一张表"意味着<b>要去改目标地址上的内容</b>（写内存，容易被检测）。<br>' +
          '而现在是"指针 → 结构体 → 数组指针"，<b>只要把最外层那个指针换掉，整张表就换了，一个字节的内存都不用改</b>。<br><br>' +
          '这个性质同时被三方利用：<br>· <b>虚拟机</b>用它把真实现接进来；<br>· <b>模拟执行工具</b>用它把桩函数接进来（第 7 章）；<br>· <b>加固壳</b>用它把影子表接进来，让你的 hook 落空（本章 20.12）。<br><br>' +
          '<span class="hit">同一个设计，三种用法。看懂结构，你就能预判各方会怎么用它。</span>'
      },

      after:
        T.note('warn', '⚠️ 由此推出的一条实战判断',
          '<p style="margin-bottom:0">当你 hook 了某个 JNI 函数却<b>零命中</b>，不要第一反应就是"我 hook 写错了"。' +
          '在加固样本上，更可能的原因是<b>它用的根本不是你以为的那张表</b>。' +
          '验证方法：在 hook 里额外打印<b>表本身的地址</b>，看看是不是每次都在变、或者是不是与你预期的地址不同。</p>')
    },

    /* ============================================================ 20.3 */
    {
      h: '20.3', title: '类型与签名：JNI 的通用语言',
      html:
        '<p>Java 的 <span class="mono">String</span> 在 JNI 里叫什么？<span class="mono">byte[]</span> 呢？' +
        '<span class="mono">Map&lt;String,String&gt;</span> 呢？——<b>这三个问题的答案，决定了你 90% 的 JNI hook 能不能写对。</b></p>' +
        '<p>JNI 用一套紧凑的<b>描述符（descriptor）</b>来表达类型。它不是给程序员看的，是给虚拟机读的。</p>' +
        T.tbl(['Java 类型', '描述符', '备注'],
          [
            ['<span class="mono">void</span>', '<span class="mono">V</span>', '只在返回值位置出现'],
            ['<span class="mono">boolean</span> / <span class="mono">byte</span> / <span class="mono">char</span>', '<span class="mono">Z</span> / <span class="mono">B</span> / <span class="mono">C</span>', '<b>注意 boolean 是 Z</b>，不是 B（B 被 byte 占了）'],
            ['<span class="mono">short</span> / <span class="mono">int</span> / <span class="mono">long</span>', '<span class="mono">S</span> / <span class="mono">I</span> / <span class="mono">J</span>', '<b>long 是 J</b>，因为 L 要留给对象类型'],
            ['<span class="mono">float</span> / <span class="mono">double</span>', '<span class="mono">F</span> / <span class="mono">D</span>', ''],
            ['任意对象类型', '<span class="mono">L全限定名;</span>', '<b>结尾的分号不能省</b>，包名里的点写成斜杠'],
            ['任意数组', '<span class="mono">[</span> + 元素描述符', '几维就几个 <span class="mono">[</span>，<b>写在前面</b>']
          ]) +
        '<p>方法签名 = <span class="mono">(</span> 参数描述符依次拼接 <span class="mono">)</span> 返回值描述符。' +
        '例如 <span class="mono">String sign(String data, int ts)</span> 的签名是 ' +
        '<span class="mono">(Ljava/lang/String;I)Ljava/lang/String;</span>。</p>' +
        T.note('bad', '☠️ 三个最容易写错的地方',
          '<p style="margin-bottom:0">' +
          '① <b>对象类型忘写结尾分号</b>——<span class="mono">Ljava/lang/String</span> 是错的，必须 <span class="mono">Ljava/lang/String;</span>。<br>' +
          '② <b>数组把 <span class="mono">[</span> 写到后面</b>——<span class="mono">byte[]</span> 是 <span class="mono">[B</span>，不是 <span class="mono">B[</span>。<br>' +
          '③ <b>以为泛型有描述符</b>——<b>没有</b>。泛型在编译后被擦除，<span class="mono">Map&lt;String,String&gt;</span> 在 JNI 里就是 <span class="mono">Ljava/util/Map;</span>。' +
          '<span class="hit">这条特别重要：你在 hook 里看到的签名永远是擦除后的，别试图从签名里读出泛型信息。</span></p>'),

      lab: {
        title: '实验一：JNI 签名生成器（把 Java 声明翻成描述符）',
        goal: '目标：手写描述符，系统真实校验',
        intro:
          '<p>JNI 签名写错一个字符，<span class="mono">RegisterNatives</span> 就会失败、' +
          '<span class="mono">GetMethodID</span> 就会返回 NULL——而且通常<b>不会告诉你错在哪</b>。' +
          '所以这个能力必须练到不用查表。</p>' +
          '<p>下面给你一个 Java 方法声明，<b>请你自己写出它的 JNI 描述符</b>（不许查表，写完再点检查）。' +
          '系统会真的解析你的输入并逐项比对。改一改声明，看看不同组合会变成什么。</p>',
        inputs: [
          { key: 'decl', label: 'Java 方法声明', hint: '可以直接改、可以加泛型、数组、内部类试试',
            value: 'public static native String sign(byte[] data, int timestamp, java.util.Map extra);' },
          { key: 'desc', label: '① 你写的方法描述符', hint: '形如 (……)……',
            ph: '例如 (Ljava/lang/String;)V', type: 'textarea', rows: 2 },
          { key: 'sym', label: '② 若类名是 com.example.app.Crypto，静态注册的短符号名是什么？',
            hint: '注意下划线要转义', ph: 'Java_...' }
        ],
        runLabel: '🔍 解析声明并对照',
        autorun: true,
        run: v => {
          const D = ch20ParseJavaDecl(v.decl || '');
          if (D.err) return '<div class="lab-msg warn">解析失败：' + D.err + '</div>';
          const rows = D.params.map((p, i) =>
            '<tr><td>' + (i + 1) + '</td><td><code>' + ch20esc(p.java) + '</code></td>' +
            '<td><code>' + ch20esc(p.desc) + '</code></td><td>' + p.note + '</td></tr>').join('');
          let html = '<div class="lab-kv">' +
            '<span>方法名 <b>' + ch20esc(D.name) + '</b></span>' +
            '<span>参数个数 <b>' + D.params.length + '</b></span>' +
            '<span>返回值 <b>' + ch20esc(D.ret.java) + '</b></span></div>';
          html += '<table class="lab-tbl"><tr><th>#</th><th>Java 类型</th><th>描述符</th><th>说明</th></tr>' +
            rows + '</table>';
          html += '<div class="lab-msg key"><b>🔑 正确答案（先自己写，再对照）</b><div class="lab-note">' +
            '方法描述符：<br><code style="font-size:15px">' + ch20esc(D.descriptor) + '</code><br><br>' +
            '静态注册短符号名（类 <code>com.example.app.Crypto</code>）：<br>' +
            '<code style="font-size:15px">' + ch20esc(D.shortSymbol) + '</code>' +
            (D.longSymbol ? '<br><br>若方法被<b>重载</b>，虚拟机改用长名：<br><code style="font-size:13px">' +
              ch20esc(D.longSymbol) + '</code>' : '') +
            '</div></div>';
          html += '<div class="lab-msg model"><b>💡 换算规则速查</b><div class="lab-note">' +
            '<b>类型 → 描述符：</b>基本类型用单字母（void=V / boolean=Z / byte=B / char=C / short=S / int=I / long=J / float=F / double=D）；' +
            '对象类型用 <code>L全限定名;</code>（点换斜杠、<b>结尾必须有分号</b>）；数组在前面加 <code>[</code>，几维加几个。<br><br>' +
            '<b>泛型被擦除：</b><code>Map&lt;String,String&gt;</code> → <code>Ljava/util/Map;</code>，参数化信息在 JNI 层根本不存在。<br><br>' +
            '<b>类名 → 符号名（JNI 规范的 Name Mangling）：</b>点 <code>.</code> → 下划线 <code>_</code>；' +
            '原有下划线 <code>_</code> → <code>_1</code>；分号 <code>;</code> → <code>_2</code>；左方括号 <code>[</code> → <code>_3</code>。' +
            '<b>顺序很重要：先处理转义、再处理点，否则会串味。</b><br>' +
            '<span class="pill warn">非 ASCII 字符还有 _0XXXX 形式的转义，细节以 JNI 规范为准</span></div></div>';
          return html;
        },
        expected: v => {
          const D = ch20ParseJavaDecl(v.decl || '');
          if (D.err) return { ok: false, detail: '声明解析失败：' + D.err };
          const norm = s => String(s || '').replace(/\s+/g, '').replace(/;/g, ';');
          const mine = norm(v.desc), want = norm(D.descriptor);
          const ok1 = mine === want;
          const symNorm = s => String(s || '').trim().replace(/\s+/g, '');
          const ok2 = symNorm(v.sym) === D.shortSymbol;
          return {
            ok: ok1 && ok2,
            detail:
              (ok1 ? '✅ 描述符完全正确。<b>你已经能凭规则手写 JNI 签名了。</b>'
                   : '❌ 描述符不对。<br>你写的：<code>' + ch20esc(v.desc || '（空）') + '</code><br>' +
                     '应该是：<code>' + ch20esc(D.descriptor) + '</code><br>' +
                     '逐位比对一下：是不是忘了对象类型的<b>结尾分号</b>？是不是把泛型写进去了？' +
                     '还是数组的 <code>[</code> 位置放错了？') +
              '<br>' +
              (ok2 ? '✅ 符号名正确——<b>下划线转义这一步你做对了</b>。'
                   : '❌ 符号名不对。你写的：<code>' + ch20esc(v.sym || '（空）') + '</code>，' +
                     '应该是 <code>' + D.shortSymbol + '</code>。' +
                     '<b>检查顺序：</b>先把类名里的每个下划线换成 <code>_1</code>（类名里其实没有），再把每个点换成 <code>_</code>，' +
                     '最后拼上 <code>_方法名</code>。')
          };
        },
        showAnswer:
          '【描述符规则】\n' +
          '  void=V  boolean=Z  byte=B  char=C  short=S  int=I  long=J  float=F  double=D\n' +
          '  对象类型：L + 全限定名（点改斜杠） + ;      例：Ljava/lang/String;\n' +
          '  数组：在前面加 [，几维加几个              例：byte[]→[B   int[][]→[[I\n' +
          '  泛型：编译后擦除，JNI 层看不到            例：Map<String,String> → Ljava/util/Map;\n\n' +
          '  方法签名 = (参数描述符依次拼接)返回值描述符\n' +
          '  例：String sign(byte[] data, int ts)\n' +
          '      → ([BI)Ljava/lang/String;\n\n' +
          '【类名 → 符号名（JNI Name Mangling）】\n' +
          '  .  →  _\n' +
          '  _  →  _1\n' +
          '  ;  →  _2\n' +
          '  [  →  _3\n' +
          '  非 ASCII → _0XXXX\n\n' +
          '  com.example.app.Crypto + sign\n' +
          '   → com_example_app_Crypto（点换下划线）\n' +
          '   → Java_com_example_app_Crypto_sign\n\n' +
          '【重载怎么办】\n' +
          '  短名只含方法名，无法区分重载。虚拟机先找短名，\n' +
          '  找不到（或存在重载）再找长名：\n' +
          '   Java_<类名>_<方法名>__<参数描述符，同样做转义>\n' +
          '  注意是"两个下划线"分隔方法名和参数。\n' +
          '  <span class="pill warn">具体回退顺序以 JNI 规范 "Resolving Native Method Names" 为准</span>',
        hint:
          '<b>三步走：</b>① 把每个参数和返回值单独翻译成描述符；② 参数按顺序拼起来用括号包住；' +
          '③ 后面跟上返回值描述符。<br><br>' +
          '<b>符号名那一步：</b>注意"下划线 → _1"必须在"点 → 下划线"<b>之前</b>处理，' +
          '否则你无法区分"原本就是下划线的字符"和"由点转来的下划线"。',
        after:
          T.note('ok', '✅ 实验一的收获',
            '<p style="margin-bottom:0">这个能力在实战里的用法很具体：<br>' +
            '· 你 hook 到了 <span class="mono">RegisterNatives</span>，拿到一堆签名，<b>要能一眼看出哪个是签名函数</b>（返回值是 String、参数含 byte[]）；<br>' +
            '· 你要自己调一个 native 函数，<b>签名写错就返回 NULL</b>，而且往往没有报错信息；<br>' +
            '· 你在静态分析里看到 <span class="mono">Java_</span> 开头的导出符号，<b>要能反推出它对应哪个 Java 方法</b>。' +
            '<span class="hit">签名是 JNI 世界的"通用语言"，读不快、写不对，后面全是白费。</span></p>')
      },

      term: {
        title: 'JNI 描述符速查（照着这个表写，别凭记忆）',
        lines: [
          { t: 'd', s: '# ── 基本类型：全部是单字母 ──' },
          { t: 'o', s: 'void=V   boolean=Z   byte=B   char=C   short=S', note: '<b>先记两个反直觉的：<span class="mono">boolean</span> 是 <span class="mono">Z</span>（不是 B，B 被 byte 占了）。</b>这两个是写签名时最常错的地方。' },
          { t: 'o', s: 'int=I    long=J     float=F   double=D', note: '<b><span class="mono">long</span> 是 <span class="mono">J</span></b>，因为 <span class="mono">L</span> 要留给对象类型。' },
          { t: 'd', s: '' },
          { t: 'd', s: '# ── 对象类型：L + 全限定名（点换斜杠） + 分号 ──' },
          { t: 'o', s: 'String        →  Ljava/lang/String;' },
          { t: 'e', s: 'String        →  Ljava/lang/String      ← 少一个分号', note: '<b>后果是 <span class="mono">GetMethodID</span> 返回 NULL，而且<b>不报错</b>。</b>这类静默失败在 JNI 里到处都是——所以签名一定要用工具核对，不要凭手写。' },
          { t: 'o', s: 'Object        →  Ljava/lang/Object;\nMap           →  Ljava/util/Map;      ← 泛型被擦除' },
          { t: 'd', s: '' },
          { t: 'd', s: '# ── 数组：在前面加 [，几维加几个 ──' },
          { t: 'o', s: 'byte[]        →  [B\nint[][]       →  [[I\nString[]      →  [Ljava/lang/String;' },
          { t: 'd', s: '' },
          { t: 'd', s: '# ── 方法签名 = (参数依次拼接)返回值 ──' },
          { t: 'p', s: 'String sign(byte[] data, int ts)  →  ([BI)Ljava/lang/String;' },
          { t: 'p', s: 'boolean check()                   →  ()Z' },
          { t: 'p', s: 'void onDone(Object r)             →  (Ljava/lang/Object;)V' }
        ]
      }
    },

    /* ============================================================ 20.4 */
    {
      h: '20.4', title: '第一个 NDK 项目：从 Java 声明到 so',
      html:
        '<p>知道规范之后，工程上还要回答一串具体问题：代码放哪、怎么编译、产物怎么进 APK、' +
        '运行时怎么找到它。<b>这些"工程细节"恰恰是逆向时判断"这东西是谁写的、怎么写的"的依据。</b></p>' +
        T.card('一个最小 NDK 项目的骨架',
          T.code(
            '<span class="c">// app/src/main/java/com/example/app/Crypto.java</span>\n' +
            '<span class="k">package</span> com.example.app;\n\n' +
            '<span class="k">public class</span> <span class="f">Crypto</span> {\n' +
            '    <span class="k">static</span> { System.<span class="f">loadLibrary</span>(<span class="s">"crypto"</span>); }\n' +
            '    <span class="k">public static native</span> String <span class="f">sign</span>(String data);\n' +
            '}\n\n' +
            '<span class="c">// app/src/main/cpp/crypto.c</span>\n' +
            '<span class="p">#include</span> <span class="s">&lt;jni.h&gt;</span>\n\n' +
            'JNIEXPORT jstring JNICALL\n' +
            '<span class="f">Java_com_example_app_Crypto_sign</span>(JNIEnv* env, jclass clazz, jstring data) {\n' +
            '    <span class="k">const char</span>* s = (*env)-&gt;<span class="f">GetStringUTFChars</span>(env, data, <span class="k">NULL</span>);\n' +
            '    <span class="c">/* ……算签名…… */</span>\n' +
            '    (*env)-&gt;<span class="f">ReleaseStringUTFChars</span>(env, data, s);\n' +
            '    <span class="k">return</span> (*env)-&gt;<span class="f">NewStringUTF</span>(env, result);\n' +
            '}') ) +
        T.tbl(['工程要素', '它决定了什么', '逆向时的观察价值'],
          [
            ['<b>ABI / 架构目录</b>（<span class="mono">arm64-v8a</span>、<span class="mono">armeabi-v7a</span>、<span class="mono">x86_64</span>…）', 'so 编译给哪些架构', '只放 64 位往往意味着新版本；<b>少了某个架构，模拟器上可能根本跑不起来</b>'],
            ['<b>构建方式</b>（CMake / ndk-build）', '编译参数、优化级别、是否 strip', '<b>strip 过的 so 没有符号表</b>，静态分析只能靠导出表与字符串'],
            ['<b>加载方式</b>（<span class="mono">loadLibrary</span> / <span class="mono">load</span> / <span class="mono">dlopen</span>）', 'so 从哪来、什么时候加载', '<span class="mono">System.load</span> 可加载任意路径——<b>加固壳从 assets 解密出 so 再加载，走的就是这条路</b>'],
            ['<b>JNIEXPORT / 导出</b>', '符号是否出现在动态符号表里', '<b>加固方会主动抹掉导出</b>，改用动态注册（20.6）']
          ]) +
        T.note('warn', '⚠️ 一个新手最常踩的坑',
          '<p style="margin-bottom:0">改了 C 代码重新编译，却发现行为没变——因为<b>APK 里用的还是旧的 so</b>。' +
          'so 要么打包进 APK（重新安装才生效），要么推送到 App 的私有目录（需要 root）。' +
          '<span class="pill warn">具体路径随包名与安装方式变化</span>。' +
          '这个坑在逆向时也有价值：<b>如果你替换了 so 但检测逻辑没变，说明真正跑的不是这个 so</b>。</p>'),

      stepper: {
        title: '构建与加载：一个 so 从源码到内存',
        lines: [
          { code: '<span class="c"># 编译：把 C 源码变成共享库</span>\nclang --target=aarch64-linux-android21 \\\n      -shared -fPIC crypto.c -o libcrypto.so',
            note: '<b>① 交叉编译。</b>用 Android NDK 的工具链，目标架构由 <span class="mono">--target</span> 决定。<span class="mono">-fPIC</span> 是共享库必须的（位置无关代码）。<br><b>这里决定了一件事：产物是给哪个架构的。</b>把它和 APK 里 <span class="mono">lib/</span> 下的目录名对照，就能反推作者的构建配置。',
            state: { '产物': 'libcrypto.so', '架构': 'aarch64', '符号': '含导出符号' } },
          { code: '<span class="c"># 常见的减负一步：剥符号</span>\nllvm-strip libcrypto.so\n<span class="c"># → .symtab 被去掉，只留 .dynsym</span>',
            note: '<b>② strip。</b>去掉的是<b>静态符号表</b>（<span class="mono">.symtab</span>），保留下的是<b>动态符号表</b>（<span class="mono">.dynsym</span>）——因为动态链接器运行时还要用它。<br><span class="hit">所以"strip 过"不等于"没有符号可看"：<span class="mono">JNIEXPORT</span> 的函数通常还在 <span class="mono">.dynsym</span> 里。</span>真正让导出表变空的，是动态注册。</span>',
            state: { '产物': '已 strip', '架构': 'aarch64', '符号': '仅 .dynsym' } },
          { code: '<span class="c"># 打包进 APK</span>\napp/build/outputs/apk/.../app-release.apk\n  └── lib/arm64-v8a/libcrypto.so',
            note: '<b>③ 进包。</b>未被压缩的 so 通常可以直接从 APK 里解出来（<span class="mono">unzip</span> 即可）。<br><b>注意</b>：<span class="mono">extractNativeLibs=false</span> 时 so 会以未压缩形式存在，直接从 APK 映射进内存；为 <span class="mono">true</span> 时会先解压到 App 私有目录。<b>这直接影响你"在磁盘上能不能找到这个 so"。</b>',
            state: { '产物': 'APK', '架构': 'arm64-v8a 一份', '符号': '仅 .dynsym' } },
          { code: '<span class="c">// 运行时：Java 侧的加载动作</span>\nSystem.<span class="f">loadLibrary</span>(<span class="s">"crypto"</span>);\n<span class="c">// → dlopen("libcrypto.so") → .init_array → JNI_OnLoad</span>',
            note: '<b>④ 加载。</b>名字补全规则是 <span class="mono">lib</span> + 名字 + <span class="mono">.so</span>。加载成功后，ELF 构造函数先跑，然后虚拟机调用 <span class="mono">JNI_OnLoad</span>（如果存在）。<br><b>逆向抓手：</b>hook <span class="mono">dlopen</span> / <span class="mono">android_dlopen_ext</span> 就能<b>在 so 刚被映射、还没执行任何代码时</b>截住它——这比 attach 之后再找模块早得多。',
            state: { '产物': '已映射', '架构': '按设备选择', '符号': '已可访问' } },
          { code: '<span class="c">// 此时 JNIEnv 表已就绪，可以做任何 JNI 调用</span>\n<span class="c">// 业务方法等到第一次被调用时才真正执行</span>',
            note: '<b>⑤ 就绪。</b>到这一步，<span class="mono">JNIEnv*</span> 可用、映射已建立。<b>但业务代码还没跑</b>——它在等 Java 层第一次调用。<br><span class="hit">这个"已就绪但未执行"的窗口，是所有"抢在检测之前"的对抗手段要争取的时间差。</span>',
            state: { '产物': '可调用', '架构': '按设备选择', '符号': '可解析' } }
        ]
      },

      after:
        '<p>你可能注意到了：这一节讲的全是"工程细节"，没有一行"技术点"。' +
        '但这些细节决定了你后面能做哪些事——<b>不知道 <span class="mono">extractNativeLibs</span> 的含义，' +
        '你会在 APK 里翻半天找不到那个 so；不知道 <span class="mono">JNI_OnLoad</span> 的时机，' +
        '你的 hook 就永远慢一步。</b></p>'
    },

    /* ============================================================ 20.5 */
    {
      h: '20.5', title: '静态注册：靠名字绑定，以及它的致命缺陷',
      html:
        '<p>静态注册的全部机制就是一句话：<b>虚拟机把 Java 方法的名字按规则改写，去 so 的导出表里找同名函数。</b>' +
        '没有表、没有注册动作、没有任何显式交互——<b>纯靠命名约定</b>。</p>' +
        '<p>所以"静态注册"的逆向极其简单：打开 IDA，看导出表里 <span class="mono">Java_</span> 开头的函数，' +
        '把符号名反解回 Java 方法名，<b>一目了然</b>。</p>' +
        T.note('bad', '☠️ 这就是它被加固淘汰的原因',
          '<p style="margin-bottom:0">导出表是 so 的"公开目录"，<b>任何人都能读</b>。' +
          '只要用了静态注册，你的加密函数、校验函数、反调试函数就<b>整整齐齐列在那里，还带描述性的名字</b>。' +
          '加固方的对策是<b>动态注册</b>（下一节）：<b>不在导出表里留任何与业务相关的名字。</b></p>') +
        '<p>但静态注册没有消失——<b>大量普通 App 和第三方 SDK 仍然用它</b>。' +
        '所以它依然是你的第一顺位检查项：<b>先看导出表，有 <span class="mono">Java_</span> 就先从那里入手，成本最低。</b></p>' +
        T.card('命名改写的完整规则（JNI Name Mangling）',
          T.tbl(['原字符', '改写为', '为什么'],
            [
              ['<span class="mono">.</span>（包名分隔）', '<span class="mono">_</span>', 'C 符号里不能有点'],
              ['<span class="mono">_</span>（原名里的下划线）', '<span class="mono">_1</span>', '<b>防止歧义</b>：否则无法区分"原名下划线"和"由点转来的下划线"'],
              ['<span class="mono">;</span>', '<span class="mono">_2</span>', '出现在对象类型的描述符里'],
              ['<span class="mono">[</span>', '<span class="mono">_3</span>', '出现在数组描述符里'],
              ['非 ASCII 字符', '<span class="mono">_0XXXX</span>', 'Unicode 转义，XXXX 是四位十六进制']
            ]) +
          '<p class="small muted" style="margin-bottom:0">重载方法用长名：<span class="mono">Java_类_方法__参数描述符</span>（<b>两个下划线</b>分隔）。' +
          '虚拟机先找短名，找不到或存在重载再找长名。</p>'),

      stage: {
        title: '名字改写器：从 Java 方法到导出符号',
        speed: 1400,
        render:
          '<div class="card">' +
            '<div class="mono" id="nm-src" style="font-size:13px">com.example.app.Crypto.sign</div>' +
            '<div class="arrow">↓ 按顺序应用改写规则</div>' +
            '<div id="nm-trace" class="small" style="min-height:96px"></div>' +
            '<div class="arrow">↓ 结果</div>' +
            '<div class="blk" id="nm-out" style="font-size:13px">（未开始）</div>' +
          '</div>' +
          '<div class="card" style="margin-top:12px"><div class="card-title">再看看有下划线的类名会怎样</div>' +
            '<div class="mono" id="nm-src2" style="font-size:13px">com.example.my_app.Crypto_Util.do_sign</div>' +
            '<div class="arrow">↓ 同样的规则</div>' +
            '<div class="blk" id="nm-out2" style="font-size:13px">（未开始）</div>' +
          '</div>',
        reset: () => {
          SET('nm-trace', '');
          SET('nm-out', '（未开始）'); CLS('nm-out', 'blk');
          SET('nm-out2', '（未开始）'); CLS('nm-out2', 'blk');
        },
        steps: [
          { run: () => SET('nm-trace', '<div>① <b>先把原有的下划线转义</b>：把类名里的每个 <code>_</code> 换成 <code>_1</code></div>'),
            note: '<b>① 第一步必须处理"原有下划线"。</b>如果先做"点换下划线"，你就会造出一堆和原有下划线无法区分的新下划线——<span class="hit">顺序反了，名字就永久性地歧义了。</span>' },
          { run: () => SET('nm-trace', '<div>① 原有下划线 → <code>_1</code></div><div>② <b>再把包名分隔的点换成下划线</b>：<code>.</code> → <code>_</code></div>'),
            note: '<b>② 然后点换下划线。</b>此时转换出来的下划线"身份明确"——因为它是在转义之后才产生的，不会和原有下划线混淆。' },
          { run: () => { SET('nm-trace', '<div>① 原有下划线 → <code>_1</code></div><div>② 点 → <code>_</code>：<code>com_example_app_Crypto</code></div><div>③ <b>拼上前缀与方法名</b></div>'); S('nm-out', 'ok'); SET('nm-out', 'Java_com_example_app_Crypto_sign'); },
            note: '<b>③ 拼接。</b><span class="mono">Java_</span> + 改写后的类名 + <span class="mono">_</span> + 方法名。<br><b>这就是 IDA 导出表里你能直接看到的那个符号。</b>反解回去也一样容易——把 <span class="mono">Java_</span> 去掉、下划线换点、<span class="mono">_1</span> 还原成下划线即可。' },
          { run: () => { S('nm-out2', 'warn'); SET('nm-out2', 'Java_com_example_my_1app_Crypto_1Util_do_1sign'); },
            note: '<b>④ 有下划线的类名。</b>对照结果：<span class="mono">my_app</span> → <span class="mono">my_1app</span>，' +
              '<span class="mono">Crypto_Util</span> → <span class="mono">Crypto_1Util</span>，<span class="mono">do_sign</span> → <span class="mono">do_1sign</span>。<br>' +
              '<span class="hit">这个 <span class="mono">_1</span> 是原生的下划线，<span class="mono">my_1app</span> 里那个单独的下划线是点转来的。' +
              '看懂这个区别，你就能把符号名准确反解回 Java 方法——<b>反解错一个字符，你 hook 的就是另一个方法。</b></span>' },
          { run: () => { S('nm-out2', 'done'); }, note: '<b>⑤ 收口。</b>静态注册的<b>全部信息都在名字里</b>，这正是它"方便"和"危险"的同一个根源。<br>下一节看加固方怎么把这条路彻底封死。' }
        ]
      },

      quiz: {
        id: 'q20-2', chapter: 20, answer: 1,
        stem: '你在 IDA 的导出表里看到符号 <span class="mono">Java_com_x_y_1z_Native_a_1b</span>。它对应的 Java 方法最可能是：',
        options: [
          { t: '<span class="mono">com.x.y1z.Native.a1b</span>', why: '❌ 反了。看到 <span class="mono">_1</span> 要还原成下划线，而不是把 <span class="mono">_1</span> 当成字面内容。' },
          { t: '<span class="mono">com.x.y_z.Native.a_b</span>', why: '✅ 正确。<span class="mono">_1</span> 是原生的下划线，单独的下划线是点转来的。<b>所以 <span class="mono">y_1z</span> → <span class="mono">y_z</span>，<span class="mono">a_1b</span> → <span class="mono">a_b</span>。</b>' },
          { t: '<span class="mono">com.x.y_z.Native.a</span>，<span class="mono">_1b</span> 是重载标记', why: '❌ 重载用的是<b>两个下划线</b>加参数描述符，不是 <span class="mono">_1</span>。' },
          { t: '无法确定，必须动态 hook 才能知道', why: '❌ 过度悲观。静态注册的全部信息都在符号名里，<b>按规则反解即可</b>——这正是静态注册"方便"的地方。' }
        ],
        explain: '<b>反解规则（与改写规则严格互逆）：</b><br>' +
          '① <span class="mono">Java_</span> 前缀去掉；<br>' +
          '② 剩下的部分里，<b><span class="mono">_1</span> → <span class="mono">_</span></b>（注意：这一步必须最先做，否则会把"点转来的下划线"也误还原）；<br>' +
          '③ 其余的下划线 → <span class="mono">.</span>（包名分隔）——<b>但要小心：最后一个下划线之后是方法名</b>；<br>' +
          '④ <span class="mono">_2</span> → <span class="mono">;</span>，<span class="mono">_3</span> → <span class="mono">[</span>。<br><br>' +
          '<b>为什么这个技能值钱：</b>静态注册的函数名里往往<b>自带语义</b>——' +
          '<span class="mono">sign</span>、<span class="mono">encrypt</span>、<span class="mono">check</span>、<span class="mono">verify</span>、' +
          '<span class="mono">detect</span>。你在导出表里扫一遍，<b>几乎等于拿到了一份功能清单</b>。<br><br>' +
          '<span class="hit">而加固方对此的回应非常直接：让导出表里一个业务名字都不剩——这就是下一节的动态注册。</span>'
      }
    },

    /* ============================================================ 20.6 */
    {
      h: '20.6', title: '动态注册：RegisterNatives 与 JNI_OnLoad',
      html:
        '<p>动态注册把"名字约定"换成了"运行时的显式动作"：代码自己构造一张表，' +
        '把 <b>方法名、方法签名、函数地址</b> 三元组交给虚拟机。</p>' +
        T.code('<span class="c">// JNINativeMethod 三元组</span>\n' +
          '<span class="k">typedef struct</span> {\n' +
          '    <span class="k">const char</span>* name;       <span class="c">// Java 方法名（不是符号名！）</span>\n' +
          '    <span class="k">const char</span>* signature;  <span class="c">// JNI 方法描述符</span>\n' +
          '    <span class="k">void</span>*       fnPtr;      <span class="c">// 实际的函数地址</span>\n' +
          '} JNINativeMethod;\n\n' +
          '<span class="c">// 在 JNI_OnLoad 里注册</span>\n' +
          '<span class="k">static const</span> JNINativeMethod gMethods[] = {\n' +
          '    { <span class="s">"sign"</span>,  <span class="s">"(Ljava/lang/String;)Ljava/lang/String;"</span>, (<span class="k">void</span>*) native_sign },\n' +
          '    { <span class="s">"check"</span>, <span class="s">"()Z"</span>,                                   (<span class="k">void</span>*) native_check },\n' +
          '};\n\n' +
          'jint <span class="f">JNI_OnLoad</span>(JavaVM* vm, <span class="k">void</span>* reserved) {\n' +
          '    JNIEnv* env;\n' +
          '    vm-&gt;<span class="f">GetEnv</span>((<span class="k">void</span>**)&amp;env, JNI_VERSION_1_6);\n' +
          '    jclass cls = env-&gt;<span class="f">FindClass</span>(<span class="s">"com/example/app/Crypto"</span>);\n' +
          '    env-&gt;<span class="f">RegisterNatives</span>(cls, gMethods, <span class="k">sizeof</span>(gMethods)/<span class="k">sizeof</span>(gMethods[0]));\n' +
          '    <span class="k">return</span> JNI_VERSION_1_6;\n' +
          '}') +
        T.note('key', '🔑 这一招对逆向意味着什么（先看好消息）',
          '<p style="margin-bottom:0">动态注册<b>必须调用 <span class="mono">RegisterNatives</span></b>——' +
          '这是虚拟机提供的、唯一的注册入口。<br>' +
          '<span class="hit">不管加固方怎么混淆，这个动作绕不过去。所以"注册的那一刻"是一个<strong>稳定可观测的语义事件</strong>：' +
          '在那个瞬间，方法名、签名、函数地址三者同时在手上。</span><br>' +
          '这正是第 4 章"定制 ART 在 RegisterNatives 处插桩"和第 13 章"硬件断点"两条路线的共同立足点。</p>') +
        T.note('bad', '☠️ 但也有坏消息',
          '<p style="margin-bottom:0">加固方知道这一点，所以会做三件事：<br>' +
          '① <b>让你来不及</b>——在极早期（甚至 <span class="mono">.init_array</span> 阶段）就完成注册，你 attach 上去时已经晚了；<br>' +
          '② <b>让你看不全</b>——延迟注册、分次注册、<span class="mono">UnregisterNatives</span> 后再重注册，让映射不断变化；<br>' +
          '③ <b>让你抓错表</b>——造一张影子 JNIEnv 表，你的 hook 改的是另一张。<br>' +
          '三条对策在第 13 章已经详细展开过，这里从"写代码的人"视角再看一遍：<b>你就是那个决定要在什么时候注册的人，所以你应该知道对方会怎么防你。</b></p>'),

      stepper: {
        title: 'JNI_OnLoad 内部的注册时序（以及每一步的逆向抓手）',
        lines: [
          { code: '<span class="c">// ① 从 JavaVM 拿 JNIEnv</span>\nvm-&gt;<span class="f">GetEnv</span>((<span class="k">void</span>**)&amp;env, JNI_VERSION_1_6);',
            note: '<b>为什么不能直接用传进来的参数？</b>因为 <span class="mono">JNI_OnLoad</span> 只给你 <span class="mono">JavaVM*</span>，' +
              '没有 <span class="mono">JNIEnv*</span>。而注册需要 <span class="mono">JNIEnv</span>——所以必须先"从 VM 换一张表"。<br>' +
              '<b>逆向抓手：</b>hook <span class="mono">GetEnv</span> 能拿到 JNIEnv，但这一步能省则省——直接 hook 后面的 <span class="mono">RegisterNatives</span> 更直接。',
            state: { '步骤': '取 JNIEnv', '钩子价值': '低（可跳过）' } },
          { code: '<span class="c">// ② 找到要绑定到哪个类</span>\njclass cls = env-&gt;<span class="f">FindClass</span>(<span class="s">"com/example/app/Crypto"</span>);',
            note: '<b>注意类名用的是斜杠不是点</b>——这里用的是 JNI 的"内部名"格式，和描述符里的写法一致。<br>' +
              '<b>逆向抓手：</b>hook <span class="mono">FindClass</span> 能看到"这个 so 关心哪些类"。' +
              '加固壳可能把类名拆开拼接、或者从别处解密得到，所以静态搜索字符串未必命中，<b>但运行时一定会以明文出现在这里</b>。',
            state: { '步骤': '定位类', '钩子价值': '中（能拿到类名）' } },
          { code: '<span class="c">// ③ 构造三元组表（这一步可以完全看不出痕迹）</span>\n<span class="c">// 表项可以在运行时逐个填充、甚至解密得到</span>\nJNINativeMethod methods[<span class="n">2</span>];\nmethods[<span class="n">0</span>].name = decrypt(<span class="s">"..."</span>);',
            note: '<b>这是加固最容易做手脚的地方。</b>表可以是运行时构造的：名字解密得到、地址算出来、顺序打乱。<br>' +
              '<span class="hit">所以"在 so 里静态搜方法名字符串"经常一无所获——不代表没有动态注册，只代表名字不是你搜的那个形态。</span>' +
              '<b>结论：不要靠静态搜字符串判断有没有动态注册，要看 <span class="mono">RegisterNatives</span> 的调用。</b>',
            state: { '步骤': '构造表', '钩子价值': '低（静态看不出来）' } },
          { code: '<span class="c">// ④ 提交给虚拟机</span>\nenv-&gt;<span class="f">RegisterNatives</span>(cls, methods, <span class="n">2</span>);',
            note: '<b>唯一绕不过去的动作。</b>三个参数就是全部答案：类、表指针、表长度。<br>' +
              '<b>这一刻，Java 方法名 → 签名 → native 地址 的完整映射就在手上。</b>' +
              '<span class="hit">拿到它，你就不再需要"猜哪个函数是干什么的"——映射表直接告诉你了。</span>',
            state: { '步骤': '注册', '钩子价值': '<b>最高（完整映射）</b>' } },
          { code: '<span class="c">// ⑤ 返回版本号，告诉虚拟机"我认这个环境"</span>\n<span class="k">return</span> JNI_VERSION_1_6;',
            note: '<b>返回值决定 so 是否被认为加载成功。</b>返回 0 或负数会被当成失败。<br>' +
              '<b>逆向意义：</b>如果你在补环境（第 7 章），忘了让 <span class="mono">JNI_OnLoad</span> 返回正确的版本号，' +
              '后续所有 native 方法都可能指向未初始化的桩——<b>结果错了，还不报错。</b>',
            state: { '步骤': '返回', '钩子价值': '中（判断初始化是否成功）' } }
        ]
      },

      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '起点',
            scenario: '<b>情境：</b>你拿到一个加固 App 的 so。<b>导出表里一个 <span class="mono">Java_</span> 开头的符号都没有</b>，' +
              '但 App 的功能明显依赖 native 实现（dex 里有 <span class="mono">native</span> 方法声明）。' +
              '静态搜索几个可疑的方法名字符串，也全部零命中。',
            q: '你的下一步是？',
            choices: [
              { t: 'A. 认为这个 so 不是真正的实现，去找别的 so', next: 'na' },
              { t: 'B. 断定它用了动态注册，直接去 hook RegisterNatives', next: 'nb' },
              { t: 'C. 先把所有 so 拉出来，逐个搜索是否有加密/解密逻辑', next: 'nc' },
              { t: 'D. 放弃静态分析，直接上动态调试单步跟 JNI_OnLoad', next: 'nd' }
            ]
          },
          na: {
            label: '选A', terminal: true, verdict: 'bad', verdictTitle: '过早排除了最可能的解释',
            result: '<b>导出表为空 + dex 里有 native 声明，这两条合起来几乎就是在说"动态注册"。</b><br><br>' +
              '你选择"去找别的 so"——这个动作本身没错，但<b>顺序错了</b>：你没有先排除掉最省事的解释，' +
              '而是先去做成本最高的排查。<br><br>' +
              '<b>认知根源：把"找不到"当成了"不存在"。</b>导出表里没有 <span class="mono">Java_</span> 符号，' +
              '只说明"没有静态注册"，而<b>动态注册本来就不需要导出符号</b>——这不是反证，这是符合预期的现象。<br><br>' +
              '<span class="hit">先验证最便宜的假设，再去做昂贵的排查。这是所有逆向工作的通用纪律。</span>'
          },
          nb: {
            label: '选B', terminal: true, verdict: 'good', verdictTitle: '正确：直奔那个绕不过去的动作',
            result: '<b>这是投入产出比最高的一步。</b>理由有三条：<br><br>' +
              '① <b><span class="mono">RegisterNatives</span> 是唯一入口</b>——动态注册<b>必须</b>经过它，没有替代路径（除非用 ART 内部特性绕过，那属于更高阶的对抗，见第 13 章）；<br>' +
              '② <b>一次拿到全部答案</b>——类、方法名、签名、函数地址，四样同时到手，<b>不需要猜</b>；<br>' +
              '③ <b>成本极低</b>——一个几十行的 Frida 脚本，十几分钟就能跑通。<br><br>' +
              '<b>具体做法：</b>在 <span class="mono">libart.so</span> 的导出符号里找 ART 内部的实现（而不是 JNIEnv 表里的那个转发表项），' +
              '对它下 <span class="mono">Interceptor.attach</span>，在 <span class="mono">onEnter</span> 里把 <span class="mono">JNINativeMethod</span> 数组逐项打印出来。' +
              '<b>本章 20.13 节的实验就是这个流程的完整推演。</b><br><br>' +
              '<b>唯一要注意的：</b>如果对方在极早期就完成了注册，你可能需要改成 <span class="mono">spawn</span> 模式抢时序，' +
              '或者把观测点下沉到 ART 内部（第 4 章路线）。'
          },
          nc: {
            label: '选C', terminal: true, verdict: 'bad', verdictTitle: '用一个昂贵的动作替代了一个廉价的验证',
            result: '<b>方向不算错，但代价被严重高估了。</b>把所有 so 拉出来逐个搜逻辑，可能要好几个小时，' +
              '而且就算找到了加密函数，你<b>依然不知道它对应哪个 Java 方法</b>——因为映射关系还没拿到。<br><br>' +
              '<b>更关键的逻辑问题：</b>你不知道有几个 so、哪个是壳、哪个是业务，<b>搜索空间没有边界</b>。' +
              '而 hook <span class="mono">RegisterNatives</span> 是<b>一次把边界划定清楚</b>——它会直接告诉你哪个类注册了哪些方法，' +
              '你甚至能反推出哪个 so 才是主角。<br><br>' +
              '<span class="hit">当存在一个"一次解决定位问题"的手段时，不要先去做"逐个排除"。</span>'
          },
          nd: {
            label: '选D', terminal: true, verdict: 'bad', verdictTitle: '跳过了免费的信息',
            result: '<b>动态调试不是错的，但把它排在第一位是浪费。</b><br><br>' +
              'hook <span class="mono">RegisterNatives</span> 本质上是"<b>带过滤条件的、自动化的动态调试</b>"——' +
              '它直接把你要找的东西打印出来，而你不用单步几万行初始化代码。<br><br>' +
              '<b>而且这里有个现实的坑：</b>能让你安心单步调试的加固样本并不多——反调试、完整性校验、时序检测都会在单步时把你踢出去。' +
              '<b>你打算单步的那段代码，很可能正是检测代码本身。</b><br><br>' +
              '<span class="hit">先用"读"（hook 打印）拿到结构化信息，再用"跟"（单步）去啃剩下读不出来的部分。顺序不要反。</span>'
          }
        }
      }
    },

    /* ============================================================ 20.7 */
    {
      h: '20.7', title: '引用管理：局部、全局、弱全局',
      intuition: {
        tag: '直觉模型 · 图书馆的临时阅览号牌',
        body:
          '<p>你在图书馆借书，前台给你一个<strong>临时号牌</strong>。这个号牌只是"当前这次借阅有效"——' +
          '你离开柜台（native 函数返回），号牌就作废了。<strong>号牌数量有限，用完了就得还。</strong></p>' +
          '<p>如果你想把书<strong>长期留在手边</strong>，得办一张<strong>长期借阅证</strong>（全局引用），' +
          '而且<strong>必须自己注销</strong>——没人会替你回收。</p>' +
          '<p>还有一种<strong>弱引用</strong>：你能拿着它去问"这本书还在不在"，' +
          '但<strong>它不阻止书被收走</strong>。对象被回收后，这张弱引用就变成"查无此书"。</p>' +
          '<p>JNI 的引用规则几乎和这套一模一样，而<strong>最容易出事故的就是"临时号牌用完了"</strong>。</p>'
      },
      html:
        T.tbl(['引用类型', '生命周期', '谁负责释放', '典型误用'],
          [
            ['<b>局部引用</b>', '本次 native 调用期间有效；函数返回时自动释放', '一般自动；循环里要用 <span class="mono">DeleteLocalRef</span> 或 <span class="mono">PushLocalFrame</span>',
             '<b>在大循环里不停创建却不释放 → 表溢出崩溃</b>'],
            ['<b>全局引用</b>', '从创建到显式删除；可跨线程、跨调用使用', '<b>必须自己 <span class="mono">DeleteGlobalRef</span></b>', '忘了删 → 内存泄漏；存了指针但对象已回收 → 悬空'],
            ['<b>弱全局引用</b>', '不阻止对象被回收', '必须自己 <span class="mono">DeleteWeakGlobalRef</span>', '以为拿到就能用，<b>实际对象可能早就被回收了</b>']
          ]) +
        T.note('key', '🔑 为什么逆向的人也要懂引用',
          '<p style="margin-bottom:0">因为加固壳的历史漏洞经常就出在这里。<br>' +
          '① <b>局部引用表溢出</b>会直接崩溃——如果加固壳在循环里创建引用不释放，' +
          '你 hook 之后改变了调用次数，就可能<b>把一个原本不崩的 App 搞崩</b>，然后误判成"hook 被检测到了"；<br>' +
          '② <b>全局引用是加固壳"缓存"关键对象的标准做法</b>——比如把 <span class="mono">jclass</span> 存成全局引用留着以后用。' +
          '你在内存里找到的"长期存活的 JNI 对象"，往往就是壳的关键结构。<br>' +
          '<span class="hit">会读引用，你就能分辨"是我 hook 错了"还是"这个 App 本来就有 bug"——这个分辨能力在排查时非常值钱。</span></p>'),

      stage: {
        title: '局部引用表溢出：一个循环如何把 App 搞崩',
        speed: 1300,
        render:
          '<div class="card">' +
            '<div class="small">Android 的局部引用表容量有限，默认每线程 <b>512</b> 项 ' +
            '<span class="pill warn">具体默认值以对应 ART 版本实现为准</span>。</div>' +
            '<div class="arrow">↓ 循环 200 次，每次创建 1 个局部引用</div>' +
            '<div class="bar-wrap"><div class="bar" id="rt-bar" style="width:0%"></div></div>' +
            '<div class="small" id="rt-txt">已占用 0 / 512</div>' +
            '<div class="blk" id="rt-verdict" style="margin-top:10px">（未开始）</div>' +
          '</div>' +
          '<div class="card" style="margin-top:12px">' +
            '<div class="card-title">三个版本对照</div>' +
            '<div class="small">① 不释放　② 每次 DeleteLocalRef　③ 用 PushLocalFrame/PopLocalFrame 包住循环体</div>' +
            '<div id="rt-cmp" class="small" style="margin-top:8px">（未开始）</div>' +
          '</div>',
        reset: () => {
          CLS('rt-bar', 'bar'); document.getElementById('rt-bar').style.width = '0%';
          SET('rt-txt', '已占用 0 / 512');
          SET('rt-verdict', '（未开始）'); CLS('rt-verdict', 'blk');
          SET('rt-cmp', '（未开始）');
        },
        steps: [
          { run: () => { document.getElementById('rt-bar').style.width = '39%'; SET('rt-txt', '已占用 200 / 512'); },
            note: '<b>① 循环 200 次，每次创建一个局部引用。</b>占用 200 项——<b>离 512 还有余量，看起来一切正常</b>。<br>' +
              '<span class="hit">这就是这类 bug 最阴险的地方：小规模测试完全正常。</span>' },
          { run: () => { CLS('rt-bar', 'bar warn'); document.getElementById('rt-bar').style.width = '100%'; SET('rt-txt', '已占用 512 / 512（溢出）'); },
            note: '<b>② 循环到 512 次，表满了。</b>再来一个 <span class="mono">NewLocalRef</span> 类操作，虚拟机就会报错并终止进程。<br>' +
              '<b>注意这是"行为随规模突变"的故障</b>——不是逻辑算错，是资源耗尽。' },
          { run: () => { S('rt-verdict', 'bad'); SET('rt-verdict', '崩溃：局部引用表溢出'); },
            note: '<b>③ 结果。</b>进程直接挂掉，日志里的信息通常很有限。<br>' +
              '<b>为什么对逆向的人重要：</b>如果这个循环的<b>次数受你的 hook 影响</b>，' +
              '你就可能把一个本来稳定运行的 App 弄崩，然后错误地归因于"被检测了"。<span class="hit">先排除自己造成的崩溃，再去怀疑对抗。</span>' },
          { run: () => { SET('rt-cmp', '<div>① <b>不释放</b>：占用 = 循环次数，<b>线性增长直到溢出</b></div>' +
              '<div>② <b>每次 DeleteLocalRef</b>：占用始终是 1，<b>安全</b></div>' +
              '<div>③ <b>PushLocalFrame / PopLocalFrame 包住循环体</b>：占用在每个迭代开始时回落到基线，<b>安全且更省事</b></div>'); },
            note: '<b>④ 三个版本对照。</b><b>正确写法是 ② 或 ③。</b>注意 ③ 的优势：不需要逐个记住创建了哪些引用，' +
              '<b>整帧一次性回收</b>——这也是为什么大循环里推荐用帧而不是逐个删除。<br>' +
              '<span class="pill warn">PushLocalFrame 请求的容量有最小值限制，具体数值以 JNI 规范为准</span>' },
          { note: '<b>⑤ 收口。</b>记住这条判断链：<b>崩溃发生在"大规模 + 循环"里 → 先怀疑引用表，而不是先怀疑反调试。</b>' }
        ]
      },

      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '起点',
            scenario: '<b>情境：</b>你写了一个 Frida 脚本，在某个 native 函数里循环调用 <span class="mono">GetStringUTFChars</span> 读取一批字符串。' +
              '脚本在小样本上（10 条）稳定工作；换上一个真实样本（8000 条）后，<b>App 跑到一半直接闪退</b>，' +
              '日志里只有一行不太有用的 native crash 信息。目标 App 已知带反调试。',
            q: '你的第一反应应该是？',
            choices: [
              { t: 'A. 反调试生效了——它在检测到 Frida 后主动崩掉自己', next: 'na' },
              { t: 'B. 先怀疑自己的脚本：检查循环里有没有及时释放局部引用', next: 'nb' },
              { t: 'C. 降低样本量到 4000，看还崩不崩', next: 'nc' },
              { t: 'D. 换成 spawn 模式启动，抢在检测之前完成 hook', next: 'nd' }
            ]
          },
          na: {
            label: '选A', terminal: true, verdict: 'bad', verdictTitle: '把"自己造成的崩溃"归因给了对手',
            result: '<b>这是逆向排查里最常见的一种误判。</b><br><br>' +
              '反调试导致的崩溃通常有特征：<b>在固定的时间点崩（比如启动后 N 秒）、在任何输入规模下都崩、' +
              '或者崩之前有明显的检测动作</b>。而这里的现象是"<b>小样本正常、大样本崩</b>"——' +
              '<span class="hit">这是"资源随规模耗尽"的典型特征，不是检测的特征。</span><br><br>' +
              '<b>为什么会这么想：</b>因为你先知道了"这个 App 有反调试"，于是把一切异常都往那个方向解释。' +
              '这叫<b>确认偏误</b>——手里有锤子，看什么都像钉子。<br><br>' +
              '<b>正确的心理顺序：</b>先排除<b>自己引入的变量</b>（脚本、hook、时序），再怀疑环境。<br>' +
              '因为<b>修改方是自己</b>——你是那个唯一改变了运行环境的人，你才是第一嫌疑人。'
          },
          nb: {
            label: '选B', terminal: true, verdict: 'good', verdictTitle: '正确：先审自己，再疑对手',
            result: '<b>这是唯一能快速收敛的动作，而且它对应一个具体的、已知的故障模式。</b><br><br>' +
              '<b>"小样本正常 + 大样本崩" 几乎就是在指认局部引用表溢出：</b><br>' +
              '· <span class="mono">GetStringUTFChars</span> 会创建一个局部引用（以及一块 native 内存）；<br>' +
              '· 局部引用表容量有限（Android 默认每线程 512 项量级 <span class="pill warn">以实际 ART 实现为准</span>）；<br>' +
              '· 8000 次循环里如果不释放，<b>远远超过容量</b>，虚拟机必然报错终止。<br><br>' +
              '<b>修法有两种：</b>① 每次用完 <span class="mono">ReleaseStringUTFChars</span> + <span class="mono">DeleteLocalRef</span>；' +
              '② 用 <span class="mono">PushLocalFrame</span> / <span class="mono">PopLocalFrame</span> 把循环体包起来，<b>整帧一次性回收</b>。<br><br>' +
              '<b>顺带一个附加收益：</b><span class="mono">GetStringUTFChars</span> 拿到的 native 字符串也必须 <span class="mono">ReleaseStringUTFChars</span>，' +
              '否则泄漏的是真正的内存。<b>引用和内存是两笔账，都要还。</b>'
          },
          nc: {
            label: '选C', terminal: true, verdict: 'bad', verdictTitle: '在试探阈值，而不是在诊断原因',
            result: '<b>这个动作会产生数据，但产生不了结论。</b><br><br>' +
              '降到 4000：如果还崩，你能得出什么？如果好了，你又能得出什么？' +
              '——最多只能确认"和规模有关"，<b>但你依然不知道为什么、以及该怎么修</b>。<br><br>' +
              '<b>更糟的是</b>：局部引用表是<b>共享的、累加的</b>——App 自己的代码、其他线程、你 hook 的其他位置，' +
              '都在消耗同一张表。所以"崩在 4000 还是 8000"是<b>不确定的</b>，取决于当时表里已经有多少。' +
              '<span class="hit">用二分法找一个本来就不稳定的阈值，是在浪费轮次。</span><br><br>' +
              '<b>当你已经能说出一个具体的候选机制时，直接去验证那个机制，不要再做黑盒试探。</b>'
          },
          nd: {
            label: '选D', terminal: true, verdict: 'bad', verdictTitle: '换了个启动方式，没换掉真正的病灶',
            result: '<b>spawn 模式解决的是"时机"问题，而这次的症状不是时机问题。</b><br><br>' +
              'spawn 能让你在 App 主线程跑起来之前完成 hook，对付"启动早期检测"很有效。' +
              '但你的崩溃发生在<b>处理 8000 条数据的循环里</b>——那是运行中后期，spawn 一点忙都帮不上。<br><br>' +
              '<b>代价是真实的：</b>换 spawn 往往要重写脚本的注入逻辑、处理时序、还要重新验证一遍之前的 hook 是否仍生效。' +
              '<b>你付出了一次不小的改动成本，换来的是一个和症状无关的改变。</b><br><br>' +
              '<span class="hit">每次动手之前先问一句：<b>这个动作，作用在我怀疑的那个机制上吗？</b>如果答不上来，说明你还没定位到机制。</span>'
          }
        }
      },

      quiz: {
        id: 'q20-3', chapter: 20, answer: [0, 2],
        stem: '（多选）关于 JNI 引用，下面哪些说法是<b>正确</b>的？',
        options: [
          { t: '局部引用在 native 函数返回时会自动释放，但在大循环里仍需要手动管理', why: '✅ 正确。"自动释放"的时机是<b>函数返回</b>，不是"用完一次就释放"。循环里不主动释放就会累积到表满。' },
          { t: '全局引用和局部引用一样会在函数返回时自动释放，只是作用域更大', why: '❌ 错。全局引用<b>必须显式删除</b>，从来不会自动释放——这正是它泄漏风险高的原因。' },
          { t: '弱全局引用不阻止对象被回收，所以使用前需要判断对象是否还活着', why: '✅ 正确。弱引用的意义就是"不阻止回收"，所以拿到它不等于拿到对象，必须先确认对象仍然存在。' },
          { t: 'PushLocalFrame / PopLocalFrame 是用来扩大局部引用表容量的', why: '❌ 方向错了。它是用来<b>成批回收</b>引用的——PopLocalFrame 会把这一帧内创建的引用一次性释放，<b>是省事，不是扩容</b>。' }
        ],
        explain: '<b>把三类引用当成三种"所有权的约定"就清楚了：</b><br><br>' +
          '<b>① 局部引用——自动的、短命的、有限的。</b>函数返回时统一释放，所以单次调用里随便创建都没事。' +
          '但<b>"自动释放"发生在函数边界，不发生在语句边界</b>：一个循环里创建 10000 个，函数还没返回，表就已经满了。<br>' +
          '· 逐个释放：<span class="mono">DeleteLocalRef</span><br>' +
          '· 批量释放：<span class="mono">PushLocalFrame</span> / <span class="mono">PopLocalFrame</span>（推荐用于循环）<br><br>' +
          '<b>② 全局引用——手动的、长命的、必须自己回收的。</b>跨线程、跨调用都用它。' +
          '正因为"没人替你回收"，它才是内存泄漏的高发区。<b>加固壳用它缓存关键对象，所以内存里活得特别久的 JNI 引用值得关注。</b><br><br>' +
          '<b>③ 弱全局引用——不持有的、随时可能失效的。</b>它回答"对象还在吗"，不回答"对象归我"。' +
          '典型用途是缓存一个你并不想阻止其回收的对象。<b>拿到弱引用后必须先确认对象存活，再决定是否升级成全局引用。</b><br><br>' +
          '<span class="hit">一个工程上的实用建议：<b>在 JNI 代码里看到"在循环中创建引用"就条件反射地找释放语句</b>——' +
          '这个习惯能帮你避开绝大多数 JNI 崩溃。</span>'
      }
    },

    /* ============================================================ 20.8 */
    {
      h: '20.8', title: '异常、线程与那些"静默失败"',
      html:
        '<p>JNI 的错误处理方式和 Java 很不一样，而<b>最危险的一类问题不是崩溃，是"什么都没发生"</b>。</p>' +
        T.card('异常处理：native 层不会自动帮你传播',
          T.code('<span class="c">// 调用了一个可能抛异常的 JNI 函数之后</span>\n' +
            'jthrowable ex = (*env)-&gt;<span class="f">ExceptionOccurred</span>(env);\n' +
            '<span class="k">if</span> (ex) {\n' +
            '    (*env)-&gt;<span class="f">ExceptionDescribe</span>(env);   <span class="c">// 打印到日志（调试用）</span>\n' +
            '    (*env)-&gt;<span class="f">ExceptionClear</span>(env);      <span class="c">// 清掉，否则后续 JNI 调用大多会失败</span>\n' +
            '    <span class="c">// 或者原谅它：(*env)-&gt;ThrowNew(env, cls, "msg");</span>\n' +
            '}') +
          '<p style="margin-bottom:0">关键规则：<b>有未处理的 pending 异常时，大多数 JNI 函数的行为是未定义或直接失败</b>。' +
          '所以"先检查、再清除、或者自己抛出"是标准动作。' +
          '<span class="hit">如果 native 代码不管异常继续调用，你会看到一连串莫名其妙的 NULL 返回值——' +
          '而真正的错误发生在更早的那一次调用。</span></p>') +
        T.card('线程：JNIEnv 不能跨线程用',
          '<p><b>这是新手最容易犯的错。</b>从 Java 线程 A 拿到的 <span class="mono">JNIEnv*</span>，' +
          '拿到线程 B 里用——<b>行为未定义</b>。</p>' +
          '<p>原因在结构上：<span class="mono">JNIEnv</span> 是<b>线程本地</b>的。' +
          '每个线程要自己在 VM 上"附着"，拿到属于自己那张环境表。</p>' +
          T.code('<span class="c">// 在 native 创建的线程里，必须先附着</span>\n' +
            'JavaVM* vm = <span class="c">/* 全局保存的，通常来自 JNI_OnLoad */</span>;\n' +
            'JNIEnv* env;\n' +
            'jint r = vm-&gt;<span class="f">AttachCurrentThread</span>(&amp;env, <span class="k">NULL</span>);\n' +
            '<span class="c">/* ……用 env 干活…… */</span>\n' +
            'vm-&gt;<span class="f">DetachCurrentThread</span>();   <span class="c">// 不收尾会导致线程无法正常退出</span>') +
          '<p style="margin-bottom:0"><b>逆向意义：</b>加固壳的反调试、心跳上报、完整性校验经常跑在<b>自己的 native 线程</b>里。' +
          '<span class="hit">这也解释了为什么你在主线程 hook 半天抓不到它的检测动作——<b>它根本不在主线程上。</b></span>' +
          '排查这类问题时，"换线程看"往往比"换 hook 点"更有效。</p>'),

      quiz: {
        id: 'q20-4', chapter: 20, answer: 3,
        stem: '你的 Frida 脚本 hook 了某个检测函数，<b>确认 hook 装上了、日志里也打印了 "hook installed"，但目标函数一次都没被调用过</b>。' +
          '目标 App 确实做了环境检测（行为上能观察到）。最值得优先怀疑的是？',
        options: [
          { t: 'hook 写错了，应该用 <span class="mono">Interceptor.replace</span> 而不是 <span class="mono">attach</span>', why: '❌ 如果 hook 根本没装上，你的 "hook installed" 日志不会打印。而且 <span class="mono">attach</span> 与 <span class="mono">replace</span> 的差别是"拦截后是否执行原函数"，与"是否被调用"无关。' },
          { t: '目标函数的符号被 strip 了，你 hook 到了同名的另一个函数', why: '❌ 有可能，但这属于"hook 到了错的地址"。如果 strip 导致解析失败，通常 <span class="mono">attach</span> 阶段就会报错，而不是静默地"没被调用"。' },
          { t: '检测逻辑被内联展开了，根本没有作为独立函数存在', why: '❌ 这是编译器优化的真实可能，但它属于"函数不存在"而不是"函数没被调用"，而且内联后你 attach 的地址本该无效或落在别的函数里。' },
          { t: '检测跑在另一个线程（native 自建线程）或更早的时机（so 加载阶段）', why: '✅ 最值得优先怀疑。这两种情况都会让你"hook 装上了但永远等不到调用"——<b>因为调用发生在你观测范围之外</b>。' }
        ],
        explain: '<b>"hook 装上了但从未命中"是一个信息量很大的现象，先把它读对：</b><br><br>' +
          '· <b>hook 装上了</b> → 地址解析成功、注入成功，<b>不是工具问题</b>；<br>' +
          '· <b>从未命中</b> → 这段代码在你观测期间<b>没有执行</b>。<br><br>' +
          '那"为什么没执行"只有三种可能：<b>时机不对、线程不对、位置不对。</b><br><br>' +
          '<b>① 时机不对（最常见）。</b>检测发生在 <span class="mono">.init_array</span> 或 ' +
          '<span class="mono">JNI_OnLoad</span> 里——<b>在你 attach 之前就已经跑完了</b>。' +
          '对策：改用 <span class="mono">spawn</span> 模式，或者把 hook 提前到 <span class="mono">dlopen</span> 上。' +
          '<span class="hit">"你 attach 的时候，它已经检查过了"是加固对抗里最经典的时序问题。</span><br><br>' +
          '<b>② 线程不对。</b>检测在 native 自建线程里跑。' +
          '对策：打印 <span class="mono">Process.getCurrentThreadId()</span> 观察；或用 Stalker 全线程跟踪。<br><br>' +
          '<b>③ 位置不对。</b>你 hook 的是"名字看起来对"的函数，但真正的检测在另一处（可能被 OLLVM 内联、' +
          '可能被动态注册隐藏、可能压根是另一份实现）。<br><br>' +
          '<b>排查顺序：先加观测点，再猜原因。</b>在你的 hook 里加一个计数器、在 <span class="mono">dlopen</span> 处也加一个、' +
          '把 attach 的地址和模块名都打出来——<b>十分钟的观测，胜过一小时的猜测。</b><br><br>' +
          '<span class="hit">顺带记住：这个"装上了但零命中"的现象，和 20.2 节讲的"影子函数表"、' +
          '20.6 节讲的"极早期注册"是同一类问题的不同表现——<b>都指向"你的观测点不在它的执行路径上"。</b></span>'
      }
    },

    /* ============================================================ 20.9 */
    {
      h: '20.9', title: '主动调用：native 回调 Java 的那一半',
      html:
        '<p>前面讲的都是"Java → native"。反过来那一半——<b>native 代码主动调 Java 方法、读 Java 字段、造 Java 对象</b>——' +
        '才是加固和风控真正依赖的部分。</p>' +
        T.tbl(['你要做的事', 'JNI 接口', '关键点'],
          [
            ['拿到类', '<span class="mono">FindClass</span> / <span class="mono">GetObjectClass</span>', '<b>FindClass 用的是"斜杠格式"的类名</b>；且它受<b>调用线程的类加载器</b>影响'],
            ['拿到方法 ID', '<span class="mono">GetMethodID</span> / <span class="mono">GetStaticMethodID</span>', '<b>必须给准确的签名</b>，写错返回 NULL（且不报错）'],
            ['调用方法', '<span class="mono">CallObjectMethod</span> / <span class="mono">CallIntMethod</span> / <span class="mono">CallVoidMethod</span> / <span class="mono">…Static…</span>', '名字里的类型必须和<b>返回值</b>匹配；带 <span class="mono">A</span> 后缀的版本接收 <span class="mono">jvalue*</span> 数组'],
            ['读字段', '<span class="mono">GetFieldID</span> + <span class="mono">GetObjectField</span> / <span class="mono">GetIntField</span> / …', '<b>字段也有签名</b>，同样写错返回 NULL'],
            ['写字段', '<span class="mono">SetObjectField</span> / <span class="mono">SetIntField</span> / …', '<b>这是壳替换对象状态的标准手法</b>'],
            ['造对象', '<span class="mono">FindClass</span> → <span class="mono">GetMethodID</span>("&lt;init&gt;") → <span class="mono">NewObject</span>', '<b>构造函数在 JNI 里的名字是 <span class="mono">&lt;init&gt;</span></b>，返回类型是 <span class="mono">V</span>']
          ]) +
        T.note('key', '🔑 反调试为什么几乎都要走这条路',
          '<p style="margin-bottom:0">native 层想知道"我是不是被 hook 了"、"设备是不是真机"、"签名对不对"，' +
          '往往需要 Java 层的信息（<span class="mono">Build</span> 字段、包签名、类是否存在）。' +
          '所以它的检测逻辑一定会<b>回调 Java</b>。<br>' +
          '<span class="hit">这给你留了一个通用的观测面：<b>hook Java 侧的 <span class="mono">getPackageInfo</span>、' +
          '<span class="mono">Build</span> 相关调用、<span class="mono">Class.forName</span>，' +
          '就能反推出 native 层在查什么</b>——哪怕你完全看不懂那个 so。</span></p>'),

      stepper: {
        title: '一次 native → Java 的完整调用序列',
        lines: [
          { code: '<span class="c">// ① 找到类</span>\njclass cls = (*env)-&gt;<span class="f">FindClass</span>(env, <span class="s">"android/os/Build"</span>);\n<span class="c">// 注意：斜杠格式，不是 android.os.Build</span>',
            note: '<b>① 类名用斜杠。</b>这是 JNI 的"内部名"格式。<b>写点会返回 NULL——而且不报错。</b><br>' +
              '<b>隐蔽性的第一个来源：</b>类名可以运行时拼接、解密得到，静态搜 <span class="mono">"android/os/Build"</span> 可能什么都搜不到。',
            state: { '步骤': '1', '产物': 'jclass', '常见错误': '用了点号' } },
          { code: '<span class="c">// ② 拿到静态字段 ID</span>\njfieldID fid = (*env)-&gt;<span class="f">GetStaticFieldID</span>(env, cls, <span class="s">"MODEL"</span>, <span class="s">"Ljava/lang/String;"</span>);',
            note: '<b>② 字段名 + 字段签名，两个都要对。</b>静态字段用 <span class="mono">GetStaticFieldID</span>，实例字段用 <span class="mono">GetFieldID</span>。<br>' +
              '<span class="hit">加固壳的常见混淆手法：把字段名和签名也加密存放，运行时解密后再查——这样静态分析完全看不到它在查什么。</span>',
            state: { '步骤': '2', '产物': 'jfieldID', '常见错误': '签名写错' } },
          { code: '<span class="c">// ③ 读值</span>\njstring model = (jstring)(*env)-&gt;<span class="f">GetStaticObjectField</span>(env, cls, fid);',
            note: '<b>③ 按类型选对应的 Get 函数。</b><span class="mono">GetStaticObjectField</span> 用于对象类型，' +
              '基本类型有 <span class="mono">GetStaticIntField</span> 等。<br>' +
              '<b>逆向抓手：</b>hook 这一层就能看到它在读哪个字段。' +
              '<b>但更省事的做法是 hook Java 侧</b>——如果它读的是 <span class="mono">Build.MODEL</span>，你 hook Java 字段访问比 hook native 容易得多。',
            state: { '步骤': '3', '产物': 'jstring', '常见错误': '用错类型函数' } },
          { code: '<span class="c">// ④ 转成 C 字符串使用</span>\n<span class="k">const char</span>* s = (*env)-&gt;<span class="f">GetStringUTFChars</span>(env, model, <span class="k">NULL</span>);\n<span class="c">/* 比较、上报等 */</span>\n(*env)-&gt;<span class="f">ReleaseStringUTFChars</span>(env, model, s);',
            note: '<b>④ 取字符串 + 必须释放。</b>两笔账：<span class="mono">ReleaseStringUTFChars</span> 还的是 native 内存，' +
              '而 jstring 本身作为局部引用还要靠 <span class="mono">DeleteLocalRef</span>（或函数返回时自动回收）。<br>' +
              '<span class="pill warn">GetStringUTFChars 返回的是"修改过的 UTF-8"，与标准 UTF-8 在补充平面字符上有差异，细节以 JNI 规范为准</span>',
            state: { '步骤': '4', '产物': 'C 字符串', '常见错误': '忘记释放' } },
          { code: '<span class="c">// ⑤ 反向：调用一个 Java 方法</span>\njclass c2 = (*env)-&gt;<span class="f">FindClass</span>(env, <span class="s">"java/lang/System"</span>);\njmethodID mid = (*env)-&gt;<span class="f">GetStaticMethodID</span>(env, c2, <span class="s">"currentTimeMillis"</span>, <span class="s">"()J"</span>);\njlong t = (*env)-&gt;<span class="f">CallStaticLongMethod</span>(env, c2, mid);',
            note: '<b>⑤ 静态方法调用。</b>注意 <span class="mono">CallStaticLongMethod</span> 这个名字里的 ' +
              '<span class="mono">Long</span> 对应的是<b>返回类型 <span class="mono">J</span></b>。<br>' +
              '<span class="hit">这一族函数的名字是最容易写错的地方：<span class="mono">CallObjectMethod</span> / ' +
              '<span class="mono">CallBooleanMethod</span> / <span class="mono">CallIntMethod</span> / <span class="mono">CallLongMethod</span> / ' +
              '<span class="mono">CallVoidMethod</span>——<b>名字必须与返回值类型一致，否则行为未定义。</b></span>',
            state: { '步骤': '5', '产物': 'jlong', '常见错误': 'Call 函数名与返回类型不匹配' } },
          { code: '<span class="c">// ⑥ 构造一个 Java 对象</span>\njclass c3 = (*env)-&gt;<span class="f">FindClass</span>(env, <span class="s">"java/util/HashMap"</span>);\njmethodID ctor = (*env)-&gt;<span class="f">GetMethodID</span>(env, c3, <span class="s">"&lt;init&gt;"</span>, <span class="s">"()V"</span>);\njobject map = (*env)-&gt;<span class="f">NewObject</span>(env, c3, ctor);',
            note: '<b>⑥ 构造函数叫 <span class="mono">&lt;init&gt;</span>，返回类型是 <span class="mono">V</span>。</b>' +
              '这是新手最容易卡住的一个点——JNI 里没有"构造"这个动作，<b>构造就是对 <span class="mono">&lt;init&gt;</span> 的一次调用</b>。<br>' +
              '<b>实战意义：</b>壳经常用 native 造对象（构造加密参数、构造上报结构）。' +
              '你在 Java 层看到某个对象<b>没有对应的构造调用栈</b>，就说明它是 native 造的。',
            state: { '步骤': '6', '产物': 'jobject', '常见错误': '把构造函数当成特殊接口去找' } }
        ]
      },

      term: {
        title: 'Call*Method 家族：名字必须和返回类型对上',
        lines: [
          { t: 'd', s: '# ── 实例方法 ──' },
          { t: 'o', s: 'CallVoidMethod      CallBooleanMethod   CallByteMethod\nCallCharMethod      CallShortMethod     CallIntMethod\nCallLongMethod      CallFloatMethod     CallDoubleMethod' },
          { t: 'o', s: 'CallObjectMethod    ← 返回任意对象（jobject）', note: '<b>返回类型是对象时用 <span class="mono">CallObjectMethod</span>，具体是 String 还是别的，由你自己按签名去解释。</b>JNI 不做类型检查。' },
          { t: 'd', s: '' },
          { t: 'd', s: '# ── 静态方法：名字前面加 Static ──' },
          { t: 'o', s: 'CallStaticIntMethod / CallStaticObjectMethod / CallStaticVoidMethod …' },
          { t: 'd', s: '' },
          { t: 'd', s: '# ── 特殊：不按虚表分发 ──' },
          { t: 'o', s: 'CallNonvirtualVoidMethod / CallNonvirtualObjectMethod …', note: '<b>它绕过虚方法分发，直接调用指定类的那一份实现。</b>壳用它来"越过子类覆写"——你在分析时看到这个，说明调用方想强制走父类逻辑。' },
          { t: 'd', s: '' },
          { t: 'd', s: '# ── 带 A 后缀：参数打包成 jvalue 数组 ──' },
          { t: 'p', s: 'CallObjectMethodA(env, obj, mid, jvalue* args)' },
          { t: 'w', s: '名字里的类型 ≠ 实际返回值类型  →  行为未定义', note: '<b>这是最容易写错、也最难查的一类 bug：</b>不报错、不崩溃，只是结果莫名其妙。<b>在逆向时如果你 unidbg 补环境"静默算错"，回头检查这个家族的名字有没有用错。</b>' }
        ]
      }
    },

    /* ============================================================ 20.10 */
    {
      h: '20.10', title: '反射：为什么它在加固里无处不在',
      html:
        '<p>反射是 Java 提供的"绕过编译期名字"的能力：<b>用字符串去查类、查方法、查字段，然后调用它</b>。</p>' +
        '<p>对加固方来说，这简直是量身定做的工具，理由只有一个：<b>字符串可以是运行时才出现的。</b></p>' +
        T.code('<span class="c">// Java 反射的三段式</span>\n' +
          'Class&lt;?&gt; c   = Class.<span class="f">forName</span>(name);              <span class="c">// ① 拿类</span>\n' +
          'Method m    = c.<span class="f">getDeclaredMethod</span>(mName, argTypes); <span class="c">// ② 拿方法</span>\n' +
          'm.<span class="f">setAccessible</span>(<span class="k">true</span>);                        <span class="c">// ③ 突破访问控制</span>\n' +
          'Object r    = m.<span class="f">invoke</span>(target, args);             <span class="c">// ④ 调用</span>') +
        T.tbl(['反射的价值', '对加固方', '对逆向方'],
          [
            ['<b>名字可以运行时生成</b>', '类名/方法名加密存放，运行时解密 → <b>静态搜字符串零命中</b>', '把观测点移到<b>反射 API 本身</b>：hook <span class="mono">Class.forName</span>、<span class="mono">getDeclaredMethod</span>、<span class="mono">Method.invoke</span>'],
            ['<b>可以访问私有成员</b>', '不修改系统类也能改内部状态', '它绕过的访问控制<b>你也能绕过</b>——同一个入口'],
            ['<b>可以调用隐藏 API</b>', '调用系统非公开接口', '<b>Android 9 起对隐藏 API 有灰/黑名单限制</b>，这也是它需要 <span class="mono">setAccessible</span> 或绕过手段的原因 <span class="pill warn">限制细节随版本变化</span>'],
            ['<b>调用点与实现解耦</b>', '同一份代码可以在不同版本上走不同路径', '你的 hook 也必须<b>解耦</b>——别按类名写死，要按行为特征']
          ]) +
        T.note('key', '🔑 一条可以反复用的经验',
          '<p style="margin-bottom:0"><b>凡是"名字被藏起来"的地方，反射就是它的必经之路。</b><br>' +
          '因为反射的 API 名字本身是固定的（<span class="mono">forName</span>、<span class="mono">invoke</span>…），' +
          '<b>它藏不了自己</b>。<br>' +
          '<span class="hit">所以：字符串搜不到 → 去 hook 反射 API，被藏起来的名字会在那里现身。</span>' +
          '这条经验在 Xposed 生态里同样成立——第 22 章会看到 Xposed 自己就是靠反射实现 Hook 的。</p>'),

      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '起点',
            scenario: '<b>情境：</b>你要找一个 App 的签名算法。已知：<br>' +
              '· 静态搜 MD5/SHA/AES 的常量特征，<b>全部零命中</b>；<br>' +
              '· 静态搜类名和方法名（<span class="mono">sign</span>、<span class="mono">encrypt</span>、<span class="mono">Signature</span>…），<b>也零命中</b>；<br>' +
              '· so 有动态注册，但 hook 到的映射表里<b>没有任何名字看起来像签名</b>（名字都被混淆成了 <span class="mono">a</span>、<span class="mono">b</span>、<span class="mono">c</span>）；<br>' +
              '· 抓包能拿到请求和响应，但请求体是密文。',
            q: '四条线索都断了。下一步最应该做的是？',
            choices: [
              { t: 'A. 在反射 API 上布观测点：hook Class.forName / getDeclaredMethod / Method.invoke，看运行时到底在调什么', next: 'na' },
              { t: 'B. 静态搜索 so 里所有字符串，看看有没有可疑的类名或方法名', next: 'nb' },
              { t: 'C. 直接上动态调试，从请求发出的调用栈往回跟', next: 'nc' },
              { t: 'D. 认定这个 App 的签名在服务端，放弃本地还原', next: 'nd' }
            ]
          },
          na: {
            label: '选A', terminal: true, verdict: 'good', verdictTitle: '正确：去找那个"藏不了自己"的入口',
            result: '<b>四条线索全断，恰恰是在指认同一件事：这个 App 用反射把名字藏起来了。</b><br><br>' +
              '推理链是这样的：<br>' +
              '· <b>常量零命中</b> → 算法要么被魔改、要么跑在别的实现里（第 8 章情况）；<br>' +
              '· <b>名字零命中（Java 侧 + native 映射表）</b> → 名字<b>不是静态存在的</b>，而是运行时产生的 → ' +
              '<span class="hit">运行时产生名字，在 Java 里只有一条路：反射。</span><br><br>' +
              '<b>为什么反射是可以被观测的：</b>反射的 API 名字<b>必须写死在代码里</b>——' +
              '<span class="mono">Class.forName</span>、<span class="mono">getDeclaredMethod</span>、<span class="mono">Method.invoke</span> ' +
              '这些是系统 API，加固方不能改自己的名字。<b>它只能藏"被查找的那个名字"，藏不了"查找"这个动作。</b><br><br>' +
              '<b>具体做法：</b>hook <span class="mono">java.lang.Class.forName</span>、' +
              '<span class="mono">getDeclaredMethod</span> / <span class="mono">getMethod</span>、' +
              '<span class="mono">Method.invoke</span>、<span class="mono">Class.getDeclaredFields</span>，' +
              '把<b>类名、方法名、参数类型、调用栈</b>都打出来。<br>' +
              '<b>大概率你会在几秒内看到那个被藏起来的签名方法的真实名字。</b>'
          },
          nb: {
            label: '选B', terminal: true, verdict: 'bad', verdictTitle: '重复了一遍已经失败的动作',
            result: '<b>你已经在做这件事了——而且它已经失败了。</b><br><br>' +
              '题目里"静态搜类名和方法名零命中"说的就是静态字符串搜索。' +
              '再做一遍同样的动作，只是把范围从"dex"扩到"so"，<b>不会改变结论</b>。<br><br>' +
              '<b>除非</b>你有一个具体的理由相信"名字在 so 里但是加密存放的"——' +
              '那你要做的也不是"搜索"，而是<b>去找到解密函数</b>（这恰好是第 8 章常量比对的思路）。' +
              '<span class="hit">"再搜一遍"不是一种策略，它只是把同一个动作重复一次。</span><br><br>' +
              '<b>判断标准很简单：</b>如果我做这个动作，<b>成功时会看到什么？失败时说明什么？</b>' +
              '如果两个问题都答不上来，这个动作就不该做。'
          },
          nc: {
            label: '选C', terminal: true, verdict: 'bad', verdictTitle: '方向对，但你还没找到"从哪往回跟"',
            result: '<b>"从请求发出的调用栈往回跟"这句话里，缺一个关键信息：请求是在哪发出的？</b><br><br>' +
              '如果签名和请求组装都在同一个方法里，那这个思路很好。' +
              '但现在的现象是<b>名字全被藏了</b>——说明请求组装和签名很可能是<b>两条被反射解耦的路径</b>：' +
              '主流程通过反射去调签名，调用栈上看到的是 <span class="mono">Method.invoke</span> 这种"通用入口"，' +
              '<b>而不是一个有意义的方法名</b>。<br><br>' +
              '<span class="hit">在反射解耦的代码里，调用栈几乎不提供信息——你看到的永远是一层反射框架。</span>' +
              '<b>所以必须先解决"名字从哪来"的问题，才能谈"从哪往回跟"。</b><br><br>' +
              '顺序应该是：<b>先用 hook 反射 API 拿到名字（选A），再用调用栈去跟（选C）。</b>' +
              '选C不是错，是<b>次序错了</b>。'
          },
          nd: {
            label: '选D', terminal: true, verdict: 'bad', verdictTitle: '用一个未经证实的假设结束了工作',
            result: '<b>"四条线索都断了"不等于"本地没有算法"。</b><br><br>' +
              '这个结论需要证据支撑：你看到请求体被<b>服务端下发的密钥</b>加密了吗？' +
              '你确认客户端<b>只是转发</b>了一个服务端算好的签名吗？<br>' +
              '——题目里一条都没有。<b>你只是遇到了困难，然后把它解释成了"做不到"。</b><br><br>' +
              '<b>为什么这个判断代价很高：</b>一旦认定"在服务端"，你就会停止一切本地分析，' +
              '而这条路的返工成本极大（要重新组织全部上下文）。' +
              '<span class="hit">把"我暂时不知道怎么做"和"这件事做不到"分开，是逆向里最重要的自律之一。</span><br><br>' +
              '<b>而且反例很常见：</b>绝大多数 App 的签名必须在<b>客户端</b>算——因为服务端要独立验证它，' +
              '如果签名由服务端生成，客户端就没有存在的必要了。' +
              '<b>请求体是密文，通常说明的是"算法藏起来了"，不是"算法不在本地"。</b>'
          }
        }
      }
    },

    /* ============================================================ 20.11 */
    {
      h: '20.11', title: 'onCreate Native 化：把入口搬进 so',
      html:
        '<p>到这一步，你已经能把 Java 和 native 两边都写通了。接下来看加固方怎么用这套能力<b>制造分析障碍</b>。</p>' +
        '<p>"onCreate Native 化"指的是：<b>把原本写在 Java 里的生命周期逻辑（尤其是 <span class="mono">onCreate</span>）搬进 native 层</b>。' +
        '这样 dex 里只剩下一个空的 <span class="mono">native</span> 声明，<b>真正的初始化逻辑全部在 so 里</b>。</p>' +
        T.tbl(['做法', 'Java 侧剩下什么', '分析障碍在哪'],
          [
            ['把 <span class="mono">onCreate</span> 改成 <span class="mono">native</span> 方法', '一个方法签名，没有方法体', '<b>dex 反编译看不到任何逻辑</b>；且 native 方法天然"没有 code_item"'],
            ['注册 Activity 生命周期回调', '一个回调注册调用', '逻辑在回调实现里，<b>调用点与实现分离</b>'],
            ['把 Application 的逻辑整个搬进 so', '一个 <span class="mono">attachBaseContext</span> 或 <span class="mono">onCreate</span> 的 native 声明', '<b>最彻底</b>：连加固入口都看不见了'],
            ['运行时"换掉"Activity 的实现', '看起来正常的 Java 代码', '动态注册/反射替换，<b>静态与运行时不一致</b>']
          ]) +
        T.note('warn', '⚠️ 它同时付出了什么代价',
          '<p style="margin-bottom:0">加固方不是在做"免费"的事：<br>' +
          '① <b>调试变难</b>——对它自己也是，线上问题排查成本上升；<br>' +
          '② <b>兼容性风险</b>——不同 Android 版本的生命周期实现会变，把生命周期搬进 native 意味着<b>要跟着系统版本走</b>；<br>' +
          '③ <b>ANR 与启动耗时</b>——native 初始化如果慢，直接体现为用户可感知的启动变慢。<br>' +
          '<span class="hit">记住这一条：<b>任何加固手段都有代价，代价就是它的"特征"。</b>' +
          '启动特别慢、崩溃率特别高、兼容性特别差的 App，往往加固做得特别狠——这不是巧合。</span></p>'),

      stage: {
        title: 'onCreate 被 Native 化之后，初始化流程长什么样',
        speed: 1400,
        render:
          '<div class="grid2">' +
            '<div class="card"><div class="card-title">Java 侧（你能反编译到的）</div>' +
              '<div class="blk" id="lc-j1">MainActivity.onCreate(Bundle)</div>' +
              '<div class="arrow">↓</div>' +
              '<div class="blk" id="lc-j2">native onCreate(Bundle)<br><span class="small">只有声明，没有方法体</span></div>' +
              '<div class="arrow">↓ ↓ ↓</div>' +
              '<div class="blk" id="lc-j3">（dex 里到此为止）</div>' +
            '</div>' +
            '<div class="card"><div class="card-title">native 侧（你要去 so 里找的）</div>' +
              '<div class="blk" id="lc-n1">反调试 / 环境检测</div>' +
              '<div class="blk" id="lc-n2">解密字符串与 dex</div>' +
              '<div class="blk" id="lc-n3">动态注册业务函数</div>' +
              '<div class="blk" id="lc-n4">反射回调原 Java 逻辑</div>' +
              '<div class="blk" id="lc-n5">完整性校验</div>' +
            '</div>' +
          '</div>' +
          '<div id="lc-note" class="small muted" style="margin-top:10px">点「播放」开始。</div>',
        reset: () => {
          ['lc-j1', 'lc-j2', 'lc-j3', 'lc-n1', 'lc-n2', 'lc-n3', 'lc-n4', 'lc-n5'].forEach(id => S(id, ''));
          SET('lc-note', '<span class="muted">点「播放」开始。</span>');
        },
        steps: [
          { run: () => { S('lc-j1', 'active'); }, note: '<b>① 系统调用 onCreate。</b>一切看起来正常——这里确实是 App 的入口。' },
          { run: () => { S('lc-j1', 'done'); S('lc-j2', 'hot'); }, note: '<b>② 但 onCreate 是个 native 方法。</b>你把 dex 反编译出来，看到的就是这么一行声明——' +
            '<span class="hit">没有方法体，因为方法体根本不在 dex 里。</span><b>静态分析到这里就断了。</b>' },
          { run: () => { S('lc-j2', 'done'); S('lc-j3', 'bad'); }, note: '<b>③ Java 侧的信息到此为止。</b>注意：<b>这不是"被混淆了"，而是"真的不在这里"</b>。' +
            '混淆是让代码难读，Native 化是让代码不在这个文件里——<b>两者的应对方式完全不同。</b>' },
          { run: () => { S('lc-n3', 'warn'); }, note: '<b>④ 真正的第一件事，往往是动态注册。</b>壳先把业务函数注册好，这样后面反射回调 Java 时才有目标。<br>' +
            '<span class="hit">这正是第 20.6 节那套机制——所以你 hook <span class="mono">RegisterNatives</span> 的价值在这里再次体现：' +
            '它是你从这个"黑盒 so"里撕开的第一道口子。</span>' },
          { run: () => { S('lc-n1', 'bad'); }, note: '<b>⑤ 检测通常排在很前面。</b>反调试、环境检测往往在注册之后、业务逻辑之前——' +
            '<b>因为它要确保"接下来跑的代码没被观测"。</b><br>' +
            '这解释了一个常见现象：<b>你能 hook 到注册，但一往下走就被踢出去。</b>' },
          { run: () => { S('lc-n1', 'done'); S('lc-n2', 'warn'); }, note: '<b>⑥ 解密字符串与 dex。</b>壳在这里把加密存放的数据解出来——' +
            '包括类名、方法名（供反射用）、以及可能的内嵌 dex。<br>' +
            '<b>观测建议：</b>解密完成后<b>内存里就是明文</b>。与其逆解密算法，不如在解密之后 dump 内存（这是第 8 章"动态 dump 常量"的同一种思路）。' },
          { run: () => { S('lc-n2', 'done'); S('lc-n5', 'bad'); }, note: '<b>⑦ 完整性校验。</b>校验 dex 有没有被改、so 有没有被改、签名对不对。<br>' +
            '<span class="hit">它排在这里不是随意的：<b>它在等所有东西都加载完，才能校验完整状态。</b>' +
            '所以"校验点"通常出现在初始化链路的相对靠后位置——这也是你 hook 时最容易撞上的地方。</span>' },
          { run: () => { S('lc-n5', 'done'); S('lc-n4', 'ok'); SET('lc-note', '结论：入口在 Java，逻辑在 native，中间靠反射连接。'); },
            note: '<b>⑧ 反射回调原本的 Java 逻辑。</b>壳并不想重写业务——它只是把入口<b>搬走</b>，' +
              '真正干活的方法还在 dex 里，通过反射调用。<br>' +
              '<b>这就给你留了活路：</b>业务逻辑没消失，<b>它只是"被隔了一层"</b>。' +
              '你在 Java 层布好反射观测点（第 20.10 节），就能把被调用的业务方法<b>重新接回静态分析</b>。' },
          { note: '<b>⑨ 收口。</b>把这条链路记住：<b>Java 入口 → native 初始化（检测 / 解密 / 注册 / 校验）→ 反射回 Java 业务</b>。' +
            '每一环都有一个对应的观测手段，<b>没有哪一环是"真的看不见"的。</b>' }
        ]
      }
    },

    /* ============================================================ 20.12 */
    {
      h: '20.12', title: '加固方的 NDK 开发：壳在 native 层做了什么',
      html:
        '<p>把前面几节的能力反过来用，就是加固。这一节把"壳在 native 层的动作"列成一张清单——' +
        '<b>你后面遇到任何一个加固样本，都可以拿这张清单去对照。</b></p>' +
        T.tbl(['壳的动作', '用到了哪个 JNI 能力', '留下的破绽（你的入口）'],
          [
            ['<b>隐藏入口</b>：抹掉 <span class="mono">Java_</span> 导出符号，改用动态注册', '<span class="mono">JNI_OnLoad</span> + <span class="mono">RegisterNatives</span>', '<b>注册这个动作必须发生</b>——hook 它就能拿到完整映射（20.6）'],
            ['<b>藏名字</b>：类名/方法名/字段名加密存放，运行时解密', '<span class="mono">FindClass</span> / <span class="mono">GetMethodID</span>', '解密后<b>内存里是明文</b>——动态 dump 比逆解密便宜（20.13）'],
            ['<b>反射解耦</b>：业务方法通过反射调用，调用栈上不留名字', '<span class="mono">GetMethodID</span> + <span class="mono">CallObjectMethod</span>', '<b>反射 API 名字固定、藏不住</b>——hook 它即可（20.10）'],
            ['<b>状态替换</b>：改 Java 对象的字段值来改变行为', '<span class="mono">SetObjectField</span> / <span class="mono">SetIntField</span>', '<b>写字段是可观测的</b>；且可以对比"静态初值 vs 运行时值"'],
            ['<b>环境检测</b>：读 <span class="mono">Build</span>、包签名、文件系统状态', '<span class="mono">GetStaticFieldID</span> / <span class="mono">CallObjectMethod</span>', '<b>检测要拿数据，拿数据就要回调 Java</b>——在 Java 侧布点反推'],
            ['<b>反调试 / 反注入</b>：检测调试器、hook 框架、<span class="mono">/proc/self/maps</span>', '直接 syscall 或 <span class="mono">CallObjectMethod</span>', '同样要读状态——<b>读行为比读代码容易</b>（第 10、13 章）'],
            ['<b>完整性校验</b>：校验 dex / so / 签名', '读文件 + 摘要计算 + 比较', '<b>比较这个动作</b>是关键：改掉比较结果比改掉校验逻辑便宜'],
            ['<b>影子函数表</b>：伪造 <span class="mono">JNIEnv</span> 让你的 hook 落空', '自己构造函数指针数组', '<b>表地址会暴露</b>——打印表地址就能发现（20.2）']
          ]) +
        T.note('key', '🔑 把这张表读成一句话',
          '<p style="margin-bottom:0">壳的所有动作都遵循同一个模式：<b>把"名字"和"逻辑"从静态可读的地方，搬到运行时才能确定的地方。</b><br>' +
          '而你的所有对策也遵循同一个模式：<b>不跟它比"谁藏得好"，而是去观测"它必须做的那些动作"。</b><br>' +
          '<span class="hit">它必须注册、必须查名字、必须反射、必须读环境、必须比较——<b>这些动作就是它的接口，也是你的接口。</b></span></p>'),

      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '起点',
            scenario: '<b>情境：</b>你在分析一个加固 App。你已经成功 hook 到了 <span class="mono">RegisterNatives</span> 并拿到了完整的映射表，' +
              '但映射表里的方法名全是 <span class="mono">a</span>、<span class="mono">b</span>、<span class="mono">c</span> 这种混淆名。' +
              '你随便 hook 了几个，发现它们<b>确实在做加密运算</b>，但输入输出看起来毫无规律。' +
              '同时你注意到 App 启动时有明显的卡顿。',
            q: '接下来最有效的推进方向是？',
            choices: [
              { t: 'A. 逐个反汇编这些 native 函数，从汇编层还原算法', next: 'na' },
              { t: 'B. 在 Java 层布反射与加密 API 的观测点，让"谁调了这些函数"自己暴露出来', next: 'nb' },
              { t: 'C. 先用 Frida 主动调用这些函数，用输入输出对拍去猜算法', next: 'nc' },
              { t: 'D. 启动卡顿说明有检测，先把反调试绕过去再回来分析算法', next: 'nd' }
            ]
          },
          na: {
            label: '选A', terminal: true, verdict: 'bad', verdictTitle: '在信息最少的层面上投入最大的成本',
            result: '<b>反汇编不是错的，但它应该是最后一步，不是第一步。</b><br><br>' +
              '你现在面对的是"混淆名 + 看不懂的输入输出"。直接读汇编意味着：<br>' +
              '· <b>不知道这个函数在算法链条的哪个位置</b>——它可能是加密，也可能是解密、编码、压缩、甚至只是拷贝；<br>' +
              '· <b>不知道谁调它、它又调谁</b>——孤立地读一个函数，你无法判断输入从哪来、输出到哪去；<br>' +
              '· <b>混淆名意味着没有语义提示</b>——"<span class="mono">a</span> 函数"和"<span class="mono">b</span> 函数"对你没有区别。<br><br>' +
              '<span class="hit">读汇编的性价比，取决于你已经知道多少上下文。上下文越少，读汇编越像在猜谜。</span><br><br>' +
              '<b>先花二十分钟建立上下文，可能省掉两天的反汇编。</b>而且——如果这些函数是通过反射被调用的，' +
              '反射那一步会<b>直接把方法名告诉你</b>，混淆名就自动失效了。'
          },
          nb: {
            label: '选B', terminal: true, verdict: 'good', verdictTitle: '正确：让调用关系自己暴露',
            result: '<b>这一步直接解决你最大的困难——"不知道这些函数在干什么"。</b><br><br>' +
              '理由：<br>' +
              '① <b>混淆名只能混淆 native 侧的名字</b>，而 native 要通过反射回调 Java 时，<b>必须使用真实的方法名和签名</b>——' +
              '那些名字是 Java 类的真实名字，加固方通常不会把整个 Java 业务层也混淆掉（成本太高）。' +
              '<span class="hit">所以反射观测点会直接告诉你"这个 <span class="mono">a</span> 函数最终调用了哪个 Java 方法"。</span><br>' +
              '② <b>加密 API 观测点能定位算法环节</b>——如果 native 最终走的是 <span class="mono">MessageDigest</span> / <span class="mono">Cipher</span>，' +
              '你在 Java 侧就能看到算法名、密钥、输入输出（这正是第 24 章自吐沙箱的核心思路）。<br>' +
              '③ <b>成本极低</b>——几十行 Frida 脚本，几分钟就能看到结果。<br><br>' +
              '<b>关于"启动卡顿"：</b>这是一个有用的旁证。卡顿往往对应"初始化时做了大量工作"——' +
              '解密、校验、扫描。你把观测点布在启动阶段，<b>很可能一次抓到它的初始化全景</b>。'
          },
          nc: {
            label: '选C', terminal: true, verdict: 'bad', verdictTitle: '在对拍之前，你缺一个致命的参照物',
            result: '<b>主动调用 + 输入输出对拍是非常好的手段——但它需要一个前提：你知道"什么是对的"。</b><br><br>' +
              '对拍的逻辑是：给一组输入，看输出，然后判断"这像不像 MD5 / AES / 某个变种"。' +
              '但你现在的情况是：<br>' +
              '· 你<b>不知道这些函数是不是纯函数</b>——如果它依赖全局状态（密钥、随机数、时间戳），同样的输入会得到不同输出，对拍直接失效；<br>' +
              '· 你<b>不知道入参的语义</b>——是原始数据？还是已经编码过的数据？还是某个中间态？<br>' +
              '· 你<b>不知道调用顺序</b>——这些函数可能是链条的一环，单独调用它得到的输出没有意义。<br><br>' +
              '<span class="hit">对拍能回答"这是什么算法"，但回答不了"它在链条的哪一环"。后者恰恰是你现在缺的。</span><br><br>' +
              '<b>正确顺序：先用反射观测拿到调用关系和上下文（选B），再用对拍去确认算法（选C+C 的方法）。</b>' +
              '不是选C错，是它排早了。'
          },
          nd: {
            label: '选D', terminal: true, verdict: 'bad', verdictTitle: '把一条弱线索当成了主线',
            result: '<b>"启动卡顿 = 有检测"这个推论太强了。</b><br><br>' +
              '卡顿的常见原因有一堆：壳在初始化时解密大量数据、扫描文件、做完整性校验、加载多个 so、' +
              '甚至只是<b>加固本身带来的性能损耗</b>（第 20.11 节讲过，加固不是免费的）。<br>' +
              '<b>它只能说明"启动阶段做了很多事"，不能说明"它在检测你"。</b><br><br>' +
              '<b>为什么这个误判代价大：</b>反调试绕过是一个<b>可能有终点的兔子洞</b>——' +
              '你绕过了这一处，可能还有下一处；而且绕过的过程会<b>大幅改变运行环境</b>，' +
              '让后续的算法分析更难对照。<br><br>' +
              '<span class="hit">更务实的做法：<b>先做能推进的事</b>（布观测点拿上下文），' +
              '等真的撞上检测（脚本被踢、进程退出）再去处理它。<b>不要提前解决还没发生的问题。</b></span>'
          }
        }
      },

      quiz: {
        id: 'q20-5', chapter: 20, answer: [1, 3],
        stem: '（多选）关于"加固壳用动态注册隐藏 native 入口"，下面哪些说法是<b>正确</b>的？',
        options: [
          { t: '因为导出表里没有 Java_ 符号，所以这类 so 无法定位到任何 native 函数', why: '❌ 恰恰相反。<b>导不出来名字，不等于没有入口</b>——注册那一刻映射表就完整暴露了。把"静态不可见"当成"无法分析"是最常见的误判。' },
          { t: 'RegisterNatives 是动态注册的唯一标准入口，因此它是一个稳定可观测的语义事件', why: '✅ 正确。这是本章反复强调的立足点：<b>动作必须发生，所以必然可观测</b>。' },
          { t: '只要在 so 里静态搜索方法名字符串，就能判断它有没有用动态注册', why: '❌ 这个判据不可靠。动态注册的方法名<b>可以是运行时解密或拼接出来的</b>，静态搜不到不代表没有注册；反之搜到字符串也不代表一定注册了。' },
          { t: '如果加固方在极早期就完成注册，你需要把观测点提前（如 spawn 模式或 dlopen hook）', why: '✅ 正确。这是"时机对抗"：<b>注册本身绕不过去，但它可以发生得比你 attach 更早</b>。' }
        ],
        explain: '<b>把"能不能看见"拆成三个独立的问题，就不会搞混：</b><br><br>' +
          '<b>① 名字在哪里？</b>静态注册 → 在导出表；动态注册 → 在运行时的 <span class="mono">JNINativeMethod</span> 数组里。' +
          '所以"导出表为空"只是一个关于<b>位置</b>的陈述，不是关于<b>存在</b>的陈述。<br><br>' +
          '<b>② 什么时候能看见？</b>这是<b>时序</b>问题。动态注册绕不过 <span class="mono">RegisterNatives</span>，' +
          '但对方可以让它发生得非常早。<b>你能不能在它之前就位，是另一个独立的问题。</b><br><br>' +
          '<b>③ 看见了能不能用？</b>这是<b>对抗</b>问题。你可能被影子表骗、被 <span class="mono">UnregisterNatives</span> + 重注册耍、' +
          '被 <span class="mono">ArtMethod</span> 级别的绑定绕过。<b>这些都需要在第 13 章那套"只读不写"的手段里解决。</b><br><br>' +
          '<span class="hit">三个问题分别对应"静态搜索 / 时序抢占 / 只读观测"三种能力。把它们混在一起谈，就会得出"这个 so 没法分析"这种错误结论。</span>'
      }
    },

    /* ============================================================ 20.13 */
    {
      h: '20.13', title: '从逆向视角追踪 JNI：三条路线与一个完整推演',
      html:
        '<p>这一节把前面所有能力收口成一套可执行的追踪方法。追踪"Java 方法 → native 函数"的映射，一共只有三条路线。</p>' +
        T.tbl(['路线', '做法', '优势', '代价'],
          [
            ['<b>① 静态命名约定</b>', '读导出表里 <span class="mono">Java_</span> 开头的符号，反解回 Java 方法（20.5）', '<b>零成本</b>、不需要运行 App', '只对静态注册有效；加固样本上通常一无所获'],
            ['<b>② 运行时 hook 注册动作</b>', 'hook <span class="mono">RegisterNatives</span>（JNIEnv 表里的转发表项，或 ART 内部实现），打印三元组数组', '<b>一次拿到完整映射</b>；对静态/动态注册都有效', '会被反 Hook 检测；<b>时机可能太晚</b>；可能被影子表骗'],
            ['<b>③ 只读观测 ART 内部结构</b>', '读 <span class="mono">ArtMethod</span> / <span class="mono">mirror::Class</span> 的方法表，直接算出口地址', '<b>不写内存，检测不到</b>；不受影子表影响', '要懂该版本 ART 的内存布局；<b>字段偏移随版本变化</b>']
          ]) +
        T.note('key', '🔑 三者的关系不是"哪个更好"，而是"哪个更早、更稳、更贵"',
          '<p style="margin-bottom:0">' +
          '① 最便宜，能用就先用；<br>' +
          '② 覆盖面最广，是主力手段，<b>能拿到名字和签名</b>——这是它不可替代的地方；<br>' +
          '③ 最隐蔽，但<b>拿不到"名字"</b>（它只给你地址），所以它解决的是"你的 hook 被发现了"而不是"我不知道映射"。<br>' +
          '<span class="hit">实战顺序：先花两分钟看导出表（①）→ 不行就上 ② → ② 被检测了才考虑 ③ 或第 13 章的内核路线。</span></p>') +
        T.card('路线 ② 的核心原理（读懂这段，你就能自己写脚本）',
          '<p>为什么要去 <span class="mono">libart.so</span> 里找符号，而不是直接 hook JNIEnv 表里的槽位？</p>' +
          '<p><b>因为表可以被伪造，符号不容易被伪造。</b>' +
          'JNIEnv 表是每个线程各有一份、地址随版本变化、还可能被壳换成影子表；' +
          '而 <span class="mono">libart.so</span> 的导出符号是<b>由 Android 系统编译出来的</b>，位置相对稳定。</p>' +
          T.code('<span class="c">// 思路示意（不是可直接运行的完整脚本）</span>\n' +
            '<span class="c">// ① 到 libart.so 的导出符号里找 ART 内部的 RegisterNatives</span>\n' +
            '<span class="c">//    C++ 名字修饰后的形态大致是：</span>\n' +
            '<span class="c">//    _ZN3art3JNI15RegisterNativesEP7_JNIEnvP7_jclassPK15JNINativeMethodi</span>\n' +
            '<span class="k">var</span> syms = Module.<span class="f">enumerateSymbolsSync</span>(<span class="s">"libart.so"</span>);\n' +
            '<span class="k">for</span> (<span class="k">var</span> i = 0; i &lt; syms.length; i++) {\n' +
            '  <span class="k">var</span> s = syms[i];\n' +
            '  <span class="c">// 三个关键词同时命中，并且排除 CheckJNI 版本</span>\n' +
            '  <span class="k">if</span> (s.name.<span class="f">indexOf</span>(<span class="s">"art"</span>) &gt;= 0 &amp;&amp;\n' +
            '      s.name.<span class="f">indexOf</span>(<span class="s">"JNI"</span>) &gt;= 0 &amp;&amp;\n' +
            '      s.name.<span class="f">indexOf</span>(<span class="s">"RegisterNatives"</span>) &gt;= 0 &amp;&amp;\n' +
            '      s.name.<span class="f">indexOf</span>(<span class="s">"CheckJNI"</span>) &lt; 0) {\n' +
            '    <span class="c">// ② 对找到的地址下钩子</span>\n' +
            '    <span class="f">Interceptor.attach</span>(s.address, {\n' +
            '      onEnter: <span class="k">function</span> (args) {\n' +
            '        <span class="c">// args[0]=env  args[1]=jclass  args[2]=JNINativeMethod*  args[3]=count</span>\n' +
            '        <span class="c">// ③ 按 count 遍历数组，每项三个字段：name / signature / fnPtr</span>\n' +
            '        <span class="c">// ④ 用 Java.vm.getEnv().getClassName(jclass) 过滤出你关心的类</span>\n' +
            '      }\n' +
            '    });\n' +
            '    <span class="k">break</span>;\n' +
            '  }\n' +
            '}') +
          '<p class="small muted" style="margin-bottom:0">' +
          '<span class="pill warn">符号名的修饰形态、数组字段偏移、jclass 转类名的具体 API 都随 ART 版本与语言绑定变化，' +
          '请以你目标设备上的实际符号表与 JNI 规范为准，不要照抄字符串</span></p>'),

      lab: {
        title: '实验二：从一份注册日志还原完整的 JNI 映射',
        goal: '目标：把一堆名字变成一张可用的映射表',
        intro:
          '<p>下面是一段模拟的 <span class="mono">RegisterNatives</span> hook 输出（形态参考真实脚本的打印结果）。' +
          '<b>请你把它读成一张映射表，并回答两个问题。</b></p>' +
          '<p>这个实验练的是实战里最关键的一步：<b>拿到映射之后，怎么快速看出"哪个是重点"。</b>' +
          '在真实样本里，你可能会拿到几百条记录——不可能每条都读汇编。<b>必须会筛选。</b></p>',
        inputs: [
          {
            key: 'dump',
            label: 'RegisterNatives 输出',
            hint: '可以直接改：删掉几行、改掉签名试试',
            type: 'textarea', rows: 9,
            value:
              '[RegisterNatives] class=com.example.app.Crypto count=5\n' +
              '  #0  sign            (Ljava/lang/String;)Ljava/lang/String;   fnPtr=0x7a1b2c3d\n' +
              '  #1  a               ([B)[B                                     fnPtr=0x7a1b2d10\n' +
              '  #2  check           ()Z                                       fnPtr=0x7a1b2e40\n' +
              '  #3  b               (Ljava/lang/String;I)Ljava/lang/String;    fnPtr=0x7a1b2f88\n' +
              '  #4  nativeGetTime   ()J                                       fnPtr=0x7a1b30a0'
          },
          { key: 'cnt', label: '① 这份 dump 里，哪个方法<b>最可能是签名/加密入口</b>？（填方法名）', ph: '方法名' },
          { key: 'why', label: '② 为什么它最可疑？说清你的判据', hint: '从参数、返回值、名字三个角度说', type: 'textarea', rows: 3 },
          { key: 'hidden', label: '③ 这份 dump 里有几条记录是<b>静态导出表查不到</b>的？（填数字）', hint: '动态注册的记录都查不到', ph: '例如 5' }
        ],
        runLabel: '🔍 解析注册日志',
        autorun: true,
        run: v => {
          const R = ch20ParseRegDump(v.dump || '');
          if (R.err) return '<div class="lab-msg warn">解析失败：' + R.err + '</div>';
          let html = '<div class="lab-kv">' +
            '<span>目标类 <b>' + ch20esc(R.cls) + '</b></span>' +
            '<span>注册条数 <b>' + R.rows.length + '</b></span>' +
            '<span>解析出的描述符 <b>' + R.rows.filter(r => r.descOk).length + ' / ' + R.rows.length + '</b></span></div>';
          html += '<table class="lab-tbl"><tr><th>#</th><th>方法名</th><th>签名</th><th>参数</th><th>返回</th><th>若静态注册的符号名</th></tr>' +
            R.rows.map((r, i) =>
              '<tr><td>' + i + '</td><td><code>' + ch20esc(r.name) + '</code></td>' +
              '<td style="font-size:11px"><code>' + ch20esc(r.sig) + '</code>' + (r.descOk ? '' : ' <span class="pill bad">描述符可疑</span>') + '</td>' +
              '<td>' + (r.args.length || '<span class="muted">无</span>') + '</td>' +
              '<td><code>' + ch20esc(r.ret) + '</code></td>' +
              '<td style="font-size:11px"><code>' + ch20esc(r.staticSymbol) + '</code></td></tr>').join('') +
            '</table>';
          html += '<div class="lab-msg key"><b>🔑 读这份日志的三个要点</b><div class="lab-note">' +
            '① <b>名字是最强的信号。</b><span class="mono">sign</span> / <span class="mono">encrypt</span> / ' +
            '<span class="mono">check</span> / <span class="mono">verify</span> 这类名字是加固方<b>没来得及或懒得混淆</b>的残留——' +
            '混淆是要花成本的，很多样本只混淆一部分。<br>' +
            '② <b>签名是第二强的信号。</b>返回 <span class="mono">Ljava/lang/String;</span> 且参数含 ' +
            '<span class="mono">String</span> 或 <span class="mono">[B</span> 的，八成是编码/摘要/签名；' +
            '返回 <span class="mono">Z</span> 的八成是校验。<b>参数是 <span class="mono">[B</span> 说明它在处理二进制——经常就是加密本体。</b><br>' +
            '③ <b>被混淆成单字母的，恰恰是最需要重点看的。</b>加固方<b>只混淆它认为重要的东西</b>——' +
            '<span class="mono">a</span>、<span class="mono">b</span> 这种名字本身就是一种"重要性标记"。<br><br>' +
            '<b>关于第③问：</b>动态注册的<b>每一条</b>记录都不会出现在静态导出表里——' +
            '因为动态注册<b>本来就不产生 <span class="mono">Java_</span> 符号</b>。' +
            '所以"静态查不到"的条数 = 这份 dump 的总条数。' +
            '<span class="hit">这正是为什么"先看导出表"在加固样本上会一无所获——它不是失败，它只是告诉你"这里走了另一条路"。</span>' +
            '</div></div>';
          html += '<div class="lab-msg model"><b>💡 下一位分析者会怎么做</b><div class="lab-note">' +
            '拿到这张表之后的推进顺序（对比一下你的直觉）：<br>' +
            '① 先 hook <b>名字可读</b>的那几个（<span class="mono">sign</span> / <span class="mono">check</span>）——<b>成本最低，先确认这个 so 确实在干业务</b>；<br>' +
            '② 再 hook <b>单字母名 + <span class="mono">[B</span> 参数</b>的那几个——<b>这里才是难点</b>；<br>' +
            '③ 对每个 hook 到的调用，<b>打印调用栈和线程</b>——这一步能立刻分辨"业务调用"和"自检调用"；<br>' +
            '④ 观察 <b><span class="mono">nativeGetTime</span></b> 这类工具函数——它往往揭示了"签名是怎么防重放的"（时间戳参与签名）。<br>' +
            '<span class="hit">注意④：很多人在签名算法里找不到"时间戳"是从哪来的，其实它就在同一张映射表里，只是名字看起来很无害。</span>' +
            '</div></div>';
          return html;
        },
        expected: v => {
          const R = ch20ParseRegDump(v.dump || '');
          if (R.err) return { ok: false, detail: '解析失败：' + R.err };
          const cand = String(v.cnt || '').trim();
          const ok1 = R.rows.some(r => r.name === cand);
          const okName = cand === 'sign' || cand === 'b' || cand === 'a';
          const ok2 = window.AKKC_hasConcept(v.why || '',
            ['参数', '返回值', '名字', 'string', 'byte', '二进制', '摘要', '签名', '混淆', '单字母',
             '可读', '语义', '长度', 'hex', '十六进制', 'sign', '命名']);
          const n = parseInt(String(v.hidden || '').replace(/[^0-9]/g, ''), 10);
          const ok3 = n === R.rows.length;
          return {
            ok: ok1 && okName && ok2 && ok3,
            detail:
              (ok1 ? (okName ? '✅ 方法名存在，且判断合理：<code>' + ch20esc(cand) + '</code> 是这份表里<br>' +
                  '· 名字<b>直接可读</b>且语义明确（<code>sign</code>），或<br>' +
                  '· 名字被混淆但<b>签名明显在处理二进制/字符串</b>（<code>a</code> / <code>b</code>）<br>' +
                  '这三者都值得优先看。<b>关键是你的判据能不能说清"为什么"。</b>'
                : '⚠️ 方法名 <code>' + ch20esc(cand) + '</code> 确实在表里，但它不太像最优先的目标。<br>' +
                  '比对一下候选的签名差异：<code>check()Z</code> 返回布尔——那是校验；' +
                  '<code>nativeGetTime()J</code> 返回时间——那是工具；' +
                  '<b>而参数/返回值是 String 或 byte[] 的，才最可能是编码与加密本体。</b>')
                : '❌ dump 里没有名为 <code>' + ch20esc(cand) + '</code> 的方法。可选项：' +
                  R.rows.map(r => r.name).join(' / ')) +
              '<br>' +
              (ok2 ? '✅ 判据说得通：<b>你从参数形态、返回类型或命名规律里至少抓住了一条。</b>'
                   : '❌ 判据还不够。<b>不要只说"看起来像"</b>——要说清用的是哪条线索：' +
                     '参数是 <code>[B</code>（在处理二进制）？返回是 <code>String</code>（产出可读结果）？' +
                     '还是名字没被混淆？') +
              '<br>' +
              (ok3 ? '✅ 数量正确：<b>动态注册的每一条都不会出现在静态导出表里</b>，所以是 ' + R.rows.length + ' 条。'
                   : '❌ 数量不对。正确答案是 <b>' + R.rows.length + '</b> 条。<br>' +
                     '关键理解：<b>动态注册根本不产生 <code>Java_</code> 符号</b>，' +
                     '所以这份表里的<b>每一条</b>都是静态查不到的——不是"部分查不到"。')
          };
        },
        showAnswer:
          '【① 最可能是签名/加密入口】\n' +
          '  sign 与 b（以及 a）都值得优先看，判据分三层：\n' +
          '    名字层：sign 语义明确 —— 加固方常常只混淆一部分\n' +
          '    签名层：返回 Ljava/lang/String; 且参数是 String/int → 典型的签名函数形态\n' +
          '             参数是 [B → 在处理二进制，往往是加密本体\n' +
          '    对照层：check()Z 是校验、nativeGetTime()J 是工具函数\n\n' +
          '  【重要判断】被混淆成单字母的 a / b 反而最需要看：\n' +
          '    加固方只混淆它认为重要的东西，单字母名本身就是"重要性标记"。\n\n' +
          '【② 判据】\n' +
          '  · 参数类型：String / [B → 处理文本或二进制\n' +
          '  · 返回类型：Ljava/lang/String; → 产出可读结果（hex、base64 等）\n' +
          '  · 命名：未被混淆的名字是加固方的疏漏\n' +
          '  · 位置：与 GetTime 类工具函数同表，说明它们在同一个业务链路里\n\n' +
          '【③ 静态导出表查不到的条数】\n' +
          '  全部 5 条。\n' +
          '  原因：动态注册通过 RegisterNatives 建立映射，\n' +
          '        它不产生任何 Java_ 前缀的导出符号。\n' +
          '  → "导出表为空"和"动态注册"是同一件事的两面。\n\n' +
          '【下一位分析者的推进顺序】\n' +
          '  1) 先 hook 名字可读的（sign / check）→ 确认 so 在干业务\n' +
          '  2) 再 hook 单字母名 + [B 参数的 → 这里才是难点\n' +
          '  3) 每次命中打印调用栈与线程 → 区分"业务调用"与"自检调用"\n' +
          '  4) 别忽略 nativeGetTime → 它揭示了防重放机制（时间戳参与签名）',
        hint:
          '<b>别只看名字。</b>这三个信号按可靠性排序：<br>' +
          '① <b>签名</b>（最可靠）——参数里出现 <span class="mono">[B</span> 说明在处理二进制；' +
          '返回 <span class="mono">Ljava/lang/String;</span> 说明产出可读结果。这两个特征同时出现，基本就是编码/加密函数。<br>' +
          '② <b>名字</b>——没被混淆的名字是信息，但<b>也可能是诱饵</b>。<br>' +
          '③ <b>所在表的位置</b>——和工具函数（取时间、取字符串）在同一张表里，说明它们属于同一个业务链路。<br><br>' +
          '<b>第③问再想一层：</b>动态注册的符号会出现在静态导出表里吗？为什么？',
        after:
          T.note('ok', '✅ 实验二的收获',
            '<p style="margin-bottom:0">你现在能做一件很具体的事：<b>拿到一份 RegisterNatives dump，在五分钟内排出分析优先级。</b><br>' +
            '这个能力的重要性经常被低估。真实样本的映射表可能有几百条，' +
            '<span class="hit">如果你按顺序逐个读汇编，三天也读不完；如果你能按"签名形态 + 命名规律"排序，' +
            '往往前三个就是目标。</span><br>' +
            '而排序的依据，就是你刚刚在用的那三条：<b>参数形态、返回类型、命名异常度。</b></p>')
      }
    },

    /* ============================================================ 20.14 实战案例 */
    {
      h: '20.14', title: '实战案例：BOSS 直聘 libyzwg.so 的动态注册追踪',
      case: {
        source: 'kanxue',
        title: 'boss app sig参数',
        date: '2023-12-24',
        author: '杨如画',
        target: 'BOSS 直聘 App（版本 11.240）· libyzwg.so（该版本由 32 位换成 64 位）· 设备 Pixel 4 XL / Android 10',
        background:
          '<p>这篇帖子完整走了一遍本章的主线，而且<b>每一步都用到了本章讲过的具体机制</b>：' +
          '抓包定位参数 → Java 层 hook 缩小范围 → 发现 native 方法 → 导出表里搜 jni 一无所获 → ' +
          '<b>判定为动态注册</b> → 写 Frida 脚本 hook ART 内部的 RegisterNatives 拿映射。</p>' +
          '<p>作者的原话是「<b>在导出表里搜索 jni 发现是动态注册，这里可以直接上脚本找出这个 so 注册的函数</b>」——' +
          '这句话正好对应本章 20.6 节那个决策演练的正确答案：<span class="hit">导出表为空 + dex 里有 native 声明，' +
          '这两条合起来就是在说"动态注册"。</span></p>',
        points: [
          '抓包确定接口里的关键参数：<code>sp</code>（长串）与 <code>sig</code>（<code>V3.0</code> 前缀 + 32 位字符串，作者据此<b>猜测</b>是 MD5）。',
          '定位手段是 hook <code>java.util.HashMap.put</code>，把 key/value 连同堆栈打出来——<b>这是"从数据形态反推调用点"的标准做法</b>，不依赖类名。',
          '顺栈找到 <code>net.bosszhipin.base.m</code> 里的 <code>sp</code> 与 <code>sig</code>，再跟进到 <code>com.twl.signer.YZWG.signature(String, String)</code>。',
          '<code>signature</code> 内部转调 <code>nativeSignature</code>——<b>一个 native 方法</b>，同一批里还有 <code>nativeEncodeRequest</code>（对应 sp）以及若干解密方法。',
          '往上找到 so 的加载来源：<code>yzwg</code>，即 <code>libyzwg.so</code>。作者特别指出<b>11.230 版本以前是 32 位 so，这一版换成了 64 位</b>。',
          '在 IDA 的导出表里搜 <code>jni</code> 没有结果 → <b>判定为动态注册</b>。',
          '写 Frida 脚本枚举 <code>libart.so</code> 的导出符号，用三个关键词组合匹配 ART 内部的 RegisterNatives（并<b>排除 CheckJNI 版本</b>），拿到地址后 <code>Interceptor.attach</code>。',
          '在 <code>onEnter</code> 里用 <code>Java.vm.tryGetEnv().getClassName(java_class)</code> 得到类名，<b>过滤出目标类</b>后按 <code>args[3]</code> 的 count 遍历 <code>JNINativeMethod</code> 数组，逐条打印 name / signature / fnPtr。',
          '<b>最终定位结果（帖中给出的偏移）：</b><code>nativeSignature</code>（即 sig 的加密）在 <code>0x21864</code>，<code>nativeEncodeRequest</code>（即 sp 的加密）在 <code>0x209a4</code>。' +
          '<span class="hit">这两个偏移就是本章 20.13 节那张映射表在真实样本上的产物形态——</span>拿到偏移之后，IDA 里按 <code>g</code> 就能直接跳到目标函数。',
          '<b>IDA 里的一个具体障碍：</b><code>.text</code> 段显示为"金色"，说明 IDA 把原本是代码的地方<b>误识别成了数据</b>。帖中的处理是：选中后按 <code>c</code> 转为代码，出现红色段再按 <code>p</code> 创建函数，重复直到关键函数可 F5。' +
          '<span class="muted">（这就是帖子里说的"反调试导致无法直接 F5，需要手动调整让 IDA 重新识别"的具体所指。）</span>',
          '<b>算法结论：</b>sig 最终被确认为<b>标准 MD5</b>（明文拼接 salt 后计算）；sp 则是<b>魔改 Base64</b>——码表被替换为 <code>A-Za-z0-9-_~</code>，且该结果<b>可被 DES 解密</b>。' +
          '<span class="hit">注意这里同时出现了第 8 章的两类魔改：摘要算法是标准的、编码算法换了表。</span>'
        ],
        method: [
          '先抓包，把"要还原什么"锁定在两个具体参数上（sp 与 sig），而不是泛泛地"分析加密"。',
          '不确定参数从哪来，就 hook 数据容器的写操作（<code>HashMap.put</code>）并打印堆栈——<b>用数据流反推代码位置</b>。',
          '顺栈找到 Java 层入口 <code>com.twl.signer.YZWG</code>，确认它转调 native 方法。',
          '定位 so 与架构（<code>libyzwg.so</code>，该版本为 64 位），把 so 拖进对应位数的 IDA。',
          '在导出表搜 <code>jni</code>：无结果 → 判动态注册。',
          '枚举 <code>libart.so</code> 符号定位 ART 内部 RegisterNatives，用关键词组合匹配并排除 CheckJNI。',
          'attach 该地址，在参数里取 <code>env / jclass / methods / count</code>，用类名过滤目标类后遍历打印三元组。'
        ],
        result:
          '<p>作者通过 hook ART 内部的 <code>RegisterNatives</code>，<b>把 <code>libyzwg.so</code> 动态注册的函数映射逐条打印了出来</b>，' +
          '从而在没有导出符号的情况下恢复了"Java 方法 → native 函数地址"的对应关系：' +
          '<code>nativeSignature</code> → <code>0x21864</code>、<code>nativeEncodeRequest</code> → <code>0x209a4</code>。</p>' +
          '<p>沿这条路继续走下去，两个参数的算法都被还原：<b>sig 是标准 MD5（明文拼接 salt）</b>，' +
          '<b>sp 是换过码表的魔改 Base64（<code>A-Za-z0-9-_~</code>），其输出可被 DES 解密</b>。</p>' +
          '<p>作者也交代了环境上的障碍：<b>32 位与 64 位的 so 在 IDA 里都被误判（代码段被识别成数据），无法直接 F5</b>，' +
          '需要手工按 <code>c</code>/<code>p</code> 逐步把数据重新识别为代码，才能得到伪 C。</p>',
        terms: ['JNI 动态注册', 'RegisterNatives', 'JNINativeMethod', 'libart.so 符号枚举', 'Interceptor.attach',
          'Java.vm.getEnv().getClassName', 'HashMap.put hook', 'native 方法', '64 位 so', 'IDA 反调试'],
        limits:
          '<p>作者在帖子里明确交代的边界（<b>照录，不代其下结论</b>）：</p>' +
          '<p>① <b>作者原话：「出于安全考虑，本章未提供完整流程，调试环节省略较多，只提供大致思路，具体细节要你自己还原」</b>——' +
          '所以帖中给出的是脚本片段与偏移，不是可直接复现的完整工程；<br>' +
          '② 抓包内容、敏感网址、数据接口<b>均已做脱敏处理</b>，帖中明确声明仅供学习交流；<br>' +
          '③ 作者提到 32 位与 64 位 so「都有反调试」，<b>但未展开说明反调试的具体形态与绕过细节</b>；' +
          '④ 关于 sig 是 MD5，作者的推导路径是<b>先 hook 中间函数、再在 CyberChef 里复算验证</b>得到确认的——' +
          '帖中特别讨论了"为什么不直接猜拼接后 MD5 就收工"，理由是不懂算法细节就无法应对魔改；<br>' +
          '⑤ <b>作者自己留了一个未解决的坑（照录）：</b>sp 解出的结果"可以被 DES 解密，并且解密出来的 raw 也是不可见的，只能转为 hex 看看"，' +
          '作者明确写「<b>尚不清楚传进去的明文和 DES 解密后的密文有什么联系</b>」——' +
          '<span class="hit">这是一个作者主动标注的未完成项，不是遗漏；本项目不代其补全。</span></p>',
        analysis:
          '<p><b>这个案例的最大价值，是它把本章前面几节的机制串成了一条真实可走的路线。</b>逐条对上：</p>' +
          '<p><b>① 它验证了"导出表为空 → 动态注册"这个判断链（20.6 节决策演练）。</b>' +
          '作者没有因为搜不到 <span class="mono">jni</span> 就转去找别的 so，而是立刻转向 <span class="mono">RegisterNatives</span>——' +
          '这正是本章反复强调的：<b>导不出名字不等于没有入口，注册这个动作绕不过去。</b></p>' +
          '<p><b>② 它用的正是"路线 ②"的工程形态（20.13 节）。</b>注意两个细节：' +
          '它去 <span class="mono">libart.so</span> 里枚举符号、且<b>显式排除了 CheckJNI 版本</b>。' +
          '为什么要排除？因为 Android 同时存在带 CheckJNI 的调试变体——<b>匹配错了地址，你的 hook 会装在一个不会在生产环境被调用的实现上，' +
          '表现为"hook 装上了但零命中"</b>，也就是 20.8 节讲的那个现象。' +
          '<span class="hit">一个看起来不起眼的排除条件，区分了"能跑的脚本"和"看起来能跑的脚本"。</span></p>' +
          '<p><b>③ 它印证了"过滤"比"打印"更重要。</b>作者没有打印全部注册记录，而是先用 ' +
          '<span class="mono">getClassName</span> 把类名取出来、<b>只对目标类 <span class="mono">com.twl.signer.YZWG</span> 打印</b>。' +
          '在大 App 里，动态注册的记录可能成千上万，<b>不过滤的话你拿到的是一堆噪音而不是一张映射表</b>——' +
          '这正是本章实验二训练的那个能力。</p>' +
          '<p><b>④ 它展示了"从数据形态反推调用点"的通用手法。</b>作者不确定 <span class="mono">sp</span> / <span class="mono">sig</span> 从哪来，' +
          '于是 hook 了 <span class="mono">HashMap.put</span>——<b>不猜类名，而是拦截"数据被放进容器"这个动作</b>。' +
          '这个思路和本章 20.10 节"反射 API 藏不住自己"是同一个逻辑：<b>找那个绕不过去的动作。</b></p>' +
          '<p><b>⑤ 关于诚实性，值得单独一提。</b>作者对 sig「猜测是 md5」、对反调试「没有展开」、对代码「不提供完整版本」——' +
          '这些措辞与本章 20.5 节的态度一致：<b>32 位十六进制只是形态像 MD5，不是证明。</b>' +
          '<span class="hit">把"猜测"标成猜测，是技术写作里最容易被省略、也最不该省略的一步。</span></p>',
        link: 'https://bbs.kanxue.com/article-25312.htm',
        linkNote:
          '⚠️ 访问说明：这是看雪的<b>文章视图</b>地址。本文内容已由本站逐段抓取核对（正文完整、' +
          '作者与日期与站内搜索索引一致），但<b>看雪的 article 路由在部分网络环境下会返回 404</b>（本站在校验时就遇到过一次）。' +
          '若打不开，请在<a href="https://bbs.kanxue.com/forum-161-1.htm" target="_blank" rel="noopener">看雪 Android 安全版</a>' +
          '搜索标题「<b>boss app sig参数</b>」（作者 杨如画，2023-12-24）。' +
          '文中所有抓包数据与接口均已由原作者脱敏。' +
          '<br><b>正因为这条链接可能打不开，本章另收了一个地址稳定的案例（见下一个案例）。</b>'
      }
    },

    /* ============================================================ 20.15 实战案例 ② */
    {
      h: '20.15', title: '实战案例②：社区里那套被用了八年的 RegisterNatives 脚本',
      case: {
        source: 'github',
        title: 'lasting-yang/frida_hook_libart —— Frida hook some jni functions',
        date: '2018-05-22',
        author: 'lasting-yang',
        target: 'Frida · Android · ART 的 RegisterNatives 与 JNI 调用追踪 · MIT · JavaScript · 1714 star · 未归档',
        background:
          '<p>上一个案例展示了"某一次真实分析里怎么用这一招"。这个案例补上另一半：' +
          '<b>这一招在社区里早就被沉淀成了一份可以直接拿来跑的脚本</b>。</p>' +
          '<p>仓库描述只有一句「<b>Frida hook some jni functions</b>」，README 也极简——' +
          '但它提供的两个脚本正好覆盖本章 20.13 节的"路线 ②"：<br>' +
          '· <span class="mono">hook_art.js</span>——hook ART 内部的实现；<br>' +
          '· <span class="mono">hook_RegisterNatives.js</span>——<b>专门抓动态注册</b>，' +
          '这正是本章反复强调的那个"绕不过去的动作"。</p>' +
          '<p><b>它值得被单独列出来的原因</b>：它说明本章 20.6、20.13 两节讲的东西' +
          '<b>不是某个人的独门技巧，而是这个领域的公共基础设施</b>。' +
          '<span class="hit">你要做的不是"发明"这套方法，而是理解它为什么成立——这样当它失效时，你才知道该往哪里改。</span></p>',
        points: [
          '仓库自述定位：<code>Frida hook some jni functions</code>（一句话，没有任何营销措辞）。',
          '<b>两个脚本各管一件事</b>：<code>hook_art.js</code> 与 <code>hook_RegisterNatives.js</code>，各自一行命令即可跑。',
          'README 给出的用法是 Frida 的标准姿势：<code>frida -U --no-pause -f &lt;包名&gt; -l &lt;脚本&gt;</code>——' +
          '<b>用 <code>-f</code>（spawn）而不是 attach</b>，这与本章 20.6 节讲的"抢在注册之前就位"完全一致。',
          '<b>输出格式就是本章 20.13 节那张映射表的形态</b>：每条记录含 <code>method_count</code>、' +
          '<code>java_class</code>、<code>name</code>、<code>sig</code>、<code>fnPtr</code>，' +
          '并且<b>额外算了 <code>module_name</code> / <code>module_base</code> / <code>offset</code></b>' +
          '——这一步是实战里最有价值的加工（见下面 analysis）。',
          'README 用的示例是 React Native 的 JNI 注册（<code>libreactnativejni.so</code> 的 ' +
          '<code>initHybrid</code> / <code>initializeBridge</code>）——' +
          '<b>这说明它不止对加固样本有用，对任何大规模用 JNI 的框架都有效</b>。',
          '地址稳定性备注：仓库 README 在 <code>master</code> 分支（<code>main</code> 返回 404）——' +
          '<b>这类老仓库的分支名本身就是一个坑</b>，很多自动化脚本按 <code>main</code> 去取会失败。'
        ],
        method: [
          '选定观测层：不在 JNIEnv 转发表项上下手，而是<b>直接 hook ART 内部的 RegisterNatives 实现</b>（本章 20.13 节的"路线 ②"）。',
          '用 spawn 模式启动目标（<code>-f</code>），保证钩子装在目标注册动作<b>之前</b>。',
          '在 <code>onEnter</code> 里读三个参数：<code>env</code>、<code>jclass</code>、<code>JNINativeMethod*</code>、<code>count</code>。',
          '按 count 遍历数组，每项三个字段：<code>name</code> / <code>signature</code> / <code>fnPtr</code>。',
          '<b>再加一步加工</b>：由 <code>fnPtr</code> 反查所属模块与偏移（<code>Process.findModuleByAddress</code>），' +
          '把"一个裸地址"变成"某个 so + 某个偏移"——<b>这一步直接决定你下一步能不能在 IDA 里跳过去</b>。',
          '按需过滤：只在目标类上打印（本章实验二训练的就是这个筛选能力）。'
        ],
        result:
          '<p>仓库提供了两个可直接运行的 Frida 脚本（<code>hook_art.js</code>、<code>hook_RegisterNatives.js</code>），' +
          'README 给出了标准用法与真实输出样例。输出样例的字段形态是：</p>' +
          '<p><code>[RegisterNatives] method_count: 0xe</code> → ' +
          '<code>java_class: com.facebook.react.bridge.CatalystInstanceImpl</code> → ' +
          '<code>name: initializeBridge</code> → <code>sig: (...)V</code> → ' +
          '<code>fnPtr: 0x9c9e2401</code> → <code>module_name: libreactnativejni.so</code> → ' +
          '<code>module_base: 0x9c991000</code> → <code>offset: 0x50c65</code>。</p>' +
          '<p>仓库信息（截至本次核实）：<b>MIT 许可、JavaScript、1714 star、未归档</b>，' +
          '创建于 2018-05-22，最近一次推送 2025-10-22——<b>一份被维护了七年的小脚本</b>。</p>',
        terms: ['RegisterNatives', 'JNI_OnLoad', 'libart.so 符号枚举', 'Interceptor.attach',
          'JNINativeMethod', 'Process.findModuleByAddress', '模块偏移', 'spawn 模式', 'React Native JNI'],
        limits:
          '<p>这个仓库的 README 极简，因此它的"局限"更多要从它的形态读出来（<b>以下为本站判断，不是作者自述</b>）：</p>' +
          '<p>① <b>README 没有版本兼容性说明</b>——hook 的是 ART 内部实现，而<b>符号名与内部结构随 Android 版本变化</b>' +
          '（本章 20.13 节已提醒过这一点）。<span class="hit">所以"脚本能跑"这件事是版本相关的，作者没有承诺覆盖面。</span><br>' +
          '② <b>没有说明对反 Hook 检测的应对</b>——它 hook 的是 ART 内部函数，' +
          '同样会留下可被检测的痕迹（本章 20.6 节列过加固方的三种反制）。<br>' +
          '③ <b>README 未提到影子函数表的情况</b>——如果壳伪造了 JNIEnv 表、或绕过 RegisterNatives 直接改 <code>ArtMethod</code>，' +
          '这类脚本会零命中（第 13 章讨论过这类对抗）。<br>' +
          '④ <b>仓库最近推送是 2025-10</b>，在快速变化的 Android 生态里属于"仍被维护但更新不频繁"，' +
          '<b>遇到新版本问题时请先看 issue 与提交记录</b>。</p>',
        analysis:
          '<p><b>这个案例与上一个案例正好构成一对：一个是"某次真实分析"，一个是"被沉淀下来的公共工具"。</b>' +
          '把它们放在一起看，比单看任何一个都更有价值。</p>' +
          '<p><b>① 它印证了本章 20.13 节"路线 ②"的工程形态。</b>' +
          '本章说"不要 hook JNIEnv 表里的转发表项，而要去 <code>libart.so</code> 里找 ART 内部的实现"——' +
          '这个仓库做的事完全一样。<span class="hit">当一个方法在社区里被反复实现成工具时，' +
          '说明它抓住的不是某个样本的特性，而是<b>机制本身的一个稳定性质</b>。</span></p>' +
          '<p><b>② 它顺手解决了本章实验二留下的最后一公里。</b>' +
          '实验二让你从一份 dump 里排优先级，拿到的是 <code>method</code> / <code>sig</code> / <code>fnPtr</code>。' +
          '但一个裸地址在 IDA 里没法用——<b>而这份脚本的输出里有 <code>module_name</code> 与 <code>offset</code></b>。' +
          '于是"下一步在 IDA 里按 <code>g</code> 跳过去"就成立了（上一个案例里作者拿到的 <code>0x21864</code> 就是这个东西）。' +
          '<b>这一步加工看起来只是多打两个字段，实际是把"观测结果"变成了"可执行线索"。</b></p>' +
          '<p><b>③ 它用的示例（React Native）提示了一个更广的适用范围。</b>' +
          '本章讲动态注册时的语境都是"加固壳在藏入口"。但看它打印的是 ' +
          '<code>libreactnativejni.so</code>、<code>libreactnativejsi</code>——' +
          '<span class="hit">这说明<b>动态注册不只属于加固，它是所有大规模 JNI 项目的常规做法</b>。' +
          '所以这套观测手段的适用面，比"对付加固"要宽得多。</span></p>' +
          '<p><b>④ 关于它的局限，最该记住的一条是"沉默"。</b>' +
          'README 没有写兼容性矩阵、没有写对抗注意事项——这不是作者的疏忽，而是' +
          '<b>这类小工具的共同形态</b>：它解决一个具体问题，其余交给你判断。<br>' +
          '<span class="hit">而"作者没说的部分"恰恰是你必须自己补的：<b>它在你的目标上跑不通时，' +
          '你要能从本章 20.13 节的三条路线里选出下一条，而不是去改脚本碰运气。</b></span></p>' +
          '<p><b>⑤ 最后，它和上一个案例一起说明了本章那句心法为什么成立：</b>' +
          '<b>壳藏得住名字，藏不住"注册"这个动作。</b>正因为它藏不住，八年前有人写了这个脚本，' +
          '八年后它还在被用。<span class="hit">工具会过期，那个"必须发生的动作"不会。</span></p>',
        link: 'https://github.com/lasting-yang/frida_hook_libart',
        linkNote: 'GitHub 公开仓库（MIT）。本次核实：API 元数据 200；README 在 <b>master 分支</b>（main 返回 404），' +
                  'raw README 200 / 7637 字节，正文完整可读。README 里的输出样例与用法均照抄自原文。'
      }
    }
  ],

  glossary: [
    { t: 'JNI', d: 'Java Native Interface。Java 与 native 代码互相调用的接口规范。它规定的是"怎么调"和"怎么找对方"，不是某个具体库。' },
    { t: 'JNIEnv', d: '指向"只有一个成员的结构体"的指针，结构体里装着指向 JNI 函数指针数组的指针，因此本质是二级指针。真机上槽位指向 ART 实现，模拟环境中可整体替换为自己的桩——这是 unidbg 一类工具能成立的理论基础。' },
    { t: 'JavaVM', d: '另一张函数表（GetEnv、AttachCurrentThread、DetachCurrentThread 等）。它是 JNI_OnLoad 的第一个参数，所以想在模拟环境里调 JNI_OnLoad，必须先伪造它。' },
    { t: '描述符（descriptor）', d: 'JNI 表达 Java 类型的紧凑字符串。基本类型单字母（void=V boolean=Z byte=B char=C short=S int=I long=J float=F double=D），对象类型 L全限定名;，数组前置 [。方法签名为 (参数)返回值。泛型在编译后被擦除，描述符里不存在泛型信息。' },
    { t: '静态注册', d: '靠命名约定绑定：虚拟机把 Java 方法名按 JNI Name Mangling 规则改写（. → _，_ → _1，; → _2，[ → _3），去 so 的导出表里找同名函数。逆向成本极低，但会在导出表里留下语义化的函数名。' },
    { t: '动态注册', d: '在运行时调用 RegisterNatives，把一张 JNINativeMethod 数组（name / signature / fnPtr）交给虚拟机完成绑定。不在导出表里留下任何 Java_ 符号，是加固方案的默认选择。' },
    { t: 'JNI_OnLoad', d: 'so 被加载后由虚拟机主动调用的初始化入口。返回 JNI 版本号（返回 0 或负数视为加载失败）。动态注册通常在这里完成。它的执行时机晚于 ELF 构造函数（.init_array）。' },
    { t: 'JNINativeMethod', d: '动态注册的三元组结构：name（Java 方法名，不是符号名）、signature（JNI 描述符）、fnPtr（实际函数地址）。这三个字段同时存在的那一刻，就是映射关系最完整的时刻。' },
    { t: '局部引用', d: '在 native 函数执行期间有效的 JNI 引用，函数返回时自动释放。在大循环里创建而不释放会导致引用表溢出并使进程终止，是 JNI 最常见的崩溃原因之一。' },
    { t: '全局引用', d: '必须显式 DeleteGlobalRef 才会释放的 JNI 引用，可跨线程与跨调用使用。加固壳常用来缓存关键对象，因此内存中长期存活的 JNI 引用值得关注。' },
    { t: '弱全局引用', d: '不阻止对象被回收的 JNI 引用。使用前必须确认对象是否仍然存活，否则会拿到一个已经失效的引用。' },
    { t: 'pending 异常', d: 'JNI 中尚未被处理的异常状态。存在 pending 异常时，大多数 JNI 函数会失败或行为未定义，因此 native 代码应在调用后检查并清除或重新抛出。' },
    { t: 'AttachCurrentThread', d: 'JavaVM 的接口。在 native 自建的线程里使用 JNI 前必须先附着到虚拟机并获得属于该线程的 JNIEnv；退出前应 DetachCurrentThread。JNIEnv 不能跨线程使用。' },
    { t: 'Name Mangling', d: 'JNI 规范的类名与符号名转换规则。顺序很关键：必须先转义原有下划线（_ → _1），再做点转下划线（. → _），否则两种下划线将无法区分。重载方法使用长名（两个下划线加参数描述符）。' },
    { t: '影子函数表', d: '加固方案伪造的一张结构合法的 JNIEnv 函数表。它使得针对"系统那张表"的 hook 全部落空，且不产生任何错误——是 JNI 对抗中典型的静默失败来源。' },
    { t: 'Native 化', d: '把原本写在 Java 层的逻辑（典型如 Activity.onCreate）改为 native 方法，使 dex 里只剩声明而没有方法体。它属于"让代码不在这里"，与"让代码看不懂"的混淆是两类不同的对抗手段。' }
  ],

  teacher: {
    id: 't20', chapter: 20,
    name: 'JNI 老法师',
    sub: '你写的每一行 JNI，都是在给自己下次逆向留线索',
    intro:
      '<p>我教这章的方式和别人不太一样。<b>我不问你"JNI 有几个接口"，那种问题查文档就有。</b></p>' +
      '<p>我问你的是：<b>当你在加固样本前面卡住的时候，你能不能说出自己在等什么、以及为什么等得到。</b>' +
      '答不出来，说明你只是在背脚本，不是在理解机制。</p>' +
      '<p>准备好了就开始。答不上来可以要提示——但提示不算过关。</p>',
    questions: [
      {
        id: 'c20q1', depth: 1, threshold: 0.7,
        q: '用你自己的话说清楚：<b>动态注册和静态注册，机制上的根本区别是什么？</b>' +
          '以及为什么加固方几乎一定选动态注册？',
        concepts: [
          { label: '静态注册靠命名约定：虚拟机按 JNI 规则改写方法名，去导出表里找同名函数',
            hint: '静态注册是怎么"找"到函数的？靠什么？',
            any: ['命名', '名字', '符号', '导出表', 'name mangling', '改名', '约定', 'Java_', '符号名', '导出符号', '拼名字'] },
          { label: '动态注册靠运行时显式动作：调用 RegisterNatives 把 name/signature/fnPtr 三元组表交给虚拟机',
            hint: '动态注册是把什么交给虚拟机？',
            any: ['registerNatives', '注册', '运行时', '三元组', 'jninativemethod', '映射表', '表', '显式', '方法名和地址'] },
          { label: '根本区别在于"信息存在哪里"：一个存在 so 的导出表里，一个只在运行时存在',
            hint: '从"信息在什么时间、什么位置可见"这个角度想。',
            any: ['存在哪', '位置', '导出表', '运行时', '静态', '可见', '信息', '时机', '生命周期', '不存在于', '磁盘'] },
          { label: '加固方选动态注册是为了不在导出表里留下语义化的业务函数名',
            hint: '想想导出表是给谁看的。',
            any: ['导出表', '暴露', '隐藏', '名字', '语义', '看得见', '公开', '泄漏', '泄漏', '业务', 'sign', 'encrypt', '反分析', '增加难度'] },
          { label: '代价是动态注册必须留下 RegisterNatives 这个可观测的动作，因此并非绝对安全',
            hint: '这一招有没有代价？代价在哪？',
            any: ['registerNatives', '可观测', '必须调用', '绕不过', '仍然', 'hooks', 'hook', '唯一入口', '留下痕迹', '未必安全', '破绽'] }
        ],
        hints: [
          '两种注册，虚拟机分别"从哪里"获取"Java 方法对应哪个函数"这个信息？',
          'so 的导出表是公开可见的。想想一个语义明确的函数名出现在那里意味着什么。'
        ],
        probes: [
          '追问：既然动态注册也要调用一个固定名字的接口，那它到底"藏"住了什么、没藏住什么？',
          '再追问：如果加固方说"我就是不用动态注册，但我把静态注册的函数名全部改成了单字母"，这样安全吗？为什么？'
        ],
        model: '<b>一、机制上的根本区别：信息存在哪里</b><br><br>' +
          '<b>静态注册</b>：没有任何显式的注册动作。虚拟机拿到一个 <span class="mono">native</span> 方法后，' +
          '按 JNI 规范的 Name Mangling 规则<b>把类名和方法名拼成一个符号名</b>（<span class="mono">.</span> → <span class="mono">_</span>，' +
          '<span class="mono">_</span> → <span class="mono">_1</span>，以此类推），然后去 so 的<b>导出表</b>里找这个名字。<br>' +
          '→ 关键在于：<b>映射关系完全由名字隐含，它静态地存在于 so 文件里。</b><br><br>' +
          '<b>动态注册</b>：代码在运行时调用 <span class="mono">RegisterNatives(clazz, methods, n)</span>，' +
          '把一张 <span class="mono">JNINativeMethod</span> 数组交过去。数组每项是三元组：' +
          '<b>name（Java 方法名）、signature（JNI 描述符）、fnPtr（函数地址）</b>。<br>' +
          '→ 关键在于：<b>映射关系只在运行时存在，磁盘上找不到它。</b><br><br>' +
          '<b>二、为什么加固方几乎一定选动态注册</b><br><br>' +
          '导出表是 so 的"公开目录"，<b>任何人都能读，而且读起来零成本</b>。用静态注册意味着把' +
          '<span class="mono">Java_com_example_Crypto_sign</span>、<span class="mono">..._check</span>、' +
          '<span class="mono">..._verifySignature</span> 这样的名字<b>整整齐齐地列出来</b>。' +
          '逆向者只要扫一遍导出表，就相当于拿到了一份<b>带注释的功能清单</b>——哪还需要什么分析？<br><br>' +
          '动态注册之后，导出表里一个业务名字都不剩。而且它还能做得更彻底：<br>' +
          '· 方法名<b>临时解密或拼接</b>得到（静态搜字符串也零命中）；<br>' +
          '· 函数地址<b>运行时计算</b>（不指向具名的导出函数）；<br>' +
          '· 表可以<b>分次注册、动态更换</b>。<br><br>' +
          '<b>三、但这一招有代价——这个代价就是逆向者的入口</b><br><br>' +
          '<span class="hit">动态注册必须调用 <span class="mono">RegisterNatives</span>，而这个接口是虚拟机提供的、名字固定的、绕不过去的。</span>' +
          '不管它怎么混淆，这个动作一定会发生。<br><br>' +
          '所以在<b>注册发生的那一瞬间</b>，类、方法名、签名、函数地址四者同时在手上——' +
          '这比静态注册给你的信息<b>还要完整</b>（静态注册你只能从符号名反推，动态注册直接给你描述符）。<br><br>' +
          '<b>这就是本章的核心判断：</b>加固方藏住了"静态可见性"，却创造了一个"运行时必经点"。' +
          '你要做的不是跟它比谁藏得好，而是<b>守住那个它必须经过的路口。</b>',
        after:
          '<p><b>补一句你可能没想到的：</b>动态注册还有一个隐藏好处——它<b>允许方法名和函数名完全脱钩</b>。' +
          '同一个 native 函数可以注册给多个 Java 方法，也可以中途换掉。' +
          '所以你在映射表里看到的"一个地址对应多个方法"，是正常现象，不是你的脚本读错了。</p>'
      },
      {
        id: 'c20q2', depth: 1, threshold: 0.7,
        q: '为什么说 <span class="mono">JNIEnv*</span> 是"可以被整体替换的函数表"？' +
          '<b>这个性质同时被哪三方利用？</b>',
        concepts: [
          { label: 'JNIEnv* 是二级指针：指向一个只有一个成员的结构体，成员是指向函数指针数组的指针',
            hint: '它的内存结构是什么样的？',
            any: ['二级指针', '两次解引用', '结构体', '函数指针数组', '函数表', '指针的指针', '只有一个成员', '解引用'] },
          { label: '槽位位置由 JNI 规范写死，因此调用不依赖符号名，谁来实现由环境决定',
            hint: '为什么 native 代码不关心"谁接电话"？',
            any: ['固定', '规范', '槽位', '下标', '位置', '不需要符号', '不关心', '实现可换', '编译后', '偏移'] },
          { label: '虚拟机用它接入真实实现（ART）',
            hint: '第一方是谁？',
            any: ['art', '虚拟机', '真机', '系统', '真实实现', '真实现', '安卓', 'vm'] },
          { label: '模拟执行工具用它把桩函数接进来，于是 JNI 调用被降维成普通函数调用',
            hint: '第二方是逆向工具。',
            any: ['unidbg', 'unicorn', '模拟', '桩', 'stub', '补环境', '降维', '假', '伪造', '模拟器'] },
          { label: '加固壳用它接入影子表，使针对系统表的 hook 全部落空且不报错',
            hint: '第三方是攻防的另一端。',
            any: ['加固', '壳', '影子表', '伪造', '欺骗', 'hook 落空', '零命中', '静默', '骗', '检测', 'shadows'] }
        ],
        hints: [
          '先描述结构：从 JNIEnv* 出发，解引用两次分别拿到什么？',
          '既然"位置固定、实现可换"，那么能换实现的就不止虚拟机一家。想想还有谁想换。'
        ],
        probes: [
          '追问：如果槽位位置不固定（比如随版本变化），JNI 会有哪些设计上的后果？',
          '再追问：你怎么在运行时判断"我 hook 的是不是它实际用的那张表"？'
        ],
        model: '<b>一、结构决定性质</b><br><br>' +
          '<span class="mono">JNIEnv*</span> 不是结构体，是<b>指向结构体的指针</b>，而这个结构体<b>只有一个成员</b>：' +
          '一个指向函数指针数组的指针。所以它是二级指针。<br>' +
          'C 里写 <span class="mono">(*env)-&gt;FindClass(env, ...)</span>：' +
          '第一次解引用拿到结构体，第二次从数组里按固定下标取出函数指针。' +
          'C++ 里包装成类成员，写法变好看，本质不变。<br><br>' +
          '<b>关键是"下标固定"。</b>哪个槽位对应哪个 JNI 函数，由 JNI 规范写死，' +
          '与 Android 版本、CPU 架构无关。这带来一个直接结果：' +
          '<b>native 代码编译之后不再需要符号名</b>——它按固定偏移取指针然后调用，' +
          '<span class="hit">接电话的究竟是谁，它既不检测也不关心。</span><br><br>' +
          '而这个"不关心"，正是"可替换"能够成立的前提。<br><br>' +
          '<b>二、三方各取所需</b><br><br>' +
          '<b>① 虚拟机（ART）</b>：把真实现填进每个槽位。' +
          '<span class="mono">FindClass</span> 去 dex 里查类，<span class="mono">GetMethodID</span> 解析签名，' +
          '<span class="mono">CallObjectMethod</span> 真进解释器执行 Java 代码。这是"正常"用法。<br><br>' +
          '<b>② 模拟执行工具（unidbg / Unicorn 一类）</b>：造一张结构相同的表，每个槽位指向自己写的桩函数。' +
          '于是 JNI 调用被<b>降维成普通函数调用</b>——这解释了为什么第 7 章说"JNIEnv 可整体替换是模拟执行能成立的理论基础"。' +
          '它不需要真的有一个 Java 虚拟机，只需要一张表。<br><br>' +
          '<b>③ 加固壳</b>：构造一张<b>影子函数表</b>，结构完全合法，但内容是自己的。' +
          '后果非常隐蔽：你 hook 了"系统那张表"的 <span class="mono">RegisterNatives</span> 槽位，' +
          '而目标代码用的是它自己那张——<b>你的 hook 零命中，且没有任何报错</b>。<br>' +
          '<span class="hit">这是 JNI 对抗里最典型的静默失败：不是"失败了"，而是"你以为成功了"。</span><br><br>' +
          '<b>三、同一个设计，三种用法</b><br><br>' +
          '把这三方放在一起看，你会发现<b>它们用的是同一个机制，只是替换的方向不同</b>：' +
          '虚拟机替换成真实现、工具替换成桩、壳替换成影子表。<br>' +
          '所以"JNIEnv 可替换"这句话是中性的——它既是你做模拟执行的工具，也是对手骗你的工具。<br><br>' +
          '<b>实战上的推论：</b>当你 hook 一个 JNI 函数却零命中时，' +
          '第一顺位要怀疑的不是"我写错了"，而是<b>"我改的表和它用的表是不是同一张"</b>。' +
          '验证方法也很直接：在 hook 里把<b>表本身的地址</b>打印出来，看它是否稳定、是否与你预期一致。',
        after:
          '<p><b>顺着再想一层：</b>既然影子表这么有效，为什么不是所有壳都用它？<br>' +
          '因为<b>伪造一张完整的 JNI 函数表成本不低</b>——表里有几百个槽位，' +
          '你得保证所有被真实用到的槽位都能正确工作，否则 App 会在某个奇怪的地方崩掉。' +
          '所以现实中更常见的是<b>局部篡改</b>（只换掉几个关键槽位）而不是整表伪造。' +
          '<span class="hit">这也意味着：你的 hook 可能是"有时候命中、有时候不命中"——这种间歇性现象，' +
          '往往就是局部篡改或分次注册的指征。</span></p>'
      },
      {
        id: 'c20q3', depth: 2, threshold: 0.7,
        q: '你的 Frida 脚本报告 "hook installed"（地址解析成功、日志已打印），' +
          '但目标函数<b>一次都没有被调用</b>，而 App 确实做了环境检测。' +
          '<b>请给出至少三种可能的原因，并说明每一种该怎么验证。</b>',
        concepts: [
          { label: '时机不对：检测发生在你 attach 之前（.init_array / JNI_OnLoad 阶段）',
            hint: '想想 so 加载之后、你 attach 之前，有什么代码会跑。',
            any: ['时机', '太早', '更早', 'attach 之前', 'init_array', 'jni_onload', '加载阶段', '初始化', 'spawn', '抢先', '时间差'] },
          { label: '线程不对：检测跑在 native 自建线程里，你只 hook 了主线程路径',
            hint: '加固的心跳、上报、检测常常跑在哪？',
            any: ['线程', '子线程', 'native 线程', 'pthread', '其他线程', 'attachCurrentThread', '非主线程', '线程id'] },
          { label: '位置不对：你 hook 的函数不是真正执行的那个（被内联 / 走了别的实现）',
            hint: '你 hook 的地址，和它实际执行的代码，一定是同一段吗？',
            any: ['位置', '不是这个函数', '内联', 'inline', '另一个实现', '地址不对', '搞错了', '别的函数', '副本', '拷贝'] },
          { label: '映射被隐藏：注册在你的观测点之外发生（更早/分次/绕过 RegisterNatives）',
            hint: '如果它根本没走你以为的那条注册路径呢？',
            any: ['分次', '延迟注册', '绕过', '没走', '另一个', '影子', 'artmethod', '直接改入口', '更早', 'unregister'] },
          { label: '验证方法必须落到"加观测点"：打线程 id、打调用栈、把 hook 提前到 dlopen、加计数器',
            hint: '不要猜，怎么用实验分辨这几种原因？',
            any: ['打印', '线程id', '调用栈', '堆栈', 'stack', '计数', '计数器', 'dlopen', 'spawn', '提前', '观测', '日志', 'trace', 'stalker'] }
        ],
        hints: [
          '"hook 装上了"和"没被调用"这两条信息合起来，能排除掉什么、又指向什么？',
          '一段代码"没有执行"，可能是它不存在、可能是它执行过了、也可能是它在别处执行。分别怎么验证？'
        ],
        probes: [
          '追问：如果加完观测点之后发现，检测确实跑在另一个线程上，你的下一步是什么？',
          '再追问：如果它是在 so 加载阶段跑的，而你的目标是"必须看到它做了什么"，你有哪些手段能提前到那个阶段？'
        ],
        model: '<b>先把现象读对：</b>"hook 装上了"说明<b>地址解析成功、注入成功，不是工具问题</b>；' +
          '"从未命中"说明<b>这段代码在你观测期间没有执行</b>。<br>' +
          '合起来，"为什么没执行"只有三种可能：<b>时机不对、线程不对、位置不对</b>。' +
          '（还有第四种"映射被隐藏"，它其实是"位置不对"的一种特殊形态。）<br><br>' +
          '<b>① 时机不对——最常见</b><br>' +
          '检测发生在 <span class="mono">.init_array</span> 或 <span class="mono">JNI_OnLoad</span> 里，' +
          '<b>在你 attach 之前就跑完了</b>。<br>' +
          '<span class="hit">这就是 20.4 / 20.6 两节强调时序的原因：ELF 构造函数在 dlopen 时就执行，' +
          '根本不需要等 Java 调用任何一个 native 方法。</span><br>' +
          '<b>验证：</b>把你的 hook 也提前——改 <span class="mono">spawn</span> 模式启动（在 App 主线程跑起来前注入），' +
          '或者直接 hook <span class="mono">dlopen</span> / <span class="mono">android_dlopen_ext</span>，' +
          '在模块<b>刚被映射、还没执行任何代码</b>时就把钩子装好。<br>' +
          '<b>判据：</b>如果提前之后命中了，就是时机问题——结论明确。<br><br>' +
          '<b>② 线程不对</b><br>' +
          '检测跑在 native 自建的线程里（心跳、上报、完整性校验都爱这么干）。' +
          '这也正是 20.8 节讲 <span class="mono">AttachCurrentThread</span> 的实战意义：' +
          'native 线程要调 Java 必须先附着，<b>而这个"附着"本身就是它存在的证据</b>。<br>' +
          '<b>验证：</b>在你的 hook 里<b>打印当前线程 id</b>；或对所有线程布点；' +
          '或用 Stalker 做全线程跟踪。<b>同时观察 <span class="mono">AttachCurrentThread</span> 有没有被调用</b>——' +
          '这是一个很灵的旁证。<br><br>' +
          '<b>③ 位置不对</b><br>' +
          '你 hook 的函数不是实际执行的那个。可能是：编译器把检测<b>内联</b>展开了；' +
          '可能是存在<b>多份实现</b>（不同 ABI、不同版本分支）；' +
          '也可能是它走的<b>根本不是这个函数</b>（比如名字看起来像，其实只是同名工具函数）。<br>' +
          '<b>验证：</b>把 attach 的<b>模块名 + 模块基址 + 偏移</b>全部打印出来，' +
          '确认解析到的地址落在你预期的模块里、且这个地址确实对应你看到的符号。' +
          '再用 <span class="mono">Memory.readByteArray</span> 读一下函数头几个字节——<b>如果不是正常的函数序言，说明这里根本不是函数入口</b>。<br><br>' +
          '<b>④ 映射被隐藏</b><br>' +
          '你对"检测在哪个函数里"的认知来自映射表（比如 hook 到的 RegisterNatives），' +
          '但它可能<b>分次注册</b>（你只抓到了第一批）、' +
          '<b>UnregisterNatives 后重新注册</b>（地址换了），' +
          '或者<b>绕过 RegisterNatives 直接改 ArtMethod 入口</b>（你那张表根本没包含它）。<br>' +
          '<b>验证：</b>在<App 运行一段时间后>重新枚举一次映射表，与初始快照对比；' +
          '或者在内存里搜索 <span class="mono">JNINativeMethod</span> 形态的数据结构。<br>' +
          '<span class="pill warn">绕过 RegisterNatives 的绑定属于更深一层的对抗，第 13 章给了"只读观测 + 硬件断点"的路线</span><br><br>' +
          '<b>统一的方法论：先加观测点，再猜原因。</b><br>' +
          '在 hook 里加<b>计数器</b>、打<b>线程 id</b>、打<b>调用栈</b>、同时 hook <span class="mono">dlopen</span>——' +
          '这些加起来不到十分钟，却能把上面四种原因一次性区分开。<br>' +
          '<span class="hit">"装上了但零命中"和 20.2 节的"影子表"、20.6 节的"极早期注册"是同一类问题的不同表现——' +
          '<b>它们都指向同一件事：你的观测点不在它的执行路径上。</b></span>'
      },
      {
        id: 'c20q4', depth: 2, threshold: 0.7,
        q: '加固壳把 <span class="mono">Activity.onCreate</span> 改成了 native 方法，' +
          'dex 反编译只能看到一行声明。有人说"这个 App 的分析到此为止了"。' +
          '<b>请反驳这个说法，并说明业务逻辑到底去哪了、你打算怎么把它接回来。</b>',
        concepts: [
          { label: 'Native 化不是"逻辑消失"，只是"逻辑换了存放位置"——它从 dex 搬到了 so 里',
            hint: '逻辑是被删掉了，还是被搬走了？',
            any: ['搬', '位置', '换地方', 'so', '还在', '没有消失', '不在 dex', '移动', '转移'] },
          { label: '壳并不想重写业务，真正的业务方法通常还留在 dex 里，只是通过反射/JNI 回调被调用',
            hint: '壳的目的是保护，不是重做 App。那业务代码去哪了？',
            any: ['反射', '回调', '还在 dex', '原逻辑', '调用', 'jni', 'CallObjectMethod', 'getMethodID', 'invoke', '复用'] },
          { label: '反射 API 的名字是固定的、藏不住，因此在 Java 层布反射观测点就能让被调用的方法名暴露',
            hint: '有一类 API，加固方改不了它的名字。',
            any: ['反射', 'forName', 'invoke', 'getDeclaredMethod', 'getMethod', '观测', 'hook', 'java 层', '名字', '藏不住'] },
          { label: 'native 调用 Java 必须经由 JNI 接口（GetMethodID / CallObjectMethod），这些也是可观测的',
            hint: 'native 想调 Java，走的是哪套接口？',
            any: ['getmethodid', 'callobjectmethod', 'jni', '接口', 'jnienv', '函数表', '可观测', 'hook'] },
          { label: '还可以观测"数据通道"：hook 数据容器写入、加密 API、网络发送，从数据流反推调用点',
            hint: '除了盯调用，还能盯什么？',
            any: ['数据', 'hashmap', '容器', 'put', '加密', 'messagedigest', 'cipher', '网络', '发送', '数据流', '堆栈', '调用栈'] },
          { label: '结论：入口被搬走不等于链路断开，它只是隔了一层，而那一层有固定接口',
            hint: '把结论说成一句可复用的话。',
            any: ['隔一层', '链路', '没断', '接回来', '接口', '固定', '必经', '不彻底', '可以观测'] }
        ],
        hints: [
          '壳的目的是"保护业务"，还是"重写业务"？这个区别决定了业务代码还在不在。',
          '有一层是加固方无论如何都改不掉名字的——native 要和 Java 通信，必须走什么？'
        ],
        probes: [
          '追问：如果连业务方法的调用都是通过一个"通用转发函数"完成的（所有方法都走同一个入口），你的反射观测还能得到什么信息？',
          '再追问：假设你通过反射观测拿到了被调用的方法名和参数，但方法体在 dex 里是空壳——这说明什么？'
        ],
        model: '<b>一、先纠正那个错误的前提</b><br><br>' +
          '"分析到此为止"这个结论，隐含了一个假设：<b>dex 里没有的东西，就是不存在的东西。</b>' +
          '这个假设是错的。<br><br>' +
          'Native 化的准确描述是：<b>把代码从"dex 里的方法体"搬到了"so 里的机器码"</b>。' +
          '它改变的是<b>存放位置</b>，不是<b>存在性</b>。<br>' +
          '<span class="hit">用第 20.11 节的说法：混淆是"让代码看不懂"，Native 化是"让代码不在这里"。' +
          '两者的应对方式完全不同——前者要读，后者要先找到。</span><br><br>' +
          '<b>二、业务逻辑到底去哪了</b><br><br>' +
          '<b>关键判断：壳的目标是保护 App，不是重写 App。</b>' +
          '加固方没有动机、也没有能力把整个业务逻辑用 C 重写一遍（成本无法承受，而且会引入大量 bug）。' +
          '所以绝大多数情况下：<b>业务方法仍然以 Java 代码的形式留在 dex 里</b>，' +
          '只是<b>调用它的入口被搬到了 native</b>。<br><br>' +
          '典型结构（20.11 节的动画画的就是这个）：<br>' +
          '<span class="mono">系统调用 onCreate → native onCreate → 检测/解密/注册/校验 → 反射回调真正的业务方法</span><br><br>' +
          '所以答案是：<b>业务逻辑没消失，它只是被隔了一层。</b><br><br>' +
          '<b>三、怎么把它接回来</b><br><br>' +
          '<b>① 在反射 API 上布点（最有效）。</b>' +
          'native 要回调 Java，绕不过反射或 JNI 接口。<br>' +
          '· Java 侧的 <span class="mono">Class.forName</span> / <span class="mono">getDeclaredMethod</span> / ' +
          '<span class="mono">Method.invoke</span>；<br>' +
          '· JNI 侧的 <span class="mono">GetMethodID</span> / <span class="mono">CallObjectMethod</span>（20.9 节）。<br>' +
          '<b>这些名字加固方改不了</b>——它们是系统 API。<br>' +
          '<span class="hit">所以被藏起来的业务方法名，会在这里以明文现身。这就是 20.10 节那句"反射藏不住自己"。</span><br><br>' +
          '<b>② 观测数据通道（不依赖调用关系）。</b>' +
          '如果调用被做了通用转发（所有方法走同一个入口），方法名可能拿不到，但<b>数据还是要流动的</b>：<br>' +
          '· hook 数据容器写入（本章案例里作者 hook <span class="mono">HashMap.put</span> 就是这么做的）；<br>' +
          '· hook 加密 API（第 24 章的自吐沙箱就是把这套做成产品）；<br>' +
          '· hook 网络发送。<br>' +
          '<b>沿着数据流反推调用栈，同样能定位到业务代码。</b><br><br>' +
          '<b>③ 观测 so 的加载与注册。</b>' +
          'native 逻辑要跑起来，so 必须先加载。<b>hook <span class="mono">dlopen</span> 能拿到完整清单</b>，' +
          'hook <span class="mono">RegisterNatives</span> 能拿到注册映射。' +
          '两件事都很便宜，而且它们发生在<b>所有业务逻辑之前</b>。<br><br>' +
          '<b>四、反过来看这件事</b><br><br>' +
          'Native 化其实<b>同时也暴露了信息</b>：<br>' +
          '· 哪个 Activity 的 onCreate 被 Native 化了 → <b>说明这个入口是加固的重点保护对象</b>；<br>' +
          '· 启动特别慢、崩溃率特别高 → <b>说明 native 初始化做得特别重</b>（20.11 节的"代价即特征"）；<br>' +
          '· 一个本来该有 Java 实现的类却只有 native 声明 → <b>这就是加固的指纹</b>。<br><br>' +
          '<span class="hit">"它把东西藏起来了"这句话本身，就是一条关于"什么东西值得藏"的情报。</span>',
        after:
          '<p><b>如果你的追问答案是"方法名拿到了，但 dex 里方法体是空的"</b>——那说明你遇到的是<b>抽取壳</b>，' +
          '而不是单纯的 Native 化。这两件事经常同时出现，但它们的解法不同：' +
          'Native 化要靠"找入口"，抽取壳要靠"逼回填"（第 2 章、第 12 章）。' +
          '<b>能分辨这两者，你就不会用错工具。</b></p>'
      },
      {
        id: 'c20q5', depth: 3, threshold: 0.72,
        q: '<b>综合题。</b>给你一个从未见过的加固 App，你确认它用了动态注册，' +
          '并且你已经成功 hook 到了 <span class="mono">RegisterNatives</span>。' +
          '<b>请完整说明从"拿到映射表"到"定位到签名算法"的推进顺序</b>，' +
          '并说明每一步为什么排在那个位置——特别是，<b>你不会先做什么。</b>',
        concepts: [
          { label: '第一步是排序而不是逐个分析：按"名字可读度 + 签名形态"筛出优先级',
            hint: '拿到几百条映射记录，第一件事是什么？',
            any: ['排序', '筛选', '优先级', '过滤', '分类', '名字', '签名', '形态', '挑', '重点', '不可能逐条'] },
          { label: '优先 hook 参数含 byte[] 或 String、返回 String 的方法（编码/摘要/签名特征）',
            hint: '哪种签名形态最可疑？',
            any: ['byte', '[b', 'string', '参数', '返回', 'hex', '二进制', '摘要', '签名', '特征', '形态'] },
          { label: '每次命中打印调用栈与线程，用于区分业务调用与自检调用',
            hint: 'hook 到了之后，第一个要加的信息是什么？',
            any: ['调用栈', '堆栈', 'stack', '线程', 'thread', '调用者', '谁调用', '区分', '业务', '自检'] },
          { label: '把观测点同时布在 Java 侧（反射 API、加密 API）做交叉验证',
            hint: '只在 native 一侧观测，有没有盲区？',
            any: ['java 层', '反射', 'forName', 'invoke', 'messagedigest', 'cipher', 'mac', '交叉', '两边', '双向', '同时'] },
          { label: '不要先做的是：不要先逐个读汇编、不要先做暴力输入输出对拍、不要先处理反调试',
            hint: '哪些动作成本高但此时信息量低？',
            any: ['不要先', '不先', '反汇编', '汇编', '对拍', '暴破', '穷举', '反调试', '先不', '成本', '信息量', '不划算'] },
          { label: '走不通时才下沉：常量比对 / 主动调用对拍 / 内存 dump 解密后的明文 / 只读观测 ART',
            hint: '前面都做完还没结果，往哪走？',
            any: ['内存', 'dump', '常量', '主动调用', '对拍', 'art', '只读', '明文', '解密', '下沉', '最后'] }
        ],
        hints: [
          '一张可能有几百条记录的映射表，它的价值不是"每条都能看"，而是"能排出顺序"。排序的依据是什么？',
          '想清楚每一步失败之后你获得了什么信息——如果失败什么都得不到，这一步就排错了位置。'
        ],
        probes: [
          '追问：如果你按签名形态筛出来的前三个方法，hook 之后发现它们的调用栈都指向同一个"通用转发函数"，你还能获得什么信息？',
          '再追问：假设你最终发现签名算法全部在 native 里完成，Java 层完全观测不到——你的顺序里哪一步会提前告诉你这个结论？'
        ],
        model: '<b>完整的推进顺序（每一步都说明"为什么排在这里"）：</b><br><br>' +
          '<b>第 ① 步（五分钟）：给映射表排序。</b><br>' +
          '拿到映射表的第一反应不是"开始分析"，而是<b>"排出分析顺序"</b>。' +
          '几百条记录逐个读汇编要几天，而排序之后你通常只需要看前三条。<br>' +
          '排序依据有两条，按可靠性排列：<br>' +
          '· <b>签名形态（最可靠）</b>：参数含 <span class="mono">[B</span> → 在处理二进制；' +
          '返回 <span class="mono">Ljava/lang/String;</span> → 产出可读结果（hex / base64）；' +
          '返回 <span class="mono">Z</span> → 校验。<b>这两个特征同时出现，基本就是编码/签名函数。</b><br>' +
          '· <b>命名异常度</b>：没被混淆的名字（<span class="mono">sign</span> / <span class="mono">check</span>）是信息，' +
          '但<b>单字母名（<span class="mono">a</span> / <span class="mono">b</span>）反而更值得看</b>——' +
          '加固方只混淆它认为重要的东西，<span class="hit">单字母名本身就是一种"重要性标记"。</span><br>' +
          '<b>为什么排第一：</b>成本最低，且它决定了后面所有工作的方向。<b>方向错了，后面全是白费。</b><br><br>' +
          '<b>第 ② 步（同步，几乎零成本）：每次命中就打印调用栈和线程 id。</b><br>' +
          '这一步<b>必须和 ① 同时做</b>，因为它决定了"这个函数值不值得继续看"：<br>' +
          '· 调用栈浅、来自业务线程 → <b>大概率是真正的签名路径</b>；<br>' +
          '· 来自 native 自建线程、或栈很深进不去 → <b>可能是自检、上报，优先级下调</b>。<br>' +
          '<span class="hit">不加这一行打印，你可能花两天分析一个只用于崩溃上报的函数。</span><br><br>' +
          '<b>第 ③ 步（半小时）：在 Java 侧布交叉观测点。</b><br>' +
          '只在 native 一侧看，会漏掉一整类情况：<b>native 只是"搬运工"，真正的算法在 Java 层。</b><br>' +
          '所以同时 hook：反射 API（<span class="mono">forName</span> / <span class="mono">invoke</span>）、' +
          '加密 API（<span class="mono">MessageDigest</span> / <span class="mono">Cipher</span> / <span class="mono">Mac</span>）。<br>' +
          '<b>为什么排第三：</b>它成本低、信息量大，而且能为 ① 的排序结果<b>提供独立验证</b>——' +
          '两边都指向同一个方法，可信度就高了。第 24 章的自吐沙箱就是把这套做成产品。<br><br>' +
          '<b>第 ④ 步（按需）：动态 dump 内存里的明文常量。</b><br>' +
          '很多加固方案在初始化时把常量表、字符串表<b>解密到堆上</b>。所以<b>静态搜不到不等于不存在</b>。' +
          '在内存里搜 MD5 的 IV 字节序列、AES S 盒开头——命中就直接读出来。<br>' +
          '<b>为什么排在 ③ 之后：</b>它比"直接读汇编"便宜，但比"看调用栈"贵。' +
          '而且如果 ③ 已经告诉了你算法名，这一步就没有必要了。<br><br>' +
          '<b>第 ⑤ 步（按需）：主动调用 + 输入输出对拍。</b><br>' +
          '拿到目标函数地址后，用固定入参主动调用，观察输出形态，与标准实现比对。<br>' +
          '<b>它的前提条件很重要：</b>目标函数必须是<b>纯函数</b>（不依赖全局密钥、随机数、时间戳）。' +
          '否则同样输入会得到不同输出，对拍直接失效。<span class="hit">所以在做对拍之前，先用 ② 的调用栈判断它是不是纯函数。</span><br><br>' +
          '<b>第 ⑥ 步（最后手段）：读汇编。</b><br>' +
          '到这一步，你已经知道：这个函数在链条的哪个位置、谁调它、输入输出长什么样、常量表在哪。' +
          '<b>带着这些上下文去读汇编，效率比一开始闷头读高一个数量级。</b>' +
          '如果发现是 OLLVM 混淆（第 5 章），那就走动态 Trace 而不是硬读。<br><br>' +
          '<b>我不会先做的三件事（以及为什么）：</b><br><br>' +
          '<b>❌ 不会先逐个读汇编。</b>成本最高（可能几天），而信息量最低——' +
          '你连"这个函数在链条的哪一环"都不知道，读出来的每一条指令都是孤立的。' +
          '<b>读汇编的性价比，取决于你已经知道多少上下文。</b><br><br>' +
          '<b>❌ 不会先做暴力输入输出对拍。</b>在不确认它是纯函数之前，对拍得到的"结果不一致"无法区分' +
          '"算法不同"和"输入不完整"两种原因——<b>你会得到一个无法解释的现象，而不是一个结论。</b><br><br>' +
          '<b>❌ 不会先去处理反调试。</b>除非它已经实际挡住了你。<b>不要提前解决还没发生的问题</b>——' +
          '反调试绕过是一个可能没有终点的兔子洞，而且它会<b>大幅改变运行环境</b>，让后续所有观测都更难对照。' +
          '<span class="hit">等它真的踢你的时候再处理，那时你至少知道它挡的是哪一步。</span><br><br>' +
          '<b>贯穿全流程的一条纪律：</b>每一步都要能回答两个问题——' +
          '<b>"成功了我看到什么"、"失败了我排除什么"。</b>' +
          '答不上来的动作，就是应该往后排的动作。'
      },
      {
        id: 'c20q6', depth: 3, threshold: 0.72,
        q: '<b>综合题（贯通本章）。</b>有人总结说：<br>' +
          '「分析加固样本的诀窍，就是找到那些<b>壳不得不做的动作</b>，然后守住它们。」<br>' +
          '请用本章讲过的机制，<b>举出至少四个"壳不得不做的动作"</b>，' +
          '并说明为什么它们绕不过去、以及你打算怎么守住。',
        concepts: [
          { label: '必须注册：动态注册必须调用 RegisterNatives，这是虚拟机提供的唯一标准入口',
            hint: '把 Java 方法和 native 地址关联起来，必须经过什么？',
            any: ['registerNatives', '注册', '唯一入口', '必经', '绕不过', '绑定', '映射'] },
          { label: '必须加载：so 必须先被 dlopen 加载进内存，代码才可能执行',
            hint: '机器码要先到内存里才能跑。这一步能跳过吗？',
            any: ['dlopen', '加载', 'loadlibrary', '映射', 'so 加载', 'init_array', 'android_dlopen_ext', '必须加载'] },
          { label: '必须查名字：要用反射或 JNI 查类/方法/字段，就必须调用固定名字的查询接口',
            hint: '它把名字藏起来了，但要"用"这些名字时必须做什么？',
            any: ['findclass', 'getmethodid', 'forname', 'getdeclaredmethod', '查询', '查名字', '反射', 'getfieldid', '接口名固定'] },
          { label: '必须调 Java：native 要拿 Java 层信息（环境、签名、类），必须经 JNI 反向调用接口',
            hint: '检测要拿数据，数据在 Java 层。怎么拿？',
            any: ['callobjectmethod', 'callstatic', 'jni', '反向调用', '回调', '主动调用', 'getstaticfield', '拿信息'] },
          { label: '必须比较：完整性校验、环境判定最终都要做一次比较或分支判断',
            hint: '校验的结论最终以什么形式出现？',
            any: ['比较', 'cmp', 'strcmp', '判断', '分支', '返回值', '校验结果', 'bool', '改返回值', '条件'] },
          { label: '必须解密：藏起来的数据（字符串、dex、常量）在使用前必须变成明文',
            hint: '加密存放的数据，什么时候变成明文？',
            any: ['解密', '明文', '内存', 'dump', '使用前', '还原', '解出来', '解密后'] },
          { label: '方法论的收口：不跟它比"谁藏得好"，而是观测"它必须做的动作"——因为动作即接口',
            hint: '把这一整套思路收成一句话。',
            any: ['不跟它比', '藏', '动作', '接口', '必经', '观测', '守', '绕不过', '行为', '必须做'] }
        ],
        hints: [
          '把加固想象成一个人在做一件坏事：他能藏起工具，但藏不起"必须伸手"这个动作。哪些动作是他必须做的？',
          '"必须做"意味着"无论怎么实现，都要经过某个固定名字的接口"。本章讲过的固定名字接口有哪些？'
        ],
        probes: [
          '追问：这四五个"必经动作"里，哪一个最不容易被对抗（比如被影子表骗、被分次注册绕过）？为什么？',
          '再追问：如果加固方把所有这些动作都做了对抗，你的观测能力会退化到什么程度？这时该往哪一层走？'
        ],
        model: '<b>这个总结是对的，而且它就是本章的元原则。</b>下面把"不得不做的动作"逐条落实。<br><br>' +
          '<b>① 必须注册（20.6 节）</b><br>' +
          '要让 Java 的 <span class="mono">native</span> 方法能执行，就必须建立"方法 → 地址"的映射。' +
          '静态注册靠命名约定，动态注册靠 <span class="mono">RegisterNatives</span>——' +
          '而 <span class="mono">RegisterNatives</span> 是<b>虚拟机提供的唯一标准入口</b>，加固方无法绕过（除非用 ART 内部特性直接改 <span class="mono">ArtMethod</span> 入口，那是更高阶的对抗）。<br>' +
          '<b>怎么守：</b>hook 它，三个参数就是完整答案（类、表指针、条数）。<b>一次拿到 name / signature / fnPtr 三元组。</b><br>' +
          '<b>注意它的软肋：</b>时机（可以比你更早）与完整性（可以分次注册、可以 Unregister 重注册）。<br><br>' +
          '<b>② 必须加载（20.4 节）</b><br>' +
          '机器码要先在内存里才能执行，所以 so <b>必须</b>经过 <span class="mono">dlopen</span> / ' +
          '<span class="mono">android_dlopen_ext</span>。这一步在<b>一切初始化之前</b>，是时间上最早的观测点。<br>' +
          '<b>怎么守：</b>hook <span class="mono">dlopen</span>，拿到完整模块清单 + 加载时机 + 加载来源路径。<br>' +
          '<span class="hit">它的独特价值：这是唯一一个"早于对手所有动作"的观测点。</span>' +
          '如果你老是被"检测跑完了你才 attach"困扰，答案就在这里。<br><br>' +
          '<b>③ 必须查名字（20.10 节）</b><br>' +
          '壳可以把类名、方法名加密存放，但<b>要用它们的时候必须以明文出现</b>，' +
          '而且必须通过<b>固定名字的查询接口</b>：<span class="mono">FindClass</span> / ' +
          '<span class="mono">GetMethodID</span> / <span class="mono">Class.forName</span> / <span class="mono">getDeclaredMethod</span>。<br>' +
          '<b>怎么守：</b>在查询接口上布点。被藏起来的名字会在这里现身。<br>' +
          '<b>为什么这条特别有用：</b>它把"解密算法"问题（难）转化成了"看日志"问题（易）。' +
          '<span class="hit">解密完成后内存里就是明文，你不需要逆解密算法。</span><br><br>' +
          '<b>④ 必须调 Java（20.9 节）</b><br>' +
          'native 层想知道环境信息（<span class="mono">Build</span> 字段、包签名、类是否存在），' +
          '数据在 Java 层，所以它<b>必须</b>经 JNI 反向调用：' +
          '<span class="mono">GetStaticFieldID</span> / <span class="mono">CallObjectMethod</span> / <span class="mono">CallStaticObjectMethod</span>。<br>' +
          '<b>怎么守：</b>两条路——在 native 侧 hook JNI 调用，' +
          '或者<b>更省事</b>：在 Java 侧 hook 那些被读取的信息源（<span class="mono">Build</span>、<span class="mono">getPackageInfo</span>、<span class="mono">Class.forName</span>），' +
          '<b>反推它在查什么</b>。<br>' +
          '<span class="hit">这条路径的意义：即使你完全看不懂那个 so，也能知道它在检测什么。</span><br><br>' +
          '<b>⑤ 必须比较（隐含在前面每一条里）</b><br>' +
          '完整性校验、环境判定、签名验证，最终都要落到一次<b>比较或分支</b>上——' +
          '<span class="mono">memcmp</span> / <span class="mono">strcmp</span> / 一个条件跳转。<br>' +
          '<b>怎么守：</b>在比较处下断点或 hook，观察"它拿什么和什么比"。' +
          '<b>更实用的做法：直接改比较结果</b>——改一处返回值，比逆完整套校验逻辑便宜得多。' +
          '这也是第 10 章"把分散的杀点收敛成一处返回值"的思路。<br><br>' +
          '<b>⑥ 必须解密（20.13 节）</b><br>' +
          '加密存放的字符串、常量表、内嵌 dex，<b>在使用前必须变成明文</b>。' +
          '而"变成明文"的那个时刻，内存里就是可以直接读的。<br>' +
          '<b>怎么守：</b>动态 dump 内存，或者观测解密函数的输出。<b>不要先想着逆解密算法。</b><br><br>' +
          '<b>方法论收口</b><br><br>' +
          '把这六条放在一起，你会发现它们遵循同一个模式：<br>' +
          '<b>壳能藏住"名字"和"位置"，但藏不住"动作"。</b>' +
          '而动作必然经过<b>固定名字的接口</b>（<span class="mono">RegisterNatives</span> / <span class="mono">dlopen</span> / ' +
          '<span class="mono">FindClass</span> / <span class="mono">CallObjectMethod</span>…）——' +
          '因为这些接口是<b>系统提供的</b>，它改不了。<br><br>' +
          '<span class="hit">所以正确的心态不是"我要比它更会藏"，而是"我要比它更会观察"。</span><br>' +
          '它花力气把东西藏起来，你花力气守住它必须经过的路口——<b>这是一场不对称的博弈，而且优势在你这边：' +
          '它要藏住全部，你只要守住一个。</b><br><br>' +
          '<b>最后，关于"观测能力退化"这个追问：</b>' +
          '如果这六条都被针对性对抗了（影子表、极早期注册、只读观测被阻断、内联消除比较点……），' +
          '那么你面对的已经不是应用层的加固，而是<b>系统层对抗</b>——' +
          '这时该往第 13 章（内核态、硬件断点、内联 SVC）或第 6 章（Hypervisor 层）走。<br>' +
          '<span class="hit">判断依据很简单：<b>当你的观测点全部在它下面（更低一层），它就看不见你。</b>' +
          '这就是"降维"这条贯穿全课的主线。</span>'
      }
    ]
  }
};

/* ==========================================================================
   本章 Lab 用到的解析器（数据文件内的纯函数，不依赖外部库）
   —— 放在文件末尾，因为它们是函数声明，会被提升，但放在下面更易读
   ========================================================================== */

/* 把 Java 类型写法翻译成 JNI 描述符 */
function ch20JniTypeOf(raw) {
  let t = String(raw || '').trim();
  if (!t) return { desc: '', note: '（空）' };
  // 去掉泛型参数（编译后被擦除）
  const generic = /<.*>/.test(t);
  t = t.replace(/<[^>]*>/g, '');
  // 数组维度
  let dim = 0;
  while (/\[\s*\]$/.test(t)) { dim++; t = t.replace(/\[\s*\]$/, '').trim(); }
  // 也支持 Java 的 int... 变参写法
  if (/\.\.\.$/.test(t)) { dim++; t = t.replace(/\.\.\.$/, '').trim(); }
  const prim = { void: 'V', boolean: 'Z', byte: 'B', char: 'C', short: 'S', int: 'I', long: 'J', float: 'F', double: 'D' };
  const short = t.replace(/^java\.lang\./, '');
  let base, note = '';
  if (prim[t]) { base = prim[t]; }
  else {
    const full = t.indexOf('.') >= 0 ? t : 'java.lang.' + t;
    base = 'L' + full.replace(/\./g, '/') + ';';
    if (t.indexOf('.') < 0 && !/^[A-Z]/.test(t)) note = '⚠️ 无法识别的类型名，按对象类型处理';
  }
  let desc = base;
  for (let i = 0; i < dim; i++) desc = '[' + desc;
  if (generic) note = (note ? note + '；' : '') + '<b>泛型被擦除</b>，描述符里不体现';
  if (dim) note = (note ? note + '；' : '') + dim + ' 维数组';
  return { desc, note };
}

/* 解析一个 Java 方法声明 → 名称 / 参数 / 返回值 / 描述符 / 短符号名 */
function ch20ParseJavaDecl(src) {
  let s = String(src || '').trim();
  if (!s) return { err: '声明是空的' };
  s = s.replace(/;\s*$/, '');
  const m = /([A-Za-z_$][\w$.]*(?:\s*<[^>]*>)?(?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/.exec(s);
  if (!m) return { err: '看不出来这是一个方法声明（需要"返回类型 方法名(参数)"的形式）' };
  const retRaw = m[1], name = m[2], argStr = m[3];
  const ret = ch20JniTypeOf(retRaw);
  const params = [];
  if (argStr.trim()) {
    argStr.split(',').forEach(p => {
      const t = p.trim();
      // 去掉参数名（取最后一个标识符之前的部分作为类型）
      const typeOnly = t.replace(/\s+[A-Za-z_$][\w$]*$/, '').trim() || t;
      const info = ch20JniTypeOf(typeOnly);
      params.push({ java: typeOnly, desc: info.desc, note: info.note || '—' });
    });
  }
  const descriptor = '(' + params.map(p => p.desc).join('') + ')' + ret.desc;
  const cls = 'com.example.app.Crypto';
  const shortSymbol = 'Java_' + ch20MangledClass(cls) + '_' + ch20MangledName(name);
  const longSymbol = 'Java_' + ch20MangledClass(cls) + '_' + ch20MangledName(name) + '__' +
    params.map(p => p.desc.replace(/\//g, '_')).join('');
  return { name, ret, params, descriptor, shortSymbol, longSymbol };
}

/* JNI 类名 → 符号名：先转义下划线，再点换下划线 */
function ch20MangledClass(cls) {
  return String(cls).replace(/_/g, '_1').replace(/\./g, '_');
}
/* 方法名里的下划线同样要转义 */
function ch20MangledName(n) {
  return String(n).replace(/_/g, '_1');
}

/* 解析 RegisterNatives hook 输出 → 映射表 */
function ch20ParseRegDump(txt) {
  const s = String(txt || '');
  const cm = /class\s*=\s*([\w.$]+)/.exec(s);
  const cls = cm ? cm[1] : '(未识别)';
  const rows = [];
  s.split(/\r?\n/).forEach(line => {
    const m = /^\s*#?\d*\s*([A-Za-z_$][\w$]*)\s+(\S+)\s+fnPtr\s*=\s*(0x[0-9a-fA-F]+|\d+)/.exec(line);
    if (!m) return;
    const name = m[1], sig = m[2], ptr = m[3];
    const parsed = ch20ParseSig(sig);
    rows.push({
      name, sig, ptr,
      args: parsed.args, ret: parsed.ret, descOk: parsed.ok,
      staticSymbol: 'Java_' + ch20MangledClass(cls) + '_' + ch20MangledName(name) + '__' +
        parsed.args.join('').replace(/\//g, '_')
    });
  });
  if (!rows.length) return { err: '没有解析出任何记录，检查每行是否形如 "#0 name (签名) fnPtr=0x..."' };
  return { cls, rows };
}

/* 极简方法描述符解析：只取顶层参数与返回类型，用于展示 */
function ch20ParseSig(sig) {
  const out = { args: [], ret: '', ok: false };
  const s = String(sig || '').trim();
  if (!s) return out;
  // 去掉内部类/数组里可能出现的空格，但保留可读性
  if (s[0] !== '(') return out;
  let depthParen = 0, i = 0, cur = '';
  const args = [];
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '(') { depthParen++; continue; }
    if (c === ')') { depthParen--; i++; break; }
    if (depthParen === 1 && c === ';') { cur += c; args.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur) args.push(cur);
  const ret = s.slice(i);
  const pretty = x => {
    if (!x) return '?';
    let dim = 0, t = x;
    while (t[0] === '[') { dim++; t = t.slice(1); }
    const P = { V: 'void', Z: 'boolean', B: 'byte', C: 'char', S: 'short', I: 'int', J: 'long', F: 'float', D: 'double' };
    let base = P[t] || (t[0] === 'L' ? t.slice(1, -1).split('/').pop() : t);
    return base + '[]'.repeat(dim);
  };
  out.args = args.map(pretty);
  out.ret = pretty(ret);
  out.ok = /^[\(\[LZVBCSIJFD]/.test(s) && s.indexOf(')') > 0;
  return out;
}

/* 小工具：转义（数据文件内自用，等价于 AKKC.esc 的最小版本） */
function ch20esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
