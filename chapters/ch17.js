/* 第 17 章数据 —— ARM & C++ 算法还原原理 + Frida */
window.CHAPTER = {
  no: 17,
  title: 'ARM & C++ 算法还原原理 + Frida',
  lede: '这一章补的是<strong>内功</strong>。加密算法最终都是指令，看不懂汇编，你就只能靠工具碰运气——' +
        '工具认不出来的魔改算法，你也认不出来。而 C++ 的对象模型（尤其是虚表）是<strong>看懂 Native 层加密代码的前提</strong>，' +
        '因为大量算法都藏在 so 的 C++ 类里。',
  meta: [
    '核心问题：<b>这行 C++ 代码编译后长什么样？</b>',
    '关键概念：<b>调用约定 / Thumb 位 / vtable / RTTI</b>',
    '用途：<b>读懂 so 里的算法实现</b>',
    '配套章节：<b>本章讲的是「机器码」（ARM/AArch64）。另一条语言在 <a href="ch16-smali.html">第 2 章</a>——' +
    'Smali 是 Dalvik/ART 的字节码，变长指令、寄存器式。两条语言要分开读，别混。</b>'
  ],

  sections: [
    {
      h: '17.1', title: '先建立直觉：源码和汇编之间隔着什么',
      intuition: {
        tag: '直觉模型 · 翻译与方言',
        body:
          '<p>把 C++ 源码想成一份<b>普通话写的工作说明书</b>，CPU 只懂<b>它自己那种方言</b>（机器码）。' +
          '编译器是翻译，但它是个<b>很有主见的翻译</b>：</p>' +
          '<ul>' +
          '<li>你写"如果温度高于30度就开空调"，它可能翻译成"如果温度不高于30度就跳过开空调"（<b>条件取反 + 跳转</b>）</li>' +
          '<li>你写三个数字相加，它可能一次算完（<b>指令合并</b>）</li>' +
          '<li>你写的小函数，它可能直接<b>塞进调用处</b>，让这个函数根本不存在（<b>内联</b>）</li>' +
          '</ul>' +
          '<p>所以逆向的本质不是"把汇编逐句翻回 C"，而是<strong>认出编译器惯用的那些翻译套路</strong>。' +
          '本章就是把这些套路一个个认全。</p>'
      },
      html:
        T.note('key', '🔑 本章的三个层次',
          '<ol style="margin-bottom:0">' +
          '<li><b>认得指令</b>：ARM / Thumb / AArch64 各自长什么样，寄存器怎么用</li>' +
          '<li><b>认出套路</b>：if、循环、函数调用、结构体、数组在汇编里的固定形态</li>' +
          '<li><b>看懂对象</b>：C++ 的类、虚函数、RTTI 在内存里怎么摆——这是硬骨头</li>' +
          '</ol>') +
        '<p>先从最基础的指令集开始。但注意：这里有一个<strong>安卓平台特有的坑</strong>，它让无数人的 Frida 脚本静默失效。</p>'
    },

    /* ============================================================ 17.2 */
    {
      h: '17.2', title: '三种指令集，和一个致命的坑',
      html:
        T.tbl(['', 'ARM（A32）', 'Thumb（T16/T32）', 'AArch64'],
          [
            ['指令长度', '固定 4 字节', '<b>2 或 4 字节混合</b>', '固定 4 字节'],
            ['代码密度', '低（体积大）', '<b>高（小约 30%）</b>', '中'],
            ['条件执行', '<b>几乎每条指令都可带条件码</b>', '部分（`IT` 块）', '用 `CSEL` 等条件选择指令'],
            ['安卓上的使用', '较少', '<b>so 库大量使用</b>', '64 位设备主力'],
            ['判断方法', '地址最低位 = 0', '<b>地址最低位 = 1</b>', '——']
          ]) +
        T.note('bad', '🔥 本章第一个、也是最重要的坑：Thumb 位',
          '<p><b>ARM 处理器用函数地址的最低一个 bit 来标记指令集：</b></p>' +
          '<ul>' +
          '<li>最低位 = <b>0</b> → 这个函数是 <b>ARM</b> 指令集</li>' +
          '<li>最低位 = <b>1</b> → 这个函数是 <b>Thumb</b> 指令集</li>' +
          '</ul>' +
          '<p>所以 IDA 里看到偏移是 <code>0x1A4C</code>，如果这个函数是 Thumb 编译的，' +
          '你在 Frida 里必须写 <code>base.add(0x1A4C + 1)</code>。</p>' +
          '<p style="margin-bottom:0"><b>为什么这个坑特别毒？</b>因为传错了<b>不会报错</b>。' +
          'Interceptor 会按 ARM 模式去解析 Thumb 指令，得到完全错误的指令边界——' +
          'Hook 装上了，但永远不触发。你会以为是地址算错了、so 没加载、函数被内联，' +
          '排查半天才发现是少加了个 1。<br>' +
          '<span class="hit">这是"脚本不报错但 onEnter 不触发"的头号原因。</span></p>') +
        T.card('怎么判断该不该 +1',
          T.tbl(['线索', '说明'],
            [
              ['IDA 里的函数名', '某些版本会在 Thumb 函数名前有特殊标记；更可靠的是看反汇编的指令宽度'],
              ['指令宽度', 'Thumb 指令 2 字节对齐，ARM 指令 4 字节对齐。看反汇编列表的地址间隔'],
              ['在 Frida 里试', '<b>最直接</b>：两个地址都 attach 一次，看哪个的 onEnter 会触发'],
              ['`BX`/`BLX` 的目标', '如果调用方用 `BX Rn` 且 Rn 是奇数，说明目标是 Thumb'],
              ['so 的编译配置', 'armeabi-v7a 常默认 Thumb；arm64-v8a 全是 AArch64 无此问题']
            ])) +
        T.acc('📖 补充：ARM 的条件执行——一个值得欣赏的设计',
          '<p>ARM（A32）有一个其他架构少见的特性：<strong>几乎每条指令都可以附加条件码</strong>。</p>' +
          T.code(
            '<span class="k">CMP</span>  <span class="r">R0</span>, <span class="r">R1</span>          <span class="c">; 比较 R0 和 R1，设置标志位</span>\n' +
            '<span class="k">ADDEQ</span> <span class="r">R2</span>, <span class="r">R2</span>, <span class="n">#1</span>      <span class="c">; 相等时才执行这条加法（EQ = Equal）</span>\n' +
            '<span class="k">MOVNE</span> <span class="r">R3</span>, <span class="n">#0</span>         <span class="c">; 不相等时才执行这条赋值（NE = Not Equal）</span>'
          ) +
          '<p><b>好处：</b>避免了大量短小的条件跳转，代码更紧凑，流水线也更友好。</p>' +
          '<p><b>对逆向的影响：</b>你在反汇编里看到的 <code>ADDEQ</code>、<code>MOVNE</code>、<code>LDRGT</code> 这些' +
          '"奇怪"的指令，其实就是"带条件的普通指令"。<b>先看条件码，再看指令本身。</b></p>' +
          '<p style="margin-bottom:0"><b>注意：</b>AArch64 <b>取消</b>了这个特性（因为条件执行会占用指令编码位，' +
          '在 32 位定长指令里代价太高）。AArch64 改用 <code>CSEL</code>（条件选择）、<code>CSET</code> 等指令实现类似效果。</p>') +
        '<p>接下来看 C 代码怎么变成指令。这是本章最需要建立直觉的地方。</p>',
      stepper: {
        title: 'C 代码 → AArch64 汇编：逐行对照',
        lines: [
          {
            code: '<span class="c">// C 源码：一个带分支和循环的函数</span>\n<span class="t">int</span> <span class="f">sum_positive</span>(<span class="t">int</span>* arr, <span class="t">int</span> n) {',
            note: '<b>起点：一个普通的 C 函数。</b>它做两件事：遍历数组、把正数累加。<br>我们要看的是编译器如何把"分支"和"循环"变成指令——' +
              '<span class="hit">这是逆向时最需要一眼认出的两种结构。</span>',
            state: { '函数': 'sum_positive', '参数': 'arr (x0), n (w1)', '返回值': '尚未计算' }
          },
          {
            code: '  <span class="t">int</span> sum = <span class="n">0</span>;',
            note: '<b>初始化局部变量。</b>编译器把 <code>sum</code> 放进寄存器（而不是栈），因为它的生命周期短、访问频繁。<br>' +
              '这一行会变成 <code>MOV w2, #0</code> —— <b>用 w 寄存器而不是 x</b> 是因为 <code>int</code> 是 32 位。' +
              'AArch64 里 <code>x0</code> 是 64 位视图，<code>w0</code> 是它的低 32 位视图，<b>同一个寄存器的两种宽度</b>。',
            state: { 'w0': 'arr 指针', 'w1': 'n', 'w2': 'sum = 0（刚初始化）' },
            mem: 'AArch64 寄存器宽度对照\n\n  x0  [========================] 64 位\n  w0  [============]             低 32 位\n\n  写 w0 会清零 x0 的高 32 位\n  （这是 AArch64 的设计，与 x86 不同）'
          },
          {
            code: '  <span class="k">for</span> (<span class="t">int</span> i = <span class="n">0</span>; i &lt; n; i++) {',
            note: '<b>循环头 = 比较 + 条件退出 + 循环体 + 跳回。</b>编译器的典型做法是<b>把条件判断放在循环体前面</b>：<br>' +
              '<code>CMP w3, w1</code>（比较 i 和 n）→ <code>B.GE .exit</code>（i &gt;= n 就跳出）→ 循环体 → <code>ADD w3, w3, #1</code>（i++）→ <code>B .loop</code>（跳回去）<br>' +
              '<span class="hit">看到"CMP + 条件跳转 + ... + 无条件跳回"，就是循环。</span>',
            state: { 'w0': 'arr', 'w1': 'n', 'w2': 'sum = 0', 'w3': 'i = 0' }
          },
          {
            code: '    <span class="k">if</span> (arr[i] &gt; <span class="n">0</span>) {',
            note: '<b>分支的实现：比较 + 条件跳转（跳过不执行的块）。</b><br>' +
              '<code>LDR w4, [x0, w3, SXTW #2]</code> —— 这一行同时做了三件事：<br>' +
              '① <code>w3</code> 是索引 i，<code>SXTW</code> 把它符号扩展成 64 位（因为地址计算要用 64 位）<br>' +
              '② <code>#2</code> 表示左移 2 位，也就是 <b>×4</b>（int 是 4 字节）<br>' +
              '③ 加上基址 <code>x0</code>，然后从该地址加载 32 位到 <code>w4</code><br>' +
              '<span class="hit">"基址 + 索引×元素大小"就是数组访问的固定形态。</span>',
            state: { 'w0': 'arr', 'w1': 'n', 'w2': 'sum = 0', 'w3': 'i', 'w4': 'arr[i]（刚加载）' },
            mem: '数组访问的地址计算\n\n  x0 = 数组基址\n  w3 = 索引 i\n\n  [x0, w3, SXTW #2]\n     │    │     └─ 左移 2 位 = ×4（int 大小）\n     │    └─────── 索引（符号扩展为 64 位）\n     └──────────── 基址\n\n  等价于 C: *(int*)((char*)arr + i*4)'
          },
          {
            code: '      <span class="k">if</span> (w4 &lt;= <span class="n">0</span>) <span class="k">goto</span> skip;',
            note: '<b>注意这里：编译器把 <code>if (arr[i] &gt; 0) { ... }</code> 翻译成了"不满足就跳过"。</b><br>' +
              '<code>CMP w4, #0</code> + <code>B.LE skip</code>（小于等于 0 就跳到 skip）<br>' +
              '<b>这是逆向时最容易被绕晕的地方</b>：你的源码写的是"大于 0 就做事"，' +
              '汇编里看到的却是"小于等于 0 就跳走"。<span class="hit">条件被取反了——这是编译器的常规操作。</span>',
            state: { 'w4': 'arr[i]', '标志位': '已由 CMP 设置', '下一步': 'B.LE 决定跳不跳' }
          },
          {
            code: '      sum += arr[i];',
            note: '<b>累加。</b><code>ADD w2, w2, w4</code> —— 把 w4 加到 w2（sum）。<br>' +
              '注意 <code>sum</code> 一直待在寄存器 <code>w2</code> 里，<b>从没进过内存</b>。' +
              '这正是"变量看不到"的原因之一——调试器想读 <code>sum</code> 时，它只存在于寄存器中。',
            state: { 'w2': 'sum 已更新', 'w3': 'i', 'w4': 'arr[i]' }
          },
          {
            code: '    }  <span class="c">// skip:</span>',
            note: '<b>分支合并点。</b>无论走不走那条 <code>ADD</code>，执行流都在这里汇合。' +
              '在控制流图里，这是一个<b>汇合节点</b>（多个前驱、一个后继）。<br>' +
              '逆向时识别分支范围，就是找"从条件跳转的目标地址，到两条路径汇合处"这段区间。',
            state: { '控制流': '两条路径在此汇合' }
          },
          {
            code: '    i++;',
            note: '<b>循环变量自增。</b><code>ADD w3, w3, #1</code>。<br>' +
              '然后是一条无条件跳转 <code>B .loop</code> 回到循环头。<br>' +
              '<span class="hit">完整循环形态：条件比较 → 条件退出 → 循环体 → 自增 → 无条件跳回。</span>',
            state: { 'w3': 'i = i + 1', '下一步': 'B .loop（跳回循环头）' }
          },
          {
            code: '  }',
            note: '循环结束。<b>编译器会把循环优化得很紧凑</b>——比如把 <code>i &lt; n</code> 改成倒计数递减来省一条比较指令。' +
              '如果你在汇编里看到"递减到 0 就跳出"，别困惑，那是优化后的等价形式。',
            state: { '循环': '已结束', 'w2': 'sum（最终结果）' }
          },
          {
            code: '  <span class="k">return</span> sum;',
            note: '<b>返回值放进 x0/w0。</b>这是 AArch64 调用约定的规定动作——' +
              '<b>参数用 x0-x7 传入，返回值用 x0 传出</b>。<br>' +
              '所以你在 Frida 的 <code>onLeave</code> 里读 <code>retval</code>，读的就是 <code>x0</code>。',
            state: { 'x0/w0': 'sum（返回值）', '函数': '即将 RET' }
          },
          {
            code: '}',
            note: '<b>函数尾声（epilogue）：恢复栈与寄存器，然后 RET。</b><br>' +
              '完整形式通常是：<code>LDP x29, x30, [sp], #16</code>（恢复帧指针和返回地址）+ <code>RET</code>（跳到 x30）。<br>' +
              '<span class="hit">"LDP ... [sp], #16 然后 RET" 是函数结束的标志性结尾。</span>',
            state: { 'x30 (lr)': '已恢复', 'sp': '已恢复', '执行': 'RET → 返回调用方' }
          }
        ]
      },
      after:
        T.note('ok', '✅ 从这个例子提炼出的四条套路',
          '<ol style="margin-bottom:0">' +
          '<li><b>分支</b>：<code>CMP</code> + 条件跳转（<code>B.xx</code>），且<b>条件常常是源码里条件的取反</b></li>' +
          '<li><b>循环</b>：条件比较 + 条件退出 + 循环体 + 无条件跳回</li>' +
          '<li><b>数组访问</b>：<code>[基址, 索引, LSL/SXTW #N]</code>，其中 #N 是 log2(元素大小)</li>' +
          '<li><b>函数</b>：参数进 x0-x7，返回值出 x0，<span class="term" data-def="Prologue。函数入口处保存现场（帧指针、返回地址、被调用者保存的寄存器）并预留栈空间的那几条指令。识别函数边界的重要线索。">序言</span>保存 lr、尾声恢复并 RET</li>' +
          '</ol>')
    },

    /* ============================================================ 17.2L 动手实验 */
    {
      h: '17.2L', title: '动手实验：算出你该传给 Frida 的地址',
      html:
        '<p>Thumb 位这个坑，光看文字记不住。下面这个实验让你<b>亲手算一遍</b>——' +
        '我会给你 IDA 里的偏移，你算出该传给 <code>Interceptor.attach</code> 的地址。</p>' +
        T.note('warn', '⚠️ 为什么必须自己算一遍',
          '<p style="margin-bottom:0">因为这个错误<b>不会报错</b>。地址传错了，脚本照样跑、attach 照样成功，' +
          '只是 <code>onEnter</code> 永远不触发。你没有机会从报错里学习——' +
          '<span class="hit">只能靠脑子里那根弦：armeabi-v7a 的 so，想想 Thumb。</span></p>'),
      lab: {
        title: '实验：ARM32 / AArch64 地址换算',
        goal: '目标：算出正确的 Frida 地址',
        intro:
          '<p>你在 IDA 里看到一个函数，<code>.text</code> 段的偏移是 <code>0x1A4C</code>。' +
          '现在要写 Frida 脚本 <code>base.add(偏移)</code> 来 Hook 它。</p>' +
          '<p><b>任务：分别算出 ARM32 和 AArch64 下应该填的偏移，并说明为什么。</b></p>',
        inputs: [
          { key: 'arm', label: '① ARM32（armeabi-v7a）下应填的偏移', hint: '十六进制，如 0x1A4C 或 1A4D', ph: '0x...' },
          { key: 'a64', label: '② AArch64（arm64-v8a）下应填的偏移', hint: '十六进制', ph: '0x...' },
          { key: 'why', label: '③ 用一句话说明两者的差别', hint: '为什么一个要改、一个不用改？', ph: '因为……', type: 'textarea', rows: 2 }
        ],
        runLabel: '🔍 验证我的答案',
        run: (v) => {
          const L = window.LABX;
          const a = L.thumbDecode(v.arm, 'arm32');
          const b = L.thumbDecode(v.a64, 'a64');
          if (!a || !b) return '<div class="lab-msg warn">两个偏移都要填有效的十六进制数。</div>';
          const hex = n => '0x' + n.toString(16).toUpperCase();
          let html = '<table class="lab-tbl"><tr><th>架构</th><th>IDA 偏移</th><th>你填的</th>'
            + '<th>Frida 实参</th><th>指令集判定</th></tr>';
          html += '<tr class="diff"><td>ARM32</td><td>' + hex(a.off) + '</td><td>' + hex(a.value) + '</td>'
            + '<td><b>' + hex(a.fridaAddr) + '</b></td><td>Thumb（最低位=1）</td></tr>';
          html += '<tr class="same"><td>AArch64</td><td>' + hex(b.off) + '</td><td>' + hex(b.value) + '</td>'
            + '<td><b>' + hex(b.fridaAddr) + '</b></td><td>定长 4 字节，无标记位</td></tr></table>';

          const wantArm = 0x1A4D, wantA64 = 0x1A4C;
          const okArm = a.value === wantArm, okA64 = b.value === wantA64;
          html += '<div class="lab-msg ' + (okArm && okA64 ? 'pass' : 'fail') + '"><b>'
            + (okArm && okA64 ? '✅ 两个都对' : '❌ 还有错') + '</b>'
            + '<div class="lab-note">'
            + (okArm ? 'ARM32 正确：<code>0x1A4D</code>（原偏移 +1）。'
                     : 'ARM32 应为 <code>0x1A4D</code> —— 原偏移 <b>+1</b>，因为 Thumb 函数地址最低位必须是 1。')
            + '<br>'
            + (okA64 ? 'AArch64 正确：<code>0x1A4C</code>（原样）。'
                     : 'AArch64 应为 <code>0x1A4C</code> —— <b>保持原样</b>，AArch64 全是指令 4 字节定长，没有指令集切换。')
            + '</div></div>';

          const why = (v.why || '').trim();
          if (why) {
            const hit = window.AKKC_hasConcept(why, ['thumb', '最低位', '最低 bit', 'bit0', '标记', '指令集', '定长', '4 字节', 'arm32', 'aarch64']);
            html += '<div class="lab-msg ' + (hit ? 'pass' : 'warn') + '"><b>'
              + (hit ? '✅ 你的解释提到了关键点' : '🟡 解释还不够到位') + '</b>'
              + '<div class="lab-note">' + (hit
                  ? '你已经抓住了核心：<b>ARM32 用地址最低位标记指令集，AArch64 没有这个机制。</b>'
                  : '试着提到这两个词：<b>最低位（bit0）</b> 和 <b>指令集</b>。'
                    + 'ARM32 用地址最低位标记 Thumb / ARM；AArch64 取消了指令集切换，所以不需要标记。')
              + '</div></div>';
          }
          return html;
        },
        expected: (v) => {
          const L = window.LABX;
          const a = L.thumbDecode(v.arm, 'arm32'), b = L.thumbDecode(v.a64, 'a64');
          // 注意 !!：thumbDecode 在输入为空时返回 null，直接 && 串起来会让 ok 变成 null
          const ok = !!(a && b && a.value === 0x1A4D && b.value === 0x1A4C);
          return {
            ok,
            detail: ok
              ? '完全正确。ARM32 要 +1（Thumb 标记），AArch64 原样。'
              : '再想一遍：ARM32 的 Thumb 函数，地址最低位必须是 <b>1</b>；AArch64 没有这个约定。'
          };
        },
        showAnswer:
          'ARM32（armeabi-v7a）：\n' +
          '  base.add(0x1A4C + 1)  →  base.add(0x1A4D)\n' +
          '  原因：Thumb 函数地址最低位=1。IDA 显示的 0x1A4C 是"对齐后的入口"，\n' +
          '        必须 +1 告诉 Frida 按 Thumb 模式解析指令边界。\n\n' +
          'AArch64（arm64-v8a）：\n' +
          '  base.add(0x1A4C)      →  保持原样\n' +
          '  原因：AArch64 所有指令固定 4 字节，没有 ARM/Thumb 双指令集，\n' +
          '        地址最低位没有特殊含义。\n\n' +
          '记忆口诀：【32 位看奇偶，64 位不用管】',
        hint:
          'ARM 处理器有两种指令集：ARM（4 字节定长）和 Thumb（2/4 字节混合）。' +
          'CPU 取指时必须知道按哪种模式解码——它靠<b>地址的最低位</b>来判断。<br>' +
          '所以 Thumb 函数的"真实入口地址"最低位是 1。想想 <code>0x1A4C</code> 的最低位是几，应该改成什么。',
        after:
          T.note('ok', '✅ 实验的收获',
            '<p style="margin-bottom:0">你现在有了一个可以复用的判断流程：<br>' +
            '<b>看到 armeabi-v7a 的 so → 想到可能有 Thumb → 试试 +1；' +
            '看到 arm64-v8a → 直接原样用。</b><br>' +
            '<span class="hit">更重要的是：你知道"不触发"时该先查这个，而不是去怀疑内联、反调试、加载时机。' +
            '排查顺序对了，能省下大量时间。</span></p>')
      }
    },

    /* ============================================================ 17.3C 实战案例 */
    {
      h: '17.3C', title: '实战案例：从 ARM64 指令位域理解反汇编',
      case: {
        source: 'kanxue',
        title: '[原创] Arm静态分析引擎原理一 - 反汇编引擎码表设计',
        date: '2026-7-29',
        author: 'neocanable',
        target: '作者自研 ARM 反汇编引擎 rosemary（作者自评「属于重复的轮子」）；原理对标 capstone / ghidra / zydis；理论依据 ARM 官方手册 DDI0487L_b A-profile Architecture Reference Manual',
        background:
          '<p>本章 17.2 节讲的都是「怎么读汇编」。这篇帖子再往下钻一层：<b>反汇编器自己是怎么把一串字节变成 <code>add Xd, Xn, #imm</code> 的</b>。</p>' +
          '<p>作者写了一个自研 ARM 反汇编引擎 <b><code>rosemary</code></b>，自嘲「属于重复的轮子」——因为这件事 capstone、ghidra、zydis 都已经做过。' +
          '他把设计过程重新梳理了一遍，理论依据是 ARM 官方手册 <b>DDI0487L_b A-profile Architecture Reference Manual</b>。</p>' +
          '<p>动机说得很直白：<b>「我原来写了个手搓反汇编引擎的帖子，有人说垃圾，我觉得确实写的潦潦草草，这里重新仔细的写一遍。」</b>该帖 8-5 有编辑。</p>' +
          '<p><b>先说清楚这篇帖子覆盖到哪里。</b>抓到的正文在 <code>ops_desc</code> 字段的说明之后被门控截断——紧接着就是「回复或点赞可查看完整内容」。' +
          '因此<b>「设计描述汇编的数据结构」一节的完整描述、x86 / mips 部分、以及解码器代码都没有抓到</b>，本站不做任何推测；' +
          '正文中间另有两处被挖空的句子（如「给定一条 arm 指令，如果它的二进制是：」之后直接接下一段）。' +
          '正文引用的 4 张 webp 附件（码表截图与 <code>add</code> 指令位域图）无法读取；参考手册链接是看雪加密 <code>elink</code>，无法解析；' +
          '作者也自评「这个手册实现的，是不是最新的我也好久没有看过了」。下面只复述确实抓到的部分。</p>',
        points: [
          '<b>反汇编的本质是「查表-解码-输出汇编」</b>：没有特殊处理过的 ELF / PE / Mach-O，找到代码段顺着往下写即可。',
          'capstone / ghidra / zydis 全都是查表做的，<b>而那张表就是 CPU 指令集手册</b>。',
          '<b>arm64 指令 = 4 字节 = 32 个 bit 的一个数字</b>；码表设计类似 <b>b-tree 索引</b>，从 bit 0–31 每一个 bit 或 bit 组合形成一个章节。',
          '<b>保留码规则</b>：<code>0xx0000xxxxxxxxxxxxxxxxxxxxxxxx</code> 即 ARM 保留码，任何符合该规则的编码都认为是 <code>nop</code>。',
          '<b>一级码表目录共 8 类</b>：Reserved / SME / SVE / Data Processing IMM / Branch / Data processing register / SIME / Load and Store。',
          '<code>add(Immediate)</code> 位域：寄存器 <b>Xd 占 bit 0–4</b>，寄存器 <b>Xn 占 bit 5–9</b>，立即数<b>占 bit 10–21</b>。',
          '<b><code>sh</code> 是第 22 位</b>：<code>== 1</code> 时立即数左移 12 位，<code>== 0</code> 时不显示。',
          '<b><code>sf</code> 位决定寄存器是 32 位还是 64 位</b>：32 位时 Xn 变 Wn，<b>Wn 与 Xn 物理位置相同，只是长短不同</b>。',
          '架构取舍：指令集有成千上万条具体指令，<b>不能做成一个巨大的 switch，那样几乎无法维护</b>。',
          'DSL 选型：作者选 <b>Ruby</b> 描述汇编。',
          '指令描述数据结构的字段：<code>patterns</code>（描述每个 bit 位，取值 <b>0 / 1 / x</b>，0 与 1 表示必须为 0 或 1，<b>x 表示不关心</b>）；<code>desc</code>（章节字符串）；<code>list</code>（标识这是一个章节，<b>一个 item 没有 list 则表示它是一条确定的指令</b>）；<code>param</code>（格式 <code>31:0,30:0,29:0</code>，表示第 31、30、29 位必须同时为 0）；<code>name</code>（助记符）；<code>grammar</code>（语法）；<code>ops_desc</code>（描述每一个 operand）。',
          '<code>ops_desc</code> 的寄存器类型标注：<code>t: :r_w</code> 表示操作数是寄存器类型，<b><code>w</code> 表示 32 位寄存器，<code>x</code> 表示 64 位寄存器</b>。',
          '评论区争论：有人质疑「牛X工具的实现没这么简单」，作者回应：<b>「反汇编引擎的实现原理其实就是很简单，复杂的地方是指令集的庞大和设计测试用例」</b>。'
        ],
        method: [
          '定基线：以 ARM 官方手册 DDI0487L_b A-profile Architecture Reference Manual 为唯一依据——反汇编器的码表就是这本手册。',
          '确定编码模型：arm64 指令是 4 字节，也就是 32 个 bit 的一个数字，所有解码都围绕这 32 位展开。',
          '设计码表结构：按 b-tree 索引的思路组织，从 bit 0–31 的每一位或 bit 组合形成一个章节，逐层收窄。',
          '切一级目录，共 8 类：Reserved / SME / SVE / Data Processing IMM / Branch / Data processing register / SIME / Load and Store。',
          '先把保留码挡在门外：按 <code>0xx0000xxxxxxxxxxxxxxxxxxxxxxxx</code> 的规则，凡符合者一律当 <code>nop</code> 处理。',
          '用 <code>patterns</code> 逐位描述：0 / 1 表示该位必须为 0 或 1，<code>x</code> 表示不关心；章节与具体指令靠有没有 <code>list</code> 字段区分。',
          '用 <code>param</code> 表达「某几位必须同时为 0」（格式 <code>31:0,30:0,29:0</code>），再配 <code>name</code> / <code>grammar</code> / <code>ops_desc</code> 把一条指令描述完整。',
          '落到位域细节：以 <code>add(Immediate)</code> 为例，Xd 占 bit 0–4、Xn 占 bit 5–9、立即数占 bit 10–21，第 22 位 <code>sh</code> 控制立即数是否左移 12 位，<code>sf</code> 位决定 32 位还是 64 位寄存器名。',
          '选 Ruby 作描述汇编的 DSL——正因为指令有成千上万条，才不能用一个巨大的 switch 硬写。'
        ],
        result:
          '<p>原帖公开的是<b>方法论与码表设计本身</b>：把「查表-解码-输出汇编」这个本质讲透，给出 arm64 一级码表的 8 类目录与保留码规则，' +
          '并用 <code>add(Immediate)</code> 一例把 32 个 bit 的位域分解讲清楚。作者的目标是一个自研 ARM 反汇编引擎 <b><code>rosemary</code></b>。</p>' +
          '<p><b>但这不是一篇完工报告。</b>正文在数据结构一节的中途被门控截断，数据结构完整定义、x86 / mips 部分、解码器代码均无从得知——这个案例的价值在于<b>原理层的认知</b>，不在于拿到一份可编译的实现。</p>',
        terms: ['反汇编引擎', '码表 / 码表目录', 'ARM64 指令编码', '位域解码', 'b-tree 索引', '保留码', 'patterns', 'ops_desc', 'Ruby DSL', 'DDI0487L_b', 'rosemary'],
        limits:
          '<p>抓取到的材料缺口很具体，逐条列出：</p>' +
          '<p>① <b>正文被门控截断</b>——抓到的内容止于 <code>ops_desc</code> 字段说明，紧接着就是「回复或点赞可查看完整内容」，' +
          '因此<b>「设计描述汇编的数据结构」一节的完整描述、x86 / mips 部分、解码器代码都没有抓到</b>；<br>' +
          '② 正文中间<b>有两处被挖空的句子</b>（如「给定一条 arm 指令，如果它的二进制是：」之后直接接下一段）；<br>' +
          '③ 正文引用的 <b>4 张 webp 附件</b>（码表截图与 <code>add</code> 指令位域图）无法读取；<br>' +
          '④ 参考手册链接是看雪加密 <code>elink</code>，无法解析；<br>' +
          '⑤ 作者自评<b>「这个手册实现的，是不是最新的我也好久没有看过了」</b>——码表所依据的手册版本时效性由作者本人存疑。</p>' +
          '<p>所以本文只当作<b>原理讲解</b>来读：位域数字照抄原帖，任何超出上述范围的技术细节，本站不补。</p>',
        analysis:
          '<p><b>本章的元原则是：逆向的本质不是把汇编逐句翻回 C，而是认出编译器惯用的那些翻译套路。</b>' +
          '这个案例把这套本领又往下推了一层，推到<b>指令本身的编码</b>——它回答的是「你凭什么能读懂那条汇编」。</p>' +
          '<p><b>第一层认知：「查表」。</b>很多人以为反汇编器里有什么魔法，其实它的全部秘密就是<b>按 CPU 手册查表</b>：' +
          '没被特殊处理过的 ELF / PE / Mach-O，找到代码段顺着往下写就是「查表-解码-输出汇编」，' +
          'capstone / ghidra / zydis 都是这么做的，<b>那张表就是 CPU 指令集手册</b>。' +
          '理解这一点之后有个很实在的收获：<b>你自己也能对着手册手算一条指令的位域</b>——' +
          '遇到 IDA 反汇编不出来、或者结果明显不对的地方，你不再只能干等工具更新，' +
          '而是可以翻到手册对应那一节，把 32 个 bit 摆开自己算一遍。' +
          '<span class="hit">这就是「会用工具」和「懂原理」的分界线。</span></p>' +
          '<p><b>第二层：<code>add</code> 那个位域分解，是本章 17.2 / 17.3 两节的具象化。</b>' +
          '17.2 节说 AArch64 里 <code>x0</code> 是 64 位视图、<code>w0</code> 是同一个寄存器的低 32 位视图——' +
          '当时你只能记住这句话；这个案例给了它底层的解释：<b><code>sf</code> 位决定寄存器是 32 位还是 64 位，32 位时 Xn 变 Wn，而 Wn 与 Xn 物理位置相同，只是长短不同</b>。' +
          '同理，<code>add Xd, Xn, #imm</code> 三个操作数各占哪几位是<b>死的</b>：Xd 占 bit 0–4、Xn 占 bit 5–9、立即数占 bit 10–21，' +
          '第 22 位的 <code>sh</code> 决定立即数要不要左移 12 位。' +
          '<span class="hit">17.3 节讲的「参数放在哪个寄存器」是调用约定层面的规矩，这里讲的是「寄存器编号写在指令的哪几位」——同一个问题的两个层次。</span>' +
          '两层都拿在手上之后，你读一条 <code>add</code> 时看到的不再是助记符，而是 32 个 bit 被切成了几段。</p>' +
          '<p><b>第三层，也是最该带走的一句话：作者回应质疑时说的「反汇编引擎的实现原理其实就是很简单，复杂的地方是指令集的庞大和设计测试用例」。</b>' +
          '这和本章反复强调的那件事是同一个道理：<b>把「难」和「多」区分开</b>。' +
          '原理不讲情面地简单，工作量不讲情面地大——<b>混淆这两者，会让你在该上的项目上退缩（误以为难），也会让你在该估工期的项目上翻车（误以为少）</b>。' +
          '判断一项工作值不值得投入，第一步永远是分清它到底难在哪：是难在没想到，还是难在要重复几千遍。<br>' +
          '换个角度看，作者这个「重复的轮子」为什么还值得造？因为<b>造过一遍的人，看任何一条反汇编结果的心态都不一样了</b>。' +
          '这也解释了评论区那场争论为什么不矛盾：质疑者说的是「工具很牛」，作者说的是「原理简单、工程量庞大」——' +
          '这两件事本来就可以同时成立。</p>',
        link: 'https://bbs.kanxue.com/thread-292220.htm',
        linkNote: '看雪论坛原创帖'
      }
    },

    /* ============================================================ 17.3 */
    {
      h: '17.3', title: '调用约定：两个架构的对照',
      html:
        '<p><span class="term" data-def="Calling Convention，调用约定。规定函数之间如何传参、如何返回、哪些寄存器由调用者保存、哪些由被调用者保存。ARM32 的标准叫 AAPCS，AArch64 的叫 AAPCS64。">调用约定</span>' +
        '是"函数之间怎么传参、怎么返回"的约定。' +
        '搞错了它，你就不知道在哪个寄存器里找参数——<strong>这是 Native Hook 和算法还原的基本功</strong>。</p>' +
        T.tbl(['', 'ARM32（AAPCS）', 'AArch64（AAPCS64）'],
          [
            ['整数/指针参数', '<code>r0</code> - <code>r3</code>', '<code>x0</code> - <code>x7</code>'],
            ['返回值', '<code>r0</code>', '<code>x0</code>'],
            ['栈指针', '<code>sp</code>（r13）', '<code>sp</code>（<b>不是通用寄存器</b>）'],
            ['返回地址', '<code>lr</code>（r14）', '<code>x30</code>（也叫 lr）'],
            ['帧指针', '<code>r11</code> 或 <code>r7</code>', '<code>x29</code>（FP）'],
            ['栈对齐要求', '<b>8 字节</b>', '<b>16 字节</b>'],
            ['被调用者须保存', 'r4-r11, sp, lr', 'x19-x29, sp'],
            ['调用者须保存', 'r0-r3, r12', 'x0-x18'],
            ['超过 4/8 个参数', '多余参数压栈', '多余参数压栈']
          ]) +
        T.note('warn', '⚠️ Frida 里的实际影响',
          '<p>当你在 <code>onEnter</code> 里访问 <code>args[0]</code>、<code>args[1]</code>……时，' +
          'Frida 就是按这个表去读寄存器的。</p>' +
          '<p style="margin-bottom:0">所以：<b>如果函数的第 5 个参数是通过栈传递的</b>（AArch64 只有 8 个寄存器参数），' +
          '你依然可以用 <code>args[4]</code> 读到——但如果是 <b>浮点参数</b>，它们走的是 <code>v0</code>-<code>v7</code>' +
          '（向量/浮点寄存器），<code>args[]</code> 里读不到，需要手工读 <code>context</code>。' +
          '<span class="hit">这是 Hook 加密函数时常见的困惑：为什么参数读出来是垃圾？因为它是浮点或结构体。</span></p>') +
        T.acc('📖 序言与尾声：函数是怎么"进栈出栈"的',
          '<p>AArch64 函数的典型序言（prologue）与尾声（epilogue）：</p>' +
          T.code(
            '<span class="c">// 序言：先保存现场</span>\n' +
            '<span class="k">STP</span>  <span class="r">x29</span>, <span class="r">x30</span>, [<span class="r">sp</span>, <span class="n">#-16</span>]!   <span class="c">; 压栈保存 FP 和 LR（SP 同时减 16）</span>\n' +
            '<span class="k">MOV</span>  <span class="r">x29</span>, <span class="r">sp</span>                     <span class="c">; 建立新的帧指针</span>\n' +
            '<span class="k">SUB</span>  <span class="r">sp</span>, <span class="r">sp</span>, <span class="n">#32</span>               <span class="c">; 为局部变量预留 32 字节栈空间</span>\n' +
            '\n' +
            '<span class="c">// ... 函数体 ...</span>\n' +
            '\n' +
            '<span class="c">// 尾声：恢复现场</span>\n' +
            '<span class="k">LDP</span>  <span class="r">x29</span>, <span class="r">x30</span>, [<span class="r">sp</span>], <span class="n">#16</span>    <span class="c">; 出栈恢复 FP 和 LR（SP 同时加 16）</span>\n' +
            '<span class="k">RET</span>                                 <span class="c">; 跳转到 x30（返回调用方）</span>'
          ) +
          '<p><b>关键观察：</b></p>' +
          '<ul>' +
          '<li><code>STP</code>/<code>LDP</code> 是 AArch64 的<b>成对读写</b>指令，一次操作两个寄存器，常用于栈操作</li>' +
          '<li>序言的 <code>#-16</code> 和尾声的 <code>#16</code> 必须对称——这是识别函数边界的重要线索</li>' +
          '<li><code>RET</code> 本质上就是 <code>BR x30</code>（跳转到返回地址）</li>' +
          '</ul>' +
          '<p style="margin-bottom:0"><b>逆向用途：</b>当你在 IDA 里不确定一个函数的边界时，' +
          '找 <code>STP x29, x30, [sp, #-N]!</code> 和对应的 <code>LDP x29, x30, [sp], #N</code> + <code>RET</code>，' +
          '这一对就是函数的头和尾。</p>')
    },

    /* ============================================================ 17.4 vtable 动画 */
    {
      h: '17.4', title: '动画：虚函数与虚表——C++ 逆向的硬骨头',
      html:
        '<p>如果本章只让你记住一件事，那应该是这个：<strong>C++ 的虚函数调用在内存里长什么样</strong>。</p>' +
        '<p>因为大量安卓 so 的加密算法都封装在 C++ 类里，而类的多态就靠虚表实现。' +
        '看不懂虚表，你会在 IDA 里看到一堆"<code>LDR</code> 两层解引用然后 <code>BLR</code>"的代码，完全不知道它调用了谁。</p>',
      stage: {
        title: 'vtable 内存布局与虚函数调用全过程',
        speed: 1700,
        render:
          '<div class="grid2" style="gap:16px">' +
            '<div>' +
              '<div class="pill acc" style="margin-bottom:8px">对象内存</div>' +
              '<div class="memgrid">' +
                '<div class="memrow"><span class="addr">+0x00</span>' +
                  '<span class="cell" id="v-obj0">vptr</span><span class="cell" id="v-obj1">—</span>' +
                  '<span class="cell" id="v-obj2">—</span><span class="cell" id="v-obj3">—</span></div>' +
                '<div class="memrow"><span class="addr">+0x08</span>' +
                  '<span class="cell" id="v-obj4">hp</span><span class="cell" id="v-obj5">—</span>' +
                  '<span class="cell" id="v-obj6">—</span><span class="cell" id="v-obj7">—</span></div>' +
              '</div>' +
              '<p class="small muted" style="margin-top:8px">对象 = <b>vptr</b>（8 字节）+ 成员变量。<br>' +
              'vptr 指向该类的虚表。</p>' +
            '</div>' +
            '<div>' +
              '<div class="pill acc" style="margin-bottom:8px">虚表（vtable）</div>' +
              '<div class="memgrid">' +
                '<div class="memrow"><span class="addr">-0x10</span>' +
                  '<span class="cell" id="v-vt0">off</span><span class="cell" id="v-vt1">—</span>' +
                  '<span class="cell" id="v-vt2">—</span><span class="cell" id="v-vt3">—</span></div>' +
                '<div class="memrow"><span class="addr">-0x08</span>' +
                  '<span class="cell" id="v-vt4">type</span><span class="cell" id="v-vt5">—</span>' +
                  '<span class="cell" id="v-vt6">—</span><span class="cell" id="v-vt7">—</span></div>' +
                '<div class="memrow"><span class="addr">+0x00</span>' +
                  '<span class="cell" id="v-vt8">enc</span><span class="cell" id="v-vt9">()</span>' +
                  '<span class="cell" id="v-vt10">—</span><span class="cell" id="v-vt11">—</span></div>' +
                '<div class="memrow"><span class="addr">+0x08</span>' +
                  '<span class="cell" id="v-vt12">dec</span><span class="cell" id="v-vt13">()</span>' +
                  '<span class="cell" id="v-vt14">—</span><span class="cell" id="v-vt15">—</span></div>' +
              '</div>' +
              '<p class="small muted" style="margin-top:8px">槽位按<b>声明顺序</b>排列。<br>' +
              '<b>-1 槽</b>是 RTTI，<b>-2 槽</b>是 offset-to-top。</p>' +
            '</div>' +
          '</div>' +
          '<div style="margin-top:16px;padding-top:14px;border-top:1px dashed var(--line)">' +
            '<div class="pill good" id="v-op" style="background:var(--bg-3);color:var(--fg-3);border-color:var(--line-2)">' +
            'C++ 源码：<code>obj-&gt;encrypt(data);</code></div>' +
          '</div>',
        reset: () => {
          ['v-obj0','v-obj4','v-vt8','v-vt12','v-vt4','v-vt0','v-op'].forEach(i => CLS(i, 'cell'));
          CLS('v-obj0', 'cell'); CLS('v-obj4', 'cell');
          CLS('v-vt8', 'cell'); CLS('v-vt12', 'cell'); CLS('v-vt4', 'cell'); CLS('v-vt0', 'cell');
          CLS('v-op', 'pill');
          SET('v-op', 'C++ 源码：<code>obj-&gt;encrypt(data);</code>');
        },
        steps: [
          {
            run: () => { CLS('v-op', 'pill acc'); SET('v-op', 'C++ 源码：<code>obj-&gt;encrypt(data);</code> —— 一次虚函数调用'); },
            note: '<b>起点：一次普通的虚函数调用。</b>编译器不知道 <code>obj</code> 运行时到底是哪个子类，所以它<b>不能直接写死函数地址</b>——必须运行时查表。这就是虚表存在的理由。'
          },
          {
            run: () => { CLS('v-obj0', 'cell hi'); },
            note: '<b>第一步：从对象首地址取出 vptr。</b>对应汇编 <code>LDR x8, [x0]</code>（x0 是 this 指针）。<br>这 8 个字节就是进入虚表世界的入口。<span class="hit">看到"先取对象头部"，就要想到可能是虚调用。</span>'
          },
          {
            run: () => { CLS('v-obj0', 'cell'); CLS('v-vt8', 'cell hi'); },
            note: '<b>第二步：在虚表里按固定槽位偏移取出函数地址。</b>对应汇编 <code>LDR x9, [x8, #0]</code>（<code>encrypt</code> 是第 0 个虚函数）。<br>' +
              '<b>关键：这个槽位偏移是编译期确定的</b>——因为 vtable 里的顺序就是类里虚函数的声明顺序，编译时就知道 <code>encrypt</code> 排第几。'
          },
          {
            run: () => { CLS('v-vt8', 'cell'); CLS('v-op', 'pill ok'); SET('v-op', '★ <code>BLR x9</code> —— 间接调用，控制流在这里"飞"出去'); },
            note: '<b>第三步：间接调用。</b>对应汇编 <code>BLR x9</code>（Branch with Link to Register）。<br>' +
              '<span class="hit">这就是虚调用的完整形态：两次解引用 + 间接跳转。</span><br>' +
              '<b>为什么它对逆向是噩梦：</b>IDA 静态分析时不知道 <code>x9</code> 会是什么值——' +
              '它取决于运行时 <code>obj</code> 的真实类型。所以 IDA 无法给出交叉引用，你按 X 键找不到谁调用了 <code>encrypt</code>。'
          },
          {
            run: () => { CLS('v-vt4', 'cell rd'); },
            note: '<b>额外收获：虚表 -1 槽指向 RTTI。</b>如果你想知道"这个对象到底是什么类"，可以：<br>' +
              '① 从对象取出 vptr　② 读 <code>vptr[-1]</code> 得到 <code>type_info</code> 对象　③ 读出里面的类型名字符串（mangled name，如 <code>_ZTS7AESCrypt</code>）。<br>' +
              '<span class="hit">这是运行时识别对象真实类型的标准手段，在 Hook 里非常有用。</span>'
          },
          {
            run: () => { CLS('v-vt0', 'cell wr'); },
            note: '<b>再说 -2 槽：offset-to-top。</b>它的值通常是 0（单继承）。' +
              '<b>但在多继承时</b>，第二个及以后的基类子对象会有各自的 vptr，且 offset-to-top 非 0——' +
              '编译器在调用这些基类的虚函数时，会先用这个值调整 <code>this</code> 指针。<br>' +
              '<span class="hit">看到非 0 的 offset-to-top，说明有多继承。</span>'
          },
          {
            run: () => { CLS('v-vt12', 'cell hi'); CLS('v-vt8', 'cell done'); },
            note: '<b>多态的实际效果：派生类覆盖虚函数时，只改 vtable 里的槽位。</b><br>' +
              '假设 <code>AESCrypt</code> 继承自 <code>BaseCrypt</code> 并重写了 <code>encrypt</code>：' +
              '那么 <code>AESCrypt</code> 的 vtable 第 0 槽指向 AESCrypt 的实现，而 <code>BaseCrypt</code> 的指向自己的。<br>' +
              '<b>对象还是那个对象，vptr 指向哪张表决定了调用谁</b>——这就是"多态"在内存层面的全部真相。'
          },
          {
            run: () => { CLS('v-op', 'pill ok'); SET('v-op', '✅ 虚调用全过程：取 vptr → 查槽位 → 间接跳转'); },
            note: '<b>总结这条路径。</b>以后在汇编里看到这个模式：<br>' +
              '<code>LDR x8, [x0]</code> → <code>LDR x9, [x8, #offset]</code> → <code>BLR x9</code><br>' +
              '你就知道：<b>这是一次虚函数调用</b>，<code>offset</code> 告诉你是第几个虚函数。<br><br>' +
              '<b>实战技巧：</b>在 Frida 里可以这样找到实际被调用的函数——<br>' +
              '<code>Interceptor.attach(ptr, { onEnter: function() { console.log(this.context.x9); } })</code>，' +
              '打印出 x9 就是真实的函数地址。'
          }
        ]
      },
      after:
        T.note('key', '🔑 虚表相关的三个实用结论',
          '<ol style="margin-bottom:0">' +
          '<li><b>识别虚调用</b>：<code>LDR (取vptr) → LDR (查槽) → BLR (间接跳)</code> 三段式</li>' +
          '<li><b>识别类型</b>：<code>vptr[-1]</code> → <code>type_info</code> → mangled name 字符串</li>' +
          '<li><b>识别多继承</b>：<code>vptr[-2]</code>（offset-to-top）非 0，或对象里有多个 vptr</li>' +
          '</ol>')
    },

    /* ============================================================ 17.5 */
    {
      h: '17.5', title: '内联汇编与 Syscall：把理论落到实操',
      html:
        '<p>课程把「内联汇编与 syscall」放在本章最后，是有道理的——' +
        '它是前面所有知识的<strong>实操出口</strong>：你要自己写一段汇编让它跑起来，' +
        '就必须真正搞懂寄存器、调用约定、<span class="term" data-def="Stack Frame，栈帧。每次函数调用在栈上开辟的一块区域，存放局部变量、保存的寄存器与返回地址。序言建立它，尾声销毁它。">栈帧</span>。</p>' +
        '<p>而且在逆向场景里，syscall 尤其重要：<strong>它是第 27 章「绕过 Frida 检测」的技术基础</strong>。' +
        'App 直接内联 SVC 发起系统调用时，所有基于 Hook libc 函数的监控都会失效。' +
        '本章先把机制讲清楚，第 27 章再讲怎么追踪它。</p>',

      stepper: {
        title: '内联汇编实现 open() 系统调用（ARM32 vs AArch64）',
        lines: [
          {
            code: '<span class="c">// === ARM32：用内联汇编直接发起 open() ===</span>\n' +
                  '<span class="t">int</span> <span class="f">my_open</span>(<span class="k">const char</span>* path, <span class="t">int</span> flags) {',
            note: '<b>目标：不用 libc 的 <code>open()</code>，自己用 <code>SVC</code> 指令发起系统调用。</b><br>' +
              '为什么要这样做？两个原因：<br>' +
              '① <b>学习</b>：理解系统调用的完整机制<br>' +
              '② <b>对抗</b>：绕过对 libc 函数的 Hook（第 27 章的核心手法）<br>' +
              'ARM32 和 AArch64 的寄存器约定<b>完全不同</b>，我们并排看。',
            state: { '架构': 'ARM32 (EABI)', '参数': 'path, flags', '目标': '发起 open 系统调用' }
          },
          {
            code: '  <span class="t">register int</span> r7 <span class="k">asm</span>(<span class="s">"r7"</span>) = <span class="n">5</span>;      <span class="c">// __NR_open</span>',
            note: '<b>★ ARM32 的关键：系统调用号放在 <code>r7</code>。</b><br>' +
              '这里用 GCC 的<strong>寄存器变量</strong>语法（<code>register int r7 asm("r7")</code>）把变量直接绑定到物理寄存器。' +
              '赋值 5 就是 <code>__NR_open</code>（在 32 位 ARM 上）。<br>' +
              '<span class="hit">注意：系统调用号的具体数值随架构与版本变化，以目标平台的头文件为准。</span>' +
              '（AArch64 上 open 的调用号就不是 5。）',
            state: { '架构': 'ARM32', 'r7': '5 = __NR_open', 'r0': 'path 指针', 'r1': 'flags' },
            mem: 'ARM32 系统调用寄存器约定\n\n  r7  ← 系统调用号（关键！）\n  r0  ← 参数 1\n  r1  ← 参数 2\n  r2  ← 参数 3\n  r3  ← 参数 4\n  r4  ← 参数 5\n  r5  ← 参数 6\n  r0  ← 返回值（输出）\n\n  SVC #0 触发陷入'
          },
          {
            code: '  <span class="k">int</span> ret;',
            note: '准备接收返回值。<b>系统调用的返回值总是放在 <code>r0</code></b>（ARM32）或 <code>x0</code>（AArch64）。' +
              '这与普通函数调用的返回值寄存器是一致的——这是 ARM 的设计选择。',
            state: { '架构': 'ARM32', 'r7': '5', 'ret': '待写入' }
          },
          {
            code: '  <span class="k">asm volatile</span> (<span class="s">"mov r0, %1\\n\\t"</span>',
            note: '<b>开始写内联汇编。</b><code>asm volatile</code> 告诉编译器：这是汇编代码，且<b>不要优化掉它</b>（volatile 防止被当成无用代码删除）。<br>' +
              '格式是 <code>asm volatile(汇编模板 : 输出 : 输入 : 破坏列表)</code>。<br>' +
              '<code>mov r0, %1</code> 把第 1 个输入操作数（path）放进 <code>r0</code>——这是系统调用的第一个参数寄存器。',
            state: { '架构': 'ARM32', 'r7': '5', 'r0': 'path 指针（已就位）', '下一步': '设置 r1' }
          },
          {
            code: '                <span class="s">"mov r1, %2\\n\\t"</span>',
            note: '把第 2 个输入（flags）放进 <code>r1</code>——第二个参数寄存器。<br>' +
              '<span class="hit">注意这个"参数依次放进 r0、r1、r2……"的过程，正是 libc 封装函数内部做的事。</span>' +
              '现在我们手动重放了一遍，所以不再需要 libc。',
            state: { '架构': 'ARM32', 'r7': '5', 'r0': 'path', 'r1': 'flags' }
          },
          {
            code: '                <span class="s">"svc #0\\n\\t"</span>',
            note: '<b>★ 核心指令：<code>SVC #0</code>（Supervisor Call）。</b><br>' +
              '执行这一条时，CPU 从<b>用户态（EL0）</b>陷入<b>内核态（EL1）</b>：<br>' +
              '① 异常向量表接管控制权<br>' +
              '② 内核读出 <code>r7</code> 里的系统调用号（5）<br>' +
              '③ 在 syscall 分发表里找到对应处理函数<br>' +
              '④ 从 r0、r1 读参数，执行真正的文件打开<br>' +
              '⑤ 结果写回 <code>r0</code>，返回用户态<br><br>' +
              '<b>ARM32 的 SVC #0 机器码是 <code>0xEF000000</code></b>——第 27 章做静态扫描时就是搜这个。',
            state: { '架构': 'ARM32', '指令': '0xEF000000', '特权级': 'EL0 → EL1 → EL0', 'r0': '系统调用返回值' },
            mem: 'SVC 陷入过程\n\n  用户态 EL0            内核态 EL1\n  ─────────────         ─────────────\n  r7 = 5\n  r0 = path\n  r1 = flags\n  SVC #0  ─────────────▶ 异常向量表\n                        ↓\n                       读 r7 → 查 syscall 表\n                        ↓\n                       执行 sys_open(path, flags)\n                        ↓\n  r0 = fd   ◀─────────── 写回 r0，返回'
          },
          {
            code: '                <span class="s">"mov %0, r0"</span>',
            note: '把 <code>r0</code>（系统调用的返回值，也就是文件描述符）取出来赋给 C 变量 <code>ret</code>。<br>' +
              '<code>%0</code> 是第一个<strong>输出</strong>操作数。到这里一次完整的系统调用就结束了。',
            state: { '架构': 'ARM32', 'r0': 'fd（文件描述符）', 'ret': '已写入' }
          },
          {
            code: '    : <span class="s">"=r"</span>(ret) : <span class="s">"r"</span>(path), <span class="s">"r"</span>(flags) : <span class="s">"r0"</span>, <span class="s">"r1"</span>, <span class="s">"memory"</span>);',
            note: '<b>约束部分——这是内联汇编最容易写错的地方。</b><br>' +
              '• <code>"=r"(ret)</code>：<b>输出</b>，用任意通用寄存器承载，写回 ret<br>' +
              '• <code>"r"(path), "r"(flags)</code>：<b>输入</b>，编译器负责把它们放进合适的寄存器<br>' +
              '• <code>"r0", "r1"</code>：<b>破坏列表</b>，告诉编译器"我们改了 r0 和 r1，别指望它们保持原值"<br>' +
              '• <code>"memory"</code>：告诉编译器"这段代码可能读写内存，别把内存访问乱序优化"<br><br>' +
              '<span class="hit">漏掉破坏列表是经典 bug</span>——编译器会以为 r0/r1 没变，导致莫名其妙的结果错乱。',
            state: { '架构': 'ARM32', '输出': 'ret', '输入': 'path, flags', '破坏': 'r0, r1, memory' }
          },
          {
            code: '  <span class="k">return</span> ret;\n}',
            note: '返回系统调用的结果。<b>ARM32 版本完成。</b><br>' +
              '接下来看 AArch64 —— 它的约定完全不同，<b>系统调用号从 r7 变成了 x8</b>。' +
              '这是很多人第一次写 AArch64 内联汇编时会踩的坑。',
            state: { '架构': 'ARM32', '状态': '✅ 完成', '返回值': 'ret = fd' }
          },
          {
            code: '<span class="c">// === AArch64：同样的功能，不同的寄存器约定 ===</span>\n' +
                  '<span class="t">int</span> <span class="f">my_open64</span>(<span class="k">const char</span>* path, <span class="t">int</span> flags) {',
            note: '<b>现在换成 AArch64。</b>功能完全一样，但寄存器约定变了：<br>' +
              '• 系统调用号：<b>r7 → x8</b><br>' +
              '• 参数：<b>r0-r6 → x0-x5</b><br>' +
              '• 返回值：<b>r0 → x0</b><br>' +
              '<span class="hit">这是"换个架构就全部重学"的典型例子——但只要你理解了机制，变化只是映射关系。</span>',
            state: { '架构': 'AArch64', '系统调用号寄存器': 'x8', '参数寄存器': 'x0-x5' },
            mem: 'AArch64 系统调用寄存器约定\n\n  x8  ← 系统调用号（对应 ARM32 的 r7）\n  x0  ← 参数 1\n  x1  ← 参数 2\n  x2  ← 参数 3\n  x3  ← 参数 4\n  x4  ← 参数 5\n  x5  ← 参数 6\n  x0  ← 返回值（输出）\n\n  SVC #0 触发陷入'
          },
          {
            code: '  <span class="k">register long</span> x8 <span class="k">asm</span>(<span class="s">"x8"</span>) = <span class="c">/* __NR_openat 等 */</span> <span class="n">56</span>;',
            note: '<b>AArch64 把系统调用号放在 <code>x8</code>。</b><br>' +
              '⚠️ 注意：<b>AArch64 上现代 Linux 更常用 <code>openat</code> 而不是 <code>open</code></b>，' +
              '调用号也不同（示意值为 56，<b>具体以目标头文件为准</b>）。<br>' +
              '<span class="hit">这个"调用号必须查头文件"的习惯很重要</span>——不同架构、不同内核版本都可能不同，' +
              '凭记忆写数值是危险的。',
            state: { '架构': 'AArch64', 'x8': '56（openat 示意值）', 'x0': 'path', 'x1': 'flags' }
          },
          {
            code: '  <span class="k">asm volatile</span> (<span class="s">"mov x0, %1\\n\\t"</span>',
            note: '设置第一个参数 <code>x0</code>。<br>' +
              '<b>与 ARM32 版本的对比：</b>结构完全一样，只是寄存器名从 <code>r0</code> 变成 <code>x0</code>。<br>' +
              '这说明<b>内联汇编的"套路"是可以迁移的</b>——理解了一次，换架构只是改寄存器名。',
            state: { '架构': 'AArch64', 'x8': '56', 'x0': 'path（已就位）' }
          },
          {
            code: '                <span class="s">"mov x1, %2\\n\\t"</span>',
            note: '设置第二个参数 <code>x1</code>。',
            state: { '架构': 'AArch64', 'x8': '56', 'x0': 'path', 'x1': 'flags' }
          },
          {
            code: '                <span class="s">"svc #0\\n\\t"</span>',
            note: '<b>AArch64 的 <code>SVC #0</code>，机器码是 <code>0xD4000001</code></b>（与 ARM32 的 <code>0xEF000000</code> 不同）。<br>' +
              '⚠️ 一个容易踩的坑：<b>AArch64 的 SVC 立即数编码方式与 ARM32 不同</b>，' +
              '如果你在做跨架构的字节码扫描，必须<b>分别用这两个特征值</b>。<br>' +
              '陷入过程与 ARM32 相同：EL0 → EL1 → 查 x8 分发 → 返回。<br><br>' +
              '<b>为什么这两条指令对逆向很重要：</b>第 27 章要找 App 里"绕过 libc 的系统调用"，' +
              '靠的就是扫描这两个机器码特征。',
            state: { '架构': 'AArch64', '指令': '0xD4000001', '特权级': 'EL0 → EL1 → EL0', 'x0': '返回值' }
          },
          {
            code: '                <span class="s">"mov %0, x0"</span>',
            note: '取出 <code>x0</code> 里的返回值。<b>注意是 <code>x0</code> 不是 <code>r0</code></b>——' +
              'AArch64 没有 r0 这个寄存器名（虽然底层是同一套物理寄存器的演进）。',
            state: { '架构': 'AArch64', 'x0': 'fd', '输出': 'ret 已写入' }
          },
          {
            code: '    : <span class="s">"=r"</span>(ret) : <span class="s">"r"</span>(path), <span class="s">"r"</span>(flags) : <span class="s">"x0"</span>, <span class="s">"x1"</span>, <span class="s">"x8"</span>, <span class="s">"memory"</span>);',
            note: '<b>约束部分——注意破坏列表里多了 <code>"x8"</code>。</b><br>' +
              '因为我们改动了 <code>x8</code>（写入系统调用号），必须告诉编译器。' +
              'ARM32 版本改动的是 <code>r7</code>，同样应该在破坏列表里声明 <code>"r7"</code>。<br>' +
              '<span class="hit">规律：凡是被内联汇编修改过的寄存器，都要进破坏列表。漏一个就可能有隐蔽 bug。</span>',
            state: { '架构': 'AArch64', '输出': 'ret', '输入': 'path, flags', '破坏': 'x0, x1, x8, memory' }
          },
          {
            code: '  <span class="k">return</span> ret;\n}',
            note: '<b>两个版本都完成了。</b>把这段代码放进 NDK 工程编译，就能得到一个<b>完全不依赖 libc 的 open 实现</b>。<br><br>' +
              '<b>这个练习的价值：</b><br>' +
              '• 你亲手验证了前面学的寄存器约定和调用约定<br>' +
              '• 你理解了 libc 封装层到底做了什么（就是设置寄存器 + SVC）<br>' +
              '• 你为第 27 章的"绕过 libc Hook"打好了基础<br><br>' +
              '<span class="hit">这也解释了为什么"直接内联 SVC"能绕过 Hook：Hook libc 函数的人，拦的是 libc 的封装层；' +
              '你跳过这一层直接进内核，他的钩子自然就落空了。</span>',
            state: { 'ARM32': 'r7 = 调用号', 'AArch64': 'x8 = 调用号', '共同点': 'SVC #0 陷入内核', '状态': '✅ 完成' }
          }
        ]
      },

      after:
        T.note('key', '🔑 ARM32 与 AArch64 的 syscall 对照（背下来）',
          T.tbl(['', 'ARM32 (EABI)', 'AArch64'],
            [
              ['系统调用号', '<b><code>r7</code></b>', '<b><code>x8</code></b>'],
              ['参数', '<code>r0</code> - <code>r6</code>', '<code>x0</code> - <code>x5</code>'],
              ['返回值', '<code>r0</code>', '<code>x0</code>'],
              ['指令', '<code>SVC #0</code>', '<code>SVC #0</code>'],
              ['机器码', '<b><code>0xEF000000</code></b>', '<b><code>0xD4000001</code></b>']
            ]) +
          '<p style="margin-bottom:0"><b>这两个机器码是第 27 章静态扫描的key</b>——它们能让你在 so 里' +
          '定位出所有"直接发起的系统调用"，而这些调用正是 Hook 监控的盲区。</p>') +
        T.note('warn', '⚠️ 写内联汇编的三个常见错误',
          '<ol style="margin-bottom:0">' +
          '<li><b>漏写破坏列表</b>：改了寄存器却没告诉编译器 → 编译器基于错误的假设优化 → 隐蔽的结果错乱。' +
          '规则是"改了什么就声明什么"。</li>' +
          '<li><b>忘记 <code>volatile</code></b>：如果内联汇编没有输出操作数，编译器可能认为它"没有副作用"而直接删掉。</li>' +
          '<li><b>凭记忆写系统调用号</b>：不同架构、不同内核版本的调用号会变。' +
          '<b>永远去查目标平台的头文件</b>（<code>asm/unistd.h</code> 等），不要背数值。</li>' +
          '</ol>') +
        T.note('ok', '✅ 本章与后面章节的衔接',
          '<p>到这里你已经具备了三样东西：<b>读汇编的能力</b>（17.2）、' +
          '<b>理解 C++ 对象布局的能力</b>（17.4）、<b>亲自写底层代码的能力</b>（17.5）。</p>' +
          '<p style="margin-bottom:0">接下来的路线是：<b>第 19 章</b>用这些能力去读懂 OLLVM 混淆后的代码；' +
          '<b>第 22、23 章</b>用它们还原加密算法；<b>第 27 章</b>则会把本节的 syscall 知识' +
          '发展成一套完整的"绕过 Hook 监控"技术。</p>')
    },

    /* ============================================================ 17.6 决策 */
    {
      h: '17.6', title: '决策演练：真实工程里怎么选',
      html: '<p>下面三个情境都来自真实的逆向工作。请认真选——选错了我不会只告诉你答案，还会讲清错在哪。</p>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一',
            scenario: '<b>情境：</b>你在 IDA 里定位到一个加密函数，偏移 <code>0x2BD4</code>。' +
                      '用 Frida 写 <code>Interceptor.attach(base.add(0x2BD4), {...})</code>，脚本不报错，' +
                      '但 <code>onEnter</code> 从来不会触发。App 功能正常，说明这个函数确实在用。',
            q: '你的第一个动作是？',
            choices: [
              { t: '先试 <code>base.add(0x2BD4 + 1)</code>，看是不是 Thumb 函数', next: 'n1' },
              { t: '在 IDA 里重新确认这个偏移算对了没有（减去 ImageBase）', next: 'n2' },
              { t: '怀疑函数被内联了，改用 Stalker 全量 trace', next: 'n3' },
              { t: '检查 so 是不是延迟加载的，加个 setTimeout 再 attach', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'good',
            verdictTitle: '正确：这是零成本的检查，应该第一个做',
            result: '<b>这是一次改动一个数字、耗时 5 秒的检查，而它命中的概率极高。</b><br><br>' +
              '<b>原理：</b>ARM 用地址最低位标记指令集。so 库大量使用 Thumb（体积小 30%），' +
              '所以"忘了 +1"是 Native Hook 静默失效的<b>头号原因</b>。<br><br>' +
              '<b>为什么它符合"先做便宜的检查"原则：</b><br>' +
              '• 改动成本：一个字符<br>' +
              '• 命中概率：很高（armeabi-v7a 的 so 大多有 Thumb 代码）<br>' +
              '• 失败无副作用：如果不触发，说明不是这个原因，你只花了 5 秒<br><br>' +
              '<span class="hit">排查的黄金法则：把检查按"成本 ÷ 命中率"排序，从最划算的开始。</span>'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'bad',
            verdictTitle: '方向对，但成本比 +1 高，且你还没排除更可能的原因',
            result: '确认偏移的算法是对的，<b>但这不是第一步该做的</b>。<br><br>' +
              '<b>问题在于成本：</b>回 IDA 核对 ImageBase、看 section 映射关系、重新计算——' +
              '这要花几分钟，而"+1"只要 5 秒且命中率更高。<br><br>' +
              '<b>特殊情况：</b>如果你在 IDA 里看到的地址是 <code>.text:00002BD4</code> 这种带段名的，' +
              '那它<b>已经是虚拟地址</b>，减去 ImageBase（通常 IDA 里是 0）就是偏移，一般不会错。<br><br>' +
              '<b>正确的排查顺序：</b><ol>' +
              '<li>打印 <code>base</code> 和 <code>addr</code>，确认地址是有效值（不是 null）</li>' +
              '<li>试 Thumb +1（<b>5 秒</b>）</li>' +
              '<li>在 IDA 里跳转到该地址，确认它真是函数入口（不是代码中间）</li>' +
              '<li>才轮到怀疑内联、延迟加载</li></ol>'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '跳过了所有便宜检查，直接上最重的武器',
            result: '<b>内联确实是 Native Hook 失效的原因之一，但它排在排查列表的最后。</b><br><br>' +
              '<b>为什么不该先用 Stalker：</b><br>' +
              '• 全量指令级 trace 会让 App 慢 <b>10-100 倍</b>，通常直接卡死或 ANR<br>' +
              '• 即使跑起来，海量输出会淹没你，定位成本极高<br>' +
              '• 而它要验证的假设（内联）概率远低于"Thumb 没 +1"<br><br>' +
              '<b>成本对比：</b>改一个数字（5 秒）vs 全量 trace（几十分钟 + 可能失败）。' +
              '<span class="hit">先做便宜的检查，这是工程判断力。</span>'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '这个假设与现象不符',
            result: '<b>关键推理：如果 so 没加载，会怎样？</b><br><br>' +
              '<code>Module.findBaseAddress(&quot;libx.so&quot;)</code> 会返回 <code>null</code>，' +
              '紧接着 <code>null.add(0x2BD4)</code> 会<b>直接抛异常</b>——你的脚本会报错，而不是"静默不触发"。<br><br>' +
              '你的现象是<b>"脚本不报错，但 onEnter 不触发"</b>，这说明：<br>' +
              '• 地址算出来了（base 不是 null）<br>' +
              '• attach 成功了（没抛错）<br>' +
              '• 只是<b>执行流没走到那个地址上</b><br><br>' +
              '这强烈指向<b>指令集模式错误</b>（Thumb 位）或<b>函数被内联</b>，而不是加载时机。<br><br>' +
              '<b>另外：</b>用 <code>setTimeout</code> 而不是 <code>Module.load</code> 事件监听，' +
              '本身就是不可靠的做法——应该用 <code>Process.attachModuleObserver</code> 或 ' +
              '<code>Module.load</code> 这类确定性机制。'
          }
        }
      }
    },

    {
      html: '<div id="decision-2"></div>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境二',
            scenario: '<b>情境：</b>你在分析一个 C++ 写的签名算法。在 IDA 里看到这样一段：<br><br>' +
                      '<code>LDR x8, [x0]</code><br><code>LDR x9, [x8, #0x18]</code><br><code>BLR x9</code><br><br>' +
                      '你想知道这里到底调用了哪个函数，但按 X 键看不到交叉引用。',
            q: '你怎么确定实际调用的函数？',
            choices: [
              { t: '用 Frida hook 这条 BLR，打印 x9 的值，然后在 IDA 里跳过去看', next: 'n1' },
              { t: '这个模式太复杂，放弃这里，去找其他调用点', next: 'n2' },
              { t: '在 IDA 里手工把所有子类的 vtable 都建出来，逐个比对 0x18 槽位', next: 'n3' },
              { t: '读 vptr[-1] 拿到 RTTI，确定对象真实类型后再查它的 vtable', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'good',
            verdictTitle: '正确：动态取值是最直接可靠的手段',
            result: '<b>这是"静态看不懂就动态看"的典型应用——本章（以及整门课）的核心方法论。</b><br><br>' +
              '<b>具体做法：</b><br>' +
              '<code>Interceptor.attach(目标地址, { onEnter: function() {' +
              ' console.log("实际调用:", this.context.x9); } })</code><br><br>' +
              '拿到地址后：<br>' +
              '① 用 <code>DebugSymbol.fromAddress(addr)</code> 看有没有符号<br>' +
              '② 减去 so 基址得到偏移，在 IDA 里 <code>G</code> 跳过去，就是真实的函数实现<br><br>' +
              '<b>为什么这个方案最好：</b><br>' +
              '• <b>确定性强</b>：这是运行时真实的值，不是推测<br>' +
              '• <b>成本低</b>：在已有的 hook 里加一行 <code>console.log</code><br>' +
              '• <b>不需要理解全部继承体系</b>：你不用知道有几个子类，运行时自然会告诉你答案<br><br>' +
              '<span class="hit">虚调用让静态分析失效，但动态执行永远会暴露真相。</span>'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'bad',
            verdictTitle: '这是放弃，不是策略',
            result: '<b>这个模式不是"复杂"，它是最标准的虚函数调用形式——本章 17.4 节专门讲了它。</b><br><br>' +
              '如果连这个都跳过，你在 C++ 写的 so 里会寸步难行：<b>大量加密算法都封装在类里，多态到处都是</b>。<br><br>' +
              '<b>更重要的是心态问题：</b>看到看不懂的代码就绕开，会让你永远停在"只会看简单样本"的水平。<br><br>' +
              '<b>正确的心态是：</b>把"看不懂"当成信号——说明这里有你需要补的知识点。' +
              '虚调用看不懂 → 回去补 vtable 的内存布局（17.4 节）；' +
              '位运算看不懂 → 补位操作套路。<br><br>' +
              '<b>而且这个具体问题有个 5 分钟就能解决的答案</b>（选项 A 或 D），根本不需要放弃。'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '理论可行，但成本极高且容易出错',
            result: '<b>先肯定：这个思路是对的</b>——通过分析 vtable 来确定调用目标，确实是静态分析的标准方法。<br><br>' +
              '<b>但问题在成本：</b><br>' +
              '• 你要找出<b>所有</b>可能的子类（可能十几个，还在不同 so 里）<br>' +
              '• 为每个子类重建 vtable，确认第 <code>0x18/8 = 3</code> 个虚函数是什么<br>' +
              '• 还得确认运行时到底是哪个子类——而这一点<b>静态根本确定不了</b>（可能有分支决定，也可能来自外部输入）<br><br>' +
              '<b>致命缺陷：</b>即使你建完了所有 vtable，你依然不知道<b>这次运行</b>用的是哪个。' +
              '你等于做了一大堆工作，最后还是得靠动态验证。<br><br>' +
              '<b>什么时候这个方法才值得用：</b>当你要做<b>完整的静态还原</b>（比如写论文、做二进制比对），' +
              '且样本不大时。日常逆向，动态取值就够了。'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'good',
            verdictTitle: '正确：这是另一个方向的漂亮解法',
            result: '<b>这个方法很聪明，而且它解决的是"类型识别"这个更本质的问题。</b><br><br>' +
              '<b>原理（本章 17.4 节讲过）：</b>Itanium C++ ABI 规定 <code>vptr[-1]</code> 指向 <code>type_info</code> 对象，' +
              '里面有类型名。所以：<br>' +
              '① 从对象取 <code>vptr</code>　② 读 <code>vptr[-1]</code>　③ 读出 mangled name<br>' +
              '④ 用 <code>c++filt</code> 或 IDA 自动还原成可读类名<br>' +
              '⑤ 然后在 IDA 里找这个类的 vtable（符号名形如 <code>_ZTV7AESCrypt</code>），' +
              '读它的第 3 槽（<code>0x18/8</code>），就是函数地址<br><br>' +
              '<b>相比选项 A 的优势：</b>你不只知道"调用了哪个函数"，还知道"对象是什么类"——' +
              '这在分析复杂继承体系时价值更大。<br><br>' +
              '<b>相比选项 A 的劣势：</b>步骤更多，且如果代码用了 <code>-fno-rtti</code> 编译（很多加固会关掉 RTTI），' +
              '<code>vptr[-1]</code> 可能无效。<br><br>' +
              '<span class="hit">实战建议：两个都用。先用 D 了解类型体系，再用 A 确认实际调用。</span>'
          }
        }
      }
    },

    {
      html: '<div id="decision-3"></div>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境三',
            scenario: '<b>情境：</b>你要还原一个算法，需要在 Frida 里 Hook 一个原型如下的函数：<br><br>' +
                      '<code>long compute(const char* input, size_t len, double factor, struct Config* cfg)</code><br><br>' +
                      '你写了 <code>args[0]</code> 到 <code>args[3]</code> 来读参数，' +
                      '但发现 <code>args[2]</code>（应该是 <code>double factor</code>）读出来是个垃圾值。',
            q: '问题出在哪？',
            choices: [
              { t: '参数顺序搞错了，应该重新数一遍', next: 'n1' },
              { t: '<code>double</code> 是浮点数，走 v 寄存器而不是 x 寄存器，<code>args[]</code> 读不到', next: 'n2' },
              { t: '函数有 4 个参数，超过了寄存器数量所以压栈了', next: 'n3' },
              { t: 'AArch64 的结构体参数必须用指针传，不能传值', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'bad',
            verdictTitle: '顺序没错——是寄存器的类型不同',
            result: '<b>如果顺序错了，其他参数也会是垃圾。</b>但你的现象是只有 <code>args[2]</code> 不对，' +
              '<code>args[0]</code>、<code>args[1]</code>、<code>args[3]</code> 都正常。<br><br>' +
              '这说明<b>参数顺序是对的，问题出在这个参数本身的传递方式上</b>。<br><br>' +
              '<b>关键线索：</b><code>args[2]</code> 对应的是 <code>double factor</code>——<b>浮点类型</b>。<br>' +
              '<span class="hit">在 AArch64 上，浮点参数走 <code>v0</code>-<code>v7</code>（向量/浮点寄存器），' +
              '而 <code>args[]</code> 读的是 <code>x0</code>-<code>x7</code>（通用寄存器）。两者是完全不同的寄存器组。</span>'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'good',
            verdictTitle: '正确：浮点参数走的是另一组寄存器',
            result: '<b>这是 Hook 加密函数时最常见的困惑之一。</b><br><br>' +
              '<b>AArch64 的参数传递规则（AAPCS64）：</b><br>' +
              '• <b>整数/指针</b> → <code>x0</code>-<code>x7</code>，<code>args[]</code> 能读到<br>' +
              '• <b>浮点/向量</b> → <code>v0</code>-<code>v7</code>，<code>args[]</code> <b>读不到</b><br>' +
              '• 两组寄存器<b>独立计数</b>，互不占用<br><br>' +
              '<b>所以你这个函数的实际传参是：</b><br>' +
              '<code>input</code> → x0　<code>len</code> → x1　<code>factor</code> → <b>v0</b>（不是 x2！）　<code>cfg</code> → x2<br><br>' +
              '<b>注意这里：</b>因为 <code>factor</code> 走 v 寄存器，它<b>不占用整数寄存器名额</b>，' +
              '所以 <code>cfg</code> 反而进了 <code>x2</code>。这就是为什么 <code>args[3]</code> 读出来也不对的原因。' +
              '（你的现象里 <code>args[3]</code> 可能也是错的，只是你没注意。）<br><br>' +
              '<b>正确做法：</b>用 <code>this.context.v0</code>（或对应的浮点视图）来读：<br>' +
              T.code('<span class="f">Interceptor.attach</span>(addr, {\n' +
                '  <span class="f">onEnter</span>: <span class="k">function</span> (args) {\n' +
                '    <span class="k">var</span> input = args[<span class="n">0</span>].<span class="f">readUtf8String</span>();\n' +
                '    <span class="k">var</span> len   = args[<span class="n">1</span>].<span class="f">toInt32</span>();\n' +
                '    <span class="c">// double 参数要从向量寄存器读</span>\n' +
                '    <span class="k">var</span> factor = <span class="k">this</span>.context.<span class="f">d0</span>;   <span class="c">// d0 = v0 的低 64 位（double 视图）</span>\n' +
                '    <span class="k">var</span> cfg    = args[<span class="n">2</span>];  <span class="c">// 注意是 2 不是 3！</span>\n' +
                '  }\n' +
                '});') +
              '<b>寄存器视图对照：</b><code>v0</code> / <code>d0</code>（double）/ <code>s0</code>（float）/ <code>q0</code>（128位）' +
              '指的是同一个寄存器的不同宽度解读。'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '算错了：4 个参数远没到上限',
            result: '<b>AArch64 有 8 个整数参数寄存器（x0-x7）</b>，4 个参数完全放得下，不会压栈。<br><br>' +
              '（对比：ARM32 只有 r0-r3 四个，第 5 个参数才需要压栈。）<br><br>' +
              '<b>更重要的：</b>即使参数真的压栈了，<code>args[]</code> 依然能读到——' +
              'Frida 会帮你处理栈上的参数。所以"压栈"不会导致读到垃圾值。<br><br>' +
              '<b>真正的原因是浮点参数走了不同的寄存器组</b>（选项 B）。' +
              '这类问题的特征很明显：<b>只有浮点类型的参数读不到，其他都正常</b>。'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '把规则记反了',
            result: '<b>实际上，较小的结构体在 AArch64 上是<b>可以按值传递</b>的</b>（会被拆分到多个寄存器里）。' +
              '只有大到超过寄存器容量，或者有特殊要求（如含非平凡拷贝构造）的结构体才会隐式转为指针传递。<br><br>' +
              '<b>而且这与你观察到的现象无关</b>：<br>' +
              '• <code>args[3]</code> 对应 <code>struct Config* cfg</code>，它本来<b>就是一个指针</b>（源码里写了 <code>*</code>）<br>' +
              '• 指针走整数寄存器，<code>args[]</code> 能正常读到<br><br>' +
              '<b>你真正遇到的问题在 <code>args[2]</code></b>，那是个 <code>double</code>——' +
              '规则是"浮点走 v 寄存器"，与结构体无关。'
          }
        }
      }
    },

    /* ============================================================ 17.6 测验 */
    {
      h: '17.7', title: '自测：检查你的模型有没有歪',
      quiz: {
        id: 'q3-1', chapter: 3, answer: 2,
        stem: '在 Frida 里 Hook 一个 Thumb 编译的 so 函数，地址为什么要 +1？',
        options: [
          { t: '因为 Thumb 指令比 ARM 指令短 1 字节', why: '错误。Thumb 是 2/4 字节混合，不是"短 1 字节"。' },
          { t: '因为 +1 可以跳过函数开头的序言指令', why: '错误。+1 是地址标记位，不是偏移调整。' },
          { t: '因为 ARM 用地址最低位标记指令集，Thumb 函数的最低位是 1', why: '正确。' },
          { t: '这是 Frida 的历史遗留 bug，必须绕过', why: '错误。这是 ARM 架构的设计，不是 bug。' }
        ],
        explain: '<b>ARM 处理器用函数地址的最低一个 bit 来标记该函数使用哪种指令集：</b><br>' +
          '• 最低位 = 0 → ARM 指令集（4 字节定长）<br>' +
          '• 最低位 = 1 → <b>Thumb 指令集</b>（2/4 字节混合）<br><br>' +
          '这个设计让 <code>BX</code>/<code>BLX</code> 能在一条指令里同时完成"跳转"和"切换指令集"。<br><br>' +
          '<b>为什么这个坑特别毒：</b>传错地址<b>不会报错</b>。Interceptor 会按 ARM 模式解析 Thumb 指令，' +
          '得到错误的指令边界，Hook 静默失效——你会以为是别的原因，排查半天。<br><br>' +
          '<b>注意：</b>AArch64 上全部是 4 字节定长指令，<b>没有这个问题</b>。' +
          '所以 64 位 so 不需要 +1。'
      }
    },
    {
      html: '<div id="quiz2"></div>',
      quiz: {
        id: 'q3-2', chapter: 3, answer: 1,
        stem: '一个带虚函数的 C++ 对象，其内存布局最可能是？',
        options: [
          { t: '所有成员变量，然后是一个指向虚表的指针', why: '顺序反了。vptr 在最前面（偏移 0）。' },
          { t: '一个 vptr（虚表指针）在偏移 0，后面跟着成员变量', why: '正确。' },
          { t: '虚表本身直接放在对象内部', why: '错误。对象里放的是指向虚表的<b>指针</b>，虚表在别处。' },
          { t: '没有额外开销，虚函数调用和普通函数一样', why: '错误。虚函数需要 vptr + 间接调用。' }
        ],
        explain: '<b>C++ 对象的内存布局（Itanium ABI，GCC/Clang 使用）：</b><br><br>' +
          '<b>无虚函数时</b>：对象只含成员变量，按声明顺序排列（考虑对齐）。大小 = 成员总大小 + padding。<br><br>' +
          '<b>有虚函数时</b>：对象<b>起始处插入 vptr</b>（64 位下 8 字节），指向该类的虚表。<br><br>' +
          '<b>虚表在别处</b>（通常在只读数据段），里面按<b>声明顺序</b>存放虚函数地址：<br>' +
          '<code>vtable[-2]</code> = offset-to-top（多继承用）<br>' +
          '<code>vtable[-1]</code> = 指向 <code>type_info</code>（RTTI）<br>' +
          '<code>vtable[0..n]</code> = 各个虚函数的地址<br><br>' +
          '<b>虚函数调用的汇编特征：</b><code>LDR x8, [x0]</code>（取 vptr）→ ' +
          '<code>LDR x9, [x8, #偏移]</code>（查槽位）→ <code>BLR x9</code>（间接调用）。'
      }
    },
    {
      html: '<div id="quiz3"></div>',
      quiz: {
        id: 'q3-3', chapter: 3, answer: 0,
        stem: '在 AArch64 上，一个 <code>double</code> 类型的位置参数通过什么传递？',
        options: [
          { t: '<code>v</code> 寄存器（如 <code>v0</code>），不是 <code>x</code> 寄存器', why: '正确。浮点参数走独立的向量寄存器组。' },
          { t: '<code>x0</code>-<code>x7</code>，和整数参数一样', why: '错误。这是 Hook 时读到垃圾值的常见原因。' },
          { t: '总是通过栈传递', why: '错误。只有寄存器不够时才压栈。' },
          { t: '通过 <code>sp</code> 指向的浮点栈', why: '错误。ARM 没有独立的浮点栈。' }
        ],
        explain: '<b>AArch64 的参数传递使用两组独立的寄存器：</b><br>' +
          '• <b>整数/指针</b> → <code>x0</code>-<code>x7</code><br>' +
          '• <b>浮点/向量</b> → <code>v0</code>-<code>v7</code><br><br>' +
          '两组<b>独立计数</b>，互不占用名额。<br><br>' +
          '<b>关键推论：</b>在 <code>long f(char* a, size_t b, double c, Config* d)</code> 里，<br>' +
          '<code>a</code>→x0、<code>b</code>→x1、<code>c</code>→<b>v0</b>、<code>d</code>→<b>x2</b>（不是 x3！）<br><br>' +
          '所以 Frida 的 <code>args[2]</code> 读到的是 <code>x2</code>（也就是 <code>d</code>），' +
          '而不是你以为的 <code>c</code>。这正是"参数读出来是垃圾"的根源。<br><br>' +
          '<b>正确读法：</b><code>this.context.d0</code>（double 视图）或 <code>this.context.s0</code>（float 视图）。'
      }
    },
    {
      html: '<div id="quiz4"></div>',
      quiz: {
        id: 'q3-4', chapter: 3, answer: 2,
        stem: '汇编里看到 <code>LDR w4, [x0, w3, SXTW #2]</code>，这是在做什么？',
        options: [
          { t: '把 x0 和 w3 相加后乘以 2', why: '错误。`#2` 是移位量，表示左移 2 位（×4）。' },
          { t: '从栈上加载一个 32 位值', why: '错误。基址是 x0，不是 sp。' },
          { t: '访问一个 int 数组的第 w3 个元素（基址 + 索引×4）', why: '正确。' },
          { t: '把 w3 符号扩展到 64 位', why: '部分正确（SXTW 确实做符号扩展），但这不是这条指令的主要目的——它是在做数组寻址。' }
        ],
        explain: '<b>这是 AArch64 数组访问的标准形态：</b><code>[基址, 索引, 移位]</code><br><br>' +
          '拆解这条指令：<br>' +
          '• <code>x0</code> —— 数组基址<br>' +
          '• <code>w3</code> —— 索引 <code>i</code>（32 位）<br>' +
          '• <code>SXTW</code> —— Sign Extend Word，把 32 位索引<b>符号扩展</b>成 64 位（因为地址计算必须用 64 位）<br>' +
          '• <code>#2</code> —— 左移 2 位，即 <b>乘以 4</b>（<code>int</code> 是 4 字节，log2(4) = 2）<br>' +
          '• <code>w4</code> —— 目标寄存器，接收加载的 32 位值<br><br>' +
          '<b>为什么用移位而不是乘法：</b>左移比乘法快，而元素大小总是 2 的幂，所以编译器总是用移位。<br><br>' +
          '<b>识别口诀：</b>移位量 = log2(元素大小)<br>' +
          '• <code>#0</code> → ×1（char / uint8）<br>' +
          '• <code>#1</code> → ×2（short / uint16）<br>' +
          '• <code>#2</code> → <b>×4（int / uint32 / float）</b><br>' +
          '• <code>#3</code> → ×8（long / pointer / double）<br><br>' +
          '<span class="hit">看到这个模式，就能立刻推断出数组元素的大小和类型。</span>'
      }
    }
  ],

  glossary: [
    { t: 'ARM（A32）', d: '4 字节定长指令集。特色是几乎每条指令都可带条件码（如 ADDEQ）。' },
    { t: 'Thumb（T16/T32）', d: '2/4 字节混合编码，代码密度高（体积小约 30%），安卓 so 大量使用。' },
    { t: 'AArch64', d: '64 位 ARM 架构。固定 32 位指令，31 个通用寄存器 x0-x30，参数用 x0-x7，返回值 x0。' },
    { t: 'Thumb 位', d: '<b>函数地址最低 bit 标记指令集</b>：1 = Thumb，0 = ARM。Frida Hook 时 Thumb 函数必须 +1，否则静默失效。' },
    { t: 'AAPCS / AAPCS64', d: 'ARM32 / AArch64 的过程调用标准，规定参数、返回值、栈帧与寄存器保存规则。' },
    { t: 'vptr', d: '虚表指针。有虚函数的 C++ 对象在<b>偏移 0</b> 处存放它，指向该类的虚表。' },
    { t: 'vtable（虚表）', d: '按虚函数<b>声明顺序</b>存放函数地址的表。<code>[-2]</code> 是 offset-to-top，<code>[-1]</code> 是 RTTI，<code>[0..n]</code> 是各虚函数。' },
    { t: '虚函数调用', d: '汇编形态为"两次解引用 + 间接跳转"：<code>LDR (取vptr) → LDR (查槽) → BLR</code>。静态分析无法确定目标。' },
    { t: 'RTTI', d: '运行时类型信息。<code>vptr[-1]</code> 指向 <code>type_info</code>，内含 mangled 类型名（如 <code>_ZTS7AESCrypt</code>）。' },
    { t: 'mangled name', d: 'C++ 名称修饰后的符号名。如 <code>_ZTV7AESCrypt</code> 是虚表、<code>_ZTI</code> 是 typeinfo、<code>_ZTS</code> 是类型名字符串。' },
    { t: '序言 / 尾声', d: '函数入口的现场保存（<code>STP x29,x30,[sp,#-16]!</code>）与出口的恢复（<code>LDP ... + RET</code>）。用于识别函数边界。' },
    { t: '跳转表', d: 'switch 语句的常见实现：<code>ADR</code> 加载表基址 + <code>LDR/LDRB</code> 索引取值 + <code>BR</code> 跳转。' }
  ],

  teacher: {
    id: 'ch3', chapter: 3,
    name: '追问老师 · 第三章',
    sub: '指令集、调用约定、对象布局——这三样不清楚，看汇编就是看天书',
    intro: '<p style="margin:0">这章全是硬知识，而硬知识最容易被"以为自己懂了"骗过去。<br>' +
           '我会逼你把机制说清楚：<b>为什么 +1？为什么要查表？为什么参数读不到？</b><br>' +
           '答不上来可以要提示，但提示不算过关。</p>',
    questions: [
      {
        id: 'c3q1', depth: 1, threshold: 0.7,
        q: 'ARM 用<b>地址最低位</b>标记指令集——请解释这个机制是怎么工作的，' +
           '以及它为什么会导致 Frida Hook <b>静默失效</b>（而不是报错）。',
        concepts: [
          { label: '最低位 = 1 表示 Thumb，= 0 表示 ARM', hint: '最低位取什么值代表哪种指令集？', any: ['最低位', '最低 bit', 'bit0', '最低一个 bit', 'lsb', '1 表示 thumb', '0 表示 arm', '奇偶'] },
          { label: 'Thumb 函数必须 +1，否则按 ARM 模式解析指令边界', hint: '传错了会发生什么？', any: ['+1', '加1', '加一', 'thumb 函数', '指令边界', '解析', '按 arm 模式'] },
          { label: '不报错的原因：地址本身合法，只是解析模式错了，Hook 装上了但不触发', hint: '为什么不是报错而是静默失败？', any: ['不报错', '合法', '有效地址', '装上了', '不触发', '静默', '永远不', '没反应'] }
        ],
        hints: [
          '这个 bit 是给谁看的？它跟 BX / BLX 指令有什么关系？',
          '如果地址是合法的、attach 也成功了，那失败会表现为"报错"还是"没反应"？'
        ],
        probes: [
          '追问：为什么 ARM 要用地址的最低位来标记指令集，而不是用另一个寄存器或标志位？',
          '这个机制在 AArch64 上还存在吗？为什么？'
        ],
        model: '<b>机制层面：</b><br><br>' +
          'ARM 处理器有两种指令集：<b>ARM</b>（A32，4 字节定长）和 <b>Thumb</b>（T16/T32，2/4 字节混合）。' +
          'CPU 在取指时必须知道"按哪种模式解析"——因为两者的指令编码规则完全不同。<br><br>' +
          'ARM 的解法很巧妙：<b>用函数地址的最低一个 bit 来携带这个信息</b>。<br>' +
          '• 最低位 = 0 → 按 <b>ARM</b> 模式解析<br>' +
          '• 最低位 = <b>1</b> → 按 <b>Thumb</b> 模式解析<br><br>' +
          '<b>为什么这样设计：</b>因为 ARM 指令至少 2 字节对齐，所以地址最低位本来就<b>永远是 0</b>（浪费的）。' +
          'ARM 把这个"废位"利用起来传递指令集信息，使得 <code>BX Rn</code> / <code>BLX Rn</code> ' +
          '能<b>用一条指令同时完成"跳转"和"切换指令集"</b>——跳过去之后 CPU 看 Rn 的最低位就知道该用哪种模式解码。<br><br>' +
          '<b>为什么会导致静默失效：</b><br>' +
          '你在 Frida 里写 <code>base.add(0x1A4C)</code>（最低位 = 0）。Frida 把这个地址交给 Interceptor，' +
          'Interceptor 看到最低位是 0，就<b>按 ARM 模式</b>去处理这个地址——读取 4 字节指令、保存、写入跳转指令。<br><br>' +
          '问题是：这个地址其实是 Thumb 代码。Thumb 指令的边界和 ARM 完全不同（2 字节对齐）。' +
          '于是 Interceptor 改写的字节<b>跨越了错误的指令边界</b>，破坏了 Thumb 指令的完整性。<br><br>' +
          '<b>结果：</b>地址是合法的（没越界）、attach 成功了（没抛异常）、跳转指令写进去了——' +
          '但因为改错了位置，执行流永远走不到你的 Hook 上。<b>脚本不报错，onEnter 不触发。</b><br><br>' +
          '<span class="hit">正确写法：<code>base.add(0x1A4C + 1)</code>。</span><br><br>' +
          '<b>补充：</b>这个机制是 ARM32 特有的。<b>AArch64 全部是 4 字节定长指令，没有指令集切换，也就没有这个问题</b>——' +
          '所以 64 位 so 的 Hook 不需要 +1。'
      },
      {
        id: 'c3q2', depth: 2, threshold: 0.75,
        q: '请完整描述 C++ 对象的<b>内存布局</b>，以及一次<b>虚函数调用</b>在汇编层面是怎么完成的。' +
           '要说清 vptr、vtable 的槽位含义，以及"两次解引用 + 间接跳转"这个模式。',
        concepts: [
          { label: 'vptr 在对象偏移 0，指向该类的 vtable', hint: 'vptr 放在对象的什么位置？它指向什么？', any: ['vptr', '虚表指针', '偏移 0', '起始', '开头', '第一个', '指向', 'vtable'] },
          { label: 'vtable[-1] 是 RTTI（type_info），vtable[-2] 是 offset-to-top', hint: '虚表的负槽位放的是什么？', any: ['-1', 'rtti', 'type_info', 'typeinfo', '-2', 'offset-to-top', '偏移'] },
          { label: '虚函数按声明顺序排在 vtable[0..n]', hint: '虚表里的函数是怎么排序的？', any: ['声明顺序', '顺序', '依次', '槽位', 'slot'] },
          { label: '调用过程：取 vptr → 按偏移查表取地址 → BLR 间接跳转', hint: '三次操作分别是什么？', any: ['ldr', 'blr', '间接', '跳转', '取 vptr', '查表', '解引用', '两次'] }
        ],
        hints: [
          '一个对象要在运行时知道"我是什么类、我的虚函数在哪"，它必须随身带一个什么东西？',
          '编译器不知道 obj 运行时是哪个子类，它怎么知道该调用哪个函数？'
        ],
        probes: [
          '追问：为什么编译器不能直接把函数地址写死在调用点，非要绕这一圈查表？',
          '如果 vtable[-1] 被去掉了（编译时加了 -fno-rtti），你还有什么办法确定对象的真实类型？'
        ],
        model: '<b>一、对象内存布局</b><br><br>' +
          '<b>无虚函数时：</b>对象只含成员变量，按声明顺序排列，考虑对齐。大小 = 成员总大小 + padding。<br><br>' +
          '<b>有虚函数时：</b>对象<b>起始处（偏移 0）插入 vptr</b>（虚表指针，64 位下 8 字节），' +
          '指向该类的 vtable。然后才是成员变量。<br><br>' +
          '<b>二、vtable 的结构</b>（Itanium C++ ABI，GCC/Clang 使用）<br>' +
          '<code>vtable[-2]</code> = <b>offset-to-top</b>：单继承时通常为 0；多继承时用于调整 <code>this</code> 指针<br>' +
          '<code>vtable[-1]</code> = 指向 <b><code>type_info</code> 对象</b>（RTTI），里面有 mangled 类型名字符串<br>' +
          '<code>vtable[0..n]</code> = 各个虚函数的地址，<b>按类中的声明顺序</b>排列<br><br>' +
          '<b>为什么按声明顺序很重要：</b>因为这个顺序在编译期就确定了，所以调用点可以写死一个<b>固定的槽位偏移</b>。' +
          '编译器不需要知道运行时是哪个子类，只需要知道"<code>encrypt</code> 是这个类第 3 个虚函数"，就能用 <code>[vptr + 0x18]</code> 取到。<br><br>' +
          '<b>三、虚函数调用的汇编三步</b><br>' +
          T.code('<span class="k">LDR</span>  <span class="r">x8</span>, [<span class="r">x0</span>]              <span class="c">; ① 从对象取 vptr（x0 是 this）</span>\n' +
            '<span class="k">LDR</span>  <span class="r">x9</span>, [<span class="r">x8</span>, <span class="n">#0x18</span>]        <span class="c">; ② 按固定槽位偏移取出函数地址</span>\n' +
            '<span class="k">BLR</span>  <span class="r">x9</span>                      <span class="c">; ③ 间接调用（Branch with Link to Register）</span>') +
          '<b>为什么必须这样绕：</b>因为编译器在编译调用点时，<b>不知道 <code>obj</code> 运行时到底是哪个子类</b>。' +
          '可能是 <code>AESCrypt</code>，也可能是 <code>RSACrypt</code>——只有运行时才知道。' +
          '所以它只能生成"运行时查表"的代码。这就是<b>动态绑定（多态）</b>的实现方式。<br><br>' +
          '<b>四、这对逆向意味着什么</b><br>' +
          '• <b>静态分析断链</b>：IDA 看到 <code>BLR x9</code> 时不知道 x9 是什么，无法给出交叉引用。你按 X 键找不到调用者。<br>' +
          '• <b>破解方法（动态）</b>：hook 那个地址，打印 <code>this.context.x9</code>，就得到真实的函数地址。<br>' +
          '• <b>破解方法（静态）</b>：读 <code>vptr[-1]</code> 拿 type_info 确定类，再查该类的 vtable 对应槽位。<br>' +
          '• <b>识别多继承</b>：如果对象里有多个 vptr，或者 <code>offset-to-top</code> 非 0，说明有多继承。',
        after: '<p style="margin-bottom:0">虚表是 C++ 逆向的分水岭。<b>以后在汇编里看到 <code>LDR → LDR → BLR</code> 三段式，' +
               '你应该立刻反应过来：这是一次虚调用，我可以动态取值拿到真实目标。</b></p>'
      },
      {
        id: 'c3q3', depth: 2, threshold: 0.7,
        q: '你在 Frida 里 Hook 一个函数，发现 <code>args[2]</code> 读出来是垃圾值。' +
           '请说出<b>至少两种</b>可能的原因，以及各自的判断方法。',
        concepts: [
          { label: '浮点参数走 v 寄存器（v0-v7），args[] 读的是 x 寄存器读不到', hint: '什么类型的参数不走 x 寄存器？', any: ['浮点', 'double', 'float', 'v 寄存器', 'v0', '向量寄存器', 'd0', 's0', 'fpu'] },
          { label: '前一个参数是浮点，导致整数寄存器编号错位（args 索引错位）', hint: '浮点参数会占用整数寄存器的名额吗？', any: ['错位', '索引', '不对应', '往后', '偏移', '顺序', '不占', '占名额'] },
          { label: '参数是结构体（按值传递），被拆分到多个寄存器或转为指针', hint: '如果参数是一个 struct 呢？', any: ['结构体', 'struct', '按值', '拆分', '指针', '指针传递'] },
          { label: '64 位返回值/参数要用完整寄存器读，或者该平台是 ARM32 参数超过 4 个压栈', hint: '还有其他传递方式吗？', any: ['arm32', '压栈', '栈', '超过', '32 位', '高位', '截断'] }
        ],
        hints: [
          '想想 AArch64 有几组参数寄存器？它们分别传什么类型？',
          '如果某个参数走的是另一组寄存器，那它还会占用 x 寄存器的名额吗？'
        ],
        probes: [
          '追问：如果参数是一个 16 字节的小结构体，AArch64 会怎么传？args[] 里能看到吗？',
          '如果一个函数同时有整数和浮点参数，Frida 的 args[] 索引和源码里的参数顺序还是一一对应的吗？'
        ],
        model: '<b>原因一：参数是浮点类型（最常见）</b><br><br>' +
          'AArch64 用<b>两组独立的寄存器</b>传参：<br>' +
          '• 整数 / 指针 → <code>x0</code>-<code>x7</code>，<code>args[]</code> 能读到<br>' +
          '• <b>浮点 / 向量 → <code>v0</code>-<code>v7</code>，<code>args[]</code> 读不到</b><br><br>' +
          '<b>判断方法：</b>看函数的源码原型或 IDA 里的反编译结果，确认第 3 个参数是不是 <code>float</code>/<code>double</code>。<br>' +
          '<b>解法：</b>从向量寄存器读——<code>this.context.d0</code>（double）或 <code>this.context.s0</code>（float）。' +
          '<code>v0</code>/<code>d0</code>/<code>s0</code>/<code>q0</code> 是同一个寄存器的不同宽度视图。<br><br>' +
          '<b>原因二：索引错位（浮点参数不占整数寄存器名额）</b><br><br>' +
          '这是原因一的<b>连带后果</b>，也是最容易被忽略的：<br>' +
          '函数 <code>f(char* a, size_t b, double c, Config* d)</code><br>' +
          '• <code>a</code> → x0　<code>b</code> → x1　<code>c</code> → <b>v0</b>　<code>d</code> → <b>x2</b>（不是 x3！）<br><br>' +
          '因为 <code>c</code> 走了 v 寄存器，<b>没有占用整数寄存器名额</b>，所以后面的 <code>d</code> 前移到了 x2。<br>' +
          '<b>于是 <code>args[2]</code> 拿到的是 <code>d</code>（一个指针，当成整数看就是"垃圾值"）。</b><br>' +
          '<b>判断方法：</b>注意到"args[2] 是垃圾"和"args[3] 也不对"同时出现——这是索引整体错位的信号。<br><br>' +
          '<b>原因三：参数是结构体（按值传递）</b><br><br>' +
          '如果参数是 <code>struct</code> 且按值传递，AArch64 会把它<b>拆分到多个寄存器</b>（如果够小），' +
          '或者<b>隐式转换成指针</b>（如果太大或含非平凡拷贝构造）。<br>' +
          '<b>判断方法：</b>看源码里参数是 <code>Config cfg</code> 还是 <code>Config* cfg</code>。' +
          '如果是前者，IDA 的反编译会显示得更清楚。<br><br>' +
          '<b>原因四：平台是 ARM32 且参数超过 4 个</b><br><br>' +
          'ARM32 只有 <code>r0</code>-<code>r3</code> 四个参数寄存器。第 5 个及以后的参数压栈。<br>' +
          '（不过 Frida 的 <code>args[]</code> 通常能正确处理栈上参数，所以这个原因较少见。）<br><br>' +
          '<span class="hit">排查口诀：先看类型（是不是浮点/结构体），再看索引（有没有错位）。</span>'
      },
      {
        id: 'c3q4', depth: 3, threshold: 0.7,
        q: '<b>综合题：</b>给你一个 only 有 so 的 C++ 加密库（无源码、无符号、被 strip 过）。' +
           '请描述你的<b>完整分析路线</b>——从拿到 so 开始，到能说清"加密函数在哪、怎么被调用、参数是什么"为止。',
        concepts: [
          { label: '先用 IDA 静态分析，找 JNI_OnLoad / 导出符号 / 字符串线索定位入口', hint: '第一步从哪里入手？', any: ['ida', '静态', 'jni_onload', '导出', '字符串', '入口', '符号'] },
          { label: '识别 C++ 特征：vtable（_ZTV）、RTTI（_ZTI/_ZTS）、构造函数（_ZN...C1/C2）', hint: '怎么确认这是 C++ 代码、并恢复类结构？', any: ['vtable', '虚表', 'rtti', 'ztv', 'zti', 'zts', '类', '构造', 'c++'] },
          { label: '用 Frida 动态 Hook，打印虚调用的 x9/x8 确定实际目标函数', hint: '静态断链（虚调用）怎么破？', any: ['frida', '动态', 'hook', 'x9', 'x8', 'blr', '实际', '打印'] },
          { label: '根据调用约定确定参数（x0-x7 整数 / v0-v7 浮点），注意结构体与 this 指针', hint: '怎么确认参数类型和个数？', any: ['x0', '调用约定', '参数', '寄存器', 'v0', 'this', '结构体'] },
          { label: '用输入输出对验证，或配合 Stalker / unidbg 做黑盒调用', hint: '怎么验证你的理解是对的？', any: ['输入输出', '验证', 'stalker', 'unidbg', '黑盒', '样本', '对比'] }
        ],
        hints: [
          '没有符号不代表没有线索——编译器留下了一些"约定俗成"的东西，比如虚表符号、构造函数的命名规律。',
          '静态分析会被虚调用打断，但动态执行时 x9 里就是答案。'
        ],
        probes: [
          '追问：如果这个库还用了 OLLVM 混淆，你的路线要怎么调整？哪一步会变得最困难？',
          '如果加密函数不是导出函数，也不在任何 vtable 里，你怎么找到它？'
        ],
        model: '<b>完整分析路线（六步）：</b><br><br>' +
          '<b>第一步：静态侦察，定位入口。</b><br>' +
          '用 IDA 加载 so，先看导出表——<code>JNI_OnLoad</code>、<code>Java_*</code> 开头的函数是天然入口。' +
          '再看字符串窗口，找错误信息、API 路径、算法名残留。' +
          '<b>这一步的目的不是理解算法，而是找到"从哪里开始读"。</b><br><br>' +
          '<b>第二步：确认这是 C++ 代码，恢复类结构。</b><br>' +
          '即使 strip 了，C++ 也会留下痕迹：<br>' +
          '• <b>虚表符号</b>：<code>_ZTV&lt;类名&gt;</code>（vtable for）<br>' +
          '• <b>RTTI 符号</b>：<code>_ZTI</code>（typeinfo）、<code>_ZTS</code>（typeinfo name，类型名字符串）——' +
          '<b>这个字符串通常不会被 strip 掉</b>，是恢复类名的金矿<br>' +
          '• <b>构造函数命名规律</b>：<code>_ZN...C1/C2</code><br>' +
          '• <b>虚函数调用模式</b>：<code>LDR → LDR → BLR</code> 三段式<br><br>' +
          '<b>第三步：用动态 Hook 破解虚调用的断链。</b><br>' +
          '静态分析在 <code>BLR x9</code> 处会断掉。解决办法是 hook 那个地址，打印 <code>this.context.x9</code>——' +
          '运行时 x9 里就是<b>真实的函数地址</b>。减去 so 基址得到偏移，在 IDA 里跳过去就是实现。<br>' +
          '<b>这一步是打通静态分析的关键。</b><br><br>' +
          '<b>第四步：确定参数与调用约定。</b><br>' +
          '• 整数/指针参数 → <code>x0</code>-<code>x7</code><br>' +
          '• 浮点参数 → <code>v0</code>-<code>v7</code>（<b>容易漏！</b>）<br>' +
          '• 成员函数第一个隐含参数是 <code>this</code>（占 x0）<br>' +
          '• 结构体按值传递会被拆分或转指针<br>' +
          '在 IDA 里可以通过"函数被调用的地方"反推参数个数与类型。' +
          '也可以用 Frida 打印全部寄存器，观察哪些有值、哪些是明显的指针。<br><br>' +
          '<b>第五步：识别算法本体。</b><br>' +
          '进去看实现——这时你已经能读懂汇编了（本章 17.2 节的套路）：<br>' +
          '• 找<b>位运算密集区</b>（<code>EOR</code>/<code>AND</code>/<code>ORR</code>/<code>ROR</code>）→ 加密轮函数<br>' +
          '• 找<b>常量表</b>（256 字节的置换表 = S 盒；4 个魔数 = MD5 IV）<br>' +
          '• 找<b>循环结构</b>（10 轮 = AES-128，64 轮 = MD5/SHA）<br>' +
          '• 找<b>数组索引模式</b>（<code>[基址, 索引, LSL #N]</code>）= 查表操作<br><br>' +
          '<b>第六步：验证理解。</b><br>' +
          '• 用 Frida 采集"输入 → 输出"样本对<br>' +
          '• 如果识别出是标准算法的变种，用 Python 实现一遍对比结果<br>' +
          '• 如果完全自定义，用 unidbg 做黑盒调用，验证你的调用方式正确<br><br>' +
          '<b>如果还有 OLLVM 混淆：</b><br>' +
          '第二步和第五步会变难（类结构被打散、控制流被平坦化），但<b>第三、四、六步不受影响</b>——' +
          '因为混淆保护的是代码的静态形式，改变不了运行时行为。' +
          '<span class="hit">动态手段永远有效，这是本课反复强调的核心方法论。</span>'
      },
      {
        id: 'c3q5', depth: 1, threshold: 0.7,
        q: '在汇编里，如何一眼认出<b>循环</b>和<b>数组访问</b>？请分别说出它们的指令模式。',
        concepts: [
          { label: '循环：条件比较 + 条件跳转退出 + 循环体 + 无条件跳回', hint: '循环的指令结构长什么样？', any: ['比较', 'cmp', '条件跳转', '跳回', '跳出去', '无条件', 'b .', '循环头', '退出'] },
          { label: '数组访问：[基址, 索引, 移位] 形式，移位量 = log2(元素大小)', hint: '数组寻址在指令里怎么表示？', any: ['基址', '索引', '移位', 'lsl', 'sxtw', '偏移', 'log2', '乘'] },
          { label: '通过移位量可以推断元素大小（#2 = int，#3 = long/指针）', hint: '从移位量能看出什么？', any: ['元素大小', '推断', '类型', '4 字节', '8 字节', '#2', '#3', 'int', 'long'] }
        ],
        hints: [
          '循环必然有"往回跳"的指令。找到它，循环范围就清楚了。',
          '数组访问要算地址：基址 + 索引 × 元素大小。编译器怎么表示"乘以 4"？'
        ],
        probes: [
          '追问：如果编译器把循环优化成"倒计数递减到 0"，你还能认出它是循环吗？',
          '如果数组元素是结构体（比如 24 字节），移位量还能用吗？编译器会怎么做？'
        ],
        model: '<b>一、循环的指令模式</b><br><br>' +
          '标准形态是四段式：<br>' +
          T.code('<span class="c">; 循环头：比较 + 条件退出</span>\n' +
            '<span class="m">.loop:</span>\n' +
            '  <span class="k">CMP</span>  <span class="r">w3</span>, <span class="r">w1</span>          <span class="c">; 比较 i 和 n</span>\n' +
            '  <span class="k">B.GE</span> <span class="m">.exit</span>            <span class="c">; i &gt;= n 就跳出</span>\n' +
            '\n' +
            '<span class="c">; 循环体</span>\n' +
            '  ...\n' +
            '\n' +
            '<span class="c">; 自增 + 跳回</span>\n' +
            '  <span class="k">ADD</span>  <span class="r">w3</span>, <span class="r">w3</span>, <span class="n">#1</span>       <span class="c">; i++</span>\n' +
            '  <span class="k">B</span>    <span class="m">.loop</span>            <span class="c">; 无条件跳回</span>\n' +
            '<span class="m">.exit:</span>') +
          '<b>识别要点：</b>找<b>往回跳</b>的指令（目标地址小于当前地址）。这一定是循环。' +
          '然后从跳转目标往上找条件判断，就确定了循环的边界与条件。<br><br>' +
          '<b>常见优化变体：</b><br>' +
          '• <b>倒计数</b>：<code>SUBS w3, w3, #1</code> + <code>B.NE .loop</code> —— 省掉一次比较指令<br>' +
          '• <b>指针递增</b>：不维护索引，直接 <code>ADD x0, x0, #4</code> 移动指针，末尾比较指针是否越界<br>' +
          '• <b>循环展开</b>（unrolling）：把循环体复制几份，减少循环次数<br>' +
          '看到这些变形不要困惑，<b>核心特征仍是"往回跳"</b>。<br><br>' +
          '<b>二、数组访问的指令模式</b><br><br>' +
          'AArch64 的标准形式是 <code>[基址, 索引, 移位]</code>：<br>' +
          T.code('<span class="k">LDR</span> <span class="r">w4</span>, [<span class="r">x0</span>, <span class="r">w3</span>, <span class="k">SXTW</span> <span class="n">#2</span>]   <span class="c">; w4 = arr[i]，int 数组</span>') +
          '拆解：<code>x0</code> 是基址，<code>w3</code> 是索引，<code>SXTW</code> 把 32 位索引符号扩展成 64 位，' +
          '<code>#2</code> 表示左移 2 位（×4）。<br><br>' +
          '<b>移位量 = log2(元素大小)：</b><br>' +
          '• <code>#0</code> → ×1 → <code>char</code> / <code>uint8_t</code><br>' +
          '• <code>#1</code> → ×2 → <code>short</code> / <code>uint16_t</code><br>' +
          '• <code>#2</code> → ×4 → <b><code>int</code> / <code>uint32_t</code> / <code>float</code></b><br>' +
          '• <code>#3</code> → ×8 → <code>long</code> / 指针 / <code>double</code><br><br>' +
          '<span class="hit">这个推断非常有用：看一条加载指令就能知道数组元素是什么类型。</span><br><br>' +
          '<b>如果元素大小不是 2 的幂</b>（比如结构体 24 字节）：<br>' +
          '编译器不能用移位，会改成<b>乘法</b>：<code>MADD x9, x3, x10, x0</code>（x9 = x3 * x10 + x0），' +
          '其中 x10 里预存了 24。<br>' +
          '看到 <code>MADD</code>/<code>MUL</code> 参与地址计算，就说明元素大小不是 2 的幂——<b>那多半是结构体数组</b>。'
      }
    ]
  }
};
