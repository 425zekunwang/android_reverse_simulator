/* 第 15 章 · 云手机核心原理与检测 —— 数据文件
   结构规范见 BRIEF.md；组件助手 T / S / CLS / SET 由 assets/chapter.js 提供。 */
window.CHAPTER = {
  no: 15,
  title: '云手机核心原理与检测',
  lede: '云手机不是玄学，它就是<strong>跑在服务器上的一台安卓虚拟机</strong>。把虚拟化的分层模型、QEMU 的网络与内核调试、以及"真机有什么、虚拟环境缺什么"这三件事打通，你既能一眼看穿 App 跑在什么环境里（风控与反作弊的看家本领），也能亲手定制一个更隐蔽的运行环境。',
  meta: [
    '核心问题：<b>控制权在哪一层？</b>——从 Type-1/Type-2 到 ARM 的 EL0/EL1/EL2/EL3，把"谁在管谁"彻底理清。',
    '关键工具：<b>QEMU</b>（<span class="mono">-netdev/-device/hostfwd</span>）、<b>GRUB 与分区</b>、<b>GDB 调试内核</b>、<b>传感器/电池/GPU 伪造</b>。',
    '对手：<b>风控与反作弊 SDK</b>——它不看你是什么，它看你<b>哪里不像真机</b>。'
  ],

  sections: [
    /* ================= 15.1 三层架构 ================= */
    {
      h: '15.1',
      title: '先把"云手机在哪一层"看穿',
      html:
        '<p>你一定见过这样的说法：某台云手机是"8 核 4G、安卓 12"。但当你 <span class="mono">adb shell getprop ro.product.model</span> 拿到一个漂亮的小米型号时，风控 SDK 可能在 200 毫秒内就判定它是假的。</p>' +
        '<p>问题出在：<b>型号是可以随便写的，分层结构骗不了人</b>。虚拟化的所有检测点，追到根上都在问同一句话——<b>这台"设备"的下面，到底有几层？谁握着最终控制权？</b>先把这张分层图刻进脑子，后面每一个检测项你都能自己推导出来。</p>' +
        T.intuition('直觉模型 · 房子与二房东',
          '<p><b>Type-1</b> 像一块空地直接盖楼：楼（Guest）之下没有别的住户，房东（Hypervisor）就是地皮的主人。<br>' +
          '<b>Type-2</b> 像你在大楼里租了一间房，再把它转租出去：你的转租（Guest）要先经过大楼物业（宿主 OS），物业再碰硬件。物业随时能查你的水电表——这就是 Type-2 更容易被宿主看穿的原因。<br>' +
          '<b>硬件辅助虚拟化</b>则是开发商直接在楼里装了一部<b>专用电梯</b>（CPU 硬件）：租客以为自己在坐普通电梯，其实每次跨层都被电梯系统记录了一次（VM Exit）。</p>') +
        T.note('key', '🔑 本章主线',
          '<p>云手机 = 服务器上的安卓虚拟机。因此它天生带着两个身份：<b>① 一个虚拟化环境</b>（可被检测、也可被伪装）；<b>② 一个安卓系统</b>（风控要的传感器、电池、基带、GPU 一个都不少）。把这两条线并起来读，本章就没有死记硬背的内容。</p>'),

      stage: {
        title: '三种虚拟化架构的分层对比 · 控制权在哪一层',
        speed: 1900,
        render:
          '<div class="flow-row" style="align-items:flex-start;gap:14px">' +
            '<div style="flex:1;min-width:180px;padding:8px;border:1px dashed #4a5568;border-radius:8px">' +
              '<div style="text-align:center;font-weight:700;margin-bottom:6px">Type-2 宿主型</div>' +
              '<div class="flow-col">' +
                '<div class="blk" id="a_app" style="font-size:12px">App 进程</div>' +
                '<div class="blk" id="a_gos" style="font-size:12px">Guest OS 内核</div>' +
                '<div class="blk" id="a_hyp" style="font-size:12px">Hypervisor（进程）</div>' +
                '<div class="blk" id="a_hos" style="font-size:12px">宿主 OS 内核</div>' +
                '<div class="blk" id="a_hw" style="font-size:12px">硬件 CPU / 内存</div>' +
              '</div></div>' +
            '<div style="flex:1;min-width:180px;padding:8px;border:1px dashed #4a5568;border-radius:8px">' +
              '<div style="text-align:center;font-weight:700;margin-bottom:6px">Type-1 裸金属</div>' +
              '<div class="flow-col">' +
                '<div class="blk" id="b_app" style="font-size:12px">App 进程</div>' +
                '<div class="blk" id="b_gos" style="font-size:12px">Guest OS 内核</div>' +
                '<div class="blk" id="b_hyp" style="font-size:12px">Hypervisor（就是 OS）</div>' +
                '<div class="blk" id="b_hw" style="font-size:12px">硬件 CPU / 内存</div>' +
              '</div></div>' +
            '<div style="flex:1;min-width:200px;padding:8px;border:1px dashed #4a5568;border-radius:8px">' +
              '<div style="text-align:center;font-weight:700;margin-bottom:6px">硬件辅助 · ARM EL</div>' +
              '<div class="flow-col">' +
                '<div class="blk" id="c_app" style="font-size:12px">EL0 · App</div>' +
                '<div class="blk" id="c_p1" style="font-size:12px">Stage-1 页表（Guest OS 管）</div>' +
                '<div class="blk" id="c_gos" style="font-size:12px">EL1 · Guest OS 内核</div>' +
                '<div class="blk" id="c_ip" style="font-size:12px">IPA 中间物理地址</div>' +
                '<div class="blk" id="c_p2" style="font-size:12px">Stage-2 页表（Hypervisor 管）</div>' +
                '<div class="blk" id="c_hyp" style="font-size:12px">EL2 · Hypervisor</div>' +
                '<div class="blk" id="c_el3" style="font-size:12px">EL3 · Secure Monitor</div>' +
                '<div class="blk" id="c_hw" style="font-size:12px">真实物理内存 / 设备</div>' +
              '</div></div>' +
          '</div>' +
          '<div class="flow-row" style="margin-top:10px;gap:10px;flex-wrap:wrap">' +
            '<span class="pill" id="st_ctrl">控制权：?</span>' +
            '<span class="pill" id="st_see">Guest 能看见：?</span>' +
            '<span class="pill acc" id="st_risk">风控风险：?</span>' +
          '</div>',
        reset: () => {
          ['a_app','a_gos','a_hyp','a_hos','a_hw','b_app','b_gos','b_hyp','b_hw',
           'c_app','c_gos','c_hyp','c_el3','c_hw','c_p1','c_p2','c_ip'].forEach(id => S(id, ''));
          CLS('st_ctrl', 'pill'); SET('st_ctrl', '控制权：?');
          CLS('st_see', 'pill'); SET('st_see', 'Guest 能看见：?');
          CLS('st_risk', 'pill acc'); SET('st_risk', '风控风险：?');
        },
        steps: [
          { run: () => { S('a_hw', 'active'); CLS('st_ctrl', 'pill'); SET('st_ctrl', '控制权：硬件'); SET('st_see', 'Guest 能看见：无'); },
            note: '<b>最底层永远是硬件。</b>CPU、内存、中断控制器、网卡、各种传感器。虚拟化要做的第一件事，就是让多个 Guest <b>轮流</b>以为自己独占这些硬件。' },
          { run: () => { S('a_hw', 'done'); S('a_hos', 'active'); SET('st_ctrl', '控制权：宿主 OS'); SET('st_see', 'Guest 能看见：宿主 OS 的一部分'); },
            note: '<b>Type-2 在硬件之上先有一层完整的宿主 OS。</b>Linux/Windows 先跑起来，Hypervisor 只是它上面的一个<b>普通进程</b>。这是 VMware Workstation、VirtualBox、纯软件 QEMU 的形态。' },
          { run: () => { S('a_hos', 'done'); S('a_hyp', 'active'); SET('st_ctrl', '控制权：Hypervisor 进程（要经过宿主 OS）'); },
            note: '<b>Hypervisor 进程负责翻译 Guest 的每一次敏感操作。</b>Guest 想改页表、想读写设备寄存器？先陷入这个进程，由它替代执行。<b>代价</b>：多绕一层宿主 OS，性能明显低于 Type-1。' },
          { run: () => { S('a_hyp', 'done'); S('a_gos', 'active'); },
            note: '<b>Guest OS 内核（比如被虚拟化的 Android/Linux）跑起来了。</b>它自以为在裸机上，实际上它的"物理内存"是宿主 OS malloc 出来的一块匿名映射。' },
          { run: () => { S('a_gos', 'done'); S('a_app', 'active'); CLS('st_risk', 'pill warn'); SET('st_risk', '风控风险：高（痕迹多）'); },
            note: '<b>最上层是 App——也就是本章反复出现的风控 SDK 所在位置。</b>Type-2 环境痕迹最多：宿主进程名、<span class="mono">/proc</span> 里的可见信息、虚拟网卡、软件渲染的 GL_RENDERER，都能从这一层探测到。' },
          { run: () => { S('a_app', 'done'); S('a_hw', 'active'); S('b_hw', 'active'); CLS('st_ctrl', 'pill'); SET('st_ctrl', '控制权：Hypervisor（直接管硬件）'); SET('st_see', 'Guest 能看见：仅虚拟硬件'); CLS('st_risk', 'pill ok'); SET('st_risk', '风控风险：低（痕迹少）'); },
            note: '<b>Type-1 拿掉整个宿主 OS。</b>Hypervisor 自己就是最底层软件，直接管硬件。Xen、VMware ESXi、Microsoft Hyper-V 属于这一类。<span class="pill acc">KVM 是特例</span> 它是 Linux 内核模块，把 Linux 内核本身变成了 Type-1 Hypervisor——常被归为 Type-1，本质是"寄生"在内核里的。' },
          { run: () => { S('b_hw', 'done'); S('b_hyp', 'active'); SET('st_see', 'Guest 能看见：虚拟 CPU / 虚拟内存 / virtio 设备'); },
            note: '<b>Type-1 的 Hypervisor 承担了操作系统的角色。</b>它自己调度、自己管内存、自己驱动网卡。Guest 看到的全是"虚拟硬件"——这正是虚拟机的第一个可探测点：<b>它看到的硬件拓扑，和真实手机完全不是一回事</b>。' },
          { run: () => { S('b_hyp', 'done'); S('b_gos', 'active'); },
            note: '<b>Guest OS 依然不知情。</b>它对硬件的每次访问都被 Hypervisor 拦下或转发。区别在于：Type-1 少了一层，路径更短，性能更好——所以<b>真正的云手机平台基本都跑在 KVM/Xen 这类 Type-1 环境上</b>，而不是 VirtualBox。' },
          { run: () => { S('b_gos', 'done'); S('b_app', 'active'); },
            note: '<b>App 层看到的世界由下层决定。</b>无论 Type-1 还是 Type-2，App 只能通过系统 API 间接观察硬件。所以反检测的核心思路永远是——<b>让 API 返回的答案，符合真机的统计规律</b>。' },
          { run: () => { ['a_app','a_gos','a_hyp','a_hos','a_hw','b_app','b_gos','b_hyp','b_hw'].forEach(i => S(i, 'done')); S('c_hw', 'active'); CLS('st_ctrl', 'pill'); SET('st_ctrl', '控制权：CPU 硬件决定，不再靠软件翻译'); },
            note: '<b>接下来是第三种形态：硬件辅助虚拟化。</b>Intel VT-x（VMX）和 AMD AMD-V（SVM）让 CPU 自己认识"我现在在跑 Guest"，敏感指令直接由硬件捕获，不需要二进制翻译。ARM 上的对应机制是 Exception Level。' },
          { run: () => { S('c_hw', 'done'); S('c_el3', 'active'); SET('st_see', 'Guest 能看见：连 Hypervisor 都看不见 EL3'); },
            note: '<b>EL3 是 ARM 的最高特权层——Secure Monitor</b>，ARM TrustZone 的落脚点。EL2 的 Hypervisor 也管不了它。云手机几乎不涉及 EL3，但你要知道：<b>ARM 的特权层级比 x86 更清晰</b>，这也是手机 SoC 上虚拟化痕迹更容易被定位的原因。' },
          { run: () => { S('c_el3', 'done'); S('c_hyp', 'active'); CLS('st_ctrl', 'pill ok'); SET('st_ctrl', '控制权：EL2 Hypervisor'); },
            note: '<b>EL2 就是 Hypervisor 层。</b>KVM/ARM、Xen on ARM、pKVM 都跑在这里。它拥有对整个 Guest 的完全控制权——包括决定 Guest 能访问哪些物理内存。' },
          { run: () => { S('c_hyp', 'done'); S('c_p2', 'active'); SET('st_see', 'Guest 能看见：Guest 物理地址，看不到真实物理地址'); },
            note: '<b>Stage-2 页表由 Hypervisor 掌管</b>，负责把 Guest 物理地址（IPA，中间物理地址）翻译成真实物理地址。关键点：<b>它不需要修改 Guest 的任何代码或内存</b>。这就是 Hypervisor 能在 EL2 做"内存断点"而 Guest 完全察觉不到的硬件基础。' },
          { run: () => { S('c_p2', 'done'); S('c_ip', 'active'); },
            note: '<b>IPA 是虚拟化里最容易被忽略的概念。</b>Guest 眼里的"0x8000_0000 物理地址"只是一个中间量，真正的落点由 Stage-2 决定。<b>对逆向的含义</b>：你在 Guest 里 dump 出来的内存布局，和硬件上真实的内存布局可能完全对不上。' },
          { run: () => { S('c_ip', 'done'); S('c_p1', 'active'); },
            note: '<b>Stage-1 页表由 Guest OS 自己管</b>：虚拟地址 → IPA。两级翻译串起来才是完整链路：<b>VA --(Stage-1, Guest 管)--> IPA --(Stage-2, Hypervisor 管)--> PA</b>。记死这条链，后面讲检测时你会反复用它。' },
          { run: () => { S('c_p1', 'done'); S('c_gos', 'active'); },
            note: '<b>EL1 是 Guest OS 内核。</b>它以为自己在管页表、管中断，其实每次要动关键资源都会被硬件送到 EL2 去批准（VM Exit）。Android 内核跑在这一层。' },
          { run: () => { S('c_gos', 'done'); S('c_app', 'active'); CLS('st_risk', 'pill bad'); SET('st_risk', '风控风险：取决于伪装质量'); },
            note: '<b>EL0 就是 App，也就是云手机里跑着的目标 App。</b>它在最外层，能拿到的全部信息都来自系统 API。但恰恰是这些 API，暴露了下层的一整个世界——传感器、电池、GPU、网卡、开机时间。' },
          { run: () => { CLS('st_ctrl', 'pill acc'); SET('st_ctrl', '一句话总结：App 在 EL0，被 EL1 管；EL1 被 EL2 管；云手机就是这整套的 EL0 那格'); SET('st_see', 'Guest 能看见：一切 API 返回值——也就是全部检测依据'); CLS('st_risk', 'pill warn'); SET('st_risk', '结论：分层骗不了人，但 API 返回值可以'); },
            note: '<b>回到本章的实用结论。</b>你没法在 EL0 直接问"我在不在虚拟机里"——硬件不会告诉你。你能问的只有 API，而 API 的返回值从下层一路传上来，<b>每一层都可能留下或抹掉痕迹</b>。云手机检测与反检测，全部战场就在这条链上。' }
        ]
      },

      after:
        T.tbl(['架构', 'Guest 之下有几层', '性能', '云手机里的现实'],
          [['Type-2 宿主型', '宿主 OS + Hypervisor 进程', '较低', '桌面测试、开发调试常见；<b>痕迹最多</b>'],
           ['Type-1 裸金属', '只有 Hypervisor', '高', '云平台主力（Xen / ESXi / Hyper-V / KVM）'],
           ['硬件辅助', 'CPU 硬件直接分层（EL2/VMX）', '接近原生', '<b>现代云手机的真实形态</b>']]) +
        T.note('', '📌 检测视角小结',
          '<p>从上图能直接推出三类检测点：<b>① 下层留下的痕迹</b>（虚拟网卡 OUI、virtio 设备、软件渲染器）；<b>② 该有却没有的硬件</b>（传感器、基带）；<b>③ 数值不像真机的统计特征</b>（恒定电量、永不变化的光照值）。第 15.9 节会把它们做成一张全景表。</p>')
    },

    /* ================= 15.2 Hypervisor 类型 ================= */
    {
      h: '15.2',
      title: 'Type-1 / Type-2：Hypervisor 站在哪里',
      html:
        '<p><span class="term" data-def="虚拟机监视器，负责创建、调度、隔离虚拟机的那层软件">Hypervisor</span>（也叫 VMM，虚拟机监视器）是虚拟化的核心。它的职责只有三件：<b>① 隔离</b>——让多个 Guest 互不干扰；<b>② 调度</b>——分配 CPU 时间与内存；<b>③ 拦截</b>——把 Guest 对硬件的直接操作接管过来，替它执行。</p>' +
        '<p>按"站在哪一层"，Hypervisor 分成两类。这个区分不是学术分类，它<b>直接决定了一台环境里能留下多少痕迹</b>。</p>' +
        T.tbl(['', 'Type-1（裸金属）', 'Type-2（宿主型）'],
          [['运行位置', '直接跑在硬件上，<b>没有宿主 OS</b>', '跑在宿主 OS 之上，是<b>一个普通进程</b>'],
           ['性能', '高', '较低（每次操作要绕过宿主 OS）'],
           ['典型实现', 'Xen、VMware ESXi、Microsoft Hyper-V', 'VMware Workstation、VirtualBox、纯软件模式的 QEMU'],
           ['主要用途', '数据中心、云平台', '桌面开发测试'],
           ['痕迹特征', '少：Guest 只面对虚拟硬件', '多：宿主进程、宿主 <span class="mono">/proc</span>、宿主网络栈都会渗出来']]) +
        T.note('acc', '⚠️ KVM 的特殊性：一个"寄生"的 Type-1',
          '<p>KVM 不是独立操作系统，它是 <b>Linux 内核模块</b>。加载后，Linux 内核本身获得了 Hypervisor 能力——内核既是宿主，又是 Hypervisor。<b>所以 KVM 常被归类为 Type-1，但它又必须靠 Linux 内核活着</b>。</p>' +
          '<p>实践含义：KVM 的性能接近原生（因为 Guest 的普通指令直接跑在物理 CPU 上，只有敏感指令被硬件捕获），同时又保留了完整 Linux 用户态工具链（<span class="mono">qemu-system-x86_64 -enable-kvm</span>、libvirt、virsh）。<b>这就是云手机平台的标准底座。</b></p>'),

      after:
        '<h4>全虚拟化 vs 半虚拟化：Guest 要不要改代码</h4>' +
        '<p>第二个关键区分维度是：<b>Guest OS 知不知道自己在被虚拟化</b>。</p>' +
        '<p><b>全虚拟化（Full Virtualization）</b>——Guest OS <b>不需要任何修改</b>。Hypervisor 通过两种手段捕获 Guest 的敏感指令：早期靠 <span class="term" data-def="动态扫描 Guest 的指令流，把敏感指令替换成能触发陷入的等价指令">二进制翻译</span>（动态扫描并替换敏感指令），后来靠硬件辅助直接捕获。<br>' +
        '<span class="hit">优点</span>：能跑任何未修改的操作系统，包括闭源的 Windows、iOS。<br>' +
        '<span class="miss">缺点</span>：二进制翻译有性能开销；而且 Guest 完全不知情，<b>也就意味着它会毫无防备地暴露真实硬件信息</b>。</p>' +
        '<p><b>半虚拟化（Paravirtualization, PV）</b>——Guest OS <b>必须修改</b>，主动通过 <span class="term" data-def="Guest 主动调用 Hypervisor 的接口，类似系统调用，取代"执行敏感指令被陷入"">hypercall</span> 与 Hypervisor 协作，而不是靠"执行敏感指令被硬件陷入"。<br>' +
        '<span class="hit">优点</span>：性能更好，没有陷入-模拟的往返开销。<br>' +
        '<span class="miss">缺点</span>：必须改 Guest 内核，因此只能跑开源系统（Linux 可以，Windows 不行）。<br>' +
        '<b>最成功的半虚拟化遗产</b>：<span class="term" data-def="一组半虚拟化 I/O 驱动规范，Guest 通过共享内存环形队列与 Hypervisor 通信，而不是模拟真实硬件寄存器">virtio</span> 驱动。今天 QEMU 上的 <span class="mono">virtio-net</span>、<span class="mono">virtio-blk</span>、<span class="mono">virtio-gpu</span> 全是半虚拟化设备。</p>' +
        '<div class="note warn"><div class="note-h">🔍 这对检测意味着什么</div><p>只要 Guest 里出现了 <span class="mono">virtio</span> 字样（<span class="mono">/sys/bus/virtio</span> 目录、<span class="mono">lspci</span> 里的 Red Hat Virtio 设备、内核日志里的 virtio 驱动），就<b>几乎可以直接判定这是虚拟机</b>——真机不会用 virtio。这是比 <span class="mono">ro.kernel.qemu</span> 更底层、更难伪造的痕迹，因为它是<b>设备树级别</b>的事实。</p></div>' +
        T.note('key', '🔑 两个维度的组合',
          '<p>把两个维度叉起来，现代云手机的位置很清楚：<b>硬件辅助的全虚拟化 + 半虚拟化 I/O</b>。CPU/内存走硬件辅助（快且无痕），I/O 走 virtio（快但留痕）。<b>所以云手机最硬的破绽，往往不在 CPU 而在 I/O 和各类传感器。</b></p>')
    },

    /* ================= 15.3 硬件辅助虚拟化 ================= */
    {
      h: '15.3',
      title: '硬件辅助虚拟化与"陷入-模拟"',
      html:
        '<p>软件二进制翻译又慢又难写。硬件厂商的解法非常直接：<b>让 CPU 自己知道"我现在在跑 Guest"</b>，并为此新增一套特权级别。</p>' +
        '<p><b>Intel VT-x</b> 引入了 <span class="term" data-def="Virtual Machine Extensions，Intel 的硬件虚拟化扩展">VMX</span> 和两种操作模式——<b>根模式（root，Hypervisor 运行的地方）</b>与<b>非根模式（non-root，Guest 运行的地方）</b>。关键机制是 <span class="term" data-def="Virtual Machine Control Structure，一块由 CPU 读写的内存区域，配置哪些事件会导致 VM Exit">VMCS</span>：Hypervisor 通过它配置"哪些指令、哪些事件会导致从非根模式切回根模式"。</p>' +
        '<p><b>AMD AMD-V</b> 做的是同一件事，叫 <span class="term" data-def="Secure Virtual Machine，AMD 的硬件虚拟化扩展">SVM</span>，用 <span class="term" data-def="Virtual Machine Control Block，AMD 对应 Intel VMCS 的结构">VMCB</span> 保存同样的控制信息。</p>' +
        '<p>把一次敏感操作串起来看，就是经典的 <b>陷入-模拟（trap-and-emulate）</b>：Guest 执行敏感指令 → 触发异常（<b>VM Exit</b>）→ 控制权交给 Hypervisor → Hypervisor 读 VMCS 判断原因、模拟执行 → <b>VM Entry</b> 返回 Guest。<b>硬件辅助的意义</b>：这一整套由 CPU 硬件完成，比软件二进制翻译快得多，Guest 的普通指令则<b>直接以原生速度跑在物理 CPU 上</b>。</p>',

      stage: {
        title: '一次敏感指令的完整旅程 · VM Exit / Stage-2 / VM Entry',
        speed: 2100,
        render:
          '<div class="flow-row" style="flex-wrap:wrap;gap:8px">' +
            '<span class="blk" id="x1" style="font-size:12px">EL0 · App 调用系统调用</span>' +
            '<span class="arrow">→</span>' +
            '<span class="blk" id="x2" style="font-size:12px">EL1 · Guest 内核执行敏感指令</span>' +
            '<span class="arrow">→</span>' +
            '<span class="blk" id="x3" style="font-size:12px">硬件捕获 · VM Exit</span>' +
          '</div>' +
          '<div class="flow-row" style="flex-wrap:wrap;gap:8px;margin-top:8px">' +
            '<span class="blk" id="x4" style="font-size:12px">EL2 · Hypervisor 读 VMCS/VMCB</span>' +
            '<span class="arrow">→</span>' +
            '<span class="blk" id="x5" style="font-size:12px">查 Stage-2 页表定落点</span>' +
            '<span class="arrow">→</span>' +
            '<span class="blk" id="x6" style="font-size:12px">模拟执行 / 改映射</span>' +
          '</div>' +
          '<div class="flow-row" style="flex-wrap:wrap;gap:8px;margin-top:8px">' +
            '<span class="blk" id="x7" style="font-size:12px">VM Entry 返回 Guest</span>' +
            '<span class="arrow">→</span>' +
            '<span class="blk" id="x8" style="font-size:12px">Guest 以为指令成功了</span>' +
          '</div>' +
          '<div class="flow-row" style="margin-top:10px;gap:10px;flex-wrap:wrap">' +
            '<span class="pill" id="xp1">Guest 视角：什么都没发生</span>' +
            '<span class="pill acc" id="xp2">Hypervisor 视角：一切尽在掌握</span>' +
          '</div>',
        reset: () => {
          ['x1','x2','x3','x4','x5','x6','x7','x8'].forEach(i => S(i, ''));
          CLS('xp1', 'pill'); SET('xp1', 'Guest 视角：什么都没发生');
          CLS('xp2', 'pill acc'); SET('xp2', 'Hypervisor 视角：一切尽在掌握');
        },
        steps: [
          { run: () => S('x1', 'active'), note: '<b>起点是 App 的一次系统调用。</b>比如 <span class="mono">getSensorList()</span>、读电池状态、取 IMEI。App 在 EL0，它唯一的出路就是 svc 指令陷入 EL1 内核。' },
          { run: () => { S('x1', 'done'); S('x2', 'active'); }, note: '<b>Guest 内核接手，准备去碰"硬件"。</b>它以为自己要读的是真实的传感器寄存器或真实网卡。但这条指令落在非根模式（non-root）里。' },
          { run: () => { S('x2', 'done'); S('x3', 'hot'); CLS('xp1', 'pill warn'); SET('xp1', 'Guest 视角：卡了一下（如果它察觉的话）'); }, note: '<b>硬件发现这是被 VMCS 标记为"要拦截"的指令，直接触发 VM Exit。</b>CPU 从非根模式切到根模式。<b>这一步没有任何软件参与，Guest 无法阻止、无法观测</b>。' },
          { run: () => { S('x3', 'done'); S('x4', 'active'); }, note: '<b>Hypervisor 在 EL2 醒来，读 VMCS/VMCB 里的退出原因。</b>是访问了未映射的内存？还是执行了特权指令？还是外部中断？退出原因决定了接下来走哪条处理路径。' },
          { run: () => { S('x4', 'done'); S('x5', 'active'); }, note: '<b>如果是内存访问，就要查 Stage-2 页表。</b>Guest 给的地址只是 IPA（中间物理地址），真实落点由 Hypervisor 掌控的 Stage-2 决定。这一步<b>不需要修改 Guest 的任何代码或内存</b>——这是它最大的威力。' },
          { run: () => { S('x5', 'done'); S('x6', 'active'); CLS('xp2', 'pill ok'); SET('xp2', 'Hypervisor：我可以让读到的值任意变化，Guest 毫无察觉'); }, note: '<b>Hypervisor 开始"模拟"。</b>它可以返回真值，也可以返回一个精心构造的假值；可以让这次读命中另一块内存，也可以在读的瞬间暂停 Guest 去检查它的整个状态。<b>这就是 Hypervisor 级调试（如 EL2 内存断点）的立足点。</b>' },
          { run: () => { S('x6', 'done'); S('x7', 'active'); }, note: '<b>VM Entry：控制权交回 Guest。</b>CPU 恢复到非根模式的上下文，Guest 从"下一条指令"继续。代价只是这几十到几百个周期的往返。' },
          { run: () => { S('x7', 'done'); S('x8', 'active'); }, note: '<b>Guest 内核和 App 完全不知道发生过什么。</b>系统调用正常返回了一个电池电量。这就是虚拟化的本质：<b>控制权的转移对上层完全透明</b>。' },
          { run: () => { CLS('xp1', 'pill bad'); SET('xp1', 'Guest 视角的"透明"，正是反检测的难点'); CLS('xp2', 'pill ok'); SET('xp2', '结论：下层全知全能，上层只能靠 API 猜'); }, note: '<b>把这条链反过来读，就是检测的全部逻辑。</b>既然下层全知全能、上层一无所知，那么<b>上层唯一能拿到的证据，就是"下层忘记抹掉的细节"</b>——不变化的电量、缺失的传感器、SwiftShader 渲染器、52:54:00 开头的 MAC。' }
        ]
      },

      after:
        '<h4>ARM 的对应机制：Exception Level 与 Stage-2 页表</h4>' +
        '<p>手机 SoC 几乎都是 ARM，所以云手机检测最终要落到 ARM 的虚拟化扩展上。ARM 用 <b>Exception Level（异常级别）</b>表达特权分层，比 x86 的 ring 更干净：</p>' +
        T.tbl(['Exception Level', '运行内容'],
          [['EL0', '用户态应用（风控 SDK 就跑在这里）'],
           ['EL1', 'Guest OS 内核（Android Linux 内核）'],
           ['EL2', '<b>Hypervisor</b>（KVM/ARM、pKVM、Xen on ARM）'],
           ['EL3', 'Secure Monitor（ARM TrustZone）']]) +
        '<p><b>Stage-2 页表</b>是 ARM 虚拟化的核心设计：地址翻译被拆成两级。<br>' +
        '<b>Stage-1</b> 由 <b>Guest OS 自己管理</b>：虚拟地址（VA）→ Guest 物理地址（IPA）。<br>' +
        '<b>Stage-2</b> 由 <b>Hypervisor 管理</b>：Guest 物理地址（IPA）→ 真实物理地址（PA）。</p>' +
        T.note('key', '🔑 Stage-2 为什么值得单独记住',
          '<p>因为它是"<b>不修改 Guest 就能完全控制 Guest 看到什么内存</b>"的硬件基础。Hypervisor 想让某块内存对 Guest 隐身，只要在 Stage-2 里取消映射；想在不改 Guest 一个字节的前提下替换一段数据，只要在 Stage-2 里改指向。Guest 的页表、代码、校验和全都完好无损——<b>这是 Hypervisor 级调试、内存断点、以及高级沙箱的技术底座</b>。</p>' ) +
        T.note('warn', '🧭 出问题往哪查',
          '<p>如果你在真机上怀疑有 Hypervisor 介入（企业沙箱、加固方案、云真机），可从三个方向找证据：<b>① 时序</b>——VM Exit 会带来可测量的抖动，用高精度计时器测异常波动；<b>② 固件与设备树</b>——<span class="mono">/proc/device-tree</span>、<span class="mono">/sys/firmware</span> 里的 hypervisor 节点；<b>③ CPU 特性寄存器</b>——某些实现会暴露虚拟化能力位。<span class="pill warn">具体寄存器名与可读性依平台而异，待核实</span></p>')
    },

    /* ================= 15.4 虚拟化下的引导与分区 ================= */
    {
      h: '15.4',
      title: '虚拟化下的引导链与磁盘分区',
      html:
        '<p>一台机器从按下电源到安卓桌面出现，中间有一条固定的接力链：<b>BIOS/UEFI → Bootloader → 内核 → 根文件系统 → init</b>。云手机把整条链搬进了虚拟机，于是每一个环节都变成<b>你可以替换、可以裁剪、也可以用来藏东西</b>的部件。</p>' +
        '<p>关键在于：虚拟机里的"固件"是 Hypervisor 造出来的。<b>QEMU 用的是 SeaBIOS（传统 BIOS）或 OVMF（UEFI 固件）</b>。它们不是真主板上的 ROM，而是一段普通的程序。<span class="hit">好处</span>：可以随意定制、随意精简。<span class="miss">代价</span>：它们的存在本身就是虚拟化特征。</p>' +
        '<h4>GRUB 的四个阶段</h4>' +
        '<p><span class="term" data-def="Grand Unified Bootloader，Linux 上最常用的引导程序">GRUB</span> 不是"一段程序"，而是<b>一串被逐级加载的程序</b>——因为最初能放进引导扇区的空间实在太小了：</p>' +
        '<p><b>① 阶段 1</b>：躺在 MBR 或 EFI 分区里的一小段代码，只有几百字节，唯一使命是"找到并加载下一段"。<br>' +
        '<b>② 阶段 1.5 / 阶段 2</b>：加载完整的 GRUB（含文件系统驱动），然后读取配置 <span class="mono">/boot/grub/grub.cfg</span>。这一步之后 GRUB 才"认识磁盘上的文件"。<br>' +
        '<b>③ 加载内核</b>：把内核镜像 <span class="mono">vmlinuz</span> 与 initramfs（<span class="mono">initrd</span> / <span class="mono">initrd.img</span>）读进内存。<br>' +
        '<b>④ 交权</b>：把控制权交给内核，引导程序退出历史舞台。</p>' +
        T.tbl(['', 'MBR', 'GPT'],
          [['最大磁盘', '2 TB', '<b>远超 2 TB</b>'],
           ['分区数', '4 个主分区（第 4 个可为扩展分区，内部再分逻辑分区）', '<b>128 个</b>分区'],
           ['引导代码位置', '磁盘最开头的 <b>512 字节</b>', '<b>ESP（EFI System Partition，FAT32）</b>'],
           ['配套固件', '传统 BIOS', '<b>UEFI</b>'],
           ['云手机里的选择', '老镜像、小磁盘', '现代镜像、大磁盘、需要多分区']]) +
        '<p><b>Linux 常见分区布局</b>：<span class="mono">/boot</span>（内核与 initramfs）、<span class="mono">/</span>（根文件系统）、<span class="mono">swap</span>（交换分区）、以及 UEFI 系统的 <b>ESP</b>。云手机镜像通常会把这一整套压到最小：一个小 <span class="mono">/boot</span> 加一个大 <span class="mono">/</span>，swap 常常直接省掉。</p>' +
        T.note('key', '🔑 initramfs 是什么，为什么安卓也有',
          '<p><span class="term" data-def="initial RAM filesystem，一个在内存里展开的临时根文件系统，包含挂载真实根文件系统所需的驱动">initramfs</span> 是一份<b>临时的根文件系统</b>，打包在内存里。它存在的理由很朴素：内核要挂载真实的根文件系统，可它连磁盘控制器的驱动都还没有——驱动在根文件系统上，根文件系统又挂不上，死循环。解法是：内核先挂载 initramfs，从里面加载必要驱动（磁盘控制器、文件系统模块），准备妥当后再 <span class="mono">switch_root</span> 切换到真实根文件系统。</p>' +
          '<p><b>这和安卓的关系</b>：Android 的 <span class="mono">boot.img</span> 里也有一个 ramdisk，里面就是精简版的 initramfs，含 <span class="mono">/init</span>。安卓启动的第一阶段（init 的第一阶段）就跑在这里面。<span class="pill acc">所以你解包 boot.img、改 ramdisk、重打包，本质上就是在改 initramfs——这是定制 ROM 隐藏虚拟化痕迹最直接的入口之一。</span></p>'),

      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一 · 内核调试的引导方式',
            scenario: '<b>情境：</b>你要在 QEMU 里调试一个自己编译的 Linux 内核。同事给了你一份预装好的磁盘镜像，让你"用 GRUB 引导进去"。你改了内核源码，重新编译出了 <span class="mono">bzImage</span>，现在要让它跑起来。<br><br>你会怎么做？',
            choices: [
              { t: '把新内核塞进镜像的 /boot 目录，更新 grub.cfg，然后从 GRUB 里选它启动', next: 'n1' },
              { t: '用 QEMU 的 -kernel / -initrd / -append 直接引导这个内核，绕过 GRUB 和整个引导链', next: 'n2' },
              { t: '重新制作一个带新内核的完整磁盘镜像，再整盘启动', next: 'n3' },
              { t: '先用 GRUB 启动旧内核，进去之后用 kexec 把新内核换上去', next: 'n4' }
            ]
          },
          n1: {
            label: '选A · 走 GRUB', terminal: true, verdict: 'bad',
            verdictTitle: '能跑通，但你在给自己加三层无关变量',
            result: '<b>这不是错，是绕远。</b>把内核塞进 <span class="mono">/boot</span> 再改 <span class="mono">grub.cfg</span>，意味着每次改内核都要：挂载镜像 → 拷文件 → 改配置 → 而且 GRUB 一旦配置写错，你会看到一个大红框而不是内核报错，<b>排查成本远高于调试本身</b>。<br><br><b>认知根源</b>：把"启动一台机器"和"启动一个内核"当成了同一件事。调试内核时你只关心内核，引导链是纯粹的干扰项。<br><br><b>正确做法</b>：用 <span class="mono">-kernel</span> 直接喂内核、<span class="mono">-initrd</span> 喂 initramfs、<span class="mono">-append</span> 传内核命令行,GRUB 和固件全部跳过。改一次编译一次，秒级重启。'
          },
          n2: {
            label: '选B · 直接引导内核', terminal: true, verdict: 'good',
            verdictTitle: '正确：调试期把引导链整个摘掉',
            result: '<b>这是内核开发的日常操作。</b><span class="mono">-kernel arch/x86/boot/bzImage -append "console=ttyS0" -nographic</span>，QEMU 直接把这份内核当成固件之后的第一个程序加载，GRUB、MBR、ESP 全部不参与。<br><br><b>为什么反直觉</b>：在生产环境里"绕过引导程序"听起来像是作弊或走捷径；但在内核调试里，<b>引导链是噪声，不是被测对象</b>。只有当你确实要调试引导过程本身（比如 GRUB 阶段 1.5 加载失败）时，才该把它加回来。<br><br><b>额外收益</b>：配合 <span class="mono">-s -S</span> 可以让 QEMU 在第一条指令前冻住 CPU，等你 GDB 连上再放行——从内核第一条指令开始单步。'
          },
          n3: {
            label: '选C · 重做整盘镜像', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：把分钟级的事做成了小时级',
            result: '<b>重做镜像只应该发生在你要交付的时候，不该发生在调试循环里。</b>内核调试的核心诉求是"改一行、编译、跑起来看结果"，这个循环必须短。整盘重做会把它拉长到几十分钟，你会因为嫌麻烦而减少尝试次数——<b>调试效率的下降往往不是技术问题，而是循环太长导致的心理成本</b>。<br><br><b>正确节奏</b>：调试期用 <span class="mono">-kernel</span> 快速迭代；定稿后再把最终内核打进镜像、验证 GRUB 引导。两件事分开做。'
          },
          n4: {
            label: '选D · 用 kexec 换内核', terminal: true, verdict: 'bad',
            verdictTitle: '技术上行得通，但你在用大炮打蚊子',
            result: '<b>kexec 是"从一个已运行的内核直接跳进另一个内核"的机制</b>，它的价值在于跳过固件初始化、把重启时间从分钟压到秒——用于生产服务器热重启、kdump 崩溃转储这类场景。<br><br>你的问题不是"重启太慢"，而是"根本还没跑起来"。先用旧内核启动、再 kexec 到新内核，等于<b>为了到达起点先跑完全程</b>。而且一旦新内核在早期初始化就崩了，你会同时失去两套上下文，排查更乱。<br><br><b>先用对工具</b>：<span class="mono">-kernel</span> 是起点，kexec 是另一类问题的答案。'
          }
        }
      },

      after:
        T.note('warn', '🧭 这对云手机检测意味着什么',
          '<p><b>① 引导链是环境指纹。</b>固件类型（SeaBIOS / OVMF / 真机 UEFI）、分区表格式、<span class="mono">/proc/cmdline</span> 里的内核命令行——真机上的这些内容是厂商固件写死的，而虚拟机里的往往带着 QEMU 痕迹（比如 <span class="mono">console=ttyS0</span>、虚拟串口参数）。<b>读 <span class="mono">/proc/cmdline</span> 是一个成本极低、命中率不低的检测点。</b></p>' +
          '<p><b>② 分区布局也是指纹。</b>真机安卓是 <span class="mono">boot</span>/<span class="mono">system</span>/<span class="mono">vendor</span>/<span class="mono">userdata</span> 这套 AOSP 标准布局；云手机若跑在通用 Linux 镜像上，<span class="mono">/proc/mounts</span> 里会出现 <span class="mono">/dev/vda1</span>、<span class="mono">ext4</span> 这类桌面 Linux 的痕迹。<b>反过来，这也是伪装的抓手</b>：定制镜像时把分区名、挂载点、cmdline 全部对齐真机，就能消掉一整类特征。</p>')
    },
    /* ================= 15.5 QEMU 网络模式 ================= */
    {
      h: '15.5',
      title: 'QEMU 网络：三种模式与数据包的旅程',
      html:
        '<p>云手机最容易被忽略、却最致命的一环是<b>网络</b>。原因很直接：<b>你连云手机用的是 adb，adb 走的是网络；风控判断你在哪，用的也是网络。</b>不理解 QEMU 的网卡模型，你既连不上云手机，也解释不了为什么它会被标记成数据中心 IP。</p>' +
        '<p>QEMU 的网络设计有一个非常干净的抽象：<b>后端（backend）与前端（frontend）分离</b>。</p>' +
        '<p><span class="mono">-netdev</span> 定义<b>后端</b>——"这个网络怎么连出去"（用户态 NAT？tap 设备？还是干脆不连？）。<br>' +
        '<span class="mono">-device</span> 定义<b>前端</b>——"Guest 看到的是什么型号的网卡"（virtio-net-pci？e1000？rtl8139？）。</p>' +
        '<p>两者用 <span class="mono">id</span> 关联。这个分离设计的好处是：<b>你可以随意组合</b>——同一个 NAT 后端，可以让 Guest 看到 virtio 网卡，也可以让它看到一块模拟的 Intel 千兆网卡。<b>而"Guest 看到什么网卡"，恰恰是风控的检测点之一。</b></p>' +
        T.tbl(['模式', '原理', '优点', '缺点'],
          [['<b>NAT</b><br><span class="small">user-mode networking</span>',
            'QEMU 内置 <span class="term" data-def="QEMU 内置的一个用户态 TCP/IP 协议栈实现，负责在 QEMU 进程内完成 NAT 转换">SLIRP</span> 协议栈做用户态 NAT。Guest 的出网流量被 QEMU 进程代理成宿主机上的普通 socket',
            '无需 root、无需配置、开箱即用',
            '性能一般；外网<b>默认无法访问 Guest</b>（需 <span class="mono">hostfwd</span>）；ICMP（ping）支持有限；Guest 看不到真实网络拓扑'],
           ['<b>桥接</b><br><span class="small">Bridge + tap</span>',
            '创建 <span class="term" data-def="Linux 的一种虚拟网卡：一端由用户态程序（QEMU）读写，另一端表现为内核里的一个网络接口">tap</span> 虚拟网卡，桥接到物理网卡。Guest 像局域网里一台<b>独立主机</b>，有独立 IP',
            '性能好；<b>网络行为最真实</b>；支持任意协议（含 ICMP）',
            '需要 root；需配置网桥；需 DHCP 或手工配 IP'],
           ['<b>Host-only / 内部网络</b>',
            '只在宿主机与 Guest 之间通信，<b>不连外网</b>',
            '隔离性好，适合沙箱测试',
            'Guest 无法上网']]) +
        T.note('', '🔧 两条必须记住的命令',
          T.code('<span class="c"># NAT + 端口转发：把宿主机 5555 转到 Guest 的 5555（adb 默认端口）</span>\n' +
            '<span class="f">-netdev</span> user,id=n0,<span class="k">hostfwd</span>=tcp::<span class="n">5555</span>-:<span class="n">5555</span> \\\n' +
            '<span class="f">-device</span> virtio-net-pci,netdev=n0\n\n' +
            '<span class="c"># 桥接：用 tap 设备，script=no 表示不由 QEMU 调用配置脚本</span>\n' +
            '<span class="f">-netdev</span> tap,id=n0,ifname=tap0,script=no \\\n' +
            '<span class="f">-device</span> virtio-net-pci,netdev=n0') +
          '<p style="margin:8px 0 0"><b><span class="mono">hostfwd</span> 对云手机的意义</b>：云手机跑在服务器上，你要在本地用 <span class="mono">adb connect &lt;服务器IP&gt;:&lt;端口&gt;</span> 连它——背后就是 QEMU 的 <span class="mono">hostfwd</span> 把宿主端口转发到 Guest 的 adb 端口（5555）。<b>你每天敲的那条 adb connect，落地就是这一行参数。</b></p>'),

      stage: {
        title: '三种网络模式的数据包流向 · 一个包从 Guest 到外网经过的每一跳',
        speed: 1800,
        render:
          '<div class="flow-col" style="gap:8px">' +
            '<div class="flow-row" style="gap:8px;flex-wrap:wrap">' +
              '<span class="blk" id="g_guest" style="font-size:12px">Guest 网卡<br><span class="small">10.0.2.15</span></span>' +
              '<span class="arrow" id="g_a1">→</span>' +
              '<span class="blk" id="g_slirp" style="font-size:12px">QEMU SLIRP<br><span class="small">用户态 NAT</span></span>' +
              '<span class="arrow" id="g_a2">→</span>' +
              '<span class="blk" id="g_sock" style="font-size:12px">宿主机 socket<br><span class="small">普通进程</span></span>' +
              '<span class="arrow" id="g_a3">→</span>' +
              '<span class="blk" id="g_wan" style="font-size:12px">外网</span>' +
            '</div>' +
            '<div class="flow-row" style="gap:8px;flex-wrap:wrap">' +
              '<span class="blk" id="b_guest" style="font-size:12px">Guest 网卡<br><span class="small">192.168.1.50</span></span>' +
              '<span class="arrow" id="b_a1">→</span>' +
              '<span class="blk" id="b_tap" style="font-size:12px">tap0<br><span class="small">虚拟网卡</span></span>' +
              '<span class="arrow" id="b_a2">→</span>' +
              '<span class="blk" id="b_br" style="font-size:12px">网桥 br0</span>' +
              '<span class="arrow" id="b_a3">→</span>' +
              '<span class="blk" id="b_phy" style="font-size:12px">物理网卡<br><span class="small">eth0</span></span>' +
              '<span class="arrow" id="b_a4">→</span>' +
              '<span class="blk" id="b_wan" style="font-size:12px">外网</span>' +
            '</div>' +
            '<div class="flow-row" style="gap:8px;flex-wrap:wrap">' +
              '<span class="blk" id="h_guest" style="font-size:12px">Guest</span>' +
              '<span class="arrow" id="h_a1">↔</span>' +
              '<span class="blk" id="h_host" style="font-size:12px">宿主机<br><span class="small">闭环，到此为止</span></span>' +
            '</div>' +
          '</div>' +
          '<div class="flow-row" style="margin-top:10px;gap:8px;flex-wrap:wrap">' +
            '<span class="pill" id="np1">NAT：外网默认进不来</span>' +
            '<span class="pill acc" id="np2">桥接：有独立 IP，可被访问</span>' +
            '<span class="pill" id="np3">Host-only：不能出网</span>' +
          '</div>',
        reset: () => {
          ['g_guest','g_slirp','g_sock','g_wan','b_guest','b_tap','b_br','b_phy','b_wan','h_guest','h_host'].forEach(i => S(i, ''));
          CLS('np1', 'pill'); SET('np1', 'NAT：外网默认进不来');
          CLS('np2', 'pill acc'); SET('np2', '桥接：有独立 IP，可被访问');
          CLS('np3', 'pill'); SET('np3', 'Host-only：不能出网');
        },
        steps: [
          { run: () => { S('g_guest', 'active'); CLS('np1', 'pill active'); }, note: '<b>先看 NAT 模式。</b>Guest 拿到的是 QEMU 分配的内网地址（SLIRP 默认网段是 <span class="mono">10.0.2.0/24</span>，网关 <span class="mono">10.0.2.2</span>）。<b>这个网段本身就是特征</b>：真机在 4G/WiFi 下几乎不可能拿到 10.0.2.x。' },
          { run: () => { S('g_guest', 'done'); S('g_slirp', 'active'); }, note: '<b>包到了 QEMU 进程里的 SLIRP 协议栈。</b>注意这里的关键：<b>SLIRP 是一个用户态的 TCP/IP 实现</b>，它不经过宿主机的内核网络栈做 NAT，而是 QEMU 自己解析这个包、自己维护连接状态、自己伪装成客户端。' },
          { run: () => { S('g_slirp', 'done'); S('g_sock', 'active'); }, note: '<b>SLIRP 用宿主机的普通 socket 把请求发出去。</b>所以在宿主机看来，这不是"一台虚拟机在上网"，而是 <b>QEMU 这个进程开了个 socket</b>——Guest 的流量和宿主机上任何一个程序的流量没有区别。这是 NAT 模式免 root 的根本原因。' },
          { run: () => { S('g_sock', 'done'); S('g_wan', 'active'); CLS('np1', 'pill warn'); SET('np1', 'NAT：出得去，但外网默认进不来'); }, note: '<b>包到达外网。</b>但反过来——<b>外网想主动连 Guest 是做不到的</b>，因为 Guest 没有可路由的公网地址，也没人给它做端口映射。所以你必须用 <span class="mono">hostfwd</span> 显式开洞，<b>这正是 adb 连接云手机的唯一通路</b>。' },
          { run: () => { S('g_wan', 'done'); S('b_guest', 'active'); CLS('np2', 'pill active'); }, note: '<b>再看桥接模式。</b>Guest 有了一张<b>看起来完全真实的网卡</b>，并且从你局域网的 DHCP 拿到地址（比如 <span class="mono">192.168.1.50</span>）。对局域网里的其他机器来说，<b>这就是一台普通主机</b>。' },
          { run: () => { S('b_guest', 'done'); S('b_tap', 'active'); }, note: '<b>关键部件是 tap0。</b>它是一种"半虚拟网卡"：一端是内核里的网络接口，另一端归用户态的 QEMU 读写。<b>QEMU 把 Guest 发出的帧写进 tap0，内核就以为这是从一块真网卡收到的。</b>' },
          { run: () => { S('b_tap', 'done'); S('b_br', 'active'); }, note: '<b>tap0 被桥接到 br0。</b>网桥是二层设备，它把 tap0 和物理网卡"接在同一根线上"。所以从协议栈角度看，<b>Guest 和宿主机真的处在同一个广播域里</b>——ARP、DHCP、ICMP 全部正常工作。' },
          { run: () => { S('b_br', 'done'); S('b_phy', 'active'); }, note: '<b>帧从物理网卡发出。</b>到这里，Guest 的包和宿主机自己发的包走的是<b>同一条物理链路</b>，没有任何 NAT、没有任何代理、没有用户态协议栈参与。<b>所以桥接的性能和真实性都是最好的。</b>' },
          { run: () => { S('b_phy', 'done'); S('b_wan', 'active'); CLS('np2', 'pill ok'); SET('np2', '桥接：可被访问，网络行为最真实'); }, note: '<b>到达外网，而且能被主动访问。</b>代价是要 root（创建 tap 和网桥需要特权）、要手工配好网桥和 DHCP。<b>对云手机平台来说，这意味着每个实例占用一个真实的局域网 IP</b>——成本高，但网络特征最干净。' },
          { run: () => { S('b_wan', 'done'); S('h_guest', 'active'); CLS('np3', 'pill warn'); }, note: '<b>最后是 Host-only。</b>流量只到宿主机为止，形成一个闭环。适合做完全隔离的沙箱测试——<b>比如你要观察某个 App 在没有网络时的行为，或者防止样本外联。</b>' },
          { run: () => { S('h_guest', 'done'); S('h_host', 'active'); CLS('np3', 'pill bad'); SET('np3', 'Host-only：Guest 无法上网'); }, note: '<b>代价是 Guest 完全没有外网。</b>对云手机来说这通常是不可接受的（App 要联网），但在恶意样本分析、离线复现里很有用。' },
          { run: () => { CLS('np1', 'pill'); SET('np1', 'NAT：成本最低 → 云手机最常用'); CLS('np2', 'pill acc'); SET('np2', '桥接：特征最干净 → 高价值业务用'); CLS('np3', 'pill'); SET('np3', 'Host-only：隔离沙箱专用'); }, note: '<b>把三种模式并排看，就是一张成本与真实性的权衡表。</b>NAT 便宜但留特征（10.0.2.x、宿主机代理）；桥接真实但贵。<b>风控视角</b>：很多云手机用 NAT + 数据中心 IP，于是"IP 归属"成了比网卡型号更早暴露它的信号。' },
          { run: () => { S('g_guest', 'hot'); S('b_guest', 'hot'); S('h_guest', 'hot'); }, note: '<b>最后记住一个共同点：三种模式下，Guest 看到的网卡都是"虚拟"的。</b>即便桥接让网络行为完全真实，<b>网卡的 MAC 地址仍然由 QEMU 生成</b>。QEMU 默认使用 <span class="mono">52:54:00</span> 开头的 OUI——<b>这是一个可以用一行代码检测出来的硬特征</b>。' }
        ]
      },

      after:
        T.note('key', '🔑 网络层的检测点（这一节最实用的部分）',
          '<p><b>① MAC 地址前缀。</b>虚拟网卡常用特定 OUI，QEMU 的默认前缀是 <span class="mono">52:54:00</span>。真机是厂商分配的 OUI。检测成本极低、命中率高。<b>对抗</b>：启动时显式指定 <span class="mono">-device virtio-net-pci,mac=...</span>，用符合真机厂商的 OUI。</p>' +
          '<p><b>② 内网网段。</b>NAT 模式的 <span class="mono">10.0.2.x</span> 在真机上极罕见。<b>对抗</b>：桥接模式，或至少改掉 SLIRP 的默认网段（<span class="mono">net=</span> 参数）。</p>' +
          '<p><b>③ IP 归属。</b>云手机跑在机房，出口 IP 是<b>数据中心 IP 段</b>，会被风控直接标记。这是最难靠改参数解决的一条——<b>必须走代理</b>（住宅代理优于机房代理）。</p>' +
          '<p><b>④ 连通性异常。</b>NAT 下 ICMP 支持有限，某些网络探测 API 会得到反常结果；<span class="mono">hostfwd</span> 只开了特定端口，扫描行为的响应模式也会暴露。</p>' +
          '<p><b>⑤ 网卡型号。</b>virtio 在真机上不存在。<b>对抗</b>：用 <span class="mono">-device e1000</span> 等更"普通"的型号，或直接改 virtio 的设备 ID 与字符串。<span class="pill warn">具体可改性依 QEMU 版本与驱动实现而定，待核实</span></p>')
    },
    /* ================= 15.6 QEMU 启动命令解析 ================= */
    {
      h: '15.6',
      title: '逐参数拆解一条 QEMU 启动命令',
      html:
        '<p>下面这条命令是<b>一台"云手机雏形"的最小骨架</b>。我们一个参数一个参数地拆——你要能说出每个参数<b>影响的是哪一层</b>（CPU？内存？存储？网络？显示？还是引导方式？），因为在定制隐蔽环境时，<b>每一层都对应着一组能被检测的特征</b>。</p>',

      stepper: {
        title: 'QEMU 启动命令 · 逐参数解析',
        lines: [
          { code: '<span class="f">qemu-system-x86_64</span> \\',
            note: '<b>选择模拟器可执行文件本身就是第一个决定。</b><span class="mono">qemu-system-x86_64</span> 模拟 x86_64 平台；云手机若是 ARM 镜像，要用 <span class="mono">qemu-system-aarch64</span>。<b>这决定了 Guest 看到的 CPU 架构</b>——而架构是 App 无法改变的硬事实（<span class="mono">Build.SUPPORTED_ABIS</span> 会暴露它）。',
            state: { '影响的层': 'CPU 架构', '检测关联': 'ABI / CPU 型号' } },
          { code: '  <span class="k">-m</span> <span class="n">4096</span> \\',
            note: '<b>给 Guest 分配 4 GB 内存。</b>Guest 眼里的"物理内存"其实是 QEMU 进程向宿主申请的一块内存。注意：<b>这个值会和真机内存规格对比</b>——真机常见 6/8/12/16 GB，而云手机常配 2/4/8 GB。<span class="mono">ActivityManager.MemoryInfo.totalMem</span> 报出来的数字不自然，就是一个弱特征。',
            state: { '影响的层': '内存', '常见坑': '配成真机没有的规格' } },
          { code: '  <span class="k">-smp</span> <span class="n">4</span> \\',
            note: '<b>4 个虚拟 CPU 核心。</b>Guest 会看到 4 个 core。<b>关键坑</b>：真机 SoC 通常是大核 + 小核的异构架构（big.LITTLE），频率也不同；而 QEMU 给出的核心是<b>完全对称、频率一致</b>的。检测方读 <span class="mono">/sys/devices/system/cpu/cpu*/cpufreq</span> 时，若所有核心频率曲线完全相同，就很可疑。',
            state: { '影响的层': 'CPU 拓扑', '检测关联': '核心数 / 频率曲线' } },
          { code: '  <span class="k">-drive</span> file=android.img,format=qcow2,if=virtio \\',
            note: '<b>磁盘：把 android.img 当成 Guest 的硬盘。</b><span class="mono">format=qcow2</span> 是 QEMU 的写时复制格式（镜像小、快照方便）；<span class="mono">if=virtio</span> 表示<b>用半虚拟化驱动</b>挂载——性能好，但 Guest 里会出现 <span class="mono">/dev/vda</span> 和 virtio 设备，<b>这是明确的虚拟化痕迹</b>。',
            state: { '影响的层': '存储', '检测关联': '/dev/vda* · virtio' } },
          { code: '  <span class="k">-netdev</span> user,id=n0,<span class="k">hostfwd</span>=tcp::<span class="n">5555</span>-:<span class="n">5555</span> \\',
            note: '<b>网络后端：用户态 NAT + 一条端口转发规则。</b><span class="mono">hostfwd=tcp::5555-:5555</span> 的含义是"宿主机的 5555 端口 → Guest 的 5555 端口"。<b>这正是 <span class="mono">adb connect &lt;服务器IP&gt;:5555</span> 能连上云手机的底层机制。</b>云手机厂商给你一个"连接地址"，本质就是它替你配好了这条规则。',
            state: { '网络后端': 'user (SLIRP)', '端口转发': '宿主 5555 → Guest 5555', '用途': '<b>adb 连接</b>' } },
          { code: '  <span class="k">-device</span> virtio-net-pci,netdev=n0 \\',
            note: '<b>网络前端：Guest 看到的网卡型号。</b>用 <span class="mono">netdev=n0</span> 绑定到上面那个后端。<b>这里才是检测点所在</b>——virtio 网卡在真机上不存在；且默认 MAC 以 <span class="mono">52:54:00</span> 开头。<b>伪装从这里下手</b>：换型号、指定 MAC。',
            state: { 'Guest 看到的网卡': 'virtio-net-pci', '检测关联': 'MAC OUI · 驱动名' } },
          { code: '  <span class="k">-nographic</span> \\',
            note: '<b>不开图形窗口，把串口重定向到当前终端。</b>服务器上没有显示器，云手机平台一律用这个。配合内核参数 <span class="mono">console=ttyS0</span>，你就能在终端里看到内核启动日志。<b>副作用</b>：<span class="mono">/proc/cmdline</span> 里可能留下 <span class="mono">console=ttyS0</span> 这种真机绝不会有</b>的痕迹。',
            state: { '显示方式': '无图形，串口到终端', '检测关联': '/proc/cmdline' } },
          { code: '  <span class="c"># 或者用 -vnc :1 提供图形界面（远程桌面）</span> \\',
            note: '<b>另一种显示方案：VNC。</b><span class="mono">-vnc :1</span> 意味着监听 5901 端口，可以用 VNC 客户端连上去看到安卓画面。<b>云手机的"远程投屏"功能，本质上就是这个 VNC（或更高效的私有协议）+ 输入事件转发。</b>',
            state: { '显示方式': 'VNC :1 → 端口 5901', '对应产品功能': '云手机投屏' } },
          { code: '  <span class="k">-kernel</span> arch/x86/boot/bzImage \\',
            note: '<b>直接引导指定内核，跳过 GRUB 和固件。</b>这是内核开发的日常操作——改一行代码、编译、重启，秒级迭代。<b>代价</b>：这条路绕过了正常引导链，所以<b>只适合调试</b>，不适合验证生产镜像。',
            state: { '引导方式': '直接加载内核', '跳过': 'BIOS/UEFI + GRUB' } },
          { code: '  <span class="k">-initrd</span> initramfs.cpio.gz \\',
            note: '<b>提供 initramfs。</b>内核先挂载这个内存文件系统，从里面加载挂载真实根文件系统所需的驱动，然后 <span class="mono">switch_root</span> 切换过去。<b>安卓对应物</b>：<span class="mono">boot.img</span> 里的 ramdisk。<b>定制隐蔽环境时，这里是改动的第一站。</b>',
            state: { '引导方式': '提供 initramfs', '安卓对应': 'boot.img 的 ramdisk' } },
          { code: '  <span class="k">-append</span> <span class="s">&quot;console=ttyS0 root=/dev/vda1&quot;</span> \\',
            note: '<b>传给内核的命令行参数。</b><span class="mono">console=ttyS0</span> 让日志走串口（配合 <span class="mono">-nographic</span>）；<span class="mono">root=/dev/vda1</span> 指定真实根文件系统在哪。<b>这些参数会原样出现在 Guest 的 <span class="mono">/proc/cmdline</span> 里</b>——真机不会有 <span class="mono">ttyS0</span> 和 <span class="mono">vda</span>，所以这是<b>一条极易检测、又极易修复</b>的特征。',
            state: { '内核命令行': 'console=ttyS0 root=/dev/vda1', 'Guest 可见': '<b>/proc/cmdline</b>', '检测关联': '<b>强特征</b>' } },
          { code: '  <span class="k">-s</span> <span class="k">-S</span>',
            note: '<b>调试双雄。</b><span class="mono">-s</span> 等价于在 1234 端口开一个 GDB server；<span class="mono">-S</span> 让 CPU <b>在第一条指令前就冻住</b>，等你连上 GDB 再放行。<b>合起来用，你就能从内核的第一条指令开始单步</b>——这是理解内核启动、定位早期崩溃的标准姿势。',
            state: { 'GDB server': 'tcp::1234', 'CPU 状态': '<b>冻结，等待 attach</b>' } }
        ]
      },

      after:
        T.note('key', '🔑 从这条命令里读出"四个可伪装层"',
          '<p>把上面的参数按"影响哪一层"归类，云手机的伪装工程就有了清晰的分工：</p>' +
          '<p><b>① 计算层</b>（<span class="mono">-m</span> / <span class="mono">-smp</span>）：改内存大小、核心数，让它们落在真机的常见规格里；更彻底的做法是伪造 cpufreq 曲线，模拟大小核。<br>' +
          '<b>② 存储层</b>（<span class="mono">-drive</span>）：<span class="mono">if=virtio</span> 会留下 <span class="mono">/dev/vda</span>，可改用 IDE/SATA 模拟，或在内核层做设备名映射。<br>' +
          '<b>③ 网络层</b>（<span class="mono">-netdev</span> / <span class="mono">-device</span>）：换网卡型号、指定 MAC OUI、改 SLIRP 网段、<b>以及最关键的——换掉数据中心出口 IP</b>。<br>' +
          '<b>④ 引导层</b>（<span class="mono">-kernel</span> / <span class="mono">-append</span>）：<span class="mono">/proc/cmdline</span> 必须干净。</p>' +
          '<p><b>而所有这一切的上层</b>——传感器、电池、GPU、设备标识——都不在 QEMU 参数里，<b>它们在 Android 系统层</b>。这就是为什么云手机的隐蔽性工程要横跨 QEMU 配置、内核定制、Android 框架修改三个层次。</p>'),

      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境二 · 从本地连上云手机',
            scenario: '<b>情境：</b>你在一台云手机实例上部署了测试环境，云手机平台给了你服务器的公网 IP <span class="mono">203.0.113.45</span>，并告诉你实例跑在 QEMU 的 NAT 模式下，adb 端口是 5555。<br><br>现在你要在本地开发机上执行 <span class="mono">adb connect</span>。<b>问题是：你需要平台侧做什么配置，这条命令才能成功？</b>',
            choices: [
              { t: '不需要任何配置，QEMU 的 NAT 模式默认允许外部访问 Guest 的任意端口', next: 'n1' },
              { t: '平台侧必须在 QEMU 启动参数里配置 hostfwd，把宿主机的某个端口转发到 Guest 的 5555', next: 'n2' },
              { t: '必须改成桥接模式才行，NAT 模式下 adb 永远连不上', next: 'n3' },
              { t: '在 Guest 里安装一个 adb 反向连接的客户端，让它主动连回本地开发机', next: 'n4' }
            ]
          },
          n1: {
            label: '选A · 不用配置', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：NAT 的默认行为恰恰是"进不来"',
            result: '<b>这是对 user-mode networking 最常见的误解。</b>QEMU 的 SLIRP 实现的是一台<b>单向的、带 NAT 的路由器</b>：Guest 主动发起的连接可以出去（因为 SLIRP 记住了这条连接的状态，回来的包能对上），但<b>外网主动发起的新连接没有任何映射关系，SLIRP 不知道送给谁，只能丢弃</b>。<br><br><b>认知根源</b>：把 NAT 想成了"端口全开的路由器"。真实 NAT 的本质是<b>连接状态表</b>——只有表里有的连接才能双向通行。<br><br><b>正确做法</b>：显式配置 <span class="mono">hostfwd</span> 建立一条静态映射规则。这条规则相当于在 NAT 表里<b>预先塞进一条永久条目</b>。'
          },
          n2: {
            label: '选B · 必须配 hostfwd', terminal: true, verdict: 'good',
            verdictTitle: '正确：hostfwd 就是 NAT 模式下的唯一入口',
            result: '<b>这就是云手机厂商替你做的事。</b>标准配置是：<br><span class="mono">-netdev user,id=n0,hostfwd=tcp::5555-:5555</span><br>含义是"宿主机所有网卡的 5555 端口 ←→ Guest 的 5555 端口"。之后你 <span class="mono">adb connect 203.0.113.45:5555</span> 就通了。<br><br><b>几个容易被忽略的细节</b>：<br>① <span class="mono">hostfwd</span> 可以写多组（比如同时转发 adb 的 5555 和投屏端口），同端口冲突时用不同的宿主端口；<br>② 宿主端口默认绑定所有网卡，若要限制来源可指定绑定地址；<br>③ <b>端口暴露在公网意味着安全风险</b>——开了 5555 就等于把设备的 shell 通道挂在互联网上，生产环境必须加防火墙或走隧道。<br><br><b>云手机平台的通行做法</b>：每个实例分配不同的宿主端口，前面再挂一层网关做鉴权，绝不裸奔。'
          },
          n3: {
            label: '选C · 必须桥接', terminal: true, verdict: 'bad',
            verdictTitle: '过度结论：桥接更好，但不是唯一解',
            result: '<b>你把"更真实"和"必需"混为一谈了。</b>桥接确实网络行为最真实、也能被主动访问，但它需要 root 权限创建 tap 设备和网桥，<b>而且每个实例要占用一个局域网 IP</b>——在规模化部署里这是实打实的成本。<br><br>NAT + <span class="mono">hostfwd</span> 是<b>绝大多数云手机平台的实际选择</b>：不需要额外 IP、不需要 root 之外的复杂配置、一台服务器上能塞下几十上百个实例，靠端口号区分。<br><br><b>认知根源</b>：把"技术上更优"直接等同于"工程上唯一可行"。真实工程永远在成本、规模、真实性之间做权衡——<b>而 NAT 的代价就是留下了更多可检测特征</b>（这一点在第 15.5 节已经列过）。'
          },
          n4: {
            label: '选D · Guest 反向连接', terminal: true, verdict: 'bad',
            verdictTitle: '可行但错位：你在给一个已经有答案的问题发明新解法',
            result: '<b>反向连接确实是穿透 NAT 的通用思路</b>（没有公网入口时，让内网主动连出来），在远程控制、内网穿透场景里很常见。<br><br>但这里的问题是：<b>QEMU 的 hostfwd 已经把这个问题解决了</b>，而且是平台侧一行参数的事。你绕开现成机制，去 Guest 里跑一个客户端，等于：<br>① 增加了 Guest 内的进程痕迹（<b>而进程列表本身就是风控检测点</b>）；<br>② 引入了额外的故障点（客户端崩了、重连失败）；<br>③ 还要额外开一条出站通道。<br><br><b>认知根源</b>：遇到"连不上"就本能地想到穿透，而没有先问一句<b>"这个虚拟化平台本身提供了什么机制"</b>。<b>先读工具的能力，再决定要不要自己造。</b>'
          }
        }
      }
    },
    /* ================= 15.7 编译与调试内核 ================= */
    {
      h: '15.7',
      title: '在 QEMU 下编译与调试 Linux 内核',
      html:
        '<p>为什么一个讲安卓逆向的课程要教你编译 Linux 内核？<b>因为云手机最彻底的伪装，发生在内核层。</b>设备名、<span class="mono">/proc</span> 下的内容、CPU 信息的呈现方式、驱动加载的痕迹——这些都在内核里。<b>应用层能改的只是返回值，内核层能改的是"这个值是否真实存在过"。</b></p>' +
        '<p>下面这条流程是内核开发的标准起手式。注意每一步<b>为什么存在</b>，而不是死记命令。</p>',

      term: {
        title: '终端 · 从源码到 GDB 断点',
        lines: [
          { t: 'p', s: 'mkdir -p ~/kdev && cd ~/kdev', note: '<b>建一个干净的工作目录。</b>内核编译产物极多（几百 MB 到几 GB），和别的项目混在一起会很难清理。' },
          { t: 'p', s: 'git clone --depth 1 https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git', note: '<b>下载内核源码。</b><span class="mono">--depth 1</span> 只取最新一次提交，能把下载量从数 GB 降到几百 MB——<b>调试时你不做内核开发历史考古，浅克隆足够</b>。' },
          { t: 'o', s: 'Cloning into \'linux\'...' },
          { t: 'd', s: 'remote: Enumerating objects: 8xxxx, done.' },
          { t: 'o', s: 'Receiving objects: 100% (8xxxx/8xxxx), 21x.xx MiB | xx MiB/s, done.' },
          { t: 'p', s: 'cd linux', note: '<b>进入源码目录。</b>之后所有 make 都在这里执行。' },
          { t: 'p', s: 'make defconfig', note: '<b>生成默认配置。</b>它会写出一个 <span class="mono">.config</span>，里面的选项是针对<b>当前编译主机架构</b>的合理默认值。<b>关键</b>：默认配置里<b>没有开调试信息</b>，直接编译出来的内核没法给 GDB 用符号——这是下一步要解决的问题。' },
          { t: 'o', s: '  HOSTCC  scripts/basic/fixdep' },
          { t: 'o', s: '  HOSTCC  scripts/kconfig/conf.o' },
          { t: 'o', s: '*** Default configuration is based on \'x86_64_defconfig\'' },
          { t: 'o', s: '#' },
          { t: 'o', s: '# configuration written to .config' },
          { t: 'o', s: '#' },
          { t: 'p', s: 'make menuconfig', note: '<b>基于 ncurses 的图形化配置界面。</b>你需要在这里打开两项：<b>① <span class="mono">Kernel hacking → Compile-time checks and compiler options → Compile the kernel with debug info</span></b>（生成 DWARF 调试信息）；<b>② <span class="mono">Kernel hacking → KGDB</span></b>（如果要走 kgdb 路线）。<b>不开调试信息，后面 GDB 只能看到汇编和地址，看不到函数名和变量</b>。' },
          { t: 'w', s: '*** 若无 ncurses 依赖，menuconfig 会报错。可改用 make nconfig 或直接编辑 .config' },
          { t: 'd', s: '（界面操作：方向键导航，空格切换，Esc Esc 退出并保存）' },
          { t: 'p', s: 'make -j$(nproc)', note: '<b>并行编译。</b><span class="mono">$(nproc)</span> 会把并行度设成 CPU 核数。<b>这里最容易踩的坑</b>：并行度过高导致内存不足（OOM），编译被内核杀掉，报错信息还很难懂。内存紧张时用 <span class="mono">-j4</span> 之类的小值。' },
          { t: 'o', s: '  CC      init/main.o' },
          { t: 'o', s: '  CC      kernel/fork.o' },
          { t: 'd', s: '  ...（数千行，首次编译通常 10-40 分钟）' },
          { t: 'o', s: '  LD      vmlinux' },
          { t: 'o', s: '  OBJCOPY arch/x86/boot/bzImage' },
          { t: 'o', s: 'Kernel: arch/x86/boot/bzImage is ready  (#1)' },
          { t: 'd', s: '↑ 产物有两个关键文件：vmlinux（带符号的 ELF，给 GDB 用）和 bzImage（压缩的可引导镜像，给 QEMU 用）' },
          { t: 'p', s: 'qemu-system-x86_64 -kernel arch/x86/boot/bzImage \\', note: '<b>直接引导刚编译的内核。</b>跳过 GRUB 和固件，把迭代循环压到最短。' },
          { t: 'd', s: '    -append "console=ttyS0" -nographic -s -S' },
          { t: 'w', s: 'QEMU 启动后终端无输出、CPU 冻结 —— 这是 -S 的预期行为，不是卡死' },
          { t: 'o', s: '（QEMU 在 1234 端口等待 GDB 连接，Guest CPU 停在上电第一条指令）' },
          { t: 'p', s: 'gdb vmlinux', note: '<b>用带符号的 vmlinux 启动 GDB。</b>注意<b>不是</b> bzImage——bzImage 是压缩镜像，没有符号。这个区分是新手最常犯的错：加载错了文件，GDB 里全是问号。' },
          { t: 'o', s: 'GNU gdb (GDB) 1x.x' },
          { t: 'o', s: 'Reading symbols from vmlinux...' },
          { t: 'p', s: '(gdb) target remote :1234', note: '<b>连上 QEMU 的 GDB stub。</b>这一步之后 GDB 就接管了 Guest 的 CPU。因为 QEMU 启动时带了 <span class="mono">-S</span>，此刻 CPU 还停着——你拥有的是<b>从第一条指令开始的完整控制权</b>。' },
          { t: 'o', s: 'Remote debugging using :1234' },
          { t: 'o', s: '0x000000000000fff0 in ?? ()' },
          { t: 'p', s: '(gdb) b start_kernel', note: '<b>在 C 语言入口下断点。</b><span class="mono">start_kernel()</span> 是内核 C 代码的起点（之前的 <span class="mono">0xfff0</span> 那段是实模式下的早期汇编）。断在这里，你就跳过了最枯燥的 16 位实模式引导。' },
          { t: 'o', s: 'Breakpoint 1 at 0xffffffff8xxxxxxx: file init/main.c, line xxx.' },
          { t: 'p', s: '(gdb) c', note: '<b>continue：放行 CPU。</b>内核开始执行，直到命中 <span class="mono">start_kernel</span>。从这一刻起，你可以单步、看变量、读内存、改寄存器——<b>整个内核对你完全透明</b>。' },
          { t: 'o', s: 'Continuing.' },
          { t: 'o', s: 'Breakpoint 1, start_kernel () at init/main.c' },
          { t: 'p', s: '(gdb) lx-dmesg', note: '<b>查看内核日志缓冲区。</b>这是内核调试脚本（<span class="mono">scripts/gdb/</span>）提供的命令，需要先在 GDB 里 <span class="mono">source vmlinux-gdb.py</span>。<b>用途</b>：不用串口输出也能看到内核启动日志，在崩溃现场事后取证时特别好用。<span class="pill warn">该命令需内核源码内的 GDB 脚本支持，不同版本命令集有差异</span>' },
          { t: 'w', s: '若提示 undefined command，说明 vmlinux-gdb.py 未加载或脚本中没有该命令' }
        ]
      },

      after:
        T.note('key', '🔑 内核层定制：反检测能做到什么程度',
          '<p>编译内核不是为了炫技，它是<b>反检测工程的天花板</b>。应用层能做的只是"把系统 API 的返回值改掉"；内核层能做到的是"<b>让这个值根本不以可疑的形式存在</b>"。</p>' +
          '<p><b>① 隐藏虚拟化设备。</b><span class="mono">/dev/qemu_pipe</span>、<span class="mono">/dev/goldfish_pipe</span> 这些设备节点是模拟器/虚拟机的招牌。在<b>内核驱动层</b>去掉它们（或改掉设备名），比在应用层拦截文件访问要干净得多——因为风控可能直接 <span class="mono">open()</span> 这些节点，甚至用 native 代码绕过 Java 层。<br>' +
          '<b>② 重写 /proc 输出。</b><span class="mono">/proc/cpuinfo</span>、<span class="mono">/proc/version</span>、<span class="mono">/proc/cmdline</span> 的内容由内核生成。<b>改内核源码，这些文件从源头上就是"真机样式"</b>。<br>' +
          '<b>③ 抹掉虚拟化标志。</b><span class="mono">/proc/cpuinfo</span> 的 <span class="mono">flags</span> 里若出现 hypervisor 相关标志，等于直接自首。<span class="pill warn">具体的 flag 名称与内核版本相关，待核实</span><br>' +
          '<b>④ 让设备拓扑合理化。</b>把 <span class="mono">/dev/vda</span> 映射成 <span class="mono">/dev/block/mmcblk0</span>（真机的 eMMC/UFS 命名习惯），把 virtio 设备伪装成真实厂商设备。</p>' +
          '<p><b>但记住边界</b>：内核能改的是"Guest 内部看到的世界"，<b>改不了的是 Hypervisor 层的事实</b>（比如真实的内存翻译、时序特征）。所以内核定制能挡住绝大多数应用层检测，但挡不住在 EL2 做内存比对的高级检测方案。<b>这就是第 15.3 节讲的 Stage-2 的价值所在。</b></p>'),

      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境三 · 一次"看不见"的启动失败',
            scenario: '<b>情境：</b>你按上面的流程编译好内核，执行：<br><span class="mono">qemu-system-x86_64 -kernel arch/x86/boot/bzImage -append "console=ttyS0" -nographic -s -S</span><br><br>终端里<b>什么都不显示</b>，光标静止，等了两分钟也没有任何输出。<br><br>你的第一反应是什么？',
            choices: [
              { t: '编译出问题了，回去检查 make 的报错，重新编译内核', next: 'n1' },
              { t: '这是 -S 的预期行为：CPU 被冻结在第一条指令，正在等 GDB 连接，不是故障', next: 'n2' },
              { t: '-nographic 不兼容，应该去掉它改用 -vnc 才能看到启动日志', next: 'n3' },
              { t: 'console=ttyS0 参数写错了，应该改成 console=tty0' , next: 'n4' }
            ]
          },
          n1: {
            label: '选A · 怀疑编译', terminal: true, verdict: 'bad',
            verdictTitle: '误判：你把"设计行为"当成了"故障"',
            result: '<b>编译几乎肯定没问题</b>——如果 <span class="mono">make</span> 成功产出了 <span class="mono">bzImage</span>，内核就是可引导的。<br><br><b>认知根源</b>：<b>没有先检查自己传的参数，就去怀疑最耗时的那个环节。</b>重新编译一遍内核要几十分钟，而读一遍自己的命令行只要十秒。这是调试中最昂贵的错误类型——<b>方向错了，越努力越亏</b>。<br><br><b>正确的第一反应永远是</b>：我加了什么非默认参数？<span class="mono">-S</span> 在手册里的定义就是"启动时不启动 CPU（do not start CPU at startup）"，waiting for gdb 是它的字面语义。<br><br><b>顺手的排查顺序</b>：先去掉 <span class="mono">-S</span>（保留 <span class="mono">-s</span>）看是否有输出 → 有输出说明一切正常，问题只在 <span class="mono">-S</span>；仍无输出再查 <span class="mono">console=</span> 与 <span class="mono">-nographic</span> 的组合。'
          },
          n2: {
            label: '选B · 这是 -S 的预期行为', terminal: true, verdict: 'good',
            verdictTitle: '正确：先读懂自己传的参数，再怀疑系统',
            result: '<b>完全正确，而且这是本章最值得形成肌肉记忆的一条调试习惯。</b><span class="mono">-S</span> 的含义是"冻结 CPU 等待调试器"，<span class="mono">-s</span> 的含义是"在 1234 端口开 GDB server"。两者合用的语义就是：<b>启动后什么都不做，安静地等人来接管。</b>没有输出不是 bug，是 feature。<br><br><b>验证方式</b>：另开一个终端 <span class="mono">gdb vmlinux</span>，然后 <span class="mono">target remote :1234</span>，再 <span class="mono">c</span>——你会立刻看到内核日志刷满屏幕。<b>这恰好证明了内核是好的。</b><br><br><b>为什么这条经验重要</b>：在虚拟化、内核、固件这类"看不见的层"里调试时，<b>"安静"往往是最难判断的状态</b>——它可能是正常等待、可能是早期崩溃、也可能是配置错误。区分它们的方法只有一个：<b>知道每一步的预期行为是什么</b>。所以本节 term 里每一行都标了预期输出。'
          },
          n3: {
            label: '选C · 换 -vnc', terminal: true, verdict: 'bad',
            verdictTitle: '治标：换了显示方式，但没解释为什么没输出',
            result: '<b><span class="mono">-nographic</span> 和这个现象没有因果关系。</b><span class="mono">-nographic</span> 的作用是"不创建图形窗口，把串口与控制台重定向到当前终端"，它<b>只会让输出更容易看到</b>，不会让它消失。<br><br>换成 <span class="mono">-vnc :1</span> 之后，你依然什么都看不到——<b>因为 CPU 根本没在跑</b>，屏幕上自然没有画面。你会以为是"VNC 配置也不对"，然后在两个无关的方向上继续浪费时间去试。<br><br><b>认知根源</b>：<b>用"换一个方案"代替"定位原因"。</b>换方案有时能碰巧绕过问题，但更多时候它只是把同一个问题换了个地方复现，还附赠一堆新的变量。<b>先定位，再替换。</b>'
          },
          n4: {
            label: '选D · 改 console 参数', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：内核连第一条指令都还没执行',
            result: '<b><span class="mono">console=</span> 参数要等内核解析命令行时才会生效</b>——而 <span class="mono">-S</span> 让 CPU 停在解析之前。<b>参数写成什么样都不会有任何区别，因为没有任何代码在运行。</b><br><br>顺带说清这两个值的区别，避免以后真踩坑：<span class="mono">console=ttyS0</span> 走向串口（配合 <span class="mono">-nographic</span> 才能在你终端里看到）；<span class="mono">console=tty0</span> 走向虚拟终端（需要图形显示或 <span class="mono">-vnc</span>）。<b>这两个参数各有用处，不是对错关系。</b><br><br><b>认知根源</b>：遇到"没有输出"就本能地把嫌疑锁定在"和输出有关的那个参数"上，而忽略了<b>更上游的、决定"代码有没有在跑"的那个开关</b>。调试要按执行顺序倒推：先确认 CPU 有没有在跑，再确认日志有没有地方去，最后才怀疑日志内容。<b>顺序错了，每一层都可能白查。</b>'
          }
        }
      }
    },
    /* ================= 15.8 检测点全景 ================= */
    {
      h: '15.8',
      title: '云手机检测点全景图：真机有什么，虚拟环境缺什么',
      html:
        '<p>前面七节讲的全是"下层"。现在换到风控 SDK 的位置——<b>EL0 的应用层</b>，看它能问出什么。</p>' +
        '<p>风控的检测逻辑可以用一句话概括：<b>它不是在证明"你在虚拟机里"，而是在统计"你有多少处不像真机"</b>。单看任何一项都可能是误报（有的真机确实没有陀螺仪），但<b>当十几项同时异常，判定就成立了</b>。所以下面这张表你要当成"扣分项清单"来读，而不是"必杀技清单"。</p>' +
        T.note('key', '🔑 检测的三个层次（这个分类比清单本身更重要）',
          '<p><b>① 存在性</b>——真机有这个硬件，虚拟环境<b>根本没有</b>。比如基带、真实传感器。<b>最难补</b>，因为要凭空造出硬件行为。<br>' +
          '<b>② 统计特征</b>——硬件"在"，但数值<b>不像真的</b>。比如电量永远 100%、光照值恒定、CPU 频率曲线完全对称。<b>最容易补</b>，加噪声和变化即可，但也最容易被忽略。<br>' +
          '<b>③ 标识一致性</b>——单个字段看起来都对，但<b>字段之间互相矛盾</b>，或<b>多个设备共享同一个标识</b>。比如 Build.MODEL 说是小米，GPU 却是 SwiftShader；或一万台"设备"的 Android ID 相同。<b>这是批量检测的杀手锏。</b></p>'),

      stage: {
        title: '检测点全景 · 展开每一项：真机 vs 虚拟环境 vs 怎么补',
        speed: 2000,
        render:
          '<div class="flow-row" style="flex-wrap:wrap;gap:6px">' +
            '<span class="blk" id="d1" style="font-size:12px">传感器</span>' +
            '<span class="blk" id="d2" style="font-size:12px">电池</span>' +
            '<span class="blk" id="d3" style="font-size:12px">CPU 信息</span>' +
            '<span class="blk" id="d4" style="font-size:12px">QEMU 痕迹</span>' +
            '<span class="blk" id="d5" style="font-size:12px">GPU 渲染器</span>' +
            '<span class="blk" id="d6" style="font-size:12px">网络信息</span>' +
            '<span class="blk" id="d7" style="font-size:12px">开机时长</span>' +
            '<span class="blk" id="d8" style="font-size:12px">硬件标识</span>' +
            '<span class="blk" id="d9" style="font-size:12px">基带短信</span>' +
            '<span class="blk" id="d10" style="font-size:12px">摄像头麦克风</span>' +
            '<span class="blk" id="d11" style="font-size:12px">进程与 maps</span>' +
            '<span class="blk" id="d12" style="font-size:12px">温度与性能</span>' +
          '</div>' +
          '<div class="card" id="dbox" style="margin-top:12px;min-height:150px">' +
            '<div class="card-title" id="dt">检测点全景</div>' +
            '<div id="db"><p class="muted">点击下方"下一步"逐项展开。每一项都会给出：真机的样子、虚拟环境通常的样子、以及怎么补。</p></div>' +
          '</div>' +
          '<div class="flow-row" style="margin-top:8px;gap:8px;flex-wrap:wrap">' +
            '<span class="pill" id="dp1">存在性：最难补</span>' +
            '<span class="pill acc" id="dp2">统计特征：最容易补</span>' +
            '<span class="pill" id="dp3">标识一致性：批量检测杀手</span>' +
          '</div>',
        reset: () => {
          for (let i = 1; i <= 12; i++) S('d' + i, '');
          SET('dt', '检测点全景');
          SET('db', '<p class="muted">点击下方"下一步"逐项展开。每一项都会给出：真机的样子、虚拟环境通常的样子、以及怎么补。</p>');
          CLS('dp1', 'pill'); SET('dp1', '存在性：最难补');
          CLS('dp2', 'pill acc'); SET('dp2', '统计特征：最容易补');
          CLS('dp3', 'pill'); SET('dp3', '标识一致性：批量检测杀手');
        },
        steps: [
          { run: () => { S('d1', 'hot'); SET('dt', '① 传感器（Sensor）'); SET('db', '<p><b>真机</b>：加速度计、陀螺仪、光线传感器、磁场传感器、接近传感器一应俱全，而且<b>数值一直在变</b>——你把手机放桌上，加速度计的 z 轴就稳定在 9.8 附近有微小抖动。</p><p><b>虚拟环境</b>：通常<b>没有传感器</b>，<span class="mono">getSensorList()</span> 返回空；或者硬塞几个假传感器，但<b>数值恒为 0、永不变化</b>。</p><p><span class="pill acc">怎么补</span> 注入<b>带合理噪声与变化</b>的伪造数据——不是恒定值！重力要有 9.8 基线加抖动；光线要随"时间"变化；摇晃手机时陀螺仪要有响应。<b>关键在"相关性"</b>：真机的传感器之间是物理耦合的。</p>'); }, note: '<b>传感器是存在性检测里最典型的一类。</b>真机的传感器不只是"有"，更是"一直在动"——重力有 9.8 基线加抖动。虚拟环境的空列表或恒定 0 值，一眼就能看出来。' },
          { run: () => { S('d1', 'done'); S('d2', 'hot'); SET('dt', '② 电池状态'); SET('db', '<p><b>真机</b>：电量缓慢下降，温度随负载浮动（玩游戏时升到 40℃+），插拔充电器时充电状态在 <span class="mono">AC</span>/<span class="mono">USB</span>/<span class="mono">DISCHARGING</span> 之间切换，电压有波动。</p><p><b>虚拟环境</b>：常返回<b>恒定值</b>——永远的 100%、固定温度、<span class="mono">AC</span> 状态永不改变、电压恒定。</p><p><span class="pill acc">怎么补</span> 模拟真实的放电曲线（非线性，低电量时掉得更快）、温度随 CPU 负载变化、定时触发充电状态切换。<b>注意时序</b>：如果 <span class="mono">EXTRA_LEVEL</span> 变了但 <span class="mono">EXTRA_TEMPERATURE</span> 纹丝不动，依然是破绽。</p>'); }, note: '<b>传感器是存在性检测里最典型的一类。</b>真机的传感器不只是"有"，更是"一直在动"——重力有 9.8 基线加抖动。虚拟环境的空列表或恒定 0 值，一眼就能看出来。' },
          { run: () => { S('d2', 'done'); S('d3', 'hot'); SET('dt', '③ CPU 信息（/proc/cpuinfo）'); SET('db', '<p><b>真机</b>：显示手机 SoC 型号（Qualcomm Snapdragon、MediaTek Dimensity、Kirin 等），核心频率各异（大小核），有厂商特定的实现细节。</p><p><b>虚拟环境</b>：可能显示<b>通用 x86 型号</b>而非手机 SoC；也可能暴露<b>虚拟化标志</b>（<span class="mono">flags</span> 里出现 hypervisor 相关标志）。<span class="pill warn">具体 flag 名称随内核版本与平台而异，待核实</span></p><p><span class="pill acc">怎么补</span> 在内核层重写 <span class="mono">/proc/cpuinfo</span> 的输出（这正是第 15.7 节编译内核的用武之地），并让 cpufreq 呈现大小核的不同频率曲线。</p>'); }, note: '<b>电池考的是统计特征。</b>真机电量缓慢下降、温度随负载浮动、充电状态会切换。恒定 100% 或固定温度是虚拟环境的招牌破绽，也是最好补的一项。' },
          { run: () => { S('d3', 'done'); S('d4', 'hot'); SET('dt', '④ QEMU / 模拟器特有痕迹'); SET('db', '<p><b>真机</b>：没有这些东西。</p><p><b>虚拟环境</b>：<b>设备文件</b> <span class="mono">/dev/qemu_pipe</span>、<span class="mono">/dev/goldfish_pipe</span>；<b>系统属性</b> <span class="mono">ro.kernel.qemu=1</span>、<span class="mono">ro.hardware=goldfish</span> 或 <span class="mono">ranchu</span>；特定进程名与驱动痕迹；<span class="mono">/proc/cmdline</span> 里的 <span class="mono">console=ttyS0</span>、<span class="mono">/dev/vda*</span>。</p><p><span class="pill acc">怎么补</span> 改系统属性、定制内核去掉 QEMU 设备节点、重命名块设备。<b>注意</b>：这类痕迹在 native 层也能读到，<b>只在 Java 层做 hook 会被绕过</b>。</p>'); }, note: '<b>CPU 信息来自 /proc/cpuinfo。</b>虚拟机的 CPU 型号不像手机 SoC，还可能暴露虚拟化标志。这一项要改就得动内核——正是 15.7 节的用武之地。' },
          { run: () => { S('d4', 'done'); S('d5', 'hot'); CLS('dp2', 'pill ok'); SET('dp2', '统计特征：最容易补，也最容易漏'); SET('dt', '⑤ GPU / 渲染器信息 ★'); SET('db', '<p><b>真机</b>：<span class="mono">GL_RENDERER</span> 是 GPU 厂商名——Adreno（高通）、Mali（ARM）、PowerVR、Apple GPU。</p><p><b>虚拟环境</b>：软件渲染会显示 <b><span class="mono">SwiftShader</span></b>、<span class="mono">llvmpipe</span>、<span class="mono">Google SwiftShader</span> 等。</p><p><span class="bad">这是非常强的模拟器特征</span>——因为它是<b>字符串直接暴露</b>，一条 <span class="mono">glGetString(GL_RENDERER)</span> 就能拿到，成本极低、区分度极高。</p><p><span class="pill acc">怎么补</span> 用硬件加速——GPU 直通（passthrough）或 <span class="mono">virtio-gpu</span> 配合宿主 GPU，让渲染器返回真实 GPU 名。</p>'); }, note: '<b>QEMU 痕迹是最直接的"自首"。</b>/dev/qemu_pipe、ro.kernel.qemu=1、/proc/cmdline 里的 console=ttyS0——成本极低、命中率极高，而且 native 层也能读到，只在 Java 层 hook 挡不住。' },
          { run: () => { S('d5', 'done'); S('d6', 'hot'); SET('dt', '⑥ 网络信息'); SET('db', '<p><b>真机</b>：MAC 地址是厂商 OUI；有 MCC/MNC（运营商代码）、SIM 卡状态、信号强度；WiFi 能扫到周边 BSSID/SSID；出口 IP 是运营商或家宽地址。</p><p><b>虚拟环境</b>：MAC 前缀可疑（QEMU 默认 <span class="mono">52:54:00</span>）；运营商信息缺失或固定；WiFi 扫描结果为空或恒定；<b>出口 IP 是数据中心 IP 段</b>，会被风控直接标记。</p><p><span class="pill acc">怎么补</span> 指定符合真机厂商的 MAC OUI；伪造完整的运营商信息；伪造 WiFi 扫描结果（对应第 18 章的"虚拟 WiFi"技术）；<b>最关键的是出口 IP——必须走代理，优先住宅代理而非机房代理</b>。</p>'); }, note: '<b>GPU 渲染器是性价比最高的检测点。</b>一条 glGetString 就能拿到，而 SwiftShader / llvmpipe 与真机的 Adreno / Mali 完全不重叠。补法只有一条：让渲染真的走 GPU。' },
          { run: () => { S('d6', 'done'); S('d7', 'hot'); SET('dt', '⑦ 开机时间与运行时长'); SET('db', '<p><b>真机</b>：<span class="mono">SystemClock.elapsedRealtime()</span>（含休眠的开机时长）、<span class="mono">uptimeMillis()</span>（不含休眠）、<span class="mono">currentTimeMillis()</span>（墙上时间）三者之间<b>存在合理的换算关系</b>。用户手机一般已经开了几小时到几天。</p><p><b>虚拟环境</b>：云手机常被<b>反复重置</b>，开机时间异常短（几十秒）；或者三个时间源<b>互相矛盾</b>（比如墙上时间被改成三个月前，但开机时长只有 30 秒）。</p><p><span class="pill acc">怎么补</span> 让开机时长落在合理区间，并保证三种时间源的一致性；注意<b>不要每次启动都归零</b>。</p>'); }, note: '<b>网络把两类检测揉在一起。</b>MAC OUI、运营商信息、WiFi 扫描属于设备特征；出口 IP 属于基础设施特征——后者最难补，必须走代理。' },
          { run: () => { S('d7', 'done'); S('d8', 'hot'); CLS('dp3', 'pill bad'); SET('dp3', '标识一致性：批量检测的杀手锏'); SET('dt', '⑧ 硬件标识 ★★'); SET('db', '<p><b>真机</b>：<span class="mono">Build.FINGERPRINT</span>、<span class="mono">Build.MODEL</span>、<span class="mono">Build.MANUFACTURER</span>、IMEI、Android ID、序列号——<b>每个设备都是独立且自洽的一整套</b>。</p><p><b>虚拟环境</b>：常用<b>固定的伪造值</b>，于是<b>多个"设备"共享同一个标识</b>。</p><p><span class="bad">这是批量检测的关键</span>：风控不需要证明某台是云手机，它只要发现<b>一万个账号来自同一台"手机"</b>，就足以判定为批量行为。<b>单台伪装得再像，标识复用一样会被抓。</b></p><p><span class="pill acc">怎么补</span> 每个"设备"分配<b>独立且合理</b>的一整套标识，并且各字段之间要自洽（型号、厂商、指纹、GPU、CPU 得对得上）。</p>'); }, note: '<b>开机时长考的是"时间自洽性"。</b>云手机常被反复重置，开机时间异常短；更隐蔽的破绽是三种时间源互相矛盾。真机一般已经开了几小时到几天。' },
          { run: () => { S('d8', 'done'); S('d9', 'hot'); CLS('dp1', 'pill bad'); SET('dp1', '存在性：最难补的一类'); SET('dt', '⑨ 通话与短信能力'); SET('db', '<p><b>真机</b>：有基带，能打电话、发短信、读 SIM 卡状态、拿到信号强度与运营商名称。</p><p><b>虚拟环境</b>：<b>没有基带</b>。<span class="mono">TelephonyManager</span> 相关字段要么缺失，要么返回固定假值。云手机即使伪造了 MCC/MNC，也<b>无法真的收短信、无法真的有信号强度变化</b>。</p><p><span class="pill acc">怎么补</span> 在系统层伪造完整的 <span class="mono">TelephonyManager</span> 行为，包括信号强度的自然波动。<b>但注意</b>：如果风控做的是<b>主动验证</b>（真的发一条短信、真的拨一个号码），伪造就无法过关——这属于"存在性"检测的硬边界。</p>'); }, note: '<b>标识一致性是批量检测的杀手锏。</b>单台伪装得再像，只要一万台共享同一个 Android ID 或序列号，风控一次聚合查询就全部揪出来。这是本章最重要的一条。' },
          { run: () => { S('d9', 'done'); S('d10', 'hot'); SET('dt', '⑩ 摄像头与麦克风'); SET('db', '<p><b>真机</b>：真实的摄像头模组与麦克风阵列，能拍到实际画面、录到环境噪声，不同设备拍出的画面有不同的传感器噪声特征。</p><p><b>虚拟环境</b>：通常<b>没有真实硬件</b>，或返回固定的测试画面（虚拟摄像头），音频常是静音或固定音源。</p><p><span class="pill acc">怎么补</span> 接入虚拟摄像头（如 v4l2loopback 类的方案）提供合理画面；音频注入带底噪的音频流。<b>难点</b>：画面要"有内容且每次不同"，固定图片反而更容易被抓。</p>'); }, note: '<b>基带是存在性的硬边界。</b>你可以伪造 TelephonyManager 的返回值，但挡不住风控真的发一条短信、真的拨一个号码。这一类补不干净。' },
          { run: () => { S('d10', 'done'); S('d11', 'hot'); SET('dt', '⑪ /proc/self/maps 与进程列表'); SET('db', '<p><b>真机</b>：进程列表是正常的 Android 系统进程 + 用户 App。<span class="mono">/proc/self/maps</span> 里是正常的系统库与 App 库。</p><p><b>虚拟环境</b>：可能暴露<b>虚拟化相关的库或进程</b>；注入的伪装模块本身也会在 maps 里留下痕迹（比如某些 hook 框架的库名）；异常的设备节点映射。</p><p><span class="pill acc">怎么补</span> 隐藏伪装模块自身的痕迹（这是 hook 框架对抗的老问题），并确保 maps 与进程列表符合真机分布。<b>注意</b>：native 层可以直接读 <span class="mono">/proc/self/maps</span>，绕过 Java 层。</p>'); }, note: '<b>摄像头与麦克风同理。</b>固定测试画面比"没有摄像头"更容易被抓——因为画面要"有内容且每次不同"才像真的。' },
          { run: () => { S('d11', 'done'); S('d12', 'hot'); SET('dt', '⑫ 温度与性能特征'); SET('db', '<p><b>真机</b>：有<b>热节流</b>——长时间高负载后 CPU 降频、跑分下降、机身温度上升。性能曲线是"先高后降"。</p><p><b>虚拟环境</b>：可能<b>永不降频</b>（因为虚拟 CPU 共享宿主资源，没有真实的功耗墙），或者性能曲线异常平坦/异常抖动（受宿主机其他实例干扰）。</p><p><span class="pill acc">怎么补</span> 模拟热节流曲线——持续高负载后主动降频，并让温度读数同步上升。<b>这条容易被忽略</b>，但跑分型检测会专门看它。</p>'); }, note: '<b>这一项有个反身性陷阱。</b>你用来伪装的模块本身会在 /proc/self/maps 里留下痕迹——这是所有 hook 框架的共同难题，而且 native 层可直接绕过 Java 层。' },
          { run: () => { S('d12', 'done'); CLS('dp1', 'pill'); SET('dp1', '存在性：基带 / 传感器 / 摄像头'); CLS('dp2', 'pill acc'); SET('dp2', '统计特征：数值不像真的'); CLS('dp3', 'pill bad'); SET('dp3', '标识一致性：多设备共享同一身份'); SET('dt', '全景总结'); SET('db', '<p><b>把十二项按"好不好补"排个序，就是对抗工作的优先级：</b></p><p><b>最容易补（先做）</b>：GPU 渲染器、系统属性、MAC OUI、<span class="mono">/proc/cmdline</span>、开机时长——改配置或改值就行。<br><b>中等（要做）</b>：传感器数据、电池曲线、CPU 信息、温度节流——需要写代码模拟<b>带相关性的动态行为</b>。<br><b>最难（但最能救命）</b>：设备标识随机化、基带能力、摄像头内容、出口 IP——涉及系统层改造与外部资源（代理）。</p><p><span class="pill warn">核心认知</span> <b>这是持续的军备竞赛。</b>检测方不断找新特征，云手机方不断补齐。所以理解<b>原理</b>（而不是背特征列表）才是关键——<b>知道"真机有什么、虚拟环境缺什么"，你就能推导出检测点，也能推导出该怎么补。</b></p>'); }, note: '<b>把十二项按"好不好补"排出优先级，就是对抗工作的施工顺序。</b>先补配置层的廉价项，再做模拟层的动态行为，最后才是系统层改造与外部资源。但无论怎么补，这始终是一场军备竞赛——<b>清单会过期，从分层模型和物理约束推导检测点的能力不会。</b>' }
        ]
      },
    },

    /* ================= 15.8L 动手实验 ================= */
    {
      h: '15.8L', title: '动手实验：读一份环境快照，找出破绽',
      html:
        '<p>检测点清单背下来没用——真正要练的是<b>看到一堆字段，一眼扫出互相矛盾的地方</b>。' +
        '下面这个实验给你一份"设备快照"，你来当风控。</p>',
      lab: {
        title: '实验：环境快照的一致性审计',
        goal: '目标：找出字段间的矛盾',
        intro:
          '<p>这是一台云手机上报的<b>设备快照</b>（模拟真实场景，纯属虚构）：</p>' +
          '<div class="tbl-wrap" style="margin:12px 0"><table class="tbl"><tbody>' +
          '<tr><td><code>Build.MANUFACTURER</code></td><td>Xiaomi</td></tr>' +
          '<tr><td><code>Build.MODEL</code></td><td>Redmi K60</td></tr>' +
          '<tr><td><code>ro.product.cpu.abi</code></td><td>arm64-v8a</td></tr>' +
          '<tr><td><code>/proc/cpuinfo</code> 型号</td><td><b>Intel(R) Xeon(R) Platinum 8269CY @ 2.50GHz</b></td></tr>' +
          '<tr><td><code>GL_RENDERER</code></td><td><b>Google SwiftShader</b></td></tr>' +
          '<tr><td>传感器列表</td><td><b>（空）</b></td></tr>' +
          '<tr><td>电池电量 / 温度</td><td>100% / 25.0℃（连续 8 小时不变）</td></tr>' +
          '<tr><td>MAC 地址</td><td><b>52:54:00:12:34:56</b></td></tr>' +
          '<tr><td><code>SystemClock.elapsedRealtime()</code></td><td>42,000 ms（42 秒）</td></tr>' +
          '<tr><td><code>/proc/cmdline</code></td><td>… <b>androidboot.hardware=ranchu</b> …</td></tr>' +
          '<tr><td>运营商 / MCC-MNC</td><td><b>（无 SIM 卡）</b></td></tr>' +
          '<tr><td>出口 IP 归属</td><td>某云服务商数据中心段</td></tr>' +
          '</tbody></table></div>' +
          '<p><b>任务：找出至少 4 处破绽，并说出每一处属于哪一类（存在性 / 统计特征 / 标识一致性）。</b></p>',
        inputs: [
          { key: 'count', label: '① 你找到了几处破绽？（填数字）', hint: '表里至少埋了 7 处', ph: '例如 5' },
          { key: 'worst', label: '② 哪一处最难靠"改返回值"补上？为什么？',
            hint: '想想哪些需要真实硬件或外部资源', ph: '我认为是……因为……', type: 'textarea', rows: 2 }
        ],
        runLabel: '🔍 对照审计结果',
        run: (v) => {
          const items = [
            { f: 'CPU 型号 = Intel Xeon', cat: '标识一致性',
              why: 'Build.MODEL 说是 Redmi K60（ARM 手机），CPU 却是 Intel 服务器芯片 —— <b>两个字段直接矛盾</b>。' +
                   '而且 <code>ro.product.cpu.abi</code> 自称 arm64-v8a，更说明 cpuinfo 是假的。' },
            { f: 'GL_RENDERER = Google SwiftShader', cat: '存在性',
              why: 'SwiftShader 是<b>软件渲染器</b>，意味着没有可用 GPU 硬件。真机一定是 Adreno / Mali / PowerVR。' +
                   '这一项<b>改字符串会被实际渲染行为戳穿</b>，必须真上 GPU 加速。' },
            { f: '传感器列表为空', cat: '存在性',
              why: '真机必有加速度计、陀螺仪等。没有任何传感器 = 不是手机。' +
                   '注意：补的时候要有<b>合理噪声与变化</b>，恒定值同样会被识破。' },
            { f: '电池 100% / 25.0℃ 连续 8 小时不变', cat: '统计特征',
              why: '真机的电量会降、温度会随负载变化。连续 8 小时完全不变是<b>统计上的不可能</b>。' },
            { f: 'MAC = 52:54:00:…', cat: '标识一致性',
              why: '<code>52:54:00</code> 是 <b>QEMU 虚拟网卡的固定 OUI 前缀</b>，一个非常经典的特征。' },
            { f: '开机 42 秒', cat: '统计特征',
              why: '云手机常被反复重置，开机时长异常短。真机用户上报时通常已运行数小时以上。' +
                   '（单独看不致命，但配合其他项就是佐证。）' },
            { f: 'androidboot.hardware=ranchu', cat: '存在性',
              why: '<code>ranchu</code> 是 <b>Android 模拟器的虚拟硬件名</b>（旧版是 goldfish）。' +
                   '直接暴露在 <code>/proc/cmdline</code> 里，属于"盖章承认自己是模拟器"。' },
            { f: '无 SIM 卡 / 无 MCC-MNC', cat: '存在性',
              why: '真机通常有 SIM。没有基带是虚拟环境的典型特征。' +
                   '（但也要注意：真机也可能没插卡，所以这条<b>单独看区分度不够</b>。）' },
            { f: '出口 IP 属数据中心段', cat: '标识一致性',
              why: '住宅宽带 IP 与云服务商 IP 段在公开的 IP 归属库里可查。' +
                   '这条<b>最难补</b>——需要在外部资源层面解决，不是改代码能搞定的。' }
          ];

          let html = '<div class="lab-kv"><span>埋设破绽 <b>' + items.length + '</b> 处</span>'
            + '<span>存在性 <b>' + items.filter(x => x.cat === '存在性').length + '</b></span>'
            + '<span>统计特征 <b>' + items.filter(x => x.cat === '统计特征').length + '</b></span>'
            + '<span>标识一致性 <b>' + items.filter(x => x.cat === '标识一致性').length + '</b></span></div>';

          html += '<table class="lab-tbl"><tr><th>#</th><th>破绽</th><th>类别</th><th>为什么是破绽</th></tr>';
          items.forEach((it, i) => {
            html += '<tr class="diff"><td>' + (i + 1) + '</td><td><b>' + it.f + '</b></td>'
              + '<td>' + it.cat + '</td><td style="font-size:12px">' + it.why + '</td></tr>';
          });
          html += '</table>';

          const ans = parseInt(String(v.count || '').trim(), 10);
          if (!isNaN(ans)) {
            const ok = ans >= 4;
            html += '<div class="lab-msg ' + (ok ? 'pass' : 'warn') + '"><b>'
              + (ok ? '✅ 找到了 ' + ans + ' 处，达标' : '🟡 只找到 ' + ans + ' 处，再看看') + '</b>'
              + '<div class="lab-note">' + (ok
                  ? '能扫出 4 处以上，说明你已经建立了"交叉验证"的直觉。'
                  : '提示：不要只盯着"值对不对"，要盯<b>字段之间矛不矛盾</b>。' +
                    '比如 Build.MODEL 和 CPU 型号是不是同一类设备。')
              + '</div></div>';
          }

          const worst = String(v.worst || '').trim();
          if (worst) {
            const hitIP = window.AKKC_hasConcept(worst, ['ip', '出口', '代理', '数据中心', '住宅', '网络']);
            const hitGPU = window.AKKC_hasConcept(worst, ['gpu', '渲染', 'swiftshader', '图形', '硬件加速']);
            const hitSensor = window.AKKC_hasConcept(worst, ['传感器', 'sensor', '摄像头', '基带']);
            if (hitIP) {
              html += '<div class="lab-msg pass"><b>✅ 好答案：出口 IP</b><div class="lab-note">' +
                '出口 IP 是<b>外部资源问题</b>，不在你的系统里。<br>' +
                '真要换，得用<b>住宅代理</b>（住宅宽带 IP），成本高、还不稳定。' +
                '这属于"再怎么写代码也解决不了"的那一类。<br>' +
                '对比：GPU 渲染器虽然难，但<b>把渲染真的落到 GPU 上</b>（GPU 直通 / virtio-gpu）就能解决，' +
                '属于工程问题而非资源问题。</div></div>';
            } else if (hitGPU) {
              html += '<div class="lab-msg pass"><b>✅ 有道理：GPU 渲染器确实很难"伪造"</b><div class="lab-note">' +
                '因为改字符串会被后续的实际渲染行为戳穿 —— 你得真的让渲染走 GPU。<br>' +
                '不过从"能不能靠自己解决"的角度看，<b>出口 IP 更难</b>：' +
                'GPU 是工程问题（加硬件加速），IP 是资源问题（得买住宅代理）。</div></div>';
            } else if (hitSensor) {
              html += '<div class="lab-msg warn"><b>🟡 传感器确实不好补，但还有更难的</b><div class="lab-note">' +
                '传感器要模拟出<b>带相关性、带噪声的动态数据</b>（不是恒定值），工作量不小但可做。<br>' +
                '比它更难的是<b>出口 IP</b> —— 那不在你的系统里，属于外部资源。</div></div>';
            } else {
              html += '<div class="lab-msg warn"><b>🟡 换个角度想</b><div class="lab-note">' +
                '问的是"最难靠<b>改返回值</b>补上"。两个方向：<br>' +
                '① 需要<b>真实硬件</b>才能自洽的（GPU 渲染器）<br>' +
                '② 根本<b>不在你的系统里</b>的（出口 IP 归属）<br>' +
                '后者更难，因为再多代码也改不了别人数据库里的 IP 归属记录。</div></div>';
            }
          }
          return html;
        },
        expected: (v) => {
          const ans = parseInt(String(v.count || '').trim(), 10);
          const ok = !isNaN(ans) && ans >= 4;
          return {
            ok,
            detail: ok
              ? '<b>达标（≥4 处）。</b>比数量更重要的是你用的方法：' +
                '<b>不是逐个字段问"这个值对不对"，而是问"这些字段之间互相矛盾吗"。</b><br>' +
                '前者只能抓明显的假值，后者能抓住精心伪造里的破绽 —— 比如把 MODEL 改成了 Redmi，' +
                '却忘了 CPU 型号还写着 Intel。'
              : '<b>数量不足。</b>表里一共埋了 9 处破绽。<br>' +
                '建议按三类逐个扫：<br>' +
                '• <b>存在性</b>：真机一定有的东西，这里有没有？（传感器、GPU、SIM）<br>' +
                '• <b>统计特征</b>：数值像不像真实物理世界的？（电池恒定、开机 42 秒）<br>' +
                '• <b>标识一致性</b>：字段之间对得上吗？（MODEL 说小米，CPU 是 Intel；MAC 是 QEMU 前缀）'
          };
        },
        showAnswer:
          '共埋了 9 处破绽，按三类分：\n\n' +
          '【存在性】真机必有而这里没有/不对\n' +
          '  1. GL_RENDERER = Google SwiftShader（软件渲染，无 GPU 硬件）\n' +
          '  2. 传感器列表为空\n' +
          '  3. androidboot.hardware=ranchu（模拟器虚拟硬件名）\n' +
          '  4. 无 SIM 卡 / 无 MCC-MNC（无基带）\n\n' +
          '【统计特征】数值不符合物理规律\n' +
          '  5. 电池 100% / 25.0℃ 连续 8 小时不变\n' +
          '  6. 开机仅 42 秒\n\n' +
          '【标识一致性】字段之间互相矛盾\n' +
          '  7. CPU 是 Intel Xeon，但 MODEL 是 Redmi K60（ARM 手机）\n' +
          '  8. MAC = 52:54:00:… （QEMU 固定 OUI 前缀）\n' +
          '  9. 出口 IP 属数据中心段\n\n' +
          '─────────────────────────\n' +
          '最难靠"改返回值"补的一处：【出口 IP 归属】\n' +
          '  原因：它不在你的系统里，而在外部数据库里。\n' +
          '        再多代码也改不了别人对 IP 段的标注。\n' +
          '        只能靠住宅代理（成本高、稳定性差）。\n\n' +
          '  次难：GPU 渲染器 —— 改字符串会被实际渲染行为戳穿，\n' +
          '        必须真正把渲染落到 GPU（GPU 直通 / virtio-gpu）。\n' +
          '        但这属于工程问题，比"资源问题"好解决。',
        hint:
          '不要逐个问"这个值对不对"——那样只能抓明显的假值。<br>' +
          '要问<b>"这些字段之间互相矛盾吗"</b>。比如：<br>' +
          '• Build.MODEL 说的是什么品牌的什么设备？<br>' +
          '• 那它的 CPU 应该是什么？<br>' +
          '• 两者对得上吗？<br><br>' +
          '另外记得查两个容易忽略的地方：MAC 地址前缀、<code>/proc/cmdline</code>。',
        after:
          T.note('key', '🔑 这个实验训练的是"交叉验证"思维',
            '<p style="margin-bottom:0">风控检测的最高级形态不是"查某个值对不对"，' +
            '而是<b>看字段之间是否自洽</b>。<br>' +
            '原因很简单：<b>改一个字段容易，改一整套互相印证的字段难。</b><br><br>' +
            '把 MODEL 改成 Redmi K60 是一行代码；' +
            '但要同时让 CPU 型号、GPU 渲染器、传感器列表、基带信息、MAC 前缀、开机时长……' +
            '全部自洽，就是系统级工程了。<br>' +
            '<span class="hit">这与你学到的方法论是一回事：' +
            '<b>找矛盾点，比逐个验证更高效。</b></span></p>')
      }
    },

    /* ================= 15.9C 实战案例 ================= */
    {
      h: '15.9C', title: '实战案例：paytm 商业 RASP 的环境检测与反制',
      case: {
        source: 'kanxue',
        title: '[原创]paytm 商业 RASP Bugsmirror Defender 环境检测分析',
        date: '2026-9-6',
        author: '小七烤地瓜',
        target: 'paytm（印度支付 App）· 商业 RASP Bugsmirror Defender，载体库 libcachehandler.so',
        background:
          '<p>2026 年 9 月的一篇看雪原创帖。目标是把环境检测做成产品来卖的商业 RASP —— ' +
          '<b>Bugsmirror Defender</b>，在 paytm（印度支付 App）里的载体库是 <code>libcachehandler.so</code>，' +
          '库里的特征串是 <code>BugsmirrorDefenderValidation</code> 和 <code>com.bugsmirror.samplekeyattestation</code>。</p>' +
          '<p>分析环境是 <b>AArch64 + IDA + Frida Gadget</b>。商业 RASP 和自研检测最大的区别是：' +
          '它有<b>编号化的检测码体系</b>（61007 / 61009 / 10002 / 10004 / 00000）、有<b>统一的上报汇聚点</b>、' +
          '还有<b>专门用来抓"伪造模块"的反制逻辑</b>。</p>' +
          '<p>这篇帖子最值得读的地方，是它把「你伪装得像不像」这件事，从"查字段、查文件"推进到了' +
          '<b>"用密码学证明你这台设备是不是真的"</b>。</p>',
        points: [
          '关键函数偏移（设备版）：<code>sub_14D5E0</code> 是上报汇聚点 <code>handle_security_violation(ctx, code, sev, a3, a4, ist)</code>；<code>sub_DF838(id)</code> 是结果读取器（读全局结果位表）。',
          'keystore attestation 校验在 <code>sub_143BB4</code> / <code>sub_11DEE8</code>（对应 <b>IST31</b>）；<code>check_android_keystore_integrity_trap</code> 是 <b>IST34</b> 的 echo-trap 本体；<code>check_su_in_system_image</code> 是 <b>IST34</b> 的上报判定点；<code>sub_14BDA8</code> 是运行期字符串解码器。',
          '检测码 <code>61007</code>：AndroidKeyStore 密钥认证链真伪，细分位为 <code>61007-IST1</code> … <code>61007-IST34</code>。',
          '检测码 <code>61009</code>：已装应用黑名单，<b>共 77 项</b>（例如 <code>bin.mt.plus</code>，即 MT 管理器）。',
          '检测码 <code>10002</code>：<code>CA compromised by proxy tool:</code> —— 抓包 / 中间人代理的 CA 检测。',
          '检测码 <code>10004</code>：通过 <code>popen</code> 执行 shell 命令做环境探测；<code>00000</code>：<code>Device environment is not correct.</code> 兜底码。',
          '<b>IST31 的完整流程</b>：<code>hasSystemFeature("android.hardware.strongbox_keystore")</code> → <code>setIsStrongBoxBacked(true)</code> → 用 <code>KeyPairGenerator</code> <b>现场生成</b>一把带 attestation 的 key → <code>getCertificateChain</code> → <b>逐级 <code>cert.verify(上一级公钥)</code></b> → <code>checkValidity()</code> → <b>比对链上证书的公钥 / 序列号 / IssuerDN 与内嵌 pin</b>。',
          '<b>IST34 echo-trap</b>：内嵌一把 PKCS#8 EC 私钥 + 自签证书（CN = <code>EchoTrapStatic</code>）→ 经 <b>WolfSSL</b> 解 DER → <code>keyStore.setKeyEntry("echo_trap_key", ...)</code> → <code>getCertificateChain</code> → <code>deleteEntry</code> → <b>逐字节比对</b>（长度不等或 <code>memcmp</code> 不等即判篡改）。',
          '比对之前先 <code>setAttestationChallenge("trap_bait")</code> 生成诱饵 —— <b>诱饵的存在是为了把伪造模块钓出来</b>。',
          'IST34 有三道门槛同时满足才跑：<code>byte_15FCDB</code> 单次守卫 / SDK 门槛 / <code>sub_EA95C(1004) &amp; 1</code> 必须已为真 ⇒ <b>IST34 是 IST31 的"二次确认"</b>。',
          '<b>关键突破</b>：<code>hasSystemFeature(strongbox) = true</code> 时会跑链校验，伪造的链会被逮住、报 <code>61007</code>；若让 StrongBox 请求失败、抛 <code>StrongBoxUnavailableException</code>，则报 <code>00000</code>；而 <b><code>hasSystemFeature(strongbox) = false</code> 时整条强完整性检查被跳过 —— 既没有 61007，也没有 00000</b>。',
          '已验证的绕过：hook 改机、魔改 ts、免解锁 root 提权三种方式全部三绿转发；运行期 hook 让 <code>sub_EA95C</code> 对 <code>id == 1004</code> 返回 0。',
          '<b>核心洞察</b>：IST31 与 IST34 的上报同归 category <code>1004</code>，但原理互补 —— 一个从<b>密码学正确性</b>下手，一个从 <b>keystore hook 的副作用</b>下手；<b>凡是粗暴全局替换 <code>getCertificateChain</code> 返回值的伪造模块，两条都躲不掉</b>。'
        ],
        method: [
          '先用特征串定位商业 RASP：<code>BugsmirrorDefenderValidation</code> / <code>com.bugsmirror.samplekeyattestation</code> 是这套 RASP 在 <code>libcachehandler.so</code> 里的自我标识。',
          '顺着上报路径找到汇聚点：<code>sub_14D5E0</code> = <code>handle_security_violation(ctx, code, sev, a3, a4, ist)</code>，结果读取器 <code>sub_DF838(id)</code> 读全局结果位表 —— <b>所有检测最终都汇到这一处，这是最高性价比的观察点</b>。',
          '整理检测码体系，把检测点分类：<code>61007</code>（KeyStore 认证链）、<code>61009</code>（77 项应用黑名单）、<code>10002</code>（代理 CA）、<code>10004</code>（<code>popen</code> shell 探测）、<code>00000</code>（兜底）。',
          '拆 <b>IST31</b>：<code>hasSystemFeature("android.hardware.strongbox_keystore")</code> → <code>setIsStrongBoxBacked(true)</code> → 现场生成带 attestation 的 key → <code>getCertificateChain</code> → <b>逐级 <code>cert.verify(上一级公钥)</code></b> → <code>checkValidity()</code> → 与内嵌 pin 比对。',
          '拆 <b>IST34</b>（echo-trap）：内嵌 PKCS#8 EC 私钥 + 自签证书（CN = <code>EchoTrapStatic</code>）→ WolfSSL 解 DER → <code>setKeyEntry("echo_trap_key", ...)</code> → <code>getCertificateChain</code> → <code>deleteEntry</code> → <b>逐字节 <code>memcmp</code></b>；动手前先 <code>setAttestationChallenge("trap_bait")</code> 下诱饵。',
          '确认 IST34 的触发条件：<code>byte_15FCDB</code> 单次守卫 + SDK 门槛 + <code>sub_EA95C(1004) &amp; 1</code> 已为真 —— 即 <b>IST34 只在 IST31 已经报过之后才补刀</b>。',
          '做对照实验找绕过点：分别构造 strongbox = true / 请求失败 / strongbox = false 三种情况，观察上报码的差异。',
          '在 <code>hasSystemFeature</code> 这一层收口：<b>让 strongbox 特性返回 false，整条强完整性检查链被跳过</b>；同时运行期 hook 让 <code>sub_EA95C</code> 对 <code>id == 1004</code> 返回 0。',
          '验证：hook 改机、魔改 ts、免解锁 root 提权三种场景均三绿转发。'
        ],
        result:
          '<p>三种已验证的绕过方式（<b>hook 改机、魔改 ts、免解锁 root 提权</b>）都做到了三绿转发；' +
          '运行期再 hook 让 <code>sub_EA95C</code> 对 <code>id == 1004</code> 返回 0，把 category 1004 这一类的上报整条掐掉。</p>' +
          '<p>更关键的是找到了那个<b>特性开关级的绕过点</b>：<code>hasSystemFeature("android.hardware.strongbox_keystore")</code> 返回 <b>false</b> 时，' +
          '整条强完整性检查直接被跳过 —— <b>既不会报 61007，也不会报 00000</b>。</p>',
        terms: ['RASP', 'Bugsmirror Defender', 'AndroidKeyStore Attestation', 'StrongBox', 'setIsStrongBoxBacked', 'getCertificateChain', 'WolfSSL', 'PKCS#8', 'echo-trap', 'memcmp', 'popen', 'Frida Gadget'],
        limits:
          '<p>这篇帖子有几处<b>口径与完整性问题必须如实标注</b>，否则照抄会踩坑：</p>' +
          '<p>① <b>偏移口径不一致</b>：IST34 那一小节取自<b>解密重建版</b>，用的是结果读取器 <code>sub_EA95C</code>；' +
          '而设备版 <code>libcachehandler.so_fixed</code> 用的是 <code>sub_DF838</code> —— <b>两套地址体系不同，不能混用</b>。</p>' +
          '<p>② 第四节的绕过方法<b>只列了名称</b>（hook 改机 / 魔改 ts / 免解锁 root 提权），<b>没有给脚本、命令或复现证据</b>。</p>' +
          '<p>③ <code>61009</code> 那份 <b>77 项黑名单的具体内容</b>、以及 <code>10004</code> 执行的具体 shell 命令，<b>帖子都没有列出</b>。</p>' +
          '<p>④ 正文之后有<b>门控</b>，其后隐藏的内容未能获取。</p>',
        analysis:
          '<p><b>本课第 15 章讲的是「真机有什么、虚拟环境缺什么」；这个案例是它的反方向应用 —— ' +
          '它讲的是「怎么检测你伪装得像不像」。</b>' +
          '站在检测方看一遍，你会比站在伪装方看十遍更懂这套分层模型：<b>因为检测方必须沿着同样的"真机 vs 虚拟环境"的差异去找证据，只是目标相反。</b></p>' +
          '<p><b>第一，交叉验证能做到什么程度：attestation 链校验不是查"有没有 key"，而是查"这条链能不能用 Google 的私钥验通"。</b>' +
          'IST31 的流程是一路往上验：<code>getCertificateChain</code> 拿到证书链之后，' +
          '<b>逐级 <code>cert.verify(上一级公钥)</code></b>，再 <code>checkValidity()</code>，最后还要把链上证书的<b>公钥、序列号、IssuerDN 与内嵌的 pin 比对</b>。' +
          '这意味着什么？<b>这不是"改个返回值"能糊过去的检查 —— 证书链要真的验证通过，你需要 Google 的私钥。</b>' +
          '这正是本章 15.8 实验里那个"交叉验证"思路的密码学版本：<b>实验里考的是"字段之间自不自洽"，这里考的是"签名链能不能验通"。</b>' +
          '而它比字段自洽更狠的地方在于：<b>字段可以被伪造得自洽，密码学签名不能。</b>' +
          '<span class="hit">改一个字段容易，改一整套互相印证的字段难；而伪造一条验得通的证书链，比这两者都难得多。</span>' +
          '这也解释了为什么 15.9 讲的"检测成本/区分度"在这里被拉满：检测方付出的只是一次本地验签，却拿到了<b>不可伪造的证据</b>。</p>' +
          '<p><b>第二，「检测 hook 本身」是一种反制思路，IST34 的 echo-trap 就是专门抓伪造模块的。</b>' +
          '它的设计非常刁：<b>主动把一把自己知道内容的 EC 私钥和自签证书塞进 KeyStore</b>（CN = <code>EchoTrapStatic</code>），' +
          '再读回来逐字节 <code>memcmp</code> —— 只要长度不等或者内容不等，就说明<b>中间有人替换了 <code>getCertificateChain</code> 的返回值</b>。' +
          '更妙的是 <code>setAttestationChallenge("trap_bait")</code> 这个诱饵：<b>它给那些"看到 challenge 就按套路伪造 attestation"的模块准备了一个钩子</b>，' +
          '你越积极地伪造，越容易在这里暴露。' +
          '这跟第 10 章「检测 Frida 的副作用」完全是同一思路的不同应用：' +
          '<b>不去正面检查"有没有 hook 框架"，而是检查"hook 之后系统行为有没有变得不正常"。</b>' +
          'hook 可以隐藏自己的名字，却很难隐藏自己<b>改变了别人的行为</b>这件事。' +
          'IST31 与 IST34 的互补也正是这个道理：<b>一个从密码学正确性下手，一个从 keystore hook 的副作用下手 —— ' +
          '暴力全局替换 <code>getCertificateChain</code> 的模块，两条都躲不掉。</b></p>' +
          '<p><b>第三，最干净的绕过点，往往在一个"特性开关"上。</b>' +
          '这个案例里最有价值的一步不是拆懂了 IST31 或 IST34，而是一组对照实验的结论：' +
          '<code>strongbox = true</code> 时跑链校验、伪造链被逮报 <code>61007</code>；' +
          '让 StrongBox 请求失败抛 <code>StrongBoxUnavailableException</code>，又会被兜底码 <code>00000</code> 接住；' +
          '而 <b><code>hasSystemFeature("android.hardware.strongbox_keystore") = false</code> 时，整条强完整性检查直接被跳过，两个码都不报</b>。' +
          '<b>问题的关键在于：这条检查链"要不要跑"，本身是一个可以被影响的判断。</b>' +
          '在检查逻辑内部硬碰（去伪造证书链、去 patch <code>memcmp</code>）是在跟密码学对赌；' +
          '而把 strongbox 特性关掉，是让<b>整段检查根本不被执行</b>。' +
          '<b>往上找"决定要不要做这件事"的判断，而不是在检查逻辑内部硬碰</b> —— 这与第 10 章「抢时序、找最小充分改动点」是同一种性价比思维：' +
          '<b>改动越小、位置越靠上，越不容易触发对方设计的反制。</b></p>' +
          '<p>最后，这个案例也印证了本章结尾那句话：<b>理解原理比背特征表重要。</b>' +
          '特征表会让你去背 <code>BugsmirrorDefenderValidation</code> 这个字符串 —— 但 RASP 一升级它就过期了；' +
          '而理解"真机有不可伪造的硬件密钥、虚拟环境没有"这条物理约束，你就能推导出 attestation 这类检测点，' +
          '<b>也能反过来推导出：绕过它的关键不在于伪造得更好，而在于让这个问题不被提出。</b></p>',
        link: 'https://bbs.kanxue.com/thread-292873.htm',
        linkNote: '看雪论坛原创帖'
      }
    },

    /* ================= 15.9 ================= */
    {
      h: '15.9', title: '自测：检测点的性价比',
      quiz: {
        id: 'q15-1', chapter: 15, answer: 2,
        stem: '某风控 SDK 只做了一项检查：调用 <code>glGetString(GL_RENDERER)</code>，发现返回 <code>Google SwiftShader</code>，随即判定该设备为模拟器。这个判定为什么"性价比极高"？',
        options: [
          { t: '因为 SwiftShader 是安卓系统的默认渲染器，所有安卓设备都会返回它', why: '错。SwiftShader 是软件渲染实现，真机的安卓设备使用 GPU 硬件渲染，返回的是 GPU 厂商名（Adreno / Mali 等）。' },
          { t: '因为 GL_RENDERER 是受保护的 API，普通 App 无法调用，能调用的必然是风控 SDK', why: '错。GL_RENDERER 通过标准的 OpenGL ES 接口即可获取，任何 App 都能读，并非特权接口。' },
          { t: '因为它一条 API 调用就能拿到结果，成本极低，而字符串直接暴露了"没有真实 GPU 硬件"这个事实，区分度极高', why: '对。检测成本几乎为零（一次 glGetString），而返回值的语义极其明确——软件渲染意味着不存在可用的 GPU 硬件，真机不可能如此。低成本 + 高区分度 = 高性价比。' },
          { t: '因为 SwiftShader 会主动向系统上报自己是模拟器，属于厂商预留的检测接口', why: '错。SwiftShader 不会主动"上报"，它只是如实返回自己的渲染器名称。是检测方读取了这个名称并做出判断。' }
        ],
        explain: '<b>这条题考的是"检测点的性价比"思维，而不是记住 SwiftShader 这个词。</b><br><br>一个检测点的价值 = <b>检测成本</b> × <b>区分度</b> × <b>伪造难度</b>。GL_RENDERER 三项全部拉满：<br>① <b>成本极低</b>——<span class="mono">glGetString(GL_RENDERER)</span> 一行调用，不需要任何权限，不触发任何可疑行为；<br>② <b>区分度极高</b>——真机的渲染器一定是 GPU 厂商名（Adreno / Mali / PowerVR），软件渲染器名（SwiftShader / llvmpipe）与真机<b>完全不重叠</b>，几乎零误报；<br>③ <b>伪造困难</b>——要让这个字符串变成真实 GPU 名，必须让渲染真的走 GPU（GPU 直通或 virtio-gpu + 宿主 GPU），<b>不是改个字符串就能糊弄的</b>（改字符串会与后续的实际渲染行为矛盾）。<br><br><b>反过来说，这也是对抗的抓手</b>：只要把渲染真正落到 GPU 上，这一项就从"致命破绽"变成了"正常特征"。这就是为什么第 15.8 节的对抗清单里，GPU 那一项写的是"用硬件加速"而不是"改返回值"。'
      }
    },
    /* ================= 15.9 对抗：怎么补 ================= */
    {
      h: '15.10',
      title: '对抗思路：把"缺失的"补成"合理的"',
      html:
        '<p>检测和对抗是同一张表的两个方向。风控逐项扣分，云手机就逐项补齐。<b>但补齐有一个贯穿始终的原则，比任何具体技巧都重要</b>：</p>' +
        T.note('key', '🔑 补的不是"值"，是"统计规律"',
          '<p>新手最容易犯的错，是把"伪造"理解成"填一个看起来对的常量"。<b>而常量恰恰是最强的虚拟化特征</b>——真机上几乎没有哪个传感器读数会永远保持不变。</p>' +
          '<p>正确的目标不是"让电量显示 87%"，而是<b>"让电量像一块真电池那样变化"</b>：非线性下降、低电量时掉得更快、温度随负载浮动、充电时曲线反转。<b>检测方查的是分布和相关性，不是单点数值。</b></p>') +
        T.tbl(['检测项', '虚拟环境通常的样子', '怎么补（按性价比排序）'],
          [['传感器', '没有，或恒为 0', '注入带噪声与变化的数据；<b>保证传感器之间的物理相关性</b>'],
           ['电池', '恒定 100%、固定温度', '模拟非线性放电曲线 + 温度随负载 + 充电状态切换'],
           ['GPU 渲染器', '<span class="mono">SwiftShader</span> / <span class="mono">llvmpipe</span>', '<b>用硬件加速</b>（GPU 直通 / virtio-gpu + 宿主 GPU），别改字符串'],
           ['QEMU 属性', '<span class="mono">ro.kernel.qemu=1</span> 等', '改系统属性 + <b>定制内核去掉设备节点</b>（native 层也要挡）'],
           ['网络', '<span class="mono">52:54:00</span> MAC、<span class="mono">10.0.2.x</span>、机房 IP', '指定真机 OUI；改 NAT 网段；<b>出口走住宅代理</b>'],
           ['设备标识', '固定值、多设备复用', '<b>每台独立且自洽的一整套</b>（型号/厂商/指纹/GPU/CPU 互相对得上）'],
           ['开机时长', '异常短，或时间源矛盾', '落在合理区间，保证三种时间源一致'],
           ['温度/性能', '永不降频，曲线平坦', '模拟热节流：持续负载后主动降频，温度同步上升'],
           ['基带/短信', '无基带', '<b>存在性硬边界</b>：可伪造上报，挡不住主动验证（真发短信）'],
           ['摄像头/麦克风', '无硬件或固定画面', '接入虚拟设备提供<b>有内容且每次不同</b>的输入']]) +
        T.note('warn', '⚠️ 一个必须说清的边界',
          '<p><b>"存在性"类的检测补不干净。</b>传感器、基带、摄像头这些，你可以伪造系统 API 的返回值，但挡不住<b>主动验证</b>——风控真的发一条短信、真的要求拍一张带特定内容的照片、真的去比对 GPU 渲染耗时。</p>' +
          '<p>所以实际工程里，对抗的目标<b>从来不是"完美伪装成真机"，而是"让检测成本高于收益"</b>：把明显的、便宜的检测点全部消掉，逼检测方动用昂贵的方案（人工审核、主动验证、行为分析）。<b>这是一场成本博弈，不是一场技术通关。</b></p>'),

      quiz: {
        id: 'q15-2', chapter: 15, answer: 1,
        stem: '某团队要降低云手机被风控识别的概率。他们列了四项改进，<b>资源只够先做一项</b>。按"消除虚拟化特征"的性价比，哪一项应当<b>优先</b>？',
        options: [
          { t: '把 Build.MODEL / Build.MANUFACTURER 等系统属性改成热门真机型号', why: '这些属性是纯字符串，改起来最容易，但风控对"属性与硬件不匹配"的交叉验证（GPU 是 SwiftShader、CPU 是通用 x86）一查就穿。属于低成本的表面工作，不是最高性价比。' },
          { t: '给每台实例分配独立且自洽的一整套设备标识，并把出口 IP 换成住宅代理', why: '对。这两项直接命中批量检测的两个核心：标识复用（多个账号共享同一身份）和数据中心 IP。它们不依赖"单台伪装得多像"，而是消除"批量关联"这一最致命的信号，收益最大。' },
          { t: '把电量改成 87% 并固定不变，避免每次读都不一样显得奇怪', why: '错得最典型。恒定值本身就是虚拟化特征——真机电池电量必然缓慢变化。这条不仅没收益，还主动制造了一个新特征。' },
          { t: '在 Java 层 hook 掉所有读 <code>/proc/cpuinfo</code> 和 <code>ro.kernel.qemu</code> 的调用', why: '方向对但覆盖面不足：native 层可以直接读这些文件，绕过 Java hook；而且这只处理了 QEMU 痕迹这一类，没有解决批量关联问题。' }
        ],
        explain: '<b>这道题考的是对抗工作的优先级判断，而不是具体技巧。</b><br><br>风控判定云手机有两条独立路径：<br><b>① 单台特征</b>——这一台哪里不像真机（GPS 是 SwiftShader、CPU 是通用 x86、MAC 前缀可疑）。<br><b>② 批量关联</b>——这一万台之间有什么共同点（同一套设备标识、同一个出口 IP、同一个 IP 段）。<br><br>关键在于：<b>路径 ② 的检测成本远低于路径 ①，而且几乎无法通过"把单台伪装得更像"来规避。</b>你可以把一台云手机伪装得无懈可击，但只要一万台共享同一个 Android ID 或同一个机房 IP，风控一次聚合查询就能全部揪出来。<br><br>所以正确策略是<b>先切断关联性</b>（独立标识 + 住宅代理），再逐步打磨单台特征（GPU、传感器、内核定制）。反过来做——先花大力气改 Build.MODEL——等于给一万台设备统一换了一张更漂亮的假身份证，<b>关联性丝毫未减</b>。<br><br>选项 C 则代表了一类经典误区：把"稳定"当成"真实"。真机的特征是<b>动态且有序</b>，不是静止。'
      }
    },

    /* ================= 15.10 军备竞赛 ================= */
    {
      h: '15.11',
      title: '为什么理解原理比背特征表重要',
      html:
        '<p>到这里，本章的技术内容已经讲完了。但在结束之前，必须把最后一件、也是最重要的一件事说透——<b>上面那张检测点清单，是有保质期的</b>。</p>' +
        '<p>风控方会不断寻找新特征，云手机方会不断补齐旧特征。今天有效的检测点，明天可能已经被修掉；今天没人查的角落，明天可能成为主战场。<b>如果你把这章当成一份"特征清单"来背，那么它的价值会随时间衰减到零。</b></p>' +
        T.note('key', '🔑 正确的心智模型：从"清单"回到"推导"',
          '<p>真正不会过期的，是你现在应该已经具备的那套推导能力：</p>' +
          '<p><b>第一，从分层模型推导。</b>知道 App 在 EL0、Linux 内核在 EL1、Hypervisor 在 EL2，你就知道<b>每一层分别会留下什么、又能抹掉什么</b>。新特征出现时，你可以立刻判断它属于哪一层、该在哪一层对抗。</p>' +
          '<p><b>第二，从"真机有什么"推导。</b>不要记"云手机缺传感器"，而要想"<b>一台真手机在物理世界里必然产生哪些副产品</b>"——温度、功耗、传感器耦合、网络拓扑、时间流逝的痕迹。凡是真机因物理约束必然产生、而虚拟机因为不共享物理约束而缺失的东西，<b>都是潜在的检测点</b>。</p>' +
          '<p><b>第三，从"检测成本"推导。</b>风控选择检测手段时有明确的性价比排序：一次 API 调用 &gt; 交叉验证 &gt; 行为分析 &gt; 主动验证 &gt; 人工审核。所以对抗的重心应该放在<b>那些一次调用就能出结果的低成本检测点上</b>——它们一定会被用，而且是第一批被用的。</p>' +
          '<p><b>第四，从"视角"推导。</b>这一章真正的收获不是知识，而是你同时拿到了两副眼镜：<b>风控的眼镜</b>（这台设备哪里不像真机？）和<b>云手机的眼镜</b>（下层能造出什么假象？）。带着这两副眼镜，你看任何一个 App 的环境检测代码，都会自动开始推演它的判据和破法。</p>'),

      quiz: {
        id: 'q15-3', chapter: 15, answer: [0, 2],
        stem: '<b>多选。</b>关于"虚拟化环境下的引导链与 <code>/proc/cmdline</code>"，下列说法正确的是：',
        options: [
          { t: '/proc/cmdline 里的 console=ttyS0、root=/dev/vda1 是明确的虚拟化特征，因为真机不会用串口控制台和 virtio 块设备', why: '正确。这些内容来自 QEMU 启动时的 -append 参数，会原样出现在 Guest 中。真机 Android 设备的 cmdline 由厂商固件决定，不含这些内容。' },
          { t: '虚拟化环境下的引导链没有 BIOS/UEFI 阶段，内核是被 Hypervisor 直接加载的', why: '错。虚拟化环境下仍有虚拟固件——QEMU 使用 SeaBIOS（传统 BIOS）或 OVMF（UEFI）。引导链 BIOS/UEFI → Bootloader → 内核 依然完整，只是每一环都换成了虚拟实现。' },
          { t: 'initramfs 是内核为了打破"挂载根文件系统需要驱动、而驱动在根文件系统上"这个死循环而引入的临时根文件系统', why: '正确。内核先挂载 initramfs，从中加载磁盘控制器与文件系统模块，再 switch_root 到真实根文件系统。Android 的 boot.img 里的 ramdisk 就是这个机制的精简版。' },
          { t: 'GRUB 会直接把内核加载到内存并执行，不依赖任何中间阶段', why: '错。GRUB 是逐级加载的：阶段 1（MBR/EFI 分区里的小段代码）→ 阶段 1.5/阶段 2（加载完整 GRUB 并读取 grub.cfg）→ 加载 vmlinuz 与 initramfs → 交权给内核。分阶段的原因是初始可用的引导空间极小。' }
        ],
        explain: '<b>这道题把 15.4 节的三个关键事实串了起来。</b><br><br><b>① 虚拟化并没有取消引导链，只是把每一环虚拟化了。</b>QEMU 提供 SeaBIOS/OVMF 作为虚拟固件，GRUB 依然正常工作，分区表依然存在。<b>这一点对检测很重要</b>：既然引导链是完整的，那么引导链上每一环留下的痕迹（固件类型、分区布局、cmdline、挂载点命名）都会传递到应用层，都成为可检测信号。<br><br><b>② initramfs 解决的是一个真实的先有鸡还是先有蛋问题。</b>内核要挂载根文件系统，就必须有磁盘控制器驱动；而驱动文件就在根文件系统上。<b>打破循环的方式是先挂一个内存里的临时根文件系统</b>，从它里面加载驱动，然后切换。理解了这一点，你就理解了 Android <span class="mono">boot.img</span> 里为什么必须有 ramdisk——那不是可有可无的部件，它是启动链的必需品。<br><br><b>③ GRUB 分阶段是空间约束的产物。</b>MBR 里只有 512 字节，装不下一个能读文件系统的引导程序，所以必须先加载一小段"loader 的 loader"。<b>这种"空间极小 → 逐级加载"的模式在内核与引导领域反复出现</b>，见到类似设计时可以先问一句"是不是有尺寸约束"。<br><br><b>回到本章主线</b>：cmdline 是这一节最直接的战利品——<b>一行 cat 就能读，一条参数就能修</b>，典型的"低成本检测点 + 低成本对抗点"。'
      }
    },

    /* ================= 15.11 收束 ================= */
    {
      h: '15.12',
      title: '把这一章收束成一句话',
      html:
        T.note('key', '🔑 本章主线回顾',
          '<p><b>云手机 = 跑在服务器上的安卓虚拟机。</b>所以它同时受两套规律的支配：<b>虚拟化的规律</b>（分层、陷入-模拟、Stage-2、virtio、NAT）决定了它<b>会留下什么痕迹</b>；<b>安卓的规律</b>（传感器、电池、GPU、基带、设备标识）决定了它<b>该有什么却常常没有</b>。</p>' +
          '<p>于是，<b>云手机检测 = 在应用层提问，看下层的答案像不像真机</b>；<b>云手机伪装 = 在下层动手，让应用层拿到的答案符合真机的统计规律</b>。<b>两件事是同一枚硬币的两面，理解了任何一面，另一面都能推出来。</b></p>') +
        T.note('', '🧭 顺着往下走',
          '<p>本章讲的是<b>x86 服务器上跑虚拟化</b>。但真正的云手机大量跑在 <b>ARM 服务器</b>上，而且安卓容器的形态（共享宿主内核、而不是各自跑一个完整内核）在密度和性能上更有优势——那是第 17、18 章的主题。</p>' +
          '<p>本章反复提到的"虚拟 WiFi"（伪造 BSSID 与扫描结果）会在第 18 章展开；而 <span class="mono">/proc/self/maps</span> 里隐藏伪装模块痕迹这个老问题，和第 4 章的沙箱、第 11 章的 eBPF 都有关联。<b>你会发现越往后，各章的知识越是在同一张分层图上汇合。</b></p>'),

      quiz: {
        id: 'q15-4', chapter: 15, answer: 3,
        stem: '你在 QEMU 上启动一个云手机实例，用 <code>-netdev user,id=n0,hostfwd=tcp::15555-:5555 -device virtio-net-pci,netdev=n0</code>。启动后，你在 Guest 内执行 <code>ip addr</code>，看到地址是 <code>10.0.2.15</code>。<br><br>随后你从本地开发机执行 <code>adb connect &lt;服务器公网IP&gt;:15555</code>，连接成功。关于这套配置，下列判断<b>错误</b>的是：',
        options: [
          { t: 'Guest 的 10.0.2.15 是 SLIRP 分配的 NAT 内网地址，这个网段本身就是可检测的虚拟化特征', why: '正确判断。SLIRP 默认使用 10.0.2.0/24 网段，真机在移动网络或 WiFi 下几乎不会拿到这个地址。' },
          { t: '连接能成功，是因为 hostfwd 在宿主机的 15555 端口与 Guest 的 5555 端口之间建立了静态映射', why: '正确判断。NAT 模式下外网默认无法主动访问 Guest，hostfwd 就是显式开的那个洞。' },
          { t: '如果再增加一个 hostfwd 规则转发投屏端口，需要给宿主侧使用不同的端口号以避免冲突', why: '正确判断。多条 hostfwd 规则可以共存，但宿主机侧端口必须唯一，否则第二条会绑定失败。' },
          { t: 'Guest 里出现 10.0.2.15 说明网络后端配置有误，正确的 NAT 配置应当让 Guest 直接看到服务器的公网 IP', why: '错误判断——这就是本题答案。NAT 的本质就是地址转换：Guest 必须持有一个内网地址，由 SLIRP 代理出网。让 Guest 直接持有公网 IP 是桥接模式（或路由模式）的特征，不是 NAT 的"正确配置"。' }
        ],
        explain: '<b>这道题考的是对 NAT 本质的理解，而不是记参数。</b><br><br><b>NAT 的字面意思就是网络地址转换。</b>如果 Guest 直接持有公网 IP，那就不叫 NAT 了。SLIRP 的工作方式决定了 Guest 必然在一个私有网段里（默认 <span class="mono">10.0.2.0/24</span>，网关 <span class="mono">10.0.2.2</span>），所有出网流量由 QEMU 进程在用户态改写源地址后代理发出。<b>10.0.2.15 不是配置错误的症状，而是 NAT 正常工作的证据。</b><br><br>选项 D 之所以诱人，是因为它把"我希望网络看起来更真实"这个<b>需求</b>偷换成了"当前配置有误"这个<b>诊断</b>。<b>需求归需求，诊断归诊断</b>——想消除 <span class="mono">10.0.2.x</span> 这个特征，正确做法是改用桥接模式（让 Guest 从真实网络拿地址），而不是断言 NAT 配错了。<br><br><b>顺带说清三个模式在这个维度上的区别</b>：<br><b>NAT</b>：Guest 在内网，出网靠代理，入网靠 hostfwd。<br><b>桥接</b>：Guest 在真实局域网，有独立 IP，进出都自然。<br><b>Host-only</b>：Guest 在内网，且这个内网不通外网。<br><br>理解了这张表，你就能一眼判断一台云手机大概用了哪种网络方案——<b>而这本身就是一个检测手段</b>。'
      }
    }
     ],
     glossary: [
       { t: 'Hypervisor', d: '虚拟机监视器（VMM），负责创建、调度、隔离虚拟机的软件层，分 Type-1 裸金属与 Type-2 宿主型。KVM 是寄生在 Linux 内核里的特例，常归为 Type-1。' },
       { t: '全虚拟化', d: 'Guest OS 无需修改的虚拟化方式。Hypervisor 通过二进制翻译或硬件辅助捕获敏感指令。优点是能跑未修改的系统，缺点是二进制翻译有性能开销。' },
       { t: '半虚拟化', d: 'Guest OS 需修改、主动通过 hypercall 与 Hypervisor 协作的方式。性能更好但只能跑开源系统。virtio 驱动是其最成功的遗产。' },
       { t: 'VM Exit', d: '硬件辅助虚拟化中，Guest 执行敏感指令或发生特定事件时，CPU 从非根模式切回根模式、把控制权交给 Hypervisor 的过程，由 CPU 硬件完成。' },
       { t: 'VMCS', d: 'Intel VT-x 的 Virtual Machine Control Structure，一块由 CPU 读写的内存区域，用于配置哪些指令或事件会触发 VM Exit。AMD 的对应结构是 VMCB。' },
       { t: 'Exception Level', d: 'ARM 的特权分层：EL0 用户态应用、EL1 Guest OS 内核、EL2 Hypervisor、EL3 Secure Monitor（TrustZone）。' },
       { t: 'Stage-2 页表', d: 'ARM 虚拟化中由 Hypervisor 管理的第二级地址翻译，把 Guest 物理地址 IPA 映射为真实物理地址 PA。它让 Hypervisor 无需修改 Guest 任何代码或内存即可完全控制其可见内存。' },
       { t: 'IPA', d: 'Intermediate Physical Address，中间物理地址。Guest 眼里的物理地址，需再经 Stage-2 页表翻译才是真实物理地址。' },
       { t: 'initramfs', d: '内存中展开的临时根文件系统，含挂载真实根文件系统所需的驱动。内核先挂载它，加载驱动后 switch_root 切换。Android 的 boot.img 里的 ramdisk 即其精简版。' },
       { t: 'SLIRP', d: 'QEMU 内置的用户态 TCP/IP 协议栈实现，在 QEMU 进程内完成 NAT 转换，使 NAT 模式无需 root 权限即可工作。' },
       { t: 'hostfwd', d: 'QEMU user-mode networking 的端口转发参数，把宿主机端口静态映射到 Guest 端口。是 NAT 模式下外部访问 Guest 的唯一通路，也是 adb 连接云手机的底层机制。' },
       { t: 'virtio', d: '一组半虚拟化 I/O 驱动规范，Guest 通过共享内存环形队列与 Hypervisor 通信而非模拟真实硬件寄存器。性能好，但出现在 Guest 中即是明确的虚拟化痕迹。' }
     ],
     teacher: { id:'ch15', chapter:15, name:'追问老师 · 第 15 章', sub:'把"云手机在哪一层"追问到底', intro:'<p style="margin:0">本章概念密度高、但每一个都能推导。我会从分层模型开始，一层层往下压，直到你说清"为什么 App 问不出自己在不在虚拟机里"。<b>答不出概念不要紧，答不出因果我会继续追。</b></p>', questions: [
       {
         id: 'c15q1', depth: 1, threshold: 0.7,
         q: 'Type-1 和 Type-2 Hypervisor 的区别是什么？<b>KVM 为什么常被归类为 Type-1，却又很特殊？</b>',
         concepts: [
           { label: 'Type-1 直接跑在硬件上，没有宿主 OS；Type-2 跑在宿主 OS 之上，是一个普通进程',
             hint: '它们的"下面"分别是什么？',
             any: ['type-1','type1','裸金属','裸机','bare metal','直接跑在硬件','没有宿主','无宿主','宿主 os 之上','宿主os之上','普通进程','type-2','type2','宿主型','宿主操作系统之上'] },
           { label: 'Type-1 性能高、用于数据中心云平台；Type-2 性能较低、用于桌面开发测试',
             hint: '谁快谁慢，各自用在哪？',
             any: ['性能','更快','较快','性能高','性能低','数据中心','云平台','服务器','桌面','开发测试','测试环境','virtualbox','vmware workstation'] },
           { label: 'KVM 是 Linux 内核模块，把 Linux 内核本身变成 Hypervisor',
             hint: '它不是独立操作系统，那它是什么？',
             any: ['内核模块','kernel module','kvm 模块','linux 内核','加载模块','ko 模块'] },
           { label: 'KVM 的特殊性在于它"寄生"在 Linux 内核里——既是宿主又当 Hypervisor，依赖 Linux 存活',
             hint: '它需不需要宿主 OS？如果需要，那它还算纯 Type-1 吗？',
             any: ['寄生','依赖 linux','依赖宿主','既是宿主','又当 hypervisor','半独立','不完全是','不是独立','依附','依靠 linux','借助 linux 内核'] }
         ],
         hints: [
           '先画一张图：Type-1 的 Hypervisor 下面是什么？Type-2 的 Hypervisor 下面又是什么？',
           'KVM 不是一个独立发行版或独立操作系统——它是通过什么方式被加载进系统的？加载进哪里？'
         ],
         probes: [
           '既然 KVM 依赖 Linux 内核，为什么还说它性能接近原生？Guest 的普通指令是怎么执行的？',
           '云手机平台为什么普遍选 KVM 这类方案，而不是 VirtualBox？从性能、规模、可控性三个角度说。'
         ],
         model: '<p><b>Type-1（裸金属）</b>：Hypervisor 直接运行在硬件之上，<b>下面没有宿主操作系统</b>。它自己就是最底层的软件层，亲自承担 CPU 调度、内存管理、设备驱动这些原本属于操作系统的职责。代表实现是 Xen、VMware ESXi、Microsoft Hyper-V。<b>性能高</b>，因为 Guest 到硬件之间的路径最短，所以数据中心和云平台都用它。</p>' +
           '<p><b>Type-2（宿主型）</b>：先有一个完整的宿主操作系统（Linux/Windows），Hypervisor 只是它上面的<b>一个普通进程</b>。Guest 的每次敏感操作都要先陷入这个进程，由它翻译后再经由宿主 OS 去碰硬件。代表实现是 VMware Workstation、VirtualBox、纯软件模拟模式的 QEMU。<b>性能较低</b>（多绕了一层），但装起来方便，所以桌面开发测试常用。</p>' +
           '<p><b>KVM 为什么特殊</b>：KVM 不是一个独立操作系统，它是 <b>Linux 内核模块</b>。用 <span class="mono">modprobe kvm</span> 加载后，<b>Linux 内核本身就获得了 Hypervisor 能力</b>——内核既是宿主，又承担了 Hypervisor 的职责。所以：<br>① 从"有没有宿主 OS"这个判据看，KVM 有明显的宿主（Linux 内核），不像纯 Type-1；<br>② 但从"Hypervisor 是否直接管理硬件"看，KVM 通过内核直接操作硬件，且 Guest 的普通指令借助硬件辅助虚拟化<b>以原生速度跑在物理 CPU 上</b>，只有敏感指令才触发 VM Exit。这个性能特征和 Type-1 一致。<br>所以它常被归为 Type-1，本质上是<b>"寄生"在 Linux 内核里的 Type-1</b>。</p>' +
           '<p><b>实践含义</b>：KVM 兼具 Type-1 的性能和 Linux 用户态工具链的便利（<span class="mono">qemu-system-* -enable-kvm</span>、libvirt、virsh）。<b>这正是云手机平台的标准底座</b>——既要有接近原生的性能来支撑高密度实例，又要有一套成熟的自动化管理工具来批量运维。</p>',
         after: '<p><b>再往前一步</b>：正因为 KVM 寄生于 Linux 内核，云手机平台的运维与安全边界实际上就是 Linux 的边界——<b>宿主内核一旦被攻破，同宿主机上的所有云手机实例都会暴露</b>。这是云手机方案商在安全设计上必须回答的问题。</p>'
       },
       {
         id: 'c15q2', depth: 1, threshold: 0.7,
         q: '全虚拟化和半虚拟化有什么区别？<b>virtio 属于哪一种，它为什么既是性能优化、又是检测特征？</b>',
         concepts: [
           { label: '全虚拟化：Guest OS 不需要修改，Hypervisor 通过二进制翻译或硬件辅助捕获敏感指令',
             hint: 'Guest 知不知道自己被虚拟化了？',
             any: ['不需要修改','无需修改','不用改','不改 guest','未修改','二进制翻译','动态翻译','binary translation','硬件辅助','hardware assist','捕获敏感指令','陷入','透明'] },
           { label: '半虚拟化：Guest OS 需要修改，主动通过 hypercall 与 Hypervisor 协作',
             hint: 'Guest 用什么机制主动通知 Hypervisor？',
             any: ['hypercall','超级调用','需要修改','必须改','改内核','修改 guest','主动协作','主动通知','配合 hypervisor'] },
           { label: 'virtio 是半虚拟化 I/O 驱动规范，通过共享内存环形队列通信，而不是模拟真实硬件寄存器',
             hint: '它怎么和 Hypervisor 传数据？靠模拟寄存器吗？',
             any: ['virtio','半虚拟化 i/o','半虚拟化驱动','共享内存','环形队列','ring buffer','vring','不模拟硬件','前端后端','frontend','backend'] },
           { label: 'virtio 出现在 Guest 中即是明确的虚拟化痕迹，因为真机不会使用 virtio 设备',
             hint: '真手机的网卡、磁盘会用 virtio 吗？',
             any: ['痕迹','特征','检测','暴露','真机不会','真机不用','判定为虚拟机','可检测','指纹','破绽'] }
         ],
         hints: [
           '关键判据只有一个：Guest OS 要不要改代码？',
           'virtio 设备在 Guest 里表现为哪个目录 / 哪个设备名？真机会有吗？'
         ],
         probes: [
           '为什么半虚拟化只能跑开源系统？Windows 为什么不行？',
           '如果让你设计一个检测方案，只看 /sys/bus/virtio 是否存在，会有什么误报风险？'
         ],
         model: '<p><b>全虚拟化</b>：Guest OS <b>不需要任何修改</b>。Hypervisor 必须想办法捕获 Guest 的敏感指令——早期靠<b>二进制翻译</b>（动态扫描 Guest 的指令流，把敏感指令替换成能触发陷入的等价序列），现代靠<b>硬件辅助</b>（CPU 直接识别并捕获）。<br><span class="hit">优点</span>：可以运行任何未经修改的操作系统，包括闭源的 Windows。<span class="miss">缺点</span>：二进制翻译有性能开销；而且 Guest 完全不知情，会毫无防备地暴露真实硬件信息。</p>' +
           '<p><b>半虚拟化（Paravirtualization, PV）</b>：Guest OS <b>必须修改</b>。它不再靠"执行敏感指令被硬件陷入"，而是主动通过 <span class="mono">hypercall</span> 与 Hypervisor 协作——<b>本质上把"被动陷入"换成了"主动调用"</b>，类似系统调用的思路。<br><span class="hit">优点</span>：性能更好，没有陷入-模拟的往返开销。<span class="miss">缺点</span>：必须改 Guest 内核，所以<b>只能跑开源系统</b>——Linux 可以，闭源的 Windows 不行。这也直接解释了 Xen 早期 PV 模式为什么只对 Linux 友好。</p>' +
           '<p><b>virtio 是哪一种</b>：virtio 是<b>半虚拟化</b>的，具体说是半虚拟化的 <b>I/O 设备</b>规范。它的做法是：Guest 和 Hypervisor 之间建立<b>共享内存的环形队列</b>（ring），Guest 把 I/O 请求描述符写进队列，Hypervisor 读取并处理，<b>完全不去模拟真实硬件的寄存器行为</b>。相比模拟一块真实的 Intel 千兆网卡（每次寄存器读写都要 VM Exit），virtio 的通信次数少得多，性能好得多。</p>' +
           '<p><b>为什么它同时是检测特征</b>：因为 <b>virtio 是虚拟化世界的专属产物</b>。真手机的存储是 UFS/eMMC、网络是 WiFi/蜂窝基带，<b>不存在 virtio 设备</b>。所以在 Guest 里只要能看到 <span class="mono">/sys/bus/virtio</span> 目录、<span class="mono">lspci</span> 里的 Red Hat Virtio 条目、或内核日志里的 virtio 驱动加载记录，<b>就几乎可以直接判定这是虚拟机</b>。它比 <span class="mono">ro.kernel.qemu</span> 这类系统属性更底层——属性是配置，virtio 是<b>设备树级别的事实</b>。</p>' +
           '<p><b>综合结论</b>：现代云手机的典型形态是 <b>硬件辅助的全虚拟化 + 半虚拟化 I/O</b>。CPU 和内存走硬件辅助（快且无痕），I/O 走 virtio（快但留痕）。<b>所以云手机最硬的破绽往往不在 CPU，而在 I/O、传感器和各类外围设备上。</b></p>'
       },
       {
         id: 'c15q3', depth: 2, threshold: 0.7,
         q: '什么是"陷入-模拟"？<b>ARM 的 Stage-2 页表在其中扮演什么角色，为什么说它是"不修改 Guest 就能完全控制 Guest"的硬件基础？</b>',
         concepts: [
           { label: 'Guest 执行敏感指令触发异常（VM Exit），控制权交给 Hypervisor，模拟执行后 VM Entry 返回 Guest',
             hint: '一次敏感指令的完整往返是哪几步？',
             any: ['vm exit','vmexit','陷入','trap','异常','接管','hypervisor 模拟','模拟执行','vm entry','vmentry','返回 guest','控制权'] },
           { label: '硬件辅助虚拟化让这个过程由 CPU 硬件完成，比软件二进制翻译快得多',
             hint: '同样一件事，硬件做和软件做差在哪？',
             any: ['硬件完成','硬件辅助','cpu 硬件','比软件快','性能','binary translation','二进制翻译','原生速度','接近原生'] },
           { label: 'ARM 用 Exception Level 分层：EL0 应用、EL1 Guest 内核、EL2 Hypervisor、EL3 Secure Monitor',
             hint: 'Hypervisor 跑在哪一级？',
             any: ['el0','el1','el2','el3','exception level','异常级别','secure monitor','trustzone','特权级'] },
           { label: 'Stage-2 页表由 Hypervisor 管理，把 Guest 物理地址 IPA 翻译为真实物理地址 PA；Stage-1 由 Guest OS 自己管',
             hint: '两级翻译分别归谁管？',
             any: ['stage-2','stage2','stage 2','第二阶段','二级页表','ipa','中间物理地址','真实物理地址','stage-1','stage1','hypervisor 管理','二级翻译','嵌套页表'] },
           { label: '正因 Stage-2 独立于 Guest，Hypervisor 能控制 Guest 可见内存而无需修改 Guest 的任何代码或内存',
             hint: '想让一块内存对 Guest 隐身，需要改 Guest 的页表吗？',
             any: ['不需要修改','无需修改','不用改','不改 guest','对 guest 透明','完全控制','隐身','取消映射','重定向','透明','察觉不到'] }
         ],
         hints: [
           '把一次敏感指令的旅程按时间顺序说一遍：谁执行、谁被触发、谁接管、谁返回。',
           'ARM 把地址翻译拆成了两级——第一级谁做？第二级谁做？中间那个地址叫什么？'
         ],
         probes: [
           '如果 Hypervisor 在 Stage-2 里把某块内存对 Guest 取消映射，Guest 自己怎么解释这次访问失败？',
           '为什么说理解了 Stage-2，就理解了 Hypervisor 级内存断点为何"Guest 完全察觉不到"？'
         ],
         model: '<p><b>陷入-模拟（trap-and-emulate）</b>是虚拟化最基本的机制。Guest 在非根模式（non-root）下执行一条敏感指令 → CPU 发现这条指令被 VMCS/VMCB 标记为需要拦截 → 触发异常，<b>VM Exit</b>，CPU 从非根模式切到根模式，控制权交给 Hypervisor → Hypervisor 读取退出原因，<b>模拟执行</b>这条指令本该产生的效果 → 执行 <b>VM Entry</b> 返回 Guest，Guest 从下一条指令继续，<b>完全不知道中间发生过什么</b>。</p>' +
           '<p><b>硬件辅助的意义</b>：这一整套切换由 CPU 硬件完成，比软件二进制翻译快得多；而 Guest 的普通指令（绝大多数）根本不触发切换，<b>直接以原生速度跑在物理 CPU 上</b>。这就是为什么硬件辅助虚拟化的性能能接近裸机。</p>' +
           '<p><b>ARM 的分层</b>：ARM 用 Exception Level 表达特权级别，比 x86 更清晰——<b>EL0</b> 用户态应用（风控 SDK 在这里）、<b>EL1</b> Guest OS 内核（Android Linux 内核）、<b>EL2</b> Hypervisor（KVM/ARM、pKVM、Xen on ARM）、<b>EL3</b> Secure Monitor（ARM TrustZone，连 EL2 也管不了它）。</p>' +
           '<p><b>Stage-2 页表的角色</b>：ARM 把地址翻译拆成两级。<b>Stage-1</b> 由 Guest OS 自己管理：虚拟地址 VA → Guest 物理地址 IPA。<b>Stage-2</b> 由 <b>Hypervisor</b> 管理：IPA → 真实物理地址 PA。Guest 眼里的"物理地址"其实只是中间量 IPA，真正的落点由 Stage-2 决定。</p>' +
           '<p><b>为什么它是"不修改 Guest 就能完全控制 Guest"的基础</b>：关键在于 <b>Stage-2 完全独立于 Guest</b>。Hypervisor 想让某块内存对 Guest 隐身，只需在 Stage-2 里取消映射；想在不改 Guest 一个字节的前提下替换一段数据，只需改 Stage-2 的指向。<b>Guest 的页表、代码、校验和全部完好无损。</b></p>' +
           '<p><b>这正是 Hypervisor 级内存断点的立足点</b>：在 Stage-2 里把目标页面设为不可访问，Guest 一碰就 VM Exit 到 EL2，Hypervisor 在那里检查 Guest 的完整状态（寄存器、调用栈、参数），记录完毕后再恢复映射放行。<b>整个过程中 Guest 的代码没有被打补丁、内存没有被动过、也没有任何 hook 框架的痕迹</b>——因为干预发生在 Guest 根本看不见的一层。这就是它相对 Frida/PLT hook 这类应用层方案的代际优势。</p>',
         after: '<p><b>反向思考</b>：既然 Stage-2 有这种能力，那么"在真机上怀疑自己被 Hypervisor 监控"就不是妄想——企业沙箱、加固方案、云真机都可能这么干。检测方向见 15.3 节的"出问题往哪查"：<b>时序抖动、固件/设备树里的 hypervisor 节点、CPU 特性寄存器</b>。</p>'
       },
       {
         id: 'c15q4', depth: 2, threshold: 0.7,
         q: 'QEMU 的 NAT（user-mode networking）模式是怎么工作的？<b>为什么外网默认访问不到 Guest，而 hostfwd 又能解决这个问题？这和 adb 连接云手机有什么关系？</b>',
         concepts: [
           { label: 'QEMU 内置 SLIRP 协议栈做用户态 NAT，Guest 出网流量被 QEMU 进程代理成宿主机上的普通 socket',
             hint: 'NAT 转换是在宿主内核里做的，还是在 QEMU 进程里做的？',
             any: ['slirp','用户态','user mode','usermode','qemu 内置','qemu 进程','协议栈','代理','普通 socket','socket','无需 root','不需要 root'] },
           { label: 'NAT 模式下 Guest 在内网（默认 10.0.2.0/24），外网主动发起的新连接没有映射关系，会被丢弃',
             hint: 'NAT 的本质是什么表？表里没有的连接会怎样？',
             any: ['10.0.2','内网','私有地址','私网','无法访问','进不来','访问不到','单向','映射','端口映射','nat 表','连接状态','主动连接','外网主动'] },
           { label: 'hostfwd 建立宿主端口到 Guest 端口的静态映射，是 NAT 模式下外部访问 Guest 的唯一通路',
             hint: '它把哪个端口映射到哪个端口？方向是什么？',
             any: ['hostfwd','端口转发','端口映射','静态映射','转发规则','唯一通路','唯一入口','host port','宿主端口'] },
           { label: 'adb 连接云手机就是靠 hostfwd 把宿主端口转发到 Guest 的 5555 端口',
             hint: 'adb 默认监听哪个端口？你敲的那条命令是什么？',
             any: ['adb','5555','adb connect','连接云手机','adb 端口','远程调试'] }
         ],
         hints: [
           'SLIRP 是一个用户态的 TCP/IP 实现——那 Guest 发出的包，在宿主机看来是什么？',
           'NAT 只允许"内部先发起"的连接双向通行，那外网想主动连进来，需要提前做什么？'
         ],
         probes: [
           '如果云手机平台不配 hostfwd，你在本地还能通过什么方式连上它？（想想 Guest 主动往外连的模式）',
           'NAT 模式下 Guest 拿到 10.0.2.15，这本身对风控意味着什么？'
         ],
         model: '<p><b>NAT 模式（user-mode networking）的原理</b>：QEMU 内置了一个叫 <b>SLIRP</b> 的协议栈，做<b>用户态的 NAT</b>。Guest 发出的包不会进入宿主的网络栈做转换，而是被 QEMU 进程自己解析——SLIRP 维护 TCP/IP 连接状态、伪装成客户端，然后用<b>宿主机上的普通 socket</b> 把请求发出去。所以从宿主机角度看，这根本不是"一台虚拟机在上网"，而是 <b>QEMU 这个进程开了个 socket</b>，和宿主机上任何程序没有区别。<b>这正是 NAT 模式不需要 root、不需要任何配置的根本原因</b>——它没有创建 tap 设备、没有改路由表、没有碰内核网络配置。</p>' +
           '<p><b>为什么外网进不来</b>：NAT 的本质是一张<b>连接状态表</b>。Guest 主动发起的连接，SLIRP 记下了状态，回来的包能对上号，双向通行。但<b>外网主动发起的新连接，在这张表里没有任何对应条目</b>，SLIRP 不知道该送给谁，只能丢弃。附带两个限制：<b>ICMP（ping）支持有限</b>；<b>Guest 看不到真实网络拓扑</b>，它以为自己在一个 10.0.2.0/24 的小网络里。</p>' +
           '<p><b>hostfwd 怎么解决</b>：<span class="mono">hostfwd=tcp::5555-:5555</span> 的作用是<b>在 NAT 状态表里预先塞进一条永久映射规则</b>——"宿主机 5555 端口收到的连接，转给 Guest 的 5555 端口"。有了这条静态规则，外网的连接就有明确去处了。所以它是 <b>NAT 模式下外部访问 Guest 的唯一通路</b>。</p>' +
           '<p><b>和 adb 连接云手机的关系</b>：这是本章最直接的一条实战链条。云手机跑在服务器上，你用 <span class="mono">adb connect &lt;服务器IP&gt;:&lt;端口&gt;</span> 连它——背后就是 QEMU 的 <span class="mono">hostfwd</span> 把宿主端口转发到 Guest 的 adb 端口（默认 5555）。<b>你每天敲的那条 adb connect，落地就是 QEMU 启动参数里的一个 hostfwd。</b></p>' +
           '<p><b>工程细节</b>：一个实例可以配多条 hostfwd，但<b>宿主侧端口必须唯一</b>，否则第二条会绑定失败。云手机平台的通行做法是<b>每个实例分配不同的宿主端口，前面再挂一层网关做鉴权</b>——直接暴露 5555 等于把设备的 shell 通道挂在公网上。</p>'
       },
       {
         id: 'c15q5', depth: 3, threshold: 0.65,
         q: '<b>综合题。</b>一个风控团队想识别云手机。他们手上只有应用层能力（跑在 EL0 的普通 App 权限），却要对抗一个可以任意定制 QEMU 参数、内核和 Android 框架的对手。<br><br>请说明：<b>①</b> 他们会优先选哪几类检测点，为什么？<b>②</b> 云手机方分别怎么补？<b>③</b> 哪些检测点是云手机方<b>补不干净</b>的，为什么？<b>④</b> 由此看，这场对抗的本质是什么？',
         concepts: [
           { label: '优先选低成本、高区分度的检测点：一次 API 调用就能出结果的（GL_RENDERER、/proc/cmdline、MAC OUI、系统属性、传感器列表）',
             hint: '风控的算力也有限，他们会先扫哪些"便宜"的特征？',
             any: ['gl_renderer','swiftshader','渲染器','gpu','mac','oui','52:54:00','cmdline','系统属性','ro.kernel.qemu','传感器列表','低成本','成本低','一次调用','性价比','区分度'] },
           { label: '存在性检测最难补：基带（电话短信）、真实传感器物理耦合、摄像头内容，因为需要凭空造出硬件行为',
             hint: '哪一类特征是"本来就没有"的，而不是"数值不对"的？',
             any: ['基带','modem','通信','打电话','发短信','sim','传感器','物理耦合','摄像头','麦克风','存在性','没有硬件','凭空'] },
           { label: '统计特征最容易补但最容易被忽略：电量曲线、传感器噪声、温度节流、CPU 频率曲线，关键是模拟动态与相关性而非恒定值',
             hint: '把电量固定成 87% 算补好了吗？',
             any: ['电量','电池','放电曲线','噪声','抖动','变化','温度','节流','降频','cpufreq','频率曲线','动态','相关性','恒定值','统计'] },
           { label: '标识一致性是批量检测的杀手：多个设备共享同一套标识或同一出口 IP，风控聚合查询即可发现批量行为',
             hint: '如果一万台云手机伪装得都很像真机，但它们之间有什么共同点？',
             any: ['标识','android id','imei','序列号','fingerprint','复用','共享','同一个','批量','关联','聚类','聚合','出口 ip','数据中心 ip','同一 ip'] },
           { label: '补不干净的是"存在性"与"主动验证"：风控可以真的发短信、真的要求拍照、真的比对渲染耗时，伪造就过不了',
             hint: '如果风控不只是读 API，而是真的做一次操作呢？',
             any: ['主动验证','真发短信','实际验证','真实操作','渲染耗时','侧信道','时序','性能','无法伪造','补不干净','硬边界','物理'] },
           { label: '对抗本质是成本博弈而非技术通关：目标是让检测成本高于收益，而不是完美伪装',
             hint: '云手机方需要骗过所有检测吗？还是只需要让检测变得不划算？',
             any: ['成本','博弈','收益','性价比','军备竞赛','持续','猫鼠','不是通关','成本高于','权衡','经济'] }
         ],
         hints: [
           '把十二个检测点按"风控查起来多贵"和"云手机补起来多贵"两个维度各排一次序，注意两张表的关系。',
           '想清楚一件事：云手机方需要"完美"吗？如果不完美也能活，那他们真正要达成的是什么？'
         ],
         probes: [
           '如果风控改用"行为分析"（操作节奏、点击轨迹、使用时段），云手机方要怎么补？这还算不算本章讨论的"环境伪装"？',
           '假设你是云手机厂商的工程师，预算有限。你会先做哪三件事？给出优先级和理由。'
         ],
         model: '<p><b>① 优先选什么</b>：风控的算力与延迟预算有限，所以按<b>性价比</b>排序——<b>单位成本能拿到多少区分度</b>。第一梯队是<b>一次 API 调用或一次文件读取就能出结果</b>的：<span class="mono">glGetString(GL_RENDERER)</span> 看是不是 SwiftShader；读 <span class="mono">/proc/cmdline</span> 看有没有 <span class="mono">console=ttyS0</span>；读 MAC 看是不是 <span class="mono">52:54:00</span> 开头；读 <span class="mono">ro.kernel.qemu</span>；调 <span class="mono">getSensorList()</span> 看是否为空。这些<b>成本几乎为零、误报率极低</b>，一定第一批被用。第二梯队是<b>交叉验证</b>（Build.MODEL 说是小米，GPU 却是软件渲染器）和<b>统计检测</b>（电量恒定、传感器无变化）。</p>' +
           '<p><b>② 云手机方怎么补</b>：分三类。<b>配置层</b>——改系统属性、指定真机 MAC OUI、清理 <span class="mono">/proc/cmdline</span>、调 QEMU 网卡型号，成本最低。<b>模拟层</b>——注入带噪声和相关性的传感器数据、模拟非线性放电曲线与热节流降频，要点是<b>造出"动态且互相耦合"的行为，而不是填常量</b>。<b>系统层</b>——定制内核重写 <span class="mono">/proc</span> 输出、去掉 QEMU 设备节点、把 <span class="mono">/dev/vda</span> 映射成 <span class="mono">/dev/block/mmcblk0</span>、让 GPU 真的走硬件加速。还有一类不属于单台伪装，而属于<b>切断关联</b>——每台独立自洽的标识、走住宅代理换掉数据中心 IP。</p>' +
           '<p><b>③ 哪些补不干净</b>：<b>存在性</b>类的。基带——风控不读 API，而是<b>真的发一条短信、真的拨一个号码</b>，没有基带就过不了。摄像头——要求拍一张带特定内容的照片，虚拟摄像头要么给不出、要么内容重复。还有<b>物理副产品</b>：真实 GPU 渲染耗时曲线、热节流带来的性能衰减、传感器之间的物理耦合（摇晃时陀螺仪和加速度计必须同时响应且相位一致）。<b>共性是：这些不是"一个可以被改写的值"，而是物理约束的产物。</b>风控只要主动做一次真实验证，或从侧信道测量，伪造就会露馅。</p>' +
           '<p><b>④ 本质是什么</b>：<b>这是一场成本博弈，不是一场技术通关。</b>云手机方不需要、也不可能做到"完美伪装成真机"——他们只需要让<b>检测成本高于检测收益</b>：把便宜的检测点全部消掉，逼风控动用昂贵方案（主动验证要真发短信、侧信道测量要专门探针、人工审核要人力），当这些成本超过一台云手机带来的收益时，对抗就成功了。<b>而检测方在不停寻找新的"便宜特征"</b>——一旦某个新特征被发现且无法低成本伪造，攻守就会再次倾斜。</p>' +
           '<p><b>所以这章真正要给你的是推导能力</b>：知道分层模型，知道"真机因物理约束必然产生什么副产品"，知道"风控会按性价比选检测手段"——那么无论特征表怎么变，你都能自己推导出下一轮的检测点和补法。<b>清单会过期，推导不会。</b></p>',
         after: '<p><b>延伸到本章之外</b>：当风控从"环境检测"转向"<b>行为检测</b>"（操作节奏、点击轨迹、使用时段分布、账号间社交图谱），对抗的重心就从"伪装环境"变成了"伪装人"。那是另一个维度的战场，本章的分层模型不再直接适用——但"<b>从物理约束和成本结构推导检测点</b>"这套方法依然有效。</p>'
       }
     ] }
};
