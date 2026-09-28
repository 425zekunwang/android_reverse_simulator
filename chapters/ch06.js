/* 第 6 章 · 高级调试之 VMP —— 数据文件
   只依赖 window.CHAPTER、全局助手 T（HTML 生成）与 S / SET / CLS（stage 动画）。
   字符串一律用单引号，内部引号用中文引号，避免转义事故。 */

window.CHAPTER = {
  no: 6,
  title: '高级调试之 VMP',
  lede: '当一代壳、抽取壳都被脱壳机碾过之后，安卓保护的最后一道墙是 <strong>VMP</strong>：把原始 ARM 指令翻译成一套自定义字节码，运行时交给内置解释器逐条执行，让静态反编译整体失效。这一章回答三个问题——VMP 内部到底长什么样、怎么用「映射表」把它逆回来、以及为什么必须把调试器藏到 <strong>Hypervisor（EL2）</strong> 这种比 App 更低的层级，反调试才会彻底失效。',
  meta: [
    '核心问题：<b>IDA 里只剩一个 while + switch，原始逻辑去哪了？</b>',
    '关键工具：<b>Hyperpwn（EL2 内存断点）、ADVMP（开源 VMP 实现）、定制 ART</b>',
    '对手：<b>指令级虚拟化 + 反调试 / 反注入 / 代码段校验和</b>'
  ],

  sections: [
    /* ================= 6.1 ================= */
    {
      h: '6.1',
      title: '保护的阶梯：从一代壳爬到 VMP',
      html:
        '<p>安卓加固不是一步到位的技术，而是一条<strong>保护强度不断爬升的阶梯</strong>。搞清楚自己面对的对手站在哪一级，' +
        '你才知道前几章那些顺手的工具会从哪里开始失灵。</p>' +
        T.tbl(['代际', '它做了什么', '静态分析还剩什么', '逆向的切入点'], [
          ['一代壳（整体加密壳）',
           'dex 整体加密存放，运行时在 Native 层解密到内存，再交给 ART 加载',
           '磁盘上的 dex 是密文，静态什么都看不到',
           '内存中解密完成的那一刻 dump 出完整 dex'],
          ['二代壳 / 抽取壳',
           'dex 结构（头、类表、方法表）保留，但方法的 <code>code_item</code> 被抽走——insns 置空或填 nop，被调用前才回填',
           '类名、方法名、签名都在，<b>方法体是空的</b>',
           '在回填/执行前抢 dump，或主动调用把方法体逼出来'],
          ['VMP（指令级虚拟化）',
           '连方法体都不再是标准指令：原始 ARM 指令被翻译成一套自定义字节码，运行时由内置解释器逐条解释执行',
           '一段解释器循环 + 一堆被当作数据使用的字节码',
           '动态记录「字节码 → 实际行为」的对应关系，重建语义'],
          ['附加手段',
           'Java2C、OLLVM 混淆、反调试 / 反注入 / 代码段校验和',
           '逻辑被拍平、控制流被伪造、调试器一附加就退出',
           '定制 ART / 定制内核 / Hypervisor：从更底层绕开']
        ]) +
        T.note('key', '🔑 一条主线，贯穿全章',
          '<p>保护强度递进：<b>一代壳 &lt; 抽取壳 &lt; VMP</b>。VMP 之所以站在安卓保护金字塔的顶端，' +
          '是因为它保护的不是「数据」（一代壳保护的是 dex 文件内容），也不是「结构」（抽取壳保留结构只抽方法体），' +
          '而是<b>语义本身</b>——指令长什么样、做了什么运算，全部由厂商自定义。</p>') +
        T.note('warn', '⚠️ 别急着找「一键脱 VMP 工具」',
          '<p>市面上确实有各种脱壳机、FART 一类的主动调用框架，但它们解决的主要是<strong>一代壳与抽取壳</strong>的问题。' +
          '到了 VMP 这一级，没有通用的「脱」——因为根本不存在一个「原始形态」可以被还原。' +
          '你能做的只有 <b>还原语义</b>：搞清这段字节码等价于什么操作。这是一件体力活，但方法论很清晰，本章就讲这个方法论。</p>') +
        T.note('', '🎯 这对逆向实战有什么用',
          '<p>遇到一个 App，先用 <span class="term" data-def="把 so / dex 拖进 IDA 或 Ghidra 做静态反编译检查">静态侦察</span> 判断它在哪一级：' +
          '磁盘 dex 是密文 → 一代壳；方法体全空但有方法名 → 抽取壳；关键函数点进去是一个巨大的 ' +
          '<code>while</code> + <code>switch</code> 而没有任何业务逻辑 → VMP。' +
          '判级决定了你接下来要投入的是「脱壳脚本」还是「映射表工程」，两者的工作量差一个数量级。</p>') +
        T.intuition('直觉模型 · VMP 就像把中文翻译成自创的密码文字',
          '<p>假设你要保护一本中文书不被别人读懂。有三条路，强度递增：</p>' +
          '<p><b>① 把书锁进保险箱</b>（一代壳）——别人打不开箱子。但如果他把箱子撬开，书就原样暴露了。</p>' +
          '<p><b>② 把每页正文挖掉，只留目录</b>（抽取壳）——别人能看到"第 3 章讲什么"，但翻到正文是空白。' +
          '麻烦的是，这本书在图书馆里被借阅时，管理员会临时把正文补回去——你只要蹲在那一刻拍照就行。</p>' +
          '<p><b>③ 把整本书翻译成一套自创的密码文字</b>（VMP）——书是"完整"的，每一页都有字，' +
          '但这些字谁都不认识。而且译者还随身带着一本<b>密码本</b>（映射表），只有对照密码本才能读。</p>' +
          '<p style="margin-bottom:0"><b>关键洞察：</b>面对第 ③ 种，你没法"把密码文字还原成中文"——' +
          '因为那不是加密，是<b>换了一套语言</b>。你能做的只有一件事：' +
          '<span class="hit">找到那本密码本，然后把整本书逐字翻译回来。</span>' +
          '这就是为什么第 6 章所有技巧最终都指向同一个目标——<b>扒出映射表</b>。</p>'),

      stage: {
        title: '保护阶梯：每一级都在拿掉分析者的一件武器',
        speed: 1900,
        render:
          '<div class="flow-col">' +
            '<span class="blk" id="g1">① 一代壳 · dex 整体加密</span>' +
            '<span class="blk" id="g2">② 抽取壳 · code_item 被抽空</span>' +
            '<span class="blk" id="g3">③ VMP · 指令级虚拟化</span>' +
          '</div>' +
          '<div class="flow-row" style="margin-top:14px;align-items:center">' +
            '<span class="pill" id="gLv">保护强度：—</span>' +
            '<span class="arrow">→</span>' +
            '<span class="pill" id="gDump">脱壳难度：—</span>' +
            '<span class="arrow">→</span>' +
            '<span class="pill" id="gSee">静态可见：原始逻辑</span>' +
          '</div>' +
          '<div class="flow-row" style="margin-top:10px">' +
            '<span class="pill" id="gFix">分析者的武器：静态反编译</span>' +
          '</div>',
        reset: () => {
          S('g1', ''); S('g2', ''); S('g3', '');
          CLS('gLv', 'pill'); SET('gLv', '保护强度：—');
          CLS('gDump', 'pill'); SET('gDump', '脱壳难度：—');
          CLS('gSee', 'pill'); SET('gSee', '静态可见：原始逻辑');
          CLS('gFix', 'pill ok'); SET('gFix', '分析者的武器：静态反编译');
        },
        steps: [
          { run: () => {
              S('g1', 'active');
              CLS('gLv', 'pill warn'); SET('gLv', '保护强度：★');
              CLS('gDump', 'pill ok'); SET('gDump', '脱壳难度：低');
              CLS('gSee', 'pill'); SET('gSee', '磁盘 dex：密文');
            },
            note: '<b>第一级：一代壳。</b>它保护的是「文件」。dex 整体被加密后塞进 APK，运行起来再由 Native 层解密到内存。攻击面很窄——只要拿到解密后的内存镜像，dex 就是完整的。' },
          { run: () => {
              S('g1', 'cool');
              CLS('gDump', 'pill warn'); SET('gDump', '脱壳难度：中（抢内存 dump）');
              CLS('gSee', 'pill warn'); SET('gSee', '内存中的完整 dex');
            },
            note: '<b>脱壳点被精确定位：</b>解密完成、交给 ART 加载之前的那一瞬间。时机对了，一次 dump 就结束。<span class="miss">一代壳的防护几乎等价于「晚一点给你看」。</span>' },
          { run: () => {
              S('g2', 'active');
              CLS('gLv', 'pill warn'); SET('gLv', '保护强度：★★');
              CLS('gSee', 'pill warn'); SET('gSee', '类名在，方法体是空的');
            },
            note: '<b>第二级：抽取壳。</b>厂商换了个思路——不再藏整个文件，而是把每个方法的 <code>code_item</code>（指令数组 insns）在磁盘上抽走，只在方法被调用前回填到内存。' },
          { run: () => {
              S('g2', 'cool');
              CLS('gDump', 'pill bad'); SET('gDump', '脱壳难度：高（要抢时机 + 主动调用）');
            },
            note: '<b>为什么普通内存 dump 失效：</b>你 dump 出来的 dex 结构完好、方法齐全，但绝大多数方法体是空的。<span class="miss">dump 到「空方法」是抽取壳最典型的翻车姿势。</span>破解要靠主动调用把方法一个个逼出来，再回填进 dump 的 dex。' },
          { run: () => {
              S('g3', 'active');
              CLS('gLv', 'pill bad'); SET('gLv', '保护强度：★★★★★');
              CLS('gDump', 'pill bad'); SET('gDump', '脱壳难度：无通用解');
              CLS('gSee', 'pill bad'); SET('gSee', '方法体 = 自定义字节码');
            },
            note: '<b>第三级：VMP。</b>它连「方法体是标准指令」这个前提都取消了。原始 ARM 指令被翻译成厂商自定义的字节码，运行时由内置解释器执行。<b>不存在「原始形态」可以还原</b>——脱壳这个概念本身在这里失效了。' },
          { run: () => {
              S('g3', 'hot');
              CLS('gFix', 'pill bad'); SET('gFix', '分析者的武器：静态反编译 → 失效');
            },
            note: '<b>最致命的一击：</b>IDA 走进去，看到的不再是业务逻辑，而是一个解释器主循环 + 一大堆被当作数据使用的字节码。<span class="bad">静态反编译在这里第一次整体失效。</span>' },
          { run: () => {
              CLS('gFix', 'pill warn'); SET('gFix', '剩下的路：动态记录语义 + 更底层的调试');
            },
            note: '<b>这就是本章的战场。</b>既然静态读不出来，就只剩动态一条路：跑起来，在分发器处记录每一条字节码做了什么，把语义一条条「抄」回来。而厂商当然也知道你会动态调试——所以还配了反调试。于是最终答案是把调试器藏到 <b>Hypervisor 层</b>。' }
        ]
      },
      after:
        '<p>记住这个顺序：<strong>先判级，再选工具</strong>。用错级别的工具，浪费的不是时间，是对形势的判断。</p>'
    },
    /* ================= 6.2 ================= */
    {
      h: '6.2',
      title: 'VMP 原理：指令被翻译成了什么',
      html:
        '<p><strong>VMP = Virtual Machine Protect</strong>。名字听着玄，核心思想一句话就能说完：' +
        '<b>把原始指令集（ARM）的代码，翻译成一套厂商自定义的字节码；运行时由一个内置解释器逐条解释执行。</b></p>' +
        '<p>这里的「自定义字节码」不是 Java 字节码、也不是 dex 的那套 Dalvik 指令——它是厂商自己拍脑袋定的，' +
        '没有任何文档，<span class="term" data-def="操作码：字节码流里表示「这是一条什么指令」的那个数值">opcode</span> 的值、' +
        '<span class="term" data-def="紧跟操作码之后、为这条指令提供参数（寄存器编号、立即数、跳转偏移等）的字节">操作数</span>的编码方式、' +
        '寄存器的编号，外人一概不知。' +
        '于是同一个函数，在 IDA 里从一个有业务含义的<span class="term" data-def="一段可读的、有明确控制流的机器指令序列">指令序列</span>，' +
        '变成了一坨「只有那个解释器才看得懂的数字」。</p>' +
        T.grid(2, [
          T.card('加固前：IDA 眼中的原生 ARM 函数',
            T.code(
              '<span class="m">0x1000</span>  <span class="k">MOV</span> <span class="r">R0</span>, <span class="r">R1</span>\n' +
              '<span class="m">0x1004</span>  <span class="k">ADD</span> <span class="r">R0</span>, <span class="r">R0</span>, <span class="n">#4</span>\n' +
              '<span class="m">0x1008</span>  <span class="k">LDR</span> <span class="r">R2</span>, [<span class="r">R0</span>]\n' +
              '<span class="m">0x100C</span>  <span class="k">STR</span> <span class="r">R2</span>, [<span class="r">R3</span>]'
            ) +
            '<p class="small">控制流清晰、语义可读——这是前几章你能顺藤摸瓜的原因。</p>'),
          T.card('加固后：同一个函数变成了字节码数据',
            T.code(
              '<span class="c">// 现在这段代码住在解释器里，而且只有一次</span>\n' +
              '<span class="k">while</span> (<span class="n">1</span>) {\n' +
              '  <span class="t">uint8_t</span> op = *pc++;\n' +
              '  <span class="k">switch</span> (op) { <span class="c">/* ... */</span> }\n' +
              '}\n' +
              '<span class="c">// 业务逻辑被挪到了数据段：</span>\n' +
              '<span class="m">0x5A00</span>: <span class="n">1A 00 2B 01 07 3C</span> ...'
            ) +
            '<p class="small">IDA 反编译出来的就是这个 switch，业务逻辑「不见了」。</p>')
        ]) +
        T.note('key', '🔑 为什么静态反编译在这里整体失效',
          '<p>因为<b>反编译器的前提被抽掉了</b>。所有反编译器（IDA 的 Hex-Rays、Ghidra 的 decompiler）都建立在一个假设上：' +
          '机器码的语义由 CPU 架构手册定义，是公共知识。VMP 把「语义」 privatize 了——' +
          '<code>0x1A</code> 对 CPU 来说只是个数据字节，它到底等于 MOV 还是 ADD，' +
          '只有那个解释器里的 <code>case 0x1A:</code> 分支知道。</p>' +
          '<p>更狠的是：解释器本身是标准代码（while + switch），<b>看起来完全正常</b>，' +
          '但它对每一条字节码做了什么，是厂商的私有约定。<span class="miss">你面对的是一台你从未见过指令集手册的 CPU。</span></p>') +
        T.note('', '📖 解释器的典型结构（背下来，这是你的分析锚点）',
          T.code(
            '<span class="k">while</span> (<span class="n">1</span>) {\n' +
            '    opcode = *pc++;            <span class="c">// 取指：从字节码流取一个操作码</span>\n' +
            '    <span class="k">switch</span> (opcode) {        <span class="c">// 分发：跳转到对应 handler</span>\n' +
            '        <span class="k">case</span> <span class="n">0x1A</span>: ...; <span class="k">break</span>;   <span class="c">// Handler：执行实际操作</span>\n' +
            '        <span class="k">case</span> <span class="n">0x2B</span>: ...; <span class="k">break</span>;\n' +
            '    }\n' +
            '}'
          ) +
          '<p>这段结构万变不离其宗。厂商能做的加固是：把 switch 打散成多层跳转、把 handler 之间的跳转 OLLVM 混淆、' +
          '每执行几条就重新计算下一次分发的目标——但<b>「取指 → 分发 → 执行 → 回到取指」这个环永远存在</b>。' +
          '找到这个环，你就找到了 VMP 的心脏。</p>') +
        T.tbl(['关键概念', '它是什么', '在分析中的角色'], [
          ['VM 入口（vm_entry）', '进入虚拟机的入口代码，负责保存真实 CPU 上下文、初始化 VMContext、把 pc 指向字节码流首地址',
           '<b>第一个要定位的地方</b>：从被保护的函数入口往下追，第一个「大段保存寄存器 + 载入几个神秘常量」的位置通常就是它'],
          ['分发器（dispatcher）', '解释器主循环里的那个 switch / 跳转表，负责把 opcode 映射到 handler',
           '<b>分析的锚点</b>：所有动态 hook 都挂在分发器上，它是唯一一个「每条字节码都会经过」的地方'],
          ['Handler', '每个字节码指令对应的实际处理代码，真正干活的地方',
           '映射表的右半边——你要记录的是「这个 handler 等价于哪种 ARM 操作」'],
          ['虚拟寄存器 / VM 上下文（VMContext）', 'VMP 自己维护的一套寄存器组与状态结构，替代真实 CPU 寄存器参与运算',
           '右半边状态表的主角：观察 V0/V1 怎么变，就知道字节码在算什么'],
          ['字节码流（bytecode stream）', '被当作数据处理的那串自定义指令，通常在 so 的只读数据段或运行时解密出来的内存区',
           '静态分析的「死路」与动态分析的「活水」——它本身没意义，配上映射表才有意义']
        ]) +
        T.note('warn', '⚠️ 常见坑：把 handler 当业务函数读',
          '<p>新手最容易犯的错，是在反编译结果里看到一个长得像业务逻辑的函数，就兴奋地开始分析，' +
          '结果发现它「什么都没做」——那是个 <b>handler</b>。handler 只做原子操作：' +
          '从 VMContext 读两个虚拟寄存器、加一下、写回去。它<b>天然没有业务语义</b>，因为它只是字节码的「腿」。' +
          '业务语义在字节码的<i>排列顺序</i>里，不在 handler 内部。</p>') +
        T.note('', '🎯 这对逆向实战有什么用',
          '<p>它给了你一个极其明确的作战地图：<b>不要试图读代码，要试图读数据</b>。' +
          '把「理解一个函数在做什么」转化成一个可枚举的工程问题——建立 <b>自定义字节码 → 实际操作</b> 的映射表。' +
          '映射表一旦建起来，剩下的就是把字节码流翻译回伪代码，这步甚至可以自动化。</p>'),

      stage: {
        title: 'VMP 全景：原始 ARM → 自定义字节码 → 解释器循环',
        speed: 1850,
        render:
          '<div class="flow-col">' +
            '<div class="small muted">① 原始 ARM 指令流（加固前存在，加固后消失）</div>' +
            '<div class="flow-row">' +
              '<span class="blk" id="ai1">MOV R0,R1</span>' +
              '<span class="blk" id="ai2">ADD R0,#4</span>' +
              '<span class="blk" id="ai3">LDR R2,[R0]</span>' +
              '<span class="blk" id="ai4">STR R2,[R3]</span>' +
            '</div>' +
            '<div class="small muted" style="margin-top:10px">② 翻译后：自定义字节码流（住在数据段，纯数字）</div>' +
            '<div class="flow-row">' +
              '<span class="blk" id="b1">0x1A</span>' +
              '<span class="blk" id="b2">0x00</span>' +
              '<span class="blk" id="b3">0x2B</span>' +
              '<span class="blk" id="b4">0x01</span>' +
              '<span class="blk" id="b5">0x07</span>' +
              '<span class="blk" id="b6">0x3C</span>' +
            '</div>' +
            '<div class="small muted" style="margin-top:10px">③ 解释器循环（全程序只有一份，IDA 看得到）</div>' +
            '<div class="flow-row">' +
              '<span class="blk" id="p1">取指 op=*pc++</span>' +
              '<span class="arrow">→</span>' +
              '<span class="blk" id="p2">分发 switch(op)</span>' +
              '<span class="arrow">→</span>' +
              '<span class="blk" id="p3">handler 执行</span>' +
              '<span class="arrow">→</span>' +
              '<span class="blk" id="p4">更新 VMContext</span>' +
            '</div>' +
          '</div>' +
          '<div class="regs" style="margin-top:12px">' +
            '<span class="reg" id="vpc"><b>vm pc</b>=—</span>' +
            '<span class="reg" id="vop"><b>opcode</b>=—</span>' +
            '<span class="reg" id="v0"><b>V0</b>=0</span>' +
            '<span class="reg" id="v1"><b>V1</b>=0x1000</span>' +
          '</div>',
        reset: () => {
          ['ai1','ai2','ai3','ai4','b1','b2','b3','b4','b5','b6','p1','p2','p3','p4'].forEach(function (i) { S(i, ''); });
          CLS('vpc', 'reg'); SET('vpc', '<b>vm pc</b>=—');
          CLS('vop', 'reg'); SET('vop', '<b>opcode</b>=—');
          CLS('v0', 'reg'); SET('v0', '<b>V0</b>=0');
          CLS('v1', 'reg'); SET('v1', '<b>V1</b>=0x1000');
          S('ai1', 'active');
        },
        steps: [
          { run: () => { S('ai1', 'active'); },
            note: '<b>起点：一段普通的 ARM 函数。</b>四条指令各司其职。如果它没被保护，IDA 按 F5 就能读出这段逻辑，你甚至不用动脑。' },
          { run: () => { S('ai1', 'hot'); S('b1', 'active'); },
            note: '<b>翻译（加固期，不是运行期）。</b><code>MOV R0,R1</code> 被翻译成字节码 <code>0x1A</code>。<span class="miss">注意：这一步发生在厂商打包时</span>，发布出去的 so 里已经没有原始 ARM 了。' },
          { run: () => { S('ai1', 'done'); S('ai2', 'hot'); S('b1', 'cool'); S('b2', 'active'); },
            note: '<b>操作数也一起被编码。</b><code>0x1A 0x00</code> 里的 <code>0x00</code> 是操作数——很可能编码了「用哪两个虚拟寄存器」。这套编码规则是厂商私有的。' },
          { run: () => { S('ai2', 'done'); S('ai3', 'hot'); S('b2', 'cool'); S('b3', 'active'); },
            note: '<b>继续翻译。</b><code>ADD R0,#4</code> → <code>0x2B 0x01</code>。指令长度可能不固定（有的 opcode 带操作数、有的不带），这让字节码流连「边界」都难以静态切分。' },
          { run: () => { S('ai3', 'done'); S('ai4', 'hot'); S('b3', 'cool'); S('b4', 'active'); S('b5', 'active'); },
            note: '<b>访存指令同样被虚拟化。</b><code>LDR</code> → <code>0x07</code>。这意味着<b>连「读了哪块内存」这种信息都被藏起来了</b>——你没法靠交叉引用（XREF）找到数据流。' },
          { run: () => { S('ai4', 'done'); S('b4', 'cool'); S('b5', 'cool'); S('b6', 'active'); },
            note: '<b>翻译完成。</b>原始 ARM 指令流从这个函数里彻底消失，只剩下数据段里的一串数字。' },
          { run: () => { S('b6', 'cool'); S('p1', 'active'); CLS('vpc', 'reg changed'); SET('vpc', '<b>vm pc</b>=0x00'); },
            note: '<b>运行时进入 vm_entry。</b>真实 CPU 上下文被保存到 VMContext，虚拟程序计数器 <code>vm pc</code> 指向字节码流首字节。从现在起，「执行」这件事由解释器接管。' },
          { run: () => { S('p1', 'hot'); S('b1', 'active'); CLS('vop', 'reg changed'); SET('vop', '<b>opcode</b>=0x1A'); },
            note: '<b>取指：<code>opcode = *pc++</code>。</b>读到 <code>0x1A</code>，vm pc 前进。这只是「读了一个字节」——CPU 层面完全没有「这是一条指令」的概念。' },
          { run: () => { S('p1', 'done'); S('p2', 'active'); },
            note: '<b>分发：<code>switch (opcode)</code>。</b>编译器通常把它编译成一张跳转表（<code>ldr pc, [table, op, lsl #2]</code>）。<span class="hit">这就是你在 IDA 里唯一能看到的「逻辑」。</span>' },
          { run: () => { S('p2', 'done'); S('p3', 'active'); S('b1', 'hot'); },
            note: '<b>命中 <code>case 0x1A</code> 的 handler。</b>它的代码极短：从 VMContext 里把 V1 读出来，写进 V0。等价于 <code>MOV</code>——但<b>代码里一个字都没提 MOV</b>。' },
          { run: () => { S('p3', 'done'); S('p4', 'active'); CLS('v0', 'reg changed'); SET('v0', '<b>V0</b>=0x1000'); },
            note: '<b>更新 VMContext。</b>V0 变成 0x1000。<span class="hit">这一刻就是映射表的一条记录：字节码 0x1A ≡ 虚拟寄存器赋值（等价 MOV）。</span>' },
          { run: () => { S('p4', 'done'); S('b1', 'cool'); S('b2', 'active'); CLS('vpc', 'reg changed'); SET('vpc', '<b>vm pc</b>=0x02'); CLS('vop', 'reg'); SET('vop', '<b>opcode</b>=—'); },
            note: '<b>回到循环顶部。</b>vm pc 已经跳过 0x1A 和它的操作数，指向下一条。整个解释过程就是这样一个永不停止的环。' },
          { run: () => { S('p1', 'active'); S('b3', 'active'); CLS('vop', 'reg changed'); SET('vop', '<b>opcode</b>=0x2B'); },
            note: '<b>下一条字节码 0x2B。</b>同样的取指、同样的分发，但这次会命中另一个 handler。' },
          { run: () => { S('p1', 'done'); S('p2', 'active'); },
            note: '<b>分发器第二次被经过。</b>注意：<b>这个 switch 会被执行成千上万次</b>，而每次的业务含义都不同。它自己没有任何信息量。' },
          { run: () => { S('p2', 'done'); S('p3', 'active'); CLS('v0', 'reg changed'); SET('v0', '<b>V0</b>=0x1004'); },
            note: '<b>0x2B 的 handler 把 V0 加了 4。</b>映射表再添一条：<b>0x2B ≡ 虚拟寄存器加立即数（等价 ADD）</b>。两条记录，语义就回来了。' },
          { run: () => { S('p3', 'done'); S('p4', 'active'); S('p1', 'hot'); S('p2', 'hot'); S('p3', 'hot'); S('p4', 'hot'); },
            note: '<b>现在回头看 IDA 的视角。</b>它看到的永远只有这四步组成的死循环，以及一堆它以为是「数组常量」的字节。<span class="bad">静态反编译失效的根源就在这里——不是代码被藏起来了，是语义被搬到了私有约定里。</span>' },
          { run: () => {
              ['ai1','ai2','ai3','ai4'].forEach(function (i) { S(i, ''); });
              CLS('vop', 'reg'); SET('vop', '<b>opcode</b>=—');
              S('p1', 'active'); S('p2', ''); S('p3', ''); S('p4', '');
            },
            note: '<b>破局的唯一方向：动态记录。</b>既然解释器自己知道每条字节码干什么，那就在它分发的那一刻把 (opcode, 随后的行为) 一对对记下来。这就是下一节的映射表工程。' }
        ]
      },
      after:
        '<p>这段动画值得反复看几遍。它把「VMP 让静态失效」从一句口号，变成了一条可以指着说的因果链：' +
        '<strong>因为语义不在代码里，而在数据 + 私有约定里。</strong></p>'
    },

    /* ================= 6.3 ================= */
    {
      h: '6.3',
      title: '分发器逐行解剖：一条字节码的完整生命周期',
      html:
        '<p>把我们平时在 IDA 里看到的伪代码，换成更接近真实的形态——一段「伪装成普通函数的」分发器。' +
        '它看起来平平无奇，但它是整台虚拟机的引擎。跟着走一遍，你会对「分析锚点」这四个字有肌肉记忆。</p>' +
        T.note('key', '🔑 观察重点',
          '<p>盯住三个东西：<b>字节码指针（vm pc）怎么前进</b>、<b>opcode 怎么被取出来</b>、' +
          '<b>switch 怎么选中 handler</b>。这三个动作构成了一个可以被 hook 的「收窄点」——' +
          '所有字节码都必须从这里经过，一条都逃不掉。</p>'),

      stepper: {
        title: 'VM dispatcher：取指 → 分发 → 执行 → 回边',
        lines: [
          { code: '<span class="c">// 被保护函数的入口（vm_entry）——分析从这里开始</span>\n' +
                  '<span class="f">vm_entry</span>:',
            note: '<b>定位锚点。</b>被 VMP 保护的函数，开头不会是业务代码，而是一段「初始化虚拟机」的样板代码。它通常出现在函数的最前面，特征很扎眼：一长串寄存器保存 + 几个神秘常量载入。' },
          { code: '  <span class="k">stp</span> <span class="r">x0</span>, <span class="r">x1</span>, [<span class="r">sp</span>, <span class="n">#-0x40</span>]!   <span class="c">@ 保存真实寄存器现场</span>',
            note: '<b>为什么要保存现场？</b>因为虚拟机要用真实 CPU 寄存器来干活（r6 当字节码基址、r7 当 VMContext 基址……）。进 VM 前必须把宿主的值存起来，出 VM 时再恢复。<span class="hit">看到这种「保存一大片寄存器但没有对应业务调用」的序幕，八成是 vm_entry。</span>' },
          { code: '  <span class="k">ldr</span> <span class="r">x6</span>, [<span class="r">pc</span>, <span class="n">#0x120</span>]   <span class="c">@ x6 = 字节码流基址</span>',
            note: '<b>载入字节码流基址。</b>这个地址指向 so 的只读数据段。在 IDA 里按过去看，你会看到一片「没有被任何代码引用的字节数组」——<span class="miss">那就是字节码流</span>。它是数据，不是代码，所以任何「反编译」都读不出东西。' },
          { code: '  <span class="k">ldr</span> <span class="r">x7</span>, [<span class="r">pc</span>, <span class="n">#0x124</span>]   <span class="c">@ x7 = VMContext 基址</span>',
            note: '<b>载入 VMContext。</b>虚拟机的「寄存器组 + 状态」结构体。里面通常有：一组虚拟通用寄存器、虚拟 pc、虚拟 sp、几个标志位。它的字段布局是你要猜的第一件事——猜法见下一步。',
            state: { 'x6 (字节码基址)': '0x5A00', 'x7 (VMContext)': '0x7F31' } },
          { code: '  <span class="k">mov</span> <span class="r">x8</span>, <span class="n">#0</span>                <span class="c">@ x8 = 虚拟 pc（字节码偏移）</span>',
            note: '<b>虚拟 pc 被清零。</b>注意它是个「偏移量」而不是绝对地址——厂商常用这种方式让字节码流与基址解耦，顺便让静态分析更难把数据流串起来。',
            state: { 'x8 (vm pc)': '0x0' },
            mem: '字节码流 @0x5A00:\n1A 00 2B 01 07 3C ...' },
          { code: '<span class="f">dispatch_loop</span>:                       <span class="c">@ ← 所有 handler 都会回到这里</span>',
            note: '<b>循环顶部。</b>这是整个虚拟机里唯一「恒定不变」的位置。你在这里下断点，就能看到每一条字节码的执行。注意：有些加固会把这一小段代码复制多份并互相跳转（控制流平坦化的变体），但<b>逻辑上的回边一定存在</b>。' },
          { code: '  <span class="k">ldrb</span> <span class="r">w9</span>, [<span class="r">x6</span>, <span class="r">x8</span>]        <span class="c">@ 取指：opcode = bytecode[pc]</span>',
            note: '<b>整个 VMP 里最重要的一条指令。</b>它把「数据」变成「指令」——读取一个字节，接下来它的值将决定跳去哪里。<span class="hit">Hook 这一条指令，你就拿到了所有 opcode。</span>',
            state: { 'opcode (w9)': '0x1A', 'x8 (vm pc)': '0x0' },
            mem: '1A 00 2B 01 07 3C ...\n↑ 读这里' },
          { code: '  <span class="k">add</span> <span class="r">x8</span>, <span class="r">x8</span>, <span class="n">#1</span>             <span class="c">@ pc++（先取指后自增）</span>',
            note: '<b>pc 前进一格。</b>注意「先取指、后自增」的顺序——这是教科书式的实现，但有的厂商会反过来写（自增后取指、或取指后加一个变长长度），<span class="miss">这会直接影响你按偏移解析字节码流的正确性</span>。',
            state: { 'opcode (w9)': '0x1A', 'x8 (vm pc)': '0x1' } },
          { code: '  <span class="k">cmp</span> <span class="r">w9</span>, <span class="n">#0x2B</span>              <span class="c">@ 范围检查 / 前哨判断</span>\n' +
                  '  <span class="k">b.hi</span> <span class="f">vm_exit</span>                <span class="c">@ 超出则退出虚拟机</span>',
            note: '<b>边界检查。</b>这里藏着两个信息：<b>一是 opcode 的合法范围</b>（0x00 到 0x2B 之间，28 个操作码以内）；<b>二是退出条件</b>——vm_exit 就是虚拟机结束、恢复宿主上下文的地方。这个范围直接告诉你映射表大概有多少条要填。',
            state: { 'opcode (w9)': '0x1A', '合法范围': '0x00 ~ 0x2B' } },
          { code: '  <span class="k">adrp</span> <span class="r">x10</span>, <span class="f">handler_table</span>  <span class="c">@ 跳转表基址</span>\n' +
                  '  <span class="k">ldr</span> <span class="r">x11</span>, [<span class="r">x10</span>, <span class="r">w9</span>, <span class="k">uxtw</span> <span class="n">#3</span>]  <span class="c">@ 查表</span>\n' +
                  '  <span class="k">br</span> <span class="r">x11</span>                     <span class="c">@ 分发！</span>',
            note: '<b>分发。</b>典型的跳转表实现：以 opcode 为索引，从表里取出 handler 地址，跳过去。<span class="hit">这张表本身就是一份「opcode → handler」的目录</span>——如果它没被加密，你甚至能静态把这张表整个抠出来，把 opcode 空间一次性枚举完。',
            state: { 'handler_table': '0x4C80', '选中 handler': '→ handler_1A' },
            mem: 'handler_table:\n[0]=0x4000 [1]=0x4088\n[0x1A]=0x5000 ← 命中' },
          { code: '<span class="f">handler_1A</span>:                       <span class="c">@ 对应字节码 0x1A</span>\n' +
                  '  <span class="k">ldr</span> <span class="r">w12</span>, [<span class="r">x7</span>, <span class="n">#4</span>]        <span class="c">@ 读 VMContext+4</span>\n' +
                  '  <span class="k">str</span> <span class="r">w12</span>, [<span class="r">x7</span>, <span class="n">#0</span>]        <span class="c">@ 写 VMContext+0</span>',
            note: '<b>Handler 本体。</b>短短两条指令：把 VMContext 偏移 4 的值搬到偏移 0。<span class="miss">从这里你没法知道它是 MOV——你只知道它做了个搬运</span>。但配合下一步的上下文变化，语义就浮现了：偏移 0 和偏移 4 是两个虚拟寄存器。',
            state: { 'VMContext+0 (V0)': '← 即将被写', 'VMContext+4 (V1)': '0x1000' } },
          { code: '  <span class="k">mov</span> <span class="r">x8</span>, <span class="r">x8</span>              <span class="c">@ （可能存在的填充 / 混淆）</span>\n' +
                  '  <span class="k">b</span> <span class="f">dispatch_loop</span>          <span class="c">@ 回边，取下一个字节码</span>',
            note: '<b>回边。</b>handler 执行完，无条件跳回循环顶部。<span class="hit">这条回边就是「一条字节码执行完毕」的分界线</span>——在分发器下断点、在这条回边处收尾，你就能干净地切分出一条条字节码的行为记录。',
            state: { 'VMContext+0 (V0)': '0x1000', 'x8 (vm pc)': '0x2' } },
          { code: '<span class="c">// 结果：V0 = V1 —— 等价于 ARM 的 MOV</span>\n' +
                  '<span class="c">// 映射表新增：0x1A → 虚拟寄存器赋值</span>',
            note: '<b>映射表的第一条记录诞生了。</b>注意这个结论是怎么来的：不是读代码读出来的，是<b>观察 handler 访问了哪个偏移、上下文怎么变</b>推出来的。<span class="hit">这就是逆向 VMP 的全部方法论。</span>' },
          { code: '  <span class="k">b</span> <span class="f">dispatch_loop</span>          <span class="c">@ 0x2B 将是下一条……</span>',
            note: '<b>循环继续。</b>同一个 switch、同一个 handler 表，只是索引变了。一台虚拟机就这样把整个函数「跑」完了。',
            state: { 'x8 (vm pc)': '0x2', '下一条 opcode': '0x2B（预计）' },
            mem: '已执行：1A 00\n待执行：2B 01 07 3C ...' }
        ]
      },
      after:
        T.note('ok', '✅ 小结：三个可以下手的点',
          '<p>① <b>字节码流基址的载入处</b>——拿到数据在哪；② <b>分发器的取指指令</b>——拿到每条 opcode；' +
          '③ <b>handler 表</b>——如果未加密，直接拿到 opcode 空间的全貌。' +
          '这三个点，就是下一节「快速逆向分析方法」的全部抓手。</p>')
    },

    /* ================= 6.3L 动手实验 ================= */
    {
      h: '6.3L', title: '动手实验：当一次 VMP 分发器，还原字节码',
      html:
        '<p>VMP 分析的核心动作是：<b>把字节码流喂给分发器，逐条查出它对应哪条原始指令</b>。' +
        '这个实验让你亲手做一遍这件事。</p>',
      lab: {
        title: '实验：字节码反查原始指令',
        goal: '目标：还原字节码流的语义',
        intro:
          '<p>你从目标 so 里 dump 出一段 VM 字节码，并且已经把<b>分发器的映射表</b>扒了出来：</p>' +
          '<div class="tbl-wrap" style="margin:12px 0"><table class="tbl"><thead><tr><th>opcode</th><th>含义</th><th>对应原始指令</th></tr></thead><tbody>' +
          '<tr><td><code>0x1A</code></td><td>LOAD</td><td><code>MOV Rd, [VmContext+off]</code></td></tr>' +
          '<tr><td><code>0x2B</code></td><td>STORE</td><td><code>MOV [VmContext+off], Rs</code></td></tr>' +
          '<tr><td><code>0x3C</code></td><td>XOR</td><td><code>EOR Rd, Rn, Rm</code></td></tr>' +
          '<tr><td><code>0x4D</code></td><td>ADD</td><td><code>ADD Rd, Rn, Rm</code></td></tr>' +
          '<tr><td><code>0x5E</code></td><td>ROL</td><td><code>ROR Rd, Rn, #imm</code></td></tr>' +
          '<tr><td><code>0x6F</code></td><td>JMP</td><td><code>B target</code></td></tr>' +
          '<tr><td><code>0x70</code></td><td>CMP</td><td><code>CMP Rn, Rm</code></td></tr>' +
          '<tr><td><code>0x81</code></td><td>HLT</td><td><code>RET</code></td></tr>' +
          '</tbody></table></div>' +
          '<p>字节码流是：<code>1A 3C 5E 2B 81</code></p>' +
          '<p><b>任务：① 把它翻译成原始指令序列 ② 判断这段代码在做什么运算。</b></p>',
        inputs: [
          { key: 'seq', label: '① 翻译结果（写指令名或原始指令，用 → 分隔）',
            hint: '例如 LOAD → XOR → ...', ph: 'LOAD → ...' },
          { key: 'what', label: '② 这段代码在做什么运算？',
            hint: '想想：取值 → 异或 → 移位 → 存回，像是加密的哪一步？', ph: '它在……', type: 'textarea', rows: 2 }
        ],
        runLabel: '🔍 反查字节码',
        run: (v) => {
          const L = window.LABX;
          const ops = L.vmDisasm('1A3C5E2B81');

          let html = '<table class="lab-tbl"><tr><th>偏移</th><th>opcode</th><th>含义</th><th>原始指令</th><th>说明</th></tr>';
          ops.forEach(o => {
            html += '<tr class="' + (o.known ? 'same' : 'diff') + '">'
              + '<td>+' + o.offset + '</td><td><code>' + o.opcode + '</code></td>'
              + '<td><b>' + o.name + '</b></td><td><code>' + o.raw + '</code></td>'
              + '<td style="font-size:12px">' + o.note + '</td></tr>';
          });
          html += '</table>';

          html += '<div class="lab-msg key"><b>🔑 还原出的逻辑</b><div class="lab-note">'
            + '<code>LOAD → XOR → ROL → STORE → HLT</code><br><br>'
            + '<b>这是一个典型的"加密一轮"结构：</b><br>'
            + '① <b>LOAD</b>：从 VM 上下文取出待处理的值（明文块）<br>'
            + '② <b>XOR</b>：与密钥异或<br>'
            + '③ <b>ROL</b>：循环移位（扩散，让每个比特影响更多位置）<br>'
            + '④ <b>STORE</b>：写回上下文<br>'
            + '⑤ <b>HLT</b>：返回<br><br>'
            + '<span class="hit">XOR + 移位 是绝大多数分组密码轮函数的骨架</span>——' +
            '看到这个组合，基本可以确定这是加密逻辑，不是普通业务代码。</div></div>';

          const seq = String(v.seq || '').toUpperCase();
          const want = ['LOAD', 'XOR', 'ROL', 'STORE', 'HLT'];
          const hitCount = want.filter(w => seq.includes(w)).length;
          if (seq.trim()) {
            const ok = hitCount === 5;
            html += '<div class="lab-msg ' + (ok ? 'pass' : 'fail') + '"><b>'
              + (ok ? '✅ 翻译完全正确' : '❌ 还差 ' + (5 - hitCount) + ' 条') + '</b>'
              + '<div class="lab-note">正确序列：<b>LOAD → XOR → ROL → STORE → HLT</b><br>'
              + '注意顺序：<b>先异或再移位</b>。如果反了，结果完全不同——' +
              '这也说明<b>还原 VM 字节码时必须逐条按顺序来，不能只看指令集合</b>。</div></div>';
          }

          const what = String(v.what || '').trim();
          if (what) {
            const hit = window.AKKC_hasConcept(what, ['加密', '异或', 'xor', '移位', '轮', '轮函数', '密文', '密钥', '混淆', '扩散']);
            html += '<div class="lab-msg ' + (hit ? 'pass' : 'warn') + '"><b>'
              + (hit ? '✅ 判断正确：这是加密轮函数' : '🟡 再想想') + '</b>'
              + '<div class="lab-note">' + (hit
                  ? '你抓住了关键：<b>XOR + 移位</b>这个组合是加密算法的典型特征。'
                  : '提示：普通业务代码很少做<b>异或 + 循环移位</b>。这个组合是"混淆 + 扩散"的标准手法，'
                    + '<b>几乎只出现在加密算法里</b>。')
              + '</div></div>';
          }
          return html;
        },
        expected: (v) => {
          const seq = String(v.seq || '').toUpperCase();
          const want = ['LOAD', 'XOR', 'ROL', 'STORE', 'HLT'];
          const hit = want.filter(w => seq.includes(w)).length;
          const what = String(v.what || '');
          const hitWhat = window.AKKC_hasConcept(what, ['加密', '异或', 'xor', '移位', '轮', '轮函数', '密钥']);
          const ok = hit === 5 && hitWhat;
          return {
            ok,
            detail: ok
              ? '<b>全对。</b>字节码 <code>1A 3C 5E 2B 81</code> 还原为 ' +
                '<b>LOAD → XOR → ROL → STORE → HLT</b>，是一段典型的加密轮函数。'
              : (hit < 5 ? '<b>翻译还差 ' + (5 - hit) + ' 条。</b>正确序列：LOAD → XOR → ROL → STORE → HLT。'
                         : '<b>翻译对了，但语义判断没到位。</b>XOR + 循环移位是加密轮函数的骨架。')
          };
        },
        showAnswer:
          '【① 字节码 1A 3C 5E 2B 81 的还原】\n\n' +
          '  +0  0x1A  →  LOAD    MOV  Rd, [VmContext+off]\n' +
          '  +1  0x3C  →  XOR     EOR  Rd, Rn, Rm\n' +
          '  +2  0x5E  →  ROL     ROR  Rd, Rn, #imm\n' +
          '  +3  0x2B  →  STORE   MOV  [VmContext+off], Rs\n' +
          '  +4  0x81  →  HLT     RET\n\n' +
          '【② 这段代码在做什么】\n' +
          '  加密的一轮（轮函数）：\n' +
          '    取值 → 与密钥异或 → 循环移位 → 存回\n\n' +
          '  为什么这么判断：\n' +
          '    · XOR  —— 混淆（把明文和密钥混在一起）\n' +
          '    · 移位 —— 扩散（让一位的变化影响到更多位）\n' +
          '    这两个动作的组合是绝大多数分组密码轮函数的标准结构，\n' +
          '    普通业务代码几乎不会这样写。\n\n' +
          '【更重要的方法论】\n' +
          '  ① 顺序不能乱：先 XOR 再 ROL ≠ 先 ROL 再 XOR\n' +
          '     → 还原 VM 字节码必须逐条按序，不能只收集指令集合\n\n' +
          '  ② 遇到未知 opcode 不要慌：\n' +
          '     它可能是分发器辅助指令，也可能映射表没找全\n' +
          '     → 回分发器看它走哪个 case\n\n' +
          '  ③ 一行字节码对应一条原始指令 —— 这是"翻译"而非"反编译"\n' +
          '     VMP 的目的就是让这一步无法自动化。\n' +
          '     但只要映射表能拿到，手工也能还原关键片段。',
        hint:
          '把字节码每两个十六进制字符切一刀：<code>1A | 3C | 5E | 2B | 81</code>，' +
          '然后逐个去映射表里查。<br><br>' +
          '第②问的关键：看看这几条指令的组合——<b>取值、异或、移位、存回</b>。' +
          '普通业务代码会这么写吗？想一想异或和移位在密码学里各自起什么作用。',
        after:
          T.note('key', '🔑 这个实验真正想告诉你的',
            '<p style="margin-bottom:0">VMP 看起来很唬人——"虚拟机保护"、"自定义指令集"。' +
            '但剥开看，它的本质是<b>把"读汇编"变成了"查字典"</b>：<br><br>' +
            '原始代码：<code>EOR Rd, Rn, Rm</code> —— 你要理解 ARM 语义<br>' +
            'VM 保护后：<code>0x3C</code> —— 你只要知道它映射到 <code>EOR</code><br><br>' +
            '困难不在"理解"，而在<b>"拿到那张映射表"</b>。<br>' +
            '而映射表藏在分发器里——所以第 6 章所有技巧最终都指向同一个目标：' +
            '<b>找到分发器，理解它的分发方式，把映射表扒出来。</b><br><br>' +
            '<span class="hit">拿到映射表之后，剩下的就是自动化的苦力活（写脚本批量翻译），' +
            '不再是智力挑战。</span></p>')
      }
    },

    /* ================= 6.4C 实战案例 ================= */
    {
      h: '6.4C', title: '实战案例：七神 VMP 的框架还原',
      case: {
        source: 'kanxue',
        title: '[原创] 七神VMP真正的分析与还原',
        date: '2026-9-11',
        author: '一只鸭子（内文署名 人生导师）',
        target: '七神 App 40.2.0 的 liba.so（0x370B64）与 libb.so（0x2e01b8）',
        background:
          '<p>2026 年的一篇看雪原创帖，目标是七神 App <b>40.2.0</b> 版本的两个 so：<code>liba.so</code> 的 <code>0x370B64</code>、' +
          '<code>libb.so</code> 的 <code>0x2e01b8</code>。</p>' +
          '<p>作者给自己划了一条明确的边界：<b>只还原 VMP 框架，不还原算法</b>。' +
          '这个自我约束很关键 —— 它把目标从「看懂业务」收缩成「把解释器结构和指令语义拿到手」，' +
          '正是本章说的「先把映射表建起来」。</p>',
        points: [
          '调用链：<code>0x2e01b8</code>（OLLVM 外壳）→ <code>0x2E2B34</code> → <code>0x2E2BE8</code> → <code>0x2d3780</code> → <code>0x2E5C2C</code> → <code>0x2e66d0</code> → <code>0x2E7FE8</code>（<code>vmOneHandler</code>）。',
          '<b>锚点寄存器体系</b>：<code>x23</code>=IP/基址基准、<code>x19</code>=ctx、<code>x20</code>=字节码源、<code>x24</code>=整数虚拟寄存器文件 <code>ctx+0x6070</code>（32×8B，idx 0-31）、<code>x26</code>=<code>ctx+0x6170</code>（32 位浮点）、<code>x27</code>=<code>ctx+0x61F0</code>（64 位浮点）、<code>x25</code>=handler 表、<code>x8</code>=当前指令指针。',
          '操作数位于 <code>[x8+8]</code>/<code>[x8+9]</code>/<code>[x8+0xA]</code>；<b>指令宽度是 0x30</b> —— 这直接推翻了「一条 VM 指令 = IP+1」的假设，实测 step=3/4/5/6 才是常态。',
          'ctx 魔数 <code>0x020007060C0C0803</code>；<code>sub_2E5C68</code> 执行 <code>memset(ctx+0x6070,0,0x381)</code>。',
          'handler 表 <code>0x3E1E58</code>~<code>0x3E3708</code> 共 <b>1580 个</b>，全量 trace 实测被调用 <b>335 个</b>。',
          '返回 handler <code>0x2ebc2c</code> 由 opcode <code>0xbd</code> 分派，返回值经由 <code>ctx+0xC</code> 复用槽传递，且<b>被 32 位截断</b>。',
          '<b>锚点一律按 offset 认、不按名字</b>：<code>x23 = 0x40B8</code>，<code>w23</code>/<code>x23</code> 是 size 4/8 的两个视图；PC 锚点用 RVA 以规避 ASLR。',
          '用 <code>pypcode</code> 取全寄存器偏移；操作数线从写 STORE 反向跟 def-use；工具链是 SLEIGH/P-code，以及把 varnode <code>(space,offset,size)</code> 折叠成的「影子轨道」。'
        ],
        method: [
          '先把 OLLVM 外壳剥掉：从 <code>0x2e01b8</code> 顺着调用链一路跟到 <code>vmOneHandler</code>（<code>0x2E7FE8</code>）。',
          '锚定寄存器体系：认下 <code>x23</code>/<code>x19</code>/<code>x20</code>/<code>x24</code>/<code>x25</code>/<code>x26</code>/<code>x27</code>/<code>x8</code> 各自的角色与 offset，确定虚拟寄存器文件的三块布局。',
          '测出指令宽度：盯 IP 的实际前进量，发现是 0x30，并实测 step 落在 3/4/5/6 —— 变长指令由此确认。',
          '拿 handler 表：读 <code>0x3E1E58</code>~<code>0x3E3708</code> 共 1580 个表项，全量 trace 后统计出实际被调用 335 个。',
          '取操作数语义：用 <code>pypcode</code> 拿全寄存器偏移，操作数线从写 STORE 反向跟 def-use，再把 varnode 的 <code>(space,offset,size)</code> 折叠成「影子轨道」。',
          '全量跑一遍并验证：749 万行 trace 切段，检查每个 entry 是否都有 IR、异常是否为 0；发现切割 bug 后修正重跑，对比假段与取不到值的数量。'
        ],
        result:
          '<p>硬数字很清楚：全量 <b>749 万行 trace</b> 切出 <b>232281 段</b>、唯一 entry <b>266 个</b>，' +
          '<b>每个 entry 都有 IR</b>（合计 875 行），异常 0。</p>' +
          '<p>修掉「段未入栈」的切割 bug 之后：段数降到 <b>49243</b>、唯一 entry <b>264 个</b>，' +
          '假段 <code>0x2e6778</code> 的命中数从 37 降到 <b>0</b>，取不到值的次数从 38 降到 <b>1</b>。' +
          '两个数字的反差本身就是证据：<b>框架级的 bug 修掉之后，噪声是成片消失的，而不是零星减少。</b></p>',
        terms: ['VMP', 'vmOneHandler', 'handler 表', '字节码源', '虚拟寄存器文件', 'SLEIGH', 'P-code', 'varnode', 'pypcode', 'def-use'],
        limits:
          '<p>作者列的边界很实在，值得原样记住：</p>' +
          '<p>① <b>flags/NZCV 未记录</b> —— 控制流一旦穿透（<code>cbz</code>/<code>tbz</code>）就会卡住；' +
          '② <b>内存地址 → 值未记录</b>，访存语义只能停在「发生了什么」；' +
          '③ 最后 1 条 handler <code>0x2e837c</code> 走 <code>[x19,#0xc]</code> 寻址、只跑过 1 次，样本太少，结论待核实；' +
          '④ 用 <code>objdump</code> 找 <code>blr x23</code> 来定位入口的做法，作者自评「<b>非常非常脆弱</b>」，' +
          '而且它无法解释这个 VM 为什么能跨 so 调用；' +
          '⑤ 折叠有明确边界：解引用不折、半字节跨算不追、只比值会认错字节。</p>',
        analysis:
          '<p><b>本课第 6 章的论断是：VMP 的困难不在「理解」，而在「拿到那张映射表」。</b>' +
          '这个案例把这句话变成了工程量：难点从来不是想不通 <code>vmOneHandler</code> 在干嘛，' +
          '而是要把 1580 个 handler 表项里的 335 个实际调用、每个的虚拟寄存器偏移、每条指令的宽度，' +
          '一条条观察出来、写下来、交叉验证。 <b>749 万行 trace、232281 段、266 个唯一 entry —— 这些数字才是 VMP 的真实成本。</b></p>' +
          '<p>案例里最该刻进肌肉记忆的是这条工程铁律：<b>锚点一律按 offset 认，不按名字认。</b>' +
          '同一块寄存器在不同宽度视图下偏移完全不同（<code>x23 = 0x40B8</code>，而 <code>w23</code>/<code>x23</code> 是 size 4/8 两个视图），' +
          '你要是按反编译器的变量名去认锚点，<b>换个 handler 名字就变了，整条 trace 线立刻断掉</b>。' +
          '这正是「P-code 的 varnode 用 <code>(space,offset,size)</code> 唯一定位」的实战意义 —— 名字是给人看的，offset 才是给脚本用的。</p>' +
          '<p>第二个呼应点，是<b>「指令宽 0x30」推翻了「一条 VM 指令 = IP+1」这个直觉假设</b>。' +
          '本章反复强调不要用直觉猜 VM 结构，就是因为 VM 的取指方式、指令长度、操作数布局都是厂商私有的：' +
          '<b>凡是能实测的，就不要假设；凡是被实测推翻的假设，都要回头改脚本。</b>' +
          '这个案例里段数从 232281 掉到 49243、假段从 37 掉到 0，正是「先量、再信」的回报。</p>',
        link: 'https://bbs.kanxue.com/thread-292925.htm',
        linkNote: '看雪论坛原创帖'
      }
    },

    /* ================= 6.4 ================= */
    {
      h: '6.4',
      title: '快速逆向 VMP：把映射表建起来',
      html:
        '<p>前面说的「还原语义」，落到工程上就是一件事：<strong>构建映射表</strong>——' +
        '记录「自定义字节码指令 → 它实际执行了什么操作」的对应关系。</p>' +
        '<p>方法只有一种：<b>动态</b>。把程序跑起来，在<span class="term" data-def="解释器主循环里把 opcode 分派到 handler 的那段代码">分发器</span>处记录下当前 opcode，' +
        '然后紧接着观察它干了什么——读了哪个虚拟寄存器、写了<b>哪块内存</b>、做了什么运算、有没有访存。' +
        '一条记录 = 一个 opcode 的语义。攒够整张表，字节码流就重新变成了可读的伪代码。</p>' +
        T.note('key', '🔑 四问法：每个 opcode 只问四件事',
          '<p>不要试图「读懂 handler 的代码」，那是在读汇编。改成问四个具体问题：</p>' +
          '<p>① <b>源</b>：它读了 VMContext 里的哪几个偏移（= 用了哪几个虚拟寄存器）？<br>' +
          '② <b>目标</b>：它写了哪个偏移（= 结果放进哪个虚拟寄存器）？<br>' +
          '③ <b>运算</b>：中间做了什么？加/减/异或/移位/比较/无运算只搬运？<br>' +
          '④ <b>副作用</b>：有没有访问 VMContext 之外的地址（= 是不是 load/store）？</p>' +
          '<p>四问答完，语义基本就锁定了。<span class="hit">这是本章最实用的一段话。</span></p>') +
        T.note('warn', '⚠️ 常见坑：只记 opcode，不记操作数',
          '<p>很多人 hook 到 opcode 就以为完事了，结果发现同一个 <code>0x2B</code> 有时是「加 4」、有时是「加 0x80」、' +
          '有时甚至是「加到另一个寄存器」。<span class="miss">因为很多字节码是变长的，opcode 后面紧跟操作数字节。</span>' +
          '你必须在取指后<b>把 pc 前进的长度、以及沿途被读走的操作数一起记下来</b>，否则映射表会自相矛盾。</p>') +
        T.note('', '💡 静态辅助：别忘了那张 handler 表',
          '<p>如果加固没有加密跳转表，你在分发器里能看到 <code>ldr x11, [x10, w9, uxtw #3]</code> 这样的查表指令，' +
          '顺着 <code>x10</code> 过去就是一张完整的「opcode → handler 地址」数组。把它整张 dump 出来，' +
          '<b>你就瞬间知道了 opcode 空间的全貌</b>——哪些值合法、每个值对应哪段代码。' +
          '这让动态记录从「盲扫」变成「按图索骥」：你甚至可以直接反编译每一个 handler，逐个静态推断语义，再用动态验证。</p>'),

      stage: {
        title: '在分发器处 hook：一张映射表是怎么长出来的',
        speed: 1800,
        render:
          '<div class="flow-col">' +
            '<div class="small muted">分发器 hook 点（所有字节码的唯一必经之路）</div>' +
            '<div class="flow-row">' +
              '<span class="blk" id="hk">取指 ldrb w9,[x6,x8]</span>' +
              '<span class="arrow">→</span>' +
              '<span class="blk" id="hd">分发 switch(w9)</span>' +
              '<span class="arrow">→</span>' +
              '<span class="blk" id="hh">handler</span>' +
            '</div>' +
            '<div class="small muted" style="margin-top:12px">映射表（每跑一条字节码就多一行）</div>' +
            '<div class="memgrid">' +
              '<div class="memrow"><span class="addr">0x1A</span><span class="cell" id="c1">? ? ?</span></div>' +
              '<div class="memrow"><span class="addr">0x2B</span><span class="cell" id="c2">? ? ?</span></div>' +
              '<div class="memrow"><span class="addr">0x07</span><span class="cell" id="c3">? ? ?</span></div>' +
              '<div class="memrow"><span class="addr">0x3C</span><span class="cell" id="c4">? ? ?</span></div>' +
            '</div>' +
          '</div>' +
          '<div class="flow-row" style="margin-top:12px">' +
            '<span class="pill" id="prg">映射表进度：0 / 4</span>' +
            '<span class="pill" id="use">用途：—</span>' +
          '</div>',
        reset: () => {
          ['hk','hd','hh'].forEach(function (i) { S(i, ''); });
          ['c1','c2','c3','c4'].forEach(function (i) { CLS(i, 'cell'); SET(i, '? ? ?'); });
          CLS('prg', 'pill'); SET('prg', '映射表进度：0 / 4');
          CLS('use', 'pill'); SET('use', '用途：—');
        },
        steps: [
          { run: () => { S('hk', 'active'); S('hd', 'active'); S('hh', 'active'); },
            note: '<b>先把 hook 挂上。</b>位置选在分发器——这是全文唯一「每条字节码都必须经过」的地方。挂在这里，一条都不会漏；挂在别处，你永远在担心漏了哪些。' },
          { run: () => { S('c1', 'hi'); SET('c1', '读取中…'); },
            note: '<b>字节码 0x1A 命中了。</b>记录下 opcode，紧接着观察 handler 干了什么。<span class="miss">注意：这里不是反编译，是「观察行为」</span>——你只需要看它碰了哪几个地址。' },
          { run: () => { S('c1', 'wr'); SET('c1', 'V0 = V1  （无运算，纯搬运）'); S('hh', 'done'); },
            note: '<b>第一条记录完成。</b>观察结论：读 VMContext+4、写 VMContext+0、中间没有任何算术指令。四问法的答案指向「赋值搬运」——等价于 <code>MOV</code>。',
            state: { '0x1A': 'MOV（等价）' } },
          { run: () => { CLS('prg', 'pill warn'); SET('prg', '映射表进度：1 / 4'); S('c1', 'cool'); S('hd', 'active'); },
            note: '<b>进度 1/4。</b>现在你已经能把字节码流里所有的 <code>0x1A</code> 翻译回 <code>MOV</code> 了。<span class="hit">映射表的价值在于它是「一次投入、全程序复用」的。</span>' },
          { run: () => { S('c2', 'hi'); SET('c2', '读取中…'); },
            note: '<b>下一条 0x2B。</b>同样的流程。注意观察这次 handler 多读了一个东西——操作数。<b>变长字节码的问题在这里第一次暴露。</b>' },
          { run: () => { S('c2', 'wr'); SET('c2', 'V0 = V0 + 立即数  （读了操作数）'); S('c1', 'done'); },
            note: '<b>第二条记录。</b>读 VMContext+0、加一个来自字节码流的立即数、写回 VMContext+0。等价 <code>ADD</code>。同时你还<b>顺带量出了这条指令的长度</b>——下次解析字节码流时不会错位。',
            state: { '0x1A': 'MOV（等价）', '0x2B': 'ADD 立即数（等价）' } },
          { run: () => { CLS('prg', 'pill warn'); SET('prg', '映射表进度：2 / 4'); S('c2', 'cool'); S('c3', 'hi'); SET('c3', '读取中…'); },
            note: '<b>0x07 来了——这次不一样。</b>前两条只碰 VMContext，这一条的 handler 会拿虚拟寄存器的值<b>当地址用</b>，去访问 VMContext 之外的内存。' },
          { run: () => { S('c3', 'wr'); SET('c3', 'V2 = [V0]  （发生访存！）'); },
            note: '<b>关键判别点：有没有访存。</b>只要 handler 里出现「用 VM 寄存器值作为地址的 load」，它就是 <code>LDR</code> 家族。<span class="hit">这一步把「纯运算」和「内存访问」两类指令彻底分开了。</span>',
            state: { '0x07': 'LDR（等价）' } },
          { run: () => { CLS('prg', 'pill warn'); SET('prg', '映射表进度：3 / 4'); S('c3', 'cool'); S('c4', 'hi'); SET('c4', '读取中…'); S('hh', 'active'); },
            note: '<b>0x3C。</b>同样发生访存，但要看清方向：是读还是写。方向搞反，翻译出来的伪代码会面目全非。' },
          { run: () => { S('c4', 'wr'); SET('c4', 'V0 → [V3]  （写内存）'); S('hh', 'done'); },
            note: '<b>第四条记录。</b>写方向 = <code>STR</code>。到这里，一个真实的函数用到的四种指令全部归位。',
            state: { '0x1A': 'MOV（等价）', '0x2B': 'ADD 立即数（等价）', '0x07': 'LDR（等价）', '0x3C': 'STR（等价）' } },
          { run: () => { CLS('prg', 'pill ok'); SET('prg', '映射表进度：4 / 4 ✅'); ['c1','c2','c3','c4'].forEach(function (i) { S(i, 'cool'); }); },
            note: '<b>表建成了。</b>四条记录，覆盖了这个函数用到的全部 opcode。<span class="hit">实测中一个真实 App 的核心函数通常只需要几十条记录就能还原</span>——因为编译器生成的指令种类是有限的，反复出现的就那么些。' },
          { run: () => { S('hk', 'hot'); S('hd', 'hot'); CLS('use', 'pill ok'); SET('use', '用途：字节码流 → 可读伪代码'); },
            note: '<b>最后一公里：回填。</b>拿着这张表，把字节码流一段段翻译成 <code>MOV/ADD/LDR/STR</code> 序列，再丢给反编译器——<b>你就把 VMP 退化成了普通 ARM 代码</b>。这一步可以写脚本自动化，但表的正确性必须靠动态记录保证。' },
          { run: () => { S('hk', 'done'); S('hd', 'done'); },
            note: '<b>回头看代价。</b>整个过程没有「理解一段天书般的混淆代码」，只有「观察 + 记录 + 归纳」。<span class="miss">VMP 的强度来自信息不对称，而不是算法复杂度——一旦你补上信息，它就只是一层壳。</span>' }
        ]
      },

      stepper: {
        title: 'hook 一件真实的事：记录一条 opcode 的完整流程',
        lines: [
          { code: '<span class="c">// 目标：在分发器处，为每个 opcode 采集四问法的答案</span>\n' +
                  '<span class="f">on_enter</span>(dispatch_addr):',
            note: '<b>为什么挂 enter 而不是手写 <code>case</code>？</b>因为你不知道 opcode 有多少个、也不知道 handler 在哪。挂在下断点处，等于让 VMP 自己把每条字节码喂给你。' },
          { code: '  <span class="r">op</span> = <span class="f">read_u8</span>(<span class="r">x6</span> + <span class="r">x8</span>)     <span class="c">// 从字节码流读出当前 opcode</span>',
            note: '<b>取指复现。</b><code>x6</code> 是字节码流基址、<code>x8</code> 是虚拟 pc——这两个寄存器是你在 vm_entry 里就已经确认过的。这里读到的值和解释器接下来要处理的值<b>必然一致</b>。',
            state: { 'x6 (bytecode base)': '0x5A00', 'x8 (vm pc)': '0x00', 'op': '0x1A' },
            mem: '0x5A00: 1A 00 2B 01 07 3C\n        ↑ pc' },
          { code: '  <span class="f">log_row</span>(<span class="r">op</span>, <span class="r">x8</span>)          <span class="c">// 先占位：opcode + 它在流中的偏移</span>',
            note: '<b>先记「存在」，再记「含义」。</b>把 (opcode, 偏移) 先落盘，哪怕语义还不知道。这样即使程序崩溃，你也知道哪里没采完——<span class="hit">采集的健壮性比采集的完整性更重要</span>。' },
          { code: '  <span class="f">snapshot</span>(<span class="r">vmctx</span>)        <span class="c">// 快照：VMContext 全量（或前 N 个字段）</span>',
            note: '<b>快照是四问法的原始素材。</b>VMContext 不大（通常几十到几百字节），整体快照成本可控。后面用「前后 diff」就能自动算出读了哪些、写了哪些。',
            state: { '快照 1 (V0~V3)': 'V0=0 V1=0x1000 V2=? V3=?' } },
          { code: '  <span class="f">resume</span>()                     <span class="c">// 放行：让真正的 handler 去执行</span>',
            note: '<b>关键：不要改变执行。</b>记录必须是只读的旁观。任何对寄存器、内存的修改都可能让程序走进不同的分支，采出来的表就不可信了。' },
          { code: '  <span class="k">wait</span> <span class="f">until</span> <span class="f">back_edge</span>(dispatch_addr)  <span class="c">// 等它执行完回到循环顶部</span>',
            note: '<b>用回边切分记录。</b>「handler 执行完跳回取指处」这一跳，就是一条字节码的结束标志。等到这个信号，再收尾。' },
          { code: '  <span class="f">snapshot</span>(<span class="r">vmctx</span>)        <span class="c">// 快照 2</span>',
            note: '<b>第二次快照。</b>现在你手上有了「执行前」和「执行后」两份 VMContext。',
            state: { '快照 2 (V0~V3)': 'V0=0x1000 V1=0x1000 V2=? V3=?' } },
          { code: '  <span class="f">diff</span>(<span class="f">snapshot1</span>, <span class="f">snapshot2</span>)      <span class="c">// 问题①源 ②目标 一次算出</span>\n' +
                  '  <span class="c">// 结果：写入 V0，其余未变 → 目标 = V0</span>',
            note: '<b>diff 出「目标」。</b>哪个字段变了，就是写目标。这一步几乎不需要人脑——<b>四问法的①②可以自动算出来</b>。',
            state: { '变化的字段': 'VMContext+0 (V0)', '差异值': '0 → 0x1000' } },
          { code: '  <span class="c">// 问题③运算：对比 handler 内部是否出现 ALU 指令</span>\n' +
                  '  <span class="c">// 结果：无 add/sub/eor → 纯搬运</span>',
            note: '<b>「运算」要靠读一眼 handler 的指令类型。</b>看有没有算术/逻辑指令；有就看是加法还是异或。<span class="miss">这一步是半自动的，但 handler 通常极短，肉眼扫一眼就够。</span>',
            state: { 'handler 长度': '约 4 条指令', 'ALU 指令': '无' } },
          { code: '  <span class="c">// 问题④副作用：handler 期间是否发生 VMContext 之外的访存</span>\n' +
                  '  <span class="c">// 结果：无 → 不是 load/store</span>',
            note: '<b>「副作用」决定它是不是访存指令。</b>监视 handler 执行期间的所有内存访问，只要目标地址落在 VMContext 之外，就是 load/store。<b>方向（读/写）决定了 LDR 还是 STR。</b>' },
          { code: '  <span class="f">emit</span>(<span class="s">"0x1A"</span>, <span class="s">"V0 = V1"</span>, <span class="s">"MOV"</span>, <span class="r">len</span>=<span class="n">1</span>)  <span class="c">// 写入映射表</span>',
            note: '<b>记录落地。</b>顺便把「指令长度」也存进去——解析字节码流时全靠它，否则遇到变长指令会整体错位，后面全盘皆错。',
            state: { '映射表': '0x1A → MOV (len 1)' },
            mem: 'map.tbl:\n0x1A | V0 = V1   | MOV | len 1' },
          { code: '  <span class="k">goto</span> <span class="f">on_enter</span>          <span class="c">// 下一条字节码……</span>',
            note: '<b>循环。</b>整套流程对每一条字节码重复一次。<span class="hit">跑完一个被保护函数，你就拿到了它需要的全部记录；跑完全部功能路径，映射表就基本完整了。</span>',
            state: { '映射表': '0x1A → MOV (len 1)', '下一步 pc': '0x01 (op 0x00?)' } }
        ]
      },
      after:
        T.note('ok', '✅ 出问题往哪查',
          '<p>映射表建得不对，症状很好认：<b>翻译出来的伪代码逻辑不通</b>（比如循环条件恒真、地址计算差一个常数、' +
          '字符串指针错位）。按这个顺序查：① 指令长度是不是量错了（最常见）；② VMContext 里的字段偏移是不是搞错了' +
          '（比如把 V0/VMContext+0 记成了 +8）；③ 有没有漏掉「同一个 opcode 在不同上下文下语义不同」的多态设计；' +
          '④ handler 里是否有你没监视到的访存（比如通过别的寄存器间接访问）。</p>')
    },

    /* ================= 6.5 ================= */
    {
      h: '6.5',
      title: 'ADVMP 源码分析：从可读实现理解 VMP 内部机制',
      html:
        '<p>真实的商业 VMP 是「混淆 + 反调试 + 私有约定」的三重叠加，直接读懂成本极高。' +
        '更聪明的做法是先拿一个<strong>开源实现</strong>把机制吃透：<b>ADVMP</b> 就是这样一个开源 VMP 实现，' +
        '把 VMP 的每一个部件都用可读的代码写了一遍。</p>' +
        '<p><span class="pill warn">待核实</span> ADVMP 的仓库地址与最新版本请自行搜索确认——' +
        '课程只把它当作「理解内部机制的抓手」，不依赖具体某个 commit。</p>' +
        T.note('key', '🔑 为什么值得花时间读开源实现',
          '<p>因为 VMP 的<b>骨架是通用的</b>：任何实现都逃不掉「翻译器 + 字节码流 + vm_entry + 分发器 + handler + VMContext」这套结构。' +
          '你在开源实现上搞懂了这套骨架的每个关节，再去看商业 VMP，就只剩「哪里被混淆了、哪里被反调试了」的差异，' +
          '<span class="hit">而不再是「这是什么东西」的茫然</span>。</p>') +
        T.tbl(['部件', '在开源实现里长什么样', '迁移到商业 VMP 时你要找的东西'], [
          ['翻译器（translator）',
           '一个把原始指令（或 ARM 汇编写法）逐条映射成自定义字节码的工具，规则由一张 opcode 表决定',
           '商业产品不会给你翻译器。但你要找的是<b>同一张 opcode 表</b>——它通常就编码在分发器的跳转表或 handler 的排列里'],
          ['字节码流',
           '编译期生成好的字节数组，可能嵌在代码段或单独的数据段',
           '商业实现常常<b>运行时才解密/自解码</b>。静态找不到是正常的，要在 vm_entry 之后的内存里找'],
          ['vm_entry',
           '一段明确的初始化函数：建 VMContext、设 pc=0、把参数搬进虚拟寄存器',
           '这是你<b>第一个落脚点</b>。被保护函数开头的「保存现场 + 载入几个常量」就是它'],
          ['分发器（dispatcher）',
           '一个直白的 <code>while + switch</code>，可读性极好',
           '会被打散、混淆、甚至复制成多份。但<b>「读 opcode → 跳 handler」的语义环必须保留</b>，那就是 hook 点'],
          ['handler',
           '一个 <code>case</code> 分支，通常十几行 C 代码，语义一目了然',
           '编译成汇编后被混淆，但依然只有几到十几条指令。<b>用四问法而不是阅读法</b>去处理它'],
          ['VMContext',
           '一个结构体定义，字段名清清楚楚',
           '是块裸内存。<b>字段布局靠动态 diff 猜</b>——这是最费时但也最有价值的一步']
        ]) +
        T.note('', '🛠️ 建议的阅读顺序（从骨架到血肉）',
          '<p>① 先只读 <b>分发器主循环</b>——把「取指 → 分发 → 回边」看死；<br>' +
          '② 再读 <b>一两个 handler</b>，对照它读写的 VMContext 字段，理解「一条字节码 = 一个原子操作」；<br>' +
          '③ 然后读 <b>vm_entry</b>，搞清上下文怎么保存、参数怎么进虚拟机；<br>' +
          '④ 最后读 <b>翻译器与 opcode 表</b>，理解字节码是怎么被生成的。<br>' +
          '<span class="hit">这个顺序和你在真实目标上的分析顺序完全一致</span>——所以读开源实现不是「学习」，是<b>预演</b>。</p>') +
        T.note('warn', '⚠️ 常见坑：把开源实现当成「商业 VMP 的简化版」去套',
          '<p>骨架一样，但有三处差异会让照搬失效：<br>' +
          '① <b>opcode 编码不同</b>，没有任何可比性，别指望 <code>0x1A</code> 在别处也是 MOV；<br>' +
          '② 商业实现常用<b>多态/加密 handler</b>——同一 opcode 在不同位置语义可能不同，甚至每次都从加密表解出一个新的跳转目标；<br>' +
          '③ <b>反调试</b>是开源实现基本没有、而商业产品投入最重的部分。<br>' +
          '所以：<b>学机制，不要抄结论。</b></p>') +
        T.note('', '🎯 这对逆向实战有什么用',
          '<p>它让你在真正遇到 VMP 之前，就已经知道「要采集什么数据、要记录哪些字段、表格该长什么样」。' +
          '更重要的是：你可以<b>改开源实现来做实验</b>——给 handler 加日志、把 opcode 表打印出来、' +
          '故意做一个多态 handler 看自己还能不能采出来。<span class="hit">在可控环境里把方法论练熟，再去打真目标。</span></p>'),
      after:
        '<p>下一节换一个话题：厂商在 VMP 之外还堆了<strong>反调试</strong>。它是动态分析的直接对手——' +
        '而我们对它的回应，将把战场从用户态一路拉到 Hypervisor。</p>'
    },
    /* ================= 6.6 ================= */
    {
      h: '6.6',
      title: '反调试：动态分析的第一个对手',
      html:
        '<p>映射表工程完全建立在「把程序跑起来」之上——所以厂商的第一反应就是<b>不让你跑</b>。' +
        '这一节先看清反调试都在哪儿下手，再看一条比「对抗」更彻底的思路。</p>' +
        T.tbl(['检测层', '常见手法', '它在找什么'], [
          ['native 层',
           '监控 <code>pthread_create</code>；扫描 <code>/proc/self/maps</code> 找注入的 so；' +
           '用 <code>fopen</code>/<code>open</code> 探测特定文件路径是否存在；读 <code>/proc/self/status</code> 的 <code>TracerPid</code>',
           '有没有 frida / xposed 这类注入痕迹，有没有被 ptrace 附着'],
          ['ART 层',
           '检查方法是否被 hook、检查 dex 是否被替换、检查调用栈里有没有异常帧',
           'Java 层是否被人动过手脚'],
          ['自校验',
           '对代码段算校验和，发现与预期不符就退出；检查关键函数开头有没有被下断点',
           '内存有没有被改动过——<b>这一条后面会变成关键</b>'],
          ['反注入',
           '校验加载的 so 列表、校验 ART 内部结构、检测 map 文件里的陌生段',
           '是不是有第三方框架住进了自己进程']
        ]) +
        T.note('warn', '⚠️ 对抗反调试的常规思路，为什么越走越窄',
          '<p>面对上面这些检测，常规做法是「<b>见招拆招</b>」：frida 换个端口绕过字符串检测、hook 掉 ' +
          '<code>fopen</code> 让它读不到文件、用 magisk 隐藏 root、改 <code>TracerPid</code> 的读取……</p>' +
          '<p>问题在于：<b>这是防御方的主场</b>。你绕过一条，厂商下个版本再加三条；你永远在追。</p>' +
          '<p>更根本的是：只要你的调试器还住在<b>同一个进程</b>里、或者还依赖 <code>ptrace</code>，' +
          '你就没有脱离对方的观测范围。<span class="miss">你是在对方的摄像头底下做小动作。</span></p>') +
        T.note('key', '🔑 换思路：与其绕过检测，不如让检测代码不存在',
          '<p><b>定制 ART</b> 提供的是完全不同的解法。既然反调试逻辑很多就写在 ART 源码里' +
          '（或依赖 ART 提供的接口来收集信息），那就<b>直接改源码</b>——' +
          '从「生成侧」把这些检测逻辑跳过去。</p>' +
          '<p>比如：把检测 <code>TracerPid</code> 的那段逻辑改掉、把探测注入 so 的遍历剪掉、' +
          '把可疑文件的可见性抹掉。<span class="hit">不是对抗检测，而是让检测代码根本不存在。</span></p>' +
          '<p>这是「<b>改环境</b>」的思路，而不是「<b>躲检测</b>」的思路——主动权第一次回到分析者手里。</p>') +
        T.grid(2, [
          T.card('对抗式（常规）',
            '<p>App 检测 → 我绕过 → App 升级检测 → 我再绕过 → ……</p>' +
            '<p class="small">在对方定义的战场上打消耗战。每一轮都要重新研究，<b>成本随版本线性增长</b>。</p>'),
          T.card('改环境式（定制 ART / 定制内核 / Hypervisor）',
            '<p>检测代码从源头消失，或者检测所依赖的「观测能力」被拿掉。</p>' +
            '<p class="small">一次性投入，长期有效。<b>成本前置，但收益是复用的。</b></p>')
        ]) +
        T.note('', '🎯 这对逆向实战有什么用',
          '<p>当你发现自己在反复处理同一类反调试检测时，<b>该停止写 hook 脚本了</b>——' +
          '那说明你选错了层级。往上（定制 ART）或往下（定制内核 / Hypervisor）走一层，' +
          '常常能让整整一类问题消失。本章剩下的篇幅全部在讲「往哪走、怎么走」。</p>')
    },

    /* ================= 6.7 ================= */
    {
      h: '6.7',
      title: '三个调试层级：为什么要把调试器藏到 EL2',
      html:
        '<p>ARM 的虚拟化扩展把软件分成几个特权层级，叫 <strong>Exception Level（异常级别）</strong>。' +
        '把它记成一张四层的楼：</p>' +
        T.tbl(['层级', '谁住在这里', '能力和限制'], [
          ['<b>EL0</b>', '用户态应用、你的 App', '权限最低。调试 App 通常就在这一层（frida 注入、ptrace 附着）'],
          ['<b>EL1</b>', 'Guest OS 内核（Android/Linux kernel）', '能管页表、能拦系统调用。定制内核调试器住这里'],
          ['<b>EL2</b>', 'Hypervisor（虚拟机监控器 VMM）', '比内核更底层。<b>能控制 Guest 的地址翻译，而 Guest 看不到它</b>'],
          ['<b>EL3</b>', 'Secure Monitor（ARM TrustZone）', '最高层，负责安全世界与普通世界的切换。一般不作调试用途']
        ]) +
        T.tbl(['调试方式', '所在层', '怎么实现内存断点', '反调试能否发现'], [
          ['frida / ptrace 附着', 'EL0（同一进程）',
           '改内存写入断点指令（软件断点），或依赖硬件调试寄存器',
           '<span class="bad">能。</span>检查函数首字节、算代码段校验和、读 <code>TracerPid</code>，都很容易抓到'],
          ['定制内核调试器', 'EL1（Guest 内核）',
           '仍要修改 Guest 内存 / 挂异常处理；但可以把 <code>TracerPid</code> 之类信息藏起来',
           '<span class="miss">部分能。</span>进程级痕迹可以抹掉，<b>但内存确实被改了，校验和照样能抓到</b>'],
          ['Hypervisor（Hyperpwn）', 'EL2（Guest 之外）',
           '<b>通过 stage-2 页表做访问控制，不修改 Guest 内存一个字节</b>',
           '<span class="hit">不能。</span>Guest 视角里什么都没发生']
        ]) +
        T.note('key', '🔑 本章最关键的技术洞察',
          '<p>反调试检测内存断点的套路，全部建立在同一个前提上：<b>断点要在目标内存里留下痕迹</b>。' +
          '软件断点改内存（ARM 上插入 <code>BRK</code> 之类的断点指令），于是函数首字节对不上、校验和变了；' +
          '硬件断点用调试寄存器，于是寄存器状态可查。</p>' +
          '<p>而 hypervisor 在 EL2 做的是另一件事：它用 <b>stage-2 页表</b>（第二级地址翻译，' +
          '负责把<b>Guest 物理地址</b>翻译成<b>真实物理地址</b>）给目标页打上权限标记。' +
          '程序访问那块内存时，CPU 在翻译阶段就抛出异常，被 EL2 截获。</p>' +
          '<p><span class="hit">关键：Guest 内存的内容一个字节都没变。</span>' +
          '所以所有「检查内存有没有被改写」的手段——比对函数开头有没有断点指令、算代码段校验和、' +
          '扫调试寄存器——<b>统统发现不了</b>。这是纯硬件隔离的访问控制，<b>Guest 完全不可见</b>。</p>') +
        T.note('warn', '⚠️ 别把「藏得深」理解成「绝对安全」',
          '<p>Hypervisor 调试绕过的是一大类<b>内存完整性检测</b>。但从原理上讲，' +
          'Guest 仍然可以通过<b>时间侧信道</b>（测量某段代码的执行耗时是否异常）、' +
          '或检测 hypervisor 必然留下的某些系统级痕迹来尝试发现异常。' +
          '具体哪些手段在特定设备上可行，取决于实现细节，<span class="pill warn">待核实</span>。' +
          '务实的态度是：<b>EL2 把「发现调试器」这件事的成本从「几行代码」抬高到了「需要专门针对 hypervisor 做检测」</b>——' +
          '绝大多数商业加固根本不做这一步。</p>'),

      stage: {
        title: '同一件事，三个层级：反调试能看见什么',
        speed: 1750,
        render:
          '<div class="flow-row" style="align-items:flex-start">' +
            '<div style="flex:1">' +
              '<div class="small muted">EL0 · 用户态</div>' +
              '<div class="blk" id="a0">调试器住在 App 进程里</div>' +
              '<div class="blk" id="b0">往目标内存写断点指令</div>' +
              '<div class="blk" id="c0">TracerPid 暴露附着</div>' +
              '<div class="pill" id="s0">反调试：—</div>' +
            '</div>' +
            '<div style="flex:1">' +
              '<div class="small muted">EL1 · 内核态</div>' +
              '<div class="blk" id="a1">调试器住在 Guest 内核</div>' +
              '<div class="blk" id="b1">仍要改 Guest 内存</div>' +
              '<div class="blk" id="c1">TracerPid 可以抹掉</div>' +
              '<div class="pill" id="s1">反调试：—</div>' +
            '</div>' +
            '<div style="flex:1">' +
              '<div class="small muted">EL2 · Hypervisor</div>' +
              '<div class="blk" id="a2">调试器住在 Guest 之外</div>' +
              '<div class="blk" id="b2">stage-2 页表拦截访问</div>' +
              '<div class="blk" id="c2">Guest 内存不受影响</div>' +
              '<div class="pill" id="s2">反调试：—</div>' +
            '</div>' +
          '</div>' +
          '<div class="small muted" style="margin-top:14px">被保护函数首 4 字节（反调试会算它的校验和）—— 三个层级下各自看到的内容</div>' +
          '<div class="memgrid"><div class="memrow">' +
            '<span class="addr">EL0 看到</span><span class="cell" id="m0">AA 01 7F 3C</span>' +
            '<span class="addr">EL1 看到</span><span class="cell" id="m1">AA 01 7F 3C</span>' +
            '<span class="addr">EL2 看到</span><span class="cell" id="m2">AA 01 7F 3C</span>' +
          '</div></div>' +
          '<div class="flow-row" style="margin-top:10px">' +
            '<span class="pill" id="sum">校验和比对：—</span>' +
            '<span class="pill" id="trace">TracerPid 检测：—</span>' +
          '</div>',
        reset: () => {
          ['a0','b0','c0','a1','b1','c1','a2','b2','c2'].forEach(function (i) { S(i, ''); });
          ['s0','s1','s2'].forEach(function (i) { CLS(i, 'pill'); SET(i, '反调试：—'); });
          ['m0','m1','m2'].forEach(function (i) { CLS(i, 'cell'); SET(i, 'AA 01 7F 3C'); });
          CLS('sum', 'pill'); SET('sum', '校验和比对：—');
          CLS('trace', 'pill'); SET('trace', 'TracerPid 检测：—');
        },
        steps: [
          { run: () => { S('a0', 'active'); CLS('trace', 'pill warn'); SET('trace', 'TracerPid 检测：反调试正在读 /proc/self/status'); },
            note: '<b>最熟悉的场景：EL0 用户态调试。</b>frida 注入进程、或用 ptrace 附着。反调试只要读一眼 <code>/proc/self/status</code> 里的 <code>TracerPid</code>，就知道自己被附着了。' },
          { run: () => { S('a0', 'done'); S('b0', 'active'); CLS('sum', 'pill bad'); SET('sum', '校验和比对：❌ 不一致，函数首字节被改过'); S('m0', 'wr'); SET('m0', 'AA 01 <b>00 00</b>'); },
            note: '<b>软件断点必然改内存。</b>要在某个地址停下来，最直接的办法就是把那里的指令换成断点指令。<span class="bad">内存一旦被改，代码段校验和立刻对不上。</span>' },
          { run: () => { S('b0', 'done'); S('c0', 'active'); CLS('s0', 'pill bad'); SET('s0', '反调试：全部看得见 ❌'); },
            note: '<b>EL0 的结论：完全暴露。</b><code>TracerPid</code> 能查、断点指令能查、校验和能算、调试寄存器能读。反调试在这里几乎是无敌的——因为你的调试器就在对方的观测范围里。' },
          { run: () => { S('a1', 'active'); CLS('trace', 'pill warn'); SET('trace', 'TracerPid 检测：已被内核层抹掉，读不到'); },
            note: '<b>往上走一层：定制内核。</b>把调试器做进 EL1 的内核里。这一层能管页表、能改系统调用的返回值，于是 <code>TracerPid</code> 这类<b>进程级痕迹可以被藏起来</b>。' },
          { run: () => { S('a1', 'done'); S('b1', 'active'); S('m1', 'wr'); SET('m1', 'AA 01 <b>00 00</b>'); CLS('sum', 'pill bad'); SET('sum', '校验和比对：❌ 仍然不一致'); },
            note: '<b>但核心问题没解决。</b>内核层实现内存断点，本质上还是要<b>改 Guest 内存</b>（或依赖异常处理留下可观测的痕迹）。' +
                  '<span class="miss">校验和这一关过不去——而校验和恰恰是 VMP 加固最爱用的自保护手段。</span>' },
          { run: () => { S('b1', 'done'); S('c1', 'active'); CLS('s1', 'pill warn'); SET('s1', '反调试：部分看得见 ⚠️'); },
            note: '<b>EL1 的结论：部分可见。</b>进程级检测被抹掉了，但「内存完整性」这一类检测依然有效。你的调试器还在对方的可观测世界里。' },
          { run: () => { S('a2', 'active'); CLS('trace', 'pill ok'); SET('trace', 'TracerPid 检测：Guest 根本没被附着'); },
            note: '<b>再往下一层：EL2 Hypervisor。</b>把调试器做成一个跑在 Guest 之外的轻量 hypervisor，目标 Android 系统完整地跑在虚拟机里。' +
                  '<span class="hit">从 Guest 的角度看，根本没有调试器附着过——因为调试器不在这个「世界」里。</span>' },
          { run: () => { S('a2', 'done'); S('b2', 'active'); },
            note: '<b>内存断点在这里换了实现方式。</b>不再往内存里写任何东西，而是配置 <b>stage-2 页表</b>——ARM 虚拟化下的第二级地址翻译，把 Guest 物理地址映射到真实物理地址。' },
          { run: () => { S('b2', 'hot'); },
            note: '<b>关键是权限位。</b>stage-2 页表的每一项除了地址，还带访问权限。把目标页的权限收紧（比如对某次写访问标记为不允许），' +
                  '<span class="hit">程序一碰这块内存，CPU 在翻译阶段就抛异常，直接陷进 EL2。</span>断点就这样生效了——<b>而那块内存本身纹丝未动</b>。' },
          { run: () => { S('b2', 'done'); S('c2', 'active'); CLS('sum', 'pill ok'); SET('sum', '校验和比对：✅ 完全一致，内存没被改过'); },
            note: '<b>决定性的一刻。</b>反调试辛辛苦苦算出来的校验和，和预期值<b>完全一致</b>。<span class="hit">因为 hypervisor 从头到尾没改过一个字节。</span>' },
          { run: () => { S('c2', 'done'); CLS('s2', 'pill ok'); SET('s2', '反调试：全部看不见 ✅'); S('m2', 'rd'); },
            note: '<b>EL2 的结论：不可见。</b>三类经典检测全部落空——<code>TracerPid</code> 干净、内存校验和一致、调试寄存器没被动过。' +
                  '<span class="miss">反调试代码在老老实实地工作，只是它检测的东西根本不存在。</span>' },
          { run: () => { CLS('s2', 'pill ok'); SET('s2', '反调试：不可见 ✅✅'); S('b2', 'hot'); S('c2', 'hot'); },
            note: '<b>总结这张对比图。</b>调试层级每下沉一层，你能观测的东西就多一圈，而对方能观测你的东西就少一圈。' +
                  '<b>当你的调试器比目标更底层时，对方的反调试手段就成了对着空气挥拳。</b>' }
        ]
      },
      after:
        '<p>这张图值得截图存下来。以后每次被反调试卡住，先问自己一句：<strong>我现在在哪一层？</strong></p>'
    },

    /* ================= 6.8 ================= */
    {
      h: '6.8',
      title: 'Hyperpwn：把调试器藏到 Hypervisor 层',
      html:
        '<p>原理讲完，接下来是工具。<strong>Hyperpwn</strong> 是一套基于 Hypervisor 的调试方案：' +
        '利用 ARM 虚拟化扩展（EL2）运行一个轻量 hypervisor，把目标 Android 系统跑在虚拟机里，' +
        '然后<b>从 EL2 层做内存断点与指令追踪</b>。</p>' +
        T.note('key', '🔑 它的工作模型',
          '<p>① 设备启动时，先把一个<b>轻量 hypervisor</b> 放到 EL2；<br>' +
          '② Android 系统以 Guest 的身份跑在它上面（仍然是一个完整的、没被改过的系统）；<br>' +
          '③ 你在宿主机/另一台机器上通过它的调试接口，对 Guest 内存设置<b>访问断点</b>；<br>' +
          '④ 断点由 stage-2 页表实现——<b>命中时是 EL2 收到陷阱，Guest 毫无察觉</b>；<br>' +
          '⑤ 于是你可以在「VMP 正在跑」的时候，观察它到底访问了哪些内存、执行到哪一步。</p>' +
          '<p><span class="pill warn">待核实</span> Hyperpwn 的具体部署命令、支持的设备与内核版本，请以官方文档为准——' +
          '不同设备/内核版本差异较大，本节只描述通用的工作流。</p>') +
        T.grid(2, [
          T.card('传统 EL0 调试在 VMP 场景下的困境',
            '<p>· 断点要改内存 → 校验和报警 → App 退出<br>' +
            '· ptrace 附着 → <code>TracerPid</code> 暴露<br>' +
            '· 注入框架 → <code>/proc/self/maps</code> 里多出陌生段<br>' +
            '· 加壳的自校验又会反过来定位你的 hook</p>' +
            '<p class="small">在你还没建好映射表之前，就已经被请出去了。</p>'),
          T.card('Hyperpwn 为什么适合打 VMP',
            '<p>· <b>不改 Guest 内存</b>——校验和自校验彻底失效<br>' +
            '· <b>观测点在全程序最底层</b>——连内核都看不到你<br>' +
            '· <b>可追踪指令与访存</b>——正好对上映射表工程的采集需求<br>' +
            '· <b>反调试的检测面被拿掉</b>——它要检测的东西不存在</p>' +
            '<p class="small">换句话说：它是为「必须动态跑起来才能分析」的目标量身定做的。</p>')
        ]),

      term: {
        title: '工作流：从确认环境到设下第一个 EL2 内存断点',
        lines: [
          { t: 'p', s: 'adb devices', note: '<b>第一步永远是确认设备连上了。</b>这一步很笨，但跳过它的代价是后面所有命令都报同一句错。' },
          { t: 'o', s: 'List of devices attached\n0123456789ABCDEF\tdevice' },
          { t: 'p', s: 'adb root && adb shell', note: '<b>要动内核/Hypervisor，root 是前提。</b>user 版本固件通常锁死；建议直接用工程机或可解锁的测试机。' },
          { t: 'o', s: 'restarting adbd as root\n# ' },
          { t: 'p', s: 'uname -a', note: '<b>先看架构和内核版本。</b>只有 64 位 ARM（aarch64）设备才谈得上 EL2 虚拟化调试；内核版本还决定了 hypervisor 能否适配。' },
          { t: 'o', s: 'Linux localhost 5.x.x-androidxx aarch64 ...' },
          { t: 'p', s: 'cat /proc/cpuinfo | head -30', note: '<b>确认 CPU 的虚拟化能力是否暴露。</b>看 Features 一栏和相关字段。<span class="pill warn">待核实</span> 不同 SoC / 厂商对 EL2 的暴露方式不一致，是否可用的最终判据是 hypervisor 能否正常启动，而不是某一个字段。' },
          { t: 'o', s: 'Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 ...' },
          { t: 'd', s: '# ---- 以下为示意流程，具体命令随 Hyperpwn 版本/设备而异 <span class="pill warn">待核实</span> ----', note: '从这里开始，命令是<b>流程示意</b>。请以工具官方文档为准，不要照抄。' },
          { t: 'p', s: '# 1) 部署 hypervisor 到设备并让系统以 Guest 身份重启', note: '<b>核心动作：抢占 EL2。</b>让轻量 hypervisor 先于 Android 内核拿到控制权，之后整个 Android 就运行在它的虚拟机里。这一步通常需要刷入/替换启动链路上的组件。' },
          { t: 'w', s: '[*] hypervisor 已驻留 EL2，Android 正在作为 Guest 运行' },
          { t: 'p', s: '# 2) 连接调试前端（宿主机侧）', note: '<b>宿主机侧是干净的世界。</b>你的调试前端跑在 PC 上，通过设备上的调试通道与 EL2 通信——它从来不在 Guest 的进程列表里。' },
          { t: 'o', s: '[*] connected. guest 已就绪，等待设置断点' },
          { t: 'p', s: '# 3) 定位到 VMP 的字节码流区域，并在分发器/字节码流上设内存访问断点', note: '<b>关键一步，也是 Hyperpwn 的杀手锏。</b>断点设在「字节码流被读取」的地址上——不需要知道虚拟 pc 在哪、不需要 hook 任何函数。<span class="hit">谁读这块内存，你就在 EL2 看到谁。</span>' },
          { t: 'o', s: '[*] breakpoint set: ACCESS @ 0x5A00 (size=0x40) [stage-2]\n[*] guest 内存未被修改，校验和一致' },
          { t: 'p', s: '# 4) 运行 App，触发被 VMP 保护的函数', note: '<b>让业务逻辑自己跑起来。</b>与主动调用类方案不同，这里是真实执行路径——采到的行为序列最有价值。' },
          { t: 'e', s: '[*] TRAP @ EL2 — guest PA 0x5A00 accessed by PC 0x4C88 (read)' },
          { t: 'o', s: '[*] 已停滞 Guest，寄存器与内存现场已保存（未修改 guest 内存）' },
          { t: 'p', s: '# 5) 读取现场：opcode、虚拟 pc、VMContext', note: '<b>这就是映射表的第一手素材。</b>命中时立刻读走：当前 opcode 的值、字节码指针的位置、VMContext 的内容。四问法的①②③④都能从这里推出来。' },
          { t: 'o', s: 'opcode = 0x1A\nvm pc  = 0x00\nVMContext[+0]=0x0  VMContext[+4]=0x1000' },
          { t: 'p', s: '# 6) 单步 / 继续，重复采集，逐步填表', note: '<b>把上面的过程循环几百次。</b>每次命中都记一条，慢慢就填出一张完整的映射表——这正是下一节的实战。' },
          { t: 'o', s: 'map[0x1A] = MOV  (len 1)\nmap[0x2B] = ADD# (len 2)\n...' }
        ]
      },
      after:
        T.note('ok', '✅ 出问题往哪查',
          '<p>Hyperpwn 起不来或断点不触发，按这个顺序排查：<br>' +
          '① <b>设备/内核是否支持</b>——这是最常见的原因，不同机型适配差别很大；<br>' +
          '② <b>hypervisor 是否真的拿到了 EL2</b>——如果启动链路里被别的组件先占了 EL2，它就没戏；<br>' +
          '③ <b>断点地址是否搞错了层级</b>——stage-2 用的是 <b>Guest 物理地址</b>，' +
          '和你从进程里看到的<b>虚拟地址</b>不是一回事，中间差一层 Guest 页表翻译。' +
          '<span class="miss">这是新手最容易卡住的地方：地址搞错，断点永远不会命中。</span><br>' +
          '④ <b>断点范围太小</b>——字节码流可能被分块解密到别处，先放宽范围确认有流量，再收窄。</p>')
    },
    /* ================= 6.9 ================= */
    {
      h: '6.9',
      title: '实战：用 Hyperpwn 调试 VMP，把映射表采出来',
      html:
        '<p>把前两节的东西合起来，就是一个完整的实战闭环：' +
        '<b>EL2 提供不可见的观测能力，映射表工程提供消费这些观测的方法</b>。' +
        '这一节按真实顺序走一遍。</p>' +
        T.note('key', '🔑 采集前的三件事（跳过任何一件都会白干）',
          '<p>① <b>找到字节码流在哪</b>——它可能在 so 的数据段，也可能在运行时才解密出来的内存里。' +
          '先在 EL2 用大范围访问断点「探路」，看哪个区域被高频读取。<br>' +
          '② <b>找到 VMContext 在哪</b>——通常紧挨着字节码指针，是一块被反复读写的内存。<br>' +
          '③ <b>确认 VM 入口被触发</b>——先让被保护函数真的跑起来一次，再开始采集。' +
          '<span class="miss">空采是新手最常见的浪费：断点设好了，程序根本没走进 VMP。</span></p>') +
        T.note('warn', '⚠️ 最容易踩的坑：地址层级搞混',
          '<p>stage-2 断点用的是 <b>Guest 物理地址（IPA）</b>。' +
          '而你在进程里（通过 so 基址 + 偏移）得到的是<b>虚拟地址（VA）</b>。两者之间隔着一层 Guest 页表翻译。' +
          '直接把 VA 填进 EL2 断点，<span class="bad">永远不会命中，而且不会有任何报错</span>——' +
          '你会以为断点功能坏了。务必先把 VA 翻译成 IPA 再下断。</p>') +
        T.note('', '🎯 这对逆向实战有什么用',
          '<p>Hyperpwn 在这里的价值不是「另一个调试器」，而是<b>把反调试这一整个干扰项从问题里删掉了</b>。' +
          '你终于可以像分析普通程序一样，安静地看着 VMP 执行——该采集采集、该单步单步，' +
          '不需要一边分析一边和检测代码斗智斗勇。</p>'),

      stepper: {
        title: '实战流程：从零到一张可用的映射表',
        lines: [
          { code: '<span class="c"># 步骤 1：确认目标函数确实被 VMP 保护</span>\n' +
                  '<span class="c"># 静态特征：函数开头是一大段寄存器保存，随后 ldr 出两个神秘常量</span>',
            note: '<b>先确认敌人是谁。</b>如果函数开头是普通的 ARM 序言（几条 stp/mov），那它没被虚拟化，用常规方法就行——<b>别把简单问题复杂化</b>。' },
          { code: '<span class="c"># 静态：在 IDA 里按 XREF 追 so 基址，找到函数入口</span>\n' +
                  '<span class="c"># 得到 VA（虚拟地址），记下来备用</span>',
            note: '<b>拿到 VA，但先别急着下断点。</b>这个地址接下来要翻译成 Guest 物理地址（IPA）——这是整个流程里最容易出错的一步。',
            state: { '函数 VA': '0x7A3C1000', '下一步': 'VA → IPA 翻译' } },
          { code: '<span class="c"># 步骤 2：在 EL2 侧把 VA 翻译成 IPA</span>\n' +
                  '<span class="c"># （stage-2 断点只认物理地址）</span>',
            note: '<b>关键一步。</b>stage-2 页表负责 Guest 物理地址 → 真实物理地址的翻译，而 Guest 页表负责 VA → IPA。' +
                  '你要下断点的地址必须是 <b>IPA</b>。<span class="hit">搞错这一步的症状是「断点不报错，但永远不命中」。</span>',
            state: { '函数 VA': '0x7A3C1000', '函数 IPA': '0x8A3C1000' } },
          { code: '<span class="c"># 步骤 3：先在函数入口下一个「执行断点」确认能停住</span>',
            note: '<b>先证明通路是活的。</b>这一步是校准：如果连入口都停不住，后面的采集全是空谈。先排除环境问题，再谈分析。' },
          { code: '<span class="o">[*] TRAP @ EL2 — guest PC 0x8A3C1000 (exec)</span>\n' +
                  '<span class="c"># 进入 vm_entry：保存宿主上下文、载入字节码基址与 VMContext</span>',
            note: '<b>停住了，而且在 vm_entry 里。</b>现在读走两个关键值：字节码流基址、VMContext 基址。' +
                  '<span class="hit">这两个地址是整个映射表工程的坐标原点。</span>',
            state: { '字节码基址': '0x5A00 (IPA)', 'VMContext': '0x7F314000' } },
          { code: '<span class="c"># 步骤 4：在「字节码流的读取」上下内存访问断点</span>\n' +
                  '<span class="c"># 断点类型：ACCESS（读），作用域：字节码流所在页</span>',
            note: '<b>策略上的巧劲。</b>不去猜分发器在哪、不去 hook 任何函数——' +
                  '<b>而是在「数据」上下断点</b>。谁读这块字节码，谁就是解释器。<span class="hit">这是 EL2 内存断点相比传统 hook 最大的优势：目标不需要是代码。</span>' },
          { code: '<span class="o">[*] breakpoint set: ACCESS 0x5A00..0x5A40 (read) [stage-2]</span>\n' +
                  '<span class="o">[*] guest 内存未被修改</span>',
            note: '<b>断点生效，且 Guest 内存一个字节没变。</b>这意味着：即使 App 每隔几百毫秒算一次代码段校验和，也永远发现不了你。' },
          { code: '<span class="c"># 步骤 5：运行 App，触发被保护函数</span>',
            note: '<b>让真实业务路径跑起来。</b>比起主动调用，真实执行路径采到的行为序列更有代表性——你会看到真实的 opcode 分布。' },
          { code: '<span class="e">[*] TRAP #1 — read @ 0x5A00 by PC 0x8A4C88</span>\n' +
                  '<span class="c"># 命中！读地址 0x5A00 正是字节码流开头</span>',
            note: '<b>第一次命中。</b>注意三件事：谁在读（<code>PC 0x8A4C88</code>，这就是取指指令的位置）、读哪里（0x5A00）、读多少。<b>这三条信息就定义了取指点。</b>',
            state: { 'opcode 读地址': '0x5A00', '取指指令 PC': '0x8A4C88' } },
          { code: '<span class="c"># 步骤 6：命中瞬间读走现场</span>\n' +
                  '<span class="c"># opcode 值、虚拟 pc、VMContext 全量快照</span>',
            note: '<b>这是四问法的原始素材。</b>每个字段都别漏：opcode 决定它是什么指令，VMContext 决定它的输入输出。',
            state: { 'opcode': '0x1A', 'vm pc': '0x00' },
            mem: 'VMContext @0x7F314000:\n+0x00: 0000 0000  (V0)\n+0x04: 0010 0000  (V1 = 0x1000)\n+0x08: ???? ????  (V2)\n+0x0C: ???? ????  (V3)' },
          { code: '<span class="c"># 步骤 7：放行，等下一次读字节码流（= 下一条指令）</span>\n' +
                  '<span class="c"># 放行前先取第二次快照，做 diff</span>',
            note: '<b>用「下一次命中」作为一条指令的结束信号。</b>因为在循环解释器里，下一条字节码的取指必然紧跟在本条 handler 之后——' +
                  '<span class="hit">不需要知道回边在哪，靠断点序列本身就能切分指令边界。</span>' },
          { code: '<span class="c"># diff 结果：只有 VMContext+0 变化（0 → 0x1000）</span>\n' +
                  '<span class="c"># handler 内部无 ALU 指令、无 VMContext 之外的访存</span>\n' +
                  '<span class="o">map[0x1A] = MOV   (len 1)</span>',
            note: '<b>第一条映射落地。</b>目标 = +0（写 V0）、源 = +4（读 V1）、运算 = 无、副作用 = 无 → 赋值搬运。' +
                  '<span class="hit">四问法全部由机器算出来了，人只需要确认。</span>',
            state: { 'map[0x1A]': 'MOV (len 1)' } },
          { code: '<span class="c"># 步骤 8：重复步骤 5~7，直到 opcode 覆盖度收敛</span>',
            note: '<b>把「跑一次」变成「跑很多次、跑不同的功能路径」。</b>每命中一次记一条，同 opcode 的记录互相印证——' +
                  '如果同一个 opcode 出现了互相矛盾的记录，那说明它是<b>多态</b>的，需要按上下文细分。' },
          { code: '<span class="o">map[0x1A] = MOV      (len 1)\n' +
                  'map[0x2B] = ADD#     (len 2)\n' +
                  'map[0x07] = LDR      (len 3)\n' +
                  'map[0x3C] = STR      (len 2)\n' +
                  '<span class="d">... 共 41 条，覆盖度 100%</span></span>',
            note: '<b>表建成了。</b>判据是「覆盖度」：连续跑一段时间没有新 opcode 出现，就说明采全了。' +
                  '<span class="hit">有了完整的表，被保护的函数就能被逐条翻译回伪代码。</span>',
            state: { '映射表条目': '41', '覆盖度': '100%', '未识别 opcode': '0' } },
          { code: '<span class="c"># 步骤 9：拿着映射表回填，把字节码流翻译成 ARM 序列</span>\n' +
                  '<span class="c"># → 丢回 IDA / Ghidra，F5 出伪代码</span>',
            note: '<b>最后一公里。</b>翻译完成后，VMP 保护就退化成了普通 ARM 代码——<b>IDA 又能工作了</b>。' +
                  '这就是整个方法论的目标：不是「读懂混淆」（做不到），而是「把混淆还原成不混淆」。' },
          { code: '<span class="c"># 复盘：全程没有对抗过一次反调试</span>\n' +
                  '<span class="c"># 因为从 EL2 的视角看，Guest 里什么都没发生</span>',
            note: '<b>这才是本章最想让你记住的一课。</b>不是在检测上赢了对方，而是<b>把对方能检测的东西整个移出了自己的作战范围</b>。' +
                  '<span class="miss">层级的选择，比技巧的堆叠重要得多。</span>' }
        ]
      }
    },

    /* ================= 6.10 ================= */
    {
      h: '6.10',
      title: '加固手段全景与选型：面对一个目标，你该从哪下手',
      html:
        '<p>到这里，本章的技术点已经齐了。把它们拼成一张选型表——<b>看到什么症状，走哪条路</b>。</p>' +
        T.tbl(['你观察到的现象', '背后的加固手段', '该走的路线', '成功率'], [
          ['磁盘 dex 是密文，运行时才有明文',
           '一代壳（整体加密壳）', '内存 dump（抓住解密完成、加载之前的时间窗）', '<span class="pill ok">高</span>'],
          ['类名方法名都在，但方法体是空的 / 全是 nop',
           '抽取壳（code_item 被抽走）', '主动调用把方法体逼出来 + dump 回填；FART 一类框架可用', '<span class="pill ok">高</span>'],
          ['关键函数点进去是一个巨大的 while + switch',
           'VMP（指令级虚拟化）', '映射表工程：动态采集 opcode → 行为，重建语义', '<span class="pill warn">中（工作量大）</span>'],
          ['逻辑在，但控制流被拍平、全是虚假分支',
           'OLLVM 控制流平坦化', '先反混淆（如 D810 一类脚本）再分析；或直接动态跟踪真实路径', '<span class="pill ok">中高</span>'],
          ['一附加就退出 / 一注入就崩',
           '反调试 / 反注入', '定制 ART 从生成侧删掉检测；或下沉到内核 / EL2', '<span class="pill ok">高（EL2 最优）</span>'],
          ['内存 dump 出来的 dex 校验不过、装载失败',
           'dex 完整性校验 / 结构校验', '修补校验字段；或直接在内存里读，不落盘重建', '<span class="pill warn">中</span>'],
          ['改动代码段就退出',
           '代码段校验和自保护', '<b>不要改内存</b>。用 EL2 stage-2 断点，或只在内存外做观测', '<span class="pill ok">高</span>']
        ]) +
        T.note('key', '🔑 选型的三条硬规则',
          '<p><b>规则一：不要用比目标更高层的工具去打更低层的保护。</b>用 frida 去打带代码校验和的 VMP，' +
          '等于用改内存的方式去骗一个专门检测内存改动的守卫。<br>' +
          '<b>规则二：先降级，再分析。</b>能脱壳就先脱壳（把 VMP 之外的干扰去掉），再集中火力打虚拟化。<br>' +
          '<b>规则三：把「对抗」换成「移出战场」。</b>与其绕过检测，不如让检测看不见你——' +
          '这也是本章从头到尾的主线。</p>') +
        T.note('warn', '⚠️ 关于「工具能不能一键解决」',
          '<p>脱壳机 / 主动调用框架对<b>一代壳和抽取壳</b>确实有效，这部分的工具生态很成熟。' +
          '但到 VMP 这一级，<b>没有通用的一键方案</b>——因为每个厂商的字节码编码都是私有的，' +
          '任何「通用映射表」都不存在。<span class="miss">认清这一点，能帮你省下大量寻找银弹的时间。</span></p>' +
          '<p>顺便：具体某个工具对某个具体 App 的适用性，<span class="pill warn">待核实</span>——' +
          '加固厂商更新很快，实践前务必自己验证。</p>'),

      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一 · 选层',
            scenario: '<b>情境：</b>你要逆的一个 App，核心算法函数被 VMP 保护。你手上有一个能 root 的测试机。' +
                      '第一次尝试：你用 frida 注入，在解释器的分发器处下了一个断点，准备开始记录 opcode。' +
                      '结果 App 启动约 3 秒后直接闪退，logcat 里只有一句含糊的 native crash。' +
                      '<br><br>你的下一步是？',
            choices: [
              { t: '换个 frida 版本 / 换端口 / 改名，把注入框架藏得更隐蔽一点', next: 'n1' },
              { t: '认为目标用了 EL2 hypervisor 反调试，开始研究怎么检测和绕过 hypervisor', next: 'n2' },
              { t: '先静态定位闪退点，确认它到底在检测什么（校验和？TracerPid？maps？）', next: 'n3' },
              { t: '改用 Hyperpwn 这类 EL2 层调试方案：用 stage-2 内存断点采集，完全不碰 Guest 内存', next: 'n4' }
            ]
          },
          n1: {
            label: '选A · 继续藏 frida', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：你在加固方选定的战场上消耗',
            result: '<b>认知根源：把「隐藏工具」当成了根本解法。</b>改端口、改名字只能骗过字符串扫描这一类最浅的检测。' +
                    '一旦对手升级到<b>内存完整性检测</b>（代码段校验和、函数首字节比对）或 <b>ptrace/TracerPid 检测</b>，' +
                    '无论你把 frida 藏得多深都没有用——因为问题不在于「它认出了 frida」，而在于<b>「进程里发生了不该发生的改动」</b>。' +
                    '<br><br><b>正确做法：</b>先判断检测属于哪一类。如果是内存完整性类，任何"改内存"的调试手段都注定失败，' +
                    '必须换层级（EL2）。把精力放在「选对层级」上，而不是「把同一层的伪装做得更好」。'
          },
          n2: {
            label: '选B · 假设目标用了 EL2 反调试', terminal: true, verdict: 'bad',
            verdictTitle: '过度假设：把一个罕见的可能性当成了默认解释',
            result: '<b>认知根源：跳过了排查，直接接受了最复杂的假设。</b>' +
                    '绝大多数商业加固的反调试都在 <code>ptrace</code> / <code>TracerPid</code> / ' +
                    '<code>/proc/self/maps</code> / 代码段校验和这个层面，' +
                    '<b>主动检测 hypervisor 的实现极其罕见</b>。' +
                    '<br><br>而且这里有一个逻辑漏洞：你自己打算用 EL2 来调试，却先假设对手已经布防在 EL2——' +
                    '这会让整个方案在还没开始时就显得不可行。<b>正确做法：</b>先花十分钟做基础排查（看 maps 有没有陌生段、' +
                    '看 TracerPid、看闪退点附近的代码），排除掉 90% 的常见情况，再考虑罕见情况。'
          },
          n3: {
            label: '选C · 先定位闪退点，确认检测类型', terminal: true, verdict: 'good',
            verdictTitle: '正确：先诊断，再选层',
            result: '<b>这是唯一理性的第一步。</b>反调试是一个大类，不同类别的破解路径完全不同：' +
                    '检测 <code>TracerPid</code> → 定制内核或定制 ART 就能解决；' +
                    '检测注入 so → 定制 ART 从加载侧隐藏；' +
                    '<b>检测内存完整性（代码段校验和、函数首字节）→ 只能靠不改内存的方案，也就是 EL2</b>。' +
                    '<br><br><b>具体怎么做：</b>用 EL2 的执行断点（不改内存的那种）先追到闪退发生的位置，' +
                    '看它在读什么、比较什么。这一步本身就已经需要 hypervisor 了——但它是「诊断用」的，' +
                    '一旦确认是内存完整性检测，你的整套采集方案自然也就切到 EL2 上了。' +
                    '<b>认知要点：诊断手段和最终方案可以是同一层。</b>'
          },
          n4: {
            label: '选D · 直接改用 Hyperpwn', terminal: true, verdict: 'good',
            verdictTitle: '方向对，但跳了一步（这是本情境的次优解）',
            result: '<b>结论正确，过程可议。</b>改用 EL2 的 stage-2 内存断点，确实是从根上解掉了「检测内存改动」这一类反调试，' +
                    '而且它同时满足了你采集 opcode 的需求——<b>在绝大多数情况下，这就是终局方案</b>。' +
                    '<br><br><b>但为什么说跳了一步：</b>如果不先确认检测类型，你无法确定 EL2 是否真的解决了问题。' +
                    '万一闪退的原因是别的（比如 App 检测了设备指纹、检测了 root、或者根本就是你自己 hook 错了导致崩溃），' +
                    '换成 EL2 之后依然会闪退，而你会误以为「EL2 也没用」。' +
                    '<br><br><b>更稳的次序是：</b>先用 EL2 的能力去诊断（不改内存，所以不会干扰），确认问题出在内存完整性检测上，' +
                    '然后顺理成章地用同一套设施继续做映射表采集。<b>先诊断、再决策——但方向你选对了。</b>'
          }
        }
      }
    },
    /* ================= 6.11 ================= */
    {
      h: '6.11',
      title: '决策演练二：映射表的可信度',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境二 · 可信度',
            scenario: '<b>情境：</b>你在 EL2 上挂了字节码流的访问断点，跑了二十分钟，采到了 37 条 opcode 记录，' +
                      '自我感觉良好。然后你拿着这张表去翻译一段被保护的函数，翻译出来的伪代码是这样的：' +
                      '<br><br><code>while (x &lt; 10) { x = x; }</code> —— <b>循环体什么都没干，条件也永远为真</b>。' +
                      '显然不对，但你的表「看起来」很完整。<br><br>你的下一步是？',
            choices: [
              { t: '表已经能覆盖绝大部分 opcode 了，先按它翻译，剩下的 3 条手工猜', next: 'n1' },
              { t: '怀疑映射表错了，回头逐条复查已经采到的记录（尤其是指令长度和字段偏移）', next: 'n2' },
              { t: '认为是遇到了多态 handler：同一个 opcode 在不同上下文下语义不同，需要按上下文细分记录', next: 'n3' },
              { t: '认为是采集样本不够：继续跑更多功能路径，直到覆盖度收敛', next: 'n4' }
            ]
          },
          n1: {
            label: '选A · 手工补缺', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：错误的表会让整段伪代码失效',
            result: '<b>认知根源：把「覆盖率」当成了「正确率」。</b>37 条记录听起来不少，' +
                    '但映射表工程对<b>单条记录的正确性</b>是零容忍的——<b>一条错，整段翻译全错</b>。' +
                    '<br><br>想想为什么：字节码流是一条<b>线性的指令序列</b>。如果你的 <code>0x2B</code> 记录把长度记成了 1（实际是 2），' +
                    '那从这条开始，后面<b>所有</b>指令的边界都错位了，翻译出来的东西当然是垃圾。' +
                    '<br><br><b>正确做法：</b>伪代码逻辑不通，第一反应应该是「表里有一条错了」，' +
                    '而不是「表不够全」。用已知正确的简单函数（比如一个纯加法函数）当测试用例，反推是哪条记录出了问题。'
          },
          n2: {
            label: '选B · 逐条复查：长度与字段偏移', terminal: true, verdict: 'good',
            verdictTitle: '正确：先怀疑数据，别怀疑工具',
            result: '<b>这是最有性价比的一步。</b>「循环体什么都不干」这个症状，指向两种极典型的数据错误：' +
                    '<br><br>① <b>指令长度记错了</b>。如果某条带操作数的字节码被你当成 1 字节，' +
                    '那它的操作数会被误读成下一条 opcode，整个解析<b>从错位点开始全盘崩坏</b>。' +
                    '症状就是「出现大量莫名其妙的 opcode」或「逻辑不通」。<br>' +
                    '② <b>VMContext 字段偏移搞错了</b>。如果把 V0 记成 +0 而实际是 +8，' +
                    '那所有读写都会指向错误的虚拟寄存器，' +
                    '结果是「<code>x = x</code>」这种自我赋值——<b>因为源和目标被误判成了同一个字段</b>。' +
                    '<br><br><b>怎么查：</b>找一个行为已知的函数（比如两数相加）跑一遍，逐条核对翻译结果；' +
                    '再看 handler 里访问的偏移是不是与你记录的一致。<b>先校验，再扩展。</b>'
          },
          n3: {
            label: '选C · 怀疑多态 handler', terminal: true, verdict: 'bad',
            verdictTitle: '过度假设：多态确实存在，但它不是这个症状的主因',
            result: '<b>认知根源：用「高级解释」掩盖「基础错误」。</b>多态 handler 确实是商业 VMP 的常见加强手段——' +
                    '同一个 opcode 在不同上下文下做不同的事。但它的表现是<b>记录之间互相矛盾</b>' +
                    '（同一个 opcode 在两次命中里 diff 出完全不同的行为），' +
                    '而不是「循环体为空」这种<b>系统性、全局性</b>的解析错乱。' +
                    '<br><br>你现在的症状是「翻译结果整体逻辑不成立」，这几乎总是<b>解析层面的错误</b>——' +
                    '长度错位或字段偏移错，属于最基础的一环。' +
                    '<br><br><b>正确做法：</b>多态是「进阶怀疑」，应该在排除了基础错误之后再考虑。' +
                    '顺序反过来会让你在错误的方向上做大量无用的细分工作。'
          },
          n4: {
            label: '选D · 继续采更多样本', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：样本量解决不了样本本身的问题',
            result: '<b>认知根源：把「量」当成了「质」的解药。</b>再跑二十条记录，只会让你得到更多<b>同样错误</b>的数据。' +
                    '采集是「记录」行为，它不会自我纠错——如果你的长度算法错了，采一万次还是错的。' +
                    '<br><br>而且「覆盖度收敛」这个判据本身有个陷阱：如果某条 opcode 因为长度错位从未被正确读到，' +
                    '它<b>永远不会出现</b>在记录里，覆盖度却会「收敛」得很漂亮。<span class="miss">收敛的覆盖度可能只是错误的稳定。</span>' +
                    '<br><br><b>正确做法：</b>先把已有记录中的一条用「行为已知的函数」验证正确，' +
                    '确认解析链路无误，再谈扩展样本。'
          }
        }
      }
    },

    /* ================= 6.12 ================= */
    {
      h: '6.12',
      title: '决策演练三：反直觉的一题——当 EL2 也用不了',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境三 · 约束',
            scenario: '<b>情境：</b>你按计划准备用 Hyperpwn 打一个 VMP 目标。但现实是：' +
                      '目标 App 绑定了特定机型（有硬件级设备指纹校验），' +
                      '而你手上这台能跑 hypervisor 的开发板，<b>不是目标支持的机型</b>；' +
                      '你唯一能拿到的目标真机，启动链被锁死，<b>刷不进 hypervisor</b>。' +
                      '<br><br>你的处境是：EL2 这条路在你的硬件上走不通，但分析还得继续。<br><br>你的下一步是？',
            choices: [
              { t: '放弃动态分析，把所有精力投到纯静态：硬啃 handler 汇编，一条条手工推语义', next: 'n1' },
              { t: '回到 EL0：用 frida 硬刚反调试，写一堆 hook 脚本把检测一项项绕过', next: 'n2' },
              { t: '先问一个前置问题：目标真的检测内存改动吗？如果不是，EL1 定制内核足够，而且真机可刷', next: 'n3' },
              { t: '想办法伪造设备指纹，把目标 App 搬到能跑 hypervisor 的开发板上', next: 'n4' }
            ]
          },
          n1: {
            label: '选A · 纯静态硬啃', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：手工推语义是可行的，但成本失控',
            result: '<b>认知根源：从一个极端跳到另一个极端。</b>静态推 handler 语义在原理上完全成立——' +
                    'handler 很短，一条条看确实能推出「它读了哪两个偏移、做了什么运算」。' +
                    '这也正是你在有动态记录之后用来<b>验证</b>的手段。' +
                    '<br><br>但把它当成<b>唯一</b>手段时，问题在于：① 你不知道 opcode 空间有多大，' +
                    '可能要看几百个 handler；② 你无法知道<b>每段字节码实际用到哪些 opcode</b>，' +
                    '只能全看一遍；③ 最容易出错的是<b>指令长度</b>——静态看 handler 很难直接得出' +
                    '「这条字节码吃掉几个字节」，而这恰恰是解析字节码流的前提。' +
                    '<br><br><b>正确做法：</b>静态推语义永远只是动态采集的<b>补充与验证</b>，' +
                    '不该被当成主路径。先想办法恢复动态能力，哪怕层级低一点。'
          },
          n2: {
            label: '选B · 回到 EL0 硬刚反调试', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：这是本末倒置的降级',
            result: '<b>认知根源：把「回退」当成了「前进」。</b>你刚刚花了整章的篇幅确认：' +
                    'EL0 的调试手段在带内存完整性检测的目标面前<b>结构性失效</b>——' +
                    '不是「难一点」，而是<b>原理上会被抓到</b>。回到 EL0 等于主动选择了一个你已经知道走不通的层级。' +
                    '<br><br>更糟的是：EL0 的对抗是<b>持续消耗</b>。你绕过一条检测，加固更新后又要重来。' +
                    '而在 VMP 这种分析周期以周计的目标上，你会在中途被反复打断，<b>永远建不完映射表</b>。' +
                    '<br><br><b>正确做法：</b>层级只能往下走（向内核、向 hypervisor），不能往回退。' +
                    '如果 EL2 暂时不可用，就找 <b>EL1</b> 的替代方案——那仍然是在正确的方向上推进。'
          },
          n3: {
            label: '选C · 先确认检测类型，再决定层级', terminal: true, verdict: 'good',
            verdictTitle: '正确：不是所有目标都需要 EL2',
            result: '<b>这是本题最反直觉、也最有价值的一步。</b>整章都在讲 EL2 的威力，' +
                    '但 EL2 解决的是一个<b>特定问题</b>：检测内存完整性。' +
                    '如果你的目标只做了 <code>TracerPid</code> 检测、<code>/proc/self/maps</code> 扫描这些' +
                    '<b>进程级</b>检测，那么 <b>EL1 定制内核就足够了</b>——' +
                    '它能抹掉进程级痕迹，而且<b>可在真机上刷入</b>，绕过了你的硬件约束。' +
                    '<br><br><b>关键判断依据：</b>如果你修改代码段后 App 不退出，说明它<b>没有</b>做内存完整性校验，' +
                    '此时内核级调试完全够用；如果你一改内存就闪退，才必须上 EL2。' +
                    '<br><br><b>认知要点：</b>工具选型要匹配<b>目标的实际防御</b>，' +
                    '而不是匹配「你在书里读到的最强武器」。另外别忘了还有<b>定制 ART</b> 这条路——' +
                    '很多检测根本不需要你在调试层面解决，从生成侧删掉即可。'
          },
          n4: {
            label: '选D · 伪造设备指纹搬 App', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：你在和加固方之外的一整套系统作战',
            result: '<b>认知根源：为了解决一个问题，引入了三个更难的问题。</b>' +
                    '硬件级设备指纹（通常基于 TEE / 安全存储 / 芯片唯一标识）的设计目标就是<b>不可伪造</b>——' +
                    '你面对的已经不是加固厂商，而是 SoC 厂商和安全世界（EL3/TrustZone）。' +
                    '这是一场难度高出一个数量级的仗。' +
                    '<br><br>而且就算伪造成功，App 在开发板上的一堆真实行为差异' +
                    '（传感器、GPU、系统调用时序）也可能触发别的风控，<b>你会陷入无穷无尽的兼容性泥潭</b>。' +
                    '<br><br><b>正确做法：</b>约束在硬件上，就应该在<b>调试层级</b>上找解法（比如 EL1），' +
                    '而不是试图改变目标的运行环境。<b>把问题留在自己的战场里解决。</b>'
          }
        }
      }
    },
    /* ================= 6.13 ================= */
    {
      h: '6.13',
      title: '自测一：VMP 为什么让静态分析整体失效',
      quiz: {
        id: 'q6-1', chapter: 6, answer: 2,
        stem: '把一个被 VMP 保护的关键函数拖进 IDA，F5 反编译后你看到的是一段 <code>while (1) { op = *pc++; switch (op) {...} }</code>。' +
              '<b>下面哪一句最准确地解释了「原始业务逻辑为什么读不出来」？</b>',
        options: [
          { t: '厂商把原始 ARM 指令加密后存在数据段，运行时再解密成标准 ARM 指令执行——只要在正确的时机 dump 内存就能拿回原始指令',
            why: '这是<b>一代壳</b>的模型（整体加密、运行时解密到内存），混淆了两类技术。VMP 里<b>根本不存在</b>「原始 ARM 指令」这个形态——翻译在加固期就完成了，发布出去的 so 里没有原始指令可供解密。' },
          { t: '解释器被 OLLVM 混淆了，控制流被拍平，所以反编译器无法还原出正确的控制流',
            why: '混淆确实常和 VMP 一起用，但它只是<b>让解释器更难读</b>，不是静态失效的根本原因。就算解释器完全没混淆、干净得像教科书，你也读不出业务逻辑——因为业务逻辑压根不在解释器里。' },
          { t: '业务逻辑的语义被搬进了「字节码数据 + 厂商私有的编码约定」：字节码本身只是普通数字，它的含义只存在于解释器的 handler 里，而反编译器只能按公开的指令集语义去解读',
            why: '正确。反编译器的前提是「机器码语义由公开的架构手册定义」。VMP 把语义 privatize 了：<code>0x1A</code> 是 MOV 还是 ADD，只有那个 <code>case 0x1A:</code> 知道。反编译器面对的是<b>一台它没有指令集手册的 CPU</b>。' },
          { t: '函数被拆成了多个小函数由解释器轮流调用，静态分析时无法把它们连起来',
            why: '这不是 VMP 的机制。VMP 不会把函数拆散——它把整个函数的指令序列<b>整体翻译</b>成一段字节码流，由一个解释器循环执行。拆散/扁平化是 OLLVM 一类混淆的做法。' }
        ],
        explain: '<b>要抓住的是「语义在哪」这个问题。</b>反编译器之所以能工作，靠的是一个公共约定：ARM 的机器码含义写在架构手册里，人人可查。' +
                 '所有静态分析工具（IDA、Ghidra）都建立在这个约定之上。' +
                 '<br><br>VMP 打破的正是它——把原始指令<b>翻译</b>成一套厂商自定义的字节码，让「指令的含义」变成了私有知识。' +
                 '于是剩下的只有两样东西：一个标准的解释器循环（反编译器能读懂，但没信息量），' +
                 '和一堆被当作数据处理的自定义字节码（反编译器根本没有解读它的依据）。' +
                 '<br><br>注意三者别混淆：<b>一代壳</b>藏文件（有原始形态可 dump）、<b>抽取壳</b>藏方法体（结构在、方法体可回填）、' +
                 '<b>VMP</b> 藏语义（<b>不存在原始形态，只能重建语义</b>）。这也解释了为什么 VMP 没有「一键脱壳」——脱壳的前提是有东西可脱。'
      }
    },

    /* ================= 6.14 ================= */
    {
      h: '6.14',
      title: '自测二：为什么 EL2 的内存断点检测不到',
      quiz: {
        id: 'q6-2', chapter: 6, answer: 1,
        stem: '同样是在目标函数上设一个「内存断点」，为什么用 <b>Hyperpwn 在 EL2 层</b>做，' +
              'App 的<b>代码段校验和</b>检测就抓不到，而在 EL0 用 frida 做就会被抓到？',
        options: [
          { t: '因为 hypervisor 的权限比 App 高，App 的文件读取和系统调用请求在到达内核之前就被 EL2 截获并篡改了',
            why: '权限高是对的，但机制说错了。EL2 并没有去「拦截并篡改 App 的读取结果」——那是一种主动伪造，反而会引入可被其它手段发现的不一致。EL2 的强项恰恰是<b>什么都不做</b>。' },
          { t: '因为 EL2 的内存断点通过 <b>stage-2 页表</b>（Guest 物理地址 → 真实物理地址的第二级翻译）做访问权限控制，命中时由 CPU 在翻译阶段陷入 EL2——<b>Guest 内存的内容一个字节都没被修改</b>；而 EL0 的软件断点必须把断点指令写进目标内存，校验和必然变化',
            why: '正确。这正是本章最关键的技术洞察：反调试的「内存完整性检测」全部建立在<b>「断点会在内存里留痕」</b>这个前提上。EL2 用硬件地址翻译做访问控制，从原理上就不产生这个痕迹。' },
          { t: '因为 hypervisor 运行在真实物理硬件上，而 App 运行在虚拟地址空间里，两者根本不在同一个地址空间，所以 App 看不到 hypervisor 的操作',
            why: '「地址空间不同」是个容易产生的直觉，但它不能解释问题：App 看不到 hypervisor 的内存，并不妨碍 App 去校验<b>自己</b>的代码段。关键在于<b>App 自己的内存有没有被改动</b>，而不是 hypervisor 藏得好不好。' },
          { t: '因为 hypervisor 会 hook 掉 App 的校验函数，让它返回一个恒定的「校验通过」结果',
            why: '这又回到了 EL0 的老思路——hook 校验函数。且不说 hook 本身会留下痕迹，这种「欺骗」一旦和别的检测交叉验证就会露馅。EL2 的优势是<b>不需要欺骗</b>：校验函数老老实实跑，算出来的结果<b>本来就是对的</b>。' }
        ],
        explain: '<b>核心区分：改内存 vs 控翻译。</b>' +
                 '<br><br>EL0 的软件断点（以及大多数内核层实现）都要往目标地址写一个断点指令，' +
                 '或者依赖调试寄存器这类<b>可被读取</b>的状态。这两种做法都会在目标身上留下可观测的证据：' +
                 '函数首字节对不上、代码段校验和变了、调试寄存器非零。检测手段非常便宜。' +
                 '<br><br>EL2 的做法完全不同。ARM 虚拟化下有两级地址翻译：stage-1 把虚拟地址翻译成 Guest 物理地址，' +
                 '<b>stage-2 再把 Guest 物理地址翻译成真实物理地址</b>。stage-2 页表的每一项除了地址还带访问权限位。' +
                 'hypervisor 只要把目标页的权限收紧，程序一访问它，CPU 在翻译阶段就抛出异常、直接陷入 EL2。' +
                 '<br><br><b>断点生效了，而那块内存从头到尾没被碰过。</b>所以校验和一致、首字节一致、寄存器干净——' +
                 '反调试在忠实地工作，只是它要找的东西不存在。' +
                 '<br><br>顺带记住层级的完整阶梯：<b>EL0 用户态 / EL1 Guest 内核 / EL2 Hypervisor / EL3 Secure Monitor</b>。' +
                 '调试器每下沉一层，可观测的东西多一圈，被观测的东西少一圈。'
      }
    },
    /* ================= 6.15 ================= */
    {
      h: '6.15',
      title: '自测三：构建映射表时必须同时记录什么',
      quiz: {
        id: 'q6-3', chapter: 6, answer: [0, 2, 3],
        stem: '<b>多选。</b>你在分发器处 hook，对每条字节码记录「opcode → 等价操作」。' +
              '为了让这张映射表<b>真正能用来翻译字节码流</b>，除了「等价操作」以外，还必须记录哪些信息？',
        options: [
          { t: '这条字节码在流中<b>吃掉了几个字节</b>（指令长度，含操作数）',
            why: '必须。<b>这是最容易漏、后果最严重的一项。</b>字节码流是一条线性序列，翻译时必须知道每条指令占多少字节才能走到下一条。长度记错 → 从错位点开始全盘崩坏，症状就是「翻译出来的伪代码逻辑不通」。' },
          { t: '这条字节码在流中的<b>绝对虚拟地址</b>（而不是相对偏移）',
            why: '不是必须。相对偏移（vm pc）已经足够定位和解析，基址是固定的。反倒是「按绝对地址建表」会让表绑死在一次运行的内存布局上，换个进程/换次启动就得重采。' },
          { t: 'handler 读写的是 <b>VMContext 里的哪几个字段</b>（源与目标虚拟寄存器）',
            why: '必须。四问法的①源②目标就靠它。不知道读写哪两个偏移，你就不知道这条指令在操作哪些虚拟寄存器，翻译出来的伪代码连数据流都是错的——「<code>x = x</code>」这种自我赋值往往就是把源和目标认成了同一个字段。' },
          { t: '这条字节码有没有发生 <b>VMContext 之外的访存</b>，以及是读还是写',
            why: '必须。这是区分「纯运算指令」和「内存访问指令」的唯一判据，也决定翻译成 LDR 还是 STR。<b>方向搞反，伪代码会面目全非</b>；漏掉访存，你会完全看不到数据从哪来、到哪去，交叉引用也无从谈起。' }
        ],
        explain: '<b>把「记录什么」想清楚，映射表工程就成了一半。</b>' +
                 '<br><br>清单是四项：<b>opcode 值</b>、<b>指令长度</b>、<b>读写哪些 VMContext 字段（源/目标）</b>、' +
                 '<b>是否有外部访存及方向</b>。再加上对 handler 内部指令的观察（有没有 ALU 指令、是加还是异或），' +
                 '就能把「运算」这一项也填上。' +
                 '<br><br>其中<b>指令长度</b>最容易被忽略，因为它在动态采集时「看起来」是自动的——' +
                 '毕竟下一次断点命中就告诉你下一条从哪开始了。但如果你只存 opcode、不存长度，' +
                 '一旦脱离这次运行（比如换一段字节码流、或者想在静态 dump 上做离线翻译），表就不可用了。' +
                 '<br><br><b>一句话记法：opcode、长度、源、目标、运算、访存。</b>六项齐全，表才算完整。'
      }
    },

    /* ================= 6.16 ================= */
    {
      h: '6.16',
      title: '自测四：VMP 与抽取壳，脱壳点完全不同',
      quiz: {
        id: 'q6-4', chapter: 6, answer: 2,
        stem: '有人总结说：「脱壳嘛，都是在内存里 dump 一份完整的 dex 下来就完事了，一代壳、抽取壳、VMP 都一样。」' +
              '<b>这个说法错在哪？</b>',
        options: [
          { t: '错在时机：三类壳都还是在内存 dump dex，只是 VMP 需要等更久，等到字节码全部解密完成之后才能 dump',
            why: '这是最典型的误解——把 VMP 当成「更慢的加密壳」。VMP 里<b>根本不存在「字节码全部解密成 dex」这件事</b>：字节码不是 dex 指令，它永远不会变回一个可读的 dex。等再久也等不到。' },
          { t: '错在对象：抽取壳抽走的是方法体指令，VMP 抽走的是整个方法（连方法表条目都不留），所以 VMP 的 dex 里连方法名都没有',
            why: '事实不符。VMP 并不以「删除方法」为手段，方法通常还在、还能被调用，只是<b>方法体不是标准指令</b>了。用「方法在不在」去区分抽取壳和 VMP 是抓错了特征。' },
          { t: '错在目标：一代壳和抽取壳最终都能还原出<b>一个完整可读的 dex</b>（前者要抢解密时机、后者要主动调用回填方法体），而 VMP 保护的方法<b>不存在可还原的原始形态</b>——你只能通过映射表把字节码的<b>语义</b>重建出来，得到的是伪代码而不是原始 dex',
            why: '正确。这是三者的本质分野：一代壳与抽取壳的产物都是 dex，只是「什么时候拿到」和「怎么把方法体填回去」不同；而 VMP 的产物是<b>语义</b>，靠映射表把字节码翻译回等价的操作序列。' },
          { t: '错在工具：VMP 必须用商业脱壳工具（如定制版脱壳机）才能脱，开源工具只能处理一代壳和抽取壳',
            why: '工具不是问题的本质。「没有通用脱 VMP 工具」的原因不是工具不够强，而是<b>不存在一个「原始 dex」等待被还原</b>——各家厂商的字节码编码都是私有的，不存在通用映射表。这是原理层面的限制，不是工具能力问题。' }
        ],
        explain: '<b>这三个概念的区别，用「产物是什么」最好记：</b>' +
                 '<br><br>· <b>一代壳</b>：磁盘上是密文 dex，内存里有明文 dex。产物 = <b>明文 dex</b>；' +
                 '关键是<b>抢时机</b>（解密完成、被 ART 加载之前）。<br>' +
                 '· <b>抽取壳</b>：结构完整、方法名都在，但 <code>code_item</code> 被抽走。' +
                 '产物 = <b>回填了方法体的 dex</b>；关键是<b>主动调用</b>把方法一个个逼出来再填回去。' +
                 '普通内存 dump 只能拿到「空方法」，这是最经典的翻车点。<br>' +
                 '· <b>VMP</b>：方法体被换成自定义字节码，由内置解释器执行。' +
                 '<b>没有可以「脱」的原始形态</b>——产物是<b>语义重建</b>的伪代码，靠的是一张张手工采出来的映射表。' +
                 '<br><br>所以下次听到「脱 VMP」，可以直接纠正对方：VMP 是<b>还原语义</b>，不是<b>脱壳</b>。' +
                 '这个措辞差异背后，是「有东西可 dump」和「无物可还」的根本区别——也正因如此，VMP 才站在安卓保护金字塔的顶端。'
      }
    },
  ],

  glossary: [
    { t: 'VMP（Virtual Machine Protect）', d: '指令级虚拟化保护。把原始 ARM 指令翻译成一套厂商自定义的字节码，运行时由内置解释器逐条解释执行。静态反编译失效的根源：语义不再由公开的指令集手册定义，而成了厂商的私有约定。' },
    { t: '字节码流（bytecode stream）', d: '被当作数据存储的自定义指令序列，通常位于 so 的只读数据段，或运行时才解密出来的内存区。它本身只是数字，配上映射表才有意义——静态分析在这里是死路，动态分析在这里是活水。' },
    { t: '分发器（dispatcher）', d: '解释器主循环里负责把 opcode 分派到对应 handler 的那段代码，典型形态是 switch 或跳转表。它是 VMP 分析中唯一的「必经之路」，也是所有动态 hook 的锚点。' },
    { t: 'Handler', d: '每条自定义字节码对应的实际处理代码，只做原子操作（读几个虚拟寄存器、运算、写回）。它天然没有业务语义，业务语义在字节码的排列顺序里，不在 handler 内部。' },
    { t: 'vm_entry（VM 入口）', d: '进入虚拟机的入口代码：保存真实 CPU 上下文、初始化 VMContext、把字节码指针指向流首字节。特征是被保护函数开头「保存一大片寄存器 + 载入几个神秘常量」。是分析的第一个落脚点。' },
    { t: 'VMContext（VM 上下文 / 虚拟寄存器）', d: 'VMP 自行维护的一套寄存器组与状态结构，替代真实 CPU 寄存器参与运算。字段布局是厂商私有约定，通常靠「执行前后 diff」来推断。' },
    { t: '映射表（mapping table）', d: '记录「自定义字节码 → 实际执行的操作」的对应关系，是逆向 VMP 的核心工作产物。采全后即可把字节码流翻译回等价的 ARM 序列，让反编译器重新可用。' },
    { t: '一代壳（整体加密壳）', d: 'dex 整体加密存放，运行时在 Native 层解密到内存再交给 ART 加载。脱壳点是「解密完成、尚未加载」的时间窗，一次内存 dump 即可拿到完整 dex。' },
    { t: '抽取壳（二代壳）', d: 'dex 结构保留（类名、方法名、签名都在），但方法体 code_item 的 insns 被抽走（置空或填 nop），被调用前才回填。普通内存 dump 只能得到「空方法」，需靠主动调用把方法体逼出来。' },
    { t: 'Hypervisor（虚拟机监控器 VMM）', d: '运行在比操作系统内核更底层的软件层，通过 ARM 虚拟化扩展把整个 Guest OS 跑在虚拟机里。调试器住在这里时，Guest 无法观测到它的存在。' },
    { t: 'Exception Level（EL0 / EL1 / EL2 / EL3）', d: 'ARM 的特权层级：EL0 用户态应用、EL1 Guest OS 内核、EL2 Hypervisor、EL3 Secure Monitor（TrustZone）。调试层级每下沉一层，可观测的更多、被观测的更少。' },
    { t: 'stage-2 页表', d: 'ARM 虚拟化下的第二级地址翻译，负责把 Guest 物理地址翻译成真实物理地址，每项附带访问权限位。Hypervisor 靠收紧权限实现内存断点——<b>命中时由 CPU 在翻译阶段陷入 EL2，Guest 内存一个字节都不改动</b>，因此所有内存完整性检测（代码段校验和、断点指令比对）都发现不了。' }
  ],

  teacher: {
    id: 'ch6', chapter: 6,
    name: '追问老师 · 第 6 章',
    sub: '拷问三件事：VMP 的语义藏在哪、映射表凭什么可信、以及你为什么必须换一层再打',
    intro: '<p style="margin:0">这一章最容易「听懂但答不出」。动画看得很爽，合上页面被问一句「那你到底怎么把映射表采出来」，' +
           '很多人就只剩「hook 分发器」四个字。<br>' +
           '我会一路追到原理层：为什么静态一定失效、为什么 EL2 一定检测不到、以及反过来——如果你坐在加固方那一边，你会怎么防。' +
           '答不上三次，我会给出完整答案；但那份答案你得当成教材读，不是当成答案背。</p>',
    questions: [
      /* ---------- Q1 ---------- */
      {
        id: 'c6q1', depth: 1, threshold: 0.7,
        q: '被 VMP 保护的关键函数，拖进 IDA 按 F5 之后，只剩一个 <code>while</code> + <code>switch</code>。' +
          '请解释：<b>原始的业务逻辑到底「去哪了」？反编译器又为什么在这种情况下一筹莫展？</b>',
        concepts: [
          { label: '原始指令被翻译成自定义字节码，由解释器逐条执行',
            hint: '这段代码被翻译之后，由谁来执行？执行的时候它是什么形态？',
            any: ['字节码', 'bytecode', '解释器', 'interpreter', '解释执行', '逐条解释', '虚拟机执行', '自定义指令', '自定义字节码', '分发器', 'dispatcher', 'handler', '虚拟机保护'] },
          { label: '语义由厂商私有约定定义，不在公开指令集里',
            hint: '字节码 0x1A 究竟等于 MOV 还是 ADD，是谁规定的？这个规定写在哪儿？',
            any: ['私有', '自定义', '厂商', '约定', '编码', '未公开', '没有文档', '不公开', '私有约定', '自研', '非标准', '只有解释器知道', '映射关系', '编码表', 'opcode 的含义'] },
          { label: '反编译器的前提是「机器码语义由公开架构手册定义」',
            hint: '反编译器凭什么能读懂一段机器码？它的前提假设是什么？',
            any: ['反编译器', '反编译', 'ida', 'ghidra', 'hex-rays', 'f5', '前提', '假设', '架构手册', '指令集手册', 'arm 手册', '公开', '标准指令', '无法还原', '读不出来', '失效', '不认识', '没有依据'] },
          { label: '原始指令在加固期就被替换，不是运行时才加密的',
            hint: '发布出去的 so 里，还找得到原始的 ARM 指令吗？',
            any: ['加固期', '编译期', '打包时', '翻译', '翻译器', 'translator', '转换', '替换', '改写', '事先翻译', '静态转换', '不存在原始', '没有原始指令', '不是解密', '没有明文'] }
        ],
        hints: [
          '先想清楚一件事：这段字节码在运行的时候，是谁在执行它？执行器长什么样？',
          '再往上一层：反编译器之所以能读懂机器码，建立在一个什么样的公共前提上？VMP 有没有把这个前提拿走？'
        ],
        probes: [
          '那如果我说「只要在对的时机 dump 内存，就能拿回原始 ARM 指令」，你同意吗？为什么？',
          '照你的说法，VMP 和一代壳的本质差别，能不能压缩成一句话？'
        ],
        model: '<b>原始逻辑没有「被藏起来」，而是「被换掉了」。</b>加固期（打包时）就有一个翻译器，把原始 ARM 指令逐条翻译成厂商自定义的字节码；' +
               '翻译完成后，发布出去的 so 里<b>不再存在原始 ARM 指令</b>。运行时，字节码流被当作纯数据读取，' +
               '由一个内置解释器循环执行：取指（<code>opcode = *pc++</code>）→ 分发（<code>switch</code> / 跳转表）→ ' +
               'handler 执行 → 更新 VMContext → 回到取指。你在 IDA 里看到的那个 while + switch，就是这个循环本身。' +
               '<br><br><b>反编译器为什么没辙：</b>所有反编译器的前提是「机器码的语义由公开的架构手册定义」——' +
               '这是个人人可查的公共约定。而 VMP 把语义 privatize 了：<code>0x1A</code> 对 CPU 来说只是个数据字节，' +
               '它等于 MOV 还是 ADD，只写在某个 <code>case 0x1A:</code> 分支里。' +
               '于是反编译器面对的是<b>一台它没有指令集手册的 CPU</b>：解释器循环它能读懂（但没信息量），' +
               '字节码流它根本没有解读依据。' +
               '<br><br><b>关键推论：不存在「原始形态」可以还原。</b>一代壳藏的是文件（有明文 dex 可 dump）、' +
               '抽取壳藏的是方法体（结构在、可回填），而 VMP 藏的是<b>语义</b>——所以「脱 VMP」这个说法本身就不成立，' +
               '你只能通过映射表把语义<b>重建</b>出来，得到的是等价伪代码，不是原始 dex。这也正是 VMP 没有一键脱壳工具的根本原因。',
        after: '<p>如果这题你答得顺，说明你已经把「VMP 不是更高级的加密」这件事真正内化了——这是本章最重要的一次认知切换。</p>'
      },

      /* ---------- Q2 ---------- */
      {
        id: 'c6q2', depth: 2, threshold: 0.7,
        q: '给你一个被 VMP 保护的 so，你需要在里面<b>定位 vm_entry 和分发器</b>。' +
          '请说出你会观察哪些特征，并且说明<b>每个特征为什么成立</b>（不要只说「它长得像」）。',
        concepts: [
          { label: 'vm_entry：保存宿主上下文 + 载入字节码基址 / VMContext 常量',
            hint: '被保护的函数，开头那段「不干正事」的样板代码在做什么？',
            any: ['vm_entry', '入口', '保存现场', '保存寄存器', '寄存器保存', 'stp', 'push', '载入常量', 'ldr 常量', '上下文保存', '初始化', '初始化虚拟机', '初始化 vm', 'pc 清零', 'vm pc'] },
          { label: '分发器：switch / 跳转表 + 无条件回边',
            hint: '什么东西会被执行成千上万次，而且每个 handler 最后都会跳回它？',
            any: ['分发器', 'dispatcher', 'switch', '跳转表', 'handler 表', '分支表', '间接跳转', 'br x', 'ldr pc', '回边', '主循环', 'while', '循环', '汇聚'] },
          { label: '字节码流：位于数据段、没有被代码引用的字节数组',
            hint: '那段「谁都不引用它」的数据，在 IDA 里长什么样？',
            any: ['字节码流', '数据段', '只读段', 'rodata', '数组', '常量', '没有被引用的数据', '乱码', 'bytecode', '基址', '字节数组'] },
          { label: '边界检查暴露 opcode 的合法范围 / 数量',
            hint: '分发之前那个 <code>cmp</code> + 跳转，告诉了你什么？',
            any: ['范围', '边界', 'cmp', '比较', '合法', '上限', '前哨', 'check', '个数', '多少条', '0x2b', '大小'] },
          { label: '热点特征：分发器是执行次数最多的位置',
            hint: '如果只能在一个地方下断点，为什么选它？',
            any: ['热点', '高频', '执行次数', '多次', '反复', '必经', '必经之路', '唯一', '都经过', '瓶颈', '采样', 'profiler', 'perf'] }
        ],
        hints: [
          '从「函数入口」和「被反复执行的那一小段」两个方向同时找，这两个位置在 VMP 里都是独一无二的。',
          '分发器的判据不是「它长得像 switch」——很多普通代码也长得像。想想它在<b>结构上</b>必须满足什么。'
        ],
        probes: [
          '你说靠跳转表识别分发器。如果厂商把表加密了、或者把 switch 打散成多层跳转，你还认得出它吗？靠什么？',
          '字节码流在 so 里可能根本没被静态引用。那你还怎么找到它？'
        ],
        model: '<b>找两个锚点：入口和心脏。</b><br><br>' +
               '<b>① vm_entry。</b>被保护函数的开头不会是业务代码，而是一段初始化样板：先把真实 CPU 寄存器成片保存到栈上（' +
               '<code>stp</code> / <code>push</code> 连发），因为虚拟机要征用这些寄存器当自己的基址寄存器；' +
               '接着 <code>ldr</code> 出两个「神秘常量」——它们是指向字节码流基址和 VMContext 基址的指针；' +
               '最后把虚拟 pc 清零。<b>为什么这是特征：</b>这段代码没有对应的业务调用，只为「换一套执行模型」而存在，' +
               '在任何普通函数里都找不到这种「保存一大片 + 载入几个地址常量」的组合。' +
               '<br><br><b>② 分发器。</b>判据不是形状而是<b>结构约束</b>：它是全程序唯一一个「每条字节码都必须经过」的位置，' +
               '因此必须满足三条——(a) 由一个从字节码流读出的值（opcode）间接决定跳转目标（switch 或跳转表）；' +
               '(b) 所有 handler 执行完都要无条件跳回它（<b>回边</b>）；(c) 它被执行成千上万次，是明显的热点。' +
               '三条同时成立的就只有分发器。<b>加固可以把它打散、混淆、复制多份，但「读 opcode → 跳 handler → 回到读 opcode」' +
               '这个语义环必须保留</b>——否则虚拟机就跑不起来了。' +
               '<br><br><b>③ 附带收获。</b>分发之前的 <code>cmp</code> + 条件跳转暴露了 <b>opcode 的合法范围</b>' +
               '（比如 0x00~0x2B），直接告诉你映射表大概要填多少条；如果跳转表没被加密，顺着基址寄存器过去就能 dump 出' +
               '「opcode → handler」的完整目录，让后续工作从盲扫变成按图索骥。' +
               '<br><br>最后补一句：<b>字节码流常常不是静态可找的</b>（可能运行时才解密到匿名内存）。' +
               '这时就靠 vm_entry 里那个基址常量的<b>运行时取值</b>来定位——这也是为什么动态能力是 VMP 分析的前提。',
        after: '<p>注意这题的答法：每个特征背后都要有一个「为什么它必然如此」的理由。找 VMP 靠的是结构约束，不是模式匹配。</p>'
      },

      /* ---------- Q3 ---------- */
      {
        id: 'c6q3', depth: 2, threshold: 0.7,
        q: '构建映射表时，你手上只有两个快照：执行前、执行后的 VMContext，以及 handler 内部的指令。' +
          '请说明<b>你的判定顺序</b>：怎么区分一条字节码是 <b>LDR</b>、<b>STR</b>、<b>ADD</b> 还是 <b>MOV</b>？',
        concepts: [
          { label: '第一步：先判断有没有 VMContext 之外的访存',
            hint: '先分大类。纯运算指令和内存访问指令，最本质的区别在哪？',
            any: ['访存', '内存访问', '访问内存', 'vmcontext 之外', '外部内存', '越界', '地址', '指针', 'load', 'store', '读内存', '写内存', 'memory access'] },
          { label: '有访存时，用方向区分 LDR / STR',
            hint: '同样是访问内存，读和写怎么从快照上看出来？',
            any: ['方向', '读还是写', '读/写', '读取', '写入', '读 = ldr', '写 = str', 'ldr', 'str', 'load/store', '源还是目标'] },
          { label: '无访存时，看 handler 里有没有 ALU 指令',
            hint: '没有访存的情况下，下一步该看什么？',
            any: ['运算', 'alu', '算术', '逻辑', 'add', 'sub', 'eor', 'xor', '移位', 'shl', '指令类型', '中间指令', '有没有计算'] },
          { label: '无 ALU 指令 = 纯搬运，等价 MOV',
            hint: '读一个寄存器、写另一个寄存器、中间什么都不做，这是什么指令？',
            any: ['搬运', '赋值', '拷贝', '复制', 'move', 'mov', '纯搬运', '无运算', '直接搬', '传送', '赋给'] },
          { label: '用快照 diff 定位源与目标字段',
            hint: '「谁读谁写」这件事，怎么自动算出来？',
            any: ['diff', '快照', '前后对比', '对比', '比较', '变化', '哪个字段变了', 'snapshot', '差异', '对比两个'] },
          { label: '顺带量出指令长度（含操作数）',
            hint: '为了能解析整条字节码流，你还必须多记一个什么数字？',
            any: ['长度', '指令长度', '几个字节', '吃掉', 'len', '变长', '操作数', '字节数', '步进'] }
        ],
        hints: [
          '把它变成一棵二分类树：先问最大的那个分叉，再问次级分叉。',
          '「有没有碰 VMContext 之外的内存」是第一刀；「碰的话是读还是写」是第二刀。剩下的才轮到运算。'
        ],
        probes: [
          '如果这条字节码既读了 VMContext 又写了 VMContext，但一个字段都没变，你会怎么解释？',
          '你 diff 出「只有 +0 变了」。你能立刻断定目标就是 +0 吗？有没有别的可能？'
        ],
        model: '<b>判定顺序是一棵二分类树，先分大类再细挑。</b><br><br>' +
               '<b>第一刀：有没有访存。</b>监视 handler 执行期间的所有内存访问。如果访问的地址<b>落在 VMContext 范围之外</b>' +
               '（尤其是「用某个虚拟寄存器的值当地址」这种间接访问），它就是内存访问指令家族；如果全程只碰 VMContext，' +
               '就是纯运算/搬运家族。<b>为什么这是第一刀：</b>因为这条分界线决定的数据流的本质——' +
               '一个是在虚拟机内部算，一个是要和外部世界交换数据，翻译成伪代码时形态完全不同。' +
               '<br><br><b>第二刀：方向。</b>访存指令里，读外部内存 → LDR，写外部内存 → STR。' +
               '判定依据是访问的权限（读/写）以及数据流向（进 VMContext 还是出 VMContext）。' +
               '<b>方向搞反是致命错误</b>——翻译出来的伪代码会面目全非，而且往往仍然「看起来合理」，极难发现。' +
               '<br><br><b>第三刀：ALU 指令。</b>没有访存的那些，读一眼 handler 内部：出现 add/sub/eor/移位一类的算术逻辑指令，' +
               '就是运算类（按具体指令决定是 ADD 还是 XOR 等等）；<b>一条 ALU 指令都没有</b>，只有 load/store 到 VMContext，' +
               '那就是纯搬运，等价于 MOV。' +
               '<br><br><b>贯穿全程的工具：快照 diff。</b>执行前后各取一份 VMContext，对比哪些字段变了。' +
               '变化的字段就是<b>写目标</b>；结合 handler 内部读的偏移，就得到<b>读源</b>。' +
               '四问法里的「源」和「目标」几乎可以全自动算出来，人只需要确认「方向」和「运算」这两项。' +
               '<br><br><b>别忘了第四项：指令长度。</b>即使语义判定全对，如果没记下这条字节码吃了几个字节（含操作数），' +
               '字节码流的解析就会从错位点开始全盘崩坏。它不属于「语义」，但它是让映射表可用的前提。',
        after: '<p>注意最后一段：<b>语义对了，表也不一定可用</b>。长度和字段偏移这两项，是实践中最常见的翻车点。</p>'
      },

      /* ---------- Q4 ---------- */
      {
        id: 'c6q4', depth: 3, threshold: 0.7,
        q: '本章的核心论断是：<b>把调试器放到 EL2（Hypervisor）层，反调试的「内存完整性检测」就会失效。</b>' +
          '请从原理层面解释这个论断——<b>并且说明它不能解决什么</b>。（后半句才是这题的重点）',
        concepts: [
          { label: 'stage-2 页表做 Guest 物理地址 → 真实物理地址的第二级翻译，带访问权限位',
            hint: 'EL2 靠什么机制来「拦住」一次内存访问？',
            any: ['stage-2', 'stage2', '第二级', '二级地址翻译', '页表', '权限位', '地址翻译', 'ipa', 'guest 物理地址', '中间物理地址', '翻译阶段', '两级翻译'] },
          { label: '命中时由 CPU 在翻译阶段陷入 EL2，Guest 内存零修改',
            hint: '断点生效的那一刻，目标内存被动过吗？',
            any: ['不修改', '没有修改', '不改内存', '不改动', '未改动', '一个字节', '无痕', '硬件', '陷入', 'trap', '异常', '拦截', '透明', '不可见', 'guest 观测不到', '没碰'] },
          { label: '内存完整性检测的前提被拿掉（校验和 / 断点指令 / 调试寄存器）',
            hint: '反调试那套「检查内存有没有被改」的手段，为什么全都落空？',
            any: ['校验和', 'checksum', '完整性', '首字节', '断点指令', 'brk', '调试寄存器', '检测前提', '前提', '失效', '发现不了', '检测不到', '落空', '没有痕迹'] },
          { label: '不能解决的：时间侧信道 / 执行耗时异常',
            hint: '内存没变，但有没有什么东西「变了」？想想执行速度和它留下的时间痕迹。',
            any: ['时间', '时序', '耗时', '延迟', 'timing', '侧信道', '性能', '变慢', '计时', '时间差', '耗时异常', '性能计数'] },
          { label: '不能解决的：硬件/内核适配限制与非内存类检测',
            hint: '这条路对设备和固件有什么要求？它对 root 检测、设备指纹这类问题有帮助吗？',
            any: ['适配', '设备', '机型', '刷不进', '锁', '启动链', '不支持', '版本', '限制', '不是万能', '有前提', '依赖设备', '硬件支持', 'root 检测', '设备指纹', '不解决', '解决不了'] }
        ],
        hints: [
          '先把「为什么失效」讲透：反调试的检测手段，全都建立在一个共同的前提上。那个前提是什么？',
          '再想「不能解决什么」：hypervisor 让内存保持不变，但一个程序被观测着运行，总会在别的维度留下点什么。'
        ],
        probes: [
          '你说「Guest 看不到 hypervisor」。那 Guest 有没有可能通过别的方式，间接推断出自己被虚拟化了？',
          '如果你的目标机型刷不进 hypervisor，这套方案还成立吗？你的替代路线是什么？'
        ],
        model: '<b>先说「为什么失效」。</b>经典反调试检测内存断点，全部依赖同一个前提：<b>断点会在目标内存里留下痕迹</b>。' +
               'EL0 的软件断点必须把断点指令（ARM 上如 <code>BRK</code>）写进目标地址，于是函数首字节对不上、代码段校验和变了；' +
               '硬件断点依赖调试寄存器，寄存器状态可读。这两种做法都在目标身上留下可观测的证据。' +
               '<br><br>EL2 走的是完全不同的路。ARM 虚拟化下有两级地址翻译：stage-1 把虚拟地址翻成 Guest 物理地址，' +
               '<b>stage-2 再把 Guest 物理地址翻成真实物理地址</b>，且每一项都带访问权限位。hypervisor 只要收紧目标页的权限，' +
               '程序一访问，CPU 在<b>翻译阶段</b>就抛出异常、直接陷入 EL2。<b>断点生效了，而那块内存从头到尾没被碰过。</b>' +
               '于是校验和一致、首字节一致、调试寄存器干净——反调试在忠实地工作，只是它要找的东西根本不存在。' +
               '这就是「纯硬件隔离的访问控制，Guest 完全不可见」。' +
               '<br><br><b>再说它不能解决什么（重点）。</b>' +
               '① <b>时间侧信道。</b>内存内容没变，但被 stage-2 拦截会让执行耗时出现异常。' +
               '一个足够偏执的加固方可以测量关键代码段的执行时间，或读取高精度计时器/性能计数器来发现「有东西在拦我」。' +
               '这条路的可行性高度依赖具体实现，<span class="pill warn">待核实</span>，但原理上它存在。' +
               '② <b>非内存类检测。</b>root 检测、设备指纹、调试器存在性检测（比如扫描进程列表、检测虚拟化环境痕迹）' +
               '都不在「内存完整性」这个范畴里，EL2 帮不上忙——那些要靠定制 ART、改设备环境等别的路线。' +
               '③ <b>硬件与适配约束。</b>这套方案要求设备/启动链允许 hypervisor 拿到 EL2，' +
               '而很多真机（尤其目标机型）根本刷不进去——这时你只能退到 EL1 定制内核，' +
               '代价是内存完整性检测这一关又回来了。' +
               '<br><br><b>结论：</b>EL2 不是「万能隐身衣」，它是把<b>特定一类</b>检测（内存完整性）从原理上删掉，' +
               '同时把「发现调试器」的成本抬高到绝大多数商业加固不会投入的程度。选它是因为<b>它精确命中了 VMP 场景的主要矛盾</b>，' +
               '而不是因为它无懈可击。',
        after: '<p>这题的关键在于后半句。能说出「EL2 解决什么」只算读懂了本章；能同时说出「它解决不了什么」，才算真的掌握了选型思维。</p>'
      },

      /* ---------- Q5 ---------- */
      {
        id: 'c6q5', depth: 3, threshold: 0.7,
        q: '<b>现在换边站。</b>假设你是加固方的架构师，已知攻击者会用「EL2 Hypervisor 调试」来逆你的 VMP。' +
          '基于本章讲过的原理，<b>你会怎么设计防御？请给出至少三条思路，并说明每一条的代价和局限。</b>',
        concepts: [
          { label: '时序检测：测量关键代码执行耗时、读高精度计时器',
            hint: '内存没被改，那还有什么维度会「露馅」？',
            any: ['时间', '时序', '耗时', '计时', 'rdtsc', 'cntvct', 'cntfrq', '侧信道', 'timing', '性能计数', '执行时间', '时间差'] },
          { label: '检测虚拟化环境本身（EL2 痕迹 / 系统寄存器）',
            hint: '能不能不去检测调试器，而是检测「自己被虚拟化了」这件事？',
            any: ['检测虚拟化', 'hypervisor 痕迹', '系统寄存器', 'hcr', 'vttbr', 'el2', '虚拟化扩展', '读系统寄存器', 'guest 标识', 'mrs', '虚拟化环境', '是否被虚拟化'] },
          { label: '代价：时序检测精度低、易误报、有性能开销',
            hint: '时间这种信号干净吗？会不会误伤正常用户？',
            any: ['误报', '精度', '噪声', '抖动', '不稳定', '性能', '开销', '代价', '影响体验', '卡顿', '不同机型', '阈值难定', '代价高'] },
          { label: '提高分析成本：多态 handler / 加密字节码 / 运行时随机化',
            hint: '就算他能在 EL2 观测，有没有办法让观测到的数据本身没用？',
            any: ['多态', '自修改', '加密', '随机化', '动态', '每次不同', '提高成本', 'handler 加密', '运行时生成', '膨胀', '膨胀体积', '混淆', '变形', '一变一密'] },
          { label: '把关键逻辑下沉到 TEE / 服务端，减少客户端暴露面',
            hint: '如果最核心的东西根本不在客户端跑，攻击者采到的映射表还有多大价值？',
            any: ['tee', 'trustzone', '安全世界', 'el3', '白盒', '服务端', '下沉', '减少暴露', '不放在客户端', '云端', '拆散', '分离', '关键逻辑放服务端'] },
          { label: '局限：这些手段都带来体积、性能、兼容性与开发维护成本',
            hint: '站在厂商角度，这些方案为什么不是免费的？',
            any: ['开销', '体积', '兼容', '成本', '开发', '维护', '稳定', '发热', '耗电', '性能下降', '工期', '收益递减', '不值得'] }
        ],
        hints: [
          '先承认一个前提：攻击者在 EL2，你在 Guest 里，你<b>观测不到他</b>。那你还能观测什么？',
          '换个方向想：不一定要「抓住他」，也可以让「他抓到的东西没用」——这对数据的形态提出了什么要求？'
        ],
        probes: [
          '你的时序检测把阈值定得很紧，结果在一批低端机上大面积误报、用户投诉。你怎么权衡？',
          '如果我把最核心的算法整个搬到服务端，客户端只留壳——那我的 VMP 还有什么意义？'
        ],
        model: '<b>先认清战场的不对称：他在 EL2，你在 Guest 里，你观测不到他。</b>所以防御思路必须从「抓调试器」转向' +
               '「抓他留下的<b>别的</b>痕迹」和「让他抓到的东西<b>没用</b>」。五条思路：' +
               '<br><br><b>① 时序检测。</b>内存内容没变，但 stage-2 拦截会让关键代码段的执行耗时异常。' +
               '可以测量一段已知工作量的代码的耗时、或读取高精度计时器做交叉验证。' +
               '<b>代价：</b>时序信号极不干净——不同机型、温度、调度、省电策略都会造成抖动，' +
               '阈值定紧了大面积误报（低端机上尤其明显），定松了又抓不到。<b>它是个概率武器，不是确定性检测。</b>' +
               '同时还有性能开销。<br><br>' +
               '<b>② 检测虚拟化环境本身。</b>不去找调试器，而是检测「自己是否运行在虚拟机里」——' +
               '读系统寄存器寻找 EL2 留下的痕迹、检查启动链特征等。' +
               '<b>代价：</b>需要针对具体 SoC / 固件做适配，兼容性负担重；而且这条线一旦被研究透，' +
               '攻击者可以在 hypervisor 里伪造对应读数，进入「检测与反检测」的长期拉锯。' +
               '<span class="pill warn">待核实</span>：具体哪些寄存器/特征在目标平台可用，需实测确认。' +
               '<br><br><b>③ 提高分析成本（我自己最看重的一条）。</b>既然无法阻止被观测，就让<b>观测到的数据本身失效</b>：' +
               '字节码流加密存储、运行时才解密；handler 多态化（同一 opcode 在不同上下文做不同事）；' +
               '甚至每次启动用随机密钥重新生成一套字节码编码。<b>代价：</b>体积膨胀、启动变慢、' +
               '开发与维护复杂度大幅上升，而且性能受影响；收益是<b>把攻击者的「采一次就够」变成「每次都得重采」</b>。' +
               '<br><br><b>④ 下沉关键逻辑。</b>把最值钱的算法搬到 TEE（安全世界）或干脆放服务端，客户端只留壳。' +
               '<b>代价：</b>依赖网络会伤体验、TEE 开发门槛高且受设备支持限制；' +
               '而且如果核心已经不在客户端，客户端这层 VMP 的投入产出比就要重新算。<br><br>' +
               '<b>⑤ 现实结论：没有免费午餐。</b>以上每一条都要付出体积、性能、兼容性或开发成本的代价，' +
               '而这些代价最终会转化成用户可感知的体验下降。<b>加固的本质是一场经济学博弈</b>——' +
               '目标不是造出攻不破的盾，而是把攻击成本抬到「破解收益 &lt; 破解成本」的那条线之上。' +
               '这也是为什么绝大多数商业加固根本不做 ① 和 ②：<b>不划算。</b>',
        after: '<p>能把这题答好，说明你对本章的理解已经从「工具使用者」上升到了「方案设计者」。' +
               '逆向和加固是同一枚硬币的两面，看懂对面为什么这么设计，你在这一侧的选择会清晰得多。</p>'
      }
    ]
  }
};
