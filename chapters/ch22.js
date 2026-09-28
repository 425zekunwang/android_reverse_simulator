/* 第 22 章数据 —— Xposed / LSPosed 开发指南 */
window.CHAPTER = {
  no: 22,
  title: 'Xposed / LSPosed 开发指南',
  lede: '前 18 章里没有 Xposed，它只在几个案例里作为"检测目标"被顺带提到。但它是与 Frida 并列的另一条主线，' +
        '而且工作方式与 Frida <strong>有本质不同</strong>：Frida 是<strong>按需注入一个进程</strong>，' +
        'Xposed / LSPosed 是<strong>常驻 Zygote、让每个 App 进程"出生即带模块"</strong>。' +
        '这个差异决定了它们各自适合什么场景，也决定了各自会被谁发现。',
  meta: [
    '核心问题：<b>要在什么时机、在哪一层介入，才能既拿到数据又不惊动目标？</b>',
    '关键机制：<b>Zygote 注入 / 入口声明 / XC_MethodHook / 类加载器 / 主动调用</b>',
    '对手：<b>环境检测、方法入口自校验、Zygisk 痕迹检查</b>'
  ],

  sections: [
    /* ============================================================ 22.1 */
    {
      h: '22.1', title: '世界观差异：临时进现场，还是给整栋楼换门禁',
      intuition: {
        tag: '直觉模型 · 现场取证 vs 门禁改造',
        body:
          '<p>Frida 像<strong>鉴识人员进现场</strong>：案子发生后，你带着工具箱进去，拍照、取样、装探头。你走了，探头也撤了——' +
          '现场恢复原样，别的房间你根本没进去过。</p>' +
          '<p>Xposed / LSPosed 像<strong>给整栋楼换一套门禁系统</strong>：你不动任何一个房间里的东西，' +
          '改的是出入口本身。此后每一个进门的人（每一个 App 进程）从刷卡那一刻起，就被你的系统记了一笔。</p>' +
          '<p>这两件事不是"哪个更强"，而是<strong>两种完全不同的工作形态</strong>：一种是一次性取证，一种是长期值守。' +
          '选错了形态，你会发现自己的脚本永远差那么一点——要么够不着，要么太吵。</p>'
      },
      html:
        '<p>先给出五个维度的硬差异。这五点决定了后面所有章节的技术选择，也是本章的立论基础。</p>' +
        T.tbl(
          ['维度', 'Frida', 'Xposed / LSPosed'],
          [
            ['<b>进程模型</b>',
             '一个 server 或 gadget 注入到<b>你指定的那个进程</b>；其它进程完全不受影响',
             '代码注入到 ' + T.term('Zygote', 'Android 所有 App 进程的母体进程。它预加载框架类与资源，之后每个 App 进程都由它 fork 出来。') +
             '，此后从它 fork 出来的<b>每个进程都带着模块</b>'],
            ['<b>注入时机</b>',
             '<b>你决定</b>：spawn 抢跑（进程第一条指令之前）或 attach 事后补挂',
             '<b>系统决定</b>：进程 fork 出来即生效，早到 App 第一行 Java 代码之前。你无法"事后"选择，只能通过作用域决定<b>给谁装</b>'],
            ['<b>作用域</b>',
             '进程级、会话级：这次连上谁，改的就是谁',
             '应用级、可配置：LSPosed 里逐个勾选生效的 App（22.2 会讲它为什么是安全边界）'],
            ['<b>可持久性</b>',
             '会话级：脚本 detach、或 App 重启，改动全部消失',
             '常驻：装一次，重启后依然生效，直到你关掉模块并重启设备'],
            ['<b>可检测性</b>',
             '特征集中在<b>进程</b>：注入线程、agent 映射、端口、被改写的函数头（第 10、21 章）',
             '特征集中在<b>环境</b>：Zygote 阶段的注入痕迹、模块 so 的映射、方法入口被替换、ClassLoader 链异常（22.11）']
          ]
        ) +
        T.note('key', '🔑 一句话把两者的检测面分开',
          '<p style="margin-bottom:0"><b>Frida 的检测面在"进程"，LSPosed 的检测面在"环境"。</b><br>' +
          '进程检测问的是"你现在有没有被接上"；环境检测问的是"<b>这台机器的系统还是不是原装的</b>"。<br>' +
          '后者更麻烦：它不需要你正在被 hook，只需要证明这台机器被改过。这就是为什么 22.11 会专门讲检测，' +
          '也是为什么本章最后要承认一条边界——<b>装过模块的机器与原装机之间的差异，不可能被完全抹平。</b></p>') +
        '<p>下面这个动画把两种进程模型摆在一起。请特别关注第 5 步：<b>你没有 attach 任何进程，但三个 App 都变了</b>。</p>',
      stage: {
        title: '进程模型对照：谁被注入、什么时候被注入',
        speed: 1600,
        render:
          '<div class="flow-col" style="gap:9px">' +
            '<div class="flow-row"><span class="pill mono">Frida 路线</span>' +
              '<span class="blk" id="fa">App A 进程</span>' +
              '<span class="blk" id="fb">App B 进程</span>' +
              '<span class="blk" id="fc">App C 进程</span></div>' +
            '<div class="flow-row"><span class="pill mono">Xposed / LSPosed 路线</span>' +
              '<span class="blk" id="xz">zygote（母体）</span>' +
              '<span class="arrow">→</span>' +
              '<span class="blk" id="xa">App A</span>' +
              '<span class="blk" id="xb">App B</span>' +
              '<span class="blk" id="xc">App C</span></div>' +
            '<div class="flow-row" style="margin-top:6px;padding-top:10px;border-top:1px dashed var(--line)">' +
              '<span class="pill bad" id="note1">准备阶段：两边都还没介入</span></div>' +
          '</div>',
        reset: () => {
          ['fa','fb','fc','xz','xa','xb','xc'].forEach(i => S(i, ''));
          CLS('note1', 'pill bad');
          SET('note1', '准备阶段：两边都还没介入');
        },
        steps: [
          { run: () => S('fa', 'active'),
            note: '<b>① Frida attach 到 App A。</b>只有 A 的进程里多出了 agent 与注入线程；B、C 一模一样，' +
                  '连一个字节都没变。<br><span class="hit">Frida 的作用域单位就是"进程"</span>——这一点后面会反复引用。' },
          { run: () => { S('fa', 'done'); S('fb', 'active'); },
            note: '<b>② 换目标就再 attach 一次。</b>粒度细是优点也是负担：每换一个目标都要重来。<br>' +
                  '但它换来一个极重要的性质——<b>暴露面只有你碰过的那一个进程</b>。' },
          { run: () => { S('fb', 'done'); CLS('note1', 'pill warn'); SET('note1', 'Frida：改动只存在于被 attach 过的进程里'); },
            note: '<b>③ 关键性质：可持久性 = 会话级。</b>脚本 detach，或者 App 自己重启，一切复原。<br>' +
                  '所以"我昨天 hook 过它"这句话在 Frida 里没有意义——<b>每次都要重新建立现场</b>。' },
          { run: () => { S('xz', 'cool'); CLS('note1', 'pill acc'); SET('note1', 'Xposed / LSPosed：模块装进 zygote'); },
            note: '<b>④ LSPosed 把模块装进 zygote。</b>它自己就是一个跑在 Zygisk 或 Riru 之上的模块（22.2 讲）。<br>' +
                  '注意这一步发生在<b>任何 App 启动之前</b>——时机上它比你早得多。' },
          { run: () => { S('xa', 'done'); S('xb', 'done'); S('xc', 'done'); },
            note: '<b>⑤ zygote fork 出 App 进程时，模块代码已经在里面了。</b>' +
                  '你没有 attach 任何进程，但 A、B、C 三个都带着它。<br>' +
                  '<span class="hit">这就是 22.1 全部差异的源头：一个注入母体，一个注入个体。</span>' },
          { run: () => { CLS('note1', 'pill ok'); SET('note1', '✅ 一个注入 zygote，一个按需 attach —— 差异从这一行开始'); },
            note: '<b>⑥ 反过来，改动也变成"持久"和"全局"的。</b>关掉模块要重启；而且所有 fork 出来的进程都被覆盖。<br>' +
                  '这既是力量（装一次，处处生效，迭代成本极低），也是最大风险（<b>暴露面从 1 个进程变成一整台机器</b>）。' }
        ]
      },
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">如果你只记住一句话：<b>Frida 管一个进程，LSPosed 管一套环境。</b><br>' +
        '接下来所有"该用哪个"的问题，都可以用这一句话推下去——包括 22.11 那个真实工程权衡。</p>')
    },

    /* ============================================================ 22.2 */
    {
      h: '22.2', title: '三条演进路线与安装：Xposed → EdXposed → LSPosed',
      html:
        '<p>这条线路上有三代实现，关系是<b>继承</b>而不是"竞争"：</p>' +
        T.tbl(['实现', '它的位置', '挂载方式', '维护状态'],
          [
            ['<b>原始 Xposed</b>（rovo89）',
             '共同祖先。替换 <code>app_process</code> 并把 <code>XposedBridge.jar</code> 塞进 Zygote，' +
             '定义了 <code>IXposedHookLoadPackage</code> 这一整套 API；LSPosed 的 README 在 Credits 里把它写成 ' +
             '<code>XposedBridge: the OG Xposed framework APIs</code>',
             '改系统文件 / 刷入',
             '官方版本停在 Android 8.1 时代 <span class="pill warn">待核实</span>（具体最后一个版本号以官方仓库为准）'],
            ['<b>EdXposed</b>',
             '基于 Riru 的接棒者；LSPosed 的 README 明确写着它是 LSPosed 的 <code>fork source</code>',
             'Riru',
             '<span class="pill warn">待核实</span>（是否已归档、最后支持到哪个版本，请以官方仓库状态为准）'],
            ['<b>LSPosed</b>',
             '当前事实上的主线。官方自述：<i>A Riru / Zygisk module trying to provide an ART hooking framework ' +
             'which delivers consistent APIs with the OG Xposed, leveraging LSPlant hooking framework.</i>',
             'Zygisk 或 Riru 两种 flavor',
             '官方 README 写的支持范围是 <b>Android 8.1 ~ 14</b>；' +
             '<span class="pill warn">待核实</span>（以 release 页当前说明为准）']
          ]) +
        T.card('两个名字必须记住：LSPlant 与 Dobby',
          '<p>LSPosed 的 README Credits 里写得很直白：<b>LSPlant</b> 是它的核心 ART hook 框架；' +
          '<b>Dobby</b> 用来做 inline hooking。<br>' +
          '记住这两个名字有两个用处：<br>' +
          '① 当你看到"LSPosed 到底怎么改的方法"时，答案在 LSPlant 里，不在 Java 层；<br>' +
          '② 当你要在模块里做 native hook 时，Dobby 这类 inline hook 库就是同一个技术家族的成员（22.9 会用到）。</p>') +
        '<h3 style="margin-top:26px">安装：先有 Magisk，再选一条路</h3>' +
        '<p>LSPosed 官方安装文档（wiki <code>How to use it</code>）给出的步骤是：</p>' +
        T.step('①', 'Magisk 24.0+',
          '这是硬前提。LSPosed 是一个 <b>Magisk 模块</b>——它自己没有注入能力，靠 Magisk 提供。') +
        T.step('②', '选 flavor：Zygisk 或 Riru',
          '想走 Zygisk：在 Magisk App 里开启 Zygisk。<br>想走 Riru：先装 <b>Riru 26.1.7+</b>（官方文档给的版本号）。<br>' +
          '<span class="pill warn">待核实</span>：Riru 与 Zygisk 两条路线在各版本上的取舍与弃用时间点，官方仓库与 Magisk 发布说明是唯一权威。') +
        T.step('③', '装 LSPosed，重启，从通知进管理界面',
          '重启后 LSPosed 会发一条状态通知，点它进管理界面确认激活状态。') +
        T.step('④', '装模块，然后<b>逐个勾选作用域</b>',
          '模块按普通 App 安装。装完之后必须回到 LSPosed 的模块页，打开开关，' +
          '<b>再挑出这个模块要对哪些 App 生效</b>——这一步就是 scope。') +
        T.note('key', '🔑 作用域不是"方便选项"，它是安全边界',
          '<p>LSPosed 官方文档里有一句话值得逐字读：有些过时模块需要注入到每一个 App，' +
          '而这件事 <i>so dangerous that LSPosed does not support Select All</i>——' +
          '<b>LSPosed 不提供"全选"，要求用户逐个勾选</b>（文档说这与 Magisk Hide 是同样的策略）。</p>' +
          '<p style="margin-bottom:0">把它读成设计意图：<b>作用域越宽，你的暴露面越大，出问题的爆炸半径也越大。</b>' +
          '一个模块崩在它自己的进程里是小事，崩在每一个 App 进程里就是整台机器的事故。' +
          '所以作用域的正确用法是"最小必要"，而不是"全都勾上省事"。</p>') +
        '<p>下面这张动画把"从装模块到它真的跑起来"的链路走一遍。最后一步（作用域过滤）是最容易被忽略、' +
        '也是最常见的"模块没生效"原因。</p>',
      stage: {
        title: '从 Magisk 到模块生效：注入链路',
        speed: 1500,
        render:
          '<div class="flow-col" style="gap:8px">' +
            '<div class="flow-row"><span class="blk" id="m1">Magisk 24+（提供 root 与模块机制）</span></div>' +
            '<div class="flow-row"><span class="arrow">↓ 二选一</span></div>' +
            '<div class="flow-row"><span class="blk" id="z1">Zygisk</span>' +
              '<span class="pill">或</span><span class="blk" id="r1">Riru 26.1.7+</span></div>' +
            '<div class="flow-row"><span class="arrow">↓ 在 Zygote 里注入</span></div>' +
            '<div class="flow-row"><span class="blk" id="lg">LSPosed 核心（LSPlant + Dobby）</span></div>' +
            '<div class="flow-row"><span class="arrow">↓ App 进程 fork 出来</span></div>' +
            '<div class="flow-row"><span class="blk" id="sc">作用域过滤：这个 App 在 scope 里吗？</span></div>' +
            '<div class="flow-row"><span class="arrow">↓ 在 scope 里</span></div>' +
            '<div class="flow-row"><span class="blk" id="ap">App 进程</span>' +
              '<span class="arrow">→</span><span class="blk" id="hn">handleLoadPackage 被调用</span></div>' +
            '<div class="flow-row" style="margin-top:6px;padding-top:10px;border-top:1px dashed var(--line)">' +
              '<span class="pill bad" id="tip2">点"单步"开始</span></div>' +
          '</div>',
        reset: () => {
          ['m1','z1','r1','lg','sc','ap','hn'].forEach(i => S(i, ''));
          CLS('tip2', 'pill bad');
          SET('tip2', '点"单步"开始');
        },
        steps: [
          { run: () => S('m1', 'active'),
            note: '<b>Magisk 是地基。</b>它改的是 boot 镜像的 ramdisk，在 <code>init</code> 极早期拿到控制权，' +
                  '再用 magic mount 做 systemless 修改（第 18 章详细讲过）。<br>' +
                  '关键结论：<b>LSPosed 自己的能力是从这里借来的</b>——它不是自己会注入，而是站在 Magisk 的肩膀上。' },
          { run: () => { S('m1', 'done'); S('z1', 'active'); },
            note: '<b>Zygisk：Magisk 自带的 Zygote 注入机制。</b>官方 README 要求 Magisk v24+，正是 Zygisk 出现在这个版本之后。' },
          { run: () => { S('z1', 'done'); S('r1', 'active'); },
            note: '<b>Riru：另一条路，第三方 zygote 注入模块。</b>LSPosed 的 README 把它列在 Credits 里：' +
                  '<code>Riru: provides a way to inject code into zygote process</code>。<br>' +
                  '两条路殊途同归，都是为了同一件事：<b>在 Zygote 里插一脚</b>。' },
          { run: () => { S('r1', 'done'); S('lg', 'cool'); },
            note: '<b>LSPosed 核心被加载进 Zygote。</b>到这里，环境已经被改造完毕——' +
                  '但此刻还没有任何 App 进程存在。' },
          { run: () => { S('lg', 'done'); S('sc', 'active'); },
            note: '<b>App 进程 fork 出来，第一道闸门是作用域。</b>不在 scope 里的 App，模块对它等于不存在。<br>' +
                  '<span class="pill warn">待核实</span>：这一步的实现细节（是"不注入"还是"注入但跳过回调"）随版本与 flavor 而异，' +
                  '但<b>语义</b>是确定的：scope 决定这个进程里你的代码会不会被唤醒。' },
          { run: () => { S('sc', 'done'); S('ap', 'active'); },
            note: '<b>进了 scope 的 App 进程继续启动。</b>注意此时 App 的 Java 代码一行都还没跑——' +
                  '你的模块比它<b>更早</b>就在场了。' },
          { run: () => { S('ap', 'done'); S('hn', 'active'); CLS('tip2', 'pill ok'); SET('tip2', '✅ 模块生效：handleLoadPackage 在你的目标进程里被调用'); },
            note: '<b>handleLoadPackage 被调用，模块正式接管。</b><br>' +
                  '排错时按这条链倒着回查最快：<b>Magisk 装了吗 → flavor 装了吗 → LSPosed 激活了吗 → 模块开关开了吗 → ' +
                  '这个 App 勾进 scope 了吗 → 进程名对得上吗</b>。' }
        ]
      },
      quiz: {
        id: 'q22-1', chapter: 22, answer: 0,
        stem: '你装好 LSPosed 和模块，重启后打开目标 App，模块里的日志一行都没有。按本章的排查顺序，<b>最应该先确认</b>的是？',
        options: [
          { t: '目标 App 有没有被勾进这个模块的作用域（scope），以及进程名是否匹配',
            why: '正确。这是"模块完全没被唤醒"的第一嫌疑，而且验证成本最低。' },
          { t: '升级 LSPosed 到最新版', why: '版本问题通常表现为行为异常或崩溃，而不是"静默地一行日志都没有"。' },
          { t: '把 hook 改到更早的时机（比如 IXposedHookZygoteInit 里）',
            why: '时机错会导致 findClass 失败，但你至少会看到 handleLoadPackage 的入口日志。什么都看不到，说明根本没被调用。' },
          { t: '怀疑目标 App 检测到了 LSPosed 并主动退出了模块',
            why: '这是可能的，但它是"更复杂的解释"。检测通常伴随闪退或异常行为，而不是安静地什么都不发生。' }
        ],
        explain: '<b>排查顺序的关键是"先排除最便宜、最可能的解释"。</b><br><br>' +
          '模块完全没反应，最常见的三个原因是：<br>' +
          '① <b>作用域没勾</b>（LSPosed 里每个模块都要逐个挑 App）——最常见；<br>' +
          '② <b>进程名不匹配</b>：你以为在 hook 主进程，其实日志写在 <code>:push</code> 之类的子进程里，' +
          '或者判断条件写的是 <code>packageName</code> 而目标只在特定进程加载模块；<br>' +
          '③ 模块开关根本没打开（装完忘了启用）。<br><br>' +
          '这三条都能在两分钟内验证。相比之下"升级版本""改时机""怀疑被检测"要么成本高，要么与现象不符。' +
          '<span class="hit">排错的一般原则：先用最便宜的检查排除最高频的原因。</span>'
      }
    },

    /* ============================================================ 22.3 */
    {
      h: '22.3', title: '模块最小骨架：入口、声明、元数据',
      html:
        '<p>一个能跑的 Xposed 模块只需要三样东西：<b>一个入口声明文件</b>、<b>一个实现入口接口的类</b>、' +
        '<b>目标方法上的 hook 回调</b>。下面这张推演器把它从"APK 装好"到"hook 真的生效"走一遍。</p>' +
        '<p>其中的入口文件名与内容不是编的——<code>assets/xposed_init</code> 里只写一行全限定类名，' +
        '可以对照 22.8C 要讲的 JDex2 项目：它的 <code>assets/xposed_init</code> 内容就是 <code>com.jsnow.jdex2.JSHook</code>。</p>' +
        '<h3 style="margin-top:26px">XC_MethodHook 与 XC_MethodReplacement：先想清楚你要不要原逻辑</h3>' +
        '<p>挂 hook 时要在两个基类之间选一个。这个选择不是风格问题，它决定<b>原方法体内的副作用还在不在</b>。</p>' +
        T.tbl(['', 'XC_MethodHook', 'XC_MethodReplacement'],
          [
            ['<b>语义</b>', '在原方法<b>前后</b>插入你的代码，原方法体<b>仍然会执行</b>',
             '原方法体<b>不再执行</b>，完全由你的实现替代'],
            ['<b>重写哪个方法</b>', '<code>beforeHookedMethod</code> / <code>afterHookedMethod</code>',
             '<code>replaceHookedMethod</code>'],
            ['<b>适合</b>', '观测、改参数、改返回值、按条件放行——绝大多数需求',
             '彻底替换逻辑（例如强制返回固定值、让校验函数永远通过）'],
            ['<b>风险</b>', '较低：原有副作用（写文件、发请求、初始化状态）照常发生',
             '<b>高</b>：原方法里的副作用<b>全部消失</b>。你替换掉的可能不只是返回值，还有它顺手做的事'],
            ['<b>一个常被忽略的点</b>',
             '用 <code>param.setResult(x)</code> 也能"短路"，此时原方法<b>不会执行</b>（除非你调用 backup）——' +
             '它的行为已经很接近 Replacement，但代码意图更明确',
             '如果你只是想让某个校验返回 true，用 Replacement 更直白；但请先确认它没有"必须发生的副作用"']
          ]) +
        T.note('bad', '🔥 一个很容易踩的坑',
          '<p style="margin-bottom:0">很多人为了"让校验通过"直接上 <code>XC_MethodReplacement</code>，' +
          '结果 App 崩在别处——因为那个校验函数同时负责给某个字段赋值、或者顺手注册了回调。<br>' +
          '<b>替换掉一个函数，等于删掉了它所有的副作用。</b>判断标准很简单：' +
          '你只需要它的<b>结果</b>不同 → 用 <code>setResult</code> 或 Replacement；' +
          '你需要它的<b>副作用照常发生</b>、只要结果不同 → 用 <code>setResult</code>；' +
          '你需要它<b>什么都没发生</b> → 才用 Replacement。</p>'),
      stepper: {
        title: '从模块安装到 hook 生效：九步推演',
        lines: [
          {
            code: '<span class="c">// assets/xposed_init（整个文件只有一行）</span>\ncom.jsnow.jdex2.JSHook',
            note: '<b>第一步：入口声明。</b>框架读完这个文件，才知道该去加载哪个类当入口。<br>' +
                  '它只是一个"名字清单"，不是配置——所以写错类名不会有语法错误，只会静默失效。',
            state: { '阶段': '① 声明入口', '文件': 'assets/xposed_init', '内容': '一行全限定类名' }
          },
          {
            code: '<span class="c">&lt;!-- AndroidManifest.xml --&gt;</span>\n&lt;meta-data android:name=<span class="s">"xposedmodule"</span> android:value=<span class="s">"true"</span> /&gt;\n' +
                  '&lt;meta-data android:name=<span class="s">"xposeddescription"</span> android:value=<span class="s">"..."</span> /&gt;\n' +
                  '&lt;meta-data android:name=<span class="s">"xposedminversion"</span> android:value=<span class="s">"..."</span> /&gt;',
            note: '<b>第二步：让系统把 APK 认成"模块"而不是普通 App。</b>' +
                  '这几个 meta-data（<code>xposedmodule</code> / <code>xposeddescription</code> / <code>xposedminversion</code>）' +
                  '是传统 Xposed 的写法。<br>' +
                  '<span class="pill warn">待核实</span>：新版 LSPosed 的现代 API（libxposed）改用 ' +
                  '<code>META-INF/xposed/module.prop</code> 之类的替代方案（22.13 会逐条列出官方差异），' +
                  '两套写法在过渡期的兼容边界请以官方 wiki 为准。',
            state: { '阶段': '② 元数据', '作用': '被识别为模块', '现代 API': '写法不同（见 22.13）' }
          },
          {
            code: '<span class="k">public class</span> <span class="f">JSHook</span> <span class="k">implements</span> IXposedHookLoadPackage {',
            note: '<b>第三步：实现入口接口。</b><code>IXposedHookLoadPackage</code> 的语义是' +
                  '"<b>每个 App 进程加载时给我一次机会</b>"——注意是每个进程，而不仅是主进程。',
            state: { '阶段': '③ 入口类', '接口': 'IXposedHookLoadPackage', '触发次数': '每个进程各一次' }
          },
          {
            code: '<span class="k">public void</span> <span class="f">handleLoadPackage</span>(XC_LoadPackage.LoadPackageParam lpparam) {',
            note: '<b>第四步：拿到 LoadPackageParam。</b>它是你和这个 App 进程之间唯一的握手信息，' +
                  '里面有 <code>packageName</code>、<code>processName</code>、<code>classLoader</code>、<code>appInfo</code>。<br>' +
                  '<span class="hit">把它当成"入场券"：所有后续动作都要从它身上找钥匙。</span>',
            state: { '阶段': '④ 拿到参数', '进程名': ':remote 还是主进程？', 'classLoader': '可能还不是最终的那个' }
          },
          {
            code: '  <span class="k">if</span> (!lpparam.packageName.<span class="f">equals</span>(<span class="s">"com.target.app"</span>)) <span class="k">return</span>;',
            note: '<b>第五步：先筛，再动手。</b>作用域已经过滤过一轮，但同一台设备上跑着几十个 App，' +
                  '你的代码在每一个 scope 内的进程里都会被执行——所以自己也要判一次。<br>' +
                  '实战中建议同时判 <code>processName</code>：很多 App 有 <code>:push</code>、<code>:remote</code> 等子进程，' +
                  '在里面重复初始化会让你看到双份日志，甚至双份崩溃。',
            state: { '阶段': '⑤ 过滤目标', '判断项': 'packageName', '建议': '同时判 processName' }
          },
          {
            code: '  <span class="f">XposedHelpers.findAndHookMethod</span>(<span class="s">"com.target.Crypto"</span>, lpparam.classLoader,\n' +
                  '      <span class="s">"encrypt"</span>, String.class, <span class="k">new</span> XC_MethodHook() { ... });',
            note: '<b>第六步：按"类名 + 方法名 + 参数类型表"定位方法并挂上回调。</b><br>' +
                  '注意这三个定位要素<b>缺一不可</b>：Java 有重载，只给方法名无法唯一确定目标。' +
                  '参数类型写错（或写成了父类/包装类）会变成"方法找不到"，而不是"挂错了"——这是下一节要讲的坑。',
            state: { '阶段': '⑥ 挂 hook', '定位三要素': '类名 / 方法名 / 参数类型', 'classLoader': '决定能不能找到类' }
          },
          {
            code: '    <span class="k">protected void</span> <span class="f">beforeHookedMethod</span>(MethodHookParam param) {\n' +
                  '      <span class="c">// param.args[0] 就是调用方传进来的第一个参数</span>\n' +
                  '    }',
            note: '<b>第七步：before。</b>此刻<b>原方法还没执行</b>。<br>' +
                  '想看"调用方到底传了什么"，只能在这里取——这是 22.6 里"参数已经变了"那个症状的根因。',
            state: { '阶段': '⑦ 拦截（前）', 'param.args': '原始入参', '原方法': '尚未执行' }
          },
          {
            code: '    <span class="k">protected void</span> <span class="f">afterHookedMethod</span>(MethodHookParam param) {\n' +
                  '      Object result = param.<span class="f">getResult</span>();   <span class="c">// 或 param.setResult(...)</span>\n' +
                  '    }',
            note: '<b>第八步：after。</b>此刻原方法已经跑完，<b>对象状态、字段、缓存都已经定型</b>。<br>' +
                  '读初始状态、读返回值、读被改写过的字段，都在这一侧。',
            state: { '阶段': '⑧ 拦截（后）', 'param.getResult()': '返回值', '对象状态': '已定型' }
          },
          {
            code: '<span class="f">XposedBridge.log</span>(<span class="s">"[JDex2] hooked: "</span> + param.method);',
            note: '<b>第九步：把动作留痕。</b>没有日志的 hook 等于没有 hook——你无法区分"没生效"和"生效了但结果一样"。<br>' +
                  '实战习惯：给自己的日志一个独立 TAG，用 <code>adb logcat -s 你的TAG</code> 单独看，' +
                  '否则会被系统日志淹掉。',
            state: { '阶段': '✅ 生效', '可观测': 'logcat', '下一步': '验证参数与返回值是否符合预期' }
          }
        ]
      },
      after: T.note('warn', '⚠️ 另一个入口：IXposedHookZygoteInit，别用错',
        '<p>除了 <code>IXposedHookLoadPackage</code>，还有 <code>IXposedHookZygoteInit</code>（' +
        '<code>initZygote(StartupParam)</code>）。它的调用时机是 <b>zygote 启动时、一次</b>，' +
        '那时<b>还没有 App 进程、没有包名、也没有 App 的 classLoader</b>。</p>' +
        '<p style="margin-bottom:0">分工很清楚：<b>改系统框架级行为 → initZygote；改某个 App 的行为 → handleLoadPackage。</b><br>' +
        '实战里 95% 以上的工作属于后者。如果你在 <code>initZygote</code> 里试图 <code>findClass</code> 一个 App 的业务类，' +
        '它必然失败——因为那个类此刻还不存在。</p>')
    },

    /* ============================================================ 22.4 */
    {
      h: '22.4', title: 'Hook 构造函数：对象状态在构造时定型',
      intuition: {
        tag: '直觉模型 · 毛坯房与验房',
        body:
          '<p>构造函数就像装修。你在<b>装修过程中</b>推门进去看（before），看到的永远是毛坯——墙没刷、家具没进；' +
          '只有在<b>装修结束</b>之后进去（after），才看得到这间房子最终长什么样。</p>' +
          '<p>而 Java 对象几乎所有的"重要状态"——校验结果、密钥、token、设备指纹——都是在这段装修里定型的。' +
          '等你 hook 到业务方法时，你看到的是<b>已经刷好墙的房子</b>；很多值一旦算完就不可逆了' +
          '（比如 hash、签名、密文），你只能看着结果，看不到原料。</p>' +
          '<p>所以构造函数不是"顺便 hook 一下"的地方，它是<b>唯一能同时看到"从无到有"前后两侧</b>的地方。</p>'
      },
      html:
        '<p>它也是新手最容易漏掉的 hook 点，原因很实在：<b>构造函数在字节码里叫 <code>&lt;init&gt;</code>，在源码里没有名字。</b>' +
        '任何"按方法名搜索"的习惯都会把它漏掉。而在 Xposed 里挂它，要用专门的方式。</p>' +
        T.tbl(['', '<code>XposedBridge.hookAllConstructors</code>', '逐个 <code>getDeclaredConstructors</code> + <code>hookMethod</code>'],
          [
            ['<b>语义</b>', '把一个类的<b>所有</b>构造函数都挂上同一个回调', '只挂你指定的那一个签名'],
            ['<b>优点</b>', '快、不会漏。只要类被 <code>new</code>，你一定知道',
             '回调干净，不碰你无关的重载；日志不会互相淹没'],
            ['<b>缺点</b>', '类里每个重载都会走你的回调；有 10 个重载你就要判断 10 次',
             '要自己枚举签名，写错一个就<b>静默漏掉</b>（不会报错）'],
            ['<b>什么时候用</b>', '<b>摸底阶段</b>：先全部挂上，在回调里打印 <code>param.method</code> 把所有重载列出来',
             '<b>收敛阶段</b>：确认是哪一个之后，只挂它，准备长期运行']
          ]) +
        T.note('key', '🔑 初始化的黄金位置是 after，不是 before',
          '<p>在 <code>afterHookedMethod</code> 里，对象已经构造完成、字段已经赋值。你要做的三件事都该放在这里：</p>' +
          '<p>① <b>把初始状态记下来</b>——之后才知道它被谁改过、改成了什么；<br>' +
          '② <b>挂后续的 hook</b>——此时对象内部引用已经有效，不会 hook 到"半个对象"；<br>' +
          '③ <b>打上"已处理"标记</b>——同一个构造函数可能被调用很多次（ListView 的 item、每次请求的实体），' +
          '不标记就会重复处理。</p>' +
          '<p style="margin-bottom:0">反过来，在 <code>before</code> 里读字段读到的 null/0，' +
          '不是"没有值"，是"还没轮到赋值"——这是 22.5 和实验一里会反复考的一点。</p>') +
        '<h3 style="margin-top:26px">一个真实工程里的构造函数用法：堵住它，而不是观察它</h3>' +
        '<p>下面这段取自 JDex2 的 <code>JSHook.java</code>（22.8C 的案例主角）。它挂构造函数的目的' +
        '<b>不是观察，而是触发</b>——请对照第 2 章 FART 的主动调用一起看。</p>' +
        T.code(
          '<span class="c">// 一个共享的 hook 实例：把构造函数"堵住"，让它不发生真实的构造</span>\n' +
          '<span class="k">private static final</span> XC_MethodHook BLOCK_CONSTRUCTOR = <span class="k">new</span> XC_MethodHook() {\n' +
          '    <span class="f">@Override</span>\n' +
          '    <span class="k">protected void</span> <span class="f">beforeHookedMethod</span>(MethodHookParam param) {\n' +
          '        param.<span class="f">setResult</span>(<span class="k">null</span>);   <span class="c">// 构造方法返回 void，用 null</span>\n' +
          '    }\n' +
          '};\n\n' +
          '<span class="c">// 只挂第一个构造函数，然后立刻调用它，最后立刻解除 hook</span>\n' +
          'Constructor&lt;?&gt; target = constructors[<span class="n">0</span>];\n' +
          'target.<span class="f">setAccessible</span>(<span class="k">true</span>);\n' +
          'XC_MethodHook.Unhook unhook = XposedBridge.<span class="f">hookMethod</span>(target, BLOCK_CONSTRUCTOR);\n' +
          '<span class="k">try</span> {\n' +
          '    Object[] args = <span class="f">makeDefaultArgs</span>(target.<span class="f">getParameterTypes</span>());\n' +
          '    target.<span class="f">newInstance</span>(args);   <span class="c">// 调用构造方法，触发壳对方法体的回填</span>\n' +
          '} <span class="k">catch</span> (Throwable ignored) {\n' +
          '} <span class="k">finally</span> {\n' +
          '    <span class="c">// 为了防止某些加固通过检测方法是否转为Native方法来检测Hook，无论构造是否成功都要解除Hook</span>\n' +
          '    unhook.<span class="f">unhook</span>();\n' +
          '}'
        ) +
        T.note('key', '🔑 这段代码里有三层信息量',
          '<p>① <b>它的目的不是观察构造函数，而是让构造函数跑一遍。</b>' +
          '真正想要的是<b>副作用</b>——壳在方法被使用时才把字节码回填进去。' +
          '这与第 2 章 FART 用默认参数狂调一遍是同一种思想，只是从 ART 层搬到了 Java 反射层。</p>' +
          '<p>② <b>用 <code>before</code> + <code>setResult(null)</code> 把构造体堵住</b>，' +
          '是为了不真的创建对象（避免真实副作用和崩溃），同时仍然触发"调用发生过"这个事实。' +
          '想清楚这一点，你就同时理解了 <code>XC_MethodHook</code> 里 <code>setResult</code> 的短路语义。</p>' +
          '<p style="margin-bottom:0">③ <b><code>finally</code> 里立刻 <code>unhook()</code>——因为 hook 本身就是痕迹。</b>' +
          '作者在注释里写的原因很具体：某些加固会检查"这个方法是不是被转成了 native"。' +
          '这一句把 22.4 和 22.11 连起来了：<b>你的观测手段，本身就是对手的检测项。</b></p>') +
        '<p>再补一条实战经验：如果你要观察的是<b>真实对象</b>（而不是触发回填），' +
        '请在 <code>after</code> 里读字段，并且<b>只在第一次构造时做初始化</b>——' +
        '用 <code>param.thisObject</code> 做 key 记一个标记，或者用 <code>setObjectExtra</code> / ' +
        '<code>getObjectExtra</code> 在同一个方法调用内部传递数据。</p>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '构造函数里的 null 字段',
            scenario: '<b>情境：</b>你 hook 了 <code>com.target.Session</code> 的构造函数，' +
              '在 <code>beforeHookedMethod</code> 里读 <code>param.thisObject</code> 的 <code>token</code> 字段，' +
              '打印出来是 <code>null</code>。你又换成在构造函数<b>之后</b>调用的业务方法里读，同一个字段却有值。',
            q: '在断定"对手把字段搬到 native 层了"之前，你<b>首先</b>该怀疑什么？',
            choices: [
              { t: '时机：<code>before</code> 时构造函数体还没执行，字段自然还是默认值；改到 <code>after</code> 再读即可验证',
                next: 'n1' },
              { t: '加固把这两个字段搬到了 native 层，Java 侧只剩空壳字段', next: 'n2' },
              { t: '混淆把字段名改掉了，所以反射读不到（读到的是另一个字段）', next: 'n3' },
              { t: '字段被声明成 <code>final</code> 或静态，反射读法用错了', next: 'n4' }
            ]
          },
          n1: {
            terminal: true, verdict: 'good', verdictTitle: '对：先证明时机，再怀疑对抗',
            result: '<p><b>你选的是成本最低、也最可能正确的解释。</b><br>' +
              '<code>beforeHookedMethod</code> 的字面语义就是"<b>在原方法体执行之前</b>"。' +
              '构造函数里的赋值语句都在方法体里，所以此刻字段当然是默认值（引用类型为 null，int 为 0，boolean 为 false）。<br>' +
              '验证只要一步：把读取改到 <code>afterHookedMethod</code>，看值有没有出现。<br>' +
              '<span class="hit">顺带记住这个诊断手法：<b>同一个字段在 before / after 各打一次日志，' +
              '就能看出它是什么时候被赋值的</b>——比反编译找赋值语句快得多。</span></p>'
          },
          n2: {
            terminal: true, verdict: 'bad', verdictTitle: '你跳到了最复杂的解释',
            result: '<p><b>认知根源：遇到异常先怀疑对手，而不是先怀疑自己的观测点。</b><br>' +
              '"字段被搬到 native 层"确实存在（那是更强的保护），但它有明确的伴随特征：' +
              '字段在<b>整个生命周期内</b>都不可见（因为 Java 侧根本没有真实数据），' +
              '而不只是"在 before 时不可见"。<br>' +
              '你的现象是"after 之后就有值了"——这恰恰证明数据<b>就在这个 Java 字段里</b>，只是赋值发生在方法体中段。<br>' +
              '<span class="miss">先排除时机问题，再谈对抗强度。顺序反了，你会花一整天去做毫无必要的对抗分析。</span></p>'
          },
          n3: {
            terminal: true, verdict: 'bad', verdictTitle: '混淆会改名，但不会变成 null',
            result: '<p><b>认知根源：你把"读不到"和"读到另一个字段"混为一谈了。</b><br>' +
              '如果字段被混淆改名，你用旧名字去 <code>getObjectField</code> 会<b>抛异常</b>（找不到该字段），' +
              '而不是安静地返回 null。既然你拿到了 null，说明你<b>确实读到了那个字段</b>。<br>' +
              '<span class="hit">这类"异常 vs 空值"的区别是一个很有用的信号：' +
              '<b>抛异常 = 你找的东西不存在；得到 null = 你找的东西存在但此刻没有值。</b></span><br>' +
              '当然，混淆确实会让字段名变成 <code>a</code>、<code>b</code>——那是另一个问题（22.5 讲怎么按类型和读写位置反推）。</p>'
          },
          n4: {
            terminal: true, verdict: 'bad', verdictTitle: '读法错误会抛异常，不会给你 null',
            result: '<p><b>认知根源：你没有把"反射失败"的两种形态分开。</b><br>' +
              '用错 API 的后果是明确的：拿实例字段当静态读（或反过来）会抛异常；' +
              '用 <code>getObjectField</code> 读 <code>int</code> 字段也会失败，因为反射不做自动装箱。<br>' +
              '这些都不会安静地返回 null。<br>' +
              '<span class="hit">所以当你<b>确切地</b>拿到 null 时，最可能的解释就是"值还没被赋上"——' +
              '而这几乎是 <code>before</code> 时机的必然结果。</span></p>'
          }
        }
      },
      quiz: {
        id: 'q22-2', chapter: 22, answer: 0,
        stem: '为什么说构造函数是"最容易被漏掉、但价值很高"的 hook 点？',
        options: [
          { t: '它在字节码里叫 <code>&lt;init&gt;</code>、源码里没有名字，按方法名搜索会漏；' +
               '而对象的关键状态基本都在这段代码里定型',
            why: '正确。两个理由都说到：定位困难 + 状态在此定型。' },
          { t: '因为构造函数执行得最早，所以能拿到最完整的调用栈',
            why: '构造函数通常不是最早的调用，也未必有更完整的调用栈。这不是它的价值所在。' },
          { t: '因为构造函数不能被打断，hook 它最稳定',
            why: '恰恰相反：hook 构造函数很容易造成对象处于半初始化状态，风险不低。' },
          { t: '因为只有构造函数里的参数是明文，业务方法里的参数都是加密的',
            why: '这是想当然。是否明文取决于业务逻辑，与是不是构造函数无关。' }
        ],
        explain: '<b>两个层次的原因，缺一不可。</b><br><br>' +
          '<b>定位层面：</b>构造函数在字节码里是 <code>&lt;init&gt;</code>，源码里没有方法名。' +
          '任何"按名字 find"的思路都会漏掉它；在 Xposed 里要用 <code>hookAllConstructors</code> ' +
          '或 <code>findAndHookConstructor</code>（按参数类型定位，而不是按名字）。<br><br>' +
          '<b>价值层面：</b>对象的状态在构造时定型。校验结果、密钥、token、设备指纹这些' +
          '"你最想要的东西"，往往在构造函数里就已经算好了。等你在业务方法里看到它们时，' +
          '你看到的是<b>成品</b>；而在构造函数前后两侧，你能看到<b>从无到有的过程</b>——' +
          '很多不可逆的值（hash、签名）只有在这一刻才有机会看到原料。<br><br>' +
          '<span class="hit">记住这个组合判断：<b>按参数类型找构造函数，在 after 里读定型后的状态。</b></span>'
      }
    },

    /* ============================================================ 22.5 */
    {
      h: '22.5', title: 'Hook 常规函数与修改属性：XposedHelpers 家族',
      html:
        '<p>把 <code>XposedHelpers</code> 当成你的"反射工具箱"。它做的事情本质上都是 Java 反射，' +
        '只是把样板代码收掉了。<b>记住这一点很重要</b>：因为它是反射，所以它的失败方式和反射一模一样——' +
        '而反射的失败方式，和 Frida 那种"脚本层找不到符号"的失败方式并不相同。</p>' +
        T.tbl(['API', '干什么', '最常见的失败'],
          [
            ['<code>findAndHookMethod</code>', '按"类 + 方法名 + <b>参数类型表</b>"定位并挂 hook', '类找不到、<b>参数类型表不匹配</b>'],
            ['<code>findAndHookConstructor</code>', '按参数类型表挂构造函数', '同上（没有方法名可依赖）'],
            ['<code>findClass</code>', '按类名 + 指定加载器加载类', '<b>加载器不对</b> → <code>ClassNotFound</code>'],
            ['<code>getObjectField</code> / <code>setObjectField</code>', '读 / 写<b>实例</b>的引用类型字段', '字段名混淆；把实例当静态用'],
            ['<code>getStaticObjectField</code> / <code>setStaticObjectField</code>', '读 / 写<b>静态</b>引用类型字段', '静态当实例用（会抛异常）'],
            ['<code>getIntField</code> / <code>setIntField</code> 等', '基本类型字段的专用读写', '用 <code>getObjectField</code> 读基本类型会失败'],
            ['<code>callMethod</code> / <code>callStaticMethod</code>', '调用实例 / 静态方法（含私有）', '重载 + null 参数歧义；参数类型不匹配'],
            ['<code>newInstance</code>', '造一个对象', '找不到匹配的构造签名；<b>抽象类与接口直接失败</b>']
          ]) +
        '<h3 style="margin-top:26px">静态字段与实例字段：不只是 API 不同</h3>' +
        T.tbl(['', '静态字段', '实例字段'],
          [
            ['<b>属于谁</b>', '属于 <code>Class</code> 对象，一个进程里只有一份', '属于具体的对象实例'],
            ['<b>用什么读</b>', '<code>getStaticObjectField(clazz, "X")</code>', '<code>getObjectField(obj, "X")</code>'],
            ['<b>在哪儿被赋值</b>', '类初始化 <code>&lt;clinit&gt;</code> 里（类第一次被使用时）', '构造函数或后续的赋值语句里'],
            ['<b>改它的影响面</b>', '<b>全局</b>：一次修改对所有实例、所有后续逻辑生效', '只影响你手上那个对象'],
            ['<b>实战取舍</b>', '适合"一次性关掉某个全局开关"；但风险也全局，改错了整条链路都受影响',
             '适合精确干预单个对象的状态；缺点是对象一多就要逐个处理']
          ]) +
        T.note('bad', '🔥 时机太早：你读到的不是"值为空"，而是"还没轮到它"',
          '<p>这是新手最常见的误判来源。同一个字段，在不同的 hook 点看到的值完全不同：</p>' +
          '<p>· 静态字段在 <code>&lt;clinit&gt;</code> 里赋值 → 你在类加载早期读，它是 null/0；<br>' +
          '· 实例字段在构造函数里赋值 → 你在构造函数的 <code>before</code> 读，它还是默认值；<br>' +
          '· 有些字段是<b>懒加载</b>的（第一次用到才算）→ 你在任何"还没用到它"的时刻读，都是 null。</p>' +
          '<p style="margin-bottom:0"><b>判断手法（最省事的一种）：</b>在同一个 hook 的 before 和 after 各打一行日志，' +
          '把字段值都打出来。值在<b>哪一侧</b>出现，就说明赋值发生在中间。' +
          '<span class="hit">这比反编译去翻赋值语句快得多，而且在混淆过的代码上同样有效。</span></p>') +
        '<p>字段名被混淆是另一个现实问题。Xposed 这一层你面对的是 Java 反射，' +
        '所以字段名变成 <code>a</code>、<code>b</code>、<code>c</code> 之后，' +
        '你要靠<b>类型 + 谁在读它 + 和谁一起出现</b>来反推——而不是靠名字猜。' +
        '（顺带说明：混淆器也可能删掉"看起来没人用"的字段，' +
        '具体行为取决于混淆配置，<span class="pill warn">待核实</span>；遇到字段不存在时先确认它是不是被删了，' +
        '而不是认定自己被检测了。）</p>' +
        '<p>下面这个推演器把 <code>findAndHookMethod</code> 的内部动作拆开。' +
        '它的价值在于：<b>失败点几乎全在"参数类型表"上</b>，而这一点很多人从没意识到。</p>',
      stepper: {
        title: '一次 findAndHookMethod 的解析过程（失败点在哪）',
        lines: [
          {
            code: '<span class="f">XposedHelpers.findAndHookMethod</span>(\n' +
                  '    <span class="s">"com.target.Crypto"</span>, lpparam.classLoader,\n' +
                  '    <span class="s">"encode"</span>, String.class, callback);',
            note: '<b>三个定位要素：类名、方法名、参数类型表。</b>Java 有重载，所以"方法名"单独一个是不够的。<br>' +
                  '注意第二个参数是<b>加载器</b>——它决定了第一步能不能找到类。',
            state: { '阶段': '① 调用', '目标类': 'com.target.Crypto', '方法': 'encode(String)' }
          },
          {
            code: '<span class="c">// 内部：用传入的 loader 加载这个类</span>',
            note: '<b>失败点 A：类加载失败。</b>抛 <code>ClassNotFoundException</code>。<br>' +
                  '两种原因：类名写错（拼写、内部类要用 <code>$</code>），或者<b>加载器不对</b>——' +
                  '这在加固 App 上更常见（见 22.8）。',
            state: { '阶段': '② 加载类', '失败信号': 'ClassNotFoundException', '对策': '换对的加载器' }
          },
          {
            code: '<span class="c">// 内部：遍历 clazz.getDeclaredMethods() 找名字匹配的候选</span>',
            note: '<b>失败点 B：一个候选都没有。</b>方法是存在的，但名字对不上——' +
                  '要么被混淆改成了 <code>a</code>，要么你抄错了。<br>' +
                  '排查：把 <code>getDeclaredMethods()</code> 全部打印一遍，对着参数类型找，不要对着名字找。',
            state: { '阶段': '③ 找名字', '候选数': '0（失败）', '对策': '打印全部方法列表' }
          },
          {
            code: '<span class="c">// 内部：逐个比对参数类型表 { String.class }</span>',
            note: '<b>失败点 C：这是最常见的坑，也是本节的核心。</b>遍历到了同名方法，但参数类型对不上：<br>' +
                  '· 目标其实是 <code>(CharSequence)</code> 或 <code>(Object)</code>，你写了 <code>String.class</code>；<br>' +
                  '· 目标有多个参数，你只写了一个；<br>' +
                  '· <b>基本类型必须写 <code>int.class</code>，不能写 <code>Integer.class</code></b>（反之亦然）；<br>' +
                  '· 变长参数在签名层面是数组：<code>Object[].class</code>。',
            state: { '阶段': '④ 比类型', '失败信号': '找不到匹配的方法', '对策': '打印真实参数类型' }
          },
          {
            code: '<span class="c">// 命中唯一候选 → 交给 XposedBridge.hookMethod 安装</span>',
            note: '<b>命中。</b>如果同名方法有多个重载，你要自己想清楚挂哪一个——' +
                  '用 <code>findMethodExact</code> 先把具体的 <code>Method</code> 拿到，再 <code>hookMethod</code>，可控性更好。',
            state: { '阶段': '⑤ 安装 hook', '方式': 'XposedBridge.hookMethod', '备选': 'findMethodExact + hookMethod' }
          },
          {
            code: '<span class="c">// 框架侧：把被 hook 方法的入口替换掉</span>',
            note: '<b>框架在 ART 层做的事。</b>LSPosed 用它的核心 hook 框架（LSPlant）替换方法入口，' +
                  '这一步在 Java 层完全不可见。<br>' +
                  '<span class="hit">记住它的存在：22.11 里"方法入口被替换"就是一条检测项，源头就在这里。</span>',
            state: { '阶段': '⑥ ART 层生效', '可见性': 'Java 层看不到', '检测面': '见 22.11' }
          },
          {
            code: '<span class="c">// 之后：方法被调用</span>\n' +
                  'beforeHookedMethod(param)  →  <span class="c">原方法体</span>  →  afterHookedMethod(param)',
            note: '<b>回调链。</b>before 里 <code>param.args</code> 是原始入参；after 里 ' +
                  '<code>param.getResult()</code> 是返回值，也可以用 <code>param.setResult(...)</code> 改掉它。<br>' +
                  '两侧的 <code>param.thisObject</code> 是同一个对象——所以你可以用 before 记下状态、在 after 对比。',
            state: { '阶段': '⑦ 运行期', 'before': '入参 / 对象状态', 'after': '返回值 / 定型后的字段' }
          }
        ]
      },
    },

    /* ============================================================ 22.6 */
    {
      h: '22.6', title: '主动调用：从"被动拦截"到"主动驱动"',
      html:
        '<p>前面的 hook 都是被动的：等 App 自己调用，你拦下来看看。主动调用是反过来——' +
        '<b>你发起调用，让 App 的代码替你干活</b>。</p>' +
        T.tbl(['', '被动 hook', '主动调用（Invoke）'],
          [
            ['<b>谁发起</b>', 'App 自己调，你只是拦截', '<b>你发起</b>，App 的代码被动执行'],
            ['<b>时机可控性</b>', '不可控：要等它调；没被调到的分支你永远看不到', '可控：你说什么时候调'],
            ['<b>典型用途</b>', '观测、改参数、改返回值', '脱壳触发回填（第 2 章 FART、22.8C 的 JDex2）、' +
             '验证算法、批量跑输入、探测方法行为'],
            ['<b>主要成本</b>', '覆盖不全', '参数要自己造、副作用不可控、容易崩'],
            ['<b>返回值</b>', '顺带就有了', '常常只是"顺手的副产品"——真正的收获是<b>调用发生过</b>']
          ]) +
        '<p>三个 API 记住就够：<code>callStaticMethod</code>（调静态）、' +
        '<code>callMethod</code>（调实例，需要先有对象）、<code>newInstance</code>（造对象）。' +
        '它们的参数都是 <code>Object...</code>，所以基本类型会自动装箱。</p>' +
        T.note('warn', '⚠️ 装箱带来的一个真实歧义',
          '<p>传 <code>null</code> 给一个重载方法时，类型信息是<b>缺失的</b>——' +
          '框架不知道你要匹配 <code>foo(String)</code> 还是 <code>foo(List)</code>，于是可能匹配失败，' +
          '也可能匹配到<b>不是你想要的那个</b>重载。</p>' +
          '<p style="margin-bottom:0">对策：优先让参数带上明确的类型（哪怕是 <code>(Object) null</code> 这种显式写法），' +
          '或者干脆先 <code>findMethodExact</code> 拿到具体 <code>Method</code> 对象再 <code>invoke</code>，' +
          '把匹配这件事变成显式的。</p>') +
        '<h3 style="margin-top:26px">调用失败了，按这个顺序查</h3>' +
        '<p>主动调用失败是常态（尤其批量调用）。<b>排查顺序本身就是本节最重要的知识点</b>——' +
        '它决定了你是十分钟定位，还是查一天。</p>' +
        '<ol>' +
        '<li><b>类加载器对不对。</b>信号：<code>ClassNotFoundException</code> / <code>NoClassDefFoundError</code>。<br>' +
        '先确认你用的 loader 到底认不认识这个类（22.8）。</li>' +
        '<li><b>方法名与签名对不对。</b>信号：<code>NoSuchMethodError</code> / <code>IllegalArgumentException</code>。<br>' +
        '重点查：重载、参数个数、<code>int.class</code> vs <code>Integer.class</code>、变长参数的数组形式。</li>' +
        '<li><b>调用时机对不对。</b>信号：拿到 <code>null</code>、<code>ExceptionInInitializerError</code>。<br>' +
        '类静态初始化还没跑、对象还没构造完、或者方法是懒加载的。</li>' +
        '<li><b>参数能不能构造出来。</b>信号：参数构造代码自己抛异常，或目标方法内部 NPE。<br>' +
        '这就是 22.7 要专门讲的问题。</li>' +
        '<li><b>目标方法有没有前置状态。</b>信号：业务异常，看起来像 App 的 bug。<br>' +
        '它可能需要先登录、先有 token、必须在主线程 / 必须有 Looper（JDex2 就用 ' +
        '<code>Handler(Looper.getMainLooper()).post(...)</code> 把某些调用丢回主线程）。</li>' +
        '<li><b>最后才怀疑"是不是被检测到了"。</b>信号：闪退、或者安静地什么都不发生。<br>' +
        '它排在最后不是因为不可能，而是因为它是<b>最贵</b>的解释——验证成本高，而且往往需要先排除前五条。</li>' +
        '</ol>' +
        T.note('key', '🔑 一条贯穿本章的判断',
          '<p style="margin-bottom:0">主动调用时，<b>返回值通常不是你要的东西。</b>' +
          '你要的是"这个方法被执行过"这个事实——它带来的副作用（回填字节码、初始化状态、写日志）才是收获。<br>' +
          '这与第 2 章 FART 用默认参数狂调一遍完全同构：<b>调用会失败，但失败不影响我们要的副作用。</b>' +
          '所以：<b>每一次主动调用都要独立 try/catch，绝不能因为第一个失败就中断整个流程</b>——' +
          '你需要的是"失败的完整清单"，而不是"第一个错误"。</p>'),
      quiz: {
        id: 'q22-4', chapter: 22, answer: 0,
        stem: '为什么说在主动调用里，"方法抛异常"往往<b>不是</b>失败信号？',
        options: [
          { t: '因为很多主动调用的目的是触发副作用（例如让壳回填字节码），传默认参数必然导致异常，而副作用已经发生',
            why: '正确。这是第 2 章 FART 与本章 JDex2 的共同逻辑。' },
          { t: '因为 Xposed 框架会吞掉所有异常，所以异常本来就不影响结果',
            why: '框架不会替你吞异常，是你自己必须写 try/catch。' },
          { t: '因为异常只影响返回值，不影响方法是否被执行', why: '方向对了但没说到点上：重点是"副作用"而非"执行"。' },
          { t: '因为主动调用本来就不需要返回值，所以异常无所谓',
            why: '"不需要返回值"和"异常不影响目标"是两件事，前者不推出后者。' }
        ],
        explain: '<b>关键区分：你要的是"调用发生"还是"调用成功"。</b><br><br>' +
          '主动调用的典型场景是<b>触发副作用</b>：<br>' +
          '· 第 2 章 FART 遍历所有方法并强制调用，传的是默认值（0、null、空串），' +
          '目的是让抽取壳把字节码回填进 <code>code_item</code>；<br>' +
          '· 22.8C 的 JDex2 主动调用构造函数，目的同样是触发回填——它甚至用 ' +
          '<code>before</code> + <code>setResult(null)</code> 把构造体<b>堵住</b>，<br>' +
          '为的就是"别真的构造对象，只要这次调用发生过"。<br><br>' +
          '在这两个例子里，参数是假的、返回值是错的、方法很可能抛异常——<b>但副作用已经产生了</b>，任务完成。<br><br>' +
          '<span class="hit">所以工程上的纪律是：<b>每次调用独立 try/catch；异常要记录但不能中断流程；' +
          '用"覆盖了多少个"而不是"成功了几个"来衡量进度。</b></span>'
      }
    },

    /* ============================================================ 22.7 */
    {
      h: '22.7', title: 'Java Hook 的复杂参数构造：与 Frida 的 $new 对照',
      html:
        '<p>如果你用过 Frida，第一反应一定会是：<b>Xposed 这边造参数怎么这么麻烦？</b>这个感受是对的，' +
        '但它不是能力差异，是<b>封装差异</b>——Frida 把 Java 反射包装成了 JS 语法糖，' +
        'Xposed 这边你就是直接写反射。</p>' +
        T.tbl(['需求', 'Frida', 'Xposed（直接写反射）'],
          [
            ['造一个对象', '<code>Java.use("A").$new(args)</code>',
             '<code>XposedHelpers.newInstance(A.class, args)</code>，或者 <code>clazz.newInstance()</code>（无参）'],
            ['造数组', "<code>Java.array('byte', [...])</code>",
             '<code>Array.newInstance(byte.class, n)</code> 再逐个 <code>Array.setByte</code>'],
            ['造接口 / 抽象类的实现', '<code>Java.registerClass({...})</code> 动态生成一个实现类',
             '<b>没有等价的一行 API</b>：只能找现成的实现类、用动态代理，或者自己生成 dex。' +
             '<span class="pill warn">待核实</span>：具体可用性与你的运行环境、依赖库有关'],
            ['造集合', '<code>Java.use("java.util.ArrayList").$new()</code>',
             '<code>newInstance(ArrayList.class)</code>，或者更省事：<code>Collections.emptyList()</code>'],
            ['泛型 <code>List&lt;String&gt;</code>', '运行时同样是擦除的',
             '同样擦除：反射拿不到 <code>String</code>。需要泛型信息只能读 <code>getGenericParameterTypes</code>，' +
             '或者靠经验判断'],
            ['给重载方法传 null', '需要显式转型，否则歧义',
             '同样的歧义：null 没有类型，匹配可能失败或匹配错']
          ]) +
        T.note('key', '🔑 一条省掉 80% 参数构造工作的判断',
          '<p>在"触发副作用"类的任务里（脱壳、探测、验证），<b>你几乎永远不需要构造真实参数</b>。</p>' +
          '<p>引用类型一律传 <code>null</code>，基本类型一律传 <code>0</code>/<code>false</code>——' +
          'JDex2 的 <code>makeDefaultArgs</code> 就是这么写的：遍历参数类型，' +
          '基本类型给零值，<b>其余一律给 null</b>，并在注释里说明了理由：' +
          '<i>对于引用类型，传入 null 是合法的（没必要再去构造对应类型参数）</i>。</p>' +
          '<p style="margin-bottom:0">只有当目标方法<b>真的需要</b>一个可用的参数（例如它内部会解引用这个参数）时，' +
          '你才需要去构造。这时候优先找"最简单能用的东西"：空集合、空字符串、App 里已经存在的实现类——' +
          '而不是自己从零造一个。</p>') +
        '<p>下面这个终端把"参数构造失败"的几种典型报错按顺序摆出来。' +
        '它的用处是让你看到：<b>同一个"调用失败"的现象，根因可能完全不同</b>——' +
        '而区分它们的成本，取决于你有没有先想清楚参数从哪来。</p>',
      term: {
        title: '参数构造失败时的典型报错（示意输出）',
        lines: [
          { t: 'd', s: '# 尝试一：类都找不到，和参数无关' },
          { t: 'e', s: 'java.lang.ClassNotFoundException: com.target.Session', note: '<b>先排除加载器问题。</b>这不是参数构造的问题——用错 loader 时，你在第一步就倒下了。先解决 22.8 的事，再谈参数。' },
          { t: 'd', s: '# 尝试二：null 撞上重载' },
          { t: 'e', s: 'java.lang.IllegalArgumentException: no method found matching: check(Ljava/lang/Object;)V', note: '<b>null 没有类型。</b>目标类里同时存在 <code>check(String)</code> 与 <code>check(List)</code>，你传了裸 null，框架无法决定匹配哪一个。对策：显式指定类型，或先 <code>findMethodExact</code> 拿到 Method。' },
          { t: 'd', s: '# 尝试三：参数类型对了，但构造不出来' },
          { t: 'e', s: 'java.lang.InstantiationException: com.target.Request is abstract', note: '<b>抽象类不能 new。</b>这是"参数构造"最典型的死路：你要的参数类型本身是抽象类或接口，必须去找一个具体实现——而在被混淆的 App 里，那个实现类往往就在同一层逻辑里。' },
          { t: 'd', s: '# 尝试四：参数造出来了，方法自己崩了' },
          { t: 'e', s: 'java.lang.NullPointerException  at com.target.Crypto.encrypt(Crypto.java:1)', note: '<b>参数是 null，而方法内部直接解引用了它。</b>这一类失败说明"给 null"的策略在这个方法上不成立——你必须造一个可用的参数，或者换一个不需要该参数的入口。' },
          { t: 'w', s: '提示：以上四类报错的定位成本差别极大。先分清是"找不到"还是"造不出"还是"对方不认"。', note: '<b>把失败分类，比逐个试参数更快。</b>同一批调用里，先按异常类型分组统计，你会立刻看出问题集中在哪一类。' }
        ]
      },
    },

    /* ============================================================ 22.8 */
    {
      h: '22.8', title: 'Hook 插件 dex 与壳 dex：在类加载器层面下钩子',
      intuition: {
        tag: '直觉模型 · 两个人换了锁，你要撬的是门轴',
        body:
          '<p>把类加载器想成<b>图书馆的检索台</b>。你问检索台要一本书（某个类），它告诉你"没有"。</p>' +
          '<p>绝大多数人此时会怀疑自己记错了书名——于是反复改类名，反复失败。' +
          '但真正的问题是：<b>你去的是旧馆的检索台，而这本书在新馆。</b></p>' +
          '<p>更麻烦的是，新馆是<b>运行时才建起来的</b>——你没法事先知道它的地址，' +
          '只能守在"建馆"这个动作上，等它出现的那一刻把它记下来。</p>' +
          '<p>这一节讲的就是这件事：<b>不再问"这本书在不在"，而是守在"馆是怎么建起来的、书是怎么被要走的"这两个层面。</b></p>'
      },
      html:
        '<p>先分清两类问题。它们现象一样（都是 <code>ClassNotFound</code>），但根因完全不同——' +
        '<b>而根因不同，解法就不可能一样</b>。</p>' +
        T.tbl(['', '插件 dex 里的类', '壳 dex 里的类'],
          [
            ['<b>谁加载的</b>', '插件框架自己 <code>new</code> 出来的 <code>DexClassLoader</code>（或类似的自定义加载器）',
             '加固壳：它替换或包裹了 App 原本的加载器'],
            ['<b>什么时候出现</b>', '<b>运行时按需</b>：点开某个功能、走到某段逻辑才加载',
             '<b>启动早期就完成了</b>：你 attach 上去的时候，它已经换过一轮'],
            ['<b>你用默认加载器看到什么</b>', '完全看不到这些类', '你可能看到的是壳的 dex；真 dex 在另一个加载器里'],
            ['<b>下钩子的目标</b>', '在"新加载器被创建 / 新 dex 被挂载"时抓住它',
             '找到"壳替换之后的那个真实加载器"，再在它上面 <code>findClass</code>'],
            ['<b>对应手法</b>', 'hook <code>BaseDexClassLoader</code> 构造、<code>DexPathList.make*Elements</code>、' +
             '<code>ClassLoader.loadClass</code>',
             '从 <code>ActivityThread.mBoundApplication.info</code>（LoadedApk）反查真实加载器']
          ]) +
        T.note('key', '🔑 与第 2 章是同一个道理，只是换了一条工具链',
          '<p>第 2 章的结论是：<b>用 <code>Java.use</code> 找不到加固 App 的业务类，不是类名错了，是"你问错了人"。</b>' +
          '（双亲委派：加载器看不到兄弟加载器加载的类。）</p>' +
          '<p style="margin-bottom:0">这一节要做的事情完全一样，只是把 Frida 的 ' +
          '<code>Java.enumerateClassLoaders</code> 换成了 Xposed 的反射：' +
          '<b>找到那个真正负责目标类的加载器，然后在对的加载器上动手。</b>' +
          '如果你跳过了第 2 章，现在回去读它的 2.2 节——本节默认你已经理解双亲委派。</p>') +
        '<h3 style="margin-top:26px">三层下钩子的位置，看的是三种不同的问题</h3>' +
        T.tbl(['层', '位置', '你能看到什么', '代价'],
          [
            ['<b>L1</b>', '<code>ClassLoader.loadClass(String)</code>',
             '<b>所有</b>加载请求，包括那些最终由父加载器加载成功的类。' +
             '这是"谁在要什么"的总入口',
             '量极大。一个 App 启动会产生成千上万次请求，日志会把你自己淹掉'],
            ['<b>L2</b>', '<code>BaseDexClassLoader.findClass(String)</code>',
             '只有"委托链走到底、这个加载器自己动手"的那部分类',
             '覆盖小得多，但指向性强：看到的几乎都是你关心的那批类'],
            ['<b>L3</b>', '<code>DexPathList</code> 的 <code>makeDexElements</code> / ' +
             '<code>makePathElements</code> / <code>makeInMemoryDexElements</code>',
             '<b>dex 级事件</b>：一个新的 dex 被挂进某个加载器的那一刻（不是类级）',
             '看不到具体类名；但它是发现"壳又塞了一个 dex"的唯一窗口']
          ]) +
        '<p>判断怎么用：<b>想在类还没被加载时就介入 → 看 L1；想定位"谁负责这个类" → 看 L2；' +
        '想发现动态加载 → 看 L3。</b>三者不是替代关系，是三个观察角度。</p>' +
        '<p>这不是我编的分类。22.8C 要讲的 JDex2 在它的 Hook 模式里<b>三层都挂了</b>，' +
        '而且在代码注释里写明了理由：<i>因为一些壳根本就不新建classloader，而是向其中插入Dex，' +
        '所以完美想要Hook创建dex成员的方法</i>——这句话对应的正是 L3。</p>',
      lab: {
        title: '实验：loadClass 日志分层推演 —— 哪一层能看到最多的类加载',
        goal: '目标：用真实日志统计三层的可见范围',
        intro:
          '<p>下面是一段加了壳的 App 启动时产生的类加载日志（<b>教学样例</b>，格式仿 logcat）。' +
          '三条前缀对应刚才讲的三层：<code>[L1]</code> = <code>loadClass</code>，' +
          '<code>[L2]</code> = <code>findClass</code>，<code>[L3]</code> = <code>make*Elements</code>。</p>' +
          '<p><b>任务：</b>① 看懂每一层的可见范围（系统会算出<b>去重后</b>的数量与覆盖率）；' +
          '② 填出"在哪一层下钩子能看到最多的类加载"；③ 用一句话说清<b>这一层的代价</b>。</p>' +
          '<p>日志按 <code>|</code> 分隔（自己改成换行也能解析）。改日志，统计会跟着变。</p>',
        inputs: [
          {
            key: 'log', label: '类加载日志',
            hint: '一行一条，用 | 分隔',
            type: 'text',
            value: '[L1] loadClass com.target.App | [L1] loadClass com.target.Crypto | ' +
                   '[L2] findClass com.target.Crypto | [L1] loadClass java.lang.String | ' +
                   '[L3] makeDexElements classes2.dex -> DexClassLoader | [L1] loadClass com.plugin.Entry | ' +
                   '[L1] loadClass com.plugin.Entry | [L2] findClass com.plugin.Entry | ' +
                   '[L1] loadClass android.app.Activity | [L3] makeInMemoryDexElements -> InMemoryDexClassLoader | ' +
                   '[L1] loadClass com.plugin.PayImpl | [L2] findClass com.plugin.PayImpl | ' +
                   '[L1] loadClass com.target.Util'
          },
          { key: 'layer', label: '哪一层能看到最多的类加载（填 L1 / L2 / L3）', hint: '看数量', type: 'text', ph: 'L?' },
          { key: 'why', label: '这一层的代价是什么（一句话）',
            hint: '看到得最多，付出的代价是什么？', type: 'textarea', rows: 2, ph: '一句话…' }
        ],
        runLabel: '🔍 统计三层的可见范围',
        autorun: true,
        run: v => {
          const raw = String(v.log || '').trim() ||
            '[L1] loadClass com.target.App | [L1] loadClass com.target.Crypto | [L2] findClass com.target.Crypto | ' +
            '[L1] loadClass java.lang.String | [L3] makeDexElements classes2.dex -> DexClassLoader | ' +
            '[L1] loadClass com.plugin.Entry | [L1] loadClass com.plugin.Entry | [L2] findClass com.plugin.Entry | ' +
            '[L1] loadClass android.app.Activity | [L3] makeInMemoryDexElements -> InMemoryDexClassLoader | ' +
            '[L1] loadClass com.plugin.PayImpl | [L2] findClass com.plugin.PayImpl | [L1] loadClass com.target.Util';
          const re = /^\[(L[123])\]\s*(\S+)\s*(.*)$/;
          const l1 = [], l2 = [], l3 = [];
          let bad = 0;
          raw.split(/[\n|]+/).forEach(seg => {
            const ln = seg.trim();
            if (!ln) return;
            const m = re.exec(ln);
            if (!m) { bad++; return; }
            const arg = String(m[3] || '').trim();
            if (m[1] === 'L1') l1.push(arg);
            else if (m[1] === 'L2') l2.push(arg);
            else l3.push(arg);
          });
          const uniq = a => a.filter((x, i) => x && a.indexOf(x) === i);
          const u1 = uniq(l1), u2 = uniq(l2);
          const pct = (n, d) => d ? Math.round(n / d * 100) : 0;
          // 类集合指纹：对排序后的类名串做一次真实 MD5（手工构造字节，不依赖 TextEncoder）
          const fpSrc = u1.slice().sort().join('|');
          const fpBytes = new Uint8Array(fpSrc.length);
          for (let k = 0; k < fpSrc.length; k++) fpBytes[k] = fpSrc.charCodeAt(k) & 0xff;
          const fp = window.CRYPTO.toHex(window.CRYPTO.md5(fpBytes)).slice(0, 16);
          const miss2 = u1.filter(x => u2.indexOf(x) < 0);
          const nois = u1.length ? (l1.length / u1.length) : 0;

          /* 用 LABX 的委托链模型，看一个"插件类"到底由谁加载 */
          const chain = window.LABX.classLoaderChain('com.plugin.PayImpl', {
            boot: ['java.lang.String', 'android.app.Activity'],
            path: ['com.target.App', 'com.target.Crypto', 'com.target.Util'],
            custom: ['com.plugin.Entry', 'com.plugin.PayImpl']
          });
          const traceRows = chain.trace.map(t =>
            [t.loader, t.role, t.hit ? '<b>命中</b>' : '不认这个类']);

          let html = '<div class="lab-msg key"><b>📊 三层可见范围（去重后）</b><div class="lab-note">' +
            '<table style="width:100%;border-collapse:collapse">' +
            '<tr><th align="left">层</th><th align="left">匹配行数</th><th align="left">去重类数</th>' +
            '<th align="left">覆盖率</th><th align="left">看得到什么</th></tr>' +
            '<tr><td><b>L1</b> loadClass</td><td>' + l1.length + '</td><td><b>' + u1.length + '</b></td>' +
            '<td>' + pct(u1.length, u1.length) + '%</td><td>全部请求（含父加载器负责的类）</td></tr>' +
            '<tr><td>L2 findClass</td><td>' + l2.length + '</td><td>' + u2.length + '</td>' +
            '<td>' + pct(u2.length, u1.length) + '%</td><td>只有这个加载器自己负责的类</td></tr>' +
            '<tr><td>L3 make*Elements</td><td>' + l3.length + '</td><td>0（dex 级事件）</td>' +
            '<td>—</td><td>新 dex 被挂进加载器的时刻</td></tr>' +
            '</table>' +
            '<div style="margin-top:10px">日志总行数（L1）<b>' + l1.length + '</b>，去重后 <b>' + u1.length + '</b> 个类 —— ' +
            '重复请求倍数约 <b>' + nois.toFixed(2) + '×</b>。这就是 L1 的噪音来源：' +
            '同一个类会被请求不止一次。<br>' +
            '解析失败（格式不匹配）的行：<b>' + bad + '</b> 行。<br>' +
            '本次解析出的类集合指纹（MD5 前 16 位）：<code>' + fp + '</code> —— ' +
            '类集合一变，指纹就变，可以用来判断"两次脱壳拿到的类是不是同一批"。</div></div></div>';

          html += '<div class="lab-msg fail"><b>🔎 L2 漏掉了谁</b><div class="lab-note">' +
            'L2 看不到的类（共 ' + miss2.length + ' 个）：' +
            (miss2.length ? '<code>' + miss2.join('</code>、<code>') + '</code>' : '（无）') + '<br>' +
            '其中 <code>java.lang.String</code>、<code>android.app.Activity</code> 这类是<b>父加载器负责的</b>——' +
            '请求从 L1 进来、往上委托成功，根本不会落到 L2。这正是"L1 全、L2 精"的原因。</div></div>';

          html += '<div class="lab-msg model"><b>🧬 用委托链模型验证一个插件类是谁加载的</b>' +
            '<div class="lab-note">目标：<code>com.plugin.PayImpl</code>' +
            '<table style="width:100%;border-collapse:collapse;margin-top:8px">' +
            '<tr><th align="left">加载器</th><th align="left">职责</th><th align="left">结果</th></tr>' +
            traceRows.map(r => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td>' + r[2] + '</td></tr>').join('') +
            '</table>' +
            '结论：它由 <b>' + (chain.found || '（无人负责）') + '</b> 加载 → ' +
            chain.solve + '<br>' +
            '<span style="color:var(--fg-3)">（这段推演用的是 assets/labx.js 里的 classLoaderChain 模型，' +
            '与第 2 章的双亲委派是同一套规则。）</span></div></div>';
          return html;
        },
        expected: v => {
          const lay = String(v.layer || '').trim().toUpperCase().replace(/[^L123]/g, '');
          const why = String(v.why || '').trim();
          const layOk = lay === 'L1' || lay === '1';
          const whyOk = window.AKKC_hasConcept(why, [
            '所有请求', '全部请求', '总入口', '请求都', '数量大', '量最大', '最多', '噪音', '淹没',
            '父加载器', '委托', '过滤', '去重', '性能'
          ]);
          return {
            ok: layOk && whyOk,
            detail:
              (layOk ? '✅ 层选对了：<b>L1 <code>ClassLoader.loadClass</code></b> 是所有加载请求的总入口，' +
                      '去重后能看到全部类（覆盖率 100%）。'
                     : '❌ 层选错了。你填的是 <code>' + (lay || '（空）') + '</code>。' +
                       '数一数上面的表：L1 看到 ' + '全部' + '，L2 只看得到"这个加载器自己动手"的那部分，' +
                       'L3 根本不看类（只看 dex）。') + '<br>' +
              (whyOk ? '✅ 代价也说到了：L1 的量极大（重复请求 + 系统类也走这里），不做过就会把自己淹掉。'
                     : '❌ 代价还差一句。关键点：<b>看到得最多 = 噪音最大</b>——' +
                       'L1 会看到同一个类的重复请求、以及大量你根本不关心的系统类（<code>java.*</code>、<code>android.*</code>），' +
                       '所以实战里通常要在回调里做前缀过滤或去重。')
          };
        },
        showAnswer:
          '【哪一层看到最多】L1 —— ClassLoader.loadClass(String)\n' +
          '  它是所有加载请求的总入口。包括：\n' +
          '    · 最终由父加载器（BootClassLoader）加载成功的系统类（java.lang.String、android.app.Activity）\n' +
          '    · 同一个类的重复请求（日志里 com.plugin.Entry 出现了两次）\n' +
          '  本例：L1 匹配 13 行 / 去重 7 个类 = 覆盖率 100%\n\n' +
          '【为什么不是 L2】\n' +
          '  L2 是 BaseDexClassLoader.findClass —— 只有"委托链一路向上都失败、这个加载器自己动手"时才会被调用。\n' +
          '  本例：L2 只看到 3 个类（com.target.Crypto / com.plugin.Entry / com.plugin.PayImpl），覆盖率约 43%。\n' +
          '  父加载器负责的类走不到这里 —— 这正是"L1 全、L2 精"。\n\n' +
          '【为什么不是 L3】\n' +
          '  L3 是 DexPathList 的 makeDexElements / makePathElements / makeInMemoryDexElements。\n' +
          '  它看到的是 dex 级事件（新 dex 被挂进加载器），不是类。本例 2 条。\n' +
          '  它的用途是"发现动态加载"：壳又塞进来一个 dex，只有在这一层能第一时间知道。\n\n' +
          '【L1 的代价】\n' +
          '  量最大、噪音最多：重复请求 + 大量系统类。\n' +
          '  实战做法：在回调里做前缀过滤（过滤 android./java./kotlin. 等）、做去重、\n' +
          '  或者把 L1 当作"侦察层"用一段时间，确认目标后再收敛到 L2 或具体类。\n\n' +
          '【记住这个三层的分工】\n' +
          '  要"提前介入还不存在的类" → L1\n' +
          '  要"确认谁负责这个类"     → L2\n' +
          '  要"发现新 dex 被挂上"     → L3',
        hint:
          '<b>先看数量。</b>把三层的"去重类数"对比一下：' +
          'L1 会包含那些"请求了但最终由父加载器加载"的系统类（<code>java.lang.String</code>、' +
          '<code>android.app.Activity</code>），而 L2 只处理"自己动手"的那部分。<br><br>' +
          '<b>再说代价：</b>看到得越多，噪音越大。想想一个真实 App 启动会产生多少次类加载请求——' +
          '你打算怎么从里面捞出你关心的那几个？',
        after: T.note('ok', '✅ 实验的收获',
          '<p style="margin-bottom:0">你现在能把"我要 hook 类加载"这句话拆成三个具体问题：' +
          '<b>我要提前介入（L1）、我要确认归属（L2）、还是我要发现新 dex（L3）？</b><br>' +
          '这个拆分能力在实战里很值钱：它决定了你的日志是"能读的"还是"不能读的"。' +
          '22.8C 的 JDex2 三层都挂了，但它的默认模式（Reflect）<b>一层都不挂</b>——' +
          '那是另一个维度的权衡，案例里会讲。</p>')
      },
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '插件类的 ClassNotFound',
            scenario: '<b>情境：</b>目标 App 用了插件化框架。你在主 dex 里成功 hook 到了几个类，' +
              '但要找的 <code>com.plugin.PayImpl</code> 一直报 <code>ClassNotFoundException</code>。' +
              '你已经确认过：类名没写错（在别的工具里能看到这个类），主进程也判断正确。',
            q: '接下来最该做的是？',
            choices: [
              { t: 'hook <code>BaseDexClassLoader</code> 构造与 <code>DexPathList</code> 的 ' +
                   '<code>make*Elements</code>，把"新加载器被创建 / 新 dex 被挂载"的时刻抓住，' +
                   '再用那个新加载器去 <code>findClass</code>', next: 'n1' },
              { t: '把包名过滤条件放宽，让模块在更多进程里生效', next: 'n2' },
              { t: '在主 dex 里遍历所有已加载的类，用模糊匹配猜一个相近的类名', next: 'n3' },
              { t: '改用 <code>Class.forName("com.plugin.PayImpl")</code> 直接加载，绕开加载器问题', next: 'n4' }
            ]
          },
          n1: {
            terminal: true, verdict: 'good', verdictTitle: '对：插件类是运行时才有的，你得守在"它出生"的那一刻',
            result: '<p><b>你抓住了插件 dex 与壳 dex 的关键区别：插件类是运行时按需加载的，事前根本不存在。</b><br>' +
              '所以任何"在固定时刻去找它"的思路都会失败——不管那个时刻有多晚。正确姿势是<b>守株待兔</b>：<br>' +
              '① hook <code>BaseDexClassLoader</code> 的构造函数 → 新加载器出现的瞬间你就知道了；<br>' +
              '② hook <code>DexPathList</code> 的 <code>makeDexElements</code> / <code>makePathElements</code> / ' +
              '<code>makeInMemoryDexElements</code> → 连"往现有加载器里插 dex"这条不新建加载器的路也堵上了；<br>' +
              '③ 拿到新加载器之后，再用它 <code>findClass</code>——这时候才谈得上"问对了人"。<br>' +
              '<span class="hit">JDex2 的做法与此逐字对应：它 hook 了 <code>BaseDexClassLoader</code> 构造，' +
              '也 hook 了那三个 <code>make*</code> 方法，并在注释里说明理由——' +
              '因为有些壳根本不新建 classloader，而是往里面插 dex。</span></p>'
          },
          n2: {
            terminal: true, verdict: 'bad', verdictTitle: '你把"加载器问题"当成了"作用域问题"',
            result: '<p><b>认知根源：现象里有一个反证，你没有用上。</b><br>' +
              '如果真是作用域问题，你<b>连主 dex 里的类都 hook 不到</b>——模块根本不会被唤醒。' +
              '但你明确说了"主 dex 里成功 hook 到了几个类"，这证明模块已经在正确的作用域和正确的进程里工作了。<br>' +
              '<span class="miss">放宽作用域不会让插件类出现，只会让你的模块在更多无关进程里跑起来' +
              '（更多的日志、更多的崩溃点、更大的暴露面）。</span><br>' +
              '诊断的基本功：<b>先用已知的成功反证掉一批假设。</b></p>'
          },
          n3: {
            terminal: true, verdict: 'bad', verdictTitle: '你在猜名字，而不是找加载器',
            result: '<p><b>认知根源：你把"类不存在"理解成了"名字不对"。</b><br>' +
              '遍历主 dex 里已加载的类不可能找到插件类——因为它<b>根本不在主 dex 里</b>，' +
              '它是插件加载器从另一个 dex 加载的。你遍历再多次也是零命中。<br>' +
              '<span class="hit">这个坑第 2 章已经点过一次：<b>找不到类时，第一反应应该是"谁负责加载它"，' +
              '而不是"它到底叫什么"。</b></span><br>' +
              '（模糊匹配猜名字还有一个副作用：真的猜中一个相近的类，你会以为问题解决了，' +
              '然后在后面因为类型不匹配崩得莫名其妙。）</p>'
          },
          n4: {
            terminal: true, verdict: 'bad', verdictTitle: 'Class.forName 用的是同一个加载器',
            result: '<p><b>认知根源：你以为换了一个 API，其实换不动加载器。</b><br>' +
              '<code>Class.forName(String)</code> 的单参数版本会用<b>调用方所在的加载器</b>——' +
              '也就是你的模块类所在的那个加载器，它同样不认识插件类。<br>' +
              '（三参数版本 <code>Class.forName(name, initialize, loader)</code> 才允许指定加载器，' +
              '而问题仍然回到"你手上有没有那个对的加载器"。）<br>' +
              '<span class="hit">这正是本节的核心命题：<b>能不能找到类，取决于你手上的加载器，' +
              '而不是取决于你用哪个 API 去问。</b></span></p>'
          }
        }
      },
      after: T.note('key', '🔑 这一节的判断，一句话版',
        '<p style="margin-bottom:0"><b>不要"在某个时刻去找类"，要"守在类出生的地方"。</b><br>' +
        '壳 dex 的问题用"找到真实加载器"解决；插件 dex 的问题用"捕获新加载器 / 新 dex"解决。' +
        '两种问题的共同点是：<b>答案都在加载器这一层，而不在类名上。</b></p>')
    },

    /* ============================================================ 22.8L */
    {
      h: '22.8L', title: '动手实验：Hook 点选择器 / 时机推演器',
      html:
        '<p>这是本章的核心实验。下面给出四个真实症状——它们分别对应你在实战里最常遇到的四种"怎么都不对"。</p>' +
        '<p>请为每一个症状选择：<b>hook 点（P1–P6）</b>与<b>时机（before / after）</b>。' +
        '系统会按 22.1–22.8 讲的<b>真实时机语义</b>逐条判定：此刻目标类存在吗？字段有值吗？' +
        '入参还是原始的吗？壳换过的真实加载器拿得到了吗？</p>' +
        '<p>最后你还要用一句话写出结论——这部分会做<b>语义判分</b>（说不清就等于没学会）。</p>' +
        T.tbl(['编号', '症状'], [
          ['<b>1</b>', 'App 一启动就闪退，logcat 里只有一条 <code>ClassNotFoundException</code>，指向你要 hook 的那个业务类'],
          ['<b>2</b>', '你在某个类的构造函数里读实例字段，读出来是 <code>null</code>'],
          ['<b>3</b>', '你在加密方法的 <code>after</code> 里看 <code>param.args</code>，发现它不是调用方传的那个明文'],
          ['<b>4</b>', '插件 dex 里的类一直 <code>ClassNotFound</code>（主 dex 里的类都能正常 hook）']
        ]) +
        T.tbl(['编号', 'hook 点'], [
          ['<b>P1</b>', '在 <code>handleLoadPackage</code> 里立刻 <code>findAndHookMethod</code> 业务类'],
          ['<b>P2</b>', 'hook <code>ClassLoader.loadClass</code>（在类被加载之前介入）'],
          ['<b>P3</b>', '等到能拿到"壳替换后的真实加载器"之后，再 <code>findClass</code> / 挂 hook'],
          ['<b>P4</b>', 'hook <code>BaseDexClassLoader</code> 构造与 <code>DexPathList.make*Elements</code>（捕获新 dex 与新加载器）'],
          ['<b>P5</b>', 'hook 目标类的构造函数'],
          ['<b>P6</b>', 'hook 业务方法本身']
        ]) +
        T.note('', '📌 怎么填',
          '<p style="margin-bottom:0"><b>症状</b>填 1/2/3/4；<b>hook 点</b>填 P1–P6；' +
          '<b>时机</b>填 <code>before</code> 或 <code>after</code>——' +
          '如果这个 hook 点本身没有"前后两侧"的概念（P1/P3/P4 属于"在哪一刻动手"，' +
          '不区分 before/after），填 <code>-</code> 即可，系统会说明原因。</p>'),
      lab: {
        title: '实验：Hook 点选择器 / 时机推演器',
        goal: '目标：按真实时机语义判定 hook 点与侧别',
        intro:
          '<p>先看上面的四个症状与六个 hook 点。这个实验的判定逻辑是<b>显式的时间轴模型</b>：' +
          '基线取自 <code>LABX.BOOT_STAGES</code>（真实的系统启动阶段），后面接上 App 进程内部的关键事件。</p>' +
          '<p>你选的 hook 点会落到时间轴的某一步上，系统据此算出"此刻你能看到什么"，' +
          '再与症状的要求逐条比对。<b>点错不要紧——重点看每一条判定给出的理由。</b></p>',
        inputs: [
          { key: 'sym', label: '症状编号（1–4）', hint: '见上方表格', type: 'text', value: '1' },
          { key: 'point', label: 'hook 点（P1–P6）', hint: '例如 P5', type: 'text', ph: 'P?' },
          { key: 'when', label: '时机（before / after / -）', hint: 'P1、P3、P4 填 -', type: 'text', ph: 'before' },
          { key: 'why', label: '用一句话写出你的结论',
            hint: '要说清"为什么是这个点、为什么是这一侧"', type: 'textarea', rows: 3,
            ph: '例如：构造函数体在 before 时还没执行，字段要到 after 才定型，所以……' }
        ],
        runLabel: '🧭 推演这个 hook 点',
        autorun: true,
        run: v => {
          const B = (window.LABX && window.LABX.BOOT_STAGES) || [];
          const first = B.length ? B[0].label : '（无数据）';
          const last = B.length ? B[B.length - 1].label : '（无数据）';
          const TL = [
            { ix: 0, t: '系统启动基线：' + first + ' → ' + last, n: 'zygote 在此阶段起来，LSPosed 已经在场' },
            { ix: 1, t: 'handleLoadPackage 被调用', n: 'App 进程刚起，业务类一个都还没加载' },
            { ix: 2, t: 'Application.attachBaseContext()', n: '加固壳在这里替换 ClassLoader' },
            { ix: 3, t: 'Application.onCreate()', n: '壳解密真 dex 并把新加载器挂上 → 真实加载器从此可拿' },
            { ix: 4, t: '第一次 loadClass(业务类)', n: '壳在这里回填 code_item；业务类到这一刻才第一次存在' },
            { ix: 5, t: '第一次 new 目标对象（构造函数执行）', n: '字段在这里被赋值：before 侧还是默认值' },
            { ix: 6, t: '业务方法被调用', n: '入参在下行；方法体执行完之后可能被改写' },
            { ix: 7, t: '业务方法再次被调用', n: '参数与上一次不同——只 hook 一次很容易漏掉变化' }
          ];
          const PT = {
            P1: { n: 'handleLoadPackage 里立刻 findAndHookMethod 业务类', ins: 1, eff: 1, w: false },
            P2: { n: 'hook ClassLoader.loadClass（在类被加载之前介入）', ins: 3, eff: 4, w: true },
            P3: { n: '等拿到壳替换后的真实加载器再 findClass / 挂 hook', ins: 3, eff: 5, w: false },
            P4: { n: 'hook BaseDexClassLoader 构造与 DexPathList.make*Elements', ins: 2, eff: 3, w: false },
            P5: { n: 'hook 目标类的构造函数', ins: 4, eff: 5, w: true },
            P6: { n: 'hook 业务方法本身', ins: 5, eff: 6, w: true }
          };
          const SYM = {
            '1': {
              title: 'App 一启动就闪退，ClassNotFoundException 指向业务类',
              root: '你在最早期就去 findClass 业务类，而它此刻还不存在。',
              ok: [['P2', 'before'], ['P3', '-']],
              kw: ['加载器', 'loader', '真实', 'loadClass', '还没加载', '更早', '提前', '时机', '等它出现', '不要一开始就找']
            },
            '2': {
              title: '在构造函数里读实例字段得到 null',
              root: 'before 侧构造函数体还没执行，字段还没被赋值。',
              ok: [['P5', 'after']],
              kw: ['after', '之后', '构造完', '赋值', '定型', 'before 太早', '还没轮到', '时机']
            },
            '3': {
              title: 'after 里看到的参数已经不是调用方传的明文',
              root: 'after 侧方法体已经跑完，param.args 可能已被改写；原始入参只能在 before 取。',
              ok: [['P6', 'before']],
              kw: ['before', '之前', '原始', '已经被改', '入参', '提前取', '先取出', '拷贝', 'copy', '保存下来']
            },
            '4': {
              title: '插件 dex 里的类 ClassNotFound（主 dex 正常）',
              root: '插件 dex 由运行时新建的加载器加载，默认加载器按双亲委派看不到它。',
              ok: [['P2', 'before'], ['P4', '-']],
              kw: ['加载器', 'loader', '双亲委派', '插件', '动态', '新建', '新 dex', 'makeDexElements', 'loadClass', '切换加载器']
            }
          };
          const symKey = String(v.sym || '').replace(/[^0-9]/g, '') || '1';
          const S = SYM[symKey] || SYM['1'];
          const pk = String(v.point || '').trim().toUpperCase().replace(/[^P0-9]/g, '');
          const P = PT[pk] || null;
          let when = String(v.when || '').trim().toLowerCase();
          when = when === '-' || when === '－' || when === '' ? '-' : (when.indexOf('after') >= 0 ? 'after' : (when.indexOf('before') >= 0 ? 'before' : '?'));

          const eff = P ? P.eff : null;
          const st = {
            cls: eff == null ? null : (eff >= 4 ? (eff === 4 ? '正在被加载（就在这一刻）' : '已存在') : '还不存在'),
            field: eff == null ? null : (eff >= 5 ? (eff === 5 && when === 'before' ? '还没赋值（默认值）' : '已定型') : '还没赋值（默认值）'),
            raw: eff == null ? null : (eff >= 6 ? (when === 'before' ? '原始（方法体还没跑）' : '可能已被方法体改写') : '不适用（还没走到调用）'),
            loader: eff == null ? null : (eff >= 3 ? '可以拿到' : '拿不到（壳还没换完）'),
            dex: eff == null ? null : (eff >= 3 ? '已挂上' : '还没挂上')
          };
          const normW = (P && P.w) ? when : '-';
          const hit = !!(P && S.ok.some(p => p[0] === pk && (p[1] === '-' || p[1] === normW)));

          let html = '<div class="lab-msg ' + (hit ? 'pass' : 'fail') + '">' +
            '<b>' + (hit ? '✅ 这个组合命中症状 ' + symKey : '❌ 这个组合不匹配症状 ' + symKey) + '</b>' +
            '<div class="lab-note">' +
            '<b>症状 ' + symKey + '：</b>' + S.title + '<br>' +
            '<b>根因：</b>' + S.root + '<br>' +
            '<b>你选的：</b>' + (P ? '<code>' + pk + '</code> · ' + P.n + '　时机：<code>' + normW + '</code>'
              : '<code>' + (pk || '（未填）') + '</code> —— 这不是 P1–P6 里的任何一个') +
            '</div></div>';

          html += '<div class="lab-msg key"><b>🕒 时间轴（基线来自 LABX.BOOT_STAGES）</b><div class="lab-note">' +
            '<table style="width:100%;border-collapse:collapse">' +
            '<tr><th align="left">步</th><th align="left">事件</th><th align="left">说明</th></tr>' +
            TL.map(r => {
              const mark = (P && (r.ix === P.ins || r.ix === P.eff))
                ? ' <span style="color:var(--acc)">◀ 你的点在这里</span>' : '';
              return '<tr><td>' + r.ix + '</td><td>' + r.t + mark + '</td><td>' + r.n + '</td></tr>';
            }).join('') +
            '</table></div></div>';

          if (P) {
            html += '<div class="lab-msg ' + (hit ? 'pass' : 'fail') + '"><b>🔬 逐条判定（在这个点上，此刻你能看到什么）</b>' +
              '<div class="lab-note"><table style="width:100%;border-collapse:collapse">' +
              '<tr><th align="left">检查项</th><th align="left">此刻的状态</th><th align="left">对这个症状意味着</th></tr>' +
              '<tr><td>目标业务类</td><td>' + st.cls + '</td><td>' +
                (st.cls === '还不存在' ? '<b>你找不到它</b>——这正是症状 1 的根因' : '可以找到它了') + '</td></tr>' +
              '<tr><td>实例字段</td><td>' + st.field + '</td><td>' +
                (st.field === '还没赋值（默认值）' ? '<b>读到 null 是必然的</b>——症状 2 的根因' : '已经有值') + '</td></tr>' +
              '<tr><td>方法入参</td><td>' + st.raw + '</td><td>' +
                (st.raw === '可能已被方法体改写' ? '<b>你看到的不是调用方传的值</b>——症状 3 的根因' : '（见左侧状态）') + '</td></tr>' +
              '<tr><td>壳替换后的真实加载器</td><td>' + st.loader + '</td><td>' +
                (st.loader === '可以拿到' ? '可以在它上面 findClass' : '现在还拿不到，只能先蹲守更底层') + '</td></tr>' +
              '<tr><td>新 dex 是否已挂载</td><td>' + st.dex + '</td><td>' +
                (st.dex === '已挂上' ? 'L3 已经能看到它了' : '还没有 dex 级事件') + '</td></tr>' +
              '</table>' +
              '<div style="margin-top:10px"><b>判定：</b>' + (hit
                ? '这个 hook 点 + 时机，与症状 ' + symKey + ' 的要求一致。'
                : '不匹配。注意：<b>不是所有 hook 点都吃 before/after</b>——' +
                  (P.w ? '你选的 <code>' + pk + '</code> 有前后两侧，时机填对了才会有意义。'
                       : '你选的 <code>' + pk + '</code> 属于"在哪一刻动手"，本身没有 before/after 的概念（填 <code>-</code> 即可）。')) +
              '</div></div></div>';
          } else {
            html += '<div class="lab-msg warn"><b>⏳ 还没选 hook 点</b><div class="lab-note">' +
              '在"hook 点"里填 P1–P6 中的任意一个，然后点上面的按钮。' +
              '时间轴已经列出来了，你可以先自己推：<b>症状 ' + symKey + '</b> 需要在时间轴的哪一步介入？</div></div>';
          }
          return html;
        },
        expected: v => {
          const SYM = {
            '1': { ok: [['P2', 'before'], ['P3', '-']],
                   kw: ['加载器', 'loader', '真实', 'loadClass', '还没加载', '更早', '提前', '时机', '等它出现'],
                   want: '<b>P2 + before</b>（在 <code>loadClass</code> 的 before 里蹲守类名，此时不会因为类不存在而崩），' +
                         '或者 <b>P3</b>（等壳换完加载器再动手，时机填 <code>-</code>）' },
            '2': { ok: [['P5', 'after']],
                   kw: ['after', '之后', '构造完', '赋值', '定型', 'before 太早', '还没轮到', '时机'],
                   want: '<b>P5 + after</b>（构造函数跑完，字段才定型）' },
            '3': { ok: [['P6', 'before']],
                   kw: ['before', '之前', '原始', '已经被改', '入参', '提前取', '先取出', '保存下来'],
                   want: '<b>P6 + before</b>（原始入参只在方法体执行前存在）' },
            '4': { ok: [['P2', 'before'], ['P4', '-']],
                   kw: ['加载器', 'loader', '双亲委派', '插件', '动态', '新建', '新 dex', 'makeDexElements', '切换加载器'],
                   want: '<b>P4</b>（捕获新加载器 / 新 dex，时机填 <code>-</code>），或者 <b>P2 + before</b>（在加载请求入口蹲守）' }
          };
          const symKey = String(v.sym || '').replace(/[^0-9]/g, '') || '1';
          const S = SYM[symKey] || SYM['1'];
          const pk = String(v.point || '').trim().toUpperCase().replace(/[^P0-9]/g, '');
          let when = String(v.when || '').trim().toLowerCase();
          when = when === '-' || when === '－' || when === '' ? '-' : (when.indexOf('after') >= 0 ? 'after' : (when.indexOf('before') >= 0 ? 'before' : '?'));
          const hit = S.ok.some(p => p[0] === pk && (p[1] === '-' || p[1] === when));
          const why = String(v.why || '').trim();
          const whyOk = window.AKKC_hasConcept(why, S.kw);
          return {
            ok: hit && whyOk,
            detail:
              '症状 ' + symKey + '：' +
              (hit ? '✅ hook 点与时机都对了。' : '❌ hook 点或时机不对。你填的是 <code>' + (pk || '空') + '</code> / <code>' + when + '</code>。') +
              '<br>' +
              (whyOk ? '✅ 结论里说到了关键概念。' :
                '❌ 结论还差关键点。这一题要说到：<b>' + S.kw.slice(0, 4).join(' / ') + '</b> 这一层的意思。') +
              (hit ? '' : '<br><b>再看一眼时间轴：</b>这个症状要求你在"目标信息还存在/还没被破坏"的那一步介入。')
          };
        },
        showAnswer:
          '【症状 1】App 一启动就闪退，ClassNotFoundException 指向业务类\n' +
          '  根因：在 handleLoadPackage 最早期就去 findClass 业务类，而它还没被壳加载出来。\n' +
          '  正解：P2 + before —— 在 ClassLoader.loadClass 的 before 侧蹲守类名（此时不会因类不存在而崩）；\n' +
          '        或 P3 —— 等到能从 ActivityThread.mBoundApplication.info 拿到壳换过的真实加载器再动手（时机填 -）。\n' +
          '  错误示范：P1（在最早的时机找还不存在的类）。\n\n' +
          '【症状 2】在构造函数里读实例字段得到 null\n' +
          '  根因：before 侧构造函数体还没执行，字段还是默认值（引用类型 null、int 0）。\n' +
          '  正解：P5 + after —— 构造完成后字段才定型。\n' +
          '  诊断手法：同一个字段在 before / after 各打一次日志，看它在哪一侧出现。\n\n' +
          '【症状 3】after 里看到的参数不是调用方传的明文\n' +
          '  根因：after 时方法体已经跑完，param.args 可能已被方法自身（或别的模块）改写。\n' +
          '  正解：P6 + before —— 原始入参只存在于方法体执行之前；需要保留就在 before 里先复制一份。\n\n' +
          '【症状 4】插件 dex 里的类 ClassNotFound（主 dex 正常）\n' +
          '  根因：插件类由运行时新建的加载器加载，默认加载器按双亲委派看不到它。\n' +
          '  正解：P4（hook BaseDexClassLoader 构造 + DexPathList.make*Elements，捕获新加载器/新 dex，时机填 -）；\n' +
          '        或 P2 + before（在加载请求的总入口蹲守）。\n' +
          '  注意：这不是作用域问题——主 dex 的类能 hook 到，说明模块已经在正确的进程里了。\n\n' +
          '【一句话总纲】\n' +
          '  hook 点的选择 = 在"你需要的信息还存在、且目标对象已经存在"的那一步介入。\n' +
          '  两侧的语义：before = 参数与对象状态都还没被使用；after = 结果与状态都已定型。',
        hint:
          '<b>逐个症状问自己三个问题：</b><br>' +
          '① 我要的东西（类 / 字段 / 原始入参 / 加载器）在<b>哪一步</b>才存在？<br>' +
          '② 我选的 hook 点在<b>那一步之前还是之后</b>？<br>' +
          '③ 我选的点有 before/after 两侧吗（P1/P3/P4 没有）？<br><br>' +
          '最常错的一个：症状 2 有相当一部分人会去 hook 业务方法（P6）——那样确实能读到值，' +
          '但你并没有回答"构造函数里为什么是 null"。',
        after: T.note('ok', '✅ 实验的收获',
          '<p style="margin-bottom:0">你现在应该能把本章前八节压缩成一张表：<br>' +
          '<b>类还不存在 → 蹲守加载层（P2/P4）；对象状态没定型 → 挪到 after（P5）；' +
          '原始数据正在被消耗 → 必须在 before 取（P6）。</b><br>' +
          '这张表就是"时机"这件事的全部判断依据。后面无论遇到什么新症状，先问"我要的东西在哪一步存在"，答案自然出来。</p>')
      }
    },

    /* ============================================================ 22.8C */
    {
      h: '22.8C', title: '实战案例：JDex2 —— 用 Xposed/LSPosed 主动调用脱抽取壳',
      case: {
        source: 'github',
        title: 'JDex：基于Xposed / Lsposed的主动调用抽取壳脱壳工具',
        date: '2026-04-06（GitHub 仓库创建时间）',
        author: 'J5now',
        target: 'JDex2（仓库 J5now/JDex2，Java + native，入口 com.jsnow.jdex2.JSHook）；README 自述' +
                '「基于 Android9.0+ 开发」，依赖 LSPosed',
        background:
          '<p>先把它要解决的问题摆清楚。第 19 章把加固分了几代：<b>一代壳</b>整体加密 dex，' +
          '<b>抽取壳</b>保留 dex 结构但抽走方法体，方法首次被调用时才回填。' +
          '第 2 章的 FART 用「主动调用」解决抽取壳——遍历所有类与所有方法强制调用一遍，逼壳回填，然后 dump。</p>' +
          '<p>但 FART 那条路很重：要改 ART、要刷机、要跟着安卓大版本反复移植（第 12 章整章都在讲这件事）。' +
          'JDex2 走的是另一条路：<b>做成一个 Xposed/LSPosed 模块，装上去就能跑</b>。' +
          '它的 README 写得很直白——<i>可以应对未对Lsposed设置有效检测的大部分的企业抽取壳和免费壳的Dex加固</i>。</p>' +
          '<p>我核对的是它的<b>仓库与源码</b>（README、<code>assets/xposed_init</code>、' +
          '<code>app/src/main/java/com/jsnow/jdex2/JSHook.java</code>）。README 里给出的原帖链接指向看雪，' +
          '但看雪未登录访问需要人机验证，本次工具未能取到正文，所以下面所有技术细节都来自 GitHub 仓库本身。</p>',
        points: [
          '<b>入口声明</b>：<code>assets/xposed_init</code> 只有一行 <code>com.jsnow.jdex2.JSHook</code>；' +
          '入口类实现 <code>IXposedHookLoadPackage</code>——就是 22.3 讲的那个最小骨架。',
          '<b>拿壳替换后的真实 ClassLoader</b>：<code>ActivityThread.currentActivityThread()</code> → ' +
          '<code>mBoundApplication</code> → <code>info</code>（LoadedApk）→ <code>getClassLoader()</code>；' +
          '失败则回退到 <code>lpparam.classLoader</code>。代码注释自称这条链是 Android 自己也在用的。',
          '<b>枚举 DexFile</b>：要求加载器是 <code>BaseDexClassLoader</code>，然后取 <code>pathList</code> → ' +
          '<code>dexElements[]</code> → 每个元素的 <code>dexFile</code> 字段。',
          '<b>主动调用构造</b>：取 <code>getDeclaredConstructors()</code> 的第一个，用 ' +
          '<code>before</code> + <code>param.setResult(null)</code> 把构造体堵住，再用默认参数 ' +
          '<code>newInstance</code> 触发回填，最后在 <code>finally</code> 里 <code>unhook()</code>。',
          '<b>dump 交给 native</b>：读 <code>DexFile.mCookie</code>（<code>long[]</code>），' +
          '调用自带的 native 方法 <code>dumpDexByCookie(cookie, outDir)</code>；' +
          '模块用 <code>System.loadLibrary("jdex2")</code> 加载自己的 so（走 LSPosed 的 native 通道）。',
          '<b>两条工作模式</b>：默认 <code>Reflect</code>（sleep 10 秒后反射 dump，<b>刻意不 hook</b> ' +
          '<code>onCreate</code> / <code>attachBaseContext</code>）；可选 <code>Hook</code> 模式——' +
          'hook <code>BaseDexClassLoader</code> 构造，并 hook <code>DexPathList</code> 的 ' +
          '<code>makeDexElements</code> / <code>makePathElements</code> / <code>makeInMemoryDexElements</code>，' +
          '通过 <code>definingContext</code> 字段拿回对应的加载器。README 把 Hook 模式标注为<b>不推荐使用</b>。',
          '<b>稳定性设计</b>：<code>CLASS_FILTER_PREFIXES</code> 过滤 <code>android.</code>/<code>java.</code>/' +
          '<code>kotlin.</code>/<code>com.google.</code> 等前缀；白名单 / 黑名单按前缀匹配；' +
          '<code>isDexAlreadyDumped()</code> 用 cookie 取出该 dex 的大小、检查输出文件是否已存在 → 支持<b>分两轮脱壳</b>。',
          '<b>产物与配置路径</b>：dump 到 <code>/sdcard/Android/data/&lt;包名&gt;/dumpDex/</code>；' +
          '配置由 <code>MainActivity</code> 写入 <code>.../files/config.properties</code>；' +
          'Android 12+ 用的是 <code>/Android/\\u200Bdata/</code>（路径里插了一个零宽字符）。'
        ],
        method: [
          '先判断对手是哪一类：目标若是抽取壳，就走"主动调用触发回填"这条路；若是方法粒度抽取，这个工具自己承认无能为力（见局限）。',
          '不信任默认加载器：先从 <code>ActivityThread.mBoundApplication.info</code> 反查壳替换后的真实 ClassLoader，拿不到再回退。',
          '从真实加载器的 <code>dexElements</code> 里把所有 <code>DexFile</code> 掏出来，用 <code>getClassNameList(mCookie)</code> 列出类名。',
          '按白名单 / 黑名单与系统类前缀过滤类名，避免在无关类上触发副作用（这是崩溃控制的第一步）。',
          '逐个类主动调用构造函数触发回填，调用前用 <code>before</code> + <code>setResult(null)</code> 堵住构造体，调用后在 <code>finally</code> 里立刻 unhook。',
          '把 <code>mCookie</code> 交给 native 层写出 dex 文件；用"cookie 里各 dex 的大小 + 文件是否已存在"做去重与增量，支持分轮补齐。',
          '遇到崩溃就用 <code>invokeDebugger</code> 打印出的类列表 + 黑名单缩小范围（README 明确提示：某些类可能继承了当前系统版本不存在的父类）。'
        ],
        result:
          '<p>README 给出了两条使用路径与产物位置：模块页选中目标 Apk、在 LSPosed 里激活并勾选对应 App、启动目标 App，' +
          'dump 出的 dex 落在 <code>/sdcard/Android/data/&lt;包名&gt;/dumpDex/</code> 下；' +
          'README 还附了一张"某最新企业抽取壳脱壳效果展示"的截图。</p>' +
          '<p>作者对适用面的表述是：<b>可以应对未对 Lsposed 设置有效检测的大部分的企业抽取壳和免费壳的 Dex 加固</b>。' +
          '<span class="pill warn">待核实</span>：README 没有给出样本清单、加固厂商名称与成功率统计，' +
          '所以"大部分"这个范围目前只能按作者自述理解，无法独立复核。</p>',
        terms: ['Xposed / LSPosed', 'IXposedHookLoadPackage', 'assets/xposed_init', '主动调用', '抽取壳',
                'ClassLoader', 'BaseDexClassLoader', 'DexPathList.make*Elements', 'DexFile.mCookie',
                'getClassNameList', 'JNI 全局引用', 'native hook 通道', 'scope'],
        limits:
          '<p>这个项目的价值有一半在它的"局限性"一节——作者写得非常具体，逐条照录：</p>' +
          '<p>① <b>只能对抗类级别的方法抽取</b>；方法粒度的抽取无法进行；' +
          '也无法应对"方法执行结束后重新抽取"的情况，以及"真正开始执行字节码才动态解密"的情况。<br>' +
          '② 便捷性不足，一些崩溃问题可能需要参考崩溃日志分析，<b>不算很完善</b>。<br>' +
          '③ <b>基于 Android 9.0+ 开发</b>，未适配 Android 7 系列及以下，Android 8 未知。<br>' +
          '④ <b>JNI 全局引用数量超过 51200 个会导致崩溃</b>——类太多时要重新跑一轮脱剩下的类' +
          '（配置不用改，会自动识别并跳过已 dump 的类）。<br>' +
          '⑤ <b>高度依赖 Lsposed 的隐蔽性，如果 Lsposed 被检测则会直接闪退无法进行脱壳。</b><br>' +
          '⑥ 对"继承了当前系统版本不存在的类"的类做主动调用实例化，可能导致崩溃，' +
          '需要观察 <code>invokeDebugger</code> 的结束类并把它加进黑名单。<br>' +
          '⑦ README 自嘲"UI 写得有点草率"（原文带删除线）。</p>' +
          '<p>另外两点是 README 明说但容易被忽略的：<b>Hook 模式"不推荐使用"</b>（原因写在代码注释里：' +
          'hooking <code>onCreate</code>/<code>attachBaseContext</code> 很容易被检测出来）；' +
          '以及"Frida 式的样本覆盖度"在这里没有任何承诺——作者没有声称它通吃所有壳。</p>',
        analysis:
          '<p><b>这个案例是 22.8 那节课的现实版本，而且它把"为什么"写在了代码注释里。</b></p>' +
          '<p><b>第一，它印证了"找类失败是加载器问题，不是类名问题"。</b>' +
          '整个工具的起点不是"我想 hook 哪个方法"，而是一段 <code>getRealClassLoader()</code>：' +
          '从 <code>ActivityThread.mBoundApplication.info</code> 反查到 LoadedApk 再拿到加载器。' +
          '这正是第 2 章讲的<b>双亲委派</b>在另一条工具链上的实现——' +
          '<span class="hit">你在 Frida 里用 <code>Java.enumerateClassLoaders</code> 干的事，' +
          '在 Xposed 这边就是沿着 ActivityThread 的引用链把那个加载器挖出来。</span></p>' +
          '<p><b>第二，它的主动调用与第 2 章 FART 完全同构，只是换了执行层。</b>' +
          'FART 遍历 DexFile × 类 × 方法强制 <code>Invoke</code>，目的是触发抽取壳回填；' +
          'JDex2 走 <code>getClassNameList(mCookie)</code> → <code>findClass</code> → <code>newInstance</code>，' +
          '目的完全一样。<b>区别只在"从 ART 内部搬到了 Java 反射层"</b>——代价是能力受限于 Java 能摸到的接口，' +
          '好处是不用刷机。这就解释了它的第一条局限：<b>方法粒度的抽取它做不到</b>，' +
          '因为它能触发的只是"类被使用 / 对象被构造"这个层级的事件。</p>' +
          '<p><b>第三，它把"hook 是痕迹"这件事写进了代码。</b>' +
          '<code>finally</code> 里那句 <code>unhook()</code> 的注释说得很清楚：' +
          '某些加固会检测"方法是否被转为 native"。也就是说，作者<b>知道自己每次挂 hook 都在增加暴露面</b>，' +
          '所以用完立刻撤。<span class="hit">这正是 22.11 节的命题：你的观测手段本身就是对手的检测项。</span></p>' +
          '<p><b>第四，最值得学的是它对"两条路线"的取舍。</b>' +
          '默认走 Reflect（不 hook、睡 10 秒后反射 dump），把 Hook 模式标成"不推荐"。' +
          '这是一个非常清醒的权衡：<b>用时间换特征</b>——延迟 10 秒拿到加载器，' +
          '比在 <code>onCreate</code> / <code>attachBaseContext</code> 上留 hook 痕迹安全得多。' +
          '这跟第 13 章"用硬件断点代替软件断点"是同一种思路：<b>减少不可逆的改动</b>。</p>' +
          '<p><b>第五，它的局限第 ⑤ 条把本章的世界观差异说透了。</b>' +
          '"高度依赖 Lsposed 的隐蔽性，如果 Lsposed 被检测则会直接闪退无法进行脱壳"——' +
          '这就是 22.1 讲的"<b>环境检测面</b>"：Frida 被检测时你失去的是<b>这一次会话</b>；' +
          'LSPosed 被检测时你失去的是<b>整个运行环境</b>，而且没有降级方案。<br>' +
          '选路线的判断就在这里：<b>如果你的目标会做环境检测，常驻型方案的收益会被整体折价。</b></p>' +
          '<p>最后留一条方法论：README 里 <code>invokeConstructors</code>、<code>innerClassesFilter</code>、' +
          '<code>lazyDump</code>、白名单/黑名单这一堆开关，本质上是同一个工程约束的产物——' +
          '<b>JNI 全局引用有上限（作者给出的数字是 51200）</b>。' +
          '类太多会把引用打爆，所以它必须能"过滤、限速、分轮、跳过已 dump"。' +
          '<span class="hit">看清这一点，你就不会把这些开关当成"作者随意加的选项"，' +
          '而会看到它们各自对应一个具体的失败模式。</span></p>',
        link: 'https://github.com/J5now/JDex2',
        linkNote: 'README 给出的原帖在看雪（thread-290669）；看雪未登录访问需要人机验证，本次未能取到正文，' +
                  '因此所有技术细节均以 GitHub 仓库与源码为准'
      }
    },

    /* ============================================================ 22.9 */
    {
      h: '22.9', title: 'Native Hook（上）：先拿到"模块被加载"的时机',
      html:
        '<p>Java 层的 hook 有一条天然边界：<b>它只看得见 Java。</b>当加密逻辑被搬进 so、当校验在 native 层做、' +
        '当 native 方法通过动态注册和某个 C 函数绑定时，你在 Java 层能做的就很有限了。</p>' +
        T.tbl(['层', '看得见什么', '看不见什么', '谁负责给你"时机"'],
          [
            ['<b>Java 层</b>（Xposed API）', '方法调用、字段读写、类加载、构造过程',
             'so 内部逻辑、JNI 层的直接调用、指针级数据流', 'LSPosed 框架（handleLoadPackage）'],
            ['<b>Native 层</b>（模块自己的 so + hook 库）', 'so 里的函数、<code>JNIEnv</code> 函数表、' +
             '<code>dlopen</code> 的瞬间',
             'Java 对象的语义（要反过来用 JNI 反射去映射）', '<b>模块自己</b>——这就是本节要讲的难点']
          ]) +
        '<p>关键问题不在"用什么 hook 库"，而在<b>你怎么知道该 hook 的时候到了</b>。' +
        '一个 App 会加载很多 so，你要 hook 的那个往往是后来才 <code>dlopen</code> 进来的；' +
        '你的 native 代码如果没有一个可靠的"被唤醒"入口，就只能靠轮询或盲猜。</p>' +
        T.note('key', '🔑 Xposed 体系里 native hook 的共同前提：框架给你时机，引擎你自己出',
          '<p>LSPosed 官方 Wiki 把它写得很清楚（照官方 Wiki 的原文结构）：模块在自己的 so 里导出 ' +
          '<code>native_init</code>，框架把一组工具函数（<code>hook_func</code> / <code>unhook_func</code>）' +
          '交给你；此后<b>每当有一个库被加载，框架就回调你的 <code>on_library_loaded(name, handle)</code></b>，' +
          '你再用 <code>handle</code> 去 <code>dlsym</code> 并挂 hook。</p>' +
          '<p style="margin-bottom:0">这里有个容易被忽略的细节：<b><code>hook_func</code> 是框架提供的，不是你实现的。</b>' +
          'LSPosed 的 README 在 Credits 里写了它用 <b>Dobby</b> 做 inline hooking——' +
          '也就是说，Xposed 生态里的 native hook <b>不是让你从零造引擎，而是把框架已经有的那套能力借给你用</b>。' +
          '你要负责的只有两件事：<b>时机</b>（什么时候挂）和<b>目标</b>（挂谁）。</p>') +
        '<p>官方文档里给出的接口定义（示意，照原文结构）：</p>' +
        T.code(
          '<span class="c">// if success, return 0</span>\n' +
          '<span class="k">typedef int</span> (*HookFunType)(<span class="k">void</span> *func, <span class="k">void</span> *replace, <span class="k">void</span> **backup);\n' +
          '<span class="k">typedef int</span> (*UnhookFunType)(<span class="k">void</span> *func);\n\n' +
          '<span class="c">// 每个库被加载时，框架回调它</span>\n' +
          '<span class="k">typedef void</span> (*NativeOnModuleLoaded)(<span class="k">const char</span> *name, <span class="k">void</span> *handle);\n\n' +
          '<span class="k">typedef struct</span> {\n' +
          '    uint32_t version;\n' +
          '    HookFunType hook_func;\n' +
          '    UnhookFunType unhook_func;\n' +
          '} NativeAPIEntries;\n\n' +
          '<span class="c">// 你在自己的 so 里导出的入口</span>\n' +
          '<span class="k">extern</span> <span class="s">"C"</span> [[gnu::visibility(<span class="s">"default"</span>)]] [[gnu::used]]\n' +
          'NativeOnModuleLoaded <span class="f">native_init</span>(<span class="k">const</span> NativeAPIEntries *entries);'
        ) +
        T.note('', '📌 三个必须对齐的地方',
          '<p>① <b>导出名字必须是 <code>native_init</code></b>，而且要被导出（文档里强调了 ' +
          '<code>visibility("default")</code> 与 <code>used</code> 两个属性）——否则框架找不到它，' +
          '表现就是"什么都没发生"。<br>' +
          '② <b>你还要在 <code>assets/native_init</code> 里写上你的 so 名字</b>，' +
          '这和 Java 入口要写 <code>assets/xposed_init</code> 是同一个道理：先声明，框架才知道去找谁。<br>' +
          '③ <b>so 得由你自己加载</b>：官方文档写明要在模块的 Java 代码里 <code>System.loadLibrary</code>。' +
          '这意味着 native hook 的<b>时机最终由你的 Java 代码决定</b>——' +
          '如果你在错的进程或错的作用域里尝试加载，回调永远不会来。</p>' +
          '<p style="margin-bottom:0">第 ③ 条把本章串起来了：<b>native hook 的门票，是 Java 层那张入场券。</b></p>') +
        '<p>本节与 22.10 的接口细节，来源是 LSPosed 官方 Wiki 的 ' +
        '<a href="https://github.com/LSPosed/LSPosed/wiki/Native-Hook" target="_blank" rel="noopener">Native Hook</a> ' +
        '页面（本次通过 wiki 的 raw Markdown 取到原文，HTTP 200）。凡涉及版本与实现的部分我都标了待核实——' +
        '接口文档写的是"入口长什么样"，它<b>不承诺</b>版本兼容与检测对抗。</p>' +
        '<p>还有一点值得单独指出：官方文档在"JNIEnv Hooks"一节里提到，' +
        '可以 hook <code>JNIEnv</code> 的函数（比如 <code>FindClass</code>），' +
        '并给出了一个"对某个特定类返回 <code>nullptr</code>"的示例。' +
        '这是<b>改函数表指针</b>级别的手段——威力很大，副作用也很大（任何一方调用它加载那个类都会失败）。' +
        '这属于 22.10 要讲的第三类落点，我们放到那里一起对比。</p>',
      after: T.note('ok', '✅ 这一节的判断',
        '<p style="margin-bottom:0"><b>Java 层 hook 解决"业务语义"，native hook 解决"so 里的实现细节"。</b><br>' +
        '而 native hook 真正的门槛不是 hook 引擎（框架已经用 Dobby 给你了），' +
        '而是<b>你能不能在正确的时机、把正确的 so 名字交到框架手上</b>。</p>')
    },

    /* ============================================================ 22.10 */
    {
      h: '22.10', title: 'Native Hook（下）：JNI_OnLoad、RegisterNatives 与函数指针',
      html:
        '<p>过了"时机"这一关，接下来才是"挂在哪"。native 层有三个最常被下手的落点，' +
        '它们的覆盖面与代价完全不同。</p>' +
        T.tbl(['落点', '你在挂什么', '能看到什么', '代价 / 风险'],
          [
            ['<b>① <code>JNI_OnLoad</code></b>', 'so 被加载时系统回调的那个函数',
             'so 的加载瞬间、以及它拿到的 <code>JavaVM</code>——进而可以拿 <code>JNIEnv</code>',
             '很多壳<b>自己也盯这里</b>（第 20、13 章都提过）；改它等于把自己摆在最显眼的位置'],
            ['<b>② <code>RegisterNatives</code></b>', 'JNI 动态注册的入口（第 20 章讲过它的注册语义）',
             '<code>Java 方法 → native 函数地址</code>的绑定关系，一次全收',
             '第 13 章列过它的五种绕过手法（延迟/分次注册、反复注销重注册、绕过它直接改 ART 内部入口……）；' +
             '你抓到的那份地址表<b>可能很快就过期</b>'],
            ['<b>③ 函数指针 / 函数表</b>', '直接改目标函数的入口（inline hook），' +
             '或改导入表、改 <code>JNIEnv-&gt;functions</code> 里的函数指针',
             '想挂什么就挂什么，粒度最自由',
             '<b>必然修改内存</b>：首字节、校验和、自校验都能发现；而且一旦对手重新注册/换实现，' +
             '你的 hook 会<b>静默失效</b>（不报错，只是不再触发）']
          ]) +
        T.note('warn', '⚠️ 与第 13 章的分工，这里必须说清楚',
          '<p>第 13 章给出的结论是硬的：<b>高对抗场景下，"硬件断点 + 不改内存"那条路更优。</b>' +
          '理由有三条，放在 native hook 的语境里同样成立：</p>' +
          '<p>① <b>检测面</b>：inline hook 一定改写函数头几个字节。对手读首字节、算校验和、比对代码段，' +
          '都能发现（第 10 章检测点⑥专门讲过这一类"通用 hook 痕迹检测"）。' +
          '硬件断点由 CPU 调试寄存器完成地址匹配，<b>目标内存一个字节都不变</b>。</p>' +
          '<p>② <b>时机对抗</b>：inline hook 需要你先找到地址、再成功写入；' +
          '如果对手在你写完之后又改回来（或重新注册一遍），你会<b>静默失效</b>——没有报错，只是不触发了。' +
          '而硬件断点监控的是"这个地址被写入"这个<b>事件本身</b>，反而能抓到对手的动作。</p>' +
          '<p style="margin-bottom:0">③ <b>名额与代价</b>：硬件断点通常只有 4–6 个名额，不可能大规模布点；' +
          'inline hook 可以铺满。所以正确的用法不是二选一，而是：' +
          '<b>用 hook 铺面，用断点定关键点。</b></p>') +
        '<p>下面这个终端模拟的是 native hook 最难受的一种失败现场：<b>它曾经是对的，后来悄悄不对了。</b></p>',
      term: {
        title: '一个"hook 突然不再触发"的现场（示意输出）',
        lines: [
          { t: 'd', s: '# T+0s：模块加载，on_library_loaded 收到目标 so' },
          { t: 'o', s: '[jdex] module loaded, native_init done', note: '<b>入口通了。</b>说明 assets/native_init 与 System.loadLibrary 这两步都对。' },
          { t: 'o', s: '[jdex] dlopen: /data/app/.../libtarget.so  handle=0x7f3c...', note: '<b>时机抓到了。</b>框架把每个库的加载都告诉了你——这正是 22.9 说的"时机由框架给"。' },
          { t: 'p', s: 'dlsym(handle, "native_check") -> 0x7f3c9e40', note: '<b>拿到地址。</b>接下来这一步是分水岭：你是"改内存"（inline hook），还是"不改内存"（下断点）。' },
          { t: 'o', s: '[jdex] hook installed: native_check @ 0x7f3c9e40', note: '（示例选择 inline hook。）<b>注意这里已经写内存了</b>：函数头几个字节被改成跳转。' },
          { t: 'd', s: '# T+5s：目标函数被调用，hook 正常' },
          { t: 'o', s: '[jdex] native_check called: arg0=0x1', note: '<b>一切正常。</b>此时你看不出任何异常——这就是它危险的地方。' },
          { t: 'd', s: '# T+300s：目标 App 完成初始化' },
          { t: 'e', s: '[jdex] ...（此后没有任何输出）', note: '<b>hook 不再触发。</b>没有报错、没有异常，日志就停在上一行。' },
          { t: 'w', s: 'Warning: 静默失效比崩溃难查一百倍', note: '<b>因为"什么都没发生"既可能是没被调用，也可能是你的 hook 已经被换掉了。</b>这两件事在日志上长得一模一样。' },
          { t: 'd', s: '# 排查方向' },
          { t: 'o', s: '① 读一下 0x7f3c9e40 开头的字节，还在不在？', note: '<b>先确认你的 hook 有没有被覆盖。</b>如果不在了，说明对手重写了这块内存（或换了函数实现）。' },
          { t: 'o', s: '② 重新枚举一遍 RegisterNatives 的绑定关系，地址变了没有？', note: '<b>再看地址有没有被换。</b>反复 注销/重注册 是第 13 章列的绕过手法之一——你 hook 的那个地址可能已经成了"孤儿"。' },
          { t: 'o', s: '③ 改成监控"入口被写入"这个事件，而不是盯着某个地址', note: '<b>这是第 13 章的思路。</b>不去追地址，而去追"谁改了入口"——不管走哪条路径绑定，最终都要往入口里写一个地址。' }
        ]
      },
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: 'inline hook 静默失效',
            scenario: '<b>情境：</b>你在模块的 native 代码里 hook 了目标 so 的一个关键函数（inline hook），' +
              'T+5 秒时日志正常，T+300 秒之后<b>再也没有输出</b>。没有异常、没有崩溃。' +
              '你确认过：目标函数确实还在被调用（从别的地方能看到它的效果）。',
            q: '最合理的解释与下一步是什么？',
            choices: [
              { t: '你 hook 的那个<b>地址已经过期</b>——对手重新注册/替换了实现，入口被写成了别的地址；' +
                   '应该改为监控"入口被写入"这个事件（观察点/硬件断点），或去 hook 注册动作本身', next: 'n1' },
              { t: '加固检测到了 hook，主动把 hook 卸载了；应该换一个更隐蔽的 hook 库', next: 'n2' },
              { t: '你的 hook 库有 bug，在长时间运行后失效了；应该换用更成熟的库', next: 'n3' },
              { t: '目标 so 被卸载了（dlclose），所以 hook 也不再被调用', next: 'n4' }
            ]
          },
          n1: {
            terminal: true, verdict: 'good', verdictTitle: '对：地址会过期，事件不会',
            result: '<p><b>你抓住了 native hook 最本质的脆弱点：inline hook 绑定的是"一个地址"，而这个地址是可以被换掉的。</b><br>' +
              '典型手法（第 13 章列过）：<code>UnregisterNatives</code> 之后重新 <code>RegisterNatives</code>，' +
              '把方法入口指向新的实现；或者干脆绕过注册接口直接改 ART 内部的方法入口。' +
              '无论哪种，你原来写入的跳转都挂在一个<b>不再被走到</b>的地址上——它还在内存里，只是没人来了。<br>' +
              '正确方向：<b>把观测点从"某个地址"移到"地址被写入这个事件"</b>——' +
              '在保存方法入口的那块内存上下观察点，或在 ART 内部"入口被写入"的位置下硬件断点。' +
              '<b>不管走哪条绑定路径，最终都要往入口里写一个地址</b>，所以这个事件是绕不过去的。<br>' +
              '<span class="hit">而这也顺带解决了检测问题：硬件断点/观察点不改内存，对手的自校验抓不到。</span></p>'
          },
          n2: {
            terminal: true, verdict: 'bad', verdictTitle: '症状对不上"被检测"',
            result: '<p><b>认知根源：你把"静默"当成了"对抗"，但被检测的典型表现不是这样的。</b><br>' +
              '如果对手真的检测到了你的 inline hook，它更可能<b>闪退、弹窗、走假逻辑、或者直接拒绝启动</b>——' +
              '因为它已经确认了环境不可信，没必要还陪你把函数跑完。<br>' +
              '而你描述的是：<b>T+5 秒正常，T+300 秒后停</b>——这是一个"先好后坏"的时间序列，' +
              '说明变化发生在运行过程中，而不是启动时的检测。<br>' +
              '<span class="miss">换 hook 库解决不了这个问题：不管哪个库，它改的都是同一块内存、绑的都是同一个地址。</span></p>'
          },
          n3: {
            terminal: true, verdict: 'bad', verdictTitle: '先看现象，再怀疑工具',
            result: '<p><b>认知根源：你把"工具不成熟"当成了默认解释。</b><br>' +
              'hook 库确实可能有 bug，但它的典型表现是崩溃、错误跳转、参数错乱——' +
              '而不是"前 5 分钟完美、之后完全静默"。<br>' +
              '更关键的是：<b>即使换了库，只要路线还是 inline hook，你面对的是同一个物理事实</b>——' +
              '你写下的跳转依附于一个可以被替换的地址。<br>' +
              '<span class="hit">诊断顺序应该是：先确认"我的 hook 还在不在内存里"（读一下函数头几个字节），' +
              '再确认"这个地址还在不在被调用"。这两步用五分钟能做完，比换库快得多。</span></p>'
          },
          n4: {
            terminal: true, verdict: 'bad', verdictTitle: '卸载会一起带走你的代码，不是悄悄停',
            result: '<p><b>认知根源：你没有区分"hook 不触发"和"代码不在内存里了"这两种状态。</b><br>' +
              '如果目标 so 真的被 <code>dlclose</code>，通常会连带引发引用计数问题、后续调用崩溃、' +
              '或者你的 hook 库里备份的原函数指针变成野指针——<b>更常见的表现是崩</b>，而不是安静。<br>' +
              '而且 App 的关键 so 一般不会在运行中被卸载（它们被全局持有）。<br>' +
              '<span class="miss">"什么都没发生"这种情况，优先怀疑"我的观测点不再被执行到"，' +
              '而不是"目标消失了"。</span>——毕竟你已经确认目标函数还在被调用。</p>'
          }
        }
      },
      quiz: {
        id: 'q22-6', chapter: 22, answer: 0,
        stem: '在 Xposed 体系里做 native hook，与第 13 章讲的"硬件断点 + 不改内存"相比，' +
              '最本质的差别是什么？',
        options: [
          { t: 'inline hook 必须改写目标内存（函数头/函数表），因此会被校验类检测发现，' +
               '而且当对手更换实现时会静默失效；硬件断点由 CPU 调试寄存器匹配地址，一个字节都不改',
            why: '正确。这是"改内存"与"不改内存"两条路线的根本分界。' },
          { t: 'inline hook 只能 hook 导出函数，硬件断点能 hook 所有函数',
            why: '断点确实能作用在任意地址上，但这不是二者的本质差别（inline hook 只要能拿到地址也能挂）。' },
          { t: 'inline hook 需要 root，硬件断点不需要', why: '两者都需要底层权限，这不是区分点。' },
          { t: 'inline hook 只能用于 Java 层，硬件断点只能用于 native 层',
            why: '两者都是 native 层手段，方向搞反了。' }
        ],
        explain: '<b>本质差别是"要不要动目标内存"。</b><br><br>' +
          '<b>inline hook：</b>把目标函数开头几个字节改成跳转。优点是可以大量布点、粒度自由；' +
          '代价是两个——<br>' +
          '① <b>必然留下痕迹</b>：首字节变了、代码段校验和对不上。' +
          '第 10 章检测点⑥讲的就是这类检测，而且它<b>对任何 inline hook 一视同仁</b>（不区分是你还是 Frida）。<br>' +
          '② <b>绑定的是地址，而地址会被换掉</b>：对手重新注册/替换实现后，你的跳转还写在旧的地址上，<br>' +
          '从此<b>静默失效</b>——不报错、不崩溃，只是不再触发。这种失败最难查，因为你分不清' +
          '"没被调用"和"hook 已经不在链路上"。<br><br>' +
          '<b>硬件断点：</b>地址匹配在 CPU 内部完成，<b>目标内存一个字节都不变</b>，因此对自校验完全隐形；' +
          '而且它监控的是"执行/写入到这个地址"这个事件，<b>对手换实现的动作本身就会被你看到</b>。<br>' +
          '代价是名额少（通常 4–6 个），不可能铺满。<br><br>' +
          '<span class="hit">所以结论不是"谁更好"，而是分工：<b>用 hook 铺面，用断点定关键点。</b></span>'
      }
    },

    /* ============================================================ 22.11 */
    {
      h: '22.11', title: '检测与对抗：Xposed 的暴露面在哪',
      intuition: {
        tag: '直觉模型 · 门禁系统自己的破绽',
        body:
          '<p>回到 22.1 那个类比：你给整栋楼换了一套门禁系统。住户用起来一切正常——' +
          '门还是那扇门，刷卡还是那张卡。<b>但楼里多了几个不该有的东西</b>：' +
          '门口多了一台读卡器、配电间多了一条线、门框的螺丝换过。</p>' +
          '<p>风控要找的从来不是"你现在是不是被接上了"，而是<b>"这栋楼有没有被动过"</b>。</p>' +
          '<p>所以 Xposed 的检测项，几乎全都是<b>环境取证</b>：进程表里多了什么、内存映射里多了什么、' +
          '某个函数的入口是不是被换过、类加载器的链条是不是多了一环。<br>' +
          '这也解释了为什么这一节的结论会有点扫兴：<b>你能减少暴露面，但不能把痕迹归零。</b></p>'
      },
      html:
        '<p>下面六类检测面，按"对手取证的成本"从低到高排。每一条我都写清<b>它为什么成立</b>——' +
        '因为只有知道它为什么成立，你才知道哪些对抗是有效的、哪些只是心理安慰。</p>' +
        T.tbl(['检测面', '对手在查什么', '为什么成立'],
          [
            ['<b>① 内存映射 / 模块列表</b>',
             '读 <code>/proc/self/maps</code> 等，找模块的 so 路径、找 Zygisk / Riru 的注入痕迹',
             '你的模块代码必须以某种形式存在于进程内存里。Xposed 时代查的是 <code>XposedBridge.jar</code> 一类的特征；' +
             'LSPosed 时代特征变成了注入的 so 与模块自身的 so 路径。' +
             '<span class="pill warn">待核实</span>：具体特征项随实现与版本变化，以对应版本的源码为准'],
            ['<b>② 方法入口特征</b>',
             '检查关键方法的入口有没有被替换、有没有被 deoptimize，或"这个方法是不是被转成了 native"',
             'hook 的实现方式决定了它必须在 ART 层改方法的入口（LSPosed 用 LSPlant）。' +
             '22.8C 那个案例的代码注释里就直接点出了这一条：某些加固会检测"方法是否被转为 native"'],
            ['<b>③ StackTrace / 调用栈异常</b>',
             '主动抛异常读栈，找陌生帧；或检查"谁调用了这个方法"是不是符合预期',
             'Xposed 早期实现会在栈里留下非常明显的框架帧；换成 ART hook 之后栈帧特征弱了很多，' +
             '<b>但"某个方法被不该存在的调用者调用"这个矛盾依然存在</b>'],
            ['<b>④ ClassLoader 链异常</b>',
             '遍历加载器链、看 <code>DexPathList</code> 里有没有多出来的元素',
             '注入、脱壳、插件化都会在加载器链上留下痕迹。' +
             '<span class="hit">第 2 章讲的"双亲委派"在这里从工具变成了检测面。</span>'],
            ['<b>⑤ 系统完整性</b>',
             '属性、<code>/proc</code> 内容、SELinux 上下文、设备指纹的一致性',
             '改过 Zygote 注入链路的系统，在这些地方往往会有不自洽。' +
             '第 16 章的 <code>tcontext=u:r:magisk:s0</code>、第 18 章讲的环境自洽，都是同一类取证思路'],
            ['<b>⑥ 行为侧信道</b>',
             '某方法的执行时间、调用次数、返回值的分布是否异常',
             '<b>最难对抗的一类。</b>它不找特征，只看行为：' +
             '一个"应该耗时 30ms 的校验"突然变成 3ms，或者原本每次都不同的返回值变得恒定——' +
             '这本身就是强烈的信号']
          ]) +
        T.note('key', '🔑 检测的本质是环境取证，不是"抓现行"',
          '<p style="margin-bottom:0">这六条里只有第②条是"抓你的 hook 现行"，其余五条都在问同一个问题：' +
          '<b>这台机器的系统还是不是原装的？</b><br>' +
          '所以"我把 hook 写得很隐蔽"能防的是第②条；<b>它防不了①③④⑤⑥</b>——' +
          '因为那些痕迹不是你这次 hook 留下的，而是"装过 LSPosed"这件事留下的。<br>' +
          '这就是 22.1 那句判断的完整含义：<b>Frida 被检测，你丢的是一次会话；LSPosed 被检测，你丢的是整个环境。</b></p>') +
        '<p>那么对抗的边界在哪？我给三条实际可用的原则，而不是安慰性的口号：</p>' +
        '<p><b>① 减少暴露面，而不是"隐藏"暴露面。</b>' +
        '作用域只勾必须的 App（22.2 讲过 LSPosed 连"全选"都不提供，就是这个道理）；' +
        'hook 点压到最少；能用一次性的方式（等到真实加载器再动手）就不要用常驻的 hook。' +
        '22.8C 那个案例的默认模式就是这个思路：<b>延迟 10 秒、不挂任何 hook、直接反射 dump</b>。</p>' +
        '<p><b>② 该换路线的时候换路线。</b>如果目标会做环境检测，' +
        '常驻型方案的收益是会被整体折价的。这时候值得考虑的不是"怎么藏得更好"，而是' +
        '<b>"有没有不需要常驻环境的做法"</b>——例如不修改系统的方案（LSPosed 生态里就有非 root 的分支，' +
        'LSPatch 一类，<span class="pill warn">待核实</span>：其适用范围与当前维护状态请以官方仓库为准）、' +
        '或者改用一次性注入的 Frida 路线（代价见第 21 章），或者干脆放弃 hook、走模拟执行（第 7 章）。</p>' +
        '<p><b>③ 承认有的东西藏不住。</b>' +
        '"装过 LSPosed 的机器"与"原装机"之间的差异不可能被完全抹平。' +
        '这不是技术不够，而是<b>目标本身就不一样</b>：你的进程里确实多了一段别人的代码。' +
        '<span class="hit">承认这条边界的实际价值是：你不会再把时间花在"找到一个完美的隐藏方案"上，' +
        '而是会去评估"这个目标值得我用哪种暴露面去换"。</span></p>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '目标有环境检测',
            scenario: '<b>情境：</b>目标 App 有 root 检测，并且额外检查 Zygisk / Riru 的注入痕迹——' +
              '它不针对你的模块，它针对的是"系统被改过"这件事。你手里只有一台装了 Magisk + LSPosed 的设备。',
            q: '要长期监控这个 App 的加密调用，你的判断是什么？',
            choices: [
              { t: '还能做，但要重新设计暴露面：作用域只勾这一个 App、hook 点压到最少、' +
                   '优先用"不改方法的观测方式"；同时并行评估不常驻的路线（非 root 方案 / 一次性注入 / 模拟执行），' +
                   '把常驻方案只当作备选', next: 'n1' },
              { t: '把 root 隐藏好就行：Magisk 的 DenyList 加进去，模块照样用', next: 'n2' },
              { t: '换 Frida：它是按需注入的，目标检测不到', next: 'n3' },
              { t: '加更多 hook 去伪装：把检测用到的属性、包列表、maps 内容都改掉，做一套完整的环境自洽', next: 'n4' }
            ]
          },
          n1: {
            terminal: true, verdict: 'good', verdictTitle: '对：把选择变成一道"暴露面预算"的题',
            result: '<p><b>你没有在"能不能用"上纠缠，而是把它改写成了"用多少暴露面换多少收益"。</b><br>' +
              '这就是本章的落点。具体到操作：<br>' +
              '· <b>收窄</b>：作用域只勾目标 App（LSPosed 不支持全选，本身就是让你这么用）；' +
              '进程名判准，别在子进程里也跑一遍；<br>' +
              '· <b>降数量</b>：每个 hook 点都是一次 ART 层的入口改写（22.11 检测面②），' +
              '能用一个点解决就不要挂三个；<br>' +
              '· <b>选方式</b>：优先"不改目标方法"的观测方式，把最关键的几个点交给"不修改内存"的手段；<br>' +
              '· <b>留后手</b>：同时评估非常驻路线，因为常驻方案一旦被环境检测否掉，' +
              '它是<b>整体失效</b>而不是局部失效（22.8C 的局限第⑤条就是活例子）。<br>' +
              '<span class="hit">记住这个判断框架：<b>先算暴露面预算，再决定用哪条路线</b>——' +
              '而不是先选好路线，再去想办法解释暴露面。</span></p>'
          },
          n2: {
            terminal: true, verdict: 'bad', verdictTitle: '你把"隐藏 root"当成了"隐藏注入"',
            result: '<p><b>认知根源：你把两个不同的检测对象混成了一个。</b><br>' +
              'DenyList 解决的是"<b>这台设备有 root</b>"这件事：隐藏 root 管理器的包、隐藏 <code>su</code> 路径、' +
              '隐藏相关属性。<br>' +
              '但你的场景里，对手额外检查的是"<b>Zygisk / Riru 的注入痕迹</b>"——' +
              '也就是"<b>进程里/系统里有没有被塞进别人的代码</b>"。这是另一个问题：<br>' +
              '· 隐藏 root 之后，你的进程里<b>依然运行着模块的代码</b>；<br>' +
              '· 目标的方法入口<b>依然被改写过</b>（检测面②）。<br>' +
              '<span class="miss">这两件事不可能靠"把 root 藏起来"解决。</span>' +
              '先分清对手问的是哪个问题，再谈对策。</p>'
          },
          n3: {
            terminal: true, verdict: 'bad', verdictTitle: 'Frida 不是"检测不到"，是"暴露面不同"',
            result: '<p><b>认知根源：你把"按需注入"理解成了"没有痕迹"。</b><br>' +
              'Frida 的暴露面集中在进程侧：注入线程名、agent 的内存映射、默认端口、以及（如果用了 inline hook）' +
              '被改写的函数头。第 10 章整节都在讲这些检测点，第 21 章则专门讲怎么去掉这些特征。<br>' +
              '对一个"已经在做环境/注入检测"的目标来说，Frida 往往<b>更容易被查</b>，而不是更安全——' +
              '因为它要在目标进程里留下一整套运行时。<br>' +
              '<span class="hit">正确的说法是：<b>两者暴露在不同维度上</b>。' +
              'Frida 暴露在"进程被接上了"，LSPosed 暴露在"环境被改过"。选哪个，取决于对手查的是哪一类。</span></p>'
          },
          n4: {
            terminal: true, verdict: 'bad', verdictTitle: '每一次伪装都在增加不自洽的风险',
            result: '<p><b>认知根源：你把"覆盖检测项"当成了可以无限叠加的加法。</b><br>' +
              '"环境自洽"这个思路本身没错（第 18 章就是这么讲云手机的）——错在把它当成万能解：<br>' +
              '· 每一个伪装点都是<b>一个新的代码路径</b>，也是一个新的暴露面；<br>' +
              '· 伪装越多，<b>互相之间越容易矛盾</b>：你改了 maps 里的某个条目，' +
              '却忘了 <code>/proc</code> 里另一处会露出同一份数据；' +
              '· 而且你是在<b>被动跟随</b>对手的检测清单——他加一条你补一条，永远慢一步。<br>' +
              '<span class="miss">这就是第 18 章那句话的另一面：<b>伪装不是改一个返回值，而是让所有证据面互相对得上账。</b>' +
              '账本越厚，越容易记错。</span><br>' +
              '更实际的问法不是"我还能补哪些检测项"，而是"<b>这个目标值不值得我维持这么大一套伪装</b>"。'
          }
        }
      },
      quiz: {
        id: 'q22-7', chapter: 22, answer: 0,
        stem: '为什么说 Xposed / LSPosed 的检测对抗，比 Frida 的"去特征"更难？',
        options: [
          { t: '因为 LSPosed 的痕迹是"系统被改过"这类环境痕迹——它不依赖你当前是否接上，' +
               '所以无法通过"这次不注入"来规避',
            why: '正确。这正是 22.1 讲的"检测面在环境 vs 在进程"的延伸。' },
          { t: '因为 LSPosed 的代码不能修改，所以特征去不掉', why: 'LSPosed 是开源的，可以自编译，这不是根本原因。' },
          { t: '因为 Frida 的端口和线程名本来就是标准行为，不算特征',
            why: '恰恰相反，端口与线程名是 Frida 最典型的特征之一（第 10 章）。' },
          { t: '因为 LSPosed 只支持高版本 Android，高版本检测更严',
            why: '版本因素存在，但不是"更难"的根本原因。' }
        ],
        explain: '<b>根本区别在"痕迹的归属"。</b><br><br>' +
          '<b>Frida 的痕迹属于"这次会话"</b>：agent 映射、注入线程、端口、被改写的函数头。' +
          '只要你不 attach，这些痕迹就不存在。所以去特征是有明确靶子的——' +
          '改端口、改线程名、编译 hluda、改用硬件断点（第 21、13 章）。<br><br>' +
          '<b>LSPosed 的痕迹属于"这台设备"</b>：Zygote 注入链路、模块 so 的映射、' +
          '被替换的方法入口、加载器链上的变化。<b>哪怕你今天不运行任何 hook，这些差异依然存在</b>——' +
          '因为模块已经在每个作用域进程里了。<br><br>' +
          '所以对抗的形态也不同：Frida 是"隐藏这一次的痕迹"，LSPosed 是"否认这台机器被改过"。' +
          '前者的靶子小、可穷尽；后者的靶子大、且永远做不到 100%。<br><br>' +
          '<span class="hit">最实际的做法因此不是"藏得更好"，而是<b>把暴露面当成预算来花</b>：' +
          '作用域只勾必要的 App、hook 点压到最少、并准备好一条不需要常驻环境的备选路线。</span>'
      }
    },

    /* ============================================================ 22.12 */
    {
      h: '22.12', title: '用 Xposed 给自己脱壳：第 2 章的思路换到另一条工具链',
      html:
        '<p>第 2 章给了脱壳的元原则：<b>在壳把真 dex 解密到内存、结构完整、但还没藏回去的那一刻把它取出来</b>；' +
        '对抽取壳则要<b>主动调用逼它回填方法体</b>。这一节讲的是：同一件事，用 Xposed / LSPosed 怎么做。</p>' +
        '<p>五个动作，全部落在前面讲过的地方：</p>' +
        T.step('①', '拿到壳替换后的真实加载器',
          '这是所有事情的前提。Xposed 这边的常规路径是从 <code>ActivityThread</code> 的 ' +
          '<code>mBoundApplication</code> → <code>info</code>（LoadedApk）→ <code>getClassLoader()</code> 反查' +
          '（22.8C 的 JDex2 用的就是这条链）。<br>' +
          '<span class="hit">和第 2 章 Frida 那边枚举加载器是同一个目的：<b>找到真正负责目标类的那个加载器。</b></span>') +
        T.step('②', '从加载器里把 DexFile 掏出来',
          '要求它是 <code>BaseDexClassLoader</code>：取 <code>pathList</code> → <code>dexElements[]</code> → ' +
          '每个元素的 <code>dexFile</code> 字段。有多少个 dex 都要拿到——第 2 章强调过"多 dex"，' +
          '加固会把关键代码放在后面的 dex 里。') +
        T.step('③', '从 DexFile 拿到能落盘的句柄',
          'Xposed 侧读到 <code>DexFile.mCookie</code>（<code>long[]</code>），把它交给 native 层写文件。' +
          'JDex2 的做法就是两个 native 方法：<code>dumpDexByCookie(cookie, outDir)</code> 与 ' +
          '<code>getDexSizesByCookie(cookie)</code>。<br>' +
          '为什么用 native 写？因为 <code>mCookie</code> 背后是 ART 的 dex 内存结构，' +
          '用 Java 的输入输出流是拿不到的。<b>这一步把 22.9 的 native 通道用上了。</b>') +
        T.step('④', '主动调用触发回填（针对抽取壳）',
          '<code>DexFile.getClassNameList(mCookie)</code> 列出类名 → <code>findClass</code> → ' +
          '对每个类主动调用它的构造函数（或其他能触发使用的方法）。<br>' +
          '与第 2 章 FART 的"遍历所有方法强制调用"是同一件事，只是粒度更粗：' +
          'FART 能精确到方法，Java 反射这边主要能做到"类被使用 / 对象被构造"。' +
          '<b>这就是为什么这类工具通常只能对付类级别的抽取。</b>') +
        T.step('⑤', '增量与去重（这一条最容易被忽略，但决定能不能成功）',
          'JDex2 用 cookie 取每个 dex 的大小、检查输出文件是否已存在，从而支持"<b>分两轮脱壳</b>"：' +
          '第一轮把能脱的脱掉，崩溃或引用耗尽后改配置再跑第二轮，自动跳过已 dump 的类。<br>' +
          '为什么必须这样？因为 <b>JNI 全局引用有上限</b>（README 给出的数字是 51200），' +
          '类多到一定程度必然撞墙。<span class="hit">这是"工程约束倒逼设计"的典型：' +
          '不是作者想加这个开关，而是不加就跑不完。</span>') +
        T.tbl(['', '第 2 章：FART / 改 ART 路线', '本章：Xposed / LSPosed 模块路线'],
          [
            ['<b>改动面</b>', '改 ART 源码、编译、刷机', '装一个模块，勾一下作用域'],
            ['<b>能力</b>', '能精确到方法粒度（方法抽取也能回填）', '通常只能到类级别；方法粒度抽取无能为力'],
            ['<b>随版本演进的成本</b>', '<b>高</b>：每个安卓大版本都要重新定位（第 12 章整章）',
             '<b>低</b>：把系统适配的活交给 LSPosed，你只跟 Java API 打交道'],
            ['<b>稳定性 / 可持久性</b>', '取决于你的 ROM，通常很稳',
             '取决于 LSPosed 自身不被检测——被检测即整体失效'],
            ['<b>最适合</b>', '长期、批量、对抗强度高的脱壳工程', '快速验证、单样本分析、迭代成本敏感的场景']
          ]) +
        T.note('key', '🔑 这条路线的真正优势不是"技术更强"',
          '<p style="margin-bottom:0">是<b>迭代成本低</b>：不用刷机、不用编译 ROM、不用等构建，' +
          '改几行 Java、重装模块、重启 App 就能重试。<br>' +
          '第 12 章那种"每个大版本重定位一次"的痛苦，在这里被 LSPosed 承担了——代价是' +
          '<b>你的能力上限也被 LSPosed 的接口限住了</b>（比如方法粒度的抽取就做不到）。<br>' +
          '这就是选型的本质：<b>你不是在选"更强的工具"，而是在选"把复杂度放在哪一层"。</b></p>') +
        T.note('warn', '⚠️ 关于本章案例来源的说明',
          '<p>本章想收录一条看雪（bbs.kanxue.com）上的 Xposed/LSPosed 原帖作为案例，' +
          '但我尝试取的几个帖子（例如 JDex2 的 README 里给出的 <code>thread-290669</code>、' +
          '以及搜索到的 LSPosed 原理帖、FDex2 脱壳工具帖）<b>都落在人机验证页上</b>：' +
          '<code>web_fetch</code> 返回 HTTP 200，但正文是"安全验证 / 请确认您不是机器人"。' +
          '这属于"能访问到页面、但取不到内容"，按契约不算可验证来源。</p>' +
          '<p style="margin-bottom:0">所以本章的两个案例都取自 <b>GitHub</b>，并且都用 ' +
          '<code>web_fetch</code> 取到了正文（一个是仓库 README 与源码文件，一个是官方 wiki 原文）。' +
          '看雪的原帖链接我保留在案例的 <code>linkNote</code> 里，方便你自己登录后核对。</p>') +
        T.note('', '📌 合规口径',
          '<p style="margin-bottom:0">本节与 22.8C 讨论的脱壳技术，面向<b>合法授权的安全研究、' +
          '自身产品的加固效果验证与教学</b>。请勿用于未授权地破解他人产品。' +
          '这与全站一贯的口径一致（第 2、10、19 章同）。</p>')
    },

    /* ============================================================ 22.13 */
    {
      h: '22.13', title: 'LSPosed 逆向开发实战要点',
      html:
        '<p>先给一个让人安心的结论：<b>传统 Xposed API 仍然能用。</b>' +
        'LSPosed 的 README 明确写了双向兼容——基于 LSPosed 的模块与原版 Xposed 框架兼容，反之亦然。' +
        '所以你前面学的 <code>IXposedHookLoadPackage</code>、<code>XposedHelpers</code>、' +
        '<code>XC_MethodHook</code> 这一套没有作废。</p>' +
        '<p>但官方同时推进了一套<b>现代 API</b>（<code>io.github.libxposed.api</code>，工程名 libxposed）。' +
        '下面这几条差异全部来自官方 wiki 的 Modern Xposed API 页面原文。' +
        '<b>如果你要写新模块，必须知道它们</b>——否则你会照着旧教程写出一个能跑但"少了半边能力"的模块。</p>' +
        T.tbl(['', '传统 API', '现代 API（libxposed）'],
          [
            ['<b>Java 入口声明</b>', '<code>assets/xposed_init</code>',
             '<code>META-INF/xposed/java_init.list</code>（放在 <code>src/main/resources/META-INF</code>，Gradle 会自动打包）'],
            ['<b>Native 入口声明</b>', '<code>assets/native_init</code>',
             '<code>META-INF/xposed/native_init.list</code>'],
            ['<b>模块元数据</b>', '<code>AndroidManifest</code> 里的 ' +
             '<code>xposedmodule</code> / <code>xposeddescription</code> / <code>xposedminversion</code>',
             '<b>不再用 metadata</b>：名称用 <code>android:label</code>、描述用 <code>android:description</code>、' +
             '作用域用 <code>META-INF/xposed/scope.list</code>（一行一个包名）、' +
             '配置用 <code>META-INF/xposed/module.prop</code>（Java properties 格式，含 ' +
             '<code>minApiVersion</code> / <code>targetApiVersion</code> / <code>staticScope</code>）'],
            ['<b>入口接口</b>', '<code>IXposedHookLoadPackage</code> / <code>IXposedHookZygoteInit</code>',
             '实现 <code>io.github.libxposed.api.XposedModule</code>；框架自动调用 ' +
             '<code>attachFramework(XposedInterface)</code>；官方明确要求模块<b>不要</b>在 ' +
             '<code>onModuleLoaded()</code> 之前做初始化'],
            ['<b>Hook 写法</b>', '<code>XC_MethodHook</code> 的 before / after；<code>XC_MethodReplacement</code>',
             '<b>OkHttp 风格的拦截器链</b>：实现 <code>Hooker&lt;T&gt;</code> 的 ' +
             '<code>intercept(Chain&lt;T&gt; chain)</code>；hook 返回 <code>HookBuilder</code> 以配置优先级与异常策略'],
            ['<b>辅助工具类</b>', '<code>XposedHelpers</code> 家族（本章 22.5 讲的全套）',
             '<b>框架不再提供 XposedHelpers</b>——官方另出 <code>libxposed/helper</code> 这类库补上'],
            ['<b>内联与调用</b>', 'hook 有时会被方法内联"绕过"',
             '可以对具体方法（接受 <code>Executable</code> 参数）做 deoptimize 以绕开内联；' +
             '并引入 Invoker 体系：<code>getInvoker(Method)</code> / <code>getInvoker(Constructor)</code>，' +
             '提供 <code>invokeSpecial</code> / <code>newInstanceSpecial</code>'],
            ['<b>资源 Hook</b>', '历史上支持',
             '<b>被移除</b>。官方给的理由是它难以维护、此前造成过很多问题'],
            ['<b>与框架通信</b>', '基本没有正式通道',
             '可以注册 service listener 与框架通信：动态申请作用域、跨模块与目标 App 共享 ' +
             'SharedPreferences / blob 文件、查询框架名与版本；<b>因此模块 App 自身不再被 hook</b>']
          ]) +
        T.note('key', '🔑 现代 API 里最值得注意的两条',
          '<p>① <b>"模块 App 自身不再被 hook"</b>——传统实现里模块 APK 自己也会被注入（因为它在作用域里就是个普通 App），' +
          '这带来过不少混乱。现代 API 用一个明确的通信通道替掉了这种"自己 hook 自己"的用法。</p>' +
          '<p style="margin-bottom:0">② <b><code>staticScope</code> / 动态申请作用域</b>——' +
          '作用域从"安装时勾一次"变成"可以在运行中与框架协商"。' +
          '这对 22.11 讲的"暴露面预算"是好事：你可以只在自己需要的那一刻申请最小作用域，' +
          '而不是一开始就勾上一大片。</p>') +
        '<h3 style="margin-top:26px">新版 Android 上的作用域与兼容性问题</h3>' +
        '<p>三条现实约束，按踩坑频率排：</p>' +
        '<p><b>① 作用域勾多了，崩溃的爆炸半径跟着变大。</b>' +
        '这一点在 22.8C 那个案例里体现得最直接：它的局限里同时出现了"JNI 全局引用超上限"和' +
        '"某些类继承了本系统不存在的父类导致崩溃"。' +
        '<b>模块崩在自己的进程里是小事，崩在每一个被勾选的 App 里就是设备级事故。</b>' +
        '所以白名单/黑名单、进程名判断、增量跳过这些东西不是可选项，而是必备。</p>' +
        '<p><b>② 存储路径与分区存储。</b>Android 11 之后 <code>/sdcard/Android/data/&lt;包名&gt;/</code> 的写入被逐步收紧。' +
        '22.8C 的案例里，作者在 Android 12+ 上用的是 <code>/Android/\\u200Bdata/</code>——' +
        '路径中间插了一个零宽字符来绕过限制。<span class="pill warn">待核实</span>：' +
        '这类技巧在哪些版本、哪些机型上仍然有效，无法从仓库信息里确认；' +
        '而且它的性质是"和系统规则对抗"，随时可能失效。<b>把它当作临时手段，不要当作设计基础。</b></p>' +
        '<p><b>③ 系统版本不等于 ART 版本。</b>' +
        '这是第 12 章的结论，在这里同样成立：从 Android 12 起 ART 变成可以独立升级的 APEX 模块，' +
        '所以"我这是 Android 13"不足以判断 hook 框架能不能用——' +
        '真正决定兼容性的是 ART 内部结构，而 hook 框架恰恰是最依赖这东西的。' +
        'LSPosed 的 README 写的是 Android 8.1 ~ 14，<span class="pill warn">待核实</span>：' +
        '请以官方 release 页的当前说明为准。</p>' +
        '<h3 style="margin-top:26px">Zygisk 模块与 LSPosed 模块是什么关系</h3>' +
        '<p>这是最容易混淆的一对概念。用一句话分开：</p>' +
        T.note('', '🏗️ 地基、房子、家具',
          '<p><b>Zygisk 是地基，LSPosed 是盖在地基上的房子，你的模块是房子里的家具。</b></p>' +
          '<p>· <b>Zygisk 模块</b>：Magisk 提供的 Zygote 注入机制。它给你的接口是 <b>native 的</b>，' +
          '你能做的事情更底层——替换 libc、改系统属性、在最早的时刻注入自己的 so。<br>' +
          '· <b>LSPosed 模块</b>：提供 <b>Java / ART 层</b>的 hook API。' +
          'LSPosed 自己就是一个"跑在 Zygisk 或 Riru 之上的模块"（README 自述：' +
          '<i>A Riru / Zygisk module trying to provide an ART hooking framework</i>）。</p>' +
          '<p style="margin-bottom:0"><b>怎么选：</b>要的是 Java 语义（方法、字段、类加载）→ 写 LSPosed 模块；' +
          '要的是比 Java 更底层的能力（native、属性、极早期）→ 写 Zygisk 模块。<br>' +
          '两者也可以配合，而且<b>官方就给了配合的通道</b>：LSPosed 模块里 ' +
          '<code>System.loadLibrary</code> 自己的 so，就是 22.9 讲的那条 native 入口。</p>') +
        '<h3 style="margin-top:26px">五条实战要点（都是踩出来的）</h3>' +
        '<ol>' +
        '<li><b>先确认作用域与进程名，再怀疑代码。</b>模块"完全没反应"的第一嫌疑永远是这两件事（22.2）。</li>' +
        '<li><b>日志给独立 TAG，用 <code>adb logcat -s 你的TAG</code> 单独看。</b>' +
        '在几十个 App 的作用域下跑模块，不隔离日志等于没有日志。</li>' +
        '<li><b>定位方法一律写全签名，不靠名字猜。</b>混淆之后名字没有信息量，参数类型表才是稳定标识（22.5）。</li>' +
        '<li><b>一次只改一件事，改完立刻看日志。</b>同时改五个 hook 点然后崩溃，你失去的是全部线索。</li>' +
        '<li><b>主动调用/批量操作必须独立 try/catch，并留可审计的黑名单。</b>' +
        '跳过而不记录，等于给自己的脱壳结果挖洞（22.6）。</li>' +
        '</ol>',
      after: T.note('warn', '⚠️ 关于版本与维护状态的统一提醒',
        '<p style="margin-bottom:0">本章涉及的所有<b>版本号、支持范围、维护状态</b>都可能已经变化：' +
        '原始 Xposed 的最后一个版本、EdXposed 是否归档、LSPosed 当前支持的 Android 区间、' +
        'Riru 与 Zygisk 两条 flavor 的取舍、libxposed 的 API 版本。' +
        '凡标注 <span class="pill warn">待核实</span> 的地方，请以<b>官方仓库与 release 页</b>为准。' +
        '我刻意不写死这些数字——写死一个过期版本号，比留一个空格糟糕得多。</p>')
    },

    /* ============================================================ 22.14 */
    {
      h: '22.14', title: '收束：把这一章压成一张判断表',
      html:
        '<p>本章的技术点很多，但真正需要带走的是<b>判断顺序</b>。下面这张表是它的压缩版。</p>' +
        T.tbl(['你遇到的现象', '先问什么', '去哪一节'],
          [
            ['模块完全没反应', '作用域勾了吗？进程名对吗？', '22.2'],
            ['类找不到（ClassNotFound）', '谁负责加载它？我手上的加载器对吗？', '22.8 / 22.8C'],
            ['字段读出来是 null', '我是在 before 还是 after？它什么时候被赋值？', '22.4 / 22.5'],
            ['参数不是调用方传的值', '我看的是不是 after？原始值还在不在？', '22.6'],
            ['主动调用崩了', '类加载器 / 签名 / 时机 / 参数 / 前置状态——按顺序查', '22.6 / 22.7'],
            ['hook 曾经生效，后来静默了', '地址还在不在？入口有没有被换？', '22.10'],
            ['目标有 root / 注入检测', '我是在花哪一份暴露面预算？有没有非常驻路线？', '22.11'],
            ['该用 Frida 还是 LSPosed', '管一个进程，还是管一套环境？', '22.1 / 22.11'],
            ['要长期监控全部加密调用', '目标会做环境检测吗？暴露面允许常驻吗？', '22.1 / 22.11'],
            ['要脱一个抽取壳', '类级别还是方法级别？迭代成本重要还是能力上限重要？', '22.12 / 22.8C']
          ]) +
        T.note('key', '🔑 三句最该记住的话',
          '<p>① <b>Frida 管一个进程，LSPosed 管一套环境。</b>' +
          '进程模型决定了注入时机、作用域、可持久性，也决定了检测面在哪一侧。</p>' +
          '<p>② <b>不要"在某个时刻去找类"，要"守在类出生的地方"。</b>' +
          '类加载器这一层同时解决加固壳（找真实加载器）与插件 dex（捕获新加载器/新 dex）两类问题。</p>' +
          '<p style="margin-bottom:0">③ <b>你的观测手段就是对手的检测项。</b>' +
          '每一个 hook 点都在增加暴露面，所以"最少必要"不是洁癖，是设计原则。</p>') +
        '<p>最后说一句不好听但必要的话：<b>本章给出的所有对抗手段都有边界。</b>' +
        '装过 LSPosed 的机器与原装机之间的差异不可能完全抹平；' +
        'native hook 必然改内存，inline hook 必然留下入口痕迹；' +
        '主动调用的粒度决定了它处理不了方法级别的抽取。<br>' +
        '知道这些边界在哪，比多背几个 API 有用得多——' +
        '因为选型失败通常不是"不会用工具"，而是<b>"用错了形态"</b>。</p>',
      quiz: {
        id: 'q22-9', chapter: 22, answer: 0,
        stem: '<b>综合题。</b>你要长期监控一个 App 的全部加密调用（每一次输入输出都要记录）。' +
              '目标会做 root 与注入检测。下面哪个判断最站得住？',
        options: [
          { t: '先算暴露面预算：如果目标的环境检测会否掉常驻方案，就选按需注入的路线（并接受它的特征管理成本）；' +
               '如果常驻方案可用，就用最小作用域 + 最少 hook 点，并准备一条备选路线',
            why: '正确。这是本章的落点：先算暴露面，再选路线，并保留退路。' },
          { t: '直接上 LSPosed，因为它比 Frida 更隐蔽', why: '这是把 22.1 的结论搞反了：LSPosed 的痕迹是环境级的，不依赖你是否接上。' },
          { t: '直接上 Frida，因为它按需注入、不装模块，所以不会被检测到',
            why: '按需注入不等于无痕；进程侧特征（线程、映射、端口、函数头）依然存在。' },
          { t: '两个一起上，覆盖面最全', why: '同时叠加两套暴露面，等于把两边的检测项都送给对手；这不是"覆盖更全"而是"风险相乘"。' }
        ],
        explain: '<b>这道题考的不是"哪个工具好"，而是"你先算什么"。</b><br><br>' +
          '题目给了两个硬约束：<b>长期</b>（暗示要持久、要稳定）与<b>目标会做环境检测</b>（暗示常驻方案有整体失效风险）。' +
          '这两条一摆出来，答案就不是"选 Frida"或"选 LSPosed"，而是：<br><br>' +
          '<b>第一步，判断环境检测会不会否掉常驻方案。</b>' +
          '如果目标是"装过 LSPosed 就拒绝运行"，那所有常驻方案都是零分——无论你写得多好。' +
          '（22.8C 的案例就是活证据：作者自述"高度依赖 Lsposed 的隐蔽性，如果 Lsposed 被检测则会直接闪退"。）<br><br>' +
          '<b>第二步，如果常驻方案可用，就按最小暴露面设计。</b>' +
          '作用域只勾目标 App、hook 点压到最少、能用一次性时机就不用常驻 hook。' +
          '注意"监控全部加密调用"这个需求本身就在逼你多挂点——' +
          '所以要评估：能不能只挂一个"总入口"（例如某个统一的加密调度方法），而不是每个算法各挂一个。<br><br>' +
          '<b>第三步，永远留一条备选路线。</b>' +
          '常驻方案失效的方式是<b>整体失效</b>，没有降级空间。' +
          '所以并行评估非常驻路线（一次性注入、非 root 方案、模拟执行，见第 21、7 章）不是浪费，是保险。<br><br>' +
          '<span class="hit">把这三步合起来就是本章的元判断：' +
          '<b>先算暴露面预算，再选路线，并保留退路。</b></span>'
      },
      after: T.note('ok', '✅ 本章完成',
        '<p style="margin-bottom:0">你现在应该能回答这几个问题，而且能说出理由：<br>' +
        '· 为什么在加固 App 上 <code>findAndHookMethod</code> 会 <code>ClassNotFound</code>，以及两条解法分别是什么；<br>' +
        '· 构造函数为什么值得单独 hook，before / after 各自能拿到什么；<br>' +
        '· 插件 dex 与壳 dex 的 ClassNotFound 为什么解法不同；<br>' +
        '· Xposed 生态里 native hook 的时机从哪来、引擎从哪来，以及它和第 13 章那条路怎么分工；<br>' +
        '· 为什么"装过 LSPosed"这件事本身无法被完全隐藏。<br><br>' +
        '如果有一条说不顺，回到对应小节；如果都顺了，去严师那里过一遍——那才是真正的验收。</p>')
    }

  ],

  /* ============================================================== 名词表 */
  glossary: [
    { t: 'Xposed', d: '最早的 Android Hook 框架（rovo89）。替换 <code>app_process</code> 并把 <code>XposedBridge.jar</code> 带进 Zygote，' +
        '定义了 <code>IXposedHookLoadPackage</code> 这一整套 API。后续所有实现都以它为 API 基准。' +
        '官方版本支持范围停在 Android 8.1 时代，<span class="pill warn">待核实</span>。' },
    { t: 'EdXposed', d: '基于 Riru 的接棒实现，LSPosed 的 fork 源。维护状态 <span class="pill warn">待核实</span>。' },
    { t: 'LSPosed', d: '当前事实上的主线实现。官方自述是一个 Riru / Zygisk 模块，提供与原始 Xposed 一致的 API，' +
        '核心 ART hook 框架是 LSPlant。README 标注支持 Android 8.1 ~ 14（<span class="pill warn">待核实</span>）。' },
    { t: 'LSPlant', d: 'LSPosed 的核心 ART hook 框架（LSPosed 组织维护）。"方法入口被替换"这件事就发生在这一层，也是 22.11 的检测面②。' },
    { t: 'Dobby', d: 'Inline hook 库。LSPosed README 的 Credits 里写明用它做 inline hooking；' +
        '也是 Xposed 生态里模块做 native hook 时可复用的引擎。' },
    { t: 'Magisk', d: 'Android 的 root 方案与模块化框架。它在 boot 镜像的 ramdisk 里注入自己的 init，' +
        '再用 magic mount 做 systemless 修改。LSPosed 是它的一个模块，自己并不具备注入能力。' },
    { t: 'Zygisk', d: 'Magisk 提供的在 Zygote 进程注入代码的机制（Magisk v24+ 起）。' +
        '因为 Zygote 是所有 App 进程的母体，在这里注入等于每个 App 进程出生即带代码。' },
    { t: 'Riru', d: '第三方的 Zygote 注入模块（LSPosed 官方文档要求 26.1.7+）。' +
        '与 Zygisk 是同一目的的两种实现，LSPosed 提供两种 flavor。' },
    { t: '作用域（scope）', d: '决定一个模块对哪些 App 生效的清单。LSPosed 要求逐个勾选、不提供全选' +
        '（官方理由是"注入每个 App 太危险"）。它是安全边界，不是方便选项。' },
    { t: 'IXposedHookLoadPackage', d: '模块入口接口之一。<code>handleLoadPackage(XC_LoadPackage.LoadPackageParam)</code> ' +
        '在每个作用域内的 App 进程加载时被调用一次（注意：每个进程一次，不是每个 App 一次）。' },
    { t: 'IXposedHookZygoteInit', d: '入口接口之一。<code>initZygote(StartupParam)</code> 在 Zygote 启动时执行一次，' +
        '此时没有 App 进程、没有包名、也没有 App 的 ClassLoader——适合改系统框架级行为。' },
    { t: 'XC_MethodHook', d: '最常用的 hook 基类。<code>beforeHookedMethod</code> 在原方法体执行前调用，' +
        '<code>afterHookedMethod</code> 在之后调用。原方法体仍然会执行——除非你在 before 里 <code>setResult</code>。' },
    { t: 'XC_MethodReplacement', d: '用 <code>replaceHookedMethod</code> 完全替代原方法体。' +
        '注意：原方法的所有副作用也随之消失，这是最容易踩的坑。' },
    { t: 'XposedHelpers', d: '反射工具箱：<code>findAndHookMethod</code> / <code>getObjectField</code> / ' +
        '<code>setObjectField</code> / <code>callMethod</code> / <code>callStaticMethod</code> / <code>newInstance</code> / ' +
        '<code>findClass</code>。本质是 Java 反射，所以失败方式与反射一致（例如 <code>int.class</code> ≠ <code>Integer.class</code>）。' },
    { t: 'loadClass / findClass', d: '<code>ClassLoader.loadClass</code> 是所有加载请求的总入口（含最终由父加载器加载的类）；' +
        '<code>BaseDexClassLoader.findClass</code> 只在"这个加载器自己动手"时才被调用。前者全而吵，后者精而少。' },
    { t: 'DexPathList.make*Elements', d: '<code>makeDexElements</code> / <code>makePathElements</code> / ' +
        '<code>makeInMemoryDexElements</code>。新 dex 被挂进某个加载器的时刻——发现"动态加载"的唯一窗口（22.8 的 L3）。' },
    { t: '主动调用（Invoke）', d: '由你发起对 App 方法的调用（<code>callMethod</code> / <code>callStaticMethod</code> / ' +
        '<code>newInstance</code>）。典型用途是触发抽取壳回填方法体；返回值通常只是副产品。' },
    { t: 'mCookie', d: 'Android <code>DexFile</code> 内部指向 ART dex 结构的句柄（常见形态是 <code>long[]</code>）。' +
        '脱壳时把它交给 native 层即可把 dex 落盘（JDex2 的 <code>dumpDexByCookie</code> 就是这么做的）。' },
    { t: 'JNI 全局引用上限', d: 'JNI 全局引用数量有上限，超过会导致崩溃（JDex2 的 README 给出的数字是 51200）。' +
        '这是"批量主动调用必须支持分轮与跳过"的根因。' },
    { t: 'libxposed（现代 API）', d: 'LSPosed 推进的新一代 API（<code>io.github.libxposed.api</code>）。' +
        '入口改 <code>META-INF/xposed/java_init.list</code>、元数据改 <code>module.prop</code>、' +
        'Hook 改为 <code>Hooker&lt;T&gt;</code> 拦截器链，并且框架不再提供 <code>XposedHelpers</code>。' }
  ],

  /* ============================================================== 严师 */
  teacher: {
    id: 't22', chapter: 22,
    name: '严师 · 时机审计员',
    sub: '说不清"为什么这里能拿到、那里拿不到"，你就只能一遍遍试',
    intro: '<p style="margin:0">我不考你 API 怎么调（那个查文档就行）。我考的是：' +
           '<b>你为什么在这个时机、这一层、这一侧动手；拿不到的东西到底是被谁挡住的。</b><br>' +
           '下面每道题都要用自己的话说全关键点。含糊我会追问；追问三次我直接给答案——但那不算你过关。</p>',
    questions: [
      {
        id: 'c22q1', depth: 1, threshold: 0.7,
        q: 'Frida 和 Xposed / LSPosed 在<b>注入时机</b>上有什么本质差别？' +
           '这个差别带来了哪些具体后果（至少说三条）？',
        concepts: [
          { label: 'Frida 是<b>按需</b>注入你指定的单个进程（attach 事后补挂，或 spawn 抢跑）',
            hint: 'Frida 改的是"一个进程"还是"一台设备"？',
            any: ['attach', 'spawn', '按需', '单个进程', '指定进程', '一个进程', '只注入', '注入单个'] },
          { label: 'LSPosed 注入 Zygote，此后每个 fork 出来的 App 进程都带着模块',
            hint: '模块是从哪个进程开始生效的？', any: ['zygote', 'Zygote', '母体', 'fork', '每个进程', '所有进程', '出生'] },
          { label: '时机差别：LSPosed 更早（早到 App 第一行 Java 代码之前），但时机不由你选；Frida 可控（可抢跑可事后）',
            hint: '谁决定注入发生在哪一刻？', any: ['更早', '第一行', '启动之前', '事先', '系统决定', '可控', '抢'] },
          { label: '可持久性差别：LSPosed 常驻（重启后仍生效），Frida 是会话级（detach 或重启就没了）',
            hint: '今天 hook 过，明天还需要再连一次吗？', any: ['持久', '常驻', '重启', '会话', 'detach', '一直生效', '仍在'] },
          { label: '暴露面差别：Frida 的特征在进程，LSPosed 的特征在环境/整台设备',
            hint: '被检测时，你失去的是"这一次会话"还是"整个环境"？',
            any: ['暴露面', '检测面', '环境', '进程级', '整台', '全局', '更大', '整体失效'] }
        ],
        hints: [
          '不要停在"一个早一个晚"。先问：Frida 的作用单位是什么？LSPosed 的作用单位是什么？',
          '再想一个后果层面的问题：如果 LSPosed 被目标检测到了，你还有"这次不接上"这个退路吗？'
        ],
        probes: [
          '你说 LSPosed 更早——那你为什么不能在 <code>IXposedHookZygoteInit</code> 里直接 hook 某个 App 的业务类？',
          '换个角度：如果目标只在"当前有没有被 attach"这一件事上做检测，两种方案谁更吃亏？为什么？'
        ],
        model: '<b>本质差别：Frida 注入个体，LSPosed 注入母体。</b><br><br>① <b>进程模型：</b>Frida 的单位是进程——attach 谁改谁，别的不受影响；LSPosed 的单位是 Zygote——模块在母体里，此后每个 fork 出来的 App 进程都带着它，你甚至没有 attach 任何进程。<br>② <b>注入时机：</b>Frida 由你决定（spawn 抢跑或 attach 事后）；LSPosed 由系统决定，进程一出生就在场，早到 App 第一行 Java 代码之前，你只能靠作用域选"给谁装"。<br><br><b>三个后果：</b><br>· <b>覆盖范围</b>：Frida 只改你连过的那个进程；LSPosed 装一次处处生效——暴露面从 1 个进程变成一整台机器。<br>· <b>持久性</b>：Frida 是会话级（detach 或重启即复原，"昨天 hook 过"没有意义）；LSPosed 常驻，重启后仍生效。<br>· <b>检测面</b>：Frida 在进程侧（注入线程、agent 映射、端口、被改写的函数头）；LSPosed 在环境侧（Zygote 注入链路、模块 so、被替换的方法入口、加载器链异常）。<br><br><span class="hit">关键一句：<b>Frida 的检测问"你现在有没有被接上"，LSPosed 的检测问"这台机器的系统还是不是原装的"。</b>前者可以靠"这次不接"规避，后者不能。</span>'},
      {
        id: 'c22q2', depth: 2, threshold: 0.7,
        q: '为什么 hook 构造函数常常是<b>唯一</b>能拿到对象初始状态的地方？' +
           '另外说清 <code>hookAllConstructors</code> 与逐个 hook 各自该在什么时候用。',
        concepts: [
          { label: '对象的状态在构造时定型：校验结果、密钥、token 这类关键值在构造函数里算好并写入字段',
            hint: '你最想要的那些值，是什么时候被算出来的？',
            any: ['构造时', '构造函数里', '定型', '初始化', '赋值', '算好', '写进字段'] },
          { label: '构造函数在字节码里叫 <code>&lt;init&gt;</code>、源码里没有名字，' +
              '按方法名搜索的工具会漏掉它（要用 hookAllConstructors 或按参数类型找）',
            hint: '你平时怎么定位一个方法？这个办法在构造函数上为什么不适用？',
            any: ['init', '<init>', '没有名字', '字节码', '按名字', '漏掉', 'hookAllConstructors', 'findAndHookConstructor'] },
          { label: '<code>before</code> 时字段还是默认值，<code>after</code> 才是定型后的状态；' +
              '用两侧各打一次日志就能看出赋值发生在哪一步',
            hint: '同一个字段，在这两侧看到的值会一样吗？',
            any: ['before', 'after', '默认值', '还没赋值', '定型', 'null', '两侧', '各打一次'] },
          { label: 'hookAllConstructors 适合<b>摸底</b>（不漏，但每个重载都会走回调、噪音大）；' +
              '逐个 hook 适合<b>收敛</b>（精确，但签名写错会静默漏掉）',
            hint: '哪个阶段该"全挂上"，哪个阶段该"只挂一个"？',
            any: ['摸底', '不漏', '噪音', '淹', '收敛', '精确', '签名', '重载', '静默漏'] },
          { label: '不可逆的值（hash、签名、密文）只有在构造阶段才有机会看到"原料"，之后再无可能',
            hint: '如果值已经被算成摘要，你还能倒推吗？',
            any: ['不可逆', 'hash', '摘要', '签名', '密文', '原料', '明文', '倒推', '还原不了'] }
        ],
        hints: [
          '先回答一个更基础的问题：一个对象"变成它自己"是在哪一刻完成的？',
          '再想定位问题：你靠什么识别一个方法？构造函数在这种情况下缺了什么？'
        ],
        probes: [
          '你说在 after 里能读到定型后的字段——那如果他想要的是"这个字段<b>被谁</b>改过"，after 够用吗？该怎么办？',
          '如果某个关键值是在构造之后<b>懒加载</b>的，你的方案要怎么调整？'
        ],
        model: '<b>为什么唯一：</b>对象状态在构造时定型——校验结果、密钥、token 这类值都在构造函数里算好并写入字段；你 hook 业务方法时看到的是成品，而 hash / 签名 / 密文一旦算完就不可逆。<b>只有构造函数的前后两侧能看到"从无到有"这个过程</b>：before 是毛坯（默认值），after 是装修好的样子。<br><br><b>为什么容易漏：</b>构造函数在字节码里叫 <code>&lt;init&gt;</code>，源码里没有名字，按方法名 find 必然漏掉；Xposed 里要用 <code>hookAllConstructors</code> 或按参数类型 <code>findAndHookConstructor</code>。<br><br><b>两种挂法：</b><br>· <code>hookAllConstructors</code>：全挂上、不会漏，但每个重载都走回调、日志被淹——<b>用于摸底</b>（在回调里打印 <code>param.method</code> 列出所有重载签名）。<br>· 逐个 <code>getDeclaredConstructors</code> + <code>hookMethod</code>：回调干净、日志可读，但签名写错会<b>静默漏掉</b>——<b>用于收敛</b>。<br><br><b>时机纪律：</b>读定型后的状态放 <code>afterHookedMethod</code>，并在 after 里打"已处理"标记（每个新对象都会走一次构造函数）。<br><span class="hit">诊断技巧：同一字段在 before / after 各打一行日志，值在哪一侧出现，赋值就发生在中间——比反编译翻赋值语句快得多，在混淆代码上同样有效。</span>'},
      {
        id: 'c22q3', depth: 2, threshold: 0.7,
        q: '同样是 <code>ClassNotFoundException</code>，为什么"<b>壳 dex 里的类</b>"和' +
           '"<b>插件 dex 里的类</b>"解法不一样？请说到类加载器这一层。',
        concepts: [
          { label: '壳 dex：壳替换/包裹了加载器，要先拿到"壳替换后的真实加载器"' +
              '（常见路径是 ActivityThread.mBoundApplication → info（LoadedApk）→ getClassLoader）',
            hint: '壳改过加载器之后，你手上那个 lpparam.classLoader 还是最终的吗？',
            any: ['真实加载器', 'LoadedApk', 'mBoundApplication', 'ActivityThread', 'info', '壳换', '替换', '回退'] },
          { label: '插件 dex：由运行时<b>按需新建</b>的加载器加载，事前根本不存在，' +
              '所以要守在"新加载器被创建 / 新 dex 被挂载"的那一刻',
            hint: '插件类是你启动时就有，还是走到某一步才有的？',
            any: ['运行时', '按需', '新建', '动态', '之前不存在', '挂载', '捕获', '蹲守'] },
          { label: '具体钩子：<code>BaseDexClassLoader</code> 构造、<code>DexPathList</code> 的 ' +
              '<code>makeDexElements</code> / <code>makePathElements</code> / <code>makeInMemoryDexElements</code>',
            hint: '一个 dex 要被"挂进"加载器，会经过哪个方法？',
            any: ['BaseDexClassLoader', 'DexPathList', 'makeDexElements', 'makePathElements',
                  'makeInMemoryDexElements', '构造'] },
          { label: '共同根因是双亲委派：加载器看不到兄弟加载器加载的类，' +
              '所以这不是"类名写错"，而是"问错了人 / 问的时机不对"',
            hint: '第 2 章讲过的那条规则，在这里起什么作用？',
            any: ['双亲委派', '看不到', '兄弟', '不是类名', '加载器不对', '问错了人', '委托'] },
          { label: '<code>ClassLoader.loadClass</code> 是最早能看到"加载请求"的层面：' +
              '它在类还不存在的时候就存在，所以不会"找不到"',
            hint: '有没有一个地方，是"类还没出生"时就已经存在的？',
            any: ['loadClass', '请求', '最早', '类名', '总入口', '还不存在', 'L1'] }
        ],
        hints: [
          '把两种情况的"类是什么时候出现的"分别写出来——一个在启动早期，一个在运行中。',
          '既然一个类可能"后来才出现"，那你有没有办法不"找它"，而是"等它出现"？'
        ],
        probes: [
          '你说要 hook <code>DexPathList.make*Elements</code>——为什么 JDex2 的作者在注释里专门强调"有些壳根本不新建 classloader，而是向其中插入 Dex"？这句话对应的正是哪个钩子？',
          '如果我用 <code>Class.forName</code> 去加载插件类，为什么还是失败？'
        ],
        model: '<b>差别在"类什么时候出现"。</b><br><br><b>壳 dex：</b>壳在启动早期解密真 dex，并替换或包裹了加载器，所以你手上那个 <code>lpparam.classLoader</code> 不一定认识业务类。解法是<b>找出壳换过之后的真实加载器</b>：<code>ActivityThread.currentActivityThread()</code> → <code>mBoundApplication</code> → <code>info</code>（LoadedApk）→ <code>getClassLoader()</code>。这就是第 2 章 <code>Java.enumerateClassLoaders</code> 的等价物。<br><br><b>插件 dex：</b>插件类是运行时按需加载的（走到某段逻辑才新建 <code>DexClassLoader</code> 把 dex 挂上），所以在任何固定时刻"去找它"都必然失败。解法是<b>守在它出生的地方</b>：hook <code>BaseDexClassLoader</code> 的构造 → 新加载器一出现你就知道；hook <code>DexPathList</code> 的 <code>makeDexElements</code> / <code>makePathElements</code> / <code>makeInMemoryDexElements</code> → 覆盖"不新建加载器、只往里插 dex"的情况（JDex2 的注释原话：<i>因为一些壳根本就不新建classloader，而是向其中插入Dex</i>）。<br><br><b>共同根因：</b>按双亲委派，加载器看不到兄弟加载器加载的类——所以不是类名写错，而是"问错了人"或者"问早了"。<br><span class="hit">通用判断：<b>不要"在某个时刻去找类"，要"守在类出生的地方"。</b>Java 层是 <code>loadClass</code>（请求）与 <code>make*Elements</code>（挂载），native 层是 <code>dlopen</code>。</span>'},
      {
        id: 'c22q4', depth: 3, threshold: 0.7,
        q: '<b>综合题：</b>Frida 和 LSPosed 各适合什么场景？请从<b>进程模型、注入时机、检测面</b>三个角度说清，' +
           '并给出一个<b>只能用其中一个</b>的具体场景。',
        concepts: [
          { label: '进程模型：Frida 注入你指定的单个进程；LSPosed 注入 Zygote，' +
              '此后每个 fork 出来的 App 进程都带模块',
            hint: '两者的作用单位分别是什么？', any: ['zygote', 'Zygote', '母体', '单个进程', '每个进程', 'fork', '一个进程'] },
          { label: '注入时机：Frida 可控（spawn 抢跑 / attach 事后）；LSPosed 由系统决定，' +
              '进程一出生就生效（早到 App 第一行 Java 代码之前）',
            hint: '谁能决定"在哪一刻注入"？', any: ['spawn', 'attach', '可控', '抢', '更早', '第一行', '出生', '系统决定'] },
          { label: '检测面：Frida 在进程侧（注入线程、agent 映射、端口、改写函数头）；' +
              'LSPosed 在环境侧（Zygote 注入链路、模块 so、方法入口、Zygisk 痕迹）',
            hint: '被检测时，你失去的是"这次会话"还是"整个环境"？',
            any: ['环境检测', '进程特征', '线程', '端口', 'maps', 'Zygisk', '注入痕迹', '整台', '会话'] },
          { label: '可持久性：LSPosed 常驻（重启后仍生效、无需人工介入）；Frida 是会话级（要重新连）',
            hint: '需要"每次 App 启动都自动生效"时，你会选谁？',
            any: ['持久', '常驻', '重启', '会话', '一次性', '自动生效', '每次启动'] },
          { label: '只能用其中一个的场景要具体：例如"必须每次启动自动生效、无人值守的长期监控"只能靠 LSPosed；' +
              '"设备不能 root / 不能装模块"或"需要 Stalker 级别的执行流跟踪、完整调用栈"只能靠 Frida',
            hint: '想一个场景，其中另一个方案在物理上就做不到（而不是"效果差一点"）。',
            any: ['不 root', '不能 root', '无法 root', 'gadget', '免 root', '长期', '每次启动', '自动生效',
                  'Stalker', '执行流', '调用栈', '藏不住', '不方便装'] },
          { label: '选型原则：先算暴露面预算再选路线，并保留一条备选路线（因为常驻方案是整体失效）',
            hint: '如果选错了，代价是局部损失还是全盘损失？',
            any: ['暴露面', '预算', '退路', '备选', '权衡', '代价', '整体失效'] }
        ],
        hints: [
          '先把三个维度各自写成一句对比，再去找"交集为空"的场景——也就是另一个方案在物理上做不到的那种。',
          '注意"效果差一点"和"根本做不到"是两回事：前者不是选型依据，后者才是。'
        ],
        probes: [
          '你说"设备不能 root 时只能用 Frida"——那 LSPosed 生态里的非 root 分支（例如 LSPatch 一类）算不算反例？' +
          '如果要推翻你的结论，你需要补什么条件？',
          '换一个方向：有没有一个场景是"Frida 能做到、LSPosed 根本做不到"的？请说清是哪个能力。'
        ],
        model: '<b>三个维度先摆平：</b><br>① <b>进程模型</b>：Frida 的单位是进程（attach 谁改谁）；LSPosed 的单位是 Zygote（每个 fork 出来的 App 进程都带模块）。<br>② <b>注入时机</b>：Frida 由你决定（spawn 抢跑 / attach 事后）；LSPosed 由系统决定，进程一出生就在场，比 App 第一行 Java 还早，你只能用作用域选"给谁装"。<br>③ <b>检测面</b>：Frida 在进程侧（注入线程、agent 映射、端口、被改写的函数头）；LSPosed 在环境侧（Zygote 注入链路、模块 so、被替换的方法入口、Zygisk / Riru 痕迹）。<br>再加一条 <b>可持久性</b>：LSPosed 常驻（重启仍在），Frida 是会话级（每次都要重新建立现场）。<br><br><b>由此分出场景：</b><br>· <b>LSPosed：</b>装好就一直生效的长期值守；覆盖每个 App 进程的批量观测；迭代要快（不刷机、不编 ROM，改几行重装即可）；目标不做环境检测。<br>· <b>Frida：</b>一次性深度分析；需要运行时能力（完整调用栈、执行流跟踪——这些是 ART hook 接口给不了的）；设备不能 root 或不允许装模块（可用 gadget 形态）；目标只做进程侧检测且你能处理（第 21 章的去特征）。<br><br><b>只能用其中一个的场景（各举一个）：</b><br>· <b>只能用 LSPosed：</b>无人值守、每次 App 启动都要自动生效的长期监控——Frida 需要每次重新连接，这是<b>形态上不成立</b>，不是效果差一点。<br>· <b>只能用 Frida：</b>设备不允许 root / 刷模块，只能用 gadget 嵌入；或者你需要 Stalker 级别的指令级执行流跟踪——那是 LSPosed 的接口<b>根本提供不了</b>的能力维度。<br><br><span class="hit"><b>选型原则：先算暴露面预算，再选路线。</b>常驻方案一旦被环境检测否掉就是整体失效，所以"长期 + 对抗"的任务必须同时评估一条非常驻的退路。选型的本质不是"谁更强"，而是"复杂度放在哪一层、愿意付多少暴露面"。</span>'},
      {
        id: 'c22q5', depth: 3, threshold: 0.7,
        q: '<b>综合题：</b>任务是在一台<b>已经装了 LSPosed 的手机</b>上长期监控某个 App 的全部加密调用，' +
           '而目标<b>会做注入检测</b>。请设计一条从"最小暴露"出发的技术路线：' +
           '每一步在减少什么特征、代价是什么；如果最终被否掉，你的退路是什么。',
        concepts: [
          { label: '作用域最小化：只勾目标 App、不做全选；进程名精确判断（别在 :push / :remote 里重复初始化）',
            hint: 'LSPosed 为什么连"全选"都不提供？', any: ['作用域', 'scope', '只勾', '最小', '进程名', '收窄', '不勾其它'] },
          { label: 'hook 点数量最小化：尽量合并到一个"总入口"（例如统一的加密调度方法），' +
              '而不是每个算法各挂一个——每个 hook 点都是一次方法入口改写',
            hint: '挂 10 个点比挂 1 个点多付出了什么？', any: ['最少', '减少', '合并', '总入口', '一个点', '少挂', '数量'] },
          { label: '把最关键的观测点交给"不修改内存"的手段（硬件断点 / 观察点），因为 inline hook 必然改函数头、会被自校验发现',
            hint: '第 13 章的结论在这里怎么用？', any: ['硬件断点', '观察点', '不改内存', '不修改', '断点', 'watchpoint', '首字节'] },
          { label: '优先"一次性时机"而非常驻 hook：例如延迟取真实加载器后一次性采集；' +
              '或用现代 API 的动态作用域（staticScope / 按需申请）把生效范围压到最小',
            hint: '22.8C 那个案例的默认模式为什么是"延迟 10 秒、不挂 hook"？',
            any: ['一次性', '延迟', '等到', '动态作用域', 'staticScope', '按需', '不常驻', '少挂 hook'] },
          { label: '承认无法消除的残留特征：Zygote 注入链路、模块 so 的映射、方法入口替换——' +
              '所以常驻方案随时可能被整体否掉，不能只做"藏得更好"这一手准备',
            hint: '哪一部分痕迹不是你这次 hook 留下的？',
            any: ['无法完全', '残留', '抹平', '整体失效', '环境痕迹', 'zygote', '承认', '不是这次留下'] },
          { label: '准备备选路线：非常驻方案（一次性注入 / gadget / 非 root 方案 / 模拟执行），' +
              '因为常驻方案失效是整体失效、没有降级空间',
            hint: '如果明天这个 App 更新了检测，你还有什么牌？',
            any: ['备选', '退路', 'Frida', '模拟执行', '非 root', '不 root', 'gadget', '降级', 'unidbg'] }
        ],
        hints: [
          '把"暴露面"当成一份预算：先列出你能减少的项（作用域、hook 点数、改内存的次数、生效时间），再逐项定价。',
          '别忘了最坏情况：如果目标明天更新了检测，你的方案是"部分失效"还是"直接归零"？'
        ],
        probes: [
          '你说要"合并到一个总入口"——如果这个 App 的加密调用分散在 Java 层与 native 层两处，你的"一个入口"还成立吗？不成立时你怎么办？',
          '你把关键点交给硬件断点——但硬件断点通常只有 4–6 个名额。请说清：你会把名额分给哪几个点，依据是什么？'
        ],
        model: '<b>基调：这道题没有完美方案，只有"暴露面预算怎么花"。</b><br><br><b>① 收窄（作用域）</b>：只勾目标 App、不做全选；用 <code>processName</code> 精确判进程，避免在子进程里重复初始化。减少的是注入覆盖范围，代价几乎为零。<br><b>② 减量（hook 点数）</b>：每个 hook 点都是一次方法入口改写，优先找"总入口"（例如统一的加密调度方法），用 1 个点覆盖 10 个算法。代价：粒度更粗，要额外解析参数才能区分算法。<br><b>③ 换手段（不改内存）</b>：把最敏感的点交给硬件断点 / 观察点——inline hook 必然改内存，自校验能发现它；硬件断点由 CPU 调试寄存器匹配，一个字节都不改。代价：名额只有 4–6 个，必须取舍。<br><b>④ 换时机（能一次性就不常驻）</b>：延迟到壳换完加载器后一次性采集；现代 API 还给了动态作用域，可把生效范围压到最小。代价：放弃实时拦截，只拿到采集时刻的快照——如果需求是"每次调用的输入输出都要记录"，这一步就不成立，只能回到常驻并接受它的暴露面。<br><b>⑤ 承认残留</b>：Zygote 注入链路、模块 so 的映射、被替换的方法入口，这些不是这次 hook 留下的，而是"装过 LSPosed"留下的，写得再好也消不掉——所以随时可能被<b>整体否掉</b>（22.8C 的作者自述就是活证据）。<br><b>⑥ 留退路</b>：并行准备非常驻路线（一次性注入 / gadget / 非 root 方案 / 模拟执行）。<br><br><span class="hit"><b>骨架：收窄范围 → 减少改写 → 换用不改内存的手段 → 缩短存活时间 → 承认残留 → 留退路。</b>每一层都在做同一个交换：<b>用能力换暴露面。</b>这道题考的就是能不能把它说成一个"预算问题"，而不是"哪个工具更隐蔽"的问题。</span>'
      }
    ]
  }
};
