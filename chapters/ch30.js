/* 第 30 章 · 安卓模拟器环境与原理揭密
   作者：章节作者（ch16）
   结构：14 个 section / stage×3 / stepper×1 / term×2 / decision×3 / quiz×4
   注：AOSP target 名、分区细节等不确定处一律标 <span class="pill warn">待核实</span> */
window.CHAPTER = {
  no: 30,
  title: '安卓模拟器环境与原理揭密',
  lede: '模拟器不是「另一台手机」，它是<strong>一套运行环境方案</strong>。这一章拆开三件事：ARM 指令在 x86 上怎么被翻译、Android 的 GKI 内核怎么被替换、以及 Google 官方的云端虚拟设备 Cuttlefish 到底长什么样。',
  meta: [
    '核心问题：<b>为什么 x86 镜像 + 翻译层比全系统 ARM 模拟快得多？GKI 把内核拆成了什么？云手机的底座是什么？</b>',
    '关键工具：<b>QEMU / TCG</b>、<b>libhoudini / libndk_translation</b>、<b>AOSP 编译</b>、<b>GKI + KMI</b>、<b>Cuttlefish + KVM</b>',
    '对手：<b>App 的模拟器风控</b>（ro.kernel.qemu / goldfish / ranchu / SwiftShader / /dev/qemu_pipe）与硬件虚拟化限制'
  ],

  sections: [
    /* ================= 30.1 ================= */
    {
      h: '30.1',
      title: '为什么逆向工程师必须懂模拟器原理',
      intuition: {
        tag: '直觉模型 · 一场国际会议的同声传译',
        body: '<p>会场里有两种极端的做法。<b>做法一</b>：所有参会者都只会说外语，于是<b>每一个人说的每一句话</b>都要经过同声传译——包括主持人念流程、念注意事项。传译员再快，会议也会被拖慢好几倍。这就是<b>全系统模拟</b>。<br><b>做法二</b>：会议主体改用中文进行，只有台上那位外宾发言时需要翻译。会场 95% 的交流是原生速度，只有外宾那几句要过一遍传译。这就是<b>应用级翻译</b>。<br>两者的差别不在「翻译质量」，而在<b>需要被翻译的代码占多大比例</b>。这一章所有的性能直觉，都从这个比例出发。</p>'
      },
      html:
        T.note('key', '🔑 本章主线',
          '<p>模拟器 = <b>指令翻译方案</b> + <b>内核/系统镜像方案</b> + <b>虚拟化底座</b>。三块拼起来，才是一台「虚拟安卓设备」。</p>'
          + '<p>本章按这个顺序讲：先把 <b>ARM→x86 翻译</b>讲透（30.2–30.3），再讲 <b>GKI 内核</b>怎么组织、怎么换（30.4–30.5），再看 Google 官方的 <b>Cuttlefish</b>（30.6），最后把模拟器、Cuttlefish、云手机、Waydroid 放进一张谱系图（30.7）。</p>')
        + T.grid(2, [
          '<div class="card"><div class="card-title">看得见的一层：模拟器是个「软件」</div><p>你双击 emulator，出现一个安卓窗口。这一层谁都会用。</p></div>',
          '<div class="card"><div class="card-title">看不见的一层：它是一台「机器」</div><p>它有内核、有 <span class="mono">/proc</span>、有属性系统、有分区表、有设备节点。App 通过 <span class="mono">Build.*</span>、<span class="mono">System.getProperty</span>、读取 <span class="mono">/proc</span>、<span class="mono">/sys</span> 就能「感知」到这是一台什么机器。</p></div>'
        ])
        + T.note('', '这对逆向有什么用（本章必须回答的问题）',
          '<p><b>① 识别环境</b>——风控 SDK 判断「你是不是模拟器」，靠的是一串<b>环境特征</b>：<span class="mono">ro.kernel.qemu</span>、硬件名 <span class="mono">goldfish</span>/<span class="mono">ranchu</span>、渲染器 <span class="mono">SwiftShader</span>、设备节点 <span class="mono">/dev/qemu_pipe</span>、<span class="mono">/dev/socket/genyd</span> 等。这些字符串不是随机出现的，它们<b>是这套虚拟化架构的必然产物</b>：Goldfish 是模拟器的虚拟硬件平台，ranchu 是它的新一代实现，qemu_pipe 是 guest 与宿主 emulator 进程通信的通道。你只有理解了「谁生成了这个文件/属性」，才知道它能不能删、删了会怎样。</p>'
          + '<p><b>② 定制隐蔽环境</b>——想做一个「看起来像真机」的模拟器，你必须改三处：<b>属性系统</b>（ro.* 只读属性从哪来、怎么在编译期或 <span class="mono">default.prop</span> 层改）、<b>内核</b>（内核启动参数、<span class="mono">/proc</span> 里的痕迹、驱动名字）、<b>系统镜像里的文件</b>（设备节点、传感器列表、相机 HAL）。不知道系统镜像怎么组织，就只能改改 <span class="mono">build.prop</span> 骗骗最弱的检测。</p>'
          + '<p><b>③ 云手机的基础</b>——云手机本质就是<b>跑在服务器上的安卓虚拟设备</b>。理解了 Cuttlefish 的组成（宿主 Linux + KVM + 虚拟设备 + 编排），云手机就不再神秘：它把 Cuttlefish 这类方案做成了多租户、带串流和运维的服务。</p>'
          + '<p><b>④ KVM 是共同底座</b>——QEMU、Cuttlefish、crosvm 都依赖 KVM 做硬件虚拟化。所以「为什么模拟器只能在特定 CPU/系统上跑得快」，答案在 KVM 的可用性上。</p>')
        + T.note('warn', '⚠️ 两个容易混淆的词',
          '<p><b>「模拟」（emulation）</b>：用软件解释另一套指令集，guest 架构可以 ≠ host 架构。<br><b>「虚拟化」（virtualization）</b>：CPU 硬件直接执行 guest 指令，要求 guest 架构 = host 架构（x86 上跑 x86）。<br>本章大部分性能结论，都来自「你到底在用哪一个」。</p>')
    },

    /* ================= 30.2 ================= */
    {
      h: '30.2',
      title: 'ARM 指令在 x86 上的两条翻译路径',
      html:
        '<p>x86 电脑要跑安卓，第一条拦路虎是<b>指令集不同</b>：安卓生态的原生库（<span class="mono">.so</span>）绝大多数是 <b>ARM/ARM64</b> 的，而你的 PC 是 <b>x86_64</b>。让它们合作，历史上有两条完全不同的路。</p>'
        + T.note('', '路径 A · 全系统模拟（QEMU + TCG）',
          '<p>Android 官方模拟器早期走的是这条路：用 <b>QEMU 全系统模拟</b>跑一个完整的 ARM 安卓系统。<span class="term" data-def="Tiny Code Generator，QEMU 内置的动态二进制翻译引擎">TCG</span> 把 guest 的 ARM 指令<b>逐条</b>翻译成等价的 x86 指令（并按基本块缓存成 TB，Translation Block）。</p>'
          + '<p>缺点很直观：<b>整个系统</b>——内核、Android 运行时、每一行 Java、每一个系统服务——都在被翻译。哪怕只是滑动桌面，背后也是几十万条 ARM 指令被逐条转译。这就是当年「模拟器慢到没法用」的根因。</p>')
        + T.note('', '路径 B · 应用级翻译（x86 镜像 + 翻译层）',
          '<p>现代方案换了个思路：<b>让安卓系统本身就是 x86 的</b>（系统镜像 <span class="mono">x86_64</span>，原生速度运行），只有 <b>App 里那些 ARM 的 <span class="mono">.so</span></b> 在运行时被翻译。</p>'
          + '<p>承担翻译的是两个<b>应用级</b>翻译层：<b><span class="term" data-def="Intel 提供的 ARM→x86 二进制翻译层，让 x86 安卓系统能运行 ARM 的原生库（.so）。Intel 已停止维护">libhoudini</span></b>（Intel 的 ARM→x86 二进制翻译层，已停止维护）和 <b><span class="term" data-def="Google 在 NDK 体系下延续的 ARM→x86 翻译层方案，作用与 libhoudini 类似">libndk_translation</span></b>（Google 在 NDK 体系里延续的方案）。它们挂在运行时的库加载路径上：当 <span class="mono">System.loadLibrary</span> 加载到一个 ARM 架构的 <span class="mono">.so</span> 时，由翻译层接管，把 ARM 代码翻译成 x86 执行。</p>'
          + '<p>关键区别：<b>需要被翻译的代码比例从 100% 掉到了个位数</b>。这就是为什么现代模拟器、云手机几乎都偏好「x86 系统镜像 + 翻译层」。</p>')
        + T.note('warn', '⚠️ 硬件加速解决的是「另一个问题」',
          '<p><b><span class="term" data-def="Hardware Accelerated Execution Manager，Intel 的硬件加速方案，让 QEMU 借助 VT-x 直接执行 guest 指令">HAXM</span></b>（Hardware Accelerated Execution Manager）和 <b>AMD Hyper-V</b> 是<b>硬件加速</b>：让 QEMU 借助 CPU 的虚拟化扩展（VT-x / AMD-V）直接执行 guest 指令，不再逐条软件翻译。</p>'
          + '<p>但它们有一个硬条件：<b>guest 与 host 必须同架构</b>。也就是说，HAXM/Hyper-V 能让 x86 镜像跑得飞快，<b>却不能</b>让 ARM 镜像跑得快——ARM 镜像仍然只能退回 TCG 软翻译。这条限制是整个模拟器选型的物理边界。</p>')
        + T.tbl(['方案', '跑的安卓系统是什么架构', '翻译发生在哪', '性能直觉'], [
          ['QEMU + TCG', 'ARM / ARM64（全系统）', '每一条 ARM 指令', '<span class="miss">慢</span>'],
          ['QEMU + HAXM / Hyper-V', 'x86 / x86_64', '<span class="hit">不翻译</span>，硬件直跑', '<span class="hit">接近原生</span>'],
          ['x86 镜像 + libhoudini / libndk_translation', 'x86_64 系统 + ARM App', '只有 App 的 ARM <span class="mono">.so</span>', '<span class="hit">快得多</span>']
        ]),
      stage: {
        title: 'ARM 指令在 x86 上的两条执行路径（对比动画）',
        speed: 1900,
        render:
          '<div class="flow-row">'
          + '<div class="flow-col">'
          + '<div class="blk" id="p1">① ARM 安卓系统镜像<br><span class="small">内核 + 运行时 + 全部 App，全是 ARM 指令</span></div>'
          + '<div class="arrow">↓</div>'
          + '<div class="blk" id="p2">② QEMU TCG 全系统翻译<br><span class="small">逐条 ARM → 等价 x86，缓存为 TB</span></div>'
          + '<div class="arrow">↓</div>'
          + '<div class="blk" id="p3">③ x86 CPU 执行翻译结果</div>'
          + '<div class="arrow">↓</div>'
          + '<div class="pill" id="p4">待评估</div>'
          + '</div>'
          + '<div class="flow-col">'
          + '<div class="blk" id="q1">① x86_64 安卓系统镜像<br><span class="small">系统本身是原生指令，不翻译</span></div>'
          + '<div class="arrow">↓</div>'
          + '<div class="blk" id="q2">② Java / Kotlin 代码 → ART 直接执行<br><span class="small">x86 后端，原生速度</span></div>'
          + '<div class="arrow">↓</div>'
          + '<div class="blk" id="q3">③ App 里的 ARM .so<br><span class="small">libhoudini / libndk_translation 翻译</span></div>'
          + '<div class="arrow">↓</div>'
          + '<div class="blk" id="q4">④ x86 CPU 执行</div>'
          + '<div class="arrow">↓</div>'
          + '<div class="pill" id="q5">待评估</div>'
          + '</div>'
          + '</div>',
        reset: () => {
          ['p1', 'p2', 'p3', 'q1', 'q2', 'q3', 'q4'].forEach((id) => S(id, ''));
          CLS('p4', 'pill'); SET('p4', '待评估');
          CLS('q5', 'pill'); SET('q5', '待评估');
        },
        steps: [
          { run: () => S('p1', 'active'),
            note: '<b>左路起点：整个系统都是 ARM。</b>内核、ART 运行时、SystemServer、每一个 App 的每一行代码——没有任何一部分是 x86 原生的。这意味着<b>没有任何东西可以幸免于翻译</b>。' },
          { run: () => { S('p1', 'done'); S('p2', 'active'); },
            note: '<b>QEMU TCG 上场。</b>它把 ARM 指令逐条翻译成等价的 x86 指令序列，并把一段连续代码（基本块）的翻译结果缓存成 TB（Translation Block），下次执行同一块就直接复用。缓存能缓解、但消除不了开销：<b>第一次经过的每一条指令都要翻译</b>。' },
          { run: () => { S('p2', 'done'); S('p3', 'active'); },
            note: '<b>x86 CPU 执行的是「翻译产物」。</b>注意：CPU 完全不知道自己在跑安卓——它只是在跑 TCG 生成的 x86 代码。多了一层间接，寄存器映射、标志位模拟、内存访问检查都要额外开销。' },
          { run: () => { S('p3', 'done'); SET('p4', '慢'); CLS('p4', 'pill bad'); },
            note: '<b>结论：慢，而且慢在根上。</b>不是「QEMU 写得不好」，而是<b>100% 的代码都要过翻译器</b>。再怎么优化 TCG，这个比例也降不下来——除非换架构。' },
          { run: () => S('q1', 'active'),
            note: '<b>右路起点：系统本身就是 x86_64。</b>系统镜像、内核、ART 都是 x86 原生指令。<span class="hit">这一层完全不需要翻译</span>——前提是 CPU 支持硬件虚拟化（HAXM / Hyper-V / KVM），让 guest 代码直接跑在真实 CPU 上。' },
          { run: () => { S('q1', 'done'); S('q2', 'active'); },
            note: '<b>App 的 Java/Kotlin 层也是原生的。</b>ART 有 x86 后端，DEX 字节码编译出的就是 x86 机器码。绝大多数 App 的绝大部分代码在这一层——<b>它们以原生速度运行</b>。' },
          { run: () => { S('q2', 'done'); S('q3', 'active'); },
            note: '<b>问题只剩一个角落：App 里的 ARM <span class="mono">.so</span>。</b>加固壳、算法库、音视频引擎、游戏引擎——这些原生库通常只带 ARM 版本。当加载器发现它是 ARM 架构时，交给翻译层（libhoudini / libndk_translation）处理。' },
          { run: () => { S('q3', 'done'); S('q4', 'active'); },
            note: '<b>翻译只发生在 .so 的边界内。</b>翻译层把 ARM 指令转成 x86 执行，并对 Java 层保持透明。翻译的代码量从「整个系统」缩小到「App 的原生库」，通常只占总执行量的很小一部分。' },
          { run: () => { S('q4', 'done'); SET('q5', '快得多'); CLS('q5', 'pill ok'); },
            note: '<b>结论：快得多。</b>不是因为翻译质量更高，而是因为<b>需要翻译的比例极低</b>。这就是现代模拟器、云手机普遍选择 x86 系统镜像 + 翻译层的原因——把翻译成本从「全民负担」变成「局部负担」。' },
          { run: () => {
              CLS('p4', 'pill bad'); SET('p4', '慢 · 100% 代码过翻译器');
              CLS('q5', 'pill ok'); SET('q5', '快 · 只有 ARM .so 过翻译器');
              S('p1', 'hot'); S('q1', 'cool');
            },
            note: '<b>一句话记住这条分界线。</b><span class="bad">全系统模拟</span>翻译的是「整个操作系统」；<span class="hit">应用级翻译</span>翻译的是「App 里的 ARM 原生库」。前者是架构决定的必然代价，后者是可优化的局部成本。<b>选型时先问一句：我到底需要翻译多少代码？</b>' }
        ]
      },
      after: T.note('', '对逆向的直接含义',
        '<p>① 在 x86 模拟器上抓一个 App 的 ARM <span class="mono">.so</span>，你看到的执行并不完全等价于真机——翻译层可能有自己的行为差异（比如对某些指令、对内存模型的模拟）。做<b>反调试验证</b>时要把这层差异算进去。</p>'
        + '<p>② 反过来，<b>翻译层的存在本身就是环境特征</b>：某些加固/风控会检测进程里是否加载了 <span class="mono">libhoudini</span>、<span class="mono">libndk_translation</span> 相关的库。你在做环境伪装时，这属于要清理的清单之一。</p>')
    },
    /* ================= 30.3 ================= */
    {
      h: '30.3',
      title: '自己编译一个安卓模拟器与系统镜像',
      html:
        '<p>官方 emulator 是二进制分发的，但你可以<b>从 AOSP 源码</b>把模拟器（<span class="mono">emulator</span>）和系统镜像一起编出来。这条路走通一次，你就拥有了「完全可控的安卓环境」——包括内核、属性、驱动、预置文件。<span class="pill warn">待核实</span> 具体 target 名称随 AOSP 版本变化，请以你所用分支的 <span class="mono">lunch</span> 列表为准。</p>'
        + T.note('', '编出来的到底是什么',
          '<p>一条命令产出的其实<b>不止模拟器程序</b>，而是三样东西：</p>'
          + '<p>① <b>系统镜像</b>：<span class="mono">system.img</span>（Android 框架与系统应用）、<span class="mono">vendor.img</span>（厂商 HAL）、<span class="mono">boot.img</span>（内核 + ramdisk）等；<br>'
          + '② <b>模拟器程序</b> <span class="mono">emulator</span>：本质是 QEMU 的一个定制分支 + 配套工具；<br>'
          + '③ <b>镜像包目录</b>：让 emulator 知道去加载哪套镜像、用什么虚拟硬件（Goldfish / ranchu 平台）。</p>'
          + '<p>所以「编译模拟器」和「编译系统镜像」是一起完成的——这也是为什么自编译环境最容易做深度定制。</p>')
        + T.note('warn', '<span class="pill warn">待核实</span> 的边界',
          '<p>下面终端里的 <b>target 名称</b>（<span class="mono">aosp_x86_64-eng</span>、<span class="mono">sdk_phone_x86_64</span>）在不同 AOSP 分支上存在差异，<span class="mono">eng</span>/<span class="mono">userdebug</span>/<span class="mono">user</span> 三种变体的可用性也不完全一致。<b>不要背 target 名，要会看 lunch 列表。</b></p>'),
      term: {
        title: 'AOSP：从源码到可启动的模拟器',
        lines: [
          { t: 'p', s: 'repo init -u https://android.googlesource.com/platform/manifest -b <分支名>',
            note: '<b>拉取清单。</b>AOSP 由上千个 git 仓库组成，<span class="mono">repo</span> 是 Google 包的一层管理工具。<span class="mono">-b</span> 指定分支（如某个 <span class="mono">android-XX.Y.Z_rN</span> 标签）。<span class="pill warn">待核实</span> 具体分支名请查官方发布页。' },
          { t: 'p', s: 'repo sync -c -j8',
            note: '<b>同步源码。</b>几十到上百 GB，是这一步最耗时的部分。<span class="mono">-c</span> 只拉当前分支，<span class="mono">-j8</span> 是并发数。' },
          { t: 'p', s: 'source build/envsetup.sh',
            note: '<b>引入构建环境。</b>这个脚本把 <span class="mono">lunch</span>、<span class="mono">m</span>、<span class="mono">mm</span>、<span class="mono">croot</span> 等命令注入当前 shell。<b>每个新终端都要重新 source 一次</b>——这是新手最常踩的坑：新开窗口直接敲 lunch，提示 command not found。' },
          { t: 'p', s: 'lunch',
            note: '<b>选 target（无参数时会列出全部可选项）。</b>格式是 <span class="mono">&lt;product&gt;-&lt;buildvariant&gt;</span>。模拟器相关的典型选项是 <span class="mono">aosp_x86_64-eng</span> 或 <span class="mono">sdk_phone_x86_64</span>。<span class="pill warn">待核实</span> 名称随版本变化，<b>务必以本机 lunch 列表为准</b>。' },
          { t: 'o', s: 'Lunch menu... pick a combo:\n    1. aosp_arm-eng\n    2. aosp_x86_64-eng\n    ...  （列表随分支变化）', },
          { t: 'p', s: 'lunch aosp_x86_64-eng',
            note: '<b>锁定 target。</b>选完之后，环境变量 <span class="mono">TARGET_PRODUCT</span>、<span class="mono">TARGET_BUILD_VARIANT</span> 被设置好，后续 make 才知道要编什么。选了 x86_64 就意味着走「应用级翻译」那条路（需要另外准备 ARM 翻译层）。' },
          { t: 'p', s: 'make -j$(nproc)',
            note: '<b>开始构建。</b>首次全量编译在普通开发机上以小时计。产物落在 <span class="mono">out/target/product/&lt;target&gt;/</span> 下，包括各分区镜像。' },
          { t: 'w', s: '注意：镜像架构 = target 架构。选了 x86_64，系统就是 x86_64 的', },
          { t: 'p', s: 'emulator -avd <你的AVD名> -no-snapshot',
            note: '<b>用编出来的产物启动。</b>前提是镜像路径被正确指向（通常靠 <span class="mono">ANDROID_PRODUCT_OUT</span> 或把镜像放进 SDK 的 system-images 目录）。<span class="mono">-no-snapshot</span> 跳过快照，确保你启动的是刚编出来的东西。' },
          { t: 'p', s: 'adb shell getprop ro.build.fingerprint',
            note: '<b>验证。</b>确认跑起来的确实是你的构建产物。这一步不做，你可能会花一小时调试一个其实没被加载的镜像。' }
        ]
      },
      after: T.note('', '对逆向的含义',
        '<p>会自编译 = 你能改<b>别人改不了的东西</b>：</p>'
        + '<p>① <b>属性系统</b>——在系统镜像源码层面把 <span class="mono">ro.kernel.qemu</span>、<span class="mono">ro.hardware</span>、<span class="mono">ro.product.*</span> 改成真机样式，而不是运行时去 hook；<br>'
        + '② <b>纯净环境</b>——编一个 <span class="mono">userdebug</span> 变体，默认 <span class="mono">adb root</span> 可用，省掉刷 Magisk 的步骤；<br>'
        + '③ <b>预置工具</b>——把 frida-server、抓包证书、调试工具直接放进系统镜像，开机即在。</p>'
        + '<p>代价是环境维护成本：每次 AOSP 升级，你的补丁都要重新适配一次。</p>')
    },

    /* ================= 30.3L 动手实验 ================= */
    {
      h: '30.3L', title: '动手实验：给需求选对翻译模式',
      html:
        '<p>本章最容易混淆的三个概念：<b>全系统模拟</b>、<b>应用级翻译</b>、<b>GKI</b>。' +
        '前两个是"怎么执行 ARM 代码"，第三个根本不是翻译——它是内核架构。这个实验帮你把它们分清楚。</p>',
      lab: {
        title: '实验：翻译模式选型',
        goal: '目标：按需求选对模式',
        intro:
          '<p>下面三个需求，分别该用哪种模式？<b>注意其中有一个需求，本身就是个错误前提。</b></p>' +
          '<div class="tbl-wrap" style="margin:12px 0"><table class="tbl"><thead><tr><th>#</th><th>需求</th></tr></thead><tbody>' +
          '<tr><td>①</td><td>在 x86 PC 上跑一个完整的 ARM Linux 系统（含内核），用来研究驱动行为</td></tr>' +
          '<tr><td>②</td><td>在 x86 安卓设备上，让某个只有 armeabi-v7a so 的 App 能正常用，且性能尽量接近原生</td></tr>' +
          '<tr><td>③</td><td>想通过"把内核换成 GKI"来让 x86 模拟器跑 ARM 的 App</td></tr>' +
          '</tbody></table></div>',
        inputs: [
          { key: 'a1', label: '① 需求①该用哪种模式？', hint: '填：全系统模拟 / 应用级翻译 / GKI', ph: '全系统模拟' },
          { key: 'a2', label: '② 需求②该用哪种模式？', hint: '', ph: '应用级翻译' },
          { key: 'a3', label: '③ 需求③有什么问题？', hint: 'GKI 解决的是"翻译"问题吗？', ph: '问题在于……', type: 'textarea', rows: 2 }
        ],
        runLabel: '🔍 校验选型',
        run: (v) => {
          const L = window.LABX;
          let html = '<table class="lab-tbl"><tr><th>模式</th><th>怎么工作</th><th>优点</th><th>代价</th><th>适用</th></tr>';
          L.TRANSLATION_MODES.forEach(m => {
            html += '<tr class="' + (m.id === 'gki' ? 'diff' : 'same') + '">'
              + '<td><b>' + m.name + '</b></td>'
              + '<td style="font-size:12px">' + m.how + '</td>'
              + '<td style="font-size:12px">' + m.pros.join('；') + '</td>'
              + '<td style="font-size:12px">' + m.cons.join('；') + '</td>'
              + '<td style="font-size:12px">' + m.when + '</td></tr>';
          });
          html += '</table>';

          // ① 判定
          const j1 = s => window.AKKC_hasConcept(String(s || ''), ['全系统', '全系统模拟', 'qemu', 'tcg', '完整系统']);
          if (String(v.a1 || '').trim()) {
            const ok = j1(v.a1);
            html += '<div class="lab-msg ' + (ok ? 'pass' : 'fail') + '"><b>① '
              + (ok ? '✅ 正确：全系统模拟' : '❌ 应该是全系统模拟') + '</b>'
              + '<div class="lab-note">因为需求是"<b>跑完整的 ARM Linux（含内核）</b>"。' +
              '应用级翻译只翻译 App 的 so，<b>它根本没有"guest 内核"这个概念</b>——' +
              '宿主内核直接就是 Android 的内核。<br>' +
              '要跑独立的 guest 内核，只能用全系统模拟（QEMU TCG 逐条翻译）。' +
              '代价是慢，但兼容性最好。</div></div>';
          }

          // ② 判定
          const j2 = s => window.AKKC_hasConcept(String(s || ''), ['应用级', '应用级翻译', 'houdini', 'ndk_translation', 'libndk']);
          if (String(v.a2 || '').trim()) {
            const ok = j2(v.a2);
            html += '<div class="lab-msg ' + (ok ? 'pass' : 'fail') + '"><b>② '
              + (ok ? '✅ 正确：应用级翻译' : '❌ 应该是应用级翻译') + '</b>'
              + '<div class="lab-note">关键在"<b>性能尽量接近原生</b>"这句话。' +
              '应用级翻译让 <b>x86 安卓以原生速度运行</b>，只把 App 里的 ARM so 翻译掉——' +
              '翻译面积从"整个系统"缩小到"一个 so"，性能差距自然小得多。<br>' +
              '对比：如果用全系统模拟，<b>连系统本身都要逐条翻译</b>，慢得没法日常使用。</div></div>';
          }

          // ③ 判定
          const a3 = String(v.a3 || '').trim();
          if (a3) {
            const hitNotTrans = window.AKKC_hasConcept(a3, ['不是翻译', '无关', '两回事', '不能', '解决不了', '不同层面', '内核架构', '不是一回事']);
            html += '<div class="lab-msg ' + (hitNotTrans ? 'pass' : 'warn') + '"><b>③ '
              + (hitNotTrans ? '✅ 抓到问题了' : '🟡 再想想') + '</b>'
              + '<div class="lab-note"><b>这个需求的前提就是错的：GKI 和"指令翻译"是两个完全无关的层面。</b><br><br>'
              + '<b>GKI 是什么：</b>Google 维护的通用内核镜像 + 厂商可加载模块，通过稳定 KMI 协作。' +
              '它解决的是<b>"内核碎片化"</b>问题（让 Google 能独立升级内核修漏洞）。<br><br>'
              + '<b>指令翻译是什么：</b>把一种 CPU 架构的机器码翻译成另一种，解决的是<b>"架构不兼容"</b>问题。<br><br>'
              + '换成 GKI 内核，<b>一条 ARM 指令也不会变成 x86 指令</b>。要跑 ARM App，' +
              '还是得靠应用级翻译（libhoudini / libndk_translation）或全系统模拟。</div></div>';
          }

          html += '<div class="lab-msg key"><b>🔑 一句话区分三者</b>'
            + '<div class="lab-note">'
            + '<b>全系统模拟</b> = 造一台完整的假机器（含假内核）→ 慢，但什么都能跑<br>'
            + '<b>应用级翻译</b> = 只把 App 的 so 翻译掉，系统本身原生跑 → 快，只解决 App 兼容<br>'
            + '<b>GKI</b> = 内核的<b>交付方式</b>（通用核心 + 厂商模块）→ <span class="bad">与指令翻译无关</span><br><br>'
            + '判断技巧：问"这个方案解决的是<b>架构不兼容</b>，还是<b>内核碎片化</b>？"<br>'
            + '前者是翻译问题，后者是内核工程问题。</div></div>';
          return html;
        },
        expected: (v) => {
          const ok1 = window.AKKC_hasConcept(String(v.a1 || ''), ['全系统', 'qemu', 'tcg']);
          const ok2 = window.AKKC_hasConcept(String(v.a2 || ''), ['应用级', 'houdini', 'ndk_translation', 'libndk']);
          const ok3 = window.AKKC_hasConcept(String(v.a3 || ''), ['不是翻译', '无关', '两回事', '不能', '解决不了', '不同层面', '内核架构']);
          const ok = ok1 && ok2 && ok3;
          return {
            ok,
            detail: ok
              ? '<b>三问全对。</b>① 全系统模拟（要跑 guest 内核）② 应用级翻译（要性能）' +
                '③ GKI 与指令翻译无关（它解决内核碎片化，不解决架构不兼容）。<br>' +
                '你已经把本章最容易混的三个概念分清了。'
              : (ok1 ? '' : '① 应为<b>全系统模拟</b>——需求要跑完整的 guest 内核。<br>')
                + (ok2 ? '' : '② 应为<b>应用级翻译</b>——需求强调"性能接近原生"，全系统模拟太慢。<br>')
                + (ok3 ? '' : '③ 关键错误是<b>把 GKI 当成了翻译方案</b>——GKI 是内核的交付方式，与指令翻译无关。')
          };
        },
        showAnswer:
          '【① 需求① → 全系统模拟（QEMU TCG）】\n' +
          '  因为要跑【完整的 ARM Linux（含内核）】。\n' +
          '  应用级翻译没有"guest 内核"这个概念，宿主内核就是内核。\n' +
          '  代价：逐条翻译整系统，慢；但兼容性最好。\n\n' +
          '【② 需求② → 应用级翻译（libhoudini / libndk_translation）】\n' +
          '  关键在"性能尽量接近原生"。\n' +
          '  x86 安卓原生速度跑，只把 App 的 ARM so 翻译掉。\n' +
          '  翻译面积：整个系统 → 一个 so，性能差距自然小。\n\n' +
          '【③ 需求③ 前提错误】\n' +
          '  GKI 和"指令翻译"是两个完全无关的层面：\n\n' +
          '  GKI 解决的是【内核碎片化】\n' +
          '    = Google 通用内核 + 厂商可加载模块 + 稳定 KMI\n' +
          '    → 让 Google 能独立升级内核修漏洞\n\n' +
          '  指令翻译解决的是【架构不兼容】\n' +
          '    = 把 ARM 机器码变成 x86 指令\n' +
          '    → 让 x86 能跑 ARM 代码\n\n' +
          '  换成 GKI 内核，一条 ARM 指令也不会变成 x86 指令。\n' +
          '  要跑 ARM App 还是得靠应用级翻译或全系统模拟。\n\n' +
          '【判断技巧】\n' +
          '  问：这个方案解决的是"架构不兼容"，还是"内核碎片化"？\n' +
          '    架构不兼容 → 翻译问题\n' +
          '    内核碎片化 → 内核工程问题',
        hint:
          '三个需求分别卡在三个不同的点上：<br>' +
          '① 关键词是"<b>完整的 ARM Linux（含内核）</b>"——应用级翻译有"guest 内核"这个东西吗？<br>' +
          '② 关键词是"<b>性能尽量接近原生</b>"——哪种方案的翻译面积最小？<br>' +
          '③ 这个需求<b>假设 GKI 能解决架构问题</b>。先问自己：GKI 到底解决什么问题？',
        after:
          T.note('key', '🔑 这个实验训练的是"概念分层"能力',
            '<p style="margin-bottom:0">很多人把 GKI 和翻译模式混为一谈，是因为它们<b>都出现在"模拟器"这个话题里</b>。<br>' +
            '但出现在同一章 ≠ 属于同一层。<br><br>' +
            '画一条线：<br>' +
            '<b>执行层</b>（代码怎么跑起来）：全系统模拟 / 应用级翻译<br>' +
            '<b>内核层</b>（内核怎么交付和维护）：GKI<br><br>' +
            '<span class="hit">这种"把概念按层归类"的能力，比记住每个概念的定义更有价值。' +
            '因为当你遇到一个新概念时，第一件事就是问它属于哪一层——' +
            '归对了层，它和什么有关、和什么无关，自然就清楚了。</span></p>')
      }
    },

    /* ================= 30.4C 实战案例 ================= */
    {
      h: '30.4C', title: '实战案例：从 logcat 里反推进程安全域——Audit 侧信道检测 root、scrcpy 与模拟器',
      case: {
        source: 'kanxue',
        title: '[原创] Audit 侧信道: Root, scrcpy 和模拟器的新型检测与绕过',
        date: '2026-5-20',
        author: 'vwvw',
        target: 'Android 三方 App 受限沙箱 + AOSP system/logging/logd/LogAudit.cpp；三类被检测对象：Magisk root 环境、AVD 模拟器（Android Studio 自带，M 芯片 Mac + Android 13 镜像，设备名 emu64a）、scrcpy 投屏',
        background:
          '<p>本章前面讲的检测，几乎都是「App 主动去问系统」：读 <code>Build.*</code>、读 <code>ro.kernel.qemu</code>、读 <code>/proc/cmdline</code>、看有没有 <code>/dev/qemu_pipe</code>。' +
          '这篇帖子讲的是<b>另一条完全不同的路</b>——不去读，而是<b>去碰</b>，然后从系统自己留下的日志里把答案读出来。</p>' +
          '<p>帖子的战场是<b>受限沙箱里的三方 App</b>（作者自己的 <code>com.vwww.mira</code>，安全域 <code>u:r:untrusted_app_27:s0:...</code>）和 AOSP 的 ' +
          '<code>system/logging/logd/LogAudit.cpp</code>。作者用它分别去识别三类东西：<b>Magisk root 环境</b>、<b>AVD 模拟器</b>' +
          '（Android Studio 自带，M 芯片 Mac + Android 13 镜像，设备名 <code>emu64a</code>）、以及 <b>scrcpy 投屏</b>。</p>' +
          '<p>帖子的题眼是那句总结：<b>「这条链路绕过的不是 SELinux 权限检查本身，而是利用权限检查失败后的诊断信息。」</b></p>',
        points: [
          '<b>侧信道核心思路</b>：三方 App 在受限沙箱里即使<b>不能直接读取其他进程的 <code>/proc/&lt;pid&gt;</code></b>，也可以通过访问 procfs <b>触发 SELinux Audit 日志</b>，再从 logcat 里的 <b><code>tcontext</code></b> 反推出目标进程的安全域。',
          '<b>完整信息链</b>：App 触碰 <code>/proc/&lt;pid&gt;</code> → SELinux 拒绝访问 → kernel 产生 audit 记录 → audit 记录通过 netlink 到 logd → logd 写入 main 或 events 日志缓冲 → App 侧通过 logcat 看到 <code>tcontext</code>。',
          '<b>Magisk 场景</b>：分块扫描从 <code>900</code> 开始按窗口触碰 <code>/proc/&lt;pid&gt;</code>，<b>每个窗口 25 个 PID</b>，命中后停止；命中窗口 <b>1025-1049</b>，日志暴露 <code>tcontext=u:r:magisk:s0</code>。',
          '<b>日志样本</b>：<code>avc: denied { getattr } for comm="sh" path="/proc/1028" dev="proc" ... scontext=u:r:untrusted_app_27:s0:... tcontext=u:r:magisk:s0 tclass=dir permissive=0 app=com.vwww.mira</code>。',
          '<b>AVD 模拟器特征（进程级实测）</b>：<code>ps -e | grep qemu</code> → <code>root 158 1 10780188 2184 0 0 S qemu-props</code>；<code>grep goldfish</code> → <code>[irq/46-goldfish]</code>（pid 152）、<code>android.hardware.media.c2@1.0-service-goldfish</code>（media 317）、<code>libgoldfish-rild</code>（radio 370）；<code>grep anchu</code> → <code>android.hardware.gnss@2.0-service.ranchu</code>（gps 777）。',
          '<b>推荐匹配正则</b>：<code>MATCH=\'tcontext=u:r:qemu_props:s0|tcontext=u:r:[^ ]*(goldfish|ranchu|qemu)[^ ]*:s0\'</code>。',
          '<b>scrcpy 场景（无文件特征）</b>：新版本基于 <b>adb shell 拉起 <code>app_process</code></b> 运行自己的 jar 包，<b>运行起来会删除 <code>/data/local/tmp/scrcpy-server.jar</code> 文件，没有文件特征</b>。',
          '<b>scrcpy 的进程链特征</b>：<code>sh -&gt; app_process -&gt; app_process</code> 三个进程 <b>pid 很相近</b>（实测 27769 <code>sh</code> / 27771 <code>app_process</code> / 27800 <code>app_process</code>）。',
          '<b>判定策略</b>：<b>「连续 3 个 <code>u:r:shell:s0</code>」</b>可作为疑似投屏的判据；作者强调「具体需要线上环境验证，这里只是提供一个思路」。',
          '<b>启停对照</b>：关闭投屏后，相同高 PID 范围扫描结果为 <code>no_shell_domain_hit</code>。',
          '<b>扫描稳定性教训（重要）</b>：该侧信道<b>不适合无脑大范围扫描</b>，「实验中出现过单点命中, 大窗口扫描反而漏检的情况」。',
          '<b>漏检的两个原因</b>：① SELinux audit 日志存在<b>限流</b>；② <b>大窗口会制造大量无关 denial</b>，目标 PID 落在窗口后段时可能被噪声淹没。',
          '<b>推荐扫描参数</b>：<code>START=1000 END=2500 CHUNK=10 STEP=10 WAIT_SEC=1 LOG_TAIL=400</code>；作者明确说「<b>不要只增加 <code>sleep</code>，因为失败原因通常不是日志延迟，而是 audit 限流和窗口噪声</b>」。',
          '<b>AOSP 根因在 <code>LogAudit::logPrint</code></b>：logd 收到 audit 消息后先格式化 <code>int rc = vasprintf(&amp;str, fmt, args);</code>，此时 <code>str</code> 已含 <code>dev="proc"</code>、<code>scontext</code>、<code>tcontext</code>、<code>tclass</code>、<code>comm</code>、<code>path</code>。',
          '随后 <code>pidToUid(pid)</code> 解析 UID，当 <b><code>uid &gt;= AID_APP_START &amp;&amp; uid &lt;= AID_APP_END</code></b> 时追加 <code>result.append(" app="s + uidname)</code>（<code>uidname = android::uidToName(uid)</code>）。',
          '<b>双缓冲</b>：<code>logbuf->Log(LOG_ID_EVENTS, ...)</code> 写入 events buffer，后续还会构造 <b>main buffer</b> 日志 ⇒ <b>同一条 procfs denial 可能进入 main buffer 和 events buffer</b>。',
          '<b>根因一句话</b>：「<b><code>hidepid=2</code> 保护的是 procfs 正常读取面，但原 logd 路径把 procfs 访问失败后的 audit 诊断信息转发到了 App 可见日志面。</b>」',
          '<b>AOSP 补丁 3725346 的修复逻辑</b>：<code>if (uid &gt;= AID_APP_START &amp;&amp; strstr(str, "dev=\\"proc\\"")) { free(str); return 0; }</code>——两个条件：① 只过滤 App UID 触发的 audit；② 只过滤 procfs 相关。',
          '「补丁<b>没有泛化过滤所有 SELinux denial</b>，而是精准阻断这条通过 <code>/proc/&lt;pid&gt;</code> 泄露其他进程安全域的路径。」',
          '<b>SELinux audit 结构字段</b>：<code>avc: denied</code>、<code>{ getattr }</code>（<b>目录元数据探测即可触发</b>）、<code>path</code>（指向 <code>/proc/&lt;pid&gt;</code>）、<code>dev="proc"</code>、<code>scontext</code>（发起方）、<b><code>tcontext</code>（目标方——侧信道泄露的核心字段）</b>、<code>tclass</code>（如 <code>dir</code>）。',
          '<b>为何 <code>priv_app</code> 的 <code>s0:c512,c768</code> 是算出来的</b>：<code>set_range_from_level()</code> 的 <code>LEVELFROM_USER</code> 分支 <code>snprintf(level, sizeof level, "s0:c%u,c%u", 512 + (userid &amp; 0xff), 768 + (userid &gt;&gt; 8 &amp; 0xff));</code>；主用户 userId=0 时算出 <b><code>c512</code> 和 <code>c768</code></b>。',
          '<b>作者被公开指正的错误</b>：原本用 <code>untrusted_app</code> 的特征去匹配 <code>priv_app</code>，经 <code>mb_bvvcoitr</code> 指正后更正，并自评「<b>我原来的写法驴唇不对马嘴</b>」。',
          '<b>隐藏成本</b>：「若想隐藏，要么使用修复后系统，要么就是得 root 设备然后 hook 系统框架将这部改掉，但<b>就会引入新的特征进入 root 对抗的范畴。提高攻击方的成本。</b>」'
        ],
        method: [
          '先看清约束：三方 App 在受限沙箱里读不了其他进程的 <code>/proc/&lt;pid&gt;</code>，直接探测这条路本身就是被 SELinux 拦住的。',
          '换个方向——不追求读到内容，而是把「被拒绝」这件事当成信号：主动触碰 procfs，触发 SELinux 拒绝与 audit 记录。',
          '跟一遍信息链：App 触碰 <code>/proc/&lt;pid&gt;</code> → SELinux 拒绝 → kernel 产生 audit 记录 → netlink 送给 logd → logd 写入 main 或 events 缓冲 → App 侧用 logcat 读到 <code>tcontext</code>。',
          '先打 Magisk：分块扫描从 <code>900</code> 开始按窗口触碰 <code>/proc/&lt;pid&gt;</code>，每个窗口 25 个 PID，命中即停；命中窗口落在 1025-1049，<code>tcontext=u:r:magisk:s0</code> 直接暴露。',
          '再打 AVD 模拟器：不读属性，改看进程级特征——<code>ps -e | grep qemu</code> 抓到 <code>qemu-props</code>，<code>grep goldfish</code> 抓到 <code>[irq/46-goldfish]</code>、<code>android.hardware.media.c2@1.0-service-goldfish</code>、<code>libgoldfish-rild</code>，<code>grep anchu</code> 抓到 <code>android.hardware.gnss@2.0-service.ranchu</code>。',
          '把这些名字收成一条正则：<code>MATCH=\'tcontext=u:r:qemu_props:s0|tcontext=u:r:[^ ]*(goldfish|ranchu|qemu)[^ ]*:s0\'</code>。',
          '再打 scrcpy：它没有文件特征（<code>/data/local/tmp/scrcpy-server.jar</code> 运行起来就被删），但进程链留痕——<code>sh -&gt; app_process -&gt; app_process</code>，三个 pid 很相近；于是改用<b>「连续 3 个 <code>u:r:shell:s0</code>」</b>作为疑似投屏的判据。',
          '做启停对照验证：关闭投屏后，相同高 PID 范围扫描结果为 <code>no_shell_domain_hit</code>。',
          '调扫描参数并总结教训：用 <code>START=1000 END=2500 CHUNK=10 STEP=10 WAIT_SEC=1 LOG_TAIL=400</code>，把窗口收到 10 而不是一味开大——实验中出现过单点命中、大窗口反而漏检，原因是 audit 限流与大窗口噪声。',
          '追上 AOSP 根因：读 <code>LogAudit::logPrint</code>，看到先 <code>vasprintf(&amp;str, fmt, args)</code> 拿到含 <code>tcontext</code> 的完整字符串，再按 <code>uid &gt;= AID_APP_START &amp;&amp; uid &lt;= AID_APP_END</code> 追加 <code>app=</code> 字段，并分别写入 events buffer 与 main buffer。',
          '最后看官方怎么修的：AOSP 补丁 3725346 只加两个条件——App UID + <code>dev="proc"</code>——精准堵掉这一条路径，而不是泛化过滤所有 denial。'
        ],
        result:
          '<p>作者用这条链路<b>分别识别出了 Magisk root 环境（<code>tcontext=u:r:magisk:s0</code>）、AVD 模拟器（<code>qemu-props</code> / <code>goldfish</code> / <code>ranchu</code>）与 scrcpy 投屏（连续 3 个 <code>u:r:shell:s0</code>）</b>，' +
          '并做了启停对照（关闭投屏后扫描结果为 <code>no_shell_domain_hit</code>）。</p>' +
          '<p>更完整的成果是<b>根因定位与官方修复的对应</b>：问题出在 <code>LogAudit::logPrint</code> 把 procfs 访问失败后的 audit 诊断信息转发到了 App 可见的日志面，' +
          'AOSP 补丁 <b>3725346</b> 用「App UID + <code>dev="proc"</code>」两个条件精准阻断。</p>',
        terms: ['SELinux', 'tcontext', 'scontext', '安全域', 'avc: denied', 'AID_APP_START', 'logd', 'LogAudit::logPrint', 'main buffer', 'events buffer', 'hidepid=2', 'procfs', '侧信道', 'Magisk', 'AVD / goldfish / ranchu', 'scrcpy', 'app_process', 'AOSP 补丁 3725346'],
        limits:
          '<p>这份材料的缺口和作者自己的保留意见都很明确，逐条列出：</p>' +
          '<p>① <b>「绕过」一节的开头存在一个看雪加密块，无法解密，其内容未知</b>——所以本文只写了「检测」这一半，绕过部分本站不做推测；<br>' +
          '② 多处参考链接是 <code>elink@...</code> 加密跳转，无法解析；<br>' +
          '③ 作者明确标注 scrcpy 部分<b>「具体需要线上环境验证, 这里只是提供一个思路」</b>；<br>' +
          '④ 作者自述失败：<b>「该侧信道不适合无脑大范围扫描，实验中出现过单点命中，大窗口扫描反而漏检的情况」</b>；<br>' +
          '⑤ 作者自述曾被指正的错误（用 <code>untrusted_app</code> 的特征去匹配 <code>priv_app</code>）并已更正；<br>' +
          '⑥ 配图为 webp 附件，无法读取；<br>' +
          '⑦ 页面末尾有「回复或点赞可查看完整内容」标记。</p>' +
          '<p>因此这条侧信道应当被理解成一个<b>思路与工程参数</b>，而不是一个可以直接照抄的检测模块——作者本人也只把它当作思路给出。</p>',
        analysis:
          '<p><b>本章第 30 章教会你怎么识别环境特征，这个案例给出的是「当代检测视角」，而且它揭示了一条比改属性更深的思路。</b></p>' +
          '<p><b>① 检测点的层级跳跃：从「主动读」到「被动看副作用」。</b>' +
          '本章前面讲的检测大多是读属性、读文件、读 <code>/proc</code>——都是 App 主动去问系统要信息。' +
          '这个案例不问题系统，它<b>去碰 procfs，然后利用系统自己被拒绝时留下的日志</b>，属于被动侧信道。' +
          '这提醒我们：<span class="hit">检测面不只在「你能读到的信息」，还在「你操作时系统产生的副作用」</span>。<br>' +
          '而这句话正是第 24 章那条元原则的跨章呼应——<b>本课第 24 章讲过：混淆保护的是逻辑，保护不了副作用。</b>' +
          '第 24 章用它来找检测点（挂 <code>strstr</code> 从副作用反推），这里反过来被防守方用来暴露攻击者：' +
          '<b>你拦截一次访问，就必然留下一次拦截记录；你留下一份记录，就等于把你的安全域告诉了对方。</b>' +
          'SELinux 的 deny 不是「什么都没发生」，而是一条带着 <code>tcontext</code> 的广播。</p>' +
          '<p><b>② 具体的模拟器特征：从 audit 日志里看 <code>goldfish</code> / <code>ranchu</code> / <code>qemu</code>。</b>' +
          '本章讲模拟器痕迹时提到的 <code>goldfish</code>、<code>ranchu</code>，在这里以 SELinux 域名的形式再次出现：' +
          '<code>tcontext=u:r:qemu_props:s0</code>，以及 <code>u:r:[^ ]*(goldfish|ranchu|qemu)[^ ]*:s0</code> 这种匹配方式。' +
          '<b>这些东西与本章讲的 QEMU 痕迹是同一类东西——它们是虚拟化架构的必然产物</b>，只是观测位置不同：' +
          '一个是读 <code>/proc/cmdline</code>、查属性，一个是从 audit 日志里看。<br>' +
          '<span class="hit">换个观测位置就能把同一批特征再抓一遍，这正是「检测是分层工程」的含义</span>——' +
          '你在 App 层清理掉的东西，可能在内核日志层原样还在。第 30 章讲的「改名不改结构会被交叉检测抓到」，这里是它的升级版：' +
          '<b>改 App 层的读取面，不改内核层的诊断面，一样会被抓到。</b></p>' +
          '<p><b>③ 一个非常实用的工程教训：「大窗口扫描反而漏检」。</b>' +
          '直觉上扫描应该「扫得越全越好」，作者实测却相反——出现单点命中、大窗口漏检。原因有两个：' +
          '<b>SELinux audit 日志有限流</b>，以及<b>大窗口制造的大量无关 denial 会把目标淹没</b>。' +
          '所以正确做法是收窄窗口（<code>CHUNK=10 STEP=10</code>），而不是加大 <code>sleep</code>、也不是开大窗口；' +
          '作者那句话值得原样记住：<b>「不要只增加 <code>sleep</code>，因为失败原因通常不是日志延迟，而是 audit 限流和窗口噪声」</b>。<br>' +
          '<b>这条经验的价值在于它反直觉</b>：<span class="hit">直觉上「扫得越全越好」，实际上「扫得越细越准」</span>。' +
          '更普遍地说，<b>当你的采集手段本身会干扰被采集的系统（限流、噪声、副作用）时，「加大力度」往往让结果更差而不是更好</b>——' +
          '这在 Frida 大规模 trace、Stalker 长时间开启上是同一个道理（第 24 章）。</p>' +
          '<p><b>④ 作者的诚实最值得学。</b>他把「被大佬指正、我原来驴唇不对马嘴」直接写进文章，还标注 scrcpy 部分「只是思路、需线上验证」，' +
          '并交代了隐藏成本——想藏就得改系统框架，而<b>那会把问题推进 root 对抗的范畴，提高攻击方的成本</b>。' +
          '这跟本课程反复强调的纪律是同一条：<b>区分「我知道」和「我推测」</b>。<br>' +
          '对照来看更清楚：他敢把「连续 3 个 <code>u:r:shell:s0</code>」写成判据，是因为启停对照跑过了（关闭投屏得到 <code>no_shell_domain_hit</code>）；' +
          '他把 scrcpy 标注为「只是思路」，是因为线上环境还没验。<span class="hit">这条区分线画在哪里，决定了你的结论能不能被别人复用。</span></p>',
        link: 'https://bbs.kanxue.com/thread-291290.htm',
        linkNote: '看雪论坛原创帖'
      }
    },

    /* ================= 30.4 ================= */
    {
      h: '30.4',
      title: 'GKI：把安卓内核拆成「通用核心 + 厂商模块」',
      html:
        '<p>安卓生态有一个持续多年的顽疾：<b>内核碎片化</b>。每台设备的 SoC 不同、驱动不同，厂商各自 fork 一份 Linux 内核改一改，于是市面上存在成百上千个互不相同的内核分支。后果是：Google 修了一个内核安全漏洞，<b>必须等每一个厂商把自己的分支合一遍</b>——而现实中很多设备永远等不到。</p>'
        + '<p><span class="term" data-def="Generic Kernel Image，通用内核镜像：Google 统一维护、与硬件解耦的安卓内核">GKI</span> 是针对这个问题的解法。核心思想一句话：<b>把内核拆成「通用核心 + 厂商模块」</b>。</p>'
        + T.grid(2, [
          '<div class="card"><div class="card-title">过去：一个大内核，人人有份</div><p>厂商 fork 内核 → 把驱动直接编进内核（<span class="mono">built-in</span>）→ 内核成了「通用代码 + 厂商代码」的混合体 → 谁也没法单独升级。</p></div>',
          '<div class="card"><div class="card-title">GKI：内核与驱动解耦</div><p>Google 维护一份统一的 GKI 内核（<span class="mono">Image</span> / <span class="mono">Image.gz</span>）；厂商的硬件驱动做成<b>可加载内核模块</b>（<span class="mono">.ko</span>），在启动时由 <span class="term" data-def="Kernel Module Interface，内核模块接口，GKI 的核心稳定契约">KMI</span> 动态装载。</p></div>'
        ])
        + T.note('key', '🔑 KMI 是这套方案的「合同」',
          '<p><b>KMI（Kernel Module Interface）</b>是内核与模块之间稳定的接口契约：符号表、结构体布局、函数签名。只要 KMI 不变，<b>内核可以被替换、模块不用重编</b>。</p>'
          + '<p>于是升级链变成两条互不干扰的线：<br>'
          + '<b>Google 侧</b>：独立升级 GKI 内核 → 修安全漏洞、合上游 LTS 补丁，<b>不用等厂商</b>；<br>'
          + '<b>厂商侧</b>：只维护自己的驱动模块 → 内核换了，模块照样能用。</p>'
          + '<p>这就是为什么 GKI 被称作 Android 内核治理的结构性改变：它把「一次升级」拆成了「两个独立发布的单元」。</p>')
        + T.note('warn', '⚠️ 内核镜像到底在哪个分区？（<span class="pill warn">待核实</span> 细节）',
          '<p>概念上要知道的演变：<b>Android 12+</b> 引入了 <span class="mono">init_boot</span> 分区用来存放<b>通用 ramdisk</b>，<b>Android 13+</b> 强制要求。<span class="mono">vendor_boot</span> 则承载厂商相关的启动内容（厂商 ramdisk、部分模块）。</p>'
          + '<p>所以 GKI 部署后，内核与 ramdisk 的归属被拆分到 <span class="mono">boot.img</span> / <span class="mono">vendor_boot.img</span> / <span class="mono">init_boot.img</span> 之间。<b>具体哪个分区放什么、镜像格式（header version、vendor boot header）在不同版本和不同厂商实现上有差异，动手前请用 <span class="mono">unpack_bootimg</span> 之类的工具实际解析确认，不要照抄教程。</b><span class="pill warn">待核实</span></p>'),
      stage: {
        title: 'GKI 的分层结构：Google 升级内核 vs 厂商更新驱动',
        speed: 1800,
        render:
          '<div class="flow-col">'
          + '<div class="blk" id="g1">Google 维护：GKI 通用内核核心<br><span class="small">Image / Image.gz · 调度、内存、文件系统、安全</span></div>'
          + '<div class="arrow">↓ 通过 <b>KMI</b> 暴露稳定接口 ↓</div>'
          + '<div class="pill" id="g2">KMI · Kernel Module Interface（稳定契约）</div>'
          + '<div class="arrow">↓ 动态加载 ↓</div>'
          + '<div class="flow-row">'
          + '<div class="blk" id="g3">厂商模块 A<br><span class="small">显示驱动 .ko</span></div>'
          + '<div class="blk" id="g4">厂商模块 B<br><span class="small">相机 / ISP .ko</span></div>'
          + '<div class="blk" id="g5">厂商模块 C<br><span class="small">电源 / 充电 .ko</span></div>'
          + '</div>'
          + '<div class="arrow">↓ 打包进启动分区 ↓</div>'
          + '<div class="flow-row">'
          + '<div class="blk" id="g6">boot.img<br><span class="small">GKI 内核 + 通用 ramdisk</span></div>'
          + '<div class="blk" id="g7">vendor_boot.img<br><span class="small">厂商 ramdisk / 模块</span></div>'
          + '<div class="blk" id="g8">init_boot.img<br><span class="small">通用 ramdisk（12+/13+）</span></div>'
          + '</div>'
          + '<div class="pill" id="g9">起始状态</div>'
          + '</div>',
        reset: () => {
          ['g1', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8'].forEach((id) => S(id, ''));
          CLS('g2', 'pill'); SET('g2', 'KMI · Kernel Module Interface（稳定契约）');
          CLS('g9', 'pill'); SET('g9', '起始状态');
        },
        steps: [
          { run: () => S('g1', 'active'),
            note: '<b>最上层只有一份内核。</b>它由 Google 统一维护，与具体硬件无关。你在真机上 <span class="mono">uname -r</span> 看到的 <span class="mono">-androidXX-Y-gki</span> 之类的后缀，就是它的身份标记。' },
          { run: () => { S('g1', 'done'); SET('g2', 'KMI · 符号表 / 结构体布局 / 函数签名'); CLS('g2', 'pill acc'); },
            note: '<b>KMI 是整层的枢纽。</b>它规定了模块可以调用内核的哪些符号、结构体怎么排布、函数签名长什么样。KMI 稳定 = 模块不必随内核重编。' },
          { run: () => { S('g3', 'active'); },
            note: '<b>厂商模块 A（显示驱动）。</b>注意它<b>不是编进内核的</b>，而是一个独立的 <span class="mono">.ko</span>，启动时由内核加载。这正是「解耦」的物理体现。' },
          { run: () => { S('g3', 'done'); S('g4', 'active'); },
            note: '<b>厂商模块 B（相机 / ISP）。</b>每个模块都只依赖 KMI，不依赖某个具体内核版本。厂商的维护工作量从「整个内核分支」降到「几个驱动模块」。' },
          { run: () => { S('g4', 'done'); S('g5', 'active'); },
            note: '<b>厂商模块 C（电源 / 充电）。</b>模块之间也彼此独立——一个模块出问题，不必重编整个内核。' },
          { run: () => { S('g5', 'done'); S('g6', 'active'); S('g7', 'active'); S('g8', 'active'); },
            note: '<b>这些部件被打包进不同的启动分区。</b>GKI 内核与通用 ramdisk 归 <span class="mono">boot.img</span> 一侧，厂商相关内容归 <span class="mono">vendor_boot.img</span>，通用 ramdisk 在 Android 12+/13+ 之后独立到 <span class="mono">init_boot.img</span>。<span class="pill warn">待核实</span> 具体切分随版本与厂商实现变化，动手请实际解包确认。' },
          { run: () => { S('g6', 'hot'); CLS('g9', 'pill bad'); SET('g9', '场景一：Google 推送内核安全更新'); },
            note: '<b>场景一：Google 升级内核。</b>只换 <span class="mono">g1</span>（GKI 内核镜像），<b>下面三个厂商模块一行都不用改</b>——因为 KMI 没变。这就是 GKI 最大的收益：安全补丁可以绕开厂商直接下发。' },
          { run: () => { S('g6', 'done'); S('g3', 'hot'); S('g4', 'hot'); S('g5', 'hot'); CLS('g9', 'pill acc'); SET('g9', '场景二：厂商更新驱动'); },
            note: '<b>场景二：厂商更新驱动。</b>只重编并替换自己的 <span class="mono">.ko</span>，<b>内核完全不受影响</b>。厂商不必再维护一个庞大的内核 fork，只维护自己那几个模块。' },
          { run: () => { ['g3', 'g4', 'g5'].forEach((id) => S(id, '')); S('g1', 'cool'); S('g6', 'cool'); CLS('g9', 'pill ok'); SET('g9', '两条升级线互不干扰 ✓'); },
            note: '<b>两条升级线彻底分开。</b>Google 修内核漏洞不阻塞在厂商手里，厂商改驱动不用重走内核评审。这是 GKI 想解决的根本问题——<b>不是性能，是升级速度与安全响应</b>。' },
          { run: () => { S('g1', 'cool'); S('g6', 'hot'); CLS('g9', 'pill bad'); SET('g9', '对逆向：内核可替换 = 内核级 Hook 的入口'); },
            note: '<b>对逆向的意义（对应第 27 章内核模块技术）。</b>GKI 让「换内核」变成一件<b>规范化、文档化</b>的事：内核是一个独立的、可替换的镜像文件，模块加载机制是标准接口。这意味着内核级 Hook / 反检测有了正规入口——你可以在自己的内核或自己的模块里做事，而不必去 patch 某个厂商的定制内核。' }
        ]
      },
      after: T.note('', 'GKI 对逆向工作流的三点影响',
        '<p>① <b>内核不再是黑盒。</b>过去厂商内核 fork 满天飞，同一个 hook 点在不同设备上偏移全不一样；GKI 让内核来源统一，可复现性大幅提升。</p>'
        + '<p>② <b>替换内核是可行路径。</b>因为内核镜像独立存在、KMI 有契约，理论上你可以准备一个自己编译的 GKI 内核镜像刷进去——这是比 patch 二进制更彻底的方案（当然也需要解锁 bootloader 等前提）。</p>'
        + '<p>③ <b>反检测要同步升级。</b>既然内核可替换、模块可加载，风控也会开始检查内核版本字符串、已加载模块列表、KMI 相关的符号是否存在。<b>攻防的战场从 App 层下沉到了内核镜像层。</b></p>')
    },

    /* ================= 30.5 ================= */
    {
      h: '30.5',
      title: 'GKI 内核的下载、解包与替换',
      html:
        '<p>理解了 GKI 的结构，就能理解「换内核」这件事为什么变得可行：<b>内核是一个独立的镜像文件，被放在一个独立的分区里</b>。替换它的流程和替换任何分区镜像一样——解包、换文件、重打包、刷入。</p>'
        + T.note('warn', '⚠️ 动手前的三条前提',
          '<p>① <b>Bootloader 必须解锁</b>，否则 <span class="mono">fastboot flash</span> 会被拒绝；<br>'
          + '② <b>必须刷对应 KMI 版本的内核</b>——KMI 不匹配，厂商模块加载会失败，设备可能起不来；<br>'
          + '③ <b>必须先备份原 boot 分区</b>，出事能救回来。<b>替换内核是高危操作，请在有恢复手段的设备上做。</b></p>'
          + '<p><span class="pill warn">待核实</span> 下面每一步的具体参数（分区名、压缩格式、mkbootimg 参数）都随设备与 Android 版本变化，<b>请用你设备实际解包出来的 header 信息为准</b>。</p>'),
      stepper: {
        title: 'GKI 内核替换：从确认版本到刷入设备',
        lines: [
          { code: '<span class="c"># ① 先确认设备当前的 KMI / 内核版本</span>\nadb shell uname <span class="n">-r</span>',
            note: '<b>第一步永远是「先看清楚现状」。</b><span class="mono">uname -r</span> 给出内核版本串，GKI 设备上通常带 <span class="mono">-gki</span> 或 <span class="mono">androidNN</span> 特征后缀。你要替换的内核，<b>KMI 版本必须和这里对得上</b>，否则厂商模块会加载失败。',
            state: { '当前内核': '（实际读出的版本串）', 'KMI 版本': '待确认' } },
          { code: 'adb shell cat <span class="m">/proc/version</span>',
            note: '<b>交叉验证。</b><span class="mono">/proc/version</span> 带编译信息（编译器版本、构建时间）。两个来源对一下，确认自己没有看错——这是后面选内核产物的依据。',
            state: { 'KMI 版本': '已确认' } },
          { code: '<span class="c"># ② 准备对应 KMI 的 GKI 内核产物</span>\n<span class="c">#    AOSP 以 prebuilt 形式分发 GKI 内核</span>\n<span class="c">#    <span class="pill warn">待核实</span>：具体仓库/分支名随版本变化</span>',
            note: '<b>关键：版本必须对齐。</b>GKI 内核按 KMI 版本分发（例如 <span class="mono">android12-5.10</span>、<span class="mono">android13-5.15</span> 这类「Android 版本 + 内核版本」的组合命名）。<b>下错版本 = 模块加载失败 = 设备起不来。</b><span class="pill warn">待核实</span> 具体命名与下载入口请查官方 documented 的内核分支说明。',
            mem: 'GKI 内核产物通常是：\nImage         （未压缩）\nImage.gz      （gzip 压缩）\nImage.lz4     （lz4 压缩，常见于移动设备）\n具体用哪个 → 看原 boot.img 里 kernel 段是什么格式' },
          { code: '<span class="c"># ③ 备份当前 boot 分区（救命步骤）</span>\nadb shell su <span class="n">-c</span> <span class="s">&quot;dd if=/dev/block/by-name/boot of=/sdcard/boot_backup.img&quot;</span>',
            note: '<b>不做这一步就不要往下走。</b>分区名 <span class="mono">by-name/boot</span> 是常见写法，但不同设备的分区布局不同（有的用 <span class="mono">/dev/block/bootdevice/by-name/</span>）。<b>刷坏了没有备份，就只能靠官方固件包救砖。</b>',
            state: { '备份': 'boot_backup.img 已生成' } },
          { code: 'adb pull <span class="m">/sdcard/boot_backup.img</span> ./boot_backup.img',
            note: '<b>把备份拉到电脑上。</b>放在手机里不算备份——万一设备进不了系统，你就拿不出来了。',
            state: { '备份': '已落盘到 PC' } },
          { code: '<span class="c"># ④ 解包 boot.img，看清内部结构</span>\nunpack_bootimg <span class="n">--boot_img</span> boot.img <span class="n">--out</span> ./unpacked/',
            note: '<b>这一步是整个流程的「诊断」环节。</b>解包后你会看到 <span class="mono">kernel</span>、<span class="mono">ramdisk</span>、以及一个 header 信息文件。先读 header 再动手——它会告诉你内核用的什么压缩格式、header 版本是几、cmdline 是什么。<b>不看 header 直接换文件，是最常见的翻车点。</b>',
            state: { 'header version': '（读出来确认）', '内核格式': '（读出来确认）' },
            mem: 'unpacked/\n  kernel          ← 要替换的目标\n  ramdisk         ← 通用 ramdisk（可能不在 boot 里）\n  bootimg-info.txt / header 信息\n（具体文件名随工具版本变化，<span class="pill warn">待核实</span>）' },
          { code: '<span class="c"># ⑤ 替换内核镜像</span>\ncp Image.lz4 ./unpacked/kernel',
            note: '<b>把 GKI 内核替换进去。</b>注意<b>压缩格式必须与原文件一致</b>：原 kernel 是 lz4，你就得放 lz4 版本；是 gzip 就放 gzip 版本。格式不对会导致内核无法解压，直接卡在开机第一屏。<b>这就是上一步必须先读 header 的原因。</b>',
            state: { 'kernel': '已替换为 GKI 内核', '格式校验': '与原文件一致 ✓' } },
          { code: '<span class="c"># ⑥ 重新打包（参数必须与原 header 对齐）</span>\nmkbootimg <span class="n">--kernel</span> ./unpacked/kernel \\\n  <span class="n">--header_version</span> &lt;原值&gt; \\\n  <span class="n">--cmdline</span> <span class="s">&quot;&lt;原 cmdline&gt;&quot;</span> \\\n  <span class="n">--output</span> new_boot.img',
            note: '<b>重打包不是「随便打一个」。</b>header version、cmdline、page size、os_version 等参数应当<b>沿用原镜像的值</b>——尤其 cmdline 里可能含有让系统正确启动的关键参数（如 Android 的 <span class="mono">androidboot.*</span> 项）。<span class="pill warn">待核实</span> 参数名与默认值随 mkbootimg 版本变化，请以你所用工具的 <span class="mono">--help</span> 为准。',
            state: { '产物': 'new_boot.img' } },
          { code: '<span class="c"># ⑦ 进入 fastboot 并刷入</span>\nadb reboot bootloader\nfastboot flash boot new_boot.img',
            note: '<b>刷入。</b>这一步会覆盖 boot 分区。刷之前再确认一次：<b>设备型号对不对？分区名是不是 <span class="mono">boot</span>？备份是不是已经拉到电脑上了？</b>',
            state: { 'boot 分区': '已写入新内核' } },
          { code: 'fastboot reboot',
            note: '<b>重启。</b>如果卡在开机 logo 或反复重启，通常就是三个原因之一：内核压缩格式不对、KMI 版本不匹配、cmdline/header 参数错了。这时用备份恢复：<span class="mono">fastboot flash boot boot_backup.img</span>。' },
          { code: 'adb shell uname <span class="n">-r</span>\nadb shell getprop <span class="m">ro.boot.verifiedbootstate</span>',
            note: '<b>验证。</b>内核版本串应该已经变了。同时看一眼 verified boot 状态——修改 boot 分区通常会导致验证失败（这也是为什么很多设备需要解锁并使用 <span class="mono">vbmeta</span> 相关处理）。<b>刷成功 ≠ 系统功能正常</b>，还要验证摄像头、WiFi、充电这些依赖厂商模块的功能。' },
          { code: 'adb shell lsmod\n<span class="c"># 或 cat /proc/modules</span>',
            note: '<b>最后确认模块有没有正常加载。</b>这直接对应 GKI 的核心契约：<b>内核换了，模块还认不认这个 KMI？</b>如果 <span class="mono">lsmod</span> 里厂商模块不在了，说明 KMI 不匹配——内核虽然起来了，硬件功能会大面积失效。这一刻你会真正体会到 KMI 为什么被叫作「合同」。',
            state: { '厂商模块': '（lsmod 里应能看到）', '结论': 'KMI 匹配 → ✓' } }
        ]
      },
      after: T.note('', '对逆向的用法',
        '<p>替换 GKI 内核是一条<b>干净的内核级 Hook 路径</b>——对应第 27 章的内核模块技术。相比在厂商定制内核上做二进制 patch，GKI 路线有三个优势：<b>内核来源统一可复现</b>、<b>模块加载是标准接口</b>、<b>升级路径清晰</b>。</p>'
        + '<p>反过来，做反检测时也要意识到：<b>内核版本字符串、已加载模块列表、boot 分区哈希</b>都是可以检测的对象。换过内核的环境，在这些维度上会留下痕迹。</p>')
    },

    /* ================= 30.6 ================= */
    {
      h: '30.6',
      title: 'Cuttlefish：Google 官方的云端虚拟安卓设备',
      html:
        '<p><span class="term" data-def="Google 的 android-cuttlefish 项目，面向云端的可配置安卓虚拟设备">Cuttlefish</span> 是本章第三个主角。它不是「给终端用户用的模拟器」，而是<b>为云端设计的安卓虚拟设备</b>。官方 <span class="mono">google/android-cuttlefish</span> 仓库的原文定位是：</p>'
        + '<p style="border-left:3px solid var(--acc,#6cf);padding-left:12px;font-style:italic">「a configurable Android Virtual Device (AVD) that targets both locally hosted Linux x86/arm64 and remotely hosted Google Compute Engine (GCE) instances rather than physical hardware.」</p>'
        + T.note('key', '🔑 一句话记住它和模拟器的区别',
          '<p><b>Android 官方模拟器</b>：面向<b>开发者个人</b>，跑在开发者电脑上，重点是「好用、能调试」。</p>'
          + '<p><b>Cuttlefish</b>：面向<b>服务器与 CI/CD</b>，跑在 Linux（本地或 GCE）上，重点是「可编排、可规模化、可远程」。</p>'
          + '<p>它主要服务于 <b>AOSP 开发与测试</b>——Google 自己跑自动化测试就用它。<b>它是理解「云手机/云测设备」的关键一环：很多云手机方案本质就是 Cuttlefish 或其变体。</b></p>')
        + T.note('warn', '⚠️ 依赖 KVM，所以需要 Linux + 硬件虚拟化',
          '<p>Cuttlefish 依赖 <b>KVM</b>（Linux 内核的硬件虚拟化设施）。这意味着：<b>你得有 Linux，且 CPU 支持并开启了虚拟化扩展</b>；在虚拟机里套娃跑（nested virtualization）通常还要额外开启。这也是它和「应用级容器方案」最大的分界。</p>'
          + '<p>它还支持<b>容器镜像</b>形式（Docker / Podman），这让它在 CI 里更容易被拉起。</p>'),
      term: {
        title: 'Cuttlefish：在 Debian/Ubuntu 上安装并准备环境',
        lines: [
          { t: 'p', s: 'sudo apt install -y cuttlefish-base cuttlefish-user',
            note: '<b>装两个包。</b><span class="mono">cuttlefish-base</span> 是<b>必需</b>的基础包；<span class="mono">cuttlefish-user</span> 提供本地 web server，让你能从浏览器里与设备交互。' },
          { t: 'd', s: '# 其他相关包：cuttlefish-integration（在 GCE 上运行）', },
          { t: 'd', s: '#           cuttlefish-orchestration（编排项目）', },
          { t: 'd', s: '#           cuttlefish-common（已废弃，仅为兼容保留的 metapackage）', },
          { t: 'p', s: 'sudo usermod -aG kvm,cvdnetwork,render $USER',
            note: '<b>把当前用户加入三个组</b>——这是安装文档明确要求的步骤：<span class="mono">kvm</span>（访问 <span class="mono">/dev/kvm</span>，硬件虚拟化）、<span class="mono">cvdnetwork</span>（Cuttlefish 的虚拟网络）、<span class="mono">render</span>（GPU 渲染设备）。<b>不加组，跑起来会各种权限被拒。</b>' },
          { t: 'w', s: '⚠️ 加组之后必须重启（或重新登录）才生效', },
          { t: 'p', s: 'sudo reboot',
            note: '<b>重启使组成员变更生效。</b>这一步常被跳过，然后卡在「为什么 /dev/kvm 打不开」上很久。' },
          { t: 'p', s: 'ls -l /dev/kvm',
            note: '<b>验证 KVM 可用。</b>设备节点存在且你有权限，才具备继续的前提。' },
          { t: 'o', s: 'crw-rw---- 1 root kvm 10, 232 ... /dev/kvm', },
          { t: 'p', s: 'egrep -c &quot;(vmx|svm)&quot; /proc/cpuinfo',
            note: '<b>确认 CPU 支持虚拟化</b>：<span class="mono">vmx</span> 是 Intel VT-x，<span class="mono">svm</span> 是 AMD-V。输出为 0 说明 BIOS 里没开或硬件不支持。<b>KVM 是 QEMU、Cuttlefish、crosvm 的共同底座</b>——这条命令检查的正是整个虚拟化方案的地基。' },
          { t: 'p', s: 'cvd version',
            note: '<b>检查 Cuttlefish 工具链。</b><span class="mono">cvd</span>（Cuttlefish Device）是它的命令行入口。具体子命令与参数<span class="pill warn">待核实</span>，请以 <span class="mono">cvd help</span> 与你所用版本为准。' },
          { t: 'p', s: 'cvd load <配置名>   # 启动一个虚拟设备',
            note: '<b>启动设备。</b>Cuttlefish 支持用配置文件描述「要一台什么样的设备」——这正对应官方定位里的 <b>configurable</b>。启动后可以用 <span class="mono">cuttlefish-user</span> 提供的 web 界面交互，也可以用 <span class="mono">adb connect</span> 连上去。<span class="pill warn">待核实</span> 具体子命令与配置文件格式随版本变化。' }
        ]
      },
      after: T.note('', '为什么逆向工程师要在意 Cuttlefish',
        '<p>① <b>它是云手机的「官方参考答案」。</b>云手机要解决的问题——多实例、远程访问、编排与回收、无物理硬件——Cuttlefish 全都正面处理过。<b>理解了它，云手机的架构就不再神秘。</b></p>'
        + '<p>② <b>它代表「干净、可控、可复现」的安卓环境。</b>CI 里跑安全测试、跑自动化逆向脚本，一个可脚本化创建/销毁的虚拟设备比一台真机好用得多。</p>'
        + '<p>③ <b>它站在硬件虚拟化这条技术路线上</b>——和 QEMU + KVM、crosvm 同宗。而 Waydroid 那类容器方案走的是完全不同的路（共享宿主内核）。<b>这个分野，是下一节谱系图的主轴。</b></p>')
    },

    /* ================= 30.7 ================= */
    {
      h: '30.7',
      title: '一张图看懂：模拟器、Cuttlefish、云手机、Waydroid 的谱系',
      html:
        '<p>这一节把整门课「运行环境」部分的方案放到一张图上。判断一个方案，只要问三个问题：<b>① 它虚拟化到什么层次？② 它跑的是不是原生架构？③ 它是给谁用的？</b></p>'
        + T.tbl(['方案', '技术路线', '跑的系统架构', '典型场景'], [
          ['Android 官方模拟器（QEMU + HAXM/Hyper-V）', '硬件虚拟化 + 应用级翻译层', 'x86_64 为主', '开发者本机调试'],
          ['Android 官方模拟器（早期，QEMU + TCG）', '全系统模拟（二进制翻译）', 'ARM / ARM64', '历史方案，慢'],
          ['Cuttlefish（google/android-cuttlefish）', '硬件虚拟化（依赖 KVM）', 'x86 / arm64，宿主 Linux', 'AOSP 开发、CI/CD、云端'],
          ['云手机 / 云测', '硬件虚拟化 + 多租户编排 + 串流', '通常 x86_64', '规模化测试、远程真机替代'],
          ['Waydroid', '容器（共享宿主内核）', '与宿主同架构', 'Linux 桌面上跑安卓应用']
        ]),
      stage: {
        title: '方案谱系：从「全系统模拟」到「容器」',
        speed: 1900,
        render:
          '<div class="flow-col">'
          + '<div class="pill" id="x0">全部方案的共同底座：KVM / 硬件虚拟化扩展</div>'
          + '<div class="arrow">↓ 按「虚拟化层次」从重到轻排列 ↓</div>'
          + '<div class="blk" id="x1">① 全系统模拟<br><span class="small">QEMU + TCG：guest 架构可 ≠ host。ARM 安卓跑在 x86 上，每条指令都翻译</span></div>'
          + '<div class="blk" id="x2">② 硬件虚拟化<br><span class="small">QEMU + KVM / HAXM / Hyper-V：guest 与 host 同架构，CPU 直接跑 guest 指令</span></div>'
          + '<div class="blk" id="x3">③ 虚拟化 + 翻译层（现代主流）<br><span class="small">x86_64 系统镜像 + libhoudini / libndk_translation：只翻译 App 的 ARM .so</span></div>'
          + '<div class="blk" id="x4">④ 云端编排<br><span class="small">Cuttlefish（KVM）→ 云手机 / 云测：多实例、远程串流、按需创建销毁</span></div>'
          + '<div class="blk" id="x5">⑤ 容器方案<br><span class="small">Waydroid 等：共享宿主内核，不是虚拟机，架构必须与宿主一致</span></div>'
          + '<div class="pill" id="x9">起始状态</div>'
          + '</div>',
        reset: () => {
          ['x1', 'x2', 'x3', 'x4', 'x5'].forEach((id) => S(id, ''));
          CLS('x0', 'pill'); SET('x0', '全部方案的共同底座：KVM / 硬件虚拟化扩展');
          CLS('x9', 'pill'); SET('x9', '起始状态');
        },
        steps: [
          { run: () => S('x1', 'active'),
            note: '<b>最重的一层：全系统模拟。</b>QEMU 的 TCG 逐条翻译指令，<b>唯一的好处是架构可以不同</b>（x86 上跑 ARM）。代价是「每条指令都要过翻译器」，性能最差。它存在的意义是<b>兼容性</b>，不是性能。' },
          { run: () => { S('x1', 'done'); S('x2', 'active'); },
            note: '<b>往下一层：硬件虚拟化。</b>QEMU 借助 KVM（Linux）/ HAXM（Intel）/ Hyper-V（AMD/Windows）让 CPU 直接执行 guest 指令。<b>性能接近原生，但硬条件来了：guest 与 host 必须同架构。</b>这一条限制划出了整张图的分水岭。' },
          { run: () => { S('x2', 'done'); S('x3', 'active'); },
            note: '<b>现代主流答案：虚拟化 + 应用级翻译层。</b>既然硬件虚拟化要求同架构，那就把<b>系统做成 x86_64 的</b>，用虚拟化跑出接近原生的速度；<b>只有 App 里的 ARM <span class="mono">.so</span> 交给翻译层</b>。翻译成本被压缩到最小比例——这就是 30.2 那条右路。' },
          { run: () => { S('x3', 'done'); S('x4', 'active'); },
            note: '<b>再往上：云端编排。</b>Cuttlefish 站在第 ②/③ 层之上（依赖 KVM），把虚拟设备做成<b>可配置、可脚本创建/销毁、可远程访问</b>的形态，服务于 AOSP 与 CI。<b>云手机 / 云测本质就是这一层的产品化</b>：多租户、串流、运维、计费，底下还是「虚拟安卓设备」这件事。' },
          { run: () => { S('x4', 'done'); S('x5', 'active'); },
            note: '<b>最后是另一个物种：容器方案。</b>Waydroid 这类方案<b>共享宿主内核</b>，用命名空间做隔离——它不是虚拟机。结果是<b>架构必须与宿主一致</b>（宿主 x86 就跑 x86 安卓，宿主 arm64 就跑 arm64），但开销极小、启动极快。它和上面四层不是同一条技术路线。' },
          { run: () => { S('x5', 'done'); CLS('x0', 'pill ok'); SET('x0', '共同底座：虚拟化方案都要 KVM；容器方案不要'); },
            note: '<b>回到最上面那条横向事实。</b>①–④ 都建立在硬件虚拟化之上（Linux 上是 KVM，Windows 上是 HAXM/Hyper-V 一类），<b>KVM 是它们的共同底座</b>；而 ⑤ 容器方案绕开了虚拟化，直接用宿主内核。这是两条根本不同的路，也是第 31、32 章要展开的内容。' },
          { run: () => { S('x3', 'cool'); S('x5', 'hot'); CLS('x9', 'pill acc'); SET('x9', '选型决策：你要的是什么？'); },
            note: '<b>怎么选？三个问题。</b>① <b>要不要跑 ARM-only 的 App？</b>要 → 走 ②/③（带翻译层），别指望容器方案能在 x86 宿主上跑 ARM so。② <b>要不要接近原生的性能？</b>要 → 放弃 ①，选 ②/③。③ <b>要不要规模化、远程、多实例？</b>要 → 走 ④（Cuttlefish/云手机路线）。<b>把这三个问题问完，方案基本就定下来了。</b>' },
          { run: () => { CLS('x9', 'pill bad'); SET('x9', '对逆向：方案决定你的环境特征'); S('x1', 'hot'); S('x3', 'hot'); S('x5', 'hot'); },
            note: '<b>对逆向：你选的方案，决定了你要对抗哪些特征。</b>①/② 会留下 QEMU / Goldfish / ranchu 一整套痕迹；③ 额外留下翻译层库（<span class="mono">libhoudini</span>、<span class="mono">libndk_translation</span>）与 x86 系统镜像的属性差异；⑤ 容器方案共享宿主内核，<span class="mono">/proc</span> 与内核版本会暴露宿主的真实身份。<b>没有「无特征」的方案，只有「特征在你的威胁模型里是否重要」。</b>' }
        ]
      },
      after: T.note('key', '🔑 本章要带走的三句话',
        '<p>① <b>性能差别的根源是「有多少代码需要翻译」</b>，不是模拟器写得好不好。全系统模拟 100%，应用级翻译只翻 App 的 ARM 原生库。</p>'
        + '<p>② <b>GKI 是内核治理的结构性改变</b>：通用内核 + 厂商模块，靠 KMI 契约解耦，让 Google 能独立升级内核、厂商只维护模块。对逆向来说，它把「换内核」变成了规范操作。</p>'
        + '<p>③ <b>云手机不神秘</b>：它就是在 KVM 上跑一堆可编排的安卓虚拟设备。Cuttlefish 是 Google 官方的同类方案，理解它，云手机的架构就可以推导出来。</p>')
    },

    /* ================= 30.8 decision 1 ================= */
    {
      h: '30.8',
      title: '决策演练一：ARM-only 的 so 摆在面前',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一',
            scenario: '<b>情境：</b>目标 App 的加固壳<b>只提供 ARM64 版本的 <span class="mono">.so</span></b>。你们团队用的是一台 x86_64 的 Windows 笔记本，需要在这上面搭环境做动态分析。你手上有 AOSP 的模拟器镜像源，可以下任意架构的系统镜像。你怎么选？',
            choices: [
              { t: '下 ARM64 的系统镜像，让整个安卓系统就是 ARM 的——最接近真机，兼容性最好', next: 'n1' },
              { t: '下 x86_64 系统镜像，让系统原生跑，只让 App 里那个 ARM so 走翻译层', next: 'n2' },
              { t: '下 x86_64 镜像，然后把 ARM so 反编译出来、重写成 x86 版本再塞回去', next: 'n3' },
              { t: '不用模拟器了，改用 Waydroid 这类容器方案，开销最小', next: 'n4' }
            ]
          },
          n1: {
            label: '选 ARM64 系统镜像', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：你选择了「全系统模拟」，性能代价是数量级的',
            result: '<b>认知根源：把「兼容性最好」当成了「最合适」。</b>ARM64 系统镜像确实能让那个 so 原生跑起来，但代价是——在 x86 宿主上，<b>整个安卓系统</b>（内核、ART、SystemServer、每一行 Java）都要经过 QEMU TCG 逐条翻译。这就是本章反复讲的「100% 的代码都要过翻译器」。<br><br>'
              + '<b>更糟的是它不只是慢。</b>真机 CPU 和 TCG 翻译执行的性能差距是数量级的，这个差距本身就是一个极强的「非真机」信号。如果这个 App 带风控，你在还没开始分析之前就已经暴露了。<br><br>'
              + '<b>正确做法：</b>选 <b>x86_64 系统镜像</b>——系统原生执行接近真机速度，只有那个 ARM so 在运行时被 <span class="mono">libhoudini</span> / <span class="mono">libndk_translation</span> 翻译（应用级翻译）。<b>把翻译成本从「全民负担」压到「局部负担」。</b>'
          },
          n2: {
            label: '选 x86_64 镜像 + 翻译层', terminal: true, verdict: 'good',
            verdictTitle: '正确：应用级翻译，把翻译成本压到最小',
            result: '<b>这就是现代模拟器和云手机的主流路线。</b>系统、ART、系统应用全部是 x86 原生指令，借硬件虚拟化（Windows 上通常是 HAXM / Hyper-V）直接执行；<b>只有 App 里那个 ARM so 需要翻译</b>——因为需要被翻译的代码比例从 100% 掉到了个位数，整体体验接近真机。<br><br>'
              + '<b>但要记住两个附带条件：</b><br>'
              + '① <b>翻译层会引入行为差异。</b>在翻译执行路径下观察到的行为不完全等价于真机，关键结论要回真机复验；<br>'
              + '② <b>翻译层本身就是环境特征。</b><span class="mono">libhoudini</span> / <span class="mono">libndk_translation</span> 相关库的存在，向风控暴露了「这是 x86 安卓在跑 ARM so」这个事实。<b>选它不等于没有代价，只是代价最小。</b>'
          },
          n3: {
            label: '把 ARM so 重写成 x86', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：这不是工程问题，是不成立的问题',
            result: '<b>认知根源：把「翻译」误解成了「改写」。</b>翻译层做的是<b>运行时的指令级翻译</b>，它按基本块把 ARM 指令转成等价的 x86 指令——这是可自动化、可缓存、语义可保的。<br><br>'
              + '而你说的「重写成 x86」意味着<b>把机器码还原成高级语义再重新实现</b>。对于一个加固过的 so，它可能：自带完整性校验、被混淆/VMP 保护、依赖 ARM 特有的指令与内存模型、运行时自解密。<b>你连它的完整语义都拿不到，谈何重写。</b><br><br>'
              + '<b>即使硬啃下来</b>，工作量以人月计且极易引入行为差异——而翻译层几秒钟就做完了这件事。<b>正确做法是让工具做翻译，你的精力放在分析上。</b>'
          },
          n4: {
            label: '改用容器方案（Waydroid）', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：容器方案救不了架构不一致',
            result: '<b>认知根源：把「开销小」当成了通用优点，忽略了架构约束。</b>容器方案（如 Waydroid）<b>共享宿主内核</b>，用命名空间做隔离——它根本不是虚拟机，因此有一个死约束：<b>guest 架构必须与宿主一致</b>。<br><br>'
              + '你的宿主是 x86_64，容器里跑的就是 x86_64 的安卓。<b>那个 ARM-only 的 so 依然跑不了</b>——而且容器方案通常<b>没有</b>模拟器那套翻译层集成，你连 libhoudini 这条路都没有。<br><br>'
              + '<b>容器方案的优势</b>（开销小、启动快、资源占用低）是真实存在的，但它适用于「宿主与目标架构一致」的场景。<b>选方案的第一步永远是问架构能不能对上，而不是问谁更轻。</b>'
          }
        }
      }
    },

    /* ================= 30.9 decision 2 ================= */
    {
      h: '30.9',
      title: '决策演练二：风控拦住了，你打算怎么改',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境二',
            scenario: '<b>情境：</b>你在自建的 x86_64 模拟器环境里跑目标 App，App 启动即退出，日志显示风控命中了模拟器检测。你已经确认它读了 <span class="mono">ro.kernel.qemu</span>、查了硬件名（<span class="mono">goldfish</span>/<span class="mono">ranchu</span>）、看了渲染器字符串（<span class="mono">SwiftShader</span>）。你的第一步是什么？',
            choices: [
              { t: '写个脚本，在 App 启动前用 setprop 把这些属性改成真机的值', next: 'n1' },
              { t: '先搞清楚每个特征由哪一层产生、删了会破坏什么，再决定在哪一层动手', next: 'n2' },
              { t: '用 Frida hook 掉属性读取接口，让它返回假值就够了', next: 'n3' },
              { t: '干脆换成 ARM 全系统模拟，ARM 环境应该更「像真机」', next: 'n4' }
            ]
          },
          n1: {
            label: '用 setprop 改属性', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：ro. 开头的属性，运行时改不了',
            result: '<b>认知根源：把属性系统当成了一个普通的键值存储。</b>安卓属性系统由 init 在启动早期从 <span class="mono">*.prop</span> 文件加载并维护，<span class="mono">ro.</span> 前缀的含义正是 <b>read-only</b>——写入一次后<b>不可更改</b>。你敲 <span class="mono">setprop ro.kernel.qemu &quot;&quot;</span>，得到的只会是静默失败或权限错误。<br><br>'
              + '<b>更根本的问题是思路。</b>即使属性改成功了，你只处理了<b>四个特征里的一个</b>。硬件名、渲染器、设备节点都还在，风控随便交叉验证一项就穿帮了。<br><br>'
              + '<b>正确做法：</b>把这些特征<b>归类到产生它们的那一层</b>——<span class="mono">ro.*</span> 属于属性层（要改系统镜像），<span class="mono">goldfish</span>/<span class="mono">ranchu</span> 属于虚拟硬件平台层，<span class="mono">SwiftShader</span> 属于图形栈层，<span class="mono">/dev/qemu_pipe</span> 属于进程通信层。<b>先做归因，再动手。</b>'
          },
          n2: {
            label: '先归因，再决定在哪一层动手', terminal: true, verdict: 'good',
            verdictTitle: '正确：这是反直觉但唯一站得住的做法',
            result: '<b>这一题的正确答案是「先不动手」——听起来反直觉，但这是唯一不会浪费你两天的路径。</b><br><br>'
              + '<b>为什么必须先归因？</b>因为每个特征的处理代价天差地别：<br>'
              + '· <span class="mono">ro.kernel.qemu</span> —— 属性层。运行时改不了，<b>必须改系统镜像</b>（自编译 AOSP 或改 <span class="mono">*.prop</span> 后重打包分区）。<br>'
              + '· <span class="mono">goldfish</span>/<span class="mono">ranchu</span> —— 虚拟硬件平台层。改字符串相对容易，但真机有<b>配套的设备节点、<span class="mono">/sys</span> 结构、HAL 实现</b>；只改名不改结构，会被交叉检测抓到。<br>'
              + '· <span class="mono">SwiftShader</span> —— 图形栈层。名字好改，<b>渲染行为改不掉</b>。<br>'
              + '· <span class="mono">/dev/qemu_pipe</span> —— 通信层。<b>删了会破坏模拟器与宿主的通信</b>（传感器注入、控制通道可能失效）——这是典型的「改了自断后路」。<br><br>'
              + '<b>方法论：</b>看到任何一个特征，先问三个问题——<b>它是谁生成的？为什么必须存在？删了会破坏什么？</b>这三个问题问完，你才知道哪些能改、哪些该保留、哪些改了得不偿失。<b>只改字符串是「伪装」，理解架构才能「重构」。</b>'
          },
          n3: {
            label: 'Frida hook 属性读取接口', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：单点 hook 会被交叉验证击穿',
            result: '<b>认知根源：把「让一个 API 返回假值」等同于「让环境变成真机」。</b>hook <span class="mono">__system_property_get</span> 确实能让某一条读取路径返回你想要的字符串，但它有三个致命问题：<br><br>'
              + '① <b>读属性的路径不止一条</b>——直接读 <span class="mono">/proc</span>、读 <span class="mono">/system/build.prop</span> 文件、通过其它系统接口拿，都能绕过你的 hook。<b>风控只需要换一条路，你的伪装就失效了。</b><br>'
              + '② <b>你只处理了一个特征。</b>硬件名、渲染器、设备节点全都还在——风控根本不需要读属性就能认出这是模拟器。<br>'
              + '③ <b>hook 框架本身也是特征。</b>Frida 的痕迹（进程名、端口、内存中的 agent）本身就是高强度检测项，你可能用一个新的暴露面换掉了一个旧的。<br><br>'
              + '<b>正确做法：</b>能在镜像层改的就在镜像层改（一次生效、无运行时痕迹），hook 只作为最后的补丁手段，并且要覆盖全部读取路径。<b>治本 vs 治标，选错了要多花十倍力气。</b>'
          },
          n4: {
            label: '换成 ARM 全系统模拟', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：ARM 模拟器的特征不是更少，而是更多',
            result: '<b>认知根源：混淆了「guest 架构像真机」与「环境像真机」。</b>真机绝大多数确实是 ARM 的——但你换成 ARM 全系统模拟后，得到的是<b>一个跑在 QEMU TCG 上的 ARM 系统</b>，它同时背上了两套暴露面：<br><br>'
              + '① <b>模拟器的那一整套特征一个都没少</b>——<span class="mono">ro.kernel.qemu</span>、<span class="mono">goldfish</span>/<span class="mono">ranchu</span>、<span class="mono">SwiftShader</span>、<span class="mono">/dev/qemu_pipe</span> 全都还在，因为你用的还是同一个模拟器。<br>'
              + '② <b>额外多了性能特征。</b>TCG 逐条翻译带来的执行速度、时序分布与真机差着数量级——<b>这是一个风控跑个基准测试就能拿到的、极其廉价的判据</b>。<br><br>'
              + '<b>结论：</b>换架构解决不了环境伪装问题，反而额外送你一个更强的暴露面。<b>要「像真机」，正确的反问是「我到底需要消除哪些特征、在哪一层消除」，而不是「换个架构碰碰运气」。</b>'
          }
        }
      }
    },

    /* ================= 30.10 decision 3 ================= */
    {
      h: '30.10',
      title: '决策演练三：内核刷上去了，硬件却废了',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境三',
            scenario: '<b>情境：</b>你按 GKI 替换流程，解包 <span class="mono">boot.img</span>、换入自编译的 GKI 内核、重打包、<span class="mono">fastboot flash boot</span>、重启。<b>设备正常开机了，进了桌面</b>——但摄像头、WiFi、充电全部失效。你的下一步判断是什么？',
            choices: [
              { t: '设备能开机说明刷入流程没问题，应该是内核编译时少选了驱动，重新编一个带驱动的内核', next: 'n1' },
              { t: '查 <span class="mono">lsmod</span> / <span class="mono">dmesg</span>，确认厂商模块有没有加载；大概率是 KMI 版本不匹配，换回对应 KMI 的内核', next: 'n2' },
              { t: '刷回原始 boot 备份，放弃内核级方案，改用 App 层 hook', next: 'n3' },
              { t: '改 cmdline 加参数，强制内核加载厂商模块', next: 'n4' }
            ]
          },
          n1: {
            label: '重新编一个带驱动的内核', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：你正在把 GKI 拆开的东西又合回去',
            result: '<b>认知根源：把「GKI 内核」当成了「传统的一体化内核」。</b>你想「编一个带驱动的内核」——这恰恰是 GKI 要消灭的做法。<br><br>'
              + '<b>GKI 的设计就是：内核里不含厂商驱动</b>，驱动是独立的可加载模块（<span class="mono">.ko</span>），通过 <b>KMI</b> 与内核对接。你把驱动编进内核，等于自己造了一个「厂商定制内核」，既违背了 GKI 的结构，也意味着以后每次内核升级你都要重新合一遍——<b>回到了碎片化的老路。</b><br><br>'
              + '<b>更关键的是诊断方向错了。</b>「能开机」只说明<b>内核镜像本身可用</b>（压缩格式对、能解压、能引导），<b>完全不说明模块能用</b>。摄像头 / WiFi / 充电失效，第一嫌疑是<b>厂商模块没有成功加载</b>，而模块加载失败最常见的原因就是 <b>KMI 版本不匹配</b>。<br><br>'
              + '<b>正确第一步：去看 <span class="mono">lsmod</span> / <span class="mono">/proc/modules</span> 和 <span class="mono">dmesg</span></b>，确认模块到底有没有加载、报了什么错，再决定动作。'
          },
          n2: {
            label: '先查模块加载状态，怀疑 KMI 不匹配', terminal: true, verdict: 'good',
            verdictTitle: '正确：能开机 ≠ 刷成功，先看模块加载',
            result: '<b>这是最容易被跳过、也最关键的一步判断。</b>「设备能开机」制造了一种虚假的成功感——但 GKI 架构下，<b>内核和厂商模块是两个独立的东西，它们各成功各的</b>。<br><br>'
              + '<b>诊断顺序：</b><br>'
              + '① <span class="mono">adb shell lsmod</span>（或 <span class="mono">cat /proc/modules</span>）——厂商模块在不在列表里？<br>'
              + '② <span class="mono">dmesg</span> ——模块加载时报了什么错？KMI 不匹配通常会表现为符号找不到、版本不兼容一类的错误。<br>'
              + '③ <span class="mono">uname -r</span> ——你现在跑的内核版本串，KMI 版本是什么。<br><br>'
              + '<b>如果确认是 KMI 不匹配</b>，正确动作是换一个<b>与设备原 KMI 版本一致</b>的 GKI 内核（GKI 内核是按「Android 版本 + 内核版本」的组合分发的，必须严格对齐）。<b>KMI 是合同——合同对不上，模块就不认这个内核。</b><br><br>'
              + '<b>这件事的真正教训：</b>刷完内核必须做<b>完整验收</b>——不只看能不能开机，还要看厂商模块是否加载、依赖硬件的功能是否正常。<b>「能开机」是一个极低的标准。</b>'
          },
          n3: {
            label: '刷回备份，放弃内核级方案', terminal: true, verdict: 'bad',
            verdictTitle: '止损没错，但结论下得太早',
            result: '<b>值得肯定的一点：你有备份，并且知道怎么回滚</b>——这是本章 stepper 里强调的救命步骤。<br><br>'
              + '<b>但认知上有问题：把「一次参数没对齐」当成了「这条路走不通」。</b>你现在遇到的极可能只是一个<b>可诊断、可修复的版本对齐问题</b>，而不是方案层面的失败。GKI 替换是一条成熟且规范的路径——内核是独立镜像、模块加载是标准接口，这正是它比「patch 厂商定制内核」更适合工程化的原因。<br><br>'
              + '<b>正确的处理：</b>先回滚保证设备可用（这一步你做对了），然后<b>去查日志把失败原因定位清楚</b>——是 KMI 版本错了，还是压缩格式不对，还是 header / cmdline 参数没对齐？<b>把原因搞清楚再决定放不放弃。</b><br><br>'
              + '<b>一句话：</b>回滚是好的工程习惯，但因为没查日志就放弃一条技术路线，是拿「未知」当「不可行」。'
          },
          n4: {
            label: '改 cmdline 强制加载模块', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：你打算用参数去覆盖一个结构性问题',
            result: '<b>认知根源：把「模块加载失败」当成了「模块没被要求加载」。</b>但这是完全不同的两件事。<br><br>'
              + '模块加载失败的原因通常是<b>接口层面的</b>：KMI 版本不匹配导致符号找不到、结构体布局对不上、模块签名验证不通过。<b>这些不是启动参数能解决的</b>——你告诉内核「去加载这个模块」，内核去加载了，然后因为符号找不到而失败，结果是同一个。<br><br>'
              + '<b>更危险的是动 cmdline。</b>Android 的启动参数里包含大量 <span class="mono">androidboot.*</span> 项，胡乱添加或覆盖可能导致<b>更严重的启动问题</b>（甚至开不了机），把一个「硬件不可用」的问题升级成「设备变砖」。<span class="pill warn">待核实</span> 参数名与语义请以你所用内核版本的实际解析为准。<br><br>'
              + '<b>正确做法：</b>先 <span class="mono">dmesg</span> 看真实的失败原因，再对症下药。<b>在没看清错误之前就动手改配置，是把调试变成赌博。</b>'
          }
        }
      }
    },

    /* ================= 30.11 quiz 1 ================= */
    {
      h: '30.11',
      title: '自测一：翻译发生在哪一层',
      quiz: {
        id: 'q16-1', chapter: 16, answer: 2,
        stem: '关于「全系统模拟」与「应用级翻译」的区别，下列说法<b>正确</b>的是：',
        options: [
          { t: '应用级翻译的翻译质量更高，所以更快', why: '不是质量差异。两者做的事本质一样（把 ARM 指令转成 x86），差别在于<b>需要被翻译的代码占多大比例</b>。' },
          { t: '全系统模拟只能跑 ARM 系统，应用级翻译只能跑 x86 系统', why: '说法过于绝对。全系统模拟（TCG）恰恰可以做到架构不同，这是它唯一的优势；应用级翻译确实以 x86 宿主系统为前提，但把它说成「只能」是把它和硬件虚拟化的约束混在一起了。' },
          { t: '全系统模拟要翻译整个操作系统的指令，应用级翻译只翻译 App 里 ARM 的 .so', why: '正确。全系统模拟下内核、ART、系统服务、每一行 Java 都要过翻译器（100%）；应用级翻译下系统本身是 x86 原生的，只有 App 的 ARM 原生库需要翻译（个位数比例）。这个比例差异才是性能差距的根源。' },
          { t: '应用级翻译是硬件加速，全系统模拟是软件模拟', why: '把两个概念弄混了。硬件加速指的是 HAXM / Hyper-V / KVM 这类让 CPU 直接执行 guest 指令的机制，它和应用级翻译层是两件不同的事——实际方案里两者常常配合使用。' }
        ],
        explain: '<b>核心区分：翻译的「覆盖面」。</b>全系统模拟（QEMU + TCG）面对的是一个架构完全不同的 guest，<b>没有一行代码能幸免</b>——内核、运行时、系统服务、App 全部逐条翻译。应用级翻译的宿主系统本身就是 x86_64 的（原生速度），只有 App 里那些 ARM 的 <span class="mono">.so</span> 在运行时被 <span class="mono">libhoudini</span> / <span class="mono">libndk_translation</span> 翻译。<br><br>还要分清另一组概念：<b>硬件虚拟化</b>（HAXM / Hyper-V / KVM）让 CPU 直接跑 guest 指令，<b>要求 guest 与 host 同架构</b>——它救不了 ARM 镜像，这正是现代方案改用 x86 镜像的根本原因。'
      }
    },

    /* ================= 30.12 quiz 2 ================= */
    {
      h: '30.12',
      title: '自测二：GKI 到底解决了什么',
      quiz: {
        id: 'q16-2', chapter: 16, answer: 1,
        stem: '关于 <b>GKI</b>（Generic Kernel Image）与 <b>KMI</b>（Kernel Module Interface），下列哪一项<b>不符合</b>实际设计？',
        options: [
          { t: 'GKI 把内核拆成 Google 维护的通用核心与厂商提供的可加载模块', why: '这符合实际设计。厂商驱动做成 <span class="mono">.ko</span> 动态加载，不再编进内核。' },
          { t: 'GKI 的主要收益是提升内核运行性能', why: '不符合。GKI 要解决的是<b>内核碎片化带来的升级困境</b>——让 Google 能独立升级内核修安全漏洞，不必等厂商合分支。它的收益在「升级速度与安全响应」，不是性能。' },
          { t: 'KMI 保持稳定，内核可替换而厂商模块不必重新编译', why: '这符合实际设计，也是 GKI 成立的前提。KMI 规定了符号、结构体布局与函数签名。' },
          { t: '如果新内核删除了模块依赖的符号，模块会加载失败', why: '这符合实际。KMI 一旦被破坏，厂商模块就认不了新内核，硬件功能会大面积失效——这就是为什么 KMI 被称作「合同」。' }
        ],
        explain: '<b>GKI 的收益不是性能，是治理结构。</b>在 GKI 之前，厂商各自 fork 内核并把驱动编进去（built-in），导致内核分支成百上千，Google 修一个漏洞必须等所有厂商合并——大量设备永远等不到。GKI 把内核拆成 <b>Google 维护的通用核心</b> + <b>厂商的可加载模块</b>，用 <b>KMI</b> 作为稳定契约连接。于是升级解耦成两条互不干扰的线：Google 独立升级内核，厂商只维护自己的模块。<br><br>对逆向的意义：内核因此变成了<b>一个独立的、可替换的镜像文件</b>，模块加载是标准接口——这让内核级 Hook / 反检测有了规范入口（对应第 27 章）。'
      }
    },

    /* ================= 30.13 quiz 3 ================= */
    {
      h: '30.13',
      title: '自测三：Cuttlefish 的定位与前提',
      quiz: {
        id: 'q16-3', chapter: 16, answer: [0, 2, 3],
        stem: '关于 <b>Cuttlefish</b>，下列说法<b>正确</b>的有哪些？（多选）',
        options: [
          { t: '它是 Google 官方项目，定位是可配置的安卓虚拟设备（AVD），面向本地 Linux 与远程 GCE，而非物理硬件', why: '正确。这是官方仓库 <span class="mono">google/android-cuttlefish</span> 的原始定位描述。' },
          { t: '它是给终端用户日常使用的安卓模拟器，主打游戏与多开', why: '错误。它面向的是 AOSP 开发与测试、CI/CD，<b>不是</b>终端用户产品。给开发者个人用的是 Android 官方模拟器。' },
          { t: '它依赖 KVM，需要 Linux 宿主 + CPU 硬件虚拟化支持（并可能需要嵌套虚拟化）', why: '正确。KVM 是它的硬前提，<span class="mono">/dev/kvm</span> 必须可用。' },
          { t: '安装时需把用户加入 kvm / cvdnetwork / render 组并重启', why: '正确。这是官方安装步骤明确要求的，加组后需重启才生效。' }
        ],
        explain: '<b>把三个关键词记住：可配置、云端、非物理硬件。</b>Cuttlefish 的官方定位是「a configurable Android Virtual Device (AVD) that targets both locally hosted Linux x86/arm64 and remotely hosted Google Compute Engine (GCE) instances rather than physical hardware」。<br><br>'
          + '<b>包组成</b>：<span class="mono">cuttlefish-base</span>（必需）、<span class="mono">cuttlefish-user</span>（本地 web server，浏览器交互）、<span class="mono">cuttlefish-integration</span>（GCE 上运行）、<span class="mono">cuttlefish-orchestration</span>（编排项目）、<span class="mono">cuttlefish-common</span>（已废弃，仅为兼容保留的 metapackage）。<b>安装后必须加入 <span class="mono">kvm</span>、<span class="mono">cvdnetwork</span>、<span class="mono">render</span> 三个组并重启。</b><br><br>'
          + '<b>为什么它重要：</b>很多<b>云手机</b>方案本质就是 Cuttlefish 或其变体。理解了它，「服务器上一堆可编排的安卓虚拟设备」这个云手机架构就不再神秘。<b>KVM 是 QEMU、Cuttlefish、crosvm 的共同底座。</b>'
      }
    },

    /* ================= 30.14 quiz 4 ================= */
    {
      h: '30.14',
      title: '自测四：模拟器特征从哪来',
      quiz: {
        id: 'q16-4', chapter: 16, answer: 3,
        stem: '某风控读取 <span class="mono">ro.kernel.qemu</span> 判断是否模拟器。你想在自己的环境里处理掉它，第一步应当做什么？',
        options: [
          { t: '在 App 启动前用 setprop 把它清空', why: '<span class="mono">ro.</span> 前缀意味着 read-only，运行时写入无效。这条命令不会生效。' },
          { t: '在 App 里 hook 属性读取函数，让它返回空串', why: '能让某一条读取路径失效，但读属性的路径不止一条（直接读文件、读 /proc 等都能绕过）；而且它只处理了一个特征，硬件名、渲染器、设备节点全都还在；hook 框架本身也是新的暴露面。' },
          { t: '把模拟器换成容器方案，容器更接近真机', why: '容器方案共享宿主内核，架构必须与宿主一致，而且会暴露宿主的 /proc 与内核版本——是换了一批特征，不是消除了特征。' },
          { t: '先确认这个属性由哪一层生成、为什么存在、删了会破坏什么，再决定在哪一层动手', why: '正确。属性层（改系统镜像）、虚拟硬件平台层、图形栈层、设备节点层各有不同的处理代价；先归因才能知道哪些能改、哪些改了会自断后路。' }
        ],
        explain: '<b>方法论：看到环境特征，先归因再动手。</b>本章反复强调的思维模型是——<b>这些字符串不是谁故意留下的破绽，而是虚拟化架构的必然产物</b>。'
          + '<p style="margin-top:8px">· <span class="mono">ro.kernel.qemu</span> → <b>属性层</b>，由 init 在启动早期从 <span class="mono">*.prop</span> 加载，<span class="mono">ro.</span> 写入后不可改，<b>要在系统镜像层面改</b>；<br>'
          + '· <span class="mono">goldfish</span>/<span class="mono">ranchu</span> → <b>虚拟硬件平台层</b>，决定设备树与驱动名；<br>'
          + '· <span class="mono">SwiftShader</span> → <b>图形栈层</b>，「没有真 GPU」的后果，名字好改、行为难改；<br>'
          + '· <span class="mono">/dev/qemu_pipe</span> → <b>通信层</b>，guest 与宿主 emulator 进程的通道，删了会破坏模拟器功能。</p>'
          + '<b>而且换方案只是换一批特征</b>：容器方案会暴露宿主内核痕迹，全系统 ARM 模拟会额外背上性能与时序特征。<b>没有「无特征」的方案，只有「特征在你的威胁模型里是否重要」。</b>'
      }
    },

  ],

  glossary: [
    { t: 'TCG', d: 'Tiny Code Generator，QEMU 内置的动态二进制翻译引擎。把 guest 指令逐条翻译成 host 指令并缓存为 TB（Translation Block）。全系统模拟的性能瓶颈所在。' },
    { t: '全系统模拟', d: 'Emulation。用软件模拟整套硬件并翻译全部 guest 指令，guest 与 host 架构可以不同。兼容性最好、性能最差。典型：QEMU + TCG 跑 ARM 安卓。' },
    { t: '硬件虚拟化', d: 'Virtualization。CPU 通过虚拟化扩展（Intel VT-x / AMD-V）直接执行 guest 指令。性能接近原生，但要求 guest 与 host 架构相同。Linux 上的实现是 KVM，Intel 侧是 HAXM，Windows/Hyper-V 侧是 Hyper-V。' },
    { t: 'libhoudini', d: 'Intel 提供的 ARM→x86 二进制翻译层，让 x86 安卓系统能运行 ARM 的原生库（.so）。属于「应用级翻译」，与全系统模拟不同。Intel 已停止维护。' },
    { t: 'libndk_translation', d: 'Google 在 NDK 体系下延续的 ARM→x86 翻译层方案，作用与 libhoudini 类似：让 x86/x86_64 安卓系统运行时执行 ARM 原生库。' },
    { t: 'GKI', d: 'Generic Kernel Image，通用内核镜像。Google 为解决安卓内核碎片化推出的方案：把内核拆成 Google 统一维护的通用核心与厂商提供的可加载模块，产物形如 Image / Image.gz。' },
    { t: 'KMI', d: 'Kernel Module Interface，内核模块接口。GKI 的核心稳定契约，规定内核暴露给模块的符号、结构体布局与函数签名。KMI 稳定意味着内核可替换而模块不必重编。' },
    { t: 'boot.img / vendor_boot.img / init_boot.img', d: '存放内核与 ramdisk 的启动分区。GKI 部署后，内核与通用 ramdisk、厂商相关内容被拆分到这些分区中；init_boot 由 Android 12+ 引入、13+ 强制，用于存放通用 ramdisk。具体切分随版本与厂商实现变化，需实际解包确认。' },
    { t: 'Cuttlefish', d: 'Google 的 android-cuttlefish 项目，一个可配置的安卓虚拟设备（AVD），面向本地 Linux x86/arm64 与远程 GCE 实例，而非物理硬件。主要服务 AOSP 开发与 CI/CD，依赖 KVM。' },
    { t: 'cvdnetwork', d: 'Cuttlefish 安装时要求用户加入的系统组之一，用于访问其虚拟网络。另两个是 kvm（访问 /dev/kvm）与 render（GPU 渲染设备）。加组后需重启生效。' },
    { t: 'Goldfish / ranchu', d: 'Android 模拟器的虚拟硬件平台代号。Goldfish 是早期平台，ranchu 是其后续实现。它们决定了设备树、驱动名与一系列模拟器特征字符串，是风控检测「是否模拟器」的重要依据。' },
    { t: 'Waydroid', d: '基于容器（共享宿主内核）在 Linux 上运行安卓的方案。不是虚拟机，因此架构必须与宿主一致，但开销极小、启动快。与 Cuttlefish/模拟器走的是根本不同的技术路线。' }
  ],

  teacher: {
    id: 'ch16', chapter: 16,
    name: '追问老师 · 第 30 章',
    sub: '拷问模拟器的架构选择：你为什么选它、它为什么快、它坏在哪',
    intro: '<p style="margin:0">这一章的概念不难，难在<b>选型和归因</b>。我会一直追问「为什么」——为什么这条路径快、为什么这个特征会出现、为什么这个操作在你的环境里不成立。答不出机制，只说结论，是过不了的。</p>',
    questions: [
      /* ---------- Q1 ---------- */
      {
        id: 'c16q1', depth: 1, threshold: 0.7,
        q: '假设你要在一台 Windows x86_64 电脑上跑一个安卓 App，这个 App 里有一个<b>只提供 ARM64 版本</b>的加固 so。请说明：从「安卓系统在被执行」到「那段 ARM 代码真正在 CPU 上跑起来」，中间发生了哪些翻译？为什么现代方案不干脆整个系统都用 ARM 模拟？',
        concepts: [
          { label: '系统本身是 x86_64 镜像，原生执行不必翻译',
            hint: '先问一句：需要被翻译的，是「整个系统」还是「只有那一个 so」？',
            any: ['x86 镜像', 'x86_64 镜像', 'x86系统', '系统镜像是 x86', 'x86 系统镜像', '原生执行', '不用翻译', '不需要翻译', '系统本身是 x86', 'x86 image', 'native'] },
          { label: '只有 App 的 ARM so 被翻译层处理',
            hint: '谁负责把 ARM 的 .so 变成 CPU 能执行的东西？',
            any: ['libhoudini', 'houdini', 'libndk_translation', 'ndk_translation', 'ndk translation', '翻译层', '二进制翻译', '应用级翻译', 'binary translation', 'translation layer', 'arm 翻译'] },
          { label: '加载时机：System.loadLibrary 加载到 ARM 架构 so 时接管',
            hint: '翻译是从哪一刻开始的？是安装时还是运行时？',
            any: ['loadLibrary', 'System.loadLibrary', '加载', '运行时', '动态加载', 'dlopen', 'so 加载', '加载器', 'linker', 'linker64'] },
          { label: '全系统 ARM 模拟（TCG）要翻译 100% 的代码，所以慢',
            hint: '那如果反过来，整个系统都用 ARM 跑在 x86 上，谁要被翻译？比例是多少？',
            any: ['TCG', 'tiny code generator', '全系统模拟', '整个系统', '全部指令', '每条指令', '逐条翻译', '100%', 'qemu 翻译', '慢'] },
          { label: 'HAXM/Hyper-V/KVM 硬件加速要求 guest 与 host 同架构',
            hint: '硬件虚拟化能救 ARM 镜像吗？它对架构有什么要求？',
            any: ['HAXM', 'Hyper-V', 'KVM', '硬件加速', '硬件虚拟化', 'vt-x', 'amd-v', '同架构', '架构相同', '架构一致', '同一架构'] }
        ],
        hints: [
          '把问题拆成两半：①「安卓系统那一层」是谁在执行、要不要翻译？②「那个 ARM so」由谁负责翻译？',
          '再想一步：为什么不全用 ARM？——因为有一种加速手段救不了 ARM 镜像，它对架构有硬性要求，说出它的名字。'
        ],
        probes: [
          '你说的翻译层，具体是在什么时机介入的？安装 APK 的时候就转好了，还是每次运行时转？',
          '如果我在这个环境里用 Frida 去 hook 那个 ARM so 里的函数，会发生什么？和真机上有什么不同？'
        ],
        model: '<b>完整答案。</b>这条链路上有三段，只有第三段需要翻译。<br><br>'
          + '<b>第一段：安卓系统本身。</b>现代模拟器用的系统镜像是 <span class="mono">x86_64</span> 的——内核、ART 运行时、SystemServer、系统应用，全部是 x86 原生指令。借硬件虚拟化（Linux 上的 KVM、Intel 的 HAXM、Windows/Hyper-V 下的 Hyper-V）让 CPU 直接执行 guest 指令，<b>不产生任何翻译开销</b>。这就是它比全系统 ARM 模拟快得多的根本原因。<br><br>'
          + '<b>第二段：App 的 Java/Kotlin 代码。</b>ART 有 x86 后端，DEX 会被编译成 x86 机器码，同样是原生执行。<b>绝大多数 App 的绝大多数代码都在这一层</b>，所以整个环境的手感接近真机。<br><br>'
          + '<b>第三段：App 里的 ARM <span class="mono">.so</span>。</b>加固壳、算法库、音视频引擎这些原生库通常只带 ARM 版本。当加载器（<span class="mono">System.loadLibrary</span> → linker）发现它是 ARM 架构、本机跑不了时，交给<b>应用级翻译层</b>——<b>libhoudini</b>（Intel，已停止维护）或 <b>libndk_translation</b>（Google 在 NDK 体系下延续的方案）。它们在<b>运行时</b>把 ARM 指令翻译成 x86 执行，对 Java 层保持透明。<br><br>'
          + '<b>为什么不全用 ARM 模拟？</b>因为那意味着用 QEMU 的 TCG 逐条翻译<b>整个系统</b>的 ARM 指令——内核、运行时、每一行 Java、每一个系统服务，<b>100% 的代码都要过翻译器</b>。哪怕只是滑一下桌面，背后也是海量指令逐条转译。而且硬件加速救不了它：<b>HAXM / Hyper-V / KVM 都要求 guest 与 host 同架构</b>，ARM 镜像在 x86 宿主上只能退回软件翻译。<br><br>'
          + '<b>一句话总结：</b>性能差异的根源不是翻译质量，而是<b>「需要被翻译的代码占多大比例」</b>——100% vs 个位数。这就是现代模拟器和云手机普遍选择「x86 系统镜像 + 翻译层」的原因。',
        after: '<p>补充一个实战点：在 x86 模拟器上调试 ARM so，执行路径经过了翻译层，行为可能与真机存在差异。做<b>反调试验证</b>时要把这层差异算进去；同时也别忘了，<span class="mono">libhoudini</span>/<span class="mono">libndk_translation</span> 的存在本身就是可被风控检测的环境特征。</p>'
      },

      /* ---------- Q2 ---------- */
      {
        id: 'c16q2', depth: 2, threshold: 0.7,
        q: '请解释 <b>GKI</b> 要解决的核心问题是什么，它把内核拆成了哪两部分，这两部分靠什么契约连接？然后说明：为什么这个设计能让「Google 修内核漏洞」不再需要等厂商？',
        concepts: [
          { label: '问题是内核碎片化：厂商各自 fork 内核，升级要等所有人',
            hint: 'GKI 出现之前，安卓内核最大的痛点是什么？',
            any: ['碎片化', '内核碎片', 'fragment', '各自 fork', 'fork 内核', '定制内核', '厂商内核', '版本分裂', '分支太多', '升级慢', '等厂商', 'kernel fragmentation'] },
          { label: '拆成通用核心（Google 维护）+ 厂商可加载模块',
            hint: '拆成了哪两半？分别归谁管？',
            any: ['通用内核', '通用核心', 'gki 内核', 'vendor module', '厂商模块', '可加载模块', '内核模块', 'ko', '.ko', 'lkm', 'loadable module', '两部分', '拆成'] },
          { label: '契约是 KMI（Kernel Module Interface）',
            hint: '这两半之间必须有一个「不能随便变」的东西，它叫什么？',
            any: ['KMI', 'kernel module interface', '模块接口', '内核模块接口', '符号表', '稳定接口', 'abi', '接口契约', 'stable'] },
          { label: 'KMI 稳定 → 内核可替换而模块不必重编',
            hint: 'KMI 保持稳定的直接后果是什么？谁可以不用重编？',
            any: ['不用重编', '无需重编', '不必重编', '不用重新编译', '可替换', '直接替换', '内核升级', '内核换', '替换内核', '二进制兼容', '兼容'] },
          { label: '升级解耦：Google 独立发内核，厂商只维护模块',
            hint: '于是升级变成了几条互不干扰的线？',
            any: ['解耦', '独立升级', '互不干扰', '两条线', '不用等厂商', '绕过厂商', '单独升级', '各自升级', 'decouple'] }
        ],
        hints: [
          '先想「没有 GKI 的世界是什么样」：一个内核镜像里混着通用代码和厂商驱动，谁能单独改其中一半？',
          '再想「要让两半能分开升级，它们之间必须约定好什么不能变」——这个东西有个专门的名字，也是 GKI 的核心契约。'
        ],
        probes: [
          '如果厂商的驱动模块调用了某个内核内部函数，而新内核把这个函数删了，会发生什么？这说明了 KMI 的什么性质？',
          'GKI 让内核变成「一个独立的、可替换的镜像文件」。这对做内核级 Hook 的逆向工程师意味着什么？'
        ],
        model: '<b>完整答案。</b><br><br>'
          + '<b>要解决的问题：内核碎片化。</b>安卓设备 SoC 五花八门，历史上每家厂商都 fork 一份 Linux 内核、把自家驱动直接编进内核（built-in），于是市面上存在成百上千个互不相同的内核分支。后果是：Google 修了一个内核安全漏洞，<b>必须等每一个厂商把自己的分支都合一遍</b>——而现实中大量设备永远等不到这次合并。<br><br>'
          + '<b>拆法：通用核心 + 厂商模块。</b>Google 维护一份统一的 <b>GKI</b>（Generic Kernel Image，产物形如 <span class="mono">Image</span> / <span class="mono">Image.gz</span>），只包含与硬件无关的通用内核能力（调度、内存管理、文件系统、安全机制）。厂商的硬件驱动不再编进内核，而是做成<b>可加载内核模块</b>（<span class="mono">.ko</span>），在启动时动态装载。<br><br>'
          + '<b>连接两者的契约：KMI（Kernel Module Interface）。</b>它规定了内核暴露给模块的符号、结构体布局与函数签名。KMI 保持稳定，就意味着<b>内核可以被替换、而模块不必重新编译</b>——这是整个方案成立的前提。反过来说，如果新内核删掉了模块依赖的某个符号，模块就会加载失败，设备硬件功能大面积失效。KMI 是「合同」，违约的代价就是设备起不来。<br><br>'
          + '<b>为什么不需要等厂商了？</b>因为升级被<b>解耦成两条独立的线</b>：<br>'
          + '<b>Google 侧</b>——独立升级 GKI 内核，合上游 LTS 补丁、修安全漏洞，只要不动 KMI，就不影响任何厂商模块，<b>安全补丁可以绕开厂商直接下发</b>；<br>'
          + '<b>厂商侧</b>——只维护自己那几个驱动模块，内核换了照样能用，维护工作量从「一整个内核分支」降到「几个模块」。<br><br>'
          + '<b>要点：</b>GKI 的收益不是性能，而是<b>升级速度与安全响应</b>。它把「一次内核升级」拆成了「两个可以独立发布的单元」。',
        after: '<p>对逆向的意义：GKI 让内核变成<b>一个独立的、格式规范的、有文档的镜像文件</b>，模块加载也是标准接口。这让「换内核做内核级 Hook / 反检测」从「patch 某个厂商的定制内核」变成了规范化操作（对应第 27 章的内核模块技术）。代价是攻防战场下沉——风控现在会检查内核版本字符串、已加载模块列表这些新的检测面。</p>'
      },

      /* ---------- Q3 ---------- */
      {
        id: 'c16q3', depth: 2, threshold: 0.7,
        q: '一个 App 检测出自己运行在模拟器上。假设它用的判据是 <span class="mono">ro.kernel.qemu</span>、硬件名 <span class="mono">goldfish</span>/<span class="mono">ranchu</span>、渲染器 <span class="mono">SwiftShader</span>、设备节点 <span class="mono">/dev/qemu_pipe</span>。请你<b>从架构层面</b>解释这些特征各自是怎么产生的——它们分别对应虚拟化方案里的哪一部分？理解了这些之后，你打算怎么改？',
        concepts: [
          { label: 'ro.kernel.qemu 是属性系统的标记，来自 QEMU 虚拟平台',
            hint: '这是一个只读系统属性。属性是谁在什么时候写进去的？',
            any: ['属性', 'property', 'prop', 'build.prop', 'default.prop', '只读属性', 'ro.', '属性系统', 'init', 'init.rc'] },
          { label: 'goldfish/ranchu 是模拟器的虚拟硬件平台代号',
            hint: '这两个名字不是随机的字符串，它们指的是什么？',
            any: ['goldfish', 'ranchu', '虚拟硬件', '硬件平台', '平台代号', '虚拟设备', 'hardware', 'ro.hardware', '模拟硬件'] },
          { label: 'SwiftShader 是软件渲染器，真机用 GPU 驱动',
            hint: '为什么模拟器的图形渲染器名字这么特殊？真机上应该是什么？',
            any: ['swiftshader', '软件渲染', '软渲染', '渲染器', 'renderer', 'gpu 驱动', 'opengl', 'vulkan', 'gralloc', '软件模拟图形'] },
          { label: '/dev/qemu_pipe 是 guest 与宿主 emulator 进程的通信通道',
            hint: '这个设备节点的另一端连着谁？为什么模拟器需要这样一条通道？',
            any: ['qemu_pipe', 'qemu pipe', '设备节点', 'dev/', '通信', '通道', '宿主', 'host', '管道', 'pipe', 'goldfish_pipe'] },
          { label: '这些特征来自「虚拟化平台」，换架构或换方案会换一批特征',
            hint: '如果换成容器方案（共享宿主内核），这些特征还会一样吗？',
            any: ['架构决定', '方案决定', '换方案', '不同的特征', '容器', 'waydroid', '宿主内核', '特征来源', '平台决定'] }
        ],
        hints: [
          '把四个特征分别归类：哪个属于「属性系统」、哪个属于「虚拟硬件平台」、哪个属于「图形栈」、哪个属于「进程间通信」？',
          '关键认知：这些字符串不是谁故意留下的「破绽」，而是这套虚拟化架构<b>必然的产物</b>。想改掉它们，得改产生它们的那一层。'
        ],
        probes: [
          '你说要改属性系统。那 <span class="mono">ro.</span> 开头的只读属性，运行时能直接改吗？如果不能，有哪些可行的改法？',
          '如果我把这四个特征全部改掉了，风控还有别的办法认出这是模拟器吗？举两个例子。'
        ],
        model: '<b>完整答案：这些特征不是「破绽」，是架构的产物。</b><br><br>'
          + '<b>① <span class="mono">ro.kernel.qemu</span> —— 属性系统层。</b>安卓的属性系统由 init 在启动早期从 <span class="mono">*.prop</span> 文件加载并维护，<span class="mono">ro.</span> 前缀表示「只读，写入后不可更改」。模拟器的虚拟平台（QEMU）在启动时把这个属性置位，告诉整个系统「你跑在虚拟化环境里」。它属于<b>虚拟平台 → 系统</b>的信息传递。<br><br>'
          + '<b>② <span class="mono">goldfish</span> / <span class="mono">ranchu</span> —— 虚拟硬件平台层。</b>这是 Android 模拟器虚拟硬件的平台代号（Goldfish 是早期平台，ranchu 是其后续实现）。它们决定了设备树、驱动名字、以及 <span class="mono">ro.hardware</span> 之类的取值。真机上这里是具体的 SoC / board 名。<b>它来自「虚拟硬件长什么样」这一层。</b><br><br>'
          + '<b>③ <span class="mono">SwiftShader</span> —— 图形栈层。</b>真机有真实的 GPU 和厂商图形驱动（Mali / Adreno 等）；模拟器没有对应的真实 GPU，只能用<b>软件渲染</b>兜底，SwiftShader 就是 Google 的软件 GL/Vulkan 实现。它出现在渲染器字符串里，是「没有真 GPU」这个事实的直接后果。<br><br>'
          + '<b>④ <span class="mono">/dev/qemu_pipe</span> —— 进程间通信层。</b>guest（安卓）需要和宿主上的 emulator 进程通信（传感器输入、网络、显示输出、控制命令）。因为 guest 里没有真实硬件设备，就约定了一个虚拟设备节点做通道，由虚拟平台驱动支撑。它出现在设备节点列表里，是「guest 与宿主需要一条控制/数据通道」的必然产物（同类还有 <span class="mono">/dev/goldfish_pipe</span> 之类的实现）。<br><br>'
          + '<b>怎么改？按层改，逐层切断。</b><br>'
          + '<b>属性层</b>：<span class="mono">ro.*</span> 属性启动后不可写，所以运行时直接 <span class="mono">setprop</span> 是无效的。可行路径是<b>在系统镜像层面改</b>——自编译 AOSP 时改属性定义，或改 <span class="mono">*.prop</span> 文件后重打包 system 分区；另一种是运行时 hook 属性读取接口（<span class="mono">__system_property_get</span>），但通用性差、容易被交叉验证识破。<br>'
          + '<b>硬件 / 渲染层</b>：改 <span class="mono">ro.hardware</span> 等字符串相对容易（同样要动镜像），但渲染器字符串涉及图形栈实际行为，改名字容易、改行为难——真机的 GPU 渲染结果和软件渲染在细节上是有差异的。<br>'
          + '<b>设备节点层</b>：删掉 <span class="mono">/dev/qemu_pipe</span> 会直接破坏模拟器与宿主的通信（传感器、控制通道可能失效），往往得不偿失。<br><br>'
          + '<b>最重要的结论：</b>只改字符串是「伪装」，理解架构才能「重构」。而且——<b>换一种虚拟化方案，特征就换一批</b>：容器方案共享宿主内核，暴露的会是宿主的 <span class="mono">/proc</span> 与内核版本。没有「无特征」的方案，只有「特征在你的威胁模型里是否重要」。',
        after: '<p>方法论上的收获：看到任何一个「模拟器特征」，不要只想着「怎么把它删掉」，先问<b>「它是谁生成的、为什么必须存在、删了会破坏什么」</b>。这三个问题问完，你才知道哪些能改、哪些改了会自断后路。</p>'
      },

      /* ---------- Q4 ---------- */
      {
        id: 'c16q4', depth: 2, threshold: 0.7,
        q: '你的团队要做一套<b>规模化云测平台</b>，需要同时跑几百台安卓设备、供远程访问、按需创建和销毁。有人提议「直接用 Android 官方模拟器多开」，也有人提议 Cuttlefish。请说明 Cuttlefish 到底是什么、它和官方模拟器的定位差别，并给出你的选型判断和理由（包括它对宿主环境有什么硬要求）。',
        concepts: [
          { label: 'Cuttlefish 是 Google 官方的可配置安卓虚拟设备（AVD）',
            hint: '官方仓库怎么定位它？它的名字后面跟的是什么缩写？',
            any: ['cuttlefish', 'avd', 'android virtual device', '虚拟安卓设备', '虚拟设备', '可配置', 'configurable', 'google 官方', 'android-cuttlefish'] },
          { label: '面向云端：本地 Linux x86/arm64 与远程 GCE，而非物理硬件',
            hint: '它设计出来是给谁用的、跑在哪？不是给终端用户的吧？',
            any: ['gce', 'google compute engine', '云端', '云', '服务器', 'server', '远程', 'linux', 'ci', 'ci/cd', 'ci cd', 'aosp 开发', '测试', '面向开发测试'] },
          { label: '依赖 KVM，要求 Linux + 硬件虚拟化支持',
            hint: '它对宿主有一个不可绕过的硬性要求，是什么？',
            any: ['kvm', '硬件虚拟化', 'vt-x', 'amd-v', '虚拟化扩展', '/dev/kvm', 'linux', '内核虚拟化', 'nested', '嵌套虚拟化'] },
          { label: '安装需加入 kvm / cvdnetwork / render 组并重启',
            hint: '装完之后有一组必须做的权限配置，涉及几个系统组？',
            any: ['cvdnetwork', 'cvd network', 'kvm 组', 'render', '用户组', 'usermod', '加组', '权限', '重启', 'reboot'] },
          { label: '适合多实例/CI/编排；官方模拟器更适合开发者单机调试',
            hint: '两者的设计目标不一样。谁更适合「可脚本化创建销毁」？',
            any: ['编排', 'orchestration', '多实例', '规模化', '批量', '自动化', '可脚本', '脚本化', 'ci', '容器', 'docker', 'podman', '单机', '开发者'] }
        ],
        hints: [
          '先把定位说清楚：Cuttlefish 的官方定义里，它「targets ... rather than physical hardware」——那它 targeting 的是什么？',
          '选型时别只谈「哪个强」，要谈「哪个的设计目标跟我的需求对齐」。Cuttlefish 是为云端和 CI 设计的，官方模拟器是为开发者本机调试设计的。'
        ],
        probes: [
          '你说 Cuttlefish 依赖 KVM。那如果我的服务器是 ARM64 的、或者跑在嵌套虚拟化的云主机上，会有什么问题？',
          '很多商业云手机方案，你觉得它们和 Cuttlefish 是什么关系？它们额外解决了哪些 Cuttlefish 不负责的问题？'
        ],
        model: '<b>完整答案。</b><br><br>'
          + '<b>Cuttlefish 是什么。</b>它是 Google 的开源项目 <span class="mono">google/android-cuttlefish</span>，官方定位是「a configurable Android Virtual Device (AVD) that targets both locally hosted Linux x86/arm64 and remotely hosted Google Compute Engine (GCE) instances <b>rather than physical hardware</b>」。注意这句话的三个关键词：<b>可配置</b>（能用配置描述出一台什么样的设备）、<b>本地 Linux 与远程 GCE</b>（宿主是 Linux 服务器，不是你的笔记本）、<b>而非物理硬件</b>（它不做真机托管）。它主要服务于 <b>AOSP 开发与测试、CI/CD</b>——Google 自己的自动化测试就跑在它上面。<br><br>'
          + '<b>和官方模拟器的定位差别。</b>Android 官方模拟器面向<b>开发者个人</b>，跑在开发者的 Windows/macOS/Linux 桌面上，设计目标是「好用、能调试、能模拟各种设备形态」。Cuttlefish 面向<b>服务器与流水线</b>，设计目标是「可编排、可规模化、可远程、可无人值守」。两者都能跑安卓，但<b>优化目标完全不同</b>。对你们的场景（几百台、远程访问、按需创建销毁），Cuttlefish 的设计目标天然对齐。<br><br>'
          + '<b>硬要求（必须提前确认，否则项目直接卡死）。</b>① <b>依赖 KVM</b>——Linux 宿主 + CPU 支持并开启硬件虚拟化扩展（Intel VT-x / AMD-V），<span class="mono">/dev/kvm</span> 必须可用；如果是云主机或虚拟机里再跑，还要确认是否支持<b>嵌套虚拟化</b>。② <b>权限配置</b>——安装时要装 <span class="mono">cuttlefish-base</span>（必需）等包，把用户加入 <span class="mono">kvm</span>、<span class="mono">cvdnetwork</span>、<span class="mono">render</span> 三个组，然后<b>重启</b>才生效（<span class="mono">cuttlefish-user</span> 提供本地 web server 用于浏览器交互；<span class="mono">cuttlefish-integration</span> 用于 GCE；<span class="mono">cuttlefish-orchestration</span> 是编排项目；<span class="mono">cuttlefish-common</span> 已废弃，仅为兼容保留的 metapackage）。③ 它还支持<b>容器镜像</b>形式（Docker / Podman），这在 CI 里更容易被拉起。<br><br>'
          + '<b>我的选型判断。</b>选 Cuttlefish 路线。理由：<b>可配置 + 可编排 + 容器化</b>正好对应「按需创建销毁」和「批量」；官方模拟器多开在管理、隔离、自动化程度上都要自己补大量轮子。但落地前必须先把 KVM 可用性和宿主规格验证清楚——<b>这是这个方案的地基，地基不成立，后面全是空谈。</b><br><br>'
          + '<b>额外认知（很重要）。</b>很多商业<b>云手机</b>方案，本质就是 Cuttlefish 这类虚拟安卓设备的产品化：在虚拟化层之上再解决<b>多租户隔离、音视频串流、设备运维、计费、反检测</b>等 Cuttlefish 本身不负责的问题。<b>理解了 Cuttlefish，云手机的架构就不再神秘——它就是「KVM 上一堆可编排的安卓虚拟设备」加上一层服务化外壳。</b>',
        after: '<p>把这一题和 30.7 的谱系图对照看：Cuttlefish 站在「硬件虚拟化 + 云端编排」这一格。它的技术底座是 KVM，和 QEMU、crosvm 同宗；而 Waydroid 那类容器方案走的是完全不同的路（共享宿主内核，不需要 KVM）。<b>看到任何一个新方案，先问它站在哪一格。</b></p>'
      },

      /* ---------- Q5 · depth 3 ---------- */
      {
        id: 'c16q5', depth: 3, threshold: 0.65,
        q: '<b>综合题。</b>你的目标是搭一个<b>「看起来像真机」的安卓运行环境</b>，用于对一款带反调试 / 反模拟器风控的 App 做动态分析。请给出一套完整方案：说明你会选<b>哪条技术路线</b>（模拟器 / Cuttlefish / 容器 / 真机），<b>用什么架构的系统镜像</b>，打算<b>伪装哪些环境特征</b>，这些特征<b>分别在哪一层产生、你要在哪一层消除它们</b>；以及<b>这套方案的固有代价和残余风险</b>是什么。',
        concepts: [
          { label: '选型：优先真机或硬件虚拟化+同架构镜像，慎用全系统模拟',
            hint: '风控会检测 CPU 架构、性能特征。全系统 ARM 模拟这条路在性能上会露馅吗？',
            any: ['真机', '物理机', '硬件虚拟化', 'x86_64 镜像', 'x86 镜像', '同架构', '不建议全系统模拟', '放弃 tcg', 'tcg 太慢', '硬件直跑', 'kvm', 'haxm'] },
          { label: '伪装属性系统（ro.kernel.qemu / ro.hardware / ro.product.*）',
            hint: '最常被检测的一层是哪一层？那些 ro. 开头的属性怎么办？',
            any: ['ro.kernel.qemu', '属性', 'property', 'build.prop', 'ro.hardware', 'ro.product', '指纹', 'fingerprint', 'getprop', '属性系统'] },
          { label: '伪装硬件/平台标识（goldfish、ranchu、渲染器）',
            hint: '硬件名和渲染器字符串分别属于哪一层？',
            any: ['goldfish', 'ranchu', 'hardware', '渲染器', 'swiftshader', 'renderer', 'gpu', '设备树', 'dtb', 'board'] },
          { label: '清理设备节点与文件痕迹，以及翻译层库',
            hint: '架构留下的文件级痕迹有哪些？',
            any: ['qemu_pipe', '设备节点', '/dev/', 'goldfish_pipe', '文件痕迹', '删除痕迹', 'genyd', 'libhoudini', 'libndk_translation', '翻译层', 'so 库', '系统镜像'] },
          { label: '内核层处理：内核版本字符串、启动参数、已加载模块',
            hint: '还有一层比属性更深，风控也会查。是哪一层？',
            any: ['内核', 'kernel', 'uname', '内核版本', '启动参数', 'cmdline', 'modules', 'lsmod', 'gki', '内核模块', 'boot.img', '内核镜像'] },
          { label: '残余风险：行为/时序/传感器等无法靠改字符串解决',
            hint: '改完所有能改的字符串，还剩哪些是改不掉的？',
            any: ['行为', '时序', '性能', '传感器', 'sensor', '功耗', '电池', 'thermal', 'gpu 行为', '固有差异', '残余风险', '改不掉', '无法完全', '交叉验证'] }
        ],
        hints: [
          '分层回答：<b>属性层 / 硬件层 / 图形层 / 设备节点层 / 内核层 / 库层</b>。每一层说清「特征是什么 → 谁生成的 → 在哪一层消除」。',
          '别忘了第二部分：任何伪装都有代价。想想哪些东西是<b>改字符串也解决不了</b>的——这往往才是风控真正的杀手锏。'
        ],
        probes: [
          '你说要在系统镜像层面改属性。如果我只有官方分发的模拟器镜像，没有条件自编译 AOSP，还有什么次优路径？各自的可靠性和代价如何？',
          '如果风控用的不是「特征检测」而是「行为检测」（例如某段代码在真机上的执行耗时分布、传感器的物理合理性），你上面这套方案还有效吗？'
        ],
        model: '<b>完整答案（分层来答）。</b><br><br>'
          + '<b>一、选路线。</b>先明确一条硬约束：<b>如果目标 App 含 ARM-only 的 so，就必须选带翻译层的 x86_64 系统镜像，或者干脆用 ARM 真机。</b>全系统 ARM 模拟（QEMU + TCG）不仅慢，而且性能特征本身就是极强的「非真机」信号——真机的 CPU 性能和它的差距是数量级的，风控跑个基准测试就能看出来。<br>'
          + '现实中的优先级大致是：<b>真机 / 云真机 &gt; 硬件虚拟化 + x86_64 镜像 + 应用级翻译层 &gt; 全系统模拟</b>。Cuttlefish 适合规模化与自动化场景（依赖 KVM），但它是为测试设计的，环境特征比官方模拟器「干净」一些、但绝不是「无特征」；容器方案（共享宿主内核）会暴露宿主 <span class="mono">/proc</span> 与内核版本，通常不适合高对抗场景。<br><br>'
          + '<b>二、架构选择。</b>选 <b>x86_64 系统镜像</b>（原生执行、性能接近真机、且能借硬件虚拟化）。这意味着走「应用级翻译」路线：只有 App 的 ARM <span class="mono">.so</span> 被 libhoudini / libndk_translation 翻译。<b>好处是快，代价是这两类翻译层库本身会作为「x86 安卓系统」的特征暴露出来。</b><br><br>'
          + '<b>三、伪装什么、在哪一层消除。</b><br>'
          + '<b>① 属性层</b>——<span class="mono">ro.kernel.qemu</span>、<span class="mono">ro.hardware</span>、<span class="mono">ro.product.*</span>、<span class="mono">ro.build.fingerprint</span> 等由系统属性系统在启动早期加载。注意：<span class="mono">ro.</span> 属性写入后不可改，运行时 <span class="mono">setprop</span> 无效。<b>正解是改系统镜像</b>（自编译 AOSP 时改属性定义，或改 <span class="mono">*.prop</span> 后重打包分区）；次优是 hook 属性读取接口（<span class="mono">__system_property_get</span>），但通用性差、易被交叉验证识破。<br>'
          + '<b>② 虚拟硬件层</b>——<span class="mono">goldfish</span>/<span class="mono">ranchu</span> 是模拟器的虚拟硬件平台代号，决定了设备树与驱动名。<b>要在系统镜像 / 内核层消除</b>；改 <span class="mono">ro.hardware</span> 之类的取值只是一半，真机还有配套的设备节点、<span class="mono">/sys</span> 目录结构、HAL 实现——只改名字不改结构，很容易被「名字对了但结构不对」的交叉检测抓到。<br>'
          + '<b>③ 图形栈层</b>——<span class="mono">SwiftShader</span> 是软件渲染器，出现在渲染器字符串里。改字符串容易（连同 GRALLOC / EGL 相关属性一起改），但<b>渲染行为改不掉</b>：软件渲染在扩展支持、精度、性能、某些视觉细节上与真 GPU 存在差异，深度检测可以从渲染结果反推。<br>'
          + '<b>④ 设备节点 / 文件层</b>——<span class="mono">/dev/qemu_pipe</span>（guest 与宿主 emulator 进程的通信通道）是「guest 需要和宿主通信」这个架构事实的产物。<b>直接删掉会破坏模拟器与宿主的通信</b>（传感器注入、控制通道可能失效），属于「改了自断后路」的典型。要在这一层动手，得先想清楚这条通道还有谁在用。<br>'
          + '<b>⑤ 内核层</b>——内核版本串（<span class="mono">uname -r</span>）、启动参数（<span class="mono">androidboot.*</span>）、已加载模块列表。这一层要动，就得走 <b>GKI 内核替换</b>那条路（解包 boot 分区 → 换内核镜像 → 重打包 → 刷入），属于高危操作，且会破坏 verified boot 状态——<b>而 verified boot 状态本身就是可检测项</b>。<br>'
          + '<b>⑥ 库层</b>——libhoudini / libndk_translation 相关库的存在，直接暴露「这是 x86 安卓跑 ARM so」的架构事实。清理或重命名要谨慎，因为它们可能被链接器按名字查找。<br><br>'
          + '<b>四、固有代价与残余风险。</b><br>'
          + '<b>代价</b>：改得越深，环境越脆弱（每次系统 / 内核升级都要重新适配）、越难复现、越容易在「改名不改结构」的地方被交叉检测抓到。删掉通信通道类的东西还可能直接让模拟器功能失效。<br>'
          + '<b>残余风险（改字符串解决不了的）</b>：<b>行为与时序特征</b>——CPU 性能分布、内存延迟、指令执行耗时；<b>传感器物理合理性</b>——静止时的噪声模式、加速度计与陀螺仪的相关性；<b>功耗与热特征</b>——电池曲线、温度变化；<b>GPU 渲染行为的细微差异</b>；<b>翻译层带来的执行路径异常</b>。<b>这些都不是「改一个字符串」能解决的，它们需要风控做更复杂的采集与分析——所以在真实对抗中，最高性价比的路线往往不是「把模拟器伪装成真机」，而是「直接用真机 / 云真机」。</b><br><br>'
          + '<b>本题的思维模型：</b>环境伪装是一项<b>分层工程</b>——先枚举特征，再为每个特征定位「它由哪一层产生」，然后判断「这一层能不能改、改了会破坏什么」。最后一定要问一句：<b>我的威胁模型里，风控到底会不会做行为检测？如果会，字符串层面的伪装收益就很有限。</b>',
        after: '<p>这道题没有唯一正确答案，评分看的是<b>分层是否完整、归因是否准确、是否主动说出了方案的局限</b>。只列「改哪些属性」而不谈「改不掉的残余风险」的答案，在真实项目里会直接导致团队误判风险。</p>'
      }
    ]
  }
};
