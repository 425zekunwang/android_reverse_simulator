/* 第 21 章 · Unicorn / unidbg 模拟执行
   数据文件：只声明数据，不含模块语法。组件与助手 API 见 BRIEF.md。 */
window.CHAPTER = {
  no: 21,
  title: 'Unicorn / unidbg 模拟执行',
  lede: '真机、Frida、IDA 之外还有第三条路：<strong>不启动 App、不插桩，直接在 PC 上把 so 里的加密函数「跑」出来</strong>。本章从 Unicorn 的裸 CPU 讲起，穿过「补环境」这片泥潭，最后落到 unidbg 的一体化黑盒调用与工程化封装。',
  meta: [
    '核心问题：<b>如何在没有设备、没有完整 Android 系统的情况下，让 so 里的算法函数跑出与真机一致的结果？</b>',
    '关键工具：<b>Capstone / Unicorn / Keystone</b> 三兄弟、<b>AndroidNativeEmu</b>、<b>unidbg</b>',
    '对手：<b>补环境</b> —— so 对 libc、syscall、JNIEnv、JavaVM、Java 层的每一处依赖，都得你亲手补上'
  ],

  sections: [
    /* ================= 21.1 ================= */
    {
      h: '21.1',
      title: '第三条路：把 so 搬进 PC 里跑',
      intuition: {
        tag: '直觉模型 · 无菌病房里做手术',
        body: '<p>真机 + Frida 调试，像在<b>闹市街头做手术</b>：病人（App）活着，但随时有交警（反调试）来查、围观群众（其他线程）在动、天气（网络 / 时间 / 电量）还在变。模拟执行则是把病人请进<b>无菌病房</b>：没有交警、没有围观群众、天气恒定。</p><p>代价是：病房里<b>什么都没有</b>。呼吸机、输液泵、监护仪，你得一台一台自己搬进来。搬设备的过程，就叫<b>补环境</b>。</p>'
      },
      html: T.note('key', '🔑 一句话定位', '<p>模拟执行 = <b>不启动 App、不需要真机</b>，直接在 PC 上加载 so，把里面的加密函数「跑」出结果。它不解决「看懂算法」，它解决「<b>让算法替你干活</b>」。</p>') +
        '<p>走到加密函数这一步，逆向工程通常只有三条路：</p>' +
        T.tbl(['路线', '怎么拿到结果', '代价'], [
          ['静态分析', 'IDA / Ghidra 读汇编，自己用 Python 重写算法', '要真正看懂每一行；遇到魔改、加固、上千行的大函数时成本爆炸'],
          ['动态调试', '真机 + Frida hook 入参与返回值，或 RPC 导出接口', '依赖设备、速度慢、难并发、随时可能撞上反调试'],
          ['模拟执行', 'Unicorn / unidbg 在 PC 上加载 so 并直接调用', '要补环境；so 的依赖越复杂，补环境越痛']
        ]) +
        '<p>模拟执行不是「更高级的 Frida」，它是<b>另一个维度的解法</b>：Frida 是让程序在它自己的环境里跑，你去旁听；模拟执行是把程序从它的环境里<b>拎出来</b>，放进你造的盒子里跑。</p>' +
        T.note('ok', '✅ 什么时候值得动用模拟执行', '<ul><li>算法全在 native 层（so），Java 层只是壳；</li><li>需要<b>批量</b>生成样本、<b>并发</b>跑算法（爬虫 / 风控对抗的典型场景）；</li><li>目标 App 反调试极强，真机 Frida 一挂就崩；</li><li>手里只有 so，没有完整 APK，也没有可用的设备。</li></ul>') +
        T.note('warn', '⚠️ 它解决不了什么', '<p>模拟执行<b>不会</b>告诉你算法逻辑长什么样。你能喂输入取输出，却依然可能不知道它做了什么——这是「黑盒」的天然后果。想要能改、能审计、能应对算法升级，最终还是要回到静态分析。</p>') +
        '<p>另外，模拟执行对<span class="term" data-def="被模拟的代码与它运行的环境之间的一切交互：库函数、系统调用、JNI 表、文件、时间。补不齐就跑不起来。">环境依赖</span>的容忍度很低：真机上 so 随便调什么都有系统兜着，模拟器里<b>什么都没有</b>。</p>'
    },

    /* ================= 21.2 ================= */
    {
      h: '21.2',
      title: '三兄弟：Capstone / Unicorn / Keystone',
      html: '<p>动手之前先把三个工具的分工钉死。它们的名字很像，定位却完全不同——<b>只有中间那个是模拟器</b>。</p>' +
        T.tbl(['工具', '方向', '它是什么'], [
          ['<b>Capstone</b>', '机器码 → 汇编文本', '反汇编框架（Disassembly Framework）。把一串字节翻译成人能读的汇编，是反汇编器里的「翻译官」。'],
          ['<b>Unicorn</b>', '（执行）机器码', 'CPU 模拟器，基于 QEMU 的 <span class="term" data-def="Tiny Code Generator，QEMU 的动态二进制翻译引擎：把目标架构指令翻译成宿主机可执行的中间表示再运行。">TCG</span> 引擎。<b>只模拟 CPU，不模拟系统。</b>'],
          ['<b>Keystone</b>', '汇编文本 → 机器码', '汇编框架（Assembler Framework），Capstone 的逆运算。用来现场造几行指令塞进模拟器。']
        ]) +
        '<p>三者常被混用，但方向是相反的：</p>' +
        T.grid(2, [
          T.card('Capstone：字节 → 文本', T.code('from capstone import *\nmd = Cs(CS_ARCH_ARM64, CS_MODE_ARM)\nfor insn in md.disasm(code, 0x1000):\n    print(hex(insn.address), insn.mnemonic, insn.op_str)')),
          T.card('Keystone：文本 → 字节', T.code('from keystone import *\nks = Ks(KS_ARCH_ARM64, KS_MODE_LITTLE_ENDIAN)\nencoding, count = ks.asm("add x0, x0, x1")'))
        ]) +
        T.note('bad', '⚠️ 最容易误解的一点', '<p>Unicorn <b>不是</b> Android 模拟器，也不是虚拟机。它只是一颗「会照着指令改寄存器的 CPU」。把它当成「PC 上的手机」是本章一切踩坑的总根源。</p>') +
        '<p>「只模拟 CPU」意味着以下四样东西<b>统统不存在</b>，全部要你自己造：</p>' +
        '<ul>' +
        '<li><b>内存</b>：没有地址空间。想用哪段地址，先 <span class="mono">mem_map</span>；</li>' +
        '<li><b>系统调用</b>：没有内核。so 执行 <span class="mono">SVC</span> 时 CPU 会停下来，等你处理；</li>' +
        '<li><b>库函数</b>：没有 libc。<span class="mono">malloc</span>、<span class="mono">memcpy</span>、<span class="mono">strlen</span> 都不存在；</li>' +
        '<li><b>进程与线程</b>：没有调度、没有 TLS，连<b>栈</b>都要你自己 map 出来并设置 SP。</li>' +
        '</ul>' +
        T.note('ok', '✅ 但「什么都没有」恰恰是优点', '<p>正因为没有操作系统，环境的每一个变量都由你决定：<b>没有反调试</b>（没有 ptrace、没有 /proc 检查的真实语义）、<b>没有副作用</b>（不写文件、不发网络）、<b>完全可复现</b>（同一份输入永远同一份输出）。再叠加 <span class="mono">UC_HOOK_CODE</span> 这种逐指令级别的观测能力，你得到的是一个<b>可以单步、可以 trace、可以随时暂停的确定性沙盒</b>。</p>') +
        '<p>这也是为什么 Unicorn 被大量嵌进各类工具链：轻量、可嵌入、API 小。代价就是——<b>环境要你自己搭</b>。</p>',
      quiz: {
        id: 'q7-1', chapter: 7, answer: 1,
        stem: '关于 Capstone / Unicorn / Keystone 三者的分工，下列说法<b>正确</b>的是？',
        options: [
          { t: 'Unicorn 既能模拟 CPU，也能模拟 Android 系统与 libc', why: '错。Unicorn 只做 CPU 模拟，内存、系统调用、库函数都要自己补——这正是本章后半段的主题。' },
          { t: 'Capstone 把机器码翻译成汇编文本，Keystone 反过来把汇编文本变成机器码', why: '对。两者方向相反，分别对应「反汇编」与「汇编」，Unicorn 才是负责执行的那个。' },
          { t: 'Keystone 是 Unicorn 的加速后端，可以替换 TCG', why: '错。Keystone 是汇编器，与执行无关。Unicorn 的加速后端是另一类东西（unidbg 支持 dynarmic 等后端，见 21.7）。' },
          { t: 'Capstone 基于 QEMU 的 TCG 实现', why: '错。基于 QEMU TCG 的是 Unicorn。Capstone 是一个独立的反汇编框架。' }
        ],
        explain: '<b>记法：</b>把三个工具想成一条流水线 —— <b>Keystone 造指令</b>（文本→字节）、<b>Unicorn 跑指令</b>（CPU）、<b>Capstone 读指令</b>（字节→文本）。写 Unicorn 脚本时最典型的组合是：用 Keystone 现场拼几行桩指令，用 Unicorn 执行，再用 Capstone 在 hook 里把每条指令反汇编打印出来做 trace。三者常一起出现，所以容易被当成一回事。'
      }
    },
    /* ================= 21.3 ================= */
    {
      h: '21.3',
      title: 'Unicorn 七步：亲手跑一段 ARM64 代码',
      html: '<p>Unicorn 的 API 小到可以背下来，核心就七步。下面这段是<b>标准用法</b>，一步步走完，你对「模拟执行」的手感就建立了。</p>' +
        T.code('<span class="k">from</span> unicorn <span class="k">import</span> *\n<span class="k">from</span> unicorn.arm64_const <span class="k">import</span> *\n\nmu = Uc(UC_ARCH_ARM64, UC_MODE_ARM)           <span class="c"># 1. 创建模拟器，指定架构</span>\nmu.mem_map(<span class="n">0x1000</span>, <span class="n">0x1000</span>)                     <span class="c"># 2. 映射内存（地址, 大小，需页对齐）</span>\nmu.mem_write(<span class="n">0x1000</span>, code_bytes)               <span class="c"># 3. 写入要执行的机器码</span>\nmu.reg_write(UC_ARM64_REG_X0, <span class="n">0x1234</span>)          <span class="c"># 4. 设置寄存器（传参）</span>\nmu.hook_add(UC_HOOK_CODE, hook_code)          <span class="c"># 5. 注册钩子（可选，用于 trace）</span>\nmu.emu_start(<span class="n">0x1000</span>, <span class="n">0x1000</span> + len(code_bytes)) <span class="c"># 6. 开始执行（起始地址, 结束地址）</span>\nresult = mu.reg_read(UC_ARM64_REG_X0)         <span class="c"># 7. 读返回值</span>') +
        T.note('warn', '⚠️ 页面大小是硬约束', '<p><span class="mono">mem_map</span> 的地址与大小都必须是<b>页对齐</b>的（通常 0x1000）。写 <span class="mono">mem_map(0x1001, 0x800)</span> 会直接抛异常。这是新手脚本第一个卡住的地方。</p>') +
        '<p>把这段代码拆开，逐步看内存和寄存器是怎么变化的：</p>',
      stepper: {
        title: 'Unicorn 模拟执行完整流程',
        lines: [
          {
            code: '<span class="k">from</span> unicorn <span class="k">import</span> *\n<span class="k">from</span> unicorn.arm64_const <span class="k">import</span> *',
            note: '<b>导入两个模块。</b><span class="mono">unicorn</span> 是通用 API（<span class="mono">Uc</span>、<span class="mono">UC_ARCH_*</span>、hook 常量），<span class="mono">unicorn.arm64_const</span> 是架构专属常量（<span class="mono">UC_ARM64_REG_X0</span> 这类寄存器编号）。<b>换架构就要换对应的 const 模块</b>，这是最常见的抄代码翻车点。',
            state: { '模拟器': '未创建', '内存': '空地址空间', '架构常量': 'arm64_const 已载入' }
          },
          {
            code: 'mu = Uc(UC_ARCH_ARM64, UC_MODE_ARM)',
            note: '<b>创建模拟器并指定架构。</b>第一个参数是 CPU 架构（这里 ARM64），第二个是模式。此刻你得到的是一颗<b>刚上电、什么都没接</b>的 CPU：没有内存、没有栈、没有任何库。',
            state: { '模拟器': 'Uc 实例已创建', '架构': 'ARM64 / ARM 模式', '内存': '空地址空间（任何访问都会失败）' }
          },
          {
            code: 'mu.mem_map(<span class="n">0x1000</span>, <span class="n">0x1000</span>)',
            note: '<b>映射一页内存。</b>参数是「起始地址, 大小」，两个都必须页对齐。这一步对应操作系统的 <span class="mono">mmap</span> —— 但在这里，<b>你就是内核</b>，映射表由你说了算。真实脚本里通常要 map 好几段：代码段、数据段、栈、以及堆。',
            state: { '模拟器': 'Uc 实例', '内存': '0x1000–0x1FFF 已映射（RWX）', '未映射区': '访问即崩' },
            mem: '地址        内容\n0x00001000  ?? ?? ?? ?? ?? ?? ?? ??\n0x00001008  ?? ?? ?? ?? ?? ?? ?? ??\n...\n0x00001FF8  ?? ?? ?? ?? ?? ?? ?? ??\n（整页可读写执行，初始全 0）'
          },
          {
            code: 'mu.mem_write(<span class="n">0x1000</span>, code_bytes)',
            note: '<b>把机器码写进去。</b><span class="mono">code_bytes</span> 必须是<b>真实的机器码字节</b>，不是汇编文本。来源通常有三处：从 so 里按偏移抠出来的函数体、用 Keystone 现场汇编出来的桩代码、或者手工拼的几字节。',
            state: { '模拟器': 'Uc 实例', '内存': '0x1000 起已写入 ' + 'N 字节指令', '指令来源': 'so 抠出 / Keystone 汇编' },
            mem: '地址        内容（示例：ARM64 指令）\n0x00001000  E0 03 00 AA   mov x0, x0\n0x00001004  00 04 00 91   add x0, x0, #1\n0x00001008  C0 03 5F D6   ret\n0x0000100C  00 00 00 00   （填充）'
          },
          {
            code: 'mu.reg_write(UC_ARM64_REG_X0, <span class="n">0x1234</span>)',
            note: '<b>设置寄存器，也就是传参。</b>ARM64 的函数调用约定里，前 8 个整型参数依次放 <span class="mono">X0–X7</span>；如果是 JNI 函数，<span class="mono">X0</span> 是 <span class="mono">JNIEnv*</span>、<span class="mono">X1</span> 是 <span class="mono">jobject/jclass</span>，<b>真正的业务参数从 X2 开始</b>。这一步设错，后面全白跑。',
            state: { 'X0': '0x00001234（第一个参数）', 'X1': '0x0', 'SP': '未设置 ⚠️', 'PC': '未设置' }
          },
          {
            code: '<span class="c"># 别忘了栈：mu.reg_write(UC_ARM64_REG_SP, stack_top)</span>',
            note: '<b>补上栈指针。</b>真实函数几乎一定会用栈（保存寄存器、开局部变量）。如果你只 map 了代码页却没设置 <span class="mono">SP</span>，函数第一条压栈指令就会写到未映射地址，<b>立刻崩</b>。所以实际脚本里还要 <span class="mono">mem_map</span> 一段栈空间并把 <span class="mono">SP</span> 指向它的高地址端（ARM 栈向低地址生长）。',
            state: { 'X0': '0x00001234', 'SP': '0x200000（栈顶，向下生长）', '栈内存': '0x1F0000–0x1FFFFF 已映射' },
            mem: '栈区（向低地址生长）\n0x001FF000  ┌─────────────┐ ← SP 初始指向高地址\n0x001FF800  │  未使用      │\n0x00200000  └─────────────┘ 栈顶'
          },
          {
            code: 'mu.hook_add(UC_HOOK_CODE, hook_code)',
            note: '<b>注册钩子（可选但强烈建议）。</b><span class="mono">UC_HOOK_CODE</span> 会在<b>每一条指令</b>执行前回调你的 <span class="mono">hook_code(mu, address, size, user_data)</span>。在这里用 Capstone 把 <span class="mono">address</span> 处的字节反汇编打印出来，你就有了一份完整的执行 trace —— 这是模拟执行相对真机调试的<b>最大优势</b>：trace 干净、完整、无遗漏。',
            state: { 'hooks': 'UC_HOOK_CODE 已注册', '回调参数': '(mu, address, size, user_data)', 'CPU': '尚未开始执行' }
          },
          {
            code: 'mu.emu_start(<span class="n">0x1000</span>, <span class="n">0x1000</span> + len(code_bytes))',
            note: '<b>开始执行。</b>参数是「起始地址, 结束地址」：PC 从 0x1000 开始，执行到 0x100C 时<b>主动停下</b>（等价于一个临时的断点，不用真写 <span class="mono">ret</span> 也能截断）。如果中途跳进了未映射内存或碰到没处理的 <span class="mono">SVC</span>，<span class="mono">emu_start</span> 会抛异常 —— 补环境的需求往往就是在这一刻暴露出来的。',
            state: { 'PC': '0x1000 → 0x100C', 'X0': '0x00001235（执行后）', '执行结果': '正常结束' }
          },
          {
            code: 'result = mu.reg_read(UC_ARM64_REG_X0)',
            note: '<b>读返回值。</b>ARM64 用 <span class="mono">X0</span> 返回整型/指针结果，浮点用 <span class="mono">D0</span>。如果被调用函数返回的是<b>结构体或通过指针输出</b>（<span class="mono">void f(char* out)</span> 这类），那就不是读寄存器而是 <span class="mono">mem_read</span> 读内存。逆向里后者极常见：加密函数十有八九是「传输入缓冲区 + 传输出缓冲区 + 长度」。',
            state: { '返回值 X0': '0x00001235', '若要取缓冲区': 'mem_read(out_ptr, length)' }
          },
          {
            code: '<span class="c"># Thumb 代码：地址最低位 +1，或用 UC_MODE_THUMB</span>',
            note: '<b>ARM32 的坑。</b>ARM 处理器有两种指令集（ARM / Thumb），切换靠地址最低位。Unicorn 里模拟 Thumb 代码，要么把起始地址<b>最低位加 1</b>（如 <span class="mono">0x1001</span>），要么用 <span class="mono">UC_MODE_THUMB</span> 模式。写错了会解码成一堆乱码指令，或者跑到一半莫名崩 —— 从 so 里抠 ARM32 函数时，<b>先确认它是 ARM 还是 Thumb</b>。',
            state: { 'ARM 模式': '地址 0x1000（最低位 0）', 'Thumb 模式': '地址 0x1001（最低位 1）' }
          }
        ]
      },
      after: T.note('key', '🔑 复盘这七步', '<p>你会发现：<b>七步里有四步都在「造环境」</b>——map 内存、设寄存器、设栈、处理异常，真正「跑」只有 <span class="mono">emu_start</span> 一行。这个比例不是巧合，它精确预告了后面所有章节的主题：<b>模拟执行的工作量，九成在环境，一成在执行。</b></p>'),
      quiz: {
        id: 'q7-2', chapter: 7, answer: 2,
        stem: '你用 Unicorn 调一个从 so 里抠出来的 ARM64 加密函数，<span class="mono">mem_map</span> 了代码页、写入了机器码、设好了 X0–X3 参数，<span class="mono">emu_start</span> 后第一条指令就崩了。最可能的原因是？',
        options: [
          { t: '机器码抠错了，字节不对', why: '有可能，但「第一条指令就崩」这种现象更典型的成因是环境缺失。字节错误通常表现为解码出奇怪的指令或中途跑飞，而不是一启动就访问非法内存。' },
          { t: 'X0 参数值设错了', why: '参数错一般不会立刻崩，而是算出错误结果，或者在函数后面才因为指针解引用而崩。' },
          { t: '没有映射栈空间、没有设置 SP，函数第一条压栈指令就写到了未映射地址', why: '对。真实函数开头几乎都会保存寄存器和开栈帧，SP 没设置或指向未映射区，第一条 stp/str 就触发非法内存访问。' },
          { t: 'Unicorn 默认不允许执行内存中的数据，需要额外调用 mem_protect', why: '错。Unicorn 的 mem_map 默认映射就是可读写执行的，不需要额外开权限。' }
        ],
        explain: '<b>「一启动就崩」几乎永远是环境问题，不是算法问题。</b>诊断顺序：① SP 设了吗？指向的内存 map 了吗？② 函数用到的参数指针（X1/X2 指向的缓冲区）map 了吗？③ 函数会不会立刻调用外部函数（malloc / memcpy / JNI 接口）？<br>所以正确习惯是：<b>先挂 UC_HOOK_CODE 打开 trace 再跑</b>。崩溃前最后几条指令会直接告诉你它想访问哪里——是压栈失败、还是跳去了一个没实现的导入函数地址。没有 trace 的模拟执行，就是在盲人摸象。'
      }
    },

    /* ================= 21.4 ================= */
    {
      h: '21.4',
      title: 'JNIEnv 到底是什么：一张函数指针数组',
      html: '<p>要补环境，先得看清敌人。<span class="term" data-def="Java Native Interface，Java 层与 native 层之间的调用规范。">JNI</span> 里最核心的两个对象是 <span class="mono">JNIEnv*</span> 和 <span class="mono">JavaVM*</span>，而它们<b>都不是结构体，是函数表</b>。这是本章最值得先建立的一个直觉。</p>' +
        T.intuition('直觉模型 · 电话总机', '<p>把 <span class="mono">JNIEnv*</span> 想成一本<b>电话簿</b>：书本身不干活，它只是一页一页写着「要找 FindClass，拨第 6 个号」。native 代码拿到这本电话簿，按固定位置拨号，接电话的<b>究竟是谁</b>它并不关心。</p><p>真机上，接电话的是 ART 虚拟机；模拟环境里，接电话的就是<b>你自己写的桩函数</b>。JNI 的设计从第一天起就为「换总机」留好了位置——这也是 unidbg 能成立的根本原因。</p>') +
        '<p>下面这张图把真实环境与模拟环境的差别摊开：</p>',
      stage: {
        title: 'JNIEnv 函数表结构：真实环境 vs 模拟环境',
        speed: 1800,
        render:
          '<div class="flow-row" style="align-items:flex-start;gap:14px">' +
            '<div class="flow-col" style="gap:8px;min-width:190px">' +
              '<div class="blk" id="envptr">JNIEnv*<br><span class="small">二级指针</span></div>' +
              '<div class="arrow">↓</div>' +
              '<div class="blk" id="envstruct">JNIEnv 结构体<br><span class="small">只有一个成员</span></div>' +
              '<div class="arrow">↓</div>' +
              '<div class="blk" id="fnptr">functions<br><span class="small">函数指针数组</span></div>' +
            '</div>' +
            '<div class="flow-col" style="gap:6px;min-width:300px">' +
              '<div class="blk" id="s4">[4] GetVersion</div>' +
              '<div class="blk" id="s6">[6] FindClass</div>' +
              '<div class="blk" id="s31">[31] GetMethodID</div>' +
              '<div class="blk" id="s34">[34] NewObject</div>' +
              '<div class="blk" id="s36">[36] CallObjectMethod</div>' +
              '<div class="blk" id="s167">[167] GetStringUTFChars</div>' +
              '<div class="blk" id="sdots">...</div>' +
            '</div>' +
            '<div class="flow-col" style="gap:8px;min-width:240px">' +
              '<div class="blk" id="real">真实环境<br><span class="small">指针指向 ART 实现</span></div>' +
              '<div class="blk" id="fake">模拟环境<br><span class="small">指针指向你的桩函数</span></div>' +
            '</div>' +
          '</div>' +
          '<div class="regs" style="margin-top:12px">' +
            '<div class="reg" id="r0"><b>X0</b> = JNIEnv*</div>' +
            '<div class="reg" id="r1"><b>X1</b> = jclass / jobject</div>' +
            '<div class="reg" id="r2"><b>X2</b> = arg0</div>' +
            '<div class="reg" id="r3"><b>X3</b> = arg1</div>' +
          '</div>' +
          '<div id="verdict" class="note" style="margin-top:12px"><div class="note-h">结论</div><p>native 代码只认<b>位置</b>，不认<b>实现</b>——所以函数表可以被整体替换。</p></div>',
        reset: () => {
          ['envptr', 'envstruct', 'fnptr', 'real', 'fake', 's4', 's6', 's31', 's34', 's36', 's167'].forEach(id => S(id, ''));
          S('sdots', 'done');
          ['r0', 'r1', 'r2', 'r3'].forEach(id => CLS(id, 'reg'));
          CLS('verdict', 'note');
          SET('verdict', '<div class="note-h">结论</div><p>native 代码只认<b>位置</b>，不认<b>实现</b>——所以函数表可以被整体替换。</p>');
        },
        steps: [
          { run: () => { S('envptr', 'active'); S('envstruct', 'active'); S('fnptr', 'active'); },
            note: '<b>第一步：认清 <span class="mono">JNIEnv*</span> 的真身。</b>它是指向「结构体」的指针，而这个结构体<b>只有一个成员</b>：一个指向函数指针数组的指针。所以 <span class="mono">JNIEnv*</span> 实际上是<b>二级指针</b>。C 代码里 <span class="mono">(*env)-&gt;FindClass(env, ...)</span> 这个写法，两次解引用就是从这来的——第一次拿到结构体，第二次从数组里取出第 6 个函数指针。' },
          { run: () => { S('s4', 'active'); S('s6', 'active'); S('s31', 'active'); },
            note: '<b>第二步：数组的每个槽位固定对应一个 JNI 函数。</b><span class="mono">[4] GetVersion</span>、<span class="mono">[6] FindClass</span>、<span class="mono">[31] GetMethodID</span>……<b>槽位编号是 JNI 规范写死的</b>，不同 Android 版本、不同架构都一样。正因为固定，native 代码编译后不再需要符号名，直接按偏移取指针——这既是 JNI 高效的原因，也是它可被整体伪造的原因。' },
          { run: () => { S('s34', 'active'); S('s36', 'active'); S('s167', 'active'); S('sdots', ''); },
            note: '<b>第三步：继续往下排。</b><span class="mono">[34] NewObject</span>、<span class="mono">[36] CallObjectMethod</span>、<span class="mono">[167] GetStringUTFChars</span>……整张表有<b>两百多个槽位</b>（不同 JNI 版本数量不同）。<span class="pill warn">具体索引值以实际 JNI 头文件为准</span> 你不需要背，但要知道<b>每一个槽位都得有个能接的电话</b>：so 调了哪个，你就得在哪个位置放上实现，否则跳到野指针直接崩。' },
          { run: () => { S('real', 'hot'); },
            note: '<b>第四步（真实环境）：槽位指向 ART 的实现。</b>App 跑在 Android 上时，VM 在 <span class="mono">JNI_OnLoad</span> 之前就把这张表填好了，每个指针都指向 ART 里真正的 JNI 实现。<span class="mono">FindClass</span> 去 dex 里找类，<span class="mono">GetMethodID</span> 去解析方法签名，<span class="mono">CallObjectMethod</span> 真正进解释器/JIT 执行 Java 代码。native 代码对这一切毫无感知。' },
          { run: () => { S('real', 'done'); S('fake', 'cool'); },
            note: '<b>第五步（模拟环境）：把整张表换成你自己的桩。</b>你 <span class="mono">mem_map</span> 一段内存当作这张数组，把每个用得到的槽位写成<b>你实现的桩函数地址</b>。于是 <span class="mono">FindClass</span> 变成「在你自己维护的假类表里查一下」，<span class="mono">CallObjectMethod</span> 变成「按照预设规则返回一个值」。<b>JNI 调用被降维成了本地函数调用。</b>' },
          { run: () => { CLS('r0', 'reg changed'); },
            note: '<b>第六步：调用时的寄存器布局。</b>JNI 函数虽然写在 C 里，但 ABI 上<b>第一个参数永远是 <span class="mono">JNIEnv*</span></b>（ARM64 在 <span class="mono">X0</span>，ARM32 在 <span class="mono">R0</span>），第二个是 <span class="mono">jclass</span>（静态方法）或 <span class="mono">jobject</span>（实例方法）。所以在 Unicorn 里调一个 JNI 函数前，你必须先把「假的 JNIEnv 指针」写进 X0——<b>忘了这一步是新手最经典的崩溃原因</b>。' },
          { run: () => { CLS('r1', 'reg changed'); CLS('r2', 'reg changed'); CLS('r3', 'reg changed'); },
            note: '<b>第七步：业务参数的偏移。</b>因为 X0/X1 被 JNIEnv 和 jclass 占用，<b>真正的业务参数从第三个位置开始</b>。这直接决定你 <span class="mono">reg_write</span> 时该往哪个寄存器写什么。<span class="pill warn">ARM32 上要特别注意：long/double 会占两个寄存器位</span>，算错一个位置，参数就整体错位。' },
          { run: () => {
              S('fake', 'done'); S('envptr', 'done'); S('envstruct', 'done'); S('fnptr', 'done');
              S('s4', 'done'); S('s6', 'done'); S('s31', 'done'); S('s34', 'done'); S('s36', 'done'); S('s167', 'done');
              CLS('verdict', 'note ok');
              SET('verdict', '<div class="note-h">✅ 关键结论</div><p><b>JNIEnv 是一张可以被整体替换的函数表</b>。真机上它接 ART，模拟环境里它接你的桩。unidbg 做的核心工作，本质上就是<b>替你造了这张表，并且把它接在一个用 Java 写的假虚拟机上</b>。</p>');
            },
            note: '<b>第八步：把这条结论记住。</b>「JNIEnv 可整体替换」是模拟执行能成立的理论基础。同理，<span class="mono">JavaVM*</span> 也是一张函数表（<span class="mono">GetEnv</span>、<span class="mono">AttachCurrentThread</span> 等），它作为 <span class="mono">JNI_OnLoad</span> 的<b>第一个参数</b>传进来——所以想调 <span class="mono">JNI_OnLoad</span>，你就得先伪造一个 <span class="mono">JavaVM*</span>。' }
        ]
      },
      after: T.note('key', '🔑 这对逆向实战有什么用', '<p>看 so 里一个有 JNI 回调的函数时，你会立刻知道该<b>在哪里下钩子</b>：凡是走 <span class="mono">(*env)-&gt;</span> 的调用，都是「环境」范畴，跟算法本身无关。真正的加密逻辑往往藏在那些<b>不碰 JNIEnv、纯算数、纯内存操作</b>的函数里。会区分这两类代码，你就知道哪些能模拟、哪些必须补。</p>')
    },

    /* ================= 21.5 ================= */
    {
      h: '21.5',
      title: '补环境全景：so 的依赖图谱与补全代价',
      html: T.note('bad', '⚠️ 本章真正的难点在这里', '<p>真实 so 里的函数<b>不是孤立的</b>。它会调 <span class="mono">malloc</span>、<span class="mono">memcpy</span>、<span class="mono">strlen</span>，会访问 <span class="mono">JNIEnv</span> 的函数表，会执行 <span class="mono">SVC</span> 系统调用，会读 <span class="mono">/proc/self/status</span>。而 Unicorn 里<b>什么都没有</b>——这些调用会跳到未映射内存，程序直接崩。</p><p><b>「补环境」就是把这些依赖一个个手工实现。</b>下面这张图，画的就是一个 so 的全部外部依赖，以及每补一项它能往前走多远。</p>') +
        '<p>按依赖的<b>性质</b>分，需要补的东西一共五类。<span class="pill acc">① ② 属于「系统层」</span> <span class="pill acc">③ ④ 属于「虚拟机层」</span> <span class="pill acc">⑤ 属于「Java 业务层」</span>，越往后越难补，因为越往后越接近目标的业务逻辑。</p>',
      stage: {
        title: '补环境全景：五类依赖，逐项补齐，看 so 能走多远',
        speed: 2000,
        render:
          '<div class="flow-col" style="gap:12px">' +
            '<div class="flow-row" style="justify-content:center"><div class="blk" id="so">libtarget.so<br><span class="small">目标：native 加密函数</span></div></div>' +
            '<div class="flow-row" style="flex-wrap:wrap;justify-content:center;gap:10px">' +
              '<div class="blk" id="dl">① libc 库函数<br><span class="small">malloc / memcpy / strlen</span></div>' +
              '<div class="blk" id="ds">② SVC 系统调用<br><span class="small">open / read / clock_gettime</span></div>' +
              '<div class="blk" id="de">③ JNIEnv 函数表<br><span class="small">FindClass / CallObjectMethod</span></div>' +
              '<div class="blk" id="dv">④ JavaVM<br><span class="small">GetEnv / AttachCurrentThread</span></div>' +
              '<div class="blk" id="dj">⑤ Java 层类与方法<br><span class="small">native 回调 Java</span></div>' +
            '</div>' +
            '<div class="flow-row" style="justify-content:center;gap:16px">' +
              '<span class="pill bad" id="lg-bad">未补：跳到野地址 → 崩</span>' +
              '<span class="pill ok" id="lg-ok">已补：接上你的实现</span>' +
              '<span class="pill acc" id="cnt">进度 0 / 5</span>' +
            '</div>' +
            '<div class="note" id="prog"><div class="note-h">运行进度</div><p>so 已载入 PC，但一次调用都还没发生。</p></div>' +
          '</div>',
        reset: () => {
          ['dl', 'ds', 'de', 'dv', 'dj'].forEach(id => S(id, 'hot'));
          S('so', 'active');
          CLS('lg-bad', 'pill bad'); CLS('lg-ok', 'pill ok'); CLS('cnt', 'pill acc');
          SET('cnt', '进度 0 / 5');
          CLS('prog', 'note');
          SET('prog', '<div class="note-h">运行进度</div><p>so 已载入 PC，但一次调用都还没发生。</p>');
        },
        steps: [
          { run: () => { S('so', 'active'); ['dl', 'ds', 'de', 'dv', 'dj'].forEach(id => S(id, 'hot')); },
            note: '<b>起点：把 so 加载进内存，调用目标函数。</b>五类依赖<b>全部标红</b>——意味着在 Unicorn 里它们对应的地址空间<b>根本没有映射</b>。函数只要碰到任意一个，立刻访问非法内存并崩溃。注意：这时候「算法」其实一行都没跑错，跑错的是<b>环境</b>。' },
          { run: () => { S('dl', 'cool'); SET('cnt', '进度 1 / 5'); CLS('prog', 'note ok');
              SET('prog', '<div class="note-h">✅ 补①之后</div><p>malloc / memcpy / strlen 可用。so 能完成<b>内存分配与拷贝</b>，能走过函数开头的一大段准备代码——然后卡在第一次 SVC。</p>'); },
            note: '<b>补① 库函数。</b>做法：在加载 so 时把导入函数「截胡」——要么在 <span class="mono">UC_HOOK_CODE</span> 里对这几个地址单独拦截，要么直接<b>改写 GOT 表</b>让它们指向你自己的实现。<span class="pill warn">注意 malloc 不是随便返回个地址就行</span>：你实现的 malloc 必须真的从一个你自己管理的堆里分配，保证后续 memcpy / free 都对得上，否则会出现「写进去的数据读出来变了」这种极难查的问题。' },
          { run: () => { S('ds', 'cool'); SET('cnt', '进度 2 / 5');
              SET('prog', '<div class="note-h">✅ 补①②之后</div><p>系统调用可用。so 能取时间、能读 <span class="mono">/proc</span>、能完成入口处的反调试检查——<b>然后卡在第一次 JNI 调用</b>。</p>'); },
            note: '<b>补② 系统调用（SVC）。</b>在 <span class="mono">UC_HOOK_INTR</span> 里拦截，根据系统调用号分发：<b>AArch64 的系统调用号在 <span class="mono">X8</span></b>，<b>ARM32 在 <span class="mono">R7</span></b>。你不需要实现全部几百个 syscall——按 trace 里实际出现的补就行。典型需要的是 <span class="mono">open</span> / <span class="mono">read</span> / <span class="mono">write</span> / <span class="mono">mmap</span> / <span class="mono">gettimeofday</span> / <span class="mono">clock_gettime</span>。' },
          { run: () => { S('de', 'cool'); SET('cnt', '进度 3 / 5');
              SET('prog', '<div class="note-h">✅ 补①②③之后</div><p>JNIEnv 表接上了。so 能在<b>不回调 Java</b>的情况下完成大部分纯计算——往往走到这里，加密结果就已经能出来了。</p>'); },
            note: '<b>补③ JNIEnv 函数表。</b>造一张函数指针数组，把 <span class="mono">FindClass</span>、<span class="mono">GetMethodID</span>、<span class="mono">CallObjectMethod</span>、<span class="mono">GetStringUTFChars</span> 等指向自己的桩函数。<b>好消息是：只有被真正调用的槽位才需要认真实现</b>，其余的放一个「调用即报错」的哨兵桩，能立刻告诉你「哦，原来它还用了这个」。' },
          { run: () => { S('dv', 'cool'); SET('cnt', '进度 4 / 5');
              SET('prog', '<div class="note-h">✅ 补①②③④之后</div><p>JavaVM 就位，<span class="mono">JNI_OnLoad</span> 可以被正常调用了——so 的初始化逻辑（注册 native 方法、缓存全局引用）终于能跑完。</p>'); },
            note: '<b>补④ JavaVM。</b><span class="mono">JNI_OnLoad(JavaVM* vm, void* reserved)</span> 的第一个参数就是它，同样是一张函数表（<span class="mono">GetEnv</span>、<span class="mono">AttachCurrentThread</span>…）。<b>很多 so 的关键初始化都在 <span class="mono">JNI_OnLoad</span> 里</b>：注册 native 方法、做字符串解密、初始化全局状态。跳过它直接调目标函数，结果经常是错的——因为 so 还没「热身」。' },
          { run: () => { S('dj', 'cool'); SET('cnt', '进度 5 / 5'); CLS('prog', 'note ok');
              SET('prog', '<div class="note-h">🎉 全部补齐</div><p>so 的加密函数完整跑通，输出与真机一致。代价：你写了库函数、syscall、JNIEnv、JavaVM、Java 假类<b>五套环境</b>。</p>'); },
            note: '<b>补⑤ Java 层类与方法。</b>最难的一类。当 native 代码<b>回调 Java 层</b>（典型如调用 <span class="mono">String.getBytes</span>、<span class="mono">MessageDigest.getInstance</span>，或者把中间结果塞进一个 Java 对象里再由 Java 层做二次处理）时，你必须<b>伪造这些类和方法</b>：unidbg 提供 <span class="mono">vm.resolveClass()</span> 这类 API 让你凭空造出一个假 Java 类。难在哪？难在你要<b>猜出它的行为</b>——而它的行为可能正是你要还原的算法的一部分。' },
          { run: () => { S('dl', 'hot'); S('ds', 'hot'); S('de', 'hot'); S('dv', 'hot'); S('dj', 'hot'); S('so', 'hot');
              SET('cnt', '成本爆表');
              CLS('prog', 'note bad');
              SET('prog', '<div class="note-h">⚠️ 换一个目标，全部重来</div><p>下一个 so：用了 <b>ollvm 混淆</b>、<b>大量 JNI 反射回调</b>、<b>自定义 syscall 混淆</b>。第⑤类依赖从「几个」变成「几十个」，且每个都要靠猜。<b>手工补环境的边际成本在这里失控</b>。</p>'); },
            note: '<b>反面：当依赖复杂度失控。</b>这正是 <b>unidbg 存在的理由</b>——它把①②③④这四类<b>通用</b>依赖一次性做好了（内置 ELF 加载器、syscall 模拟、JNI/JavaVM 实现、以及一个用 Java 写的假虚拟机），你只需要集中精力对付第⑤类<b>与目标业务相关的</b>部分。<b>补环境成本决定工具选择</b>：依赖简单，Unicorn 裸写就够；依赖复杂，必须上 unidbg。' }
        ]
      },
      after: T.note('key', '🔑 补环境的三条判断准则', '<ol><li><b>按需补，不要预补。</b>不要一上来就把 syscall 全实现一遍——先 trace，看它到底调了什么。绝大多数 so 实际只用到个位数的依赖。</li><li><b>保真度够用就行。</b>时间函数返回一个固定值往往就够（只要算法不真的依赖时间差）；<span class="mono">/proc/self/status</span> 返回一份「正常手机」的假内容就行。追求 100% 内核语义是过度工程。</li><li><b>补不动的依赖就是边界。</b>如果第⑤类依赖复杂到你要重新实现半个 App 的业务逻辑，那<b>正确的决定不是继续补，而是换 Frida RPC</b>。认得出边界，比会写代码更重要。</li></ol>')
    },

    /* ================= 21.5L 动手实验 ================= */
    {
      h: '21.5L', title: '动手实验：给一份导入表分类，判断补环境难度',
      html:
        '<p>补环境的第一步不是写代码，而是<b>看导入表、估算工作量</b>。这个判断做对了，' +
        '你能在半小时内决定"这个 so 值不值得用 unidbg 跑"。</p>',
      lab: {
        title: '实验：导入表依赖分类',
        goal: '目标：估算补环境难度',
        intro:
          '<p>下面是一份从目标 so 里 dump 出的<b>导入函数清单</b>（<code>readelf -d</code> 或 IDA 的 Imports 窗口可见）。</p>' +
          '<pre style="margin:10px 0;font-size:12.5px"><code>' +
          'malloc  memcpy  memset  strlen  strcmp\n' +
          'open    read    close   mmap    munmap\n' +
          'gettimeofday      __android_log_print\n' +
          'pthread_create    pthread_mutex_lock\n' +
          'GetEnv  FindClass  GetMethodID  CallObjectMethod\n' +
          'GetStringUTFChars  NewStringUTF  RegisterNatives</code></pre>' +
          '<p><b>任务：把它们分类，然后判断这个 so 的补环境难度。</b></p>',
        inputs: [
          { key: 'jni', label: '① 其中有几个函数属于「JNI 接口」这一类？（填数字）', hint: '含 JavaVM 侧的调用', ph: '例如 7' },
          { key: 'verdict', label: '② 结论：这个 so 用 unidbg 补环境，难度如何？为什么？', hint: '提示：看 JNI 类占比', ph: '难度……因为……', type: 'textarea', rows: 3 }
        ],
        runLabel: '🔍 分类并评估',
        run: (v) => {
          const L = window.LABX;
          const names = ['malloc','memcpy','memset','strlen','strcmp',
            'open','read','close','mmap','munmap',
            'gettimeofday','__android_log_print',
            'pthread_create','pthread_mutex_lock',
            'GetEnv','FindClass','GetMethodID','CallObjectMethod',
            'GetStringUTFChars','NewStringUTF','RegisterNatives'];

          const groups = {};
          for (const n of names) {
            const r = L.classifyImport(n);
            (groups[r.cat] = groups[r.cat] || []).push({ n, how: r.how });
          }
          const jni = groups['★ JNI 接口'] || [];

          let html = '<table class="lab-tbl"><tr><th>分类</th><th>数量</th><th>函数</th><th>怎么补</th></tr>';
          for (const [cat, items] of Object.entries(groups)) {
            html += '<tr class="' + (cat.startsWith('★') ? 'diff' : 'same') + '">'
              + '<td>' + cat + '</td><td>' + items.length + '</td>'
              + '<td style="font-size:11.5px">' + items.map(x => x.n).join(' ') + '</td>'
              + '<td style="font-size:12px">' + items[0].how + '</td></tr>';
          }
          html += '</table>';

          html += '<div class="lab-kv">'
            + '<span>导入总数 <b>' + names.length + '</b></span>'
            + '<span>JNI 接口 <b>' + jni.length + '</b></span>'
            + '<span>JNI 占比 <b>' + Math.round(jni.length / names.length * 100) + '%</b></span></div>';

          // 判定
          const ratio = jni.length / names.length;
          let level, cls, advice;
          if (ratio === 0) {
            level = '★★☆☆☆ 简单'; cls = 'pass';
            advice = '没有 JNI 回调，说明这是一个"纯计算"的 so。这类最舒服：只要补几个 libc 函数和 syscall，用裸 Unicorn 就能跑起来。';
          } else if (ratio < 0.25) {
            level = '★★★☆☆ 中等'; cls = 'pass';
            advice = 'JNI 调用不多，但要造 JNIEnv 函数表。用 unidbg 比裸 Unicorn 划算得多——它已经把函数表和假虚拟机准备好了。';
          } else {
            level = '★★★★★ 麻烦'; cls = 'fail';
            advice = 'JNI 接口占比很高，说明 native 代码与 Java 层<b>深度耦合</b>——它会频繁回调 Java 层取数据、构造对象。'
              + '你要么把那些 Java 类和方法全部伪造出来（工作量大且易错），要么<b>换 Frida RPC</b>（直接在真机上跑，不用补任何环境）。';
          }
          html += '<div class="lab-msg ' + cls + '"><b>评估结论：' + level + '</b>'
            + '<div class="lab-note">' + advice + '</div></div>';

          // 用户答案校验
          const ans = parseInt(String(v.jni || '').trim(), 10);
          if (!isNaN(ans)) {
            const ok = ans === jni.length;
            html += '<div class="lab-msg ' + (ok ? 'pass' : 'fail') + '"><b>'
              + (ok ? '✅ JNI 计数正确（' + jni.length + ' 个）' : '❌ JNI 计数不对')
              + '</b><div class="lab-note">' + (ok
                ? '你正确识别出了：' + jni.map(x => x.n).join('、')
                : '正确答案是 <b>' + jni.length + '</b> 个：' + jni.map(x => x.n).join('、')
                  + '。<br><b>识别要点：</b>凡是以 <code>Get/New/Call/Find/Register</code> 开头、'
                  + '或明确是 <code>JavaVM</code> 侧（<code>GetEnv</code>）的，都走 JNI 函数表。')
              + '</div></div>';
          }
          return html;
        },
        expected: (v) => {
          const L = window.LABX;
          const jniCount = ['GetEnv','FindClass','GetMethodID','CallObjectMethod',
            'GetStringUTFChars','NewStringUTF','RegisterNatives']
            .filter(n => L.classifyImport(n).cat.startsWith('★')).length;
          const ans = parseInt(String(v.jni || '').trim(), 10);
          const ok = ans === jniCount;
          return {
            ok,
            detail: ok
              ? '<b>完全正确。</b>这 7 个都走 JNI 函数表，占比 ' + Math.round(jniCount / 21 * 100) +
                '% —— 这个 so <b>与 Java 层耦合很深</b>，补环境成本高。<br>' +
                '<b>工程判断：优先考虑 Frida RPC</b>，而不是硬啃 unidbg 补环境。'
              : '再数一遍。JNI 类一共 <b>' + jniCount + '</b> 个：' +
                '<code>GetEnv</code>、<code>FindClass</code>、<code>GetMethodID</code>、' +
                '<code>CallObjectMethod</code>、<code>GetStringUTFChars</code>、<code>NewStringUTF</code>、' +
                '<code>RegisterNatives</code>。<br>' +
                '注意 <code>__android_log_print</code> 是 liblog 不是 JNI；' +
                '<code>pthread_*</code> 是线程原语。'
          };
        },
        showAnswer:
          '分类结果（共 21 个导入）：\n\n' +
          '  libc 库函数     5 个   malloc memcpy memset strlen strcmp\n' +
          '  文件 syscall    3 个   open read close\n' +
          '  内存 syscall    2 个   mmap munmap\n' +
          '  时间 syscall    1 个   gettimeofday\n' +
          '  liblog          1 个   __android_log_print\n' +
          '  pthread         2 个   pthread_create pthread_mutex_lock\n' +
          '  ★ JNI 接口      7 个   GetEnv FindClass GetMethodID CallObjectMethod\n' +
          '                        GetStringUTFChars NewStringUTF RegisterNatives\n\n' +
          '结论：JNI 占 7/21 ≈ 33%，属于【麻烦】级别。\n' +
          '建议：这个 so 与 Java 层深度耦合，补环境要伪造大量类与方法。\n' +
          '     优先用 Frida RPC 在真机上跑；除非必须脱离设备，才走 unidbg。',
        hint:
          'JNI 接口的识别特征：它们都是<b>通过函数表调用</b>的，名字以 ' +
          '<code>Get</code> / <code>New</code> / <code>Call</code> / <code>Find</code> / ' +
          '<code>Register</code> 开头。<br>' +
          '注意排除干扰项：<code>__android_log_print</code> 属于 liblog，' +
          '<code>pthread_*</code> 是线程库，它们都有现成的标准实现可替换。',
        after:
          T.note('key', '🔑 这个实验训练的是"先评估、再动手"',
            '<p style="margin-bottom:0">很多人在补环境上浪费大量时间，是因为<b>先动手后评估</b>——' +
            '写了一堆 syscall 桩，最后才发现真正麻烦的是 JNI 回调。<br>' +
            '正确顺序是：<b>① 看导入表 → ② 数 JNI 类占比 → ③ 决定用 unidbg 还是 Frida RPC。</b><br>' +
            '<span class="hit">这个判断只要五分钟，却能省下几天。</span></p>')
      }
    },

    /* ================= 21.6C 实战案例 ================= */
    {
      h: '21.6C', title: '实战案例：某商业加固的 Native Loader 与 VMP',
      case: {
        source: 'kanxue',
        title: '[原创]某商业级加固 Native Loader 与 VMP 解释器逆向分析实战',
        date: '2026-8-6',
        author: 'kudos5566',
        target: 'com.mobile.demo_target（梆梆 / Bangcle 系加固）',
        background:
          '<p>2026 年的一篇看雪原创帖。目标 App 包名 <code>com.mobile.demo_target</code>，用的是一套“某企业版”加固：' +
          '壳特征包名 <code>com.secneo.apkwrapper</code>，作者把 <code>libsmkernel</code> / <code>libbangcle_risk</code> / ' +
          '<code>libnllvm1623735669</code> 一并标注为 <b>Bangcle 系</b>。</p>' +
          '<p>APK 的 <code>lib/arm64-v8a/</code> 里一共塞了 <b>60 个 .so</b>，其中三件是主角：' +
          '<code>libdexjni_target.so</code>（Native 加密 loader，2,677,789 B）、<code>libDexHelper.so</code>（反篡改，627,610 B）、' +
          '<code>libantitrace.so</code>；此外还有 <code>libtongdun.so</code> 与 CFCA 国密四件套。</p>' +
          '<p>作者搭了<b>双环境</b>：真机侧是 SysTrace 定制 ROM（AOSP 10，内置 Dobby 注入 / SandHook-Xposed / ROM 打桩），' +
          '宿主机侧是 <b>unidbg</b>，并且<b>全程排除 Frida</b>。这篇帖子最有价值的地方不在“跑通了”，' +
          '而在于它把<b>一个真实加固在对抗模拟执行时做了什么</b>，以及<b>哪些地方作者也没能跑通</b>，都写清楚了。</p>',
        points: [
          '双环境开局：真机用 SysTrace 定制 ROM（AOSP 10，内置 Dobby 注入 / SandHook-Xposed / ROM 打桩）观察真实行为，宿主机用 <b>unidbg</b> 做可复现的模拟执行，<b>全程排除 Frida</b>。',
          'loader 结构：镜像 size <code>0x2F4150</code>，明文 stub 只有 <code>0x0000~0x2CA0</code>（≈11KB），<code>0x13090~0x2F4150</code> 是 2.85MB 加密 payload。',
          '三个关键函数：<code>sub_13F8</code>（主加载器 / 自定义 Dynamic Linker）、<code>sub_1184</code>（RC4）、<code>sub_CD0</code>（JNI_OnLoad 查找）。',
          'RC4 解密：256B S-box KSA + 16B key 循环 + PRGA 异或写回，每块 ≤ <code>0x40</code>，范围 <code>[0x4000,0x2E1E00)</code>。',
          'key 由 <code>sub_AC0</code> 的 <code>pread(fd,&amp;qword_13050,0x14,0x2E1E00)</code> 从<b>文件偏移 0x2E1E00</b> 读入，值为 <code>e0 67 0d d6 1a 2c 24 cc 92 b7 06 c2 fa 9f 2d 1c</code>。',
          '<b>反模拟手段</b>：壳用自定义 <code>svc 63505</code>（NR=222 的自定义 mmap2）让 unidbg 的默认 syscall 处理失效，需注册 <code>Arm64Svc</code>，对 <code>x5&gt;0x10000000</code> 的请求返回 -1。',
          '不写死地址：运行时从 memoryMap 动态定位 RWX 段 seg0 / seg1（<code>0x12000000</code> 起、<code>prot==0x7</code>）。',
          '<b>JNIEnv 定制布局修正</b>：反射取 <code>_JNIEnv</code> 的真实表布局，让 <code>[0x480]</code> GetStaticFieldID 与 <code>[0x4B0]</code> GetStaticIntField 恒返回 23（即 SDK_INT）。',
          'code hook 逐点改写：<code>0x2E00</code> 置 W0=0 过入口检查、<code>0x2E18</code> 置 X0=JNIEnv、<code>0x101A8</code> 改分支跳主状态机、<code>0x10168</code> 跳过 switch、<code>0x90F8</code> 把 canary 检查 NOP 掉，并令 X23 = seg0 + <code>0x9120</code>。',
          '10 个 JNI 方法全部注册成功：<code>cV</code> / <code>cI</code> / <code>cL</code> / <code>cS</code> / <code>cC</code> / <code>cB</code> / <code>cJ</code> / <code>cZ</code> / <code>cF</code> / <code>cD</code>，其中 <code>cL</code> 的入口落在 <code>RWX@0x12973690</code>。',
          'dump 出可直接分析的 so：<code>payload_clean_full.so</code>（size <code>0x2e2000</code>，MD5 <code>246affafe5c033d716f54a532f88fcde</code>），IDA 识别出 <b>103 个函数 / 9185 条字符串</b>，entry <code>0x2D80</code>。',
          '算法黑盒调用：<code>cL(#239)</code> 的日志链是 <code>KeyGenerator.getInstance("AES")</code> → <code>init(0x80)</code> → <code>generateKey().getEncoded()</code>，即 <b>AES-128</b>（unidbg 侧 mock key <code>030a11181f262d343b424950575e656c</code>）。',
          '<code>#238 aesEncry</code> = <code>Cipher.getInstance("AES/CBC/PKCS5Padding")</code> + SecretKeySpec + IvParameterSpec + doFinal；Java 回环 6 组全 PASS（<code>"hello-238"</code> → hex <code>3dd62fbbad0bbac61ffb16ae972accf0</code>，b64 <code>PdYvu60LusYf+xaulyrM8A==</code>）。',
          '<b>VMP 解释器</b> <code>loc_10950</code>：主循环 <code>0x109D4~0x109E8</code> 先做 <code>UBFX X9,X8,#0,#0x20</code> 取 opcode → <code>LDRSW X8,[X27,X9,LSL#2]</code> 查跳转表（X27=<code>0x112B8</code>，16 个 case）→ <code>BR X8</code>；状态寄存器 W28 初值 <code>0xE568AAEC</code>。',
          '16 个 opcode 统一模式是 <code>byte[X25+addr] ^= key</code>；opcode 10 是 JNI 调用指令（经 <code>JNIEnv[0x558]</code> CallStaticObjectMethodV 与 <code>[0x568]</code> CallObjectMethod），opcode 15 是结束哨兵。',
          'DEX 脱壳走 Zero-Break：不 attach、不 ptrace，只用 <code>/proc/&lt;PID&gt;/mem</code> + <code>pread</code> 读取；v1 扫匿名段配 magic <code>dex\\n035\\0</code>，再从 DEX 头偏移 <code>0x20</code> 读 <code>file_size</code> 精确截断。',
          'DEX 修复 <code>fix_dex_checksum_full.py</code>：先算 SHA-1 signature（20B，偏移 12，覆盖 <code>data[32:]</code>），再算 Adler32 checksum（4B，偏移 8，覆盖 <code>data[12:]</code>）；产物 <code>payload_2_full_fixed.dex</code>（13,000,000 B，checksum <code>0x326a2e89</code>），jadx 出 <b>2070 个类</b>。'
        ],
        method: [
          '搭双环境并明确排除 Frida：真机定制 ROM 用来看“真实的它长什么样”，unidbg 用来做“可复现地喂输入取输出”，两条线互相印证而不是互相依赖。',
          '静态拆 loader：<code>libdexjni_target.so</code> 镜像 size <code>0x2F4150</code>，明文 stub 只到 <code>0x2CA0</code>，其余全是密文 ⇒ 先锁定 <code>sub_13F8</code> / <code>sub_1184</code> / <code>sub_CD0</code> 三个入口再谈别的。',
          '解 RC4：认出标准的 256B S-box KSA + 16B key 循环 + PRGA 写回，并顺着 <code>sub_AC0</code> 的 <code>pread</code> 找到 key 来自<b>文件偏移 <code>0x2E1E00</code></b>。',
          '预判反模拟：静态里看到自定义 <code>svc 63505</code>，先给 unidbg 注册 <code>Arm64Svc</code> 把 <code>x5&gt;0x10000000</code> 挡成 -1，而不是去硬改 unidbg 的默认 syscall 表。',
          '把地址全部改成运行时求值：从 memoryMap 动态定位 RWX 段 seg0 / seg1，后续 hook 一律相对它计算。',
          '修 JNIEnv 表：按反射拿到的 <code>_JNIEnv</code> 真实布局，让 <code>[0x480]</code> / <code>[0x4B0]</code> 两个槽位恒返回 23。',
          '逐点打 code hook：入口检查、JNIEnv 传参、主状态机分支、switch 跳过、canary 检查、X23 基址，一处一处改到能往下走。',
          '验证注册结果：确认 10 个 JNI 方法全部注册成功，再 dump 出 <code>payload_clean_full.so</code> 丢进 IDA 复核（103 函数 / 9185 字符串）。',
          '黑盒调用出算法：跑 <code>cL(#239)</code> 读日志链判定 AES-128，跑 <code>#238</code> 判定 AES/CBC/PKCS5Padding。',
          '交叉确认而不是自我说服：用 Java 回环跑 6 组，全部 PASS 之后才把结论写下来。',
          '顺带脱 DEX：Zero-Break 方式只读 <code>/proc/&lt;PID&gt;/mem</code>，扫匿名段配 <code>dex\\n035\\0</code> magic，按 DEX 头的 <code>file_size</code> 精确截断，最后用 <code>fix_dex_checksum_full.py</code> 补齐 SHA-1 与 Adler32 两个校验字段。'
        ],
        result:
          '<p>最终拿到两份可以继续分析的产物：一份能丢进 IDA 的干净脱壳文件 <code>payload_clean_full.so</code>' +
          '（<b>103 函数 / 9185 字符串 / entry <code>0x2D80</code></b>），以及全部 payload DEX（<b>2070 类 + 198 类</b>）。</p>' +
          '<p>算法层面：<b><code>#239</code> = AES-128</b>，<b><code>#238</code> = AES/CBC/PKCS5Padding</b>，整条链路有 Java 回环 6 组 PASS 作为实证。</p>' +
          '<p>同时确认了一件对定位很重要的事：<b>VMP 保护的是 <code>cL</code> 的参数解析与 methodID 分发（Instruction Stealing 型），不是 AES 算法本身。</b>' +
          '换句话说，虚拟机指令流负责的是“调用谁、传什么”，真正的密码学运算仍然交给系统的 JCE 完成。</p>',
        terms: ['unidbg', 'Arm64Svc / 自定义 svc', '自定义 Dynamic Linker', 'RC4', 'JNIEnv 表布局', 'code hook', 'VMP 解释器', 'Instruction Stealing', 'Zero-Break 脱壳', 'Adler32 / SHA-1'],
        limits:
          '<p>作者的局限自述相当充分，逐条照录：</p>' +
          '<p>① <b>自写的 VMP 模拟器没有在真实的 <code>#238</code> 指令流上跑通。</b>' +
          'unidbg 执行到 opcode 10 时崩于模拟缺陷：该处要求 <code>X21=JNIEnv</code>、<code>[SP,#0x18]=参数数组</code>，实际两边都是野指针。' +
          '作者推测是壳在 opcode 9→10 的寄存器保存 / 恢复过程中，高位指针被低 32 位截断，并注明“解密后的 payload 中未发现 setjmp / longjmp / signal 特征”——把异常跳转这个解释主动排除了。</p>' +
          '<p>② 因此 <b><code>#238</code> 的结论来自静态字符串（<code>0x129df4</code> 处的 <code>"AES/CBC/PKCS5P"</code>）+ 参数映射 + Java 回环交叉确认，不是模拟器跑通所得。</b></p>' +
          '<p>③ <code>mic</code>（MAC）消息认证码的生成 / 校验算法未深入。</p>' +
          '<p>④ RSA 公钥的来源与存放未评估。</p>' +
          '<p>⑤ 16 个 opcode 的语义表里，部分 next 值作者自己标为<b>不确定</b>。</p>' +
          '<p>⑥ 两条常规路线——<b>真机 Frida 与硬件断点——全部撞墙</b>，这也正是作者转向 unidbg 的原因。</p>',
        analysis:
          '<p><b>这是第 21 章“补环境”与“黑盒调用”两条主线的实战全景。</b>本章反复讲的两件事在这里同时发生：' +
          '一边是补环境必须按需迭代，一边是黑盒调用只要能喂输入取输出就等于拿到了算法能力。</p>' +
          '<p><b>第一层，反模拟是模拟器遇到的新对手。</b>壳用了自定义的 <code>svc 63505</code>（NR=222 的自定义 mmap2），' +
          'unidbg 默认的 syscall 处理对它完全失效——这不是“少补了一个函数”，而是对方<b>专门为了让模拟器读不懂而改的调用号</b>。' +
          '作者的应对是注册 <code>Arm64Svc</code>，让 <code>x5&gt;0x10000000</code> 的请求返回 -1。' +
          '这正是本章那句“补环境是持续的对抗过程，不是一次性配置”的现实版本：' +
          '<span class="hit"><b>你补完一轮，对手下一次升级就可能让这一轮失效。</b></span></p>' +
          '<p><b>第二层，补环境必须分层。</b>看作者一共改了多少个点：JNIEnv 表布局（<code>[0x480]</code> / <code>[0x4B0]</code> 恒返回 23）、' +
          'RWX 段 seg0 / seg1 的动态定位（不写死地址）、状态机分支改写（<code>0x101A8</code> 改分支、<code>0x10168</code> 跳过 switch）、' +
          'canary 检查 NOP（<code>0x90F8</code>）、入口检查（<code>0x2E00</code> 置 W0=0）。' +
          '<b>每一层都要单独修，修错一层就前功尽弃</b>——这不是本章“五类依赖”清单的简化版，而是它的满配形态：' +
          '第②③④类依赖全部占满，且每一项都带着壳自己的定制。<b>所谓“补环境”，就是把这些定制一条条摊平。</b></p>' +
          '<p><b>第三层，作者对结论的诚实最值得学。</b>他明确区分了“模拟器跑通”和“静态字符串 + Java 回环交叉确认”两种证据强度，' +
          '并把没跑通的具体原因写了出来（野指针、寄存器高位被低 32 位截断的推测），而不是含糊地说一句“算法基本复原”。' +
          '<span class="hit">这提醒我们：<b>结论的可信度取决于证据链的完整性，而不是结论听起来有多完整。</b></span>' +
          '同样值得学的是他没有隐瞒那两条撞墙的常规路线——真机 Frida 和硬件断点——因为“哪些路走不通”本身就是有效信息。</p>',
        link: 'https://bbs.kanxue.com/thread-292331.htm',
        linkNote: '看雪论坛原创帖'
      }
    },

    /* ================= 21.6 ================= */
    {
      h: '21.6',
      title: '决策演练：崩在 SVC 的那一刻',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一',
            scenario: '<b>情境：</b>你用 Unicorn 调一个从 so 抠出来的 ARM64 加密函数，已经 map 了代码段、栈和输出缓冲区。trace 显示前 40 条指令跑得很顺，第 41 条是一条 <span class="mono">SVC #0</span>，然后 <span class="mono">emu_start</span> 立刻抛异常退出。<br><br>你此刻的下一步是什么？',
            choices: [
              { t: '用 Keystone 把这条 SVC 汇编成 NOP 覆盖掉，让它直接跳过，先跑通再说', next: 'n1' },
              { t: '在 UC_HOOK_INTR 里拦截，读出系统调用号（AArch64 在 X8）并分发到自己实现的处理函数', next: 'n2' },
              { t: '模拟执行太麻烦了，立刻放弃，改用真机 + Frida RPC', next: 'n3' },
              { t: '照着 Linux 内核源码，把 open/read/mmap/ioctl 等 syscall 完整实现一遍保证保真度', next: 'n4' }
            ]
          },
          n1: {
            label: '选 A：NOP 掉它', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：你把「不崩」当成了目标',
            result: '<b>认知根源：把「跑通」和「跑对」混为一谈。</b>模拟执行的目标从来不是「不崩溃」，而是「<b>输出与真机一致</b>」。SVC 被 NOP 掉之后，本该由内核写入的返回值（在 X0）还是原来的垃圾值，后续算法会拿这个垃圾值继续算——结果是<b>程序不崩了，但算出来的密文是错的</b>。<br><br>更糟的是，这种错误<b>极难发现</b>：你没有异常、没有报错，只有一份看起来很正常但和真机对不上的结果。很多人会因此怀疑「是不是参数传错了」「是不是抠错了字节」，然后在这个假问题上耗掉一整天。<br><br><b>正确做法：</b>先看这个 syscall 是几号、参数是什么（trace 里有 X0–X5），判断它要做什么，再决定是补一个简化实现，还是真的可以跳过。如果确认它对结果无影响（比如只是个日志 write），跳过是合理的——但那是<b>判断之后</b>的跳过，不是逃避式的跳过。'
          },
          n2: {
            label: '选 B：UC_HOOK_INTR 拦截分发', terminal: true, verdict: 'good',
            verdictTitle: '正确：把内核的活揽到自己身上',
            result: '<b>这就是补环境的正解。</b>Unicorn 遇到 <span class="mono">SVC</span> 时会停下来并触发 <span class="mono">UC_HOOK_INTR</span> 回调，把控制权交给你——它<b>不是报错，是提问</b>：「这条系统调用你想怎么办？」<br><br>标准处理流程：① 读系统调用号（<b>AArch64 在 <span class="mono">X8</span>，ARM32 在 <span class="mono">R7</span></b>）；② 读参数（X0–X5 / R0–R5）；③ switch 分发到你自己写的处理函数；④ <b>把返回值写回 X0</b>；⑤ 让 PC 前进到下一条指令（否则会死循环）。<br><br><b>关键心法：先别急着实现，先看清楚它是什么。</b>把「syscall 号 + 参数」打印出来再决定——绝大多数 so 真正用到的 syscall 只有个位数，而且往往可以用极度简化的方式糊弄过去（比如 <span class="mono">clock_gettime</span> 直接返回固定时间戳）。<br><br><b>常见坑：</b>忘记写回 X0（后续读到垃圾值）、忘记推进 PC（死循环）、以及把 64 位 AArch64 和 32 位 ARM 的调用号规则搞混（<b>两套编号体系完全不同</b>，抄错表格会让分发全错）。'
          },
          n3: {
            label: '选 C：立刻转 Frida RPC', terminal: true, verdict: 'bad',
            verdictTitle: '退得太早：你还没评估成本就放弃了',
            result: '<b>认知根源：把「遇到障碍」直接等同于「此路不通」。</b>Frida RPC 本身是极好的方案（见 21.9），但它的定位应该是<b>「补环境成本评估之后的退路」</b>，而不是「碰到第一个报错时的第一反应」。<br><br>一次 <span class="mono">SVC</span> 崩溃的成本可能是<b>十行代码</b>——判断 syscall 号、返回一个合理值、写回 X0。为了这个放弃整条模拟执行路线，等于把后面所有的收益（不依赖设备、可并发、可打包成服务、可无限次复现）全部扔掉。<br><br><b>什么时候该真的退？</b>当依赖复杂度触及边界时：目标 so 大量回调 Java 层业务逻辑、用了几十个只在内核里才能解释清楚的 syscall、或者干脆在 so 里做了完整性自校验（校验不过就返回错误结果）。<b>该退的时候果断退，不该退的时候别被第一个异常吓跑。</b><br><br><b>务实做法：</b>先用 Frida RPC 在真机上跑出几组「输入 → 输出」样本对，再决定要不要迁到 unidbg——这样你随时有一个已知正确的参照系。'
          },
          n4: {
            label: '选 D：完整实现所有 syscall', terminal: true, verdict: 'bad',
            verdictTitle: '过度工程：你在造一个内核，而你需要的是跑通一个函数',
            result: '<b>认知根源：把「保真度」当成了目标本身。</b>模拟执行的保真度是<b>手段</b>，不是目的。目标是「输出与真机一致」，而达到这个目标所需的环境，通常远小于「一个完整的 Linux 内核」。<br><br>实际的经验是：<b>90% 的 syscall 只需要极简实现</b>。时间类返回固定值、文件类返回「文件不存在」或一小段假内容、内存类从一个简单的线性分配器里切一块。<b>唯一需要认真对待的</b>，是那些返回值会真正参与运算的调用（比如 <span class="mono">mmap</span> 返回的地址必须真的可用）。<br><br>代价还有一层：你实现的每一个 syscall 都是<b>一份新的 bug 来源</b>。写得多，错得多；错了之后，崩溃点离真正的病因非常远，调试成本指数上升。<br><br><b>正确姿势：按需补 + 迭代收敛。</b>跑 → 崩 → trace 定位 → 只补这一个 → 再跑。这个循环每一轮都把环境向「刚好够用」推进一步，而不是向「完整」推进一步。'
          }
        }
      }
    },

    /* ================= 21.7 ================= */
    {
      h: '21.7',
      title: 'AndroidNativeEmu：把补环境「框架化」的第一次尝试',
      html: '<p>手工用 Unicorn 补环境，写第二个目标时你会发现：<b>① ② ③ ④ 这四类工作几乎一模一样</b>。换一个 so，ELF 还是要解析、syscall 还是要拦截、JNIEnv 表还是要造一遍。于是很自然有人想：为什么不把这部分做成框架？</p>' +
        '<p><b>AndroidNativeEmu</b>（<span class="mono">AeonLucid/AndroidNativeEmu</span>）就是这个思路的产物：一个 Python 项目，<span class="mono">pip install androidemu</span> 即可安装，基于 Unicorn + Keystone 构建。它的官方定位非常坦诚：</p>' +
        '<div class="note"><div class="note-h">官方 README 原文</div><p><span class="mono">Allows you to partly emulate an Android native library. This is an educational project to learn more about the ELF file format and Unicorn.</span></p><p class="small muted">译：允许你<b>部分地</b>模拟一个 Android native 库。这是一个用于学习 ELF 文件格式与 Unicorn 的教育性项目。</p></div>' +
        T.note('warn', '⚠️ 注意「partly」和「educational」这两个词', '<p>作者自己就把定位划得很清楚：<b>它不承诺完整、不承诺生产可用</b>。把它当作「补环境框架的最小可行示例」来读，比当作生产工具更合适——它的价值在于让你看懂 unidbg 那类框架<b>在做什么</b>。</p>') +
        '<p>官方 README 列出的 Features（原文，直接引用）：</p>' +
        T.tbl(['官方 Feature（原文）', '对应本章的哪一类依赖'], [
          ['Emulation of the JNI Invocation API so <span class="mono">JNI_OnLoad</span> can be called properly', '<b>④ JavaVM</b> + 调用入口'],
          ['Emulation of native memory for <span class="mono">malloc</span> / <span class="mono">memcpy</span>', '<b>① 库函数</b>'],
          ['Emulation of syscalls (<span class="mono">SVC #0</span>) instruction', '<b>② 系统调用</b>'],
          ['Hooking through the symbol table', '<b>① 库函数</b>的接入方式：按符号名挂钩'],
          ['All <span class="mono">JavaVM</span>, <span class="mono">JNIEnv</span> and hooked functions are handled by python', '<b>③ JNIEnv 函数表</b> + ④，且用 Python 实现'],
          ['Enable VFP support', 'ARM32 浮点单元支持（很多加密 / 校验算法用浮点）'],
          ['（依赖）Unicorn + Keystone', '本章 21.2 的三兄弟之二']
        ]) +
        T.note('key', '🔑 从这份 Feature 列表里该读出什么', '<p>看第二列——<b>AndroidNativeEmu 的 Feature 列表，就是本章「补环境五类依赖」的前四类</b>。这说明「补环境」不是一个模糊的工程问题，而是一份<b>可以被枚举、被框架化</b>的清单。谁能把这四类做得最通用、最省事，谁就成为主流工具。</p>') +
        '<p>而第五类（Java 层类与方法）它没有覆盖——这正是后起之秀 unidbg 拉开差距的地方。</p>' +
        T.note('ok', '✅ 它现在还有用吗', '<p>有，但用途变了：<b>当作读得懂的教材</b>。项目规模不大、Python 写的、逻辑直观，是理解「一个 so 加载器 + 一个 syscall 分发器 + 一张 JNI 表」如何拼起来的最佳样本。真要跑复杂目标，主流选择已经是 unidbg。</p>') +
        '<p>接下来是本章的主角。</p>',
      quiz: {
        id: 'q7-3', chapter: 7, answer: 1,
        stem: 'AndroidNativeEmu 官方 README 里的定位是「allows you to <b>partly</b> emulate an Android native library」，并且自称是「an <b>educational</b> project」。结合本章的「补环境五类依赖」，这句话最准确的解读是？',
        options: [
          { t: '它只能模拟 ARM32，不能模拟 ARM64，所以是「部分」', why: '错。官方 Feature 里写着 Enable VFP support（ARM32 浮点），但这只是能力项之一，不是「partly」这个措辞的由来。' },
          { t: '它把①库函数②syscall③JNIEnv④JavaVM 这几类通用依赖框架化了，但 Java 层的类与方法（第⑤类）需要使用者自己伪造，所以是「部分模拟」', why: '对。它的 Feature 列表恰好覆盖前四类，第五类要靠使用者用 Python 自己造——这就是「partly」的实际边界。' },
          { t: '它不能调用 JNI_OnLoad，只能调用普通导出函数', why: '错。官方 Feature 第一条就是 Emulation of the JNI Invocation API so JNI_OnLoad can be called properly。' },
          { t: '它是 unidbg 的 Python 封装，本身不实现 ELF 解析', why: '错。它是独立项目，且官方明说目标是学习 ELF 文件格式与 Unicorn，ELF 解析是它自己的核心部分。' }
        ],
        explain: '<b>读一个框架，先读它的 Feature 列表和免责声明。</b>开源模拟器项目的 README 通常会诚实地划出边界，而这些边界恰好和「补环境五类依赖」一一对应。养成习惯：拿到一个新工具，先问「它替我把哪几类依赖补好了？剩下哪几类要我自己来？」——这个问题的答案，直接决定你在这个目标上要花三天还是三周。<br>AndroidNativeEmu 的历史意义在于：它证明了<b>通用依赖可以被框架化</b>；而它把第⑤类留给使用者，也预告了下一节的主角会往哪个方向发力。'
      }
    },

    /* ================= 21.8 ================= */
    {
      h: '21.8',
      title: 'unidbg：一体化方案与完整加载流程',
      html: '<p><b>unidbg</b>（<span class="mono">zhkl0228/unidbg</span>）是目前 Java 生态里最主流的 native 模拟执行框架。作者自己的定位同样克制：</p>' +
        '<div class="note"><div class="note-h">官方 README 原文</div><p><span class="mono">Allows you to emulate an Android native library, and an experimental iOS emulation.</span></p><p class="small muted">译：允许你模拟一个 Android native 库，以及一个<b>实验性</b>的 iOS 模拟。</p><p class="mono small">It is an educational project to learn more about the ELF/MachO file format and ARM assembly. Use it at your own risk !</p></div>' +
        T.note('warn', '⚠️ 官方免责声明要读进去', '<p>「educational project」+「Use it at your own risk」不是客套。<b>unidbg 的目标是「让 so 跑起来」，不是「通过任何反模拟检测」</b>。遇到专门针对模拟器做完整性和环境自校验的 so，它一样会失败——而且往往失败得<b>无声无息</b>（返回一个错误的密文，而不是抛异常）。所以永远要保留真机样本对作为参照系。</p>') +
        '<p>它的能力清单（官方 Features，原文）：</p>' +
        T.tbl(['官方 Feature（原文）', '意义'], [
          ['Emulation of the JNI Invocation API so <span class="mono">JNI_OnLoad</span> can be called', '标准入口，so 的初始化能正常走完'],
          ['Support <span class="mono">JavaVM</span>, <span class="mono">JNIEnv</span>', '第③④类依赖内置'],
          ['Emulation of syscalls instruction', '第②类依赖内置'],
          ['Support ARM32 and ARM64', '32/64 位 so 都能跑'],
          ['Inline hook（基于 <span class="mono">Dobby</span>）', '能改 native 函数实现，<span class="term" data-def="轻量级多平台 inline hook 框架，仓库 jmpews/Dobby。" >Dobby</span> 是底层 hook 引擎'],
          ['Android import hook（基于 <span class="mono">xHook</span>）', '<span class="term" data-def="爱奇艺开源的 Android PLT/GOT hook 框架，仓库 iqiyi/xHook。">xHook</span> 负责替换导入函数——正是「补①库函数」的自动化手段'],
          ['iOS fishhook / substrate / whale hook', 'iOS 侧的同类能力'],
          ['unicorn 后端：console 调试器、<b>gdb stub</b>、指令 trace、内存读写 trace', '把 Unicorn 的观测能力包装成可用工具链'],
          ['支持 iOS objc 和 swift runtime', 'iOS 目标'],
          ['支持 <b>dynarmic</b> 快速后端', '性能替代品，比纯 Unicorn 后端快'],
          ['支持 <b>Apple M1 hypervisor</b>（最快的 ARM64 后端）', 'Apple 芯片上接近原生速度'],
          ['支持 <b>Linux KVM</b> 后端（树莓派 B4）', 'ARM Linux 上利用硬件虚拟化'],
          ['模拟 native 代码的<b>内存泄漏检测</b>（带 guest 回溯与 host 栈）', '调 so 时排查泄漏，定位到具体调用栈']
        ]) +
        T.note('key', '🔑 这张表真正在说什么', '<p>注意最后五行——<b>unidbg 早就不只是「模拟器」了</b>，它是一整套 <b>native 代码调试工具链</b>：多后端（精度 vs 速度自由切换）、gdb stub（能用 IDA/GDB 连上去调）、trace、内存泄漏检测。<br>对你的实战意义：「模拟执行调不通」时，你手里的排查手段比裸 Unicorn 多得多——<b>先用 verbose 看加载日志，再用 trace 看执行流，必要时挂 gdb stub 单步</b>。</p>') +
        '<p>下面把一个 so 从零到「可以调用」的完整流程走一遍。这是你写第一个 unidbg 脚本时实际会敲的代码：</p>',
      stepper: {
        title: 'unidbg 加载 so 并调用 JNI_OnLoad',
        lines: [
          {
            code: '<span class="k">AndroidEmulator</span> emulator = AndroidEmulatorBuilder.<span class="f">for64Bit</span>().<span class="f">build</span>();',
            note: '<b>第一步：造模拟器。</b><span class="mono">AndroidEmulatorBuilder</span> 是入口工厂，<span class="mono">for64Bit()</span> 表示目标是 64 位（32 位用对应的 32 位构建器）。这一步做完，你得到的是一个<b>已经内置了 syscall 模拟、JNIEnv/JavaVM 实现、ELF 加载器</b>的模拟器——也就是 21.5 里让你手工补的那四类，它一次性给你了。',
            state: { '模拟器': 'AndroidEmulator 实例', '位数': '64 位', '内置能力': 'ELF 加载 / syscall / JNIEnv / JavaVM' }
          },
          {
            code: '<span class="k">Memory</span> memory = emulator.<span class="f">getMemory</span>();',
            note: '<b>第二步：拿到内存对象。</b>后面所有跟地址空间相关的配置都走它——最关键的是下一步的库解析器。<span class="pill warn">注意概念上的差别</span>：裸 Unicorn 里你要自己 <span class="mono">mem_map</span>；这里 unidbg 会按 ELF 的段表<b>自动布局</b>，你通常不需要手动 map 代码段。',
            state: { 'memory': 'Memory 对象已获取', '地址空间': '由 unidbg 管理' }
          },
          {
            code: 'memory.<span class="f">setLibraryResolver</span>(<span class="k">new</span> <span class="t">AndroidResolver</span>(<span class="n">23</span>));',
            note: '<b>第三步：设置库解析器。</b>参数 <span class="mono">23</span> 是目标 <b>Android API 版本</b>。这一步的实质是：<b>告诉 unidbg「当 so 说要加载 libc.so / liblog.so 时，去用哪个版本的假实现」</b>。选错版本可能让某些结构体布局或符号行为对不上——<b>最稳的做法是选与你抓到的 so 实际运行环境匹配的 API 等级</b>。',
            state: { 'LibraryResolver': 'AndroidResolver(23)', '含义': '按 Android API 23 解析系统库依赖' }
          },
          {
            code: '<span class="k">DalvikVM</span> vm = emulator.<span class="f">createDalvikVM</span>(<span class="k">new</span> <span class="t">File</span>(<span class="s">&quot;target.apk&quot;</span>));',
            note: '<b>第四步：创建假虚拟机。</b><span class="mono">DalvikVM</span> 是 unidbg 用 Java 写的「迷你 ART」——它实现了 <span class="mono">JNIEnv</span> 与 <span class="mono">JavaVM</span> 的函数表（21.4 讲的那张表，这里被真正填上了）。参数指向 APK 是为了让 <span class="mono">FindClass</span> 这类调用有机会去 dex 里找类。<span class="pill acc">如果只调纯 native 函数、不涉及 Java 交互，也可以不传 APK</span>。',
            state: { 'DalvikVM': '已创建', 'JNIEnv 表': '已由 unidbg 填好', 'JavaVM': '已就绪', 'APK': 'target.apk（供 FindClass 使用）' }
          },
          {
            code: 'vm.<span class="f">setVerbose</span>(<span class="k">true</span>);',
            note: '<b>第五步：打开 verbose 日志。</b>强烈建议<b>第一次跑任何目标都打开</b>。它会打印出库加载、符号解析、每一次 JNI 调用、每一次 syscall。<b>这份日志就是你补环境的说明书</b>——so 调了什么、缺什么、崩在哪一步，全在里面。',
            state: { 'verbose': 'true', '输出内容': '库加载 / 符号解析 / JNI 调用 / syscall' }
          },
          {
            code: '<span class="k">DalvikModule</span> dm = vm.<span class="f">loadLibrary</span>(<span class="k">new</span> <span class="t">File</span>(<span class="s">&quot;libtarget.so&quot;</span>), <span class="k">true</span>);',
            note: '<b>第六步：加载 so。</b>第二个参数 <span class="mono">true</span> 表示<b>加载后自动调用 <span class="mono">JNI_OnLoad</span></b>。<span class="pill warn">这个 true 千万别随手写 false</span>：很多 so 的关键初始化（字符串解密、函数注册、全局状态准备）都在 <span class="mono">JNI_OnLoad</span> 里，跳过它直接调目标函数，结果经常是错的——而且不报错。',
            state: { 'DalvikModule': 'libtarget.so 已加载', 'ELF 段': '已按段表布局到地址空间', '导入符号': '由 unidbg 挂钩', 'JNI_OnLoad': '触发调用' }
          },
          {
            code: 'dm.<span class="f">callJNI_OnLoad</span>(emulator);',
            note: '<b>第七步：显式确认 <span class="mono">JNI_OnLoad</span> 执行。</b>返回的整数是 so 声明的 JNI 版本（正常应该是一个像 <span class="mono">0x00010006</span> 这样的版本号）。<b>它是你第一个健康检查点</b>：如果返回 0、负数，或者这一步就崩了，说明 so 的初始化没走完——先解决它，别急着调业务函数。',
            state: { 'JNI_OnLoad 返回': 'JNI 版本号（如 0x00010006）', '健康检查': '✅ 非 0 即视为初始化成功', 'so 状态': '已完成注册与热身' }
          },
          {
            code: '<span class="c">// 之后：定位目标函数</span>\n<span class="c">// emulator.getMemory().findModule(&quot;libtarget.so&quot;)</span>\n<span class="c">// dm.getModule().findSymbolByName(&quot;Java_...&quot;)</span>',
            note: '<b>第八步：定位目标函数。</b>两种常用入口：按 <b>JNI 导出名</b>找（形如 <span class="mono">Java_com_x_y_Native_encrypt</span>），或者按<b>模块基址 + 偏移</b>找（静态分析时在 IDA 里量出的偏移，直接加基址）。后者在 so 做了符号混淆 / 动态注册时是唯一选择。<span class="pill warn">具体 API 名以你所用版本为准</span>。',
            state: { '模块基址': '如 0x40000000（每次构建可能不同）', '查找方式': '导出符号名 / 基址+偏移', '下一步': '准备参数并调用' }
          },
          {
            code: '<span class="c">// 调用：callFunction / callStaticJniMethod 等</span>\n<span class="c">// 或把 emulator 丢进 WorkerPool 供并发复用</span>',
            note: '<b>第九步：调用与工程化。</b>调用方式按函数类型选：<b>普通导出函数</b>用 <span class="mono">callFunction</span> 直接给参数；<b>JNI 方法</b>用 <span class="mono">callStaticJniMethod</span> / <span class="mono">callJniMethod</span>，由 unidbg 自动帮你把参数转成 jstring / jbyteArray 等 JNI 类型。<span class="pill acc">要跑成服务，就用官方提供的 Worker Pool</span> 做对象池复用（见 21.10）。',
            state: { '调用方式': 'callFunction / callStaticJniMethod', '参数类型': 'unidbg 自动做 JNI 类型转换', '工程化': 'WorkerPool 复用实例' }
          }
        ]
      },
      after: T.note('ok', '✅ 骨架记牢，剩下都是查文档', '<p>这九步是固定的。<b>模拟执行调不通的时候，永远按这个顺序回查</b>：位数选对了吗 → API 版本选对了吗 → APK / so 路径对吗 → <span class="mono">JNI_OnLoad</span> 返回值正常吗 → 目标函数定位对吗 → 参数类型对吗。绝大多数「跑不出来」，答案在前三步。</p>')
    },

    /* ================= 21.9 ================= */
    {
      h: '21.9',
      title: '黑盒调用：算法还原的落地形态',
      html: '<p>前面所有铺垫最后都要落到一个问题上：<b>我到底要拿到什么？</b>如果你的答案是「密文」，那你很可能<b>根本不需要还原算法逻辑</b>。</p>' +
        T.note('key', '🔑 黑盒调用的核心思想', '<p>只要能让 so 跑起来、能喂输入、能取输出，<b>你就等于拥有了这个算法</b>——哪怕你一行汇编都没读懂。这在工程上完全够用：你需要的是「给定明文产出密文」这个能力，不是「知道它用了什么魔改的 TEA」。</p>') +
        '<p>落地方式就两种，选哪个取决于补环境的成本：</p>' +
        T.tbl(['', '① Frida RPC', '② unidbg 黑盒调用'], [
          ['<b>怎么跑</b>', '真机 / 模拟器上跑 App，用 <span class="mono">rpc.exports</span> 把加密函数暴露成 JS 可调用接口，Python 端 <span class="mono">script.exports_sync.xxx()</span> 批量调用', 'PC 上加载 so 直接调用，不启动 App'],
          ['<b>优点</b>', '保真度<b>最高</b>——环境是真实的，反调试、完整性校验、Java 交互全都天然成立', '不依赖设备、<b>速度快</b>、可并发、可打包成常驻服务、可无限次复现'],
          ['<b>缺点</b>', '依赖设备、速度慢、难并发、随时可能被反调试干掉', '<b>补环境可能很痛苦</b>，且失败时常常返回错误结果而不报错'],
          ['<b>适合</b>', '验证算法可行性、采集「输入→输出」样本对、一次性少量调用', '批量 / 高并发 / 长期稳定服务化']
        ]) +
        '<p>注意上表最后一行——<b>两者不是竞争关系，而是流程上的先后关系</b>。这也引出了本节最重要的一条建议：</p>' +
        T.note('ok', '✅ 推荐工作流（先 Frida，后 unidbg）', '<ol><li><b>先用 Frida RPC 在真机上跑通</b>，确认函数可以被成功调用；</li><li><b>采集几组「输入 → 输出」样本对</b>，作为后续一切的<b>黄金参照</b>；</li><li>同时观察它调了什么（JNI 回调多不多？syscall 多不多？有没有读 /proc？）——<b>这就是补环境难度评估</b>；</li><li>评估结果可接受 → 迁到 unidbg，用样本对逐组回归验证；</li><li>评估结果是「地狱级」→ 老老实实继续用 Frida RPC，或者回到静态分析。</li></ol>') +
        T.note('bad', '⚠️ 没有样本对的 unidbg 迁移＝闭眼开车', '<p>unidbg 最危险的失败模式不是崩溃，是<b>静默地算错</b>。补错了环境、跳过了 <span class="mono">JNI_OnLoad</span>、时间函数返回了不合适的值——它都会给你一个<b>格式正常但内容错误</b>的结果。<b>手里没有真机样本对，你根本发现不了。</b></p>') +
        '<p>什么时候<b>必须</b>上 unidbg？当 Frida 路线被物理掐死的时候：目标 App 反调试太强无法稳定附着、没有可用设备、需要每秒上千次调用、或者要把算法能力封装成一个对外 HTTP 服务。<b>除此之外，Frida RPC 往往是更省事的选择。</b></p>',
      quiz: {
        id: 'q7-4', chapter: 7, answer: 3,
        stem: '你在做某 App 的接口签名逆向。Frida RPC 已经在真机上跑通了，但接口需要每秒数百次签名，真机方案顶不住。评估后发现：目标 so <b>只调了 malloc/memcpy，做了 2 个 syscall，完全不回调 Java 层</b>。最合理的决策是？',
        options: [
          { t: '继续用 Frida RPC，靠加设备横向扩容', why: '成本高且脆弱。补环境评估结果明明很乐观（依赖极简），却选择了最贵的扩容路径。' },
          { t: '放弃接口签名，改用静态分析手写算法', why: '你可能根本看不懂混淆后的算法；而且你已经有了可用的调用能力，重写是纯粹的浪费。' },
          { t: '直接上 unidbg，不需要任何验证，先把服务搭起来', why: '错在「不需要任何验证」。迁移到 unidbg 后必须用真机样本对回归验证，否则静默算错无法察觉。' },
          { t: '迁移到 unidbg 做黑盒调用，并用已有的真机样本对逐组回归验证', why: '对。依赖极简意味着补环境成本很低，unidbg 的速度与并发优势正好解决问题；样本对保证迁移后结果一致。' }
        ],
        explain: '<b>这道题的两个得分点：① 补环境成本评估；② 迁移后必须有参照系。</b><br>「只调 malloc/memcpy + 2 个 syscall + 不回调 Java」翻译成 21.5 的语言就是：<b>第①类依赖简单、第②类依赖极少、第③④类几乎不用、第⑤类完全没有</b>。这是 unidbg 最舒服的场景，通常半天到一天就能跑通。<br>反过来，如果评估结果是「大量 JNI 回调 + 几十个 syscall + 读 /proc 自校验」，那即使 Frida 慢，也该继续忍着——因为补环境的天数成本远超扩容成本。<br><b>「先用 Frida 验证并采样，再决定是否迁移」这条流程的价值就在于：它把补环境的风险，提前暴露在一个成本极低的阶段。</b>'
      }
    },

    /* ================= 21.10 ================= */
    {
      h: '21.10',
      title: 'verbose 日志：补环境的说明书',
      html: '<p>unidbg 的 <span class="mono">setVerbose(true)</span> 输出信息量很大，但结构是固定的。学会读它，补环境就变成了一件「按图索骥」的事。下面是一次典型加载过程的日志。</p>',
      term: {
        title: 'unidbg verbose 输出（加载 so → 调 JNI_OnLoad → 调目标函数）',
        lines: [
          { t: 'p', s: 'java -jar unidbg.jar --verbose libtarget.so', note: '<b>启动。</b>实际项目中通常是写一个 Java 主类跑，这里用命令行示意。<span class="pill warn">具体命令行参数以你的构建为准</span>' },
          { t: 'd', s: '[INFO] AndroidEmulatorBuilder: backend=Unicorn, 64bit, Android API 23', note: '<b>第一行就要核对两件事：位数和后端。</b>如果目标 so 是 32 位的而这里写着 64bit，后面所有地址都会对不上，报错会非常离奇。' },
          { t: 'o', s: '[INFO] Load library libtarget.so from /work/libtarget.so', note: '<b>开始加载 so。</b>确认路径是你要的那个版本——同名 so 不同版本结果可能不同，这是很隐蔽的坑。' },
          { t: 'o', s: '[INFO] resolve library: libc.so -> /android/sdk/android-23/libc.so', note: '<b>库解析器在工作。</b>这行告诉你依赖 libc 时它去拿了哪个假实现。如果这里显示 <span class="miss">failed</span> 或者版本和真机不符，后续行为可能偏离真机。' },
          { t: 'w', s: '[WARN] resolve symbol: __cxa_atexit not found, use stub', note: '<b>⚠️ 关键行。</b>某个导入符号在 unidbg 的库里没找到，于是用了一个桩。多数情况下无害，但如果这个符号<b>真的参与运算</b>（比如是一个加密相关的函数），结果就会静默出错。ⓘ <b>看到 WARN 就要停下来判断，不要当噪音刷过去。</b>' },
          { t: 'o', s: '[INFO] find symbol Java_com_x_y_Native_encrypt at 0x40001A2C', note: '<b>找到目标函数了。</b>记下这个地址——它是「模块基址 + 偏移」定位法的落点，和你 IDA 里看到的偏移应该能对上。<b>对不上说明你抓的 so 和静态分析的不是同一份。</b>' },
          { t: 'o', s: '[INFO] call JNI_OnLoad, vm=0x..., reserved=0x0', note: '<b><span class="mono">JNI_OnLoad</span> 被调用。</b>参数里的 <span class="mono">JavaVM*</span> 是 unidbg 造的假 VM（21.4 讲的那张函数表）。这一步成功，说明 so 的初始化环境齐了。' },
          { t: 'o', s: '[INFO] JNI_OnLoad return 0x10006', note: '<b>✅ 健康检查通过。</b>返回 JNI 版本号（这里示意为 0x10006），说明 so 认可了这个假 VM。<b>返回 0 或负数就是初始化失败</b>，先解决它，别急着调业务函数。' },
          { t: 'o', s: '[INFO] JNIEnv->NewStringUTF(&quot;...&quot;) => 0x...', note: '<b>JNI 调用被记录。</b>每次 native 回调 Java 都会打印。<b>这一段的密度直接反映第⑤类依赖的复杂度</b>：只有零星几行说明很干净；刷屏几百行说明补环境会很痛。' },
          { t: 'o', s: '[INFO] syscall: gettimeofday(tv=0x..., tz=0x0)', note: '<b>syscall 被记录。</b>这是第②类依赖的清单来源。<span class="hit">如果只出现个位数种 syscall，说明补环境成本很低</span>——正是 21.9 那道题里「该迁移」的信号。' },
          { t: 'o', s: '[INFO] memcpy(0x..., 0x..., 32) => 0x...', note: '<b>库函数调用被记录。</b>第①类依赖的清单。<b>技巧：如果某个库函数行为可疑，可以用 Dobby inline hook 把它替换成你自己的实现，再对比结果变化</b>——这是 unidbg 相比裸 Unicorn 的巨大便利。' },
          { t: 'p', s: 'Call native function: encrypt(input, len) -> [B', note: '<b>你自己的调用代码。</b>参数与返回类型要写对：<span class="mono">[B</span> 表示 byte 数组。类型写错是「结果莫名其妙」的常见原因。' },
          { t: 'o', s: 'encrypt(&quot;hello&quot;) => 8F 3A C1 00 9D 2E 77 B4', note: '<b>✅ 拿到结果。</b><b>立刻做的一件事：和真机 Frida RPC 采到的样本对比。</b>一致 → 迁移成功，可以上 Worker Pool 做并发服务；不一致 → 回去看日志里的 WARN 行和 JNI 调用行。' },
          { t: 'e', s: '[ERROR] Memory access error at 0x0 (unmapped)', note: '<b>❌ 最典型的崩溃。</b><span class="mono">0x0</span> 通常意味着<b>某个函数指针是空的</b>——极可能是 so 调用了一张你没补全的表（JNIEnv 槽位、或者某个结构体里的回调），或者是 so 在 <span class="mono">JNI_OnLoad</span> 之前的代码被提前执行了。<b>往上看 10 行日志，答案通常就在那里。</b>' }
        ]
      },
      after: T.note('key', '🔑 读日志的三条经验', '<ol><li><b>WARN 不是噪音。</b>「use stub」意味着某个符号没实现。它可能有影响，也可能没影响——<b>必须判断，不能忽略</b>。</li><li><b>看 JNI 调用与 syscall 的密度。</b>这是补环境难度最直接的量化指标，也是你决定「继续投入」还是「退回 Frida RPC」的依据。</li><li><b>崩溃时往上看，不要往下找。</b>模拟执行的错误现场往往离病因几十条日志——最后一行 ERROR 只是<b>症状</b>，前面第一次出现异常的 WARN 或第一次「不该出现的调用」才是<b>病因</b>。</li></ol>')
    },

    /* ================= 21.11 ================= */
    {
      h: '21.11',
      title: '工程化：从脚本到服务',
      html: '<p>算法一旦在 PC 上跑通，下一个问题就是<b>怎么把它变成能扛住生产流量的东西</b>。这一步 unidbg 同样给了答案。</p>' +
        T.note('key', '🔑 直接复用实例是不行的', '<p><span class="mono">AndroidEmulator</span> 对象<b>不是线程安全的</b>，而且创建一个实例（加载 so、跑 <span class="mono">JNI_OnLoad</span>、初始化环境）本身有可观的耗时。<b>每次请求都新建一个 emulator</b> → 慢且吃内存；<b>全局共用一个</b> → 并发下直接出乱子。两条路都走不通。</p>') +
        '<p>unidbg 官方提供的解法是 <b>Worker Pool</b>：一个<b>线程安全的 <span class="term" data-def="这里指 AndroidEmulator 实例池：预创建若干已初始化的模拟器，请求来时借用、用完归还，避免每次请求重复加载 so 与初始化环境。">emulator 对象池</span></b>。它做的事很朴素——预创建若干个已初始化好的 emulator 实例放在池里，请求来了借一个、用完归还，从而<b>复用实例、避免重复初始化开销</b>。这正是「适合把算法封装成高并发服务」的关键机制。</p>' +
        T.note('ok', '✅ 服务化骨架（思路，非完整代码）', '<ol><li>启动时创建一个 Worker Pool，池大小按 CPU 核数与单个实例内存占用权衡；</li><li>暴露一个薄薄的 HTTP / RPC 接口（参数：输入字节；返回：输出字节）；</li><li>请求进来 → 从池里<b>借</b>一个 emulator → 调用目标函数 → <b>归还</b>；</li><li>对结果做<b>自校验</b>：拿预存的真机样本对跑一轮健康检查，对不上就熔断。</li></ol>') +
        '<p>第 4 条是很多人会省掉、然后在半夜被叫起来的一条。<b>静默算错是模拟执行服务最可怕的故障</b>——它不会报警，只会安静地返回错误结果。</p>' +
        T.note('warn', '⚠️ 别忘了 unidbg 是「实验性」项目', '<p>作者自己写着 <span class="mono">Use it at your own risk !</span>。服务化时要有心理准备：<b>目标 so 更新一次，你的服务可能就得跟着重调一次补环境</b>。把「so 版本」当成服务的一个显式配置项来管理，比事后救火强得多。</p>') +
        '<p>顺带一提，unidbg 近期加入了 <b>MCP（<span class="term" data-def="Model Context Protocol：让 AI 工具与外部系统对接的协议。unidbg 在 debugger 激活后输入 mcp 即可启动 MCP server。">Model Context Protocol</span>）支持</b>用于 AI 辅助调试：在 debugger 激活时于控制台输入 <span class="mono">mcp</span> 即可启动 MCP server，让 AI 工具连接后进行<b>寄存器读写、反汇编、内存搜索、断点、trace、函数调用</b>等操作。<span class="pill acc">这是很新的能力</span> 它的意义在于：补环境这件事原本高度依赖「反复看日志 + 猜」，而现在可以把这些观测动作交给能自动迭代的工具体系来做——<b>调试循环的速度，往往比单次操作的效率更决定成败</b>。</p>',
      quiz: {
        id: 'q7-5', chapter: 7, answer: [0, 2],
        stem: '关于把 unidbg 封装成远程服务，下列说法<b>正确</b>的有哪些？<span class="small muted">（多选）</span>',
        options: [
          { t: '直接全局共享一个 AndroidEmulator 实例最省资源，推荐这么做', why: '错。AndroidEmulator 不是线程安全的，并发共享会出乱子。官方给的正解是 Worker Pool。' },
          { t: '应该用 Worker Pool 复用 emulator 实例，避免每次请求重复初始化', why: '对。Worker Pool 是线程安全的对象池，既避免重复初始化开销，又保证并发安全。' },
          { t: '服务应该内置真机样本对做自校验，因为模拟执行可能静默返回错误结果', why: '对。模拟执行最危险的失败模式是不崩溃但算错——补错环境、跳过 JNI_OnLoad、某个符号用了 stub，都会让输出「格式正常但内容错误」。没有自校验就无法察觉。' },
          { t: '只要 unidbg 脚本在本地跑通了，服务化之后就不需要再维护了', why: '错。so 更新、依赖变化都可能让补环境失效，且 unidbg 自称实验性项目，需要持续维护与回归验证。' }
        ],
        explain: '<b>本题正确答案是第 2、3 项。</b><br>两个要点：<br><b>① 并发正确性：</b>emulator 实例不是线程安全的，且初始化昂贵。Worker Pool 用对象池同时解决这两个问题——这是 unidbg 官方为服务化场景准备的机制。<br><b>② 结果正确性：</b>模拟执行会<b>静默算错</b>。补环境不完整、<span class="mono">JNI_OnLoad</span> 没跑、某个符号用了 stub，都可能让输出「格式正常但内容错误」。内置样本对自校验是唯一能在线上发现的机制。<br>把这两条合起来看，你会发现服务化真正的难点不在「怎么调函数」，而在<b>「怎么保证每一次调用的结果都还是对的」</b>。'
      }
    },

    /* ================= 21.12 ================= */
    {
      h: '21.12',
      title: '决策演练：迁移、崩溃与保真度',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境二',
            scenario: '<b>情境：</b>你已经用 Frida RPC 在真机上跑通了目标加密函数，并采集了 <b>20 组「输入 → 输出」样本对</b>。现在想迁到 unidbg 做批量调用。<br><br>写第一版脚本时，你应该是怎样的推进顺序？',
            choices: [
              { t: '一次性把所有环境补全：实现几十个 syscall、造完整的 JNIEnv 表、把可能用到的 Java 类全部伪造好，然后再跑', next: 'n1' },
              { t: '先把 Frida 采到的样本对拿来，跑通最小可执行路径，每崩一次只补一个依赖，每补一个就用样本对回归一次', next: 'n2' },
              { t: '先不管 unidbg，把 so 拖进 IDA 把算法彻底看懂，再用 Python 完整重写一遍', next: 'n3' },
              { t: '直接照着网上的现成 unidbg 脚本改，反正目标都是 ARM64 的 so，环境应该差不多', next: 'n4' }
            ]
          },
          n1: {
            label: '选 A：一次性补全', terminal: true, verdict: 'bad',
            verdictTitle: '最贵的错：把「按需补」做成了「预补」',
            result: '<b>认知根源：把工程量的不确定性，用「多做事」来对冲。</b>这个直觉在别的领域往往有效，在补环境里恰恰相反——因为你<b>根本不知道哪些是需要的</b>。<br><br>后果有三层：<br>① <b>大量无效工作</b>。一个 so 实际用到的 syscall 常常只有个位数，你写的另外几十个永远不会被执行。<br>② <b>你写的每一行都是新的 bug 来源</b>。而且这些 bug 只在你「以为需要」的路径上，一旦被触发，崩溃点离病因极远，调试成本呈指数上升。<br>③ <b>最致命的一点：你的实现细节会污染结果</b>。你精心写的 <span class="mono">mmap</span> 分配器可能返回了不同的地址布局，你实现的 <span class="mono">clock_gettime</span> 返回了不同的时间——这些都可能让 so 走上与真机不同的分支，最终算出<b>格式正常但内容错误</b>的结果。<br><br><b>正确做法：</b>让 so 自己告诉你缺什么。跑 → 崩 → trace 定位 → 只补这一个 → 回归。<b>你的环境应该长得像「so 实际用到的那一小撮」，而不是「一个完整的 Linux」。</b>'
          },
          n2: {
            label: '选 B：按需补 + 样本对回归', terminal: true, verdict: 'good',
            verdictTitle: '正确：让样本对当路标，让崩溃当需求',
            result: '<b>这是唯一能在可控成本内收敛的推进方式。</b>三个要素各司其职：<br><br><b>① 样本对是路标。</b>没有它，你根本不知道自己走在正确还是错误的路上——因为模拟执行会静默算错。每补一个依赖就用 20 组样本回归一次，你随时知道「现在到哪了」。<br><br><b>② 崩溃是需求。</b>模拟执行的美妙之处在于：缺什么它就崩什么，绝不藏着。每次崩溃都精确地告诉你「下一个要补的依赖是 X」。补环境因此不是一个需要规划的工程，而是一个<b>自带需求生成器的迭代过程</b>。<br><br><b>③ 一次只补一个。</b>如果你一次改了三个地方再跑，跑出来的结果变了，你无法判断是哪一个改动起了作用。这是所有调试工作的通用纪律。<br><br><b>补齐顺序建议：</b>先 <span class="mono">JNI_OnLoad</span> 能正常返回 → 再让目标函数能被调用 → 再让结果对上样本。每一层都是下一层的健康前提，不要跳级。'
          },
          n3: {
            label: '选 C：IDA 看懂后重写', terminal: true, verdict: 'bad',
            verdictTitle: '方向反了：你已经有能用的东西，却去要一个更难的',
            result: '<b>认知根源：低估了静态分析的难度，高估了自己的收益。</b>既然 Frida RPC 已经跑通、样本对已经采到，说明「调用能力」你已经拿到了。这时去做全量静态还原，是在<b>放弃一个已经解决的问题，去换一个更难的问题</b>。<br><br>而且现实是：目标 so 大概率有 ollvm 混淆、字符串加密、控制流平坦化。想「彻底看懂」可能要花上几周，而 unidbg 迁移可能只需要一天。<br><br><b>更要紧的是黑盒调用的定位（见 21.9）：</b>工程上你需要的是「给定明文产出密文」的能力，不是「知道它用了什么魔改算法」。<b>你已经有的能力，就是你要的东西。</b><br><br><b>什么时候静态分析才真正必要？</b>当算法会<b>持续升级</b>、你需要快速跟进时；当黑盒调用的成本（设备、速度、稳定性）已经无法承受时；当你需要审计它有没有上传隐私数据时。<b>这些理由都成立，但「我先看懂再动手」不是其中之一。</b>'
          },
          n4: {
            label: '选 D：照抄网上的脚本', terminal: true, verdict: 'bad',
            verdictTitle: '经验主义的陷阱：目标换了，环境就得重来',
            result: '<b>认知根源：把「架构相同」当成了「环境相同」。</b>ARM64 是<b>指令集</b>相同，不是<b>依赖</b>相同。两个 so 都编译成 ARM64，一个可能只调 <span class="mono">malloc</span> 和 <span class="mono">memcpy</span>，另一个可能做几十次 JNI 回调、读 <span class="mono">/proc/self/maps</span> 做完整性校验、用 <span class="mono">SVC</span> 直接发起自定义调用。<br><br>而且这里有一个<b>非常危险的副作用</b>：照抄的脚本里往往带着原作者为<b>他的目标</b>写的桩函数。这些桩会安静地运行在你的目标上——比如一个「<span class="mono">clock_gettime</span> 返回固定值」的实现，在原目标的算法里无害，在你的目标里可能触发一条完全不同的分支。<b>结果是：不崩溃，但结果错。</b>这正是最难发现的一类故障。<br><br><b>那参考脚本该怎么用？</b>把它当<b>骨架</b>用，不当<b>答案</b>用。21.8 那九步是通用的，照着搭；但每一类依赖「补什么、补成什么样」，必须由<b>你自己的 trace 和日志</b>决定。<b>环境是每个 so 私有的，没有通用解。</b>'
          }
        }
      }
    },

    /* ================= 21.13 ================= */
    {
      h: '21.13',
      title: '决策演练：当结果和真机对不上',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境三',
            scenario: '<b>情境：</b>unidbg 脚本终于不崩了，目标函数也能返回结果。但你拿真机 Frida RPC 采的 20 组样本对一比对——<b>20 组全对不上</b>。结果格式看起来完全正常（长度对、像密文），只是内容不对。<br><br>没有异常、没有崩溃、没有 ERROR 日志。你接下来先查什么？',
            choices: [
              { t: '先确认 JNI_OnLoad 真的成功返回了、以及加载的 so 与真机是同一份，再去逐项排查环境差异', next: 'n1' },
              { t: '怀疑是参数传错了，先把参数类型和寄存器布局反复调整，多试几种组合', next: 'n2' },
              { t: '认为 unidbg 对这种 so 就是不支持，直接放弃迁移', next: 'n3' },
              { t: '既然是黑盒，结果不对也无所谓，把 unidbg 的返回值改成从真机 RPC 转发过来就行', next: 'n4' }
            ]
          },
          n1: {
            label: '选 A：先验证前提条件', terminal: true, verdict: 'good',
            verdictTitle: '正确：先排除「前提不成立」，而不是在结果层瞎猜',
            result: '<b>这是排查「静默算错」的第一性顺序。</b>结果错了，说明从「加载」到「调用」这条链上有一环和真机不同。而排查必须<b>从链条最上游开始</b>——因为上游错了，下游的一切观察都是无意义的噪音。<br><br><b>上游两个必须最先确认的前提：</b><br>① <b><span class="mono">JNI_OnLoad</span> 成功了吗？</b>仔细看它的返回值。返回 0 或负数意味着 so 没认可这个假 VM，初始化逻辑没走完（字符串解密表没建、native 方法没注册、全局状态没准备）。这种情况下调业务函数，地址可能都还指向未初始化的桩——<b>结果必然是错的，而且不会崩</b>。<br>② <b>so 是同一份吗？</b>把你加载的 so 的符号地址 / 校验值，和真机上抓到的那份比一比。同名不同版本、或者你拿到的是加固后的壳 so，结果当然对不上。<br><br><b>然后是环境差异的逐项比对：</b>Android API 版本（<span class="mono">AndroidResolver</span> 的参数）是否与真机一致？so 读时间了吗？读 <span class="mono">/proc</span> 了吗？有没有走 <span class="mono">getpid</span> / <span class="mono">getrandom</span> 这类「每次不同」的调用？<b>凡是「返回值不确定」的依赖，都可能是分歧点。</b><br><br>顺序心法：<b>先证明「它在正确地跑」，再追问「它为什么算得不一样」。</b>'
          },
          n2: {
            label: '选 B：反复调参数组合', terminal: true, verdict: 'bad',
            verdictTitle: '症状层打转：在没确认前提的情况下穷举参数',
            result: '<b>认知根源：把「静默算错」当成了「参数问题」，于是用穷举代替诊断。</b>参数错的确会导致结果错——但参数错通常还有一个特征：<b>结果会剧烈变化或者直接崩溃</b>。而「格式完全正常、只是内容不对、且 20 组一致地不对」，更像是一个<b>确定性的环境差异</b>：so 里某个值从一开始就不同，然后一路确定性地算错。<br><br>穷举参数组合的代价极高：寄存器布局、类型、长度、字节序……组合空间是乘法级的，而你每试一次都要重新跑一遍，几乎没有信息增益。<b>这是典型的「用工作量掩盖判断力缺失」。</b><br><br><b>正确的诊断路径：</b>拿一组样本，在真机和 unidbg 上<b>同时观察中间状态</b>——真机端用 Frida hook 关键中间函数（或者 hook 那个加密函数的入参内存），unidbg 端挂 trace 或 Dobby inline hook 看同样位置的值。<b>找到第一个出现分歧的点</b>，那才是病因所在。第一处分歧往往是：一个时间戳、一个随机数、一个从 Java 层拿到的常量、或者一段本该被 <span class="mono">JNI_OnLoad</span> 解密但没解密的字符串。<br><br><b>关键区别：</b>调参数是「猜」，找第一处分歧是「看」。永远选后者。'
          },
          n3: {
            label: '选 C：直接放弃', terminal: true, verdict: 'bad',
            verdictTitle: '过早归因：把可诊断的问题当成了工具的能力上限',
            result: '<b>认知根源：缺少诊断框架，于是把「我不知道怎么查」等同于「工具做不到」。</b>这两件事完全不同。unidbg 确实有它的能力边界，但「不崩溃、结果不对」这个现象<b>远在边界之内</b>——它是最常见、也最有章法可查的一类故障。<br><br>更实际的问题是：放弃之后你有更好的选择吗？回 Frida RPC？那意味着彻底放弃并发与设备无关性，而你的原始需求（高并发）恰恰是当初迁移的理由。<b>你只是把问题退回了起点。</b><br><br><b>该怎么建立诊断框架？</b>按「结果不对」的可能成因分层：<br>① <b>输入层</b>：参数类型、编码、长度（尤其是含 <span class="mono">\0</span> 或非 ASCII 时）。<br>② <b>初始化层</b>：<span class="mono">JNI_OnLoad</span> 是否真成功、so 版本是否一致。<br>③ <b>环境层</b>：时间、随机数、<span class="mono">/proc</span>、syscall 返回值——一切「不确定」的依赖。<br>④ <b>Java 交互层</b>：native 回调 Java 时，你的假类返回的值与真机是否一致（这是重灾区，且极易被忽略）。<br>按这个顺序逐层排除，绝大多数「结果不对」都能定位到具体某一行。<br><br><b>知道工具的能力边界很重要，但别把「自己还没查」误判成「工具不行」。</b>'
          },
          n4: {
            label: '选 D：改成转发真机结果', terminal: true, verdict: 'bad',
            verdictTitle: '自欺：把「模拟执行」退化成了「真机代理」，问题一个没解决',
            result: '<b>认知根源：把「让测试通过」当成了目标，而不是「让系统正确」。</b>这个方案在实践中确实有人用（真机做后端、unidbg 做前端），但它<b>不是模拟执行的解决方案</b>，而是彻底放弃了模拟执行。<br><br>代价清单：<br>① 你依然依赖设备——而设备依赖正是当初要迁移走的原因。<br>② 速度、并发、稳定性<b>一点没改善</b>，反而多了一层转发开销和新的故障点。<br>③ 你还需要维护两条链路（真机侧和 unidbg 侧），成本翻倍。<br>④ 最要命的：<b>你的 unidbg 脚本还是错的</b>。它会在某个更新后悄悄开始返回另一种错误结果，而你因为「反正真实结果来自真机」而毫无察觉，直到某天真机挂了，你才发现自己手里那条备选路径从来没通过验证。<br><br><b>那「真机做后端」这个模式什么时候成立？</b>当它是<b>有意的降级架构</b>时——比如真机池 + unidbg 兜底，且两条路径<b>都经过同一套样本对验证</b>。这时它是容灾设计，不是逃避。<br><br><b>区别只在一句话：你有没有让 unidbg 的结果也对上。</b>对上了，它是冗余；没对上，它是伪装成解决方案的技术债。'
          }
        }
      }
    },

  ],

  glossary: [
    { t: 'Capstone', d: '反汇编框架：把机器码翻译成汇编文本。常与 Unicorn 配合，在 hook 里把每条指令反汇编出来做 trace。' },
    { t: 'Unicorn', d: '基于 QEMU TCG 的 CPU 模拟器。<b>只模拟 CPU，不模拟系统</b>——内存要自己 map，syscall 要自己实现，函数调用要自己安排。' },
    { t: 'Keystone', d: '汇编框架：把汇编文本变成机器码，Capstone 的逆运算。用来在模拟器里现场造几行桩指令。' },
    { t: '补环境', d: '把目标 so 对外部的每一处依赖（库函数、syscall、JNIEnv 表、JavaVM、Java 类）在模拟器里手工实现出来的过程。成本高低直接决定该选哪个工具。' },
    { t: 'JNIEnv', d: '指向「只有一个成员的函数表结构体」的指针，实际是二级指针。表里每个固定槽位对应一个 JNI 函数。真机上指向 ART 实现，模拟环境里指向你自己的桩——正因为位置固定、实现可换，模拟执行才成立。' },
    { t: 'JavaVM', d: '另一张函数表（GetEnv、AttachCurrentThread 等），作为 <span class="mono">JNI_OnLoad</span> 的第一个参数传入。调 JNI_OnLoad 前必须先伪造它。' },
    { t: 'JNI_OnLoad', d: 'so 加载时由系统调用的初始化入口，负责注册 native 方法、解密字符串、准备全局状态。模拟执行时必须让它跑完，否则业务函数结果常常静默出错。' },
    { t: 'UC_HOOK_INTR', d: 'Unicorn 的中断钩子。so 执行 SVC 时触发，让你有机会按系统调用号（AArch64 在 X8，ARM32 在 R7）分发到自己实现的处理函数。' },
    { t: 'AndroidNativeEmu', d: 'Python 项目（AeonLucid/AndroidNativeEmu），基于 Unicorn + Keystone，把①库函数②syscall③JNIEnv④JavaVM 框架化。官方自称 educational project，「partly emulate」。' },
    { t: 'unidbg', d: 'Java 项目（zhkl0228/unidbg），一体化 native 模拟执行框架：内置 ELF 加载、syscall 模拟、JNIEnv/JavaVM 实现、DalvikVM 假虚拟机。支持多后端（Unicorn / dynarmic / M1 hypervisor / Linux KVM）、gdb stub、trace、内存泄漏检测、Worker Pool 与 MCP 调试。' },
    { t: 'Dobby / xHook', d: '<b>Dobby</b>（jmpews/Dobby）是轻量级多平台 inline hook 框架，unidbg 用它实现 native 函数的 inline hook；<b>xHook</b>（iqiyi/xHook）是爱奇艺开源的 Android PLT/GOT hook 框架，unidbg 用它实现 import hook——也就是自动化的「补库函数」。' },
    { t: '黑盒调用', d: '不还原算法逻辑，只把 so 当函数用：喂输入、取输出。落地形态有 Frida RPC（真机）与 unidbg（PC）两种，选择取决于补环境成本。' }
  ],

  teacher: {
    id: 'ch7', chapter: 7,
    name: '追问老师 · 第 21 章',
    sub: '模拟执行不是「高级 Frida」——要能说清它到底模拟了什么、缺了什么、代价在哪',
    intro: '<p style="margin:0">这一章我会盯住三件事追问：<b>Unicorn 到底模拟了什么</b>、<b>补环境补的究竟是什么</b>、<b>什么时候该用它、什么时候不该</b>。答不上来不要紧，但别用「反正 unidbg 能跑」这种话糊弄过去——工具会崩的那天，你手里得有判断力。</p>',
    questions: [
      {
        id: 'c7q1', depth: 1, threshold: 0.7,
        q: '用一句话说清 <b>Unicorn 模拟了什么、没模拟什么</b>。这个「没模拟」的部分，在实战中会以什么形式暴露出来？',
        concepts: [
          { label: '只模拟 CPU，不模拟系统',
            hint: '它和 Android 模拟器、虚拟机的根本区别在哪？',
            any: ['只模拟cpu', '只做cpu', '不模拟系统', '不做系统模拟', '没有操作系统', '没有系统', '不是模拟器', 'cpu模拟器', 'cpu emulator', '只模拟cpu不模拟系统', '只有cpu', '没有os', '无操作系统', '不模拟安卓', '不模拟android'] },
          { label: '内存要自己 map',
            hint: '地址空间是谁给的？',
            any: ['mem_map', 'mapping', '内存要自己', '自己映射', '手动映射', '映射内存', 'map内存', '地址空间', '页对齐', 'page align', '自己分配内存'] },
          { label: '系统调用要自己实现',
            hint: 'so 执行 SVC 的时候，谁来回话？',
            any: ['svc', 'syscall', '系统调用', '系统调用号', 'hook_intr', 'uc_hook_intr', '中断钩子', '自己实现系统调用', '内核', 'kernel'] },
          { label: '库函数与运行前提缺失，表现为崩溃',
            hint: 'malloc、memcpy 这些在模拟器里存在吗？缺了会怎样？',
            any: ['malloc', 'memcpy', 'libc', '库函数', '崩溃', 'crash', '崩', '非法内存', 'unmapped', '未映射', '跳到野地址', '访问非法', 'memory access', '补环境', '栈', 'sp', '栈指针'] },
          { label: '「什么都没有」反而是优点：可控、无副作用、可单步',
            hint: '一个没有任何干扰的环境，对调试意味着什么？',
            any: ['可控', '完全可控', '无副作用', '没有副作用', '可复现', '确定性', '单步', 'trace', '无干扰', '没有反调试', '轻量', '可嵌入', '没有干扰', '干净'] }
        ],
        hints: [
          '把它和「Android 模拟器」「虚拟机」区分开：它连一个操作系统都没有。',
          '想想你第一次写 Unicorn 脚本时，除了 mem_map 还漏了什么？崩溃是怎么表现出来的？'
        ],
        probes: [
          '既然它什么都没有，为什么还说这是优点？举一个真机调试做不到、而它能做到的事。',
          '如果目标 so 的第一条指令就访问了未映射内存，你的排查顺序是什么？'
        ],
        model: 'Unicorn 是<b>只模拟 CPU、不模拟系统</b>的模拟器。它基于 QEMU 的 TCG 引擎，做的事情非常单纯：读一条指令、按指令语义改寄存器和内存。除此之外什么都没有——没有内核、没有 libc、没有进程概念、没有线程调度，甚至连「内存」本身都不存在，只有一片由你亲手划定的地址空间。<br><br>具体缺四样东西：<b>① 内存</b>，要用 <span class="mono">mem_map</span> 一段段映射，地址和大小必须页对齐；<b>② 系统调用</b>，so 执行 SVC 时 CPU 会停下来触发 <span class="mono">UC_HOOK_INTR</span>，等你按系统调用号（AArch64 在 X8，ARM32 在 R7）分发处理；<b>③ 库函数</b>，<span class="mono">malloc</span>、<span class="mono">memcpy</span>、<span class="mono">strlen</span> 统统不存在，要靠 hook 导入表或改写 GOT 接上你自己的实现；<b>④ 栈</b>，连 SP 都要你自己设，而真实函数几乎第一条指令就要压栈。<br><br>这些缺失在实战中的暴露形式高度一致：<b>跳到未映射地址、访问非法内存、emu_start 抛异常</b>。典型症状是「第一条指令就崩」——十有八九是没设 SP 或没 map 栈。诊断的正解是<b>先挂 UC_HOOK_CODE 打开 trace 再跑</b>，崩溃前最后几条指令会直接指出它想访问哪里。<br><br>但「什么都没有」恰恰是它最大的优点：<b>完全可控</b>（环境变量全由你决定）、<b>无副作用</b>（不写文件、不发网络）、<b>完全可复现</b>（同输入必同输出）、<b>可单步可 trace</b>（逐指令级观测，真机做不到这么干净）。再加上没有真正的反调试语义——so 里那些检查 ptrace、读 /proc 的代码在模拟环境里根本得不到真实反馈。<b>代价就是环境要你自己搭，这正是「补环境」的全部由来。</b>',
        after: '<p>记住这个比例：一个完整的 Unicorn 脚本里，七步中有四步都在「造环境」，真正执行的只有 <span class="mono">emu_start</span> 一行。<b>模拟执行的工作量，九成在环境，一成在执行。</b></p>'
      },
      {
        id: 'c7q2', depth: 2, threshold: 0.7,
        q: '<b>补环境</b>到底在补什么？请把需要补的依赖<b>分类</b>说清楚，并说明每一类用什么手段接入。',
        concepts: [
          { label: '库函数：hook 导入表 / 改写 GOT',
            hint: 'malloc、memcpy、strlen 这些调用，怎么让它跳到你的实现？',
            any: ['malloc', 'memcpy', 'memset', 'strlen', 'strcmp', 'libc', '库函数', '导入函数', 'got', 'got表', 'plt', 'xhook', 'import hook', '符号表', 'symbol table', '改写got', 'hook导入'] },
          { label: '系统调用：UC_HOOK_INTR 拦截 + 按调用号分发',
            hint: 'so 执行 SVC 的时候，Unicorn 会给你什么信号？怎么知道它要干什么？',
            any: ['svc', 'syscall', '系统调用', 'uc_hook_intr', 'hook_intr', '中断', '调用号', 'x8', 'r7', 'open', 'read', 'write', 'mmap', 'clock_gettime', 'gettimeofday', '分发'] },
          { label: 'JNIEnv 函数表：造一张函数指针数组指向自己的桩',
            hint: 'JNIEnv 的结构是什么样的？真机上那些指针指向谁？',
            any: ['jni', 'jnienv', '函数表', '函数指针', '指针数组', '函数指针数组', 'findclass', 'getmethodid', 'callobjectmethod', 'getstringutfchars', '桩', '桩函数', 'stub', '伪造', '假表', '槽位'] },
          { label: 'JavaVM：JNI_OnLoad 的第一个参数，同样要伪造',
            hint: '想调 JNI_OnLoad，它的第一个参数从哪来？',
            any: ['javavm', 'java vm', 'jni_onload', 'getenv', 'attachcurrentthread', '第一个参数', '初始化', '注册native', '注册 native'] },
          { label: 'Java 层类与方法：伪造假类（unidbg 的 resolveClass）',
            hint: 'native 代码回调 Java 层时，那些类和方法在模拟器里存在吗？',
            any: ['resolveclass', '假类', '伪造类', '伪造java', 'java类', 'java层', 'java 层', '回调java', '回调 java', 'dalvikvm', 'string.getbytes', 'getbytes', 'messagedigest', 'fakedclass', '模拟java', '假java', 'java方法'] },
          { label: '按需补 + 保真度够用即可，不要预补',
            hint: '是把所有 syscall 都实现一遍，还是先看它到底调了什么？',
            any: ['按需', '按需补', '需要什么补什么', '不要预补', '先trace', '先看日志', 'verbose', '够用', '保真度', '迭代', '逐项', '崩了再补', '缺失才补', '不过度', '够用就行', '简化实现'] }
        ],
        hints: [
          '按「系统层 / 虚拟机层 / Java 业务层」三个层次去分，会清楚很多。',
          '每一类都问一句：真实环境里是谁在接这个调用？把它换成我行不行？'
        ],
        probes: [
          '五类里哪一类最难补？为什么说它的难度是「质」上的而不是「量」上的？',
          '什么叫「保真度够用就行」？举一个可以极度简化、和一个不能简化的依赖做对比。'
        ],
        model: '补环境就是<b>把目标 so 对外部的每一处依赖，在模拟器里手工实现出来</b>。Unicorn 里什么都没有，所以这些依赖对应的地址根本没映射——一碰就崩。按性质一共五类：<br><br><b>① 库函数（系统层）。</b><span class="mono">malloc</span> / <span class="mono">free</span> / <span class="mono">memcpy</span> / <span class="mono">memset</span> / <span class="mono">strlen</span> / <span class="mono">strcmp</span>。做法是加载 so 时 hook 这些导入函数——在 <span class="mono">UC_HOOK_CODE</span> 里对这些地址单独拦截，或直接<b>改写 GOT 表</b>让指针指向你的实现。注意 <span class="mono">malloc</span> 不能随便返回一个常量地址，必须真的从一个你自己管理的堆里分配，否则后续 memcpy / free 对不上。<br><br><b>② 系统调用（系统层）。</b>在 <span class="mono">UC_HOOK_INTR</span> 里拦截 <span class="mono">SVC</span>，按调用号分发：<b>AArch64 的号在 X8，ARM32 在 R7</b>。需要 <span class="mono">open</span> / <span class="mono">read</span> / <span class="mono">write</span> / <span class="mono">mmap</span> / <span class="mono">gettimeofday</span> / <span class="mono">clock_gettime</span> 等。三个常见坑：忘记把返回值写回 X0、忘记推进 PC（死循环）、把 64 位和 32 位的编号体系搞混。<br><br><b>③ JNIEnv 函数表（虚拟机层）。</b><span class="mono">JNIEnv</span> 是一个函数指针数组，真机上指向 ART 实现。模拟环境里造一张表，把 <span class="mono">FindClass</span>、<span class="mono">GetMethodID</span>、<span class="mono">CallObjectMethod</span>、<span class="mono">GetStringUTFChars</span> 等指向自己的桩函数。关键在于<b>只有被真正调用的槽位才需要认真实现</b>，其余放一个「调用即报错」的哨兵。<br><br><b>④ JavaVM（虚拟机层）。</b>它是 <span class="mono">JNI_OnLoad</span> 的第一个参数，同样是函数表（<span class="mono">GetEnv</span>、<span class="mono">AttachCurrentThread</span>）。不伪造它，so 的初始化就跑不完。<br><br><b>⑤ Java 层类与方法（业务层）。</b>native 回调 Java 时，你要伪造这些类和方法，unidbg 提供 <span class="mono">vm.resolveClass()</span> 这类 API。<b>这类最难</b>，因为你要猜出它的行为——而那个行为可能正是你要还原的算法的一部分。<br><br><b>两条纪律：</b>一是<b>按需补</b>，先 trace 看它到底调了什么，绝大多数 so 只用个位数的依赖；二是<b>保真度够用即可</b>，时间函数返回固定值往往就够，追求完整内核语义是过度工程。<b>补不动的依赖就是边界——那时该换 Frida RPC，而不是继续硬补。</b>',
        after: '<p>把五类依赖和工具对上号：<b>Unicorn 裸写</b>＝①②③④全部自己来；<b>AndroidNativeEmu</b>＝①②③④框架化，⑤自己来；<b>unidbg</b>＝①②③④内置，还额外帮你把⑤的大部分（DalvikVM 假虚拟机）也兜住了。</p>'
      },
      {
        id: 'c7q3', depth: 2, threshold: 0.7,
        q: '为什么说 <span class="mono">JNIEnv</span> 是一张「可以被整体替换的函数表」？这个性质对模拟执行意味着什么？',
        concepts: [
          { label: 'JNIEnv 是二级指针，指向只有一个成员的结构体',
            hint: 'C 代码里 (*env)->FindClass(env, ...) 为什么要解引用两次？',
            any: ['二级指针', 'two level', 'double pointer', '结构体', '只有一个成员', '两次解引用', '解引用两次', '指针的指针', 'functions', '函数表指针'] },
          { label: '表里槽位固定，每个位置对应一个 JNI 函数',
            hint: 'native 代码靠什么找到 FindClass？符号名还是位置？',
            any: ['槽位', '索引', '位置', '固定', '偏移', '序号', '下标', 'slot', 'index', 'jni规范', 'jni 规范', '不靠符号', '按位置', '按偏移', '函数指针数组'] },
          { label: '真机指向 ART 实现，模拟环境指向自己的桩',
            hint: '接电话的到底是谁，native 代码在意吗？',
            any: ['art', '真机', '假表', '桩', 'stub', '自己的实现', '替换', '伪造', 'fake', '模拟环境', '指向自己的', '接上自己的'] },
          { label: '位置固定 + 实现可换 ⇒ 调用被降维成本地函数调用',
            hint: 'FindClass 在你的环境里变成了什么操作？',
            any: ['降维', '本地调用', '普通函数调用', '查表', '自己的表', '假类表', '变成查表', '挂钩', '拦截', '可控', '不再需要虚拟机'] },
          { label: '由此 JNI_OnLoad / JavaVM 也同构，可以伪造出可用的初始化环境',
            hint: '既然 JNIEnv 能换，JavaVM 呢？JNI_OnLoad 的第一个参数从哪来？',
            any: ['javavm', 'java vm', 'jni_onload', '同样', '同构', '也是函数表', '第一个参数', '伪造一个', '假vm', '假 vm', '初始化'] }
        ],
        hints: [
          '想清楚 JNIEnv* 解引用两次分别拿到什么。',
          'native 代码是用「名字」找函数的，还是用「位置」找的？这一点为什么关键？'
        ],
        probes: [
          '如果 JNI 表的槽位不是固定的（每个版本都不一样），模拟执行还能成立吗？',
          '在 Unicorn 里手动调一个 JNI 函数前，你必须先往 X0 写什么？忘了会怎样？'
        ],
        model: '<span class="mono">JNIEnv*</span> 的真身是<b>二级指针</b>：它指向一个结构体，而这个结构体<b>只有一个成员</b>——一个指向函数指针数组的指针。所以 C 代码里要写 <span class="mono">(*env)-&gt;FindClass(env, ...)</span>：第一次解引用拿到结构体，第二次从数组里取出目标槽位的函数指针。这个绕的设计，正是 JNI 为「实现可替换」付出的代价，也是它最精妙的地方。<br><br><b>关键性质是「位置固定」。</b>表里每一个槽位对应哪个 JNI 函数，是 JNI 规范写死的，与 Android 版本、CPU 架构无关。这意味着 native 代码编译之后<b>不再需要符号名</b>——它直接按固定偏移取指针然后调用。这既让 JNI 调用足够高效，也从根本上决定了：<b>谁来接这个电话，native 代码根本不知道，也不关心。</b><br><br>真机上，这些指针全部指向 ART 里的实现：<span class="mono">FindClass</span> 去 dex 里找类，<span class="mono">GetMethodID</span> 解析方法签名，<span class="mono">CallObjectMethod</span> 真进解释器执行 Java 代码。<b>模拟环境里，你把整张表换成自己的桩函数</b>：<span class="mono">FindClass</span> 变成「在你自己维护的假类表里查一下」，<span class="mono">CallObjectMethod</span> 变成「按预设返回一个值」。于是 JNI 调用被<b>降维成了本地函数调用</b>——这是模拟执行能成立的理论基石。<br><br>对实战的直接含义有三条：<br><b>① 你能自己造一个可用的初始化环境。</b><span class="mono">JavaVM*</span> 同样是一张函数表（<span class="mono">GetEnv</span>、<span class="mono">AttachCurrentThread</span>），它是 <span class="mono">JNI_OnLoad</span> 的第一个参数。伪造它，so 的初始化就能跑完。<br><b>② 你知道在哪里下钩子。</b>凡是走 <span class="mono">(*env)-&gt;</span> 的调用都是「环境」范畴，与算法无关；真正的加密逻辑往往藏在那些不碰 JNIEnv、纯算数纯内存操作的函数里。<b>会区分这两类代码，你就知道哪些能模拟、哪些必须补。</b><br><b>③ 手动调用时寄存器布局固定。</b>JNI 函数的第一个参数永远是 <span class="mono">JNIEnv*</span>（ARM64 在 X0），第二个是 <span class="mono">jclass</span> 或 <span class="mono">jobject</span>，<b>业务参数从第三个位置才开始</b>。忘了往 X0 写假 JNIEnv 指针，是新手最经典的崩溃原因。',
        after: '<p>unidbg 的 <span class="mono">DalvikVM</span> 做的核心工作，本质上就是<b>替你造了这张表，并把它接在一个用 Java 写的迷你 ART 上</b>。</p>'
      },
      {
        id: 'c7q4', depth: 2, threshold: 0.75,
        q: '在什么情况下你会选 <b>unidbg 黑盒调用</b>，什么情况下坚持 <b>Frida RPC</b>？给出你的判断依据和行动顺序。',
        concepts: [
          { label: '先评估补环境成本：JNI 回调密度、syscall 种类数、是否读 /proc 自校验',
            hint: '迁移前你靠什么信号判断「这个 so 好不好补」？',
            any: ['补环境', '成本', '评估', '难度', 'jni回调', 'jni 回调', '回调密度', 'syscall', '系统调用', '数量', '种类', 'proc', '自校验', '完整性', 'verbose', '日志', '依赖'] },
          { label: '推荐顺序：先 Frida 验证并采样本对，再决定是否迁移',
            hint: '为什么不直接上 unidbg？先做哪一步能让风险最低？',
            any: ['先frida', '先 frida', '先用frida', '样本', '样本对', '采样', '采集', '黄金', '参照', '参照系', '验证可行性', '先验证', '再迁移', '先跑通', '对比'] },
          { label: 'unidbg 优势：不依赖设备、速度快、可并发、可服务化',
            hint: '真机方案扛不住高并发时，出路在哪？',
            any: ['不依赖设备', '无需设备', '速度快', '快', '并发', '高并发', '服务', '服务化', 'worker pool', 'workerpool', '对象池', '批量', '稳定', '可复现', '长期'] },
          { label: 'Frida RPC 优势：保真度最高，真实环境',
            hint: '真机跑有什么是模拟器永远给不了的？',
            any: ['保真', '保真度', '真实环境', '真机', '反调试', '完整性校验', '不需要补', '省事', '准确', '一致'] },
          { label: '迁移后必须用样本对回归，因为会静默算错',
            hint: 'unidbg 最危险的失败模式是什么？你怎么发现它？',
            any: ['静默', '不报错', '不崩溃', '算错', '结果不对', '回归', '验证', '样本对', '比对', '校验', '自校验', '对不上', '错误结果'] }
        ],
        hints: [
          '把「补环境五类依赖」当成一张体检表：哪几类复杂，就说明成本高。',
          '想想 unidbg 最危险的地方：它什么时候会骗你？'
        ],
        probes: [
          '如果评估结果是「大量 JNI 反射回调 + 几十个 syscall + 读 /proc 自校验」，你会怎么决策？',
          '「先用 Frida 采样」这一步，除了拿样本对，还有什么额外收益？'
        ],
        model: '<b>判断依据只有一个：补环境成本 vs 真机方案的痛点，哪个更贵。</b><br><br>先看 <b>Frida RPC</b>：真机 / 模拟器上跑 App，用 <span class="mono">rpc.exports</span> 把加密函数暴露成 JS 接口，Python 端批量调用。它的优点是<b>保真度最高</b>——环境是真的，反调试、完整性校验、Java 交互全部天然成立。缺点是依赖设备、速度慢、难并发、随时可能被反调试干掉。适合验证可行性、采集样本对、低频调用。<br><br>再看 <b>unidbg 黑盒调用</b>：PC 上加载 so 直接调用。优点是不依赖设备、速度快、可并发、可打包成常驻服务、可无限次复现。缺点是<b>补环境可能很痛苦</b>，而且失败时常常<b>静默返回错误结果</b>而不是报错。适合批量、高并发、长期服务化。<br><br><b>但它们不是二选一，而是流程上的先后。</b>推荐顺序：<br><b>① 先用 Frida RPC 在真机上跑通</b>目标函数，确认它确实可以被成功调用；<br><b>② 采集若干组「输入 → 输出」样本对</b>，作为后续一切的黄金参照；<br><b>③ 同时观察它的依赖特征</b>——native 回调 Java 多不多？syscall 有多少种？有没有读 <span class="mono">/proc</span> 做自校验？<b>这就是补环境难度体检</b>；<br><b>④ 评估可接受 → 迁移 unidbg，用样本对逐组回归验证</b>；评估是「地狱级」→ 继续用 Frida RPC，或者回到静态分析。<br><br>这条顺序的价值在于：<b>它把补环境的不确定性，提前暴露在一个成本极低的阶段。</b>你花半天采样，可能省掉两星期的徒劳补环境。<br><br><b>什么时候必须上 unidbg？</b>当 Frida 路线被物理掐死：需要每秒上千次调用、没有可用设备、反调试太强无法稳定附着、或者要把算法能力封装成对外 HTTP 服务。<b>除此之外，Frida RPC 往往是更省事的选择。</b><br><br>最后一条纪律：<b>没有样本对的 unidbg 迁移等于闭眼开车。</b>unidbg 最危险的失败模式不是崩溃，是静默地算错——补错环境、跳过 <span class="mono">JNI_OnLoad</span>、时间函数返回了不合适的值，它都会给你一个格式正常但内容错误的结果。<b>手里没有真机样本对，你根本发现不了。</b>',
        after: '<p>把这条流程和 21.11 的 Worker Pool 接起来：验证通过 → 上服务 → <b>服务里内置样本对做健康检查</b>，形成一个能自我发现退化的闭环。</p>'
      },
      {
        id: 'c7q5', depth: 3, threshold: 0.75,
        q: '综合题：你的 unidbg 脚本不再崩溃了，目标函数也返回了结果，但用真机采的 20 组样本对比<b>全部对不上</b>——结果格式完全正常，长度对、看起来像密文，只是内容不对，而且没有任何异常或 ERROR 日志。<br><br>请给出你的<b>完整排查方案</b>：从哪一层开始、每一层查什么、怎么判断「找到了第一处分歧」，以及在这个现象背后可能隐藏着一类什么性质的问题。',
        concepts: [
          { label: '确认前提：JNI_OnLoad 是否真的成功返回、so 是否为同一份',
            hint: '排查必须从链条最上游开始。上游错了，下游观察全是噪音。',
            any: ['jni_onload', 'jni onload', '返回值', '返回0', '返回 0', '初始化', 'so版本', 'so 版本', '同一份', '是不是同一个', '校验值', 'hash', 'md5', '基址', '偏移', '前提', '上游'] },
          { label: '分层排查：输入层 → 初始化层 → 环境层 → Java 交互层',
            hint: '把「结果不对」的可能成因分个层次，才不会乱试。',
            any: ['分层', '逐层', '输入层', '参数', '编码', '长度', '初始化', '环境层', '时间', '随机数', '随机', 'proc', 'syscall', 'java交互', 'java 交互', 'jni回调', '假类', '返回值一致', '顺序'] },
          { label: '用 trace / hook 找「第一处分歧点」而不是穷举参数',
            hint: '调参数是「猜」，那什么是「看」？',
            any: ['trace', 'hook', '第一处', '第一个分歧', '分歧点', '中间值', '对比中间', '同时观察', 'dobby', 'inline hook', '打断点', '断点', '单步', '看而不是猜', '定位'] },
          { label: '静默算错的本质：确定性环境差异，不是随机 bug',
            hint: '20 组一致地不对、格式还正常——这说明错误是什么性质的？',
            any: ['静默', '确定性', '一致的错', '不是随机', '系统性的', '系统性', '环境差异', '确定地错', '不报错', '格式正常', '看起来正常', '隐性', '错误结果'] },
          { label: '最可能的病因候选：时间戳 / 随机数 / 未解密的常量 / 假 Java 类返回值',
            hint: '哪些「在你环境里与真机不同」的值会一路确定性地把结果带偏？',
            any: ['时间', '时间戳', 'timestamp', 'clock_gettime', 'gettimeofday', '随机', 'random', 'urandom', 'getrandom', '常量', '字符串解密', '解密表', '假类', '返回值不同', 'javavm', 'jni_onload没跑', '没跑完', 'sn', '设备信息', 'androidid', 'imei', 'prop'] },
          { label: '结论：黑盒调用的正确性必须靠外部参照系保证，无样本对则不可信',
            hint: '这件事最终教会你什么纪律？',
            any: ['样本对', '参照系', '回归', '校验', '自校验', '外部参照', '健康检查', '不可信', '必须验证', '对比真机', '黄金', '基准', '闭环'] }
        ],
        hints: [
          '先别碰结果。把「从加载到调用」这条链上的每一环，从最上游开始逐个确认——第一步该确认什么？',
          '「20 组一致地不对、格式还正常、不报错」这个现象组合，排除了哪些可能、指向了哪一类问题？',
          'unidbg 端你能看到中间值的手段有哪些？真机端呢？怎么把它们对起来？'
        ],
        probes: [
          '如果你找到了第一处分歧点，发现是 so 在 JNI_OnLoad 里解密出来的一张字符串表在你的环境里没被解密——你怎么验证这个判断？',
          '假设排查到最后发现是「目标 so 读 /proc/self/maps 做了一段完整性自校验，校验不过就切换到一个假算法分支」。这时你会怎么决策？',
          '这道题如果换成「崩溃」而不是「结果不对」，你的排查方案会有哪些不同？'
        ],
        model: '<b>这一类现象有一个专门的名字：静默算错（silent wrong answer）。它是模拟执行最危险、也最有诊断章法的一类故障。</b>先看现象组合给了什么信息：「20 组一致地不对」⇒ 不是随机 bug，而是<b>确定性的环境差异</b>；「格式正常、长度对、像密文」⇒ so 确实跑到了最后，没有走错分支或提前返回；「没有异常和 ERROR」⇒ 所有依赖都「接上了」，只是<b>接错了</b>。三条合起来，指向一个结论：<b>so 里某个输入在你的环境里从第一步就与真机不同，然后被确定性地一路算错。</b><br><br><b>排查必须从链条最上游开始</b>，因为上游错了，下游的一切观察都是噪音。<br><br><b>第一层：前提条件。</b>① <span class="mono">JNI_OnLoad</span> 的返回值是多少？返回 0 或负数意味着 so 没认可这个假 VM——字符串解密表没建、native 方法没注册、全局状态没准备。这种情况下调业务函数，结果<b>必然错且必然不崩</b>。② 你加载的 so 和真机抓的是同一份吗？比校验值。同名不同版本、或者拿到的是壳 so，结果当然对不上。<br><br><b>第二层：环境层的「不确定依赖」。</b>凡是返回值不确定的调用都可能是分歧点：<span class="mono">gettimeofday</span> / <span class="mono">clock_gettime</span>（真机是真时间，你的桩可能是 0 或固定值）、<span class="mono">getrandom</span> / <span class="mono">/dev/urandom</span>、<span class="mono">getpid</span>、以及 <span class="mono">/proc</span> 下的各种文件、设备信息类 <span class="mono">prop</span>。<b>注意：这里不一定要「补得和真机一样」，但要保证「补出来的值能让 so 走进与真机相同的分支」。</b><br><br><b>第三层：Java 交互层（重灾区）。</b>native 回调 Java 时，你的假类返回的值与真机一致吗？<span class="mono">GetStringUTFChars</span> 拿到的字符串对吗？<span class="mono">CallObjectMethod</span> 返回的对象内容对吗？<b>这一层极易被忽略，因为它不崩、不报错，只是安静地返回了一个「合理的默认值」。</b><br><br><b>怎么找「第一处分歧」——这是本题的核心方法。</b>不要穷举参数（那是「猜」）。正确做法是<b>两端同时观察、找第一个不同的中间值</b>：真机端用 Frida hook 关键中间函数的入参/出参或某段内存；unidbg 端用 trace、Dobby inline hook、或用 gdb stub 单步看同样位置。<b>从函数入口往后逐点比对，第一个出现分歧的位置就是病因。</b>更粗暴有效的版本：把 20 组样本的输入逐字节变化，观察输出哪一段先开始不对——差异的起点常常能反推出是哪一步的中间值出了问题。<br><br><b>最后一层结论，也是这件事真正教会你的纪律：</b>黑盒调用的正确性<b>无法自证</b>，必须靠<b>外部参照系</b>（真机样本对）保证。所以任何 unidbg 服务都应该内置样本对做健康检查——因为 so 更新、unidbg 升级、环境配置漂移，都可能在某一天悄悄让结果变成「另一种错误」，而它不会报错。<b>没有参照系的黑盒调用，不是可信的能力，只是看起来能跑。</b>',
        after: '<p>如果最终的病因确认是「so 做了模拟器 / 完整性自校验，校验不过就走假分支」——那已经触到 unidbg 的能力边界了（作者自己也写着 <span class="mono">Use it at your own risk</span>）。这时务实的决策是：<b>退回 Frida RPC 保证生产，把 unidbg 当作探索工具</b>，而不是继续和一套专门针对你的检测机制死磕。</p>'
      }
    ]
  }
};
