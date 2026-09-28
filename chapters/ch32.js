/* 第 32 章 · 安卓容器化原理与核心点深度解析
   全课程集大成者：虚拟化 + 容器化 + Android 系统三者的融合。
   事实原则：Waydroid / Magisk / KVM / virtio-gpu 等已核实内容直接使用；
   未核实的分区列表、remote_android 细节、具体命令一律标注「待核实」。 */
window.CHAPTER = {
  no: 32,
  title: '安卓容器化原理与核心点深度解析',
  lede: '把虚拟化、容器化、Android 系统三块积木焊在一起：从 <strong>virtio-gpu</strong> 图形加速、<strong>Waydroid</strong> 容器化跑完整 Android、内核 <strong>binder</strong> 前提，到绑定挂载与命名空间下的 <code>/proc</code>、完整启动链路、<strong>Magisk</strong> systemless、虚拟 WiFi 与 <strong>KVM API</strong>，最终落到一套<strong>高度定制、可欺骗风控的云端安卓运行环境</strong>。',
  meta: [
    '核心问题：<b>怎么让一个 App 相信它跑在一台真手机上？</b>性能、硬件访问、环境自洽，三者缺一不可',
    '关键工具：<b>Waydroid · Linux namespaces · Magisk · KVM(/dev/kvm) · virtio-gpu/VirGL · remote_android</b>',
    '对手：<b>风控 SDK 的交叉验证</b>——它不看单一 API 返回值，而是让多个证据面互相对账'
  ],

  sections: [
    /* ================= 32.1 ================= */
    {
      h: '32.1',
      title: '终点站：什么叫「云端安卓运行环境」',
      intuition: {
        tag: '直觉模型 · 把手机寄养在机房',
        body: '<p>你自己那台手机，是「一个人住一整套房」：房子（内核）、家具（系统服务）、门牌号（IMEI/序列号/传感器）全是它独占的，谁来敲门它都得应答。</p>' +
              '<p>云端安卓是「把手机寄养到机房里的合租房」：房子还在（宿主 Linux 内核），但每个 App 只分到一个上了锁的房间（namespace）。问题来了——<b>房客会四处打量，确认自己是不是真的在独栋里住</b>：地板响不响（性能）、窗户能不能看见外面（硬件访问）、门牌号对不对得上（环境自洽）。</p>' +
              '<p>本章所有的技术，都是在回答这三个问题里的某一个。想清楚这一点，你就不会把 Waydroid、Magisk、虚拟 WiFi 当成三个孤立的知识点。</p>'
      },
      html: T.note('key', '🔑 本章主线：三块积木的合体',
              '<p><b>虚拟化</b>（怎么凭空造出「一台机器」：KVM 提供 CPU/内存虚拟化，QEMU/Cuttlefish 提供设备模型）＋ <b>容器化</b>（怎么让 Android 用户空间以为自己独占一台机器：namespaces + 绑定挂载 + 共享宿主内核）＋ <b>Android 系统本身</b>（boot.img、init、zygote、system_server、分区与检测面）。</p>' +
              '<p>前面每一章你都在拆其中一块，这一章的任务是<b>把它们焊在一起，并且焊得让风控看不出来</b>。</p>') +
            T.grid(3, [
              '<div class="card"><div class="card-title">① 运行环境</div><p>Waydroid 用容器跑完整 Android；QEMU/Cuttlefish 用 KVM 跑虚拟机。两条路线的<b>性能、硬件访问、隔离强度</b>完全不同。</p></div>',
              '<div class="card"><div class="card-title">② 内核前提</div><p>Android 的 IPC 靠 <span class="term" data-def="Android 的进程间通信机制，内核里以驱动形式提供，需要宿主内核编译了对应模块">binder</span>，共享内存靠 ashmem/memfd。<b>宿主内核不支持，容器里的 Android 起不来。</b></p></div>',
              '<div class="card"><div class="card-title">③ 环境自洽</div><p>Magisk 隐藏 root、虚拟 WiFi 伪造网络状态、图形加速伪装渲染器——<b>伪装不是改一个返回值，而是让所有证据面互相对得上账</b>。</p></div>'
            ]) +
            T.note('warn', '⚠️ 本章的「待核实」约定',
              '<p>本章涉及大量发行版/内核/固件相关的细节，<b>凡是课程没有第一时间给出官方出处的地方，一律标注 <span class="pill warn">待核实</span></b>，包括：Android 各版本的分区清单与对应关系、remote_android 的具体实现、具体发行版的编译命令。</p>' +
              '<p>做逆向的人最忌讳「听起来很合理就当成事实」——这个习惯比任何一个 API 都值钱。</p>'),
      after: '<p><b>这一章怎么读：</b>先建立「三条路线 + 一个自洽原则」的框架（32.1–32.2），再逐个下沉到内核层（32.3–32.6），然后用启动链路把整条路径串起来（32.7），最后是最容易被忽略、也最容易被风控抓到的两块：Magisk 与虚拟 WiFi（32.8–32.9），以及用户态直接操作 KVM 的 API 视角（32.10）。</p>'
    },

    /* ================= 32.2 ================= */
    {
      h: '32.2',
      title: '虚拟化图形硬件加速：云手机真正的第一难点',
      html: '<p>把 Android 跑起来不难，<b>把界面画出来又画得快，才是分水岭</b>。云手机/容器化安卓的第一道坎几乎都是图形：GPU 是整个系统里最难虚拟化的硬件——它不是「一块内存 + 一组寄存器」，而是一整条有状态、有厂商私有命令流、有驱动-固件耦合的流水线。</p>' +
            '<p>更麻烦的是：图形栈是<b>风控最好用的检测面之一</b>。渲染器的厂商/型号字符串、驱动版本、扩展列表，全是 App 可以直接读到的公开信息，而纯软件渲染的取值和真机完全不是一回事。</p>' +
            T.tbl(['路线', '做法', '性能/能力', '代价与检测风险'], [
              ['<b>软件渲染</b><br><span class="small">SwiftShader / llvmpipe</span>', 'Guest 里用 CPU 跑光栅化，完全没有 GPU', '差：分辨率与帧率都被 CPU 卡死', '渲染器/驱动字符串与真机差异大，<b>极易被判定为模拟器</b>'],
              ['<b>VirGL</b><br><span class="small">半虚拟化转发</span>', 'Guest 里的 OpenGL 调用被转发给 Host 的 GPU 去真正渲染', '好：能用上宿主 GPU', '需要 Guest 侧驱动与 Host 侧组件配套；能力/扩展集合与真机仍有差别'],
              ['<b>virtio-gpu</b><br><span class="small">半虚拟化设备</span>', 'Guest 通过 virtio 队列把渲染命令提交给 Host 的 GPU', '好：标准化的虚拟 GPU 接口，社区方案成熟', '仍然要向 Guest 暴露一套「虚拟厂商」的身份信息'],
              ['<b>GPU 直通</b><br><span class="small">passthrough / VFIO</span>', '把物理 GPU 直接分配给虚拟机，Guest 用真驱动', '最好：接近裸机', '成本高、一台机器一张卡、隔离与运维复杂度陡增']
            ]) +
            '<p class="small muted">注：各路线在具体发行版/内核/Android 版本上的开关与配置细节 <span class="pill warn">待核实</span>；上表只描述机制层面的差异。</p>' +
            T.note('bad', '❌ 纯软件渲染的两个代价，第二个才是致命的',
              '<p>第一个代价人人看得见：<b>卡</b>。分辨率、帧率、视频解码全部被 CPU 拖死，用户体验直接崩。</p>' +
              '<p>第二个代价才致命：<b>它会自己举报自己</b>。App 通过 OpenGL ES 查询 <span class="mono">GL_RENDERER</span> / <span class="mono">GL_VENDOR</span> / <span class="mono">GL_VERSION</span> 和扩展列表，一眼就能看出这不是手机 GPU。你可以在 Java 层把这些 API 全 hook 掉，但<b>原生层、第三方渲染库、甚至某些 SDK 自己起的 EGL 上下文</b>都会读到同样的信息——只要有一处没覆盖，前后取值不一致，伪装立刻破功。</p>') +
            T.note('key', '🔑 一句话记住本章的底层立场',
              '<p>图形加速在云手机上<b>不只</b>是性能问题，它同时是<b>反检测问题</b>——这就是为什么真正的云手机方案一定要在 Native 层解决图形，而不是在 Java 层「返回假字符串」。</p>') +
            '<p>相关术语：' + T.term('virtio-gpu', '半虚拟化的 GPU 接口：Guest 通过 virtio 队列把渲染命令提交给 Host 的 GPU，由宿主真正执行') + '、' +
            T.term('VirGL', '在 Guest 内部把 OpenGL 调用转发给宿主 GPU 渲染的方案') + '、' +
            T.term('GPU passthrough', '把物理 GPU 通过 VFIO 直接分配给虚拟机，Guest 使用真实厂商驱动，性能接近裸机') + '、' +
            T.term('SwiftShader', '纯 CPU 实现的图形渲染器，常见于没有 GPU 的虚拟环境，其渲染器字符串极具辨识度') + '。</p>',
      after: '<p><b>出问题往哪查：</b>如果一台实例「界面正常但被判定为模拟器」，先抓图形栈的指纹——渲染器/厂商/版本字符串、支持的扩展列表、GPU 相关的系统属性，再看这些值在 Java 层与 Native 层是否一致。</p>'
    },

    /* ================= 32.3 ================= */
    {
      h: '32.3',
      title: 'Waydroid：用容器跑一个完整的 Android',
      html: '<p>Waydroid 官方 README 的原话是：<b>&quot;Waydroid uses a container-based approach to boot a full Android system on a regular GNU/Linux system.&quot;</b>（Waydroid 用基于容器的方式，在一个普通的 GNU/Linux 系统上启动<b>完整的</b> Android 系统。）仓库地址 <span class="mono">waydroid/waydroid</span>。</p>' +
            '<p>它用的隔离手段就是你在第 31 章见过的 ' + T.term('Linux namespaces', 'Linux 内核的隔离机制：user / pid / uts / net / mount / ipc 六种，让一组进程看到「自己独占一套系统」') + '——<b>user、pid、uts、net、mount、ipc</b> 全套上齐，然后在里面跑 Android 的用户空间。系统镜像基于 ' + T.term('LineageOS', '基于 Android 的开源发行版，Waydroid 的系统镜像以它为底') + '，当前基于 <b>Android 13</b>（<span class="small muted">具体版本随上游演进，以官方仓库为准</span>）。它最常见的两个战场是 <b>Linux 手机</b>（比如 PinePhone）和<b>桌面 Linux</b>。</p>' +
            T.note('key', '🔑 最关键的一句话：容器里的 Android 直接访问硬件',
              '<p>官方原文：<b>&quot;The Android system inside the container has direct access to any needed hardware.&quot;</b>——容器内的 Android 系统<b>可以直接访问所需的硬件</b>。</p>' +
              '<p>这就是它与模拟器/虚拟机的<b>本质分界</b>：<span class="hit">没有虚拟化层，性能接近原生</span>。摄像头、传感器、GPU、网络，走的是宿主内核里真实的驱动，中间不隔着「虚拟硬件 → Guest 驱动」这一层翻译。</p>' +
              '<p>代价同样明确：<b>隔离强度天然弱于虚拟机</b>，而且它<b>不是一台独立机器</b>——宿主能看到的东西，容器里原则上也能碰到，这对「伪装成一台独立真机」既是便利（性能真）也是风险（暴露面多）。</p>') +
            T.grid(2, [
              '<div class="card"><div class="card-title">为什么性能接近原生</div><p>没有指令翻译、没有第二套内核、没有虚拟设备模型。App 的系统调用<b>直接落在宿主内核</b>上，只有命名空间决定它「看得见什么」。</p></div>',
              '<div class="card"><div class="card-title">为什么隔离仍然存在</div><p>Android 有一套自己的用户/权限模型（uid、SELinux、沙箱），加上 namespace 把 PID、网络、挂载视图切开，App 并不能随便看见宿主进程。</p></div>'
            ]) +
            T.note('warn', '⚠️ 内核前提：binder 与 ashmem —— 装不上十有八九是这里',
              '<p>Android 的进程间通信靠 <span class="term" data-def="Android 的核心 IPC 机制，内核以驱动形式提供；没有它 servicemanager/zygote 这一整套都起不来">binder</span>，而 binder <b>不是</b>标准 Linux 内核的必备组件，需要宿主内核提供支持（Linux 主线常见的做法是编译对应模块，课程中提到的名字是 <span class="mono">binder_linux</span> / <span class="mono">ashmem_linux</span>）。共享内存侧还要 <span class="term" data-def="Android 早期的匿名共享内存机制，新内核上越来越多地用 memfd 替代">ashmem</span> 或 <span class="term" data-def="Linux 的匿名文件描述符机制，可在新内核上承担 ashmem 的角色">memfd</span>。</p>' +
              '<p><b>这是安卓容器化的核心技术前提</b>：宿主内核没有 binder，容器里的 Android 会在启动早期就卡死——<span class="mono">servicemanager</span> 起不来，后面全都谈不上。所以「编译一个带 binder 支持的宿主内核」是本路线绕不过去的一步。</p>') +
            '<p><b>下载与编译安装：</b>官方仓库 README 给出了安装方式，不同发行版的包名、依赖与内核模块处理方式都不一样，<span class="pill warn">具体命令与版本对应关系待核实</span>。真正的硬骨头通常在「宿主内核是否带 binder/ashmem」以及「显卡与显示协议怎么对接」这两处，而不在 Waydroid 本体。</p>',
      term: {
        title: '先体检：宿主内核到底支不支持（示意）',
        lines: [
          { t: 'p', s: 'uname -r', note: '<b>先确认宿主内核版本。</b>内核太老或发行版裁剪过狠，后面都白搭。' },
          { t: 'o', s: '6.x.y-generic' },
          { t: 'p', s: 'zcat /proc/config.gz | grep -i -E "binder|ashmem|memfd"', note: '<b>查内核编译选项。</b>这是判断「能不能跑容器化 Android」的第一手证据——比任何文档都可靠。没有 /proc/config.gz 时改用发行版的内核配置文件。', state: { '阶段': '前提检查', '关键点': 'binder 是否内建或编成模块' } },
          { t: 'o', s: 'CONFIG_ANDROID_BINDER_IPC=y' },
          { t: 'o', s: 'CONFIG_ANDROID_BINDERFS=y' },
          { t: 'd', s: '（不同发行版/内核版本的符号名可能不同，以上仅为示意）' },
          { t: 'p', s: 'ls /dev/binder* /dev/binderfs 2>/dev/null', note: '<b>看设备节点是否真的存在。</b>内核编了不等于节点已经挂出来，这一步才是「现在能不能用」。', state: { '阶段': '前提检查', 'binder 设备': '存在 / 不存在' } },
          { t: 'o', s: '/dev/binderfs' },
          { t: 'w', s: '若这里为空：先解决内核与模块，不要继续往下走 —— 后面每一步都会失败在上一步的原因上。' },
          { t: 'p', s: 'ls -l /dev/kvm', note: '<b>顺手确认硬件虚拟化设备。</b>走容器路线它未必需要，但走虚拟机路线（32.4 / 32.10）它是门票。' },
          { t: 'o', s: 'crw-rw---- 1 root kvm 10, 232 ... /dev/kvm' }
        ]
      },
      after: '<p><b>常见坑：</b>①把 Waydroid 装成功当成内核没问题——它可能只是没到那一步；②宿主内核升级后模块没跟着重建，昨天好好的今天起不来；③在有 SELinux 的发行版上，模块加载与设备节点权限会额外折腾一轮。<b>出问题先看内核日志</b>，binder 相关的报错通常非常直白。</p>'
    },

    /* ================= 32.4 ================= */
    {
      h: '32.4',
      title: '并排看：容器路线 vs 虚拟机路线',
      html: '<p>这是全课程「运行环境」部分的收束。左边是 <b>Waydroid（容器）</b>，右边是 <b>QEMU / Cuttlefish（虚拟机）</b>。请重点看两条链路<b>差在哪一层</b>——一条共享内核，一条要过 KVM 再造一台机器。</p>' +
            T.note('key', '🔑 一句话分辨两条路线',
              '<p>容器路线：<b>内核是共用的，Android 只是「另一个用户空间」</b>。虚拟机路线：<b>内核是虚拟出来的，Android 跑在「另一台机器」上</b>。</p>' +
              '<p>所有的差异——性能、硬件访问、隔离强度、能伪装成什么——都是从这一句推出来的。</p>'),
      stage: {
        title: '两条路线并排推演',
        speed: 1900,
        render: '<div class="flow-row" style="align-items:flex-start;gap:20px">' +
                '<div class="flow-col" style="flex:1"><div class="small muted" style="margin-bottom:6px">A · 容器路线：Waydroid</div>' +
                '<div class="blk" id="wa1">宿主 Linux 内核（共享，同一份）</div><div class="arrow">↓</div>' +
                '<div class="blk" id="wa2">namespaces 隔离<br><span class="small">user · pid · uts · net · mount · ipc</span></div><div class="arrow">↓</div>' +
                '<div class="blk" id="wa3">Android 用户空间<br><span class="small">LineageOS / Android 13</span></div><div class="arrow">↓</div>' +
                '<div class="blk" id="wa4">直接访问硬件 · 无虚拟化层</div></div>' +
                '<div class="flow-col" style="flex:1"><div class="small muted" style="margin-bottom:6px">B · 虚拟机路线：QEMU / Cuttlefish</div>' +
                '<div class="blk" id="wb1">宿主 Linux 内核</div><div class="arrow">↓</div>' +
                '<div class="blk" id="wb2">/dev/kvm 硬件虚拟化</div><div class="arrow">↓</div>' +
                '<div class="blk" id="wb3">虚拟硬件<br><span class="small">virtio-gpu · virtio-net · virtio-blk</span></div><div class="arrow">↓</div>' +
                '<div class="blk" id="wb4">Guest 内核<br><span class="small">另一份内核，跑在 vCPU 上</span></div><div class="arrow">↓</div>' +
                '<div class="blk" id="wb5">Android 用户空间</div></div>' +
                '</div>' +
                '<div class="flow-row" style="margin-top:14px;align-items:center"><span class="arrow">→</span><span class="pill" id="vd">对照结论</span></div>',
        reset: () => { ['wa1','wa2','wa3','wa4','wb1','wb2','wb3','wb4','wb5'].forEach(i => S(i, '')); CLS('vd', 'pill'); SET('vd', '对照结论'); },
        steps: [
          { run: () => { S('wa1', 'active'); S('wb1', 'active'); }, note: '<b>起点是一样的：宿主 Linux 内核。</b>整个故事从这里分岔。' },
          { run: () => { S('wa1', 'done'); S('wa2', 'active'); }, note: '<b>容器路线在这里分岔：</b>不造新内核，只是给一组进程套上 namespaces。进程看到的 PID、网络、挂载点都是「自己那一份」。' },
          { run: () => { S('wb1', 'done'); S('wb2', 'active'); }, note: '<b>虚拟机路线在这里分岔：</b>先开 <span class="mono">/dev/kvm</span>。宿主内核切换角色，变成 Type-1 Hypervisor，用硬件虚拟化扩展去执行 guest 的代码。' },
          { run: () => { S('wa2', 'done'); S('wa3', 'active'); }, note: '<b>容器里直接跑 Android 用户空间。</b>系统镜像基于 LineageOS，init / zygote / system_server 一样不少，但它们发出的系统调用落在<b>宿主内核</b>上。' },
          { run: () => { S('wb2', 'done'); S('wb3', 'active'); }, note: '<b>虚拟机要凭空造出一套硬件。</b>virtio-gpu、virtio-net 这些半虚拟化设备，就是 guest 眼里的「显卡和网卡」。图形加速的难点全在这一层。' },
          { run: () => { S('wa3', 'done'); S('wa4', 'active'); S('wb3', 'done'); S('wb4', 'active'); }, note: '<b>关键对照出现了。</b>左边已经没有下一层了——Android <b>直接访问所需硬件</b>；右边还要再启动一个 Guest 内核，才有 Android 可用。' },
          { run: () => { S('wb4', 'done'); S('wb5', 'active'); }, note: '<b>虚拟机里的完整链路：</b>宿主内核 → KVM → 虚拟硬件 → Guest 内核 → Android。链条越长，能对不上账的地方越多，性能损耗也越多。' },
          { run: () => { S('wa4', 'done'); S('wb5', 'done'); CLS('vd', 'pill ok'); SET('vd', '容器：性能与硬件访问占优 / 虚拟机：隔离强度占优'); }, note: '<b>结论：这不是「谁更好」，而是「你要什么」。</b>要性能和真实硬件访问 → 容器；要强隔离、要一台「独立机器」的完整幻觉、要不共享宿主内核 → 虚拟机。' },
          { run: () => { CLS('vd', 'pill acc'); SET('vd', '对逆向：还要叠加 Magisk + 虚拟 WiFi + 图形伪装'); }, note: '<b>但对本章的目标来说，两条路线都只是地基。</b>「看起来像真机」还要在三处补课：root 的隐藏与注入（Magisk）、网络状态的自洽伪造（虚拟 WiFi）、图形栈的指纹一致（32.2）。' }
        ]
      },
      after: T.tbl(['维度', '容器（Waydroid）', '虚拟机（QEMU / Cuttlefish）'], [
        ['内核', '共享宿主内核', 'Guest 自带一份内核'],
        ['性能', '接近原生（官方强调无虚拟化层）', '有虚拟化开销，图形/IO 尤甚'],
        ['硬件访问', '容器内 Android <b>可直接访问所需硬件</b>', '只能看到虚拟硬件（virtio 等）或直通设备'],
        ['隔离强度', '依赖 namespaces + Android 自身沙箱，较弱', '强：guest 与宿主之间有硬件级边界'],
        ['风控视角', '<b>像真机</b>（硬件是真的），但宿主暴露面多、容易被找出「不是独立设备」的破绽', '容易被识别为模拟器（虚拟硬件指纹、渲染器字符串），但更容易伪装成「一台完整设备」'],
        ['典型场景', 'Linux 手机 / 桌面 Linux 上跑 Android 应用', '云真机、CI 测试、需要多实例强隔离的场合']
      ]) +
      '<p class="small muted">关于 remote_android 具体走哪条路线、如何组合：<span class="pill warn">以作者发布为准，待核实</span>。</p>'
    },

    /* ================= 32.5 ================= */
    {
      h: '32.5',
      title: '内核从哪来：自己编译一个「任意版本」的虚拟机内核',
      html: '<p>不管走哪条路线，你最终都会发现<b>宿主内核是你唯一改不动、又必须改的东西</b>：容器路线要它带 binder/ashmem，虚拟机路线要它带 KVM 与 virtio 相关支持，云上还要它带特定的网络/存储/调度特性。发行版给你的通用内核，恰好就是「什么都有一点、什么都不够」的那一个。</p>' +
            '<p>所以这门课里会反复出现同一个动作：<b>拿一份内核源码，按自己的需求配一遍，编出一个属于你的内核</b>。它可以是 Ubuntu 的、可以是主线某个版本，甚至可以是给 Android 用的——流程是同一套。</p>' +
            T.note('key', '🔑 三个概念先分清，别混',
              '<p><b>内核源码</b>（决定有哪些功能）→ <b>配置 .config</b>（决定哪些功能被编进来）→ <b>产物</b>（<span class="mono">vmlinuz</span> 内核镜像 + 内核模块 <span class="mono">.ko</span>）。</p>' +
              '<p>很多人编译失败不是不会敲命令，而是<b>没意识到「配置」才是内核的真正内容</b>：同一个源码树，两份不同的 .config，编出来就是两个完全不同的系统。</p>') +
            T.note('warn', '⚠️ 「任意版本」的代价：模块与内核是绑定关系',
              '<p>内核模块（<span class="mono">.ko</span>）与它被编译时的内核版本、配置<b>强绑定</b>。换内核版本却不重建模块，结果就是模块加载失败。这也是为什么「装上去了但 binder 用不了」这种问题经常出现在<b>升级内核之后</b>。</p>' +
              '<p class="small muted">具体每个发行版、每个内核版本的编译命令与依赖包名 <span class="pill warn">待核实</span>，以下步骤只描述机制，不作为可直接粘贴的命令。</p>'),
      stepper: {
        title: '内核是怎么被「做」出来的（机制流程）',
        lines: [
          { code: '<span class="c"># 1. 取源码：版本由你决定，这就是「任意版本」的含义</span>\n<span class="f">git</span> clone <span class="s">内核源码仓库</span> <span class="c"># 或下载对应版本的源码包</span>',
            note: '<b>选版本是第一个决策点。</b>版本决定了可用的特性集合，也决定了你能不能用上某个已经修好的 bug 修复。云上跑安卓容器，通常优先选<b>长期支持</b>分支而不是最新版。',
            state: { '阶段': '取源码', '当前产物': '一份内核源码树' } },
          { code: '<span class="c"># 2. 生成基础配置：从一个已知可用的配置出发</span>\n<span class="f">make</span> <span class="n">olddefconfig</span>   <span class="c"># 或 defconfig / 发行版配置</span>',
            note: '<b>不要从零配。</b>先拿一份「这个平台本来就能跑」的配置当基线，只在上面做增量修改。从零开始配内核是纯粹的浪费时间。',
            state: { '阶段': '配置', '当前产物': '.config' } },
          { code: '<span class="c"># 3. 开需要的选项 —— 这一步决定成败</span>\n<span class="c">#   容器路线：binder / ashmem 或 memfd</span>\n<span class="c">#   虚拟机路线：KVM / virtio 系列</span>\n<span class="c">#   网络：网桥、TUN/TAP、网络命名空间相关</span>',
            note: '<b>这是整条链路上最关键的三行注释。</b>你要开的选项和你的路线直接对应：跑容器必须有 binder，跑虚拟机必须有 KVM 与 virtio。<b>配置漏了一项，后面所有工作都会失败在这一项上。</b>',
            state: { '阶段': '配置', '关键选项': 'binder / memfd / KVM / virtio' } },
          { code: '<span class="c"># 4. 编译：先编内核镜像，再编模块</span>\n<span class="f">make</span> -j<span class="n">$(nproc)</span> <span class="c"># 再 make modules / modules_install</span>',
            note: '<b>耗时最长的一步，也最不需要人盯着。</b>注意 -j 用满核心；云上编译内核是个很典型的「用钱换时间」的场景。',
            state: { '阶段': '编译', '当前产物': 'vmlinuz + .ko 模块' } },
          { code: '<span class="c"># 5. 安装：镜像放 /boot，模块进 /lib/modules/&lt;版本&gt;</span>',
            note: '<b>模块必须落在以版本号命名的目录下</b>，这就是上一段说的「强绑定」在文件系统上的体现。',
            state: { '阶段': '安装', '内核镜像': '/boot', '模块目录': '/lib/modules/&lt;版本&gt;' } },
          { code: '<span class="c"># 6. 生成 initramfs：内核启动早期要用到的驱动与脚本打包在这里</span>',
            note: '<b>initramfs 是内核启动链条里的「第一段用户空间」。</b>它负责把真正的根文件系统挂起来——第 32.7 节的启动链路里，它就在内核与 /init 之间。',
            state: { '阶段': '打包', '当前产物': 'initramfs / initrd' } },
          { code: '<span class="c"># 7. 加引导项，重启进新内核，验证</span>\n<span class="f">uname</span> -r',
            note: '<b>验证的方式只有一个：真的重启进去，再跑一遍 32.3 那种体检。</b>不看内核版本号、不看设备节点，就等于没验证。',
            state: { '阶段': '验证', '判据': 'uname -r 与设备节点同时符合预期' } }
        ]
      },
      after: '<p><b>对逆向实战有什么用：</b>当你需要「宿主内核支持某个特性」时，你要能判断这是<b>一个配置项问题</b>、<b>一个版本问题</b>，还是<b>一个模块没重建的问题</b>。这三者的排查路径完全不同，而它们在现象上全都表现为「功能不可用」。</p>'
    },

    /* ================= 32.6 ================= */
    {
      h: '32.6',
      title: '绑定挂载与命名空间下的 /proc：容器的地基',
      html: '<p>容器听起来很玄，拆到内核原语只有两件事：<b>namespaces 决定「看得见什么」，mount 决定「看得见的东西长什么样」</b>。而绑定挂载是其中最常用的一把螺丝刀。</p>' +
            '<p><span class="term" data-def="把一个已存在的目录挂载到另一个位置，两个路径看到同一份内容：mount --bind olddir newdir">绑定挂载（bind mount）</span>做的事情非常朴素：<span class="mono">mount --bind olddir newdir</span>，把 <b>olddir 挂到 newdir 上</b>。挂完以后，访问 newdir 就是访问 olddir——同一份数据，两个入口。</p>' +
            '<p>容器用它把宿主机的目录「映射」进容器：宿主准备好一份 rootfs，然后在容器自己的挂载命名空间里把它 bind 到 <span class="mono">/</span> 或 <span class="mono">/system</span> 之类的路径上。<b>宿主什么都没变，容器里却像是另一台机器。</b>这也是后面 Magisk 的 magic mount 的基础手法。</p>' +
            T.note('key', '🔑 为什么每个 PID 命名空间都需要自己的 /proc',
              '<p>因为 <b>/proc 里的 PID 编号是「命名空间内相对的」</b>：同一个进程，在宿主里可能是 PID 3000，在容器的命名空间里却是 PID 1。<span class="mono">/proc</span> 不是一块静态数据，它是内核<b>按当前进程所处的 PID 命名空间实时生成的视图</b>。</p>' +
              '<p>所以容器启动时一定要在自己的挂载命名空间里重新挂一次：<span class="mono">mount -t proc proc /proc</span>。挂载动作本身会带上「是谁在挂」的上下文，内核据此生成对应的内容。</p>' +
              '<p><b>如果忘了这一步</b>，容器里的进程会看到宿主的 /proc——`ps` 里冒出一堆不该看见的进程，PID 1 也不是它的 init。<b>这是一个既影响功能、又直接暴露环境性质的错误。</b></p>') +
            T.grid(2, [
              '<div class="card"><div class="card-title">其他常见挂载点</div><p><span class="mono">/dev</span>（设备节点，常配合 binderfs）、<span class="mono">/sys</span>、<span class="mono">/dev/pts</span>、<span class="mono">/dev/shm</span>。它们和 /proc 一样，都是「内核视图」，必须按命名空间重新挂。</p></div>',
              '<div class="card"><div class="card-title">对检测的意义</div><p>风控非常喜欢读 <span class="mono">/proc</span> 和 <span class="mono">/sys</span>：进程列表、CPU 信息、设备树、网络统计。挂载没做干净，这里就是最大的破绽来源。</p></div>'
            ]) +
            T.note('', '📌 Linux init 进程：内核交给用户空间的第一棒',
              '<p>内核启动的最后一步，是执行 <span class="mono">/sbin/init</span>（也可以用 <span class="mono">init=</span> 内核参数指定别的路径）。这个进程成为 <b>PID 1</b>，职责有三件：<b>挂载文件系统、启动服务、回收孤儿进程</b>。</p>' +
              '<p>在容器里，PID 1 的角色由<b>容器运行时或一个精简 init</b> 承担。而 Android 的情况更特殊：它的用户空间里也有一份自己的 <span class="mono">/init</span>（在 ramdisk 里），负责解析 <span class="mono">init.rc</span> 并拉起 servicemanager、zygote 等一整套服务——这一层属于<b>下一节要讲的 Android 启动链路</b>。</p>' +
              '<p><b>容易踩的坑：</b>PID 1 在 Linux 里有特殊语义（信号处理、僵尸进程回收）。container 里如果 PID 1 是一个不处理 SIGCHLD 的普通程序，就会出现「僵尸进程堆积」——症状是容器跑久了越来越怪，但单看每个服务都正常。</p>'),
      term: {
        title: '容器启动时的挂载与 init 时序（示意）',
        lines: [
          { t: 'p', s: 'unshare --pid --mount --uts --ipc --net --fork ...', note: '<b>先把命名空间开出来。</b>这一步之后，进程看到的 PID/挂载/网络就是「自己那一份」了。' },
          { t: 'd', s: '（下面在容器内部执行，命令为示意，具体实现随运行时不同）' },
          { t: 'p', s: 'mount --bind /host/rootfs /container/root', note: '<b>绑定挂载 rootfs。</b>把宿主准备好的一套文件系统「接」到容器的根上——数据还是那一份，入口换了。' },
          { t: 'p', s: 'mount -t proc proc /container/root/proc', note: '<b>重新挂 /proc，这一步最容易被漏。</b>漏了就会看到宿主的进程表，PID 1 也不是容器自己的 init。', state: { '当前命名空间': '新 PID ns', '/proc 归属': '容器命名空间' } },
          { t: 'p', s: 'mount -t sysfs sys /container/root/sys', note: '<b>同理挂 /sys。</b>内核视图都要按命名空间重建。' },
          { t: 'p', s: 'mount --bind /dev/binderfs /container/root/dev/binderfs', note: '<b>把 binder 设备接进容器。</b>没有它，Android 的 IPC 从第一秒就不通。' },
          { t: 'p', s: 'chroot /container/root /sbin/init', note: '<b>切根并交棒给 init。</b>从这一刻起，容器内的 PID 1 就是它；宿主内核仍然是那个宿主内核。' },
          { t: 'o', s: '[    0.000000] Linux version ...' },
          { t: 'o', s: 'init: 启动用户空间服务 ...' },
          { t: 'w', s: '注意：真实运行时的挂载顺序、参数与安全加固（只读挂载、noexec、SELinux 标签等）比这里复杂得多，以上只表达「顺序与依赖关系」。' }
        ]
      }
    },

    /* ================= 32.7 ================= */
    {
      h: '32.7',
      title: 'Android 完整启动链路：从通电到 App 的第一行代码',
      html: '<p>这是全课程<b>最完整的一张系统图</b>。前面每一章你都在某个局部打转——Frida 在 App 层、unidbg 在模拟执行层、eBPF 在内核层——但它们最终都跑在下面这条链路的<b>某一环</b>上。看懂它，你就知道「我的 hook 到底插在哪一层」，也就知道<b>容器化环境下哪些环节被替换了、哪些环节反而成了新的攻击面</b>。</p>' +
            T.note('key', '🔑 看这条链路时，永远问三个问题',
              '<p>① <b>这一步做了什么？</b>② <b>在哪里可以看到它的痕迹？</b>（没有观测手段的步骤等于不存在）③ <b>容器化环境下有什么不同？</b></p>' +
              '<p>第三个问题是本章独有的。因为在容器里跑 Android，<b>这条链路的前半段根本不会发生</b>——没有 BootROM、没有 Bootloader，因为宿主已经启动完了。Android 是从半途「接上」的。</p>'),
      stage: {
        title: 'Android 启动链路全流程',
        speed: 1750,
        render: '<div class="flow-col" style="max-width:820px">' +
                '<div class="blk" id="b1">① BootROM<span class="small"> · SoC 内固化的第一段代码</span></div><div class="arrow">↓</div>' +
                '<div class="blk" id="b2">② Bootloader（abl / lk）<span class="small"> · 初始化内存、校验并加载 boot.img</span></div><div class="arrow">↓</div>' +
                '<div class="blk" id="b3">③ boot.img = 内核 + ramdisk<span class="small"> · ramdisk 里有 /init</span></div><div class="arrow">↓</div>' +
                '<div class="blk" id="b4">④ 内核启动<span class="small"> · 解压、初始化驱动、挂载 initramfs</span></div><div class="arrow">↓</div>' +
                '<div class="blk" id="b5">⑤ 执行 /init（PID 1）<span class="small"> · Android 的 init，不是 systemd</span></div><div class="arrow">↓</div>' +
                '<div class="blk" id="b6">⑥ 解析 init.rc<span class="small"> · 声明式启动脚本：service / action / trigger</span></div><div class="arrow">↓</div>' +
                '<div class="blk" id="b7">⑦ servicemanager<span class="small"> · binder 的「电话簿」</span></div><div class="arrow">↓</div>' +
                '<div class="blk" id="b8">⑧ zygote<span class="small"> · 所有 App 进程的父进程</span></div><div class="arrow">↓</div>' +
                '<div class="blk" id="b9">⑨ system_server<span class="small"> · 几百个系统服务住在里面</span></div><div class="arrow">↓</div>' +
                '<div class="blk" id="b10">⑩ fork 应用进程<span class="small"> · zygote fork + ActivityThread</span></div><div class="arrow">↓</div>' +
                '<div class="blk" id="b11">⑪ App 第一行代码开始执行</div>' +
                '<div class="flow-row" style="margin-top:14px;align-items:center;gap:10px">' +
                '<span class="pill" id="bx1">容器化替代范围</span><span class="pill" id="bx2">当前层次</span></div>' +
                '</div>',
        reset: () => {
          for (let i = 1; i <= 11; i++) S('b' + i, '');
          CLS('bx1', 'pill'); SET('bx1', '容器化替代范围');
          CLS('bx2', 'pill'); SET('bx2', '当前层次');
        },
        steps: [
          { run: () => S('b1', 'active'), note: '<b>① BootROM：SoC 里那段改不动的代码。</b>上电后 CPU 从固定地址取指，它只做最少的事——把下一段引导程序载入并交出去。<br><b>可观察点：</b>基本看不到，只能通过串口/调试口在最早期抓输出。<br><b>容器化差异：</b><span class="hit">整步不存在。</span>宿主早就启动完了，容器里的 Android 不会经历上电。' },
          { run: () => { S('b1', 'done'); S('b2', 'active'); CLS('bx2', 'pill acc'); SET('bx2', '硬件层 · 容器中不存在'); }, note: '<b>② Bootloader（abl / lk 这类）：真正的「第一段可变代码」。</b>它初始化 DDR、决定从哪个分区启动、校验镜像完整性（<span class="term" data-def="Android Verified Boot：校验启动链上每个镜像的完整性，防止被篡改">AVB</span> / vbmeta），最后把 boot.img 载入内存并跳进去。<br><b>可观察点：</b>fastboot 界面、<span class="mono">fastboot getvar</span> 的解锁状态；解锁与否直接决定你能不能刷自己的镜像。<br><b>容器化差异：</b>同样跳过。这是<b>刷机/改机玩法的入口层</b>，容器里没有对应物。' },
          { run: () => { S('b2', 'done'); S('b3', 'active'); }, note: '<b>③ boot.img 被载入：它里面装的是内核 + ramdisk。</b>ramdisk 是一个极小的根文件系统，Android 的 <span class="mono">/init</span> 就住在里面。<br><b>可观察点：</b>解包 boot.img 看内容；对比不同机型/版本的镜像结构。<br><b>容器化差异：</b>容器路线里通常没有「boot.img」这个概念——Android 的用户空间直接来自一份 rootfs 镜像；<b>但 ramdisk 与 init 的逻辑依然存在</b>，只是由容器运行时以别的方式提供（见 32.6）。' },
          { run: () => { S('b3', 'done'); S('b4', 'active'); }, note: '<b>④ 内核启动：解压自身、初始化子系统与驱动，最后挂载 initramfs。</b>这一步结束时，内核会去找那个「要执行的第一个用户空间程序」。<br><b>可观察点：</b>内核日志 <span class="mono">dmesg</span>；启动早期的串口输出。<br><b>容器化差异：</b><span class="hit">这一步被彻底替换。</span>容器共享宿主内核，宿主内核<b>早就在跑了</b>。容器启动不会产生新的内核启动日志——<b>这本身就是一个可被检测的特征</b>（某些检测会去看内核启动时间与系统运行时间的矛盾）。' },
          { run: () => { S('b4', 'done'); S('b5', 'active'); }, note: '<b>⑤ 内核执行 /init，它成为 PID 1。</b>Linux 的惯例是 <span class="mono">/sbin/init</span>（可用 <span class="mono">init=</span> 参数指定），Android 用的是自己那份 <span class="mono">/init</span>，在 ramdisk 里。<br><b>可观察点：</b><span class="mono">ps</span> 里 PID 1 是谁；<span class="mono">/proc/1/</span> 下的信息。<br><b>容器化差异：</b><b>这里的落点完全不同。</b>容器里的 PID 1 由容器运行时或精简 init 承担，Android 的 <span class="mono">/init</span> 往往<b>不是</b> PID 1——这是一个非常值得记住的差异点。' },
          { run: () => { S('b5', 'done'); S('b6', 'active'); }, note: '<b>⑥ init 解析 init.rc：Android 的启动是「声明式」的。</b><span class="mono">init.rc</span> 及其包含的众多 <span class="mono">.rc</span> 文件里写着 service（要启动哪些进程）与 action/trigger（在什么条件下做什么）。<br><b>可观察点：</b>直接读 <span class="mono">/system/etc/init/</span> 等目录下的 rc 文件——<b>这是理解一台设备「为什么这样启动」最直接的材料</b>。<br><b>容器化差异：</b>逻辑基本保留（Android 用户空间还是那套），但部分 rc 会因为硬件不存在或权限不同而走不到。' },
          { run: () => { S('b6', 'done'); S('b7', 'active'); CLS('bx2', 'pill ok'); SET('bx2', 'Android 用户空间 · 容器中保留'); }, note: '<b>⑦ servicemanager 起来，binder 的「电话簿」开张。</b>所有系统服务都要来这里注册自己的名字，客户端再按名字去查句柄。<b>没有 binder，就没有 Android。</b>这正是 32.3 强调宿主内核必须支持 binder 的原因。<br><b>可观察点：</b>进程列表里的 servicemanager；用 binder 相关的调试手段列出已注册服务。<br><b>容器化差异：</b>保留，但<b>依赖宿主内核与设备节点</b>——这是容器化 Android 最容易失败的一环。' },
          { run: () => { S('b7', 'done'); S('b8', 'active'); }, note: '<b>⑧ zygote 启动：所有 App 进程的「母体」。</b>它预加载大量框架类与资源，之后 App 进程都从它 fork 出来——这样新 App 启动时不必重复做这些昂贵的事。<br><b>可观察点：</b>进程列表里的 zygote / zygote64（<b>这也是 Zygisk 注入的目标进程，见 32.8</b>）。<br><b>容器化差异：</b>完全保留。zygote 是 Android 用户空间的一部分，跟跑在谁的内核上无关。' },
          { run: () => { S('b8', 'done'); S('b9', 'active'); }, note: '<b>⑨ system_server：zygote fork 出的第一个「大进程」。</b>ActivityManager、PackageManager、WifiService……几百个系统服务住在里面，它们是 App 调用一切系统能力的<b>真正服务端</b>。<br><b>可观察点：</b><span class="mono">dumpsys</span> 全家桶——<b>这是排查「系统认为自己是台什么设备」的最佳工具</b>。<br><b>容器化差异：</b>保留。而且这里就是<b>虚拟 WiFi 要动手的地方</b>（WifiService 就在这个进程里，见 32.9）。' },
          { run: () => { S('b9', 'done'); S('b10', 'active'); }, note: '<b>⑩ 启动一个 App：zygote fork 出新进程。</b>新进程里执行到 ActivityThread，接下来才轮到 Application / Activity 的生命周期。<br><b>可观察点：</b>进程列表、<span class="mono">/proc/&lt;pid&gt;/</span> 下的信息、启动耗时日志。<br><b>容器化差异：</b>保留。<b>App 完全无法从这一层感知自己是容器还是真机</b>——它看到的永远是 Android 自己的抽象。' },
          { run: () => { S('b10', 'done'); S('b11', 'active'); }, note: '<b>⑪ App 第一行代码开始执行。</b>从这里往后，就是你在前十七章学的所有东西的战场：Java 层 hook、Native 层 inline hook、算法还原、风控对抗。<br><b>但请记住：</b>App 的检测代码从这一刻起就在<b>向上摸</b>——它想知道自己脚下这条链路是真是假。' },
          { run: () => { CLS('bx1', 'pill warn'); SET('bx1', '①②③④ 被跳过 / ⑤ 的 PID 1 归属改变 / 其余保留'); S('b1', 'hot'); S('b2', 'hot'); S('b3', 'hot'); S('b4', 'hot'); }, note: '<b>整体对照：容器化把这条链路的「硬件前缀」整段砍掉了。</b>①BootROM、②Bootloader、③加载 boot.img、④内核启动<b>都不会发生</b>；⑤的 PID 1 归属也变了。剩下的 ⑥–⑪ 完全是 Android 自己的用户空间逻辑，保留。<br><b>这个结论有两面：</b>一面是你<b>少了一大堆麻烦</b>（不用刷机、不用改 boot）；另一面是<b>你也少了一大堆「真机才有的痕迹」</b>——而这正是风控要找的东西。' },
          { run: () => { CLS('bx2', 'pill'); SET('bx2', '结论：容器化 = 只重放用户空间'); }, note: '<b>一句话收束：容器化 Android 的本质，是「把 Android 的用户空间重放到另一个内核上」。</b>凡是发生在这个用户空间<b>内部</b>的事情都还在；凡是发生在它<b>下面</b>的事情都要由宿主代为「伪造」——包括内核版本、硬件信息、网络状态、启动时间。本章剩下的每一节，都是在处理这个「伪造」问题。' }
        ]
      },
      after: T.tbl(['环节', '真机', '容器化环境'], [
        ['① BootROM', '上电执行', '<b>不存在</b>'],
        ['② Bootloader（abl/lk）', '初始化内存、AVB 校验、加载 boot.img', '<b>不存在</b>'],
        ['③ boot.img（内核+ramdisk）', '独立镜像', '<b>通常不存在</b>，用户空间来自 rootfs 镜像'],
        ['④ 内核启动', '每次开机都发生', '<b>共享宿主内核</b>，不重新启动'],
        ['⑤ /init 与 PID 1', 'Android 的 /init 是 PID 1', '<b>PID 1 归属改变</b>，由容器运行时/精简 init 承担'],
        ['⑥ init.rc 解析', '声明式启动服务', '保留（可能因硬件缺失而跳过部分）'],
        ['⑦ servicemanager', '注册系统服务', '保留，<b>但强依赖宿主内核的 binder</b>'],
        ['⑧ zygote', 'App 进程的母体', '保留'],
        ['⑨ system_server', '几百个系统服务', '保留（虚拟 WiFi 的动手处）'],
        ['⑩⑪ fork App 进程 / 代码执行', 'App 运行', '保留'],
        ['分区结构（boot/system/vendor/...）', '与机型、版本强相关 <span class="pill warn">待核实</span>', '动态分区等机制在容器里通常无对应物 <span class="pill warn">待核实</span>']
      ])
    },

    /* ================= 32.7L 动手实验 ================= */
    {
      h: '32.7L', title: '动手实验：给启动链路排序，并标出容器化会跳过哪几步',
      html:
        '<p>启动链路是本章的骨架。光看动画容易"觉得懂了"，自己排一遍才知道哪几步真的记住了。</p>',
      lab: {
        title: '实验：Android 启动链路排序 + 容器化差异',
        goal: '目标：排出正确顺序并标出跳过项',
        intro:
          '<p>下面 7 个启动阶段被打乱了。<b>任务：</b>① 排出正确顺序 ② 说出容器化时<b>哪几步根本不会发生</b>。</p>' +
          '<div class="tbl-wrap" style="margin:12px 0"><table class="tbl"><thead><tr><th>编号</th><th>阶段</th></tr></thead><tbody>' +
          '<tr><td>A</td><td>解析 <code>init.rc</code>，启动各 service</td></tr>' +
          '<tr><td>B</td><td>执行 <code>/init</code>（用户空间第一个进程）</td></tr>' +
          '<tr><td>C</td><td><code>system_server</code> 就绪 → App 可被拉起</td></tr>' +
          '<tr><td>D</td><td>BootROM（SoC 内固化的第一段代码）</td></tr>' +
          '<tr><td>E</td><td><code>servicemanager</code> / <code>zygote</code> 启动</td></tr>' +
          '<tr><td>F</td><td>Bootloader（abl / lk）</td></tr>' +
          '<tr><td>G</td><td>加载并启动 Linux 内核</td></tr>' +
          '</tbody></table></div>',
        inputs: [
          { key: 'order', label: '① 正确顺序（填字母，用 → 或空格分隔）',
            hint: '从最底层硬件开始', ph: '例如 A B C ...', value: '' },
          { key: 'skip', label: '② 容器化时会跳过哪几步？（填字母）',
            hint: '想想"没有真实硬件"意味着什么', ph: '例如 A、B' },
          { key: 'why', label: '③ 为什么容器里 <code>/init</code> 的角色会变？',
            hint: '谁承担了 PID 1？', ph: '因为……', type: 'textarea', rows: 2 }
        ],
        runLabel: '🔍 校验顺序',
        run: (v) => {
          const L = window.LABX;
          const CORRECT = ['D', 'F', 'G', 'B', 'A', 'E', 'C'];
          const letters = String(v.order || '').toUpperCase().match(/[A-G]/g) || [];
          const uniq = [...new Set(letters)];

          let html = '';
          if (letters.length) {
            const ok = uniq.length === 7 && uniq.every((c, i) => c === CORRECT[i]);
            html += '<table class="lab-tbl"><tr><th>位置</th><th>正确阶段</th><th>你填的</th><th>判定</th></tr>';
            CORRECT.forEach((c, i) => {
              const got = letters[i] || '—';
              const good = got === c;
              const st = L.BOOT_STAGES[i];
              html += '<tr class="' + (good ? 'same' : 'diff') + '"><td>' + (i + 1) + '</td>'
                + '<td><code>' + c + '</code> ' + st.label + '</td>'
                + '<td><code>' + got + '</code></td>'
                + '<td>' + (good ? '✅' : '❌') + '</td></tr>';
            });
            html += '</table>';
            html += '<div class="lab-msg ' + (ok ? 'pass' : 'fail') + '"><b>'
              + (ok ? '✅ 顺序完全正确' : '❌ 顺序有误') + '</b>'
              + '<div class="lab-note">正确顺序：<b>D → F → G → B → A → E → C</b><br>'
              + '记忆线索：<b>硬件 → 引导 → 内核 → 用户空间 init → rc → 服务 → 应用框架</b>。' +
              '注意 <code>init</code>(B) 在解析 <code>init.rc</code>(A) <b>之前</b>——先有进程，才有它的配置。</div></div>';
          }

          const skipLetters = String(v.skip || '').toUpperCase().match(/[A-G]/g) || [];
          const skipUniq = [...new Set(skipLetters)];
          if (skipUniq.length) {
            const wantSkip = ['D', 'F'];
            const okSkip = skipUniq.length === 2 && wantSkip.every(x => skipUniq.includes(x));
            html += '<div class="lab-msg ' + (okSkip ? 'pass' : 'warn') + '"><b>'
              + (okSkip ? '✅ 正确：跳过 D 和 F' : '🟡 不完全是') + '</b>'
              + '<div class="lab-note"><b>D（BootROM）和 F（Bootloader）在容器里完全不存在</b> —— ' +
              '因为它们的作用是"初始化真实硬件（DDR、存储）并加载内核"，而容器<b>共用宿主内核</b>，' +
              '根本没有"上电启动"这个动作。<br><br>'
              + '容易混淆的是 <b>G（内核启动）</b>：它不是"不存在"，而是<b>"已经发生过了"</b> —— ' +
              '宿主机的内核早就跑起来了，容器只是共享它。<br>'
              + '这个区别很重要：<b>不存在</b>与<b>已发生</b>在对检测的含义上完全不同。</div></div>';
          }

          const why = String(v.why || '').trim();
          if (why) {
            const hitRuntime = window.AKKC_hasConcept(why, ['容器运行时', 'runtime', 'docker', 'runc', '迷你 init', '精简 init', '自己']);
            const hitPid1 = window.AKKC_hasConcept(why, ['pid 1', 'pid1', '第一个进程', '一号进程']);
            html += '<div class="lab-msg ' + (hitRuntime || hitPid1 ? 'pass' : 'warn') + '"><b>'
              + (hitRuntime || hitPid1 ? '✅ 抓住了要点' : '🟡 再补充一下') + '</b>'
              + '<div class="lab-note">在容器里，<b>PID 1 的角色由容器运行时（或一个精简 init）承担</b>，' +
              '而不是 Android 自己的 <code>/init</code>。<br><br>'
              + '但 Android 的情况<b>更特殊</b>：它的用户空间里<b>也有一份自己的 init 体系</b>' +
              '（init.rc 声明式启动服务）。所以容器化 Android 时，' +
              '通常的做法是<b>保留 Android 的 init 流程，只是把它挂到容器的 PID 命名空间里</b>——' +
              '这样 Android 的服务依赖关系（比如 zygote 必须在 servicemanager 之后）才能正常工作。<br><br>'
              + '<b>所以准确的说法是：</b>不是"Android 的 init 消失了"，而是<b>"硬件引导段消失了，用户空间段被保留但换了宿主"</b>。</div></div>';
          }
          return html || '<div class="lab-msg warn">先填第①问的顺序。</div>';
        },
        expected: (v) => {
          const CORRECT = ['D', 'F', 'G', 'B', 'A', 'E', 'C'];
          const letters = [...new Set(String(v.order || '').toUpperCase().match(/[A-G]/g) || [])];
          const skip = [...new Set(String(v.skip || '').toUpperCase().match(/[A-G]/g) || [])];
          const okOrder = letters.length === 7 && letters.every((c, i) => c === CORRECT[i]);
          const okSkip = skip.length === 2 && skip.includes('D') && skip.includes('F');
          return {
            ok: okOrder && okSkip,
            detail: (okOrder ? '✅ 顺序正确：D→F→G→B→A→E→C。'
                             : '❌ 顺序应为 <b>D → F → G → B → A → E → C</b>。' +
                               '注意 <code>init</code> 进程先于 <code>init.rc</code> 解析。')
              + '<br>'
              + (okSkip ? '✅ 跳过项正确：D（BootROM）和 F（Bootloader）在容器里根本不存在。'
                        : '❌ 跳过项应为 <b>D 和 F</b>。注意 G（内核启动）不是"不存在"，而是宿主机早就完成了。')
          };
        },
        showAnswer:
          '【① 正确顺序】D → F → G → B → A → E → C\n\n' +
          '  D  BootROM           SoC 内固化，只负责加载下一级\n' +
          '  F  Bootloader        初始化 DDR，校验并加载 boot 分区\n' +
          '  G  Linux 内核         解析 cmdline，挂载 ramdisk\n' +
          '  B  执行 /init         用户空间第一个进程（PID 1）\n' +
          '  A  解析 init.rc       按声明启动各 service\n' +
          '  E  servicemanager / zygote\n' +
          '  C  system_server 就绪 → App 可被拉起\n\n' +
          '  记忆线索：硬件 → 引导 → 内核 → 用户空间 → 服务 → 框架\n' +
          '  易错点：init(B) 在 init.rc(A) 之前 —— 先有进程，才有它的配置。\n\n' +
          '【② 容器化时跳过的步骤】D 和 F\n' +
          '  原因：它们的作用是初始化真实硬件并加载内核，\n' +
          '        而容器【共用宿主内核】，没有"上电"这个动作。\n\n' +
          '  ⚠️ 注意区分：G（内核启动）不是"不存在"，而是"已发生"。\n' +
          '     宿主内核早就跑起来了，容器只是共享它。\n' +
          '     "不存在"与"已发生"对检测的含义完全不同。\n\n' +
          '【③ 为什么 /init 的角色会变】\n' +
          '  在通用容器里，PID 1 由容器运行时（或精简 init）承担。\n\n' +
          '  但 Android 更特殊：它的用户空间里【也有一份自己的 init 体系】\n' +
          '  （init.rc 声明式启动服务）。所以容器化 Android 时，\n' +
          '  通常【保留 Android 的 init 流程】，只是把它挂到容器的 PID 命名空间里，\n' +
          '  这样 zygote 依赖 servicemanager 之类的顺序关系才能正常工作。\n\n' +
          '  准确说法：不是"Android 的 init 消失了"，\n' +
          '            而是"硬件引导段消失了，用户空间段被保留但换了宿主"。',
        hint:
          '从最底层开始想：<b>谁最先跑？</b>（提示：芯片里固化的那段代码）<br>' +
          '然后依次是：谁来初始化内存并找内核 → 内核起来后第一个用户空间进程是谁 → ' +
          '那个进程接下来读什么文件 → 再往上是哪些服务。<br><br>' +
          '第②问的关键：容器<b>共用宿主内核</b>，所以"上电""初始化硬件""加载内核"这些事情……' +
          '在容器里发生过吗？',
        after:
          T.note('key', '🔑 这个实验的深层价值',
            '<p style="margin-bottom:0">排序本身不难，难的是回答第②问时那个<b>微妙的区分</b>：<br>' +
            '<b>D/F 是"不存在"，G 是"已发生"。</b><br><br>' +
            '为什么这个区分重要？因为它直接决定检测手段的可行性：<br>' +
            '• 如果某一步<b>从没发生过</b>，你无法"伪装"它——只能伪造它的<b>痕迹</b><br>' +
            '• 如果某一步<b>已经发生</b>（在宿主机上），你可以<b>转述</b>它的结果<br><br>' +
            '<span class="hit">这条推理和第 29 章"真机有什么、虚拟环境缺什么"是同一个思路：' +
            '先弄清机制上什么是可能的，再推导出检测点和对抗方案。' +
            '不需要背特征清单。</span></p>')
      }
    },

    /* ================= 32.7C 实战案例 ================= */
    {
      h: '32.7C', title: '实战案例：freeRASP 的多层环境检测与"不 hook 应用代码"的绕过思路',
      case: {
        source: 'kanxue',
        title: '[原创]freeRASP签名检测和其他设备环境的绕过方案',
        date: '2026-1-18',
        author: 'wohowo',
        target: 'Talsec freeRASP（第三方 RASP SDK）',
        background:
          '<p>freeRASP 是一套被广泛集成的第三方运行时应用自保护（RASP）SDK——它不绑定某个 App，' +
          '而是作为库嵌进去，负责检测 root、模拟器、调试器、签名篡改等环境异常。</p>' +
          '<p>这个案例的价值在于它展示了一种<b>与第 24 章完全不同层级的对抗思路</b>：' +
          '作者明确提出总原则——<b>"不 hook 任何应用代码，全部走系统底层以求通杀"</b>。' +
          '因为 RASP 是<b>被集成方</b>，逐个 hook 各 App 的检测调用不现实，' +
          '只有在系统层做拦截才能一次覆盖所有集成方。</p>',
        points: [
          '<b>第一层（Native 层 BPF 系统调用拦截）</b>：在内核层拦 <code>syscall</code>，' +
            '用 <b>SIGSYS 处理器伪造返回值</b>，让被拦的调用"看起来成功了"',
          '① 拦 <code>openat</code> / <code>read</code> / <code>fstat</code>，把 APK 签名读取<b>重定向到预存的原包</b>——' +
            '作者自己加了 PS：freeRASP 其实并不直接读 APK 验签，这只是他给出的 svc 签名绕过方案',
          '② 拦 <code>read</code> 以<b>隐藏 <code>/proc/self/maps</code> 的敏感行</b>（注入库等映射项）',
          '③ 伪造 <code>/proc/self/status</code>，把 <code>Seccomp:</code> 字段从 <code>2</code> 改成 <code>0</code>——' +
            '作者自评该方案<b>不完整</b>，因为 Zygote 自身也装了 BPF',
          '④ 过滤 <code>/proc/self/mounts</code>，剔除含 <code>magisk</code> / <code>zygisk</code> / <code>core</code> / <code>mirror</code> 的行',
          '⑤ 伪造 <code>/proc/sys/kernel/ftrace_enabled</code> 与 <code>/sys/kernel/debug/tracing/current_tracer</code>',
          '<b>第二层（Java 层 API hook 伪造设备安全状态）</b>：直接改写系统 API 的返回值',
          '① <code>File.exists()</code> → 恒 <code>false</code>：隐藏 <code>/system/bin/su</code> 等 <b>70+ 个 root 路径</b>',
          '② <code>Runtime.exec()</code> → 拦截对 <code>su</code> / <code>which su</code> 的调用',
          '③ <code>PackageManager.getPackageInfo()</code> → 抛异常：隐藏 Magisk / KernelSU 等 <b>50+ 个 root 包名</b>',
          '④ <code>System.getenv("PATH")</code> → 过滤掉 <code>/sbin</code> 等可疑目录',
          '三组清单（70+ 路径 / 50+ 包名 / PATH 项）<b>均从某个加密数组解密得到</b>，文中未给出明文'
        ],
        method: [
          '<b>判断集成层级</b>：先确认 freeRASP 的检测是 Native 实现还是 Java 实现，决定拦截点放在 BPF 还是 Java API',
          '<b>定原则</b>：确立"不 hook 应用代码"——只在系统层（syscall / 系统 API）动手，对所有集成方通用',
          '<b>Native 层拦 syscall</b>：挂 BPF 程序拦目标 syscall，用 SIGSYS 处理器改写返回值和输出缓冲',
          '<b>Java 层改 API 返回值</b>：对文件检查、进程调用、包管理、环境变量四类 API 做统一改写',
          '<b>逐项验证</b>：关掉对应检测项看 RASP 是否还上报，确认拦截生效'
        ],
        result:
          '<p>给出了一套<b>跨 App 通用</b>的 freeRASP 绕过方案：Native 层 5 项 + Java 层 4 项，' +
          '覆盖签名、maps、seccomp、mounts、ftrace、root 路径、root 包名、PATH 等检测面。</p>' +
          '<p>核心思路不是"针对 freeRASP 的某个检测函数做 hook"，而是<b>从它读取环境信息的通道上做手脚</b>——' +
          '让所有走这些通道的检测都拿到伪造结果。</p>',
        terms: ['RASP', 'BPF 系统调用拦截', 'SIGSYS', '/proc/self/maps', 'Seccomp', 'Magisk', 'Zygisk', 'PackageManager'],
        limits:
          '<p><b>⚠️ 该帖正文被论坛门控截断</b>：正文在"二、设备安全状态伪造 / Root 检测绕过' +
          '（<code>System.getenv("PATH")</code> 那一行）"处即结束，作者所称<b>"四层防护体系"的第三、第四层完全不可见</b>。' +
          '抓取时已核对页面 HTML，源码中确实不存在"三、""四、"标题，因此本站<b>不对后两层做任何推测</b>。</p>' +
          '<p>其他限制：① 三组清单（70+ root 路径、50+ root 包名、PATH 项）<b>均从加密数组解密得到，文中未给出明文</b>，' +
          '具体拦截列表<b>不可复现</b>；② 作者<b>自认 seccomp 隐藏方案不完整</b>（Zygote 自身也装了 BPF）；' +
          '③ 案例针对 2026 年初的 freeRASP 版本，后续版本行为可能变化。</p>',
        analysis:
          '<p><b>本课第 32 章讲过"环境伪装的核心原则：自洽"</b>——只改一个 API 返回值一定会被交叉验证识破。' +
          '这个案例正好从攻防两个方向印证了这条原则。</p>' +
          '<p><b>① 检测方用"交叉验证"，绕过方用"统一数据源"。</b>' +
          'freeRASP 不只查一个 <code>su</code> 文件，而是同时看 root 路径、root 包名、PATH 环境变量、' +
          'mounts 挂载项、seccomp 状态多个维度——这正是第 32 章讲的"整个状态自洽"。' +
          '而作者的应对同样精彩：他不逐个去堵这些检查，而是<b>在它们共同的数据来源（syscall 与系统 API）上做统一改写</b>。' +
          '<span class="hit">这是"点防御"与"面防御"的区别。</span></p>' +
          '<p><b>② 为什么必须走系统层？</b>作者那句"不 hook 任何应用代码，全部走系统底层以求通杀"值得反复读。' +
          '因为 RASP 是<b>被集成方</b>，你面对的不是一个 App 而是无数个——' +
          '在系统层拦截一次，所有集成方同时生效。' +
          '这跟第 27 章"把观测点放到比对手更低的层级"是同一条思路，只不过这里的目的从"观测"变成了"篡改"。</p>' +
          '<p><b>③ 最值得记的是作者的自我限定。</b>他主动标注 seccomp 方案"不完整"，' +
          '也没把加密清单当成果展示。<b>这种"知道自己方案边界在哪"的态度，比方案本身更有价值</b>——' +
          '因为环境伪装永远是军备竞赛，清楚地知道你堵住了哪些口子、还漏着哪些，' +
          '才能判断当前方案在目标 App 上够不够用。</p>',
        link: 'https://bbs.kanxue.com/thread-289794.htm',
        linkNote: '看雪论坛原创帖（正文被论坛门控截断，后两层未公开）'
      }
    },

    /* ================= 32.8 ================= */
    {
      h: '32.8',
      title: 'Magisk：systemless 挂载原理与「看起来像真机」',
      html: '<p>仓库是 <span class="mono">topjohnwu/Magisk</span>。它的定位有两层：<b>Android 的 Root 方案</b>，以及<b>模块化框架</b>。但真正精彩的是它怎么做到的——<b>不碰系统分区，却能让系统「看见」被修改过的文件</b>。</p>' +
            T.note('key', '🔑 核心原理一句话',
              '<p><b>修改 boot 镜像的 ramdisk，在 init 启动的极早期注入 Magisk 自己的 init 逻辑</b>（常见做法是替换 <span class="mono">init</span> 或者修改 <span class="mono">.rc</span> 文件，由 <span class="mono">magiskinit</span> 打补丁），<b>从而在系统把各个分区挂载起来之前就拿到控制权</b>。</p>' +
              '<p>为什么必须「早」？因为一旦 /system 已经被按原样挂上并跑了半天服务，你再去改就晚了、也脏了。<b>抢在挂载之前动手，才有资格决定「系统最终看到什么」。</b></p>'),
      stage: {
        title: 'Magisk 的 systemless 挂载',
        speed: 1800,
        render: '<div class="flow-col" style="max-width:780px">' +
                '<div class="blk" id="m1">boot.img 的 ramdisk<span class="small"> · 里面原本是系统的 init</span></div><div class="arrow">↓</div>' +
                '<div class="blk" id="m2">注入 magiskinit<span class="small"> · 替换 init / 打补丁 .rc</span></div><div class="arrow">↓</div>' +
                '<div class="blk" id="m3">系统启动：magiskinit 先拿到控制权</div><div class="arrow">↓</div>' +
                '<div class="blk" id="m4">以只读方式挂载真实 /system</div><div class="arrow">↓</div>' +
                '<div class="blk" id="m5">magic mount / overlayfs：把模块文件「叠加」上去</div><div class="arrow">↓</div>' +
                '<div class="blk" id="m6">系统看到的是「被覆盖」的文件</div><div class="arrow">↓</div>' +
                '<div class="blk" id="m7">真实 /system 分区<span class="hit">一个字节都没改</span></div><div class="arrow">↓</div>' +
                '<div class="blk" id="m8">所以：可以 OTA 升级 · 可以随时卸载干净</div>' +
                '<div class="flow-row" style="margin-top:14px;gap:10px;flex-wrap:wrap">' +
                '<span class="pill" id="mp1">MagiskSU</span><span class="pill" id="mp2">Zygisk</span><span class="pill" id="mp3">DenyList</span></div>' +
                '</div>',
        reset: () => {
          for (let i = 1; i <= 8; i++) S('m' + i, '');
          ['mp1','mp2','mp3'].forEach(i => { CLS(i, 'pill'); });
          SET('mp1', 'MagiskSU'); SET('mp2', 'Zygisk'); SET('mp3', 'DenyList');
        },
        steps: [
          { run: () => S('m1', 'active'), note: '<b>起点：boot.img 的 ramdisk。</b>系统正常启动时，内核会执行这里的 init，由它去挂载 /system、/vendor 等分区并启动服务。<b>谁控制了这个 init，谁就控制了「系统将看到的世界」。</b>' },
          { run: () => { S('m1', 'done'); S('m2', 'active'); }, note: '<b>关键动作：往 ramdisk 里注入 magiskinit。</b>常见做法是替换掉系统的 init，或修改 <span class="mono">.rc</span> 文件让它先执行 Magisk 的逻辑。<br><b>可观察点：</b>解包/重打包 boot 镜像；对比原厂与打过补丁的 ramdisk。<br><b>这一步是「systemless」这个词的真正来源</b>——改动发生在 <b>boot 分区</b>，不在系统分区。' },
          { run: () => { S('m2', 'done'); S('m3', 'active'); }, note: '<b>系统启动，magiskinit 抢在最前面运行。</b>此时还没人挂载 /system，Magisk 拥有完全的主动权。<br><b>这就是「早」的价值：</b>它不是事后往一个已经跑起来的系统里塞东西，而是在系统成型之前就站在了路口。' },
          { run: () => { S('m3', 'done'); S('m4', 'active'); }, note: '<b>它把真实的 /system 以只读方式挂载起来。</b>注意：<b>只读</b>。真实分区的完整性从一开始就被保护住——这是后面「能 OTA、能干净卸载」的物理基础。' },
          { run: () => { S('m4', 'done'); S('m5', 'active'); }, note: '<b>核心手法：magic mount / overlayfs 叠加。</b>把模块里的文件「覆盖」到对应的系统路径上。<span class="term" data-def="一种联合文件系统：把多个目录按层叠起来，上层同名文件覆盖下层，对外表现为一个目录">overlayfs</span> 是 Linux 的联合挂载机制；Magisk 的 magic mount 则是在挂载层面做等价的叠加（手法与 32.6 的<b>绑定挂载</b>一脉相承）。<br><b>记忆锚点：</b>播放列表叠加——底层歌单没变，你在上面盖了一张新歌单，播放器只认最上面那张。' },
          { run: () => { S('m5', 'done'); S('m6', 'active'); }, note: '<b>结果：系统看到的是「被覆盖」的文件。</b>对 Android 来说，这个文件就是这样；它<b>无法从文件内容本身</b>判断下面还有一层。<br><b>对逆向的意义：</b>这意味着你可以往系统路径上「注入」几乎任何东西——定制的系统属性、被替换的库、额外的配置文件——而系统会当成原生的接受。' },
          { run: () => { S('m6', 'done'); S('m7', 'active'); }, note: '<b>最关键的一点：真实 /system 分区一个字节都没改。</b>所有修改都活在<b>挂载层</b>，随启动建立、随卸载消失。<br><b>对比传统改法：</b>直接改系统分区会破坏校验、导致无法 OTA，而且改动是「永久性的脏」——出了问题很难回到干净状态。' },
          { run: () => { S('m7', 'done'); S('m8', 'active'); }, note: '<b>两个直接好处：</b>① <b>可以 OTA 升级</b>——系统分区是原厂的，校验能过；② <b>可以随时卸载干净</b>——把挂载层撤掉，系统回到出厂状态。<br><b>这就是 systemless 的全部价值：把「修改」从磁盘上搬到挂载层。</b>' },
          { run: () => { CLS('mp1', 'pill ok'); SET('mp1', 'MagiskSU · 权限管理'); }, note: '<b>MagiskSU：提供 root 权限管理。</b>它决定「哪个 App 可以拿到 root」，以及以什么身份拿。<br><b>注意它的双重身份：</b>对你自己是便利（调试、抓包、注入），对风控是<b>明确的信号</b>——所以才有下面两个组件。' },
          { run: () => { CLS('mp2', 'pill ok'); SET('mp2', 'Zygisk · 注入 Zygote'); }, note: '<b>Zygisk：在 Zygote 进程注入代码的机制。</b>因为 Zygote 是<b>所有 Android 应用进程的父进程</b>（回看 32.7 第⑧步），在这里注入就等于<b>每个 App 进程一出生就带着你的代码</b>。<br><b>这是模块 Hook 最有效的位置</b>——比在 App 里事后 hook 更早、更全面。' },
          { run: () => { CLS('mp3', 'pill ok'); SET('mp3', 'DenyList · 隐藏 root'); }, note: '<b>DenyList（旧称 MagiskHide）：隐藏 root 状态，对抗检测。</b>它的存在本身就说明了一个事实：<b>「有 root」和「不被发现」是两件必须同时做到的事</b>。<br><b>对逆向的意义：</b>Magisk 是让云手机/容器化安卓<span class="hit">看起来像真机</span>的关键一环——隐藏 root、注入定制模块、按 App 白名单决定谁看得见什么。' },
          { run: () => { CLS('mp1', 'pill acc'); CLS('mp2', 'pill acc'); CLS('mp3', 'pill acc'); }, note: '<b>三个组件合起来，就是一台「可编程的真机」：</b>你能拿到最高权限（MagiskSU）、能在每个进程出生时注入（Zygisk）、还能对着风控装作什么都没有（DenyList）。<br><b>但要清醒：</b>隐藏是一个<b>持续对抗</b>的过程，不是装完就赢。检测方会看挂载表、看进程、看属性、看行为——<b>任何一处不自洽，前功尽弃</b>。这就是下一节的主题。' }
        ]
      },
      after: T.note('warn', '⚠️ 容器化环境下 Magisk 的位置会变',
              '<p>在真机上，Magisk 改的是 boot 镜像的 ramdisk；而在<b>容器化 Android</b> 里，你往往<b>本来就控制着整个用户空间镜像</b>——很多在真机上要靠 Magisk 才能做到的事情（替换系统文件、注入 init 逻辑），在这里可以直接在镜像层面完成。</p>' +
              '<p>但 Magisk 依然有两个不可替代的价值：<b>① 模块化的增量修改</b>（可开关、可卸载、可组合）；<b>② Zygisk 的注入时机</b>（每个 App 进程出生即被注入）。<span class="pill warn">具体在 remote_android 中的取舍与实现以作者发布为准，待核实</span>。</p>')
    },

    /* ================= 32.9 ================= */
    {
      h: '32.9',
      title: '虚拟 WiFi：让「网络环境」自己讲得通',
      html: '<p>这是本章最能体现「伪装思维」的一节。App 检查自己是不是在真机上跑，<b>网络环境是最便宜、也最常用的判据之一</b>：真机往往连着 WiFi 或蜂窝网，而机房里的实例可能只有一张 <span class="mono">eth0</span>，网段还长得像数据中心。</p>' +
            '<p>容器化环境下<b>根本没有真实 WiFi 硬件</b>。那要怎么办？新手的第一反应是：「我把 <span class="mono">WifiManager</span> 的返回值 hook 掉不就行了？」——<b>这正是最容易翻车的地方。</b></p>' +
            T.note('bad', '❌ 为什么「只改一个 API 返回值」一定会被识破',
              '<p>因为 App 不会只问一个问题。它会从<b>多个互相独立的数据源</b>去问<b>同一件事</b>，然后<b>对账</b>：</p>' +
              '<p>Java 层的 <span class="mono">WifiManager</span> 说「我连着 BSSID=<span class="mono">aa:bb:...</span> 的路由器」，但内核视角的 <span class="mono">/proc/net/wireless</span> 是空的；扫描结果是空列表，可 RSSI 却有一个漂亮的 <span class="mono">-45 dBm</span>；IP 是 <span class="mono">10.0.x.x</span> 的数据中心网段，网关却号称是一台家用路由器……</p>' +
              '<p><b>任何一处对不上账，前面所有的伪装都白做。</b>风控不需要证明你是假的，它只需要发现你的证据链有矛盾。</p>'),
      stage: {
        title: '虚拟 WiFi 的自洽性要求',
        speed: 1850,
        render: '<div class="flow-col" style="max-width:860px">' +
                '<div class="blk" id="w1">App 发起「网络环境」检查</div><div class="arrow">↓</div>' +
                '<div class="flow-row" style="gap:8px;flex-wrap:wrap">' +
                '<div class="blk" id="w2">WifiManager<br><span class="small">SSID / BSSID</span></div>' +
                '<div class="blk" id="w3">信号强度<br><span class="small">RSSI 及其变化</span></div>' +
                '<div class="blk" id="w4">IP / 网关 / DNS<br><span class="small">网络参数</span></div>' +
                '<div class="blk" id="w5">扫描结果列表<br><span class="small">周围有哪些 AP</span></div>' +
                '<div class="blk" id="w6">/proc/net/wireless<br><span class="small">内核视角</span></div>' +
                '</div><div class="arrow">↓</div>' +
                '<div class="blk" id="w7">交叉对账：这些值互相说得通吗？</div><div class="arrow">↓</div>' +
                '<div class="flow-row" style="gap:10px"><span class="pill" id="wr1">自洽</span><span class="pill" id="wr2">矛盾</span></div>' +
                '</div>',
        reset: () => {
          ['w1','w2','w3','w4','w5','w6','w7'].forEach(i => S(i, ''));
          CLS('wr1', 'pill'); CLS('wr2', 'pill');
          SET('wr1', '自洽'); SET('wr2', '矛盾');
        },
        steps: [
          { run: () => S('w1', 'active'), note: '<b>App 在启动或关键操作前做一次网络环境检查。</b>成本极低、不需要任何权限（有些信息连权限都不要），却是判断运行环境的强信号——所以它是风控的常客。' },
          { run: () => { S('w1', 'done'); S('w2', 'active'); }, note: '<b>第一问：SSID / BSSID。</b>这些值由系统服务提供，真机上源自驱动的扫描与关联结果。<br><b>容器里的现实：</b>没有 WiFi 硬件，这些值要么不存在，要么是编的。<b>关键不只是「有没有值」，而是这个值和其他证据对不对得上。</b>' },
          { run: () => { S('w2', 'done'); S('w3', 'active'); }, note: '<b>第二问：信号强度。</b>真机的 RSSI 是<b>持续波动</b>的——你手一挡就掉，走动一下就变。<br><b>自洽要求：</b>如果每次查询都返回同一个完美值（比如恒定 <span class="mono">-50 dBm</span>），这本身就是异常——<b>真实世界是不停抖动的</b>。' },
          { run: () => { S('w3', 'done'); S('w4', 'active'); }, note: '<b>第三问：IP / 网关 / DNS。</b>这一项最容易被忽略，也最容易露馅：BSSID 指向一台家用路由器，IP 却是数据中心网段、网关是 <span class="mono">10.x</span> 内网地址——<b>两者物理上不可能同时成立</b>。<br><b>对账关系：</b>BSSID ↔ 网关 ↔ 网段 ↔ DNS，这是一条链。' },
          { run: () => { S('w4', 'done'); S('w5', 'active'); }, note: '<b>第四问：扫描结果列表。</b>真机在居民区/办公楼里扫一圈，能看到一堆邻居 AP，强度有高有低、加密方式五花八门。<br><b>自洽要求：</b>扫描结果是空列表、或者清一色信号满格、或者邻居 AP 的名字明显是生成的——<b>都会被立刻标记</b>。' },
          { run: () => { S('w5', 'done'); S('w6', 'active'); }, note: '<b>第五问：/proc/net/wireless —— 内核视角。</b>这一项最狠，因为它绕过了整个 Java 层与系统服务：<b>你 hook 了 WifiManager，不代表内核里真有这张网卡。</b><br><b>这是「交叉验证」的教科书案例：</b>上层说有一套 WiFi，底层说没有。<br><b>对逆向的意义：</b>凡是同时存在「上层 API」和「内核视图」的信息，都要两边一起动，否则必然矛盾。' },
          { run: () => { S('w6', 'done'); S('w7', 'active'); CLS('wr2', 'pill bad'); SET('wr2', '矛盾 → 判定为异常运行环境'); }, note: '<b>对账：三条证据指向两个不同的世界。</b>风控不需要抓到「你在用云手机」的铁证，它只要发现<b>证据之间不自洽</b>，就可以按高风险处理——降权、加验证码、拒绝登录。' },
          { run: () => { S('w7', 'done'); CLS('wr2', 'pill'); SET('wr2', '矛盾'); CLS('wr1', 'pill ok'); SET('wr1', '自洽 → 通过这一层检查（不代表全部通过）'); }, note: '<b>正确姿势：伪造一整套「自洽的状态」，而不是伪造一个「正确的返回值」。</b>这意味着要同时覆盖：系统服务层（WifiManager 背后的服务）、内核可读的视图（<span class="mono">/proc</span> 等）、以及<b>时间维度</b>。' },
          { run: () => { S('w2', 'cool'); S('w3', 'cool'); S('w4', 'cool'); S('w5', 'cool'); S('w6', 'cool'); }, note: '<b>时间维度是最容易被忽略的一层。</b>真机的 WiFi 状态有历史：信号在抖动、偶尔切换 AP、断开又重连、扫描列表随位置变化。<br><b>一个「刚刚才有、而且永远不变」的 WiFi，比没有 WiFi 更可疑。</b>' },
          { run: () => { CLS('wr1', 'pill acc'); SET('wr1', '核心原则：伪装必须自洽'); }, note: '<b>本节的核心原则：伪装必须自洽。</b>不是「让 API 返回真」，而是<b>让一整套状态机看起来被真实使用过</b>——包括它的历史、它的波动、它和其他子系统之间的约束关系。<br><b>这条原则适用于本章所有的伪装工作：</b>root 的隐藏、图形指纹的一致、设备信息的完整，都是同一件事。' }
        ]
      },
      after: T.tbl(['检测面', 'App 会读到什么', '只改单一 API 会怎样', '自洽要求'], [
        ['SSID / BSSID', '当前关联的无线网络标识', 'Java 层说有，底层设备不存在 → 当场矛盾', 'BSSID 的格式与厂商前缀要像真的，并与网关/网段配套'],
        ['RSSI 信号强度', '信号强度及其随时间的变化', '恒定值 = 明显不真实', '要有抖动，且抖动范围符合物理直觉'],
        ['扫描结果列表', '周围可见的 AP 列表', '空列表或过于整齐 → 立刻可疑', '数量、强度分布、加密方式、名称都要合理'],
        ['IP / 网关 / DNS', '网络参数', '与 BSSID 描述的场景不匹配', '与「这台设备连的是什么网」保持一致'],
        ['<span class="mono">/proc/net/wireless</span>', '<b>内核视角</b>的无线设备信息', '<b>上层改了这里没改 → 最硬的矛盾</b>', '要么真有对应支撑，要么在更底层一起伪造'],
        ['连接历史 / 网络切换', '系统记录过的网络', '从未连接过任何网络，却一直在线', '要有可解释的历史轨迹']
      ]) +
      T.note('warn', '⚠️ 边界声明',
              '<p>本节讲的是<b>机制与自洽性原理</b>，用于理解风控如何做环境检测、以及容器化环境为什么难做真。<b>具体到某个 App 的检测项清单、某个虚拟 WiFi 方案的实现细节，都不在本章断言范围内</b> <span class="pill warn">待核实</span>。</p>' +
              '<p><b>出问题往哪查：</b>当实例「功能正常但被风控拦」时，按本节表格<b>逐行对账</b>——先找出哪两条证据互相矛盾，再决定在哪一层修。<b>不要在没有定位矛盾点之前就开始 hook</b>，那是纯粹的碰运气。</p>')
    },

    /* ================= 32.10 ================= */
    {
      h: '32.10',
      title: 'KVM API：从用户态亲手造一台机器',
      html: '<p><span class="term" data-def="Kernel-based Virtual Machine：Linux 内核的硬件虚拟化接口，把内核变成 Type-1 Hypervisor">KVM</span> 是 Linux 内核的硬件虚拟化接口。它最迷人的地方在于<b>接口极其简单</b>：内核通过一个字符设备 <span class="mono">/dev/kvm</span> 暴露 API，用户态程序（QEMU、Cuttlefish、crosvm 都是这么干的）用 <b>ioctl</b> 去调用它。</p>' +
            '<p><b>前提：</b>CPU 要支持硬件虚拟化（Intel VT-x / AMD-V / ARM Virtualization Extensions）<b>而且 BIOS/UEFI 里开启了</b>。这个前提不满足时，<span class="mono">/dev/kvm</span> 根本不会出现——这也是你应该养成习惯的<b>第一个检查动作</b>（回看 32.3 的体检）。</p>' +
            '<p>下面用一个极简的 vmm（虚拟机监视器）骨架，把 KVM 的主要 ioctl 走一遍。<b>看懂它，你就看懂了 QEMU 这类程序的骨架</b>——它们无非是把这套调用做得更完整、更工程化。</p>' +
            T.note('key', '🔑 记住三样东西就够了',
              '<p><b>一个设备</b>：<span class="mono">/dev/kvm</span>。<b>三类 fd</b>：kvm（系统）→ vm（虚拟机）→ vcpu（虚拟 CPU）。<b>一个循环</b>：<span class="mono">KVM_RUN</span> 进去、VM Exit 出来、处理完再进去。</p>' +
              '<p>所有虚拟化软件，本质上都是这三样东西的扩展：<b>虚拟机是 fd，vCPU 是线程，VM Exit 是事件源。</b></p>'),
      stepper: {
        title: 'KVM API 调用流程（vmm 骨架）',
        lines: [
          { code: '<span class="k">int</span> kvm_fd = <span class="f">open</span>(<span class="s">"/dev/kvm"</span>, O_RDWR);',
            note: '<b>第一步永远是打开设备。</b>打开失败基本只有三种原因：CPU 不支持硬件虚拟化、BIOS 里没开、或者权限不够。<b>先把这三条排除掉，再怀疑别的。</b>',
            state: { 'kvm_fd': '3（打开成功）', '前提': 'CPU 虚拟化扩展 + BIOS 已开启', '失败时': '/dev/kvm 不存在或无权限' } },
          { code: '<span class="k">int</span> api = <span class="f">ioctl</span>(kvm_fd, KVM_GET_API_VERSION, <span class="n">0</span>);',
            note: '<b>先问版本，再动手。</b>确认这个内核暴露的 KVM 接口版本与你的程序预期一致（KVM_API_VERSION 为 12）。这是 ioctl 协议的标准开场——<b>不打招呼就调用后面的接口，出了问题你连「是版本不匹配」都想不到。</b>',
            state: { 'kvm_fd': '3', 'API 版本': '12', '含义': '接口协议对得上' } },
          { code: '<span class="k">int</span> vm_fd = <span class="f">ioctl</span>(kvm_fd, KVM_CREATE_VM, <span class="n">0</span>);',
            note: '<b>创建虚拟机，拿到 vm_fd。</b>注意层级：KVM_CREATE_VM 是<b>系统级</b> ioctl（作用在 kvm_fd 上），从这里往后都是<b>虚拟机级</b> ioctl（作用在 vm_fd 上）。<b>这一个 fd，就代表「一台机器」。</b>',
            state: { 'kvm_fd': '3', 'vm_fd': '4（新建）', 'vm 状态': '已创建，尚无内存与 CPU' } },
          { code: '<span class="k">struct</span> kvm_userspace_memory_region r = { .slot = <span class="n">0</span>, .guest_phys_addr = <span class="n">0</span>, .memory_size = SIZE, .userspace_addr = (<span class="k">unsigned long</span>)mem };',
            note: '<b>准备内存映射结构体。</b>看清楚这四个字段的意思：<b>slot</b>（第几号映射）、<b>guest_phys_addr</b>（guest 眼里的物理地址）、<b>memory_size</b>（多大）、<b>userspace_addr</b>（<span class="hit">你自己进程里那块内存的地址</span>）。',
            state: { 'vm_fd': '4', 'slot': '0', 'guest 物理地址': '0x0 起', '宿主内存': '用户态缓冲区' } },
          { code: '<span class="f">ioctl</span>(vm_fd, KVM_SET_USER_MEMORY_REGION, &amp;r);',
            note: '<b>KVM 最关键的一步。</b>KVM <b>不替你分配 guest 的物理内存</b>——它让你把<b>自己进程里的一块内存</b>登记成 guest 的物理地址空间。<br><b>由此推出两件重要的事：</b>① guest 读写的每一个字节，最终都落在你用户态的缓冲区里；② 你<b>随时可以直接读写 guest 的内存</b>，不需要走任何虚拟机接口。<b>这就是调试器、内存取证、脱壳工具能工作在虚拟机上的根本原因。</b>',
            state: { 'vm_fd': '4', '内存 slot': 'slot 0 已登记', '宿主视图': 'mem[] 可被本进程直接读写' } },
          { code: '<span class="k">int</span> vcpu_fd = <span class="f">ioctl</span>(vm_fd, KVM_CREATE_VCPU, <span class="n">0</span>);',
            note: '<b>创建第 0 号虚拟 CPU。</b>多核就是循环创建多个 vCPU（1、2、3……），每个 vCPU 通常由一个<b>独立的宿主线程</b>去驱动。<br><span class="small muted">vCPU 的初始寄存器状态与体系结构相关，实际 vmm 还需要额外设置。</span>',
            state: { 'vm_fd': '4', 'vcpu_fd': '5（新建）', 'vCPU 状态': '已创建，未运行' } },
          { code: '<span class="k">struct</span> kvm_run *run = <span class="f">mmap</span>(NULL, mmap_size, PROT_READ | PROT_WRITE, MAP_SHARED, vcpu_fd, <span class="n">0</span>);',
            note: '<b>把 vCPU 的 kvm_run 结构映射到本进程。</b>这是很多人第一次写 vmm 时漏掉的一步，也是<b>整个循环能成立的关键</b>：guest 每次因某个原因退出时，退出原因与相关参数就写在这块共享内存里；你的程序读它来决定下一步做什么。',
            state: { 'vcpu_fd': '5', 'kvm_run': '已映射（共享内存）', '作用': '读取 VM Exit 原因' } },
          { code: '<span class="f">ioctl</span>(vcpu_fd, KVM_SET_REGS, &amp;regs); <span class="c">/* 设置初始寄存器，把 PC 指向 guest 入口 */</span>',
            note: '<b>给这台「机器」设置上电后的第一站。</b>在真机上这件事由 BootROM 完成（回看 32.7 第①步）；在这里，<b>你就是那个 BootROM</b>——你直接告诉 vCPU 从哪里开始执行。<br><b>这个对照非常有价值：</b>它说明「引导」本质上是「设定初始状态」，而虚拟化只是让你有权设定它。',
            state: { 'vcpu_fd': '5', '初始 PC': 'guest 内核入口', 'vCPU 状态': '已就绪' } },
          { code: '<span class="k">while</span> (<span class="n">1</span>) { <span class="f">ioctl</span>(vcpu_fd, KVM_RUN, <span class="n">0</span>); <span class="f">switch</span> (run-&gt;exit_reason) { <span class="c">/* 处理各类 VM Exit */</span> } }',
            note: '<b>虚拟机的心脏：KVM_RUN 循环。</b>这个 ioctl 会<b>阻塞</b>，直到 guest 因为某个原因退出（访问了未映射的地址、执行了需要模拟的指令、等待中断、关机等）。你处理完，再调一次 KVM_RUN 继续。<br><b>CPU 的开销几乎全在 guest 里</b>，宿主只是在每次退出时做一点点事——这就是硬件虚拟化比软件模拟快几个数量级的根本原因。',
            state: { 'vCPU 状态': '运行中 ↔ 已退出（循环）', '宿主线程': '每个 vCPU 一个', '退出原因': 'run->exit_reason' } },
          { code: '<span class="c">/* VM Exit 处理：按 exit_reason 分派 */</span>',
            note: '<b>VM Exit 就是虚拟机的「事件循环」。</b>典型的处理包括：模拟一次设备 IO（对应 32.4 里那些 virtio 设备）、处理 MMIO 访问、注入中断、响应关机请求。<br><b>到这里可以下结论了：所谓「虚拟机」，就是一个用户态程序在不停地接住 CPU 抛出来的事件。</b>',
            state: { 'vCPU 状态': '已退出，等待处理', '典型事件': 'IO / MMIO / 中断 / 关机' } },
          { code: '<span class="f">close</span>(vcpu_fd); <span class="f">close</span>(vm_fd); <span class="f">close</span>(kvm_fd);',
            note: '<b>清理。</b>三层 fd 依次关闭，mmap 的内存解除映射。<br><b>顺带记住这个层级关系</b>：kvm → vm → vcpu，<b>上面的一关，下面的全部失效</b>。这是排查「为什么我的 vm 忽然不可用」时最该先想到的方向。',
            state: { 'kvm_fd': '已关闭', 'vm_fd': '已关闭', 'vcpu_fd': '已关闭', 'vCPU 状态': '已销毁' } }
        ]
      },
      after: T.note('', '📌 KVM 在移动端的演进：AVF 与 pKVM',
              '<p>Android 上的 <b>Android Virtualization Framework（AVF）</b> 与 <b>pKVM（protected KVM）</b> 是 KVM 在移动端的延伸。它们的动机和服务器虚拟化不同：不是「多租户」，而是<b>把安全敏感的东西（密钥、支付、DRM）放进一个即使主系统被攻破也攻不破的隔离域里</b>。</p>' +
              '<p><b>对逆向的含义：</b>如果你的目标把关键逻辑放进了这类受保护的环境，那么在主系统里做的一切 hook 都够不着它——<b>攻击面从「代码」变成了「两个世界之间的接口」</b>。这是移动安全对抗正在滑向的方向，值得持续关注。<span class="pill warn">具体版本与机型支持情况待核实</span>。</p>')
    },

    /* ================= 32.11 ================= */
    {
      h: '32.11',
      title: '综合情境演练：三个真实的抉择',
      html: '<p>下面三个情境，都来自「把安卓搬进容器/云端」这条路上真实会做的判断。请先想清楚<b>你依据什么做决定</b>，再看结果——本章考的不是记忆力，是<b>决策模型</b>。</p>',

      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一 · 路线选型',
            scenario: '<b>情境：</b>你要搭一套云端安卓环境，业务方给出两条硬性要求：<b>① 首屏与视频必须流畅</b>；<b>② 目标 App 的风控很激进，会读大量设备与硬件信息</b>。你需要在「Waydroid 容器路线」与「QEMU/Cuttlefish 虚拟机路线」之间做选择。你怎么决策？',
            choices: [
              { t: '选容器路线。因为它没有虚拟化层、性能接近原生，而且容器内的 Android 可以直接访问真实硬件——真硬件比虚拟硬件更不容易露馅', next: 'n1' },
              { t: '选虚拟机路线。因为「一台独立的机器」这个幻觉更完整，隔离也更强，设备信息全部由我自己提供，检测面反而更好控制', next: 'n2' },
              { t: '两条都不用：直接把安卓刷到一台真手机上，用远程桌面/远程控制访问，性能和真实性都最好', next: 'n3' },
              { t: '先看风控具体读哪些信息再定：如果它主要读虚拟硬件的指纹，就用容器；如果它主要核对「设备是否独立」，就用虚拟机', next: 'n4' }
            ]
          },
          n1: {
            label: '选容器路线', terminal: true, verdict: 'good',
            verdictTitle: '正确：性能这一条，只有容器路线能干净地满足',
            result: '<b>为什么对：</b>官方明确说容器里的 Android <b>直接访问所需硬件</b>，没有虚拟化层、性能接近原生。要求①（首屏、视频流畅）在虚拟机路线上要额外付出图形加速的成本——virtio-gpu / VirGL 每条路线都有自己的坑，GPU 直通又要求一台机器一张卡。<br><b>要求②也支持这个选择：</b>风控读硬件信息时，容器给的是<b>宿主的真实硬件</b>，这恰恰是最难伪造也最不需要伪造的部分——它本来就是真的。<br><b>但要记住代价：</b>容器路线的隔离强度弱、宿主暴露面多，你得用别的手段（namespace 配置、挂载清理、命名空间内的 /proc 处理）去控制「App 能看见宿主多少东西」。',
            after: '<p><b>认知要点：</b>性能与硬件真实性这两件事在容器路线上是<b>一起解决</b>的，这是它最大的结构性优势。</p>'
          },
          n2: {
            label: '选虚拟机路线', terminal: true, verdict: 'bad',
            verdictTitle: '方向偏了：你用「更好控制的检测面」换掉了硬性要求',
            result: '<b>认知根源：</b>把「可控性」误当成第一优先级。<b>业务方的两条要求里没有一条是「更好控制」</b>——而要求①是硬指标。<br>虚拟机路线上，guest 只能看到 virtio 之类的虚拟硬件，你还得单独解决图形加速问题（这本身就是云手机公认的第一难点）。更要命的是：<b>虚拟硬件的指纹恰恰是风控最容易识别的部分</b>——你以为「全部由我提供」很好控制，实际上「全部由我编造」意味着每一处都要编得对，成本高得多。<br><b>正确做法：</b>先满足硬性要求（容器路线），再用配置与伪装手段去补齐隔离与自洽性。<b>不要用「架构上更优雅」去替换「业务上必须满足」。</b>'
          },
          n3: {
            label: '用真机 + 远程访问', terminal: true, verdict: 'bad',
            verdictTitle: '看似最真，实则把「可定制」和「可欺骗」这两件事一起放弃了',
            result: '<b>认知根源：</b>把「真实性」等同于「环境影响最小」。真机的真实性确实最好，但本章的目标是<b>高度定制 + 可欺骗风控</b>——真机上你要改任何东西都得先解锁、刷机，而且一旦刷了就不再「最真」了。<br>更现实的问题是规模与成本：真机方案难以弹性扩缩，一台机器一个环境，出了故障要人工介入。<br><b>什么时候真机才是对的？</b>当你需要的是<b>少量、高保真、长期稳定</b>的验证环境，而不是大规模的云端实例时——<b>技术选型永远要回到规模和目标上，而不是「哪个更真」。</b>'
          },
          n4: {
            label: '先看风控读什么再定', terminal: true, verdict: 'bad',
            verdictTitle: '思路方向对，但它不能替代这个决策',
            result: '<b>为什么这个选项有吸引力：</b>「先侦察再决策」是很好的工程习惯，但它在这里解决不了问题——因为<b>要求①（性能）与风控读什么完全无关</b>。<br><b>认知根源：</b>把「对抗目标的差异」当成了选型的唯一变量，忽略了同时存在的<b>非对抗性硬约束</b>（性能、成本、弹性、交付时间）。<br><b>正确做法：</b>先用硬约束筛掉不可能的选项（这一步就能定下容器路线），再针对风控做定制。<b>决策的顺序是「先可行域、后最优化」，反了就会一直纠结在错误的问题上。</b>'
          }
        }
      }
    },

    {
      h: '32.12',
      title: '综合情境演练（二）：内核与检测面的取舍',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境二 · 卡在启动',
            scenario: '<b>情境：</b>你按容器路线部署，Android 镜像、rootfs、namespace 配置都做好了，但容器里的 Android <b>启动到一半就卡死</b>：日志显示某个系统服务起不来。你已经确认宿主内核版本不算老。你第一步应该查什么？',
            choices: [
              { t: '去查 Android 的 init.rc，看是不是某个 service 的定义有问题', next: 'n1' },
              { t: '先确认宿主内核有没有 binder 支持、设备节点有没有正确暴露给容器——因为 servicemanager 依赖它，这一环不通后面全都不通', next: 'n2' },
              { t: '先把宿主内核升级到最新版本，新内核一般兼容性更好', next: 'n3' },
              { t: '直接给 Android 镜像打补丁，把这个起不来的服务从 init.rc 里注释掉，先让它跑起来', next: 'n4' }
            ]
          },
          n1: {
            label: '查 init.rc', terminal: true, verdict: 'bad',
            verdictTitle: '查错了层：rc 文件通常不是根因，只是「症状的传出地」',
            result: '<b>认知根源：</b>「日志出现在哪就查哪」——这是排查启动问题最常见的陷阱。<b>rc 只是声明「要启动什么」，服务起不来往往是因为它依赖的东西不存在。</b><br>而且这是<b>容器化环境</b>：同一个 Android 镜像在真机上能跑，说明 rc 本身没问题，变量在<b>下面那一层</b>——宿主内核提供了什么。<br><b>正确顺序：</b>先确认容器化 Android 的<b>核心技术前提</b>（binder 与共享内存机制），再看 IPC 中枢（servicemanager），最后才轮到上层服务的 rc。'
          },
          n2: {
            label: '先查宿主内核的 binder 支持', terminal: true, verdict: 'good',
            verdictTitle: '正确：先验证「容器化 Android 的核心技术前提」',
            result: '<b>为什么这是第一顺位：</b>Android 的一切系统服务都通过 <b>binder</b> 注册与调用。宿主内核没有 binder（或设备节点没有接进容器），<span class="mono">servicemanager</span> 就起不来——而它是「电话簿」，它不在，后面所有服务都找不到彼此，症状就是<b>五花八门的服务启动失败</b>。<br><b>怎么查：</b>看内核编译配置里 binder/ashmem（或 memfd）相关的选项，再确认设备节点在容器里真的可见可用（回看 32.3 的体检命令）。<br><b>顺带记住：</b>内核模块与内核版本强绑定，<b>「昨天好好的今天起不来」几乎一定是内核升级后模块没重建</b>。',
            after: '<p><b>认知要点：</b>排查启动问题要从<b>依赖链的最底层</b>往上查。<b>哪一层缺了，上面所有层都会以各种奇怪的方式失败</b>，而失败信息通常出现在最上面那层。</p>'
          },
          n3: {
            label: '升级宿主内核', terminal: true, verdict: 'bad',
            verdictTitle: '把「配置缺失」误判成「版本落后」',
            result: '<b>认知根源：</b>把内核当成一个「越新越全」的整体。<b>内核是「源码 × 配置」的产物</b>：发行版给你的通用内核，很可能就是「什么都有点、但恰好没编 binder」。<br>盲目升级还有实实在在的风险：升级后<b>依赖这个内核的模块全部要重建</b>，容器里的东西也可能一起坏掉——你会在一堆新问题里找不到原来那个问题。<br><b>正确做法：</b>先确定是<b>配置问题</b>还是<b>版本问题</b>。方法就是直接查编译选项与设备节点，而不是靠猜。<b>「升级」应该是一个有依据的动作，不是一种祈祷。</b>'
          },
          n4: {
            label: '注释掉起不来的服务', terminal: true, verdict: 'bad',
            verdictTitle: '最危险的一条：你把「症状」删掉了，把「病因」留下了',
            result: '<b>为什么危险：</b>注释掉一个系统服务，会引发一连串你完全预料不到的连锁失败（权限、资源、依赖它的其他服务）。更糟的是<b>你会失去那条唯一能指向根因的错误信息</b>，之后就只能靠猜。<br><b>认知根源：</b>把「让它跑起来」当成了目标，而真正的目标是「让它<b>正确地</b>跑起来」。在环境伪装这个领域，这个区别是致命的：<b>一个被阉割过的系统，会在别的检测面上以更隐蔽的方式暴露自己</b>（少了服务、少了进程、少了该有的行为）。<br><b>正确做法：</b>卡住的时候，宁可停下来定位根因，也不要靠删功能过关——<b>欠下的技术债，风控会替你收。</b>'
          }
        }
      }
    },

    {
      h: '32.13',
      title: '综合情境演练（三）：伪装的自洽性',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境三 · 全部改完之后仍被拦',
            scenario: '<b>情境：</b>你的容器化安卓实例已经做了这些事：Magisk 装上并配置了 DenyList 隐藏 root；在 Java 层用 Zygisk 模块 hook 了 <span class="mono">WifiManager</span>，让它返回一个合理的 SSID/BSSID；图形栈也换成了带 GPU 加速的方案。功能全部正常。但目标 App 依然<b>在启动后不久就把你拦下</b>了。最应该先做什么？',
            choices: [
              { t: '加大隐藏力度：把 DenyList 的覆盖范围扩大，再多加几个隐藏 root 的模块', next: 'n1' },
              { t: '做交叉验证排查：把 App 可能读到的各条信息列出来（WiFi 各数据源、/proc 内核视图、图形指纹、内核与设备信息），逐条比对它们是否互相矛盾，先定位矛盾点', next: 'n2' },
              { t: '直接逆向上这个 App 的风控逻辑，把检测函数全 hook 掉', next: 'n3' },
              { t: '换一条路线：容器路线天生容易被识破，改用 QEMU 虚拟机，从零开始重做一套', next: 'n4' }
            ]
          },
          n1: {
            label: '加大隐藏力度', terminal: true, verdict: 'bad',
            verdictTitle: '在没定位矛盾点之前，加码隐藏基本是无效努力',
            result: '<b>认知根源：</b>默认「被拦 = 隐藏得不够」。但你要想清楚：<b>你已经做了不少伪装，如果还失败，更可能的原因不是「藏得不够深」，而是「藏得不一致」。</b><br>本章反复讲过：风控不需要找到「你在用云手机」的铁证，它只要发现<b>你的证据链内部有矛盾</b>。继续堆隐藏模块，往往是给一个已经有裂缝的体系再加一层漆——<b>反而增加新的暴露面</b>（多一个模块，多一处可被读到的痕迹）。<br><b>正确做法：</b>先把「有没有矛盾」这个疑问解决掉，再决定要不要加码。'
          },
          n2: {
            label: '做交叉验证排查', terminal: true, verdict: 'good',
            verdictTitle: '正确：先定位「哪两条证据对不上账」',
            result: '<b>为什么这是第一顺位：</b>你前面做的每一件事都可能是<b>局部正确、整体矛盾</b>的。典型的矛盾组合：<br>· Java 层说连着 WiFi，但<span class="mono">/proc/net/wireless</span> 是空的（内核视角没有这张网卡）；<br>· RSSI 恒定不变，而扫描列表每次完全一样（缺时间维度）；<br>· 图形栈的渲染器字符串与 GPU 型号对不上（伪装不彻底）；<br>· 内核启动时间与系统运行时间互相矛盾（容器共享宿主内核的典型痕迹）。<br><b>做法：</b>按 32.9 的表格逐行对账，先从最便宜、最能一票否决的地方查起，找到矛盾点，再去对应的层修。<br><b>这一步的本质是：把「猜」换成「对账」。</b>',
            after: '<p><b>认知要点：</b>在环境伪装这类工作里，<b>排查的粒度是「证据面」而不是「功能」</b>——功能正常不代表证据自洽。</p>'
          },
          n3: {
            label: '直接逆向风控逻辑', terminal: true, verdict: 'bad',
            verdictTitle: '代价最高的路径，而且很可能盖不住',
            result: '<b>为什么不是第一选择：</b>逆向风控当然有用，但它是<b>成本最高、最不可持续</b>的手段——对方更新一次你就重来一次。而且风控越来越依赖原生层、甚至依赖你够不着的组件（回看 32.10 里的 pKVM/AVF 方向），此时在主系统里 hook 根本无效。<br><b>更根本的问题：</b>它没有解决「环境本身是否自洽」。哪怕你这次把检测函数全 hook 掉了，<b>环境里的矛盾依然存在</b>，下次换个入口又会撞上。<br><b>正确顺序：</b>先让环境经得起查（自洽），再用逆向手段处理个别强检测点。<b>把逆向当第一手段，等于把地基问题当成装修问题。</b>'
          },
          n4: {
            label: '换路线重做', terminal: true, verdict: 'bad',
            verdictTitle: '在有定位手段之前换路线，是拿成本换不确定性',
            result: '<b>认知根源：</b>把架构当成了问题的原因。你已经花了大力气做出一个功能正常的实例，<b>但你还不知道它为什么被拦</b>——此时换路线，等于把「不明确的问题」带到「新的、你还更不熟悉的实现」里去，很可能在新路线上遇到同类问题还找不到原因。<br>而且两条路线各有各的破绽：容器路线的真硬件是优势，虚拟化路线的完整设备幻觉也是优势——<b>没有哪条路线是「天生不被识破」的</b>。<br><b>正确做法：</b>先定位矛盾点（选项 B）。如果定位结果是「这个矛盾在架构上无法解决」（比如某个必须在硬件层存在的证据），<b>那时候换路线才是一个有依据的决定。</b>'
          }
        }
      }
    },

    /* ================= 32.14 ================= */
    {
      h: '32.14',
      title: '自测：四个必须过关的判断',
      quiz: {
        id: 'q18-1', chapter: 18, answer: 1,
        stem: 'Waydroid 与 QEMU 这类模拟器/虚拟机方案相比，<b>最本质</b>的区别是什么？',
        options: [
          { t: 'Waydroid 性能更好，因为它做了更多的优化', why: '性能更好是<b>结果</b>，不是本质区别。说「优化得好」没有解释为什么它会快。' },
          { t: 'Waydroid 用容器方式共享宿主内核运行完整 Android，容器内的 Android 可直接访问所需硬件，中间没有虚拟化层', why: '正确。官方 README 的两句话正好覆盖了这两点：container-based approach 启动 full Android system；容器内的 Android has direct access to any needed hardware。' },
          { t: 'Waydroid 只能在 Linux 手机上运行，桌面 Linux 用不了', why: '与事实不符：桌面 Linux 也是它的常见使用场景。' },
          { t: 'Waydroid 不需要内核支持，因为它不碰内核', why: '恰好相反：它<b>极度</b>依赖内核支持——binder 与 ashmem/memfd 是它能跑起来的技术前提。' }
        ],
        explain: '<b>解析：</b>本质区别在<b>是否共享内核、是否经过虚拟化层</b>。容器路线里 Android 只是「另一个用户空间」，系统调用直接落在宿主内核上，硬件也是真的；虚拟机路线要经过 KVM → 虚拟硬件 → Guest 内核三道门。<br><b>由此推出的所有差异：</b>性能（容器占优）、隔离强度（虚拟机占优）、硬件访问（容器是真的）、检测面（容器给的是真硬件，但共享内核本身也是可检测特征）。<br><b>注意：</b>这也意味着 <span class="mono">binder</span> 是这条路线的硬前提——宿主内核没有它，容器里的 Android 起不来。'
      }
    },

    {
      h: '32.15',
      title: '自测二：Magisk 到底改了哪里',
      html: '<p>这道题考的是「systemless」这个词的字面含义——<b>改动到底落在磁盘上，还是落在挂载层上</b>。</p>',
      quiz: {
        id: 'q18-2', chapter: 18, answer: 2,
        stem: 'Magisk 的「systemless（无系统分区修改）」是靠什么实现的？',
        options: [
          { t: '把 /system 分区重新挂载为可写，然后直接改里面的文件，改完再改回只读', why: '这正是 systemless 要避免的做法——它会破坏分区完整性，导致无法 OTA、也无法干净卸载。' },
          { t: '把整个 /system 分区解包、修改后重新打包成镜像刷回去', why: '那叫改系统镜像，不是 systemless。而且同样会破坏校验。' },
          { t: '修改 boot 镜像的 ramdisk 注入 magiskinit，在 init 早期拿到控制权，再用 overlayfs/magic mount 把模块文件叠加到系统路径上', why: '正确。改动落在 <b>boot 分区</b>，真实 /system 分区一个字节都没改——修改活在挂载层。' },
          { t: '在 App 进程里用 Xposed 那样的 hook 把读文件的调用重定向到模块目录', why: '那是运行时的 hook 思路，不是 Magisk systemless 的机制；而且它覆盖面远不如挂载层。' }
        ],
        explain: '<b>解析：</b>记住两句话：<b>① 抢早</b>——在系统挂载分区之前拿到控制权（所以要在 ramdisk 里注入 magiskinit）；<b>② 改挂载不改磁盘</b>——用 overlayfs/magic mount 做叠加，系统看到的是被覆盖后的文件，而真实分区保持原样。<br><b>两个直接好处：</b>可以 OTA 升级、可以随时卸载干净。<br><b>对逆向的意义：</b>这意味着你可以在系统路径上「注入」几乎任何东西，而系统会当成原生内容接受——配合 <b>Zygisk</b>（在 Zygote 注入，等于每个 App 进程出生即带代码）和 <b>DenyList</b>（隐藏 root），Magisk 是让云端安卓「看起来像真机」的关键一环。'
      }
    },

    {
      h: '32.16',
      title: '自测三：虚拟 WiFi 为什么藏不住',
      html: '<p>这道题考的是本章的核心原则——<b>伪装必须自洽</b>。请特别注意「多选」两个字。</p>',
      quiz: {
        id: 'q18-3', chapter: 18, answer: [1, 2],
        stem: '<b>多选。</b>容器化环境下做虚拟 WiFi，为什么「只在 Java 层 hook 掉 <span class="mono">WifiManager</span> 的返回值」会被识破？',
        options: [
          { t: '因为 hook 技术本身一定会被反调试检测到', why: '这不是本题的原因。hook 是否被发现是另一个问题，而这里的破绽来自<b>信息之间的不一致</b>，与 hook 是否暴露无关。' },
          { t: '因为 App 会从多个互相独立的数据源交叉验证同一件事，比如内核视角的 /proc/net/wireless 与上层的 WifiManager 会互相矛盾', why: '正确。上层说有 WiFi，内核视图说没有这张网卡——这是最硬的一类矛盾。' },
          { t: '因为真实世界的 WiFi 状态有历史与波动（信号抖动、扫描结果变化、连接记录），而伪造的返回值往往是静态的', why: '正确。时间维度极容易被忽略：一个「刚刚才有、永远不变」的 WiFi 比没有 WiFi 更可疑。' },
          { t: '因为 WifiManager 的返回值是加密的，hook 之后校验会失败', why: '不存在这种机制，属于编造。' }
        ],
        explain: '<b>解析：</b>本节的核心原则是<b>「伪装必须自洽」</b>。风控通常不需要证明你是假的，它只要发现<b>你提供的证据链内部互相矛盾</b>就够了。<br><b>要覆盖的至少四层：</b>① 系统服务层（WifiManager 及其背后的服务）；② 内核可读的视图（<span class="mono">/proc</span>、<span class="mono">/sys</span>）；③ 网络参数之间的配套关系（BSSID ↔ 网关 ↔ 网段 ↔ DNS）；④ <b>时间维度</b>（历史、抖动、切换）。<br><b>推广：</b>这条原则适用于本章所有的伪装工作——隐藏 root、图形指纹、设备信息，全都是「让一整套状态自洽」而不是「让一个 API 返回真」。'
      }
    },

    {
      h: '32.17',
      title: '自测四：KVM 的内存是谁的内存',
      html: '<p>最后一道自测，回到最底层：<b>KVM 只是接口，它不替你做任何事</b>。想清楚这一点，你对所有虚拟化软件的理解都会不一样。</p>',
      quiz: {
        id: 'q18-4', chapter: 18, answer: 3,
        stem: '关于 KVM 的 <span class="mono">KVM_SET_USER_MEMORY_REGION</span>，下列说法<b>正确</b>的是？',
        options: [
          { t: '它是让 KVM 内核模块为虚拟机分配一块物理内存', why: '反了。KVM <b>不</b>替 guest 分配物理内存——它让你把<b>自己进程里的一块内存</b>登记成 guest 的物理地址空间。' },
          { t: '它必须在 KVM_CREATE_VCPU 之后调用，因为内存是挂在 vCPU 上的', why: '顺序反了，而且归属也错了：设备内存映射作用在 <b>vm_fd</b> 上，通常在 KVM_CREATE_VM 之后、创建 vCPU 之前完成。' },
          { t: '它只能用于把内存映射到 guest 的物理地址 0，其他地址必须用别的接口', why: '该结构体里有 guest_phys_addr 字段，可以把用户态内存映射到任意的 guest 物理地址区间。' },
          { t: '它把宿主用户态的一块内存登记为 guest 的物理地址空间，因此宿主进程可以直接读写 guest 内存', why: '正确。这正是调试器、内存取证与脱壳工具能够工作在虚拟机上的根本原因。' }
        ],
        explain: '<b>解析：</b>KVM 的 API 设计非常克制：内核只提供 <b>CPU 虚拟化 + 内存虚拟化</b>这两件事的接口，其余一切（设备模型、镜像格式、显示、网络）都由用户态程序自己实现。QEMU、Cuttlefish、crosvm 都是这套接口的不同封装。<br><b>顺序要记牢：</b>open(<span class="mono">/dev/kvm</span>) → KVM_GET_API_VERSION → KVM_CREATE_VM（得到 vm_fd）→ KVM_SET_USER_MEMORY_REGION（作用在 vm_fd 上）→ KVM_CREATE_VCPU（得到 vcpu_fd）→ mmap kvm_run → 循环 KVM_RUN。<br><b>最值得记住的一点：</b>guest 的物理内存就是你进程里的一块缓冲区——<b>你随时可以直接读写它</b>。'
      }
    }
     ],
     glossary: [
       { t: 'Waydroid', d: '用基于容器的方式在普通 GNU/Linux 上启动完整 Android 系统的开源项目（仓库 waydroid/waydroid）。使用 Linux namespaces 隔离，容器内的 Android 可直接访问所需硬件。' },
       { t: 'Linux namespaces', d: '内核隔离机制，包括 user / pid / uts / net / mount / ipc。容器化 Android 的基础：让一组进程看到「自己独占一套系统」。' },
       { t: 'binder', d: 'Android 的核心 IPC 机制，以内核驱动形式提供。宿主内核不支持 binder，容器里的 Android 根本起不来。相关模块名常见为 binder_linux / ashmem_linux。' },
       { t: 'ashmem / memfd', d: 'Android 的匿名共享内存机制。早期用 ashmem，新内核上越来越多改用通用的 memfd。' },
       { t: 'virtio-gpu', d: '半虚拟化的 GPU 接口：Guest 通过 virtio 队列把渲染命令提交给 Host 的 GPU 执行。' },
       { t: 'VirGL', d: '在 Guest 内把 OpenGL 调用转发给宿主 GPU 渲染的方案，属于半虚拟化图形加速的一种。' },
       { t: 'GPU passthrough / VFIO', d: '把物理 GPU 直接分配给虚拟机，Guest 使用真实厂商驱动，性能接近裸机，但成本与运维复杂度高。' },
       { t: '绑定挂载（bind mount）', d: 'mount --bind olddir newdir：把一个已存在的目录挂到另一个位置，两个入口共享同一份内容。容器映射宿主目录、Magisk magic mount 的基础手法。' },
       { t: 'Magisk', d: 'Android 的 Root 方案与模块化框架（仓库 topjohnwu/Magisk）。核心是修改 boot 镜像的 ramdisk，在 init 早期注入自己的逻辑，再用 overlayfs/magic mount 实现 systemless 修改。' },
       { t: 'Zygisk', d: 'Magisk 提供的在 Zygote 进程注入代码的机制。Zygote 是所有 App 进程的父进程，因此在这里注入等于每个 App 进程出生即带代码。' },
       { t: 'DenyList', d: 'Magisk 中用于隐藏 root 状态的功能（旧称 MagiskHide），对抗环境检测。' },
       { t: 'KVM', d: 'Kernel-based Virtual Machine：Linux 内核的硬件虚拟化接口，通过 /dev/kvm 以 ioctl 暴露 API（KVM_CREATE_VM / KVM_CREATE_VCPU / KVM_SET_USER_MEMORY_REGION / KVM_RUN）。要求 CPU 支持硬件虚拟化且 BIOS 开启。' }
     ],
     teacher: { id: 'ch18', chapter: 18, name: '追问老师 · 第 32 章', sub: '把虚拟化、容器化与 Android 系统焊成一套能骗过风控的云端环境', intro: '<p style="margin:0">这是全课程最后一章，我会问得最狠：不只问你「怎么做」，还问你「为什么这样做是对的」。</p>', questions: [
      {
        id: 'c18q1', depth: 1, threshold: 0.7,
        q: 'Waydroid 用容器方式在 Linux 上跑完整 Android。<b>它为什么能做到「性能接近原生」？这条路线的技术前提又是什么？</b>请把「为什么快」和「靠什么才能跑起来」分开说。',
        concepts: [
          { label: '共享宿主内核、没有虚拟化层，Android 只是另一个用户空间',
            hint: '它和模拟器/虚拟机差在哪一层？有没有第二份内核？',
            any: ['共享内核', '同一个内核', '同一份内核', '共用内核', '没有虚拟化层', '无虚拟化', '不经虚拟化', '不是虚拟机', 'container', '容器', 'namespaces', '命名空间', '用户空间', 'user space', 'shared kernel', '宿主内核', '直接跑在'] },
          { label: '容器内的 Android 可直接访问所需硬件（真实硬件，非虚拟硬件）',
            hint: '官方 README 里特别强调的那一句是什么？',
            any: ['直接访问硬件', '访问硬件', '真实硬件', '真硬件', 'direct access', 'hardware', '显卡', 'gpu', '驱动', '原生驱动', '设备', '传感器', '摄像头', '网卡'] },
          { label: '前提：宿主内核必须支持 binder 与 ashmem/memfd',
            hint: 'Android 的进程间通信靠什么机制？它是内核的必备组件吗？',
            any: ['binder', 'ashmem', 'memfd', 'binderfs', 'binder_linux', 'ashmem_linux', '内核模块', 'kernel module', '内核支持', '内核编译', '编译选项', '配置项', 'config', '设备节点', 'dev/binder', '内核前提'] }
        ],
        hints: ['先问自己：容器里的 Android 发出的系统调用，最后落在哪个内核上？', '再问：Android 里所有系统服务互相之间是怎么「找到对方」的？这个机制需要内核提供什么？'],
        probes: ['如果宿主内核不带 binder，容器里的 Android 会死在启动链路的哪一步？', '「没有虚拟化层」带来的代价是什么？它在隔离强度上意味着什么？'],
        model: '<b>为什么快：因为它根本没有虚拟化层。</b>官方 README 说 Waydroid 用 container-based approach 在普通 GNU/Linux 上启动一个<b>完整的</b> Android 系统，隔离手段是 Linux namespaces（user、pid、uts、net、mount、ipc）。也就是说：Android 只是宿主系统上的「另一个用户空间」，它发出的系统调用<b>直接落在宿主内核</b>上，中间没有指令翻译、没有第二份内核、没有虚拟设备模型。而官方同时说明：容器内的 Android 系统<b>可以直接访问所需的硬件</b>——摄像头、传感器、GPU 走的都是宿主内核里真实的驱动。<b>没有那一层「虚拟硬件 → Guest 驱动」的翻译，性能自然接近原生。</b><br><br><b>靠什么才能跑起来：内核前提。</b>Android 的进程间通信靠 <b>binder</b>，而 binder 不是标准 Linux 内核的必备组件，需要宿主内核提供支持（课程中提到的模块名是 <span class="mono">binder_linux</span> / <span class="mono">ashmem_linux</span>）；共享内存侧还要 ashmem 或新内核上的 memfd。<b>这是安卓容器化的核心技术前提</b>：宿主内核没有 binder，<span class="mono">servicemanager</span> 就起不来，而它是 binder 的「电话簿」——它不在，后面所有系统服务都找不到彼此，症状是各式各样的启动失败。<br><br><b>结论：</b>「快」来自共享内核与真实硬件；「能跑」取决于内核配置。这也解释了为什么这条路上真正的硬骨头常常是「编译一个带 binder 支持的宿主内核」，而不是 Waydroid 本体本身。',
        after: '<p>顺手记住一个工程细节：内核模块与内核版本、配置<b>强绑定</b>。「昨天好好的今天起不来」几乎一定发生在内核升级之后、模块没重建。</p>'
      },
      {
        id: 'c18q2', depth: 2, threshold: 0.7,
        q: '容器启动时用<b>绑定挂载</b>把宿主目录映射进来。<b>为什么每个 PID 命名空间必须重新挂一次自己的 <span class="mono">/proc</span>？不挂会怎样？</b>顺带说清绑定挂载本身在容器里承担什么角色。',
        concepts: [
          { label: '/proc 是内核按当前 PID 命名空间实时生成的视图，PID 编号是命名空间内相对的',
            hint: '同一个进程，在宿主和容器里看到的 PID 一样吗？/proc 是静态文件吗？',
            any: ['pid 命名空间', 'pid namespace', '命名空间相对', '相对编号', 'pid 相对', '实时生成', '动态生成', '内核生成', '内核视图', '视图', '视图按命名空间', 'pid 1', '命名空间内', '同一个进程不同 pid', '由内核提供'] },
          { label: '必须在容器内重新 mount -t proc proc /proc，否则会看到宿主的进程表',
            hint: '不重新挂载的话，ps 输出的是谁的进程？',
            any: ['重新挂载', '重新 mount', 'mount -t proc', '挂 proc', '重挂', 'mount proc', 'proc 挂载', '看到宿主进程', '宿主进程表', 'ps 看到宿主', '没隔离', '泄漏', '暴露宿主', '必须重挂'] },
          { label: '绑定挂载把一个已存在目录挂到另一个位置，两个入口共享同一份内容，是容器映射宿主目录的基础',
            hint: 'mount --bind olddir newdir 到底做了什么？',
            any: ['bind mount', '绑定挂载', 'mount --bind', '--bind', '同一份内容', '同一份数据', '两个入口', '映射目录', '挂载点', '把目录挂到', '映射进容器', 'rootfs'] },
          { label: '这也是 Magisk magic mount / overlayfs 叠加的基础手法',
            hint: '本章还有哪个技术是在「挂载层」做文章的？',
            any: ['magisk', 'magic mount', 'overlayfs', 'overlay', '叠加', '挂载层', '联合挂载', 'systemless'] }
        ],
        hints: ['想清楚 PID 这个数字是「全局唯一」还是「相对于某个命名空间」。', '/proc 不是磁盘上的一堆文件，那它是什么？谁在什么时候生成它？'],
        probes: ['如果容器里忘了重挂 /proc，除了 ps 会看到多余进程，还可能带来什么安全/检测上的后果？', '/dev、/sys 为什么也要按命名空间重新挂？它们和 /proc 的共同点是什么？'],
        model: '<b>根本原因：/proc 里的 PID 编号是「命名空间内相对的」。</b>同一个进程，在宿主命名空间里可能是 PID 3000，在容器的 PID 命名空间里却是 PID 1。<span class="mono">/proc</span> 不是磁盘上的静态数据，而是<b>内核根据「谁在读、它在哪个 PID 命名空间里」实时生成的视图</b>。所以容器必须在自己的挂载命名空间里重新执行一次 <span class="mono">mount -t proc proc /proc</span>——挂载动作本身携带了「是谁在挂」的上下文，内核据此生成对应内容。<br><br><b>不挂会怎样：</b>容器里的进程会看到<b>宿主的 /proc</b>——<span class="mono">ps</span> 里冒出一堆本不该看见的进程，PID 1 也不是容器自己的 init。这既是功能问题（依赖 /proc 的程序行为异常），更是<b>暴露问题</b>：风控非常喜欢读 <span class="mono">/proc</span> 与 <span class="mono">/sys</span>（进程列表、CPU 信息、设备树、网络统计），挂载没做干净，这里就是最大的破绽来源。<br><br><b>绑定挂载的角色：</b><span class="mono">mount --bind olddir newdir</span> 把一个已存在的目录挂到另一个位置，两个入口共享<b>同一份内容</b>。容器用它把宿主准备好的 rootfs接」到容器的根上——宿主什么都没变，容器里却像是另一台机器。同一手法也是 Magisk magic mount / overlayfs 叠加的基础：<b>不改磁盘，只改挂载层</b>。<br><br><b>补一句：</b>内核启动的最后一步是执行 <span class="mono">/sbin/init</span>（可用 <span class="mono">init=</span> 指定），它成为 PID 1，负责挂载文件系统、启动服务、回收孤儿进程。在容器里，这个角色由容器运行时或一个精简 init 承担——这也正是「容器里谁才是 PID 1」这个问题的答案。'
      },
      {
        id: 'c18q3', depth: 2, threshold: 0.6,
        q: 'Magisk 号称「systemless」——<b>它到底改了哪里？又是怎么让系统「看见」模块文件的？</b>为什么这种做法能带来 OTA 升级与干净卸载？再说说 Zygisk 和 DenyList 各解决什么问题。',
        concepts: [
          { label: '改 boot 镜像的 ramdisk，注入 magiskinit（替换 init 或改 .rc），在 init 启动早期拿到控制权',
            hint: '它改的是 /system 吗？如果不是，那是哪个分区？什么时机动手？',
            any: ['ramdisk', 'boot 镜像', 'boot.img', 'boot 分区', 'magiskinit', '替换 init', '改 init', '替换掉 init', '打补丁', '.rc', 'rc 文件', '早期', '启动早期', 'init 之前', '注入', '抢先'] },
          { label: '用 overlayfs / magic mount 把模块文件叠加到系统路径上，系统看到的是被覆盖的文件',
            hint: '它是怎么让 /system 里「出现」一个原本不存在的文件的？',
            any: ['overlayfs', 'overlay', 'magic mount', 'magisk mount', '叠加', '覆盖', '挂载层', 'mount 层', '联合挂载', '联合文件系统', '覆盖文件', '被覆盖'] },
          { label: '真实 /system 分区一个字节都没改，所以能 OTA、能随时卸载干净',
            hint: '好处有哪两个？为什么改磁盘就做不到？',
            any: ['未修改', '没改', '不修改 system', '不改 system', 'systemless', '无系统分区修改', 'ota', '升级', '卸载', '卸载干净', '干净', '还原', '可逆', '只读挂载', '校验', '完整性'] },
          { label: 'Zygisk 在 Zygote（所有 App 进程的父进程）注入；DenyList 隐藏 root 对抗检测',
            hint: '模块 hook 插在哪里最有效？对抗检测靠哪个组件？',
            any: ['zygisk', 'zygote', '注入 zygote', 'denylist', 'magiskhide', 'magisk hide', '隐藏 root', 'hide', '白名单', '黑名单', '权限管理', 'magisksu', 'root 权限'] }
        ],
        hints: ['「systemless」这个词的字面意思就是「没有系统（分区修改）」——那改动只能落在别的地方。', '注意时机：它必须比系统挂载分区更早动手，否则就没有资格决定「系统最终看到什么」。'],
        probes: ['为什么「抢早」这件事是必须的？如果系统已经挂载完并跑起了服务，再动手会有什么后果？', '在容器化 Android 里，你本来就控制整个用户空间镜像——那 Magisk 还有哪些不可替代的价值？'],
        model: '<b>它改了哪里：boot 镜像的 ramdisk，不是系统分区。</b>核心原理是在 ramdisk 里注入 Magisk 自己的 init 逻辑（常见做法是替换系统的 <span class="mono">init</span>，或者修改 <span class="mono">.rc</span> 文件，由 <span class="mono">magiskinit</span> 打补丁），从而在<b>系统把各分区挂载起来之前</b>就拿到控制权。为什么必须「早」？因为一旦 /system 已经按原样挂上、服务已经跑起来，你再去改就晚了、也脏了——<b>只有抢在挂载之前，才有资格决定「系统最终看到什么」</b>。<br><br><b>它怎么让系统「看见」模块文件：</b>以只读方式挂载真实的 /system，然后用 <b>overlayfs / magic mount</b> 把模块里的文件「叠加」到对应的系统路径上。系统看到的是<b>被覆盖后</b>的文件，它无法从文件内容本身判断下面还有一层。这个手法与绑定挂载一脉相承：<b>不改磁盘，只改挂载层</b>。<br><br><b>两个好处：</b>① 可以 OTA 升级——系统分区是原厂的，校验能过；② 可以随时卸载干净——把挂载层撤掉，系统回到出厂状态。相比之下，直接改系统分区会破坏校验、无法 OTA，而且改动是「永久性的脏」。<b>这就是 systemless 的全部价值：把「修改」从磁盘搬到挂载层。</b><br><br><b>另外两个组件：</b><b>MagiskSU</b> 提供 root 权限管理（决定哪个 App 能以什么身份拿 root）；<b>Zygisk</b> 在 <b>Zygote</b> 进程注入代码，而 Zygote 是<b>所有 Android 应用进程的父进程</b>，因此在它这里注入等于每个 App 进程<b>一出生就带着你的代码</b>——这是模块 Hook 最有效的位置；<b>DenyList</b>（旧称 MagiskHide）用于隐藏 root 状态、对抗环境检测。<b>对逆向的意义：</b>Magisk 是让云手机/容器化安卓「看起来像真机」的关键一环。'
      },
      {
        id: 'c18q4', depth: 2, threshold: 0.65,
        q: '容器化环境下没有真实 WiFi 硬件。你要伪造出「这台机器连着 WiFi」。<b>为什么只在 Java 层 hook 掉 <span class="mono">WifiManager</span> 的返回值一定会被识破？</b>要让这套伪装自洽，至少要覆盖哪些方面？',
        concepts: [
          { label: 'App 会从多个互相独立的数据源交叉验证同一件事（WifiManager vs /proc 等内核视图）',
            hint: 'App 会只问一个地方吗？除了 Java API，它还能从哪里看到网络状态？',
            any: ['交叉验证', '交叉', '对账', '多个来源', '多数据源', '多个数据源', 'proc/net/wireless', 'proc', '内核视图', '内核视角', 'sys', '不一致', '矛盾', '互相验证', '多个 api', '不同来源'] },
          { label: '时间维度：信号强度会抖动、扫描结果会变化、有连接历史，静态值本身就可疑',
            hint: '真机上的 RSSI 是恒定的吗？一个「永远不变」的状态正常吗？',
            any: ['时间', '历史', '抖动', '波动', '变化', '动态', 'rssi 变化', '信号变化', '扫描结果变化', '静态', '恒定', '永远不变', '一成不变', '轨迹', '记录'] },
          { label: '网络参数之间要配套：BSSID ↔ 网关 ↔ 网段 ↔ DNS 必须说得通',
            hint: '如果 BSSID 指向家用路由器，而 IP 在数据中心网段，会怎样？',
            any: ['bssid', '网关', '网段', 'dns', 'ip', '配套', '说得通', '匹配', '家用路由器', '场景', '一致', '自相矛盾'] },
          { label: '核心原则：伪装必须自洽——伪造一整套状态，而不是伪造一个返回值',
            hint: '本节的核心原则是哪四个字？',
            any: ['自洽', '一致', '协调', '说得通', '整体', '状态机', '完整', '逻辑一致', '不矛盾', '可信', '合理', '证据链'] }
        ],
        hints: ['想一想本章反复出现的那句话：风控不需要证明你是假的，它只需要发现什么？', '除了「值对不对」，还要问「这个值有没有被真实使用过的痕迹」。'],
        probes: ['如果 /proc/net/wireless 是空的，而上层说连着 WiFi，你会在哪一层修这个问题？各方案的成本差别在哪？', '这条「自洽」原则怎么推广到 root 隐藏和图形指纹上？'],
        model: '<b>因为 App 不会只问一个问题。</b>它会从<b>多个互相独立的数据源</b>去问<b>同一件事</b>，然后对账。典型矛盾：Java 层的 <span class="mono">WifiManager</span> 说「连着 BSSID=aa:bb:... 的路由器」，但<b>内核视角</b>的 <span class="mono">/proc/net/wireless</span> 是空的；扫描结果是空列表，可 RSSI 却有个漂亮的 <span class="mono">-45 dBm</span>；IP 在数据中心网段，网关却号称是家用路由器。<b>风控不需要证明你是假的，它只需要发现你的证据链内部有矛盾。</b><br><br><b>至少要覆盖四层：</b>① <b>系统服务层</b>——WifiManager 及其背后的服务（system_server 里的 WifiService，回看 32.7 第⑨步）；② <b>内核可读的视图</b>——<span class="mono">/proc</span>、<span class="mono">/sys</span> 这类绕过整个 Java 层的信息源，这一项最狠，因为你 hook 了上层不代表内核里真有这张网卡；③ <b>参数之间的配套关系</b>——BSSID ↔ 网关 ↔ 网段 ↔ DNS 必须共同描绘出同一个场景；④ <b>时间维度</b>——真机的 WiFi 状态有历史：信号在抖动、偶尔切换 AP、断开又重连、扫描列表随位置变化。<b>一个「刚刚才有、而且永远不变」的 WiFi，比没有 WiFi 更可疑。</b><br><br><b>核心原则四个字：伪装必须自洽。</b>不是「让 API 返回真」，而是<b>让一整套状态机看起来被真实使用过</b>。这条原则适用于本章所有的伪装工作：root 的隐藏、图形指纹的一致、设备信息的完整，全都是同一件事——<b>排查的粒度是「证据面」，不是「功能」</b>。'
      },
      {
        id: 'c18q5', depth: 3, threshold: 0.5,
        q: '<b>综合题（全课程收束）：</b>现在要你构建一套<b>高度定制、可欺骗风控检测的云端安卓运行环境</b>。请说明这套系统需要用到<b>本课程哪些章节的知识</b>——从最底层的运行环境，一直到最上层的对抗与验证。不要求你背出章节号，<b>要讲清每一块技术在这个系统里承担什么职责、缺了它会怎样</b>。',
        concepts: [
          { label: '运行环境层：容器化（Waydroid / namespaces）或虚拟化（KVM / QEMU / Cuttlefish）路线选型',
            hint: 'Android 最终要跑在什么东西上面？有哪两条路线？',
            any: ['waydroid', '容器', '容器化', 'container', 'namespaces', '命名空间', 'lxc', 'docker', 'kvm', 'qemu', 'cuttlefish', '虚拟机', '虚拟化', 'avf', 'pkvm', 'remote_android', '云手机', '云端', '实例'] },
          { label: '内核与挂载层：宿主内核配置（binder / ashmem / memfd）、绑定挂载、命名空间下的 /proc',
            hint: '容器里的 Android 靠什么才能起来？文件系统视图是怎么拼出来的？',
            any: ['binder', 'ashmem', 'memfd', '内核', 'kernel', '编译内核', '内核配置', '绑定挂载', 'bind mount', 'mount', '/proc', 'proc', '挂载', 'rootfs', '分区'] },
          { label: 'Android 系统与启动链路：boot.img/ramdisk、init 与 init.rc、servicemanager、zygote、system_server',
            hint: 'Android 自己是怎么从「一行代码都不跑」到「App 起来」的？',
            any: ['boot.img', 'ramdisk', 'init', 'init.rc', 'zygote', 'system_server', 'servicemanager', '启动链路', '启动流程', '启动过程', '动态分区', 'super 分区', 'vbmeta', 'lineageos'] },
          { label: '图形与性能：GPU 加速（virtio-gpu / VirGL / 直通），以及渲染器指纹的一致性',
            hint: '界面怎么画出来？为什么这也和检测有关？',
            any: ['virtio', 'gpu', '图形', '渲染', '加速', 'virgl', 'swiftshader', '直通', 'passthrough', 'vfio', '显卡', 'opengl', 'egl', '渲染器'] },
          { label: 'Root 与注入：Magisk（systemless / MagiskSU / Zygisk / DenyList）及其隐藏能力',
            hint: '你要改系统、要注入代码，靠什么框架？同时又要让检测看不见它。',
            any: ['magisk', 'zygisk', 'denylist', 'magiskhide', 'systemless', 'overlayfs', 'root', '隐藏', '模块', '注入', 'xposed', 'frida', 'hook'] },
          { label: '环境伪装与反检测：设备信息、虚拟 WiFi、传感器等「自洽的假状态」',
            hint: '风控会问哪些问题？你要怎么让它问不出破绽？',
            any: ['伪装', '反检测', '风控', '检测', '指纹', '环境', '设备信息', '序列号', 'imei', 'build.prop', '系统属性', '虚拟 wifi', 'wifi', 'bssid', 'ssid', '传感器', '自洽', '交叉验证', '模拟器检测', '真机'] },
          { label: '逆向对抗技术（前面各章）：hook 框架、脱壳、混淆对抗、Native 分析、算法还原、流量与签名',
            hint: '环境搭好之后，真正要对付 App 的那些手段来自哪里？',
            any: ['frida', 'hook', 'unidbg', 'ida', '反调试', 'ollvm', 'vmp', '脱壳', 'fart', 'native', '算法', '还原', 'ebpf', '沙箱', '签名', 'ssl', '抓包', '证书', '混淆', 'dex'] },
          { label: '观测与验证：内核日志、系统日志、dumpsys、进程与 /proc 检查——没有观测就没有对抗',
            hint: '你怎么知道自己的环境是自洽的？靠猜吗？',
            any: ['logcat', 'dmesg', 'dumpsys', 'ps', '观测', '验证', '对账', '排查', '测试', '检查', '证据', '日志'] }
        ],
        hints: ['按「层」来组织答案：硬件/内核 → 内核上的运行环境 → Android 用户空间 → 系统之上的定制与注入 → 面向检测的伪装 → 面向 App 的逆向对抗 → 贯穿始终的观测手段。', '每一层都问一遍：这一层如果缺失或做错，会在哪一步暴露？风控会从哪个信息源看到它？'],
        probes: ['这套系统里，哪一层是「性能问题」，哪一层是「伪装问题」，哪一层两者都是？', '如果目标 App 把关键逻辑放进了受保护的环境（比如 AVF/pKVM 那类方向），你这套体系里的哪些部分会失效？你打算怎么办？'],
        model: '<b>这套系统是一条自下而上的栈，每一层都承担一个明确职责，缺一层则上层全部失效。</b><br><br><b>① 运行环境层（选型）</b>：Android 最终跑在容器（Waydroid，共享宿主内核 + namespaces 隔离，容器内可直接访问硬件、性能接近原生）还是虚拟机（KVM + QEMU/Cuttlefish，隔离强但多一层虚拟硬件）之上。这一层决定性能上限、硬件真实性、隔离强度——<b>选错路线，后面所有努力都在错误的地基上</b>。<br><br><b>② 内核与挂载层</b>：容器路线的硬前提是宿主内核支持 <b>binder</b> 与 ashmem/memfd，没有它 servicemanager 起不来、Android 根本无法启动；虚拟机路线则要求 KVM 与 virtio 相关支持。同时要用<b>绑定挂载</b>拼出容器里的文件系统视图，并在命名空间内重新挂载 <span class="mono">/proc</span>、<span class="mono">/sys</span>、<span class="mono">/dev</span>——<b>挂载没做干净，/proc 就是最大的破绽来源</b>。<br><br><b>③ Android 系统与启动链路</b>：从 boot.img（内核+ramdisk）→ init → init.rc → servicemanager → zygote → system_server → fork App 进程。容器化会<b>整段砍掉硬件前缀</b>（BootROM、Bootloader、内核启动、boot.img 加载都不发生），PID 1 的归属也变了——<b>这些「缺失的痕迹」正是风控要找的东西</b>。<br><br><b>④ 图形与性能</b>：virtio-gpu / VirGL / GPU 直通解决「画得快」；但图形加速在云手机上<b>同时是反检测问题</b>——纯软件渲染（SwiftShader 一类）的渲染器字符串极具辨识度。这一层是性能与伪装的双重战场。<br><br><b>⑤ Root 与注入</b>：Magisk 的 systemless（改 ramdisk + overlayfs/magic mount）让你在<b>不碰系统分区</b>的前提下定制系统；Zygisk 在 Zygote 注入，使每个 App 进程出生即带代码。这是「高度定制」的实现手段。<br><br><b>⑥ 环境伪装</b>：虚拟 WiFi 是典型例子——不能只改 WifiManager，必须让系统服务层、内核视图（<span class="mono">/proc</span>）、参数配套关系（BSSID↔网关↔网段↔DNS）、时间维度（抖动与历史）全部自洽。<b>核心原则：伪装必须自洽，风控只要发现证据链矛盾就赢了。</b><br><br><b>⑦ 逆向对抗技术</b>：环境只是地基，真正对付 App 还要靠前十七章的 hook 框架、脱壳、混淆对抗、Native 分析、算法还原、流量与签名等一整套手段。<br><br><b>⑧ 观测与验证</b>：以上每一层都需要可观测手段（内核日志、系统日志、dumpsys、进程与 /proc 检查）来确认「我的环境是不是自洽的」——<b>没有观测就没有对抗，只能靠猜。</b><br><br><b>最后一句：</b>这套系统的难点从来不是「把某一块做出来」，而是<b>让所有块之间的证据互相对得上账</b>。这也是整个课程反复训练的那件事：<b>不要停在「功能正常」，要追到「为什么它是对的」。</b>',
        after: '<p><b>课程到此结束。</b>如果你能不看笔记把这条栈讲一遍、并在每一层说出「这一层错了会在哪暴露」，那你已经具备了独立设计云端安卓对抗环境的能力——剩下的只是动手与踩坑。</p>'
      }
    ] }
   };
