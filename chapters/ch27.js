/* 第 27 章数据 —— Smali 汇编与重打包实战
   —— 1w 计划班第四章「了解Smali，ARM」+ 第十三章「APP重打包风险利用实战」
   分工声明：第 3 章讲 ARM/AArch64 机器码与 C++ 对象模型（native 层，so）；
   本章讲 Dalvik/ART 字节码（Java 层，dex）。两章是同一台设备上两种不同的指令语言。 */
window.CHAPTER = {
  no: 27,
  title: 'Smali 汇编与重打包实战',
  lede: 'Smali 是 dex 字节码的<strong>可读文本形式</strong>——它既不是 Java，也不是机器码。' +
        '把它放到"代码表示链"的正确位置上，本章的两个真问题才有答案：' +
        '<strong>为什么一行 Java 会变成两行 Smali</strong>，以及<strong>为什么改完重新签名装上去，App 会直接拒绝运行</strong>。',
  meta: [
    '核心问题：<b>Smali 在代码表示链的哪一环？改成什么样才会真的生效？</b>',
    '关键机制：<b>寄存器模型 / 五条 invoke / new + &lt;init&gt; / 签名与完整性校验</b>',
    '对手：<b>签名校验、完整性校验、加固壳与抽取壳</b>'
  ],

  sections: [

    /* ============================================================ 27.1 */
    {
      h: '27.1', title: '先建立坐标系：安卓虚拟机的两代，与一份代码的六种表示',
      intuition: {
        tag: '直觉模型 · 同一份文稿的六种形态',
        body:
          '<p>你写了一段 Java。这份"文稿"在它被执行的路上，会依次变成六种形态：</p>' +
          '<ul>' +
          '<li><b>手稿</b>（<code>.java</code>）——人写的，人能读</li>' +
          '<li><b>装订稿</b>（<code>.class</code>）——javac 产出，JVM 字节码。注意它<b>也不是</b>安卓要的那份</li>' +
          '<li><b>发行版</b>（<code>classes.dex</code>）——d8 把 class 转成 <b>Dalvik 字节码</b>，这才是 APK 里装的东西</li>' +
          '<li><b>官方译本</b>（<code>oat</code> / <code>vdex</code> / <code>.art</code>）——设备安装后由系统自己生成的派生物</li>' +
          '<li><b>逐句标注版</b>（<code>.smali</code>）——把 dex 的字节码写成人类可读的文本，<b>本章的主角</b></li>' +
          '<li><b>机器方言</b>（ARM/AArch64 指令）——只有 native 的 so 才是这个形态，<b>那是第 3 章的战场</b></li>' +
          '</ul>' +
          '<p>逆向里最常见的两个错位就在这里：<b>用读手稿的习惯去读发行版</b>（以为反编译出来的是源码），' +
          '和<b>用改发行版的力气去改官方译本</b>（对着设备上的 oat 打补丁，然后被系统重建覆盖）。</p>'
      },
      html:
        T.note('key', '🔑 本章的三条边界（先划清楚，后面才不串）',
          '<ol style="margin-bottom:0">' +
          '<li><b>Smali ≠ Java ≠ 机器码。</b>Smali 是 dex 字节码的文本形式。反编译工具给你的"Java 代码"是<b>猜</b>出来的，' +
          'Smali 才是<b>原样</b>的——这就是为什么改不动源码时大家都去改 Smali。</li>' +
          '<li><b>dex 字节码在 Dalvik 和 ART 上是同一套格式。</b>虚拟机换了两代，字节码格式没换。' +
          '所以"Dalvik 字节码"这个名字活到了 ART 时代，你在 Android 14 上反编译出的仍然是它。</li>' +
          '<li><b>本章不碰 ARM 指令。</b>寄存器模型、调用约定、指令编码、vtable、RTTI 都在第 3 章讲了，' +
          '本章不再重复。<span class="hit">同一台手机，两条语言：Java 层说 dex 字节码，native 层说 ARM 机器码。</span></li>' +
          '</ol>') +
        '<p>先看这台"翻译机"的完整流水线。下面这个动画把一份代码的六种形态排成一条链，' +
        '并标出<b>你能改、改了会生效</b>的那一环到底在哪。</p>',
      stage: {
        title: '一份 Java 代码的六种形态 · 改哪一环才有用',
        speed: 1700,
        render:
          '<div class="grid2">' +
            '<div><div class="card-title">① 编译链（往设备里走）</div>' +
            '<div class="flow-col" style="gap:8px">' +
              '<span class="blk" id="aJava">Hello.java<span class="small">人写的手稿</span></span>' +
              '<span class="arrow">↓ javac</span>' +
              '<span class="blk" id="aClass">Hello.class<span class="small">JVM 字节码</span></span>' +
              '<span class="arrow">↓ d8 / R8</span>' +
              '<span class="blk" id="aDex">classes.dex<span class="small">★ Dalvik 字节码</span></span>' +
              '<span class="arrow">↓ aapt2 + zip + 签名</span>' +
              '<span class="blk" id="aApk">app.apk<span class="small">这就是你手里的文件</span></span>' +
              '<span class="arrow">↓ adb install</span>' +
              '<span class="blk" id="aOat">oat / vdex / .art<span class="small">系统自己生成的派生物</span></span>' +
              '<span class="arrow">↓ 运行时</span>' +
              '<span class="blk" id="aRt">解释器 / JIT / AOT 机器码<span class="small">真正在跑的</span></span>' +
            '</div></div>' +
            '<div><div class="card-title">② 逆向链（往回走）</div>' +
            '<div class="flow-col" style="gap:8px">' +
              '<span class="blk" id="aSmali">.smali 文本<span class="small">dex 逐句标注版</span></span>' +
              '<span class="arrow">↑ baksmali / apktool d</span>' +
              '<span class="blk" id="aBack">classes.dex<span class="small">你改的就是它</span></span>' +
              '<span class="arrow">↑ smali 汇编器 / apktool b</span>' +
              '<span class="blk" id="aNew">新的 classes.dex<span class="small">重新汇编出来的</span></span>' +
              '<span class="arrow">↑ 必须重新签名</span>' +
              '<span class="blk" id="aSigned">重签后的 APK<span class="small">签名已经不是原来那个了</span></span>' +
            '</div>' +
            '<div style="margin-top:10px"><span class="pill" id="aNote">先点"单步"，一步步看</span></div>' +
            '</div>' +
          '</div>',
        reset: () => {
          ['aJava','aClass','aDex','aApk','aOat','aRt','aSmali','aBack','aNew','aSigned'].forEach(i => S(i, ''));
          CLS('aNote', 'pill'); SET('aNote', '先点"单步"，一步步看');
        },
        steps: [
          { run: () => S('aJava', 'active'),
            note: '<b>起点：人能读的手稿。</b>这一环只有你（和写它的人）看得见，设备上永远不会出现它。' },
          { run: () => { S('aJava', 'done'); S('aClass', 'active'); },
            note: '<b>javac 产出 .class（JVM 字节码）。</b>注意这只是编译链的中间产物，<b>APK 里没有 .class</b>。' +
              '有人拿到 APK 后到处找 .class，那说明他把 Android 和 Java SE 的打包流程混在一起了。' },
          { run: () => { S('aClass', 'done'); S('aDex', 'hot'); CLS('aNote', 'pill acc'); SET('aNote', '★ 第 3 环：dex，这里是本章的全部舞台'); },
            note: '<b>d8（或带混淆压缩的 R8）把 class 转成 dex：Dalvik 字节码。</b>' +
              '这一环是 APK 里真正装着的"代码本体"。<span class="hit">你改 Smali，改的就是这一环。</span>' },
          { run: () => { S('aDex', 'done'); S('aApk', 'active'); },
            note: '<b>打包 + 签名成 APK。</b>dex 被塞进 zip（可能还有 classes2.dex、classes3.dex……这就是多 dex）。' +
              '签名覆盖全部文件内容，<b>它同时是"身份"和"完整性"两件事的证据</b>——记住这句，27.16 要用。' },
          { run: () => { S('aApk', 'done'); S('aOat', 'wr'); },
            note: '<b>安装到设备后，dex2oat 会把它编译成 oat，并生成 vdex / .art。</b>' +
              '这些是<b>系统按第 3 环自己生成的派生物</b>，不是别人发给你的。' +
              '它们按设备架构、系统版本、编译策略生成——换台机器就不一样。' },
          { run: () => { S('aOat', 'done'); S('aRt', 'active'); },
            note: '<b>运行时真正执行的，可能是 AOT 编译出的机器码，也可能是 JIT 现场编译的，也可能是解释器逐条解释的。</b>' +
              'ART 从来不是"纯 AOT"：它一直保留解释器，Android 7.0 起又加回 JIT，并按运行剖面做分级编译。' +
              '<span class="pill warn">待核实</span> 具体在某台设备上走哪条路径，取决于 profile、编译过滤器和系统策略，' +
              '别靠"我记得是 AOT"来下结论。' },
          { run: () => { S('aRt', 'done'); S('aSmali', 'hot'); CLS('aNote', 'pill cool'); SET('aNote', '逆向链：dex → Smali，可读、可 grep、可改'); },
            note: '<b>换一条路走：baksmali / apktool 把 dex 写成 .smali 文本。</b>' +
              '它不是"反编译成 Java"，而是把字节码<b>逐条</b>换成人看得懂的写法。' +
              '信息不丢、结构不变——这是它比"猜出来的 Java 代码"更可靠的原因。' },
          { run: () => { S('aSmali', 'done'); S('aBack', 'active'); },
            note: '<b>你在 Smali 里改一行，然后用 smali 汇编器（apktool b 内部就是它）重新汇编出一份新的 dex。</b>' +
              '注意这是"<b>重新生成</b>"，不是"原地改字节"。' +
              '<span class="hit">这一点后面会反复用到：改 Smali 不用担心字符串变长、指令长度、对齐——因为它们全都要重算。</span>' },
          { run: () => { S('aBack', 'done'); S('aNew', 'done'); S('aSigned', 'wr'); CLS('aNote', 'pill bad'); SET('aNote', '⚠️ 到这里为止，一切都成功了——麻烦从这里才开始'); },
            note: '<b>新 dex 有了，但它和原 APK 的签名对不上了。</b>你只能用<b>自己的</b>密钥重新签一遍。' +
              '于是 App 看到的签名摘要变了——如果它自己会检查这件事，接下来就是闪退。' +
              '这就是 27.16 的主题，也是"改 Smali 重打包"真正的门槛所在。' }
        ]
      },
      after: T.note('', '🧭 这一节真正要记住的一件事',
        '<p>Smali 不是"另一种语言"，它是<b>同一个东西的另一种写法</b>。' +
        '搞清楚它站在链上的哪一环，你就同时得到了两样东西：' +
        '改它的正确姿势（重新汇编整份 dex），和它的能力边界（只管 Java 层，管不到 so）。</p>')
    },

    /* ============================================================ 27.2 */
    {
      h: '27.2', title: '为什么改包改的是 dex，而不是设备上那份"编译好的代码"',
      html:
        '<p>上一节的动画里有个反直觉的地方：<b>设备上明明有一份已经编译好的机器码，为什么没人去改它？</b>' +
        '答案有三层，每一层都能单独劝退你。</p>' +
        T.tbl(['层级', '它是什么', '为什么打它的主意没用'],
          [
            ['<code>dex</code>', 'APK 里装着的 Dalvik 字节码。<b>唯一的"源"</b>',
             '改它 → 重新汇编 → 重新签名 → <b>有效</b>（代价在签名校验上）'],
            ['<code>vdex</code>',
             'ART 保存的"已验证过的 dex 副本"，装在 <code>/data/app/&lt;包名&gt;/oat/&lt;ISA&gt;/</code> 下',
             '删掉/改了会被重新生成；校验和与 dex 绑定，属于派生物'],
            ['<code>oat</code>',
             'AOT 编译产物，格式是 ELF 容器里装的 OAT 数据，同样在 <code>oat/&lt;ISA&gt;/</code> 下',
             '<b>换台设备/换个系统版本/换个编译策略就得重来</b>；而且系统会按 dex 的变化重建它'],
            ['<code>.art</code>',
             'ART 的 image（启动镜像 / 应用镜像，高版本上才有应用镜像）',
             '同上是缓存性质的产物，属于"系统的账本"，不属于你的可交付物'],
            ['.smali', 'dex 的文本形式（本章主角）', '改它有用，因为它最终会变成新的 dex']
          ]) +
        T.note('bad', '🔥 一个高频误区：对着 dalvik-cache / oat 打补丁',
          '<p>有人脱壳之后直接在设备上改 <code>/data/dalvik-cache</code> 或 <code>oat</code> 目录下的文件，' +
          '改完发现"重启又变回去了"，或者改完这台能用、换台机器就崩。</p>' +
          '<p style="margin-bottom:0">原因很朴素：<b>那些文件是系统按 dex 生成的缓存</b>。' +
          '你改的是"结果"，系统随时会按"原因"重新算一遍结果。<br>' +
          '更麻烦的是它们和设备的指令集、系统版本、编译过滤器绑定——<span class="hit">你在 ARM64 机器上算出来的指令，' +
          '搬到 32 位机器上就是废纸。</span></p>') +
        T.card('那 oat / vdex 到底还有什么用？',
          '<p>对"改包"没用，对"<b>脱壳</b>"极其有用：</p>' +
          '<ul>' +
          '<li><b>抽取壳</b>会把方法体抽走，但 ART 用到它时必须把真指令拿回来——<b>vdex / oat 里往往留着回填后的结果</b>，' +
          '所以脱壳工具会去这些位置找完整 dex（这正是第 2 章 FART 那条路线的落点之一）。</li>' +
          '<li>反过来，你 dump 出来的 dex 用 jadx 打开报 checksum 错误，正是因为它是从内存/缓存里"抢救"出来的，' +
          '文件头的校验值还是旧的（第 2 章实验里算过这件事）。</li>' +
          '</ul>' +
          '<p style="margin-bottom:0"><span class="pill warn">待核实</span> ' +
          '不同 Android 版本上 <code>oat</code> / <code>vdex</code> / <code>.art</code> 的具体文件名与目录布局有变化' +
          '（例如 64 位设备上是 <code>oat/arm64/base.oat</code> 这一类命名），<b>以你目标设备的实际目录为准</b>，别背路径。</p>') +
        T.note('key', '🔑 与第 4 章的分工',
          '<p>这一节只回答"<b>哪一份是可交付的源、哪一份是派生物</b>"。' +
          '至于 ART 内部把这些东西挂到了哪个 C++ 结构上（<code>DexFile</code>、<code>ArtMethod</code>、' +
          '<code>dex_code_item_offset_</code> 这些字段长什么样），是第 4 章 4.2 / 4.6 的内容；' +
          '按安卓大版本追踪这些结构怎么变，是第 12 章的内容。<b>本章不重复，只在需要时指路。</b></p>') +
        T.acc('📖 dex 与它的"名字"：一个容易绕晕的命名事实',
          '<p>你在 Android 14 上反编译 APK，拿到的仍然是<b>叫"Dalvik 字节码"的那套格式</b>，' +
          '文件里写着 <code>dex\\n039\\0</code> / <code>dex\\n040\\0</code> 这样的 magic。</p>' +
          '<p>这不矛盾：<b>Dalvik 是虚拟机（已死），Dalvik 字节码是格式规范（还活着）</b>。' +
          'ART 换掉的是"怎么执行这份字节码"，不是"字节码长什么样"。</p>' +
          '<p style="margin-bottom:0">顺带记住这组版本号（第 2 章实验里用过）：' +
          '<code>035</code> → Android 2.2–4.4；<code>037</code> → 5.0–6.0；<code>038</code> → 7.0–8.0；' +
          '<code>039</code> → 9.0+；<code>040</code> → 10+（与 CompactDex 相关）。' +
          'dex 字节级的结构留给第 28 章，本章只用到"它是一套栈……不，是一套<b>寄存器式</b>字节码"这一点。</p>')
    },

    /* ============================================================ 27.3 */
    {
      h: '27.3', title: 'Smali 是什么、谁生成它：一行字节码的两种写法',
      html:
        '<p>先把两个工具的分工说清楚，很多人卡在这里是因为把它们当成同一个东西用：</p>' +
        T.tbl(['工具', '负责什么', '你什么时候用它'],
          [
            ['<b>baksmali</b> / <b>smali</b>',
              '只做一件事：<code>dex ⇄ smali 文本</code> 的互转（baksmali = 反汇编，smali = 汇编）',
              '只想改代码、不需要碰资源时；它<b>对结构不规范的 dex 容忍度更高</b>（第 2 章脱壳后用过）'],
            ['<b>apktool</b>',
              '把 APK 整个拆开：<code>AndroidManifest.xml</code>、<code>res/</code>、<code>smali/</code>、' +
              '<code>assets/</code>……回编译时再把它们装回 APK',
              '<b>重打包的标准入口</b>：改资源、改清单、改代码，一条龙'],
            ['<b>jadx</b> / <b>JEB</b> 等反编译器',
              '把 dex <b>猜</b>成 Java 源码（结构漂亮，但可能猜错，改不了）',
              '快速看懂逻辑、搜索关键字；<b>它不是用来改的</b>']
          ]) +
        T.note('key', '🔑 一句话分工',
          '<p style="margin-bottom:0"><b>看逻辑用 jadx，改代码用 Smali（baksmali 或 apktool 产出）。</b><br>' +
          'apktool 内部本来就包含 smali/baksmali，所以"用 apktool 反编译出来的 smali"和"用 baksmali 单独反汇编出来的 smali"' +
          '基本是同一批文件——区别只在于 apktool 顺手把资源和清单也拆了。</p>') +
        '<p>下面是本节的核心：<b>同一条指令的两种写法</b>。左边是 dex 里的字节码（opcode + 操作数），' +
        '右边是 Smali 文本。看清楚它们是一一对应的，你就不会再觉得 Smali 是"另一门语言"了。</p>',
      stepper: {
        title: 'dex 字节码 ⇄ Smali 文本：逐条对照',
        lines: [
          {
            code: '<span class="c">; dex 里的 insns 数组（十六进制，小端）</span>\n' +
                  '<span class="n">6E 10 02 00 01 00</span>',
            note: '<b>先看字节码这一侧。</b><code>0x6E</code> 是 <code>invoke-virtual</code> 的 opcode，' +
              '后面两字节是"方法引用索引"（指向 method_ids 表），再后面是寄存器列表编码。<br>' +
              '对人来说这是一串数字，对虚拟机来说是全部信息。' +
              '<span class="hit">注意：它是变长指令，不是 ARM 那种定长 4 字节——这一点和第 3 章读机器码的手感完全不同。</span>',
            state: { 'opcode': '0x6E', '含义': 'invoke-virtual', '长度': '3 个 16 位码元（本例）' }
          },
          {
            code: '<span class="k">invoke-virtual</span> {<span class="r">v0</span>}, ' +
                  '<span class="t">Lcom/demo/app/User;</span>-><span class="f">getName</span>()<span class="t">Ljava/lang/String;</span>',
            note: '<b>同一件事的 Smali 写法。</b>baksmali 把 opcode 查表翻译成名字，把方法引用索引翻译成' +
              '"<b>完整类名 → 方法名(签名)返回值</b>"的可读形式。<br>' +
              '<span class="hit">关键洞察：dex 里存的是"索引"，Smali 里写的是"名字"。' +
              '这决定了 Smali 有一个字节码没有的巨大好处——你可以直接 grep 方法名。</span>',
            state: { '助记符': 'invoke-virtual', '寄存器': 'v0', '方法': 'User.getName()' }
          },
          {
            code: '<span class="c"># 反汇编：baksmali d classes.dex -o out/</span>\n' +
                  '<span class="c"># 汇编：  smali a out/ -o classes.dex</span>\n' +
                  '<span class="c"># 等价的 apktool 流程：apktool d / apktool b（内部就是上面两条）</span>',
            note: '<b>工具怎么用。</b>反汇编把 dex 摊成目录树，<b>目录结构就是包名结构</b>' +
              '（<code>Lcom/demo/app/User;</code> → <code>out/com/demo/app/User.smali</code>），' +
              '所以你看到类名就知道文件在哪。<br>' +
              '汇编时<b>整个目录被重新汇编成一份新的 dex</b>——再次强调：重新生成，不是原地打补丁。',
            state: { '产物': 'out/**/*.smali', '回汇编产物': '新的 classes.dex' }
          },
          {
            code: '<span class="k">const-string</span> <span class="r">v1</span>, <span class="s">"VIP"</span>\n' +
                  '<span class="k">sget-object</span> <span class="r">v0</span>, ' +
                  '<span class="t">Lcom/demo/app/BuildConfig;</span>-><span class="f">TAG</span>:<span class="t">Ljava/lang/String;</span>',
            note: '<b>再补两条你会天天见到的。</b><code>const-string</code> 是加载字符串常量，' +
              '<code>sget-object</code> 是读静态字段。<br>' +
              '注意 Smali 里<b>字段用冒号写类型</b>（<code>TAG:Ljava/lang/String;</code>），' +
              '方法用括号写签名（<code>getName()Ljava/lang/String;</code>）——' +
              '这套"类型描述符"语法（<code>I</code>/<code>Z</code>/<code>J</code>/<code>L...;</code>/<code>[</code>）' +
              '是第 20 章讲 JNI 签名时同一套东西，忘了就回去对一遍。',
            state: { '字段写法': '名字:类型', '方法写法': '名字(参数)返回值' }
          },
          {
            code: '<span class="c">; 改这一行会发生什么？</span>\n' +
                  '<span class="k">const-string</span> <span class="r">v1</span>, <span class="s">"VIP 已过期"</span>',
            note: '<b>你只是把字符串改了。</b>在 native 层改字符串是件苦活（长度变了要挪数据、改指令里的偏移、修对齐），' +
              '在 Smali 层它只是换个字面量——<b>因为回汇编时会重建字符串表和所有索引</b>。<br>' +
              '<span class="hit">这是"改 Smali"相对"patch so"最大的生产力差异，而它来自一个很朴素的机制：整份重新生成。</span>',
            state: { '你需要操心': '改对了没有', '你不需要操心': '长度、偏移、对齐、索引' }
          }
        ]
      },
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">你现在应该能在看到任何一段 Smali 时先问出三个问题：' +
        '它对应哪条字节码？它操作哪几个寄存器？它引用的那个类/字段/方法是完整名是什么？' +
        '<b>能回答这三个，剩下的就是查表。</b></p>')
    },

    /* ============================================================ 27.4 */
    {
      h: '27.4', title: 'Smali 文件骨架：六个指令就够描述一个类',
      html:
        '<p>打开任意一个 <code>.smali</code> 文件，最上面永远是这几行。它们是类的"身份证"。</p>' +
        T.code(
          '<span class="c"># 一个最小但结构完整的 smali 文件</span>\n' +
          '<span class="k">.class</span> <span class="k">public</span> <span class="k">final</span> ' +
          '<span class="t">Lcom/demo/app/CryptoUtil;</span>\n' +
          '<span class="k">.super</span> <span class="t">Ljava/lang/Object;</span>\n' +
          '<span class="k">.source</span> <span class="s">"CryptoUtil.java"</span>\n\n' +
          '<span class="c"># interfaces</span>\n' +
          '<span class="k">.implements</span> <span class="t">Ljava/io/Serializable;</span>\n\n' +
          '<span class="c"># static fields</span>\n' +
          '<span class="k">.field</span> <span class="k">private</span> <span class="k">static</span> ' +
          '<span class="k">final</span> <span class="f">TAG</span>:<span class="t">Ljava/lang/String;</span> = ' +
          '<span class="s">"CryptoUtil"</span>\n\n' +
          '<span class="c"># instance fields</span>\n' +
          '<span class="k">.field</span> <span class="k">private</span> <span class="f">key</span>:' +
          '<span class="t">Ljava/lang/String;</span>\n\n' +
          '<span class="c"># direct methods</span>\n' +
          '<span class="k">.method</span> <span class="k">public</span> <span class="k">constructor</span> ' +
          '<span class="f">&lt;init&gt;</span>(<span class="t">Ljava/lang/String;</span>)<span class="t">V</span>\n' +
          '    <span class="k">.registers</span> <span class="n">2</span>\n' +
          '    <span class="k">invoke-direct</span> {<span class="r">p0</span>}, ' +
          '<span class="t">Ljava/lang/Object;</span>-><span class="f">&lt;init&gt;</span>()<span class="t">V</span>\n' +
          '    <span class="k">iput-object</span> <span class="r">p1</span>, <span class="r">p0</span>, ' +
          '<span class="t">Lcom/demo/app/CryptoUtil;</span>-><span class="f">key</span>:' +
          '<span class="t">Ljava/lang/String;</span>\n' +
          '    <span class="k">return-void</span>\n' +
          '<span class="k">.end method</span>'
        ) +
        T.tbl(['指令', '它说什么', '读的时候注意什么'],
          [
            ['<code>.class</code>', '这个类的<b>完整名字和访问标志</b>（public / final / interface / abstract / enum…）',
             '类型描述符是 <code>L包/路径/类名;</code>，<b>结尾的分号不能少</b>，包路径用 <code>/</code> 不是 <code>.</code>'],
            ['<code>.super</code>', '父类。没有父类的类（<code>Object</code>）这条不出现', '找不到父类时别怀疑工具，先看这个类是不是 <code>Object</code>'],
            ['<code>.source</code>', '源码文件名，来自 dex 的调试信息',
             '<b>发布版常常没有它</b>——被 strip 掉调试信息后这一行会消失。所以"没有 .source"很正常，不要据此判断文件损坏'],
            ['<code>.implements</code>', '实现了哪些接口（可以有多个）', '和 <code>.super</code> 一起决定类型系统，hook 时常用它来判断某个类是不是目标接口的实现'],
            ['<code>.annotation</code>', '注解（可见的 / 不可见的）', '骨架、路由、序列化这类框架会把它当配置用；改 Smali 时<b>动不动它取决于框架会不会在运行时读它</b>'],
            ['<code>.field</code> / <code>.method</code>', '字段与方法定义', '顺序上 baksmali 会把字段放前面、方法放后面，并分 <code>direct</code> / <code>virtual</code> 两组——<b>这是 dex 的真实存储顺序</b>，不是排版好看']
          ]) +
        T.note('warn', '⚠️ 骨架里最容易骗到新手的两个东西',
          '<p><b>① <code>.source</code> 和 <code>.line N</code> 是调试信息，不是逻辑。</b>' +
          '没有它们代码照样跑；有它们也只是"当初写这行的时候在第几行"。' +
          '用 <code>.line</code> 做代码定位很方便，但<b>加固/混淆/去调试信息之后它们会消失或者完全错乱</b>，不能当依据。</p>' +
          '<p style="margin-bottom:0"><b>② <code>.prologue</code> 是老写法。</b>' +
          '它在早期 Dalvik 反汇编输出里常见，现代 dex 里通常没有对应的东西，' +
          '很多版本的反汇编器也不再生成它。<span class="pill warn">待核实</span> 你手上的 baksmali 具体生成哪些指令，' +
          '<b>以它的一次真实输出为准</b>——这一章所有示例都是"结构正确"的示意，不是某个版本的逐字输出。</p>') +
        '<p>下面这份"知识骨架"把本节的结构再压缩一遍，方便你回头查。</p>',
      deck: {
        title: 'Smali 类骨架 · 六页速查',
        slides: [
          { kicker: 'CH27 · 骨架 1/6', title: '.class：我是谁', foot: '访问标志 + 类型描述符',
            body: '<p style="font-family:var(--mono);font-size:13px">.class public final Lcom/demo/app/CryptoUtil;</p>' +
                  '<ul><li>类型描述符以 <code>L</code> 开头、以 <code>;</code> 结束</li>' +
                  '<li>包路径用 <code>/</code>；<code>.</code> 只出现在类型描述符之间的分隔里（如 <code>Lcom/x/Foo$Bar;</code> 表示内部类）</li>' +
                  '<li>访问标志在这里和内层定义处<b>都要出现</b>（如方法前的 <code>public static</code>）</li></ul>' },
          { kicker: 'CH27 · 骨架 2/6', title: '.super / .implements：我的血缘', foot: '单继承 + 多接口',
            body: '<p>类只继承一个父类，可以实现多个接口。</p>' +
                  '<ul><li>给 hook 用：判断"这个类是不是某个接口的实现"，比拿类名硬匹配靠谱</li>' +
                  '<li>给调用用：<code>invoke-super</code> 能成立的前提就是这里有真实的父类</li></ul>' },
          { kicker: 'CH27 · 骨架 3/6', title: '.field：字段三要素', foot: '可见性 + 静态与否 + 类型',
            body: '<p style="font-family:var(--mono);font-size:13px">.field private static final TAG:Ljava/lang/String; = "CryptoUtil"</p>' +
                  '<ul><li><b>有 <code>static</code> → 用 <code>sget</code>/<code>sput</code>；没有 → 用 <code>iget</code>/<code>iput</code></b></li>' +
                  '<li>带初始值的写法只适用于静态字段（等价于 <code>&lt;clinit&gt;</code> 里赋值）</li>' +
                  '<li>字段类型写在冒号后面，是<b>类型描述符</b>不是 Java 类型名</li></ul>' },
          { kicker: 'CH27 · 骨架 4/6', title: '.method：方法壳 + .registers', foot: '寄存器声明必须在最前',
            body: '<p style="font-family:var(--mono);font-size:13px">.method public encrypt(Ljava/lang/String;)Ljava/lang/String;<br>&nbsp;&nbsp;&nbsp;&nbsp;.registers 4<br>&nbsp;&nbsp;&nbsp;&nbsp;…<br>.end method</p>' +
                  '<ul><li>方法签名 = <code>名字(参数类型)返回类型</code>，<b>没有空格</b></li>' +
                  '<li><code>.registers</code> 或 <code>.locals</code> 必须出现在第一条指令之前</li>' +
                  '<li>不需要写"返回什么"，返回类型已经在签名里了</li></ul>' },
          { kicker: 'CH27 · 骨架 5/6', title: 'direct vs virtual：两组分开写', foot: '这是 dex 的真实结构',
            body: '<ul><li><b>direct methods</b>：构造方法 <code>&lt;init&gt;</code>、静态方法、private 方法、<code>&lt;clinit&gt;</code></li>' +
                  '<li><b>virtual methods</b>：其余可被重写/分派的实例方法</li>' +
                  '<li>回头对应 27.8：<b>direct 里的方法用 <code>invoke-direct</code>/<code>invoke-static</code> 调，virtual 里的用 <code>invoke-virtual</code> 调</b></li></ul>' },
          { kicker: 'CH27 · 骨架 6/6', title: '.annotation / .line / .source：能信到什么程度', foot: '调试信息 ≠ 逻辑',
            body: '<ul><li><code>.annotation</code>：框架可能真的读它（路由、序列化、DI），改之前先确认</li>' +
                  '<li><code>.line</code>：定位很方便，但去调试信息后就消失或错乱</li>' +
                  '<li><code>.source</code>：发布版常常没有，别把它当"文件完整"的证据</li></ul>' }
        ]
      },
      after: T.note('', '🧭 一个实用习惯',
        '<p style="margin-bottom:0">拿到一个陌生的 <code>.smali</code>，先花十秒扫骨架：' +
        '<b>它继承谁、实现谁、有哪些字段、方法分成哪两组</b>。' +
        '这十秒能省掉后面十分钟在方法体里迷路——因为在方法体里，你看到的每个 <code>iget</code>、' +
        '每个 <code>invoke</code> 都要靠骨架里的信息才能读懂。</p>')
    },

    /* ============================================================ 27.5 */
    {
      h: '27.5', title: '寄存器模型：新手在这里卡最久，也最值得一次讲透',
      intuition: {
        tag: '直觉模型 · 一排编号储物柜，参数总是从最右边开始放',
        body:
          '<p>想象一排编号的储物柜，从左到右是 <code>v0 v1 v2 v3 …</code>。' +
          '方法一开始，柜子数量就定死了（<code>.registers N</code> 或 <code>.locals N</code>）。</p>' +
          '<p>规矩只有一条，但它是全部混乱的来源：<b>参数从最右边开始放。</b>' +
          '这意味着"靠左的那批"是给你放局部变量的，"靠右的那批"是别人塞进来的参数。</p>' +
          '<p>于是同一个柜子有两个名字：按绝对编号叫 <code>v4</code>，按"第 0 个参数"叫 <code>p0</code>。' +
          '<b>它们说的是一模一样的东西。</b>新手看 Smali 觉得乱，八成是没意识到自己面对的是"同一排柜子的两套命名"。</p>'
      },
      html:
        '<p>下面把这条规矩用动画走一遍。注意两个例子用的是<b>同一个 <code>.registers 8</code></b>，' +
        '但含义完全不同——这正是本节要你带走的东西。</p>',
      stage: {
        title: '寄存器布局：v 编号与 p 编号的换算',
        speed: 1900,
        render:
          '<div class="card"><div class="card-title" id="rDecl">方法声明与寄存器声明</div>' +
            '<div class="flow-row" style="gap:6px;flex-wrap:wrap;margin-top:8px">' +
              '<span class="blk" id="rb0">v0</span><span class="blk" id="rb1">v1</span>' +
              '<span class="blk" id="rb2">v2</span><span class="blk" id="rb3">v3</span>' +
              '<span class="blk" id="rb4">v4</span><span class="blk" id="rb5">v5</span>' +
              '<span class="blk" id="rb6">v6</span><span class="blk" id="rb7">v7</span>' +
            '</div>' +
            '<div class="flow-row" style="gap:6px;flex-wrap:wrap;margin-top:6px">' +
              '<span class="small" id="pl0">—</span><span class="small" id="pl1">—</span>' +
              '<span class="small" id="pl2">—</span><span class="small" id="pl3">—</span>' +
              '<span class="small" id="pl4">—</span><span class="small" id="pl5">—</span>' +
              '<span class="small" id="pl6">—</span><span class="small" id="pl7">—</span>' +
            '</div>' +
            '<div class="grid2" style="margin-top:10px">' +
              '<div><div class="card-title">参数区（柜子右半边）</div>' +
                '<div class="mono" id="rParam">—</div></div>' +
              '<div><div class="card-title">本地区（柜子左半边）</div>' +
                '<div class="mono" id="rLocal">—</div></div>' +
            '</div>' +
            '<div style="margin-top:10px"><span class="pill" id="rNote">点"单步"开始</span></div>' +
          '</div>',
        reset: () => {
          ['rb0','rb1','rb2','rb3','rb4','rb5','rb6','rb7'].forEach(i => S(i, ''));
          for (let i = 0; i < 8; i++) { CLS('pl' + i, 'small'); SET('pl' + i, '—'); }
          CLS('rNote', 'pill'); SET('rNote', '点"单步"开始');
          SET('rDecl', '.method public encrypt(Ljava/lang/String;[BI)Ljava/lang/String;   .registers 8');
          SET('rParam', '—'); SET('rLocal', '—');
        },
        steps: [
          { run: () => {
              SET('rDecl', '.registers 8  →  这排柜子一共 8 个槽位，每个 32 位');
              ['rb0','rb1','rb2','rb3','rb4','rb5','rb6','rb7'].forEach(i => S(i, 'active'));
            },
            note: '<b>先声明柜子数量。</b><code>.registers N</code> 说的是<b>总槽位</b>，' +
              '不是"局部变量个数"。这排柜子从声明那一刻起就不能再变——' +
              '<span class="hit">所以你在方法中途"想多用一个变量"是做不到的，只能复用前一个已经死掉的柜子。</span>' },
          { run: () => {
              SET('rDecl', '.method public encrypt(Ljava/lang/String;[BI)Ljava/lang/String;  →  4 个参数槽位');
              ['rb0','rb1','rb2','rb3'].forEach(i => S(i, 'cool'));
              ['rb4','rb5','rb6','rb7'].forEach(i => S(i, 'hi'));
              SET('rParam', 'p0 = v4　p1 = v5　p2 = v6　p3 = v7');
              SET('rLocal', 'v0 v1 v2 v3（共 4 个）');
            },
            note: '<b>参数从最右边开始放。</b>这个方法有 4 个参数寄存器（<code>this</code> + String + byte[] + int），' +
              '所以它们占掉<b>最右边 4 个</b>：<code>v4…v7</code>。左边的 <code>v0…v3</code> 才是本地变量区。<br>' +
              '<b>换算公式就一句：</b><code>pN = v(locals + N)</code>。这里 <code>locals = 4</code>，所以 p0 = v4。' },
          { run: () => { S('rb4', 'wr'); SET('pl4', 'p0 = this'); CLS('pl4', 'small hi'); },
            note: '<b>实例方法的 p0 就是 <code>this</code>。</b>不是"第 0 个业务参数"——它占了一个参数槽位。' +
              '所以实例方法的参数槽位数 = <b>1 + 真实参数个数</b>（宽类型另算，见下一步）。' },
          { run: () => {
              SET('rDecl', '.locals 4  ≡  .registers 8（同一个方法，两种写法）');
              CLS('rNote', 'pill ok'); SET('rNote', '.registers = 局部数 + 参数槽位数');
            },
            note: '<b>两种写法是等价的。</b><code>.locals 4</code> 的意思是"我要 4 个本地槽位"，' +
              '工具自己加上参数槽位，等价于 <code>.registers 8</code>。<br>' +
              '记住选择：<b>看到 <code>.locals</code> 就加上参数槽位数才是总槽位；看到 <code>.registers</code> 就得减掉参数槽位数才是本地数。</b>' },
          { run: () => {
              SET('rDecl', '.method public static add(JJ)J   .registers 8  →  同样是 8，含义全变了');
              ['rb0','rb1','rb2','rb3'].forEach(i => S(i, 'cool'));
              ['rb4','rb5','rb6','rb7'].forEach(i => S(i, 'hi'));
              CLS('pl4', 'small hi'); SET('pl4', 'p0/p1 = 第一个 long 的两个槽位');
              CLS('pl5', 'small hi'); SET('pl5', '(同一个参数的高位)');
              CLS('pl6', 'small hi'); SET('pl6', 'p2/p3 = 第二个 long 的两个槽位');
              CLS('pl7', 'small hi'); SET('pl7', '(同一个参数的高位)');
              SET('rParam', 'p0 p1 p2 p3 = v4 v5 v6 v7（4 个槽位，只有 2 个参数）');
              SET('rLocal', 'v0 v1 v2 v3（共 4 个）');
              CLS('rNote', 'pill warn'); SET('rNote', '⚠️ 数槽位，不要数参数');
            },
            note: '<b>长整型和 double 各占两个槽位。</b><code>add(long, long)</code> 只有 2 个参数，' +
              '但吃掉 4 个槽位（<code>p0 p1</code> 其实是同一个 long 的低位和高位）。<br>' +
              '<span class="hit">这就是"<code>.registers</code> 到底该写几"这个问题的唯一正确算法：数槽位。</span> ' +
              'Java 层看是 2 个参数，字节码层看是 4 个寄存器。<br>' +
              '<span class="pill warn">待核实</span> 宽类型参数的 <code>.param</code> 名称具体挂在低位还是高位槽位上，' +
              '不同版本的反汇编器输出可能不同——<b>以你本机 baksmali 的真实输出为准</b>，别背结论。' },
          { run: () => {
              CLS('rNote', 'pill bad'); SET('rNote', '⚠️ 所以手改 .registers 是高危操作');
            },
            note: '<b>收口，也是本节最实用的一条纪律。</b><code>pN = v(locals + N)</code>，' +
              '而 <code>locals = .registers - 参数槽位数</code>。<br>' +
              '你一旦改了 <code>.registers</code>，<b>locals 就变了，于是所有 p 编号对应的 v 编号整体平移</b>——' +
              '而方法体里写的是 <code>p0</code>、<code>p1</code>，看起来没变，实际指向的槽位全变了。<br>' +
              '<span class="hit">这就是"我只改了一个数字，怎么运行结果全错了"的经典成因。</span> ' +
              '要么别动它，要么把整个方法体重新过一遍。' }
        ]
      },
      after: T.note('ok', '✅ 三条可以背下来、也必须背下来的规则',
        '<ol style="margin-bottom:0">' +
        '<li><code>.registers N</code> = 总槽位；<code>.locals N</code> = 本地槽位；<b>总槽位 = 本地槽位 + 参数槽位数</b>。</li>' +
        '<li><b>参数槽位从最右边开始排</b>，<code>pN = v(locals + N)</code>；实例方法的 <code>p0</code> 是 <code>this</code>。</li>' +
        '<li><b>数槽位，不数参数</b>：<code>long</code> / <code>double</code> 各占两个槽位。</li>' +
        '</ol>')
    },

    /* ============================================================ 27.6 */
    {
      h: '27.6', title: '动手实验：寄存器换算器（把上一条规则算成数字）',
      html:
        '<p>规则听着简单，真正上手时卡人的是"到底该写几"和"p0 是哪个 v"。' +
        '这个实验让你自己算一遍：<b>输入一个方法签名和 <code>.locals</code>，系统真的解析它并给出寄存器布局。</b></p>' +
        '<p>下面预填的是一个实例方法，参数里有窄类型也有宽类型，故意留了几个坑。</p>',
      lab: {
        title: '实验：从方法签名算出寄存器布局',
        goal: '目标：算出总槽位、p0 的 v 编号',
        intro:
          '<p>方法签名用 JNI/Smali 的类型描述符写（<code>I</code>=int，<code>J</code>=long，' +
          '<code>Z</code>=boolean，<code>L…;</code>=对象，<code>[</code>=数组）。</p>' +
          '<p>填写签名、"是否静态"和 <code>.locals</code>，点运行——它会真的一句句解析描述符、数出槽位。</p>',
        inputs: [
          { key: 'sig', label: '方法签名', hint: '形如 encrypt(Ljava/lang/String;J[BI)I',
            value: 'encrypt(Ljava/lang/String;J[BI)I' },
          { key: 'isStatic', label: '是不是静态方法？', hint: '填 是/否（静态方法没有 this）', value: '否' },
          { key: 'locals', label: '.locals 的值', hint: '本地槽位数', value: '3' },
          { key: 'ansP0', label: '① p0 对应哪个 v 寄存器？', hint: '例如 v3', ph: 'v?' },
          { key: 'ansTotal', label: '② 这个方法的 .registers 应该写几？', hint: '总槽位数', ph: '数字' }
        ],
        runLabel: '🔍 解析签名、数槽位',
        autorun: true,
        run: (v) => {
          const C = window.CRYPTO;
          const sigRaw = String(v.sig || '').trim();
          const localsN = parseInt(String(v.locals || '').replace(/[^0-9]/g, ''), 10);
          const st = /^(是|yes|y|true|静态|static|1)$/i.test(String(v.isStatic || '').trim());
          if (!sigRaw) return '<div class="lab-msg warn">先填一个方法签名。签名必须是 JNI/Smali 的类型描述符写法。</div>';

          const p = sigRaw.indexOf('(');
          const q = sigRaw.lastIndexOf(')');
          if (p < 0 || q < p) return '<div class="lab-msg warn">签名里找不到 <code>(参数)返回类型</code> 的结构。' +
            '正确写法类似 <code>encrypt(Ljava/lang/String;I)Z</code>。</div>';
          const params = sigRaw.slice(p + 1, q);
          const ret = sigRaw.slice(q + 1).trim() || '（未写返回值）';

          /* --- 真正的描述符解析：逐字符走，数出"槽位"而不是"参数个数" --- */
          const items = [];
          let i = 0, inArray = false, bad = '';
          const PRIM = { Z: 'boolean', B: 'byte', S: 'short', C: 'char', I: 'int', F: 'float', J: 'long', D: 'double' };
          while (i < params.length) {
            const c = params[i];
            if (c === '[') { inArray = true; i++; continue; }
            let name = '', slots = 1;
            if (c === 'L') {
              const e = params.indexOf(';', i);
              if (e < 0) { bad = '对象类型少了结尾分号：' + params.slice(i); break; }
              name = params.slice(i, e + 1); i = e + 1;
            } else if (PRIM[c]) {
              name = PRIM[c];
              slots = (c === 'J' || c === 'D') ? 2 : 1;
              i++;
            } else { bad = '看不懂的类型描述符字符：' + c; break; }
            if (inArray) { name = (name.charAt(0) === 'L' ? '[' + name : name + '[]'); slots = 1; }
            items.push({ name, slots, wide: slots === 2 });
            inArray = false;
          }
          if (bad) return '<div class="lab-msg fail"><b>签名解析失败</b><div class="lab-note">' + bad +
            '<br>对照一下：<code>Z B S C I F</code> 各占 1 个槽位，<code>J D</code> 各占 2 个，' +
            '<code>L全限定名;</code> 是对象，<code>[</code> 是数组（数组本身是一个引用，占 1 个槽位）。</div></div>';

          const paramSlots = items.reduce((a, x) => a + x.slots, 0) + (st ? 0 : 1);
          if (!isFinite(localsN) || localsN < 0) {
            return '<div class="lab-msg warn">`.locals` 要填一个非负整数。</div>';
          }
          const total = localsN + paramSlots;

          /* --- p 编号 → v 编号 --- */
          let rows = '', idx = 0, pi = 0;
          if (!st) {
            rows += '<tr class="diff"><td>p' + pi + '</td><td>v' + (localsN + idx) + '</td><td>对象引用</td>' +
              '<td><b>this</b>（实例方法的第 0 个参数槽位）</td></tr>';
            idx++; pi++;
          }
          items.forEach(it => {
            const from = localsN + idx;
            const to = from + it.slots - 1;
            rows += '<tr' + (it.wide ? ' class="diff"' : '') + '><td>p' + pi + (it.slots === 2 ? '/p' + (pi + 1) : '') + '</td>' +
              '<td>v' + from + (it.slots === 2 ? '–v' + to : '') + '</td>' +
              '<td><code>' + it.name + '</code></td>' +
              '<td>' + (it.slots === 2 ? '<b>宽类型占 2 个槽位</b>（低位 + 高位）' : '占 1 个槽位') + '</td></tr>';
            idx += it.slots; pi += it.slots;
          });

          /* 局部区示意（真算，不写死） */
          const localCells = [];
          for (let k = 0; k < localsN; k++) localCells.push('v' + k);

          /* 用 CRC32 给签名算一个短指纹：索引几万个方法时用得上的思路 */
          const sigNorm = (st ? 'static ' : '') + sigRaw.replace(/\s+/g, '');
          const fp = C.crc32(C.toBytes(sigNorm)).toString(16).padStart(8, '0');

          return '<div class="lab-kv">' +
              '<span>参数槽位 <b>' + paramSlots + '</b>（' + items.length + ' 个真实参数' +
                (st ? '' : ' + this') + '）</span>' +
              '<span>本地槽位 <b>' + localsN + '</b></span>' +
              '<span>总槽位 <b>' + total + '</b></span></div>' +
            '<table class="lab-tbl"><tr><th>参数寄存器</th><th>对应 v 编号</th><th>类型</th><th>说明</th></tr>' +
              (rows || '<tr><td colspan="4" class="muted">这个方法没有参数</td></tr>') + '</table>' +
            '<div class="lab-msg key"><b>🔑 换算结果</b><div class="lab-note">' +
              '总槽位 = 本地槽位 + 参数槽位 = <b>' + localsN + ' + ' + paramSlots + ' = ' + total + '</b><br>' +
              '所以 <code>.registers ' + total + '</code> 与 <code>.locals ' + localsN + '</code> 在这里等价。<br>' +
              '<b>p0 = v(locals) = v' + localsN + '</b>' +
              (st ? '（静态方法，p0 就是第一个真实参数，不是 this）' : '（实例方法，p0 就是 this）') + '<br>' +
              '本地区：' + (localCells.length ? '<code>' + localCells.join(' ') + '</code>' : '（一个都不占）') +
            '</div></div>' +
            '<div class="lab-msg"><b>为什么数组和宽类型要分开数</b><div class="lab-note">' +
              '<code>[J</code>（long 数组）只占 <b>1</b> 个槽位——因为它是一个<b>引用</b>；' +
              '而 <code>J</code>（long）占 <b>2</b> 个。这是描述符解析里最容易数错的地方。<br>' +
              '签名 <code>' + sigNorm + '</code> 的 CRC32 短指纹：<code>' + fp + '</code>（' +
              '工具/加固常用这类指纹在几万个方法里做索引，这里演示它怎么算出来的）。返回值类型：<code>' + ret + '</code>' +
              '</div></div>';
        },
        expected: (v) => {
          const num = s => { const m = String(s || '').match(/-?\d+/); return m ? Number(m[0]) : NaN; };
          const sigRaw = String(v.sig || '').trim();
          const localsN = num(v.locals);
          const st = /^(是|yes|y|true|静态|static|1)$/i.test(String(v.isStatic || '').trim());
          const p = sigRaw.indexOf('('), q = sigRaw.lastIndexOf(')');
          if (p < 0 || q < p) return { ok: false, detail: '❌ 签名格式不对，先写成 <code>名字(参数)返回</code> 的样子。' };
          const params = sigRaw.slice(p + 1, q);
          let slots = 0, i = 0, inArray = false, okParse = true;
          const WIDE = { J: 1, D: 1 };
          while (i < params.length) {
            const c = params[i];
            if (c === '[') { inArray = true; i++; continue; }
            if (c === 'L') { const e = params.indexOf(';', i); if (e < 0) { okParse = false; break; } i = e + 1; }
            else if ('ZBSCIFJD'.indexOf(c) >= 0) { i++; }
            else { okParse = false; break; }
            slots += (inArray ? 1 : (WIDE[c] ? 2 : 1));
            inArray = false;
          }
          if (!okParse) return { ok: false, detail: '❌ 签名解析失败，检查类型描述符写法（对象要有结尾分号）。' };
          const paramSlots = slots + (st ? 0 : 1);
          const total = (isFinite(localsN) ? localsN : NaN) + paramSlots;
          const p0 = isFinite(localsN) ? localsN : NaN;

          const aP0 = num(v.ansP0), aT = num(v.ansTotal);
          const p0Ok = aP0 === p0, tOk = aT === total;
          return {
            ok: p0Ok && tOk,
            detail:
              (p0Ok ? '✅ p0 算对了：p0 = v(locals) = <code>v' + p0 + '</code>。'
                    : '❌ p0 不对。用公式 <b>p0 = v(locals)</b>：locals 是 <code>' + localsN + '</code>，' +
                      '所以 p0 应该是 <code>v' + p0 + '</code>。' +
                      (st ? '（这是静态方法，p0 是第一个真实参数）' : '（这是实例方法，p0 是 this）')) +
              '<br>' +
              (tOk ? '✅ 总槽位算对了：' + localsN + ' + ' + paramSlots + ' = <code>' + total + '</code>。'
                   : '❌ 总槽位不对。参数占 <b>' + paramSlots + '</b> 个槽位（别忘了宽类型算 2 个、' +
                     (st ? '静态方法没有 this' : '实例方法的 this 也占 1 个') + '），' +
                     '加上 locals ' + localsN + ' → 应该写 <code>.registers ' + total + '</code>。')
          };
        },
        showAnswer:
          '【① p0 是哪个 v】\n' +
          '  公式：p0 = v(locals)\n' +
          '  locals = 3  →  p0 = v3\n' +
          '  注意 p0 是 this（实例方法），不是第一个业务参数。\n\n' +
          '【② 总槽位（.registers 写几）】\n' +
          '  逐个数参数槽位：\n' +
          '    this               → 1 个槽位（实例方法才有）\n' +
          '    Ljava/lang/String; → 1 个（对象引用）\n' +
          '    J                  → 2 个（long 占两个槽位！）\n' +
          '    [B                 → 1 个（数组是引用）\n' +
          '    I                  → 1 个\n' +
          '  参数槽位合计 = 1+1+2+1+1 = 6\n' +
          '  总槽位 = locals 3 + 参数 6 = 9\n' +
          '  → .registers 9  ≡  .locals 3\n\n' +
          '【最容易错的两处】\n' +
          '  ① long / double 占两个槽位（J、D），数成 1 就少算。\n' +
          '  ② 数组 [X 只占一个槽位（它是引用），里面的元素类型不影响寄存器数量。\n' +
          '  ③ 静态方法没有 this，参数槽位要少算 1 个。\n\n' +
          '【返回类型】\n' +
          '  I → 返回 int，用 return v0（不是 return-void、也不是 return-object）。\n' +
          '  宽类型返回用 return-wide；对象返回用 return-object；无返回用 return-void。',
        hint:
          '<b>先数槽位，再套两个公式。</b><br>' +
          '公式一：<code>总槽位 = locals + 参数槽位数</code><br>' +
          '公式二：<code>p0 = v(locals)</code>，然后每个参数往后排自己的槽位数<br><br>' +
          '参数槽位怎么数：<code>Z B S C I F</code> 各 1 个；<b><code>J</code> 和 <code>D</code> 各 2 个</b>；' +
          '<code>L…;</code> 是 1 个；<code>[…</code> 是数组，也只是 1 个。实例方法别忘了 <code>this</code> 占 1 个。',
        after:
          T.note('ok', '✅ 实验的收获',
            '<p style="margin-bottom:0">以后看到任何 <code>.registers N</code>，你都能在脑子里拆出"本地区"和"参数区"，' +
            '并且知道 <code>p0</code> 落在哪个 <code>v</code> 上。<br>' +
            '<span class="hit">这个能力在两种场合救你：读懂别人写的 Smali，' +
            '以及——更重要的——你自己改完之后知道有没有把寄存器搞越界。</span></p>')
      }
    },

    /* ============================================================ 27.7 */
    {
      h: '27.7', title: '字段：一条 static 之分，决定你用 iget 还是 sget',
      html:
        '<p>字段的 Smali 定义在 27.4 见过，这里讲<b>读写</b>。规则简单到只有一条，但它是新手最常见的低级错误来源：' +
        '<b>字段有没有 <code>static</code>，决定了你用 <code>i*</code> 还是 <code>s*</code> 系列指令。</b></p>' +
        T.tbl(['你要做的事', '指令', '寄存器和操作数怎么写', '为什么'],
          [
            ['读实例字段', '<code>iget</code> / <code>iget-object</code> / <code>iget-boolean</code> / ' +
              '<code>iget-wide</code> 等',
              '<code>iget v0, v1, Lcom/x/Foo;-&gt;a:I</code><br>把 <code>v1</code> 指向的<b>对象</b>里的 a 读进 <code>v0</code>',
              '实例字段在<b>对象</b>里，所以必须先有一个对象引用'],
            ['写实例字段', '<code>iput</code> 系列', '<code>iput v0, v1, Lcom/x/Foo;-&gt;a:I</code><br>把 <code>v0</code> 的值写进 <code>v1</code> 对象的 a',
              '同样是"值 + 对象引用"两个操作数'],
            ['读静态字段', '<code>sget</code> 系列', '<code>sget v0, Lcom/x/Foo;-&gt;COUNT:I</code><br><b>没有对象操作数</b>',
              '静态字段挂在<b>类</b>上，不需要对象'],
            ['写静态字段', '<code>sput</code> 系列', '<code>sput v0, Lcom/x/Foo;-&gt;COUNT:I</code>',
              '同上']
          ]) +
        T.code(
          '<span class="c"># 一个类里的两种字段</span>\n' +
          '<span class="k">.field</span> <span class="k">private</span> <span class="f">name</span>:' +
          '<span class="t">Ljava/lang/String;</span>          <span class="c"># 实例字段</span>\n' +
          '<span class="k">.field</span> <span class="k">public</span> <span class="k">static</span> ' +
          '<span class="k">final</span> <span class="f">TAG</span>:<span class="t">Ljava/lang/String;</span> = ' +
          '<span class="s">"demo"</span>   <span class="c"># 静态字段（名字后面的分号别丢）</span>\n\n' +
          '<span class="c"># 读实例字段 → iget-object（因为类型是对象）</span>\n' +
          '<span class="k">iget-object</span> <span class="r">v0</span>, <span class="r">p0</span>, ' +
          '<span class="t">Lcom/demo/app/User;</span>-><span class="f">name</span>:' +
          '<span class="t">Ljava/lang/String;</span>\n\n' +
          '<span class="c"># 读静态字段 → sget-object（没有对象操作数）</span>\n' +
          '<span class="k">sget-object</span> <span class="r">v0</span>, ' +
          '<span class="t">Lcom/demo/app/User;</span>-><span class="f">TAG</span>:' +
          '<span class="t">Ljava/lang/String;</span>\n\n' +
          '<span class="c"># 写实例字段 → iput-object</span>\n' +
          '<span class="k">iput-object</span> <span class="r">p1</span>, <span class="r">p0</span>, ' +
          '<span class="t">Lcom/demo/app/User;</span>-><span class="f">name</span>:' +
          '<span class="t">Ljava/lang/String;</span>'
        ) +
        T.note('warn', '⚠️ 指令后缀是"值的类型"，不是"字段的类型"',
          '<p><code>iget-object</code> 里的 <code>-object</code>、<code>iget-boolean</code> 里的 <code>-boolean</code>、' +
          '<code>iget-wide</code> 里的 <code>-wide</code>（64 位值）——这些后缀决定的是' +
          '<b>在寄存器和内存之间搬多少、怎么解释这段数据</b>。</p>' +
          '<p style="margin-bottom:0">所以改字段时最容易犯的错是"只改了声明里的类型，忘了改读写指令的后缀"。' +
          '两边对不上时，运气好是回编译/校验阶段报错，运气不好是运行时读到一段被解释错的数据——' +
          '<span class="hit">后者不会崩，只会静默出错，最难查。</span></p>') +
        T.card('为什么要区分 iget 与 sget——这是编译期就定死的信息',
          '<p>这不是"风格问题"，而是<b>字节码格式层面的硬约束</b>：dex 里实例字段访问和静态字段访问是' +
          '<b>不同的 opcode</b>，操作数个数都不一样（差一个对象引用）。</p>' +
          '<p>所以你在 Smali 里写错了，回汇编时可能还能过，' +
          '但到了设备的<b>字节码验证阶段</b>就会因为"寄存器里那个值不可能是对象"这一类的类型推断失败而被拒绝。' +
          '<span class="pill warn">待核实</span> 具体的报错形态随版本和路径而异（可能是安装/校验阶段的日志，也可能是启动即崩），' +
          '<b>别指望有一个统一的报错文案</b>——最稳的办法是改完先自己对着表检查一遍。</p>' +
          '<p style="margin-bottom:0">这也解释了为什么"改 Smali"比"改 Java 源码"难受：Java 编译器替你做的类型检查，' +
          '现在要你自己做。</p>')
    },

    /* ============================================================ 27.8 */
    {
      h: '27.8', title: '方法调用：五条 invoke 分别什么时候用，返回值怎么接',
      html:
        '<p>方法调用是 Smali 里信息量最大的一行。它同时在说三件事：' +
        '<b>用什么分派方式</b>、<b>传哪些寄存器</b>、<b>调用谁</b>。</p>' +
        T.tbl(['指令', '什么时候用', '一个能记住的判断'],
          [
            ['<code>invoke-virtual</code>', '普通实例方法（public / protected 等<b>可被重写</b>的方法）',
              '<b>要按对象的实际类型去分派</b> → 走虚方法表'],
            ['<code>invoke-direct</code>', '构造方法 <code>&lt;init&gt;</code>、private 实例方法、同一类内部的非虚调用',
              '<b>不允许被重写</b>，所以不需要（也不能）做虚分派'],
            ['<code>invoke-static</code>', '静态方法', '<b>没有 this</b>，寄存器列表里第一个就是第一个真实参数'],
            ['<code>invoke-super</code>', '在重写的方法里调父类实现（对应 <code>super.foo()</code>）',
              '<b>明确绕过本类的重写</b>'],
            ['<code>invoke-interface</code>', '被调方法的<b>声明类型是接口</b>时',
              '分派目标由实现类决定，但静态类型是接口']
          ]) +
        T.note('key', '🔑 为什么构造函数必须用 invoke-direct',
          '<p style="margin-bottom:0">因为它<b>不能被重写</b>。' +
          '<code>&lt;init&gt;</code> 不是普通方法：它没有虚方法表条目，' +
          '子类的构造方法也不是"覆盖"父类的 <code>&lt;init&gt;</code>，而是通过 <code>invoke-direct</code> ' +
          '在自己的第一行显式调用父类构造方法。<br>' +
          '换成 <code>invoke-virtual</code> 去调 <code>&lt;init&gt;</code>，语义上就是"我想按实际类型分派一个构造器"——' +
          '这件事在对象模型里根本不成立。<span class="hit">所以这不是"约定"，是类型系统逼出来的唯一写法。</span></p>') +
        '<p>还有两个工程细节，不知道的话会在实战里吃暗亏：</p>' +
        T.grid(2, [
          '<div class="card"><div class="card-title">① 非 range 形式最多 5 个寄存器</div>' +
          '<p><code>invoke-virtual {v0, v1, v2}, …</code> 这种写法里，每个寄存器用 4 位表示，' +
          '所以<b>只能出现 5 个</b>，而且涉及的寄存器<b>编号最好在 v0–v15</b>。</p>' +
          '<p>参数多、或者要用 <code>p</code> 寄存器（编号很大）时，必须改成 ' +
          '<code>invoke-virtual/range {p0 .. p4}, …</code>——' +
          '<b><code>/range</code> 要求寄存器连续</b>。<span class="hit">这是"明明写对了却回编译失败"的常见原因之一。</span></p></div>',
          '<div class="card"><div class="card-title">② 返回值必须用 move-result 接</div>' +
          '<p><code>invoke-*</code> <b>自己不写返回值到寄存器</b>，要靠紧跟着的一条：</p>' +
          '<ul><li><code>move-result</code>：32 位值（int / boolean / float / 引用？不，引用见下）</li>' +
          '<li><code>move-result-object</code>：对象引用</li>' +
          '<li><code>move-result-wide</code>：64 位值（long / double）</li></ul>' +
          '<p style="margin-bottom:0"><b>void 方法没有 move-result</b>。<br>' +
          '而且这条 <code>move-result</code> <b>必须紧跟在 invoke 之后</b>，中间不能插别的指令——' +
          '这就是 27.12 里"删掉一行调用为什么要连着删两行"的原因。</p></div>'
        ]) +
        '<p>下面把"一次调用 + 接返回值 + 用它做分支"的完整过程推一遍，注意右侧寄存器里的值怎么变。</p>',
      stepper: {
        title: '一次 invoke 与它的返回值：寄存器视角',
        lines: [
          {
            code: '<span class="c"># 假设这是 MainActivity 里的一个方法</span>\n' +
                  '<span class="k">.method</span> <span class="k">public</span> <span class="f">onClick</span>' +
                  '(<span class="t">Landroid/view/View;</span>)<span class="t">V</span>\n' +
                  '    <span class="k">.registers</span> <span class="n">3</span>',
            note: '<b>先看寄存器账。</b>参数槽位：<code>this</code> + <code>View</code> = 2 个；' +
              '总槽位 3，所以本地区只有 <code>v0</code> 一个。<br>' +
              '<code>p0 = v1</code>（this），<code>p1 = v2</code>（那个 View）。<br>' +
              '<span class="hit">每读一个方法，先做这一步"账"，后面就不会猜。</span>',
            state: { '总槽位': '3', '本地': 'v0', 'p0': 'v1 (this)', 'p1': 'v2 (View)' }
          },
          {
            code: '    <span class="k">invoke-virtual</span> {<span class="r">p0</span>}, ' +
                  '<span class="t">Lcom/demo/app/MainActivity;</span>-><span class="f">isVip</span>()' +
                  '<span class="t">Z</span>',
            note: '<b>调用开始。</b>花括号里是<b>传给这个方法的寄存器列表</b>，第一个永远是接收者（<code>this</code>）。' +
              '方法签名结尾的 <code>Z</code> 告诉你：它返回一个 <code>boolean</code>（32 位）。<br>' +
              '此刻 <code>v0</code> 还是空的——<b>invoke 不负责把结果放进来</b>。',
            state: { 'v0': '（未赋值）', '调用': 'MainActivity.isVip()', '返回类型': 'Z (boolean, 32 位)' }
          },
          {
            code: '    <span class="k">move-result</span> <span class="r">v0</span>',
            note: '<b>接返回值。</b>用 <code>move-result</code> 而不是 <code>move-result-object</code>，' +
              '因为返回值是 32 位的 boolean。<br>' +
              '如果上面那个方法返回的是 <code>String</code>，这里必须写 <code>move-result-object</code>；' +
              '返回 <code>long</code> 就要 <code>move-result-wide</code>。<br>' +
              '<span class="hit">这条指令和 invoke 是一对，位置不能挪。</span>',
            state: { 'v0': '0 或 1（isVip 的结果）', '指令': 'move-result' }
          },
          {
            code: '    <span class="k">if-eqz</span> <span class="r">v0</span>, :<span class="f">cond_notvip</span>',
            note: '<b>用它做判断。</b><code>if-eqz</code> = "if equals zero"，即 <b>v0 == 0 时跳转</b>。' +
              'v0 是 0（不是 VIP）→ 跳到 <code>:cond_notvip</code>；是 1（是 VIP）→ 不跳，继续往下走。<br>' +
              '<span class="hit">记住"跳转条件"和"你想要的结果"往往是相反的——这是 27.11 和 27.12 两个实验的关键。</span>',
            state: { 'v0=0': '跳到 :cond_notvip', 'v0=1': '继续执行下一行' }
          },
          {
            code: '    <span class="k">invoke-static</span> {}, ' +
                  '<span class="t">Lcom/demo/app/Stat;</span>-><span class="f">report</span>()<span class="t">V</span>',
            note: '<b>对比一条静态调用。</b>花括号是空的——<b>静态方法没有接收者</b>，不需要传 this。<br>' +
              '返回类型是 <code>V</code>（void），所以<b>后面绝对不能跟 move-result</b>。<br>' +
              '要"去掉统计/上报调用"，删的就是这种行——但记得确认它后面没有 <code>move-result</code>。',
            state: { '花括号': '空 {}', '返回': 'V (void)', '后续': '不能有 move-result' }
          },
          {
            code: '    <span class="k">invoke-direct</span> {<span class="r">p0</span>}, ' +
                  '<span class="t">Lcom/demo/app/MainActivity;</span>-><span class="f">openVip</span>()' +
                  '<span class="t">V</span>',
            note: '<b>再看一条 invoke-direct。</b>目标方法如果是 <code>private</code>，或者你要写的是构造方法，' +
              '就属于这一类——<b>非虚、不可重写</b>。<br>' +
              '<span class="hit">判断口诀：能被重写 → virtual；不能被重写（private / 构造） → direct；' +
              '没有 this → static；调父类实现 → super；声明类型是接口 → interface。</span>',
            state: { '分派方式': 'direct（非虚）', '典型场景': 'private 方法 / 构造方法' }
          },
          {
            code: '    <span class="k">invoke-virtual/range</span> {<span class="r">p0</span> .. ' +
                  '<span class="r">p4</span>}, <span class="t">Lcom/demo/app/Api;</span>->' +
                  '<span class="f">sign</span>(<span class="t">Ljava/lang/String;I</span>)' +
                  '<span class="t">Ljava/lang/String;</span>',
            note: '<b>寄存器多于 5 个时改用 /range。</b><code>{p0 .. p4}</code> 这种"起止"写法要求寄存器连续，' +
              '好处是能表达任意多的参数。<br>' +
              '看到 <code>/range</code> 不要慌，它和普通写法是同一件事的两种编码——' +
              '区别只在"寄存器列表怎么表示"。<span class="pill warn">待核实</span> ' +
              '非 range 形式的寄存器编号上限（4 位字段）在不同文档里表述略有差异，动手改的时候以回编译报错为准。',
            state: { '写法': '{p0 .. p4}', '约束': '寄存器必须连续', '用途': '参数多 / 用高编号寄存器' }
          },
          {
            code: '    <span class="k">return-void</span>',
            note: '<b>返回。</b>方法签名最后是 <code>V</code>，所以用 <code>return-void</code>。<br>' +
              '四个 return 要分清：<code>return</code>（32 位）、<code>return-object</code>（对象）、' +
              '<code>return-wide</code>（64 位）、<code>return-void</code>（无返回）。<br>' +
              '<span class="hit">"方法末尾少了 return"是新手回编译时最常见的语法错误。</span>',
            state: { '签名返回类型': 'V', '对应指令': 'return-void' }
          }
        ]
      },
      after: T.note('ok', '✅ 一个能立刻用上的检查清单',
        '<p style="margin-bottom:0">改任何一条 <code>invoke</code> 之前，问自己四个问题：<br>' +
        '<b>① 目标方法是哪种分派？</b>（virtual / direct / static / super / interface）<br>' +
        '<b>② 花括号里的寄存器列表对不对？</b>（实例方法要带上接收者；静态方法不带；多参数用 /range）<br>' +
        '<b>③ 返回值有没有接？</b>（32 位 move-result / 对象 -object / 64 位 -wide / void 不接）<br>' +
        '<b>④ 有没有破坏"move-result 必须紧跟 invoke"这条约束？</b></p>')
    },

    /* ============================================================ 27.9 */
    {
      h: '27.9', title: '对象创建：为什么一行 new 会变成两行 Smali',
      html:
        '<p>这是本章点名要回答的问题，答案只有一句话：<b>因为 <code>new</code> 在字节码层面是两件事——' +
        '分配内存，和运行构造方法。</b>Java 把它们合成一个表达式，字节码把它们拆成两条指令。</p>' +
        T.code(
          '<span class="c">// Java</span>\n' +
          '<span class="t">User</span> u = <span class="k">new</span> <span class="f">User</span>();\n' +
          'u.<span class="f">setName</span>(<span class="s">"tom"</span>);\n\n' +
          '<span class="c"># Smali：一行 Java 变成三行</span>\n' +
          '<span class="k">new-instance</span> <span class="r">v0</span>, ' +
          '<span class="t">Lcom/demo/app/User;</span>              <span class="c"># ① 分配 + 标记类型</span>\n' +
          '<span class="k">invoke-direct</span> {<span class="r">v0</span>}, ' +
          '<span class="t">Lcom/demo/app/User;</span>-><span class="f">&lt;init&gt;</span>()<span class="t">V</span>  ' +
          '<span class="c"># ② 运行构造方法</span>\n' +
          '<span class="k">const-string</span> <span class="r">v1</span>, <span class="s">"tom"</span>\n' +
          '<span class="k">invoke-virtual</span> {<span class="r">v0</span>, <span class="r">v1</span>}, ' +
          '<span class="t">Lcom/demo/app/User;</span>-><span class="f">setName</span>(' +
          '<span class="t">Ljava/lang/String;</span>)<span class="t">V</span>   <span class="c"># ③ 用这个对象</span>'
        ) +
        T.tbl(['你在 Java 里写的', '字节码必须做的两件事', '为什么不能合成一条'],
          [
            ['<code>new User()</code>',
              '① <code>new-instance</code>：在堆上分配、把对象头里的类指针设成 <code>User</code>；' +
              '② <code>invoke-direct &lt;init&gt;</code>：跑构造方法（内含父类构造、字段初始化、构造体）',
              '因为"<b>分配</b>"和"<b>初始化</b>"可以被分开：先 <code>new-instance</code> 再决定调哪个构造器' +
              '（这正好对应 Java 里的构造器重载——参数不同，<code>&lt;init&gt;</code> 的签名就不同）'],
            ['<code>String s = "a" + b</code>',
              '<code>new-instance</code> StringBuilder → <code>invoke-direct &lt;init&gt;</code> → ' +
              '<code>append</code> → <code>toString</code>',
              '字符串拼接在字节码层面是<b>方法调用链</b>；现代编译器可能改用 <code>invokedynamic</code>/<code>invoke-custom</code>，' +
              '于是 Smali 里会看到 <code>invoke-custom</code>——<b>看到它不要以为文件坏了</b>'],
            ['<code>u.setName("tom")</code>',
              '<code>const-string</code> 先加载常量，再 <code>invoke-virtual</code>',
              '常量必须先落到寄存器。Smali 里几乎每条"看起来有字面量"的调用，上面都有一条 <code>const-*</code>']
          ]) +
        '<p>下面把这两步在内存里的样子演一遍。看完你就知道"为什么只写 <code>new-instance</code> 不写 <code>&lt;init&gt;</code> 会出事"。</p>',
      stage: {
        title: 'new-instance + invoke-direct &lt;init&gt;：对象诞生的两步',
        speed: 1800,
        render:
          '<div class="flow-col" style="gap:8px">' +
            '<div class="flow-row"><span class="pill mono">寄存器 v0</span>' +
              '<span class="blk" id="nRef">未初始化引用</span></div>' +
            '<div class="flow-row"><span class="arrow">↓</span>' +
              '<span class="blk" id="nIns">new-instance v0, Lcom/demo/app/User;</span></div>' +
            '<div class="flow-row"><span class="arrow">↓</span>' +
              '<span class="blk" id="nObj">堆上对象：klass_ 已设，字段全是零值</span></div>' +
            '<div class="flow-row"><span class="arrow">↓</span>' +
              '<span class="blk" id="nInit">invoke-direct {v0}, Lcom/demo/app/User;-&gt;&lt;init&gt;()V</span></div>' +
            '<div class="flow-row"><span class="arrow">↓</span>' +
              '<span class="blk" id="nReady">对象可用：字段已赋值，可以 invoke-virtual 了</span></div>' +
            '<div class="card" style="margin-top:8px"><div class="card-title">当前状态</div>' +
              '<div class="mono" id="nState">v0 = ?</div>' +
              '<div style="margin-top:8px"><span class="pill" id="nNote">点"单步"开始</span></div>' +
            '</div>' +
          '</div>',
        reset: () => {
          ['nRef','nIns','nObj','nInit','nReady'].forEach(i => S(i, ''));
          CLS('nNote', 'pill'); SET('nNote', '点"单步"开始');
          SET('nState', 'v0 = ?');
        },
        steps: [
          { run: () => { S('nRef', 'wr'); SET('nState', 'v0 = 尚未初始化（不能使用）'); },
            note: '<b>起点：v0 是个"还没初始化的引用"。</b>验证器对这类值有明确约束：' +
              '<b>不能用它去调方法、读字段</b>，唯一合法操作是把它当作接收者交给一个构造方法。' },
          { run: () => { S('nRef', 'done'); S('nIns', 'active'); SET('nState', 'v0 = 指向新对象（但字段还是零值）'); },
            note: '<b><code>new-instance</code> 只做分配。</b>结果是"堆上有一块内存，对象头里的类指针指向 <code>User</code>，' +
              '实例字段全是零值/null"。<br>' +
              '<span class="hit">注意：<code>new-instance</code> 自己把结果写进目标寄存器，' +
              '所以它<b>后面没有、也不需要 move-result</b>——这一点和 invoke 不一样，很多人在这里多写一行。</span>' },
          { run: () => { S('nIns', 'done'); S('nObj', 'active'); SET('nState', 'v0 = User 实例（字段：name = null）'); },
            note: '<b>此刻对象"存在但不可用"。</b>如果这是个带 <code>final</code> 字段、或者父类构造器里做了重要初始化的类，' +
              '你在这个时刻去读它的字段，会读到 null/0——这是"<b>泄漏 this</b>"这类 bug 的字节码根源。' },
          { run: () => { S('nObj', 'done'); S('nInit', 'hi'); SET('nState', 'v0 = 正在执行 &lt;init&gt;：父类构造 → 字段初始化 → 构造体'); },
            note: '<b><code>invoke-direct</code> 调用 <code>&lt;init&gt;</code>，对象正式初始化。</b>' +
              '构造方法内部会（编译器插入）先调父类构造方法，再执行实例字段的初始化和构造体。<br>' +
              '<b>为什么必须是 <code>invoke-direct</code>：</b>构造方法不可被重写（27.8 讲过），' +
              '所以走非虚调用。另外注意签名：<code>&lt;init&gt;()V</code> 返回类型永远是 <code>V</code>，没有返回值。' },
          { run: () => { S('nInit', 'done'); S('nReady', 'cool'); CLS('nNote', 'pill ok'); SET('nNote', '✅ 两步都做完了，对象才能用'); SET('nState', 'v0 = 可用对象'); },
            note: '<b>两步做完，才轮到 <code>iget</code> / <code>iput</code> / <code>invoke-virtual</code>。</b>' +
              '这就是"一行 Java 变两行 Smali"的完整答案：' +
              '<span class="hit">不是编译器啰嗦，而是"分配"和"初始化"本来就是两件可以分别发生的事。</span>' },
          { run: () => {
              S('nReady', 'bad'); CLS('nNote', 'pill bad');
              SET('nNote', '⚠️ 如果删掉 <init> 那一行会怎样');
              SET('nState', 'v0 = 未初始化引用 + 试图使用它 → 验证/运行阶段拒绝');
            },
            note: '<b>反过来说：想"跳过构造器直接造对象"是不成立的。</b>' +
              '只 <code>new-instance</code> 不调 <code>&lt;init&gt;</code>，然后拿这个引用去用，' +
              '会被字节码验证/运行时规则直接拦下。<br>' +
              '<span class="pill warn">待核实</span> 具体表现（安装校验失败、启动即崩、还是某个更具体的异常）' +
              '随 Android 版本和编译路径不同，<b>别背报错文案，记住规则本身</b>。' +
              '反过来说也有一条实用推论：<b>如果你看到某个对象是"绕过构造器"造出来的，' +
              '那一定是有人在更底层动了手脚</b>（比如 ART 层直接分配）——这正是有些 hook 框架和壳的做法。' }
        ]
      },
      after: T.note('', '🧭 把这条规律推广出去',
        '<p style="margin-bottom:0">"一行 Java → 多行 Smali"不止 <code>new</code> 一个案例，' +
        '它是一类现象：<b>Java 的语法糖在字节码层面都会被展开</b>。' +
        '字符串拼接展开成 StringBuilder、增强 for 展开成迭代器、自动装箱展开成 <code>valueOf</code>、' +
        'try-with-resources 展开成 finally 里的 <code>close</code>。<br>' +
        '所以读 Smali 时不要试图"逐行翻译回 Java"——' +
        '<b>要认的是"这段指令在做什么事"，而不是"这行对应哪句 Java"</b>。' +
        '这和你在第 3 章读汇编时学到的是同一个道理。</p>')
    },

    /* ============================================================ 27.10 */
    {
      h: '27.10', title: '控制流：标签、if、goto、switch、try/catch',
      intuition: {
        tag: '直觉模型 · 汇编里的"跳格子"',
        body:
          '<p>Java 里有 if/while/for/switch/try，字节码里只剩一种动作：<b>跳</b>。</p>' +
          '<p>循环是"往回跳"，if 是"条件满足就跳过一段"，switch 是"查表跳到某个格子"，' +
          'try/catch 是"我给这段划个范围，出事就跳到备用格子"。</p>' +
          '<p>所以读 Smali 的控制流，关键不是认关键字，而是<b>认跳转方向和目标标签</b>：' +
          '谁跳到谁、什么条件下跳、跳过去的那段是"成功路径"还是"失败路径"。' +
          '<span class="hit">把这三点认出来，一段控制流你就读懂了。</span></p>'
      },
      html:
        '<p>标签（label）是 Smali 里唯一"为了给人看"而存在的东西之一。它长这样：<code>:cond_0</code>、' +
        '<code>:goto_5</code>、<code>:pswitch_data_0</code>。名字只是工具按顺序起的，<b>不携带语义</b>——' +
        '所以你必须顺着跳转去判断它是哪条路径。</p>' +
        T.code(
          '<span class="c"># ① 条件跳转：两类，认清楚就不容易看反</span>\n' +
          '<span class="k">if-eqz</span> <span class="r">v0</span>, :<span class="f">cond_fail</span>   ' +
          '<span class="c"># v0 == 0 时跳（单寄存器 vs 零）</span>\n' +
          '<span class="k">if-nez</span> <span class="r">v0</span>, :<span class="f">cond_fail</span>   ' +
          '<span class="c"># v0 != 0 时跳（eq/ne/lt/ge/gt/le + z）</span>\n' +
          '<span class="k">if-lt</span> <span class="r">v0</span>, <span class="r">v1</span>, :<span class="f">cond_0</span> ' +
          '<span class="c"># 两个寄存器比较（不带 z）</span>\n\n' +
          '<span class="c"># ② 无条件跳转：goto（还有 /16 /32 变体，只是跳转距离不同）</span>\n' +
          '<span class="k">goto</span> :<span class="f">goto_end</span>\n\n' +
          '<span class="c"># ③ 分支表：switch 会被编译成查表跳转</span>\n' +
          '<span class="k">packed-switch</span> <span class="r">v0</span>, :<span class="f">pswitch_data_0</span>  ' +
          '<span class="c"># 键值连续（0,1,2,3…）</span>\n' +
          '<span class="k">sparse-switch</span> <span class="r">v0</span>, :<span class="f">sswitch_data_0</span>  ' +
          '<span class="c"># 键值稀疏（0, 5, 100, 0x7fffffff…）</span>\n\n' +
          '<span class="c">…方法体…</span>\n\n' +
          ':<span class="f">pswitch_data_0</span>\n' +
          '<span class="k">.packed-switch</span> <span class="n">0x0</span>\n' +
          '    :<span class="f">pswitch_0</span>     <span class="c"># case 0 → 跳到 :pswitch_0</span>\n' +
          '    :<span class="f">pswitch_1</span>     <span class="c"># case 1 → 跳到 :pswitch_1</span>\n' +
          '<span class="k">.end packed-switch</span>'
        ) +
        T.code(
          '<span class="c"># ④ try/catch：用"标号区间 + 处理器标签"表达</span>\n' +
          ':<span class="f">try_start_0</span>\n' +
          '    <span class="k">invoke-static</span> {}, ' +
          '<span class="t">Lcom/demo/app/Net;</span>-><span class="f">get</span>()' +
          '<span class="t">Ljava/lang/String;</span>\n' +
          '    <span class="k">move-result-object</span> <span class="r">v0</span>\n' +
          ':<span class="f">try_end_0</span>\n' +
          '    <span class="k">.catch</span> <span class="t">Ljava/io/IOException;</span> ' +
          '{:<span class="f">try_start_0</span> .. :<span class="f">try_end_0</span>} :<span class="f">catch_0</span>\n' +
          '    <span class="k">.catchall</span> {:<span class="f">try_start_0</span> .. :<span class="f">try_end_0</span>} ' +
          ':<span class="f">catchall_0</span>\n' +
          '    <span class="k">goto</span> :<span class="f">goto_end</span>\n\n' +
          ':<span class="f">catch_0</span>\n' +
          '    <span class="k">move-exception</span> <span class="r">v1</span>   ' +
          '<span class="c"># ★ 必须是处理器里的第一条指令</span>\n' +
          '    <span class="k">const-string</span> <span class="r">v0</span>, <span class="s">""</span>\n' +
          ':<span class="f">catchall_0</span>\n' +
          '    <span class="k">move-exception</span> <span class="r">v1</span>\n' +
          '    <span class="k">const/4</span> <span class="r">v0</span>, <span class="n">0x0</span>\n' +
          ':<span class="f">goto_end</span>\n' +
          '    <span class="k">return-object</span> <span class="r">v0</span>'
        ) +
        T.tbl(['你看到的', '它表达什么', '读的时候干什么'],
          [
            ['<code>if-*z</code>（带 z）', '一个寄存器与 0 比较', '先看跳转条件，再看它是"跳过成功块"还是"跳进失败块"'],
            ['<code>if-*</code>（不带 z）', '两个寄存器比较', '注意比较方向（<code>if-lt v0,v1</code> 是 v0&lt;v1）'],
            ['<code>:cond_*</code> / <code>:goto_*</code>', '工具生成的标签，<b>无语义</b>', '顺着它往下读，判断这段是成功路径还是失败路径'],
            ['<code>packed-switch</code>', '连续键值的 switch', '看 <code>.packed-switch</code> 里的起始值，逐个对齐 case'],
            ['<code>sparse-switch</code>', '稀疏键值的 switch', '看每对 "值 :标签"，常出现在状态机、协议分发里'],
            ['<code>:try_start_N</code> / <code>:try_end_N</code>', '受保护代码段的区间',
             '<b>这两类标签定义区间，不产生跳转</b>；真正跳转的是 <code>.catch</code> 指定的处理器'],
            ['<code>.catch</code> / <code>.catchall</code>', '捕获某个异常类型 / 捕获所有',
             '<code>.catchall</code> 对应 <code>finally</code> 或"吞掉一切"的兜底逻辑'],
            ['<code>move-exception vN</code>', '把刚抛出的异常对象搬到寄存器',
             '<b>它必须是处理器入口的第一条指令</b>；看到它就知道"这里开始是 catch 块"']
          ]) +
        T.note('key', '🔑 控制流的读法：先找"出口"，再找"条件"',
          '<p style="margin-bottom:0">一段陌生的控制流，<b>不要从头逐行读</b>。先做两件事：<br>' +
          '<b>① 找出口</b>：这段代码有几个 <code>return</code>？分别返回什么？<br>' +
          '<b>② 找条件</b>：每个 <code>if-*</code> 的跳转条件是什么，跳过去之后走到了哪个出口？<br>' +
          '这两步做完，中间那些 <code>goto</code> 和标签自己就归位了。' +
          '<span class="hit">你在 27.12 要做的"改哪一行"，本质就是在这张跳转图上找"最省事的那一刀"。</span></p>') +
        T.card('循环去哪了？',
          '<p><b>循环不是一种指令，而是"往回跳"的跳转。</b></p>' +
          '<p><code>while</code> / <code>for</code> 在字节码里长成"条件判断 + 往回 goto 到循环头"的形状；' +
          '增强 for 还会先展开成迭代器调用（<code>iterator()</code> → <code>hasNext()</code> → <code>next()</code>）。</p>' +
          '<p style="margin-bottom:0">所以看到一段"标签在下面、条件跳转往上"的结构，那就是循环。' +
          '<b>改循环相关的逻辑比改单个 if 危险得多</b>——因为你要同时照顾退出条件和循环体，' +
          '一不小心就是死循环（表现为 App 卡死，而不是崩溃）。</p>') +
        T.acc('📖 想深入字节码结构，下一步看哪里',
          '<p>本节的目的是"能读、能改"，不是"能写反汇编器"。' +
          '如果你想知道 <code>insns</code> 数组、<code>code_item</code>、分支偏移具体怎么编码的，' +
          '那是第 28 章（APK / DEX / ELF 文件格式解析）的内容。</p>' +
          '<p style="margin-bottom:0">另外别忘了 27.1 划的边界：<b>这里的"寄存器"全是虚拟寄存器</b>，' +
          'ART 怎么把它们映射到物理寄存器或栈帧，是运行时决定的。' +
          '想知道那部分，去第 4 章看 <code>ArtMethod</code> 与执行入口。</p>')
    },

    /* ============================================================ 27.11 */
    {
      h: '27.11', title: '动手实验一：读 Smali 说人话',
      html:
        '<p>纸上的规则看完了，现在验证一遍你是不是真的会读。' +
        '<b>下面这段 Smali 是真实结构（不是伪代码）</b>，包含构造方法、字段读写、字符串拼接的三件套。' +
        '你要回答三个问题，然后自己动手改一个字符串看看会发生什么。</p>',
      lab: {
        title: '实验：读 Smali 说人话',
        goal: '目标：说清它在做什么 + 算准寄存器',
        intro:
          '<p>任务：<br>' +
          '<b>①</b> 用一句话说清 <code>encrypt</code> 这个方法在做什么，等价于什么 Java 代码；<br>' +
          '<b>②</b> 算出 <code>encrypt</code> 里 <code>p0</code> 对应哪个 <code>v</code> 寄存器（填 <code>v?</code>）；<br>' +
          '<b>③</b> 解释为什么构造方法用 <code>invoke-direct</code> 而不是 <code>invoke-virtual</code>。<br>' +
          '填完后点运行，它会<b>真的解析你输入框里的 Smali</b>（你可以改它），并算出每个方法的寄存器布局。</p>',
        inputs: [
          { key: 'smali', label: 'Smali 片段（可以改它，再点运行）', type: 'textarea', rows: 18,
            hint: '实验会逐行解析 .method / .registers / 参数签名',
            value:
              '.class public Lcom/demo/app/CryptoUtil;\n' +
              '.super Ljava/lang/Object;\n' +
              '.source "CryptoUtil.java"\n' +
              '\n' +
              '# instance fields\n' +
              '.field private key:Ljava/lang/String;\n' +
              '\n' +
              '# direct methods\n' +
              '.method public constructor <init>(Ljava/lang/String;)V\n' +
              '    .registers 2\n' +
              '    invoke-direct {p0}, Ljava/lang/Object;-><init>()V\n' +
              '    iput-object p1, p0, Lcom/demo/app/CryptoUtil;->key:Ljava/lang/String;\n' +
              '    return-void\n' +
              '.end method\n' +
              '\n' +
              '.method public encrypt(Ljava/lang/String;)Ljava/lang/String;\n' +
              '    .registers 4\n' +
              '    new-instance v0, Ljava/lang/StringBuilder;\n' +
              '    invoke-direct {v0}, Ljava/lang/StringBuilder;-><init>()V\n' +
              '    iget-object v1, p0, Lcom/demo/app/CryptoUtil;->key:Ljava/lang/String;\n' +
              '    invoke-virtual {v0, v1}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;\n' +
              '    move-result-object v0\n' +
              '    invoke-virtual {v0, p1}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;\n' +
              '    move-result-object v0\n' +
              '    invoke-virtual {v0}, Ljava/lang/StringBuilder;->toString()Ljava/lang/String;\n' +
              '    move-result-object v0\n' +
              '    return-object v0\n' +
              '.end method' },
          { key: 'what', label: '① 这段 encrypt 在做什么？（一句话 + 等价 Java）', type: 'textarea', rows: 3,
            hint: '说清"用了哪个字段、对入参做了什么、返回什么"',
            ph: '它把……然后返回……，等价于 Java 的 ……' },
          { key: 'p0v', label: '② encrypt 里 p0 是哪个 v 寄存器？', hint: '填 v?', ph: 'v?' },
          { key: 'why', label: '③ 为什么构造方法用 invoke-direct？', type: 'textarea', rows: 2,
            hint: '想想"能不能被重写"', ph: '因为……' }
        ],
        runLabel: '🔍 解析这段 Smali',
        autorun: true,
        run: (v) => {
          const C = window.CRYPTO;
          const hEsc = s => String(s == null ? '' : s).split('').map(c =>
            c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c).join('');
          const src = String(v.smali || '');
          if (!src.trim()) return '<div class="lab-msg warn">输入框是空的。把上面的 Smali 粘回来再运行。</div>';

          const lines = src.split(/\r?\n/);
          const methods = [];
          let cur = null;
          const PRIM = { Z: 'boolean', B: 'byte', S: 'short', C: 'char', I: 'int', F: 'float', J: 'long', D: 'double', V: 'void' };
          const parseParams = (s) => {
            const out = []; let i = 0, inArr = false;
            while (i < s.length) {
              const c = s[i];
              if (c === '[') { inArr = true; i++; continue; }
              if (c === 'L') { const e = s.indexOf(';', i); if (e < 0) return null; out.push((inArr ? '[' : '') + s.slice(i, e + 1)); i = e + 1; }
              else if (PRIM[c]) { out.push((inArr ? '[' : '') + PRIM[c]); i++; }
              else return null;
              inArr = false;
            }
            return out;
          };
          const slotsOf = (t) => (t === 'long' || t === 'double') ? 2 : 1;

          lines.forEach((raw, idx) => {
            const t = raw.trim();
            const m = /^\.method\s+(.*)$/.exec(t);
            if (m) {
              const decl = m[1].trim();
              const mm = /([^\s(]+)\s*\(([^)]*)\)\s*(\S+)\s*$/.exec(decl);
              cur = { decl, name: mm ? mm[1] : '?', params: mm ? (parseParams(mm[2]) || []) : [],
                      ret: mm ? (PRIM[mm[3]] || mm[3]) : '?', regs: null, locals: null,
                      insts: [], invokes: {}, line: idx + 1 };
              methods.push(cur);
              return;
            }
            if (!cur) return;
            if (/^\.end method/.test(t)) { cur = null; return; }
            const r = /^\.registers\s+(\d+)/.exec(t);
            if (r) { cur.regs = Number(r[1]); return; }
            const l = /^\.locals\s+(\d+)/.exec(t);
            if (l) { cur.locals = Number(l[1]); return; }
            if (/^\.param\b/.test(t)) return;
            if (/^[.:#]/.test(t) || !t) return;                 // 指令/标签/注释
            cur.insts.push(t);
            const iv = /^(invoke-[a-z/-]+)/.exec(t);
            if (iv) cur.invokes[iv[1]] = (cur.invokes[iv[1]] || 0) + 1;
          });

          if (!methods.length) return '<div class="lab-msg fail"><b>没解析到任何方法</b>' +
            '<div class="lab-note">检查有没有 <code>.method …</code> 和 <code>.end method</code> 配对。</div></div>';

          let total = 0, rows = '';
          methods.forEach(mo => {
            const paramSlots = mo.params.reduce((a, x) => a + slotsOf(x), 0);
            const isCtor = /constructor|&lt;init&gt;/.test(mo.decl) || mo.name === '<init>';
            const isStatic = /\bstatic\b/.test(mo.decl);
            const pSlots = paramSlots + (isStatic ? 0 : 1);
            const localsN = mo.regs != null ? mo.regs - pSlots : (mo.locals != null ? mo.locals : null);
            const tot = mo.regs != null ? mo.regs : (mo.locals != null ? mo.locals + pSlots : null);
            total += mo.insts.length;
            const p0v = localsN != null ? localsN : '?';
            rows += '<tr><td><code>' + hEsc(mo.name) + '</code></td>' +
              '<td>' + (tot == null ? '?' : tot) + '</td>' +
              '<td>' + (localsN == null ? '?' : localsN) + '</td>' +
              '<td>' + pSlots + (isStatic ? '（静态，无 this）' : '（含 this）') + '</td>' +
              '<td><b>p0 = v' + p0v + '</b></td>' +
              '<td>' + mo.insts.length + '</td></tr>';
          });

          /* 真的把方法体规范化后算一个 SHA-1：这就是"完整性/方法体指纹"的文本版近似 */
          const bodyNorm = lines.filter(l => {
            const t = l.trim();
            return t && !/^(\.|:|#)/.test(t);
          }).join('').replace(/\s+/g, '');
          const fp = C.toHex(C.sha1(C.toBytes(bodyNorm))).slice(0, 32);

          return '<div class="lab-kv">' +
              '<span>方法数 <b>' + methods.length + '</b></span>' +
              '<span>指令行数 <b>' + total + '</b></span>' +
              '<span>指令指纹 <b>' + fp + '</b></span></div>' +
            '<table class="lab-tbl"><tr><th>方法</th><th>总槽位</th><th>本地槽位</th><th>参数槽位</th>' +
              '<th>p0 落在</th><th>指令数</th></tr>' + rows + '</table>' +
            '<div class="lab-msg key"><b>🔑 解析出的关键事实</b><div class="lab-note">' +
              '① <b>构造函数</b>：参数槽位 = <code>this</code> + String = 2，<code>.registers 2</code> → 本地 0 个，' +
              '<code>p0 = v0</code>（就是 this）、<code>p1 = v1</code>（那个 String）。<br>' +
              '② <b>encrypt</b>：<code>.registers 4</code>，参数槽位 2 → 本地 2 个（v0、v1），' +
              '<code>p0 = v2</code>、<code>p1 = v3</code>。<b>所以第②问的答案是 v2</b>。<br>' +
              '③ 指令指纹那一栏：把方法体的指令行去掉空白后算 SHA-1，' +
              '<b>改一个字它就会全变</b>——真实的完整性校验算的是 dex/so 的字节摘要，思路是同一个。' +
            '</div></div>' +
            '<div class="lab-msg"><b>这段 Smali 在做什么（逐段读法）</b><div class="lab-note">' +
              '<b>构造函数</b>：先 <code>invoke-direct</code> 调父类 <code>Object.&lt;init&gt;()</code>，' +
              '然后把 <code>p1</code>（传进来的 key）通过 <code>iput-object</code> 存进本对象的 <code>key</code> 字段。<br>' +
              '<b>encrypt</b>：<code>new-instance</code> + <code>invoke-direct &lt;init&gt;</code> 造一个 StringBuilder，' +
              '用 <code>iget-object</code> 取出自己的 <code>key</code> 字段追加进去，再追加 <code>p1</code>（入参），' +
              '最后 <code>toString()</code> 返回。<br>' +
              '<b>等价 Java：</b><code>public String encrypt(String s) { return this.key + s; }</code><br>' +
              '<span class="hit">注意：你在 Java 里看到的是 <code>+</code>，在 Smali 里看到的是一整条 StringBuilder 调用链——' +
              '这就是 27.9 说的"语法糖会被展开"。</span>' +
            '</div></div>';
        },
        expected: (v) => {
          const what = String(v.what || '');
          const p0 = String(v.p0v || '').trim().toLowerCase().replace(/\s+/g, '');
          const why = String(v.why || '');

          const whatOk = window.AKKC_hasConcept(what,
            ['拼接', '连接', '相加', '串起来', '拼起来', 'concat', 'stringbuilder',
             'key', '密钥', '字段', '返回', 'toString', 'append']);
          const whatDeep = window.AKKC_hasConcept(what, ['key', '密钥', '字段', '成员']);
          const p0Ok = /v?2$/.test(p0) || /v2/.test(p0);
          const whyOk = window.AKKC_hasConcept(why,
            ['构造', 'init', 'private', '私有', '不能重写', '不能被重写', '不可重写', '不能被覆盖',
             '非虚', 'direct', '没有虚方法', '不被分派', '不可覆盖', '重载']);

          return {
            ok: whatOk && whatDeep && p0Ok && whyOk,
            detail:
              (whatOk ? (whatDeep ? '✅ 说对了：它把自身的 <code>key</code> 字段与入参拼接后返回。'
                                 : '🟡 方向对了，但漏了关键：它用的是<b>自己的 <code>key</code> 字段</b>，不是别的。')
                      : '❌ 第①问还差得远。提示：看 <code>iget-object</code> 读了什么、<code>append</code> 追加了谁。') +
              '<br>' +
              (p0Ok ? '✅ p0 = <code>v2</code> 算对了（.registers 4，参数槽位 2，locals = 2）。'
                    : '❌ p0 不对。算一遍：<code>.registers 4</code>，参数槽位 = <code>this</code>(1) + ' +
                      '<code>String</code>(1) = 2，所以 locals = 4 - 2 = 2，<b>p0 = v(locals) = v2</b>，' +
                      '<code>p1 = v3</code>。') +
              '<br>' +
              (whyOk ? '✅ 构造方法的理由说对了：它不可被重写，所以走非虚调用。'
                     : '❌ 第③问要说到点上：<code>&lt;init&gt;</code> <b>不能被重写 / 没有虚方法表条目</b>，' +
                       '不存在"按实际类型分派一个构造器"这回事，所以只能用 <code>invoke-direct</code>。')
          };
        },
        showAnswer:
          '【① 它在做什么】\n' +
          '  encrypt(String s) 返回 this.key + s。\n' +
          '  Java 等价写法：\n' +
          '    public String encrypt(String s) { return this.key + s; }\n' +
          '  Smali 里之所以有 new-instance StringBuilder + 两次 append + toString，\n' +
          '  是因为 Java 的 + 拼接在字节码层被展开成了 StringBuilder 调用链。\n' +
          '  注意区别：取的是【自己的 key 字段】，不是静态常量、也不是入参。\n\n' +
          '【② p0 是哪个 v】\n' +
          '  .registers 4\n' +
          '  参数槽位 = this(1) + Ljava/lang/String;(1) = 2\n' +
          '  locals = 4 - 2 = 2          → v0、v1 是本地\n' +
          '  p0 = v(locals) = v2 （this）\n' +
          '  p1 = v3             （入参 String）\n\n' +
          '【③ 为什么构造方法用 invoke-direct】\n' +
          '  <init> 不能被重写：子类构造方法不是"覆盖"父类的 <init>，\n' +
          '  而是在自己第一行显式调用父类构造。它没有虚方法表条目，\n' +
          '  所以不存在"按对象实际类型分派构造器"的语义 —— 只能非虚调用。\n' +
          '  同一类里调 private 实例方法也是 invoke-direct，原因同样是"不可重写"。\n\n' +
          '【顺手能看出来的两件事】\n' +
          '  · 构造函数里 <init>()V 的返回类型永远是 V：构造方法没有返回值。\n' +
          '  · iput-object / iget-object 用的是 -object 后缀，因为字段类型是对象引用。\n' +
          '    如果字段是 int，就要换成 iget / iput（没有后缀）。',
        hint:
          '<b>读这段的顺序：</b>先看骨架（继承谁、有什么字段），再看每个方法里 <code>p</code> 和 <code>v</code> 各是谁。<br><br>' +
          '<b>第②问只用两个公式：</b><code>参数槽位 = 真实参数个数 + 1（实例方法）</code>，' +
          '<code>locals = .registers - 参数槽位</code>，然后 <code>p0 = v(locals)</code>。<br><br>' +
          '<b>第③问的方向：</b>想想"能不能被重写"这件事和分派方式的关系。' +
          '如果构造方法也能被"覆盖"，那 <code>new Foo()</code> 该跑谁的构造器？',
        after:
          T.note('ok', '✅ 实验的收获',
            '<p style="margin-bottom:0">你现在具备了一个真正的实用能力：' +
            '<b>把一段陌生 Smali 翻译成"它在做什么"，并且算清它的寄存器账。</b><br>' +
            '这两个能力合起来，就是"改 Smali 之前必须先做的事"。' +
            '<span class="hit">不能算清寄存器账的人改 Smali，等于闭着眼睛动手术。</span></p>')
      }
    },

    /* ============================================================ 27.12 */
    {
      h: '27.12', title: '动手实验二：改哪一行',
      html:
        '<p>这是本章第一个高潮。场景是<b>合法授权下的最小验证</b>：一个"VIP 校验恒失败"的界面，' +
        '你要让 VIP 内容能打开。但重点不是改出来，而是<b>搞清"改哪一行、为什么是那一行"</b>。</p>' +
        T.code(
          '<span class="c"># MainActivity.smali（节选）—— 行号只是给你指路用的，文件里没有行号</span>\n' +
          '1   <span class="k">.method</span> <span class="k">public</span> <span class="f">onClick</span>' +
          '(<span class="t">Landroid/view/View;</span>)<span class="t">V</span>\n' +
          '2       <span class="k">.registers</span> <span class="n">3</span>\n' +
          '3       <span class="k">invoke-virtual</span> {<span class="r">p0</span>}, ' +
          '<span class="t">Lcom/demo/app/MainActivity;</span>-><span class="f">isVip</span>()<span class="t">Z</span>\n' +
          '4       <span class="k">move-result</span> <span class="r">v0</span>\n' +
          '5       <span class="k">if-eqz</span> <span class="r">v0</span>, :<span class="f">cond_notvip</span>\n' +
          '6       <span class="k">invoke-direct</span> {<span class="r">p0</span>}, ' +
          '<span class="t">Lcom/demo/app/MainActivity;</span>-><span class="f">openVipContent</span>()<span class="t">V</span>\n' +
          '7       <span class="k">return-void</span>\n' +
          '8   :<span class="f">cond_notvip</span>\n' +
          '9       <span class="k">invoke-direct</span> {<span class="r">p0</span>}, ' +
          '<span class="t">Lcom/demo/app/MainActivity;</span>-><span class="f">showPayDialog</span>()<span class="t">V</span>\n' +
          '10      <span class="k">return-void</span>\n' +
          '11  <span class="k">.end method</span>'
        ) +
        '<p>先把这段读一遍：<b>什么时候走到第 6 行（打开 VIP 内容），什么时候走到第 9 行（弹付费框）？</b>' +
        '答案是：<code>v0 == 0</code>（不是 VIP）时第 5 行跳走，落到第 9 行；是 VIP 时第 5 行不跳，顺走到第 6 行。</p>' +
        T.note('key', '🔑 于是"改哪一行"变成了一道选择题',
          '<p style="margin-bottom:0">要让 VIP 内容<b>恒</b>打开（不管 <code>isVip()</code> 返回什么），你有三条路：<br>' +
          '<b>① 改结果</b>：让 <code>v0</code> 永远是 1 —— 但要改对那一行，别把 <code>move-result</code> 变成孤儿。<br>' +
          '<b>② 改分支</b>：让第 5 行的跳转永不发生 —— 但这和"把条件取反"是两回事，取反只在特定状态下成立。<br>' +
          '<b>③ 改上游</b>：改 <code>isVip()</code> 自己的返回值 —— 有效，但影响面更大（别处也可能在用它）。<br>' +
          '<span class="hit">下面的实验会真的模拟这段指令流，把两种状态下分别走到哪条路算给你看。写错了我不会只说"错"，' +
          '会告诉你"在哪种情况下错"。</span></p>') +
        '<p>提示：这个实验支持你写 <code>const/4</code>、<code>if-eqz</code>、<code>if-nez</code>、<code>goto</code>、' +
        '<code>invoke-*</code>、<code>return-void</code>，或者写一个 <code>#</code> 开头的内容表示"把这一行注释掉"。' +
        '它会照你写的去解释执行。</p>',
      lab: {
        title: '实验：让 VIP 路径恒成立，并说明你为什么这么改',
        goal: '目标：选出正确的那一行与改法',
        intro:
          '<p>两个输入框：<b>你要改第几行</b>（填 3–10），<b>改成什么</b>。</p>' +
          '<p>系统会把你的改动套进这段指令流，然后分别用"<b>isVip() 返回 false</b>"和"<b>返回 true</b>"两种状态各跑一遍——' +
          '只有<b>两种状态都走到第 6 行</b>，才算真正改对了。</p>',
        inputs: [
          { key: 'line', label: '① 你要改第几行？', hint: '填 3–10 之间的行号', value: '4' },
          { key: 'newins', label: '② 改成什么？（写替换后的整行；写 # 表示把这一行注释掉）',
            hint: '例如 const/4 v0, 0x1 或 # 或 if-nez v0, :cond_notvip',
            value: 'const/4 v0, 0x1' }
        ],
        runLabel: '🔍 套用改动并模拟两种状态',
        autorun: true,
        run: (v) => {
          const esc27 = s => String(s == null ? '' : s).split('').map(ch => {
            if (ch === '&') { return '&amp;'; }
            if (ch === '<') { return '&lt;'; }
            if (ch === '>') { return '&gt;'; }
            if (ch === '"') { return '&quot;'; }
            if (ch === "'") { return '&#39;'; }
            return ch;
          }).join('');
          const lnRaw = String(v.line || '').replace(/[^0-9]/g, '');
          const ln = lnRaw ? Number(lnRaw) : NaN;
          const newins = String(v.newins || '').trim();

          /* 原始指令流（这是"真实结构"，行号与上面代码块一致） */
          const PROG = [
            { n: 3, kind: 'invoke', name: 'isVip', ret: 'Z' },
            { n: 4, kind: 'moveresult', dst: 'v0' },
            { n: 5, kind: 'branch', op: 'if-eqz', reg: 'v0', label: 'cond_notvip' },
            { n: 6, kind: 'invoke', name: 'openVipContent', ret: 'V', vip: true },
            { n: 7, kind: 'ret' },
            { n: 8, kind: 'label', label: 'cond_notvip' },
            { n: 9, kind: 'invoke', name: 'showPayDialog', ret: 'V', pay: true },
            { n: 10, kind: 'ret' }
          ];
          const LABELS = PROG.filter(x => x.kind === 'label').map(x => x.label);

          if (!isFinite(ln) || !PROG.some(x => x.n === ln)) {
            return '<div class="lab-msg warn">先填一个有效的行号（3 到 10 之间）。' +
              '本实验只模拟上面代码块里的这段指令流。</div>';
          }

          /* --- 解析读者写的替换指令 --- */
          const parse = (s) => {
            const t = s.trim();
            if (!t || t === '#' || /^#/.test(t)) return { kind: 'delete', text: t };
            let m;
            if ((m = /^const\/4\s+(v\d+)\s*,\s*(0x[0-9a-f]+|\d+)/i.exec(t))) {
              const val = /^0x/i.test(m[2]) ? parseInt(m[2], 16) : parseInt(m[2], 10);
              return { kind: 'const', dst: m[1], val: val };
            }
            if ((m = /^(if-(?:eq|ne|lt|ge|gt|le)z?)\s+(v\d+)(?:\s*,\s*(v\d+))?\s*,\s*:(\S+)/i.exec(t))) {
              return { kind: 'branch', op: m[1].toLowerCase(), reg: m[2], reg2: m[3], label: m[4] };
            }
            if ((m = /^goto(?:\/\d+)?\s+:(\S+)/i.exec(t))) return { kind: 'goto', label: m[1] };
            if (/^invoke-[a-z/-]+/i.test(t)) {
              const b1 = t.indexOf('{'), b2 = t.indexOf('}');
              if (b1 < 0 || b2 < b1) return { kind: 'unknown', text: t };
              const regs = t.slice(b1 + 1, b2).trim();
              const rest = t.slice(b2 + 1).replace(/^\s*,\s*/, '');
              const im = /^(\S+?)->([\w<>$]+)\(([^)]*)\)(\S+)/.exec(rest);
              const opm = /^(invoke-[a-z/-]+)/i.exec(t);
              if (!im) return { kind: 'unknown', text: t };
              return { kind: 'invoke', op: opm[1].toLowerCase(), regs: regs, target: im[2], ret: im[4] };
            }
            if (/^return-void$/i.test(t)) return { kind: 'ret' };
            if (/^move-result(-object|-wide)?$/i.test(t)) return { kind: 'moveresult', dst: '?' };
            return { kind: 'unknown', text: t };
          };

          const edit = parse(newins);
          if (edit.kind === 'unknown') {
            return '<div class="lab-msg fail"><b>这条指令本实验解释不了</b>' +
              '<div class="lab-note">你写的是：<code>' + esc27(edit.text) + '</code><br>' +
              '本实验支持：<code>const/4 vN, 0x0|0x1</code>、<code>if-*z vN, :label</code>、' +
              '<code>goto :label</code>、<code>invoke-* {...}, L…;-&gt;m()T</code>、<code>return-void</code>、' +
              '或 <code>#</code>（注释掉这一行）。<br>' +
              '<span class="hit">这一点本身就值得记住：Smali 不是自由文本，写错一个字符就是回编译失败或验证失败。</span>' +
              '</div></div>';
          }
          if (edit.kind === 'goto' && !LABELS.includes(edit.label)) {
            return '<div class="lab-msg fail"><b>目标标签不存在</b>' +
              '<div class="lab-note">你写了 <code>goto :' + esc27(edit.label) + '</code>，' +
              '但这段代码里只有标签 <code>' + LABELS.map(x => ':' + x).join('</code>、<code>') + '</code>。<br>' +
              '<b>跳到不存在的标签 → 回编译就会报错</b>（这是 apktool b 最常见的失败原因之一）。<br>' +
              '如果你想"无条件走 VIP 路径"，在这段代码里最直接的写法是<b>把第 5 行（那条 if）去掉</b>——' +
              '不跳转，自然就顺走到第 6 行。</div></div>';
          }

          /* --- 真正解释执行：pending = 上一次 invoke 的返回值 --- */
          const simulate = (vipState) => {
            let reg = { v0: 0 };
            let pending;                       // undefined = 没有待接收的返回值
            let hasPending = false;
            let pc = 0, guard = 0, trace = [], called = null, err = null;
            while (pc < PROG.length && guard++ < 200) {
              let ins = PROG[pc];
              let isEdited = (ins.n === ln);
              let eff = ins;
              if (isEdited) {
                if (edit.kind === 'delete') { pc++; continue; }
                eff = Object.assign({ n: ins.n }, edit);
              }
              if (eff.kind === 'label') { pc++; continue; }
              if (eff.kind === 'invoke') {
                trace.push('L' + ins.n + ' invoke ' + (eff.name || eff.target || '?'));
                if ((eff.name === 'isVip') || /isVip/.test(eff.target || '')) { pending = vipState ? 1 : 0; hasPending = true; }
                else { hasPending = false; if (eff.vip) called = 'vip'; if (eff.pay) called = 'pay'; }
                pc++;
                if (called) return { called, trace, err: null };
                continue;
              }
              if (eff.kind === 'moveresult') {
                if (!hasPending) { err = '第 ' + ins.n + ' 行的 move-result 前面没有 invoke —— ' +
                  '没有返回值可接。Smali 规定 move-result 必须紧跟在 invoke 之后，这种写法回编译就会失败（或语义不成立）。'; return { called: null, trace, err }; }
                reg['v0'] = pending; hasPending = false;
                trace.push('L' + ins.n + ' move-result v0 = ' + pending);
                pc++; continue;
              }
              if (eff.kind === 'const') { reg[eff.dst] = eff.val; trace.push('L' + ins.n + ' const ' + eff.dst + ' = ' + eff.val); pc++; continue; }
              if (eff.kind === 'branch') {
                const a = reg[eff.reg] | 0, b = eff.reg2 != null ? (reg[eff.reg2] | 0) : 0;
                const op = eff.op;
                let take = false;
                if (op === 'if-eqz') take = a === 0;
                else if (op === 'if-nez') take = a !== 0;
                else if (op === 'if-ltz') take = a < 0;
                else if (op === 'if-gtz') take = a > 0;
                else if (op === 'if-lez') take = a <= 0;
                else if (op === 'if-gez') take = a >= 0;
                else if (op === 'if-eq') take = a === b;
                else if (op === 'if-ne') take = a !== b;
                else if (op === 'if-lt') take = a < b;
                else if (op === 'if-ge') take = a >= b;
                else if (op === 'if-gt') take = a > b;
                else if (op === 'if-le') take = a <= b;
                trace.push('L' + ins.n + ' ' + op + ' (v0=' + a + ') → ' + (take ? '跳转 :' + eff.label : '不跳'));
                if (take) {
                  const t = PROG.findIndex(x => x.kind === 'label' && x.label === eff.label);
                  if (t < 0) return { called: null, trace, err: '跳转到不存在的标签 :' + eff.label };
                  pc = t; continue;
                }
                pc++; continue;
              }
              if (eff.kind === 'ret') { trace.push('L' + ins.n + ' return-void（方法结束）'); return { called, trace, err: null }; }
              pc++;
            }
            return { called, trace, err };
          };

          const s0 = simulate(false), s1 = simulate(true);
          const lineOf = x => x.err ? '<span class="miss">无法执行</span>'
            : (x.called === 'vip' ? '<span class="hit">打开 VIP 内容（第 6 行）</span>'
              : x.called === 'pay' ? '<span class="miss">弹付费框（第 9 行）</span>'
                : '<span class="miss">没走到任何分支就结束了</span>');
          const robust = !s0.err && !s1.err && s0.called === 'vip' && s1.called === 'vip';

          let html = '<div class="lab-kv"><span>改动：第 <b>' + ln + '</b> 行 → ' +
            '<code>' + esc27(newins || '（空）') + '</code></span></div>';
          html += '<table class="lab-tbl"><tr><th>isVip() 的返回值</th><th>实际走到</th><th>执行轨迹</th></tr>' +
            '<tr><td><code>false</code>（0，非会员）</td><td>' + lineOf(s0) + '</td><td class="mono" style="font-size:11px">' +
              esc27(s0.err || s0.trace.join(' → ')) + '</td></tr>' +
            '<tr><td><code>true</code>（1，会员）</td><td>' + lineOf(s1) + '</td><td class="mono" style="font-size:11px">' +
              esc27(s1.err || s1.trace.join(' → ')) + '</td></tr></table>';

          if (s0.err || s1.err) {
            html += '<div class="lab-msg fail"><b>这段改动不成立</b><div class="lab-note">' +
              esc27(s0.err || s1.err) + '</div></div>';
          } else if (robust) {
            html += '<div class="lab-msg pass"><b>✅ 两种状态都走到了 VIP 路径</b><div class="lab-note">' +
              '你的改动让 VIP 分支<b>恒成立</b>，与 <code>isVip()</code> 的返回值无关。' +
              '这才是"改对了"。<br>' +
              '接下来自己要能回答：<b>我改的这一行的语义为什么决定了结果？</b>' +
              '（看上面两条轨迹里，被改动的那一行分别做了什么。）</div></div>';
          } else {
            html += '<div class="lab-msg fail"><b>❌ 只在一种状态下成立</b><div class="lab-note">' +
              '非会员状态：' + (s0.called === 'vip' ? '走到了 VIP 路径' : '没走到 VIP 路径') + '；' +
              '会员状态：' + (s1.called === 'vip' ? '走到了 VIP 路径' : '没走到 VIP 路径') + '。<br>' +
              '<b>一个只在特定状态下"看起来成功"的改动，是改包最大的陷阱</b>——' +
              '你测试时恰好是非会员，就以为成功了，结果真实用户（或者别的分支）走的是另一条路。' +
              '<span class="hit">判断标准永远是"恒成立"，不是"这次成功了"。</span></div></div>';
          }
          return html;
        },
        expected: (v) => {
          const lnRaw = String(v.line || '').replace(/[^0-9]/g, '');
          const ln = lnRaw ? Number(lnRaw) : NaN;
          const t = String(v.newins || '').trim();
          const isDelete = !t || /^#/.test(t);
          const isConst1 = /^const\/4\s+v0\s*,\s*(0x1|1)\b/i.test(t);
          const isIfNez = /^if-nez\s+v0\s*,\s*:cond_notvip/i.test(t);
          const isInvokeBad = /^invoke-static/i.test(t);
          const isReturn = /^return/i.test(t);

          if (!isFinite(ln)) return { ok: false, detail: '❌ 先在①里填一个行号（3–10）。' };
          if (!/^(#|const\/4|if-|goto|invoke-|return|move-result)/i.test(t)) {
            return { ok: false, detail: '❌ ②里写的不是本实验能解释的 Smali 指令：<code>' +
              String(t).replace(/</g, '&lt;') + '</code><br>' +
              '可用写法：<code>const/4 v0, 0x1</code>、<code>if-eqz v0, :cond_notvip</code>、' +
              '<code>goto :cond_notvip</code>、<code>invoke-* {...}, L…;-&gt;m()T</code>、' +
              '<code>return-void</code>，或者写 <code>#</code> 表示把这一行注释掉。<br>' +
              '<span class="hit">Smali 不是自由文本：写错一个字符，回编译就会失败。</span>' };
          }

          if (ln === 4 && isConst1) {
            return { ok: true, detail: '✅ <b>这就是最稳的一刀。</b>第 4 行 <code>move-result v0</code> 是' +
              '"把 <code>isVip()</code> 的结果搬进 v0"的唯一入口。把它换成 <code>const/4 v0, 0x1</code>，' +
              '等于<b>在源头上把结果改成 1</b>：后面的分支逻辑一个字没动，两种状态都走 VIP 路径。<br>' +
              '<b>为什么它比"改第 5 行的跳转条件"更好：</b>因为 v0 的值就是这段代码的"事实"，' +
              '改事实比改判断更不容易留下反直觉的边界（见下面第 5 行的分析）。' };
          }
          if (ln === 5 && isDelete) {
            return { ok: true, detail: '✅ <b>也对，而且是一个很干净的改法。</b>把第 5 行那条 <code>if-eqz</code> 去掉，' +
              '等于"永不跳转"——执行流从第 4 行直接落到第 6 行。<br>' +
              '注意你删的是<b>分支</b>而不是"把条件取反"：<b>删除 = 无条件走 VIP 路径（恒成立）</b>，' +
              '取反 = 只在一种状态下成立。这两者天差地别。' };
          }
          if (ln === 5 && isIfNez) {
            return { ok: false, detail: '❌ <b>这是本章最值得记住的陷阱。</b>' +
              '<code>if-nez</code> 是"<b>把跳转条件取反</b>"，不是"让 VIP 恒成立"。<br>' +
              '取反之后的语义是：<b>v0 != 0 时跳到付费分支</b>。<br>' +
              '· 非会员（v0=0）→ 不跳 → 顺走到 VIP 路径 ✅<br>' +
              '· 会员（v0=1）→ 跳转 → 落到付费弹窗 ❌<br>' +
              '<span class="hit">你只是把"会员被拦、非会员放行"倒了过来，逻辑依然是反的。</span>' +
              '如果你测试时恰好是非会员状态，<b>你会以为成功了</b>——这就是"改包改出玄学"的经典成因。<br>' +
              '想达到"恒真"，要么改事实（第 4 行 <code>const/4 v0, 0x1</code>），要么删掉分支（第 5 行注释掉）。' };
          }
          if (ln === 3) {
            return { ok: false, detail: '❌ 第 3 行是<b>发起调用</b>那一步，它只负责"去问 isVip 是真是假"。' +
              '改它有几个问题：<br>· 只改第 3 行、留着第 4 行的 <code>move-result</code>，' +
              '就变成"没有 invoke 的 move-result"——<b>没有返回值可接</b>，回编译/验证阶段就会出问题；<br>' +
              '· 就算你把 3、4 两行一起换掉，本质上和第 4 行的改法是同一件事，但动了两行、风险更大。<br>' +
              '<b>原则：能改一行就别改两行；能改结果就别改调用。</b>' };
          }
          if (isReturn) {
            return { ok: false, detail: '❌ 你把某一行换成了 <code>return</code>。' +
              '这样只会让方法<b>提前结束</b>：什么都不会发生（VIP 内容不打开、付费框也不弹），' +
              '用户表现为"点了没反应"。<br><b>注意"更好的失败"和"更差的失败"</b>：' +
              '改动引起功能缺失，往往比崩溃更难被发现。' };
          }
          if (isInvokeBad) {
            return { ok: false, detail: '❌ 把调用方式改成 <code>invoke-static</code> 会破坏语义：' +
              '<code>openVipContent</code> 是实例方法（内部要用 this），静态调用既不符合分派方式，' +
              '寄存器列表也对不上（静态方法不该传接收者）。<br>' +
              '这类改动的结果是<b>回编译可能过、运行时崩</b>——比语法错误更难查。' };
          }
          return { ok: false, detail: '❌ 这个组合还不是"恒成立"的改法。' +
            '回到这段代码的语义上想：<b>要么让 v0 这个"事实"永远是 1，要么让那条跳转永不发生。</b><br>' +
            '可用的写法：把第 4 行换成 <code>const/4 v0, 0x1</code>（在源头上改事实）；' +
            '或者把第 5 行注释掉（去掉跳转）。' };
        },
        showAnswer:
          '【推荐改法（最稳、只动一行）】\n' +
          '  第 4 行：move-result v0\n' +
          '  改成  ：const/4 v0, 0x1\n' +
          '  理由：第 4 行是"把 isVip() 的结果搬进 v0"的唯一入口。\n' +
          '        把它换成常量 1，等于在源头把"事实"改成"是会员"，\n' +
          '        后面的分支指令一行不改，两种状态都走 VIP 路径。\n' +
          '  自检：改完这一行，v0 永远是 1；第 5 行 if-eqz 永不成立、永不跳转。\n\n' +
          '【等价改法（去掉分支）】\n' +
          '  第 5 行：if-eqz v0, :cond_notvip\n' +
          '  改成  ：# if-eqz v0, :cond_notvip     （Smali 注释用 #）\n' +
          '  理由：删掉跳转 = 无条件顺走到第 6 行 = VIP 路径恒成立。\n' +
          '  注意：注释掉一行是合法的，但如果你删掉一条 invoke，\n' +
          '        它后面紧邻的 move-result 必须一起处理。\n\n' +
          '【为什么不能把 if-eqz 改成 if-nez】\n' +
          '  这是"取反"，不是"恒真"：\n' +
          '    if-nez v0, :cond_notvip  =  v0 != 0 时跳到付费分支\n' +
          '    非会员 v0=0 → 不跳 → 走 VIP 路径  ✅\n' +
          '    会员   v0=1 → 跳转 → 落到付费弹窗 ❌\n' +
          '  你以为自己破解了，其实只是把判断倒过来。\n' +
          '  【判断标准】改动必须在【所有可能状态】下都达到目的，\n' +
          '  而不是"我这次测试成功了"。\n\n' +
          '【第三条路：改上游 isVip() 本身】\n' +
          '  在 isVip() 方法体里让它恒返回 1（const/4 v0, 0x1 + return v0）。\n' +
          '  有效，但影响面更大：全 App 所有用 isVip() 的地方都会被影响。\n' +
          '  如果别处有"会员才能看的入口"依赖它，可能反而暴露异常 UI。\n' +
          '  改哪一层，取决于你想要多大的影响面 —— 这是工程判断，不是对错。\n\n' +
          '【这一步真正的收获】\n' +
          '  "改 Smali"不是玄学：每一行都有明确语义，改动等于改变一段控制流的输入或判断。\n' +
          '  能说清"改这一行为什么能达到目的、在哪些状态下不成立"，才算会改。',
        hint:
          '<b>先回答一个问题：这段代码里，谁决定"是不是会员"？</b>' +
          '<code>v0</code> 的值就是答案，而它只在一个地方被写入（第 4 行的 <code>move-result</code>）。<br><br>' +
          '<b>再回答第二个：第 5 行的跳转条件是什么？</b><code>if-eqz</code> 在 <code>v0 == 0</code> 时跳。' +
          '跳过去就会落到第 9 行的付费弹窗——所以"跳转"是<b>坏结果</b>。<br><br>' +
          '<b>于是有两条路：</b>让 <code>v0</code> 永远是 1（改事实），或者让这条跳转永不发生（删掉它）。<br><br>' +
          '<b>小心陷阱：</b><code>if-nez</code> 看起来"反过来了"，但它不是"恒真"——想想会员状态下会发生什么。',
        after:
          T.note('ok', '✅ 实验的收获',
            '<p style="margin-bottom:0">你现在应该能区分子三类改动，这个区分比"会不会改"重要得多：<br>' +
            '<b>① 改事实</b>（改值/改返回）——影响面小、语义清晰，通常最稳；<br>' +
            '<b>② 改判断</b>（删分支/改跳转）——要分清"恒真"和"取反"；<br>' +
            '<b>③ 改上游</b>（改被调用方）——有效但影响面最大，可能连带改变别处行为。<br>' +
            '<span class="hit">真实工作里，"想清楚改哪一层"花的时间应该比"改"本身多。</span></p>')
      }
    },

    /* ============================================================ 27.13 */
    {
      h: '27.13', title: '实战方法：怎么找到该改的那一行',
      html:
        '<p>上一节我们给你准备好了代码，所以"改哪一行"看起来简单。' +
        '真实情况是：<b>你手上只有一个几百 MB 的 APK 和一个"某个按钮点了没反应"的现象。</b>' +
        '下面这五步是把它变成"确定的一行"的通用方法。</p>' +
        T.note('key', '🔑 合法边界（先划清楚）',
          '<p style="margin-bottom:0">这一节的适用范围是：<b>你拥有或已获授权测试的 App</b>、' +
          'CTF 题目、自己的产品做加固自检、以及公开的教学样本。' +
          '对不拥有、未授权的线上产品做这些操作，可能违反用户协议甚至法律，' +
          '<b>本课程不提供针对具体线上产品的操作指引。</b></p>') +
        '<p>下面把"从现象到那一行"的过程拆成六步。注意第 4 步是<b>Smali 独有的优势</b>——' +
        '你在 ARM 那侧（第 3 章）做同样的事要难得多。</p>',
      stepper: {
        title: '从"现象"到"那一行"：六步定位法',
        lines: [
          {
            code: '<span class="c">第 1 步：从现象反推"关键字"</span>\n' +
                  '<span class="c"># 现象：点"开通会员"弹出一句固定文案</span>\n' +
                  '<span class="c"># 现象：logcat 里有一行固定 tag 的日志</span>\n' +
                  '<span class="c"># 现象：界面上有固定文案的按钮 / 标题</span>',
            note: '<b>先找"用户能看见 / 日志能看见"的字符串。</b>' +
              '现象 → 文案 → 字符串常量，这是最省力的一条线。<br>' +
              '如果文案在资源里（<code>strings.xml</code>），就找它的 <code>name</code>，' +
              '再找 <code>R.string.xxx</code> 的引用点；如果是硬编码在代码里的，它就会以 ' +
              '<code>const-string</code> 的形式出现在 Smali 里。<br>' +
              '<span class="pill warn">待核实</span> 加固/资源混淆之后，资源名可能被改成 <code>a</code>、<code>b</code> 这类，' +
              '这条线会断——那就走第 2 步的方法名/调用链。',
            state: { '输入': '用户能看到的一句文案', '输出': '一个可以搜的字符串' }
          },
          {
            code: '<span class="c">第 2 步：用 jadx 搜关键字，拿到"类 + 方法 + 签名"</span>\n' +
                  '<span class="c"># jadx 里搜字符串 → 定位到某个方法 → 记下：</span>\n' +
                  '<span class="c">#   Lcom/demo/app/MainActivity;->onClick(Landroid/view/View;)V</span>',
            note: '<b>用反编译器搜，是为了"看得快"，不是为了"改"。</b>' +
              'jadx 的搜索和跳转比在 smali 目录里 grep 舒服得多，先用它把目标缩小到一个方法。<br>' +
              '关键产出是一条<b>完整的成员签名</b>：类描述符 + 方法名 + 参数与返回类型。' +
              '有了它，下一步就是纯粹的"按图找文件"。',
            state: { '产出': '完整成员签名', '注意': 'jadx 的"Java 代码"是猜的，只用来定位' }
          },
          {
            code: '<span class="c">第 3 步：按包路径找到对应的 .smali 文件</span>\n' +
                  '<span class="c"># Lcom/demo/app/MainActivity;  →  smali/com/demo/app/MainActivity.smali</span>\n' +
                  '<span class="c"># 多 dex 时注意：smali/ 是第一个 dex，smali_classes2/ 是第二个……</span>',
            note: '<b>baksmali / apktool 的目录结构 = 包名结构。</b>找不到文件时先想两件事：<br>' +
              '<b>① 是不是在别的 dex 里</b>（<code>smali_classes2</code>、<code>smali_classes3</code>……）；<br>' +
              '<b>② 类名里的 <code>$</code></b> 表示内部类，文件名里会写成 <code>Outer$Inner.smali</code>。<br>' +
              '<span class="hit">这两个原因是"我明明搜到了类名，却在目录里找不到文件"的全部答案。</span>',
            state: { '映射规则': 'L包/路径/类; → 包/路径/类.smali', '多 dex': 'smali_classes2/ …' }
          },
          {
            code: '<span class="c">第 4 步（Smali 独有的杀手锏）：直接 grep 交叉引用</span>\n' +
                  '<span class="c"># 找"谁调用了 isVip"——因为 Smali 是文本，方法名是字面量</span>\n' +
                  '<span class="c">grep -rn "isVip()Z" smali/ smali_classes*/</span>',
            note: '<b>这是 Smali 相对"纯字节码"最大的优势。</b>' +
              'dex 里存的是 method 索引编号，直接搜字节是搜不到名字的；' +
              '而 Smali 把索引翻译成了完整名字，<b>于是"谁调用了这个方法"变成一个 grep 问题</b>。<br>' +
              '<span class="hit">你要改的往往不是"定义"，而是"调用点"。</span>' +
              '比如 VIP 判断的<b>定义</b>在 <code>User.smali</code>，但真正决定"这个按钮能不能点"的是' +
              '<code>MainActivity.smali</code> 里那次 <code>invoke-virtual</code>。<br>' +
              '（反编译器的 <code>Find usages</code> 也能做这件事；两种都行，grep 更直接。）',
            state: { '搜索对象': '方法名 + 签名', '得到': '所有调用点', '价值': '找到"真正该改的调用点"' }
          },
          {
            code: '<span class="c">第 5 步：在调用点定位"哪条分支是成功"</span>\n' +
                  '<span class="k">invoke-virtual</span> {<span class="r">p0</span>}, ' +
                  '<span class="t">Lcom/demo/app/MainActivity;</span>-><span class="f">isVip</span>()<span class="t">Z</span>\n' +
                  '<span class="k">move-result</span> <span class="r">v0</span>\n' +
                  '<span class="k">if-eqz</span> <span class="r">v0</span>, :<span class="f">cond_0</span>   ' +
                  '<span class="c"># ← 跳过去的那段是成功还是失败？</span>',
            note: '<b>这一步是全部判断力的所在，也是不能偷懒的一步。</b>' +
              '方法只有一个：<b>顺着两条路径各往下读几行，看它们分别做了什么</b>' +
              '（一个调用了"打开内容"，一个调用了"弹付费框"）——然后你就知道"跳"代表什么。<br>' +
              '<span class="hit">不要根据 <code>if-eqz</code> 或 <code>if-nez</code> 猜结果。</span>' +
              '同样是 <code>if-eqz</code>，在不同代码里可能"跳过去是成功"也可能"跳过去是失败"，' +
              '取决于作者怎么写。唯一的依据是那两条路径实际做了什么。',
            state: { '判断依据': '两条路径分别调用了什么', '禁止': '靠助记符猜' }
          },
          {
            code: '<span class="c">第 6 步：改完之后，逐项自检</span>\n' +
                  '<span class="c"># ① 寄存器编号有没有越界（不能超过 .registers 声明的范围）</span>\n' +
                  '<span class="c"># ② move-result 有没有变成孤儿（前面没有 invoke）</span>\n' +
                  '<span class="c"># ③ 有没有动过 .registers / .locals（动了就要全方法体重算）</span>\n' +
                  '<span class="c"># ④ 删掉的 invoke 有没有跟它配对的 move-result</span>',
            note: '<b>改包翻车，一半翻在这一步。</b>上面四条已经是"改 Smali 自检四问"的完整版了，' +
              '每一条都对应一个具体的失败形态：<br>' +
              '① 回编译报错或运行时崩（越界）；<br>' +
              '② 回编译失败（孤儿 move-result）；<br>' +
              '③ 运行结果莫名其妙地错（寄存器整体平移）；<br>' +
              '④ 和 ② 同类，但如果原来那行 <code>move-result</code> 还在，还可能读到上一次调用的残留值——' +
              '<b>不崩，但结果是错的</b>。',
            state: { '自检四问': '越界 / 孤儿 / 动过寄存器声明 / 删调用漏了配对', '目标': '改一行、验一行' }
          }
        ]
      },
      after: T.note('ok', '✅ 这一节最值钱的一句话',
        '<p style="margin-bottom:0"><b>改 Smali 的难点从来不是"改"，是"定位到该改的那一行，并且确认跳转方向"。</b><br>' +
        '而这套方法之所以成立，靠的是 Smali 的一个文本属性：<b>成员名字是字面量，可以直接搜。</b>' +
        '这也是为什么"反编译成 Smali"比"直接读字节码"更适合做改动——' +
        '<span class="hit">工具选得对不对，取决于你要做的是"读"还是"改"。</span></p>')
    },

    /* ============================================================ 27.14 */
    {
      h: '27.14', title: '工具链：解密、回编译、签名、对齐、安装——每一步失败会发生什么',
      html:
        '<p>改完一行，真正的麻烦才开始。下面把完整流程走一遍，' +
        '<b>重点看每一步失败时的现象</b>：因为在实战里，你排查问题靠的就是"这一步失败长什么样"。</p>' +
        T.tbl(['步骤', '命令（示意）', '它解决什么问题'],
          [
            ['① 解密', '<code>apktool d -f -o out_dir target.apk</code>',
              '把 APK 拆成可编辑的目录：<code>smali/</code>、<code>res/</code>、<code>AndroidManifest.xml</code>'],
            ['② 改代码', '（编辑器 / 脚本）', '改 <code>smali/**.smali</code>——本章前面讲的都在这一步'],
            ['③ 回编译', '<code>apktool b -o patched.apk out_dir</code>',
              '把目录重新组装成 APK（内部会调用 smali 汇编器和 aapt2）'],
            ['④ 对齐', '<code>zipalign -f -v 4 patched.apk aligned.apk</code>',
              '让 zip 内未压缩数据按 4 字节边界对齐（<b>必须在签名前做</b>）'],
            ['⑤ 签名', '<code>apksigner sign --ks my.keystore --out signed.apk aligned.apk</code>',
              '用<b>你自己的密钥</b>重新签名。这一步之后，签名摘要必然与原包不同'],
            ['⑥ 验证签名', '<code>apksigner verify --print-certs signed.apk</code>',
              '不做这一步就装，等于把问题留到下一步才暴露'],
            ['⑦ 安装', '<code>adb install -r signed.apk</code>',
              '覆盖安装原包<b>一定失败</b>（签名不一致）；先卸载再装'],
            ['⑧ 运行', '（看现象）', '闪退/黑屏/卡启动页 → 大概率是签名校验或完整性校验；' +
              '崩溃栈里有 <code>VerifyError</code> 一类 → 更可能是你自己改错了']
          ]) +
        T.note('key', '🔑 三件必须分清的事：jarsigner / apksigner / zipalign',
          '<p><b>jarsigner</b>（JDK 自带）只能做 <b>v1（JAR 签名）</b>。' +
          '<b>apksigner</b>（Android build-tools 里）支持 v1 / v2 / v3 / v4，' +
          '是现在的标准工具。</p>' +
          '<p><b>zipalign</b> 只做对齐，<b>不做签名</b>，而且它必须在签名<b>之前</b>——' +
          '因为签名（尤其 v2/v3）是对整个文件内容做摘要，签名后再对齐等于把签名弄废。</p>' +
          '<p style="margin-bottom:0"><span class="pill warn">待核实</span> ' +
          '<code>apksigner</code> 默认启用哪些签名方案取决于你的 build-tools 版本和 <code>minSdkVersion</code>；' +
          '也可以显式指定（如 <code>--v1-signing-enabled</code> / <code>--v2-signing-enabled</code>）。' +
          '<b>动手前先 <code>apksigner verify -v</code> 看一下实际用了哪几个方案</b>，别凭印象。</p>') +
        '<p>下面是一个可以逐步"执行"的终端。注意每一行输出后面的说明栏——' +
        '那里写的是"这一步失败会长什么样"。</p>',
      term: {
        title: '重打包完整流程（含每一步的失败形态）',
        lines: [
          { t: 'p', s: 'apktool d -f -o demo_out demo.apk',
            note: '<b>解密。</b>成功后你会看到 <code>I: Using Apktool …</code> 之类的日志，' +
              '以及一个和 APK 同名的目录。如果只得到一个 <code>apktool.yml</code> 和空的 smali 目录——' +
              '说明这个 APK 大概率被加固了，<b>你拿到的是壳的代码，不是业务代码</b>（第 19 章教你判断是哪类壳）。' },
          { t: 'o', s: 'I: Using Apktool 2.x on demo.apk\n' +
              'I: Loading resource table...\n' +
              'I: Decoding AndroidManifest.xml with resources...\n' +
              'I: Copying assets and libs...',
            note: '<b>正常输出的样子。</b>记住这个"正常"，因为失败时的日志和它差别很大。' },
          { t: 'o', s: 'demo_out/\n' +
              '├── AndroidManifest.xml\n' +
              '├── apktool.yml\n' +
              '├── smali/            ← 第 1 个 dex\n' +
              '├── smali_classes2/   ← 第 2 个 dex（多 dex 时才有）\n' +
              '├── res/  assets/  lib/',
            note: '<b>目录结构 = 你要找的战场。</b>改代码在 <code>smali*/</code>，改清单在 ' +
              '<code>AndroidManifest.xml</code>，改文案/图片在 <code>res/</code>。<br>' +
              '找不到目标类时，先确认它在哪个 <code>smali_classesN</code> 里（27.13 第 3 步）。' },
          { t: 'd', s: '// 你在 smali/com/demo/app/MainActivity.smali 里改了那一行',
            note: '<b>动手。</b>改完先自己过一遍"自检四问"（27.13 第 6 步）。' },
          { t: 'p', s: 'apktool b -o demo_patched.apk demo_out',
            note: '<b>回编译。</b>这是最容易失败的一步。' },
          { t: 'e', s: 'W: Could not decode file, skipping...\n' +
              'brut.androlib.AndrolibException: Could not smali file: com/demo/app/MainActivity.smali',
            note: '<b>失败形态 A：smali 语法错误。</b>报错里会带<b>文件名</b>，' +
              '但常常<b>不带行号</b>——所以你要回头逐行看你改过的地方。<br>' +
              '最常见的三类：多了/少了空格与逗号、指令名拼错、跳转标签不存在。<br>' +
              '<span class="hit">排查技巧：把改动撤销（或注释掉），确认真的是你改的那行引起的。</span>' },
          { t: 'e', s: 'Exception in thread "main" brut.androlib.AndrolibException:\n' +
              '  A resource failed to compile / aapt2 error',
            note: '<b>失败形态 B：资源编译失败。</b>注意：如果你<b>只改了 smali</b>，却报资源错误，' +
              '那说明问题不在你的改动，而在<b>工具链版本</b>（apktool / aapt2 / build-tools 不匹配）' +
              '或原包的资源本身不规范。<br>' +
              '<span class="pill warn">待核实</span> 具体报错文案随 apktool 版本变化很大。' +
              '通用对策：<b>升级/降级 apktool 和 build-tools 到匹配版本</b>，' +
              '系统 App 还要先 <code>apktool if framework-res.apk</code> 装框架资源。' },
          { t: 'p', s: 'zipalign -f -v 4 demo_patched.apk demo_aligned.apk',
            note: '<b>对齐。</b>必须在签名前。<code>-f</code> 覆盖输出文件，<code>-v</code> 打印验证信息，' +
              '<code>4</code> 是 4 字节对齐。<br>' +
              '<span class="pill warn">待核实</span> 新版本 Android 对共享库有更高的页对齐要求' +
              '（<code>zipalign</code> 的 <code>-p</code> / <code>-P</code> 一类的选项与之相关），' +
              '<b>以你手上的 build-tools 文档为准</b>。' },
          { t: 'o', s: 'Verification successful',
            note: '<b>对齐成功。</b>如果这里报错，通常说明输入 APK 已经损坏，或者你漏了上一步。' },
          { t: 'p', s: 'apksigner sign --ks my.keystore --ks-pass pass:123456 --out demo_signed.apk demo_aligned.apk',
            note: '<b>签名。</b>用你自己的密钥库。<br>' +
              '<b>记住这一行的后果：</b>从这一刻起，这个 APK 的签名摘要与原包<b>必然不同</b>——' +
              '不管你有没有改代码。这就是 27.16 的起点。' },
          { t: 'p', s: 'apksigner verify --print-certs demo_signed.apk',
            note: '<b>验证签名。</b>别跳过这一步。它会打印用了哪些签名方案和证书摘要。' },
          { t: 'o', s: 'Signer #1 certificate DN: CN=demo\n' +
              'Signer #1 certificate SHA-256 digest: 3a:1f:...\n' +
              'Verifies',
            note: '<b>看到 <code>Verifies</code> 才算签名这关过了。</b>' +
              '如果这里报 <code>DOES NOT VERIFY</code>，说明上一步的输入被改过（比如你又重新对齐了一次）。' },
          { t: 'p', s: 'adb install -r demo_signed.apk',
            note: '<b>覆盖安装。</b>设备上还装着原版 App 时，这一步注定失败。' },
          { t: 'e', s: 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package com.demo.app ' +
              'signatures do not match previously installed version; ignoring!]',
            note: '<b>这是最经典、也最容易被误判的一步失败。</b>' +
              '注意它说的是 <b>signatures do not match</b>——<b>是"签名和已装版本不一致"</b>，' +
              '不是"你的 APK 有问题"。<br>' +
              '<span class="hit">这不是错误，是 Android 的保护机制：同一个包名不允许用不同密钥覆盖安装。</span>' +
              '（如果原 App 是系统预装的，还要考虑能不能卸载。）' },
          { t: 'p', s: 'adb uninstall com.demo.app',
            note: '<b>先卸载。</b>代价是 App 数据全丢——如果你需要调查它的本地数据，' +
              '<b>卸载前先备份</b>（<code>adb backup</code> 或直接拷 <code>/data/data/包名</code>，需要 root）。' },
          { t: 'p', s: 'adb install demo_signed.apk',
            note: '<b>重新安装。</b>这次应该成功。' },
          { t: 'o', s: 'Success',
            note: '<b>装上了。</b>但"装上"不等于"能用"——下一步才是真正的考验。' },
          { t: 'e', s: '（点开 App）启动页一闪 → 立即退出。logcat 里没有任何 Java 异常。',
            note: '<b>这就是签名校验的典型现象。</b>注意"<b>没有 Java 异常</b>"这个细节：' +
              '很多校验故意不抛异常、不打印日志，只是安静地 <code>System.exit(0)</code> 或 ' +
              '<code>Process.killProcess</code>——让你无从下手。<br>' +
              '对照一下：如果是<b>你自己改错了</b>，通常能在 logcat 里看到具体的异常' +
              '（<code>VerifyError</code>、<code>NoSuchMethodError</code>、<code>ClassCastException</code> 之类）。' },
          { t: 'p', s: 'adb logcat -v time | grep -i "com.demo.app\\|AndroidRuntime"',
            note: '<b>看崩溃栈是第一件事。</b>有明确异常 → 先怀疑自己的改动；' +
              '什么都没有（只有一行"进程退出"）→ 先怀疑校验。' +
              '<b>这个分流判断，就是 27.18 决策演练①的核心。</b>' }
        ]
      },
      after: T.note('warn', '⚠️ 两个"不是你的错但会让你崩溃"的坑',
        '<p><b>① split APK（App Bundle 产物）。</b>从商店下载的现代 App 常常是"基础包 + 若干 split"，' +
        '<b>apktool 直接处理 split 会很难受</b>（要么装不上去，要么只有一个 split 的内容）。' +
        '需要先把 split 合并成一个可处理的 APK（社区有一些合并脚本，' +
        '<span class="pill warn">待核实</span> 工具名与可用性随时间变化，用前先验证）。</p>' +
        '<p style="margin-bottom:0"><b>② 资源混淆 / 强混淆的 App。</b>回编译时资源相关的报错往往指向' +
        '<code>res/</code> 和 <code>resources.arsc</code>，而这些问题和你改的那一行 smali 毫无关系。' +
        '<b>这时候要做的是"控制变量"：先不改任何东西，跑一遍 d → b → 签名 → 安装。' +
        '如果原样往返都失败，那这条路的第一步就不是改代码，而是修工具链。</b></p>')
    },

    /* ============================================================ 27.15 */
    {
      h: '27.15', title: '实战案例：一次完整的"签名校验对抗"实战记录',
      case: {
        source: 'kanxue',
        title: '[原创]《安卓逆向这档事》六、校验的N次方-签名校验对抗、PM代理、IO重定向',
        date: '2023-07-30',
        author: '正己',
        target: '《安卓逆向这档事》系列课程 Demo（<code>com.zj.wuaipojie</code>）；工具链为 MT管理器 / NP管理器 / 雷电模拟器 / jadx',
        background:
          '<p>这篇帖子是系列课程的第六课，主题正好落在本章最硬的那道门上：' +
          '<b>你改完代码重新签名之后，App 拿什么发现你改过、以及你怎么应对。</b></p>' +
          '<p>作者先从"什么是校验"讲起，把常见校验摊开成一张清单——' +
          '<b>签名校验（最常见）、dexcrc 校验、apk 完整性校验、路径文件校验</b>——' +
          '然后讲了 APK 签名的四种方案（v1 基于 JAR 签名、v2 在 Android 7.0 引入、v3 在 Android 9、v4 在 Android 11），' +
          '以及 v1 签名在 <code>META-INF/</code> 下的三个产物：' +
          '<code>MANIFEST.MF</code>（逐文件 SHA-1 摘要）、<code>ANDROID.SF</code>（对摘要文件的签名）、' +
          '<code>ANDROID.RSA</code>（公钥与算法信息）。</p>' +
          '<p>最有价值的一句判断在帖子里写得很直白：<b>如何判断有没有签名校验？' +
          '不做任何修改、直接签名安装，应用闪退则说明大概率有签名校验。</b>' +
          '<span class="hit">这正是本章 27.18 第一个决策演练的判据——先判断有没有门，再决定要不要动手。</span></p>',
        points: [
          '常见的校验类型：签名校验（最常见）、dexcrc 校验、apk 完整性校验、路径文件校验。',
          'APK 签名的四种方案：v1（JAR 签名，Android 7.0 前）、v2（Android 7.0 引入）、v3（Android 9）、v4（Android 11）。' +
            'v2 把 APK 当成一个整体 blob 签名——<b>对 ZIP 元数据的任何修改都会让签名失效</b>。',
          'v1 的三个产物：<code>MANIFEST.MF</code>（逐文件摘要）、<code>ANDROID.SF</code>（用私钥对摘要签名）、' +
            '<code>ANDROID.RSA</code>（公钥与算法）。帖子还提到一种流传的情况：某些场景下只做 v1 签名可以绕过部分签名校验。',
          '普通签名校验的形状：取 <code>PackageInfo</code> 的 <code>signatures</code> → Base64 → 算 MD5 → 与硬编码值比对。',
          '反面的现象学：签名校验导致的现象是<b>闪退 / 黑屏 / 卡启动页</b>；' +
            '更"狠"的会 <code>rm -rf /</code>（作者原话，指极端个例）；' +
            '作者还提到最麻烦的一种叫<b>三角校验</b>——<b>so 检测 dex、动态加载的 dex 检测 so、dex 检测动态加载的 dex</b>。',
          '五条对抗路线：核心破解插件不签名安装、一键过签名工具（MT / NP / ARMPro / CNFIX / Modex 等）、' +
            '手撕签名校验逻辑、IO 重定向（VA &amp; SVC：ptrace + seccomp）、以及"去作者家拿到 .jks 和密码"（这条是玩笑，但说明了密钥才是终极答案）。',
          'PM 代理的实现：拿到 <code>ActivityThread.currentActivityThread()</code>，' +
            '通过反射替换 <code>sPackageManager</code> 字段为动态代理，' +
            '再把 <code>ApplicationPackageManager</code> 里的 <code>mPM</code> 一起换掉，' +
            '让所有签名查询返回伪造结果。',
          'IO 重定向的实现：Hook <code>open</code> / <code>openat</code> / <code>fopen</code> / <code>syscall</code> / ' +
            '<code>dlopen</code> 系列，当路径是"原始 APK"时，改指向自己保存的一个副本' +
            '（帖子里用的是 App 私有目录下的 <code>base.apk</code> 副本）。',
          '其他同类校验：root 检测（查 <code>Build.TAGS</code> 含 <code>test-keys</code>、查 <code>su</code> 路径、' +
            '<code>Runtime.exec("which su")</code>）、模拟器检测（<code>Build.FINGERPRINT</code> / <code>MODEL</code> / ' +
            '<code>MANUFACTURER</code> / <code>HOST</code> 特征）、反调试、Frida 检测。'
        ],
        method: [
          '先把校验分类：作者把"什么算校验"从抽象概念落成一张清单（签名、dex crc、apk 完整性、路径文件），' +
            '这样后面的对抗才有对象。',
          '搞清楚签名机制本身：v1 的三个文件分别在做什么（摘要 / 签名 / 公钥），以及 v2 为什么"动一个字节就废"。' +
            '理解机制之后，"为什么重打包必然触发校验"就不再是经验之谈。',
          '给出最省力的判据：不做任何修改、直接重新签名安装，看会不会闪退。' +
            '这一步把"要不要投入时间对抗校验"变成一个几分钟就能得到答案的实验。',
          '按投入产出排列对抗路线：从"一键工具"到"手撕逻辑"再到"IO 重定向"，' +
            '并明确每条路线的适用场景与代价。',
          '把 IO 重定向作为通用解法：既然校验的本质是"读文件、算摘要、比对"，' +
            '那就让它的"读"发生在另一个文件上——<b>这是把对手的检查点变成可控输入</b>。',
          '用 Demo 做可复现验证：想验证自己的防护有没有用，就要有一个带校验的 Demo 反复试。'
        ],
        result:
          '<p>帖子给出了完整的对抗链路：<b>校验类型清单 → 签名机制 → 判据（重签安装看是否闪退）→ ' +
          '五条对抗路线 → PM 代理与 IO 重定向的完整代码实现 → 其他同类校验（root / 模拟器 / 反调试 / Frida）</b>。</p>' +
          '<p>其中 PM 代理与 IO 重定向都给了可直接编译运行的代码（替换 <code>sPackageManager</code> 与 ' +
          '<code>mPM</code> 的动态代理类、以及 <code>fake_open</code> 路径替换逻辑），' +
          '并配有"课后小作业"要求读者自己移植重定向代码。</p>',
        terms: ['签名校验', 'dexcrc 校验', 'APK 完整性校验', 'v1/v2/v3/v4 签名方案', 'META-INF', 'MANIFEST.MF',
          'ANDROID.SF', 'PackageInfo.signatures', '三角校验', 'PM 代理', 'IO 重定向', 'seccomp', 'ptrace',
          'dlopen', 'root 检测', '模拟器检测', '隐式签名校验'],
        limits:
          '<p>作者在"反思"一节里自己交代了几条局限，逐条照录：</p>' +
          '<p>① <b>"签名的博弈日新月异，善用工具，拥抱开源"</b>——帖子的方法不是终点；' +
          '② <b>通过系统自带 API 获取签名很容易被伪造</b>，作者建议试试通过 <b>SVC 的方式</b>去获取（并指向 MT 的开源实现）；' +
          '③ <b>存在"隐式签名校验"</b>：有些校验发现 APK 被改后<b>不闪退</b>，而是偷偷改变部分功能——' +
          '作者举的例子是某些多开定位软件会暗改 IP 与经纬度，让结果与真实情况产生偏差；' +
          '④ 帖子末尾的"答疑"章节标注为<b>待更新</b>；' +
          '⑤ 文中部分外链以站内 <code>elink</code> 形式给出，需要跳转或登录才能打开，' +
          '外部读者不一定能追到全部参考资料。</p>',
        analysis:
          '<p><b>这个案例的价值，不在"他绕过了什么"，而在它把本章的因果关系按顺序摊开了。</b></p>' +
          '<p><b>第一，它印证了 27.14 的那条铁律：重签名是不可避免的第一步。</b>' +
          '帖子花大篇幅先讲 v1 的三个文件、再讲 v2"动一个字节就作废"，这不是铺垫——' +
          '它是在解释<b>为什么你改完 smali 之后，签名摘要不可能和原来一样</b>。' +
          '<span class="hit">你没法"既改内容又保留签名"，这是密码学层面的不可能，不是工具能力问题。</span> ' +
          '所以问题从来不是"能不能不触发校验"，而是"校验在哪一层、你能不能改到它"。</p>' +
          '<p><b>第二，那条判据（原样重签、看是否闪退）值得单独抄下来。</b>' +
          '它把"要不要对抗校验"变成了一次成本几分钟的实验：' +
          '<b>不改任何代码，只重新签名安装</b>——如果闪退，说明门在，且门和你的改动无关；' +
          '如果不闪退，说明至少没有"一改就死"的硬校验，你可以放心改。' +
          '这个实验的设计思路，正是本章反复强调的<b>控制变量</b>：' +
          '先确认"失败是不是我造成的"，再去改代码。</p>' +
          '<p><b>第三，三角校验（so ↔ dex ↔ 动态加载的 dex 互相校验）解释了"改一处就露馅"。</b>' +
          '从防守方视角看，这是一个非常值得学的设计：<b>把校验点做成互相依赖的环，而不是重复同一种校验</b>。' +
          '重复三次"读签名比对"只会让你多花三分钟绕三次；而"so 查 dex、dex 查 so、动态 dex 查 so"会让任何单点修改都留下矛盾。' +
          '这跟第 19 章讲的"防二次打包要 Java 与 native 双份"是同一条原则的加强版。</p>' +
          '<p><b>第四，对本章读者最实用的一条是"先判断，后动手"。</b>' +
          '本章 27.12 的实验教你"改一行让行为恒成立"，但真实工程里更常见的情况是：' +
          '<b>你花了两小时改完、回编译、签名、安装，然后在启动页被拦下——两小时白费，只因为你没花五分钟先做那个判据实验。</b> ' +
          '案例里把判据放在很靠前的位置，这个顺序本身就是方法论。</p>' +
          '<p>最后用它反向校准本章的适用面：<b>这里讨论的对抗手段（PM 代理、IO 重定向）本身都是"运行时改写"</b>——' +
          '它们不修改 APK，而是在运行时把对手的检查点接管掉。' +
          '这也再次说明：<b>当静态改包撞上校验墙时，正确的迁移方向通常是"运行时"（Hook / 代理），' +
          '而不是"在 APK 里和校验逻辑硬刚"。</b></p>',
        link: 'https://bbs.kanxue.com/thread-278216-1.htm',
        linkNote: '看雪论坛《安卓逆向这档事》系列第六课（原帖正文可读，已实测）'
      }
    },

    /* ============================================================ 27.16 */
    {
      h: '27.16', title: '重打包的代价：为什么改完签名装上去，它拒绝运行',
      intuition: {
        tag: '直觉模型 · 你换了一把锁，房东手里有原钥匙的拓片',
        body:
          '<p>APK 签名同时干了两件事：<b>证明"这是我发的"</b>（身份），和<b>证明"内容没被改过"</b>（完整性）。' +
          '它靠的是"用我的私钥签，任何人都能用我的公钥验"。</p>' +
          '<p>现在你把门锁换了（改代码 + 重新签名）。<b>锁更新了、也更结实了，但房东手里存着原钥匙的拓片</b>——' +
          '他把拓片和现在的锁一比，立刻知道换过锁。</p>' +
          '<p>更麻烦的是：他可以<b>不吭声</b>。不报警、不赶你走，只是悄悄把你家的水电改了——' +
          '这就是 27.15 案例里说的"隐式签名校验"，也是它比闪退可怕得多的原因。</p>'
      },
      html:
        '<p>把"签名变了"这件事拆开看，你会发现它必然触发一串连锁反应：</p>' +
        T.grid(3, [
          '<div class="card"><div class="card-title">① 内容变了</div>' +
          '<p>你改了 smali，重新汇编 → dex 的字节变了。</p>' +
          '<p style="margin-bottom:0">如果你的改动还涉及资源（文案、图片），' +
          '<code>resources.arsc</code> 和 <code>res/</code> 也变了。</p></div>',
          '<div class="card"><div class="card-title">② 签名必然失效</div>' +
          '<p>v1 是逐文件摘要，你改的文件摘要对不上；' +
          '<b>v2/v3 是把整个 APK 当 blob 签名，动一个字节（包括 zip 元数据）就整体作废</b>。</p>' +
          '<p style="margin-bottom:0">所以"重新签名"不是可选项，是唯一出路。</p></div>',
          '<div class="card"><div class="card-title">③ 签名摘要变了</div>' +
          '<p>你用<b>自己的</b>密钥签，证书摘要必然和原包不同。</p>' +
          '<p style="margin-bottom:0">于是任何"比对签名摘要"的代码都会发现异常。' +
          '<span class="hit">这一条与你改得对不对无关——哪怕你只改一个空格。</span></p></div>'
        ]) +
        T.note('key', '🔑 一句可以当成公理的话',
          '<p style="margin-bottom:0"><b>"改 Smali 重打包"和"保留原签名"在密码学上不可兼得。</b><br>' +
          '所以真正的工程问题不是"怎么不被发现签名变了"，而是' +
          '<b>"对方的校验放在哪一层、我这一层能不能改到它"。</b></p>') +
        T.tbl(['校验放在哪一层', '它怎么做', '重打包会怎样', '你要绕开它的代价'],
          [
            ['<b>Java 层</b>',
              '取 <code>PackageInfo.signatures</code> → 摘要 → 与硬编码值比对',
              '<b>必被发现</b>（摘要肯定不同）',
              '低：改返回值 / Hook 签名查询 / 改硬编码的比对值'],
            ['<b>native 层</b>',
              '在 so 里直接 <code>open</code> 自己的 APK、读内容算摘要，或读 <code>/proc/self/maps</code> 找 base.apk',
              '<b>必被发现</b>',
              '高：Java 层 Hook 无效，要动 so（第 3 章）或做 IO 重定向'],
            ['<b>直接走系统调用</b>',
              '不经过 libc 的 <code>open</code>/<code>read</code>，自己发 SVC（案例里作者建议的方向）',
              '<b>必被发现</b>',
              '很高：常规的文件 Hook 拦不到，要靠更底层的手段'],
            ['<b>完整性校验</b>',
              'dex crc / apk 内容摘要 / so 摘要 / 资源摘要，与内置值比对',
              '内容变了就露馅',
              '高：要么找出所有比对点，要么让它读到"原版内容"'],
            ['<b>三角校验</b>',
              'so 查 dex、动态加载的 dex 查 so、dex 查动态加载的 dex，互相牵制',
              '任何一处改动都会与另外两处矛盾',
              '极高：单点突破不成立'],
            ['<b>隐式校验</b>',
              '发现被改后<b>不闪退</b>，只悄悄改变部分功能或数据',
              '"看起来成功了"',
              '<b>最危险</b>：你可能带着错误结论继续往下做几小时']
          ]) +
        T.card('为什么"改 Smali 重打包"在带加固的样本上常常走不通',
          '<p>这不是"技术不行"，而是<b>前提就不成立</b>。三个原因，任何一个都足以劝退：</p>' +
          '<ol>' +
          '<li><b>你改的那份 dex 根本不是你看到的逻辑。</b>抽取壳的方法体在静态文件里是空的，' +
          'apktool 反编译出来的 smali 可能是"空方法"或"壳的代码"。' +
          '<span class="hit">你连改什么都还没看到，谈何改对。</span>（第 2 章、第 19 章）</li>' +
          '<li><b>校验和业务逻辑都在壳里。</b>加固产品的默认项就包含防二次打包：Java 层 + native 层双份签名校验、' +
          'dex/so 完整性校验（第 19 章把它归为"防二次打包"这一类威胁模型）。' +
          '你在业务 dex 里改的每一行，都要先过它这一关。</li>' +
          '<li><b>壳自己就在用"抢先执行"这套机制。</b>壳的 Application / <code>attachBaseContext</code> ' +
          '比你的代码先跑（第 2 章动画里的第 3 步）。也就是说：<b>你改的东西，是在壳的监控之下开始运行的。</b></li>' +
          '</ol>' +
          '<p style="margin-bottom:0">所以"看到加固就别先想着改包"不是保守，是省钱：' +
          '同样的目标，<b>运行时 Hook（第 1 / 21 / 22 章）通常比静态改包更快、更稳、也更容易回滚。</b></p>') +
        T.tbl(['目标特征', '"改 Smali 重打包"合适吗', '更好的路线'],
          [
            ['无加固、无校验的小工具 / 老旧 App / 自家 Demo / CTF 题',
              '<b>合适</b>，而且往往是最快的一条路',
              'apktool + 重签，按 27.14 的流程走'],
            ['无加固但有 Java 层签名校验', '可以，但要先过校验这一关',
              '先做 27.15 案例里的判据实验 → 再决定是改校验还是做运行时绕过'],
            ['有 native 层校验 / 完整性校验', '成本迅速上升',
              '评估改走运行时（Hook / IO 重定向）或放弃静态修改'],
            ['带加固（尤其抽取壳 / VMP 壳）', '<b>基本不成立</b>',
              '先脱壳（第 2 / 10 / 12 章）看懂逻辑，或直接走运行时路线；' +
              '动手前先用第 19 章的方法判定壳的类型'],
            ['只想知道"它到底怎么判断的"', '可以利用：改包是验证假设的好手段',
              '在无校验的自建样本上验证结论，别拿线上产品当实验场']
          ]) +
        T.note('warn', '⚠️ 与第 19 章的接口',
          '<p style="margin-bottom:0">第 19 章把加固的威胁模型分成三类：防静态分析、防动态调试、<b>防二次打包</b>；' +
          '并指出"防二次打包"的技术落点是<b>签名校验与完整性校验</b>。<br>' +
          '本章补上的是<b>机制层的解释</b>：为什么重新签名这件事一定会被"防二次打包"捕捉到——' +
          '因为签名摘要的变化是<b>不可避免的副作用</b>，而不是你的操作失误。<br>' +
          '两条合起来就是完整的判断：<b>第 19 章告诉你"有没有这道门"，本章告诉你"这道门为什么必然关上"。</b></p>')
    },

    /* ============================================================ 27.17 */
    {
      h: '27.17', title: 'APK 后门植入的原理与防范：为什么"重打包"是灰产的核心动作',
      html:
        T.note('bad', '🛡️ 先把立场说清楚',
          '<p><b>本节讲原理，是为了让你能识别和防范，不是操作手册。</b></p>' +
          '<p>重打包植入后门是黑灰产的常规动作：拿一个正规 App 的 APK，塞进自己的代码，重新签名，' +
          '投放到第三方下载站或私聊发给你。用户装的是"那个熟悉的 App"，但里面已经多了一个不属于原作者的程序。</p>' +
          '<p style="margin-bottom:0">所以本节的组织方式是<b>防御视角</b>：' +
          '先看"植入会发生在哪些位置"（这样你才知道去查哪里），' +
          '再看"每个位置对应的拦截点"（这样你才知道自己的 App 该怎么加固）。' +
          '<b>不提供对他人 App 实施植入的具体步骤。</b></p>') +
        '<p>好消息是：植入的位置是<b>结构性的、有限的</b>。' +
        '因为一个 APK 能被"抢先执行"的入口就那么几个——' +
        '而且这些入口你其实很熟：<b>加固壳用的也是同一批入口。</b></p>' +
        T.tbl(['植入位置（原理）', '为什么这个位置有效', '防守方的拦截点'],
          [
            ['<b>Application / <code>attachBaseContext</code></b>',
              '它是 App 里<b>最早</b>能拿到执行权的 Java 位置，早于所有业务代码（壳也是靠它抢先的）',
              '在 <code>attachBaseContext</code> / <code>onCreate</code> 里做<b>启动期完整性校验</b>；' +
              '把校验结果作为后续解密/鉴权的输入'],
            ['<b>入口 Activity / launcher</b>',
              '改名或新增一个启动 Activity，就能让自己的界面或逻辑先跑',
              '校验 <code>AndroidManifest.xml</code> 里的组件清单与预期一致（组件白名单校验）'],
            ['<b>塞入 native so</b>',
              'so 在 <code>System.loadLibrary</code> 时被加载，' +
              '<code>JNI_OnLoad</code> 或 <code>init_array</code> 里可以做事，且<b>比 Java 层的检测更隐蔽</b>',
              '<b>校验 so 的内容摘要</b>，而不只是校验签名；' +
              '注意 <code>extractNativeLibs</code> 为 false 时 so 直接从 APK 映射，给了另一条防线'],
            ['<b>劫持 <code>dlsym</code> / 改 PLT-GOT / 改 <code>init_array</code></b>',
              '不新增文件，而是让<b>已有调用</b>指向自己的实现（第 3 章讲过动态链接的机制）',
              '校验关键导入函数的行为与返回值；在 native 侧做函数序言/内存校验（第 13 章的相关思路）'],
            ['<b>改 dex：插一行 <code>invoke-static</code></b>',
              '只要在任意 <code>&lt;clinit&gt;</code> 或启动路径上插一条调用，就能把控制流引到自己的类',
              '<b>dex 内容摘要校验</b>（注意：只看签名不够，因为攻击者会重签）；' +
              'dex 完整性校验要和"当前签名"绑定，防止换成"自己签的另一份"'],
            ['<b>resources / assets 里塞 payload</b>',
              'payload 不在代码里，躲开代码审计；运行时释放并<b>动态加载</b>（第 26 章讲过动态加载机制）',
              '校验 <code>assets/</code> 与 <code>res/</code> 清单；' +
              '限制运行时从可写目录动态加载代码；监控异常的动态加载行为'],
            ['<b>批量注入（产业链形态）</b>',
              '自动化改写 + 自动重签名 + 多渠道分发，一次处理成千上万个包',
              '<b>渠道校验</b>：把渠道信息与签名/摘要绑定，' +
              '让"换个渠道再签一次"这条路失效；服务端配合校验客户端身份']
          ]) +
        T.note('key', '🔑 三条防守原则（比逐个位置对抗更重要）',
          '<ol style="margin-bottom:0">' +
          '<li><b>校验要"多点 + 交叉 + 延迟"，不要重复同一种校验。</b>' +
          '重复三次读签名，只是让攻击者多花三分钟；而"启动时查签名、关键功能前查 dex 摘要、' +
          '登录后拿服务端下发的挑战值再查一次"会让单点修改处处矛盾——' +
          '这就是 27.15 案例里"三角校验"的思路。</li>' +
          '<li><b>让校验结果参与后续运算，而不是"校验失败就 return"。</b>' +
          '如果失败只是 <code>return false</code>，那改一个 <code>if</code> 就绕过了。' +
          '更好的做法是：<b>把校验摘要作为密钥派生的一环</b>——' +
          '校验不通过时，后面解出来的数据就是错的（对应第 31 章讲的密钥流派生思路）。</li>' +
          '<li><b>能放到服务端的，就别放在客户端。</b>' +
          '客户端的一切都可以被改写，只是成本问题；' +
          '<span class="hit">把"谁有权限"这种判断放在服务端，是最省事也最有效的一条——' +
          '它同时也是最容易被忽略的一条。</span></li>' +
          '</ol>') +
        T.card('两个可以直接用的检查清单',
          '<p><b>① 作为用户：拿到一个"第三方渠道下载的同名 App"，怎么判断它被动过？</b></p>' +
          '<ul>' +
          '<li>比对<b>签名证书摘要</b>（<code>apksigner verify --print-certs</code>）与官方渠道的是否一致</li>' +
          '<li>比对文件与大小（官方包的哈希值更可靠）；看是否多出可疑的 <code>lib/</code> 或 <code>assets/</code></li>' +
          '<li>看 <code>AndroidManifest.xml</code> 里有没有<b>多出来的 Activity / Service / 权限</b></li>' +
          '<li>看它请求的权限是否与功能相符（一个手电筒要通讯录权限就很可疑）</li>' +
          '<li><b>最省事的一条：从官方应用市场或官网下载。</b></li>' +
          '</ul>' +
          '<p><b>② 作为开发者：发布前怎么自检？</b></p>' +
          '<ul>' +
          '<li>写一个"重签名自检"脚本：把自己的包重新签名、安装，看 App 会不会拒绝运行</li>' +
          '<li>确认签名校验<b>不只在 Java 层</b>，且校验结果参与后续逻辑（不是简单 return）</li>' +
          '<li>确认 dex / so / 资源配置了内容摘要校验（不只是签名校验）</li>' +
          '<li>确认关键判断在服务端也有一份</li>' +
          '<li>密钥管理：<code>.jks</code> 与口令不进代码库、不进聊天记录（27.15 案例里那条"去作者家要 .jks"的玩笑，' +
          '说的正是这件事的本质）</li>' +
          '</ul>') +
        '<p>下面这个案例，会用<b>真实帖子里作者自述的四条路线及其优缺点</b>，' +
        '说明"重打包植入"这条路到底贵在哪——而它的每一个"缺点"，正好就是防守方的一个抓手。</p>',
      case: {
        source: 'kanxue',
        title: '[原创]《安卓逆向这档事》第十九课、表哥，你也不想你的Frida被检测吧!(下)',
        date: '2024-07-25',
        author: '正己',
        target: 'Frida 持久化 hook 的四种落地方式（免 root 重打包 / root 改 so / Magisk 模块 / 源码定制）；工具链含 objection patchapk、apktool、jarsigner、aapt、adb',
        background:
          '<p>这篇帖子的主线是 Frida 检测与对抗，但其中"<b>frida 持久化方案</b>"一节正好落在本章的主题上：' +
          '<b>把一段不属于原作者的代码塞进 App，让它每次启动都跑起来。</b></p>' +
          '<p>作者的分类非常清楚：<b>免 root 一条路、root 三条路</b>，并且对每一条都写明了优点和缺点。' +
          '<span class="hit">这一节对本章的价值恰恰在那几句"缺点"上——' +
          '它把"重打包植入"的真实成本用原作者的话写出来了。</span></p>' +
          '<p>注意：这里引用的是<b>持久化注入技术本身</b>，目的是说明"这条路贵在哪、防守方该堵在哪"。' +
          '作者的用途是让分析环境在每个样本上自动就位（教学与研究场景），' +
          '这与"给别人的 App 装后门分发"是两件事——但两者用的是同一批技术入口，' +
          '所以防守方必须理解它。</p>',
        points: [
          '<b>路线一（免 root，重打包）：</b>把 APK 解包，<b>通过修改 smali 代码或 patch so 文件的方式植入 frida-gadget</b>，' +
            '然后重新打包安装。<br>' +
            '作者原话的<b>优点</b>：免 ROOT、能过掉一部分检测机制。<br>' +
            '作者原话的<b>缺点</b>：<b>重打包可能会遇到解决不了的签名校验、hook 时机需要把握。</b>',
          '<b>路线一的具体工具：</b><code>objection patchapk -V &lt;gadget 版本&gt; -c config.txt -s demo.apk</code>，' +
            '并明确提醒<b>路径不要有中文</b>；它依赖 <code>aapt</code> / <code>adb</code> / <code>jarsigner</code> / ' +
            '<code>apktool</code> 这几个外部命令。<br>' +
            '作者还点出一个很真实的工程问题：patch 时会去下载对应版本的 gadget so，<b>网络慢到异常</b>，' +
            '建议手动下载后放到固定路径（如 <code>…/.objection/android/arm64-v8a/libfrida-gadget.so</code>）。',
          '<b>路线二（root，改 so）：</b>patch <code>/data/app/包名/lib/arm64(or arm)/</code> 目录下的 so 文件——' +
            '因为 APK 安装后 so 会被解压到该目录并在运行时加载，' +
            '<b>修改该目录下的文件不会触发签名校验</b>。<br>' +
            '作者原话的<b>优点</b>：绕过签名校验、root 检测和部分 ptrace 保护。<br>' +
            '作者原话的<b>缺点</b>：需要 root；<b>高版本系统下当 manifest 的 ' +
            '<code>android:extractNativeLibs</code> 为 false 时，lib 目录文件可能不会被加载，' +
            '而是直接映射 APK 中的 so</b>；<b>可能会有 so 完整性校验</b>。',
          '<b>路线三（root，Magisk 模块）：</b>基于 Magisk 模块注入 gadget。<br>' +
            '作者原话的<b>优点</b>：<b>无需重打包</b>、灵活性较强。<br>' +
            '作者原话的<b>缺点</b>：需要过 root 检测、Magisk 检测。',
          '<b>路线四（源码定制）：</b>改 AOSP 源代码，在 fork 子进程时注入 gadget。<br>' +
            '这条路的代价最高，但也最彻底——它不碰目标 App 的任何文件。',
          '一个横向对照：四种路线对应四种不同的"成本结构"——' +
            '<b>改包要付签名校验的代价，改 so 要付内容校验与系统行为的代价，' +
            'Magisk 要付环境检测的代价，改源码要付工程复杂度的代价。</b>没有免费的路线。'
        ],
        method: [
          '先分类：作者把持久化方案按"是否需要 root"分成两大类，再在 root 类里细分三条路线。' +
            '分类一做完，"我该选哪条"就变成了"我愿意付哪种代价"。',
          '对每条路线写出优点<b>和缺点</b>，而不是只写优点。这一点很关键：' +
            '它让读者能在动手之前就知道自己会在哪一步被拦住。',
          '把工程细节一起交代：工具依赖了哪几个外部命令、路径不能有中文、so 下载慢要手动准备——' +
            '<b>这些细节才是"能不能真的跑起来"的分水岭。</b>',
          '在 root 路线里指出一个具体的系统行为变化（<code>extractNativeLibs=false</code> ' +
            '导致 so 直接从 APK 映射），并由此推出"这条路在高版本上可能失效"。'
        ],
        result:
          '<p>帖子给出了 Frida 持久化 hook 的四条完整路线，并对每条都给出了优点与缺点，' +
          '其中免 root 路线（重打包植入）给出了完整的 <code>objection patchapk</code> 命令与依赖清单。</p>' +
          '<p>对本章而言，它的结论可以浓缩成一句：' +
          '<b>"重打包植入"这条路在技术上成立，但它的两个已知代价是"签名校验"和"hook 时机"</b>——' +
          '而这两条恰好是防守方最该加固的地方。</p>',
        terms: ['frida-gadget', 'objection patchapk', 'jarsigner', 'apktool', 'aapt',
          '签名校验', 'so 完整性校验', 'extractNativeLibs', 'JNI_OnLoad', 'init_array',
          'Magisk 模块', '持久化 hook', '重打包', 'patch so'],
        limits:
          '<p>作者自述与帖子本身可确认的边界，逐条照录：</p>' +
          '<p>① <b>路线一自己承认走不通的地方</b>：' +
          '"重打包可能会遇到<b>解决不了的签名校验</b>、hook 时机需要把握"——' +
          '这是原作者的原话，不是本章的评价。</p>' +
          '<p>② <b>路线二的两个前提都有时效性</b>：' +
          '依赖 <code>extractNativeLibs</code> 的具体取值，并且"可能会有 so 完整性校验"——' +
          '也就是说这条路在有内容校验的目标上会失效。</p>' +
          '<p>③ <b>路线三、四都要求先过环境检测</b>：' +
          'Magisk 方案要过 root/Magisk 检测，源码定制方案工程量大。</p>' +
          '<p>④ <b>帖子发布于系列课程的语境下</b>，命令与路径以当时的工具版本为准；' +
          'gadget 版本、objection 版本、目录结构都可能已经变化。</p>',
        analysis:
          '<p><b>把这张"优缺点表"倒过来读，就是一份防守检查清单。</b>这是本节最想教的一件事：' +
          '<span class="hit">攻击路线的成本结构，直接告诉你防御的着力点在哪。</span></p>' +
          '<p><b>① "签名校验"被列为路一的致命缺点</b> → 说明<b>签名校验是对付重打包植入的第一道、也是最便宜的一道门</b>。' +
          '这是本章 27.16 的核心结论，被一个真实案例从攻击者视角再次确认：' +
          '他们不是"顺手绕一下"，而是把它列为<b>可能解决不了</b>的困难。</p>' +
          '<p><b>② "so 完整性校验"被列为路二的缺点</b> → 说明<b>只做签名校验不够</b>，' +
          '还要做内容摘要校验。而且案例里还给出了一个更细的推论：' +
          '当 <code>extractNativeLibs=false</code> 时 so 直接从 APK 映射，' +
          '"改 lib 目录下的文件"这条路会自然失效——' +
          '<b>这是一个由系统行为带来的、几乎零成本的防御收益。</b>' +
          '把这类"顺手就能拿到的防线"用上，是加固设计里性价比最高的部分。</p>' +
          '<p><b>③ "hook 时机需要把握"</b> → 反过来提醒防守方：' +
          '<b>把校验放在更早的时机（Application / attachBaseContext），就能把对手的活动窗口压得更窄。</b> ' +
          '这与本章 27.17 表格里第一条完全对应：<b>谁先拿到执行权，谁就占据主动。</b>' +
          '这也正是加固壳自己要抢 <code>attachBaseContext</code> 的原因（第 2 章）。</p>' +
          '<p><b>④ 四条路线没有一条是"免费"的</b> → 这条观察对防御方是莫大的安慰，也是重要的判断依据：' +
          '你不需要做到"无法被攻破"（那不可能），你只需要<b>把对手的成本抬到他不愿意付的高度</b>。' +
          '当四条路线各自都有一道明确的门时，"重打包一个 App 塞东西进去"就从"十分钟的活"变成了"要先解决四类问题"。</p>' +
          '<p>最后回到本章的主线：<b>为什么读者要学 Smali 和重打包？</b>' +
          '很大一部分原因是——<b>只有亲手走通过一次这条路，你才知道自己的 App 该在哪里设卡。</b> ' +
          '没改过包的人，写出来的"安全校验"往往只是在 Java 层 <code>return false</code> 而已。</p>',
        link: 'https://bbs.kanxue.com/thread-282623.htm',
        linkNote: '看雪论坛《安卓逆向这档事》系列第十九课（原帖正文可读，已实测）'
      }
    },

    /* ============================================================ 27.18 */
    {
      h: '27.18', title: '决策演练①：改完重打包，启动页一闪就退',
      html: '<p>先从最常见的那个现场开始。<b>现象里已经藏着答案，就看你有没有先做最便宜的那一步。</b></p>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一',
            scenario: '<b>情境：</b>你按 27.14 的流程走完了：改了一行 Smali（把 <code>move-result v0</code> 换成 ' +
              '<code>const/4 v0, 0x1</code>）、<code>apktool b</code> 回编译、<code>apksigner</code> 重新签名、' +
              '卸载原包、<code>adb install</code> 成功。<br>' +
              '点开 App：<b>启动页停大约一秒，进程退出</b>。logcat 里<b>没有 Java 异常栈</b>，' +
              '只有一行进程结束的记录。',
            q: '你的第一步应该是什么？',
            choices: [
              { t: '先怀疑自己改错了：把改动撤销再试', next: 'n1' },
              { t: '先做"原样往返"实验：不改任何代码，走一遍 解密→回编译→签名→安装', next: 'n2' },
              { t: '先换一个 apktool 版本重来', next: 'n3' },
              { t: '直接去搜签名校验的代码，准备绕过它', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'bad',
            verdictTitle: '方向不算错，但顺序错了——你跳过了最便宜的一步',
            result: '<p>撤销改动确实能验证"是不是我改的"，但它<b>要重走一整轮流程</b>' +
              '（回编译 + 签名 + 卸载 + 安装），而且验证完之后，如果是校验，你还得再来一轮。</p>' +
              '<p><b>真正的认知根源：你把"我改过东西"直接等同于"我改错了"。</b>' +
              '但这次改动只是把一行 <code>move-result</code> 换成常量——它<b>不可能</b>引起"没有异常的静默退出"：' +
              '真正改错的表现通常是 <code>VerifyError</code> / <code>NoSuchMethodError</code> / ' +
              '<code>ClassCastException</code> 这类<b>有栈的崩溃</b>。</p>' +
              '<p><span class="hit">"没有异常栈的退出"是一个强信号，它几乎在指着校验说：' +
              '"这是我干的，而且我故意不留痕迹。"</span></p>'
          },
          n2: {
            label: '选B',
            scenario: '<b>你做了原样往返：</b>拿到原始 APK，<b>一行代码都不改</b>，' +
              '只走 <code>apktool d</code> → <code>apktool b</code> → 重新签名 → 卸载 → 安装。<br>' +
              '结果：<b>一样，启动页一闪就退，同样没有异常栈。</b>',
            q: '这个结果告诉你什么？',
            choices: [
              { t: '问题在校验层：重新签名这件事本身就被检测到了，和我的改动无关', next: 'n5' },
              { t: 'apktool 回编译把包搞坏了', next: 'n6' },
              { t: '换台设备/换个系统版本就好了', next: 'n7' }
            ]
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '在错误的方向上做实验',
            result: '<p>换 apktool 版本能解决的问题是<b>"回编译失败"</b>，而不是"回编译成功但运行被拒"。</p>' +
              '<p>你的现象是：<b>包编出来了、签名验过了、装上了、能启动到启动页</b>——' +
              '这说明工具链本身是好的。问题出在<b>运行时的某个检查</b>上。</p>' +
              '<p><b>认知根源：把"工具链问题"和"运行时问题"混在一起。</b>' +
              '这两类问题的现象完全不同：<br>' +
              '• 工具链问题 → 编译期/安装期报错<br>' +
              '• 运行时校验 → 装得上、跑得起来、然后被拒绝</p>' +
              '<p><span class="hit">先按"问题发生在哪个阶段"分类，能省掉一半弯路。</span></p>'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '结论可能是对的，但你还没有证据',
            result: '<p>"去准备绕过签名校验"这个方向很可能最终是对的，但<b>你现在还没有任何证据证明它是校验</b>。</p>' +
              '<p>更现实的场景是：你花了几个小时读校验逻辑、写绕过，最后发现真正的原因是' +
              '<b>回编译时某个资源没被正确处理</b>，或者 <b>split APK 只处理了一半</b>。' +
              '那时候你的心情会非常糟。</p>' +
              '<p><b>认知根源：把"最可能的假设"当成了"已确认的事实"。</b>' +
              '工程上更稳的顺序是：<b>先用一个几分钟的实验把可能性砍掉一半，再投入几小时去解决其中一个。</b></p>'
          },
          n5: {
            label: '选B→是校验', terminal: true, verdict: 'good',
            verdictTitle: '正确：你把问题范围一次砍掉了一半',
            result: '<p><b>这就是"控制变量"的威力。</b>原样往返（不改任何代码）都退，说明：</p>' +
              '<ul>' +
              '<li>你的那一行改动<b>不是原因</b>——可以放心地把它改回去，它没问题；</li>' +
              '<li>原因在"<b>重新签名</b>"这个动作带来的副作用上——也就是签名摘要变了；</li>' +
              '<li>接下来要查的就是 27.16 那张表：校验在哪一层（Java / native / 直接系统调用）、' +
              '有没有完整性校验、有没有三角校验。</li>' +
              '</ul>' +
              '<p><span class="hit">这一步在真实工程里的价值极高：它把一个"不知道哪出问题"的模糊状态，' +
              '变成了一个"我知道门在哪，只是还没打开"的确定状态。</span></p>' +
              '<p><b>顺带记住这个判据的原始出处：</b>27.15 案例里作者写的——' +
              '"不做任何修改，直接签名安装，应用闪退则说明大概率有签名校验"。' +
              '这条经验之所以值钱，正因为它是一次<b>成本极低的二分实验</b>。</p>' +
              '<p><b>接下来怎么办：</b>才好判断要不要继续。' +
              '如果目标是自己或已获授权的样本，就按 27.15 案例里的路线走' +
              '（改校验逻辑 / 运行时 IO 重定向 / 不签名安装等）；' +
              '如果目标是加固产品，先回想 27.16 的结论：<b>静态改包这条路可能一开始就不该走。</b></p>',
            after: '<p style="margin-bottom:0">下一步动作建议：先 <code>adb logcat</code> 完整抓一遍启动日志，' +
              '再对照 27.16 的表格判断校验层次。<b>先分层，再选工具。</b></p>'
          },
          n6: {
            label: '选B→工具坏了', terminal: true, verdict: 'bad',
            verdictTitle: '判断错了：工具坏了不会让你"启动一秒再退出"',
            result: '<p>如果 apktool 回编译真的把包搞坏了，现象会是：<b>装不上</b>' +
              '（<code>INSTALL_PARSE_FAILED_...</code> / <code>INSTALL_FAILED_INVALID_APK</code>），' +
              '或者<b>装上但立刻崩在类加载阶段</b>（有明确的 <code>ClassNotFoundException</code> 栈）。</p>' +
              '<p>而现在它能启动到启动页——<b>说明包的结构、签名、dex 都是完好的，App 正常跑起来了</b>，' +
              '是跑起来之后<b>主动</b>退出的。</p>' +
              '<p><b>"启动到某个界面之后才退出"和"根本没启动起来"，是两个完全不同的问题域。</b>' +
              '前者说明代码在跑，后者说明包/环境有问题。<span class="hit">看现象先看"它跑到了哪一步"。</span></p>'
          },
          n7: {
            label: '选C→设备问题', terminal: true, verdict: 'bad',
            verdictTitle: '把确定性的问题当成了环境问题',
            result: '<p>"换台设备就好了"这类结论，只有当现象是<b>偶发</b>或<b>与设备特征强相关</b>时才成立。' +
              '而你的现象是<b>100% 稳定复现</b>的启动即退。</p>' +
              '<p>稳定复现说明触发条件是确定的——最可能的就是"签名变了"这件事。</p>' +
              '<p><b>认知根源：用"换环境"来替代"定位原因"。</b>' +
              '环境问题该怀疑的时候是：只有某台机器崩、或者模拟器上不崩真机上崩、' +
              '或者和系统版本强相关。<b>在这些特征出现之前，先怀疑逻辑。</b></p>'
          }
        }
      }
    },

    /* ============================================================ 27.19 */
    {
      h: '27.19', title: '决策演练②：apktool 回编译报错，怎么定位',
      html: '<p>这一类问题的特点是：<b>报错信息有用，但不够用。</b>学会在信息不足的情况下做二分，是省时间的关键。</p>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境二',
            scenario: '<b>情境：</b>你只改了一个文件里的一行（加了一条 <code>const/4</code>），' +
              '执行 <code>apktool b -o patched.apk out_dir</code>，报错：<br>' +
              '<code>brut.androlib.AndrolibException: Could not smali file: ' +
              'com/demo/app/MainActivity.smali</code><br>' +
              '报错里<b>没有行号</b>，只有一个文件名。这个文件有两千多行。',
            q: '你怎么定位？',
            choices: [
              { t: '先二分：把改动撤销（或注释掉），重新编译一次，确认是不是我改的那一行引起的', next: 'n1' },
              { t: '换一个新版本的 apktool 再说', next: 'n2' },
              { t: '打开这个文件，从第 1 行开始逐行找语法错误', next: 'n3' },
              { t: '怀疑是资源问题，去检查 res/ 目录', next: 'n4' }
            ]
          },
          n1: {
            label: '选A',
            scenario: '<b>你把改动撤销，重新 <code>apktool b</code>——这次编译通过了。</b><br>' +
              '结论很清楚：问题就出在你改的那一行上。',
            q: '接下来你会怎么做？',
            choices: [
              { t: '把我的改动和原始文件做逐字对照（diff），检查空格、逗号、分号、跳转标签、寄存器编号', next: 'n5' },
              { t: '把那一段整个删掉，先让它能编过', next: 'n6' },
              { t: '凭记忆把这个方法重写一遍', next: 'n7' }
            ]
          },
          n2: {
            label: '选B', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了一半：工具版本问题不会只报一个文件',
            result: '<p>"换版本"对的问题类型是：<b>整包资源编译失败</b>、<b>所有 smali 都报错</b>、' +
              '<b>框架资源缺失</b>。这类问题的现象是"大面积失败"。</p>' +
              '<p>而你的报错<b>精确指向一个文件</b>，而且你恰好改过那个文件——' +
              '这个相关性太强了，不该跳过它去怀疑工具。</p>' +
              '<p><b>认知根源：用"换工具"回避"定位问题"。</b>' +
              '工具版本确实要匹配（27.14 里讲过），但那只在"原样往返都失败"的时候才是第一嫌疑。' +
              '<span class="hit">判断依据很简单：<b>失败是全局的还是局部的？</b>局部失败先怀疑自己，全局失败先怀疑环境。</span></p>'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '方法没错，但代价太高——两千行里找一行',
            result: '<p>逐行读一定能找到，但它把"O(1) 的二分"换成了"O(n) 的扫描"，' +
              '而且两千行里你很容易看花眼、甚至把没问题的行改坏。</p>' +
              '<p><b>更好的顺序永远是：先缩小范围，再仔细看。</b>' +
              '你已经知道"我改了哪一行"，那就从这里开始：<b>把改动还原 → 确认编译通过 → 再把改动加回去 → 确认失败</b>。' +
              '两步就能把范围从两千行缩到一行。</p>' +
              '<p><span class="hit">这类问题在工程上叫"二分定位"。它不是聪明，是纪律：' +
              '先用最少的信息把范围砍一半，再投入注意力。</span></p>'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '看错了报错的对象',
            result: '<p>报错明确写的是 <code>Could not smali file</code>——' +
              '<b>"smali" 这个词告诉你失败发生在 smali 汇编阶段</b>，对象是那个 <code>.smali</code> 文件。</p>' +
              '<p>资源编译失败是另一类报错（会出现 <code>aapt2</code> / resource / <code>resources.arsc</code> 一类关键词）。' +
              '两类问题的修复手段完全不重叠。</p>' +
              '<p><b>认知根源：没有先把报错"读到底"。</b>' +
              '工具报错往往已经给了两个关键信息：<b>失败发生在哪个阶段</b>（看关键词）、' +
              '<b>失败对象是哪个文件</b>（看路径）。先把这两样读出来再动手。' +
              '<span class="pill warn">待核实</span> 不同 apktool 版本的报错文案差异很大，' +
              '但"出现 smali 相关关键词 = 汇编阶段失败"这个判断是通用的。</p>'
          },
          n5: {
            label: '选A→diff', terminal: true, verdict: 'good',
            verdictTitle: '正确：把范围缩到一行，再逐字检查',
            result: '<p><b>这是最高效的路径。</b>你已经把范围从"两千行"缩到"一行"，' +
              '接下来只需要对着原始文件做一次 diff，检查这几类最常见的问题：</p>' +
              '<ul>' +
              '<li><b>分隔符</b>：Smali 的逗号、空格、冒号都很严格。' +
              '<code>const/4 v0, 0x1</code> 少了逗号或空格就是语法错误。</li>' +
              '<li><b>指令名</b>：<code>const/4</code> 不是 <code>const4</code>，<code>move-result</code> 不是 <code>moveresult</code>。</li>' +
              '<li><b>标签必须存在</b>：你写的每个 <code>:label</code> 都必须在同一个方法里有定义（27.12 实验里演示过）。</li>' +
              '<li><b>寄存器越界</b>：用到的 <code>vN</code> 不能超过方法声明的槽位数。</li>' +
              '<li><b>注释符</b>：Smali 用 <code>#</code>，不是 <code>//</code> 也不是 <code>;</code>。</li>' +
              '</ul>' +
              '<p><span class="hit">还有一个容易被忽略的：如果你改了 <code>.registers</code> 或 <code>.locals</code>，' +
              '整个方法体里的寄存器引用都要重新对账（27.5 最后一步讲的）。</span></p>' +
              '<p><b>最后一条纪律：一次只改一处，改完立刻回编译。</b>' +
              '攒了五处改动一起编，报错之后你就要重新做一次二分。</p>'
          },
          n6: {
            label: '选B→整段删掉', terminal: true, verdict: 'bad',
            verdictTitle: '能让它编过，但你已经把要改的东西删掉了',
            result: '<p>删掉那一段当然能编过——<b>但你做这件事的目的是"改变行为"，' +
              '把改动删掉等于回到了原点，绕了一圈什么都没得到。</b></p>' +
              '<p>更糟的是：如果你删的是原有代码（不是你的改动），' +
              '可能引入新的功能缺失，而这类问题<b>不会在编译期暴露</b>，会留到运行时变成"点了没反应"。</p>' +
              '<p><b>认知根源：把"能编译"当成了目标。</b>' +
              '能编译只是必要条件，不是目的。<span class="hit">正确的目标是"目标行为改变且其余不变"，' +
              '所以定位问题时要保留改动、缩小范围，而不是删掉它。</span></p>'
          },
          n7: {
            label: '选C→凭记忆重写', terminal: true, verdict: 'bad',
            verdictTitle: '最危险的一种做法：用"重写"掩盖"没定位"',
            result: '<p>凭记忆重写一个方法，等于<b>同时引入了 N 处新改动</b>，' +
              '其中任何一处都可能带来新问题，而你<b>已经失去了"原始文件"这个参照物</b>——' +
              '再出错时就没有 diff 可做了。</p>' +
              '<p><b>认知根源：用"更大动作"替代"更小定位"。</b>' +
              '出问题时人的本能是"推倒重来"，但工程上正确的反射是<b>把范围缩小到最小、保留参照物、做可控实验</b>。</p>' +
              '<p><span class="hit">一个永久有效的习惯：动手前先备份原始目录（或者 <code>git init</code> 一下），' +
              '这样任何时候你都能回答"相对于原始文件，我到底改了哪几处"。</span></p>'
          }
        }
      }
    },

    /* ============================================================ 27.20 */
    {
      h: '27.20', title: '决策演练③：目标带加固，重打包这条路还要不要走',
      html: '<p>这一题考的不是技术，是<b>路线选择</b>——也是本章最贵的一个判断。</p>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境三',
            scenario: '<b>情境：</b>团队要搞清某个 App 的一段业务逻辑（"某个入口在什么条件下能看到内容"），' +
              '并且希望"能改一行让它走另一条分支"作为验证。这个 App <b>带加固</b>。' +
              '有人提议："直接 apktool 解开改 smali 重打包，最快。"',
            q: '你怎么办？',
            choices: [
              { t: '先按第 19 章的方法判定壳的类型与防护层次，再决定走哪条路线', next: 'n1' },
              { t: '先 apktool 解开看看，能反编译出代码就改', next: 'n2' },
              { t: '带加固的没法静态改，直接告诉团队做不到', next: 'n3' },
              { t: '先花几天写一个绕过 native 签名校验的 so patch 工具', next: 'n4' }
            ]
          },
          n1: {
            label: '选A',
            scenario: '<b>判定结果：</b>抽取壳（jadx 能看到类名方法名，但方法体是空的或不完整）' +
              '+ Java 与 native 双份签名校验 + 有反调试。<br>' +
              '也就是说：<b>你手上这份 dex 根本不是运行时真正执行的那份代码。</b>',
            q: '你的下一步是什么？',
            choices: [
              { t: '把静态改包降级为辅助手段：先脱壳只为"读懂逻辑"，改动与验证走运行时路线（Hook / IO 重定向）', next: 'n5' },
              { t: '硬刚 native 签名校验：patch so 把它绕过去，然后继续改 smali 重打包', next: 'n6' },
              { t: '还是重打包，顺手把 Java 层的校验代码也改掉', next: 'n7' }
            ]
          },
          n2: {
            label: '选B', terminal: true, verdict: 'bad',
            verdictTitle: '最贵的错法：带着不成立的前提投入工作',
            result: '<p>带加固的 App，<code>apktool d</code> 有两种结局，两种都说明"改 smali"这条路不成立：</p>' +
              '<ul>' +
              '<li><b>只能看到壳的代码</b>（一代壳）→ 你连业务逻辑在哪里都不知道，改什么？</li>' +
              '<li><b>能看到类名方法名，但方法体是空的</b>（抽取壳）→ 你看到的是"骨架"，' +
              '改它不会影响运行时真正执行的代码（真指令是运行时回填的）。</li>' +
              '</ul>' +
              '<p>而且就算你改成功了，还有 native 层的签名校验在等着——' +
              '<b>你会连续在两道必然关上的门上撞两次。</b></p>' +
              '<p><b>认知根源：把"能反编译"当成了"能改"。</b>' +
              '这两个是完全不同的门槛：能反编译只说明结构可读，' +
              '能改还要求 <b>① 你改的是运行时真正执行的代码，② 没有完整性校验把这处改动当作异常</b>。' +
              '<span class="hit">第 19 章那套"半小时判定壳类型"的流程，存在的意义就是让你在这两种结局发生之前就知道答案。</span></p>'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '方向对，但结论下得太早：你要的是"读懂 + 验证"，不是"改包"',
            result: '<p>你正确地识别出"静态改包不成立"，但把结论扩大成了"任务做不到"——<b>任务其实是能做到的。</b></p>' +
              '<p>团队的真实需求是两件事：<br>' +
              '<b>① 读懂那段逻辑</b> → 脱壳之后就能读（第 2 / 10 / 12 章的脱壳路线）；<br>' +
              '<b>② 验证"改一行会走另一条分支"</b> → 这件事在运行时做更自然：' +
              'Hook 那个判断方法，返回你想要的值，看界面怎么变（第 1 / 21 / 22 章）。' +
              '你甚至不需要改任何文件。</p>' +
              '<p><b>认知根源：把"某一种技术路线不成立"等同于"目标不可达"。</b>' +
              '<span class="hit">工程判断要做两件事：判断这条路的可行性，以及找出其他路的可行性。' +
              '只做前一半，就会从"盲目乐观"直接跳到"过早放弃"。</span></p>'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '在确认"值不值得"之前，先付了最高的成本',
            result: '<p>写一个绕过 native 校验的工具，是这张决策图里<b>成本最高的一步</b>。' +
              '而你还没有确认：<br>' +
              '· 校验是在 native 层吗？还是 Java 层就够了？<br>' +
              '· 是签名校验还是内容校验？是单点还是三角校验？<br>' +
              '· 就算绕过了校验，<b>你改的那份 dex 是运行时执行的那份吗？</b>（抽取壳下不是）</p>' +
              '<p><b>认知根源：把"最难的那一步"当成了"最该先做的那一步"。</b>' +
              '正确的顺序恰恰相反：<b>先把最便宜的信息收集完，再决定要不要付最贵的成本。</b>' +
              '<span class="hit">这条原则在本课程里反复出现（第 2 章先判断壳类型、第 19 章先判定加固），' +
              '因为它能省下的不是几分钟，是几天。</span></p>'
          },
          n5: {
            label: '选A→分层处理', terminal: true, verdict: 'good',
            verdictTitle: '正确：把手段按"成本"和"是否成立"分层',
            result: '<p><b>这是本章最想让你带走的一个判断。</b>具体怎么分层：</p>' +
              '<ul>' +
              '<li><b>读懂逻辑</b> → 需要真代码。走脱壳（第 2 / 10 / 12 章的路线），' +
              '或者退一步：用运行时 trace / 抓包观察行为，也能回答很多问题。</li>' +
              '<li><b>验证改动</b> → 不需要脱壳，也不需要重打包。' +
              'Hook 那个判断方法（或它的上游），直接返回不同值，观察界面/行为变化。' +
              '这就是"改一行"的等价操作，而且<b>可随时回滚、不影响其他逻辑</b>。</li>' +
              '<li><b>静态改包（Smali 重打包）</b> → 只在<b>"无加固 + 无完整性校验"</b>的目标上作为主路线。' +
              '本章讲它，是为了让你理解这条路的原理与边界，' +
              '也是为了让你在遇到<b>该用它</b>的目标时（自家 Demo、CTF、老旧小工具）能一次做对。</li>' +
              '</ul>' +
              '<p><b>分层的好处是可加性：</b>先用便宜的手段拿到 80% 的答案，' +
              '不够再上贵的手段。<span class="hit">反过来做（先付最贵的成本）就会像选 D 那样，' +
              '在还不知道值不值得的时候就投入了几天的功夫。</span></p>' +
              '<p><b>最后一句提醒：</b>这一整套判断只适用于<b>自有或已获授权</b>的目标。' +
              '对未授权的线上产品做这些操作，不在本课程讨论范围内。</p>'
          },
          n6: {
            label: '选B→硬刚 native 校验', terminal: true, verdict: 'bad',
            verdictTitle: '解决了第二道门，却漏了第一道',
            result: '<p>patch so 绕过 native 校验，本身是一套需要第 3 章功底的硬功夫，' +
              '而且它解决的是<b>第二道门</b>。</p>' +
              '<p>第一道门是：<b>你手上这份 dex 不是运行时真正执行的那份代码</b>（抽取壳）。' +
              '方法体在静态文件里是空的，运行时才回填——' +
              '<b>你改的那一行，运行时可能根本不执行。</b></p>' +
              '<p>也就是说：你花了大力气绕过校验，装上去之后可能发现"改了没效果"，' +
              '然后才回过头来处理抽取壳。而处理抽取壳（脱壳）本身又是一条完整的路线。</p>' +
              '<p><b>认知根源：按"难度"排序而不是按"依赖关系"排序。</b>' +
              '<span class="hit">正确的顺序是按依赖排：先确认"我改的代码会不会被执行"，再解决"执行了会不会被发现"。</span></p>'
          },
          n7: {
            label: '选C→顺手改 Java 校验', terminal: true, verdict: 'bad',
            verdictTitle: '改掉了看得见的那一层，留下看不见的那一层',
            result: '<p>"顺手把 Java 层校验改掉"听起来很划算，问题有二：</p>' +
              '<p><b>① 双份校验的意义就在于"改一份没用"。</b>' +
              '如果 native 层也在校验，你改掉 Java 那份，native 那份照样拦你。' +
              '这正是 27.17 里"三角校验"要防的东西——' +
              '<b>防守方最怕的是"只做一份校验"，因为那一份一定被改掉。</b></p>' +
              '<p><b>② 你改的这份 dex 可能不是运行时被执行的那份</b>（同上，抽取壳）。</p>' +
              '<p><b>认知根源：把"看得见的那部分"当成了"全部"。</b>' +
              'Java 层易读易改，所以人天然会先去改它；' +
              '而真正难对付的通常在 native 层和运行时。<span class="hit">' +
              '第 19 章那张"Java 层 / Native 层防护对照表"就是为纠正这种直觉偏差而存在的。</span></p>'
          }
        }
      }
    },

    /* ============================================================ 27.21 */
    {
      h: '27.21', title: '收口：拿到一个 APK，我该怎么决定能不能改、怎么改',
      html:
        '<p>把整章压成一张决策路径。<b>顺序很重要</b>——这六个问题里，前三个是"要不要动手"，' +
        '后三个是"怎么动手"。<span class="hit">真实工作里最常见的浪费，是在第 1、2 问还没回答的时候就开始动手改代码。</span></p>',
      stage: {
        title: '拿到一个 APK 的六问决策路径',
        speed: 1900,
        render:
          '<div class="flow-col" style="gap:8px">' +
            '<div class="flow-row"><span class="pill mono">Q1</span>' +
              '<span class="blk" id="qq1">它是加固 / 抽取壳吗？</span></div>' +
            '<div class="flow-row"><span class="pill mono">Q2</span>' +
              '<span class="blk" id="qq2">有没有签名校验 / 完整性校验？</span></div>' +
            '<div class="flow-row"><span class="pill mono">Q3</span>' +
              '<span class="blk" id="qq3">关键逻辑在 Java 层还是 native 层？</span></div>' +
            '<div class="flow-row"><span class="pill mono">Q4</span>' +
              '<span class="blk" id="qq4">我要改的是哪一层的东西？</span></div>' +
            '<div class="flow-row"><span class="pill mono">Q5</span>' +
              '<span class="blk" id="qq5">工具链能不能原样往返？</span></div>' +
            '<div class="flow-row"><span class="pill mono">Q6</span>' +
              '<span class="blk" id="qq6">改完之后怎么确认"真的生效了"？</span></div>' +
            '<div class="card" style="margin-top:8px"><div class="card-title">当前结论</div>' +
              '<div class="mono" id="qVerdict">（还没开始）</div>' +
              '<div style="margin-top:8px"><span class="pill" id="qNote">点"单步"逐个回答</span></div>' +
            '</div>' +
          '</div>',
        reset: () => {
          ['qq1','qq2','qq3','qq4','qq5','qq6'].forEach(i => S(i, ''));
          CLS('qNote', 'pill'); SET('qNote', '点"单步"逐个回答');
          SET('qVerdict', '（还没开始）');
        },
        steps: [
          { run: () => { S('qq1', 'active'); SET('qVerdict', 'Q1：先用最便宜的方式判定壳的类型'); },
            note: '<b>Q1：它是加固 / 抽取壳吗？</b>这一步零成本，几十分钟就能有答案，' +
              '而它的结果直接决定后面所有步骤有没有意义。<br>' +
              '做法：jadx 直接打开 APK——只能看到壳的代码 → 一代壳；' +
              '能看到完整类名方法名但方法体是空的 → 抽取壳（完整方法见第 19 章）。<br>' +
              '<span class="hit">如果是抽取壳，你手上的 dex 不是运行时执行的那份，"改 smali"从前提上就不成立。</span>' },
          { run: () => { S('qq1', 'done'); S('qq2', 'active'); SET('qVerdict', 'Q2：原样重签安装，看会不会被拒'); },
            note: '<b>Q2：有没有签名校验 / 完整性校验？</b>做那个最便宜的判据实验：' +
              '<b>不改任何代码，只重新签名安装</b>（27.15 案例里的原话）。<br>' +
              '退 → 有硬校验（先解决它，或者改走运行时路线）；' +
              '不退 → 至少没有"一改就死"的门，可以放心往下走。<br>' +
              '<span class="hit">这一步能省掉整轮白工，是整张图里性价比最高的一个动作。</span>' },
          { run: () => { S('qq2', 'done'); S('qq3', 'active'); SET('qVerdict', 'Q3：Smali 只管 Java 层，管不到 so'); },
            note: '<b>Q3：关键逻辑在 Java 层还是 native 层？</b>' +
              '经过混淆的 App 往往把敏感逻辑下沉到 so（第 3 / 20 章）。<br>' +
              '如果目标逻辑在 so 里，<b>改 Smali 一点用都没有</b>——' +
              '这时候该拿起来的是 IDA / Frida / unidbg（第 1 / 3 / 7 章），不是 apktool。<br>' +
              '<span class="hit">这是本章（Java 层字节码）与第 3 章（native 层机器码）分工的落点。</span>' },
          { run: () => { S('qq3', 'done'); S('qq4', 'active'); SET('qVerdict', 'Q4：常量、分支、调用适合改 Smali；算法不适合'); },
            note: '<b>Q4：我要改的是哪一层的东西？</b>' +
              '改字符串常量、改分支走向、去掉一个调用、让某个判断恒真——这些都在 Smali 的舒适区里。<br>' +
              '但要改一个加密算法的实现、或者要"还原出服务端的 sign 算法"——' +
              '那就不是 Smali 的战场了（第 8 / 9 / 31 章）。<br>' +
              '<b>Smali 擅长改控制流，不擅长改算法。</b>' },
          { run: () => { S('qq4', 'done'); S('qq5', 'active'); CLS('qNote', 'pill warn'); SET('qNote', '⚠️ 这一步失败的话，前面所有分析都白做'); SET('qVerdict', 'Q5：先跑一遍 d → b → 签名 → 安装'); },
            note: '<b>Q5：工具链能不能原样往返？</b>在动手改任何代码之前，先做一次' +
              '<code>apktool d</code> → <code>apktool b</code> → <code>zipalign</code> → <code>apksigner</code> ' +
              '→ <code>adb install</code> 的空跑。<br>' +
              '失败原因通常是：apktool 与 build-tools 版本不匹配、资源不规范、split APK 没合并、' +
              '系统 App 缺 framework 资源（27.14 与那节的 warn note）。<br>' +
              '<span class="hit">这一跑失败，你要修的是工具链，不是代码——顺序反过来会让你把工具的问题误判成自己改错了。</span>' },
          { run: () => { S('qq5', 'done'); S('qq6', 'active'); SET('qVerdict', 'Q6：一定要有"改动生效"的客观证据'); },
            note: '<b>Q6：改完之后怎么确认"真的生效了"？</b>' +
              '这是最容易被跳过、也最容易骗到自己的一步。<br>' +
              '可用的证据：界面/文案确实变了、logcat 里出现了你加/去掉的那条日志、' +
              '行为分支确实走到了预期的那一条。<br>' +
              '<b>不可用的证据：</b>"我觉得应该生效了"。<br>' +
              '<span class="hit">27.12 实验里那个"只在一种状态下成立"的陷阱，就是靠这一步发现的。</span>' },
          { run: () => {
              ['qq1','qq2','qq3','qq4','qq5','qq6'].forEach(i => S(i, 'ok'));
              CLS('qNote', 'pill ok'); SET('qNote', '✅ 六问都过了，再动手');
              SET('qVerdict', '可以动手：改一行 → 回编译 → 重签 → 安装 → 验证生效');
            },
            note: '<b>六问都过了，才开始改。</b>然后按 27.13 的六步定位法找那一行，' +
              '按 27.14 的流程走工具链，改完按 27.13 第 6 步的"自检四问"检查，' +
              '最后按 Q6 的方式验证。<br>' +
              '<span class="hit">整个流程里，"改"本身只占一小段时间；' +
              '剩下的时间都花在判断上——这就是本章和"看教程改包"的区别。</span>' }
        ]
      },
      after: T.note('', '🧭 一页纸版本',
        '<p style="margin-bottom:0">' +
        '<b>能不能改</b>：加固？（Q1）→ 有校验？（Q2）→ 逻辑在 Java？（Q3）<br>' +
        '<b>怎么改</b>：改什么层？（Q4）→ 工具链通不通？（Q5）→ 怎么验证？（Q6）<br>' +
        '<b>改哪一行</b>：现象→关键字→类与方法→grep 调用点→判断分支方向→自检四问（27.13）<br>' +
        '<b>改完的代价</b>：签名一定变 → 校验一定有机会发现（27.16）→ 所以先问"有没有门"。</p>')
    },

    /* ============================================================ 27.22 */
    {
      h: '27.22', title: '自测①：坐标系与寄存器模型',
      quiz: {
        id: 'q27-1', chapter: 27, answer: 2,
        stem: '关于 Smali、dex 字节码与机器码的关系，下面哪个说法是对的？',
        options: [
          { t: 'Smali 是 Android 的机器码，和设备 CPU 直接对应',
            why: '错误。机器码是 ARM/AArch64 那套（第 3 章），Smali 与 CPU 无关。' },
          { t: 'Smali 是 Java 源码的另一种写法，改 Smali 等于改 Java',
            why: '错误。Smali 对应的是 dex 字节码，不是 Java 源码；两者结构差得很远（例如一行 new 会变成两行）。' },
          { t: 'Smali 是 dex 字节码的可读文本形式，改它最终会重新汇编出新的 dex',
            why: '正确。它和字节码一一对应，汇编时整份 dex 被重新生成。' },
          { t: 'Smali 是设备上 oat 文件的反汇编结果，改完要重新生成 oat',
            why: '错误。Smali 来自 APK 里的 dex；oat 是设备安装后由系统生成的派生物。' }
        ],
        explain: '三个概念的层级关系：<b>Java 源码 → class（JVM 字节码）→ dex（Dalvik 字节码）→ Smali（dex 的文本形式）</b>；' +
          '而<b>机器码（ARM/AArch64）是 native 层 so 的形态</b>，属于另一条线（第 3 章）。<br><br>' +
          '设备安装后系统还会生成 <code>oat</code> / <code>vdex</code> / <code>.art</code> 这些派生物，' +
          '它们是按 dex 算出来的缓存，改它们没有可交付性（换设备/换版本就失效，而且会被重建）。<br><br>' +
          '<b>所以：能改、改了有用的那一环，是 dex → 也就是 Smali。</b>'
      }
    },

    /* ============================================================ 27.23 */
    {
      h: '27.23', title: '自测②：寄存器与对象创建',
      quiz: {
        id: 'q27-2', chapter: 27, answer: 1,
        stem: '一个<b>实例方法</b>声明为 <code>.registers 6</code>，它有 3 个参数，' +
          '其中一个是 <code>long</code>。下面哪个判断是对的？',
        options: [
          { t: '本地槽位有 3 个，p0 = v3',
            why: '错误。参数槽位不能按"参数个数"算，long 占两个槽位，还要加上 this。' },
          { t: '参数槽位有 5 个（this 1 + long 2 + 另外两个各 1），所以本地槽位 1 个，p0 = v1',
            why: '正确。总槽位 6 = 本地 1 + 参数 5，p0 = v(locals) = v1。' },
          { t: '本地槽位有 2 个，p0 = v2',
            why: '错误。这样算等于把 long 当成 1 个槽位了。' },
          { t: '无法判断，必须先看 dex 文件头',
            why: '错误。所需信息在方法签名和寄存器声明里就齐了，不需要读文件头。' }
        ],
        explain: '<b>两条公式解决全部问题：</b><br>' +
          '① <code>总槽位 = 本地槽位 + 参数槽位数</code>；<br>' +
          '② <code>p0 = v(locals)</code>，后续参数按各自占用的槽位数往后排。<br><br>' +
          '<b>参数槽位怎么数：</b>实例方法先算 1 个（<code>this</code>）；' +
          '<code>Z B S C I F</code> 各 1 个；<b><code>J</code> 和 <code>D</code> 各 2 个</b>；' +
          '<code>L…;</code> 是 1 个；<code>[…</code>（数组）也是 1 个（它是引用）。<br><br>' +
          '本题：this(1) + long(2) + 2 个各 1 = <b>5 个参数槽位</b>；' +
          '总 6 → 本地 1 个；<code>p0 = v1</code>。<br><br>' +
          '<span class="hit">记住"数槽位，不数参数"——这是手改 Smali 时最容易翻车的地方。</span>'
      }
    },

    /* ============================================================ 27.24 */
    {
      h: '27.24', title: '自测③：invoke 与 move-result',
      quiz: {
        id: 'q27-3', chapter: 27, answer: 3,
        stem: '为什么构造方法要用 <code>invoke-direct</code> 而不是 <code>invoke-virtual</code>？',
        options: [
          { t: '因为 invoke-virtual 的性能更差',
            why: '错误。这是语义问题，不是性能问题。' },
          { t: '因为构造方法的返回类型是 V，virtual 不能调 void 方法',
            why: '错误。void 方法和分派方式无关，普通 void 方法照样用 invoke-virtual。' },
          { t: '因为 invoke-direct 可以少写一个寄存器',
            why: '错误。寄存器列表的写法不因分派方式而不同（静态方法才不带接收者）。' },
          { t: '因为构造方法不可被重写，不存在"按实际类型分派构造器"的语义',
            why: '正确。子类构造方法不是覆盖父类的 <init>，而是显式调用它；<init> 没有虚方法表条目。' }
        ],
        explain: '<code>&lt;init&gt;</code>（构造方法）和 <code>private</code> 实例方法是<b>非虚</b>的：' +
          '它们<b>不能被重写</b>，因此不存在"按对象实际类型去分派"这件事。' +
          '所以必须用 <code>invoke-direct</code>。<br><br>' +
          '反过来理解更清楚：<code>invoke-virtual</code> 的含义是"按运行时类型分派"——' +
          '如果用它调构造器，语义上就变成"我想找一个被覆盖过的构造器"，而这在对象模型里根本不成立。<br><br>' +
          '<b>顺带记牢返回值那条约束：</b>返回值要靠紧跟其后的 <code>move-result</code>' +
          '（32 位）/ <code>move-result-object</code>（对象）/ <code>move-result-wide</code>（64 位）来接，' +
          '<b>void 方法不接</b>，而且这条指令不能和 invoke 分离——这正是"删一行调用要连着删两行"的原因。'
      }
    },

    /* ============================================================ 27.25 */
    {
      h: '27.25', title: '自测④：工具链与重打包的代价',
      quiz: {
        id: 'q27-4', chapter: 27, answer: 2,
        stem: '改完 Smali、回编译成功、也签了名，但 <code>adb install -r</code> 报 ' +
          '<code>INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match</code>。正确的理解是？',
        options: [
          { t: '签名步骤做错了，重新签一次就好',
            why: '错误。签名本身是成功的（否则报的是"未签名"一类错误）。问题在于"和已安装版本不一致"。' },
          { t: 'APK 结构被 apktool 破坏了',
            why: '错误。结构问题会表现为解析失败（INSTALL_PARSE_FAILED_...），不是签名不匹配。' },
          { t: '正常现象：你用新密钥签了名，而设备上还装着用旧密钥签的原版；必须先卸载原包',
            why: '正确。这是 Android 的保护机制：同包名不允许用不同密钥覆盖安装。' },
          { t: '设备开启了"仅允许安装应用商店的应用"，去设置里关掉即可',
            why: '错误。那个限制的报错形态不是签名不匹配。' }
        ],
        explain: 'Android 用签名来绑定"同一个包名的升级关系"：<b>只有签名一致才允许覆盖安装</b>，' +
          '这是防止别人用你的包名替换你的 App 的第一道机制。<br><br>' +
          '你重新签了名，签名摘要必然变了（哪怕一个字节都没改）→ 覆盖安装必然失败 → ' +
          '<b>只能先卸载再安装</b>（代价是 App 数据全部丢失，需要备份的话要提前做）。<br><br>' +
          '记住这个失败和"签名校验"是<b>两件不同的事</b>：<br>' +
          '· <code>INSTALL_FAILED_UPDATE_INCOMPATIBLE</code>：安装器拒绝了，App 还没跑起来；<br>' +
          '· 装上之后启动即退：那是 App 自己发现签名变了（签名校验），属于运行时行为。<br>' +
          '<span class="hit">把这两者分开，你就能在"安装失败"和"运行被拒"之间快速定位。</span>'
      }
    },

    /* ============================================================ 27.26 */
    {
      h: '27.26', title: '自测⑤：加固、后门与防范',
      quiz: {
        id: 'q27-5', chapter: 27, answer: 1,
        stem: '为什么"改 Smali 重打包"在带加固（尤其抽取壳）的样本上常常走不通？',
        options: [
          { t: '因为 apktool 不支持加固后的 APK，工具报错',
            why: '错误。apktool 往往能正常解密（因为壳的 dex 是明文的），问题不在工具能不能跑。' },
          { t: '因为静态文件里的方法体是空的（运行时才回填），你改的那份不是运行时执行的代码；' +
            '而且还有 Java + native 双份签名/完整性校验在等着',
            why: '正确。这是"前提不成立"，不是"技术不够强"。' },
          { t: '因为加固后的 dex 版本号不同，Smali 语法也不一样',
            why: '错误。dex 格式与语法没变，加固不改变字节码规范。' },
          { t: '因为重打包后体积变大，超过系统限制',
            why: '错误。与体积无关。' }
        ],
        explain: '两个原因，任一都足以劝退：<br><br>' +
          '<b>① 前提不成立。</b>抽取壳保留 dex 结构（类名、方法名、字段都在）但抽走方法体的 ' +
          '<code>code_item</code>，方法首次被调用时才回填。所以你 apktool 反编译出来的' +
          '"业务代码"可能是空方法——<b>你连要改的代码都没看到</b>（第 2 章）。<br><br>' +
          '<b>② 门一定是关着的。</b>加固产品的默认项就包含防二次打包：Java 层 + native 层双份签名校验、' +
          'dex/so 完整性校验，甚至三角校验（so ↔ dex ↔ 动态加载的 dex 互相校验，第 19 章）。' +
          '而重新签名一定改变签名摘要——这是密码学层面的必然，不是操作失误（本章 27.16）。<br><br>' +
          '<b>所以正确路线通常是：</b>先脱壳/用运行时手段读懂逻辑（第 2 / 10 / 12 章），' +
          '改动与验证走 Hook 或 IO 重定向（第 1 / 21 / 22 章及本章案例），' +
          '而不是在静态文件里和校验逻辑硬刚。<br>' +
          '<span class="hit">"改 Smali 重打包"的主场是：无加固、无完整性校验的目标——自家 Demo、CTF 题、老旧小工具。</span>'
      }
    }

  ],

  /* ============================================================== 名词表 */
  glossary: [
    { t: 'Smali', d: 'dex 字节码的可读文本形式。它不是 Java 也不是机器码，与字节码一一对应。改 Smali 后需要重新汇编出新的 dex。' },
    { t: 'baksmali / smali', d: '一对工具：baksmali 把 dex 反汇编成 .smali 文本，smali 把 .smali 汇编回 dex。对结构不规范的 dex 容忍度通常高于反编译器。' },
    { t: 'apktool', d: 'APK 解密/回编译工具，内部包含 smali/baksmali 与资源处理。解密产出 smali/ res/ AndroidManifest.xml，回编译重新组装成 APK。' },
    { t: 'dex', d: 'Dalvik Executable，APK 里装着的字节码容器。Dalvik 虚拟机已退场，但 dex 格式沿用至今（ART 执行的仍是它）。' },
    { t: 'Dalvik 字节码', d: 'dex 里那套指令集。名字来自已退场的 Dalvik 虚拟机，但 ART 时代格式没变，所以你在 Android 14 上反编译到的仍是它。' },
    { t: 'ART', d: 'Android Runtime，Android 5.0 起取代 Dalvik。AOT 编译 + JIT + 解释器并存，并按运行剖面做分级编译。它执行的仍是 dex 字节码。' },
    { t: 'odex / vdex / oat / .art', d: '设备安装后由系统按 dex 生成的派生物（缓存性质）。换设备/换系统版本/换编译策略都会重来，所以不构成"可交付的改动对象"。' },
    { t: '.registers / .locals', d: '方法开头的寄存器声明。.registers 是总槽位数，.locals 是本地槽位数，两者关系：总槽位 = 本地 + 参数槽位。' },
    { t: 'p 寄存器（p0 / p1 …）', d: '参数寄存器的别名，从最右边开始排：pN = v(locals + N)。实例方法的 p0 就是 this。' },
    { t: '寄存器槽位', d: '一个 32 位单元。long / double 各占两个槽位；对象引用和数组各占一个。数槽位而不是数参数，是算 .registers 的唯一正确方法。' },
    { t: 'invoke-virtual', d: '调用可被重写的实例方法，按对象实际类型分派（走虚方法表）。' },
    { t: 'invoke-direct', d: '调用非虚方法：构造方法 <init> 与同类内的 private 方法。' },
    { t: 'invoke-static / invoke-super / invoke-interface', d: '分别用于静态方法（无 this）、父类实现（super 调用）、声明类型是接口的方法。' },
    { t: 'move-result', d: '接收上一条 invoke 的返回值。变体：move-result（32 位）、-object（对象）、-wide（64 位）。必须紧跟 invoke，void 方法不需要。' },
    { t: 'new-instance + <init>', d: '对象创建的两步：new-instance 分配内存并设置类型，invoke-direct 调用构造方法完成初始化。这就是"一行 Java 变两行 Smali"的原因。' },
    { t: '标签（:label）', d: '跳转目标，由工具按顺序命名，不携带语义。判断分支方向必须看两条路径实际做了什么，不能靠助记符猜。' },
    { t: 'if-eqz / if-nez', d: '单寄存器与 0 比较的条件跳转：eqz 是"等于 0 时跳"。把 eqz 改成 nez 是"取反"，不是"恒成立"——这是改包最常见的陷阱。' },
    { t: '.catch / .catchall', d: 'try/catch 的 Smali 表达：用标号区间划定受保护范围，指向异常处理器入口；处理器第一条指令必须是 move-exception。' },
    { t: '交叉引用（grep 调用点）', d: 'Smali 里成员名字是字面量，所以"谁调用了这个方法"可以直接搜索——这是 Smali 相对纯字节码的最大优势。' },
    { t: 'zipalign', d: '让 APK 内未压缩数据按边界对齐的工具。必须在签名之前执行，签名后再对齐会破坏签名。' },
    { t: 'jarsigner / apksigner', d: 'jarsigner（JDK 自带）只能做 v1 的 JAR 签名；apksigner（build-tools）支持 v1/v2/v3/v4，是现在的标准工具。' },
    { t: 'APK 签名方案 v1–v4', d: 'v1 基于 JAR 签名（META-INF 下三个文件）；v2 把 APK 当整体 blob 签名（动一个字节即作废）；v3、v4 依次引入（Android 9 / 11）。' },
    { t: '签名校验', d: 'App 读取自身签名摘要并与内置值比对。重打包后签名摘要必然变化，因此必然被发现。加固产品常做 Java + native 双份。' },
    { t: '完整性校验', d: '校验 dex / so / 资源的内容摘要（如 dexcrc、APK 内容摘要）。只看签名不够，因为攻击者可以重签。' },
    { t: '隐式签名校验', d: '发现 APK 被改后不闪退，而是悄悄改变部分功能或数据。比闪退危险得多，因为它让你误以为成功。' },
    { t: '三角校验', d: '多个校验点互相牵制（如 so 检 dex、动态加载的 dex 检 so、dex 检动态 dex），使任何单点修改都留下矛盾。' },
    { t: '重打包（二次打包）', d: '解包 → 改动 → 回编译 → 重新签名的完整动作。灰产用它植入后门，开发者用签名/完整性校验对抗它（第 19 章"防二次打包"）。' },
    { t: '后门植入', d: '把不属于原作者的代码塞进 APK 的常见入口：Application / attachBaseContext、入口 Activity、native so、dlsym 劫持、dex 插桩、assets payload。' },
    { t: 'attachBaseContext', d: 'Application 里最早的 Java 执行点之一。加固壳用它抢先执行，植入方也盯它——谁先拿到执行权谁占主动。' },
    { t: 'split APK / App Bundle', d: '商店分发的现代形态：基础包 + 若干 split。直接对 split 做 apktool 处理通常要先合并，属于工具链层面的坑。' }
  ],

  /* ============================================================== 严师 */
  teacher: {
    id: 't27', chapter: 27,
    name: '追问老师 · 第二十七章',
    sub: '说不清"它在哪一层、改了会怎样"，你改的每一行都是在赌',
    intro: '<p style="margin:0">我不考你 apktool 的命令怎么写（那个查文档就行）。' +
      '我考三件事：<b>Smali 站在代码表示链的哪一环、寄存器账怎么算、以及你为什么一定躲不开签名那道门。</b><br>' +
      '答不上来我会追问，问到第三次我直接给答案——但那不算你过关，你得用自己的话复述一遍。</p>',
    questions: [
      {
        id: 'c27q1', depth: 1, threshold: 0.7,
        q: '请说清 <b>Smali、dex 字节码、机器码</b> 三者的关系，并解释：' +
          '<b>为什么改包改的是 dex（Smali），而不是设备上那份"已经编译好的代码"？</b>',
        concepts: [
          { label: 'Smali 是 dex 字节码的可读文本形式，两者一一对应，不是另一门语言',
            hint: 'Smali 和字节码是"两种语言"还是"同一件事的两种写法"？',
            any: ['文本形式', '可读文本', '一一对应', '同一件事', '不是另一种语言', 'text', '人类可读', '逐条'] },
          { label: '机器码是 native 层（so）的形态，属于 ARM/AArch64，那是第 3 章的领域',
            hint: '机器码出现在哪一层？',
            any: ['机器码', 'arm', 'aarch64', 'native', 'so', '第3章', '第三章', '底层指令', 'cpu'] },
          { label: '设备上的 oat / vdex / .art 是系统按 dex 生成的派生物，会被重建、与设备绑定',
            hint: '设备上那份"编译好的"东西是谁生成的？换个设备还一样吗？',
            any: ['oat', 'vdex', '派生物', '派生', '缓存', '系统生成', '重建', 'dex2oat', 'art'] },
          { label: 'dex 是唯一的"源"，改它才能重新汇编出可安装的产物；机器码无法塞回 APK',
            hint: 'APK 里有 oat 吗？你改完的机器码怎么装回去？',
            any: ['唯一', '源', '重新汇编', '重新生成', 'apk 里没有', '装不回去', '可交付', '重新编译'] },
          { label: 'Dalvik 虚拟机已退场但字节码格式没变，ART 执行的仍是 dex 字节码',
            hint: 'ART 时代反编译出来的还是"Dalvik 字节码"吗？',
            any: ['art', 'dalvik', '格式没变', '沿用', '仍然是', '同一套', '字节码格式'] }
        ],
        hints: [
          '把这条链按顺序说出来：Java 源码 → class → dex → ? 以及 Smali 站在哪一环。',
          '设备上那些 oat / vdex 是谁生成的？如果系统发现 dex 变了，它会怎么做？'
        ],
        probes: [
          '那我追问：如果你把设备上 oat 文件里的机器码 patch 了，会怎样？为什么这条路没有可交付性？',
          '再问：为什么脱壳工具反而对 vdex / oat 很感兴趣？这和"改包"的结论矛盾吗？'
        ],
        model: '<b>先建立链条：</b><br>' +
          'Java 源码（<code>.java</code>）→ javac → <code>.class</code>（JVM 字节码）→ d8/R8 → ' +
          '<code>classes.dex</code>（<b>Dalvik 字节码</b>）→ 打包签名成 APK → 安装到设备 → ' +
          '系统生成 <code>oat</code> / <code>vdex</code> / <code>.art</code>（派生物）。<br><br>' +
          '<b>Smali 站在哪一环：</b>它是 <b>dex 字节码的可读文本形式</b>。' +
          'baksmali 把 dex 的 opcode 与索引翻译成"指令名 + 完整成员名"的文本，' +
          'smali 汇编器再把它变回 dex。<b>两者一一对应，信息不丢。</b>' +
          '它不是 Java（不还原语法糖，不做类型推断），也不是机器码（与 CPU 无关）。<br><br>' +
          '<b>为什么改 dex 而不是机器码——三层理由：</b><br>' +
          '<b>① 机器码在 APK 里根本不存在。</b>' +
          'APK 里只有 dex。<code>oat</code> / <code>vdex</code> 是设备安装后由 <code>dex2oat</code> ' +
          '按这台设备的架构和系统版本生成<strong>派生物</strong>。' +
          '你改完的机器码没法"装回 APK"，因为它不属于 APK。<br>' +
          '<b>② 派生物会和设备绑定，且随时会被重建。</b>' +
          '同一份 dex 在 ARM64 手机和 32 位设备上生成的东西完全不同；' +
          '而系统一旦发现 dex 变了（或缓存被清、App 重装），就会重新生成。' +
          '<b>你改的是"结果"，系统随时按"原因"重算一遍结果。</b><br>' +
          '<b>③ 重新汇编 dex 是"整份重新生成"，不是原地打补丁。</b>' +
          '所以你改 Smali 时不需要操心字符串变长、指令长度变化、偏移与对齐——这些全都会重算。' +
          '这一点在 native 层（第 3 章）是做不到的：那里改一个字节要考虑指令长度、对齐、重定位。' +
          '<span class="hit">"改 Smali"比"patch so"轻松，根本原因就在这里。</span><br><br>' +
          '<b>顺带回答一个常见的混淆：</b>Dalvik 虚拟机已经退场，但 <b>dex 字节码格式没变</b>，' +
          'ART 执行的仍然是它。所以"Dalvik 字节码"这个名字活到了今天，' +
          '你在 Android 14 上反编译出来的还是它（dex magic 写着 <code>039</code>/<code>040</code>）。'
      },
      {
        id: 'c27q2', depth: 2, threshold: 0.75,
        q: '一个实例方法写着 <code>.registers 8</code>，它的签名是 <code>encrypt(Ljava/lang/String;J[BI)V</code>。' +
          '请说出：<b>本地槽位几个？p0 是哪个 v？参数寄存器分别落在哪些 v 上？</b>' +
          '如果换成 <code>.locals</code> 该怎么写？',
        concepts: [
          { label: '参数槽位要"数槽位"：this(1) + String(1) + long(2) + byte[] 数组(1) + int(1) = 6',
            hint: 'long 占几个槽位？数组占几个？this 算不算？',
            any: ['long 占两个', '两个槽位', '宽类型', 'this 一个', '数组一个', '引用', '6 个', '六个', '数槽位'] },
          { label: '本地槽位 = 总槽位 - 参数槽位 = 8 - 6 = 2（即 v0、v1）',
            hint: '总数减掉参数就是本地。',
            any: ['8-6', '8 减 6', '2 个', 'v0 v1', '本地 2', 'locals 2'] },
          { label: 'p0 = v(locals) = v2，并且实例方法的 p0 就是 this',
            hint: '公式是什么？p0 代表什么？',
            any: ['p0=v2', 'p0 = v2', 'v(locals)', 'locals 位置', 'this', '当前对象'] },
          { label: '后续参数依次往后排：p1=v3（String）、p2/p3=v4/v5（long 两个槽位）、p4=v6（数组）、p5=v7（int）',
            hint: 'long 后面的参数会怎样？',
            any: ['p1=v3', 'p2', 'v4', 'v5', 'p4=v6', 'p5=v7', '依次', '往后排', '跳过两个'] },
          { label: '换成 .locals 就写 .locals 2（两种声明等价）',
            hint: '两种写法怎么换算？',
            any: ['.locals 2', 'locals 2', '等价', '同一个意思', '一样'] }
        ],
        hints: [
          '先把参数槽位一个个数出来，别数参数个数。',
          '公式只有两条：总 = 本地 + 参数；p0 = v(locals)。'
        ],
        probes: [
          '追问：如果你把 <code>.registers 8</code> 改成 <code>.registers 10</code>，' +
          '但方法体里一个 <code>p0</code> 都没改，会发生什么？为什么？',
          '再问：如果那个参数不是 <code>J</code> 而是 <code>[J</code>（long 数组），参数槽位数会变吗？为什么？'
        ],
        model: '<b>第一步：数参数槽位（不是数参数个数）。</b><br>' +
          '· <code>this</code> → 1 个（实例方法才有）<br>' +
          '· <code>Ljava/lang/String;</code> → 1 个（对象引用）<br>' +
          '· <code>J</code>（long）→ <b>2 个</b>（宽类型占两个槽位）<br>' +
          '· <code>[B</code>（byte 数组）→ 1 个（数组是引用，里面的元素类型不影响寄存器数量）<br>' +
          '· <code>I</code>（int）→ 1 个<br>' +
          '<b>合计 6 个参数槽位。</b><br><br>' +
          '<b>第二步：本地槽位。</b>总槽位 8 − 参数 6 = <b>2 个</b>，即 <code>v0</code>、<code>v1</code>。<br><br>' +
          '<b>第三步：p 编号 → v 编号。</b>参数寄存器从最右边开始排，' +
          '公式 <code>p0 = v(locals) = v2</code>：<br>' +
          '· <code>p0 = v2</code>（<b>this</b>）<br>' +
          '· <code>p1 = v3</code>（那个 String）<br>' +
          '· <code>p2 = v4</code>、<code>p3 = v5</code>（<b>同一个 long 的低位与高位</b>）<br>' +
          '· <code>p4 = v6</code>（byte 数组）<br>' +
          '· <code>p5 = v7</code>（int）<br><br>' +
          '<b>第四步：换写法。</b>两种声明等价：<code>.registers 8</code> ≡ <code>.locals 2</code>。' +
          '<code>.locals</code> 只写本地数量，参数部分由工具自己加上。<br><br>' +
          '<b>追问的答案（这句最重要）：</b>' +
          '如果你把 <code>.registers</code> 从 8 改成 10，<b>locals 就从 2 变成 4</b>，' +
          '于是 <code>p0</code> 指向的 v 编号从 <code>v2</code> 整体平移到了 <code>v4</code>。' +
          '而方法体里写的是 <code>p0</code> 这个名字，<b>看起来一个字没变，实际指向的槽位全变了</b>——' +
          '本来装 this 的地方现在装的是别的值，运行结果会莫名其妙地错，而且不一定崩。<br>' +
          '<span class="hit">这就是"我只改了一个数字，怎么全乱了"的完整成因，也是本节实验最后一个动画要你带走的东西。</span><br><br>' +
          '<b>关于 <code>[J</code>：</b>不会变。数组本身是一个<b>引用</b>，占 1 个槽位；' +
          '数组元素的类型（哪怕元素是 long）不影响它占几个寄存器。' +
          '这是数槽位时第二个高频错误（第一个是忘记 long/double 占两个）。'
      },
      {
        id: 'c27q3', depth: 2, threshold: 0.7,
        q: '五条 invoke 分别什么时候用？另外两个问题：' +
          '<b>为什么构造函数必须用 invoke-direct</b>，以及' +
          '<b>返回值怎么接、为什么 move-result 不能和 invoke 分开？</b>',
        concepts: [
          { label: 'invoke-virtual：可被重写的实例方法，按对象实际类型分派（虚方法表）',
            hint: '最常见的普通实例方法用哪条？',
            any: ['virtual', '虚方法', '重写', '重写的方法', '实例方法', '分派', 'vtable', '虚表'] },
          { label: 'invoke-direct：非虚调用，用于构造方法 <init> 与 private 实例方法',
            hint: '哪两类方法不可能被重写？',
            any: ['direct', '构造', 'init', 'private', '私有', '非虚', '不可重写', '不能被重写'] },
          { label: 'invoke-static 没有 this；invoke-super 调父类实现；invoke-interface 用于声明类型是接口的方法',
            hint: '剩下三条分别对应什么场景？',
            any: ['static', '静态', '没有 this', 'super', '父类', '父类实现', 'interface', '接口', '接口方法'] },
          { label: '返回值必须用紧跟其后的 move-result / -object / -wide 接收；void 方法不需要；指令不能分离',
            hint: 'invoke 自己会把返回值写进寄存器吗？',
            any: ['move-result', 'move result', '紧跟', '不能分开', '必须紧跟', 'object', 'wide', 'void 不用', '无返回值'] },
          { label: '寄存器列表：实例方法第一个是接收者（this），静态方法不带；参数多时用 /range',
            hint: '花括号里第一个寄存器是谁？什么时候要写 /range？',
            any: ['花括号', '寄存器列表', '接收者', 'this', 'range', '连续', '超过 5', '五个'] }
        ],
        hints: [
          '判断口诀：能被重写 → virtual；不能被重写（private / 构造）→ direct；没有 this → static；' +
          '调父类 → super；声明类型是接口 → interface。',
          '返回值这条想一想：如果 invoke 后面插了别的指令，move-result 还能知道"该接谁的返回值"吗？'
        ],
        probes: [
          '追问：如果你删掉一条 <code>invoke-static</code>（比如某个统计上报），' +
          '但它后面跟着一条 <code>move-result</code>，会发生什么？为什么要连着删两行？',
          '再问：什么时候必须用 <code>invoke-*  /range</code>？它和普通写法有什么约束差异？'
        ],
        model: '<b>五条 invoke 的分工（按"能不能被重写"和"有没有 this"分）：</b><br>' +
          '· <code>invoke-virtual</code>：普通实例方法。<b>能被重写</b>，所以要按对象的实际类型分派（虚方法表）。<br>' +
          '· <code>invoke-direct</code>：<b>不能被重写</b>的调用——构造方法 <code>&lt;init&gt;</code> ' +
          '与同类内部的 <code>private</code> 实例方法，不走虚分派。<br>' +
          '· <code>invoke-static</code>：静态方法，<b>没有 this</b>，寄存器列表里第一个就是第一个真实参数。<br>' +
          '· <code>invoke-super</code>：在重写的方法里调父类实现，对应 <code>super.foo()</code>。<br>' +
          '· <code>invoke-interface</code>：被调方法的<b>声明类型是接口</b>时使用。分派目标由实现类决定，' +
          '但静态类型是接口。<br><br>' +
          '<b>为什么构造函数必须是 invoke-direct：</b>' +
          '因为它<b>不能被重写</b>。子类的构造方法不是"覆盖"父类的 <code>&lt;init&gt;</code>，' +
          '而是在自己的第一行<b>显式调用</b>它；<code>&lt;init&gt;</code> 没有虚方法表条目。<br>' +
          '换成 <code>invoke-virtual</code> 去调它，语义就变成"按运行时类型分派一个构造器"——' +
          '这件事在对象模型里根本不成立。<span class="hit">所以这不是约定，是类型系统逼出来的唯一写法。</span><br><br>' +
          '<b>返回值：</b><code>invoke-*</code> 自己不把返回值写进寄存器，' +
          '要靠紧跟着的一条 <code>move-result</code> 系列：<br>' +
          '· <code>move-result</code> → 32 位（int / boolean / float 等）<br>' +
          '· <code>move-result-object</code> → 对象引用<br>' +
          '· <code>move-result-wide</code> → 64 位（long / double）<br>' +
          '· <b>void 方法不接</b>（写了就是错的）<br>' +
          '<b>为什么不能分开：</b>因为 <code>move-result</code> 的语义就是"取我前面那条 invoke 的返回值"——' +
          '它依赖"紧邻"这个位置关系。中间插了别的指令，它接的就不再是那条 invoke 的结果了。<br>' +
          '<span class="hit">这条约束直接决定了实战动作：<b>你要删掉一条调用，就必须检查它后面有没有 move-result，' +
          '有的话要一起处理。</b>否则轻则回编译失败，重则读到上一次调用的残留值——不崩，但结果是错的。</span><br><br>' +
          '<b>补充两条工程细节：</b><br>' +
          '① 非 range 形式的寄存器列表最多 5 个（寄存器字段只有 4 位），参数多或寄存器编号大时要改用 ' +
          '<code>/range</code>，而且 <b><code>/range</code> 要求寄存器连续</b>。<br>' +
          '② 实例方法的寄存器列表第一个永远是接收者；静态方法<b>不要</b>传它——' +
          '这两点写反了，回编译可能过，运行时才炸。'
      },
      {
        id: 'c27q4', depth: 3, threshold: 0.7,
        q: '<b>综合题：</b>给你一段 Smali（下面这段是真实结构，行号只是标注）：<br>' +
          '<pre data-hl><code>1  .method public check()V\n' +
          '2      .registers 4\n' +
          '3      iget-boolean v0, p0, Lcom/demo/app/User;-&gt;vip:Z\n' +
          '4      invoke-virtual {p0}, Lcom/demo/app/User;-&gt;isVip()Z\n' +
          '5      move-result v1\n' +
          '6      if-eqz v1, :cond_0\n' +
          '7      const-string v2, "VIP 已开通"\n' +
          '8      invoke-static {v2}, Lcom/demo/app/Log;-&gt;d(Ljava/lang/String;)V\n' +
          '9      return-void\n' +
          '10 :cond_0\n' +
          '11     const-string v2, "非会员"\n' +
          '12     invoke-static {v2}, Lcom/demo/app/Log;-&gt;d(Ljava/lang/String;)V\n' +
          '13     return-void\n' +
          '14 .end method</code></pre>' +
          '请回答三件事：<b>① 寄存器布局（本地几个、p0 是哪个 v、各 v 装什么）；' +
          '② 它的等价 Java 逻辑；③ 如果要让"永远走 VIP 那一支"，你会改哪一行、为什么</b>——' +
          '并说明"把 if-eqz 改成 if-nez"为什么不算正确答案。',
        concepts: [
          { label: '寄存器布局：参数只有 this（1 个），所以本地 3 个（v0 v1 v2），p0 = v3',
            hint: '这个方法有几个参数槽位？',
            any: ['本地 3', 'v0 v1 v2', 'p0=v3', 'p0 = v3', '一个参数', '只有 this', 'v3 是 this'] },
          { label: '等价 Java：读一个 vip 布尔字段（结果没被使用），再调用 isVip()，' +
              'true 打"VIP 已开通"、false 打"非会员"',
            hint: '第 3 行读的字段用到了吗？第 4 行才是真正决定分支的。',
            any: ['isVip', '字段', 'vip', '日志', 'log', '打日志', '无用的读取', '没被使用', '分支'] },
          { label: 'if-eqz v1 是"v1 == 0 时跳到 :cond_0"，所以跳过去是"非会员"那支；不跳才是 VIP 那支',
            hint: '跳转目标那段代码做的是什么？',
            any: ['v1==0', '等于 0', '跳转到非会员', '跳过去是非会员', '不跳是 vip', 'cond_0', '落下去是 vip'] },
          { label: '正确改法：改第 5 行 move-result v1 为 const/4 v1, 0x1（改事实），或去掉第 6 行的跳转（删分支）',
            hint: '两条路：改"事实"或者改"判断"。',
            any: ['move-result 改成 const', 'const/4 v1', 'const/4 v1, 0x1', '删掉 if', '注释掉 if',
                  '去掉跳转', '无条件', '改事实', '永不跳转'] },
          { label: 'if-nez 是"把条件取反"，只在一种状态下成立：非会员时走 VIP 支，会员时反而跳到非会员支',
            hint: '取反之后，会员状态会发生什么？',
            any: ['取反', '反过来', '不是恒真', '只在一种', '状态相关', '会员时跳', '逻辑反转', '不成立'] },
          { label: '改上游 isVip() 也能达到目的，但影响面更大（别处也可能在用它）',
            hint: '还有第三条路吗？它的代价是什么？',
            any: ['改 isVip', '改上游', '影响面', '别处', '被调用', '上下文', '全局'] }
        ],
        hints: [
          '先把寄存器账算出来：这个方法有几个参数？.registers 4 减掉参数就是本地数量。',
          '判断分支方向不要看助记符，去看那个标签下面那段代码在干什么。'
        ],
        probes: [
          '追问：第 3 行读到 <code>v0</code> 的那个字段之后，整个方法里再也没用过 v0——' +
          '这说明原 Java 代码可能是什么样子？这种"读了不用"的指令对你定位逻辑有什么价值？',
          '再追问：如果你改的是第 4 行（把 invoke-virtual 换成 invoke-static），会发生什么？为什么？'
        ],
        model: '<b>① 寄存器布局。</b><br>' +
          '方法签名是 <code>check()V</code>——<b>没有参数</b>。但它是实例方法，所以参数槽位 = 1（<code>this</code>）。<br>' +
          '总槽位 4 − 参数 1 = <b>本地 3 个</b>：<code>v0</code>、<code>v1</code>、<code>v2</code>。<br>' +
          '<code>p0 = v(locals) = v3</code>（就是 <code>this</code>）。<br>' +
          '各寄存器的用途：<br>' +
          '· <code>v0</code>：第 3 行读进来的 <code>vip</code> 字段值（<b>读完就再也没用过</b>）<br>' +
          '· <code>v1</code>：第 5 行接收 <code>isVip()</code> 的返回值，第 6 行用它做分支<br>' +
          '· <code>v2</code>：两条分支里各自复用的字符串寄存器<br>' +
          '· <code>p0 / v3</code>：<code>this</code><br><br>' +
          '<b>② 等价 Java 逻辑。</b>大意是：<br>' +
          '<code>boolean b = this.vip;  // 读了但没用（很可能是反编译后残留，或原作者调试留下的）</code><br>' +
          '<code>if (this.isVip()) { Log.d("VIP 已开通"); } else { Log.d("非会员"); }</code><br>' +
          '注意第 3 行的 <code>iget-boolean</code> <b>对这个方法的输出没有任何影响</b>——' +
          '它是这段代码里最值得怀疑的一行：<b>要么是残留，要么是"看起来在判断实际上不是"的伪装</b>。' +
          '在真实样本里，这种"读了不用"的指令往往就是作者故意放的干扰项。<br><br>' +
          '<b>③ 分支方向（不改之前先判断）：</b>' +
          '<code>if-eqz v1, :cond_0</code> 的意思是 <b>v1 == 0（不是会员）时跳到 <code>:cond_0</code></b>，' +
          '而 <code>:cond_0</code> 那段打的是"非会员"。所以：<b>跳 = 非会员，不跳（顺走）= 会员</b>。<br><br>' +
          '<b>让它恒走 VIP 的两条正确改法：</b><br>' +
          '<b>改法 A（改事实，推荐）：</b>第 5 行 <code>move-result v1</code> → ' +
          '<code>const/4 v1, 0x1</code>。<br>' +
          '第 5 行是"把 <code>isVip()</code> 的结果搬进 v1"的唯一入口，' +
          '把它换成常量 1，等于在源头把事实改成"是会员"，后面的分支一行都不用动。<br>' +
          '<b>改法 B（删分支）：</b>把第 6 行注释掉（Smali 用 <code>#</code>）。' +
          '没有跳转，执行流从第 5 行直接落到第 7 行——同样恒走 VIP 支。<br>' +
          '<b>改法 C（改上游）：</b>去 <code>isVip()</code> 里让它恒返回 1。' +
          '也有效，但影响面更大：<b>全 App 所有调用 <code>isVip()</code> 的地方都会被影响</b>，' +
          '可能连带你没预期的界面/逻辑一起改变。这是工程判断，不是对错。<br><br>' +
          '<b>为什么 if-nez 不算正确答案：</b>' +
          '<code>if-nez v1, :cond_0</code> 是"<b>把跳转条件取反</b>"，不是"让 VIP 恒成立"。取反之后：<br>' +
          '· 非会员（v1 = 0）→ <b>不跳</b> → 顺走到第 7 行，打了"VIP 已开通" ✅（看起来成功了）<br>' +
          '· 会员（v1 = 1）→ <b>跳转</b> → 落到 <code>:cond_0</code>，打了"非会员" ❌<br>' +
          '<span class="hit">你只是把"会员显示非会员"倒了过来，逻辑依然是反的。' +
          '更要命的是：如果你测试时恰好是非会员状态，你会以为改成功了。</span>' +
          '<b>判断标准永远是"在所有可能状态下都达到目的"，不是"我这次测试成功了"。</b><br><br>' +
          '<b>追问的答案（关于第 4 行）：</b>如果把 <code>invoke-virtual</code> 换成 <code>invoke-static</code>，' +
          '有两个问题：① 分派方式与目标方法不符（<code>isVip()</code> 是可重写的实例方法）；' +
          '② 寄存器列表对不上——静态方法<b>不该传接收者</b>，而这里传了 <code>{p0}</code>。' +
          '这类改动的典型后果是<b>回编译可能通过、运行时才崩</b>，比语法错误更难查。'
      },
      {
        id: 'c27q5', depth: 3, threshold: 0.7,
        q: '<b>综合题：</b>你按本章流程给一个 App 改了一行 Smali，重新签名安装后：' +
          '<b>它能启动，但启动页一闪就退，logcat 里没有 Java 异常栈。</b><br>' +
          '请给出你的<b>完整排查流程</b>：怎么区分"签名/完整性校验"和"我自己改错了"？' +
          '每一步的依据是什么？如果最后确认是校验，接下来有哪些方向、各自的代价是什么？',
        concepts: [
          { label: '先做控制变量：不改任何代码、只重新签名安装（原样往返），看是否同样被拒',
            hint: '最便宜的一步是什么？',
            any: ['控制变量', '不改任何', '原样', '往返', '重新签名安装', '只签名', '二分', '最便宜'] },
          { label: '判据：原样往返还退 → 是校验（与我的改动无关）；不退 → 先怀疑自己的改动',
            hint: '这一步的结果怎么解读？',
            any: ['原样也退', '说明是校验', '与我无关', '不是我改的', '排除', '范围内', '二分'] },
          { label: '看 logcat 的形态：有明确异常栈（VerifyError / NoSuchMethodError 等）更像改错了；' +
              '只有进程退出、没有异常，更像校验',
            hint: '崩溃栈的有无说明了什么？',
            any: ['logcat', '异常栈', 'verifyerror', 'nosuchmethod', '没有异常', '静默', '进程退出', '无栈'] },
          { label: '校验的层次：Java 层（读签名摘要比对）/ native 层（自己读 APK 算摘要，或 SVC 不走 libc）/ ' +
              '完整性校验（dex so 资源摘要）/ 三角校验 / 隐式校验（不闪退只改功能）',
            hint: '如果确认是校验，它可能放在哪几层？',
            any: ['java 层', 'native', 'so', '完整', 'dex 摘要', '三角', '隐式', 'svc', '系统调用', 'getPackageInfo'] },
          { label: '为什么会必然被发现：重新签名后签名摘要必然变化，这是密码学层面的必然，与改动大小无关',
            hint: '只改一个字节，签名会不会变？',
            any: ['签名摘要', '必然变', '一定不同', '密码学', '不可避免', '重签', '证书'] },
          { label: '方向与代价：改校验逻辑（便宜但校验可能在 native）、运行时 IO 重定向/不签名安装（中等）、' +
              '改走 Hook（更稳、可回滚）、加固目标上静态改包基本不成立',
            hint: '接下来有哪些路？哪条最省？',
            any: ['hook', '运行时', 'io 重定向', '重定向', '不签名', '绕过校验', '改走', '加固', '放弃静态', '回滚'] },
          { label: '目标带加固时应先判定壳类型：抽取壳下你改的 dex 不是运行时执行的那份，前提就不成立',
            hint: '如果是加固目标，还要先确认什么？',
            any: ['加固', '壳', '抽取壳', '判定', '第19章', '前提不成立', '不是运行时'] }
        ],
        hints: [
          '第一步不是改代码，也不是读校验逻辑，而是做一个"几分钱"的实验来砍掉一半可能性。',
          '"没有异常栈"这个细节本身就是一个很强的信号——想想什么情况下崩溃才会不留栈。'
        ],
        probes: [
          '追问：如果原样往返还退，但你把这个包安装到一台<strong>没装过原版 App</strong> 的设备上却能跑，' +
          '这说明校验依赖了什么信息？',
          '再追问：如果确认校验在 native 层且用了直接系统调用（不走 libc），' +
          '常规的文件 Hook 为什么拦不到？你会怎么调整方案？'
        ],
        model: '<b>完整排查流程（五步，顺序不能乱）：</b><br><br>' +
          '<b>第一步：先做控制变量实验（成本最低，收益最大）。</b><br>' +
          '拿原始 APK，<b>一行代码都不改</b>，只走 <code>apktool d</code> → <code>apktool b</code> → ' +
          '<code>zipalign</code> → <code>apksigner</code> → 卸载 → 安装。<br>' +
          '· <b>同样一闪就退</b> → 结论：问题在"重新签名"这个动作上，<b>和你的改动无关</b>。' +
          '你那一行可以放心留着。<br>' +
          '· <b>不退了</b> → 结论：是<b>你的改动</b>引起的，回头按 27.13 的"自检四问"检查' +
          '（寄存器越界、孤儿 move-result、动过 .registers、删调用漏了配对）。<br>' +
          '<span class="hit">这一步之所以第一，是因为它把"不确定"变成"二选一"，而成本只有一轮编译安装。</span><br><br>' +
          '<b>第二步：读 logcat 的形态。</b><br>' +
          '· 有明确异常栈（<code>VerifyError</code>、<code>NoSuchMethodError</code>、' +
          '<code>ClassCastException</code>、<code>NoClassDefFoundError</code> 等）→ <b>更像你改错了</b>，' +
          '因为校验代码通常不会留下这种"结构性"异常。<br>' +
          '· 只有一行进程退出、没有异常 → <b>更像校验</b>：' +
          '很多校验故意 <code>System.exit(0)</code> / <code>Process.killProcess</code>，不留日志，让你无从下手。<br>' +
          '<b>"静默退出"本身就是一种签名</b>——它说明对方不想让你知道发生了什么。<br><br>' +
          '<b>第三步：接受一个前提——"重新签名必然被发现"。</b><br>' +
          'v1 是逐文件摘要（你改的 dex 摘要一定不同）；<b>v2/v3 是把整个 APK 当作 blob 签名，' +
          '哪怕只改一个字节、甚至只改了 zip 元数据，签名整体作废</b>。' +
          '你只能用自己的密钥重签，于是签名摘要与内置值必然不一致。<br>' +
          '<b>这不是你操作失误，是密码学层面的必然。</b>所以问题不是"怎么不被发现签名变了"，' +
          '而是"对方的校验放在哪一层、我这一层能不能改到它"。<br><br>' +
          '<b>第四步：按层次定位校验在哪（对照本章 27.16 的表）。</b><br>' +
          '· <b>Java 层</b>：<code>PackageInfo.signatures</code> 取摘要、与硬编码值比对，' +
          '或校验 <code>dexcrc</code> / APK 内容摘要 / 路径。<b>最容易改</b>。<br>' +
          '· <b>native 层</b>：so 里自己 <code>open</code> 自己的 APK 读内容算摘要，' +
          '或读 <code>/proc/self/maps</code> 找 base.apk。Java 层 Hook 无效。<br>' +
          '· <b>直接系统调用（不走 libc）</b>：绕过常规的文件 Hook。要更底层的手段。<br>' +
          '· <b>完整性校验 / 三角校验</b>：dex、so、资源的摘要互相牵制，单点突破不成立。<br>' +
          '· <b>隐式校验</b>：不闪退，只悄悄改变部分功能（案例里提到多开定位软件暗改 IP/经纬度）——' +
          '<b>最危险</b>，因为你可能带着错误结论继续往下做几小时。<br><br>' +
          '<b>第五步：选方向，并明确每条路的代价。</b><br>' +
          '① <b>改校验逻辑</b>：最直接、最便宜，但前提是你能找到<b>全部</b>校验点（双份校验时只改一份没用）；<br>' +
          '② <b>让校验读到"原版内容"</b>（IO 重定向 / PM 代理）：不改 APK 结构，' +
          '而是把对手的检查点接管掉；代价是要处理 native 与直接系统调用；<br>' +
          '③ <b>改走运行时路线（Hook）</b>：<b>通常是最稳的</b>——' +
          '它不修改 APK，因此不触发任何完整性校验，而且可随时回滚；<br>' +
          '④ <b>不签名安装 / 核心破解一类手段</b>：绕开"重签"这个动作本身，但依赖设备环境；<br>' +
          '⑤ <b>确认目标带加固时就该换路线</b>：抽取壳下你改的 dex 不是运行时执行的那份，' +
          '<b>前提就不成立</b>——这时候该做的是脱壳读懂逻辑 + 运行时改动，而不是继续和校验硬刚。<br><br>' +
          '<b>追问答案：</b>如果原样往返还退，但装到一台<b>从没装过原版</b>的设备上能跑，' +
          '说明校验依赖"和已安装版本/本地文件对比"这类信息，' +
          '比如读了设备上原本的 base.apk、或者比对某个缓存的摘要——' +
          '这对定位校验实现是非常有价值的线索。<br>' +
          '如果校验在 native 层且用直接系统调用，常规文件 Hook 拦不到，' +
          '因为你的 Hook 挂在 libc 上，而它根本不经过 libc——' +
          '这时候要么在更底层拦截（内核/PLT 层，第 13 章相关思路），要么换整体路线。',
        after: '<p style="margin-bottom:0">这道题的本质是两个字：<b>顺序</b>。' +
          '先把问题范围砍一半（控制变量），再分层定位，最后才投入成本。' +
          '<span class="hit">本章所有工程建议都可以归结为这一条。</span></p>'
      },
      {
        id: 'c27q6', depth: 1, threshold: 0.7,
        q: 'APK 后门植入常见的位置有哪些？' +
          '<b>针对每一个位置，防守方该在哪里拦？</b>' +
          '另外说说：为什么"只做签名校验"是不够的？',
        concepts: [
          { label: 'Application / attachBaseContext 是最早的 Java 执行点，壳和植入方都抢它',
            hint: 'App 里最早能拿到执行权的 Java 位置在哪？',
            any: ['application', 'attachbasecontext', '最早', '启动', '抢先', '入口', 'oncreate'] },
          { label: '其他位置：入口 Activity / 多出来的组件、塞 native so、劫持 dlsym 或改 init_array、' +
              'dex 里插 invoke-static、assets/res 里塞 payload 动态加载',
            hint: '除了改 Application，还有哪些入口？',
            any: ['activity', '清单', 'manifest', 'so', 'dlsym', 'init_array', 'invoke-static', 'dex',
                  'assets', 'payload', '动态加载', 'loadlibrary'] },
          { label: '签名校验防的是"用别的密钥重签"；完整性校验防的是"内容被动过"（dex/so/资源摘要），两者都要',
            hint: '签名和内容摘要分别证明什么？',
            any: ['签名校验', '完整性', '内容摘要', 'dex 摘要', 'so 摘要', '资源', '重签', '两者都要', '不够'] },
          { label: '只做签名校验不够：攻击者可以重签，且校验点若只有一处、一个 if，改掉就绕过了',
            hint: '如果校验只是"失败就 return false"，会发生什么？',
            any: ['可以重签', '重签名', '一处分', '单点', '改掉', 'if', 'return false', '绕过', '容易被改'] },
          { label: '更好的做法：多点 + 交叉 + 延迟校验；让校验结果参与后续解密/运算；把判断放到服务端',
            hint: '什么样的校验设计更难对付？',
            any: ['多点', '交叉', '延迟', '参与运算', '密钥派生', '解出来是错的', '服务端', '三角'] },
          { label: '还能结合：校验下沉到 native、渠道校验、so 内容校验、' +
              'extractNativeLibs=false 让 so 直接从 APK 映射',
            hint: '有哪些"顺手就能拿到"的防线？',
            any: ['native', '下沉', '渠道', 'extractNativeLibs', '映射', '内容校验', '把校验放 native'] }
        ],
        hints: [
          '想一想：一个 APK 要执行代码，必须经过哪几个"必经之路"？植入方就是在这几条路上设卡。',
          '再想一想：加固壳本身用的是同一批入口吗？'
        ],
        probes: [
          '追问：如果 App 的校验代码"校验失败就 return false"，攻击者改一个 if 就绕过了。' +
          '怎么设计才能让"改掉校验"变得没用？',
          '再追问：把 so 的内容校验加上之后，为什么攻击者还有可能绕过？' +
          '而"extractNativeLibs=false"为什么能顺手带来一份额外的防御收益？'
        ],
        model: '<b>先说一个结构性的事实：</b>一个 APK 里能让代码"抢先执行"的入口是有限的，' +
          '而且<b>加固壳用的正是同一批入口</b>。所以"植入位置"和"加固要守的位置"高度重合。<br><br>' +
          '<b>常见植入位置与对应拦截点：</b><br>' +
          '· <b>Application / <code>attachBaseContext</code></b>：App 里最早的 Java 执行点。' +
          '→ 防守：在这里做启动期完整性校验，并把校验结果作为后续解密/鉴权的输入。<br>' +
          '· <b>入口 Activity / 清单里多出来的组件</b>：改 launcher 或新增组件，让自己先跑。' +
          '→ 防守：对清单做组件白名单校验。<br>' +
          '· <b>塞 native so</b>：<code>System.loadLibrary</code> 时加载，<code>JNI_OnLoad</code> / ' +
          '<code>init_array</code> 里做事，比 Java 层隐蔽。' +
          '→ 防守：<b>校验 so 的内容摘要</b>，而不只是签名；' +
          '另外 <code>android:extractNativeLibs=false</code> 时 so 直接从 APK 映射，' +
          '<b>"改 lib 目录下的文件"这条路会自然失效</b>——这是几乎零成本的防御收益。<br>' +
          '· <b>劫持 <code>dlsym</code> / 改 PLT-GOT / 改 <code>init_array</code></b>：不新增文件，' +
          '让已有调用指向自己的实现（第 3 章讲过动态链接机制）。' +
          '→ 防守：校验关键导入函数的行为；native 侧做函数序言/内存校验。<br>' +
          '· <b>改 dex：插一条 <code>invoke-static</code></b>：在启动路径上把控制流引到自己的类。' +
          '→ 防守：<b>dex 内容摘要校验</b>（只校验签名不够，因为攻击者会重签）；' +
          '并且摘要要和"当前签名"绑定，防止换成"自己签的另一份"。<br>' +
          '· <b>assets / res 里塞 payload</b>：躲开代码审计，运行时释放并动态加载（第 26 章）。' +
          '→ 防守：校验资源清单；限制从可写目录动态加载代码。<br>' +
          '· <b>批量注入（产业链形态）</b>：自动化改写 + 自动重签 + 多渠道分发。' +
          '→ 防守：<b>渠道校验</b>，把渠道信息与签名/摘要绑定，让"换个渠道再签一次"失效。<br><br>' +
          '<b>为什么只做签名校验不够：</b><br>' +
          '① <b>签名只证明"是谁签的"，不证明"内容是什么"。</b>' +
          '攻击者用自己的密钥重签一遍，就是一个"签名有效"的新包——' +
          '所以还必须做 <b>内容摘要校验</b>（dex / so / 资源）。<br>' +
          '② <b>如果校验只有一处、且失败只是 <code>return false</code>，那它就是一个 if 的距离。</b>' +
          '正确做法三条：<br>' +
          '&nbsp;&nbsp;· <b>多点 + 交叉 + 延迟</b>：启动时查签名、关键功能前查 dex 摘要、' +
          '登录后拿服务端下发的挑战值再查一次——让单点修改处处矛盾（就是"三角校验"的思路）；<br>' +
          '&nbsp;&nbsp;· <b>让校验结果参与后续运算</b>：把摘要作为密钥派生的一环，' +
          '校验不通过时后面解出来的数据就是错的（对比"失败就 return"，前者会让绕过者"看起来成功了但什么也拿不到"）；<br>' +
          '&nbsp;&nbsp;· <b>能放到服务端的就别放客户端</b>：客户端的一切都可以被改写，只是成本问题。' +
          '把"谁有权限"这类判断放在服务端，是性价比最高的一条。<br><br>' +
          '<b>最后一条防守纪律：</b>发布前做一次"重签名自检"——' +
          '把自己的包重新签名、安装，看 App 会不会拒绝运行。' +
          '<span class="hit">没做过这个自检的 App，等于没设防。</span>'
      }
    ]
  }
};
