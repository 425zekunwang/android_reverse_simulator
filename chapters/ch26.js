/* 第 26 章数据 —— 安卓应用基础模型：组件、生命周期与 IPC */
window.CHAPTER = {
  no: 26,
  title: '安卓应用基础模型：组件、生命周期与 IPC',
  lede: '前面二十多章讲的都是"怎么突破防护"，但有一个更基础的问题始终没被系统回答过：' +
        '<strong>一个 App 到底是怎么被系统拉起来的，它凭什么能活着、能被别人唤起、能和别的进程说话？</strong>' +
        '这一章补的就是这个坐标系——<b>不知道组件与 IPC 的模型，你后面所有的"hook 哪里""为什么这里能触发"都只能靠试。</b>',
  meta: [
    '核心问题：<b>一个 App 是"一个程序"还是"一组被系统随时唤起的组件"？</b>',
    '关键机制：<b>四大组件 / 生命周期 / Handler 消息循环 / Binder IPC</b>',
    '对手：<b>把入口藏在组件回调里的加固壳，和把逻辑拆到别的进程里的风控</b>'
  ],

  sections: [
    /* ============================================================ 26.1 */
    {
      h: '26.1', title: '先纠正一个直觉：App 不是"一个程序"',
      intuition: {
        tag: '直觉模型 · 不是一家公司，而是一排服务窗口',
        body:
          '<p>如果你写惯了 C 程序，你脑子里的模型是：<b>一个 main() 从头跑到尾，程序自己决定什么时候结束。</b></p>' +
          '<p>安卓完全不是这样。更准确的类比是：<b>你的 App 是一排"服务窗口"，而系统是那个发号的大厅经理。</b></p>' +
          '<ul>' +
          '<li>窗口什么时候开、什么时候关，<b>不是你说了算，是经理说了算</b>（系统按内存压力随时杀你）；</li>' +
          '<li>每个窗口有自己的"上班流程"（生命周期回调），经理会在特定时刻敲你：<b>客人来了</b>（onCreate）、' +
          '<b>客人看不见你了</b>（onStop）、<b>下班</b>（onDestroy）；</li>' +
          '<li>你的 App <b>可以没有 main()</b>——严格说它有一个（<span class="mono">ActivityThread.main</span>），' +
          '但那是系统给的，不是你写的，而且它跑起来之后<b>立刻就进入了一个"等消息"的循环</b>，不是在执行你的逻辑；</li>' +
          '<li>你的代码是<b>被回调驱动的</b>：没人敲门，你一行代码都不跑。</li>' +
          '</ul>' +
          '<p><span class="hit">这个模型一旦建立，很多逆向里的困惑会自己消失：' +
          '为什么断点要下在 onCreate 而不是 main、为什么"启动后什么都不做"的 App 也在耗电、' +
          '为什么加固壳第一件事就是覆写 <span class="mono">attachBaseContext</span>。</span></p>'
      },
      html:
        T.note('key', '🔑 本章要建立的三个坐标系',
          '<p style="margin-bottom:0">' +
          '① <b>组件坐标系</b>——App 由哪四种东西组成，每一种<b>什么时候被系统唤起</b>（26.3–26.6）；<br>' +
          '② <b>线程坐标系</b>——主线程在干嘛、消息循环是怎么转的、为什么你的代码必须在特定线程上跑（26.8–26.9）；<br>' +
          '③ <b>进程坐标系</b>——你的 App 怎么和系统服务、和别的 App 说话（26.10–26.12）。<br>' +
          '而最后 26.13 会把这三套坐标系<b>翻译成逆向视角的观测点清单</b>。</p>') +
        '<p>先说一件很多人搞混的事：<b>进程 ≠ App。</b>' +
        '一个 App 可以配置成跑在多个进程里，一个进程里也可以只有 App 的一部分。' +
        '你在 <span class="mono">ps</span> 里看到的 <span class="mono">com.example.app:remote</span> 这种带冒号后缀的，' +
        '就是同一个 App 的另一个进程。</p>' +
        T.tbl(['概念', '谁决定', '逆向时的意义'],
          [
            ['<b>进程</b>', '系统（zygote fork）', '你的 hook 要注入到<b>正确的那个进程</b>——多进程 App 里，主进程 hook 不到 :remote 里的代码'],
            ['<b>组件</b>', '系统按请求唤起', '<b>每个组件入口都是一个可能的下钩点</b>，也是一个攻击面'],
            ['<b>线程</b>', '代码自己（主线程由系统起）', 'Hook 时要关心"这段代码跑在哪个线程上"——第 20.8 节讲过这个坑'],
            ['<b>生命周期回调</b>', '系统', '加固壳最爱的介入点，因为它比你的业务代码<b>更早</b>']
          ])
    },

    /* ============================================================ 26.2 */
    {
      h: '26.2', title: '点一下图标，系统到底做了什么',
      html:
        '<p>这是本章最重要的一条主线。很多"为什么"（为什么加固要抢在那一步、为什么 hook 早了没用）' +
        '都要靠它来回答。<b>下面这九步值得逐字看一遍。</b></p>' +
        T.note('warn', '⚠️ 一个反直觉的事实：你的代码不是"从头开始执行"的',
          '<p style="margin-bottom:0">App 进程是<b>被 fork 出来的</b>，不是被 <span class="mono">exec</span> 起来的。' +
          '这意味着它<b>生来就带着一大堆已经加载好的东西</b>——Zygote 进程里预加载的系统类和资源，子进程直接继承。<br>' +
          '<span class="hit">这就是为什么安卓能"秒开"一个 App，也是为什么 <span class="mono">.init_array</span>、' +
          '<span class="mono">attachBaseContext</span> 这些早期时机对加固方这么有价值：' +
          '它们比你想象的要早得多。</span></p>'),

      stepper: {
        title: '从点击图标到首帧显示：九步',
        lines: [
          { code: '<span class="c">// ① Launcher 收到点击</span>\nstartActivity(<span class="k">new</span> Intent(ACTION_MAIN, ...));',
            note: '<b>发起方是 Launcher，不是你的 App。</b>Launcher 也是一个普通 App，它只是调用了 <span class="mono">startActivity</span>。<br>' +
              '<b>注意这一步已经跨进程了</b>：Launcher 要通过 Binder 把请求交给系统服务，而不是直接启动你的 App。',
            state: { '步骤': '发起', '在哪个进程': 'Launcher', '跨进程？': '是（Binder）' } },
          { code: '<span class="c">// ② 请求到达 ATMS</span>\nActivityTaskManagerService.startActivity(...)',
            note: '<b>ATMS 是系统服务，跑在 system_server 进程里。</b>它负责"哪个 Activity 该在哪个任务栈、哪个进程里显示"。<br>' +
              '<b>逆向意义：</b>所有 Activity 启动都要过这里——所以你 <span class="mono">hook startActivity</span> 看到的是"意图"，' +
              '而真正的调度发生在 system_server 里（你通常没有权限注入那个进程）。',
            state: { '步骤': '调度', '在哪个进程': 'system_server', '跨进程？': '是' } },
          { code: '<span class="c">// ③ 需要新进程？通过 Zygote socket 请求 fork</span>\n<span class="c">// zygote 收到请求 → fork() → 返回子进程 pid</span>',
            note: '<b>关键：<span class="mono">fork</span> 而不是 <span class="mono">exec</span>。</b>' +
              'Zygote 预先加载了系统类库与资源，<b>fork 出来的子进程直接继承这些内存</b>——这是安卓启动速度的结构性原因。<br>' +
              '<span class="hit">这条机制有一个直接的逆向后果：<b>Zygote 是所有 App 的"共同祖先"</b>，' +
              '所以在 Zygote 里注入代码（第 22 章的 LSPosed 就是这么做的），就能对<b>之后启动的每一个 App 生效</b>。</span>',
            state: { '步骤': '起进程', '在哪个进程': 'zygote → 新进程', '跨进程？': 'socket' } },
          { code: '<span class="c">// ④ 子进程进入 ActivityThread.main()</span>\nLooper.prepareMainLooper();\n<span class="c">// ……注册 ApplicationThread、attach 到 AMS……</span>\nLooper.loop();   <span class="c">// ← 从此开始"等消息"</span>',
            note: '<b>这就是你的 App 唯一的 main()。</b>注意它做了什么：准备主线程的 Looper（26.8 节的主角），把 ' +
              '<span class="mono">ApplicationThread</span> 这个 Binder 对象注册给 AMS，然后<b>立刻进入死循环等消息</b>。<br>' +
              '<span class="hit">"App 的 main 就是一句 Looper.loop()"——这句话能解释很多疑惑：' +
              '为什么主线程不能被阻塞（它一旦被占住，谁的消息都处理不了）、为什么你的所有代码都是"被调度进来的"。</span>',
            state: { '步骤': '进入主循环', '在哪个进程': 'App 新进程', '跨进程？': '—' } },
          { code: '<span class="c">// ⑤ AMS 通过 ApplicationThread 回调 bindApplication</span>\n<span class="c">// （ApplicationThread 是 App 进程里的 Binder 服务端）</span>\nhandleBindApplication(...)',
            note: '<b>注意方向反过来了。</b>App 把自己的 <span class="mono">ApplicationThread</span> 交给 AMS 之后，' +
              'AMS 就能<b>反过来调用 App</b>。<br>' +
              '<b>这是安卓 IPC 的典型双向模式：</b>你调系统服务，系统服务也调你（通过你注册进去的回调）。' +
              '<span class="hit">逆向视角：如果你只盯着"App → 系统"这一个方向，就会漏掉一半的调用链。</span>',
            state: { '步骤': '回调 App', '在哪个进程': 'system_server → App', '跨进程？': 'Binder' } },
          { code: '<span class="c">// ⑥ 创建 ContentProvider（注意：早于 Application.onCreate！）</span>\ninstallContentProviders(app, providers);',
            note: '<b>这是本章最值钱的一个冷知识。</b>ContentProvider 的 <span class="mono">onCreate</span> 在 ' +
              '<span class="mono">Application.onCreate</span> <b>之前</b>执行。<br>' +
              '<span class="hit">所以：<b>如果你的初始化代码放在 Application.onCreate 里，而某个 Provider 已经依赖了它，就会拿到 null。</b>' +
              '这也是很多加固/风控把初始化逻辑塞进 ContentProvider 的原因——它能抢到更早的时机。</span>',
            state: { '步骤': '建 Provider', '在哪个进程': 'App', '跨进程？': '—' } },
          { code: '<span class="c">// ⑦ Application 登场</span>\napp.attachBaseContext(base);\napp.onCreate();',
            note: '<b><span class="mono">attachBaseContext</span> 是加固壳的标准介入点</b>——此时 <span class="mono">Context</span> 刚拿到手，' +
              '业务代码一行没跑，壳可以在这里解密 dex、造 ClassLoader、替换类加载器。<br>' +
              '第 19 章把"<span class="mono">attachBaseContext</span> 被覆写"列为"加固存在的第二强证据"，原因就在这里。',
            state: { '步骤': 'Application', '在哪个进程': 'App', '跨进程？': '—' } },
          { code: '<span class="c">// ⑧ 创建并驱动 Activity</span>\nactivity.attach(...);\nactivity.onCreate(savedInstanceState);\nactivity.onStart();\nactivity.onResume();',
            note: '<b>这才轮到"你写的代码"。</b>注意 <span class="mono">onCreate</span> 的入参 <span class="mono">savedInstanceState</span>' +
              '——它是"上次被杀之前的现场"，26.4 节会讲它为什么重要。<br>' +
              '<b>逆向抓手：</b>想找某个界面的业务逻辑，<span class="mono">onCreate</span> 是最自然的起点。' +
              '但要注意——<b>加固可能把 onCreate 也 Native 化了</b>（第 20.11 节）。',
            state: { '步骤': 'Activity', '在哪个进程': 'App', '跨进程？': '—' } },
          { code: '<span class="c">// ⑨ 首帧绘制 → 你看到界面</span>\n<span class="c">// measure → layout → draw → surface 合成 → 上屏</span>',
            note: '<b>到这一步之前，界面一直是"黑的"。</b>这条链上有一步很有逆向价值：' +
              '<span class="mono">View</span> 树的构建发生在 <span class="mono">onCreate</span>（<span class="mono">setContentView</span>）里，' +
              '所以<b>从资源 id 反查监听器</b>这条线索（26.13 与第 30 章）永远走得通。<br>' +
              '如果启动很慢，"卡在哪一步"本身就是线索——第 19 章讲过"<b>加固的代价就是它的特征</b>"。',
            state: { '步骤': '上屏', '在哪个进程': 'App + SurfaceFlinger', '跨进程？': '是（BufferQueue）' } }
        ]
      },

      after:
        T.note('ok', '✅ 这九步里，哪些是"逆向的必经之路"',
          '<p style="margin-bottom:0">' +
          '· <b>第 ④ 步</b>（Looper.loop）——解释了主线程的一切行为；<br>' +
          '· <b>第 ⑥ 步</b>（Provider 早于 Application）——解释了初始化顺序的坑，也是加固的藏身点；<br>' +
          '· <b>第 ⑦ 步</b>（attachBaseContext）——加固的第一现场；<br>' +
          '· <b>第 ⑤ 与第 ② 步</b>——解释了"为什么调用链是双向的"。<br>' +
          '<span class="hit">剩下的步骤你不需要背；你需要的是建立一个印象：<b>App 是"被系统一步步推着走"的，' +
          '每一步都有一个系统回调可以下钩子。</b></span></p>')
    },

    /* ============================================================ 26.3 */
    {
      h: '26.3', title: '四大组件：系统眼里的 App 长什么样',
      html:
        '<p>对系统来说，你的 App <b>不是一堆类，而是清单里声明的若干个组件</b>。' +
        '系统不认识你的业务逻辑，它只认识"这个 App 能提供哪些可被唤起的东西"。</p>' +
        T.tbl(['组件', '一句话职责', '谁唤起它', '它的入口回调', '逆向视角'],
          [
            ['<b>Activity</b>', '一块可见的界面', '<span class="mono">startActivity</span> / 通知点击 / 其他 App 唤起', '<span class="mono">onCreate</span> / <span class="mono">onNewIntent</span>',
             '<b>业务逻辑最集中的地方</b>；导出的 Activity 是攻击面（第 29 章）'],
            ['<b>Service</b>', '没有界面的后台工作', '<span class="mono">startService</span> / <span class="mono">bindService</span>', '<span class="mono">onStartCommand</span> / <span class="mono">onBind</span>',
             '常驻逻辑、心跳、上报；<b>注意它默认跑在主线程上</b>'],
            ['<b>BroadcastReceiver</b>', '接收"广播"这种系统级事件', '<span class="mono">sendBroadcast</span> / 系统事件（开机、网络变化）', '<span class="mono">onReceive</span>',
             '<b>静默触发点</b>——不需要界面就能跑代码，风控喜欢用它做环境检测'],
            ['<b>ContentProvider</b>', '把自己的数据开放给别的进程', '别的进程 <span class="mono">ContentResolver</span> 查询', '<span class="mono">onCreate</span> / <span class="mono">query</span> / <span class="mono">call</span>',
             '<b>启动最早</b>；也是目录遍历漏洞的高发地（第 29 章）']
          ]) +
        T.note('key', '🔑 把"组件"理解成"攻击面 + 观测点"',
          '<p style="margin-bottom:0">同一个东西有两面：<br>' +
          '· <b>对攻击者/审计者</b>——导出的组件是<b>可以绕过界面直接调的入口</b>。' +
          '一个 App 的界面只暴露了它想让你看到的功能，而组件清单暴露了<b>它所有能被唤起的地方</b>。<br>' +
          '· <b>对逆向者</b>——每个组件入口都是<b>一个稳定的下钩点</b>。' +
          '比起在几十万行代码里找"哪里是登录逻辑"，直接 hook <span class="mono">LoginActivity.onCreate</span> 要便宜得多。<br>' +
          '<span class="hit">而这两件事之所以成立，都是因为组件必须在 <span class="mono">AndroidManifest.xml</span> 里<b>显式声明</b>——' +
          '清单文件本身就是一份地图。</span></p>'),

      term: {
        title: '组件相关术语速查',
        lines: [
          { t: 'd', s: '# ── 声明与可见性 ──' },
          { t: 'o', s: 'android:exported="true|false"', note: '<b>决定"别的 App 能不能唤起这个组件"。</b>注意 Android 12（API 31）起<b>凡带 intent-filter 的组件必须显式写这个属性</b>，否则装不上——这本身就是一条可观测的版本线索。' },
          { t: 'o', s: '<intent-filter>', note: '<b>声明"我能响应什么意图"。</b>历史规则是"有 intent-filter 就默认 exported=true"，这也是很多越权漏洞的来源。' },
          { t: 'o', s: 'android:permission', note: '<b>给组件加一道权限门。</b>有它保护时外部调用方必须持有对应权限——所以判断攻击面时<b>必须把权限一起看</b>，只看 exported 会误判。' },
          { t: 'd', s: '' },
          { t: 'd', s: '# ── 与生命周期有关的声明 ──' },
          { t: 'o', s: 'android:process=":remote"', note: '<b>把这个组件放到独立进程。</b>带冒号是"App 私有进程"，不带冒号是全局进程名。<b>逆向时最容易踩的坑：hook 注入了主进程，而目标逻辑在 :remote 里。</b>' },
          { t: 'o', s: 'android:configChanges', note: '<b>声明"这些配置变化我自己处理，别重建我"。</b>声明了之后旋转屏幕不会走销毁重建流程——这会改变你观察到的生命周期序列。' },
          { t: 'o', s: 'android:launchMode', note: '<b>standard / singleTop / singleTask / singleInstance。</b>它决定"再启动一次是新建实例还是复用"，直接影响 <span class="mono">onCreate</span> 会不会被调用、以及 <span class="mono">onNewIntent</span> 会不会被触发。' },
          { t: 'd', s: '' },
          { t: 'd', s: '# ── 权限与存储 ──' },
          { t: 'o', s: '<uses-permission android:name="..."/>', note: '静态申请权限。<b>但声明 ≠ 授予</b>——运行时权限（API 23+）还要用户同意，逆向时看到声明就假定"有这个权限"是错的。' },
          { t: 'w', s: 'android:allowBackup="true"', note: '<b>允许 adb backup 导出应用数据</b>（含 SharedPreferences、数据库）。<b>这是第 29 章"明文保存"风险的放大器</b>，也是一个很常见的配置疏漏。' }
        ]
      },

      quiz: {
        id: 'q26-1', chapter: 26, answer: 1,
        stem: '一个 App 里有个 <span class="mono">ContentProvider</span>，同时 <span class="mono">Application</span> 里也有一段初始化代码。' +
          '下面关于执行顺序的说法，哪个是对的？',
        options: [
          { t: 'Application.onCreate 先执行，因为它是整个 App 的入口', why: '❌ 这是最符合直觉、也最常见的错答。<b>Provider 比 Application 更早。</b>' },
          { t: 'ContentProvider.onCreate 先执行，Application.onCreate 在后', why: '✅ 正确。在 <span class="mono">ActivityThread.handleBindApplication</span> 里，<b>安装 ContentProvider 发生在调用 Application.onCreate 之前</b>。这是本章最值钱的一个细节。' },
          { t: '两者的顺序由 AndroidManifest 里的声明顺序决定', why: '❌ 清单顺序不影响这个。Provider 的创建时机是框架写死的（早于 Application）。' },
          { t: '取决于 Provider 是否被导出（exported）', why: '❌ 导出与否只影响"别的 App 能不能访问它"，不影响它自己的创建时机。' }
        ],
        explain: '<b>顺序是：<span class="mono">attachBaseContext</span> → <span class="mono">ContentProvider.onCreate</span> → ' +
          '<span class="mono">Application.onCreate</span> → <span class="mono">Activity.onCreate</span>。</b><br><br>' +
          '为什么会这样？因为 Provider 是"<b>App 对外提供的能力</b>"，而 <span class="mono">Application</span> 只是"App 自己的容器"。' +
          '系统需要先把"对外能力"装好，才有资格说这个进程准备好了。<br><br>' +
          '<b>这个顺序在实战里的三个后果：</b><br>' +
          '① <b>初始化顺序 bug</b>：把初始化放在 <span class="mono">Application.onCreate</span>，而 Provider 已经依赖它 → 拿到 null。' +
          '正确做法是用 <span class="mono">ContentProvider</span> 做初始化（这也是很多 SDK 自动初始化的手法），或者用 <span class="mono">attachBaseContext</span>。<br>' +
          '② <b>加固与风控的藏身点</b>：想抢更早的时机，就注册一个 Provider。<span class="hit">你在 <span class="mono">Application.onCreate</span> 里下钩子，' +
          '可能已经晚了一步。</span><br>' +
          '③ <b>观测顺序</b>：如果你在排查"某个全局状态没准备好"，<b>先确认 Provider 有没有被提前创建</b>——' +
          '很多"莫名其妙"的空指针都是这个顺序造成的。'
      }
    },

    /* ============================================================ 26.4 */
    {
      h: '26.4', title: 'Activity 生命周期：系统在什么时候敲你的门',
      intuition: {
        tag: '直觉模型 · 一个随时会被打断的会面',
        body:
          '<p>把 Activity 想成<b>你和用户的一次会面</b>。问题是：<strong>这次会面随时可能被打断</strong>——' +
          '电话来了、用户按了 Home、你把手机转了个方向、系统内存不够把你赶走。</p>' +
          '<p>生命周期回调就是<b>系统在每次状态变化时敲你的门，告诉你"现在是什么情况"</b>：</p>' +
          '<ul>' +
          '<li><span class="mono">onCreate</span>：<b>会面开始了，先把材料准备好</b>（只发生一次）；</li>' +
          '<li><span class="mono">onStart</span>：<b>你出现了，但用户还没法跟你说话</b>（界面可见但不在前台）；</li>' +
          '<li><span class="mono">onResume</span>：<b>用户开始跟你说话</b>（可交互，这是"前台"）；</li>' +
          '<li><span class="mono">onPause</span>：<b>有人插话了</b>（另一个界面盖上来，但你还能看见一部分）——<b>赶紧保存关键状态</b>；</li>' +
          '<li><span class="mono">onStop</span>：<b>你完全被挡住了</b>；</li>' +
          '<li><span class="mono">onDestroy</span>：<b>会面彻底结束</b>。</li>' +
          '</ul>' +
          '<p><span class="hit">记住一条：<b>onPause 和 onStop 的区别是"还看得见"和"看不见"。</b>' +
          '而 Android 的设计意图是让 App 在 onStop 之后<b>随时可以被无声杀掉而不需要更多回调</b>——' +
          '所以你保存状态的动作必须发生在 onStop 之前。</span></p>'
      },
      html:
        '<p>生命周期最容易被误解的一点是：<b>它不是一条直线，而是一个可以被系统任意打断、任意重入的状态机。</b></p>' +
        T.tbl(['回调', '什么时候来', '此时能不能交互', '你该做什么'],
          [
            ['<span class="mono">onCreate</span>', 'Activity 对象被创建', '不能（还没显示）', '<b>只做一次的事</b>：setContentView、绑定 ViewModel、读 Intent'],
            ['<span class="mono">onStart</span>', '即将可见', '不能', '注册只需要"可见期间有效"的资源'],
            ['<span class="mono">onResume</span>', '可见且可交互', '<b>能</b>', '开启动画、申请定位、注册传感器'],
            ['<span class="mono">onPause</span>', '失去前台（但仍可能可见）', '<b>不能</b>', '<b>尽快</b>：提交未保存的数据、停掉动画。<b>这个回调必须快</b>'],
            ['<span class="mono">onStop</span>', '完全不可见', '不能', '释放重资源、注销监听'],
            ['<span class="mono">onRestart</span>', '从 onStop 回到 onStart 之前', '不能', '重新准备（注意：<b>这是"回来"与"新建"的分界</b>）'],
            ['<span class="mono">onDestroy</span>', '销毁前（主动 finish 或被系统回收）', '不能', '释放一切。<b>但它不保证一定被调用</b>']
          ]) +
        T.note('warn', '⚠️ 三个必须知道的"反直觉"',
          '<p style="margin-bottom:0">' +
          '① <b>onDestroy 不保证被调用。</b>进程被系统直接杀掉时，不会有任何回调。' +
          '<span class="hit">所以任何"必须在退出时执行"的逻辑，</span>放在 onDestroy 里都是不可靠的。<br>' +
          '② <b>旋转屏幕默认会销毁重建 Activity。</b>这是新手最常见的"我的状态没了"的原因；' +
          '声明 <span class="mono">configChanges</span> 或使用 <span class="mono">ViewModel</span> / <span class="mono">onSaveInstanceState</span> 才能挺过去。<br>' +
          '③ <b>onSaveInstanceState 与 onStop 的先后是随版本变的。</b>' +
          '<span class="pill warn">在较新的版本上它出现在 onStop 之后（这是一处有明确版本分界的行为变更），' +
          '具体分界版本请以官方文档为准</span>。<b>所以不要写"依赖两者顺序"的代码。</b></p>'),

      stage: {
        title: '生命周期状态机：把一个 Activity 走一遍（含"被旋转屏幕打断"）',
        speed: 1400,
        render:
          '<div class="card">' +
            '<div class="flex" style="gap:6px;flex-wrap:wrap;margin-bottom:10px">' +
              '<span class="blk" id="lc-create">onCreate</span>' +
              '<span class="arrow">→</span>' +
              '<span class="blk" id="lc-start">onStart</span>' +
              '<span class="arrow">→</span>' +
              '<span class="blk" id="lc-resume">onResume</span>' +
              '<span class="arrow">→</span>' +
              '<span class="blk" id="lc-pause">onPause</span>' +
              '<span class="arrow">→</span>' +
              '<span class="blk" id="lc-stop">onStop</span>' +
              '<span class="arrow">→</span>' +
              '<span class="blk" id="lc-destroy">onDestroy</span>' +
            '</div>' +
            '<div class="flex" style="gap:6px;flex-wrap:wrap">' +
              '<span class="blk" id="lc-restart">onRestart（从 Stop 回来时才走）</span>' +
              '<span class="blk" id="lc-save">onSaveInstanceState</span>' +
            '</div>' +
          '</div>' +
          '<div class="card" style="margin-top:12px"><div class="card-title">当前状态</div>' +
            '<div id="lc-state" class="mono" style="font-size:13px">（未开始）</div>' +
            '<div id="lc-log" class="small" style="margin-top:8px;line-height:1.9"></div>' +
          '</div>',
        reset: () => {
          ['lc-create', 'lc-start', 'lc-resume', 'lc-pause', 'lc-stop', 'lc-destroy', 'lc-restart', 'lc-save']
            .forEach(id => S(id, ''));
          SET('lc-state', '（未开始）');
          SET('lc-log', '');
        },
        steps: [
          { run: () => { S('lc-create', 'active'); S('lc-start', 'active'); S('lc-resume', 'active'); SET('lc-state', 'RESUMED（前台，可交互）'); },
            note: '<b>① 首次启动：onCreate → onStart → onResume。</b>三步一气呵成，中间没有停顿——因为界面一准备好就直接进前台了。<br>' +
              '<b>观测点：</b>如果你的 hook 只打了 onResume，你会漏掉 onCreate 里那些"只做一次"的初始化（读取 Intent、解密配置）。' },
          { run: () => { S('lc-resume', 'done'); S('lc-pause', 'hot'); SET('lc-state', 'PAUSED（失去前台，可能仍可见）'); SET('lc-log', '另一界面盖上来 → onPause 先执行'); },
            note: '<b>② 被另一个界面盖住：onPause。</b><b>注意顺序：是先让旧界面 onPause，再让新界面 onResume</b>——' +
              '所以 onPause 里做重活会直接拖慢界面切换的体感。<br>' +
              '<span class="hit">逆向意义：onPause 里常常有"上报埋点""保存草稿"这类逻辑，' +
              '因为它是"用户可能再也不回来"之前最后一次可靠的机会。</span>' },
          { run: () => { S('lc-pause', 'done'); S('lc-stop', 'hot'); SET('lc-state', 'STOPPED（完全不可见）'); SET('lc-log', '界面被完全挡住 → onStop'); },
            note: '<b>③ 完全不可见：onStop。</b>到这里，系统已经认为<b>"这个 Activity 随时可以被回收，不需要再通知你"</b>。<br>' +
              '<b>所以所有必须落盘的东西都该在 onStop 之前完成。</b>' },
          { run: () => { S('lc-stop', 'done'); S('lc-restart', 'active'); S('lc-start', 'active'); S('lc-resume', 'active'); SET('lc-state', 'RESUMED（从后台回来）'); SET('lc-log', '用户切回来 → onRestart → onStart → onResume'); },
            note: '<b>④ 用户切回来：onRestart → onStart → onResume。</b><b>注意 onCreate 没有再被调用</b>——对象还在，状态还在。<br>' +
              '<span class="hit">这就是 onRestart 存在的意义：它让你把"回到前台"和"首次创建"分开处理。' +
              '反过来，如果你看到 onCreate 被调用了第二次，说明这个 Activity 之前被销毁过（或 launchMode 导致了新实例）。</span>' },
          { run: () => { S('lc-restart', 'done'); S('lc-save', 'warn'); SET('lc-log', '旋转屏幕 → onPause → onStop → onSaveInstanceState → onDestroy → onCreate → onStart → onResume'); },
            note: '<b>⑤ 旋转屏幕：整个销毁重建。</b>序列是 <span class="mono">onPause → onStop → onSaveInstanceState → onDestroy → onCreate → onStart → onResume</span>。<br>' +
              '<b>这一步是本章最值得记住的"陷阱"</b>：<br>' +
              '· 你的 Hook 如果在 onCreate 里装了一次性的桩，<b>旋转一次就装了两遍</b>；<br>' +
              '· 你观察到的"某个方法被调用了两次"，可能只是屏幕转了一下；<br>' +
              '· <span class="pill warn">onSaveInstanceState 与 onStop 的先后在较新版本上发生过变化，不要依赖这个顺序</span>。' },
          { run: () => { S('lc-save', 'done'); ['lc-create', 'lc-start', 'lc-resume', 'lc-pause', 'lc-stop', 'lc-restart'].forEach(id => S(id, '')); S('lc-destroy', 'bad'); SET('lc-state', 'DESTROYED'); SET('lc-log', ''); },
            note: '<b>⑥ 销毁：onDestroy。</b>但请记住前面那条警告——<b>被系统直接杀进程时，这个回调根本不会来</b>。<br>' +
              '<span class="hit">所以"退出时清理"这种设计在安卓上天生不可靠，必须改成"关键节点增量保存"。</span>' }
        ]
      },

      quiz: {
        id: 'q26-2', chapter: 26, answer: 2,
        stem: '你写了一个 Frida 脚本，在目标 App 的某个 <span class="mono">Activity.onCreate</span> 里替换了一个方法的实现，' +
          '并且用了一个全局标志位保证"只替换一次"。测试时你发现<b>替换确实生效了，但日志里能看到初始化代码跑了两次</b>。最可能的原因是？',
        options: [
          { t: 'Frida 的 hook 被重复注入了', why: '❌ 如果真的重复注入，你通常会看到更明显的异常（比如脚本报错、hook 冲突），而不是"业务初始化跑了两次"。' },
          { t: '目标 App 有两个同名的 Activity 在不同进程', why: '❌ 有可能，但这是比较少见的结构；而且在多进程情况下，你通常会先注意到"另一个进程完全没被 hook 到"，而不是"跑了两次"。' },
          { t: 'Activity 经历了销毁重建（比如屏幕旋转、或配置变化），onCreate 被系统重新调用了一次', why: '✅ 最可能。**onCreate 被调用两次是 Activity 重建的典型标志**，而重建最常见的原因就是配置变化（旋转屏幕、切换深色模式、字体大小变化…）。' },
          { t: 'App 使用了 launchMode="singleTask"，这会导致 onCreate 执行两次', why: '❌ 方向反了。<b>singleTask 的作用恰恰是"复用已有实例"</b>，它会让系统优先走 <span class="mono">onNewIntent</span> 而不是再次 <span class="mono">onCreate</span>。' }
        ],
        explain: '<b>先把"onCreate 跑两次"这件事读对：它几乎总是在说"这个 Activity 被销毁重建了"。</b><br><br>' +
          '<b>重建的常见触发：</b><br>' +
          '· <b>配置变化</b>——旋转、深色模式切换、语言/字体变化、外接键盘插拔……<b>这是最常见的</b>；<br>' +
          '· <b>进程被回收后再回来</b>——系统杀掉进程，用户从最近任务切回，会重建；<br>' +
          '· <b>主动 recreate()</b>——有些 App 用它来应用主题切换。<br><br>' +
          '<b>为什么这对逆向的人特别重要（三条实战影响）：</b><br>' +
          '① <b>Hook 的幂等性。</b>在 <span class="mono">onCreate</span> 里装的桩，重建后会再装一次。' +
          '如果桩本身不幂等（比如往列表里 push 数据、或者重新注册了一个全局监听器），你会得到重复行为。' +
          '<span class="hit">正确做法是：要么用 <span class="mono">Java.use</span> 在类层面替换（天然只生效一次），' +
          '要么在运行时维护一个"已处理实例"的集合。</span><br>' +
          '② <b>观测噪声。</b>你看到的"初始化跑了两次"很可能根本不是重复调用，而是两次独立的生命周期。' +
          '<b>分不清这两者，你会去改一个根本不存在的 bug。</b><br>' +
          '③ <b>状态丢失类问题的根源。</b>如果作者把状态只存在 Activity 字段上，重建就丢——' +
          '这类"偶发 bug"在用户那里表现为"转个屏幕就白屏了"。<br><br>' +
          '<b>怎么快速确认是哪一个原因：</b>在 <span class="mono">onCreate</span> 里把 ' +
          '<span class="mono">savedInstanceState == null</span> 以及 <span class="mono">hashCode()</span>（对象实例标识）打出来。' +
          '<b>实例标识不同 + savedInstanceState 不为 null = 重建</b>；实例标识相同 = 那才叫重复调用。'
      }
    },

    /* ============================================================ 26.5 */
    {
      h: '26.5', title: 'Service：它不是你想要的"后台线程"',
      html:
        '<p>这是新手最容易误解的组件。名字叫 Service、文档说"后台工作"，于是很多人以为它跑在后台线程上。</p>' +
        T.note('bad', '☠️ 最重要的一个纠正：Service 默认跑在主线程上',
          '<p style="margin-bottom:0"><span class="mono">Service</span> 的所有生命周期回调' +
          '（<span class="mono">onCreate</span> / <span class="mono">onStartCommand</span> / <span class="mono">onBind</span>）' +
          '<b>都由主线程的 Looper 调度执行</b>——和 Activity 一模一样。<br>' +
          '<span class="hit">所以"在 Service 里做耗时操作"和"在 Activity 里做耗时操作"一样会导致 ANR。' +
          'Service 解决的是"生命周期长"，不是"线程问题"。</span><br>' +
          '<b>逆向意义：</b>如果你怀疑某段逻辑跑在主线程上，<b>不要因为它在 Service 里就排除它</b>。' +
          '第 20.8 节讲过"native 自建线程"的排查，这里补上另一半：<b>Java 层的 Service 不等于子线程。</b></p>') +
        T.tbl(['启动方式', '生命周期', '什么时候结束', '典型用途'],
          [
            ['<b>startService</b>', '<span class="mono">onCreate</span> → <span class="mono">onStartCommand</span>（可多次）→ <span class="mono">onDestroy</span>',
             '调用方 <span class="mono">stopService</span> 或 Service 自己 <span class="mono">stopSelf</span>；<b>与调用方的死活无关</b>',
             '下载、播放、后台任务'],
            ['<b>bindService</b>', '<span class="mono">onCreate</span> → <span class="mono">onBind</span> → <span class="mono">onUnbind</span> → <span class="mono">onDestroy</span>',
             '<b>最后一个客户端解绑时自动销毁</b>',
             '跨进程调用、给别的组件提供服务'],
            ['<b>两者同时用</b>', '两套回调会混合', '<b>必须既 stop 又 unbind，才会销毁</b>',
             '既要长期运行、又要被调用']
          ]) +
        T.note('warn', '⚠️ 两个必须知道的现实约束（都不是"最佳实践"，是硬限制）',
          '<p style="margin-bottom:0">' +
          '① <b>后台启动 Service 受限。</b>从 Android 8.0 起，处于后台的 App 不能随意 <span class="mono">startService</span>，' +
          '要用 <span class="mono">startForegroundService</span> 并且<b>必须在几秒内显示一个通知</b>，否则会被系统杀并报错。' +
          '<span class="hit">这条限制有一个逆向上的副作用：<b>如果一个 App 有常驻通知，它很可能就是在用前台 Service。</b>' +
          '这条线索能帮你快速判断"它的后台逻辑是怎么活下来的"。</span>' +
          '<span class="pill warn">具体的超时秒数与各版本的限制细节随时间变化，请以官方文档当期说明为准</span><br>' +
          '② <b>前台 Service 需要通知，而通知是用户可见的。</b>所以大量风控/心跳逻辑转而去用 ' +
          '<span class="mono">JobScheduler</span> / <span class="mono">WorkManager</span> / <span class="mono">AlarmManager</span>，' +
          '或者干脆注册一个进程级的东西。<b>你找不到 Service，不代表它没有后台逻辑。</b></p>'),

      stage: {
        title: '两种启动方式的生命周期差异（以及"忘了 unbind"的后果）',
        speed: 1300,
        render:
          '<div class="grid2">' +
            '<div class="card"><div class="card-title">startService 路径</div>' +
              '<div class="blk" id="sv-a1">onCreate</div><div class="arrow">↓</div>' +
              '<div class="blk" id="sv-a2">onStartCommand</div><div class="arrow">↓</div>' +
              '<div class="blk" id="sv-a3">（运行中，可再次 onStartCommand）</div><div class="arrow">↓</div>' +
              '<div class="blk" id="sv-a4">stopService / stopSelf</div><div class="arrow">↓</div>' +
              '<div class="blk" id="sv-a5">onDestroy</div>' +
            '</div>' +
            '<div class="card"><div class="card-title">bindService 路径</div>' +
              '<div class="blk" id="sv-b1">onCreate</div><div class="arrow">↓</div>' +
              '<div class="blk" id="sv-b2">onBind</div><div class="arrow">↓</div>' +
              '<div class="blk" id="sv-b3">（客户端持有连接）</div><div class="arrow">↓</div>' +
              '<div class="blk" id="sv-b4">onUnbind</div><div class="arrow">↓</div>' +
              '<div class="blk" id="sv-b5">onDestroy</div>' +
              '<div id="sv-note" class="small muted" style="margin-top:8px"></div>' +
            '</div>' +
          '</div>',
        reset: () => {
          ['sv-a1', 'sv-a2', 'sv-a3', 'sv-a4', 'sv-a5', 'sv-b1', 'sv-b2', 'sv-b3', 'sv-b4', 'sv-b5']
            .forEach(id => S(id, ''));
          SET('sv-note', '');
        },
        steps: [
          { run: () => { S('sv-a1', 'active'); S('sv-b1', 'active'); }, note: '<b>① 两种方式都以 onCreate 开始，而且都只执行一次。</b>即使你调十次 <span class="mono">startService</span>，<span class="mono">onCreate</span> 也只跑一次——后面九次走的是 <span class="mono">onStartCommand</span>。<br><b>这个"只创建一次"的性质，是判断"某段初始化逻辑是否可靠"的关键。</b>' },
          { run: () => { S('sv-a1', 'done'); S('sv-a2', 'active'); S('sv-b1', 'done'); S('sv-b2', 'active'); }, note: '<b>② 分岔点。</b>start 路径进 <span class="mono">onStartCommand</span>（<b>每次 start 都会调，且要通过返回值声明"被杀后要不要重启"</b>）；bind 路径进 <span class="mono">onBind</span>（<b>返回一个 IBinder，这就是 26.10 节的主角</b>）。<br><span class="hit">注意 onStartCommand 的返回值（START_STICKY / START_NOT_STICKY / START_REDELIVER_INTENT）决定系统杀进程后是否重建 Service——这是"为什么这个 App 杀不死"的一个常见答案。</span>' },
          { run: () => { S('sv-a2', 'done'); S('sv-a3', 'cool'); S('sv-b2', 'done'); S('sv-b3', 'cool'); }, note: '<b>③ 运行中。</b>两条路径此刻看起来一样，但"谁决定它活着"完全不同：<br>· start 路径——<b>由 stop 决定</b>，跟调用方的死活无关；<br>· bind 路径——<b>由绑定者决定</b>，最后一个客户端解绑就自动销毁。' },
          { run: () => { S('sv-a3', 'done'); S('sv-a4', 'warn'); SET('sv-note', '客户端 unbind 了，但 Service 还在跑——因为它是 start 起来的。'); },
            note: '<b>④ 混合场景的坑（这是真实代码里最常见的泄漏源）。</b>如果一个 Service <b>既被 start 又被 bind</b>：' +
              '客户端解绑了，它<b>不会销毁</b>——因为还有"start 起来"这个身份在。<br>' +
              '<span class="hit">所以很多 App 会出现"Service 永远不退出"的现象，而作者自己也不知道为什么。</span>' +
              '<b>逆向视角：这也意味着"你以为的清理时机"可能根本不会到来。</b>' },
          { run: () => { S('sv-a4', 'done'); S('sv-a5', 'done'); S('sv-b3', 'done'); S('sv-b4', 'done'); S('sv-b5', 'done'); },
            note: '<b>⑤ 两条路径最终都收敛到 onDestroy，但触发条件不同。</b>把这句话记住就够用了：' +
              '<b>start 起来的不怕客户端走，bind 起来的跟着客户端走。</b>' }
        ]
      }
    },

    /* ============================================================ 26.6 */
    {
      h: '26.6', title: 'BroadcastReceiver 与 ContentProvider：两个"不起眼"的入口',
      html:
        '<p>这两个组件在业务开发里没那么显眼，但在<b>逆向与安全里权重很高</b>——原因就一个：' +
        '<b>它们都能"在没有界面的情况下被执行"。</b></p>' +
        T.card('BroadcastReceiver：无界面执行代码的标准手段',
          '<p>它的入口只有 <span class="mono">onReceive(context, intent)</span> 一个回调，而这个回调有几个硬约束：</p>' +
          T.tbl(['约束', '内容', '为什么重要'],
            [
              ['<b>跑在主线程</b>', '<span class="mono">onReceive</span> 由主线程调度', '在里面做耗时操作会 ANR——和 Service 同一个坑'],
              ['<b>时间很短</b>', '超过限定时间会被系统判定为 ANR <span class="pill warn">具体超时值随版本与前后台状态变化</span>', '所以它只适合"触发一下"，不适合干活'],
              ['<b>生命周期极短</b>', '回调返回后这个 Receiver 实例就不再有意义（静态注册的除外）', '不能依赖它的字段保存状态'],
              ['<b>可以被外部触发</b>', '导出的 Receiver 能被任意 App 用 <span class="mono">sendBroadcast</span> 触发', '<b>这是第 29 章"BroadcastReceiver 导出漏洞"的根</b>']
            ]) +
          '<p style="margin-bottom:0"><b>静态注册 vs 动态注册</b>（这个区别在实战里很实用）：' +
          '静态注册写在清单里，<b>App 没启动也能被唤起</b>（所以是很好的"冷启动入口"）；' +
          '动态注册在代码里 <span class="mono">registerReceiver</span>，只在注册后有效，' +
          '而且新版本对隐式广播有额外限制。<span class="hit">逆向时：想找"App 是怎么被静默唤起的"，先看清单里的 Receiver。</span></p>') +
        T.card('ContentProvider：最早执行、也最容易出漏洞',
          '<p>它的作用是"把数据开放给别的进程"，入口是几个标准方法：' +
          '<span class="mono">query</span> / <span class="mono">insert</span> / <span class="mono">update</span> / ' +
          '<span class="mono">delete</span> / <span class="mono">openFile</span> / <span class="mono">call</span>。</p>' +
          '<p>三个要点：</p>' +
          '<ul>' +
          '<li><b>它的 onCreate 早于 Application.onCreate</b>（26.3 的 quiz 讲过）——这是它在逆向里最独特的价值：' +
          '<span class="hit">想抢最早的执行时机，就注册一个 Provider。</span></li>' +
          '<li><b>它通过 URI 暴露数据</b>：<span class="mono">content://authority/path/id</span>。' +
          '而 URI 是<b>外部可控的字符串</b>——输入校验不到位就是目录遍历（第 29 章会专门讲 <span class="mono">openFile</span> 的路径拼接问题）。</li>' +
          '<li><b><span class="mono">call</span> 方法是一个"后门式"的通用入口</b>：它允许用自定义方法名传参，' +
          '很多 App 用它来做 IPC，而审计工具不一定认得出来。<b>看到一个导出的 Provider 带 call 实现，值得多看一眼。</b></li>' +
          '</ul>') +
        T.note('key', '🔑 把这两个组件收成一句话',
          '<p style="margin-bottom:0"><b>Activity 和 Service 是"用户/开发者视角"的组件，' +
          'BroadcastReceiver 和 ContentProvider 是"系统/其他 App 视角"的组件。</b><br>' +
          '前两者的存在感来自界面与后台任务，后两者的存在感来自<b>"被别人找上门"</b>。<br>' +
          '所以：<b>分析一个 App 的攻击面时，重点看后两个；分析它的业务逻辑时，重点看前两个。</b></p>')
    },

    /* ============================================================ 26.7 */
    {
      h: '26.7', title: 'Context 与存储沙箱：你的文件到底能放哪',
      html:
        '<p>"读写 sdcard"这件事在安卓上<b>不是一个 API 问题，而是一个版本问题</b>——' +
        '过去十年里权限模型改过好几轮，很多教程和代码示例早就过期了。' +
        '而它对逆向很直接：<b>你想让 App 读一个文件、或想找到它写到哪去了，必须知道当前的规则。</b></p>' +
        T.tbl(['位置', '路径形态', '属于谁', '需要权限吗'],
          [
            ['<b>内部私有目录</b>', '<span class="mono">/data/data/&lt;pkg&gt;/</span>（新版本实际在 <span class="mono">/data/user/0/&lt;pkg&gt;/</span>）',
             '<b>只有本 App</b>（+ root）', '<b>不需要</b>。<span class="mono">files/</span> / <span class="mono">cache/</span> / <span class="mono">databases/</span> / <span class="mono">shared_prefs/</span> 都在这里'],
            ['<b>外部私有目录</b>', '<span class="mono">/sdcard/Android/data/&lt;pkg&gt;/</span>',
             '本 App（但<b>其他 App 在旧版本上也能访问</b>）', '<b>不需要</b>（API 19 起免权限）'],
            ['<b>共享媒体目录</b>', '<span class="mono">/sdcard/DCIM/</span>、<span class="mono">/sdcard/Pictures/</span>、<span class="mono">/sdcard/Download/</span>',
             '所有 App 共享', '<b>看版本</b>——这正是本章实验要算的东西'],
            ['<b>其他 App 的外部私有目录</b>', '<span class="mono">/sdcard/Android/data/&lt;别的包名&gt;/</span>',
             '别的 App', '<b>新版本上禁止</b>（分区存储的默认行为）']
          ]) +
        T.note('warn', '⚠️ 权限模型的三次转折（这是最容易讲过时的部分）',
          '<p style="margin-bottom:0">' +
          '① <b>分区存储（Scoped Storage）之前</b>：申请 <span class="mono">READ/WRITE_EXTERNAL_STORAGE</span> 之后，' +
          '基本等于"能读写整张 sdcard"——包括别的 App 的目录。<b>这是"SDCard 目录遍历"类作业诞生的时代背景。</b><br>' +
          '② <b>Android 10（API 29）引入分区存储</b>：App 默认只能看到自己的目录和通过 MediaStore 管理的媒体；' +
          '当年可以用 <span class="mono">requestLegacyExternalStorage</span> 临时退回旧行为。<br>' +
          '③ <b>Android 11（API 30）起强制分区存储</b>：那个临时开关失效了。要访问共享目录，' +
          '要么走 <b>MediaStore</b>，要么申请<b>「所有文件访问权限」</b>（<span class="mono">MANAGE_EXTERNAL_STORAGE</span>，' +
          '需要在应用商店说明用途，属于敏感权限）。<br>' +
          '<span class="pill warn">具体的 API 级别分界、各版本的行为差异、以及厂商 ROM 的额外改动，请以官方文档当期说明为准——' +
          '这一块是本章最容易过期的内容。</span><br>' +
          '<span class="hit">逆向视角：<b>看到 App 申请了「所有文件访问权限」，这条信息本身就很有价值</b>——' +
          '它意味着这个 App 需要遍历共享目录（常见于文件管理、清理、备份、以及某些风控取证逻辑）。</span></p>'),

      lab: {
        title: '实验一：存储路径与权限判定器',
        goal: '目标：算出"这个路径在当前版本上能不能读写"',
        intro:
          '<p>下面这个判定器按<b>真实的分层规则</b>工作：先判断路径属于哪一类存储，' +
          '再看目标 API 级别与已声明/已授予的权限，最后给出结论与"正确做法"。</p>' +
          '<p>建议你按这个顺序试几组：<br>' +
          '① 保持默认，看一个普通的共享目录；<br>' +
          '② 把 API 从 29 改成 30、31，观察结论怎么变；<br>' +
          '③ 把路径改成 <span class="mono">/sdcard/Android/data/别的包名/</span>；<br>' +
          '④ 试试带 <span class="mono">../</span> 的路径——看看它能不能"逃出"自己的沙箱。</p>' +
          '<p><b>注意第 ④ 组</b>：这不是存储权限问题，而是<b>路径拼接漏洞</b>问题——' +
          '很多 ContentProvider 目录遍历漏洞就是这么来的（第 29 章详讲）。</p>',
        inputs: [
          { key: 'path', label: '要访问的路径', hint: '可以带 ../ 试试', value: '/sdcard/Download/report.pdf' },
          { key: 'api', label: '目标 API 级别（Android 版本对应：29=10, 30=11, 31=12, 33=13, 34=14）', ph: '30', value: '30' },
          { key: 'perm', label: '已声明/已授予的权限（逗号分隔，可留空）',
            hint: '例如 READ_EXTERNAL_STORAGE,WRITE_EXTERNAL_STORAGE,MANAGE_EXTERNAL_STORAGE',
            value: 'READ_EXTERNAL_STORAGE' },
          { key: 'pkg', label: '本 App 的包名', ph: 'com.example.app', value: 'com.example.app' }
        ],
        runLabel: '🔍 判定',
        autorun: true,
        run: v => ch26Storage(v),
        hint:
          '<b>判定的三步：</b>① 先看路径<b>属于哪一类存储</b>（内部私有 / 外部私有 / 共享媒体 / 别人的私有目录）；' +
          '② 再看<b>目标 API 级别落在哪一段</b>（分区存储之前 / Android 10 / Android 11 及以后）；' +
          '③ 最后看<b>权限够不够</b>（注意 MANAGE_EXTERNAL_STORAGE 是"所有文件访问"，与普通存储权限不是一个层级）。<br><br>' +
          '<b>关于 <span class="mono">../</span>：</b>想一想——如果 App 在拼接路径时只做字符串拼接、' +
          '不做规范化，那么 <span class="mono">../</span> 会把"沙箱内的一个子目录"变成"沙箱外的任意位置"。',
        after:
          T.note('ok', '✅ 实验一的收获',
            '<p style="margin-bottom:0">你应该已经看到了：<b>同一行代码，换个 API 级别就完全不能用。</b><br>' +
            '这就是为什么"照着两年前的教程写存储"会失败，也是为什么<b>逆向时看到一段可疑的文件访问逻辑，' +
            '要先把它的目标版本搞清楚</b>——不然你会把"在新版本上必然失败"的代码当成"有效的攻击面"。<br>' +
            '<span class="hit">而 <span class="mono">../</span> 那一组告诉的是另一件事：' +
            '<b>存储权限管的是"能不能进这个目录"，路径规范化管的是"能不能出这个目录"——这是两个独立的问题，两个都要有。</b></span></p>')
      },

      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '起点',
            scenario: '<b>情境：</b>你要分析一个文件管理类 App。你发现它在启动时会<b>遍历 <span class="mono">/sdcard</span> 下的目录</b>' +
              '并把结果上报。你的设备是 Android 13。你想在 Frida 里复现它的遍历逻辑，看看它到底在找什么。' +
              '你直接在 Frida 里调用了它自己的遍历函数，<b>结果返回空列表</b>。',
            q: '最可能的原因是什么？',
            choices: [
              { t: 'A. 遍历函数被加固保护了，检测到 Frida 就返回空', next: 'na' },
              { t: 'B. 目标 App 申请了「所有文件访问权限」并在真机上被授予，而你的 Frida 脚本运行的环境没有这个权限', next: 'nb' },
              { t: 'C. Android 13 禁止任何 App 遍历 /sdcard，这个 App 在真机上也是空的', next: 'nc' },
              { t: 'D. 遍历逻辑在 native 层，Java 层调用只是壳', next: 'nd' }
            ]
          },
          na: {
            label: '选A', terminal: true, verdict: 'bad', verdictTitle: '把一个权限问题归因给了对抗',
            result: '<b>这个归因跳过了最关键的一步：先确认"在同样的条件下，它本来应该返回什么"。</b><br><br>' +
              '有一个很便宜的办法可以排除掉你的怀疑：<b>在没注入 Frida 的情况下，用同样的权限去读同一个目录</b>' +
              '（比如 <span class="mono">adb shell ls /sdcard</span>，再对比 App 自己的行为）。' +
              '如果 App 在真机上能列出文件、而你的脚本不能，那问题在<b>权限上下文</b>，不在对抗。<br><br>' +
              '<b>认知根源：</b>在"已知目标有防护"的前提下，人容易把一切异常都归到防护上。' +
              '但<b>权限/环境差异导致的失败，和"被检测到"导致的失败，现象完全不同</b>——' +
              '前者是"返回空/报错但进程正常"，后者通常是崩溃、退出、或后续行为异常。<br>' +
              '<span class="hit">先排除环境和权限，再怀疑对抗。这个顺序能省掉大量无效的对抗分析。</span>'
          },
          nb: {
            label: '选B', terminal: true, verdict: 'good', verdictTitle: '正确：先看权限上下文，再看代码逻辑',
            result: '<b>这是最符合现象的解释。</b>理由：<br><br>' +
              '① <b>Android 11（API 30）起，要遍历共享目录就必须有「所有文件访问权限」</b>' +
              '（<span class="mono">MANAGE_EXTERNAL_STORAGE</span>）。这个权限<b>不是普通运行时权限</b>，' +
              '它需要在设置里单独授予，而且 Google Play 对它有严格的用途审核。<br>' +
              '② <b>你注入的 Frida 脚本，其代码运行在目标 App 的进程里，用的是目标 App 的 UID</b>——' +
              '所以权限上下文<b>取决于目标 App 被授予了什么</b>，而不是你的 adb shell。<br>' +
              '③ <b>但从 adb shell 手动跑同样的目录遍历，用的是 shell 的 UID</b>（在非 root 的 userdebug 上权限也不同）。' +
              '<span class="hit">这两者的权限不是一回事，所以"adb 能列、App 不能列"是完全可能的。</span><br><br>' +
              '<b>怎么验证：</b>查目标 App 的权限授予状态（<span class="mono">dumpsys package &lt;pkg&gt;</span> 看 ' +
              '<span class="mono">MANAGE_EXTERNAL_STORAGE</span> 是否 granted），再看它有没有在代码里检查这个权限、' +
              '拿不到时是否静默返回空。<b>如果是，那你在设备上补上这个权限，遍历就正常了。</b><br><br>' +
              '<b>顺带一个更大的收获：</b>这条线索本身很有价值——<b>一个申请了「所有文件访问权限」的 App，' +
              '它的业务里一定有"需要看全盘"的部分</b>（清理、备份、文件管理、或取证类风控）。这比你在代码里瞎找高效得多。'
          },
          nc: {
            label: '选C', terminal: true, verdict: 'bad', verdictTitle: '把"受限"误读成了"完全禁止"',
            result: '<b>分区存储是"限制默认行为"，不是"禁止访问"。</b>这个区别很关键。<br><br>' +
              'Android 11 之后访问共享目录有<b>两条合法路径</b>：<br>' +
              '· <b>MediaStore</b>——管理照片/视频/音频等媒体，不需要敏感权限，但<b>只能看到媒体文件</b>；<br>' +
              '· <b>MANAGE_EXTERNAL_STORAGE</b>——「所有文件访问」，能看到全盘，但属于敏感权限，需要专门授予与审核。<br>' +
              '<span class="hit">所以"文件管理类 App 在 Android 13 上依然能用"这件事，本身就说明存在合法通路。' +
              '"禁止"和"需要专门授权"是完全不同的结论——前者意味着这条路不存在，后者意味着你要去找它拿到了什么授权。</span><br><br>' +
              '<b>逆向意义：</b>把"受限"读成"禁止"，会让你错误地排除掉整条分析路径。' +
              '正确的问法不是"这个版本还能不能做"，而是"<b>它必须拿到什么，才能做到这件事</b>"——' +
              '而那个"什么"，往往就是它的关键权限声明，也是它的行为特征。'
          },
          nd: {
            label: '选D', terminal: true, verdict: 'bad', verdictTitle: '在没有证据前就假设了实现层',
            result: '<b>这个猜测本身不算离谱，但它现在是一个"没有证据的假设"，而且它解释不了最关键的一点。</b><br><br>' +
              '<b>为什么它解释不了：</b>如果遍历逻辑在 native 层，那么"返回空列表"这个结果仍然需要解释——' +
              'native 层同样受权限约束（它用的是同一个进程的同一个 UID）。' +
              '<span class="hit">换句话说：<b>换成 native 实现，权限问题依然存在。</b>' +
              '你提出的解释并不能解释现象，只是把它往后推了一层。</span><br><br>' +
              '<b>更重要的方法论问题：</b>要验证"是不是 native 实现"，成本是多少？' +
              '你需要 dump so、找导出、追调用——而验证"是不是权限问题"，成本是<b>一条 dumpsys 命令</b>。<br>' +
              '<b>当两个假设都能解释现象时，先验证成本低的那个。</b>这不是"偷懒"，这是把有限的注意力花在能快速收敛的地方。<br><br>' +
              '<b>什么情况下该怀疑实现层？</b>当权限确认没问题、行为却依然不符预期时——' +
              '那时"它到底在哪一层做的"才成为真正需要回答的问题。'
          }
        }
      }
    },

    /* ============================================================ 26.8 */
    {
      h: '26.8', title: 'Handler / Looper / MessageQueue：主线程在干什么',
      intuition: {
        tag: '直觉模型 · 一个只有一个人的前台，和一摞待办号牌',
        body:
          '<p>主线程（UI 线程）就是这个前台，<strong>而且只有一个</strong>。它一次只能办一件事。</p>' +
          '<p>问题是：<b>所有人都想让它办事</b>——你的点击事件、系统的绘制信号、你自己 post 的任务、' +
          '别的线程想把结果送回 UI……它们不能直接冲上去打断前台，只能<b>取一个号、排到队尾</b>。</p>' +
          '<ul>' +
          '<li><b>MessageQueue</b> = 那摞号牌（按"该在什么时间办"排序）；</li>' +
          '<li><b>Looper</b> = 那个不停喊"下一位"的人（<span class="mono">loop()</span> 是一个死循环）；</li>' +
          '<li><b>Handler</b> = 你手里的取号器 + 你的身份标识（号牌上写着"办完找谁"）；</li>' +
          '<li><b>Message</b> = 一张号牌（带参数、带"什么时候办"、带"办完找谁"）。</li>' +
          '</ul>' +
          '<p><span class="hit">于是"主线程被卡住"这件事就有了精确的含义：' +
          '<b>不是前台在忙，而是前台在办一件事的时候不肯放手，后面所有号牌都办不了。</b>' +
          '这就是 ANR。</span></p>'
      },
      html:
        '<p>这套机制是安卓最核心的并发模型。它值得你花时间，因为：' +
        '<b>逆向时"代码跑在哪个线程上"这个问题，答案几乎总是要回到 Looper。</b></p>' +
        T.tbl(['角色', '是什么', '关键性质'],
          [
            ['<span class="mono">Looper</span>', '一个线程的消息循环', '<b>每个线程最多一个</b>，存在 <span class="mono">ThreadLocal</span> 里。主线程的在 <span class="mono">ActivityThread.main</span> 里由 <span class="mono">prepareMainLooper()</span> 创建'],
            ['<span class="mono">MessageQueue</span>', '消息队列', '内部是<b>按 <span class="mono">when</span> 排序的单链表</b>（不是普通队列，所以"队首"是按时间算的，不是按入队顺序）'],
            ['<span class="mono">Handler</span>', '发送与处理消息', '构造时<b>绑定当前线程的 Looper</b>（或指定一个）。它同时是"发送者"和"接收者"——消息里带着 <span class="mono">target</span> 指回它自己'],
            ['<span class="mono">Message</span>', '消息实体', '带 <span class="mono">what</span> / <span class="mono">arg1</span> / <span class="mono">arg2</span> / <span class="mono">obj</span> / <span class="mono">callback</span> / <span class="mono">when</span>；<b>有池化复用</b>（<span class="mono">obtainMessage</span>）']
          ]) +
        T.note('key', '🔑 三个最常被搞错的点',
          '<p style="margin-bottom:0">' +
          '① <b>post(Runnable) 和 sendMessage 走的是同一条路。</b><span class="mono">post</span> 只是把 Runnable ' +
          '塞进 <span class="mono">Message.callback</span> 字段。所以它们的排队规则完全一样。<br>' +
          '② <b>dispatchMessage 的顺序是固定的：</b>先看 <span class="mono">msg.callback</span>（Runnable）→ ' +
          '再看 <span class="mono">Handler</span> 构造时传入的 <span class="mono">Callback</span> → ' +
          '最后才是你重写的 <span class="mono">handleMessage</span>。' +
          '<span class="hit">逆向时如果你 hook 了 handleMessage 却什么都没抓到，很可能消息是被 callback 分支消费掉了。</span><br>' +
          '③ <b>延迟消息不是"定时器"。</b><span class="mono">postDelayed</span> 的语义是"<b>不早于</b>这个时间"——' +
          '如果主线程正忙，它会晚得多。所以拿它做精确定时是不可靠的。</p>'),

      stepper: {
        title: '一条消息的完整旅行',
        lines: [
          { code: '<span class="c">// ① 在主线程里创建一个 Handler（隐式绑定主线程的 Looper）</span>\nHandler h = <span class="k">new</span> Handler(Looper.getMainLooper()) {\n    <span class="k">public void</span> handleMessage(Message msg) { <span class="c">/* … */</span> }\n};',
            note: '<b>① Handler 一出生就"认领"了一个 Looper。</b>不传参数的构造器绑定<b>当前线程</b>的 Looper——' +
              '这也是为什么"在子线程里 new Handler() 会崩"：那个线程没有 Looper。',
            state: { '阶段': '创建', '在哪个线程': '主线程', '队列长度': '0' } },
          { code: '<span class="c">// ② 从子线程发一条延迟消息（这是最常见的使用场景）</span>\nh.postDelayed(runnable, 100);\n<span class="c">// 内部：msg.callback = runnable; msg.when = now + 100</span>',
            note: '<b>② 跨线程投递。</b>注意 <span class="mono">postDelayed</span> 是<b>线程安全</b>的——' +
              '这正是它存在的意义：<b>让别的线程能安全地要求主线程干活。</b><br>' +
              '<span class="hit">逆向视角：<b>一个 App 里所有"从子线程回到 UI"的动作都要经过这里</b>。' +
              '所以 hook <span class="mono">Handler.post</span> 是一张很灵的网——第 22 章提到 JDex2 就是用 ' +
              '<span class="mono">Handler(Looper.getMainLooper()).post()</span> 把某些调用丢回主线程的。</span>',
            state: { '阶段': '投递', '在哪个线程': '子线程 → 主队列', '队列长度': '1' } },
          { code: '<span class="c">// ③ 入队：MessageQueue.enqueueMessage</span>\n<span class="c">// 按 when 找到插入位置（不是简单追加到队尾！）</span>',
            note: '<b>③ 入队时会按 <span class="mono">when</span> 排序。</b>这是 MessageQueue 与普通队列<b>最本质的区别</b>：' +
              '一条延迟 100ms 的消息，会被插到所有"时间更早"的消息<b>后面</b>，而不是无条件排到队尾。<br>' +
              '<span class="hit">所以"谁先执行"取决于<b>时间戳</b>，不取决于"谁先发"。</b>' +
              '本章实验二就是让你亲手验证这件事。</span>',
            state: { '阶段': '入队', '在哪个线程': '主队列', '队列长度': '1（按 when 有序）' } },
          { code: '<span class="c">// ④ Looper.loop() 取消息（主线程一直在转这个循环）</span>\nMessage msg = queue.next();   <span class="c">// 必要时阻塞等待</span>',
            note: '<b>④ 死循环取消息。</b>队列空的时候 <span class="mono">next()</span> 会阻塞（用 epoll 等待），' +
              '<b>不消耗 CPU</b>——所以"App 停在那里"并不等于"在忙"。<br>' +
              '这也是主线程唯一的"空闲时刻"：<span class="mono">IdleHandler</span> 就是在这时候被回调的。',
            state: { '阶段': '取消息', '在哪个线程': '主线程', '队列长度': '0' } },
          { code: '<span class="c">// ⑤ 分发：msg.target.dispatchMessage(msg)</span>\n<span class="c">// 顺序：msg.callback → Handler.mCallback → handleMessage</span>',
            note: '<b>⑤ 分发的优先级是固定的。</b>这就是前面"三个最常被搞错的点"里的第 ② 条——' +
              '<span class="mono">post</span> 进去的 Runnable 走的是 <span class="mono">callback</span> 分支，' +
              '<b>根本不会进 handleMessage</b>。<br>' +
              '<b>这对 hook 很重要：</b>你 hook <span class="mono">handleMessage</span> 能抓到的只是"用 sendMessage 发的"那一部分。',
            state: { '阶段': '分发', '在哪个线程': '主线程', '队列长度': '0' } },
          { code: '<span class="c">// ⑥ 执行完毕，回到 ④ 等下一张号牌</span>\n<span class="c">// 中间如果某条消息执行太久 → ANR</span>',
            note: '<b>⑥ 回到循环。</b>整套机制就是这样转下去的。<br>' +
              '<span class="hit">现在你应该能精确解释 ANR 了：<b>不是"主线程崩了"，而是"主线程在执行某一条消息时花了太久，' +
              '后面的消息（包括用户的输入事件）都超时了"。</b><br>' +
              '所以定位 ANR 的关键永远是同一个问题：<b>当时主线程正在执行哪一条消息、它的调用栈是什么。</b></span>',
            state: { '阶段': '循环', '在哪个线程': '主线程', '队列长度': '按需' } }
        ]
      },

      lab: {
        title: '实验二：消息循环执行顺序推演器',
        goal: '目标：算出真实的消息执行顺序',
        intro:
          '<p>下面是一个<b>真实的消息队列模拟</b>：它按每行的"投递时刻 + 延迟"算出 <span class="mono">when</span>，' +
          '再按 MessageQueue 的真实规则排出执行顺序。</p>' +
          '<p>每行格式：<span class="mono">&lt;类型&gt; &lt;名字&gt; t=&lt;投递时刻ms&gt; d=&lt;延迟ms&gt;</span>，类型有三种：<br>' +
          '· <span class="mono">post</span>——普通投递（等同于 sendMessage）<br>' +
          '· <span class="mono">postDelayed</span>——带延迟<br>' +
          '· <span class="mono">front</span>——<span class="mono">sendMessageAtFrontOfQueue</span>，<b>插到队首</b>（相当于 when=0 且优先）</p>' +
          '<p><b>先自己写出你预测的顺序，再点运行对照。</b>特别留意两件事：' +
          '① 同 <span class="mono">when</span> 的消息谁先；② <span class="mono">front</span> 能插到多前面。</p>',
        inputs: [
          {
            key: 'ops',
            label: '消息投递序列',
            hint: '改一改、加几行试试',
            type: 'textarea', rows: 7,
            value:
              'post        A  t=0 d=0\n' +
              'postDelayed B  t=0 d=100\n' +
              'front       C  t=0\n' +
              'postDelayed D  t=0 d=50\n' +
              'post        E  t=0 d=0'
          },
          { key: 'guess', label: '① 你预测的执行顺序（用逗号分隔，例如 C,A,E,D,B）', ph: 'C,A,E,D,B' },
          { key: 'why', label: '② 为什么 front 能排到最前面？用一句话说清它的语义', type: 'textarea', rows: 2,
            ph: '因为……' }
        ],
        runLabel: '▶ 模拟执行',
        autorun: true,
        run: v => {
          const S = ch26SimQueue(v.ops || '');
          if (S.err) return '<div class="lab-msg warn">解析失败：' + S.err + '</div>';
          let html = '<table class="lab-tbl"><tr><th>#</th><th>类型</th><th>名字</th><th>投递 t</th><th>延迟 d</th><th>计算出 when</th></tr>' +
            S.ops.map((o, i) =>
              '<tr><td>' + (i + 1) + '</td><td><code>' + o.kind + '</code></td><td><code>' + ch26esc(o.name) + '</code></td>' +
              '<td>' + o.t + '</td><td>' + o.d + '</td>' +
              '<td><code>' + (o.kind === 'front' ? '-1（强制队首）' : o.when) + '</code></td></tr>').join('') +
            '</table>';
          html += '<div class="lab-msg key"><b>🔑 真实执行顺序</b><div class="lab-note">' +
            '<div class="lab-answer" style="font-size:16px">' + S.order.join(' → ') + '</div>' +
            '<b>最终队列（按 when 排序后的顺序）：</b><code>' + S.order.join(', ') + '</code></div></div>';
          html += '<div class="lab-msg model"><b>💡 规则说明</b><div class="lab-note">' +
            '<b>① 排序依据是 when，不是投递顺序。</b>所以一条"延迟 50ms 的消息"会排在"延迟 100ms 的消息"前面，' +
            '哪怕它是后发的。<br>' +
            '<b>② when 相同的消息，按投递先后（FIFO）。</b>' + (S.sameWhen.length
              ? '本例里有同 when 的一组：<code>' + S.sameWhen.join(' / ') + '</code>——注意它们的相对顺序。'
              : '本例里没有 when 相同的消息，你可以自己加一行 <code>post F t=0 d=0</code> 看看。') + '<br>' +
            '<b>③ <code>sendMessageAtFrontOfQueue</code> 的语义是"插到队首"</b>——' +
            '源码上它是把 when 设为 0 并在入队时直接插到链表头，<b>所以它永远最先执行，且会抢在"同为 0 但先入队的消息"之前。</b><br>' +
            '<span class="hit">这也解释了它的危险性：<b>它是唯一能"插队"的手段。</b>' +
            '框架内部用它来保证"同步屏障/异步消息"的优先级（比如 Choreographer 的 vsync 回调），' +
            '而滥用它会饿死正常消息。</span></div></div>';
          return html;
        },
        expected: v => {
          const S = ch26SimQueue(v.ops || '');
          if (S.err) return { ok: false, detail: '解析失败：' + S.err };
          const norm = s => String(s || '').replace(/[\s，、;；]+/g, ',').replace(/,+/g, ',').replace(/^,|,$/g, '').toUpperCase();
          const ok1 = norm(v.guess) === norm(S.order.join(','));
          const ok2 = window.AKKC_hasConcept(v.why || '',
            ['队首', '最前', '插队', '头部', 'front', 'first', 'when=0', '0', '优先', '抢先', '立即', '链表头', '插入到最前']);
          return {
            ok: ok1 && ok2,
            detail:
              (ok1 ? '✅ 顺序正确：<code>' + S.order.join(' → ') + '</code>'
                   : '❌ 顺序不对。<br>你写的：<code>' + (v.guess || '（空）') + '</code><br>' +
                     '正确是：<code>' + S.order.join(' → ') + '</code><br>' +
                     '对照上面的表格看 <code>when</code> 列：<b>执行顺序就是 when 从小到大；' +
                     '<code>front</code> 是强制 -1，所以永远第一。</b>') +
              '<br>' +
              (ok2 ? '✅ 语义说对了：<b>front 就是"插到队首"</b>，它绕过正常的 when 排序。'
                   : '❌ 语义还没说清。<b>要点是"插到队首/链表头"，而不是"设了个更小的 when"</b>——' +
                     '虽然效果相似，但它的实现是入队时直接插头，<b>因此能抢在同样 when 的消息之前</b>。'),
          };
        },
        showAnswer:
          '【默认样例的执行顺序】\n' +
          '  输入：\n' +
          '    post        A  t=0 d=0     → when=0\n' +
          '    postDelayed B  t=0 d=100   → when=100\n' +
          '    front       C  t=0         → 插队首（等价 when=-1）\n' +
          '    postDelayed D  t=0 d=50    → when=50\n' +
          '    post        E  t=0 d=0     → when=0\n\n' +
          '  按 when 排序：0(A,E) → 50(D) → 100(B)\n' +
          '  再把 C 插到队首：C → A → E → D → B\n\n' +
          '  所以答案是： C, A, E, D, B\n\n' +
          '【三条规则】\n' +
          '  1) 排序依据是 when（绝对时间戳），不是投递顺序。\n' +
          '  2) when 相同的按投递先后（FIFO）。A 和 E 都是 when=0，A 先投所以 A 先执行。\n' +
          '  3) sendMessageAtFrontOfQueue 入队时直接插链表头，\n' +
          '     所以它排在所有消息之前——包括同样 when=0 的。\n\n' +
          '【为什么这个语义重要】\n' +
          '  它是消息队列里唯一能"插队"的手段。框架用它保证高优先级事件\n' +
          '  （如同步屏障之后的异步消息、vsync 回调）不被普通消息饿死。\n' +
          '  滥用它会让正常消息一直排不上队。\n\n' +
          '【一个常见误解】\n' +
          '  postDelayed(x, 100) 不等于"100ms 后一定执行"，它的语义是"不早于 100ms"。\n' +
          '  如果主线程在忙，实际执行时间会晚得多。所以它不能当精确定时器用。',
        hint:
          '<b>三步走：</b>① 给每一行算出 <span class="mono">when = t + d</span>；' +
          '② 按 <span class="mono">when</span> 从小到大排（<b>相同 when 的按投递先后</b>）；' +
          '③ 最后处理 <span class="mono">front</span>——它是插队，不是"算一个更小的 when"。<br><br>' +
          '<b>第 ② 问的关键词是"队首"。</b>想想 <span class="mono">sendMessageAtFrontOfQueue</span> ' +
          '这个名字里的 <span class="mono">FrontOfQueue</span> 字面意思是什么。',
        after:
          T.note('ok', '✅ 实验二的收获',
            '<p style="margin-bottom:0">你现在能精确回答"为什么这条消息先执行"了。<br>' +
            '这个能力在实战里有两个用处：<br>' +
            '① <b>判断时序型 bug</b>——"为什么我的 hook 在 onResume 之后才生效"这类问题，' +
            '本质就是消息顺序问题；<br>' +
            '② <b>判断延迟是否可靠</b>——很多风控/心跳用 <span class="mono">postDelayed</span> 做定时，' +
            '而它<b>不保证准时</b>。所以"检测在 N 秒后触发"这种假设本身就不严谨。' +
            '<span class="hit">反过来，这也解释了为什么加固方更爱用 <span class="mono">AlarmManager</span> ' +
            '或独立的 native 线程来做真正的定时。</span></p>')
      },

      after:
        T.note('warn', '⚠️ 由此得到的一条 Hook 纪律',
          '<p style="margin-bottom:0"><b>Hook 之前先问：这段代码跑在哪条线程上？</b><br>' +
          '· 如果是主线程 → 它一定通过上面这个循环被调度，你的 hook 可能在消息分发之后才生效；<br>' +
          '· 如果是 native 自建线程 → 主线程的 hook 完全看不到它（第 20.8 节）；<br>' +
          '· 如果是 Binder 线程 → 那是系统给你的线程池（26.10 节）。<br>' +
          '<span class="hit">"我的 hook 装上了但没命中"这个问题，一半的答案在这三种线程里。</span></p>')
    },

    /* ============================================================ 26.9 */
    {
      h: '26.9', title: '主线程为什么不能阻塞：把 ANR 讲清楚',
      html:
        '<p>现在你已经有了足够的零件，可以把 ANR 讲准了。它不是一个模糊的"卡了"，而是一个<b>可观测的因果</b>。</p>' +
        T.card('ANR 的机制（精确版）',
          '<p>主线程在跑 <span class="mono">Looper.loop()</span>。它一次处理一条消息。' +
          '系统在很多地方会<b>往主线程投递消息并等它被处理</b>——最典型的是用户的输入事件（触摸、按键）。</p>' +
          '<p>如果主线程被一条耗时消息占住超过阈值，后面的输入事件就迟迟得不到处理，' +
          '系统的看门狗就会判定 <b>ANR（Application Not Responding）</b>，弹出"应用无响应"。</p>' +
          '<p style="margin-bottom:0"><b>所以"ANR 的根因"永远可以归结为同一个句式：</b>' +
          '<span class="hit">某个回调在主线程上执行了太久——是哪个回调、为什么久，这才是要查的东西。</span></p>') +
        T.tbl(['常见的 ANR 触发面', '典型元凶', '逆向/排查时的观测点'],
          [
            ['<b>输入事件超时</b>', '主线程在做 IO、在等锁、在做大量计算', '<span class="mono">/data/anr/traces.txt</span> 里主线程的调用栈（<b>这是最有价值的证据</b>）'],
            ['<b>BroadcastReceiver 超时</b>', '<span class="mono">onReceive</span> 里做了耗时操作（它是主线程回调）', '广播的 action 与 <span class="mono">onReceive</span> 栈'],
            ['<b>Service 超时</b>', '<span class="mono">onCreate</span> / <span class="mono">onStartCommand</span> 里阻塞太久', 'Service 生命周期栈'],
            ['<b>ContentProvider 超时</b>', 'Provider 初始化太慢（<b>它还在 Application 之前</b>，所以影响启动）', 'Provider 的 <span class="mono">onCreate</span> 栈']
          ]) +
        T.note('key', '🔑 为什么"ANR 的 traces 文件"对逆向的人特别有用',
          '<p style="margin-bottom:0">因为它是一份<b>带调用栈的、真实运行时的快照</b>。<br>' +
          '当你要找"某个功能到底走了哪条代码路径"时，<b>制造一次 ANR 或直接从 traces 里读</b>，' +
          '往往比静态分析快得多——你直接看到了方法调用链。<br>' +
          '<span class="hit">这与第 30 章"调用栈定位关键代码"是同一个方法论：' +
          '<b>让程序自己在栈上把答案写出来。</b></span><br>' +
          '<span class="pill warn">traces 的路径与可读性随 Android 版本与权限变化（新版本上普通 App 往往读不到），' +
          '请以你目标设备的实际情况为准</span></p>'),

      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '起点',
            scenario: '<b>情境：</b>你在分析一个 App 的签名算法。静态分析发现签名逻辑分布在一个 <span class="mono">SignUtil.sign()</span> 里，' +
              '它被 <span class="mono">NetworkHelper.buildRequest()</span> 调用。你 hook 了 <span class="mono">SignUtil.sign</span>，' +
              '<b>确认它被调用了、参数也对</b>。但你想进一步知道"<b>是谁在什么时机触发了这次网络请求</b>"，' +
              '于是你在 <span class="mono">SignUtil.sign</span> 里打印了 <span class="mono">Java.use(\'android.util.Log\').getStackTraceString(...)</span>，' +
              '<b>结果栈里只有几帧框架代码，看不到任何业务方法名</b>。',
            q: '最可能的原因是什么？',
            choices: [
              { t: 'A. 调用方用了反射，所以栈上不留业务方法名', next: 'na' },
              { t: 'B. 调用发生在子线程，主线程的 hook 抓不到业务栈', next: 'nb' },
              { t: 'C. 栈被截断或过滤了——要么打印方式不对，要么中间隔着一个"通用转发/线程切换"的边界', next: 'nc' },
              { t: 'D. 该 App 用了 OLLVM 把调用关系混淆掉了', next: 'nd' }
            ]
          },
          na: {
            label: '选A', terminal: true, verdict: 'bad', verdictTitle: '混淆了一个常见但不成立的推论',
            result: '<b>反射和"栈上看不到业务名"是两件不同的事。</b><br><br>' +
              '反射的特征是：<b>在 <span class="mono">Method.invoke</span> 那一帧上，你看不到"被调用的方法名"</b>，' +
              '但<b>"谁调用了 invoke"这一帧仍然是业务方法</b>——也就是说，栈上依然会出现 <span class="mono">invoke</span> 的调用者。<br>' +
              '<span class="hit">反射会隐藏"目标"，不会隐藏"调用者"。</span>' +
              '而你现在的现象是<b>连调用者都看不到</b>——所以问题不在这里。<br><br>' +
              '<b>不过 A 的思路方向是对的</b>（先想"什么机制会让栈变得不可读"），只是候选选错了。' +
              '同样会让栈变短的机制还有：<b>线程切换</b>（跨线程后栈是断的）、' +
              '<b>消息循环</b>（投递出去之后栈就断了，26.8 节刚讲过）、' +
              '<b>native 回调</b>（从 native 调回 Java 时栈的起点变了）。'
          },
          nb: {
            label: '选B', terminal: true, verdict: 'bad', verdictTitle: '方向对了一半，但结论下得太快',
            result: '<b>"子线程"确实是一个很常见的原因，但它解释不了你现在这个现象。</b><br><br>' +
              '关键在于：<b>你是在 <span class="mono">SignUtil.sign</span> 内部打印栈的</b>——' +
              '也就是说，打印的动作<b>就发生在调用它的那条线程上</b>。' +
              '所以不管是主线程还是子线程，<b>栈上都应该能看到调用它的业务方法</b>。' +
              '<span class="hit">"子线程"会影响"你 hook 的方式对不对"，但不会让"当前线程的栈"本身变空。</span><br><br>' +
              '<b>真正与"跨线程"有关的现象是另一种：</b>' +
              '如果你 hook 的是<b>主线程上某个入口</b>（比如按钮点击），而签名在子线程里算，' +
              '那么"从点击到签名"这条链<b>在栈上是断开的</b>——因为它中间经过了 ' +
              '<span class="mono">Handler.post</span> 或线程池投递。' +
              '<b>这才是跨线程带来的真正困难：栈只能看到"当前这一段"。</b>'
          },
          nc: {
            label: '选C', terminal: true, verdict: 'good', verdictTitle: '正确：栈只覆盖"当前这一段执行"',
            result: '<b>这是唯一能完整解释现象的方向，而且它包含两种很常见的具体情况：</b><br><br>' +
              '<b>① 栈本身被"边界"截断了。</b>栈的语义是"当前的调用链"，而下面几种情况都会让它断开：<br>' +
              '· <b>线程切换</b>——消息投递（<span class="mono">post</span> / <span class="mono">Handler</span>）、线程池、' +
              '<span class="mono">AsyncTask</span>，投递之后新线程的栈<b>重新从线程入口开始</b>，看不到发起者；<br>' +
              '· <b>native 回调</b>——从 so 里回调 Java 时，栈的底部是 native 帧，中间的业务关系可能不在 Java 栈上；<br>' +
              '· <b>Binder 调用</b>——跨进程之后，栈在<b>另一个进程</b>里，你只能看到本进程的这一侧。<br>' +
              '<span class="hit">所以正确的预期不是"栈能告诉我整条链"，而是"栈能告诉我<b>当前这一段的起点</b>"。</span><br><br>' +
              '<b>② 打印方式本身有问题。</b>这类坑非常具体：<br>' +
              '· Frida 里 <span class="mono">getStackTraceString</span> 需要传一个 <span class="mono">Throwable</span> 实例，' +
              '而 <span class="mono">Java.use("java.lang.Throwable").$new()</span> 拿到的栈是"创建它那一刻"的——<b>位置不对就什么都看不到</b>；<br>' +
              '· 打印得太深会被系统截断；<br>' +
              '· 有些加固会 hook 或过滤栈相关 API。<br>' +
              '<b>验证方法：先打印一个你自己造的、肯定有业务帧的栈</b>（比如在同一处调用 ' +
              '<span class="mono">Thread.currentThread().getStackTrace()</span>），确认打印机制本身是通的。' +
              '<b>把"工具坏了"和"事实如此"分开，永远是第一步。</b><br><br>' +
              '<b>那正确的做法是什么？</b>既然栈只能看到一段，就要<b>顺着"边界"一段一段接起来</b>：<br>' +
              '· 在投递点（<span class="mono">Handler.post</span> / 线程池提交）也打一个栈，' +
              '这样"谁发起的"和"谁执行的"两段就都有了；<br>' +
              '· 或者换个思路：<b>不要在 sync 里往上找，而是在"可能的发起者"那里往下找</b>——' +
              'hook 网络层（<span class="mono">OkHttp</span> / <span class="mono">HttpURLConnection</span>），' +
              '看是谁调了它。<span class="hit">这与第 30 章"七条线索"里"从数据流反推调用点"是同一种手法。</span>'
          },
          nd: {
            label: '选D', terminal: true, verdict: 'bad', verdictTitle: '把 Java 层的问题归因给了 native 混淆',
            result: '<b>OLLVM 是 native 层的编译器混淆（第 5 章），它根本不作用于 Java 字节码。</b><br><br>' +
              'Java 方法的调用关系在 dex 里、由 ART 在运行时维护，' +
              '<b>OLLVM 改的是 C/C++ 编译出来的机器码控制流</b>——两者不在一个层面上。' +
              '<span class="hit">"Java 栈上没有业务方法名"这件事，OLLVM 不背这个锅。</span><br><br>' +
              '<b>不过这个选项背后有一个值得正视的直觉：</b>确实存在"Java 层看起来干干净净、其实逻辑全在 native"的情况' +
              '（第 20.11 节的 Native 化）。<b>但那时的现象是"Java 层根本没有这个方法体"</b>，' +
              '而不是"方法有、栈上没有调用者"。<br><br>' +
              '<b>怎么快速区分这两者：</b>看你 hook 的那个方法——' +
              '如果它是 <span class="mono">native</span> 声明，那逻辑在 so 里，要按第 20 章的路线走；' +
              '如果它有正常的 Java 方法体（你能读到它的字节码），那它就是 Java 实现的，' +
              '栈上的问题属于"调用链被边界截断"，与 native 无关。'
          }
        }
      },

      quiz: {
        id: 'q26-3', chapter: 26, answer: [0, 2],
        stem: '（多选）关于安卓的主线程与消息机制，下面哪些说法是<b>正确</b>的？',
        options: [
          { t: 'Service 的生命周期回调默认在主线程执行，所以在 Service 里做耗时操作同样会 ANR', why: '✅ 正确。Service 解决的是"生命周期长"，不是"跑在哪个线程"。它和 Activity 一样由主线程 Looper 调度。' },
          { t: 'postDelayed(r, 100) 保证 r 会在 100 毫秒后准时执行', why: '❌ 它的语义是"<b>不早于</b> 100ms"。主线程忙的时候会晚得多，所以不能当精确定时器。' },
          { t: 'post(Runnable) 与 sendMessage 最终都进入同一个 MessageQueue，按 when 排序', why: '✅ 正确。post 只是把 Runnable 放进 Message.callback 字段，排队规则完全一致。' },
          { t: '主线程被阻塞时，系统的做法是再起一个线程来处理输入事件', why: '❌ 不是。输入事件也必须由主线程处理，这正是 ANR 发生的原因——<b>它不能绕过你的阻塞</b>。' }
        ],
        explain: '<b>把这四条串起来看，你会得到一张完整的图：</b><br><br>' +
          '<b>① 只有一个主线程，所有 UI 与大部分组件回调都在它上面。</b>' +
          'Activity 的生命周期、Service 的生命周期、<span class="mono">BroadcastReceiver.onReceive</span>——' +
          '全都由主线程 Looper 调度。<span class="hit">所以"挂在主线程上"这件事与组件类型无关，只与它跑在哪个线程有关。</span><br><br>' +
          '<b>② 想让它干活，只能投递消息。</b>其他线程通过 <span class="mono">Handler</span> 把任务放进队列，' +
          '这是唯一安全的跨线程方式。消息按 <span class="mono">when</span> 排序，' +
          '<b>所以"谁先执行"是时间问题，不是先来后到问题。</b><br><br>' +
          '<b>③ 延迟不等于定时。</b>队列是"尽力而为"的——前面有长任务就会推迟。' +
          '这一点在逆向里很实用：<b>任何"N 秒后触发"的检测逻辑，都不能假定它精确在 N 秒触发</b>；' +
          '而反过来，<b>"过了 N 秒还没触发"也不能证明它不存在</b>。<br><br>' +
          '<b>④ ANR 是这个模型的必然产物，不是 bug。</b>单线程 + 消息队列，就必然存在' +
          '"某条消息超时导致后续消息得不到处理"的可能。<span class="hit">理解了机制，你对 ANR 的态度会从"讨厌的错误"' +
          '变成"一个能提供调用栈快照的诊断工具"。</span>'
      }
    },

    /* ============================================================ 26.10 */
    {
      h: '26.10', title: 'Binder：一次跨进程调用的完整链路',
      html:
        '<p>这是本章技术含量最高的一节，也是最值得花时间的一节。' +
        '因为在安卓里，<b>"跨进程"不是特例而是常态</b>——你几乎每一个稍微重要一点的操作，都要穿过 Binder。</p>' +
        T.note('key', '🔑 先记住一句话：Binder 调用在底层是 <span class="mono">ioctl</span>，不是文件读写',
          '<p style="margin-bottom:0">这一点在第 24 章的一个真实案例里已经出现过一次：' +
          '<b>某个安全 SDK 通过 Binder 查询已安装应用，而 seccomp 拦不到它——因为它走的是 <span class="mono">ioctl</span>，' +
          '不经过文件系统相关的 syscall。</b><br>' +
          '<span class="hit">这是 Binder 在对抗层面最重要的性质：<b>你如果只在 open/read/write 上做监控，就看不到 Binder 上跑的任何东西。</b>' +
          '反过来，想观测 Binder，就必须在 <span class="mono">ioctl</span> 或者更上层下手。</span></p>'),
      stepper: {
        title: '一次跨进程调用的旅行（客户端 → 内核 → 服务端 → 回来）',
        lines: [
          { code: '<span class="c">// ① 客户端：从 ServiceManager 拿到服务的"句柄"</span>\nIBinder b = ServiceManager.<span class="f">getService</span>(<span class="s">"package"</span>);',
            note: '<b>① 先找"总机"。</b><span class="mono">ServiceManager</span> 是所有系统服务的登记处，' +
              '它自己有一个特殊的句柄（<b>0 号</b>）。你拿到的 <span class="mono">IBinder</span> 不是真正的服务对象，' +
              '而是<b>一个"引用"</b>——在客户端这一侧，它具体是 <span class="mono">BinderProxy</span> 的实例。<br>' +
              '<span class="hit">这个"句柄/引用"的概念是理解 Binder 的关键：<b>跨进程传不了对象，只能传"指向对象的编号"。</b></span>',
            state: { '步骤': '取句柄', '在哪': '客户端进程', '跨进程？': '是' } },
          { code: '<span class="c">// ② AIDL 生成的 Proxy：把方法调用翻译成"事务"</span>\n<span class="k">public</span> ApplicationInfo <span class="f">getApplicationInfo</span>(...) {\n    Parcel data = Parcel.obtain(), reply = Parcel.obtain();\n    data.writeInterfaceToken(DESCRIPTOR);\n    data.writeString(packageName);\n    mRemote.<span class="f">transact</span>(TRANSACTION_getApplicationInfo, data, reply, <span class="n">0</span>);\n    <span class="c">// ……从 reply 里读返回值……</span>\n}',
            note: '<b>② "接口调用"在这里被降维成了"打包 + 编号 + 发送"。</b>注意三样东西：<br>' +
              '· <b>DESCRIPTOR</b>——接口的唯一标识字符串（防止串号）；<br>' +
              '· <b>TRANSACTION_xxx</b>——<b>一个整数编号</b>，服务端靠它 switch 到对应方法；<br>' +
              '· <b>Parcel</b>——序列化容器，参数按顺序写进去。<br>' +
              '<span class="hit">逆向意义：<b>你在 Binder 层看到的东西就是"编号 + 字节流"。</b>' +
              '想知道编号对应哪个方法，要么拿到 AIDL 生成的类，要么从服务端的 switch 里反查。</span>',
            state: { '步骤': '打包事务', '在哪': '客户端进程', '跨进程？': '否' } },
          { code: '<span class="c">// ③ 进入 native 层，最终落到一次 ioctl</span>\nBpBinder::transact()\n  → IPCThreadState::transact()\n  → talkWithDriver()\n  → <span class="f">ioctl</span>(fd, BINDER_WRITE_READ, &amp;bwr);   <span class="c">// fd = /dev/binder</span>',
            note: '<b>③ 这一行是整个机制的物理落点。</b><span class="mono">/dev/binder</span> 是一个字符设备，' +
              '所有 Binder 通信都是对它做 <span class="mono">ioctl</span>。<br>' +
              '<b>为什么这一步如此重要：</b>它是<b>客户端侧唯一必须经过的、且可以下钩子的位置</b>。' +
              '本章最后的实战案例做的就是这件事——<b>GOT Hook 掉 libbinder.so 里的 ioctl，就能看到全部 Binder 事务。</b>',
            state: { '步骤': 'ioctl', '在哪': '客户端 native', '跨进程？': '即将' } },
          { code: '<span class="c">// ④ Binder 驱动：找到目标进程，把事务挂进它的待办队列</span>\n<span class="c">// 依据是事务里的 handle（句柄数）</span>\n<span class="c">// 内核在这里还会填入调用方的 UID/PID</span>',
            note: '<b>④ 内核是"中介"，也是"公证人"。</b>驱动按句柄找到目标进程，把事务放进它的 todo 队列，' +
              '然后唤醒目标进程的一个 Binder 线程。<br>' +
              '<span class="hit">关键安全性质：<b>调用方的 UID/PID 是内核填进去的，不能伪造。</b>' +
              '这就是为什么"Binder 比其它 IPC 安全"——被调用方可以确信"你是谁"。</span>' +
              '逆向意义：<b>风控可以用它来确认"到底是不是这个 App 在调我"</b>，而你想伪造身份就没那么容易了。',
            state: { '步骤': '驱动转发', '在哪': '内核', '跨进程？': '是' } },
          { code: '<span class="c">// ⑤ 服务端：Binder 线程从队列取出事务</span>\nBBinder::transact() → <span class="f">onTransact</span>(code, data, reply, flags)\n<span class="k">switch</span> (code) {\n  <span class="k">case</span> TRANSACTION_getApplicationInfo: <span class="c">/* 真正干活 */</span>\n}',
            note: '<b>⑤ 服务端在"Binder 线程"里执行。</b>注意：<b>不是服务端的主线程</b>，' +
              '而是一个由 Binder 驱动唤醒的线程池里的线程（默认池子有上限，<span class="pill warn">具体线程数上限是实现细节，随版本变化</span>）。<br>' +
              '<span class="hit">这解释了一个常见困惑："为什么系统服务的代码不在它的主线程上跑？"<b>因为它是被 Binder 线程承载的。</b>' +
              '这也意味着——<b>你在服务端 hook 时，永远要记得自己在 Binder 线程上。</b></span>',
            state: { '步骤': '处理', '在哪': '服务端 Binder 线程', '跨进程？': '—' } },
          { code: '<span class="c">// ⑥ 回复：BC_REPLY → BR_REPLY，客户端被唤醒</span>\n<span class="c">// 返回值从 reply Parcel 里读出来</span>\nresult = reply.readTypedObject(ApplicationInfo.CREATOR);\nreply.recycle(); data.recycle();',
            note: '<b>⑥ 原路返回。</b>客户端阻塞在 <span class="mono">transact</span> 上的那条线程被唤醒，' +
              '从 <span class="mono">reply</span> 里读出返回值。<br>' +
              '<b>注意"同步"这件事：</b>默认的 Binder 调用是<b>同步阻塞</b>的——' +
              '客户端线程会一直等到服务端返回。' +
              '<span class="hit">所以"主线程调了一个慢的系统服务"同样会 ANR——<b>Binder 调用是主线程阻塞的一大来源，而且它非常隐蔽，因为你在自己的代码里看不到任何耗时操作。</b></span>',
            state: { '步骤': '返回', '在哪': '内核 → 客户端', '跨进程？': '是' } },
          { code: '<span class="c">// ⑦ 可选：oneway（异步）</span>\n<span class="c">// flags |= IBinder.FLAG_ONEWAY  → 立即返回，不等回复</span>',
            note: '<b>⑦ oneway：不等待的调用。</b>用 <span class="mono">oneway</span> 修饰的 AIDL 方法会立即返回，' +
              '不阻塞客户端。<br>' +
              '<b>它的代价：</b>没有返回值、不保证顺序（同一进程内的 oneway 是有序的，跨进程不一定）、不保证送达。' +
              '<span class="hit">所以"为什么我调了这个方法，但它的效果没出现"——先确认它是不是 oneway。</span>',
            state: { '步骤': '（变体）', '在哪': '—', '跨进程？': '是' } }
        ]
      },

      after:
        T.note('ok', '✅ Binder 这一节，逆向时真正要带走的三条',
          '<p style="margin-bottom:0">' +
          '① <b>物理落点是 <span class="mono">ioctl(/dev/binder)</span></b>——所以基于文件 syscall 的监控看不到 Binder（第 24 章案例）；' +
          '想观测 Binder，要么 hook <span class="mono">ioctl</span>，要么在 Java 层的 <span class="mono">transact</span> 上下手。<br>' +
          '② <b>客户端侧看到的是"编号 + Parcel"</b>——没有方法名。想知道编号对应什么，靠 AIDL 生成类或服务端 switch。<br>' +
          '③ <b>服务端在 Binder 线程上执行</b>——不是主线程。这条决定了你在服务端下钩子时对线程的预期。<br>' +
          '<span class="hit">再补一条最实用的：<b>Binder 调用是同步阻塞的，它是主线程卡顿的一个隐蔽来源。</b>' +
          '你在代码里看不到任何耗时操作，但主线程就是卡住了——因为它卡在 <span class="mono">transact</span> 上等对方。</span></p>')
    },

    /* ============================================================ 26.11 */
    {
      h: '26.11', title: 'AIDL 与系统服务：Binder 在工程里长什么样',
      html:
        '<p>上一节讲的是机制。这一节讲"它在真实代码里长什么样"——因为<b>你在逆向时看到的不是机制，而是 AIDL 生成的类</b>。</p>' +
        T.card('AIDL 帮你生成了什么',
          '<p>写一个 <span class="mono">.aidl</span> 文件之后，构建工具会生成一个 Java 类，里面有<b>两个内部类</b>：</p>' +
          T.tbl(['生成物', '跑在哪一侧', '它做什么'],
            [
              ['<span class="mono">Stub</span>', '<b>服务端</b>', '继承 <span class="mono">Binder</span>，实现 <span class="mono">onTransact</span>：<b>按 code 分发到你的方法</b>'],
              ['<span class="mono">Stub.Proxy</span>', '<b>客户端</b>', '实现接口，方法体就是<b>打包参数 + 调 <span class="mono">transact</span> + 解包返回值</b>'],
              ['<span class="mono">asInterface(IBinder)</span>', '两侧', '<b>关键的分叉函数</b>：同进程返回本地对象（<span class="mono">Stub</span>），跨进程返回 <span class="mono">Proxy</span>']
            ]) +
          '<p style="margin-bottom:0"><b><span class="mono">asInterface</span> 这个分叉是逆向时的一个关键路标</b>：' +
          '<span class="hit">它决定了"这个调用到底走不走 Binder"。</span>' +
          '如果返回的是本地 Stub，那这次调用<b>根本不跨进程，也没有 ioctl</b>——' +
          '这意味着你在 Binder 层的 hook 抓不到它。' +
          '<b>"为什么我只抓到了一部分调用"，答案经常就在这里。</b></p>') +
        T.tbl(['系统服务', '接口', '它管什么', '逆向时为什么关心'],
          [
            ['<b>ActivityTaskManagerService</b>', '<span class="mono">IActivityTaskManager</span>', 'Activity 的启动与任务栈', '所有界面跳转的必经之路'],
            ['<b>PackageManagerService</b>', '<span class="mono">IPackageManager</span>', '包信息、组件信息、权限', '<b>风控最爱查这里</b>（已安装应用列表、签名、是否 debug）'],
            ['<b>ActivityManagerService</b>', '<span class="mono">IActivityManager</span>', '进程与运行状态', '进程管理、被杀/拉起'],
            ['<b>WindowManagerService</b>', '<span class="mono">IWindowManager</span>', '窗口与输入', '界面结构、触摸事件'],
            ['<b>ServiceManager</b>', '<span class="mono">IServiceManager</span>', '<b>所有服务的登记处（句柄 0）</b>', '想找某个系统服务，先问它']
          ]) +
        T.note('key', '🔑 两条能立刻用上的观察',
          '<p style="margin-bottom:0">' +
          '① <b>查"已安装应用列表"是风控的高频动作</b>，而它必然经过 <span class="mono">IPackageManager</span>。' +
          '第 24 章的案例里，那个 SDK 就是用 <span class="mono">PackageManager</span> 做全量扫描的——' +
          '<span class="hit">所以在 <span class="mono">PackageManager</span> 相关的 Binder 调用上布点，等于直接看到"它在查什么"。</span><br>' +
          '② <b>系统服务的名字是稳定的字符串</b>（<span class="mono">"package"</span>、<span class="mono">"activity"</span>…），' +
          '而 Binder 事务里带着服务名与接口描述符。<b>这意味着即使方法名被混淆，服务名仍然是明文的</b>——' +
          '它是你在 Binder 层定位目标的一条可靠线索。</p>'),

      term: {
        title: 'Binder 相关术语速查',
        lines: [
          { t: 'd', s: '# ── 接口与实现 ──' },
          { t: 'o', s: 'IBinder', note: '<b>"一个可以被跨进程引用的对象"的抽象。</b>客户端拿到的基本都是 <span class="mono">BinderProxy</span>。' },
          { t: 'o', s: 'Binder / BBinder', note: '<b>服务端的实现基类。</b>Java 层的 <span class="mono">Binder</span> 与 native 层的 <span class="mono">BBinder</span> 对应。' },
          { t: 'o', s: 'BinderProxy / BpBinder', note: '<b>客户端的代理。</b>Java 层 <span class="mono">BinderProxy</span>，native 层 <span class="mono">BpBinder</span>。它的 <span class="mono">transact</span> 是下钩子的热门位置。' },
          { t: 'o', s: 'IInterface', note: '业务接口。<span class="mono">asInterface</span> 返回的就是它。' },
          { t: 'd', s: '' },
          { t: 'd', s: '# ── 事务与数据 ──' },
          { t: 'o', s: 'transact(code, data, reply, flags)', note: '<b>客户端发起调用。</b><span class="mono">code</span> 是方法编号；<span class="mono">flags</span> 里置 <span class="mono">FLAG_ONEWAY</span> 就是异步。' },
          { t: 'o', s: 'onTransact(code, data, reply, flags)', note: '<b>服务端的入口。</b>按 <span class="mono">code</span> 分发——<b>这里就是那个"编号到方法"的映射表</b>。' },
          { t: 'o', s: 'Parcel', note: '<b>序列化容器。</b>参数按写入顺序读出。注意它有位置指针（<span class="mono">setDataPosition</span>），读写顺序必须严格一致。' },
          { t: 'o', s: 'writeInterfaceToken / DESCRIPTOR', note: '<b>接口身份校验。</b>防止 A 接口的事务被发到 B 服务上。在 Binder 层看到的就是一个明文字符串。' },
          { t: 'o', s: 'handle（句柄）', note: '<b>指向某个进程里的 Binder 对象的编号</b>，由驱动维护。0 号是 ServiceManager。' },
          { t: 'd', s: '' },
          { t: 'd', s: '# ── 通道与线程 ──' },
          { t: 'o', s: '/dev/binder', note: '<b>物理通道。</b>所有通信都是对它做 <span class="mono">ioctl</span>。' },
          { t: 'o', s: 'Binder 线程池', note: '服务端处理事务的线程来自这里，<b>不是主线程</b>。<span class="pill warn">默认上限随版本变化，请以实际实现为准</span>' },
          { t: 'o', s: 'oneway', note: '<b>不等待回复的调用。</b>没有返回值、跨进程不保证顺序、不保证送达。' },
          { t: 'w', s: 'transaction too large', note: '<b>Binder 事务有大小上限</b>（约 1MB 量级，且是<b>整个进程共享</b>的缓冲区）。超了会抛 <span class="mono">TransactionTooLargeException</span>——<b>这是"传大对象崩溃"的经典原因</b> <span class="pill warn">具体上限值随版本变化</span>' }
        ]
      },

      quiz: {
        id: 'q26-4', chapter: 26, answer: 1,
        stem: '你在 <span class="mono">libbinder.so</span> 的 <span class="mono">ioctl</span> 上下了一个钩子，想看看目标 App 都调了哪些系统服务。' +
          '结果你发现<b>有一类调用完全抓不到</b>：某个接口明明被调用了（你在 Java 层 hook 它的方法确认过），但 ioctl 里没有对应的记录。' +
          '最可能的原因是？',
        options: [
          { t: 'ioctl 的钩子装晚了，漏掉了早期的调用', why: '❌ 如果只是"漏掉了部分"，通常是时序问题。但这里你的观察是<b>某个具体接口一次都没出现过</b>，这更像结构性问题而不是时序问题。' },
          { t: '这个接口在同一个进程内被调用，asInterface 返回的是本地 Stub，根本没走 Binder', why: '✅ 正确。<b>同进程调用不走 Binder</b>——<span class="mono">asInterface</span> 发现 <span class="mono">queryLocalInterface</span> 有结果时，直接返回本地对象，<span class="mono">transact</span> 和 <span class="mono">ioctl</span> 都不会发生。' },
          { t: 'Binder 事务在 native 层被加密了，所以你看不到', why: '❌ Binder 不做加密。Parcel 是明文二进制（这也是它能被分析和修改的原因）。' },
          { t: 'Android 新版本改用别的 IPC 机制了，不再用 /dev/binder', why: '❌ Binder 依然是安卓的核心 IPC 机制。新版本加的是"内核里怎么实现"的变化（如 binderfs），不是把它换掉。' }
        ],
        explain: '<b>"某个接口明明被调了，但 ioctl 里没有记录"——这句话本身就排除了大部分可能性。</b><br><br>' +
          '<b>先看它排除了什么：</b>如果只是"漏了一部分"，那多半是时序问题（钩子装晚了）。' +
          '但你的观察是<b>某个具体接口一次都没出现过</b>——这是<b>结构性问题</b>的特征，不是时序问题。<br><br>' +
          '<b>正确解释：同进程调用不走 Binder。</b><br>' +
          'AIDL 生成的代码里有一个关键函数 <span class="mono">asInterface(IBinder)</span>，' +
          '它内部会先调 <span class="mono">queryLocalInterface(DESCRIPTOR)</span>：<br>' +
          '· <b>有结果</b> → 说明服务就在<b>本进程</b>，直接返回那个本地对象，' +
          '后续方法调用就是<b>普通的 Java 方法调用</b>——<span class="mono">transact</span> 不会执行，' +
          '<span class="mono">ioctl</span> 自然也不会发生；<br>' +
          '· <b>没有结果</b> → 返回 <span class="mono">Stub.Proxy</span>，走真正的跨进程路径。<br>' +
          '<span class="hit">这就是那个"分叉点"。它同时解释了为什么你在 Java 层能看到方法被调用，' +
          '而 Binder 层毫无记录——<b>因为这次调用压根没出过这个进程。</b></span><br><br>' +
          '<b>为什么这件事在实战里很重要：</b><br>' +
          '① <b>决定你的观测点选在哪一层。</b>如果你的目标是"看到这两个组件之间传了什么"，' +
          '在 Binder 层下钩子是<b>无用的</b>（同进程不走 Binder）；正确做法是在 Java 层直接 hook 那个方法，' +
          '或者 hook <span class="mono">asInterface</span> 先确认它到底走不走 Binder。<br>' +
          '② <b>解释了"为什么只抓到一部分调用"。</b>同一个接口，' +
          '在某些调用路径上是同进程（不走 Binder），在另一些路径上是跨进程（走 Binder）——' +
          '于是你的 Binder 钩子<b>时灵时不灵</b>。<br>' +
          '③ <b>它也是"为什么有些优化能生效"的原因。</b>' +
          '同进程调用省掉打包、拷贝、线程切换，成本低一个数量级——' +
          '所以框架会尽量把相关组件放在同一进程，或者用 <span class="mono">asInterface</span> 的本地分支做快速路径。<br><br>' +
          '<b>顺带把另外两个选项也钉死：</b><br>' +
          '· <b>Binder 不加密。</b>Parcel 是明文二进制——这正是它能被解析、能被修改的原因' +
          '（本章 26.14 的案例就是改 Parcel）。如果 Binder 加密了，那类工具根本不可能存在。<br>' +
          '· <b>/dev/binder 依然是核心通道。</b>新版本的变化是"内核侧怎么实现"（比如引入 binderfs 做设备节点管理），' +
          '而不是换掉这套 IPC。<b>把"实现方式演进"误读成"机制被替换"，会让你错误地放弃整条 Binder 分析路线。</b>'
      }
    },

    /* ============================================================ 26.12 */
    {
      h: '26.12', title: '动态加载：为什么是 dex 而不是 jar',
      html:
        '<p>这一节回答 1w 目录里那两个非常具体的问题：<b>"怎么生成安卓能动态加载的 jar 包"</b>和' +
        '<b>"怎么动态加载 sdcard 上的可执行文件"</b>。它们背后是同一个事实：<b>安卓不认 Java 字节码。</b></p>' +
        T.note('bad', '☠️ 最核心的一条：Android 的类加载器只认 dex',
          '<p style="margin-bottom:0">你 <span class="mono">javac</span> 编出来的是 <b>JVM 字节码</b>（<span class="mono">.class</span>），' +
          '它<b>不能被 Android 加载</b>。<br>' +
          'Android 的执行格式是 <b>dex</b>，需要再经过一步转换：<b><span class="mono">d8</span></b>（旧版是 <span class="mono">dx</span>）' +
          '把 <span class="mono">.class</span> 转成 <span class="mono">classes.dex</span>。<br>' +
          '<span class="hit">所以"生成一个 Android 能动态加载的 jar"，实质是：' +
          '<b>javac 编出 .class → d8 转成 dex → 把 dex 打包进一个 zip 并命名为 .jar</b>。' +
          '这个 jar 里装的<b>不是 class，而是 dex</b>——这就是它和普通 Java jar 的本质区别。</span></p>') +
        T.tbl(['加载器', '加载什么', '典型用途', '逆向视角'],
          [
            ['<span class="mono">PathClassLoader</span>', '已安装 APK 里的 dex', '<b>App 的默认加载器</b>', '你 <span class="mono">Java.use</span> 默认用它——所以找不到壳加载的类（第 2 章）'],
            ['<span class="mono">DexClassLoader</span>', '任意路径的 dex / jar / apk（可指定优化目录与 so 搜索路径）', '<b>插件化、加固壳</b>', '<b>加固的核心动作</b>——它解密 dex 到一个私有路径，再用它加载'],
            ['<span class="mono">InMemoryDexClassLoader</span>', '<b>内存里的 dex</b>（<span class="mono">ByteBuffer</span>）', '不想落盘的场景', '<b>不落地就加载</b>——所以"去文件系统里找解密后的 dex"这条路会失败，要 dump 内存'],
            ['<span class="mono">BaseDexClassLoader</span>', '上面几个的公共父类', '—', '要 hook 类加载行为，<b>这是覆盖面最广的位置</b>']
          ]) +
        T.tbl(['加载 so', '怎么用', '限制'],
          [
            ['<span class="mono">System.loadLibrary("name")</span>', '按名字在 App 的 native 库目录里找', '只找 App 自己的 lib 目录'],
            ['<span class="mono">System.load("/abs/path/libx.so")</span>', '按绝对路径加载', '<b>路径必须可读</b>；且受下面的"可执行限制"约束'],
            ['<span class="mono">dlopen</span> / <span class="mono">android_dlopen_ext</span>', 'native 层直接加载', '加固壳走这条，可加载它自己解密出来的 so']
          ]) +
        T.note('warn', '⚠️ 一个真实的硬限制：从可写目录加载可执行代码被禁止',
          '<p style="margin-bottom:0">历史上"把 so 放到 sdcard 上再加载"是可行的，' +
          '所以 1w 目录里才有"动态加载 SDCard 可执行文件"这个课时。<br>' +
          '但<b>较新的 Android 版本禁止了"从可写目录执�行本地代码"</b>（W^X 策略）——' +
          'App 私有目录里的文件默认不能再被 <span class="mono">dlopen</span>。' +
          '<span class="pill warn">具体从哪个版本、以什么范围生效，随版本演进有过调整，请以官方文档当期说明为准。</span><br>' +
          '<span class="hit">逆向意义：<b>如果你看到"这个 so 从 sdcard 加载"的方案，先确认它的目标版本还允许。</b>' +
          '很多老教程里的做法在新系统上会直接失败——把"必然失败的做法"当成有效攻击面，是分析里的一种典型浪费。</span></p>'),

      stepper: {
        title: '生成并加载一个"能被安卓动态加载的 jar"：五步',
        lines: [
          { code: '<span class="c">// ① 写 Java 源码，用 javac 编成 .class</span>\njavac -source 8 -target 8 -d out/ src/com/example/plugin/*.java\n<span class="c">// out/com/example/plugin/Plugin.class</span>',
            note: '<b>① 产出 JVM 字节码。</b>注意这一步和普通 Java 完全一样——<b>问题出在下一步</b>。<br>' +
              '<span class="pill warn">字节码版本要与目标环境兼容（Android 支持到哪个 Java 版本随工具链演进），具体以你的 d8 版本为准</span>',
            state: { '产出': '.class（JVM 字节码）', 'Android 能加载？': '<b>不能</b>' } },
          { code: '<span class="c">// ② 用 d8（旧版 dx）转成 dex</span>\nd8 --output out-dex/ out/com/example/plugin/*.class\n<span class="c">// out-dex/classes.dex</span>',
            note: '<b>② 这一步是"安卓化"的关键。</b>d8 会把一批 <span class="mono">.class</span> 合并成<b>一个</b> dex，' +
              '并完成 dex 格式特有的处理（寄存器分配、字符串与类型索引去重等）。<br>' +
              '<span class="hit">"为什么 dex 比同等的 class 集合小"——因为 dex 有全局的索引区去重（第 28 章会拆它的结构）。</span>',
            state: { '产出': 'classes.dex', 'Android 能加载？': '<b>能</b>' } },
          { code: '<span class="c">// ③ 打包成 zip，并命名成 .jar</span>\nzip -j plugin.jar out-dex/classes.dex\n<span class="c">// ⚠️ 里面装的是 classes.dex，不是 .class</span>',
            note: '<b>③ "jar"在这里只是一个容器格式（zip）。</b>类加载器会去容器里找 ' +
              '<b><span class="mono">classes.dex</span></b> 这个名字。<br>' +
              '<b>所以"安卓能动态加载的 jar"的定义是：</b><span class="hit">一个 zip，根目录下有 <span class="mono">classes.dex</span>。</span>' +
              '名字叫 .jar 还是 .apk 都不重要，重要的是里面的东西。<br>' +
              '<span class="pill warn">多 dex（classes2.dex…）的支持情况与加载器版本有关，以官方文档为准</span>',
            state: { '产出': 'plugin.jar（内含 classes.dex）', 'Android 能加载？': '能' } },
          { code: '<span class="c">// ④ 运行时用 DexClassLoader 加载</span>\nDexClassLoader loader = <span class="k">new</span> DexClassLoader(\n    jarPath,          <span class="c">// jar/dex/apk 的路径</span>\n    optimizedDir,     <span class="c">// 优化产物目录（新版本已忽略，见下）</span>\n    libSearchPath,    <span class="c">// so 的搜索路径</span>\n    parentLoader);    <span class="c">// 父加载器</span>',
            note: '<b>④ 加载。</b>四个参数都要留意：<br>' +
              '· <b><span class="mono">optimizedDir</span></b>——历史上用来放 odex，' +
              '<span class="pill warn">在较新版本上这个参数已被忽略（系统有自己的优化产物管理），传 null 也常见</span>；<br>' +
              '· <b><span class="mono">libSearchPath</span></b>——<b>插件自己的 so 目录</b>，不传的话插件里的 so 加载会失败；<br>' +
              '· <b><span class="mono">parentLoader</span></b>——决定双亲委派链，' +
              '<span class="hit">这也是第 2 章"类找不到该切哪个加载器"的核心。</span>',
            state: { '产出': '可用的 ClassLoader', 'Android 能加载？': '能' } },
          { code: '<span class="c">// ⑤ 用反射调用插件里的类</span>\nClass&lt;?&gt; c = loader.loadClass(<span class="s">"com.example.plugin.Plugin"</span>);\nObject o = c.newInstance();\nc.getMethod(<span class="s">"run"</span>).invoke(o);',
            note: '<b>⑤ 用反射调。</b>因为宿主编译期<b>没有</b>插件的类，只能用反射（或统一接口 + 强制转换）。<br>' +
              '<span class="hit">这解释了一个逆向现象：<b>为什么插件化/加固的代码里到处是反射？</b>' +
              '不是作者喜欢反射，而是编译期根本拿不到那个类型。<br>' +
              '反过来说——<b>你在 Java 栈上看到大量反射调用时，往往说明"这里有一个动态加载的模块边界"</b>（第 20.10 节、第 26.9 节都用到过这个判断）。</span>',
            state: { '产出': '插件代码被执行', 'Android 能加载？': '能' } }
        ]
      },

      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '起点',
            scenario: '<b>情境：</b>你在分析一个插件化 App。你发现宿主在运行时从服务端下载了一个 <span class="mono">plugin.jar</span>，' +
              '存到 App 私有目录，然后用 <span class="mono">DexClassLoader</span> 加载它。' +
              '你想把 <span class="mono">plugin.jar</span> 拉出来静态分析，于是 <span class="mono">adb pull</span> 了整个目录。' +
              '结果你 <b>在私有目录里找不到这个文件</b>——目录里只有一些名字很奇怪的 <span class="mono">.dat</span> 文件。',
            q: '你的下一步最应该做什么？',
            choices: [
              { t: 'A. 认定它用了内存加载（InMemoryDexClassLoader），改去 dump 内存', next: 'na' },
              { t: 'B. 先确认 DexClassLoader 的第一个参数到底指向哪个路径——很可能你看到的那几个 .dat 就是它', next: 'nb' },
              { t: 'C. 认为文件被删除了，去 hook 文件删除相关的 API 看它删了什么', next: 'nc' },
              { t: 'D. 静态搜索宿主代码里对 "plugin.jar" 这个字符串的引用，看它从哪来的', next: 'nd' }
            ]
          },
          na: {
            label: '选A', terminal: true, verdict: 'bad', verdictTitle: '跳过了一个更便宜的验证',
            result: '<b>"找不到文件"和"没有文件"是两件事，而你把它们当成了同一件。</b><br><br>' +
              '<b>现象其实强烈暗示文件就在眼前：</b>目录里有几个名字奇怪的 <span class="mono">.dat</span>——' +
              '<b>这恰恰是"文件被改名以躲避静态搜索"的典型做法</b>，而不是"文件不存在"。<br>' +
              '<span class="hit">文件名混淆是一个非常廉价、也非常常见的混淆手段：<b>内容一个字没改，只把名字换掉。</b>' +
              '它的成本几乎为零，但能挡住"按名字找文件"这一整类分析。</span><br><br>' +
              '<b>验证"是不是内存加载"的成本对比：</b>内存加载的判断依据是——' +
              '<b>你能 hook 到 DexClassLoader 的构造，但它的第一个参数指向的文件不存在或读不出来</b>。' +
              '而现在你还没确认这个参数是什么，就直接跳到"dump 内存"，' +
              '等于<b>用一个昂贵的手段去解决一个还没被确认的问题</b>。<br><br>' +
              '<b>还有一个更关键的区别：</b>内存加载的 dex <b>从来不以文件形式存在</b>，' +
              '所以"目录里有几个可疑的 .dat"这个现象本身就不支持内存加载的假设——' +
              '<b>如果是内存加载，你不会看到任何可疑的落盘文件。</b>'
          },
          nb: {
            label: '选B', terminal: true, verdict: 'good', verdictTitle: '正确：先问"它到底在读哪个文件"',
            result: '<b>这是唯一能一步收敛的动作，而且它有明确的做法：</b><br><br>' +
              '<b>hook <span class="mono">DexClassLoader</span> 的构造函数，把四个参数都打出来。</b>' +
              '第一个参数（<span class="mono">dexPath</span>）就是答案。<br>' +
              '<span class="hit">这一个 hook 同时回答三个问题：</span><br>' +
              '① <b>文件在哪</b>——拿到真实路径，直接去 pull；<br>' +
              '② <b>是不是内存加载</b>——如果 <span class="mono">dexPath</span> 指向一个不存在的文件，才轮到内存加载的假设；<br>' +
              '③ <b>有几个</b>——传进来的是单个路径还是用 <span class="mono">:</span> 分隔的多个路径。<br><br>' +
              '<b>为什么这个动作排第一：</b>它把"猜测文件叫什么"变成了"读一个已知的值"。' +
              '<b>成本是几十行 Frida 脚本，收益是消除全部不确定性。</b><br><br>' +
              '<b>顺带一提：</b>那几个 <span class="mono">.dat</span> 很可能就是答案。' +
              '你在 hook 里看到 <span class="mono">dexPath</span> 指向某个 <span class="mono">.dat</span> 之后，' +
              '把它的扩展名改成 <span class="mono">.dex</span> 或直接拖进 jadx，通常就能打开了——' +
              '<b>因为改名不改内容。</b>'
          },
          nc: {
            label: '选C', terminal: true, verdict: 'bad', verdictTitle: '在验证"文件是否存在"之前就假设了"它被删了"',
            result: '<b>"被删除"是一个需要证据的假设，而你现在没有任何证据。</b><br><br>' +
              '<b>更实际的判断是：</b>如果它加载完就把文件删了，那你应该能观察到"文件曾经存在过"的痕迹——' +
              '而且<b>卸载后重新启动，它必须重新下载一次</b>（因为本地已经没有了）。' +
              '<span class="hit">这两个都是可观测的：<b>看它有没有反复下载同一个资源，就能验证"删除了"这个假设。</b></span><br><br>' +
              '<b>而"去 hook 删除相关 API"这个动作的性价比很低：</b><br>' +
              '· 删除 API 有很多种（<span class="mono">File.delete</span> / <span class="mono">unlink</span> / ' +
              '<span class="mono">remove</span> / <span class="mono">rename</span>…），你要先猜它用哪个；<br>' +
              '· 就算抓到了，你也只能知道"它删了某个文件"，<b>拿不到文件内容</b>；<br>' +
              '· 而与它相比，hook 一个<b>已知会被调用</b>的构造函数（<span class="mono">DexClassLoader</span>）是确定能拿到结果的。<br><br>' +
              '<b>选择动作的判断标准：这个动作成功时我能得到什么？</b>' +
              '"hook 删除 API"成功时得到的是"一个被删的路径"，"hook DexClassLoader"成功时得到的是' +
              '"<b>它到底加载了什么</b>"——后者的信息量高一个数量级。'
          },
          nd: {
            label: '选D', terminal: true, verdict: 'bad', verdictTitle: '静态搜索在这个场景里信息量很低',
            result: '<b>搜字符串不是错的，但在这里它几乎注定一无所获——而且原因值得说清楚。</b><br><br>' +
              '<b>为什么搜不到：</b><br>' +
              '① <b>路径是运行时拼出来的。</b>真实代码通常是 <span class="mono">getFilesDir() + "/" + name</span>，' +
              '字符串常量里根本没有完整路径；<br>' +
              '② <b>名字可能是下载后决定的。</b>服务端返回的元数据里带文件名，客户端只是照着用；<br>' +
              '③ <b>那就更容易连 "plugin.jar" 这个字符串都不存在</b>——' +
              '<span class="hit">你按一个自己想象出来的名字去搜，当然搜不到。</span><br><br>' +
              '<b>更重要的方法论问题：</b>你要找的不是"这个字符串在哪"，而是"<b>它实际加载了什么</b>"。' +
              '前者的答案可能是一堆拼接代码（你还得继续往下追），后者的答案是一个<b>具体的路径值</b>。<br>' +
              '<span class="hit">凡是"运行时才能确定的值"，都不要试图静态穷举——去运行时读它。</span>' +
              '这与第 8 章"动态 dump 常量"、第 30 章"七条线索"里"从行为反推"是同一条原则：' +
              '<b>让程序自己把值算出来给你看。</b>'
          }
        }
      }
    },

    /* ============================================================ 26.13 */
    {
      h: '26.13', title: '收口：把基础模型翻译成逆向观测点',
      html:
        '<p>这一章讲的都是"安卓怎么运作"。最后这一节做一件更有用的事：' +
        '<b>把每个基础概念翻译成"遇到它时，我该在哪里下钩子、该注意什么"。</b></p>' +
        T.tbl(['基础概念', '它在逆向里对应的观测点', '最容易踩的坑'],
          [
            ['<b>四大组件</b>', '清单文件是地图；每个组件入口都是稳定下钩点', '只看 Activity，漏掉 Receiver/Provider 这些<b>无界面入口</b>'],
            ['<b>生命周期</b>', '<span class="mono">attachBaseContext</span> / <span class="mono">onCreate</span> 是加固的介入点；也是你找业务逻辑的起点', '<b>销毁重建</b>让 onCreate 跑两次；onDestroy <b>不保证被调用</b>'],
            ['<b>ContentProvider 早于 Application</b>', '想抢最早的时机，看这里', '在 Application 里做的初始化，Provider 可能<b>已经依赖过了</b>'],
            ['<b>Service 在主线程</b>', 'Service 回调里的耗时操作同样会 ANR', '以为 Service = 后台线程'],
            ['<b>Handler / Looper</b>', 'hook <span class="mono">Handler.post</span> 能看到"从子线程回到 UI"的所有动作；<span class="mono">handleMessage</span> 抓不到 post 进去的 Runnable', '<b>线程判断错误</b>导致 hook 装上了不命中'],
            ['<b>消息按 when 排序</b>', '判断"为什么这条先执行"；判断延迟是否可靠', '把 <span class="mono">postDelayed</span> 当精确定时器'],
            ['<b>Binder = ioctl</b>', '在 <span class="mono">libbinder.so</span> 的 <span class="mono">ioctl</span> 或 Java 层 <span class="mono">transact</span> 上下钩子', '<b>基于文件 syscall 的监控看不到 Binder</b>'],
            ['<b>同进程不走 Binder</b>', '<span class="mono">asInterface</span> 是分叉点', '"为什么只抓到一部分调用"'],
            ['<b>Binder 线程池</b>', '服务端代码跑在 Binder 线程上', '在服务端下钩子时对线程的预期搞错'],
            ['<b>存储沙箱与版本</b>', '权限声明本身就是行为特征（如「所有文件访问」）', '<b>把"新版本上必然失败"的做法当成有效攻击面</b>'],
            ['<b>动态加载只认 dex</b>', 'hook <span class="mono">DexClassLoader</span> 构造拿真实路径', '按自己想象的文件名去静态搜索'],
            ['<b>类加载器可换</b>', '<span class="mono">BaseDexClassLoader</span> 是覆盖面最广的钩子位置', '用默认加载器找不到壳加载的类（第 2 章）']
          ]) +
        T.note('key', '🔑 一条贯穿全章的心法',
          '<p style="margin-bottom:0">这一章的所有内容，最后都可以收成一句话：' +
          '<b>安卓不是"一个跑起来的程序"，而是"一台被系统反复调用的状态机 + 一张进程间的电话网"。</b><br>' +
          '所以逆向时的两个基本问题永远是：<br>' +
          '① <b>这段代码是在哪个回调里被系统调起来的？</b>（组件 + 生命周期 + 线程）<br>' +
          '② <b>它是怎么知道要干这件事的？</b>（Binder + 动态加载 + 存储）<br>' +
          '<span class="hit">把这两个问题问出来，你就不会再有"不知道该从哪下手"的情况——' +
          '因为在安卓里，<b>代码永远不会"自己开始跑"，它总是被某个人、通过某个入口、在某个线程上调起来的。</b></span></p>'),

      quiz: {
        id: 'q26-5', chapter: 26, answer: [1, 3],
        stem: '（多选）你要 hook 的目标代码"装上了但一次都没命中"。结合本章内容，下面哪些解释是<b>成立的</b>？',
        options: [
          { t: '你的 hook 注入到了主进程，而目标逻辑跑在一个 android:process=":remote" 的独立进程里', why: '✅ 成立。<b>多进程是本项目里的高频坑</b>——每个进程有独立的地址空间，注入必须针对正确的那一个。' },
          { t: '这段代码跑在系统服务进程里，你的 hook 在 App 进程里当然命中不了', why: '✅ 成立。Binder 调用跨越进程边界，<b>调用链的另一半在 system_server 里</b>——你只能看到本进程这一侧。' },
          { t: '目标函数通过 Binder 调用了系统服务，所以它在本地一定没有执行', why: '❌ 不成立。Binder 调用是<b>客户端先执行自己的打包代码</b>，再去 transact 的。所以"发起 Binder 调用的那段本地代码"是会被执行的。' },
          { t: '代码在 ContentProvider.onCreate 里执行，而你的 hook 是在 Application.onCreate 里装的', why: '✅ 成立。<b>Provider 早于 Application</b>——你在 Application 里装钩子时，Provider 的初始化已经跑完了。' }
        ],
        explain: '<b>"装上了但零命中"，本章给了你四个新的候选解释——这正是这一章的价值所在。</b><br><br>' +
          '<b>① 进程不对。</b>组件可以被声明到独立进程（<span class="mono">android:process</span>），' +
          '而<b>进程之间不共享内存</b>。风控、推送、插件化都爱用多进程，' +
          '<span class="hit">而多进程的一个副作用是：<b>你的 Frida 脚本只注入了一个进程，另一个进程完全不受影响。</b>' +
          '排查方法很直接——<span class="mono">frida-ps -U</span> 里看进程列表，有没有带冒号后缀的。</span><br><br>' +
          '<b>② 代码在别的进程里（Binder 的另一侧）。</b>你在 App 进程里 hook"某个系统服务的方法"，' +
          '那个方法的实现根本不在 App 进程——它在 <span class="mono">system_server</span> 里。' +
          '<b>你能影响的是"客户端这一侧"</b>（比如 hook <span class="mono">BinderProxy.transact</span> 改参数），' +
          '而不是服务端的实现。<br><br>' +
          '<b>③ 时机不对（Provider 早于 Application）。</b>这是本章最冷门但最实用的一条。' +
          '如果你的钩子装在 <span class="mono">Application.onCreate</span>，而目标在 ' +
          '<span class="mono">ContentProvider.onCreate</span> 里，<b>那你就慢了整整一步</b>。' +
          '正确的做法是把钩子提前到 <span class="mono">attachBaseContext</span>，或者干脆用 spawn 模式。<br><br>' +
          '<b>关于第 3 个选项为什么不成立：</b>Binder 调用<b>不是"把执行权交出去"</b>，' +
          '而是"本地打包 → 进内核 → 对方执行 → 返回"。所以<b>发起调用的本地代码一定会执行</b>，' +
          '你 hook 它是有效的。<span class="hit">真正会"本地不执行"的是 <b>native 化</b>（第 20.11 节）——' +
          '那时代码根本不在 Java 层，而不是"因为走了 Binder"。</span>'
      }
    },

    /* ============================================================ 26.14 实战案例 */
    {
      h: '26.14', title: '实战案例：用 GOT Hook 劫持 libbinder 的 ioctl 拦截全部 Binder 事务',
      case: {
        source: 'github',
        title: 'AndProxy – Android Binder 与系统调用拦截库',
        date: '2026-03-26',
        author: 'ggggmllll',
        target: 'Android · ARM64 · Linux 内核 ≥ 5.10（Seccomp 用户态通知）· NDK r25+ / CMake 3.22+ · GPL-2.0 · C++',
        background:
          '<p>这个项目把本章 26.10 节那条"<b>Binder 的物理落点是 <span class="mono">ioctl(/dev/binder)</span></b>"' +
          '从一个知识点变成了一个可运行的工具。</p>' +
          '<p>它的做法非常直接：<b>用 GOT Hook 劫持 <span class="mono">libbinder.so</span> 里的 <span class="mono">ioctl</span> 调用</b>，' +
          '从而捕获<b>全部</b> Binder 读写；同时用 <b>Seccomp 用户态通知</b>机制拦截指定系统调用，' +
          '并在 Java 层提供统一的回调接口。</p>' +
          '<p>README 自述的核心能力包括：解析 <span class="mono">BR_TRANSACTION</span> / ' +
          '<span class="mono">BC_TRANSACTION</span> 等命令、<b>自动提取服务名与方法名</b>、' +
          '支持在请求前（<span class="mono">before</span>）与回复后（<span class="mono">after</span>）注入 Java 回调并修改事务数据。</p>' +
          '<p><b>为什么它值得作为本章的案例：</b>它正好落在"组件 / IPC / 观测点"这三件事的交点上——' +
          '它不关心某个具体 App 的业务，而是<b>把"进程间通信"这一层变成可观测、可修改的</b>。' +
          '这正是本章想建立的视角。</p>',
        points: [
          '<b>拦截点选在 <code>libbinder.so</code> 的 <code>ioctl</code> 上</b>——对应本章 26.10 节第 ③ 步："所有 Binder 通信都是对 <code>/dev/binder</code> 做 <code>ioctl</code>"。',
          '<b>手段是 GOT Hook</b>：改写导入函数在 GOT 表里的地址，从而在不改动代码段的前提下接管调用（这一点与第 7 章 unidbg 补环境里的"改写 GOT 让指针指向自己的实现"是同一套机制）。',
          '<b>解析 Binder 协议命令</b>：<code>BR_TRANSACTION</code>（服务端收）/ <code>BC_TRANSACTION</code>（客户端发）等，并<b>自动提取服务名与方法名</b>——这解决了 26.10 节第 ② 步留下的问题："客户端侧看到的只是编号 + Parcel，方法名从哪来"。',
          '<b>提供 before / after 两个注入时机</b>：before 可以改请求，after 可以改回复。README 给的示例正是<b>修改 <code>IPackageManager.getApplicationInfo</code> 的返回值、清掉 <code>FLAG_DEBUGGABLE</code></b>——一个"隐藏应用可调试状态"的真实用途。',
          '<b>第二条线是 Seccomp 用户态通知</b>：拦截任意系统调用，回调里可以拿到<b>完整寄存器上下文与参数</b>，并<b>修改返回值或设置错误码</b>；内存读写走 <code>process_vm_readv</code> / <code>process_vm_writev</code>。',
          '<b>Java 层 API 做了封装</b>：README 自述"无需理解底层 Binder 协议或 Seccomp 细节"，<code>BinderDispatcher.registerAfter(接口名, 方法名, 回调)</code> 即可注册，事务数据会自动转成 Java 对象。'
        ],
        method: [
          '先在 <code>libbinder.so</code> 里定位 <code>ioctl</code> 的 GOT 条目，替换为代理函数（<b>这是整个方案的立足点：找对拦截位置</b>）。',
          '在代理函数里转发真正的 ioctl，同时解析 <code>binder_write_read</code> 里的事务命令。',
          '按服务名与方法名匹配注册的回调——这一步把"字节流"翻译成了"可读的调用"。',
          '在 before / after 两个时机回调 Java 层，允许修改 Parcel 数据或回复。',
          '另一条独立线路：用 Seccomp 用户态通知拦系统调用，通过 <code>process_vm_readv</code> / <code>process_vm_writev</code> 安全读写目标进程内存。',
          '把上面两套能力统一暴露成 Java API，降低使用成本。'
        ],
        result:
          '<p>项目实现了一个<b>可用的 Binder 事务拦截与修改框架</b>：能够捕获全部 Binder 读写、' +
          '提取服务名与方法名、在请求前后注入回调并修改事务数据；' +
          '同时提供基于 Seccomp 的系统调用拦截能力。README 给出了完整的使用示例与 API 说明表。</p>' +
          '<p>仓库信息（截至本次核实）：<b>GPL-2.0 许可、C++ 实现、114 star、未归档</b>，' +
          '创建于 2026-03-26，最近一次推送 2026-04-18。</p>',
        terms: ['Binder', 'ioctl', '/dev/binder', 'GOT Hook', 'BR_TRANSACTION', 'BC_TRANSACTION',
          'Parcel', 'Seccomp 用户态通知', 'process_vm_readv', 'IPackageManager', 'FLAG_DEBUGGABLE'],
        limits:
          '<p>README 里明确写出的约束（<b>照录，不代其下结论</b>）：</p>' +
          '<p>① <b>仅支持 ARM64 架构</b>——这一点很关键：它是 GOT Hook，依赖目标架构的指令与表结构；<br>' +
          '② <b>需要 Linux 内核 ≥ 5.10</b>（Seccomp 用户态通知机制的引入版本），依赖项一节里再次强调"Kernel 版本大于 5.10"；' +
          '构建依赖 NDK r25+ 与 CMake 3.22+；<br>' +
          '③ <b>许可证是 GPL-2.0</b>——这会影响它的使用与二次分发方式，采用前需要确认与你的项目许可是否兼容；<br>' +
          '④ <b>README 没有提供"已知问题 / 成功率 / 兼容机型矩阵"这类章节</b>，' +
          '也没有给出在带反调试、带完整性校验的目标上的实测结论。' +
          '<span class="hit">这意味着"能不能在你的目标上稳定工作"需要你自己验证——README 给的是能力与依赖，不是实测保证。</span><br>' +
          '⑤ README 末尾只留了 Issue 与邮箱作为反馈渠道，<b>没有列出测试覆盖范围</b>。</p>',
        analysis:
          '<p><b>这个案例是本章 26.10 节的一次完整工程化兑现，而且它每一步都踩在本章讲过的机制上。</b></p>' +
          '<p><b>① 它验证了"Binder 的落点是 ioctl"这条判断的实际价值。</b>' +
          '本章说这句话时是从"seccomp 拦不到 Binder"这个现象出发的（第 24 章的案例）。' +
          '而这个项目把它反过来用：<b>既然 Binder 一定要经过 ioctl，那劫持 ioctl 就能看到全部 Binder 事务。</b>' +
          '<span class="hit">同一个事实，攻防两侧的用法正好相反——这就是"理解机制"比"记住技巧"值钱的原因。</span></p>' +
          '<p><b>② 它回答了本章 26.10 节留下的一个悬空问题。</b>' +
          '那一节说过："客户端侧看到的只是编号 + Parcel，想知道编号对应哪个方法，要靠 AIDL 生成类或服务端 switch。"' +
          '而这个项目做到了<b>自动提取服务名与方法名</b>——' +
          '这说明<b>这些信息在 Binder 事务里是可解析的</b>：接口描述符（DESCRIPTOR）是明文，' +
          '服务名也是明文。<span class="hit">"名字被藏起来了"这句话在 Binder 层并不成立——' +
          '藏起来的只是业务方法的语义，通道本身的标识是明文的。</span>' +
          '这与第 20 章"反射藏不住自己"、第 26 章"服务名是稳定字符串"是同一条思路。</p>' +
          '<p><b>③ 它的示例选得很准：改 <span class="mono">IPackageManager.getApplicationInfo</span> 清掉 ' +
          '<span class="mono">FLAG_DEBUGGABLE</span>。</b>' +
          '这一条同时印证了本章的两处内容：<br>' +
          '· 26.11 节说"<b>风控最爱查 <span class="mono">PackageManager</span></b>"——这个示例正是从"被查"翻转成"改答案"；<br>' +
          '· 26.10 节第 ④ 步说"<b>调用方的 UID/PID 由内核填入、不可伪造</b>"——' +
          '但请注意：<b>这个项目改的不是"调用方身份"，而是"服务端返回的内容"</b>。' +
          '<span class="hit">这是一个很重要的边界：<b>Binder 保证的是"谁在调"不可伪造，' +
          '但它不保证"返回的数据"没被中间人改过——因为中间人就在你自己的进程里。</b></span></p>' +
          '<p><b>④ 它用的是 GOT Hook，这一点值得单独指出。</b>' +
          '第 1 章讲过 inline hook（改函数头）与 PLT/GOT hook（改跳转表项）的区别，' +
          '而这里选择了后者。<b>原因很实际：</b><span class="mono">ioctl</span> 是一个<b>被导入的函数</b>' +
          '（来自 libc），所以它在 <span class="mono">libbinder.so</span> 的 GOT 里有表项，改表项比改代码段更干净、' +
          '也更容易绕开"检测函数头是否被改"这类检测（与第 1、21 章的对抗内容呼应）。</p>' +
          '<p><b>⑤ 关于它的局限，README 的态度是诚实的：</b>给的是<b>能力清单 + 明确的兼容性边界</b>' +
          '（ARM64、内核 ≥ 5.10、构建依赖），<b>没有夸大战绩</b>——' +
          '没有"支持所有 App"、没有成功率数字、没有机型矩阵。' +
          '<span class="hit">而"内核 ≥ 5.10"这条限制恰恰是本章反复强调的一个主题：' +
          '<b>底层手段总带版本枷锁</b>——就像第 19 章说"每个安卓版本 ART 都会变"、' +
          '第 24 章说"每换一个版本沙箱都要重适配"。<b>越靠近内核，枷锁越硬。</b></span></p>',
        link: 'https://github.com/ggggmllll/AndProxyDemo',
        linkNote: 'GitHub 公开仓库（GPL-2.0）。本次核实：仓库页与 raw README 均返回 200，README 正文 8464 字节，' +
                  '作者、创建时间、许可证、语言、star 数取自 GitHub API。该库定位是安全研究/隐私保护/自动化测试用途。'
      }
    }
  ],

  glossary: [
    { t: '四大组件', d: 'Activity（界面）、Service（无界面后台）、BroadcastReceiver（接收广播）、ContentProvider（跨进程数据共享）。它们必须在 AndroidManifest.xml 中显式声明，系统只认识组件，不认识你的业务逻辑。' },
    { t: '组件导出（exported）', d: '决定"别的 App 能不能唤起这个组件"。历史规则是"带 intent-filter 就默认导出"，Android 12 起带 intent-filter 的组件必须显式声明该属性。它同时是攻击面与逆向入口。' },
    { t: 'Activity 生命周期', d: 'onCreate → onStart → onResume → onPause → onStop → onDestroy，从 Stop 回到前台时经过 onRestart。它不是直线而是可被打断的状态机；onDestroy 不保证被调用；配置变化会触发销毁重建。' },
    { t: 'configChanges 与销毁重建', d: '默认情况下屏幕旋转等配置变化会销毁并重建 Activity，导致 onCreate 被再次调用。声明 android:configChanges 可自行处理。这是"onCreate 跑了两次"最常见的原因。' },
    { t: 'ContentProvider 的创建时机', d: '它的 onCreate 早于 Application.onCreate——因为系统要先装好"对外提供的能力"，才认为进程准备好了。想抢占最早执行时机（加固、SDK 自动初始化）常用它。' },
    { t: 'Service 与线程', d: 'Service 解决的是"生命周期长"，不是"跑在哪个线程"。它的生命周期回调默认由主线程 Looper 调度，因此在其回调里做耗时操作同样会 ANR。' },
    { t: 'startService 与 bindService', d: '前者由 stopService/stopSelf 结束，与调用方死活无关；后者在最后一个客户端解绑时自动销毁。两者混用时必须既 stop 又 unbind 才会销毁——这是"Service 永不退出"的常见原因。' },
    { t: 'Looper', d: '线程的消息循环，每个线程最多一个，存在 ThreadLocal 中。主线程的在 ActivityThread.main 里由 prepareMainLooper() 创建，随后立即进入 loop() 死循环。' },
    { t: 'MessageQueue', d: '按 when（绝对时间戳）排序的单链表，不是普通队列。因此"谁先执行"取决于时间戳而非入队顺序；when 相同的按入队先后。' },
    { t: 'Handler', d: '消息的发送者与处理者，构造时绑定一个 Looper。post(Runnable) 与 sendMessage 走同一条路（前者把 Runnable 放进 Message.callback）。分发优先级：msg.callback → Handler.Callback → handleMessage。' },
    { t: 'sendMessageAtFrontOfQueue', d: '把消息直接插到队列头部，是消息队列里唯一能"插队"的手段。框架用它保证高优先级事件（如同步屏障后的异步消息）不被饿死，滥用会让正常消息排不上队。' },
    { t: 'ANR', d: 'Application Not Responding。机制是：主线程在处理某条消息时耗时过久，导致后续消息（尤其是用户输入事件）超过阈值未被处理。根因永远可归结为"某个回调在主线程上执行太久"。' },
    { t: 'Binder', d: 'Android 的跨进程通信机制。物理落点是对 /dev/binder 做 ioctl；调用方的 UID/PID 由内核填入、不可伪造。它只做一次数据拷贝（通过内存映射）。' },
    { t: 'BinderProxy / Stub', d: '客户端侧的代理与服务端的实现基类。asInterface(IBinder) 是分叉点：同进程返回本地 Stub（不走 Binder），跨进程返回 Proxy（走 transact）。' },
    { t: 'transact / onTransact', d: 'Binder 的调用入口与分发入口。前者发送（code + Parcel + flags），后者按 code 分发到具体方法。code 是整数编号，是"编号→方法"映射表的所在。' },
    { t: 'Parcel', d: 'Binder 的序列化容器。参数按写入顺序读出，有位置指针，读写顺序必须严格一致。Binder 事务有大小上限（约 1MB 量级且进程内共享），超限抛 TransactionTooLargeException。' },
    { t: 'oneway', d: '不等待回复的 Binder 调用（FLAG_ONEWAY）。没有返回值、跨进程不保证顺序、不保证送达。用于不需要结果的单向通知。' },
    { t: 'Binder 线程池', d: '服务端处理 Binder 事务的线程来源，不是服务端主线程。这决定了"在服务端下钩子时，代码跑在哪个线程上"。' },
    { t: 'AIDL', d: '接口定义语言。构建时生成 Stub（服务端）与 Stub.Proxy（客户端），把跨进程调用封装成看起来像普通方法调用的形式。' },
    { t: '动态加载只认 dex', d: 'Android 类加载器加载的是 dex，不是 JVM 字节码。javac 产出 .class 后必须经 d8（旧版 dx）转成 classes.dex。所谓"能被安卓动态加载的 jar"，实质是一个内含 classes.dex 的 zip。' },
    { t: 'DexClassLoader', d: '可加载任意路径 dex/jar/apk 的类加载器，是插件化与加固壳的核心手段。参数包括 dex 路径、优化目录（新版本已忽略）、so 搜索路径、父加载器。' },
    { t: 'InMemoryDexClassLoader', d: '直接从内存中的 ByteBuffer 加载 dex，不落盘。因此"去文件系统找解密后的 dex"这条路对它无效，必须 dump 内存。' },
    { t: '存储沙箱的三次转折', d: '分区存储之前（可读写整张 sdcard）→ Android 10 引入分区存储（可用 requestLegacyExternalStorage 临时退回）→ Android 11 起强制分区存储（需 MediaStore 或「所有文件访问权限」）。具体分界以官方文档为准。' },
    { t: 'W^X 与可执行目录限制', d: '较新 Android 版本禁止 App 从可写目录执行本地代码，因此"把 so 放 sdcard 再 dlopen"在新系统上会失败。分析此类方案前必须先确认目标版本是否还允许。' }
  ],

  teacher: {
    id: 't26', chapter: 26,
    name: '教你重新认识安卓的老兵',
    sub: '你写的每一行代码，都是被系统叫起来才跑的',
    intro:
      '<p>很多人做了一两年逆向，对加固、混淆、脱壳如数家珍，<b>但说不清一个 Activity 是怎么被拉起来的。</b></p>' +
      '<p>这不是知识缺口的问题——<b>这是坐标系的问题。</b>不知道坐标系，你所有的"下钩子"都只能靠试；' +
      '有了坐标系，你会先问"这段代码是被谁、在什么时候、在哪个线程上调起来的"，然后钩子自己就浮出来了。</p>' +
      '<p>我要问的就是坐标系。答不上来可以要提示，但提示不算过关。</p>',
    questions: [
      {
        id: 'c26q1', depth: 1, threshold: 0.7,
        q: '用你自己的话说清楚：<b>为什么说"安卓 App 不是从头执行到尾的程序"？</b>' +
          '这对逆向意味着什么？',
        concepts: [
          { label: 'App 的进程是被 Zygote fork 出来的，不是自己启动的；fork 让它继承了预加载的类库与资源',
            hint: 'App 的进程是怎么来的？',
            any: ['fork', 'zygote', '孵化', '继承', '预加载', '不是 exec', '派生', '复制'] },
          { label: '唯一的 main（ActivityThread.main）跑起来后立刻进入 Looper.loop()，之后处于"等消息"状态',
            hint: '那个 main 函数做了什么之后就再也不返回了？',
            any: ['looper', 'loop', '消息循环', '死循环', '等消息', 'activitythread', '消息队列', '事件驱动'] },
          { label: '业务代码是被回调驱动的：没有系统/事件来调，它一行都不跑',
            hint: '你的代码什么时候才会执行？',
            any: ['回调', '被调用', '事件', '驱动', '系统调用', '没人调就不跑', '被动', '被拉起', '按需'] },
          { label: '逆向意义：每个"唤起点"都是一个稳定的下钩位置，不必在几十万行里盲找',
            hint: '这个模型对"该 hook 哪里"有什么帮助？',
            any: ['下钩', 'hook 点', '钩子', '唤起点', '入口', '稳定', '不用盲找', '定位', '观测点'] },
          { label: '逆向意义：组件的生死由系统决定，所以"运行环境"不是你能假定的',
            hint: '谁决定这个进程什么时候死？',
            any: ['系统决定', '随时被杀', '内存压力', '不保证', '生命周期由系统', '低内存', '被回收'] }
        ],
        hints: [
          '先从进程的诞生说起：它是被"新建"的，还是被"复制"出来的？',
          '再想那个唯一的 main：它执行完之后，程序结束了吗？'
        ],
        probes: [
          '追问：既然业务代码都是被回调驱动的，那"App 一启动就执行的代码"到底挂在哪里？你能说出至少三个位置吗？',
          '再追问：onDestroy 不保证被调用这件事，会怎么影响"退出时清理"这类设计？'
        ],
        model: '<b>一、进程层面的真相：它是被"复制"出来的</b><br><br>' +
          '安卓 App 的进程<b>不是被 <span class="mono">exec</span> 起来的，而是被 Zygote <span class="mono">fork</span> 出来的</b>。' +
          'Zygote 在系统启动时就把框架类库、常用资源预加载好了，' +
          '<b>fork 出来的子进程直接继承这一整套内存</b>。<br><br>' +
          '这一条同时解释了两件事：<br>' +
          '· <b>为什么安卓 App 能"秒开"</b>——不需要重新加载一遍系统类；<br>' +
          '· <b>为什么 Zygote 是所有 App 的共同祖先</b>——所以第 22 章的 LSPosed 只要在 Zygote 里注入，' +
          '就能对之后启动的每一个 App 生效。<br><br>' +
          '<b>二、执行层面的真相：main 是一句死循环</b><br><br>' +
          'App 确实有一个 <span class="mono">main</span>（<span class="mono">ActivityThread.main</span>），' +
          '但它做的事是：<span class="mono">prepareMainLooper()</span> 建好主线程的消息队列 → ' +
          '把 <span class="mono">ApplicationThread</span> 注册给 AMS → 然后 <b><span class="mono">Looper.loop()</span> 进入死循环</b>。<br>' +
          '<span class="hit">从那一刻起，这个进程就在"等消息"，而不是在"执行你的逻辑"。</span><br><br>' +
          '<b>三、所以你的代码是被"叫"起来跑的</b><br><br>' +
          '界面上的一次点击、系统的一次广播、另一个进程通过 Binder 的一次调用、' +
          '一条延迟消息到期……<b>这些才是你代码的执行起点。</b>' +
          '没有它们，你的代码一行都不会跑。<br><br>' +
          '<b>四、这对逆向意味着什么（三条）</b><br><br>' +
          '<b>① "该 hook 哪里"这个问题有了系统性的答案。</b>既然代码是被唤起点调起来的，' +
          '那么<b>每一个唤起点都是一个稳定的下钩位置</b>：' +
          '组件入口（<span class="mono">onCreate</span> / <span class="mono">onStartCommand</span> / <span class="mono">onReceive</span> / <span class="mono">query</span>）、' +
          '消息分发、Binder 调用、生命周期回调。<br>' +
          '<span class="hit">你不需要在几十万行代码里盲找——先问"这个功能是由什么事件触发的"，钩子自己就浮出来了。</span><br><br>' +
          '<b>② 运行环境是你不能假定的。</b>组件什么时候被创建、什么时候被销毁，' +
          '<b>由系统按内存压力和用户行为决定</b>，不由你决定。' +
          '所以 <span class="mono">onDestroy</span> 可能不来、进程可能被无声杀掉、' +
          '旋转屏幕可能让 onCreate 再跑一遍。<br>' +
          '<b>逆向上的后果：</b>不要因为"逻辑上它应该执行过"就断定它执行过——' +
          '<b>要去看证据。</b><br><br>' +
          '<b>③ 早期时机比你想的更早。</b>因为进程是 fork 出来的，' +
          '<span class="mono">ContentProvider.onCreate</span> 早于 <span class="mono">Application.onCreate</span>，' +
          '而 <span class="mono">attachBaseContext</span> 更早。<br>' +
          '<span class="hit">这就是加固壳为什么抢那些位置——它们比"业务代码的起点"更靠前。' +
          '而你的钩子如果装在业务层，就永远慢一步。</span>',
        after:
          '<p><b>如果你的追问答案是"三个位置"，这里对一下：</b>' +
          '① <span class="mono">attachBaseContext</span>（最早，拿到 Context）；' +
          '② <span class="mono">ContentProvider.onCreate</span>（早于 Application，很多人不知道）；' +
          '③ <span class="mono">Application.onCreate</span>（常规位置）。' +
          '<span class="hit">还有第 ④ 个：so 的 ELF 构造函数（<span class="mono">.init_array</span>）——' +
          '那比上面三个都早，因为它在 dlopen 时就跑了（第 20.1 节）。</span></p>'
      },
      {
        id: 'c26q2', depth: 1, threshold: 0.7,
        q: '<b>Service 到底是不是"后台线程"？</b>请说清它的真实性质，以及这个误解会怎么坑到你。',
        concepts: [
          { label: 'Service 不是线程，它是组件；它的生命周期回调默认由主线程 Looper 调度',
            hint: '它的回调跑在哪个线程上？',
            any: ['不是线程', '组件', '主线程', 'ui线程', 'looper', '主线程调度', '同一个线程'] },
          { label: 'Service 解决的问题是"生命周期长"，不是"不阻塞主线程"',
            hint: '它存在的意义是什么？',
            any: ['生命周期', '长期运行', '常驻', '存活', '长命', '与界面无关', '不是并发', '不是异步'] },
          { label: '在 Service 里做耗时操作照样会 ANR，和在 Activity 里一样',
            hint: '那会有什么后果？',
            any: ['anr', '卡死', '阻塞', '无响应', '一样会', '同样', '超时'] },
          { label: '要真正在后台干活必须自己开线程 / 线程池 / 用 JobScheduler 一类',
            hint: '那正确做法是什么？',
            any: ['开线程', '子线程', 'thread', '线程池', 'executors', 'jobservice', 'jobscheduler', 'workmanager', 'coroutine', '协程', 'intentservice'] },
          { label: '逆向意义：不能因为"它在 Service 里"就排除"这段代码跑在主线程上"',
            hint: '这对分析线程有什么影响？',
            any: ['不能排除', '主线程', '线程判断', '误判', '跑在主线程', '排查', '线程假设'] }
        ],
        hints: [
          'Service 的 onStartCommand / onBind 是谁调用的？那个调用者的线程是什么？',
          '如果它真的跑在后台线程上，那"Service 里做耗时操作会 ANR"这件事还成立吗？'
        ],
        probes: [
          '追问：既然 Service 在主线程上，那它到底解决了什么问题？为什么还需要它？',
          '再追问：如果我要在后台做一件真正耗时的活，正确做法是什么？'
        ],
        model: '<b>结论先行：Service 是组件，不是线程；它的回调跑在主线程上。</b><br><br>' +
          '<b>为什么会误解：</b>名字叫 Service、文档说"后台工作"、' +
          '看上去"没有界面所以应该在后台跑"——这三个印象叠起来，就形成了错误的直觉。<br>' +
          '<b>但"后台"在这里指的是"没有界面"，而不是"不在主线程"。</b><br><br>' +
          '<b>机制上的原因：</b>Service 的生命周期回调' +
          '（<span class="mono">onCreate</span> / <span class="mono">onStartCommand</span> / <span class="mono">onBind</span> / <span class="mono">onDestroy</span>）' +
          '是<b>系统通过主线程的消息队列投递进来的</b>——和 Activity 的生命周期回调走的是同一个 Looper。<br>' +
          '所以：<b>在主线程上做耗时操作会 ANR，这件事在 Service 里一模一样。</b><br><br>' +
          '<b>那 Service 到底解决什么：</b>它解决的是<b>"这段逻辑不属于任何一个界面，而且要比界面活得久"</b>。<br>' +
          '· Activity 会随用户操作被销毁，Service 不会（除非你或系统结束它）；<br>' +
          '· 所以"下载""播放""心跳上报"这类需要跨界面持续存在的任务适合放在 Service 里。<br>' +
          '<b>但它提供的只是"生命周期"，不提供"并发"。</b>这两件事必须分清楚。<br><br>' +
          '<b>正确做法：</b>耗时逻辑要自己开子线程/线程池；' +
          '或者用 <span class="mono">IntentService</span>（内部自带工作线程，但已有更新替代方案）、' +
          '<span class="mono">JobScheduler</span> / <span class="mono">WorkManager</span>（带系统调度与约束条件）、' +
          '协程等。<b>Service 只负责"活着"，不负责"不占主线程"。</b><br><br>' +
          '<b>这个误解怎么坑到逆向（两条）：</b><br>' +
          '① <b>线程判断错，钩子白装。</b>如果你假设"Service 里的代码在子线程"，' +
          '用了只对子线程生效的 hook 方式，或者反过来<b>排除了"它在主线程上"的可能</b>，' +
          '你就会在错误的地方找答案。<br>' +
          '② <b>排查 ANR 时找错方向。</b>看到 ANR 的栈在 Service 回调里，' +
          '如果你以为"Service 是后台的所以不该卡主线程"，就会怀疑是别的原因（比如系统调度、Binder 阻塞），' +
          '<span class="hit">而真正的答案就在眼前：<b>那段代码本身就在主线程上，它自己就是元凶。</b></span><br><br>' +
          '<b>顺带补一条本章讲过的同类误解：</b>Binder 服务端的代码<b>也不在它自己的主线程上</b>——' +
          '它跑在 Binder 线程池里。<span class="hit">所以"在哪一层"和"在哪个线程"，永远是两个独立的问题。</span>'
      },
      {
        id: 'c26q3', depth: 2, threshold: 0.7,
        q: '你的 Frida 脚本报告 hook 装上了，但目标方法<b>一次都没被调用</b>。' +
          '<b>请用本章的知识，给出至少三种与"进程/时机/线程"有关的解释，并说明各自的验证方法。</b>',
        concepts: [
          { label: '进程不对：目标逻辑在别的进程（android:process=":remote"），而你的注入只针对一个进程',
            hint: '一个 App 一定只有一个进程吗？',
            any: ['多进程', '进程', 'remote', 'android:process', '别的进程', '独立进程', '进程不对', '冒号'] },
          { label: '时机不对：代码跑在更早的回调里（ContentProvider.onCreate 早于 Application.onCreate，attachBaseContext 更早）',
            hint: '有没有比 Application.onCreate 更早的回调？',
            any: ['时机', '更早', 'contentprovider', 'provider', 'attachbasecontext', '早了', '注册晚了', '提前'] },
          { label: '线程不对：代码在别的线程上（native 自建线程 / Binder 线程池 / 子线程），你的钩子挂在另一条路径上',
            hint: '线程也会让钩子落空吗？',
            any: ['线程', '子线程', 'binder线程', 'native线程', '另一个线程', '线程不对', '线程池'] },
          { label: '代码在别的进程里执行（Binder 的另一侧，如 system_server），本进程只能看到客户端这一侧',
            hint: 'Binder 调用的另一半在哪？',
            any: ['binder', 'system_server', '服务端', '另一个进程', '跨进程', '另一半', '客户端侧'] },
          { label: '验证方法：把钩子提前（spawn / attachBaseContext / hook dlopen），并打印进程与线程 id',
            hint: '怎么区分这几种原因？',
            any: ['spawn', '提前', 'attachbasecontext', 'dlopen', '打印进程', '线程id', 'pid', 'tid', '观测', '计数', 'frida-ps'] },
          { label: '验证方法：用 frida-ps 或 ps 看进程列表，确认有没有带冒号后缀的进程',
            hint: '怎么确认"是不是多进程"？',
            any: ['frida-ps', 'ps', '进程列表', '列出进程', '冒号', '有没有另一个进程', '枚举进程'] }
        ],
        hints: [
          '先不要怀疑"我钩子写错了"——"装上了"已经排除了这一点。那还有什么会让代码"不在你的观测范围内"？',
          '从三个维度各想一个：它在哪个进程、它在什么时刻、它在哪条线程。'
        ],
        probes: [
          '追问：如果确认是多进程，你的下一步是什么？把钩子装到另一个进程有什么额外成本？',
          '再追问：如果代码确实在 system_server 里，你还想观测这次调用，你能做的最近的一件事是什么？'
        ],
        model: '<b>前提读对：</b>"hook 装上了"说明地址解析成功、注入成功，<b>不是工具问题</b>；' +
          '"从未命中"说明<b>这段代码在你观测期间没有执行</b>。<br>' +
          '把它拆成三个维度：<b>进程 / 时机 / 线程</b>。<br><br>' +
          '<b>① 进程不对（多进程）</b><br>' +
          '一个 App 可以有多个进程（<span class="mono">android:process</span>），' +
          '风控、推送、插件化常用。<b>进程之间不共享内存</b>，所以你的注入只影响你注入的那一个。<br>' +
          '<b>验证：</b><span class="mono">frida-ps -U | grep 包名</span> 看有没有带冒号后缀的进程；' +
          '或者进 adb shell 看 <span class="mono">ps -A</span>。<br>' +
          '<span class="hit">这条的"额外成本"是：你要在每个目标进程里各注入一次，而且进程间通信的观测点要重新布。</span><br><br>' +
          '<b>② 时机不对（跑得比你早）</b><br>' +
          '本章的重点之一：<b><span class="mono">attachBaseContext</span> → <span class="mono">ContentProvider.onCreate</span> → ' +
          '<span class="mono">Application.onCreate</span> → <span class="mono">Activity.onCreate</span></b>。<br>' +
          '如果你把钩子装在 <span class="mono">Application.onCreate</span>，' +
          '而目标在 <span class="mono">ContentProvider.onCreate</span> 里——<b>你已经慢了整整一步</b>。<br>' +
          '再往前还有 <span class="mono">.init_array</span>（so 的 ELF 构造函数，dlopen 时就跑）。<br>' +
          '<b>验证 / 对策：</b>改用 <span class="mono">spawn</span> 模式（在 App 主线程跑起来之前注入）；' +
          '或者把钩子提前到 <span class="mono">attachBaseContext</span>；' +
          '或者 hook <span class="mono">dlopen</span> 在模块加载那一刻就位。<br><br>' +
          '<b>③ 线程不对</b><br>' +
          '代码可能跑在：<b>native 自建线程</b>（心跳、上报、检测）；' +
          '<b>Binder 线程池</b>（服务端事务处理）；普通子线程。<br>' +
          '如果你的钩子挂在"主线程的某条路径"上，而这些代码走的是另一条线程，就永远等不到。<br>' +
          '<b>验证：</b>在钩子相关的路径上打印 <span class="mono">Process.getCurrentThreadId()</span>；' +
          '观察 <span class="mono">AttachCurrentThread</span> 有没有被调用（native 线程要调 Java 必须先附着，' +
          '这是一个很灵的旁证）。<br><br>' +
          '<b>④ 补充一条：代码在别的进程里（Binder 的另一侧）</b><br>' +
          '这一条严格说属于"进程不对"，但机制不同：<b>你想 hook 的那个方法，实现根本不在这个进程里。</b><br>' +
          '比如你想 hook 某个系统服务的方法——它在 <span class="mono">system_server</span> 里，' +
          '你通常没有权限注入那个进程。<br>' +
          '<b>能做的：</b>退回到客户端这一侧——hook <span class="mono">BinderProxy.transact</span> 观察/修改参数，' +
          '或者 hook <span class="mono">asInterface</span> 看它是本地对象还是远程代理。<br>' +
          '<span class="hit">本章 26.14 的案例做的就是这件事：既然进不去服务端，<b>就把客户端这一侧的所有 Binder 事务拦下来。</b></span><br><br>' +
          '<b>统一的方法论：先加观测点，再猜原因。</b><br>' +
          '把这几件事一起做，成本不到十分钟，却能一次性区分开：<br>' +
          '· <span class="mono">frida-ps</span> 列进程 → 排除多进程；<br>' +
          '· 在钩子里打印 pid / tid → 排除线程；<br>' +
          '· 在 <span class="mono">attachBaseContext</span>、<span class="mono">ContentProvider.onCreate</span>、' +
          '<span class="mono">dlopen</span> 各下一个"路过就打印"的探针 → 排除时机；<br>' +
          '· 加一个命中计数器 → 区分"真的没执行"和"执行了但你的日志没打出来"。<br>' +
          '<span class="hit">"装上了但零命中"根本不是一个谜题，它是一个可以被四个观测点分开的问题。</span>',
        after:
          '<p><b>再给一条本章特有的排查顺序建议：</b>先查<b>进程</b>（最便宜，一条命令），' +
          '再查<b>时机</b>（改一下注入模式），最后查<b>线程</b>（要加打印）。<br>' +
          '<span class="hit">顺序依据是"验证成本"，不是"发生概率"——因为最便宜的那个往往也是高频原因。</span></p>'
      },
      {
        id: 'c26q4', depth: 2, threshold: 0.7,
        q: '<b>为什么说 Binder 调用"在底层就是一次 ioctl"？</b>' +
          '这个事实给逆向带来哪两个具体后果？',
        concepts: [
          { label: 'Binder 的物理通道是字符设备 /dev/binder，通信通过对它做 ioctl 完成',
            hint: 'Binder 通信具体是对哪个东西做什么操作？',
            any: ['/dev/binder', 'binder设备', '字符设备', 'ioctl', '驱动', 'BINDER_WRITE_READ'] },
          { label: '后果一：基于文件系统 syscall（open/read/write）的监控看不到 Binder 流量',
            hint: '如果你只监控文件读写，能看到 Binder 吗？',
            any: ['seccomp', '文件读写', 'open', 'read', 'write', 'syscall', '监控不到', '看不到', '绕过', '拦不到'] },
          { label: '后果二：想观测或修改 Binder，就要在 ioctl 这一层（或更上层的 transact）下手',
            hint: '那想观测 Binder 该在哪里下手？',
            any: ['hook ioctl', 'libbinder', '拦截', '观测', 'transact', 'hook', 'GOT', '上一层'] },
          { label: 'Binder 走 ioctl 而非 read/write，是它"高效"与"难被通用监控覆盖"的共同原因',
            hint: '为什么它不走普通的读写？',
            any: ['一次拷贝', 'mmap', '高效', '内存映射', '不是读写', '共享内存', '性能'] },
          { label: '调用方的 UID/PID 由内核填入，不可伪造——这是 Binder 的安全性质',
            hint: 'Binder 为什么比其它 IPC "安全"？',
            any: ['uid', 'pid', '内核填入', '不可伪造', '身份', '安全', '内核态', '可信'] }
        ],
        hints: [
          'Binder 通信在系统调用层面是什么形式？想一想 /dev/binder 是什么类型的设备。',
          '如果你写一个 seccomp 规则只拦 open/read/write，Binder 上的数据会被拦到吗？'
        ],
        probes: [
          '追问：既然 ioctl 是一个必经点，为什么"在 ioctl 上做拦截"仍然有局限？',
          '再追问：Binder 保证了"调用方身份不可伪造"，那它保证"返回的数据没被改过"吗？'
        ],
        model: '<b>一、为什么是 ioctl</b><br><br>' +
          '<b>Binder 的物理通道是一个字符设备 <span class="mono">/dev/binder</span>。</b>' +
          '用户态与它的全部交互都通过 <span class="mono">ioctl(fd, BINDER_WRITE_READ, &bwr)</span> 完成——' +
          '<b>不是 read/write，而是 ioctl</b>。<br><br>' +
          '原因是设计选择：<b>Binder 需要"一次调用里既写又读"</b>（发出事务、取回结果），' +
          '而且支持同步/异步两种语义。这种复杂的命令-响应结构用 <span class="mono">read</span>/<span class="mono">write</span> 表达不了，' +
          '用 <span class="mono">ioctl</span> 的命令码机制最自然。<br>' +
          '另外，<b>它只做一次数据拷贝</b>——驱动把一块内核缓冲区映射到目标进程的用户空间（<span class="mono">binder_mmap</span>），' +
          '传统 IPC 要拷贝两次。这也是为什么它比 socket/pipe 更适合做高频的进程间调用。<br><br>' +
          '<b>二、后果一：文件系统监控看不到 Binder</b><br><br>' +
          '这一点在本项目第 24 章的一个真实案例里出现过：<b>某个安全 SDK 通过 Binder 查询已安装应用，' +
          '而基于文件 syscall 的 seccomp 过滤拦不到它——因为它走的是 ioctl，' +
          '压根不经过 open/read/write 这条路径。</b><br>' +
          '<span class="hit">这条的普遍意义：<b>任何"我只拦文件操作"的监控方案，都天然对 Binder 盲。</b>' +
          '而现代 App 的大量敏感行为（查包、查权限、查设备信息、调系统服务）恰恰都在 Binder 上。</span><br><br>' +
          '<b>三、后果二：想观测 Binder，就要在 ioctl 或更上层下手</b><br><br>' +
          '两个层次可选：<br>' +
          '· <b>native 层 hook <span class="mono">ioctl</span></b>（通常是 <span class="mono">libbinder.so</span> 里对 libc ' +
          '<span class="mono">ioctl</span> 的导入调用），<b>覆盖面最全</b>——所有 Binder 事务都从这里过；' +
          '本章 26.14 的案例正是这么做的（GOT Hook）；<br>' +
          '· <b>Java 层 hook <span class="mono">BinderProxy.transact</span></b>，更简单，' +
          '能拿到接口描述符、事务编号与 Parcel，但<b>只覆盖 Java 层的调用</b>（native 直接用的 Binder 看不到）。<br>' +
          '<span class="hit">选哪个取决于你的目标：要"全"就下沉到 ioctl，要"快"就停在 transact。</span><br><br>' +
          '<b>四、顺带说清一个容易混淆的点：身份 vs 数据</b><br><br>' +
          'Binder 有一个很强的安全性质：<b>调用方的 UID/PID 是内核在转发时填入的，调用方自己填不了。</b>' +
          '所以服务端可以确信"你是谁"。<br>' +
          '但请注意它<b>不保证</b>什么：<b>它不保证"返回给你的数据没有被改过"。</b><br>' +
          '<span class="hit">因为中间人就在你自己的进程里——如果你能改自己进程里的 GOT 表，' +
          '就能改掉服务端返回的内容（26.14 的案例正是这么干的：清掉 <span class="mono">FLAG_DEBUGGABLE</span>）。' +
          '<b>"身份不可伪造"与"数据不可篡改"是两个独立的安全目标，Binder 只保证了前者。</b></span>',
        after:
          '<p><b>关于追问"为什么在 ioctl 上拦截仍有局限"：</b>至少三点——<br>' +
          '① <b>架构与版本依赖</b>：GOT Hook 依赖具体的动态链接结构与指令集（26.14 的案例就只支持 ARM64）；<br>' +
          '② <b>可能被更底层的调用绕过</b>：如果目标直接用 syscall 指令进内核（不经过 libc 的 ioctl 包装），' +
          'GOT Hook 就失效了——这与第 13 章"内联 SVC 绕过 libc hook"是同一类问题；<br>' +
          '③ <b>自身可能被检测</b>：改 GOT 表会留下痕迹，遍历自己的 GOT 或校验关键表项就能发现。<br>' +
          '<span class="hit">这三条正好对应全课的主线：<b>越靠近内核越难被绕过，但版本枷锁也越硬。</b></span></p>'
      },
      {
        id: 'c26q5', depth: 3, threshold: 0.72,
        q: '<b>综合题。</b>有人总结说：「安卓里没有"自己开始跑"的代码——' +
          '每一段代码都是被某个人、通过某个入口、在某个线程上调起来的。」<br>' +
          '请用本章的知识，<b>把这句话展开成一套可操作的排查方法</b>：' +
          '当你要找一个功能的实现位置时，你会从哪几个维度去问、每问一次能得到什么信息。',
        concepts: [
          { label: '维度一：谁触发的（组件入口）——按钮点击、通知、广播、其他 App 调起、Provider 查询、Service 启动',
            hint: '这个功能是被什么"事件"触发的？',
            any: ['组件', '触发', '入口', 'activity', 'service', 'receiver', 'provider', '点击', '广播', '通知', 'intent'] },
          { label: '维度二：什么时候（生命周期与初始化时机）——attachBaseContext / Provider.onCreate / Application.onCreate / 具体组件回调',
            hint: '它是在启动的哪个阶段跑的？',
            any: ['生命周期', '时机', 'oncreate', 'attachbasecontext', 'application', 'provider', '启动阶段', '早晚'] },
          { label: '维度三：在哪条线程（主线程 Looper / 子线程 / Binder 线程池 / native 自建线程）',
            hint: '它在哪条线程上执行？',
            any: ['线程', '主线程', 'looper', '子线程', 'binder线程', 'native线程', '线程池', 'tid'] },
          { label: '维度四：在哪个进程（是否多进程、是否需要跨进程才能到达）',
            hint: '它在哪个进程里跑？',
            any: ['进程', '多进程', 'remote', 'pid', '跨进程', 'binder', '另一个进程'] },
          { label: '维度五：怎么被通知到的（消息投递 / Binder / 回调注册），这决定了调用链在哪一段是断的',
            hint: '从触发到执行，中间经过了什么"边界"？',
            any: ['消息', 'handler', 'post', 'binder', '回调', '投递', '边界', '断链', '调用链'] },
          { label: '每一问都要能回答"成功时看到什么、失败时排除什么"，否则这个问法就没价值',
            hint: '怎么判断一个排查动作值不值得做？',
            any: ['成功看到', '失败排除', '信息量', '值不值得', '成本', '收敛', '排除法'] },
          { label: '落地手段：用组件清单当地图、用调用栈分段拼接、用 hook 唤起点、用 traces 文件、用行为反推',
            hint: '具体拿什么工具去问这几个维度？',
            any: ['清单', 'manifest', '调用栈', 'stack', 'hook', 'traces', 'anr', '行为', '反推', '日志', 'logcat'] }
        ],
        hints: [
          '把"某个人"和"某个入口"和"某个线程"拆成三个独立的问题——它们各有各的查法。',
          '再想想：为什么"经过的边界"也值得单独问一次？它决定了什么？'
        ],
        probes: [
          '追问：这五个维度里，哪一个最容易让"钩子明明装上了却不命中"？为什么？',
          '再追问：如果五个维度都问过了还是找不到，说明什么？下一步该往哪一层走？'
        ],
        model: '<b>这句话是对的，而且它可以被操作化。五个维度，每个都有明确的问法与产出。</b><br><br>' +
          '<b>维度一：谁触发的？（组件入口）</b><br>' +
          '<b>怎么问：</b>这个功能是用户点了某个界面、还是收到通知、还是开机/网络变化、' +
          '还是被别的 App 调起、还是被 Provider 查询触发的？<br>' +
          '<b>拿什么问：</b><span class="mono">AndroidManifest.xml</span> 就是地图——' +
          '看有哪些组件、哪些带 <span class="mono">intent-filter</span>、哪些是导出的。<br>' +
          '<b>得到什么：</b>一个<b>确定的类名</b>（比如 <span class="mono">LoginActivity</span>）。' +
          '<span class="hit">这一步的性价比最高——你从"几十万行代码"缩小到了"一个类"。</span><br><br>' +
          '<b>维度二：什么时候？（生命周期与初始化时机）</b><br>' +
          '<b>怎么问：</b>它是在应用启动阶段跑的，还是在某个界面显示时跑的？' +
          '如果是启动阶段，是 <span class="mono">attachBaseContext</span>、' +
          '<span class="mono">ContentProvider.onCreate</span>、还是 <span class="mono">Application.onCreate</span>？<br>' +
          '<b>得到什么：</b><b>这个决定你的钩子要装多早。</b>' +
          '如果目标在 Provider 里，而你把钩子装在 Application —— <span class="hit">那你就慢了一步，表现为"装上了但零命中"。</span><br><br>' +
          '<b>维度三：在哪条线程？</b><br>' +
          '<b>怎么问：</b>主线程（Looper 调度）？子线程？Binder 线程池？native 自建线程？<br>' +
          '<b>得到什么：</b><b>这决定你的钩子在哪条路径上才有机会命中</b>，' +
          '也决定你能不能从主线程的 hook 看到它。<br>' +
          '<span class="hit">本章 26.8 节那句话在这里落地：<b>"我的 hook 装上了但没命中"，一半的答案在这几种线程里。</b></span><br><br>' +
          '<b>维度四：在哪个进程？</b><br>' +
          '<b>怎么问：</b>一个命令就够——<span class="mono">frida-ps</span> 看有没有带冒号后缀的进程。' +
          'Binder 调用的"另一半"是不是在 <span class="mono">system_server</span> 里？<br>' +
          '<b>得到什么：</b>排除掉"进程不对"这个最便宜的怀疑，或者发现"需要在另一个进程里也注入一次"。<br><br>' +
          '<b>维度五：中间经过了什么边界？</b><br>' +
          '<b>怎么问：</b>从触发到执行，中间经过了消息投递（<span class="mono">Handler.post</span>）？' +
          '线程池？Binder？还是直接调用？<br>' +
          '<b>得到什么：</b><b>这个维度决定了"调用栈在哪一段是断的"。</b><br>' +
          '<span class="hit">这是本章最容易被忽略、但在实战里最省时间的一问：<b>' +
          '栈的语义是"当前这一段执行"，经过了投递/跨进程之后，你就看不到发起者了。</b>' +
          '知道在哪里断，你就知道要在哪里<b>补一个观测点把两段接起来</b>（第 26.9 节的决策演练讲的就是这个）。</span><br><br>' +
          '<b>附加的一条纪律：每一问都必须能回答"成功看到什么、失败排除什么"。</b><br>' +
          '比如"hook 一个可能相关的方法"——成功了你能拿到参数，失败了你能排除"它不在这里"。' +
          '而"再读一遍汇编"——成功了也未必得到结论，失败了什么都排除不了。<br>' +
          '<span class="hit">凡答不上这两个问题的动作，往后排。</span><br><br>' +
          '<b>落地手段（与前几章的呼应）：</b><br>' +
          '· <b>组件清单当地图</b>——维度一；<br>' +
          '· <b>调用栈分段拼接</b>——维度五，用第 30 章的"七条线索"里的栈分析；<br>' +
          '· <b>hook 唤起点</b>——维度一/二/三的通用手段；<br>' +
          '· <b>ANR traces 文件</b>——一份带调用栈的真实运行时快照，<b>能直接看到方法调用链</b>；<br>' +
          '· <b>从行为反推</b>——不猜调用关系，直接 hook 数据层（网络、加解密、文件），看谁在动数据。<br><br>' +
          '<b>关于追问"五个都问过还找不到"：</b>' +
          '那说明<b>你要找的东西不在你观测的这一层</b>。可能的方向：<br>' +
          '· 它被 <b>Native 化</b>了（第 20.11 节）——Java 层根本没有方法体；<br>' +
          '· 它被 <b>加固壳</b>藏起来了（第 19 章）——连类都可能不在你看到的 dex 里；<br>' +
          '· 它在 <b>另一个进程或另一个 App</b> 里（跨进程 / 跨应用）；<br>' +
          '· 它在 <b>服务端</b>（这时候要验证的是"客户端到底发了什么"，而不是"客户端算了什么"）。<br>' +
          '<span class="hit">"五个维度都问过"本身就是一条重要信息：<b>它说明问题不在"定位"，而在"层次"</b>——' +
          '该换一层观测了，而不是继续在同一层里换钩子。</span>'
      },
      {
        id: 'c26q6', depth: 3, threshold: 0.72,
        q: '<b>综合题（贯通本章）。</b>一个 App 的行为很奇怪：<br>' +
          '· 它在<b>没有任何界面</b>的情况下也会做网络请求；<br>' +
          '· 你在主进程里 hook 了它的网络库，<b>抓不到那些请求</b>；<br>' +
          '· 你用 <span class="mono">ps</span> 看，发现它有两个进程。<br>' +
          '请结合本章内容，<b>说清这个 App 可能用了哪些机制、你打算怎么一步步把它锁死</b>，' +
          '并指出<b>每一步依据的是本章的哪条机制</b>。',
        concepts: [
          { label: '无界面执行代码：BroadcastReceiver（静默触发点）或 Service / JobScheduler 一类后台机制',
            hint: '没有界面还能跑代码，靠的是哪类组件？',
            any: ['broadcastreceiver', 'receiver', '广播', 'service', 'jobservice', 'jobscheduler', 'workmanager', 'alarmmanager', '无界面', '后台'] },
          { label: '静态注册的 Receiver 能在 App 未启动时被系统唤起（冷启动入口）',
            hint: '哪种注册方式能让 App 没启动也被叫起来？',
            any: ['静态注册', '清单', 'manifest', '冷启动', '未启动', '开机', '系统唤起'] },
          { label: '两个进程意味着要先确认"目标逻辑在哪一个进程里"，抓不到很可能是注入了错误的进程',
            hint: '两个进程这件事，首先意味着什么？',
            any: ['进程', '哪个进程', '注入错', '多进程', 'remote', '独立进程', '分别注入'] },
          { label: '跨进程通信（Binder）意味着调用链在进程边界断开，本进程只能看到自己这一侧',
            hint: '网络请求可能是由另一个进程发起的，那你怎么才能看到它？',
            any: ['binder', '跨进程', 'ipc', '另一个进程发起', '边界', '断链', '客户端侧'] },
          { label: '排查手段：frida-ps / ps 列进程并分别注入；用 spawn 抢时机；hook 组件入口',
            hint: '具体怎么动手？',
            any: ['frida-ps', 'ps', '列进程', '分别注入', 'spawn', '抢时机', 'hook 入口', 'onreceive', 'attach'] },
          { label: '还要考虑：网络可能走 native 直连或自研 SSL（第 23 章），此时 Java 层网络库 hook 不命中',
            hint: '如果它在正确的进程里但你还是抓不到呢？',
            any: ['native', '自研', 'ssl', '直连', 'socket', '不是java', 'openssl', 'boringssl', '下沉'] },
          { label: '收口：把"组件 → 进程 → 线程 → 通信边界 → 实现层"按成本排序逐层排除',
            hint: '把整个流程收成一句有顺序的方法论。',
            any: ['顺序', '逐层', '成本', '排除', '组件', '进程', '线程', '边界', '实现层', '排查顺序'] }
        ],
        hints: [
          '先回答"没有界面怎么还能跑代码"——这指向组件而非线程。',
          '再回答"两个进程意味着什么"——你之前的所有 hook 是在哪个进程里生效的？'
        ],
        probes: [
          '追问：如果确认网络请求是在另一个进程里发起的，你有哪些办法看到它的参数？',
          '再追问：如果两个进程都注入了、网络库也 hook 了，还是抓不到——你下一步该怀疑什么？'
        ],
        model: '<b>先说结论：这三个现象各自对应本章的一条机制，而且它们指向的是同一件事——' +
          '"我的观测点不在它的执行路径上"。</b><br><br>' +
          '<b>第一步：无界面执行代码 → 组件（维度一：谁触发的）</b><br>' +
          '本章 26.6 节讲过：<b>BroadcastReceiver 与 ContentProvider 是"系统/其他 App 视角"的组件，' +
          '它们的价值就在于能在没有界面的情况下被执行。</b><br>' +
          '· <b>静态注册的 Receiver 能在 App 未启动时被唤起</b>——这是很典型的"冷启动入口"；<br>' +
          '· 也可能是 Service（含前台 Service，会带一个常驻通知）或 ' +
          '<span class="mono">JobScheduler</span> / <span class="mono">WorkManager</span>；' +
          '<span class="pill warn">具体是哪种，取决于你看到的系统行为与通知——这一层要靠观测确认，不能靠猜</span>。<br>' +
          '<b>动作：</b>看清单里的 Receiver / Service 声明，特别是带 <span class="mono">intent-filter</span> 的那些。<br>' +
          '<b>依据：</b>26.3 的"组件即入口"、26.6 的"无界面执行"。<br><br>' +
          '<b>第二步：两个进程 → 先确认目标逻辑在哪个进程（维度四：在哪个进程）</b><br>' +
          '这一步是<b>成本最低、也最可能直接解决问题</b>的一步。<br>' +
          '本章反复强调：<b>进程之间不共享内存</b>，你的注入只影响注入的那一个。' +
          '你在主进程 hook 网络库抓不到请求，<b>最省事的解释就是：那些请求是在另一个进程里发的。</b><br>' +
          '<b>动作：</b><span class="mono">frida-ps -U</span> 或 <span class="mono">ps -A</span> 列出全部进程，' +
          '对每个相关进程分别注入，再观察。<br>' +
          '<b>依据：</b>26.1 的"进程 ≠ App"、26.13 的"进程不对"这条坑。<br>' +
          '<span class="hit">这一步之所以要排第二，是因为它"成功时直接给出答案、失败时排除一个维度"，而成本只是一条命令。</span><br><br>' +
          '<b>第三步：通信边界 → 调用链在哪断的（维度五）</b><br>' +
          '如果请求确实在另一个进程里发，那"从点击到请求"这条链<b>中间跨了进程</b>——' +
          'Binder（本章 26.10）或其他 IPC。' +
          '<b>跨进程之后，栈在另一侧重新开始</b>，你在这个进程里永远看不到完整的链。<br>' +
          '<b>动作：</b>把观测点移到<b>边界</b>上——' +
          '在发起侧 hook Binder 调用（<span class="mono">transact</span>）或消息投递（<span class="mono">Handler.post</span>），' +
          '在接收侧 hook 组件入口（<span class="mono">onStartCommand</span> / <span class="mono">onReceive</span>），' +
          '<b>两段分别打，再拼起来</b>。<br>' +
          '<b>依据：</b>26.9 决策演练的结论——<b>栈只能覆盖"当前这一段执行"</b>。<br><br>' +
          '<b>第四步：如果进程对了、入口也对了，还是抓不到 —— 怀疑实现层（维度三 + 更下层）</b><br>' +
          '两种可能：<br>' +
          '· <b>网络不走 Java 层</b>：第 23 章讲过，native 直连、自研 SSL（Flutter/BoringSSL/WebView）都会让' +
          'Java 层网络库的 hook 失效——<b>这是"钩子装上了但零命中"的经典解释</b>；' +
          '· <b>线程不对</b>：请求可能在一个 native 自建线程或线程池里发出，' +
          '而你的钩子挂在主线程的调用路径上。<br>' +
          '<b>动作：</b>下沉到 <span class="mono">send</span>/<span class="mono">recv</span> / ' +
          '<span class="mono">SSL_write</span>/<span class="mono">SSL_read</span>（第 23 章），' +
          '或打印 tid 确认线程。<br>' +
          '<b>依据：</b>26.8 的"三种线程"、26.13 的"实现层"这一行。<br><br>' +
          '<b>把整套流程收成一句方法论：</b><br>' +
          '<span class="hit">按"组件 → 进程 → 通信边界 → 线程 → 实现层"的顺序逐层排除，' +
          '每一层都问"成功时我看到什么、失败时我排除什么"。</span><br>' +
          '这个顺序的依据是<b>验证成本</b>（一条 ps 命令 < 一次 spawn 注入 < 一次 ioctl 层 hook），' +
          '而不是"发生概率"。<br><br>' +
          '<b>最后，回到本章那句心法：</b>' +
          '这三个现象看起来像三个谜题，其实<b>是同一个问题的三种表现</b>——' +
          '"你的观测点不在它的执行路径上"。' +
          '<span class="hit">而本章教的，就是<b>把"它在哪条执行路径上"这个问题拆成几个可以分别回答的小问题</b>：' +
          '哪个进程、哪个时刻、哪条线程、经过了什么边界。</span>'
      }
    ]
  }
};

/* ==========================================================================
   本章 Lab 用到的纯函数（带 ch26 前缀，避免与其它章节在同一上下文里重名）
   ========================================================================== */

function ch26esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---- 实验一：存储路径与权限判定（真实分层规则） ---- */
function ch26StorageData(v) {
  v = v || {};
  const raw = String(v.path || '').trim();
  const api = parseInt(String(v.api || '').replace(/[^0-9]/g, ''), 10) || 0;
  const pkg = String(v.pkg || 'com.example.app').trim() || 'com.example.app';
  const perms = String(v.perm || '').split(/[,，\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  const has = p => perms.some(x => x === p || x.endsWith(p));

  // 路径规范化：真实地解掉 . 与 ..（这正是"路径穿越"的判定依据）
  let norm = raw.replace(/\\/g, '/');
  const isAbs = norm.startsWith('/');
  const segs = norm.split('/');
  const out = [];
  for (const s of segs) {
    if (s === '' || s === '.') continue;
    if (s === '..') { out.pop(); continue; }
    out.push(s);
  }
  norm = (isAbs ? '/' : '') + out.join('/');

  const escaped = norm !== raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/\.\//g, '/');

  // 分类
  let cls, clsLabel, note = '';
  const mInternal = /^\/data\/(data|user\/\d+)\/([^/]+)(\/|$)/.exec(norm);
  const mExtPkg = /^(\/sdcard|\/storage\/emulated\/\d+|\/storage\/self\/primary)\/Android\/data\/([^/]+)(\/|$)/.exec(norm);
  const mExtObb = /^(\/sdcard|\/storage\/emulated\/\d+)\/Android\/obb\/([^/]+)(\/|$)/.exec(norm);
  const mExt = /^(\/sdcard|\/storage\/emulated\/\d+|\/storage\/self\/primary)(\/|$)/.exec(norm);

  if (mInternal) {
    cls = 'internal'; clsLabel = '内部私有目录';
    if (mInternal[2] === pkg) note = '这是本 App 自己的内部目录。';
    else { note = '这是<b>别的 App</b> 的内部目录——非 root 下不可访问。'; cls = 'internalOther'; }
  } else if (mExtPkg) {
    if (mExtPkg[2] === pkg) { cls = 'extSelf'; clsLabel = '外部私有目录（本 App）'; note = '这是本 App 自己的外部私有目录。'; }
    else { cls = 'extOther'; clsLabel = '外部私有目录（别的 App）'; note = '这是<b>别的 App</b> 的外部私有目录。'; }
  } else if (mExtObb) {
    cls = (mExtObb[2] === pkg) ? 'obbSelf' : 'obbOther'; clsLabel = 'OBB 目录';
    note = 'OBB 用于存放 App 的扩展资源包。';
  } else if (mExt) {
    cls = 'shared'; clsLabel = '共享外部存储'; note = '这是共享目录（所有 App 都能看到）。';
  } else if (/^\/data(\/|$)/.test(norm)) {
    cls = 'systemData'; clsLabel = '系统数据区'; note = '非 App 可达（除 root）。';
  } else {
    cls = 'unknown'; clsLabel = '未知 / 其他路径'; note = '不在常见存储分类里。';
  }

  // 判定
  const lines = [];
  let verdict, vcls;
  const need = [];

  if (cls === 'internal') {
    verdict = '✅ 可读写（无需任何权限）'; vcls = 'pass';
  } else if (cls === 'internalOther' || cls === 'systemData') {
    verdict = '❌ 不可访问（除非 root）'; vcls = 'fail';
  } else if (cls === 'extSelf') {
    verdict = '✅ 可读写（API 19 起无需权限）'; vcls = 'pass';
  } else if (cls === 'obbSelf') {
    verdict = '✅ 可读写（无需存储权限）'; vcls = 'pass';
  } else if (cls === 'extOther' || cls === 'obbOther') {
    if (api >= 30) { verdict = '❌ 不可访问（API 30+ 强制分区存储）'; vcls = 'fail'; need.push('分区存储之后，App 默认看不到别的 App 的私有目录'); }
    else { verdict = '⚠️ 旧版本上可能可访问（分区存储之前的行为）'; vcls = 'warn'; need.push('API ' + api + ' 处于分区存储之前或过渡期，行为还不严格'); }
  } else if (cls === 'shared') {
    if (has('MANAGE_EXTERNAL_STORAGE')) { verdict = '✅ 可读写（已具备「所有文件访问」权限）'; vcls = 'pass'; }
    else if (api >= 30) {
      verdict = '❌ 直接按路径访问共享目录不可行'; vcls = 'fail';
      need.push('API 30+ 要么走 <code>MediaStore</code>，要么申请 <code>MANAGE_EXTERNAL_STORAGE</code>（「所有文件访问」）');
    } else if (api >= 29) {
      if (has('WRITE_EXTERNAL_STORAGE') || has('READ_EXTERNAL_STORAGE')) {
        verdict = '⚠️ 可能可访问，但依赖分区存储的过渡配置';
        need.push('API 29 是分区存储的引入版本，当年可用 <code>requestLegacyExternalStorage</code> 临时退回旧行为');
        vcls = 'warn';
      } else { verdict = '❌ 缺少存储权限'; vcls = 'fail'; need.push('需要 <code>READ/WRITE_EXTERNAL_STORAGE</code>'); }
    } else {
      if (has('WRITE_EXTERNAL_STORAGE')) { verdict = '✅ 可读写（分区存储之前的行为）'; vcls = 'pass'; }
      else if (has('READ_EXTERNAL_STORAGE')) { verdict = '⚠️ 只可能读，写需要 <code>WRITE_EXTERNAL_STORAGE</code>'; vcls = 'warn'; }
      else { verdict = '❌ 缺少存储权限'; vcls = 'fail'; need.push('需要 <code>WRITE_EXTERNAL_STORAGE</code>（或至少 READ）'); }
    }
  } else {
    verdict = '❓ 无法判定'; vcls = 'warn';
  }

  return { raw, norm, api, pkg, perms, cls, clsLabel, note, verdict, vcls, need, escaped,
    summary: '<p>' + verdict + '</p>' + (need.length ? '<ul>' + need.map(n => '<li>' + n + '</li>').join('') + '</ul>' : '') };
}

function ch26Storage(v) {
  const d = ch26StorageData(v);
  let html = '<div class="lab-kv">' +
    '<span>原路径 <b style="font-size:11px">' + ch26esc(d.raw) + '</b></span>' +
    '<span>规范化后 <b style="font-size:11px">' + ch26esc(d.norm) + '</b></span>' +
    '<span>目标 API <b>' + (d.api || '?') + '</b></span></div>';

  html += '<table class="lab-tbl"><tr><th>判定项</th><th>结果</th></tr>' +
    '<tr><td>路径分类</td><td><code>' + d.cls + '</code> —— ' + d.clsLabel + '</td></tr>' +
    '<tr><td>说明</td><td>' + d.note + '</td></tr>' +
    '<tr><td>已具备权限</td><td>' + (d.perms.length ? '<code>' + d.perms.join('</code> <code>') + '</code>' : '<span class="muted">（无）</span>') + '</td></tr>' +
    '<tr class="' + (d.vcls === 'pass' ? 'same' : 'diff') + '"><td><b>结论</b></td><td><b>' + d.verdict + '</b></td></tr>' +
    '</table>';

  if (d.escaped) {
    html += '<div class="lab-msg fail"><b>⚠️ 注意：这个路径里含有 <code>. / ..</code> 这类分量，规范化之后跳到了别处</b>' +
      '<div class="lab-note">' +
      '你输入的是 <code>' + ch26esc(d.raw) + '</code>，规范化之后是 <code>' + ch26esc(d.norm) + '</code>。<br>' +
      '<b>这正是"路径穿越"的机制：</b>如果代码只做字符串拼接、不做规范化，' +
      '那么 <code>../</code> 就能把"沙箱内某个子目录下的文件"变成"沙箱外的任意文件"。<br>' +
      '<span class="hit">注意区分两件事：<b>存储权限管的是"能不能进这个目录"，路径规范化管的是"能不能出这个目录"</b>——' +
      '这是两个独立的问题。很多 ContentProvider 目录遍历漏洞就是"权限没问题、但路径没规范化"。</span>' +
      '</div></div>';
  }

  html += '<div class="lab-msg key"><b>🔑 判定的分层依据</b><div class="lab-note">' +
    '<b>第一层看"属于谁"：</b>内部私有（只有本 App）→ 外部私有（本 App 免权限）→ 共享（需要权限/媒体库）→ 别人的私有目录（新版本禁止）。<br>' +
    '<b>第二层看"目标 API 落在哪一段"：</b>' +
    'API &lt; 29（分区存储之前）→ API 29（引入分区存储，有过渡开关）→ API ≥ 30（强制分区存储）。<br>' +
    '<b>第三层看"权限够不够"：</b>注意 <code>MANAGE_EXTERNAL_STORAGE</code>（所有文件访问）' +
    '<b>与普通存储权限不是一个层级</b>——它是敏感权限，需要专门授予。<br>' +
    '<span class="pill warn">各 API 级别的具体分界、过渡开关的生效范围、厂商 ROM 的额外改动，请以官方文档当期说明为准' +
    '——这是本章最容易过期的内容。</span>' +
    '</div></div>';

  html += '<div class="lab-msg model"><b>💡 逆向视角：这条判定有什么用</b><div class="lab-note">' +
    '① <b>避免把"必然失败的做法"当成有效攻击面。</b>' +
    '你在代码里看到一段从 <code>/sdcard</code> 读文件的逻辑，如果它的目标 API 是 30+ 且没有「所有文件访问」权限，' +
    '<b>那这段逻辑在你的设备上根本跑不通</b>——不要在上面浪费分析时间。<br>' +
    '② <b>权限声明本身就是行为特征。</b>看到 App 申请了「所有文件访问」，' +
    '你就知道它需要看全盘（清理、备份、文件管理、或取证类风控）。这比在代码里瞎找高效得多。<br>' +
    '③ <b>路径规范化是漏洞判定的关键。</b>做 ContentProvider 审计时，' +
    '要看的是"它有没有在拼接后做规范化与白名单校验"，而不是"它有没有检查权限"（第 29 章会专门讲）。' +
    '</div></div>';
  return html;
}

/* ---- 实验二：消息队列执行顺序的真实模拟 ---- */
function ch26SimQueue(text) {
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return { err: '没有可解析的输入行' };
  const ops = [];
  for (const ln of lines) {
    // 按位置解析，不要用"关键词黑名单"过滤——那样会把名字就叫 D 的消息误当成 d= 参数
    const m = /^\s*(postDelayed|post|front|sendMessageAtFrontOfQueue)\s+([A-Za-z_$][\w$]*)(?:\s+t\s*=\s*(-?\d+))?(?:\s+d\s*=\s*(-?\d+))?\s*$/i.exec(ln);
    if (!m) {
      return { err: '这一行认不出：「' + ch26esc(ln) + '」——格式应为 <类型> <名字> t=<投递时刻> d=<延迟>，' +
        '类型可选 post / postDelayed / front' };
    }
    ops.push({
      kind: m[1].toLowerCase(),
      raw: ln,
      name: m[2],
      t: m[3] === undefined ? 0 : Number(m[3]),
      d: m[4] === undefined ? 0 : Number(m[4])
    });
  }
  // 真实排序：front 插队首；其余按 when = t + d 稳定排序
  const queue = [];
  ops.forEach((o, idx) => {
    o.when = o.kind === 'front' ? -1 : o.t + o.d;
    o.idx = idx;
  });
  const normal = ops.filter(o => o.kind !== 'front')
    .sort((a, b) => (a.when - b.when) || (a.idx - b.idx));
  // front 类按投递顺序依次插到最前（后投的插得更前）
  const fronts = ops.filter(o => o.kind === 'front').sort((a, b) => a.idx - b.idx);
  const order = fronts.slice().reverse().map(o => o.name).concat(normal.map(o => o.name));
  // 找 when 相同的一组
  const byWhen = {};
  normal.forEach(o => { (byWhen[o.when] = byWhen[o.when] || []).push(o.name); });
  const sameWhen = Object.keys(byWhen).filter(k => byWhen[k].length > 1)
    .map(k => 'when=' + k + '：' + byWhen[k].join(' → '));
  return { ops, order, sameWhen };
}
