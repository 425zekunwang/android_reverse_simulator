window.CHAPTER = {
  no: 11,
  title: 'eBPF 环境搭建与热门源码赏析',
  lede: '前面几章你一直在<strong>用户态</strong>里和对手贴身肉搏：Frida 注入、脱壳、反调试，招招都在对方的视野里。这一章把观测点整体往下压一层——<strong>eBPF</strong> 让一小段受限程序直接跑在 Linux 内核中，用内核的视角去看系统调用、文件访问和函数调用。本章先讲清 eBPF 的安全模型（内核凭什么敢执行你写的代码），再落到 Android 的真实限制（为什么大多数手机根本跑不起来），最后回答一个绕不开的问题：<strong>这对逆向到底有什么用</strong>。',
  meta: [
    '核心问题：<b>一段用户写的代码，凭什么被允许跑在内核里？</b>',
    '关键工具：<b>clang -target bpf + libbpf / CO-RE / BCC / bpftrace / bpftool</b>',
    '对手：<b>被观测的 App（看不见你）＋ 厂商裁剪过的内核（它挡得住你）</b>'
  ],

  sections: [
    /* ================= 11.1 直觉 ================= */
    {
      h: '11.1',
      title: '先建立直觉：内核里为什么要装一个虚拟机',
      intuition: {
        tag: '直觉模型 · 传送带上的安检机器人',
        body:
          '<p>你是一家机场的安保负责人。传统做法是：<b>站在出口拦人翻包</b>——这相当于用户态 hook（Frida、PLT hook），你在行李已经离开传送带之后才动手，动作大、容易被看见。</p>' +
          '<p>eBPF 的做法是：<b>把一台只会执行你写的检查清单的机器人，直接装到传送带内部</b>。这台机器人上岗前要过机场自己的严格审查（<b>验证器</b>），上岗后只能用机场指定的几件工具（<b>helper 函数</b>），只能把结果写进一本共享登记本（<b>BPF Map</b>），而且明令禁止三件事：<b>不许搬走行李、不许改动行李、不许赖着不走（不许死循环、不许睡眠阻塞）</b>。</p>' +
          '<p>机器人被锁死在传送带里，旅客（App）根本看不见它——这就是 eBPF 对逆向最大的价值，也是它最大的风险来源。</p>'
      },
      html:
        '<p><b>BPF</b>（Berkeley Packet Filter）不是什么新概念——1992 年就提出了，它是 <code>tcpdump</code> 背后那套' + T.term('包过滤', '在网络栈中按规则筛掉不需要的报文，只把关心的包交给上层，避免无谓的数据拷贝') + '机制的底座，干的事很窄：从网络包里按规则挑出你要的那些。</p>' +
        '<p>2014 年（Linux 3.18）内核把 BPF 整个重做了一遍，从「包过滤器」升级成了<strong>一个运行在内核中的' + T.term('通用虚拟机', '这里指 eBPF 不再是某个固定用途的过滤器，而是能执行通用字节码、挂到多种事件源上的执行引擎') + '</strong>，这就是 <b>eBPF</b>（extended BPF）。它今天被用来做' + T.term('可观测性', 'Observability：通过系统调用、函数调用、网络等外部信号推断系统内部正在发生什么，而不是靠加日志') + '（性能分析、系统调用追踪）、网络（负载均衡、DDoS 防护）和安全监控（运行时检测、LSM 策略）。</p>' +
        T.tbl(['阶段', '是什么', '典型使用者'], [
          ['BPF（1992）', '网络包过滤的字节码，只处理网络包', 'tcpdump、libpcap'],
          ['eBPF（2014，Linux 3.18）', '内核中的通用虚拟机，可挂到几十种事件源上', '性能分析、网络安全、可观测性']
        ]) +
        T.note('key', '🔑 本章主线', '<p>记住三件事就够了：<b>①</b> eBPF 程序是<b>内核态</b>运行的；<b>②</b> 它能运行的前提是内核的<b>验证器</b>静态证明它安全；<b>③</b> 它和用户态通信用的是 <b>BPF Map</b>。全章的动画、代码和题目都围绕这三点转。</p>') +
        T.note('warn', '⚠️ 时效性警告（务必先读）',
          '<p>本章内容以 <b>2023 年前后</b>的 Linux / Android 生态为背景撰写。eBPF 本身和它在 Android 上的支持情况演进非常快——<b>内核版本、厂商配置、SELinux 策略在不同设备上差异极大</b>。</p>' +
          '<p>所以本章中任何涉及「当前支持情况」「最新内核版本」「某配置项默认是否开启」的表述，<b>都请当成线索而不是结论</b>，一律以你自己设备上的实测结果为准。文中不确定的点会用 ' + T.pill('warn', '待核实') + ' 标出。</p>') +
        T.note('', '📌 一句话记住 eBPF 和 Frida 的分工',
          '<p>' + T.term('Frida', '用户态动态插桩框架，需要注入目标进程，改变其内存与指令') + ' 是「<b>进到敌人家里装摄像头</b>」——看得细，但你要先破门而入，家里的人一定知道有人来过。eBPF 是「<b>在小区门口的电线杆上装摄像头</b>」——看不清家里沙发的花纹，但能看清谁几点进出、拎了什么包，而且住户完全不知道摄像头存在。</p>' +
          '<p>两者的观测粒度和隐蔽性是一组<b>此消彼长</b>的权衡，不是谁替代谁。第 13 章讲的内核态对抗里，eBPF 是标准观测手段。</p>')
    },

    /* ================= 11.2 生命周期 stage ================= */
    {
      h: '11.2',
      title: '一个 eBPF 程序的完整生命周期（本章最重要的动画）',
      html:
        '<p>下面这台动画把 eBPF 从「一段 C 源码」到「用户态看见结果」的全过程拆成 14 步。' +
        '请特别留意两个地方：<b>第 ④ 步（' + T.term('验证器', '内核在加载 eBPF 程序时做静态分析，证明它不会崩溃内核、不会无限循环、内存访问不越界') + '）为什么能保证安全</b>，以及<b>第 ⑧⑨ 步（数据怎么从内核回到用户态）</b>。' +
        '把这两处想通，eBPF 的整个设计哲学就通了。</p>',
      stage: {
        title: 'eBPF 程序生命周期：从 C 源码到内核机器码，再回到用户态',
        speed: 2600,
        render:
          '<div class="flow-row" style="align-items:flex-start;gap:16px;flex-wrap:wrap">' +
            '<div class="flow-col" style="flex:1 1 300px">' +
              '<div class="blk" id="e1">① 写 eBPF 程序（C 的受限子集）</div>' +
              '<div class="arrow">▼</div>' +
              '<div class="blk" id="e2">② clang -target bpf 编译 → eBPF 字节码 .o</div>' +
              '<div class="arrow">▼</div>' +
              '<div class="blk" id="e3">③ 用户态 bpf(BPF_PROG_LOAD) 提交字节码</div>' +
              '<div class="arrow">▼</div>' +
              '<div class="blk" id="e4">④ 内核验证器 verifier 逐项静态检查</div>' +
              '<div class="arrow">▼</div>' +
              '<div class="blk" id="e5">⑤ JIT 编译成本机机器码</div>' +
              '<div class="arrow">▼</div>' +
              '<div class="blk" id="e6">⑥ attach 到钩子点（kprobe / tracepoint…）</div>' +
              '<div class="arrow">▼</div>' +
              '<div class="blk" id="e7">⑦ 事件触发，内核执行你的程序</div>' +
              '<div class="arrow">▼</div>' +
              '<div class="blk" id="e8">⑧ 用 helper 写 BPF Map / ringbuf</div>' +
              '<div class="arrow">▼</div>' +
              '<div class="blk" id="e9">⑨ 用户态读 Map，拿到结果</div>' +
            '</div>' +
            '<div class="flow-col" style="flex:1 1 340px">' +
              '<div class="card" style="margin-top:10px"><div class="card-title">事件记录（ringbuf 里的内容）</div>' +
              '<div class="term-box" id="ebuf" style="min-height:100px">[ 空 ]</div></div>' +
              '<div class="term-box" id="elog" style="margin-top:10px">$ 等待开始…</div>' +
              '<div class="card" style="margin-top:10px"><div class="card-title">这一步为什么重要</div>' +
              '<div id="ewhy"><p class="muted">点「下一步 ▶」或「自动播放」开始。</p></div></div>' +
            '</div>' +
          '</div>',
        reset: () => {
          for (let i = 1; i <= 9; i++) S('e' + i, '');
          SET('elog', '$ 等待开始…');
          SET('ebuf', '[ 空 ]');
          SET('ewhy', '<p class="muted">点「下一步 ▶」或「自动播放」开始。</p>');
        },
        steps: [
          {
            run: () => { S('e1', 'active'); SET('elog', '$ vim minimal.bpf.c'); SET('ewhy', '<p><b>① 写程序。</b>eBPF 程序用什么语言写？答案是 <b>C 的一个受限子集</b>（也可以用 Rust，通过 Aya 之类的框架）。</p><p>「受限」体现在：不能调用任意内核函数（只能调内核白名单里的 <b>helper</b>）、不能动态分配内存、不能无限循环、不能睡眠。你写的是一个<b>看见事件就处理、处理完就退出</b>的小函数。</p>'); },
          },
          {
            run: () => { S('e1', 'done'); S('e2', 'active'); SET('elog', '$ clang -O2 -g -target bpf -c minimal.bpf.c -o minimal.bpf.o\\n$ file minimal.bpf.o\\nminimal.bpf.o: ELF 64-bit LSB relocatable, eBPF'); SET('ewhy', '<p><b>② 编译。</b>关键参数是 <code>-target bpf</code>：让 clang 生成的是 <b>eBPF 字节码</b>，而不是你宿主机的 x86/ARM 机器码。</p><p>产物是一个普通的 <b>ELF 文件</b>（<code>.o</code>），里面装着字节码、Map 定义、以及<b>重定位信息</b>。注意：此时它还是「平台无关」的中间产物，没跟任何具体内核绑定。</p>'); },
          },
          {
            run: () => { S('e2', 'done'); S('e3', 'active'); SET('elog', '用户态：bpf(BPF_PROG_LOAD, &attr, sizeof(attr))\\n  prog_type  = BPF_PROG_TYPE_KPROBE\\n  insns      = <字节码数组>\\n  license    = "GPL"\\n→ 返回 fd = 7'); SET('ewhy', '<p><b>③ 提交内核。</b>字节码不会自己跑进内核。必须由用户态程序通过 <code>bpf()</code> 系统调用、以 <code>BPF_PROG_LOAD</code> 命令把字节码连同元信息一起交给内核。</p><p>两个容易被忽略的点：<b>①</b> 加载<b>需要权限</b>（内核里检查 <code>CAP_BPF</code>/<code>CAP_SYS_ADMIN</code> 一类的能力），普通进程根本没资格；<b>②</b> 要提供 <b>license</b>，声明为 <code>GPL</code> 才允许调用某些 GPL-only 的 helper——许可证不匹配时加载会直接失败。</p>'); },
          },
          {
            run: () => { S('e3', 'done'); S('e4', 'active'); SET('elog', '内核对字节码做静态分析（不是运行它）…\\n  · 控制流可达性\\n  · 循环是否有界\\n  · 每条内存访问的边界\\n  · 寄存器/指针类型\\n  · helper 调用是否合法'); SET('ewhy', '<p><b>④ 验证器（verifier）。这是 eBPF 安全性的基石，没有之一。</b></p><p>内核面对的是一个哲学问题：<b>凭什么允许一段用户写的代码在内核态执行？</b>答案不是「信任作者」，而是「<b>用程序证明程序安全</b>」。验证器会模拟执行字节码的<b>所有可能路径</b>，逐条指令检查——它不是沙箱里跑一遍看会不会崩，而是<b>静态地证明</b>这段代码不可能把内核搞坏。</p><p>接下来的三步是验证器最重要的三项检查。</p>'); },
          },
          {
            run: () => { S('e4', 'hot'); SET('elog', '  [检查 1] 循环\\n   旧内核：完全禁止循环，直接拒绝\\n   新内核：允许，但必须能证明循环「有界」\\n  → 无法证明上界的循环：REJECTED'); SET('ewhy', '<p><b>④a 检查循环。</b>最早的 eBPF <b>完全禁止循环</b>，因为循环意味着「可能永不结束」，而内核态死循环等于<b>整机卡死</b>。</p><p>后来的内核放宽了这一限制：允许循环，但验证器必须能<b>证明它有界</b>（例如循环次数是常量、或由 Map 里的值限定在某个范围内的有界循环）。证明不了的，直接拒收。</p><p>这就是为什么 eBPF 程序里写 <code>while</code> 要格外小心——它可能是你被拒的最常见原因。</p>'); },
          },
          {
            run: () => { S('e4', 'hot'); SET('elog', '  [检查 2] 内存访问\\n   寄存器 R1 = ctx 指针，偏移 0 → 允许\\n   寄存器 R2 = 用户态指针 → 禁止直接解引用\\n  → 必须改用 bpf_probe_read_user*() 一类的 helper'); SET('ewhy', '<p><b>④b 检查内存访问。</b>这是最容易踩坑、也最能体现 eBPF 设计意图的一项。</p><p>内核指针（<code>ctx</code>、Map value、数据包）的每一次读写，偏移量都必须被验证器证明<b>落在合法范围内</b>。越界一次就是内核崩溃或者信息泄露。</p><p>而<b>用户态指针在内核里绝对不能直接解引用</b>——因为用户态可以随时把这块内存 unmap 掉，直接读会触发内核 oops。必须用 <code>bpf_probe_read_user()</code> 这类 helper，由内核替你做「安全拷贝」并在失败时返回错误码。你在写 eBPF 时的别扭感，多半来自这条规则。</p>'); },
          },
          {
            run: () => { S('e4', 'hot'); SET('elog', '  [检查 3] 指针类型\\n   R1 = PTR_TO_CTX    → 不能当 PTR_TO_MAP_VALUE 用\\n   R1 += 100          → 类型退化为标量，需重新验证边界\\n  → 类型不匹配：REJECTED'); SET('ewhy', '<p><b>④c 检查指针类型。</b>验证器内部维护一套<b>寄存器类型系统</b>：这个寄存器是 ctx 指针、这个指向 Map 的 value、那个是数据包指针、那个只是个标量数字。</p><p>类型是一道<b>硬墙</b>：ctx 指针不能当 Map value 用，数据包指针不能当栈指针用。更微妙的是，<b>指针一旦做算术运算（加偏移），类型就会退化</b>，之后想再用它读写，必须重新做边界检查。</p><p>此外验证器还会检查 helper 的<b>调用白名单和参数类型</b>——不是所有 helper 对所有程序类型都开放。</p>'); },
          },
          {
            run: () => { S('e4', 'hot'); SET('elog', '  [补充] 验证通过 → 内核返回 prog fd\\n  [失败]   EACCES / EPERM + verifier log\\n\\n  $ cat /sys/kernel/debug/tracing/... 可查看日志'); SET('ewhy', '<p><b>验证失败是常态，不是异常。</b>真写起来你会发现，第一次加载 eBPF 程序几乎一定会被拒。好消息是验证器会输出一份<b>逐指令的日志</b>（通常通过 <code>libbpf_set_print()</code> 或环境变量打开），告诉你第几条指令、哪个寄存器、哪条规则没过。</p><p><b>排查口诀：先看循环有没有上界，再看有没有直接解引用用户态指针，最后看指针类型有没有用混。</b></p>'); },
          },
          {
            run: () => { S('e4', 'done'); S('e5', 'active'); SET('elog', 'JIT：字节码 → 本机机器码（x86-64 / arm64）\\n  bpf_jit_enable = 1\\n加载后即成为内核里一段真实可执行的函数'); SET('ewhy', '<p><b>⑤ JIT 编译。</b>验证通过后，内核把它<b>即时编译成本机机器码</b>（Just-In-Time）。这一步是性能的关键：eBPF 不是解释执行的，跑起来和手写的内核代码是同一个量级。</p><p>如果设备内核没开 JIT（<code>CONFIG_BPF_JIT</code>），程序只能解释执行，性能差一大截——这也是厂商裁剪内核时的一个常见受害项。</p>'); },
          },
          {
            run: () => { S('e5', 'done'); S('e6', 'active'); SET('elog', 'attach：把程序挂到事件源上\\n  kprobe/do_sys_open      → 内核函数被调用时\\n  tracepoint/syscalls/... → 系统调用进入/退出时\\n  uprobe:/lib/libc.so:fn  → 用户态函数被调用时'); SET('ewhy', '<p><b>⑥ 挂载（attach）。</b>程序本身不知道自己要干什么，必须先<b>绑定到一个钩子点</b>。这是 eBPF 灵活性的来源——同一段逻辑换个 attach 点，就从「追踪文件打开」变成「追踪网络连接」。</p>' + T.tbl(['钩子类型', '挂在哪里', '对逆向的价值'], [
            ['kprobe / kretprobe', '内核函数入口 / 返回', '看内核替 App 做了什么（文件、网络、权限检查）'],
            ['uprobe / uretprobe', '用户态函数入口 / 返回', '<b>最高</b>：直接盯 so 里的加密、解密、校验函数'],
            ['tracepoint', '内核预定义的静态追踪点', '稳定，不依赖内核函数名；<b>推荐优先用</b>'],
            ['XDP', '网络驱动层最早的处理点', '高性能包处理、DDoS 防护'],
            ['tc', '流量控制层', '网络过滤、限速'],
            ['perf_event / socket filter / LSM', '性能事件 / socket / 安全策略', '采样分析、包过滤、安全策略钩子']
          ]) + '</p>'); },
          },
          {
            run: () => { S('e6', 'done'); S('e7', 'active'); SET('e7', 'hot'); SET('elog', '[事件发生] 某个进程调用 openat()\\n→ 进入内核 do_sys_open\\n→ 内核发现这里挂着 BPF 程序\\n→ 调用 JIT 后的机器码（微秒级）'); SET('ewhy', '<p><b>⑦ 触发执行。</b>现在你的代码是内核执行路径的一部分了：只要有进程碰这个事件，内核就会调用你。</p><p><b>关键点：触发是「被动」的。</b>eBPF 没有轮询、没有定时器，它只在<b>事件发生的那一刻</b>被内核叫起来。程序本身极短——读几个字段、写进 Map、返回。这也是它能做到微秒级开销的原因。</p>'); },
          },
          {
            run: () => { S('e7', 'done'); S('e8', 'active'); SET('ebuf', '{\\n  pid  : 4821,\\n  comm : "browser",\\n  fname: "/proc/self/maps"\\n}'); SET('elog', 'e->pid  = bpf_get_current_pid_tgid() >> 32;\\nbpf_get_current_comm(&e->comm, sizeof(e->comm));\\nbpf_probe_read_user_str(&e->fname, ...);\\nbpf_ringbuf_submit(e, 0);   // → 推给用户态'); SET('ewhy', '<p><b>⑧ 回传结果。</b>程序在内核态，怎么把数据交出来？答案只有一条路：<b>BPF Map</b>——内核态和用户态共享的键值存储，是两者通信的<b>主要</b>通道。</p><p>内核态这边用 helper 操作：<code>bpf_map_lookup_elem()</code>、<code>bpf_map_update_elem()</code>、<code>bpf_map_delete_elem()</code>。</p><p>流式数据（比如源源不断的事件）现在推荐用 <b>ringbuf</b>（<code>BPF_MAP_TYPE_RINGBUF</code>），它取代了老式的 <code>perf_event_array</code>：<b>单生产者单消费者、无锁、高效</b>，也不会像 perf buffer 那样给每个 CPU 开一份缓冲。</p>'); },
          },
          {
            run: () => { S('e8', 'done'); S('e9', 'active'); SET('ebuf', '[ 已被用户态读走，槽位释放 ]'); SET('elog', '$ sudo ./minimal\\npid=4821  comm=browser  file=/data/local/tmp/x.bin\\npid=4821  comm=browser  file=/proc/self/maps'); SET('ewhy', '<p><b>⑨ 用户态收割。</b>用户态通过 <code>bpf()</code> 系统调用（或者直接用 <b>libbpf</b> 封装好的 API）读 Map，拿到内核递出来的结构体，打印、写日志、发给分析平台。</p><p>到这里整个闭环完成：<b>源码 → 字节码 → 验证 → JIT → 挂载 → 触发 → 写 Map → 用户态读取</b>。这九步就是 eBPF 的全部骨架，后面所有复杂项目（Cilium、Falco、各种 tracing 工具）都是它加了不同的钩子和 Map 类型。</p>'); },
          },
          {
            run: () => { S('e9', 'done'); SET('elog', '✓ 闭环完成。\\n整个过程中，目标进程:\\n  · 没有被注入\\n  · 没有新增模块\\n  · 没有新增线程\\n  · 没有新增监听端口'); SET('ewhy', '<p><b>回头看一个关键事实：</b>在这整条链路里，<b>被观测的那个进程从头到尾不知道发生了什么</b>。它的内存没被改、模块列表没变、线程表没变、端口没开。</p><p>这就是下一节要展开的核心价值。但先泼一盆冷水：<b>上面这套流程在 PC 的 Linux 上很顺，在 Android 手机上会撞上四堵墙</b>——11.6 节细说。</p>'); }
          }
        ]
      },
      after:
        T.note('ok', '✅ 把九步压成一句话',
          '<p><b>用 C 写、clang 编译成字节码、bpf() 系统调用送进内核、验证器证明它安全、JIT 编译、挂到钩子上、事件触发时执行、结果写进 Map、用户态读取。</b></p>' +
          '<p>面试或讨论里，只要你能把这九步顺着说下来，并说清「验证器保证了什么」，就已经超过大多数只会背名词的人。</p>')
    },

    /* ================= 11.3 BPF Maps 数据流 ================= */
    {
      h: '11.3',
      title: 'BPF Maps：数据怎么从内核态回到用户态',
      html:
        '<p>上一节的第 ⑧⑨ 步值得单独拉出来做一台动画。原因很简单：<b>eBPF 程序什么都干不了，它只能把结果塞进 Map</b>。' +
        '你写 eBPF 时 90% 的挫败感都来自这一层——数据明明采到了，用户态就是读不出来。</p>' +
        '<p>先记住一个反直觉的事实：<b>Map 不是「内核发给用户态的消息」</b>，它是<b>一块双方都能按 fd 访问的共享存储</b>。' +
        '内核侧和用户态侧谁也不「发送」什么，只是各自往同一个 fd 上读写而已。理解这一点，后面所有的 API 都顺了。</p>',
      stage: {
        title: 'BPF Map 的内核态 ↔ 用户态数据通路',
        speed: 2000,
        render:
          '<div class="flow-row" style="align-items:flex-start;gap:14px;flex-wrap:wrap">' +
            '<div class="flow-col" style="flex:1 1 280px">' +
              '<div class="card"><div class="card-title">内核态 Kernel</div>' +
                '<div class="blk" id="k1">eBPF 程序（kprobe 命中）</div>' +
                '<div class="arrow">▼</div>' +
                '<div class="blk" id="k2">helper 调用</div>' +
                '<div class="pill" id="k3">bpf_get_current_pid_tgid()</div><br>' +
                '<div class="pill" id="k4">bpf_get_current_comm()</div><br>' +
                '<div class="pill" id="k5">bpf_probe_read_user_str()</div><br>' +
                '<div class="arrow">▼</div>' +
                '<div class="blk" id="k6">bpf_ringbuf_reserve() 取记录槽</div>' +
                '<div class="arrow">▼</div>' +
                '<div class="blk" id="k7">bpf_ringbuf_submit() 提交</div>' +
              '</div>' +
            '</div>' +
            '<div class="flow-col" style="flex:0 0 200px">' +
              '<div class="blk" id="m1">BPF Map</div>' +
              '<div class="pill" id="m2">RINGBUF</div>' +
              '<div class="term-box" id="mbuf" style="min-height:120px">[ 空 ]</div>' +
            '</div>' +
            '<div class="flow-col" style="flex:1 1 280px">' +
              '<div class="card"><div class="card-title">用户态 Userspace</div>' +
                '<div class="blk" id="u1">libbpf 加载程序</div>' +
                '<div class="arrow">▼</div>' +
                '<div class="blk" id="u2">bpf_map__fd() 拿到 Map fd</div>' +
                '<div class="arrow">▼</div>' +
                '<div class="blk" id="u3">ring_buffer__new() 注册回调</div>' +
                '<div class="arrow">▼</div>' +
                '<div class="blk" id="u4">ring_buffer__poll() 轮询</div>' +
                '<div class="arrow">▼</div>' +
                '<div class="blk" id="u5">回调里拿到 struct event</div>' +
                '<div class="arrow">▼</div>' +
                '<div class="pill ok" id="u6">printf 输出</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="term-box" id="mlog" style="margin-top:12px">$ 等待开始…</div>',
        reset: () => {
          ['k1','k2','k6','k7','m1','u1','u2','u3','u4','u5'].forEach(i => S(i, ''));
          ['k3','k4','k5'].forEach(i => CLS(i, 'pill'));
          CLS('m2', 'pill');
          CLS('u6', 'pill ok');
          SET('mbuf', '[ 空 ]');
          SET('mlog', '$ 等待开始…');
        },
        steps: [
          { run: () => { S('k1', 'active'); SET('mlog', '$ sudo ./trace_open\\n[内核] kprobe/tracepoint 触发 → 进入 eBPF 程序'); }, },
          { run: () => { S('k1', 'done'); S('k2', 'active'); SET('mlog', 'e->pid = bpf_get_current_pid_tgid() >> 32;'); }, },
          { run: () => { S('k3', 'cool'); SET('mlog', 'e->pid = bpf_get_current_pid_tgid() >> 32;\\n  → 高 32 位是 PID，低 32 位是 TID（一个 64 位数拆两半）'); }, },
          { run: () => { S('k4', 'cool'); SET('mlog', 'bpf_get_current_comm(&e->comm, sizeof(e->comm));\\n  → 进程名，最多 16 字节，含结尾的 \\\\0'); }, },
          { run: () => { S('k5', 'cool'); SET('mlog', 'bpf_probe_read_user_str(&e->fname, sizeof(e->fname), filename);\\n  → 内核里不能直接解引用用户态指针，必须让 helper 代读'); }, },
          { run: () => { S('k2', 'done'); S('k6', 'active'); SET('mbuf', '[ 已预留一条记录槽 ]'); SET('mlog', 'e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);\\nif (!e) return 0;   // 预留失败直接返回，不能阻塞'); }, },
          { run: () => { S('k6', 'done'); S('k7', 'active'); SET('m1', 'active'); CLS('m2', 'pill acc'); SET('mbuf', '{\\n  pid : 4821,\\n  comm: "browser",\\n  fname:"/proc/self/maps"\\n}'); SET('mlog', 'bpf_ringbuf_submit(e, 0);\\n  → 记录被推到 ringbuf 消费者侧'); }, },
          { run: () => { S('k1', 'done'); S('k7', 'done'); S('m1', 'done'); S('u1', 'active'); SET('mlog', '$ sudo ./trace_open\\n[用户态] libbpf 已完成程序加载与 attach'); }, },
          { run: () => { S('u1', 'done'); S('u2', 'active'); SET('mlog', 'int map_fd = bpf_map__fd(skel->maps.events);\\n  → 这就是那块共享存储的句柄'); }, },
          { run: () => { S('u2', 'done'); S('u3', 'active'); SET('mlog', 'rb = ring_buffer__new(map_fd, handle_event, NULL, NULL);\\n  → 注册回调：内核每提交一条，就调一次 handle_event()'); }, },
          { run: () => { S('u3', 'done'); S('u4', 'active'); SET('m1', 'hot'); SET('mlog', 'while (1) ring_buffer__poll(rb, 100 /* ms */);\\n  → 用户态主动轮询（本质是对 Map fd 做 epoll）'); }, },
          { run: () => { S('u4', 'done'); S('u5', 'active'); SET('mbuf', '[ 已消费，缓冲清空 ]'); SET('mlog', '[回调 handle_event]\\n  ctx->pid = 4821, ctx->comm = "browser"'); }, },
          { run: () => { S('u5', 'done'); S('u6', 'active'); SET('m1', ''); CLS('m2', 'pill'); SET('mlog', 'printf("pid=%d comm=%s file=%s\\\\n", ...);\\npid=4821 comm=browser file=/proc/self/maps'); }, },
          { run: () => { S('u6', 'cool'); SET('mlog', '✓ 闭环。\\n注意：全程没有任何数据「被发送」——内核写、用户态读，\\n共享的是同一个 fd。'); }, }
        ]
      },
      after:
        T.note('key', '🔑 Map 选型速查（记这 5 个就够入门）', '') +
        T.tbl(['Map 类型', '结构', '什么时候用'], [
          ['<code>BPF_MAP_TYPE_HASH</code>', '键值对，可增删', '按 pid / 路径 / 五元组聚合统计'],
          ['<code>BPF_MAP_TYPE_ARRAY</code>', '定长数组，索引即键', '配置下发、固定槽位的计数器'],
          ['<code>BPF_MAP_TYPE_PERCPU_ARRAY</code>', '每个 CPU 一份副本', '高频计数，避免多核写冲突'],
          ['<code>BPF_MAP_TYPE_RINGBUF</code>', '单生产者单消费者环形缓冲', '<b>流式事件，现代首选</b>，取代 perf_event_array'],
          ['<code>BPF_MAP_TYPE_PERF_EVENT_ARRAY</code>', '每 CPU 一份 perf 缓冲', '老代码常见，新项目不推荐']
        ]) +
        T.note('warn', '⚠️ 三个最容易踩的坑',
          '<p><b>① 有界与失败处理。</b>在 eBPF 里做 Map 查找，返回值<b>必须判空</b>；写 ringbuf 前 <code>reserve</code> 失败也必须返回。验证器会盯着你——忘记判空，加载就被拒。</p>' +
          '<p><b>② 值大小限制。</b>往 Map value 里塞东西时，结构体大小、栈上临时变量的尺寸都有上限，超出会直接编译或加载失败。大结构体要拆着写或者改用 ringbuf 直接写。</p>' +
          '<p><b>③ perf buffer 的串扰。</b>老式 <code>perf_event_array</code> 是每 CPU 一份缓冲，多核下事件顺序会被打乱，且要开一大堆 fd。这就是 ringbuf 被推出来的原因。</p>') +
        T.note('', '📌 对你的逆向工作意味着什么',
          '<p>你现在应该能看出：<b>「内核态观测」是一个天然的隐蔽通道</b>。数据从 App 看不见的地方被采集、写进内核里的一块存储、再由一个<b>和 App 毫无关系的进程</b>读走。</p>' +
          '<p>App 就算把 <code>/proc/self/maps</code> 翻烂，也不会看到任何异常——因为它本来就不在自己的地址空间里。这正是 11.5 节要展开的对比。</p>')
    },

    /* ================= 11.4 最小程序 stepper ================= */
    {
      h: '11.4',
      title: '解剖一段最小的 eBPF 程序（逐行代码推演）',
      html:
        '<p>下面这段代码短到可以背下来，但它包含了 eBPF 程序的<b>全部结构要素</b>：SEC 注解、上下文、helper、Map、有界检查。' +
        '看懂它，再去看 libbpf-bootstrap 或 BCC 里的现成工具，就只是「多了几个钩子和几个字段」而已。</p>' +
        '<p>任务设定：<b>追踪进程打开文件的行为，把文件名送进 ringbuf。</b>这是 eBPF 世界里 Hello World 级别的例子（BCC 里对应 <code>opensnoop</code>）。</p>',
      stepper: {
        title: 'kprobe 追踪文件打开 → 写 ringbuf → 用户态读取',
        lines: [
          {
            code: '<span class="c">// minimal.bpf.c —— 内核态部分</span>\n<span class="k">#include</span> <span class="s">&lt;linux/bpf.h&gt;</span>\n<span class="k">#include</span> <span class="s">&lt;bpf/bpf_helpers.h&gt;</span>',
            note: '<b>两个头文件决定了一切。</b><code>linux/bpf.h</code> 提供内核侧的 BPF 类型与 helper 声明；<code>bpf/bpf_helpers.h</code> 来自 libbpf，提供 <code>SEC()</code> 宏和 helper 的友好包装。<br>注意：这是<b>内核态代码</b>，不是普通用户态 C——这里没有 libc、没有 <code>malloc</code>、没有 <code>printf</code>（只有调试用的 <code>bpf_printk</code>）。'
          },
          {
            code: '<span class="k">struct</span> <span class="t">event</span> {\n  <span class="t">__u32</span> pid;\n  <span class="t">char</span>  comm[<span class="n">16</span>];\n  <span class="t">char</span>  fname[<span class="n">256</span>];\n};',
            note: '<b>这是要送到用户态的结构体</b>，两边必须逐字节一致——所以实践中通常抽到一个共享的头文件里，内核态和用户态各 include 一次。<br>字段尺寸在这里不是随便定的：comm 取 16 字节是因为内核里的进程名（TASK_COMM_LEN）就是 16；fname 给 256 是权衡后的常用值，太大会挤爆栈。'
          },
          {
            code: '<span class="k">struct</span> {\n  <span class="t">__uint</span>(type, BPF_MAP_TYPE_RINGBUF);\n  <span class="t">__uint</span>(max_entries, <span class="n">256</span> * <span class="n">1024</span>);\n} events <span class="t">SEC</span>(<span class="s">".maps"</span>);',
            note: '<b>用 BTF 风格声明一个 Map。</b><code>SEC(".maps")</code> 告诉 libbpf：这个变量不是数据，是一个 Map 定义，请把它放进 ELF 的 maps 段。<br><code>max_entries</code> 对 ringbuf 来说就是<b>缓冲区总字节数</b>，必须是 2 的幂。这段声明只存在于 <code>.o</code> 文件里，加载时由 libbpf 创建真正的内核对象。'
          },
          {
            code: '<span class="t">SEC</span>(<span class="s">"kprobe/do_sys_open"</span>)\n<span class="k">int</span> <span class="f">handle_open</span>(<span class="k">struct</span> <span class="t">pt_regs</span> *ctx) {',
            note: '<b>SEC 注解 = attach 点的声明书。</b>libbpf 靠扫描段名来决定把这个程序挂到哪里。<code>kprobe/do_sys_open</code> 的意思是「挂在 <code>do_sys_open</code> 这个内核函数入口」。<br><code>ctx</code> 的类型随程序类型变化：kprobe 给的是 <code>struct pt_regs *</code>（寄存器现场）。<span class="pill warn">不同内核版本里 do_sys_open 的符号与签名有差异，建议用 tracepoint 替代以提升可移植性</span>'
          },
          {
            code: '  <span class="k">struct</span> <span class="t">event</span> *e;\n  e = <span class="f">bpf_ringbuf_reserve</span>(&amp;events, <span class="k">sizeof</span>(*e), <span class="n">0</span>);\n  <span class="k">if</span> (!e) <span class="k">return</span> <span class="n">0</span>;',
            note: '<b>先在 ringbuf 里「预订」一块空间。</b>这是 ringbuf 和普通 Map 的关键差别：普通 Map 是 <code>update</code> 一次性写入，ringbuf 是<b>先 reserve 拿到可写指针、填完再 submit</b>。<br><b>那句判空绝不能省</b>：缓冲区满时 reserve 会返回 NULL（而且不会阻塞，eBPF 里不允许睡眠等待）。漏掉它，验证器直接拒收。'
          },
          {
            code: '  e-&gt;pid = <span class="f">bpf_get_current_pid_tgid</span>() &gt;&gt; <span class="n">32</span>;\n  <span class="f">bpf_get_current_comm</span>(&amp;e-&gt;comm, <span class="k">sizeof</span>(e-&gt;comm));',
            note: '<b>两个最常用的 helper。</b><code>bpf_get_current_pid_tgid()</code> 返回一个 64 位数：<b>高 32 位是 PID，低 32 位是 TID</b>——所以要右移 32 位才拿到 PID。<br><code>bpf_get_current_comm()</code> 把当前进程名拷进你给的缓冲。<br>注意这里没有任何函数调用栈、没有 libc——<b>helper 就是 eBPF 世界的系统调用</b>。'
          },
          {
            code: '  <span class="t">const char</span> *filename = <span class="t">BPF_CORE_READ</span>(...);\n  <span class="f">bpf_probe_read_user_str</span>(&amp;e-&gt;fname,\n      <span class="k">sizeof</span>(e-&gt;fname), filename);',
            note: '<b>最容易翻车的一步。</b>文件名字符串在<b>用户态内存</b>里，内核态指针不能直接解引用它——用户态随时可能把这块内存 unmap 掉，硬读就是内核 oops。<br>必须交给 <code>bpf_probe_read_user_str()</code> 这类 helper 做安全拷贝，失败了它会返回负值（很多例子里干脆不检查，因为读不到就留空，但严谨写法应该检查）。<br><span class="pill warn">从内核结构体里抠出 filename 字段的具体写法随内核版本变化很大，CO-RE 的 BPF_CORE_READ 系列是相对可移植的途径，但字段名仍需按目标内核确认</span>'
          },
          {
            code: '  <span class="f">bpf_ringbuf_submit</span>(e, <span class="n">0</span>);\n  <span class="k">return</span> <span class="n">0</span>;\n}\n<span class="t">char</span> <span class="t">LICENSE</span>[] <span class="t">SEC</span>(<span class="s">"license"</span>) = <span class="s">"GPL"</span>;',
            note: '<b>提交并声明许可证。</b><code>submit</code> 之后这块记录才真的对用户态可见（若不提交要用 <code>discard</code> 归还，否则算泄漏）。<br><code>LICENSE</code> 不是形式主义：内核会检查它，声明 <code>GPL</code> 才允许调用那些 GPL-only 的 helper；写成别的字符串，某些 helper 会导致加载失败。<br>返回值 <code>0</code> 在 kprobe 上通常表示「不干预，继续执行」——eBPF 观测默认是<b>只读</b>的。'
          },
          {
            code: '<span class="c">// minimal.c —— 用户态部分（节选）</span>\n<span class="t">struct</span> minimal_bpf *skel = <span class="f">minimal_bpf__open_and_load</span>();\n<span class="f">minimal_bpf__attach</span>(skel);',
            note: '<b>用户态只做三件事：打开、加载、挂载。</b>骨架（skeleton）是 <code>bpftool gen skeleton</code> 从 <code>.o</code> 生成的 C 头文件，它把「读 ELF、建 Map、加载程序、attach」这些琐事全包了。<br>这也是 <b>CO-RE</b> 发挥作用的位置：加载时 libbpf 读目标机器的 BTF 做重定位，所以同一份 <code>.o</code> 能在不同内核版本上跑。'
          },
          {
            code: '<span class="t">struct</span> ring_buffer *rb =\n  <span class="f">ring_buffer__new</span>(<span class="f">bpf_map__fd</span>(skel-&gt;maps.events),\n                     handle_event, <span class="n">NULL</span>, <span class="n">NULL</span>);\n<span class="k">while</span> (!exiting) <span class="f">ring_buffer__poll</span>(rb, <span class="n">100</span>);',
            note: '<b>用户态开始收割。</b>先为 ringbuf 注册一个回调 <code>handle_event</code>，然后死循环轮询。<code>poll</code> 的第二个参数是超时毫秒数，返回负数表示出错，应当退出循环（示例里为了简化省略了判断）。<br>这里的「轮询」底层是对 Map fd 做 epoll，<b>不占 CPU</b>；有数据才唤醒回调。'
          },
          {
            code: '<span class="k">static int</span> <span class="f">handle_event</span>(<span class="k">void</span> *ctx, <span class="k">void</span> *data, <span class="t">size_t</span> len) {\n  <span class="k">struct</span> <span class="t">event</span> *e = data;\n  <span class="f">printf</span>(<span class="s">"pid=%d comm=%s file=%s\\n"</span>,\n         e-&gt;pid, e-&gt;comm, e-&gt;fname);\n  <span class="k">return</span> <span class="n">0</span>;\n}',
            note: '<b>回调解包。</b>参数 <code>data</code> 指向的就是内核里那个 <code>struct event</code>——因为两边共用同一个头文件定义，可以直接强转使用（真实项目中要注意 <code>len</code> 校验以防越界读）。<br>返回非 0 会中止轮询，一般返回 0 继续。'
          },
          {
            code: '$ clang -O2 -g -target bpf -c minimal.bpf.c -o minimal.bpf.o\n$ bpftool gen skeleton minimal.bpf.o &gt; minimal.skel.h\n$ clang -O2 -g minimal.c -lbpf -lelf -lz -o minimal\n$ sudo ./minimal\npid=4821 comm=browser file=/proc/self/maps\npid=4821 comm=browser file=/data/local/tmp/payload.bin',
            note: '<b>完整构建链路四步走。</b>① clang 编成 BPF 目标文件；② bpftool 生成骨架头；③ 编用户态程序并链接 libbpf；④ 以 root 运行。<br>注意这个例子是 <b>PC Linux 上的标准流程</b>——搬到 Android 上，第 ④ 步会撞上四堵墙（见 11.6 节）。'
          }
        ]
      },
      after:
        T.note('ok', '✅ 记住这四个结构件，你就能读绝大多数 eBPF 源码',
          '<p><b>①</b> <code>SEC()</code> 决定<b>挂在哪</b>；<b>②</b> <code>SEC(".maps")</code> 定义<b>数据放哪</b>；<b>③</b> helper 决定<b>能拿到什么、怎么安全地拿</b>；<b>④</b> 用户态骨架负责<b>加载、挂载、读取</b>。</p>' +
          '<p>BCC 的 Python 脚本、bpftrace 的一行命令、Cilium 的复杂数据面，剥到最里面都是这四件。</p>')
    },

    /* ================= 11.4L 动手实验 ================= */
    {
      h: '11.4L', title: '动手实验：当一回 eBPF 验证器',
      html:
        '<p>验证器（verifier）是 eBPF 最核心也最抽象的设计。理解它的最好方式不是读文档，' +
        '而是<b>自己当一次验证器</b>——判断几段代码能不能通过。</p>',
      lab: {
        title: '实验：验证器会放行哪一段代码？',
        goal: '目标：找出会被拒绝的写法',
        intro:
          '<p>下面有五段 eBPF 代码片段。<b>其中三段能通过验证器，两段会被拒绝。</b></p>' +
          '<p><b>任务：找出被拒绝的那两段，并说明验证器拒绝它们的理由。</b></p>' +
          '<pre style="margin:10px 0;font-size:12.5px"><code>' +
          '【A】\n' +
          '  int idx = ctx-&gt;arg0;\n' +
          '  if (idx &gt;= 0 &amp;&amp; idx &lt; 16)          // ① 先检查\n' +
          '      return arr[idx];               // ② 再访问\n\n' +
          '【B】\n' +
          '  int idx = ctx-&gt;arg0;\n' +
          '  return arr[idx];                   // 没有边界检查\n\n' +
          '【C】\n' +
          '  while (1) { }                      // 无条件死循环\n\n' +
          '【D】\n' +
          '  #pragma clang loop unroll(full)\n' +
          '  for (int i = 0; i &lt; 8; i++) { ... }  // 循环次数固定且可展开\n\n' +
          '【E】\n' +
          '  void *p = bpf_map_lookup_elem(&amp;m, &amp;key);\n' +
          '  if (!p) return 0;                  // ① 先判空\n' +
          '  return *(int *)p;                  // ② 再解引用' +
          '</code></pre>',
        inputs: [
          { key: 'reject', label: '① 哪两段会被验证器拒绝？（填字母）',
            hint: '格式：B、C 或 B C', ph: '例如 B、C' },
          { key: 'reason', label: '② 验证器拒绝它们的共同理由是什么？',
            hint: '它不做运行时测试，只在加载时做什么？', ph: '因为……', type: 'textarea', rows: 3 }
        ],
        runLabel: '🔍 对照验证器判定',
        run: (v) => {
          const items = [
            { k: 'A', pass: true,  title: '先检查 idx 范围，再访问数组',
              why: '通过。验证器跟踪 <code>idx</code> 的取值范围：经过 <code>if</code> 之后它确定落在 [0,16)，' +
                   '而 <code>arr</code> 是已知大小的栈数组 → 访问安全。' +
                   '<b>这是"每条可能路径上都要安全"的典型写法。</b>' },
            { k: 'B', pass: false, title: '没有边界检查就索引数组',
              why: '<b>拒绝。</b>验证器无法证明 <code>idx</code> 在数组范围内 —— 它是从上下文读来的<b>不可信输入</b>。' +
                   'eBPF 不允许任何"可能越界"的访问。<br>' +
                   '<b>注意：验证器不会"运行时试试看"</b>，它必须在<b>加载时静态证明</b>所有路径都安全。' },
            { k: 'C', pass: false, title: '无条件死循环',
              why: '<b>拒绝。</b>eBPF 程序运行在<b>内核态</b>，而且常常在中断/软中断上下文里执行。' +
                   '死循环会让整个内核挂住。<br>' +
                   '<b>所以验证器要求所有循环必须可证明会终止</b>（有界循环）。' +
                   '注意：较新内核支持有界循环，但必须能被证明有上界。' },
            { k: 'D', pass: true,  title: '固定次数的展开循环',
              why: '通过。<code>#pragma clang loop unroll(full)</code> 让编译器在<b>编译期</b>把循环完全展开成 8 段直线代码，' +
                   '指令流里<b>不再有循环结构</b>，验证器看到的是一串确定的直线代码，自然可证明会终止。<br>' +
                   '<b>这正是 eBPF 里处理循环的经典手法：能展开就展开。</b>' },
            { k: 'E', pass: true,  title: '判空后再解引用 Map 指针',
              why: '通过。<code>bpf_map_lookup_elem</code> 可能返回 NULL（key 不存在），验证器<b>知道这一点</b>。' +
                   '先 <code>if (!p) return 0;</code> 把 NULL 分支排除掉，剩下的路径上 <code>p</code> 一定非空 → 解引用安全。' }
          ];

          let html = '<table class="lab-tbl"><tr><th>片段</th><th>验证器判定</th><th>理由</th></tr>';
          items.forEach(it => {
            html += '<tr class="' + (it.pass ? 'same' : 'diff') + '">'
              + '<td><b>' + it.k + '</b><br><span style="font-size:11px;color:var(--fg-3)">' + it.title + '</span></td>'
              + '<td>' + (it.pass ? '✅ 通过' : '❌ <b>拒绝</b>') + '</td>'
              + '<td style="font-size:12px">' + it.why + '</td></tr>';
          });
          html += '</table>';

          // 校验用户答案
          const picked = String(v.reject || '').toUpperCase().replace(/[^A-E]/g, '').split('');
          const uniq = [...new Set(picked)].sort();
          const correct = ['B', 'C'];
          const ok = uniq.length === 2 && uniq[0] === 'B' && uniq[1] === 'C';
          if (picked.length) {
            html += '<div class="lab-msg ' + (ok ? 'pass' : 'fail') + '"><b>'
              + (ok ? '✅ 正确：B 和 C 会被拒绝' : '❌ 答案不对') + '</b>'
              + '<div class="lab-note">' + (ok
                  ? 'B 是<b>内存安全</b>问题（可能越界），C 是<b>终止性</b>问题（可能死循环）。'
                  : '正确答案是 <b>B</b> 和 <b>C</b>。<br>' +
                    'B —— 没有边界检查的数组访问，验证器无法证明不越界。<br>' +
                    'C —— 无条件死循环，验证器无法证明会终止。<br>' +
                    '<b>A / D / E 都能通过</b>，因为它们分别用"范围检查""循环展开""判空"给出了静态可证的保证。')
              + '</div></div>';
          }

          const reason = String(v.reason || '').trim();
          if (reason) {
            const hitStatic = window.AKKC_hasConcept(reason, ['静态', '加载时', '证明', '可证明', '不运行', '编译时', '事先', '不可判定']);
            const hitSafe = window.AKKC_hasConcept(reason, ['安全', '越界', '死循环', '终止', '崩溃', '崩溃内核', '内存']);
            html += '<div class="lab-msg ' + (hitStatic && hitSafe ? 'pass' : 'warn') + '"><b>'
              + (hitStatic && hitSafe ? '✅ 抓住核心了' : '🟡 还不够到位') + '</b>'
              + '<div class="lab-note">'
              + '验证器的核心特征是：<b>它不做运行时测试，而是在加载时静态证明"这段程序在任何输入下都不会出事"。</b><br><br>'
              + '要证明两件事：<br>'
              + '<b>① 内存安全</b> —— 任何一次访问都在合法范围内（B 违反）<br>'
              + '<b>② 一定终止</b> —— 不会无限循环卡住内核（C 违反）<br><br>'
              + '<b>这就是"凭什么允许用户代码进内核"的答案：</b>' +
              '不是靠权限限制（那限制不住），而是靠<b>数学证明</b>。'
              + '</div></div>';
          }
          return html;
        },
        expected: (v) => {
          const picked = [...new Set(String(v.reject || '').toUpperCase().replace(/[^A-E]/g, '').split(''))].sort();
          const ok = picked.length === 2 && picked[0] === 'B' && picked[1] === 'C';
          return {
            ok,
            detail: ok
              ? '<b>完全正确：B 和 C。</b><br>' +
                '验证器要静态证明两件事：<b>内存安全</b>（B 违反：可能越界）和<b>一定终止</b>（C 违反：可能死循环）。<br>' +
                'A / D / E 分别靠"范围检查""循环展开""判空"给出了可证的保证。'
              : '<b>不是这两个。</b>正确答案是 <b>B</b> 和 <b>C</b>。<br>' +
                '判断方法：逐段问自己"验证器能不能<b>静态证明</b>它安全？"<br>' +
                '• A 有范围检查 → 能证明<br>• D 循环被展开成直线代码 → 能证明<br>• E 判空后解引用 → 能证明<br>' +
                '• <b>B</b> 直接用不可信输入索引 → <b>证明不了</b><br>' +
                '• <b>C</b> 无条件死循环 → <b>证明不了会终止</b>'
          };
        },
        showAnswer:
          '【会被拒绝的两段】B 和 C\n\n' +
          'B —— 内存安全问题\n' +
          '  代码：int idx = ctx->arg0;  return arr[idx];\n' +
          '  理由：idx 来自上下文的不可信输入，验证器无法证明它落在 arr 范围内。\n' +
          '        只要存在一条"可能越界"的路径，就拒绝。\n\n' +
          'C —— 终止性问题\n' +
          '  代码：while (1) { }\n' +
          '  理由：eBPF 跑在内核态，死循环会挂住整个内核。\n' +
          '        验证器要求所有循环都能被证明有上界。\n\n' +
          '【能通过的三段及原因】\n' +
          'A：先做范围检查 if (idx >= 0 && idx < 16)\n' +
          '   → 验证器跟踪 idx 的取值范围，检查后确定落在 [0,16) 内\n' +
          'D：#pragma clang loop unroll(full)\n' +
          '   → 编译期完全展开成 8 段直线代码，指令流里没有循环结构\n' +
          'E：先判空 if (!p) return 0;\n' +
          '   → 排除 NULL 分支后，剩余路径上 p 一定非空\n\n' +
          '【验证器的核心特征】\n' +
          '  它【不做运行时测试】，而是在【加载时静态证明】：\n' +
          '    "这段程序在任何输入、任何路径下都不会出事"\n\n' +
          '  要证明两件事：\n' +
          '    ① 内存安全 —— 每次访问都在合法范围内\n' +
          '    ② 一定终止 —— 不会无限循环\n\n' +
          '  这是"凭什么允许用户代码进内核"的答案：\n' +
          '    不是靠权限限制，而是靠数学证明。',
        hint:
          '不要问"这段代码平时跑得通吗"——验证器<b>不运行代码</b>。<br>' +
          '要问：<b>「验证器能不能在加载时，静态地证明这段程序永远不会出事？」</b><br><br>' +
          '它主要证明两件事：<br>' +
          '① <b>内存安全</b>：每次读写都在合法范围内吗？<br>' +
          '② <b>一定终止</b>：会不会死循环卡住内核？<br><br>' +
          '拿这两把尺子去量五个片段，答案就出来了。',
        after:
          T.note('key', '🔑 这个实验训练的是"从机制推边界"',
            '<p style="margin-bottom:0">你现在能解释一个很多人答不上来的问题：' +
            '<b>"eBPF 凭什么敢让用户写的代码跑在内核里？"</b><br><br>' +
            '答案是<b>验证器</b>——它用静态分析证明了程序不会危害内核。' +
            '这也解释了 eBPF 的很多"奇怪限制"：<br>' +
            '• 为什么不能随心所欲循环？→ 终止性无法证明<br>' +
            '• 为什么只能用 helper 白名单？→ 白名单函数的行为是已知安全的<br>' +
            '• 为什么不能动态分配内存？→ 分配器的行为无法静态验证<br>' +
            '• 为什么有 4096 条指令限制？→ 保证验证能在有限时间内完成<br><br>' +
            '<span class="hit">这一节是本课程方法论的又一次体现：' +
            '<b>先问"机制是什么"，限制和用法就能自己推导出来，不用背。</b></span></p>')
      }
    },

    /* ================= 11.5C 实战案例 ================= */
    {
      h: '11.5C', title: '实战案例：某加固 V3/V4 的 Frida 检测定位',
      case: {
        source: 'kanxue',
        title: '[原创]某加固最新版frida检测绕过-trace一把嗦(续)',
        date: '2026-7-28',
        author: '东方玻璃',
        target: '某加固（壳 so = libDexHelper.so）最新 V3 / V4 版 Frida 检测；V3 样本 com.mobile.zgcbank，V4 样本 com.yitong.zjrc.mfs.android',
        background:
          '<p>2026 年的一篇看雪原创帖。目标是某加固<b>最新 V3 / V4 版</b>的 Frida 检测：V3 样本 <code>com.mobile.zgcbank</code>，' +
          'V4 样本 <code>com.yitong.zjrc.mfs.android</code>，壳 so 都是 <code>libDexHelper.so</code>。作者没有点名厂商。</p>' +
          '<p>环境：Mac mini M4 / macOS 15.7.7、IDA Pro 9.4、Pixel 6A（Android 14）；' +
          '工具链是 Codex、Frida 16.2.1、ida-export-cli、<b>glass-stalker-trace</b>、SoFixer、bindiff。</p>' +
          '<p>这篇帖子的看点在于：<b>检测点藏在匿名内存里的 so 中，静态根本无从下手</b>，' +
          '作者于是走上了一条“先把它变成可分析对象，再让程序自己走一遍，最后用二分法逼出唯一那个人”的路。' +
          'V4 还多了一层变化——<b>它不再杀进程，而是故意不解密 DEX 让你自己崩</b>。</p>',
        points: [
          '版本谱系：V1 / V2 会解密释放真 so 并替换 <code>soinfo</code>，hook 掉线程检测函数即可；<b>V3 / V4 内置自定义 linker，直接把真 so 加载到匿名内存</b>，磁盘上再也找不到它。',
          'V3 dump 法：<code>Process.enumerateRanges({protection:\'r-x\',coalesce:true})</code> 扫可执行内存，校验 ELF 魔数 <code>0x7f 45 4c 46</code>，并用 <code>Process.enumerateModules()</code> 做白名单排除。',
          'fullSize 靠解析 Phdr 算：64 位下 <code>e_phoff@32</code>、<code>e_phnum@56</code>、<code>p_size=56</code>，取所有 PT_LOAD 的 <code>p_vaddr+p_memsz</code> 最大值向上按 4096 对齐；dump 完再用 <b>SoFixer</b> 修复。',
          'hook <code>clone</code> 定位检测线程：<code>args[3]!=0</code> 时读 <code>args[3].add(96).readPointer()</code>；当 Frida 的 <code>Process.findModuleByAddress</code> 返回 null 时，改按 <code>addr.sub(base)</code> 打印偏移。',
          '确认某个函数是检测点后，用 <code>Arm64Writer.putRet()</code> 把函数头 patch 成 <code>ret</code>，先粗暴验证再谈精细绕过。',
          'V3 首批 8 个偏移 <code>0x2cb28</code> / <code>0x43ed8</code> / <code>0x3e018</code> / <code>0x4bd70</code> / <code>0x4c608</code> / <code>0x574d8</code> / <code>0x48088</code> / <code>0x4aed8</code> <b>全部处理完，App 仍然崩</b>——说明真凶不在这一批里。',
          '<b>glass-stalker-trace</b> 用法：插件放进 IDA 的 <code>plugins</code> 目录，<code>configureTrace({moduleName, root:{name:\'JNI_OnLoad\',offset:0x13A8C}})</code> 设根节点，再 <code>trace_start(base,range)</code> 跑；输出节点形如 <code>[tree] |-- sub_29D78 (0x29d78) [from=0x2832c, bl, depth=2]</code>。',
          '<b>二分法定位</b>：取 trace 树里居中且唯一路径上的中间节点，在它的 <code>onLeave</code> 里 <code>Thread.sleep(10)</code>（5–10s 合适，太久系统会 kill app）；sleep 没跑完就崩 ⇒ 检测点在前半段，跑完才崩 ⇒ 在后半段。',
          'V3 真检测点 <b><code>sub_2813C</code></b>：不是 JNI_OnLoad 开头的那次调用，而是<b>第 418 行 <code>if</code> 内 fork 分支里的第 2 次调用</b>；功能是扫 <code>cmdline</code> 判断调试态。',
          '它的返回值语义是四态：<b>0 = 触发 fork、1 = 崩溃、2 = 可运行、3 = 其他点位的正常值</b> ⇒ 用 <code>retval.replace(3)</code> 绕过，而不是简单置 0。',
          'V4 的检测摊在 8 个线程函数里：<code>0x302b0</code> / <code>0x348a4</code> / <code>0x5171c</code> / <code>0x4741c</code> / <code>0x5e588</code> / <code>0x60a88</code> / <code>0x61b3c</code> / <code>0x6dc04</code>。',
          'V4 上 trace 默认 10s 窗口不够，要加 <code>maxDurationMs:30000</code>，并用 <code>hotPathSuppress:{functions:[0x80100,0x7C4F0]}</code> 压掉热点函数，最终锁定真检测函数 <b><code>sub_6A5A8</code></b>。',
          'V4 的指令级定位用 <code>detailTrace:{enabled:true,startOffset:0x10380,untilProcessExit:true}</code>，log 写在 <code>/data/data/&lt;pkg&gt;/files/</code>；关键位置是最后的 <code>blr x20</code>，调用点 <code>0x10674</code>，符号为 <code>_ZN3art13DexFileLoader10OpenCommonEPKhmS2_mRKNSt3__112basic_string...</code>。',
          '<b>V4 的关键变化</b>：它不再主动杀进程，而是检测到 Frida 后<b>故意不解密 DEX / 埋坑</b>，等正常业务逻辑去调系统 API 时因缺关键数据触发异常崩溃——把“杀你”伪装成“你自己崩的”。',
          '<code>sub_6A5A8</code> 返回 0 → 正常解密释放 DEX；返回 1 → DEX 无法释放，最后崩溃 ⇒ 必须把它 hook 成 0，并配合 patch <code>6AB94</code>。'
        ],
        method: [
          '先认清对手升级到了哪一代：V1 / V2 的 soinfo 替换法在 V3 / V4 上完全无效，因为真 so 已经进了匿名内存，磁盘侧无从下手。',
          '把匿名内存里的 so 变成可分析对象：扫 <code>r-x</code> 段 → 校验 ELF 魔数 → 排除已知模块 → 按 Phdr 算出 fullSize → dump 并用 SoFixer 修复。',
          '拿到可读 so 之后，hook <code>clone</code> 盯住检测线程的创建，先把可疑线程的调用点按 <code>addr.sub(base)</code> 的相对偏移记录下来。',
          '对首批 8 个偏移逐个 <code>putRet()</code> 试 patch——<b>全部失败</b>，于是放弃“猜偏移”，转向行为追踪。',
          '用 glass-stalker-trace 从 <code>JNI_OnLoad+0x13A8C</code> 为根跑出一棵调用树，拿到几千个节点的完整执行路径。',
          '在树上做二分：挑居中节点塞 <code>Thread.sleep(10)</code>，用“崩不崩”把范围砍一半，反复收敛到唯一的那个函数。',
          '定位到 <code>sub_2813C</code> 后，先读清它的返回值语义（四态！），再用 <code>retval.replace(3)</code> 而不是置 0 来绕过。',
          'V4 重复同一套流程：先扩 trace 窗口到 <code>maxDurationMs:30000</code> 并压制热点函数，再从 8 个线程函数收敛到 <code>sub_6A5A8</code>。',
          'V4 上再下沉一层，用 <code>detailTrace</code> 做指令级 trace，顺着最后的 <code>blr x20</code> 找到 <code>DexFileLoader::OpenCommon</code> 这个调用点，确认“不解密 DEX”这条链。',
          '收口：V4 把 <code>sub_6A5A8</code> hook 成返回 0（让它老老实实解密释放 DEX），并补掉 <code>6AB94</code>，绕过完成。'
        ],
        result:
          '<p>V3 侧：定位到真检测点 <code>sub_2813C</code>，用 <code>retval.replace(3)</code> 绕过——' +
          '注意这里的关键是<b>读懂了返回值是四态而不是布尔</b>，简单置 0 反而会踩进 <code>fork</code> 分支。</p>' +
          '<p>V4 侧：从 8 个线程函数收敛到 <code>sub_6A5A8</code>，把它 hook 成返回 <code>0</code> 并 patch <code>6AB94</code>，' +
          'App 恢复正常——<b>因为返回 0 才会触发正常的 DEX 解密与释放流程</b>。</p>' +
          '<p>整条路线上真正的两个突破，一个来自<b>把匿名 so 变成可 dump 的对象</b>，另一个来自<b>用二分法把几千个函数砍成 1 个</b>。' +
          '静态分析在这两个环节都没能直接给出答案。</p>',
        terms: ['Frida Stalker', 'glass-stalker-trace', 'SoFixer', 'Process.enumerateRanges', 'Arm64Writer', '匿名内存加载', 'JNI_OnLoad', 'retval.replace', 'detailTrace', 'DexFileLoader'],
        limits:
          '<p>这篇帖子的局限作者自己交代得比较清楚，也有几处必须替他标注：</p>' +
          '<p>① <b>trace 结果因插件版本而异</b>——作者用的是 V1.2，换版本输出可能不同。</p>' +
          '<p>② V4 定位到 <code>sub_6A5A8</code> <b>“有一些运气成分”</b>：插件 V1.0 会折叠节点，导致当时的判断是误打误撞命中的。</p>' +
          '<p>③ trace 命中过多热点函数时，会触发 trace 引擎自身的性能限制，需要靠 <code>hotPathSuppress</code> 之类的手段减负。</p>' +
          '<p>④ <b>二分法的节点选取有讲究</b>：要挑居中、且在树上路径唯一的节点，随便挑一个可能压根没被走到，sleep 就白塞了。</p>' +
          '<p>⑤ <b>加固厂商未点名</b>，样本无法据此复现验证。</p>' +
          '<p>⑥ 作者还专门反思了“让 AI 自动调 IDA”的坑：<b>AI 谎报军情，说脚本已经跑通，实际把 APP 卡死了</b>，最后他放弃自动化、回归手工操作。</p>',
        analysis:
          '<p><b>虽然本案例用的是 Frida Stalker 而不是 eBPF，但它是第 11 章“内核态 / 低层观测”这条思路的方法论同构。</b>' +
          '本章的元原则是：<b>观测点决定了你能看见什么</b>——eBPF 的价值不在技术先进，而在“观测发生在目标进程的地址空间之外”。' +
          '这个案例换了个方向用同一条原则：当静态分析看不见目标时，就<b>把观测这件事本身往下压一层</b>，从“读代码”压到“看它怎么跑”。</p>' +
          '<p><b>第一层，把“不可能”变成“可枚举”。</b>面对匿名内存里的 so，作者没有硬啃汇编，而是用三个可判定的条件——' +
          '扫 <code>r-x</code> 段、校验 ELF 魔数 <code>0x7f 45 4c 46</code>、用 <code>Process.enumerateModules()</code> 排除已知模块——' +
          '把它变成了一个<b>可以被 dump 的普通对象</b>。变成文件之后，IDA 能读、bindiff 能比、SoFixer 能修，' +
          '<span class="hit">原本无从下手的问题，被翻译成了一套标准流程。这是本章 11.7 探测清单的同一种思维：<b>把“行不行”变成一组可测量的数据。</b></span></p>' +
          '<p><b>第二层，二分法这种“笨办法”的价值。</b>当检测点藏在几千个函数里，作者的解法是塞一个 <code>Thread.sleep(10)</code>，' +
          '用“崩不崩”把搜索空间砍一半。<b>它比任何静态分析都快</b>，因为它完全绕过了“读懂逻辑”这件事，只依赖一个前提：程序会自己告诉你答案。' +
          '这正是本课反复强调的元原则——<b>静观看不懂的，让程序自己走一遍</b>——第 11 章的观测优先思路，正是它在内核层的版本。' +
          '<span class="hit">先让程序走一遍，再决定要读哪一段代码。</span></p>' +
          '<p><b>第三层，对 AI 的批判性使用。</b>作者明确记录了“AI 谎报军情说脚本通过、实际卡死 APP”，然后回归手工。' +
          '这个细节比技术本身更重要：<b>AI 适合做“从汇编到逻辑”的静态还原</b>——那部分它确实能省下大量时间；' +
          '<b>但它不适合做“脚本到底跑没跑通”的判断</b>，因为那是事实问题，必须自己验证。' +
          '<span class="hit">把 AI 用在“提出假设”上，把人工留在“验证事实”上——这与本章 11.6 那句“唯一可靠的做法是在你自己的目标设备上实测”是同一条底线。</span></p>',
        link: 'https://bbs.kanxue.com/thread-292208.htm',
        linkNote: '看雪论坛原创帖'
      }
    },

    /* ================= 11.5 eBPF vs Frida 可见性 ================= */
    {
      h: '11.5',
      title: '核心价值：同一个观测行为，Frida 看得见、eBPF 看不见',
      html:
        '<p>前面四节都在讲 eBPF 怎么工作。现在必须回答那个最实际的问题：<b>这跟我做逆向有什么关系？</b></p>' +
        '<p>假定我们想做同一件事：<b>观测目标 App 的一次函数调用，拿到它的入参。</b>有两条路——' +
        '<b>A 路</b>用 ' + T.term('Frida', '用户态动态插桩框架：把 agent 注入目标进程，在其地址空间内改写指令或解释执行 JS') + ' 注入，' +
        '<b>B 路</b>用 ' + T.term('uprobe', '内核提供的用户态函数探针机制，在目标进程的指定函数入口插入断点式回调') + ' 从内核侧挂探针。' +
        '下面这台动画让两条路同时接受<b>同一套 App 自查</b>，看看各自暴露了什么。</p>',
      stage: {
        title: '可见性对照实验：App 的六项自查，谁能躲过',
        speed: 1900,
        render:
          '<div class="flow-row" style="align-items:flex-start;gap:14px;flex-wrap:wrap">' +
            '<div class="flow-col" style="flex:1 1 320px">' +
              '<div class="card"><div class="card-title">A 路 · Frida 用户态注入</div>' +
                '<div class="blk" id="fa">目标进程地址空间内</div>' +
                '<div class="pill" id="f1">1 扫 /proc/self/maps</div><br>' +
                '<div class="pill" id="f2">2 查线程名 /proc/self/task/*/comm</div><br>' +
                '<div class="pill" id="f3">3 扫监听端口（27042 一类）</div><br>' +
                '<div class="pill" id="f4">4 查 TracerPid / ptrace 痕迹</div><br>' +
                '<div class="pill" id="f5">5 校验代码段是否被改写</div><br>' +
                '<div class="pill" id="f6">6 校验函数序言字节</div>' +
              '</div>' +
            '</div>' +
            '<div class="flow-col" style="flex:1 1 320px">' +
              '<div class="card"><div class="card-title">B 路 · eBPF 内核态观测</div>' +
                '<div class="blk" id="ba">目标进程完全在内核视野之外</div>' +
                '<div class="pill" id="b1">1 扫 /proc/self/maps</div><br>' +
                '<div class="pill" id="b2">2 查线程名 /proc/self/task/*/comm</div><br>' +
                '<div class="pill" id="b3">3 扫监听端口</div><br>' +
                '<div class="pill" id="b4">4 查 TracerPid / ptrace 痕迹</div><br>' +
                '<div class="pill" id="b5">5 校验代码段是否被改写</div><br>' +
                '<div class="pill" id="b6">6 校验函数序言字节</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="term-box" id="vlog" style="margin-top:12px">$ 等待开始…</div>',
        reset: () => {
          S('fa', ''); S('ba', '');
          for (let i = 1; i <= 6; i++) { CLS('f' + i, 'pill'); CLS('b' + i, 'pill'); }
          SET('vlog', '$ 等待开始…');
        },
        steps: [
          { run: () => { SET('vlog', '实验目标：观测目标 App 调用某加密函数时的入参。\\nApp 自身内置了 6 项运行时自查，每秒执行一次。'); } },
          { run: () => { S('fa', 'hot'); SET('vlog', '[A 路] frida -U -f com.target.app -l hook.js\\n→ agent 被注入目标进程，地址空间里多了一个 so'); } },
          { run: () => { CLS('f1', 'pill bad'); SET('vlog', '[A 路 · 自查 1] App 打开 /proc/self/maps 逐行扫描\\n  → 命中：frida-agent-64.so  ← 可疑模块，直接暴露'); } },
          { run: () => { CLS('f2', 'pill bad'); SET('vlog', '[A 路 · 自查 2] App 遍历 /proc/self/task/*/comm\\n  → 命中：gum-js-loop / gmain 一类的框架线程名'); } },
          { run: () => { CLS('f3', 'pill bad'); SET('vlog', '[A 路 · 自查 3+4] App 扫本地监听端口，并读 /proc/self/status 的 TracerPid\\n  → 端口命中；TracerPid 也可能非 0（取决于接入方式）'); } },
          { run: () => { CLS('f5', 'pill bad'); CLS('f6', 'pill bad'); SET('vlog', '[A 路 · 自查 5+6] App 把内存里的代码段和磁盘上的 .so 逐字节比对\\n  → 命中：函数序言被改写成跳转指令（inline hook 特征）\\n→ 结论：A 路被抓住，且证据链完整'); } },
          { run: () => { S('fa', 'done'); S('ba', 'active'); SET('vlog', '--- 换 B 路：拆掉 Frida，改成在钩子点挂 eBPF 程序 ---\\n# 内核侧挂 uprobe 到目标 so 的加密函数入口\\n# 用户态读 ringbuf 拿入参'); } },
          { run: () => { CLS('b1', 'pill ok'); SET('vlog', '[B 路 · 自查 1] 扫 /proc/self/maps\\n  → 没有新增模块。App 的地址空间和没被观测时一模一样'); } },
          { run: () => { CLS('b2', 'pill ok'); SET('vlog', '[B 路 · 自查 2] 遍历线程名\\n  → 目标进程一个线程都没多。观测者根本不在这个进程里'); } },
          { run: () => { CLS('b3', 'pill ok'); CLS('b4', 'pill ok'); SET('vlog', '[B 路 · 自查 3+4] 扫端口、查 TracerPid\\n  → 无新增端口；没有 ptrace，TracerPid=0。\\n  注意：uprobe 用的是内核断点机制，不是 ptrace 附着'); } },
          { run: () => { CLS('b5', 'pill ok'); CLS('b6', 'pill ok'); SET('vlog', '[B 路 · 自查 5+6] 比对代码段、校验函数序言\\n  → 内存里没有写入任何东西：eBPF 是<b>只读观测</b>，不修改目标指令\\n→ 结论：B 路六项全绿，App 一无所知'); } },
          { run: () => { S('ba', 'cool'); SET('vlog', '✓ 同一个观测动作，A 路留下 6 处痕迹，B 路留下 0 处（在 App 的可见范围内）。'); } },
          { run: () => { S('ba', 'hot'); SET('vlog', '⚠️ 但别把话说满：\\n  · 观测者若在用户态，它自己会留下痕迹（进程、文件、网络）\\n  · root 环境下 App 仍可能用非常规手段检测内核（自身带 root 的场景）\\n  · 对手也可以用 eBPF 反过来监控你 —— 这是双向的'); } }
        ]
      },
      after:
        T.note('key', '🔑 隐蔽性的真正来源', '<p>不是「eBPF 这个技术很隐蔽」，而是<b>「观测发生在目标进程的地址空间之外」</b>。记住这条原理，你就能自己推导出哪些检测手段有效、哪些天生无效：<b>所有依赖「观测者必须在目标进程内部留下东西」的检测，对内核态观测一律失效</b>。</p>') +
        T.note('warn', '⚠️ 别神化隐蔽性：三个现实约束',
          '<p><b>① 观测者本身要在设备上落地。</b>你的 loader 是个跑在手机上的用户态进程，它会被 <code>ps</code> 看见、会在文件系统里留下文件。内核态隐蔽的只是「观测动作」，不是「观测者」。</p>' +
          '<p><b>② 加载 eBPF 程序需要高权限。</b>没 root 基本免谈（见 11.6）。你为了让观测更隐蔽，反而先要在设备上取得最高权限——这是一个很现实的成本。</p>' +
          '<p><b>③ 这是一场双向博弈。</b>对手同样可以用 eBPF 监控你的行为，甚至用 <code>LSM</code> 钩子加固自己的检测逻辑。第 13 章讲内核态对抗时会展开这一层。</p>') +
        T.note('', '📌 放回课程的坐标系里',
          '<p><b>第 6 章</b>讲 ' + T.term('Hypervisor', '虚拟机监控器，运行在比内核更高的特权级（EL2），可以监控甚至篡改内核行为') + '，那是比内核更低的层；' +
          '<b>第 11 章（本章）</b>是内核态观测的标准手段；<b>第 13 章</b>讲内核态对抗（SVC 系统调用、硬件断点）。</p>' +
          '<p>三章连起来是一条清晰的主线：<b>谁控制了更低的层，谁就拥有最终的观测权和控制权</b>。用户态的 Frida 打不过内核，内核打不过 Hypervisor。</p>')
    },

    /* ================= 11.6 安卓四重限制 ================= */
    {
      h: '11.6',
      title: '安卓上的四重限制：为什么大多数手机跑不起来',
      html:
        '<p>上面所有动画都在 PC Linux 的语境下。现在把场景换到手机上——这是本章最有价值、也最容易被网上教程误导的部分。</p>' +
        '<p><b>先给结论：eBPF 在 Android 上「理论可行，实际高度受限」。</b>Android 基于 Linux 内核，内核本身有 BPF 支持；' +
        'Android 9（kernel 4.9）起内核配置就打开了一部分 BPF 相关功能，较完整的 eBPF 能力一般需要 <b>kernel 4.14+</b>。' +
        '但「内核里有」和「你能用」之间隔着四堵墙。</p>' +
        T.tbl(['限制', '挡住的到底是什么', '能不能绕'], [
          ['① 内核版本', '老设备内核太旧，很多 eBPF 特性（如 BTF、ringbuf、有界循环支持）压根不存在。内核 4.14 以下基本可以放弃', '绕不过。这是硬件与固件层面的既成事实，只能换设备'],
          ['② 厂商内核裁剪', '手机厂商为减小体积、缩小攻击面，常把 BPF 相关配置裁掉。关键配置如 <code>CONFIG_BPF_SYSCALL</code>、<code>CONFIG_BPF_JIT</code>、<code>CONFIG_DEBUG_INFO_BTF</code> 可能未开启。<b>没有 <code>CONFIG_BPF_SYSCALL</code>，就完全无法加载 eBPF 程序</b>', '理论上可自编译内核刷入，但需解锁 bootloader、有变砖风险，且多数机型内核源码不完整'],
          ['③ SELinux 策略', 'Android 的强制访问控制会限制 <code>bpf()</code> 系统调用。普通 App 无权调用——即使内核支持，策略也会把你拦在门外', '需要 root 后调整策略，或使用已获授权的域；这本身就是一道高门槛'],
          ['④ 需要 root', '上面三条叠加的结果：实际使用通常需要 root 权限或定制 ROM', '没有银弹。这是本章所有手机端实验的前提条件']
        ]) +
        T.note('key', '🔑 一个反直觉但重要的事实：Android 自己在用 eBPF',
          '<p>Android 系统本身就把 eBPF 用于<b>网络统计</b>（例如按 UID 统计流量、<code>trafficController</code> 相关的模块）。' +
          '这件事有两层含义：<b>①</b> 它证明了在真机上跑 eBPF 是可行的——不是纸上谈兵；<b>②</b> 但这些程序由<b>系统进程</b>在开机时加载，普通 App 既没权限、也看不到它们。</p>' +
          '<p>所以当你在设备上执行 <code>bpftool prog show</code> 看到一堆已有程序时，不要误以为「这台机器对我开放了」——那大概率是系统自己的。</p>') +
        T.note('warn', '⚠️ 时效性再强调一次',
          '<p>「哪些机型支持、哪些配置默认开启」这个问题，<b>每一年、每个厂商、每个机型、每个内核版本的答案都不一样</b>，而且厂商会随系统更新调整策略。' +
          '本章表格里的判断是<b>2023 年前后的普遍经验</b>，不是对你的设备的结论。' +
          '唯一可靠的做法是<b>在你自己的目标设备上实测</b>——具体探测命令见 11.7。' + T.pill('warn', '待核实') + '</p>'),
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一 · 项目启动',
            scenario: '<b>情境：</b>你接到一个任务——要给公司的 Android 安全测试工具加一套「内核态观测」能力，用来追踪目标 App 的文件访问和加密函数入参。团队里有人看了本章前几节，很兴奋，说 eBPF 隐蔽性最好，建议<b>把它作为所有机型上的统一方案</b>。你是这个项目的技术负责人，第一步怎么做？',
            choices: [
              { t: 'A. eBPF 隐蔽性碾压用户态方案，直接按统一架构立项，全线推 eBPF', next: 'n1' },
              { t: 'B. 先拿 3-5 台真实目标机型做内核能力探测（版本、config、BTF、SELinux、root），按探测结果把 eBPF 定位成「特定机型上的可选增强」，主力仍是用户态方案', next: 'n2' },
              { t: 'C. 既然手机上限制这么多，本章内容直接跳过，继续用 Frida', next: 'n3' },
              { t: 'D. 先把目标机型的内核源码拉下来自编译、替换掉原厂内核，再上 eBPF', next: 'n4' }
            ]
          },
          n1: {
            label: '选 A', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：把「理论上更优」当成了「工程上可行」',
            result: '<b>认知根源：混淆了技术上限和工程可达性。</b>eBPF 的隐蔽性确实是数量级的优势，但这个优势有一个硬前提——<b>程序能被加载进内核</b>。而加载受内核版本、厂商配置、SELinux 策略三重约束，这些约束在真实机型上大量存在。<br><br>按统一架构立项的直接后果是：交付时发现 70% 的目标机型根本加载不了，前面的架构投入全部沉没，还要回头改设计。<br><br><b>正确做法：</b>任何依赖设备底层能力的技术方案，第一步都应该是<b>能力探测</b>——把「能不能用」变成一组可测量的数据，再决定投入。'
          },
          n2: {
            label: '选 B', terminal: true, verdict: 'good',
            verdictTitle: '正确：先探测，再决定投入比例（哪怕结论是「大部分机型用不了」）',
            result: '<b>这是本章最想让你接受的一个「反直觉」结论：</b>讲了一整章 eBPF，但正确的工程判断往往是<b>不要梭哈</b>。<br><br>探测要回答五个问题：<b>①</b> 内核版本是多少（4.14 以下基本出局）；<b>②</b> BPF 相关配置开没开（尤其是有没有 <code>CONFIG_BPF_SYSCALL</code>）；<b>③</b> <code>/sys/kernel/btf/vmlinux</code> 在不在（决定 CO-RE 能不能用）；<b>④</b> SELinux 拦不拦 <code>bpf()</code>；<b>⑤</b> 有没有 root。<br><br><b>探测的意义在于把技术选型变成数据驱动的决策</b>：如果探测下来只有少数机型可用，那 eBPF 就是一个「针对高价值目标机的精准工具」，而不是产品基线。这种分层设计在安全工程里是常态。'
          },
          n3: {
            label: '选 C', terminal: true, verdict: 'bad',
            verdictTitle: '从一个极端跳到另一个极端',
            result: '<b>认知根源：把「受限」读成了「不可用」。</b>限制多 ≠ 不能用。Android 系统自己在用 eBPF（流量统计就是例子），说明内核路径是通的；在部分机型上、配合 root，eBPF 完全能跑出你在 PC 上见过的效果。<br><br>更关键的是：<b>eBPF 提供的能力是用户态方案给不了的</b>。系统调用级别的全量观测、不进入目标进程地址空间的隐蔽性，这些用 Frida 做不到。因为「不是每台机器都能用」就整个放弃，等于放弃了一个能力维度。<br><br><b>正确的态度：</b>把它当作工具箱里的一件特种工具——不常出场，但出场时不可替代。'
          },
          n4: {
            label: '选 D', terminal: true, verdict: 'bad',
            verdictTitle: '技术上可行，但在错误的阶段做了最重的事',
            result: '<b>认知根源：跳过了「值不值得」直接进入「怎么做」。</b>自编译内核刷机在原理上确实能解开配置和策略的限制，但它的代价是：解锁 bootloader（很多机型会清空数据甚至熔断）、内核源码不完整导致编译失败、刷入后变砖风险、每换一个机型就要重来一遍。<br><br>而且这道门槛<b>并不能解决内核版本问题</b>——老设备的内核基线太旧，自编译也拿不到上游的新特性。<br><br><b>什么时候 D 才是对的？</b>当你有一台固定的、长期使用的测试样机，且项目明确需要深度内核观测能力时，为它专门定制内核是合理的投入。但这是「选定样机之后的专项工程」，不是「项目第一步」。'
          }
        }
      }
    },

    /* ================= 11.7 实测与工具链 ================= */
    {
      h: '11.7',
      title: '动手：一台设备到底支不支持？工具链怎么选',
      html:
        '<p>11.6 讲了四堵墙，但「我的这台机器到底行不行」只能靠实测。这一节给一份可执行的探测清单——' +
        '<b>顺序很重要</b>，因为前面的检查不过，后面的做了也白做。</p>' +
        '<p>另外要提醒一句：下面所有命令都<b>需要 root</b>（或者有等价权限）。没有 root 的话，第 ⑤ 步就已经是终点了。</p>',
      term: {
        title: 'root shell · 设备 eBPF 能力探测（顺序执行）',
        lines: [
          { t: 'p', s: 'adb shell', note: '<b>先连上设备。</b>下面所有命令都在设备的 shell 里执行。注意 <code>adb shell</code> 默认进的是 App 的 shell 域，很多命令会被 SELinux 拒绝——所以要先 <code>su</code>。' },
          { t: 'p', s: 'su', note: '<b>第 ⑤ 道门槛：root。</b>拿不到 root，后面全部免谈。这是最现实的一条限制，也是为什么本章强调「eBPF 在手机上不是随手就能用」。' },
          { t: 'o', s: '# id' },
          { t: 'o', s: 'uid=0(root) gid=0(root) context=u:r:magisk:s0' },
          { t: 'p', s: 'uname -r', note: '<b>第 ① 步：内核版本。</b>这是最硬的一条。Android 9 对应的 kernel 4.9 起内核就开了一部分 BPF 配置；较完整的 eBPF 能力一般需要 <b>4.14+</b>。看到 4.4 / 3.18 这种，基本可以直接放弃这条路线。' },
          { t: 'o', s: '4.14.190-g0d3d5a1' },
          { t: 'd', s: '# 上例是一台 4.14 设备：属于「可以一试」的区间。\n# 4.14 以下：BTF / ringbuf 等新特性大概率缺失。' },
          { t: 'p', s: 'zcat /proc/config.gz | grep -E \'CONFIG_BPF|CONFIG_DEBUG_INFO_BTF\'', note: '<b>第 ② 步：厂商裁剪（最关键的一步）。</b><code>/proc/config.gz</code> 是内核配置。有些设备上这个文件不存在（说明 <code>CONFIG_IKCONFIG_PROC</code> 没开），那就只能去 <code>/boot</code> 或内核源码里找，或者干脆用第 ③ 步的能力探测法间接判断。' },
          { t: 'o', s: 'CONFIG_BPF_SYSCALL=y\nCONFIG_BPF_JIT=y\n# CONFIG_DEBUG_INFO_BTF is not set' },
          { t: 'w', s: '# ⚠️ CONFIG_BPF_SYSCALL 是总闸：没有它 → 完全无法加载 eBPF 程序，后面全部不用看了。\n# ⚠️ 没有 CONFIG_BPF_JIT → 只能解释执行，性能大幅下降。\n# ⚠️ 没有 CONFIG_DEBUG_INFO_BTF → 没有 BTF，CO-RE 用不了，程序必须针对具体内核编译。' },
          { t: 'p', s: 'ls -l /sys/kernel/btf/vmlinux', note: '<b>第 ③ 步：BTF 在不在。</b>这个文件就是内核导出的 BTF 类型信息，它是 <b>CO-RE</b>（Compile Once – Run Everywhere）的前提。文件不存在 = 你没法用 CO-RE，得回到「针对每台设备的内核单独编译」的老办法。' },
          { t: 'e', s: 'ls: /sys/kernel/btf/vmlinux: No such file or directory' },
          { t: 'd', s: '# 本例这台机器没有 BTF：说明 CONFIG_DEBUG_INFO_BTF 未开启。\n# 结论：仍可能加载 eBPF 程序，但 portability 方案要降级。' },
          { t: 'p', s: 'getenforce', note: '<b>第 ④ 步：SELinux。</b>Android 的强制访问控制会限制 <code>bpf()</code> 系统调用。<code>Enforcing</code> 状态下，即使内核支持，策略也会拦你。' },
          { t: 'o', s: 'Enforcing' },
          { t: 'p', s: './bpftool feature probe 2>&1 | head -30', note: '<b>第 ③ 步的另一种做法：直接用 bpftool 探测。</b>静态看配置文件容易漏，<code>bpftool feature probe</code> 会真正去问内核「你支持哪些 helper、哪些 Map 类型、哪些程序类型」。<b>注意</b>：你需要先把 <b>bpftool</b> 交叉编译成 <b>arm64/aarch64</b> 版本再推到设备上；用 PC 上的 x86 版本推过去是跑不起来的。' },
          { t: 'o', s: 'eBPF kernel: available\n  ... helper / map_type / program_type 支持列表 ...' },
          { t: 'p', s: './bpftool prog show', note: '<b>顺带看看设备上已经有什么。</b>正如 11.6 提到的，Android 系统自己就加载了一些 eBPF 程序（流量统计等）。看到它们说明内核路径是通的，但也提醒你：这些是系统进程的，不是给你的。' },
          { t: 'o', s: '12: sched_cls  name trafficController  ...  run_time_ns 0' },
          { t: 'w', s: '# 注意：看不到任何程序 ≠ 内核不支持；\n#      看得到程序 ≠ 你有权限加载自己的程序。两件事要分开判断。' },
          { t: 'p', s: 'ls /data/local/tmp/', note: '<b>最后：观测者的落脚点。</b>你的 loader 是个用户态可执行文件，得先在设备上有个位置。这一步也提醒你——<b>内核态观测隐蔽，但观测者本身不隐蔽</b>。<code>/data/local/tmp</code> 是最常用的位置，也正因如此它是各种检测的重点扫描区域。' },
          { t: 'o', s: 'trace_open\nminimal.bpf.o' }
        ]
      },
      after:
        T.note('', '📌 探测清单（照着走一遍）',
          '<p><b>①</b> <code>uname -r</code> → 内核版本，4.14+ 才有戏；<b>②</b> <code>CONFIG_BPF_SYSCALL</code> → 总闸，没有就结束；' +
          '<b>③</b> <code>/sys/kernel/btf/vmlinux</code> → 决定能不能用 CO-RE；<b>④</b> <code>getenforce</code> → SELinux 会不会拦；' +
          '<b>⑤</b> root 有没有。五条里任何一条卡住，方案就得降级。</p>') +
        T.tbl(['工具', '仓库', '定位', '什么时候用它'], [
          ['<b>BCC</b>', '<code>iovisor/bcc</code>', 'Python 前端 + 内嵌 C。开发快，自带大量现成工具（<code>execsnoop</code>、<code>opensnoop</code>、<code>biolatency</code>）', '快速验证想法、临时排查。缺点：<b>每次运行都要编译 C</b>，目标机要装内核头文件，启动有开销'],
          ['<b>bpftrace</b>', '<code>bpftrace/bpftrace</code>', '类 awk 的高级脚本语言，一行就能写一个追踪器', '现场快速排查，写脚本成本最低。适合「我就想知道是谁在开这个文件」这种问题'],
          ['<b>libbpf + CO-RE</b>', '<code>libbpf/libbpf</code>', '<b>CO-RE = Compile Once – Run Everywhere</b>：用 BTF 类型信息让同一份 <code>.o</code> 适配不同内核版本', '<b>现代推荐的工程化方案</b>。交付型项目、需要嵌入到 App 或工具链里的场景'],
          ['<b>bpftool</b>', '<code>libbpf/libbpf</code> 附带', '内核 BPF 子系统的命令行瑞士军刀：列出程序/Map、生成 skeleton、探测能力', '开发期调试与设备探测（注意要交叉编译到 arm64）']
        ]) +
        T.note('key', '🔑 三者的关系（面试常问）',
          '<p><b>BCC 和 bpftrace 内部都基于 libbpf</b>。可以把它们理解成同一套底座上的三种使用姿势：' +
          'BCC 是「Python 包 C」，bpftrace 是「DSL 脚本」，libbpf 是「直接用 C 写工程」。</p>' +
          '<p>新项目推荐 <b>libbpf + CO-RE</b>——它避开了 BCC 的两个老问题：<b>目标机需要装内核头文件</b>、<b>每次运行都要现场编译</b>。' +
          '这两个问题在 PC 上只是慢一点，在手机上往往是「直接跑不起来」。</p>'),
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境二 · 实测结果很差',
            scenario: '<b>情境：</b>你按 11.7 的清单在自己手上的测试机上跑了一遍，结果是：<code>uname -r</code> 显示 <b>4.9</b>；<code>CONFIG_BPF_SYSCALL=y</code> 但 <code>CONFIG_DEBUG_INFO_BTF</code> 没开（<code>/sys/kernel/btf/vmlinux</code> 不存在）；有 root。' +
              '你原本写好的基于 libbpf + CO-RE 的追踪工具（用 uprobe 盯加密函数）拿过去直接跑不起来。下一步怎么办？',
            choices: [
              { t: 'A. 加大投入，把这台机器的内核源码拉下来，把 CONFIG_DEBUG_INFO_BTF 打开重新编译内核刷进去', next: 'n1' },
              { t: 'B. 放弃 CO-RE，改成为这台设备的内核单独编译一份 eBPF 目标文件（依赖具体内核的 BTF/头文件），保留 CO-RE 版本给新机型；同时评估用户态方案作为兜底', next: 'n2' },
              { t: 'C. 既然 CO-RE 用不了，说明 eBPF 这条路在这台机器上彻底走不通，直接放弃', next: 'n3' },
              { t: 'D. 把 PC 上用得好好的那份 CO-RE 目标文件直接拷到设备上再试一次，说不定能跑', next: 'n4' }
            ]
          },
          n1: {
            label: '选 A', terminal: true, verdict: 'bad',
            verdictTitle: '代价与收益严重不成比例',
            result: '<b>认知根源：把「技术上能做到」等同于「现在就该做」。</b>自编译内核确实能打开 <code>CONFIG_DEBUG_INFO_BTF</code>，但那意味着：解锁 bootloader、找到（可能并不完整的）厂商内核源码、配置正确的交叉编译工具链、刷机、承担变砖风险，而且<b>每换一台设备就要重来一遍</b>。<br><br>更关键的是，<b>你未必需要 BTF</b>。BTF 是 CO-RE 的前提，不是 eBPF 的前提。没有 BTF，你只是失去了「一份目标文件跑遍所有内核」的能力，还可以回到「针对具体内核编译」的老路。<br><br>先问自己：<b>这台设备是要长期使用的固定样机吗？</b>如果不是，为它定制内核的投入几乎必然打水漂。'
          },
          n2: {
            label: '选 B', terminal: true, verdict: 'good',
            verdictTitle: '正确：把「缺失的能力」降级处理，而不是全盘放弃',
            result: '<b>这是本章第二个反直觉结论：没有 BTF / CO-RE，不等于没有 eBPF。</b><br><br>CO-RE 解决的是<b>可移植性</b>问题——让同一份编译产物适配不同内核。没有它，你退回到传统做法：<b>针对目标设备的内核版本，单独编译一份 eBPF 目标文件</b>（需要该内核的头文件/类型信息，字段偏移在编译期就固定下来）。这条路更麻烦、更难维护，但在这个内核（4.9，<code>CONFIG_BPF_SYSCALL=y</code>、有 root）上，它<b>大概率是能跑通的</b>。<br><br>工程上的正确姿势是<b>分层</b>：新机型走 CO-RE 的通用路径，老机型走「一机一编」的特化路径，再老的（内核 &lt; 4.14 或没有 <code>CONFIG_BPF_SYSCALL</code>）走用户态方案兜底。<b>明确每一层的适用边界，比追求一套方案通吃要可靠得多。</b>'
          },
          n3: {
            label: '选 C', terminal: true, verdict: 'bad',
            verdictTitle: '把一个子能力的缺失，误判为整条路线不通',
            result: '<b>认知根源：把 CO-RE 和 eBPF 划了等号。</b>CO-RE 只是 eBPF 工程化的一种方式（而且是较新的一种），它依赖 BTF。BTF 缺失只说明「你不能用最省事的那种方式」，不代表内核不支持 eBPF。<br><br>回到探测结果本身：<code>CONFIG_BPF_SYSCALL=y</code> —— 说明<b>加载 eBPF 程序的总闸是开的</b>；有 root —— 说明权限这关也过了。这两条已经跨过了最难的两堵墙（11.6 的第 ② 和第 ④ 条）。<br><br><b>读探测结果要分清「缺什么」和「缺的那个是不是必需的」。</b>BTF 是「好用的加速器」，<code>CONFIG_BPF_SYSCALL</code> 才是「生死线」。'
          },
          n4: {
            label: '选 D', terminal: true, verdict: 'bad',
            verdictTitle: '误判了 CO-RE 到底在哪一步生效',
            result: '<b>认知根源：以为 CO-RE 是「编译时烧进目标文件里的自适配魔法」。</b>事实正相反——CO-RE 的重定位发生在<b>加载时</b>：libbpf 读取<b>目标机器</b>的 <code>/sys/kernel/btf/vmlinux</code>，据此把 <code>.o</code> 里记录的字段偏移改成这台机器的真实偏移。<br><br>所以当目标机器上根本没有 <code>/sys/kernel/btf/vmlinux</code> 时，重定位这一步<b>没有输入</b>，加载必然失败——再拷一百次也一样。这不是运气问题，是机制问题。<br><br><b>排查口诀：CO-RE 加载失败，先确认目标机的 <code>/sys/kernel/btf/vmlinux</code> 存在且可读。</b>把「机制问题」误当成「玄学问题」，是浪费时间的经典方式。'
          }
        }
      },
      quiz: {
        id: 'q11-1', chapter: 11,
        answer: 1,
        stem: '你在设备上执行 <code>ls /sys/kernel/btf/vmlinux</code>，返回 <code>No such file or directory</code>。基于本章内容，<b>最准确</b>的结论是什么？',
        options: [
          { t: '这台设备不支持 eBPF，应该直接放弃', why: '过度推断。BTF 和 eBPF 是两个层次的东西：BTF 是类型信息来源，eBPF 是内核的虚拟机子系统。没有 BTF，内核照样可能支持加载和运行 eBPF 程序。' },
          { t: '内核很可能没有开启 <code>CONFIG_DEBUG_INFO_BTF</code>，因此 <b>CO-RE 无法使用</b>；但 eBPF 本身是否可用，还要看 <code>CONFIG_BPF_SYSCALL</code> 等配置和实际加载测试', why: '正确。BTF 缺失直接影响的是 CO-RE 的重定位能力（加载时 libbpf 需要读目标机的 BTF），而不是 eBPF 加载能力本身。判断后者要看 BPF 相关的配置与实测。' },
          { t: '说明 SELinux 正在拦截 <code>bpf()</code> 系统调用', why: '混淆了不同的限制维度。SELinux 拦截会表现为权限类错误（EACCES/EPERM），而不是文件不存在；BTF 文件不存在是配置层面的问题。' },
          { t: '只要 root 权限足够，就能自动生成这个文件', why: '错误。BTF 是内核在编译期通过配置项生成的调试信息，不是运行时可以凭空创建的文件；有 root 也不能无中生有。' }
        ],
        explain: '<b>这道题考的是一条纪律：把「现象」翻译成「机制」，再翻译成「结论」，不要一步跳到底。</b><br><br>现象：<code>/sys/kernel/btf/vmlinux</code> 不存在。<br>机制：这个文件是内核 BTF（BPF Type Format，内核的调试类型信息）的导出点，由 <code>CONFIG_DEBUG_INFO_BTF</code> 决定是否生成。<br>直接结论：<b>CO-RE 用不了</b>——因为 CO-RE 的重定位在加载时依赖目标机的 BTF。<br>不能推出的结论：<b>eBPF 不能用</b>——那取决于 <code>CONFIG_BPF_SYSCALL</code>（总闸）、<code>CONFIG_BPF_JIT</code>（性能）、SELinux 策略和权限。<br><br>在实际排查里，把「缺 BTF」误当成「不能用 eBPF」，会让你白白放弃一个本来可行的方案；反过来把「有 BTF」当成「一定能跑」，也会让你在加载失败时找不到原因。'
      }
    },

    /* ================= 11.8 源码赏析与工程决策 ================= */
    {
      h: '11.8',
      title: '源码赏析：三类实用项目的技术原理',
      html:
        '<p>最后一节把「热门 eBPF 项目」按用途分成三类，说清它们各自用了什么钩子、解决什么问题。你会发现：<b>看懂了 11.2 的九步和 11.4 的四个结构件，这些项目就没有神秘感了</b>。</p>' +
        T.tbl(['类别', '核心钩子', '技术原理', '对逆向的用处'], [
          ['<b>系统调用追踪</b><br><span class="small">如 BCC 的 execsnoop / opensnoop</span>',
           '<code>tracepoint</code>（如 <code>sys_enter</code>/<code>sys_exit</code>）、<code>kprobe</code>',
           '在每个系统调用的入口/出口挂程序，从上下文里取出参数（路径、flags、fd）和返回值，写进 Map 或 ringbuf，用户态聚合成「谁在什么时候做了什么」',
           '<b>极高</b>。App 的任何文件访问、网络连接、进程创建最终都要走系统调用，这里能看到<b>完整且不可绕过</b>的行为序列'],
          ['<b>网络过滤</b><br><span class="small">如 Cilium、XDP 程序、tc 分类器</span>',
           '<code>XDP</code>（驱动层最早处理点）、<code>tc</code>（流量控制层）、<code>socket filter</code>',
           '在网络包进入协议栈前后直接读取/修改/丢弃。XDP 在驱动收包后最先执行，性能极高，常用于 DDoS 防护和负载均衡；tc 层能做更复杂的流分类',
           '<b>中高</b>。可观测目标的全部网络流量（域名、IP、载荷元数据），且<code>XDP</code> 层可以做到丢包级干预'],
          ['<b>性能分析</b><br><span class="small">如 BCC 的 biolatency、火焰图工具</span>',
           '<code>perf_event</code>、<code>kprobe</code>、<code>tracepoint</code>',
           '用采样或埋点记录延迟、调用次数、栈回溯，聚合到 PERCPU_ARRAY 之类的 Map 里再导出。关键是<b>开销极低</b>，可以长时间挂在生产环境',
           '<b>中</b>。定位目标 App 的性能瓶颈和热点函数，间接推断其内部结构']
        ]) +
        T.note('key', '🔑 从源码里最该学的三个模式',
          '<p><b>① SEC 段名就是配置。</b>读一个 eBPF 项目，先从 <code>SEC("...")</code> 看它挂了哪些钩子——钩子决定了它能看见什么，这比读逻辑更快。</p>' +
          '<p><b>② 数据结构的定义就是信息边界。</b>内核态和用户态共享的那个 <code>struct event</code>，列出了这个工具能给你的<b>全部</b>信息。看它，就知道这个工具能不能解决你的问题。</p>' +
          '<p><b>③ helper 的用法暴露了它的能力上限。</b>用了 <code>bpf_probe_read_user_str()</code> 说明它在读用户态字符串（uprobe 类）；用了 <code>bpf_skb_*</code> 系列说明它在处理网络包；只用 <code>bpf_get_current_pid_tgid()</code> 和 Map，那多半是个统计类工具。</p>') +
        T.note('', '📌 对逆向实战的具体用法（把本章落到地上）',
          '<p>假设你要分析一个 App 的加密协议，但在用户态怎么 hook 都被反调试挡住。用 eBPF 的思路是：</p>' +
          '<p><b>①</b> 先按 11.7 探测目标设备是否具备条件；<b>②</b> 确认加密函数所在的 so，用 <code>uprobe</code> 挂到函数入口和返回；' +
          '<b>③</b> 入口处用 helper 读参数（<code>bpf_probe_read_user</code> 系列），返回处读返回值或输出缓冲；<b>④</b> 写进 ringbuf，用户态进程收集。</p>' +
          '<p>整个过程中，目标 App <b>没有新增模块、没有新增线程、代码段没有被改写</b>——它的常规反调试检测全部落空。这就是本章开头说的「在电线杆上装摄像头」。</p>'),
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境三 · 老板要「反 eBPF 检测」',
            scenario: '<b>情境：</b>你在甲方做 App 加固。防护团队开会时，安全负责人说：「既然 eBPF 能在内核态偷偷看我们，那你们加固组想办法<b>检测出设备上有没有人在用 eBPF 监控我们</b>，加进我们的反调试体系。」' +
              '你清楚前面几节讲的原理。<b>你会怎么回应这个需求？</b>',
            choices: [
              { t: 'A. 直接答应，回去就写代码遍历内核里的 BPF 程序列表，发现有挂在目标进程上的就报警', next: 'n1' },
              { t: 'B. 先说明能力边界：不越权的情况下 App 根本拿不到内核态信息，这条路走不通；但有<b>真正可行</b>的替代方向——检测「观测者」在用户态留下的痕迹（高权限环境、异常进程与文件、设备的 root/解锁状态），并指出这是双向博弈', next: 'n2' },
              { t: 'C. 告诉负责人 eBPF 是内核态技术，我们做不了任何事，这个需求没法接', next: 'n3' },
              { t: 'D. 建议在 App 里直接读取 /proc/kallsyms 和内核内存，扫描 BPF 相关数据结构', next: 'n4' }
            ]
          },
          n1: {
            label: '选 A', terminal: true, verdict: 'bad',
            verdictTitle: '承诺了一个在权限模型下做不到的事',
            result: '<b>认知根源：把「内核里有这个能力」当成了「App 有这个权限」。</b>遍历内核里的 BPF 程序，需要通过 <code>bpf()</code> 系统调用做 <code>BPF_PROG_GET_NEXT_ID</code> 一类的枚举操作，或者读内核内存。这需要 <code>CAP_BPF</code>/<code>CAP_SYS_ADMIN</code> 级别的高权限——<b>普通 App 根本没有</b>，而且这正是 11.6 第 ③ 条讲的 SELinux 限制所针对的行为。<br><br>答应了做不到的事，比一开始就说清楚代价大得多。安全工程里，<b>先说边界，再谈方案</b>是基本职业素养。'
          },
          n2: {
            label: '选 B', terminal: true, verdict: 'good',
            verdictTitle: '正确：厘清边界，把不可行的需求转成可行的需求',
            result: '<b>这是本章最重要的一次认知迁移。</b>答案的关键不是「能不能检测 eBPF」（在 App 权限下不能），而是<b>「把你的威胁模型从内核态挪回用户态」</b>。<br><br>要加载 eBPF 程序，观测者必须：<b>①</b> 取得 root 或等价高权限——那么设备的 root 状态本身就是最强的信号；<b>②</b> 在设备上放一个用户态 loader——它会出现在进程列表和文件系统里；<b>③</b> 很可能解锁了 bootloader、刷了非官方镜像。<br><br>这些<b>全部是可以从 App 侧合理检测的</b>（当然也要受 SELinux 和 Android 版本的限制，需要实测确认哪些 API 可用）。<br><br>同时要明确告诉负责人：<b>这是双向博弈，不存在一劳永逸。</b>你的检测手段会被绕过，对方也会升级；加固的价值在于抬高成本，不是造一道绝对防线。'
          },
          n3: {
            label: '选 C', terminal: true, verdict: 'bad',
            verdictTitle: '把「不能直接做」答成了「什么都做不了」',
            result: '<b>认知根源：只回答了字面问题，没有回到需求背后的真实目标。</b>负责人真正想要的是「降低被内核态观测的风险」，而「检测 eBPF」只是他想到的一种实现方式。<br><br>App 侧确实拿不到内核态信息，但风险降低路径依然存在：提高观测者的门槛（root 检测、完整性校验、设备可信状态评估）、增加观测者的成本、把敏感逻辑下沉到更难被静态定位的位置。<br><br><b>面对一个技术上不可实现的需求，优秀的回应是「重新定义问题」，而不是「拒绝问题」。</b>前者是工程师，后者只是执行者。'
          },
          n4: {
            label: '选 D', terminal: true, verdict: 'bad',
            verdictTitle: '技术上正是那道权限墙拦住的路径',
            result: '<b>认知根源：以为「读文件」比「调系统调用」更容易。</b>在 Android 上，<code>/proc/kallsyms</code> 和内核内存恰恰是限制最严的东西：<code>kptr_restrict</code> 一类内核参数会让符号地址对非特权进程隐藏；<code>/dev/kmem</code> 在现代内核上基本不存在；SELinux 也会拦住这类访问。<br><br>更根本的是：<b>App 的进程运行在 EL0，内核数据在 EL1</b>。从用户态「扫描内核内存」本身就是个伪命题——你没有那个视角，除非先拿到内核读写能力，而那就等于已经 root 了。<br><br>这条选项的诱惑在于它听起来很「底层、很硬核」，但方向错了，越硬核越浪费时间。'
          }
        }
      }
    },
    /* 三个自测题各占一个 section —— 同一 section 里放多个 quiz 键会被 JS 静默覆盖 */
    {
      h: '11.9', title: '自测（一）：BTF 缺失意味着什么',
      quiz: {
        id: 'q11-2', chapter: 11,
        answer: 2,
        stem: '一位同事说：「eBPF 就是把 Frida 那套 hook 搬到内核里跑，原理一样，只是位置不同。」这个说法<b>最主要的错误</b>在哪里？',
        options: [
          { t: '没有错误，本质就是这样', why: '这个说法抹掉了 eBPF 最核心的设计——验证器，也抹掉了两者在能力边界上的巨大差异。' },
          { t: 'eBPF 不能 hook 用户态函数，所以和 Frida 没有可比性', why: '不准确。uprobe/uretprobe 正是挂到用户态函数入口/返回的钩子，eBPF 完全可以观测用户态函数——只是方式与 Frida 的指令改写完全不同。' },
          { t: 'Frida 是改写目标进程的指令/内存来拦截执行，而 eBPF 程序是<b>独立运行在内核里的程序</b>，靠内核提供的钩子点被动触发；而且它必须先通过<b>验证器</b>的静态安全证明才能加载，能力被 helper 白名单严格限制', why: '正确。差别不是「换个位置执行同样的逻辑」，而是两套完全不同的执行与安全模型。' },
          { t: 'eBPF 只能用在 Linux 服务器上，手机上根本不存在这种东西', why: '错误。Android 基于 Linux 内核，系统自身就在用 eBPF（例如网络统计）。限制在于厂商配置、内核版本和 SELinux，而不是「不存在」。' }
        ],
        explain: '<b>「搬到内核里跑」这五个字丢掉了三件最关键的事。</b><br><br><b>① 执行模型不同。</b>Frida 的 Stalker/Interceptor 是<b>改写目标进程</b>——把跳转指令写进函数序言，或接管执行流。eBPF 是<b>一段独立存在于内核中的程序</b>，由内核在事件发生时调用；它不修改目标进程的任何字节。这也是 11.5 里「校验函数序言」那项自查对 eBPF 无效的原因。<br><br><b>② 安全模型不同。</b>Frida 注入的 JS 拥有目标进程的全部权限——它想崩就能崩。eBPF 必须过<b>验证器</b>：静态证明无越界、无死循环、指针类型正确，才能被加载。这是「凭什么允许用户代码进内核」这个问题的答案。<br><br><b>③ 能力边界不同。</b>Frida 能调用目标进程里的任意函数、读写任意内存。eBPF 只能用<b>helper 白名单</b>里的函数，不能动态分配内存、不能阻塞。它的能力是<b>被刻意收窄</b>的。<br><br>所以正确的表述是：<b>两者解决的是「观测/干预」这个大问题下的不同子问题，而不是同一个方案的两种部署位置。</b>'
      }
    },
    {
      h: '11.10', title: '自测（二）：把可用性拆成四个维度',
      quiz: {
        id: 'q11-3', chapter: 11,
        answer: [0, 2, 3],
        stem: '<b>多选。</b>以下关于 eBPF 在 Android 上可用性的判断，哪些是<b>正确</b>的？',
        options: [
          { t: '厂商常在定制内核时裁掉 BPF 相关配置，若 <code>CONFIG_BPF_SYSCALL</code> 未开启，则完全无法加载 eBPF 程序', why: '正确。这是 11.6 第 ② 条的核心：BPF 系统调用是总闸，没有它一切免谈。' },
          { t: '只要设备的 Android 版本足够新，就一定能加载自定义 eBPF 程序', why: '错误。Android 版本只是间接线索，真正的决定因素是内核版本、内核配置、SELinux 策略和权限。系统版本新但内核被裁剪的设备完全可能存在。' },
          { t: 'Android 系统自身使用 eBPF（例如按 UID 的网络流量统计），这说明内核路径是通的，但这些程序由系统进程加载，普通 App 无权', why: '正确。这既是可行性的证据，也划清了权限边界——「系统能用」不等于「你能用」。' },
          { t: '即使内核支持，Android 的 SELinux 强制访问控制仍可能限制 <code>bpf()</code> 系统调用，通常需要 root 才能绕过', why: '正确。这是 11.6 第 ③④ 条的叠加效果。' }
        ],
        explain: '<b>这道题的关键在于：把「支持」拆成四个独立的维度来判断。</b><br><br><b>① 内核版本</b>——决定有没有这个特性（较完整能力一般需 4.14+，Android 9 / kernel 4.9 起开启部分 BPF 功能）。<br>' +
          '<b>② 内核配置</b>——决定这个特性<b>在你这台机器上</b>有没有被编译进来，典型开关是 <code>CONFIG_BPF_SYSCALL</code>、<code>CONFIG_BPF_JIT</code>、<code>CONFIG_DEBUG_INFO_BTF</code>。<br>' +
          '<b>③ SELinux 策略</b>——决定你有没有权限去调用它。<br>' +
          '<b>④ 运行身份</b>——root 与否，往往决定前三条能不能落地。<br><br>' +
          '选项 B 的错误是典型的<b>「用代理指标替代真实指标」</b>：Android 版本和内核版本、内核配置之间没有强绑定，厂商可以在很新的系统上裁剪内核，也可以在老系统上开启部分功能。做这类判断，永远要落到<b>实测</b>。<br><br>' +
          '<span class="pill warn">再次提醒时效性</span>：上述经验以 2023 年前后的生态为背景，不同厂商、机型、内核版本差异极大，请以你自己的目标设备实测结果为准。'
      }
    },
    {
      h: '11.11', title: '自测（三）：按数据通路排查',
      quiz: {
        id: 'q11-4', chapter: 11,
        answer: 3,
        stem: '你的 eBPF 程序在内核里采集到了数据，但用户态程序一直读不到任何内容。回看 11.2 的九步流程，<b>最应该优先排查</b>的是哪一环？',
        options: [
          { t: '第一步「写程序」——重新检查 C 代码的逻辑是否正确', why: '逻辑错误确实可能导致没有数据，但「内核侧毫无输出」这种症状更典型地指向数据通路而非业务逻辑。而且如果程序有逻辑问题，往往加载阶段就会因为验证器检查失败而暴露。' },
          { t: '第六步「attach」——确认程序是否挂到了正确的钩子上，以及事件有没有真的发生', why: '这是第二顺位，值得排查（挂错钩子确实会一条数据都没有）。但如果 attach 完全失败，libbpf 通常会在加载或挂载时直接报错，而不是静默无输出。' },
          { t: '第五步「JIT 编译」——怀疑内核没有开启 JIT，导致程序没有真正执行', why: '方向错误。JIT 只影响<b>性能</b>；没有 JIT 时程序会解释执行，依然会产出数据，只是更慢。这不会造成「完全没有输出」。' },
          { t: '第八步「写 Map」——检查内核侧是否真的提交了数据：Map 定义、reserve/submit 是否配对、以及漏掉了失败分支的判空', why: '正确。这是最高频的原因，且症状完全吻合：程序在跑、事件在发生，但数据没有进入共享存储。' }
        ],
        explain: '<b>这道题训练的是「按数据通路排查」而不是「凭感觉猜」。</b><br><br>把 11.2 的九步按数据流切成三段：<b>入口段</b>（①②③④⑤⑥⑦：写、编、加载、验证、JIT、挂载、触发）、<b>存储段</b>（⑧：写 Map）、<b>出口段</b>（⑨：用户态读）。<br><br>「内核侧采集到了但用户态读不到」这个症状，指向的是<b>存储段和出口段</b>。而出口段相对好验证——先确认 Map fd 拿到了、注册回调成功、<code>poll</code> 返回值不是负数。如果出口段没问题，那问题几乎必然在第八步。<br><br>第八步最常见的三个坑：<b>①</b> Map 定义写错（类型、大小、<code>max_entries</code> 不合法——比如 ringbuf 要求 2 的幂）；<b>②</b> <code>reserve</code> 之后忘了 <code>submit</code>（或该 <code>discard</code> 时没归还），记录永远不出现在消费侧；<b>③</b> 没有处理 <code>reserve</code> 返回 NULL 的情况——缓冲满时静默丢数据，看起来就像「什么都没发生」。<br><br><b>排查口诀：先分入口/存储/出口三段定位，再在段内按可能性排序。</b>比逐个环节乱试快得多。'
      }
    }
  ],

  glossary: [
    { t: 'BPF', d: 'Berkeley Packet Filter，1992 年提出的网络包过滤机制，是 tcpdump 背后的底层技术。它只处理网络包，用途很窄。' },
    { t: 'eBPF', d: 'extended BPF，2014 年（Linux 3.18）引入。把 BPF 从「包过滤器」扩展成<b>一个运行在内核中的通用虚拟机</b>，可挂到几十种事件源上，用于可观测性、网络和安全监控。' },
    { t: '验证器 Verifier', d: '内核在加载 eBPF 程序时的静态分析器。它<b>不运行</b>程序，而是模拟所有可能的执行路径，证明代码不会崩溃内核、循环有界、内存访问不越界、指针类型正确。<b>它是 eBPF 安全性的基石</b>。' },
    { t: 'BPF Map', d: '内核态 eBPF 程序与用户态程序共享的键值存储，是两者通信的<b>主要</b>通道。常见类型有 HASH、ARRAY、PERCPU_ARRAY、RINGBUF、PERF_EVENT_ARRAY。' },
    { t: 'ringbuf', d: '<code>BPF_MAP_TYPE_RINGBUF</code>，现代推荐的流式数据传输方式。单生产者单消费者、无锁、高效，用来取代老式的 perf_event_array（后者是每 CPU 一份缓冲，会打乱事件顺序且 fd 开销大）。' },
    { t: 'Helper 函数', d: '内核提供给 eBPF 程序调用的受控函数白名单。eBPF 程序<b>不能</b>直接调用任意内核函数，只能通过这些 helper（如 bpf_probe_read_user、bpf_get_current_pid_tgid）。这是安全边界的一部分。' },
    { t: 'kprobe / kretprobe', d: '内核函数入口 / 返回处的动态探针，用于追踪内核函数调用。属于较底层的手段，依赖具体的内核函数名与签名。' },
    { t: 'uprobe / uretprobe', d: '用户态函数入口 / 返回处的探针。对逆向最有用——可以直接盯住某个 so 里的加解密、校验函数，且不需要修改目标进程的任何指令。' },
    { t: 'tracepoint', d: '内核预先定义的静态追踪点（如系统调用的 sys_enter/sys_exit）。相比 kprobe 更稳定，不依赖内核内部函数名，是<b>推荐优先使用</b>的钩子类型。' },
    { t: 'BTF', d: 'BPF Type Format，内核的调试类型信息，暴露在 <code>/sys/kernel/btf/vmlinux</code>。它是 CO-RE 的基础——没有它，libbpf 无法在加载时做类型重定位。' },
    { t: 'CO-RE', d: 'Compile Once – Run Everywhere。借助 BTF 类型信息，让同一份 eBPF 目标文件适配不同内核版本。重定位发生在<b>加载时</b>（libbpf 读目标机的 BTF），因此目标机没有 BTF 时无法使用。' },
    { t: 'XDP', d: 'eXpress Data Path，网络驱动层最早的数据包处理点。在协议栈之前执行，性能极高，常用于高性能包处理、负载均衡和 DDoS 防护。' }
  ],

  teacher: {
    id: 'ch11', chapter: 11,
    name: '追问老师 · 第 11 章',
    sub: 'eBPF 的安全模型、它和 Frida 的关系、以及它在 Android 上到底能不能用。',
    intro: '<p style="margin:0">这一章名词多、门槛高，所以我会问得比前几章更狠。<b>我不接受「eBPF 很强大所以要用它」这种回答</b>——我要听的是：内核凭什么信任它、数据怎么回来、以及在你的目标设备上它究竟跑不跑得起来。答不上来我会一层层追问，直到你自己把逻辑补完整。</p>',
    questions: [
      {
        id: 'c11q1', depth: 1, threshold: 0.7,
        q: '<b>BPF</b> 和 <b>eBPF</b> 是什么关系？请说清 BPF 最初是干什么的、eBPF 在什么时候把它变成了什么。',
        concepts: [
          { label: 'BPF 是 1992 年提出的网络包过滤机制，是 tcpdump 的底层',
            hint: '先想 tcpdump 抓包的时候，那些过滤表达式最终是谁在执行？',
            any: ['1992', '包过滤', '抓包', 'tcpdump', 'libpcap', 'packet filter', 'berkeley packet filter', '网络包', '报文过滤', '过滤网络包'] },
          { label: 'eBPF 是 extended BPF，2014 年随 Linux 3.18 引入',
            hint: '它是在哪个内核版本进入主线的？',
            any: ['2014', '3.18', 'extended bpf', 'linux 3.18', '扩展 bpf', '扩展版 bpf'] },
          { label: 'eBPF 把它从专用过滤器升级成运行在内核中的通用虚拟机',
            hint: '升级之后，它还能不能只处理网络包？',
            any: ['通用虚拟机', '虚拟机', 'vm', 'virtual machine', '通用', '不再局限于网络', '不只是网络', '内核中运行', '内核态运行', '可编程', '通用执行引擎', '跑在内核里'] }
        ],
        hints: [
          '回忆一下：tcpdump 写 `tcp port 80` 这种过滤条件时，真正的过滤动作发生在用户态还是内核态？',
          '版本号是个硬知识：BPF 的年代，和 eBPF 进入 Linux 主线内核的版本。'
        ],
        probes: [
          '你说 eBPF 是「通用虚拟机」——那它「通用」体现在哪里？和原来只处理网络包相比，多了什么能力？',
          '为什么这个改动值得单独立一个名字？直接叫 BPF 2.0 不行吗？'
        ],
        model: '<b>BPF（Berkeley Packet Filter）诞生于 1992 年</b>，解决的问题非常具体：网络抓包时，如果每个包都要先拷到用户态再判断「要不要」，开销太大。BPF 的思路是把过滤规则编译成一小段字节码，<b>在内核里先筛一遍</b>，只把命中的包交给用户态。它是 <code>tcpdump</code> 背后的底层机制（经由 libpcap），几十年里一直很稳定，但用途也一直很窄——只处理网络包。' +
          '<br><br><b>eBPF（extended BPF）在 2014 年随 Linux 3.18 进入主线内核</b>，做的是把 BPF 从「一个专用过滤器」彻底重做成「<b>一个运行在内核中的通用虚拟机</b>」。这个「通用」体现在三处：<b>①</b> 输入不再限于网络包——内核提供了几十种<b>钩子点</b>（kprobe、tracepoint、uprobe、XDP、LSM……），挂在哪里决定它看见什么；<b>②</b> 指令集扩充为 64 位、寄存器从 2 个扩到 10 个以上（具体数量不必死记），能表达更复杂的逻辑；<b>③</b> 有了 <b>BPF Map</b> 这个内核态与用户态共享的存储，程序可以把状态留下来、把结果交出去。' +
          '<br><br>于是今天它被用在可观测性（性能分析、系统调用追踪）、网络（负载均衡、DDoS 防护）和安全监控上。<b>对逆向工程师来说，最重要的那句总结是：eBPF 让我们第一次有了一个「写起来像普通程序、跑起来在内核态、还不改目标进程一个字节」的观测手段。</b>',
        after: '<p>这道题是地基。如果 BPF/eBPF 的关系说不清，后面验证器、Map、Android 限制全都挂不上。</p>'
      },
      {
        id: 'c11q2', depth: 2, threshold: 0.75,
        q: '内核凭什么敢让用户写的代码在内核态执行？<b>验证器</b>具体检查哪些东西？请至少说出三项，并解释为什么它被称为 eBPF 安全性的基石。',
        concepts: [
          { label: '验证器做的是静态分析，不实际运行程序',
            hint: '它是「跑一遍看看会不会崩」，还是「证明它不可能崩」？',
            any: ['静态分析', '静态检查', '不运行', '不会真的执行', '不实际执行', '模拟执行', '符号执行', '证明', 'statically', 'static analysis', '遍历所有路径', '所有可能路径'] },
          { label: '检查循环：老内核完全禁止，新内核要求能证明循环有界',
            hint: '如果程序里有个永不结束的循环，内核会怎么样？',
            any: ['循环', '死循环', '有界', '边界', '上界', '无限循环', 'loop', 'bounded', '有界循环', '循环次数', '不能无限'] },
          { label: '检查内存访问：读写必须落在合法范围内，不能越界',
            hint: '如果程序读了一个越界的地址会怎样？',
            any: ['内存访问', '越界', '边界', '偏移', '范围', 'out of bound', 'bounds', '内存安全', '读写范围', '非法地址', '不能越界'] },
          { label: '检查指针类型：ctx / Map value / 包指针不能混用，算术运算后类型会退化',
            hint: '一个指向 Map value 的寄存器，能不能当上下文指针用？',
            any: ['指针类型', '类型系统', '类型检查', '寄存器类型', 'ptr_to', '不能混用', '类型退化', 'pointer type', '类型不匹配', '类型安全'] },
          { label: '检查 helper 调用是否在白名单内、参数类型是否匹配',
            hint: 'eBPF 程序能不能随便调用内核函数？',
            any: ['helper', '白名单', '受控', '调用限制', '参数类型', '允许调用的函数', '不能调用任意', 'helper 白名单'] },
          { label: '它是安全性的基石：证明不通过就拒绝加载，把「信任作者」变成「证明程序安全」',
            hint: '如果去掉验证器，eBPF 还能存在吗？',
            any: ['基石', '基础', '根本', '拒绝加载', '加载失败', '不允许加载', '不信任作者', '证明安全', '安全保证', '没有它就不安全', '先决条件', '前提'] }
        ],
        hints: [
          '换个角度问自己：如果内核直接执行用户提交的任意字节码，攻击者会怎么做？把你能想到的坏事列出来，每一条对应验证器的一项检查。',
          '「循环、内存、指针」是三项核心检查；除此之外还有一类和「能调用什么函数」有关的检查。'
        ],
        probes: [
          '你说验证器检查内存访问——那内核态程序想读用户态内存里的字符串，直接解引用行不行？为什么？',
          '为什么旧内核干脆禁止循环，而不是想办法限制循环次数？后来为什么又放开了？'
        ],
        model: '<b>验证器（verifier）要回答的是「凭什么信任」这个问题，而它的答案不是信任作者，而是证明程序安全。</b>注意它的工作方式是<b>静态分析</b>：<b>它不会真的把程序跑一遍看会不会崩</b>，而是模拟执行字节码的<b>所有可能路径</b>，逐条指令地证明这段代码不可能损坏内核。' +
          '<br><br>核心检查有三项：<br>' +
          '<b>① 循环。</b>最早的 eBPF <b>完全禁止循环</b>——因为内核态死循环等于整机卡死，而这个后果无法接受。后来内核放宽了限制：允许循环，但验证器<b>必须能证明它有界</b>（例如循环次数是常量，或被限定在某个可证明的范围内）。证明不了的，直接拒收。这就是为什么在 eBPF 里写 <code>while</code> 要格外小心。<br>' +
          '<b>② 内存访问。</b>内核指针（ctx、Map value、数据包）的每次读写，偏移量都必须被证明落在合法范围内。越界一次，轻则信息泄露，重则内核 oops。特别地，<b>用户态指针在内核里绝对不能直接解引用</b>——用户态随时可能把那块内存 unmap 掉，必须改用 <code>bpf_probe_read_user()</code> 这类 helper 做安全拷贝。<br>' +
          '<b>③ 指针类型。</b>验证器维护一套寄存器类型系统：这是 ctx 指针、那是指向 Map value 的指针、那只是个标量。类型是一道硬墙，不能混用；而且<b>指针一旦做算术运算，类型就会退化</b>，之后想再用它读写必须重新做边界检查。<br><br>' +
          '此外还会检查 <b>helper 调用</b>：eBPF 程序不能调用任意内核函数，只能用内核提供的受控 helper，且不同程序类型开放的白名单不同。<br><br>' +
          '<b>为什么说它是基石？</b>因为它是「允许用户代码进内核」这个决定的唯一担保。没有验证器，eBPF 就是一个任意内核代码执行漏洞——整个技术根本不可能被接受进主线内核。所以验证失败不是异常而是常态，排查顺序建议是：<b>先看循环有没有上界，再看有没有直接解引用用户态指针，最后看指针类型有没有用混。</b>',
        after: '<p>能把这三项检查和「如果不管会出什么事」一一对应上，就说明你真的理解了 eBPF 的安全模型，而不是背了三条名词。</p>'
      },
      {
        id: 'c11q3', depth: 2, threshold: 0.75,
        q: 'eBPF 程序跑在内核态，它采到的数据是<b>怎么回到用户态</b>的？为什么一定要走这条路？另外，<code>ringbuf</code> 相比老的 <code>perf_event_array</code> 好在哪？',
        concepts: [
          { label: '通过 BPF Map：内核态与用户态共享的键值存储，是两者通信的主要通道',
            hint: '它不是「发消息」，那它是什么？',
            any: ['map', 'bpf map', 'bpf maps', '共享', '键值', '键值对', '共享存储', '共享内存', '通信通道', '主要通道', 'kv', 'key value'] },
          { label: '内核态用 helper 写：bpf_map_lookup_elem / bpf_map_update_elem / bpf_map_delete_elem 等',
            hint: '内核侧是用什么 API 往 Map 里放东西的？',
            any: ['helper', 'bpf_map_update_elem', 'bpf_map_lookup_elem', 'bpf_map_delete_elem', 'bpf_map_update', 'bpf_map_lookup', 'map_update_elem', '用 helper 写'] },
          { label: '用户态按 fd 读：通过 bpf() 系统调用或 libbpf 提供的封装',
            hint: '用户态拿到的是什么句柄？',
            any: ['fd', '文件描述符', 'libbpf', 'bpf()', 'bpf 系统调用', '系统调用', 'bpf_map__fd', '用户态读', '轮询', 'poll', 'map fd'] },
          { label: '内核态不能直接 printf，也不能直接把数据推给某个进程',
            hint: 'eBPF 里有 printf 吗？',
            any: ['不能 printf', '不能直接输出', '没有 printf', '不能打印', 'bpf_printk', '不能直接通信', '无法直接', '不能任意调用', '只能写 map', '没有 libc'] },
          { label: 'ringbuf 是单生产者单消费者、无锁、高效，推荐用于流式数据',
            hint: 'ringbuf 的核心卖点是它的并发模型。',
            any: ['ringbuf', 'ring buffer', '环形缓冲', '单生产者', '单消费者', '无锁', 'lock free', 'lockless', '高效', 'spmc', '推荐'] },
          { label: 'perf_event_array 是每 CPU 一份缓冲，会打乱事件顺序、fd 开销大，所以被 ringbuf 取代',
            hint: '老方案在多核机器上有什么麻烦？',
            any: ['perf_event_array', 'perf buffer', 'perf 缓冲', '每 cpu', 'per cpu', '每个 cpu', '顺序', '乱序', '打乱', '开销大', '文件描述符多', 'fd 多', '被取代', '老方案', '旧方案'] }
        ],
        hints: [
          '关键认识：Map 不是「内核发给用户态的消息」，而是双方都能按 fd 访问的<b>同一块存储</b>。先接受这一点，所有 API 就顺了。',
          '想想多核：如果每个 CPU 都往自己那份缓冲里写，用户态读的时候，事件的全局顺序还保得住吗？'
        ],
        probes: [
          '你说用 Map 传数据——那如果我要传的是「源源不断的事件流」而不是「一张统计表」，Map 类型该怎么选？为什么？',
          '内核态程序往 Map 里写的时候，有没有可能写失败？失败了你该怎么办？（提示：验证器会盯着你）'
        ],
        model: '<b>内核态和用户态之间只有一条主要通道：BPF Map。</b>先纠正一个常见误解——Map <b>不是「内核发给用户态的消息队列」</b>，而是<b>一块双方都能按 fd 访问的共享键值存储</b>。内核侧和用户态侧谁也不「发送」什么，只是各自往同一个 fd 上读写而已。理解这一点，后面所有 API 都不再别扭。' +
          '<br><br><b>为什么必须走这条路？</b>因为 eBPF 程序的能力被刻意收窄了：它没有 libc，<b>不能调用 printf，也不能直接把数据交给某个用户态进程</b>。它唯一被允许的对外动作，就是通过 helper 操作内核对象。<br><br>' +
          '<b>内核侧</b>用 helper 写：<code>bpf_map_lookup_elem()</code>、<code>bpf_map_update_elem()</code>、<code>bpf_map_delete_elem()</code>；流式场景则用 ringbuf 的 <code>reserve</code>/<code>submit</code> 配对。<br>' +
          '<b>用户态侧</b>通过 <code>bpf()</code> 系统调用，或直接用 libbpf 的封装（如 <code>bpf_map__fd()</code>、<code>ring_buffer__poll()</code>）读同一块存储。' +
          '<br><br><b>ringbuf 相比 perf_event_array 的改进</b>：老的 <code>perf_event_array</code> 是<b>每个 CPU 一份缓冲</b>，带来两个麻烦——多核下事件的<b>全局顺序会被打乱</b>，而且要开一大堆 fd、管理成本高。' +
          '<code>ringbuf</code>（<code>BPF_MAP_TYPE_RINGBUF</code>）是<b>单生产者单消费者、无锁</b>的环形缓冲，所有 CPU 共享一个，既保序又高效，是<b>现代推荐的流式传输方式</b>。' +
          '<br><br><b>实战提醒：</b>在 Map 上做操作必须<b>判空</b>、写 ringbuf 前 <code>reserve</code> 失败必须返回——验证器会检查这些分支。漏掉判空，加载就被拒。另外结构体大小和栈上临时变量都有尺寸上限，超出会直接失败。',
        after: '<p>把「Map 是共享存储而不是消息通道」这句话记住，你就超过了大多数只会照抄 BCC 脚本的人。</p>'
      },
      {
        id: 'c11q4', depth: 3, threshold: 0.75,
        q: '<b>综合题。</b>你手上有一台 Android 手机，想用 eBPF 观测某个 App 的行为。请说出至少<b>四重</b>限制，每重说明「挡住了什么、能不能绕过」；并说明你会按什么顺序去探测一台设备到底支不支持。',
        concepts: [
          { label: '内核版本：老设备内核太旧，较完整的 eBPF 能力一般需要 4.14+',
            hint: 'Android 9 对应哪个内核版本？更完整的 eBPF 能力需要多新？',
            any: ['内核版本', 'kernel 版本', '版本太旧', '4.14', '4.9', 'kernel 4', '版本低', '内核太老', 'android 9', '内核基线'] },
          { label: '厂商内核裁剪：BPF 相关配置可能未开启，CONFIG_BPF_SYSCALL 未开则完全无法加载',
            hint: '厂商为了让内核变小、攻击面变小，会做什么？哪个配置是总闸？',
            any: ['裁剪', '厂商', '定制内核', 'config', '内核配置', 'CONFIG_BPF_SYSCALL', 'BPF_SYSCALL', 'CONFIG_BPF_JIT', 'BPF_JIT', 'DEBUG_INFO_BTF', '未开启', '没开', '总闸', '编译选项', '阉割'] },
          { label: 'SELinux 强制访问控制会限制 bpf() 系统调用，普通 App 无权调用',
            hint: 'Android 上有一层强制访问控制，它会拦系统调用。',
            any: ['selinux', '强制访问控制', 'mac', '策略', 'policy', '被拦', '拦截', '权限控制', 'enforcing', '无权调用', '普通 app 无权'] },
          { label: '需要 root（或定制 ROM）：前面几条叠加的结果',
            hint: '前面三条叠加起来，最后的现实门槛是什么？',
            any: ['root', '超级用户', '提权', 'su', 'magisk', '定制 rom', '刷机', '高权限', 'cap_bpf', 'cap_sys_admin', '需要权限'] },
          { label: 'Android 系统自身在用 eBPF（如按 UID 的网络流量统计），证明可行但这些程序由系统进程加载',
            hint: 'Android 自己有没有在用 eBPF？这说明了什么、又没说明什么？',
            any: ['android 自己', '系统自己在用', '流量统计', 'trafficController', 'traffic controller', '系统进程', '系统加载', '证明可行', '网络统计', 'uid 统计', '按 uid'] },
          { label: '探测顺序与实测意识：不臆测，要在目标设备上按版本→配置→BTF→SELinux→root 逐项确认（且结果有时效性）',
            hint: '不同厂商机型差异极大，你凭什么下结论？',
            any: ['实测', '探测', '验证', '确认', 'uname', 'config.gz', 'btf', 'vmlinux', 'getenforce', '逐项', '顺序', '不确定', '差异大', '以实测为准', '时效', '不能假设', '不能臆测'] }
        ],
        hints: [
          '把「支持 eBPF」拆成四个独立维度来想：内核<b>有没有</b>这个特性、这个特性在这台机器上<b>有没有被编译进来</b>、你有<b>没有权限</b>调用它、你<b>是不是 root</b>。',
          '还有一个反直觉的事实：Android 系统自己就在用 eBPF。想清楚这件事「证明了什么」和「没证明什么」。'
        ],
        probes: [
          '你说要看内核配置——如果 <code>/proc/config.gz</code> 这个文件在设备上根本不存在，你还能怎么判断内核支不支持 BPF？',
          '假设探测结果是没有 BTF，但 CONFIG_BPF_SYSCALL=y、也有 root。你会放弃吗？如果不放弃，方案要怎么改？'
        ],
        model: '<b>结论先说：eBPF 在 Android 上「理论可行，实际高度受限」。</b>Android 基于 Linux 内核，内核本身有 BPF 支持；Android 9（kernel 4.9）起内核配置就开了一部分 BPF 功能，较完整的 eBPF 能力一般需要 <b>4.14+</b>。但「内核里有」和「你能用」之间隔着四堵墙。' +
          '<br><br><b>① 内核版本。</b>挡住的是「这个特性存不存在」。老设备内核太旧，BTF、ringbuf、有界循环支持等新能力压根没有。<b>绕不过</b>——这是硬件与固件层面的既成事实，只能换设备。' +
          '<br><b>② 厂商内核裁剪。</b>挡住的是「这个特性有没有被编译进来」。厂商为减小体积、缩小攻击面，常把 BPF 相关配置裁掉：<code>CONFIG_BPF_SYSCALL</code>（总闸，没有它<b>完全无法加载</b> eBPF 程序）、<code>CONFIG_BPF_JIT</code>（没有它只能解释执行，性能大降）、<code>CONFIG_DEBUG_INFO_BTF</code>（没有它就没有 BTF，CO-RE 用不了）。<b>理论可自编译内核，但需解锁 bootloader、有变砖风险、多数机型源码不完整</b>，成本极高。' +
          '<br><b>③ SELinux 策略。</b>挡住的是「你有没有权限调用」。Android 的强制访问控制会限制 <code>bpf()</code> 系统调用，普通 App 无权。<b>需 root 后调整策略</b>。' +
          '<br><b>④ 需要 root。</b>这是前三条叠加的现实结果。没有银弹。' +
          '<br><br><b>一个反直觉但重要的事实：Android 自己在用 eBPF</b>（例如按 UID 的网络流量统计、<code>trafficController</code> 相关模块）。这<b>证明</b>了真机上跑 eBPF 可行；但<b>不证明</b>你有权限——这些程序由系统进程在开机时加载。' +
          '<br><br><b>探测顺序（顺序很重要，前一项不过后面做了也白做）：</b><b>①</b> <code>uname -r</code> 看内核版本；<b>②</b> <code>zcat /proc/config.gz | grep CONFIG_BPF</code>（文件不存在就改用 <code>bpftool feature probe</code> 直接问内核）；<b>③</b> <code>ls /sys/kernel/btf/vmlinux</code> 判断 CO-RE 可用性；<b>④</b> <code>getenforce</code> 看 SELinux；<b>⑤</b> 有没有 root。' +
          '<br><br><b>最后必须强调时效性：</b>「哪些机型支持」这个问题，每一年、每个厂商、每个机型、每个内核版本的答案都不一样，厂商还会随系统更新调整策略。<b>以你自己的目标设备实测为准，不要相信任何固定结论</b>——包括我这段话。',
        after: '<p>如果这道题你能把四重限制和探测顺序都讲出来，说明你已经具备「在真机上评估一项底层技术可行性」的能力——这比记住 eBPF 的 API 值钱得多。</p>'
      },
      {
        id: 'c11q5', depth: 3, threshold: 0.75,
        q: '<b>综合题（本章灵魂）。</b>同样是观测目标 App 的一次函数调用，用 eBPF 和用 Frida 相比，<b>隐蔽性上的差别到底来自哪里</b>？请从「App 能做哪些自查」的角度具体说明，并谈谈这种隐蔽性有什么代价和边界。',
        concepts: [
          { label: 'Frida 需要注入目标进程，会在其地址空间里留下模块（/proc/self/maps 可见）',
            hint: 'agent 被注入之后，目标进程里多了什么？',
            any: ['注入', 'maps', '/proc/self/maps', '模块', 'so', 'frida-agent', '地址空间', '多了一个 so', '内存里', '进程内部', '要注入'] },
          { label: 'Frida 会改写指令/内存来拦截执行，代码段与磁盘文件不一致，函数序言被改，可被完整性校验发现',
            hint: 'inline hook 在内存里留下了什么痕迹？',
            any: ['改写', '修改指令', 'inline hook', '序言', '代码段', '内存校验', '字节比对', '完整性', '改了内存', '篡改', 'prologue'] },
          { label: 'Frida 可能留下线程名、监听端口、ptrace 痕迹（TracerPid）',
            hint: '除了内存，进程表、端口表上还有没有线索？',
            any: ['线程名', 'thread', 'comm', '端口', 'port', '27042', 'tracerpid', 'ptrace', 'task', '进程表', '句柄'] },
          { label: 'eBPF 运行在<b>内核态</b>，在目标进程的地址空间之外，App 的这些自查全部失效',
            hint: '核心差别不在于技术先进，而在于观测点在哪。',
            any: ['内核态', 'kernel', '地址空间之外', '不在进程里', '进程外', '内核侧', '内核里', '观测点更底', '外层', '内核视角', 'all 失效', '看不到'] },
          { label: 'eBPF 是只读观测，不修改目标进程的任何字节（不注入、不改指令、不加线程）',
            hint: 'eBPF 会改目标进程的内存吗？',
            any: ['只读', '不修改', '不改指令', '不注入', '不改变目标', '不加线程', '不改内存', 'read only', '无侵入', '非侵入', '零修改'] },
          { label: '代价与边界：观测者自身（loader 进程、文件、root 状态）仍会在用户态留痕；加载需要高权限；对手也能用 eBPF 反制，是双向博弈',
            hint: '内核态隐蔽的是「观测动作」，那「观测者」呢？',
            any: ['代价', '边界', '局限', 'loader', '观测者', '进程可见', '文件', 'root 状态', '高权限', '双向', '对手也能', '反制', '博弈', '不是万能', '同样能', '需要 root', '留痕'] },
          { label: '与课程的层级主线呼应：内核态观测（第 11 章）/ 内核态对抗（第 13 章）/ Hypervisor（第 6 章），逐层向下要控制权',
            hint: '本章在课程里处在哪一层？再往下还有什么？',
            any: ['第 13 章', '第13章', '13 章', '第 6 章', '第6章', 'hypervisor', '层级', '更低', '逐层', 'svc', '硬件断点', '更底层', '控制权'] }
        ],
        hints: [
          '不要泛泛说「eBPF 更高级」。请具体列出 App 有哪几项自查手段，然后逐项判断：这条手段对 Frida 有效吗？对 eBPF 有效吗？为什么？',
          '隐蔽性的来源可以用一句话概括——但它不是「eBPF 这个技术本身很隐蔽」，而是关于<b>观测发生在哪里</b>的一句话。'
        ],
        probes: [
          '你说 App 检测不到 eBPF——那 App 有没有可能检测到「有人在这台设备上加载 eBPF」这件事本身？注意区分「观测动作」和「观测者」。',
          '如果对手也用 eBPF 来监控你的行为，你该怎么办？这个问题的答案和本章哪个章节有关联？'
        ],
        model: '<b>隐蔽性的差别不来自「eBPF 技术更先进」，而来自一句很朴素的话：观测发生在目标进程的地址空间之外。</b>把这句话想通，你就能自己推导出哪些检测有效、哪些天生无效。' +
          '<br><br><b>先看 App 的常规自查有哪些，以及两条路各会露出什么：</b><br>' +
          '<b>① 扫 <code>/proc/self/maps</code>。</b>Frida 注入后会多出一个 agent 模块，<b>命中</b>；eBPF 不往目标进程里放任何东西，<b>无效</b>。<br>' +
          '<b>② 遍历 <code>/proc/self/task/*/comm</code> 查线程名。</b>Frida 会留下框架线程，<b>命中</b>；eBPF 一个线程都不加，<b>无效</b>。<br>' +
          '<b>③ 扫监听端口（例如 27042 一类）。</b>Frida 可能开端口，<b>可能命中</b>；eBPF 根本不进这个进程，<b>无效</b>。<br>' +
          '<b>④ 读 <code>/proc/self/status</code> 看 TracerPid / 查 ptrace 痕迹。</b>Frida 的某些接入方式会命中；eBPF 走的是内核探针机制，不是 ptrace 附着，<b>无效</b>。<br>' +
          '<b>⑤ 把内存里的代码段与磁盘上的 <code>.so</code> 逐字节比对。</b>Frida 的 inline hook 会改写函数序言，<b>命中</b>；eBPF <b>不修改目标进程的任何字节</b>——它是只读观测，<b>无效</b>。<br>' +
          '<b>⑥ 校验函数序言字节。</b>同上，Frida <b>命中</b>，eBPF <b>无效</b>。<br><br>' +
          '<b>所以规律是：所有依赖「观测者必须在目标进程内部留下东西」的检测手段，对内核态观测一律失效。</b>' +
          '<br><br><b>但这种隐蔽性有明确的代价与边界，不能神化：</b>' +
          '<b>① 观测者本身不隐蔽。</b>你的 loader 是个跑在手机上的用户态进程，会被 <code>ps</code> 看见、会在文件系统里留下文件（<code>/data/local/tmp</code> 是重灾区）。内核态隐蔽的是「观测动作」，不是「观测者」。<br>' +
          '<b>② 加载门槛极高。</b>要加载 eBPF 程序需要高权限，实际通常要 root（见 11.6）。你为了让观测更隐蔽，反而先要在设备上取得最高权限——这是很现实的成本，而且 root 状态本身就是 App 最容易检测的信号之一。<br>' +
          '<b>③ 这是双向博弈。</b>对手同样可以用 eBPF 监控你的行为，甚至用 LSM 钩子加固自己的检测逻辑。<b>不存在一劳永逸的隐蔽</b>，加固与对抗的价值都在于抬高对方的成本。<br>' +
          '<b>④ 观测粒度有取舍。</b>eBPF 看不到目标进程内部的任意内存和任意函数调用细节（Frida 可以），它擅长的是系统调用、文件、网络、以及通过 uprobe 挂到的特定函数入口/出口。' +
          '<br><br><b>放回课程坐标系：</b>第 6 章的 Hypervisor 层比内核更低，第 11 章（本章）是内核态观测的标准手段，第 13 章讲内核态对抗（SVC 系统调用、硬件断点）。三章连起来是一条主线——<b>谁控制了更低的层，谁就拥有最终的观测权和控制权。</b>',
        after: '<p>这道题是本章存在的理由。如果你只能记住本章的一件事，请记住：<b>内核态观测的隐蔽性来自「在目标进程的地址空间之外」，而不是来自 eBPF 本身有什么隐身魔法。</b></p>'
      }
    ]
  }
};
