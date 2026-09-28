window.CHAPTER = {
  no: 27,
  title: '内核模块绕过 Frida 检测',
  lede: '当 App 不再调用 libc，而是自己内联一条 <code>SVC</code> 直接陷入内核，所有挂在 libc 导出函数上的 Hook 都会瞬间失明。本章讲清楚这条指令的完整路径、三种追踪技巧的横评与选择模型，以及内存动态释放、JNI 地址防追踪与硬件断点反制。',
  meta: [
    '核心问题：<b>App 如何用 SVC 绕过基于函数 Hook 的监控，你又该把观测点放到哪一层</b>',
    '关键工具：<b>Frida 的 Memory.scan / 观察点、内核 syscall 表 Hook、0r0env 调试 ROM</b>',
    '对手：<b>内联系统调用、内存动态释放代码、JNI 地址延迟与分次注册</b>'
  ],

  sections: [
     /* ================= 27.1 ================= */
     {
       h: '27.1',
       title: 'Hook 了 open，为什么一次都没触发',
       html:
         '<p>先把本章要解决的问题原样摆到桌面上。</p>' +
         '<p>你写了一个 Frida 脚本，把 <code>open</code>、<code>openat</code>、<code>read</code> 通通 <code>Interceptor.attach</code> 上，然后运行目标 App。' +
         '日志里明明白白地看到它读到了 <code>/proc/self/maps</code>——可你的 hook <b>一次都没有触发</b>。</p>' +
         '<p>这不是脚本写错了，也不是 frida-server 被反调试干掉了。<b>这是观测层选错了。</b></p>' +
         T.grid(2, [
           '<div class="card"><div class="card-title">你以为的调用链</div>' +
           '<p class="mono small">App → libc.open() → svc → 内核</p>' +
           '<p>Frida 的 <code>Interceptor.attach</code> 挂在 <b>libc 导出函数的入口</b>上，所以这条链上的每一步你都看得见。' +
           '这也是绝大多数教程默认的世界模型。</p></div>',

           '<div class="card"><div class="card-title">实际的调用链</div>' +
           '<p class="mono small">App → svc → 内核</p>' +
           '<p>App 把' + T.term('内联系统调用', '不经过 libc 封装函数，直接在代码里写下 SVC 指令并自行设置系统调用号与参数寄存器的做法') +
           '直接写进了自己的代码。libc 的那一层被整个跳过了，你的 hook 自然什么都看不到。</p></div>'
         ]) +
         '<p>要理解这件事，得先接受一个事实：<b>libc 不是系统调用的入口，它只是一个"帮你把寄存器摆好"的封装层</b>。' +
         '真正把事情办成的是那条 <code>svc</code> 指令。谁写这条指令，谁就是在发起系统调用——封装层可以被任意替换或省略。</p>',

       intuition: {
         tag: '直觉模型 · 正门摄像头与员工通道',
         body:
           '<p>你在一栋大楼的<b>正门</b>装了一台摄像头（Hook libc 的 <code>open</code>），记录每个进出的人。' +
           '你以为这就是全部的人流。</p>' +
           '<p>但目标人物压根不走正门——他有员工通道的钥匙（自己能写 <code>svc</code> 指令），从通道直接进楼。' +
           '摄像头一次都没拍到他，你却在反复检查摄像头是不是坏了。</p>' +
           '<p><b>本章的第一个认知跃迁就是：不要修摄像头，去找通往大楼的其他入口。</b>' +
           '而"其他的入口"只有一条最终通道——<b>内核的系统调用分发表</b>。所有进楼的人，最后都得经过前台登记。</p>'
       },

       after:
         T.note('key', '🔑 本章主线',
           '<p><b>观测点必须高于对手的绕过点。</b>对手在用户态玩花活（内联 SVC、动态生成代码、延迟注册），' +
           '你如果还待在用户态的同一个层级较劲，永远慢一步。</p>' +
           '<p>本章的路线是：先看清楚 <code>SVC</code> 这条指令到底做了什么（27.2、27.3），' +
           '再把三种可行观测点摆在一起横评、建立选择模型（27.4、27.5），' +
           '最后逐个拆解三个具体对手：<b>内存动态释放代码</b>（27.7）、<b>JNI 地址防追踪</b>（27.9），' +
           '以及用来反制它们的<b>硬件断点</b>（27.11）。</p>')
     },

     /* ================= 27.2 ================= */
     {
       h: '27.2',
       title: '一条 SVC 指令的完整旅程：两条路径并排看',
       html:
         '<p><code>SVC</code> 是 <b>Supervisor Call</b>（管理程序调用）的缩写，在 ARM32 上旧称 <code>SWI</code>（Software Interrupt，软中断）。' +
         '它的作用只有一个：<b>主动触发一次同步异常，把 CPU 从用户态请进内核态。</b></p>' +
         '<p>完整过程是：用户态（<b>EL0</b>）执行 <code>SVC #0</code> → CPU 触发<b>同步异常</b> → 陷入内核态（<b>EL1</b>）→ ' +
         '内核的<b>异常向量表</b>接管 → 根据<b>系统调用号</b>在 syscall 分发表里找到对应处理函数 → 执行完毕，返回 EL0。</p>' +
         '<p>下面这张图把两条路径并排画出来。请特别留意：<b>两条路径在 <code>svc</code> 之后完全汇合</b>——' +
         '它们进的是同一个内核、查的是同一张分发表。差别只在于<b>前半段有没有经过 libc</b>，而你的 hook 恰恰只能挂在那一小段上。</p>',

       stage: {
         title: 'SVC 陷入过程 · 路径 A（走 libc） vs 路径 B（直接内联 SVC）',
         speed: 1800,
         render:
           '<div class="flow-row" style="align-items:stretch;gap:14px">' +
             '<div class="card" style="flex:1">' +
               '<div class="card-title">路径 A · 走 libc（常规写法）</div>' +
               '<div class="flow-col">' +
                 '<div class="blk" id="pa1">App：open(&quot;/proc/self/maps&quot;)</div>' +
                 '<div class="blk" id="pa2">libc 的 open 封装函数</div>' +
                 '<div class="blk" id="pa3">EL0：执行 svc #0</div>' +
                 '<div class="blk" id="pa4">同步异常 → EL1 · 异常向量表接管</div>' +
                 '<div class="blk" id="pa5">按系统调用号查 syscall 表 · 分发</div>' +
                 '<div class="blk" id="pa6">返回 EL0 · 一路上抛返回值</div>' +
               '</div>' +
               '<div id="paTag" class="pill acc">观测点：Interceptor.attach 挂在这一层</div>' +
             '</div>' +
             '<div class="card" style="flex:1">' +
               '<div class="card-title">路径 B · 直接内联 SVC（绕过写法）</div>' +
               '<div class="flow-col">' +
                 '<div class="blk" id="pb1">App 自己设 r7 / x8 与参数</div>' +
                 '<div class="blk" id="pb2">EL0：执行 svc #0</div>' +
                 '<div class="blk" id="pb3">同一个 EL1 · 同一张 syscall 表</div>' +
                 '<div class="blk" id="pb4">返回 EL0 · 直接拿返回值</div>' +
               '</div>' +
               '<div id="pbTag" class="pill acc">libc 层完全看不到</div>' +
             '</div>' +
           '</div>' +
           '<div class="flow-row" style="margin-top:14px">' +
             '<span class="blk" id="px1">介入点① 内核 syscall 表</span>' +
             '<span class="blk" id="px2">介入点② 静态扫描 SVC 字节</span>' +
             '<span class="blk" id="px3">介入点③ SVC 处硬件断点</span>' +
           '</div>' +
           '<div id="pnote" class="note key" style="margin-top:12px"><p>点「播放」，跟着一条 SVC 走完全程。</p></div>',

         reset: () => {
           ['pa1','pa2','pa3','pa4','pa5','pa6','pb1','pb2','pb3','pb4','px1','px2','px3'].forEach(function (i) { S(i, ''); });
           CLS('paTag', 'pill acc');
           CLS('pbTag', 'pill acc');
           SET('pnote', '<p>点「播放」，跟着一条 SVC 走完全程。</p>');
         },

         steps: [
           { run: () => S('pa1', 'active'),
             note: '<b>路径 A 起点。</b>App 里写的是一句普通的 C 调用 <code>open(path, O_RDONLY)</code>。' +
                   '编译器把它变成一次对 libc 导出符号 <code>open</code> 的调用（ARM64 上通常是 <code>openat</code>）。' +
                   '此刻还完全在 EL0 用户态，没有任何内核参与。' },

           { run: () => { S('pa1', 'done'); S('pa2', 'active'); },
             note: '<b>进入 libc 封装。</b>libc 的 <code>open</code> 并不做实际工作，它只负责把参数搬到正确的寄存器、' +
                   '把系统调用号写进 r7（ARM32）或 x8（AArch64），然后准备执行 <code>svc</code>。' +
                   '<span class="hit">这一层是 Frida 所有 libc hook 的栖身之所。</span>' },

           { run: () => { S('pa2', 'done'); S('pa3', 'active'); },
             note: '<b>EL0 执行 <code>SVC #0</code>。</b>这条指令本身不做任何逻辑判断，它做的是"举手"：' +
                   '向 CPU 表明「我要请求管理程序（内核）的服务」。CPU 随即产生一次<b>同步异常</b>，' +
                   '把当前执行流打断，切换到更高的异常级别。' },

           { run: () => { S('pa3', 'done'); S('pa4', 'active'); },
             note: '<b>陷入 EL1，异常向量表接管。</b>CPU 自动保存返回地址与状态，跳到内核的异常向量入口。' +
                   '从这一刻起，代码已经在<b>内核态</b>运行——用户态的任何 hook 框架都不再拥有执行权。' },

           { run: () => { S('pa4', 'done'); S('pa5', 'active'); },
             note: '<b>按系统调用号分发。</b>内核读取 r7 / x8 里的<b>系统调用号</b>，用它作为下标去查 syscall 分发表，' +
                   '找到对应的处理函数并调用。<span class="hit">这张表就是本章所有"最彻底方案"的落点。</span>' },

           { run: () => { S('pa5', 'done'); S('pa6', 'active'); },
             note: '<b>返回 EL0。</b>处理结果写回 r0 / x0。若走的是路径 A，这个返回值还要沿着 libc 再上抛一层，' +
                   '顺便把内核的负错误码翻译成 <code>-1</code> 并设置 <code>errno</code>。' },

           { run: () => { CLS('paTag', 'pill ok'); S('pa6', 'done'); S('pb1', 'active'); },
             note: '<b>切换到路径 B。</b>路径 A 全程走完。现在看绕过写法：App <b>不调用任何 libc 函数</b>，' +
                   '它自己把系统调用号和参数塞进寄存器，然后内联写下那条 <code>svc</code> 指令。' +
                   '<span class="bad">路径 A 的观测点（pa2）从头到尾没有被触碰过。</span>' },

           { run: () => { S('pb1', 'done'); S('pb2', 'active'); },
             note: '<b>同样的 EL0，同样的 svc。</b>对 CPU 而言，路径 A 和路径 B 在这里发出的指令<b>完全一样</b>——' +
                   '区别只是谁写的。CPU 不关心这条指令来自 libc 还是来自 App 自己，它只认指令本身。' },

           { run: () => { S('pb2', 'done'); S('pb3', 'active'); },
             note: '<b>两条路径在内核汇合。</b>同样的异常向量、同样的 syscall 分发表、同样的处理函数。' +
                   '<span class="hit">这是本章最重要的一个结构性事实：绕过只发生在用户态，内核侧无法被跳过。</span>' },

           { run: () => { CLS('pbTag', 'pill bad'); S('pb3', 'done'); S('pb4', 'active');
                          SET('pnote', '<p><b>结论：</b>基于 <code>Interceptor.attach(Module.getExportByName(&quot;libc.so&quot;, &quot;open&quot;))</code> 的监控，' +
                                       '对路径 B <b>100% 失效</b>。这不是 Frida 的 bug，是观测层被架空了。</p>'); },
             note: '<b>路径 B 直接拿到返回值。</b>它连 errno 都省了，自己判断 r0 / x0 的负值。' +
                   '<span class="bad">你的 libc hook 全程零命中，日志里干干净净。</span>' },

           { run: () => S('px1', 'active'),
             note: '<b>介入点① · 内核 syscall 表。</b>改内核里的系统调用分发表。' +
                   '不管发起者是 libc 还是 App 自己，<b>最终都要经过这张表</b>——所以它无法被用户态绕过。' +
                   '代价是需要内核层能力（编译内核模块 / 定制内核 / 刷机）。' },

           { run: () => { S('px1', 'done'); S('px2', 'active'); },
             note: '<b>介入点② · 静态扫描 SVC 字节。</b>ARM32 的 <code>SVC #0</code> 指令编码是 <code>0xEF000000</code>，' +
                   'AArch64 是 <code>0xD4000001</code>。用 Frida 的 <code>Memory.scan</code> 在 so 的代码段里搜这两个特征值，' +
                   '命中处就是潜在的 SVC 调用点。<span class="miss">缺点：动态生成的代码扫不到。</span>' },

           { run: () => { S('px2', 'done'); S('px3', 'active');
                          SET('pnote', '<p><b>三个介入点分别在</b>：内核分发表（最彻底、门槛最高）、代码段静态扫描（最简单、最易被绕过）、' +
                                       'SVC 指令地址硬件断点（最精确、数量有限）。27.4 节会把它们摆在一起横评。</p>'); },
             note: '<b>介入点③ · SVC 地址硬件断点。</b>在扫描或已知的 SVC 指令地址上设置<b>硬件断点</b>。' +
                   '硬件断点由 CPU 调试寄存器实现，<b>不修改目标内存</b>，因此校验代码段和检查首字节的反调试全都抓不到它。' +
                   '<span class="miss">代价：ARM 上通常只有 4-6 个，不能大规模布点。</span>' }
         ]
       },

       after:
         T.note('ok', '✅ 记住这张图的三段结构',
           '<p>把任何一次系统调用都拆成三段：<b>① 用户态准备</b>（谁设的寄存器？libc 还是 App 自己）→ ' +
           '<b>② svc 陷入</b>（两条路径在此合流，永远相同）→ <b>③ 内核分发与执行</b>（永远发生在 EL1）。</p>' +
           '<p>你的观测点只能放在 ① 或 ③。<b>放在 ① 就一定可以被绕过</b>——对手只要不调用你 hook 的那个函数就行了；' +
           '<b>放在 ③ 才具备不可绕过性</b>，代价是门槛。<span class="pill warn">内核模块的具体实现细节待核实，以 0r0env 作者发布为准</span></p>')
     },

     /* ================= 27.3 ================= */
     {
       h: '27.3',
       title: '两种架构下，内联 SVC 到底怎么写',
       html:
         '<p>光看图还不够。要建立真正的直觉，你必须能<b>自己写出这段代码</b>——因为你在逆向时看到的，' +
         '就是这段代码编译后的样子。</p>' +
         '<p>按下表的寄存器约定，把"调用 <code>open</code>"这件事拆成四步：<b>设参数 → 设系统调用号 → 执行 svc → 读返回值</b>。' +
         'ARM32 和 AArch64 的区别，几乎全部集中在<b>系统调用号放在哪个寄存器</b>上。</p>' +
         '<div class="tbl-wrap"><table class="tbl">' +
           '<thead><tr><th></th><th>ARM32 (EABI)</th><th>AArch64</th></tr></thead>' +
           '<tbody>' +
             '<tr><td><b>系统调用号</b></td><td class="mono">r7</td><td class="mono">x8</td></tr>' +
             '<tr><td><b>参数</b></td><td class="mono">r0 - r6</td><td class="mono">x0 - x5</td></tr>' +
             '<tr><td><b>返回值</b></td><td class="mono">r0</td><td class="mono">x0</td></tr>' +
             '<tr><td><b>陷入指令</b></td><td class="mono">SVC #0</td><td class="mono">SVC #0</td></tr>' +
             '<tr><td><b>指令编码</b></td><td class="mono">0xEF000000</td><td class="mono">0xD4000001</td></tr>' +
           '</tbody>' +
         '</table></div>' +
         '<p class="small muted">注意最后一行的两个常量：它们是你后面做<b>静态扫描</b>时的特征字节。' +
         '小端存储时字节序要反过来算，这一点在写扫描器时最容易翻车。</p>' +
         '<p>下面这个步进器把同一件事（打开一个文件）在两种架构下各走一遍。<b>右边盯着寄存器看。</b></p>',

       stepper: {
         title: '同一个 open，两种架构的内联 SVC 写法对比',
         lines: [
           { code: '<span class="c">/* ---------- ARM32 (EABI) ---------- */</span>\n' +
                   '<span class="k">ldr</span> <span class="r">r0</span>, =path      <span class="c">@ 第 1 个参数：文件路径指针</span>',
             note: '<b>ARM32 第 1 步：设参数。</b>ARM32 的参数寄存器从 <code>r0</code> 开始向上排。' +
                   '第一个参数（路径字符串地址）放进 <code>r0</code>。<br>' +
                   '<span class="small muted">对照点：AArch64 这里也是 x0，前几个参数的约定是一致的——区别从"系统调用号"才开始。</span>',
             state: { 'r0': 'path 地址', 'r1': '未设置', 'r2': '未设置', 'r7': '未设置' },
             mem: '0x00401000  "/proc/self/maps\\0"\n         ^\n         r0 指向这里' },

           { code: '<span class="k">mov</span> <span class="r">r1</span>, <span class="n">#0</span>        <span class="c">@ 第 2 个参数：flags = O_RDONLY</span>\n' +
                   '<span class="k">mov</span> <span class="r">r2</span>, <span class="n">#0</span>        <span class="c">@ 第 3 个参数：mode = 0（open 不用，占位）</span>',
             note: '<b>继续摆参数。</b><code>flags</code> 进 <code>r1</code>，<code>mode</code> 进 <code>r2</code>。' +
                   '<code>mode</code> 只在带 <code>O_CREAT</code> 时才有意义，这里占位补零。<br>' +
                   '<b>坑：</b>参数个数超过寄存器数量时，多余的参数通过栈传递——但系统调用本身最多只认 7 个（ARM32）/ 6 个（AArch64），' +
                   '所以内联 SVC 时你几乎总能全部塞进寄存器。',
             state: { 'r0': 'path 地址', 'r1': '0 (O_RDONLY)', 'r2': '0', 'r7': '未设置' } },

           { code: '<span class="k">mov</span> <span class="r">r7</span>, <span class="n">#5</span>        <span class="c">@ 系统调用号：__NR_open（ARM32 EABI）</span>',
             note: '<b>关键一步：系统调用号进 r7。</b>这是 ARM32 独有的约定——AArch64 用的是 <code>x8</code>。' +
                   '很多人在跨架构移植内联 SVC 时，就是忘了改这一个寄存器，结果内核按错误的号去分发，直接 <code>-ENOSYS</code>。<br>' +
                   '<span class="pill warn">具体号值随 ABI 与内核版本变化，实战中请以目标环境头文件为准</span>',
             state: { 'r0': 'path 地址', 'r1': '0 (O_RDONLY)', 'r2': '0', 'r7': '5 (__NR_open)' } },

           { code: '<span class="k">svc</span> <span class="n">#0</span>            <span class="c">@ 陷入内核 —— 编码 0xEF000000</span>',
             note: '<b>转折点。</b>执行 <code>SVC #0</code>，CPU 触发同步异常，从 EL0 陷入 EL1。' +
                   '在此之前的一切都是"用户态准备"；从此之后的一切发生在内核里。<br>' +
                   '<span class="hit">对 Frida 而言，这一瞬间没有任何 libc 函数被调用过。</span>' +
                   '如果你 hook 的是 libc 的 <code>open</code>，你的回调永远不会执行。',
             state: { 'r0': 'path 地址', 'r1': '0 (O_RDONLY)', 'r2': '0', 'r7': '5 (__NR_open)' },
             mem: 'EL0 ──svc──> EL1\n  异常向量表\n  syscall[5] → sys_open' },

           { code: '<span class="c">@ 内核处理完毕，返回 EL0</span>\n' +
                   '<span class="c">@ 结果已经在 r0 里了</span>',
             note: '<b>读返回值：r0。</b>成功时是文件描述符（一个小整数，如 <code>3</code>）；' +
                   '失败时是<b>负的错误码</b>（如 <code>-2</code> 表示 ENOENT）。<br>' +
                   '<b>注意：</b>内联 SVC 拿到的是内核原始错误码，<b>没有 errno 这个中间层</b>——' +
                   'libc 的封装函数才负责把负值翻译成 <code>-1</code> 并写 <code>errno</code>。这也是识别"某段代码是不是内联 SVC"的一个线索：' +
                   '它自己判断负数，而不是去读 errno。',
             state: { 'r0': '3 (fd) 或 负错误码', 'r1': '0 (O_RDONLY)', 'r2': '0', 'r7': '5 (__NR_open)' } },

           { code: '<span class="c">/* ---------- AArch64 ---------- */</span>\n' +
                   '<span class="k">adrp</span> <span class="r">x0</span>, path\n' +
                   '<span class="k">add</span>  <span class="r">x0</span>, <span class="r">x0</span>, :lo12:path  <span class="c">// 第 1 个参数</span>',
             note: '<b>换架构，重来一遍。</b>AArch64 取地址需要 <code>adrp</code> + <code>add</code> 两条指令配合（页基址 + 页内偏移），' +
                   '因为单条指令装不下 64 位地址。<br>' +
                   '参数寄存器从 <code>x0</code> 开始——这一点和 ARM32 一样，所以前几步你会觉得"没差别"。' +
                   '<b>差别马上就来。</b>',
             state: { 'x0': 'path 地址', 'x1': '未设置', 'x8': '未设置' } },

           { code: '<span class="k">mov</span> <span class="r">x1</span>, <span class="n">#0</span>          <span class="c">// flags = O_RDONLY</span>\n' +
                   '<span class="k">mov</span> <span class="r">x2</span>, <span class="n">#0</span>          <span class="c">// mode = 0</span>',
             note: '<b>参数就位。</b>AArch64 的参数寄存器是 <code>x0</code>-<code>x5</code>，比 ARM32 少一个（ARM32 有 r0-r6）。' +
                   '对系统调用这种参数不多的场景，这点差异基本无感。',
             state: { 'x0': 'path 地址', 'x1': '0 (O_RDONLY)', 'x2': '0', 'x8': '未设置' } },

           { code: '<span class="k">mov</span> <span class="r">x8</span>, <span class="n">#56</span>         <span class="c">// 系统调用号：__NR_openat（AArch64）</span>',
             note: '<b>这里是最大的差异：系统调用号进 x8，不是 r7。</b><br>' +
                   '还有第二个差异：<b>AArch64 上没有独立的 <code>open</code> 系统调用</b>，只有 <code>openat</code>。' +
                   '所以你内联 SVC 时要按 <code>openat(dirfd, path, flags, mode)</code> 摆参数——' +
                   '<code>x0</code> 是目录 fd（用 <code>AT_FDCWD</code> 表示"相对当前工作目录"），路径挪到 <code>x1</code>，flags 挪到 <code>x2</code>。' +
                   '<span class="miss">这一步是跨架构逆向里最常被忽略的陷阱：不只是换个寄存器，调用签名也变了。</span><br>' +
                   '<span class="pill warn">号值（此处 56）请以目标内核头文件为准，不同版本可能不同</span>',
             state: { 'x0': 'AT_FDCWD (-100)', 'x1': 'path 地址', 'x2': '0 (O_RDONLY)', 'x3': '0 (mode)', 'x8': '56 (__NR_openat)' } },

           { code: '<span class="k">svc</span> <span class="n">#0</span>            <span class="c">// 陷入内核 —— 编码 0xD4000001</span>',
             note: '<b>同一条指令，不同的编码。</b>AArch64 的 <code>SVC #0</code> 编码是 <code>0xD4000001</code>，' +
                   '和 ARM32 的 <code>0xEF000000</code> 完全不同。<br>' +
                   '<span class="hit">这意味着写静态扫描器时，你必须同时搜两种特征值</span>——' +
                   '一个 App 里可能同时存在 32 位和 64 位的 so（比如为了兼容旧设备），漏掉任何一种都会漏掉一半的 SVC 调用点。',
             state: { 'x0': 'AT_FDCWD (-100)', 'x1': 'path 地址', 'x2': '0 (O_RDONLY)', 'x8': '56 (__NR_openat)' },
             mem: 'EL0 ──svc #0──> EL1\n  0xD4000001' },

           { code: '<span class="c">// 返回 EL0，结果在 x0</span>',
             note: '<b>读返回值：x0。</b>和 ARM32 一样，成功是 fd，失败是负错误码。',
             state: { 'x0': '3 (fd) 或 负错误码', 'x8': '56 (__NR_openat)' } },

           { code: '<span class="c">// 逆向视角：这段代码在反汇编里长什么样？</span>\n' +
                   '<span class="c">// 你会看到"设 x8 → svc"这个固定节奏，紧挨在一起</span>',
             note: '<b>把两台机器的知识合并成一条识别规则。</b>当你在 IDA / Ghidra 里看到' +
                   '「某个寄存器被赋一个小的立即数，紧接着一条 <code>SVC</code>」，那基本就是一个内联系统调用点。<br>' +
                   'ARM32 找 <code>r7</code>，AArch64 找 <code>x8</code>。<span class="hit">这条规则就是 27.5 节实战定位的起点。</span>',
             state: { 'r7': 'ARM32 的号寄存器', 'x8': 'AArch64 的号寄存器' } }
         ]
       },

       after:
         T.note('key', '🔑 一句话记住两台机器的差别',
           '<p><b>参数都是从第 0 号寄存器往上排；系统调用号一个放 r7、一个放 x8；返回值都在第 0 号寄存器。</b></p>' +
           '<p>再补一条容易忘的：<b>AArch64 没有 <code>open</code>，只有 <code>openat</code></b>。' +
           '所以同样一句 &quot;打开 /proc/self/maps&quot;，两种架构下的内联 SVC 不只是寄存器不同，<b>参数顺序都不同</b>。</p>') +
         T.note('warn', '⚠️ 不要背号值，要会查',
           '<p>系统调用号是<b>内核 ABI 的一部分</b>，会随架构、ABI（EABI / OABI）和内核版本变化。' +
           '上面出现的号值只是常见参考，实战中应以目标环境的头文件（<code>asm/unistd.h</code> 或 <code>asm-generic/unistd.h</code>）为准。</p>' +
           '<p><b>而指令编码是稳定的</b>——<code>0xEF000000</code> 和 <code>0xD4000001</code> 由 ARM 架构规范定义，' +
           '这才是你可以放心硬编码进扫描器的常量。</p>')
     },

     /* ================= 27.3L 动手实验 ================= */
     {
       h: '27.3L', title: '动手实验：从一段内联汇编反推它在干什么',
       html:
         '<p>这一章的核心技能是：<b>看到一段裸 SVC，能立刻说出它在调什么、参数是什么。</b>' +
         '下面这个实验让你自己解一遍。</p>',
       lab: {
         title: '实验：解码内联 SVC',
         goal: '目标：读出系统调用名与参数',
         intro:
           '<p>你在 so 里发现下面这段汇编。目标是搞清楚它在干什么：</p>' +
           '<pre style="margin:10px 0;font-size:13px"><code>' +
           'MOV  X0, #0xFFFFFF9C      ; -100\n' +
           'ADR  X1, [PC, #0x120]     ; 指向字符串 "/proc/self/maps"\n' +
           'MOV  W2, #0x0             ; O_RDONLY\n' +
           'MOV  X8, #0x38            ; 系统调用号\n' +
           'SVC  #0</code></pre>' +
           '<p><b>任务：① 这是哪个架构？② 系统调用号 0x38 是什么调用？③ 它在访问什么文件？</b></p>',
         inputs: [
           { key: 'arch', label: '① 架构（填 arm32 或 a64）', hint: '看号寄存器是 X8 还是 R7', ph: 'a64' },
           { key: 'name', label: '② 系统调用 0x38 的名字', hint: '查表或推导', ph: 'open 或 openat' },
           { key: 'reason', label: '③ 这段代码在做什么？为什么值得警惕？', hint: '它读的是什么文件？', ph: '它在……', type: 'textarea', rows: 2 }
         ],
         runLabel: '🔍 校验我的解码',
         run: (v) => {
           const L = window.LABX;
           const arch = /a64|arm64|64/i.test(String(v.arch || '')) ? 'a64'
                      : /arm32|arm|32/i.test(String(v.arch || '')) ? 'arm32' : null;
           if (!arch) return '<div class="lab-msg warn">架构请填 <code>a64</code> 或 <code>arm32</code>。</div>';

           const nr = 0x38;   // 56
           const dec = L.decodeSyscall(arch, nr);
           const decArm = L.decodeSyscall('arm32', nr);

           let html = '<table class="lab-tbl"><tr><th>架构</th><th>号寄存器</th><th>nr=0x38 (56)</th><th>结论</th></tr>';
           html += '<tr class="' + (arch === 'a64' ? 'same' : '') + '"><td>AArch64</td><td><code>x8</code></td>'
             + '<td><b>' + dec.name + '</b></td><td>' + (dec.known ? '是标准调用' : '未收录') + '</td></tr>';
           html += '<tr><td>ARM32</td><td><code>r7</code></td>'
             + '<td>' + decArm.name + '</td><td>（同样号值在 ARM32 下含义不同）</td></tr></table>';

           const okArch = arch === 'a64';
           html += '<div class="lab-msg ' + (okArch ? 'pass' : 'fail') + '"><b>'
             + (okArch ? '✅ 架构判断正确：AArch64' : '❌ 架构判断错了') + '</b>'
             + '<div class="lab-note">' + (okArch
                 ? '依据很明确：<b>系统调用号放在 <code>X8</code></b>，参数用 <code>X0/X1/W2</code>。' +
                   'ARM32 会用 <code>R7</code> 放号、<code>R0-R6</code> 放参数。'
                 : '<b>正确答案是 AArch64。</b>判断依据：号放在 <code>X8</code>（ARM32 是 <code>R7</code>），' +
                   '参数用 <code>X0/X1/W2</code>（ARM32 是 <code>R0-R6</code>），寄存器是 64 位 <code>X</code> 而非 <code>R</code>。')
             + '</div></div>';

           const userAns = String(v.name || '').trim().toLowerCase().replace(/[^a-z]/g, '');
           if (userAns) {
             const okName = userAns === 'openat';
             html += '<div class="lab-msg ' + (okName ? 'pass' : 'fail') + '"><b>'
               + (okName ? '✅ 调用名正确：openat' : '❌ 调用名不对') + '</b>'
               + '<div class="lab-note">' + (okName
                   ? '<code>0x38</code> = <b>56</b> = <code>openat</code>（AArch64）。'
                   : 'AArch64 下 <code>0x38</code> = <b>56</b> = <code>openat</code>。' +
                     '<br><b>注意陷阱：</b>如果你填了 <code>open</code>，那说明你在用"直觉"而不是查表——' +
                     '<b>AArch64 根本没有 <code>open</code> 这个系统调用</b>，只有 <code>openat</code>。' +
                     '这正是本节想让你记住的点。')
               + '</div></div>';
           }

           // 参数解读
           html += '<div class="lab-msg key"><b>🔑 参数解读</b>'
             + '<div class="lab-note">'
             + '<code>X0 = 0xFFFFFF9C</code> → 有符号解读是 <b>-100</b>，即 <code>AT_FDCWD</code>（相对当前工作目录）<br>'
             + '<code>X1</code> → 指向字符串 <code>"/proc/self/maps"</code><br>'
             + '<code>W2 = 0</code> → <code>O_RDONLY</code>（只读打开）<br>'
             + '<code>X8 = 0x38</code> → 系统调用号 56 = <code>openat</code><br><br>'
             + '<b>所以它在做的事是：</b>以只读方式打开 <code>/proc/self/maps</code>。'
             + '<span class="hit">这是最典型的反调试 / 反 Frida 行为</span>——'
             + '读自己的内存映射表，检查里面有没有 <code>frida-agent</code>、<code>gum-js-loop</code> 之类的映射项。'
             + '<br><br><b>为什么值得警惕：</b>它是<b>直接内联 SVC</b>，没有经过 libc。'
             + '所以你在 Frida 里 hook <code>open</code> / <code>fopen</code> <b>完全看不到这次调用</b>——'
             + '这正是本章标题"绕过 Frida 检测"的另一面：对手也在用同样的手段绕过你的监控。'
             + '</div></div>';
           return html;
         },
         expected: (v) => {
           const arch = /a64|arm64|64/i.test(String(v.arch || '')) ? 'a64'
                      : /arm32|arm|32/i.test(String(v.arch || '')) ? 'arm32' : null;
           const name = String(v.name || '').trim().toLowerCase().replace(/[^a-z]/g, '');
           const ok = arch === 'a64' && name === 'openat';
           return {
             ok,
             detail: ok
               ? '<b>全对。</b>架构 AArch64（号在 X8），调用 <code>openat</code>（nr=56），目标是 <code>/proc/self/maps</code>。' +
                 '<br>你已经具备"读裸 SVC"的能力了 —— 这正是定位反调试代码的核心技能。'
               : (arch !== 'a64'
                   ? '<b>架构判断错了。</b>号放在 <code>X8</code> 而不是 <code>R7</code>，所以是 AArch64。'
                   : '<b>调用名不对。</b>AArch64 下 0x38=56 是 <code>openat</code>，' +
                     '而且 <b>AArch64 没有 <code>open</code></b> —— 这是最容易踩的坑。')
           };
         },
         showAnswer:
           '① 架构：AArch64\n' +
           '   依据：系统调用号放在 X8（ARM32 是 R7）；参数用 X0/X1/W2；\n' +
           '         寄存器是 64 位 X 系列（ARM32 是 R 系列）。\n\n' +
           '② 系统调用号 0x38 = 56 → openat（AArch64）\n' +
           '   ⚠️ 注意：AArch64 没有 open 这个系统调用，只有 openat。\n' +
           '      同样号值 56 在 ARM32 下完全不是 openat。\n\n' +
           '③ 参数：\n' +
           '   X0 = 0xFFFFFF9C = -100 = AT_FDCWD（相对当前目录）\n' +
           '   X1 → "/proc/self/maps"\n' +
           '   W2 = 0 = O_RDONLY\n\n' +
           '   行为：只读打开自己的内存映射表 —— 典型反调试/反 Frida 检测。\n' +
           '   危险点：走的是内联 SVC，绕过 libc，\n' +
           '           所以 hook open/fopen 看不到它。',
         hint:
           '第一步永远是<b>看号放在哪个寄存器</b>：<code>X8</code> → AArch64，<code>R7</code> → ARM32。<br>' +
           '<code>0x38</code> 是十六进制，先换成十进制：<code>0x38 = 3×16 + 8 = 56</code>。<br>' +
           '然后想一个问题：<b>AArch64 上有没有 <code>open</code> 这个系统调用？</b>（回忆 27.3 节讲的）',
         after:
           T.note('ok', '✅ 这个实验的价值',
             '<p style="margin-bottom:0">你现在能<b>从裸汇编读出系统调用语义</b>了。' +
             '这个能力在第 27 章有两个直接用途：<br>' +
             '① <b>定位绕过 libc 的调用</b>——静态扫描 <code>0xEF000000</code> / <code>0xD4000001</code>，' +
             '然后用这套方法解码每一条，就能知道对手在偷偷做什么；<br>' +
             '② <b>理解检测逻辑</b>——看到 <code>/proc/self/maps</code> 就基本能确定是反 Frida，' +
             '不需要再逆一大段混淆代码。<br>' +
             '<span class="hit">"读得懂系统调用"，等于拿到了对手行为的意图清单。</span></p>')
       }
     },

     /* ================= 27.4C 实战案例 ================= */
     {
       h: '27.4C', title: '实战案例：wxshadow 式内核 Hook 的原理复刻',
       case: {
         source: 'kanxue',
         title: '[原创] Android 内核 wxshadow-style Hook 核心原理复刻实验心得',
         date: '2026-7-26',
         author: 'Ivory0',
         target: 'Pixel 7（代号 panther）/ Android 14 / 内核 5.10.198-android13-4-00050-g12f3388846c3-ab11920634；FolkPatch 50ac6,d01 KPM；被测对象是自写 Lab App 自己分配、自己映射的页',
         background:
           '<p>第 27 章反复讲一条：<b>观测点必须高于对手的绕过点</b>。当对手已经在用户态内联 <code>SVC</code>，' +
           '你能去的下一层就是内核。这篇帖子是这一步的完整工程记录——作者在 <b>Pixel 7（panther）/ Android 14</b> 上，' +
           '内核 <code>5.10.198-android13-4-00050-g12f3388846c3-ab11920634</code>，用 <b>FolkPatch 50ac6,d01</b> 的 KPM 机制，' +
           '复刻了一遍 wxshadow 式内核 Hook 的核心原理。</p>' +
           '<p>它的目标很纯粹：<b>不改目标代码一个字节，靠 page table 切换实现无痕 Hook</b>。' +
           '被测对象是作者自写 Lab App 自己分配、自己映射的页。整篇帖子的重心不在「Hook 成功了」，' +
           '而在<b>状态怎么管、边界怎么划</b>。</p>',
         points: [
           '触发安装选 <b>UXN fault</b>：目标页先临时不可执行，首次执行时进入 <b>IABT</b>，KPM 校验 <code>mm + VA + generation</code> 之后才切换视图。',
           '执行视图的切换路线是 visible clone → <b>raw two-PFN</b>；读取隐藏则从 translation-DABT 的 read-cycle 走到 <b>raw-XOM permission-DABT</b>。',
           '<b>明确弃用硬件断点</b>：理由不是做不到，而是<b>资源占用与上下文管理成本太高</b>。',
           'KPM 维护一个 <code>Lab UID + owner TGID + owner mm + token</code> 的 session，并<b>固定两个 Lab slot</b>。',
           '状态机共 9 态：EMPTY / CAPTURED / SOURCE_UXN / SHADOW_RX / ORIGINAL_STEP / RESTORED / POISONED / ORIGINAL_READ / SHADOW_XOM。',
           '<b>把 PTE 当事务来做</b>：admit → snapshot original PTE/PFN → prepare shadow backing → walk target mm → take leaf PTE lock → check live PTE == expected → clear old PTE → target-mm TLB invalidate → sync executable shadow aliases → install replacement → commit。',
           '<code>r0lab_raw_walk_locked</code> 的硬约束：地址 <b>4KiB 对齐</b>，VMA 要完整覆盖且 <code>vma-&gt;vm_mm == mm</code>；逐级走 pgd / p4d / pud / pmd 并做 none / bad 检查；用 <code>pud_sect()</code> / <code>pmd_sect()</code> 挡掉 section mapping，<b>只处理 4KiB 的 leaf PTE</b>。',
           '<code>r0lab_raw_replace_locked</code> 的顺序：<code>ptep_get_and_clear()</code> → <code>flush_tlb_page()</code> → 当指向 shadow PFN 时调用 <code>r0lab_runtime_sync_icache_aliases()</code> → <code>set_pte_at()</code>。',
           'raw-XOM 的做法是：<code>clear_pte_bit(pte, __pgprot(PTE_USER))</code> 清掉用户读侧，同时 <code>clear_pte_bit(pte, __pgprot(PTE_UXN))</code> 保留 EL0 执行侧。',
           '<b>行为证据</b>：源页是 <code>MOV W0,#42 ; RET</code>（返回 42），shadow 页是 <code>MOV W0,#99 ; RET</code>（返回 99）；' +
           '观测序列为 <code>normal→42</code> / <code>arm raw→SOURCE_UXN</code> / <code>IABT→切 shadow PFN</code> / <code>shadow exec→99</code> / <code>clear→restore</code> / <code>normal→42</code>。'
         ],
         method: [
           '先做最小闭环：用 visible clone 把「触发 → 切换 → 执行 → 还原」跑通，再上 raw two-PFN 这种难点，不在没验证的地基上盖楼。',
           '把工作拆成可验证的阶段（M0~S4），每一阶段都有独立的通过标准，而不是一口气写完再调。',
           '<b>每次只改一个变量</b>来定位 panic —— 作者的经验是：第一次 PTE 修改<b>并不是</b>主要风险点，反复重启卡住的其实是<b>生命周期</b>。',
           '做三层验证：静态契约脚本 + device smoke + lifecycle stress runner —— 静态管约定、smoke 管通路、stress 管状态反复切换。',
           '补负向测试：bad BRK offset、stale generation、wrong slot 等逐项 probe，确认异常输入会被正确拒绝，而不是静默走错分支。',
           '实现上把 PTE 修改做成事务（admit → snapshot → prepare → walk → lock → 校验 live PTE → clear → TLB invalidate → sync icache aliases → install → commit），任何一步不满足预期就不进入下一步。'
         ],
         result:
           '<p>在自写 Lab App 自己分配、自己映射的页上，这套机制跑通了：' +
           '<b>同一段代码，正常执行返回 42，进入 shadow 视图执行返回 99，清除之后又回到 42</b>——' +
           '目标代码一个字节都没被改写。</p>' +
           '<p>作者给出的核心结论是：<b>「内核 Hook 的难点集中在状态转换治理」</b>。' +
           '也就是说，能做到切换并不稀奇，<b>难的是让它在任意时刻都能安全地切回去</b>。</p>',
         terms: ['UXN fault', 'IABT', 'raw two-PFN', 'raw-XOM', 'PTE 事务', 'leaf PTE lock', 'TLB invalidate', 'icache aliases', 'generation', 'KPM', 'FolkPatch', 'wxshadow'],
         limits:
           '<p>作者<b>专门用一节划边界</b>，明确说明这停留在概念验证阶段。未纳入范围的四类：</p>' +
           '<p>① <b>arbitrary PID / VA 未纳入</b> —— 只处理 Lab App 自己分配映射的页，没有做任意进程、任意地址；</p>' +
           '<p>② <b>通用 iTLB / dTLB split-view 未纳入</b>；</p>' +
           '<p>③ <b><code>/proc</code> / ptrace / VMA 隐蔽未纳入</b> —— 也就是说，它并不保证在对手的检测视角下看不出来；</p>' +
           '<p>④ <code>handle_mm_fault</code> 正向路由 <b>blocked</b>；EPAN 路线是条件性的，<b>本机没跑通</b>。</p>' +
           '<p>作者原话：<b>「（人话：做起来太复杂，而且也过不了审）」</b>。</p>' +
           '<p>⚠️ <b>抓取缺口，如实注明</b>：整理本页时，<b>该帖第 3、4 节的标题及正文没有被抓取到</b>（抓取工具输出被截断）。' +
           '因此本案例只覆盖抓取到的部分，<b>缺失的两节很可能就是上面几条限制的实现细节，本页不做推测、不予补全</b>；' +
           '要看完整推导请回到原帖。</p>',
         analysis:
           '<p><b>这是第 27 章「把观测点放到比对手更低的层级」这条元原则最彻底的一次实践。</b>' +
           '前面几节你还在挑层级（libc / syscall 表 / 内核模块），这个案例直接给出了终点形态：' +
           '<b>不修改目标代码一个字节，靠 page table 在「源页」与「影子页」之间切换——同一段地址，执行时看到 99，正常时看到 42。</b>' +
           '对手在用户态做的任何自校验（算函数头字节、比对代码段校验和、查 inline hook 痕迹）' +
           '<b>看到的都是原封不动的源页</b>。' +
           '<span class="hit">「观测点高于对手的绕过点」在这里被推到了极致：连被观测的那段代码本身，都从来没有被碰过。</span></p>' +
           '<p><b>但真正值得学的，是作者紧接着给出的那句话：无痕的代价是复杂度。</b>' +
           '他在结论里写：<b>「内核 Hook 的难点集中在状态转换治理」</b>。' +
           '这句话把两件事彻底分开了——<b>「能不能做」和「能不能稳定做」是两回事</b>。' +
           '把一条 PTE 改成指向影子页，是几十行代码的事；难的是这个改动要在 9 个状态之间来回切换' +
           '（EMPTY / CAPTURED / SOURCE_UXN / SHADOW_RX / ORIGINAL_STEP / RESTORED / POISONED / ORIGINAL_READ / SHADOW_XOM），' +
           '而每一次切换都可能被并发、被中断、被目标自己触发的缺页打断。' +
           '所以作者把 PTE 修改做成了<b>事务</b>：先 snapshot 原始 PTE/PFN、拿 leaf PTE lock、' +
           '<b>校验 live PTE 是否还等于当初记下的那个</b>，再 clear → <code>flush_tlb_page()</code> → 同步 icache aliases → 安装 → commit。' +
           '<span class="hit">先快照、再上锁、然后校验「世界还是我以为的那个世界吗」——这三步是所有并发场景下的通用纪律，不只是内核 Hook 才有。</span></p>' +
           '<p>第二件值得学的，是<b>他的方法论比技术本身更可复制</b>：先做最小闭环（visible clone）再上难点；' +
           '把工作拆成可验证阶段 M0~S4；<b>每次只改一个变量来定位 panic</b>；' +
           '三层验证（静态契约脚本 + device smoke + lifecycle stress runner）；' +
           '以及一整套负向测试（bad BRK offset、stale generation、wrong slot）。' +
           '尤其是那句经验——<b>第一次 PTE 修改并不是主要风险点，反复重启卡住的其实是生命周期</b>——' +
           '这正是「不要凭直觉猜风险点，要用实验定位风险点」的示范。' +
           '注意他还主动<b>弃用了硬件断点</b>，理由写得很清楚：资源占用与上下文管理成本太高。' +
           '<b>选方案时把成本算进去，而不是只看能不能实现——这是工程判断，不是技术炫技。</b></p>' +
           '<p>最后一条，也是这个案例最该被记住的：<b>作者对边界的诚实</b>。' +
           '他专门用一节列出未纳入的四类 —— arbitrary PID/VA、通用 iTLB/dTLB split-view、<code>/proc</code>/ptrace/VMA 隐蔽、' +
           '<code>handle_mm_fault</code> 正向路由（连 EPAN 路线本机也没跑通）—— 还自嘲了一句' +
           '<b>「做起来太复杂，而且也过不了审」</b>。' +
           '这句话的分量比成果本身更重：<b>它精确地说清了「这个东西现在到底能做到什么程度」</b>。' +
           '对照本课 27.4 节那张「按目标强度选层级」的表：内核层观测点确实「无法被用户态绕过」，' +
           '但同一节也提醒过<b>它并不是免费的——它会暴露你自己</b>。' +
           '作者把「VMA 隐蔽未纳入」明写出来，等于承认这笔代价还没付。' +
           '<span class="hit">做完一个酷炫的 PoC 之后敢写下「它不能做什么」，才是能拿去做工程决策的结论。</span></p>' +
           '<p><b>本课的一贯判断在这里再次成立：不是「哪个工具最强」，而是「对手在哪一层，我的观测点该放在哪一层，以及我凭什么认为它有效」。</b>' +
           '这个案例的回答是：<b>放到内核 page table 那一层，凭的是「目标代码零改动」这条硬证据，' +
           '以及一整套状态机 + 事务 + 负向测试撑起来的稳定性论证。</b></p>',
         link: 'https://bbs.kanxue.com/thread-292175.htm',
         linkNote: '看雪论坛原创帖'
       }
     },

     /* ================= 27.4 ================= */
     {
       h: '27.4',
       title: '三种追踪技巧横评：把你的观测点放到哪一层',
       html:
         '<p>现在你知道了：SVC 可以从两条路径发起，而 libc hook 只能看见其中一条。' +
         '下面把三种可行方案摆在一起，从四个维度做对照。</p>' +
         '<p class="small muted">看的时候请带着一个问题：<b>每一种方案，是"让对手绕不过"，还是"赌对手不知道"？</b></p>',

       stage: {
         title: '三种追踪方法 · 四维横评（实现难度 / 覆盖率 / 抗绕过 / 被检测风险）',
         speed: 2000,
         render:
           '<div class="flow-row" style="align-items:stretch;gap:12px">' +
             '<div class="card" style="flex:1">' +
               '<div class="card-title">① Hook 内核 syscall 表</div>' +
               '<div class="blk" id="a1">实现难度</div><div class="blk" id="a2">覆盖率</div>' +
               '<div class="blk" id="a3">抗绕过</div><div class="blk" id="a4">被检测风险</div>' +
               '<div id="av" class="pill acc">未评估</div>' +
             '</div>' +
             '<div class="card" style="flex:1">' +
               '<div class="card-title">② 静态扫描 SVC 指令</div>' +
               '<div class="blk" id="b1">实现难度</div><div class="blk" id="b2">覆盖率</div>' +
               '<div class="blk" id="b3">抗绕过</div><div class="blk" id="b4">被检测风险</div>' +
               '<div id="bv" class="pill acc">未评估</div>' +
             '</div>' +
             '<div class="card" style="flex:1">' +
               '<div class="card-title">③ 陷入入口 / 硬件断点</div>' +
               '<div class="blk" id="c1">实现难度</div><div class="blk" id="c2">覆盖率</div>' +
               '<div class="blk" id="c3">抗绕过</div><div class="blk" id="c4">被检测风险</div>' +
               '<div id="cv" class="pill acc">未评估</div>' +
             '</div>' +
           '</div>' +
           '<div id="vnote" class="note" style="margin-top:12px"><p>逐个评估三种方法。</p></div>',

         reset: () => {
           ['a1','a2','a3','a4','b1','b2','b3','b4','c1','c2','c3','c4'].forEach(function (i, n) {
             var names = ['实现难度', '覆盖率', '抗绕过', '被检测风险'];
             SET(i, names[n % 4]);
             S(i, '');
           });
           CLS('av', 'pill acc'); CLS('bv', 'pill acc'); CLS('cv', 'pill acc');
           SET('av', '未评估'); SET('bv', '未评估'); SET('cv', '未评估');
           SET('vnote', '<p>逐个评估三种方法。</p>');
         },

         steps: [
           { run: () => {
               SET('a1', '实现难度 <b>高</b>'); S('a1', 'hot');
               SET('a2', '覆盖率 <b>最高</b>'); S('a2', 'cool');
               SET('a3', '抗绕过 <b>无法绕过</b>'); S('a3', 'cool');
               SET('a4', '被检测风险 <b>低</b>（用户态看不见）'); S('a4', 'cool');
               CLS('av', 'pill ok'); SET('av', '最彻底 · 门槛最高');
             },
             note: '<b>方法① · Hook 内核 syscall 表。</b>直接修改内核里的系统调用分发表，把所有系统调用都截下来。<br>' +
                   '<span class="hit">决定性优势：无法被用户态绕过。</span>因为不管你从哪条路径发起系统调用，' +
                   '最终都必须经过内核这张表——App 在用户态做的任何反检测，都看不见你的观测点。' +
                   '这就是本章标题"内核模块绕过 Frida 检测"的由来。<br>' +
                   '<span class="miss">代价：需要内核层能力</span>——编译内核模块、定制内核、刷机，门槛高且有变砖风险。' },

           { run: () => {
               SET('b1', '实现难度 <b>低</b>（Frida 就能做）'); S('b1', 'cool');
               SET('b2', '覆盖率 <b>不完整</b>'); S('b2', 'hot');
               SET('b3', '抗绕过 <b>弱</b>'); S('b3', 'hot');
               SET('b4', '被检测风险 <b>低</b>（只读不写）'); S('b4', 'active');
               CLS('bv', 'pill warn'); SET('bv', '最容易上手 · 最易被绕过');
             },
             note: '<b>方法② · 静态扫描代码段找 SVC 指令。</b>用 <code>0xEF000000</code> / <code>0xD4000001</code> 做特征字节，' +
                   '在 so 的代码段里搜，命中处下断点或做记录。用 Frida 的 <code>Memory.scan</code> 就能实现，不需要任何内核能力。<br>' +
                   '<span class="bad">三个明确的短板：</span>① <b>动态生成的代码扫不到</b>——App 在运行时解密出一段代码扔进可执行内存，' +
                   '静态扫描时那段内存还不存在（这正是 27.7 节的内容）；② <b>可能误报</b>——数据段里恰好出现这两个字节序列的情况并不罕见；' +
                   '③ <b>扫描本身有开销</b>，大 so 全量扫描会明显拖慢启动。' },

           { run: () => {
               SET('c1', '实现难度 <b>中</b>'); S('c1', 'active');
               SET('c2', '覆盖率 <b>精确但不全</b>'); S('c2', 'active');
               SET('c3', '抗绕过 <b>强</b>'); S('c3', 'cool');
               SET('c4', '被检测风险 <b>极低</b>'); S('c4', 'cool');
               CLS('cv', 'pill ok'); SET('cv', '最精确 · 数量有限');
             },
             note: '<b>方法③ · Hook 陷入入口 / 用硬件断点。</b>两条子路线：在内核侧 hook 异常向量表，' +
                   '或者干脆在 SVC 指令地址上设置<b>硬件断点</b>。<br>' +
                   '<span class="hit">硬件断点的决定性优势：不修改目标内存。</span>它由 CPU 调试寄存器实现，' +
                   '目标内存一个字节都不变，所以校验代码段校验和、检查函数首字节、扫描内存找 hook 痕迹这些反调试手段<b>全部无效</b>。<br>' +
                   '<span class="miss">限制：ARM 上通常只有 4-6 个硬件断点</span>，无法大规模布点。' +
                   '这反过来要求你<b>必须先理解目标行为，才能选对位置</b>——工具的能力上限变成了你的分析能力上限。' },

           { run: () => {
               S('a1', 'done'); S('a2', 'done'); S('a3', 'done'); S('a4', 'done');
               S('b1', 'done'); S('b2', 'done'); S('b3', 'done'); S('b4', 'done');
               S('c1', 'done'); S('c2', 'done'); S('c3', 'done'); S('c4', 'done');
               SET('vnote', '<p><b>横评结论：三者是能力递进关系，不是互相替代。</b>' +
                            '静态扫描最容易但最易被绕过；硬件断点精确但数量有限；内核 hook 最彻底但门槛最高。' +
                            '<b>实战中按目标的反检测强度选层级。</b></p>');
             },
             note: '<b>不要问"哪个最好"，要问"我的对手在哪一层"。</b><br>' +
                   '如果目标只是个普通加固 App，静态扫描 + 在命中点下软件断点就够了；' +
                   '如果目标会校验代码段、会检测调试器，就必须上硬件断点；' +
                   '如果目标连 <code>mprotect</code> 都走 SVC、代码还是运行时解密的，只有内核侧能稳定观测。' }
         ]
       },

       after:
         T.note('ok', '✅ 决策模型：按目标强度选层级',
           '<p>把上面的横评压缩成一张可以直接照着走的表：</p>' +
           T.tbl(['目标的反检测强度', '推荐层级', '具体做法', '为什么不选别的'], [
             ['无加固，只是好奇它调了什么', '② 静态扫描', 'Memory.scan 搜两个特征码，命中处打印调用号', '没必要上硬件断点'],
             ['有 libc hook 检测 / 会校验代码段', '③ 硬件断点', '在已知 SVC 地址上设硬件断点，不碰内存', '软件断点会改内存，必被抓'],
             ['代码运行时解密、动态释放', '③ + 内核监控', '观察点盯内存权限变化，或内核侧监控 mprotect', '静态扫描时那段代码还不存在'],
             ['全链路反调试、连 mprotect 都走 SVC', '① 内核 syscall 表', '定制内核 / 内核模块改分发表', '用户态任何观测点都可能被架空']
           ]) +
           '<p class="small muted">这张表是<b>能力递进</b>的：越往下，门槛越高，但"被绕过"的可能性越低。' +
           '选层级时的判断依据不是你的技术水平，而是<b>对手做了什么</b>。</p>') +
         T.note('warn', '⚠️ 一个必须提前想清楚的问题',
           '<p>内核层观测点虽然"无法被用户态绕过"，但它并不是免费的：<b>它会暴露你自己</b>。' +
           '如果目标 App 有能力读取内核信息（比如通过某些侧信道或系统调用探测），定制内核本身就是一个可被指纹识别的特征。</p>' +
           '<p>所以真正的对抗永远是<b>双向</b>的：你在提高观测层，对手也可能在提高探测层。' +
           '<span class="pill warn">具体探测手法与 0r0env 的隐藏措施待核实，以作者发布为准</span></p>')
     },

     /* ================= 27.5 ================= */
     {
       h: '27.5',
       title: '实战：定位 SVC syscall 的五种姿势',
       html:
         '<p>知道了 <code>SVC</code> 长什么样，接下来的问题是：<b>在一个几 MB 的 so 里，怎么找到它？</b>' +
         '下面五种姿势，按"从最简单到最可靠"排列，你会在不同场景下用到不同的几种。</p>' +
         T.tbl(['姿势', '做法', '前提', '什么时候用'], [
           ['① 反汇编节奏匹配',
            '在 IDA / Ghidra 里找「<code>mov r7, #imm</code> 或 <code>mov x8, #imm</code> 紧跟 <code>SVC</code>」这个固定节奏',
            '能静态反汇编目标 so',
            '有 so 可分析时，<b>永远先做这一步</b>'],
           ['② Frida 内存扫描',
            '<code>Memory.scan</code> 搜特征字节 <code>00 00 00 ef</code>（ARM32）/ <code>01 00 00 d4</code>（AArch64）',
            '能注入 Frida',
            'so 被加固、反汇编困难，或需要覆盖运行时映射的所有段'],
           ['③ 从 libc 反推',
            'libc 的每个封装函数（<code>open</code>/<code>read</code>/<code>write</code>…）内部都有一条 <code>svc</code>，先定位它们，建立"地址 → 调用号"对照',
            '能拿到 libc',
            '想先摸清正常情况下 SVC 都出现在哪些地址，作为基线'],
           ['④ 内核侧系统调用跟踪',
            '<code>strace</code> 类工具、或内核模块记录系统调用',
            '内核层能力（root / 定制内核）',
            '只想知道"它到底发了哪些系统调用"，不关心指令在哪'],
           ['⑤ 硬件断点',
            '在①②③找到的地址上设硬件断点，不修改内存',
            '调试器 / 内核支持',
            '目标会校验代码段或有自校验时（见 27.11）']
         ]) +
         '<p><b>顺序很重要。</b>很多人的第一反应是直接上 Frida 扫描——但如果目标 so 没有加固，' +
         '<b>姿势①在 IDA 里点两下就有结果</b>，而且能同时看到上下文（谁调用了它、参数怎么来的）。' +
         '工具越轻，获得的<b>上下文信息</b>反而越多。</p>' +
         '<p class="small muted">关于姿势②的一个细节：扫描器里写的是<b>字节序列</b>而不是整数常量。' +
         '小端机器上，<code>0xEF000000</code> 在内存里的字节顺序是 <code>00 00 00 EF</code>。' +
         '把字节序写反是这类扫描器最常见、也最难发现的一类 bug——它不会报错，只会<b>一条都扫不到</b>。</p>',

       term: {
         title: '姿势② 实操：用 Frida 扫描 SVC 特征字节',
         lines: [
           { t: 'd', s: '# 目标：在目标 so 的代码段里找出所有 SVC 指令' },
           { t: 'd', s: '# 特征：ARM32 SVC#0 = 0xEF000000 → 小端字节 00 00 00 EF' },
           { t: 'd', s: '#       AArch64 SVC#0 = 0xD4000001 → 小端字节 01 00 00 D4' },
           { t: 'p', s: 'frida -U -f com.target.app -l scan_svc.js',
             note: '<b>启动。</b>用 <code>-f</code> 让 frida 负责启动 App，这样能在最早的时机注入，' +
                   '避免错过在启动阶段就发生的 SVC 调用。' },
           { t: 'o', s: 'Spawning `com.target.app`...' },
           { t: 'o', s: 'Attaching...' },
           { t: 'd', s: '# --- scan_svc.js 核心逻辑 ---' },
           { t: 'd', s: "var m = Process.findModuleByName('libtarget.so');" },
           { t: 'o', s: 'module: libtarget.so  base=0x7a3c1000  size=0x2a4000',
             note: '<b>先定位模块。</b><code>base</code> 和 <code>size</code> 划定了扫描范围。' +
                   '<span class="miss">坑：不要对整个进程空间盲扫</span>——几 GB 的地址空间会让扫描慢到不可用，而且数据段里的误报会淹没结果。' },
           { t: 'd', s: '// 64 位目标：搜 AArch64 的 SVC 编码' },
           { t: 'd', s: "var hits = Memory.scanSync(m.base, m.size, '01 00 00 d4');" },
           { t: 'o', s: 'hits.length = 7',
             note: '<b>命中 7 处。</b>注意：<code>Memory.scanSync</code> 返回的是 <code>{address, size}</code> 数组，' +
                   '<code>size</code> 恒为 4（一条指令的长度）。' },
           { t: 'o', s: '[0] 0x7a3c1d20  [1] 0x7a3c1d88  [2] 0x7a3c2f04',
             note: '<b>看地址分布。</b>如果这几处地址<b>聚在一起</b>（比如都在 <code>0x7a3c1xxx</code> 这一段），' +
                   '说明它们是同一批封装函数里的 SVC；如果<b>散落在不同段</b>，那更可能是 App 自己内联的调用点。' },
           { t: 'o', s: '[3] 0x7a3d4100  [4] 0x7a3d4104  [5] 0x7a3e8820  [6] 0x7a3e8830' },
           { t: 'p', s: '# 反汇编命中点，看它前面把什么数写进了 x8' },
           { t: 'o', s: '0x7a3e8820:  mov x8, #0x38      ; 56 = __NR_openat',
             note: '<b>这就是证据。</b><code>x8</code> 被写入 56，紧接着一条 <code>SVC</code>——' +
                   '按照 27.3 节的识别规则，这是一个标准的<b>内联 <code>openat</code></b>。' },
           { t: 'o', s: '0x7a3e8824:  svc #0' },
           { t: 'w', s: '⚠️ 误报排查：确认命中点是否真的在可执行段',
             note: '<b>必须做的一步。</b>数据段里恰好出现 <code>01 00 00 D4</code> 这四个字节完全可能。' +
                   '做法：把命中地址和 <code>/proc/self/maps</code> 里的段权限对一遍，' +
                   '<b>只保留落在 <code>r-x</code> 段内的命中</b>。' },
           { t: 'e', s: 'Error: unable to find module &quot;libtarget.so&quot;',
             note: '<b>常见报错：模块还没加载。</b>如果目标 so 是延迟加载的（比如在 <code>JNI_OnLoad</code> 之后才 <code>dlopen</code>），' +
                   '注入时它根本不存在。<br><b>出问题往哪查：</b>① 用 <code>Process.enumerateModules()</code> 确认模块名拼写和加载时机；' +
                   '② 把扫描逻辑挂到 <code>dlopen</code> 之后；③ 注意 32/64 位——如果 App 同时加载 32 位和 64 位 so，' +
                   '<b>两种特征字节都要搜</b>，用错了就是一个都扫不到。' }
         ]
       },

       after:
         T.note('key', '🔑 定位只是第一步，扣动扳机才是',
           '<p>找齐 SVC 地址之后，你有两个选择：在这些地址上<b>下软件断点</b>（写 <code>BRK</code> 指令，会改内存，可能被抓），' +
           '或者下<b>硬件断点</b>（不改内存，但只有 4-6 个名额）。</p>' +
           '<p>27.11 节会详细讲这个选择。这里先记住：<b>命中点可能有几十个，而硬件断点只有几个</b>——' +
           '所以你必须在"扫描结果"和"硬件名额"之间做一次取舍。<b>这个取舍本身，就是 27.4 节决策模型的实战形态。</b></p>')
     },

     /* ================= 27.6 ================= */
     {
       h: '27.6',
       title: '决策演练 · 当你的 hook 一次都没触发',
       html: '<p>把 27.1 的场景原样交给你，看你怎么走。</p>',
       decision: {
         start: 'n0',
         nodes: {
           n0: {
             label: '情境一 · libc hook 零命中',
             scenario: '<b>情境：</b>你写了一个 Frida 脚本，<code>Interceptor.attach</code> 挂上了 <code>open</code>、' +
                       '<code>openat</code>、<code>read</code> 三个 libc 导出函数，日志里准备看它怎么读 <code>/proc/self/maps</code>。' +
                       '运行 App 之后，你的检测脚本（另一个脚本，读 smaps 统计）明确报告目标确实读了那个文件，' +
                       '<b>但你的三个 hook 一次都没触发</b>。frida-server 活着，其他 hook（比如字符串相关）也都正常。',
             choices: [
               { t: 'A. 怀疑是反调试：重启 frida-server、换更隐蔽的注入方式、检查有没有被检测', next: 'na' },
               { t: 'B. 覆盖面不够，继续加 hook：把 <code>fopen</code>、<code>syscall</code>、<code>__openat</code> 等一堆变体全挂上', next: 'nb' },
               { t: 'C. 先验证"它到底有没有走 libc"：静态扫 SVC 特征码，或在内核侧看它实际发了哪些系统调用', next: 'nc' },
               { t: 'D. 不猜了，直接上最狠的：做一个内核模块改 syscall 分发表，把所有系统调用都记下来', next: 'nd' }
             ]
           },
           na: {
             label: '选 A', terminal: true, verdict: 'bad',
             verdictTitle: '方向错了：你在排查一个不存在的故障',
             result: '<b>认知根源：默认「观测不到 = 工具坏了」。</b>' +
                     '这个默认在大多数章节里是对的——Frida 挂不上通常是注入问题、反调试、或者符号名写错。' +
                     '但本章的前提恰恰是<b>工具完全正常，只是你的观测点被绕过了</b>。<br>' +
                     '注意题干给你的关键线索：<b>其他 hook 都正常</b>。如果 frida-server 被杀或注入失败，' +
                     '是<b>所有</b> hook 一起失效，而不是精确地只有这三个文件相关的函数失效。' +
                     '<b>「部分失效」这个模式本身就指向"路径问题"而不是"工具问题"。</b><br>' +
                     '<b>正确做法：</b>先做区分性实验——挂一个必然被调用的 libc 函数（比如内存分配或时间相关）作为"存活探针"。' +
                     '探针命中说明工具没问题，那就只剩"目标没走这一层"这一种解释。' },
           nb: {
             label: '选 B', terminal: true, verdict: 'bad',
             verdictTitle: '方向错了：在同一个层级上横向扩张',
             result: '<b>认知根源：把「覆盖不够」当成问题，而真正的问题是「层级错了」。</b>' +
                     '这是最容易犯、也最隐蔽的错误——因为它看起来完全合理：加更多 hook 总是好的，对吧？<br>' +
                     '不对。<b>如果对手根本没有经过 libc 这一层，你挂多少个 libc 函数都是零。</b>' +
                     '你可以把整个 libc 的导出表全挂上，结果还是零命中，而且还白白增加了脚本体积和被检测面。' +
                     '<b>横向扩展解决不了纵向错位。</b><br>' +
                     '一个可操作的判据：如果你挂在 <code>open</code> 上没命中，但挂了 <code>syscall</code> 这个通用入口也没命中，' +
                     '那就<b>不是覆盖面问题</b>——因为 <code>syscall()</code> 是 libc 里所有系统调用的公共转发点，' +
                     '它没命中意味着<b>连 libc 都没进</b>。<br>' +
                     '<b>正确做法：</b>停止加 hook，去做"路径验证"（见选项 C）。' },
           nc: {
             label: '选 C', terminal: true, verdict: 'good',
             verdictTitle: '正确：先确认路径，再选观测点',
             result: '<b>这是唯一能真正推进的诊断。</b>你的问题不是"怎么 hook 得更好"，而是"它到底走没走 libc"。' +
                     '在回答这个问题之前，任何方案选择都是赌博。<br>' +
                     '<b>为什么这一步如此关键：</b>它会把你带到正确的问题上——' +
                     '如果确认它绕过了 libc，那接下来的问题就变成"我该把观测点放到哪一层"，' +
                     '这正是 27.4 节那张决策表的入口；如果发现它其实走了 libc（比如通过 <code>dlopen</code> 拿到函数指针调用），' +
                     '那问题就回到常规的 hook 技巧上。<b>两种结果的处置方式完全不同。</b><br>' +
                     '<b>具体怎么做：</b>① 用 <code>Memory.scan</code> 在目标 so 里搜 <code>01 00 00 d4</code>，' +
                     '看有没有内联 SVC；② 反汇编命中点，确认前面是不是 <code>mov x8, #imm</code>；' +
                     '③ 如果目标加固严重，退到内核侧看它实际发起了哪些系统调用。<br>' +
                     '<b>这一步的副产品：</b>你会顺手得到一批 SVC 地址，正好是 27.11 节硬件断点的布点候选。' },
           nd: {
             label: '选 D', terminal: true, verdict: 'bad',
             verdictTitle: '反直觉：最强的手段，此刻不是最优解',
             result: '<b>这个选项最容易骗过有经验的人——因为它"技术上完全正确"。</b>' +
                     '内核 hook 确实是本章能力上限最高的方案，也确实无法被用户态绕过。问题不在方案，<b>在于顺序</b>。<br>' +
                     '<b>认知根源：把「最强的工具」当成「最好的下一步」。</b>' +
                     '内核 syscall 表 hook 一开，你会收到<b>海量的系统调用流水</b>——启动阶段每秒可能几万条，' +
                     '涉及内存、线程、文件、时钟、ioctl、futex……<b>你依然不知道哪一条是"读 /proc/self/maps"。</b><br>' +
                     '换句话说：你付出了刷机、编译内核、承担变砖风险的全部成本，' +
                     '换来的却是一堆<b>没有上下文的原始数据</b>。而选项 C 只需要几秒钟的静态扫描，' +
                     '就能把范围从"几万条系统调用"缩小到"7 个 SVC 地址"。<br>' +
                     '<b>正确的决策顺序是：先用最轻的手段做诊断，确认路径之后，再决定要不要上内核层。</b>' +
                     '内核层是给"确认了对手在用户态无法观测"的场景用的，不是给"我还没搞清楚发生了什么"的场景用的。'
           }
         }
       }
     },

     /* ================= 27.7 ================= */
     {
       h: '27.7',
       title: '内存动态释放代码：一个只有几十毫秒的窗口',
       html:
         '<p>现在换一个对手。这一次，你的静态扫描扫到了个寂寞——<b>so 里根本没有可疑的代码</b>。</p>' +
         '<p>因为这已经不是静态代码了。' +
         '<span class="term" data-def="把关键代码加密存放，运行时才解密到内存并赋予可执行权限，执行完立即释放的技术">内存动态释放代码</span>' +
         '（Memory Dynamic Release）的做法是：</p>' +
         '<p><b>① </b>运行时从某处（网络、资源文件、native 数据段）取到<b>加密的代码</b> → ' +
         '<b>② </b>解密到一块内存 → <b>③ </b>用 <code>mmap</code> + <code>mprotect(PROT_READ|PROT_WRITE|PROT_EXEC)</code> ' +
         '把这块内存变成<b>可执行</b> → <b>④ </b>跳进去执行 → <b>⑤ </b>执行完 <code>munmap</code> 释放，或改回不可执行。</p>' +
         '<p>它的可怕之处不在于加密强度，而在于<b>它把"分析对象"从磁盘上搬到了一个转瞬即逝的时间窗口里</b>。</p>',

       stage: {
         title: '内存动态释放代码 · 时间轴与介入窗口',
         speed: 1900,
         render:
           '<div class="flow-row" style="align-items:stretch;gap:10px;flex-wrap:wrap">' +
             '<div class="blk" id="t1">① 取到加密代码</div><span class="arrow">→</span>' +
             '<div class="blk" id="t2">② 解密到内存</div><span class="arrow">→</span>' +
             '<div class="blk" id="t3">③ mmap + mprotect RWX</div><span class="arrow">→</span>' +
             '<div class="blk" id="t4">④ 执行</div><span class="arrow">→</span>' +
             '<div class="blk" id="t5">⑤ munmap / 去掉 X 权限</div>' +
           '</div>' +
           '<div class="flow-row" style="margin-top:14px">' +
             '<span class="blk" id="w0">静态分析视角</span>' +
             '<span class="blk" id="w1">内存扫描视角</span>' +
             '<span class="blk" id="w2">你的介入窗口</span>' +
           '</div>' +
           '<div id="tnote" class="note" style="margin-top:12px"><p>沿着时间轴走一遍，注意窗口有多窄。</p></div>',

         reset: () => {
           ['t1','t2','t3','t4','t5','w0','w1','w2'].forEach(function (i) { S(i, ''); });
           SET('tnote', '<p>沿着时间轴走一遍，注意窗口有多窄。</p>');
         },

         steps: [
           { run: () => S('t1', 'active'),
             note: '<b>① 取到加密代码。</b>密文可能来自网络下发、APK 资源文件、或者藏在 so 的数据段里。' +
                   '对静态分析者来说，这些字节<b>看起来就是一段随机数据</b>，不会引起任何注意。' +
                   '<span class="bad">静态分析在这里就已经失效了——代码根本不在 so 的代码段里。</span>' },

           { run: () => { S('t1', 'done'); S('t2', 'active'); },
             note: '<b>② 解密到内存。</b>解密算法可能很简单（异或、AES），但这不是重点。' +
                   '<b>重点是解密结果落在一块普通的内存里</b>，此刻它还没有可执行权限。' +
                   '这一步通常很难被观测——除非你 hook 了分配内存的函数。' },

           { run: () => { S('t2', 'done'); S('t3', 'active'); },
             note: '<b>③ mmap + mprotect 拿到 RWX。</b>这是全流程中<b>最显眼、也最值得下手</b>的一步：' +
                   '一个正常的 App 极少会申请"同时可写又可执行"的内存。' +
                   '<span class="hit">看到 RWX，基本可以直接判定这里有问题。</span><br>' +
                   '<b>这就是最经典的检测点：</b>hook <code>mprotect</code>，一旦出现 <code>PROT_EXEC</code> 就报警。' },

           { run: () => { S('t3', 'done'); S('t4', 'active'); },
             note: '<b>④ 执行 —— 窗口期开始。</b>从这一刻到 munmap 之间，就是所谓' +
                   '<span class="term" data-def="动态释放代码可执行的那一小段时间，通常只有几十毫秒甚至更短">窗口期</span>。' +
                   '<span class="miss">它很短。</span>执行完目标动作（可能只是算一个校验值，或者发一次系统调用）就结束了。' +
                   '<b>扫早了这块内存还没有代码，扫晚了代码已经没了。</b>' },

           { run: () => { S('t4', 'done'); S('t5', 'active'); S('w2', 'hot');
                          SET('tnote', '<p><b>窗口已经关闭。</b>如果你没有在步骤 ③→④ 之间介入，这次就错过了。</p>'); },
             note: '<b>⑤ 释放。</b><code>munmap</code> 直接把整块映射还回去，或者 <code>mprotect</code> 去掉执行权限。' +
                   '<b>痕迹被抹掉了。</b>事后再 dump 进程内存，什么都找不到。' },

           { run: () => S('w0', 'hot'),
             note: '<b>第一个视角：静态分析。</b>看磁盘上的 so —— <span class="bad">零收获</span>。' +
                   '代码从来没有以明文形式存在于文件里。' },

           { run: () => { S('w0', 'done'); S('w1', 'active'); },
             note: '<b>第二个视角：内存扫描。</b>能不能靠"定时扫可执行内存"抓到？' +
                   '<span class="miss">很不稳定。</span>取决于你的扫描周期和窗口期的相对长度。' +
                   '窗口期如果是几十毫秒，你以秒为周期扫，命中概率极低；' +
                   '<b>而且把扫描周期压到毫秒级，开销会大到影响 App 行为，反而暴露自己。</b>' },

           { run: () => { S('w1', 'done'); S('w2', 'active');
                          SET('tnote', '<p><b>结论：不要"扫描"，要"被通知"。</b>扫描是轮询，你在赌运气；' +
                                       'hook 是事件驱动，窗口一开你就收到回调。</p>'); },
             note: '<b>唯一可靠的位置：步骤 ③ 和 ④ 之间的那个缝。</b>' +
                   '<b>做法是事件驱动而不是轮询</b>：hook <code>mprotect</code> / <code>mmap</code>，' +
                   '当出现"申请 RWX"或"把内存改成可执行"时立刻捕获——<b>在那一刻 dump 这块内存，或者在它的入口下断点。</b><br>' +
                   '<span class="bad">但是：</span><code>mprotect</code> 也是 libc 函数。' +
                   '如果对手连 <code>mprotect</code> 都用内联 SVC 绕过——你就又回到 27.4 节的决策表了，' +
                   '必须上内核侧监控内存权限变化。<b>这就是本章技术环环相扣的地方：每个用户态方案都有一个"对手再进一步"的边界。</b>' }
         ]
       },

       after:
         T.note('warn', '⚠️ 就算你 dump 到了，也别高兴太早',
           '<p>假设你完美地在窗口期内 dump 到了这块内存。<b>接下来还有一个更隐蔽的障碍：</b></p>' +
           '<p>这段代码里的函数地址是<b>运行时才确定的</b>——它可能指向刚才 mmap 出来的那块内存里的某个偏移，' +
           '也可能指向 so 里某个函数的当前加载地址。这些地址<b>在你的 dump 文件里是一堆具体的数值</b>，' +
           '但静态分析工具无法把它们和你磁盘上的 so 对应起来。<b>引用关系建立不起来，反汇编出来的就是一片跳来跳去的裸地址。</b></p>' +
           '<p><b>所以正确的做法是在 dump 的同时记录上下文：</b>这块内存的基址、当时进程里所有模块的加载地址。' +
           '有了这两样，你才能把 dump 里的地址重新映射回符号。<b>只存一个 bin 文件，等于存了一堆无主地址。</b></p>') +
         T.note('ok', '✅ 这对逆向实战有什么用',
           '<p>记住这条判据：<b>当你发现"关键行为找不到对应的代码"时，第一反应应该是去查内存权限变化，而不是继续翻 so。</b></p>' +
           '<p>具体动作：① hook <code>mprotect</code>/<code>mmap</code>，过滤出带 <code>PROT_EXEC</code> 的调用；' +
           '② 命中时立刻 dump 内存并记录模块基址；③ 如果 <code>mprotect</code> 本身也被绕过了，' +
           '说明对手成熟度很高，直接考虑内核侧。</p>')
     },

     /* ================= 27.8 ================= */
     {
       h: '27.8',
       title: '决策演练 · 抓到一次 mprotect，然后呢',
       html: '<p>你按 27.7 的做法挂上了 <code>mprotect</code>，现在它响了。考验的是你接下来三十秒内的动作。</p>',
       decision: {
         start: 'n0',
         nodes: {
           n0: {
             label: '情境二 · 窗口期只有一个回调的时间',
             scenario: '<b>情境：</b>你 hook 了 <code>mprotect</code>，过滤 <code>PROT_EXEC</code>。某次调用命中了：' +
                       '目标把一块 0x2000 字节的匿名内存改成了 <code>PROT_READ|PROT_WRITE|PROT_EXEC</code>。' +
                       '你的回调此刻正在执行。你知道这块内存马上会被跳进去执行，执行完可能就被 <code>munmap</code> 了。' +
                       '<b>你的回调里做什么，决定了这次分析能不能拿到东西。</b>',
             choices: [
               { t: 'A. 在回调里先 dump 这块内存，再跳到目标函数入口，把所有线程状态和调用栈打印出来', next: 'na' },
               { t: 'B. 在回调里 dump 这块内存，并立刻记录当时进程里所有模块的加载基址，然后返回', next: 'nb' },
               { t: 'C. 在回调里改掉内存权限，把 <code>PROT_EXEC</code> 去掉，逼它自己去改回来，从而制造更多观测机会', next: 'nc' },
               { t: 'D. 回调里什么都不做，只记一条日志，等它执行完再回头 dump 内存做静态分析', next: 'nd' }
             ]
           },
           na: {
             label: '选 A', terminal: true, verdict: 'bad',
             verdictTitle: '方向对了一半，但动作太重',
             result: '<b>dump 部分是对的，后面的全是危险的。</b><br>' +
                     '<b>认知根源：把"这是个难得的机会"理解成"我要趁这个机会把能拿的都拿了"。</b>' +
                     '但你此刻正站在目标的执行流中间——<b>回调一返回，它马上就要跳进那块内存执行了。</b><br>' +
                     '<b>跳出目标函数入口、遍历所有线程、打调用栈，这些都是重操作。</b>' +
                     '它们会：① 消耗大量时间，<b>窗口期可能就在你打印栈的时候关闭了</b>；' +
                     '② 触发大量内存分配和系统调用，<b>明显扰动目标进程</b>；' +
                     '③ 如果目标是多线程的，你的打印可能卡住其他线程，导致行为异常甚至死锁。<br>' +
                     '<b>更关键的是：你把"取证"和"分析"混在了同一个窗口里。</b>' +
                     '正确的分工是——<b>窗口期内只做最小必要的固化动作（dump + 记录上下文），分析放到窗口关闭之后慢慢做。</b>' },
           nb: {
             label: '选 B', terminal: true, verdict: 'good',
             verdictTitle: '正确：窗口内只固化，不分析',
             result: '<b>这是唯一能在几十毫秒里做完、又不干扰目标的方案。</b><br>' +
                     '<b>为什么必须同时记录模块基址：</b>这是 27.7 节末尾强调过的那个坑。' +
                     'dump 出来的代码里全是<b>裸地址</b>——某个 <code>bl 0x7a3c1d20</code>。' +
                     '如果不知道当时 <code>libtarget.so</code> 加载在 <code>0x7a3c1000</code>，' +
                     '你永远无法把这个地址换算回符号。<b>内存 dump 和模块基址必须成对记录，缺一个这份 dump 就是废纸。</b><br>' +
                     '<b>动作清单（按顺序，越短越好）：</b>① <code>Memory.readByteArray</code> 把这块内存整块读走，' +
                     '立刻落盘或发到主机；② <code>Process.enumerateModules()</code> 记录每个模块的 name/base/size；' +
                     '③ 记录这次 <code>mprotect</code> 的调用栈（<code>Thread.backtrace</code>）——' +
                     '这一步轻量而且极其有用，<b>它会告诉你"是谁申请了这块 RWX"</b>；④ 返回，不要做别的事。<br>' +
                     '<b>事后分析</b>：把 dump 文件按记录的基址做地址重定位，再交给 IDA 反汇编。' +
                     '如果这块内存里有指向目标 so 的调用，重定位之后就都能正确解析成符号了。<br>' +
                     '<span class="hit">核心原则：窗口期内只做"快照"，不做"解读"。</span>' },
           nc: {
             label: '选 C', terminal: true, verdict: 'bad',
             verdictTitle: '反直觉：技术上很聪明，实战上会打草惊蛇',
             result: '<b>这个思路确实很巧——人为制造更多观测机会，看起来很聪明。</b>但它违反了一条更根本的原则。<br>' +
                     '<b>认知根源：把"观测"和"干预"混为一谈。</b>' +
                     '你现在的身份是<b>观察者</b>，目标是"看清楚它做什么"。' +
                     '而改内存权限是<b>主动干预</b>——你改变了目标的运行环境。<br>' +
                     '<b>后果有三层：</b><br>' +
                     '① <b>目标可能直接崩溃或走异常分支</b>：它跳进那块内存时如果权限已被去掉，会触发段错误；' +
                     '如果它有信号处理，会走进你完全没预期的错误路径。<br>' +
                     '② <b>这会暴露你</b>：一个成熟的对抗目标会检查自己刚设置好的权限是否被改动过。' +
                     '<b>你为了多看一眼，主动留下了一个可被检测的痕迹。</b><br>' +
                     '③ <b>它不会"自己去改回来"</b>——更可能的结果是它再也不走这条路了，或者直接判定环境异常退出。' +
                     '<b>你用一次性的情报换掉了长期的观测能力。</b><br>' +
                     '<b>正确做法：</b>观察者先做观察者的事。要干预，也应该在理解清楚行为之后，' +
                     '用硬件断点这种<b>不留痕迹</b>的方式（见 27.11 节）。' },
           nd: {
             label: '选 D', terminal: true, verdict: 'bad',
             verdictTitle: '方向错了：等你想看的时候，它已经没了',
             result: '<b>这个选项的错误最直接，但也最常发生——因为它"省事"。</b><br>' +
                     '<b>认知根源：把动态的东西当静态的东西处理。</b>' +
                     '你在潜意识里假设"这块内存会一直在那儿"，所以可以"回头再看"。' +
                     '但 27.7 节的时间轴已经说得很清楚了：<b>执行完就是 <code>munmap</code>，或者权限改回去。</b><br>' +
                     '<b>具体后果：</b>回调返回 → 目标跳进去执行 → 执行完释放 → 你这边"回头"去 dump → ' +
                     '<b>那块地址上要么是未映射区域（读会报错），要么已经被别的分配复用，内容面目全非。</b>' +
                     '你得到的是一个空结果，而且<b>你甚至不知道自己错过了——日志里只有一行默默无闻的记录。</b><br>' +
                     '<b>这是动态分析里最阴险的一类失败：不是报错，而是静默地拿到错误结论。</b>' +
                     '你会以为自己"看过了，没有问题"，从而做出完全错误的判断。<br>' +
                     '<b>正确做法：</b>观测动作必须发生在事件发生的<b>当下</b>，而不是之后。' +
                     '这也是为什么 27.7 节强调要用 <b>hook（事件驱动）</b>而不是<b>轮询扫描</b>——' +
                     '轮询同样是在"之后"才去看。'
           }
         }
       }
     },

     /* ================= 27.9 ================= */
     {
       h: '27.9',
       title: 'JNI 函数地址防追踪：一份会过期的地图',
       html:
         '<p>再换一个对手。这次它不藏代码，它藏的是<b>代码和 Java 方法之间的对应关系</b>。</p>' +
         '<p><b>常规做法</b>很简单：在 <code>JNI_OnLoad</code> 里一次性调用 <code>RegisterNatives</code>，' +
         '把所有 native 方法一次性注册完。</p>' +
         '<p>这对你来说简直是礼物——<span class="hit">只要 hook <code>RegisterNatives</code>，' +
         '所有"Java 方法名 → Native 函数地址"的映射一次全部到手。</span></p>' +
         '<p>所以成熟的对抗目标不会这么做。它会让这份地图<b>一直变</b>。</p>' +
         T.tbl(['防追踪手法', '做法', '对你的影响'], [
           ['① 延迟注册', '不在 <code>JNI_OnLoad</code> 注册，真正要用到某个方法时才注册',
            '你 hook <code>RegisterNatives</code> 时可能只看到一部分，剩下的在你收工之后才出现'],
           ['② 分次注册', '把方法拆成多批，分散在不同时机（不同页面、不同功能触发时）注册',
            '任何单次观测都只能拿到<b>快照的一部分</b>'],
           ['③ 动态计算地址', '函数地址运行时才算出来（如"基址 + 运行时推导的偏移"），甚至指向动态释放的内存',
            '你看到的地址在下一次运行时<b>未必相同</b>，写进脚本会失效'],
           ['④ 反复注册/注销', '<code>UnregisterNatives</code> 后再重新 <code>RegisterNatives</code>，让映射不断变化',
            '<b>你在某个时刻抓到的映射，过一会儿就失效了</b>'],
           ['⑤ 不走标准路径', '利用 ART 内部特性（例如直接改 <code>ArtMethod</code> 的入口）来绑定，绕过 <code>RegisterNatives</code>',
            '<span class="bad">hook <code>RegisterNatives</code> 直接零命中</span>']
         ]) +
         '<p><b>这五种手法的共同效果是：你手里的那份映射表有保质期。</b>' +
         '你可能在启动时抓到了一份完整的表，看起来很漂亮——但等 App 真正开始跑业务逻辑，' +
         '方法入口已经被换过好几轮了。你按旧表去下断点，<b>断点打在一个已经不再被调用的地址上</b>。</p>' +
         '<p class="small muted">第 ⑤ 种最狠：它根本不产生 <code>RegisterNatives</code> 调用，' +
         '你在 libc / libart 层面的所有 hook 都看不见这次绑定。<b>要观测它，就得在 ART 内部"方法入口被写入"的那个位置下手</b>——' +
         '这又回到了硬件断点。</p>',

       intuition: {
         tag: '直觉模型 · 会换岗的哨兵',
         body:
           '<p>你拿到一份哨兵换岗表，上面写着「三号岗亭：张三」。你打算去三号岗亭找他。</p>' +
           '<p>但对方每小时换一次岗，而且<b>换岗记录不公开</b>。你手里的表在拿到的那一刻就过期了。' +
           '你跑到三号岗亭，站在那儿的可能是李四，也可能根本没人。</p>' +
           '<p><b>传统做法的问题就在这：你想先拿到一份"完整的地图"，再去行动。</b>' +
           '而对手的全部策略就是让"完整的地图"这个东西不存在。</p>' +
           '<p><b>破法不是去拿一份更全的地图，而是改变策略：</b>不再问"张三在哪"，' +
           '而是<b>在岗亭门上装一个传感器</b>——不管谁被派过来，进门的那一刻你都会知道。' +
           '这就是 27.11 节硬件断点的思路：<b>不追踪地址，追踪"地址被写入"这个事件本身。</b></p>'
       },

       after:
         T.note('key', '🔑 从"追踪地址"到"追踪事件"',
           '<p>JNI 地址防追踪的所有手法，本质上都在做同一件事：<b>让"地址"这个快照失去意义。</b></p>' +
           '<p>所以你的应对也不应该是"更频繁地抓快照"（那是和他拼手速，你会输），' +
           '而是<b>转换观测对象</b>：不去记录"方法指向哪里"，而是记录<b>"方法入口在什么时候被谁改成了什么"</b>。</p>' +
           '<p>这个转换之后，对手换多少次岗都无所谓——<b>每一次换岗都会触发你的观测点。</b>' +
           '具体实现就是下一节的硬件断点：在"入口被写入"的那个指令位置布点，' +
           '捕获每一次绑定发生的瞬间。</p>' +
           '<p><span class="pill warn">ART 内部具体哪个结构、哪个函数负责入口写入，随 Android 版本差异较大，待核实；' +
           '实战中以目标版本的实际代码为准</span></p>')
     },

     /* ================= 27.10 ================= */
     {
       h: '27.10',
       title: '决策演练 · 一张过期的 JNI 映射表',
       html: '<p>你拿到了一份漂亮的地图，但它正在失效。这时候的选择最能体现你有没有建立"事件思维"。</p>',
       decision: {
         start: 'n0',
         nodes: {
           n0: {
             label: '情境三 · 断点打在了空地址上',
             scenario: '<b>情境：</b>你在 <code>JNI_OnLoad</code> 之后 hook 到了 <code>RegisterNatives</code>，' +
                       '拿到了 12 个 native 方法的完整映射表，包括你最关心的那个校验函数。' +
                       '你在校验函数的地址上下了一个软件断点（改首字节为 <code>BRK</code>）。' +
                       '<b>结果：App 跑完了整个流程，这个断点一次都没命中，而且 App 表现完全正常。</b>' +
                       '你确认过那个 Java 方法确实被调用了（在 Java 层 hook 能看到）。',
             choices: [
               { t: 'A. 断点肯定被反调试清掉了，改用 Frida 的 <code>Interceptor.attach</code> 换一种 hook 方式再试', next: 'na' },
               { t: 'B. 怀疑地址过期：持续监控方法入口的变化，或在"入口被写入"的位置布硬件断点', next: 'nb' },
               { t: 'C. 把 <code>RegisterNatives</code> 的 hook 做得更早更全，确保 12 个方法一个不漏地抓到', next: 'nc' },
               { t: 'D. Java 层 hook 已经能看到调用了，干脆放弃 native 层，就在 Java 层做分析', next: 'nd' }
             ]
           },
           na: {
             label: '选 A', terminal: true, verdict: 'bad',
             verdictTitle: '方向错了：改了手法，没改观测对象',
             result: '<b>这是最常见的条件反射：断点没命中 → 一定是被检测了 → 换个更隐蔽的 hook 方式。</b><br>' +
                     '<b>认知根源：把"没命中"一律归因为"被检测"。</b>' +
                     '但在本章的语境下，"没命中"有<b>两种</b>截然不同的原因：' +
                     '① 你的痕迹被发现了（工具问题）；② <b>你观测的那个地址已经不再被使用了（模型问题）</b>。<br>' +
                     '<b>题干给了你一个决定性的线索：App 表现完全正常。</b>' +
                     '如果它检测到了你改写的 <code>BRK</code> 指令，正常反应是<b>崩溃、退出、或者走错误分支</b>——' +
                     '而不是若无其事地跑完。<b>"什么都没发生"恰恰说明它根本没有读到你的断点。</b><br>' +
                     '而且注意：<code>Interceptor.attach</code> 同样是把 hook 挂在<b>某个具体地址</b>上。' +
                     '如果那个地址本身已经失效，换什么 hook 技术都是在给一个空房子装摄像头。<br>' +
                     '<b>正确做法：</b>先验证"这个地址现在还有没有人用"。' },
           nb: {
             label: '选 B', terminal: true, verdict: 'good',
             verdictTitle: '正确：把观测对象从「地址」换成「事件」',
             result: '<b>你识破了这道题的核心：对手不是在躲你，而是在让地址本身变得不可靠。</b><br>' +
                     '<b>为什么这才对：</b>回顾 27.9 节的五种手法——延迟注册、分次注册、动态计算地址、反复注册注销、绕过标准路径。' +
                     '它们的共同效果就是<b>让"启动那一刻的映射表"迅速过期</b>。' +
                     '你在 <code>JNI_OnLoad</code> 之后抓的那份表，很可能在 App 初始化完成的瞬间就已经被换掉了。<br>' +
                     '<b>具体怎么做：</b><br>' +
                     '① <b>先验证假设</b>——读一下那个地址处的内存，看看它现在是什么内容。' +
                     '如果入口指令和你预期的不一样（比如是一段跳转桩，或者干脆是被回收的内存），就证实了地址已失效。<br>' +
                     '② <b>监控入口变化</b>——对保存方法入口的那个内存位置下<b>观察点</b>（Watchpoint）。' +
                     '这样每次有代码往里面写新地址，你都会收到通知，<b>拿到的是最新鲜的映射，而不是过期的快照</b>。<br>' +
                     '③ <b>用硬件断点</b>——因为对手很可能同时在做自校验（它既然会动态换入口，' +
                     '大概率也会检查代码段有没有被改），<b>软件断点会改内存，硬件断点不会</b>。' +
                     '<span class="hit">这一步直接指向了 27.11 节。</span><br>' +
                     '<b>这个思路的通用性：</b>不只是 JNI 地址，对动态释放代码、对任何"会变的地址"都适用。' +
                     '<b>当快照不可靠时，就改为订阅变更事件。</b>' },
           nc: {
             label: '选 C', terminal: true, verdict: 'bad',
             verdictTitle: '方向错了：在错误的维度上追求完备',
             result: '<b>这个选项听起来很专业——"更早、更全"，谁能说不对？</b>但它解决的是一个不存在的问题。<br>' +
                     '<b>认知根源：把问题诊断成"采样覆盖率不足"，而实际问题是"采样时机无效"。</b><br>' +
                     '注意题干的细节：<b>你已经抓到了那个方法的地址</b>。你的问题不是漏抓，' +
                     '而是<b>抓到的那个地址在之后失效了</b>。把 hook 挪得更早、覆盖得更全，' +
                     '只会让你拿到一份<b>更早、更完整、但同样会过期</b>的表。<br>' +
                     '<b>举一个具体的反例：</b>假设对手在 <code>JNI_OnLoad</code> 里先注册 12 个方法（让你抓到），' +
                     '然后在初始化完成后用 <code>UnregisterNatives</code> 全部注销，再在真正使用前重新注册一批新地址。' +
                     '<b>你抓得再早再全，抓到的都是那批"故意给你看的"地址。</b><br>' +
                     '<b>这类设计的阴险之处：</b>它专门迎合"抓得越早越好"这个直觉，' +
                     '用一份完美而虚假的地图换取你的信任。<br>' +
                     '<b>正确做法：</b>不要追求"一次性抓全"，要建立<b>持续观测</b>——' +
                     '关注映射在时间上的<b>变化</b>，而不是某一时刻的<b>状态</b>。' },
           nd: {
             label: '选 D', terminal: true, verdict: 'bad',
             verdictTitle: '反直觉：能看到调用，不等于看到了行为',
             result: '<b>这个选项在"够用就行"的标准下甚至算合理——Java 层确实能看到方法被调用了。</b>' +
                     '但你会失去这一章全部的意义。<br>' +
                     '<b>认知根源：把"调用发生了"当成"我知道它做了什么"。</b><br>' +
                     'Java 层 hook 能告诉你：<b>哪个 Java 方法在什么时候被调用了、参数是什么。</b>' +
                     '它<b>不能</b>告诉你：<br>' +
                     '① 这个 native 方法<b>内部</b>做了什么——它可能只是入口，真正的核心逻辑在更深的 native 层；<br>' +
                     '② 它有没有用<b>内联 SVC</b> 去做一些不方便让你看到的事（比如读 <code>/proc/self/maps</code> 做环境检测）——' +
                     '<b>这正是本章 27.1 节的那个场景</b>；<br>' +
                     '③ 它有没有<b>动态释放代码</b>并跳进去执行（27.7 节）；<br>' +
                     '④ 它的地址在运行过程中被换成了什么。<br>' +
                     '<b>而这一章里，最难对付的行为恰恰全都藏在这些看不见的地方。</b>' +
                     'Java 层是一个舒适的观测点，但舒适本身就是个信号——<b>对手最不希望你看的地方，才是你最该看的地方。</b><br>' +
                     '<b>正确做法：</b>Java 层可以作为<b>入口和索引</b>（用来看"什么时候该关注了"），' +
                     '但分析必须下到 native 层，并且用能应对地址变化的手段。'
           }
         }
       }
     },
     /* ================= 27.11 ================= */
     {
       h: '27.11',
       title: '硬件断点：不碰内存的观测方式',
       html:
         '<p>前面几节反复指向同一个结论：<b>你的观测动作本身会被发现。</b>' +
         '改内存会被校验，加 hook 会被扫描，而地址还会变。所以最后我们来看这一章最有力的一件工具。</p>' +
         '<p>ARM 处理器提供两类硬件调试设施：' + T.term('硬件断点', '由 CPU 调试寄存器实现的断点，地址匹配在 CPU 内部完成，不修改目标内存的任何一个字节') +
         '（Breakpoint）和' + T.term('观察点', 'Watchpoint，对某个内存地址的读写操作进行匹配，同样由调试寄存器实现，不修改内存') + '（Watchpoint）。</p>' +
         '<p>它们和传统软件断点的根本区别，用一句话就能说清：</p>' +
         T.note('key', '🔑 决定性优势：一个字节都不改',
           '<p>' + T.term('软件断点', '把目标地址处的指令替换成一条断点指令（ARM 上如 BRK）来实现的断点——它必须改写目标内存') + '必须<b>把目标地址的指令改成断点指令</b>。' +
           '这意味着目标内存<b>被改动了</b>。</p>' +
           '<p>而硬件断点完全在 CPU 内部完成地址匹配，<b>目标内存一个字节都不变</b>。</p>' +
           '<p><b>这一条差异，直接决定了它能绕过所有"检测内存改写"的反调试手段</b>：</p>' +
           '<p>校验代码段校验和 → <span class="hit">通过</span>；' +
           '检查函数开头是否有断点指令 → <span class="hit">通过</span>；' +
           '扫描内存找 hook 痕迹 → <span class="hit">通过</span>。</p>') +
         '<p>下面这张表是选型时的核心参考。注意最后两行——硬件断点不是"更好"，而是<b>另一种权衡</b>。</p>' +
         T.tbl(['维度', '软件断点', '硬件断点'], [
           ['是否修改目标内存', '<span class="bad">必须修改</span>（写入断点指令）', '<span class="hit">完全不修改</span>'],
           ['能否被检测', '<span class="bad">能</span>：校验和、首字节检查、内存扫描都能发现', '<span class="hit">常规手段无法检测</span>'],
           ['数量限制', '几乎无限，可以大规模布点', '<span class="miss">很有限，ARM 上通常只有 4-6 个</span>'],
           ['实现依赖', '只需能写目标内存', '需要调试器或内核支持调试寄存器'],
           ['命中时的现场', '控制权交给你，可任意读写寄存器与内存', '同样能拿到现场，但要注意数量与开销'],
           ['适用场景', '目标无自校验、需要大量布点时', '目标有自校验、需要隐蔽观测、或地址会变时']
         ]) +
         '<p><b>怎么用硬件断点捕获 JNI 地址？</b>三条实战思路：</p>' +
         '<p><b>① 在 <code>RegisterNatives</code> 的函数地址下硬件断点</b>（不修改它的代码）——' +
         '捕获每一次注册调用，拿到当时传进来的方法名与函数指针。<b>因为它不改内存，目标的代码段自校验查不出问题。</b></p>' +
         '<p><b>② 监控动态释放代码的那块内存</b>（在关键地址下观察点）——' +
         '关注它什么时候被写入、什么时候被执行，从而在 27.7 节那个窗口期里精确介入。</p>' +
         '<p><b>③ 在 ART 内部"方法入口被写入"的位置下断点</b>——' +
         '捕获地址绑定发生的瞬间。这是对付 27.9 节第 ⑤ 种手法（绕过 <code>RegisterNatives</code>）的关键思路：' +
         '<b>不管走哪条路径绑定，最终都要往方法入口里写一个地址</b>，你盯住那个写入动作就行。</p>' +
         '<p class="small muted">调试寄存器方面：AArch64 上断点地址与控制寄存器形如 <code>DBGBVR&lt;n&gt;_EL1</code> / ' +
         '<code>DBGBCR&lt;n&gt;_EL1</code>，观察点形如 <code>DBGWVR&lt;n&gt;_EL1</code> / <code>DBGWCR&lt;n&gt;_EL1</code>，' +
         '并可通过 <code>DBGDRAR</code> / <code>DBGDTR</code> 一类的寄存器访问。' +
         '<span class="pill warn">具体寄存器名与编号上限待核实，请以目标架构的 ARM 手册为准</span></p>',

       after:
         T.note('warn', '⚠️ 限制决定了方法论',
           '<p>硬件断点<b>只有 4-6 个名额</b>。这不是一个小限制，它从根本上改变了你的工作方式：</p>' +
           '<p><b>你不能再"先大量布点，再看哪个命中"。</b>软件断点时代那种"在 50 个可疑地址上都下一遍"的粗放做法彻底不可用了。' +
           '你必须先<b>理解目标的行为</b>，才能选出那 4 个最值得观测的位置。</p>' +
           '<p><b>所以：工具的能力上限，变成了你分析能力的上限。</b>' +
           '硬件断点不是"更省事的方案"，而是"更考验判断力的方案"——' +
           '这也是为什么这一章前面花了那么多篇幅讲清楚 SVC 路径、内存释放时序和 JNI 注册流程：' +
           '<b>没有这些理解，你根本不知道该把仅有的几个名额放在哪。</b></p>') +
         T.note('ok', '✅ 回顾：三种追踪方法在硬件断点这里汇合',
           '<p>回到 27.4 节的决策表——第三种方法"陷入入口 / 硬件断点"用的就是这套机制。' +
           '而在实战中，它常常是<b>和第二种方法配合使用</b>的：</p>' +
           '<p><b>② 静态扫描负责"找候选"</b>（把所有 SVC 地址列出来，成本低、可以全量）→ ' +
           '<b>③ 硬件断点负责"精确定点"</b>（从候选里挑出最关键的几个，成本高但不可检测）。</p>' +
           '<p>这正是 27.4 节结论"三者是能力递进关系，不是互相替代"的具体体现。' +
           '<b>把它们组合起来用，而不是二选一。</b></p>')
     },

     /* ================= 27.12 ================= */
     {
       h: '27.12',
       title: '0r0env 调试 ROM：把这些能力打包成环境',
       html:
         '<p>到这里，本章的技术点已经铺满了：SVC 路径、三种追踪方法、内存动态释放、JNI 地址防追踪、硬件断点。' +
         '但你大概已经注意到一个问题——<b>这些东西里有相当一部分需要内核层能力才能用。</b></p>' +
         '<p>编译内核模块、定制内核、刷机、配置调试寄存器……每一步都有门槛，而且<b>任一步出错都可能把设备变成砖头</b>。' +
         '如果每次分析一个新目标都要重新走一遍这套流程，效率会低到无法接受。</p>' +
         '<p>' + T.term('0r0env 调试 ROM', '课程作者提供的整套定制调试环境（定制 ROM / 内核），把内核级对抗能力打包成开箱即用的工具') +
         '就是为解决这个问题而存在的：它把这一章涉及的<b>内核级对抗能力</b>——' +
         'syscall 表 hook、硬件断点支持、反检测绕过——预先集成到一个可以直接刷入的定制环境里。</p>' +
         T.note('warn', '⚠️ 关于 0r0env 的说明，请务必读这一条',
           '<p><b>本节不提供具体的技术细节。</b>0r0env 是作者维护的具体产品/环境，' +
           '它的功能范围、支持的机型、内核版本、使用方式、命令接口，<b>都会随作者发布而变化</b>。</p>' +
           '<p>任何我这里写下来的"具体功能清单"，都可能在你看到的时候已经过时，或者从一开始就是我的推测。' +
           '<b>本章不编造这部分内容。</b></p>' +
           '<p><b>请以作者实际发布的文档与版本说明为准。</b>' +
           '<span class="pill warn">0r0env 的具体内容、支持范围与使用方式：待核实，以作者发布为准</span></p>') +
         '<p><b>你应该从这一节带走的，是一个方法论判断：</b></p>' +
         T.grid(2, [
           '<div class="card"><div class="card-title">为什么要用现成环境</div>' +
           '<p>本章的三种追踪方法里，<b>方法①（内核 syscall 表 hook）和方法③的内核侧部分</b>都需要定制内核。' +
           '自己从零搭建意味着：找内核源码 → 配编译环境 → 改代码 → 编译 → 刷入 → 调试 → 失败重来。</p>' +
           '<p><b>这条路上的大部分时间花在环境上，而不是花在分析目标上。</b>而对于以"分析目标"为目的的逆向工作来说，' +
           '这部分投入的边际收益很低。</p></div>',

           '<div class="card"><div class="card-title">但要清楚它的边界</div>' +
           '<p>现成环境降低的是<b>搭建成本</b>，不是<b>理解成本</b>。刷完之后，' +
           '你依然需要知道：syscall 表在哪、硬件断点的名额怎么分配、该在哪个位置布点。</p>' +
           '<p><b>如果跳过前面几节直接上手工具，你会得到一个"能跑但不知道在看什么"的黑盒</b>——' +
           '看到一堆系统调用流水，却认不出哪一条是目标在读 <code>/proc/self/maps</code>。</p>' +
           '<p><b>工具解决"能不能观测"，本章前面几节解决"该观测什么"。</b></p></div>'
         ]),

       after:
         T.note('key', '🔑 这一章真正要你带走的',
           '<p>把全章压缩成三句话：</p>' +
           '<p><b>① 观测点必须高于对手的绕过点。</b>' +
           '对手在用户态内联 <code>SVC</code>，你就不能在 libc 层等它。理解 <code>SVC</code> 的两条路径，是一切的起点。</p>' +
           '<p><b>② 没有万能的方案，只有分层的决策。</b>' +
           '静态扫描最容易但最易被绕过；硬件断点最隐蔽但只有几个名额；内核 hook 最彻底但门槛最高。' +
           '<b>按目标的反检测强度选层级，而不是按自己的熟练度。</b></p>' +
           '<p><b>③ 当快照不可靠时，改为订阅事件。</b>' +
           '这一条贯穿了内存动态释放（不要轮询扫描，要 hook <code>mprotect</code>）和 JNI 地址防追踪（不要抓一次映射表，要监控入口写入）。' +
           '<b>这是本章最可迁移的一条思维模型。</b></p>')
     },

     /* ================= 27.13 ================= */
     {
       h: '27.13',
       title: '自测 · SVC 与观测层',
       html: '<p>先检验最基础的两件事：寄存器约定和观测层的选择。</p>' +
             '<p class="small muted">提示：下面两题分别对应 27.3 节的硬件事实和 27.1 节的诊断顺序。</p>',
       quiz: {
         id: 'q13-1', chapter: 13, answer: 2,
         stem: '关于 AArch64 上内联 <code>SVC</code> 发起系统调用，下列哪一项描述是<b>正确</b>的？',
         options: [
           { t: '系统调用号放在 <code>r7</code>，参数放在 <code>r0</code>-<code>r6</code>',
             why: '这是 <b>ARM32 (EABI)</b> 的约定。AArch64 用的是 <code>x8</code>，参数是 <code>x0</code>-<code>x5</code>。' +
                  '把 32 位的约定套到 64 位上，是跨架构分析中最常见的错误之一。' },
           { t: 'AArch64 上 <code>SVC</code> 的指令编码是 <code>0xEF000000</code>',
             why: '<code>0xEF000000</code> 是 <b>ARM32</b> 的 <code>SVC #0</code> 编码。AArch64 的是 <code>0xD4000001</code>。' +
                  '写扫描器时如果用错编码，结果是<b>一条都扫不到</b>——而且不会报错。' },
           { t: '系统调用号放在 <code>x8</code>，返回值放在 <code>x0</code>，且没有独立的 <code>open</code> 而要用 <code>openat</code>',
             why: '正确。AArch64 的约定是 <code>x8</code> 存系统调用号、<code>x0</code>-<code>x5</code> 传参数、<code>x0</code> 存返回值。' +
                  '同时 AArch64 上没有独立的 <code>open</code> 系统调用，只有 <code>openat</code>——' +
                  '所以不只是换个寄存器，<b>参数顺序也变了</b>（<code>dirfd</code> 占用了 <code>x0</code>，路径挪到 <code>x1</code>）。' },
           { t: '内联 SVC 成功后需要读取 <code>errno</code> 才能判断结果',
             why: '不需要。内联 SVC 拿到的是<b>内核原始返回值</b>：成功是文件描述符，失败是<b>负的错误码</b>。' +
                  '<code>errno</code> 是 libc 封装层引入的中间层——它负责把负值翻译成 <code>-1</code> 并写 <code>errno</code>。' +
                  '内联 SVC 绕过了这一层，所以它自己判断负数。' }
         ],
         explain: '<b>把两台机器的约定并排记住：</b>参数都从第 0 号寄存器往上排；' +
                  '系统调用号 <b>ARM32 用 r7 / AArch64 用 x8</b>；返回值都是第 0 号寄存器。' +
                  '<b>指令编码是稳定的常量</b>（<code>0xEF000000</code> / <code>0xD4000001</code>，由 ARM 架构规范定义），' +
                  '可以放心硬编码进扫描器；而<b>系统调用号是内核 ABI 的一部分，会随架构与版本变化</b>，实战要以目标头文件为准。' +
                  '还有一条隐藏差异：<b>AArch64 只有 <code>openat</code> 没有 <code>open</code></b>，参数布局随之改变。'
       }
     },

     /* ================= 27.14 ================= */
     {
       h: '27.14',
       title: '自测 · 观测与反观测',
       html: '<p>再检验三件事：为什么 libc hook 会失效、动态释放代码怎么抓、硬件断点强在哪。</p>',
       quiz: {
         id: 'q13-2', chapter: 13, answer: [0, 2],
         stem: '一个 App 通过 <b>内联 SVC 直接发起系统调用</b>（不经过任何 libc 封装函数）来读取 <code>/proc/self/maps</code>。' +
               '关于这时 Frida 的能力边界，下列哪些说法是<b>正确</b>的？<span class="small muted">（多选）</span>',
         options: [
           { t: '挂在 libc <code>open</code> / <code>openat</code> 上的 <code>Interceptor.attach</code> 会完全失效',
             why: '正确。这些 hook 挂在 libc 导出函数的入口上，而内联 SVC 的代码路径<b>根本不进入 libc</b>。' +
                  '这不是工具故障，而是观测层被整个跳过——两条路径只在 <code>svc</code> 之后的<b>内核侧</b>才汇合。' },
           { t: '只要改用 <code>Interceptor.attach</code> 挂到 <code>syscall</code> 这个 libc 通用转发函数上就能捕获',
             why: '不能。这个思路的错误在于<b>仍然待在同一个层级</b>。' +
                  '如果对手压根没进入 libc，那么 libc 里的任何函数——包括 <code>syscall()</code> 这个通用入口——都不会被调用。' +
                  '这恰恰是判断"是不是覆盖率问题"的好探针：<b>连 <code>syscall()</code> 都没命中，说明问题在层级而不在覆盖面。</b>' },
           { t: '这些系统调用最终还是会在内核的 syscall 分发表上出现，这是无法被用户态绕过的汇聚点',
             why: '正确。<b>这是本章最重要的结构性事实。</b>不管发起者是 libc 还是 App 自己写的内联指令，' +
                  'CPU 都会陷入 EL1、由异常向量表接管、按系统调用号查同一张分发表。' +
                  '这也是"内核模块"方案能力上限最高的原因——它是唯一<b>无法被用户态绕过</b>的观测点。' },
           { t: '可以用 <code>Memory.scan</code> 搜 <code>0xEF000000</code> 稳定地找到所有这类调用点',
             why: '不稳定，有两个问题。① <b>编码要对架构</b>：<code>0xEF000000</code> 是 ARM32，AArch64 要用 <code>0xD4000001</code>，' +
                  '而且要注意小端存储的字节序。② <b>动态生成的代码扫不到</b>：如果这段代码是运行时解密到可执行内存的（27.7 节），' +
                  '静态扫描时它根本不存在。此外数据段还可能有误报。' }
         ],
         explain: '<b>这道题的核心是"层级"概念。</b>观测点放在用户态的某一层，就一定存在"对手不走这一层"的可能。' +
                  '唯一的例外是<b>内核的 syscall 分发表</b>——它是所有系统调用的必经之路，' +
                  '所以它无法被绕过，代价是需要内核能力。<br>' +
                  '<b>记住那个诊断探针：</b>挂 <code>syscall()</code>。它没命中，就说明对手已经下到比你更低的层了。'
       }
     },

     /* ================= 27.15 ================= */
     {
       h: '27.15',
       title: '自测 · 硬件断点与动态释放',
       html: '<p>最后两题，检验本章最有迁移价值的两条判断。</p>',
       quiz: {
         id: 'q13-3', chapter: 13, answer: 1,
         stem: '目标 App 会校验自身代码段的校验和，并且会检查关键函数开头是否被写入了断点指令。' +
               '你想在它的一个 native 函数上设置断点做分析。下列做法中，<b>最可能有效</b>的是？',
         options: [
           { t: '用软件断点，但每次校验前临时恢复正常字节，校验完再写回',
             why: '这是典型的"猫鼠游戏"做法，在实战中很脆弱：你需要<b>准确知道校验发生的每一次时机</b>，' +
                  '漏掉任何一次（比如某个你没想到的后台线程触发的校验）就会暴露。' +
                  '而且"恢复—写回"这个动作本身在内存里制造了可被观测的时间窗口。' },
           { t: '用硬件断点：地址匹配在 CPU 内部完成，目标内存一个字节都不变',
             why: '正确。<b>硬件断点由 CPU 调试寄存器实现，不修改目标内存</b>，' +
                  '所以校验代码段校验和 → 通过；检查函数开头是否有断点指令 → 通过；扫描内存找 hook 痕迹 → 通过。' +
                  '这是"不修改内存"这个特性的直接推论。<span class="miss">代价是数量有限（ARM 上通常 4-6 个），必须精准布点。</span>' },
           { t: '放弃断点，改用 Frida 的 <code>Interceptor.attach</code>，因为它内部实现更隐蔽',
             why: '<code>Interceptor.attach</code> 同样需要修改目标函数的入口指令（插入跳转），' +
                  '<b>本质上仍是一种会改写内存的 hook</b>。面对校验代码段的目标，它并不能提供额外的隐蔽性。' },
           { t: '把目标 so 完整 dump 到磁盘，离线反汇编分析，不在运行时干预',
             why: '离线分析本身很有价值，但它<b>不解决"观察运行时行为"的问题</b>：' +
                  '你不知道某个函数实际被调用的时机、参数是什么、返回值如何影响流程。' +
                  '而且如果目标用了内存动态释放代码（27.7 节），磁盘上的 so 里根本没有关键逻辑。' }
         ],
         explain: '<b>"不修改内存"是硬件断点的决定性优势，不是一个小小的加分项。</b>' +
                  '所有基于"检测内存改写"的反调试手段——校验和、首字节检查、内存扫描——在它面前全部失效。' +
                  '<b>但要记住它的真实代价：名额只有 4-6 个。</b>' +
                  '这意味着你必须先理解目标的行为，才知道该把宝贵的名额放在哪。' +
                  '<b>工具的能力上限，等于你分析能力的上限。</b>'
       },
       after:
         '<div style="height:14px"></div>'
     },

     {
       h: '27.16',
       title: '自测 · 动态释放代码的窗口期',
       html: '<p>最后一题。它检验的是本章最实用、也最容易在实战中出错的一个判断。</p>',
       quiz: {
         id: 'q13-4', chapter: 13, answer: 3,
         stem: '你怀疑目标 App 使用了<b>内存动态释放代码</b>：运行时解密关键逻辑到一块匿名内存，' +
               '赋予可执行权限，执行完立即释放。你想抓到这段代码。<b>最可靠</b>的做法是？',
         options: [
           { t: '用一个高频定时器（比如每 10ms）轮询进程内存，发现新的可执行匿名段就 dump',
             why: '这是"扫描"思路，本质是<b>赌运气</b>：只有在你的扫描周期恰好落在窗口期内时才可能命中。' +
                  '而窗口期可能只有几十毫秒甚至更短，且时机不可预测。<br>' +
                  '<b>更糟的是副作用：</b>10ms 级的全内存扫描开销巨大，会明显扰动目标进程——' +
                  '既可能让目标行为失真，也可能因为异常的资源占用<b>暴露你自己</b>。' },
           { t: '静态分析 so 文件，把数据段里所有可疑的加密数据找出来解密',
             why: '静态分析在这里<b>从原理上就失效</b>：密文看起来就是一段随机数据，你无法可靠地判断哪一段是代码；' +
                  '而且解密算法和密钥往往也是运行时才确定的。<b>最关键的是——代码从来没有以明文形式存在于文件里。</b>' },
           { t: '在 <code>munmap</code> 上 hook，在内存被释放前把内容 dump 出来',
             why: '时机太晚了。到达 <code>munmap</code> 时，代码<b>已经执行完毕</b>——' +
                  '你拿到的是"曾经执行过什么"的物证，但错过了执行过程中的所有动态信息：' +
                  '它调用了谁、参数是什么、返回值如何。而且有些实现是<b>改权限而不是 munmap</b>，这个 hook 会完全落空。' },
           { t: 'hook <code>mprotect</code> / <code>mmap</code>，在出现带 <code>PROT_EXEC</code> 的调用时立刻 dump 并记录模块基址',
             why: '正确。这是<b>事件驱动</b>而非轮询——窗口一打开你就收到回调，不依赖运气。' +
                  '而且 <code>PROT_EXEC</code> 是一个高信噪比的信号：正常 App 极少申请可执行内存。' +
                  '<b>关键细节：dump 的同时必须记录当时所有模块的加载基址</b>，' +
                  '否则 dump 里的函数地址都是无主裸地址，静态分析时无法重定位回符号。<br>' +
                  '<span class="miss">注意前提：<code>mprotect</code> 本身也是 libc 函数——如果对手连它都用内联 SVC 绕过，' +
                  '就必须退到内核侧监控内存权限变化。</span>' }
         ],
         explain: '<b>核心原则：窗口期太短，不能"扫描"，要"被通知"。</b>' +
                  '轮询是在赌"我的采样点恰好落在窗口内"，而 hook 是让目标主动告诉你"窗口现在打开了"。' +
                  '当被观测的现象具有<b>短时、不可预测</b>的特征时，事件驱动永远优于轮询。<br>' +
                  '<b>两个必须记住的操作细节：</b>① <b>dump 和模块基址必须成对记录</b>，缺一个这份 dump 就无法做符号重定位；' +
                  '② <b>窗口期内只做快照，不做解读</b>——遍历线程、打印调用栈这些重操作会把窗口期耗光。' +
                  '把分析留到窗口关闭之后。'
       }
     }
     ],
     glossary: [
       { t: 'SVC', d: '<b>Supervisor Call</b>（管理程序调用）。ARM 上用于从用户态主动陷入内核态的指令，ARM32 上旧称 <code>SWI</code>（Software Interrupt）。' +
                      '执行后 CPU 触发同步异常，从 EL0 切到 EL1，由内核异常向量表接管并按系统调用号分发。' },
       { t: '内联系统调用', d: '不经过 libc 封装函数，直接在代码里写下 <code>SVC</code> 指令并自行设置系统调用号与参数寄存器的做法。' +
                               '它使所有基于 Hook libc 导出函数的监控完全失效，是本章标题所指反 Hook 手段的技术基础。' },
       { t: '系统调用号', d: '内核用来在 syscall 分发表里定位处理函数的编号。约定：<b>ARM32 (EABI) 放 r7，AArch64 放 x8</b>。' +
                            '号值随架构、ABI 与内核版本变化，实战应以目标头文件（<code>asm/unistd.h</code>）为准；' +
                            '而指令编码 <code>0xEF000000</code> / <code>0xD4000001</code> 由架构规范定义，是稳定的扫描特征。' },
       { t: '异常向量表', d: '内核中用于接收各类异常（含 <code>SVC</code> 触发的同步异常）的入口表。' +
                            'CPU 执行 <code>SVC</code> 后跳转到这里，由内核决定后续处理。它是内核侧观测点（方法③）的候选位置之一。' },
       { t: 'EL0 / EL1', d: 'AArch64 的异常级别。<b>EL0</b> 是用户态（普通 App 代码运行处），<b>EL1</b> 是内核态。' +
                           '<code>SVC</code> 的作用就是让执行流从 EL0 陷入 EL1——一旦进入 EL1，用户态的 hook 框架就失去了执行权。' },
       { t: 'syscall 分发表', d: '内核里保存"系统调用号 → 处理函数"映射的表。' +
                                '它是所有系统调用的必经汇聚点，<b>无法被用户态绕过</b>——这是内核模块方案能力上限最高的根本原因。' },
       { t: '硬件断点', d: '由 CPU 调试寄存器实现的断点，地址匹配在 CPU 内部完成，<b>不修改目标内存的任何一个字节</b>。' +
                          '因此校验代码段校验和、检查函数首字节、扫描内存找 hook 痕迹等反调试手段对它全部无效。' +
                          '限制是数量很少（ARM 上通常 4-6 个）。' },
       { t: '观察点（Watchpoint）', d: '硬件断点的一类，匹配的不是"执行到某地址"而是"对某地址的读写操作"。' +
                                       '在分析 JNI 地址防追踪时非常有用：对保存方法入口的内存下观察点，' +
                                       '就能捕获每一次"入口被写入新地址"的事件，而不必反复抓过期的快照。' },
       { t: '软件断点', d: '把目标地址处的指令替换成一条断点指令（ARM 上如 <code>BRK</code>）来实现的断点。' +
                          '实现简单、数量几乎无限，但<b>必须改写目标内存</b>——因此会被代码段校验和、首字节检查等手段发现。' },
       { t: '内存动态释放代码', d: 'Memory Dynamic Release。关键代码不以静态形式存放于 so 中，而是运行时解密到内存、' +
                                  '用 <code>mmap</code> + <code>mprotect</code> 赋予可执行权限、跳进去执行、执行完 <code>munmap</code> 释放。' +
                                  '静态分析看不到，内存扫描也不稳定（窗口期极短）。' },
       { t: 'RegisterNatives', d: 'JNI 中把 Java native 方法与本地函数地址建立绑定的标准接口。' +
                                  '常规做法是在 <code>JNI_OnLoad</code> 里一次性注册全部方法，因而极易被 hook 一网打尽；' +
                                  '防追踪做法包括延迟注册、分次注册、动态计算地址、反复注册注销，以及绕过该接口直接改方法入口。' },
       { t: '0r0env 调试 ROM', d: '课程作者提供的整套定制调试环境（定制 ROM / 内核），把内核级对抗能力打包成开箱即用的工具。' +
                                  '<b>具体内容、支持范围与使用方式待核实，以作者发布为准，本章不做推测。</b>' }
     ],
     teacher: {
       id: 'ch13', chapter: 13,
       name: '追问老师 · 第 27 章',
       sub: '围绕 SVC 绕过、观测层选择、三种追踪技巧与硬件断点展开追问',
       intro: '<p style="margin:0">这一章我不问"<code>SVC</code> 是什么意思"，那种问题查手册就有。我只问一件事：<b>当你的观测点被架空时，你怎么知道？又该往哪一层退？</b>答不上来我会一层层往下逼，直到你说清楚"为什么这个方案在这一层是有效的、在另一层就失效了"。</p>',
       questions: [
         {
           id: 'c13q1', depth: 1, threshold: 0.7,
           q: '你的 Frida 脚本 hook 了 libc 的 <code>open</code>，运行目标 App 后<b>一次都没触发</b>，' +
              '但其他 hook 都正常工作。<b>请描述 App 绕过你的机制</b>——从它写下那行代码，到内核真正开始处理，中间经过了哪些步骤？',
           concepts: [
             { label: '内联 SVC / 直接发起系统调用，跳过 libc 封装',
               hint: '它没有走你 hook 的那一层。那它是怎么进内核的？',
               any: ['svc', 'SVC', '内联', 'inline', 'syscall', '系统调用', 'swi', 'SWI', '直接调用', '自己发起',
                     '不经过libc', '绕过libc', '跳过libc', '直接陷入', '直接进内核', '手写汇编', '内联汇编'] },
             { label: '自己设置系统调用号与参数寄存器（ARM32 r7 / AArch64 x8）',
               hint: 'libc 本来替你做的事，现在谁来做？具体是哪个寄存器？',
               any: ['r7', 'x8', '系统调用号', 'syscall number', '调用号', '寄存器', '参数寄存器', 'x0', 'r0',
                     '自己设置', '自行设置', '手工设置', '摆寄存器', '设参数'] },
             { label: 'EL0 执行 SVC 触发同步异常，陷入 EL1',
               hint: '这条指令执行后 CPU 发生了什么？特权级有没有变化？',
               any: ['EL0', 'EL1', '同步异常', '异常', '陷入', 'trap', '特权级', '异常级别', 'exception',
                     '内核态', '用户态', '特权', 'svc指令', '触发异常'] },
             { label: '内核异常向量表接管，按系统调用号查 syscall 表分发',
               hint: '进了内核之后，它怎么知道你要办哪件事？',
               any: ['异常向量', '向量表', 'vector', 'syscall表', '系统调用表', '分发表', '分发', 'dispatch',
                     '查表', '处理函数', 'handler', '系统调用号', '路由'] },
             { label: '两条路径在内核侧汇合，libc hook 因此完全失效',
               hint: '为什么会完全失效？两条路径在哪一点上是一样的？',
               any: ['汇合', '合流', '相同', '一样', '同一', '都经过', '必经', '看不到', '失效', '绕过', 'bypass',
                     '观测不到', '零命中', '没有经过', '不经过'] }
           ],
           hints: [
             'libc 的 <code>open</code> 本身不做任何实际工作，它只是"帮你把寄存器摆好"。既然如此，App 能不能自己摆？',
             '想想 ARM 上真正干这件事的那条指令叫什么，以及它运行在哪个异常级别、之后 CPU 跳到了哪里。'
           ],
           probes: [
             '你说到了"直接发起系统调用"——那具体是哪几个寄存器需要被设置？ARM32 和 AArch64 一样吗？',
             '两条路径在 <code>svc</code> 之后是不是完全一样？如果是，这对"该在哪里设观测点"意味着什么？'
           ],
           model: '<b>完整机制。</b>正常路径是：App 调用 libc 的 <code>open</code> → libc 把参数搬进寄存器、' +
                  '把系统调用号写进 <code>r7</code>（ARM32）或 <code>x8</code>（AArch64）→ 执行 <code>SVC</code> → 内核处理 → 返回。<br>' +
                  '绕过路径则是：<b>App 根本不管 libc，自己在代码里把系统调用号和参数塞进寄存器，然后内联写下那条 <code>SVC</code> 指令。</b>' +
                  '对 CPU 而言，这两条路径发出的指令完全一样——它不关心指令来自 libc 还是 App 自己。<br>' +
                  '<b>完整执行过程：</b>用户态（<b>EL0</b>）执行 <code>SVC #0</code> → CPU 触发<b>同步异常</b> → ' +
                  '陷入内核态（<b>EL1</b>）→ 内核的<b>异常向量表</b>接管 → 根据<b>系统调用号</b>在 syscall 分发表里' +
                  '定位并调用对应处理函数 → 执行完毕返回 EL0，结果写回 <code>r0</code> / <code>x0</code>。<br>' +
                  '<b>为什么你的 hook 完全失效：</b>Frida 的 <code>Interceptor.attach</code> 挂在 <b>libc 导出函数的入口</b>上。' +
                  '绕过路径<b>根本不进入 libc</b>，所以那一层代码一次都不会被执行。这不是 Frida 的 bug，是观测层被整个跳过了。<br>' +
                  '<b>一个实用的诊断探针：</b>挂 libc 的 <code>syscall()</code>——它是所有系统调用的公共转发点。' +
                  '如果连它都没命中，说明对手<b>压根没进 libc</b>，问题在层级而不在覆盖面。<br>' +
                  '<b>结构性的结论：</b>两条路径只在 <code>svc</code> 之后的内核侧汇合。' +
                  '所以观测点放在用户态的任何一层，都存在"被绕过"的可能；只有内核的 syscall 分发表无法被用户态绕过。',
           after: '<p>如果你答出了"两条路径在内核汇合"，说明你已经摸到本章的主线了——<b>接下来所有方案的选择，都是在回答"我要不要下到内核侧"。</b></p>'
         },

         {
           id: 'c13q2', depth: 2, threshold: 0.7,
           q: '这一章介绍了三种追踪 SVC 的方法：<b>Hook 内核 syscall 表</b>、<b>静态扫描代码段找 SVC 指令</b>、' +
              '<b>硬件断点</b>。请分别说出它们的<b>核心优势和硬伤</b>，并说明为什么说这三者是<b>"能力递进"</b>而不是"互相替代"。',
           concepts: [
             { label: '内核 syscall 表：最彻底、无法被用户态绕过，但需要内核能力、门槛高',
               hint: '哪一种方案是"不管你怎么绕都躲不掉"的？代价是什么？',
               any: ['内核', 'kernel', 'syscall表', '系统调用表', '分发表', '最彻底', '无法绕过', '不能绕过',
                     '不可绕过', '门槛', '编译内核', '内核模块', '刷机', '变砖', 'root', '定制内核'] },
             { label: '静态扫描：实现简单、Frida 即可做，但扫不到动态生成代码、可能误报、有开销',
               hint: '哪一种最容易上手？它最怕对手做什么？',
               any: ['静态扫描', '扫描', 'scan', 'Memory.scan', '特征码', '特征字节', '简单', '容易',
                     '动态生成', '动态代码', '运行时', '解密', '扫不到', '误报', '开销', '数据段'] },
             { label: '硬件断点：不修改内存、难以被检测、精确捕获，但数量有限（ARM 通常 4-6 个）',
               hint: '哪一种最不容易被发现？为什么？它的名额有多少？',
               any: ['硬件断点', 'hardware breakpoint', '不修改内存', '不改内存', '难以检测', '无法检测',
                     '调试寄存器', '数量有限', '4个', '6个', '4-6', '名额', '有限', '精确', '隐蔽'] },
             { label: '三者按目标反检测强度分层选择，能力递进，实战中组合使用',
               hint: '如果目标同时有加固、会自校验、代码还是动态解密的，你会只用其中一种吗？',
               any: ['递进', '分层', '层级', '组合', '配合', '按需', '选择', '决策', '强度', '根据目标',
                     '不是替代', '互补', '叠加', '由易到难', '逐级'] },
             { label: '扫描负责"找候选"，硬件断点负责"精确定点"（组合用法）',
               hint: '几十个扫描命中点，和只有几个的硬件名额之间，怎么衔接？',
               any: ['候选', '筛选', '缩小范围', '先扫描', '再断点', '配合使用', '组合使用', '两步',
                     '扫描定位', '断点验证', '先粗后细'] }
           ],
           hints: [
             '每个方案都问两个问题：<b>它能不能被对手绕过？它会不会被对手发现？</b>这两题的答案往往指向相反的方向。',
             '想想"硬件断点只有 4-6 个名额"这个限制，它把什么负担转移给了分析者？'
           ],
           probes: [
             '你说硬件断点最难被检测——具体难在哪一步？软件断点为什么做不到？',
             '如果目标是一个完全没加固的普通 App，你会一上来就编内核模块吗？为什么？'
           ],
           model: '<b>三种方法的核心权衡。</b><br>' +
                  '<b>① Hook 内核 syscall 表</b>（内核模块 / 定制内核）：直接改内核里的系统调用分发表，把所有系统调用都截下来。' +
                  '<b>优势是最彻底——无法被用户态绕过</b>，因为不管 App 怎么写，最终都必须经过这张表。' +
                  '这正是本章标题"内核模块绕过 Frida 检测"的由来：<b>当观测点在内核，App 在用户态做的任何反检测都看不见你。</b>' +
                  '<b>硬伤是需要内核层能力</b>：编译内核模块、定制内核、刷机，门槛高且有变砖风险。<br>' +
                  '<b>② 静态扫描代码段</b>：按特征字节找 <code>SVC</code>（ARM32 <code>0xEF000000</code>，' +
                  'AArch64 <code>0xD4000001</code>），在命中地址下断点或做记录。<b>优势是实现简单</b>，用 Frida 的 ' +
                  '<code>Memory.scan</code> 就能做，不需要任何内核能力。<b>硬伤有三条</b>：' +
                  '① <b>动态生成的代码扫不到</b>（运行时解密到内存的代码，扫描时还不存在）；' +
                  '② <b>可能误报</b>（数据段里恰好出现这四个字节的情况并不罕见，必须和 <code>/proc/self/maps</code> 的段权限核对）；' +
                  '③ 全量扫描有开销。<br>' +
                  '<b>③ Hook 陷入入口 / 硬件断点</b>：hook 异常向量表，或在 SVC 地址上设硬件断点。' +
                  '<b>优势是硬件断点不修改目标内存</b>——它由 CPU 调试寄存器实现，因此校验代码段校验和、检查首字节、' +
                  '扫描内存找 hook 痕迹这些手段全部无效。<b>硬伤是数量有限</b>：ARM 上通常只有 4-6 个，无法大规模布点。<br>' +
                  '<b>为什么是"能力递进"而非"互相替代"：</b>三者的<b>不可绕过性</b>和<b>隐蔽性</b>依次提升，' +
                  '但<b>门槛和限制</b>也依次提高。它们覆盖的是不同的对抗强度：静态扫描适合无加固目标；' +
                  '硬件断点适合有自校验的目标；内核 hook 适合连 <code>mprotect</code> 都走 SVC 的成熟目标。' +
                  '<b>实战中往往组合使用</b>：先用静态扫描低成本地找出所有 SVC 候选地址，' +
                  '再用仅有的几个硬件断点名额，精准布在从候选中挑出的最关键位置上。' +
                  '<b>结论：按目标的反检测强度选层级，而不是按自己的熟练度选。</b>'
         },

         {
           id: 'c13q3', depth: 2, threshold: 0.7,
           q: '什么是<b>内存动态释放代码</b>？请描述它的完整流程。' +
              '为什么说它对静态分析和内存扫描<b>都不友好</b>？你应该在哪一刻介入？' +
              '<b>并且：如果对手连 <code>mprotect</code> 都用 SVC 绕过，你怎么办？</b>',
           concepts: [
             { label: '流程：取加密代码 → 解密到内存 → mmap/mprotect 赋予可执行 → 跳进去执行 → munmap 释放',
               hint: '按时间顺序把这五步说出来。',
               any: ['解密', 'decrypt', 'mmap', 'mprotect', '可执行', 'RWX', 'PROT_EXEC', '跳进去', '执行',
                     'munmap', '释放', '加密', '密文', '流程', '动态释放', '内存释放'] },
             { label: '静态分析看不到：so 里根本没有这段代码，密文看起来只是随机数据',
               hint: '你去翻磁盘上的 so 文件，能找到什么？',
               any: ['静态分析', '看不到', '不存在', '没有代码', '磁盘', '文件里没有', '随机数据', '密文',
                     '不在代码段', '扫不到', '静态'] },
             { label: '内存扫描不稳定：窗口期极短，扫早了没有、扫晚了已释放',
               hint: '这段代码以可执行形式存在的时间有多长？',
               any: ['窗口', '窗口期', '很短', '短暂', '时机', '瞬时', '几十毫秒', '转瞬', '不稳定',
                     '扫早了', '扫晚了', '错过', '时间窗口', '来不及'] },
             { label: '介入点：hook mprotect/mmap，出现 PROT_EXEC 时立刻 dump 并记录模块基址',
               hint: '要在"变可执行"和"开始执行"之间介入。怎么知道这一刻到了？',
               any: ['mprotect', 'mmap', 'hook', '事件驱动', 'PROT_EXEC', 'RWX', 'dump', '报警', '通知',
                     '回调', '基址', '模块基址', '记录', '立刻', '马上', '拦截'] },
             { label: 'mprotect 也是 libc 函数，被 SVC 绕过时须退到内核侧监控内存权限变化',
               hint: '你用来观测的那个函数，本身是不是也可以被对手绕过？',
               any: ['内核', 'kernel', '也被绕过', '同样绕过', '退到内核', '内核侧', '监控权限', '内存权限',
                     '环环相扣', '回到方法1', '硬件断点', '更高层', '内核模块'] }
           ],
           hints: [
             '关键在于：这段代码<b>以可执行形式存在</b>的时间有多长？在这段时间之外，你是找不到它的。',
             '要抓一个"转瞬即逝"的事件，是应该定时去看一眼，还是应该让目标在事件发生时通知你？'
           ],
           probes: [
             '你说要 hook <code>mprotect</code>——那 <code>mprotect</code> 是什么层的函数？它自己会不会被绕过？',
             '假设你成功 dump 到了这块内存，里面的函数地址能直接拿去反汇编吗？还缺什么信息？'
           ],
           model: '<b>内存动态释放代码（Memory Dynamic Release）</b>指 App 不把关键代码静态放在 so 里，而是：' +
                  '<b>① </b>运行时从某处（网络、资源文件、native 数据段）取到<b>加密的代码</b>；' +
                  '<b>② </b>解密到一块内存；<b>③ </b>用 <code>mmap</code> + <code>mprotect(PROT_READ|PROT_WRITE|PROT_EXEC)</code> ' +
                  '把这块内存变成<b>可执行</b>；<b>④ </b>跳进去执行；<b>⑤ </b>执行完 <code>munmap</code> 释放，或改回不可执行。<br>' +
                  '<b>为什么静态分析不友好：</b>so 里<b>根本没有这段代码</b>。密文就是一段看起来随机的数据，' +
                  '你不会注意到它，也无法可靠地判断"这一段就是代码"。<b>代码从来没有以明文形式存在于文件里。</b><br>' +
                  '<b>为什么内存扫描不稳定：</b>因为它有一个极短的<b>窗口期</b>——从 <code>mprotect</code> 赋予可执行权限，' +
                  '到执行完毕被释放。这个窗口可能只有几十毫秒甚至更短。<b>扫早了这块内存还没有代码，扫晚了代码已经没了。</b>' +
                  '而且把扫描周期压到毫秒级，开销会大到影响 App 行为，反而暴露自己。<br>' +
                  '<b>应该在哪一刻介入：</b>在步骤 ③ 和 ④ 之间——<b>刚刚 mprotect 完、还没开始执行</b>的那个瞬间。' +
                  '做法是<b>事件驱动而不是轮询</b>：hook <code>mprotect</code> / <code>mmap</code>，' +
                  '当出现"申请 RWX 权限"或"把内存改成可执行"时立刻捕获，<b>在那一刻 dump 这块内存</b>，或者在它的入口下断点。' +
                  '<code>PROT_EXEC</code> 是高信噪比信号——正常 App 极少申请可执行内存。<br>' +
                  '<b>两个关键操作细节：</b>① <b>dump 的同时必须记录当时所有模块的加载基址</b>。' +
                  'dump 出来的代码里全是裸地址（如 <code>bl 0x7a3c1d20</code>），不知道各模块加载在哪，' +
                  '这些地址就永远无法换算回符号——<b>只存一个 bin 文件等于存了一堆无主地址</b>。' +
                  '② <b>窗口期内只做快照，不做解读</b>：遍历线程、打印调用栈这些重操作会把窗口期耗光。<br>' +
                  '<b>如果对手连 <code>mprotect</code> 都用 SVC 绕过：</b>你又回到了方法 ① 或 ③——' +
                  '必须从<b>内核侧监控内存权限变化</b>（最可靠），或者对内核里的权限修改路径下硬件断点。' +
                  '<b>这体现本章技术的环环相扣：每一个用户态方案都有一个"对手再进一步"的边界。</b>'
         },

         {
           id: 'c13q4', depth: 2, threshold: 0.7,
           q: '你已经 hook 到了 <code>RegisterNatives</code>，拿到了一份完整的 JNI 映射表（Java 方法 → native 地址），' +
              '并在关心的函数上下好了断点。<b>结果跑完全程，断点一次都没命中，而 App 一切正常。</b>' +
              '请给出至少三种可能的解释，并说明你会怎么验证、最终怎么解决。',
           concepts: [
             { label: '地址已过期：对手用 UnregisterNatives + 重新 RegisterNatives 反复更换映射',
               hint: '你抓到的那份表，在抓到之后有没有可能被改掉？',
               any: ['过期', '失效', '失效了', '已经变了', '更换', '换掉', 'UnregisterNatives', '注销',
                     '重新注册', '重复注册', '反复注册', '动态变化', '地址变了', '快照'] },
             { label: '延迟注册 / 分次注册：真正的方法在更晚的时机才注册，你抓的只是部分或诱饵',
               hint: '你抓这份表的时机，是方法真正被使用的时机吗？',
               any: ['延迟注册', '延迟', '分次注册', '分次', '分批', '更晚', '时机', 'JNI_OnLoad',
                     '不在OnLoad', '诱饵', '假的', '部分', '不完整', '后面才注册'] },
             { label: '绕过 RegisterNatives：直接改 ART 内部方法入口，你的 hook 零命中',
               hint: '有没有一种绑定方式，压根不调用你 hook 的那个函数？',
               any: ['ArtMethod', 'art', '绕过', '不走标准', '不调用RegisterNatives', '直接改入口',
                     '方法入口', '入口', 'entry', 'artmethod', '绑定', '零命中', 'hook不到'] },
             { label: '改用硬件断点 / 观察点监控"入口被写入"这一事件，而非追踪地址',
               hint: '当快照不可靠时，你应该追踪"地址"还是追踪"地址被改写的动作"？',
               any: ['硬件断点', '观察点', 'watchpoint', '监控写入', '监控变化', '事件', '入口被写入',
                     '不修改内存', '不改内存', '订阅', '持续监控', '动态'] },
             { label: '先验证假设：读取该地址的内存，确认入口指令是否还符合预期',
               hint: '在换方案之前，第一件事应该是确认什么？',
               any: ['验证', '确认', '读取内存', 'dump', '看内存', '检查', '先验证', '排错', '诊断',
                     '读一下', '对比', '反汇编'] }
           ],
           hints: [
             '注意题干里的关键线索：<b>App 表现完全正常</b>。如果它检测到了你的断点，正常反应应该是崩溃或退出，而不是若无其事。这说明什么？',
             '你假设"映射表是稳定的"。如果这个假设不成立，那么"抓得更早更全"还有意义吗？'
           ],
           probes: [
             '你说地址过期了——那有没有一种观测方式，不管它换多少次都能捕获？',
             '如果对手是直接改 ART 内部方法入口，完全不调用 <code>RegisterNatives</code>，你的硬件断点该下在哪里？'
           ],
           model: '<b>这道题的核心是：从"追踪地址"转向"追踪事件"。</b><br>' +
                  '<b>为什么"App 表现完全正常"是关键线索：</b>如果对手检测到了你改写的断点指令，' +
                  '正常反应是崩溃、退出或走错误分支。<b>"什么都没发生"恰恰说明它根本没读到你的断点</b>——' +
                  '所以问题不是"被检测"，而是<b>你观测的那个地址已经不再被使用了</b>。<br>' +
                  '<b>三种可能的解释：</b><br>' +
                  '<b>① 反复注册/注销。</b>对手在 <code>JNI_OnLoad</code> 里先注册一批（故意让你抓到），' +
                  '初始化完成后用 <code>UnregisterNatives</code> 注销，再用 <code>RegisterNatives</code> 注册新地址。' +
                  '<b>你在某个时刻抓到的映射，过一会儿就失效了。</b><br>' +
                  '<b>② 延迟注册 / 分次注册。</b>不在 <code>JNI_OnLoad</code> 注册，而是真正要用到某个方法时才注册；' +
                  '或把方法拆成多批、分散在不同时机注册。你抓到的只是快照的一部分——而且是<b>最容易被抓到的那一部分</b>。<br>' +
                  '<b>③ 绕过 <code>RegisterNatives</code>。</b>利用 ART 特性（例如直接修改 <code>ArtMethod</code> 的入口）' +
                  '来绑定，<b>根本不产生 <code>RegisterNatives</code> 调用</b>，你在这个接口上的 hook 直接零命中。' +
                  '<span class="pill warn">ART 内部具体结构与版本差异较大，待核实，以目标版本实际代码为准</span><br>' +
                  '<b>怎么验证：</b>先读一下那个地址处的内存，看入口指令是否还符合预期。' +
                  '如果已经不一样了（变成跳转桩，或者干脆是被回收的内存），就证实了"地址已失效"。<br>' +
                  '<b>怎么解决：</b>不要再追求"抓一份更全的快照"——<b>对手的全部策略就是让完整快照不存在。</b>' +
                  '正确做法是<b>持续观测变更事件</b>：<br>' +
                  '· 对保存方法入口的那个内存位置下<b>观察点（Watchpoint）</b>，每次有代码写入新地址都会通知你，' +
                  '拿到的是最新鲜的映射而不是过期快照；<br>' +
                  '· 在 ART 内部"方法入口被写入"的位置下<b>硬件断点</b>——<b>不管走哪条路径绑定，最终都要往方法入口里写一个地址</b>，' +
                  '盯住那个写入动作，就能捕获所有绑定；<br>' +
                  '· 用<b>硬件断点而非软件断点</b>：对手既然会动态换入口，大概率也会校验代码段，' +
                  '软件断点会改内存，硬件断点不会。<br>' +
                  '<b>可迁移的思维模型：当快照不可靠时，改为订阅变更事件。</b>'
         },

         {
           id: 'c13q5', depth: 3, threshold: 0.6,
           q: '<b>综合题。</b>你现在接手一个目标 App，已知它同时具备以下特征：' +
              '① 关键 native 逻辑用<b>内联 SVC</b> 直接发起系统调用；② 部分代码<b>运行时解密到可执行内存</b>后执行即释放；' +
              '③ JNI 方法<b>分多次注册且会反复换地址</b>；④ 会校验自身代码段的校验和。' +
              '<b>请设计一套完整的分析方案</b>：你会按什么顺序做什么？每一步用什么工具、布在哪个位置？' +
              '为什么是这个顺序？最后说明这套方案的<b>能力边界</b>在哪里。',
           concepts: [
             { label: '顺序原则：先用最轻的手段做诊断，确认对手层级后再决定是否升级',
               hint: '第一步应该是直接刷定制内核，还是先用最便宜的方式搞清楚它在干什么？',
               any: ['先轻后重', '由易到难', '先诊断', '诊断', '先确认', '再决定', '顺序', '逐步', '渐进',
                     '最小成本', '先静态', '轻量', '分层', '逐级', '先摸清'] },
             { label: '静态扫描两个特征码定位候选 SVC，并核对 /proc/self/maps 段权限排除误报',
               hint: '面对"内联 SVC"，第一个能立刻做、成本最低的动作是什么？',
               any: ['Memory.scan', '静态扫描', '扫描', '特征码', '0xEF000000', '0xD4000001', 'D4000001',
                     'EF000000', '候选', '特征字节', '/proc/self/maps', 'maps', '段权限', '排除误报', '误报'] },
             { label: 'hook mprotect/mmap 抓 PROT_EXEC，在窗口期内 dump 并同时记录全部模块基址',
               hint: '面对"运行时解密到可执行内存"，观测点该放在哪个事件上？',
               any: ['mprotect', 'mmap', 'PROT_EXEC', 'RWX', '窗口', '窗口期', 'dump', '模块基址', '基址',
                     '事件驱动', '可执行内存', '解密', '动态释放'] },
             { label: '对入口写入下观察点/硬件断点，捕获每一次 JNI 绑定，而非抓一次映射表',
               hint: '面对"反复换地址的 JNI 注册"，追踪地址和追踪事件哪个可行？',
               any: ['观察点', 'watchpoint', '硬件断点', '入口写入', '监控写入', '事件', '每次绑定',
                     '捕获绑定', '不抓快照', '持续监控', '动态'] },
             { label: '优先用硬件断点而非软件断点，因为目标会校验代码段，改内存会被发现',
               hint: '目标会校验代码段校验和。这对你选择断点类型意味着什么？',
               any: ['硬件断点', '不修改内存', '不改内存', '校验和', '自校验', '代码段校验', '会被发现',
                     '隐蔽', '无痕', '软件断点不行', 'BRK', '改内存'] },
             { label: '硬件断点名额有限（4-6 个），必须先理解行为才能精准布点',
               hint: '你只有几个名额，却有一堆候选位置。这个限制对你的方法论意味着什么？',
               any: ['数量有限', '名额', '4-6', '4个', '6个', '有限', '精准', '取舍', '优先级',
                     '理解行为', '判断力', '选位置', '不能全下'] },
             { label: '升级到内核侧：syscall 表 hook 或内核监控内存权限变化（绕过了 mprotect 时）',
               hint: '如果对手连 <code>mprotect</code> 都走内联 SVC，用户态还剩什么办法？',
               any: ['内核', 'kernel', 'syscall表', '系统调用表', '内核模块', '定制内核', '内核侧',
                     '监控权限', '内核监控', '0r0env', '刷机', '升级'] },
             { label: '能力边界：定制内核本身可能成为指纹；工具只解决"能不能观测"，不解决"该观测什么"',
               hint: '把观测点放到内核之后，还会有什么风险？工具能替你解决理解问题吗？',
               any: ['边界', '指纹', '暴露', '被发现', '反制', '局限', '限制', '双向', '对抗',
                     '不理解', '黑盒', '判断力', '理解成本', '不能代替理解'] }
           ],
           hints: [
             '先问自己一个问题：这四条特征里，哪一条是<b>你在用户态完全无法观测</b>的？从它反推你需要的最低层级。',
             '再问第二个问题：如果你一上来就编内核模块，你会得到什么？<b>一堆没有上下文的系统调用流水</b>——' +
             '你依然不知道哪一条是你关心的。那么正确的顺序应该是什么？'
           ],
           probes: [
             '你说先用静态扫描——但目标有运行时解密代码，静态扫描对第 ② 条特征完全无效。那这一步还有价值吗？价值是什么？',
             '你把硬件断点放在"入口写入"上——请说清楚：你为什么认为这个位置能覆盖"绕过 <code>RegisterNatives</code>"的情况？',
             '最后：如果目标能检测到定制内核的存在，你这套方案里哪一环会先崩？'
           ],
           model: '<b>一套完整的分析方案，按"先轻后重、先诊断后投入"的顺序展开。</b><br>' +
                  '<b>第一步 · 静态扫描定位候选（成本最低，先做）。</b>' +
                  '用 <code>Memory.scan</code> 搜两个特征字节——ARM32 <code>00 00 00 EF</code>、' +
                  'AArch64 <code>01 00 00 D4</code>（注意小端字节序）。<b>32 位和 64 位的 so 都要搜。</b>' +
                  '命中后<b>必须核对 <code>/proc/self/maps</code> 的段权限，只保留落在 <code>r-x</code> 段内的</b>，排除数据段误报。' +
                  '同时反汇编命中点，确认前面确实是 <code>mov r7/x8, #imm</code>。<br>' +
                  '<b>这一步对第 ② 条特征（动态解密代码）无效</b>——但依然有价值：它能把"内联 SVC"这部分摸清，' +
                  '并且给你一批硬件断点的<b>候选地址</b>。<br>' +
                  '<b>第二步 · 事件驱动抓动态代码。</b>hook <code>mprotect</code>/<code>mmap</code>，' +
                  '过滤出带 <code>PROT_EXEC</code> 的调用。命中时<b>立刻 dump 这块内存，同时记录当时所有模块的加载基址</b>。' +
                  '<b>窗口期内只做快照，不做解读</b>——遍历线程、打调用栈都会把窗口期耗光。' +
                  '没有模块基址，dump 出来的地址就是一堆无主裸地址，无法做符号重定位。<br>' +
                  '<b>第三步 · 把观测对象从"地址"换成"事件"。</b>' +
                  '针对第 ③ 条（JNI 地址反复变化），<b>不要再去抓映射表快照</b>——对手的全部策略就是让完整快照不存在。' +
                  '改为：对保存方法入口的内存位置下<b>观察点</b>，或在 ART 内部"方法入口被写入"的位置下<b>硬件断点</b>。' +
                  '<b>关键洞察：不管走哪条路径绑定，最终都要往方法入口里写一个地址</b>，盯住这个写入动作，' +
                  '就能覆盖"绕过 <code>RegisterNatives</code>"的情况。<br>' +
                  '<b>第四步 · 断点类型的选择。</b>因为第 ④ 条（校验代码段校验和），' +
                  '<b>必须用硬件断点，不能用软件断点</b>。软件断点要改写目标指令，校验和一定对不上，首字节检查也会发现。' +
                  '硬件断点由 CPU 调试寄存器实现，<b>目标内存一个字节都不变</b>，' +
                  '所有"检测内存改写"的手段全部失效。<br>' +
                  '<b>第五步 · 面对名额限制做取舍。</b>硬件断点只有 4-6 个。' +
                  '<b>这个限制从根本上改变了工作方式</b>：不能再"先大量布点再看哪个命中"。' +
                  '必须先用前三步建立对目标行为的理解，才能选出最关键的几个位置。<br>' +
                  '<b>第六步 · 必要时升级到内核侧。</b>如果发现第一步的 SVC 定位被绕过（比如连 <code>mprotect</code> 都走内联 SVC），' +
                  '或者第二步的观测被干扰，就退到内核：<b>syscall 表 hook 无法被用户态绕过</b>，' +
                  '或从内核侧监控内存权限变化。<b>这一步门槛最高（编译内核模块 / 刷机 / 变砖风险），所以放在最后。</b><br>' +
                  '<b>为什么是这个顺序：</b>因为内核方案虽然最强，但它一开就是<b>海量的系统调用流水</b>——' +
                  '启动阶段每秒可能几万条，涉及内存、线程、文件、时钟、futex……<b>你付出了刷机和变砖风险，' +
                  '换来的却是没有上下文的原始数据。</b>而前三步成本极低，却能把范围从"几万条系统调用"缩小到"7 个 SVC 地址"。' +
                  '<b>先用最轻的手段做诊断，确认对手层级之后，再决定要不要上内核层。</b><br>' +
                  '<b>能力边界在哪里：</b>① 硬件断点名额有限，覆盖不了全量调用点；' +
                  '② <b>定制内核本身可能成为可被指纹识别的特征</b>——你在提高观测层，对手也可能在提高探测层，' +
                  '对抗永远是双向的；③ 也是最根本的一条：<b>这套工具只解决"能不能观测"，不解决"该观测什么"。</b>' +
                  '如果你不理解 SVC 的路径、内存释放的时序、JNI 注册的流程，' +
                  '刷完机之后你只会看到一个"能跑但不知道在看什么"的黑盒。' +
                  '<b>工具降低的是搭建成本，不是理解成本。</b>' +
                  '<span class="pill warn">0r0env 的具体功能与内核探测对抗细节待核实，以作者发布为准</span>',
           after: '<p>如果你能把这道题答完，说明你已经建立了本章最核心的决策模型：' +
                  '<b>不是"哪个工具最强"，而是"对手在哪一层，我的观测点该放在哪一层，以及我凭什么认为它有效"。</b></p>'
         }
       ]
     }
};
