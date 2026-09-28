/* 第 13 章 · 自吐沙箱与算法自监控
   —— 第 18 章的「一行探针」在这里长成一件产品：一台会自己招供的运行环境
   数据文件：只写 window.CHAPTER，浏览器脚本，禁止 import/require/export/async。 */

/* —— 本章实验用的「模拟自吐沙箱输出」（JSONL）。
      这些值不是编的：每一条都由 assets/labs.js 里的真实实现在生成时算过，
      实验的 run/expected 会现场复算并逐字节比对。 —— */
var CH24_LOG_ROWS = [
  '{"pid":8421,"t":"MessageDigest","algo":"MD5","ev":"update","seq":1,"len":11,"in":"757365723d616c69636526"}',
  '{"pid":8421,"t":"MessageDigest","algo":"MD5","ev":"update","seq":2,"len":29,"in":"74733d31373030303030303030267369676e5f6b65793d733363723374"}',
  '{"pid":8421,"t":"MessageDigest","algo":"MD5","ev":"doFinal","out":"b94dee2184b1ab61baa11fd73d62fcf4"}',
  '{"pid":8421,"t":"Mac","algo":"HmacSHA1","ev":"init","key":"7333637233742d6b6579","keyLen":10}',
  '{"pid":8421,"t":"Mac","algo":"HmacSHA1","ev":"doFinal","in":"474554202f6170692f76312f70726f66696c65","out":"dedf56910576135711f8579c9c24ce4bd622c200"}',
  '{"pid":8421,"t":"Cipher","algo":"AES/CBC/PKCS5Padding","ev":"init","mode":1,"key":"4d795333637233744b65793230323421","keyLen":16,"iv":"1a2b3c4d5e6f708192a3b4c5d6e7f809"}',
  '{"pid":8421,"t":"Cipher","algo":"AES/CBC/PKCS5Padding","ev":"doFinal","in":"7b22756964223a223130303836222c2276223a22322e332e31227d","out":"0f4699bfad668f6fae6357bf90fe8b536b09abce7c9d13a0c9003b995b56c1a9"}',
  '{"pid":8421,"t":"Cipher","algo":"AES/ECB/PKCS5Padding","ev":"init","mode":1,"key":"546865517569636b42726f776e466f784a756d70734f7665725468654c617a79","keyLen":32}',
  '{"pid":8421,"t":"Cipher","algo":"AES/ECB/PKCS5Padding","ev":"doFinal","in":"70696e3d31323334","out":"e605e27d...(trunc, cap=8)","outLen":16}'
];

/* —— 实验二用：一份「行序被打乱」的分块 update 日志 —— */
var CH24_L2_ROWS = [
  '{"pid":9012,"t":"MessageDigest","algo":"MD5","ev":"update","seq":3,"len":7,"in":"26743d31373030"}',
  '{"pid":9012,"t":"MessageDigest","algo":"MD5","ev":"update","seq":1,"len":5,"in":"757365723d"}',
  '{"pid":9012,"t":"MessageDigest","algo":"MD5","ev":"update","seq":2,"len":5,"in":"616c696365"}',
  '{"pid":9012,"t":"MessageDigest","algo":"MD5","ev":"doFinal","out":"a3ce80904ed7c8b953c00156245a72e9"}'
];

window.CHAPTER = {
  no: 13,
  title: '自吐沙箱与算法自监控',
  lede: '第 18 章你学会了在 ART 里插一行日志。这一章把它做成一件<strong>能长期用的产品</strong>：' +
        '一个会自己招供的沙箱——App 在里面跑，它调用过的每一次哈希、加解密、MAC，' +
        '<strong>算法名、密钥、IV、明文、密文</strong>都被自动记成结构化日志。' +
        '于是「还原算法」这件事，从<strong>读汇编</strong>变成了<strong>读日志</strong>。',
  meta: [
    '核心问题：<b>观测点该插在框架层还是算法层？拿到密钥之后，还有必要读一行汇编吗？</b>',
    '关键机制：<b>MessageDigest.update / Cipher.init + doFinal / Mac.doFinal · Provider 与 SPI · JSONL 落盘 · 数据流观测</b>',
    '对手：<b>自定义 Provider · native 下沉与 C 魔改 · 内联 SVC 与 seccomp</b>'
  ],

  sections: [
    /* ================= 13.1 ================= */
    {
      h: '13.1',
      title: '沙箱在这里不是牢笼，而是带传感器的运行环境',
      intuition: {
        tag: '直觉模型 · 隔离病房与检查室',
        body: '<p>恶意代码分析里的「沙箱」是一间<strong>牢笼</strong>：目的是把样本关起来，别让它伤到外面。</p>' +
              '<p>这一章说的沙箱是<strong>检查室</strong>：病人照常生活，房间里装满传感器——血压、心率、吃了什么、说了什么，全被自动记下来。' +
              '医生不需要剖开他，就能知道他的身体在做什么。</p>' +
              '<p>两者的差别不在「隔离得多严」，而在<strong>「观测点装在哪」</strong>。装错了位置，病人在你眼皮底下发病你都看不见。</p>'
      },
      html:
        T.note('key', '🔑 本章主线',
          '<p>整章只回答两个问题：<b>①</b> 观测点插在哪一层（<span class="term" data-def="Android 框架/JCA 提供的 Java 密码学 API，如 MessageDigest、Cipher、Mac">框架层</span> ' +
          '还是 <span class="term" data-def="具体算法的实现处，是密钥、明文、IV 这些参数真正交汇的地方">算法层</span>）；' +
          '<b>②</b> 记录下来的东西怎么变成可用的分析输入（结构化落盘 → 复算验证 → 批量驱动）。</p>' +
          '<p>它和<a href="ch32-art-sandbox.html">第 18 章</a>是同一件事的两个尺度：第 18 章在 <span class="mono">RegisterNatives</span> 里记下' +
          '「Java 方法 ↔ native 地址」，本章把同一套插桩手法用在密码学 API 上，记下「算法 ↔ 密钥 ↔ 明文 ↔ 密文」。' +
          '<b>那章讲的是怎么插桩，这章讲的是把插桩做成能力。</b></p>') +
        '<p>先看一个具体的对照。同一个「算一次 MD5」的动作，从 App 的代码到真正算出结果，要穿过五层：</p>' +
        T.tbl(['层', '典型位置', '在这一层插桩，你能拿到什么', '拿不到什么'], [
          ['① 业务代码', 'App 自己的 <span class="mono">MD5Util.encrypt()</span>', '业务语义（这是登录签名还是参数校验）、入参与返回值', '算法名、盐、密钥——名字叫 <span class="mono">encrypt</span> 的方法可能只是在做哈希'],
          ['② JCA 门面类', '<span class="mono">java.security.MessageDigest</span>', '<b>算法名 + 每一次 update 的原始字节 + 最终摘要</b>，且与调用者是谁无关', '密钥（哈希本来就没有）；加密类才有'],
          ['③ Provider / SPI', '<span class="mono">MessageDigestSpi</span> 的具体子类', '<b>实际是哪个实现在算</b>——这一层是判断「有没有自定义 Provider」的唯一位置', '如果 SPI 是第三方实现，你可能根本没有它的源码'],
          ['④ JNI 边界', '<span class="mono">GetByteArrayElements</span> / <span class="mono">NewByteArray</span>', '<b>进出 native 的原始字节流</b>——不关心算法是什么', '算法名、参数含义（这段字节是盐还是正文？）'],
          ['⑤ native 实现', 'BoringSSL / OpenSSL / 自研 C 代码', '算法是否标准、常量有没有被魔改（回到第 22 章的手法）', 'Java 层的语义与字段归属，需要你自己对齐']
        ]) +
        T.note('key', '🔑 这一节的判断：框架层和算法层不是二选一',
          '<p>很多人第一次做自吐沙箱，会在这两个选项之间纠结。其实它们的成本结构完全不同：</p>' +
          '<p><b>框架层</b>（②③④）的特点是「一次投入、一次覆盖一大批样本」——因为它监控的是 API，而 API 的数量是有限的、稳定的。' +
          '代价是：<b>目标不走这条路，你就什么都看不到。</b></p>' +
          '<p><b>算法层</b>（⑤以及②里的具体实现）的特点是精确——算法名、密钥、IV、明文全在手上，代价是你要知道目标用了什么、用什么实现。</p>' +
          '<p>正确的姿势是<b>先用框架层铺面，再用算法层取点</b>：先用一个便宜的探针确认「这个 App 到底用不用 JCA API、用的是哪几个类」，' +
          '再决定要不要为它单独下沉。反过来做——上来就猜目标用 OpenSSL 并去改它——是最常见的浪费。</p>') +
        '<p>下面这个动画把这条五层链路点亮。特别留意每一行右下角的两个格子：<b>这一层能看到什么、看不到什么</b>——' +
        '这两个格子加起来，就是本节的取舍表。</p>',
      stage: {
        title: '一次 MD5 调用穿过的五层：观测点插在哪，就能看到什么',
        speed: 1500,
        render:
          '<div class="flow-col" style="gap:9px">' +
            '<div class="flow-row">' +
              '<span class="blk" id="L0">App 业务代码<br><span class="small">MD5Util.encrypt(pwd)</span></span>' +
              '<span class="arrow">→</span>' +
              '<span class="blk" id="L1">java.security<br>.MessageDigest</span>' +
              '<span class="arrow">→</span>' +
              '<span class="blk" id="L2">Provider /<br>MessageDigestSpi</span>' +
            '</div>' +
            '<div class="flow-row">' +
              '<span class="arrow">↓</span>' +
              '<span class="blk" id="L3">JNI 边界<br><span class="small">byte[] 进出</span></span>' +
              '<span class="arrow">→</span>' +
              '<span class="blk" id="L4">native 实现<br><span class="small">BoringSSL / OpenSSL / 自研</span></span>' +
            '</div>' +
          '</div>' +
          '<div class="regs" style="margin-top:14px">' +
            '<span class="reg" id="vis"><b>这一层能看到</b>=—</span>' +
            '<span class="reg" id="blind"><b>这一层看不到</b>=—</span>' +
          '</div>' +
          '<div style="margin-top:12px"><span class="pill" id="vd">等待播放</span></div>',
        reset: () => {
          ['L0', 'L1', 'L2', 'L3', 'L4'].forEach(id => S(id, ''));
          SET('vis', '<b>这一层能看到</b>=—');
          SET('blind', '<b>这一层看不到</b>=—');
          CLS('vd', 'pill'); SET('vd', '等待播放');
        },
        steps: [
          { run: () => { S('L0', 'active'); SET('vis', '<b>能看到</b>=谁调用了什么方法'); SET('blind', '<b>看不到</b>=算法是不是标准 MD5'); },
            note: '<b>起点：业务代码这一层。</b>在这一层插桩，你看到的是<b>业务语义</b>——「登录时调了一个叫 encrypt 的方法」。' +
                  '这很有用（它告诉你这段逻辑在业务里的位置），但它完全不能回答「用什么算法、盐是什么」。' +
                  '<b>方法名叫 encrypt 不代表它在加密，方法名叫 md5 也不代表它没被魔改。</b>',
            state: { '观测点': '① 业务代码', '信息类型': '业务语义' } },
          { run: () => { S('L0', 'done'); S('L1', 'active'); SET('vis', '<b>能看到</b>=算法名 + 每次 update 的字节 + 摘要'); SET('blind', '<b>看不到</b>=哪个实现类在算'); },
            note: '<b>下沉一层：JCA 门面类 MessageDigest。</b>这是本章的主战场，原因只有一个——' +
                  '<b>它是所有标准哈希调用的必经之路</b>。不管 App 是直接 <span class="mono">MessageDigest.getInstance("MD5")</span>，' +
                  '还是通过它自己的工具类绕进来，最终都要落到这里的方法上。在这里插桩，你就拿到了：' +
                  '<span class="mono">getAlgorithm()</span> 的算法名、每次 <span class="mono">update</span> 的原始字节、<span class="mono">digest()</span> 的结果。',
            state: { '观测点': '② 门面类', '关键': '与调用者无关' } },
          { run: () => { S('L1', 'done'); S('L2', 'active'); SET('vis', '<b>能看到</b>=实际实现类的类名'); SET('blind', '<b>看不到</b>=第三方实现内部的细节'); },
            note: '<b>再下沉一层：Provider 与 SPI。</b>门面类只负责「找到谁来算」，真正干活的是某个 <span class="mono">MessageDigestSpi</span> 子类。' +
                  '这一层的价值在于<b>它回答一个门面类回答不了的问题：是谁在算？</b>' +
                  '如果目标用了自定义 Provider，这一层的类名就是你的第一个线索——<b>也是接下来 13.6 那个决策情境的入口</b>。' +
                  '注意这一层的观测难度：第三方 Provider 的实现代码可能根本不在你的 AOSP 树里。<span class="pill warn">待核实</span>',
            state: { '观测点': '③ Provider/SPI', '风险': '实现可能不在源码树内' } },
          { run: () => { S('L2', 'done'); S('L3', 'active'); SET('vis', '<b>能看到</b>=进出 native 的原始字节'); SET('blind', '<b>看不到</b>=这些字节的业务含义'); },
            note: '<b>换个维度：JNI 边界。</b>这一层不关系算法，只关系<b>数据流</b>——' +
                  '「有一段字节从 Java 进了 native，过一会儿有一段字节从 native 回到 Java」。' +
                  '<span class="hit">这看起来信息量最低，却是本章最后能救命的一层</span>：当算法完全自研、Java 层一无所获时，' +
                  '你依然能在边界上记录「进去什么、出来什么」——这就等价于一次不花钱的黑盒调用（第 23 章的手法）。',
            state: { '观测点': '④ JNI 边界', '思路': '观测数据而不是观测函数' } },
          { run: () => { S('L3', 'done'); S('L4', 'active'); SET('vis', '<b>能看到</b>=是不是标准算法、常量有没有被改'); SET('blind', '<b>看不到</b>=Java 层的字段归属与语义'); },
            note: '<b>最底层：native 实现。</b>在这里你回到了<a href="ch11-algo1.html">第 22 章</a>的战场——常量比对、S 盒比对、' +
                  '动静态内存比对。它能回答「是不是标准算法」，但回答不了「哪个参数是盐、哪个是时间戳」。' +
                  '<b>层越低，看到的越「真实」，但越脱离业务语义。</b>这就是分层观测的核心张力。',
            state: { '观测点': '⑤ native 实现', '手段': '回到第 22 章' } },
          { run: () => { ['L0', 'L1', 'L2', 'L3', 'L4'].forEach(id => S(id, 'cool')); CLS('vd', 'pill ok'); SET('vd', '选点规则：要覆盖面选 ②，要数据流选 ④，要算法细节选 ⑤'); },
            note: '<b>收束成一条可执行的选择规则。</b>' +
                  '<b>要覆盖面</b>（一个探针看一大批样本）→ 插在 ② 门面类；' +
                  '<b>要数据流</b>（不管算法是什么）→ 插在 ④ JNI 边界；' +
                  '<b>要算法细节</b>（判断魔改、还原实现）→ 下沉到 ⑤。' +
                  '而 ③ 是<b>诊断用</b>的位置：当你「什么都没看到」时，回到 ③ 去问「到底是谁在算」。',
            state: { '选点': '按要观测什么决定', '而不是': '按哪层技术更高级决定' } },
          { run: () => { CLS('vd', 'pill acc'); SET('vd', '记住：0 命中不是失败，是一个关于目标的信息'); },
            note: '<b>最后一句，也是这一章最容易被忽略的判断。</b>自吐沙箱「什么都没记录到」不是白干——' +
                  '它是一条<b>强证据</b>：目标没有走 JCA API。这条证据本身就把你的下一步（下沉到 native、或走数据流观测）' +
                  '指得很清楚。<span class="hit">很多人在这里的失败不是技术上的，而是心理上的：把「没日志」当成「工具没用」，然后换工具重来一遍。</span>',
            state: { '0 命中的含义': '目标不走这条路', '下一步': '换观测层，而不是换工具' } }
        ]
      },
      quiz: {
        id: 'q24-1', chapter: 24, answer: 2,
        stem: '你在 AOSP 的密码学 API 里插了自吐探针，跑一批样本时发现：<b>有些样本有日志、有些一条都没有</b>，而有日志的那些记录得都很完整。下面哪个判断最准确？',
        options: [
          { t: '探针有 bug，遇到某些数据形态就静默失败，应该先去排查插桩代码', why: '「有的有、有的没有」这种按样本分布的规律，更像目标行为差异而不是代码随机失败。插桩 bug 通常表现为格式错误、崩溃或特定类型输入（比如 ByteBuffer 入参）才丢，而不是整份日志为空。' },
          { t: '没日志的样本把加密放在了 native 层，说明这套沙箱对这个样本集完全没用', why: '前半句是合理假设，后半句过头了。沙箱的价值取决于样本分布：只要样本集里有相当比例走 JCA API，它就有净收益。「有的样本覆盖不了」和「工具没用」是两件事。' },
          { t: '「整份日志为空」是一条有效信息：这些样本没有走这套 API 路径，应该据此决定下一步下沉到哪一层', why: '正确。自吐沙箱的阴性结果同样可解释——0 命中说明调用没有经过你插桩的那一层。这直接决定了下一步：下沉到 JNI 边界记录数据流，或者回到第 22 章的常量比对手法。' },
          { t: '应该同时插桩全部五层，这样无论目标走哪条路都能覆盖', why: '听起来稳妥，实际是成本灾难：五层的探针要同时维护、同时随版本适配，而且多进程高频日志会把设备拖死（见 13.7）。分层观测的前提是「先便宜地确认走哪一层」，而不是全部铺开。' }
        ],
        explain: '<b>这道题考的是「怎么读阴性结果」。</b>自吐沙箱输出的是两类证据：有日志（目标走了这条路）和没日志（目标没走这条路）。' +
                 '后者看似「没信息」，实际上把搜索空间砍掉了一大块——你不再需要猜它是不是用了标准 JCA API。' +
                 '<b>正确的心智模型是：探针的价值不在于「命中率多高」，而在于「命中与不命中都指向明确的下一步」。</b>'
      }
    },

    /* ================= 13.2 ================= */
    {
      h: '13.2',
      title: 'APPMON 的思路：监控 API，而不是监控算法',
      html:
        '<p>自吐沙箱有一个更「不能动目标」的形态：<b>不去理解算法，只记录 App 调用了哪些敏感 API</b>。' +
        '这一节讲清这种形态为什么能一次覆盖一大批样本，以及它的天花板在哪。</p>' +
        T.note('key', '🔑 这一类工具的立足点',
          '<p><b>算法是无限的，API 是有限的。</b></p>' +
          '<p>一个 App 可以把 MD5 改成任何样子、可以把加密整个搬进 native、可以自研一套谁都认不出的东西。' +
          '但它要用系统的能力，就<b>必须经过系统提供的那些接口</b>：读文件要经过文件 API，发网络请求要经过网络 API，' +
          '加解密要经过密码学 API，加载代码要经过动态加载 API。</p>' +
          '<p>这些接口<b>名字有限、签名固定、行为由系统定义</b>。监控它们的集合，就是用一份有限的清单，' +
          '去覆盖一个无限的样本空间——这就是「监控 API」相对「监控算法」的根本优势。</p>') +
        '<p>下面这张表是这类沙箱通常覆盖的六类观测面。注意第三列：<b>它对逆向的真正价值不是「记录了什么」，而是「它替你回答了哪个问题」</b>。</p>' +
        T.tbl(['观测面', '典型接口', '它替你回答的问题', '它的盲区'], [
          ['加解密', '<span class="mono">MessageDigest</span> / <span class="mono">Cipher</span> / <span class="mono">Mac</span> / <span class="mono">Signature</span>', '<b>这个 App 的算法是哪个、密钥是什么、明文长什么样</b>——直接产出可用结论', '算法下沉到 native、或自研实现时完全失效'],
          ['文件', '<span class="mono">open</span> / <span class="mono">read</span> / <span class="mono">write</span> / <span class="mono">stat</span>', '它读了哪些配置、把结果写到了哪里、有没有在探测 <span class="mono">/proc</span>', '拿到的是路径与字节，不含语义'],
          ['网络', '<span class="mono">socket</span> / <span class="mono">connect</span> / <span class="mono">send</span> / <span class="mono">recv</span>', '除了抓包工具看到的，还能看到<b>加密之前</b>的明文与参数拼装', 'TLS 与自研协议下需要配合解密'],
          ['反射', '<span class="mono">Class.forName</span> / <span class="mono">getDeclaredMethod</span> / <span class="mono">invoke</span>', '它在运行时「找」哪些类和方法——这是加壳与隐藏调用链最常暴露的一环', '只是名字，不含参数语义'],
          ['动态加载', '<span class="mono">DexClassLoader</span> / <span class="mono">dlopen</span> / <span class="mono">System.loadLibrary</span>', '真代码是从哪来的、什么时候被加载进来的', '加载之后的执行情况要另找观测点'],
          ['进程与系统信息', '<span class="mono">getpid</span> / <span class="mono">uname</span> / <span class="mono">/proc/self/status</span>', '它在做哪些环境检测（这同时也是<b>反检测</b>的输入）', '检测手段下沉到内联 SVC 时会漏（见 13.8）']
        ]) +
        T.note('warn', '⚠️ 关于「APPMON」这个名字的边界，必须说清楚',
          '<p>本章把「以监控 App 使用了哪些敏感 API 为核心目标的沙箱形态」统称为 <b>APPMON 形态</b>。' +
          '<b>它的具体实现、仓库地址与版本号，本课程资料里不作断言</b> <span class="pill warn">待核实</span>：' +
          '不同教材、不同团队可能各自有一套叫这个名字的东西，把它们混为一谈是不诚实的。</p>' +
          '<p>公开可查的同名项目确实存在一个（见下面的案例），但它<b>基于 Frida、走的是框架层路线</b>，' +
          '和本章要讲的「改 AOSP 源码」不是同一件东西。<b>名字相同不代表实现相同</b>——这一点我希望你从一开始就绷着。</p>' +
          '<p>本节只讲可以确证的设计思想：<b>监控 API 而不是监控算法</b>，以及由此带来的覆盖面优势与「不走这条路就看不见」的代价。</p>'),
      case: {
        source: 'github',
        title: 'Welcome to AppMon!（仓库 dpnishant/appmon）',
        date: '2016-04-29（仓库创建时间，取自 GitHub API）',
        author: 'dpnishant',
        target: 'AppMon —— 面向 macOS / iOS / Android 原生 App 的系统 API 调用监控与篡改框架（Frida 实现）',
        background:
          '<p>这是「监控 API 而不是监控算法」这一思路<b>公开可查的一个真实实现</b>。README 的第一句就把定位写死了：' +
          '<i>an automated framework for monitoring and tampering system API calls of native macOS, iOS and android apps</i>，' +
          '并明确说明它 <b>based on Frida</b>。</p>' +
          '<p>它在 <b>Black Hat US-16 与 EU-16 的 Arsenal</b> 环节展出（README 顶部挂的就是这两个 Arsenal 徽章，' +
          '链接分别指向 <span class="mono">blackhat.com/us-16/arsenal.html#appmon</span> 与 ' +
          '<span class="mono">blackhat.com/eu-16/arsenal.html#appmon-runtime-security-testing-and-profiling-framework-for-native-apps</span>）。</p>' +
          '<p>收录它的理由很直接：<b>它是框架层路线的教科书样本</b>——用一个外挂的 instrumentation 框架，去覆盖三大平台上所有「App 会调用的系统 API」。' +
          '这恰好是本章的对照组：同样是监控 API，一个插在框架层，一个插进源码里。</p>',
        points: [
          'README 自述的组件划分：<b>AppMon Sniffer</b>（拦截 API 调用，找出 App 做了哪些「有意思」的操作）、' +
          '<b>AppMon Intruder</b>（篡改 API 调用数据以改变 App 原有行为）、<b>AppMon Android Tracer</b>' +
          '（自动 trace APK 里的 Java 类、方法、参数及其数据类型）。',
          '另有两个部署向组件：<b>AppMon IPA Installer</b>（在未越狱 iOS 设备上安装「可检查」的 IPA）、' +
          '<b>AppMon APK Builder</b>（在未 root 的 Android 设备上生成「可检查」的 APK）。',
          '能力边界写在名字里：<b>monitoring</b>（观测）与 <b>tampering</b>（篡改）是一对——' +
          '前者对应 Sniffer，后者对应 Intruder。也就是说它从一开始就不只是记录，还要能改。',
          '目标平台是 <b>macOS / iOS / Android 三端</b>，而不是只做 Android——这解释了它为什么必然选择 Frida：' +
          '只有跨平台的 instrumentation 框架才能用一套架构覆盖三个平台的不同 API 面。',
          '技术底座是 <b>Frida</b>，README 里专门致敬了 Frida 作者 Ole André Vadla Ravnås，并写明「这个项目因他而成为可能」。'
        ],
        method: [
          '选定观测策略：<b>监控系统 API 调用</b>，而不是去理解每个 App 的业务算法。因为 API 集合有限、稳定、跨样本通用。',
          '用 Frida 作为统一的 instrumentation 底座，一次解决「怎么在目标进程里执行我们的代码」这个问题。',
          '把能力拆成「观测」与「篡改」两条线：Sniffer 只读地拦截并记录 API 调用；Intruder 在拦截点上修改数据、观察 App 行为变化。',
          '为降低使用门槛，把注入问题也一起解决掉：APK Builder 生成「可检查」的 APK，让没有 root 的设备也能跑起来。',
          '在 Android 侧额外提供 Tracer，自动枚举并 trace Java 类与方法及其参数类型——' +
          '这一步是「不用事先知道目标用了什么类」的关键，也是覆盖面的来源。',
          '整体作为安全测试/性能剖析工具发布，在 Black Hat Arsenal 公开演示，面向授权测试场景。'
        ],
        result:
          '<p>项目成型并公开，被 Black Hat US-16 / EU-16 Arsenal 收录，仓库在 GitHub 上长期维护到 2023 年，' +
          '累计约 1.6k star、279 fork，采用 Apache-2.0 协议。</p>' +
          '<p>它证明了一件事：<b>「监控 API 调用」这个抽象是站得住的</b>——一套架构可以跨 macOS / iOS / Android 三个平台复用，' +
          '并且能同时承载观测与篡改两类用途。</p>',
        terms: ['API 监控', 'Instrumentation', 'Frida', 'Sniffer / Intruder', 'Java Tracer', 'Black Hat Arsenal', '框架层观测点'],
        limits:
          '<p>下面这些局限里，一部分是 README 与仓库元数据直接可查的，一部分是该技术路线的结构性代价，我把两者分开说。</p>' +
          '<p><b>可查的事实：</b>① 仓库<b>已归档</b>（GitHub API 返回 <span class="mono">"archived": true</span>），' +
          '最后一次 push 是 <b>2023-05-01</b>；② 主要语言是 <b>JavaScript</b>（Frida 脚本语言的必然结果）；' +
          '③ 由于构建与运行都依赖 Frida，<b>它继承 Frida 的全部可检测特征</b>——进程里会多出模块、线程与内存特征，' +
          '目标可以直接枚举到。</p>' +
          '<p><b>结构性的代价（不是这个项目的失误，是这条路线的天花板）：</b>' +
          '④ 观测点在<b>系统 API 这一层</b>，因此「App 自己实现的算法」它看不见——这正好是本章要处理的问题；' +
          '⑤ 三端兼容意味着它必须在各个平台的 API 面上做最大公约数，深度上必然让位于「一个平台做到极深」的方案。</p>',
        analysis:
          '<p><b>用 13.1 的五层框架拆它：AppMon 明确选了 ②③④ 这三个「框架层」位置，一次覆盖了跨平台的全部 API 面。</b>' +
          '这是一个非常理性的工程决策：它的目标用户是安全测试人员，需要的是「快速知道这个 App 干了什么」，' +
          '而不是「把某个 App 的密钥挖出来」。所以它用「覆盖广度」换掉了「观测精度」。</p>' +
          '<p>这个取舍在 13.1 的选点规则里对应得很直白：<b>要覆盖面，选框架层。</b>AppMon 就是这条规则做到极致的样子——' +
          '连部署问题（未 root / 未越狱）都用「重新打一个可检查的包」解决了，为的就是让覆盖面不被使用门槛吃掉。</p>' +
          '<p>但它的边界同样清楚，而且这个边界正是本章存在的理由：' +
          '<b>它能告诉你「这个 App 调用了 SHA-1 和 AES」，但没法告诉你「密钥是这 16 个字节、明文是这个 JSON」</b>——' +
          '因为密钥与明文的交汇点不在 API 名字上，而在<b>参数里</b>。' +
          '要拿到参数，观测点就必须挪到能同时看见「算法名 + 密钥 + IV + 输入 + 输出」的位置，' +
          '也就是 13.4 要讲的那三个汇聚点。这就是本章与它<b>互补而非竞争</b>的地方。</p>' +
          '<p>最后一点，也是最值得记住的一点：<b>它的技术底座选择（Frida）决定了它的隐蔽性上限。</b>' +
          '第 18 章和本章一直在说「定制源码的收益是不引入可被检测的框架特征」，而这个案例是那句话的反面样本——' +
          '<span class="hit">用最省事的部署方式换最广的覆盖面，代价就是把「我在被分析」这件事写在了目标进程的内存里。</span>' +
          '选它还是选源码沙箱，取决于你要的是「今天下午出结果」还是「这台环境长期可用且不可被发现」。</p>',
        link: 'https://github.com/dpnishant/appmon',
        linkNote: 'HTTP 200 已核实；仓库当前状态为 archived（归档），元数据取自 GitHub API'
      }
    },

    /* ================= 13.3 ================= */
    {
      h: '13.3',
      title: '为什么改 AOSP 源码比 Frida hook 强，以及它到底贵在哪',
      intuition: {
        tag: '直觉模型 · 门口装摄像头，还是承重墙里埋线',
        body: '<p>Frida 是<b>在门口装摄像头</b>：装得快、拆得也快，房东（目标 App/系统）随时可以检查摄像头、可以拆掉它、可以在门口挂个帘子。</p>' +
              '<p>改 AOSP 源码是<b>在承重墙里埋线</b>：房子盖的时候就布好了，住在里面的人根本不知道有这回事——' +
              '但他一旦决定换一套房子（换 Android 版本），你的线得全部重埋。</p>' +
              '<p>这一节要做的判断是：<strong>你的任务值不值得为它重盖一次房子。</strong></p>'
      },
      html:
        T.note('key', '🔑 三个结构性优势，一个结构性代价',
          '<p><b>① 时序更早。</b>探针在你编译的虚拟机代码里，从进程启动的第一条指令开始就位——' +
          '不存在「attach 晚了错过了注册/初始化」的竞态。第 18 章在讲 <span class="mono">RegisterNatives</span> 时强调过这一点，' +
          '在密码学场景里同样成立：<b>有些 App 在 <span class="mono">Application.onCreate</span> 之前就已经算过一次签名了。</b></p>' +
          '<p><b>② 不受反调试影响。</b>进程里没有多出的线程、没有注入的模块、没有可枚举的框架特征。' +
          '目标扫 <span class="mono">/proc/self/maps</span>、扫线程名、检查函数序言，都发现不了你。</p>' +
          '<p><b>③ 能改内部实现。</b>你可以直接在算法实现内部记录中间状态（第几轮、状态矩阵长什么样）——' +
          '这是任何外部 hook 都够不到的位置。</p>' +
          '<p><b>代价只有一个，但它很重：版本绑定。</b>AOSP 源码随版本演进，插桩点要跟着重新定位。' +
          '这不是「偶尔维护一下」，而是<b>每换一个目标版本就要重做一遍适配</b>。这一点直接接上<a href="ch1-fart10.html">第 26 章</a>的结论。</p>') +
        T.grid(2, [
          '<div class="card"><div class="card-title">✅ 值得走这条路的信号</div>' +
          '<p>· 任务需要<b>长期、稳定、可重复</b>的观测能力，不是一次性看看<br>' +
          '· 目标会主动检测分析环境（有反调试、有完整性校验）<br>' +
          '· 你要观测的东西<b>发生在 hook 框架能够介入之前</b><br>' +
          '· 你需要的是参数级信息（密钥、IV、明文），而且样本量不小</p></div>',
          '<div class="card"><div class="card-title">⚠️ 不值得的信号</div>' +
          '<p>· 只想确认「这个方法有没有被调用」——一次 Frida 就够<br>' +
          '· 目标版本还在频繁变动，你的适配永远追不上<br>' +
          '· 样本只有一个，且只分析一次<br>' +
          '· 你没有可控的设备（刷机失败就没有回滚手段）</p></div>'
        ]) +
        T.note('warn', '⚠️ 与第 26 章的呼应：版本绑定比你想的更麻烦',
          '<p>第 26 章讲过 ART 的版本演进史。这里补一条对自吐沙箱最要命的细节：' +
          '<b>从 Android 12 起，ART 变成 APEX 模块，可以独立于系统版本升级</b>——' +
          '于是「系统版本」不再等于「ART 版本」，你按 <span class="mono">ro.build.version.release</span> 选的源码分支，' +
          '可能跟设备上真正跑的那个 ART 不是一回事。</p>' +
          '<p>做沙箱之前必须先确认三件事：设备的系统版本、ART 模块的实际版本、以及你要改的那个类<b>到底在不在你要编译的模块里</b>。' +
          '第三点最容易翻车——密码学 API 的门面类在 <span class="mono">libcore</span>（Java 库）里，' +
          '而不是在 <span class="mono">art</span> 里，两者是不同的编译产物。<span class="pill warn">待核实</span>：' +
          '具体的模块名、jar 名与打包方式随版本变化，请在本地源码树里确认后再动手。</p>'),
      term: {
        title: '从源码到可用沙箱：一条概念层的流程（每一步的失败信号都标出来了）',
        lines: [
          { t: 'd', s: '# 步骤 1：先确定「你要改的东西在哪」——这一步不做，后面全是白工' },
          { t: 'p', s: 'adb shell getprop ro.build.version.release && getprop ro.build.version.sdk', note: '<b>记录系统版本。</b>这是选源码分支的依据，但它<b>不等于</b> ART 的版本（APEX 模块化之后两者可以独立升级）。' },
          { t: 'p', s: 'adb shell getprop | grep -i -E "art|apex"', note: '<b>再看 ART 模块的实际版本。</b>如果这一步拿不到有用信息，说明你的设备权限不够或属性名不同——<b>先解决这个，别急着下载源码</b>。<span class="pill warn">待核实</span>：属性名随版本/厂商变化。' },
          { t: 'd', s: '# 步骤 2：在你的源码树里定位插桩点（顺序很重要）' },
          { t: 'p', s: 'grep -rn "class MessageDigest" libcore/', note: '<b>先找门面类。</b>密码学 API 的门面类通常位于 libcore 的 ojluni 目录下；<b>具体路径随版本变化</b> <span class="pill warn">待核实</span>，用类名搜比记路径可靠得多。' },
          { t: 'o', s: 'libcore/ojluni/src/main/java/java/security/MessageDigest.java' },
          { t: 'p', s: 'grep -rn "engineUpdate\\|engineDoFinal" libcore/ojluni/src/main/java/java/security/ libcore/ojluni/src/main/java/javax/crypto/', note: '<b>再找 SPI 层的钩子。</b><span class="mono">engineXxx</span> 是门面类转发给具体实现的入口。三个类（MessageDigest / Cipher / Mac）的钩子名字相近但不同，别记混。<span class="pill warn">待核实</span>：Cipher 与 Mac 的 SPI 方法集合与命名随 JDK 版本对齐情况不同。' },
          { t: 'w', s: 'warning: 你可能搜到「门面类已经把实现交给 native」的版本', note: '<b>这是最常见的路径幻觉。</b>某些版本里门面类只是薄薄一层转发，真正的实现在 Provider 的 SPI 子类里。' +
              '<b>对策：把「门面类」和「SPI 实现类」都当成候选插桩点，先用最外层确认命中，再决定是否下沉。</b>' },
          { t: 'd', s: '# 步骤 3：插桩——只读、轻量、可关闭' },
          { t: 'p', s: 'vim <上一步定位到的文件>', note: '<b>三条纪律（与第 18 章相同，这里再强调一次）：</b>只读不改（不得影响控制流与返回值）、轻量（不在高频/持锁路径做重 IO）、可关闭（用于对照验证）。' },
          { t: 'd', s: '# 步骤 4：只编你改的那个模块（不要全量编 AOSP）' },
          { t: 'p', s: 'source build/envsetup.sh && lunch <你的产品>', note: '<b>选对产品。</b>编错产品会导致产物与设备不匹配，刷进去直接开不了机。' },
          { t: 'p', s: 'm <受影响的模块>   # 注意：改 libcore 与改 art 编译的不是同一个目标', note: '<b>关键效率点：只编受影响的模块。</b>全量编译动辄数小时，插桩迭代根本跑不动。' +
              '要编哪个模块，取决于你上一步把探针放在了哪里——这也是「先定位再动手」的第二个理由。<span class="pill warn">待核实</span>：模块名随版本变化。' },
          { t: 'e', s: 'error: 依赖缺失 / 找不到头文件 / 找不到符号', note: '<b>最常见的三类失败。</b>多半是没 <span class="mono">lunch</span>、环境变量没 source、或者改的文件不属于当前编译目标。' +
              '看到这类错误先回查「我改的文件属于哪个模块」，而不是去补依赖。' },
          { t: 'd', s: '# 步骤 5：推入设备并生效（这一步风险最高）' },
          { t: 'p', s: 'adb root && adb remount && adb push <产物> <对应位置>', note: '<b>务必先备份原文件。</b>这是系统关键组件，推错会卡开机。<b>强烈建议先在模拟器或可无损重刷的设备上验证。</b>32/64 位产物路径不同，别推错。' },
          { t: 'w', s: 'warning: 修改系统分区有变砖风险，请确保有回滚手段', note: '<b>不是客套话。</b>做沙箱的第一天就该准备好「一键回到原状」的镜像或备份，否则一次失败的实验会中断你一整周的进度。' },
          { t: 'd', s: '# 步骤 6：验证插桩是否真的生效（对照实验）' },
          { t: 'p', s: 'adb logcat | grep <你的标签>', note: '<b>验证信号：日志出现你的标记。</b>没有输出时按这个顺序回查：<b>① 产物真的重新生成了吗 → ② 推入的文件真的生效了吗（可以加一行启动时必打的日志来确认）→ ③ 目标 App 真的调用了密码学 API 吗。</b>' },
          { t: 'o', s: '[MD-TRACE] MD5 update len=11' },
          { t: 'o', s: '[MD-TRACE] MD5 digest = b94dee2184b1ab61baa11fd73d62fcf4', note: '<b>看到这一行，最小闭环就通了。</b>接下来才是本章真正的重点：怎么把这类日志变成结构化的、可复算的分析输入。' },
          { t: 'd', s: '# 步骤 7：把日志从 logcat 搬到文件（13.7 的内容）' },
          { t: 'p', s: '# 先把探针写进内存缓冲，再由独立线程批量落盘', note: '<b>不要在插桩点直接写文件。</b>密码学调用可能在高频路径上，同步 IO 会把 App 卡死，而且会引入可被检测的耗时特征。' }
        ]
      },
      after: T.note('', '💡 这一节真正要你记住的判断',
        '<p>「定制源码更强」这句话本身没意义——<b>强在「观测点位于内部」，贵在「跟着版本走」</b>。' +
        '所以决策变量不是「哪种技术更高级」，而是<b>「这个任务需要多长时间的稳定观测」</b>。</p>' +
        '<p>另外记住那个顺序：<b>先定位（我要改的东西在哪个模块），再插桩，最后才谈编译。</b>' +
        '跳过第一步的人，会在编译失败上耗掉大部分时间，而且不知道自己错在哪一层。</p>')
    },

    /* ================= 13.4 ================= */
    {
      h: '13.4',
      title: '源码地图：MessageDigest / Cipher / Mac 三个汇聚点',
      html:
        '<p>要在源码里插桩，你得知道去哪儿插。好消息是：Java 密码学 API 的结构非常规整，' +
        '<b>几乎所有标准用法都要经过三个门面类</b>——它们是「参数汇聚的地方」，也是本章全部的插桩目标。</p>' +
        T.tbl(['门面类（汇聚点）', '你要盯住的方法', '插上去能拿到什么'], [
          ['<span class="mono">java.security.MessageDigest</span>',
           '<span class="mono">update(byte[])</span> / <span class="mono">update(ByteBuffer)</span> / <span class="mono">update(byte[],int,int)</span> / <span class="mono">digest()</span>',
           '<b>算法名</b>（<span class="mono">getAlgorithm()</span>）、<b>每一次更新的原始字节</b>、<b>最终摘要</b>。哈希没有密钥，所以记录的重点是「输入是怎么拼起来的」'],
          ['<span class="mono">javax.crypto.Cipher</span>',
           '<span class="mono">init(int,Key)</span> / <span class="mono">init(int,Key,AlgorithmParameterSpec)</span> / <span class="mono">update(...)</span> / <span class="mono">doFinal(...)</span>',
           '<b>算法名与变换串</b>（如 <span class="mono">AES/CBC/PKCS5Padding</span>）、<b>加密/解密方向</b>、<b>密钥字节</b>、<b>IV</b>、<b>明文与密文</b>。这是本章信息密度最高的一个点'],
          ['<span class="mono">javax.crypto.Mac</span>',
           '<span class="mono">init(Key)</span> / <span class="mono">init(Key,AlgorithmParameterSpec)</span> / <span class="mono">update(...)</span> / <span class="mono">doFinal(...)</span>',
           '<b>算法名</b>（<span class="mono">HmacSHA1</span> / <span class="mono">HmacSHA256</span>）、<b>密钥字节</b>、<b>被认证的消息</b>、<b>MAC 值</b>']
        ]) +
        T.note('key', '🔑 结构：门面类与 SPI 的分工',
          '<p>每个门面类背后都有一套 <b>SPI</b>（Service Provider Interface）：' +
          '<span class="mono">MessageDigestSpi</span> / <span class="mono">CipherSpi</span> / <span class="mono">MacSpi</span>。' +
          '门面类负责「找谁来算 + 参数校验 + 状态维护」，SPI 子类负责「真的去算」。</p>' +
          '<p>这个分工决定了插桩策略：</p>' +
          '<p><b>门面类</b>是所有调用的必经之路（只要目标用的是 JCA API），命中率最高，但你看不到「是谁在算」；' +
          '<b>SPI 层</b>能告诉你实际实现是谁，但如果目标用了自定义 Provider，那个实现类可能根本不在你的源码树里。</p>' +
          '<p>所以实战顺序是：<b>先插门面类确认有没有调用，再根据需要在 SPI 层细分。</b>' +
          '13.6 的决策情境就是这条顺序被跳过之后会发生的事。</p>') +
        T.note('warn', '⚠️ 三个「插了却什么都没打印」的常见原因',
          '<p><b>① 目标是自研实现。</b>很多加固 App 会自己写一个 <span class="mono">Md5Utils</span>，' +
          '里面是纯 Java 或 native 的 MD5——<b>根本不经过 JCA</b>。此时门面类再完美也没有调用记录。</p>' +
          '<p><b>② 目标用了自定义 Provider。</b>它仍然会经过门面类（所以你至少能看到算法名），' +
          '但如果你只插在 <b>AOSP 自带的那几个 SPI 实现</b>里，就会 0 命中。</p>' +
          '<p><b>③ 你插的是「另一个类」。</b>Android 里同时存在 <span class="mono">java.security.MessageDigest</span> 与 ' +
          '各种第三方封装（Apache Commons Codec 的 <span class="mono">DigestUtils</span> 等），' +
          '后者最终仍然会落到前者——但如果你只插了第三方封装，覆盖面就取决于目标用不用它。</p>' +
          '<p><b>区分方法很简单：把探针插到最外层的门面类，它的命中与否直接回答「目标走不走 JCA」。</b>' +
          '这就是 13.1 说的「用便宜的探针先二分」。</p>') +
        '<p>下面把 <span class="mono">Cipher</span> 的一次完整加密拆开，看每个字段是在哪一步出现的。' +
        '注意右侧的寄存器面板——它记的就是你探针最终要写进日志的东西。</p>',
      stage: {
        title: 'Cipher 的一次加密：key / IV / 明文 / 密文 分别在哪一步到手',
        speed: 1600,
        render:
          '<div class="grid2">' +
            '<div>' +
              '<div class="card-title">调用序列（门面类这一层）</div>' +
              '<div class="memgrid">' +
                '<div class="memrow"><span class="addr">step 1</span><span class="cell" id="c0">Cipher.getInstance(...)</span></div>' +
                '<div class="memrow"><span class="addr">step 2</span><span class="cell" id="c1">init(mode, key, iv)</span></div>' +
                '<div class="memrow"><span class="addr">step 3</span><span class="cell" id="c2">update(part1)</span></div>' +
                '<div class="memrow"><span class="addr">step 4</span><span class="cell" id="c3">update(part2)</span></div>' +
                '<div class="memrow"><span class="addr">step 5</span><span class="cell" id="c4">doFinal(tail)</span></div>' +
              '</div>' +
            '</div>' +
            '<div>' +
              '<div class="card-title">探针要记下的字段</div>' +
              '<div class="regs" style="flex-direction:column;align-items:stretch">' +
                '<span class="reg" id="f_algo"><b>transform</b>=—</span>' +
                '<span class="reg" id="f_mode"><b>opmode</b>=—</span>' +
                '<span class="reg" id="f_key"><b>key</b>=—</span>' +
                '<span class="reg" id="f_iv"><b>iv</b>=—</span>' +
                '<span class="reg" id="f_in"><b>input</b>=—</span>' +
                '<span class="reg" id="f_out"><b>output</b>=—</span>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div style="margin-top:12px"><span class="pill" id="cvd">等待播放</span></div>',
        reset: () => {
          ['c0', 'c1', 'c2', 'c3', 'c4'].forEach(id => CLS(id, 'cell'));
          SET('c0', 'Cipher.getInstance(...)');
          SET('c1', 'init(mode, key, iv)');
          SET('c2', 'update(part1)');
          SET('c3', 'update(part2)');
          SET('c4', 'doFinal(tail)');
          SET('f_algo', '<b>transform</b>=—'); SET('f_mode', '<b>opmode</b>=—');
          SET('f_key', '<b>key</b>=—');   SET('f_iv', '<b>iv</b>=—');
          SET('f_in', '<b>input</b>=—');  SET('f_out', '<b>output</b>=—');
          CLS('cvd', 'pill'); SET('cvd', '等待播放');
        },
        steps: [
          { run: () => { CLS('c0', 'cell hi'); SET('f_algo', '<b>transform</b>=AES/CBC/PKCS5Padding'); },
            note: '<b>第一步拿到的是「变换串」。</b><span class="mono">getInstance("AES/CBC/PKCS5Padding")</span> 一次性告诉了你三件事：' +
                  '算法（AES）、模式（CBC）、填充（PKCS5Padding）。<b>这一行是零成本的——它就在参数里。</b>' +
                  '如果目标是 <span class="mono">getInstance("AES")</span>，那模式与填充就要靠 Provider 的默认值来决定，' +
                  '此时日志里必须补记「实际生效的模式」，否则复算时会用错。<span class="pill warn">待核实</span>：默认值由 Provider 决定，不同实现可能不同。',
            state: { '拿到': '算法 + 模式 + 填充', '位置': 'getInstance 的参数' } },
          { run: () => { CLS('c0', 'cell'); CLS('c1', 'cell hi'); SET('f_mode', '<b>opmode</b>=1 (ENCRYPT_MODE)'); SET('f_key', '<b>key</b>=4d795333637233744b65793230323421'); SET('f_iv', '<b>iv</b>=1a2b3c4d5e6f708192a3b4c5d6e7f809'); },
            note: '<b>第二步是整章最关键的一步：init。</b>密钥、IV、方向在这里同时到手。' +
                  '<span class="mono">opmode</span> 是整数常量（加密为 1、解密为 2）——' +
                  '<b>记日志时一定要把它翻译成文字</b>，否则三个月后你看到一堆 <span class="mono">"mode":1</span> 得回去查常量表。' +
                  '密钥从 <span class="mono">key.getEncoded()</span> 取；IV 在 <span class="mono">AlgorithmParameterSpec</span> 里，' +
                  '要按类型分派：<span class="mono">IvParameterSpec</span>（CBC/CFB/OFB）、<span class="mono">GCMParameterSpec</span>（GCM，还带 tag 长度），' +
                  '也可能是 <span class="mono">null</span>（ECB 不需要 IV）。',
            state: { '拿到': '密钥 + IV + 方向', '注意': 'opmode 要翻译成文字' } },
          { run: () => { CLS('c1', 'cell'); CLS('c2', 'cell wr'); SET('f_in', '<b>input</b>=7b22756964223a223130303836222c2276223a22322e332e31227d (27B)'); },
            note: '<b>第三步开始收输入。</b>注意 <span class="mono">update</span> 是<b>可以调用多次的</b>——' +
                  '大文件、长报文都会被分块喂进来。' +
                  '<span class="hit">日志里必须保留「分块」这个事实，不能只记最后一块</span>，' +
                  '因为分块拼接顺序错了，摘要/密文就全错（13.11L 的实验专门考这个）。',
            state: { '拿到': '第一块输入', '陷阱': 'update 可能被多次调用' } },
          { run: () => { CLS('c2', 'cell wr'); CLS('c3', 'cell wr'); SET('f_in', '<b>input</b>=（两块已累积，共 27B）'); CLS('cvd', 'pill warn'); SET('cvd', 'update 的输出可能为空——不要以为没输出就是没调用'); },
            note: '<b>第四步：又一块。</b>这里有一个非常容易误判的细节：' +
                  '<b><span class="mono">update</span> 的返回值可能是一个空数组</b>（数据还不够一个块，被内部缓冲了）。' +
                  '如果你的日志只记录「非空返回」，就会看到一片空白，误以为这个方法没被调用。' +
                  '<b>正确做法：记录调用事件本身（含入参长度），而不是记录返回值。</b>',
            state: { '陷阱': '空返回 ≠ 没调用', '对策': '记调用事件，不记返回值' } },
          { run: () => { CLS('c3', 'cell'); CLS('c4', 'cell hi'); SET('f_out', '<b>output</b>=0f4699bfad668f6fae6357bf90fe8b536b09abce7c9d13a0c9003b995b56c1a9 (32B)'); CLS('cvd', 'pill ok'); SET('cvd', '到这里，一次加密的全部关键信息都到手了'); },
            note: '<b>第五步：doFinal，输出到手。</b>密文长度是 32 字节，明文 27 字节——' +
                  '<b>多出来的 5 个字节就是填充</b>（PKCS5Padding 补齐到 16 的整数倍）。' +
                  '<span class="hit">密文长度与明文长度的关系，本身就是一条免费的证据</span>：' +
                  '密文比明文长且是块大小整数倍 → 有填充的分组模式；密文与明文等长 → 流模式或 CTR；' +
                  'GCM 还要多出认证标签的长度。',
            state: { '拿到': '密文', '可推断': '填充方式（靠长度关系）' } },
          { run: () => { ['c0', 'c1', 'c2', 'c3', 'c4'].forEach(id => CLS(id, 'cell')); CLS('cvd', 'pill acc'); SET('cvd', '复算所需的全部字段：transform + opmode + key + iv + 完整 input + output'); },
            note: '<b>收束：一条完整的 Cipher 记录应该包含什么。</b>' +
                  '<span class="mono">transform / opmode / key / iv / 累积后的完整 input / output</span>，' +
                  '再加上「属于哪个实例」和「序号」。' +
                  '<b>这六个字段凑齐，你就能在任何语言、任何平台上把这次运算重放一遍——不需要读一行汇编。</b>',
            state: { '最小完整记录': '6 个字段', '用途': '跨语言重放' } }
        ]
      },
      quiz: {
        id: 'q24-2', chapter: 24, answer: [0, 2],
        stem: '<b>多选：</b>你把探针插在 <span class="mono">java.security.MessageDigest</span> 的门面方法上。下面哪些说法是正确的？',
        options: [
          { t: '只要目标使用标准 JCA 哈希 API，无论它用的是哪个 Provider，都会经过这个门面类', why: '正确。门面类是 JCA 的入口，Provider 的选择发生在门面类内部，调用方无法绕过它（除非不用 JCA）。这正是它命中率最高的原因。' },
          { t: '插在门面类上就能看到实际是哪个实现类在算，因此插桩点已经完备', why: '错误。门面类不告诉你实现是谁；要看实现类名必须下沉到 SPI 层或去查 Provider 的解析结果。这正是「插了却没日志」的常见误判来源。' },
          { t: '如果目标自己实现了一个纯 Java 的 MD5，这个探针会一条记录都没有', why: '正确。自研实现不经过 JCA，门面类根本没有被调用。这种 0 命中不是探针的 bug，而是关于目标的一条有效信息。' },
          { t: '把探针插在门面类上会改变目标的行为，因为门面类参与了参数校验', why: '错误。只要遵守「只读不改」的纪律（不修改入参、不影响返回值、不改变状态），插桩不会改变行为。参数校验逻辑本身也不受影响。' }
        ],
        explain: '<b>门面类的价值是「必经之路」，局限是「不知道谁在算」。</b>' +
                 '这两句话决定了正确的插桩顺序：<b>先用门面类回答「目标走不走 JCA」，再用 SPI 层回答「是谁在算」。</b><br><br>' +
                 '选项 B 之所以危险，是因为它把「我已经看到了我想看的东西」当成了「我已经看到了全部」。' +
                 '选项 D 则混淆了「插桩」与「改写」——本章和<a href="ch32-art-sandbox.html">第 18 章</a>反复强调的纪律就是：' +
                 '<b>探针只旁观，不参与。</b>'
      }
    },
    /* ================= 13.5 ================= */
    {
      h: '13.5',
      title: '手把手：给哈希算法做一个自吐沙箱',
      html:
        '<p>这一节把探针真正写出来。哈希是最好的练手对象——它没有密钥、状态机简单，' +
        '但<b>几乎所有插桩的坑都在它身上</b>：多重重载、分块更新、ByteBuffer 入参、状态复位。' +
        '把哈希这一关过了，13.6 的 Cipher 只是多几个字段。</p>' +
        T.note('key', '🔑 插桩的五个动作',
          '<p><b>① 选点</b>（插在哪个方法上）→ <b>② 取参数</b>（怎么把 Java 参数安全地读成字节）→ ' +
          '<b>③ 维护状态</b>（分块调用怎么拼、什么时候清）→ <b>④ 取输出</b>（什么能读、什么绝对不能碰）→ ' +
          '<b>⑤ 打日志</b>（怎么做到又全又轻）。</p>' +
          '<p>其中 <b>④ 是最容易犯致命错误的一步</b>，下面会专门讲。</p>') +
        T.tbl(['要点', '做法', '不做会怎样'], [
          ['三个 update 重载都要覆盖',
           '<span class="mono">update(byte[])</span>、<span class="mono">update(byte[],int,int)</span>、<span class="mono">update(ByteBuffer)</span> 各插一处',
           '<b>只插 byte[] 版本会漏掉 ByteBuffer 调用</b>——而用 <span class="mono">ByteBuffer</span> 的代码在真实 App 里很常见（NIO、序列化库、部分加密库内部都会用）'],
          ['<span class="mono">off/len</span> 不能忽略',
           '读入参时按 <span class="mono">(array, off, len)</span> 三元组切片，而不是整个数组',
           '把「只用了后 16 字节」当成「整个数组都是输入」，日志里的明文会多出一段本不属于它的数据'],
          ['<span class="mono">ByteBuffer</span> 要用 <span class="mono">duplicate()</span> 读',
           '先 <span class="mono">dup = buffer.duplicate()</span>，再按 <span class="mono">remaining()</span> 拷出字节',
           '<b>直接读原 buffer 会移动它的 position</b>——你改变了目标的行为；而对 DirectBuffer 调 <span class="mono">array()</span> 会直接抛异常'],
          ['按实例累积分块',
           '以「这个 MessageDigest 对象」为 key 维护一份缓冲，每次 update 追加并编号',
           '分块信息丢失，你只看到三块互不相关的字节，无法判断拼接顺序'],
          ['<span class="mono">digest()</span> / <span class="mono">reset()</span> 之后必须清空缓冲',
           '在这两个方法里清掉该实例累积的数据',
           '下一个摘要会把上一个的输入一起带上，日志与结果对不上'],
          ['日志先写内存，异步落盘',
           '插桩点只做「拷贝必要字节 + 入队」，落盘交给独立线程',
           '同步 IO 拖慢目标 App，甚至引入可被检测的耗时特征（13.7 有完整方案）']
        ]) +
        T.note('bad', '🚫 一个会直接破坏目标行为的操作：不要为了「看看当前状态」去调 digest()',
          '<p>这条必须单独拎出来说。很多人写哈希探针时会想：「我想在每个 update 之后看看当前算到哪了」，' +
          '于是顺手调用一次 <span class="mono">digest()</span> 把中间值取出来。</p>' +
          '<p><b>这是一个破坏性操作。</b>按 JCA 的约定，<span class="mono">digest()</span> 在计算完摘要之后' +
          '<b>会把摘要状态复位</b>（等价于随后调用了一次 <span class="mono">reset()</span>）。' +
          '你插进去的那一次调用，会把目标自己后续的摘要结果<b>完全改掉</b>——' +
          'App 的签名会算错，而你会以为是自己的日志写错了。</p>' +
          '<p><b>正确的做法是让目标自己走到 <span class="mono">digest()</span>，你在那里读它的返回值。</b>' +
          '如果你想观测中间状态，只能对内部状态做<b>只读拷贝</b>（如果实现允许），绝不能调用任何会改变状态的方法。</p>' +
          '<p>这就是第 18 章那条纪律「只读不改」在密码学场景里的具体形态：' +
          '<b>不是「别写内存」，而是「别调用任何有副作用的方法」。</b></p>') +
        '<p>下面把这一步一步走完。注意每一步的「状态」栏——那就是探针要维护的东西。</p>',
      stepper: {
        title: '给 MessageDigest 插一条探针：从选点到落盘',
        lines: [
          { code: '<span class="c">// ① 选点：门面类的三个 update 重载 + digest + reset</span>\n' +
                  '<span class="c">// 文件名与类结构随 AOSP 版本变化 <span class="pill warn">待核实</span></span>\n' +
                  '<span class="k">public</span> <span class="k">void</span> <span class="f">update</span>(<span class="k">byte</span>[] input, <span class="k">int</span> offset, <span class="k">int</span> len) {',
            note: '<b>先定选点。</b>为什么选门面类而不是 SPI？因为门面类是所有 JCA 调用的必经之路，' +
                  '插一处就能覆盖全部 Provider。注意这里是 <span class="mono">(byte[], int, int)</span> 那个重载——' +
                  '<b>只插它是错的，另外两个重载也要覆盖</b>，但它们通常会转到这个实现上，所以可以把探针放在这一处，' +
                  '前提是你确认过转发关系。<span class="pill warn">待核实</span>：不同版本的重载转发关系可能不同。',
            state: { '阶段': '① 选点', '插桩位置': '门面类 public 方法' } },
          { code: '  <span class="t">MessageDigest</span> self = <span class="k">this</span>;\n' +
                  '  <span class="t">String</span> algo = <span class="f">getAlgorithm</span>();\n' +
                  '  <span class="c">// algo = "MD5" / "SHA-1" / "SHA-256" ...</span>',
            note: '<b>② 取算法名，只要一次调用。</b><span class="mono">getAlgorithm()</span> 返回的是注册时用的名字，' +
                  '通常就是 <span class="mono">"MD5"</span>、<span class="mono">"SHA-1"</span> 这类标准名。' +
                  '<b>把它记进每一条日志</b>，而不是只在第一条记——否则日志被截断或按行 grep 时，你会丢掉上下文。',
            state: { '阶段': '② 取参', 'algo': '"MD5"' } },
          { code: '  <span class="k">byte</span>[] chunk = <span class="k">new</span> <span class="k">byte</span>[len];\n' +
                  '  <span class="t">System</span>.<span class="f">arraycopy</span>(input, offset, chunk, <span class="n">0</span>, len);',
            note: '<b>③ 按 <span class="mono">(off, len)</span> 切出真正被使用的那一段。</b>' +
                  '这是最容易写错的地方：入参 <span class="mono">input</span> 是一个可能被复用的缓冲区，' +
                  '<span class="mono">offset</span> 之前和 <span class="mono">offset+len</span> 之后的字节<b>不属于这次调用</b>。' +
                  '直接记录整个数组，你的日志里就会出现「不属于这次运算的字节」——' +
                  '而这类噪音在复算时会让你怀疑人生。',
            state: { '阶段': '③ 取入参', '长度': 'len（不是 input.length）' } },
          { code: '<span class="c">// ByteBuffer 形态：必须 duplicate，不能动原 buffer</span>\n' +
                  '<span class="t">ByteBuffer</span> dup = buffer.<span class="f">duplicate</span>();\n' +
                  '<span class="k">byte</span>[] chunk = <span class="k">new</span> <span class="k">byte</span>[dup.<span class="f">remaining</span>()];\n' +
                  'dup.<span class="f">get</span>(chunk);\n' +
                  '<span class="c">// 注意：不要用 buffer.array()</span>',
            note: '<b>④ <span class="mono">ByteBuffer</span> 是第二个大坑。</b>' +
                  '<span class="mono">duplicate()</span> 创建一个共享内容但<b>位置独立</b>的视图——' +
                  '你在副本上 <span class="mono">get()</span>，原 buffer 的 position 一动不动，目标行为不受影响。' +
                  '而 <span class="mono">buffer.array()</span> 有两个问题：' +
                  '<b>①</b> 对 DirectByteBuffer 会抛 <span class="mono">UnsupportedOperationException</span>；' +
                  '<b>②</b> 即使能拿到 backing array，你也分不清哪一段是这次的有效数据（要靠 position/limit）。' +
                  '<b>读 <span class="mono">remaining()</span> 个字节，永远是对的。</b>',
            state: { '阶段': '③ 取入参（ByteBuffer）', '关键': 'duplicate + remaining' } },
          { code: '<span class="c">// ⑤ 按实例累积：这份输入属于哪个 MessageDigest 对象</span>\n' +
                  '<span class="t">Rec</span> r = bufferOf(self);   <span class="c">// key = 实例标识</span>\n' +
                  'r.<span class="f">append</span>(chunk);\n' +
                  'r.seq++;\n' +
                  '<span class="c">// 日志：{"algo":"MD5","ev":"update","seq":2,"len":29,"in":"..."}</span>',
            note: '<b>⑤ 维护「这次调用属于哪一次运算」。</b>一个 MessageDigest 实例上可以发生多次 update，' +
                  '把这些块按 <span class="mono">seq</span> 串起来，你才有一条完整的输入。' +
                  '<span class="hit">实例标识怎么取，是这一步唯一的难点</span>：在 Java 侧可以用 <span class="mono">IdentityHashMap</span>（以对象身份为 key，天然 GC 安全）；' +
                  '在 ART 的 C++ 侧要用对象指针，那就必须用 <span class="mono">Handle&lt;T&gt;</span> / <span class="mono">ObjPtr&lt;T&gt;</span> 这类 GC 安全句柄——' +
                  '因为 GC 会移动对象，裸指针会失效（这正是<a href="ch32-art-sandbox.html">第 18 章</a>讲过的那个坑）。',
            state: { '阶段': '④ 维护状态', 'key': '实例身份', 'seq': '2' } },
          { code: '  <span class="c">// ⑥ 绝对不要这样做：</span>\n' +
                  '  <span class="c">// byte[] mid = digest();   // ✗ 会复位状态！</span>\n' +
                  '  <span class="c">// 目标后面的签名会算错，而你会以为是日志写错了</span>',
            note: '<b>⑥ 划一条红线。</b><span class="mono">digest()</span> 有副作用：算完摘要后<b>复位状态</b>。' +
                  '为了「看一眼中间值」而调用它，等于替目标多做了一次复位。<b>这是本节最重要的一条。</b>' +
                  '如果你真的需要中间状态，只能做只读拷贝，绝不能调用任何改变状态的方法。',
            state: { '阶段': '红线', '禁止': 'digest() 用于观测' } },
          { code: '<span class="k">public</span> <span class="k">byte</span>[] <span class="f">digest</span>() {\n' +
                  '  <span class="k">byte</span>[] out = <span class="k">super</span>.<span class="f">digest</span>();\n' +
                  '  <span class="c">// ★ 探针：先让目标算完，再记录它的返回值</span>\n' +
                  '  <span class="f">emit</span>(<span class="s">"doFinal"</span>, self, out);\n' +
                  '  <span class="f">clearBuf</span>(self);\n' +
                  '  <span class="k">return</span> out;\n}',
            note: '<b>⑦ 在目标自己的 <span class="mono">digest()</span> 里读输出。</b>' +
                  '注意顺序：<b>先调用原有实现拿到结果，再记录</b>，最后才清理累积缓冲。' +
                  '记录用的是返回值 <span class="mono">out</span>（JCA 约定它是一份新数组，可以安全持有），' +
                  '而不是内部状态。<b>清理必须紧跟其后</b>——否则这个实例下一次运算会带上上一次的输入。',
            state: { '阶段': '⑤ 取输出', '顺序': '先算 → 再记 → 后清' } },
          { code: '  <span class="c">// ⑧ reset() 也要清：目标可能不等 digest 就复位</span>\n' +
                  '<span class="k">public</span> <span class="k">void</span> <span class="f">reset</span>() {\n' +
                  '  <span class="k">super</span>.<span class="f">reset</span>();\n' +
                  '  <span class="f">clearBuf</span>(self);\n}',
            note: '<b>⑧ 别漏掉 <span class="mono">reset()</span>。</b>目标完全可能调用 <span class="mono">reset()</span> 来复用同一个实例' +
                  '（比如一个工具类里的静态 MessageDigest），此时不会有 <span class="mono">digest()</span>。' +
                  '不清理的话，下一轮运算的输入里会混进上一轮的残留——<b>这种错误在日志上看起来非常像「目标加了盐」，会把你的方向带偏。</b>',
            state: { '阶段': '④ 状态清理', '触发点': 'digest() 与 reset()' } },
          { code: '<span class="c">// ⑨ 落盘：插桩点只入队，不做 IO</span>\n' +
                  '<span class="f">enqueue</span>(<span class="s">"{\\"pid\\":8421,\\"t\\":\\"MessageDigest\\","</span>\n' +
                  '        + <span class="s">"\\"algo\\":\\"MD5\\",\\"ev\\":\\"doFinal\\","</span>\n' +
                  '        + <span class="s">"\\"out\\":\\""</span> + <span class="f">hex</span>(out) + <span class="s">"\\"}"</span>);',
            note: '<b>⑨ 插桩点只做「拷贝 + 入队」这一件事。</b>JSON 拼装可以在这里做（便宜），' +
                  '但<b>写文件、打 logcat 这类 IO 动作必须交给独立线程</b>。' +
                  '原因在 13.7 会展开：密码学调用可能在高频路径上，同步 IO 会把 App 卡到不可用，' +
                  '而且耗时异常本身就是一个可被检测的特征。',
            state: { '阶段': '⑤ 打日志', '纪律': '插桩点不做 IO' } },
          { code: '<span class="c"># 产物：一行一条，可以直接 grep / 复算</span>\n' +
                  '<span class="c"># {"pid":8421,"t":"MessageDigest","algo":"MD5",</span>\n' +
                  '<span class="c">#  "ev":"update","seq":1,"len":11,"in":"757365723d616c69636526"}</span>',
            note: '<b>收尾：检查清单。</b>① 三个 update 重载都覆盖了吗；② <span class="mono">off/len</span> 有没有用对；' +
                  '③ ByteBuffer 是不是用 <span class="mono">duplicate()</span> 读的；④ 分块有没有按实例累积并编号；' +
                  '⑤ <span class="mono">digest()</span> 和 <span class="mono">reset()</span> 有没有清缓冲；' +
                  '⑥ 有没有任何地方调用了会改变状态的方法。' +
                  '<b>这六条全部为「是」，你的哈希探针就是可用的了。</b>',
            mem: '{"pid":8421,"t":"MessageDigest","algo":"MD5","ev":"update","seq":1,"len":11,"in":"757365723d616c69636526"}\n' +
                 '{"pid":8421,"t":"MessageDigest","algo":"MD5","ev":"update","seq":2,"len":29,"in":"74733d31373030303030303030267369676e5f6b65793d733363723374"}\n' +
                 '{"pid":8421,"t":"MessageDigest","algo":"MD5","ev":"doFinal","out":"b94dee2184b1ab61baa11fd73d62fcf4"}',
            state: { '产物形态': 'JSONL', '可复算': '✓' } }
        ]
      },
      after: T.note('ok', '✅ 这一节的收获',
        '<p>你现在有了一个<b>能自证正确</b>的哈希沙箱：日志里有算法名、完整的输入（分块保留）、最终摘要。' +
        '<b>拿这些字段在任何语言里复算一遍，结果必须一致</b>——这个「必须一致」就是沙箱的可信度来源。</p>' +
        '<p>而 13.10L 的实验，考的就是你有没有真的会读这份日志。</p>')
    },

    /* ================= 13.6 ================= */
    {
      h: '13.6',
      title: '密码学关键信息自吐：把 Cipher 与 Mac 也拿下',
      html:
        '<p>哈希只是热身。真正值钱的是<b>带密钥的运算</b>——因为哈希的输入你本来就能猜（抓包、看代码），' +
        '而密钥是你猜不出来的东西。</p>' +
        T.note('key', '🔑 这一节的中心判断',
          '<p><b>拿到密钥之后，还原就不需要读一行汇编了。</b></p>' +
          '<p>这句话值得拆开说。逆向算法之所以难，是因为你要在汇编层面反推「输入怎么变成输出」。' +
          '但一旦你手上有了 <b>算法名 + 密钥 + IV + 明文 + 密文</b>这五样东西，' +
          '这个算法对你来说就是<b>一个已知的、可以随时重放的函数</b>——' +
          '你不必理解它的实现，甚至不必知道它被魔改过没有（标准实现算不出、自研实现算得出，这本身又是一条信息）。</p>' +
          '<p>这就是自吐沙箱相对「读汇编」和「黑盒调用」的中间位置：' +
          '<b>比读汇编便宜得多，比黑盒调用多知道一件事——密钥是什么。</b></p>') +
        T.tbl(['插桩点', '你能拿到', '你依然拿不到', '成本'], [
          ['<span class="mono">SecretKeySpec(byte[],String)</span> 构造',
           '<b>密钥字节 + 它声称的算法名</b>。这是一个极廉价且高命中的点——绝大多数对称加密都要先构造它',
           '密钥从哪来（如果是运行时派生的，你得顺着调用栈往回找）',
           '极低'],
          ['<span class="mono">IvParameterSpec(byte[])</span> 构造',
           '<b>IV 字节</b>（CBC / CFB / OFB 必需）', '它是不是每次请求都变（要按实例关联）', '极低'],
          ['<span class="mono">Cipher.init(int,Key[,spec])</span>',
           '<b>算法变换串 + 方向 + 密钥 + IV/参数</b>，四要素齐全', '实际的 SPI 实现类（要下沉一层）', '低'],
          ['<span class="mono">Cipher.doFinal(...)</span>',
           '<b>输入与输出</b>——加上前面的 init，你就有了一组完整的明密文对', '分块情况下中间块的边界（所以 update 也要记）', '低'],
          ['<span class="mono">Mac.init(Key)</span> + <span class="mono">Mac.doFinal(byte[])</span>',
           '<b>算法名 + 密钥 + 被认证的消息 + MAC 值</b>。HMAC 的密钥通常就是签名密钥，价值极高',
           '如果消息是分块喂的，需要 update 一起记', '低'],
          ['<span class="mono">Signature.initSign/update/sign</span>（非对称）',
           '私钥句柄、被签名的数据', '<b>私钥本身拿不到</b>（它可能永远不出 KeyStore）——非对称是自吐的天然边界', '低']
        ]) +
        T.grid(2, [
          '<div class="card"><div class="card-title">🔧 opmode 必须翻译成文字</div>' +
          '<p><span class="mono">Cipher.init</span> 的第一个参数是整数：加密是 <span class="mono">1</span>，解密是 <span class="mono">2</span>。' +
          '日志里写 <span class="mono">"mode":1</span> 三个月后你自己都要回去查常量表。</p>' +
          '<p>更麻烦的是：<b>解密方向同样有价值</b>。解密时的输入是密文、输出是明文，' +
          '你一样可以把整条链路复现出来。很多人只记录加密路径，结果漏掉了最重要的那条（App 里往往解密比加密更常见）。</p></div>',
          '<div class="card"><div class="card-title">🔧 实例复用：init 可以被调用很多次</div>' +
          '<p>一个 <span class="mono">Cipher</span> 对象不是「加密一次就废」——<span class="mono">doFinal</span> 之后可以重新 ' +
          '<span class="mono">init</span> 换密钥/换 IV/换方向，再继续用。</p>' +
          '<p>所以日志必须回答「这次 doFinal 用的是哪一次 init 的参数」。' +
          '<b>做法：以实例身份为 key，维护「最近一次 init」的快照，并在每条记录里带上实例 id 与线程 id。</b>' +
          '否则并发场景下你会把 A 请求的密钥配到 B 请求的密文上——' +
          '而<b>这种错误在日志里看起来完全正常，只是算不对</b>，最难排查。</p></div>'
        ]) +
        T.note('warn', '⚠️ 两处需要按版本/实现确认的细节',
          '<p><b>① IV 可能不是由调用方提供的。</b>某些模式与某些实现会在内部生成或维护 IV' +
          '（例如未显式传入 IV 参数的情况）。此时你在 <span class="mono">init</span> 的入参里只能看到 <span class="mono">null</span>。' +
          '对策是同时在 <span class="mono">doFinal</span> 之后补记一次「当前 IV」（接口上可通过 <span class="mono">getIV()</span> 获取，' +
          '但其可用性与返回时机随实现变化）。<span class="pill warn">待核实</span>：请在目标版本上实测确认。</p>' +
          '<p><b>② GCM 不是「密文 + IV」这么简单。</b>GCM 会额外产生一个认证标签（tag），长度可配置；' +
          '<span class="mono">GCMParameterSpec</span> 里带着 tag 长度。复算时漏掉 tag 长度就永远对不上。<span class="pill warn">待核实</span>：' +
          '不同 Provider 对 tag 的默认处理与拼接方式可能不同。</p>') +
        T.note('key', '🔑 一个反直觉但很有用的推论',
          '<p>既然「拿到密钥就不需要读汇编」，那么<b>自吐沙箱的价值上限，等于「目标愿意把密钥交给 Java 层」的程度</b>。</p>' +
          '<p>很多加固方案的对策正是从这里下手的：<b>密钥不落 Java 堆</b>——' +
          '要么在 native 里派生并使用，要么干脆放进 <span class="mono">KeyStore</span> 或硬件密钥库，Java 层只拿到一个句柄。' +
          '看懂这一点，你就知道 13.8 那一节的边界在哪里，也知道看到「init 的 key 参数是一个 Key 对象而不是 SecretKeySpec」时该警觉什么。</p>') +
        '<p>下面这个情境，讲的就是探针「一条都没命中」时最常见的那个解释。</p>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一',
            scenario: '<b>情境：</b>你按 13.4 的路径，在 AOSP 里那几个自带的 <span class="mono">CipherSpi</span> 实现类上插了探针，' +
                      '然后跑目标 App。结果：<br><br>' +
                      '· <span class="mono">MessageDigest</span> 的日志<b>有</b>，而且很完整（算法名、输入、摘要都对得上）；<br>' +
                      '· <span class="mono">Cipher</span> 的日志<b>一条都没有</b>；<br>' +
                      '· App 的加密功能一切正常。<br><br>' +
                      '<b>你的下一步是什么？</b>',
            choices: [
              { t: '既然 Java 层没有，说明加解密在 native 层，直接去 dump so、按第 22 章的方法搜常量', next: 'n1' },
              { t: '先在最外层的 Cipher 门面类（getInstance / init / doFinal）上补一条日志，确认它到底有没有被调用', next: 'n2' },
              { t: '把 AOSP 里所有 CipherSpi 的子类逐个插一遍，宁可多插不可漏插', next: 'n3' },
              { t: '上 Frida hook javax.crypto.Cipher，先把答案拿到手再说', next: 'n4' }
            ]
          },
          n1: {
            label: '选 A', terminal: true, verdict: 'bad',
            verdictTitle: '结论跳得太快：你手上有反例没解释',
            result: '<b>问题不在于「去 native 找」这个方向错，而在于你现在还没有证据支持它。</b><br><br>' +
                    '<b>认知根源：</b>你把「Cipher 没日志」直接读成了「加解密不在 Java 层」。但同一个 App 的 ' +
                    '<span class="mono">MessageDigest</span> 是有日志的——这说明<b>它确实在用 JCA API</b>。' +
                    '一个用 JCA 做哈希的 App，却完全不用 JCA 做加解密，这个组合是可能的，但不是最可能的解释。<br><br>' +
                    '<b>最可能的解释是：你插错了层。</b>门面类是所有 Provider 的必经之路，' +
                    '而 <span class="mono">CipherSpi</span> 的实现类有很多个——<b>目标只要用了一个你没插的实现（尤其是第三方或自定义 Provider），你就会 0 命中。</b><br><br>' +
                    '而且「去 native 找」是成本高得多的战场。在还没排除便宜解释之前进入它，是典型的用力过猛。'
          },
          n2: {
            label: '选 B', terminal: true, verdict: 'good',
            verdictTitle: '正确：一次二分，把「有没有调用」和「是谁在算」分开',
            result: '<b>这是最省时间的一步。</b>门面类是 Provider 无关的，只要目标用 JCA，' +
                    '它就一定会经过 <span class="mono">Cipher.getInstance</span> / <span class="mono">init</span> / <span class="mono">doFinal</span>。<br><br>' +
                    '<b>补上这条日志之后，你会得到两种结果之一，而两种都直接指向下一步：</b><br>' +
                    '<b>· 门面类有日志、SPI 没有</b> → 目标用的是<b>自定义 Provider 或你没覆盖的 SPI 实现</b>。' +
                    '下一步不是去 native，而是把探针从「具体 SPI 类」挪到「门面类」，或者顺着 ' +
                    '<span class="mono">getInstance</span> 记下它返回的实现类名，再去确认那个类是什么。<br>' +
                    '<b>· 门面类也没有日志</b> → 目标确实没用 JCA 做加解密。此时再去 native 才是有证据的行动。<br><br>' +
                    '<b>这个动作的本质是「把一个大问题二分成两个小问题」</b>——同样的思路在第 18 章出现过：' +
                    '遇到 <span class="mono">ClassNotFoundException</span>，先问「这个类归谁管」，而不是先怀疑类名写错。<br><br>' +
                    '<span class="hit">额外收益：门面类的日志里带着 <span class="mono">getInstance</span> 的变换串和返回的实现类名，' +
                    '这些信息本身就是你下一步定位的线索。</span>'
          },
          n3: {
            label: '选 C', terminal: true, verdict: 'bad',
            verdictTitle: '成本爆炸，而且大概率还是漏',
            result: '<b>「宁可多插不可漏插」在插桩这件事上是错的原则。</b><br><br>' +
                    '<b>第一，成本不对。</b>每个 SPI 实现都要单独插、单独编、单独维护，' +
                    '换一个 Android 版本全部重来。而收益只是「也许命中了其中一个」。<br><br>' +
                    '<b>第二，最关键的那一类你插不到。</b>如果目标是<b>自定义 Provider</b>，' +
                    '它的实现类根本不在 AOSP 源码树里——你把 AOSP 里所有子类插满，依然 0 命中。<br><br>' +
                    '<b>认知根源：</b>把「覆盖面」理解成「枚举所有已知项」，而忘了未知项（第三方实现）永远枚举不完。' +
                    '正确的覆盖面来自<b>结构性位置</b>——门面类这种「谁都绕不过去」的地方，' +
                    '而不是「把所有已知实现都抄一遍」。'
          },
          n4: {
            label: '选 D', terminal: true, verdict: 'bad',
            verdictTitle: '能拿到答案，但退掉了这条路线的全部优势',
            result: '<b>技术上当然可行——Frida hook <span class="mono">javax.crypto.Cipher</span> 是常见做法，而且很快就能出结果。</b>' +
                    '问题在于你为什么要做这台沙箱。<br><br>' +
                    '<b>认知根源：</b>遇到 0 命中就退回 hook 框架，等于<b>放弃了源码沙箱存在的唯一理由</b>：' +
                    '不引入可被检测的框架特征。如果 Frida 可以解决问题，你一开始就不该花几周去搭源码环境——' +
                    '既然搭了，说明这个任务的前提是「目标会检测分析环境」。<br><br>' +
                    '<b>那 Frida 在这里有用吗？有，但用法不同：它适合用来「快速验证一个假设」</b>——' +
                    '比如你怀疑是自定义 Provider，用 Frida 花五分钟 dump 一次 <span class="mono">getInstance</span> 的返回类名，' +
                    '验证完就撤，然后把结论落回沙箱的实现里。<br><br>' +
                    '<b>把 Frida 当诊断工具，而不是当退路。</b>这个区别决定了你是在两条腿走路，还是在一个坑里来回换工具。'
          }
        }
      }
    },

    /* ================= 13.7 ================= */
    {
      h: '13.7',
      title: '把日志从 logcat 升级成结构化文件，并给沙箱加一个 API',
      html:
        '<p>探针写好了、日志也能打出来了。但如果你就这样把它当成产品用，一周之内就会撞上一堵墙：' +
        '<b>logcat 不是给「结构化分析数据」用的。</b></p>' +
        T.tbl(['logcat 的问题', '具体表现', '后果'], [
          ['按行截断', '单行长度有上限，超长内容被截掉', '<b>大 buffer 的密文被截成半截</b>，而复算需要完整字节'],
          ['缓冲与丢弃', '日志缓冲区满时会丢最旧的内容', '你看到的是「日志」，但<b>你不知道中间丢了多少</b>——这比没有日志更危险'],
          ['多进程混流', '同一台设备上所有进程的日志混在一起', '分不清这条记录属于哪个进程，尤其是 App 开多进程时'],
          ['同步开销', '写入路径上的开销会直接作用到目标进程', '密码学高频调用时把 App 拖慢甚至拖死（见本节决策情境）'],
          ['字段不可寻址', '它是给人看的文本流，不是结构化数据', '想统计「这个 App 一共调了几次 AES」得写正则；想按 key 关联 init 与 doFinal 基本做不到']
        ]) +
        T.note('key', '🔑 结构化落盘的设计清单',
          '<p><b>① 格式：一行一条 JSON（JSONL）。</b>选它的理由很实际——' +
          '可以 <span class="mono">grep</span>、可以流式追加、单行写入天然原子（不会出现半行）、' +
          '而且几乎每种语言都能直接读。<b>不要用一个巨大的 JSON 数组</b>，那样每次追加都要改文件尾部。</p>' +
          '<p><b>② 路径与分文件：按进程分开。</b>App 常常有多个进程（主进程、推送、webview、隔离进程），' +
          '混在一个文件里会让你无法把「同一时刻的两次调用」关联起来。' +
          '文件名里带上 pid 与进程名，例如 <span class="mono">8421-com.example.app.jsonl</span>。</p>' +
          '<p><b>③ 写入策略：缓冲 + 批量。</b>插桩点只把记录塞进内存队列；' +
          '一个低优先级的落盘线程按批（比如每 200 条或每 500ms）追加写一次。' +
          '<b>这是把「日志开销」从「每次调用一次 IO」降到「每批一次 IO」的唯一办法。</b></p>' +
          '<p><b>④ 大 buffer：截断 + 记原长，绝不悄悄丢。</b>超出上限的内容截断，' +
          '但在记录里明确写下 <span class="mono">"len"</span>（原始长度）与 <span class="mono">"trunc":true</span>。' +
          '<b>「我知道它被截了」和「我以为它是完整的」是两种完全不同的处境。</b></p>' +
          '<p><b>⑤ 编码：hex 与 base64 各有用途。</b>需要逐字节比对、需要看结构时用 hex；' +
          '体积敏感时用 base64（约省 1/3）。<b>但要统一</b>——同一份日志里两种编码混用，是复算时最常见的低级错误来源。</p>' +
          '<p><b>⑥ 时间戳与序号：至少要有序号。</b>时间戳跨进程不可靠（时钟可能被篡改或精度不够），' +
          '而<b>单调递增的序号</b>可以做连续性检查——<b>序号断档就是「这里丢过日志」的铁证。</b></p>') +
        '<p>日志本身搞定了，还有一块经常被忽略、但它决定了沙箱是「一个日志文件」还是「一个可编程的平台」：<b>给沙箱加自定义 API</b>。</p>' +
        T.tbl(['自定义 API 形态', '做什么', '典型用途'], [
          ['开关接口', '按类别（哈希 / 加解密 / MAC / 反射）动态打开或关闭记录', '<b>只在目标进入关键流程时才开启重记录</b>，避免全程写放大'],
          ['标记接口（mark）', '让 App 侧或分析脚本在关键时刻打一条标记记录', '把「我点了登录按钮」与「这一串密码学调用」在时间轴上对齐——<b>这是最实用的一条</b>'],
          ['查询接口', '查询当前已记录条数、丢失计数、开关状态', '自动化脚本据此判断「这次运行有没有采到数据」，而不是跑完才发现是空的'],
          ['导出接口', '把内存缓冲立刻刷盘并返回文件路径', '在进程被杀之前抢救数据；也用于「按需取证」'],
          ['注入接口', '主动让沙箱用记录到的参数执行一次指定运算', '与第 23 章的主动调用合流，见 13.9']
        ]) +
        T.note('', '💡 为什么「标记接口」价值最高',
          '<p>因为自吐日志最大的问题不是「信息不够」，而是<b>「信息太多、不知道哪一条对应哪个业务动作」</b>。' +
          '一个 App 启动时可能算几十次哈希，你根本分不清哪一次是登录签名、哪一次是参数校验。</p>' +
          '<p>标记接口解决的就是这个：<b>在关键业务点主动打一条带语义的记录</b>（例如 <span class="mono">{"mk":"login_click"}</span>），' +
          '于是日志被切成了一段一段有名字的区间。' +
          '<span class="hit">这一招把「时间序列」变成了「有标签的时间序列」，后面无论是人看还是脚本处理，效率都完全不同。</span></p>') +
        '<p>最后回到落盘这条链路本身。下面这个动画演示一条记录从产生到落盘的全过程，' +
        '重点是<b>每一步都在丢东西，而好的设计会让丢失变得可见</b>。看完之后，我们再看它最容易翻车的地方：<b>把目标拖死</b>。</p>',
      stage: {
        title: '一条记录的一生：从插桩点到 JSONL 文件（含截断与丢弃）',
        speed: 1600,
        render:
          '<div class="flow-row" style="flex-wrap:wrap;gap:6px">' +
            '<span class="blk" id="p1">插桩点<br><span class="small">ART 内部</span></span>' +
            '<span class="arrow">→</span>' +
            '<span class="blk" id="p2">内存环形缓冲<br><span class="small">按进程</span></span>' +
            '<span class="arrow">→</span>' +
            '<span class="blk" id="p3">落盘线程<br><span class="small">批量 flush</span></span>' +
            '<span class="arrow">→</span>' +
            '<span class="blk" id="p4">JSONL 文件</span>' +
          '</div>' +
          '<div class="regs" style="margin-top:12px">' +
            '<span class="reg" id="r_seq"><b>seq</b>=—</span>' +
            '<span class="reg" id="r_lost"><b>丢弃计数</b>=0</span>' +
            '<span class="reg" id="r_len"><b>原始长度</b>=—</span>' +
            '<span class="reg" id="r_trunc"><b>截断</b>=否</span>' +
          '</div>' +
          '<div class="memgrid" style="margin-top:12px">' +
            '<div class="memrow"><span class="addr">记录</span><span class="cell" id="rec" style="grid-column:span 8">（尚未产生）</span></div>' +
          '</div>' +
          '<div style="margin-top:12px"><span class="pill" id="gvd">等待播放</span></div>',
        reset: () => {
          ['p1', 'p2', 'p3', 'p4'].forEach(id => S(id, ''));
          SET('r_seq', '<b>seq</b>=—'); SET('r_lost', '<b>丢弃计数</b>=0');
          SET('r_len', '<b>原始长度</b>=—'); SET('r_trunc', '<b>截断</b>=否');
          SET('rec', '（尚未产生）'); CLS('rec', 'cell');
          CLS('gvd', 'pill'); SET('gvd', '等待播放');
        },
        steps: [
          { run: () => { S('p1', 'active'); SET('r_len', '<b>原始长度</b>=1048576 字节'); CLS('gvd', 'pill warn'); SET('gvd', '这一步的危险：不能在这里做 IO'); },
            note: '<b>起点：插桩点产生了一条记录，其中有一段 1MB 的密文。</b>' +
                  '<b>第一反应不该是「怎么记下来」，而是「记下来要花多少代价」。</b>' +
                  '1MB 的拷贝本身就是成本，如果再加上一次文件写入或 logcat 输出，' +
                  '这条链路上的耗时会直接体现在目标 App 的响应时间上——<b>而耗差异常本身就是可被检测的特征。</b>',
            state: { '阶段': '产生', '数据量': '1 MB', '风险': '在插桩点做 IO' } },
          { run: () => { S('p1', 'done'); S('p2', 'active'); SET('r_seq', '<b>seq</b>=18427'); CLS('gvd', 'pill'); SET('gvd', '只做拷贝 + 入队'); SET('rec', '{...省略...}'); },
            note: '<b>插桩点只做两件事：拷贝必要字节、入队。</b>注意这里已经产生了第一次「取舍」——' +
                  '<b>拷贝整个 1MB，还是只拷贝前 N 个字节？</b>前者的成本高但信息全，后者便宜但会丢内容。' +
                  '这个取舍没有标准答案，取决于你要拿日志做什么（复算需要完整字节，统计不需要）。' +
                  '<span class="hit">重要的不是选哪个，而是把选择明确写进字段里。</span>',
            state: { '阶段': '入队', '动作': '拷贝 + enqueue' } },
          { run: () => { S('p2', 'hot'); SET('r_lost', '<b>丢弃计数</b>=37'); CLS('gvd', 'pill bad'); SET('gvd', '缓冲满了：要么丢，要么拖死目标'); },
            note: '<b>关键一步：缓冲满了。</b>高频调用下，生产速度必然超过落盘速度，你只有三种选择：' +
                  '<b>① 丢最旧的</b>（保住最新，但第一批日志没了）；<b>② 丢最新的</b>（保住开头，但你可能永远看不到出问题的那一刻）；' +
                  '<b>③ 阻塞等待</b>（不丢数据，但把目标 App 拖慢甚至拖死）。' +
                  '<p><b>无论选哪个，都必须把丢弃次数记下来。</b>一个没有 <span class="mono">lost</span> 计数的沙箱，' +
                  '会让你在「日志看起来完整」的错觉下得出错误结论——<b>这比日志少更危险。</b></p>',
            state: { '阶段': '缓冲', '策略': '丢 + 计数', 'lost': '37' } },
          { run: () => { S('p2', 'done'); S('p3', 'active'); SET('r_trunc', '<b>截断</b>=是（cap=64 字节）'); SET('r_len', '<b>原始长度</b>=1048576（保留）'); CLS('gvd', 'pill warn'); SET('gvd', '截断必须显式标注，不能悄悄做'); },
            note: '<b>落盘线程取走一批，做截断与转义。</b>截断是必然的（没有沙箱能把无限大的数据全记下来），' +
                  '但<b>截断必须显式</b>：记录里同时留下 <span class="mono">原始长度</span> 和 <span class="mono">是否被截断</span>。' +
                  '<span class="hit">回想 13.10L 的实验——那条被截断的 AES 记录之所以还能救回来，' +
                  '正是因为日志诚实地告诉你「这里被截了，但长度是 16 字节」。</span>',
            state: { '阶段': '截断', 'cap': '64 字节', '保留': '原始长度' } },
          { run: () => { S('p3', 'done'); S('p4', 'active'); SET('rec', '{"seq":18427,"t":"Cipher","algo":"AES/ECB/PKCS5Padding","key":"...","out":"e605e27d...(trunc, cap=8)","outLen":16,"trunc":true}'); CLS('rec', 'cell wr'); CLS('gvd', 'pill ok'); SET('gvd', '一行一条，可 grep、可复算'); },
            note: '<b>写进 JSONL：一行一条，追加写。</b>选一行一条的理由在这一刻体现得很清楚：' +
                  '<b>追加是原子的</b>——即使进程被杀死，最多损失最后一行，不会出现「半个文件解析不了」。' +
                  '而一个巨大的 JSON 数组在追加时必然要改文件尾部，一旦中断整份日志就废了。',
            state: { '阶段': '落盘', '格式': 'JSONL', '特性': '追加写' } },
          { run: () => { ['p1', 'p2', 'p3', 'p4'].forEach(id => S(id, 'cool')); CLS('gvd', 'pill acc'); SET('gvd', '按 pid 分文件：8421-com.example.app.jsonl'); },
            note: '<b>分进程分文件。</b>文件名里带 pid 与进程名，是为了解决一个具体问题：' +
                  '<b>当你想把「同一时刻的两次调用」关联起来分析时，混流的日志是致命的。</b>' +
                  'App 开多进程很常见（推送、webview、隔离进程），而这些进程里往往都有加解密调用。',
            state: { '阶段': '落盘', '分片': 'pid + 进程名' } },
          { run: () => { CLS('gvd', 'pill ok'); SET('gvd', 'seq 连续性检查：18426 → 18427 → 18430（缺 2 条）'); SET('r_lost', '<b>丢弃计数</b>=37（与断档吻合）'); },
            note: '<b>事后校验：用 seq 做连续性检查。</b>' +
                  '<span class="hit">这是整套设计里最值钱的一步。</span>' +
                  '序号断档告诉你「这里丢过记录」，而丢失计数告诉你「丢了多少」——' +
                  '两者吻合，就说明你的模型是自洽的；两者矛盾，说明还有你没想到的丢失路径。<br>' +
                  '<b>一份可信的日志，不是「看起来完整」的日志，而是「能自证它丢了什么」的日志。</b>',
            state: { '校验': 'seq 连续性', '断档': '18427 → 18430', '吻合': '✓' } },
          { run: () => { CLS('gvd', 'pill acc'); SET('gvd', '结论：日志的可信度来自自证，不来自齐全'); },
            note: '<b>收尾。</b>把这一节的判断压成一句话：<b>你不可能记录一切，但你可以让「没记到的部分」变得可数。</b>' +
                  '抽出结论：<span class="mono">seq</span>（有序）、<span class="mono">len</span> + <span class="mono">trunc</span>（截断可见）、' +
                  '<span class="mono">lost</span>（丢弃可见）、<span class="mono">pid</span>（可归并）——' +
                  '这四个字段比「多记几个算法字段」重要得多。',
            state: { '四个关键字段': 'seq / len / trunc / lost', '目标': '丢失可见' } }
        ]
      },
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境二',
            scenario: '<b>情境：</b>你的沙箱在一个「批量上传图片」的 App 上跑崩了。现象是：<br><br>' +
                      '· 日志增长速度达到<b>每秒数百兆</b>；<br>' +
                      '· 设备发烫、App 被系统杀掉；<br>' +
                      '· 拉回来的日志文件本身<b>还不完整</b>（有明显的断档）。<br><br>' +
                      '你的记录点覆盖了 MessageDigest / Cipher / Mac 的<b>全部</b>调用，' +
                      '包括对每个图片做的分块 <span class="mono">update</span>。<br><br>' +
                      '<b>你会怎么改？</b>',
            choices: [
              { t: '降低记录粒度：从今往后只记 doFinal，不再记 update', next: 'n1' },
              { t: '改数据结构与写入路径：在内存里按实例聚合分块、只在收尾时落一条完整记录；超限的 buffer 截断并记长度；落盘交给独立的低优先级线程批量写', next: 'n2' },
              { t: '把落盘从文件改成 logcat，交给系统的日志服务去管缓冲与轮转', next: 'n3' },
              { t: '关掉 Cipher 的记录，只保留 MessageDigest——毕竟哈希更常用', next: 'n4' }
            ]
          },
          n1: {
            label: '选 A', terminal: true, verdict: 'bad',
            verdictTitle: '用丢信息的方式解决性能问题',
            result: '<b>方向反了：性能问题的解法应该在「怎么写」，而不是「少记什么」。</b><br><br>' +
                    '<b>而且你丢掉的恰好是最关键的那一类信息。</b>分块 <span class="mono">update</span> 的边界与顺序，' +
                    '是复算时最容易出错、也最需要证据的地方（13.11L 的实验专门考它）。' +
                    '只记 <span class="mono">doFinal</span>，你拿到一段输入和一段输出，' +
                    '<b>但永远不知道这段输入是怎么拼起来的</b>——如果中间掺了盐、或者顺序被调整过，你将完全看不出来。<br><br>' +
                    '<b>认知根源：</b>把「日志量大」简单归因于「记的字段太多」。' +
                    '真正的问题在于<b>同一条信息被写了太多次</b>（每个分块一条记录、每次同步写盘），' +
                    '而不是信息本身多余。删信息是最省事的做法，也是最容易把工具做废的做法。'
          },
          n2: {
            label: '选 B', terminal: true, verdict: 'good',
            verdictTitle: '正确：把「信息完整」和「写入昂贵」解耦',
            result: '<b>这是本节全部设计清单的合体。</b>逐条对上：<br><br>' +
                    '<b>· 内存聚合</b>：分块 update 不再各写一条，而是按实例累积到内存里，' +
                    '在 <span class="mono">doFinal</span> 时合并成一条完整记录。' +
                    '<b>信息一点没少（分块边界仍以 <span class="mono">seq</span> 体现），但写入次数降了两个数量级。</b><br>' +
                    '<b>· 截断 + 记长度</b>：超限的 buffer 截断，同时保留原始长度与截断标记——' +
                    '日志总量变得可控，而「被截了」这件事仍然可见。<br>' +
                    '<b>· 独立低优先级落盘线程</b>：插桩点只入队，IO 不在目标的关键路径上，' +
                    'App 的响应时间不再被日志拖累。<br><br>' +
                    '<b>为什么这才是对的解法：</b>它同时满足了三个约束——<b>信息完整</b>（没丢语义）、' +
                    '<b>开销可控</b>（IO 次数与数据量都下来了）、<b>丢失可见</b>（截断与丢弃都有字段记录）。' +
                    '性能问题不该用「少观测」来解决，而应该用「<b>改变观测量与观测时机的结构</b>」来解决。'
          },
          n3: {
            label: '选 C', terminal: true, verdict: 'bad',
            verdictTitle: '把问题搬走，而不是解决它',
            result: '<b>这不解决写放大，只是把「丢日志」这件事藏进了系统服务的黑盒里。</b><br><br>' +
                    '<b>技术上的问题有三条：</b>① logcat 有行长度上限，大 buffer 依然会被截断，' +
                    '而且<b>截断方式不由你控制</b>；② 缓冲区满时 logd 会丢弃，' +
                    '而<b>它不会告诉你丢了多少</b>——你失去了 <span class="mono">seq</span> 之外唯一的丢失证据；' +
                    '③ 写入 logd 依然是<b>同步路径上的开销</b>（只是从磁盘 IO 变成了 socket + 内核缓冲），' +
                    '高频调用下照样拖慢目标。<br><br>' +
                    '<b>认知根源：</b>把「有缓冲的服务」等同于「免费的缓冲」。' +
                    '任何缓冲在溢出时都要做丢弃决策，区别只在于<b>这个决策由谁做、以及你有没有被告知</b>。' +
                    '放在你自己的代码里，你至少还能计数。'
          },
          n4: {
            label: '选 D', terminal: true, verdict: 'bad',
            verdictTitle: '砍掉了这一章最值钱的那一半',
            result: '<b>策略上说不通：Cipher 的记录正是自吐沙箱存在的理由。</b><br><br>' +
                    '哈希的输入你本来就能从抓包和代码里猜到；<b>密钥是你猜不到的东西</b>，' +
                    '而密钥只在 Cipher / Mac 的记录里出现。' +
                    '把 Cipher 关掉，这个沙箱就退化成「一个能看到 MD5 输入的日志工具」——' +
                    '<b>那用 Frida 半天就能做完，不值得你花几周搭源码环境。</b><br><br>' +
                    '<b>认知根源：</b>把「哪个算法更常出现」当成了「哪个记录更该保留」。' +
                    '保留价值的判断标准不是频次，而是<b>「这条信息是否无法从别处获得」</b>。' +
                    '哈希输入可以别处获得，密钥不能——所以该保护的是后者。<br><br>' +
                    '<b>顺带说：如果 Cipher 真的是性能瓶颈，正确的做法是「按需开关」</b>——' +
                    '平时只记摘要级信息，进入关键流程时再用开关接口打开全量记录。这就是加自定义 API 的用处。'
          }
        }
      }
    },
    /* ================= 13.8 ================= */
    {
      h: '13.8',
      title: '边界：算法沉到 native 之后，自吐还剩多少',
      html:
        '<p>前面七节都在讲「怎么让它招供」。这一节讲<b>它招不出来的时候怎么办</b>——这是本章最该讲清楚、也最容易被含糊过去的部分。</p>' +
        T.note('key', '🔑 边界的判据只有一句话',
          '<p><b>自吐沙箱能看到什么，完全由「观测点所在的那一层」决定，与探针写得好不好无关。</b></p>' +
          '<p>Java 层的探针，对「经过 Java 层的密码学调用」几乎是完美的（算法名、密钥、明文、IV 全在手上）；' +
          '而一旦算法下沉到 native，<b>调用根本没有经过你插桩的那一层</b>，日志自然一条都没有。' +
          '这不是失败，这是分层观测的必然结果——13.1 那个动画的最后一格说的就是这件事。</p>') +
        T.tbl(['下沉程度', '目标的做法', 'Java 层自吐', '你还能拿到什么'], [
          ['① 用 JCA，但底层走 native',
           '<span class="mono">Cipher.getInstance</span> 照常用，只是 SPI 实现最终调用 native 的算法库',
           '<span class="hit">✅ 正常命中</span>',
           '<b>算法名、密钥、IV、明文、密文全都有</b>——只是看不到 native 内部的中间状态。这是最好的情况'],
          ['② 绕开 JCA，自研实现',
           '自己写一个 <span class="mono">Md5Utils</span> 或 <span class="mono">nativeEncrypt([B)[B</span>，不经过任何 JCA 类',
           '<span class="miss">❌ 0 命中</span>',
           '回到<a href="ch11-algo1.html">第 22 章</a>的常量比对、<a href="ch12-algo2.html">第 23 章</a>的动静态内存比对；或在 JNI 边界做数据流观测'],
          ['③ 绕开 libc，直发系统调用',
           '内联 <span class="mono">SVC</span> 指令，不走 libc 封装函数',
           '<span class="miss">❌ 0 命中</span>',
           '<b>连用户态的函数级 hook 也失效</b>——包括 PLT/GOT hook 与 inline hook libc。只有内核层拦截能生效（见本节案例）'],
          ['④ 密钥不落 Java 堆',
           '密钥在 native 里派生并使用，或放进 <span class="mono">KeyStore</span>／硬件密钥库，Java 层只拿句柄',
           '<span class="miss">❌ 拿不到密钥</span>',
           '算法名与明密文可能仍然可见（如果走了 JCA），但<b>「拿到密钥就不必读汇编」这条捷径断了</b>']
        ]) +
        T.note('key', '🔑 下沉之后的三条出路，按成本从低到高',
          '<p><b>出路一：把插桩点也下沉一层（到 libc / 加密库层）。</b>' +
          '如果目标用的是通用加密库，那里有一个和 JCA 门面类性质相同的汇聚点——' +
          'OpenSSL/BoringSSL 的 <span class="mono">EVP_*</span> 系列接口（<span class="mono">EVP_DigestUpdate</span>、' +
          '<span class="mono">EVP_EncryptUpdate</span> 等）就是这一层的汇聚点。' +
          '<span class="pill warn">待核实</span>：具体函数名与是否存在随库/版本/是否被裁剪而变化，必须在目标的 so 里确认。' +
          '<b>注意这条路只对「用这个库」的目标有效</b>——自研实现依然 0 命中。</p>' +
          '<p><b>出路二：回到第 22/23 章的手法。</b>常量比对 + 动静态内存比对。' +
          '这条路不依赖任何 API，因此对自研实现也有效，代价是工作量大、结论依赖经验。</p>' +
          '<p><b>出路三（最值得记住的一条）：观测数据流，而不是观测函数。</b>' +
          '在 <b>JNI 边界</b>记录「一段字节数组进入 native / 一段字节数组离开 native」，' +
          '以及它的长度、内容与调用栈。<b>你完全不关心 native 里怎么算，你只关心「进去什么、出来什么」。</b></p>' +
          '<p>第三条为什么重要：它<b>等价于一次不需要发起的黑盒调用</b>（第 23 章的手法），' +
          '但成本低得多——黑盒调用要构造参数、要维持进程、要处理崩溃；而数据流观测只是「把已经发生的事实记下来」。' +
          '对大量目标来说，这就够了。</p>') +
        T.note('warn', '⚠️ 诚实的结论：这一章的能力有明确上限',
          '<p>把话说明白：<b>自吐沙箱覆盖不了「native 自研算法 + 强混淆 + 密钥不出 native」这三件事叠加的目标。</b>' +
          '这类目标你只能回到第 22 章的常量比对与第 23 章的主动调用，或者接受「黑盒调用出产能」的路线。</p>' +
          '<p>但它能覆盖的是：<b>用 JCA 的目标</b>与<b>用通用加密库的目标</b>——' +
          '而现实中这两类占了大多数。更重要的是，<b>它把「逆向算法」这件事从「读汇编」降级成了「读日志 + 复算」</b>，' +
          '这个降级本身就是巨大的产能差异。</p>' +
          '<p>判断一个沙箱方案好不好，不要问「它能不能处理所有样本」，要问<b>「它在你的样本分布上能覆盖多少，以及覆盖不了的那些有没有明确的下一步」</b>。' +
          '13.1 的探针设计正是为了回答后者：<b>0 命中本身就是一条指向下一步的证据。</b></p>') +
        '<p>下面这个案例从<b>防守方</b>的视角，把「下沉到内联系统调用」这件事做到了极致。' +
        '它不是讲自吐的，但它给出了本章边界论最硬的外部证据。</p>',
      case: {
        source: 'kanxue',
        title: '[原创]沙箱对抗某商业安全 SDK 检测',
        date: '2026-2-5',
        author: 'alds',
        target: '某商业安全 SDK 的运行时环境检测（SaaS 加固模式）；涉及 libcovault-appsec.so / libtoolChecker.so / libSecureComponent.so；对抗侧为 Android 上的定制框架 hook 环境',
        background:
          '<p>作者的出发点很朴素：分析一个竞品 App 时，手机一打开就闪退。用惯常的做法（APatch 开内核 root）本来大多能过，' +
          '但这次「碰到个狠的」——<b>连 lite 模式都不行</b>，依然被检测到并闪退。' +
          '于是他反过来把这套 SDK 的检测原理完整还原了一遍，最后在手机上用魔改框架实现了 hook。</p>' +
          '<p>这篇帖子和本章的关系在于：<b>它是一份「观测点被绕过」的完整清单。</b>' +
          '本章一直在说「观测点插在哪一层，决定你能看到什么」；而这个 SDK 做的事情恰好相反——' +
          '<b>它主动选择那些让分析者的观测点失效的调用方式。</b>把它当成本章的对照组来读，边界会变得非常具体。</p>',
        points: [
          '检测分成<b>两个互相独立、互不依赖</b>的层面，由不同的 SO 执行：' +
          '<span class="mono">libcovault-appsec.so</span>（约 1.7M，Java/JNI 检测）与 ' +
          '<span class="mono">libtoolChecker.so</span>（约 5.4K，native syscall 检测），另有辅助组件 <span class="mono">libSecureComponent.so</span>（约 1.2M）。',
          '<b>第一层走 Binder IPC。</b>通过 native 层 JNI 调用 <span class="mono">PackageManager</span> API 做全量已安装应用扫描，' +
          '提取包名、APK 路径、权限、Provider authority，以及每个应用 manifest 里有没有 <span class="mono">xposeddescription</span> 元数据。' +
          '<b>关键点：数据流走 <span class="mono">ioctl</span>（Binder 底层），不经过文件系统 syscall，所以 seccomp 拦不到。</b>',
          '<b>第二层用内联 SVC 直发系统调用。</b>检测 SO 不通过 libc 封装函数（<span class="mono">access()</span> / <span class="mono">stat()</span> / <span class="mono">open()</span>），' +
          '而是在代码里直接写内联汇编 <span class="mono">SVC #0</span>。' +
          '<b>后果：PLT/GOT hook（xhook / bhook 这类基于 GOT/PLT 表的方案）完全无法拦截，因为执行路径根本不经过 libc 的函数入口。</b>',
          '路径扫描用 <span class="mono">faccessat</span>（arm64 syscall 48）覆盖 <b>70+ 条</b> root 相关路径：' +
          'su 二进制约 24 条、Magisk 约 29 条、SuperSU/daemonsu 约 12 条、Xposed/Substrate 约 6 条。',
          '随后用 <span class="mono">statx</span>（syscall 291）做<b>二次验证</b>——同一个文件换一个 syscall 号再查一遍。' +
          '作者的观察是：如果 seccomp 过滤器只覆盖了 <span class="mono">faccessat</span>(48) 和 <span class="mono">newfstatat</span>(79)，' +
          '<span class="mono">statx</span>(291) 与 <span class="mono">faccessat2</span>(439) 就会漏过去。',
          '<b>反过来用 seccomp 识别沙箱：</b>读 <span class="mono">/proc/self/status</span> 的 <span class="mono">Seccomp:</span> 字段——' +
          '正常应用是 0，装了 seccomp 过滤器的进程是 2。<b>也就是说，「用 seccomp 对抗检测」这件事本身会成为被检测的特征。</b>',
          '<b>fd 遍历补 maps 的漏：</b>对 <span class="mono">/proc/self/fd/N</span> 做 <span class="mono">newfstatat</span>(79) + ' +
          '<span class="mono">readlinkat</span>(78) 拿到 fd 指向的真实路径。' +
          '这样即使某个 SO 通过 <span class="mono">dlopen</span> 加载后被从 maps 里抹掉，<b>已经打开的 fd 仍然指向原始文件</b>。',
          '<b>inline hook 检测：</b>校验关键函数（帖子里举的例子是 <span class="mono">pthread_create</span>）入口的头几个字节，' +
          '如果是跳转指令（B / BL / BR / LDR PC 等）就判定被 inline hook 篡改——Dobby 这类 inline hook 框架必然留下这个痕迹。',
          '<b>自杀机制用 SIGALRM：</b>启动时 <span class="mono">alarm(N)</span> 设定时器，检测全过就取消；发现异常就让定时器到期杀死进程。' +
          '作者指出选 SIGALRM 而非 SIGKILL 的原因很实用：<b>日志里显示为 "Alarm clock" 而不是 "Killed"，更隐蔽，' +
          '而且 Java 层的 <span class="mono">UncaughtExceptionHandler</span> 捕获不到信号级终止</b>，App 看起来像正常超时退出。',
          '<b>多进程架构：</b>主进程（已装 seccomp）、隔离进程 1（后台上报检测结果）、隔离进程 2（看门狗，监控主进程）。' +
          '看门狗在独立进程空间里，不受主进程 seccomp 影响，理论上可以从外部读 <span class="mono">/proc/PID/status</span> 与 ' +
          '<span class="mono">/proc/PID/maps</span> 来判断主进程是否被装了 seccomp 或被注入 SO。'
        ],
        method: [
          '从现象出发：APatch 内核 root 甚至 lite 模式都过不了，说明这不是常规的 root 检测，而是更系统的环境检测。',
          '先把检测 SO 从目标里取出来，按大小与职责做初判：一个 1.7M 的（Java/JNI 检测）、一个 5.4K 的（native syscall 检测）、一个 1.2M 的辅助组件。',
          '分层还原第一层：确认它通过 JNI 直接调 <span class="mono">PackageManager</span>，走 Binder IPC；' +
          '并明确「Binder 走 ioctl，不过文件系统 syscall，因此 seccomp 拦不到」这条边界。',
          '分层还原第二层：在反汇编里确认检测代码用的是内联 <span class="mono">SVC #0</span>，而不是 libc 封装——' +
          '这一步直接解释了「PLT/GOT hook 为什么完全无效」。',
          '把 syscall 用法逐条列出来：<span class="mono">faccessat</span>(48) 做主扫描、<span class="mono">statx</span>(291) 做二次验证、' +
          '<span class="mono">newfstatat</span>(79) + <span class="mono">readlinkat</span>(78) 做 fd 遍历，并整理成一张 syscall 编号表。',
          '把「回调/上报」链也理清：检测结果如何组装、由哪个进程上报、SIGALRM 在什么条件下触发。',
          '最后在手机上用魔改框架实现 hook 并跑通——即把还原出来的结论反过来用于对抗。',
          '作者同时给出了自己的检测清单复盘（第 9 节「检测局限性」），逐条指出这套方案可以被怎么绕过。'
        ],
        result:
          '<p>作者完整还原了这套 SDK 的两层检测原理，并在手机上通过魔改框架成功 hook，绕过了检测。</p>' +
          '<p>但他给出的结论比「我绕过了」更有价值——他在帖子末尾把纯客户端用户态检测的根本局限写了出来：' +
          '<b>检测代码和被检测环境运行在同一权限层级（甚至更低），无法建立可信的信任根</b>；' +
          '真正有效的检测需要把信任根转移到硬件（TEE）或服务端。' +
          '他还在对比表里把 <b>Play Integrity API（硬件 TEE + 服务端）</b>列为绕过难度「极高」的一档。</p>' +
          '<p>另外他指出了一个合规层面的问题：全量应用扫描（遍历设备上所有已安装应用并提取详细信息）' +
          '<b>超出了安全检测的合理最小范围</b>，而 Android 11 引入的包可见性限制正是为了限制这类行为。</p>',
        terms: ['seccomp-bpf', '内联 SVC', 'PLT/GOT hook', 'inline hook 检测', 'Binder IPC', 'statx', 'faccessat2', 'SIGALRM', '看门狗进程', '信任根（root of trust）'],
        limits:
          '<p>作者自己列了一张「检测局限性」清单，这里照录，不替他下结论：</p>' +
          '<p><b>架构层面：</b>① <b>权限不对等</b>——检测 SDK 在用户态，kernel root 在内核态，<b>检测者权限低于被检测者</b>；' +
          '② <b>syscall 可被拦截</b>——所有文件系统检测都通过标准 syscall 执行，seccomp-bpf 是内核级拦截机制；' +
          '③ <b>Binder 返回值可被修改</b>——PM 查询走 Binder，返回值经过 Java 层可被过滤；' +
          '④ <b>单次检测</b>——只在启动时执行一次，没有持续监控。</p>' +
          '<p><b>实现层面：</b>① <b>内联 SVC 仍可被拦截</b>——虽然 <span class="mono">SVC #0</span> 绕过了 PLT/GOT hook，' +
          '但 seccomp-bpf 工作在内核层面，<b>在 syscall 进入内核时拦截，与用户态的调用方式无关</b>；' +
          '② <b>路径硬编码</b>——su/magisk 路径列表固定在 SO 里；' +
          '③ <b>未校验拦截行为</b>——只看结果（文件存在/不存在），不验证 syscall 是否被拦截；' +
          '④ <b>SIGALRM 依赖检测结果</b>——全部通过就不触发自杀；' +
          '⑤ <b>看门狗进程未充分利用</b>——理论上可从外部检测主进程异常，实际未观察到充分利用。</p>' +
          '<p>另外两处属于帖子里的观察而非代码结论：该 SDK 的检测流程在 <span class="mono">Application.onCreate</span> 之后启动，' +
          '整体约 2 秒完成；以及作者提到分析对象是「竞品 App」，其合规边界由使用者的授权决定。</p>',
        analysis:
          '<p><b>这个案例是 13.8 边界论的外部证据，而且是从防守方的视角给的。</b>本节说「观测点在哪一层，决定你能看到什么」，' +
          '这个 SDK 做的事情正好是它的反命题：<b>它主动选择让分析者的观测点失效的调用方式。</b></p>' +
          '<p>先看那条最锋利的：<b>检测代码用内联 <span class="mono">SVC #0</span>，PLT/GOT hook 完全无法拦截。</b>' +
          '对照本章的分层表，这等于目标主动把自己搬到了「③ 绕开 libc，直发系统调用」那一档。' +
          '<span class="hit">它印证的是一个通用规律：<b>用户态的函数级观测点，天然会被「不走用户态函数」的实现绕过。</b></span>' +
          '这条规律不只适用于文件检测——<b>密码学算法下沉到 native 是同一件事的另一面</b>：' +
          '你的观测点插在 Java 的 <span class="mono">Cipher</span> 上，而目标的算法根本不从那里走。' +
          '两件事看起来不同（一个是系统调用，一个是加密算法），但失败的机制完全一样：<b>调用路径绕过了你的层。</b></p>' +
          '<p>第二条值得抄进笔记本的是那个「反向识别」：<b>SDK 读 <span class="mono">/proc/self/status</span> 的 ' +
          '<span class="mono">Seccomp:</span> 字段来识别沙箱。</b>' +
          '这是本章没有正面讲、但非常关键的一个维度——<b>沙箱本身也是被观测对象。</b>' +
          '你为了让观测点不被绕过而加的措施（比如用 seccomp 拦 syscall），会变成对手识别你的特征。' +
          '把这条推理带回本章：这也正是<a href="ch32-art-sandbox.html">第 18 章</a>和 13.3 反复强调「改源码不引入额外进程特征」的价值所在——' +
          '<b>不引入特征，就没有这条可被反向识别的线索。</b></p>' +
          '<p>第三条是一个思维方式：作者先分「两个独立层面」，再对每一层分别问「我的拦截手段在这一层能不能生效」。' +
          '这个拆法比「找一个万能 hook 方案」高效得多，因为它把「为什么 0 命中」变成了一个可以逐层回答的问题。' +
          '<b>本章把这条思路制度化成了 13.1 的那个五层动画和 13.10 的字段读法。</b></p>' +
          '<p>最后，作者把「纯客户端用户态检测无法建立信任根」这个结论写出来，同时明确对比了硬件/服务端方案——' +
          '<b>这是攻防两边都给出边界的写法，比只讲「我怎么绕过的」有价值得多。</b>' +
          '本章 13.8 结尾那句「不要问它能不能处理所有样本，要问它在你的样本分布上能覆盖多少」，说的正是同一种态度。</p>',
        link: 'https://bbs.kanxue.com/thread-289955.htm',
        linkNote: '看雪论坛 Android安全 版块原创帖；HTTP 200 已核实'
      },
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境三',
            scenario: '<b>情境：</b>你花了两周做的自吐沙箱，在这个样本上<b>一条密码学记录都没有</b>。' +
                      '你用第 22 章的方法在它的 so 里搜到了 <span class="mono">0x67452301</span>、<span class="mono">0xefcdab89</span>、' +
                      '<span class="mono">0x98badcfe</span>、<span class="mono">0x10325476</span> 四个常量，' +
                      '并且 <span class="mono">0xd76aa478</span> 开头的 K 表也在——<b>确认是标准 MD5，没有被魔改</b>。' +
                      '签名逻辑全在 native。<br><br>' +
                      '老板问你：要不要继续投入，把沙箱改到 native 层？<br><br>' +
                      '<b>你决定先做哪件事？</b>',
            choices: [
              { t: '直接批准：把插桩点下沉到 libc 与 OpenSSL 的 EVP 层，覆盖 native 场景', next: 'n1' },
              { t: '先花半天确认两件事：这个 MD5 是调库还是自研实现；以及它的<b>输入</b>是怎么拼起来的（盐从哪来）', next: 'n2' },
              { t: '判定沙箱对这个样本无效，转用 Frida 主动调用直接把签名服务化', next: 'n3' },
              { t: '把这个样本归档为「沙箱覆盖不了」，然后去统计沙箱在整个样本集上的命中率', next: 'n4' }
            ]
          },
          n1: {
            label: '选 A', terminal: true, verdict: 'bad',
            verdictTitle: '同一种手段加码，但没确认它是否对症',
            result: '<b>这是典型的「用更硬的方案做同一件没确认过的事」。</b><br><br>' +
                    '<b>你缺的那个信息是：它到底调不调库。</b>如果这个 so 里是自研的 MD5 实现（第 22、23 章见过大量这种样本），' +
                    '那么把探针下沉到 OpenSSL 的 <span class="mono">EVP_*</span> 层<b>依然 0 命中</b>——' +
                    '你花两周改造，换来的是同样的空日志。<br><br>' +
                    '<b>认知根源：</b>把「下沉一层」当成了通用的解法，而忘了下沉的价值取决于<b>目标是否用了那一层的公共接口</b>。' +
                    '下沉到 EVP 能命中的前提是「目标用 OpenSSL 系」，而这个前提你还没验证。<br><br>' +
                    '<b>还有一个更省钱的观察：</b>你已经在 so 里搜到了完整的标准 MD5 常量。' +
                    '既然是标准 MD5，那么<b>你真正缺的从来不是「算法是什么」，而是「输入是什么」</b>——' +
                    '而这很可能不需要改造沙箱就能拿到（见选项 B）。'
          },
          n2: {
            label: '选 B', terminal: true, verdict: 'good',
            verdictTitle: '正确：先确定缺的是哪一类信息，再决定往哪投',
            result: '<b>这一步把「要不要投入」变成了一个有答案的问题。</b><br><br>' +
                    '<b>查第一件事（调库还是自研）</b>直接决定下沉是否有意义：' +
                    'so 的导入表里有加密库符号（或能看到对库函数的调用）→ 下沉到库层值得；' +
                    '反之符号表干净、常量以立即数形式出现在自研函数里 → 下沉必然扑空，该走第 22/23 章的路。<br><br>' +
                    '<b>查第二件事（输入怎么拼）更有价值</b>，因为你是<b>标准 MD5 + 不知道输入</b>：' +
                    '算法已经确认，剩下的唯一变量就是输入。而观测输入<b>根本不需要改沙箱</b>——' +
                    '在 JNI 边界记录「哪段字节进了 native」就够了；甚至可以直接在 native 里 dump 一次真实调用的入参。<br><br>' +
                    '<b>为什么这个顺序对：</b>它遵循了本章一贯的原则——<b>先问「我缺什么信息」，再问「哪一层能看到它」</b>。' +
                    '投入方向应该由信息缺口决定，而不是由「哪层技术更彻底」决定。' +
                    '<span class="hit">而且它只花了半天，就避免了两周的无用功。</span>'
          },
          n3: {
            label: '选 C', terminal: true, verdict: 'bad',
            verdictTitle: '把「这个样本」的问题升级成了「这条路」的问题',
            result: '<b>主动调用不是沙箱的替代品，它是另一种观测方式。</b><br><br>' +
                    '<b>技术上的问题：</b>主动调用同样要求你能定位到入口、构造出参数。' +
                    '签名函数在 native、参数是 Java 字节数组，你得先知道<b>哪个 Java 方法对应它</b>、' +
                    '传进去的字节该怎么拼——<b>这些恰恰是自吐沙箱本来要提供的信息</b>。' +
                    '没有它，你还是要回退到第 18 章的 <span class="mono">RegisterNatives</span> 映射或 Frida 枚举。' +
                    '更别忘了，主动调用会引入 Frida 的框架特征，而目标样本既然值得你搭源码沙箱，说明它有检测能力。<br><br>' +
                    '<b>认知根源：</b>把「我这次没拿到信息」误判为「这套方法论失效了」。' +
                    '实际上这次失败的原因非常具体：<b>观测层选错了</b>。换工具并不能修正一个选层错误。'
          },
          n4: {
            label: '选 D', terminal: true, verdict: 'bad',
            verdictTitle: '方向不错，但顺序错了：你在该诊断的时候去做了统计',
            result: '<b>统计命中率是对的动作，但它是「有了结论之后」该做的动作，不是「遇到 0 命中时」该做的动作。</b><br><br>' +
                    '<b>为什么现在做统计是错的：</b>你手上这个样本的 0 命中<b>原因还没查清</b>。' +
                    '它可能是「算法下沉」（沙箱的结构性边界），也可能是「你插错了类」（探针的 bug）。' +
                    '这两种原因对应的改进动作完全相反——前者要换观测层，后者要修探针。' +
                    '<b>在原因不明的时候统计，你会把探针的 bug 也算进「沙箱的边界」里，从而低估工具、高估边界。</b><br><br>' +
                    '<b>认知根源：</b>用一个看起来更「科学」的动作（统计、量化）替代了本该做的现场诊断。' +
                    '数据只有在归因清楚之后才有意义；归因不清的统计只会把噪音固化成一个结论。<br><br>' +
                    '<b>正确顺序：</b>先把这个样本的 0 命中归因清楚（选项 B 那半天），' +
                    '<b>然后</b>再去跑一批样本统计命中率——那时候你才知道每个 0 命中该归到哪一类。'
          }
        }
      }
    },

    /* ================= 13.9 ================= */
    {
      h: '13.9',
      title: '主动调用：自吐是观测，主动驱动是产能',
      html:
        '<p>到这里，你已经有一台会自己招供的沙箱了。但它有一个天生的限制：<b>它只能记录目标自己走过的路。</b>' +
        '你想让它算一个特定的输入，它不会理你——因为它不知道你要什么。</p>' +
        T.note('key', '🔑 两者的关系，一句话',
          '<p><b>自吐是被动观测，主动调用是主动驱动；先自吐摸清入口和参数形态，再主动调用批量出结果。</b></p>' +
          '<p>这个顺序不能反。主动调用（<a href="ch12-algo2.html">第 23 章</a>）解决的是「怎么批量出活」，' +
          '它的前提是三个你事先必须知道的东西：<b>调哪个方法、参数怎么构造、返回值怎么解释</b>。' +
          '而这恰好就是自吐日志逐条给出的内容。</p>') +
        T.tbl(['维度', '自吐（被动观测）', '主动调用（主动驱动）'], [
          ['触发者', '目标 App 自己（它走到那条路你才看得到）', '<b>你</b>（你决定要算什么）'],
          ['前置条件', '插桩点覆盖到目标用的那一层', '知道<strong>入口、参数形态、返回类型</strong>——这三样自吐日志全都给你'],
          ['单次成本', '零（记录是顺带的）', '一次 IPC 往返（第 23 章讲过「脚本常驻」的重要性）'],
          ['产出形态', '<b>真实业务里的一次调用记录</b>，带真实的密钥与数据', '<b>任意输入的运算结果</b>，可与日志交叉验证'],
          ['拿不到的', '你没让它走的路径、你构造的特定输入', '目标没有暴露为可调用接口的内部函数'],
          ['典型失败模式', '0 命中（走错层）、日志太大拖死目标', '参数构造错、进程崩溃、App 升级后入口失效'],
          ['适用场景', '摸清算法与参数、定位入口、拿密钥', '批量生产、构造测试向量、跑字典']
        ]) +
        T.note('ok', '✅ 自吐送给主动调用的一份大礼：已知答案测试向量（KAT）',
          '<p>这是两者配合中最容易被忽略、又最实用的一点。</p>' +
          '<p>主动调用最大的问题不是「调不通」，而是<b>「调通了但不知道结果对不对」</b>。' +
          '你批量跑出一万条结果，凭什么相信它们是对的？' +
          '靠自吐日志：<b>日志里那条 <span class="mono">in</span> / <span class="mono">out</span> 就是一组现成的、来自真实业务的已知明密文对。</b></p>' +
          '<p>拿它当第一个测试向量：主动调用算同一份输入，结果必须与日志里的输出<b>逐字节一致</b>。' +
          '一致，说明你的调用链路、参数构造、编码转换全都是对的，可以放心批量跑；' +
          '不一致，你至少知道问题出在自己的链路上，而不是在业务逻辑上。' +
          '<span class="hit">在没有自吐之前，这个「已知答案」要么靠逆向硬啃，要么靠猜——而猜出来的基准会让后面所有批量数据都不可信。</span></p>') +
        T.note('', '🔗 完整的配合链路',
          '<p><b>①</b> 自吐日志给出「类名 + 方法签名 + 参数形态 + 一次真实的明密文对」→ ' +
          '<b>②</b> 用那条真实记录做 KAT，校准主动调用链路 → ' +
          '<b>③</b> 批量调用产出数据 → ' +
          '<b>④</b> 把批量结果与沙箱日志交叉比对（同一输入必须得到同一输出）→ ' +
          '<b>⑤</b> 如果发现不一致，说明中间有隐藏状态（计数器、时间戳、随机 IV），回到日志里找它。</p>' +
          '<p>第 <b>⑤</b> 步特别值得说：<b>「主动调用算出来的结果和日志里的不一样」几乎总是意味着存在你没记录的隐藏输入</b>——' +
          '常见的候选是随机 IV、时间戳、递增计数器、或者上一次调用的状态（比如 Cipher 实例没重新 init）。' +
          '这类不一致是极有价值的信号，它比「算对了」更能加深你对目标的理解。</p>') +
        '<p>下面的情境，是「日志字段读错一字，复算全盘皆输」的典型。</p>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境四',
            scenario: '<b>情境：</b>自吐日志里有一条记录：<br><br>' +
                      '<span class="mono">{"t":"Cipher","algo":"AES/ECB/PKCS5Padding","ev":"init","mode":1,' +
                      '"key":"546865517569636b42726f776e466f784a756d70734f7665725468654c617a79","keyLen":32}</span><br><br>' +
                      '你按 AES-128 复算（把密钥前 16 字节当作密钥），怎么都对不上同一批日志里那条 <span class="mono">doFinal</span> 的输出。' +
                      '你检查过输入、填充、编码，都没问题。<br><br>' +
                      '<b>你的结论是什么？</b>',
            choices: [
              { t: '这个 App 魔改了 AES——标准实现算不出来，说明 S 盒或轮函数被动过，去做常量比对', next: 'n1' },
              { t: '密钥是 32 字节，也就是 AES-256；我一开始就选错了密钥长度，按 32 字节重新做密钥扩展', next: 'n2' },
              { t: '64 个十六进制字符说明日志把同一个 16 字节密钥记了两遍，去重后再算', next: 'n3' },
              { t: 'ECB 模式下 32 字节其实是「16 字节密钥 + 16 字节盐」拼在一起，应该拆开取前半段', next: 'n4' }
            ]
          },
          n1: {
            label: '选 A', terminal: true, verdict: 'bad',
            verdictTitle: '把「我算错了」归因成「算法被改了」',
            result: '<b>这是自吐沙箱时代最常见的一类误判：日志已经把答案写给你了，你却选择怀疑目标。</b><br><br>' +
                    '<b>日志里那个 <span class="mono">"keyLen":32</span> 就是明确写在脸上的提示。</b>' +
                    '而魔改的判断需要证据——它的正确做法是<b>先用标准实现在正确的参数下算一遍，算不出来再去比对常量</b>。' +
                    '你跳过了这一步。<br><br>' +
                    '<b>认知根源：</b>习惯性地把「算不对」等同于「被魔改」。' +
                    '但在有日志的前提下，算不对的<b>第一嫌疑人永远是你自己的复算参数</b>——' +
                    '密钥长度、模式、填充、编码、端序，这五项里任何一项错了，结果都会完全不同，' +
                    '而它们的表现与「魔改」一模一样。<br><br>' +
                    '<b>判断顺序应该是：先穷尽「参数错了」的可能，再怀疑算法。</b>' +
                    '这和<a href="ch12-algo2.html">第 23 章</a>那条判断呼应得很好——那里是「常量全中但结果不符 → 去找盐」，' +
                    '这里是「日志字段摆着但结果不符 → 先按字段重算」。<b>都是先归因到输入/参数，再怀疑算法本体。</b>'
          },
          n2: {
            label: '选 B', terminal: true, verdict: 'good',
            verdictTitle: '正确：密钥长度决定 AES 变体，日志已经告诉你了',
            result: '<b>正是这一处。</b>AES 的密钥长度决定轮数：<b>16 字节 → AES-128（10 轮）、24 字节 → AES-192（12 轮）、' +
                    '32 字节 → AES-256（14 轮）</b>。密钥扩展算法本身也随长度变化（尤其是 32 字节时多出一个额外的 SubWord 步骤）。' +
                    '用 128 位的轮密钥去算一个 256 位的加密，得到的当然是一堆看似随机的垃圾——' +
                    '<b>而它和「魔改后的 AES」在表面上完全无法区分。</b><br><br>' +
                    '<b>为什么这是自吐沙箱的典型收益：</b>在只有汇编的年代，你要从密钥调度的循环次数、' +
                    '轮常量的个数去反推密钥长度；现在日志里直接写着 <span class="mono">keyLen: 32</span>。' +
                    '<b>这就是 13.6 那句「拿到密钥之后就不需要读一行汇编」的完整形态——连参数都不用你自己数。</b><br><br>' +
                    '<b>顺带记住这条经验：</b>看到密钥长度，先定变体，再定模式，最后才谈复算。' +
                    '顺序错了，你会在一个错误的算法上反复调参数，而且每一步看起来都很合理。'
          },
          n3: {
            label: '选 C', terminal: true, verdict: 'bad',
            verdictTitle: '把长度算错了：64 个 hex 字符就是 32 字节',
            result: '<b>这是一道算术题，不是一道语义题。</b><br><br>' +
                    '<span class="mono">546865517569636b42726f776e466f784a756d70734f7665725468654c617a79</span> 是 ' +
                    '<b>64 个十六进制字符</b>；每 2 个字符表示 1 个字节，所以它就是 <b>32 字节</b>——' +
                    '与日志里 <span class="mono">"keyLen":32</span> 完全一致。<br><br>' +
                    '<b>而且日志自己已经给了你校验：<span class="mono">keyLen</span> 这个字段存在的意义就是「让字节数与字符串长度这两个数互相印证」。</b>' +
                    '如果 hex 长度对应的字节数与 <span class="mono">keyLen</span> 不符，那才是真的有问题（截断或者编码错误）。' +
                    '这里两者一致，说明日志是干净的，问题在你的复算参数上。<br><br>' +
                    '<b>认知根源：</b>拿到了正确数据却因为一次心算失误把它当成脏数据。' +
                    '做这类复算时，<b>先把「长度」这个最容易算错、也最容易验证的量确认一遍</b>，成本几乎为零，' +
                    '却能排除掉一大类误判。'
          },
          n4: {
            label: '选 D', terminal: true, verdict: 'bad',
            verdictTitle: '凭空发明了一个不存在的结构',
            result: '<b>「16 字节密钥 + 16 字节盐」在 AES 里不是一个真实存在的结构。</b><br><br>' +
                    '盐是<b>哈希与 KDF</b> 里的概念（<a href="ch12-algo2.html">第 23 章</a>专门讲过加盐），' +
                    '它的作用是让相同的输入产生不同的输出；而 AES 是一个<b>密钥长度固定为 16/24/32 字节之一</b>的分组密码，' +
                    '它的 key 参数就是纯密钥，没有「前半段密钥 + 后半段盐」这种拼法。' +
                    '如果要用盐扩充密钥，走的是<b>密钥派生</b>（PBKDF2、HKDF 之类），' +
                    '那会在日志里表现为一次独立的 <span class="mono">SecretKeyFactory</span> 调用，而不是让你自己切字符串。<br><br>' +
                    '<b>认知根源：</b>在「输入不对」的直觉驱动下，为一个已经解释清楚的现象发明了新的结构。' +
                    '这里其实有一个更简单的解释（密钥长度是 32 字节，就是 AES-256），而它<b>不需要假设任何额外的东西</b>。<br><br>' +
                    '<b>一条通用原则：当日志给出了字面解释时，优先采用字面解释。</b>' +
                    '自吐沙箱的价值就在于它把「需要推理的东西」变成了「需要读的东西」——' +
                    '如果读了之后还要推出一套更复杂的结构，那大概率是你推错了。'
          }
        }
      },
      quiz: {
        id: 'q24-3', chapter: 24, answer: 1,
        stem: '关于<b>自吐沙箱</b>与<b>主动调用</b>的配合，下面哪个判断最准确？',
        options: [
          { t: '主动调用可以替代自吐：只要能通过 RPC 调到目标的加密函数，就不需要搭沙箱了', why: '主动调用的三个前提（调哪个方法、参数怎么构造、返回值怎么解释）恰恰是自吐日志提供的。没有自吐，这些信息还得靠逆向去啃。两者是配合关系，不是替代关系。' },
          { t: '自吐日志里的 in/out 是一组现成的已知答案测试向量，应该先用它校准主动调用链路，再批量生产', why: '正确。主动调用最怕的不是「调不通」而是「调通了但不知道对不对」。日志里来自真实业务的明密文对，正好给批量生产提供了一个可信的校准点。' },
          { t: '应该先用主动调用批量拿到大量样本，再回头用自吐日志验证这些样本', why: '顺序反了。没有校准点的批量数据无法判断对错，而「先批量后验证」会把错误放大：你手上会有一万条不知道真假的输出。' },
          { t: '自吐只记录目标自己走过的路径，因此它提供的信息与主动调用完全没有交集', why: '「没有交集」是错的。自吐提供的入口位置、参数形态、实例关联、真实明密文对，全都是主动调用能跑起来的前置条件。' }
        ],
        explain: '<b>这一题考的是两者的分工。</b>自吐是<b>观测</b>——它回答「目标在做什么、用什么参数」；' +
                 '主动调用是<b>驱动</b>——它回答「我要它算什么」。<br><br>' +
                 '<b>顺序不能反，是因为信息依赖有方向：</b>你要驱动一个函数，必须先知道它长什么样。' +
                 '而自吐日志正好是把「这个函数长什么样」从推理题变成了阅读题。<br><br>' +
                 '最容易被忽略的价值是那个 <b>已知答案测试向量</b>：它把主动调用从「黑盒批量」升级成了「有校准的批量」。' +
                 '在<a href="ch12-algo2.html">第 23 章</a>里，这个校准点要靠人工构造；有了自吐沙箱，它是现成的。'
      }
    },

    /* ================= 13.10 ================= */
    {
      h: '13.10',
      title: '日志的读法：每个字段对应一个还原动作',
      html:
        '<p>日志到手了，但「能读到」和「读得对」是两件事。这一节把日志字段与还原动作一一对应起来——' +
        '这也是本章最实用的一张表，值得单独记住。</p>' +
        T.tbl(['日志字段', '它直接告诉你什么', '你能据此推出什么（以及怎么验证）'], [
          ['<span class="mono">algo</span> / <span class="mono">transform</span>',
           '算法名与完整变换串（如 <span class="mono">AES/CBC/PKCS5Padding</span>）',
           '<b>直接确定算法、模式、填充。</b>若只有 <span class="mono">"AES"</span>，模式与填充由 Provider 默认值决定，' +
           '必须靠「密文长度关系」与「是否有 IV」来反推 <span class="pill warn">待核实</span>'],
          ['<span class="mono">keyLen</span>',
           '密钥字节数',
           '<b>定变体</b>：16 → AES-128、24 → AES-192、32 → AES-256（轮数与密钥扩展都不同）。' +
           '哈希的 HMAC 里，密钥长度还决定是否需要先做一次哈希压缩'],
          ['<span class="mono">key</span>',
           '密钥原文（hex 或 base64）',
           '<b>还原完成。</b>校验方法：用它复算日志里的那组明密文，逐字节一致即可确认'],
          ['<span class="mono">iv</span> 的有无',
           '这条记录有没有 IV',
           '<b>缺失 IV 通常意味着 ECB</b>（不需要 IV）；也可能是 IV 由实现内部生成——' +
           '靠「同一明文加密两次结果是否相同」来区分：相同 → 无状态（ECB），不同 → 有 IV/随机化'],
          ['<span class="mono">iv</span> 的值跨多条记录',
           '同一个 IV 有没有重复出现',
           '<b>固定 IV 说明它是硬编码常量或全局单例</b>（可用于跨会话复现）；' +
           '每条都不同说明是随机或递增的（此时要找到生成它的地方，否则无法离线复算历史数据）'],
          ['<span class="mono">in</span> / <span class="mono">out</span> 的长度关系',
           '明文与密文的字节数',
           '<b>反推填充与模式</b>：密文 = 明文向上取整到块大小 → 有填充的分组模式；两者相等 → 流模式或 CTR/CFB/OFB；' +
           '密文 = 明文 + 固定尾长 → 大概率是 GCM 的 tag'],
          ['<span class="mono">ev:update</span> 的多次记录',
           '分块调用的边界与顺序',
           '<b>还原真实的输入拼接方式</b>——盐是加在前面还是后面、有没有分隔符、顺序有没有被调整，全在这里'],
          ['<span class="mono">mode</span>（必须翻译成文字）',
           '加密还是解密',
           '<b>别只记加密路径。</b>解密的记录同样给你一组明密文对；而且 App 里解密往往比加密更常见'],
          ['<span class="mono">seq</span> / <span class="mono">lost</span> / <span class="mono">trunc</span>',
           '记录是否连续、有没有丢、有没有被截断',
           '<b>判断这份日志能不能作为证据使用</b>：有断档就要在结论里标注不确定，被截断的字段不能当作完整值'],
          ['实例 id / 线程 id',
           '这条记录属于哪个对象、哪个线程',
           '<b>把 init 与 doFinal 正确配对</b>。并发场景下少了这两个字段，你会把 A 的密钥配到 B 的密文上']
        ]) +
        T.note('key', '🔑 一句话总结读日志的方法论',
          '<p><b>先读「结构性字段」（算法、长度、有没有 IV），再读「内容字段」（密钥、明文、密文）。</b></p>' +
          '<p>因为结构性字段能<b>排除掉大半的错误假设</b>：密钥长度排除了变体错误，长度关系排除了模式与填充错误，' +
          'IV 的有无排除了模式错误。<b>等你把这些都排除掉之后，剩下的差异才是真正需要解释的东西。</b></p>' +
          '<p>反过来做——一上来就盯着密钥和密文算——你会发现「算不对」的可能原因有几十种，而且每种看起来都成立。' +
          '这正是 13.9 情境四里那个误判的成因。</p>') +
        T.note('warn', '⚠️ 跨语言的复算，最后一定卡在三个地方',
          '<p>自吐日志给你的是一串 hex，但复算时你会撞上三件与算法无关的事：</p>' +
          '<p><b>① 编码。</b>「明文」是 UTF-8 还是 GBK？日志里记的是字节，所以不会错；' +
          '但当你用 <span class="mono">"字符串".getBytes()</span> 重新构造输入时，平台默认编码就进来了。' +
          '<b>永远显式指定编码。</b></p>' +
          '<p><b>② 端序。</b>密钥、IV 都是字节序列，本身没有端序问题；' +
          '但一旦你把它们当成整数（比如自己实现轮密钥），端序就出现了。' +
          '<b>复算时保持「一律按字节序列处理」可以完全绕开这个坑。</b></p>' +
          '<p><b>③ Base64 与 hex 混用。</b>日志里用 hex，你复算时把结果转成 base64 去比对——' +
          '必然对不上。<b>先把两边统一成 hex 再逐字节比。</b></p>') +
        '<p>到这里，你已经有了完整的读法。下面两道自测，考的就是「先读结构性字段」这条方法论。</p>',
      quiz: {
        id: 'q24-4', chapter: 24, answer: 1,
        stem: '日志里有两条 <span class="mono">Cipher</span> 记录：算法名与密钥完全相同，' +
              '第一条带 16 字节的 <span class="mono">iv</span> 字段，第二条<b>没有 iv 字段</b>。' +
              '下面哪个判断最可靠？',
        options: [
          { t: '第二条记录是探针漏记了，同一个算法不可能有时有 IV 有时没有', why: '同一个密钥可以用于不同模式；而且「没有 IV」本身就是一个有信息量的字段状态（ECB 不需要 IV），不是漏记。把缺失一律当成 bug，会让你把有效信息当噪音丢掉。' },
          { t: '第二条很可能是 ECB 模式（不需要 IV），可以用「同一明文加密两次结果是否相同」来进一步确认', why: '正确。缺失 IV 指向不需要 IV 的模式（最典型是 ECB）；而 ECB 的判定特征是「相同明文块产生相同密文块」——用同一明文加密两次比对结果，就能把 ECB 与「IV 在实现内部生成」区分开。' },
          { t: '第二条一定是 GCM 模式，因为 GCM 的 IV 只在 doFinal 之后才可见', why: 'GCM 同样需要 IV（通常是 nonce），不是「没有 IV」；把缺失解释成「稍后才可见」是凭空补了一个机制。这类推断必须先在目标实现上验证，不能直接当结论使用。' },
          { t: '第二条一定是流模式（CTR/OFB），因为流模式不需要 IV', why: '事实错误：CTR 需要计数器/nonce，OFB 需要 IV，它们只是不需要填充。把「少了一个字段」直接推成「少了一种依赖」，是过度推断。' }
        ],
        explain: '<b>这道题考的是「先读结构性字段」。</b>在做任何复算之前，先把算法名、密钥长度、有没有 IV、' +
                 '明密文长度关系这四项读一遍，能排掉一大半错误假设。<br><br>' +
                 '「没有 IV 字段」的正确读法不是「漏了」，而是<b>「这条记录所描述的模式不需要 IV」</b>——' +
                 '最典型的就是 ECB。但注意：这只是一种<b>假设</b>，还需要一个验证动作把它变成结论。' +
                 '<b>ECB 的判定特征是非常干脆的：相同明文块 → 相同密文块。</b>' +
                 '用同一份明文加密两次、看输出是否完全一致，就能区分「ECB」与「IV 由实现内部生成」。<br><br>' +
                 '这也是本章一贯的作风：<b>日志给你假设，复算给你结论。</b>两者之间的那一步验证，永远不能省。'
      }
    },
    /* ================= 13.10L 动手实验一 ================= */
    {
      h: '13.10L',
      title: '动手实验一：自吐日志解析器（判断 + 真实复算）',
      html:
        '<p>前面讲了那么多，现在轮到你上手。这一节给你一段<b>真实的沙箱输出格式</b>，' +
        '你要做三件事：判断每条记录是什么、把被截断的那条复算出来、说清你的依据。</p>' +
        T.note('key', '🔑 实验目标',
          '<p style="margin-bottom:0">不是「看懂」，而是<b>亲手体会「有日志之后，还原只剩下复算一遍」这件事</b>。' +
          '下面的复算会用课程自带的真实算法实现（<span class="mono">window.CRYPTO</span>）完成——' +
          '<b>MD5、HMAC-SHA1、AES 全部是真算的，不是印出来的数</b>。</p>'),
      lab: {
        title: '实验：解析一段自吐日志，并复算出被截断的密文',
        goal: '目标：读出算法与参数，并真实复算',
        intro:
          '<p>下面这段是从沙箱里导出的日志（文件名 <span class="mono">mon/8421-com.example.app.jsonl</span>，' +
          '为了可读性略去了时间戳）。<b>它记录了这个 App 的四次密码学运算。</b></p>' +
          '<pre class="mono" style="white-space:pre-wrap;word-break:break-all;font-size:11.5px;line-height:1.75;padding:12px;background:rgba(0,0,0,.3);border:1px solid var(--line);border-radius:8px">' +
          CH24_LOG_ROWS.join('\n') + '</pre>' +
          '<p><b>任务：</b></p>' +
          '<p><b>①</b> 读出这四条记录分别是什么算法（含模式与填充）；' +
          '<b>②</b> 注意最后一条的 <span class="mono">out</span> 字段——<b>它被日志的长度上限截断了</b>，' +
          '所以你不能抄，只能拿日志里给的 <span class="mono">key</span> 和 <span class="mono">in</span> 复算；' +
          '<b>③</b> 说清你是<b>依据哪些字段</b>下结论的。</p>' +
          T.note('warn', '⚠️ 别急着点按钮',
            '<p>先自己读一遍日志，把「算法 / 模式 / 填充 / 密钥长度 / 有没有 IV」这五项写在纸上，' +
            '再点「运行」看复算结果。这一步的差距，就是本章要教你的东西。</p>'),
        inputs: [
          { key: 'rec', label: '① 你要重点复算哪一条 doFinal 记录？', hint: '填序号 1–4（对应日志里 doFinal 出现的顺序）', type: 'hex', value: '4', ph: '4' },
          { key: 'outhex', label: '② 把复算得到的完整密文 hex 填进来', hint: '被截断的那条：用日志里的算法名 + key + in 复算', type: 'hex', ph: '32 位十六进制', rows: 1 },
          { key: 'verdict', label: '③ 写下你的判断与依据', hint: '四条记录分别是什么算法/模式/填充？依据哪个字段？被打断的字段说明了什么？', type: 'textarea', rows: 4, ph: '第 1 条是……；第 2 条是……；第 3 条……；第 4 条……。我的依据是 keyLen 字段……' }
        ],
        runLabel: '🔍 解析日志并真实复算',
        autorun: true,
        run: (v) => {
          const C = window.CRYPTO;
          const hex = C.toHex;
          const recs = CH24_LOG_ROWS.map(s => JSON.parse(s));
          const evs = t => recs.filter(r => r.t === t);
          const first = (t, e, algoPart) => recs.filter(r =>
            r.t === t && (!e || r.ev === e) && (!algoPart || String(r.algo).indexOf(algoPart) >= 0))[0];

          const pad16 = b => {
            const n = 16 - (b.length % 16); const o = new Uint8Array(b.length + n);
            o.set(b); for (let i = b.length; i < o.length; i++) o[i] = n; return o;
          };
          const ecbEnc = (pt, key) => {
            const rk = C.aesKeyExpansion(key), p = pad16(pt), out = new Uint8Array(p.length);
            for (let off = 0; off < p.length; off += 16) out.set(C.aesEncryptBlock(p.slice(off, off + 16), rk), off);
            return out;
          };
          const cbcEnc = (pt, key, iv) => {
            const rk = C.aesKeyExpansion(key), p = pad16(pt), out = new Uint8Array(p.length);
            let prev = iv;
            for (let off = 0; off < p.length; off += 16) {
              const blk = new Uint8Array(16);
              for (let i = 0; i < 16; i++) blk[i] = p[off + i] ^ prev[i];
              const e = C.aesEncryptBlock(blk, rk); out.set(e, off); prev = e;
            }
            return out;
          };
          const cat = arr => {
            let n = 0; arr.forEach(b => { n += b.length; });
            const o = new Uint8Array(n); let p = 0;
            arr.forEach(b => { o.set(b, p); p += b.length; });
            return o;
          };

          /* ---- 复算四条记录 ---- */
          const ups = recs.filter(r => r.t === 'MessageDigest' && r.ev === 'update').sort((a, b) => a.seq - b.seq);
          const d1 = first('MessageDigest', 'doFinal');
          const got1 = hex(C.md5(cat(ups.map(r => C.fromHex(r.in)))));

          const mi2 = first('Mac', 'init'), d2 = first('Mac', 'doFinal');
          const got2 = hex(C.hmac(C.sha1, 64, C.fromHex(mi2.key), C.fromHex(d2.in)));

          const i3 = first('Cipher', 'init', 'CBC'), d3 = first('Cipher', 'doFinal', 'CBC');
          const got3 = hex(cbcEnc(C.fromHex(d3.in), C.fromHex(i3.key), C.fromHex(i3.iv)));

          const i4 = first('Cipher', 'init', 'ECB'), d4 = first('Cipher', 'doFinal', 'ECB');
          const got4 = hex(ecbEnc(C.fromHex(d4.in), C.fromHex(i4.key)));

          const rows = [
            { n: 1, t: 'MessageDigest', name: 'MD5（两次 update 后 doFinal）', logv: d1.out, mine: got1 },
            { n: 2, t: 'Mac', name: 'HmacSHA1（init(' + mi2.keyLen + 'B key) → doFinal）', logv: d2.out, mine: got2 },
            { n: 3, t: 'Cipher', name: 'AES/CBC/PKCS5Padding（key ' + i3.keyLen + 'B + IV 16B）', logv: d3.out, mine: got3 },
            { n: 4, t: 'Cipher', name: 'AES/ECB/PKCS5Padding（key ' + i4.keyLen + 'B，无 IV）', logv: d4.out, mine: got4 }
          ];

          let html = '<div class="lab-kv">' +
            '<span>日志条数 <b>' + recs.length + '</b></span>' +
            '<span>进程 <b>pid ' + recs[0].pid + '</b></span>' +
            '<span>复算实现 <b>window.CRYPTO（真实算法）</b></span>' +
            '</div>';

          html += '<table class="lab-tbl"><tr><th>#</th><th>记录的算法</th><th>日志里的 out</th><th>本地复算结果</th><th>一致？</th></tr>';
          rows.forEach(r => {
            const trunc = String(r.logv).indexOf('trunc') >= 0;
            const logShown = trunc ? String(r.logv).split('...')[0] + '…（截断）' : r.logv;
            const same = trunc ? (r.mine.indexOf(String(r.logv).split('...')[0]) === 0) : (r.mine === r.logv);
            html += '<tr class="' + (same ? 'same' : 'diff') + '">' +
              '<td>' + r.n + '</td><td style="font-size:12px">' + r.name + '</td>' +
              '<td style="font-size:11.5px;word-break:break-all">' + logShown + '</td>' +
              '<td style="font-size:11.5px;word-break:break-all">' + r.mine + '</td>' +
              '<td>' + (same ? (trunc ? '✅ 前缀一致' : '✅ 完全一致') : '❌ 不一致') + '</td></tr>';
          });
          html += '</table>';

          html += '<div class="lab-msg key"><b>🔑 第 4 条：被截断的密文完整值</b>' +
            '<div class="lab-note"><code style="font-size:14px">' + got4 + '</code></div>' +
            '<div class="lab-note">日志里只有 <code>' + String(d4.out).split('...')[0] + '…</code>，' +
            '但日志同时给了 <code>key</code>（' + i4.keyLen + ' 字节）与 <code>in</code>——' +
            '<b>有这两样，复算就能补出完整值。这就是「自吐沙箱把还原变成复算」的字面意思。</b></div></div>';

          /* ---- 针对读者选中的那条，展开复算细节 ---- */
          let k = parseInt(String(v.rec || '4').replace(/[^0-9]/g, ''), 10);
          if (!k || k < 1 || k > 4) k = 4;
          const sel = rows[k - 1];
          html += '<div class="lab-msg model"><b>你选的第 ' + k + ' 条：逐字节比对</b>' +
            '<div class="lab-note">下面把日志值与复算值按字节对齐（绿色相同，红色不同）：</div>' +
            '<div class="lab-hex" style="font-size:12.5px;word-break:break-all">' +
            window.LABX.hexDiff(sel.mine, String(sel.logv).indexOf('trunc') >= 0
              ? sel.mine.slice(0, String(sel.logv).split('...')[0].length)
              : sel.logv) + '</div>' +
            '<div class="lab-note">复算值长度 <b>' + (sel.mine.length / 2) + ' 字节</b>；' +
            '日志记录的长度字段 ' + (k === 4 ? '<b>outLen = 16</b>' : '与之一致') + '。</div></div>';

          const myTry = C.normHex(v.outhex || '');
          if (myTry) {
            html += myTry === got4
              ? '<div class="lab-msg pass"><b>✅ 你填的密文与真实复算结果完全一致</b>' +
                '<div class="lab-note">你已经完成了一次完整的还原：<b>从日志里读出参数，用另一套实现算出同样的结果。</b>' +
                '这就是本章要交付的能力。</div></div>'
              : '<div class="lab-msg fail"><b>❌ 你填的密文与真实复算结果不一致</b>' +
                '<div class="lab-note">对照上面那行完整值。最常见的三个原因：' +
                '<b>①</b> 把 32 字节密钥当成 16 字节用了（这是 AES-128 与 AES-256 的区别）；' +
                '<b>②</b> 忘了 PKCS5Padding 会把 8 字节明文补成 16 字节（补 8 个 0x08）；' +
                '<b>③</b> 手抄时漏字符。</div></div>';
          } else {
            html += '<div class="lab-msg warn"><b>把上面那行完整密文填进 ②，再点一次「检查我的答案」</b>' +
              '<div class="lab-note">这一小步就是「复算」——本章所有结论都建立在这个动作上。</div></div>';
          }
          return html;
        },
        expected: (v) => {
          const C = window.CRYPTO;
          const recs = CH24_LOG_ROWS.map(s => JSON.parse(s));
          const find = (algoPart) => recs.filter(r => r.t === 'Cipher' && r.ev === 'init' && String(r.algo).indexOf(algoPart) >= 0)[0];
          const findD = (algoPart) => recs.filter(r => r.t === 'Cipher' && r.ev === 'doFinal' && String(r.algo).indexOf(algoPart) >= 0)[0];
          const i4 = find('ECB'), d4 = findD('ECB');
          const pad16 = b => {
            const n = 16 - (b.length % 16); const o = new Uint8Array(b.length + n);
            o.set(b); for (let i = b.length; i < o.length; i++) o[i] = n; return o;
          };
          const pt = C.fromHex(d4.in);
          const want = C.toHex(C.aesEncryptBlock(pad16(pt), C.aesKeyExpansion(C.fromHex(i4.key))));

          const got = C.normHex(v.outhex || '');
          const algos = window.AKKC_hasConcept(v.verdict || '',
            ['MD5', 'SHA-1', 'SHA1', 'HMAC', 'HmacSHA1', 'AES', 'CBC', 'ECB',
             'PKCS5', 'PKCS7', 'PKCS#5', '填充', '分组', '摘要', '哈希', 'MAC', '消息认证']);
          const reason = window.AKKC_hasConcept(v.verdict || '',
            ['keyLen', '密钥长度', '32', 'AES-256', '256', '位数', '字节数',
             '截断', 'trunc', '长度上限', 'cap', '日志', '字段', '长度', 'outLen', '不能抄']);

          if (!got) {
            return { ok: false, detail: '先做第 ② 步：把复算出来的完整密文 hex 填进去。（提示：运行一次，答案就在输出里。）' };
          }
          const okLen = got === want;
          const ok = okLen && algos && reason;
          let detail = '';
          if (!okLen) {
            detail = '密文对不上。真实值是 <code>' + want + '</code>。注意这条记录的 <code>key</code> 是 ' +
              '<b>' + i4.keyLen + ' 字节</b>，必须用 AES-256（14 轮）的密钥扩展，而不是 AES-128。';
          } else if (!algos) {
            detail = '密文<b>完全正确</b>（这就是真实复算结果）。但第 ③ 问还差算法判断：' +
              '请写出四条记录分别是什么算法、什么模式、什么填充。';
          } else if (!reason) {
            detail = '算法判断与密文都对了。再把<b>依据</b>补上：你是靠哪个字段判断出密钥长度与变体的？' +
              '最后那条记录为什么必须复算而不能直接使用？';
          } else {
            detail = '<b>全部正确。</b>你完成了一次完整的日志驱动还原：' +
              '从 <code>algo</code> 拿到算法与模式，从 <code>keyLen</code> 拿到密钥长度（32 字节 → AES-256），' +
              '从缺失的 <code>iv</code> 字段判断出 ECB，最后用 <code>key</code> + <code>in</code> 复算出被截断的密文 ' +
              '<code>' + want + '</code>。<br>' +
              '<span class="hit">这一串动作里没有一行汇编，也没有一次「猜」。</span>';
          }
          return { ok, detail };
        },
        showAnswer:
          '【① 四条记录分别是什么】\n' +
          '  1. MessageDigest / MD5：两次 update（11 字节 + 29 字节）后 doFinal，输出 16 字节摘要。\n' +
          '     证据：algo 字段写的是 MD5；两条 update 的 seq 是 1、2（要按 seq 拼，不是按行序）。\n' +
          '  2. Mac / HmacSHA1：init 带 10 字节 key，doFinal 带 in 与 out，输出 20 字节。\n' +
          '     证据：algo=HmacSHA1；keyLen=10；输出长度 20 字节正好是 SHA-1 的摘要长度。\n' +
          '  3. Cipher / AES/CBC/PKCS5Padding：init 有 key（16 字节）和 iv（16 字节），doFinal 输出 32 字节。\n' +
          '     证据：transform 字符串直接写明算法/模式/填充；有 iv 字段 → 分组链式模式。\n' +
          '     明文 27 字节 → 密文 32 字节，多出的 5 字节就是 PKCS5 填充（补到 16 的整数倍）。\n' +
          '  4. Cipher / AES/ECB/PKCS5Padding：init 只有 key（32 字节），没有 iv 字段。\n' +
          '     证据：缺 iv → ECB（不需要 IV）；keyLen=32 → AES-256，不是 AES-128。\n' +
          '\n' +
          '【② 被截断那条的完整密文（真实复算结果）】\n' +
          '  e605e27d94d91e7edc77ad38f25512c9\n' +
          '  复算过程：\n' +
          '    in  = 70696e3d31323334                      → ASCII "pin=1234"（8 字节）\n' +
          '    PKCS5Padding：8 字节补 8 个 0x08 → 16 字节（正好一个分组）\n' +
          '    key = 32 字节 → AES-256 密钥扩展（14 轮）\n' +
          '    单分组 ECB 加密 → 16 字节密文 = 32 个 hex 字符\n' +
          '\n' +
          '【③ 关键依据与结论】\n' +
          '  · 算法/模式/填充这三件事，由 transform 字符串一次性给出。\n' +
          '  · 变体（128/192/256）由 keyLen 决定：16 → AES-128，24 → AES-192，32 → AES-256。\n' +
          '    这一条最容易错，而且错了之后的症状与「算法被魔改」完全一样。\n' +
          '  · 有没有 IV 由 iv 字段的有无判断：缺 iv 通常就是 ECB。\n' +
          '  · 填充方式由长度关系反推：密文是明文向上取整到块大小 → 有填充的分组模式。\n' +
          '  · out 字段被截断（outLen=16 但只写了 8 位 hex）说明日志有长度上限。\n' +
          '    截断不可怕，可怕的是不知道它被截断了——所以日志必须同时保留原始长度。\n' +
          '\n' +
          '【结论】有这份日志，还原不需要读一行汇编：算法、模式、填充、密钥、明文全在字段里，\n' +
          '剩下的唯一工作就是「用另一套实现复算一遍」。',
        hint:
          '读日志的顺序很重要：<b>先读结构性字段，再读内容字段。</b><br><br>' +
          '① 先看 <code>algo</code>——它可能直接写着 <code>AES/CBC/PKCS5Padding</code> 这种完整变换串，' +
          '<b>算法、模式、填充三件事一次到手</b>。<br>' +
          '② 再看 <code>keyLen</code>——AES 的变体由密钥长度决定：16 → AES-128，24 → AES-192，32 → AES-256。' +
          '选错变体，结果会变成一堆看似随机的垃圾，而你很可能误判成「算法被魔改了」。<br>' +
          '③ 然后看有没有 <code>iv</code> 字段——没有 IV 最典型的原因就是 ECB 模式。<br>' +
          '④ 最后看 <code>in</code> 与 <code>out</code> 的<b>长度关系</b>——密文比明文长、且是块大小整数倍，说明有填充。<br><br>' +
          '第 ④ 条记录的 <code>out</code> 只写了 8 位 hex 就跟着 <code>...(trunc, cap=8)</code>，' +
          '但同一批日志里的 <code>init</code> 给了密钥、<code>doFinal</code> 给了输入——<b>有这两样就能算出完整密文，不用抄。</b>',
        after:
          T.note('ok', '✅ 这个实验真正要你带走的',
            '<p style="margin-bottom:0">你刚刚做的事，在只有汇编的年代要花几个小时：' +
            '在反汇编里找到密钥加载的位置、推出是 AES-256 还是 AES-128、' +
            '判断模式和填充、再写一段代码验证。</p>' +
            '<p>现在它变成了三步：<b>读字段 → 定参数 → 复算。</b><br>' +
            '这正是本章标题里「自监控」三个字的落点——<b>沙箱不只是替你记日志，它让还原这件事变得可验证。</b>' +
            '而「可验证」意味着：当你算不出来的时候，你能确定问题出在自己的参数上，而不是在「算法可能被改了」这种无法证伪的怀疑里打转。</p>')
      }
    },

    /* ================= 13.11 ================= */
    {
      h: '13.11',
      title: '反模式清单：自吐沙箱最常见的六种失败',
      html:
        '<p>这一节把前面散落的坑集中起来。<b>如果你要自己做一个自吐沙箱，把这张表当成上线前的检查单。</b></p>' +
        T.tbl(['反模式', '典型症状', '根因', '对策'], [
          ['<b>① 0 命中就换工具</b>',
           '日志是空的 → 判定「沙箱没用」→ 改用 Frida 重做一遍',
           '把「没记到」当成「工具失败」，而没意识到它可能是<b>层次选错</b>或<b>探针 bug</b>',
           '先二分：门面类有没有命中？有 → 是 SPI/Provider 问题；没有 → 才是目标没用 JCA。见 13.6 决策'],
          ['<b>② 只记算法名，不记参数</b>',
           '日志里全是 <span class="mono">{"algo":"AES"}</span>，没有 key / IV / in / out',
           '把「监控 API 调用」当成了目标（那是 13.2 那一类工具），忘了本章要的是<b>还原材料</b>',
           '记录点的选择标准是「这一刻关键信息是否齐全」：<span class="mono">init</span> 拿 key/IV，' +
           '<span class="mono">doFinal</span> 拿 in/out，两个都要'],
          ['<b>③ 分块拼接错</b>',
           '日志里的 update 顺序看起来对，但复算总差一点；或者把 update 当成独立事件记录',
           '按<b>日志行序</b>而不是按 <span class="mono">seq</span> 拼接；或者漏记了某次 update',
           '每一条记录都带 <span class="mono">seq</span>，复算一律按 seq 排序（13.11L 实验专考这个）'],
          ['<b>④ 实例配错</b>',
           '并发场景下密钥与密文对不上，算出来的结果像乱码',
           '没按实例关联 init 与 doFinal，把 A 请求的 key 配到了 B 请求的密文上',
           '每条记录带实例 id 与线程 id；以「最近一次 init 的快照」为准'],
          ['<b>⑤ 写放大把目标拖死</b>',
           '设备发烫、App 被杀、日志还断档',
           '在插桩点做同步 IO；不截断；不聚合分块',
           '内存聚合 + 独立低优先级落盘线程 + 截断记长度 + 丢弃计数（13.7 决策）'],
          ['<b>⑥ 沙箱自己被检测</b>',
           '加了 seccomp/额外模块/额外进程之后，App 开始闪退或上报异常',
           '为了让观测点不被绕过而引入的措施，本身变成了<b>可被识别的特征</b>',
           '<b>尽量不改动运行时的可观测状态</b>：记录写进内存 + 异步落盘；' +
           '不引入新进程与新模块；改源码而不是 hook——见本节下面的案例呼应'],
          ['<b>⑦ 把日志当真相</b>',
           '拿一份断档的日志得出了确定结论',
           '没有检查 <span class="mono">seq</span> 连续性、<span class="mono">trunc</span> 标记与 <span class="mono">lost</span> 计数',
           '每次分析前先跑一遍完整性自检；有断档就在结论里标注不确定；被截断的字段绝不能当完整值用']
        ]) +
        T.note('warn', '⚠️ 第 ⑥ 条值得再展开一句',
          '<p>本章 13.8 的案例给出了一个很尖锐的实例：一个商业安全 SDK 通过读 ' +
          '<span class="mono">/proc/self/status</span> 的 <span class="mono">Seccomp:</span> 字段' +
          '<b>反过来识别那些用 seccomp 做对抗的沙箱</b>（正常应用是 0，装了过滤器的进程是 2）。</p>' +
          '<p>这条推理对做沙箱的人是一个提醒：<b>你以为的「加固措施」，在对手眼里可能就是「分析环境特征」。</b>' +
          '所以自吐沙箱的设计原则里应该有一条——<b>尽量让观测留在「数据」层面，不要留在「运行时可观测状态」层面。</b>' +
          '往内存里写一条记录，和往进程里加一个模块、起一个线程、装一个过滤器，是两种性质的改动。</p>' +
          '回来后一种。') +
        T.note('ok', '✅ 全章收束：把三句话串起来',
          '<p><b>① 选层决定视野。</b>框架层覆盖面广、算法层精度高、JNI 边界拿到的是数据流；' +
          '0 命中不是失败，是一条关于目标的信息。</p>' +
          '<p><b>② 拿到密钥就不必读汇编。</b>算法名、密钥、IV、明文、密文五样齐了，' +
          '还原就退化成「用另一套实现复算一遍」——这也是<b>可验证</b>的：算不出来时你能确定是参数错了，而不是算法被改了。</p>' +
          '<p><b>③ 边界要诚实。</b>native 自研 + 强混淆 + 密钥不出 Java 堆，这三样叠加时自吐无能为力；' +
          '此时回到<a href="ch11-algo1.html">第 22 章</a>的常量比对、<a href="ch12-algo2.html">第 23 章</a>的主动调用，' +
          '或者在 JNI 边界做数据流观测。<b>知道自己在哪一层、缺哪一层，比多会几个工具重要。</b></p>')
    },

    /* ================= 13.11L 动手实验二 ================= */
    {
      h: '13.11L',
      title: '动手实验二：分块 update 的拼接顺序',
      html:
        '<p>这一节专门考第三个坑：<b>分块更新的拼接顺序</b>。它是自吐沙箱里最隐蔽的错误——' +
        '因为日志看起来完全正常，只是你<b>读错了顺序</b>。</p>' +
        T.note('key', '🔑 为什么这个坑特别隐蔽',
          '<p>哈希和分组密码都是<b>顺序敏感</b>的：输入字节换一个位置，输出就完全不同。' +
          '而日志是<b>流式追加</b>写下来的，写入顺序和调用顺序在两种情况下会不一致：' +
          '<b>① 落盘线程异步、批量 flush</b>（多个实例的记录交错）；' +
          '<b>② 目标本身用了线程池并发做多次 update</b>。</p>' +
          '<p>所以「日志行序 = 调用顺序」是一个<b>未经证实的假设</b>。' +
          '判定真实顺序唯一可靠的依据，是每条记录自带的 <span class="mono">seq</span>。' +
          '<b>下面这段日志，行序就是错的。</b></p>'),
      lab: {
        title: '实验：判断分块顺序，并复算出正确摘要',
        goal: '目标：按 seq 拼接，复算验证',
        intro:
          '<p>同一台沙箱上另一个进程（pid 9012）的日志：</p>' +
          '<pre class="mono" style="white-space:pre-wrap;word-break:break-all;font-size:11.5px;line-height:1.75;padding:12px;background:rgba(0,0,0,.3);border:1px solid var(--line);border-radius:8px">' +
          CH24_L2_ROWS.join('\n') + '</pre>' +
          '<p><b>注意：日志行出现的顺序是 seq 3、1、2。</b>输入框 ① 里预填的就是「按日志行序」拼接，' +
          '你点一次运行就会看到它的后果。</p>' +
          '<p><b>任务：</b>① 找出正确的拼接顺序；② 用正确顺序复算出完整摘要；③ 说明为什么行序不可信。</p>',
        inputs: [
          { key: 'order', label: '① 拼接顺序（逗号分隔的 seq 编号）', hint: '预填的是「按日志行出现的顺序」，先看看会发生什么', type: 'hex', value: '3,1,2', ph: '例如 1,2,3' },
          { key: 'digest', label: '② 正确顺序下复算出的完整摘要 hex', hint: '32 位十六进制；运行一次就能看到正确值', type: 'hex', ph: '32 位 hex', rows: 1 },
          { key: 'why', label: '③ 为什么不能按日志行序拼接？', hint: '想想日志是怎么被写下来的', type: 'textarea', rows: 2, ph: '因为……' }
        ],
        runLabel: '🔍 按你给的顺序拼接并复算',
        autorun: true,
        run: (v) => {
          const C = window.CRYPTO;
          const hex = C.toHex;
          const recs = CH24_L2_ROWS.map(s => JSON.parse(s));
          const ups = recs.filter(r => r.ev === 'update');
          const fin = recs.filter(r => r.ev === 'doFinal')[0];

          const orderStr = String(v.order || '').replace(/[^0-9]/g, '');
          const order = orderStr.split('').map(x => parseInt(x, 10)).filter(x => x >= 1 && x <= 3);

          const cat = arr => {
            let n = 0; arr.forEach(b => { n += b.length; });
            const o = new Uint8Array(n); let p = 0;
            arr.forEach(b => { o.set(b, p); p += b.length; });
            return o;
          };
          const byOrder = ord => ord.map(seq => C.fromHex(ups.filter(r => r.seq === seq)[0].in));

          let html = '<div class="lab-kv">' +
            '<span>update 条数 <b>' + ups.length + '</b></span>' +
            '<span>你给的顺序 <b>' + (order.length ? order.join(' → ') : '（空）') + '</b></span>' +
            '<span>日志里的 doFinal <b>' + fin.out + '</b></span>' +
            '</div>';

          html += '<table class="lab-tbl"><tr><th>日志行序</th><th>seq</th><th>len</th><th>内容（hex → ASCII）</th></tr>';
          recs.filter(r => r.ev === 'update').forEach((r, i) => {
            let txt = '';
            try {
              C.fromHex(r.in).forEach(b => { txt += (b >= 32 && b < 127) ? String.fromCharCode(b) : '.'; });
            } catch (e) { txt = '?'; }
            html += '<tr><td>' + (i + 1) + '</td><td><b>' + r.seq + '</b></td><td>' + r.len + '</td>' +
              '<td style="font-size:12px">' + r.in + '<br><span class="muted">"' + txt + '"</span></td></tr>';
          });
          html += '</table>';

          if (!order.length) {
            return html + '<div class="lab-msg warn"><b>先在 ① 里填一个顺序</b>' +
              '<div class="lab-note">格式：逗号分隔的 seq 编号，比如 <code>1,2,3</code>。</div></div>';
          }

          const mine = hex(C.md5(cat(byOrder(order))));
          const good = order.join(',') === '1,2,3';

          html += '<div class="lab-msg ' + (mine === fin.out ? 'pass' : 'fail') + '">' +
            '<b>按 ' + order.join(',') + ' 拼接 → md5 = ' + mine + '</b>' +
            '<div class="lab-note">日志中的 doFinal 摘要是 <b>' + fin.out + '</b>　' +
            (mine === fin.out ? '→ <span class="lab-ok">✅ 一致</span>' : '→ <span class="lab-no">❌ 不一致</span>') + '</div>' +
            '<div class="lab-note">拼接后的字节数：<b>' + cat(byOrder(order)).length + '</b> ' +
            '（三条 update 的 len 分别是 ' + ups.map(r => r.len).join(' + ') + '）</div></div>';

          if (!good) {
            html += '<div class="lab-msg key"><b>🔑 为什么行序是错的</b>' +
              '<div class="lab-note">这三条 update 属于同一个 MessageDigest 实例，是被<b>依次</b>调用的：' +
              '<b>seq 1 → seq 2 → seq 3</b>。日志里行序乱掉，是因为记录先入内存缓冲、再由独立的落盘线程批量写出——' +
              '<b>行序反映的是「落盘时的排队顺序」，不是「调用顺序」。</b></div>' +
              '<div class="lab-note">把它改成 <code>1,2,3</code> 再运行一次，看摘要能不能对上。</div></div>';
          } else {
            html += '<div class="lab-msg pass"><b>✅ 顺序正确，摘要完全一致</b>' +
              '<div class="lab-note">这就是「分块拼接」的全部要点：<b>按 seq，不按行序。</b>' +
              '而且注意——如果日志里连 seq 都没有，你根本无法判断哪一条先发生：' +
              '三条 update 的任一种排列都会算出一个「看起来正常」的 32 位摘要，' +
              '你没有任何办法分辨哪个是真的。</div></div>';
          }

          const myDigest = C.normHex(v.digest || '');
          if (myDigest) {
            html += myDigest === fin.out
              ? '<div class="lab-msg pass"><b>✅ ② 你填的摘要正确</b><div class="lab-note">与日志中的 doFinal 完全一致。</div></div>'
              : '<div class="lab-msg fail"><b>❌ ② 与日志中的 doFinal 不一致</b>' +
                '<div class="lab-note">正确值是 <code>' + fin.out + '</code>。' +
                '注意它是「按 seq 拼接后」的 MD5，不是按日志行序算出来的那个。</div></div>';
          }
          return html;
        },
        expected: (v) => {
          const C = window.CRYPTO;
          const recs = CH24_L2_ROWS.map(s => JSON.parse(s));
          const ups = recs.filter(r => r.ev === 'update').sort((a, b) => a.seq - b.seq);
          const fin = recs.filter(r => r.ev === 'doFinal')[0];
          let n = 0; ups.forEach(r => { n += r.len; });
          const buf = new Uint8Array(n); let p = 0;
          ups.forEach(r => { const b = C.fromHex(r.in); buf.set(b, p); p += b.length; });
          const want = C.toHex(C.md5(buf));

          const gotOrder = String(v.order || '').replace(/[^0-9]/g, '');
          const okOrder = gotOrder === '123';
          const gotDigest = C.normHex(v.digest || '');
          const okDigest = gotDigest === want;
          const okWhy = window.AKKC_hasConcept(v.why || '',
            ['seq', '序号', '编号', '异步', '缓冲', '缓存', '并发', '线程', 'flush', '乱序', '顺序', '日志', '落盘', '批量', '排队', '写入顺序']);

          let detail = '';
          const ok = okOrder && okDigest && okWhy;
          if (!okOrder) {
            detail = '顺序还不对。请<b>按每条记录自己的 seq 编号</b>排，而不是按它在文件里出现的先后。' +
              '（日志行序是 3、1、2；正确顺序应当从 1 开始。）';
          } else if (!okDigest) {
            detail = '顺序对了，但摘要还没对上。用正确顺序拼出来的 MD5 应当是 <code>' + want + '</code>。' +
              '你也可以直接点一次「运行」，输出里会给出这个值。';
          } else if (!okWhy) {
            detail = '顺序与摘要都对了。把第 ③ 问补上：<b>为什么日志的行序不等于调用顺序？</b>' +
              '（提示：想一想记录是<b>先入内存缓冲、再由独立线程批量落盘</b>的——' +
              '行序反映的是落盘时的排队情况。）';
          } else {
            detail = '<b>全部正确。</b>你需要按 <code>1,2,3</code> 拼接，得到摘要 <code>' + want + '</code>。<br>' +
              '<span class="hit">关键结论：分块更新的拼接顺序<b>只能</b>由每条记录自带的序号决定——' +
              '日志的物理行序反映的是落盘时的排队顺序，而不是调用顺序。</span>' +
              '这也是 13.7 把 <code>seq</code> 列为第一个必需字段的原因。';
          }
          return { ok, detail };
        },
        showAnswer:
          '【① 正确顺序】1 → 2 → 3\n' +
          '  日志行序是 3、1、2，但每条记录自带 seq。判定依据只有 seq。\n' +
          '  seq 1 → "user="    （hex 757365723d，5 字节）\n' +
          '  seq 2 → "alice"    （hex 616c696365，5 字节）\n' +
          '  seq 3 → "&t=1700"  （hex 26743d31373030，7 字节）\n' +
          '  拼接结果："user=alice&t=1700"（17 字节）\n' +
          '\n' +
          '【② 正确摘要（真实复算）】\n' +
          '  a3ce80904ed7c8b953c00156245a72e9\n' +
          '  它正好等于日志中那条 doFinal 记录的 out 值 —— 这就是验证：\n' +
          '  既然只有一种排列能算出与日志一致的摘要，这条顺序就是唯一正确的。\n' +
          '\n' +
          '【③ 为什么行序不可信】\n' +
          '  记录是「先入内存缓冲、再由独立的落盘线程批量写出」的（为了不让日志拖慢目标，见 13.7）。\n' +
          '  于是文件里的行序反映的是【落盘时的排队情况】，而不是【调用发生的顺序】。\n' +
          '  更极端的情况：目标用线程池并发发起多次 update，写入顺序完全不可预测。\n' +
          '  所以「日志行序 = 调用顺序」是一个未经证实的假设，必须用 seq 来判定。\n' +
          '\n' +
          '【反面的教训】\n' +
          '  三条 update 一共只有 3! = 6 种排列，每一种都能算出一个「格式正常」的 32 位摘要。\n' +
          '  如果日志里没有 seq，你根本无从分辨哪个是真的 —— 这正是「可验证」比「看起来完整」重要的地方。',
        hint:
          '不要数日志的行号。<b>每条记录里有一个字段专门用来表达顺序</b>——它叫 <code>seq</code>。<br><br>' +
          '① 把三条 update 按 <code>seq</code> 从小到大排列，这就是调用顺序。<br>' +
          '② 把它们拼成一个字节序列，用 <b>MD5</b> 复算（日志里 <code>algo</code> 字段写着）。<br>' +
          '③ 复算结果应当与那条 <code>doFinal</code> 记录的 <code>out</code> 完全一致——' +
          '不一致就说明顺序错了。<br><br>' +
          '第 ③ 问的关键是理解日志是<b>怎么被写下来的</b>：记录先进入内存缓冲，' +
          '再由一个独立的线程批量刷到文件里。所以文件里的先后，反映的是<b>落盘排队</b>，不是<b>调用发生</b>。',
        after:
          T.note('ok', '✅ 这个坑的真实后果',
            '<p style="margin-bottom:0">在真实项目里，这个错误的表现是：<b>日志一切正常，但你复算出来的摘要/密文总差一点</b>。' +
            '于是你会开始怀疑「是不是加了盐」「是不是魔改了算法」——' +
            '而真相只是你把三条 update 按文件里的顺序拼了。</p>' +
            '<p>这就是为什么 13.7 把 <span class="mono">seq</span> 列为日志的第一个必需字段，' +
            '也是为什么 <span class="mono">lost</span> 与 <span class="mono">trunc</span> 要和它一起出现：' +
            '<b>顺序、完整性、截断，这三件事决定了这份日志能不能当成证据。</b></p>')
      }
    },

    /* ================= 13.12 ================= */
    {
      h: '13.12',
      title: '自测：把整章的判断串起来',
      html:
        '<p>最后一道自测。<b>它不考细节，考的是你有没有把「选层、复算、边界」这三件事连成一条判断链。</b></p>',
      quiz: {
        id: 'q24-5', chapter: 24, answer: 1,
        stem: '<b>综合题：</b>关于自吐沙箱的能力边界与工程取舍，下面哪个判断最准确？',
        options: [
          { t: '自吐沙箱是「一次投入、长期有效」的方案，因为密码学 API 是稳定的', why: 'API 稳定不等于插桩点稳定。门面类与 SPI 的结构、所在模块、打包方式都随 AOSP 版本变化；ART 模块化之后系统版本还不等于 ART 版本。每换一个目标版本就要重新适配，这正是它最大的代价。' },
          { t: '它的价值取决于「观测层」与「样本分布」是否匹配；评价一个方案要看它在你样本集上的覆盖比例，以及覆盖不到的那些样本有没有明确的下一步', why: '正确。自吐沙箱不是「能不能处理所有样本」的问题，而是「在你的样本分布上覆盖多少」的问题。而且因为探针的命中与不命中都指向明确的下一步，覆盖不到的部分也不会让你停摆。' },
          { t: '只要把插桩点覆盖到全部五层，就能覆盖所有样本', why: '五层里除 native 实现之外都是用户态观测面；即使全部铺开，遇到「native 自研算法 + 密钥不落 Java 堆」依然拿不到关键信息，而且五层同时维护的成本与日志量都不可接受。分层观测的前提是先便宜地确认目标走哪一层。' },
          { t: '自吐沙箱与 Frida 是互斥的两条路线，选了沙箱就不应该再用 Frida', why: '两者互补：源码沙箱适合长期、稳定、不可被发现的观测；Frida 适合快速验证一个假设（比如 dump 一次 getInstance 的返回类名），验证完就撤。把 Frida 当诊断工具而不是当退路，才是正确的用法。' }
        ],
        explain: '<b>这道题的正确选项里有两个词最关键：「样本分布」和「下一步」。</b><br><br>' +
                 '<b>「样本分布」</b>说的是：评价一台沙箱不能脱离它要处理的样本集。' +
                 '如果样本集里大多数目标用 JCA 或通用加密库，Java 层自吐就能拿到密钥与明文，收益极大；' +
                 '如果全都是 native 自研 + 密钥不出堆，那这套东西的命中率就接近于零。' +
                 '<b>所以「要不要做」永远是先看分布，再看技术。</b><br><br>' +
                 '<b>「下一步」</b>说的是：本章 13.1 那个动画的最后一格——' +
                 '<b>0 命中不是失败，而是一条关于目标的信息，它直接告诉你该换哪一层观测。</b>' +
                 '有了这一步，一个方案的边界就不会变成「死路」，而只是「另一条路的入口」。<br><br>' +
                 '另外三个选项分别对应三种典型的认知偏差：把「API 稳定」当成「插桩点稳定」、' +
                 '把「覆盖面」理解成「枚举所有已知实现」、把「工具选择」理解成「路线站队」。' +
                 '这三种偏差在本章的不同小节里都出现过，值得回去对照。'
      },
      after: T.note('ok', '✅ 本章完成',
        '<p>回头看，这一章其实只做了一件事：<b>把第 18 章那一行探针，扩展成一套可以信任的观测系统。</b></p>' +
        '<p>扩展的过程里有四次关键判断：<b>选层</b>（框架层还是算法层）、' +
        '<b>取准参数</b>（ByteBuffer、分块、实例关联、绝不能调 digest()）、' +
        '<b>让日志可信</b>（seq / len / trunc / lost）、' +
        '<b>认清边界</b>（native 自研时换层，而不是换工具）。</p>' +
        '<p>下一章会走出另一个极端：当算法被做成白盒——<b>连密钥都不再以明文形式存在</b>时，' +
        '自吐沙箱会彻底失效，那时候要换的是完全不同的武器。</p>')
    }
  ],

  glossary: [
    { t: '自吐沙箱', d: '一台「会自己招供」的定制运行环境：把观测点插进虚拟机或算法实现内部，让 App 在正常运行时自动把密码学运算的算法名、密钥、IV、明文、密文记成结构化日志。核心价值是<b>把「逆向算法」从读汇编降级成读日志 + 复算</b>；相对 Frida 的优势是不引入可被检测的框架特征、时序更早。' },
    { t: '观测层（观测点）', d: '探针所在的那一层：业务代码、JCA 门面类、Provider/SPI、JNI 边界、native 实现。<b>能观测到什么完全由这一层决定，与探针写得好不好无关。</b>选层由「我要观测什么」决定，而不是由「哪层技术更高级」决定。' },
    { t: 'JCA 门面类', d: '<span class="mono">java.security.MessageDigest</span>（哈希）、<span class="mono">javax.crypto.Cipher</span>（对称加解密）、<span class="mono">javax.crypto.Mac</span>（消息认证码）。它们是标准密码学调用的必经之路，也是参数汇聚的地方，因此是命中率最高的插桩点。' },
    { t: 'SPI', d: 'Service Provider Interface。门面类背后的真正实现接口：<span class="mono">MessageDigestSpi</span> / <span class="mono">CipherSpi</span> / <span class="mono">MacSpi</span>。门面类负责「找谁算 + 状态维护」，SPI 子类负责「真的去算」。<b>要看「是谁在算」，必须下沉到这一层。</b>' },
    { t: 'Provider', d: '密码学服务的提供者，决定某个算法名由哪个 SPI 实现承担。目标可以用自定义 Provider，此时它的实现类很可能不在你的 AOSP 源码树里。<b>「门面类有日志、SPI 没日志」是自定义 Provider 的典型信号。</b>' },
    { t: '分块更新', d: '哈希与分组密码都支持多次 <span class="mono">update</span> 后再 <span class="mono">doFinal</span>（长报文、大文件被分段喂入）。<b>日志必须保留分块边界与顺序</b>，否则无法还原真实的输入拼接方式（盐加在哪、顺序有没有被调整）。' },
    { t: 'ByteBuffer 入参', d: '密码学 API 的另一种入参形态。读取时必须：① 用 <span class="mono">duplicate()</span> 拿一个位置独立的视图；② 按 <span class="mono">remaining()</span> 读有效区间；③ <b>绝不移动原 buffer 的 position</b>。<span class="mono">array()</span> 对 DirectByteBuffer 不可用。' },
    { t: '只读不改（插桩纪律）', d: '探针不得改变目标的行为。在密码学场景里的具体含义是：<b>不调用任何有副作用的方法</b>——最典型的就是为了「看一眼中间状态」而调用 <span class="mono">digest()</span>，它会复位摘要状态，直接改坏目标后续的结果。' },
    { t: 'opmode', d: '<span class="mono">Cipher.init</span> 的第一个参数，整数常量表示方向（加密 / 解密）。<b>记日志时必须翻译成文字</b>，否则长期维护时无法阅读。解密路径的记录同样有价值——App 里解密往往比加密更常见。' },
    { t: 'PKCS5Padding', d: '分组密码的填充方案（在 16 字节块下即 PKCS#7）：把数据补齐到块大小的整数倍，补的字节值等于补的字节数（8 字节明文补 8 个 0x08）。<b>「密文长度是明文向上取整到块大小」是判断「有填充的分组模式」的直接依据。</b>' },
    { t: 'JSONL', d: '一行一条 JSON 的日志格式。选它的理由：可 grep、可流式追加、单行写入天然原子（中断最多损失最后一行）、几乎每种语言都能直接读。<b>不要用一个大 JSON 数组</b>——追加时要改文件尾部，中断即整份报废。' },
    { t: '写放大', d: '记录产生的速度超过落盘能力时，日志系统反而成为目标进程的负担（设备发烫、App 被杀、日志还断档）。解法是<b>内存聚合 + 独立低优先级线程批量落盘 + 截断记长度 + 丢弃计数</b>，而不是「少记几个字段」。' },
    { t: 'seq 连续性检查', d: '用单调递增序号检查日志有没有断档。<b>序号断档与丢弃计数吻合，说明你的模型自洽。</b>这是「日志能自证它丢了什么」的核心手段——一份可信的日志不是看起来完整的日志，而是丢失可见的日志。' },
    { t: '数据流观测', d: '在 JNI 边界记录「进去什么字节、出来什么字节」，不关心 native 里怎么算。<b>它等价于一次不需要发起的黑盒调用</b>，是算法完全自研、Java 层零命中时最值得投入的一层观测。' },
    { t: '内联 SVC', d: '不经过 libc 封装函数、直接在代码里写 <span class="mono">SVC #0</span> 发起系统调用。它让 PLT/GOT hook 与 inline hook libc 完全失效（执行路径不经过 libc 的函数入口），<b>只有内核层的 seccomp-bpf 能拦截</b>。是「用户态函数级观测点被绕过」的极端形态。' },
    { t: 'seccomp-bpf', d: '内核级系统调用过滤机制，在 syscall 进入内核时拦截，与用户态调用方式无关，因此能拦住内联 SVC。<b>但它本身会留下痕迹</b>：<span class="mono">/proc/self/status</span> 的 <span class="mono">Seccomp:</span> 字段（正常应用 0、装了过滤器 2）可被目标反过来用来识别沙箱。' },
    { t: 'KAT（已知答案测试向量）', d: 'Known Answer Test。自吐日志里真实业务产生的那组明文/密文，就是一组现成的 KAT。<b>用它先校准主动调用的链路，再批量生产</b>——否则你无法判断批量结果是真是假。这是自吐与主动调用配合中最实用的一环。' },
    { t: '版本绑定', d: '改 AOSP 源码做沙箱的最大代价：插桩点、所在模块、打包方式都随版本变化，每换一个目标版本就要重新适配。Android 12 起 ART 成为可独立升级的 APEX 模块，<b>系统版本不再等于 ART 版本</b>。' }
  ],

  teacher: {
    id: 't24', chapter: 24,
    name: '沙箱监工',
    sub: '日志不会说谎，但会被读错——我盯的就是你有没有读错。',
    intro: '<p style="margin:0">我不问你 API 名字，也不问你常量表长什么样。' +
           '我只问一件事：<b>当你的探针什么都没记到时，你凭什么判断下一步该做什么？</b>' +
           '答不上来也没关系，我会给提示、会追问。三次之后我会把答案讲给你听——但那一题要你自己复述一遍才算过。</p>',
    questions: [
      /* ---------- 第 1 题 ---------- */
      {
        id: 'c24q1', depth: 1, threshold: 0.7,
        q: '自吐沙箱的观测点可以插在<b>框架层</b>（JCA 门面类、Provider/SPI、JNI 边界），也可以插在<b>算法层</b>（具体实现）。' +
           '<b>这两者各自能看到什么、代价是什么？为什么说它们不是二选一？</b>',
        concepts: [
          { label: '框架层的优势是覆盖面：一次投入可以覆盖一大批样本',
            hint: '算法有无穷多种，而系统提供的 API 只有有限几个。',
            any: ['覆盖面', '覆盖', '批量', '一次覆盖', '通用', '样本集', '范围广', '广泛', '省事', '廉价'] },
          { label: '框架层拿不到参数级信息（密钥、明文），只能知道「调用了哪个 API」',
            hint: 'API 名字里没有密钥。密钥在哪？',
            any: ['参数', '密钥', '拿不到', '看不到', '只知道', '调用名', '算法名', '不含语义', '业务语义'] },
          { label: '算法层的优势是精确：算法名、密钥、IV、明文、密文同时在手',
            hint: '哪一层能同时看见「算法 + 参数 + 输入输出」？',
            any: ['精确', '齐全', '密钥', 'iv', '明文', '密文', '输入输出', '参数级', '完整', '五样'] },
          { label: '算法层的代价：要事先知道目标用什么，而且算法一下沉就失效',
            hint: '如果目标根本不用这个 API，你插得再准有什么用？',
            any: ['下沉', 'native', '自研', '失效', '前提', '依赖', '知道', '绕过', '命中率'] },
          { label: '两者是「先铺面再取点」的配合关系，不是二选一',
            hint: '先用便宜的手段问「目标走不走这条路」，再决定要不要下沉。',
            any: ['不是二选一', '先', '再', '结合', '配合', '互补', '两层', '组合', '顺序', '铺面'] },
          { label: '0 命中本身是一条有效信息，指向下一步该换哪一层',
            hint: '「什么都没记到」是不是等于「白干了」？',
            any: ['0 命中', '零命中', '没有命中', '阴性', '信息', '证据', '下一步', '换一层', '有意义'] }
        ],
        hints: [
          '先把两者的「成本结构」说清楚：一个是「便宜但浅」，一个是「精确但贵」。',
          '再想一个更基本的问题：如果探针什么都没记到，这个结果本身有没有价值？'
        ],
        probes: [
          '那你说说，什么情况下应该插在 JNI 边界，而不是门面类？',
          '如果目标用了自定义 Provider，你的框架层探针会看到什么、看不到什么？'
        ],
        model: '<b>先把两者当成两种不同的「成本结构」来看，而不是两种技术的高低。</b><br><br>' +
               '<b>框架层（②③④）</b>：门面类、Provider/SPI、JNI 边界。<b>优势是覆盖面</b>——' +
               '算法有无穷多种，但系统提供的接口是有限的、稳定的。' +
               '在门面类上插一处探针，就能覆盖所有经过 JCA 的调用，不管调用者是谁、用的是哪个 Provider。' +
               '<b>代价是精度</b>：门面类能告诉你「这个 App 调了 AES/CBC/PKCS5Padding」，' +
               '但密钥与明文的交汇点在<b>参数</b>里——如果你只记了方法名，就等于只做了一份「调用统计」。' +
               '另外 SPI 层还有额外的坑：自定义 Provider 的实现类可能根本不在你的源码树里。<br><br>' +
               '<b>算法层（⑤）</b>：具体实现所在的层。<b>优势是精确</b>——算法名、密钥、IV、明文、密文五样同时在手，' +
               '复算所需的全部字段一次到位（这也是 13.6 那句「拿到密钥就不必读汇编」的落点）。' +
               '<b>代价有两个</b>：一是你<b>必须事先知道目标用什么</b>，否则不知道往哪儿插；' +
               '二是<b>算法一下沉就失效</b>——观测点在 Java 层，而调用根本不经过 Java 层，你自然一条都记不到。<br><br>' +
               '<b>为什么不是二选一？</b>因为它们的组合方式有一个明确的顺序：<b>先用框架层铺面，再用算法层取点。</b>' +
               '先用最便宜、最通用的门面类探针问一个问题——「目标到底走不走 JCA、用的是哪几个类」——' +
               '再根据答案决定要不要为它单独下沉。<br><br>' +
               '<b>而这里最关键的一个认知是：0 命中不是失败。</b>' +
               '「整份日志为空」是一条关于目标的强证据：<b>它没有走你插桩的那一层。</b>' +
               '这条证据直接把下一步（换到 JNI 边界做数据流观测，或者回到第 22 章的常量比对）指得很清楚。' +
               '很多人真正的失败不在技术上，而在心理上——把「没日志」当成「工具没用」，然后换工具重来一遍。',
        after: '<p>记住这个顺序：<b>先问「目标走不走这条路」，再决定「我要在哪一层动手」。</b></p>'
      },

      /* ---------- 第 2 题 ---------- */
      {
        id: 'c24q2', depth: 1, threshold: 0.7,
        q: '你在 <span class="mono">MessageDigest</span> 的 <span class="mono">update</span> 上插桩。' +
           '<b>为什么必须单独处理 <span class="mono">ByteBuffer</span> 这种入参形态？' +
           '直接用 <span class="mono">buffer.array()</span> 取字节有什么问题？</b>',
        concepts: [
          { label: 'update 有多个重载（byte[]、byte[],int,int、ByteBuffer），只覆盖一种会漏',
            hint: '目标可能用 NIO 或序列化库，它们内部用的是哪种入参？',
            any: ['重载', '三种', '多个', 'bytebuffer', 'update', 'byte[]', '覆盖', '漏'] },
          { label: 'array() 对 DirectByteBuffer 不可用（会抛异常或拿不到）',
            hint: '堆外内存的 buffer 有没有 backing array？',
            any: ['directbytebuffer', '直接缓冲', '堆外', 'array', '异常', '不可用', 'backing', 'unsupported'] },
          { label: '即使能拿到 backing array，也必须按 position/limit（remaining）取有效区间',
            hint: '整个数组都是这次调用的输入吗？',
            any: ['position', 'limit', 'remaining', '有效', '区间', '长度', '读多少', '有效数据', 'capacity'] },
          { label: '不能改变原 buffer 的 position，否则就改变了目标行为',
            hint: '读操作会不会移动位置指针？移动了会怎样？',
            any: ['position', '位置', '移动', '改变', '行为', '副作用', '只读', '影响目标'] },
          { label: '正确做法是用 duplicate()（或 slice）拿一个位置独立的视图',
            hint: '有没有一个方法能「共享内容但位置独立」？',
            any: ['duplicate', '副本', '复制', '视图', 'slice', '拷贝'] },
          { label: 'byte[],int,int 形态要按 off/len 切片，不能整数组记录',
            hint: '同一个坑在另一个重载上是哪个参数？',
            any: ['off', 'offset', 'len', 'length', '偏移', '切片', '从一个位置开始'] }
        ],
        hints: [
          '先回想 ByteBuffer 的对象模型：它除了内容，还带着 position 和 limit 两个游标。',
          '再想插桩的第一纪律：只读不改。读一个 buffer 会不会不小心改了它？'
        ],
        probes: [
          '如果目标复用了同一个 ByteBuffer 连续调用两次 update，你的日志会有什么风险？',
          '为什么说「按 remaining() 读」比「按 capacity() 读」更正确？'
        ],
        model: '<b>根因是 ByteBuffer 不是「一段字节」，而是「一段字节 + 两个游标」。</b><br><br>' +
               '<b>第一，重载必须全部覆盖。</b>哈希与加密 API 通常有三个 update 形态：' +
               '<span class="mono">update(byte[])</span>、<span class="mono">update(byte[], int, int)</span>、' +
               '<span class="mono">update(ByteBuffer)</span>。如果只插 <span class="mono">byte[]</span> 版本，' +
               '用 NIO、序列化库或部分加密库内部实现的目标就会在你的日志里「不存在」——而它们的功能一切正常。' +
               '这类漏报最坑的地方是<b>它看起来像「目标没用这个方法」</b>。<br><br>' +
               '<b>第二，<span class="mono">array()</span> 不可靠。</b>只有带 backing array 的堆内 buffer 才能调它；' +
               '对 <span class="mono">DirectByteBuffer</span>（堆外内存）调用会直接抛 ' +
               '<span class="mono">UnsupportedOperationException</span>。' +
               '而高风险场景恰恰爱用 DirectBuffer（避免拷贝）。<br><br>' +
               '<b>第三，即使拿到了数组，也不知道哪一段是这次的输入。</b>' +
               'ByteBuffer 的有效数据是 <span class="mono">[position, limit)</span>，对应 <span class="mono">remaining()</span> 个字节。' +
               '<b>按 <span class="mono">capacity()</span> 读会多读垃圾；按 <span class="mono">array()</span> 整段读会多读「不属于这次运算的字节」</b>——' +
               '而这类噪音在复算时会让你怀疑「是不是加了盐」。<br><br>' +
               '<b>第四，也是最容易犯的一条：读操作会移动 position。</b>' +
               '如果你直接在原 buffer 上 <span class="mono">get()</span>，position 就跑到 limit 了，' +
               '目标后续的读取会拿到空数据——<b>你观测的行为被你改变了，违反了「只读不改」这条纪律。</b><br><br>' +
               '<b>正确写法只有一种：</b>先 <span class="mono">ByteBuffer dup = buffer.duplicate()</span> 拿一个' +
               '<b>内容共享、位置独立</b>的视图，再 <span class="mono">new byte[dup.remaining()]</span>，' +
               '然后 <span class="mono">dup.get(chunk)</span>。原 buffer 的 position 一动不动，目标毫无感知。<br><br>' +
               '同样的道理适用于 <span class="mono">update(byte[], int, int)</span>：必须按 <span class="mono">(off, len)</span> 切片，' +
               '而不是记录整个数组——那个数组很可能是被复用的缓冲区。',
        after: '<p>一条通用规则：<b>凡是「带游标的入参」，读之前先拿独立视图。</b>这个坑在 NIO、流、序列化里到处都是。</p>'
      },

      /* ---------- 第 3 题 ---------- */
      {
        id: 'c24q3', depth: 2, threshold: 0.7,
        q: '很多人在写哈希探针时，会为了「看一眼当前算到哪了」而在 <span class="mono">update</span> 之后调用一次 ' +
           '<span class="mono">digest()</span>。<b>为什么这是绝对不能做的？</b>' +
           '以及：第 18 章那条「只读不改」的纪律，在密码学插桩里<b>具体的含义</b>是什么？',
        concepts: [
          { label: 'digest() 有副作用：算完摘要后会复位摘要状态',
            hint: 'JCA 对 digest() 之后的实例状态是怎么约定的？',
            any: ['复位', 'reset', '重置', '清空', '状态', '副作用', '有副作用'] },
          { label: '结果会让目标后续的摘要算错，而且症状会误导你',
            hint: '目标下一个 digest() 拿到的是什么？',
            any: ['算错', '结果错', '不对', '破坏', '影响', '后续', '下一个', '签名', '错误'] },
          { label: '「只读不改」在密码学场景里 = 不调用任何有副作用的方法，不只是「别写内存」',
            hint: '这条纪律只是关于内存写入吗？',
            any: ['只读不改', '副作用', '不改变', '行为', '不改逻辑', '调用', '观测', '不参与'] },
          { label: '正确做法是在目标自己的 digest() 里读它的返回值',
            hint: '你不需要主动去取，目标自己会取。',
            any: ['在 digest', '返回值', '它自己', '让目标', '读返回', '记录返回', '顺带'] },
          { label: '确实需要中间状态时，只能做只读拷贝（快照），不能调用会改变状态的方法',
            hint: '想看内部状态，有没有「不改动」的看法的？',
            any: ['拷贝', '复制', '只读', '快照', 'readonly', 'copy', '不改动'] }
        ],
        hints: [
          '先查一件事：JCA 约定 digest() 调用之后，这个 MessageDigest 实例处于什么状态？',
          '然后问：如果你的探针让它多复位了一次，目标下一次拿到的摘要还是它想要的吗？'
        ],
        probes: [
          '那 reset() 呢？在探针里调 reset() 有没有问题？',
          '如果某个实现允许你只读地导出内部状态，你会怎么确认它真的没有副作用？'
        ],
        model: '<b>因为 <span class="mono">digest()</span> 不是一个查询方法，它是一个改变状态的操作。</b><br><br>' +
               'JCA 的约定是：<span class="mono">digest()</span> 在计算完摘要之后<b>会把摘要状态复位</b>' +
               '（效果等价于随后调用了一次 <span class="mono">reset()</span>），这样同一个实例可以接着算下一个摘要。' +
               '也就是说，它一边给你结果，一边把机器归零。<br><br>' +
               '<b>所以你的探针每多调一次 digest()，就等于替目标多做了一次复位。</b>' +
               '后果是：目标后续算出来的摘要与它期望的完全不同——' +
               '而<b>最恶劣的地方在于症状会误导你</b>：App 的签名校验失败，你会去怀疑算法被魔改了、怀疑是盐不对，' +
               '却想不到问题出在自己的「观测」动作上。<b>这是观察者效应在插桩里的教科书形态。</b><br><br>' +
               '<b>那「只读不改」在密码学插桩里到底是什么意思？</b>' +
               '它比「别写内存」要宽得多：<b>不改变入参的任何状态（ByteBuffer 的 position、数组内容、对象引用）、' +
               '不调用任何有副作用的方法、不影响时序、不改变返回值。</b>' +
               '一句话：<b>探针只能旁观，不能参与。</b><br><br>' +
               '<b>正确做法：</b>把记录点放在目标<b>自己</b>会调用的那些方法里——' +
               '在 <span class="mono">update</span> 里记入参，在 <span class="mono">digest</span> 里记它<b>返回的那个数组</b>。' +
               '你不需要主动去要任何东西，目标走到哪里你就记到哪里。<br><br>' +
               '如果你真的需要中间状态，唯一合法的路径是<b>对内部状态做只读拷贝（快照）</b>——' +
               '而且这个「只读」必须自己验证过：读完之后，目标的摘要结果必须与插入探针之前逐字节一致。<br><br>' +
               '顺带回答那个常见的追问：<b>探针自己调用 <span class="mono">reset()</span> 同样是不行的</b>，' +
               '原因一模一样——它也是有副作用的方法。',
        after: '<p>这条纪律有一个可直接执行的验收标准：<b>关掉探针，目标的行为必须与开着时完全一致。</b>' +
               '对不上就说明你的探针参与进去了。</p>'
      },

      /* ---------- 第 4 题 ---------- */
      {
        id: 'c24q4', depth: 2, threshold: 0.7,
        q: '分块 <span class="mono">update</span> 的拼接顺序是自吐沙箱最隐蔽的坑。<b>为什么它会出错？' +
           '为什么「日志的行序」不能当作「调用的顺序」？你需要日志里具备哪些字段才能避免这个问题？</b>',
        concepts: [
          { label: '哈希与分组密码对输入顺序敏感：换一个位置结果就完全不同',
            hint: 'MD5 的输入如果是「abc」，换成「bca」会怎样？',
            any: ['顺序敏感', '顺序', '位置', '拼接', '排列', '换位置', '顺序相关', '不一样'] },
          { label: '日志是先入内存缓冲、再由独立线程批量落盘的，所以行序反映的是落盘排队',
            hint: '为什么要异步落盘？异步之后写入顺序由什么决定？',
            any: ['缓冲', '缓存', '异步', '线程', '批量', '落盘', 'flush', '排队', '写出'] },
          { label: '因此「日志行序 = 调用顺序」是一个未经证实的假设',
            hint: '你有没有验证过这个假设？怎么验证？',
            any: ['行序', '写入顺序', '文件顺序', '不等于', '不是', '假设', '未经证实', '未必'] },
          { label: '必须靠每条记录自带的 seq（单调递增序号）来判定真实顺序',
            hint: '唯一可靠的判据是哪个字段？',
            any: ['seq', '序号', '编号', '递增', '单调', '序列号'] },
          { label: '并发场景下顺序完全不可预测（线程池交错）',
            hint: '如果目标用线程池并发发起多次 update 呢？',
            any: ['并发', '多线程', '线程池', '交错', '不可预测', '竞争', '并行'] },
          { label: '还需要 len / trunc / lost 之类的字段来判断这份日志是否完整',
            hint: '顺序对了，但如果中间丢了几条呢？',
            any: ['len', 'trunc', 'lost', '长度', '截断', '丢弃', '完整', '断档', '缺失'] }
        ],
        hints: [
          '先回答一个更基础的问题：这条记录是「什么时候」写进文件的？是调用发生时，还是之后某个时刻？',
          '然后想：如果写入是批量、异步的，那文件里的先后代表什么？'
        ],
        probes: [
          '如果日志里没有 seq，你有没有别的办法判断顺序？',
          '三条 update 一共 6 种排列，每一种都能算出一个格式正常的 32 位摘要——这说明什么？'
        ],
        model: '<b>这个坑之所以隐蔽，是因为出错的每一环单独看都很合理。</b><br><br>' +
               '<b>第一层原因：算法对顺序敏感。</b>哈希和分组密码的输入是字节序列，' +
               '<b>换一个位置就得到完全不同的结果</b>。所以「拼接顺序」不是一个细节，它是还原的一部分。' +
               '更麻烦的是：三条 update 一共有 6 种排列，<b>每一种都能算出一个「格式完全正常」的 32 位摘要</b>——' +
               '你没有任何办法靠肉眼看结果判断哪个是真的。<br><br>' +
               '<b>第二层原因：日志不是同步写的。</b>13.7 讲过为什么必须异步落盘——' +
               '如果在插桩点直接写文件，高频调用会把目标拖死，而且耗时异常本身就是可被检测的特征。' +
               '于是记录先进入<b>内存缓冲</b>，再由一个独立的<b>低优先级线程批量刷盘</b>。<br><br>' +
               '<b>结论就是：文件里的行序反映的是「落盘时的排队情况」，而不是「调用发生的顺序」。</b>' +
               '这两个顺序在<b>并发</b>场景下会彻底脱钩——目标完全可能用线程池同时发起多次 update，' +
               '此时写入顺序根本不可预测。<br><br>' +
               '<b>所以「日志行序 = 调用顺序」是一个未经证实的假设</b>，而它恰好是一个会静默出错的假设：' +
               '顺序错了，日志看起来毫无异常，你只会得到「算不对」这个结果，' +
               '然后开始怀疑算法被魔改、怀疑有隐藏的盐——方向全错。<br><br>' +
               '<b>要避免它，日志里至少要有四个字段（13.7 的设计清单）：</b><br>' +
               '<b>① <span class="mono">seq</span></b>——单调递增序号，判定真实顺序的<b>唯一</b>依据；<br>' +
               '<b>② <span class="mono">len</span></b>——每块的字节数，既用于拼装，也用于和 seq 交叉校验（有没有漏块）；<br>' +
               '<b>③ <span class="mono">trunc</span></b>——标记这条记录被截断过，被截断的字段绝不能当完整值用；<br>' +
               '<b>④ <span class="mono">lost</span></b>——丢弃计数。有了它，你才能判断「少了一条」是<b>丢在落盘</b>，' +
               '还是<b>根本没产生</b>。<br><br>' +
               '把这四个凑齐，你的日志才从「一段看起来正常的文本」变成<b>可验证的证据</b>：' +
               'seq 连续、len 加起来等于预期输入长度、没有 trunc、lost 为 0 —— 四条全过，你才有资格说「这份日志可以信」。',
        after: '<p><b>顺序、完整性、截断</b>——这三件事决定一份日志能不能当证据。缺了任何一个，你都在猜。</p>'
      },

      /* ---------- 第 5 题（综合，depth 3） ---------- */
      {
        id: 'c24q5', depth: 3, threshold: 0.6,
        q: '<b>综合题。</b>请完整比较<b>自吐沙箱</b>与 <b>Frida hook</b>：' +
           '各自的优势与代价分别是什么？然后各给出<b>一个只能用沙箱的场景</b>和<b>一个只能用 Frida 的场景</b>，并说明理由。',
        concepts: [
          { label: '沙箱优势：观测点在虚拟机/源码内部，不引入可被检测的框架特征',
            hint: 'Frida 必须在目标进程里留下什么？改源码又留下什么？',
            any: ['检测', '特征', '痕迹', '不引入', '隐蔽', '进程', '模块', '线程', '无痕', '不被发现'] },
          { label: '沙箱优势：时序更早，没有 attach 竞态，进程启动即就位',
            hint: '如果目标在你 attach 之前就算过一次签名呢？',
            any: ['时序', '更早', 'attach', '竞态', '错过', '启动', '就位', '第一', '抢', '先于'] },
          { label: '沙箱优势：能改内部实现，看到 hook 够不到的中间状态',
            hint: '哪一层能看到算法内部的轮状态？',
            any: ['内部', '源码', '中间状态', '实现', '编译进去', '直接改', '轮', '深层'] },
          { label: '沙箱代价：编译环境、版本绑定、刷机风险、完整性校验',
            hint: '这条路不是免费的，钱花在哪？',
            any: ['编译', 'aosp', '版本', '刷机', '风险', '成本', '维护', '适配', '完整性', '变砖'] },
          { label: '只能用沙箱的场景：目标有强反调试/环境检测，且需要长期稳定、批量、不可被发现的观测',
            hint: '什么样的任务要求「目标完全感知不到你在分析」？',
            any: ['反调试', '检测', '长期', '稳定', '不可被发现', '批量', '持续', '产品', '样本集'] },
          { label: '只能用 Frida 的场景：快速验证一个假设 / 一次性分析 / 无法刷机的设备',
            hint: '什么时候你只需要花五分钟确认一件事？',
            any: ['快速', '验证', '一次', '临时', '假设', '不能刷机', '没有设备', '应急', '探索', '试'] },
          { label: '两者可以配合：把 Frida 当诊断工具，验证完把结论落回沙箱实现',
            hint: '遇到 0 命中时，Frida 能用来做什么？',
            any: ['配合', '诊断', '互补', '结合', '验证完', '落回', '先用', '工具'] }
        ],
        hints: [
          '先说「代价」，因为代价往往决定了选择：一边贵在编译与维护，一边贵在可被发现。',
          '然后从「目标会不会检测你」和「这个任务是长期还是临时」这两个维度，各构造一个极端场景。'
        ],
        probes: [
          '如果目标会校验系统镜像完整性，你的定制沙箱还能用吗？有什么出路？',
          '一个只能用沙箱的场景里，如果沙箱也失效了，你会怎么继续？'
        ],
        model: '<b>这两条路线的差别可以从「观测点在哪里」一路推到「什么时候该用哪一条」。</b><br><br>' +
               '<b>沙箱的优势有三条，而且它们都来自同一个事实：记录代码是编译进系统里的。</b><br>' +
               '<b>① 不可被发现。</b>Frida 必须把代码<b>注入</b>目标进程——于是进程里会多出模块、多出线程、多出内存特征，' +
               '这些都可以被枚举。而定制沙箱的探针就是虚拟机的普通代码，对目标而言这就是一台普通 Android。<br>' +
               '<b>② 时序更早。</b>不存在「attach 晚了」的竞态：进程从第一条指令起就在你的观测之下。' +
               '有些 App 在 <span class="mono">Application.onCreate</span> 之前就已经算过一次签名了，Frida 抢不到那一刻。<br>' +
               '<b>③ 能改内部实现。</b>你可以在算法实现内部记录中间状态（第几轮、状态矩阵），' +
               '这是任何外部 hook 都够不到的位置。<br><br>' +
               '<b>代价只有一条，但它很重：版本绑定。</b>' +
               '要搭 AOSP 编译环境（首次最痛）、源码随版本变化导致插桩点要重新定位、刷机有变砖风险、' +
               '而且部分 App 会校验系统镜像完整性——<b>定制 ROM 本身就是个可被识别的特征。</b>' +
               '更要留意 Android 12 之后 ART 成为可独立升级的 APEX 模块，<b>系统版本不再等于 ART 版本</b>，' +
               '这让「选对源码分支」这件事本身变复杂了。<br><br>' +
               '<b>只能用沙箱的场景：</b>你要做<b>长期的、批量的、且目标会主动检测分析环境</b>的观测。' +
               '典型形态是——你有一批样本要跑，目标里有反调试、有完整性校验、有 Frida 检测，' +
               '而你需要的不是「今天下午看到结果」，而是「这台环境未来半年都能稳定地吐数据」。' +
               '这时候 Frida 的每一次注入都在赌自己不被发现，而沙箱不需要赌。<br><br>' +
               '<b>只能用 Frida 的场景：</b>你要<b>快速验证一个假设</b>，或者<b>根本没有可控设备</b>。' +
               '最典型的是 13.6 那个决策情境——沙箱 0 命中，你怀疑是自定义 Provider，' +
               '于是用 Frida 花五分钟 dump 一次 <span class="mono">getInstance</span> 的返回类名，验证完就撤。' +
               '<b>五分钟 vs 两周的差别，就是 Frida 不可替代的地方。</b>' +
               '同理，如果目标是别人线上的 App、你只能在自己的普通手机上跑，' +
               '那你连刷机的条件都没有，沙箱路线从一开始就不成立。<br><br>' +
               '<b>最值得记住的是两者的配合方式：把 Frida 当诊断工具，而不是当退路。</b>' +
               '遇到 0 命中时退回 Frida 去「把答案拿到手」，等于放弃了源码沙箱存在的唯一理由' +
               '（如果 Frida 能解决问题，你一开始就不该花几周搭源码环境）；' +
               '但用 Frida 快速确认一个假设、然后把结论落回沙箱的实现里，就是两条腿走路。<br><br>' +
               '<b>一句话收束：</b>沙箱是「昂贵但信息完备且不可被发现」，Frida 是「廉价但会留下痕迹」。' +
               '按「这个任务需要多长时间的稳定观测」来选，而不是按「哪种技术更高级」。',
        after: '<p>同一套判断在第 18 章的严师题里出现过一次。如果你两处都能讲清，说明这个模型真的进你脑子了。</p>'
      },

      /* ---------- 第 6 题（综合，depth 3） ---------- */
      {
        id: 'c24q6', depth: 3, threshold: 0.6,
        q: '<b>综合题。</b>拿到的样本：加密全在 native、算法是<b>自研</b>的、密钥在 native 里派生。' +
           '你的 Java 层自吐沙箱<b>一条记录都没有</b>。<br>' +
           '请给出完整的判断链：<b>怎么确认这个 0 命中是「目标不走 JCA」而不是「我插错了」</b>？' +
           '确认之后有哪些出路、按什么顺序投入？以及为什么<b>不应该</b>直接换工具？',
        concepts: [
          { label: '先用二分确认归因：门面类有没有命中，以此区分「插错层」与「目标不走 JCA」',
            hint: '0 命中至少有两种解释，怎么用一次动作把它们分开？',
            any: ['门面类', '二分', '确认', '归因', '插错', '区分', '定位', '先确认', '第一次'] },
          { label: '看 so 的导入表/符号/常量，确认是调库还是自研实现',
            hint: '怎么用静态手段判断它到底有没有用通用加密库？',
            any: ['导入表', '符号', '常量', '调库', '自研', 'openssl', 'evp', 'so', '反汇编', 'iv'] },
          { label: '出路一：把插桩点下沉到 libc / 加密库层（EVP 系列），但只对用该库的目标有效',
            hint: '通用加密库有没有类似「汇聚点」的接口？',
            any: ['下沉', 'evp', 'openssl', 'libc', '加密库', '库层', 'boringssl'] },
          { label: '出路二：回到第 22/23 章——常量比对、动静态内存比对、主动调用',
            hint: '不依赖 API 的手段有哪些？',
            any: ['常量比对', '第 22 章', '第 23 章', '主动调用', '黑盒', '动静态', '内存比对', '特征'] },
          { label: '出路三：在 JNI 边界做数据流观测，只关心「进去什么、出来什么」',
            hint: '不关心算法怎么算，能不能只观测数据？在哪一层？',
            any: ['jni', '边界', '数据流', '进出', '字节数组', '进去什么', '出来什么', '观测数据'] },
          { label: '边界：密钥不出 native 时拿不到密钥，「拿到密钥就不必读汇编」这条捷径断了',
            hint: '这一章最值钱的那句话，在这个样本上还成立吗？',
            any: ['密钥', '拿不到', '不出', '边界', '句柄', 'keystore', '派生', '失效', '捷径'] },
          { label: '不该直接换工具：0 命中是信息，换工具不能修正一个选层错误',
            hint: '如果问题出在「观测层选错了」，换一个观测工具能解决吗？',
            any: ['换工具', '不是', '选层', '信息', '下一步', '归因', '路线', '诊断'] }
        ],
        hints: [
          '第一步永远不是「换个更强的工具」，而是「把 0 命中的原因弄清楚」。用什么动作能把两种解释分开？',
          '确认是自研之后，按成本从低到高排一下你能做的事——注意「密钥在 native 派生」这一条会砍掉哪些选项。'
        ],
        probes: [
          '如果它其实调了 OpenSSL，你会先做哪一件投入最小的事？',
          '这三条出路里，哪一条不需要你理解算法？为什么它反而常常最划算？'
        ],
        model: '<b>第一步永远是归因，不是换工具。</b><br><br>' +
               '<b>① 怎么确认 0 命中的原因。</b>0 命中至少有两种解释：<b>(a)</b> 目标不走 JCA；' +
               '<b>(b)</b> 走了，但你插错了层（比如只插了 AOSP 自带的 SPI 实现，而目标是自定义 Provider）。' +
               '分开这两个只需一个动作：<b>在最外层的门面类（<span class="mono">MessageDigest</span> / ' +
               '<span class="mono">Cipher</span> / <span class="mono">Mac</span> 的 getInstance / init / doFinal）' +
               '补一条日志</b>——门面类是 Provider 无关的，只要用 JCA 就绕不过去。<br>' +
               '门面类有日志 → 是 (b)，问题在 SPI/Provider 层，把探针挪到门面类即可解决；' +
               '门面类也没日志 → 才是 (a)，目标真的没用 JCA。<b>在没做这个二分之前，你对 0 命中的任何解释都只是猜测。</b><br><br>' +
               '<b>② 确认是自研之后，按成本从低到高排三条出路。</b><br>' +
               '<b>出路一（最便宜的先做）：静态看一眼它到底调不调库。</b>' +
               '看 so 的导入符号表、看有没有对 <span class="mono">EVP_*</span> 这类接口的引用、' +
               '看 MD5 的四个 IV 常量是以<b>立即数</b>形式出现在自研函数里，还是从外部库地址加载的。' +
               '这一步几乎零成本，却直接决定「下沉到库层」值不值得做——<b>如果目标是自研实现，下沉到 OpenSSL 层依然 0 命中。</b><br>' +
               '<b>出路二：下沉到 libc / 加密库层的汇聚点。</b>' +
               '通用加密库有自己的 <span class="mono">EVP_DigestUpdate</span> / <span class="mono">EVP_EncryptUpdate</span> 这类接口，' +
               '性质和 JCA 门面类一样（谁都绕不过去）。<b>但它只对「用这个库」的目标有效</b>，' +
               '而且具体函数名与是否被裁剪要按目标 so 的实际情况确认。<br>' +
               '<b>出路三：回到第 22/23 章的老路，或者做数据流观测。</b>' +
               '常量比对 + 动静态内存比对不依赖任何 API，对自研实现同样有效，代价是工作量大；' +
               '而在 <b>JNI 边界</b>记录「哪段字节进了 native、哪段字节出来」则完全不需要理解算法——' +
               '<b>它等价于一次不需要发起的黑盒调用</b>，在实战中往往是最划算的一条。<br><br>' +
               '<b>③ 为什么不该直接换工具。</b>因为 0 命中的原因如果是「观测层选错了」，' +
               '换成 Frida 只会让你在另一个层上再错一次（Frida hook 的也是同样的 Java API）。' +
               '更根本的是：<b>换工具不能修正一个归因错误。</b>' +
               '你需要的不是「更强的工具」，而是「知道我缺的是哪一类信息」。' +
               '回到这个样本，你已经确认了算法是标准 MD5（常量都在），<b>那你缺的从来不是「算法是什么」，而是「输入是什么」</b>——' +
               '而观测输入根本不需要改造沙箱。<br><br>' +
               '<b>④ 最后必须承认的边界：密钥在 native 里派生。</b>' +
               '这一条直接砍掉了本章最值钱的那个结论——<b>「拿到密钥就不必读汇编」在这里不成立</b>，' +
               '因为密钥从来没有以明文形式出现在 Java 层，你也拿不到它（可能只以句柄形式存在）。' +
               '这时候你只能退回到「黑盒调用出产能」，或者在 native 里把派生的那一段读出来。' +
               '<b>把这条边界明确写进结论，比含糊地说「沙箱能覆盖大部分场景」要诚实得多。</b>',
        after: '<p><b>知道自己在哪一层、缺哪一层，比多会几个工具重要。</b>这句话是本章全部内容的压缩。</p>'
      }
    ]
  }
};
