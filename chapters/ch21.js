/* 第 21 章数据 —— Frida 自动化与去特征 */
window.CHAPTER = {
  no: 21,
  title: 'Frida 自动化与去特征',
  lede: '第 1 章教会你手写 Frida 脚本，第 10、13 章讲透了特征检测与内核绕过。' +
        '但这中间缺了整整一层<strong>工程能力</strong>：把 Frida 从"每次手写几十行"升级成<strong>流水线</strong>，' +
        '以及在自己动手编译时，知道<strong>到底要抹掉哪些字符串、以及抹不掉的是什么</strong>。' +
        '本章干的就是这件事——先在用户态把常规特征做干净，再老老实实承认哪些特征<strong>根本不是用户态能修的</strong>。',
  meta: [
    '核心问题：<b>怎么把 Frida 用成流水线，又怎么知道自己的特征还剩几处暴露？</b>',
    '关键工具：<b>objection · r0capture · r0tracer · Java.registerClass · dlopen hook · ModuleMap · hluda 式改编译</b>',
    '对手：<b>指纹级检测——不看你做了什么，只看"你是不是 Frida"</b>'
  ],

  sections: [
    /* ============================================================ 21.1 */
    {
      h: '21.1', title: '手写脚本的三笔账，和自动化的边界',
      html:
        T.note('key', '🔑 这一节先算账，再谈工具',
          '<p style="margin-bottom:0">不谈"自动化很爽"。谈<b>手写脚本到底贵在哪</b>，' +
          '以及<b>自动化工具为什么救不了你最想救的那一段</b>。</p>') +
        '<p>手写 Frida 脚本的成本不在"写那 30 行 JS"，而在三笔你看不见的账：</p>' +
        T.tbl(['成本', '它长什么样', '自动化能不能省掉'],
          [
            ['<b>定位成本</b>',
             '为了 hook 一个方法，你得先知道<b>类名、方法名、参数签名、加载它的 ClassLoader</b>。' +
             '在加固 App 上，这四样东西一个都可能不在静态结果里',
             '<b>能省大半。</b>objection 的 <code>android hooking list classes</code> / <code>search classes</code> ' +
             '就是把"翻 jadx"换成"运行时枚举"，r0tracer 更进一步：<b>先批量打点，再从输出里捞</b>'],
            ['<b>重复成本</b>',
             '同一个动作你写过 100 遍：打印参数、打印返回值、打印调用栈、打印字段。' +
             '每换一个目标就复制粘贴改类名',
             '<b>能省掉。</b>这正是 objection 和 r0tracer 存在的唯一理由——' +
             '它们是"通用动作"的固化'],
            ['<b>重写成本</b>',
             'App 发现被 hook，换了个实现或加了混淆。你之前那 200 行脚本<b>一行都用不上了</b>',
             '<b>省不掉。</b>这是本章最要命的一条——' +
             '<span class="miss">工具能给你通用动作，给不了"这个 App 的业务逻辑"</span>']
          ]) +
        T.note('warn', '⚠️ 自动化工具的边界线画在哪里',
          '<p>把这条线记住，能省掉你未来大量的徒劳：</p>' +
          '<p><b>自动化工具解决的是"通用动作"</b>——枚举、搜索、批量打印、追溯调用、绕过常见的证书校验。' +
          '这些动作<b>不依赖目标 App 的具体逻辑</b>，所以可以被固化成一个通用工具。</p>' +
          '<p style="margin-bottom:0"><b>自动化工具不解决"这个 App 的特定逻辑"</b>——' +
          '"它把签名参数拼成了什么顺序"、"这个 48 字节的数组是怎么从设备信息算出来的"、' +
          '"它校验的是哪一份证书"——这三类问题<b>每一个都只属于那一个 App</b>，' +
          '没有任何通用工具能替你回答。<br>' +
          '<span class="hit">所以实战中的比例大致是：自动化吃掉 60% 的体力活，剩下 40% 仍然是手写脚本 + 手写推演。</span></p>') +
        T.card('一个可复用的判断顺序',
          '<p>遇到新目标时，按这个顺序问自己三句话：</p>' +
          '<p><b>① "我要找的东西，名字是我能猜到的吗？"</b><br>' +
          '能猜到 → <b>直接用 Java.use 手写</b>，比启动 objection 还快。<br>' +
          '猜不到 → 进第 ② 步。</p>' +
          '<p><b>② "我要做的事，是通用动作吗？"</b><br>' +
          '是（看参数 / 看调用栈 / 追谁调用了谁）→ <b>上 r0tracer 批量打点</b>。<br>' +
          '不是 → 进第 ③ 步。</p>' +
          '<p style="margin-bottom:0"><b>③ "我要的是业务语义吗？"</b><br>' +
          '是（还原算法、构造参数、复现协议）→ <b>只能手写</b>，工具最多帮你把线索捞出来（见 21.5、21.7）。</p>'),
      after: T.note('', '📌 本章的地图',
        '<p style="margin-bottom:0"><b>21.2–21.5</b> 是自动化三件套（objection / r0capture / r0tracer）；' +
        '<b>21.6–21.9</b> 是"从能 hook 到能主动调用"（Invoke Java / 抓包分工 / nop / dlopen）；' +
        '<b>21.10–21.14</b> 是去特征工程（ROM 内置 / 改编译 / syscall / ModuleMap / 暴露面审计）；' +
        '<b>21.15</b> 讲对抗的极限在哪里。</p>')
    },

    /* ============================================================ 21.2 */
    {
      h: '21.2', title: '先看清对手在数什么：暴露面逐层亮起来',
      html:
        '<p>谈去特征之前，先把<b>"暴露面"这个词变得可见</b>。' +
        '下面这个面板把一次 Frida 会话在目标进程里留下的痕迹，按<b>被检测的先后顺序</b>逐层点亮。</p>' +
        '<p>注意观察一件事：<strong>越靠后的层，越难消除</strong>——' +
        '而绝大多数人只做到第三层就停了。</p>',
      stage: {
        title: 'Frida 的暴露面 · 六层由浅到深',
        speed: 2000,
        render:
          '<div class="flow-col" style="gap:9px">' +
            '<div class="flow-row"><span class="pill mono">第 1 层</span>' +
              '<span class="blk" id="e1">进程名 frida-server</span>' +
              '<span class="blk" id="e2">端口 27042 / 27043</span>' +
              '<span class="blk" id="e3">安装路径 /data/local/tmp</span></div>' +
            '<div class="flow-row" style="margin-left:20px"><span class="arrow">↓ 往下走一层，靠"看名字"就不够了</span></div>' +
            '<div class="flow-row"><span class="pill mono">第 2 层</span>' +
              '<span class="blk" id="e4">模块名 frida-agent-64.so</span>' +
              '<span class="blk" id="e5">内存映射 /proc/self/maps</span>' +
              '<span class="blk" id="e6">线程名 gum-js-loop / gmain</span></div>' +
            '<div class="flow-row" style="margin-left:20px"><span class="arrow">↓ 名字也能改，但它还有"长相"</span></div>' +
            '<div class="flow-row"><span class="pill mono">第 3 层</span>' +
              '<span class="blk" id="e7">内存特征字符串 frida / gum</span>' +
              '<span class="blk" id="e8">导出符号 frida_agent_main</span>' +
              '<span class="blk" id="e9">D-Bus 通信</span></div>' +
            '<div class="flow-row" style="margin-left:20px"><span class="arrow">↓ 长相也能抹，但"行为"抹不掉</span></div>' +
            '<div class="flow-row"><span class="pill mono">第 4 层</span>' +
              '<span class="blk" id="e10">V8 / JSC 运行时结构</span>' +
              '<span class="blk" id="e11">RWX 匿名内存段</span>' +
              '<span class="blk" id="e12">TracerPid / ptrace 痕迹</span></div>' +
            '<div class="flow-row" style="margin-top:6px;padding-top:10px;border-top:1px dashed var(--line)">' +
              '<span class="pill bad" id="mark">🎯 到第 4 层，用户态已经没牌了</span></div>' +
          '</div>',
        reset: () => {
          ['e1','e2','e3','e4','e5','e6','e7','e8','e9','e10','e11','e12'].forEach(i => S(i, ''));
          CLS('mark', 'pill bad');
          SET('mark', '🎯 到第 4 层，用户态已经没牌了');
        },
        steps: [
          { run: () => { S('e1', 'hot'); },
            note: '<b>第 1 层，第 1 处：进程名。</b>默认的 <span class="mono">frida-server</span> 是独立进程，' +
                  '遍历 <span class="mono">/proc</span> 就能看到它。<b>成本几乎为零的检测，也是成本几乎为零的对抗</b>——改个文件名就没了。' },
          { run: () => { S('e1', 'done'); S('e2', 'hot'); },
            note: '<b>第 1 层，第 2 处：端口。</b>server 默认监听 <b>27042 / 27043</b>。' +
                  'App 可以读 <span class="mono">/proc/net/tcp</span>，也可以直接 connect 一下。' +
                  '<b>注意：这两处是可以一起改掉的</b>（改名 + <span class="mono">--listen</span>），这就是"一个改动覆盖多个暴露点"的最简单形态。' },
          { run: () => { S('e2', 'done'); S('e3', 'hot'); },
            note: '<b>第 1 层，第 3 处：安装路径。</b><span class="mono">/data/local/tmp/frida-server</span> 是教科书级别的默认位置，' +
                  '一次 <span class="mono">stat</span> 就能查完。<b>同样是"卫生习惯"级别的问题。</b>' },
          { run: () => { S('e1', 'done'); S('e3', 'done'); S('mark', 'pill warn'); SET('mark', '⚠️ 第 1 层清干净了——但那只是"名字"'); },
            note: '<b>第 1 层收工。</b>改名 + 换端口 + 换路径，三处暴露一起消失，成本不到五分钟。' +
                  '<span class="miss">但别急着高兴——下一层开始，"改名字"就不管用了。</span>' },
          { run: () => { S('e4', 'hot'); S('e5', 'hot'); },
            note: '<b>第 2 层，第 1–2 处：模块名与内存映射。</b>注入之后，' +
                  '<span class="mono">frida-agent-64.so</span> 这些名字会出现在 <span class="mono">/proc/self/maps</span> 里。' +
                  '<b>这是最常用的检测手段</b>——因为注入必然留下映射，而映射"曾经"带着自己的名字。' },
          { run: () => { S('e4', 'done'); S('e6', 'hot'); },
            note: '<b>第 2 层，第 3 处：线程名。</b>Frida 会在目标进程里建自己的线程：' +
                  '<span class="mono">gum-js-loop</span>、<span class="mono">gmain</span>、<span class="mono">pool-frida</span> 等等。' +
                  '<b>读 <span class="mono">/proc/self/task/*/comm</span> 就能看到。</b>' +
                  '<span class="hit">这一处特别值得记住：它说明"我用了 gadget、没有独立进程"并不等于"我隐身了"——</span>' +
                  '进程内的线程名依然是暴露点。' },
          { run: () => { S('e5', 'done'); S('e6', 'done'); S('mark', 'pill warn'); SET('mark', '⚠️ 第 2 层靠"改名字"已经不够了'); },
            note: '<b>第 2 层的三处，性质变了。</b>模块名<b>可以</b>改（改编译），' +
                  '但 maps 本身是内核给的、线程名是运行时创建的。<br>' +
                  '于是对抗手段从"改自己"升级成<b>"改对方的观察管道"</b>：' +
                  'hook <span class="mono">open</span>/<span class="mono">read</span> 过滤 maps 内容。' },
          { run: () => { S('e7', 'hot'); S('e8', 'hot'); S('e9', 'hot'); },
            note: '<b>第 3 层：内存特征、导出符号、通信协议。</b>检测方不再看名字，而是<b>扫描你代码段里的字节</b>——' +
                  '找 <span class="mono">frida</span>、<span class="mono">gum</span> 这些字符串，找 <span class="mono">frida_agent_main</span> 这个导出符号，' +
                  '或者干脆看通信行为（D-Bus）。<br>' +
                  '<b>这一层只能在"编译期"解决</b>：字符串在二进制里，符号在导出表里，' +
                  '你在运行时 hook 字符串比较函数只能挡住一部分检测手法（见 21.11）。' },
          { run: () => { S('e7', 'done'); S('e8', 'done'); S('e9', 'done'); S('mark', 'pill acc'); SET('mark', '🔧 第 3 层：必须改编译，运行时补不回来'); },
            note: '<b>第 3 层是"自己编译"这条路的动机所在。</b>' +
                  '<span class="mono">strongR-frida-android</span> 这个社区项目把要改的东西列成了一份补丁清单，' +
                  '每一条对应一个特征：RPC 字符串、server 的通信路径、管道名、agent 的 so 名、' +
                  '<span class="mono">frida_agent_main</span> 符号、<span class="mono">gum-js-loop</span> 线程、' +
                  '<span class="mono">gmain</span> 线程。<br>' +
                  '<span class="pill warn">该项目的维护状态与具体补丁编号随上游变化，待核实</span>' },
          { run: () => { S('e10', 'hot'); S('e11', 'hot'); S('e12', 'hot'); },
            note: '<b>第 4 层：行为特征。</b>名字改了、字符串抹了，但还有三样东西是<b>运行时的必然副作用</b>：' +
                  '<b>①</b> JS 引擎（V8 / JSC）在堆上留下的结构特征；' +
                  '<b>②</b> Stalker / 代码 patch 产生的 <b>RWX 匿名内存段</b>（maps 里一行路径都没有的可写可执行段）；' +
                  '<b>③</b> 注入方式本身——用 ptrace 注入就会在 <span class="mono">/proc/self/status</span> 的 <span class="mono">TracerPid</span> 上留痕。' },
          { run: () => { CLS('mark', 'pill bad'); SET('mark', '⛔ 第 4 层说明：用户态对抗有天花板'); },
            note: '<b>收尾。这一层是本章最重要的一课。</b><br>' +
                  '第 1–3 层都可以靠"改名字、改编译、篡改观察管道"解决；<b>第 4 层不行</b>——' +
                  '因为它的证据不是"你是 Frida"，而是"有一块 RWX 匿名内存"、"有进程被 ptrace 过"。' +
                  '<b>你要么接受这个暴露面，要么把观测点下沉到内核（第 13 章），甚至更下（第 6 章）。</b>' }
        ]
      },
      after: T.note('key', '🔑 这一节要带走的一句话',
        '<p style="margin-bottom:0">暴露面<b>不是一维的</b>，它是有层次的：' +
        '<b>名字 → 映射 → 字节 → 行为</b>。<br>' +
        '每往下一层，你能做的改动就越少、代价越大，' +
        '而且<b>没有任何一层能被"一招"清干净</b>。' +
        '后面 21.13 的审计实验，就是让你把这四层变成一个可以算的数字。</p>')
    },

    /* ============================================================ 21.3 */
    {
      h: '21.3', title: 'objection：免脚本的运行时操作台',
      intuition: {
        tag: '直觉模型 · 从"自己造工具"到"用现成的瑞士军刀"',
        body:
          '<p>手写 Frida 脚本，好比每次修东西都自己从钢锭开始打一把螺丝刀。' +
          '而你真正要做的，往往只是"拧一颗螺丝"。</p>' +
          '<p>objection 就是那套已经打好的螺丝刀组：<strong>枚举类、搜索类、监听方法、搜索内存、绕过证书校验</strong>——' +
          '这些动作几乎每个逆向任务都要做一遍，所以它们值得被固化成命令。</p>' +
          '<p>但请把这句话刻在脑子里：<strong>objection 底层就是 Frida</strong>。' +
          '它不是另一个更隐蔽的工具，它只是<b>把 Frida 脚本包了一层命令行</b>。' +
          '所以——<span class="miss">它的特征暴露面，就是 Frida 的暴露面，一处不多、一处不少。</span>' +
          '你用 objection 被检测到，换成手写脚本一样会被检测到，因为被检测的不是脚本，是 Frida 本身。</p>'
      },
      html:
        '<p>objection 的定位很清楚：<b>基于 Frida 的免脚本运行时操作台</b>。' +
        '它把一批高频动作做成了命令，你不需要写 JS，也不需要理解 Frida 的 API。</p>' +
        T.tbl(['你常做的动作', 'objection 命令（示意）', '它底层在干什么'],
          [
            ['看看 App 里有哪些类', '<code>android hooking list classes</code>',
             '走 Java 层反射，枚举已加载的类。<b>注意：只列"已加载"的</b>，没被加载的类看不到'],
            ['搜一个关键词相关的类', '<code>android hooking search classes &lt;关键词&gt;</code>',
             '同样是枚举已加载类，然后做名字匹配'],
            ['列出某个类的所有方法', '<code>android hooking list class_methods &lt;类名&gt;</code>',
             '反射拿方法列表，连签名一起打出来'],
            ['<b>监听一个方法的入参和返回值</b>', '<code>android hooking watch class_method &lt;类&gt;.&lt;方法&gt; --dump-args --dump-return</code>',
             '这就是"免脚本版 Interceptor.attach"，<b>是 objection 最常用的功能</b>'],
            ['监听整个类的所有方法', '<code>android hooking watch class &lt;类名&gt;</code>',
             '对类里每个方法都装一个钩子——<b>小类可用，大类会拖慢甚至卡死</b>'],
            ['在内存里搜字符串 / 字节', '<code>memory search</code> 系列',
             '直接扫进程内存，属于 Native 侧能力'],
            ['绕过常见 root 检测', '<code>android root disable</code>',
             'hook 掉一批常见的 root 检查点'],
            ['<b>绕过 SSL Pinning</b>', '<code>android sslpinning disable</code>',
             '挂掉一批常见证书校验实现（OkHttp / TrustManager 等）'],
            ['看 keystore 里的密钥', '<code>android keystore</code> 系列',
             '反射 AndoidKeyStore 相关 API，把密钥导出或用它做加解密']
          ]) +
        T.note('warn', '⚠️ 上面这些命令<strong>只写示意</strong>，不要照抄进终端',
          '<p style="margin-bottom:0">objection 的子命令名、参数与输出格式<b>随版本变动过</b>' +
          '（尤其是 <code>android hooking</code> 这一族）。<span class="pill warn">命令名与参数请以你安装的那个版本为准，待核实</span><br>' +
          '本章的方法是"知道有这么一类命令、知道它底层是什么"，' +
          '<b>而不是背命令行</b>——背下来的命令会过期，理解底层不会。</p>') +
        T.card('为什么必须知道"它底层是 Frida"',
          '<p>这条认知直接决定你<b>遇到失败时往哪查</b>。三种典型情形：</p>' +
          '<p><b>① <code>watch class</code> 完全没输出</b><br>' +
          '不是 objection 坏了，是<b>类根本没被加载</b>。命令走的是"枚举已加载类"，' +
          '一个还没被用到的类不在里面。<b>先去界面上把那个功能点一遍，再回来 watch。</b></p>' +
          '<p><b>② 类找不到 / ClassNotFoundException 同款错误</b><br>' +
          '这就是第 2、4 章讲的<b>加载器问题</b>：加固 App 的业务类归壳的 DexClassLoader 管，' +
          'objection 默认用的也是 App 的默认加载器。<b>这是 Frida 层面的问题，不是 objection 层面的问题。</b></p>' +
          '<p style="margin-bottom:0"><b>③ 一 attach 上去 App 就退出</b><br>' +
          'App 检测到 Frida 了。换工具没用——<b>objection 的特征就是 Frida 的特征</b>。<br>' +
          '唯一的出路是 21.10–21.14 那几节的去特征工作。' +
          '<span class="hit">这也是本章最重要的一条判断：不要把"换个工具"当成对抗手段。</span></p>'),
      quiz: {
        id: 'q21-1', chapter: 21, answer: 2,
        stem: '你用 objection 的 <code>android hooking watch class_method</code> 监听一个加密方法，命令执行成功、没有任何报错，' +
              '但你操作完 App 的界面后日志里一条都没有。最可能的原因是什么？',
        options: [
          { t: 'objection 的版本太旧，这个子命令在当前版本上已经失效',
            why: '版本问题会报错或提示未知命令，不会"执行成功但零输出"。把"没输出"归因到版本，会让你不停地换工具而不去找真正的原因。' },
          { t: 'App 检测到了 Frida，主动把日志通道掐断了',
            why: '检测到 Frida 通常表现为进程退出、崩溃或行为异常，而不是"只针对某一条 hook 静默"。而且这个 App 既然能正常操作，说明 Frida 会话是活着的。' },
          { t: '这个类的这个方法从来没被执行过——你监听的调用路径没有被触发',
            why: '正确。objection 的 watch 只是装钩子，装上了不等于会被调用。要么是你操作的功能走的不是这条路径（比如走的是另一个重载、或另一个类），要么这个方法在这次会话里压根没被调用到。解决方向是"先把功能跑起来，再用批量打点（r0tracer）确认哪个方法真的被调了"。' },
          { t: '需要先执行 <code>android root disable</code>，否则 watch 不会生效',
            why: '这两件事没有任何依赖关系。root 检测绕过和 Java 方法监听是两套独立机制，把它们串起来只会让你把无关动作当成必做步骤。' }
        ],
        explain:
          '<p><b>这是 objection 使用中最高频的"假故障"。</b>命令成功 + 零输出，只有一个解释：' +
          '<b>钩子装上了，但被钩的方法没有被调用。</b></p>' +
          '<p>排查顺序应该固定成这三步：</p>' +
          '<p><b>① 确认方法真的存在</b>——<code>list class_methods</code> 看签名，' +
          '确认你 hook 的是那个重载（Java 方法重载很常见，hook 错了重载是完全无声的）。</p>' +
          '<p><b>② 确认方法真的被调用</b>——换 r0tracer 对整个类批量打点（见 21.5），' +
          '看这次操作到底碰了哪些方法。<b>不要用"猜"来选 hook 点。</b></p>' +
          '<p><b>③ 确认加载器对不对</b>——如果是加固 App 且连类都列不出来，' +
          '那是第 2、4 章的加载器问题，不是 objection 的问题。</p>' +
          '<p style="margin-bottom:0"><b>元原则：</b>"工具没反应"几乎从来不是工具的问题，' +
          '而是<b>你对目标的行为假设错了</b>。先验证假设，再怀疑工具。</p>'
      }
    },

    /* ============================================================ 21.4 */
    {
      h: '21.4', title: 'r0capture：不碰证书，在 socket 层直接拿明文',
      html:
        '<p>第 23 章会完整讲抓包的原理与协议分析。这一节只回答一个问题：' +
        '<b>为什么 r0capture 能绕过大部分证书校验，以及它在什么情况下必然失效。</b></p>' +
        T.note('key', '🔑 一句话定位',
          '<p style="margin-bottom:0">传统抓包（Charles / mitmproxy）是<b>中间人</b>：你必须让 App 信任你的证书。' +
          'r0capture 走的是完全不同的路——<b>它不插进通信中间，它站在 App 自己的进程里，' +
          '在数据被加密之后、被写进 socket 之前（或反过来）把明文抄一份。</b></p>') +
        '<p>把两条路线并排看，差别一目了然：</p>' +
        T.tbl(['', '代理抓包（中间人）', 'r0capture（进程内观测）'],
          [
            ['<b>数据经过谁</b>', '你 → App 把流量发给你 → 你再转发给服务器', '<b>数据不经过任何人</b>，App 直连服务器'],
            ['<b>证书这件事</b>', '必须让 App 信任你的 CA。<b>证书固定（pinning）就是专门用来打这一招的</b>',
             '<b>完全不需要证书</b>——它在 SSL 读写函数的出口/入口抄明文'],
            ['<b>被检测的点</b>', '网络层：代理设置、证书链、证书是否来自系统 CA',
             '进程内：<b>又回到 Frida 特征</b>（见 21.3 最后那条判断）'],
            ['<b>加固是否有影响</b>', '无关', 'README 明确写了"无视加固"，因为 hook 的是系统层的 SSL 实现'],
            ['<b>能不能拿到密文之外的东西</b>', '只能拿到被代理的那部分流量', '能同时给出发包/收包函数的调用栈，<b>帮你定位"是哪个方法在发这个包"</b>']
          ]) +
        T.card('它到底 hook 了什么（理解这一步，才能理解它的边界）',
          '<p>r0capture 的抓包点不是"某一个 App 的加密函数"，而是<b>系统/框架层面的 SSL 读写路径</b>：' +
          'Java 侧的 <code>SSL_read</code> / <code>SSL_write</code>、以及 Native 侧对应的一层。' +
          '它把这些函数的<b>参数（明文指针）和返回值</b>记录下来，再结合 socket 信息还原五元组、拼成 pcap。</p>' +
          '<p style="margin-bottom:0">所以它的能力边界非常好推：' +
          '<b>凡是最终会走到系统 SSL 实现的，它都能抓；凡是绕开系统 SSL 实现的，它都抓不到。</b></p>') +
        T.note('bad', '🔥 它什么时候会失效（这一段比它"能做什么"更重要）',
          '<p>直接照抄作者在 README 里自述的局限——<b>这不是我推测的，是项目自己写的</b>：</p>' +
          '<p><b>① 自研 SSL 框架</b>：部分大厂或框架使用自身的 SSL 实现（README 点名了 <b>WebView、小程序、Flutter</b>），' +
          '这部分"目前暂未支持"。<br>' +
          '<b>② 融合 App</b>：本质上已经不属于安卓 App、没有使用安卓系统框架的，无法支持。<br>' +
          '<b>③ HTTP/2、HTTP/3</b>：暂不支持——这些协议栈由 App 自带，无法做通用 hook。<br>' +
          '<b>④ 模拟器</b>：README 建议"珍爱生命、使用真机"（模拟器架构与实现复杂）。<br>' +
          '<b>⑤ 多进程</b>：暂未添加 <code>:service</code> / <code>:push</code> 等子进程支持，' +
          'README 提示可以用 Frida 的 Child-gating 自行补上，并提醒多进程之后要考虑 pcap 写入锁。<br>' +
          '<b>⑥ 环境限制</b>：README 写明"仅限安卓平台"、并给出"禁止使用模拟器"的表述。</p>' +
          '<p style="margin-bottom:0"><b>把 ①②③ 归纳成一句话：</b>' +
          'r0capture 的抓包点<b>寄生在系统 SSL 实现上</b>。' +
          '当 App 自带一份 SSL 实现（Flutter 的 BoringSSL、小程序的私有网络栈、WebView 自己的网络层）时，' +
          '系统的 <code>SSL_read</code>/<code>SSL_write</code> 根本没有被调用——<span class="miss">hook 点从来没被执行过，自然一条都抓不到。</span><br>' +
          '这时你要么去找那个自研实现自己的读写函数（第 23 章的方法），' +
          '要么回到第 7 章的路子把 so 拖进 unidbg 里单独跑。</p>') +
        T.note('warn', '⚠️ 版本与搭配关系会变',
          '<p style="margin-bottom:0">r0capture 的 README 里记了若干次版本更新与"推荐搭配"（哪个 Frida 版本配哪个安卓版本）。' +
          '<b>这些搭配关系随版本变化很快，请以仓库 README 当时的说明为准。</b>' +
          '<span class="pill warn">具体版本号不在此处断言，待核实</span></p>')
    },

    /* ============================================================ 21.5 */
    {
      h: '21.5', title: 'r0tracer：批量打点，再从几万行里捞出那一个函数',
      html:
        '<p>如果你不知道要 hook 什么，objection 帮不了你——它需要你给出类名和方法名。' +
        '而 r0tracer 的定位正好补上这个缺口：' +
        '<b>不问你 hook 什么，先把一整批类的方法全打上点，让运行时的真实调用顺序自己浮现出来。</b></p>' +
        '<p>r0tracer 的 README 把它自己的定位写得很直白——<b>"精简版 objection + Wallbreaker"</b>，' +
        '并且明确列出了它相对 objection 的增量：<b>支持延时 spawn、支持批量 hook 类/方法/构造函数、' +
        '以及 hook 之后能打印实例的字段值</b>。这三点就是"批量打点"这个能力的具体内容。</p>' +
        T.tbl(['能力', '它解决什么问题', '代价'],
          [
            ['按黑白名单批量 hook 一个类的所有方法', '<b>你不知道该 hook 哪个方法</b>，就让类里每个方法都开口说话', '输出量爆炸；大 App 上可能拖到不可用'],
            ['命中后打印参数 / 返回值 / 调用栈 / 字段值', '省掉手写那 20 行模板代码', '慢。打印调用栈尤其慢'],
            ['切换 ClassLoader', '加固 App 里业务类归壳的加载器管（第 2、4 章）', '需要先知道该切到哪个'],
            ['把日志输出到文件便于搜索', '几万行输出在终端里是没法看的，必须落盘再筛', '文件会很大']
          ]) +
        T.note('key', '🔑 批量打点的正确姿势：先撒网，再用过滤器收网',
          '<p>新手用 r0tracer 的典型失败是：打开 <code>hookALL()</code>，跑一遍，' +
          '得到 8 万行输出，然后<b>从头开始读</b>。</p>' +
          '<p style="margin-bottom:0">这是错的。正确姿势是<b>两级收敛</b>：<br>' +
          '<b>第一级——在打点的时候收窄</b>：只 hook 目标类，只 hook 目标线程，不去 hook 整个 App。<br>' +
          '<b>第二级——在输出上用过滤器收敛</b>：把日志落盘，然后用下面五种过滤器交叉筛。</p>') +
        T.grid(2, [
          '<div class="card"><div class="card-title">过滤器 ①：只看首次调用</div>' +
          '<p>同一个方法在一次会话里可能被调用上万次（循环里、轮询里）。' +
          '<b>而"它被调用过"这个事实只需要看一次。</b><br>' +
          '做法：用方法签名做 key 建一个 Map 去重，只打印第一次。<br>' +
          '<span class="hit">这一条通常能砍掉 90% 以上的输出</span>，而且几乎不损失信息——' +
          '你找的是"调用关系"，不是"调用次数"。</p></div>',
          '<div class="card"><div class="card-title">过滤器 ②：只看特定线程</div>' +
          '<p>加密往往发生在<b>少数几个线程</b>上（网络线程、加解密线程、JNI 回调线程）。' +
          '把线程 id 打出来，然后只看那一个。<br>' +
          '<b>怎么知道是哪个线程？</b>先不做任何过滤跑一遍短会话，' +
          '看目标方法出现在哪个 tid 上——<b>用一次全量输出去换一个精确的过滤条件，是划算的。</b></p></div>',
          '<div class="card"><div class="card-title">过滤器 ③：只看入参里含特定字符串</div>' +
          '<p>这是<b>性价比最高</b>的过滤器。因为你的目标动作往往带有一个可识别的特征：' +
          '一个 URL 片段、一个固定的 salt 前缀、一个已知的请求体字段名。<br>' +
          '<b>先用它筛出"哪些方法看得到这个字符串"</b>，再把范围缩到那几个方法。' +
          '用你的业务语义去筛运行时日志，比读调用栈快得多。</p></div>',
          '<div class="card"><div class="card-title">过滤器 ④：按调用深度剪枝</div>' +
          '<p>一个方法后面跟着几百层调用，绝大多数是 Java 标准库（<code>String</code>、' +
          '<code>Arrays</code>、<code>MessageDigest</code> 的内部实现）。<br>' +
          '<b>把 <code>java.*</code>、<code>android.*</code>、<code>com.android.*</code> 这些前缀的帧整段剪掉</b>，' +
          '只留业务包名的帧。剩下的往往就是真正的关键路径。</p></div>',
          '<div class="card"><div class="card-title">过滤器 ⑤：只看耗时异常的方法</div>' +
          '<p>真正的加密运算是有成本的。把每个方法的进入/退出时间打出来，' +
          '<b>按耗时排序扫一眼</b>：耗时突然大起来的那一段，往往就是"数据在这里被处理"。<br>' +
          '<span class="pill warn">注意：这是把双刃剑——你为了看耗时给方法加了钩子，钩子本身也会改变耗时，待核实具体误差量级</span></p></div>',
          '<div class="card"><div class="card-title">⛔ 不要做的三件事</div>' +
          '<p><b>① 不要开全量 Stalker</b>——指令级追踪会让 App 慢几十倍，' +
          '既可能直接卡死，又会触发耗时检测（第 10、13 章的检测点⑦）。<br>' +
          '<b>② 不要在回调里做重活</b>——字符串拼接、格式化、写文件都要少做，先塞内存缓冲，最后统一导出。<br>' +
          '<b>③ 不要用"猜"选 hook 点</b>——猜一次的成本，比跑一次批量打点高得多。</p></div>'
        ]) +
        T.note('', '📌 出问题往哪查',
          '<p style="margin-bottom:0"><b>日志一条都没有</b> → 类没被加载，或加载器不对（回到第 2、4 章）。<br>' +
          '<b>日志有，但目标方法一次都没出现</b> → 你操作的功能没走到那条路径；换个操作再跑一次。<br>' +
          '<b>App 直接卡死 / ANR</b> → hook 的面太宽，或回调里做了重活。<br>' +
          '<b>同一个方法在两个不同线程上各出现一次</b> → 这是线索，不是噪音：说明它被并发调用了。</p>'),
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">你现在有了一个<b>不依赖猜测的定位流程</b>：' +
        '批量打点 → 落盘 → 用"首次/线程/字符串/深度"四个过滤器交叉收敛 → <b>锁定那一个函数</b> → ' +
        '再回头用 objection 或手写脚本精确 hook 它。<br>' +
        '<span class="hit">21.13 的实验就是把这个流程做成一道可以动手做的题。</span></p>')
    },

    /* ============================================================ 21.6 */
    {
      h: '21.6', title: 'Frida Invoke Java：从"能看见"到"能指挥"',
      html:
        '<p>前面所有内容（objection、r0capture、r0tracer）都属于同一个范式：' +
        '<b>App 先动，你跟着看</b>。而一旦你需要的东西 App 永远不会主动做，这个范式就撞墙了。</p>' +
        '<p>典型场景：<b>你想知道"给定这个输入，加密结果是什么"</b>，' +
        '但 App 只会在你点击"登录"时用它自己的输入去调那个函数。' +
        '<b>你没法传自己的参数进去。</b></p>' +
        T.note('key', '🔑 主动调用（Invoke Java）改变的是什么',
          '<p style="margin-bottom:0">它把 Frida 从"观察者"变成"<b>调用者</b>"：' +
          '不再等 App 调那个方法，而是<b>你自己构造参数、自己发起调用、自己取回结果</b>。<br>' +
          '这就是第 2 章 FART"主动调用"思路的用户态版本——' +
          '<b>观测量不够的时候，就去制造一次调用。</b></p>') +
        T.tbl(['能力', '关键 API（概念）', '最容易踩的坑'],
          [
            ['拿到一个类', '<code>Java.use("包名.类名")</code>', '加载器问题（第 2、4 章）；内部类要用 <code>$</code> 连接（如 <code>Outer$Inner</code>）'],
            ['<b>构造一个对象</b>', '<code>Cls.$new(参数…)</code>', '必须匹配一个真实存在的构造函数重载；参数类型不能靠"看起来像"'],
            ['把父类型转成子类型', '<code>Java.cast(实例, 目标类)</code>', '接口 / 抽象类拿到的实例必须 cast 到实际实现类才能调它的方法'],
            ['读 / 写实例字段', '<code>实例.字段名.value</code>', '<b>字段名是混淆过的</b>时只能靠类型和赋值关系反推'],
            ['构造 Java 数组', '<code>Java.array(\'int\', [...])</code>', 'Java 数组不是 JS 数组；类型名要写对（<code>byte</code> / <code>char</code> 混淆会导致结果不对）'],
            ['字符串 ↔ 字节', '<code>Java.use(\'java.lang.String\')</code> / <code>getBytes</code>', '<b>编码</b>。同一个 <code>String</code> 用不同 charset 转字节，密文完全不同'],
            ['<b>动态造一个类</b>', '<code>Java.registerClass({...})</code>', '要提供 name / superClass / implements / methods。常用于<b>实现一个接口当回调</b>'],
            ['实现一个接口', '<code>Java.registerClass</code> 里写 <code>implements</code>', '接口方法名与签名必须完全匹配，否则运行时报错'],
            ['调用静态方法', '<code>Cls.方法名(参数…)</code>', '静态方法直接挂在 <code>Java.use</code> 返回的对象上']
          ]) +
        T.note('warn', '⚠️ 签名是主动调用的生命线',
          '<p>objection 和 r0tracer 不需要你懂签名——它们把签名打给你看。' +
          '但<b>主动调用必须你自己把签名写对</b>，因为 <code>$new</code> 和重载方法都靠参数类型来选具体的那一个。</p>' +
          '<p style="margin-bottom:0">记不准就用两步走的办法：<b>先用 r0tracer 把真实调用打出来，' +
          '把它的参数类型与返回值签牌照抄下来，再照着构造。</b>' +
          '<span class="hit">这是"自动化工具 + 主动调用"最实用的组合方式。</span></p>') +
        T.card('为什么"通用工具"在这里帮不上忙（呼应 21.1）',
          '<p>主动调用的每一步都依赖<b>这个 App 的具体逻辑</b>：这个类叫什么、构造它需要哪些参数、' +
          '那个参数是 <code>byte[]</code> 还是 <code>String</code>、编码是不是 UTF-8、' +
          '返回的是 Base64 还是裸字节。</p>' +
          '<p style="margin-bottom:0"><b>这些信息没有任何通用工具能替你猜。</b>' +
          '这就是 21.1 那条边界线在实操层面的样子：' +
          '<span class="miss">工具帮你找到它，但构造它、理解它，只能是你自己。</span></p>')
    },

    /* ============================================================ 21.7 */
    {
      h: '21.7', title: '代码推演：构造一个复杂参数去调用加密函数',
      html:
        '<p>下面这个推演是 21.6 的实战版。目标是：<b>不点 App 的按钮，自己构造参数，' +
        '直接调用它的加密方法，拿到密文。</b></p>' +
        '<p>推演里的类名、方法名、算法都是<b>示意</b>，但每一步的判断依据都是真实的。</p>',
      stepper: {
        title: '主动调用推演：构造参数 → 调用 → 取回结果',
        lines: [
          {
            code: '<span class="c">// 目标（示意）：com.example.sec.SignHelper#sign(String data, byte[] key, int mode)</span>',
            note: '<b>第 0 步：先明确你要调用的目标签名。</b>注意它有三个参数、类型各不相同，' +
                  '还有一个返回值。<b>这三样必须在动手之前就确定</b>——方法是"用 r0tracer 打点看真实调用"，' +
                  '而不是"凭印象写"。<br>如果这一步就靠猜，后面每一步都会错，而且错得很安静。',
            state: { '参数个数': '3', '返回类型': '未知（待确认）', '调用是否发起': '否' }
          },
          {
            code: '<span class="k">var</span> Sign = <span class="f">Java.use</span>(<span class="s">"com.example.sec.SignHelper"</span>);',
            note: '<b>取到类。</b>如果这一步抛 <code>ClassNotFoundException</code>，' +
                  '<b>不要改类名</b>——去走第 2、4 章的加载器切换流程。' +
                  '加固 App 上，这一步失败的概率远高于类名写错的概率。',
            state: { '类已取到': '✅', 'ClassLoader': '默认（如需切换见第 2 章）', '调用是否发起': '否' }
          },
          {
            code: '<span class="k">var</span> Inst = Sign.<span class="f">$new</span>();   <span class="c">// 无参构造</span>',
            note: '<b>构造实例。</b>这里是第一个常见卡点：<b>构造函数可能是有参的</b>，' +
                  '也可能它根本是个静态方法（那就不用 <code>$new</code>）。<br>' +
                  '<b>怎么判断？</b>看两个地方：<code>list class_methods</code> 里有没有 <code>&lt;init&gt;</code> 条目、' +
                  '以及它是不是 <code>static</code>。',
            state: { '实例': 'Inst（新构造）', '构造函数': '无参', '调用是否发起': '否' }
          },
          {
            code: '<span class="k">var</span> data = <span class="f">Java.use</span>(<span class="s">"java.lang.String"</span>).$new(<span class="s">"username=admin&amp;ts=1700000000"</span>);',
            note: '<b>构造第一个参数：一个 Java String。</b>注意——<b>不能直接把 JS 字符串传进去</b>，' +
                  '要用 <code>Java.use("java.lang.String").$new(...)</code> 显式构造。<br>' +
                  '字符串内容是<b>你自己控制的输入</b>，这正是主动调用的价值所在：' +
                  '<b>你可以传 App 永远不会传的输入。</b>',
            state: { 'data': 'Java String（23 字符，UTF-16）', '编码': '待定（见下一步）', '调用是否发起': '否' }
          },
          {
            code: '<span class="k">var</span> keyBytes = <span class="f">Java.array</span>(<span class="s">"byte"</span>, [<span class="n">0x31</span>, <span class="n">0x32</span>, <span class="n">0x33</span>, <span class="n">0x34</span>]);',
            note: '<b>构造第二个参数：一个 Java <code>byte[]</code>。</b>两个坑：' +
                  '<b>①</b> 必须用 <code>Java.array</code>，JS 数组不是 Java 数组；' +
                  '<b>②</b> 元素范围是<b>有符号字节</b>，写 <code>0xFF</code> 时要注意实际存入的值（一般按 8 位截断）。<br>' +
                  '这里的 key 是"示意"的——实战里 key 往往来自别处（设备信息、服务端下发、另一个方法的返回值），' +
                  '<b>那就先把它 dump 出来，再喂进来。</b>',
            state: { 'keyBytes': 'byte[4]', '长度': '4', '调用是否发起': '否' }
          },
          {
            code: '<span class="k">var</span> out = Inst.<span class="f">sign</span>(data, keyBytes, <span class="n">1</span>);',
            note: '<b>发起调用——这一步才是"指挥 App"。</b><br>' +
                  '如果报"参数类型不匹配"，说明<b>你猜错了签名</b>（比如第二参数其实是 <code>String</code>）。' +
                  '<b>回去用 r0tracer 看真实调用的类型，不要在这里试错。</b><br>' +
                  '如果这一步<b>直接崩溃</b>，常见原因是：它内部依赖了某个还没初始化的状态' +
                  '（比如先要调一个 <code>init()</code>），或它内部做了自己的反调试检查。',
            state: { 'out': '待取回', '返回值类型': '取决于真实签名', '调用是否发起': '✅ 已发起' }
          },
          {
            code: '<span class="c">// out 可能是 String，也可能是 byte[] —— 先判断再取值</span>\n' +
                  '<span class="k">var</span> s = out.$className ? <span class="f">String</span>(out.$className) : <span class="s">"?"</span>;',
            note: '<b>先确认返回值的真实类型，再谈怎么读。</b>这一步非常关键，因为：<br>' +
                  '<b>返回 String</b> → 直接 <code>String(out)</code> 或 <code>out.toString()</code>；<br>' +
                  '<b>返回 byte[]</b> → 必须逐元素读并转成十六进制，<b>不能当字符串打印</b>（会有不可见字节、负数）。<br>' +
                  '<span class="hit">"返回了 byte[] 却当字符串打印"是主动调用中最常见的"结果看起来不对"的来源。</span>',
            state: { 'out 真实类型': '待判定', '读取方式': '按类型分支', '调用是否发起': '已发起' }
          },
          {
            code: '<span class="c">// byte[] 的正确读法：逐元素 → 十六进制</span>\n' +
                  '<span class="k">var</span> hex = <span class="s">""</span>;\n' +
                  '<span class="k">for</span> (<span class="k">var</span> i = <span class="n">0</span>; i &lt; out.length; i++) {\n' +
                  '  <span class="k">var</span> b = out[i] &amp; <span class="n">0xff</span>;              <span class="c">// ★ 关键：转无符号</span>\n' +
                  '  hex += (b &lt; <span class="n">16</span> ? <span class="s">"0"</span> : <span class="s">""</span>) + b.<span class="f">toString</span>(<span class="n">16</span>);\n' +
                  '}',
            note: '<b>把结果正确落地。</b>注意标了 ★ 的那一行：<b>Java 的 byte 是有符号的</b>，' +
                  '读到 <code>-1</code> 时要按 <code>&amp; 0xff</code> 转成 <code>0xff</code>。' +
                  '忘了这一步，你的十六进制串里会出现负号和缺位，' +
                  '<b>而且看起来"像是算法不对"，其实只是读错了。</b><br>' +
                  '<span class="miss">这类"读值 bug 伪装成算法 bug"，是主动调用里最消耗时间的坑。</span>',
            state: { '密文（十六进制）': '已得到', '算法还原': '下一步', '调用是否发起': '已完成' }
          },
          {
            code: '<span class="c">// 换输入再跑一次：验证这是"可复现的纯函数"还是"带随机性的"</span>\n' +
                  '<span class="c">// 同样输入跑两次，比较两次输出</span>',
            note: '<b>收尾动作：先验证可复现性。</b>同样的输入跑两次：<br>' +
                  '<b>结果相同</b> → 它是确定性算法，可以继续做第 8、9 章的算法还原；<br>' +
                  '<b>结果不同</b> → 里面掺了时间戳、随机数或设备信息。<b>先找到那个随机源并把它固定住</b>' +
                  '（hook <code>Random</code> / <code>currentTimeMillis</code>），否则后面所有比对都是白做。<br>' +
                  '<span class="hit">这一步很多人跳过，然后在算法比对上浪费一整天。</span>',
            state: { '两次结果': '待比较', '若不同则查': 'Random / 时间 / 设备信息', '下一步': '转第 8、9 章算法还原' }
          }
        ]
      },
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">主动调用的流程可以固化成一个固定顺序：' +
        '<b>确认签名 → 取类 → 构造实例 → 逐个构造参数（注意类型与编码）→ 发起调用 → ' +
        '先判返回类型再读数 → 验证可复现性。</b><br>' +
        '这条链上<b>每一步的失败都有独特的现象</b>（类找不到 / 参数不匹配 / 直接崩溃 / 结果像算法错），' +
        '认出是哪一步，比把整段脚本重写一遍快得多。</p>')
    },

    /* ============================================================ 21.8 */
    {
      h: '21.8', title: '用 Frida 让抓包"能成"：与第 23 章的分工',
      html:
        '<p>本节要划一条清晰的界线，避免和第 23 章（抓包全解与协议分析）重复。</p>',
      term: {
        title: '本节的分工边界',
        lines: [
          { t: 'e', s: 'if (task == "搞懂 HTTPS 握手、证书链、TLS 记录结构") {' },
          { t: 'o', s: '  → 第 23 章。本章一个字都不讲。' },
          { t: '', s: '' },
          { t: 'e', s: '} else if (task == "让抓包这件事能成功") {' },
          { t: 'o', s: '  → 本章 21.4（r0capture 的定位与失效条件）' },
          { t: 'o', s: '  → 本章 21.9（hook dlopen / nop 掉校验函数）' },
          { t: '', s: '' },
          { t: 'e', s: '} else if (task == "拆协议、复现请求、做参数溯源") {' },
          { t: 'o', s: '  → 第 23 章。那是"拿到流量之后"的工作。' },
          { t: 'w', s: '记住：本章负责"把水引出来"，第 23 章负责"分析水里的东西"' }
        ]
      },
      after:
        T.tbl(['问题', '归哪一章', '为什么这样分'],
          [
            ['HTTPS 握手、证书链、TLS 记录结构', '<b>第 23 章</b>', '这是协议知识，与 Frida 无关'],
            ['单向校验 / 双向校验（客户端证书）的区别', '<b>第 23 章</b>', '同上'],
            ['证书固定（pinning）的实现方式与分类', '<b>第 23 章</b>', '同上'],
            ['"App 不信任我的代理证书，抓不到"', '两边都要：<b>本章讲为什么 r0capture 不碰证书</b>，第 23 章讲证书层怎么处理', '本章给你一个绕开证书的思路（进程内观测），第 23 章给你证书本身的知识'],
            ['"它用的是自研 SSL / Flutter / 小程序，r0capture 抓不到"', '<b>本章给判断，第 23 章给方法</b>', '本章教你<b>怎么判断"抓不到的原因不是配置问题"</b>；具体怎么去 hook 它自己的读写函数，是第 23 章的 socket/SSL 溯源'],
            ['"我要用 Frida hook 掉它的证书校验"', '<b>本章 21.9</b>', '本质是 hook 一个校验函数，属于"让抓包能成"的手段'],
            ['"我要复现这个请求、还原参数"', '<b>第 23 章</b>', '拿到流量之后的分析工作']
          ]) +
        T.note('key', '🔑 一张最有用的判断表：抓不到包时，先分清是哪一类失败',
          '<p>抓包失败至少有四类完全不同的原因，<b>而它们的解法互不相干</b>。' +
          '先用这张表定位类别，再决定翻哪一章：</p>' +
          T.tbl(['现象', '真正的原因', '该走哪条路'],
            [
              ['代理一切正常，但 App 报网络错误', 'App 在做证书校验（pinning）',
               '<b>本章</b>：换 r0capture（不碰证书），或 hook 掉校验函数（21.9）；<br><b>第 23 章</b>：证书链与双向校验的细节'],
              ['抓到了 HTTP，但业务接口一条都没有', '业务接口走的是自研 SSL / 私有网络栈',
               '<b>本章</b>：接受"r0capture 不适用"这个结论；<br><b>第 23 章</b>：去定位它自己的 socket / SSL 读写点'],
              ['App 一开抓包工具就闪退', 'App 检测到代理或 Frida',
               '<b>本章</b>：这是 Frida 特征问题，走 21.10–21.14；<br>代理检测本身则属于第 23 章的环境检测部分'],
              ['能看到请求，但 body 是密文', '<b>这不是抓包问题，是算法问题</b>',
               '<b>本章 21.6 / 21.7</b> 主动调用加密函数；<br><b>第 8、9 章</b>还原算法']
            ])) +
        T.note('warn', '⚠️ 一个常见误判',
          '<p style="margin-bottom:0">很多人把"第四类"（body 是密文）当成抓包失败，' +
          '于是不停地换抓包工具、加证书、试各种 pinning bypass。<br>' +
          '<b>但抓包工具已经完成任务了——你的流量本来就长这样。</b>' +
          '密文是 App 自己加密的结果，<span class="miss">换一百个抓包工具也只会得到同样的密文。</span><br>' +
          '这时候该做的是<b>主动调用它的解密/加密函数</b>（21.6、21.7），而不是继续折腾抓包环境。</p>')
    },

    /* ============================================================ 21.9 */
    {
      h: '21.9', title: 'nop 掉校验函数：为什么保留调用时序很重要',
      html:
        '<p>当你要做的事情卡在一个"检测函数"上时，有两种截然不同的处理哲学：' +
        '<b>让检测函数失效</b>，或者<b>抢在检测代码运行之前完成替换</b>。本节讲这两招。</p>',
      intuition: {
        tag: '直觉模型 · 拆掉门铃，还是在门铃装上前就进门',
        body:
          '<p><b>nop 函数</b>像是把门铃的线剪断：门铃还在那儿，但按下去不会响。' +
          '关键在于——<strong>按门铃这个动作依然发生，只是没有后果</strong>。' +
          '很多检测逻辑的价值在于"按下之后触发什么"，剪断那根线，检测就完成了它的表演却没有伤害。</p>' +
          '<p><b>hook dlopen</b> 则完全不同：它不是剪线，而是<strong>守在大门口，在门铃还没被装上的时候就进屋</strong>。' +
          'so 被加载的那一刻是<b>所有检测代码的起点</b>——还没跑起来，也就还没开始检测。' +
          '这一招的完整用法放在 21.13（它同时也是 ModuleMap 的数据来源）。</p>'
      },
      after:
        T.card('第一招：nop 一个函数——为什么"保留调用时序"很重要',
          '<p><b>nop（空操作）一个函数</b>的常见做法是：在函数入口处直接把返回值写死，然后立刻返回，' +
          '不执行函数体。表现出来就是"这个函数被调用了，但什么都没做"。</p>' +
          '<p><b>为什么不是"让它不被调用"？</b>因为改了调用关系，副作用可能比改返回值大得多：</p>' +
          '<ul>' +
          '<li>调用它的那一段代码可能<b>依赖它的返回值</b>做分支判断，你不调用就等于没给返回值；</li>' +
          '<li>调用点周围的<b>时序</b>可能是别的检测的一部分（比如"这个检查必须在某个时间窗内完成"）；</li>' +
          '<li>有些校验是<b>成对</b>的（检查 + 上报），少了一次调用会让后面的逻辑拿到空状态。</li>' +
          '</ul>' +
          '<p style="margin-bottom:0"><b>所以 nop 的正确理解是：保留"被调用"这个事实，只消灭"生效"这个结果。</b>' +
          '<span class="hit">第 10 章那个案例里"让 <code>sub_432774</code> 恒返回 0"，就是这个思路的 native 版。</span></p>') +
        T.tbl(['做法', '改了什么', '保留了什么', '适用情形'],
          [
            ['<b>让函数恒返回某个值</b>', '函数的输出', '<b>调用发生时序</b>、调用次数',
             '检查函数：让它永远"没发现问题"'],
            ['<b>整体 nop（直接返回）</b>', '函数的全部行为', '调用发生时序',
             '上报 / 杀进程 / 破坏性函数：让它什么都不做'],
            ['<b>替换实现（转调自己的逻辑）</b>', '函数行为的一部分', '其余行为',
             '你既想观察又想放行（例如过滤返回值再转调原函数）'],
            ['<b>彻底不调用</b>', '调用关系本身', '<b>几乎什么都没保留</b>',
             '<b>不推荐</b>。除非你确定调用方不依赖它的副作用']
          ]) +
        T.note('', '📌 nop 之后的排查顺序',
          '<p style="margin-bottom:0"><b>nop 之后 App 行为异常</b> → 说明这个函数的副作用被别处依赖了。' +
          '改用"转调自己的逻辑"，把返回值改成"看起来正常"的值再转调原实现。<br>' +
          '<b>nop 之后毫无变化</b> → 说明你 nop 的不是那个关键点。检测可能有多处（第 10 章案例里核心原语被复用 4 处），' +
          '或者真正的判据在别的地方。<b>这时不要继续 nop 更多函数，先去找"被复用次数最多的那个原语"。</b></p>') +
        T.note('key', '🔑 第二招（hook dlopen）为什么放到 21.13',
          '<p style="margin-bottom:0">hook <code>dlopen</code> 既是"把介入点前移"的对抗手段，' +
          '也是"画出模块加载关系图"的数据来源——<b>而后者才是它在实战里更常用的形态</b>。<br>' +
          '所以这一招的完整用法（能做什么、两个现实问题、怎么用它的输出定位 so）' +
          '统一放在 <b>21.13 ModuleMap</b> 那一节讲，避免在同一个概念上重复两遍。</p>'),
      quiz: {
        id: 'q21-2', chapter: 21, answer: 1,
        stem: '一个 App 在进入主界面后检测 Frida，检测到就退出。你在 Java 层确认了检测逻辑所在的方法，' +
              '但用 <code>Interceptor.attach</code> 挂上去之后，<b>那个方法一次都没有被触发</b>。最合理的下一步是什么？',
        options: [
          { t: '把 hook 的代码换成 Java 层反射调用，避免使用 Native hook',
            why: '换 API 不能解决"我的钩子挂得太晚"这个时序问题。而且如果目标的检测本身在 Native 层，Java 层反射根本看不见它。' },
          { t: '先确认检测代码的运行时机是不是早于我的注入——如果是，改用 spawn 模式，并用 hook dlopen 之类的手段把介入点前移',
            why: '正确。"钩子一次都没触发"最经典的原因不是钩子写错了，而是<b>代码在你的钩子生效之前就执行完了</b>。先验证时序，再讨论逻辑。' },
          { t: '把已确认的检测方法整体 nop 掉，这样即使它运行了也没有后果',
            why: '方向对但前提没满足——你还没能"运行到它"就挂了，nop 需要能改到那段代码（通常也要在它被调用前完成替换）。必须先解决介入时机，nop 才谈得上。' },
          { t: '放弃 Frida，改用 Xposed / LSPosed 模块来做',
            why: '换框架同样要面对时序问题，而且会引入新的特征（第 22 章会讲 LSPosed 自己的检测面）。把"时序问题"当成"工具选择问题"是最常见的误判。' }
        ],
        explain:
          '<p><b>"hook 一次都没触发"是一个诊断信号，不是一个需要换工具的现象。</b>' +
          '它的两个标准原因是有优先级的：</p>' +
          '<p><b>① 时序（最常见）：</b>目标的代码在你的钩子生效之前就跑完了。判据是——检测代码在 so 的初始化流程里，' +
          '而你在 Java 层挂钩时 so 早已加载完毕。解法是 <b>spawn 模式 + 把介入点前移到 dlopen</b>。</p>' +
          '<p><b>② 路径：</b>你钩的方法根本没被调用（走的是另一个重载、另一个类、或另一个进程）。' +
          '判据是——r0tracer 批量打点后，目标方法在日志里完全不出现。</p>' +
          '<p style="margin-bottom:0"><b>元原则：</b>先判断"是没被调用，还是被调用时我的钩子不在"。' +
          '这两个原因指向完全不同的下一步，<b>而"换工具"对两者都不起作用。</b></p>'
      }
    },

    /* ============================================================ 21.10 */
    {
      h: '21.10', title: 'Frida 结合自定义 ROM：内置还是注入',
      html:
        '<p>"去特征"这件事有两条根本不同的路线，先把它们的差别摆清楚：' +
        '<b>把东西编进系统镜像</b>，或者<b>在运行时把它注入进程</b>。</p>',
      term: {
        title: '两条路线的第一次对照',
        lines: [
          { t: 'p', s: '$ # 路线 A：编译进 ROM' },
          { t: 'o', s: '  把 frida-server（或 gadget）与绕过逻辑放进 system 分区 / init 脚本' },
          { t: 'o', s: '  → 开机即就位，App 还没跑起来，环境已经准备好了' },
          { t: '', s: '' },
          { t: 'p', s: '$ # 路线 B：运行时注入' },
          { t: 'o', s: '  push 一个 server 上去，attach 或 spawn 时注入' },
          { t: 'o', s: '  → 无需刷机，改一个参数就能换目标' },
          { t: 'w', s: '两条路线不是"谁更好"，是"你现在该接受哪种代价"' }
        ]
      },
      after:
        T.tbl(['维度', '路线 A：编进 ROM', '路线 B：运行时注入'],
          [
            ['<b>介入时机</b>', '<b>最早。</b>开机就位，能覆盖 App 启动最早期的检测',
             '受注入时机限制。attach 常常已经太晚（见 21.9）'],
            ['<b>痕迹</b>', '文件在系统分区里（但可以不常驻进程）。<b>系统分区的改动本身是痕迹</b>：'
             + '完整性校验、分区哈希、SafetyNet/Play Integrity 一类机制都会看到',
             '注入痕迹（RWX 内存、TracerPid、线程名）。<b>进程内痕迹更集中，但也更接近检测点</b>'],
            ['<b>可维护性</b>', '<b>差。</b>换一个目标要重刷、要适配机型与安卓版本、'
             + '要跟着系统升级维护（第 12 章讲过的"每个大版本都要重新适配"在这里同样成立）',
             '<b>好。</b>换脚本、换参数即可，不动系统'],
            ['<b>可迁移性</b>', '差。一台设备一套镜像', '好。同一套工具能跑在任意已 root 设备上'],
            ['<b>回滚成本</b>', '高（要重新刷回去）', '<b>低</b>（删掉文件、重启即可）'],
            ['<b>适合什么阶段</b>', '<b>长期、固定目标的深挖</b>。研究一台固定设备上的一个固定目标',
             '<b>快速探索与反复试验</b>。还没确定要长期投入的时候']
          ]) +
        T.note('key', '🔑 一条实用的判断规则',
          '<p>把这两句话记住，能省掉很多纠结：</p>' +
          '<p><b>"我还在探索，不知道要盯多久" → 运行时注入。</b>' +
          '这时候上线一条 ROM 路线，等于<b>把探索成本一次性提高到刷机成本</b>——' +
          '而你可能第二天就换目标了。</p>' +
          '<p style="margin-bottom:0"><b>"我已经确定要长期盯这一个目标，且它检测极其早期" → 才考虑 ROM。</b><br>' +
          '而且第 13 章给了第三条路：<b>不把逻辑编进 ROM，而是编成内核模块</b>——' +
          '这样既拿到了"开机就位"，又没有污染系统分区。' +
          '<span class="hit">这就是为什么"下沉层级"和"改 ROM"是两个不同的决定。</span></p>') +
        T.note('warn', '⚠️ 攻击性技术的边界',
          '<p style="margin-bottom:0">本节讨论的都是<b>合法授权的安全研究、自身产品加固与教学</b>场景下的工程取舍。' +
          '刷机与分区改写涉及<b>设备变砖、防回滚（anti-rollback）、保修失效</b>等真实风险，' +
          '请只在你拥有或已获明确授权的设备上操作。<br>' +
          '本章<b>不提供</b>针对任何具体线上产品的操作步骤。</p>')
    },

    /* ============================================================ 21.11 */
    {
      h: '21.11', title: '自己编译 Frida：抹掉名字，以及 hluda 的真相',
      html:
        '<p>第 3 层暴露面（21.2）只能在编译期解决。这一节讲清楚两件事：' +
        '<b>到底需要改什么</b>，以及<b>"hluda"这个名字背后的真实状态</b>。</p>',
      intuition: {
        tag: '直觉模型 · 从"改文件名"到"改身份证"',
        body:
          '<p>改 <code>frida-server</code> 的文件名，好比把门口的姓名牌换掉。' +
          '但对方不只看姓名牌——它会看你的<strong>档案</strong>（导出符号）、' +
          '听你的<strong>口音</strong>（内部线程名）、翻你的<strong>行李</strong>（二进制里的字符串常量）。</p>' +
          '<p>这些信息全都写死在编译产物里。<strong>运行时改不了"我编译成了什么"</strong>——' +
          '这就是为什么必须自己编译：你需要在源码层面把那些字符串和符号换掉，' +
          '而不是在运行时往它们前面挂一个过滤器。</p>'
      },
      after:
        '<p>先说清楚要改的东西。社区项目 <b>strongR-frida-android</b> 把它的工作描述成' +
        '"跟随 Frida 上游自动修补程序，并为 Android 构建抗检测版本的 frida-server"，' +
        '并在 README 里给出了一份<b>补丁清单</b>。清单本身就是一份很好的"要改什么"的目录：</p>' +
        T.tbl(['补丁所针对的对象', '它对应哪个暴露点', '说明'],
          [
            ['<code>frida-core</code> 的 <b>RPC 字符串</b>', '内存特征字符串（第 3 层）', '通信协议里带的可识别字符串'],
            ['<b>server 的通信路径</b>', 'D-Bus / 通信特征（第 3 层）', '改掉默认的通道路径'],
            ['<b>管道（pipe）名</b>', '进程间通信特征', '注入与通信会用到命名管道'],
            ['<b>agent 的 so 名</b>', '模块名 / maps（第 2 层）', '就是 <code>frida-agent-*.so</code> 这一类名字'],
            ['<b><code>frida_agent_main</code> 符号</b>', '导出符号（第 3 层）', '导出表里的符号名，扫描导出表即可发现'],
            ['<b><code>gum-js-loop</code> 线程</b>', '线程名（第 2 层）', 'JS 运行循环线程'],
            ['<b><code>gmain</code> 线程</b>', '线程名（第 2 层）', 'GLib 主循环线程']
          ]) +
        T.note('', '📌 关于上表的纪律说明',
          '<p style="margin-bottom:0">上表的<b>条目内容</b>来自该项目 README 里列出的补丁文件名（每个补丁文件名本身就说明了它改什么）。' +
          '但<b>补丁编号、文件内容、以及它当前跟随的 Frida 版本</b>都会随上游变化，' +
          '<span class="pill warn">请以该项目 README 与 releases 页面当时的状态为准，本文不断言具体版本号，待核实</span><br>' +
          '本节也不给出任何具体的编译命令与参数——<b>那些参数随 Frida 的构建系统变化，写死在这里只会误导你。</b></p>') +
        T.card('编译这件事的"必要步骤"粒度（只到这一层）',
          '<p><b>① 取得源码</b>：Frida 是分仓库组织的（核心、gum、构建配方等），' +
          '官方有自己的构建脚本负责拉齐依赖。<b>不要试图手抄依赖列表。</b></p>' +
          '<p><b>② 准备工具链</b>：会需要特定版本的 NDK、Node.js，以及一堆系统依赖。' +
          '<b>这一层的失败最常见，而且报错信息往往指向缺失的工具而不是缺失的依赖。</b></p>' +
          '<p><b>③ 打补丁</b>：把"改字符串 / 改符号 / 改线程名"的改动应用到源码上。' +
          '<b>这一步的失败点</b>：上游源码变了，补丁上下文对不上，patch 打不上。' +
          '<span class="miss">这也是"跟随上游自动修补"这条路最大的维护成本——上游一动，补丁就可能失效。</span></p>' +
          '<p><b>④ 编译目标架构</b>：安卓上要按 <code>arm64</code> / <code>arm</code> 分别产出。' +
          '<b>这一步的失败点</b>：工具链版本不匹配，或者编译中途内存/磁盘不足。</p>' +
          '<p><b>⑤ 验证改动真的生效</b>：这是最容易被跳过、也最不该跳过的一步。' +
          '<b>编译成功不等于改动生效</b>——你必须回去检查那些字符串/符号是不是真的没了' +
          '（用 21.13 的审计流程去核对）。</p>' +
          '<p style="margin-bottom:0"><b>常见失败点的总结：</b>工具链版本（②）＞ 补丁上下文（③）＞ 目标架构与依赖（④）。' +
          '绝大多数"编译不过"都发生在 ② 和 ③。</p>') +
        T.note('warn', '⚠️ 关于「hluda」：这个名字要讲清楚，否则你会走弯路',
          '<p><b>事实层面：</b>"hluda"是中文社区里流传的一个<b>去特征 Frida 分支</b>的名字标签，' +
          '在若干论坛帖子与技术文章里被当作"魔改版 Frida"的代称。</p>' +
          '<p><b>但有三件事我必须说清楚，而不是替它背书：</b></p>' +
          '<p><b>① 它的维护状态与当前版本，本文无法断言。</b>' +
          '<span class="pill warn">hluda 的版本号、维护状态、以及它当前跟随的 Frida 上游版本，待核实</span><br>' +
          '这个领域的项目生命周期普遍很短，"某个名字曾经很好用"和"它现在还能用"是两件不同的事。</p>' +
          '<p><b>② 你真正需要的不是某个特定的分支名，而是"一份补丁清单"。</b>' +
          '上面那张表已经告诉你要改什么了。<b>任何实现了这些改动的分支都能达到同样的效果</b>，' +
          '名字只是标签。</p>' +
          '<p style="margin-bottom:0"><b>③ 更值得关注的是这个领域当下的实际状态。</b>' +
          '我查证到的可访问项目 <b>strongR-frida-android</b> 在其 README 顶部写了一句很关键的话：' +
          '<b>作者因为工作忙已长时间没维护，并建议读者去参考它引用的另一个项目（Florida）。</b><br>' +
          '<span class="hit">这句话本身就是本章最好的教材：去特征 Frida 这个赛道上，' +
          '"哪个分支现在活着"是一个快速变化的事实，' +
          '而"要改哪些特征"是一条稳定的知识。学后者。</span></p>') +
        T.card('自己编译 vs 换路线：一笔必须算的账',
          '<p>在决定投入编译之前，先算这三笔账：</p>' +
          '<p><b>① 你要解决的是哪一层？</b><br>' +
          '如果目标只检测第 1 层（进程名、端口、路径），<b>改文件名 + 换端口就够了，不要编译。</b><br>' +
          '只有当目标扫描第 3 层（二进制里的字符串、导出符号）时，编译才是必需品。</p>' +
          '<p><b>② 编译一次能用多久？</b><br>' +
          '补丁要跟上游。你的 Frida 版本不动，它能用很久；你一升级 Frida，补丁可能全部失效。' +
          '<b>如果你的工作流需要频繁升级 Frida（新安卓版本 → 新 Frida），编译成本是持续的。</b></p>' +
          '<p style="margin-bottom:0"><b>③ 有没有不需要编译的替代路线？</b><br>' +
          '第 13 章的内核路线就是一条：<b>它不改 Frida，而是让检测看不见 Frida</b>。' +
          '内核模块可以过滤掉那些暴露点，<b>代价是门槛更高（要写内核代码、要适配内核版本）。</b><br>' +
          '<span class="hit">两条路的取舍在 21.15 会接着讲。</span></p>')
    },

    /* ============================================================ 21.12 */
    {
      h: '21.12', title: 'syscall 观测面：当用户态 hook 全部失效',
      html:
        '<p>第 13 章讲了一件事：<b>当目标不走 libc、直接内联 SVC 指令时，所有符号级 hook 都会扑空。</b>' +
        '本节接着那条线，讲它对本章的意义。</p>',
      term: {
        title: '为什么 syscall 是"更稳的观测面"',
        lines: [
          { t: 'p', s: '$ # 三个层级的观测面，稳的程度递增' },
          { t: 'o', s: '  ① Java 层 hook   —— 目标不用这段 Java 代码，就看不到' },
          { t: 'o', s: '  ② Native 符号级 hook —— 目标不走 libc 符号，就看不到' },
          { t: 'o', s: '  ③ syscall 观测     —— 只要它要读内存 / 要写文件 / 要退出，就必须发系统调用' },
          { t: '', s: '' },
          { t: 'e', s: 'if (目标要做任何有副作用的事) {' },
          { t: 'o', s: '  → 它必然要在某个时刻发一个 syscall' },
          { t: 'e', s: '}' },
          { t: 'w', s: '所以 syscall 是"最后一层无法被语言/框架选择所回避"的观测面' }
        ]
      },
      after:
        T.tbl(['观测面', '目标怎么绕开它', '绕开的代价', '用什么看'],
          [
            ['Java 层', '不用 Java 写这段逻辑（放进 native）', '低——壳普遍这么做', 'Frida / Xposed（第 1、22 章）'],
            ['Native 符号级', '静态链接、内联汇编、动态注册（第 10 章）、自定义 Linker（第 4 章）',
             '<b>中——需要加固方做额外工作</b>', 'Frida Interceptor / 硬件断点（第 13 章）'],
            ['<b>syscall</b>', '只能不走系统调用，或者自己也去改内核',
             '<b>高——多数保护不到这一步</b>', 'eBPF / kprobe（第 11 章）、内核模块、硬件断点（第 13 章）']
          ]) +
        T.note('key', '🔑 这与第 13 章的呼应关系',
          '<p><b>第 13 章解决的是"怎么看见内联 SVC"</b>——它教你在汇编层面识别 SVC 特征字节，' +
          '让你知道"这里有一个绕开 libc 的调用"。</p>' +
          '<p style="margin-bottom:0"><b>本章要补的是另一半：看见了之后，观测点应该放在哪里。</b><br>' +
          '如果你只是在用户态"看到了一段 SVC 指令"，你其实还是被动的一方——' +
          '目标下次换一种绕过方式，你又得从头找。<br>' +
          '<span class="hit">把观测点放到 syscall 这一层，意味着你不再关心"它是用 libc 还是内联"，' +
          '你只关心"它发了什么系统调用"——<b>这是语义层面的观测，不是语法层面的。</b></span></p>') +
        T.card('为什么 syscall 观测对"抓包"也特别有价值',
          '<p>回到 21.4：r0capture 靠 hook 系统 SSL 读写函数来抓明文。' +
          '如果目标自带 SSL 实现，这条路就断了。</p>' +
          '<p style="margin-bottom:0">而<b>再自研的 SSL 实现，最终也要把加密后的数据写给 socket</b>——' +
          '那就是 <code>send</code> / <code>sendto</code> / <code>write</code> 这些 syscall。<br>' +
          '<b>在这一层你能拿到"加密之后"的数据</b>，而不是明文。<br>' +
          '<span class="miss">所以 syscall 观测能解决"流量在哪"，但解决不了"明文是什么"——</span>' +
          '要明文，你还是得回到算法层（第 8、9 章）或主动调用（21.6、21.7）。' +
          '<b>知道每一层观测面各自的极限，比多学一个工具重要得多。</b></p>') +
        T.note('', '📌 出问题往哪查',
          '<p style="margin-bottom:0"><b>syscall 观测里什么都看不到</b> → 你的观测点没挂上，或者目标在别的进程（多进程 App 要注意）。<br>' +
          '<b>看到大量重复的同一个 syscall</b> → 先用"只看首次 / 只看特定参数"收敛，不要直接读原始日志。<br>' +
          '<b>看到了 syscall 但认不出语义</b> → <b>调用号是跟架构绑定的</b>（ARM32 与 AArch64 完全不同），' +
          '先确认你查的是哪个架构的表。</p>')
    },

    /* ============================================================ 21.13 */
    {
      h: '21.13', title: 'ModuleMap 与 hook dlopen：在几十个 so 里锁定那一个',
      html:
        '<p>一个加固 App 加载几十个 so 是常态。你要找的那个函数在其中一个里面。' +
        '<b>盲目地逐个 so 翻导出表，是最慢的办法。</b></p>' +
        T.note('key', '🔑 模块加载关系图能回答的问题',
          '<p>把"谁加载了谁、什么时候加载的"画成一张图，你立刻能问出几个非常有力的筛选问题：</p>' +
          '<p><b>① 谁是"被加载"而不是"被依赖"的？</b><br>' +
          '正常 so 通过依赖关系被 linker 自动加载；<b>而壳自己解密出来的 so 是被"主动加载"的</b>。' +
          '这个差别直接把它标出来了。</p>' +
          '<p><b>② 谁是在启动之后很久才加载的？</b><br>' +
          '加密相关的 so 往往在"用到那个功能"时才加载。<b>时间线上的异常点就是线索。</b></p>' +
          '<p><b>③ 谁的加载者是"可疑的那一个"？</b><br>' +
          '如果 so A 的加载者是壳的 so，那 A 就很值得看；如果 A 的加载者是系统 linker，它大概率是普通库。</p>' +
          '<p style="margin-bottom:0"><b>配合 hook dlopen</b>：把每次加载的' +
          '[加载者 → 被加载者 → 时间] 记录下来，这就是一张 ModuleMap 的原始数据。</p>') +
        T.card('hook dlopen：在 so 被加载的那一刻介入',
          '<p><code>dlopen</code>（以及它的兄弟 <code>android_dlopen_ext</code>）是<b>so 被加载进进程的入口</b>。' +
          '在这个入口上下钩，你能做三件别处做不到的事：</p>' +
          '<p><b>① 知道"谁加载了什么、什么时候加载的"</b><br>' +
          '把所有被加载的 so 名字与返回句柄记录下来，就拿到了一张<b>模块加载时间线</b>——' +
          '这正是上一节那三个筛选问题所需要的数据。</p>' +
          '<p><b>② 抢在目标 so 的自检代码之前做替换</b><br>' +
          '虽然 <code>dlopen</code> 返回时构造函数已经跑完了，但你的钩子在<b>调用方拿到句柄之后</b>立刻就能动手，' +
          '而调用方后续的逻辑还没执行。<b>这个时间窗在实战里往往刚好够用。</b></p>' +
          '<p><b>③ 对加载行为本身做判断</b><br>' +
          '比如"这个 App 在启动后第 3 秒加载了一个可疑的加密 so"——这个时间关系本身就是线索。</p>' +
          '<p style="margin-bottom:0"><b>为什么这一招在实战里这么重要：</b>App 的检测逻辑一般写在<b>某个 so 的初始化流程里</b>。' +
          '你在 Java 层 hook（<code>Java.perform</code> 之后）时，这个 so 早就加载并跑完了。' +
          '<span class="miss">你会得到一个必然失败的结论："hook 挂不上，因为代码在我挂之前就跑完了。"</span><br>' +
          '所以遇到"hook 一次都没触发"，第一件事就是检查<b>你的 hook 和目标的加载顺序</b>。</p>') +
        T.note('warn', '⚠️ hook dlopen 的两个现实问题',
          '<p style="margin-bottom:0"><b>① 时机</b>：dlopen 本身可能在你完成注入之前就被调用过（尤其是 App 启动早期）。' +
          '这就是 <code>spawn</code> 模式（在 App 主逻辑之前注入）价值所在——<b>第 10 章讲的"抢时序"在这里具体兑现</b>。<br>' +
          '<b>② 误伤</b>：dlopen 被大量正常代码调用，你的钩子里做的事要尽量轻，' +
          '而且要考虑重入（你的钩子内部如果又触发了 dlopen，要能正确处理）。</p>') +
        T.card('与第 4 章"自定义 Linker"的呼应',
          '<p>第 4 章那个自制 ELF Loader 的案例里，有一个细节和本节直接相关：' +
          '<b>它加载出来的 so 在 <code>/proc/self/maps</code> 里没有文件路径</b>——' +
          '因为那块内存是从匿名映射起来的，不是从文件映射的。</p>' +
          '<p><b>这对 ModuleMap 有两个直接后果：</b></p>' +
          '<p><b>① 你的模块列表可能"少一个"。</b>用常规的"枚举模块"接口拿到的列表，' +
          '是 linker 认识的模块；<b>自定义 Linker 加载的东西不在里面</b>。<br>' +
          '<span class="miss">"枚举模块看不到它"不等于"它不存在"</span>——' +
          '这时要改用"枚举内存区间 + 校验 ELF 魔数"的思路去找。</p>' +
          '<p style="margin-bottom:0"><b>② 加载关系图会断链。</b>' +
          '你的 dlopen 钩子只能看到"走系统 linker 的那部分"；' +
          '走自定义 Linker 的 so，在系统看来根本没被加载过。<br>' +
          '<b>所以 ModuleMap 有一个已知的盲区，而知道盲区在哪，比相信这张图完整更重要。</b></p>'),
      stage: {
        title: 'hook dlopen：介入点能前移到多早',
        speed: 1700,
        render:
          '<div class="flow-col" style="gap:6px">' +
            '<div class="flow-row" style="font-size:12px;color:var(--fg-3)">' +
              '<span style="width:96px">时间轴</span>' +
              '<span style="flex:1">越靠左 = 越早 = 你的介入点越主动</span></div>' +
            '<div class="flow-row" style="align-items:flex-start">' +
              '<span class="pill mono" style="width:96px">① 最早</span>' +
              '<span class="blk" id="t1">spawn 完成注入<br><span class="small">App 主逻辑尚未开始</span></span>' +
              '<span class="arrow">→</span>' +
              '<span class="blk" id="t2">hook dlopen<br><span class="small">so 加载入口被接管</span></span></div>' +
            '<div class="flow-row" style="align-items:flex-start">' +
              '<span class="pill mono" style="width:96px">② 目标动作</span>' +
              '<span class="blk" id="t3">目标 so 被 dlopen<br><span class="small">此刻你能拿到模块名与句柄</span></span>' +
              '<span class="arrow">→</span>' +
              '<span class="blk" id="t4">so 的构造函数 / JNI_OnLoad 运行<br><span class="small">⚠️ 检测代码通常在这里</span></span></div>' +
            '<div class="flow-row" style="align-items:flex-start">' +
              '<span class="pill mono" style="width:96px">③ 太晚了</span>' +
              '<span class="blk" id="t5">你在 Java 层 attach 上钩子<br><span class="small">Java.perform 之后</span></span>' +
              '<span class="arrow">→</span>' +
              '<span class="blk" id="t6">检测早已跑完<br><span class="small">你得到的必然结论：hook 一次都没触发</span></span></div>' +
            '<div class="flow-row" style="margin-top:6px;padding-top:8px;border-top:1px dashed var(--line)">' +
              '<span class="pill bad" id="mk">🎯 你的钩子必须在 t4 之前就位</span></div>' +
          '</div>',
        reset: () => {
          ['t1','t2','t3','t4','t5','t6'].forEach(i => S(i, ''));
          CLS('mk', 'pill bad');
          SET('mk', '🎯 你的钩子必须在 t4 之前就位');
        },
        steps: [
          { run: () => { S('t1', 'cool'); },
            note: '<b>先看坐标。</b>时间轴从左到右。左边是"环境还没准备好"，右边是"App 已经在跑了"。' +
                  '<b>你的介入点越靠左，你就越主动</b>——因为在左边，目标还没开始检测。' },
          { run: () => { S('t1', 'done'); S('t2', 'active'); CLS('mk', 'pill warn'); SET('mk', '⚠️ 现在钩子在"加载入口"上'); },
            note: '<b>hook dlopen：把钩子挂在 so 的加载入口上。</b>' +
                  '<code>dlopen</code> 和 <code>android_dlopen_ext</code> 是<b>库被装进这个进程的必经之路</b>。' +
                  '挂在这里，你就拿到了"谁在什么时候被装进来"的完整名单。' },
          { run: () => { S('t2', 'done'); S('t3', 'active'); },
            note: '<b>目标 so 被加载。</b>此刻你的钩子先跑，你能拿到：' +
                  '<b>加载者是谁</b>（系统 linker 还是别的 so）、<b>被加载的是谁</b>（模块名/路径）、<b>什么时候</b>。<br>' +
                  '<span class="hit">这三样就是 ModuleMap 的原始数据。</span>' },
          { run: () => { S('t3', 'done'); S('t4', 'hot'); CLS('mk', 'pill bad'); SET('mk', '⛔ t4 是检测代码开始运行的地方'); },
            note: '<b>警告：so 的构造函数与 <code>JNI_OnLoad</code> 会在这里运行。</b><br>' +
                  '注意一个技术细节：<code>dlopen</code> <b>返回时，构造函数其实已经跑完了</b>。' +
                  '所以你的钩子是在构造函数之后执行的——<b>但通常仍在调用方后续逻辑之前</b>，' +
                  '这个时间窗在实战里往往刚好够用。<br>' +
                  '<span class="pill warn">不同 linker 实现下这个先后关系需要实测确认，待核实</span>' },
          { run: () => { S('t4', 'done'); S('t5', 'active'); },
            note: '<b>对比一下"太晚"是什么样。</b>如果你只在 Java 层 <code>Java.perform</code> 之后挂钩，' +
                  '那是在 App 主逻辑起来之后了——<b>而 t3、t4 早就发生完了。</b>' },
          { run: () => { S('t5', 'done'); S('t6', 'miss'); CLS('mk', 'pill bad'); SET('mk', '❌ 这就是"hook 一次都没触发"的真正原因'); },
            note: '<b>你得到一个必然失败的结论："hook 挂不上。"</b><br>' +
                  '但真相不是"挂不上"，而是<b>你要挂的东西已经跑完了</b>。<br>' +
                  '<span class="miss">所以"hook 一次都没触发"的第一诊断方向永远是时序，而不是钩子写错了。</span>' },
          { run: () => { S('t2', 'cool'); S('t3', 'cool'); S('t6', 'done'); CLS('mk', 'pill ok'); SET('mk', '✅ 介入点前移 = 把问题从"跟得上"变成"抢在前"'); },
            note: '<b>收尾。</b>这就是"抢时序"这一整类手段的共同逻辑：' +
                  '<b>它不消除你的特征，而是让你在对手检查之前就已经完成了替换。</b><br>' +
                  'spawn 让注入更早、hook dlopen 让介入点更早——两者叠加，' +
                  '你就把"我能不能活下来"这个问题，变成了"我能不能比它更早"这个问题。' }
        ]
      },
      stepper: {
        title: '用加载关系图锁定目标 so（推演）',
        lines: [
          {
            code: '<span class="c">// 第 1 步：记录所有的 dlopen 调用 —— [调用者, 被加载的 so, 时间]</span>',
            note: '<b>先撒网，不做判断。</b>在 <code>dlopen</code> 上挂钩子，把每次加载的' +
                  '调用方模块、被加载模块名、以及时间戳记下来。<br>' +
                  '<b>不要在这一步做筛选</b>——你还不知道什么值得筛。',
            state: { '已记录加载事件': '0 条', '可疑模块': '未标注', '结论': '—' }
          },
          {
            code: '<span class="c">// 第 2 步：标注"谁是加载者" —— 系统 linker 还是 App 自己的 so？</span>',
            note: '<b>第一次筛选。</b>把加载者分成两类：<br>' +
                  '<b>系统 linker</b>（如 <code>linker64</code>）加载的 → 正常依赖关系，先放一边；<br>' +
                  '<b>App 自己的 so</b> 加载的 → <b>主动加载，全部留下。</b><br>' +
                  '这一步通常能把几十个 so 砍到个位数。',
            state: { '已记录加载事件': '若干条', '主动加载的': '<b>3 个（可疑）</b>', '结论': '—' }
          },
          {
            code: '<span class="c">// 第 3 步：看时间 —— 哪个是"启动之后很久才加载"的？</span>',
            note: '<b>第二次筛选。</b>把剩下的按加载时间排序。<br>' +
                  '<b>启动阶段加载</b> → 大概率是壳的初始化模块（也值得看，但不是加密逻辑）；<br>' +
                  '<b>点击某个功能之后才加载</b> → <span class="hit">高度可疑</span>，' +
                  '它很可能就是那个功能专属的逻辑。<br>' +
                  '<b>实战技巧：把"点击前后的两条时间线"对比着看。</b>',
            state: { '主动加载的': '3 个', '功能触发后才加载的': '<b>1 个</b>', '结论': '—' }
          },
          {
            code: '<span class="c">// 第 4 步：验证这个"功能触发后才加载"的 so 里有你要的东西</span>',
            note: '<b>假设要验证，不能直接采信。</b>三重验证：<br>' +
                  '<b>①</b> 枚举它的导出符号，看有没有加解密相关的名字（注意可能是动态注册、导出表为空）；<br>' +
                  '<b>②</b> 看它的内存区间权限，有没有 RWX 段（第 3 层暴露面的那个特征，这里反过来当线索用）；<br>' +
                  '<b>③</b> <b>最有力的一条</b>：在这个 so 里下钩，然后触发功能，看它是否真的被调用。',
            state: { '候选 so': 'libxxx.so', '导出符号': '为空（疑似动态注册）', '结论': '待验证' }
          },
          {
            code: '<span class="c">// 第 5 步：处理"枚举不到"的情况 —— ModuleMap 的盲区</span>',
            note: '<b>如果第四步怎么都验证不了</b>，怀疑它走了自定义 Linker（第 4 章）。<br>' +
                  '这时常规的模块枚举完全看不到它。改走：<b>枚举内存区间 → 找可执行段 → 校验 ELF 魔数</b>，' +
                  '把"没有文件路径但内容像 ELF"的区间捞出来，再交给 so 修复工具处理。',
            state: { '常规枚举': '看不到', '改用': '枚举区间 + 校验 ELF magic', '结论': '盲区已定位' }
          },
          {
            code: '<span class="c">// 收尾：把这次的结果回写成"加载关系图"的一个节点</span>',
            note: '<b>让 ModuleMap 成为资产而不是一次性产物。</b>把这次标注出来的' +
                  '[模块名 / 加载者 / 加载时机 / 用途 / 验证方式] 记下来。<br>' +
                  '<span class="hit">下次换一个同类 App 时，这张图能让你在十分钟内到达上次花了一小时的位置。</span>',
            state: { 'ModuleMap': '已更新', '可复用条目': '1 条', '结论': '✅ 锁定目标 so' }
          }
        ]
      },
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">定位 so 不靠"逐个翻"，靠<b>三个筛选问题</b>：' +
        '<b>谁是主动加载的 → 谁是晚加载的 → 谁在功能触发时被调用。</b><br>' +
        '同时记住这张图有一个<b>已知盲区</b>（自定义 Linker 加载的模块不在常规枚举里），' +
        '盲区的处理方式是"枚举内存区间 + 校验 ELF 魔数"，而不是继续在模块列表里找。</p>')
    },

    /* ============================================================ 21.14 动手实验 A */
    {
      h: '21.14', title: '动手实验 A：特征暴露面审计器',
      html:
        '<p>前面几节把暴露面按层讲清楚了，但"还剩几处暴露"一直是个模糊的感觉。' +
        '这个实验把它变成一个<b>可以算的数字</b>。</p>' +
        '<p>规则很简单，但有一条必须提前说清楚：' +
        '<strong>一项对抗手段往往只能覆盖某个暴露点的一部分，剩下的那部分依然暴露。</strong>' +
        '所以这个审计器不会给你"挡住了/没挡住"两档，而是给出<b>部分覆盖</b>并计入残余风险。</p>',
      lab: {
        title: '实验 A：特征暴露面审计器',
        goal: '目标：算出残余暴露点，并写出不可替代项',
        intro:
          '<p>下面有 <b>7 项对抗手段</b>。把你<b>已经做掉</b>的填进第一个框（写编号即可）。</p>' +
          '<p>系统会按<b>真实的暴露点权重</b>算出：还剩几处暴露、每一处对应什么检测手法、' +
          '以及<b>眼下最划算的下一步</b>（做哪一项能一次砍掉最多残余风险）。</p>' +
          '<p class="small muted">' +
          '<b>1</b> = 改 frida-server 文件名与安装路径　' +
          '<b>2</b> = 改默认监听端口<br>' +
          '<b>3</b> = 用 gadget 代替独立 server　' +
          '<b>4</b> = hook open/read 过滤 maps<br>' +
          '<b>5</b> = 自己编译抹掉字符串与符号<br>' +
          '<b>6</b> = 改内部线程名　' +
          '<b>7</b> = 内核模块隐藏<br>' +
          '（<b>8</b> = 编进 ROM 镜像，是<b>部署方式</b>不是消除手段，可以一起填）</p>',
        inputs: [
          { key: 'pick', label: '① 我已经做掉的对抗手段（填编号）',
            hint: '例如 1 2 3', ph: '例如 1 2 4', value: '1 2' },
          { key: 'gap', label: '② 上一步结论里，哪一项是"不能被替代"的？为什么？',
            hint: '说清它覆盖了什么别人覆盖不了的暴露点',
            ph: '例如：第 X 项不能被替代，因为……', type: 'textarea', rows: 3 },
          { key: 'cost', label: '③ 如果只能再做一件事，你做哪一项、代价是什么？',
            hint: '写清代价，不只是收益', ph: '我选第 X 项，代价是……', type: 'textarea', rows: 2 }
        ],
        runLabel: '🔍 审计残余暴露面',
        autorun: true,
        run: (v) => {
          /* ---------------------------------------------------------------
             特征暴露面台账（本章唯一的"事实表"）
             w     : 权重（3=高 2=中 1=低），按"被实际检测的频率 × 干掉的难度"估
             val   : 对 7 项手段的覆盖度，下标 0..6 依次对应手段 1..7
                     1 = 完全覆盖（该暴露点消失）
                     0.5 = 部分覆盖（仍然暴露，只是更难看）
                     0   = 无覆盖
             --------------------------------------------------------------- */
          const MEASURES = [
            { id: 1, name: '改文件名与安装路径' },
            { id: 2, name: '改默认监听端口' },
            { id: 3, name: '用 gadget 代替独立 server' },
            { id: 4, name: 'hook open/read 过滤 maps' },
            { id: 5, name: '自己编译抹掉字符串与符号' },
            { id: 6, name: '改内部线程名' },
            { id: 7, name: '内核模块隐藏' }
          ];
          const LEDGER = [
            { id: 'PORT', name: '进程名 frida-server 可被枚举', w: 2,
              how: '遍历 /proc 读 /proc/<pid>/comm 与 cmdline，就一个进程名的事',
              fix: '换目录 + 换成毫不相关的进程名（例如伪装成一个系统服务名）',
              val: [1, 0, 1, 0, 0, 0, 1] },
            { id: 'PATH', name: '安装路径 /data/local/tmp 下的文件名', w: 1,
              how: '一次 stat 就能查完，是最"便宜"的检测，加固方很爱加',
              fix: '连目录一起换（别放在人尽皆知的目录），并按需重命名',
              val: [1, 0, 1, 0, 0, 0, 1] },
            { id: 'DFLT', name: '默认端口 27042 / 27043', w: 2,
              how: '读 /proc/net/tcp，或直接 connect 试一下',
              fix: '启动参数指定一个非默认端口（--listen 一类）',
              val: [0, 1, 0.5, 0, 1, 1, 1] },
            { id: 'DMAPS', name: '模块名出现在 /proc/self/maps', w: 3,
              how: '读 maps 找 "frida" / "gum" 相关的映射项——最常用的检测手段',
              fix: '改编译抹掉 agent 的 so 名；或在 open/read 上过滤 maps 内容',
              val: [0, 0, 0, 1, 1, 1, 1] },
            { id: 'ROOT', name: '进程名再次出现（kill(pid,0) / 二次确认）', w: 2,
              how: '换一种方式再拿一次进程名；gadget 之后这条基本失效',
              fix: '改用 gadget：进程内加载，不存在独立的 server 进程',
              val: [0, 0, 1, 0, 0, 0.5, 1] },
            { id: 'DIR', name: '目录名 re.frida.server 等可枚举', w: 2,
              how: '在文件系统里按名字找工具留下的目录',
              fix: '换目录 + 重命名（注意是目录名，不只是文件名）',
              val: [1, 0, 1, 0, 1, 0, 1] },
            { id: 'MEM', name: '内存中的特征字符串（frida / gum / rpc）', w: 3,
              how: '扫描自身代码段与数据段，找特征字节序列（AntiFrida / DetectFrida 一类项目就在做这件事）',
              fix: '改编译把常量字符串换掉；运行时 hook strstr/memmem 只能骗过字符串比较那一类',
              val: [0, 0, 0, 0.5, 1, 0, 1] },
            { id: 'EXPT', name: '导出符号 frida_agent_main 等', w: 3,
              how: '遍历已加载模块的导出符号表，按名字匹配——比扫内存更省事',
              fix: '改编译把符号名换掉（或改成不导出的本地符号）',
              val: [0, 0, 0, 0, 1, 0, 1] },
            { id: 'TASK', name: '线程名 /proc/self/task/*/comm', w: 3,
              how: '读线程名，匹配 gum-js-loop / gmain / pool-frida 等 Frida 内部线程名',
              fix: '改编译换掉线程名；根上要改的是"线程名的产生处"，不是显示处',
              val: [0, 0, 0, 0, 1, 1, 1] },
            { id: 'DBUS', name: 'D-Bus 通信（端口 / 协议特征）', w: 2,
              how: '探测本机 D-Bus 端口，或看通信内容里带不带特征字符串',
              fix: '改编译换掉协议里的特征字符串；或改用 gadget 改变通信路径',
              val: [0, 0, 0.5, 0, 1, 0, 1] },
            { id: 'INDEX', name: '匿名 RWX 内存段（0x100 一类的索引映射）', w: 2,
              how: '在 maps 里找没有任何路径、却同时可写可执行的内存区间——这是"代码被改过"的通用证据',
              fix: '只有换观测方式（内核 / 硬件断点，见第 13 章）才在本质上少留这类痕迹',
              val: [0, 0, 0, 0.5, 0.5, 0, 1] },
            { id: 'RVWX', name: '运行时代码修改留下的 RWX 痕迹', w: 3,
              how: '同上，但更专指 Stalker / inline hook 动态改写代码段时产生的痕迹',
              fix: '限制 trace 范围（别长时间开 Stalker）；或改用硬件断点，不写内存',
              val: [0, 0, 0, 0, 0, 0, 0.5] },
            { id: 'CJIT', name: 'JS 引擎（V8 / JSC）的运行时结构', w: 2,
              how: '识别 JS 运行时在堆上留下的结构特征，而不是按字符串匹配',
              fix: '这一层没有"抹掉"的办法，只能靠换环境或提高检测成本',
              val: [0, 0, 0, 0, 0.5, 0, 0.5] },
            { id: 'PTRA', name: 'ptrace 注入痕迹（TracerPid / 调试寄存器）', w: 3,
              how: '读 /proc/self/status 的 TracerPid，或看调试寄存器有没有被设置',
              fix: '改用 spawn 抢先注入，或走不需要 ptrace 的注入路径',
              val: [0, 0, 0, 0, 0, 0, 0.5] }
          ];

          const nums = String(v.pick || '').match(/\d+/g) || [];
          const enabled = [...new Set(nums.map(n => parseInt(n, 10)).filter(n => n >= 1 && n <= 7))];
          const rom = nums.indexOf('8') >= 0;

          let total = 0, residual = 0;
          const rows = LEDGER.map(e => {
            total += e.w;
            // 多个手段的覆盖取"并集"，但不能简单相加——用一个折减公式：
            // 未被覆盖的剩余比例 = ∏(1 - val_i)，因此覆盖度 = 1 - 剩余比例
            let remain = 1;
            enabled.forEach(m => { remain *= (1 - e.val[m - 1]); });
            const cover = 1 - remain;
            const left = e.w * remain;
            residual += left;
            return { e, cover, remain, left };
          });
          const maxResidual = LEDGER.reduce((a, e) => a + e.w, 0);
          const score = Math.round(residual / maxResidual * 100);
          const fullGone = rows.filter(r => r.remain <= 0.001);
          const partial = rows.filter(r => r.remain > 0.001 && r.cover > 0.001);
          const untouched = rows.filter(r => r.cover <= 0.001);

          let html = '<div class="lab-kv">'
            + '<span>已做手段 <b>' + enabled.length + '</b> / 7' + (rom ? '（+ ROM 内置）' : '') + '</span>'
            + '<span>残余暴露 <b style="color:var(--warn)">' + score + '%</b></span>'
            + '<span>完全消除 <b>' + fullGone.length + '</b> 处</span>'
            + '<span>部分覆盖 <b>' + partial.length + '</b> 处</span>'
            + '<span>原地不动 <b>' + untouched.length + '</b> 处</span>'
            + '</div>';

          if (rom) {
            html += '<div class="lab-msg warn"><b>⚠️ 你把「编进 ROM」也填了</b>'
              + '<div class="lab-note">这不是坏事，但要分清性质：<b>编进 ROM 是"部署方式"，不是"消除手段"</b>。<br>'
              + '它改变的是<b>介入时机</b>（开机就位，能覆盖 App 启动最早期的检测）和<b>可维护性</b>，'
              + '并不会让上面任何一处暴露点消失。'
              + '<span class="miss">把"部署方式"当成"特征消除"来记账，是最常见的自欺。</span></div></div>';
          }

          html += '<table class="lab-tbl"><tr><th>暴露点</th><th>检测手法</th><th>覆盖度</th><th>还剩</th></tr>';
          rows.forEach(r => {
            const cls = r.remain <= 0.001 ? 'same' : (r.cover >= 0.5 ? '' : 'diff');
            const tag = r.remain <= 0.001 ? '✅ 已消除'
              : (r.cover >= 0.5 ? '🟡 部分覆盖（' + Math.round(r.cover * 100) + '%）'
                                : '❌ 完全暴露');
            html += '<tr class="' + cls + '">'
              + '<td><b>' + r.e.name + '</b><br><span class="muted" style="font-size:11px">权重 ' + r.e.w + '</span></td>'
              + '<td style="font-size:12px">' + r.e.how + '</td>'
              + '<td>' + tag + '</td>'
              + '<td>' + (r.remain <= 0.001 ? '—' : '<b>' + (Math.round(r.remain * 100) / 100 * r.e.w).toFixed(2) + '</b> / ' + r.e.w)
              + (r.remain > 0.001 ? '<br><span class="muted" style="font-size:11px">补法：' + r.e.fix + '</span>' : '') + '</td>'
              + '</tr>';
          });
          html += '</table>';

          /* ---------------- 最划算的下一步 ---------------- */
          const notYet = MEASURES.filter(m => enabled.indexOf(m.id) < 0);
          const gain = notYet.map(m => {
            let after = 0;
            LEDGER.forEach(e => {
              let remain = 1;
              [...enabled, m.id].forEach(k => { remain *= (1 - e.val[k - 1]); });
              after += e.w * remain;
            });
            return { m, gain: residual - after, after };
          }).sort((a, b) => b.gain - a.gain);

          html += '<div class="lab-msg key"><b>🔑 最短的补齐路径</b><div class="lab-note">';
          if (!gain.length) {
            html += '7 项你全做了。此时残余 <b>' + score + '%</b> —— ' +
              '<b>而这个数字不可能降到 0</b>，因为清单最后三项（RWX 痕迹、JS 引擎结构、ptrace 痕迹）' +
              '<span class="miss">没有任何一项用户态手段能完全消除</span>。' +
              '这就是下一节要正面回答的问题：用户态对抗的极限在哪。';
          } else {
            const top = gain[0];
            html += '<b>再补一项 <code>' + top.m.id + ' ' + top.m.name + '</code>，' +
              '残余从 ' + score + '% 降到 ' + Math.round(top.after / maxResidual * 100) + '%</b>' +
              '（一次砍掉 ' + Math.round(top.gain / maxResidual * 100) + ' 个百分点）。<br><br>';
            html += '<b>性价比排序（每多做一项能砍掉多少）：</b><br>';
            gain.slice(0, 5).forEach((g, i) => {
              html += (i + 1) + '. <code>' + g.m.id + '</code> ' + g.m.name +
                ' → −' + Math.round(g.gain / maxResidual * 100) + ' 个百分点' +
                (g.gain <= 0.001 ? '（<span class="miss">已经没什么可砍了</span>）' : '') + '<br>';
            });
            html += '<br><b>注意这个排序和"哪项好做"是两回事。</b>' +
              '改文件名几乎零成本但只砍一处；改编译成本高，' +
              '<b>却能同时砍掉模块名、特征字符串、导出符号、线程名四类暴露点</b>。' +
              '<span class="hit">这是本章最实用的一条实践原则：按"覆盖面"排序，不按"好实现"排序。</span>';
          }
          html += '</div></div>';

          /* ---------------- 不可替代性 ---------------- */
          const irreplaceable = [];
          MEASURES.forEach(m => {
            const others = MEASURES.filter(x => x.id !== m.id).map(x => x.id);
            let alone = 0, rest = 0;
            LEDGER.forEach(e => {
              alone += e.w * (1 - e.val[m.id - 1]);
              let remain = 1;
              others.forEach(k => { remain *= (1 - e.val[k - 1]); });
              rest += e.w * remain;
            });
            if (alone < rest - 0.001) irreplaceable.push({ m, delta: rest - alone });
          });
          irreplaceable.sort((a, b) => b.delta - a.delta);

          html += '<div class="lab-msg fail"><b>⛔ 哪一项不能被替代（去掉它，损失最大）</b>'
            + '<div class="lab-note">'
            + irreplaceable.slice(0, 3).map(x =>
                '去掉 <code>' + x.m.id + ' ' + x.m.name + '</code> → 残余风险多出 ' +
                Math.round(x.delta / maxResidual * 100) + ' 个百分点').join('<br>')
            + '<br><br><b>怎么读这个结果：</b>排第一的那一项，就是"其它六项一起上也补不回来"的那一项。' +
            '<span class="hit">它是你的最短的一根木板——先把它做掉。</span>'
            + '</div></div>';

          html += '<div class="lab-msg warn"><b>⚠️ 这个审计器不能告诉你的事</b>'
            + '<div class="lab-note">它的数字是<b>由上面的台账推出来的，不是从真实 App 扫出来的</b>。<br>'
            + '真实检测方的权重、以及它对每一处暴露点的敏感度，<b>每一家都不一样</b>；'
            + '而且检测手段本身在更新。所以它的价值不在于那个百分数，'
            + '而在于<b>"暴露点是分层的、覆盖面是不均匀的"这个认知</b>。</div></div>';
          return html;
        },
        expected: (v) => {
          const nums = String(v.pick || '').match(/\d+/g) || [];
          const enabled = [...new Set(nums.map(n => parseInt(n, 10)).filter(n => n >= 1 && n <= 7))];
          const gap = String(v.gap || '').trim();
          const cost = String(v.cost || '').trim();

          if (!gap) return { ok: false, detail: '先回答第 ② 问：哪一项不能被替代？——这是本实验真正的判分点。' };

          /* 先算出"哪一项最不可替代"，用读者自己的勾选情况做基线 */
          const VAL = [
            [1, 0, 1, 0, 0, 0, 1], [1, 0, 1, 0, 0, 0, 1], [0, 1, 0.5, 0, 1, 1, 1],
            [0, 0, 0, 1, 1, 1, 1], [0, 0, 1, 0, 0, 0.5, 1], [1, 0, 1, 0, 1, 0, 1],
            [0, 0, 0, 0.5, 1, 0, 1], [0, 0, 0, 0, 1, 0, 1], [0, 0, 0, 0, 1, 1, 1],
            [0, 0, 0.5, 0, 1, 0, 1], [0, 0, 0, 0.5, 0.5, 0, 1], [0, 0, 0, 0, 0, 0, 0.5],
            [0, 0, 0, 0, 0.5, 0, 0.5], [0, 0, 0, 0, 0, 0, 0.5]
          ];
          const W = [2, 1, 2, 3, 2, 2, 3, 3, 3, 2, 2, 3, 2, 3];
          const allIds = [1, 2, 3, 4, 5, 6, 7];
          const resid = set => W.reduce((acc, w, i) => {
            let remain = 1; set.forEach(k => { remain *= (1 - VAL[i][k - 1]); });
            return acc + w * remain;
          }, 0);
          const W_TOTAL = W.reduce((a, b) => a + b, 0);
          const others = allIds.filter(i => i !== 5);
          const deltaCompile = resid(others) - resid(allIds);
          const othersK = allIds.filter(i => i !== 7);
          const deltaKernel = resid(othersK) - resid(allIds);
          const pctOf = d => Math.round(d / W_TOTAL * 100);

          const saysCompile = window.AKKC_hasConcept(gap,
            ['5', '编译', '自己编译', '重新编译', '源码', '抹掉字符串', '改字符串', '符号', '导出符号',
             '字符串特征', '特征字符串', '线程名', '改编译', 'compile', 'hluda']);
          const saysKernel = window.AKKC_hasConcept(gap,
            ['7', '内核', 'kernel', '内核模块', '驱动', 'ko ', '下沉', '系统调用', 'syscall', '隐藏', 'RWX', 'ptrace']);

          const saysWhy = window.AKKC_hasConcept(gap,
            ['覆盖', '同时', '一次', '多个', '多类', '多种', '改不了', '消不掉', '抹不掉',
             '编译期', '运行时', '二进制', '硬编码', '写死', '别的手段', '其它手段', '其他手段',
             '用户态', '做不到', '唯一', '只有', '不可替代']);
          const saysCost = window.AKKC_hasConcept(cost,
            ['代价', '成本', '要刷', '刷机', '重刷', '变砖', '时间', '维护', '适配', '版本',
             '门槛', '内核', '编译', '升级', '回归', '风险', '只掩蔽', '只是掩盖', '不通用', '耦合']);

          const gapOk = (saysCompile || saysKernel) && saysWhy;
          const ok = gapOk && saysCost;

          let detail = '';
          detail += saysCompile || saysKernel
            ? '✅ 你指出的确有"不能被替代"的性质。' +
              '按本实验的台账算：<b>把手段 5（自己编译）单独拿掉</b>，残余风险约多出 ' + pctOf(deltaCompile) + ' 个百分点；' +
              '<b>把手段 7（内核模块隐藏）单独拿掉</b>，约多出 ' + pctOf(deltaKernel) + ' 个百分点。<br>' +
              '<b>注意这两个数字不大——这恰恰是要讲清的一点：</b>' +
              '它们之所以在"不可替代"上排前面，<b>不是因为它们的数字大，' +
              '而是因为它们覆盖的那几处暴露点，其它六项手段的覆盖度全都接近 0</b>——' +
              '手段 5 覆盖的是编译期写死在二进制里的模块名、特征字符串、导出符号、线程名；' +
              '手段 7 覆盖的是 RWX 痕迹与 ptrace 这类行为特征。' +
              '<span class="hit">换句话说：它们不是"更划算"，而是"没得换"。</span>'
            : '❌ 第 ② 问还没说到点子上。提示：去上面那张表里找一栏——<b>哪一栏的"补法"里写着"改编译"或"内核"？</b>' +
              '再问自己：把那一项拿掉，还有别的手段能覆盖同一个暴露点吗？';
          detail += '<br>';
          detail += saysWhy
            ? '✅ 你给出了"为什么不能替代"的理由（覆盖的是别的手段覆盖不到的那一层）。'
            : '❌ 理由还不够：要说清<b>它覆盖的暴露点，是别的手段覆盖不到的哪一层</b>（编译期写死的东西，运行时改不掉）。';
          detail += '<br>';
          detail += saysCost
            ? '✅ 你也算了代价——这是本实验最容易被忽略的一半。'
            : '❌ 第 ③ 问没提代价。任何一项的收益都有成本：<b>编译要跟上游、要适配；内核要写内核代码、要跟内核版本；ROM 要刷机、有变砖风险。</b>' +
              '只谈收益的取舍不是取舍。';

          return { ok, detail: detail + '<br><br><b>你当前勾选的手段：</b>' + (enabled.length ? enabled.join('、') : '（无）') };
        },
        showAnswer:
          '【本实验的判分点：哪一项不能被替代】\n\n' +
          '不能被替代的是两类，它们覆盖的是"别人覆盖不到的层"：\n\n' +
          '  手段 5「自己编译」\n' +
          '    覆盖面：模块名(maps) + 内存特征字符串 + 导出符号 + 线程名\n' +
          '    为什么不能被替代：\n' +
          '      这些是【编译期写死在二进制里】的东西。\n' +
          '      运行时 hook 只能骗过"用字符串比较函数来检测"的那一类；\n' +
          '      一旦对方直接扫内存字节或遍历导出符号表，hook 就失效了。\n' +
          '      → 想去掉它们，只能重新编译。\n' +
          '    注意：它单独拿掉时，台账上的残余风险只多约 2 个百分点 ——\n' +
          '      因为它覆盖的那几处暴露点权重不高、而其它手段对它们的覆盖度接近 0。\n' +
          '      所以"不可替代"不等于"数字大"，而是"没得换"。\n\n' +
          '  手段 7「内核模块隐藏」\n' +
          '    覆盖面：ptrace 痕迹 + 部分 RWX / JS 运行时结构特征\n' +
          '    为什么不能被替代：\n' +
          '      它们不是"名字"也不是"字符串"，而是【行为的必然副作用】。\n' +
          '      用户态改不了自己的副作用，只能把观测点下沉到内核去改写"别人看到的结果"。\n\n' +
          '【为什么"代价"这一半必须答】\n' +
          '  手段 5 的代价：要跟 Frida 上游。上游一动，补丁可能全部失效。\n' +
          '                 你频繁升级 Frida 的话，这是持续成本。\n' +
          '  手段 7 的代价：要写内核代码，要适配内核版本，门槛高得多。\n' +
          '  手段 8（编进 ROM）的代价：刷机风险、不可回滚（anti-rollback）、变砖。\n' +
          '                 而且它只是【部署方式】，不消除任何暴露点。\n\n' +
          '【一句话结论】\n' +
          '  按【覆盖面】排序，不按【好实现】排序。\n' +
          '  改文件名几乎零成本，但只砍一处；\n' +
          '  改编译成本高，却一次砍掉四类。\n' +
          '  而最后三项（RWX 痕迹 / JS 引擎结构 / ptrace 痕迹）\n' +
          '  是任何用户态手段都无法完全消除的 —— 这就是 21.15 要正面回答的问题。',
        hint:
          '先别看百分数，去上面那张表里找一栏：<b>"补法"里写着"改编译"的那些暴露点。</b><br><br>' +
          '然后问自己三个问题：<br>' +
          '① 这些暴露点的共同点是什么？（提示：它们在哪一层？是名字、映射、字节，还是行为？）<br>' +
          '② 如果不用"改编译"，运行时的手段（hook 字符串比较、过滤 maps）能不能覆盖它们？覆盖到什么程度？<br>' +
          '③ 表里最后三行，有哪一项手段的覆盖度是 1 吗？如果没有——<b>说明什么？</b>',
        after:
          T.note('ok', '✅ 实验的收获',
            '<p style="margin-bottom:0">你现在有一个<b>可复用的审计流程</b>，而不只是一张会过期的对照表：' +
            '<b>列出暴露点 → 标出权重 → 逐项评估覆盖面（允许"部分覆盖"）→ 算残余 → 按覆盖面优劣排序 → 找出不可替代项。</b><br>' +
            '这套流程换一个目标、换一套检测手段，依然能用——' +
            '<span class="hit">因为变的只是台账里的行，不变的是"分层 + 加权 + 覆盖面不均"这个结构。</span></p>')
      }
    },

    /* ============================================================ 21.15 动手实验 B */
    {
      h: '21.15', title: '动手实验 B：用过滤器把 trace 压到最小候选',
      html:
        '<p>21.5 讲了几个过滤器，但"讲"和"会"之间隔着一道手感的墙。' +
        '这个实验给你一段 <b>r0tracer 风格的输出片段</b>（200 条方法调用记录），' +
        '你要用过滤条件把候选压到最小，再从剩下的几个里挑出<b>真正做加密的那一个</b>。</p>' +
        '<p>规则：你选的过滤器是<b>与</b>关系。每加一个，剩下的候选就少一批——' +
        '而代价是<b>你可能把真的那个漏掉</b>。这就是实战里真正的手感。</p>' +
        '<p class="small muted">这段样本刻意做成"<b>过滤到极限也还剩 4 个候选</b>"的形状。' +
        '这不是设计失误，而是实战的常态：<b>过滤器负责把候选数量压下来，"选哪一个"要靠行为判据。</b></p>',
      lab: {
        title: '实验 B：从 trace 输出里定位目标函数',
        goal: '目标：压到最小候选，再挑出真正做加密的那个',
        intro:
          '<p>场景：一个 App 登录时会做签名。你已经用 r0tracer 对 <code>com.example.net</code>、' +
          '<code>com.example.sec</code>、<code>com.example.util</code> 三个包批量打了点，' +
          '输出 <b>200 条</b>记录（下面只展示被当前过滤条件命中的部分和统计）。</p>' +
          '<p><b>任务：</b>① 勾过滤条件，把候选压到最小；' +
          '② 从剩下的候选里说出<b>真正做加密的那一个</b>；' +
          '③ 说清你是靠什么把它和"冒牌货"区分开的。</p>',
        inputs: [
          { key: 'focus', label: '① 你选择的过滤条件（填编号）',
            hint: '1 首次调用　2 只看主线程 tid=1　3 只看业务包　4 只看入参含 nonce=　5 只看耗时 &gt; 5ms　6 只看深度 ≤ 3',
            ph: '例如 1 3', value: '3' },
          { key: 'answer', label: '② 剩下的候选里，真正做加密的是哪个函数？',
            hint: '写方法名即可', ph: '例如 com.example.sec.XxxHelper.yyy', value: '' },
          { key: 'why', label: '③ 说出你是靠哪一条过滤条件把它和"冒牌货"区分开的',
            hint: '表里有一个函数看起来最像加密，但它不是——说清你怎么排除它',
            ph: '因为……', type: 'textarea', rows: 3 }
        ],
        runLabel: '🔍 应用过滤器',
        autorun: true,
        run: (v) => {
          /* ---------------------------------------------------------------
             r0tracer 风格输出样本：200 条记录
             刻意放的两个"陷阱"：
               A. com.example.sec.CryptoAlg.encrypt  —— 名字最像加密，但只是薄封装，
                  真正的加密逻辑在它调用的 NativeHelper.doCrypt，而 doCrypt 是 native 方法，
                  r0tracer 的 Java 层打点看不到它（只有一条 native 调用的痕迹）。
               B. java/org 包里的 MessageDigest / Base64 —— 是标准库，不是业务加密。
             --------------------------------------------------------------- */
          const CALLS = [];
          const push = (fn, tid, arg, ms, depth, first) =>
            CALLS.push({ fn, tid, arg, ms, depth, first });

          /* 业务包：com.example.net.*（网络层） */
          const NET = 'com.example.net';
          const netMethods = ['buildRequest', 'addHeader', 'setBody', 'openConnection', 'readResponse', 'parseJson', 'checkRetCode'];
          netMethods.forEach((m, i) => {
            for (let k = 0; k < 4; k++) {
              push(NET + '.HttpApi.' + m,
                   k === 0 ? 1 : 4211,
                   k === 0 ? '{"nonce=ab12cd34", "uid=10086"}' : '{}',
                   0.4 + i * 0.3, 1 + (i % 3), k === 0);
            }
          });
          /* 业务包：com.example.util.*（工具类，噪音） */
          const UTIL = 'com.example.util';
          ['toHex', 'fromHex', 'isEmpty', 'join', 'splitSafe', 'md5', 'base64Encode', 'randomStr', 'timestamp']
            .forEach((m, i) => {
              for (let k = 0; k < 4; k++) {
                push(UTIL + '.Bytes.' + m, k === 0 ? 1 : 4211, k === 0 ? 'nonce=ab12cd34' : '',
                     0.1 + i * 0.05, 2, k === 0);
              }
            });
          /* 业务包：com.example.sec.*（安全包 —— 目标在这里） */
          const SEC = 'com.example.sec';
          /* 冒牌货：名字像加密，但是薄封装 */
          push(SEC + '.CryptoAlg.encrypt', 1, '{"nonce=ab12cd34"}', 6.8, 1, true);
          push(SEC + '.CryptoAlg.encrypt', 1, '{"nonce=ab12cd34"}', 7.1, 1, false);
          push(SEC + '.CryptoAlg.encrypt', 1, '{"nonce=ab12cd34"}', 6.5, 1, false);
          push(SEC + '.CryptoAlg.encrypt', 1, '{"nonce=ab12cd34"}', 6.9, 1, false);
          /* 真目标：入参带 nonce，耗时明显大，且不是 native 薄封装 */
          push(SEC + '.SignCore.doSign', 1, 'nonce=ab12cd34&uid=10086', 12.4, 1, true);
          push(SEC + '.SignCore.doSign', 1, 'nonce=ab12cd34&uid=10086', 12.9, 1, false);
          push(SEC + '.SignCore.doSign', 1, 'nonce=ab12cd34&uid=10086', 12.1, 1, false);
          push(SEC + '.SignCore.doSign', 1, 'nonce=ab12cd34&uid=10086', 12.6, 1, false);
          /* 真目标的辅助方法 */
          push(SEC + '.SignCore.buildKey', 1, 'nonce=ab12cd34', 1.2, 2, true);
          push(SEC + '.SignCore.buildKey', 1, 'nonce=ab12cd34', 1.1, 2, false);
          push(SEC + '.SignCore.mixRounds', 1, 'nonce=ab12cd34', 8.3, 2, true);
          push(SEC + '.SignCore.mixRounds', 1, 'nonce=ab12cd34', 8.1, 2, false);
          /* 干扰：sec 包里与本次登录无关的检测/初始化方法 */
          ['antiFridaCheck', 'verifyApk', 'initEnv', 'checkRoot', 'startWatchdog']
            .forEach((m, i) => {
              for (let k = 0; k < 5; k++) {
                push(SEC + '.Guard.' + m, 4612, '', 0.3 + i * 0.2, 1, k === 0);
              }
            });
          /* 干扰：工作线程上的方法 */
          ['decodeResp', 'retryLogic', 'queueTask']
            .forEach((m, i) => {
              for (let k = 0; k < 5; k++) {
                push(SEC + '.Async.' + m, 4301, '', 0.6 + i * 0.4, 3, k === 0);
              }
            });
          /* 干扰：标准库 */
          push('javax.crypto.Cipher.getInstance', 1, 'AES/CBC/PKCS5Padding', 2.1, 6, true);
          push('javax.crypto.Cipher.init', 1, 'nonce=ab12cd34', 3.4, 6, true);
          push('javax.crypto.Cipher.doFinal', 1, '', 9.2, 6, true);
          push('java.security.MessageDigest.digest', 1, '', 2.8, 6, true);
          push('android.util.Base64.encodeToString', 1, '', 0.3, 6, true);
          push('com.example.sec.NativeHelper.doCrypt', 1, 'nonce=ab12cd34', 11.9, 2, true);
          push('com.example.sec.NativeHelper.doCrypt', 1, 'nonce=ab12cd34', 11.7, 2, false);
          /* 把总量补到 200 条 */
          let pad = 0;
          while (CALLS.length < 200) {
            const m = netMethods[pad % netMethods.length];
            push(NET + '.HttpApi.' + m, 4211, '{}', 0.2 + (pad % 5) * 0.1, 2, false);
            pad++;
          }

          const F = [
            { id: 1, name: '只看首次调用', apply: c => c.first },
            { id: 2, name: '只看主线程 tid=1', apply: c => c.tid === 1 },
            { id: 3, name: '只看业务包(com.example)', apply: c => c.fn.indexOf('com.example') === 0 },
            { id: 4, name: '只看入参含 nonce=', apply: c => c.arg.indexOf('nonce=') >= 0 },
            { id: 5, name: '只看耗时 > 5ms', apply: c => c.ms > 5 },
            { id: 6, name: '只看深度 ≤ 3', apply: c => c.depth <= 3 }
          ];
          const nums = String(v.focus || '').match(/\d+/g) || [];
          const on = [...new Set(nums.map(n => parseInt(n, 10)).filter(n => n >= 1 && n <= 6))];
          let kept = CALLS.filter(c => on.every(id => F.find(f => f.id === id).apply(c)));
          /* 首次调用过滤在样本里是"记录级"的：如果同时开了 1，同方法只留一条 */
          if (on.indexOf(1) >= 0) {
            const seen = {};
            kept = kept.filter(c => { if (seen[c.fn]) return false; seen[c.fn] = 1; return true; });
          }

          const byFn = {};
          kept.forEach(c => { byFn[c.fn] = (byFn[c.fn] || 0) + 1; });
          const fns = Object.keys(byFn).sort((a, b) => byFn[b] - byFn[a]);

          let html = '<div class="lab-kv">'
            + '<span>原始记录 <b>200</b> 条</span>'
            + '<span>命中过滤 <b>' + on.length + '</b> 个</span>'
            + '<span>剩余记录 <b>' + kept.length + '</b> 条</span>'
            + '<span>剩余函数 <b style="color:var(--warn)">' + fns.length + '</b> 个</span>'
            + '</div>';

          html += '<div class="lab-kv"><span>已启用：<b>'
            + (on.length ? on.map(i => F.find(f => f.id === i).name).join(' ＋ ') : '（无，全量输出）')
            + '</b></span></div>';

          html += '<table class="lab-tbl"><tr><th>函数</th><th>命中条数</th><th>线程</th><th>耗时</th><th>深度</th></tr>';
          fns.slice(0, 25).forEach(fn => {
            const one = kept.find(c => c.fn === fn);
            html += '<tr><td><code>' + fn + '</code></td>'
              + '<td>' + byFn[fn] + '</td>'
              + '<td>' + one.tid + '</td>'
              + '<td>' + one.ms.toFixed(1) + ' ms</td>'
              + '<td>' + one.depth + '</td></tr>';
          });
          if (!fns.length) html += '<tr><td colspan="5" class="muted">（没有记录命中——过滤器加得太紧了）</td></tr>';
          if (fns.length > 25) html += '<tr><td colspan="5" class="muted">…还有 ' + (fns.length - 25) + ' 个函数</td></tr>';
          html += '</table>';

          /* ---- 收敛进度提示 ---- */
          if (kept.length === 0) {
            html += '<div class="lab-msg fail"><b>❌ 过滤太紧，什么都没剩下</b>'
              + '<div class="lab-note">这是实战里最常见的一步：<b>过滤器加多了，真的那个也被筛掉了。</b><br>'
              + '注意成本和收益——每加一个过滤条件，你都必须确定<b>"我的目标一定满足这个条件"</b>，' +
              '否则就是在赌。去掉一个再试。</div></div>';
          } else if (fns.length <= 4) {
            html += '<div class="lab-msg pass"><b>✅ 已经压到最小候选集（' + fns.length + ' 个）</b>'
              + '<div class="lab-note">再往下加过滤器就要冒"把真的筛掉"的风险了。<br>'
              + '<b>现在轮到了判据这一步——这 ' + fns.length + ' 个里，谁是真正做加密的？</b><br>' +
              '把它们逐个问一遍：<br>' +
              '• 它是<b>标准库</b>吗？（<code>javax.*</code> / <code>java.*</code> / <code>android.*</code>）——那是框架调用，不是这个 App 的逻辑；<br>' +
              '• 它<b>自己做了计算</b>，还是只是转手给别人？（看耗时、看它下面调了谁）<br>' +
              '• 它是 <b>native 方法</b>吗？——Java 层打点看不到 native 方法体内部。<br>' +
              '<span class="hit">注意：这里没有"唯一正确"的过滤器组合。' +
              '你能做的是把候选压到最小，然后靠行为判据做最后一步。</span></div></div>';
          } else {
            html += '<div class="lab-msg warn"><b>还有 ' + fns.length + ' 个函数没排除</b>'
              + '<div class="lab-note">还差一步。看看列表里哪些明显不是你要的——' +
              '注意里面有<b>标准库</b>（<code>javax.crypto</code> / <code>java.security</code> / <code>android.util</code>）' +
              '和<b>业务包里的工具类</b>（比如 <code>com.example.net.*</code>、<code>com.example.util.*</code>。<br>'
              + '<b>提示：</b>真正的加密运算是有耗时的（毫秒级以上）；而且它是"业务自己写的"。' +
              '试试再加上「只看入参含 nonce=」和「只看耗时 &gt; 5ms」。</div></div>';
          }

          html += '<div class="lab-msg key"><b>🔑 四个过滤器的真实性价比</b><div class="lab-note">'
            + '<b>「只看业务包」</b>——最安全、几乎不会误伤，应该是你的第一个过滤器。<br>'
            + '<b>「只看首次调用」</b>——砍得最狠，但会丢掉"调用次数"信息。' +
            '如果你的线索是"这个方法被循环调用了很多次"（比如逐字节处理），<b>就不能开它。</b><br>'
            + '<b>「只看入参含特定字符串」</b>——最精准，但<b>前提是你得先知道那个字符串</b>。' +
            '而"知道那个字符串"往往需要先跑一次不过滤的会话——<b>用一次全量输出换一个精确条件，是划算的。</b><br>'
            + '<b>「只看特定线程」</b>——注意本例里<b>干扰方法全在工作线程上（tid≠1）</b>，' +
            '所以它是有效的；但如果目标方法恰好也在工作线程上，这一刀就砍到自己了。'
            + '</div></div>';
          return html;
        },
        expected: (v) => {
          const ans = String(v.answer || '').trim();
          const why = String(v.why || '').trim();
          if (!ans) return { ok: false, detail: '先回答第 ② 问：剩下的候选里，真正做加密的是哪个函数？' };

          const isRight = window.AKKC_hasConcept(ans, ['doSign', 'SignCore.doSign', 'SignCore', 'sign']);
          const isSub = window.AKKC_hasConcept(ans, ['mixRounds', 'buildKey']);
          const isTrap = window.AKKC_hasConcept(ans, ['CryptoAlg', 'CryptoAlg.encrypt', 'encrypt']);
          const isStd = window.AKKC_hasConcept(ans, ['Cipher', 'MessageDigest', 'Base64', 'NativeHelper']);
          const saysWhy = window.AKKC_hasConcept(why,
            ['耗时', 'ms', '时间', '慢', 'native', '封装', '薄封装', '看不到', '标准库', 'javax',
             '业务包', 'com.example', 'nonce', '名字', '像', '冒牌', '不是它', '排除', '深度',
             '转手', '转发', '只是调', '入口', '最慢']);

          if (isRight && saysWhy) {
            return { ok: true, detail:
              '✅ 正确。<b>com.example.sec.SignCore.doSign</b> 才是真正做签名的那一个。<br>' +
              '一个有效的收敛路径是：<b>「只看业务包(3)」+「只看入参含 nonce=(4)」+「只看耗时 &gt; 5ms(5)」</b>，' +
              '把候选从 34 个压到 4 个。<br>' +
              '<b>但请注意：过滤器压到 4 个就到极限了，最后一步靠的是行为判据，不是过滤器。</b><br>' +
              '<span class="hit">逐个排除：</span><code>mixRounds</code> 是它调用的子函数；' +
              '<code>NativeHelper.doCrypt</code> 是 native 方法（Java 层看不到内部）；' +
              '<code>CryptoAlg.encrypt</code> 名字最像加密、耗时也过了线，' +
              '<b>但在它下面能看到它调了 <code>NativeHelper.doCrypt</code>——说明它只是把活转手给了 native。</b>' +
              '而 <code>doSign</code> 耗时最高（12.4ms）、入参是最完整的签名载荷、且它自己是业务实现而非薄封装。' };
          }
          if (isSub) {
            return { ok: false, detail:
              '❌ <code>' + ans + '</code> 是 <code>SignCore</code> 里的<b>子函数</b>，不是加密入口。<br>' +
              '它确实在做计算（<code>mixRounds</code> 耗时 8.3ms 也不算小），但它是被 <code>doSign</code> 调用的。<br>' +
              '<b>怎么看出来：</b>看<b>深度</b>那一列——子函数的调用深度更大（被别的业务方法包着）。<br>' +
              '<b>先找入口，再看入口下面调了什么</b>，而不是直接扎到最里层。' };
          }
          if (isTrap) {
            return { ok: false, detail:
              '❌ 你选的是那个<b>陷阱</b>。<code>com.example.sec.CryptoAlg.encrypt</code> 名字确实最像加密，' +
              '它也满足"业务包"、"入参含 nonce"、"耗时 &gt; 5ms"全部三个条件，看起来完全像答案。<br>' +
              '但它<b>只是薄封装</b>：它下面调用了 <code>NativeHelper.doCrypt</code>，' +
              '而这是一个 <b>native 方法</b>——<b>r0tracer 是 Java 层的批量打点工具，看不到 native 方法体内部。</b><br>' +
              '<b>这正好说明一般规律：名字最像的那个，往往不是你要找的那个。</b>' +
              '真正的判据是<b>行为</b>（耗时、调用链、参数形态），不是名字。' };
          }
          if (isStd) {
            return { ok: false, detail:
              '❌ <code>' + ans + '</code> 属于<b>标准库或 native 边界</b>，不是"这个 App 自己写的加密逻辑"。<br>' +
              '<code>javax.crypto.Cipher</code> / <code>java.security.MessageDigest</code> / ' +
              '<code>android.util.Base64</code> 是框架提供的；<code>NativeHelper.doCrypt</code> 是 native 方法，' +
              'Java 层打点看不到它的内部。<br>' +
              '<b>它们都有价值</b>（能告诉你用了什么算法、什么时候调用），' +
              '但它们不是"业务加密逻辑"本身。<b>先分清"我找的是业务逻辑还是框架调用"。</b>' };
          }
          return { ok: false, detail:
            '❌ 还没定位对。<br>' +
            '提示：先用<b>业务包过滤</b>排除掉 <code>javax.*</code> / <code>java.*</code> / <code>android.*</code>，' +
            '再用<b>耗时过滤</b>排除掉那些 1ms 以下的工具函数，' +
            '剩下满足"入参含 nonce"的方法里，<b>哪个既是业务实现、又真正做了计算？</b>' };
        },
        showAnswer:
          '【第一步：用过滤器把候选压到最小】\n' +
          '  过滤器 3「只看业务包」   → 排除 javax.* / java.* / android.*，34 个降到 29 个\n' +
          '  过滤器 4「只看入参含 nonce=」→ 排除和本次签名无关的方法，降到 21 个\n' +
          '  过滤器 5「只看耗时 > 5ms」  → 排除所有轻量工具函数，降到 4 个\n' +
          '  → 到此为止。再加过滤器就要冒"把真的筛掉"的风险了。\n\n' +
          '  【关键认知】过滤器只能把候选压到 4 个，压不到 1 个。\n' +
          '    最后一步（选出唯一那个）靠的是行为判据，不是更多的过滤器。\n\n' +
          '【第二步：在 4 个候选里逐个排除】\n' +
          '  候选：CryptoAlg.encrypt / SignCore.doSign\n' +
          '        SignCore.mixRounds / NativeHelper.doCrypt\n\n' +
          '  ✗ com.example.sec.NativeHelper.doCrypt\n' +
          '      它是 native 方法。r0tracer 是 Java 层的批量打点工具，\n' +
          '      看不到 native 方法体内部。有价值，但不是"业务加密逻辑"本身。\n\n' +
          '  ✗ com.example.sec.SignCore.mixRounds\n' +
          '      它是 SignCore 里的子函数（看"深度"那一列，它被别的业务方法包着）。\n' +
          '      在做计算 ≠ 是入口。先找入口，再看入口下面调了什么。\n\n' +
          '  ✗ com.example.sec.CryptoAlg.encrypt   ← 最容易选错的那个\n' +
          '      名字最像加密，耗时 6~7ms 也过了线，三个过滤条件全部满足。\n' +
          '      但它下面调用了 NativeHelper.doCrypt —— 它只是转手给了 native，\n' +
          '      自己没有实现算法。\n' +
          '      → 教训：名字最像的那个，往往不是你要找的那个。\n\n' +
          '  ✓ com.example.sec.SignCore.doSign\n' +
          '      耗时最高（12.4ms），入参是最完整的签名载荷（nonce + uid），\n' +
          '      而且是业务包里的实现（不是 native 边界，也不是子函数）。\n\n' +
          '【四个过滤器的性价比排序】\n' +
          '  最安全：只看业务包 —— 几乎不会误伤，应该是第一个\n' +
          '  砍最狠：只看首次调用 —— 但会丢掉"调用次数"这个信息\n' +
          '  最精准：只看入参含特定字符串 —— 前提是你先知道那个字符串\n' +
          '  最危险：只看特定线程 —— 目标方法可能恰好就在你想排除的那个线程上\n\n' +
          '【本实验的真正目的】\n' +
          '  不是记住"用 3+4+5"，而是建立三条手感：\n' +
          '    ① 每加一个过滤器，都是在用"可能漏掉真的"换"少看一些噪音"\n' +
          '    ② 过滤器有极限，别指望它给出唯一答案；最后一步永远是行为判据\n' +
          '    ③ 判据是行为（耗时 / 调用链 / 参数形态），不是名字',
        hint:
          '分三步想：<br>' +
          '① 哪些函数<b>一眼就不可能是</b>业务加密？提示：看包名——' +
          '<code>javax.*</code>、<code>java.*</code>、<code>android.*</code> 是框架，不是这个 App 的逻辑。<br>' +
          '② 剩下里，哪些<b>名字像但不是</b>？提示：注意有一个函数下面出现了 ' +
          '<code>NativeHelper.doCrypt</code>——那说明它自己没做事，只是转手给了 native。<br>' +
          '③ 真正的密码学运算<b>要花时间</b>。把耗时列出来排个序，最慢的那一批是哪些？',
        after:
          T.note('ok', '✅ 实验的收获',
            '<p style="margin-bottom:0">你现在亲手做过一遍"从海量 trace 收敛到目标函数"：' +
            '<b>先撒网 → 用便宜且安全的过滤器砍大块 → 用业务语义（字符串 / 耗时）精修 → ' +
            '在剩下几个候选里用行为判据做最后一步 → 回验。</b><br>' +
            '<span class="hit">这里最容易记错的一点是：过滤器不会给你唯一答案。' +
            '它把候选从几十个压到几个，剩下的必须靠"它是标准库吗 / 它自己算了吗 / 它是 native 吗"来判断。</span><br>' +
            '最后那一步回验最容易被跳过，而它恰恰是"猜对了"和"知道对了"的分界线。</p>')
      }
    },

    /* ============================================================ 21.16 */
    {
      h: '21.16', title: '决策演练一：手上只有一份公开的 frida-server',
      html:
        '<p>这是最常见的第一现场。你在<b>自己或已获授权的测试设备</b>上，' +
        '手上只有一份从公开渠道下载的标准 frida-server，App 一检测到就退出。' +
        '<b>你没有源码、没刷机、也没有时间。</b></p>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            scenario: '<b>现象：</b>App 启动后 3 秒内退出，日志里没有任何异常栈。' +
                      '你 attach 上去时进程已经没了。<br>' +
                      '<b>你手上的资源：</b>一份标准 frida-server、一台已 root 的测试机、' +
                      '一份还没看过的 APK。<b>没有源码，还没编译过 Frida。</b>',
            q: '你第一件事做什么？',
            choices: [
              { t: '先改文件名 + 换安装目录 + 换监听端口，再 attach 一次看看', next: 'n1' },
              { t: '直接去下载 Frida 源码，开始编译一个去特征版本', next: 'n2' },
              { t: '改用 spawn 模式（frida -f 包名）抢先注入，看能否在检测执行前挂上钩子', next: 'n3' },
              { t: '先反编译 APK，静态定位它的检测逻辑，再决定怎么改', next: 'n4' }
            ]
          },
          n1: {
            scenario: '<b>改完三样（文件名、目录、端口）之后 attach —— App 还是退了。</b><br>' +
                      '你确认了新文件名和新端口都生效了（frida-ps 能看到、端口也确实不是默认的）。',
            q: '现在最该做的下一步是什么？',
            choices: [
              { t: '既然名字改了还是被发现，说明它检测的是二进制里的字符串或线程名——先去确认它到底在看哪一层', next: 'n5' },
              { t: '继续改更多名字：把所有相关文件、目录都改成毫不相关的名字', next: 'n6' },
              { t: '放弃 Frida，改用 Xposed / LSPosed 模块', next: 'n7' }
            ]
          },
          n5: {
            terminal: true, verdict: 'good',
            verdictTitle: '这是正确的第二刀：先确认"它在看哪一层"',
            result:
              '<p><b>为什么这是对的：</b>改名字只覆盖了第 1 层暴露面（进程名 / 端口 / 路径）。' +
              '名字改完还在被杀，说明<b>检测点在第 2 层或更深</b>——而第 2 层的补法和第 1 层完全不同。</p>' +
              '<p><b>具体怎么"确认它在看哪一层"：</b><br>' +
              '① 看 <code>/proc/self/maps</code> 里还有没有 frida 相关内容 → 有，说明它读的是 maps；<br>' +
              '② 看 <code>/proc/self/task/*/comm</code> 里还有没有 <code>gum-js-loop</code> 一类线程 → 有，说明它读线程名；<br>' +
              '③ 在 <code>open</code> / <code>read</code> 上挂钩，看它到底打开了哪些文件 → ' +
              '<b>这一步最有说服力</b>，因为你能直接看到它的检测动作。</p>' +
              '<p><b>认知根源：</b>你已经做对了一件最关键的判断——' +
              '<b>把"改名没用"读成"它在看更深的一层"，而不是"改名这招不管用"。</b><br>' +
              '很多人卡在这里，是因为他们把"手段失效"当成了"这条路走不通"，' +
              '于是去换工具、换框架——<span class="miss">而换工具从来不会改变暴露面，因为暴露面是 Frida 的，不是某个工具的。</span></p>'
          },
          n6: {
            terminal: true, verdict: 'bad',
            verdictTitle: '你在第 1 层越做越细，但对手早就看到第 2 层了',
            result:
              '<p><b>这条路会在什么时候失败：</b>当检测方<b>不读文件名</b>的时候。' +
              '它可能读的是 <code>/proc/self/maps</code>（映射表里有模块名，' +
              '而模块名是编译产物的一部分，你改磁盘上的文件名不影响它），' +
              '或者读 <code>/proc/self/task/*/comm</code>（线程名是运行时创建的）。</p>' +
              '<p><b>具体表现：</b>你把文件、目录改得面目全非，App 依然一启动就退——' +
              '而且你会开始怀疑"是不是改名没生效"，跑去反复验证文件确实改名了，' +
              '<span class="miss">白花一两个小时在一个已经做对的事情上。</span></p>' +
              '<p><b>认知根源：</b>你把"改名"当成了一个<b>可以一直做深的策略</b>，' +
              '但它其实只覆盖一个很薄的层。<b>"还能再改点什么名字"不是一个新的假设，' +
              '只是在同一个假设上刷细节。</b><br>' +
              '<span class="hit">遇到"手段做了但没效果"，正确的反应是<b>换一个假设</b>，而不是把同一个手段做得更彻底。</span></p>'
          },
          n7: {
            terminal: true, verdict: 'bad',
            verdictTitle: '换框架解决不了"我是个 hook 框架"这个问题',
            result:
              '<p><b>这条路会在什么时候失败：</b>几乎立刻。因为 Xposed / LSPosed 有<b>自己的检测面</b>' +
              '（第 22 章会把 LSPosed 自己的暴露面积讲清楚），而更关键的是——' +
              '大多数 App 的反调试检测是<b>按"有没有被 hook"来查的，而不是按"你叫 Frida 还是 Xposed"来查的</b>。</p>' +
              '<p><b>具体表现：</b>你换了框架，App 换个崩溃方式再来一次：' +
              '这次可能不是静默退出，而是崩溃在某个校验函数里。' +
              '你又去研究 LSPosed 的特征，然后卡在同一个位置。</p>' +
              '<p><b>认知根源（这条最重要）：</b>你把"<b>工具选择问题</b>"当成了"<b>对抗问题</b>"。<br>' +
              '换工具改变的是"我用什么去 hook"，而没改变"我留下了什么痕迹"。<br>' +
              '<span class="miss">第 10 章那张对照表里有一条通用规律：能改自己就改自己，改不了自己就去改对方的观察管道，' +
              '两者都不行就抢时序。</span>这三条<b>没有一条是"换个工具"</b>。<br>' +
              '而且每一次换工具，你都要重新学一遍它的特征面——<b>成本在累积，问题一个没解决。</b></p>'
          },
          n2: {
            terminal: true, verdict: 'bad',
            verdictTitle: '在没确认"它在看哪一层"之前就启动编译，是把成本押在了未知上',
            result:
              '<p><b>这条路会在什么时候失败：</b>两种情况都会。<br>' +
              '<b>① 如果检测只在第 1 层</b>（只查进程名和端口），那你改个文件名就解决了，' +
              '编译纯属白干——而这个白干的成本是<b>一整天到几天</b>（拉源码、配工具链、解依赖、打补丁、编译、验证）。<br>' +
              '<b>② 如果检测在第 3 层</b>（扫二进制字符串、遍历导出符号），那编译<b>确实是必需的</b>——' +
              '但你在编译完之后<b>依然要面对"要改哪些字符串"这个问题</b>，' +
              '而这个问题只能通过观察目标的检测行为来回答。</p>' +
              '<p><b>认知根源：</b>你把"自己编译"当成了<b>一种更强的手段</b>，' +
              '但它其实只是<b>覆盖第 3 层的手段</b>。手段的强弱是相对于层而言的，' +
              '没有一种手段在所有层都更强。<br>' +
              '<span class="hit">正确顺序永远是：先确定暴露点在哪一层（花几分钟），再选覆盖面匹配的手段。' +
              '先选手段再找问题，是在用自己的时间赌一个未知。</span></p>'
          },
          n3: {
            scenario: '<b>你改用 spawn 模式（frida -f 包名），脚本在 App 主逻辑之前注入。</b><br>' +
                      '这一次脚本确实跑起来了，但 App <b>还是退出了</b>——' +
                      '只不过退出时间晚了一两秒，而且日志里出现了你脚本的前几行输出。',
            q: '这个结果告诉了你什么？',
            choices: [
              { t: 'spawn 已经抢到一部分时序了，说明检测代码在更早的位置（比如 so 的初始化流程）——下一步应该把介入点前移到 dlopen', next: 'n8' },
              { t: '既然脚本跑起来了还是被杀，说明 spawn 也没用，回去用 attach 更省事', next: 'n9' },
              { t: '把脚本里所有 console.log 都去掉，减少对 App 的干扰再试一次', next: 'n10' }
            ]
          },
          n8: {
            terminal: true, verdict: 'good',
            verdictTitle: '这是正确的读法：spawn 把边界推后了，说明墙还在更早的地方',
            result:
              '<p><b>为什么这是对的：</b>你拿到了一个非常有价值的信息——' +
              '<b>attach 时脚本一行都不输出（太晚），spawn 时脚本能输出几行（早了一点）。</b>' +
              '这说明检测代码的位置在<b>"spawn 注入点"和"App 主逻辑"之间</b>，而不是在更后面。</p>' +
              '<p><b>下一步为什么是 hook dlopen：</b>App 启动早期跑的那段代码，' +
              '大概率在某个 so 的初始化流程里（<code>JNI_OnLoad</code>、构造函数、<code>.init_array</code>）。' +
              '而 so 的加载入口是 <code>dlopen</code> / <code>android_dlopen_ext</code>——' +
              '<b>在加载入口上下钩，你就能拿到"谁在什么时候被加载了"，' +
              '并在调用方拿到句柄之后、继续执行之前动手。</b></p>' +
              '<p><b>认知根源：</b>你把"partially 成功"读成了<b>一个边界测量结果</b>，而不是"又一次失败"。<br>' +
              '<span class="hit">这是对抗工作里最重要的读数习惯：' +
              '每一次"部分生效"都在告诉你"墙在哪"，而知道墙在哪，就已经把搜索空间砍掉了一大半。</span></p>'
          },
          n9: {
            terminal: true, verdict: 'bad',
            verdictTitle: '你把一次"有用的部分成功"读成了"又一次失败"',
            result:
              '<p><b>这条路会在什么时候失败：</b>你退回去用 attach 之后，会得到和一开始一模一样的现象——' +
              '脚本完全没机会执行。然后你可能得出结论"这个 App 就是防 Frida，没办法"，收工。</p>' +
              '<p><b>你丢掉了什么信息：</b>attach 时脚本零输出、spawn 时脚本有几行输出，' +
              '这两个现象的<b>差</b>是一个精确的边界测量：<b>检测发生在 spawn 注入点之后、App 主逻辑之前。</b><br>' +
              '<span class="miss">"部分成功"是最贵的情报，把它当成失败扔掉，等于把已经买到的信息退回去。</span></p>' +
              '<p><b>认知根源：</b>你用"成功 / 失败"这个二分法在读结果，' +
              '而对抗工作的结果几乎从来不是二分的——它是<b>"我的介入点离目标的运行点还差多远"这个连续量</b>。<br>' +
              '<span class="hit">把"脚本输出了几行"当成一个可以优化的指标，比把"有没有被杀"当成成败，路要好走得多。</span></p>'
          },
          n10: {
            terminal: true, verdict: 'bad',
            verdictTitle: '你在优化一个不是瓶颈的东西',
            result:
              '<p><b>这条路会在什么时候失败：</b>当你去掉 log 之后，App <b>依然会退出</b>——' +
              '因为退出是检测逻辑导致的，不是因为你的 <code>console.log</code> 慢了。<br>' +
              '更有意思的是：日志变少了，你反而<b>失去了唯一的测量手段</b>。' +
              '本来"脚本输出了几行"是判断介入时机的唯一证据，现在连这个都没有了。</p>' +
              '<p><b>认知根源：</b>你假设了"干扰"是原因，但<b>没有任何证据支持这个假设</b>。<br>' +
              '这和对 <code>n6</code> 那条路是同一个错误：<b>把"我还能做的一件事"当成了"我该做的一件事"。</b><br>' +
              '<span class="hit">判断的依据应该是"这个动作能验证或推翻哪个假设"，' +
              '而不是"这个动作我做得来"。</span></p>'
          },
          n4: {
            scenario: '<b>你先做了静态分析。</b>APK 反编译出来，看到壳的代码和一份体积不小的 native 库。' +
                      '你花时间翻了一轮，在 native 库里找到了几个名字像检测的函数。' +
                      '<b>但你没有运行时的证据，无法确定它们在哪一步被调用、以及调用条件是什么。</b>',
            q: '现在怎么办？',
            choices: [
              { t: '把定位到的检测函数直接 nop 掉，再运行看效果', next: 'n11' },
              { t: '先用最便宜的运行时手段（改名 / 换端口 / spawn）跑一遍，用"改到哪一步生效"来反推它到底在看什么', next: 'n12' }
            ]
          },
          n11: {
            terminal: true, verdict: 'bad',
            verdictTitle: '静态定位 + 直接 nop：你在没有运行时证据的情况下改代码',
            result:
              '<p><b>这条路会在什么时候失败：</b>失败概率相当高，而且失败得很安静。<br>' +
              '① <b>你 nop 的可能不是真正生效的那一个</b>——第 10 章那个案例里，' +
              '看起来像"反调试总入口"的函数有好几个，真正起作用的是<b>被复用 4 次的那一个核心原语</b>。<br>' +
              '② <b>检测函数可能还没执行到，你的 nop 本身就需要时机</b>——' +
              '如果它在 boot 阶段就跑完了，你 attach 上去再 nop 已经晚了。<br>' +
              '③ <b>静态看到的名字可能是假的</b>——动态注册（第 10 章）、内联 dispatch、' +
              '自定义 Linker（第 4 章）都会让静态结果误导你。</p>' +
              '<p><b>认知根源：</b>你跳过了"测量"这一步，直接用静态结果下刀。<br>' +
              '静态分析给的是<b>可能性</b>（"这里有这么一段代码"），运行时给的是<b>现实性</b>' +
              '（"它确实在这里执行了"）。<span class="miss">在对抗检测这种问题里，' +
              '可能性远远不够——你必须知道它是什么时候、因为什么被触发的。</span><br>' +
              '<span class="hit">而且这里有个成本问题：静态翻库可能要几个小时，' +
              '而"改名 + 换端口 + spawn 跑一遍"只要几分钟，却能告诉你一大堆信息。' +
              '顺序错了，时间就白花了。</span></p>'
          },
          n12: {
            terminal: true, verdict: 'good',
            verdictTitle: '先用便宜的运行时手段做"探针"，再决定要不要下刀',
            result:
              '<p><b>为什么这是对的：</b>改名 / 换端口 / spawn 这些手段的意义<b>不只是"可能绕过"，' +
              '更是"能当探针用"。</b></p>' +
              '<p><b>具体怎么用它们当探针：</b><br>' +
              '① 只换端口 → 还退？说明它不查端口。<br>' +
              '② 只改文件名 → 还退？说明它不查进程名。<br>' +
              '③ 只改 spawn → 输出变多了？说明检测在注入点之后。<br>' +
              '④ 都不生效 → 那基本可以确定它看的是 maps / 字符串 / 线程名，' +
              '这时再去静态分析<b>就是有方向的</b>：直接找它读 maps 或比较字符串的地方。</p>' +
              '<p><b>认知根源：</b>你把"对抗手段"和"诊断手段"看成了同一批东西的两面。<br>' +
              '同一个动作，在还没定位问题时是<b>探针</b>，在定位之后才是<b>解法</b>。<br>' +
              '<span class="hit">这一步选对，你后面所有的静态分析都带着一个明确的假设；' +
              '选错，你就是在几万个函数里凭感觉翻。</span></p>'
          }
        }
      },
      quiz: {
        id: 'q21-3', chapter: 21, answer: 1,
        stem: '你手上有公开的 frida-server，App 检测到 Frida 就退出。' +
              '改文件名、换安装目录、换监听端口之后仍然退出。以下判断哪个最站得住？',
        options: [
          { t: '这三个改动没生效，需要重新确认一遍改了没有',
            why: '验证改动是否生效当然值得做一次，但把"没效果"默认归因为"我没改对"，会让你在一个已经做对的事情上反复打转。改完还在被杀，是"检测点不在这三处"的强信号。' },
          { t: '检测点不在第 1 层（名字与端口），而在更深的层——比如读 /proc/self/maps、扫二进制字符串、或读线程名',
            why: '正确。文件名、端口、路径属于"最容易看到也最容易改掉"的那一层；这三处都清干净了还在被杀，说明对方看的是映射表、二进制内容或运行时线程——它们的补法与第 1 层完全不同。' },
          { t: '这个 App 用了某种无法绕过的检测，Frida 路线走不通了',
            why: '"无法绕过"是一个需要大量证据才能下的结论。现在的证据只是"三个特定手段无效"，离"无法绕过"差得很远——比如可以换 spawn 抢时序、hook dlopen 前移介入点、走内核路线。' },
          { t: '应该改用非 Frida 的方案（比如第 13 章的内核路线）',
            why: '内核路线在"特征藏不住"时确实是正确方向，但它门槛高得多（写内核代码、适配内核版本）。在还没搞清暴露点在哪一层之前就跳到最重的方案，是把成本押在未知上。' }
        ],
        explain:
          '<p><b>这道题考的是"读结果"的能力，不是记手段。</b></p>' +
          '<p>改名字、换端口、换路径，覆盖的是 21.2 里的<b>第 1 层</b>暴露面：' +
          '它们是"最容易看到"的，也正是"最容易改掉"的。所以这一层被清干净而 App 依然被杀，' +
          '只有一个合理解释：<b>检测点不在第 1 层。</b></p>' +
          '<p><b>第 2、3 层的补法和第 1 层是两件完全不同的事：</b></p>' +
          '<ul>' +
          '<li><b>第 2 层</b>（maps 里的模块名、线程名）：自己改不掉，要去<b>改对方的观察管道</b>——' +
          'hook <code>open</code>/<code>read</code> 过滤 maps 内容，或在编译期把模块名和线程名换掉。</li>' +
          '<li><b>第 3 层</b>（二进制里的字符串、导出符号）：<b>运行时怎么补都不完整</b>，' +
          '必须自己编译抹掉。</li>' +
          '</ul>' +
          '<p style="margin-bottom:0"><b>元原则：</b>遇到"手段做了但没效果"，' +
          '第一反应应该是<b>换一个关于"它在看哪一层"的假设</b>，而不是把同一个手段做得更彻底。' +
          '第 10 章那张对照表把这条写成了一句话：<b>能改自己就改自己，改不了自己就改对方的观察管道，' +
          '两者都不行就抢时序。</b>三条路对应三个不同的层，而不是同一条路上的三个力度。</p>'
      },
      after: T.note('key', '🔑 这个决策演练的核心',
        '<p style="margin-bottom:0">它训练的不是"先改名字还是先编译"，而是<b>"你的每一刀在问什么问题"</b>。<br>' +
        '改名字问的是"它看进程名吗"；换端口问的是"它看端口吗"；spawn 问的是"检测在注入点之前还是之后"；' +
        'hook dlopen 问的是"墙在哪个 so 的初始化里"。<br>' +
        '<span class="hit">每一次动作都应该是一次测量。没有测量的动作，无论多重，都只是在消耗你的时间。</span></p>')
    },

    /* ============================================================ 21.17 */
    {
      h: '21.17', title: '决策演练二：objection 的 SSL pinning 绕过失效了',
      html:
        '<p>第二个决策演练换一个现场：你已经在用 objection，绕过 <code>sslpinning</code> 的命令执行"成功"了，' +
        '但<b>App 依然报网络错误，抓不到任何业务流量</b>。</p>',
      decision: {
        start: 'm0',
        nodes: {
          m0: {
            scenario: '<b>现象：</b>objection 的 SSL pinning 绕过命令执行成功、没有报错，' +
                      '你配好代理（Charles / mitmproxy），但 App 里所有业务请求都失败，' +
                      '提示网络异常。<b>系统更新、图片这类请求倒是正常。</b>',
            q: '你的第一步判断是什么？',
            choices: [
              { t: '先确认代理本身没配错（证书装到系统区了吗、代理地址对吗），再看是不是有 pinning', next: 'm1' },
              { t: '立刻换 r0capture，因为它不需要证书', next: 'm2' },
              { t: '把 objection 的 sslpinning 命令换成更强力的脚本（多挂几个 TrustManager 类）', next: 'm3' }
            ]
          },
          m1: {
            scenario: '<b>代理确认没问题</b>：同一个代理抓别的 App 一切正常，证书也装在系统信任区了。' +
                      '<b>而目标 App 的"系统更新 / 图片"请求能过，只有业务接口失败。</b>',
            q: '这个"部分请求能过、部分不能"的现象说明什么？',
            choices: [
              { t: '说明是证书校验问题，而且只校验在业务接口那一条链路上——换 r0capture 绕开证书这个维度', next: 'm4' },
              { t: '说明是网络环境问题，业务接口可能有 IP 白名单或地域限制', next: 'm5' },
              { t: '说明 App 检测到了代理，把业务接口的流量改走别的通道了', next: 'm6' }
            ]
          },
          m4: {
            terminal: true, verdict: 'good',
            verdictTitle: '读对了：这是"证书校验只挂在一部分链路上"的典型形态',
            result:
              '<p><b>为什么这是对的：</b>"图片能过、业务接口不能过"是一个非常精确的信号——' +
              '<b>证书校验不是全局生效的，而是只装在业务请求那一条链路上。</b><br>' +
              '这在工程上很常见：App 的业务请求往往有自己的网络栈或自己的 <code>OkHttpClient</code> 配置，' +
              '而图片 / 系统请求走的是另外一条（默认的、没加 pinning 的）链路。</p>' +
              '<p><b>为什么换 r0capture 是对的：</b>它<b>换掉的是"证书"这个维度本身</b>——' +
              '它在进程内直接抄 SSL 读写出口的明文，你的代理证书根本没有参与这次通信。' +
              'pinning 挡的是"不受信任的证书"，而 r0capture 的问题里<b>压根没有证书这一项</b>。</p>' +
              '<p><b>同时要记住它的失效条件（21.4）：</b>如果这条业务链路用的是<b>自研 SSL 实现' +
              '（Flutter / 小程序 / WebView / 私有网络栈）</b>，r0capture 的 hook 点也不会被调用，' +
              '你会得到"命令成功但一条都没抓到"。<br>' +
              '<span class="hit">这时正确的结论是"我要去定位它自己的读写函数"（第 23 章），' +
              '而不是"r0capture 不好用"。</span></p>' +
              '<p><b>认知根源：</b>你没有停在"pinning 绕过失败了"这个层面，' +
              '而是从"部分请求能过"这个细节里<b>读出了 pinning 的作用范围</b>。<br>' +
              '这就是为什么对抗工作里"观察失败的具体形态"比"记录失败这个事实"重要得多——' +
              '<span class="miss">"全部失败"和"只有业务接口失败"是两个完全不同的问题，指向完全不同的下一步。</span></p>'
          },
          m5: {
            terminal: true, verdict: 'bad',
            verdictTitle: '你把"部分失败"归因到了一个无法解释它的原因上',
            result:
              '<p><b>这条路会在什么时候失败：</b>IP 白名单 / 地域限制这个假设<b>解释不了"图片能过"</b>——' +
              '如果业务接口因为 IP 被拒，那么图片请求同样经过你的代理、同样来自你的 IP，它凭什么能过？</p>' +
              '<p><b>你会怎么浪费时间：</b>去换网络环境、换出口 IP、试各种代理模式。' +
              '这些都做完之后，业务接口依然失败——因为它压根不是网络层的问题。</p>' +
              '<p><b>认知根源：</b>你抓住了一个"听起来合理"的解释，但没有检查它<b>能不能解释全部现象</b>。<br>' +
              '<span class="hit">诊断里最有力的一步永远是：<b>我的假设能解释"为什么这部分成功、那部分失败"吗？</b>' +
              '如果解释不了这个差异，这个假设就是错的——不管它本身多合理。</span></p>'
          },
          m6: {
            terminal: true, verdict: 'bad',
            verdictTitle: '这个假设听起来高级，但它要求一个更复杂的前提',
            result:
              '<p><b>这条路会在什么时候失败：</b>"检测到代理就把业务流量改走别的通道"要求 App 具备' +
              '<b>双通道的网络实现</b>（一条走系统、一条自研），这是一个相当大的工程量，' +
              '而它带来的现象应该更"干净"（比如业务接口完全无流量，而不是"请求失败"）。</p>' +
              '<p><b>更重要的是：这个假设让你跳过了更简单的解释。</b>' +
              '按照"先排除最便宜的可能"的原则，证书校验只挂在业务链路上，' +
              '既解释得通现象，又不需要假设 App 有双套网络实现。</p>' +
              '<p><b>认知根源：</b>你用"复杂度"换来了"听起来更专业"的结论。<br>' +
              '<span class="miss">诊断的默认原则是：在能解释同样现象的前提下，选前提更少的那个假设。</span><br>' +
              '<span class="hit">而且这个假设有一个可验证的推论：如果业务流量真的被改道了，' +
              '你在系统的 socket 层应该能看到它（21.12 的 syscall 观测面）。' +
              '能验证的假设才值得花时间——提出一个无法验证的精巧假设，等于什么也没说。</span></p>'
          },
          m2: {
            terminal: true, verdict: 'bad',
            verdictTitle: '方向可能对，但顺序错了——你跳过了"确认代理没问题"这一步',
            result:
              '<p><b>这条路会在什么时候失败：</b>如果问题其实是<b>代理配错了</b>（证书没装进系统信任区、' +
              '代理地址写错、或者你抓的是错误的进程），那么换 r0capture 也解决不了' +
              '——只是把"抓不到"的原因换了一个。</p>' +
              '<p>更麻烦的是：换到 r0capture 之后现象可能<b>看起来一样</b>（还是抓不到），' +
              '于是你无法判断是新工具不适用，还是老问题没解决。</p>' +
              '<p><b>认知根源：</b>你把"换工具"当成了排查手段。但工具替换会<b>同时改变多个变量</b>，' +
              '让你失去判断力。<br>' +
              '<span class="hit">正确的做法是先用最小成本排除最简单的可能（代理配置），' +
              '确认之后再换手段——这样你才能把"换工具之后成功了"正确地归因到"证书不是障碍"上。</span></p>'
          },
          m3: {
            terminal: true, verdict: 'bad',
            verdictTitle: '你在同一个维度上加大力度，但问题可能不在这个维度',
            result:
              '<p><b>这条路会在什么时候失败：</b>当 pinning 实现<b>不经过你挂的那些类</b>的时候。<br>' +
              '常见的绕过脚本挂的是 Java 层的 <code>TrustManager</code> / <code>OkHttpClient</code> 一类接口；' +
              '但如果校验是在 <b>Native 层</b>做的（自己调 <code>SSL_CTX_set_verify</code>），' +
              '或者用了自研 SSL 实现，Java 层挂多少个类都没用。</p>' +
              '<p><b>具体表现：</b>你挂的类从 3 个变成 10 个，App 行为一模一样。' +
              '然后你会开始怀疑这个脚本本身有问题，去找下一个脚本——' +
              '<span class="miss">而每一次都是在同一个维度里加码。</span></p>' +
              '<p><b>认知根源：</b>你把"绕过失败"理解成了"绕过不够强"，' +
              '而它更可能是"绕过打在了错误的层上"。<br>' +
              '<span class="hit">换个维度（从"证书"换到"进程内观测"）比在同一个维度上加大力度有效得多——' +
              '这正是 21.4 那条"不碰证书"的思路的价值所在。</span></p>'
          }
        }
      },
      quiz: {
        id: 'q21-4', chapter: 21, answer: 2,
        stem: 'r0capture 执行成功、没有任何报错，但一条流量都没抓到，' +
              '而这个 App 的业务请求在系统抓包工具里能看到加密后的流量。最可能的原因是什么？',
        options: [
          { t: 'r0capture 的版本和 Frida 版本不匹配，需要换一组搭配',
            why: '版本不匹配通常表现为启动报错或脚本加载失败，而不是"静默地零输出"。先把它当成最后的可能，而不是第一个。' },
          { t: '这个 App 的请求量太小，语句没触发，需要多操作一会儿',
            why: '如果一条都没有，说明不是"量小"的问题；而且系统抓包能看到流量，证明通信确实在发生。' },
          { t: '这个 App 使用了自研的 SSL 实现（比如 Flutter / 小程序 / WebView / 私有网络栈），系统的 SSL_read / SSL_write 根本没有被调用，所以 hook 点从未执行',
            why: '正确。r0capture 的抓包点寄生在系统 SSL 实现上。当 App 自带一份 SSL 实现时，系统的这两个函数不会被调用——钩子装上了却从不执行，表现为"成功但零输出"。这正是项目 README 自述的局限（WebView、小程序、Flutter 暂未支持）。' },
          { t: '需要先用 objection 绕过 pinning，r0capture 才能抓到',
            why: '这是把两件事串错了。r0capture 的设计前提恰恰是"不碰证书"——它根本不需要绕过 pinning。反过来，如果它连钩子都没被触发，那问题也和 pinning 无关。' }
        ],
        explain:
          '<p><b>这道题的关键在于把"零输出"和"流量确实存在"这两个事实放在一起看。</b>' +
          '既然系统层面能看到加密流量，说明通信在正常发生；既然 r0capture 一条都没抓到，' +
          '说明它的钩子<b>从未被执行</b>。</p>' +
          '<p><b>追一层：钩子为什么没被执行？</b>因为 r0capture 挂在系统的 SSL 读写路径上，' +
          '而这条路径<b>只有当 App 使用系统的 SSL 实现时才会被走到</b>。' +
          'App 若自带 SSL 实现（README 明确点名 WebView、小程序、Flutter，"暂未支持"），' +
          '它根本不会调用系统的 <code>SSL_read</code> / <code>SSL_write</code>。</p>' +
          '<p><b>这个推理链本身就是本章要训练的能力：</b>' +
          '遇到"工具没反应"，先问"它的钩子挂在哪个函数上"，再问"这个函数在这条路径上会被调用吗"。' +
          '这两个问题能把绝大部分"工具不好用"的抱怨变成一个明确的技术判断。</p>' +
          '<p style="margin-bottom:0"><b>下一步该做什么：</b>去定位它自己的 socket / SSL 读写点' +
          '（这是第 23 章 socket 与 SSL 溯源的内容），或者回到第 7 章把 so 拖进 unidbg 里单独跑。' +
          '<span class="hit">而不是换一个抓包工具再来一遍。</span></p>'
      },
      after: T.note('key', '🔑 这个决策演练的核心',
        '<p style="margin-bottom:0">"绕过失败"和"绕过打错了层"是完全不同的问题，而它们的现象很像是——' +
        '都是抓不到。<br>' +
        '区分它们的唯一办法是<b>看失败的具体形态</b>：' +
        '"图片能过业务不能过"说明校验是局部的；' +
        '"钩子成功但零输出且系统能看到流量"说明钩子挂在了一条不会被走到的路径上。<br>' +
        '<span class="hit">先读形态，再选手段。</span></p>')
    },

    /* ============================================================ 21.18 */
    {
      h: '21.18', title: '决策演练三：自己编译 Frida，还是换内核路线',
      html:
        '<p>第三个决策演练是一次真正的路线取舍。' +
        '<b>两条路的收益和代价都不在同一张表上</b>，所以它比前两个更难。</p>',
      decision: {
        start: 'k0',
        nodes: {
          k0: {
            scenario: '<b>背景：</b>你确认了目标的检测点在第 3 层——它会在内存里扫描特征字符串，' +
                      '并且遍历已加载模块的导出符号表。<b>改名、换端口、hook 字符串比较函数都试过了，都无效。</b><br>' +
                      '<b>你的条件：</b>有一台已解锁的测试设备（你拥有它）；每周大概能投入一天；' +
                      '任务需要持续跟进这个目标<b>至少几个月</b>；你熟悉 C/C++，但没写过内核模块。',
            q: '你选哪条路？',
            choices: [
              { t: '自己编译一份去特征的 Frida，把字符串和符号抹掉', next: 'k1' },
              { t: '走第 13 章的内核路线，用内核模块隐藏 Frida 的痕迹', next: 'k2' },
              { t: '先花半天确认"它扫的到底是哪些字符串、哪些符号"，再决定用哪条路', next: 'k3' }
            ]
          },
          k1: {
            scenario: '<b>你选了编译。</b>花了两天把环境搭起来、补丁打上、编译出 arm64 版本，' +
                      '验证了几个关键字符串确实没了，App 这次<b>确实跑起来了</b>。' +
                      '但一个月后你为了支持一个新系统版本升级了 Frida，<b>补丁全部失效，编译不过了</b>。',
            q: '这件事说明了什么？',
            choices: [
              { t: '补丁要跟随上游维护，这是编译路线的持续成本——需要把它当成一个要长期投入的项目，而不是一次性任务', next: 'k4' },
              { t: '说明编译路线不可靠，应该立刻转内核路线', next: 'k5' },
              { t: '换一个更活跃的去特征分支就行了，问题在于分支选得不好', next: 'k6' }
            ]
          },
          k4: {
            terminal: true, verdict: 'good',
            verdictTitle: '你算对了这笔账：编译路线买的是"覆盖面"，付的是"持续维护"',
            result:
              '<p><b>为什么这是对的：</b>编译覆盖的是第 3 层——它能一次性抹掉<b>模块名、内存特征字符串、' +
              '导出符号、线程名</b>四类暴露点（21.14 的实验里，它是"不能被替代项"排第一的那个），' +
              '这是任何运行时手段都做不到的。</p>' +
              '<p><b>但它的代价结构是"持续"的</b>：补丁跟着上游源码的上下文走，' +
              '上游一改，补丁就要重新适配。这在社区项目里是一个被反复验证过的现实——' +
              '我查证到的 <code>strongR-frida-android</code> 项目，README 顶部就写着作者已长时间没维护、' +
              '并指向另一个项目。<span class="pill warn">这些项目的活跃状态随时间变化，评测具体项目前请自行核实，待核实</span></p>' +
              '<p><b>所以正确的做法是把"维护补丁"排进你的时间预算</b>：' +
              '如果你的任务要持续几个月，那么"每次升级 Frida 要花半天重新适配补丁"就是必须计入的成本。' +
              '<span class="hit">这不是编译路线的缺陷，是它的定价方式。任何只谈收益不谈维护成本的方案评估都是假的。</span></p>' +
              '<p><b>认知根源：</b>你没有把"补丁失效"当成一个不幸的意外，' +
              '而是把它认成了<b>这条路线的固有成本</b>。' +
              '能提前认出成本结构，比事后补救有价值得多。</p>'
          },
          k5: {
            terminal: true, verdict: 'bad',
            verdictTitle: '你把"有成本"读成了"不可靠"',
            result:
              '<p><b>这条路会在什么时候失败：</b>内核路线<b>同样有维护成本，而且更大</b>——' +
              '内核模块要适配内核版本（每个厂商的内核都可能不一样），' +
              '要处理内核 API 的变化，出问题会导致<b>整机崩溃或无法开机</b>。</p>' +
              '<p>更关键的是：<b>两条路覆盖的不是同一批暴露点。</b>' +
              '内核路线擅长的是隐藏"行为痕迹"（ptrace、内存区间关系），' +
              '而它<b>并不天然解决"二进制里有特征字符串"这个问题</b>——' +
              '字符串还在你的 agent so 里，内核能让检测者看不到那个模块，但若是对方扫的是内存内容，' +
              '你还是需要把字符串本身抹掉。</p>' +
              '<p><b>认知根源：</b>你用"有没有成本"来评判路线，而正确的判据是' +
              '<b>"它覆盖哪些暴露点，以及代价是哪种类型"</b>。<br>' +
              '<span class="miss">"这条路也有问题"永远成立，"这条路解决的是哪个问题"才是决策依据。</span></p>'
          },
          k6: {
            terminal: true, verdict: 'bad',
            verdictTitle: '把系统性问题归因到"选错了项目"',
            result:
              '<p><b>这条路会在什么时候失败：</b>换一个分支，你会经历同一个循环——' +
              '一开始能编译、能用；过上几个月（或一次 Frida 大版本升级之后）补丁再次失效。<br>' +
              '因为这是<b>这条技术路线的结构问题</b>：你的改动是"对上游源码打的补丁"，' +
              '而上游源码在动。<b>换分支换不掉这个结构。</b></p>' +
              '<p><b>认知根源：</b>你把"结构性的持续成本"当成了"某个项目的质量问题"。<br>' +
              '<span class="hit">区分这两者很重要：如果是项目质量问题，换项目是对的；' +
              '如果是结构问题，换项目只是把同一个账单换了一个收款人。</span></p>'
          },
          k2: {
            scenario: '<b>你选了内核路线。</b>花了三周写出一个能加载的模块，' +
                      '在本机上确实把 Frida 相关的痕迹藏住了。' +
                      '然后你换了一台<b>内核版本不同的设备</b>，模块加载失败；' +
                      '再换一台，加载成功但系统行为异常。',
            q: '最该从这件事里得出的结论是什么？',
            choices: [
              { t: '内核路线的成本集中在"适配"，所以它的适用场景是"少数几台固定设备上的长期目标"，而不是广泛兼容', next: 'k7' },
              { t: '内核路线门槛太高，不适合作为常规手段，应该退回用户态方案', next: 'k8' }
            ]
          },
          k7: {
            terminal: true, verdict: 'good',
            verdictTitle: '你认出了内核路线的产品形态：少数设备的深度定制',
            result:
              '<p><b>为什么这是对的：</b>内核模块与内核版本强耦合——' +
              '内核 API、结构体布局、符号导出都可能不同。<b>这决定了它不是"一个工具"，而是"一套针对特定环境的定制"。</b></p>' +
              '<p><b>这也正好呼应 21.10 的 ROM 路线结论：</b>' +
              '"长期、固定目标的深挖"才值得付这个成本；' +
              '"还在探索，不知道要盯多久"的时候，上线重装备等于把探索成本一次性抬高。</p>' +
              '<p><b>所以本例中真正的答案是：</b>你前面说的是"任务需要持续跟进几个月"，' +
              '而且你拥有设备——<b>这两个条件恰好支持内核路线</b>。' +
              '但你必须接受"它只能在你的那几台设备上跑"，并且<b>把每台新设备的适配时间算进预算</b>。</p>' +
              '<p><b>认知根源：</b>你没有用"门槛高 / 门槛低"来评价技术，' +
              '而是用<b>"它的成本花在哪里、因此适合什么场景"</b>来评价。<br>' +
              '<span class="hit">门槛高从来不是缺点——缺点是在错误的场景里用了对的工具。</span></p>'
          },
          k8: {
            terminal: true, verdict: 'bad',
            verdictTitle: '你把"适配成本高"读成了"不该用"',
            result:
              '<p><b>这条路会在什么时候失败：</b>回到用户态之后，你会撞上一开始那面墙——' +
              '<b>目标扫的是内存字符串和导出符号，而你确认过用户态的所有手段都无效。</b><br>' +
              '退回用户态不是"稳妥的选择"，而是<b>退回一个已知无解的位置</b>。</p>' +
              '<p><b>认知根源：</b>你用"实施难度"当成了唯一的决策维度。<br>' +
              '但决策有两端：<b>一是这条路能不能解决我的问题，二是我付不付得起它的代价。</b>' +
              '你只看了第二端。<br>' +
              '<span class="miss">当一个问题在低层无解时，"难度高"就不再是排除理由——它是唯一的选项。</span><br>' +
              '<span class="hit">这时候要做的不是退缩，而是<b>缩小题目的范围</b>：' +
              '把"支持所有设备"改成"只支持我手上这三台"，难度立刻就回到可控区间。</span></p>'
          },
          k3: {
            terminal: true, verdict: 'good',
            verdictTitle: '先测量，再选路线——这一步无论后面怎么走都不会白花',
            result:
              '<p><b>为什么这是对的：</b>你已经知道"它扫字符串、遍历导出符号"，' +
              '但你还不知道<b>它扫的是哪些具体的字符串、哪些具体的符号</b>。' +
              '而这个清单直接决定你该付哪种成本：</p>' +
              '<p>• 如果它扫的字符串**数量很少且集中**（比如只看 <code>frida_agent_main</code> 和 <code>gum-js-loop</code>），' +
              '那<b>编译 + 只改这几处</b>就够了，成本比内核路线低一个数量级；<br>' +
              '• 如果它扫的是**一堆通用特征**（JS 引擎结构、pthread 行为、内存布局），' +
              '那"抹字符串"这条路根本走不通（改不完），<b>内核路线才是对的</b>。</p>' +
              '<p><b>怎么测量：</b>hook 掉它的字符串比较 / 符号遍历函数，把<b>它请求的每一个关键词</b>打出来。' +
              '这就是第 10 章"从副作用反推检测逻辑"的具体用法——' +
              '<b>不需要读懂检测逻辑，只需要看它问了什么。</b></p>' +
              '<p><b>认知根源：</b>你在两条都"看起来可行"的路之间，选择了<b>先把信息补全</b>而不是先投入。<br>' +
              '<span class="hit">半天的测量，可能省掉两天的编译或三周的内核开发——' +
              '这是本章反复出现的那条原则：每一步动作都应该是一次测量，没有测量的投入是在赌。</span></p>'
          }
        }
      },
      after: T.note('key', '🔑 这个决策演练的核心',
        '<p style="margin-bottom:0">编译路线买的是<b>覆盖面</b>（一次性抹掉四类二进制特征），付的是<b>持续维护</b>；<br>' +
        '内核路线买的是<b>行为痕迹的隐藏</b>，付的是<b>适配成本与环境耦合</b>。<br>' +
        '两者<b>覆盖的暴露点并不相同</b>——所以"哪个更好"这个问题是问错了的，' +
        '该问的是"<b>我的目标在哪一层、我这几个月打算投多少时间</b>"。<br>' +
        '<span class="hit">而在两者之间做选择之前，有一个几乎总是值得先做、且几乎总是被跳过的动作：' +
        '先把"它到底在看什么"测出来。</span></p>')
    },

    /* ============================================================ 21.19 */
    {
      h: '21.19', title: '对抗的极限：从"改名字"到"改行为特征"，以及墙在哪里',
      html:
        '<p>最后一节，把整章收成一张地图。</p>',
      deck: {
        title: 'Frida 特征对抗的四级台阶',
        slides: [
          {
            kicker: '第 1 级', title: '改名字',
            body:
              '<p><b>做什么：</b>改文件名、改安装目录、改监听端口、改进程名。</p>' +
              '<p><b>覆盖：</b>第 1 层暴露面（进程名、端口、路径）。</p>' +
              '<p><b>成本：</b>几乎为零，五分钟。</p>' +
              '<p><b>局限：</b>只能挡住"按名字找"的检测。对 maps、二进制内容、线程名完全无效。</p>',
            foot: '这是起点，不是方案。做完这一步之后，你几乎一定会被更深一层的检测拦住。'
          },
          {
            kicker: '第 2 级', title: '改观察管道（篡改对方看到的）',
            body:
              '<p><b>做什么：</b>hook <code>open</code> / <code>read</code> 过滤 <code>/proc/self/maps</code>；' +
              'hook <code>strstr</code> / <code>memmem</code> 过滤字符串比较；hook <code>dlopen</code> 前移介入点。</p>' +
              '<p><b>覆盖：</b>第 2 层（映射、线程名）以及部分第 3 层（字符串比较类检测）。</p>' +
              '<p><b>成本：</b>中等。要处理分块读、多条读取路径、重入。</p>' +
              '<p><b>局限：</b><b>它改变的是"对方读到什么"，不是"我是什么"。</b>' +
              '如果对方直接扫内存字节、或遍历导出符号表，这条路就断了。</p>',
            foot: '第 10 章那句"能改自己就改自己，改不了自己就改对方的观察管道"讲的就是这一级。'
          },
          {
            kicker: '第 3 级', title: '改编译产物（从二进制里抹掉）',
            body:
              '<p><b>做什么：</b>自己编译 Frida，把模块名、特征字符串、导出符号、内部线程名换掉。</p>' +
              '<p><b>覆盖：</b>第 3 层（内存特征、导出符号）以及第 2 层的一部分（模块名、线程名）。</p>' +
              '<p><b>成本：</b>高，而且是<b>持续成本</b>——补丁要跟随上游维护，Frida 一升级就要重新适配。</p>' +
              '<p><b>局限：</b>它抹掉的是"名字和字符串"，<b>抹不掉"行为"</b>——' +
              '你依然会产生 RWX 内存、依然有 JS 运行时的结构、依然有注入痕迹。</p>',
            foot: '这是用户态能做的最后一件事。做完它，第 4 层的三样东西依然在。'
          },
          {
            kicker: '第 4 级', title: '改行为特征——用户态的墙',
            body:
              '<p><b>剩下的是什么：</b><br>' +
              '<b>①</b> 运行时代码修改留下的 <b>RWX 内存段</b>；<br>' +
              '<b>②</b> <b>JS 引擎（V8 / JSC）</b>在堆上留下的结构特征；<br>' +
              '<b>③</b> 注入方式本身的痕迹（<b>TracerPid</b>、调试寄存器）。</p>' +
              '<p><b>为什么用户态改不掉它们：</b>因为它们不是"名字"，也不是"字符串"——' +
              '它们是<b>行为的必然副作用</b>。你要 hook 就必须改代码段，改了就会有 RWX；' +
              '你要跑 JS 就必须有 JS 引擎，有引擎就有它的堆结构；' +
              '你要注入就必须有一个进入进程的方式，而这个方式会留下痕迹。</p>',
            foot: '到这一层，"隐藏自己"这条路的边际收益已经很低了——因为你要隐藏的不再是身份，而是存在。'
          },
          {
            kicker: '墙', title: '所以第 13 章要下沉到内核',
            body:
              '<p><b>用户态的根本困境：</b>你的一切痕迹都产生在<b>目标进程内部</b>，' +
              '而检测代码也在同一个进程内部。<b>你和它共享同一个观测视角，所以你能做的事有上限。</b></p>' +
              '<p><b>内核路线换掉的是视角：</b>内核模块不改变"进程里有什么"，' +
              '它改变的是<b>"内核向这个进程报告什么"</b>——' +
              '读 maps 时返回过滤后的内容、读线程名时返回伪造的名字、' +
              '甚至让某些内存区间在对方看来不存在。</p>' +
              '<p><b>这就是"下沉层级"的通用价值：不是让自己更隐蔽，而是让自己站在观测者的位置上。</b></p>',
            foot: '第 13 章的 wxshadow 式内核 Hook、0r0env 调试 ROM，都是这条思路的具体兑现。'
          },
          {
            kicker: '更下面', title: '以及为什么第 6 章要下沉到 Hypervisor',
            body:
              '<p><b>内核也不是终点。</b>如果对手的检测能力也下沉到内核（甚至自己就是一个内核模块），' +
              '那么"内核里的对抗"就变成了同层对抗——你能改的它也能看。</p>' +
              '<p><b>Hypervisor 提供的是内核之下的观测层：</b>它对被观测的系统来说是"硬件"，' +
              '因此它能看到内核的每一次内存访问、每一次特权指令，' +
              '而内核<b>无法观测到 Hypervisor 的存在</b>（在理想的实现下）。</p>' +
              '<p><b>于是整门课的层次结构就清楚了：</b><br>' +
              'Java 层（第 1 章）→ Native 符号层（第 3 章）→ <b>syscall 层（第 11、13 章）</b> → ' +
              '内核层（第 13 章）→ Hypervisor 层（第 6 章）。</p>',
            foot: '每往下一层，你能看到的越多、被绕过的可能越小——但门槛和代价也越高。没有免费的层。'
          },
          {
            kicker: '收束', title: '对抗的极限在哪里',
            body:
              '<p><b>三条结论：</b></p>' +
              '<p><b>① 用户态的对抗有硬上限。</b>' +
              '第 4 层的三样痕迹（RWX、JS 引擎结构、注入痕迹）在用户态无法消除，' +
              '只能被"部分掩盖"或"抢在检测之前完成动作"。</p>' +
              '<p><b>② 攻防是不对称的，而且方向对你不利。</b>' +
              '检测方找到一个口子就够了；你必须堵住所有口子。' +
              '所以<b>不要追求"完美的隐身"——那不存在</b>。</p>' +
              '<p><b>③ 正确的目标是"在对手检查的那一刻，我已经完成了我要做的事"。</b>' +
              '这就是 spawn 抢先、hook dlopen 前移介入点、以及"少开 Stalker"这些手段的共同逻辑：' +
              '<b>它们不消除特征，它们把问题从"如何不被发现"转化成了"如何抢在发现之前"。</b></p>',
            foot: '把这句话带走：能改自己就改自己，改不了自己就改对方的观察管道，两者都不行就抢时序，再不行就下沉一层。'
          }
        ]
      },
      after:
        T.note('key', '🔑 一张必须记住的四步决策顺序',
          '<p style="margin-bottom:0"><b>① 改自己</b>（文件名 / 端口 / 路径——成本最低，先做完）<br>' +
          '<b>② 改对方的观察管道</b>（maps 过滤 / 字符串过滤——覆盖面比第 1 步大，成本中等）<br>' +
          '<b>③ 抢时序</b>（spawn / hook dlopen——不消除特征，但让检测来不及生效）<br>' +
          '<b>④ 改变自己产生的字节</b>（自己编译——成本最高，但覆盖第 3 层）<br>' +
          '如果这四步都做完还被拦住，说明对手看的是<b>第 4 层的行为特征</b>——' +
          '<span class="miss">这时候继续在用户态加码是低效的，该换层级了：内核（第 13 章），或 Hypervisor（第 6 章）。</span></p>') +
        T.card('最后一个提醒：本章与第 10、13 章的分工',
          '<p>三章都在讲"怎么让 Frida 活下来"，但它们的着力点不同，别混着用：</p>' +
          T.tbl(['章', '它回答的问题', '它的输出'],
            [
              ['<b>第 10 章</b>', '检测点和对抗手段<b>怎么配对</b>？',
               '一张对照表 + "攻防不对称"这条元原则。它给的是<b>地图</b>'],
              ['<b>第 21 章（本章）</b>', '把 Frida 用成<b>流水线</b>要哪些工具？' +
               '自己编译时<b>到底抹掉哪些字节</b>？还剩几处暴露？',
               'objection / r0capture / r0tracer 的定位与边界 + <b>一套可算的暴露面审计流程</b>。它给的是<b>工程能力与度量</b>'],
              ['<b>第 13 章</b>', '用户态做不到的部分，<b>内核怎么补</b>？',
               'SVC 定位、硬件断点、内存动态释放、0r0env。它给的是<b>下一层</b>']
            ]) +
          '<p style="margin-bottom:0"><b>合起来是一条完整的路线：</b>' +
          '先用第 10 章的地图判断"谁在看什么"，' +
          '再用本章的工具把流水线搭起来、用审计器把暴露面算清楚、把用户态能做的做干净，' +
          '最后当剩下的暴露点确实无法在用户态消除时，用第 13 章下沉到内核。<br>' +
          '<span class="hit">不要跳步——先确认暴露点在哪一层，再选覆盖面匹配的手段，这是本章唯一的元原则。</span></p>')
    },

    /* ============================================================ 21.20 */
    {
      h: '21.20', title: '实战案例：r0capture 的自述能力与自述局限',
      html:
        '<p>本章要找的是一个<b>真实可访问</b>的公开项目案例。看雪（bbs.kanxue.com）的帖子在未登录状态下' +
        '会被拦在安全验证页——我用 <code>web_fetch</code> 取到的只有验证提示，' +
        '<b>拿不到正文，因此无法核实原帖的标题、作者与日期</b>，不能收录。' +
        '（搜索关键词记在交付报告里。）</p>' +
        '<p>于是改用 GitHub 上的项目仓库：<b>它的 README 本身就是一份作者亲笔写的能力清单与局限清单</b>，' +
        '而且我确认过可以完整取到内容。这比一篇转述帖更硬——' +
        '<b>你看到的是作者自己划的边界。</b></p>',
      case: {
        source: 'github',
        title: 'r0capture —— 安卓应用层抓包通杀脚本',
        author: 'r0ysue（仓库作者）',
        target: 'r0ysue/r0capture：安卓应用层抓包脚本（README 自述测试 Android 7–16 可用）',
        background:
          '<p>这是一个在安卓逆向圈流传很广的抓包脚本。它的定位一句话能说完：' +
          '<b>不处理证书，直接在应用层把明文抄下来。</b></p>' +
          '<p>我引用的全部内容都来自<b>仓库 README 本身</b>（<code>raw.githubusercontent.com</code> 上取到的原文）。' +
          '这也符合本章的态度：<b>要评估一个工具，先读它自己承认的边界，而不是先读别人的推荐。</b></p>',
        points: [
          'README 自述<b>"无视所有证书校验或绑定，不用考虑任何证书的事情"</b>——这正是 21.4 讲的"不碰证书"路线。',
          '自述通杀 TCP/IP 四层模型中的<b>应用层全部协议</b>，包括 Http、WebSocket、Ftp、Xmpp、Imap、Smtp、Protobuf 以及它们的 SSL 版本。',
          '自述通杀应用层框架：<b>HttpUrlConnection、Okhttp 1/3/4、Retrofit、Volley</b> 等。',
          '自述<b>"无视加固，不管是整体壳还是二代壳或 VMP"</b>——因为它 hook 的是系统层 SSL 实现，不进入业务代码。',
          '提供了<b>收发包函数定位</b>功能（Spawn 与 Attach 模式均默认开启），可以重定向输出后过滤。',
          '提供了<b>客户端证书导出</b>功能（默认开启、必须 Spawn 模式运行），导出到 <code>/sdcard/Download/包名xxx.p12</code>，README 说明默认密码为 <code>r0ysue</code>。',
          '提供了 <code>-H</code> 参数，用于 <b>frida-server 监听在非标准端口</b>时连接——README 明确写出理由：<b>"有些 App 会检测 Frida 标准端口"</b>。',
          'README 记录了若干次版本更新与"推荐搭配"（如 frida17 配安卓 16 等）——说明它的可用性<b>强烈依赖 Frida 与安卓版本的组合</b>。'
        ],
        method: [
          '把抓包点放在<b>系统 SSL 读写路径</b>上（而不是做中间人代理），因此绕过了"证书是否受信任"这整个问题域。',
          '用 hook 到的读写参数还原套接字五元组，把明文按流重组，落成 pcap —— 便于后续用 Wireshark 分析。',
          '额外把"是哪个函数在发包"也一起记下来（收发包函数定位），把"流量"和"代码位置"对上。',
          '把"Frida 端口可能被检测"这个现实问题写进参数里（<code>-H</code>），而不是假设默认端口一定能用。',
          '用 README 的"更新记录 + 推荐搭配"来管理版本兼容性，而不是声称"任何版本都能用"。'
        ],
        result:
          '<p>README 自述的能力覆盖到一个相当宽的范围：多个安卓大版本、应用层全部协议、' +
          '主流 Java 网络框架、以及加固应用（整体壳 / 二代壳 / VMP）。' +
          '同时 README 也自述在 Pixel4 / 安卓13 / KernelSU / Frida16 环境下测试工作正常。</p>',
        terms: ['Frida', 'SSL pinning', 'SSL_read / SSL_write', '应用层抓包', 'socket 五元组',
                'pcap', '客户端证书', '加固壳', 'Child-gating', '多进程'],
        limits:
          '<p>这一节我直接照录 README 里作者自述的局限——<b>它的价值比"能做什么"那一段更高</b>：</p>' +
          '<p>① <b>自研 SSL 框架不支持</b>：README 点名 <b>WebView、小程序、Flutter</b>，"这部分目前暂未支持"；' +
          '并说明"部分融合 App 本质上已经不属于安卓 App，没有使用安卓系统的框架，无法支持"，且承认"这部分 App 也是少数"。</p>' +
          '<p>② <b>不支持 HTTP/2、HTTP/3</b>：README 的理由是这部分 API"在安卓系统上暂未普及或部署，为 App 自带，无法进行通用 hook"。</p>' +
          '<p>③ <b>模拟器不被推荐</b>：README 的措辞是"各种模拟器架构、实现、环境较为复杂，建议珍爱生命、使用真机"；' +
          '并在用法一节写了"禁止使用模拟器"。</p>' +
          '<p>④ <b>多进程未支持</b>：README 说"暂未添加多进程支持，比如 <code>:service</code> 或 <code>:push</code> 等子进程"，' +
          '并指出可以用 Frida 的 <b>Child-gating</b> 自行支持；同时提醒支持多进程后<b>要考虑 pcap 文件的写入锁问题</b>。</p>' +
          '<p>⑤ <b>平台限制</b>：README 写明"仅限安卓平台"。</p>' +
          '<p>⑥ <b>版本搭配依赖</b>：README 里多次出现的"推荐搭配"本身就是一个信号——' +
          '这个工具不是版本无关的，换 Frida 或换安卓版本都可能需要重新适配。</p>' +
          '<p><span class="pill warn">本案例引用的所有自述内容均来自仓库 README；这些描述会随项目更新而改变，' +
          '请以你查看时的 README 为准，待核实</span></p>',
        analysis:
          '<p><b>用本章的方法论拆解：这个 README 本身就是一个"暴露面台账"的范例。</b>' +
          '它做了一件很聪明的事——<b>把"能做什么"和"不能做什么"分开写，而且都写得很具体。</b></p>' +
          '<p><b>第一层印证：21.4 的"hook 点决定能力边界"这条推理，在这里被完整验证。</b><br>' +
          'r0capture 的抓包点是<b>系统 SSL 读写路径</b>。这个选择决定了它能无视证书（因为它不参与证书验证），' +
          '也决定了它抓不到自研 SSL 实现（因为那些实现不走系统的 SSL 函数）。' +
          '<span class="hit">README 里"WebView / 小程序 / Flutter 暂未支持"和"HTTP/2、HTTP/3 无法通用 hook"，' +
          '根本原因是同一句话：那些实现不经过我的钩子。</span>' +
          '这正是本章反复训练的那种推理——<b>不要问"这个工具强不强"，要问"它的钩子挂在哪个函数上、这个函数什么时候会被调用"。</b></p>' +
          '<p><b>第二层印证：21.3 那条判断在这里得到了一次现实注脚。</b><br>' +
          'README 专门加了 <code>-H</code> 参数，理由写得很直白：<b>"有些 App 会检测 Frida 标准端口"</b>。<br>' +
          '这句话等于作者亲口确认了本章的一个核心判断：' +
          '<b>r0capture 绕过了证书这一整个问题域，但绕不过"我是 Frida"这件事。</b>' +
          '它在抓包能力上很强（不碰证书），但在<b>存在性</b>上完全暴露（就是 Frida）。' +
          '<span class="miss">一把工具在某个维度上的优势，不会自动延伸到别的维度。</span>' +
          '<b>所以"用 r0capture 就安全了"是一个错误的推论</b>——它只解决证书，不解决特征。</p>' +
          '<p><b>第三层印证：它的局限清单，正好是 21.8 那张"抓不到包时先分清哪一类失败"的判断表的实战版。</b><br>' +
          '把 README 的局限对进那张表：<br>' +
          '• "WebView / 小程序 / Flutter 不支持" → 对应<b>第二类</b>（业务接口走自研 SSL，抓不到）；<br>' +
          '• "HTTP/2、HTTP/3 不支持" → 也属于第二类，而且 README 给的原因（App 自带、无法通用 hook）' +
          '和本章的推理完全一致；<br>' +
          '• "多进程未支持" → 这是一个<b>额外的一类</b>：不是 hook 点错了，而是<b>你根本没在那个进程里</b>。' +
          '<span class="hit">这一类值得单独记：多进程 App 上，"抓不到"的原因可能简单到"我在错误的进程里跑脚本"。</span></p>' +
          '<p><b>最后一条方法论：怎么读一个项目的 README。</b><br>' +
          '大多数人读 README 只看"功能列表"和"安装步骤"。' +
          '但这个案例说明，<b>最有价值的一段是"局限"那一段</b>——' +
          '因为功能列表会告诉你"作者想解决什么"，而局限列表会告诉你' +
          '<b>"作者知道自己的方法在什么条件下不成立"</b>。<br>' +
          '一个作者愿意写清后者，说明他知道自己的方法边界在哪；' +
          '<span class="hit">而一个只写功能不写局限的工具，你只能用自己的时间去发现它的边界。</span></p>',
        link: 'https://github.com/r0ysue/r0capture',
        linkNote: '仓库 README（本章引用的全部自述内容来自此 README；另经 raw.githubusercontent.com 取其原文核对）'
      }
    },

    /* ============================================================ 21.21 */
    {
      h: '21.21', title: '本章自测',
      html: '<p>五道题，覆盖本章最容易搞反的五处判断。</p>',
      quiz: {
        id: 'q21-5', chapter: 21, answer: 3,
        stem: '关于"objection 的特征暴露面"，下边的说法哪个是对的？',
        options: [
          { t: 'objection 是 Frida 之上的封装，比直接用 Frida 脚本更隐蔽，因为它不往目标进程写自定义脚本',
            why: '反了。objection 最终仍然要通过 Frida 注入 agent、仍然会产生 Frida 的全部运行时痕迹。"不写自定义脚本"降低的是你的工作量，不是进程里的特征。' },
          { t: 'objection 的暴露面比 Frida 小，因为它只 hook 必要的几个点',
            why: '它 hook 什么、hook 多少，跟"Frida 本身在不在这个进程里"是两件事。检测方识别的是 Frida 的存在（maps、线程、字符串、端口），不是你的脚本内容。' },
          { t: 'objection 的特征面取决于你用它跑了多少命令，跑得少就暴露得少',
            why: '命令数量影响的是"你的脚本行为留下了多少额外痕迹"，而 Frida 自身的基础特征（模块映射、内部线程名、端口）在你 attach 成功的那一刻就已经存在了。' },
          { t: 'objection 底层就是 Frida，所以它的特征暴露面就是 Frida 的暴露面——被检测到时换工具不解决问题',
            why: '正确。这就是 21.3 的核心判断：objection 是把 Frida 脚本包了一层命令行，被检测的不是脚本而是 Frida。所以"被检测到就换个工具"是一条走不通的路，真正的解法是去特征（21.10–21.14）或换层级（第 13 章）。' }
        ],
        explain:
          '<p><b>这道题只需要一条认知：objection 是 Frida 的封装，不是 Frida 的替代品。</b></p>' +
          '<p>它的价值在于<b>省掉你的重复劳动</b>（枚举、搜索、批量打印、常见绕过），' +
          '而不在于它更隐蔽。相反——</p>' +
          '<p><b>它还有一个额外的代价：</b>它比手写脚本<b>更重</b>。' +
          'objection 会加载它自己的 agent、执行它自己的枚举逻辑，' +
          '这些行为本身也会产生可观测的副作用（额外的模块、额外的线程、额外的耗时）。</p>' +
          '<p style="margin-bottom:0"><b>所以正确的用法是：</b>用 objection <b>探路和验证</b>' +
          '（快速确认类名、方法签名、哪个重载被调用），' +
          '一旦确定要 hook 什么，就<b>换成精简的手写脚本</b>，只留必要的钩子。<br>' +
          '<span class="hit">这是"先重工具探路，再轻脚本落地"的顺序——它同时降低了你的工作量和进程里的噪音。</span></p>'
      }
    },

    /* ============================================================ 21.22 */
    {
      h: '21.22', title: '本章自测（二）',
      quiz: {
        id: 'q21-6', chapter: 21, answer: 2,
        stem: '你为了做去特征，自己编译了一份 Frida，把特征字符串和导出符号都换掉了。' +
              '有人说"这样就不是 Frida 了，检测不到了"。这个说法哪里有问题？',
        options: [
          { t: '没有问题，改名换符号之后从外部看确实无法区分',
            why: '把"名字层面不可识别"当成了"整体不可识别"。检测方还有别的层次可看——映射内容、内存权限、运行时线程行为、注入痕迹。' },
          { t: '它只覆盖了"名字与字符串"这一层，而第 4 层的行为特征（RWX 内存段、JS 引擎的运行时结构、注入留下的 ptrace 痕迹）依然存在',
            why: '正确。自己编译能抹掉模块名、特征字符串、导出符号、线程名（第 2、3 层的一大块），但抹不掉"你改过代码段"（RWX）、"你有一个 JS 引擎在跑"（V8/JSC 结构）、"你注入过这个进程"（TracerPid）这三样行为特征。' },
          { t: '问题在于自己编译的版本不稳定，容易崩溃，所以实际不可用',
            why: '稳定性是一个工程问题，不是这个说法的逻辑漏洞。而且这是两件事：能不能编译出稳定版本，和"改了名字是否就等于隐身"无关。' },
          { t: '问题在于改编译之后 Frida 就无法工作了，因为 Frida 内部会校验自己的名字',
            why: 'Frida 不依赖这些字符串来工作（否则社区的去特征项目不会存在）。改字符串与符号是可行的改动，问题在于它能覆盖的范围。' }
        ],
        explain:
          '<p><b>这道题考的是"不要被一层上的成功说服"。</b></p>' +
          '<p>自己编译确实是很强的一招——21.14 的实验算过，它是唯一能一次性抹掉<b>模块名、内存特征字符串、' +
          '导出符号、线程名</b>四类暴露点的手段。做了它，你已经比绝大多数人干净得多。</p>' +
          '<p><b>但"干净得多"不等于"不可识别"。</b>剩下的三样是行为的副作用：</p>' +
          '<ul>' +
          '<li><b>RWX 内存段</b>：你要 hook 就必须改写代码段，改写了就会出现可写可执行的内存区间。' +
          '这在 maps 里是可见的，而且它不带任何名字——<b>你没法给它改名</b>。</li>' +
          '<li><b>JS 引擎结构</b>：Frida 要跑你的脚本，就必然有一个 JS 运行时在堆上留下结构。' +
          '这是"按结构识别"，不是"按字符串识别"，所以改字符串对它无效。</li>' +
          '<li><b>注入痕迹</b>：你进入这个进程的方式会留下痕迹（用 ptrace 注入就有 TracerPid）。' +
          '这是"你做过什么"，不是"你叫什么"。</li>' +
          '</ul>' +
          '<p style="margin-bottom:0"><b>元原则：</b>对抗检测的每一步都要问自己' +
          '"<b>我这一刀覆盖的是哪一层？下一层还剩什么？</b>"<br>' +
          '被"这一层解决了"说服，是最常见的停滞方式——' +
          '<span class="miss">而真正的下一步往往就在下一层里等着你。</span></p>'
      }
    },

    /* ============================================================ 21.23 */
    {
      h: '21.23', title: '本章自测（三）',
      quiz: {
        id: 'q21-7', chapter: 21, answer: 1,
        stem: '主动调用一个加密方法时，你构造好参数、调用成功、拿到了返回值，' +
              '但打印出来的十六进制串和预期对不上，而且偶尔出现负数。最可能的原因是什么？',
        options: [
          { t: '方法的参数类型猜错了，导致它内部走了另一条分支',
            why: '参数类型错了通常会直接报类型不匹配或抛异常，而不是"调用成功但结果数值异常"。而且这一条解释不了"偶尔出现负数"这个具体现象。' },
          { t: '返回值是 Java 的 byte[]，而 byte 是有符号的——你没有做 <code>&amp; 0xff</code> 转换就直接拼十六进制',
            why: '正确。这是主动调用中最常见的"读值 bug 伪装成算法 bug"。Java 的 byte 范围是 -128~127，读到 0x80 以上的字节会显示为负数，直接 toString(16) 会得到带负号的字符串，长度也不对。' },
          { t: '方法内部使用了随机数或时间戳，所以每次结果不同',
            why: '随机性会导致"每次结果不同"，但不会导致同一个字节显示成负数。而且这里是"和预期对不上 + 偶尔负数"，负数是一个明确的技术症状。' },
          { t: 'Frida 的版本太旧，二进制数据在跨语言传递时被截断了',
            why: '这是把技术症状归因到工具版本。版本问题会表现为报错或崩溃，不会表现为"数值带负号"这种规律的、可解释的现象。' }
        ],
        explain:
          '<p><b>"偶尔出现负数"是这道题的关键线索——它是一个有明确技术含义的症状。</b></p>' +
          '<p>Java 的 <code>byte</code> 是<b>有符号 8 位整数</b>（-128 ~ 127），而十六进制的一个字节是<b>无符号</b>的（0x00 ~ 0xFF）。' +
          '当 Java 里的字节值是 <code>0x80</code> 及以上时，Frida 读出来是负数：</p>' +
          '<p><code>0xFF</code> → <code>-1</code>；<code>0x80</code> → <code>-128</code>。</p>' +
          '<p>如果不做转换直接 <code>toString(16)</code>，你会得到 <code>"-1"</code> 这样的字符串——' +
          '<b>既有负号，长度也不对</b>。而预期值里对应位置应该是 <code>ff</code>。</p>' +
          '<p><b>正确的读法：</b>逐元素取出来，先 <code>&amp; 0xff</code> 转成无符号，再补零成两位十六进制。</p>' +
          '<p style="margin-bottom:0"><b>为什么这道题重要：</b>这类 bug 会<b>伪装成算法错误</b>。' +
          '你会拿着一个读错的十六进制串去和预期比对，发现"对不上"，' +
          '于是开始怀疑算法被魔改、怀疑密钥不对、怀疑常数表变了——' +
          '<span class="miss">而真正的问题只是读数时少了一个 &amp; 0xff。</span><br>' +
          '<span class="hit">所以 21.7 的推演里专门把这一步标成 ★：' +
          '<b>先把"读值"正确性确认掉，再谈算法正确性。</b></span></p>'
      }
    },

    /* ============================================================ 21.24 */
    {
      h: '21.24', title: '本章自测（四）',
      quiz: {
        id: 'q21-8', chapter: 21, answer: 0,
        stem: '你用 r0tracer 对三个包批量打点，得到 6 万行输出。想尽快定位到"哪个方法在做加密"，' +
              '下面哪种做法最符合本章的方法论？',
        options: [
          { t: '先把日志落盘，然后用"只看业务包 + 只看首次调用 + 只看耗时较大的"三个条件交叉收敛，锁定候选后再回验',
            why: '正确。这就是 21.5 讲的两级收敛：打点时收窄范围，输出上用过滤器交叉筛。落盘是前提（终端里看不了 6 万行），首次调用砍掉绝大部分重复，耗时把注意力引向真正做运算的方法，最后必须回验而不是直接采信。' },
          { t: '打开 Stalker 做指令级 trace，这样能精确看到每一条指令，定位最准',
            why: '指令级 trace 会让 App 慢几十倍，既有卡死风险，又会触发耗时检测（第 10、13 章的检测点）。而且你现在要的是"哪个方法"，不是"哪条指令"——用重锤砸核桃，还会把核桃砸碎。' },
          { t: '从日志第一行开始逐行读，因为顺序就是调用顺序，读一遍就懂了',
            why: '6 万行逐行读不是方法，是消耗。而且调用顺序在批量打点里会被大量无关调用打断，读一遍得到的是一堆噪音。' },
          { t: '先用 objection 把三个包的类都列出来，人工找出名字里带 crypto / aes / sign 的，直接 hook 它们',
            why: '这个做法有一个致命前提：你假设"名字能反映功能"。而加固混淆下名字往往是 a、b、c；更常见的是名字最像加密的那个只是薄封装（21.15 实验里的陷阱 A 就是这个）。按名字挑 hook 点，命中率远低于按行为筛。' }
        ],
        explain:
          '<p><b>这道题的核心是"先用便宜的过滤器砍大块，再用业务语义精修"。</b></p>' +
          '<p><b>① 落盘</b>——6 万行在终端里没法看，这是物理限制，不是效率问题。<br>' +
          '<b>② 只看业务包</b>——最安全的过滤器，几乎不会误伤，砍掉所有 <code>java.*</code> / <code>javax.*</code> / <code>android.*</code> 框架噪音。<br>' +
          '<b>③ 只看首次调用</b>——砍得最狠，因为同一个方法在循环里会被调用上万次，而"它被调用过"只需要看一次。<br>' +
          '<b>④ 只看耗时较大的</b>——真正的密码学运算是有成本的。<br>' +
          '<b>⑤ 回验</b>——<b>过滤器会把候选压到几个，但不会压到唯一一个。</b>' +
          '最后还得靠行为判据（是标准库吗 / 它自己算了吗 / 它是 native 吗）挑出那一个，' +
          '再用它做条件重新精确 hook 一次确认。</p>' +
          '<p style="margin-bottom:0"><b>三个错误选项各自代表一种典型误区：</b><br>' +
          'B 是"用力过猛"——用最重的工具解决最轻的问题，还引入了新的风险；<br>' +
          'C 是"没有方法"——把"读日志"当成了工作本身；<br>' +
          'D 是"用名字代替行为"——这在混淆和薄封装面前会立刻失效。<br>' +
          '<span class="hit">记住 21.15 实验的结论：判据是行为（耗时 / 调用链 / 参数形态），不是名字。</span></p>'
      }
    }
  ],

  /* ============================================================ 名词表 */
  glossary: [
    { t: 'objection', d: '基于 Frida 的免脚本运行时操作台。把枚举类、搜索、监听方法、内存搜索、常见绕过等高频动作做成命令。' +
        '关键认知：它底层就是 Frida，因此它的特征暴露面就是 Frida 的暴露面。' },
    { t: 'r0capture', d: '基于 Frida 的安卓应用层抓包脚本。不做中间人、不处理证书，' +
        '在系统 SSL 读写路径上直接取明文。能力边界由此决定：不走系统 SSL 的实现（自研 SSL / WebView / 小程序 / Flutter）抓不到。' },
    { t: 'r0tracer', d: '安卓 Java 层批量追踪脚本，自我定位是"精简版 objection + Wallbreaker"。' +
        '核心价值是"先批量打点、再从输出里捞"——用运行时行为代替对类名方法名的猜测。' },
    { t: '主动调用（Invoke Java）', d: '不等待 App 调用目标方法，而是自己构造参数、主动发起调用并取回结果。' +
        '把 Frida 从观察者变成调用者，是第 2 章 FART"主动调用"思路的用户态版本。' },
    { t: 'Java.registerClass', d: 'Frida 提供的动态造类能力：可以在运行时定义一个新类，指定父类、实现的接口与方法体。' +
        '常用于实现一个接口来充当回调，把 Java 侧的控制流引到你的代码里。' },
    { t: 'hluda', d: '中文社区里流传的一个"去特征 Frida 分支"的名字标签，在若干帖子与文章中被当作魔改版 Frida 的代称。' +
        '本项目无法断言它的版本与维护状态（待核实）。真正稳定可学的不是某个分支名，而是"要改哪些特征"这份清单。' },
    { t: 'strongR-frida-android', d: '一个跟随 Frida 上游自动打补丁、构建抗检测版 frida-server 的社区项目。' +
        '它的 README 列出了补丁清单（RPC 字符串、server 通信路径、管道名、agent 的 so 名、frida_agent_main 符号、' +
        'gum-js-loop 与 gmain 线程），这份清单本身就是"编译期要改什么"的目录。当前维护状态随上游变化，待核实。' },
    { t: 'frida-agent', d: '注入到目标进程内的 Frida 组件（以 so 形式存在）。它的模块名会出现在 /proc/self/maps 里，' +
        '是"读 maps 找 Frida"这类检测的主要目标，也是自己编译时要改名的主要对象之一。' },
    { t: 'gum-js-loop / gmain', d: 'Frida 在目标进程内部创建的线程名。它们会出现在 /proc/self/task/*/comm 里。' +
        '关键点：改用 gadget 消除了独立 server 进程，但这些内部线程名依然存在。' },
    { t: '暴露面（攻击面）', d: '本章的核心概念：一次 Frida 会话在目标进程（及系统）里留下的全部可观测痕迹。' +
        '它是有层次的——名字 → 映射 → 字节 → 行为，越往下越难消除。' },
    { t: 'nop 一个函数', d: '让函数被调用但立即返回、不执行原逻辑。要点是<b>保留调用发生时序</b>，只消灭"生效"这个结果——' +
        '因为调用方可能依赖返回值、时序、或调用次数。' },
    { t: 'hook dlopen', d: '在动态库加载入口（dlopen / android_dlopen_ext）上下钩，从而掌握"谁在什么时候被加载"，' +
        '并把介入时机前移到目标 so 的初始化流程之前。解决"hook 一次都没触发"这类时序问题的核心手段。' },
    { t: 'ModuleMap（模块加载关系图）', d: '记录"谁加载了谁、什么时候加载的"的关系图。' +
        '筛选用法：谁是主动加载的（而非依赖加载）、谁晚加载、谁在功能触发时才加载。' +
        '已知盲区：走自定义 Linker 加载的 so 不在常规模块枚举里。' },
    { t: 'RWX 内存段', d: '同时可写可执行的内存区间。运行时代码修改（Stalker、inline hook）的必然副产品，' +
        '在 /proc/self/maps 里表现为没有文件路径的匿名可执行映射。这是"行为特征"，用户态无法消除。' },
    { t: 'TracerPid', d: '/proc/self/status 里的一个字段。进程被 ptrace 附加（常见的注入方式）时该字段非 0，' +
        '因此它既是检测点，也是"我用什么方式注入"的暴露面。' },
    { t: '特征暴露面审计', d: '本章实验 A 的方法：列出暴露点 → 标注权重 → 逐项评估各对抗手段的覆盖度（允许部分覆盖）→ ' +
        '算残余风险 → 按覆盖面优劣排序 → 找出不可替代项。它的价值在于结构（分层 + 加权 + 覆盖不均），不在具体数字。' }
  ],

  /* ============================================================ 严师 */
  teacher: {
    id: 't21',
    chapter: 21,
    name: 'Hook 老工头',
    sub: '你在车间里待了多久不重要，我只看你能不能说出"这一刀砍在哪一层"',
    intro:
      '<p>我见过太多人抱着一堆工具来干活，问他"你现在做这一步是为了什么"，他答不上来。</p>' +
      '<p>这一关我不考你记住了几个命令——<b>我考你能不能说出：你这一刀砍的是哪一层暴露面，砍完还剩什么，' +
      '以及为什么不能换个更省事的做法。</b></p>' +
      '<p>答不上来可以要提示，但我要提醒你：提示不算过关。说不全，我就继续问。</p>',
    questions: [
      {
        id: 'c21q1', depth: 1, threshold: 0.7,
        q: '自动化工具（objection / r0capture / r0tracer）到底帮你省掉了什么成本？' +
           '以及它们<b>省不掉</b>的是什么？请两类都说。',
        concepts: [
          { label: '省掉的是定位成本与重复成本（枚举、搜索、批量打印、绕过通用校验）',
            hint: '想想你每次手写脚本时，有哪几行是"每换一个目标都要重写一遍"的模板代码',
            any: ['定位', '重复', '枚举', '搜索', '批量', '模板', '通用动作', '通用', '体力活',
                  '省事', '打印', '调用栈', '重复劳动', '套路'] },
          { label: '省不掉的是"这个 App 的特定逻辑"——业务语义、参数怎么拼、算法怎么还原',
            hint: '想想"这个签名参数为什么是这个顺序"这类问题，有没有通用工具能回答',
            any: ['特定逻辑', '业务逻辑', '业务语义', '这个app', '特定', 'app 的', '语义',
                  '参数怎么拼', '还原算法', '算法还原', '猜不到', '定制', '独有的', '只属于'] },
          { label: '自动化只是把手写脚本固化，它不改变 Frida 本身的特征暴露面',
            hint: '再想一层：换了工具之后，进程里的痕迹变了吗',
            any: ['暴露面', '特征', '底层', '还是 frida', '就是 frida', '封装', '换工具', '不改变',
                  '一处不多', '痕迹'] },
          { label: '所以实战中的比例是"自动化吃体力活，手写脚本吃业务推理"，两者都要',
            hint: '那到底还要不要学手写脚本',
            any: ['手写', '都要', '结合', '配合', '比例', '不是全部', '仍需', '还得', '不能只靠',
                  '工具加手写', '两条腿'] }
        ],
        hints: [
          '先分两类想：一类是"每换一个目标都要重做一遍的事"，一类是"只跟这一个目标有关的事"。',
          '再往深一层：你把工具从手写脚本换成 objection，目标进程里的痕迹少了哪怕一处吗？'
        ],
        probes: [
          '你说的"省掉重复成本"具体指哪些动作？举三个。',
          '那"省不掉的那部分"，在实战里通常占多少工作量？为什么不是"工具再进步一点就能解决"？'
        ],
        model:
          '<p><b>省掉的两笔成本：</b></p>' +
          '<p><b>① 定位成本。</b>手写脚本的第一步永远是"我要 hook 谁"——类名、方法名、参数签名、' +
          '以及加载它的 ClassLoader。这四样在加固 App 上可能一个都不在静态结果里。' +
          'objection 的枚举/搜索把"翻 jadx"换成了"运行时枚举"；r0tracer 更进一步，' +
          '<b>直接不问"要 hook 什么"，而是先批量打点、让真实调用顺序自己浮现。</b></p>' +
          '<p><b>② 重复成本。</b>打印参数、打印返回值、打印调用栈、打印字段——这些模板代码每个目标都要写一遍。' +
          '它们<b>不依赖目标的业务逻辑</b>，所以可以被固化成工具。这正是 objection 和 r0tracer 存在的理由。</p>' +
          '<p><b>省不掉的那笔：</b><b>"这个 App 的特定逻辑"</b>。' +
          '"签名参数拼成了什么顺序"、"这个 48 字节数组是怎么从设备信息算出来的"、' +
          '"它校验的是哪一份证书"——<b>每一个问题都只属于那一个 App</b>，没有任何通用工具能回答。' +
          '这不是"工具还不够强"，而是这类问题的输入本身就是"那个 App 的代码"，' +
          '通用工具拿不到这个输入。</p>' +
          '<p><b>还有一层更关键的：自动化不改变暴露面。</b>' +
          'objection 底层就是 Frida，它仍然要注入 agent、仍然会产生模块映射、内部线程名、' +
          '端口这些痕迹。<b>换工具改变的是"你的工作量"，不是"进程里的特征"。</b>' +
          '所以遇到"被检测到"，正确答案从来不是"换个工具"。</p>' +
          '<p><b>结论：</b>自动化吃掉体力活（大概六成），剩下的业务推理只能手写。' +
          '<b>两者不是替代关系，是分工。</b></p>',
        after:
          '<p>你把"工具能做什么、不能做什么"这条线画出来了。' +
          '<b>这条线就是本章的元原则：先确认要解决的问题在哪一层，再选覆盖面匹配的手段。</b></p>'
      },
      {
        id: 'c21q2', depth: 2, threshold: 0.7,
        q: 'r0capture 为什么"不用管证书"，以及它在什么情况下<b>必然</b>抓不到？' +
           '请从"它的 hook 点在哪里"这个角度回答。',
        concepts: [
          { label: '它不做中间人，而是在目标进程内的 SSL 读写路径上直接取明文',
            hint: '想想传统抓包（Charles）和它的根本差别在哪',
            any: ['进程内', '不经过代理', '不做中间人', '不插中间', 'ssl_read', 'sslwrite', 'ssl_write',
                  '读写', '直接取明文', '明文', '在进程里', '进程内部'] },
          { label: '因为不参与证书验证，所以证书固定（pinning）这个维度对它整体失效',
            hint: 'pinning 挡的是"不受信任的证书"，而它的问题域里有证书这一项吗',
            any: ['证书校验', '证书固定', 'pinning', '不信任', '不需要证书', '不参与', '绕开证书',
                  '不碰证书', '无关'] },
          { label: '必然抓不到的情况：App 用自研 SSL 实现，系统的 SSL_read / SSL_write 从未被调用',
            hint: '如果目标根本不调用你挂的那个函数，你的钩子会发生什么',
            any: ['自研', '自己实现', 'flutter', 'webview', '小程序', '私有', '自带', '不调用',
                  '从未被调用', '钩子不触发', '不生效', '不走系统'] },
          { label: '所以"抓不到"的正确读法是"钩子挂在了一条不会被走到的路径上"，而不是"工具不好用"',
            hint: '那这时候该做什么，而不是该换什么',
            any: ['钩子', '路段', '路径', '不会被调用', '定位它自己的', '自己找', '溯源',
                  'socket', '第23章', '不是工具', '换思路'] }
        ],
        hints: [
          '先回答一个更基本的问题：r0capture 到底 hook 了哪个函数？',
          '然后问：这个函数在什么条件下会被调用？把这个条件反过来写，就是它的适用边界。'
        ],
        probes: [
          '那"WebView / 小程序 / Flutter 抓不到"和"HTTP/2 抓不到"，是同一个原因还是两个原因？',
          '如果目标走自研 SSL，你觉得下一步应该是换工具，还是换思路？换什么思路？'
        ],
        model:
          '<p><b>为什么不用管证书：</b>传统抓包（Charles / mitmproxy）是<b>中间人</b>——' +
          '你必须让 App 信任你的 CA，所以"证书固定"能精准打它。' +
          'r0capture 走的是完全不同的路：<b>它站在目标进程内部，' +
          '在 SSL 读写函数的出口/入口把明文抄一份</b>。' +
          '数据根本不经过它，它也不需要被信任——<b>证书验证这件事压根没有发生。</b></p>' +
          '<p><b>从 hook 点推边界：</b>它的钩子挂在<b>系统 SSL 实现</b>（Java 侧 <code>SSL_read</code>/<code>SSL_write</code> ' +
          '及 Native 对应层）上。于是一条推理链就出来了：</p>' +
          '<p><b>能抓 ⇔ 目标最终走到系统 SSL 实现。</b></p>' +
          '<p><b>必然抓不到的三种情况，都是这条推理的推论：</b></p>' +
          '<p><b>① 自研 SSL 实现</b>（Flutter 的 BoringSSL、小程序的私有网络栈、WebView 自己的网络层）：' +
          '<b>系统的 <code>SSL_read</code>/<code>SSL_write</code> 从未被调用</b>——' +
          '钩子装上了，但从来没有执行过。表现出来就是"命令成功、零输出"。</p>' +
          '<p><b>② HTTP/2、HTTP/3</b>：这些协议栈由 App 自带，同样不走系统的通用 hook 点。' +
          '<b>和 ① 是同一个原因的不同表现。</b></p>' +
          '<p><b>③ 多进程</b>：这条略有不同——不是 hook 点错了，而是<b>你根本没在那个进程里</b>。' +
          '子进程（<code>:service</code>、<code>:push</code>）里的网络请求，你主进程的脚本看不到。</p>' +
          '<p><b>正确的读法：</b>遇到"抓不到"，不要问"这个工具行不行"，要问' +
          '<b>"它的钩子挂在哪个函数上，这个函数在这条路径上会被调用吗"</b>。' +
          '这两个问题能把"工具不好用"的抱怨变成一个明确的技术判断。' +
          '然后下一步是<b>去定位目标自己的读写点</b>（第 23 章的 socket/SSL 溯源），' +
          '而不是换一个抓包工具再来一遍。</p>',
        after:
          '<p>你从"它 hook 什么"推出了"它什么时候失效"。<b>这就是本章最该带走的一种推理方式：' +
          '能力与边界是同一个原因的两面。</b></p>'
      },
      {
        id: 'c21q3', depth: 2, threshold: 0.7,
        q: '你要 nop 掉一个校验函数。为什么通常应该"让函数被调用但立刻返回"，' +
           '而不是"让它根本不被调用"？另外，nop 之后如果 App 行为反而异常了，说明什么？',
        concepts: [
          { label: '保留调用发生时序：调用方可能依赖调用次数、时序、或"调用过"这个事实本身',
            hint: '如果一段代码从来不调那个函数，周围的时序会不会变',
            any: ['时序', '调用次数', '顺序', '依赖', '被调用', '时机', '时间窗', '节奏',
                  '副作用', '状态'] },
          { label: '调用方可能依赖返回值做分支判断，不调用等于没给返回值',
            hint: '那个函数的返回值，有没有可能被用来决定走哪个分支',
            any: ['返回值', '返回', '分支', '判断', '结果', '条件', '决定'] },
          { label: 'nop 后行为异常，说明这个函数的副作用被别处依赖了——应该改成"返回一个看起来正常的值再转调原实现"',
            hint: '那该怎么修，而不是继续 nop 更多函数',
            any: ['副作用', '被依赖', '别处', '依赖', '转调', '原实现', '改成', '伪造',
                  '看起来正常', '换个值', '返回值改'] },
          { label: '如果 nop 之后毫无变化，说明你 nop 的不是关键点——检测可能存在多处或被复用，应该去找被复用最多的那个原语',
            hint: '第 10 章那个案例里，核心原语被复用了几处',
            any: ['复用', '多处', '不是关键', '不是那个', '找关键', '核心原语', '收敛',
                  '换目标', '没用', '白 nop'] }
        ],
        hints: [
          '想想调用它的那段代码：它除了"调用"这个动作，还会不会用到这个调用的"结果"？',
          '第 10 章的案例里，作者为什么是去改一个"被 4 处复用的原语"，而不是逐个去堵检测点？'
        ],
        probes: [
          '那"nop 之后调用次数变了"这件事，本身会不会成为新的检测特征？',
          '多个检测点共用同一个底层原语，这个结构对你有什​么好处？'
        ],
        model:
          '<p><b>为什么要保留调用：</b></p>' +
          '<p><b>① 时序。</b>调用点周围的执行顺序、时间窗口、状态推进，可能本身就是别的检测或业务逻辑的一部分。' +
          '你让它不被调用，改变的不只是那个函数的行为，还有它所在的那段流程。</p>' +
          '<p><b>② 返回值。</b>调用方很可能<b>拿它的返回值做分支判断</b>。不调用就等于没有返回值——' +
          '调用方拿到的可能是未初始化的值、上一次的残留，行为不可预测。' +
          '而"调用它、但让它返回一个看起来正常的值"，调用方会按正常路径继续走。</p>' +
          '<p><b>③ "被调用过"这个事实本身可能被依赖。</b>有些校验是成对的（检查 + 上报），' +
          '少了一次调用会让后面的逻辑拿到空状态。</p>' +
          '<p><b>所以：</b>nop 的正确理解是<b>"保留被调用这个事实，只消灭生效这个结果"</b>。' +
          '这和 21.9 里说的"保留调用发生时序"是同一件事。' +
          '第 10 章那个案例里"让核心原语恒返回 0"，就是这个思路的 native 版。</p>' +
          '<p><b>nop 之后行为异常说明什么：</b>说明<b>这个函数的副作用被别处依赖了</b>。' +
          '修法是改用"替换实现"——<b>返回一个看起来正常的值，再转调原实现</b>，' +
          '让下游拿到它期待的东西，同时你拿到你想要的结果。</p>' +
          '<p><b>补一句更重要的：</b>如果 nop 之后<b>毫无变化</b>，那说明<b>你 nop 的不是关键点</b>。' +
          '这时不要继续 nop 更多函数——<b>应该去找"被复用次数最多的那个原语"</b>。' +
          '第 10 章那个案例里，核心原语被 4 处复用，作者改一个函数就关掉了全部 hook 检测。' +
          '这就是"找最小充分改动点"——它和本章实验里"按覆盖面排序、不按好实现排序"是同一种性价比思维。</p>',
        after:
          '<p>你分清了"消灭行为"和"消灭调用"的差别，也知道了 nop 无效时该往哪找。' +
          '<b>下一步我要问的是更狠的问题：如果目标根本不给你 nop 的机会呢？</b></p>'
      },
      {
        id: 'c21q4', depth: 3, threshold: 0.7,
        q: '<b>综合题。</b>现在给你一个 App：<b>一 attach 就退出</b>，' +
           '你没有源码、只有一份公开的 frida-server。' +
           '请说清你的<b>完整对抗顺序</b>——每一步你在验证什么、这一步失败意味着什么、' +
           '以及如果所有用户态手段都用尽了，你下一步往哪走、为什么是那里。',
        concepts: [
          { label: '第一步用最便宜的手段（改名 / 换目录 / 换端口）——它同时是"探针"：不生效就说明检测点不在第 1 层',
            hint: '为什么值得先做这个"看起来最没用"的动作',
            any: ['改名', '重命名', '换端口', '改端口', '换目录', '路径', '最便宜', '成本最低',
                  '探针', '试一下', '先试', '五分钟'] },
          { label: '第二步改用 spawn 模式抢时序——脚本能输出几行就说明"墙在注入点之后"，输出还是零就说明墙更早',
            hint: 'attach 和 spawn 的结果差，本身就是一个测量结果',
            any: ['spawn', '抢时序', '抢先', '抢跑', '-f', '注入时机', '前移', '早', '时序',
                  '输出几行', '部分生效', '边界'] },
          { label: '第三步 hook dlopen，把介入点前移到 so 的初始化流程之前（JNI_OnLoad / 构造函数）',
            hint: 'spawn 之后还太晚，说明目标在更早的位置动手；那个位置通常在哪',
            any: ['dlopen', 'android_dlopen_ext', 'jni_onload', '构造函数', 'init_array',
                  'so 加载', '加载入口', '初始化', '前移'] },
          { label: '同时要确认暴露点在"哪一层"：读 /proc/self/maps、读线程名、扫二进制字符串、遍历导出符号，各自的补法完全不同',
            hint: '第 1 层清干净了还被杀，说明它在看第 2 层或更深',
            any: ['maps', '线程名', 'comm', '字符串', '导出符号', '符号表', '哪一层', '第2层', '第3层',
                  '扫描', '遍历'] },
          { label: '覆盖面排序：编译能一次性抹掉模块名 / 特征字符串 / 导出符号 / 线程名四类，但它有持续维护成本',
            hint: '哪一项手段的覆盖面最大，代价是什么',
            any: ['编译', '自己编译', 'hluda', 'strongr', '抹字符串', '改符号', '改名字', '覆盖面',
                  '维护', '跟上游', '补丁'] },
          { label: '用户态的墙：RWX 内存段、JS 引擎运行时结构、ptrace 注入痕迹——这三样用户态消除不掉',
            hint: '名字、字符串都能改，但有哪三样是"行为的必然副作用"',
            any: ['rwx', '匿名内存', '可写可执行', 'v8', 'jsc', 'js 引擎', '引擎结构', 'tracerpid',
                  'ptrace', '注入痕迹', '行为特征', '副作用'] },
          { label: '下一步下沉到内核（第 13 章）：不改"进程里有什么"，而改"内核向这个进程报告什么"；再下面还有 Hypervisor（第 6 章）',
            hint: '用户态做不到的部分，哪个层级能补',
            any: ['内核', 'kernel', '内核模块', '第13章', 'syscall', '下沉', 'hypervisor',
                  '第6章', '下一层', '虚拟化'] }
        ],
        hints: [
          '顺序不是"哪个手段强就先上哪个"，而是"哪个动作能最快地告诉我它在看哪一层"。',
          '每一步失败都不是终点，而是一个测量结果：它告诉你"墙还在更前面"。想想 attach 和 spawn 的差别能测出什么。',
          '最后那一步：当你要隐藏的不再是"名字"而是"存在"的时候，同一层里还有办法吗？'
        ],
        probes: [
          '你说"改名不生效就说明检测点不在第 1 层"——那你怎么确认改名本身是生效的？如果没确认，这个推论还成立吗？',
          '编译能抹掉四类特征，但它抹不掉什么？那三样为什么抹不掉？',
          '你为什么选内核而不是 Hypervisor？在你的场景下，这两个层级的差别是什么？'
        ],
        model:
          '<p><b>完整顺序（每一步都同时是"动作"和"测量"）：</b></p>' +
          '<p><b>第 1 步：改名 + 换目录 + 换端口。</b>成本五分钟。' +
          '<b>它测的是"检测点在第 1 层吗"。</b>生效 → 收工；不生效 → <b>确认改动确实生效过之后</b>，' +
          '可以下结论：检测点不在第 1 层。<br>' +
          '<span class="hit">（这一步的关键纪律：必须确认"改动生效"和"仍然被杀"这两个事实同时成立，' +
          '否则这个推论是空的。）</span></p>' +
          '<p><b>第 2 步：改用 spawn 模式。</b>它测的是"墙在注入点之前还是之后"。<br>' +
          '脚本能输出几行 → <b>墙在注入点之后</b>，你只差一点；<br>' +
          '脚本还是零输出 → <b>墙在更早的位置</b>（so 的初始化流程里）。<br>' +
          '<span class="miss">"部分成功"是最贵的情报，不能当成失败扔掉。</span></p>' +
          '<p><b>第 3 步：hook dlopen，把介入点前移。</b>' +
          '在加载入口上挂钩，你能拿到"谁在什么时候被加载"，' +
          '并在调用方拿到句柄之后、继续执行之前动手。' +
          '<b>这一步对应的判断是"检测代码在某个 so 的初始化流程里"。</b></p>' +
          '<p><b>第 4 步：确认它在看哪一层。</b>' +
          '读 <code>/proc/self/maps</code>？读 <code>/proc/self/task/*/comm</code>？' +
          '扫二进制字符串？遍历导出符号表？<br>' +
          '<b>这四种的补法完全不同</b>——前两种可以篡改观察管道（hook open/read 过滤），' +
          '后两种只能靠改编译。<b>不确认层次就动手，等于在猜。</b></p>' +
          '<p><b>第 5 步：按覆盖面排序做去特征。</b>' +
          '改编译是覆盖面最大的一招——一次性抹掉<b>模块名、内存特征字符串、导出符号、内部线程名</b>四类。' +
          '代价是持续维护（补丁要跟 Frida 上游）。' +
          '<b>注意这一步不是"因为强所以先做"，而是"确认了它在看第 3 层之后才做"。</b></p>' +
          '<p><b>第 6 步：认清用户态的墙。</b>' +
          '名字改了、字符串抹了，但还有三样抹不掉：<br>' +
          '<b>① RWX 匿名内存段</b>——你要 hook 就得改代码段，改了就有可写可执行区间，' +
          '而且它没有名字，你没法给它改名；<br>' +
          '<b>② JS 引擎（V8 / JSC）的运行时结构</b>——你要跑脚本就得有 JS 运行时，' +
          '它是"按结构识别"，改字符串对它无效；<br>' +
          '<b>③ 注入痕迹</b>（TracerPid、调试寄存器）——这是"你做过什么"，不是"你叫什么"。</p>' +
          '<p><b>第 7 步：换层级——下沉到内核（第 13 章）。</b><br>' +
          '理由不是"内核更隐蔽"，而是<b>视角变了</b>：' +
          '用户态的一切痕迹都产生在目标进程内部，而检测代码也在同一个进程里——' +
          '<b>你和它共享同一个观测视角，所以你能做的事有上限。</b><br>' +
          '内核模块不改变"进程里有什么"，它改变的是<b>"内核向这个进程报告什么"</b>：' +
          '读 maps 时返回过滤后的内容、读线程名时返回伪造的名字。<br>' +
          '<b>代价：</b>要写内核代码、要适配内核版本、出问题影响整机。' +
          '所以它的适用场景是"少数几台固定设备上的长期目标"，不是广泛兼容。</p>' +
          '<p><b>为什么再往下还有 Hypervisor（第 6 章）：</b>' +
          '如果对手的检测也下沉到内核（甚至自己就是内核模块），内核里的对抗就变成了同层对抗。' +
          'Hypervisor 提供内核之下的观测层：对被观测系统来说它是"硬件"，' +
          '因此能看到内核的每一次内存访问，而内核在理想实现下观测不到它。</p>' +
          '<p><b>再点一遍那个纪律：</b>每一步都要问"我这一刀砍的是哪一层、砍完还剩什么"。' +
          '<b>被"这一层解决了"说服，是最常见的停滞方式。</b></p>',
        after:
          '<p>你把整条路线串起来了，而且每一段都说清了"这一步在验证什么"。</p>' +
          '<p><b>最后一句话送你：</b>对抗的极限不在于你手里的工具够不够强，' +
          '而在于<b>你到底在哪一层和对手交手</b>。' +
          '同层对抗永远有天花板——<span class="hit">下沉，或者换维度。</span></p>'
      },
      {
        id: 'c21q5', depth: 3, threshold: 0.7,
        q: '<b>综合题。</b>请把"暴露面"这件事讲成一幅地图：' +
           '它分几层、每一层是什么、各层的补法有什么本质差别，' +
           '以及为什么"用很少的手段清干净所有暴露点"是做不到的。' +
           '顺带说清：第 10 章、本章、第 13 章各自的着力点是什么。',
        concepts: [
          { label: '分层：名字（进程名 / 端口 / 路径）→ 映射（模块名 / maps / 线程名）→ 字节（内存字符串 / 导出符号）→ 行为（RWX / JS 引擎结构 / ptrace 痕迹）',
            hint: '按"越往下越难消除"的顺序数一遍',
            any: ['名字', '端口', '路径', '映射', 'maps', '模块名', '线程名', '字节', '字符串',
                  '符号', '行为', 'rwx', 'tracerpid', '分层', '四层', '几层'] },
          { label: '各层补法本质不同：改自己 → 改对方的观察管道 → 改编译产物 → 换层级（内核 / Hypervisor）',
            hint: '这四种补法不是"力度递增"，而是四种不同的动作类型',
            any: ['改自己', '观察管道', '篡改', '过滤', 'hook open', '改编译', '重新编译',
                  '换层级', '下沉', '内核', 'hypervisor', '换维度'] },
          { label: '覆盖面是不均匀的：改文件名只覆盖一处，改编译一次覆盖四类；所以手段要按覆盖面排序而不是按好实现排序',
            hint: '实验 A 里那个"性价比排序"告诉你什么',
            any: ['覆盖面', '不均匀', '排序', '性价比', '一次', '多项', '四类', '不是一对一',
                  '攻防不对称', '不对称'] },
          { label: '用户态有硬上限：RWX / JS 引擎结构 / ptrace 痕迹是"行为的必然副作用"，用户态消除不掉',
            hint: '那三样为什么改名字改不掉',
            any: ['硬上限', '天花板', '极限', '必然', '副作用', '消除不掉', '改不掉', '行为特征',
                  '存在', '消不掉'] },
          { label: '所以"很少的手段清干净全部"做不到——检测方只要找到一个口子就赢了，而你必须堵住所有口子',
            hint: '这个不对称性对策略意味着什么',
            any: ['不对称', '一个口子', '所有口子', '全部', '不可能', '做不到', '必须全堵',
                  '短板', '木桶'] },
          { label: '第 10 章给地图（检测点与对抗手段的配对 + 攻防不对称），本章给工程能力与度量（工具定位与边界 + 可算的暴露面审计），第 13 章给下一层（syscall / 内核 / 硬件断点）',
            hint: '三章不是重复，是分工——各自用力在哪',
            any: ['第10章', '第 10 章', '地图', '配对', '对照表', '本章', '工程', '度量', '审计',
                  '第13章', '下一层', 'syscall', '硬件断点', '分工'] }
        ],
        hints: [
          '第一层和最后一层的差别不是"手段强弱"，而是"你在和谁共享观测视角"。',
          '想想实验 A 里那三个"去掉它损失最大"的项——它们覆盖的暴露点有什么共同点？',
          '三章的关系：一张是地图，一张是工具台和尺子，一张是楼梯。'
        ],
        probes: [
          '如果给你无限时间但只能在用户态工作，你能把残余暴露降到零吗？为什么？',
          '为什么说"换层级"和"加大力度"是两种不同的操作？'
        ],
        model:
          '<p><b>暴露面地图（由浅到深）：</b></p>' +
          '<p><b>第 1 层 · 名字</b>：进程名、默认端口、安装路径。<br>' +
          '<b>补法：改自己。</b>成本五分钟。' +
          '<span class="hit">这一层的特点是"又容易看到、又容易改掉"。</span></p>' +
          '<p><b>第 2 层 · 映射</b>：模块名出现在 <code>/proc/self/maps</code>；内部线程名出现在 ' +
          '<code>/proc/self/task/*/comm</code>。<br>' +
          '<b>补法：改对方的观察管道</b>（hook <code>open</code>/<code>read</code> 过滤 maps 内容），' +
          '或在编译期把模块名和线程名换掉。<br>' +
          '<b>为什么不能靠改自己：</b>maps 是内核给的，线程名是运行时创建的——' +
          '你在磁盘上改文件名，一点都不影响它们。</p>' +
          '<p><b>第 3 层 · 字节</b>：内存里的特征字符串（frida / gum / rpc）、导出符号（<code>frida_agent_main</code>）、' +
          'D-Bus 通信特征。<br>' +
          '<b>补法：改编译产物。</b>因为它们<b>写死在二进制里</b>——运行时改不了"我编译成了什么"。<br>' +
          '运行时 hook <code>strstr</code> 只能骗过"用字符串比较函数检测"的那一类；' +
          '一旦对方直接扫内存字节或遍历导出表，hook 就失效了。</p>' +
          '<p><b>第 4 层 · 行为</b>：RWX 匿名内存段、JS 引擎（V8 / JSC）的运行时结构、' +
          '注入痕迹（TracerPid / 调试寄存器）。<br>' +
          '<b>补法：用户态没有。</b>因为它们不是名字，也不是字符串，' +
          '而是<b>行为的必然副作用</b>——你要 hook 就要改代码段（→ RWX），' +
          '要跑脚本就要有 JS 引擎（→ 结构），要进入进程就要有注入方式（→ 痕迹）。' +
          '<b>它们没有名字可以改。</b></p>' +
          '<p><b>为什么"用很少的手段清干净"做不到：</b></p>' +
          '<p><b>① 覆盖面不均匀。</b>改端口只覆盖一处；改编译一次覆盖四类（模块名 / 字符串 / 符号 / 线程名）。' +
          '所以手段必须按<b>覆盖面</b>排序，而不是按<b>好实现</b>排序——' +
          '这就是实验 A 里那个性价比排序要教的东西。</p>' +
          '<p><b>② 攻防不对称。</b>检测方只要找到一个你没堵的口子就赢了；' +
          '而你必须堵住<b>所有</b>口子。<b>这是结构性劣势，不是技术差距。</b></p>' +
          '<p><b>③ 第 4 层在用户态无解。</b>前三层都可以靠改名字、改编译、篡改观察管道解决；' +
          '第 4 层不行。<span class="miss">所以"把残余暴露降到零"这个目标在用户态是不成立的</span>——' +
          '不是因为你不够努力，是因为那一层的证据不是"你是 Frida"，而是"有一块 RWX 内存"、"有进程被 ptrace 过"。</p>' +
          '<p><b>正确的目标因此变成：</b>不追求"完美的隐身"，而追求' +
          '<b>"在对手检查的那一刻，我已经完成了我要做的事"</b>。' +
          '这就是 spawn 抢先、hook dlopen 前移、少开 Stalker 这些手段的共同逻辑——' +
          '<b>它们不消除特征，它们换了一个问题。</b></p>' +
          '<p><b>三章的分工：</b></p>' +
          '<p><b>第 10 章给地图</b>——检测点与对抗手段怎么配对，加上"攻防不对称"这条元原则。' +
          '它让你知道"谁在看什么"。</p>' +
          '<p><b>本章给工程能力和度量</b>——objection / r0capture / r0tracer 各自的定位与边界，' +
          '以及一套<b>可算的暴露面审计流程</b>（列出暴露点 → 加权 → 逐项评估覆盖面（允许部分覆盖）→ ' +
          '算残余 → 按覆盖面排序 → 找出不可替代项）。' +
          '它让你知道"我做到哪一步了、还差什么"。</p>' +
          '<p><b>第 13 章给下一层</b>——SVC 定位、硬件断点、内存动态释放、0r0env。' +
          '当用户态确实无解时，它把观测点搬到内核。<br>' +
          '<b>而且换层级的本质不是"加大力度"，而是"改变观测视角"</b>：' +
          '用户态你和检测代码共享同一个视角；内核里，你成了"向它报告世界"的那一方。</p>',
        after:
          '<p><b>你可以走了。</b>但把这句话带走——</p>' +
          '<p><span class="hit">不要问"哪个工具更强"，要问"我这一刀砍在哪一层、砍完还剩什么、' +
          '剩下的那些是不是同一层里根本解决不了的"。</span>' +
          '能回答这个问题的人，换个目标、换套检测手段，依然走得通。</p>'
      }
    ]
  }
};
