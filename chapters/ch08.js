/* 第 8 章 · 非标准算法还原（上）
   主线：常量特征比对（静态） + 动态 Trace 抓中间状态（动态）
   结论先行：所谓"非标准算法"绝大多数只是标准算法换了常量表，
             能直接调现成库替换常量，就不要逐行还原逻辑。 */

/* ---- 本章局部助手：给比对单元格上色（不改 style.css） ---- */
function _c8el(id) { return document.getElementById(id); }
function _c8paint(id, kind, txt) {
  var e = _c8el(id); if (!e) return;
  var map = {
    same: ['rgba(55,214,122,.28)', '#37d67a', '#eafff2'],
    diff: ['rgba(255,95,109,.30)', '#ff5f6d', '#fff'],
    cur:  ['rgba(77,163,255,.30)', '#4da3ff', '#fff'],
    none: ['', '', '']
  };
  var m = map[kind] || map.none;
  e.className = 'cell';
  e.style.background = m[0]; e.style.borderColor = m[1]; e.style.color = m[2];
  if (txt !== undefined && txt !== null) e.innerHTML = txt;
}
function _c8txt(id, html) { var e = _c8el(id); if (e) e.innerHTML = html; }
/* 生成"地址 + 4 字节"的一行格子；rows = [[标签,[b0,b1,b2,b3]], ...]；prefix 用于左右两个面板不撞 id */
function _c8g(prefix, rows) {
  var s = '<div class="memgrid">';
  for (var r = 0; r < rows.length; r++) {
    s += '<div class="memrow" style="grid-template-columns:74px repeat(4,1fr)">';
    s += '<span class="addr">' + rows[r][0] + '</span>';
    for (var b = 0; b < 4; b++) s += '<span class="cell" id="' + prefix + r + b + '">' + rows[r][1][b] + '</span>';
    s += '</div>';
  }
  return s + '</div>';
}
/* 给一组前缀的所有格子统一上色（lo..hi 为行下标区间） */
function _c8m(prefixes, lo, hi, kind) {
  for (var p = 0; p < prefixes.length; p++)
    for (var r = lo; r <= hi; r++)
      for (var b = 0; b < 4; b++) _c8paint(prefixes[p] + r + b, kind);
}
/* 生成 8×8 = 64 字符的编码表网格 */
function _c8g64(prefix, chars) {
  var s = '<div class="memgrid">';
  for (var r = 0; r < 8; r++) {
    s += '<div class="memrow" style="grid-template-columns:44px repeat(8,1fr)">';
    s += '<span class="addr">+' + (r * 8) + '</span>';
    for (var c = 0; c < 8; c++) s += '<span class="cell" id="' + prefix + (r * 8 + c) + '">' + chars[r * 8 + c] + '</span>';
    s += '</div>';
  }
  return s + '</div>';
}
function _c8m64(prefixes, lo, hi, kind) {
  for (var p = 0; p < prefixes.length; p++)
    for (var k = lo; k <= hi; k++) _c8paint(prefixes[p] + k, kind);
}
/* ---- RC4 舞台专用：S 盒前 16 格的标记 / 交换 ---- */
function _c8rc4mark(i) {
  for (var k = 0; k < 16; k++) _c8paint('c8s' + k, 'none');
  if (i >= 0) _c8paint('c8s' + i, 'cur');   /* 蓝色 = 当前 i 指针所在格 */
}
function _c8rc4hl(list) {
  for (var n = 0; n < list.length; n++) _c8paint('c8s' + list[n], 'wr');  /* 绿色 = 本次参与 swap 的两格 */
}
function _c8swaps(a, b) {
  var ea = _c8el('c8s' + a), eb = _c8el('c8s' + b);
  if (!ea || !eb) return;
  var t = ea.innerHTML; ea.innerHTML = eb.innerHTML; eb.innerHTML = t;
  _c8paint('c8s' + a, 'wr'); _c8paint('c8s' + b, 'wr');
}
/* 直接把整个 16 格 S 盒设成给定数组（用于"快进"到某个已算好的状态） */
function _c8rc4set(arr) {
  for (var k = 0; k < 16; k++) _c8paint('c8s' + k, 'none', arr[k]);
}
/* ---- AES 舞台：4×4 状态矩阵（列优先，state[r][c] = in[r + 4c]） ---- */
var _C8AES0 = [['00','04','08','0c'],['01','05','09','0d'],['02','06','0a','0e'],['03','07','0b','0f']];
var _C8AES1 = [['63','f2','30','fe'],['7c','6b','01','d7'],['77','6f','67','ab'],['7b','c5','2b','76']];
var _C8AES2 = [['63','f2','30','fe'],['6b','01','d7','7c'],['67','ab','77','6f'],['76','7b','c5','2b']];
var _C8AES3 = [['6a','2c','b0','27'],['6a','6d','d9','9c'],['5c','33','5d','21'],['45','51','61','5c']];
var _C8AES4 = [['ca','9c','70','f7'],['cb','dc','18','4d'],['fe','81','9f','f3'],['e6','e2','a2','8f']];
function _c8mx(p) {
  var s = '<div class="memgrid">';
  for (var r = 0; r < 4; r++) {
    s += '<div class="memrow" style="grid-template-columns:repeat(4,1fr)">';
    for (var c = 0; c < 4; c++) s += '<span class="cell" id="' + p + r + c + '">--</span>';
    s += '</div>';
  }
  return s + '</div>';
}
function _c8setm(p, m) {
  for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++) _c8paint(p + r + c, 'none', m[r][c]);
}

window.CHAPTER = {
  no: 8,
  title: '非标准算法还原（上）',
  lede: '上一章你把 so 跑起来了，这一章解决"跑起来之后怎么把算法扒出来"。所谓<strong>非标准算法</strong>，绝大多数只是把标准算法的常量表动了几笔——改了 IV、改了 S 盒、换了编码表、加了盐。<br>本章给你两条腿：<strong>常量特征比对</strong>负责锁定"它是哪个算法的变种"，<strong>动态 Trace 抓中间状态</strong>负责抓住"它到底改了哪一笔"。能直接调现成库换常量，就绝不逐行还原。',
  meta: [
    '核心问题：<b>怎么在几分钟内判断一段加密代码"是哪个算法的变种、改了什么"</b>，而不是从第一条指令开始逆汇编',
    '关键方法：<b>常量特征比对（静态 dump + 逐字节比对）</b> 配合 <b>动态 Trace 抓中间状态（观察寄存器/内存里的轮常量）</b>',
    '对手：<b>改 IV 的 MD5、换编码表的 Base64、改 S 盒的 RC4/AES、以及套了 OLLVM 混淆的 MD5/SHA1/Base64/RC4/AES</b>'
  ],

  sections: [
    /* ==================== 8.1 ==================== */
    {
      h: '8.1', title: '先认清敌人：什么叫"非标准算法"',
      intuition: {
        tag: '直觉模型 · 魔改算法 = 换了锁芯弹子的门',
        body: '<p>标准算法就像一扇国标防盗门：锁孔形状是公开的，任何人看一眼就能说出"这是 B 级锁芯"。厂商为了不让人一眼认出来，把锁芯里的<b>几颗弹子换了位置、换了高度</b>。门的结构没变、开门动作没变，只是<b>原配钥匙打不开了</b>。</p>' +
              '<p>你要做的不是"重新发明一把钥匙"，而是——<b>发现它只换了第 3 颗弹子</b>，然后照着原厂图纸配一把新的。这一章教的就是"怎么看弹子"。</p>'
      },
      html:
        '<p>做 App 逆向，绕不开一件事：<b>把请求里的签名算出来</b>。而签名背后一定是某个加解密算法。本章要解决的不是"怎么写加密代码"，而是——<b>看到一段加密代码，怎么快速判断它是什么、改了什么</b>。</p>' +
        '<p>先把常用算法的"认人特征"过一遍。这张表建议背下来，它是你后面所有判断的依据：</p>' +
        T.tbl(['算法', '类别', '最强常量特征（一眼认人的地方）', '标准输出'], [
          ['MD5', '摘要', 'IV <span class="mono">67452301 efcdab89 98badcfe 10325476</span>；K[64] 轮常量，首字 <span class="mono">d76aa478</span>', '16 字节'],
          ['SHA-1', '摘要', 'IV 前 4 个字与 MD5 相同，第 5 个字是 <span class="mono">C3D2E1F0</span>；4 组轮常量', '20 字节（大端输出）'],
          ['SHA-256', '摘要', '8 个 IV：<span class="mono">6a09e667 bb67ae85 3c6ef372 a54ff53a …</span>；K[64] 首字 <span class="mono">428a2f98</span>', '32 字节'],
          ['AES', '对称分组', 'S 盒 256 字节置换表，头 4 字节 <span class="mono">63 7c 77 7b</span>；逆 S 盒首字节 <span class="mono">52</span>', '16 字节分组'],
          ['RC4', '流密码', '256 字节 S 盒 + KSA 初始化 <span class="mono">S[i]=i</span> + PRGA 每字节两次 swap', '与明文等长'],
          ['Base64', '编码', '64 字符串 <span class="mono">ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/</span>，填充 <span class="mono">=</span>', '约 4/3 倍'],
          ['CRC32', '校验', '反射多项式 <span class="mono">0xEDB88320</span>（正常形式 <span class="mono">0x04C11DB7</span>）+ 256 项表 + 初值/末值均 <span class="mono">0xFFFFFFFF</span>', '4 字节'],
          ['HMAC', '摘要', '<span class="mono">0x36</span>/<span class="mono">0x5C</span> 填充到块大小（MD5/SHA1/SHA256 均为 64 字节）+ <b>两次哈希调用</b>', '同内层哈希']
        ]) +
        T.note('key', '🔑 本章主线（后面每一节都在证明这一句）', '<p>所谓"非标准算法"，99% 是<b>把某个标准算法的常量表动了几笔</b>——改了 IV、改了 S 盒、换了编码表、加了自定义前后缀。' +
          '而<b>改常量表恰恰是最容易还原的一种保护</b>：算法结构没变，你<b>不需要逐行还原逻辑</b>，直接调用现成库、把常量替换掉就行。</p>') +
        '<h4>为什么 App 要魔改？</h4>' +
        '<p>因为自动化识别工具——IDA 的 <span class="mono">findcrypt</span> 类插件、YARA 规则、各种"加密算法识别"脚本——<b>全都靠常量表做指纹</b>。' +
        '你把 IV 的第一个字从 <span class="mono">0x67452301</span> 改成 <span class="mono">0x12345678</span>，指纹库就全部失效，脚本会报告"未发现已知算法"。</p>' +
        '<p>但它只是<b>骗过了工具</b>，没骗过你。' +
        T.term('特征识别', '通过算法的固有常量（IV、S 盒、编码表、多项式、填充值）判断代码在用哪个标准算法，而不是逐行读逻辑。') +
        ' 的价值正在这里：<b>工具靠完整匹配，人靠部分匹配</b>。工具要 100% 命中才敢下结论，你只要看到"16 个字节里有 14 个对得上标准 MD5 的 IV"，就足够下结论了——剩下的 2 个字节就是作者改的东西。</p>' +
        T.note('', '🔍 一个反直觉的事实', '<p>魔改后的算法常常<b>比原版更好还原</b>。原版你还要怀疑"是不是变种"；魔改版留下了"标准常量 + 少量差异"这个极其清晰的指纹，' +
        '<b>差异所在的位置直接告诉你作者改了哪一步</b>。真正难的是整体换表 + OLLVM，那才需要动态 Trace。</p>'),
      quiz: {
        id: 'q8-1', chapter: 8, answer: 1,
        stem: '你从 so 里 dump 出一段 16 字节常量：<span class="mono">01 23 45 67 89 AB CD EF FE DC BA 98 76 54 32 10</span>。下一步最有价值的动作是什么？',
        options: [
          { t: '把这段字节丢进在线哈希识别网站', why: '在线网站做的是"输入→输出"黑盒比对，它看不到你 so 内部的常量，也帮不了你判断实现细节。' },
          { t: '按小端把它还原成 4 个 32 位字，与 MD5 的 IV 逐字比对', why: '正确。这 16 字节按小端读回来正是 0x67452301 / 0xefcdab89 / 0x98badcfe / 0x10325476，与 MD5 的 IV 完全一致——这一步就锁定了算法家族。' },
          { t: '去找 MD5 的 K[64] 轮常量表，找不到就说明不是 MD5', why: 'K 表经常被折叠进指令立即数、被魔改、或运行时才生成，找不到 K 表不能否定 MD5。IV 才是第一顺位的判据。' },
          { t: '从 JNI_OnLoad 开始逐行读汇编', why: '成本极高且没有必要。先花两分钟做常量比对，很可能直接省掉几小时的反汇编。' }
        ],
        explain: '<b>为什么先看 IV：</b>MD5 的 IV 写在算法规范里，绝大多数魔改版<b>最多改其中 1-2 个字</b>（改多了作者自己也记不住，还要在每个调用点同步）。' +
          '而 ARM 是小端，so 里存的字节序列看起来是"反的"——<span class="mono">0x67452301</span> 存成 <span class="mono">01 23 45 67</span>。' +
          '很多人第一次 dump 常量时就是因为忘了端序，看到 <span class="mono">01 23 45 67</span> 觉得"这不像 MD5 啊"而错过。' +
          '<b>牢记：dump 出来的字节，先按目标架构端序还原成字，再去比对。</b>'
      }
    },

    /* ==================== 8.2 ==================== */
    {
      h: '8.2', title: '方法论：常量比对 + 动态 Trace，两条腿走路',
      html:
        '<p>还原非标准算法只有两条路，而且必须<b>配合使用</b>：</p>' +
        '<div class="grid2">' +
          '<div class="card"><div class="card-title">① 常量特征比对（静态）</div>' +
          '<p>回答"<b>它是哪个算法的变种</b>"。成本极低，常常几分钟出结论，是永远的第一步。</p></div>' +
          '<div class="card"><div class="card-title">② 动态 Trace 抓中间状态（动态）</div>' +
          '<p>回答"<b>它到底改了哪一步</b>"。当常量被整体替换、或运行时才解密出来时，靠观察寄存器/内存反推。</p></div>' +
        '</div>' +
        T.note('ok', '✅ 常量特征比对：五步工作流', '<ol>' +
          '<li><b>dump 候选数据</b>：静态在 so 里按字节序列搜（搜 <span class="mono">01 23 45 67</span>、搜 <span class="mono">63 7C 77 7B</span>）；' +
          '或者动态 attach 后 dump 内存区间（常量可能运行时才解密出来）。</li>' +
          '<li><b>归一化端序</b>：ARM 小端，<span class="mono">0x67452301</span> 在内存里是 <span class="mono">01 23 45 67</span>。先把字节按架构还原成字或表。</li>' +
          '<li><b>逐字节比对</b>：与标准算法常量表对齐，逐一标出"<span class="hit">相同</span>"与"<span class="bad">不同</span>"。</li>' +
          '<li><b>读差异</b>：<b>相同的部分告诉你它是哪个家族，不同的部分告诉你作者改了什么</b>。这是整个方法论的核心。</li>' +
          '<li><b>定策略</b>：只改了 IV / 表 → 直接调现成库换常量；改了轮结构 / 加了盐 → 才需要逐行还原或长期 Hook。</li></ol>') +
        T.note('', '🔍 动态 Trace 抓中间状态：看"每一轮算出什么"', '<p>当静态常量搜不到时，改用 Frida 在轮循环里打印：</p>' +
          '<ul><li><b>寄存器</b>：在轮函数入口打印 <span class="mono">A/B/C/D</span>（MD5）或状态矩阵（AES）。</li>' +
          '<li><b>内存</b>：dump S 盒指针指向的 256 字节、dump 轮常量表指针指向的 256 字节。</li>' +
          '<li><b>对照</b>：把第 1 轮的输出与标准算法第 1 轮输出对比——<b>从第几轮开始不一致，问题就出在第几轮</b>。</li></ul>' +
          '<p>这个思路把"还原算法"变成了"<b>定位第一次分叉的位置</b>"，问题规模从几百行汇编瞬间缩到一个常量或一条指令。</p>') +
        T.note('bad', '⛔ 最常见的两种浪费', '<p>① 一上来就反编译整段，逐行抄成 C 代码——90% 的情况下，你以为的"自定义算法"其实只是改了 IV 的 MD5。' +
          '② 只做静态搜索，搜不到 <span class="mono">0x67452301</span> 就断定"不是 MD5"——很多 so 的常量表是<b>运行时解密</b>到栈/堆上的，静态当然搜不到。</p>') +
        '<p>还有一个必须建立的习惯：' +
        T.term('盐 salt', '在哈希输入里额外拼接的一段数据（固定串、设备号、时间戳）。加盐<b>不改变算法的常量表</b>，只改变输入——所以常量比对依然能认出算法本体。') +
        ' 和 ' +
        T.term('魔改常量', '直接修改算法内部的固有常量（IV、S 盒、K 表、编码表）。这与加盐是完全不同的两件事，识别手段也不同：加盐要抓输入，魔改要抓常量。') +
        ' 是两回事，别混。前者动的是<b>输入</b>，后者动的是<b>算法本体</b>。</p>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一',
            scenario: '<b>情境：</b>你负责一个电商 App 的签名还原。so 里静态搜索 <span class="mono">01 23 45 67</span>（MD5 IV 小端）、<span class="mono">63 7C 77 7B</span>（AES S 盒开头）、<span class="mono">ABCDEFGH</span>（Base64 表）<b>全部零命中</b>。但抓包发现 sign 是 32 位十六进制（16 字节），你判断它是某种摘要算法。接下来怎么走？',
            choices: [
              { t: '静态搜不到就说明是自研算法，开始逐行反编译 so', next: 'n1' },
              { t: 'attach 进程，用 Frida 在内存里扫这些字节序列，并 dump 疑似轮函数用到的表和输入输出', next: 'n2' },
              { t: '先上 OLLVM 反混淆工具把控制流平坦化还原了，再重新静态搜常量', next: 'n3' },
              { t: '搜不到常量说明签名里加了盐，先去把盐抓出来', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：把"搜不到"直接等价于"自研"',
            result: '<b>认知根源：把静态搜索的失败当成了算法性质的证据。</b>静态搜不到常量只有三种可能——① 常量被 OLLVM 拆散/折叠进指令立即数；' +
              '② 常量被加密存储，<b>运行时才解密到栈或堆上</b>；③ 常量确实改了。这三种里前两种都<b>不是自研算法</b>。' +
              '正确做法是先花几分钟做动态内存验证，再决定要不要逐行逆。逐行逆是最后手段，不是第一步。'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'good',
            verdictTitle: '正确：静态搜不到就转动态，在内存里找',
            result: '<b>这一步的价值在于把"看不见"变成"看得见"。</b>具体做法：attach 后用 Frida 的 <span class="mono">Process.enumerateRanges</span> 枚举可读内存，' +
              '再用 <span class="mono">Memory.scan</span> 搜 <span class="mono">01 23 45 67 89 AB CD EF</span> 这样的字节序列；很多加固方案会在 <span class="mono">JNI_OnLoad</span> 或首次调用时把常量表解密到堆上，' +
              '抓一次 dump 出来，静态比对就能照常进行。<b>更彻底的做法</b>是在疑似轮函数入口 Hook，dump 它读取的指针指向的内存——直接拿到真正在用的那张表。' +
              '记住这个顺序：<b>静态搜不到 → 动态 dump → 再比对</b>，而不是"搜不到 → 从头逆"。'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '顺序错了：反混淆的代价远大于先做一次动态 dump',
            result: '<b>认知根源：把"工具链的顺序"和"问题的难度"搞反了。</b>OLLVM 反混淆（去平坦化、去虚假控制流）是<b>成本最高的手段之一</b>，' +
              '而且它解决的是"控制流看不懂"，不是"常量看不到"。你现在的问题是常量不可见，<b>动态 dump 十分钟能解决的事，没必要先花两天反混淆</b>。' +
              '另外很多加固 so 的常量根本不参与控制流，反混淆对找回常量毫无帮助。'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '混淆了两个概念：加盐不会让常量消失',
            result: '<b>认知根源：把"加盐"和"改常量"当成了同一件事。</b>加盐改的是<b>哈希的输入</b>（多拼一段数据），' +
              '算法内部的 IV/K 表<b>原封不动</b>——所以加盐的 App，你静态依然能搜到 <span class="mono">01 23 45 67</span>。' +
              '反过来，搜不到常量说明的是<b>常量本身不可见或被改了</b>，跟盐没关系。先分清楚你面对的是"输入被改"还是"算法被改"，再决定去抓什么。'
          }
        }
      }
    },
    /* ==================== 8.3 ==================== */
    {
      h: '8.3', title: '摘要算法：MD5 / SHA-1 / SHA-256 的常量与魔改点',
      html:
        '<p>摘要算法是被魔改最多的一类，因为它常用于签名，而且<b>魔改成本极低</b>——改一个 IV 常量就够让所有自动化识别失效。</p>' +
        '<h4>三个算法的"身份证"</h4>' +
        T.tbl(['算法', 'IV / 初始常量（十六进制）', '轮常量', '输出'], [
          ['MD5', '<span class="mono">67452301 efcdab89 98badcfe 10325476</span>', 'K[64]：<span class="mono">K[i] = floor(abs(sin(i+1)) × 2^32)</span>，首字 <span class="mono">d76aa478</span>，次字 <span class="mono">e8c7b756</span>，末字 <span class="mono">eb86d391</span>', '16 字节，<b>小端</b>输出'],
          ['SHA-1', '<span class="mono">67452301 efcdab89 98badcfe 10325476 c3d2e1f0</span>', '4 组 × 20 轮：<span class="mono">5a827999 / 6ed9eba1 / 8f1bbcdc / ca62c1d6</span>', '20 字节，<b>大端</b>输出'],
          ['SHA-256', '<span class="mono">6a09e667 bb67ae85 3c6ef372 a54ff53a 510e527f 9b05688c 1f83d9ab 5be0cd19</span>', 'K[64]，首字 <span class="mono">428a2f98</span>，次字 <span class="mono">71374491</span>', '32 字节，<b>大端</b>输出']
        ]) +
        T.note('', '🔍 SHA-1 的一个"送分特征"', '<p>SHA-1 的 <span class="mono">h0~h3</span> 与 MD5 的 <span class="mono">A~D</span> <b>完全相同</b>，只有第 5 个字 <span class="mono">0xC3D2E1F0</span> 是它独有的。' +
          '所以 dump 到 <span class="mono">01 23 45 67 89 AB CD EF FE DC BA 98 76 54 32 10 F0 E1 D2 C3</span>（小端）这 20 字节，<b>一眼就是 SHA-1</b>；如果是 16 字节就到此为止，那是 MD5。' +
          '<b>输出长度（16 / 20 / 32 字节）是你最快的第二判据。</b></p>') +
        '<h4>MD5 的五个魔改点</h4>' +
        T.tbl(['魔改点', '作者怎么改', '你怎么发现'], [
          ['IV', '改其中 1~2 个 32 位字（最省事，最常见）', 'dump 出的 16 字节与标准 IV 有若干字节对不上'],
          ['K 表', '改部分轮常量，或整张表换成自定义值', '<span class="mono">K[0]</span> 不是 <span class="mono">d76aa478</span>'],
          ['移位表', '把某轮的 <span class="mono">7,12,17,22</span> 换成别的四元组', '静态里看到 4 组立即数；动态 Trace 每轮左移量对不上'],
          ['轮数', '64 轮改成 48 / 80 轮', '在轮函数入口计数——调用次数不等于 64'],
          ['填充', '把末尾 8 字节长度字段改成大端，或加一层自定义长度', '<b>输出长度不变但值全错</b>，最容易漏掉的一种']
        ]) +
        '<p>动手之前先建立一个概念：' +
        T.term('IV（初始向量）', '哈希算法压缩函数的 4 个（MD5/SHA-1）或 8 个（SHA-256）起始状态字。它是算法规范里写死的常量，也是魔改时作者最先动的地方。') +
        ' 只是一次性的起点，' +
        T.term('K 轮常量', '每一轮参与运算的固定加数。MD5 的 K 表由 sin 函数生成，SHA-256 的 K 表来自前 64 个质数的立方根小数部分——都带有"可重新推导"的数学来源，这正是它们容易被换掉又容易被识破的原因。') +
        ' 是每轮都要用的。改 IV 只是"起跑线不同"，改 K 表是"每一步都不同"——<b>后者的输出差异更彻底，但发现难度一样低</b>，因为表本身还在。</p>',
      stepper: {
        title: 'Frida 脚本抓 MD5 中间状态：从"搜不到常量"到"算出差异"',
        lines: [
          {
            code: '<span class="k">var</span> base = <span class="t">Module</span>.<span class="f">findBaseAddress</span>(<span class="s">\'libsign.so\'</span>);',
            note: '<b>先拿基址，后面所有偏移都相对它。</b>如果返回 <span class="mono">null</span>，说明 so 不是正常 dlopen 进来的（例如落地前先整体解密再 mmap），这时改用 <span class="mono">Process.enumerateModules()</span> 按名字找，或者直接 <span class="mono">Process.enumerateRanges</span> 全内存扫。',
            state: { 'base': '0x7a3c100000', '模块名': 'libsign.so' }
          },
          {
            code: '<span class="t">Memory</span>.<span class="f">scan</span>(base, <span class="t">ptr</span>(<span class="n">0x80000</span>), <span class="s">\'01 23 45 67 89 AB CD EF\'</span>, { onMatch: <span class="k">function</span> (a) { <span class="f">console</span>.log(<span class="s">\'HIT\'</span>, a); } });',
            note: '<b>这是"动态 dump 常量"的核心一行。</b>静态文件里搜不到，<b>不代表常量不存在</b>——很多 so 在 <span class="mono">JNI_OnLoad</span> 里把常量表解密到堆上，此刻内存里是明文的。在内存里搜字节序列，命中就直接读出来。',
            state: { '扫描范围': '0x80000 字节', '命中地址': '0x7a3c1e0a00', '命中次数': '1' }
          },
          {
            code: '<span class="f">console</span>.log(<span class="f">hexdump</span>(<span class="t">ptr</span>(<span class="s">\'0x7a3c1e0a00\'</span>), { length: <span class="n">16</span> }));',
            note: '<b>读出来就是常量比对的输入。</b>注意最后 4 个字节 <span class="mono">10 32 54 76</span>：按小端读回来是 <span class="mono">0x76543210</span>，而标准 MD5 的 D 是 <span class="mono">0x10325476</span>——<b>差异当场暴露</b>。',
            state: { 'A': '0x67452301 ✓', 'B': '0xefcdab89 ✓', 'C': '0x98badcfe ✓', 'D': '0x76543210 ✗' },
            mem: '7a3c1e0a00  01 23 45 67 89 ab cd ef\n7a3c1e0a08  fe dc ba 98 10 32 54 76'
          },
          {
            code: '<span class="c">// ② 从 IDA 里定位压缩函数入口，假设偏移是 0x4A18</span>',
            note: '<b>为什么要进轮函数：</b>IV 只回答"这是哪个算法"，要确认"改了哪一步"，必须看每一轮算出的中间值。压缩函数处理一个 64 字节分组，如果作者把轮循环展开了，你会看到一个被调用 <b>64 次</b>的内层函数——调用次数本身就是判据。',
            state: { '偏移': '0x4A18', '若展开则调用次数': '64', '约定参数': 'x0=state, x1=block' }
          },
          {
            code: '<span class="t">Interceptor</span>.<span class="f">attach</span>(base.<span class="f">add</span>(<span class="n">0x4A18</span>), { onEnter: <span class="k">function</span> (args) { <span class="k">this</span>.st = args[<span class="n">0</span>]; } });',
            note: '<b>进入时把状态指针存下来（this 在 onEnter/onLeave 之间共享）。</b>不要在这里做重活——轮函数会被调用几十次，打印太多会把目标进程拖死。<b>只在前 2~3 次打印</b>，用计数器卡住。',
            state: { 'this.st': '0x7a3c1e0a00（指向 4 个状态字）' }
          },
          {
            code: '<span class="f">console</span>.log(<span class="s">\'in \'</span>, <span class="k">this</span>.st.<span class="f">readU32</span>().<span class="f">toString</span>(<span class="n">16</span>), <span class="k">this</span>.st.<span class="f">add</span>(<span class="n">4</span>).<span class="f">readU32</span>().<span class="f">toString</span>(<span class="n">16</span>));',
            note: '<b>读的是"这一轮开始时的 A/B/C/D"。</b>ARM64 小端，<span class="mono">readU32()</span> 会按小端解释，所以读出来正好是逻辑上的字——<b>你不需要自己做端序转换</b>。',
            state: { '第1次调用 in': 'A=67452301 B=efcdab89', '与标准对照': '一致（说明 IV 的 A/B 没改）' }
          },
          {
            code: '<span class="k">this</span>.onLeave = <span class="k">function</span> (ret) { <span class="f">console</span>.log(<span class="s">\'out\'</span>, <span class="k">this</span>.st.<span class="f">readU32</span>().<span class="f">toString</span>(<span class="n">16</span>)); };',
            note: '<b>出口读的是"这一轮结束后的 A"。</b>把标准 MD5 用同一份输入跑一遍，两边同轮次的输出逐个对照：<b>从第几轮开始不一致，问题就出在第几轮</b>。这是把"还原算法"降维成"定位第一次分叉"的关键一步。',
            state: { '第1轮 out': 'A=7d1a2f60', '标准 第1轮': 'A=7d1a2f60 ✓', '第1轮一致': '→ IV 之后的运算逻辑没动' }
          },
          {
            code: '<span class="c">// ③ 用同一份输入跑标准 MD5，逐轮 diff</span>',
            note: '<b>结论怎么下：</b>第 1 轮就不一致 → 大概率 IV 被改（把 hook 到的入口状态直接替换成 dump 出的值再对）；中途才开始不一致 → 轮常量或移位表被改；<b>全程一致但最终输出不同</b> → 去看填充和长度字段。三种结论对应三种完全不同的处置方式，别混。',
            state: { '本轮任务': '定位第一次分叉', '处置': '只改 IV → 换库常量；改 K/移位 → 逐轮补丁' }
          }
        ]
      },
      after: T.note('ok', '✅ 这一节的实战结论', '<p>魔改 MD5 的还原成本，取决于<b>差异落在哪一层</b>：</p>' +
        '<ul><li><b>只改 IV</b>（最常见）：调用现成 MD5 库，把初始状态换成 dump 出的 4 个字，<b>零逻辑还原</b>。</li>' +
        '<li><b>改 K 表 / 移位表</b>：仍然调用现成库，但要能在库初始化时替换常量——Python 里可以自己按规范实现（MD5 只有 60 行），比改 so 便宜得多。</li>' +
        '<li><b>改轮数 / 填充</b>：必须自己按规范改写实现，但依然是"照标准结构改参数"，不是从汇编里抄逻辑。</li></ul>' +
        '<p><b>没有一种情况需要你从第一条汇编指令开始读。</b></p>')
    },

    /* ==================== 8.3L 动手实验 ==================== */
    {
      h: '8.3L', title: '动手实验：亲手识别一个魔改 MD5',
      html:
        '<p>前面都是看。这一节<b>你自己算</b>——我会给你一段从 so 里 dump 出的常量，你来判断它是什么算法、被改了什么。</p>' +
        T.note('key', '🔑 实验目标',
          '<p style="margin-bottom:0">不是"看懂"，而是<b>能拿起一段陌生字节，在几分钟内说出结论</b>。' +
          '这正是本章要建立的能力。下面三个实验都要你自己填、自己跑、自己判断。</p>'),
      lab: {
        title: '实验一：从一段 16 字节常量认出算法家族',
        goal: '目标：说出这是哪个算法 + 改了什么',
        intro:
          '<p>你从目标 so 的 <code>.rodata</code> 段里 dump 出下面这 16 个字节。' +
          '<b>任务：判断它是哪个摘要算法，以及是否被魔改。</b></p>' +
          '<pre style="margin:10px 0"><code>3e 8f 2b a1 89 ab cd ef fe dc ba 98 76 54 32 10</code></pre>' +
          '<p class="small muted">提示：ARM 是小端。先把这 16 字节按小端还原成 4 个 32 位字，再和标准算法的 IV 比对。</p>',
        inputs: [
          { key: 'hex', label: '① 把你还原出的 4 个 32 位字填在这里', hint: '格式：8 位十六进制，用空格或逗号分隔', ph: '例如 67452301 efcdab89 ...', type: 'hex' }
        ],
        runLabel: '🔍 与标准算法比对',
        run: (v) => {
          const C = window.CRYPTO, L = window.LABX;
          const raw = (v.hex || '').trim();
          if (!raw) return '<div class="lab-msg warn">先在输入框里填入你还原出的 4 个 32 位字。</div>';

          // 把输入按 32 位字解析
          let words = [];
          const hexes = raw.match(/(?:0x)?[0-9a-fA-F]{1,8}/g) || [];
          if (hexes.every(h => h.replace(/^0x/, '').length <= 2) && hexes.length === 16) {
            // 用户填的是字节序列，按小端组装
            for (let i = 0; i < 16; i += 4) {
              const b = hexes.slice(i, i + 4).map(x => parseInt(x, 16));
              words.push(((b[3] << 24) | (b[2] << 16) | (b[1] << 8) | b[0]) >>> 0);
            }
          } else {
            words = hexes.map(h => (parseInt(h, 16) >>> 0));
          }
          if (!words.length) return '<div class="lab-msg fail">没解析出有效的十六进制值。</div>';

          const STD = {
            'MD5 IV':   [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476],
            'SHA-1 IV': [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0],
            'SHA-256 IV': [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
          };

          let html = '<div class="lab-note">你填入的字（十六进制）：' +
            words.map(w => '<code>' + w.toString(16).padStart(8, '0') + '</code>').join(' ') + '</div>';

          let best = null;
          for (const [name, ref] of Object.entries(STD)) {
            const n = Math.min(words.length, ref.length);
            let same = 0;
            for (let i = 0; i < n; i++) if (words[i] === (ref[i] >>> 0)) same++;
            const pct = Math.round(same / ref.length * 100);
            if (!best || pct > best.pct) best = { name, pct, same, total: ref.length, ref };
          }

          html += '<table class="lab-tbl"><tr><th>候选算法</th><th>逐字比对</th><th>相同率</th><th>结论</th></tr>';
          for (const [name, ref] of Object.entries(STD)) {
            const n = Math.min(words.length, ref.length);
            let same = 0, cells = '';
            for (let i = 0; i < ref.length; i++) {
              const ok = i < words.length && words[i] === (ref[i] >>> 0);
              if (ok) same++;
              cells += '<span class="' + (ok ? 'lab-ok' : 'lab-no') + '">' +
                (i < words.length ? words[i].toString(16).padStart(8, '0') : '——') + '</span> ';
            }
            const pct = Math.round(same / ref.length * 100);
            html += '<tr class="' + (pct === 100 ? 'same' : pct >= 50 ? 'diff' : '') + '">' +
              '<td>' + name + '</td><td style="font-size:11.5px">' + cells + '</td>' +
              '<td>' + pct + '%</td>' +
              '<td>' + (pct === 100 ? '完全一致' : pct >= 50 ? '<b>家族匹配，有差异</b>' : '不像') + '</td></tr>';
          }
          html += '</table>';

          if (best.pct === 100) {
            html += '<div class="lab-msg pass"><b>✅ 完全匹配 ' + best.name + '</b>' +
              '<div class="lab-note">这就是标准 ' + best.name + '，没有被魔改。直接用现成库即可。</div></div>';
          } else if (best.pct >= 50) {
            const diffs = [];
            for (let i = 0; i < best.ref.length; i++) {
              if (i >= words.length || words[i] !== (best.ref[i] >>> 0)) {
                diffs.push('第 ' + (i + 1) + ' 个字：标准 <code>' + best.ref[i].toString(16).padStart(8, '0') +
                  '</code> → 实际 <code>' + (i < words.length ? words[i].toString(16).padStart(8, '0') : '缺失') + '</code>');
              }
            }
            html += '<div class="lab-msg pass"><b>✅ 判断正确：这是被魔改的 ' + best.name.replace(' IV', '') + '</b>' +
              '<div class="lab-note">' + best.pct + '% 的字与标准一致 —— <b>结构是 ' + best.name.replace(' IV', '') +
              '，但常量被动了</b>。具体差异：</div>' +
              '<ul style="margin:8px 0 0;font-size:13.5px">' + diffs.map(d => '<li>' + d + '</li>').join('') + '</ul>' +
              '<div class="lab-note"><b>还原策略：</b>调用现成 ' + best.name.replace(' IV', '') +
              ' 实现，把这 ' + diffs.length + ' 个初始状态字换成实际值即可 —— <b>零逻辑还原</b>。</div></div>';
          } else {
            html += '<div class="lab-msg fail"><b>❌ 与已知摘要算法都不像</b>' +
              '<div class="lab-note">要么端序还原错了（ARM 是小端，字节序列要反过来读），' +
              '要么这确实是自定义算法。先检查端序，再考虑下一步。</div></div>';
          }
          return html;
        },
        expected: (v) => {
          const raw = (v.hex || '').trim();
          const hexes = raw.match(/(?:0x)?[0-9a-fA-F]{1,8}/g) || [];
          let words = [];
          if (hexes.every(h => h.replace(/^0x/, '').length <= 2) && hexes.length === 16) {
            for (let i = 0; i < 16; i += 4) {
              const b = hexes.slice(i, i + 4).map(x => parseInt(x, 16));
              words.push(((b[3] << 24) | (b[2] << 16) | (b[1] << 8) | b[0]) >>> 0);
            }
          } else words = hexes.map(h => (parseInt(h, 16) >>> 0));
          // 正确还原：3e8f2ba1 89abcdef fedcba98 76543210
          const want = [0xa12b8f3e, 0xefcdab89, 0x98badcfe, 0x10325476];
          const ok = words.length === 4 && words.every((w, i) => w === want[i]);
          return {
            ok,
            detail: ok
              ? '完全正确。3 个字与 MD5 标准 IV 一致，第 1 个被改成了 <code>0xa12b8f3e</code>。'
              : '还不对。注意：<b>小端还原</b>要把每 4 个字节<b>反序</b>拼成 32 位字 —— ' +
                '<code>3e 8f 2b a1</code> → <code>0xa12b8f3e</code>（不是 <code>0x3e8f2ba1</code>）。'
          };
        },
        showAnswer:
          '小端还原后的 4 个字是：\n' +
          '  0xa12b8f3e  0xefcdab89  0x98badcfe  0x10325476\n\n' +
          '对比 MD5 标准 IV：\n' +
          '  0x67452301  0xefcdab89  0x98badcfe  0x10325476\n' +
          '  ^^^^^^^^^^  ←—— 只有第 1 个字被改了\n\n' +
          '结论：这是【改了 IV 的 MD5】。\n' +
          '还原方式：调现成 MD5 库，把初始状态第 1 个字设为 0xa12b8f3e，其余照标准。',
        hint:
          '<b>端序是关键。</b>ARM 是小端存储：<code>0x67452301</code> 在内存里写成 <code>01 23 45 67</code>。' +
          '所以你 dump 到的 <code>3e 8f 2b a1</code>，反过来读才是 <code>0xa12b8f3e</code>。<br>' +
          '先做这一步，再看 4 个字里哪几个和 MD5 的 IV（<code>67452301 efcdab89 98badcfe 10325476</code>）对得上。',
        after:
          T.note('ok', '✅ 实验一的收获',
            '<p style="margin-bottom:0">你刚才做的事情，就是<b>行业里真实的"算法识别"工作</b>：' +
            'dump 常量 → 归一化端序 → 逐字比对 → 读差异。<br>' +
            '整个过程的成本是<b>几分钟</b>，而没有这套方法的人会去逐行反汇编，花掉<b>几小时甚至几天</b>。' +
            '<span class="hit">这就是本章最大的价值：把"还原算法"从"读懂汇编"变成"比对常量"。</span></p>')
      }
    },

    /* ==================== 8.3L2 实验二 ==================== */
    {
      html: '',
      lab: {
        title: '实验二：亲手算出魔改 Base64 的编码结果',
        goal: '目标：验证换表后输出如何变化',
        intro:
          '<p>标准 Base64 表是 <code>ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/</code>。</p>' +
          '<p>现在作者把表<b>整体循环左移 13 位</b>（前 13 个字符挪到末尾）。' +
          '<b>任务：输入任意明文，观察两张表的输出差异，验证"换表 = 同一份数据、不同输出"这个结论。</b></p>' +
          '<p class="small muted">这个实验会让你看到：为什么用标准 Base64 解码换表数据会得到乱码——' +
          '因为索引到字符的映射整个错位了。</p>',
        inputs: [
          { key: 'text', label: '要编码的明文', hint: '随便输，试试不同长度', ph: 'hello world', value: 'hello' }
        ],
        runLabel: '⚙️ 用两张表分别编码',
        autorun: true,
        run: (v) => {
          const C = window.CRYPTO;
          const text = v.text || '';
          if (!text) return '<div class="lab-msg warn">先输入一段明文。</div>';
          const STD = C.B64_STD;
          const shifted = STD.slice(13) + STD.slice(0, 13);
          const bytes = C.toBytes(text);
          const a = C.base64Encode(bytes, STD);
          const b = C.base64Encode(bytes, shifted);

          let html = '<div class="lab-kv"><span>输入字节数 <b>' + bytes.length + '</b></span>' +
            '<span>输出长度 <b>' + a.length + '</b></span>' +
            '<span>填充 <b>' + (a.match(/=/g) || []).length + '</b></span></div>';

          html += '<table class="lab-tbl">' +
            '<tr><th>编码表</th><th>表内容（前 20 字符）</th><th>编码结果</th></tr>' +
            '<tr><td>标准表</td><td style="font-size:11px">' + STD.slice(0, 20) + '…</td>' +
            '<td><code>' + a + '</code></td></tr>' +
            '<tr class="diff"><td>魔改表（左移 13）</td><td style="font-size:11px">' + shifted.slice(0, 20) + '…</td>' +
            '<td><code>' + b + '</code></td></tr></table>';

          // 逐字符比对
          if (a.length === b.length) {
            let cells = '';
            for (let i = 0; i < a.length; i++) {
              cells += '<span class="' + (a[i] === b[i] ? 'lab-ok' : 'lab-no') + '">' + b[i] + '</span>';
            }
            const same = [...a].filter((c, i) => c === b[i]).length;
            html += '<div class="lab-note">魔改表输出（绿=与标准表相同，红=不同）：</div>' +
              '<div class="lab-answer" style="font-size:15px;letter-spacing:2px">' + cells + '</div>' +
              '<div class="lab-note">' + a.length + ' 个字符里有 <b>' + (a.length - same) + '</b> 个不同（' +
              Math.round((a.length - same) / a.length * 100) + '%）。</div>';
          }

          html += '<div class="lab-msg key"><b>🔑 关键观察</b>' +
            '<div class="lab-note">同一个输入，两张表产出<b>完全不同的字符串</b>，但<b>长度完全相同</b>、' +
            '用到的<b>字符集合也完全相同</b>。所以识别换表型 Base64 的正确姿势是：' +
            '<b>看字符集合（还是那 64 个符号）与输出长度（仍是 4/3 倍）</b>，而不是去匹配具体字符串。</div></div>';

          html += '<div class="lab-msg model"><b>💡 还原方法</b>' +
            '<div class="lab-note">不需要逆任何代码——只要拿到那张<b>实际的 64 字符表</b>' +
            '（静态 dump 或运行时读内存），替换掉标准表，用现成的 Base64 实现即可。<br>' +
            '<b>甚至更快：</b>如果你的目标是"解出服务端返回的数据"，把魔改表当成"自定义编码"，' +
            '用 <code>base64.b64decode(s.translate(str.maketrans(shifted, STD)))</code> 这类一行代码就能转回标准表再解。</div></div>';
          return html;
        },
        expected: (v) => {
          const C = window.CRYPTO;
          const text = v.text || '';
          if (!text) return { ok: false, detail: '先输入明文再检查。' };
          const STD = C.B64_STD;
          const shifted = STD.slice(13) + STD.slice(0, 13);
          const a = C.base64Encode(C.toBytes(text), STD);
          const b = C.base64Encode(C.toBytes(text), shifted);
          const same = [...a].filter((c, i) => c === b[i]).length;
          return {
            ok: true,
            detail: '<b>实验做完了，结论自己就得出来了：</b>「' + text + '」在两张表下分别是 ' +
              '<code>' + a + '</code> 与 <code>' + b + '</code>，' + a.length + ' 个字符里只有 ' + same +
              ' 个位置碰巧相同。<br><br><b>这说明换表型魔改的本质是"同一份数据、不同的符号映射"——' +
              '算法结构完全没变，所以拿到表就能还原，不需要读一行汇编。</b>'
          };
        },
        after:
          T.note('ok', '✅ 实验二的收获',
            '<p style="margin-bottom:0">你现在应该能回答一个关键问题：<b>"我看到一段像 Base64 但不是 Base64 的字符串，该怎么办？"</b><br>' +
            '答案：<b>去找那张 64 字符的表</b>（长度 64、值域是可见字符、被密集索引访问），' +
            '拿到之后一切迎刃而解。<span class="hit">这就是"常量比对"思维在编码算法上的应用。</span></p>')
      }
    },

    /* ==================== 8.4 ==================== */
    {
      h: '8.4', title: '编码与校验：Base64 换表、CRC32 换多项式',
      html:
        '<p>Base64 <b>不是加密</b>，是编码——它没有密钥，只有一张 64 字符的映射表。正因为如此，<b>换表是最廉价也最有效的"混淆"</b>：标准库解出来是乱码，新手第一反应是"这里有加密"，于是开始逆汇编。</p>' +
        '<div class="grid2">' +
          '<div class="card"><div class="card-title">标准 Base64</div>' +
          '<p><span class="mono">ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/</span></p>' +
          '<p class="small">填充符 <span class="mono">=</span>；每 3 字节输入 → 4 字符输出；位运算特征是取 6 位一组：<span class="mono">(b0 &gt;&gt; 2)</span>、<span class="mono">((b0 &amp; 0x03) &lt;&lt; 4) | (b1 &gt;&gt; 4)</span>……</p></div>' +
          '<div class="card"><div class="card-title">常见变体（都是同一类问题）</div>' +
          '<ul class="small"><li><b>换表顺序</b>：把大小写两段互换、把数字挪到前面（最常用）</li>' +
          '<li><b>换填充符</b>：<span class="mono">=</span> 换成 <span class="mono">.</span> 或 <span class="mono">*</span>，或干脆去掉</li>' +
          '<li><b>URL-safe</b>：<span class="mono">+</span> <span class="mono">/</span> 换成 <span class="mono">-</span> <span class="mono">_</span>（这个其实是 RFC 4648 标准变体，不必当魔改处理）</li>' +
          '<li><b>加自定义前后缀</b>：结果首尾拼一段固定串做混淆</li></ul></div>' +
        '</div>' +
        '<h4>CRC32：4 字节魔改的典型</h4>' +
        '<p>CRC32 的特征非常"硬"：反射多项式 <span class="mono">0xEDB88320</span>（正常形式 <span class="mono">0x04C11DB7</span>）、初始值 <span class="mono">0xFFFFFFFF</span>、结果异或 <span class="mono">0xFFFFFFFF</span>、一张 256 项的 <span class="mono">uint32</span> 表（或按位循环 8 次）。' +
        '实现特征也很明显：<b>右移 + 异或 + 查表</b>，且结果只有 4 字节。</p>' +
        T.tbl(['魔改点', '改法', '发现方式'], [
          ['多项式', '<span class="mono">0xEDB88320</span> → 任意 32 位值', 'CRC 表的第 1 项就是多项式本身；dump 表首 4 字节比对即可'],
          ['初始值', '<span class="mono">0xFFFFFFFF</span> → <span class="mono">0</span> 或自定义', '同一份输入算出的 crc 与标准值不同，但差异恒定'],
          ['反射', '输入反射 / 输出反射改成不反射', '表的生成方式变了，首项不再是多项式'],
          ['末异或', '结果不再异或 <span class="mono">0xFFFFFFFF</span>', '差值恒为 <span class="mono">0xFFFFFFFF</span> 的异或关系']
        ]) +
        '<p>CRC32 的魔改判断有一条捷径：' +
        T.term('多项式', 'CRC 算法里决定"用什么规则做除法"的那个常量。它同时决定了查表法的第一项，所以你 dump 出 CRC 表，<b>看第 0 项就能反推多项式</b>。') +
        ' 是 4 个魔改点里<b>唯一无法靠"输入输出对拍"反推</b>的——改初值和末异或，你还能用差值补偿；改多项式，整张表都变了，必须重新拿表。所以<b>见到 4 字节输出先 dump 表，不要先猜</b>。</p>',
      stage: {
        title: '常量特征比对器（一）：魔改 MD5 的 IV 比对',
        speed: 1500,
        render:
          '<div class="grid2">' +
            '<div><div class="small muted">① 目标 libsign.so · 内存中 dump 出的 16 字节</div>' +
              _c8g('ta', [['A +0x00', ['01', '23', '45', '67']], ['B +0x04', ['89', 'AB', 'CD', 'EF']], ['C +0x08', ['FE', 'DC', 'BA', '98']], ['D +0x0C', ['10', '32', '54', '76']]]) +
              '<div class="small mono" id="c8tgtw" style="margin-top:6px">小端解读：?</div></div>' +
            '<div><div class="small muted">② 标准 MD5 的 IV（RFC 1321 规范值）</div>' +
              _c8g('sa', [['A +0x00', ['01', '23', '45', '67']], ['B +0x04', ['89', 'AB', 'CD', 'EF']], ['C +0x08', ['FE', 'DC', 'BA', '98']], ['D +0x0C', ['76', '54', '32', '10']]]) +
              '<div class="small mono" style="margin-top:6px">小端解读：0x67452301 0xefcdab89 0x98badcfe 0x10325476</div></div>' +
          '</div>' +
          '<div id="c8v1" style="margin-top:12px"></div>',
        reset: function () {
          _c8m(['ta', 'sa'], 0, 3, 'none');
          _c8txt('c8tgtw', '小端解读：?');
          _c8txt('c8v1', '<span class="pill">等待比对</span>');
        },
        steps: [
          {
            run: function () { _c8txt('c8v1', '<span class="pill acc">第 1 步 · 摆好两份数据</span>'); },
            note: '<b>左：目标 so 里 dump 出来的常量。右：标准 MD5 的 IV。</b>此刻所有格子都是中立的——<b>先看，不下结论</b>。这一步养成的习惯，能避免 90% 的误判。'
          },
          {
            run: function () { _c8m(['ta', 'sa'], 0, 3, 'cur'); _c8txt('c8tgtw', '小端解读：0x67452301 …'); },
            note: '<b>端序归一化。</b>ARM 是小端，内存里的 <span class="mono">01 23 45 67</span> 读成一个 32 位字其实是 <span class="mono">0x67452301</span>。<b>不做这一步，你会觉得"这不像 MD5"而直接错过。</b>'
          },
          {
            run: function () { _c8m(['ta', 'sa'], 0, 3, 'same'); _c8txt('c8v1', '<span class="pill ok">A 字：4/4 字节相同</span>'); },
            note: '<b>第 1 个字全绿。</b><span class="mono">0x67452301</span> 与标准 MD5 完全一致。单看这一行还不能下结论——但接着看。'
          },
          {
            run: function () { _c8m(['ta', 'sa'], 4, 7, 'same'); _c8txt('c8v1', '<span class="pill ok">A ✓ B ✓ → 累计 8/8 字节相同</span>'); },
            note: '<b>第 2 个字也全绿。</b><span class="mono">0xefcdab89</span> 一致。<b>连续 8 个字节对上，随机巧合的概率已经可以忽略</b>——这基本锁定了算法家族。'
          },
          {
            run: function () { _c8m(['ta', 'sa'], 8, 11, 'same'); _c8txt('c8v1', '<span class="pill ok">A ✓ B ✓ C ✓ → 12/16 字节相同</span>'); },
            note: '<b>第 3 个字依然全绿。</b><span class="mono">0x98badcfe</span> 一致。到这里，"这是 MD5"已经是高置信结论了。'
          },
          {
            run: function () { _c8m(['ta', 'sa'], 12, 15, 'diff'); _c8txt('c8v1', '<span class="pill bad">D 字：4/4 字节不同 ✗</span>'); },
            note: '<b>差异出现了，而且高度集中。</b>左边是 <span class="mono">10 32 54 76</span>，右边是 <span class="mono">76 54 32 10</span>——<b>正好是字节逆序</b>。按小端读：<span class="mono">0x76543210</span> vs <span class="mono">0x10325476</span>。'
          },
          {
            run: function () { _c8txt('c8v1', '<b>结论：</b><span class="pill ok">16 字节中 12 字节相同</span> → 算法家族 = MD5；<span class="pill bad">第 4 个 IV 被改</span>（0x10325476 → 0x76543210，字节逆序）'); },
            note: '<b>这就是"一眼看出"的完整推理链：相同的部分定义算法，不同的部分定义改动。</b>注意差异的位置信息量极大——<b>只有 D 变了</b>，说明作者只动了第 4 个初始字，前面三个连动都没动。'
          },
          {
            run: function () { _c8txt('c8v1', '<span class="pill acc">处置：调用标准 MD5 库，把初始状态 D 换成 0x76543210</span> → 用已知明文验证输出'); },
            note: '<b>最关键的一步决策：不要逐行还原。</b>调用现成 MD5 实现，把 <span class="mono">D</span> 的初值改成 dump 出来的值，跑一遍标准测试向量；输出对上就收工。<b>整个还原过程不需要读一行汇编。</b>'
          }
        ]
      },
      after: T.note('warn', '⚠️ 一个必须养成的反直觉习惯', '<p>看到"标准库解出来是乱码"，<b>第一反应不应该是"有加密"，而应该是"我的解码表对不对"</b>。' +
        'Base64 换表导致的乱码和真加密导致的乱码，观感上完全一样，但前者<b>五分钟就能解掉</b>，后者可能要两天。<b>先证伪最便宜的可能。</b></p>'),
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境二',
            scenario: '<b>情境：</b>你抓到 App 的一个请求参数 <span class="mono">data</span>，长相是标准 Base64（有 <span class="mono">A-Za-z0-9+/</span>，结尾有 <span class="mono">=</span>），但用标准 Base64 库解出来全是乱码字节，不是可读文本。同一个请求里还有个 <span class="mono">sign</span> 是 8 位十六进制。你打算怎么推进？',
            choices: [
              { t: '乱码说明 data 是密文，先集中精力去 so 里找解密函数', next: 'n1' },
              { t: '先 dump 出 App 实际使用的编码表，与标准表逐字符比对；同时按 4 字节长度特征去核对 CRC32 表', next: 'n2' },
              { t: '换成 URL-safe 变体（把 +/ 换成 -_）再解一次', next: 'n3' },
              { t: '既然解不出来，直接 Hook 网络层拿解密后的明文结果', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'bad',
            verdictTitle: '跳过了最便宜的一步',
            result: '<b>认知根源：把"解不出来"直接归因于"有加密"，跳过了"是不是表不对"这个一分钟就能排除的可能。</b>' +
              '判断方法其实很简单：<b>换表产生的"乱码"有一个统计学特征——解出来的字节均匀分布在 0~255，且长度恰好是原文的 3/4 左右</b>；' +
              '而真加密（AES 等）解出来虽然也乱，但<b>长度是分组对齐的整数倍</b>，且往往还需要拿到密钥。先花一分钟做这个区分，再决定要不要去逆 so。'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'good',
            verdictTitle: '正确：先做常量比对，把问题定性',
            result: '<b>这一步同时覆盖了两个疑点，而且都不需要读汇编。</b>做法：① 在 so 里搜 <span class="mono">ABCDEFGH</span>，或者运行时 dump 疑似编码表的 64 字节，与标准表逐字符比对——' +
              '<b>如果 64 个字符只是换了顺序，那它还是 Base64，反查表就能解</b>；② 8 位 hex 强烈指向 CRC32，去 dump 疑似 CRC 表的第 0 项，看是不是 <span class="mono">0xEDB88320</span>（通常以小端存为 <span class="mono">20 83 B8 ED</span>）。' +
              '<b>这一节的中心思想：能用"表比对"定性的问题，永远不要用"逐行逆"去解。</b>'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '合理但不够：URL-safe 只是众多变体之一',
            result: '<b>这个选项不算离谱——它确实是 RFC 4648 里的标准变体，值得一试。</b>问题在于你只试了<b>一种猜测</b>，试完失败就没了下一步。' +
              '换表有 64! 种可能，你在盲猜。正确做法是<b>从目标里把表 dump 出来直接看</b>，一次定位全部差异——' +
              '推测只能在证据缺失时用，而这里证据唾手可得。<b>先取证，再推测。</b>'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '能拿到明文，但没解决"还原算法"这件事',
            result: '<b>认知根源：把"拿到这一次的结果"当成了目标。</b>Hook 网络层确实能看到明文，但你交付的是<b>能在本地复现签名的能力</b>，不是一次性的抓包结果。' +
              '客户端风控一升级、参数一变，你的 Hook 就得重来。<b>抓包给的是样本，算法给的是能力</b>——两者不冲突，但只有后者能沉淀下来。当然，Hook 拿到明文后<b>反推算法</b>是极好的辅助手段，别把它当成终点。'
          }
        }
      }
    },
    /* ==================== 8.5 ==================== */
    {
      h: '8.5', title: '换表型魔改实战：Base64 编码表比对',
      html:
        '<p>上一节的比对器用的是"4 个 32 位字"，手感还比较粗糙。Base64 换表则把问题推到极致：<b>64 个字符，每一个都可能被换掉</b>。但方法论一模一样——<b>摆数据、逐格比对、读差异</b>。</p>' +
        '<p>先在脑子里过一遍 Base64 的位运算结构，这是你后面判断"到底是换表还是换了算法"的依据：</p>' +
        T.code('<span class="c">// 标准 Base64：每 3 字节输入拆成 4 个 6-bit 索引</span>\n' +
          'i0 = (b0 &gt;&gt; 2) &amp; 0x3F;                          <span class="c">// 取 b0 高 6 位</span>\n' +
          'i1 = ((b0 &amp; 0x03) &lt;&lt; 4) | ((b1 &gt;&gt; 4) &amp; 0x0F);   <span class="c">// b0 低 2 位 + b1 高 4 位</span>\n' +
          'i2 = ((b1 &amp; 0x0F) &lt;&lt; 2) | ((b2 &gt;&gt; 6) &amp; 0x03);   <span class="c">// b1 低 4 位 + b2 高 2 位</span>\n' +
          'i3 = b2 &amp; 0x3F;                            <span class="c">// b2 低 6 位</span>\n' +
          'out = TABLE[i0] + TABLE[i1] + TABLE[i2] + TABLE[i3];') +
        '<p>注意最后一行：<b>索引的算法是死的，变的只有 TABLE</b>。这就是为什么换表如此廉价——它只改了一行查表，却让所有标准解码器失效。</p>' +
        '<p>再看两个相关的术语，它们经常和换表一起出现：' +
        T.term('编码表', 'Base64 里把 6 位索引（0~63）映射成可见字符的那张 64 字符表。标准表是 A-Z a-z 0-9 + /，换表就是把它整体重排或部分重排。') +
        ' 决定"索引 → 字符"；而 ' +
        T.term('URL-safe 变体', 'RFC 4648 定义的官方变体：把 + 和 / 换成 - 和 _，避免在 URL 中被转义。它属于标准变体而非魔改，识别时不要误报为"自定义算法"。') +
        ' 只动了两个字符。两者在比对器里都表现为"部分格子变红"，但处置方式不同。</p>' +
        T.note('', '🔍 换表的三种常见手法（和对应的比对结果长什么样）', '<ul>' +
          '<li><b>整体重排</b>：把 64 个字符按自定义顺序排列。比对结果<b>大面积红</b>，但字符集合完全一致——<b>看见"集合一样、顺序不同"就立刻下结论：这是换表 Base64</b>，不是新算法。</li>' +
          '<li><b>分段交换</b>：只把大写段和小写段对调，或把数字段挪到开头。比对结果<b>呈块状红</b>，块边界清晰。</li>' +
          '<li><b>部分替换</b>：只把 + 和 / 换成别的。比对结果<b>只有 2 个格子红</b>——这种情况下很多人根本发现不了，因为解出来的明文<b>大部分是对的</b>，只在特定输入下末尾几个字节出错。</li></ul>' +
          '<p><b>第三种最阴险</b>：如果原文恰好不含那些会产生 62/63 索引的字节组合，你甚至会用标准表解出完全正确的结果，然后把一个隐藏的 bug 带给上线。</p>') +
        '<p>下面是比对器。这次两条线索同时给出：<b>64 字符表的逐格比对</b>，加上 <b>同一段明文用两张表编码后的结果对比</b>。' +
        '后者更贴近实战——因为很多时候你先拿到的是密文，比对的是"我算出来的"和"它给我的"。</p>',
      stage: {
        title: '常量特征比对器（二）：魔改 Base64 编码表比对',
        speed: 1400,
        render:
          '<div class="small muted">① 目标 so 中 dump 出的 64 字节编码表</div>' +
          _c8g64('t', 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/'.split('')) +
          '<div class="small muted" style="margin-top:12px">② 标准 Base64 编码表（RFC 4648）</div>' +
          _c8g64('s', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('')) +
          '<div id="c8v2" style="margin-top:12px"></div>' +
          '<div class="small mono" id="c8b64" style="margin-top:10px">原文（明文）：<b>{"uid":1}</b> &nbsp; 长度 9 字节 → 编码后 12 字符</div>',
        reset: function () {
          _c8m64(['t', 's'], 0, 63, 'none');
          _c8txt('c8v2', '<span class="pill">等待比对</span>');
          _c8txt('c8b64', '原文（明文）：<b>{"uid":1}</b> &nbsp; 长度 9 字节 → 编码后 12 字符');
        },
        steps: [
          {
            run: function () { _c8txt('c8v2', '<span class="pill acc">第 1 步 · 数据结构先对上</span>'); },
            note: '<b>在比内容之前，先比"结构"。</b>两张表都是 <b>64 个格子、每个格子一个可见字符</b>。结构一致这件事本身就有信息量——它排除了"这是某种自定义编码"的可能。'
          },
          {
            run: function () { _c8m64(['t', 's'], 0, 25, 'cur'); _c8txt('c8v2', '<span class="pill acc">第 2 步 · 比对字符集合（不比对顺序）</span>'); },
            note: '<b>集合比对：把两张表里出现的字符各收进一个集合。</b>这一步故意忽略顺序——因为<b>"字符集合相同"是换表型 Base64 的决定性证据</b>。左表 0~25 是 <span class="mono">a</span>~<span class="mono">z</span>，右表 0~25 是 <span class="mono">A</span>~<span class="mono">Z</span>。'
          },
          {
            run: function () { _c8m64(['t', 's'], 26, 51, 'cur'); _c8txt('c8v2', '<span class="pill acc">集合各有 64 个字符：26 小写 + 26 大写 + 10 数字 + 2 符号</span>'); },
            note: '<b>集合完全一致。</b>左表 26~51 是 <span class="mono">A</span>~<span class="mono">Z</span>，右表是 <span class="mono">a</span>~<span class="mono">z</span>。两边的字符种类、数量都一模一样，<b>只是排布不同</b>。'
          },
          {
            run: function () { _c8m64(['t', 's'], 52, 63, 'cur'); _c8txt('c8v2', '<span class="pill acc">数字段与符号段也一致：0-9 与 + / 都在，位置相同</span>'); },
            note: '<b>52~61 是十个数字，62/63 是 <span class="mono">+</span> 和 <span class="mono">/</span>，两边位置一样。</b>这说明作者的改动<b>只涉及前 52 个字符</b>——这是一个可以立刻利用的信息：<b>索引 52~63 的解码结果，用标准表算就行</b>。'
          },
          {
            run: function () { _c8m64(['t'], 0, 25, 'diff'); _c8m64(['t'], 26, 51, 'diff'); _c8m64(['s'], 0, 51, 'same'); _c8txt('c8v2', '<span class="pill bad">前 52 个字符：全部错位 ✗</span>'); },
            note: '<b>逐格比对，大面积红。</b>左边 <span class="mono">abcdefghij…</span>，右边 <span class="mono">ABCDEFGHIJ…</span>。<b>但注意——这不是"乱改"，而是一个整齐的块交换</b>：0~25 段和 26~51 段整体对调。'
          },
          {
            run: function () { _c8txt('c8v2', '<b>结论：</b>字符集合 100% 一致 + 前 52 位呈两块整体对调 → <span class="pill ok">换表型 Base64</span>，<b>不是新算法</b>'); },
            note: '<b>这是本比对器要教给你的终极判断：</b>"集合相同、顺序不同" → 换表；"集合不同、长度不同" → 才可能是别的算法。<b>结论不是猜出来的，是比对出来的。</b>'
          },
          {
            run: function () { _c8txt('c8b64', '同一段明文 <b>{"uid":1}</b>：<br>标准表编码 → <span class="mono">eyJ1aWQiOjF9</span><br>目标表编码 → <span class="mono">EYj1IwqIoJf9</span>'); },
            note: '<b>用编解码结果交叉验证。</b>用标准表解目标的密文会得到乱码；把比对出的表填进标准 Base64 实现，就能解出明文。<b>更省事的做法：写一个"字符反查表"——遍历目标表，把每个字符映射回它标准表里的索引，然后拿这个映射直接喂给标准解码器。</b>等价于只改了一张表，算法一行没动。'
          }
        ]
      },
      after: T.note('ok', '✅ 换表 Base64 的通用处置（三行伪代码）', '<p><b>不要重写 Base64。</b>绝大多数语言的 Base64 实现都允许自定义字母表（Python 的 <span class="mono">base64.b64decode(s, altchars=…)</span> 只覆盖 <span class="mono">+/</span> 两个字符，更通用的是先做字符串替换再调标准解码）：</p>' +
        T.code('<span class="c"># 1) 把目标表的字符，替换成标准表同位置的字符</span>\n' +
          'trans = <span class="f">str.maketrans</span>(CUSTOM_TABLE, STANDARD_TABLE)\n' +
          'fixed = cipher.translate(trans)\n' +
          '<span class="c"># 2) 交给标准库</span>\n' +
          'plain = base64.<span class="f">b64decode</span>(fixed)\n' +
          '<span class="c"># 3) 若填充符也被改了，先补上 = 再解</span>') +
        '<p><b>核心思想：把"还原算法"降级成"替换常量"。</b>这就是本章反复强调的那件事——能换常量解决的，绝不重写逻辑。</p>'),
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境三',
            scenario: '<b>情境：</b>你用比对器确认了目标用的是"大小写两段对调"的 Base64 表，写脚本解码成功。但验证时发现<b>大部分样本都解对了，少数样本末尾会多出几个乱码字节</b>。你已经核对过表本身没错。下一步最该查什么？',
            choices: [
              { t: '表一定还有别的地方也改了，重新逐格核一遍 64 个字符', next: 'n1' },
              { t: '去核对填充符和末尾处理：填充是 = 还是别的、去填充是在解码前还是解码后、末尾比特是否被清零', next: 'n2' },
              { t: '说明这些样本本身就是二进制数据，不是文本，属正常现象', next: 'n3' },
              { t: '少数出错很正常，换个 Base64 库实现试试', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'bad',
            verdictTitle: '方向偏了：症状和原因不匹配',
            result: '<b>认知根源：把"不确定"直接转化为"重新做一遍已知有效的事"。</b>如果表还有错，出错应该是<b>大面积、随机分布</b>的，而不是"大部分对、少数末尾错"。' +
              '"只在末尾出错"这个症状强烈指向<b>长度与填充处理</b>，而不是字符映射。重新核表不是错，但它<b>没有对准症状</b>——先根据症状缩小范围，再决定查哪里。'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'good',
            verdictTitle: '正确：末尾出错的症状直接指向填充与边界处理',
            result: '<b>"只在末尾错"是填充问题的典型指纹。</b>Base64 的三类末尾问题：① <b>填充符被换掉</b>（<span class="mono">=</span> 换成 <span class="mono">.</span> 或直接省略），你那句"补上 <span class="mono">=</span>"的代码在省略填充时算错了长度；' +
              '② <b>去填充的时机错了</b>——先补再解和先解再删，结果在部分长度下不同；③ <b>末尾比特没清零</b>：当输入长度 mod 3 不为 0 时，最后一个字符里只有部分比特有效，标准编码器会把多余比特清零，' +
              '而自定义编码器可能不清零，<b>于是同一个明文编出两个不同的密文</b>，你的解码器按标准规则去填充就多出字节。' +
              '<b>通用经验：凡是"大部分对、少数错"，先怀疑边界条件（长度、填充、对齐），而不是核心逻辑。</b>'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '用一个无法验证的说法终止了排查',
            result: '<b>认知根源：把"解释得通"误当成"已经验证"。</b>"样本是二进制所以末尾乱码"这个说法<b>无法证伪</b>，因此它不能作为结论。' +
              '正确的验证方法是：<b>拿你的解码器把明文重新编码回去，看能不能得到原始密文</b>。能往返说明算法对了；不能往返，说明你的实现和目标有差异——这个差异<b>就是你要找的 bug 或魔改点</b>。' +
              '<b>不要用模糊解释掩盖可测量的不一致。</b>'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '把确定性问题当成了偶然性问题',
            result: '<b>认知根源：对"可复现"这件事不敏感。</b>如果你用同一份输入反复跑，错误每次都出现在<b>同一位置</b>，那它就是<b>确定性 bug</b>，换库不会消失——' +
              '换库只会换成另一个同样错的实现，甚至引入新错误。<b>"换个库试试"只在怀疑库自身实现有 bug 时成立</b>，而标准库的 Base64 是被全世界验证过的，' +
              '问题几乎一定在你的自定义映射层。<b>先证明差异是可复现的，再去找确定性原因。</b>'
          }
        }
      }
    },

    /* ==================== 8.6 ==================== */
    {
      h: '8.6', title: 'RC4：S 盒的初始化与密钥流生成动画',
      html:
        '<p>Base64 没有密钥，RC4 有。但 RC4 的特征<b>极其好认</b>：它是少数几个"用 256 字节状态表 + 两次交换"的算法，这个结构在汇编里非常醒目。</p>' +
        '<div class="grid2">' +
          '<div class="card"><div class="card-title">KSA（密钥调度）</div>' +
          '<p class="small mono">S[i] = i &nbsp;(i = 0..255)<br>j = 0<br>for i = 0..255:<br>&nbsp;&nbsp;j = (j + S[i] + key[i % keylen]) % 256<br>&nbsp;&nbsp;swap(S[i], S[j])</p></div>' +
          '<div class="card"><div class="card-title">PRGA（密钥流生成）</div>' +
          '<p class="small mono">i = j = 0<br>每次输出一字节：<br>&nbsp;&nbsp;i = (i + 1) % 256<br>&nbsp;&nbsp;j = (j + S[i]) % 256<br>&nbsp;&nbsp;swap(S[i], S[j])<br>&nbsp;&nbsp;K = S[(S[i] + S[j]) % 256]</p></div>' +
        '</div>' +
        T.note('', '🔍 在汇编里认 RC4 的三个特征', '<ul>' +
          '<li><b>256 字节的状态数组</b>，且初始化时是 <span class="mono">for (i=0;i&lt;256;i++) S[i]=i;</span> —— 你会看到一段把 0~255 顺序写入的循环，或者一段紧凑的初始化数据。</li>' +
          '<li><b>取模 256 的加法</b>：ARM 上表现为 <span class="mono">AND rX, rX, #0xFF</span>，而不是昂贵的除法/取模指令。</li>' +
          '<li><b>两次 swap</b>：KSA 里一次、PRGA 里一次，每次都伴随<b>三次内存读写</b>（读 S[i]、读 S[j]、写回两个位置）。<b>这个"读两次写两次"的模式是 RC4 最独特的指纹</b>。</li></ul>') +
        '<p>RC4 的魔改点也集中在这三个地方：' +
        T.term('S 盒', 'RC4 里那 256 字节的状态数组。它从恒等排列 <span class="mono">S[i]=i</span> 开始，被密钥"搅乱"成伪随机排列，之后每个字节的输出都依赖它当前的状态。<b>S 盒是 RC4 的全部状态</b>——你 dump 到某个时刻的 S 盒，就能算出之后所有的密钥流。') +
        ' 的初始值、密钥流的取法、以及 swap 的顺序。下面看动画。</p>' +
        '<p>为了看得清，动画只画 S 盒的<b>前 16 格</b>（真实 S 盒是 256 格，但 i / j 指针在 0~15 之间时行为完全一样）。注意两点：<b>① 交换是"原地"的，S 盒被永久改变；② PRGA 的每一次输出都依赖之前所有的交换。</b></p>',
      stage: {
        title: 'RC4 KSA → PRGA 逐步动画（S 盒前 16 格）',
        speed: 1500,
        render:
          '<div class="small muted">S 盒（只显示索引 0~15，真实为 0~255）</div>' +
          '<div class="memgrid" id="c8rc4s"></div>' +
          '<div class="regs" style="margin-top:10px">' +
            '<span class="reg" id="c8i"><b>i</b>=—</span>' +
            '<span class="reg" id="c8j"><b>j</b>=—</span>' +
            '<span class="reg" id="c8k"><b>K</b>=—</span>' +
          '</div>' +
          '<div class="small mono" id="c8rc4n" style="margin-top:10px">演示用 16 格迷你 RC4（结构与真实 RC4 同构，模数 16 代替 256）</div>' +
          '<div class="small mono" id="c8ks" style="margin-top:6px">密钥流：（尚未开始 PRGA）</div>',
        reset: function () {
          var h = '<div class="memrow" style="grid-template-columns:44px repeat(16,1fr)"><span class="addr">idx</span>';
          for (var c = 0; c < 16; c++) h += '<span class="cell" style="font-size:10px">' + c + '</span>';
          h += '</div><div class="memrow" style="grid-template-columns:44px repeat(16,1fr)"><span class="addr">S[]</span>';
          for (var v = 0; v < 16; v++) h += '<span class="cell" id="c8s' + v + '">' + v + '</span>';
          h += '</div>';
          _c8txt('c8rc4s', h);
          CLS('c8i', 'reg'); SET('c8i', '<b>i</b>=—');
          CLS('c8j', 'reg'); SET('c8j', '<b>j</b>=—');
          CLS('c8k', 'reg'); SET('c8k', '<b>K</b>=—');
          _c8txt('c8rc4n', '演示用 <b>16 格迷你 RC4</b>：结构与真实 RC4 完全同构，只把 <span class="mono">% 256</span> 换成 <span class="mono">% 16</span>，这样每一次 swap 都落在可见范围内。真实 RC4 只是把 16 换成 256，公式一字不差。');
          _c8txt('c8ks', '密钥流：（尚未开始 PRGA）');
        },
        steps: [
          {
            run: function () {
              _c8rc4mark(-1);
              SET('c8j', '<b>j</b>=0'); CLS('c8j', 'reg changed');
              _c8txt('c8rc4n', '<b>起点：S 盒是恒等排列。</b><span class="mono">S[0..15] = 0,1,2,…,15</span>，<span class="mono">j = 0</span>。真实 RC4 在这里是 <span class="mono">S[0..255] = 0,1,…,255</span>。');
            },
            note: '<b>KSA 的第一件事是把 S 盒初始化成 S[i] = i。</b>你在动画初始状态看到的这个恒等排列，<b>是 RC4 在内存里最容易被 dump 到的一刻</b>——' +
              '很多 Hook 点就选在初始化循环刚结束的位置。<b>认 RC4 的第一眼，就是认这段"0,1,2,3…"的顺序写入。</b>'
          },
          {
            run: function () {
              SET('c8i', '<b>i</b>=0'); CLS('c8i', 'reg changed');
              _c8rc4mark(0);
              _c8txt('c8rc4n', '<b>KSA i=0：</b>key[0]=\'K\'=75 → j = (0 + S[0] + 75) % 16 = <b>11</b><br>S = [11,1,2,…,15]（S[0] 与 S[11] 已交换）');
            },
            note: '<b>公式是 <span class="mono">j = (j + S[i] + key[i % keylen]) % 256</span>，三项缺一不可：</b><span class="mono">j</span> 保留上一步的状态，' +
              '<span class="mono">S[i]</span> 把当前 S 盒揉进去，<span class="mono">key[…]</span> 把密钥揉进去。<b>改任何一项都是 RC4 的魔改点——而三项里最好改、最难发现的就是 S[i] 的初值。</b>'
          },
          {
            run: function () { _c8swaps(0, 11); _c8rc4mark(0); },
            note: '<b>第一次 swap。</b>交换后 <span class="mono">S[0]=11、S[11]=0</span>。注意 S 盒被<b>永久改变</b>——这就是 RC4 与"直接用密钥异或"的本质区别：' +
              '<b>密钥不是直接参与运算，而是通过不断交换把 S 盒搅乱</b>。所以你 dump 到任意时刻的 S 盒，就能从那一刻起复现之后所有的密钥流，<b>不需要还原出密钥</b>。'
          },
          {
            run: function () {
              _c8rc4set([11, 1, 12, 3, 4, 5, 6, 7, 8, 9, 10, 0, 2, 13, 14, 15]);
              SET('c8i', '<b>i</b>=2'); CLS('c8i', 'reg changed');
              SET('c8j', '<b>j</b>=12'); CLS('c8j', 'reg changed');
              _c8rc4mark(-1); _c8rc4hl([2, 12]);
              _c8txt('c8rc4n', '<b>快进到 i=2：</b>j = (1 + S[2] + 121) % 16 = <b>12</b><br>swap(S[2], S[12]) → S = [11,1,<b>12</b>,3,…,0,<b>2</b>,13,14,15]<br><span class="muted">（i=1 时 j=1，是自己和自己交换，等于没换）</span>');
            },
            note: '<b>j 会跳来跳去，这是 KSA 的目的。</b>注意 i=1 那步 <span class="mono">j=1</span>，交换的是 S[1] 和自己——<b>这种"自交换"是正常现象，不是 bug</b>。' +
              '逆向时看到 swap 的两个下标相等，不要以为代码写错了。'
          },
          {
            run: function () {
              _c8rc4set([11, 5, 6, 9, 2, 1, 7, 3, 15, 8, 0, 14, 10, 12, 13, 4]);
              SET('c8i', '<b>i</b>=16（KSA 结束）'); CLS('c8i', 'reg changed');
              SET('c8j', '<b>j</b>=9'); CLS('c8j', 'reg changed');
              _c8rc4mark(-1);
              _c8rc4hl([11, 9]);
              _c8txt('c8rc4n', '<b>KSA 结束（i 走完 0~15）：</b>最后一个动作是 swap(S[15], S[9])<br>S = [11,5,6,9,2,1,7,3,15,8,0,14,10,12,13,4]<br>真实 RC4 这里走完 256 次，S 盒变成一个看似随机的排列。');
            },
            note: '<b>KSA 跑完后，S 盒已经看不出密钥的痕迹。</b>这是 RC4 的设计意图——<b>你无法从 S 盒反推出密钥</b>（除非用已知的 RC4 弱密钥攻击）。' +
              '但反过来说，<b>这对逆向是好消息：你根本不需要密钥，只需要 S 盒当前的状态。</b>这也是为什么"在 KSA 结束后 dump 一次 256 字节"是最有价值的 Hook 点。'
          },
          {
            run: function () {
              SET('c8i', '<b>i</b>=0 → 1'); CLS('c8i', 'reg changed');
              SET('c8j', '<b>j</b>=9 → 5'); CLS('c8j', 'reg changed');
              _c8rc4mark(1); _c8rc4hl([1, 5]);
              _c8txt('c8rc4n', '<b>进入 PRGA，取第 1 个密钥流字节：</b><br>i = (0+1) % 16 = <b>1</b>；j = (9 + S[1]=5) % 16 = <b>5</b><br>swap(S[1], S[5]) → S[1]=1, S[5]=5（本例恰好值相同）');
            },
            note: '<b>阶段切换：从"搅乱 S 盒"进入"取用 S 盒"。</b>PRGA 里 <b>i 和 j 都从 0 重新开始，而 S 盒不重置</b>——' +
              '这是新手实现时最容易写错的一行：把 S 盒也一起重置了，结果每次加密都用同一个密钥流。<b>逆向时如果发现每个数据包开头密文都一样，先查这里。</b>'
          },
          {
            run: function () {
              _c8rc4mark(1); _c8rc4hl([1, 5]);
              SET('c8k', '<b>K</b>=?'); CLS('c8k', 'reg changed');
              _c8txt('c8rc4n', '<b>取密钥流：</b>K = S[(S[i] + S[j]) % 16]<br>S[1]=1、S[5]=5 → 索引 = (1+5) % 16 = <b>6</b> → K = S[6] = <b>7</b>');
            },
            note: '<b>关键细节：K 既不是 S[i] 也不是 S[j]，而是 <span class="mono">S[(S[i] + S[j]) % 256]</span>。</b>' +
              '这个<b>二级索引</b>是 RC4 最独特的汇编指纹——你会看到"先把两个查表结果相加，再拿这个和去查第三次表"。<b>一次取流三次内存读，这个模式几乎不会出现在别的算法里。</b>'
          },
          {
            run: function () {
              _c8swaps(1, 5);
              SET('c8k', '<b>K</b>=0x07'); CLS('c8k', 'reg changed');
              _c8txt('c8ks', '密钥流：<b>07</b> …（明文逐字节 XOR K 得到密文）');
              _c8txt('c8rc4n', '<b>第 1 字节输出完成：</b>K = 0x07。<br>下一个字节：i = 2，j = (5 + S[2]) % 16，重复整个流程。<br>本例后续密钥流为 <b>02, 06, 05</b>。');
            },
            note: '<b>输出就是简单异或，没有任何轮函数。</b>RC4 的全部密码学强度都在 S 盒的搅乱过程里，不在输出环节。' +
              '所以对逆向来说：<b>拿到 S 盒 = 拿到一切</b>。这也解释了为什么魔改 RC4 最常见的做法是<b>改 S 盒的初始化</b>（改初值、改搅乱公式），而不是改输出——' +
              '因为输出环节太简单，改了反而更显眼。',
            state: { 'i': '1', 'j': '5', 'S[1] / S[5]': '1 / 5', '(S[i]+S[j]) % 16': '6', 'K = S[6]': '0x07' }
          }
        ]
      },
      quiz: {
        id: 'q8-4', chapter: 8, answer: 1,
        stem: '你在 so 里发现一段代码：一个 256 字节的数组被初始化为 <span class="mono">0,1,2,…,255</span>，随后是一个 256 次的循环，循环体里有<b>两次内存读</b>和<b>两次内存写</b>，并且索引计算用到了 <span class="mono">AND rX, rX, #0xFF</span>。这最可能是什么？',
        options: [
          { t: 'AES 的密钥扩展（Key Expansion）', why: '密钥扩展确实有 256 字节相关的操作，但它是按 4 字节字为单位、伴随 S 盒查表和 Rcon 异或，不会出现"初始化成 0..255 递增序列"这种动作。' },
          { t: 'RC4 的 KSA：初始化 S 盒并做 256 次带 swap 的搅乱', why: '正确。三个特征全部命中：S[i]=i 的恒等初始化、256 次循环、每次 swap 的"2 读 2 写"内存模式，加上 AND 0xFF 实现的模 256。' },
          { t: 'Base64 编码表的初始化', why: 'Base64 表是 64 个字符（64 字节），不是 256 字节，也没有 256 次循环和成对的内存读写。' },
          { t: 'MD5 的 K 表初始化', why: 'MD5 的 K 表是 64 个 32 位常量（共 256 字节，这点容易混淆），但它是静态常量或按 sin 公式生成的，不是 0~255 的递增序列，也没有 swap。' }
        ],
        explain: '<b>这道题的关键是"把三个特征叠加起来看"。</b>单个特征都可能误判——"256 字节"会让人想到 MD5 的 K 表（64×4=256 字节）、"循环 256 次"太常见——' +
          '但<b>"0..255 递增初始化" + "256 次循环" + "2 读 2 写的成对内存访问"三者同时出现，就只有 RC4 的 KSA</b>。' +
          '<br><b>为什么是"2 读 2 写"：</b>一次 swap 需要先把 <span class="mono">S[i]</span> 和 <span class="mono">S[j]</span> 都读出来（2 读），再分别写回对方的位置（2 写）。' +
          '这个模式在编译器优化后有时会变成 2 读 2 写加一个临时寄存器，但<b>读写总次数 4 次这个量级不会变</b>。<br>' +
          '<b>为什么用 AND 而不是取模：</b><span class="mono">% 256</span> 等价于 <span class="mono">&amp; 0xFF</span>，但除法/取模指令在 ARM 上要几十个周期，编译器（和手写汇编的作者）一定会用 AND。' +
          '<b>所以你在汇编里看不到"取模"指令，看到的是 AND 0xFF——不要因为"没看到 % 256"就否定 RC4。</b>'
      },
      after: T.note('warn', '⚠️ RC4 的三个魔改点与识别方法', '<ul>' +
        '<li><b>改 S 盒初始值</b>：不再是 <span class="mono">S[i]=i</span>，而是某个固定排列（或由密钥派生）。识别：Hook 初始化循环，dump 循环结束后的 256 字节，看是否等于恒等排列。</li>' +
        '<li><b>改密钥流取法</b>：不再是 <span class="mono">S[(S[i]+S[j])%256]</span>，比如改成 <span class="mono">S[(S[i]^S[j])%256]</span> 或 <span class="mono">(S[i]+S[j])&amp;0xFF</span> 后再做别的事。识别：Trace 那几个关键寄存器，看加法还是异或。</li>' +
        '<li><b>改 swap 顺序 / 只交换一半</b>：比如只把 S[i] 写成 S[j] 而不写回。识别：数内存写次数——<b>标准 RC4 每次 swap 是 2 读 2 写，写少了就是魔改</b>。</li></ul>' +
        '<p><b>共同点：三种魔改都不改变"256 字节状态数组"这个总体结构。</b>所以你的第一判据永远是"看到 256 字节的 S 盒初始化"，而不是"算出第一个密钥流字节对不对"。</p>')
    },
    /* ==================== 8.7 ==================== */
    {
      h: '8.7', title: 'AES：S 盒是最强特征，用 Stalker 穿透 OLLVM',
      html:
        '<p>AES 是本章所有算法里<b>特征最"重"</b>的一个。它的 S 盒是一张 256 字节的固定置换表，头 4 个字节是 <span class="mono">0x63 0x7C 0x77 0x7B</span>——<b>这四个字节几乎不可能偶然出现在别处</b>。' +
        '而且 AES 有三条互相独立的识别线索：</p>' +
        T.tbl(['线索', '内容', '识别难度'], [
          ['S 盒', '256 字节置换表，首字节 <span class="mono">0x63</span>、次 <span class="mono">0x7C</span>、三 <span class="mono">0x77</span>、四 <span class="mono">0x7B</span>；逆 S 盒首字节 <span class="mono">0x52</span>', '最低——直接搜字节序列'],
          ['轮常量 Rcon', '<span class="mono">01 02 04 08 10 20 40 80 1B 36</span>（GF(2^8) 上 x 的幂）', '低——10 字节的序列'],
          ['轮数', 'AES-128 → 10 轮；AES-192 → 12 轮；AES-256 → 14 轮', '中——需要数循环次数']
        ]) +
        T.note('key', '🔑 S 盒的结构比 S 盒的值更难改', '<p>作者可以换掉 S 盒的 256 个值，但<b>很难改变它的结构</b>：仍然必须是 <b>256 字节、值是 0~255 的一个完整置换、无重复、无缺失</b>。' +
          '因为 AES 的每一步都依赖"任意字节都能被唯一映射"这个性质，破坏了这个性质算法就跑不通。</p>' +
          '<p><b>所以即使 S 盒被整体换掉，你依然能识别出"这是一张（魔改的）AES S 盒"</b>——判据是统计性的：dump 出 256 字节，检查它的取值是否恰好覆盖 0~255 各一次。' +
          '<b>这就是"常量比对"从"逐字节匹配"升级到"结构匹配"的地方。</b>面对整体换表的对手，别再去找 <span class="mono">63 7C 77 7B</span>，去找"256 字节的完美置换"。</p>') +
        '<h4>轮函数的四步：数据结构比指令更重要</h4>' +
        '<p>AES 的状态是一个 <b>4×4 字节矩阵，按列优先排列</b>（16 字节密文的前 4 个字节是第一列）。轮函数四步：' +
        '<b>SubBytes</b>（查 S 盒）→ <b>ShiftRows</b>（行循环左移，第 0 行不移、第 1 行移 1、第 2 行移 2、第 3 行移 3）→ ' +
        '<b>MixColumns</b>（列混合，GF(2^8) 乘法）→ <b>AddRoundKey</b>（与轮密钥异或）。</p>' +
        '<p>看下面的动画时请特别留意：<b>四步里只有 SubBytes 和 AddRoundKey 是"逐字节独立"的</b>，ShiftRows 和 MixColumns 是<b>字节之间的搬运和混合</b>。' +
        '这个区别直接决定了你在汇编里怎么找它们——前者是查表和异或，后者是移位和乘法。</p>',
      stage: {
        title: 'AES 轮函数四步变换（状态矩阵逐字节演示）',
        speed: 1600,
        render:
          '<div class="grid2">' +
            '<div><div class="small muted">轮输入状态（4×4，列优先；第 0 列 = 前 4 字节）</div>' + _c8mx('in') + '</div>' +
            '<div><div class="small muted">当前状态</div>' + _c8mx('cur') + '</div>' +
          '</div>' +
          '<div class="small mono" id="c8aesn" style="margin-top:10px">按 ▶ 开始：SubBytes → ShiftRows → MixColumns → AddRoundKey</div>' +
          '<div class="small mono" id="c8aesr" style="margin-top:6px">轮密钥（示例，逐字节）：<span class="mono">a0 a1 a2 a3 | b0 b1 b2 b3 | c0 c1 c2 c3 | d0 d1 d2 d3</span></div>',
        reset: function () {
          _c8setm('in', _C8AES0);
          _c8setm('cur', _C8AES0);
          _c8txt('c8aesn', '按 ▶ 开始：SubBytes → ShiftRows → MixColumns → AddRoundKey');
          _c8txt('c8aesr', '轮密钥（示例，逐字节）：<span class="mono">a0 a1 a2 a3 | b0 b1 b2 b3 | c0 c1 c2 c3 | d0 d1 d2 d3</span>');
        },
        steps: [
          {
            run: function () { _c8txt('c8aesn', '<b>起点：</b>16 字节状态，列优先。第 0 列是前 4 个字节，第 3 列是最后 4 个字节。'); },
            note: '<b>先记住"列优先"这件事。</b>AES 规范里状态矩阵的填充顺序是<b>列优先</b>——<span class="mono">state[r][c] = in[r + 4c]</span>。' +
              '很多人在纸上手推 AES 时算不对，90% 是因为按行优先填了矩阵。<b>这个坑在写解密脚本时同样致命。</b>'
          },
          {
            run: function () { _c8setm('cur', _C8AES1); _c8txt('c8aesn', '<b>① SubBytes：</b>每个字节独立查 S 盒。<span class="mono">0x00→0x63</span>、<span class="mono">0x01→0x7C</span>、<span class="mono">0x02→0x77</span>、<span class="mono">0x03→0x7B</span>（正是 S 盒的头 4 个值）。'); },
            note: '<b>SubBytes 是 AES 里唯一的"非线性"步骤，也是整个算法的安全性来源。</b>它没有算术结构，就是一张 256 字节的表。' +
              '<b>在汇编里表现为查表（ARM 上是 <span class="mono">LDRB</span>），如果做了 T-table 优化则是 4 次 32 位查表（<span class="mono">LDR</span>）。</b>' +
              '<b>看到"连续的字节查表 + 表大小 256"就是 SubBytes。</b>'
          },
          {
            run: function () { _c8setm('cur', _C8AES2); _c8txt('c8aesn', '<b>② ShiftRows：</b>第 0 行不动，第 1 行左移 1，第 2 行左移 2，第 3 行左移 3。字节被"搬运"而不是"变换"。'); },
            note: '<b>ShiftRows 只搬字节，不改值。</b>注意移位方向是<b>循环左移</b>（解密时是右移）。<b>逆向时的坑：</b>如果 so 里用 T-table 实现，ShiftRows 会被<b>合并进查表的索引计算</b>里，' +
              '你在汇编中<b>找不到独立的移位指令</b>——不要因此认为"这不是 AES"。'
          },
          {
            run: function () { _c8setm('cur', _C8AES3); _c8txt('c8aesn', '<b>③ MixColumns：</b>每一列做 GF(2^8) 上的矩阵乘法，系数固定为 2、3、1、1。字节之间发生混合。'); },
            note: '<b>MixColumns 是唯一让"一列里的字节互相影响"的步骤。</b>在汇编里表现为 <b>GF(2^8) 乘法 + 异或</b>——典型的 <span class="mono">xtime</span> 实现是"左移一位，若溢出则异或 <span class="mono">0x1B</span>"。' +
              '<b>看到大量 <span class="mono">LSL</span> + 条件异或 <span class="mono">0x1B</span>，那基本就是 MixColumns。</b>'
          },
          {
            run: function () { _c8setm('cur', _C8AES4); _c8txt('c8aesn', '<b>④ AddRoundKey：</b>状态与轮密钥逐字节异或。<span class="mono">6a ^ a0 = ca</span>、<span class="mono">2c ^ b0 = 9c</span>、<span class="mono">b0 ^ c0 = 70</span>…'); },
            note: '<b>AddRoundKey 就是异或，代价极低，特征也最弱。</b>你很难靠"看到异或"来定位它——<b>所以定位 AES 的入口应该靠 S 盒和轮循环结构，而不是靠找异或指令。</b>'
          },
          {
            run: function () { _c8txt('c8aesn', '<b>一轮完成。</b>整个 AES-128 就是把"SubBytes→ShiftRows→MixColumns→AddRoundKey"重复 10 轮（第 10 轮去掉 MixColumns）。'); },
            note: '<b>轮数是最可靠的第三判据。</b>数循环次数得到 9 次完整轮 + 1 次末轮 = <b>AES-128</b>；11 + 1 = <b>AES-192</b>；13 + 1 = <b>AES-256</b>。' +
              '<b>注意末轮没有 MixColumns</b>——如果你看到循环里四步齐全、但循环外还有一次只有"SubBytes+ShiftRows+AddRoundKey"的收尾，那就是它。',
            state: { 'SubBytes': '查 S 盒（LDRB）', 'ShiftRows': '行循环左移', 'MixColumns': 'GF(2^8) 乘法 + 0x1B', 'AddRoundKey': 'EOR' }
          }
        ]
      },
      after:
        T.note('', '🔍 Frida Stalker：为什么它对 OLLVM 特别有效', '<p>OLLVM 的控制流平坦化把代码变成一个大 <span class="mono">while(1) + switch</span> 的分发器，<b>静态看是几百个互不相干的 case</b>。但 Stalker 是<b>动态指令级跟踪</b>，它不关心代码"看起来"怎么组织，只记录<b>实际执行了哪些指令</b>。' +
          '还原出来的 trace 是一串<b>线性执行序列</b>——平坦化在动态视角下自动消失了。</p>' +
          '<p><b>关键实用技巧：Stalker 的原始事件量极大，直接 <span class="mono">console.log</span> 会把进程拖死。</b>必须用 <span class="mono">transform</span> 回调在<b>目标进程内</b>做过滤（比如只保留 <span class="mono">LDRB</span> 指令），只把命中结果送回来。</p>') +
        T.code('<span class="c">// Stalker 跟踪：只记录"字节查表"这一件事，穿透 OLLVM 找 AES 的 S 盒</span>\n' +
          '<span class="t">Stalker</span>.<span class="f">follow</span>(<span class="t">Thread</span>.<span class="f">backtrace</span>()[<span class="n">0</span>].id, {\n' +
          '  <span class="f">transform</span>: <span class="k">function</span> (iterator) {\n' +
          '    <span class="k">var</span> insn = iterator.<span class="f">next</span>();\n' +
          '    <span class="c">// 只关心 LDRB（字节加载）——SubBytes 的 S 盒查表</span>\n' +
          '    <span class="k">if</span> (insn.mnemonic === <span class="s">\'ldrb\'</span>) {\n' +
          '      iterator.<span class="f">putCallout</span>(<span class="k">function</span> (ctx) {\n' +
          '        <span class="k">var</span> base = ctx.x1, idx = ctx.x0;   <span class="c">// 需按实际指令操作数调整</span>\n' +
          '        <span class="k">if</span> (base &amp;&amp; idx &lt; <span class="n">256</span>) {\n' +
          '          <span class="k">var</span> b = base.<span class="f">add</span>(idx).<span class="f">readU8</span>();\n' +
          '          <span class="k">if</span> (b === <span class="n">0x63</span>) <span class="f">console</span>.log(<span class="s">\'疑似 S 盒基址\'</span>, base);\n' +
          '        }\n' +
          '      });\n' +
          '    }\n' +
          '    iterator.<span class="f">keep</span>();\n' +
          '  }\n' +
          '});') +
        T.note('warn', '⚠️ 这段脚本的边界（别照抄就当能跑）', '<p><span class="pill warn">待核实</span> 上面 <span class="mono">ctx.x0 / ctx.x1</span> 的语义<b>取决于具体指令的编码</b>——' +
          '<span class="mono">LDRB Wt, [Xn, Wm]</span> 里基址和索引可能在不同寄存器，也可能是"基址+立即数偏移"的形式。' +
          '<b>实战里必须先 <span class="mono">console.log(instruction.toString())</span> 看清真实操作数，再写对应的取址逻辑。</b>' +
          '在任何教程里看到"复制即用"的 Stalker 脚本，都要先怀疑这一点。</p>' +
          '<p>更稳妥的定位思路：<b>先用 <span class="mono">Memory.scan</span> 在内存里搜 <span class="mono">63 7C 77 7B</span> 找到 S 盒地址，再在 Stalker 里只判断"访问的地址是否落在这个 256 字节区间内"</b>——这样就完全绕开了操作数解析的麻烦。</p>'),
      quiz: {
        id: 'q8-2', chapter: 8, answer: [0, 2],
        stem: '<b>多选。</b>你在 so 里搜 <span class="mono">63 7C 77 7B</span>（AES S 盒开头）零命中，但仍怀疑目标用了 AES。以下哪些做法是合理的？',
        options: [
          { t: '运行时用 Process.enumerateRanges + Memory.scan 在内存里搜这段序列', why: '正确。常量可能在 JNI_OnLoad 或首次调用时才解密到堆上，静态搜不到不代表不存在。' },
          { t: '搜 Rcon 序列 01 02 04 08 10 20 40 80 1B 36，用第二条线索交叉验证', why: '正确。轮常量是独立线索——S 盒被整体换了，Rcon 常常还在。多条线索交叉能显著提高结论置信度。' },
          { t: '搜 0x1B 这个立即数，看到就确认是 AES', why: '错误。0x1B 是 GF(2^8) 的不可约多项式，但它是个单字节立即数，误报率极高，单独不能作为证据。' },
          { t: '既然搜不到 S 盒，说明目标一定没用 AES，转去查别的算法', why: '错误。这是把"证据缺失"当成了"反证"。静态搜不到只说明常量不可见或被改了，必须先做动态验证再下结论。' }
        ],
        explain: '<b>核心是"多线索交叉"这个方法论。</b>单一特征（哪怕是 S 盒）搜不到时，不要立刻否定假设，而要：① 换搜索位置（静态 → 动态内存）；② 换线索（S 盒 → Rcon → 轮数 → 结构）。' +
          'AES 的三条线索里，<b>S 盒可以被整体换掉、Rcon 可以改、轮数可以改，但它们很难同时被彻底抹掉</b>——尤其是"10/12/14 轮的循环结构"和"256 字节完美置换表"这两个结构性特征。' +
          '<b>魔改能改变量，很难改结构。</b>这也正是下一节要讲的：当所有常量都变了，就靠结构认人。'
      }
    },

    /* ==================== 8.8C 实战案例 ==================== */
    {
      h: '8.8C', title: '实战案例：一句话驱动 AI 还原中某某动 App 的登录加密链',
      case: {
        source: 'kanxue',
        title: '中某某动APP算法AI分析-一句话全自动分析网络请求和加密算法',
        date: '2026-9-14',
        author: '太岁又沐风',
        target: '中国移动 App cn.10086.app（iOS 16.7.15 越狱 / rootless ElleKit）；三网一键登录 · UAM 组件',
        background:
          '<p>2026 年 9 月的一篇看雪帖。<b>这篇帖子的形态本身就是案例的一部分</b>：正文只有 4 个步骤标题和一句总结，' +
          '真正的技术内容全部压在 <b>7 张截图</b>里 —— 读者要自己读图才能拼出加密链。</p>' +
          '<p>目标是中国移动 iOS 客户端 <code>cn.10086.app</code>，跑在 <b>iOS 16.7.15 越狱环境（rootless ElleKit）</b>上，' +
          '分析对象是「三网一键登录 / UAM 组件」，SDK 的签名字段上带着 <code>Leadeon/SecurityOrganization</code> 标记。</p>' +
          '<p>作者的思路不是反汇编，而是<b>把越狱设备上的加解密观测能力通过 MCP 挂给 AI</b>，然后用一句话让 Codex 自己去跑完整个分析。</p>',
        points: [
          '装 <code>IOSDecryptHub 1.25.3</code>（<code>pip install ios-decrypt-hub</code>），用 <code>idh connect &lt;ip&gt;:8088</code> 连上越狱机，再配 MCP：<code>{"mcpServers":{"idh":{"command":"idh","args":["mcp"]}}}</code>。',
          '悬浮面板先给出全局账本：<b>总 2899 / 运行 787 / 加解密 0 / 对称 268 / RSA 0 / 序列 1482</b> —— 其中 <b>RSA 计数为 0</b>，这是后面"无非对称加密"结论的最早伏笔。',
          '加解密事件按算法名归类，整条链只有三种：<b>AES-128-CBC-PKCS7</b>、<b>AES-128-ECB-PKCS7</b>、<b>MD5</b>。',
          '单条事件可下钻到密钥与 IV：<code>#2688 AES-128-CBC-PKCS7 decrypt</code>，KEY(16B) = <code>5259563080435c31b6c563235d49564a</code>，IV(16B) = <code>566a465351315a74566b517852546c51</code>，<b>96B 密文 → 84B 明文</b>。',
          '目标请求是 <code>POST https://client.app.coc.10086.cn/biz-orange/LN/uamthreenetworklogin/login</code>，请求头带 <code>x-sign</code> / <code>x-token</code> / <code>xs</code> / <code>x-nonce</code> / <code>x-qen</code> 五个签名字段。',
          '<b>seq1977</b>：SIM 号 <code>13122225555</code>（11 字节）→ 16 字节，算法 <b>AES-128-ECB-PKCS7</b>。',
          '<b>seq1979</b>：CAID 配置 160 字节 → 144 字节。',
          '<b>seq1982</b>：<code>MD5(URL + Body 明文 + 签名字段 1146B)</code> → <code>xs = d29e548b6a76f099dd2f71eed0fca880</code>。',
          '<b>seq1983</b>：137 字节 → 144 字节 → <code>x-token</code>（Base64 后 192 字符）。',
          '<b>seq1984</b>：<code>MD5(x-token + ts + nonce + null 220B)</code> → <code>x-sign = 33e6a79a7288d70f93aaac83027cb37a</code>。',
          '<b>seq1985</b>：1044 字节 JSON → 1056 字节请求体（1408 字符）；<b>seq1986</b> 发出 POST；<b>seq1990</b> 把 96 字节响应解回 84 字节明文。',
          '收口结论：<b>asym event = 0，全程无 RSA / SM2</b>，结构是 <b>AES-128 双层（CBC + ECB）+ 双重 MD5 签名 + 硬编码外层密钥 + 动态会话密钥</b>。',
          '工具链由一句话驱动 Codex，<b>9 分 18 秒</b>产出完整分析报告。'
        ],
        method: [
          '装工具、连设备：<code>pip install ios-decrypt-hub</code> 装上 <code>IOSDecryptHub 1.25.3</code>，<code>idh connect &lt;ip&gt;:8088</code> 连上 iOS 16.7.15 越狱机（rootless ElleKit）。',
          '把设备能力挂给 AI：配置 MCP <code>{"mcpServers":{"idh":{"command":"idh","args":["mcp"]}}}</code>，让 Codex 能直接查这台设备的加解密事件。',
          '先看全局账本，不急着下钻：<b>总 2899 / 运行 787 / 加解密 0 / 对称 268 / RSA 0 / 序列 1482</b> —— <b>RSA 为 0</b> 已经预告了结论方向。',
          '按算法名归类：确认整条链只用到 <b>AES-128-CBC-PKCS7 / AES-128-ECB-PKCS7 / MD5</b> 三种，先把"用了哪几个算法"这件事定下来。',
          '对单条事件下钻拿密钥与 IV：<code>#2688 AES-128-CBC-PKCS7 decrypt</code> → KEY <code>5259563080435c31b6c563235d49564a</code>、IV <code>566a465351315a74566b517852546c51</code>、96B → 84B。',
          '锚定目标请求：<code>POST .../biz-orange/LN/uamthreenetworklogin/login</code>，认出 <code>x-sign / x-token / xs / x-nonce / x-qen</code> 这组签名头。',
          '按 seq 把事件串成时序：1977 SIM 号 → 1979 CAID → 1982 <code>xs</code> → 1983 <code>x-token</code> → 1984 <code>x-sign</code> → 1985 请求体 → 1986 POST → 1990 响应解密。',
          '交给 AI 收口：一句话驱动 Codex 输出完整加密链报告，<b>9 分 18 秒</b>。'
        ],
        result:
          '<p>一句话驱动 Codex，<b>9 分 18 秒</b>产出一份完整的加密链分析报告：从 SIM 号的 AES-128-ECB 加密，' +
          '到两次 MD5 分别生成 <code>xs</code> 与 <code>x-sign</code>，再到请求体的组装与响应的解密，整条时序被完整还原。</p>' +
          '<p>最关键的是一条<b>否定性结论</b>：<b>asym event = 0</b>，没有 RSA、没有 SM2。' +
          '也就是说这条链是 <b>AES-128 双层（CBC + ECB）+ 双重 MD5 签名 + 硬编码外层密钥 + 动态会话密钥</b> —— ' +
          '看起来吓人的五个签名头，底层只是两个标准算法在反复组合。</p>',
        terms: ['IOSDecryptHub', 'MCP', 'AES-128-CBC-PKCS7', 'AES-128-ECB-PKCS7', 'PKCS7', 'MD5', 'Base64', 'rootless ElleKit', 'UAM 三网一键登录'],
        limits:
          '<p>这个案例的局限<b>不在技术，而在信息形态</b>，必须如实标注：</p>' +
          '<p>① <b>帖子正文极简</b> —— 只有 4 个步骤标题加一句总结，<b>技术内容全部来自 7 张截图，靠读图提取</b>；' +
          '本节引用的编号（seq1977…seq1990）、密钥、IV、字段长度也都出自截图，<b>没有可执行脚本或可复现的命令行</b>。</p>' +
          '<p>② 作者<b>未提供任何失败尝试或限制说明</b> —— 整个过程看起来一次成功，但真实逆向里被工具卡住、被检测拦住的部分没有被记录下来。</p>' +
          '<p>③ <b>AI 的输出留了未闭合项</b>：密钥来源（keychain / init）、<code>xk</code> 的生成方式、SDK 归属这三项在截图里仍标注为"再确认"，最终答案没有展示。</p>' +
          '<p>④ 越狱源地址在原文里是<b>图片形式，文本不可读</b>，无法照抄。</p>',
        analysis:
          '<p><b>本课第 8 章的元原则是「两条腿走路」：常量特征比对 + 动态 Trace 抓中间状态。</b>' +
          '这个案例是这两条腿合起来的完整闭环演示 —— 而且演示的方式很极端：<b>作者一行汇编都没读，整条加密链就出来了。</b></p>' +
          '<p><b>第一，"两层 AES + 双重 MD5"这个组合本身就是一种指纹。</b>' +
          '你不需要逆每一行代码，只要看「哪几个算法被组合、按什么顺序调用」，就能把加密链画出来。' +
          'seq1977 用 ECB 打 SIM 号、seq1983 用 CBC 出 <code>x-token</code>、seq1982 和 seq1984 各做一次 MD5 —— ' +
          '<b>算法名 + 调用顺序 + 输入输出长度，这三样合起来就已经是一条可复现的链。</b>' +
          '这正是本章反复强调的顺序：<b>先确定"是什么算法"，再决定要不要读实现。</b>' +
          '而 8.2 讲过的成本排序在这里被推到了极致 —— 当工具已经把算法名直接标好时，"看算法名"比"比对常量"还要便宜。</p>' +
          '<p><b>第二，动态观测工具的价值在于「直接在加解密调用点抓明文」。</b>' +
          '传统路径是「识别算法 → 找密钥 → 自己实现一遍」，中间任何一步出错都会卡住。' +
          '而这个案例走的是另一条路：<code>#2688</code> 这条事件直接把 <b>KEY、IV、96B 密文和 84B 明文</b>一起摆在你面前，' +
          '<b>密钥不用推导、明文不用爆破，算法还原里最贵的两步被工具一次绕过。</b>' +
          '注意面板上那三个分类计数 —— 加解密 / 对称 / 非对称 —— 它们其实是本章"三条成本路径"的仪器化：' +
          '<b>当 RSA 计数是 0 的时候，"要不要去啃非对称算法"这个问题已经不需要问了。</b>' +
          '这也是本章对新手最有价值的一次纠偏：<b>遇到加密不要先想着自己实现，先问"能不能在调用点直接把明文捞出来"。</b></p>' +
          '<p><b>第三，AI 输出的边界必须看清。</b>报告给出了一条干净的链，但它留了 3 个未闭合项：' +
          '<b>密钥从哪来（keychain 还是 init）、<code>xk</code> 怎么生成、SDK 归属是谁</b>，' +
          '在截图里都还是"再确认"状态，最终答案没有展示。' +
          '前两项尤其致命 —— <b>"密钥来源"直接决定这条链能不能被复现</b>：' +
          '拿得到 KEY 却不知道它怎么产生，你就只能对这一台设备、这一个会话有效。' +
          '所以这个案例真正的姿势是：<b>让 AI 负责铺开假设和时序，让人负责回答"密钥从哪来"这类决定性问题。</b>' +
          '<span class="hit">自动化工具的输出仍需人工复核 —— 它把 90% 的读汇编时间省掉了，但剩下 10% 恰恰是决定成败的那部分。</span></p>',
        link: 'https://bbs.kanxue.com/thread-292939.htm',
        linkNote: '看雪论坛原创帖'
      }
    },

    /* ==================== 8.8 ==================== */
    {
      h: '8.8', title: '当常量被整体换掉：HMAC 的结构特征与决策模型',
      html:
        '<p>前面所有方法都有一个前提：<b>目标还保留了部分标准常量</b>。如果作者把 S 盒、IV、编码表全部换成自己生成的，常量比对就失效了——这时候要退回到<b>结构特征</b>。</p>' +
        '<h4>HMAC：一个纯靠结构认出来的算法</h4>' +
        '<p>HMAC 的公式是：</p>' +
        T.code('HMAC(K, m) = H( (K &oplus; opad) || H( (K &oplus; ipad) || m ) )\n\n' +
          '<span class="c">其中：ipad = 0x36 重复到块大小；opad = 0x5C 重复到块大小</span>\n' +
          '<span class="c">      MD5 / SHA-1 / SHA-256 的块大小都是 64 字节</span>') +
        '<p>HMAC 的识别<b>不依赖任何一张常量表</b>，它靠的是两个结构事实：</p>' +
        '<div class="grid2">' +
          '<div class="card"><div class="card-title">特征一：0x36 / 0x5C 的填充</div>' +
          '<p>你会看到一段<b>连续的 <span class="mono">0x36</span> 字节</b>（64 个），以及另一段<b>连续的 <span class="mono">0x5C</span> 字节</b>（64 个）。' +
          '这个"两个固定字节各重复一整块"的模式在正常业务代码里极其罕见。</p></div>' +
          '<div class="card"><div class="card-title">特征二：两次哈希调用</div>' +
          '<p>你会看到<b>同一个哈希函数被调用两次</b>，且第二次的输入里包含第一次的输出。' +
          '抓调用栈或数调用次数就能看出来——<b>这是 HMAC 的决定性结构</b>。</p></div>' +
        '</div>' +
        T.note('key', '🔑 为什么 HMAC 是"方法论"最好的收尾案例', '<p>因为 HMAC 把本章的两种手段都推到了边界：</p>' +
          '<ul><li><b>常量比对在这里失效</b>——HMAC 自己没有常量表（<span class="mono">0x36/0x5C</span> 严格说不是"表"，是两个填充字节）。</li>' +
          '<li><b>但它的内层哈希仍然可以比对</b>——HMAC-MD5 的内层就是 MD5，IV 和 K 表还在。所以你只需<b>先认出内层是 MD5，再认出外层套了 HMAC</b>，两个结论叠加即可。</li>' +
          '<li><b>剩下的靠结构</b>——"固定填充 + 两次调用"这个模式，任何语言的标准实现都一样。</li></ul>' +
          '<p><b>这就是完整的方法论：优先找常量（最便宜）、找不到找结构（次便宜）、都没有才逐行动态 Trace（最贵）。永远按成本从低到高试。</b></p>') +
        '<p>最后交代两个和 RC4 一起常被问到的术语，作为本章的收束：' +
        T.term('密钥流', '流密码（RC4 是典型）每次加密生成的一串与明文等长的伪随机字节，密文 = 明文 XOR 密钥流。逆向时<b>拿到密钥流就等于拿到明文</b>，所以 Hook 点常常选在密钥流生成函数的出口。') +
        ' 和 ' +
        T.term('OLLVM 混淆', '基于 LLVM 的代码混淆方案，控制流平坦化、虚假控制流、指令替换是它的三大手段。它对"常量特征识别"的影响其实很小——' +
        '<b>混淆改变的是控制流，不是数据</b>。所以本章的常量比对方法在 OLLVM 面前依然有效，失败时改查内存即可。') +
        '。</p>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境三（反直觉）',
            scenario: '<b>情境：</b>目标 so 被 OLLVM 严重混淆，IDA 里全是控制流平坦化的 <span class="mono">switch</span> 分发器。你已经确认它算的是 <b>HMAC-MD5</b>（看到了 <span class="mono">0x36/0x5C</span> 填充和两次 MD5 调用）。' +
              '<b>问题是：MD5 的 IV 搜索零命中</b>，静态也看不到 K 表。你的目标是拿到和 App 一致的签名。<br>最该做的是什么？',
            choices: [
              { t: '先把 OLLVM 平坦化还原，恢复出清晰的控制流，再去找 IV 和 K 表', next: 'n1' },
              { t: '接受"IV 可能就是标准值、只是被混淆藏起来了"这个假设：直接按标准 HMAC-MD5 算一遍签名，与抓包结果对比', next: 'n2' },
              { t: '在 MD5 压缩函数入口 Hook，dump 输入状态的前 4 个字，看是不是标准 IV', next: 'n3' },
              { t: '先假设 MD5 被魔改了，从零开始照规范自己实现一套带可调参数的 MD5', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'bad',
            verdictTitle: '又回到了最贵的那条路',
            result: '<b>认知根源：默认"看不懂 = 必须看懂"。</b>你的目标是<b>算出正确的签名</b>，不是"读懂这段代码"。' +
              '去平坦化本身可能花掉几天，而且它<b>完全没有回答"IV 到底是不是标准值"这个真正的未知量</b>。' +
              '<b>正确的成本排序是：先用实验排除假设（成本低），再决定要不要反混淆（成本高）。</b>而且严格说，这一题的正确答案比"排除假设"更省——见选 B。'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'good',
            verdictTitle: '正确（反直觉）：先用标准实现打一发，让结果告诉你答案',
            result: '<b>这是全章最反直觉、也最实战的一步：面对未知，先做最便宜的实验，而不是先做最彻底的还原。</b>' +
              '具体做法：把抓包得到的原始消息（URL 参数按同样的顺序拼好）和已知的密钥，<b>用标准 <span class="mono">hmac.new(key, msg, hashlib.md5)</span> 算一遍</b>，与抓包里的 sign 比对。<br>' +
              '<b>结果只有两种，两种都极大推进：</b>① <b>一致</b> → 作者根本没改 MD5，只是套了 OLLVM 混淆；<b>你当场收工</b>，零反汇编。' +
              '② <b>不一致</b> → 说明确实改了，此时你才需要按选 C 去 Hook 抓 IV。<b>一次五分钟的实验，就能把"要不要做重活"这个问题彻底解决。</b><br>' +
              '<b>为什么反直觉：</b>新手觉得"我还没搞清楚原理，怎么能直接算"；老手的直觉是"<b>能用一个实验问出答案的事，绝不用反汇编去猜</b>"。' +
              '注意：这个实验要求你先能正确还原<b>待签名的原始串</b>（参数的拼接顺序、编码、大小写），这一步本身往往比算法更难——所以如果算出来不一致，<b>先怀疑拼接方式，再怀疑算法</b>。'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'good',
            verdictTitle: '也正确，但顺序应该在选 B 之后',
            result: '<b>这个做法本身完全正确</b>：Hook 压缩函数入口，读状态指针指向的前 4 个字，与 <span class="mono">0x67452301</span> 等标准 IV 对比——' +
              '这是"动态 Trace 抓中间状态"的标准姿势，能给你<b>确定性的答案</b>。<br>' +
              '<b>唯一的改进是顺序：</b>选 B 的实验只要五分钟且不需要定位函数偏移（OLLVM 下定位压缩函数入口本身就要花时间），' +
              '所以应该<b>先用最便宜的实验排除掉 90% 的可能性，再用 Hook 去确认剩下的</b>。<br>' +
              '<b>OLLVM 下的额外提示：</b>平坦化会让函数边界和偏移变得难找，可以改用"扫内存找 S 盒/IV 的地址，再对访问该地址的指令下断点"这种<b>数据驱动</b>的思路定位函数，比顺着控制流找入口高效得多。'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '为一个未经验证的假设付出全部成本',
            result: '<b>认知根源：把"可能"当成了"确定"。</b>"MD5 被魔改"目前只是<b>一个可能性</b>——静态搜不到 IV 也可能纯粹是因为 OLLVM 把它变成了指令立即数，或者常量在内存里。' +
              '在假设没被验证之前就动手实现一套可调参数的 MD5，是<b>为一个可能不存在的需求写代码</b>。<br>' +
              '而且这个方向还有个隐患：自己实现的 MD5 一旦和目标的签名对不上，你<b>分不清是"参数猜错了"还是"自己实现写错了"</b>，排查难度翻倍。' +
              '<b>正确顺序永远是：先实验定性，再动手实现。</b>'
          }
        }
      },
      quiz: {
        id: 'q8-3', chapter: 8, answer: 2,
        stem: '你在一个 so 里 dump 出 256 字节数据，它<b>恰好是 0~255 的一个完整置换</b>（每个值出现且仅出现一次），但首字节不是 <span class="mono">0x63</span>。最合理的判断是？',
        options: [
          { t: '这是一张普通的随机查找表，与加密无关', why: '“恰好是 0~255 的完整置换”这个性质本身就是极强的信号——随机数据几乎不可能满足它。' },
          { t: '这是 AES 的逆 S 盒，因为它是置换表', why: '逆 S 盒确实是置换表，但它的首字节是 0x52；而且这个判断遗漏了更重要的推理路径。' },
          { t: '这极可能是一张被魔改过的 AES S 盒（结构保留、数值被换）', why: '正确。“256 字节 + 完整置换”是 AES S 盒的结构性特征，即使数值被整体换掉，结构也很难改。' },
          { t: '这是 S 盒，但因为首字节不对，所以它是 RC4 的 S 盒', why: 'RC4 的 S 盒确实是 0~255 的置换，但它只在 KSA 结束后才随机化，且 RC4 不会把它作为静态常量存在 so 里。' }
        ],
        explain: '<b>这道题考的是"从逐字节匹配升级到结构匹配"。</b>标准 S 盒首字节 <span class="mono">0x63</span>、逆 S 盒首字节 <span class="mono">0x52</span>——但这两个都是<b>可被替换的值</b>。' +
          '真正难以替换的是<b>结构</b>：<b>256 字节、取值覆盖 0~255 各一次</b>。原因很实在：AES 的 SubBytes 要求任意字节都有唯一映射，破坏了这个性质算法就跑不通，' +
          '所以作者只能"把表里的值重排"，不能"把表改成别的形状"。<br>' +
          '<b>识别方法：</b>dump 出 256 字节后写个三行脚本——建一个 256 长度的计数数组，遍历一遍，检查每个桶是否恰好为 1。是，就是 S 盒（或其逆）；不是，才考虑其他算法。' +
          '<br><b>RC4 的 S 盒为什么通常不是静态常量：</b>它是在 KSA 运行时被搅乱出来的，so 里存的往往是"初始化用的 0~255 序列"或干脆用循环生成。你静态搜到的 256 字节递增序列（<span class="mono">00 01 02 … FF</span>）反而更可能是 RC4 的 S 盒初始化，而不是 AES 的 S 盒。' +
          '<b>同一个"置换"结构，靠"它是静态常量还是运行时生成的"来区分 AES 和 RC4。</b>'
      }
    },
     ],
     glossary: [
       { t: '非标准算法', d: 'App 对通用加密算法的改动版本：改了 IV、S 盒、编码表、轮数或填充。绝大多数情况下算法结构不变，只是常量被替换，因此可以用标准实现换常量来还原。' },
       { t: '常量特征比对', d: '把目标 so 中 dump 出的常量数据与标准算法的常量表逐字节对齐、标出异同的方法。相同的部分确定算法家族，不同的部分确定魔改点。逆向算法的第一步，成本最低。' },
       { t: '特征识别', d: '通过算法的固有常量（IV、S 盒、编码表、多项式、填充值）判断代码在用哪个标准算法，而不是逐行读逻辑。自动化工具（findcrypt、YARA）靠它，人也靠它。' },
       { t: 'IV（初始向量）', d: '哈希算法压缩函数的起始状态字。MD5 与 SHA-1 各有 4 个（SHA-1 是 5 个），SHA-256 有 8 个。它是算法规范里写死的常量，也是魔改时最常被改的地方。' },
       { t: 'K 轮常量', d: '每一轮参与运算的固定加数。MD5 的 K 表由 floor(abs(sin(i+1))×2^32) 生成，SHA-256 的 K 表来自前 64 个质数立方根的小数部分。带有数学来源，便于重新推导和比对。' },
       { t: 'S 盒', d: '256 字节的固定置换表。AES 的 S 盒首字节 0x63、逆 S 盒首字节 0x52；RC4 的 S 盒则从 S[i]=i 开始，在 KSA 中被搅乱。魔改常整体换值，但“256 字节的完整置换”这个结构很难改。' },
       { t: '编码表', d: 'Base64 里把 6 位索引（0~63）映射成可见字符的那张 64 字符表。换表是 Base64 最常见的魔改手法，表现为“字符集合相同、顺序不同”。' },
       { t: '填充符', d: 'Base64 中用于补齐的字符，标准是 =。魔改时常被换成 . 或其他符号，或直接省略。只在输入长度不是 3 的倍数时出现，因此容易被忽略并导致“少数样本末尾出错”。' },
       { t: '多项式', d: 'CRC 算法里决定除法规则的常量。CRC32 的反射形式是 0xEDB88320（正常形式 0x04C11DB7）。查表法的第 0 项就是多项式本身，dump 表即可反推。' },
       { t: 'HMAC', d: '基于哈希的消息认证码，结构为 H((K⊕opad) || H((K⊕ipad) || m))，ipad=0x36、opad=0x5C 各填充到块大小（MD5/SHA1/SHA256 均为 64 字节）。识别靠“固定填充 + 两次哈希调用”的结构特征。' },
       { t: '密钥流', d: '流密码每次加密生成的与明文等长的伪随机字节序列，密文 = 明文 XOR 密钥流。RC4 的密钥流由 PRGA 逐个字节产生，拿到密钥流或某个时刻的 S 盒即可解出全部明文。' },
       { t: 'OLLVM 混淆', d: '基于 LLVM 的代码混淆方案，控制流平坦化、虚假控制流、指令替换是三大手段。它改变的是控制流而非数据，因此常量特征比对依然有效；失败时改用动态内存 dump 或 Stalker 跟踪。' }
     ],
     teacher: { id: 'ch8', chapter: 8, name: '追问老师 · 第 8 章', sub: '非标准算法到底是"新算法"还是"旧算法换常量"——你能说清判断依据吗？', intro: '<p style="margin:0">这一章我会盯着"<b>你凭什么这么判断</b>"来问。答"我看代码像 MD5"是过不了关的，我要听到<b>常量、字节、端序、轮次</b>。三次答不上来我会给完整答案，但那时候你已经浪费了一次练习机会。</p>', questions: [
        {
          id: 'c8q1', depth: 1, threshold: 0.7,
          q: '你从 so 里 dump 出一段常量，发现它和某个标准算法的常量表<b>大部分字节相同、少数字节不同</b>。请说出这个现象让你能得出<b>两个</b>结论，以及为什么这两个结论都成立。',
          concepts: [
            { label: '相同的部分锁定算法家族', hint: '大部分字节都对得上，这告诉你它是"哪一个"算法？', any: ['相同', '一致', '匹配', '家族', '是哪个算法', '哪个算法', '识别', '确认算法', 'same'] },
            { label: '不同的部分就是魔改点', hint: '那少数字节不一样，说明作者动了什么？', any: ['不同', '差异', '魔改', '改动', '修改', '改了什么', '变动', 'diff'] },
            { label: '魔改常量比自研算法常见得多', hint: '作者为什么不干脆自己写一个全新算法？', any: ['自研', '自己写', '新算法', '成本', '省事', '偷懒', '常见', '惯例', '改常量'] },
            { label: '因此可以直接调用现成库并替换常量', hint: '既然结构没变，你的还原方式可以有多省事？', any: ['现成库', '调用库', '标准库', '替换常量', '换常量', '不用还原', '不必逐行', '直接调'] }
          ],
          hints: ['先问自己：如果它是个全新的自研算法，为什么还留着这么多和标准算法一样的字节？', '再问：既然大部分字节一样，你还需要从汇编第一行开始抄逻辑吗？'],
          probes: ['如果差异是"整张表 256 个字节全不一样"，你上面第二个结论还成立吗？怎么办？', '假设差异只有 1 个字节，你有多大的把握说"这不是巧合"？为什么？'],
          model: '这个现象能同时给出两个结论。<b>第一个结论：它是哪个算法的变种。</b>加密算法的常量表（IV、S 盒、K 表、编码表）是算法规范里写死的。两个互不相关的算法碰巧共享十几个相同字节的概率极低，所以"大部分字节相同"就足以锁定算法家族——比如 16 个字节里有 12 个符合 MD5 的 IV，那它就是 MD5 系。<b>第二个结论：作者改了什么。</b>差异出现的位置信息量极大：差异集中在第 4 个 32 位字，说明只动了 IV 的 D；差异散布在整张 S 盒，说明换表了；差异出现在轮常量区，说明改了 K 表。<b>位置直接指向改动点</b>，这比"它被改过"这句话有用得多。<br>为什么这两个结论都成立？因为魔改的本质是<b>在保留算法结构的前提下替换常量</b>。作者改常量的动机是让自动化识别工具（findcrypt、YARA 规则）失效——这些工具靠完整匹配做指纹，改几个字节就能骗过它们。但作者<b>不会真的重写算法</b>：一来成本高，二来改变结构容易引入 bug，三来还要保证加解密自洽。所以"标准结构 + 少量自定义常量"成了事实上的行业惯例。这也直接导出<b>第三个推论</b>：既然结构没变，你根本不需要逐行还原逻辑，<b>直接调用现成的标准库、把常量换成 dump 出来的值就行</b>。整个还原工作可能只是几行代码。',
          after: '<p>补一句反向的边界：如果差异是"整张表 256 字节全不一样"，第一个结论（家族）依然可能成立——因为<b>结构没变</b>。这时你要从"逐字节匹配"升级到"结构匹配"：检查它是不是仍然满足 256 字节、取值覆盖 0~255 各一次。</p>'
        },
        {
          id: 'c8q2', depth: 1, threshold: 0.7,
          q: '你在 so 的静态数据里搜 MD5 的 IV 字节序列 <span class="mono">01 23 45 67</span>，零命中。为什么这<b>不能</b>得出"目标没用 MD5"的结论？请给出至少两种解释，并说明静态搜不到时你接下来怎么做。',
          concepts: [
            { label: '常量可能是运行时解密到内存的', hint: 'so 文件里没有，不代表进程内存里没有——作者可以在什么时候把表解出来？', any: ['运行时', '解密', '动态', '内存', '堆', '栈', 'JNI_OnLoad', 'init', '初始化', '加密存储', '加壳'] },
            { label: '常量可能被折叠进指令立即数', hint: 'IV 是 4 个 32 位字，它一定要以连续数据的形式存在吗？', any: ['立即数', '指令里', 'mov', '拆散', '分散', '内联', 'immediate', '常数', 'movz', 'movk'] },
            { label: '改用动态手段在内存里搜或 dump', hint: '静态看不到，那就换个时间点、换个地方看。具体用什么工具？', any: ['frida', 'Memory.scan', 'enumerateRanges', 'attach', 'hook', '动态', 'dump', '内存搜索', '内存扫描'] },
            { label: '端序问题：dump 出来的字节要先按小端还原成字', hint: 'ARM 是小端，0x67452301 在内存里长什么样？', any: ['端序', '小端', '大端', '字节序', 'endian', '逆序', '反过来', 'little endian'] }
          ],
          hints: ['so 文件是磁盘上的静态快照，而算法是在进程内存里跑的。这两者之间可能隔了什么？', 'Frida 里哪个 API 可以在内存区间里按字节序列搜索？'],
          probes: ['如果动态内存里也搜不到，你的下一步是什么？', '为什么很多加固方案选择在 JNI_OnLoad 里解密常量表，而不是在首次调用签名函数时？'],
          model: '静态搜不到至少有四种解释，没有一种能推出"没用 MD5"。<b>第一，常量是运行时解密到内存的。</b>加固方案普遍把常量表加密存在 so 的数据段里，在 <span class="mono">JNI_OnLoad</span> 或首次调用时解密到堆/栈上。磁盘上的 so 里当然搜不到，但进程内存里那一刻是明文。<b>第二，常量被折叠进了指令立即数。</b>IV 是 4 个 32 位字，编译器或作者完全可以不把它作为一个连续数据块存放，而是用 <span class="mono">MOVZ/MOVK</span> 之类的指令逐段拼出来，或拆成几个局部变量分别赋值。这时你在数据段里搜当然零命中，但常量的值依然存在于代码中。<b>第三，端序问题。</b>ARM 是小端，内存里的 <span class="mono">0x67452301</span> 字节序列是 <span class="mono">01 23 45 67</span>——但如果你按大端去搜 <span class="mono">67 45 23 01</span>，或者搜的字节串本身拼错了，也会零命中。很多人的"零命中"其实是自己搜错了。<b>第四，常量确实被改了。</b>这是唯一真正指向"魔改"的解释，但需要另外的证据支持。<br><b>正确做法：</b>静态搜不到就转动态——用 Frida attach 进程，<span class="mono">Process.enumerateRanges</span> 枚举可读内存，<span class="mono">Memory.scan</span> 搜同样的字节序列；更彻底的做法是在疑似压缩函数入口 Hook，dump 它读取的指针指向的内存，直接拿到<b>真正在用的那张表</b>。核心心法是：<b>"搜不到"只是证据缺失，不是反证</b>；先扩大搜索的时间和空间范围，再考虑否定假设。',
          after: '<p>再补一个判断技巧：如果动态内存里搜到了常量，但地址<b>不在任何已加载模块的范围内</b>（是堆地址），那基本可以确认"这个表是运行时解密/构造出来的"——这本身就是一条有价值的加固情报。</p>'
        },
        {
          id: 'c8q3', depth: 2, threshold: 0.7,
          q: '你用标准 Base64 库解一个参数，解出来是乱码。请说明你怎么<b>在几分钟内</b>判断这是"换表型 Base64"还是"真正的加密"，以及判断为换表后你的还原步骤。',
          concepts: [
            { label: '检查字符集合是否与标准表一致', hint: '如果只是换了顺序，那么 64 个字符的"集合"会怎样？', any: ['字符集合', '集合', '字符种类', '相同字符', '换顺序', '顺序', '重排', '表'] },
            { label: '看解码结果的长度与熵特征', hint: '换表解码出来的长度和原文是什么关系？真加密呢？', any: ['长度', '3/4', '四分之三', '等长', '分组', '16', '倍数', '熵', '随机'] },
            { label: '从目标里 dump 编码表逐字符比对', hint: '最可靠的办法是猜还是直接看？去哪里看？', any: ['dump', '搜', '内存', 'so', '比对', '取证', '0x', '找表', '字符串'] },
            { label: '用字符串替换/建反查表后交给标准库解码', hint: '还原时你要重写 Base64 吗？还是可以只做一层映射？', any: ['替换', 'maketrans', 'translate', '反查', '映射', '标准库', 'b64decode', '不用重写', '换表'] }
          ],
          hints: ['换表只改"索引到字符"的映射，不改"字节到索引"的位运算。所以解码结果的<b>长度</b>会呈现什么规律？', '你有没有办法直接看到 App 用的那张表，而不是靠猜？'],
          probes: ['如果是"只把 + 和 / 换掉"这种局部替换，你的长度判据还管用吗？该怎么补一条判据？', '填充符被改成别的字符（甚至省略）时，你的还原脚本会在哪一步出错？'],
          model: '先做"定性"，再做"定罪"。<b>定性靠两个便宜的特征。</b>第一，<b>长度关系</b>：Base64 是编码，输出长度约等于输入的 4/3，去掉填充后能精确算出原文长度；用标准表解码虽然得到乱码，但<b>长度关系依然成立</b>，而 AES 等分组加密的输出长度是 16 的整数倍。第二，<b>字符集合</b>：换表只改"6 位索引 → 字符"的映射，不改字符的种类和数量，所以密文的字符集合仍然恰好是那 64 个字符（可能加上填充符）；真加密的输出是随机字节，编码后字符分布没有这种约束。<b>更直接的证据是去把表 dump 出来</b>——在 so 里搜 <span class="mono">ABCDEFGH</span>，或者运行时扫内存找 64 字节的可疑表，与标准表逐字符比对。看到"64 个字符集合完全一致、只是顺序不同"，就是换表型 Base64 的决定性证据——因为<b>换表不增加信息量，只是重排</b>。<br><b>还原步骤（关键：不要重写 Base64）：</b>① 拿到目标表后，建一个翻译映射 <span class="mono">trans = str.maketrans(CUSTOM, STANDARD)</span>，把密文里每个字符替换成标准表同位置的字符；② 把替换后的字符串交给标准库 <span class="mono">base64.b64decode</span>；③ 处理填充符——如果目标用的不是 <span class="mono">=</span>（或省略了填充），先补齐成正确的 <span class="mono">=</span> 再解码。<b>整个过程等价于"只改了一张表"，算法一行没动。</b>这就是本章的核心思想：把"还原算法"降级成"替换常量"。',
          after: '<p>补一条排错经验：如果解出来"大部分对、少数样本末尾多几个乱码字节"，几乎一定是<b>填充或末尾比特没清零</b>的问题，而不是表又错了。症状和原因要对得上。</p>'
        },
        {
          id: 'c8q4', depth: 2, threshold: 0.7,
          q: '你用 Frida 在一个疑似 MD5 的压缩函数入口和出口打日志，想还原魔改点。请说明你会打印<b>什么</b>、怎么用这些数据<b>定位</b>魔改点，以及这种方法为什么比逐行读汇编高效。',
          concepts: [
            { label: '用 this 在 onEnter 和 onLeave 之间保存状态指针', hint: '轮函数会被调用很多次，你怎么在出口拿到入口的那个指针？', any: ['this', 'onenter', 'onleave', '保存', '存下来', 'args[0]', '参数', '指针'] },
            { label: '只打印前几次调用，避免拖慢目标进程', hint: '压缩函数要被调用几十次，全打印会怎样？', any: ['前几次', '限流', '计数', '不要全打', '性能', '拖慢', '卡死', '采样', 'counter'] },
            { label: '与标准算法同轮次输出对照，定位第一次分叉', hint: '拿到两边每一轮的中间值之后，你要找的是什么？', any: ['对照', '对比', '比较', '标准', 'diff', '第一次不一致', '分叉', '哪一轮', '定位'] },
            { label: '按分叉位置推断改动类型（IV/K表/移位/轮数/填充）', hint: '第 1 轮就不一致，和中途才不一致，分别说明改了什么？', any: ['iv', '初始', 'k 表', '轮常量', '移位', '轮数', '填充', '推断', '判断改动', '哪一种'] }
          ],
          hints: ['入口处读到的 A/B/C/D 是什么？出口处读到的又是什么？这两个值各能回答什么问题？', '如果第 1 轮就对不上，你会怀疑 IV；如果第 1 轮对得上、第 5 轮开始错，你会怀疑什么？'],
          probes: ['如果作者把 64 轮完全展开了（没有内层函数），你这个 Hook 点还成立吗？该改怎么打断点？', '如果两侧数据都对得上，但最终输出不同，问题最可能出在哪里？'],
          model: '<b>打印什么：</b>在压缩函数入口用 <span class="mono">Interceptor.attach</span> 的 <span class="mono">onEnter</span> 拿到状态指针（通常是 <span class="mono">args[0]</span>），把它存到 <span class="mono">this</span> 上——<b><span class="mono">this</span> 在 <span class="mono">onEnter</span> 和 <span class="mono">onLeave</span> 之间是共享的</b>，这是 Frida 里跨回调传值的标准做法。然后在出口读回这块内存，就得到了"这一轮开始时的状态"和"这一轮结束后的状态"。<br><b>两个必须遵守的工程约束：</b>① <b>一定要限流</b>——压缩函数会被调用几十次，每次打印还会触发字符串转换，全量打印会把目标进程拖到卡死。用计数器只打前 2~3 次。② <b>打印要精简</b>，只打关键字段（A/B/C/D 或状态矩阵），不要 <span class="mono">hexdump</span> 整块内存。<br><b>怎么定位魔改点：</b>用同一份输入跑一遍标准算法，采集同样的逐轮中间值，然后<b>对齐轮次逐个对照</b>。你要找的不是"哪里不一样"，而是<b>"第一次开始不一样"的位置</b>。据此推断：<b>第 1 轮入口状态就和标准 IV 不同</b> → IV 被改了；<b>入口正常、第 1 轮输出就错</b> → 轮常量或移位表被改；<b>前几轮对得上、中途开始错</b> → 大概率是某几轮的常量被改；<b>全程中间值都对得上、只有最终输出不同</b> → 去看填充规则和长度字段。<br><b>为什么比读汇编高效：</b>这个思路把"还原一个有几十轮、几百条指令的算法"降维成了<b>"定位第一次分叉"</b>——问题规模从一个函数缩到一个常量或一条指令。而且 OLLVM 的平坦化会让静态阅读极其痛苦，但<b>动态执行序列是线性的，混淆在运行时自动消失</b>。',
          after: '<p>如果 64 轮被完全展开（没有内层函数），就把 Hook 点下在<b>第一条轮运算指令</b>上，或者在轮循环的回边（back edge）处计数。另一个更省事的办法是直接 Hook 状态结构的内存写入，观察它被更新了多少次——<b>次数就是轮数</b>，这同时也是判断 AES-128/192/256 的手段。</p>'
        },
        {
          id: 'c8q5', depth: 3, threshold: 0.7,
          q: '<b>综合题。</b>目标是"复现 App 的请求签名"。已知：so 有 OLLVM 平坦化混淆；抓包显示 sign 是 32 位十六进制；静态搜 MD5 IV、AES S 盒、Base64 表全部零命中；你已确认存在 HMAC 结构（<span class="mono">0x36</span>/<span class="mono">0x5C</span> 填充 + 两次哈希调用）。<br>请给出你的<b>完整推进顺序</b>，并说明每一步为什么排在那个位置——特别是你<b>不会</b>先做什么。',
          concepts: [
            { label: '不先做去混淆/反平坦化：目标是算出签名而不是读懂代码', hint: '去混淆的成本和它对你当前未知量的帮助，哪个更划算？', any: ['不去混淆', '不去平坦化', '成本', '不划算', '没必要', '目标是签名', '太贵', '最后手段'] },
            { label: '先用标准实现打一发，与抓包结果比对来验证假设', hint: '面对"不确定 IV 是否被改"，最便宜的实验是什么？', any: ['标准实现', '直接算', 'hmac', '跑一遍', '比对', '验证', '实验', '试一下', '打一发'] },
            { label: '同时核对拼接方式：待签名原文的顺序、编码、大小写', hint: '算出来不一致时，除了算法还有什么地方最容易错？', any: ['拼接', '参数顺序', '排序', '编码', 'urlencode', '大小写', '原始串', '待签名', '原文'] },
            { label: '不一致再 Hook 压缩函数入口 dump 状态，用动态内存搜常量', hint: '实验排除了"标准值"之后，下一步用什么手段取证？', any: ['hook', 'dump', '内存', 'memory.scan', '动态', 'enumerateranges', '抓', 'trace', 'stalker'] },
            { label: '按常量/结构特征识别出算法家族后再决定还原方式', hint: '整个流程背后的排序原则是什么？', any: ['常量比对', '结构', '特征', '成本从低到高', '先便宜', '由易到难', '识别算法'] }
          ],
          hints: ['先别想"怎么读懂这段混淆代码"。先问：要算出正确的签名，我<b>必须</b>知道哪些未知量？', '把可能的动作按"成本"排个序：五分钟能做完的、五小时能做完的、五天能做完的，你会先做哪个？'],
          probes: ['如果标准实现算出来不一致，你凭什么判断是"算法被改"而不是"我拼接错了"？怎么设计实验把这两个原因分开？', '如果最后确认 MD5 的 IV 真的被改了，你的还原工作量有多大？还需要读汇编吗？'],
          model: '<b>第一步（五分钟）：用标准 HMAC-MD5 打一发。</b>把抓包参数按你的理解拼成待签名串，用已知密钥调 <span class="mono">hmac.new(key, msg, hashlib.md5)</span>，与抓包的 sign 比对。<b>为什么排第一：</b>成本最低，却一刀切开两种未来——一致就当场收工（作者只套了 OLLVM，没改算法）；不一致才说明确有魔改。<b>这一步的价值是用实验消灭不确定性，而不是用反汇编去猜。</b><br><b>第二步（同步）：核对待签名原文。</b>若不一致，<b>先怀疑拼接，再怀疑算法</b>——参数顺序、是否按 key 排序、URL 编码、空值处理、大小写、时间戳格式。设计实验把两个原因分开：找一个只有一个参数的极简请求，能对上就说明算法标准、复杂度在拼接上。<br><b>第三步（半小时）：动态内存搜常量。</b>attach 后用 <span class="mono">Process.enumerateRanges</span> + <span class="mono">Memory.scan</span> 搜 MD5 的 IV 字节序列。它比静态贵一点、比定位函数偏移便宜，而且加固方案常把常量解密到堆上，这一搜往往直接出结果。<br><b>第四步（一两小时）：Hook 压缩函数入口 dump 状态。</b>读前 4 个 32 位字与标准 IV 对比，拿到确定性答案。OLLVM 下定位偏移难，改用<b>数据驱动</b>：先找到常量在内存里的地址，再对访问该地址的指令下断点，比顺着平坦化控制流找入口高效得多。<br><b>第五步（按需）：还原。</b>若只是 IV 被改，换常量即可，<b>完全不需要读汇编</b>。<br><b>我不会先做的两件事：</b>① <b>不去混淆、不去平坦化</b>——成本最高（可能几天），且完全不回答"IV 是否被改"这个真正的未知量，混淆改变的是控制流而非数据；② <b>不先自己实现可调参数的哈希</b>——在假设被验证前就写代码是为可能不存在的需求付出全部成本，而且一旦对不上，你分不清是参数猜错还是自己实现写错。<br><b>贯穿原则：把所有手段按成本从低到高排开——常量比对 → 结构识别 → 动态内存 dump → Hook 抓中间状态 → 逐行/去混淆，永远先试最便宜的。</b>',
          after: '<p>这道题的通用形态是：<b>面对一个"不知道能不能读懂"的保护，先设计一个能证伪你假设的最便宜实验。</b>这个思维在后续章节（VMP、Unidbg、eBPF）里会反复用到——工具越重，越要先问"我是不是非用它不可"。</p>'
        }
      ] }
};
