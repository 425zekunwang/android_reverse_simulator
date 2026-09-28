/* 第 19 章 · 彻底搞懂 OLLVM
   数据文件：只依赖全局助手 T 与 chapter.js 的渲染器。
   官方信息已核实：OLLVM = Obfuscator-LLVM，开源代码混淆器，当前版本基于 LLVM 4.0；
   论文 = Junod / Rinaldini / Wehrli / Michielin, "Obfuscator-LLVM -- Software Protection for the Masses",
   IEEE/ACM SPRO 2015。官方三大特性 = Instructions Substitution(-sub)、Bogus Control Flow(-bcf)、
   Control Flow Flattening(-fla)，外加 Functions annotations（函数注解）。 */
window.CHAPTER = {
  no: 19,
  title: '彻底搞懂 OLLVM',
  lede: 'OLLVM 是加固世界的“入门门面”：<strong>平坦化、虚假控制流、指令替换</strong>三件套几乎出现在每一份被加固的 so 里。' +
        '本章从 <strong>LLVM Pass 机制</strong>讲起，拆开三大混淆的源码思路，自己编一个带混淆的 so 做对照实验，' +
        '最后给出逆向 OLLVM 的<strong>通用与非通用两条路线</strong>。',
  meta: [
    '核心问题：<b>OLLVM 到底对 IR 做了什么？为什么 IDA 反编译出来是一坨 switch？</b>',
    '关键工具：<b>LLVM / Clang、FunctionPass、OLLVM、NDK(CMake / Android.mk)、D-810、HexRaysDeob、动态 Trace</b>',
    '对手：<b>加固厂商定制的 OLLVM fork —— 加了字符串加密、间接跳转、打乱 Pass 顺序</b>'
  ],

  sections: [
    /* ============ 19.1 ============ */
    {
      h: '19.1',
      title: 'LLVM 三阶段编译器：战场在 IR，不在汇编',
      intuition: {
        tag: '直觉模型 · 装修队里的恶作剧设计师',
        body: '<p>把编译器想成一支装修队：<b>前端</b>负责量房出图纸（源码 → IR），<b>中端</b>是一群设计师在图纸上反复改（一堆 Pass 做优化），' +
              '<b>后端</b>才是按图纸施工的工人（IR → 机器码）。</p>' +
              '<p>OLLVM 就是混进中端的一个恶作剧设计师：它不换材料、不改功能，只是把图纸上的走廊全画成迷宫。' +
              '房子住起来一模一样（程序行为不变），但任何人拿到图纸都看不懂户型了。<b>它改的是图纸，不是房子</b> —— 这就是为什么' +
              '你 dump 出来的字符串还是明文，代码却完全读不懂。</p>'
      },
      html:
        '<p><b>OLLVM</b> 全称 <b>Obfuscator-LLVM</b>，是一个基于 LLVM 的开源代码混淆器，论文是 Junod / Rinaldini / Wehrli / Michielin 的 ' +
        '<i>Obfuscator-LLVM — Software Protection for the Masses</i>（IEEE/ACM SPRO 2015）。当前版本基于 <b>LLVM 4.0</b>。' +
        '国内加固厂商几乎人手一个它的 fork，所以你遇到“看不懂的 so”，多半就是它的徒子徒孙。</p>' +
        '<p>要逆向它，必须先接受一个反直觉的事实：<b>混淆发生在 IR 层，不发生在汇编层</b>。它的输入是 C/C++，' +
        '它的手术对象是 LLVM IR，汇编只是它顺手吐出来的副产品。</p>' +
        T.tbl(
          ['阶段', '输入 → 输出', '谁在干活', 'OLLVM 在哪插刀'],
          [
            ['前端 Frontend', 'C/C++ 源码 → <b>LLVM IR</b>', 'Clang 词法/语法/语义分析', '不碰（它读不懂源码语义）'],
            ['中端 Middle-end', '<b>IR → 优化后 IR</b>', '一串 <b>Pass</b>（内联、GVN、死代码消除…）', '<b>就在这里，注册三个自定义 Pass</b>'],
            ['后端 Backend', 'IR → 目标机器码', '指令选择、寄存器分配、调度', '不碰（此时结构已被定型）']
          ]
        ) +
        T.note('key', '🔑 一句话建立坐标',
          '<p>OLLVM 的三大混淆，本质就是<b>往 LLVM 中端插了三个自定义 Pass</b>：<span class="pill acc">-fla</span> 控制流平坦化、' +
          '<span class="pill acc">-bcf</span> 虚假控制流、<span class="pill acc">-sub</span> 指令替换。' +
          '官方 wiki 里它们对应 <code>-mllvm -fla</code> / <code>-mllvm -bcf</code> / <code>-mllvm -sub</code> 三个开关。</p>') +
        T.note('', '🧭 为什么逆向工程师要懂编译器',
          '<p>因为三大混淆<b>都不是加密，而是结构变形</b>。加密你还能找密钥，结构变形你只能理解<b>生成规则</b>。' +
          '不懂 IR 和 Pass，你就永远停留在“受害者视角”——只能抱怨 IDA 输出一坨 switch；' +
          '懂了生成规则，你才知道那坨 switch 是<b>可还原的</b>，还原依据是它的状态变量。</p>') +
        T.note('warn', '⚠️ 一个必须先纠正的常见误解',
          '<p><b>字符串加密不是 OLLVM 官方特性。</b>官方 wiki 只列了三大混淆 + 函数注解（Functions annotations）。' +
          '你看到的“字符串全被加密成 byte 数组”，是<b>后续 fork / 加固厂商自己加的</b>。' +
          '课程把它和三大混淆并列讲，是因为国内加固实践里它们总是一起出现，但<b>归因别搞错</b>（详见 19.8）。</p>') +
        '<p>术语先混个脸熟：' + T.term('IR', 'Intermediate Representation，中间表示。LLVM 的核心资产，一种类型化、SSA 形式的类汇编语言') + '、' +
        T.term('Pass', '作用于 IR 的转换或分析单元，是 LLVM 里一切优化的基本砖块') + '、' +
        T.term('OLLVM', 'Obfuscator-LLVM，把混淆做成 LLVM Pass 的开源项目') + '。</p>'
    },

    /* ============ 19.2 ============ */
    {
      h: '19.2',
      title: 'LLVM Pass 机制：OLLVM 的全部魔法都在这里（源码级）',
      html:
        '<p>OLLVM 之所以“优雅”，是因为它<b>没有发明任何新东西</b>，只是把 LLVM 自带的 Pass 框架用到了极致。' +
        '你只要看懂一个 <code>runOnFunction</code>，就等于看懂了三大混淆的骨架。</p>' +
        T.tbl(
          ['Pass 类型', '作用范围', '入口函数', '典型用途'],
          [
            ['<b>ModulePass</b>', '整个模块（一个 .bc / 一个编译单元）', '<code>runOnModule</code>', '跨函数分析、插桩、全局重命名'],
            ['<b>FunctionPass</b>', '<b>单个函数</b>', '<code>runOnFunction</code>', '<b>OLLVM 三大混淆全部属于这一类</b>'],
            ['<b>BasicBlockPass</b>', '单个基本块', '<code>runOnBasicBlock</code>', '局部的窥孔式改写'],
            ['<b>LoopPass</b>', '单个循环（自然循环）', '<code>runOnLoop</code>', '循环不变量外提、展开']
          ]
        ) +
        T.note('key', '🔑 为什么 OLLVM 选 FunctionPass',
          '<p>因为混淆的<b>合理作用域就是函数</b>：控制流平坦化要重排一个函数的全部基本块，虚假控制流要在函数内部造分支，' +
          '指令替换只看单条指令。超过函数范围（ModulePass）会互相打架、签名对不上；小于函数范围（BasicBlockPass）又看不见全局结构。' +
          '<b>基本块是它操作的原子单位</b>。</p>') +
        '<p>四个必须记住的 API（后面读源码全靠它们）：</p>' +
        '<ul>' +
        '<li><code>Function::getBasicBlockList()</code> / 范围 for 循环 —— <b>拿到函数里所有基本块</b>，这是混淆的第一步。</li>' +
        '<li><code>BasicBlock::getInstList()</code> —— 拿到块内指令链表，删改指令从这里下手。</li>' +
        '<li><code>IRBuilder&lt;&gt;</code> —— <b>插入新指令的构造器</b>，比裸调 <code>new AddInst(...)</code> 干净得多，自动维护 SSA 与插入点。</li>' +
        '<li><code>SplitBlock</code> / <code>SplitEdge</code>（位于 <code>Transforms/Utils/BasicBlockUtils.h</code>）—— <b>切分基本块与边</b>，' +
        '这是插入“序言块”的关键工具。</li>' +
        '</ul>' +
        '<p>下面用一个 Pass 的完整骨架，把 <code>-fla</code> 的注册与改写流程走一遍。注意每一步都在动<b>同一个函数对象</b>。</p>',
      stepper: {
        title: '一个 OLLVM 风格 Pass 的骨架：从注册到改写基本块',
        lines: [
          {
            code: '<span class="c">// 一个 Pass 就是一个类，继承谁 = 声明作用范围</span>\n' +
                  '<span class="k">namespace</span> { <span class="k">struct</span> <span class="t">FlaPass</span> : <span class="k">public</span> <span class="t">FunctionPass</span> {',
            note: '<b>先立规矩：作用范围由基类决定。</b>继承 <code>FunctionPass</code>，LLVM 就会对模块里<b>每一个函数</b>各调用你一次。' +
                  'OLLVM 的 fla / bcf / sub 三个 Pass 都是这么声明的。',
            state: { '当前动作': '声明 Pass 类', '作用范围': '单个函数', '是否改写 IR': '否' }
          },
          {
            code: '  <span class="k">static</span> <span class="k">char</span> <span class="t">ID</span>;\n' +
                  '  <span class="t">FlaPass</span>() : <span class="f">FunctionPass</span>(ID) {}',
            note: '<b>ID 是 Pass 的身份证。</b>LLVM 用这个静态 ID 在 Pass 注册表里唯一标识它；' +
                  '命令行上的 <code>-mllvm -fla</code> 最终就是按名字找到这个 Pass 并调度它。',
            state: { '当前动作': '分配 Pass ID', '注册名': 'fla', '是否改写 IR': '否' }
          },
          {
            code: '  <span class="k">bool</span> <span class="f">runOnFunction</span>(<span class="t">Function</span> &amp;F) <span class="k">override</span> {',
            note: '<b>唯一的必写入口。</b>参数是<b>引用</b>不是拷贝 —— 你改的 <code>F</code> 就是模块里那个函数本身，改完不需要“返回”什么，' +
                  '所以逆向时看到的混淆是<b>原地发生</b>的。',
            state: { '当前动作': '进入函数入口', '函数': '待处理', '是否改写 IR': '否' }
          },
          {
            code: '    <span class="k">if</span> (!<span class="f">toObfuscate</span>(flag, &amp;F, <span class="s">&quot;fla&quot;</span>)) <span class="k">return</span> <span class="n">false</span>;',
            note: '<b>函数注解过滤（Functions annotations）。</b>OLLVM 支持只混淆被标注的函数，其余原样放过 —— ' +
                  '所以同一个 so 里往往<b>只有一部分函数被混淆</b>，这正是你定位关键函数的突破口。' +
                  '<span class="pill warn">注解的确切写法随 fork 而异，待核实</span>',
            state: { '当前动作': '命中注解才继续', '未命中': '原样返回 false', '是否改写 IR': '否' }
          },
          {
            code: '    <span class="t">std::vector</span>&lt;<span class="t">BasicBlock</span> *&gt; origBB;\n' +
                  '    <span class="k">for</span> (<span class="t">BasicBlock</span> &amp;BB : F) origBB.<span class="f">push_back</span>(&amp;BB);',
            note: '<b>第一步永远是“拍照存底”。</b>把函数当前的所有基本块按顺序存进 <code>origBB</code>，' +
                  '后面建 switch、分配 case 编号、改跳转，全靠这张表。<span class="hit">列表顺序 = 原始基本块顺序</span>。',
            state: { '当前动作': '收集基本块', '已收集块数': 'N（本函数全部分支）', '是否改写 IR': '否' }
          },
          {
            code: '    <span class="t">BasicBlock</span> *disp = <span class="t">BasicBlock</span>::<span class="f">Create</span>(\n' +
                  '        F.<span class="f">getContext</span>(), <span class="s">&quot;disp&quot;</span>, &amp;F, &amp;F.<span class="f">getEntryBlock</span>());',
            note: '<b>造“分发器”基本块。</b>注意最后一个参数是“插在哪个块之前” —— 它被插到函数入口块<b>前面</b>，' +
                  '将来全函数唯一的公共枢纽。IDB 里那个巨大的 <code>switch</code> 就在这个块里。',
            state: { '当前动作': '创建分发器 disp', '已收集块数': 'N', '是否改写 IR': '是' }
          },
          {
            code: '    <span class="t">IRBuilder</span>&lt;&gt; B(&amp;F.<span class="f">getEntryBlock</span>());\n' +
                  '    <span class="t">Value</span> *switchVar = B.<span class="f">CreateAlloca</span>(<span class="t">Int32Ty</span>);',
            note: '<b>造状态变量 switchVar。</b>它就是个普通局部变量（alloca 在栈上）—— ' +
                  '但它是整个平坦化的<b>唯一真相来源</b>：程序下一步去哪，全看它的值。' +
                  '<span class="hit">反混淆的核心就是追它</span>。',
            state: { '当前动作': '创建状态变量', 'switchVar': '未初始化', '是否改写 IR': '是' }
          },
          {
            code: '    <span class="t">SwitchInst</span> *sw = <span class="t">SwitchInst</span>::<span class="f">Create</span>(\n' +
                  '        switchVar, disp, <span class="n">0</span>, disp);',
            note: '<b>在分发器里建 switch。</b>第二个参数是默认目标，第四个是插入点。默认目标也指向 disp —— ' +
                  '在 case 填满之前，它就是个<b>空转的死循环</b>，这也是静态看非常可疑的结构特征。',
            state: { '当前动作': '创建 switch 指令', 'switchVar': '未初始化', 'case 数': '0' }
          },
          {
            code: '    <span class="k">for</span> (<span class="k">unsigned</span> i = <span class="n">0</span>; i &lt; origBB.<span class="f">size</span>(); i++)\n' +
                  '      sw-&gt;<span class="f">addCase</span>(<span class="t">ConstantInt</span>::<span class="f">get</span>(Int32Ty, i), origBB[i]);',
            note: '<b>每个原始基本块变成一个 case。</b>块 0 = case 0、块 1 = case 1…… 编号与原始顺序一致。' +
                  '到这里，<b>原来的 if / while 关系已经消失，只剩“编号 → 块”的映射表</b>。',
            state: { '当前动作': '分配 case 编号', 'case 数': 'N', '映射': 'i → origBB[i]' }
          },
          {
            code: '    <span class="k">for</span> (每个原始跳转边 from→to) {\n' +
                  '      <span class="t">BasicBlock</span> *pro = <span class="f">SplitEdge</span>(from, to);\n' +
                  '      <span class="k">new</span> <span class="t">StoreInst</span>(nextState, switchVar, pro);',
            note: '<b>最关键的一刀：把每条边切成两块，在中间塞“序言块”。</b>序言块只做两件事：' +
                  '<span class="pill acc">把下一状态写进 switchVar</span> → <span class="pill acc">跳回 disp</span>。' +
                  '于是“跳去哪个块”变成了“给变量赋哪个值”。',
            state: { '当前动作': '插入序言块', '序言块作用': '赋值 + 跳回 disp', '是否改写 IR': '是' }
          },
          {
            code: '    <span class="k">return</span> <span class="n">true</span>;   <span class="c">// 告诉 PassManager：我改了 IR</span>\n' +
                  '  }\n}; }\n<span class="k">static</span> <span class="t">RegisterPass</span>&lt;<span class="t">FlaPass</span>&gt; <span class="t">X</span>(<span class="s">&quot;fla&quot;</span>, <span class="s">&quot;Enable control flow flattening&quot;</span>);',
            note: '<b>返回值语义别搞错：</b><code>true</code> = “我改过这个函数”，PassManager 据此让失效的分析结果重算，' +
                  '并可能重跑后续 Pass。<code>false</code> = 我没动它。<b>谎报 false 会导致整个优化管线拿到过期数据</b>。' +
                  '最后一行把 Pass 注册进 CLI，这就是 <code>-mllvm -fla</code> 的来源。',
            state: { '当前动作': '收尾 + 注册', '返回值': 'true（已修改）', 'CLI': '-mllvm -fla' }
          }
        ]
      },
      after: T.note('ok', '✅ 你已经掌握了 OLLVM 的“通用骨架”',
        '<p>记住这个节奏：<b>收集基本块 → 造新块 → 用 IRBuilder 插指令 → 改跳转 → 返回 true</b>。' +
        '三大混淆都是这个骨架的不同填法。另外注意版本差异：LLVM 4.0（OLLVM 当前基线）用旧的 ' +
        '<code>legacy::PassManager</code> + <code>RegisterPass</code>；新版本 LLVM 已转向 <code>PassBuilder</code> + 新 Pass Manager' +
        '（<code>run(Function &amp;, FunctionAnalysisManager &amp;)</code>）。' +
        '所以拿新版 LLVM 直接编老 OLLVM 源码会<b>编译失败</b>，这不是你的问题。</p>')
    },

    /* ============ 19.3 ============ */
    {
      h: '19.3',
      title: '控制流平坦化 -fla：把 if/while 拆成 switch 状态机（动画拆解）',
      html:
        '<p><code>-fla</code>（Control Flow Flattening）是三大混淆里<b>视觉冲击最大</b>的一个，也是你打开 IDA 第一眼看到的东西：' +
        '一个巨大的 <code>switch</code> 套在 <code>while(1)</code> 里，几十个 <code>case</code> 互相跳来跳去。</p>' +
        '<p>它的源码思路只有四步：<b>① 收集函数所有基本块 ② 造分发器 dispatcher，用 switch 按状态变量跳转 ' +
        '③ 为每条原始边生成序言块（写下一状态 → 跳回分发器） ④ 原始基本块变成 switch 的 case</b>。</p>' +
        '<p>下面这段代码就是要被平坦化的受害者，它的 CFG 只有 5 个基本块：</p>' +
        T.code('<span class="k">int</span> <span class="f">check</span>(<span class="k">int</span> x) {\n' +
               '  <span class="k">int</span> r = <span class="n">0</span>;\n' +
               '  <span class="k">if</span> (x &amp; <span class="n">1</span>) r = <span class="n">10</span>;   <span class="c">// B1 条件分支 → B2 / B3</span>\n' +
               '  <span class="k">else</span>        r = <span class="n">20</span>;\n' +
               '  <span class="k">return</span> r;               <span class="c">// B4 汇合</span>\n' +
               '}') +
        '<p>点击播放，看着这 5 个块一步步变成“分发器 + 状态机”。<b>请特别留意右侧 switchVar 的取值序列</b> —— ' +
        '那是后面反混淆的唯一钥匙。</p>',
      stage: {
        title: '控制流平坦化：从可读 CFG 到 switch 状态机',
        speed: 2100,
        render:
          '<div class="grid2">' +
            '<div class="card"><div class="card-title">混淆前 · 原始 CFG（5 个基本块）</div>' +
              '<div class="flow-col">' +
                '<span class="blk" id="c0">B0 · 入口 r=0</span>' +
                '<span class="arrow">↓</span>' +
                '<span class="blk" id="c1">B1 · if (x&amp;1)</span>' +
                '<div class="flow-row">' +
                  '<span class="blk" id="c2">B2 · r=10</span>' +
                  '<span class="muted">◀ 二选一 ▶</span>' +
                  '<span class="blk" id="c3">B3 · r=20</span>' +
                '</div>' +
                '<span class="arrow">↓</span>' +
                '<span class="blk" id="c4">B4 · return r</span>' +
              '</div>' +
            '</div>' +
            '<div class="card"><div class="card-title">混淆后 · 平坦化状态机</div>' +
              '<div class="flow-col">' +
                '<span class="blk" id="d0">disp · switch(switchVar)</span>' +
                '<span class="arrow">↑ ↓ 每条边都回到这里</span>' +
                '<div class="flow-row">' +
                  '<span class="blk" id="s0">case 0</span><span class="blk" id="s1">case 1</span>' +
                  '<span class="blk" id="s2">case 2</span><span class="blk" id="s3">case 3</span>' +
                  '<span class="blk" id="s4">case 4</span>' +
                '</div>' +
                '<span class="arrow">↓</span>' +
                '<span class="blk" id="p0">序言块 · 写下一状态 然后跳回 disp</span>' +
              '</div>' +
              '<div class="memgrid" style="margin-top:10px">' +
                '<div class="memrow"><span class="addr">switchVar</span><span class="cell" id="cellv">-</span></div>' +
              '</div>' +
            '</div>' +
          '</div>',
        reset: () => {
          S('c0', ''); S('c1', ''); S('c2', ''); S('c3', ''); S('c4', '');
          S('d0', ''); S('s0', ''); S('s1', ''); S('s2', ''); S('s3', ''); S('s4', ''); S('p0', '');
          CLS('cellv', 'cell'); SET('cellv', '-');
          SET('d0', 'disp · switch(switchVar)');
          SET('p0', '序言块 · 写下一状态 然后跳回 disp');
        },
        steps: [
          {
            run: () => { S('c0', 'active'); SET('cellv', '未分配'); },
            note: '<b>起点：一个老实的 CFG。</b>B0 是入口。<code>switchVar</code> 这时候还不存在 —— ' +
                  '混淆器还没动手，控制流由 <b>CPU 的跳转指令</b>直接表达：<code>if (x&amp;1)</code> 编译成一条条件跳转。'
          },
          {
            run: () => { S('c0', 'done'); S('c1', 'active'); },
            note: '<b>人眼读这个 CFG 毫无压力：</b>走过 B0 到 B1，判断 <code>x&amp;1</code>，然后二选一。' +
                  'IDA 的 F5 之所以能还原出漂亮的 <code>if/else</code>，靠的就是这种“<b>一个块有两条出边</b>”的结构特征。'
          },
          {
            run: () => { S('c1', 'done'); S('c2', 'active'); },
            note: '<b>假设走 true 分支。</b>注意此刻“下一步去哪”这件事，是<b>写在跳转指令里</b>的（跳或不跳），' +
                  '只有一个 bit 的信息，静态分析极易恢复。'
          },
          {
            run: () => { S('c2', 'done'); S('c4', 'active'); },
            note: '<b>B2 → B4 汇合。</b>到这里，一条完整的可读执行路径结束。' +
                  '接下来我们要把这个结构<b>彻底抹掉</b>。'
          },
          {
            run: () => { S('c0', 'cool'); S('c1', 'cool'); S('c2', 'cool'); S('c3', 'cool'); S('c4', 'cool'); },
            note: '<b>第 ① 步：收集全部基本块。</b>源码就是 <code>for (BasicBlock &amp;BB : F) origBB.push_back(&amp;BB);</code>。' +
                  '<span class="hit">绿色代表“这些块已经被登记，等待被重排”</span>。'
          },
          {
            run: () => { CLS('cellv', 'cell hi'); SET('cellv', '0 → B0'); },
            note: '<b>第 ② 步：创建状态变量 switchVar。</b>它就是个普通的栈上变量（<code>CreateAlloca</code>），' +
                  '但从此以后<b>整个函数的控制权都交给它</b>。初值 0，代表“从头开始”。'
          },
          {
            run: () => { S('d0', 'active'); },
            note: '<b>第 ③ 步：造分发器 disp。</b>它被插到函数入口块前面，成为<b>全函数唯一的公共枢纽</b>。' +
                  '所有块执行完都回这里，由它决定下一站。'
          },
          {
            run: () => { S('d0', 'active'); SET('d0', 'disp · switch(switchVar) 5 cases'); },
            note: '<b>第 ④ 步：在 disp 里建 switch 指令。</b>' +
                  '<code>SwitchInst::Create(switchVar, disp, 0, disp)</code> —— 默认目标也指向 disp，' +
                  '所以还没填 case 时它是个<b>空转死循环</b>。'
          },
          {
            run: () => { S('s0', 'cool'); S('s1', 'cool'); S('s2', 'cool'); S('s3', 'cool'); S('s4', 'cool'); S('d0', 'active'); },
            note: '<b>第 ⑤ 步：每个原始块变成一个 case。</b>块 0 = case 0、块 1 = case 1……编号顺序<b>就是原始顺序</b>。' +
                  '此刻原来的 <code>if</code> 已经不存在了 —— 只剩下“<b>编号 → 块</b>”的映射表。'
          },
          {
            run: () => { S('p0', 'active'); SET('p0', '序言块 · switchVar = ? 然后跳回 disp'); },
            note: '<b>第 ⑥ 步（最关键）：拆边插序言块。</b>对每一条原始边 from→to，用 <code>SplitEdge</code> 把边切成两段，' +
                  '中间塞一个只做两件事的小块：<span class="pill acc">写下一状态</span> + <span class="pill acc">跳回 disp</span>。'
          },
          {
            run: () => { SET('cellv', '0'); S('s0', 'active'); S('d0', 'done'); S('p0', 'cool'); },
            note: '<b>现在开始“动态跑一遍”。</b>switchVar=0 → disp 分发到 case 0（原 B0）。' +
                  'B0 执行完不再直接跳 B1，而是经过序言块去改状态变量。'
          },
          {
            run: () => { SET('cellv', '1'); S('s0', 'done'); S('s1', 'active'); },
            note: '<b>序言块把 1 写进 switchVar，跳回 disp，分发到 case 1（原 B1）。</b>' +
                  '“跳去 B1” 这件事，被翻译成了“把变量设成 1”。<span class="miss">跳转指令消失了，取而代之的是数据</span>。'
          },
          {
            run: () => { SET('cellv', '2'); S('s1', 'done'); S('s2', 'active'); },
            note: '<b>case 1 判断 x&amp;1，走 true，序言块写 2。</b>注意分支结果现在体现为<b>两个不同的常数</b>：' +
                  '走 true 写 2、走 false 写 3。逆向时你看不到“条件跳转”，只看到“给变量赋值 2 或 3”。'
          },
          {
            run: () => { SET('cellv', '4'); S('s2', 'done'); S('s4', 'active'); },
            note: '<b>case 2 → 序言块写 4 → case 4（原 B4）。</b>至此一次完整执行的状态序列是：' +
                  '<span class="hit">0 → 1 → 2 → 4 → 退出</span>。' +
                  '<b>这就是全部真相</b>：路径被完整地编码进了一串整数。'
          },
          {
            run: () => { S('d0', 'hot'); SET('cellv', '0 → 1 → 2 → 4'); },
            note: '<b>IDA 的视角。</b>它看到的是：一个 <code>while(1)</code>，里面一个 <code>switch</code>，' +
                  '几十个 <code>case</code>，每个 case 结尾都改一个变量再 <code>continue</code>。' +
                  '<span class="miss">它没有任何理由认为这是 if/else</span>，只能老老实实输出 switch —— 这就是“反编译成一坨”的机制原因。'
          },
          {
            run: () => { S('d0', 'cool'); S('s0', 'active'); S('s2', 'active'); S('s4', 'active'); SET('cellv', '0 → 1 → 2 → 4'); },
            note: '<b>破法已经浮出水面。</b>静态看不懂没关系 —— ' +
                  '<b>把 switchVar 的实际取值序列 Trace 出来</b>，按顺序把 case 0 → 1 → 2 → 4 拼起来，' +
                  '真实路径就还原了。这正是动态 Trace 与 D-810 这类插件的立足点。'
          }
        ]
      },
      after: T.note('key', '🔑 平坦化的“可还原性”从哪来',
        '<p>平坦化<b>不是加密</b>：状态变量是<b>确定性的</b>，同一条输入必然产生同一串状态值。' +
        '所以还原路径有三条通用路子：<b>① 动态 Trace 状态变量</b>（最稳，见 19.9）；' +
        '<b>② 静态识别分发器 + 追踪常量赋值</b>（D-810 的思路）；' +
        '<b>③ 符号执行走一遍</b>。三条路都在回答同一个问题：<span class="hit">switchVar 的取值序列是什么</span>。</p>') +
        T.note('warn', '⚠️ 别被“一个 switch”骗了',
        '<p>真实加固样本里常见<b>多层嵌套平坦化</b>（混淆器跑多轮）和 <b>状态变量被拆成多个</b>（switchVar 与另一个变量异或后再算）。' +
        '还有些 fork 把 case 编号<b>随机化</b>而不是 0..N 顺序。这些都不改变原理，但会让你手写脚本时踩坑：' +
        '<b>不要假设编号连续、不要假设只有一个状态变量</b>。</p>')
    },

    /* ============ 19.4 ============ */
    {
      h: '19.4',
      title: '虚假控制流 -bcf：靠“恒真条件”把 1 条路变成 2 条',
      html:
        '<p><code>-bcf</code>（Bogus Control Flow）的目标和 <code>-fla</code> 不同：平坦化是<b>重排结构</b>，' +
        '虚假控制流是<b>往结构里灌垃圾分支</b>，让任何静态分析都要多算几百条根本走不到的路。</p>' +
        '<p>它的核心武器是 <b>不透明谓词（opaque predicate）</b>：一个<b>结果恒定、但编译器/反编译器静态难以化简</b>的表达式。' +
        '把原基本块拆成“真块”和“假块”，假块塞满垃圾指令，再插一条 ' +
        '<code>if (opaque) 正常路径 else 垃圾路径</code>。</p>' +
        '<p>下面是 OLLVM 里最经典的几种不透明谓词构造，以及它们<b>为什么恒真</b>的数学证明：</p>' +
        T.tbl(
          ['构造式', '恒真/恒假', '证明（一句话）', '反编译器为什么看不穿'],
          [
            ['<code>y = x * x % 2 == 0</code>', '恒真（x 为整数）', '平方的奇偶性：<code>x²</code> 与 <code>x</code> 同奇偶，但 <code>x²</code> 的因子指数翻倍 —— 更直接的版本是 <code>x*(x+1) % 2 == 0</code>', '要先证明“平方不改变奇偶性”，再证明偶数模 2 为 0；GVN 通常只做局部化简，不做数论推理'],
            ['<code>y = x * (x + 1) % 2 == 0</code>', '<b>恒真</b>', '<code>x</code> 与 <code>x+1</code> 是连续整数，必有一个是偶数 ⇒ 乘积必为偶数 ⇒ 模 2 恒为 0', '反编译器不会对 <code>x*(x+1)</code> 做“连续整数”这种代数归纳'],
            ['<code>y = (x ^ (x - 1)) &gt; x</code>', '<b>恒假</b>（在常见变体中用于构造死分支）', '当 <code>x=0</code> 时为 <code>-1 &gt; 0</code> 即假；需按具体变体逐例验证 <span class="pill warn">具体变体待核实</span>', '涉及位运算与符号语义的混合推理'],
            ['<code>y = ((x | 1) * (x | 1)) % 2 == 0</code>', '恒假（<code>x|1</code> 必为奇数，奇² 仍为奇数）', '强制低位为 1 ⇒ 奇数 ⇒ 平方仍是奇数 ⇒ 模 2 得 1', '同样需要“奇数平方仍是奇数”这一步推理']
          ]
        ) +
        T.note('key', '🔑 不透明谓词的本质：把“数学事实”伪装成“运行时条件”',
          '<p>编译器做的是<b>局部、保守、快</b>的化简（常量折叠、GVN、稀疏条件传播）。' +
          '不透明谓词刻意选那些<b>需要一两步代数归纳才能证明</b>的恒等式 —— 证明成本略高于编译器的预算，它就活下来了。' +
          '对逆向者而言这是好消息：<b>你不需要真的去证明它，你只需要跑一遍看它走哪条路</b>。</p>') +
        T.note('ok', '✅ 破解关键：死代码永远不会出现在动态 trace 里',
          '<p>这是 <code>-bcf</code> 最大的软肋。垃圾分支<b>结构上存在，执行上永远不进入</b>。' +
          '所以只要你在真实设备上跑一遍并记录执行过的地址（模块基址 + 偏移），垃圾块的偏移<b>一次都不会出现</b>，' +
          '把没出现过的块全部删掉，控制流立刻瘦身回可读状态。这也是为什么 <b>动态 Trace 是对付 bcf 性价比最高的手段</b>。</p>') +
        T.note('warn', '⚠️ 反过来说：静态去 bcf 是“体力活”',
          '<p>纯静态方案（D-810 / HexRaysDeob 这类）必须<b>先判定谓词恒真</b>，再删死分支。' +
          '由于谓词构造是无限的（加固厂商会自己加变体），静态规则库总有漏网之鱼。' +
          '更麻烦的是：<code>-bcf</code> 常和 <code>-fla</code> 叠加使用 —— 垃圾分支也被塞进 case 列表里，' +
          '于是你面对的是一个“平坦化 + 一堆走不到的 case”的复合体。</p>')
    },

    /* ============ 19.5 ============ */
    {
      h: '19.5',
      title: '指令替换 -sub：值一模一样，指令面目全非',
      html:
        '<p><code>-sub</code>（Instructions Substitution）是三件套里<b>最“温柔”</b>的一个：它不改控制流，只把一条二元运算' +
        '换成<b>数学上等价</b>的一串更复杂的运算。官方支持 <code>add</code> / <code>sub</code> / <code>and</code> / <code>or</code> / <code>xor</code>。</p>' +
        '<p>它的迷惑性在于：<b>你读到的东西和 CPU 实际算的东西对不上</b>。你在反编译窗口里看到五个操作，' +
        '寄存器里其实只发生了一次加法。下面是几条必须刻进肌肉记忆的等价变形（全部是真实成立的数学等价式）：</p>' +
        T.tbl(
          ['原始运算', '等价变形', '验证要点'],
          [
            ['<code>a + b</code>', '<code>a - (-b)</code>', '减去相反数 = 加上本身'],
            ['<code>a + b</code>', '<code>a - (~b) - 1</code>', '<code>~b = -b - 1</code> ⇒ <code>a - ~b - 1 = a + b + 1 - 1 = a + b</code>'],
            ['<code>a + b</code>', '<code>(a ^ b) + 2 * (a &amp; b)</code>', '半加器思想：异或得无进位和，与运算得进位，进位左移一位相加'],
            ['<code>a - b</code>', '<code>a + (~b) + 1</code>', '补码定义：<code>-b = ~b + 1</code>，减法即加补码'],
            ['<code>a ^ b</code>', '<code>(a | b) - (a &amp; b)</code>', '并集减去交集 = 对称差'],
            ['<code>a ^ b</code>', '<code>(~a &amp; b) | (a &amp; ~b)</code>', '按定义展开：恰好一个为 1 的位'],
            ['<code>a | b</code>', '<code>(a &amp; ~b) + b</code>', '先把 a 中与 b 重叠的位清掉再加回来']
          ]
        ) +
        '<p>下面把 <code>a + b</code> 展开成 <code>(a ^ b) + 2 * (a &amp; b)</code> 逐步跑一遍。' +
        '案例取 <code>a = 0x3</code>、<code>b = 0x5</code>。<b>请盯住每一步的寄存器值，尤其最后两行。</b></p>',
      stepper: {
        title: '指令替换：a + b 的等价展开（盯着寄存器别眨眼）',
        lines: [
          {
            code: '<span class="c">// 原始源码（人写的）</span>\n<span class="k">int</span> r = a + b;',
            note: '<b>正常世界的样子。</b>一条加法，IDA 反编译出来就是一句话。' +
                  '接下来 OLLVM 会把这条指令“替换”掉 —— 注意是<b>替换 IR 里的指令</b>，不是包一层函数，所以没有任何调用痕迹。',
            state: { 'a': '0x3', 'b': '0x5', 'r': '未计算' },
            mem: '原始指令序列:\nadd  r, a, b\n\n长度: 1 条'
          },
          {
            code: '<span class="c">// -sub 替换后（编译器眼里的样子）</span>\n' +
                  '<span class="k">int</span> t1 = a ^ b;\n' +
                  '<span class="k">int</span> t2 = a &amp; b;\n' +
                  '<span class="k">int</span> t3 = t2 &lt;&lt; <span class="n">1</span>;\n' +
                  '<span class="k">int</span> r  = t1 + t3;',
            note: '<b>替换发生了。</b>一条加法变成四条指令。' +
                  '这是<b>半加器</b>的经典分解：<code>a ^ b</code> 给出<b>不进位的和</b>，<code>a &amp; b</code> 给出<b>进位</b>，' +
                  '进位左移一位再相加。数学上完全等价，但<b>字面上已经认不出是加法了</b>。',
            state: { 'a': '0x3', 'b': '0x5', 't1': '待算', 't2': '待算', 'r': '未计算' },
            mem: '替换后指令序列:\nxor  t1, a, b\nand  t2, a, b\nshl  t3, t2, #1\nadd  r,  t1, t3\n\n长度: 4 条'
          },
          {
            code: '<span class="c">// 二进制展开看清楚每一步</span>\n<span class="c">// a = 0x3 = 0011b</span>\n<span class="c">// b = 0x5 = 0101b</span>',
            note: '<b>先把两个操作数写成二进制。</b>后面每一步都要按位看，十进制心算会出错。' +
                  '<code>a</code> 的低两位是 11，<code>b</code> 是 01 —— 这正是进位的来源。',
            state: { 'a': '0b0011', 'b': '0b0101' },
            mem: 'a = 0011\nb = 0101\n    ^^^^\n    低位对齐'
          },
          {
            code: '<span class="k">int</span> t1 = a ^ b;   <span class="c">// 不进位的和</span>',
            note: '<b>t1 = 异或 = 无进位相加。</b>逐位看：<code>1^0=1</code>、<code>1^1=0</code>、<code>0^0=0</code>、<code>0^1=1</code> ⇒ <code>0110b = 6</code>。' +
                  '<span class="hit">这一步已经算出了“如果完全不进位，和是多少”</span>。',
            state: { 'a': '0b0011', 'b': '0b0101', 't1': '0x6 (0110b)' },
            mem: '  0011\n^ 0101\n= 0110  → t1 = 6'
          },
          {
            code: '<span class="k">int</span> t2 = a &amp; b;   <span class="c">// 哪些位要进位</span>',
            note: '<b>t2 = 与 = 进位标志位。</b>某一位上 <code>a</code> 和 <code>b</code> 同时为 1，相加时这一位就会<b>向高位进位</b>。' +
                  '这里只有最低位满足：<code>0011 &amp; 0101 = 0001b = 1</code>。',
            state: { 'a': '0b0011', 'b': '0b0101', 't1': '0x6', 't2': '0x1 (0001b)' },
            mem: '  0011\n& 0101\n= 0001  → t2 = 1\n(最低位需要进位)'
          },
          {
            code: '<span class="k">int</span> t3 = t2 &lt;&lt; <span class="n">1</span>;   <span class="c">// 进位要去高一位</span>',
            note: '<b>关键的一步：进位必须左移一位。</b>最低位产生的进位，加到的是<b>次低位</b>上，所以把 <code>0001b</code> 左移成 <code>0010b = 2</code>。' +
                  '<span class="miss">忘了这个左移，公式就错了 —— 这是手写还原脚本最常见的 bug</span>。',
            state: { 'a': '0b0011', 'b': '0b0101', 't1': '0x6', 't2': '0x1', 't3': '0x2 (0010b)' },
            mem: 't2 = 0001\n<<1 = 0010 → t3 = 2\n(进位落到次低位)'
          },
          {
            code: '<span class="k">int</span> r = t1 + t3;   <span class="c">// 和 + 进位 = 最终结果</span>',
            note: '<b>合并：t1 + t3 = 6 + 2 = 8。</b>而正确答案本来就是 <code>0x3 + 0x5 = 8</code>。' +
                  '<span class="hit">结果完全一致</span>。这就是 <code>-sub</code> 的全部秘密：' +
                  '它<b>只改写法，不改结果</b>。',
            state: { 't1': '0x6', 't3': '0x2', 'r': '0x8 ✅' },
            mem: '  0110\n+ 0010\n= 1000  → r = 8\n\n验证: 0x3 + 0x5 = 8 ✔'
          },
          {
            code: '<span class="c">// 换成 a - b，同一个套路（补码）</span>\n' +
                  '<span class="k">int</span> r = a + (~b) + <span class="n">1</span>;',
            note: '<b>减法被拆成“取反 + 加一 + 加”。</b>依据是补码定义 <code>-b = ~b + 1</code>。' +
                  '所以 <code>a - b</code> 会被写成两次加法和一次取反 —— <b>反编译窗口里再也看不到 <code>sub</code> 指令</b>。',
            state: { 'a': '0x3', '~b': '0xFFFFFFFA', '+1': '0xFFFFFFFB', 'r': '0xFFFFFFFE = -2' },
            mem: 'a=3, b=5\n~b   = 0xFFFFFFFA\n+1   = 0xFFFFFFFB  (= -5)\n3 + (-5) = -2 ✔'
          },
          {
            code: '<span class="c">// 更狠的变体：a ^ b 也不直接出现</span>\n' +
                  '<span class="k">int</span> r = (a | b) - (a &amp; b);',
            note: '<b>异或被拆成“并集减交集”。</b>依据：两位中<b>恰好一个为 1</b> 的位 = 至少一个为 1 的位 − 两个都为 1 的位。' +
                  '到这里你应该放弃“按指令形式认算法”的念头了。',
            state: { 'a | b': '0b0111 = 7', 'a & b': '0b0001 = 1', 'r': '0x6 ✅ (同 a^b)' },
            mem: 'a|b = 0111 = 7\na&b = 0001 = 1\n7 - 1 = 6\n\n验证: 3 ^ 5 = 6 ✔'
          },
          {
            code: '<span class="c">// 逆向者的正确姿势</span>\n<span class="c">// 不要读“形式”，要算“值”</span>',
            note: '<b>破解关键：CPU 算出的寄存器值是等价的。</b>你不需要在脑子里还原成 <code>a+b</code>，' +
                  '你需要的是知道“<b>这里算出 8</b>”。两条实战路径：' +
                  '<span class="pill ok">① 常量折叠/污点传播，让脚本自动把已知输入的表达式求值</span> ' +
                  '<span class="pill ok">② 直接动态调试，在关键点 dump 寄存器</span>。' +
                  '当输入是密钥字节时，<b>动态值比对往往比静态还原更快出结果</b>。',
            state: { '结论': '值等价，形式不等价', '推荐手段': '动态 Trace / 常量折叠' },
            mem: '形式: 4 条指令 (看不懂)\n值  : 1 个结果 (看得懂)\n\n→ 关注最终值，别纠结指令形式'
          }
        ]
      },
      after: T.note('warn', '⚠️ -sub 的实战坑',
        '<p><b>① 它会让代码膨胀 2-4 倍</b>，所以加了 <code>-sub</code> 的 so 往往明显变大、指令缓存压力上升 —— ' +
        '这也是它常被加固厂商<b>限制比例</b>使用的原因（例如只替换一部分基本块）。</p>' +
        '<p><b>② 有符号 / 无符号语义。</b>上面所有等价式都基于<b>定宽整数 + 补码</b>，在 C 语言里有符号溢出是 UB，' +
        '但 IR 层面是 <code>add nsw</code> 这类带 flag 的指令。如果你自己写脚本做常量折叠，' +
        '请按<b>无符号回绕</b>语义算，不要用高精度整数 —— 否则会在边界值上算错。</p>' +
        '<p><b>③ 它不防你，它只拖慢你。</b><code>-sub</code> 是三大混淆里最容易被工具批量处理掉的一个，' +
        '因为它<b>没有任何上下文依赖</b>，纯局部改写，模式匹配就能干掉一大半。</p>')
    },

    /* ============ 19.5L 动手实验 ============ */
    {
      h: '19.5L', title: '动手实验：验证等价变形，找出假变形',
      html:
        '<p>反混淆的第一步不是写脚本，而是<b>能一眼判断"这两段指令是不是等价的"</b>。' +
        '下面这个实验让你亲手验证——而且里面混了<b>一个假的等价式</b>。</p>',
      lab: {
        title: '实验：指令替换的等价性验证',
        goal: '目标：用边界值戳穿假等价',
        intro:
          '<p><code>-sub</code> 会把 <code>a + b</code> 改写成各种等价形式。下面四个候选式，' +
          '<b>其中三个与 <code>a + b</code> 等价，一个是错的</b>。</p>' +
          '<p><b>任务：输入 a 和 b，逐个验证哪个式子在所有情况下都等于 a+b。</b></p>' +
          '<p class="small muted">提示：不要只试 a=1, b=2。真正的等价必须在<b>边界值</b>（0、最大值、回绕点）上也成立。' +
          '试试 <code>0xFFFFFFFF</code> 和 <code>0x80000000</code>。</p>',
        inputs: [
          { key: 'a', label: 'a（32 位无符号）', hint: '十六进制或十进制', ph: '0xFFFFFFFF', value: '0xFFFFFFFF' },
          { key: 'b', label: 'b（32 位无符号）', hint: '十六进制或十进制', ph: '0x00000001', value: '0x00000001' }
        ],
        runLabel: '⚙️ 逐个求值',
        autorun: true,
        run: (v) => {
          const L = window.LABX;
          const p = s => {
            const t = String(s).trim();
            if (/^0x/i.test(t)) return parseInt(t, 16) >>> 0;
            const n = Number(t);
            return isNaN(n) ? null : (n >>> 0);
          };
          const a = p(v.a), b = p(v.b);
          if (a === null || b === null) return '<div class="lab-msg warn">a 和 b 都要填有效的数字（支持 0x 十六进制）。</div>';
          const hex = n => '0x' + n.toString(16).toUpperCase().padStart(8, '0');
          const truth = L.sub32(a, b);

          const forms = [
            ['a + b',                    L.sub32(a, b)],
            ['(a ^ b) + 2 * (a & b)',    L.subVariant(a, b)],
            ['a - (~b) - 1',             L.subVariant2(a, b)],
            ['(a ^ b) + (a & b)',        ((a ^ b) + (a & b)) >>> 0],   // ← 漏了进位的 ×2，假的
          ];

          let html = '<div class="lab-kv"><span>a = <b>' + hex(a) + '</b></span>'
            + '<span>b = <b>' + hex(b) + '</b></span>'
            + '<span>标准 a+b = <b>' + hex(truth) + '</b></span></div>';

          html += '<table class="lab-tbl"><tr><th>等价式</th><th>求值结果</th><th>与 a+b 相同？</th></tr>';
          for (const [name, val] of forms) {
            const same = val === truth;
            html += '<tr class="' + (same ? 'same' : 'diff') + '"><td><code>' + name + '</code></td>'
              + '<td>' + hex(val) + '</td><td>' + (same ? '✅ 相同' : '❌ <b>不同</b>') + '</td></tr>';
          }
          html += '</table>';

          const mismatch = forms.filter(([, val]) => val !== truth);
          if (mismatch.length) {
            html += '<div class="lab-msg fail"><b>🔍 抓到了！这个式子在当前取值下不成立</b>'
              + '<div class="lab-note"><code>' + mismatch[0][0] + '</code> 算出 ' + hex(mismatch[0][1])
              + '，而 a+b 是 ' + hex(truth) + '。</div>'
              + '<div class="lab-note"><b>为什么：</b><code>(a^b) + (a&amp;b)</code> 少了<b>进位的权重</b>。<br>'
              + '<code>a ^ b</code> 给出"无进位和"，<code>a &amp; b</code> 标出"哪些位要进位"——'
              + '但一个进位会让高一位加 1，价值是 2 而不是 1，<b>所以必须写成 <code>2 * (a &amp; b)</code></b>。<br>'
              + '当前 <code>a &amp; b = ' + hex(a & b) + '</code>'
              + ((a & b) ? '，不为 0，所以少了这一份就错了。' : '，恰好是 0 —— 换个值就会暴露！')
              + '</div></div>';
            if ((a & b) === 0) {
              html += '<div class="lab-msg warn"><b>⚠️ 注意：这次刚好没暴露</b>'
                + '<div class="lab-note">当前 a 和 b 没有重叠位（<code>a &amp; b == 0</code>），'
                + '没有进位要处理，所以假式子碰巧也算对了。<br>'
                + '<b>这正是它的危险之处</b>——你必须用<b>会产生进位</b>的值去测。<br>'
                + '试试 <code>a=0xFFFFFFFF, b=0x00000001</code>，或者任意两个在同一位上都是 1 的数。</div></div>';
            }
          } else {
            html += '<div class="lab-msg pass"><b>✅ 当前取值下四个式子结果一致</b>'
              + '<div class="lab-note">但别急着下结论——<b>把 a 换成 0xFFFFFFFF、b 换成 0x00000001 再跑一次</b>。'
              + '有一项只有在<b>产生进位</b>时才会露馅。</div></div>';
          }

          html += '<div class="lab-msg key"><b>🔑 这就是反混淆的第一个技能</b>'
            + '<div class="lab-note">判断"两条指令序列是否等价"，靠的不是读懂它，'
            + '而是<b>代入边界值验证</b>。<br>'
            + '<code>-sub</code> 的所有变形都是<b>数学上可证明等价</b>的（否则程序就跑错了），'
            + '所以你不必理解它为什么等价——<b>只要能用一两组边界值确认它确实等价，就可以放心折叠掉它。</b></div></div>';
          return html;
        },
        expected: (v) => {
          const L = window.LABX;
          const p = s => {
            const t = String(s).trim();
            if (/^0x/i.test(t)) return parseInt(t, 16) >>> 0;
            const n = Number(t); return isNaN(n) ? null : (n >>> 0);
          };
          const a = p(v.a), b = p(v.b);
          if (a === null || b === null) return { ok: false, detail: '先填入 a 和 b 两个值。' };
          const truth = L.sub32(a, b);
          const bad = ((a ^ b) + (a & b)) >>> 0;
          if (bad !== truth) {
            return { ok: true, detail: '<b>正确 —— 你找到了假等价式 <code>(a^b) + (a&amp;b)</code>。</b><br>' +
              '它漏掉了进位的权重：进位要写成 <code>2 * (a &amp; b)</code>，不是 <code>(a &amp; b)</code>。' +
              '当前 <code>a &amp; b = 0x' + (a & b).toString(16).toUpperCase() + '</code>（非 0，有进位）。<br>' +
              '另外三个式子是<b>真正等价</b>的，可以放心用于反混淆。' };
          }
          return { ok: false,
            detail: '<b>还没戳穿它。</b>当前 a 和 b 没有重叠位（<code>a &amp; b == 0</code>），' +
              '没有进位，四个式子碰巧结果一致。<br>' +
              '换一组<b>会产生进位</b>的值试试 —— 例如 <code>a=0xFFFFFFFF, b=0x00000001</code>，' +
              '或者任何两个在同一位上都是 1 的数（如 a=3, b=3）。' };
        },
        showAnswer:
          '四个候选式中，【(a ^ b) + (a & b)】是假的。\n\n' +
          '验证（a=0xFFFFFFFF, b=0x00000001）：\n' +
          '  a + b                = 0x00000000  （回绕）\n' +
          '  (a ^ b) + 2*(a & b)  = 0x00000000  ✅ 等价\n' +
          '  a - (~b) - 1         = 0x00000000  ✅ 等价\n' +
          '  (a ^ b) + (a & b)    = 0xFFFFFFFF  ❌ 不等价\n\n' +
          '为什么假：\n' +
          '  a ^ b  = 无进位和（每一位不考虑进位的加法结果）\n' +
          '  a & b  = 哪些位会产生进位\n' +
          '  一个进位会让"高一位"加 1，其权重是 2 而不是 1，\n' +
          '  所以必须写成 2 * (a & b)。漏掉这个 2，就等于把进位算少了一半。\n\n' +
          '正确分解式：(a ^ b) + 2 * (a & b)\n' +
          '另一个真恒等式：(a | b) + (a & b)  ← 这个是对的，别搞混。',
        hint:
          '别用 a=1, b=2 这种"太干净"的值——它们无法暴露进位错误。<br>' +
          '真正的考验是<b>边界</b>：<code>0xFFFFFFFF + 1</code>（回绕到 0），' +
          '或者让 a 和 b 在<b>同一位上都是 1</b>（产生进位）。<br>' +
          '想想哪个式子在"有进位"时会算错。',
        after:
          T.note('ok', '✅ 这个实验训练的是什么',
            '<p style="margin-bottom:0">不是让你背等价式，而是建立<b>"用边界值验证等价性"的直觉</b>。' +
            '这套直觉有两个用途：<br>' +
            '① <b>反混淆</b>：确认一段复杂指令确实等价于简单运算，就可以安全折叠；<br>' +
            '② <b>算法还原</b>：当你怀疑"这段位运算在算什么"时，代入几组值就能反推出来，' +
            '比逐条读指令快得多。<br>' +
            '<span class="hit">这是第 22 章"常量比对"之外的另一种识别手段：行为比对。</span></p>')
      }
    },

    /* ============ 19.6C 实战案例 ============ */
    {
      h: '19.6C', title: '实战案例：某企鹅 App 的 OLLVM 平坦化还原',
      case: {
        source: 'kanxue',
        title: '[原创]26企鹅ollvm混淆去除',
        date: '2026-9-7',
        author: '北袅',
        target: '某企鹅（腾讯系）App 的 JNI_OnLoad（IDA 0x5370）',
        background:
          '<p>2026 年的一篇看雪原创帖。目标是一个腾讯系 App 的 <code>JNI_OnLoad</code>（IDA 里位于 <code>0x5370</code>），' +
          '函数被 OLLVM 处理过，作者主攻其中的 <b>FLA（控制流平坦化）</b>。</p>' +
          '<p>这个案例值得精读的地方在于：<b>面对一个 D-810 这类现成脚本吃不动的样本，作者用纯静态分析把平坦化还原了回来</b>，' +
          '而且整条路线里的每一步都是可复用、可验证的。</p>',
        points: [
          '不透明谓词形如 <code>((((_BYTE)dword_68068-1)*(_BYTE)dword_68068)&amp;1)==0 || dword_6807C&lt;10</code>；代入 <code>dword_68068=2</code>，左式恒真。',
          '另一路 <code>dword_6807C</code>（<code>.bss:6807C</code>）的交叉引用清一色 offset/read、<b>零 write</b> ⇒ 初值 0 ⇒ 该条件恒真。',
          '谓词对应汇编从 <code>.text:6C70</code> 起：<code>ADRP X8,#off_61D30@PAGE</code> / <code>LDR W8,[X8]</code> / <code>SUB</code> / <code>MUL</code> / <code>TST</code> / <code>CSEL W20,W9,W8,LT</code>。',
          '<b>最小改动</b>：只把 <code>CSEL W20,W9,W8,LT</code> 换成 <code>MOV W20,W9</code> —— 因为它在给状态寄存器 <code>W20</code> 写值，前面十几条计算指令一行都不用动。',
          'patch 脚本用 <code>idautils.XrefsTo(idc.get_name_ea_simple("off_61D30"))</code> <b>只认 ADRP</b>，否则 ADRP 与 LDR 两个 xref 会把同一个点处理两遍。',
          '从命中点向后 40 条指令扫 <code>CSEL</code>，途中遇到 <code>B</code>/<code>BL</code>/<code>RET</code> 就放弃，命中后写 <code>ida_bytes.patch_dword(ea, 0x2A0003E0|(rm&lt;&lt;16)|20)</code>。',
          '清掉 BCF 之后，被垃圾分支撑开的代码<b>塌陷到 300 多行</b>。',
          '分发器 <code>loc_53EC</code> 是 <code>MOV W8,#imm</code> / <code>CMP W20,W8</code> / <code>B.EQ</code> 组成的比较链；<code>W20</code> 的赋值只有 MOV / MOV+MOVK / CSEL 三种形态。',
          '三段脚本 <code>collect()</code>/<code>build_succ()</code>/<code>solve_exit()</code>/<code>do_patch()</code> 共解出 <b>122 个真实块</b>，回填用 <code>enc_b=0x14000000|(((dst-src)&gt;&gt;2)&amp;0x3FFFFFF)</code>、<code>enc_bcond=0x54000000|((((dst-src)&gt;&gt;2)&amp;0x7FFFF)&lt;&lt;5)|COND_CODE</code>。',
          '两个特例：Tail merging 生成的 fallthrough 尾块 <code>loc_53E0</code>；真实块前驱里找不到 <code>CMP W20</code> 时，用 <code>ida_gdl.FlowChart(f, flags=ida_gdl.FC_PREDS)</code> 查第二前驱。'
        ],
        method: [
          '先清 BCF：把恒真谓词找齐 —— 一路靠代入 <code>dword_68068=2</code> 直接证明，另一路靠 <code>.bss:6807C</code> 零 write 推出初值 0。',
          '只改状态写入点：定位到 <code>CSEL W20,W9,W8,LT</code>，替换为 <code>MOV W20,W9</code>，前面整串等价计算原样保留。',
          '脚本化定位：把 ADRP 的 xref 唯一化 → 向后 40 条扫 <code>CSEL</code> → 遇 <code>B</code>/<code>BL</code>/<code>RET</code> 放弃 → <code>patch_dword</code> 写入。',
          '分析分发器：读 <code>loc_53EC</code> 的 <code>CMP W20,W8</code> 比较链，确认 <code>W20</code> 的赋值形态只有 MOV / MOV+MOVK / CSEL。',
          '状态值反查后继并建图：用 <code>collect()</code>/<code>build_succ()</code>/<code>solve_exit()</code>/<code>do_patch()</code> 解出 122 个真实块，按 <code>enc_b</code>/<code>enc_bcond</code> 两种编码回填跳转。',
          '处理特例收尾：<code>loc_53E0</code> 这类 Tail merging 尾块单独处理；前驱缺 <code>CMP W20</code> 时用 <code>ida_gdl.FlowChart(..., FC_PREDS)</code> 补出第二前驱。'
        ],
        result:
          '<p>去 BCF 后代码从上千行塌陷到 300 多行；脚本最终解出 <b>122 个真实块</b>并完成跳转回填，' +
          '原本散落在比较链里的二分派发节点被自动消掉。</p>' +
          '<p>作者给出的关键结论是：<b>不吃 D-810 的样本也能纯静态还原 FLA</b> —— 只要状态值是以 MOV / MOVK / CSEL 立即数写进 <code>W20</code>，' +
          '用「主分发器所有前驱 + 赋值形态筛选」这套判据，就能区分真实块与二分派发链的内部节点。这个判据可以套用到绝大多数魔改 FLA 上。</p>',
        terms: ['控制流平坦化', '不透明谓词', '状态变量', 'IDAPython', 'idautils', 'CSEL', 'Tail merging'],
        limits:
          '<p>三点要如实说明：① 作者明说 <b>D810 在这个样本上不好使</b>，但没有深究原因；' +
          '② 这套脚本的规则吃死了「状态值是 MOV/MOVK/CSEL 这类简单形态」的前提，换成寄存器间接写入就要重写；' +
          '③ <b>帖子末节被论坛门控挡住</b>，本篇能逐条核对的是到跳转回填为止的部分。</p>',
        analysis:
          '<p><b>本课第 19 章的元原则是：混淆改变的是代码的长相，改变不了运行结果 —— 因为 OLLVM 从不销毁信息，它只是把信息搬了个家。</b>' +
          '这个案例就是这句话的实拍：那一串 <code>ADRP</code>/<code>LDR</code>/<code>SUB</code>/<code>MUL</code>/<code>TST</code>/<code>CSEL</code> 算得煞有介事，' +
          '净效果却只是把一个常量塞进 <code>W20</code>，等价于一条 <code>MOV</code>。</p>' +
          '<p>案例里最妙的一步，是<b>只改 <code>CSEL</code> 一条指令</b>。作者没有去「逐条还原」那十几条等价计算，而是先问了一句：' +
          '这串指令到底影响了什么？答案是——它唯一有意义的出口，就是给状态寄存器 <code>W20</code> 赋值的那条 <code>CSEL</code>，' +
          '而状态变量正是控制流的关键节点。<b>「找最小充分改动点」比「逐条还原」高明：逐条还原等于把混淆器的活重做一遍，' +
          '而掐住一个节点，是直接接管它的输出。</b>这也顺带解释了为什么 <code>-bcf</code> 是三大混淆里最容易死的一个 —— ' +
          '它的全部信息都在「哪条路是假的」上，一旦证明谓词恒真，剩下的分支就是纯噪声。</p>' +
          '<p>还有一条动手纪律值得抄走：<b>先证明，再动手。</b>案例里每一次 patch 前面都有一句「为什么这里恒真」的证明' +
          '（代入 <code>dword_68068=2</code>、靠 <code>.bss</code> 零 write 推初值），<b>没有证明就 patch，等于拿猜测去改二进制</b>。</p>',
        link: 'https://bbs.kanxue.com/thread-292886.htm',
        linkNote: '看雪论坛原创帖'
      }
    },

    /* ============ 19.6 ============ */
    {
      h: '19.6',
      title: '字符串加密：一个必须先讲清的归因问题',
      html:
        T.note('bad', '⚠️ 重要澄清：字符串加密不是 OLLVM 官方特性',
          '<p>这是全网教程里<b>最容易误导人</b>的一点。翻 OLLVM 官方 wiki，特性列表只有四项：' +
          '<span class="pill acc">Instructions Substitution -sub</span> ' +
          '<span class="pill acc">Bogus Control Flow -bcf</span> ' +
          '<span class="pill acc">Control Flow Flattening -fla</span> ' +
          '<span class="pill acc">Functions annotations（函数注解）</span>。</p>' +
          '<p><b>官方没有字符串加密。</b>你看到“字符串全变成 byte 数组、运行时解密”的样本，' +
          '那是<b>后续 fork 或加固厂商的定制版本</b>自己加的。课程把它和三大混淆并列讲，' +
          '是因为国内加固实践里它们总是一起出现 —— 但<b>归因必须准确</b>：' +
          '看到字符串加密，说明对方用的是<b>魔改版</b>，不是原版 OLLVM，这本身就是一条情报。</p>') +
        '<p>为什么这个区分对逆向有用？因为它决定了你<b>对付它的手段</b>。三大混淆是<b>结构变形</b>，' +
        '需要你理解 IR 生成规则；字符串加密是<b>数据变换</b>，它有明确的<b>解密点（解密函数）</b>，' +
        '可以用完全不同的思路解决：</p>' +
        T.tbl(
          ['维度', '三大混淆（-fla/-bcf/-sub）', '字符串加密（fork 定制）'],
          [
            ['改的是什么', '<b>控制流 / 指令形式</b>（代码结构）', '<b>数据</b>（常量字符串的存放形态）'],
            ['静态可见性', '明文字符串<b>依然可见</b>（因为没动数据）', '明文字符串<b>消失</b>，只剩密文 byte 数组'],
            ['主要逆向手段', '还原控制流、折叠常量', '<b>定位解密函数 + 动态 dump</b>'],
            ['典型工具思路', 'D-810 / HexRaysDeob / 符号执行', 'Frida hook 解密函数返回值、内存搜索'],
            ['是否官方特性', '<b>是</b>', '<b>否</b>（fork / 厂商自研）']
          ]
        ) +
        T.note('key', '🔑 一个立刻可用的侦察动作',
          '<p>拿到样本先做一件事：<b>在 so 里搜明文字符串</b>。' +
          '如果关键字符串（URL、日志、错误提示）能直接搜到 ⇒ 对方<b>只用了三大混淆</b>；' +
          '如果全搜不到、只看到一堆高熵字节 ⇒ <b>有字符串加密</b>，切到“找解密函数”的赛道。' +
          '这一步花 10 秒，能省你半天方向性错误。</p>') +
        T.note('ok', '✅ 字符串加密的常见破法（简版）',
          '<p><b>① 找解密函数：</b>特征通常是“循环 + 异或/加减 + 写回内存”，且<b>被大量调用</b>。' +
          '<b>② Frida hook 它的返回值</b>，或 hook 调用点 dump 参数，直接拿明文。' +
          '<b>③ 内存搜索：</b>解密后的明文一定在内存里出现过，扫内存找特征字符串。</p>' +
          '<p>注意：本课程第 20 章之后的壳与 VMP 会把它做得更狠（按需解密、解密后立刻擦除），' +
          '本章先建立“它有解密点”这个认知即可。</p>'),
      quiz: {
        id: 'q5-1',
        chapter: 5,
        answer: 2,
        stem: '你在一个 so 里发现：所有关键字符串都变成了 byte 数组、运行时才解密；同时函数里是巨大的 switch 状态机。以下哪个判断是<b>准确</b>的？',
        options: [
          {
            t: '这说明 OLLVM 的官方特性被全开了，包括字符串加密',
            why: '❌ 错在归因。<b>OLLVM 官方 wiki 没有字符串加密</b>，只有 -sub / -bcf / -fla 和函数注解。字符串加密来自后续 fork 或加固厂商的定制版本。'
          },
          {
            t: '字符串加密属于 -fla 的副产物，因为平坦化时顺手把常量也打散了',
            why: '❌ 混淆因果关系。-fla 只重排<b>基本块与跳转</b>，它不碰数据段、不碰常量。字符串加密是独立的、额外的一层处理。'
          },
          {
            t: 'switch 状态机对应官方 -fla；字符串加密说明用的是定制 fork，两者要分开处理',
            why: '✅ 对。结构变形（-fla）走“还原控制流”的路线；字符串加密走“定位解密函数 + 动态 dump”的路线。归因清楚了，手段才不会用错。'
          },
          {
            t: '既然字符串被加密了，说明 -fla 也是假的，整个样本都是别的东西伪装的',
            why: '❌ 逻辑跳跃。两种技术可以共存，且共存恰恰是国内加固的常态。看到 A 不能否定 B。'
          }
        ],
        explain: '<b>这一题考的是归因能力，不是记忆力。</b>混淆技术是<b>分层</b>的：<code>-fla</code> / <code>-bcf</code> / <code>-sub</code> 是 OLLVM 官方的三层（改代码结构），' +
                 '字符串加密是厂商额外加的一层（改数据形态）。把层分清楚，你才能给每一层匹配正确的手段 —— ' +
                 '对结构变形用动态 Trace / 控制流还原，对数据加密用 hook 解密点。<br><br>' +
                 '更重要的实战意义：<b>归因即情报</b>。如果样本只有三大混淆，你面对的是“公开工具能打”的目标；' +
                 '一旦出现字符串加密、间接跳转、自定义不透明谓词，就说明对方 <b>fork 过 OLLVM 并做过二次开发</b>，' +
                 '你需要准备自研脚本，而不是指望 D-810 一键搞定。'
      }
    },

    /* ============ 19.7 ============ */
    {
      h: '19.7',
      title: '在 NDK 里用 OLLVM：亲手编一个带混淆的 so 做对照实验',
      html:
        '<p>看再多文章，不如<b>自己编两个 so 摆在一起对比</b>。这一步的价值有三层：' +
        '<b>① 建立对混淆强度的真实预期</b>（哪个 Pass 影响多大）；' +
        '<b>② 验证你的反混淆手段是否真的有效</b>（用已知答案的样本练手，比拿真实样本瞎试快十倍）；' +
        '<b>③ 拿到“混淆器指纹”</b>，以后看到真实样本能一眼认出来。</p>' +
        '<p>整体流程：<b>先自己编译 OLLVM 的 clang → 再让 NDK 构建系统用这个 clang → 通过 <code>-mllvm</code> 传混淆开关</b>。' +
        '注意 <code>-mllvm</code> 是<b>把参数透传给 LLVM 后端</b>的通用开关，后面跟的才是 Pass 名。</p>',
      term: {
        title: '从源码编译 OLLVM 到产出带混淆的 so',
        lines: [
          { t: 'p', s: '# 1) 取 OLLVM 源码（当前基线为 LLVM 4.0）', note: '<b>OLLVM 是 LLVM 的一个分支</b>，不是一个独立小工具 —— 所以你要编的是<b>整个编译器</b>，耗时较长（几十分钟到数小时，取决于机器）。仓库路径可能已变更，<span class="pill warn">请自行搜索确认</span>。' },
          { t: 'p', s: 'git clone -b llvm-4.0 https://github.com/obfuscator-llvm/obfuscator.git', note: '拉取 OLLVM 的 <code>llvm-4.0</code> 分支。如果这条命令 404，说明仓库已迁移或改名 —— <b>不要硬猜地址，去搜官方 wiki</b>。' },
          { t: 'p', s: 'mkdir build && cd build', note: '<b>一定要 out-of-tree 编译</b>（在源码目录外建 build 目录）。LLVM 的 in-tree 编译会污染源码树，出问题很难清理。' },
          { t: 'p', s: 'cmake -DCMAKE_BUILD_TYPE=Release -DLLVM_TARGETS_TO_BUILD="X86;ARM;AArch64" ../obfuscator', note: '<b>只编你需要的那几个后端。</b><code>LLVM_TARGETS_TO_BUILD</code> 里加上 <code>ARM</code> / <code>AArch64</code>（安卓真机）和 <code>X86</code>（本机测试）。支持的后端越少，编译越快。', mem: '关键变量:\nCMAKE_BUILD_TYPE  = Release\nLLVM_TARGETS_TO_BUILD\n  = X86;ARM;AArch64' },
          { t: 'p', s: 'make -j$(nproc)', note: '<b>编译本体。</b>这一步最容易失败的地方是<b>宿主编译器版本过新</b> —— 用 GCC/Clang 的新版本编 LLVM 4.0 常报 C++ 标准相关错误。' },
          { t: 'e', s: 'error: no member named \'xxx\' in namespace \'std\'', note: '<b>典型症状：老 LLVM 撞上新标准库。</b>解法是换一个较老的宿主编译器（或容器内构建）。<span class="pill warn">具体可用版本组合待核实</span>' },
          { t: 'p', s: 'ls bin/clang bin/clang++', note: '<b>验证产物。</b>编完你会得到自己的 <code>clang</code> / <code>clang++</code>。下面要让 NDK 用它们，而不是 NDK 自带的工具链编译器。' },
          { t: 'd', s: '--- 接下来：让 NDK 使用这个 clang ---', note: '关键点：<b>NDK 的 toolchain file 默认会选它自带的 clang</b>，所以必须显式覆盖 <code>CMAKE_C_COMPILER</code> / <code>CMAKE_CXX_COMPILER</code>。' },
          { t: 'p', s: 'cmake -DCMAKE_TOOLCHAIN_FILE=$NDK/build/cmake/android.toolchain.cmake \\', note: '<b>加载 NDK 的 CMake 工具链</b>，这一步负责注入 sysroot、ABI 相关的 flags。' },
          { t: 'p', s: '  -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-21 \\', note: '指定 ABI 与最低 API。<b>ABI 要和你测试的设备一致</b>，否则装上去直接崩。' },
          { t: 'p', s: '  -DCMAKE_C_COMPILER=$OLLVM/bin/clang \\\n  -DCMAKE_CXX_COMPILER=$OLLVM/bin/clang++ ..', note: '<b>核心一步：把编译器换成 OLLVM 的 clang。</b>从这一刻起，所有编译都经过混淆 Pass。' },
          { t: 'd', s: '--- 在 CMakeLists.txt 里打开混淆开关 ---', note: '<b>混淆开关是编译选项，不是 CMake 变量。</b>写法是 <code>-mllvm &lt;Pass名&gt;</code>，每个 Pass 一个 <code>-mllvm</code>。' },
          { t: 'p', s: 'target_compile_options(native-lib PRIVATE\n    -mllvm -fla -mllvm -bcf -mllvm -sub)', note: '<b>三件套全开。</b>做对照实验时建议<b>先一个个单独开</b>：只开 <code>-fla</code> 看平坦化、只开 <code>-sub</code> 看指令膨胀，最后再三个一起开。' },
          { t: 'p', s: 'LOCAL_CFLAGS := -mllvm -fla -mllvm -bcf -mllvm -sub', note: '<b>Android.mk 的等价写法</b>（老式 ndk-build 项目用这个）。两种构建系统传参方式不同，但开关名字完全相同。' },
          { t: 'p', s: 'cmake --build . --target native-lib', note: '开始构建。<b>加混淆后编译会明显变慢</b>，因为 Pass 在做大量 IR 改写与重算。' },
          { t: 'p', s: 'llvm-readelf -s libnative-lib.so | head', note: '<b>先确认编出来了、符号表正常</b>。注意混淆<b>不会隐藏导出符号</b> —— JNI 函数名（<code>Java_...</code>）依然可见，这是你定位入口的路标。' },
          { t: 'o', s: 'libnative-lib.so    (arm64-v8a)', note: '产物就绪。下一步是<b>对照</b>：把未混淆版本一起拖进 IDA。' },
          { t: 'd', s: '--- 对照实验：两个 so 并排看 ---', note: '<b>实验设计很重要。</b>同一份源码，编两次：一次不加开关（对照组），一次加开关（实验组）。' },
          { t: 'p', s: 'objdump -d libnative-lib.so | wc -l\nobjdump -d libnative-ollvm.so | wc -l', note: '<b>量化对比指令数。</b><code>-sub</code> 会让指令数膨胀，<code>-fla</code> 会引入大量跳转与状态赋值 —— 数字会直观地告诉你“混淆的代价”。' },
          { t: 'w', s: 'note: 混淆后 so 体积通常明显增大，且执行性能下降', note: '<b>没有免费的混淆。</b>加固厂商会权衡强度与性能，所以真实样本往往<b>只对关键函数</b>开混淆 —— 这也是你的突破口。' },
          { t: 'p', s: '# 把两个 so 一起拖进 IDA，对同一个函数按 F5', note: '<b>最关键的一步。</b>对照组能看到漂亮的 <code>if/else</code>；实验组是一坨 switch + 看不懂的位运算。' },
          { t: 'o', s: '对照组: if (x & 1) r = 10; else r = 20;\n实验组: while(1) switch(state){ case 0: ... }', note: '<span class="hit">亲眼看到差异，你对 OLLVM 的认知才算落地。</span>从此再看到真实样本的那坨 switch，你不会有任何慌乱。' }
        ]
      },
      quiz: {
        id: 'q5-2',
        chapter: 5,
        answer: 1,
        stem: '你已按 19.7 的流程编好了 OLLVM，并在 <code>CMakeLists.txt</code> 里写了 <code>target_compile_options(native-lib PRIVATE -fla -bcf -sub)</code>，编译成功，但 IDA 里看代码<b>完全没有混淆</b>。最可能的原因是什么？',
        options: [
          {
            t: 'OLLVM 的 Pass 需要额外的 Python 脚本在编译后触发',
            why: '❌ 不存在这种机制。OLLVM 的混淆发生在编译<b>过程中</b>（LLVM 中端 Pass），不是后处理脚本。'
          },
          {
            t: '少了 <code>-mllvm</code> 前缀，这些参数根本没被透传给 LLVM',
            why: '✅ 对。<code>-fla</code> 单独写会被当成普通编译选项，clang 不认识就忽略/警告，LLVM 中端收不到任何 Pass 注册请求。<b>正确写法是 <code>-mllvm -fla</code></b>。'
          },
          {
            t: '必须用 Android.mk，CMake 不支持 OLLVM',
            why: '❌ 错。CMake 和 Android.mk 都只是<b>传递编译选项</b>的工具，与 OLLVM 是否生效无关。真正决定生效的是“编译器是不是 OLLVM 的 clang”+“选项有没有透传给 LLVM”。'
          },
          {
            t: '混淆只对 C++ 生效，如果源码是 C 就不会被混淆',
            why: '❌ 错。OLLVM 作用于 <b>LLVM IR</b>，C 和 C++ 都会先变成 IR，与源语言无关。'
          }
        ],
        explain: '<b>核心知识点：<code>-mllvm</code> 是“透传给 LLVM 层”的专用通道。</b><br><br>' +
                 '驱动的参数解析是分两层的：<code>clang</code> 自己认识的选项（<code>-O2</code>、<code>-g</code>、<code>-I</code>…）用它；' +
                 '而 LLVM 中端/后端自己的参数，必须通过 <code>-mllvm &lt;arg&gt;</code> 前缀传进去。' +
                 'OLLVM 用 <code>RegisterPass</code> 把 <code>fla</code> / <code>bcf</code> / <code>sub</code> 注册成 LLVM 的命令行参数，' +
                 '所以只有 <code>-mllvm -fla</code> 这种形式才能被它的 Pass 注册表看到。<br><br>' +
                 '<b>排错顺序（照这个顺序查，别乱试）：</b><br>' +
                 '① <b>编译器对不对</b> —— 看 CMake 有没有真的用上 OLLVM 的 clang（<code>-DCMAKE_C_COMPILER=...</code> 是否被 toolchain file 覆盖了）；<br>' +
                 '② <b>选项有没有传下去</b> —— 加 <code>-mllvm --help</code> 或看编译日志里的完整命令行，确认 <code>-mllvm -fla</code> 在里面；<br>' +
                 '③ <b>函数有没有被跳过</b> —— OLLVM 支持函数注解只混淆指定函数，如果源码/配置里做了限制，没被标注的函数当然不会变；<br>' +
                 '④ <b>你 F5 看的是不是那个函数</b> —— 导出符号和实际被混淆的函数可能不是同一个。<br><br>' +
                 '这四步背后的通用方法论：<b>任何“工具没生效”的问题，都先确认“输入对不对 → 参数到没到 → 作用域命中没命中”</b>，而不是急着换工具。'
      }
    },

    /* ============ 19.8 ============ */
    {
      h: '19.8',
      title: '反混淆的第一层认知：通用方法与“非通用”方法',
      html:
        '<p>面对 OLLVM，逆向工程师分两派：一派到处找“一键反混淆插件”，另一派先问“<b>我要的是看懂，还是拿到结果</b>”。' +
        '这两派的差别对应两条路线：</p>' +
        T.grid(2, [
          '<div class="card"><div class="card-title">通用方法（针对混淆模式本身）</div>' +
          '<p>不关心具体样本在算什么，只针对<b>混淆技术本身的结构特征</b>下手：</p>' +
          '<ul><li>识别平坦化的<b>分发器</b>（while(1) + switch + 状态变量）</li>' +
          '<li>用符号执行 / 常量折叠求<b>不透明谓词</b>的值，删死分支</li>' +
          '<li>常量折叠消除<b>指令替换</b>的等价序列</li></ul>' +
          '<p><b>优点：</b>换个样本还能用。<b>缺点：</b>厂商一改构造（换谓词、拆状态变量、多层嵌套）就失效。</p></div>',
          '<div class="card"><div class="card-title">非通用方法（针对具体样本 / 绕开）</div>' +
          '<p>不试图“理解混淆”，而是<b>针对这个样本的特征</b>拿结果：</p>' +
          '<ul><li><b>动态 Trace</b>：跑一遍，记录真实执行路径，绕开一切静态迷雾</li>' +
          '<li>针对某样本写<b>一次性脚本</b>（匹配它的特征常量、模式）</li>' +
          '<li>直接 hook 关键函数，<b>不还原算法，只要结果</b></li></ul>' +
          '<p><b>优点：</b>见效快、几乎不可防。<b>缺点：</b>换样本要重来，且需要能跑起来的环境。</p></div>'
        ]) +
        T.note('key', '🔑 选路线的判断标准：你要的是“算法”还是“结果”',
          '<p>如果任务是“<b>搞懂它怎么算的</b>”（比如要做注册机、要写协议文档）⇒ 走<b>通用方法</b>，你需要可读的控制流。' +
          '如果任务是“<b>拿到某个输入下的输出</b>”或“<b>绕过判断</b>”（比如过校验、抓密钥）⇒ 走<b>非通用方法</b>，' +
          '动态 Trace + hook 往往十分钟出结果，而静态还原可能花你三天。</p>' +
          '<p><span class="miss">新手最常见的错误：不管任务是什么，一律先上静态还原。</span>' +
          '这不是勤奋，这是没想清楚目标。</p>') +
        '<p>工具层面，两个名字绕不过去（都是 IDA 生态里的反混淆插件）：</p>' +
        T.tbl(
          ['工具', '类型', '原理要点', '备注'],
          [
            ['<b>D-810</b>', 'IDA Pro 插件', '识别平坦化的<b>分发器</b>、追踪<b>状态变量</b>的赋值、重建原始控制流', '作者 GuideM。仓库路径可能已变更，<span class="pill warn">请自行搜索确认</span>'],
            ['<b>HexRaysDeob</b>', 'IDA Hex-Rays 反编译器插件', '在反编译层面自动化还原 OLLVM 混淆（表达式级还原）', '仓库地址同样 <span class="pill warn">请自行搜索确认</span>'],
            ['<b>符号执行（如 angr 等）</b>', '通用框架', '对谓词求值、枚举可行路径', '<span class="pill warn">具体适用性因样本规模而异，待核实</span>'],
            ['<b>动态 Trace（自研）</b>', '非通用方法', '记录实际执行的基本块地址序列', '<b>本章最推荐先掌握的</b>，见 19.9']
          ]
        ) + '<p>先分清概念：' + T.term('不透明谓词', '结果恒定但静态难以化简的表达式，-bcf 的核心构造') + '、' +
        T.term('分发器', 'dispatcher，平坦化后全函数唯一的跳转枢纽，内含大 switch') + '、' +
        T.term('状态变量', 'switchVar，决定下一步去哪个 case 的栈上变量，是还原路径的钥匙') + '。</p>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一 · 一个被 -fla 保护的校验函数',
            scenario: '<b>情境：</b>你拿到一个 so，JNI 入口很快定位到了。核心校验函数被 <code>-fla</code> 平坦化：' +
                      '一个巨大的 <code>while(1) switch</code>，40 多个 case，全是状态变量赋值。' +
                      '你的任务是<b>写注册机</b>，需要完全理解校验算法。<br><br>' +
                      '你手上有：能跑的目标 App（真机 root）、IDA Pro、一周时间。你会先做什么？',
            choices: [
              { t: '直接上 D-810，先让插件把平坦化还原成 if/else，还原后再慢慢读算法', next: 'n1' },
              { t: '先不还原，用 Frida/Stalker 把状态变量的取值序列 Trace 出来，看看真实路径长什么样', next: 'n2' },
              { t: '用 angr 从函数入口符号执行到返回，让它自动求解', next: 'n3' },
              { t: '既然静态看不懂，就纯靠人工逐个 case 阅读，硬啃 40 个块', next: 'n4' }
            ]
          },
          n1: {
            label: '选A · 先上 D-810', terminal: true, verdict: 'bad',
            verdictTitle: '方向不算错，但顺序错了：你在没验证“真实路径”之前就动结构',
            result: '<b>为什么错：</b>D-810 这类插件是<b>通用方法</b>，它重建的控制流是“<b>结构上可能的所有路径</b>”，' +
                    '而不是“这个样本实际走的那条”。对于 <code>-fla</code> + <code>-bcf</code> 叠加的样本，' +
                    '插件很可能重建出一张<b>依然庞大且含有大量死分支</b>的图，你花在阅读上的时间并没有省下来。<br><br>' +
                    '<b>认知根源：</b>把“反混淆”当成了“点一下按钮”，忽略了<b>反混淆也需要验证手段</b>。' +
                    '没有动态 Trace 作为参照，你甚至无法判断插件还原得对不对 —— 还原错了你也不会发现，' +
                    '然后在这张错误的图上推导出错误的算法。<br><br>' +
                    '<b>正确做法：</b>先用动态 Trace 拿到<b>真实执行的基本块序列</b>（这就是标准答案），' +
                    '再上 D-810，<b>拿 Trace 结果去校准插件的输出</b>。工具的产出必须可验证，否则就是不可信的。<br><br>' +
                    '<span class="pill ok">推荐顺序：动态 Trace 定标准 → 通用工具做重活 → 人工读剩下的硬骨头</span>'
          },
          n2: {
            label: '选B · 先动态 Trace 状态变量', terminal: true, verdict: 'good',
            verdictTitle: '正确：先拿到“标准答案”，再决定要不要动静态结构',
            result: '<b>为什么对：</b>平坦化的状态变量序列是<b>确定性的</b>，Trace 一次就得到了真实路径的“真值”。' +
                    '这件事有三个连锁收益：<br>' +
                    '① <b>立刻缩小战场</b> —— 40 个 case 里可能只有 12 个真正被执行过，另外 28 个是死代码或错误分支，' +
                    '你可以直接不看了；<br>' +
                    '② <b>给后续工具当标尺</b> —— D-810 还原出来的图对不对，拿 Trace 一比就知道；<br>' +
                    '③ <b>有时直接就到答案了</b> —— 如果 Trace 里能看到完整的比较/运算过程，算法可能不用还原就能推出来。<br><br>' +
                    '<b>更深一层：</b>这个选择体现了“<b>先降维，再攻坚</b>”的逆向方法论。' +
                    '面对被刻意复杂化的对象，第一反应不该是“怎么把复杂度还原”，而是“<b>能不能先把它变小</b>”。' +
                    '动态执行天然携带了“哪些代码真的重要”这个信息，代价只是需要一个能跑的环境 —— 而你有。<br><br>' +
                    '<span class="pill ok">注意前提：这条路的成本是“必须能跑起来”。如果样本有强反调试/环境检测，先解决反调试。</span>'
          },
          n3: {
            label: '选C · angr 符号执行', terminal: true, verdict: 'bad',
            verdictTitle: '工具选型过早：符号执行在混淆代码上往往爆炸',
            result: '<b>为什么错：</b>平坦化会引入<b>大量状态变量的赋值与分支</b>，符号执行的路径数会随 case 数快速膨胀，' +
                    '再叠加 <code>-bcf</code> 的垃圾分支和 <code>-sub</code> 的指令膨胀，' +
                    '求解器很容易陷入“跑一晚上没结果”的境地。<br><br>' +
                    '<b>认知根源：</b>把符号执行当成“<b>万能求解器</b>”，忽略了它有明确的<b>适用边界</b>：' +
                    '它擅长<b>路径少、约束清晰</b>的小函数（比如一个纯粹的校验片段），' +
                    '不擅长<b>被刻意膨胀过的大函数</b>。而且这个样本你可能连入口参数怎么传、返回怎么判成功都没搞清楚，' +
                    '约束都建不对。<br><br>' +
                    '<b>正确姿势：</b>符号执行是<b>精确制导武器</b>，不是地毯式轰炸。' +
                    '先用 Trace 把范围缩小到“真正的校验那 20 条指令”，<b>再把这一小段</b>丢给符号执行求解，成功率会高得多。' +
                    '<span class="pill warn">具体工具的能力边界随版本变化很大，请以自己的实测为准</span>'
          },
          n4: {
            label: '选D · 人工硬啃 40 个 case', terminal: true, verdict: 'bad',
            verdictTitle: '最贵的错：用人力去对抗机器生成的复杂度',
            result: '<b>为什么错：</b>混淆器的产出是<b>机器批量生成</b>的，你用人眼逐块阅读，是在打一场<b>成本完全不对等</b>的仗。' +
                    '40 个 case 读三天，如果对方开了多层嵌套平坦化，就是 200 个 case。<br><br>' +
                    '<b>认知根源：</b>把“勤奋”当成了方法。人工阅读在<b>有结构的信息</b>上很强，' +
                    '在<b>被刻意打散的信息</b>上极弱 —— 而平坦化干的就是打散结构这件事。<br><br>' +
                    '<b>更隐蔽的害处：</b>人工逐块读，你会在脑子里<b>隐式地假设</b>“case 3 之后应该去 case 7”，' +
                    '一旦这个假设错了，你会基于错误的路径推出错误的算法，而且<b>很难自查</b>。' +
                    '动态 Trace 给出的路径不带任何主观假设，这是它比人眼可靠的地方。<br><br>' +
                    '<b>什么时候才该人工啃：</b>Trace 已经把范围缩到<b>最后十几个块</b>，而且这些块里的运算' +
                    '需要人的语义理解（比如它在拼一个协议头）—— 那时候人工阅读才是高价值投入。'
          }
        }
      }
    },

    /* ============ 19.9 ============ */
    {
      h: '19.9',
      title: '反混淆第二层：把真实路径“问”出来（动态 Trace 实操）',
      html:
        '<p>上一节我们把路线分成了通用与非通用。这一节把<b>性价比最高的那条</b>落到可执行步骤上：' +
        '<b>动态 Trace 真实执行过的基本块</b>。</p>' +
        '<p>核心思路一句话：<b>被混淆的代码结构是假的，但执行痕迹是真的。</b>' +
        '平坦化把“跳转”变成了“给变量赋值”，可它<b>无法阻止 CPU 按真实顺序执行</b>。' +
        '你只要记录下执行了哪些块、按什么顺序，就得到了混淆器<b>不可能撒谎</b>的那份路径。</p>' +
        T.note('key', '🔑 通用三问：任何 OLLVM 样本都可以用这三问开局',
          '<p><b>问 1：哪些基本块<b>真的执行过</b>？</b>（Trace 采集）⇒ 删掉从未出现的垃圾块，<code>-bcf</code> 直接失效大半。<br>' +
          '<b>问 2：状态变量取了哪些值、按什么顺序？</b>⇒ 把平坦化的 case 序列拼成线性路径。<br>' +
          '<b>问 3：关键运算点上的<b>寄存器/内存值</b>是什么？</b>⇒ 绕开 <code>-sub</code>，不还原形式只要值。</p>' +
          '<p>这三问都不需要你理解混淆器的实现，只需要你<b>能观察运行时</b>。这就是“非通用方法”的威力。</p>') +
        '<p>实操上，安卓平台常见的采集手段有三类（按侵入性从低到高）：</p>' +
        T.tbl(
          ['手段', '原理', '优点', '代价 / 坑'],
          [
            ['<b>指令级 Stalker 追踪</b>（Frida Stalker）', '逐条指令动态翻译执行，记录执行过的地址', '粒度最细，能看到完整指令流', '开销极大，慢到可能触发超时/反调试；大函数上容易卡死'],
            ['<b>基本块级插桩</b>（在块首插桩）', '在每个基本块入口埋点，记录“块被走过”', '开销可控，块级信息足够还原平坦化路径', '需要先知道块的起始地址（可从 IDA 导出）'],
            ['<b>断点 / 单步</b>（调试器）', '在分发器或特定 case 下断，人工记录', '最精确，可同时看寄存器', '<b>不可扩展</b>，适合已缩小范围后的验证阶段']
          ]
        ) +
        T.note('warn', '⚠️ 动态 Trace 的三个真实坑',
          '<p><b>① 环境检测。</b>很多样本会检测 Frida、调试器、root。Trace 前先解决反调试，' +
          '否则你拿到的可能是“检测分支”的路径，而不是真实业务路径。</p>' +
          '<p><b>② 路径依赖。</b>Trace 出来的只是<b>这一次输入</b>的路径。' +
          '校验函数往往“输入错就早退”，如果你随便喂一个错输入，只会看到最前面几个块。' +
          '<b>要用有意义的输入去跑</b>，甚至要跑多组输入对比路径差异。</p>' +
          '<p><b>③ 地址要归一化。</b>记录的是运行时地址，必须先<b>减去模块基址</b>换算成偏移，' +
          '否则和 IDA 里的地址对不上。这一步不做，你的 Trace 数据等于废纸。</p>') +
        '<p>回到工具：<b>D-810</b> 走的是静态路线（识别分发器 + 追踪状态变量赋值 + 重建控制流），' +
        '<b>HexRaysDeob</b> 走的是反编译表达式级还原。两者都是<b>通用方法</b>，' +
        '都能被“厂商改构造”绕过，所以实战里最常见的组合是：' +
        '<span class="pill ok">动态 Trace 定标</span> + <span class="pill ok">通用插件干重活</span> + ' +
        '<span class="pill ok">人工读最后几块</span>。</p>' +
        '<p>补充两个必须知道的概念：' + T.term('基本块', 'Basic Block，只有一个入口一个出口、中间没有分支的一段指令，是 OLLVM 操作的原子单位') + '、' +
        T.term('Stalker', 'Frida 的动态指令追踪引擎，可逐条指令回调，用于采集执行流') + '。</p>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境二 · 只有固件，App 跑不起来',
            scenario: '<b>情境：</b>这次你拿到的是一个<b>嵌入式设备上的 ARM 二进制</b>（不是安卓 App）。' +
                      '它被 OLLVM 保护，你怀疑里面有一段<b>私有加密协议</b>。麻烦在于：' +
                      '设备固件可以 dump，但<b>你无法在上面跑 Frida</b>，也没有可用的调试接口。<br><br>' +
                      '你手上只剩：<b>IDA Pro + 一个被 -fla/-bcf/-sub 三重保护的二进制</b>。没有动态手段了。你会怎么推进？',
            choices: [
              { t: '先写脚本做静态识别：找出所有“分发器”特征（while(1)+switch+单一状态变量），把它们标记出来', next: 'n1' },
              { t: '先做静态常量折叠：把 -sub 生成的等价表达式尽可能算回常量，让代码先“瘦”一圈', next: 'n2' },
              { t: '放弃静态，想办法把二进制跑在 QEMU 用户态里做仿真 Trace', next: 'n3' },
              { t: '直接开始逐个函数人工阅读，反正只有几百个函数', next: 'n4' }
            ]
          },
          n1: {
            label: '选A · 先静态识别分发器', terminal: true, verdict: 'bad',
            verdictTitle: '顺序反了：最贵的活先干，最容易见效的活没干',
            result: '<b>为什么错：</b>“识别分发器”是<b>针对 -fla 的重活</b>，它需要你处理多层嵌套、多个状态变量、随机化的 case 编号。' +
                    '在没有其它线索的情况下先啃它，你很可能花两天写出一个只能处理“教科书式平坦化”的脚本，' +
                    '而样本里正好有<code>-bcf</code> 的垃圾分支混在 case 列表里。<br><br>' +
                    '<b>认知根源：</b>把三大混淆当成了<b>同等难度</b>。事实上它们的破解成本差距极大：' +
                    '<code>-sub</code> 是局部改写、无上下文依赖，<b>最容易自动化消除</b>；' +
                    '<code>-bcf</code> 的死分支一旦识别出来就能整块删掉，<b>收益极高</b>；' +
                    '<code>-fla</code> 才是真正需要重建结构的硬骨头。<br><br>' +
                    '<b>正确顺序：</b><b>先摘低垂的果实</b> —— 先折叠 <code>-sub</code>（代码变短、可读性立刻提升），' +
                    '再删 <code>-bcf</code> 死分支（CFG 立刻瘦身），<b>最后</b>才用剩下的精力对付平坦化。' +
                    '每一步都在<b>降低下一步的难度</b>，这才是有复利的顺序。'
          },
          n2: {
            label: '选B · 先做静态常量折叠', terminal: true, verdict: 'good',
            verdictTitle: '正确：先降低复杂度，再攻坚结构',
            result: '<b>为什么对：</b>在没有动态手段的情况下，你唯一的武器就是<b>静态化简</b>，而化简必须<b>从依赖最少的技术开始</b>。<br><br>' +
                    '<b>① <code>-sub</code> 最适合打头阵：</b>它是纯局部改写，<code>a+b</code> → <code>(a^b)+2*(a&b)</code> 这类模式' +
                    '既稳定又有限（官方就那几种运算、固定几套等价式），<b>模式匹配 + 常量折叠脚本就能批量干掉</b>。' +
                    '做完这一步，函数体量可能直接掉三成，后面所有分析都受益。<br><br>' +
                    '<b>② 紧接着做 <code>-bcf</code>：</b>不透明谓词恒真恒假，很多情况下<b>折叠后常量就暴露了</b> —— ' +
                    '一旦条件算成常数，那条垃圾分支就是纯粹的死代码，删起来毫无风险。<br><br>' +
                    '<b>③ 最后才碰 <code>-fla</code>：</b>此时你面对的分发器，case 数量已经被前两步削减过，' +
                    '状态变量的赋值源头也更干净，重建难度大幅下降。<br><br>' +
                    '<b>方法论：</b>反混淆和做菜一样有<b>下锅顺序</b>。先处理“无依赖、收益高”的变换，' +
                    '让剩余问题变小变清晰。<span class="hit">永远不要第一个去啃最难的那块。</span>'
          },
          n3: {
            label: '选C · QEMU 仿真 Trace', terminal: true, verdict: 'good',
            verdictTitle: '正确但反直觉：没有动态手段，就自己造一个动态手段',
            result: '<b>为什么对（而且这是本题最反直觉的答案）：</b>“跑不起来”经常只是指<b>跑不了 Frida</b>，' +
                    '而不等于“无法执行”。QEMU 用户态仿真可以在<b>没有设备、没有 root、没有调试接口</b>的情况下，' +
                    '把 ARM 二进制在你的 PC 上跑起来 —— 一旦能跑，<b>19.9 的三问就全部重新可用了</b>：' +
                    '能记录执行过的块、能读状态变量、能在关键点 dump 寄存器。<br><br>' +
                    '<b>认知根源的转变：</b>把“动态分析”等同于“必须有真机 + Frida”，这是一种<b>手段绑定</b>的思维。' +
                    '动态分析的本质是<b>观察运行时</b>，只要能执行，观察方式是自由的：QEMU 插件、仿真器 trace、' +
                    '甚至把关键函数<b>抽出来单独编译成宿主程序</b>跑一遍，都算动态。<br><br>' +
                    '<b>真实代价（必须说清）：</b>仿真不是免费的 —— 你需要处理系统调用、外设寄存器、' +
                    '以及<b>样本可能带的环境检测</b>；私有协议如果依赖硬件外设，纯用户态仿真可能拿不到完整上下文。' +
                    '<span class="pill warn">可行性因样本而异，请先做小规模验证再投入</span><br><br>' +
                    '<b>正确姿势：</b>把 QEMU 仿真和静态化简<b>并行推进</b> —— 仿真验证结论，静态负责理解。' +
                    '只靠其中一条都会偏。'
          },
          n4: {
            label: '选D · 直接人工阅读', terminal: true, verdict: 'bad',
            verdictTitle: '回到了成本最不对等的打法',
            result: '<b>为什么错：</b>“只有几百个函数”不是安慰，而是<b>陷阱</b>。混淆后的函数<b>单位阅读成本</b>被放大了数倍，' +
                    '几百个函数乘以数倍成本，人力上是不可行的。<br><br>' +
                    '<b>认知根源：</b>用“数量不多”来安慰自己，忽略了混淆改变的正是<b>单个函数的阅读成本</b>。' +
                    '这和“只有一页纸，但它是用你不认识的语言写的”是同一种困境。<br><br>' +
                    '<b>更关键的判断失误：</b>你其实<b>还不确定</b>目标在哪。在没有缩小范围之前投入人工阅读，' +
                    '很可能读完 200 个无关函数才找到那 3 个真正干活的。' +
                    '而“缩小范围”这件事有便宜得多的办法：<b>搜字符串、看导入表、看交叉引用、从外部行为反推入口</b>。' +
                    '<span class="pill ok">先定位，再阅读 —— 这是所有逆向工作的铁律</span>'
          }
        }
      }
    },

    /* ============ 19.10 ============ */
    {
      h: '19.10',
      title: '实战组合：工具、Trace 与人工的接力顺序',
      quiz: {
        id: 'q5-3',
        chapter: 5,
        answer: [0, 1, 3],
        stem: '<b>多选。</b>以下哪些做法属于“针对混淆模式本身”的<b>通用</b>反混淆方法？（即：不是只对这一个样本有效）',
        options: [
          {
            t: '识别分发器结构：查找 while(1) 中包含 switch、且所有 case 都回写同一个变量的模式，据此重建控制流',
            why: '✅ 属于通用方法。它针对的是 <code>-fla</code> 这个<b>技术的结构特征</b>，而不是某个样本的具体逻辑。换成另一个被 -fla 保护的函数，同样的规则依然成立。'
          },
          {
            t: '对不透明谓词做符号执行或常量折叠，求出条件的恒定值，据此删除死分支',
            why: '✅ 属于通用方法。它针对 <code>-bcf</code> 的<b>本质</b>（恒真/恒假），只要你能求解出来，删分支就是通用操作 —— 不依赖于谓词长什么样。'
          },
          {
            t: '为该样本特有的魔改 VIP 指令序列写一段一次性脚本，把它的加密常量硬编码进脚本里',
            why: '❌ 这是<b>非通用方法</b>。硬编码了本样本的特征常量，换个样本立刻失效。'
          },
          {
            t: '常量折叠 / 局部化简，把 -sub 生成的等价运算序列算回原值',
            why: '✅ 属于通用方法。它针对 <code>-sub</code> 的<b>数学等价性</b>，用通用的代数化简规则即可处理，与样本无关。'
          },
          {
            t: '在真实设备上跑一遍，记录实际执行过的基本块偏移序列，删掉从未出现的块',
            why: '❌ 严格说这是<b>非通用方法</b>。它不针对混淆模式，而是<b>绕开</b>混淆 —— 靠“这一次运行的实际路径”得到答案。换了样本要重新跑，换了输入路径还可能不同。它极其有效，但不属于“通用”。'
          }
        ],
        explain: '<b>通用 vs 非通用的分界线在于：你的方法是针对“混淆技术”，还是针对“这一次运行/这一个样本”。</b><br><br>' +
                 '<b>通用方法</b>（识别分发器、求解不透明谓词、常量折叠）的共同点是：它们建立在<b>混淆技术的数学/结构性质</b>上。' +
                 '只要对方还用这套技术，方法就有效 —— 代价是，厂商一改构造（换谓词形式、拆状态变量、加多层嵌套）就可能失效。<br><br>' +
                 '<b>非通用方法</b>（动态 Trace、一次性脚本、直接 hook）的共同点是：它们建立在<b>具体样本的运行时事实</b>上。' +
                 '优势是几乎不可防（你改不了我实际执行了什么），劣势是换样本要重来、依赖能跑起来的环境。<br><br>' +
                 '<b>实战结论：两者是接力关系，不是二选一。</b>典型接力顺序是：' +
                 '<span class="pill ok">① 动态 Trace 拿到真实路径（定标准）</span> → ' +
                 '<span class="pill ok">② 通用工具/脚本做批量还原（干重活）</span> → ' +
                 '<span class="pill ok">③ 拿 Trace 校准工具输出（验证）</span> → ' +
                 '<span class="pill ok">④ 人工阅读剩余硬骨头（收尾）</span>。' +
                 '很多人的失败在于跳过 ①，于是既不知道工具还原得对不对，也不知道人工阅读该读哪几块。'
      }
    },

    /* ============ 19.11 ============ */
    {
      h: '19.11',
      title: '把 OLLVM 放回加固技术谱系里看',
      html:
        '<p>学完本章，你必须对 OLLVM 在加固谱系里的<b>位置</b>有清晰判断 —— 这决定了后续章节的难度预期。</p>' +
        T.tbl(
          ['技术', '改的是什么', '你的主要对手', '破解难度', '对应章节'],
          [
            ['<b>OLLVM 三大混淆</b>', 'IR 结构（控制流 + 指令形式）', '机器生成的复杂度', '中（工具可打大半）', '<b>第 19 章（本章）</b>'],
            ['<b>字符串加密</b>（fork 定制）', '数据形态', '解密函数 + 调用点', '中低（hook 即得）', '本章 19.6 已建立认知'],
            ['<b>VMP / 虚拟化保护</b>', '把指令翻译成自研字节码', '自定义虚拟机解释器', '高（要做指令语义还原）', '第 20 章'],
            ['<b>抽取壳 / 指令抽取</b>', 'DEX 方法体抽取，运行时回填', '壳的还原时机', '中高（要抓回填点）', '第 16 章已学'],
            ['<b>反调试 / 环境检测</b>', '运行条件', '检测点本身', '低到中（绕过即可）', '贯穿全书']
          ]
        ) +
        T.note('key', '🔑 为什么 OLLVM 是“必修课”而不是“选修课”',
          '<p>因为它是<b>所有高级加固的思想底座</b>。VMP 做的事情，本质上是<b>把 OLLVM 的平坦化推到极致</b> —— ' +
          '平坦化只是把跳转变成状态变量赋值，VMP 干脆把<b>每条指令的语义</b>都变成由解释器查表执行。' +
          '你在本章学到的“<b>结构是假的，运行时痕迹是真的</b>”这条方法论，在第 20 章会<b>原封不动地再用一次</b>。</p>' +
          '<p>换句话说：<b>不会打 OLLVM，就不可能打得动 VMP</b>。这不是难度递进，这是同一招的两次应用。</p>') +
        T.note('ok', '✅ 遇到 OLLVM 样本的排查清单（照着做）',
          '<p><b>Step 1 · 侦察</b>：搜明文字符串 → 有 ⇒ 只用了三大混淆；无 ⇒ 有字符串加密，先解决它。<br>' +
          '<b>Step 2 · 定位</b>：从 JNI 导出符号（<code>Java_...</code> / <code>JNI_OnLoad</code>）进，' +
          '找交叉引用最多的那个函数 —— 被混淆的函数往往是核心函数，也常是调用最密集的。<br>' +
          '<b>Step 3 · 分流</b>：只被 <code>-sub</code> 影响 ⇒ 常量折叠即可；有 <code>-bcf</code> ⇒ 找死分支；' +
          '有 <code>-fla</code> ⇒ 找分发器和状态变量。<br>' +
          '<b>Step 4 · 定标准</b>：条件允许就先动态 Trace，拿到真实块序列。<br>' +
          '<b>Step 5 · 上工具</b>：D-810 / HexRaysDeob，用 Step 4 的结果校准输出。<br>' +
          '<b>Step 6 · 收尾</b>：人工读剩下的硬骨头，重点看<b>数据流</b>而不是控制流。</p>') +
        '<p>三个必须区分的概念：' + T.term('OLLVM', 'Obfuscator-LLVM，把混淆做成 LLVM Pass 的开源混淆器，当前基于 LLVM 4.0') + '、' +
        T.term('反混淆', 'deobfuscation，把被刻意复杂化的代码还原成可读形式，分通用与非通用两条路') + '、' +
        T.term('函数注解', 'Functions annotations，OLLVM 官方特性之一，用于指定哪些函数参与混淆') + '。</p>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境三 · 老板要“三天出算法”，但样本是魔改版',
            scenario: '<b>情境：</b>样本分析到一半，你发现对方<b>不是原版 OLLVM</b>：' +
                      '字符串被加密了、case 编号是随机化的、状态变量有两个并且互相异或、还叠加了 <code>-bcf</code>。' +
                      '你试了 D-810，<b>还原出错的图</b>（拿 Trace 一比就对不上）。<br><br>' +
                      '老板要求<b>三天内交出加密算法</b>。你手上有一台 root 真机、能跑 Frida。你会怎么安排这三天？',
            choices: [
              { t: '继续深挖静态还原，改造 D-810 的规则去适配这个魔改版本，直到还原正确', next: 'n1' },
              { t: '先问清“算法交付物”到底是什么：要的是公式，还是“给定输入能算出输出”的能力', next: 'n2' },
              { t: '并行推进：一条线用 Frida 做输入输出对拍，另一条线尝试 hook 中间层（密钥派生/核心运算）拿中间值', next: 'n3' },
              { t: '先花一天把字符串加密解决掉，再看情况', next: 'n4' }
            ]
          },
          n1: {
            label: '选A · 改造静态规则硬啃', terminal: true, verdict: 'bad',
            verdictTitle: '把自己绑死在一条最慢的路上，还无视了三天这个约束',
            result: '<b>为什么错：</b>魔改版的特征是<b>规则会持续失效</b>。你改好“随机化 case 编号”，它还有“双状态变量异或”；' +
                    '你改好这个，它还有“多层嵌套平坦化”。这是在和<b>对方的开发迭代速度</b>赛跑，而对方只要改一行符号名，' +
                    '你的规则就废了。三天根本不够。<br><br>' +
                    '<b>认知根源：</b>把“<b>还原出可读代码</b>”当成了唯一目标，忽略了任务其实可能有更弱的交付形式。' +
                    '而且这里有一个更严重的信号被你忽略了：<b>你已经知道 D-810 的图是错的</b> —— ' +
                    '在一个<b>已知不可信</b>的图上继续加规则，风险极高，你无法验证最终结论。<br><br>' +
                    '<b>正确做法：</b>先<b>明确交付物</b>，再选路线。如果交付物只是“能算出结果”，静态还原根本不是必需的。' +
                    '把三天投在一个可能永远做不完的通用还原上，是典型的<b>目标失焦</b>。'
          },
          n2: {
            label: '选B · 先确认交付物', terminal: true, verdict: 'good',
            verdictTitle: '正确：先定义“完成”，再选择“路径”',
            result: '<b>为什么对：</b>这一问能<b>直接改变整个技术路线的成本</b>：<br>' +
                    '· 如果交付物是“<b>一个能算出正确结果的程序/脚本</b>” ⇒ 你只需要<b>输入输出对拍 + 中间值观察</b>，' +
                    '可能一天就能拿出可用的实现，完全不需要还原控制流。<br>' +
                    '· 如果交付物是“<b>完整的算法公式文档</b>”（要做协议兼容、要被审计）⇒ 那就必须还原，' +
                    '但要和老板讲清<b>魔改版的工期风险</b>，争取时间或缩小范围。<br><br>' +
                    '<b>认知根源的升级：</b>技术人最容易犯的错，是<b>把手段当目标</b>。' +
                    '“反混淆”是手段，“拿到算法”是目标 —— 而在很多真实需求里，目标其实更弱：' +
                    '“<b>能在给定输入下复现输出</b>”。一旦发现目标更弱，你就能合法地绕开最贵的那部分工作。<br><br>' +
                    '<b>这不是偷懒，这是工程判断。</b>把三天花在满足真实需求上，比花在自我感动式的“完整还原”上更有价值。' +
                    '<span class="pill ok">沟通成本极低，收益极高 —— 永远是第一个该做的动作</span>'
          },
          n3: {
            label: '选C · 双线并行（对拍 + 中间层 hook）', terminal: true, verdict: 'good',
            verdictTitle: '正确：用动态事实替代静态理解，同时向中间层要信息',
            result: '<b>为什么对：</b>这是<b>在“必须出结果”的约束下最务实的打法</b>，两个方向互补：<br>' +
                    '<b>① 输入输出对拍：</b>构造大量输入、记录输出，做差分分析。' +
                    '当你观察到“改一个 bit，输出变化的位数”这类统计特征，往往能<b>反推出运算类型</b>' +
                    '（比如呈现雪崩效应 ⇒ 可能是分组密码/哈希；呈现线性 ⇒ 可能是异或/线性变换）。' +
                    '这条路<b>完全不需要读代码</b>。<br>' +
                    '<b>② hook 中间层：</b>核心运算前后一定有可 hook 的点（密钥派生函数、AES 轮函数、内存中的中间缓冲）。' +
                    '拿到<b>中间值</b>，你就把“一个大黑箱”拆成了“两个小黑箱”，每个都可以独立对拍。<br><br>' +
                    '<b>关键洞察：</b>魔改版把<b>静态结构</b>搞得很复杂，但它<b>没法改变运行时一定会产生中间值</b>这个事实。' +
                    '动态手段的攻击面在<b>数据流</b>上，而厂商的混淆主要投资在<b>控制流</b>上 —— ' +
                    '<span class="hit">攻击对方投入最少的那一面</span>，这是逆向里最重要的策略直觉之一。<br><br>' +
                    '<b>风险提示：</b>双线并行对个人精力有要求，建议以 ① 为主线（更容易出交付物）、② 为增益。'
          },
          n4: {
            label: '选D · 先花一天解决字符串加密', terminal: true, verdict: 'bad',
            verdictTitle: '典型的“顺手先干个简单的”，但顺序上它不是当前瓶颈',
            result: '<b>为什么错：</b>字符串加密确实相对好解决（找解密函数 + hook），但它<b>不能推进“拿到加密算法”这个目标</b>。' +
                    '解密出来的字符串最多给你<b>线索</b>（日志、错误提示、密钥名），而你的瓶颈是<b>核心运算逻辑</b>。<br><br>' +
                    '<b>认知根源：</b>这是很常见的<b>舒适区偏移</b> —— 人会不自觉地先做“有明确解法、能做出来”的任务，' +
                    '以获得进度感，哪怕它不是关键路径。三天工期里花掉整整一天（33%）在一个非瓶颈上，' +
                    '是典型的<b>优先级误判</b>。<br><br>' +
                    '<b>正确做法：</b>字符串解密应该作为<b>顺手动作</b>穿插进行 —— 比如在写 hook 脚本时顺便扫一遍解密后的字符串，' +
                    '成本几乎为零。但要把它当成<b>独立的一天任务</b>，就本末倒置了。<br><br>' +
                    '<b>通用原则：</b>排优先级看<b>“它是否在关键路径上”</b>，而不是看<b>“它是否容易做”</b>。' +
                    '容易做的事做完，瓶颈还在那里，工期照样超。<span class="pill warn">记住：进度感 ≠ 进度</span>'
          }
        }
      }
    },

    /* ============ 19.12 ============ */
    {
      h: '19.12',
      title: '本章自测与主线回顾',
      quiz: {
        id: 'q5-4',
        chapter: 5,
        answer: 2,
        stem: '关于 <code>-fla</code> 控制流平坦化，下列说法<b>正确</b>的是？',
        options: [
          {
            t: '它通过加密跳转指令的目标地址来隐藏控制流，所以需要找到解密算法才能还原',
            why: '❌ 混淆了不同技术。“加密跳转目标”是<b>间接跳转 / 跳转表加密</b>那一类技术。平坦化不加密任何东西，它<b>把跳转改写成了数据赋值</b>。'
          },
          {
            t: '它生成了新的基本块并打乱了顺序，因此原始的执行顺序已经无法确定',
            why: '❌ 后半句错。顺序<b>完全可确定</b> —— 状态变量的取值序列就是顺序。混淆改变了“表达方式”，没有销毁“顺序信息”。'
          },
          {
            t: '它把边的跳转改写为对状态变量的赋值，真实路径被完整编码进状态变量的取值序列，因此可被 Trace 或静态追踪还原',
            why: '✅ 对。这正是平坦化<b>既可混淆又可还原</b>的原因：信息没有丢失，只是从“控制流”搬到了“数据流”里。'
          },
          {
            t: '它只对含有循环的函数生效，因为平坦化本质是把循环改写成状态机',
            why: '❌ 错。平坦化对<b>任何有分支的函数</b>都适用，不要求原函数含循环。它是在函数外层<b>新造</b>一个循环（分发器），而不是改写已有的循环。'
          }
        ],
        explain: '<b>理解这一题，就理解了整章的核心。</b>混淆技术的强度取决于它<b>销毁了多少信息</b>，而不是它让代码<b>看起来多乱</b>。<br><br>' +
                 '<code>-fla</code> 做的事情是<b>搬家</b>：把“下一步去哪”这条信息，从 CPU 的跳转指令里，搬到栈上一个整数变量里。' +
                 '信息<b>一点没少</b>，只是换了个地方存 —— 所以它<strong>必然可还原</strong>，只是还原需要你<b>换个地方找</b>：' +
                 '不去读跳转，去读状态变量的赋值序列。<br><br>' +
                 '<b>对比一下真正强的保护：</b>VMP 把指令语义搬到自研字节码里，你连“这条指令在算什么”都要先还原；' +
                 '而平坦化只是把控制流搬了个家，指令本身还是 ARM 指令，运算还是那些运算。' +
                 '这就是为什么 OLLVM 被定位为“<b>入门级到中级的保护</b>”——它能有效挡住<b>纯静态的快速分析</b>，' +
                 '但在动态手段面前几乎没有还手之力。<br><br>' +
                 '<b>记住这条判据：看一个保护强不强，问“它销毁了哪些信息，还是仅仅搬走了信息”。</b>'
      },
      after: T.note('key', '🔑 本章主线（一句话版本）',
        '<p><b>OLLVM 是三个 LLVM FunctionPass</b>：<code>-fla</code> 把跳转搬进状态变量、' +
        '<code>-bcf</code> 用恒真谓词灌垃圾分支、<code>-sub</code> 用等价式改写指令形式。' +
        '三者<b>都不销毁信息，只是把信息搬了家或加了噪声</b> —— 所以都有对应的“把信息找回来”的手段：' +
        '<b>Trace 状态变量、删死分支、折叠常量</b>。</p>' +
        '<p>而字符串加密<b>不是官方特性</b>，是 fork/厂商加的，要单独用“找解密点”的思路处理。</p>') +
        T.note('ok', '✅ 你现在应该能做到的三件事',
          '<p><b>① 看到一坨 switch 不慌</b> —— 你知道那是分发器，知道要找状态变量。<br>' +
          '<b>② 知道先干什么</b> —— 先侦察（搜字符串）、先定标准（Trace）、先摘低垂果实（<code>-sub</code> → <code>-bcf</code> → <code>-fla</code>）。<br>' +
          '<b>③ 能自己做实验</b> —— 自己编 OLLVM、自己产混淆 so、自己验证反混淆手段。' +
          '<span class="hit">能自己造样本的人，才真正理解样本。</span></p>') +
        T.note('warn', '⚠️ 下一章的伏笔',
          '<p>第 20 章 VMP 会把本章的平坦化“推到极致”：不再是“跳转变成状态变量”，而是' +
          '<b>“整个指令集变成自研字节码，由解释器逐条执行”</b>。' +
          '你会发现本章学到的所有方法论 —— 找分发器、追状态、动态 Trace、先降维再攻坚 —— ' +
          '<b>一条都不用改，全部继续适用</b>。区别只是：这次的“状态”复杂到需要你先还原一套指令语义。</p>')
    }
  ],

  glossary: [
    { t: 'OLLVM', d: 'Obfuscator-LLVM 的简称，基于 LLVM 的开源代码混淆器。论文为 Junod / Rinaldini / Wehrli / Michielin 的《Obfuscator-LLVM — Software Protection for the Masses》(IEEE/ACM SPRO 2015)。当前版本基于 LLVM 4.0。国内加固厂商大量基于它的 fork 做二次开发。' },
    { t: 'LLVM IR', d: 'Intermediate Representation，LLVM 的中间表示。一种类型化、SSA 形式的类汇编语言，是前端（Clang）与后端（机器码生成）之间的通用货币，也是 OLLVM 所有混淆手术的操作对象。' },
    { t: 'Pass', d: 'LLVM 中作用于 IR 的转换或分析单元，是一切优化的基本砖块。按作用范围分 ModulePass / FunctionPass / BasicBlockPass / LoopPass。OLLVM 三大混淆都注册为 FunctionPass。' },
    { t: 'FunctionPass', d: '作用范围为单个函数的 Pass，入口函数是 runOnFunction(Function &F)，返回值 true 表示“我修改了这个函数”。OLLVM 的 -fla / -bcf / -sub 均属此类。' },
    { t: '基本块 (Basic Block)', d: '只有一个入口、一个出口，中间不含分支的一段指令序列。它是控制流图的基本节点，也是 OLLVM 各类混淆操作的原子单位。' },
    { t: '控制流平坦化 (-fla)', d: 'Control Flow Flattening。OLLVM 官方特性之一。把函数所有基本块变成 switch 的 case，用状态变量决定下一步跳转，为每条原始边生成“写下一状态 + 跳回分发器”的序言块。结果是 IDA 只能反编译出巨大 switch。' },
    { t: '虚假控制流 (-bcf)', d: 'Bogus Control Flow。OLLVM 官方特性之一。用不透明谓词构造恒真/恒假条件，把原基本块拆成真块与假块，假块填入垃圾指令，从而向控制流中注入大量永远走不到的分支。' },
    { t: '指令替换 (-sub)', d: 'Instructions Substitution。OLLVM 官方特性之一。把二元运算替换为数学等价的复杂序列，支持 add / sub / and / or / xor。例如 a + b 可写成 (a ^ b) + 2 * (a & b)。只改形式与长度，不改计算结果。' },
    { t: '分发器 (Dispatcher)', d: '平坦化后全函数唯一的跳转枢纽基本块，内部包含根据状态变量做多路选择的 switch。所有 case 执行完毕都回到它。是识别 -fla 的首要结构特征。' },
    { t: '状态变量 (switchVar)', d: '平坦化引入的栈上局部变量，其取值决定分发器下一步跳转到哪个 case。真实执行路径被完整编码为它的一串取值，因此是反混淆（Trace 或静态追踪）的核心目标。' },
    { t: '不透明谓词 (Opaque Predicate)', d: '结果恒定（恒真或恒假）但静态难以化简的表达式，是 -bcf 的核心构造。经典例子：x*(x+1) % 2 == 0（连续整数乘积必为偶数）。破解不靠证明它，而靠动态执行观察实际走哪条路。' },
    { t: '函数注解 (Functions annotations)', d: 'OLLVM 官方特性之一，用于指定哪些函数参与混淆，未标注的函数原样保留。因此同一个 so 里可能只有一部分函数被混淆 —— 这也是定位关键函数的突破口。' }
  ],

  teacher: {
    id: 'ch5',
    chapter: 5,
    name: '追问老师 · 第 19 章',
    sub: '专治“看了教程会，上手就懵”：逼你说清 OLLVM 每一步到底改了什么',
    intro: '<p style="margin:0">这一章我不考你背参数，我考你<b>因果链</b>。你说“-fla 让代码变乱”不算答案，' +
           '我要你说清它<b>在 IR 上动了哪几刀</b>、为什么动完 IDA 就废了、以及你<b>凭什么</b>能还原。' +
           '答不上来我会一层层追问，直到你说出机制为止。</p>',
    questions: [
      {
        id: 'c5q1', depth: 1, threshold: 0.6,
        q: 'OLLVM 的三大混淆 <code>-fla</code> / <code>-bcf</code> / <code>-sub</code>，本质上是往编译流程的哪一环插入了什么？<b>为什么偏偏是这个位置</b>——而不是源码层，也不是最终的汇编层？',
        concepts: [
          { label: '插在 LLVM 的中端（middle-end），做成自定义 Pass',
            hint: '不是前端也不是后端。它挂在三阶段编译器的哪一段？',
            any: ['中端', 'middle end', 'middle-end', 'middleend', '中间端', '优化器', 'optimizer', '中端优化', 'IR 层', 'IR层', 'llvm pass', '自定义 pass', '自定义pass', 'pass'] },
          { label: '三个混淆都注册为 FunctionPass（函数粒度）',
            hint: '按作用范围分类：ModulePass / FunctionPass / BasicBlockPass，它属于哪种？',
            any: ['functionpass', 'function pass', '函数级 pass', '函数级pass', '函数 pass', 'runonfunction', '单函数', '以函数为单位', '函数粒度', '函数作用域', '函数为单位'] },
          { label: '操作对象是 LLVM IR：类型化、SSA 形式的中间表示',
            hint: '它改写的东西叫什么？长什么样？',
            any: ['IR', '中间表示', 'intermediate representation', 'bitcode', 'llvm ir', '字节码', '中间代码'] },
          { label: '只改结构/形式，不改变程序语义（行为等价）',
            hint: '混淆前后，程序跑出来的结果变了吗？',
            any: ['语义不变', '功能不变', '行为不变', '逻辑不变', '结果不变', '行为等价', '功能等价', '等价变换', 'semantics', '不改变语义', '不影响功能'] },
          { label: '因此它与源语言、目标架构都无关，同一套 Pass 通吃',
            hint: '为什么同一份混淆代码能同时用于 ARM 和 x86、C 和 C++？',
            any: ['架构无关', '平台无关', '不依赖架构', '跨架构', '可移植', 'target independent', '与源语言无关', '和源语言无关', 'c 和 c++', 'arm 和 x86', '处理器无关'] }
        ],
        hints: [
          '先回忆 LLVM 的三阶段：前端 Clang 把源码变成什么？中端对什么做优化？后端输出什么？',
          '再想一个事实：OLLVM 的 Pass 里能拿到的是 BasicBlock、Instruction、IRBuilder —— 这些都是什么层次的概念？'
        ],
        probes: [
          '既然它只在中端工作，那它能不能理解“这个函数是在做 AES 加密”？为什么这个限制对你有利？',
          '如果加固厂商想把混淆做得更强，为什么“继续往中端加 Pass”很快就到瓶颈了？'
        ],
        model: 'LLVM 是模块化的三阶段编译器：<b>前端</b>（Clang）把 C/C++ 源码变成 <b>LLVM IR</b>；' +
               '<b>中端</b>由一串 <b>Pass</b> 对 IR 反复做转换与优化；<b>后端</b>把优化后的 IR 降级成目标机器码。' +
               '<b>Pass</b> 就是“作用于 IR 的转换或分析单元”，按作用范围分 ModulePass（整个模块）、FunctionPass（单函数，入口 runOnFunction）、' +
               'BasicBlockPass（单基本块）、LoopPass（单循环）。<br><br>' +
               'OLLVM 做的事情非常朴素：<b>往中端插了三个自定义 Pass，而且全部注册为 FunctionPass</b>。' +
               '为什么选这个位置？三个理由。' +
               '① <b>信息刚刚好</b>：到了 IR 层，源码的语义已经被打散成基本块和指令，混淆器不需要理解“这段在算 MD5”；' +
               '而再往后到汇编层，寄存器分配和调度已经做完了，插桩会破坏正确性。' +
               '② <b>结构还在</b>：IR 层的基本块与控制流图清晰可读，正是平坦化、造分支所需要的粒度 —— 基本块就是它操作的原子单位。' +
               '③ <b>与源语言、目标架构完全无关</b>：无论源文件是 C 还是 C++、目标是 ARM 还是 x86，最终都会变成 IR，' +
               '所以同一套 Pass 通吃一切。<br><br>' +
               '<b>这个位置同时定义了它的能力边界</b>：因为完全不懂源码语义，它只能做<b>结构层面的变形</b>（重排控制流、' +
               '替换指令形式），无法做“语义级”的保护；又因为它不改变运行结果，<b>信息只是被搬家或加了噪声，没有被销毁</b>——' +
               '这正是所有 OLLVM 混淆都能被还原的根本原因。而“选 FunctionPass”则决定了它的合理作用域：' +
               '混淆一个函数是自洽的，跨函数重排会破坏调用约定与签名。',
        after: '<p>补一句：老版本 LLVM（含 4.0）用 <code>legacy::PassManager</code> + <code>RegisterPass</code> 注册；' +
               '新版本 LLVM 转向 <code>PassBuilder</code> + 新 Pass Manager，入口签名变成 <code>run(Function &amp;, FunctionAnalysisManager &amp;)</code>。' +
               '所以拿新版 LLVM 直接编老 OLLVM 源码会编译失败，这不是你的操作问题。</p>'
      },

      {
        id: 'c5q2', depth: 2, threshold: 0.7,
        q: '详细讲 <code>-fla</code> 平坦化的<b>源码级步骤</b>：它到底动了哪几刀，才让 IDA 从“漂亮的 if/else”变成“一坨 switch”？' +
           '并且说清：<b>为什么这坨 switch 是可还原的</b>？',
        concepts: [
          { label: '第一步：收集函数全部基本块（如 getBasicBlockList / 遍历 F）',
            hint: '动手前它先做了什么准备工作？',
            any: ['收集基本块', '遍历基本块', '所有基本块', '全部基本块', 'origbb', 'getbasicblocklist', '基本块列表', '存起来', '记录下来', '保存原来的块'] },
          { label: '创建分发器（dispatcher）基本块，内含 switch',
            hint: '平坦化之后，所有块执行完都会回到哪里？',
            any: ['分发器', 'dispatcher', 'dispatch', '枢纽', 'disp', '中枢', '汇聚块', '中心块', '公共块'] },
          { label: '引入状态变量（switchVar），用它的取值决定跳转目标',
            hint: '“下一步去哪”这条信息，被搬到了什么地方？',
            any: ['状态变量', 'switchvar', 'state', '状态值', '控制变量', 'state 变量', '状态机变量', 'switch 变量'] },
          { label: '为每条原始边生成序言块：写入下一状态 + 跳回分发器',
            hint: '原来的 A→B 这条边，被拆成了什么？中间多了个什么块？',
            any: ['序言块', 'prologue', '序言', '中间块', '插入块', 'splitedge', '拆边', '切边', '边拆分', '写状态', '赋值再跳回', '跳回分发器'] },
          { label: '原始基本块变成 switch 的 case，原 if/while 结构消失',
            hint: '最终每个基本块在反编译里表现成什么？',
            any: ['case', '分支', '变成 case', 'switch case', '拉平', '拍平', '原有结构消失', 'if 消失', '结构被抹掉', '顺序打乱'] },
          { label: '可还原的原因：信息没丢，只是从控制流搬进了数据流，状态序列确定',
            hint: '为什么说“可还原”是有理论保证的，而不是碰运气？',
            any: ['信息没丢', '信息未丢失', '搬到数据', '数据流', '确定', '确定性', '取值序列', '可还原', '可恢复', 'trace', '追踪', '序列固定', '顺序确定'] }
        ],
        hints: [
          '回忆那个 Pass 骨架：收集 → 造块 → IRBuilder 插指令 → 改跳转 → return true。平坦化就是这套骨架的具体填法。',
          '想一想：平坦化之后，“下一步去哪”这个信息存储在哪里？它是被加密了，还是被搬了个地方？'
        ],
        probes: [
          '你说状态变量可 Trace —— 那如果厂商把 case 编号随机化、或者用两个变量异或后再算呢？你的还原思路要不要改？',
          '为什么 OLLVM 要给“每条边”都插入序言块，而不是直接让每个 case 结尾自己算下一个编号？这样做的代价是什么？'
        ],
        model: '<b>平坦化的四刀，每一刀都在削弱 CFG 的可读性。</b><br><br>' +
               '<b>第一刀：收集基本块。</b>源码是 <code>for (BasicBlock &amp;BB : F) origBB.push_back(&amp;BB);</code>，' +
               '把函数当前所有基本块按顺序存进一个表。这张表后面用来分配 case 编号 —— 编号顺序<b>就是原始顺序</b>。' +
               '（OLLVM 还支持函数注解，没被标注的函数会直接 return false 放过。）<br>' +
               '<b>第二刀：造分发器。</b>用 <code>BasicBlock::Create</code> 新建一个块并插在函数入口之前，成为全函数唯一的公共枢纽；' +
               '再用 <code>IRBuilder</code> 在其中 <code>CreateAlloca</code> 出<b>状态变量 switchVar</b>（一个普通的栈上局部变量），' +
               '然后 <code>SwitchInst::Create(switchVar, disp, 0, disp)</code> 建 switch。注意默认目标也指向 disp，' +
               '所以 case 没填满时它是个<b>空转死循环</b>——这个结构在静态上极其可疑，是识别的强特征。<br>' +
               '<b>第三刀：每个原始块变一个 case。</b>按 <code>origBB</code> 的顺序 <code>addCase(i, origBB[i])</code>。' +
               '从这一刻起，原来的 <code>if</code>/<code>while</code> 关系<b>彻底消失</b>，只剩“编号 → 块”的映射。' +
               'IDA 看到的就是一个 while(1) 套 switch，它没有任何理由判定这是 if/else，只能老实输出 switch —— ' +
               '这就是“反编译成一坨”的<b>机制原因</b>，不是 IDA 不够强。<br>' +
               '<b>第四刀（最狠）：拆边插序言块。</b>对每一条原始边 from→to，用 <code>SplitEdge</code> 把边切成两段，' +
               '中间插入一个只做两件事的小块：<b>把“下一状态”写进 switchVar，然后跳回 disp</b>。' +
               '于是“跳去 B1”被翻译成“把变量设成 1”。跳转指令退役了，取而代之的是一次赋值。<br><br>' +
               '<b>为什么可还原？</b>因为信息<b>一点没少，只是搬了家</b>：从 CPU 的跳转指令里，搬到栈上一个整数里。' +
               '而且这个搬家是<b>确定性的</b>——同一输入必然产生同一串状态值。所以还原路径有三条：' +
               '① 动态 Trace 记录 switchVar 的实际取值序列（最稳）；② 静态识别分发器并追踪常量赋值（D-810 的思路）；' +
               '③ 符号执行。三条路都在回答同一个问题：<span class="hit">switchVar 的取值序列是什么</span>。',
        after: '<p><b>实战注意：</b>真实加固样本常见<b>多层嵌套平坦化</b>（Pass 跑多轮）和<b>多状态变量</b>（两个变量异或后再作为 switch 条件）。' +
               '这些不改变原理，但会让脚本失效：<b>不要假设 case 编号连续、不要假设只有一个状态变量</b>。</p>'
      },

      {
        id: 'c5q3', depth: 2, threshold: 0.7,
        q: '<code>-bcf</code> 虚假控制流靠什么构造分支？请<b>至少举出一个不透明谓词的具体例子并证明它恒真/恒假</b>。' +
           '最后说清：为什么这类混淆在<b>动态 Trace 面前几乎失效</b>？',
        concepts: [
          { label: '使用不透明谓词（opaque predicate）：结果恒定但静态难化简的表达式',
            hint: '这个“看起来像条件、实际上恒定”的表达式有专门的术语，叫什么？',
            any: ['不透明谓词', 'opaque predicate', '不透明表达式', '恒真谓词', '谓词', 'opaque', '永真条件', '恒真条件'] },
          { label: '构造恒真/恒假的判断，例如 x*(x+1) % 2 == 0（连续整数乘积必为偶数）',
            hint: '能否写出一个具体的、能证明的不透明谓词？',
            any: ['x*(x+1)', 'x * (x + 1)', '连续整数', '连续两个整数', '必为偶数', '偶数', '平方', 'x*x', 'x * x', '奇偶', '模 2', 'mod 2', '% 2', '恒真', '恒假', '永真', '永假', '不透明'] },
          { label: '把原基本块拆成“真块”和“假块”，假块填垃圾指令',
            hint: '插入分支之后，原本那一个块变成了几个块？多出来的块里放什么？',
            any: ['拆块', '拆分基本块', '真块', '假块', '垃圾代码', '垃圾指令', '死代码', '无用指令', '垃圾块', '无效分支', '两条路'] },
          { label: '插入 if (opaque) 正常路径 else 垃圾路径，使 CFG 膨胀',
            hint: '最终在控制流图上表现成什么？',
            any: ['插入分支', '注入分支', '伪造分支', '虚假分支', '膨胀', '控制流复杂', '路径爆炸', '多了分支', '假分支'] },
          { label: '破解关键：垃圾分支永远不会被执行，死代码不出现在动态 trace 里',
            hint: '那些假路径，在真实运行时会不会被走到？这对你有什么用？',
            any: ['不会执行', '永不执行', '走不到', '不可达', '死代码', '不出现在 trace', '不在 trace', 'trace 里没有', '没被执行', '从未执行', '动态看不见', '运行时不可达', '永久不可达'] },
          { label: '所以先跑一遍、删掉未出现的块，控制流立刻瘦身',
            hint: '具体怎么利用“它走不到”这个事实？',
            any: ['跑一遍', '执行一次', '删掉', '删除未执行', '过滤', '筛掉', '瘦身', '简化控制流', '去掉死分支', '排除', '剔除'] }
        ],
        hints: [
          '关键术语是“结果恒定、但静态难以化简”。为什么编译器不能直接把它折叠成常量？',
          '换个角度想：垃圾分支的作用是让“读代码的人”多算几条路。那它能不能让“跑代码的 CPU”多走几步？'
        ],
        probes: [
          '既然不透明谓词是恒真的，为什么 OLLVM 不直接用 <code>if (1)</code>？编译器会在哪个 Pass 把它优化掉？',
          '如果厂商把垃圾分支里塞进“看起来有用”的假计算（比如假的密钥派生），你的动态 Trace 策略还成立吗？会受到什么干扰？'
        ],
        model: '<b>核心武器是“不透明谓词”（opaque predicate）</b>：一个<b>结果恒定、但静态难以化简</b>的表达式。' +
               'OLLVM 用它构造恒真/恒假的条件，再把原基本块拆成“真块”和“假块”，假块塞满垃圾指令，' +
               '插入 <code>if (opaque) 正常路径 else 垃圾路径</code>。结果是 CFG 膨胀数倍，任何静态分析都要多算几百条根本走不到的路。<br><br>' +
               '<b>具体例子与证明：</b><br>' +
               '① <code>y = x * (x + 1) % 2 == 0</code>，<b>恒真</b>。<code>x</code> 与 <code>x+1</code> 是连续整数，' +
               '其中必有一个是偶数，因此乘积必为偶数，模 2 恒等于 0。<br>' +
               '② <code>y = x * x % 2 == 0</code>：平方与自身同奇偶，需按具体变体验证 <span class="pill warn">具体变体待核实</span>。<br>' +
               '③ <code>y = ((x | 1) * (x | 1)) % 2 == 0</code>，<b>恒假</b>：<code>x | 1</code> 强制最低位为 1，必为奇数；' +
               '奇数的平方仍是奇数，模 2 得 1，所以条件恒为假。<br><br>' +
               '<b>为什么编译器看不穿？</b>编译器做的是<b>局部、保守、快</b>的化简（常量折叠、GVN、稀疏条件传播）。' +
               '不透明谓词刻意选那些需要一两步<b>代数归纳</b>才能证明的恒等式 —— 证明成本略高于编译器的预算，它就活下来了。' +
               '也正因如此，OLLVM 不能用 <code>if (1)</code>：那会被常量折叠直接干掉。<br><br>' +
               '<b>为什么动态 Trace 面前它几乎失效？</b>因为垃圾分支<b>结构上存在，执行上永远不进入</b>。' +
               '在真实设备上跑一遍、记录执行过的基本块偏移（模块基址 + 偏移），垃圾块的偏移<b>一次都不会出现</b>；' +
               '把这些从未出现的块全部删掉，控制流立刻瘦身回可读状态。对逆向者来说这是好消息：' +
               '<b>你根本不需要去证明谓词恒真，你只需要观察它实际走了哪条路</b>。<br><br>' +
               '<b>代价提醒：</b>纯静态去 bcf 是体力活 —— 谓词构造无限（厂商会加变体），规则库总有漏网之鱼；' +
               '而且 <code>-bcf</code> 常与 <code>-fla</code> 叠加，垃圾分支也被塞进 case 列表，变成复合体。',
        after: '<p><b>排错向：</b>如果动态 Trace 出来发现垃圾块<b>居然被执行了</b>，先别怀疑原理 —— ' +
               '大概率是你 Trace 的是“环境检测分支”（检测到 Frida 后走的假路径），而不是真实业务路径。' +
               '先解决反调试，再谈还原。</p>'
      },

      {
        id: 'c5q4', depth: 2, threshold: 0.7,
        q: '<code>-sub</code> 指令替换会把 <code>a + b</code> 改写成什么？请写出<b>至少两种等价形式并说明依据</b>。' +
           '更重要的是：作为逆向者，你<b>应该怎样对付它</b>——是把它还原回加法，还是别的思路？',
        concepts: [
          { label: '数学等价变形：如 a - (-b)、(a ^ b) + 2*(a & b)、a - (~b) - 1',
            hint: '能否写出一两个具体的等价表达式？',
            any: ['a - (-b)', 'a-(-b)', 'a - (~b) - 1', 'a - ~b - 1', '(a ^ b) + 2', 'a^b + 2', 'a & b', 'a&b', '进位', '半加器', '补码', '~b + 1', '~b+1'] },
          { label: '支持的运算类型：add / sub / and / or / xor',
            hint: '官方支持替换哪几类运算？',
            any: ['add', 'sub', 'and', 'or', 'xor', '加法', '减法', '与', '或', '异或', '位运算', '二元运算'] },
          { label: '只改形式不改结果，指令数膨胀 2-4 倍',
            hint: '程序跑出来的结果变了吗？代码量呢？',
            any: ['等价', '结果相同', '结果不变', '值相同', '膨胀', '变长', '指令变多', '代码变大', '形式不同', '不改结果', '语义等价'] },
          { label: '破解思路一：常量折叠 / 局部代数化简，把表达式算回去',
            hint: '静态上能做什么，让表达式重新变简单？',
            any: ['常量折叠', 'constant folding', '折叠', '化简', '代数化简', '模式匹配', 'pattern', '优化', 'gvn', '局部化简', '规则匹配'] },
          { label: '破解思路二：关注最终值而非指令形式，靠动态 dump 寄存器/内存',
            hint: '如果静态还原太慢，能不能换个目标？',
            any: ['动态', 'trace', '寄存器', 'dump', '值等价', '看值不看形式', 'hook', '调试', '执行时', '运行时', '不还原形式'] },
          { label: '它是纯局部改写、无上下文依赖，所以最容易被自动化处理',
            hint: '三大混淆里，哪一个的破解成本最低？为什么？',
            any: ['局部', '无上下文', '上下文无关', '独立', '最容易', '成本最低', '好处理', '好对付', '模式固定', '有限'] }
        ],
        hints: [
          '回忆补码的定义：<code>-b</code> 用位运算怎么表示？减法和加法是什么关系？',
          '注意它替换的是<b>指令</b>。指令是局部的还是全局的？这个性质决定了它好不好自动化处理。'
        ],
        probes: [
          '你说要“关注最终值”。那如果输入是运行时才知道的用户密钥，你打算怎么拿到那个值？',
          '为什么 <code>-sub</code> 经常被加固厂商<b>限制比例</b>使用？他们担心什么？'
        ],
        model: '<b>子替换的本质是“数学等价改写”。</b>OLLVM 官方支持 <code>add</code> / <code>sub</code> / <code>and</code> / ' +
               '<code>or</code> / <code>xor</code> 五类二元运算，把它们换成更复杂但等价的序列。<br><br>' +
               '<b>必须刻进肌肉记忆的等价式：</b><br>' +
               '· <code>a + b</code> ≡ <code>a - (-b)</code>（减去相反数）<br>' +
               '· <code>a + b</code> ≡ <code>a - (~b) - 1</code>（依据 <code>~b = -b - 1</code>）<br>' +
               '· <code>a + b</code> ≡ <code>(a ^ b) + 2 * (a &amp; b)</code>（<b>半加器</b>：异或得无进位和，与运算得进位，' +
               '进位左移一位再相加。以 a=3, b=5 验证：t1=6, t2=1, t3=2, 6+2=8 ✔）<br>' +
               '· <code>a - b</code> ≡ <code>a + (~b) + 1</code>（补码定义）<br>' +
               '· <code>a ^ b</code> ≡ <code>(a | b) - (a &amp; b)</code>（并集减交集 = 对称差）<br>' +
               '· <code>a ^ b</code> ≡ <code>(~a &amp; b) | (a &amp; ~b)</code>（按定义展开）<br><br>' +
               '<b>结果完全一致</b>——以 3+5 为例，替换后依然算出 8。这就是它的全部秘密：只改写法，不改结果。' +
               '但它让一条指令变成四条，可读性急剧下降。<br><br>' +
               '<b>怎么对付它？两条路，别死磕第一条。</b><br>' +
               '<b>路线一（静态）：常量折叠 + 局部代数化简。</b>因为 <code>-sub</code> 是<b>纯局部改写、无上下文依赖</b>，' +
               '模式既稳定又有限（官方就那几套等价式），写个模式匹配脚本批量折叠就能干掉一大半。' +
               '<b>这也是三大混淆里破解成本最低的一个</b>，应该<b>最先处理</b>——做完之后函数体量下降，后面所有分析都受益。<br>' +
               '<b>路线二（动态）：关注最终值，而不是指令形式。</b>CPU 算出来的寄存器值是等价的：' +
               '你不需要在脑子里把 <code>(a^b)+2*(a&amp;b)</code> 还原成 <code>a+b</code>，你只需要知道“这里算出了 8”。' +
               '当输入是运行时密钥时，<b>动态 dump 寄存器/内存往往比静态还原快得多</b>——' +
               '混淆能改指令形式，改不了运算结果。<br><br>' +
               '<b>两个实战坑：</b>① 所有等价式都基于<b>定宽整数 + 补码</b>，自己写折叠脚本要按<b>无符号回绕</b>语义算，' +
               '别用高精度整数，否则边界值会算错；② <code>a&amp;b</code> 的进位必须<b>左移一位</b>，漏掉这个左移是最常见的手写 bug。',
        after: '<p><b>为什么厂商要限制 <code>-sub</code> 的比例：</b>它让代码膨胀 2-4 倍，指令缓存压力上升、性能明显下降。' +
               '所以真实样本往往只对关键函数开 —— 而“哪些函数被开了”，反过来就是“哪些函数是核心”的线索。' +
               '<span class="hit">混淆强度本身会泄露设计者的重视程度。</span></p>'
      },

      {
        id: 'c5q5', depth: 3, threshold: 0.6,
        q: '<b>综合题。</b>你拿到一个 so：关键字符串全部消失（只剩 byte 数组）、核心函数是一坨 <code>switch</code>、' +
           '里面夹杂大量恒真恒假的分支、运算全是看不懂的位运算。老板要你<b>三天内交出加密算法</b>。<br><br>' +
           '请给出你的<b>完整作战计划</b>：先做什么、按什么顺序、每一步的依据是什么、' +
           '哪些地方必须<b>警惕工具会骗你</b>。同时说清：样本里哪一部分<b>不是 OLLVM 官方能力</b>，这个判断如何影响你的方案？',
        concepts: [
          { label: '归因：字符串加密不是 OLLVM 官方特性，是 fork/厂商定制，要单独走“找解密点”路线',
            hint: '三大官方特性里有没有字符串加密？没有的话，它从哪来？',
            any: ['字符串加密不是官方', '不是官方', '非官方', 'fork', '厂商定制', '定制版', '魔改', '自研', '额外加的', '解密函数', '解密点', 'hook 解密'] },
          { label: '先侦察定位：搜明文字符串、从 JNI 导出符号进、看交叉引用热点，缩小战场',
            hint: '动手还原之前，怎么先确定“该看哪个函数”？',
            any: ['搜字符串', '字符串搜索', '导出符号', 'jni', 'jni_onload', 'java_', '交叉引用', 'xref', '定位', '缩小范围', '先侦察', '入口'] },
          { label: '先拿到动态事实：Trace 真实执行的基本块 / 状态变量序列，作为“标准答案”',
            hint: '在动静态结构之前，有没有更便宜的办法知道真实路径？',
            any: ['trace', '动态', '跟踪', '执行路径', '真实路径', '状态变量序列', 'frida', 'stalker', '跑一遍', '标尺', '校准', '标准答案', '动态事实'] },
          { label: '处理顺序：先易后难 —— 先 -sub 折叠，再 -bcf 删死分支，最后 -fla 重建控制流',
            hint: '三大混淆的破解成本并不相同，应该按什么顺序摘果子？',
            any: ['先易后难', '先 sub', '先-sub', '先做替换', '再 bcf', '再bcf', '最后 fla', '最后平坦化', '顺序', '先简化', '降维', '低垂的果实', '由易到难', '先常量折叠'] },
          { label: '警惕工具不可信：D-810/HexRaysDeob 的还原结果必须用 Trace 校准，不可盲信',
            hint: '插件给你的图，你凭什么认为它是对的？',
            any: ['校准', '验证', '不可信', '不能盲信', '要核对', '对照', '交叉验证', '工具会出错', '还原错误', 'd-810', 'hexraysdeob', '存疑'] },
          { label: '先确认交付物：要“算法公式/可读代码”还是“给定输入能算出输出”的能力，两者成本天差地别',
            hint: '在投入技术方案之前，有没有一件非技术的、但更关键的事要先做？',
            any: ['交付物', '明确需求', '确认目标', '沟通', '问清', '需求', '目标是什么', '要什么', '对齐', '范围'] },
          { label: '关键判据：厂商的混淆主要投资在控制流，而动态手段打的是数据流',
            hint: '如果对方把控制流做得很强，你应该往哪个方向找突破口？',
            any: ['数据流', '中间值', '对拍', '输入输出', '攻击面', '打数据流', '控制流被保护', '中间层', 'hook 中间', '差分'] }
        ],
        hints: [
          '计划的第一条不应该是技术动作。想清楚“交付物”再动手，可能会让整个方案的成本差一个数量级。',
          '把三大混淆按“破解成本”排个序：哪一个无上下文依赖、最容易自动化？哪一个需要重建结构、最贵？'
        ],
        probes: [
          '你说先用 Trace 定标准。但如果样本带强反调试、Trace 一开就被检测到自杀，你的计划要怎么改？',
          '如果对方把垃圾分支里塞进“看起来有意义的假计算”，你的“删掉未执行的块”这招还够用吗？需要补什么？'
        ],
        model: '<b>作战计划（按动作顺序，每一步都说明依据）：</b><br><br>' +
               '<b>第 0 步 · 先确认交付物（非技术动作，但最关键）。</b>“交出加密算法”至少有两种含义：' +
               '① <b>完整算法公式</b>（要写文档、做协议兼容）；② <b>给定输入能算出输出</b>的能力（要做批量处理/过校验）。' +
               '两者的技术成本差一个数量级：②往往只需要输入输出对拍 + 中间值观察，可能一天就够。' +
               '<b>先问清，再动手</b>——这可能是整个计划里投入产出比最高的一个动作。<br><br>' +
               '<b>第 1 步 · 归因，把样本分层。</b>关键字符串消失 ⇒ 有<b>字符串加密</b>；' +
               '而<b>字符串加密不是 OLLVM 官方特性</b>（官方只有 <code>-sub</code> / <code>-bcf</code> / <code>-fla</code> 和函数注解），' +
               '说明对方用的是<b>魔改 fork</b>。这个判断直接改变方案：' +
               '结构变形（三大混淆）走“还原控制流”路线；数据加密走完全不同的“<b>找解密函数 + hook 拿明文</b>”路线。' +
               '归因清楚，手段才不会用错。<br><br>' +
               '<b>第 2 步 · 定位，缩小战场。</b>从 JNI 导出符号（<code>Java_...</code> / <code>JNI_OnLoad</code>）进，' +
               '看交叉引用找调用密集的热点函数。<b>被混淆的函数往往就是核心函数</b>——' +
               '而且混淆本身会泄露设计者的重视程度：只对关键函数开混淆是加固厂商的常态。<br><br>' +
               '<b>第 3 步 · 先拿动态事实，作为“标准答案”。</b>跑一遍，记录<b>真实执行过的基本块序列</b>和' +
               '<b>状态变量的取值序列</b>。这份数据的价值是双重的：立刻删掉从未执行的垃圾块（<code>-bcf</code> 大半失效），' +
               '同时它成为后面<b>校准一切静态工具输出的标尺</b>。<br><br>' +
               '<b>第 4 步 · 按“先易后难”处理，绝不先啃最贵的。</b>' +
               '<code>-sub</code> 是纯局部改写、无上下文依赖，模式有限，<b>最容易自动化折叠</b>，先做它——做完函数体量下降，' +
               '后面全部受益；再处理 <code>-bcf</code>，谓词折叠成常量后死分支可无风险删除；' +
               '<b>最后</b>才碰 <code>-fla</code>，此时分发器的 case 已被前两步削减，重建难度大幅下降。' +
               '每一步都在<b>降低下一步的难度</b>，这才是有复利的顺序。<br><br>' +
               '<b>第 5 步 · 警惕工具骗你。</b>D-810 / HexRaysDeob 都是<b>通用方法</b>，' +
               '在魔改样本上<b>完全可能还原出错误的图</b>——而错误比“没有结果”更危险：你会基于错误的控制流' +
               '推出错误的算法，且很难自查。所以：<b>工具输出必须用第 3 步的 Trace 校准，不可盲信</b>。<br><br>' +
               '<b>贯穿全程的关键判据：</b>厂商的混淆投资几乎全在<b>控制流</b>上，' +
               '而动态手段打的是<b>数据流</b>——运行时的中间值他们藏不住。' +
               '<b>攻击对方投入最少的那一面</b>，这是本题最重要的策略直觉。<br><br>' +
               '<b>风险与备案：</b>① 若样本带强反调试，第 3 步要先解决检测，否则 Trace 到的是假路径；' +
               '② 若对方在垃圾分支里塞了“看起来有意义的假计算”，仅靠“删未执行块”不够，还需结合数据流污点分析；' +
               '③ <span class="pill warn">魔改版的还原工期难以预估，务必在第一天就和老板对齐范围与风险</span>。',
        after: '<p><b>评分自检：</b>如果你上来就说“先上 D-810 反混淆”，那你跳过了“定标准”与“确认交付物”两步 —— ' +
               '这是本章最想纠正的思维习惯。<b>工具是放大器，不是判断力。</b></p>'
      }
    ]
  }
};
