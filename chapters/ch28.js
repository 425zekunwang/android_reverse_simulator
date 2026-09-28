/* 第 28 章 · iOS 设备指纹开发与逆向 —— 章节数据文件
   由 ch3-ios.html 经 assets/chapter.js 加载。
   ⚠️ 时效性：越狱工具 / iOS 版本 / Frida 版本变化极快，本文件中所有「当前支持情况」
   均指 2023 年前后的公开状态，读者应以官方仓库与社区当前状态为准。 */

window.CHAPTER = {
  no: 28,
  title: 'iOS 设备指纹开发与逆向',
  lede: '这一章把 iOS 从一个「黑盒平台」拆成三层可操作的对象：<strong>ObjC 运行时</strong>（消息机制决定了 Hook 的入口长什么样）、<strong>Mach-O 与 FairPlay DRM</strong>（决定了你能不能看懂二进制）、<strong>反调试与 SSL Pinning</strong>（决定了你能不能跑起来、能不能抓到包）。学完你应该能回答：拿到一个 App Store 的 ipa，第一步做什么、每一步的失败信号长什么样。',

  meta: [
    '核心问题：<b>为什么 ObjC 的方法调用可以被 Hook？为什么 App Store 的二进制静态反汇编全是乱码？</b>',
    '关键工具：<b>Frida（ObjC API / Interceptor）、Frida-iOS-dump、checkra1n / unc0ver / palera1n / Dopamine（2023 前后）</b>',
    '对手：<b>FairPlay DRM、OLLVM 混淆、ptrace / sysctl / csops 反调试、证书绑定（SSL Pinning）</b>'
  ],

  sections: [
    /* ================= 28.1 ================= */
    {
      h: '28.1',
      title: '先画一张地图：iOS 逆向的生态与现实（2023 前后）',
      intuition: {
        tag: '直觉模型 · 一栋自带保安的房子',
        body: '<p>iOS 设备像一栋<b>自带保安、门锁随时会换</b>的房子：</p>' +
          '<p>· <b>越狱</b> = 你搞到一把备用钥匙，能进配电房（root 权限）。但房东（Apple）每次系统升级就换一次锁，所以钥匙有保质期。</p>' +
          '<p>· <b>砸壳</b> = 屋里那本书是用<b>只有本楼门禁卡才能解密的密码</b>印的。你只能在屋里读；想带走，就得在屋里读一遍、亲手抄一份。</p>' +
          '<p>· <b>反调试</b> = 保安在门口装了「谁在偷看」的探头，你一探头它就拉闸关门（进程自杀）。</p>' +
          '<p>· <b>SSL Pinning</b> = 屋里的人只认自家信使的印章。你伪造一张「通用通行证」（Charles/mitmproxy 根证书）在别的楼好用，在这栋楼直接被拒收。</p>'
      },
      html:
        '<p>iOS 逆向的门槛<b>一半是技术，一半是生态</b>。技术那一半（ObjC 运行时、Mach-O 格式、Frida 的 Hook 模型）十年没大变，学会了就是资产；生态那一半（哪款越狱工具支持哪些芯片、哪些 iOS 版本）几乎每半年翻一次桌子。所以本章把两者分开讲：<b>凡涉及「当前支持情况」的结论，一律标注 2023 年前后</b>。</p>' +

        T.note('key', '🔑 本章的四条主线', '<p><b>① 消息机制 → Hook 入口</b>：ObjC 的方法调用本质是发消息，所有调用都收敛到 <code>objc_msgSend</code>，这直接决定了 Hook 的两个可选位置（28.2）。</p>' +
          '<p><b>② Frida 的 ObjC API → 怎么下手</b>：拿到类、拿到方法、拿到 IMP、主动调用（28.3）。</p>' +
          '<p><b>③ FairPlay DRM → 为什么必须运行时 dump</b>：磁盘上的代码是密文，内存里才是明文（28.4）。</p>' +
          '<p><b>④ 攻防博弈 → 反调试与证书绑定</b>：检测与绕过是一对持续升级的动作，不是一次性 checklist（28.5、28.6）。</p>') +

        '<h4>越狱工具：它们各自解决了什么问题</h4>' +
        T.tbl(
          ['方案', '技术基础', '大致覆盖范围（2023 前后）', '关键特点'],
          [
            ['<b>checkra1n</b>', 'checkm8 漏洞（BootROM 级）', 'A5–A11 芯片，约 iPhone 5s ~ iPhone X', '<b>硬件漏洞，无法被软件更新修复</b>；但受芯片限制，新型号用不了'],
            ['<b>unc0ver</b>', '软件漏洞链', '取决于当时可用的漏洞与 iOS 版本', '跟着漏洞走，版本覆盖面随漏洞公布而变'],
            ['<b>palera1n</b>', 'checkm8', 'A11 及之后的设备（限特定 iOS 版本）', '在 checkm8 能触达的范围内继续沿用硬件漏洞路线'],
            ['<b>Dopamine</b>', '<b>无根越狱</b>（rootless）', 'iOS 15+ 的特定版本', '因为 SSV 把系统卷变成只读签名卷，越狱文件只能放到别处再挂载覆盖']
          ]
        ) +
        '<p class="small muted">上表只是「帮助建立分类直觉」，不是支持列表。具体到某台设备某个 iOS 版本能不能越狱，<b>以官方仓库当期说明为准</b>。</p>' +

        T.note('warn', '⚠️ 时效性警告（涉及生态的结论都要打折听）', '<p>越狱工具、支持机型、Frida 与 frida-server 的版本兼容性<b>变化极快</b>：一个漏洞公布的当天，支持列表就可能重写。本章所有生态性描述都是 <b>2023 年前后</b>的快照。真正动手前，第一件事是去官方仓库/社区看当期状态，而不是照抄任何教程（包括本章）的设备型号。</p>') +

        '<h4>无根越狱（rootless）为什么会成为主流</h4>' +
        '<p>iOS 15 引入 ' + T.term('SSV（签名系统卷）', 'Signed System Volume：系统卷被密封（seal）并做签名校验，只读') + ' 之后，系统卷本身是<b>只读且带签名校验</b>的，直接往里写文件会破坏密封，设备直接起不来。于是越狱方案改成「无根」模式：越狱相关的文件不再铺到 <code>/</code> 下面，而是放在另一处，再通过挂载的方式覆盖到系统路径上。</p>' +
        '<p>这对逆向的<b>实际影响</b>很直接：教程里那些「把 frida-server 丢到 <code>/usr/sbin/</code>」「改 <code>/etc/apt</code> 源」的路径，在无根越狱设备上<b>可能根本不存在或者不是这个位置</b>。你要用工具，就得先看它是否声明支持 rootless，以及它把东西装到了哪里。</p>' +

        T.note('', '为什么非要越狱？不越狱行不行？', '<p><b>需要越狱的根本原因只有一个：权限。</b>' + T.term('frida-server', 'Frida 在设备侧运行的守护进程，需要 root 权限才能注入其他进程') + ' 要以 root 身份运行才能注入别人的进程；砸壳工具也必须在设备上执行、并能读取目标进程的内存。</p>' +
          '<p>不越狱也能做，但走的是另一条路：用 <b>frida-gadget</b> 把 Frida 运行时以动态库的形式<b>重打包注入</b>进 App，再重签名安装。限制很明显——你需要先能改这个 App 的二进制（见 28.4：从 App Store 拿到的二进制是加密的，这一步本身就要先砸壳）、要处理签名与描述文件、而且 gadget 是被 App 自己加载的，运行时机与注入能力都不如 frida-server 自由。</p>') +

        '<h4>砸壳的两条路径</h4>' +
        '<p>砸壳的目标在 28.4 详述，这里只建立分类：<b>静态砸壳</b>——用 <code>Clutch</code>、<code>dumpdecrypted</code> 这类工具从内存里把解密后的段 dump 出来；<b>动态砸壳</b>——基于 Frida（如 Frida-iOS-dump），遍历进程里已加载的 Mach-O 镜像，找到加密的段，从内存读出明文，再<b>重建</b>成一个结构正确的二进制文件。后者的好处是能跑脚本、能批量、能在 Frida 生态里做二次加工。</p>' +

        '<h4>动手前的三条手感（示意输出，用于认路）</h4>',

      term: {
        title: '终端 · 建立三分钟手感',
        lines: [
          { t: 'p', s: 'frida-ps -U', note: '<b>列出通过 USB 连接的 iOS 设备上的进程。</b>能列出进程，说明设备上已经有 frida-server 在跑 —— 这是判断「越狱环境是否真的可用」的第一个信号。' },
          { t: 'o', s: ' PID  Name' },
          { t: 'o', s: '----  ------------------------------' },
          { t: 'o', s: '1234  SpringBoard' },
          { t: 'o', s: '5678  TargetApp' },
          { t: 'p', s: 'otool -l TargetApp | grep -A 5 LC_ENCRYPTION', note: '<b>在 Mac 上看 Mach-O 的 load command。</b>App Store 下载的二进制，加密信息就写在这里。' },
          { t: 'o', s: '      cmd LC_ENCRYPTION_INFO_64' },
          { t: 'o', s: '  cryptoff 16384' },
          { t: 'o', s: ' cryptsize 12345678' },
          { t: 'o', s: '   cryptid 1', note: '<b>cryptid = 1</b> 表示「这段数据在磁盘上是密文」。cryptoff / cryptsize 圈定加密区间 —— 通常就是 <code>__TEXT</code> 段（代码段）。这三个字段是本章 28.4 的主角。' },
          { t: 'p', s: 'python dump.py -l', note: '<b>Frida-iOS-dump 的典型用法之一。</b>具体脚本名与参数以仓库当期 README 为准 <span class="pill warn">待核实</span>；关键不是命令拼写，而是它做的事：连上设备 → 枚举进程 → 从内存 dump 已解密的段。' },
          { t: 'd', s: '# 输出为示意，用于认路；真实字段与顺序以你的设备为准' }
        ]
      },
      after: '<p>记住这张地图的读法：<b>越狱解决权限，砸壳解决可读性，反调试解决运行自由，证书绑定解决抓包可见性</b>。后面四节就是把这四句话各展开一次。</p>'
    },

    /* ================= 28.2 ================= */
    {
      h: '28.2',
      title: 'ObjC 的消息机制：一切都经过 objc_msgSend',
      html:
        '<p>Objective-C 里写下的每一个方法调用，<b>本质都不是「调用」，而是「发消息」</b>：</p>' +
        '<pre data-hl><code>[obj doThing:arg];                          <span class="c">// 你写的</span>\n' +
        'objc_msgSend(obj, @selector(doThing:), arg); <span class="c">// 编译器产出的</span></code></pre>' +
        '<p>' + T.term('objc_msgSend', 'Objective-C 运行时核心函数：接收接收者与选择器，查找方法实现并跳转') + ' 接收三样东西：<b>接收者对象</b>、<b>选择器（selector）</b>、以及<b>参数</b>。它在接收者所属类的方法表里查找这个选择器对应的实现（IMP），然后跳转过去执行。</p>' +

        T.note('key', '🔑 关键推论：Hook 的两个位置就是这么来的', '<p><b>推论一（全覆盖）</b>：既然所有 ObjC 方法调用都要经过 <code>objc_msgSend</code>，那么 <b>Hook 住 objc_msgSend，就能拦截全部 ObjC 方法调用</b>。这是一次 attach 换来 100% 覆盖率。</p>' +
          '<p><b>推论二（更实用）</b>：既然每次调用最终都会落到一个具体的函数地址（IMP）上，那么<b>直接 Hook 某个具体方法的 IMP</b> 才是工程上最常用的做法 —— 用 <code>method_getImplementation</code> 拿到函数地址，再 <code>Interceptor.attach</code>。</p>' +
          '<p>这两条不是「哪个更好」，而是<b>侦察与打击的分工</b>：先用全覆盖去问「谁调用了什么」，锁定目标后换成精准 Hook 把开销和副作用压下来。</p>') +

        '<h4>为什么 Hook objc_msgSend 代价大</h4>' +
        '<p>三个现实问题，缺一不可地要考虑：</p>' +
        '<p><b>① 开销。</b>进程里每一次方法调用都要进你的 JS 回调。JS 侧的执行与 C 侧不在一个数量级上，热点路径上直接把 App 拖慢一个数量级并不罕见。</p>' +
        '<p><b>② 参数个数不固定。</b>ObjC 方法可以有 0 到 N 个参数，而 <code>objc_msgSend</code> 是变参的。在 arm64 调用约定下前若干个参数走寄存器（x0–x7），超出的走栈，你必须自己判断这次调用到底带了几个参数、要不要读栈。</p>' +
        '<p><b>③ 递归。</b>你在回调里只要调用任何一个 ObjC 方法（包括 <code>console.log</code> 背后可能触发的、或 <code>ObjC.Object</code> 的属性访问），都会再次触发你自己的 hook。轻则日志爆炸，重则死循环卡死进程。</p>' +

        '<h4>Frida 的 ObjC API：本章后面反复出现的那几个</h4>' +
        T.tbl(
          ['API', '作用', '实战要点'],
          [
            ['<code>ObjC.available</code>', '判断 ObjC 运行时是否就绪', '脚本开头先判断；在非 ObjC 进程里访问其他 ObjC API 会报错'],
            ['<code>ObjC.classes.ClassName</code>', '获取一个类', '类不存在时返回 undefined，取值前先判空'],
            ['<code>ObjC.classes.X[\'- method:\']</code>', '获取实例方法（<code>-</code>）或类方法（<code>+</code>）', '选择器里的冒号要原样保留，不能省略'],
            ['<code>method.implementation</code>', '方法的 IMP 地址', '可直接喂给 <code>Interceptor.attach</code> —— 这就是 Hook 点 B'],
            ['<code>ObjC.implement(method, func)</code>', '替换方法的实现', '比 attach 更「重」的替换；适合整体改写行为'],
            ['<code>ObjC.choose(ObjC.classes.X, {...})</code>', '枚举堆上该类及其子类的实例', '用来找「当前活着的那个对象」，注意它会扫描堆，别在热路径上反复调用']
          ]
        ) +
        '<p class="small muted">API 名与语义以 Frida 当期文档为准；不同大版本之间 ObjC API 有过调整，脚本报错先怀疑版本差异。</p>',

      stage: {
        title: '一次方法调用的全过程，以及两个 Hook 位置',
        speed: 1900,
        render:
          '<div class="flow-col">' +
            '<div class="flow-row">' +
              '<span class="blk" id="m-src">[obj doThing:arg]</span><span class="arrow">→</span>' +
              '<span class="blk" id="m-msg">objc_msgSend</span><span class="arrow">→</span>' +
              '<span class="blk" id="m-lookup">查方法表</span><span class="arrow">→</span>' +
              '<span class="blk" id="m-imp">找到 IMP</span><span class="arrow">→</span>' +
              '<span class="blk" id="m-run">跳转执行</span>' +
            '</div>' +
            '<div class="flow-row">' +
              '<span class="blk" id="m-recv">接收者 obj</span>' +
              '<span class="blk" id="m-sel">@selector(doThing:)</span>' +
              '<span class="blk" id="m-arg">参数 arg</span>' +
            '</div>' +
            '<div class="flow-row">' +
              '<span class="blk" id="m-cache">方法缓存 cache</span>' +
              '<span class="blk" id="m-cls">本类方法列表</span>' +
              '<span class="blk" id="m-super">父类（沿继承链）</span>' +
            '</div>' +
            '<div class="flow-row">' +
              '<span class="pill" id="m-h1">Hook 点 A：劫持 objc_msgSend</span>' +
              '<span class="pill" id="m-h2">Hook 点 B：劫持具体方法的 IMP</span>' +
            '</div>' +
            '<div class="term-box" id="m-log">&gt; 等待开始…</div>' +
          '</div>',
        reset: () => {
          ['m-src', 'm-msg', 'm-lookup', 'm-imp', 'm-run', 'm-recv', 'm-sel', 'm-arg', 'm-cache', 'm-cls', 'm-super']
            .forEach((i) => S(i, ''));
          CLS('m-h1', 'pill');
          CLS('m-h2', 'pill');
          SET('m-log', '&gt; 等待开始…');
        },
        steps: [
          { run: () => S('m-src', 'active'), note: '<b>起点：源码里的一次调用。</b>你写的是 <code>[obj doThing:arg]</code>。请记住「这不是函数调用，而是发消息」—— 后面所有的可行性都建立在这一句上。' },
          { run: () => { S('m-src', 'done'); S('m-msg', 'active'); SET('m-log', '&gt; objc_msgSend(obj, @selector(doThing:), arg)'); }, note: '<b>编译期改写成 C 调用。</b>编译器把它变成 <code>objc_msgSend(obj, @selector(doThing:), arg)</code>。注意 selector 不是字符串字面量随便传，它在运行时是一个被注册过的 SEL 指针。' },
          { run: () => { S('m-recv', 'active'); S('m-sel', 'active'); S('m-arg', 'active'); }, note: '<b>三个入参就位。</b><code>obj</code> 是接收者，<code>@selector(doThing:)</code> 是选择器，<code>arg</code> 是参数。<span class="hit">方法名（含冒号）被整体当作身份标识</span>，<code>doThing:</code> 和 <code>doThing</code> 是两个不同的选择器。' },
          { run: () => { S('m-msg', 'done'); S('m-recv', 'done'); S('m-sel', 'done'); S('m-arg', 'done'); S('m-lookup', 'active'); }, note: '<b>objc_msgSend 开始查找。</b>它先通过接收者的 isa 找到它的类，然后拿着这个 SEL 去方法表里找对应实现。' },
          { run: () => S('m-cache', 'active'), note: '<b>先查方法缓存（cache）。</b>每个类都维护一张「最近调用过的方法」表，命中就<b>直达 IMP</b>。这是 ObjC 消息发送在热路径上不至于太慢的关键设计。' },
          { run: () => { S('m-cache', 'done'); S('m-cls', 'active'); }, note: '<b>缓存未命中就查本类的方法列表。</b>这里是「注册了哪些方法」的权威来源，也是 <code>method_getImplementation</code> 关注的同一张表。' },
          { run: () => { S('m-cls', 'done'); S('m-super', 'active'); }, note: '<b>本类没有就沿继承链向上找。</b>一直找到 NSObject；找到之后结果会写回缓存，下次同样的调用就走快路径。' },
          { run: () => { S('m-super', 'done'); S('m-lookup', 'done'); S('m-imp', 'active'); }, note: '<b>找到了 IMP。</b>IMP 就是方法实现的函数指针。<span class="hit">这就是 Hook 能成立的全部秘密</span>：无论消息怎么绕，执行最终收敛到一个函数地址上；能改这个地址，就能改行为。' },
          { run: () => { S('m-imp', 'done'); S('m-run', 'active'); }, note: '<b>跳转执行，返回，调用方毫无感觉。</b>整个过程对写上层代码的人是透明的 —— 这正是「运行时可交换实现」这种能力的土壤。' },

          { run: () => CLS('m-h1', 'pill ok'), note: '<b>Hook 点 A：劫持 objc_msgSend 本身。</b>因为所有 ObjC 消息都经过它，一次 attach 就能看到全进程的方法调用 —— <span class="hit">覆盖率接近 100%</span>，用于侦察无敌。' },
          { run: () => CLS('m-h1', 'pill warn'), note: '<b>点 A 的三笔代价。</b>① 每次调用都要进 JS 回调，<span class="miss">开销可能高到改变 App 行为</span>；② 参数个数不固定，arm64 上要自己判断寄存器/栈的取参方式；③ 回调里调用任何 ObjC 方法都会递归触发自己。' },
          { run: () => CLS('m-h2', 'pill ok'), note: '<b>Hook 点 B：先拿到具体方法的 IMP，再 attach 到这个地址。</b>只拦你关心的那一个方法，其他调用完全不经过你 —— 开销可控、逻辑清晰、不易递归。' },
          { run: () => { CLS('m-h2', 'pill acc'); SET('m-log', '&gt; 结论：A 负责「找到目标」，B 负责「稳定打击」'); }, note: '<b>结论（后面每一节都在复用这套分工）。</b>用 A 做侦察：快速知道谁调了谁、参数长什么样；用 B 做工程化 Hook：性能可控、可长期挂着。SSL Pinning 与反调试绕过，本质上都是<b>先用 A 定位、再用 B 改写返回值</b>。' }
        ]
      },

      quiz: {
        id: 'q14-1', chapter: 14, answer: 1,
        stem: '某 App 的 <code>-[LoginManager sendToken:]</code> 会在整个生命周期里被调用上万次，你只需要在它被调用时打印参数。以下做法在工程上最合理的是：',
        options: [
          { t: 'Hook <code>objc_msgSend</code>，在回调里判断选择器是否等于 <code>sendToken:</code>，是就打印参数', why: '能跑通，但每次 ObjC 方法调用都要进你的 JS 回调做一次判断 —— 上万次目标调用之外，是整进程所有调用的开销。这是「用侦察手段干工程活」。' },
          { t: '用 <code>ObjC.classes.LoginManager[\'- sendToken:\'].implementation</code> 拿到 IMP，<code>Interceptor.attach</code> 到该地址', why: '正确。只拦这一个方法，其他调用完全不受影响，开销与副作用都可控 —— 这就是 Hook 点 B 的标准写法。' },
          { t: 'Hook <code>objc_msgSend</code>，并在回调里直接修改传入的参数', why: '不但有全覆盖的开销问题，还想在消息层改参数 —— 参数的取用方式本身就要按参数个数与调用约定判断，风险叠加。' },
          { t: '直接从 App Store 下载的 ipa 里取出二进制，静态改成打印参数再重签名', why: '两个硬伤：从 App Store 拿到的二进制被 FairPlay 加密（见 28.4），静态改的是一段密文；改完还会破坏代码签名。' }
        ],
        explain: '<b>考的是「覆盖率 vs 精准度」的分工。</b><code>objc_msgSend</code> 是 ObjC 全部方法调用的公共咽喉，所以 hook 它必然拿到最大覆盖率，也必然付出最大代价：热路径上的 JS 回调、不固定的参数个数、以及递归风险。一旦你已经知道目标方法是谁（本例已知是 <code>-[LoginManager sendToken:]</code>），就没有任何理由继续用过路费最贵的关口 —— 直接 <code>ObjC.classes.LoginManager[\'- sendToken:\']</code> 取到 <code>.implementation</code>，attach 到那个 IMP 地址，得到的是「只关心这一个方法」的等价能力。工程上的默认策略是：<b>不确定目标时用全覆盖侦察，确定目标后立刻换成精准 Hook</b>。'
      },
      after: '<p>把这一节压缩成一句话：<b>ObjC 的方法调用是消息发送，消息查找的终点是 IMP，所以 Hook 的两种位置天然存在 —— 入口（objc_msgSend）和终点（IMP）。</b>下一节讲怎么用 Frida 把这套机制变成可执行的脚本。</p>'
    },
     /* ================= 28.3 ================= */
     {
       h: '28.3',
       title: '实战起手式：ObjC Hook 与主动调用',
       html:
         '<p>知道了「Hook 点在哪」，接下来是「怎么写」。Frida 的 ObjC API 有三类动作：<b>读</b>（拿类、拿方法、拿 IMP）、<b>拦</b>（attach 到 IMP 或替换实现）、<b>主动调用</b>（在 JS 里直接构造并调用 ObjC 方法）。第三类常被低估 —— 很多「猜不出参数含义」的问题，是靠<b>主动构造一组输入喂进去、看输出变化</b>解决的。</p>' +

         T.note('warn', '⚠️ 最容易踩的坑：ObjC 方法名到 JS 名字的转换', '<p>ObjC 的选择器里有冒号 <code>- sendToken:to:</code>，而 JS 标识符里不能有冒号。Frida 的规则是：<b>把每个冒号 <code>:</code> 换成下划线 <code>_</code></b>。</p>' +
           '<p>· <code>-[Foo doThing:]</code> → 主动调用写 <code>doThing_(x)</code><br>' +
           '· <code>-[Foo doThing:with:]</code> → <code>doThing_with_(a, b)</code></p>' +
           '<p>而在<b>用字符串取方法</b>时（<code>ObjC.classes.Foo[\'- doThing:\']</code>），你必须写<b>原始的、带冒号的</b>选择器，冒号一个都不能少、也不能写成下划线。两个场景规则相反，这是新手最常见的报错来源。</p>') +

         T.note('', '把「主动调用」当探针用', '<p>静态看代码只能猜参数含义。主动调用的价值在于：<b>你可以控制输入</b>。构造一个明显的输入（比如全 <code>A</code> 的字符串、特定的长度），看它返回什么、看它触发哪些后续调用，参数语义往往就此暴露。这和前面几章讲「构造输入观察副作用」是同一个方法论：<b>可控输入 + 可观测输出 = 实验</b>。</p>'),

       stepper: {
         title: 'Frida Hook ObjC 方法：从取类到读返回值',
         lines: [
           { code: '<span class="k">if</span> (!ObjC.available) { <span class="k">throw</span> <span class="k">new</span> <span class="t">Error</span>(<span class="s">"ObjC runtime not ready"</span>); }',
             note: '<b>先确认运行时可用。</b>在非 ObjC 进程（比如纯 C 的守护进程）里访问后面的 API 会直接报错。这是脚本的第一道闸门。',
             state: { 'ObjC.available': 'true' } },

           { code: '<span class="k">var</span> cls = ObjC.classes.<span class="t">LoginManager</span>;',
             note: '<b>按名字取类。</b>拿到的是这个类在运行时的对象。类名错了会是 <code>undefined</code> —— 所以稳妥的写法是先判空再往下走。',
             state: { 'cls': 'LoginManager', '判空': '需要' } },

           { code: '<span class="k">var</span> m = cls[<span class="s">\'- sendToken:\'</span>];',
             note: '<b>取实例方法，字符串里必须带冒号。</b>前缀 <code>-</code> 表示实例方法（对象上调用的），<code>+</code> 表示类方法（类上调用的）。把 <code>-</code> 写成 <code>+</code> 或漏掉冒号，都会拿到 <code>undefined</code>。',
             state: { 'm': 'ObjC.Method', '选择器': '- sendToken:' } },

           { code: '<span class="k">var</span> imp = m.implementation;',
             note: '<b>取出 IMP —— 也就是这个方法实现所在的函数地址。</b>这一步把「ObjC 世界的概念」翻译成「一个普通的指针」，从此就能用通用的 <code>Interceptor</code> 手段处理它。',
             state: { 'imp': '0x1a2b3c4d', '类型': '函数指针' } },

           { code: 'Interceptor.attach(imp, {\n  onEnter: <span class="k">function</span> (args) {\n    <span class="k">this</span>.tok = <span class="k">new</span> ObjC.Object(args[<span class="n">2</span>]);\n  },\n  onLeave: <span class="k">function</span> (retval) { }\n});',
             note: '<b>attach 到 IMP 上。</b>arm64 上 <code>args[0]</code> 是 <code>self</code>、<code>args[1]</code> 是 <code>_cmd</code>（选择器），<b>真正的第一个方法参数从 <code>args[2]</code> 开始</b>。这是 ObjC 方法比普通 C 函数多出来的两个「隐藏参数」。',
             state: { 'args[0]': 'self', 'args[1]': '_cmd', 'args[2]': '第 1 个方法参数' } },

           { code: '<span class="k">this</span>.tok = <span class="k">new</span> ObjC.Object(args[<span class="n">2</span>]);',
             note: '<b>把裸指针包成 ObjC 对象再读。</b><code>args[2]</code> 只是一个地址；用 <code>ObjC.Object()</code> 包一层，才能当对象用（比如看它的类名、当字符串读）。<b>读之前要确认它不是 NULL</b>，否则会得到异常。',
             state: { 'this.tok': 'ObjC.Object' } },

           { code: '<span class="k">var</span> s = <span class="k">this</span>.tok.toString();\nconsole.log(<span class="s">"[+] sendToken: "</span> + s);',
             note: '<b>读值。</b>如果是 NSString，<code>toString()</code> 能直接拿到 JS 字符串。token 这类敏感数据在这里就泄出来了 —— 这也是为什么真实 App 会把参数做成 NSData 或先加密。',
             state: { 's': '"eyJhbGciOi..."' } },

           { code: 'onLeave: <span class="k">function</span> (retval) {\n  console.log(<span class="s">"[+] ret = "</span> + retval);\n}',
             note: '<b>读返回值。</b><code>retval</code> 是原始数值（寄存器里的返回值）。想要对象就再包 <code>ObjC.Object(retval)</code>。<span class="hit">注意：返回结构体时情况不同</span>，需要按架构调用约定处理。',
             state: { 'retval': '0x1 / 0x0' } },

           { code: 'onLeave: <span class="k">function</span> (retval) {\n  retval.replace(ptr(<span class="s">"0x1"</span>));   <span class="c">// 改返回值</span>\n}',
             note: '<b>改返回值 —— 这是绕过类需求的主力动作。</b>把校验函数的返回值从 0（失败）改成 1（成功）。<span class="hit">所有「hook 它让它恒返回成功」的技巧，落地就是这一行。</span>',
             state: { 'retval': '被替换为 0x1' } },

           { code: '<span class="k">var</span> str = ObjC.classes.NSMutableString.alloc().initWithString_(<span class="s">"abc"</span>);',
             note: '<b>主动调用：造一个 ObjC 对象。</b>这里出现了名字转换规则 —— 选择器 <code>initWithString:</code> 在 JS 里写成 <code>initWithString_()</code>，冒号变成下划线。这是本章最容易写错的地方，写错就是 <code>not a function</code>。',
             state: { 'str': 'NSMutableString "abc"' } },

           { code: '<span class="k">var</span> up = str.uppercaseString();\nconsole.log(up.toString());',
             note: '<b>主动调用：把方法当 JS 函数用。</b>无参数的方法没有冒号，因此名字不变。<code>[str uppercaseString]</code> 与 <code>str.uppercaseString()</code> 是同一件事。',
             state: { 'up': 'NSMutableString "ABC"' } },

           { code: '<span class="k">var</span> insts = ObjC.choose(ObjC.classes.<span class="t">LoginManager</span>, {\n  onMatch: <span class="k">function</span> (o) { console.log(o); },\n  onComplete: <span class="k">function</span> () { }\n});',
             note: '<b>主动找出「活着的对象」。</b><code>ObjC.choose</code> 扫描堆上该类<b>及其子类</b>的所有实例。它的用处是：方法要带对象才能调，而你不知道对象在哪 —— 比如单例。代价是扫堆很重，别在热路径上反复调用。',
             state: { 'onMatch': '每个实例回调一次' } },

           { code: '<span class="c">// 危险示范：在读参数的回调里直接对裸指针调方法</span>\nconsole.log(args[<span class="n">2</span>].toString());',
             note: '<b>错误示范：裸指针没有 ObjC 方法。</b>正确姿势是 <code>new ObjC.Object(args[2]).toString()</code>。更重要的是这个提醒：<b>回调里每一次 ObjC 调用都是一次新的消息发送</b>，如果你 hook 的是 <code>objc_msgSend</code> 本身，它会递归触发你自己。',
             state: { '风险': '递归 / 报错' } }
         ]
       },

       decision: {
         start: 'n0',
         nodes: {
           n0: {
             label: '情境一 · 单例对象找不到',
             scenario: '<b>情境：</b>你要主动调用 <code>-[TokenManager refresh]</code> 来观察它的行为，但这个类写成了单例，你不通过界面根本拿不到那个实例。你手上只有 Frida。',
             choices: [
               { t: '直接 <code>ObjC.classes.TokenManager.refresh()</code>，把类当对象用', next: 'n1' },
               { t: '用 <code>ObjC.choose(ObjC.classes.TokenManager, {...})</code> 扫描堆，在 <code>onMatch</code> 里拿到活着的实例再调用', next: 'n2' },
               { t: '先去静态分析找到单例的静态变量在哪，再从内存地址手动读出来', next: 'n3' },
               { t: 'Hook <code>+[TokenManager sharedInstance]</code>，等它被调用时把返回的对象存起来再用', next: 'n4' }
             ]
           },
           n1: { label: '选A', terminal: true, verdict: 'bad',
             verdictTitle: '方向错了：类方法和实例方法是两套东西',
             result: '<b>认知根源：把「类」和「类的实例」混为一谈。</b><code>- refresh</code> 前面的 <code>-</code> 就明确写了它是实例方法，必须在<b>对象</b>上调用。拿类去调实例方法，结果就是取不到这个方法（<code>undefined</code>），随后报 <code>not a function</code>。正确做法是先把对象搞到手：单例的经典拿法是 hook 它的取单例方法（选项 D），或者在堆上找活实例（选项 B）。<b>顺带提醒</b>：如果这里写的是 <code>+ refresh</code>（类方法），那选项 A 反而是对的 —— 所以看选择器前缀不是形式主义，它决定你的整个调用方式。' },
           n2: { label: '选B', terminal: true, verdict: 'good',
             verdictTitle: '可行：堆扫描拿到活实例',
             result: '<b>逻辑正确：对象活在堆上，那就去堆上找。</b><code>ObjC.choose</code> 会枚举该类及其子类的所有实例，在 <code>onMatch</code> 里你就能得到真实对象并调用它的方法。适用场景是「实例已经存在、只是你没有引用」。<b>代价要清楚</b>：扫堆本身很重，而且如果实例还没被创建，你会一无所获 —— 这时需要先触发一次创建路径（比如主动走一遍登录流程）。<b>更省事的替代</b>是选项 D：hook 取单例的方法，让 App 自己把对象送到你手里。两者常配合使用。' },
           n3: { label: '选C', terminal: true, verdict: 'bad',
             verdictTitle: '把手段排错了顺序：静态定位不该是第一步',
             result: '<b>认知根源：面对「运行时缺对象」的问题，却先去做静态分析。</b>从静态偏移手动读内存当然可行，但它依赖一堆前提：你要先有一个没被加密、没被混淆的可分析二进制（28.4 节的坑）、要算准 ASLR 之后的实际地址、还要确保那一刻对象已被初始化。任一环出错，你得到的是一个非法地址，而崩溃现场不会告诉你错在哪一步。<b>正确顺序是：能用运行时手段拿到的，就不要用静态地址去猜。</b>静态分析在这里是交叉验证的工具，不是取对象的首选。' },
           n4: { label: '选D', terminal: true, verdict: 'good',
             verdictTitle: '最干净：让 App 自己把单例交出来',
             result: '<b>这是实战里最常用的做法，因为它把「时机」问题也一起解决了。</b>单例对象必然是被某个方法创建并返回的 —— 通常是 <code>+[TokenManager sharedInstance]</code> 这类取单例方法。你 <code>Interceptor.attach</code> 到它的 <code>.implementation</code>，在 <code>onLeave</code> 里把 <code>retval</code> 包成 <code>ObjC.Object</code> 存到全局变量里，之后随时可用。<b>好处</b>：不用扫堆（省开销）、不需要静态地址、而且拿到的必然是 App 自己认可的那个对象。<b>唯一前提</b>是它得先被调用一次 —— 所以这一步通常配合「先操作一下界面 / 等一会儿」使用。' }
         }
       },

       quiz: {
         id: 'q14-2', chapter: 14, answer: 2,
         stem: '你想用 Frida <b>主动调用</b>方法 <code>-[Foo setValue:forKey:]</code>。下面哪一行写法是对的？',
         options: [
           { t: '<code>foo[\'- setValue:forKey:\'](a, b)</code>', why: '括号取方法是对的，但<b>主动调用</b>不能用带冒号的选择器字符串当函数名。' },
           { t: '<code>foo.setValue:forKey:(a, b)</code>', why: '冒号在 JS 里根本不是合法的标识符字符，这行连语法都过不了。' },
           { t: '<code>foo.setValue_forKey_(a, b)</code>', why: '正确。主动调用时每个冒号 <code>:</code> 变成下划线 <code>_</code>，两个参数依次传入。' },
           { t: '<code>foo.setValue_forKey(a, b)</code>', why: '少了一个下划线。第二个冒号也要转成下划线，写成 <code>setValue_forKey_</code> 才对。' }
         ],
         explain: '<b>记两条相反的规则，就不会再错。</b>①<b>取方法时写原始选择器</b>：<code>ObjC.classes.Foo[\'- setValue:forKey:\']</code> —— 冒号必须保留，因为它是方法身份的一部分。②<b>主动调用时每个冒号换成一个下划线</b>：<code>foo.setValue_forKey_(a, b)</code> —— 因为 JS 标识符不允许冒号，Frida 用下划线替换，一个冒号对应一个下划线，数量必须严格一致（两个冒号就是两个下划线）。另外提醒：主动调用的对象必须是真实的 ObjC 对象（比如从 <code>ObjC.choose</code> 的 <code>onMatch</code> 里拿到的，或 <code>objc_msgSend</code> 的 <code>args</code> 包出来的）；如果它是裸指针，得先 <code>new ObjC.Object(ptr)</code>。'
       },

       after: '<p>到这里，你已经能「读、拦、调」了。但这一切都有个前提：<b>你得先看得懂二进制</b>。而 App Store 下载来的二进制，静态打开是一堆乱码 —— 下一节解释为什么，以及砸壳到底在干什么。</p>'
     },

     /* ================= 28.4 ================= */
     {
       h: '28.4',
       title: 'FairPlay 砸壳：为什么磁盘上是密文，内存里才是明文',
       intuition: {
         tag: '直觉模型 · 只在展厅能读的书',
         body: '<p>想象一本书<b>只在展厅的特定灯光下才能读</b>：书页上印的是乱码，展厅的灯（设备的硬件密钥）一照，字才显形。你可以随便把书带出展厅，但带出去的那本仍然是乱码。</p>' +
           '<p>所以想拿到能读的版本只有一个办法：<b>在展厅里、灯亮着的时候，把内容抄一遍</b>。这就是砸壳 —— 趁 App 运行时内存里已经是明文，把它 dump 出来。</p>' +
           '<p>再补一刀：<b>每台设备的灯都不一样</b>（硬件密钥各不相同），所以你不能把 A 手机上的加密 App 拷到 B 手机上解密 —— B 的灯照不出 A 的字。</p>'
       },
       html:
         '<p>问题从 App Store 的下载机制开始。<b>从 App Store 下载的 App 被 FairPlay DRM 加密</b>，加密信息记录在 Mach-O 的 load command 里：</p>' +
         '<p>· 32 位：<code>LC_ENCRYPTION_INFO</code>　·　64 位：<code>LC_ENCRYPTION_INFO_64</code></p>' +
         '<p>这个 load command 里有三个关键字段：<b><code>cryptoff</code></b>（加密数据在文件中的偏移）、<b><code>cryptsize</code></b>（加密数据的大小）、<b><code>cryptid</code></b>（<code>1</code> = 已加密，<code>0</code> = 未加密）。加密范围通常就是 <code>__TEXT</code> 段 —— <b>代码段</b>。</p>' +

         T.note('bad', '❌ 直接后果：静态反汇编看到的是乱码', '<p>既然 <code>__TEXT</code> 段（代码段）在磁盘上是密文，那么你把它丢进 IDA / Hopper / Ghidra，反汇编出来的<b>全是无意义的字节</b>。这不是工具的问题，也不是你哪里配错了 —— 是数据本身还没解密。这个卡点之所以危险，是它<b>不报错</b>：工具不崩、不提示，只是安静地给你错的结果，很容易让人在工具配置上白绕几小时。</p>') +

         '<h4>解密发生在什么时候</h4>' +
         '<p>解密时机是关键：<b>iOS 内核在把 App 加载到内存时</b>，用<b>设备的硬件密钥</b>解密。注意两个要点：</p>' +
         '<p><b>① 是内核做的，不是 App 自己做的。</b>App 的代码没有机会参与，也无法阻止 —— 它要运行就必须先被解密。</p>' +
         '<p><b>② 密钥是每台设备独有的。</b>所以你不能在设备 B 上解密一个从设备 A 拷来的加密 App。这也解释了为什么砸壳必须在<b>目标设备本机</b>、在 App <b>正在运行</b>的时候做。</p>' +

         T.note('key', '🔑 砸壳的本质（一句话记住）', '<p><b>App 运行时内存里的代码已经是明文 —— 把这部分 dump 出来，并把 <code>cryptid</code> 改成 <code>0</code>，就得到一个可以静态分析的二进制。</b></p>' +
           '<p>这句话拆成三个动作，缺一不可：<b>① dump 内存里的段</b>（拿到明文）→ <b>② 改 <code>cryptid</code> 为 0</b>（告诉后续工具「这段已经不是密文了」）→ <b>③ 重建文件结构</b>（修正段偏移等，让它成为一个结构正确的 Mach-O，而不是一段裸数据）。</p>') +

         '<h4>两条路径</h4>' +
         T.grid(2, [
           '<div class="card"><div class="card-title">静态砸壳（工具化）</div><p>用 <code>Clutch</code>、<code>dumpdecrypted</code> 这类现成工具从内存 dump。特点是<b>拿来就用、步骤少</b>；代价是灵活性有限，遇到结构特殊的二进制或需要批量处理时不好扩展。</p></div>',
           '<div class="card"><div class="card-title">动态砸壳（Frida-iOS-dump）</div><p>基于 Frida：遍历已加载的 Mach-O 镜像 → 找到加密的段 → 从内存 dump 明文 → <b>重建为可用的二进制</b>（修正文件结构、段偏移等）。特点是<b>可脚本化、可二次加工</b>，能嵌进 Frida 工作流。</p></div>'
         ]) +
         '<p><b>Frida-iOS-dump 的一般流程</b>可以概括为五步：列出进程所有模块 → 用户选择目标 → 找到加密的段 → 从内存读取明文 → 写回新的 Mach-O 文件并修正 <code>cryptid</code> 与相关头部字段。<span class="pill warn">待核实</span> <span class="small muted">其内部具体函数名与实现细节本章不复述（避免编造），需要时直接读仓库源码。</span></p>' +

         '<h4>砸壳之后你会遇到什么</h4>' +
         T.note('warn', '⚠️ 砸壳不是终点，只是「可以开始」', '<p>砸壳解决的是<b>可读性</b>，不解决<b>可理解性</b>。真实 App 里还有：<b>OLLVM 混淆</b>（控制流平坦化、虚假控制流 —— 28.6 的案例就是）、<b>Swift 符号</b>（名字被 mangle，读起来是另一套语法）、<b>ObjC 符号被混淆</b>（类名方法名变成无意义串）。所以砸壳之后的第一件事通常不是「读懂全部」，而是<b>定位入口</b>：先找反调试在哪、证书校验在哪，把拦路的点清掉再说。</p>') +

         '<h4>顺带回答一个常见疑问</h4>' +
         '<p><b>「我改了 <code>cryptid</code> 为什么还是跑不起来？」</b>因为 <code>cryptid</code> 只是元数据里的一个标记位，它不负责解码任何东西。如果你只改标记而没有真的把密文替换成明文，系统会按「这段是明文」去执行密文 —— 结果就是崩溃。标记和内容必须<b>同时</b>是「已解密」状态，这也是为什么砸壳必须真的去 dump 内存。</p>',

       stage: {
         title: 'FairPlay 砸壳全过程：从密文磁盘到可分析二进制',
         speed: 2000,
         render:
           '<div class="flow-col">' +
             '<div class="flow-row">' +
               '<span class="blk" id="d-disk">磁盘上的 Mach-O（密文）</span><span class="arrow">→</span>' +
               '<span class="blk" id="d-kern">内核加载</span><span class="arrow">→</span>' +
               '<span class="blk" id="d-key">设备硬件密钥</span><span class="arrow">→</span>' +
               '<span class="blk" id="d-mem">内存中的明文 __TEXT</span>' +
             '</div>' +
             '<div class="flow-row">' +
               '<span class="blk" id="d-dump">从内存 dump</span><span class="arrow">→</span>' +
               '<span class="blk" id="d-fix">改 cryptid 1→0</span><span class="arrow">→</span>' +
               '<span class="blk" id="d-rebuild">重建 Mach-O</span><span class="arrow">→</span>' +
               '<span class="blk" id="d-ida">可静态分析</span>' +
             '</div>' +
             '<div class="memgrid">' +
               '<div class="memrow"><span class="addr">cryptoff</span><span class="cell" id="d-c1">0x4000</span><span class="cell">文件偏移</span></div>' +
               '<div class="memrow"><span class="addr">cryptsize</span><span class="cell" id="d-c2">0xBC614E</span><span class="cell">加密大小</span></div>' +
               '<div class="memrow"><span class="addr">cryptid</span><span class="cell" id="d-c3">1</span><span class="cell" id="d-c4">已加密</span></div>' +
             '</div>' +
             '<div class="term-box" id="d-log">&gt; 等待开始…</div>' +
           '</div>',
         reset: () => {
           ['d-disk', 'd-kern', 'd-key', 'd-mem', 'd-dump', 'd-fix', 'd-rebuild', 'd-ida']
             .forEach((i) => S(i, ''));
           ['d-c1', 'd-c2', 'd-c3', 'd-c4'].forEach((i) => CLS(i, 'cell'));
           SET('d-c3', '1');
           SET('d-c4', '已加密');
           SET('d-log', '&gt; 等待开始…');
         },
         steps: [
           { run: () => S('d-disk', 'active'), note: '<b>起点：从 App Store 下载到磁盘上的二进制。</b>它的 <code>LC_ENCRYPTION_INFO_64</code> 里写着 <code>cryptid = 1</code>，<code>__TEXT</code> 段（代码段）是密文。此刻把它丢进 IDA，看到的全是无意义字节。' },
           { run: () => { CLS('d-c3', 'cell hi'); CLS('d-c4', 'cell hi'); SET('d-log', '&gt; LC_ENCRYPTION_INFO_64: cryptid = 1 （磁盘上是密文）'); }, note: '<b>盯住 cryptid = 1。</b>这个 <code>1</code> 就是「这段数据在磁盘上没解密」的声明。<code>cryptoff</code> 与 <code>cryptsize</code> 圈定了加密区间 —— 通常覆盖 <code>__TEXT</code>。' },
           { run: () => { S('d-disk', 'done'); S('d-kern', 'active'); }, note: '<b>App 启动，内核介入。</b>iOS 内核在加载这个 App 时必须先把它解密 —— 因为 CPU 要执行的指令不能是密文。这一动作发生在你的代码运行之前，App 自身无法干预。' },
           { run: () => { S('d-kern', 'done'); S('d-key', 'active'); }, note: '<b>用设备硬件密钥解密。</b>密钥来自这台设备本身，<b>每台设备不同</b>。这直接推出一条硬约束：你无法在设备 B 上解密设备 A 下载的加密 App —— 所以砸壳必须在目标设备本机、在 App 运行时做。' },
           { run: () => { S('d-key', 'done'); S('d-mem', 'active'); SET('d-log', '&gt; 内存里的 __TEXT 段 = 明文代码 ✓'); }, note: '<b>关键状态：内存里已经是明文。</b><span class="hit">这是整个砸壳得以成立的唯一支点。</span>磁盘是密文、内存是明文，两者的差异就是你的机会窗口。' },
           { run: () => S('d-dump', 'active'), note: '<b>动作①：从内存 dump。</b>读目标进程内存里那段已解密的段。这正是为什么需要越狱（root 权限）与 frida-server —— 你要读的是<b>别的进程</b>的内存。' },
           { run: () => { S('d-dump', 'done'); CLS('d-c1', 'cell rd'); CLS('d-c2', 'cell rd'); SET('d-log', '&gt; 从内存读取 cryptoff 起、cryptsize 字节 → 已获得明文'); }, note: '<b>按 cryptoff / cryptsize 精确取数。</b>不是盲扫内存，而是照着 load command 里的偏移与大小去读 —— 这也是为什么要先解析 Mach-O 头部。' },
           { run: () => { S('d-fix', 'active'); SET('d-c3', '0'); SET('d-c4', '未加密'); CLS('d-c3', 'cell wr'); CLS('d-c4', 'cell wr'); SET('d-log', '&gt; 改写 cryptid: 1 → 0 （告诉后续工具：这段已是明文）'); }, note: '<b>动作②：把 cryptid 从 1 改成 0。</b>这一步不是解密，只是<b>改声明</b> —— 告诉之后使用这个文件的所有工具「别再去解密它了」。<span class="miss">只改标记不换内容 = 崩溃</span>：系统会按明文去执行密文。' },
           { run: () => { S('d-fix', 'done'); S('d-rebuild', 'active'); }, note: '<b>动作③：重建为可用的二进制。</b>修正文件结构、段偏移等相关头部字段，让 dump 出来的数据成为<b>一个结构正确的 Mach-O</b>，而不是一段裸内存。这一步最容易被忽略，也是成熟工具与手写脚本差距最大的地方。' },
           { run: () => { S('d-rebuild', 'done'); S('d-ida', 'active'); SET('d-log', '&gt; 完成：磁盘文件 = 明文 + cryptid=0 → 可丢进 IDA 反汇编'); }, note: '<b>终点：可以静态分析了。</b>现在丢进 IDA / Ghidra 得到的是真实代码。注意这只是「可以开始读」，符号混淆、OLLVM、Swift 名字这些还在后面等着。' },
           { run: () => { S('d-ida', 'done'); SET('d-log', '&gt; ⚠️ 提示：砸壳解决「可读」，不解决「可理解」，OLLVM 混淆仍在。'); }, note: '<b>重要提醒：别把砸壳当成通关。</b>砸壳只是让你看得见。真实 App 里紧接着就是 <b>OLLVM 混淆</b>（28.6 的案例就是）、符号被抹掉、Swift 名字被 mangle。所以砸壳后的第一目标通常很具体：<b>先找到反调试与证书校验，把拦路的点清掉。</b>' }
         ]
       },

       decision: {
         start: 'n0',
         nodes: {
           n0: {
             label: '情境二 · 静态打开全是乱码',
             scenario: '<b>情境：</b>你把从 App Store 下载的 ipa 解开，取出主二进制丢进 IDA。函数列表稀稀拉拉，反汇编窗口里全是无意义的字节，交叉引用也建不起来。你反复确认了文件没取错。',
             choices: [
               { t: '换一个反汇编工具再试，怀疑是 IDA 对这个二进制的支持问题', next: 'n1' },
               { t: '在设备上运行 App，用 Frida-iOS-dump 之类从内存 dump 已解密的段，改 <code>cryptid</code> 为 0 并重建后再分析', next: 'n2' },
               { t: '只把文件里的 <code>cryptid</code> 从 1 改成 0，然后重新打开', next: 'n3' },
               { t: '放弃静态分析，全程靠 Frida 动态跟踪，不砸壳', next: 'n4' }
             ]
           },
           n1: { label: '选A', terminal: true, verdict: 'bad',
             verdictTitle: '误判了故障类型：这是数据问题，不是工具问题',
             result: '<b>认知根源：把「输入是密文」当成了「工具不好用」。</b>反汇编器做的事情是「按指令集解释字节」。当字节是被 FairPlay 加密过的密文时，任何工具都只能解释出垃圾 —— Ghidra、Hopper、objdump 结果都一样。这个卡点之所以危险，是因为它<b>没有任何报错</b>：工具不崩、不提示，只是安静地给你错的结果。<b>识别信号</b>：函数数量异常少、大量字节无法反汇编、看不到常见的库函数调用点。看到这些，第一反应应该是去查 <code>LC_ENCRYPTION_INFO_64</code> 里的 <code>cryptid</code>。' },
           n2: { label: '选B', terminal: true, verdict: 'good',
             verdictTitle: '正确：识别出 FairPlay 加密，走砸壳流程',
             result: '<b>这是唯一能根治的做法。</b>推理链条是：磁盘上的 <code>__TEXT</code> 段是密文（<code>cryptid = 1</code>）→ 内核在加载 App 时用设备硬件密钥把它解密到内存 → 所以<b>内存里是明文</b> → 趁 App 运行时从内存把这段 dump 出来 → 把 <code>cryptid</code> 改成 0 → 重建文件结构，得到可静态分析的二进制。<b>三个动作缺一不可</b>：dump 拿内容、改标记改声明、重建修结构。少了重建，你得到的只是一段裸内存，工具仍然读不出正确的段布局。' },
           n3: { label: '选C', terminal: true, verdict: 'bad',
             verdictTitle: '只改了声明，没换内容',
             result: '<b>认知根源：把元数据当成了数据。</b><code>cryptid</code> 只是 Mach-O 头部里的一个标记位，它<b>不解密任何东西</b>。把它改成 0 之后文件内容<b>仍然是密文</b>，只是现在所有工具都被告知「这段已经是明文了」。后果分两种：静态工具按明文解释密文，得到更混乱的结果；如果这个文件被拿去运行，系统会直接执行密文导致崩溃。<b>正确的心智模型</b>：<code>cryptid</code> 是「这段数据的状态声明」，它必须和<b>真实内容状态</b>一致 —— 内容来自内存 dump（明文），声明才改成 0。' },
           n4: { label: '选D', terminal: true, verdict: 'bad',
             verdictTitle: '方向可行但代价被严重低估',
             result: '<b>认知根源：把「动态能跑」等同于「不需要静态」。</b>纯动态确实能在不砸壳的情况下观察行为，但你会同时失去：全局视野（不知道还有哪些地方做了同样的事）、交叉引用（改了一处，还有三处冗余校验等着你），以及最重要的<b>效率</b> —— 靠动态试错去定位一个被 OLLVM 混淆的校验函数，工作量比先砸壳再静态定位大一个数量级。<b>真实工作流是两者配合</b>：砸壳给静态分析提供可读的二进制，动态负责验证与绕过。而且有个反直觉的点：<b>Frida 能跑起来本身就说明设备已越狱</b> —— 环境都具备了，更没有理由跳过砸壳。' }
         }
       },

       after: '<p>把这一节压缩成一句话：<b>磁盘密文、内存明文，砸壳就是趁明文还在内存里时抄下来、再改掉声明。</b>现在你能读懂二进制了 —— 但 App 未必愿意让你安静地读。下一节讲它怎么反抗。</p>'
     },
     /* ================= 28.5 ================= */
     {
       h: '28.5',
       title: 'iOS 反调试：六种检测手法与它们的升级版',
       intuition: {
         tag: '直觉模型 · 猫鼠游戏的记分牌',
         body: '<p>把 iOS 反调试想成一场<b>没有终局的猫鼠游戏</b>，而不是一张「有解」的清单。</p>' +
           '<p>老鼠（逆向者）每次找到一个洞，猫（App）下个版本就在那个洞上补一层。所以真正要记住的不是「有哪几招」，而是<b>每一招的第一版长什么样、升级版长什么样</b> —— 因为教程里教的几乎总是第一版的破解法。</p>' +
           '<p>更关键的是：这些检测<b>大多不是独立工作</b>的。你绕过一处，另一处会举报你（进程退出 / 行为异常）。所以识别「总共有几处在检」比「绕过一处在检」重要得多。</p>'
       },
       html:
         '<p>反调试的检测点分布很有规律：<b>几乎全部集中在「我怎么知道自己被跟踪/被注入」这个问题上</b>。其中 <code>ptrace</code> 是最经典的一种，值得单独看。</p>' +

         T.note('key', '🔑 最经典的一招：ptrace(PT_DENY_ATTACH, 0, 0, 0)', '<p>调用之后<b>调试器无法附着</b>；如果进程<b>已经被附着</b>，则进程直接退出。这一招的狠处在于：它不需要知道谁在调试它，只需要宣布「我拒绝被调试」—— 由内核来执行这个拒绝。</p>' +
           '<p><b>反制</b>：hook <code>ptrace</code>，让它直接返回（根本不进内核）。<b>但升级版更难缠</b>：有些实现不调用 <code>ptrace</code> 这个库函数，而是用 <code>syscall(SYS_ptrace, 31, 0, 0, 0)</code> <b>直接发起系统调用</b>（<code>31</code> 是 <code>PT_DENY_ATTACH</code> 的值），绕过了对 <code>ptrace</code> 符号的 hook。</p>' +
           '<p><b>这和 SVC syscall 是同一思想</b>：不经过库函数封装，直接进内核。你 hook 的是库函数，而对方根本没走库函数 —— 这就是「绕不过符号 hook」的根源。</p>') +

         '<h4>其余五种检测</h4>' +
         '<p><b>② <code>sysctl</code> 检查 <code>P_TRACED</code></b>：通过 <code>sysctl</code> 查询自己的 <code>kinfo_proc</code> 结构，检查 <code>kp_proc.p_flag &amp; P_TRACED</code>。该标志被置位说明正在被调试。<b>反制</b>：hook <code>sysctl</code>，返回前把 <code>P_TRACED</code> 位清掉。</p>' +
         '<p><b>③ 检查 <code>getppid()</code></b>：正常启动时父进程是 <code>launchd</code>（PID 1）；被调试器启动时父进程是调试器。所以检查父进程是不是 <code>launchd</code>。</p>' +
         '<p><b>④ 代码签名校验（<code>csops</code>）</b>：用 <code>csops</code> 系统调用检查进程的 code signing flags，看是否有 <b><code>CS_DEBUGGED</code></b> 标志（表示被调试器附加过）。<b>反制</b>：hook <code>csops</code>，清掉 <code>CS_DEBUGGED</code>。</p>' +
         '<p><b>⑤ 检测 Frida</b>：扫描内存找 <code>frida</code>、<code>cycript</code>、<code>substrate</code>、<code>FridaGadget</code> 等字符串；检查特定端口；检测 <code>frida-server</code> 进程；检查 <code>DYLD_INSERT_LIBRARIES</code> 环境变量；遍历已加载动态库找可疑 dylib。</p>' +
         '<p><b>⑥ <code>ptrace</code> 变体</b>：有些 App 用<b>后台线程反复调用</b> <code>ptrace(PT_DENY_ATTACH)</code>，让你的 hook 难以持久生效 —— 你补上了，它下一轮又调。</p>' +

         T.note('bad', '❌ 越狱检测：和反调试是一套组合拳', '<p>越狱检测常和反调试绑定出现，因为「能注入」往往意味着「设备已越狱」。常见手法：检查常见越狱路径（<code>/Applications/Cydia.app</code>、<code>/bin/bash</code>、<code>/usr/sbin/sshd</code>、<code>/etc/apt</code>）、尝试写文件到系统目录、检查 <code>fork()</code> 是否可用（<b>沙盒内 App 不能 fork</b>，能 fork 说明沙盒被破了）、检查 URL scheme（<code>cydia://</code>）。</p>' +
           '<p><b>对逆向者的实际影响</b>：检测到之后不一定立刻退出 —— 更讨厌的是「静默降级」（功能变了但不说）或「延迟上报」。所以看到行为诡异时，先怀疑是不是触发了越狱检测分支，而不一定是你 hook 写错了。</p>'),

       stage: {
         title: '检测点 vs 绕过手段 · 以及每一招的升级版',
         speed: 1800,
         render:
           '<div class="flow-col">' +
             '<div class="flow-row">' +
               '<span class="blk" id="ad-t1">ptrace PT_DENY_ATTACH</span><span class="arrow">↔</span><span class="blk" id="ad-b1">hook ptrace 直接返回</span>' +
             '</div>' +
             '<div class="flow-row">' +
               '<span class="blk" id="ad-t2">sysctl 查 P_TRACED</span><span class="arrow">↔</span><span class="blk" id="ad-b2">hook sysctl 清 P_TRACED 位</span>' +
             '</div>' +
             '<div class="flow-row">' +
               '<span class="blk" id="ad-t3">getppid 是否为 launchd</span><span class="arrow">↔</span><span class="blk" id="ad-b3">hook getppid 返回 1</span>' +
             '</div>' +
             '<div class="flow-row">' +
               '<span class="blk" id="ad-t4">csops 查 CS_DEBUGGED</span><span class="arrow">↔</span><span class="blk" id="ad-b4">hook csops 清标志位</span>' +
             '</div>' +
             '<div class="flow-row">' +
               '<span class="blk" id="ad-t5">扫 frida / substrate 字符串</span><span class="arrow">↔</span><span class="blk" id="ad-b5">改名 / 隐藏端口 / 换注入方式</span>' +
             '</div>' +
             '<div class="flow-row">' +
               '<span class="blk" id="ad-t6">越狱路径 / fork / cydia://</span><span class="arrow">↔</span><span class="blk" id="ad-b6">hook 文件与 URL 检查</span>' +
             '</div>' +
             '<div class="flow-row">' +
               '<span class="pill" id="ad-up">升级版：syscall(SYS_ptrace, 31, ...) 直接进内核，绕过符号 hook</span>' +
             '</div>' +
             '<div class="term-box" id="ad-log">&gt; 等待开始…</div>' +
           '</div>',
         reset: () => {
           ['ad-t1', 'ad-b1', 'ad-t2', 'ad-b2', 'ad-t3', 'ad-b3', 'ad-t4', 'ad-b4', 'ad-t5', 'ad-b5', 'ad-t6', 'ad-b6']
             .forEach((i) => S(i, ''));
           CLS('ad-up', 'pill warn');
           SET('ad-log', '&gt; 等待开始…');
         },
         steps: [
           { run: () => S('ad-t1', 'hot'), note: '<b>检测①：ptrace(PT_DENY_ATTACH, 0, 0, 0)。</b>最经典的手法。调用后调试器<b>无法附着</b>；若已经被附着，进程直接退出 —— 这就是你「一 attach 上去 App 就闪退」的原因。' },
           { run: () => { S('ad-t1', 'done'); S('ad-b1', 'cool'); SET('ad-log', '&gt; hook ptrace → 直接返回，不调用内核'); }, note: '<b>绕过①：hook ptrace 让它直接返回。</b>要点是<b>不要真的调用原函数</b>。这也是反调试绕过的通用形状：与其让检测通过，不如让它<b>根本不执行</b>。' },
           { run: () => { CLS('ad-up', 'pill bad'); SET('ad-log', '&gt; ⚠️ 升级版：syscall(SYS_ptrace, 31, 0, 0, 0) —— 不经过 ptrace 符号'); }, note: '<b>⚠️ 升级版来了。</b>高级写法用 <code>syscall(SYS_ptrace, 31, 0, 0, 0)</code> 直接发起系统调用（<code>31</code> 即 <code>PT_DENY_ATTACH</code>），<b>完全绕过对 ptrace 符号的 hook</b>。<span class="hit">和 SVC syscall 是同一思想</span>：跳过库函数封装，直连内核。你 hook 的是库函数，而对方根本没走库函数。' },
           { run: () => { CLS('ad-up', 'pill'); S('ad-t2', 'hot'); }, note: '<b>检测②：sysctl 查 P_TRACED。</b>通过 <code>sysctl</code> 拿自己的 <code>kinfo_proc</code>，检查 <code>kp_proc.p_flag &amp; P_TRACED</code>。被调试时该位置位。<b>特点</b>：它不阻止附着，只是「发现」被附着 —— 所以它常用来触发后续动作（退出、降级、上报）。' },
           { run: () => { S('ad-t2', 'done'); S('ad-b2', 'cool'); SET('ad-log', '&gt; hook sysctl → 返回前清掉 P_TRACED 位'); }, note: '<b>绕过②：hook sysctl，返回前清 P_TRACED 位。</b>注意这是<b>改返回值</b>而不是阻止调用 —— 因为 kinfo_proc 是输出参数，你要在它写完之后、调用方读取之前动手。' },
           { run: () => { S('ad-t3', 'hot'); }, note: '<b>检测③：检查 getppid()。</b>正常启动时父进程是 <code>launchd</code>（PID 1）；通过调试器启动时父进程就是调试器。所以「父进程不是 launchd」= 可疑。' },
           { run: () => { S('ad-t3', 'done'); S('ad-b3', 'cool'); }, note: '<b>绕过③：hook getppid 让它返回 1。</b>简单直接。但它只是<b>六个检测点之一</b> —— 单独绕过它毫无意义，这也正是为什么「按清单逐个绕」的路线总会漏。' },
           { run: () => { S('ad-t4', 'hot'); }, note: '<b>检测④：csops 查 CS_DEBUGGED。</b>用 <code>csops</code> 系统调用读取进程的 code signing flags，看有没有 <code>CS_DEBUGGED</code>（表示曾被调试器附加过）。<b>它比 getppid 难缠</b>：即使你事后 detach，这个标志可能已经留下了痕迹。' },
           { run: () => { S('ad-t4', 'done'); S('ad-b4', 'cool'); }, note: '<b>绕过④：hook csops，清掉 CS_DEBUGGED。</b>手法与 sysctl 同理 —— 在返回值里抹掉标志位。注意 <code>csops</code> 也是系统调用，同样存在「直接 syscall 绕过符号 hook」的升级空间。' },
           { run: () => { S('ad-t5', 'hot'); }, note: '<b>检测⑤：找 Frida 的痕迹。</b>扫内存里的 <code>frida</code>、<code>cycript</code>、<code>substrate</code>、<code>FridaGadget</code> 字符串；检查特定端口；检测 <code>frida-server</code> 进程；检查 <code>DYLD_INSERT_LIBRARIES</code> 环境变量；遍历已加载动态库找可疑 dylib。' },
           { run: () => { S('ad-t5', 'done'); S('ad-b5', 'cool'); SET('ad-log', '&gt; 绕过⑤：改名 frida-server / 换非常规端口 / 改用 gadget 注入'); }, note: '<b>绕过⑤：这一条不是「hook 一下」能解决的。</b>因为检测对象是<b>你注入的方式本身</b>。应对手段偏工程：把 <code>frida-server</code> 改名、把默认端口换掉、或者干脆改用 frida-gadget 重打包注入（少一个独立进程和默认端口）。<b>代价是维护成本上升</b>，而且每次检测升级都要跟着改。' },
           { run: () => { S('ad-t6', 'hot'); }, note: '<b>检测⑥：越狱检测。</b>查 <code>/Applications/Cydia.app</code>、<code>/bin/bash</code>、<code>/usr/sbin/sshd</code>、<code>/etc/apt</code>；尝试写系统目录；测 <code>fork()</code> 能否成功（沙盒内不能 fork）；查 <code>cydia://</code> URL scheme。<b>它和反调试是组合拳</b>：越狱检测一旦命中，反调试常跟着一起上。' },
           { run: () => { S('ad-t6', 'done'); S('ad-b6', 'cool'); }, note: '<b>绕过⑥：hook 那些文件存在性/可写性检查与 URL 检查。</b>关键是<b>要覆盖全</b>：文件检测往往同时用多个 API（<code>stat</code>、<code>access</code>、<code>fopen</code>），只 hook 一个会漏。' },
           { run: () => { ['ad-b1', 'ad-b2', 'ad-b3', 'ad-b4', 'ad-b5', 'ad-b6'].forEach((i) => S(i, 'done')); SET('ad-log', '&gt; 结论：这不是清单，是持续的攻防博弈 —— 每次升级都要重测一遍全部检测点'); }, note: '<b>结论：把它当成博弈，而不是清单。</b>每一招都有升级版（最典型的是 <code>ptrace</code> 走 <code>syscall</code> 绕过符号 hook）；检测之间<b>互相备份</b>（绕了三个还剩三个）；还有后台线程反复调用 <code>ptrace</code> 这种「让你 hook 不持久」的打法。所以正确的工作方式是：<b>先数清楚总共有几处在检，再谈绕过</b>。' }
         ]
       },

       decision: {
         start: 'n0',
         nodes: {
           n0: {
             label: '情境三 · attach 上去就闪退',
             scenario: '<b>情境：</b>你写好了 Hook 脚本，<code>frida -U -f TargetApp</code> 一启动，App 界面闪一下就没了。去掉 <code>-f</code> 先手动打开 App 再 attach，情况稍好但很快也退出。你怀疑是脚本写错了。',
             choices: [
               { t: '把脚本逐行删掉，用二分法找出哪一行 Hook 导致崩溃', next: 'n1' },
               { t: '先怀疑反调试：用 spawn 模式尽早 attach，在启动阶段把 ptrace / sysctl / getppid / csops 等检测点挡住再继续', next: 'n2' },
               { t: '换一台设备或者换一个 Frida 版本重试，可能是兼容性问题', next: 'n3' },
               { t: '放弃 Hook，改用静态分析直接改二进制再重签名安装', next: 'n4' }
             ]
           },
           n1: { label: '选A', terminal: true, verdict: 'bad',
             verdictTitle: '方向错了：闪退不是脚本 bug，是反调试在起作用',
             result: '<b>认知根源：把「进程被主动杀死」误判为「我的代码有 bug」。</b>两者有明确的区分信号：脚本 bug 通常报 JS 异常、或者崩在某个具体调用上，控制台有堆栈；而反调试导致的退出<b>往往什么都没输出，进程安静消失</b>。本例中「一开就闪」「attach 后很快退出」正是 <code>ptrace(PT_DENY_ATTACH)</code> 的典型表现 —— 它拒绝被附着，且若已被附着就让进程退出。用二分法删脚本只会浪费大量时间，因为即使脚本为空，检测依然会命中。' },
           n2: { label: '选B', terminal: true, verdict: 'good',
             verdictTitle: '正确：先解决运行自由，再谈 Hook',
             result: '<b>核心思路是抢在检测生效之前把它挡住。</b>用 spawn 模式（而不是先启动再 attach）让进程<b>在你的控制下启动</b>，在最早的时机把 <code>ptrace</code>、<code>sysctl</code>（清 <code>P_TRACED</code>）、<code>getppid</code>、<code>csops</code>（清 <code>CS_DEBUGGED</code>）这些检测点一起挡住，检测就没机会触发。<b>顺序很重要</b>：一旦进程已经因检测而退出，后面所有 Hook 都无从谈起 —— 这就是「先运行自由，再可观测性」。<b>还要留心升级版</b>：如果对方用 <code>syscall(SYS_ptrace, 31, ...)</code> 直接进内核，hook <code>ptrace</code> 符号是无效的，需要往系统调用层或更早的位置去找。' },
           n3: { label: '选C', terminal: true, verdict: 'bad',
             verdictTitle: '把确定性问题当成环境问题',
             result: '<b>认知根源：用「换环境」代替「找原因」。</b>换设备、换版本确实能解决一部分兼容性问题，但本例的现象有非常明确的技术解释 —— <b>进程被反调试主动终止</b>，这在任何设备、任何 Frida 版本上都会发生。把时间花在重装环境上，等于赌一个不存在的原因。<b>正确的排查顺序</b>：先看现象特征（是否有报错、崩在哪一步）→ 若是「无输出即退出」，优先假设反调试 → 用 spawn + 早期拦截验证假设 → 假设成立后再处理环境细节。' },
           n4: { label: '选D', terminal: true, verdict: 'bad',
             verdictTitle: '用更贵的手段绕开问题，而不是解决问题',
             result: '<b>认知根源：遇到运行时阻碍就退回静态改包。</b>这条路在技术上行得通，但成本极高：你要先砸壳（否则改的是密文，见 28.4）、要在混淆过的二进制里定位检测代码、改完还要处理重签名与描述文件、而且每次 App 更新都要重做一遍。更关键的是，<b>反调试是本章后面所有内容的前置条件</b> —— SSL Pinning 绕过、算法定位、砸壳，全都要求你能把进程稳定地跑在调试器下。跳过这一关，等于把后面每一节都变成静态苦工。' }
         }
       },

       quiz: {
         id: 'q14-3', chapter: 14, answer: 2,
         stem: '某 App 用 <code>syscall(SYS_ptrace, 31, 0, 0, 0)</code> 而不是直接调用 <code>ptrace()</code> 来拒绝调试。你 hook 了 <code>ptrace</code> 符号并让它直接返回，结果 App 依然闪退。最可能的原因是：',
         options: [
           { t: '你的 hook 时机太晚，应该在更早的阶段 attach', why: '时机确实是常见的失败原因，但本例的现象有更直接的解释 —— 你的 hook 点根本不在调用路径上。' },
           { t: 'Frida 版本与目标 App 不兼容，导致 hook 未生效', why: '版本问题会表现为 hook 完全不工作或报错，而不是「精准地只漏掉这一个调用」。' },
           { t: 'App 直接发起系统调用，没有经过 <code>ptrace</code> 这个库函数，所以对符号的 hook 不会被触发', why: '正确。hook 库函数只在调用方走库函数时才生效；直接 syscall 绕过了这一层。' },
           { t: '<code>ptrace</code> 是不可 hook 的系统调用，Frida 对它无能为力', why: 'Frida 完全可以 hook 用户态的 <code>ptrace</code> 函数；问题从来不是「不能 hook」，而是「对方没走这条路」。' }
         ],
         explain: '<b>考的是「hook 的层级」这个容易被忽略的前提。</b>你 hook 的是<b>用户态的库函数</b> <code>ptrace()</code>，它内部封装了发起系统调用的动作（在 arm64 上通常是 <code>svc</code> 指令）。如果 App 调用这个库函数，你的 hook 必然命中。但如果 App 自己内联汇编或直接调用 <code>syscall()</code> 并传入 <code>SYS_ptrace</code>（<code>31</code> 即 <code>PT_DENY_ATTACH</code> 的值），那么执行路径<b>根本没经过你 hook 的那个函数</b>，你的回调自然不会被触发 —— 而内核收到的请求和正常调用一模一样，于是进程照样退出。这与前面章节讲的「绕过库函数封装、直接发起 SVC 系统调用」是同一个思想。应对方向：把拦截点下移到更底层（系统调用入口），或在更早的阶段用 spawn 模式介入，或从行为现象反推它到底走了哪条路。'
       },

       after: '<p>这一节的办法论只有一句：<b>先数清楚有几处在检，再动手绕；并且永远假设对手有升级版。</b>接下来进入实战里最常被卡住的一环 —— 抓不到包。</p>'
     },

     /* ================= 28.6 ================= */
     {
       h: '28.6',
       title: 'SSL Pinning 绕过：从握手校验点到 OLLVM 混淆的 libsscronet.so',
       intuition: {
         tag: '直觉模型 · 只认自家印章的信使',
         body: '<p>普通的 HTTPS 抓包，靠的是你往系统证书库里塞一张自签的根证书 —— 相当于给系统发了一张「通用通行证」，所有 App 都认。</p>' +
           '<p><b>SSL Pinning（证书绑定）</b>就是 App 明确宣布：<b>我不看系统证书库，我只认内置的那一张</b>。它把服务端证书或公钥（或其哈希）打包进自己身体里，握手时逐一比对。</p>' +
           '<p>后果：你的通用通行证在别的 App 上畅通无阻，在这个 App 上直接被拒。这也是为什么「装了 Charles 证书却还是抓不到包」——不是证书没装好，是对方根本不查系统证书库。</p>'
       },
       html:
         '<p><b>App 为什么要做这个？</b>两个理由，一手一防：<b>防中间人攻击</b>（这是正当理由），以及<b>防逆向者抓包分析接口</b>（这是我们要绕的）。理解前一个理由很重要 —— 它解释了为什么这个机制设计得相当扎实，不是随便 hook 一下就能全绕干净的。</p>' +

         '<h4>实现层面：iOS 常见的四种做法</h4>' +
         '<p><b>① <code>NSURLSession</code> 的 delegate 回调</b>：在 <code>URLSession:didReceiveChallenge:completionHandler:</code> 里做校验，最终调用 <code>SecTrustEvaluate</code> 或手动比对证书。</p>' +
         '<p><b>② AFNetworking</b>：设置 <code>securityPolicy.SSLPinningMode</code>（如 <code>AFSSLPinningModeCertificate</code> / <code>AFSSLPinningModePublicKey</code>）。</p>' +
         '<p><b>③ <code>NSURLConnection</code></b>：老 API 的 <code>connection:willSendRequestForAuthenticationChallenge:</code> 回调。</p>' +
         '<p><b>④ Native 层（OpenSSL / BoringSSL）</b>：绕过 ObjC 层，直接在 C/C++ 里做校验 —— <b>这也是最难绕的一层</b>。</p>' +

         T.note('warn', '⚠️ 通用绕过手段（按层级）', '<p><b>ObjC 层</b>：Hook <code>evaluateServerTrust:forDomain:</code> 把返回值改成 <code>YES</code>；让 <code>SecTrustEvaluate</code> 返回 <code>errSecSuccess</code>；用 <code>ObjC.implement</code> 直接替换方法实现。</p>' +
           '<p><b>Native 层</b>：Hook OpenSSL / BoringSSL 的校验函数。</p>' +
           '<p><b>系统级</b>：用 <code>SSL-kill-switch2</code> 之类的越狱插件（针对系统层面的校验）。</p>' +
           '<p><b>真正的难点不在「怎么改」，而在「找到校验点」</b> —— 尤其当它被 OLLVM 混淆、或者做了<b>多处冗余校验</b>（改了一处，还有另一处等着你）的时候。</p>') +

         T.note('key', '🔑 核心方法论：静态看不懂就动态跑', '<p>当代码被混淆到读不懂时，不要硬读。<b>去 hook 那些「校验必经之路」的库函数，从副作用反推逻辑。</b></p>' +
           '<p>思路是：无论上层怎么混淆，只要它最终要验证证书，就<b>大概率会调用某个成熟的密码学/SSL 库函数</b>。这些函数的符号是公开的、名字是固定的、不会被混淆。所以你可以：hook 常见的 SSL 校验函数，看<b>哪个真的被调用了</b>；被调用的那一个，就是你的突破口。</p>' +
           '<p><b>候选点（按 OpenSSL / BoringSSL 分）</b>：OpenSSL 的 <code>X509_verify_cert</code>、<code>SSL_CTX_set_verify</code>；BoringSSL 的 <code>SSL_CTX_set_custom_verify</code>。<b>定位到校验点之后</b>，hook 它让它恒返回成功（<code>X509_V_OK</code> 或 <code>1</code>）。</p>') +

         '<h4>课程案例：被 OLLVM 混淆的 libsscronet.so</h4>' +
         '<p>' + T.term('cronet', 'Chromium 的网络栈，被很多 App 用作底层网络库') + ' 是 Chromium 的网络栈；<b><code>libsscronet.so</code> 是字节跳动系对它的封装/定制版本</b>，被很多 App 用来做网络请求。它是一个 <b>native so</b>，所以它的 SSL Pinning <b>做在 C++ 层</b> —— 也就是说，ObjC 层的那套 hook 对它完全无效。</p>' +
         '<p>更麻烦的是：<b>这个 so 被 OLLVM 混淆了</b>。控制流被平坦化、插入虚假分支之后，你<b>没法直接静态找到校验函数</b>。这时候方法论就派上用场了：<b>① 先反混淆</b>（用 OLLVM 那一章的方法：D-810、HexRaysDeob，或动态 Trace）；<b>② 或者绕开静态分析，用动态 Trace 定位</b> —— 去 hook 上面那些常见的 SSL 校验函数，看哪个被调用；<b>③ 定位到校验点后</b>，hook 它让它恒返回成功。</p>' +
         '<p class="small muted">具体符号名以目标 so 的实际导入/导出表为准；不同版本的 <code>libsscronet.so</code> 内部结构差异较大，上面给出的是「候选函数类别」，不是固定答案。</p>',

       stage: {
         title: 'TLS 握手：证书校验发生在哪，三层绕过点各在哪',
         speed: 1900,
         render:
           '<div class="flow-col">' +
             '<div class="flow-row">' +
               '<span class="blk" id="sp-c1">ClientHello</span><span class="arrow">→</span>' +
               '<span class="blk" id="sp-c2">ServerHello</span><span class="arrow">→</span>' +
               '<span class="blk" id="sp-c3">Certificate（服务端证书链）</span><span class="arrow">→</span>' +
               '<span class="blk" id="sp-c4">★ 证书校验</span><span class="arrow">→</span>' +
               '<span class="blk" id="sp-c5">密钥交换 / 完成</span>' +
             '</div>' +
             '<div class="flow-row">' +
               '<span class="blk" id="sp-l1">① ObjC：delegate 回调 / SecTrustEvaluate</span>' +
             '</div>' +
             '<div class="flow-row">' +
               '<span class="blk" id="sp-l2">② AFNetworking：SSLPinningMode 与 evaluateServerTrust:forDomain:</span>' +
             '</div>' +
             '<div class="flow-row">' +
               '<span class="blk" id="sp-l3">③ Native：OpenSSL / BoringSSL（libsscronet.so · OLLVM 混淆）</span>' +
             '</div>' +
             '<div class="flow-row">' +
               '<span class="pill" id="sp-tr">动态 Trace：hook X509_verify_cert / SSL_CTX_set_verify / SSL_CTX_set_custom_verify</span>' +
             '</div>' +
             '<div class="term-box" id="sp-log">&gt; 等待开始…</div>' +
           '</div>',
         reset: () => {
           ['sp-c1', 'sp-c2', 'sp-c3', 'sp-c4', 'sp-c5', 'sp-l1', 'sp-l2', 'sp-l3'].forEach((i) => S(i, ''));
           CLS('sp-tr', 'pill');
           SET('sp-log', '&gt; 等待开始…');
         },
         steps: [
           { run: () => S('sp-c1', 'active'), note: '<b>握手第一步：ClientHello。</b>客户端发出支持的协议版本、密码套件列表等。这一步只是协商，还没到校验。' },
           { run: () => { S('sp-c1', 'done'); S('sp-c2', 'active'); }, note: '<b>ServerHello：服务端选定参数。</b>到这一步为止，双方还没验证对方身份 —— 而这正是中间人最容易插入的位置。' },
           { run: () => { S('sp-c2', 'done'); S('sp-c3', 'active'); }, note: '<b>服务端把证书链发过来。</b>这是即将被校验的对象。注意：抓包工具能解密流量，靠的就是在这一步插入自己的证书 —— 所以 <b>校验这一步，就是攻防的分界线</b>。' },
           { run: () => { S('sp-c3', 'done'); S('sp-c4', 'hot'); SET('sp-log', '&gt; ★ 证书校验：信任锚是谁？系统证书库，还是 App 内置的那一张？'); }, note: '<b>★ 校验点：整个抓包成败就在这里。</b>普通 App 用系统的信任锚（你的 Charles/mitmproxy 根证书就生效）；做了 <b>Pinning</b> 的 App 用<b>内置的</b>信任锚 —— 于是你的证书直接被拒，抓包失败。<span class="hit">记住这个位置，下面三层的绕过都是围着它转。</span>' },
           { run: () => { S('sp-c4', 'done'); S('sp-l1', 'hot'); }, note: '<b>绕过层级①（最容易）：ObjC 层。</b>典型是 <code>URLSession:didReceiveChallenge:completionHandler:</code> 回调，最终落到 <code>SecTrustEvaluate</code> 或手写比对。<b>手法</b>：hook <code>evaluateServerTrust:forDomain:</code> 返回 <code>YES</code>；或让 <code>SecTrustEvaluate</code> 返回 <code>errSecSuccess</code>；或用 <code>ObjC.implement</code> 换实现。' },
           { run: () => { S('sp-l1', 'done'); S('sp-l2', 'hot'); }, note: '<b>绕过层级②：AFNetworking。</b>校验由 <code>securityPolicy.SSLPinningMode</code> 决定（<code>AFSSLPinningModeCertificate</code> 比证书、<code>AFSSLPinningModePublicKey</code> 比公钥）。<b>手法</b>：hook <code>evaluateServerTrust:forDomain:</code> 改写返回值；或直接把 <code>SSLPinningMode</code> 相关的判断绕过。这类库调用集中、函数名固定，<b>是最好下手的一层</b>。' },
           { run: () => { S('sp-l2', 'done'); S('sp-l3', 'hot'); SET('sp-log', '&gt; ★ 难点：libsscronet.so 是 native so，上面的 ObjC hook 全部无效'); }, note: '<b>绕过层级③（最难）：Native 层。</b>OpenSSL / BoringSSL 直接在 C/C++ 里做校验 —— <b>ObjC 层的 hook 对它完全无效</b>，因为它压根不经过 ObjC。课程案例的 <code>libsscronet.so</code> 就在这一层，而且<b>被 OLLVM 混淆了</b>。' },
           { run: () => { S('sp-l3', 'done'); CLS('sp-tr', 'pill warn'); SET('sp-log', '&gt; 混淆后静态读不懂 → 不要硬读，改为 hook 校验必经之路看谁被调用'); }, note: '<b>关键转折：混淆让静态分析失效，就换动态。</b>核心是<b>找到校验点</b>。无论上层怎么混淆，要验证证书就<b>大概率会调用某个成熟的密码学/SSL 库函数</b> —— 这些函数符号固定、名字不会被混淆。' },
           { run: () => { CLS('sp-tr', 'pill acc'); SET('sp-log', '&gt; hook X509_verify_cert / SSL_CTX_set_verify / SSL_CTX_set_custom_verify → 看哪个被调用'); }, note: '<b>候选点清单（按库分）。</b><b>OpenSSL</b>：<code>X509_verify_cert</code>、<code>SSL_CTX_set_verify</code>；<b>BoringSSL</b>：<code>SSL_CTX_set_custom_verify</code>。做法是<b>全都挂上、只看谁被调用</b> —— 被调用的那个就是你的突破口。<span class="small muted">符号以目标 so 的实际导入/导出表为准。</span>' },
           { run: () => { CLS('sp-tr', 'pill ok'); SET('sp-log', '&gt; 定位成功 → hook 该点让其恒返回成功（X509_V_OK 或 1）'); }, note: '<b>定位到之后就好办了：hook 它，让它恒返回成功</b>（<code>X509_V_OK</code> 或 <code>1</code>）。这就是 28.3 里 <code>retval.replace()</code> 那一行的价值 —— 绕过类需求的落地动作永远是这个。' },
           { run: () => { SET('sp-log', '&gt; ⚠️ 仍然抓不到包？检查冗余校验：改了一处还有另一处'); S('sp-l1', 'hot'); S('sp-l3', 'hot'); }, note: '<b>⚠️ 最常见的失败原因：冗余校验。</b>如果改了一处还是抓不到包，多半是<b>同时存在多处校验</b>（ObjC 一处、native 一处，或者同一层写了两遍）。<b>排查思路</b>：把三个层级的候选点<b>全部挂上日志</b>，看还有谁在调用 —— 直到所有校验收敛到你手里。' }
         ]
       },

       quiz: {
         id: 'q14-4', chapter: 14, answer: 1,
         stem: '目标 App 的 SSL Pinning 实现在 <code>libsscronet.so</code> 里，该 so 被 OLLVM 混淆。你已经 hook 了 ObjC 层的各校验回调并让它恒返回成功，但抓包仍然失败。下一步最该做的是：',
         options: [
           { t: '继续在 ObjC 层找漏掉的回调，把所有相关方法都 hook 一遍', why: '如果校验根本没走 ObjC 层，在 ObjC 层再找也是徒劳 —— 这也解释不了「已经全部返回成功却仍然失败」。' },
           { t: '用动态 Trace 挂上 native 层的候选校验函数（OpenSSL 的 <code>X509_verify_cert</code> / <code>SSL_CTX_set_verify</code>、BoringSSL 的 <code>SSL_CTX_set_custom_verify</code>），看哪个真的被调用，再针对它改写返回值', why: '正确。混淆让静态定位失效，但库函数的调用路径是绕不开的 —— 从副作用反推逻辑。' },
           { t: '先把 so 完整反混淆（D-810 / HexRaysDeob 跑一遍），在还原后的伪代码里找出校验函数再动手', why: '方向本身没错，是正路之一，但作为「下一步」代价偏高：反混淆需要时间和运气，而你只要知道哪个函数被调用就够了。' },
           { t: '放弃抓包，改用后端返回的数据做静态推断接口格式', why: '代价被严重低估：接口格式、签名算法、参数含义都拿不到，等于放弃了这一层最直接的信息来源。' }
         ],
         explain: '<b>考的是「静态看不懂就动态跑」这个方法论。</b>当你已经在 ObjC 层做到极致却仍然失败，问题一定在<b>另一个层级</b> —— <code>libsscronet.so</code> 是 native so，它的校验写在 C++ 里，根本不经过 ObjC 运行时，所以 ObjC hook 再全也无效。<b>为什么动态 Trace 是首选</b>：OLLVM 混淆的是<b>控制流</b>（平坦化、虚假分支），它<b>无法混淆库函数的符号名</b>。所以只要目标要验证证书，就有很大概率调用到某个成熟的 SSL 库函数，而这些名字是公开固定的。你不需要读懂混淆后的代码，只需要挂上候选点看<b>谁被调用</b> —— 被调用的那个就是突破口，然后让它恒返回成功（<code>X509_V_OK</code> 或 <code>1</code>）。<b>反混淆是另一条正路</b>，但它更适合「需要理解完整逻辑」的场景；单纯为了绕过，动态定位的性价比高得多。<b>最后别忘了冗余校验</b>：定位到一处之后如果仍然失败，说明还有第二处，继续用同样的方法把剩下的都找出来。'
       },

       after: '<p>把这一节的方法论记牢：<b>混淆提升的是「读代码」的成本，不提升「观察行为」的成本。</b>所以对绕过类需求，动态永远比静态便宜。下一节回到砸壳，看 Frida-iOS-dump 这件事本身做得有多讲究。</p>'
     },
     /* ================= 28.6L 动手实验 ================= */
     {
       h: '28.6L', title: '动手实验：规划 iOS 反调试的绕过方案',
       html:
         '<p>iOS 的反调试手段种类不多，但有一个特点：<b>对手也在升级</b>。' +
         '最典型的是"你用 hook 绕过 ptrace，他改成内联 SVC 直接调"。这个实验让你体会这层博弈。</p>',
       lab: {
         title: '实验：iOS 反调试检测与绕过配对',
         goal: '目标：找出最难绕的那一项',
         intro:
           '<p>目标 App 用了 6 种反调试手段。下面有 6 种绕过方案，' +
           '<b>勾选你要启用的</b>，系统会告诉你哪些检测被绕过、哪些还生效。</p>' +
           '<p><b>任务：① 全部绕过需要几种方案？② 哪一项最难绕，为什么？</b></p>' +
           '<p class="small muted">输入格式：把方案编号用空格分隔，例如 <code>1 2 4</code>。' +
           '也可以写关键词（<code>ptrace</code>、<code>sysctl</code>、<code>svc</code>）。</p>',
         inputs: [
           { key: 'pick', label: '① 你要启用的绕过方案（填编号 1-6）',
             hint: '1=hook ptrace 2=hook sysctl 3=hook getppid 4=hook csops 5=改名 Frida 6=内核级 hook/patch SVC',
             ph: '例如 1 2 3', value: '1' },
           { key: 'hard', label: '② 哪一项最难绕？为什么？',
             hint: '想想：如果对方不调用 libc 函数，你 hook 符号还有用吗？', ph: '我认为是……因为……', type: 'textarea', rows: 2 }
         ],
         runLabel: '🔍 推演绕过覆盖度',
         autorun: true,
         run: (v) => {
           const L = window.LABX;
           const nums = String(v.pick || '').match(/\d+/g) || [];
           const kw = String(v.pick || '').toLowerCase();
           const byIdx = nums.map(n => L.IOS_OPTIONS[parseInt(n, 10) - 1]).filter(Boolean);
           const byKw = L.IOS_OPTIONS.filter(o => kw.includes(o.id.split('-')[1] || '###'));
           const enabled = [...new Set([...byIdx, ...byKw].map(o => o.id))];

           const sweep = L.iosSweep(enabled);
           const blocked = sweep.filter(d => d.blocked).length;

           let html = '<div class="lab-kv"><span>已启用 <b>' + enabled.length + '</b> 种方案</span>'
             + '<span>绕过 <b>' + blocked + '</b> / ' + sweep.length + ' 项检测</span>'
             + '<span>剩余 <b>' + (sweep.length - blocked) + '</b></span></div>';

           html += '<table class="lab-tbl"><tr><th>反调试手段</th><th>状态</th><th>说明 / 需要的方案</th></tr>';
           sweep.forEach(d => {
             html += '<tr class="' + (d.blocked ? 'same' : 'diff') + '">'
               + '<td><b>' + d.name + '</b></td>'
               + '<td>' + (d.blocked ? '✅ 已绕过' : '❌ 仍生效') + '</td>'
               + '<td style="font-size:12px">' + d.why
               + (d.blocked ? '' : '<br><b>需要：</b>' +
                   (L.IOS_OPTIONS.find(o => o.id === d.bypass) || {}).name)
               + '</td></tr>';
           });
           html += '</table>';

           if (blocked === sweep.length) {
             html += '<div class="lab-msg pass"><b>✅ 全部绕过（用了 ' + enabled.length + ' 种方案）</b>'
               + '<div class="lab-note">注意最后一项 <b>内联 SVC</b> —— 它必须用'
               + '<b>内核级 hook 或 patch 指令本身</b>才能解决，普通 Frida 的符号 hook 对它完全无效。<br>'
               + '这就是 iOS 反调试对抗的<b>升级路径</b>：<br>'
               + '<code>hook ptrace</code> → 对手改用 <code>syscall(SYS_ptrace)</code> 绕过符号 hook → ' +
               '你只能下沉到内核层。</div></div>';
           } else {
             html += '<div class="lab-msg warn"><b>还有 ' + (sweep.length - blocked) + ' 项生效</b>'
               + '<div class="lab-note">特别留意 <b>内联 SVC</b> 那一项：'
               + '它不是普通的 ptrace 调用，而是<b>自己设置寄存器后直接发 SVC 指令</b>，'
               + '根本不经过 libc。所以 <code>Interceptor.attach(ptrace)</code> 看不到它。<br>'
               + '要解决它，必须<b>内核级 hook</b>（hook 系统调用表）或<b>直接 patch 那条 SVC 指令</b>。</div></div>';
           }

           html += '<div class="lab-msg key"><b>🔑 从实验看 iOS 对抗的特点</b>'
             + '<div class="lab-note">iOS 的反调试手段数量不多（就这么几种），但有一条清晰的<b>军备竞赛路径</b>：<br><br>'
             + '<b>第一代</b>：直接调 <code>ptrace(PT_DENY_ATTACH)</code> → 你 hook <code>ptrace</code> 就行<br>'
             + '<b>第二代</b>：查 <code>sysctl</code> / <code>getppid</code> / <code>csops</code> → 你逐个 hook<br>'
             + '<b>第三代</b>：<b>内联 SVC 绕过所有符号 hook</b> → 只能下沉到内核<br><br>'
             + '<span class="hit">注意这条路径和第 27 章（Android 的 SVC 绕过）<b>完全同构</b>——' +
             '平台不同，但对抗的演进逻辑一模一样：' +
             '<b>当上层被堵住，就往更底层走。</b></span></div></div>';
           return html;
         },
         expected: (v) => {
           const L = window.LABX;
           const nums = String(v.pick || '').match(/\d+/g) || [];
           const enabled = nums.map(n => L.IOS_OPTIONS[parseInt(n, 10) - 1]).filter(Boolean).map(o => o.id);
           const sweep = L.iosSweep([...new Set(enabled)]);
           const blocked = sweep.filter(d => d.blocked).length;
           const hard = String(v.hard || '').trim();
           const hitSvc = window.AKKC_hasConcept(hard, ['svc', '内联', '系统调用', 'syscall', '内核', '不经过 libc', '直接调用']);
           const ok = blocked === sweep.length && hitSvc;
           return {
             ok,
             detail: ok
               ? '<b>全对。</b>全部绕过需要 6 种方案；最难的是<b>内联 SVC</b> —— ' +
                 '它不经过 libc，符号 hook 完全无效，必须下沉到内核层。'
               : (blocked < sweep.length
                   ? '<b>还有 ' + (sweep.length - blocked) + ' 项没绕过。</b>' +
                     '要全覆盖需要 6 种方案全上。最难那一项是<b>内联 SVC</b>。'
                   : '<b>覆盖度够了，但"最难项"回答得不到位。</b>' +
                     '正确答案是<b>内联 SVC</b>：它绕过 libc 直接发系统调用，' +
                     '所以 hook <code>ptrace</code> 符号根本拦不住它，只能内核级 hook 或 patch 指令。')
           };
         },
         showAnswer:
           '【① 全部绕过需要 6 种方案】\n\n' +
           '  ptrace(PT_DENY_ATTACH)    ← hook ptrace 直接返回 0\n' +
           '  sysctl 查 P_TRACED        ← hook sysctl，返回前清标志位\n' +
           '  getppid() 不是 launchd    ← hook getppid 返回 1\n' +
           '  csops 查 CS_DEBUGGED      ← hook csops 清标志\n' +
           '  扫描 Frida 特征字符串      ← 重命名相关文件/端口\n' +
           '  内联 SVC 直接调 ptrace     ← 内核级 hook 或 patch SVC 指令 ★\n\n' +
           '【② 最难绕的是「内联 SVC」】\n\n' +
           '  原因：它【不经过 libc】，而是自己设置寄存器后直接执行 SVC 指令。\n' +
           '        所以 Frida 的 Interceptor.attach(ptrace) 完全看不到这次调用——\n' +
           '        因为 ptrace 这个符号根本没被使用。\n\n' +
           '  解法只有两条：\n' +
           '    ① 内核级 hook（hook 系统调用表 / 用内核模块）\n' +
           '    ② 直接 patch 掉那条 SVC 指令（改成 NOP 或直接返回）\n\n' +
           '【iOS 反调试的军备竞赛路径】\n' +
           '  第一代：直接调 ptrace          → hook 符号即可\n' +
           '  第二代：查 sysctl/getppid/csops → 逐个 hook\n' +
           '  第三代：内联 SVC 绕过符号 hook  → 只能下沉到内核\n\n' +
           '  注意：这条路径与第 27 章（Android 的 SVC 绕过）完全同构。\n' +
           '        平台不同，但对抗逻辑一致：\n' +
           '        【当上层被堵住，就往更底层走】。',
         hint:
           '先把 6 项检测和 6 种方案一一对应上。<br><br>' +
           '然后重点想第②问：<b>其中有一项检测，它不是"调用某个函数"，而是"直接执行一条 CPU 指令"</b>。<br>' +
           '对于这种检测，你 hook 函数符号还有用吗？<br><br>' +
           '回忆第 27 章讲过的：App 怎么绕过 Frida 对 libc 的 hook？',
         after:
           T.note('key', '🔑 跨平台的一条共同规律',
             '<p style="margin-bottom:0">你可能已经发现：这个实验的结论和第 27 章几乎一样。<br><br>' +
             '<b>Android</b>：App 用内联 <code>SVC</code> 绕过 Frida 对 libc 的 hook<br>' +
             '<b>iOS</b>：App 用内联 <code>SVC</code> 绕过 Frida 对 ptrace 的 hook<br><br>' +
             '同一招，同一原理，同一个应对方式（下沉到内核）。<br><br>' +
             '<span class="hit">这就是本课程反复强调的元原则：' +
             '<b>机制层面的规律是跨平台通用的。</b>' +
             '你不需要分别背"Android 反调试清单"和"iOS 反调试清单"——' +
             '理解"符号 hook 只能拦到调用函数的那条路"这一个原理，' +
             '两个平台的答案就都出来了。</span></p>')
       }
     },
     /* ================= 28.7C 实战案例 ================= */
     {
       h: '28.7C', title: '实战案例：中国移动 App 的加解密事件捕获',
       case: {
         source: 'kanxue',
         title: '中某某动APP算法AI分析-一句话全自动分析网络请求和加密算法',
         date: '2026-9-14',
         author: '太岁又沐风',
         target: '中国移动 App cn.10086.app（iOS 16.7.15 / rootless ElleKit）；三网一键登录 / UAM 组件',
         background:
           '<p>2026 年的一篇看雪帖。目标是中国移动 App（<code>cn.10086.app</code>），运行在 <b>iOS 16.7.15</b> 上，' +
           '越狱环境是 <b>rootless 的 ElleKit</b>；要分析的是“三网一键登录 / UAM 组件”这条链路。</p>' +
           '<p>这篇帖子代表了一种新的工作方式：作者几乎没有手工逆任何东西，而是<b>用一句话驱动 AI（Codex）</b>，' +
           '由它调用一个跑在越狱设备上的加解密事件捕获工具，把运行时的所有密码学调用记录下来，再自动产出分析报告——' +
           '全程 <b>9 分 18 秒</b>。</p>' +
           '<p>需要预先说明的是：<b>作者正文只有 4 个步骤标题加一句总结，技术内容全部在 7 张截图里</b>，' +
           '下面这些数据是从截图中读出来的。</p>',
         points: [
           '越狱环境：Sileo 添加越狱源后安装 <code>IOSDecryptHub 1.25.3</code>，这是整套流程的数据来源。',
           'MCP 集成：<code>pip install ios-decrypt-hub</code> 装客户端，<code>idh connect 192.168.200.162:8088</code> 连设备；配置写成 <code>{"mcpServers":{"idh":{"command":"idh","args":["mcp"]}}}</code>（<b>仅限可信网络</b>）。',
           '悬浮面板给出实时统计：<code>总 2899 / 运行 787 / 加解密 0 / 对称 268 / RSA 0 / 序列 1482</code>。',
           'Web 面板分页签统计：<code>加解密 1055 / 序列 1543 / 网络 126 / Keychain 27 / 文件 / 符号 / Dump</code>。',
           '事件条目直接带算法名，例如 <code>AES-128-CBC-PKCS7</code>、<code>AES-128-ECB-PKCS7</code>、<code>MD5</code>——不需要你再去猜它是哪种模式。',
           '单条事件可以下钻到密钥与 IV：<code>#2688 AES-128-CBC-PKCS7 decrypt</code>，KEY(16B)=<code>5259563080435c31b6c563235d49564a</code>，IV(16B)=<code>566a465351315a74566b517852546c51</code>，96B 密文 → 84B 明文。',
           '目标请求：<code>POST https://client.app.coc.10086.cn/biz-orange/LN/uamthreenetworklogin/login</code>，请求头带 <code>x-sign</code> / <code>x-token</code> / <code>xs</code> / <code>x-nonce</code> / <code>x-qen</code>。',
           '最终结论：<b>无非对称加密</b>（asym event=0，全流程没有 RSA / SM2），方案是 <b>AES-128 双层（CBC + ECB）+ 双重 MD5 签名 + 硬编码外层密钥 + 动态会话密钥</b>。'
         ],
         method: [
           '在 rootless 越狱设备上装好 <code>IOSDecryptHub 1.25.3</code>，把密码学调用捕获能力部署到运行时。',
           '用 <code>pip install ios-decrypt-hub</code> 装好客户端，<code>idh connect 192.168.200.162:8088</code> 连上设备（仅在可信网络里做）。',
           '把工具注册成 MCP server 接进 Codex：<code>{"mcpServers":{"idh":{"command":"idh","args":["mcp"]}}}</code>。',
           '用一句话让 AI 自主完成分析：先看悬浮面板的全局统计，再从 Web 面板的页签里筛出加解密与网络事件。',
           '顺着目标请求（<code>uamthreenetworklogin/login</code>）回溯相关事件，逐条下钻到密钥与 IV，确认算法模式与数据长度变化。',
           '汇总成结论：哪些是对称、有没有非对称、签名是怎么叠的、密钥是硬编码还是动态协商。'
         ],
         result:
           '<p>AI 在 <b>9 分 18 秒</b>内产出了一份报告，结论是：这个登录链路<b>完全没有非对称加密</b>' +
           '（asym event = 0，没有 RSA / SM2），而是 <b>AES-128 双层加密（CBC + ECB）+ 双重 MD5 签名</b>，' +
           '密钥结构是<b>硬编码的外层密钥 + 动态会话密钥</b>。</p>' +
           '<p>整条链路上最关键的那块拼图——<code>#2688</code> 那条 <code>AES-128-CBC-PKCS7 decrypt</code> 事件，' +
           '直接给出了 KEY、IV、密文长度和明文长度，这些都是传统流程里要靠 hook 一点点试出来的东西。</p>',
         terms: ['IOSDecryptHub', 'ElleKit（rootless）', 'MCP', 'idh connect', 'AES-128-CBC-PKCS7', 'AES-128-ECB-PKCS7', 'x-sign', 'Keychain', '会话密钥'],
         limits:
           '<p>这篇帖子的局限必须如实标注，因为它比较特殊：</p>' +
           '<p>① <b>作者正文只有 4 个步骤标题 + 一句总结，技术内容全在 7 张截图里</b>，上面所有数据都由读图提取。' +
           '正文<b>没有任何失败尝试，也没有任何限制说明</b>——这本身就是一个信号。</p>' +
           '<p>② AI 的输出留下了 <b>3 个未闭合项</b>：<b>密钥来源</b>（是 keychain 还是初始化时生成）、<b><code>xk</code> 是怎么生成的</b>、以及<b>这套 SDK 的归属</b>。</p>' +
           '<p>③ <b>越狱源地址是图片形式，不可读</b>，无法照抄复现。</p>' +
           '<p>④ 整个结论的可信度，最终取决于那个捕获工具本身是否正确——而这一点帖子里没有独立验证。</p>',
         analysis:
           '<p><b>这是第 28 章“iOS 逆向工具链”的当代形态展示。</b>本章讲的工作流是“越狱拿权限 → 砸壳拿明文 → 绕反调试 → 抓包 → 定位算法”，' +
           '而这个案例展示的是：<b>当工具足够强时，其中好几步可以被折叠掉。</b></p>' +
           '<p><b>第一层，越狱环境与 rootless 的变化。</b>作者用的是 <b>ElleKit</b>——rootless 越狱下的 hook 框架，' +
           '而不是老式 Cydia Substrate 时代的那一套。这正好印证本章反复强调的时效性警告：' +
           '<span class="hit"><b>越狱工具的支持矩阵变化很快，任何教程（包括本章）里的路径与工具名都可能过期，一切以官方仓库当期状态为准。</b></span>' +
           '本章 28.1 讲过的“无根越狱下 <code>/usr/sbin/</code> 这类路径可能根本不存在”，在这个案例里就是默认前提。</p>' +
           '<p><b>第二层，“加解密事件捕获”这类工具改变了 iOS 逆向的工作方式。</b>' +
           '传统流程是“砸壳 → 静态分析 → 定位算法 → hook 验证”，重心在<b>逆向</b>；' +
           '而这个工具直接在运行时把<b>每一次加解密的算法名、密钥、IV、明文长度</b>都记录下来，' +
           '工作重心于是从“逆向”转移到了“<b>读日志</b>”。' +
           '<span class="hit">这提醒我们：工具越强，人越要清楚<b>自己到底在解决哪一类问题</b>——是“不知道用了什么算法”，还是“不知道密钥从哪来”。</span>' +
           '前者正在被工具迅速商品化，后者没有。</p>' +
           '<p><b>第三层，注意 Keychain 页签的存在。</b>Web 面板里有一个独立的 <b>Keychain</b> 页签（27 条），' +
           '它本身就是一个提示：<b>密钥可能来自 Keychain，而不是硬编码在二进制里</b>。' +
           '而 AI 报告恰恰把“密钥来源”列为了未闭合项之一。' +
           '<span class="hit">工具能告诉你“用了什么算法、密钥是什么”，但“<b>密钥从哪来、怎么生成</b>”往往仍然需要人工去追——' +
           '因为那属于业务逻辑，不是密码学调用的范畴。</span>' +
           '密码学 API 是通用的、模式固定的，所以能被自动识别；而密钥派生逻辑是这家公司自己写的，没有模式可循。</p>',
         link: 'https://bbs.kanxue.com/thread-292939.htm',
         linkNote: '看雪论坛原创帖'
       }
     },

     /* ================= 28.7 ================= */
     {
       h: '28.7',
       title: 'Frida-iOS-dump 核心原理赏析：为什么「重建」比「dump」难',
       html:
         '<p>28.4 已经把砸壳的一句话讲完了：<b>dump 内存里的明文，把 <code>cryptid</code> 改成 0</b>。但真正动手写一遍，你会发现最难的既不是 dump 也不是改标记，而是<b>「重建」</b>。这一节拆开看为什么。</p>' +

         T.note('key', '🔑 一句话原理', '<p><b>App Store 应用被 FairPlay DRM 加密，磁盘上的 <code>__TEXT</code> 是密文；进程运行时内核已把它解密到内存。Frida-iOS-dump 就是在运行时从内存 dump 解密后的二进制，并把它修回一个可用的 Mach-O。</b></p>') +

         '<h4>① 为什么要遍历「已加载的镜像」</h4>' +
         '<p>进程内存里不是只有主二进制。还有大量系统库、框架、以及 App 自带的其它 ' + T.term('Mach-O 镜像', '进程地址空间里一个已加载的可执行文件或动态库') + '。每个镜像都有自己的头部与 <code>LC_ENCRYPTION_INFO_64</code>。所以第一步是<b>列出进程的所有模块</b>，让用户选目标 —— 而不是盲目地对整块内存开刀。</p>' +

         '<h4>② 为什么「找到加密的段」要读 load command</h4>' +
         '<p>内存里同一个镜像的段有多个（<code>__TEXT</code>、<code>__DATA</code>、<code>__LINKEDIT</code> …），各自权限不同（可执行、可读写）。<b>哪一段是被加密的那一段，只有 load command 知道</b> —— 靠 <code>cryptoff</code> / <code>cryptsize</code> 确定的区间去对应。这也解释了为什么「砸壳」工具的核心能力其实是<b>解析 Mach-O</b>，dump 只是最后一步搬运。</p>' +

         '<h4>③ 为什么 dump 出来的不能直接当文件用</h4>' +
         '<p>这是整件事最容易被低估的地方。从内存里读到的是一段<b>连续字节</b>，而一个可用的 Mach-O 文件还需要正确的：<b>段在文件中的偏移</b>、<b>各段的大小与对齐</b>、<b>头部里的字段一致性</b>。内存布局与文件布局<b>本来就不一样</b>（内存按页对齐、有权限粒度），所以必须把内存布局「翻译」回文件布局 —— 这就是<b>重建</b>。</p>' +

         T.note('warn', '⚠️ 三种典型失败，症状各不相同', '<p><b>a. 只改 <code>cryptid</code> 没换内容</b> → 工具按明文解释密文，越看越乱；拿去运行则直接崩溃。</p>' +
           '<p><b>b. dump 了但没重建</b> → 文件结构不对，工具读不出段布局，或加载即失败。</p>' +
           '<p><b>c. dump 范围错了</b>（没按 <code>cryptoff</code>/<code>cryptsize</code>，或漏了别的加密段）→ 部分函数正常、部分仍然是垃圾，<span class="miss">这种最难查</span>，因为症状是「看起来能用，但某些函数反汇编不出来」。</p>') +

         '<h4>④ 它不解决什么（预期管理）</h4>' +
         '<p>Frida-iOS-dump 这类工具解决的是<b>「拿到明文二进制」</b>。它<b>不</b>解决：符号被抹掉（你还是看到一堆 <code>sub_XXXX</code>）、<b>OLLVM 混淆</b>（28.6 的 <code>libsscronet.so</code> 就是）、Swift 名字被 mangle、以及 DRM 之外的其它保护。<b>所以别把砸壳当成逆向的里程碑，它只是入场券。</b></p>' +
         '<p class="small muted">本工具的具体内部函数名、参数与脚本使用方式，以仓库当期 README 与源码为准 <span class="pill warn">待核实</span>；本节讲的是可验证的原理框架，不是它的 API 文档。</p>',

       stepper: {
         title: '砸壳流水线：从遍历镜像到产出可分析文件',
         lines: [
           { code: '<span class="c">// 伪代码：示意流程，非某个工具的真实 API</span>\n<span class="f">enumerate_modules</span>(process);',
             note: '<b>第一步：列出进程里所有已加载的模块。</b>内存里有很多 Mach-O 镜像，主二进制只是其中之一。<b>为什么要列</b>：每个镜像的加密信息独立，你只能逐个判断，不能对整块内存一刀切。',
             state: { '模块数': '主二进制 + 系统库 + 框架' } },

           { code: '<span class="k">foreach</span> (image : modules) <span class="f">parse_macho_header</span>(image);',
             note: '<b>第二步：逐个解析 Mach-O 头部与 load command。</b>这是整个工具真正的技术含量所在 —— 砸壳工具的核心其实是 <b>Mach-O 解析器</b>，不是内存搬运工。',
             state: { '关键字段': 'LC_ENCRYPTION_INFO_64' } },

           { code: '<span class="k">if</span> (enc.cryptid == <span class="n">1</span>) { <span class="c">/* 这段在磁盘上是密文 */</span> }',
             note: '<b>第三步：靠 <code>cryptid</code> 判断要不要处理。</b><code>cryptid == 1</code> 说明该镜像的对应区间在磁盘上被加密 —— 只有这种镜像才需要砸壳。系统库通常已经是明文，跳过。',
             state: { 'cryptid': '1 → 需要处理' } },

           { code: '<span class="k">var</span> off  = enc.cryptoff;   <span class="c">// 文件偏移</span>\n<span class="k">var</span> size = enc.cryptsize;  <span class="c">// 加密大小</span>',
             note: '<b>取出 cryptoff / cryptsize。</b>这两个字段定义了要搬运的区间。注意它们描述的是<b>文件偏移</b>，而你面对的是内存 —— 中间需要按段的内存地址映射换算，这正是「布局不一样」带来的第一处麻烦。',
             state: { 'cryptoff': '0x4000', 'cryptsize': '0xBC614E' } },

           { code: '<span class="k">var</span> plain = <span class="f">read_memory</span>(base + off, size);',
             note: '<b>第四步：从内存读明文。</b>此刻读到的<b>已经是解密后的内容</b> —— 内核在加载时就解好了。这就是「必须运行时 dump」的全部原因：这个窗口只在 App 运行期间存在。',
             state: { '数据状态': '明文 ✓' } },

           { code: '<span class="k">var</span> out = <span class="f">clone_file_layout</span>(image);',
             note: '<b>第五步：以原文件为骨架，准备写回。</b>内存布局与文件布局不同（内存按页对齐、还有权限粒度），所以要按<b>文件的</b>布局来组织输出，而不是把内存原样倒出来。',
             state: { '骨架': '来自原始 ipa 内的二进制' } },

           { code: '<span class="f">write_segment</span>(out, plain, off);',
             note: '<b>第六步：把明文写回对应的文件偏移。</b>注意是「按 <code>cryptoff</code> 写回原位」，其它没有加密的段保持原样 —— 这样重建出来的文件才和原始结构一致。',
             state: { '写回位置': 'cryptoff 处' } },

           { code: 'out.encryption_info.cryptid = <span class="n">0</span>;',
             note: '<b>第七步：把 <code>cryptid</code> 改成 0。</b>这不是解密，只是<b>改声明</b>：告诉后续所有工具「这段已经是明文了，别再当密文处理」。<span class="miss">必须和真实内容状态一致</span> —— 内容换了才改标记。',
             state: { 'cryptid': '1 → 0' } },

           { code: '<span class="f">fix_offsets_and_sizes</span>(out);',
             note: '<b>第八步：修正段偏移、大小、对齐等头部字段。</b>这是「重建」的实质，也是最容易出问题的一步。<b>为什么必须做</b>：文件头里记录的是文件布局信息，而你的数据来自内存，两套布局不换算就会得到一个「看着像 Mach-O、实际加载失败」的文件。',
             state: { '校验': '段偏移 / 大小 / 对齐' } },

           { code: '<span class="f">save</span>(out, <span class="s">"TargetApp.decrypted"</span>);',
             note: '<b>第九步：产出文件。</b>现在这个二进制可以丢进 IDA / Ghidra 了。回顾一下：<b>dump 拿到内容、改标记改声明、重建修结构</b> —— 三件事缺一不可。',
             state: { '产物': '明文 Mach-O' } },

           { code: '<span class="c">// 砸壳之后：符号被抹掉、OLLVM 混淆、Swift 名字 mangle 依然存在</span>',
             note: '<b>最后一行提醒，也是最重要的一行。</b>砸壳只把「看不见」变成「看得见」，不把「看不懂」变成「看得懂」。所以砸壳之后不要试图通读，而是<b>带着具体问题去定位</b>：反调试在哪、证书校验在哪 —— 这也是本章 28.5 与 28.6 的落点。',
             state: { '下一步': '定位反调试 / 证书校验' } }
         ]
       },

       quiz: {
         id: 'q14-5', chapter: 14, answer: 3,
         stem: '砸壳产出的二进制放进 IDA 之后，大部分函数能正常反汇编了，但仍有少数函数显示为无法解析的字节。最可能的原因是：',
         options: [
           { t: 'IDA 的处理器类型或加载基址设错了，重新配置一下即可', why: '配置问题会导致整体都读不好，而不是「大部分正常、少数几处异常」这种局部症状。' },
           { t: '这几个函数用了 IDA 不支持的指令集扩展', why: '同架构下指令集一致，不会只影响少数几个函数。这个解释站不住脚。' },
           { t: '这些区域是被后续加载的 dylib 覆盖，属于正常的分析噪声，忽略即可', why: '把明确的技术症状归因为「噪声」，会漏掉真正的问题 —— 局部失败通常有确定性原因。' },
           { t: 'dump 的区间不完整或存在多个加密段，有部分内容没被正确取出/重建', why: '正确。局部失败是「范围或重建出问题」的典型信号，应当回头核对 cryptoff / cryptsize 与全部加密段。' }
         ],
         explain: '<b>考的是对「局部失败」这种症状的读法。</b>砸壳的失败模式可以分为两类。<b>整体失败</b>（全篇乱码、文件加载不了）说明方向就错了：没砸壳、只改了 <code>cryptid</code> 没换内容、或者根本没有重建结构。<b>局部失败</b>（大部分正常、少数几处读不出来）说明方向对了但<b>范围或重建有偏差</b>：可能是 <code>cryptoff</code> / <code>cryptsize</code> 算错、可能是这个二进制存在<b>不止一个</b>需要处理的加密区域而工具只处理了一处、也可能是重建时段偏移没对齐导致该区域错位。<b>正确的排查动作</b>：回到 Mach-O 头部，重新核对加密区间的偏移与大小，并确认所有 <code>cryptid == 1</code> 的镜像/段都被覆盖到。这类问题之所以值得单独记住，是因为它的症状具有欺骗性 —— 「大部分能看」很容易让人以为已经成功，然后在少数几个函数上白白耗掉大量时间。'
       },

       after: '<p>本章到此形成一个闭环：<b>越狱拿权限 → 砸壳拿明文 → 反调试拿运行自由 → 抓包拿行为 → 再到 ObjC / native 层定位逻辑</b>。每一环都是下一环的前提，任何一环断掉，后面都会退化成昂贵的静态苦工。</p>'
     }
   ],

   glossary: [
     { t: 'objc_msgSend', d: 'ObjC 运行时核心函数：接收「接收者对象 + 选择器 + 参数」，在接收者类的方法列表中查找方法实现（IMP）并跳转。所有 ObjC 方法调用都收敛到它，因此 hook 它可拦截全部 ObjC 方法调用（代价是开销大、参数个数不固定、易递归）。' },
     { t: '选择器 / SEL', d: '方法的名字标识，包含冒号（如 doThing:）。冒号是方法身份的一部分，doThing: 与 doThing 是两个不同的选择器。用字符串取方法时必须写原始选择器。' },
     { t: 'IMP', d: '方法实现的函数指针。通过 method_getImplementation 或 Frida 的 method.implementation 取得，可直接交给 Interceptor.attach —— 这是精准 Hook（Hook 点 B）的落点。' },
     { t: 'FairPlay DRM', d: 'App Store 分发的加密机制。加密范围通常是 Mach-O 的 __TEXT 段（代码段），因此磁盘上的二进制静态反汇编出来是乱码，必须先砸壳才能分析。' },
     { t: 'cryptid', d: 'LC_ENCRYPTION_INFO(_64) load command 中的字段：1 表示该区间在磁盘上是密文，0 表示未加密。它只是状态声明，不解密任何内容，必须与真实数据状态一致。' },
     { t: 'cryptoff / cryptsize', d: '加密数据在文件中的偏移与大小。砸壳时按这两个字段精确定位要 dump 的区间，通常对应 __TEXT 段。' },
     { t: '砸壳', d: '把 App 运行时内存中已解密的代码段 dump 出来、改写 cryptid 为 0、并重建为结构正确的 Mach-O 的过程。因为内核用设备硬件密钥在加载时解密，且密钥每台设备不同，所以必须在目标设备本机、App 运行时进行。' },
     { t: 'Frida-iOS-dump', d: '基于 Frida 的动态砸壳工具：遍历已加载的 Mach-O 镜像、找到加密的段、从内存 dump 明文、重建为可用的二进制并修正 cryptid 与相关头部字段。' },
     { t: 'ptrace(PT_DENY_ATTACH)', d: '最经典的 iOS 反调试手法：调用后调试器无法附着；若已被附着则进程直接退出。绕过方式是 hook ptrace 让它直接返回；升级版会用 syscall(SYS_ptrace, 31, 0, 0, 0) 直接发起系统调用绕过符号 hook。' },
     { t: 'P_TRACED', d: 'kinfo_proc 中 kp_proc.p_flag 的一个标志位，通过 sysctl 查询。被置位说明进程正在被调试。绕法是 hook sysctl，在返回前清掉该位。' },
     { t: 'CS_DEBUGGED', d: '代码签名标志之一，通过 csops 系统调用查询，表示进程被调试器附加过。绕法是 hook csops 并清掉该标志。' },
     { t: 'SSL Pinning', d: '证书绑定：App 不信任系统证书库，而是内置服务端证书或公钥（或其哈希）并在 TLS 握手时比对，因此安装 Charles/mitmproxy 根证书也无法抓包。iOS 上常见实现有 NSURLSession delegate 回调、AFNetworking 的 SSLPinningMode、NSURLConnection 回调，以及 native 层 OpenSSL/BoringSSL。' }
   ],

   teacher: {
     id: 'ch14', chapter: 14,
     name: '追问老师 · 第 28 章',
     sub: '从消息机制到砸壳、反调试与证书绑定 —— 每一环都要求你讲得出「为什么」',
     intro: '<p style="margin:0">第 28 章的知识点密集，但真正会卡住人的不是记不住 API，而是<b>把因果搞反</b>：以为砸壳是为了解密、以为反调试是「清单」、以为混淆让动态分析也变难了。我会逐条追问，直到你能自己把推理链讲完整为止。答不上来没关系，但别用「反正工具能做」糊过去。</p>',
     questions: [
       {
         id: 'c14q1', depth: 1, threshold: 0.7,
         q: '为什么说「<b>Hook <code>objc_msgSend</code> 就能拦截所有 ObjC 方法调用</b>」？请从 ObjC 的方法调用机制讲起，并说明这条路线的代价。',
         concepts: [
           { label: 'ObjC 方法调用本质是发消息',
             hint: '先想清楚 [obj doThing:arg] 在编译后变成了什么。',
             any: ['发消息', '消息发送', '消息机制', 'message', 'send message', 'objc_msgSend', '运行时', 'runtime', '消息传递'] },
           { label: 'objc_msgSend 是唯一公共入口',
             hint: '为什么它能拦到「所有」调用，而不是一部分？',
             any: ['所有方法调用', '全部调用', '都经过', '公共入口', '唯一入口', '必经', '统一入口', '都会经过', '收敛'] },
           { label: '接收者 + 选择器 + 参数',
             hint: '它接收哪几样东西？',
             any: ['接收者', 'receiver', 'self', '选择器', 'selector', 'SEL', '参数'] },
           { label: '代价：开销 / 参数个数不固定 / 递归',
             hint: '为什么工程上不这么干？至少说出两条代价。',
             any: ['开销', '性能', '慢', '参数个数', '变参', '不定参数', '递归', '死循环', 'overhead'] }
         ],
         hints: [
           '你写的 [obj doThing:arg] 并不是一次函数调用，那它编译成了什么？',
           '如果所有消息都从同一个函数走，那从这个函数往下看，你能看到什么？这么做又有什么坏处？'
         ],
         probes: [
           '既然 hook 它能全覆盖，那为什么实战里我们更常去 hook 具体方法的 IMP？这两者的分工是什么？',
           '如果参数个数不固定，在 arm64 上你怎么知道这次调用到底带了几个参数？'
         ],
         model: 'Objective-C 的方法调用在语义上是「<b>发消息</b>」而不是「调用函数」。源码里写的 <code>[obj doThing:arg]</code>，编译后等价于 <code>objc_msgSend(obj, @selector(doThing:), arg)</code>。也就是说，编译器把你的方法调用改写成了一次对运行时核心函数 <code>objc_msgSend</code> 的调用。<br><br>这个函数接收三样东西：<b>接收者对象</b>、<b>选择器（selector）</b>、<b>参数</b>。它的工作是：通过接收者的 isa 找到它的类，拿着这个 SEL 去方法列表里查（先查方法缓存，未命中查本类方法列表，再沿继承链向上），找到对应的<b>方法实现（IMP）</b>，然后跳转过去执行。<br><br><b>为什么 hook 它就能拦全部</b>：因为这是所有 ObjC 方法调用的<b>唯一公共入口</b>。不管上层怎么写 —— 直接调用、通过 <code>performSelector</code>、KVO、还是框架内部调用 —— 只要它是一次 ObjC 消息发送，就必然经过这个函数。于是「在这个函数上架一个钩子」就等价于「看到全进程的 ObjC 方法调用」。<br><br><b>代价有三条</b>：① <b>开销</b>——每次方法调用都要进一次你的回调，热点路径上足以把 App 拖慢一个数量级；② <b>参数个数不固定</b>——它是变参函数，arm64 上前几个参数走寄存器、超出的走栈，你必须自己判断并取参；③ <b>递归</b>——你在回调里只要调用了任何 ObjC 方法（包括打印、属性访问），都会再次触发你自己的 hook，轻则日志爆炸，重则死循环。<br><br>所以正确的定位是：<b>它是最强的侦察工具，不是最好的打击工具</b>。先用它搞清楚「谁调了谁」，锁定目标后立刻换成对具体方法 IMP 的精准 hook。'
       },
       {
         id: 'c14q2', depth: 2, threshold: 0.75,
         q: '从 App Store 下载的 ipa，把主二进制丢进 IDA 后发现反汇编全是乱码。<b>请解释这个现象的成因</b>，以及砸壳到底做了哪几件事。',
         concepts: [
           { label: 'FairPlay DRM 加密',
             hint: '这是 Apple 的分发保护机制，叫什么名字？',
             any: ['FairPlay', 'DRM', '加密', 'encrypted', 'App Store 加密', '应用加密'] },
           { label: '加密范围是 __TEXT 代码段',
             hint: '被加密的是哪一段？',
             any: ['__TEXT', 'TEXT', '代码段', 'text 段', '代码'] },
           { label: 'cryptid = 1 表示已加密',
             hint: '哪个字段说明了「这段在磁盘上是密文」？',
             any: ['cryptid', 'LC_ENCRYPTION_INFO', 'cryptoff', 'cryptsize', 'load command'] },
           { label: '内核加载时用设备硬件密钥解密，内存里是明文',
             hint: '解密是谁做的？在什么时机做的？',
             any: ['内核', 'kernel', '加载', '载入', '运行时', '硬件密钥', '设备密钥', '内存中明文', '内存里是明文', '解密到内存'] },
           { label: '砸壳 = dump 内存明文 + 改 cryptid 为 0 + 重建结构',
             hint: '把内存里的东西拿出来之后，还差什么才算一个能用的文件？',
             any: ['dump', '导出', '内存读取', '改成 0', '改 cryptid', '重建', '修正结构', '段偏移', '修复头部'] }
         ],
         hints: [
           '磁盘上的那份二进制，它的 __TEXT 段在文件里是什么状态？为什么会这样？',
           '既然磁盘上是密文，那有没有哪个时刻它是明文？那个时刻在哪里？'
         ],
         probes: [
           '为什么砸壳必须在目标设备本机、在 App 运行时做？换一台设备行不行？',
           '如果我只把 cryptid 改成 0 而不真的替换内容，会发生什么？'
         ],
         model: '成因是 <b>FairPlay DRM</b>。从 App Store 下载的 App 是被加密分发的，加密信息记录在 Mach-O 的 load command 里：32 位用 <code>LC_ENCRYPTION_INFO</code>，64 位用 <code>LC_ENCRYPTION_INFO_64</code>。这个 load command 里有三个关键字段：<code>cryptoff</code>（加密数据的文件偏移）、<code>cryptsize</code>（加密数据大小）、<code>cryptid</code>（<b>1 = 已加密，0 = 未加密</b>）。加密范围通常就是 <code>__TEXT</code> 段，也就是<b>代码段</b>。所以磁盘上的机器码是密文，反汇编器按指令集去解释密文，得到的自然全是无意义字节 —— 这不是工具的问题，任何工具都一样。<br><br>解密发生在<b>运行时的加载阶段</b>：iOS 内核把 App 加载进内存时，用<b>设备的硬件密钥</b>把它解密。这里有两个要点：① 解密是内核做的，App 自己无法参与也无法阻止，因为它要能执行就必须先被解密；② 密钥<b>每台设备各不相同</b>，所以你不能在设备 B 上解密设备 A 下载的加密 App —— 这直接决定了砸壳必须在目标设备本机、在 App 正在运行时进行。<br><br><b>砸壳的本质一句话</b>：App 运行时内存里的代码已经是明文 —— 把这部分 dump 出来，并把 <code>cryptid</code> 改成 0，就得到一个可以静态分析的二进制。<br><br>拆开是<b>三个动作，缺一不可</b>：① <b>dump</b>——按 <code>cryptoff</code>/<code>cryptsize</code> 从内存读出明文；② <b>改标记</b>——把 <code>cryptid</code> 从 1 改成 0，这是「改声明」而不是解密，它告诉后续所有工具「别再当密文处理」；③ <b>重建</b>——修正段偏移、大小、对齐等头部字段，因为内存布局和文件布局本来就不同（内存按页对齐、有权限粒度），不换算就会得到一个「看着像 Mach-O、实际加载失败」的文件。<br><br>最后要建立正确预期：砸壳只把「看不见」变成「看得见」，不把「看不懂」变成「看得懂」—— OLLVM 混淆、符号被抹掉、Swift 名字 mangle 都还在。'
       },
       {
         id: 'c14q3', depth: 2, threshold: 0.75,
         q: '某 App 用了 <code>ptrace(PT_DENY_ATTACH, 0, 0, 0)</code> 反调试。你 hook 了 <code>ptrace</code> 让它直接返回，结果 App 依然闪退。请给出至少两种可能的原因，并说明这个现象反映了什么更普遍的规律。',
         concepts: [
           { label: '升级版：syscall 直接发起系统调用绕过符号 hook',
             hint: '有没有可能它压根没调用 ptrace 这个库函数？',
             any: ['syscall', 'SYS_ptrace', '系统调用', 'svc', '直接调用', '31', 'PT_DENY_ATTACH', '绕过符号', '不经过 ptrace'] },
           { label: '存在多处检测点，不止 ptrace 一处',
             hint: '除了 ptrace，App 还会用什么方式知道自己被调试？',
             any: ['sysctl', 'P_TRACED', 'getppid', 'launchd', 'csops', 'CS_DEBUGGED', '多处', '其它检测', '越狱检测', 'Frida 检测', '多个检测点'] },
           { label: 'hook 时机太晚 / 需要 spawn 模式早期介入',
             hint: '如果你的 hook 是在检测已经执行之后才装上的呢？',
             any: ['时机', '太晚', 'spawn', '启动阶段', '早期', '更早', '来不及', '已经被检测'] },
           { label: '需要先拿到运行自由再谈可观测性',
             hint: '当进程会因为检测而自杀时，你的分析顺序应该是什么？',
             any: ['先绕过', '先解决', '运行自由', '前置', '顺序', '先让它跑起来', '先稳定运行', '优先级'] }
         ],
         hints: [
           'hook 一个库函数，前提是调用方真的走了这个库函数。有没有办法不走？',
           '这个 App 可能只用了 ptrace 这一种检测手段吗？'
         ],
         probes: [
           '如果它确实是用 syscall 直接进内核的，你的拦截点应该往哪里移？',
           '为什么说反调试不是一张「绕过清单」，而是一场持续的博弈？'
         ],
         model: '<b>最直接的原因</b>是：你 hook 的是<b>用户态的库函数</b> <code>ptrace()</code>，而 App 可能根本不走它。高级写法会用 <code>syscall(SYS_ptrace, 31, 0, 0, 0)</code> <b>直接发起系统调用</b> —— 这里的 <code>31</code> 就是 <code>PT_DENY_ATTACH</code> 的值。执行路径没有经过你挂钩的那个函数，你的回调自然不会被触发；而内核收到的请求与正常调用完全一样，于是进程照样退出。这与「绕过库函数封装、直接用 SVC 进内核」是同一个思想：<b>你 hook 的是封装层，对方选择了不经过封装层。</b><br><br><b>第二个原因</b>是：<code>ptrace</code> 只是检测手段之一，App 很可能<b>同时用了多种</b>。常见的有：<code>sysctl</code> 查询 <code>kinfo_proc</code> 检查 <code>kp_proc.p_flag &amp; P_TRACED</code>；检查 <code>getppid()</code> 是否为 <code>launchd</code>（PID 1）；用 <code>csops</code> 检查 code signing flags 里是否有 <code>CS_DEBUGGED</code>；扫描内存里的 <code>frida</code>/<code>cycript</code>/<code>substrate</code> 等字符串、检查特定端口与 <code>DYLD_INSERT_LIBRARIES</code> 环境变量；以及越狱检测（<code>/Applications/Cydia.app</code>、<code>/bin/bash</code>、<code>/usr/sbin/sshd</code>、<code>/etc/apt</code>、能否 <code>fork()</code>、<code>cydia://</code>）。你只堵了其中一个，其余的照样会举报你。<br><br><b>第三个常见原因是时机</b>：你可能是在检测已经执行之后才装上 hook 的，需要用 spawn 模式让进程在你的控制下启动，尽早把检测点挡住。<br><br><b>更普遍的规律</b>：① <b>反调试是攻防博弈，不是清单</b> —— 每一招都有升级版（<code>ptrace</code> 走 <code>syscall</code> 就是最典型的例子），教程里教的往往只是第一版的破法；② <b>检测之间互相备份</b>，所以要先数清楚总共有几处在检，再谈绕过；③ <b>顺序上要先拿到「运行自由」，再谈「可观测性」</b> —— 进程一旦因检测而退出，后面所有 hook 都无从谈起。'
       },
       {
         id: 'c14q4', depth: 2, threshold: 0.75,
         q: '目标 App 的 SSL Pinning 做在 <code>libsscronet.so</code> 里，且该 so 被 OLLVM 混淆。你已经在 ObjC 层把所有能找到的校验回调都 hook 成恒返回成功，抓包仍然失败。<b>请说明应该往哪个方向走，以及为什么这个方向是对的。</b>',
         concepts: [
           { label: '校验在 native 层，ObjC hook 无效',
             hint: 'libsscronet.so 是什么类型的库？它的代码走 ObjC 运行时吗？',
             any: ['native', 'so', 'C++', 'c++', '底层', '不走 ObjC', '不经过 ObjC', '不是 ObjC', 'native 层', '动态库'] },
           { label: 'OLLVM 混淆让静态定位困难',
             hint: '为什么不能直接在 so 里读代码找校验函数？',
             any: ['OLLVM', '混淆', 'ollvm', '控制流平坦化', '平坦化', '花指令', '虚假控制流', '静态看不懂', '读不懂'] },
           { label: '动态 Trace：hook 校验必经的库函数看谁被调用',
             hint: '混淆改的是控制流，什么改不了？',
             any: ['动态', 'trace', 'trace 定位', 'hook 库函数', '看谁被调用', '哪个被调用', '副作用', '动态分析', '运行时观察'] },
           { label: '候选点：X509_verify_cert / SSL_CTX_set_verify / SSL_CTX_set_custom_verify',
             hint: 'OpenSSL 和 BoringSSL 各有哪些代表性的校验函数？',
             any: ['X509_verify_cert', 'SSL_CTX_set_verify', 'SSL_CTX_set_custom_verify', 'OpenSSL', 'BoringSSL', 'boringssl', 'openssl'] },
           { label: '定位后让它恒返回成功（X509_V_OK 或 1）',
             hint: '找到校验点之后的具体动作是什么？',
             any: ['返回成功', '恒返回', 'X509_V_OK', '返回 1', 'retval', '改返回值', 'replace'] },
           { label: '警惕冗余校验：改一处还有另一处',
             hint: '如果改了一处还是抓不到包，说明什么？',
             any: ['冗余', '多处', '另一处', '还有别的地方', '多个校验点', '不止一处'] }
         ],
         hints: [
           '你已经确认 ObjC 层全部放行了，但依然失败 —— 那校验还可能在哪一层？',
           'OLLVM 混淆的是控制流，那有没有什么是它混淆不了的？'
         ],
         probes: [
           '为什么在这种情况下，动态定位比先完整反混淆更划算？',
           '如果挂了所有候选函数，发现都没有被调用，你下一步会怎么查？'
         ],
         model: '<b>方向是：从 ObjC 层下沉到 native 层，用动态 Trace 去定位校验点。</b><br><br><b>为什么 ObjC 层一定失败</b>：<code>libsscronet.so</code> 是 <b>native so</b>。<code>cronet</code> 是 Chromium 的网络栈，<code>libsscronet</code> 是字节跳动系对它的封装/定制版本。它的 SSL Pinning 写在 <b>C++ 层</b>，根本不经过 ObjC 运行时 —— 所以无论你在 ObjC 层 hook 多少回调、返回多少次成功，都不可能影响它。这一点是判断的关键：<b>hook 只在被 hook 的那条路径上生效。</b><br><br><b>为什么静态定位困难</b>：这个 so 被 <b>OLLVM 混淆</b>了。控制流被平坦化、插入虚假分支之后，你几乎没法直接静态找到校验函数 —— 即使有符号表，函数体也是一团读不懂的分发器。<br><br><b>为什么动态 Trace 是对的</b>：这是本章最重要的方法论 —— <b>静态看不懂就动态跑</b>。核心洞察是：<b>OLLVM 混淆的是控制流，它混淆不了库函数的符号名。</b>无论上层怎么混淆，只要程序要验证证书，就<b>大概率会调用某个成熟的 SSL/密码学库函数</b>，而这些函数的名字是公开的、固定的。所以做法是：把常见的校验函数<b>全部挂上</b> —— OpenSSL 的 <code>X509_verify_cert</code>、<code>SSL_CTX_set_verify</code>；BoringSSL 的 <code>SSL_CTX_set_custom_verify</code> —— 然后<b>观察哪个真的被调用了</b>。被调用的那个就是突破口，接着 hook 它让它恒返回成功（<code>X509_V_OK</code> 或 <code>1</code>）。<br><br><b>为什么比先反混淆更划算</b>：混淆提升的是「读代码」的成本，不提升「观察行为」的成本。你不需要理解混淆后的逻辑，只需要知道「哪个函数被调用了」。反混淆（D-810、HexRaysDeob 等）是另一条正路，但它更适合需要理解完整逻辑的场景。<br><br><b>最后一条实战经验：警惕冗余校验。</b>如果定位到一处并绕过后仍然抓不到包，说明还有第二处校验（可能 ObjC 一处、native 一处）。排查办法是把所有层级的候选点全部挂上日志，直到确认再没有别的调用者。'
       },
       {
         id: 'c14q5', depth: 3, threshold: 0.7,
         q: '<b>综合题。</b>你拿到一个 App Store 应用，要完成「抓包分析它的登录接口」这一个目标。请把本章的各个环节串成一条<b>有先后依赖</b>的工作流，并说明：<b>如果跳过其中某一环会发生什么</b>。',
         concepts: [
           { label: '越狱拿 root 权限：frida-server 运行的前提',
             hint: '要注入别人的进程，你首先需要什么？',
             any: ['越狱', 'root', '权限', 'jailbreak', 'frida-server', 'frida server', '无根', 'rootless'] },
           { label: '砸壳拿明文二进制，便于静态定位',
             hint: '没有可读的二进制，你的分析会变成什么样？',
             any: ['砸壳', 'dump', '解密', '明文', 'FairPlay', 'cryptid', '可读', '静态分析'] },
           { label: '绕过反调试以获得运行自由',
             hint: '如果 App 一 attach 就退出，后面还能做什么？',
             any: ['反调试', 'ptrace', 'PT_DENY_ATTACH', 'sysctl', '绕过', '运行自由', '不闪退', '稳定运行'] },
           { label: '定位 SSL Pinning 所在层级（ObjC / AFNetworking / native）',
             hint: '证书校验可能写在哪几个地方？要先判断在哪一层。',
             any: ['SSL Pinning', '证书绑定', 'pinning', '校验证书', 'evaluateServerTrust', 'SecTrustEvaluate', 'AFNetworking', 'SSLPinningMode', 'native', 'libsscronet', 'ObjC 层'] },
           { label: '动态 Trace 定位校验点并让它恒返回成功',
             hint: '找到校验点之后的具体动作是什么？',
             any: ['动态', 'trace', 'hook', '返回成功', 'retval', '改返回值', 'X509_verify_cert', '绕过校验', '恒返回'] },
           { label: '每环都是下一环的前提，顺序不可颠倒',
             hint: '这些步骤是并列的清单，还是有依赖关系的链条？',
             any: ['前提', '依赖', '先后', '顺序', '链路', '递进', '前面是后面的基础', '环环相扣', '缺一不可'] }
         ],
         hints: [
           '你的最终目标是抓到包。倒推一下：要 hook 到校验点，你需要进程能被你控制；要让进程被你控制，你需要什么？',
           '这几步之间是并列关系，还是每一步都以前一步为条件？'
         ],
         probes: [
           '如果这个 App 是 Swift 写的、并且类名方法名都被混淆了，你的工作流哪一步会变难？为什么？',
           '假设你只有一台不能越狱的新设备，这条链路会在哪一环断掉？有没有替代方案？'
         ],
         model: '<b>完整工作流（有严格依赖顺序）：</b><br><br><b>① 越狱拿权限</b> → 因为 <span class="term" data-def="Frida 在设备侧运行的守护进程，需要 root 权限才能注入其他进程">frida-server</span> 必须以 root 身份运行才能注入其它进程。<span class="small muted">（2023 年前后的生态：checkra1n 基于 checkm8 硬件漏洞覆盖 A5–A11；unc0ver 走软件漏洞；palera1n 基于 checkm8 支持 A11 及之后的部分设备；Dopamine 是无根越狱。iOS 15+ 因 SSV 使系统卷只读且带签名校验，越狱改为无根模式。具体支持情况务必以官方仓库当期状态为准。）</span><br><br><b>② 砸壳拿明文二进制</b> → 因为磁盘上的 <code>__TEXT</code> 段被 FairPlay 加密，静态看到的全是乱码。<b>跳过它</b>的后果：你无法静态定位任何东西，只能靠动态试错去猜校验点在哪，效率低一个数量级；而且后面若要改包重签名，你手里根本没有可用的二进制。<br><br><b>③ 绕过反调试</b> → 因为 App 可能用 <code>ptrace(PT_DENY_ATTACH)</code>、<code>sysctl</code> 查 <code>P_TRACED</code>、<code>getppid</code>、<code>csops</code> 查 <code>CS_DEBUGGED</code>、Frida 特征扫描、越狱检测等手段拒绝你。<b>跳过它</b>的后果最严重：进程一 attach 就退出，<b>后面所有环节全部无从谈起</b> —— 这就是为什么顺序上必须先拿「运行自由」，再谈「可观测性」。注意升级版：若对方用 <code>syscall(SYS_ptrace, 31, 0, 0, 0)</code> 直接进内核，hook <code>ptrace</code> 符号是无效的。<br><br><b>④ 判断 SSL Pinning 在哪一层</b> → 可能是 ObjC 层（<code>URLSession:didReceiveChallenge:completionHandler:</code>、<code>evaluateServerTrust:forDomain:</code>、<code>SecTrustEvaluate</code>）、AFNetworking（<code>securityPolicy.SSLPinningMode</code>）、<code>NSURLConnection</code> 回调，或 native 层（OpenSSL/BoringSSL，如 <code>libsscronet.so</code>）。<b>跳过它</b>的后果：在错误的层级上白做功 —— 就像在 ObjC 层反复 hook 一个根本不走 ObjC 的 native 校验。<br><br><b>⑤ 定位校验点并让它恒返回成功</b> → 被 OLLVM 混淆时<b>不要硬读</b>，改用动态 Trace：挂上 <code>X509_verify_cert</code>、<code>SSL_CTX_set_verify</code>、<code>SSL_CTX_set_custom_verify</code> 等候选点，看哪个被调用，然后让它返回 <code>X509_V_OK</code> 或 <code>1</code>。<b>跳过定位直接硬绕</b>的后果：陷入「改了一处还有另一处」的冗余校验泥潭。<br><br><b>⑥ 抓包验证</b> → 装 Charles/mitmproxy 根证书，确认流量可解密。<br><br><b>核心结论：这不是一张并列的清单，而是一条依赖链 —— 越狱给权限，砸壳给可读性，反调试给运行自由，识别层级给方向，动态定位给突破口。</b>任何一环断掉，后面的环节都会退化成昂贵的静态苦工。<br><br><b>关于替代方案</b>：如果不能越狱，可以用 <b>frida-gadget</b> 重打包注入，但限制更多 —— 你需要先能改这个二进制（而这一步本身要先砸壳）、要处理重签名与描述文件，且 gadget 由 App 自己加载，注入时机与能力都不如 frida-server 自由。'
       }
     ]
   }
};
