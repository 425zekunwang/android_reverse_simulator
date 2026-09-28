/* 第 9 章 · 非标准算法还原（下）
   —— 动态编码表 / 加盐与改常量 / OLLVM / BPO / Frida RPC 自动化
   数据文件：只写 window.CHAPTER，浏览器脚本，禁止 import/require/export。 */

/* —— 本文件内部的表格数据与生成器（纯字符串拼装，便于 stage 逐字节演示） —— */
var B64_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var B64_GEN = 'QWERTYUIOPASDFGHJKLZXCVBNMqwertyuiopasdfghjklzxcvbnm0123456789+/';

/* 生成 64 个内存单元格，按 0x00 / 0x20 两段排列成 memrow（stage 初始渲染用）
   blank=true 时表示「静态视角」——这块内存还没有值（全 0） */
function b64rows(prefix, str, blank, label) {
  var h = '';
  for (var half = 0; half < 2; half++) {
    h += '<div class="memrow"' + (half === 0 ? ' style="margin-top:8px"' : '')
      + '><span class="addr">' + (half ? '+0x20' : label) + '</span>';
    for (var i = half * 32; i < half * 32 + 32; i++) {
      h += '<span class="cell" id="' + prefix + i + '">'
        + (blank ? '00' : str.charAt(i)) + '</span>';
    }
    h += '</div>';
  }
  return h;
}

window.CHAPTER = {
  no: 9,
  title: '非标准算法还原（下）',
  lede: '上一章我们学会了「看到常量就认出算法」。这一章处理三种让常量失效的场景：<strong>动态生成的编码表</strong>（静态根本搜不到那张表）、<strong>加盐与改常量</strong>（一个改输入、一个改内脏）、以及 <strong>OLLVM 混淆</strong>（连指令序列都不可信）。工具箱里补两件重武器：<strong>手动编译带调试符号的 OpenSSL 做对照实验</strong>，和 <strong>Frida RPC 把还原成果封装成自动化接口</strong>。',
  meta: [
    '核心问题：<b>常量搜不到、表搜不到、代码看不懂</b>的时候，算法还原怎么继续往下走？',
    '关键工具：<b>OpenSSL 手动交叉编译 · 动静态内存比对 · BPO 类反混淆插件 · Frida RPC</b>',
    '对手：<b>运行时生成编码表 · 加盐 · 魔改常量表 · OLLVM 控制流平坦化</b>'
  ],

  sections: [
    /* ================= 9.1 ================= */
    {
      h: '9.1',
      title: '把「非标准」拆成三个可分别对付的维度',
      intuition: {
        tag: '直觉模型 · 验尸官看的是内脏',
        body: '<p>法医认尸靠牙齿、骨骼、DNA —— 这些是<b>内脏</b>，外面穿什么衣服都不影响判断。侦察兵认人靠口令 —— <b>口令（输入）</b>改了，人还是那个人。</p>'
          + '<p><b>加盐</b>就是给算法换了件衣服：算法本体一个字节没动，只是喂进去的数据多了一段。<b>魔改常量</b>才是换了内脏：IV、K 表、S 盒被动过，验尸官一看 DNA 就知道「这不是标准 MD5」。</p>'
          + '<p>所以结论只有一句：<b>常量比对永远是你的第一动作</b>。它一次回答两个问题 —— 这是哪个算法，以及它有没有被改内脏。</p>'
      },
      html: T.note('key', '🔑 本章主线', '<p>一个标准化算法（MD5 / SHA / AES / Base64）要变成「非标准」，只有三条路，而且它们<b>可以自由叠加</b>：</p>'
          + '<p>① <b>改输入</b>（加盐 / 改拼接顺序 / 多次哈希）；② <b>改内脏</b>（魔改 IV、K 表、S 盒、编码表）；③ <b>改代码形态</b>（OLLVM 控制流平坦化、指令替换、虚假控制流）。</p>'
          + '<p>三条路的识别手段完全不同，混在一起想就会乱。<b>先分类，再动手</b> —— 这就是本章的全部结构。</p>')
        + T.tbl(['改造维度', '改了什么', '常量比对还能用吗', '你额外要做的事'], [
          ['加盐 ' + T.term('Salt', '盐：一段固定或半固定的附加数据，和真正的输入一起进入哈希。它不改变算法的任何常量。'), '哈希的<b>输入</b>（拼接 / 当 key）', '<span class="hit">✅ 完全能用</span>：IV 与 K 表原封不动', '找出盐的值、长度与拼接位置'],
          ['魔改常量', 'IV / K 表 / S 盒本身', '<span class="miss">⚠️ 能认出「像 MD5」但值对不上</span>', '逐常量比对，反推变换公式（异或？置换？加偏移？）'],
          ['动态生成表', '表的<b>生成方式</b>，而不是表', '<span class="bad">❌ 静态根本搜不到表</span>', '动静态内存比对 + 运行时 dump'],
          ['OLLVM', '控制流与指令序列', '<span class="hit">✅ 常量还在</span>，只是被拆散、被搬进分发器', '用 BPO 类插件 / 符号执行恢复原结构']
        ])
        + T.note('warn', '⚠️ 本章最容易混的一对概念', '<p><b>加盐和改常量是两个不同维度的改造，不能互相推导。</b>加了盐的 MD5 仍然是标准 MD5 —— 你拿网上的 MD5 工具算不对，不是算法被改了，是<b>你喂的输入不对</b>。反过来，改了 K 表的 MD5，无论你怎么加盐都算不出正确结果，因为压缩函数本身就是错的。</p>'
          + '<p>判断口诀：<b>常量没变但密文对不上 → 去找盐；常量变了 → 去比对差异。</b></p>')
        + T.note('', '🧭 本章路线图', '<p>9.2 先给自己造一份带符号的「已知样本」（手动编译 OpenSSL）→ 9.3–9.4 解决动态编码表 → 9.5 讲透加盐 vs 改常量 → 9.6–9.10 处理 OLLVM 与魔改 HMAC → 9.11 用 Frida RPC 把成果变成产能。</p>'),
      after: '<p>读完 9.1，你应该已经能把任何一个「算不对的密文」先归档到三个抽屉之一。<b>归档错了，后面所有力气都会白费</b> —— 比如明明是加盐，你却去 dump 内存找表，那就完全是两个方向。</p>'
    },

    /* ================= 9.2 ================= */
    {
      h: '9.2',
      title: '手动编译 OpenSSL：给自己造一份「已知样本」',
      html: '<p>静态识别算法的本质是<b>比对</b>：目标的指令序列长什么样，标准实现的指令序列长什么样，两者像不像。这个动作有一个前提 —— 你手上得有一份<b>确定无疑的标准实现</b>，而且最好是<b>带调试符号、能反编译出可读代码</b>的。</p>'
        + '<p>很多人直接去网上找一个第三方编译好的 <span class="mono">libcrypto.so</span>。这不好，原因有三个：符号被 strip 过、编译器和优化等级不明、ABI 可能对不上，最重要的是 <b>你不知道它是怎么编出来的</b>。既然要做对照实验，就要做一份<b>完全可控</b>的样本。</p>'
        + T.note('key', '🔑 对照实验的价值', '<p>自己编译出的 <span class="mono">libcrypto.a</span> / <span class="mono">libcrypto.so</span> 同时给你三样东西：</p>'
          + '<p>① <b>已知样本</b> —— 用同样的 NDK、同样的 ABI、同样的优化等级编一段「调用 OpenSSL 做 MD5」的 so，它的反汇编就是标准答案；② <b>调试符号</b> —— 函数名、行号都在，反编译出来可以顺着读；③ <b>可改造</b> —— 你可以故意把 K 表改一个字节重新编，观察「魔改后长什么样」，反向建立经验。</p>')
        + T.note('warn', '⚠️ 别把「编译成功」当成目的', '<p>编译 OpenSSL 只是手段。<b>目的是得到一个可对照的参照系</b>。如果你的目标 so 用的是 BoringSSL、mbedTLS 或自己手写的 MD5，这份 OpenSSL 样本依然有用 —— 因为 MD5 的<b>算法常量与运算结构是公开且唯一的</b>，不同实现的指令序列会因编译器和优化等级不同而不同，但常量一定一样。</p>'),
      term: {
        title: '手动交叉编译 OpenSSL（以 Android arm64 为例）',
        lines: [
          { t: 'd', s: '# 具体路径、NDK 版本、OpenSSL tag 都随环境变化，命令以下方思路为准' },
          { t: 'p', s: 'export NDK=$HOME/Android/Sdk/ndk/25.2.9519653', note: '<b>指定 NDK 根目录。</b>NDK 版本请以你本地实际安装的为准；章节里写的版本号只是示例。' },
          { t: 'p', s: 'export TC=$NDK/toolchains/llvm/prebuilt/linux-x86_64', note: '<b>NDK 自带的 clang 工具链。</b>Linux 主机是 linux-x86_64，macOS 上是 darwin-x86_64。' },
          { t: 'p', s: 'export API=21', note: '<b>目标最低 API。</b>它决定链接哪个版本的 libc / liblog，也决定部分符号是否存在。' },
          { t: 'p', s: 'export TARGET=aarch64-linux-android', note: '<b>目标三元组。</b>arm64 是 aarch64-linux-android，32 位 arm 是 armv7a-linux-androideabi。' },
          { t: 'p', s: 'export CC=$TC/bin/${TARGET}${API}-clang', note: '<b>关键一步：把 CC 指到带 API 后缀的 wrapper 上。</b>少了这个后缀，编译器不会知道你要链哪个 API 级别的库。' },
          { t: 'p', s: 'export AR=$TC/bin/llvm-ar RANLIB=$TC/bin/llvm-ranlib', note: '<b>静态库归档工具。</b>OpenSSL 会产出 libcrypto.a，需要它们来归档。' },
          { t: 'p', s: 'export PATH=$TC/bin:$PATH', note: '<b>把工具链加进 PATH。</b>OpenSSL 的 Configure 会自己去探测 as / nm / strip 等工具。' },
          { t: 'p', s: 'git clone https://github.com/openssl/openssl.git', note: '<b>取源码。</b>用 git 是为了能切到指定 tag，保证样本可复现。' },
          { t: 'p', s: 'cd openssl && git checkout openssl-3.0.x', note: '<b>切分支/tag。</b>具体 tag 号 <span class="pill warn">待核实</span>：不同大版本的 Configure 目标名和选项有差异，请对照该版本的 INSTALL.md。' },
          { t: 'p', s: './Configure android-arm64 -D__ANDROID_API__=21 --prefix=$PWD/out-arm64 no-shared no-tests', note: '<b>配置目标平台。</b><span class="mono">android-arm64</span> 是 OpenSSL 内置的目标名；<span class="mono">-D__ANDROID_API__</span> 是给 C 代码的宏；<span class="mono">no-shared</span> 只要静态库（更好裁剪进目标 so），<span class="mono">no-tests</span> 跳过测试工程、加快编译。32 位用 <span class="mono">android-arm</span>，模拟器用 <span class="mono">android-x86_64</span>。<span class="pill warn">待核实</span>：不同版本可用目标名与选项集合略有出入。' },
          { t: 'p', s: 'make -j$(nproc)', note: '<b>编译。</b>这一步最慢，通常几分钟到十几分钟。报错优先看是不是 CC/AR 没配对。' },
          { t: 'o', s: '... 大量编译输出 ...' },
          { t: 'p', s: 'ls -l libcrypto.a libssl.a', note: '<b>产出物。</b>对照实验只需要 <span class="mono">libcrypto.a</span>（算法都在里面），libssl.a 是 TLS 协议层、通常用不到。' },
          { t: 'o', s: '-rw-r--r-- 1 user user 21M libcrypto.a' },
          { t: 'o', s: '-rw-r--r-- 1 user user 3.4M libssl.a' },
          { t: 'p', s: '$TC/bin/llvm-nm --defined-only libcrypto.a | grep -i -E "MD5_Init|SHA1_Init|AES_set"', note: '<b>验证符号。</b>能看到带名字的函数，说明这份样本可以作为对照基准。<span class="mono">llvm-nm</span> 的选项名随版本略有差异。' },
          { t: 'o', s: '0000000000000000 T MD5_Init' },
          { t: 'o', s: '0000000000000000 T MD5_Update' },
          { t: 'o', s: '0000000000000000 T SHA1_Init' },
          { t: 'p', s: '$CC -shared -fPIC -O2 -g -o libmd5ref.so md5_ref.c -I include libcrypto.a', note: '<b>编一个「已知算法」的对照 so。</b>md5_ref.so 里就一句 <span class="mono">MD5_Update</span> 调用。<span class="mono">-g</span> 保留调试信息 —— 这是我们花力气自己编译的<b>唯一理由</b>。' },
          { t: 'p', s: '$TC/bin/llvm-objdump -d libmd5ref.so | grep -n -i -E "d76aa478|67452301"', note: '<b>把常量搜出来看一眼。</b>这一步是在给「常量比对」这个方法本身做校准：确认标准 MD5 在 arm64 上这些常量长什么样（是小端字面量、还是被拆成两条 mov）。' },
          { t: 'o', s: '  1a2c:  mov  w8, #0xefcdab89     ; IV[1]' },
          { t: 'w', s: '# 目标 so 里同样的片段如果对不上，先怀疑魔改，再怀疑编译器差异' },
          { t: 'p', s: 'ls $TC/bin/ | grep -i -E "pelf|sigmake"', note: '<b>（可选）造 FLIRT 签名。</b>IDA 的 FLAIR 工具集（pelf / plb / sigmake）能把 <span class="mono">libcrypto.a</span> 转成 <span class="mono">.sig</span> 签名库，让 IDA 自动识别目标 so 里被内联的 OpenSSL 函数。<span class="pill warn">待核实</span>：FLAIR 工具名与用法随 IDA 版本变化，且这些工具并不在 NDK 里，需从 IDA 安装目录取。' },
          { t: 'd', s: '# 结论：你现在有了一份「标准答案」。接下来的所有魔改，都是相对它而言的。' }
        ]
      },
      after: T.note('ok', '✅ 对照实验的三个正确用法', '<p>① <b>指令指纹比对</b>：把目标 so 里可疑函数的反汇编，和 libmd5ref.so 里 MD5_Update 的反汇编并排看，看循环结构、看常量加载方式；② <b>常量交叉验证</b>：目标里搜到 <span class="mono">0x67452301</span> 只是第一步，还要确认它周围有没有 <span class="mono">0xefcdab89</span>、<span class="mono">0x98badcfe</span>、<span class="mono">0x10325476</span>，四个都在才能基本确认是 MD5；③ <b>反向工程魔改</b>：把 OpenSSL 的 K 表整体改一个字节重新编一份，看看编译产物有什么变化 —— 你就有了「魔改样本」的经验。</p>')
    },
    /* ================= 9.3 ================= */
    {
      h: '9.3',
      title: '动态编码表：一次「动静态比对」就把它抓出来',
      html: '<p>先看一个具体的场景。某个 App 的请求参数是 <b>Base64</b> 之后的字符串，但你把 <span class="mono">libnative-lib.so</span> 翻了个底朝天，也搜不到 <span class="mono">ABCDEFGHIJKLMNOPQRSTUVWXYZ...</span> 这张表，甚至连 64 字节的字符串常量都没有。</p>'
        + '<p>这时候不要怀疑自己搜错了。<b>大概率这张表根本不在静态文件里</b> —— 它是程序运行时现算出来的。这种表我们叫它 ' + T.term('动态编码表', '不在编译期定义、而在运行时用算法生成的编码表。它的生成过程可能依赖种子（设备号 / 版本号 / 服务端下发），因此不同环境产出的表可能不同。') + '。</p>'
        + T.note('key', '🔑 为什么要运行时生成表', '<p>三个动机，一个比一个实际：</p>'
          + '<p>① <b>让静态特征识别失效</b>：工具与逆向者的第一反应是搜表，表不在文件里，这一招就废了；② <b>让样本之间产生差异</b>：种子可以来自设备 ID、版本号、甚至服务端下发，不同版本/不同设备算出来的表不一样，一份 dump 出来的表在另一个环境里就不通用；③ <b>方便整体换算法</b>：换个种子或换个生成函数，整条链路就变了，实现代码却几乎不用改。</p>'
          + '<p>它的弱点也很明显：<b>表终究要在某一刻变成完整的 64 个字节落在内存里</b>。算得再花哨，最后都是一次内存写入。</p>')
        + T.note('', '🧭 核心手法：动静态比对（diff）', '<p><b>静态看</b>：这块内存在文件里是空的（<span class="mono">.bss</span> 段，全 0），或者是某个无意义的初始值。</p>'
          + '<p><b>动态看</b>：程序跑起来之后，同一个地址变成了一张完整的表。</p>'
          + '<p><b>差值就是你要的东西。</b> 这不是猜测，这是同一块内存在两个时刻的差集。下面这个动图演示的就是这个过程。'),
      stage: {
        title: '动静态内存比对：64 字节 Base64 表是怎么长出来的',
        speed: 1500,
        render: (function () {
          return '<div class="regs" style="margin-bottom:8px">'
            + '<span class="reg" id="sr"><b>种子</b>=（未知）</span>'
            + '<span class="reg" id="sn"><b>已写入</b>=0/64</span>'
            + '<span class="reg" id="sl"><b>表基址</b>=0x7f3a2000</span></div>'
            + '<div class="memgrid">'
            + b64rows('g', B64_GEN, true, '目标内存')
            + b64rows('s', B64_STD, false, '标准表')
            + '</div>';
        })(),
        reset: () => {
          for (var i = 0; i < 64; i++) { SET('g' + i, '00'); CLS('g' + i, 'cell'); }
          for (var j = 0; j < 64; j++) { SET('s' + j, B64_STD.charAt(j)); CLS('s' + j, 'cell'); }
          SET('sr', '<b>种子</b>=（未知）');
          SET('sn', '<b>已写入</b>=0/64');
        },
        steps: [
          {
            run: () => { for (var i = 0; i < 64; i++) CLS('g' + i, 'cell hi'); },
            note: '<b>静态视角：这一整块 64 字节全是 0。</b>它在 <span class="mono">.bss</span> 段里，反编译出来就是 <span class="mono">char tbl[64];</span> —— 没有初值，没有字符串交叉引用。你在 IDA 里用 <span class="mono">Shift+F12</span> 搜字符串，什么也搜不到，就是因为<b>此刻它还不存在</b>。'
          },
          {
            run: () => { SET('sr', '<b>种子</b>=0x5A3C71'); SET('sn', '<b>已写入</b>=0/64 · 生成中'); },
            note: '<b>关键转折：种子出现了。</b>运行时程序先算出一个种子（可能来自设备参数、可能是个写死的常量、也可能是服务端下发）。<b>注意：种子本身不重要，重要的是它触发了后面的写入。</b>你甚至不需要理解生成算法 —— 只要等它算完就行。'
          }
        ].concat([
          '<b>第 1 组：写入 0x00–0x07。</b>最开始的几个字节。此时这块内存「动」起来了 —— 静态看是 0，现在有了真实值。<span class="small muted">（这一步的真实实现通常是查表/位运算，但对我们来说只要看结果）</span>',
          '<b>第 2 组：写入 0x08–0x0F。</b>写入是<b>连续且顺序</b>的，这本身就是一条线索：编码表的生成几乎总是「for i in 0..63」，写成一条直线。',
          '<b>第 3 组：写入 0x10–0x17。</b>到这里已经能看出值域特征了 —— 出现的都是可见 ASCII 字符，范围在 <span class="mono">0x2B</span>–<span class="mono">0x7A</span> 之间。<b>这是 Base64 表最典型的指纹。</b>',
          '<b>第 4 组：写入 0x18–0x1F。</b>再过一半。如果是 AES S 盒，这里的值会散落在整个 0–255 区间；如果是 Base64，永远是可见字符。',
          '<b>第 5 组：写入 0x20–0x27。</b>下半区开始。注意观察：<b>大部分位置的值和标准表不一样</b> —— 这是「自定义换表」而不是「标准 Base64 加盐」。',
          '<b>第 6 组：写入 0x28–0x2F。</b>继续。这时候你在 Frida 里已经可以把它 dump 出来了 —— <b>不用等它写完</b>，因为写入是顺序的。',
          '<b>第 7 组：写入 0x30–0x37。</b>接近尾声。这一段的字符和标准表<b>基本一致</b>（数字区）—— 说明魔改只动了字母部分。',
          '<b>第 8 组：写入 0x38–0x3F。</b>最后 8 个字节落位，包括收尾的 <span class="mono">+</span> 和 <span class="mono">/</span>。'
        ].map(function (txt, k) {
          return {
            run: function () {
              for (var i = k * 8; i < k * 8 + 8; i++) {
                SET('g' + i, B64_GEN.charAt(i));
                CLS('g' + i, 'cell wr');
              }
              SET('sn', '<b>已写入</b>=' + ((k + 1) * 8) + '/64');
            },
            note: txt
          };
        })).concat([
          {
            run: () => { for (var i = 0; i < 64; i++) CLS('g' + i, 'cell wr'); },
            note: '<b>表完整了。</b>64 个字节全部落位。此刻这块内存和静态文件里的样子已经完全不同 —— <b>这个「不同」就是你的战利品</b>。在 Frida 里一条 <span class="mono">Memory.readByteArray(base, 64)</span> 就把它带走了。'
          },
          {
            run: () => {
              for (var i = 0; i < 64; i++) {
                CLS('g' + i, 'cell ' + (B64_GEN.charAt(i) === B64_STD.charAt(i) ? 'wr' : 'rd'));
              }
            },
            note: '<b>逐字符diff：绿色 = 与标准表相同，橙色 = 被换掉了。</b>看分布规律 —— 数字区 <span class="mono">0-9</span> 和收尾的 <span class="mono">+/</span> <span class="hit">完全没动</span>，只有大小写字母被整体重排。<b>这句话就是还原结论的雏形</b>：它是一个「只换字母区」的自定义 Base64。'
          },
          {
            run: () => { SET('sn', '<b>已写入</b>=64/64 · 已 dump'); SET('sl', '<b>表基址</b>=0x7f3a2000 ✓'); },
            note: '<b>收工。</b>现在你手上有一张真实的表，可以直接拿去替换 Python 的 <span class="mono">base64.b64decode</span> 字符映射，或者用 Frida 在目标进程里直接调用它的编码函数。整条链路里，<b>你一行生成算法都没读懂，但表已经拿到了</b> —— 这就是动态比对的威力。'
          }
        ])
      },
      after: T.note('ok', '✅ 这个手法能推广到哪里', '<p>把「64 字节 Base64 表」换成任意一个常量表，方法完全一样：<b>AES S 盒（256 字节）、RC4 S 盒（256 字节）、自定义置换表（任意长度）、异或密钥表</b>。共同点都是：<b>静态是空的，动态是满的；静态是初始值，动态是终值。</b></p>'
        + '<p>实操顺序建议固定下来：① 静态定位那块内存的地址（看它在哪个段、被谁引用）；② 下内存写断点或者在写入函数返回处停住；③ dump 出来；④ 和标准表做 diff。</p>'
        + '<p>如果连「哪块内存」都不知道，就看 9.4 的三个线索。</p>')
    },

    /* ================= 9.4 ================= */
    {
      h: '9.4',
      title: '三个线索：在几百兆内存里找到那张表',
      html: '<p>9.3 有一个前提没说 —— 你<b>怎么知道</b>该盯哪块内存？一个 App 跑起来有几十上百个内存段，几百万个字节，总不能一个个看。</p>'
        + '<p>好在那张表有三个非常硬的指纹，而且<b>可以按代价从低到高逐级过滤</b>，每一步都能砍掉一两个数量级。</p>'
        + '<p>这里用到的核心性质叫 ' + T.term('置换（Permutation）', '一个集合到自身的一一映射：n 个位置放 n 个互不重复的值，恰好覆盖 0..n-1 各一次。编码表与 S 盒在数学上都是置换，这是它们最难伪装的指纹。') + ' —— 编码表在数学上就是这个东西，下面会反复用到。</p>'
        + T.tbl(['线索', '具体特征', '为什么成立', '过滤强度'], [
          ['① 大小特征', '64 字节 / 256 字节的连续可读写内存块', 'Base64 必然是 64，AES S 盒与 RC4 S 盒必然是 256 —— 这是算法定义决定的，改不了', '中等：从百万字节筛到几千块'],
          ['② 置换特征', '块内值互不重复，且恰好覆盖 0..n-1 各一次', '编码表/S 盒在数学上就是一个<b>置换</b>（双射）。这是最强的判据', '极强：通常只剩个位数候选'],
          ['③ 访问特征', '被密集地以 <span class="mono">LDRB [基址, 索引]</span> 形式索引读取', '编码/加密是逐字节循环，对表的访问是<b>热点</b>，调用频率远高于普通数据', '定位到具体函数']
        ]),
      stepper: {
        title: '用 Frida 逐级收窄：从 1284 个内存段到 1 张表',
        lines: [
          {
            code: '<span class="c">// 目标：找到运行时生成的 Base64 表</span>\n<span class="c">// 线索一：大小特征 —— 只看可读写段</span>\n<span class="k">var</span> ranges = <span class="t">Process</span>.<span class="f">enumerateRanges</span>(<span class="s">\'rw-\'</span>);',
            note: '<b>第一步不是搜内容，是缩小战场。</b>编码表在运行时被写入，所以它一定落在<b>可读写</b>的内存里 —— 代码段（r-x）直接排除，只读数据段（r--）也排除。<span class="mono">Process.enumerateRanges</span> 是 Frida 枚举内存段的接口，参数 <span class="mono">\'rw-\'</span> 表示只要可读可写不可执行的段。',
            state: { '候选内存段': '1284', '累计字节': '约 380MB', '阶段': '线索① 大小特征' }
          },
          {
            code: '<span class="k">var</span> cand = [];\n<span class="k">for</span> (<span class="k">var</span> i = <span class="n">0</span>; i &lt; ranges.length; i++) {\n  <span class="k">var</span> r = ranges[i];\n  <span class="k">if</span> (r.size &gt;= <span class="n">64</span> &amp;&amp; r.size &lt;= <span class="n">4096</span>) cand.<span class="f">push</span>(r);\n}',
            note: '<b>只保留「小块的 rw 内存」。</b>理由：堆上的大块（几百 KB 到几 MB）不太可能整块就是一张表；而小于 64 字节的一定放不下。<b>经验区间取 64 到 4096</b> —— 这个上限是经验值，不是定理，遇到大表（比如 SM4 的多个表连着放）要放宽。',
            state: { '候选内存段': '1284 → 213', '累计字节': '约 400KB', '阶段': '线索① 大小特征' }
          },
          {
            code: '<span class="k">function</span> <span class="f">isPermutation</span>(ptr, n) {\n  <span class="k">var</span> seen = <span class="t">new</span> <span class="t">Uint8Array</span>(n);\n  <span class="k">for</span> (<span class="k">var</span> i = <span class="n">0</span>; i &lt; n; i++) {\n    <span class="k">var</span> v = ptr.<span class="f">add</span>(i).<span class="f">readU8</span>();\n    <span class="k">if</span> (v &gt;= n || seen[v]) <span class="k">return</span> <span class="k">false</span>;\n    seen[v] = <span class="n">1</span>;\n  }\n  <span class="k">return</span> <span class="k">true</span>;\n}',
            note: '<b>线索二：置换特征 —— 这是全章最强的一把刀。</b>编码表在数学上是<b>双射</b>：64 个位置放 64 个互不相同的值，恰好覆盖 0..63 各一次（AES S 盒 / RC4 S 盒则是 0..255）。<span class="mono">seen</span> 数组的作用是检测重复；一旦发现重复值或越界值，立刻淘汰。<b>随机内存块通过这个检验的概率极低</b>，所以这一步能砍掉 95% 以上的候选。',
            state: { '候选内存段': '213 → 7', '累计字节': '通过置换检验', '阶段': '线索② 置换特征' }
          },
          {
            code: '<span class="k">var</span> hits = [];\n<span class="k">for</span> (<span class="k">var</span> j = <span class="n">0</span>; j &lt; cand.length; j++) {\n  <span class="k">var</span> p = cand[j].base;\n  <span class="k">if</span> (<span class="f">isPermutation</span>(p, <span class="n">64</span>) || <span class="f">isPermutation</span>(p, <span class="n">256</span>))\n    hits.<span class="f">push</span>(p);\n}',
            note: '<b>把两个尺寸都试一遍。</b>走 64 通道找到 Base64 表，走 256 通道找到 AES S 盒 / RC4 S 盒 / SM4 用表。<b>用 <span class="mono">||</span> 而不是分开两次扫描</b>是工程习惯：一次遍历把两类都收了。',
            state: { '候选内存段': '7 → 3 个地址', '命中': '0x7f3a2000 / 0x7f3b0110 / 0x7f41c040', '阶段': '线索② 置换特征' }
          },
          {
            code: '<span class="c">// 逐个 dump 出来，和标准表做 diff</span>\n<span class="k">var</span> buf = hits[<span class="n">0</span>].<span class="f">readByteArray</span>(<span class="n">64</span>);\n<span class="f">console</span>.<span class="f">log</span>(<span class="f">hexdump</span>(buf));',
            note: '<b>静态 vs 动态比对就发生在这里。</b>把 dump 出来的 64 字节转成字符串，和标准表 <span class="mono">' + B64_STD + '</span> 逐字符对齐。<b>相同的字符保留，不同的字符记下来 —— 那张差异表就是你的自定义映射。</b>',
            state: { '命中': '3 个地址', '当前检查': '0x7f3a2000', '阶段': 'dump + diff' }
          },
          {
            code: '<span class="c">// 线索三：访问特征 —— 看谁在密集索引它</span>\n<span class="k">var</span> base = <span class="f">ptr</span>(<span class="s">\'0x7f3a2000\'</span>);\n<span class="t">Memory</span>.<span class="f">accessMonitor</span>(base, <span class="n">64</span>).<span class="f">on</span>(<span class="s">\'access\'</span>, <span class="k">function</span> (d) {\n  <span class="f">console</span>.<span class="f">log</span>(d.operation, d.from, d.address);\n});',
            note: '<b>第三个线索登场：谁在读它。</b>Frida 提供 <span class="mono">Memory.accessMonitor</span> 来监控一段内存的访问（<span class="pill warn">待核实</span>：该接口可用性与 Frida 版本相关，老版本上没有；等效办法是硬件断点或直接 hook 候选读取函数）。<b>日志里疯狂刷屏的那条读指令，就是编码循环的查表点。</b>',
            state: { '命中': '1 张表', '编码函数': 'sub_2A4C', '阶段': '线索③ 访问特征' }
          },
          {
            code: '<span class="c">// 更快的替代：直接在 Frida 里比对，一次遍历就能定位</span>\n<span class="k">function</span> <span class="f">diffTable</span>(ptr, std) {\n  <span class="k">var</span> s = <span class="s">\'\'</span>;\n  <span class="k">for</span> (<span class="k">var</span> i = <span class="n">0</span>; i &lt; std.length; i++)\n    s += <span class="t">String</span>.<span class="f">fromCharCode</span>(ptr.<span class="f">add</span>(i).<span class="f">readU8</span>());\n  <span class="k">return</span> s;\n}',
            note: '<b>把 diff 做成工具函数，而不是每次手敲。</b>还原工作会反复做同一件事：dump 一块内存 → 转成字符串 → 和标准值比。<b>把它固化成一个函数</b>，下次换目标时只改参数。这是「工程师式逆向」和「脚本小子式逆向」的分水岭。',
            state: { '命中': '1 张表', '工具函数': 'diffTable()', '阶段': '工具化' }
          },
          {
            code: '<span class="c">// 收尾：把表喂给 Python 直接解码</span>\n<span class="c">// import base64</span>\n<span class="c">// std = "ABC...+/";  mine = "QWERTY..."</span>\n<span class="c">// trans = str.maketrans(mine, std)</span>\n<span class="c">// base64.b64decode(s.translate(trans))</span>',
            note: '<b>闭环。</b>拿到自定义表之后，标准库的 Base64 解码器<b>一行都不用重写</b> —— 先用 <span class="mono">maketrans</span> 把自定义表映射回标准表，再交给标准库。这是还原工作的通用收尾姿势：<b>把「非标准」通过一次映射还原成「标准」，然后复用一切现成工具。</b>',
            state: { '命中': '1 张表', '状态': '✅ 已可解码', '阶段': '收尾' }
          }
        ]
      },
      after: T.note('warn', '⚠️ 三个线索的排查顺序不要颠倒', '<p>很多人的第一反应是「下内存写断点看谁在写」。这没错，但<b>代价最高</b>：你得先知道地址，或者对一大片内存下断点，程序会被拖到几乎跑不动。</p>'
        + '<p>正确顺序是：<b>先用②置换特征做一次全内存扫描（几秒钟，纯读，无侵入）→ 得到几个候选地址 → 再用③去看谁在访问</b>。大小特征①只是为了让扫描更快，它是优化不是必需。</p>'
        + '<p>另外一个坑：<b>表的地址会变</b>。堆上分配的表，这次跑在 <span class="mono">0x7f3a2000</span>，下次可能就是别的地方。所以脚本里<b>不要写死地址</b>，要么每次重新扫描，要么 hook 分配点。</p>')
        + T.note('ok', '✅ 这对逆向实战有什么用', '<p>动态编码表是「反自动化」的常见手段，但它防的是<b>静态工具</b>，不防<b>运行时</b>。你只要接受「表在内存里」这个事实，用置换特征一扫，它反而比静态常量更好定位 —— 因为<b>置换这个数学性质几乎不可能被伪装</b>：想让 64 字节看起来不像表，就不能让它是一个置换；可一旦不是置换，编码就错了。</p>')
    },

    /* ================= 9.4L 动手实验：置换检测 ================= */
    {
      h: '9.4L', title: '动手实验：判断一段内存像不像"表"',
      html:
        '<p>定位动态编码表靠的是<b>数学结构</b>，不是字节内容。下面让你亲手做一次判断。</p>',
      lab: {
        title: '实验：检查一段内存是否是"完美置换表"',
        goal: '目标：用结构特征识别表',
        intro:
          '<p>你从内存里 dump 出几段数据。<b>任务：判断哪一段是"表"</b>——' +
          '即长度为 64（Base64）或 256（S 盒）的<b>完美置换</b>（每个值恰好出现一次）。</p>' +
          '<p>粘贴任意字节序列（十六进制），系统会检查它是否满足置换性质。</p>',
        inputs: [
          { key: 'hex', label: '待检查的字节序列（十六进制）',
            hint: '支持空格/逗号/0x 前缀；长度应为 64 或 256 字节',
            ph: '输入或粘贴一段 dump 出的内存',
            type: 'textarea', rows: 4,
            value: '41 42 43 44 45 46 47 48 49 4A 4B 4C 4D 4E 4F 50 51 52 53 54 55 56 57 58 59 5A 61 62 63 64 65 66 67 68 69 6A 6B 6C 6D 6E 6F 70 71 72 73 74 75 76 77 78 79 7A 30 31 32 33 34 35 36 37 38 39 2B 2F' }
        ],
        runLabel: '🔍 检查结构',
        autorun: true,
        run: (v) => {
          const C = window.CRYPTO, L = window.LABX;
          const hex = L.extractHex(v.hex || '');
          if (!hex) return '<div class="lab-msg warn">请粘贴一段十六进制字节序列。</div>';
          const bytes = [];
          for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
          const n = bytes.length;

          let html = '<div class="lab-kv"><span>长度 <b>' + n + '</b> 字节</span>'
            + '<span>不同值 <b>' + new Set(bytes).size + '</b> 种</span></div>';

          const freq = new Array(256).fill(0);
          bytes.forEach(b => freq[b]++);
          const dup = freq.map((c, i) => c > 1 ? { v: i, c } : null).filter(Boolean);
          const missing = freq.map((c, i) => c === 0 ? i : null).filter(x => x !== null);

          const isPerm = (n === 64 || n === 256) && dup.length === 0;
          const fullPerm = n === 256 && isPerm;

          html += '<table class="lab-tbl"><tr><th>检查项</th><th>结果</th><th>判定</th></tr>'
            + '<tr class="' + (n === 64 || n === 256 ? 'same' : 'diff') + '">'
            + '<td>长度是 64 或 256</td><td>' + n + '</td><td>'
            + (n === 64 ? '✅ 典型 Base64 表长度' : n === 256 ? '✅ 典型 S 盒长度' : '❌ 不像标准表')
            + '</td></tr>'
            + '<tr class="' + (dup.length === 0 ? 'same' : 'diff') + '">'
            + '<td>无重复值</td><td>' + dup.length + ' 个重复</td><td>'
            + (dup.length === 0 ? '✅ 通过' : '❌ 有重复，不是置换') + '</td></tr>'
            + '<tr class="' + (isPerm ? 'same' : 'diff') + '">'
            + '<td>值域覆盖</td><td>' + missing.length + ' 个缺失</td><td>'
            + (isPerm ? '✅ 完美置换' : '❌ 不完整') + '</td></tr></table>';

          if (dup.length) {
            html += '<div class="lab-msg fail"><b>❌ 不是置换表</b><div class="lab-note">'
              + '发现 <b>' + dup.length + '</b> 个值重复出现，例如 '
              + dup.slice(0, 5).map(d => '<code>0x' + d.v.toString(16).padStart(2, '0') + '</code>×' + d.c).join('、')
              + '。<br><b>这意味着：</b>它不是编码表/S 盒，可能只是普通数据、或者你 dump 的区间不对。</div></div>';
          } else if (isPerm) {
            const isB64 = n === 64 && bytes.every(b => b >= 0x20 && b < 0x7f);
            const isSbox = n === 256;
            html += '<div class="lab-msg pass"><b>✅ 这是一个完美置换表</b><div class="lab-note">'
              + (isB64 ? '长度 64 且全落在可打印 ASCII 范围 —— <b>高度疑似 Base64 编码表</b>。'
                       : '')
              + (isSbox ? '长度 256 且是完美置换 —— <b>高度疑似 AES S 盒 / 逆 S 盒 / 或 RC4 的 S 盒</b>。'
                        + '<br>进一步区分：AES 的 S 盒是<b>静态常量</b>（存在 .rodata 或解密后放堆上），' +
                          'RC4 的 S 盒是<b>运行时从 0..255 递增序列搅乱出来的</b>。'
                        + '<br>看看这段数据是在文件里还是在堆上 —— 在堆上且附近有 KSA 循环，就是 RC4。'
                       : '')
              + '<br><b>为什么这个判断可靠：</b>随机数据出现完美置换的概率极低' +
              '（256 字节完美置换的概率约为 256!/256²⁵⁶ ≈ 10⁻¹¹¹）。' +
              '所以「是置换」几乎必然意味着它<b>被设计成表</b>。</div></div>';
          } else {
            html += '<div class="lab-msg warn"><b>🟡 部分特征符合，但不完整</b>'
              + '<div class="lab-note">长度不是 64/256，或存在缺失值。'
              + '可能你 dump 的范围偏了（多截或少截了几个字节），或者这不是表。</div></div>';
          }

          html += '<div class="lab-msg key"><b>🔑 这就是定位动态编码表的第二条线索</b>'
            + '<div class="lab-note">回忆 9.4 节的三个线索：<br>'
            + '① <b>大小特征</b>：64 或 256 字节<br>'
            + '② <b>置换特征</b>：值是 0~255 的一个完整置换（无重复、无缺失）← <b>你刚才验证的就是这条</b><br>'
            + '③ <b>访问特征</b>：被密集索引访问（<code>LDRB [基址, 索引]</code>）<br><br>'
            + '正确顺序：<b>先用②做全内存扫描（纯读、无侵入、几秒钟）→ 得到候选地址 → 再用③看谁在访问</b>。' +
            '不要一上来就下内存断点，那会拖死程序。</div></div>';
          return html;
        },
        expected: (v) => {
          const L = window.LABX;
          const hex = L.extractHex(v.hex || '');
          const bytes = [];
          for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
          const n = bytes.length;
          const uniq = new Set(bytes).size;
          const ok = (n === 64 || n === 256) && uniq === n;
          return {
            ok,
            detail: ok
              ? '<b>正确识别：这是完美置换表。</b>长度 ' + n + '、' + uniq + ' 个不同值，无重复。' +
                '<br>「完美置换」是识别编码表/S 盒的<b>结构性判据</b>——它比匹配字节内容更抗魔改，' +
                '因为换表只改顺序，改不了置换这个性质。'
              : '<b>还不是完美置换。</b>长度 ' + n + '，只有 ' + uniq + ' 个不同值。' +
                '<br>要成为表，需要：长度 = 64 或 256，且每个值恰好出现一次。'
          };
        },
        showAnswer:
          '判断标准（两条同时满足）：\n' +
          '  ① 长度 = 64（Base64 表）或 256（S 盒）\n' +
          '  ② 每个值恰好出现一次 —— 即"完美置换"\n\n' +
          '为什么可靠：\n' +
          '  随机 256 字节恰好构成完美置换的概率 ≈ 256!/256^256 ≈ 10^-111\n' +
          '  → 出现置换，几乎必然是被设计成表。\n\n' +
          '实战顺序：\n' +
          '  ① 大小特征：只为缩小扫描范围（优化项）\n' +
          '  ② 置换特征：全内存扫描（纯读、无侵入）← 主判据\n' +
          '  ③ 访问特征：查谁在索引访问（代价最高，最后做）\n\n' +
          '注意：堆上分配的表，地址每次都变 → 脚本里不要写死地址。',
        hint:
          '不要看字节的<b>内容</b>，看它的<b>结构</b>。<br>' +
          '一张表要满足：长度是 64 或 256，而且<b>每个值都有、且只有一个</b>。' +
          '这叫做"置换"（permutation）。<br>' +
          '想想为什么这个性质很难被对手破坏——他换表只能改顺序，改不了"每个值出现一次"这件事。',
        after:
          T.note('ok', '✅ 实验的收获',
            '<p style="margin-bottom:0">你刚才做的判断，是第 9 章最实用的一项技能：' +
            '<b>不看内容、只看结构</b>。<br>' +
            '这个思路可以迁移到很多地方：<br>' +
            '• 找 AES S 盒 → 找 256 字节完美置换<br>' +
            '• 找 Base64 表 → 找 64 字节、全可打印 ASCII 的置换<br>' +
            '• 找 CRC 表 → 找 256 个 uint32、首项等于多项式<br>' +
            '<span class="hit">结构特征比内容特征更抗魔改，因为改内容容易，改结构会破坏算法本身。</span></p>')
      }
    },

    /* ================= 9.5C 实战案例 ================= */
    {
      h: '9.5C', title: '实战案例：五套 Native 防护里的手写密码学与结构指纹',
      case: {
        source: 'kanxue',
        title: '防得最狠的地方往往最不值钱--xx总结',
        date: '2026-7-12',
        author: 'qqqiu',
        target: '一款未指名 App（文中称 T-App），拆出五套 Native 防护体系',
        background:
          '<p>2026 年 7 月的一篇看雪总结帖。目标 App 没有指名，作者称它 <b>T-App</b>，' +
          '一次拆下来<b>五套 Native 防护体系</b>并列存在。</p>' +
          '<p>这篇帖子最反直觉的地方，正是标题那句话：<b>防得最狠的地方往往最不值钱。</b>' +
          'SDK-S 用三层混淆包起来的，是标准的 <code>HMAC-SHA512</code>；' +
          '<code>libN.so</code> 里一行 crypto 库都没链接、纯手写的，是标准的 <code>SHA-1</code>；' +
          '壳-N 用了一整圈保护的，是标准的 <code>CRC32</code>。' +
          '<b>工程上的恶心程度，和数学上的强度完全是两回事。</b></p>' +
          '<p>本节只摘录与第 9 章「非标准算法还原」直接相关的部分：<code>libN.so</code> 的短码算法、' +
          '手写 SHA-1 的实现指纹、Base58 表的越界机关、RSA 公钥的分片与诱饵，以及 HMAC 的结构识别。</p>',
        points: [
          '<code>libN.so</code> 的短码 <code>encode</code> 主流程：<b><code>s1</code> 经 Base64 编码后作 HMAC 密钥 K</b>；统计 <code>s3</code> 的数字个数 <code>cnt</code>；计算 <code>n = atoi(s2) + cnt</code>；把 n 写成大端 8 字节 <code>C = big_endian_u64(n)</code>，做 <code>HMAC-SHA1(K, C)</code> 得到 <code>mac[20]</code>。',
          '<b>RFC 4226 动态截断</b>：<code>off = mac[19] &amp; 0x0F</code>，<code>DT = be32(mac[off:off+4]) &amp; 0x7FFFFFFF</code> —— 这就是 HOTP 标准里的 DT 取值方式，翻 RFC 可以直接对照。',
          '自定义 Base58 展开 5 位：<code>table[(DT // 58^k) % 58]</code>（<code>k = 0..4</code>），末两位再做 <b>GF(2⁸) 混淆 + <code>%100</code> 校验</b>，最终返回 <code>code[0..4] + "%02d"</code>。',
          '<b>手写 SHA-1 的常量指纹</b>：初值 <code>H = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0]</code>，轮常量 <code>K = [0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xCA62C1D6]</code> —— <b>常量是标准的，只是实现是手写的</b>。',
          '作者用 <b>Unicorn</b> 单独跑真实机器码，与 Python <code>hashlib.sha1</code> 对拍，<b>10/10 全中</b>，并且特意覆盖了 SHA-1 padding 最容易出错的 <b>55 / 56 / 64 字节块边界</b>。',
          '<b>Base58 表的越界机关</b>：模数是 58，但固定字母表只有 <b>26 个字符</b>（剔除了 <code>0/O/1/I/L/S/Z/U/A/E</code>）；<code>table[26..57]</code> 这 32 格由 <code>upper(s3)</code> 的前 32 个字符在<b>运行期填充</b>，而 <code>table[58] = 0</code> —— 于是<b>隐式要求 <code>s3</code> 长度 ≥ 32</b>。',
          '越界的实测后果：喂一个 <b>4 字符</b>的 <code>s3</code> 时，本该是 7 位的短码被<b>砍成 3 位</b> —— 因为表格后半段全是 0。',
          '<b>RSA 公钥分片 + 诱饵</b>：<code>getrsakey</code> 拼接「内置前缀 + 内置中段 + 运行期由 Java 传入的尾段」得到 1024-bit RSA SPKI；so 里<b>只硬编码了公钥的前 3/4</b>。',
          '紧挨着那段公钥，还并列存放着另一段 Base64 —— 解码后是<b>高熵的 <code>0xFF</code> / <code>0xFE</code></b>，DER 的长度与结构直接崩，是纯<b>诱饵</b>；<code>getrsakey</code> 全程没有引用这个字段。',
          '<b>JNI 障眼法</b>：静态导出表里的 <code>Java_xxx_TempEncodeUtil_encode</code> 只是一条 thunk（<code>B .real_encode_impl</code>），<b>并不是实际调用入口</b>；真实绑定在 <code>JNI_OnLoad</code> 里通过 <b><code>RegisterNatives</code> 动态注册</b>。',
          '<code>hkey = HEX_UPPER_128( HMAC-SHA512( key = K32, msg = field_A ⧺ field_B ) )</code> —— <b>纯字符串拼接、没有分隔符</b>；密钥在静态 IDB 里显示为全 <code>0xFF</code>（运行时才解密）。',
          '<b>HMAC 指纹识别</b>：<code>init</code> 里一处 <code>memset</code> 用 <b><code>0x36</code></b> 填充一段 <b>128 字节</b>缓冲，另一处用 <b><code>0x5C</code></b> 填充同样长度 —— <b>ipad / opad 是 HMAC 独有的指纹</b>。',
          '<b>填充长度直接给出哈希家族</b>：<b>block size 128 → SHA-512 家族</b>（SHA-256 的 block 只有 64 字节）；同时可排除 BLAKE2、SHA3 这类<b>自带 keying、不需要 ipad/opad</b> 的带密钥哈希。',
          '进一步交叉验证：搜标准 SHA-512 初始向量的首字（小端）命中一处地址，<b>紧邻的就是 80 个 64 位轮常量表</b>；输出 <b>64 字节</b>，因此排除 SHA-384（48 字节）。',
          '<b>工程恶心度 ≠ 数学强度</b>：SDK-S 三层混淆包里是标准 <code>HMAC-SHA512</code>，<code>libN.so</code> 手写实现的是标准 <code>SHA-1</code>，壳-N 用的是标准 <code>CRC32</code>。'
        ],
        method: [
          '先定"是不是标准算法"，再决定要不要逆：<code>libN.so</code> 没链接任何 crypto 库，但常量一比对就认出是标准 SHA-1 / HMAC / RFC 4226 —— <b>手写不等于非标准</b>。',
          '按调用顺序读 <code>encode</code>：<code>s1</code> 过 Base64 当 HMAC 密钥 → 数 <code>s3</code> 的数字个数 → <code>n = atoi(s2) + cnt</code> → <code>C = big_endian_u64(n)</code> → <code>HMAC-SHA1(K, C)</code>。',
          '认出动态截断：<code>off = mac[19] &amp; 0x0F</code>、<code>DT = be32(mac[off:off+4]) &amp; 0x7FFFFFFF</code> —— 落到 RFC 4226，直接照标准实现。',
          '展开 Base58 与校验：<code>table[(DT // 58^k) % 58]</code>（<code>k = 0..4</code>）取 5 位，末两位 GF(2⁸) 混淆后 <code>%100</code>，拼成 <code>code[0..4] + "%02d"</code>。',
          '用 Unicorn 做机器码对拍：把真实实现单独跑起来，与 Python <code>hashlib.sha1</code> 比对，<b>10/10 全中</b>，并专门覆盖 SHA-1 padding 的 <b>55 / 56 / 64 字节</b>边界。',
          '复现越界机关：故意喂 4 字符的 <code>s3</code>，观察本该 7 位的短码被砍成 <b>3 位</b>，确认 <code>table[26..57]</code> 的运行期填充依赖 <code>s3</code> 长度 ≥ 32。',
          '识破并排诱饵：<code>getrsakey</code> 拼前缀 + 中段 + Java 传入尾段得到 1024-bit SPKI，so 内只硬编码前 3/4；旁边那段 Base64 解码后是 <code>0xFF</code> / <code>0xFE</code> 高熵垃圾，DER 结构直接崩，且从未被引用。',
          '绕过 JNI 障眼法：静态导出 <code>Java_xxx_TempEncodeUtil_encode</code> 只是 <code>B .real_encode_impl</code> 的 thunk，真实入口要看 <code>JNI_OnLoad</code> 里的 <code>RegisterNatives</code>。',
          '认 HMAC 家族：<code>init</code> 里 <code>0x36</code> 填充 128 字节、<code>0x5C</code> 填充同样长度 → ipad/opad 指纹 + block size 128 → SHA-512 家族。',
          '交叉验证：搜 SHA-512 初始向量首字（小端）命中一处，紧邻即 80 个 64 位轮常量表；输出 64 字节排除 SHA-384。'
        ],
        result:
          '<p>五套防护里与算法相关的部分基本被拆开：短码算法的主流程、SHA-1 手写实现的机器码、Base58 的越界机关、' +
          'RSA 公钥的分片方式与诱饵字段、以及 <code>hkey</code> 的 HMAC-SHA512 结构，都拿到了确定结论。</p>' +
          '<p>验证手段是两头发力：一头用 <b>Unicorn 跑真实机器码、与 Python <code>hashlib.sha1</code> 对拍 10/10 全中</b>（还专门覆盖了 55 / 56 / 64 字节的 padding 边界）；' +
          '另一头靠<b>常量与结构指纹</b>把算法家族钉死（<code>0x36</code>/<code>0x5C</code> 长度 128 → SHA-512，SHA-512 初始向量首字紧邻 80 个 64 位轮常量）。</p>' +
          '<p>但作者<b>刻意留了一个开放问题</b>：短码引擎的两位校验算法没能完全还原。</p>',
        terms: ['HMAC-SHA1', 'RFC 4226', '动态截断 DT', 'Base58', 'GF(2⁸)', 'SHA-1 padding', 'Unicorn', 'RegisterNatives', 'JNI_OnLoad', 'ipad/opad', 'HMAC-SHA512', 'SPKI', '诱饵字段'],
        limits:
          '<p>这篇帖子的价值有一半在<b>它承认了什么没做完</b>，必须如实标注：</p>' +
          '<p>① <b>短码引擎的两位校验算法没有完全还原</b>。那个 GF(2⁸) 混淆是个黑盒，带跨 lane 重排、<b>不是逐列的标准 MixColumns</b>，' +
          '目前只能拿 <b>Unicorn 当 oracle 顶替</b>（5 组样本 5/5 命中），<b>尚未转成纯 Python 等价实现</b>。' +
          '作者的原文态度是：<b>不打算硬凑一个"看起来解决了"的结论，这是这个库唯一一处开放问题，留着。</b></p>' +
          '<p>② <b>加固壳的二级 payload 真身尚未取得</b>。</p>' +
          '<p>③ <b>RSA 公钥拼接过程中，有一个来源不明的运行时参数未确认</b> —— 尾段确实由 Java 传入，但具体是什么还没坐实。</p>' +
          '<p>④ 作者<b>自我纠正过一次误判</b>：最初外推 <code>hkey</code> 的输出「也是同样的字母编码、且长度 32 字节」，<b>完全错误</b> —— ' +
          '真相是输出 <b>64 字节</b>且用<b>标准十六进制</b>格式化。</p>',
        analysis:
          '<p><b>本课第 9 章的元原则是「把非标准拆成三个可分别对付的维度」，以及一句更狠的判据：结构特征比内容特征更抗魔改。</b>' +
          '这个案例把两句话都演了一遍，而且给出了本章最反直觉的一个结论。</p>' +
          '<p><b>第一，「手写密码学」不等于「非标准算法」。</b>' +
          '<code>libN.so</code> 一行 crypto 库都没链接，看上去完全符合"非标准"的直觉 —— ' +
          '但它实现的是<b>标准 SHA-1 + 标准 HMAC + 标准 RFC 4226</b>。' +
          '所以 <code>H = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0]</code> 和 ' +
          '<code>K = [0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xCA62C1D6]</code> 这两张表一摆出来，算法身份当场就定了 —— ' +
          '<b>手写改变的只是代码的形态，改变不了常量。</b>' +
          '这正是第 8 章「常量特征比对」的用武之地：<b>判断一个算法是不是标准算法，看的是常量，不是看它有没有 import 加密库。</b></p>' +
          '<p><b>第二，HMAC 的 <code>0x36</code> / <code>0x5C</code> 填充长度，是识别哈希家族的钥匙。</b>' +
          '这条比"找 S 盒"通用得多：S 盒只有 AES 有，而 ipad/opad 是所有 HMAC 实现都必须写的两个填充字节。' +
          '看到 <code>0x36</code> 和 <code>0x5C</code> 各填一整块 → 确认是 HMAC；' +
          '再看这块是 <b>128 字节还是 64 字节</b> → <b>128 直接锁定 SHA-512 家族</b>（SHA-256 的 block 只有 64）。' +
          '作者的排除法同样干净：<b>BLAKE2、SHA3 这类带密钥哈希自带 keying，根本不需要 ipad/opad，所以可以先排除掉。</b>' +
          '最后用 SHA-512 初始向量首字（小端）命中一处地址、紧邻 80 个 64 位轮常量表来交叉验证，用输出 64 字节排除 SHA-384 —— ' +
          '<b>四步全部落在结构特征上，一步都没进压缩函数。</b>' +
          '这就是本章说的「结构特征比内容特征更抗魔改」：<b>常量可以被换掉，但 HMAC 的两次哈希结构和 block size 改不掉，改了就不是 HMAC 了。</b></p>' +
          '<p><b>第三，Base58 表越界那个机关说明：算法还原不只是算对，还要理解边界行为。</b>' +
          '模数明明写着 58，固定字母表却只有 26 个字符，<code>table[26..57]</code> 全靠 <code>upper(s3)</code> 的运行期填充，' +
          '<code>table[58] = 0</code> 于是<b>隐式要求 <code>s3</code> 长度 ≥ 32</b>；' +
          '喂 4 字符时，本该 7 位的短码被砍成 <b>3 位</b>。' +
          '这不是 bug，是<b>设计里没写出来的前置条件</b>。' +
          '它正是本章「动态编码表」的现实变体 —— 9.1 讲的表是运行期生成的，这里连表的<b>长度约束</b>都是运行期由输入决定的。' +
          '实战含义很直接：<b>你按标准 Base58 实现出来会"大部分时候对、偶尔不对"，而那个偶尔才是别人抓你的地方。</b></p>' +
          '<p><b>第四，最值得学的其实是作者的自我纠正。</b>' +
          '他先外推了一个结论 —— <code>hkey</code> 的输出「也是同样的字母编码、长度 32 字节」—— 后来推翻：' +
          '真相是 <b>64 字节、标准十六进制</b>。他的总结是<b>「密钥的存储编码与最终输出的序列化编码是两套独立机制，不能互相外推」</b>。' +
          '这一点极容易踩：<b>密钥在静态 IDB 里显示为全 <code>0xFF</code>（运行时才解密）、传输用 Base58、<code>hkey</code> 用大写十六进制 —— ' +
          '同一个库里三种编码并存，它们之间没有任何推导关系。</b>' +
          '<span class="hit">识别算法时必须区分「数据本身」和「数据的表示形式」：一个是数学对象，一个是序列化格式，前者决定能不能复现，后者只是搬运方式。</span></p>' +
          '<p>最后回到标题那句话。<b>工程恶心度不等于数学强度</b> —— SDK-S 三层混淆包着标准 <code>HMAC-SHA512</code>，' +
          '<code>libN.so</code> 手写实现着标准 <code>SHA-1</code>，壳-N 保护着标准 <code>CRC32</code>。' +
          '<b>混淆抬高的是你读代码的成本，不是算法本身的强度；而成本是可以被"认出结构、跳过实现"绕开的。</b>' +
          '反倒是作者留着没解的那处 GF(2⁸) 校验 —— 真正的自创数学 —— 才是全篇最难的地方，' +
          '而他选择用 Unicorn 当 oracle 先顶住、<b>不硬凑一个"看起来解决了"的结论</b>。' +
          '这个取舍本身也是本章的一部分：<b>还原工作的目的是拿到可用的等价实现，不是把每一行都读懂。</b></p>',
        link: 'https://bbs.kanxue.com/thread-291974.htm',
        linkNote: '看雪论坛原创帖'
      }
    },

    /* ================= 9.5 ================= */
    {
      h: '9.5',
      title: '加盐 vs 改常量：一个改输入，一个改内脏',
      html: '<p>这是本章<b>最重要的思维模型</b>，值得单独用一节讲透。新手最常见的错误是：算出来的密文和标准 MD5 对不上，就断言「算法被魔改了」。<b>大概率不是。</b></p>'
        + '<p>算不对只有两种可能，而且它们指向完全不同的排查动作：</p>'
        + '<p>第一种叫 ' + T.term('加盐（Salt）', '往哈希的输入里额外掺入的一段数据。它不改变算法的任何常量，只改变输入，因此常量比对依然能认出算法本体。') + '，第二种叫 ' + T.term('魔改常量', '直接修改算法的内脏：IV、K 表、S 盒、编码表。后果是压缩函数本身变了，无论喂什么输入都算不出标准结果。') + '。</p>'
        + T.note('key', '🔑 一句话记住区别', '<p><b>盐不改变算法的常量表。</b>MD5 加了盐，IV 还是 <span class="mono">0x67452301 0xefcdab89 0x98badcfe 0x10325476</span>，K 还是那 64 个，K[0] 还是 <span class="mono">0xd76aa478</span>，K[63] 还是 <span class="mono">0xeb86d391</span>。<b>常量比对依然能一眼认出「这是 MD5」</b>，剩下的问题只是：它到底吃了什么进去。</p>'
          + '<p>而魔改常量是动了算法的内脏：压缩函数本身变了，<b>无论你喂什么输入都算不出标准结果</b>。<span class="pill warn">注意</span>这种改造下，常量比对仍然有价值 —— 它能告诉你「这像 MD5 但被改过」，而不是「这不是 MD5」。</p>'),
      stage: {
        title: '两种改造的并排对照',
        speed: 1800,
        render: '<div class="grid2">'
          + '<div class="card"><div class="card-title">① 加盐 —— 改的是<b>输入</b></div>'
          + '<div class="regs">'
          + '<span class="reg" id="lA"><b>IV0</b>=67452301</span>'
          + '<span class="reg" id="lB"><b>IV1</b>=efcdab89</span>'
          + '<span class="reg" id="lC"><b>IV2</b>=98badcfe</span>'
          + '<span class="reg" id="lD"><b>IV3</b>=10325476</span></div>'
          + '<div class="regs" style="margin-top:8px">'
          + '<span class="reg" id="lK"><b>K[0]</b>=d76aa478</span>'
          + '<span class="reg" id="lI"><b>输入</b>=&quot;hello&quot;</span></div>'
          + '<div class="note" id="lV" style="margin-top:10px"><p style="margin:0">等待开始…</p></div></div>'
          + '<div class="card"><div class="card-title">② 改常量 —— 改的是<b>内脏</b></div>'
          + '<div class="regs">'
          + '<span class="reg" id="rA"><b>IV0</b>=67452301</span>'
          + '<span class="reg" id="rB"><b>IV1</b>=efcdab89</span>'
          + '<span class="reg" id="rC"><b>IV2</b>=98badcfe</span>'
          + '<span class="reg" id="rD"><b>IV3</b>=10325476</span></div>'
          + '<div class="regs" style="margin-top:8px">'
          + '<span class="reg" id="rK"><b>K[0]</b>=d76aa478</span>'
          + '<span class="reg" id="rI"><b>输入</b>=&quot;hello&quot;</span></div>'
          + '<div class="note" id="rV" style="margin-top:10px"><p style="margin:0">等待开始…</p></div></div>'
          + '</div>',
        reset: () => {
          ['lA', 'lB', 'lC', 'lD', 'lK', 'rA', 'rB', 'rC', 'rD', 'rK'].forEach(function (id) { CLS(id, 'reg'); });
          CLS('lI', 'reg'); CLS('rI', 'reg');
          SET('lI', '<b>输入</b>=&quot;hello&quot;');
          SET('rI', '<b>输入</b>=&quot;hello&quot;');
          SET('lK', '<b>K[0]</b>=d76aa478');
          SET('rK', '<b>K[0]</b>=d76aa478');
          CLS('lV', 'note'); SET('lV', '<p style="margin:0">等待开始…</p>');
          CLS('rV', 'note'); SET('rV', '<p style="margin:0">等待开始…</p>');
        },
        steps: [
          {
            run: () => { SET('lV', '<p style="margin:0">起点：两边都是<b>标准 MD5</b>，常量完全一致。</p>'); SET('rV', '<p style="margin:0">起点：两边都是<b>标准 MD5</b>，常量完全一致。</p>'); },
            note: '<b>先把基准摆好。</b>左右两边初始状态完全相同：同样的 4 个 IV、同样的 K 表、同样的输入 <span class="mono">&quot;hello&quot;</span>。接下来的每一步改造，都要盯住「哪一个格子变了」。'
          },
          {
            run: () => { SET('lI', '<b>输入</b>=&quot;x9$k&quot;+&quot;hello&quot;'); CLS('lI', 'reg changed'); },
            note: '<b>左边动手了 —— 但它动的是输入，不是常量。</b>盐 <span class="mono">&quot;x9$k&quot;</span> 被拼在明文前面（前缀盐）。注意看左侧那 5 个常量格子：<b>一个都没变。</b>'
          },
          {
            run: () => { ['lA', 'lB', 'lC', 'lD', 'lK'].forEach(function (id) { CLS(id, 'reg changed'); }); SET('lV', '<div class="note-h">✅ 常量区：完全未变</div><p>IV / K 表与标准 MD5 逐字节一致 → <b>算法本体没被改</b>。</p>'); CLS('lV', 'note ok'); },
            note: '<b>关键观察：常量一个都没变。</b>高亮是「被验证过」的意思，不是「被修改过」。这一步在实战里就是把目标 so 里搜到的常量，和标准表逐个对齐 —— 对齐了，就锁定「算法是标准的」。'
          },
          {
            run: () => { SET('lV', '<div class="note-h">✅ 结论：标准 MD5 + 前缀盐</div><p>下一步唯一要做的就是<b>把盐找出来</b>：长度、内容、拼接位置。</p>'); },
            note: '<b>左边的排查动作被唯一化了。</b>既然算法没变，唯一的未知量就是输入。盐一般有三个落点：<b>写死在 Java 层</b>（字符串常量，最好找）、<b>写死在 native 层</b>（跟着密文一起进 so）、<b>运行时计算</b>（设备号 / 时间戳派生，最难）。'
          },
          {
            run: () => { SET('rK', '<b>K[0]</b>=0x1a2b3c4d'); CLS('rK', 'reg changed'); },
            note: '<b>右边动手了 —— 它改的是常量表本身。</b>本应是 <span class="mono">0xd76aa478</span> 的 K[0] 变成了 <span class="mono">0x1a2b3c4d</span>。<b>这就是魔改（magic modification）。</b>这里用的是一个虚构值做演示；真实样本里常见的手法是整体加一个偏移、整体异或某个值、或者交换若干项。'
          },
          {
            run: () => { SET('rV', '<div class="note-h">⚠️ 常量区：被替换</div><p>K[0] 对不上标准值 → <b>压缩函数已被改动</b>，标准工具算不出结果。</p>'); CLS('rV', 'note warn'); },
            note: '<b>注意右边的输入始终是干净的 <span class="mono">&quot;hello&quot;</span>。</b>这说明右边的问题<b>不可能靠加盐/去盐解决</b>：盐是输入侧的补救，而错误发生在算法内部。这就是「找错方向就永远走不通」的典型场景。'
          },
          {
            run: () => { SET('rV', '<div class="note-h">⚠️ 结论：魔改 MD5</div><p>下一步要做的动作完全不同：<b>逐常量比对，反推变换公式</b>。</p>'); CLS('rV', 'note bad'); },
            note: '<b>右边的排查动作也被唯一化了。</b>要做的是：把 64 个 K 值全部 dump 出来，和标准表做逐项比对，找出规律 —— 是加了常数？异或了常数？还是整表被重排？<b>找到规律就能写出等价的还原实现。</b>'
          },
          {
            run: () => { SET('lV', '<div class="note-h">✅ 加盐：常量没变，去找盐</div><p>常量比对 → 全部命中标准值 → 算法是标准的。</p>'); CLS('lV', 'note ok'); },
            note: '<b>对照总结。</b>左边和右边的<b>第一动作是同一个</b>：搜常量、比对。但比对的结果把后续路径<b>劈成了两条完全不重叠的路</b>。这就是为什么 9.1 说「先分类，再动手」。'
          }
        ]
      },
      after: T.tbl(['你看到的', '说明什么', '下一步做什么'], [
        ['IV/K 全对，但密文不对', '算法标准，<b>输入被加了东西</b>', '找盐：字符串搜索 / hook 输入拼接点 / 抓调用栈'],
        ['IV/K 有部分对不上', '<b>魔改常量</b>，算法内脏被改', 'dump 全部常量，逐项 diff，反推变换公式'],
        ['IV 对但 K 表长度不是 64', '可能不是 MD5，<b>再看别的特征</b>', '转去比对 SHA 系列常量或 AES S 盒'],
        ['一个常量都搜不到', '可能被混淆 / 被拆分 / 是动态生成的', '走 9.3、9.4 的内存比对路线，或看 9.6 的 OLLVM']
      ])
        + T.note('', '🧩 顺便记住盐的几种常见形态', '<p><b>前缀盐</b> <span class="mono">hash(salt + input)</span>；<b>后缀盐</b> <span class="mono">hash(input + salt)</span>；<b>中缀</b> <span class="mono">hash(a + salt + b)</span>（最难找，因为盐夹在中间）；<b>HMAC 式</b> <span class="mono">HMAC(key, input)</span>（key 就是盐，但算法结构本身变了，见 9.7）；<b>多次哈希</b> <span class="mono">hash(hash(input))</span>（严格说不算盐，但同样让结果对不上）。</p>'
          + '<p><b>识别拼接位置的办法</b>：hook <span class="mono">MD5_Update</span> / 对应的 update 函数，看它被调用几次、每次的 buffer 内容是什么。多次调用往往意味着「先喂盐再喂明文」。</p>'),
      quiz: {
        id: 'q9-1', chapter: 9, answer: 2,
        stem: '你在目标 so 里搜到了 <code>0x67452301</code>、<code>0xefcdab89</code>、<code>0x98badcfe</code>、<code>0x10325476</code> 四个 IV，K 表也完整且与标准 MD5 一致。但你用标准 MD5 对明文 <code>&quot;hello&quot;</code> 求哈希，和目标 App 输出的密文对不上。此时<b>最合理</b>的下一个动作是？',
        options: [
          { t: '判定算法被魔改了，去逐项比对 K 表找差异', why: 'K 表已完整且与标准一致，此时去比对差异必然一无所获。这是没区分「加盐」和「改常量」两个维度的典型误判。' },
          { t: '换一个哈希算法库再试一次，怀疑是工具实现差异', why: 'MD5 是确定性的，任何正确实现的结果都一样。换库不会改变结果，只会浪费时间。' },
          { t: '判定算法是标准 MD5，转去找盐（输入被拼接了什么）', why: '正确。常量全部命中说明算法本体标准，对不上只可能是输入不同 —— 去找前缀/后缀/中缀盐，或 hook update 函数看调用了几次、每次喂了什么。' },
          { t: '怀疑是动态生成的常量表，去做内存动静态比对', why: '动态生成表会导致「搜不到常量」，而这里常量明明搜到了且完全正确，所以不适用这条路线。' }
        ],
        explain: '<b>完整解析。</b>常量比对一次回答两个问题：<b>这是什么算法</b>、<b>它的内脏有没有被动过</b>。四个 IV 加上完整的 K 表全部命中标准值，说明第二问的答案是「没被动过」——<b>算法就是标准 MD5</b>。</p><p>既然算法标准、输入却是 <span class="mono">&quot;hello&quot;</span> 时结果对不上，那么唯一的变量就是<b>输入不是 &quot;hello&quot;</b>。这就是盐。<b>盐不改变任何常量</b>，它只是在进哈希之前往数据里掺了东西。</p><p>这也解释了为什么很多人会在这里卡住：他们看到「算不对」就本能地怀疑算法被改，于是去 dump 常量、去比对 K 表、去找魔改规律 —— 方向从一开始就错了。正确的排查顺序永远是 <b>先确认常量 → 常量对就查输入 → 常量不对才查算法</b>。</p>'
      }
    },

    /* ================= 9.6 ================= */
    {
      h: '9.6',
      title: 'MD5 / SHA1 的加盐、改常量，以及叠加的 OLLVM',
      html: '<p>把 9.5 的思维模型落到最常见的两个算法上。先明确<b>标准常量</b>长什么样 —— 这些值必须背下来，它们是所有比对的基准。</p>'
        + T.grid(2, [
          '<div class="card"><div class="card-title">MD5 的识别基准</div><p class="mono small">IV = 67452301 efcdab89 98badcfe 10325476<br>K[0] = d76aa478<br>K[63] = eb86d391<br>共 64 个 K 常量</p><p>四个 IV 全中 + K 表命中 = <b>基本确认 MD5</b>。K 常量是按 <span class="mono">floor(abs(sin(i+1)) × 2^32)</span> 生成的，没有简单规律，所以很难伪造成别的样子。</p></div>',
          '<div class="card"><div class="card-title">SHA-1 的识别基准</div><p class="mono small">IV = 67452301 EFCDAB89 98BADCFE 10325476 C3D2E1F0<br>K = 5A827999 / 6ED9EBA1 / 8F1BBCDC / CA62C1D6</p><p><b>注意前四个 IV 与 MD5 完全相同</b> —— 这是最容易误判的地方。区分靠第五个 IV <span class="mono">0xC3D2E1F0</span> 和四个轮常量（各用于 20 轮）。</p></div>'
        ])
        + T.note('warn', '⚠️ 别看到 67452301 就喊 MD5', '<p><span class="mono">0x67452301</span> 这个值在 MD4 / MD5 / SHA-1 / SHA-256（前 32 位不同，见下）里都出现，它来自 MD4 的初始向量设计。<b>必须看完整的 IV 组合：</b></p>'
          + '<p>MD5 是 4 个 32 位字；SHA-1 是 5 个（多一个 <span class="mono">C3D2E1F0</span>）；SHA-256 是 8 个，前两个就变了 —— <span class="mono">6a09e667</span>、<span class="mono">bb67ae85</span>、<span class="mono">3c6ef372</span>、<span class="mono">a54ff53a</span>、<span class="mono">510e527f</span>、<span class="mono">9b05688c</span>、<span class="mono">1f83d9ab</span>、<span class="mono">5be0cd19</span>（这些是前 8 个素数平方根的小数部分，与 MD 系列的小端字面量风格完全不同）。</p>')
        + T.card('SHA-256 的旁证：K 表有 64 个，第一个是 0x428a2f98', '<p>SHA-256 的 64 个轮常量取目前 64 个素数立方根的小数部分，第一个是 <span class="mono">0x428a2f98</span>。它的 IV 八个字和 MD5/SHA-1 风格迥异，<b>只要扫到其中两三个就能确认</b>。</p><p class="small muted">注：SHA-256 的部分 IV 常量在不同文档中因大小端书写习惯会有字节序差异，比对时<b>把两种字节序都试一遍</b>，不要因为字节序不同就否定判断。</p>')
        + T.note('key', '🔑 加盐的四种落地位置（按排查难度排序）', '<p>① <b>Java 层字符串常量</b>：<span class="mono">const-string</span> 指令直接引用，<span class="mono">grep</span> 一下 dex 就能找到，最容易；② <b>native 层字符串常量</b>：so 里明文的 salt，搜字符串能出，但可能被拆成多段拼接；③ <b>native 层计算得到</b>：由包名、版本号、设备 ID 派生，需要顺着数据流往回跟；④ <b>服务端下发</b>：本地只有算法没有盐，这种情况要么抓包拿盐，要么在 Frida 里直接调它的加密函数（见 9.9）。</p>')
        + T.note('', '🧭 当 OLLVM 和加盐同时出现', '<p>现实中的加固 App 不会只用一招。<b>典型组合是：MD5 + 加盐 + OLLVM 控制流平坦化</b>。这时候你会同时遇到两个困难：常量被拆散藏在分发器里搜不齐，盐又不知道是什么。</p>'
          + '<p><b>正确的拆解顺序是「先解混淆、再谈算法」</b>。因为混淆只影响<b>代码形态</b>，不影响<b>数据与常量</b> —— 一旦用 BPO 类插件把控制流还原回接近原始的结构，常量比对、盐查找这些常规手法就全部重新可用了。<b>不要试图在混淆代码上做算法分析</b>，那是在跟编译器打架。</p>'),
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一',
            scenario: '<b>情境：</b>你要还原一个 App 的签名算法。反编译 so 后发现：搜 <span class="mono">0x67452301</span> 能搜到，但只有 2 个 IV，另外两个 IV 找不到；K 表也只搜到了 37 个。函数控制流是典型的 <span class="mono">while(1) switch(state)</span> 平坦化结构，state 变量被反复赋值。<b>你的第一步应该做什么？</b>',
            choices: [
              { t: '先补全缺失的常量：用脚本暴力搜整个 so 的字节，把 64 个 K 逐个对上', next: 'n1' },
              { t: '先解 OLLVM 混淆，等控制流恢复正常结构后再做常量比对与算法分析', next: 'n2' },
              { t: '直接上 Frida hook 这个函数，dump 出运行时内存里所有常量', next: 'n3' },
              { t: '判定算法不是 MD5，转去比对 SHA 系列常量', next: 'n4' }
            ]
          },
          n1: { label: '选A', terminal: true, verdict: 'bad', verdictTitle: '方向可理解，但在混淆代码上做常量比对效率极低', result: '<b>认知根源：把「常量必须在指令里出现」当成了前提。</b>在 OLLVM 保护下，常量的加载会被打散 —— 可能被拆成高低位分别 mov 再 or 回来、可能被 XOR 混淆后在运行时还原、可能被塞进常量池由分发器统一读取。你硬搜字节，能搜到一部分（因为有些确实还是明文），但<b>永远凑不齐</b>，而且凑不齐时你无法判断是「被混淆了」还是「这算法真的不用这个常量」。</p><p><b>正确做法</b>：先解混淆，让代码结构恢复，常量自然会以正常形态出现。混淆与算法分析是<b>先后关系</b>，不是并行关系。</p>' },
          n2: { label: '选B', terminal: true, verdict: 'good', verdictTitle: '正确：先解混淆，再谈算法', result: '<b>这是本章最想让你建立的条件反射。</b>OLLVM 只改变代码的<b>形态</b>（控制流被打散、指令被替换、虚假分支被插入），不改变代码的<b>语义与数据</b>。所以：</p><p>① 混淆层面的事，用反混淆工具/插件解决，这是一次性的、机械的工作；② 算法层面的事（常量比对、盐查找、差分分析），必须在结构清晰的代码上做。<b>两件事混在一起做，等于同时解两个未知数。</b></p><p>补一句：解完混淆后，之前「搜不全的常量」大概率会全部现身 —— 因为常量从来没消失，只是被拆散或延迟计算了。</p>' },
          n3: { label: '选C', terminal: true, verdict: 'bad', verdictTitle: 'Frida 是对的方向，但时机不对', result: '<b>认知根源：把「动态」当成万能替代品。</b>Hook 并 dump 内存确实能拿到运行时常量（这是 9.3 的正解），但在这个情境里有个致命问题：<b>你还不知道该 hook 哪里</b>。函数被平坦化后，你连「哪个分支是主循环、哪个是虚假分支」都分不清，dump 出来的内存里混着大量与算法无关的中间状态。</p><p><b>更麻烦的是</b>：如果常量是被 XOR 还原后立即使用的，它在内存里可能只存在几十纳秒，你在错误的时机读到的还是密文。<b>动态手段适合「静态已定位、只差取值」的场景</b>，不适合「结构还没搞清楚」的场景。</p>' },
          n4: { label: '选D', terminal: true, verdict: 'bad', verdictTitle: '跳到结论：证据不足', result: '<b>认知根源：用「常量凑不齐」反推「算法不是 MD5」。</b>这个推理有漏洞 —— 常量凑不齐的原因有很多：混淆打散、跨函数拆分、运行时还原、甚至只是你搜的字节序不对（小端字面量在指令里是反的）。</p><p>四个 IV 里已经能搜到两个，这本身就是「大概是 MD 系列」的正面证据。<b>应该做的是把不确定性消除（解混淆 / 动态 dump），而不是在证据不足时换假设。</b>换假设的代价是：你会在 SHA 系列上再浪费一轮，而且同样凑不齐。</p>' }
        }
      }
    },

    /* ================= 9.7 ================= */
    {
      h: '9.7',
      title: '魔改 ollvm_hmac_md5 的还原实战',
      html: '<p><span class="mono">ollvm_hmac_md5</span> 是加固样本里非常常见的一个函数形态：<b>' + T.term('HMAC', '基于哈希的消息认证码，结构为 H((K⊕opad) || H((K⊕ipad) || m))，ipad=0x36、opad=0x5C 各重复 64 次（块长）。') + ' 的结构 + OLLVM 混淆 + 若干处魔改</b>。它常被用作签名算法，因为 HMAC 天然需要密钥，比单纯加盐更难猜。</p>'
        + T.note('key', '🔑 先把标准结构摆清楚', '<p>HMAC 的完整结构是：<span class="mono">H((K ⊕ opad) || H((K ⊕ ipad) || m))</span>，其中 <span class="mono">ipad = 0x36</span>、<span class="mono">opad = 0x5C</span>，<b>各自重复 64 次</b>（因为 MD5/SHA-1 的块长是 64 字节）。</p>'
          + '<p>把它展开成可执行的动作，一共是<b>四次 MD5 初始化、两次内外层哈希</b>：</p>'
          + '<p>① 建内层：<span class="mono">K_inner = K ⊕ 0x36…36</span>（64 字节）；② 喂数据：<span class="mono">MD5_Update(K_inner)</span> 然后 <span class="mono">MD5_Update(m)</span>；③ 收尾得 <span class="mono">inner = MD5_Final()</span>（16 字节）；④ 建外层：<span class="mono">K_outer = K ⊕ 0x5C…5C</span>；⑤ 喂数据：<span class="mono">MD5_Update(K_outer)</span> 然后 <span class="mono">MD5_Update(inner)</span>；⑥ 收尾得最终 16 字节。</p>'
          + '<p><b>识别 HMAC 的铁证就是 <span class="mono">0x36</span> 和 <span class="mono">0x5C</span> 这两个字节常量</b>，以及「64 字节的异或缓冲区」这个结构。</p>')
        + T.tbl(['改造点', '标准做法', '样本里的常见魔改', '还原手段'], [
          ['ipad/opad', '<span class="mono">0x36</span> / <span class="mono">0x5C</span>', '换成别的两个字节值，或改成加法/减法而非异或', '在异或循环附近找循环不变量；两个「重复填充 64 次」的常量几乎必是它们'],
          ['块长', '64 字节', '改成 32 或 128，绕过特征匹配', '看缓冲区分配大小与循环计数'],
          ['密钥处理', '密钥长于块长时先哈希', '省略这一步，或先做一次额外变换', '看密钥进入异或前是否经过一次 MD5'],
          ['内层结果', '直接进外层', '内层结果被再加工（异或/反转/截断）后再进外层', '跟踪 16 字节缓冲区的流向'],
          ['嵌套层数', '两层', '三层甚至四层嵌套 HMAC', '数「初始化 → update → final」出现的次数'],
          ['控制流', '正常顺序结构', 'OLLVM 平坦化，上述步骤全被打散进分发器', '先反混淆，再按上面的表逐项核对']
        ])
        + T.note('warn', '⚠️ 还原顺序：先解混淆，再拆结构，最后找密钥', '<p>这三步的顺序不能乱：</p>'
          + '<p>① <b>解混淆</b>：用 BPO 类插件或手工 patch 把平坦化还原（见 9.8）。做完这一步，你才「看得见」代码；② <b>拆结构</b>：对着上面的表逐项核对，确认是不是 HMAC，魔改在哪几处。这一步只关心<b>数据流</b>，不关心具体数值；③ <b>找密钥/盐</b>：结构确认后再去找 K 从哪来 —— 通常是个全局数组、或者由某个字符串派生。</p>'
          + '<p>新手最常犯的错是<b>跳过第①步直接读代码</b>，结果在分发器里迷路，把「虚假分支」当成真实逻辑，最后得出「这算法前后矛盾」的错误结论。</p>'),
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境二',
            scenario: '<b>情境：</b>你解完混淆后，在函数里清晰地看到了两次「初始化 IV → 循环处理 64 字节 → 输出 16 字节」的过程。你也找到了 <span class="mono">0x36</span> 和 <span class="mono">0x5C</span> 两个常量，确认是 HMAC-MD5。但你把密钥、明文按标准 HMAC 拼进去算，结果仍然和 App 对不上。你反查发现：<b>内层输出的 16 字节在进外层之前，先和一个全局数组做了异或。</b>你接下来怎么做？',
            choices: [
              { t: '把这个异或数组 dump 出来当密钥，按「HMAC 的 key 就是它」重算', next: 'n1' },
              { t: '确认这个异或数组的值（是常量还是运行时生成），再判断它是魔改的一环还是密钥的一部分', next: 'n2' },
              { t: '判定这不是标准 HMAC，放弃结构比对，改用 Frida 逐字节 dump 中间状态', next: 'n3' },
              { t: '认为外层 MD5 被换成了别的算法，重新比对外层的常量', next: 'n4' }
            ]
          },
          n1: { label: '选A', terminal: true, verdict: 'bad', verdictTitle: '把一个「额外的加工步骤」当成了密钥', result: '<b>认知根源：默认所有不明数据都是密钥。</b>HMAC 里密钥出现在<b>两个</b>位置（⊕ipad 和 ⊕opad 各一次），而且是<b>先进异或再进哈希</b>。而你观察到的这个异或，发生在<b>内层输出之后、外层输入之前</b> —— 这是一个标准 HMAC 里根本不存在的位置，说明它是<b>额外的魔改环节</b>，不是密钥。</p><p>把它的值当密钥代入，会同时搞错两件事：密钥用错了、魔改步骤没还原。<b>正确做法是先定位这个异或数组的性质</b>：如果是写死的常量表，直接抄下来照做一遍即可；如果是运行时生成的，走 9.3 的内存比对路线。</p>' },
          n2: { label: '选B', terminal: true, verdict: 'good', verdictTitle: '正确：先定性，再决定它是哪一环', result: '<b>这一步问对了问题：这个数组「是什么」，而不是「怎么用它」。</b>位置已经告诉了你一半答案 —— 它出现在内层与外层之间，所以它是<b>算法结构的一部分（魔改）</b>，不是输入侧的盐。</p><p>接下来按性质分流：<b>写死的常量数组</b> → 直接读出来，在还原实现里照做一次异或；<b>运行时生成</b> → 用动静态内存比对拿到它的值（9.3/9.4）；<b>由密钥派生</b> → 逆推派生公式。</p><p>这个判断的通用价值在于：<b>数据出现在算法流程的哪个位置，决定了它属于「输入侧」还是「算法侧」</b>。位置比数值更有信息量。</p>' },
          n3: { label: '选C', terminal: true, verdict: 'bad', verdictTitle: '过早放弃结构分析', result: '<b>认知根源：把「有魔改」等同于「结构不可信」。</b>你已经确认了两次「初始化 → 循环 → 输出」，这就是 HMAC 的骨架，是硬证据。多出一个异或步骤，只是说明它是「魔改版 HMAC」，而不是「不是 HMAC」。</p><p>逐字节 dump 中间状态是有效的兜底手段，但它的成本极高（要找到所有关键中间点、要在正确的时机读内存），而且<b>你依然要理解数据流才能解释 dump 出来的东西</b>。先用结构分析把问题缩小到一个异或，是更省力的路径。</p>' },
          n4: { label: '选D', terminal: true, verdict: 'bad', verdictTitle: '怀疑对象选错了', result: '<b>认知根源：把「结果对不上」归因到「算法被换」。</b>外层是不是 MD5，用常量比对一秒钟就能确认（IV 四个 + K 表）。而且你刚刚才看到外层完整执行了一遍 MD5 的循环结构。</p><p>真正对不上的原因，你自己已经观察到了 —— <b>那个多出来的异或</b>。手上有明确异常点时，应该优先解决它，而不是另起一个假设。这是排查工作中的通用纪律：<b>先处理已知异常，再考虑未知假设。</b></p>' }
        }
      }
    },

    /* ================= 9.8 ================= */
    {
      h: '9.8',
      title: 'BPO 插件还原 OLLVM 非标准算法',
      html: '<p>面对平坦化的控制流，你有两条路：<b>手工 patch</b>（慢、但完全可控）和<b>用反混淆插件自动化</b>（快、但有适用边界）。9.6 已经确立了纪律 —— <b>先解混淆，再谈算法</b>。这一节讲第二条路怎么走。</p>'
        + '<p>为什么值得单独讲一节？因为 ' + T.term('控制流平坦化', 'OLLVM 最典型的手段：真实基本块被拆散，由一个 state 变量和 while(1) switch(state) 分发器串起来。反编译出来是一坨看不出顺序的代码。') + ' 是当前安卓加固里出现频率最高的混淆形态之一，几乎每个做非标准算法还原的人都会反复遇到它。</p>'
        + T.note('key', '🔑 BPO 类插件的核心思路（三步）', '<p>本节讨论的是一类<b>「二进制补丁 / 自动化反混淆」</b>思路的 IDA 插件，业界常以 BPO 之类的名字称呼它们。<span class="pill warn">待核实</span>：<b>具体仓库地址、支持的 OLLVM 版本、命令名请自行搜索确认 —— 本章不给出未经核实的链接，也不编造 API 名。</b>这里讲的是思路，思路是通用的。</p>'
          + '<p>① <b>识别混淆模式</b>：扫描函数，寻找平坦化的特征结构 —— 一个入口基本块、一个 state 变量、一个 <span class="mono">while(1)</span> 分发器、以及若干「给 state 赋常量后跳回分发器」的后继块。这些特征在不同 OLLVM 版本里形态有差异，插件的规则库就是用来描述这些差异的。</p>'
          + '<p>② <b>自动打补丁</b>：既然是补丁思路，就不去重建完整的 CFG，而是直接修改二进制/指令 —— 把分发器的 switch 分支<b>改成真实的后继跳转</b>，或者把虚假分支的判定<b>改成恒真/恒假</b>。</p>'
          + '<p>③ <b>让 IDA 恢复反编译</b>：patch 完成后重新分析，反编译器看到的就是接近原始的顺序结构，Hex-Rays 的输出从「一坨 switch」变成「可读的循环」。</p>')
        + T.note('warn', '⚠️ 插件的三条边界，不知道就会踩坑', '<p>① <b>它治的是「形态」，不是「语义」</b>：插件能让代码变好看，但被魔改的常量、换过的 ipad/opad 一个字节都不会帮你改回来。反混淆之后，<b>9.5–9.7 的比对工作才真正开始</b>。</p>'
          + '<p>② <b>模式匹配会被「二次混淆」绕过</b>：加固厂商会在 OLLVM 之上再叠加自己的变异（分发器嵌套、state 变量加密、用间接跳转代替 switch）。这时插件可能识别失败或误报。<b>识别失败时不要硬套，回到手工分析。</b></p>'
          + '<p>③ <b>patch 是有副作用的</b>：改错了会让函数彻底跑不起来。所以永远<b>在副本上操作</b>，并保留原始 so 的哈希备份。</p>')
        + T.card('手工兜底的姿势：不改二进制，只重建可读性', '<p>如果你不想用插件、或者插件不适用，还有一条纯分析的路：<b>把分发器的状态转移关系抽出来，人为重建基本块顺序</b>。</p>'
          + '<p>具体做法：找到 state 变量 → 找到所有给 state 赋值的位置 → 记录「哪个块把 state 置成哪个值」→ 由入口的初始 state 出发串成一条链 → 按链的顺序在 IDA 里重命名和加注释。</p>'
          + '<p>这条路慢，但<b>不需要信任任何工具</b>，而且做上两三次之后你会对 OLLVM 的形态产生直觉 —— 后面再遇到新变种，你能一眼看出「这个块是假的」。<b>手工做一遍，是为了以后能判断插件做得对不对。</b></p>')
        + T.note('ok', '✅ 解混淆之后立刻做的三件事', '<p>① <b>重新常量比对</b>：把 9.6 的 IV/K 表、9.7 的 <span class="mono">0x36</span>/<span class="mono">0x5C</span> 重新搜一遍，这次目标是「搜全」，而不是「搜到」；② <b>恢复函数边界</b>：平坦化常把多个逻辑函数揉成一坨，确认边界后才能认出哪个是 MD5 压缩函数、哪个是 HMAC 封装；③ <b>回到 9.5 的分类</b>：常量全对 → 去找盐/密钥；常量有差异 → 逐项 diff 反推魔改公式。</p>'),
      quiz: {
        id: 'q9-2', chapter: 9, answer: 1,
        stem: '你用反混淆插件处理了一个 OLLVM 保护的目标函数，Hex-Rays 的反编译结果从「一坨 switch」变回了清晰的顺序结构。你重新搜索常量，这次 4 个 MD5 IV 和 64 个 K 全部搜到了，且与标准值完全一致。但用标准 MD5 计算仍然对不上。<b>接下来最该做的是？</b>',
        options: [
          { t: '继续用别的反混淆工具再处理一遍，怀疑还有残留的混淆没解干净', why: '常量已经搜全且完全正确，说明「形态」问题已经解决了。再解一遍混淆不会改变输入侧的问题，属于重复劳动。' },
          { t: '确认算法是标准 MD5，转去找盐：检查输入在进入 MD5 前被拼接了什么', why: '正确。解混淆后常量全中 = 算法本体标准；结果对不上 = 输入不同。这正是 9.5 建立的分类：常量对就查输入。' },
          { t: '认为常量全对只是巧合，魔改可能藏在压缩函数的运算顺序里', why: '这是「不愿意下结论」的过度怀疑。常量全对加上结构完全恢复，已经是很强的证据；在没有正面证据指向运算顺序被改之前，不该假设更复杂的解释。' },
          { t: '把整个 so 丢给动态分析，逐字节记录 MD5 内部每一轮的中间状态', why: '这是成本最高的兜底手段，用在这里是杀鸡用牛刀。逐轮记录状态的前提是你已经知道要 hook 哪里、要对比什么 —— 而你现在连「输入是什么」都还没确认。' }
        ],
        explain: '<b>完整解析。</b>这道题在考「解混淆的产出是什么」。反混淆解决的是<b>可读性</b>问题 —— 让代码结构从被打散恢复到接近原始形态。它的产出是「你能看懂代码了」，<b>不是「算法被还原了」</b>。</p><p>解混淆之后你重新做常量比对，四个 IV 加 64 个 K 全部命中，等于拿到了「算法是标准 MD5」的确认书。既然算法标准、结果又不一致，唯一剩下的变量就是<b>输入</b> —— 盐。所以下一步是找盐，而不是继续怀疑混淆、也不是上重型动态手段。</p><p>这道题和 9.5 的 quiz 是同一个思维模型的两个入口：<b>一个从静态常量进，一个从解混淆后进，出口都是同一句「常量对 → 查输入」。</b>把这个条件反射建立起来，在真实项目里能省掉大量试错时间。</p>'
      }
    },

    /* ================= 9.9 ================= */
    {
      h: '9.9',
      title: 'Frida 辅助 SO 算法还原与 RPC 自动化封装',
      html: '<p>前面所有工作都在回答「算法是什么」。这一节回答一个更实际的问题：<b>知道了之后，怎么把它变成能批量出活的工具？</b></p>'
        + '<p>很多场景下你其实<b>不需要</b>完整还原算法：密钥是服务端下发的、盐是运行时派生的、或者算法里有个你暂时啃不动的魔改。这时候最实用的做法是 —— <b>把目标进程当成一个黑盒函数</b>：输入明文进去，拿密文出来。这就是 ' + T.term('黑盒调用', '不还原算法内部逻辑，直接把目标进程当成一个函数：输入明文、观察密文。适合密钥/盐在服务端或运行时派生、静态无法还原的场景。') + '。</p>'
        + T.note('key', '🔑 Frida 辅助还原的三种用法（从轻到重）', '<p>① <b>验证假设</b>：你猜是「MD5 + 前缀盐 <span class="mono">abc</span>」，直接 hook update 函数看它被调用几次、每次的 buffer 内容是什么 —— 一秒钟证伪；② <b>观测中间状态</b>：dump 函数入口/出口的参数与返回值，确认数据流向（这是 9.7 里定位那个「多出来的异或」的手段）；③ <b>黑盒调用</b>：直接调用目标的加密函数，把它当作 API 用。三种用法可以叠加，但<b>只有第三种能变成产能</b>。</p>'),
      stepper: {
        title: '从「手工 attach」到「RPC 服务化」的四级演进',
        lines: [
          {
            code: '<span class="c">// 第 1 级：手工 attach，控制台里直接调</span>\n<span class="c">// frida -U -f com.a.b -l hook.js</span>\n<span class="t">Java</span>.<span class="f">perform</span>(<span class="k">function</span> () {\n  <span class="k">var</span> C = <span class="t">Java</span>.<span class="f">use</span>(<span class="s">\'com.a.b.Crypto\'</span>);\n  <span class="f">console</span>.<span class="f">log</span>(C.<span class="f">encrypt</span>(<span class="s">\'hello\'</span>));\n});',
            note: '<b>起点：能跑，但只能手工跑。</b>每换一个输入就要改脚本、重启、再看输出。这种方式适合<b>探索阶段</b> —— 验证「这个类这个方法真的能加密」。<span class="mono">Java.perform</span> 是必须的：它保证在 Java 运行时可用之后、且在正确的线程上执行 Java 调用。',
            state: { '阶段': '① 手工 attach', '每次调用成本': '重启 App + 人工', '可批量': '✗' }
          },
          {
            code: '<span class="c">// 第 2 级：暴露成 RPC 导出函数</span>\n<span class="f">rpc</span>.exports = {\n  <span class="f">encrypt</span>: <span class="k">function</span> (input) {\n    <span class="k">var</span> result = <span class="k">null</span>;\n    <span class="t">Java</span>.<span class="f">perform</span>(<span class="k">function</span> () {\n      <span class="k">var</span> C = <span class="t">Java</span>.<span class="f">use</span>(<span class="s">\'com.a.b.Crypto\'</span>);\n      result = C.<span class="f">encrypt</span>(input);\n    });\n    <span class="k">return</span> result;\n  }\n};',
            note: '<b>关键一跃：把函数暴露出去。</b><span class="mono">rpc.exports</span> 里定义的函数，宿主语言（Python / Node / C）可以直接调用，<b>不需要重启 App</b>。这一步让「手工操作」变成了「函数调用」—— 量变引起质变的地方。',
            state: { '阶段': '② RPC 封装', '每次调用成本': '一次 IPC', '可批量': '✓' }
          },
          {
            code: '<span class="c"># Python 端：加载并常驻</span>\n<span class="k">import</span> frida\nsession = frida.<span class="f">get_usb_device</span>().<span class="f">attach</span>(<span class="s">"com.a.b"</span>)\nscript = session.<span class="f">create_script</span>(<span class="f">open</span>(<span class="s">"hook.js"</span>).<span class="f">read</span>())\nscript.<span class="f">on</span>(<span class="s">"message"</span>, on_message)\nscript.<span class="f">load</span>()',
            note: '<b>把 attach 和 load 放在循环外面。</b>这是最重要的一条工程纪律：<b>脚本常驻，不要每次调用都重新 attach</b>。attach/load 的开销是秒级的，而单次 RPC 调用是毫秒级的 —— 如果你在循环里 attach，99% 的时间都花在建立连接上。',
            state: { '阶段': '② RPC 封装', '脚本生命周期': '常驻', '可批量': '✓' }
          },
          {
            code: '<span class="c"># 调用：exports_sync 是同步版本</span>\n<span class="k">for</span> pwd <span class="k">in</span> wordlist:\n    r = script.exports_sync.<span class="f">encrypt</span>(pwd)\n    results.<span class="f">append</span>((pwd, r))',
            note: '<b>批量调用成型。</b><span class="mono">exports_sync.encrypt</span> 会阻塞直到设备端返回结果，适合顺序流程；大批量时改用异步版本配合并发控制，吞吐会高很多。<b>注意</b>：不同 Frida 版本的属性名有差异 <span class="pill warn">待核实</span>，请以你所用版本的文档为准。',
            state: { '阶段': '③ 批量调用', '吞吐': '约 10²–10³ 次/分钟', '可批量': '✓' }
          },
          {
            code: '<span class="c"># 包成 HTTP 服务，给爬虫/自动化系统用</span>\n<span class="k">from</span> flask <span class="k">import</span> Flask, request\napp = <span class="f">Flask</span>(__name__)\n\n<span class="f">@app.route</span>(<span class="s">"/encrypt"</span>, methods=[<span class="s">"POST"</span>])\n<span class="k">def</span> <span class="f">enc</span>():\n    p = request.json[<span class="s">"plain"</span>]\n    <span class="k">return</span> {<span class="s">"cipher"</span>: script.exports_sync.<span class="f">encrypt</span>(p)}',
            note: '<b>服务化：把本机能力变成远程接口。</b>爬虫、压测、数据生产流水线都可以 <span class="mono">POST /encrypt</span>。这一步之后，你的还原成果从「一份分析报告」变成了「一个可调用的生产组件」—— <b>这是逆向工程能产生业务价值的关键形态</b>。（Flask 只是示例，FastAPI 等价。）',
            state: { '阶段': '④ 服务化', '接口': 'POST /encrypt', '可批量': '✓ 跨机器' }
          },
          {
            code: '<span class="c">// 异常处理：设备端必须兜住，否则整个服务挂掉</span>\n<span class="f">encrypt</span>: <span class="k">function</span> (input) {\n  <span class="k">try</span> {\n    <span class="k">var</span> r = <span class="k">null</span>;\n    <span class="t">Java</span>.<span class="f">perform</span>(<span class="k">function</span> () {\n      r = <span class="t">Java</span>.<span class="f">use</span>(<span class="s">\'com.a.b.Crypto\'</span>).<span class="f">encrypt</span>(input);\n    });\n    <span class="k">return</span> r;\n  } <span class="k">catch</span> (e) {\n    <span class="k">return</span> { <span class="f">error</span>: e.<span class="f">toString</span>() };\n  }\n}',
            note: '<b>把异常挡在设备端。</b>App 内部抛异常、类加载失败、参数类型不对 —— 这些都会让 RPC 调用失败。如果不在 JS 层 try/catch，Python 端只能看到一个含糊的错误，而且<b>一次崩溃可能带走整个 App 进程</b>，后续所有调用全废。',
            state: { '阶段': '④ 服务化', '健壮性': '设备端兜异常', '可批量': '✓' }
          },
          {
            code: '<span class="c">// 性能优化：类引用缓存</span>\n<span class="k">var</span> CachedC = <span class="k">null</span>;\n<span class="f">rpc</span>.exports = {\n  <span class="f">encrypt</span>: <span class="k">function</span> (input) {\n    <span class="t">Java</span>.<span class="f">perform</span>(<span class="k">function</span> () {\n      <span class="k">if</span> (!CachedC) CachedC = <span class="t">Java</span>.<span class="f">use</span>(<span class="s">\'com.a.b.Crypto\'</span>);\n    });\n    <span class="k">return</span> CachedC.<span class="f">encrypt</span>(input);\n  }\n};',
            note: '<b>缓存 <span class="mono">Java.use</span> 的结果。</b>它每次调用都要做一次类查找，在高频循环里就是瓶颈。<b>但要注意</b>：跨线程使用缓存的类引用可能有问题，稳妥做法是每次在 <span class="mono">Java.perform</span> 内部重新取一次。<span class="pill warn">待核实</span>：具体行为随 Frida 版本变化，建议实测。',
            state: { '阶段': '④ 优化', '类引用': '已缓存', '可批量': '✓' }
          },
          {
            code: '<span class="c">// 进一步：直接调 Native，绕开 Java 层</span>\n<span class="k">var</span> fn = <span class="t">Module</span>.<span class="f">getExportByName</span>(\n  <span class="s">\'libnative-lib.so\'</span>, <span class="s">\'Java_com_a_b_Crypto_encrypt\'</span>);\n<span class="k">var</span> f = <span class="t">new</span> <span class="t">NativeFunction</span>(\n  fn, <span class="s">\'pointer\'</span>, [<span class="s">\'pointer\'</span>, <span class="s">\'pointer\'</span>]);',
            note: '<b>性能天花板的分界线。</b>Java 层调用要经过 JNI 边界和 Java 对象创建，开销远大于直接调 Native。如果算法在 native 层、且你能搞定参数构造（jstring 转换），直接 <span class="mono">NativeFunction</span> 调用会快得多。<b>代价是可读性与稳定性下降</b>，只在 Java 层成为瓶颈时才做。',
            state: { '阶段': '④ 优化', '调用路径': 'Native 直调', '可批量': '✓ 最快' }
          }
        ]
      },
      after: T.tbl(['工程化要点', '具体做法', '不做会怎样'], [
        ['脚本常驻', 'attach + load 只做一次，循环里只调 RPC', '99% 的时间花在建立连接，吞吐断崖式下跌'],
        ['异常兜底', 'JS 层 try/catch，把错误转成返回值', '一次异常带走 App 进程，服务整个挂掉'],
        ['超时控制', 'Python 端设置调用超时，超时后重连', 'App 卡死时调用方无限等待'],
        ['线程安全', '<span class="mono">Java.perform</span> 包住所有 Java 调用', '偶发的、难以复现的崩溃'],
        ['性能分层', '优先 native 直调，Java 层只做参数转换', '批量生产时吞吐不够'],
        ['设备管理', '多设备/多模拟器并行，分摊负载', '单机成为瓶颈，且崩溃即全停'],
        ['版本锁定', '记录 App 版本与 so 哈希，升级后重新适配', 'App 一升级，全部调用失效且无从追溯']
      ])
        + T.note('ok', '✅ 这条路对逆向实战有什么用', '<p><b>它把「还原算法」这个不确定的任务，换成了「调用函数」这个确定的任务。</b>当密钥在服务端、盐在运行时派生、或者魔改部分你暂时啃不动时，黑盒调用是唯一能立刻产出的方案。</p>'
          + '<p>而且它和还原并不冲突 —— 你可以<b>先用黑盒调用拿到产能</b>，同时继续做还原。<b>能出活的方案才是好方案</b>，追求「完全理解算法」有时只是工程师的洁癖。当然，如果目标 App 有反调试、有完整性校验、有 Frida 检测，你得先把这些绕过（那属于前面几章的战场）。</p>')
    },

    /* ================= 9.10 ================= */
    {
      h: '9.10',
      title: '从脚本到产能：自动化黑盒调用的流水线',
      html: '<p>把 9.9 的四级演进画成一张流水线图。注意每一段的责任边界 —— <b>出问题时你要能立刻说出「是哪一段挂了」</b>。</p>',
      stage: {
        title: '批量生产流水线：输入明文 → 输出密文',
        speed: 1600,
        render: '<div class="flow-row" style="flex-wrap:wrap;gap:6px">'
          + '<span class="blk" id="p1">输入队列</span><span class="arrow">→</span>'
          + '<span class="blk" id="p2">HTTP 服务</span><span class="arrow">→</span>'
          + '<span class="blk" id="p3">Frida 会话</span><span class="arrow">→</span>'
          + '<span class="blk" id="p4">目标进程</span><span class="arrow">→</span>'
          + '<span class="blk" id="p5">结果汇聚</span>'
          + '</div>'
          + '<div class="regs" style="margin-top:12px">'
          + '<span class="reg" id="cnt"><b>已完成</b>=0</span>'
          + '<span class="reg" id="okc"><b>成功</b>=0</span>'
          + '<span class="reg" id="erc"><b>失败</b>=0</span>'
          + '<span class="reg" id="qps"><b>吞吐</b>=—</span></div>'
          + '<div class="memgrid" style="margin-top:12px"><div class="memrow"><span class="addr">样例</span>'
          + '<span class="cell" id="o0">—</span><span class="cell" id="o1">—</span><span class="cell" id="o2">—</span>'
          + '<span class="cell" id="o3">—</span><span class="cell" id="o4">—</span><span class="cell" id="o5">—</span>'
          + '</div></div>',
        reset: () => {
          ['p1', 'p2', 'p3', 'p4', 'p5'].forEach(function (id) { S(id, ''); });
          SET('cnt', '<b>已完成</b>=0'); SET('okc', '<b>成功</b>=0');
          SET('erc', '<b>失败</b>=0'); SET('qps', '<b>吞吐</b>=—');
          for (var i = 0; i < 6; i++) { SET('o' + i, '—'); CLS('o' + i, 'cell'); }
        },
        steps: [
          {
            run: () => { S('p1', 'active'); S('p2', 'active'); S('p3', 'active'); S('p4', 'active'); S('p5', ''); },
            note: '<b>先把链路点亮，再灌数据。</b>从输入队列到目标进程这四段是常驻的 —— 只建立一次。这一步对应 9.9 里「attach 和 load 放在循环外面」的工程纪律。<b>链路建好之后，真正的成本只剩单次 RPC 往返。</b>'
          },
          {
            run: () => { SET('o0', 'hello'); CLS('o0', 'cell hi'); S('p1', 'active'); },
            note: '<b>第一批明文进队列。</b>输入从左边推进来：可能是字典、可能是爬虫抓到的参数、也可能是压测数据。<b>注意此时还没有任何输出</b> —— 流水线的延迟（latency）和吞吐（throughput）是两件事，别把第一次的等待时间当成性能。'
          },
          {
            run: () => { SET('o0', 'hello'); CLS('o0', 'cell wr'); SET('o1', 'a1b2'); CLS('o1', 'cell wr'); SET('cnt', '<b>已完成</b>=1'); SET('okc', '<b>成功</b>=1'); },
            note: '<b>第一个结果回来了。</b>整条链路走通了 —— 这是最重要的心理节点：<b>只要一个输入能出结果，剩下的就是工程问题</b>（并发、重试、监控），不再是逆向问题。'
          },
          {
            run: () => { SET('o2', 'c3d4'); CLS('o2', 'cell wr'); SET('o3', 'e5f6'); CLS('o3', 'cell wr'); SET('cnt', '<b>已完成</b>=3'); SET('okc', '<b>成功</b>=3'); SET('qps', '<b>吞吐</b>=38/s'); },
            note: '<b>连续出结果，吞吐开始稳定。</b>这个数字是你后面所有规划的依据：拿到 10 万个样本需要多久、要不要多开设备、要不要改成 native 直调提速。<b>先量出来，再优化。</b>'
          },
          {
            run: () => { SET('o4', '—'); CLS('o4', 'cell rd'); SET('erc', '<b>失败</b>=1'); SET('qps', '<b>吞吐</b>=—'); S('p4', 'hot'); },
            note: '<b>出事了：某个输入让目标进程崩了。</b>看失败计数跳了、目标进程标红、吞吐变成「—」。这是黑盒调用最常见的故障模式 —— <b>你无法预知哪个输入会触发 App 的异常路径</b>。此刻如果没有异常兜底，整条流水线就停了。'
          },
          {
            run: () => { CLS('o4', 'cell rd'); SET('o4', 'ERR'); S('p4', 'cool'); SET('erc', '<b>失败</b>=1 (已记录)'); SET('qps', '<b>吞吐</b>=41/s'); },
            note: '<b>恢复：记录失败样本，继续跑。</b>这条输入的失败被单独记下来，不进结果集，剩下的照常处理。<b>失败样本要留档</b> —— 它们往往是最有价值的那批（触发异常的输入，可能暴露了 App 的边界条件或校验逻辑）。'
          },
          {
            run: () => { SET('o5', 'done'); CLS('o5', 'cell wr'); SET('cnt', '<b>已完成</b>=6'); SET('okc', '<b>成功</b>=5'); S('p5', 'done'); S('p1', ''); },
            note: '<b>批次收尾。</b>6 条输入，5 条成功、1 条失败，结果落盘。这时候你要回答的是<b>业务问题</b>而不是技术问题：这批数据够不够、失败率能不能接受、要不要补跑。'
          },
          {
            run: () => { S('p1', 'cool'); S('p2', 'cool'); S('p3', 'cool'); S('p4', 'cool'); S('p5', 'cool'); CLS('o4', 'cell rd'); },
            note: '<b>稳态：整条链路持续跑，偶发失败被隔离。</b>这就是「自动化黑盒调用」的最终形态 —— 一个可以持续运转的密文生产服务。<b>到这一步，你的还原成果已经变成了生产系统的一部分。</b>记得给它加监控：成功率、延迟、进程存活。'
          }
        ]
      },
      after: T.note('warn', '⚠️ 这条流水线的三个真实风险', '<p>① <b>稳定性</b>：目标 App 可能被检测、被杀死、被更新。要有进程存活检测与自动重启，并锁定版本；② <b>合法性</b>：黑盒调用是在他人进程中执行代码，它的适用边界由法律与授权决定，<b>务必确认你在合规场景下使用</b>；③ <b>可维护性</b>：App 一升级，类名/方法名/偏移全可能变。<b>把「定位逻辑」单独抽出来</b>，让适配新版本只改一个文件。</p>')
        + T.note('ok', '✅ 本章小结：三个抽屉 + 两件重武器 + 一条纪律', '<p><b>三个抽屉</b>（遇到算不对，先归档）：加盐 → 查输入；改常量 → 比对差异；动态生成 → 动静态内存比对。</p>'
          + '<p><b>两件重武器</b>：手动编译带符号的 OpenSSL，给自己造已知样本，让「像不像」有基准；Frida RPC，把还原成果变成可批量调用的接口。</p>'
          + '<p><b>一条纪律</b>：OLLVM 在场时，先解混淆再谈算法 —— 混淆改的是形态，不是数据。</p>')
    },

    /* ================= 9.11 ================= */
    {
      h: '9.11',
      title: '决策演练与自测',
      html: '<p>这一节先给一个综合决策情境，然后用两道测验收尾。它来自「知识没问题，但顺序和方法选错了」的典型失败。</p>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境三',
            scenario: '<b>情境：</b>你要还原一个 App 的接口签名。抓包发现参数里有个 32 位十六进制字符串，因此判断是 MD5。你在 so 里搜常量，<b>四个 IV 全部搜到、64 个 K 表全部搜到、全部与标准值一致</b>。函数结构正常（没有 OLLVM）。但你用 <span class="mono">md5(postBody)</span> 算出来的结果和抓包对不上。你已经试过：前面加时间戳、加 <span class="mono">imei</span>、加 <span class="mono">api_key</span>，都不对。<b>下一步最值得做的是？</b>',
            choices: [
              { t: '继续穷举拼接组合：多试几种字段顺序、多种分隔符、大小写变体', next: 'n1' },
              { t: 'hook 目标的 MD5_Update，看它实际被调用几次、每次传入的 buffer 内容是什么', next: 'n2' },
              { t: '判定这个 32 位字符串不是 MD5，可能是 SHA-1 截断或别的算法', next: 'n3' },
              { t: '放弃还原，直接把参数丢进 9.9 的黑盒 RPC 接口拿结果', next: 'n4' }
            ]
          },
          n1: { label: '选A', terminal: true, verdict: 'bad', verdictTitle: '穷举的搜索空间是无限的，收益是随机的', result: '<b>认知根源：把「常量已对得上」这个强证据浪费了。</b>四个 IV 加 64 个 K 全部命中，这是<b>算法被确认</b>的铁证 —— 你在 9.5 已经建立过这个判断。既然如此，问题 100% 出在输入上。</p><p>但你选择用<b>猜</b>的方式逼近答案：猜字段、猜顺序、猜分隔符。这个空间是组合爆炸的（字段数 × 顺序 × 分隔符 × 编码方式），而且<b>猜错一百次和猜对一次之间没有任何信息增量</b>。</p><p>正确做法是<b>直接观测</b>：hook update 函数，看真实输入。见一次比猜一千次都快。</p>' },
          n2: { label: '选B', terminal: true, verdict: 'good', verdictTitle: '正确：用观测替代穷举', result: '<b>这一步把「黑盒猜谜」变成了「白盒读数」。</b>具体会看到两种情况之一：</p><p>① <b>update 被调用了两次或以上</b>：说明输入是分段喂的 —— 第一段就是盐。直接读 buffer 内容，盐到手，还原完成。</p><p>② <b>只调用了一次，但 buffer 内容和你的 postBody 不一样</b>：说明进 MD5 之前输入被重新组装过（URL 参数重排、做了编码、或拼接了一个你没抓到的字段）。照样直接读出来。</p><p>这个方法的普适价值：<b>当你的搜索空间是「输入」时，永远优先选择直接观测输入，而不是枚举输入。</b></p>' },
          n3: { label: '选C', terminal: true, verdict: 'bad', verdictTitle: '否定了自己已有的强证据', result: '<b>认知根源：把「结果不符」错误地归因为「前提错误」。</b>32 位十六进制确实可能是 SHA-1 截断，听起来合理。但你已经有了更强的证据：<b>MD5 的完整常量表在这个 so 里全部出现且完全正确</b>。一个 App 里同时存在标准 MD5 和它的截断，这个概率远低于「MD5 被加了盐」。</p><p>更关键的是：<b>这个假设可以通过 9.6 的常量比对立刻证伪</b> —— 搜一下 SHA-1 的第五个 IV <span class="mono">0xC3D2E1F0</span> 和四个轮常量 <span class="mono">0x5A827999</span> / <span class="mono">0x6ED9EBA1</span> / <span class="mono">0x8F1BBCDC</span> / <span class="mono">0xCA62C1D6</span>。有就查，没有就排除，几秒钟的事。</p>' },
          n4: { label: '选D', terminal: true, verdict: 'bad', verdictTitle: '过早投降：明明只差一步观测', result: '<b>认知根源：把黑盒调用当成「放弃还原」的替代品。</b>黑盒调用是个好工具，但它有成本：要对抗反调试、要维护常驻进程、要处理崩溃与升级。而当前的情况是 —— <b>算法已经确认（标准 MD5），只差观测一次真实输入</b>。</p><p>这是一步之遥的差距。用整套黑盒基础设施去替代「hook 一下 update 函数」，是明显的用力过猛。</p><p><b>正确的心智模型</b>：黑盒调用应该用在<b>还原确实走不通</b>的地方（密钥在服务端、算法被强 VMP 保护），而不是用在<b>还原只差最后一步</b>的地方。它是 Plan B，不是 Plan A。</p>' }
        }
      }
    },

    {
      h: '9.12',
      title: '自测：两个最容易混的判断',
      quiz: {
        id: 'q9-3', chapter: 9, answer: [0, 2],
        stem: '<b>多选。</b>关于「加盐」和「魔改常量」，下列说法<b>正确</b>的有哪些？',
        options: [
          { t: '加盐不改变算法的常量表，因此常量比对依然能识别出算法本体', why: '正确。盐作用在输入侧，MD5 加了盐之后 IV 与 64 个 K 常量一个都没变，常量比对完全不受影响。' },
          { t: '魔改常量后，算法就不再是原来的算法了，因此常量比对失去意义', why: '错误。常量比对仍然很有价值 —— 它能告诉你「这像 MD5 但被改过」。恰恰是「像但不一致」这个信号，指引你去逐项 diff 反推变换公式。' },
          { t: '看到常量全部命中标准值但密文算不对，应该去找盐，而不是去比对常量差异', why: '正确。常量全中 = 算法标准 = 问题在输入。这是本章最重要的条件反射。' },
          { t: '加盐和改常量是等价的两种说法，只是描述角度不同', why: '错误。它们是两个不同维度的改造：加盐改的是算法的输入，魔改改的是算法的内脏（IV/K 表/S 盒）。识别手段、还原动作完全不同。' }
        ],
        explain: '<b>完整解析。</b>这道题在检验你是否真正建立了「两个维度」的思维模型。</p><p><b>加盐 = 改输入</b>。算法本体（含全部常量）一个字节没动。所以常量比对照常有效，它帮你确认「这是标准 MD5」，把问题唯一化为「输入被掺了什么」。</p><p><b>魔改常量 = 改内脏</b>。IV / K 表 / S 盒被改，压缩函数本身错了。这时常量比对的价值不减反增 —— 它的结果从「是/不是」变成了「像但不一样」，而<b>「像在哪、不一样在哪」正好就是还原的线索</b>。逐项 diff 之后，你往往能看出规律（整体加常数？整体异或？整表重排？）。</p><p>所以 D 选项的错误在于：把「作用位置不同的两件事」当成了「同一件事的两种说法」。这个混淆在实战中的后果是 —— 明明该去找盐，你却在 K 表上较劲；或者明明 K 表被动过，你却拼命试各种盐的组合。</p>'
      }
    },

    {
      h: '9.13',
      title: '自测：怎么定位那张运行时生成的表',
      quiz: {
        id: 'q9-4', chapter: 9, answer: 1,
        stem: '你要在一段可读写内存里定位一张<b>运行时生成的 AES S 盒</b>。以下哪种筛选顺序<b>最有效率</b>？',
        options: [
          { t: '先对全部可写内存下写断点，观察哪个地址被写入 256 次', why: '方向对但代价最高。对一大片内存下断点会让目标进程几乎跑不动，而且你还不知道该对哪个地址下断点。' },
          { t: '先按大小筛出 256 字节的候选块，再用「值互不重复且覆盖 0..255 各一次」的置换特征过滤，最后看谁在密集索引它', why: '正确。纯读扫描、无侵入、开销极低，而且置换特征这一层的过滤强度极高，通常几次扫描就能收敛到个位数候选。' },
          { t: '直接把整个内存 dump 下来，用标准 AES S 盒逐字节搜索匹配', why: '如果目标是「自定义换表」（值被换过），逐字节搜索标准表会完全搜不到。而且全内存 dump 的数据量与后续处理成本都很高。' },
          { t: '搜索代码段中所有 LDRB 指令，从访问指令反推出表地址', why: '反了。静态代码里这条指令的基址寄存器值在运行时才确定，静态反推不出来。而且 so 里 LDRB 数量巨大，噪音极高。' }
        ],
        explain: '<b>完整解析。</b>定位算法表的三个线索，正确的使用顺序是<b>按代价从低到高</b>：</p><p><b>① 大小特征</b>（快速缩小战场）：Base64 表必然 64 字节，AES S 盒与 RC4 S 盒必然 256 字节 —— 这是算法定义决定的，改不了。</p><p><b>② 置换特征</b>（过滤强度最高）：编码表 / S 盒在数学上是<b>双射</b>，n 个位置恰好覆盖 0..n-1 各一次。随机内存块通过这个检验的概率极低，所以这一刀能砍掉 95% 以上的候选。注意 <b>「无重复」比「值域正确」更强</b>：一段随机的 0–255 字节可能值域恰好落在区间内，但几乎不可能恰好是一个置换。</p><p><b>③ 访问特征</b>（定位到函数）：找到候选地址后再去看谁在读它（<span class="mono">Memory.accessMonitor</span>、硬件断点、或 hook 候选函数）。密集的 <span class="mono">LDRB [基址, 索引]</span> 就是编码循环的查表点。</p><p><b>选项 D 特别值得警惕</b>：它把顺序反过来了。静态代码里只能看到「从某个寄存器偏移取值」，而那个寄存器的值在运行时才确定 —— <b>这正是动态编码表能防住静态分析的原因</b>，也是为什么必须用动态手段。</p>'
      }
    }
  ],

  glossary: [
    { t: '盐（Salt）', d: '一段附加数据，和真正的输入一起进入哈希。它<b>不改变算法的任何常量</b>，只改变输入，因此常量比对仍然能认出算法本体。常见形态：前缀盐 hash(salt+input)、后缀盐 hash(input+salt)、中缀、HMAC 式、多次哈希。' },
    { t: '魔改常量', d: '直接修改算法的内脏：IV、K 表、S 盒、编码表。后果是压缩函数本身变了，<b>无论喂什么输入都算不出标准结果</b>。识别靠「像某算法但常量对不上」，还原靠逐项 diff 反推变换公式。' },
    { t: '动态编码表', d: '不在编译期定义、而在运行时用算法生成的编码表（如用种子算出 64 个 Base64 字符）。目的是让静态搜表失效、让不同设备/版本产生差异。破法是动静态内存比对 + 运行时 dump。' },
    { t: '动静态比对', d: '同一块内存在两个时刻的差集：静态时它是 .bss 里的全 0 或某个初值，动态运行后变成完整的表。<b>这个差值就是运行时生成的数据</b>，是本章最核心的取证手法。' },
    { t: '置换特征', d: '编码表 / S 盒在数学上是双射：n 个位置放 n 个互不重复的值，恰好覆盖 0..n-1 各一次。Base64 表 n=64，AES S 盒与 RC4 S 盒 n=256。<b>用这个性质全内存扫描，能从几十万候选里筛出个位数</b>。' },
    { t: 'HMAC', d: '基于哈希的消息认证码，结构为 H((K⊕opad) || H((K⊕ipad) || m))，ipad=0x36、opad=0x5C 各重复 64 次（块长）。识别铁证就是这两个字节常量与「64 字节异或缓冲区」结构。' },
    { t: 'OLLVM', d: '基于 LLVM 的代码混淆器，三大手段：控制流平坦化（把基本块塞进 switch 分发器）、指令替换（把简单运算换成等价复杂形式）、虚假控制流（插入永不执行的分支）。它改变代码形态，<b>不改变数据与常量</b>。' },
    { t: '控制流平坦化', d: 'OLLVM 最典型的手段：真实基本块被拆散，由一个 state 变量和 while(1) switch(state) 分发器串起来。反编译出来是一坨看不出顺序的代码，反混淆的目标就是恢复基本块的真实顺序。' },
    { t: 'BPO 类插件', d: '一类「二进制补丁 / 自动化反混淆」思路的 IDA 插件，用于还原 OLLVM 保护的非标准算法：识别混淆模式 → 自动打补丁 → 让 IDA 反编译恢复正常。<b>具体插件仓库地址待核实，请自行搜索确认</b>；本章讲的是它的思路而非某个具体实现。' },
    { t: 'FLIRT 签名', d: 'IDA 的库函数识别技术，用已知静态库（.a）生成 .sig 签名，让 IDA 自动认出目标二进制里被内联或裁剪过的库函数。<b>自己手动编译一份带符号的 OpenSSL，就是最可靠的已知样本来源</b>。' },
    { t: 'Frida RPC', d: '通过 rpc.exports 把注入脚本里的函数暴露给宿主语言调用。Python 端用 script.exports_sync.方法名(...) 同步调用。作用是把「手工 hook」升级为「可批量调用的接口」。' },
    { t: '黑盒调用', d: '不还原算法内部逻辑，直接把目标进程当成一个函数：输入明文、观察密文。适合密钥/盐在服务端或运行时派生、静态无法还原的场景，工程上用 RPC + HTTP 服务封装成产能。' }
  ],

  teacher: {
    id: 'ch9', chapter: 9,
    name: '追问老师 · 第 9 章',
    sub: '常量没变却算不对、表在静态里根本不存在 —— 这两件事你必须能立刻说清原因。',
    intro: '<p style="margin:0">这一章我会反复用同一个句式问你：<b>「你凭什么说它是加盐，而不是魔改？」</b> 答不上来，说明你还在凭感觉还原。五道题，难度递增，最后一道是综合场景 —— 那道题答不出来，说明这一章你只是读过了，没有学会。</p>',
    questions: [
      {
        id: 'c9q1', depth: 1, threshold: 0.6,
        q: '你在一个 so 里搜到了完整的 MD5 常量（四个 IV + 64 个 K 表），全部与标准值一致。但用标准 MD5 计算同一个明文，结果和 App 输出的密文对不上。<b>你凭什么判断这是「加盐」而不是「魔改」？判断依据是什么？</b>',
        concepts: [
          { label: '常量全部命中标准值 → 算法本体没被改',
            hint: '魔改的标志是什么？如果内脏被动过，常量会长什么样？',
            any: ['常量没变', '常量不变', '常量一致', '常量全对', '常量全部', '常量都对', 'IV 一致', '相同', '未修改', '没改', '一致', '匹配', 'standard', '常量对上', '常量命中'] },
          { label: '魔改会改 IV / K 表 / S 盒，常量必然对不上',
            hint: '魔改动的是算法的哪个部分？动了之后怎么被看出来？',
            any: ['魔改', 'magic', '改常量', '修改常量', 'IV 被改', 'K 表被改', 'S 盒', '内脏', '压缩函数', '替换', '换表'] },
          { label: '盐作用在输入侧，不改变任何常量',
            hint: '盐进了哪里？它进的是算法内部还是算法之前？',
            any: ['输入', '明文', '拼接', '盐', 'salt', 'prefix', 'suffix', '前缀', '后缀', '中缀', '输入侧', '掺', '混入'] },
          { label: '结论：算法是标准 MD5，问题在输入 → 去找盐/观测真实输入',
            hint: '既然算法是对的，下一步唯一要查的是什么？',
            any: ['找盐', '找 salt', 'hook', 'update', '观测', '打印输入', 'dump 输入', '看输入', '调用几次', '真实输入', 'hook 函数'] }
        ],
        hints: [
          '常量比对一次回答两个问题：这是哪个算法、它的内脏有没有被动过。这里第二问的答案是什么？',
          '如果 K 表被改了一个字节，你还能算出标准 MD5 的结果吗？反过来，如果 K 表完全没动、只是输入多了一段数据呢？'
        ],
        probes: [
          '追问：那如果 K 表只改了 3 个值、其他 61 个都对，你的结论会变吗？下一步做什么？',
          '追问：你打算怎么「找盐」？说说具体动作，不要说「搜索一下字符串」。'
        ],
        model: '判断依据只有一条：<b>常量比对的结果</b>。四个 IV 加 64 个 K 全部命中标准值，说明这个算法的<b>内脏没有被改过</b> —— 压缩函数、初始向量、轮常量都是原装的，它就是标准 MD5。<b>魔改的定义是改常量</b>：IV 被换、K 表被置换或整体异或、S 盒被重排。一旦发生魔改，你搜到的常量<b>必然与标准值对不上</b>，而且通常是对不上「一部分」—— 这个「像但不一致」正是魔改的指纹。</p><p>既然算法是标准的，输入也确实是同一个明文，结果却不一样，那么唯一的变量就是：<b>真正进入哈希的数据，不是你手上的那个明文</b>。这就是盐 —— 它是<b>输入侧的改造</b>，作用在算法<b>之前</b>，算法本身对此一无所知。</p><p>所以下一步的动作被唯一化了：<b>去观测真实的输入</b>。最直接的做法是 hook 目标的 MD5_Update 或对应的 update 函数，打印每次调用的 buffer 内容与调用次数。如果被调用了两次，第一段通常就是盐；如果只调用一次但内容和你预期的不一样，说明输入在进哈希前被重新组装过。</p><p>关键心智：<b>「常量对不对」决定你走哪条路，「输入是什么」只是这条路走多远的问题。</b>把这两件事的顺序搞反，你会一直在错误的方向上使劲。</p>',
        after: '<p>如果你答对了但说不出「hook update 看调用次数和 buffer」这个具体动作，说明你理解了模型但没有落到操作。补上这一步。</p>'
      },

      {
        id: 'c9q2', depth: 2, threshold: 0.6,
        q: '一个 App 的请求参数是 Base64 编码后的字符串，但你在 so 里<b>完全搜不到那张 64 字符的表</b>。请解释：表去哪了？以及「动静态内存比对」具体比对的是什么？你要怎么把这张表拿到手？',
        concepts: [
          { label: '表是运行时生成的，静态文件里根本不存在',
            hint: '表不在文件里，那它是什么时候出现的？',
            any: ['运行时生成', '动态生成', '运行时计算', '运行时', '动态', 'runtime', '不在文件', '没写死', '现算', '生成表', '算出来'] },
          { label: '静态时那块内存是空的 / 初始值（.bss），动态才被写入',
            hint: '同一块内存在编译期长什么样？跑起来之后又长什么样？',
            any: ['静态', '空白', '全 0', '全零', '零', '初值', '初始值', '.bss', 'bss', '未初始化', '空的', '没有值'] },
          { label: '差值就是表：dump 运行时内存即可得到完整表',
            hint: '两个时刻的差集，就是你要的东西。用什么动作把它取出来？',
            any: ['dump', 'dump 内存', '读取内存', '读内存', '内存转储', 'readByteArray', '导出内存', '内存读取', '抓内存'] },
          { label: '定位手段：64/256 字节 + 置换特征（无重复）+ 被密集索引访问',
            hint: '全内存那么大，你凭什么知道该看哪一块？表在数学上有什么特殊性质？',
            any: ['置换', '排列', 'permutation', '无重复', '不重复', '互不重复', '唯一', '双射', '64 字节', '64字节', '256 字节', '256字节', '大小', '索引', 'LDRB', '访问'] }
        ],
        hints: [
          '静态看是空的、动态看是满的 —— 这中间的「差」是什么？',
          'Base64 表和 AES S 盒在数学上都是同一种东西，那个性质是什么？它为什么几乎无法被伪装？'
        ],
        probes: [
          '追问：为什么开发者要费劲把表做成运行时生成的？这样做防住了什么、又没防住什么？',
          '追问：如果这张表每次运行的值都不一样（种子来自设备 ID），你的还原方案还成立吗？'
        ],
        model: '表之所以搜不到，是因为它<b>根本不在静态文件里</b>。开发者没有写死那 64 个字符，而是让程序在运行时用一个种子（可能来自设备信息、版本号、甚至服务端下发）<b>现算出来</b>，再逐字节写进一块内存。这样做的收益有两个：静态搜表失效，以及不同设备/版本产出不同的表、dump 结果不通用。</p><p><b>「动静态内存比对」比对的就是同一块内存在两个时刻的内容。</b>静态时它在 <span class="mono">.bss</span> 段，是一块未初始化的内存，全 0；动态运行起来后，同一个地址被写满，变成一张完整的表。<b>这两个状态的差值，就是运行时生成的数据本身</b>。这不是推测，是同一地址两个时刻的客观差集 —— 所以它比任何猜测都可靠。</p><p>拿到手的具体路径是三步：① <b>缩小战场</b>：只扫可读写（rw-）内存、只留 64 到 4096 字节的小块，因为编码表必然是<b>连续、定长</b>的；② <b>置换过滤</b>：这是最强的一刀 —— 编码表和 S 盒在数学上是<b>双射</b>，n 个位置恰好覆盖 0..n-1 各一次，<span class="mono">seen</span> 数组一查重复就能淘汰绝大多数候选（随机内存通过这个检验的概率极低）；③ <b>dump 并 diff</b>：把候选地址的内容读出来转成字符串，和标准表 <span class="mono">ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/</span> 逐字符对齐，相同的保留、不同的记下来 —— 这张差异表就是你的自定义映射，可以直接用 <span class="mono">str.maketrans</span> 喂回标准库解码。</p><p>要补充的一点：<b>它防的是静态工具，不防运行时。</b>只要接受「表在内存里」这个事实，置换特征反而让它比普通常量更好定位 —— 因为置换这个数学性质几乎不可能被伪装：想让它不像表，就不能让它是一个置换；可一旦不是置换，编码就错了。</p>',
        after: '<p>注意一个坑：堆上分配的表<b>地址会变</b>。脚本里不要写死地址，要么每次重新扫描，要么 hook 分配点。</p>'
      },

      {
        id: 'c9q3', depth: 2, threshold: 0.6,
        q: '为什么不直接用网上下载的 <code>libcrypto.so</code> 做对照，而要花时间<b>手动编译</b>一份 OpenSSL？手动编译这件事，到底给你带来了什么？大致要经过哪几步？',
        concepts: [
          { label: '得到一份带调试符号、完全可控的「已知样本」',
            hint: '对照实验需要一个基准。这个基准最重要的是什么属性？',
            any: ['调试符号', '符号', 'symbol', '-g', '已知样本', '基准', '对照', '参考', '参照', '样本', '可控', '自己编', '确定无疑'] },
          { label: '用来做指令特征比对 / 建立 FLIRT 等签名',
            hint: '有了标准实现之后，你拿它和什么比？比什么？',
            any: ['指令', '反汇编', '特征', '指纹', '比对', '对比', 'FLIRT', '签名', 'sig', 'IDA', '匹配', '相似'] },
          { label: 'NDK 交叉编译：Configure 选目标 → 指定 CC/AR → make',
            hint: '大致的流程：配置目标平台、指定工具链、编译、拿产物。',
            any: ['NDK', 'ndk', '交叉编译', 'clang', 'CC', 'AR', 'RANLIB', '工具链', 'toolchain', 'Configure', 'configure', 'make', 'android-arm64', 'libcrypto'] },
          { label: '还有额外价值：可以故意改常量、造「魔改样本」积累经验',
            hint: '有一份能自己改、自己编的源码，你还能拿它做什么实验？',
            any: ['改造', '魔改样本', '改常量', '可复现', '可修改', '改一个字节', '实验', '验证', '反向'] }
        ],
        hints: [
          '既然要做「比对」，那比对的基准必须满足什么条件？网上那份 so 满足吗？',
          '自己编译除了得到产物，还得到了什么别人给不了的东西？'
        ],
        probes: [
          '追问：如果目标 App 用的是 BoringSSL 而不是 OpenSSL，你这份样本还有用吗？为什么？',
          '追问：编译出来之后，你第一步会拿它做什么？具体动作说一下。'
        ],
        model: '核心答案只有四个字：<b>已知样本</b>。静态识别算法的本质是<b>比对</b> —— 目标的指令序列长什么样，标准实现长什么样，两者像不像。比对就必须有一个<b>确定无疑的基准</b>。网上随手下载的 <span class="mono">libcrypto.so</span> 有三个致命问题：符号被 strip 过（反编译出来全是 <span class="mono">sub_XXXX</span>）、编译器和优化等级不明（指令序列没法归因）、ABI 与你的目标可能对不上。而自己编译的产物<b>这三个问题全部可控</b>，还能加上 <span class="mono">-g</span> 保留调试信息。既然要做对照实验，就要做一份完全可控的样本。</p><p>流程大致是（<b>具体命令随 OpenSSL 版本与 NDK 版本变化，务必以该版本 INSTALL.md 为准</b>）：① 设置 NDK 工具链路径，把 <span class="mono">CC</span> 指向带 API 后缀的 clang wrapper（比如 <span class="mono">aarch64-linux-android21-clang</span>），<span class="mono">AR</span>/<span class="mono">RANLIB</span> 指向 <span class="mono">llvm-ar</span>/<span class="mono">llvm-ranlib</span>；② <span class="mono">./Configure android-arm64 -D__ANDROID_API__=21</span> 选目标平台（32 位用 <span class="mono">android-arm</span>，模拟器用 <span class="mono">android-x86_64</span>）；③ <span class="mono">make</span> 编译，产出 <span class="mono">libcrypto.a</span> / <span class="mono">libcrypto.so</span>；④ 用 <span class="mono">llvm-nm</span> 确认 <span class="mono">MD5_Init</span> 等符号还在；⑤ 编一个「调用 OpenSSL 做 MD5」的小 so 作为标准答案，反汇编看常量和循环结构长什么样。</p><p>还有一份别人给不了的价值：<b>你可以故意改它</b>。把 K 表改一个字节重新编一份，观察「魔改后长什么样」—— 你就同时拥有了「标准样本」和「魔改样本」两套经验，以后遇到真实样本时判断会快得多。这个反向建立经验的过程，才是手动编译最值钱的地方。</p>',
        after: '<p>补充：自己编译出来的静态库还可以用 IDA 的 FLAIR 工具集转成 <span class="mono">.sig</span> 签名，让 IDA 自动识别目标 so 里被内联的 OpenSSL 函数（<span class="pill warn">待核实</span>：工具名与用法随 IDA 版本变化）。</p>'
      },

      {
        id: 'c9q4', depth: 2, threshold: 0.6,
        q: '一个目标函数被 OLLVM 控制流平坦化了。你的同伴说：「直接在这个函数上做常量比对和算法分析不就行了，混淆又不影响常量。」这句话<b>哪里对、哪里不对</b>？为什么必须「先解混淆、再谈算法」？',
        concepts: [
          { label: '对的部分：混淆只改代码形态，不改数据与常量语义',
            hint: 'OLLVM 改变的是什么？不改变的又是什么？',
            any: ['形态', '控制流', '结构', '语义', '数据', '常量', '不改数据', '不改常量', '逻辑不变', '数据流不变'] },
          { label: '不对的部分：常量会被拆散 / 延迟计算，静态搜不全',
            hint: '在平坦化代码里搜常量，你搜到的是全部还是部分？为什么？',
            any: ['拆散', '拆分', '打散', '延迟', '运行时还原', 'XOR', '异或', '分发器', 'switch', '搜不全', '搜不到', '凑不齐', '分散', '常量池'] },
          { label: '结构被破坏 → 读不懂数据流，分不清真实块与虚假分支',
            hint: '在分发器里读代码，你会遇到什么麻烦？',
            any: ['虚假分支', '假分支', '真实块', '基本块', '分不清', '读不懂', '看不出顺序', 'state', '状态变量', '迷路', '乱'] },
          { label: '两件事是先后关系：解混淆是一次性的机械工作，之后常规手法全部恢复可用',
            hint: '混淆层面和算法层面，能不能分开做？应该谁先谁后？',
            any: ['先解混淆', '先反混淆', '顺序', '先后', '先', '再', '解混淆', '反混淆', 'deobfuscate', 'BPO', '插件', 'patch', '补丁', '还原结构'] }
        ],
        hints: [
          '想想常量是怎么被加载的：它一定是一条 mov 指令里的立即数吗？',
          '如果两步一起做，等于同时在解几个未知数？'
        ],
        probes: [
          '追问：解完混淆之后，你紧接着做的第一件事是什么？',
          '追问：如果反混淆插件识别失败（比如加固厂商做了二次变异），你还有什么办法？'
        ],
        model: '<b>对的部分</b>：OLLVM 确实只改变代码的<b>形态</b> —— 控制流被打散进分发器、简单运算被替换成等价复杂形式、虚假分支被插入。它<b>不改变数据与常量所表达的语义</b>：算法要用的 IV 还是那个 IV，K 表还是那 64 个值。所以「混淆不影响常量」这句话在<b>语义层面</b>是成立的。</p><p><b>不对的部分</b>：它不改变常量的<b>值</b>，但会改变常量的<b>出现方式</b>。平坦化之后，常量的加载会被打散：可能被拆成高低位分别 mov 再 or 回来、可能被异或混淆后在运行时还原、可能被塞进常量池由分发器统一读取。<b>你硬搜字节，能搜到一部分（有些确实还是明文），但永远凑不齐</b> —— 而最要命的是，凑不齐时你无法区分「被混淆了」和「这算法真的不用这个常量」。这就是同伴那句话的错误所在：他把「语义不变」误当成了「可分析性不变」。</p><p>还有一层更实际的问题：<b>在平坦化代码里你读不懂数据流</b>。真实基本块和虚假分支混在一起，state 变量反复赋值，Hex-Rays 的反编译输出是一坨看不出顺序的 switch。你没法确认「哪个块是 MD5 的主循环」「哪个块永远不会执行」。</p><p>所以正确的纪律是：<b>先解混淆、再谈算法</b>。这两件事是<b>先后关系，不是并行关系</b>。混淆层面的事用反混淆插件（BPO 类）或手工重建基本块顺序来解决，这是一次性的、机械的工作；解完之后代码结构恢复，常量会以正常形态全部现身，9.5–9.7 的常规手法（常量比对、找盐、结构核对）就全部重新可用了。<b>两件事混在一起做，等于同时解两个未知数。</b></p>',
        after: '<p>提醒：解混淆的产出是「你能看懂代码了」，<b>不是「算法被还原了」</b>。魔改的常量它一个字节都不会帮你改回来。</p>'
      },

      {
        id: 'c9q5', depth: 3, threshold: 0.5,
        q: '<b>综合题。</b>你拿到一个加固 App 的 so，观察到三件事：① 请求参数是 Base64 字符串，但 so 里搜不到标准 Base64 表；② 签名参数是 32 位十六进制，so 里能搜到 MD5 常量，但用标准 MD5 算出来对不上；③ 关键函数的控制流是 <span class="mono">while(1) switch(state)</span> 结构。<b>请给出完整的还原方案：先做什么、再做什么、每步的产出是什么，以及最后怎么把它变成能批量出活的工具。</b>',
        concepts: [
          { label: '③ 先解混淆：控制流恢复后才能可靠地做后面的一切',
            hint: '三件事里有先后依赖，哪一件是所有其他工作的前提？',
            any: ['先解混淆', '反混淆', '解混淆', 'OLLVM', '平坦化', 'BPO', '插件', 'patch', '补丁', '恢复控制流', '先处理混淆'] },
          { label: '① 动态编码表：动静态内存比对 / 置换特征扫描 / dump 内存',
            hint: '搜不到的表，去哪里找？靠什么特征定位？',
            any: ['动态', '运行时', '内存比对', 'dump', '置换', '64 字节', '64字节', '生成表', 'readByteArray', '内存'] },
          { label: '② 加盐：常量没变 → 问题在输入，hook update 观测真实输入',
            hint: '常量搜到了却算不对，说明算法本体怎么样？那问题出在哪？',
            any: ['盐', 'salt', '加盐', '输入', '拼接', 'hook', 'update', '观测输入', '常量没变', '常量一致', '标准算法', '前缀', '后缀'] },
          { label: '收尾：Frida RPC 黑盒调用 / HTTP 服务化，实现批量输入输出',
            hint: '还原之后，怎么让它变成产能？',
            any: ['RPC', 'rpc', 'Frida', 'frida', '黑盒', '自动化', '批量', 'HTTP', '接口', '服务', 'Flask', 'FastAPI', 'exports'] },
          { label: '强调顺序与依赖：先解混淆 → 再算法分析 → 最后工程化',
            hint: '这三步能不能并行？为什么？',
            any: ['顺序', '先后', '分步', '先', '再', '最后', '依赖', '优先级', '分阶段', '不能并行', '依次'] }
        ],
        hints: [
          '三件事里有一件是其他两件的前提 —— 在混淆代码上做算法分析会怎样？',
          '把三件事分别归类到「改输入 / 改内脏 / 改形态」三个抽屉里，你会发现它们的处理手段完全不同。'
        ],
        probes: [
          '追问：如果第②步 hook 之后发现 update 只调用了一次、且 buffer 内容就是明文，你的结论要改成什么？',
          '追问：假设第①步的表每次运行都不一样（种子来自设备），你的方案要怎么调整？',
          '追问：如果 App 有 Frida 检测，你的 RPC 服务要怎么活下去？'
        ],
        model: '<b>先分类，再排序。</b>这三件事正好对应本章开头的三个抽屉：①是<b>动态生成</b>（改的是表的产生方式）、②是<b>加盐</b>（改的是输入）、③是<b>改代码形态</b>（OLLVM）。它们的处理手段完全不重叠，但<b>有严格的先后依赖</b>。</p><p><b>第一步：解混淆（③）。</b>这是所有后续工作的前提。在平坦化代码上做常量比对会搜不全，读数据流会迷路，hook 时也分不清哪个分支是真的。用 BPO 类反混淆插件自动打补丁，或者手工抽取 state 转移关系重建基本块顺序。<b>产出：一份结构可读的反编译结果</b>。注意插件治的是形态不是语义 —— 魔改的常量它不会帮你改回来。</p><p><b>第二步：确认算法本体（②的前半）。</b>在结构恢复的代码上重新做常量比对，把四个 IV 和 64 个 K 搜全、对齐。<b>产出：一句明确结论 —— 「这是标准 MD5」或「这是被改过的 MD5」。</b>常量全对就说明算法标准，问题在输入，进入下一步；常量有差异就逐项 diff 反推变换公式。</p><p><b>第三步：找盐（②的后半）。</b>hook 目标的 update 函数，打印每次调用的 buffer 内容与调用次数。被调用两次说明输入分段喂入、第一段往往就是盐；只调用一次但内容不符说明输入被重新组装过。<b>产出：盐的值与拼接位置</b>，此时你有了纯 Python 的等价实现。</p><p><b>第四步：抓动态编码表（①）。</b>走动静态内存比对：先按大小筛出 64 字节的 rw 内存块，再用<b>置换特征</b>（值互不重复、恰好覆盖 0..63）过滤，然后 dump 出来和标准表做逐字符 diff。<b>产出：一张自定义表</b>，用 <span class="mono">str.maketrans</span> 映射回标准表即可复用标准库解码。</p><p><b>第五步：工程化（收尾）。</b>把上述成果用 Frida RPC 封装：<span class="mono">rpc.exports</span> 暴露 <span class="mono">encrypt</span>/<span class="mono">encode</span>，<b>脚本常驻、attach 只做一次</b>，JS 层 try/catch 兜住异常，Python 端加超时与重试，最后用 Flask/FastAPI 包成 <span class="mono">POST /encrypt</span> 接口。<b>产出：一个「输入明文 → 输出密文」的远程服务</b>，供爬虫或数据流水线批量调用。</p><p><b>最重要的一句</b>：只有在还原走不通时（密钥在服务端、算法被强 VMP 保护）才应该跳到第五步做纯黑盒。它是 Plan B —— 但一旦跑通，它就能立刻产出，而且可以边出活边继续还原。顺序对了，每一步的产出都能被下一步复用；顺序错了，你会在三个方向之间反复横跳。</p>',
        after: '<p>如果你答出了四步以上但顺序错了（比如先去找盐再解混淆），说明你把「知道该做什么」和「知道先做什么」混为一谈了。真实项目里，<b>顺序错了的代价往往比漏做一步更大</b>。</p>'
      }
    ]
  }
};
