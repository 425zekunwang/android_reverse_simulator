/* 第 31 章 · 容器化核心原理
   数据文件：window.CHAPTER（浏览器脚本，禁止 import/require/export）
   约定：字符串内的单引号一律改用中文引号「」或 &quot;，避免转义地狱 */
window.CHAPTER = {
  no: 31,
  title: '容器化核心原理',
  lede: '容器既不是黑魔法，也不是「小虚拟机」——它是 <strong>namespaces + cgroup + rootfs + capabilities/seccomp</strong> 四样东西同时作用在<strong>一个普通进程</strong>上的结果。这一章我们亲手拆开 Docker：用命令行造一个迷你容器，把 docker0 网桥上的数据流跑一遍，再打通 x86_64 上运行 arm64 的整条链路。',
  meta: [
    '核心问题：<b>Docker 到底做了什么？容器与虚拟机的边界在哪里？</b>',
    '关键工具：<b>clone / unshare / setns、cgroup v2、pivot_root、binfmt_misc + QEMU、debootstrap</b>',
    '对手：<b>容器环境检测（云手机风控、环境伪装）、x86 服务器跑 ARM 负载</b>'
  ],

  sections: [
    /* ============ 31.1 ============ */
    {
      h: '31.1',
      title: '先摆正认知：容器不是「小虚拟机」',
      intuition: {
        tag: '直觉模型 · 合租公寓 vs 独栋别墅',
        body: '<p>虚拟机像<b>独栋别墅</b>：自带地基、水电、锅炉，甚至自带一套门牌系统 —— 每一位住户（Guest OS）都有自己的内核、自己的驱动、自己的资源管理。想再住一户？先盖一栋楼，从打地基（引导内核）开始，几十秒起步、几百 MB 内存打底。</p>'
          + '<p>容器像<b>合租公寓</b>：楼（宿主内核）只有一栋，所有住户共用同一套水电管道和同一面承重墙。公寓管理做的事情只有四件 —— 给每户发<b>独立门牌号</b>（namespace 决定「看得见什么」）、给每户<b>限水限电</b>（cgroup 决定「能用多少」）、给每户配<b>独立家具</b>（rootfs 决定「有哪些文件」）、给每户拉<b>独立网线</b>（veth 决定「怎么连出去」）。</p>'
          + '<p>这个类比直接解释了两件事：为什么容器启动只要几十毫秒 —— 它<b>只是一个加了四层约束的普通进程</b>，没有引导过程；为什么容器隔离比虚拟机弱 —— 承重墙是共用的，一旦有人凿穿内核这面墙（内核漏洞逃逸），整栋楼一起遭殃。</p>'
      },
      html:
        '<p>先把最容易搞错的一件事摆正：<b>容器和虚拟机之间没有继承关系</b>。容器不是「瘦身版的虚拟机」，它是 Linux 内核几套既有机制被组合出来的一种<b>用法</b>。把这一点想通，后面所有细节都会自动归位。</p>'
        + T.tbl(['维度', '容器', '虚拟机'], [
            ['内核', '<b>共享宿主内核</b>（同一份）', '<b>独立内核</b>（Guest OS 自带）'],
            ['隔离机制', 'namespace —— <b>软件隔离</b>，改的是「视图」', '硬件虚拟化 VT-x / AMD-V —— <b>硬件隔离</b>'],
            ['隔离强度', '<b>弱</b>：内核漏洞 / 危险 capabilities 可逃逸', '强：逃逸要靠虚拟化层本身的漏洞'],
            ['启动开销', '极小 —— <b>就是一个进程</b>，毫秒级', '大 —— 要引导完整 OS，秒级'],
            ['资源占用', '低（MB 级）', '高（GB 级）'],
            ['单机密度', '几十到几百个', '几个到十几个（受内存限制）']
          ])
        + T.note('key', '🔑 一句话记牢', '<p><code>docker run</code> 的本质，是内核的 <b>clone() 带上一堆 <code>CLONE_NEW*</code> 标志</b>创建了一个新进程，给它换了个根目录，再用 cgroup 给它套上额度。<b>没有任何虚拟硬件被创建</b>。最快的判别方法：在容器里敲 <code>uname -r</code>，看到的是<b>宿主机的内核版本</b>；在虚拟机里敲，看到的是 Guest 自己的内核版本。</p>')
        + T.note('warn', '⚠️ 反向误解：容器「更安全」', '<p>很多人以为「隔离就等于安全」。方向恰恰相反：<b>虚拟机的隔离强度高于容器</b>。容器里的 root（尤其是带上了 <code>CAP_SYS_ADMIN</code>、或挂载了宿主目录时）离宿主 root 只差一个内核漏洞。这既是云手机厂商的成本考量，也是风控厂商的检测入口 —— 31.12 会专门演练这个战场。</p>'),
      after: '<p>那容器究竟由哪几块拼成？下一节把它们拆成四根柱子，一根一根装上去。</p>'
    },

    /* ============ 31.2 ============ */
    {
      h: '31.2',
      title: '容器是由什么拼出来的：四根柱子',
      html:
        '<p>Docker 的文档喜欢把容器讲成「镜像 + 运行时」的黑盒。我们换一个讲法：<b>容器 = 四组内核机制同时作用在一个普通进程上</b>。下面这张图把它们拆成四根柱子，逐步点亮，看每一根装上去之后这个世界多了什么。</p>'
        + '<p>先认识三个必须在术语上分清的东西：' + T.term('namespace', '命名空间：Linux 的资源隔离机制，决定进程「看得见什么」。注意它是视图隔离，不是物理隔离') + '、'
        + T.term('cgroup', 'control group 控制组：Linux 的资源限制机制，决定进程「能用多少」') + '、'
        + T.term('veth pair', '虚拟网卡对：成对出现的两块虚拟网卡，像一根网线连接两个网络命名空间') + '。三者加上一个 rootfs，就是你在 <code>docker ps</code> 里看到的那一行。</p>'
        + T.note('key', '🔑 四根柱子的分工', '<p><b>namespaces 管「看不见」</b>（隔离视图）→ <b>cgroup 管「用不了那么多」</b>（限制资源）→ <b>rootfs 管「文件系统长什么样」</b>（换根）→ <b>veth + capabilities/seccomp 管「怎么连出去、还剩多少权限」</b>。任何号称「容器」的东西，缺了其中任意一根都跑不起来 —— 这也是你自己写容器时的检查清单。</p>'),
      stage: {
        title: '容器装配图：四根柱子一根一根装上去',
        speed: 2000,
        render:
          '<div class="flow-row" style="align-items:stretch;gap:12px">' +
            '<div class="card" style="flex:1">' +
              '<div class="card-title">① namespaces · 看不见</div>' +
              '<div class="flow-col">' +
                '<div class="blk" id="nsp1">CLONE_NEWPID · 进程视图</div>' +
                '<div class="blk" id="nsp2">CLONE_NEWNET · 网络视图</div>' +
                '<div class="blk" id="nsp3">CLONE_NEWNS · 挂载视图</div>' +
                '<div class="blk" id="nsp4">CLONE_NEWUTS · 主机名</div>' +
                '<div class="blk" id="nsp5">CLONE_NEWIPC · IPC 对象</div>' +
                '<div class="blk" id="nsp6">CLONE_NEWUSER · UID 映射</div>' +
              '</div>' +
            '</div>' +
            '<div class="card" style="flex:1">' +
              '<div class="card-title">② cgroup · 用不了那么多</div>' +
              '<div class="flow-col">' +
                '<div class="blk" id="cgp1">cpu.max · CPU 配额</div>' +
                '<div class="blk" id="cgp2">memory.max · 内存上限</div>' +
                '<div class="blk" id="cgp3">pids.max · 进程数上限</div>' +
                '<div class="blk" id="cgp4">io.max · 磁盘带宽</div>' +
              '</div>' +
            '</div>' +
            '<div class="card" style="flex:1">' +
              '<div class="card-title">③ rootfs · 有哪些文件</div>' +
              '<div class="flow-col">' +
                '<div class="blk" id="rfp1">/ 换成容器的根目录</div>' +
                '<div class="blk" id="rfp2">/proc · 重挂 procfs</div>' +
                '<div class="blk" id="rfp3">/sys · 重挂 sysfs</div>' +
                '<div class="blk" id="rfp4">/dev · 最小设备集</div>' +
              '</div>' +
            '</div>' +
            '<div class="card" style="flex:1">' +
              '<div class="card-title">④ 网络与权限 · 怎么连、剩多少权</div>' +
              '<div class="flow-col">' +
                '<div class="blk" id="nvp1">eth0 · 容器里的网卡</div>' +
                '<div class="blk" id="nvp2">vethXXXX · 宿主这端</div>' +
                '<div class="blk" id="nvp3">docker0 · 虚拟网桥</div>' +
                '<div class="blk" id="nvp4">capabilities · 能力裁剪</div>' +
                '<div class="blk" id="nvp5">seccomp · 系统调用过滤</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="flow-row" style="margin-top:14px">' +
            '<span class="blk" id="sum1">PID 1 = 你的程序</span>' +
            '<span class="arrow">+</span>' +
            '<span class="blk" id="sum2">限额生效</span>' +
            '<span class="arrow">+</span>' +
            '<span class="blk" id="sum3">/ 指向 rootfs</span>' +
            '<span class="arrow">+</span>' +
            '<span class="blk" id="sum4">能连出去</span>' +
            '<span class="arrow">=</span>' +
            '<span class="blk" id="sum5">这就是「容器」</span>' +
          '</div>',
        reset: () => {
          ['nsp1','nsp2','nsp3','nsp4','nsp5','nsp6','cgp1','cgp2','cgp3','cgp4',
           'rfp1','rfp2','rfp3','rfp4','nvp1','nvp2','nvp3','nvp4','nvp5',
           'sum1','sum2','sum3','sum4','sum5'].forEach((k) => S(k, ''));
        },
        steps: [
          { run: () => S('sum1', 'active'),
            note: '<b>起点：一个再普通不过的进程。</b>你敲下 <code>docker run</code> 时，内核里并没有发生什么「创建机器」的大事 —— containerd 只是准备了一次 <code>clone()</code> 调用。容器的一切特殊性，都是这次 clone 之后才被贴上去的。记住这个起点，后面每一步都只是往这个进程上加约束。' },
          { run: () => S('nsp1', 'active'),
            note: '<b>①-A PID namespace（CLONE_NEWPID）。</b>新进程成为新命名空间里的 <b>PID 1</b>。它看不到宿主机上的任何其他进程，宿主机上的 <code>ps</code> 也看不到它。这就解决了「进程互相干扰」的问题 —— 容器 A 里跑什么，容器 B 里完全不知道。' },
          { run: () => S('nsp2', 'active'),
            note: '<b>①-B NET namespace（CLONE_NEWNET）。</b>给它一套全新的网卡、路由表、iptables 规则和端口空间。于是两个容器可以同时监听 80 端口而互不冲突 —— 因为「80 端口」在各自的网络命名空间里是两回事。<b>没有这一层，容器网络无从谈起。</b>' },
          { run: () => { S('nsp3', 'active'); S('nsp4', 'active'); },
            note: '<b>①-C Mount（CLONE_NEWNS）+ UTS（CLONE_NEWUTS）。</b>挂载命名空间让进程拥有独立的挂载点视图，可以安全地换根；UTS 命名空间隔离主机名与域名，容器里 <code>hostname</code> 改成什么都不会影响宿主机。<span class="mono">注意 flag 叫 NEWNS 而不是 NEWMNT</span> —— 历史遗留命名，考试与文档里经常出现，别写错。' },
          { run: () => { S('nsp5', 'active'); S('nsp6', 'active'); S('sum1', 'done'); },
            note: '<b>①-D IPC（CLONE_NEWIPC）+ USER（CLONE_NEWUSER）。</b>IPC 隔离 System V IPC 与 POSIX 消息队列，防止容器间通过共享内存串门；USER 做 UID 映射，让<b>非 root 用户也能创建容器</b> —— 这是 rootless 容器的基础。至此「看不见」这一列完成：<b>它现在活在一个只有自己的世界里</b>。' },
          { run: () => { ['cgp1','cgp2','cgp3','cgp4'].forEach((k) => S(k, 'active')); S('sum2', 'active'); },
            note: '<b>② cgroup：从「看不见」到「拿不走」。</b>光隔离不限制，一个容器里的死循环照样能把整台机器吃光。cgroup 就是那道闸门：把进程 PID 写进 <code>cgroup.procs</code>，再往 <code>cpu.max</code>、<code>memory.max</code>、<code>pids.max</code> 里写上限。<b>namespace 管邻居是谁，cgroup 管你能吃多少 —— 两者缺一不可。</b>' },
          { run: () => { ['rfp1','rfp2','rfp3','rfp4'].forEach((k) => S(k, 'active')); S('sum3', 'active'); },
            note: '<b>③ rootfs：换掉整个文件系统。</b>用 <code>pivot_root</code>（或 <code>chroot</code>）把进程眼中的 <span class="mono">/</span> 指到容器的根目录。接着必须<b>重新挂载 /proc、/sys、/dev</b> —— 因为换了根以后，旧的 <code>/proc</code> 挂载点已经看不到了，而 <code>ps</code>、<code>free</code>、<code>ifconfig</code> 全都靠它。<b>这一步是新手最常漏的坑</b>：漏了 /proc，容器里连 <code>ps</code> 都跑不起来。' },
          { run: () => { ['nvp1','nvp2','nvp3'].forEach((k) => S(k, 'active')); S('sum4', 'active'); },
            note: '<b>④-A 网络：veth pair 把容器接出去。</b>刚创建的网络命名空间里只有一块 down 状态的 <code>lo</code>。运行时创建一对 veth 虚拟网卡，一端丢进容器的命名空间改名 <code>eth0</code>，另一端留在宿主机插到 <code>docker0</code> 网桥上。<b>记住「网卡是成对出现的」</b> —— 这是理解容器网络的钥匙，31.7 会逐跳验证。' },
          { run: () => { S('nvp4', 'active'); S('nvp5', 'active'); },
            note: '<b>④-B capabilities + seccomp：把 root 的权限切碎。</b>容器里的 root 默认已经丢掉了大量 capability（不能改内核模块、不能改系统时间、不能直接挂载设备）；seccomp 再从系统调用层面过滤掉危险调用。<b>这一层决定了「容器逃逸有多难」</b> —— 也是风控判断「你是不是在容器里」的重要依据。' },
          { run: () => { S('sum5', 'hot'); S('sum1', 'cool'); S('sum2', 'cool'); S('sum3', 'cool'); S('sum4', 'cool'); },
            note: '<b>合体完成。</b>四根柱子都装好了，你现在拥有一个「看起来像一台机器、实际上只是一个被约束的进程」的东西。回头看：<b>没有任何一行代码在模拟硬件，没有任何一个内核被拷贝</b>。Docker 不是魔法，Docker 是这四根柱子的封装器 —— 下一节先跟虚拟机并排比一次，再动手自己造。' }
        ]
      },
      after: T.note('', '📌 这张图的用法', '<p>以后遇到任何容器相关问题，先问自己「是四根柱子里的哪一根出问题了」：看不见对方进程 → PID namespace；端口冲突 → NET namespace；<code>ps</code> 报错 → rootfs 里 /proc 没挂；OOM 被杀 → cgroup 的 <code>memory.max</code>；连不上网 → veth/docker0/NAT。<b>把这张图背下来，排障速度会快一个数量级。</b></p>')
    },
    /* ============ 31.3 ============ */
    {
      h: '31.3',
      title: '并排看：共享内核 vs 独立内核',
      html:
        '<p>上一节说「容器共享宿主内核」，这句话值得单独画一张图钉死。下面把两者按分层摊开 —— 请重点盯<b>内核层有几份</b>，以及<b>每一层上面压着几个应用</b>。</p>'
        + '<p>为什么要花一整节讲这个？因为在实战里，「我到底是在容器里还是在虚拟机里」这个问题会反复出现：它决定了你能不能 <code>insmod</code>、能不能改系统时间、能不能看到别人、以及风控会不会把你标出来。<b>分层图是判断这一切的坐标系。</b></p>',
      stage: {
        title: '架构对比：容器（共享内核） vs 虚拟机（独立内核）',
        speed: 2000,
        render:
          '<div class="flow-row" style="align-items:stretch;gap:14px">' +
            '<div class="card" style="flex:1">' +
              '<div class="card-title">容器 · 一个内核，多个隔离视图</div>' +
              '<div class="flow-col">' +
                '<div class="blk" id="ca1">App A（独立 rootfs）</div>' +
                '<div class="blk" id="ca2">App B（独立 rootfs）</div>' +
                '<div class="blk" id="cl1">libc / 依赖（各一份）</div>' +
                '<div class="blk" id="cl2">libc / 依赖（各一份）</div>' +
                '<div class="blk" id="cr1">namespaces + cgroup 施加的「视图与额度」</div>' +
                '<div class="blk" id="ck1">宿主内核 · 全程只有这一份</div>' +
                '<div class="blk" id="ch1">物理硬件</div>' +
              '</div>' +
              '<div id="ct1" class="pill">启动：毫秒级</div>' +
            '</div>' +
            '<div class="card" style="flex:1">' +
              '<div class="card-title">虚拟机 · 每个 Guest 一套完整内核</div>' +
              '<div class="flow-col">' +
                '<div class="blk" id="va1">App A</div>' +
                '<div class="blk" id="va2">App B</div>' +
                '<div class="blk" id="vg1">Guest OS 内核 A（完整 OS 映像）</div>' +
                '<div class="blk" id="vg2">Guest OS 内核 B（完整 OS 映像）</div>' +
                '<div class="blk" id="vv1">Hypervisor（VT-x / AMD-V 硬件虚拟化）</div>' +
                '<div class="blk" id="vh1">物理硬件</div>' +
              '</div>' +
              '<div id="ct2" class="pill">启动：秒级</div>' +
            '</div>' +
          '</div>' +
          '<div class="flow-row" style="margin-top:14px">' +
            '<span class="blk" id="k1">隔离强度</span>' +
            '<span class="blk" id="k2">启动开销</span>' +
            '<span class="blk" id="k3">单机密度</span>' +
            '<span class="blk" id="k4">判据 uname -r</span>' +
            '<span class="blk" id="k5">逃逸难度</span>' +
          '</div>',
        reset: () => {
          ['ca1','ca2','cl1','cl2','cr1','ck1','ch1','va1','va2','vg1','vg2','vv1','vh1',
           'k1','k2','k3','k4','k5'].forEach((k) => S(k, ''));
          CLS('ct1', 'pill'); SET('ct1', '启动：毫秒级');
          CLS('ct2', 'pill'); SET('ct2', '启动：秒级');
        },
        steps: [
          { run: () => { S('ca1', 'active'); S('ca2', 'active'); },
            note: '<b>先看应用层，两边是一样的。</b>无论容器还是虚拟机，跑的都是普通 Linux 用户态程序。差别不在这里，往下看。' },
          { run: () => { ['cl1','cl2'].forEach((k) => S(k, 'active')); S('ca1', 'done'); S('ca2', 'done'); },
            note: '<b>容器：每个应用有自己的依赖库和 rootfs。</b>这正是容器「环境一致性」的来源 —— 把 libc、openssl 这些依赖连同程序一起打包，换台机器照样跑。注意它<b>只打包用户态</b>，内核不打。' },
          { run: () => { S('cr1', 'active'); S('cl1', 'done'); S('cl2', 'done'); },
            note: '<b>容器：中间这一层是「约束」而不是「系统」。</b>namespaces 提供隔离视图，cgroup 提供资源额度，capabilities/seccomp 裁掉多余权限。它们全部由<b>宿主内核自己实现</b>，容器里没有任何一份独立的内核代码。' },
          { run: () => { S('ck1', 'hot'); S('cr1', 'done'); },
            note: '<b>★ 关键：宿主内核只有一份，所有容器共用。</b>这就是「合租公寓的承重墙」。它带来两个后果 —— 好处是启动极快、内存占用极低（不需要为每个容器加载一份内核）；代价是<b>内核漏洞一旦被利用，影响的是整栋楼</b>。容器的隔离强度天然低于虚拟机，根源就在这一格。' },
          { run: () => { ['va1','va2','vg1','vg2'].forEach((k) => S(k, 'active')); },
            note: '<b>虚拟机：每个 Guest 自带一套完整内核</b>（含驱动、调度器、内存管理、网络协议栈）。这就是为什么虚拟机镜像动辄 GB 级，而容器镜像可以只有几 MB —— 容器省掉的那部分，正是整个 OS。' },
          { run: () => { S('vv1', 'active'); ['va1','va2','vg1','vg2'].forEach((k) => S(k, 'done')); S('ch1', 'cool'); S('vh1', 'cool'); },
            note: '<b>虚拟机靠 Hypervisor + CPU 硬件虚拟化指令（VT-x / AMD-V）实现隔离。</b>Guest 的每一次特权操作都会被硬件截获并交给 Hypervisor 处理。<b>这是硬件级隔离</b>，与容器的「内核帮忙改个视图」完全不是一个量级 —— 前者是物理隔断，后者是软件约定。' },
          { run: () => { S('k1', 'cool'); S('k2', 'hot'); },
            note: '<b>对比一：隔离强度（虚拟机强）与启动开销（容器小）。</b>注意这两个结论<b>方向相反</b> —— 这正是选型时的核心权衡。云手机厂商大量采用容器方案，赌的就是「密度和成本」，而不是「更强隔离」。<span class="pill warn">具体性能数字随硬件、内核、负载差异很大，不要背数字，记住量级关系即可</span>' },
          { run: () => { S('k2', 'done'); S('k3', 'active'); S('ct1', 'done'); S('ct2', 'done'); },
            note: '<b>对比二：单机密度。</b>容器只是进程，密度受限于内存和 PID 数量；虚拟机每个都要预留一大块内存和磁盘。同一台 128G 的机器，跑十几个虚拟机就到顶了，跑几十上百个容器是常态 —— <b>这就是云手机能「一台宿主机开几百个安卓实例」的底层原因</b>（第 32 章 Waydroid 会用到这个结论）。' },
          { run: () => { S('k3', 'done'); S('k4', 'active'); },
            note: '<b>对比三：一条命令判断你在哪。</b>在容器里 <code>uname -r</code> 返回<b>宿主内核版本</b>；在虚拟机里返回 Guest 自己的。这是最快的判据。<span class="mono">补充判据</span>：<code>systemd-detect-virt</code> 的输出在容器里常为 <code>docker</code>/<code>lxc</code>/<code>podman</code>，在虚拟机里为 <code>kvm</code>/<code>vmware</code>；容器里 <code>cat /proc/1/cgroup</code> 往往能看到容器 ID 的痕迹。' },
          { run: () => { S('k4', 'done'); S('k5', 'hot'); S('ck1', 'hot'); },
            note: '<b>★ 对比四：逃逸难度，方向与直觉相反。</b>很多人默认「容器更轻更现代所以更安全」。事实是：<b>容器逃逸通常只需一个内核漏洞，或一次危险 capability 的滥用；虚拟机逃逸要攻破虚拟化层本身，难度高一个档次。</b>记住这句话 —— 它既是安全常识，也是下一节「风控怎么发现你」的伏笔。' }
        ]
      },
      quiz: {
        id: 'q17-1', chapter: 17,
        answer: 2,
        stem: '你远程连上一台「云手机」，想确认它的底座到底是容器还是虚拟机。下面哪一组命令的输出，能<b>最直接地</b>证明它跑在容器里？',
        options: [
          { t: '<code>uname -m</code> 返回 <code>aarch64</code>', why: '这只说明用户态/内核报告的机器架构是 ARM64，和「容器还是虚拟机」完全无关。真机、模拟器、容器、虚拟机都可能是 aarch64。' },
          { t: '<code>cat /proc/cpuinfo</code> 里出现了 QEMU 的字样', why: '这指向的是<b>模拟器</b>（QEMU 模拟 CPU），不是容器。容器共享宿主内核、不模拟 CPU，所以这条判据方向整个错了。' },
          { t: '<code>cat /proc/1/cgroup</code> 里出现形如 <code>/docker/&lt;一长串ID&gt;</code> 的路径', why: '正确。cgroup 路径记录了 1 号进程被放进了哪个 cgroup 层级，容器的 1 号进程是被运行时创建并放进专属 cgroup 的，路径里因此带着容器 ID 或编排系统前缀（kubepods 等）。<b>这是最硬的容器指纹之一。</b>' },
          { t: '<code>df -h</code> 显示根分区容量很小', why: '容量小只能说明磁盘配得小，真机也可以是小容量分区。虽然容器镜像确实通常很小，但它不是判据 —— 判据要能反映「机制」而不是「习惯」。' }
        ],
        explain: '<b>判据必须来自机制本身，而不是经验观察。</b><code>/proc/1/cgroup</code> 之所以可靠，是因为它直接读出了「1 号进程属于哪个 cgroup」这个内核事实 —— 而 Docker/K8s/LXC 都会为容器主进程建立专属的 cgroup 层级，路径名就是证据。<br><br>其他几条佐证（组合起来更硬）：<code>uname -r</code> 返回宿主内核版本、<code>/.dockerenv</code> 文件存在、网卡名带 <code>@ifN</code> 后缀、IP 落在 172.17/172.18 网段、主机名是随机十六进制。<b>注意 <code>/.dockerenv</code> 是「有则可疑，无则不能证明不是」</b> —— 它可以被删掉。<br><br>把能力用在本章上：判断底座决定了你后续能用哪些调试手段（容器里通常没有内核模块权限），所以这应该是接手任何云环境时的<b>第一步</b>。'
      },
      after:
        T.note('key', '🔑 这对逆向 / 环境伪装有什么用', '<p>① <b>判断自己在哪：</b>拿到一台「云手机」或「云真机」，第一件事就是确定底座是容器还是虚拟机 —— <code>uname -r</code>、<code>/.dockerenv</code>、<code>/proc/1/cgroup</code> 三连就能定性，这决定了你后续能用哪些提权/调试手段。</p>'
          + '<p>② <b>利用共享内核：</b>容器共享宿主内核意味着<b>宿主上装了什么模块，容器里就可能用得上</b>（取决于权限和 seccomp）——<code>ebpf</code> 抓包、<code>perf</code>、某些内核接口在虚拟机里根本不存在，在容器里却可能可用（第 25 章 eBPF 与这一章合起来看会很有感觉）。</p>'
          + '<p>③ <b>反检测意识：</b>风控识别模拟器/云手机时，容器特征（挂载表、cgroup 路径、网络握手特征）是重要证据链之一。你要先知道「特征从哪来」，才谈得上伪装。</p>'
          + '<p>④ <b>能力规划：</b>容器里往往没有完整 <code>/sys</code>、没有内核模块权限，所以依赖内核模块的调试方案（部分内核态 Hook、自定义驱动）在容器化云手机上会直接失效 —— <b>选方案前先确认底座</b>。</p>')
    },

    /* ============ 31.4 ============ */
    {
      h: '31.4',
      title: 'namespaces API 实战：三个系统调用，七个标志',
      html:
        '<p>namespace 在用户态只有三个入口，把这三个函数记住，你就掌握了容器隔离的全部 API 面。</p>'
        + T.tbl(['系统调用', '作用', '典型场景'], [
            ['<code>clone()</code>', '创建一个<b>新进程</b>，并在创建时指定它进入哪些新命名空间', '运行时的入口：容器主进程就是这么来的'],
            ['<code>unshare()</code>', '让<b>当前进程</b>脱离某个命名空间，进入一个新的', '实验、<code>unshare</code> 命令行工具、rootless 工具链'],
            ['<code>setns()</code>', '让当前进程<b>加入一个已存在的</b>命名空间', '<code>docker exec</code>、<code>nsenter</code>、调试已运行的容器']
          ])
        + '<p>七个标志（<code>clone()</code> / <code>unshare()</code> 共用）对照表 —— 这张表建议直接背下来：</p>'
        + T.tbl(['标志', '隔离什么', '备注'], [
            ['<code>CLONE_NEWPID</code>', 'PID 命名空间：容器内进程从 <b>PID 1</b> 开始，看不到宿主机其他进程', '★<b>只对之后 fork 出的子进程生效</b>'],
            ['<code>CLONE_NEWNET</code>', '网络命名空间：独立网卡、路由表、iptables、端口空间', '新命名空间里默认只有 down 的 <code>lo</code>'],
            ['<code>CLONE_NEWNS</code>', 'Mount 命名空间：独立挂载点视图', '★<b>叫 NEWNS 不叫 NEWMNT</b>，历史原因，高频考点'],
            ['<code>CLONE_NEWUTS</code>', '主机名与域名隔离', 'UTS = UNIX Time-sharing System，历史名称'],
            ['<code>CLONE_NEWIPC</code>', 'System V IPC 与 POSIX 消息队列隔离', '防止容器间通过共享内存「串门」'],
            ['<code>CLONE_NEWUSER</code>', '用户与用户组 ID 映射', '<b>rootless 容器的基础</b>：非 root 也能造容器'],
            ['<code>CLONE_NEWCGROUP</code>', 'cgroup 根目录视图隔离', '容器里 <code>cat /proc/self/cgroup</code> 看到的是自己的根']
          ])
        + T.note('bad', '❌ 最容易踩的坑：PID 不是立刻就变 1', '<p>调用 <code>unshare(CLONE_NEWPID)</code> 之后，<b>当前进程的 PID 不会改变</b>，它仍然是宿主机命名空间里的那个 PID。原因：PID 命名空间是在<b>进程创建时</b>绑定到进程上的。你必须再 <code>fork()</code> 一次，让子进程成为新命名空间的第一个进程（PID 1），或者干脆用 <code>clone(CLONE_NEWPID)</code> 直接带着标志创建子进程。<b>「unshare 完 PID 没变、以为内核不支持」是新手第一大坑</b>，下一个决策演练就是它。</p>')
        + T.note('', '🔍 怎么查看当前的命名空间', '<p>每个进程在 <code>/proc/&lt;pid&gt;/ns/</code> 下都有一组软链接指向自己所属的各命名空间：<code>ls -l /proc/self/ns/</code> 会列出 <code>cgroup ipc mnt net pid pid_for_children user uts</code>。括号里的 <code>pid:[4026531836]</code> 这样的编号就是命名空间 inode 号 —— <b>两个进程的这个号相同，就说明它们共享同一个命名空间</b>。命令行工具 <code>lsns</code> 可以一次性列出系统里所有命名空间及其中进程数。<span class="pill warn">不同内核版本的 /proc 视图与 lsns 输出字段略有差异，待核实</span></p>')
        + T.note('warn', '⚠️ 组合使用的权限讲究', '<p><code>CLONE_NEWUSER</code> 比较特殊：<b>它能让非特权用户创建其他命名空间</b>（先建 user namespace，在里面「成为 root」，再用这份名义上的权限去建 net/pid namespace）。但代价是新 user namespace 里的 root 在宿主机上<b>依然不是真正的 root</b>，只是被映射到某个普通 UID —— 这带来大量后续限制（比如某些挂载类型仍然不允许）。<b>「rootless 容器能跑，但有些事就是做不到」的根源就在这里。</b></p>'),
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一 · 我以为内核不支持 PID namespace',
            scenario: '<b>情境：</b>你要亲手验证 PID 隔离。你写了一段 C：先调 <code>unshare(CLONE_NEWPID)</code>，紧接着 <code>printf(&quot;%d&quot;, getpid())</code>，期待看到 <code>1</code>。<br><br>'
              + '结果打印出来是 <code>18422</code> —— 一个宿主机上的普通 PID。<code>unshare</code> 的返回值是 0，没有报错。<br><br>'
              + '你接下来怎么做？',
            choices: [
              { t: '怀疑内核没开 PID 命名空间支持，去查 config、换台机器或重新编译内核', next: 'n1' },
              { t: '在 unshare 之后再 fork() 一次，让子进程打印自己的 PID', next: 'n2' },
              { t: '改用 setns() 加入 /proc/1/ns/pid，把当前进程搬进去', next: 'n3' },
              { t: '再加上 CLONE_NEWUSER 一起 unshare，这样才有权限让 PID 变成 1', next: 'n4' }
            ]
          },
          n1: {
            label: '选 A', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：这不是内核支持问题',
            result: '<b>认知根源：把「机制没生效」直接归因于「功能不存在」。</b><code>unshare</code> 返回 0 就已经说明内核<b>接受</b>了这个请求、命名空间创建成功了 —— 只是<b>当前进程不会因此换 PID</b>。<br><br>'
              + '真正的原因：PID 命名空间在<b>进程被创建的那一刻</b>绑定到进程结构上，<code>unshare</code> 只是给「之后创建的子进程」准备好了新的命名空间。所以当前进程的 <code>getpid()</code> 当然还是老值。<br><br>'
              + '<b>正确做法：</b><code>unshare(CLONE_NEWPID)</code> 之后立刻 <code>fork()</code>，子进程就是新命名空间的 PID 1；或者在 <code>fork()</code> 的子进程里做 unshare + 再 fork。用 <code>clone(CLONE_NEWPID)</code> 一次到位也可以。<br><br>'
              + '<b>迁移经验：</b>凡是「调用了没反应」，先查这个机制的<b>生效时机</b>（创建时？写文件时？下一次系统调用时？），不要急着怀疑内核没编进去。'
          },
          n2: {
            label: '选 B', terminal: true, verdict: 'good',
            verdictTitle: '正确：PID 命名空间只对之后创建的子进程生效',
            result: '<b>这就是标准答案。</b>改造后的骨架大致是：<code>unshare(CLONE_NEWPID)</code> → <code>pid = fork()</code> → 子进程里 <code>getpid()</code> 得到 <b>1</b>。<br><br>'
              + '<b>为什么必须这样：</b>PID 命名空间是一棵<b>树</b>，每个命名空间有自己的 PID 编号体系。新命名空间的第一个进程（PID 1）同时承担特殊职责 —— 它是这个命名空间的 init：<b>它挂了，整个命名空间的进程都会被内核杀掉</b>；它还要负责回收孤儿进程。<br><br>'
              + '<b>顺带记住两个推论：</b>① 容器里 PID 1 必须是能正确处理信号、能回收子进程的程序，否则一 <code>kill</code> 就带崩整个容器，这正是 <code>--init</code> 选项存在的理由；② 新 PID 命名空间会自动挂载一个新的 <code>procfs</code>，你之后必须重新 <code>mount -t proc</code>，否则 <code>/proc</code> 里看到的还是宿主的进程列表。<br><br>'
              + '<b>验证一下：</b><code>unshare --pid --fork --mount-proc /bin/bash</code>，然后 <code>echo $$</code> 应该得到 1。'
          },
          n3: {
            label: '选 C', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：setns 搬的是「加入已有的」，解决不了你的问题',
            result: '<b>认知根源：把三个系统调用的职责混为一谈。</b><code>setns()</code> 的语义是「<b>加入一个已经存在的</b>命名空间」，而 <code>/proc/1/ns/pid</code> 恰恰是<b>宿主机自己的</b> PID 命名空间 —— 你搬进去等于原地不动，甚至可能因为权限不足直接失败（<code>setns</code> 到 PID 命名空间需要 <code>CAP_SYS_ADMIN</code>）。<br><br>'
              + '<b>三者的正确分工：</b><code>clone</code> = 创建进程并进入新命名空间；<code>unshare</code> = 当前进程脱离旧的、进入新的；<code>setns</code> = 加入别人已经建好的。<br><br>'
              + '<b>setns 真正的用武之地：</b><code>docker exec</code> 要钻进一个正在运行的容器，靠的就是 setns；调试时用 <code>nsenter -t &lt;pid&gt; -n</code> 借一个进程的网络命名空间来抓包，也是它。<b>它的方向永远是「进去」，不是「新建」。</b>'
          },
          n4: {
            label: '选 D', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：权限不是这里的原因，而且加错顺序会更糟',
            result: '<b>认知根源：把「权限不足」当成了万能解释。</b>你的 <code>unshare</code> 明明返回了 0，说明权限<b>没问题</b>（root 拥有 <code>CAP_SYS_ADMIN</code>）。加 <code>CLONE_NEWUSER</code> 不会让当前进程的 PID 变成 1，问题照样存在。<br><br>'
              + '<b>而且这里有真实的顺序陷阱：</b>同时 unshare user + pid 时，正确的姿势是<b>先建 user namespace、在里面写 uid_map/gid_map 拿到名义权限，再建 pid namespace</b>。顺序写反或忘了写映射文件，会得到一个「里面什么都不敢做」的命名空间，报出各种 <code>EPERM</code>，比原来的问题更难查。<br><br>'
              + '<b>思维习惯：</b>调用的返回值是判断权限的最直接证据 —— <b>返回 0 就代表内核已经答应了你的请求</b>，此时应该去查「语义/时机」，而不是继续加权限。'
          }
        }
      },
      after: '<p>三个系统调用 + 七个标志 + 一个 fork 时机，这就是容器隔离的全部原料。下一节我们不再用现成工具，<b>自己写一个迷你容器</b> —— 把 rootfs、mount、pivot_root、exec 全部手工串一遍。</p>'
    },

    /* ============ 31.4L 动手实验 ============ */
    {
      h: '31.4L', title: '动手实验：为一个需求挑选正确的 namespace 组合',
      html:
        '<p>七个 namespace 标志不难记，难的是<b>面对一个具体需求，知道该开哪几个</b>。' +
        '这个实验给你三个真实场景，你来选。</p>',
      lab: {
        title: '实验：给需求配 namespace',
        goal: '目标：按需选标志，不多不少',
        intro:
          '<p>下面是一个具体需求：</p>' +
          '<div class="note key" style="margin:12px 0"><div class="note-h">🎯 需求</div>' +
          '<p style="margin-bottom:0">你要做一个"进程沙箱"，用来安全地跑一段<b>不可信的第三方代码</b>。要求：<br>' +
          '① 这段代码<b>看不到宿主机的其他进程</b>（也不能 kill 它们）<br>' +
          '② 它写文件时<b>不能污染宿主机文件系统</b>，要用一份独立的根目录<br>' +
          '③ 它<b>不能改主机名</b>，以免影响宿主机上的服务<br>' +
          '④ 它<b>不能占用宿主机已用的端口</b>（比如 80、443）<br>' +
          '⑤ 它<b>不能创建超过 100 个进程</b>，防止 fork 炸弹<br>' +
          '⑥ <b>不需要</b>限制 CPU 和内存（这段代码本身就是短任务）</p></div>' +
          '<p><b>任务：从七个 namespace 标志里选出需要的，并说明⑤⑥分别属于什么机制。</b></p>',
        inputs: [
          { key: 'flags', label: '① 需要哪些 namespace 标志？（可多选，用空格分隔）',
            hint: '写简称即可，如 PID NET MNT UTS IPC USER CGROUP', ph: '例如 PID MNT UTS' },
          { key: 'forkbomb', label: '② 需求⑤（限制进程数）靠什么机制实现？',
            hint: '不是 namespace', ph: 'namespace 还是 cgroup？还是别的？', type: 'textarea', rows: 2 }
        ],
        runLabel: '🔍 校验我的方案',
        run: (v) => {
          const need = {
            PID:  { want: true,  why: '① 隔离进程视图 —— 容器内看不到宿主机进程，也杀不了。注意：CLONE_NEWPID 后需要再 fork 一次，当前进程才会进入新 PID 命名空间。' },
            MNT:  { want: true,  why: '② 挂载命名空间 —— 独立挂载点视图，配 pivot_root 换根，文件写入落在自己的 rootfs 里。' },
            UTS:  { want: true,  why: '③ 隔离主机名与域名 —— 容器内改 hostname 不影响宿主机。' },
            NET:  { want: true,  why: '④ 网络命名空间 —— 独立网卡/IP/端口空间，容器内绑 80 端口不与宿主机冲突。' },
            IPC:  { want: false, why: '需求里没提 IPC。虽然实践中常一起开（避免共享 System V IPC / 消息队列造成干扰），但不是这个需求的必需项。' },
            USER: { want: false, why: '需求没要求"非 root 也能创建容器"。USER 命名空间是 rootless 容器的基础，属于额外加分项而非必需。' },
            CGROUP:{ want: false, why: 'CGROUP 命名空间只是隔离 cgroup 根目录的<b>视图</b>，它本身不提供限制能力。限制要靠 cgroup 控制器。' }
          };

          const picked = String(v.flags || '').toUpperCase()
            .split(/[\s,，、]+/).filter(Boolean)
            .map(s => ({ 'PIDNS': 'PID', 'MNTNS': 'MNT', 'MOUNT': 'MNT', 'NS': '', 'CLONE_NEWPID': 'PID',
                         'CLONE_NEWNET': 'NET', 'CLONE_NEWNS': 'MNT', 'CLONE_NEWUTS': 'UTS',
                         'CLONE_NEWIPC': 'IPC', 'CLONE_NEWUSER': 'USER', 'CLONE_NEWCGROUP': 'CGROUP' }[s] || s))
            .filter(Boolean);

          let html = '<table class="lab-tbl"><tr><th>标志</th><th>需求是否需要</th><th>你的选择</th><th>说明</th></tr>';
          let correct = 0, total = 0;
          for (const [f, info] of Object.entries(need)) {
            const has = picked.includes(f);
            const ok = has === info.want;
            if (ok) correct++;
            total++;
            html += '<tr class="' + (ok ? 'same' : 'diff') + '">'
              + '<td><code>' + f + '</code></td>'
              + '<td>' + (info.want ? '<b>需要</b>' : '非必需') + '</td>'
              + '<td>' + (has ? '选了' : '没选') + ' ' + (ok ? '✅' : '❌') + '</td>'
              + '<td style="font-size:12px">' + info.why + '</td></tr>';
          }
          html += '</table>';

          // 未知项
          const unknown = picked.filter(p => !(p in need));
          if (unknown.length) {
            html += '<div class="lab-msg warn"><b>⚠️ 有无法识别的项</b>'
              + '<div class="lab-note">' + unknown.join('、') + ' —— 请用 PID / NET / MNT / UTS / IPC / USER / CGROUP 这些简称。</div></div>';
          }

          const score = unknown.length ? 0 : correct;
          html += '<div class="lab-msg ' + (score === total ? 'pass' : score >= 4 ? 'warn' : 'fail') + '">'
            + '<b>' + (score === total ? '✅ 完全正确' : score >= 4 ? '🟡 大体对了，有偏差' : '❌ 偏差较大')
            + '（' + score + '/' + total + '）</b>'
            + '<div class="lab-note">正确答案：<b>PID + MNT + UTS + NET</b> 四个。<br>'
            + '口诀：<b>① 看得见什么（PID）② 写在哪儿（MNT）③ 叫什么名字（UTS）④ 网络怎么走（NET）</b>——' +
            '前四个需求正好一一对应这四个标志。</div></div>';

          // 第②问
          const fb = String(v.forkbomb || '').trim();
          if (fb) {
            const hitCg = window.AKKC_hasConcept(fb, ['cgroup', '控制组', 'pids.max', 'pids', '资源限制']);
            const hitNs = window.AKKC_hasConcept(fb, ['namespace', '命名空间']);
            html += '<div class="lab-msg ' + (hitCg && !hitNs ? 'pass' : 'warn') + '">'
              + '<b>' + (hitCg && !hitNs ? '✅ 正确：靠 cgroup 的 pids 控制器' : '🟡 再想想') + '</b>'
              + '<div class="lab-note">'
              + '限制进程数属于<b>资源限制</b>，是 <b>cgroup</b> 的职责，不是 namespace 的。<br>'
              + '具体用 <code>pids</code> 控制器：写 <code>pids.max = 100</code>，' +
              '再把进程加入对应的 <code>cgroup.procs</code>。<br><br>'
              + '<b>关键区分（本章最重要的那句话）：</b><br>'
              + '<b>namespace 管"看不看得见"（隔离），cgroup 管"能⽤多少"（限制）。</b><br>'
              + '它们解决的是两类完全不同的问题，容器 = 两者 + rootfs + capabilities。'
              + '</div></div>';
          }
          return html;
        },
        expected: (v) => {
          const want = ['PID', 'MNT', 'UTS', 'NET'];
          const picked = String(v.flags || '').toUpperCase()
            .split(/[\s,，、]+/).filter(Boolean)
            .map(s => ({ 'CLONE_NEWPID': 'PID', 'CLONE_NEWNET': 'NET', 'CLONE_NEWNS': 'MNT',
                         'CLONE_NEWUTS': 'UTS', 'CLONE_NEWIPC': 'IPC', 'CLONE_NEWUSER': 'USER',
                         'CLONE_NEWCGROUP': 'CGROUP' }[s] || s));
          const extra = picked.filter(p => !want.includes(p));
          const miss = want.filter(w => !picked.includes(w));
          const ok = extra.length === 0 && miss.length === 0;
          return {
            ok,
            detail: ok
              ? '<b>完全正确：PID + MNT + UTS + NET。</b><br>' +
                '前四个需求恰好一一对应这四个标志 —— 这不是巧合，' +
                '而是因为<b>每个 namespace 都对应一类"共享资源"</b>：进程表、挂载表、主机名、网络栈。<br>' +
                '需求⑤（进程数）不属于隔离而是<b>限制</b>，归 cgroup 的 <code>pids</code> 控制器。'
              : (miss.length ? '<b>漏了：' + miss.join('、') + '</b><br>' : '')
                + (extra.length ? '<b>多选了：' + extra.join('、') + '</b>（不是错，但按"最小必要"原则可以不选）<br>' : '')
                + '正确答案是 <b>PID + MNT + UTS + NET</b>。<br>' +
                '对照需求：① 看不到别的进程→PID；② 不污染文件系统→MNT；③ 不改主机名→UTS；④ 不占端口→NET。'
          };
        },
        showAnswer:
          '【① 需要的 namespace】PID + MNT + UTS + NET 四个\n\n' +
          '  需求① 看不到宿主机进程     → CLONE_NEWPID\n' +
          '  需求② 独立根目录、不污染   → CLONE_NEWNS（Mount）\n' +
          '  需求③ 不改主机名           → CLONE_NEWUTS\n' +
          '  需求④ 不占用宿主端口       → CLONE_NEWNET\n\n' +
          '  IPC / USER / CGROUP 非必需：\n' +
          '    IPC   — 需求没提共享内存/消息队列\n' +
          '    USER  — 需求没要求非 root 也能创建容器（那是 rootless 场景）\n' +
          '    CGROUP— 只隔离 cgroup 根目录的"视图"，本身不提供限制能力\n\n' +
          '【② 限制进程数靠什么】cgroup 的 pids 控制器（不是 namespace）\n\n' +
          '  写 cgroup v2: /sys/fs/cgroup/<组>/pids.max = 100\n' +
          '  再把进程 pid 写入 cgroup.procs\n\n' +
          '【核心区分】\n' +
          '  namespace = 隔离"看不看得见"（进程表/挂载表/主机名/网络栈…）\n' +
          '  cgroup    = 限制"能用多少"（CPU/内存/进程数/IO）\n' +
          '  容器 = namespaces + cgroup + rootfs + capabilities/seccomp',
        hint:
          '把六个需求逐条翻译成"要隔离什么资源"：<br>' +
          '① 进程表　② 挂载表　③ 主机名　④ 网络栈<br>' +
          '每一个都对应一个 namespace。<br><br>' +
          '第⑤条要小心：<b>"限制数量"和"隔离视图"是两回事</b>——' +
          'namespace 让你看不见别人，但不能阻止你自己创建 10000 个进程。那该由谁来管？',
        after:
          T.note('ok', '✅ 实验的收获',
            '<p style="margin-bottom:0">你现在有了一个可复用的判断方法：' +
            '<b>把需求翻译成"要隔离哪类共享资源"，再去找对应的 namespace。</b><br>' +
            '七个标志记不住也没关系——记住它们的<b>语义分类</b>就够了：<br>' +
            '• 进程相关：PID、IPC<br>• 文件系统相关：MNT、CGROUP<br>' +
            '• 身份与网络：UTS、USER、NET<br><br>' +
            '<span class="hit">另外记住那条分界线：namespace 管"看不看得见"，cgroup 管"能用多少"。' +
            '分不清这两者，是新手设计容器方案时最常见的错误。</span></p>')
      }
    },

    /* ============ 31.4C 实战案例 ============ */
    {
      h: '31.4C', title: '实战案例：把 Android 装进 Docker —— redroid 与 adb 认证改造',
      case: {
        source: 'kanxue',
        title: '[原创]redroid 镜像编译及预埋 adb_key 认证',
        date: '2025-6-6',
        author: 'CCTV果冻爽',
        target: 'redroid（Android-in-Docker 容器方案）跑在香橙派 5 Max（ARM64 板卡）',
        background:
          '<p>第 31 章讲的容器化原理（namespaces + cgroup + rootfs），在真实项目里长什么样？' +
          'redroid 就是那个把 Android 系统整套塞进 Docker 容器的方案——你不再需要一台手机或一台虚拟机，' +
          '在 ARM64 板卡（甚至服务器）上就能跑起一个完整的 Android。</p>' +
          '<p>但装进去只是第一步。真正麻烦的是<b>装进去之后怎么管</b>。这个案例讲的正是第二件事：' +
          '作者要在 Android <b>12 user 版</b>（注意是 user 版，不是 userdebug）上实现<b>免配对的 adb 认证</b>——' +
          '即预埋公钥，让 adb 连进来时不用点确认框。</p>' +
          '<p>为什么需求这么具体？因为容器的价值在于<b>自动化批量管理</b>。' +
          '如果每次连接都要人工点一下"允许 USB 调试"，那 100 个容器就是 100 次手工操作，容器化就失去意义了。</p>',
        points: [
          '<code>device/redroid/AndroidProducts.mk</code> 新增 <code>redroid_arm64-user</code> 产品，增加 <b>user 模式</b>编译目标',
          '新增 <code>adb_keys</code>（存放 adb 认证公钥）与 <code>preinstall.sh</code>（首次开机把 adb_keys 拷到 <code>data/system</code>）',
          '改 <code>build/target/product/base_product.mk</code>，打包时把 <code>adb_keys</code> / <code>preinstall</code> 相关文件拷进镜像',
          '改 <code>system/core/rootdir/init.rc</code>，在 <code>on boot</code> 末尾新增执行 <code>preinstall.sh</code>',
          '<b>SELinux 五处改动</b>：<code>sepolicy/private/file_contexts</code>、' +
            '<code>prebuilts/api/31.0/private/file_contexts</code>、新增 <code>preinstall.te</code>（两份）、' +
            '以及 <code>init.te</code>（两份）',
          '改 <code>frameworks/native/libs/adbd_auth/adbd_auth.cpp</code>，在认证路径中新增 <code>/data/system/adb_keys</code>',
          '改 <code>frameworks/base/services/core/java/com/android/server/adb/AdbDebuggingManager.java</code>',
          '开机启动 adb 服务：改 <code>AdbService.java</code> + <code>system/core/rootdir/init.usb.rc</code>',
          '延长 adb 连接过期时间：改 <code>frameworks/base/core/java/android/provider/Settings.java</code>',
          '<b>保持 adb root</b>：改 <code>packages/modules/adb/daemon/main.cpp</code>，' +
            '令 <code>should_drop_privileges()</code> <b>返回 false</b>'
        ],
        method: [
          '<b>拉 Android 12 源码</b>，在 <code>AndroidProducts.mk</code> 里加一个 user 模式的 redroid 产品',
          '<b>准备免配对材料</b>：放好 <code>adb_keys</code> 与首次开机会自动执行的 <code>preinstall.sh</code>',
          '<b>打通打包链路</b>：改 <code>base_product.mk</code> 让这两个文件进镜像',
          '<b>打通执行时机</b>：改 <code>init.rc</code>，在 <code>on boot</code> 末尾触发 preinstall.sh',
          '<b>放开 SELinux 限制</b>：新增 <code>preinstall.te</code> 并改 <code>file_contexts</code> 与 <code>init.te</code>，' +
            '否则 init 无权执行脚本、无全新文件的安全上下文',
          '<b>改 adbd 认证路径</b>：让 <code>adbd_auth.cpp</code> 认 <code>/data/system/adb_keys</code>，再改 ' +
            '<code>AdbDebuggingManager.java</code> 配合',
          '<b>编译刷板验证</b>：烧进香橙派 5 Max，确认 adb 免配对直连且保持 root'
        ],
        result:
          '<p>Android 12 <b>user 版</b>的 redroid 实现了两项改造：</p>' +
          '<p>① <b>免配对 adb 认证</b>——通过预埋 <code>/data/system/adb_keys</code>，adb 连接无需人工确认；</p>' +
          '<p>② <b>保持 adb root</b>——<code>should_drop_privileges()</code> 返回 false 让 adbd 不降权。</p>' +
          '<p>这两项合起来，才让"在板卡上批量跑 Android 容器"具备了自动化管理的前提。</p>',
        terms: ['redroid', 'Android-in-Docker', 'init.rc', 'SELinux file_contexts', 'adbd_auth', 'user 构建变体', 'preinstall', 'AdbDebuggingManager'],
        limits:
          '<p><b>⚠️ 这个案例的步骤不可完整复现</b>——作者自己写道：' +
          '「编译时如果还有其他 selinux 问题，自行看提示解决。<b>因为我也忘了还修改了哪些</b>」，' +
          '且"9）其它可能需要修改"一节<b>内容为空</b>。</p>' +
          '<p>更关键的是：正文的多个命令与配置以 <b>webp 截图</b>呈现（至少 6 处：板卡实物图、' +
          '<code>adb_keys</code> 与 preinstall 目录结构图、<code>preinstall.sh</code> 内容图、' +
          '<code>base_product.mk</code> 改动图、<code>init.rc</code> 改动图、SELinux 各文件内容图），' +
          '<b>这些截图无法读取</b>，因此具体的 shell 内容、mk 语法、te 规则文本均缺失。</p>' +
          '<p>结论：本文适合作为<b>"改哪些文件"的索引</b>，但<b>不能当作可照抄的教程</b>。' +
          '另外正文末尾的「回复或点赞可查看完整内容」经核验仅为 CSS 遮罩，其后确实没有更多文字。</p>',
        analysis:
          '<p><b>本课第 31 章讲的核心是"容器 = namespaces + cgroup + rootfs + capabilities/seccomp"。</b>' +
          '这个案例正好把其中的 <b>rootfs</b> 那一块落到了实处——' +
          '而且它揭示了一个课本上不会写、但工程上绕不开的事实：' +
          '<b>把 Android 塞进容器之后，你会立刻撞上 SELinux。</b></p>' +
          '<p><b>① 为什么改一个 adb 认证要动这么多地方？</b>' +
          '看作者的改动清单：打包（<code>base_product.mk</code>）→ 触发（<code>init.rc</code>）→ ' +
          '权限（<code>file_contexts</code> + <code>preinstall.te</code> + <code>init.te</code>）→ ' +
          '认证逻辑（<code>adbd_auth.cpp</code> + <code>AdbDebuggingManager.java</code>）。' +
          '<span class="hit">这是 Android 的典型特征：一个功能的实现被拆到构建系统、启动脚本、' +
          '安全策略、框架代码四个层面。缺任何一层都不工作。</span>' +
          '其中 <b>init.rc 的执行时机</b>和 <b>SELinux 上下文</b>是最容易漏的两环——' +
          '文件放进镜像了 ≠ 开机会被执行 ≠ 执行时有权限。</p>' +
          '<p><b>② user 版这个细节很关键。</b>作者特意新增 <code>redroid_arm64-user</code> 产品去编译 <b>user</b> 模式，' +
          '而不是图省事用 userdebug。为什么？<b>因为 user 版才是真实设备的形态</b>——' +
          'adb root 默认关闭、SELinux 强制、调试接口收紧。' +
          '在 userdebug 上跑通的方案，搬到 user 版上大概率失败；' +
          '反过来先在 user 版上走通，方案的可靠性才站得住。' +
          '这跟第 29 章"伪装要经得起交叉验证"是同一种思路：<b>在更严格的条件下验证，结论才可信。</b></p>' +
          '<p><b>③ 最该学的其实是作者的诚实。</b>' +
          '他直接写"我也忘了还修改了哪些"，并且把关键配置留成截图而不是文本。' +
          '这提醒我们：<b>社区案例的价值往往在"改哪些文件"这个索引上，' +
          '而不在"照抄就能用"</b>。真正要复现时，还是得对着目标版本的 AOSP 源码自己走一遍——' +
          '这正是本课反复强调的"护城河在原理，不在步骤"。</p>',
        link: 'https://bbs.kanxue.com/thread-287127.htm',
        linkNote: '看雪论坛原创帖（关键配置为截图，步骤不可完整复现）'
      }
    },

    /* ============ 31.5 ============ */
    {
      h: '31.5',
      title: '命令行实现 Docker：手写一个迷你容器',
      html:
        '<p>前面讲了原理，现在动手。下面这段 C 大约 40 行，<b>它就是一个可用的容器运行时</b> —— 没有 containerd、没有 runc、没有镜像分层，只有内核 API 本身。把它读懂、跑通，你对 Docker 的敬畏就会变成掌控。</p>'
        + '<p>先看它的整体骨架，一共七件事，缺一不可：' + T.term('clone', '创建新进程并按标志进入新命名空间，容器运行时的真正入口') + ' → '
        + T.term('MS_PRIVATE', '把挂载事件设为私有，防止容器里的挂载传播回宿主机') + ' → '
        + T.term('MS_BIND', '绑定挂载，让目录本身成为一个挂载点（pivot_root 的前置条件）') + ' → '
        + T.term('pivot_root', '真正交换根文件系统的系统调用，容器的标准做法') + ' → '
        + T.term('procfs 重挂', '换根后必须重新挂载 /proc，否则 ps 等工具全废') + ' → '
        + T.term('sethostname', '在 UTS 命名空间里改主机名，不影响宿主机') + ' → '
        + T.term('execv', '用目标程序替换当前进程映像，成为容器里的 PID 1') + '。</p>'
        + T.note('warn', '⚠️ 先准备 rootfs，否则跑不起来', '<p>这段代码假设当前目录下有一个名为 <code>rootfs</code> 的目录，里面是一套可用的最小文件系统。<b>没有它就只能等到 chroot 之后 exec 失败。</b>怎么造？两条路：① 用 busybox 手工搭（<code>busybox --install -s ./rootfs/bin</code>，最省事）；② 用 <code>debootstrap</code> 拉一套 Debian/Ubuntu（31.11 详细讲）。<b>注意：宿主和 rootfs 的架构必须一致</b>（除非你按 31.10 配好了 binfmt + QEMU 跨架构执行）。</p>'),
      stepper: {
        title: 'mini-container.c —— 逐行拆解一个容器运行时',
        lines: [
          {
            code: '<span class="k">int</span> flags = <span class="t">CLONE_NEWPID</span> | <span class="t">CLONE_NEWNS</span> | <span class="t">CLONE_NEWUTS</span> | <span class="t">CLONE_NEWIPC</span>;',
            note: '<b>第 1 件事：决定要几根柱子。</b>PID（进程视图）、NS（挂载视图）、UTS（主机名）、IPC（进程间通信）四个。<b>故意没写 CLONE_NEWNET</b> —— 网络命名空间的网卡需要在<b>宿主机侧</b>创建 veth 再塞进去，所以通常由运行时在外面配好，而不是在这里开空网络（开了也只有一个 down 的 lo）。',
            state: { '当前命名空间': '宿主 init 命名空间', '根文件系统': '/ （宿主机）', 'cgroup 限额': '无' }
          },
          {
            code: '<span class="k">mount</span>(<span class="n">NULL</span>, <span class="s">&quot;/&quot;</span>, <span class="n">NULL</span>, <span class="t">MS_REC</span> | <span class="t">MS_PRIVATE</span>, <span class="n">NULL</span>);',
            note: '<b>第 2 件事：把挂载传播切断。</b>这是<b>新手最常漏、后果最严重</b>的一步。默认情况下挂载事件是 shared 的，容器里的挂载会「传播」回宿主机 —— 你在容器里挂了个 tmpfs，宿主机的挂载表里居然也出现了。<code>MS_REC | MS_PRIVATE</code> 让这棵挂载树变成私有的，容器里的操作就出不去了。<b>这是隔离的一部分，不是可选项。</b>',
            state: { '当前命名空间': '宿主 init 命名空间', '根文件系统': '/ （宿主）· 挂载已私有化', 'cgroup 限额': '无' }
          },
          {
            code: '<span class="k">mount</span>(<span class="s">&quot;./rootfs&quot;</span>, <span class="s">&quot;./rootfs&quot;</span>, <span class="n">NULL</span>, <span class="t">MS_BIND</span> | <span class="t">MS_REC</span>, <span class="n">NULL</span>);',
            note: '<b>第 3 件事：把 rootfs 变成「挂载点」。</b>这行看起来莫名其妙 —— 把一个目录挂到它自己身上有什么意义？意义在于 <code>pivot_root</code> 有一条硬性要求：<b>new_root 必须已经是一个挂载点</b>。普通目录不是挂载点，直接调 pivot_root 会拿到 <code>EINVAL</code>。绑定挂载就是为了满足这个前置条件。',
            state: { '当前命名空间': '宿主 init 命名空间', '根文件系统': '/ （宿主）', 'cgroup 限额': '无' }
          },
          {
            code: '<span class="k">chdir</span>(<span class="s">&quot;./rootfs&quot;</span>); <span class="k">mkdir</span>(<span class="s">&quot;oldroot&quot;</span>, <span class="n">0755</span>);',
            note: '<b>第 4 件事：摆好新旧根的位置。</b><code>pivot_root</code> 的第二个参数（put_old）必须是<b>新根目录下的一个子目录</b>，用来临时安置旧根。所以要先进到新根里，再建一个 <code>oldroot</code> 目录。这一步纯粹是准备现场，没有任何魔法。',
            state: { '当前命名空间': '宿主 init 命名空间', '根文件系统': '/ （宿主）· 已进入 ./rootfs', 'cgroup 限额': '无' }
          },
          {
            code: '<span class="k">pivot_root</span>(<span class="s">&quot;.&quot;</span>, <span class="s">&quot;oldroot&quot;</span>);',
            note: '<b>第 5 件事：真正换根。</b>这一行的效果是：当前进程的根目录从宿主 <code>/</code> 变成 <code>./rootfs</code>，而原来的宿主根被挪到了 <code>/oldroot</code> 下面。<b>注意它和 chroot 的本质区别</b> —— pivot_root 是在<b>挂载树层面做交换</b>，旧根成了一个可被卸载的普通挂载点；chroot 只是改了一个指针，旧根依然静静躺在那里，随时可能被绕回去。',
            state: { '当前命名空间': '宿主 init 命名空间（挂载视图已独立）', '根文件系统': '<b>rootfs</b>（旧根在 /oldroot）', 'cgroup 限额': '无' }
          },
          {
            code: '<span class="k">umount2</span>(<span class="s">&quot;/oldroot&quot;</span>, <span class="t">MNT_DETACH</span>); <span class="k">rmdir</span>(<span class="s">&quot;/oldroot&quot;</span>);',
            note: '<b>第 6 件事：把旧根彻底摘掉。</b>少了这一步，容器里就能通过 <code>/oldroot</code> 一路走回宿主机的完整文件系统 —— <b>等于没隔离</b>。<code>MNT_DETACH</code> 是「惰性卸载」：立刻从挂载树里摘除，等没人再引用它时才真正释放。因为此时当前进程的工作目录还挂在旧根上，普通 <code>umount</code> 会报 <code>EBUSY</code>，必须用惰性卸载。<b>这一步做完，「逃回宿主」的路径才真正断掉。</b>',
            state: { '当前命名空间': '宿主 init 命名空间（挂载视图独立）', '根文件系统': '<b>rootfs</b>（旧根已摘除）', 'cgroup 限额': '无' }
          },
          {
            code: '<span class="k">mount</span>(<span class="s">&quot;proc&quot;</span>, <span class="s">&quot;/proc&quot;</span>, <span class="s">&quot;proc&quot;</span>, <span class="n">0</span>, <span class="n">NULL</span>);',
            note: '<b>第 7 件事：重新挂 /proc。</b>换根之后，原来的 <code>/proc</code> 挂载点已经不在视野里了，而新 rootfs 里通常是<b>一个空目录</b>。不重挂的后果非常直观：<code>ps</code> 报错、<code>free</code> 读不到内存、<code>top</code> 一片空白、很多程序启动时读取 <code>/proc/self/...</code> 直接崩。<b>因为挂着新的 PID 命名空间，这里的 /proc 会天然只显示本命名空间的进程</b> —— 隔离是免费获得的。',
            state: { '当前命名空间': '宿主 init ns · <b>PID 视图已隔离</b>', '根文件系统': 'rootfs · /proc 已重挂', 'cgroup 限额': '无' }
          },
          {
            code: '<span class="k">mount</span>(<span class="s">&quot;sysfs&quot;</span>, <span class="s">&quot;/sys&quot;</span>, <span class="s">&quot;sysfs&quot;</span>, <span class="n">0</span>, <span class="n">NULL</span>);',
            note: '<b>第 8 件事：挂 /sys。</b>同理。<code>/sys</code> 暴露的是内核对象（设备、驱动、cgroup 视图）。<b>注意一个坑</b>：容器里挂载 <code>sysfs</code> 通常需要网络命名空间已就绪，否则网卡相关的 sysfs 子树会是空的。至于 <code>/dev</code>，最省事的做法是从宿主机<b>绑定挂载</b>需要的设备节点（如 <code>/dev/null</code>、<code>/dev/zero</code>、<code>/dev/random</code>），或者挂一个 tmpfs 再用 <code>mknod</code> 造节点（需要 <code>CAP_MKNOD</code>）。<b>设备节点的权限控制，正是容器逃逸的经典入口之一。</b>',
            state: { '当前命名空间': '宿主 init ns · PID 视图隔离', '根文件系统': 'rootfs · /proc /sys 已挂', 'cgroup 限额': '无' }
          },
          {
            code: '<span class="k">sethostname</span>(<span class="s">&quot;mini-container&quot;</span>, <span class="n">14</span>);',
            note: '<b>第 9 件事：改主机名。</b>因为带了 <code>CLONE_NEWUTS</code>，这次改名只作用于本命名空间。宿主机上跑 <code>hostname</code> 依然纹丝不动。<b>顺带说一个实战细节</b>：很多程序（尤其是授权类、上报类）会把主机名当作指纹的一部分 —— 容器里主机名是一串随机 ID，这本身就是「我在容器里」的强特征，31.11 会回到这一点。',
            state: { '当前命名空间': 'PID/MNT/UTS/IPC 均已隔离', '根文件系统': 'rootfs', 'cgroup 限额': '无', '主机名': 'mini-container' }
          },
          {
            code: '<span class="k">char</span> *argv[] = { <span class="s">&quot;/bin/sh&quot;</span>, <span class="n">NULL</span> }; <span class="k">execv</span>(<span class="s">&quot;/bin/sh&quot;</span>, argv);',
            note: '<b>第 10 件事：exec，成为 PID 1。</b><code>execv</code> 用目标程序<b>替换当前进程映像</b>，进程号不变 —— 所以这个 shell 就是容器里的 <b>PID 1</b>。回想 31.4 的知识点：PID 1 一旦退出，整个命名空间的所有进程都会被内核清理掉。这就是「容器里不要随便 kill 1 号进程」的原因，也是 <code>--init</code> 参数的意义（插一个真正的 init 来回收僵尸进程）。<b>真实运行时在这一步之前，还会先设置 cgroup、丢 capabilities、装 seccomp 过滤器、切 uid/gid，最后才 exec。</b>',
            state: { '当前命名空间': 'PID 1 = /bin/sh（隔离生效）', '根文件系统': 'rootfs', 'cgroup 限额': '无', '主机名': 'mini-container' }
          },
          {
            code: '<span class="c">/* 宿主机侧，另一个终端：给容器套上额度 */</span>\n<span class="k">echo</span> $PID &gt; /sys/fs/cgroup/mini/cgroup.procs\n<span class="k">echo</span> <span class="s">&quot;50000 100000&quot;</span> &gt; /sys/fs/cgroup/mini/cpu.max\n<span class="k">echo</span> <span class="s">&quot;268435456&quot;</span> &gt; /sys/fs/cgroup/mini/memory.max',
            note: '<b>第 11 件事：补上 cgroup 这一根柱子。</b>注意这步<b>不在容器内部做，而是在宿主机侧做</b>（容器里通常没有权限写 cgroup 文件）。先把容器主进程的 PID 写进 <code>cgroup.procs</code>，它和它的所有子进程就自动归属这个 cgroup；再写 <code>cpu.max</code>（<code>50000 100000</code> 表示每 100ms 周期最多用 50ms CPU，即半个核）和 <code>memory.max</code>（这里 256MB）。<b>没有这一步，你的「容器」只是隔离了视图，却随时能把宿主机吃穿 —— 隔离和限额是两回事。</b>',
            state: { '当前命名空间': '已隔离', '根文件系统': 'rootfs', 'cgroup 限额': '<b>cpu 0.5 核 · mem 256MB</b>' }
          },
          {
            code: '<span class="k">int</span> pid = <span class="k">clone</span>(child, stack + <span class="k">sizeof</span>(stack), flags | <span class="t">SIGCHLD</span>, <span class="n">NULL</span>);\n<span class="k">waitpid</span>(pid, <span class="n">NULL</span>, <span class="n">0</span>);',
            note: '<b>回到入口：一切从这里开始。</b><code>clone()</code> 带着四个 <code>CLONE_NEW*</code> 标志创建子进程 —— <b>这一个调用就是「创建容器」的全部内核动作</b>。<code>stack</code> 是给子进程准备的栈空间（glibc 的 clone 封装要求调用者自己提供）。<code>SIGCHLD</code> 标志不能少，否则父进程 <code>waitpid</code> 会一直等不到子进程退出。<br><br><b>回头看：整个「容器」就是这一次 clone + 换根 + 挂 proc + 写 cgroup。</b>Docker 在它上面加的是镜像分层、网络编排、卷管理、日志、健康检查、重启策略 —— <b>全是工程封装，没有新的内核魔法</b>。这就是本章最想让你带走的一句话。',
            state: { '当前命名空间': '<b>新容器已创建</b>', '根文件系统': 'rootfs', 'cgroup 限额': 'cpu 0.5 核 · mem 256MB' }
          }
        ]
      },
      after: T.note('ok', '✅ 编译与运行', '<p><code>gcc -o mini-container mini-container.c &amp;&amp; sudo ./mini-container</code>（<code>_GNU_SOURCE</code> 宏、<code>sched.h</code> 等头文件按你的 glibc 版本自行补全）。进去以后依次验证：<code>echo $$</code> 应为 <b>1</b>；<code>ps aux</code> 只应看到自己的进程；<code>hostname</code> 应是 mini-container；<code>ls /</code> 应是 rootfs 的内容。<b>四条全部对上，说明四根柱子都装好了。</b><span class="pill warn">待核实</span>：不同发行版/内核上 sysfs 挂载是否需要在网络命名空间就绪后进行，表现不一，遇到挂载失败请先看 <code>dmesg</code>。</p>')
    },

    /* ============ 31.6 ============ */
    {
      h: '31.6',
      title: 'pivot_root 与 chroot：为什么容器不用 chroot',
      html:
        '<p>很多人第一次写容器用的是 <code>chroot</code> —— 因为它简单、耳熟能详、一条命令就能把根目录换掉。它能跑，但它<b>不是安全边界</b>。这一节把两者的差异彻底讲清。</p>'
        + T.tbl(['对比项', '<code>chroot</code>', '<code>pivot_root</code>'], [
            ['做了什么', '只修改进程的根目录指针（fs_struct 里的 root）', '<b>在挂载树层面交换</b>新旧根'],
            ['旧根还在吗', '<b>还在</b>，仍挂在系统上，只要能被引用到就能回去', '变成 <code>/oldroot</code> 下的普通挂载点，<b>可以彻底卸载</b>'],
            ['需要挂载命名空间', '不需要', '<b>需要</b>（否则会动到宿主机的挂载树）'],
            ['前置条件', '无', 'new_root <b>必须已是挂载点</b>（先 bind mount）'],
            ['安全强度', '弱 —— 经典逃逸手法可绕过', '强 —— 旧根被摘除后无路可回'],
            ['容器里的地位', '早期方案 / 简易场景', '<b>事实标准</b>（runc 等都用它）']
          ])
        + T.note('bad', '❌ chroot 的两个经典逃逸路径', '<p><b>① 持有外部 fd：</b>进程在 chroot <b>之前</b>打开了一个宿主机目录的 fd（或用 <code>openat</code> 拿到目录 fd），chroot 之后用 <code>fchdir(fd)</code> 切过去，再 <code>chdir(&quot;..&quot;)</code> 逐级上爬 —— <b>根目录的限制只作用于路径解析，不作用于已经打开的 fd</b>。<br><br>'
          + '<b>② 保留 CAP_SYS_CHROOT 时的嵌套逃逸：</b>在新根里再建一层目录、chroot 进去、然后 <code>chdir(&quot;..&quot;)</code>，就能跳到新根之外。这个手法在内核历史上被反复修补，现代内核已有防护，<b>但只要进程还能再调一次 chroot 并且能构造出目录层级，就始终是隐患</b>。<span class="pill warn">具体行为随内核版本变化，待核实</span><br><br>'
          + '<b>共同点：</b>根因都是「chroot 只是改了个名字，没有改变挂载事实」。<code>pivot_root</code> 从挂载树上真正换掉，这两条路同时被封死。</p>')
        + T.note('key', '🔑 记住这条判断准则', '<p><b>chroot 是「改路径」，pivot_root 是「换挂载树」。</b>凡是需要把它当安全边界的地方，就必须用 pivot_root（或者现代内核提供的新接口 <code>open_tree</code> + <code>move_mount</code>，那是 pivot_root 的继任者）。<span class="pill warn">新接口的可用性依赖内核版本，待核实</span></p>'),
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境二 · 被一个 fd 掀翻的「容器」',
            scenario: '<b>情境：</b>你用 <code>chroot ./rootfs /bin/sh</code> 做了一套「容器」，一直用得好好的。某天同事问了一个问题：<br><br>'
              + '「如果一个进程在 chroot <b>之前</b>就打开了一个宿主机目录的 fd，chroot 之后它还能访问那个目录吗？」<br><br>'
              + '你做了个实验：<code>fd = open(&quot;/&quot;, O_RDONLY|O_DIRECTORY)</code> → <code>chroot(&quot;./rootfs&quot;)</code> → <code>fchdir(fd)</code> → <code>chdir(&quot;..&quot;)</code>。'
              + '<b>结果：它一路走回了宿主机的根目录。</b><br><br>你的「容器」整个被打穿了。现在你怎么处理？',
            choices: [
              { t: '给进程去掉不必要的 capability、用非 root 用户跑，让它在容器里也拿不到什么权限就行', next: 'n1' },
              { t: '改用 pivot_root 换根，并把 MS_PRIVATE 和卸载旧根两步补齐，从挂载树上真正切断回宿主的路径', next: 'n2' },
              { t: '在 chroot 之后立刻 chdir(&quot;/&quot;)，并把工作目录重置，让进程找不到向上爬的起点', next: 'n3' },
              { t: '用 seccomp 过滤掉 chdir 和 openat 系统调用，让它没法往上走', next: 'n4' }
            ]
          },
          n1: {
            label: '选 A', terminal: true, verdict: 'bad',
            verdictTitle: '缓解而非修复：权限最小化是对的，但边界仍然漏着',
            result: '<b>先肯定：最小权限原则本身完全正确</b>，去 capability、非 root 运行应该做。但它<b>没有修掉这个洞</b>。<br><br>'
              + '<b>认知根源：把「降低后果」当成了「消除边界」。</b>只要进程还持有那个外部 fd，<b>它就依然能读写宿主机的文件</b> —— 而这些操作是用它自己已有的权限做的，跟去掉 CAP_SYS_ADMIN 没关系。一个非 root 进程能读到宿主机的 <code>/etc/passwd</code>、能读到别的应用的数据目录，这已经足够造成信息泄露了。<br><br>'
              + '<b>更要命的是：如果 chroot 之前的那个 fd 是在特权阶段拿到的</b>，你连「它到底能摸到什么」都说不清。<br><br>'
              + '<b>正确顺序：</b>先修边界（pivot_root + 私有挂载 + 卸载旧根），再谈权限收缩。两者是<b>叠加</b>关系，不是替代关系。安全上有句老话：<b>你无法通过限制权限来修补一个根本不存在隔离的边界</b>。'
          },
          n2: {
            label: '选 B', terminal: true, verdict: 'good',
            verdictTitle: '正确：从挂载树上真正切断，而不是只改路径',
            result: '<b>这就是正解，而且必须是三件事一起做，缺一不可</b>（对照 31.5 的 stepper）：<br><br>'
              + '① <code>mount(NULL, &quot;/&quot;, NULL, MS_REC|MS_PRIVATE, NULL)</code> —— 先让挂载树私有，否则下一步会动到宿主机的挂载表；<br>'
              + '② <code>pivot_root(&quot;.&quot;, &quot;oldroot&quot;)</code> —— 在新挂载命名空间里交换根；<br>'
              + '③ <code>umount2(&quot;/oldroot&quot;, MNT_DETACH)</code> —— <b>把旧根卸载掉</b>。<br><br>'
              + '<b>第 ③ 步是很多人漏掉的关键：</b>只做 pivot_root 不做卸载，旧根就静静躺在 <code>/oldroot</code>，容器里 <code>ls /oldroot</code> 就能看到整个宿主机文件系统 —— <b>和 chroot 一样漏</b>。因为此时工作目录还在旧根上，普通 umount 会 EBUSY，所以要用 <code>MNT_DETACH</code> 惰性卸载。<br><br>'
              + '<b>为什么这能同时封死两条逃逸路径：</b>挂载命名空间独立后，容器里的挂载变动不影响宿主；旧根被卸载后，即使手里有 fd 也指不到任何还挂着的宿主机目录树 —— <b>路径解析和 fd 引用两条路一起断了</b>。这正是 runc 等真实运行时的做法。'
          },
          n3: {
            label: '选 C', terminal: true, verdict: 'bad',
            verdictTitle: '没打到点上：chdir 治不了已经打开的 fd',
            result: '<b>认知根源：以为「路径逃逸靠的是相对路径」，忽略了 fd 这条完全独立的通道。</b><br><br>'
              + '<code>fchdir(fd)</code> 的作用就是<b>把工作目录直接切到 fd 指向的地方</b>，它根本不走路径解析 —— 你之前 chdir 到哪儿都无所谓。攻击者只要手里握着那个 fd，随便什么时候都能切回去。<br><br>'
              + '<b>反过来想：</b>如果「重置工作目录」能解决 chroot 逃逸，那 chroot 早就是一个合格的安全边界了，也不会有人费力去发明 pivot_root。<br><br>'
              + '<b>真正的判断方法：</b>问自己「<b>这个限制作用在什么层面</b>」。chroot 限制的是<b>路径解析</b>；而 fd 是内核对象引用，<b>绕过路径解析的直接引用</b>。凡是「限制一层、另一层还能直接引用」的设计，都不能当边界用 —— 这个思路在做沙箱对抗时同样适用。'
          },
          n4: {
            label: '选 D', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：seccomp 挡不住已存在的能力，还会误伤正常程序',
            result: '<b>认知根源：把 seccomp 当成万能拦截器，忽略了「时机」和「精度」。</b><br><br>'
              + '<b>时机问题：</b>fd 是在 seccomp 生效<b>之前</b>就拿到的（甚至是父进程传递给子进程的）。seccomp 只能拦「之后的系统调用」，<b>不能回收已经存在的 fd</b>。攻击者只需要在装过滤器之前把 fd 准备好就行。<br><br>'
              + '<b>精度问题：</b>直接禁掉 <code>chdir</code>／<code>openat</code> 会让 shell、包管理器、几乎所有正常程序立刻罢工 —— 这两个调用太基础了。真实运行时的 seccomp 配置是<b>白名单</b>式的（只放行需要的调用，并带参数级过滤），不是这样粗暴地拉黑。<br><br>'
              + '<b>seccomp 的正确定位：</b>它是四根柱子里的<b>第四层加固</b>，用来缩小内核攻击面 —— 在边界已经正确的前提下再加一道锁。<b>它的作用是「减少可被利用的入口」，不是「修补一个漏的边界」。</b>边界问题必须在挂载树层面解决。'
          }
        }
      },
      after: '<p>根换好了，进程也跑起来了 —— 但这个容器<b>连不上网</b>。下一节我们回到宿主机侧，看 docker0 网桥上到底发生了什么。</p>'
    },
    /* ============ 31.7 ============ */
    {
      h: '31.7',
      title: 'docker0 网桥与 veth pair：一个包的旅行',
      html:
        '<p>上一节做出来的容器，<code>ping</code> 一下外网会发现完全不通 —— 因为网络命名空间里只有一块 down 状态的 <code>lo</code>。<b>网络是最需要动手、也最容易讲糊涂的一块</b>，所以这一节我们跟踪一个数据包，把每一跳都点亮。</p>'
        + '<p>先记住两个关键角色。' + T.term('docker0', 'Docker 默认创建的虚拟网桥，本质上是一个二层交换机，接在宿主机的网络栈里') + '负责转发，'
        + T.term('veth pair', '虚拟网卡对：两端相连，从一端进去的帧会从另一端出来，像一根网线连接两个网络命名空间') + '负责连接。</p>'
        + T.note('key', '🔑 一句话理解容器网络', '<p>容器网络不需要任何硬件。<b>veth pair 就是一根「虚拟网线」</b>：一头插在容器的网络命名空间里（在容器里看叫 <code>eth0</code>），另一头插在宿主机的 <code>docker0</code> 网桥上（在宿主上叫 <code>vethXXXX</code>）。<b>网卡一定是成对出现的</b> —— 在容器里 <code>ip link</code> 和宿主上 <code>ip link</code> 各看到一半，两端合起来才是一根完整的线。<b>这个「成对」的心智模型，是看懂一切容器网络的钥匙。</b></p>'),
      stage: {
        title: 'bridge 模式：一个数据包从容器到外网的每一跳',
        speed: 1800,
        render:
          '<div class="card">' +
            '<div class="card-title">bridge 模式 · 出向路径</div>' +
            '<div class="flow-col">' +
              '<div class="blk" id="b1">① 容器内进程发包 · 源 172.17.0.2 → 目标 8.8.8.8</div>' +
              '<div class="blk" id="b2">② 容器内 eth0 发出（它是 veth pair 的一端）</div>' +
              '<div class="blk" id="b3">③ 从「另一端的 vethXXXX」出现在宿主机网络栈里</div>' +
              '<div class="blk" id="b4">④ docker0 网桥收到帧 · 查转发表决定去向</div>' +
              '<div class="blk" id="b5">⑤ 进 IP 层 → 路由判断：目标不是本地网段</div>' +
              '<div class="blk" id="b6">⑥ ★ SNAT / MASQUERADE：源地址 172.17.0.2 改写成宿主机 IP</div>' +
              '<div class="blk" id="b7">⑦ 宿主机物理网卡 ethX 真正发出去</div>' +
              '<div class="blk" id="b8">⑧ 到达外网 · 回包靠 conntrack 表原路还原</div>' +
            '</div>' +
          '</div>' +
          '<div class="flow-row" style="margin-top:14px;align-items:stretch;gap:12px">' +
            '<div class="card" style="flex:1">' +
              '<div class="card-title">host 模式 · 无隔离</div>' +
              '<div class="flow-col"><div class="blk" id="h1">直接使用宿主机网络栈</div><div class="blk" id="h2">没有 veth、没有 docker0、没有 NAT</div></div>' +
            '</div>' +
            '<div class="card" style="flex:1">' +
              '<div class="card-title">none 模式 · 完全无网</div>' +
              '<div class="flow-col"><div class="blk" id="h3">只有一块 lo</div><div class="blk" id="h4">连不上任何东西，除了自己</div></div>' +
            '</div>' +
          '</div>' +
          '<div class="flow-row" style="margin-top:14px">' +
            '<span class="blk" id="z1">端口映射 -p 8080:80</span>' +
            '<span class="blk" id="z2">DNAT：宿主 8080 → 容器 80</span>' +
            '<span class="blk" id="z3">iptables DOCKER 链</span>' +
          '</div>',
        reset: () => {
          ['b1','b2','b3','b4','b5','b6','b7','b8','h1','h2','h3','h4','z1','z2','z3']
            .forEach((k) => S(k, ''));
        },
        steps: [
          { run: () => S('b1', 'active'),
            note: '<b>起点：容器里的进程发起连接。</b>它眼里的世界非常简单 —— 自己有一块网卡 <code>eth0</code>，IP 是 <code>172.17.0.2</code>，默认网关是 <code>172.17.0.1</code>（也就是 docker0 的地址）。<b>它对 veth、网桥、NAT 一无所知</b>，就像你在家里上网时不知道运营商做了什么。' },
          { run: () => { S('b1', 'done'); S('b2', 'active'); },
            note: '<b>第一跳：包进了容器的 eth0。</b>关键点在这里 —— 这块 <code>eth0</code> <b>不是真实网卡</b>，它是一个 veth pair 的一端。在容器里敲 <code>ip link</code> 只能看到它，看不到另一端，因为另一端在另一个网络命名空间里。<b>「看不到另一半」是正常的，不是配置出错。</b>' },
          { run: () => { S('b2', 'done'); S('b3', 'active'); },
            note: '<b>第二跳：包从「另一端」冒了出来。</b>veth pair 的行为就是一进一出：从容器侧写入的帧，会从宿主侧那块 <code>vethXXXX</code> 上出现，仿佛瞬间穿过了一根网线。<b>在宿主机上 <code>ip link</code> 会看到一堆 veth 开头的网卡，每个对应一个运行中的容器</b> —— 数一数就知道宿主机上跑了几个容器，这也是容器环境检测的一个小线索。' },
          { run: () => { S('b3', 'done'); S('b4', 'active'); },
            note: '<b>第三跳：docker0 网桥接手。</b><code>docker0</code> 本质是一个<b>二层虚拟交换机</b>，所有容器的 veth 宿主端都插在它上面。它维护一张转发表（哪个 MAC 在哪个端口后面），决定这个帧该从哪个口转发出去。<b>容器之间能互 ping，靠的就是网桥在同一网段内直接转发，根本不经过 NAT。</b>' },
          { run: () => { S('b4', 'done'); S('b5', 'active'); },
            note: '<b>第四跳：上升到自己人管不了的地方 —— IP 路由。</b>网桥只管同网段的二层转发；目标是 <code>8.8.8.8</code>，不在 <code>172.17.0.0/16</code> 里，所以帧要交给宿主机的 IP 层处理。宿主机查路由表，发现要走默认网关，也就是物理网卡那条路。' },
          { run: () => { S('b5', 'done'); S('b6', 'hot'); },
            note: '<b>★ 第五跳：NAT —— 整条链路最容易被忽略、也最关键的一步。</b>如果不做任何处理，包源地址是 <code>172.17.0.2</code>（一个私有地址），外网回包时根本不知道往哪送，连接必然失败。<br><br>所以宿主机在这块网卡的出口上做了一次 <b>SNAT / MASQUERADE（源地址伪装）</b>：把源地址改写成宿主机的公网/出口 IP，同时在内核的 <code>conntrack</code>（连接跟踪表）里记一笔「这个连接是我转发的」。<b>回包回来后，内核查 conntrack 表把目标地址还原成 172.17.0.2，再沿原路送回容器。</b>对容器里的进程来说，整个过程不可见 —— 这正是 NAT 的设计目的。' },
          { run: () => { S('b6', 'done'); S('b7', 'active'); },
            note: '<b>第六跳：真正的物理网卡发出。</b>到了这一步，包的外观已经和宿主机自己发起的连接<b>完全一样</b>了 —— 外网看到的源 IP 就是宿主机 IP。<b>推论很重要：从外部无法直接连进容器</b>，因为容器 IP 在公网上不存在。这就是「容器默认只能出不能进」的原因。' },
          { run: () => { S('b7', 'done'); S('b8', 'active'); },
            note: '<b>第七跳：到达外网，回程靠 conntrack 还原。</b>应答包回到宿主机后，内核查连接跟踪表，把目标地址从宿主机 IP 改回 <code>172.17.0.2</code>，再从 docker0 转回对应的 veth，最终回到容器。<b>整条路径的验证方法</b>：容器里 <code>ip addr</code> / <code>ip route</code> 看自己的视图；宿主上 <code>ip link show master docker0</code> 看插了哪些 veth；<code>iptables -t nat -L -n</code> 看 SNAT 规则；<code>conntrack -L</code> 看连接跟踪表。<b>四张表对着看，网络问题基本无处可藏。</b>' },
          { run: () => { ['b8'].forEach((k) => S(k, 'done')); S('z1', 'active'); S('z2', 'active'); S('z3', 'active'); },
            note: '<b>反过来：外界怎么访问容器？靠端口映射。</b><code>docker run -p 8080:80</code> 会在宿主机上装一条 <b>DNAT</b> 规则：凡是发往宿主机 <code>8080</code> 的连接，目标地址改写为 <code>172.17.0.2:80</code>。这就是「出向用 SNAT 伪装源，入向用 DNAT 改目标」的对称设计。<span class="pill warn">具体 iptables 链名与规则条数随 Docker 版本变化，待核实</span>' },
          { run: () => { ['z1','z2','z3'].forEach((k) => S(k, 'done')); S('h1', 'active'); S('h2', 'active'); },
            note: '<b>对比 host 模式：整条链路全部消失。</b><code>--network host</code> 让容器<b>直接共享宿主机的网络命名空间</b> —— 没有 veth、没有 docker0、没有 NAT，容器里的 <code>ip addr</code> 看到的就是宿主机的网卡。<br><br><b>收益：</b>没有虚拟化开销，网络性能最好，延迟最低。<b>代价：</b>容器与宿主<b>抢端口</b>（容器监听 80，宿主机就不能再监听 80），而且<b>网络隔离完全消失</b> —— 容器里 <code>iptables</code> 一改，宿主机的防火墙规则就变了。' },
          { run: () => { S('h1', 'done'); S('h2', 'done'); S('h3', 'active'); S('h4', 'active'); },
            note: '<b>对比 none 模式：另一个极端。</b><code>--network none</code> 只给容器一块 down 的 <code>lo</code>，连宿主都碰不到。听起来没用，实际上很有用 —— <b>纯离线计算、密钥生成、以及「我要自己手工配网络」的场景</b>都会用它当起点。三种模式连起来看就是一条光谱：<b>none（无网）→ bridge（NAT 隔离，默认）→ host（共享栈，无隔离）</b>，隔离性与性能此消彼长。<span class="mono">另有 container:（复用另一容器的网络命名空间）、overlay（跨主机，Swarm）、macvlan（给容器分配物理网段 IP）等模式，按需了解</span>' }
        ]
      },
      quiz: {
        id: 'q17-2', chapter: 17,
        answer: [0, 3],
        stem: '<b>多选题。</b>你在宿主机上执行 <code>docker exec c-bridge cat /sys/class/net/eth0/iflink</code>，得到 <code>7</code>。这个数字意味着什么？下面哪些说法是<b>正确</b>的？',
        options: [
          { t: '它是容器里 eth0 这块网卡的<b>对端接口索引</b>，也就是宿主机上那块 veth 的 index', why: '正确。<code>iflink</code> 记录的就是 veth pair 对端的接口索引 —— 拿这个数字回宿主机 <code>ip link</code> 里找 index 为 7 的接口，就是配对的那块 vethXXXX。<b>这一步做完，「网卡成对出现」就从抽象变成可验证的事实。</b>' },
          { t: '它说明容器里有 7 块网卡', why: '错。这个数字是接口索引（index），不是数量，也不是编号顺序 —— 接口索引在整个网络命名空间体系里分配，跳号、从大数开始都很正常。' },
          { t: '它可以直接当成宿主机的 veth 网卡名（veth7）使用', why: '错。接口索引和接口名是两回事。<code>veth7</code> 这种命名只是恰好可能出现，不能假设两者对应，必须真的去 <code>ip link</code> 输出里按 index 查。' },
          { t: '这个 <code>@if</code> / iflink 机制的存在本身，也让「我是虚拟网卡对的一端」成为可被外部观察到的特征', why: '正确。真实物理网卡不会有对端接口索引，而 veth 一定有 —— <b>这正是容器网络检测的一条线索</b>，也是 31.11 那张特征清单里的一项。' }
        ],
        explain: '<b>核心概念：veth pair 是「成对」的，两端各有一个接口索引，<code>iflink</code> 指向的就是对端。</b>验证流程是：容器里读 <code>/sys/class/net/eth0/iflink</code> 拿到对端 index → 在宿主机上 <code>ip link</code> 找同 index 的接口（会是 <code>vethXXXX@ifN</code> 的形式）→ <code>ip link show master docker0</code> 还能确认它确实插在 docker0 上。<br><br>顺带记住两个同源的现象：宿主上 <code>ip link</code> 看到的每一块 <code>vethXXXX</code> 都对应一个运行中的容器，数一数就知道密度；而容器里 <code>ip addr</code> 看到的 <code>eth0@if7</code>，那个后缀就是对端索引。<b>「看不见另一半」是正常的 —— 因为另一半在另一个网络命名空间里。</b><br><br>这条机制在实战里的意义是双向的：抓包时你要想清楚在哪个命名空间抓（容器内只能看到自己的流量，全貌要在 docker0 上或 <code>nsenter -t &lt;pid&gt; -n</code> 进去抓）；做环境检测时，网卡名形态本身就是证据。'
      },
      after: T.note('key', '🔑 这对逆向 / 环境伪装有什么用', '<p>① <b>容器网络的指纹很硬。</b>容器里的 IP 常落在 <code>172.17.0.0/16</code>、<code>172.18.0.0/16</code> 这类网段，网关是 <code>x.x.0.1</code>，网卡名是 <code>eth0@if&lt;N&gt;</code>（<b>那个 <code>@if</code> 后缀本身就暴露了它是 veth 的一端</b>）。风控拿到这些信息，判断「这是不是一台真机」就有了依据。</p>'
          + '<p>② <b>NAT 之后的可见性有限。</b>容器出网时源 IP 是宿主机 IP，外网看不到真实容器 —— <b>但这恰恰意味着「一台宿主 IP 上突然出现几百个不同设备指纹」会成为异常特征</b>。很多云手机的封号不是因为单个实例被识破，而是因为<b>同 IP 高密度</b>。</p>'
          + '<p>③ <b>抓包位置要想清楚。</b>在容器里 tcpdump 只能看到容器命名空间内的流量；要抓全貌得在宿主机的 <code>docker0</code> 上抓，或者用 <code>nsenter -t &lt;pid&gt; -n</code> 借命名空间进去抓。<b>「在哪一层抓包」这件事，本质就是命名空间问题。</b></p>'
          + '<p>④ <b>host 模式是双刃剑。</b>做环境伪装时，某些方案故意用 host 模式来消除 veth 特征；但代价是端口冲突与隔离丧失，而且宿主机上的网络配置痕迹依然存在。<b>没有免费的伪装。</b></p>')
    },

    /* ============ 31.8 ============ */
    {
      h: '31.8',
      title: 'Docker 三种网络模式实操',
      html:
        '<p>原理讲完，落到命令上。<b>三种模式各建一个容器，用同一组命令对比它们的网络视图</b> —— 这张对比表是排障时最有用的东西。</p>'
        + T.tbl(['模式', '启动命令', '<code>ip addr</code> 看到什么', '隔离性', '典型用途'], [
            ['bridge（默认）', '<code>docker run -d --name c1 nginx</code>', '<code>eth0</code> + <code>lo</code>，IP 在 172.17.x.x', '网络命名空间独立 + NAT', '绝大多数服务'],
            ['host', '<code>docker run -d --network host nginx</code>', '<b>宿主机的全部网卡</b>', '<b>无</b>（共享宿主网络栈）', '性能敏感、需要监听宿主端口'],
            ['none', '<code>docker run -d --network none nginx</code>', '只有 <code>lo</code>', '最强（完全没有网）', '离线计算、手工配网']
          ])
        + T.note('', '🔍 自己动手验证的三个动作', '<p>① <code>docker network ls</code> 看有哪些网络（默认会有 bridge / host / none 三个）；<code>docker network inspect bridge</code> 能看到网段、网关和<b>已接入的容器列表</b>。</p>'
          + '<p>② 进容器里对比：<code>docker exec -it c1 ip addr</code> 与 <code>docker exec -it c1 ip route</code> —— bridge 模式会看到默认路由指向 <code>172.17.0.1</code>，host 模式看到的和你在宿主机上敲一模一样。</p>'
          + '<p>③ 在宿主机上对账：<code>ip link show master docker0</code> 列出所有插在网桥上的 veth；<code>docker exec c1 cat /sys/class/net/eth0/iflink</code> 拿到容器侧的对端接口索引，再回宿主 <code>ip link</code> 里找同号的那块 veth —— <b>这一步做完，「成对」就不再是抽象概念了</b>。</p>'),
      term: {
        title: '三种网络模式的实操命令',
        lines: [
          { t: 'p', s: 'docker network ls', note: '<b>先看 Docker 自建了哪些网络。</b>安装完 Docker 后默认就有 bridge / host / none 三个，<code>docker0</code> 网桥也是安装时自动建的。' },
          { t: 'o', s: 'NETWORK ID     NAME      DRIVER    SCOPE' },
          { t: 'o', s: 'a1b2c3d4e5f6   bridge    bridge    local' },
          { t: 'o', s: 'f6e5d4c3b2a1   host      host      local' },
          { t: 'o', s: '0f1e2d3c4b5a   none      null      local' },
          { t: 'p', s: 'docker network inspect bridge', note: '<b>看默认网桥的细节。</b>重点看 <code>Subnet</code>（网段）、<code>Gateway</code>（就是 docker0 的地址）、以及 <code>Containers</code> 里已经接进来的容器。<b>容器 IP 是从这个网段自动分配的。</b>' },
          { t: 'p', s: 'docker run -d --name c-bridge nginx', note: '<b>模式一：bridge（默认）。</b>不写 <code>--network</code> 就是这个模式：建 veth pair、接 docker0、配 NAT。' },
          { t: 'p', s: 'docker exec -it c-bridge ip addr', note: '<b>进容器看网卡。</b>会看到 <code>eth0@if123</code> —— <b>注意那个 <code>@if123</code></b>：数字是<b>对端接口的索引</b>，也就是宿主侧那块 veth 的编号。这个后缀本身就是「我是 veth 的一端」的自白。' },
          { t: 'p', s: 'docker exec -it c-bridge ip route', note: '<b>看路由表。</b>默认路由指向 <code>172.17.0.1</code>，那正是 docker0 的地址。容器不需要知道外面有什么，它只知道「不知道往哪送就交给网关」。' },
          { t: 'p', s: 'docker run -d --name c-host --network host nginx', note: '<b>模式二：host。</b>容器共享宿主机网络命名空间，<b>不再创建 veth、不接网桥、不做 NAT</b>。' },
          { t: 'p', s: 'docker exec -it c-host ip addr', note: '<b>对比一下：这里看到的网卡和你在宿主机上敲 <code>ip addr</code> 的结果完全一致。</b>隔离为零，性能最好。<span class="mono">注意端口冲突问题：宿主机上已占用 80 的话，这个 nginx 会直接启动失败。</span>' },
          { t: 'p', s: 'docker run -d --name c-none --network none nginx', note: '<b>模式三：none。</b>只给一块 down 的 lo，连宿主都碰不到。' },
          { t: 'p', s: 'docker exec -it c-none ip addr', note: '<b>确认：只有 lo。</b>适合离线任务；也可以把它当「白纸」，后续手动把 veth 塞进去自己配网 —— <b>这就是你自己实现 bridge 模式的过程</b>。' },
          { t: 'p', s: 'ip link show master docker0', note: '<b>回到宿主机侧对账。</b>这条命令列出所有「从属于 docker0」的接口，也就是所有 bridge 模式容器的 veth 宿主端。<b>数一数有几个，就知道有几个容器在用 bridge 网络。</b>' },
          { t: 'o', s: '7: veth1a2b3c@if6: &lt;BROADCAST,MULTICAST,UP,LOWER_UP&gt; mtu 1500 master docker0' },
          { t: 'o', s: '9: veth4d5e6f@if8: &lt;BROADCAST,MULTICAST,UP,LOWER_UP&gt; mtu 1500 master docker0' },
          { t: 'p', s: 'docker exec c-bridge cat /sys/class/net/eth0/iflink', note: '<b>★ 关键对账动作：拿到容器侧的「对端索引」。</b>得到比如 <code>7</code>，回到宿主机 <code>ip link</code> 里找 index 为 7 的那块，就是 <code>veth1a2b3c</code>。<b>两端对上了，veth pair 的「成对」就从抽象变成了可验证的事实。</b>' },
          { t: 'o', s: '7' },
          { t: 'p', s: 'iptables -t nat -L POSTROUTING -n | grep -i masq', note: '<b>看 NAT 规则。</b>能看到 MASQUERADE 规则 —— 这就是 31.7 里那一跳的实体。<span class="pill warn">规则条数与链名随 Docker 版本和 iptables/nftables 后端不同，待核实</span>' },
          { t: 'w', s: '# 排障顺序：容器 ip addr → 容器 ip route → 宿主 ip link master docker0 → iptables -t nat -L' },
          { t: 'd', s: '# 四张表依次看下来，网络问题基本能定位到具体哪一跳' }
        ]
      },
      after: '<p>三种模式没有「哪个更好」，只有「哪个更合适」。下一节把选型做成决策演练。</p>'
    },

    /* ============ 31.9 ============ */
    {
      h: '31.9',
      title: '网络模式选型演练',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境三 · 容器里的服务，外网连不上',
            scenario: '<b>情境：</b>你把一个内部服务打包成镜像，用默认的 bridge 模式起容器：<code>docker run -d --name api myapi:latest</code>。容器内监听 <code>0.0.0.0:8080</code>。<br><br>'
              + '在宿主机上 <code>curl http://172.17.0.2:8080</code> —— <b>通</b>。<br>'
              + '在你自己笔记本上 <code>curl http://&lt;服务器公网IP&gt;:8080</code> —— <b>不通</b>。<br><br>'
              + '同事建议了四种做法，你选哪个？',
            choices: [
              { t: '改用 --network host 起容器，这样容器直接听宿主机的 8080，外网就能连上了', next: 'n1' },
              { t: '保留 bridge 模式，加上 -p 8080:8080 做端口映射', next: 'n2' },
              { t: '在宿主机上写一条 iptables DNAT 规则，把公网 8080 转发到 172.17.0.2:8080', next: 'n3' },
              { t: '给容器手动配一个和宿主机同网段的 IP（macvlan 思路），让它像一台独立机器一样出现在局域网里', next: 'n4' }
            ]
          },
          n1: {
            label: '选 A', terminal: true, verdict: 'bad',
            verdictTitle: '能跑通，但代价被忽略了',
            result: '<b>先说清楚：这样做确实能连上</b> —— host 模式下容器共享宿主网络栈，外网访问宿主 8080 就是访问容器 8080。<b>但这不是「解决了问题」，而是「把隔离拆了」。</b><br><br>'
              + '<b>认知根源：把「网络隔离」当成了可有可无的装饰。</b>host 模式的实际代价：① <b>端口空间被独占</b>，宿主上其他服务再想用 8080 就冲突了，多实例部署直接不可能；② <b>容器与宿主网络配置互相影响</b>，容器里改 iptables / 路由会影响整台机器；③ <b>失去了容器网络的可编排性</b>（网络别名、服务发现、容器间隔离统统失效）。<br><br>'
              + '<b>什么时候 host 才是对的：</b>性能极致敏感（如高频网络转发）、需要监听大量动态端口、或者容器本身就是「宿主的一个组件」。<b>「为了省一条 -p」不是理由。</b>'
          },
          n2: {
            label: '选 B', terminal: true, verdict: 'good',
            verdictTitle: '正确：这正是端口映射存在的意义',
            result: '<b>标准答案。</b><code>-p 8080:8080</code> 的意思是「宿主 8080 ←→ 容器 8080」，Docker 会在宿主机上装一条 <b>DNAT</b> 规则：发往宿主 8080 的连接，目标地址被改写为 <code>172.17.0.2:8080</code>。<br><br>'
              + '<b>为什么这样是对的（对照 31.7 的路径图）：</b>出向靠 SNAT 把容器源地址伪装成宿主 IP，入向靠 DNAT 把宿主端口改写到容器 —— <b>两者是同一套 NAT 机制的对称使用</b>，容器网络的全部「既隔离又能通信」就建立在这一点上。<br><br>'
              + '<b>几个必须知道的细节：</b>① 默认绑 <code>0.0.0.0</code>（对外全开），只想本机访问要写 <code>-p 127.0.0.1:8080:8080</code>，<b>这是很常见的安全疏漏</b>；② 一次可以映射多个端口，也可以只写 <code>-p 8080</code> 让 Docker 随机分配宿主端口（用 <code>docker port</code> 查）；③ 容器内程序必须监听 <code>0.0.0.0</code>，只监听 <code>127.0.0.1</code> 的话连 DNAT 也救不了 —— <b>这是「映射了但还是不通」的第一大原因</b>。'
          },
          n3: {
            label: '选 C', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：手工造轮子，而且是最脆的那种',
            result: '<b>认知根源：跳过抽象层直接操作底层机制。</b>手写 DNAT 规则确实能达到同样效果（Docker 内部也是这么干的），但你会失去 Docker 帮你维护的一切：<br><br>'
              + '① <b>容器重建后 IP 会变</b> —— 规则还指着旧 IP，连接就断了，而 Docker 的 <code>-p</code> 会自动跟随容器的生命周期重新下发；② <b>规则散落在宿主机上无人管理</b>，<code>docker rm</code> 不会清理你的手写规则，日积月累变成谁也看不懂的遗留配置；③ <b>与 Docker 自己的 iptables 链相互干扰</b>，规则顺序稍有出入就会静默失效；④ 换台机器部署时，这些手工步骤完全没有记录。<br><br>'
              + '<b>但这条选项有一个成立的场景：</b>当你需要<b>绕过 Docker 做自定义转发</b>（例如把流量先引到审计代理、或者做四层负载均衡），此时确实要自己写 iptables —— 但那时你是在<b>补充</b>容器网络，而不是替它做端口映射。'
          },
          n4: {
            label: '选 D', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：动机不对，macvlan 是为别的需求准备的',
            result: '<b>认知根源：把「让容器看起来像独立主机」这个进阶需求，当成了解决基础连通性的手段。</b><br><br>'
              + '<b>macvlan 是什么：</b>给容器分配一个<b>和宿主机同网段的真实 IP</b>，容器直接出现在物理局域网里，像是插在同一台交换机上的一台独立机器。它确实很优雅，但用在这里是杀鸡用牛刀，而且带着真实的代价：<br><br>'
              + '① <b>需要网络环境配合</b>（网卡要支持混杂模式、交换机/云平台往往限制同网段多 MAC，<b>云服务器上经常直接用不了</b>）；② <b>宿主机通常无法直接访问自己网卡上的 macvlan 容器</b>，这是个经典的坑；③ <b>容器直接暴露在局域网</b>，安全边界与 bridge 完全不同，需要重新评估；④ 每次加容器都要消耗一个同网段 IP，地址管理成为负担。<br><br>'
              + '<b>macvlan 该用在哪：</b>需要低延迟直连、需要被局域网其他设备直接发现（如 IoT 设备仿真、需要「真机 IP」的场景）时才值得。<b>先用最简单的手段满足需求，是工程判断力的体现。</b>'
          }
        }
      },
      after: '<p>到这里，网络这一块你已经能自己解释并排障了。下面几节换战场：<b>怎么在 x86_64 上跑起一套 arm64 的根文件系统</b>。</p>'
    },
    /* ============ 31.10 ============ */
    {
      h: '31.10',
      title: 'x86_64 上跑 arm64：binfmt_misc + QEMU',
      html:
        '<p>为什么要把这一节放进容器章？因为<b>服务器绝大多数是 x86_64，而安卓生态以 ARM 为主</b>。当你需要在一台 x86 云主机上准备一份 arm64 的 rootfs（拉包、跑构建脚本、装依赖）时，就绕不开跨架构执行。这也是第 32 章用容器跑安卓的前置能力。</p>'
        + '<p>核心机制是内核提供的 <b>binfmt_misc</b>：一个让内核<b>识别任意二进制格式并交给指定解释器执行</b>的功能。配上 QEMU 的 user-mode 模拟器，x86_64 机器就能直接运行 ARM64 的 ELF。整个过程由内核自动完成，对用户完全透明。</p>'
        + T.note('key', '🔑 两种 QEMU 模式，别搞混', '<p><b>QEMU user-mode（<code>qemu-aarch64-static</code>）：</b>只模拟 CPU 指令 + 把系统调用<b>转发给宿主内核</b>。它跑的是<b>单个程序</b>，不需要模拟硬件。轻量、快、启动几乎无感 —— <b>本章和 debootstrap 用的就是它</b>。</p>'
          + '<p><b>QEMU system-mode（<code>qemu-system-aarch64</code>）：</b>模拟<b>整个系统</b> —— CPU、内存、中断控制器、磁盘、网卡全都虚拟出来，能启动一个完整的 Guest 内核和 OS。重、慢、但它能跑真正的内核。</p>'
          + '<p><b>一句话分辨：</b>你要跑的是「一个程序」还是「一个系统」？前者 user-mode 就够（快十倍以上），后者才需要 system-mode。<b>容器场景永远是 user-mode</b>，因为容器共享宿主内核 —— 而 system-mode 恰恰是虚拟机路线（第 30 章模拟器那一路）。</p>')
        + T.note('bad', '❌ 最大的坑：qemu-aarch64-static 必须复制进 rootfs', '<p>这是「x86_64 下运行 arm64 rootfs」<b>最容易踩、也最难自查</b>的坑。</p>'
          + '<p>binfmt_misc 的工作原理是：内核发现一个 ARM64 二进制 → 查找注册好的解释器路径 → 执行它。<b>问题在于这个解释器路径是在「当前根文件系统」里解析的</b>。当你 <code>chroot ./rootfs</code> 之后，内核眼里的 <code>/usr/bin/qemu-aarch64-static</code> 已经变成了 <b>rootfs 里面的</b>那个路径 —— 而 rootfs 里通常根本没有这个文件。</p>'
          + '<p><b>症状：</b><code>chroot ./rootfs /bin/bash</code> 报 <code>Exec format error</code> 或者 <code>No such file or directory</code>（哪怕 <code>/bin/bash</code> 明明存在）。<b>很多人会去怀疑 debootstrap 拉错了架构、或者内核没开 binfmt</b>，其实只是少复制了一个文件。</p>'
          + '<p><b>解法：</b><code>sudo cp /usr/bin/qemu-aarch64-static ./rootfs/usr/bin/</code> —— 一次性动作，但必须做。<b>记住这条因果链：chroot 改变了解释器的解析基准。</b></p>'),
      term: {
        title: 'x86_64 上构建并运行 arm64 rootfs',
        lines: [
          { t: 'd', s: '# 目标：在 x86_64 主机上做出一个能跑起来的 arm64 Ubuntu 根文件系统' },
          { t: 'p', s: 'sudo apt install qemu-user-static binfmt-support debootstrap', note: '<b>三个包各司其职：</b><code>qemu-user-static</code> 提供静态链接的 qemu-aarch64-static；<code>binfmt-support</code> 负责向内核注册 binfmt_misc 规则；<code>debootstrap</code> 是拉取并搭建根文件系统的工具。<span class="pill warn">包名与是否已默认启用 binfmt 注册，随发行版与版本变化，待核实</span>' },
          { t: 'p', s: 'ls /proc/sys/fs/binfmt_misc/', note: '<b>第一步验证：binfmt_misc 挂上了没有。</b>正常情况下这里应该有 <code>register</code>、<code>status</code>，以及注册后的 <code>qemu-aarch64</code> 条目。<b>如果这个目录不存在或为空，后面所有事都不会成功</b> —— 先解决它再说。' },
          { t: 'o', s: 'qemu-aarch64  qemu-arm  register  status' },
          { t: 'p', s: 'cat /proc/sys/fs/binfmt_misc/qemu-aarch64', note: '<b>第二步验证：看注册的具体内容。</b>重点看 <code>interpreter</code> 这一行指向哪个路径 —— <b>这个路径就是后面必须复制进 rootfs 的那个文件</b>，也解释了为什么少了它就会报 Exec format error。' },
          { t: 'o', s: 'enabled' },
          { t: 'o', s: 'interpreter /usr/bin/qemu-aarch64-static' },
          { t: 'o', s: 'flags: OCF' },
          { t: 'o', s: 'magic 7f454c460201010000000000000000000200b700' },
          { t: 'p', s: 'sudo debootstrap --arch=arm64 --foreign jammy ./rootfs http://ports.ubuntu.com/ubuntu-ports/', note: '<b>第三步：拉取 arm64 的根文件系统。</b>逐段拆解：<code>--arch=arm64</code> 指定目标架构；<code>jammy</code> 是发行版代号（<span class="pill warn">代号与仓库 URL 随版本变化，待核实，请以你要用的发行版官方文档为准</span>）；<code>--foreign</code> 表示<b>只做前半段</b>（下载 + 解包）不做配置 —— 因为主机跑不了 arm64 的脚本，必须分两段；最后那个 URL 是 <b>Ubuntu 的 ARM 移植仓库</b>，<b>ARM 架构必须用 ports.ubuntu.com/ubuntu-ports/，不能用普通的 archive.ubuntu.com</b>，否则会找不到包。<span class="pill warn">Debian 对应的是 deb.debian.org/debian 加 <code>--arch=arm64</code>，具体路径待核实</span>' },
          { t: 'p', s: 'sudo cp /usr/bin/qemu-aarch64-static ./rootfs/usr/bin/', note: '<b>★ 第四步：把 QEMU 复制进 rootfs —— 全章最关键的一行。</b>少了它，第五步的 chroot 必然失败。原因见上面的红色提示框：<b>chroot 之后，内核解析解释器路径的基准变成了 rootfs 自己</b>，宿主机上那个 qemu-aarch64-static 已经不在视野里了。<br><br><span class="mono">顺便注意</span>：<code>qemu-user-static</code> 这个名字里的 <b>static</b> 也是必需的 —— 动态链接版的 QEMU 还需要 rootfs 里有对应的 arm64 动态库，鸡生蛋问题，静态链接版才自包含。' },
          { t: 'p', s: 'sudo chroot ./rootfs /debootstrap/debootstrap --second-stage', note: '<b>第五步：在 chroot 里跑第二段配置。</b>这一步会执行大量 arm64 的程序（apt 配置、包安装后脚本）—— <b>它们之所以能在 x86_64 上跑起来，全靠 binfmt + QEMU 在背后透明地做指令翻译</b>。你看到的输出和在一台真 ARM 机器上几乎没有区别。' },
          { t: 'o', s: 'I: Base system installed successfully.' },
          { t: 'p', s: 'sudo chroot ./rootfs /bin/bash', note: '<b>第六步：进容器。</b>现在你就在一套 arm64 的根文件系统里了。<b>注意这不是虚拟机、也不是模拟器</b> —— 你只是换了个根目录，跑的却是 ARM64 的二进制。' },
          { t: 'p', s: 'uname -m', note: '<b>验证 1：内核架构。</b>这里会返回 <code>x86_64</code> —— <b>因为内核是宿主的，从未变过</b>。这正是 31.3 那句「容器共享宿主内核」最直白的证据。' },
          { t: 'o', s: 'x86_64' },
          { t: 'p', s: 'dpkg --print-architecture', note: '<b>验证 2：用户态架构。</b>返回 <code>arm64</code> —— <b>用户态变了，内核没变</b>。这两条命令的输出差异，就是「跨架构容器」的全部秘密。' },
          { t: 'o', s: 'arm64' },
          { t: 'p', s: 'echo hello-arm64 > /tmp/t && chmod +x /tmp/t', note: '<b>验证 3：直接跑一个「未注册」的 arm64 二进制。</b>脚本由 shell 解释，和 binfmt 无关。<b>想真正验证 binfmt，要去跑一个 arm64 的 ELF 可执行文件</b>（比如 rootfs 里现成的 <code>/bin/ls</code>）—— 它跑得起来，就说明透明翻译生效了。' },
          { t: 'p', s: '/bin/ls -l /usr/bin/qemu-aarch64-static', note: '<b>验证 4：回头看那个复制进来的解释器。</b>它就在这里，静静地待着 —— <b>没有它，这个 rootfs 里任何一个 ELF 都跑不起来</b>。这是本章最值得记住的一个「不起眼但致命」的细节。' },
          { t: 'p', s: 'sudo chroot ./rootfs apt update && sudo chroot ./rootfs apt install -y python3', note: '<b>实际用途：在 x86 上给 arm64 环境装包。</b>这是跨架构 rootfs 最常见的用法 —— 构建 ARM 镜像、准备测试环境、给 ARM 设备做离线包。' },
          { t: 'w', s: '# 常见报错对照：Exec format error → qemu 没复制进 rootfs；No such file or directory → 同上（容易被误判成文件不存在）' },
          { t: 'w', s: '# Cannot mount /proc → 忘了在 chroot 前挂载 proc/sys/dev' },
          { t: 'd', s: '# 结论：kernel 认架构靠 binfmt，用户态认架构靠 rootfs —— 两者解耦，才有了跨架构容器' }
        ]
      },
      quiz: {
        id: 'q17-3', chapter: 17,
        answer: 1,
        stem: '你在 x86_64 主机上用 debootstrap 做好了 arm64 的 rootfs，注册了 binfmt_misc，<code>qemu-aarch64-static</code> 也装好了。但执行 <code>chroot ./rootfs /bin/bash</code> 时，报出 <code>Exec format error</code>（有些系统上表现为 <code>No such file or directory</code>），而 <code>/bin/bash</code> 明明存在。<b>最可能的原因是什么？</b>',
        options: [
          { t: 'debootstrap 拉错了架构，rootfs 里其实是 x86_64 的二进制', why: '可能性很低。如果真是拉错架构，你会得到一份能正常运行的 rootfs（只是架构不对），而不是 Exec format error。而且 <code>dpkg --print-architecture</code> 一查就知道，不必靠猜。' },
          { t: '<code>qemu-aarch64-static</code> 没有复制进 rootfs，导致 chroot 之后找不到 binfmt 注册的解释器', why: '正确。binfmt_misc 注册的 interpreter 路径是 <code>/usr/bin/qemu-aarch64-static</code>；<b>一旦 chroot，这个路径就在 rootfs 内解析</b>，而宿主机上那个文件已经不在视野里了。内核找不到解释器，于是 ELF 无法被识别执行。' },
          { t: '内核没有编译 binfmt_misc 支持，需要重新编译内核', why: '如果内核不支持，那么 <code>/proc/sys/fs/binfmt_misc/</code> 目录根本不会出现，你在准备阶段就能发现。而且报错形态和这里不同 —— 先做检查再下结论，不要直接跳到「重编内核」这种重手段。' },
          { t: '缺少 <code>--foreign</code> 参数，导致第二段配置没跑', why: '顺序搞反了：<code>--foreign</code> 是<b>第一段</b>用的（只下载解包），少了它反而会提前尝试执行 arm64 脚本并失败。而且它导致的是 debootstrap 阶段报错，不是 chroot 时报 Exec format error。' }
        ],
        explain: '<b>根因链要背下来：chroot 改变了解释器路径的解析基准。</b>binfmt_misc 的工作方式是「内核识别 ELF 头 → 查找注册的解释器路径 → 执行它」。这个路径在<b>当前根文件系统</b>中解析。你没有 chroot 时，<code>/usr/bin/qemu-aarch64-static</code> 是宿主机的；chroot 之后，同一个路径字符串指向的是 rootfs 里的位置 —— 那里什么都没有。<br><br><b>解法就一行：</b><code>sudo cp /usr/bin/qemu-aarch64-static ./rootfs/usr/bin/</code>。<br><br>两个容易忽略的细节：① 必须是 <b>static</b> 版本 —— 动态链接版的 QEMU 还需要 rootfs 里有对应的 arm64 动态库，鸡生蛋问题；② <code>No such file or directory</code> 这个报错极具迷惑性（文件明明在），它的真实含义是「<b>解释器</b>找不到」，不是「目标文件找不到」。<b>记住这个报错语义，能省下几个小时。</b><br><br>顺带验证一下这个机制：chroot 进去后 <code>uname -m</code> 返回 <code>x86_64</code>（宿主内核），而 <code>dpkg --print-architecture</code> 返回 <code>arm64</code>（用户态）—— <b>内核架构与用户态架构解耦，这正是跨架构容器的全部秘密。</b>'
      },
      after: T.note('', '📌 别忘了 cgroup 也有命名空间', '<p>回顾 31.2 的第四根柱子：容器里 <code>cat /proc/self/cgroup</code> 看到的是自己命名空间的根，而不是宿主机的完整 cgroup 树 —— 这靠的是 <code>CLONE_NEWCGROUP</code>。<b>如果容器里能直接看到宿主机 cgroup 的全貌，风控一眼就能认出「我在容器里」。</b>这个视角在下一节会立刻派上用场。</p>')
    },

    /* ============ 31.11 ============ */
    {
      h: '31.11',
      title: 'cgroup：容器资源限制的实体与检测线索',
      html:
        '<p>namespaces 决定「看得见什么」，cgroup 决定「能用多少」。这一节把 cgroup 落到文件系统上 —— 因为<b>它既能限制你的容器，也能暴露你的容器</b>。</p>'
        + T.tbl(['版本', '结构', '挂载点', '现状'], [
            ['<b>cgroup v1</b>', '各控制器（cpu / memory / blkio / pids …）<b>各自独立挂载，层次结构混乱</b>', '<code>/sys/fs/cgroup/&lt;controller&gt;/</code> 多套目录', '老系统；同一进程在不同控制器里的分组可能不一致'],
            ['<b>cgroup v2</b>', '<b>统一层次结构（unified hierarchy）</b>，单一挂载点，所有控制器协同', '通常 <code>/sys/fs/cgroup</code> 一个', '<b>现代发行版默认</b>']
          ])
        + '<p>v2 的主要控制器与对应文件：</p>'
        + T.tbl(['控制器', '核心文件', '作用'], [
            ['<code>cpu</code>', '<code>cpu.max</code>', 'CPU 带宽上限。格式 <code>&quot;配额 周期&quot;</code>，如 <code>50000 100000</code> = 每 100ms 最多用 50ms（半个核）'],
            ['<code>memory</code>', '<code>memory.max</code>', '内存上限（字节）。超过会被 OOM killer 干掉'],
            ['<code>pids</code>', '<code>pids.max</code>', '进程/线程数上限。<b>防 fork 炸弹</b>'],
            ['<code>io</code>', '<code>io.max</code>', '块设备读写带宽 / IOPS 上限']
          ])
        + '<p>两个必须认识的文件：<b><code>cgroup.controllers</code></b> 列出当前 cgroup <b>可用</b>的控制器；<b><code>cgroup.procs</code></b> 是<b>加入这个 cgroup 的进程列表</b> —— 把 PID 写进去，进程就归它管。</p>'
        + T.note('ok', '✅ 动手：亲手给一个进程套上限额', '<p>① <code>sudo mkdir /sys/fs/cgroup/demo</code>（在 cgroup v2 里，<b>创建目录就等于创建 cgroup</b>）；② <code>cat /sys/fs/cgroup/demo/cgroup.controllers</code> 看有哪些控制器可用；③ 如果控制器没启用，往父级的 <code>cgroup.subtree_control</code> 写 <code>+cpu +memory</code> 启用；④ <code>echo &lt;PID&gt; | sudo tee /sys/fs/cgroup/demo/cgroup.procs</code> 把进程放进去（<b>它和它的所有子进程一起生效</b>）；⑤ <code>echo &quot;50000 100000&quot; | sudo tee /sys/fs/cgroup/demo/cpu.max</code> 限成半个核；⑥ <code>echo 268435456 | sudo tee /sys/fs/cgroup/demo/memory.max</code> 限成 256MB。<b>做完以后跑个死循环看 CPU 占用，你会亲眼看到它被压在 50% 上下</b> —— 那一刻 cgroup 就从名词变成了实体。<span class="pill warn">subtree_control 的写法与是否需要多级委派随内核版本而异，待核实</span></p>')
        + T.note('warn', '⚠️ 容器里最经典的 OOM 迷思', '<p>「容器里 <code>free</code> 显示还剩很多内存，进程却被 OOM killer 杀了」—— 因为 <b><code>free</code> 读的是宿主机内存，而杀你的是 cgroup 的 <code>memory.max</code></b>。容器看到的内存数字和它真正能用的额度是两回事。<b>排查方向：</b>看 <code>/sys/fs/cgroup/.../memory.max</code>（额度）与 <code>memory.current</code>（当前用量）、<code>memory.events</code>（有没有触发 oom/oom_kill 计数）。<b>推论到实战：</b>性能压测、批量任务在容器里跑时，「加内存」要加的是 cgroup 额度，不是宿主机内存条。</p>')
        + T.note('key', '🔑 这对逆向 / 环境伪装有什么用', '<p><b>cgroup 是容器检测最硬的证据之一</b>，因为它不太容易被「伪装」而不留痕迹：</p>'
          + '<p>① <code>cat /proc/1/cgroup</code> —— 在容器里往往会看到 <code>/docker/&lt;64位容器ID&gt;</code>、<code>/kubepods/...</code>、<code>/lxc/...</code> 这类路径；在真机上通常只有 <code>/</code> 或一条很短的路径。<b>这一条几乎是最常见的容器指纹。</b></p>'
          + '<p>② <code>cat /proc/self/cgroup</code> —— 同理，暴露自己是哪一层下的进程。</p>'
          + '<p>③ <code>ls -la /.dockerenv</code> —— Docker 会在容器根目录创建一个空的 <code>/.dockerenv</code> 文件作为标记。存在的架构差异使它成为一个「有则可疑」的信号（<b>不存在不能证明不是容器</b>，因为可以删、别的运行时也不建）。</p>'
          + '<p>④ <code>ls /sys/fs/cgroup/</code> —— 在容器里看到的内容和真机差别很大；如果连 cgroup 的层次结构都只剩极少几项，基本可以确定被裁剪过。</p>'
          + '<p>⑤ 综合判断 —— <b>主机名是一串随机十六进制</b>、<b>网卡名带 <code>@if</code> 后缀</b>、<b>IP 在 172.17/172.18 网段</b>、<b>挂载表里出现 overlay / tmpfs 的异常组合</b>。风控不会只看一条，而是<b>打分</b>；同理，做环境伪装的人也不能只改一条 —— <b>删掉 /.dockerenv 却留着 /proc/1/cgroup 里的容器 ID，等于没改</b>。<span class="pill warn">具体检测项与各云手机方案的实现差异很大，需按目标逐个验证，待核实</span></p>'),
      quiz: {
        id: 'q17-4', chapter: 17,
        answer: 0,
        stem: '一个容器被限制了 <code>memory.max = 256MB</code>。容器里的程序申请了约 400MB 内存后被 OOM killer 杀掉。但运维在容器里执行 <code>free -m</code>，看到宿主机<b>还剩好几个 GB</b>。<br><br>关于这个现象，下面哪个说法是<b>正确</b>的？',
        options: [
          { t: '<code>free</code> 读的是宿主机内存，而限制容器的是 cgroup 的 <code>memory.max</code> —— 两者是不同层面的数字，容器的真实额度要看它所在 cgroup 目录下的 <code>memory.max</code> / <code>memory.current</code>', why: '正确。容器共享宿主内核，<code>free</code> 从宿主内核拿全局内存统计，它<b>不知道也不关心</b> cgroup 额度。杀进程的是 cgroup 控制器按 <code>memory.max</code> 触发的 OOM。' },
          { t: '说明宿主机的内存统计被容器篡改了，应该重启 Docker 服务', why: '把机制差异误判成了故障。数字没有错，只是它回答的不是你想问的问题 —— <b>容器视角和宿主视角本来就看到不同的内存统计</b>。' },
          { t: '应该删掉 cgroup 的 <code>memory.max</code> 限制，让容器直接用宿主机内存', why: '这是「用拆掉护栏的方式解决问题」。去掉限额确实不会被杀了，但你也失去了隔离保护 —— 一个容器就能把整台宿主机拖垮。<b>正确做法是调大额度，不是取消额度。</b>' },
          { t: '在容器里执行 <code>free</code> 的结果不可信，容器里无法获取内存信息', why: '过度怀疑。<code>free</code> 的输出本身是准确的（就是宿主内存），只是它的<b>语义</b>不是「你能用多少」。真正的容器内存额度要读 cgroup 文件。' }
        ],
        explain: '<b>核心认知：容器里看到的很多「系统信息」其实是宿主机的，而限制你的那套规则活在另一个地方。</b><code>free</code>、<code>nproc</code>、部分 <code>/proc/meminfo</code> 字段反映的都是宿主全局状态 —— 因为它们读的是共享内核的全局统计。而 cgroup 的额度是「挂在这个进程组上的规则」，不会改变全局统计的数字。<br><br><b>正确的排查姿势：</b>① 先找到容器所属的 cgroup 目录（<code>cat /proc/self/cgroup</code> 或 <code>cat /proc/1/cgroup</code>）；② 读 <code>memory.max</code>（额度上限）、<code>memory.current</code>（当前用量）、<code>memory.events</code>（<code>oom</code> / <code>oom_kill</code> 计数，能确认是不是 cgroup 层面杀的）；③ 如果是 K8s 环境，还要看 Pod 的 resources.limits。<br><br><b>这条知识在实战里的两个用法：</b>一是给容器里的服务做容量规划时，「加内存」加的是 cgroup 额度而不是物理内存条；二是反过来 —— <b>容器里 <code>free</code> 显示的就是宿主内存，这本身就泄露了宿主机信息</b>，是环境检测可以利用（或被利用）的一个点。'
      }
    },

    /* ============ 31.12 ============ */
    {
      h: '31.12',
      title: '为什么逆向要关心容器化：四个战场',
      html:
        '<p>这一节回答本章的收尾问题：<b>我一个做逆向的，学容器干什么？</b>四个理由，每一个都会在后续章节反复出现。</p>'
        + T.card('① 云手机的运行底座 —— 你调试的东西可能就是一个容器',
          '<p>很多云手机 / 云真机方案用<b>容器而不是虚拟机</b>来做多实例：开销小、启动快、单机密度高（回想 31.3 的分层图：共享内核省掉的就是整个 OS 的内存和启动时间）。</p>'
          + '<p><b>对你的直接影响：</b>当你远程连上一台「云手机」时，需要先判断它的底座是什么 —— 是<b>容器里跑安卓</b>（第 32 章 Waydroid 那一类）、是<b>虚拟机里跑安卓</b>、还是<b>真机托管</b>。判断方法就是 31.3 和 31.11 给的那几条：<code>uname -r</code>、<code>/proc/1/cgroup</code>、<code>/.dockerenv</code>、网卡名。<b>底座决定了你的调试手段清单</b> —— 容器里通常没有内核模块权限，依赖 insmod 的方案直接出局。</p>')
        + T.card('② 环境伪装与检测 —— 容器特征是风控的重要证据链',
          '<p>容器环境有一整套<b>独特的、难以完全抹除的</b>特征：<code>/.dockerenv</code> 文件、cgroup 路径里的容器 ID、被裁剪的挂载表、<code>eth0@ifN</code> 形式的网卡、172.17 网段、随机主机名、以及特殊的 <code>/proc</code>、<code>/sys</code> 视图。</p>'
          + '<p><b>攻防两侧都需要这一章：</b>检测方把这些特征做成打分项（单条不可靠，组合起来就很硬）；伪装方则需要知道<b>每一条特征的来源</b>才能对症下药 —— 而特征的来源，正是前面十一节讲的 namespace / cgroup / veth。<b>本章最大的实用价值之一，就是让你拿到一份「容器特征清单 + 每条特征的内核出处」。</b></p>'
          + '<p>更进一步：<b>风控也会检测「反检测行为」本身</b> —— 比如 <code>/.dockerenv</code> 被删除、cgroup 路径被改写成 <code>/</code>，这类「过于干净」的环境反而会触发另一套规则。<b>伪装的目标是「像真的」，不是「像空的」。</b></p>')
        + T.card('③ 安卓容器化的前提 —— 第 32 章全靠这一章',
          '<p>第 32 章的 Waydroid 本质就是<b>「用容器跑安卓」</b>：用 Linux namespace 给 Android 用户态一个隔离视图，用 cgroup 限制它，用 binder / ashmem 之类的内核支持让安卓框架跑起来。<b>没有 namespace 和 cgroup 这两块地基，Waydroid 一行都跑不起来。</b></p>'
          + '<p>届时你会遇到的所有问题 —— 为什么安卓容器里看不到宿主的某些设备、为什么网络要走特殊配置、为什么某些 App 一启动就闪退 —— <b>答案都在这一章的四根柱子里</b>。学完本章再去看 Waydroid 的启动脚本，你会发现它做的就是把 31.5 的迷你容器流程（换根、挂 /proc、配 cgroup、exec）包装了一遍，只是多了安卓特有的挂载点和设备节点。</p>')
        + T.card('④ 跨架构是刚需 —— 服务器 x86，生态 ARM',
          '<p>现实是错位的：<b>服务器以 x86_64 为主，而安卓应用生态以 ARM 为主</b>。所以「在一台 x86 云主机上准备、运行、调试 ARM 环境」是每天都在发生的事。</p>'
          + '<p>31.10 的那条链路（binfmt_misc + qemu-user-static + debootstrap）就是标准解法。理解它之后，你才能回答一些很实际的问题：为什么这个方案快（user-mode 只翻译指令、系统调用直接转发给宿主内核）、什么时候会失效（涉及大量 <code>ioctl</code>、自修改代码、或依赖特定 CPU 特性时会翻译出错）、以及为什么它<b>不能代替真机</b>（模拟器检测 —— 见第 30 章）。</p>'
          + '<p><b>一句话总结这一章：容器不神秘，它是内核给一个普通进程套上的四层约束。</b>你越是能亲手把它拼出来，就越能在「云手机到底是什么」这个问题上拥有判断力 —— 而这正是后面所有环境对抗工作的起点。</p>'),
      after: T.note('ok', '✅ 本章带走五句话', '<p>① <b>容器不是虚拟机</b>：共享宿主内核，软件隔离，弱于硬件隔离，但启动开销和资源占用低一个数量级。</p>'
        + '<p>② <b>容器 = namespaces + cgroup + rootfs + capabilities/seccomp</b>，四根柱子缺一不可；<code>docker run</code> 的内核本质是一次带 <code>CLONE_NEW*</code> 标志的 <code>clone()</code>。</p>'
        + '<p>③ <b>namespaces 管「看不见」，cgroup 管「用不了那么多」</b>；三个系统调用 <code>clone</code> / <code>unshare</code> / <code>setns</code>，<code>CLONE_NEWNS</code> 不叫 NEWMNT，PID 隔离要再 fork 一次才生效。</p>'
        + '<p>④ <b>容器网络靠 veth pair 成对出现</b>：一端在容器里叫 eth0，一端在宿主上挂在 docker0；出向 SNAT、入向 DNAT，host 模式无隔离、none 模式只有 lo。</p>'
        + '<p>⑤ <b>容器特征是可检测的</b>（/.dockerenv、/proc/1/cgroup、cgroup 路径、网卡名、网段）—— 每条特征的源头都能在本章找到，这就是你在环境对抗里的地图。</p>')
    }
     ],
     glossary: [
       { t: 'namespace（命名空间）', d: 'Linux 的<b>资源隔离机制</b>，决定进程「看得见什么」。通过 clone / unshare / setns 创建与加入，标志形如 CLONE_NEW*。注意它是<b>视图隔离</b>，不是物理隔离 —— 进程仍共享同一个内核。' },
       { t: 'cgroup（控制组）', d: 'Linux 的<b>资源限制机制</b>，决定进程「能用多少」。v2 采用<b>统一层次结构</b>，单一挂载点通常为 /sys/fs/cgroup；主要控制器有 cpu（cpu.max）、memory（memory.max）、pids（pids.max）、io（io.max）。' },
       { t: 'CLONE_NEWNS', d: '<b>Mount 命名空间</b>标志。名字里的 NS 指 mount namespace，<b>不叫 NEWMNT</b> —— 这是历史原因造成的命名，属于高频考点。提供独立的挂载点视图。' },
       { t: 'CLONE_NEWPID', d: 'PID 命名空间标志。容器内进程从 <b>PID 1</b> 开始编码，看不到宿主机其他进程。<b>关键时机：只对之后 fork 出的子进程生效</b>，unshare 之后必须再 fork 一次当前进程的 PID 才会变。' },
       { t: 'CLONE_NEWUSER', d: '用户命名空间标志，做用户与用户组 ID 映射。<b>rootless 容器的基础</b> —— 让非 root 用户也能创建容器。但里面的「root」在宿主机上只是被映射的普通 UID，能力有限。' },
       { t: 'pivot_root', d: '真正<b>交换根文件系统</b>的系统调用：new_root 必须已是挂载点（先 bind mount），旧根被挪到 put_old 目录后可被卸载。<b>比 chroot 安全，是容器的标准做法</b>。' },
       { t: 'chroot', d: '只<b>修改进程的根目录指针</b>，不改变挂载事实。旧根依然挂在系统上，持有外部 fd 可经典逃逸。<b>不是安全边界</b>，容器场景应改用 pivot_root。' },
       { t: 'veth pair', d: '虚拟网卡<b>对</b>：两端相连，从一端进去的帧从另一端出来，像一根网线连接两个网络命名空间。容器侧叫 eth0，宿主侧叫 vethXXXX 并挂在 docker0 上。<b>「成对出现」是理解容器网络的关键。</b>' },
       { t: 'docker0', d: 'Docker 安装时自动创建的<b>虚拟网桥</b>，本质是一个二层交换机，接在宿主机的网络栈里。所有 bridge 模式容器的 veth 宿主端都插在它上面，同网段容器互通靠它直接转发，出网则交给 NAT。' },
       { t: 'binfmt_misc', d: 'Linux 内核功能：让内核<b>识别任意二进制格式并交给指定解释器执行</b>。配合 QEMU user-mode 可在 x86_64 上透明运行 ARM64 程序。<b>坑：解释器路径经 chroot 后会在 rootfs 内解析，所以 qemu-aarch64-static 必须复制进 rootfs。</b>' },
       { t: 'QEMU user-mode / system-mode', d: '<b>user-mode</b>（qemu-aarch64-static）只模拟 CPU 并把系统调用转发给宿主内核，跑单个程序、轻量快速；<b>system-mode</b>（qemu-system-aarch64）模拟整个系统（CPU + 设备 + 内存），能跑完整 OS，重。容器场景用 user-mode。' },
       { t: 'debootstrap', d: 'Debian/Ubuntu 的引导工具，可在指定目录构建最小根文件系统。<code>--arch=arm64</code> 指定架构，<code>--foreign</code> 只做下载解包、配置留给 chroot 内的 second-stage。<b>ARM 架构要用 ports.ubuntu.com/ubuntu-ports/，不是 archive.ubuntu.com。</b>' }
     ],

  teacher: {
    id: 'ch17', chapter: 17,
    name: '追问老师 · 第 31 章',
    sub: '拷问五件事：容器与虚拟机的分界、命名空间的生效时机、pivot_root 的完整姿势、容器网络的数据流、以及容器特征从哪来',
    intro: '<p style="margin:0">这一章的知识点不多，但<b>每一条都容易被「差不多懂了」蒙混过去</b>。我会追问机制背后的因果：为什么 PID 没变成 1、为什么只调 pivot_root 还会漏、为什么容器里删了 <code>/.dockerenv</code> 照样被识破。<b>答不上来不要紧，但请不要用「Docker 帮我做了」当答案 —— 那正是这一章要拆掉的东西。</b></p>',
    questions: [
      {
        id: 'c17q1', depth: 1, threshold: 0.7,
        q: '请说清楚：<b>容器和虚拟机最本质的区别是什么？</b>并且给出<b>至少两种在实战中判断「我当前是在容器里还是在虚拟机里」的具体方法</b>，说明每个方法的原理。',
        concepts: [
          { label: '容器共享宿主内核，虚拟机有独立内核',
            hint: '想想两者分别有几份内核？容器省掉的是什么？',
            any: ['共享内核', '共享宿主内核', '共用一个内核', '同一个内核', '独立内核', '自己的内核', 'guest os', '客户机内核', '不用引导内核', '不启动内核', 'shared kernel', 'own kernel', '没有独立内核'] },
          { label: '容器是软件隔离（namespace），虚拟机是硬件隔离（VT-x/AMD-V）',
            hint: '两者隔离的手段分别是什么层面的？',
            any: ['软件隔离', '命名空间隔离', 'namespace', '硬件隔离', '硬件虚拟化', '虚拟化指令', 'vt-x', 'vtx', 'amd-v', 'amd v', 'hypervisor', '虚拟化层', 'intel vt', '硬件辅助'] },
          { label: '判据 uname -r：容器返回宿主内核版本',
            hint: '哪条命令能一次性看出内核是谁的？',
            any: ['uname -r', 'uname -a', 'uname', '内核版本', '宿主内核版本', '内核号'] },
          { label: '判据 /proc/1/cgroup 或 /.dockerenv 等容器痕迹',
            hint: '容器运行时会在文件系统里留下什么标记？cgroup 路径长什么样？',
            any: ['/proc/1/cgroup', 'proc/1/cgroup', 'cgroup', '/.dockerenv', 'dockerenv', 'docker 文件', 'systemd-detect-virt', 'detect-virt', 'lsns', '/proc/self/cgroup', '容器id', '容器 id'] }
        ],
        hints: [
          '先问自己一个问题：容器里 <code>uname -r</code> 显示的是谁的内核版本？为什么？',
          '再想想隔离手段：一个是在内核里改「视图」，一个是用 CPU 硬件指令做「隔断」—— 强度能一样吗？'
        ],
        probes: [
          '那为什么大家都说容器「更轻」？轻在哪里？具体省掉了哪些开销？',
          '如果我说「容器比虚拟机更安全」，你怎么反驳我？'
        ],
        model: '最本质的区别只有一条：<b>容器共享宿主内核，虚拟机拥有自己的内核。</b>容器里的所有进程和宿主机上的进程，跑的是同一份内核代码、同一套调度器和内存管理；虚拟机的 Guest OS 则自带完整内核，通过 Hypervisor 和 CPU 的硬件虚拟化指令（Intel VT-x / AMD-V）与宿主隔开。<br><br>由这一条推出其余全部差异。隔离手段上：容器靠 <b>namespace</b> 做软件层的视图隔离（改的是「看得见什么」），虚拟机靠<b>硬件虚拟化</b>做真正的隔断 —— 前者的隔离强度<b>弱于</b>后者，一个内核漏洞就可能让容器里的 root 摸到宿主；后者要逃逸得先攻破虚拟化层本身。开销上：容器不需要引导内核、不需要加载驱动、不需要为每个实例准备一份 OS 镜像，所以启动是毫秒级、内存占用是 MB 级；虚拟机要引导完整 OS，秒级启动、GB 级内存。<b>注意这两个结论方向是相反的：容器更轻但更弱，虚拟机更重但更强</b> —— 这就是选型的核心权衡，也是云手机厂商选容器方案时真正赌的东西（密度和成本，而不是隔离强度）。<br><br>实战判据有四个，原理各不相同：① <code>uname -r</code> —— 容器返回<b>宿主内核版本</b>，虚拟机返回 Guest 自己的，这是最直接的证据；② <code>cat /proc/1/cgroup</code> —— 容器里常能看到 <code>/docker/&lt;容器ID&gt;</code>、<code>/kubepods/...</code> 之类的路径，真机上通常只有 <code>/</code>；③ <code>ls -la /.dockerenv</code> —— Docker 会在容器根目录建这个标记文件（<b>有则可疑，无则不能证明不是</b>）；④ <code>systemd-detect-virt</code> —— 容器里常输出 docker/lxc/podman，虚拟机里输出 kvm/vmware。<br><br>补充一条更细的：容器里 <code>/proc/self/ns/</code> 下的命名空间 inode 号与宿主机 init 不同，<code>lsns</code> 能直接列出系统里的命名空间及进程数。'
      },
      {
        id: 'c17q2', depth: 2, threshold: 0.7,
        q: '你写了这段代码想验证 PID 隔离：<code>unshare(CLONE_NEWPID)</code> 之后立刻 <code>printf(&quot;%d&quot;, getpid())</code>。<b>结果打印出的是一个普通的宿主机 PID，而 unshare 返回了 0。</b>请解释原因，并给出正确的写法；再说说为什么这个设计是<b>必须的</b>，而不是内核的缺陷。',
        concepts: [
          { label: 'PID 命名空间在进程创建时绑定，只对之后创建的子进程生效',
            hint: '命名空间是在哪个时刻被「贴」到进程上的？',
            any: ['创建时', '进程创建', 'fork 时', 'fork时', '创建进程时', '只对子进程', '对子进程生效', '之后创建', '下一个进程', '新创建的进程', '不影响当前进程', '当前进程不变', 'clone 时', 'clone时'] },
          { label: '正确写法：unshare 之后再 fork 一次（或用 clone 带标志）',
            hint: '让谁成为新命名空间的第一个进程？',
            any: ['再 fork', '再fork', 'fork 一次', 'fork()', '调用 fork', 'clone', 'clone(', 'clone 带', '带上标志', 'unshare --fork', '--fork', 'unshare -f', 'fork 出子进程'] },
          { label: '子进程成为新命名空间的 PID 1，并承担 init 职责',
            hint: '新命名空间里的第一个进程编号是多少？它有什么特殊责任？',
            any: ['pid 1', 'pid1', '1 号进程', '一号进程', 'init', '第一个进程', '回收', '僵尸', '孤儿进程', 'reap', '子进程退出', '整个命名空间被杀', '命名空间被清理'] }
        ],
        hints: [
          '<code>unshare</code> 返回 0 说明内核<b>已经答应了</b>。那么没变的到底是什么？换个角度：当前这个进程是什么时候被创建的？',
          '想想「命名空间」是挂在进程结构的哪个字段上的，以及这个字段是在生命周期的哪一刻被确定的。'
        ],
        probes: [
          '那新 PID 命名空间里，<code>/proc</code> 需要做处理吗？不做会怎样？',
          '容器里 PID 1 挂了会发生什么？这解释了 Docker 的哪个命令行选项？'
        ],
        model: '原因在于 <b>PID 命名空间是在进程被创建的那一刻绑定到进程上的</b>。当你调用 <code>unshare(CLONE_NEWPID)</code> 时，内核为<b>之后创建的子进程</b>准备好了一个新的 PID 命名空间，但当前进程早就创建完了 —— 它的 PID 命名空间字段不可能在此时被改写，否则进程在宿主机上的身份会瞬间变化，所有引用它的地方（信号、wait、/proc 条目、父进程记录）都会错乱。<b>所以 unshare 返回 0 是诚实的：命名空间确实创建了，只是还没人住进去。</b><br><br>正确写法有两条路：① <code>unshare(CLONE_NEWPID)</code> 之后立刻 <code>fork()</code>，子进程就是新命名空间的 <b>PID 1</b>；② 直接用 <code>clone(child_func, stack, CLONE_NEWPID | SIGCHLD, NULL)</code>，一步到位，子进程出生就在新命名空间里。命令行等价物是 <code>unshare --pid --fork --mount-proc /bin/bash</code>，进去后 <code>echo $$</code> 得到 1。<br><br>这个设计不是缺陷，而是<b>必须的</b>。PID 命名空间是一棵<b>树</b>，每个命名空间有自己的号码体系：同一个进程在宿主机上是 18422，在容器里是 1，两者同时成立。这要求「进程 → 它属于哪个 PID 命名空间」的映射在进程诞生时就固定下来，才能保证信号投递、父子关系、进程回收在每一层都自洽。如果允许运行中的进程中途换命名空间，内核就必须在每一处引用 PID 的地方做动态重解析，成本和复杂度不可接受。<br><br>顺着 PID 1 的特殊地位还有两个实战推论：① PID 1 退出时，<b>内核会杀死该命名空间内的所有进程</b> —— 所以容器里不能随便 kill 1 号进程，这也是 <code>docker run --init</code> 存在的理由（插一个真正的 init 来回收孤儿进程、正确转发信号）；② 换了 PID 命名空间后，<b>必须重新挂载 procfs</b>（<code>mount -t proc proc /proc</code>），否则 <code>/proc</code> 里显示的仍是宿主机的进程列表 —— 这正是 31.5 的 stepper 里那一步。'
      },
      {
        id: 'c17q3', depth: 2, threshold: 0.7,
        q: '在写迷你容器时，为什么标准做法用 <b>pivot_root</b> 而不是 <b>chroot</b>？请说出 chroot 的至少一条<b>经典逃逸路径</b>，以及完整的、<b>不能省略任何一步</b>的换根流程。',
        concepts: [
          { label: 'chroot 只改根目录指针，不改变挂载事实，旧根仍可被引用',
            hint: 'chroot 修改的到底是什么？旧根去哪了？',
            any: ['只改根目录', '改根目录指针', '只是改路径', '只改路径', '路径解析', '旧根还在', '旧根仍然', '没改变挂载', '不改变挂载', '不是安全边界', '指针', 'fs_struct', 'root 指针'] },
          { label: '经典逃逸：持有外部 fd 用 fchdir 逃出；或保留 CAP_SYS_CHROOT 做嵌套逃逸',
            hint: '在 chroot 之前打开的 fd 会怎样？还能用吗？',
            any: ['fd', '文件描述符', 'fchdir', 'chdir', '已打开的', '外部 fd', '目录 fd', 'dirfd', '..', '向上爬', '嵌套', 'cap_sys_chroot', '再 chroot', '双 chroot', '逃逸', '绕回', '回到宿主'] },
          { label: 'pivot_root 在挂载树层面交换根，旧根可被卸载',
            hint: 'pivot_root 和 chroot 的作用层面有什么不同？',
            any: ['挂载树', '挂载层面', '交换根', '交换', '换挂载', 'mount namespace', '旧根可卸载', '可以卸载', '真正的根', '更安全', '标准做法'] },
          { label: '完整流程：MS_PRIVATE 私有化 + bind mount 使其成为挂载点 + pivot_root + 卸载 oldroot',
            hint: '少了 MS_PRIVATE 会怎样？少了 umount 会怎样？pivot_root 对 new_root 有什么硬性要求？',
            any: ['ms_private', 'ms_rec', '私有', 'private', 'bind', 'bind mount', 'ms_bind', '绑定挂载', '挂载点', '必须是挂载点', 'umount', '卸载', 'mnt_detach', 'oldroot', '惰性卸载', 'pivot_root'] }
        ],
        hints: [
          '关键区别在于：一个是在<b>路径解析</b>层面限制你，另一个是在<b>挂载树</b>层面换掉事实。已经打开的 fd 受路径解析限制吗？',
          '只调 pivot_root 却不卸载 oldroot，容器里 <code>ls /oldroot</code> 会看到什么？这说明少做了哪一步？'
        ],
        probes: [
          '为什么 pivot_root 之前必须先把 rootfs bind mount 一下？不做会报什么错？',
          '如果进程在 chroot 之前打开了宿主 <code>/</code> 的目录 fd，之后用 <code>fchdir</code> 会发生什么？为什么？'
        ],
        model: '核心区别一句话：<b>chroot 是「改路径」，pivot_root 是「换挂载树」。</b><code>chroot</code> 只修改进程 fs 结构里的根目录指针，被换掉的旧根<b>依然挂在系统上</b>，路径解析只是暂时看不见它而已；而 <code>pivot_root</code> 是在挂载命名空间里做真正的交换 —— 旧根变成一个普通挂载点，可以被彻底卸载。<br><br>chroot 的经典逃逸有两条。① <b>外部 fd 逃逸：</b>进程在 chroot <b>之前</b>打开了一个宿主机目录的 fd，chroot 之后调用 <code>fchdir(fd)</code> 把工作目录切过去，再 <code>chdir(&quot;..&quot;)</code> 逐级上爬，就回到了宿主机文件系统。<b>根因是：chroot 限制的是路径解析，而 fd 是对内核对象的直接引用，根本不走路径解析。</b>② <b>嵌套 chroot 逃逸：</b>进程若仍持有 <code>CAP_SYS_CHROOT</code>，可以在新根里再建一层目录、再 chroot 进去、然后 <code>chdir(&quot;..&quot;)</code> 跳到新根之外。现代内核已针对后者打了补丁，但只要还能再调 chroot 且能构造目录层级，就始终是隐患 —— 这也是为什么它不能当边界用。<br><br>完整的换根流程<b>四步都不能少</b>（对照 31.5 的 stepper）：<br>① <code>mount(NULL, &quot;/&quot;, NULL, MS_REC | MS_PRIVATE, NULL)</code> —— 把挂载树设为私有。<b>少了这步，容器里的挂载会传播回宿主机</b>，你在容器里挂个 tmpfs，宿主机的挂载表里也会冒出来。<br>② <code>mount(&quot;./rootfs&quot;, &quot;./rootfs&quot;, NULL, MS_BIND | MS_REC, NULL)</code> —— 绑定挂载到自身，让 rootfs 成为一个真正的挂载点。因为 <b>pivot_root 有一条硬性要求：new_root 必须已经是挂载点</b>，普通目录会直接返回 <code>EINVAL</code>。<br>③ <code>chdir(&quot;./rootfs&quot;); pivot_root(&quot;.&quot;, &quot;oldroot&quot;)</code> —— 交换根，旧根落到 <code>/oldroot</code>。<br>④ <code>umount2(&quot;/oldroot&quot;, MNT_DETACH)</code> —— <b>卸载旧根，这一步最常被漏掉</b>。不卸载的话容器里 <code>ls /oldroot</code> 就能看到整个宿主机文件系统，和 chroot 一样漏。因为此时工作目录还在旧根上，普通 <code>umount</code> 会 <code>EBUSY</code>，所以要用 <code>MNT_DETACH</code> 惰性卸载。<br><br>做完这四步，路径解析和 fd 引用两条逃逸通道同时被切断 —— 这正是 runc 等真实运行时的做法。'
      },
      {
        id: 'c17q4', depth: 2, threshold: 0.7,
        q: '一个容器用默认 bridge 网络启动，容器内监听 8080。请<b>逐跳描述</b>一个从容器发往 <code>8.8.8.8</code> 的数据包经过了哪些环节，并指出 <b>NAT 具体发生在哪一跳、为什么非做不可</b>。再说说 host 模式与 none 模式在这一路上分别少了什么、多了什么。',
        concepts: [
          { label: 'veth pair：容器 eth0 与宿主 vethXXXX 是一对，一进一出',
            hint: '容器里那块 eth0 是真的网卡吗？它的另一端在哪？',
            any: ['veth', 'veth pair', '网卡对', '成对', '虚拟网卡', 'eth0', 'vethxxxx', '另一端', '对端', 'iflink', '@if'] },
          { label: 'docker0 网桥做二层转发，再交给宿主 IP 层路由',
            hint: 'docker0 本质是什么设备？它在哪一层工作？',
            any: ['docker0', '网桥', 'bridge', '虚拟网桥', '二层', '交换机', '转发', 'mac', '路由表', 'ip 层', '路由'] },
          { label: 'SNAT / MASQUERADE 在宿主机出口改写源地址，回包靠 conntrack 还原',
            hint: '私有地址 172.17.0.2 怎么才能让外网把回包送回来？谁记下了这次转换？',
            any: ['snat', 'nat', 'masquerade', 'masq', '源地址', '地址转换', '伪装', 'conntrack', '连接跟踪', '改写源', '转换为宿主 ip', '宿主 ip', '出口'] },
          { label: 'host 模式共享宿主网络命名空间，无 veth/无网桥/无 NAT；none 模式只有 lo',
            hint: '两种极端模式各自牺牲了什么、保留了什么？',
            any: ['host 模式', 'host模式', '--network host', '共享宿主网络', '共享网络栈', '同一网络命名空间', '没有隔离', '无隔离', '端口冲突', 'none', '--network none', '只有 lo', '只有lo', '无网络', '没有网络'] }
        ],
        hints: [
          '先想清楚：容器里那块 <code>eth0</code> 到底连着哪里？它在宿主侧对应的那块网卡长什么样？',
          '容器的 IP 是 <code>172.17.0.2</code>，这个地址在公网上根本不存在。外网的应答包怎么可能找回来？'
        ],
        probes: [
          '那外界想主动访问容器怎么办？描述一下 DNAT 发生在哪里。',
          '<code>docker run -p 127.0.0.1:8080:8080</code> 和不写这个前缀有什么区别？为什么这关系到安全？'
        ],
        model: '逐跳走一遍（对照 31.7 的 stage）：<br><br><b>① 容器内进程发包</b>，源 <code>172.17.0.2</code>、目标 <code>8.8.8.8</code>，默认网关是 docker0 的地址 <code>172.17.0.1</code>。<b>② 进入容器的 eth0</b> —— 这块网卡不是硬件，而是 <b>veth pair 的一端</b>。<b>③ 包从宿主侧的 vethXXXX 出现</b> —— veth pair 的行为就是一进一出，像一根虚拟网线穿过两个网络命名空间。<b>④ docker0 网桥收到帧</b>，查转发表决定从哪个口转发。docker0 本质是<b>二层虚拟交换机</b>，同网段容器互 ping 靠它直接转发，<b>不经过 NAT</b>。<b>⑤ 目标不在 172.17.0.0/16 内，交给宿主机 IP 层做路由判断</b>，决定走物理网卡出去。<b>⑥ ★ NAT 就发生在这一跳</b>：在出口上做 <b>SNAT / MASQUERADE</b>，把源地址 <code>172.17.0.2</code> 改写成宿主机的出口 IP，同时在 <b>conntrack（连接跟踪表）</b>里记下这次转换。<b>⑦ 物理网卡 ethX 真正发出</b>，此时包的外观和宿主机自己发的完全一样。<b>⑧ 到达外网；回包回来后内核查 conntrack 把目标地址还原成 172.17.0.2</b>，再从 docker0 沿对应的 veth 送回容器。<br><br><b>为什么 NAT 非做不可：</b><code>172.17.0.2</code> 是私有地址，公网上没有路由，外网的回包根本不知道该送给谁 —— 连接必然失败。NAT 让成百上千个容器可以共用宿主机的<b>一个</b>公网 IP：靠改写源地址获得可达性，靠 conntrack 表在回程还原身份。<b>代价是外网无法主动连进容器</b>（容器 IP 在公网不存在），所以才需要端口映射：<code>-p 8080:8080</code> 会装一条 <b>DNAT</b> 规则，把发往宿主机 8080 的连接目标改写为 <code>172.17.0.2:8080</code> —— <b>出向 SNAT、入向 DNAT，是同一套 NAT 机制的对称使用</b>。<br><br><b>host 模式：整条路径全部消失。</b>容器直接共享宿主机的网络命名空间 —— 没有 veth、没有 docker0、没有 NAT，容器里 <code>ip addr</code> 看到的就是宿主机的网卡。收益是路径最短、性能最好、没有 NAT 开销；代价是<b>端口被独占</b>（宿主已占用 80，容器再听 80 会启动失败）、<b>网络隔离完全消失</b>（容器里改 iptables 会改到宿主机）。<b>none 模式：另一个极端</b>，只给一块 down 的 <code>lo</code>，连宿主都碰不到，适合离线计算或作为「白纸」自己手工配网。<br><br>排障顺序：容器 <code>ip addr</code> → 容器 <code>ip route</code> → 宿主 <code>ip link show master docker0</code> → <code>iptables -t nat -L</code>。四张表依次看，问题基本定位到具体哪一跳。'
      },
      {
        id: 'c17q5', depth: 3, threshold: 0.6,
        q: '<b>综合题。</b>某云手机平台用容器跑安卓实例（容器内跑 Android 用户态）。风控会检测「当前是否运行在容器中」。请你：<br>① 列出<b>至少四条</b>容器环境特征，并说明每条的<b>内核出处</b>（是哪套机制留下的）；<br>② 如果让你负责伪装，你会怎么处理，<b>难点在哪</b>；<br>③ 顺带说说：为什么这类平台多用<b>容器</b>而不是虚拟机，以及为什么远端的 x86 服务器上要准备 ARM 镜像。',
        concepts: [
          { label: '容器特征的具体项：/.dockerenv、/proc/1/cgroup 的容器 ID、网卡 @if 后缀、172.17 网段、随机主机名等',
            hint: '从「容器运行时会留下什么痕迹」这个角度穷举：文件、cgroup、网络、主机名、挂载表。',
            any: ['/.dockerenv', 'dockerenv', '/proc/1/cgroup', 'proc/1/cgroup', 'cgroup 路径', '容器id', '容器 id', 'kubepods', 'lxc', '@if', 'iflink', 'veth', '172.17', '172.18', '网段', '主机名', '随机主机名', '十六进制', 'overlay', '挂载表', 'mountinfo', '/proc/self/cgroup', 'lsns', '命名空间'] },
          { label: '每条特征的出处：namespace（视图）、cgroup（分组）、veth（网络）、挂载（rootfs）',
            hint: '不要只说「有痕迹」，要说出这个痕迹是被哪套内核机制产生的。',
            any: ['namespace', '命名空间', 'cgroup', 'veth', '挂载', 'mount', 'rootfs', '联合文件系统', 'overlayfs', 'union', 'pid 命名空间', 'net 命名空间', 'uts', '来源'] },
          { label: '伪装的难点：特征是「组合打分」而非单点，且反检测行为本身可疑；要像真的而不是像空的',
            hint: '删掉 /.dockerenv 就安全了吗？一个「过于干净」的环境会不会更可疑？',
            any: ['组合', '多条', '打分', '综合判断', '不止一条', '连锁', '改不干净', '难以完全', '反检测', '过于干净', '太干净', '不自然', '像真的', '一致性', '自洽', '内核层面', '改不了', '宿主内核', '无法伪造'] },
          { label: '选容器的理由：开销小、密度高、启动快、共享内核',
            hint: '对比虚拟机的启动开销和内存占用。',
            any: ['开销小', '开销低', '密度', '密度高', '启动快', '轻量', '共享内核', '省内存', '成本', '资源占用低', '毫秒', '多实例', '一台机器跑很多'] },
          { label: '跨架构理由：服务器多 x86_64，安卓生态以 ARM 为主，需 binfmt + QEMU 或对应架构镜像',
            hint: '服务器和安卓各自的架构是什么？靠什么弥合这个错位？',
            any: ['x86', 'x86_64', 'arm', 'arm64', '架构', 'binfmt', 'binfmt_misc', 'qemu', 'qemu-aarch64-static', '跨架构', '交叉', '指令翻译', '模拟', '生态', '错位', '服务器是 x86'] }
        ],
        hints: [
          '第一部分请分头找：<b>文件系统</b>上有什么？<b>cgroup</b> 里有什么？<b>网络</b>上有什么？<b>主机名和挂载表</b>呢？每找到一条，都追问「这是哪套内核机制造成的」。',
          '第二部分想一个反问：如果我把特征一条条删干净，风控会因此认为我是真机吗？一个「什么都不像」的环境，本身是不是一种异常？',
          '第三部分回忆 31.3 的分层图：容器省掉的是哪一整层？再看看本章开头那句话 —— 服务器是什么架构，安卓生态是什么架构？'
        ],
        probes: [
          '你说「删掉 /.dockerenv」，那 <code>/proc/1/cgroup</code> 里的容器 ID 呢？这条改得掉吗？为什么？',
          '如果这个平台换成全部用虚拟机跑安卓，单机能开的实例数是变多还是变少？用户能感知到什么差异？',
          '跨架构方案在什么情况下会失效？为什么它不能代替真机做兼容性验证？'
        ],
        model: '<b>① 容器特征的清单与出处（这是本章最实用的一张表）。</b><br>'
          + '· <code>/.dockerenv</code> —— 文件系统标记，由 Docker 运行时在容器根目录创建（<b>有则可疑，无则不证明不是</b>：可以删，别的运行时也不建）。<br>'
          + '· <code>cat /proc/1/cgroup</code> 出现 <code>/docker/&lt;64位ID&gt;</code>、<code>/kubepods/...</code>、<code>/lxc/...</code> —— <b>出自 cgroup 分组</b>：容器主进程被放进了运行时创建的 cgroup 层级里，路径本身就是证据。<br>'
          + '· 网卡名形如 <code>eth0@if123</code>，或宿主上出现一堆 <code>vethXXXX</code> —— <b>出自网络命名空间 + veth pair</b>：那个 <code>@ifN</code> 后缀就是对端接口索引，等于自白「我是虚拟网卡对的一端」。<br>'
          + '· IP 落在 <code>172.17.0.0/16</code> / <code>172.18.0.0/16</code>，网关是 <code>x.x.0.1</code> —— <b>出自 docker0 网桥的默认网段分配</b>。<br>'
          + '· 主机名是一串随机十六进制 —— <b>出自 UTS 命名空间</b>：运行时在新建的 UTS 里随机设置了主机名。<br>'
          + '· 挂载表（<code>/proc/self/mountinfo</code>）里出现大量 <code>overlay</code> / <code>tmpfs</code> 组合、缺少真机常见的分区挂载 —— <b>出自挂载命名空间 + 联合文件系统</b>。<br>'
          + '· <code>/proc/self/ns/*</code> 的 inode 号与 init 不同、<code>lsns</code> 里进程数极少 —— <b>命名空间本身</b>的直接暴露。<br><br>'
          + '<b>② 伪装该怎么做、难在哪。</b>做法：逐条对应地处理 —— 删 <code>/.dockerenv</code>、改 /proc 视图或 mask 掉 cgroup 路径、把网卡改名去特征并换网段、把主机名设成像真机的形式（如 <code>Pixel-7</code>）、补齐真实设备应有的挂载与文件。<b>难点有三层：</b>第一层，<b>单条不可靠、组合才致命</b> —— 风控是打分而非一票否决，你漏掉任何一条都可能被组合规则命中；第二层，<b>反检测行为本身就是特征</b> —— 环境「过于干净」（cgroup 只剩一条、挂载表空白、什么痕迹都没有）比留着痕迹更可疑，<b>伪装的目标是「像真的」，不是「像空的」</b>；第三层，也是最硬的：<b>有些特征在内核层面，用户态改不动</b> —— 你改不掉「内核是宿主的」，也改不掉真实的命名空间拓扑，只能尽量把可观测面做成自洽的。所以真正成熟的方案通常不是「删特征」，而是<b>让整套环境特征互相自洽</b>，包括 IP 归属、设备型号、传感器数据、网络时延等一整套。<span class="pill warn">具体平台的检测项与权重差异很大，需按目标逐个验证，待核实</span><br><br>'
          + '<b>③ 为什么用容器而不是虚拟机。</b>对照 31.3 的分层图：容器<b>省掉了整个 Guest OS</b> —— 不用为每个实例引导内核、不用预留大块内存、不用复制一份 OS 镜像。结果是启动毫秒级、单机密度从「十几个」提升到「几十上百个」，<b>每用户成本直接下降一个量级</b>。代价是隔离更弱（内核漏洞共享风险），所以这类平台通常还会叠加额外的加固措施，并且不适合承载高安全等级的业务。<br><br>'
          + '<b>为什么 x86 服务器上要准备 ARM 镜像。</b>因为存在架构错位：<b>服务器几乎全是 x86_64，而安卓应用生态以 ARM 为主</b>。弥合方式就是 31.10 那条链路 —— 内核的 <b>binfmt_misc</b> 识别 ARM64 的 ELF 并交给 <b>QEMU user-mode</b> 解释器执行，透明翻译指令、把系统调用转发给宿主内核。<b>注意最容易踩的坑：chroot 之后解释器路径在 rootfs 内解析，所以 <code>qemu-aarch64-static</code> 必须复制进 rootfs</b>，否则 <code>Exec format error</code>。它失效的场景包括大量 <code>ioctl</code>、自修改代码（JIT）、依赖特定 CPU 特性的代码 —— 这也是<b>为什么它不能代替真机</b>：安卓上的 ART 大量使用 JIT 与原生库，跨架构翻译下的行为与真机存在差异，兼容性和反调试行为的验证最终仍要回到真机或对应的模拟器方案（第 30 章）。'
      }
    ]
  }
};
