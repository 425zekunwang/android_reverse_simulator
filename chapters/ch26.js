/* 第 26 章 · FART 10 & 12 版本演进
   分多次写入：本文件由 write + 多次 edit 拼装而成。
   注意：不确定的 ART 源码细节一律标注「待核实」，绝不编造函数名/字段名/编译命令。 */

/* 时间轴 stage 用的选取助手：清空 → 标记已完成 → 高亮当前 → 写三栏详情 */
function fartPick(cur, done, cols) {
  ['tl5', 'tl6', 'tl8', 'tl9', 'tl10', 'tl11', 'tl12'].forEach(function (i) { S(i, ''); });
  (done || []).forEach(function (i) { S(i, 'done'); });
  if (cur) S(cur, 'active');
  SET('tla', cols[0]); SET('tlb', cols[1]); SET('tlc', cols[2]);
}

window.CHAPTER = {
  no: 26,
  title: 'FART 10 & 12 版本演进',
  lede: '上一章你学会了写一个脱壳工具；这一章要告诉你一个更残酷的事实：<strong>那个工具明年就会失效</strong>。ART 的内部结构每个大版本都在变，插在里面的脱壳点必须重新定位——FART 不是一个成品，而是一个要持续维护的项目。本章用 FART 移植到 Android 10、以及用 FART14 秒脱 DexProtector 两个实战，把「读懂 ART 源码 → 重新定位脱壳点 → 适配编译 → 真机验证」这条链路走完，最后沉淀成一套<strong>遇到任何新壳都能用的决策框架</strong>。',
  meta: [
    '核心问题：<b>为什么同一个脱壳工具，换一个安卓大版本就不能用了？</b>',
    '关键能力：<b>读对应版本 AOSP 源码 → 找到 dex 加载与 code item 回填点 → 重新插桩</b>',
    '实战目标：<b>Android 10 上移植 FART；Android 14 上用 FART 秒脱 DexProtector</b>',
    '最重要的一句话：<b>逆向的护城河是原理理解，不是工具收藏</b>'
  ],

  sections: [
    /* ================= 26.1 ================= */
    {
      h: '26.1',
      title: '为什么 FART 必须跟着安卓版本一起走',
      intuition: {
        tag: '直觉模型 · 每年换一次锁芯的房东',
        body: '<p>你花三个月配出一把万能钥匙（FART），能开房东家的锁（某个版本的 ART）。可这位房东有个习惯：<b>每到一个大版本就换一次锁芯</b>——锁的位置没变，钥匙也还能插进去，但里面的弹子结构已经完全不同，齿形对不上了。</p>' +
              '<p>绝大多数人第一次移植失败，不是技术不行，而是心里默认了「脱壳工具是一次性投入」。真相是：<b>ART 是活的代码，每个大版本都在动</b>；而 FART 是插进 ART 内部的一根探针，探针插在哪里，是由 ART 的内部结构决定的。<b>结构一变，探针就得重新找位置。</b></p>' +
              '<p>所以本章真正要教的不是「FART 10 怎么改」，而是两件不会过期的事：<b>为什么必须持续维护</b>，以及<b>遇到新壳时的决策框架</b>。</p>'
      },
      html: T.note('key', '🔑 一句话抓住主线', '<p>FART 的每一次版本移植，本质都是同一个动作：<b>读那一版的 AOSP 源码 → 找到 dex 加载与 code item 回填的那个点 → 把插桩代码挪过去 → 重新编译刷入</b>。系统版本会变、函数名会变、字段布局会变，但「找脱壳点」这件事的方法论不变。<b>会读 ART 源码的人，永远能在新版本上重建 FART。</b></p>') +
            '<p>先把版本演进的时间轴摊开。下面这条轴上的每一格，都代表「FART 又得改一次」，注意看三栏分别发生了什么变化。<span class="small muted">（这一节会反复出现两个词，先把它们的意思钉死：' + T.term('脱壳点', '插桩代码所依附的 ART 内部位置。关键：它不是某个固定函数名，而是一个语义事件——例如「dex 加载完成」「方法体 code item 回填完成」。函数名随版本变，语义事件不变。') + '：FART 把插桩代码插在 ART 内部的哪个位置；' + T.term('ART 移植', '把为某个安卓版本编写的 ART 内部插桩代码，适配到另一个版本上的过程。本质工作 = 读对应版本 AOSP 源码 + 重新定位脱壳点 + 对齐接口与结构 + 重新编译刷入。') + '：把旧版本的 FART 改成能在新版本上跑的过程。后面所有讨论都建立在这两个概念上。）</span></p>',
      stage: {
        title: 'Android 版本 × ART 结构变化 × 脱壳点 演进图',
        speed: 2200,
        render:
          '<div class="flow-row" style="flex-wrap:wrap;gap:8px">' +
            '<span class="blk" id="tl5">Android 5</span>' +
            '<span class="blk" id="tl6">Android 6</span>' +
            '<span class="blk" id="tl8">Android 8</span>' +
            '<span class="blk" id="tl9">Android 9</span>' +
            '<span class="blk" id="tl10">Android 10</span>' +
            '<span class="blk" id="tl11">Android 11+</span>' +
            '<span class="blk" id="tl12">Android 12/13/14</span>' +
          '</div>' +
          '<div class="grid3" style="margin-top:12px">' +
            '<div class="card"><div class="card-title">ART 结构变化</div><div id="tla" class="small">点「播放」或「下一步」开始</div></div>' +
            '<div class="card"><div class="card-title">脱壳点要怎么调</div><div id="tlb" class="small">—</div></div>' +
            '<div class="card"><div class="card-title">FART 移植要改什么</div><div id="tlc" class="small">—</div></div>' +
          '</div>' +
          '<div style="margin-top:10px"><span class="pill" id="tlstat">维护状态：待观察</span></div>',
        reset: function () {
          fartPick(null, [], ['点「播放」或「下一步」开始', '—', '—']);
          CLS('tlstat', 'pill');
          SET('tlstat', '维护状态：待观察');
        },
        steps: [
          {
            run: function () { fartPick(null, [], ['点「播放」或「下一步」开始', '—', '—']); },
            note: '<b>先看整体：这条轴上每一格都意味着一次重做。</b>注意一个规律——<b>Android 5 到 6 是「从无到有」，6 之后的每一格都是「结构变了、必须重新定位」</b>。这就是 FART 必须持续维护的全部理由。'
          },
          {
            run: function () {
              fartPick('tl5', [], [
                'ART 正式取代 Dalvik：dex 的执行模型从「解释执行 + JIT」转为「AOT 编译 + 解释器兜底」。',
                'FART 的脱壳点此时还不存在。但 ART 带来了一个关键前提：<b>运行时内存里一定存在结构完整的 dex</b>。',
                '无。FART 不是从这一版起家的。'
              ]);
              CLS('tlstat', 'pill warn'); SET('tlstat', '维护状态：无工具可用');
            },
            note: '<b>Android 5.0 是分水岭，但不是 FART 的起点。</b>记住这条因果：<b>因为 ART 会在内存里把 dex 完整映射出来，脱壳才有物理基础</b>。Dalvik 时代也有脱壳，但内存布局与 ART 完全不同。'
          },
          {
            run: function () {
              fartPick('tl6', ['tl5'], [
                'ART 的实现逐渐稳定，<code>DexFile</code>、<code>ClassLinker</code>、<code>ArtMethod</code> 这套骨架定型，成为后续所有版本的共同祖先。',
                'FART 的原生脱壳点就在这一版被找到：<b>dex 加载完成处</b> + <b>方法体执行时的 code item 回填处</b>。',
                '这是 FART 的<b>起点版本</b>。后面每一版的移植，都是把这一版的插桩逻辑挪到新结构里。'
              ]);
              CLS('tlstat', 'pill ok'); SET('tlstat', '维护状态：基线版本（FART 6.0）');
            },
            note: '<b>为什么一定要抓住「基线版本」这个概念？</b>因为移植不是从零发明，而是<b>把一份已知正确的实现，翻译到新的结构上</b>。你手上永远要有一份「逻辑基准」——知道它到底在哪两个点插了桩、插桩时读写了哪些字段。'
          },
          {
            run: function () {
              fartPick('tl8', ['tl5', 'tl6'], [
                '<code>DexFile</code> 结构被重构，<code>ClassLinker</code> 的接口有较大调整，AOT 编译策略变得更激进。（<span class="pill warn">具体类名与字段差异待核实</span>）',
                '原来 hook 的那个函数可能改名、换签名、甚至搬到别的文件里。脱壳点必须<b>按语义重新定位</b>，而不是按旧函数名去搜。',
                '第一类真实移植工作出现了：<b>去读这一版的源码，找到「dex 加载完成」这个语义事件在新的哪一行代码上。</b>'
              ]);
              CLS('tlstat', 'pill warn'); SET('tlstat', '维护状态：首次大规模重定位');
            },
            note: '<b>这是移植心态的分界线。</b>Android 8 之前，很多人以为脱壳点是「一个固定的函数名」；Android 8 之后就明白了：<b>你要找的是语义事件（dex 何时加载完、方法体何时回填），函数名只是这一版对它的实现</b>。找语义，不要找名字。'
          },
          {
            run: function () {
              fartPick('tl9', ['tl5', 'tl6', 'tl8'], [
                'Android 9 引入 <b>CompactDex</b>：一种为节省内存而优化的 dex 变体，<b>指令操作数被重新编码</b>；同时 <code>dex2oat</code> 的编译流程也有调整。',
                '脱壳点仍要在 dex 加载路径上重新定位；同时<b>dump 出来的可能不是标准 dex</b>，如果不管这一点，产物用 jadx 打开会是一片乱码或报错。',
                '修复组件要升级：<b>识别 CompactDex 并做额外转换/还原</b>，否则前两步全对、最后一步白干。'
              ]);
              CLS('tlstat', 'pill warn'); SET('tlstat', '维护状态：dump 产物格式变了');
            },
            note: '<b>Android 9 教会我们一件事：移植不只改「脱壳点」，还要改「产物处理」。</b>内存里躺着的那份 dex 未必是教科书上的标准 dex 格式。遇到 dump 出来打不开的文件，<b>先怀疑格式变体，再怀疑 dump 错了</b>。'
          },
          {
            run: function () {
              fartPick('tl10', ['tl5', 'tl6', 'tl8', 'tl9'], [
                '<code>ArtMethod</code> 的结构为支持 <b>hidden API 策略</b>而调整，部分字段的访问方式发生变化，并引入了新的 dex 加载路径。（<span class="pill warn">具体字段名与访问器待核实</span>）',
                '脱壳点要在新的加载路径上重新定位；<b>取方法体（code item）的方式也必须改写</b>，因为原来读字段的写法可能已经不成立。',
                '本章第一个实战：<b>FART10 的移植</b>。第 26.3 节会把三个组件要改的地方逐个摊开。'
              ]);
              CLS('tlstat', 'pill'); SET('tlstat', '维护状态：本章实战（移植中）');
            },
            note: '<b>为什么 Android 10 的移植工作量特别大？</b>因为 <code>ArtMethod</code> 是「方法」这个概念的物理载体，而 FART 的第二步（遍历方法 + 主动调用 + dump code item）<b>每一步都要读 ArtMethod</b>。它一变，FART 最核心的那段循环就几乎要重写。'
          },
          {
            run: function () {
              fartPick('tl11', ['tl5', 'tl6', 'tl8', 'tl9', 'tl10'], [
                '<code>ArtMethod</code> 进一步调整，<b>部分信息被移到 <code>CodeItemDataAccessor</code> 之类的辅助结构里</b>。（<span class="pill warn">具体访问器名称与职责待核实</span>）',
                '「从方法拿到 code item」这个动作，从「直接读字段」变成了「通过一层访问器」。脱壳点要跟着换入口。',
                '遍历与取方法体的代码要重写成新的访问方式。<b>逻辑没变，接口全变</b>——这正是移植的典型形态。'
              ]);
              CLS('tlstat', 'pill warn'); SET('tlstat', '维护状态：接口层再变');
            },
            note: '<b>注意这个趋势：ART 在不断把内部字段「藏起来」。</b>早期版本可以直接读结构体字段，后来要经过访问器、要经过辅助结构。<b>这既是难度来源，也是提示</b>：当你在新版本里找不到某个字段时，去搜索「谁提供了等价的访问接口」，而不是硬找旧字段名。'
          },
          {
            run: function () {
              fartPick('tl12', ['tl5', 'tl6', 'tl8', 'tl9', 'tl10', 'tl11'], [
                '持续演进：Android 12 引入 <b>init_boot 分区</b>（ramdisk 搬家，刷机方式跟着变）；ART 的 GC、编译器、类链接器都在持续调整。',
                '脱壳点在新版本上<b>照旧要重新定位</b>——注意这里的「照旧」两个字：这就是常态，不是意外。',
                '第二个实战：<b>FART14 秒脱 DexProtector</b>。之所以能「秒脱」，正是因为这一版的重定位工作<b>已经提前做完了</b>。'
              ]);
              CLS('tlstat', 'pill ok'); SET('tlstat', '维护状态：持续维护中（FART14 就绪）');
            },
            note: '<b>走到时间轴末尾，回头看那个核心事实：</b>从 Android 6 到 14，ART 没有一年是「不变」的。所以「我的脱壳工具在 A 手机上好好的，换 B 手机就不行」不是玄学，<b>是版本结构差异的必然结果</b>。下一节把这七格逐条落成可对照的表格。'
          }
        ]
      },
      after: T.note('', '🧭 关于「待核实」', '<p>本节里凡是标注 <span class="pill warn">待核实</span> 的地方，都是<b>方向确定、但具体到某个函数名/字段名需要你打开对应版本源码确认</b>的点。这不是偷懒，而是本章要训练的态度：<b>版本相关的细节，永远以你手上那一版 AOSP 源码为准</b>。任何一份「永久有效的 ART 内部结构说明书」都是不可信的——包括本文。</p>')
    },

    /* ================= 26.2 ================= */
    {
      h: '26.2',
      title: '逐版本对照：ART 变了什么，脱壳点怎么调',
      html: '<p>把上一节的时间轴压成一张对照表。<b>这张表的价值不在于记住每一行，而在于看清「变化发生在哪一层」</b>——是加载路径变了、是结构布局变了、是产物格式变了，还是只剩刷机方式变了。不同层的变化，对应的移植工作量差一个数量级。</p>' +
            T.tbl(
              ['安卓版本', 'ART 发生了什么（大方向确定）', '脱壳点受到的影响', 'FART 移植要动的东西'],
              [
                ['<b>5.0</b>', 'ART 取代 Dalvik，执行模型改为 AOT + 解释器兜底', '尚无 FART 脱壳点；但内存中存在完整 dex 这一前提成立', '无（FART 从 6.0 起家）'],
                ['<b>6.0</b>', '<code>DexFile</code> / <code>ClassLinker</code> / <code>ArtMethod</code> 骨架定型', '原生脱壳点在此版被确定：<b>dex 加载完成处</b> + <b>code item 回填处</b>', '这是<b>基线版本</b>，移植的参照物'],
                ['<b>8.0</b>', '<code>DexFile</code> 结构重构、<code>ClassLinker</code> 接口调整、AOT 更激进', '旧函数名可能失效，必须<b>按语义事件重新定位</b>脱壳点', '重新读源码，找到「dex 加载完成」的新位置'],
                ['<b>9</b>', '引入 <b>CompactDex</b>（省内存的 dex 变体，指令操作数被重编码）；<code>dex2oat</code> 流程调整', '脱壳点需重新定位；<b>dump 产物可能不是标准 dex</b>', '修复组件升级：识别并处理 CompactDex 变体'],
                ['<b>10</b>', '<code>ArtMethod</code> 为支持 <b>hidden API 策略</b>而调整，字段访问方式变化，出现新的 dex 加载路径', '取方法体的方式必须改写，脱壳点要在新加载路径上重定位', '<b>本章实战</b>：三个组件逐项适配'],
                ['<b>11+</b>', '<code>ArtMethod</code> 再调整，部分信息移到 <code>CodeItemDataAccessor</code> 一类辅助结构 <span class="pill warn">待核实</span>', '「方法 → code item」从直读字段变为经过访问器', '遍历与取方法体逻辑按新接口重写'],
                ['<b>12/13/14</b>', 'Android 12 引入 <b>init_boot 分区</b>；GC / 编译器 / 类链接器持续演进', '脱壳点照旧要重新定位（这是常态）', '刷入方式随分区变化调整；<b>FART14 由此而来</b>']
              ]
            ) +
            T.note('', '📌 读这张表的正确姿势', '<p>不要试图背下每一行。请只记住<b>四种变化类型</b>：</p><p>① <b>加载路径变了</b>（8.0 / 10）→ 去源码里重新找「dex 什么时候加载完」；② <b>结构布局变了</b>（8.0 / 10 / 11+）→ 去源码里重新找「怎么从方法拿到 code item」；③ <b>产物格式变了</b>（9）→ 改修复组件；④ <b>只有刷机/分区变了</b>（12）→ 改交付方式，插桩逻辑不动。</p><p>拿到任何一个新版本，先判断它属于哪一类，<b>你就已经知道这次移植大概要花几天、会卡在哪</b>。</p>'),
      after: T.note('warn', '⚠️ 不要去找「标准答案」', '<p>市面上流传着各种「ART 结构对照表」，它们大多在半年内就会过时。<b>唯一可靠的做法是打开你手上那一版 AOSP 源码自己确认</b>：关键代码通常位于 <code>art/runtime/</code> 目录下，与 dex 加载、类链接、方法访问相关的几个源文件里（<span class="pill warn">具体文件名随版本差异较大，待核实</span>）。第 26.4 节会把「怎么在源码里找脱壳点」拆成可执行步骤。</p>')
    },

    /* ================= 26.3 ================= */
    {
      h: '26.3',
      title: 'FART 的三根支柱：dump dex、主动调用、修复',
      html: '<p>移植之前先要想清楚一件事：<b>你到底在移植什么？</b>FART 看起来是一大坨代码，实际上只有三块功能，每一块的适配点都不一样。把这三块分清楚，移植时才知道自己卡在哪一块。</p>' +
            '<p>先明确这一节会用到的基本概念：' + T.term('code item', 'dex 中描述一个方法体的结构，指令数组（insns）就在里面。抽取壳抽走的正是它，因此它「有没有内容」是判断脱壳是否成功的关键。') + '是 dex 里承载方法体的结构，' + T.term('抽取壳', '加壳时把方法体从 dex 中抽走，只在方法真正执行前由壳解密填回。它的 dex 结构完整（类名、方法名都在），但方法体为空——因此必须先触发回填才能脱。') + '则是动了它的一种加固类型。这两者会在下面反复出现。</p>' +
            T.grid(3, [
              '<div class="card"><div class="card-title">① dex 文件 dump</div><p>在 <code>DexFile</code> 完成映射/加载的那个点，把内存里完整的 dex 落盘。<b>一次加载只做一次</b>，产物是 App 启动时解密的原始 dex。</p><p class="small muted">适配点：DexFile 的构造与 Open 系列方法，或这一版新的加载入口（<b>随版本变化</b>）。</p></div>',
              '<div class="card"><div class="card-title">② code item dump（含主动调用）</div><p>遍历所有类、所有方法，<b>逐个触发调用以强制回填方法体</b>，再 dump 出方法体。这是抽取壳的克星。</p><p class="small muted">适配点：怎么遍历 DexFile 里的 ClassDef；怎么拿到 code_item；<b>ArtMethod 的字段布局（版本差异最大）</b>。</p></div>',
              '<div class="card"><div class="card-title">③ 修复组件</div><p>把 dump 出来的方法体合并回 dex，修正文件头与 map 段，产出 jadx 能打开的成品。</p><p class="small muted">适配点：dex 格式本身相对稳定，但 <b>CompactDex 等变体需要额外处理</b>。</p></div>'
            ]) +
            T.note('key', '🔑 三块功能的「版本敏感度」完全不同', '<p>这是移植前最该建立的一张优先级表：</p>' +
              '<p><b>③ 修复组件最稳</b>——dex 格式是公开规范，五年八年不怎么变；<b>① dex dump 中等</b>——加载路径会变，但语义事件（"dex 加载完成"）只有几个地方可能；<b>② 主动调用最脆</b>——它直接依赖 <code>ArtMethod</code> 的内存布局，而这个结构<b>几乎每个大版本都在动</b>。</p>' +
              '<p>结论很实用：<b>移植时把 80% 的时间留给 ②</b>。看到有人移植失败，多半是卡在「我能 dump 出 dex 了，但方法体全是空的」。</p>'),
      after: T.note('warn', '⚠️ 为什么「dump 出 dex」不等于脱壳成功', '<p>如果目标只是<b>一代壳</b>（整体加密、启动时一次性解密到内存），①就够用了：内存里那份 dex 结构完整，直接 dump 即可。</p>' +
        '<p>但如果目标是<b>抽取壳</b>，① 拿到的 dex 是「空壳」——<b>结构完整、类和方法的名字都在，唯独方法体（code item）是空的或被 nop 填充</b>。因为加固厂商在加壳时就把方法体抽走了，只在真正要执行某个方法时才由壳的解密逻辑填回去。</p>' +
        '<p>这就逼出了 FART 最核心也最独特的设计：<b>你不去等它回填，你主动触发它回填</b>。这正是下一节要拆解的那段循环。</p>')
    },

    /* ================= 26.4 ================= */
    {
      h: '26.4',
      title: '主动调用的核心循环：FART 最独特的那段代码',
      html: '<p>FART 相对其他脱壳工具最大的差别，就是<b>主动调用（invoke）</b>。它不去被动等待壳自己解密方法体，而是<b>用双重循环把 App 里每一个方法都调用一遍</b>，用「强制执行」逼 ART 把 code item 填回内存，然后再 dump。</p>' +
            '<p>下面这段是主动调用循环的结构示意（伪代码）。<b>注意看它的嵌套层次——每一层在不同安卓版本上的稳定性是不一样的</b>，右边状态栏会跟着循环推进而变化。</p>',
      stepper: {
        title: 'FART 主动调用循环（结构示意 · 伪代码）',
        lines: [
          {
            code: '<span class="c">// 目标：遍历所有 dex → 所有类 → 所有方法 → 强制调用 → dump 方法体</span>',
            note: '<b>先把目标说清楚。</b>FART 的第二块功能不是为了「执行 App 逻辑」，而是为了<b>触发副作用</b>：只要方法被真正执行过一次，它的方法体就必须存在于内存中。<b>调用是手段，回填才是目的。</b>',
            state: { '阶段': '准备', '已 dump 类': '0', '已 dump 方法': '0' },
            mem: '/sdcard/fart/<包名>/\n  (空)'
          },
          {
            code: '<span class="k">for</span> (<span class="k">auto</span>&amp; df : <span class="f">dex_files</span>) {   <span class="c">// 第 1 层：遍历 DexFile</span>',
            note: '<b>最外层。</b>一个 App 运行时可能同时存在多个 DexFile（多 dex、动态加载的 dex、壳自己释放出来的 dex）。<b>适配点：怎么枚举到全部 DexFile——这一层的接口在不同版本里叫法不同</b>（<span class="pill warn">待核实</span>）。',
            state: { '阶段': '遍历 DexFile', '当前 dex': 'classes.dex', '已 dump 类': '0', '已 dump 方法': '0' }
          },
          {
            code: '  <span class="k">const</span> DexFile::Header&amp; hdr = df.<span class="f">GetHeader</span>();',
            note: '<b>读 dex 头。</b>脱壳的第一手信息就在这里——尤其是 <code>class_defs_size</code>（类定义数量）与 <code>map_off</code>（段表偏移）。<b>dump 完整 dex 时，这份头信息决定了你要拷贝多大、拷贝哪几段</b>，这也是 ① 号功能的关键。',
            state: { '阶段': '读 dex 头', 'class_defs_size': '3821（示例值）', '已 dump 类': '0' },
            mem: 'header:\n  magic   dex\\n035\\0\n  map_off -> 段表'
          },
          {
            code: '  <span class="k">for</span> (<span class="t">uint32_t</span> i = <span class="n">0</span>; i &lt; hdr.<span class="f">class_defs_size_</span>; ++i) {  <span class="c">// 第 2 层：遍历 ClassDef</span>',
            note: '<b>第二层：遍历 DexFile 里的每一个类定义（ClassDef）。</b>ClassDef 描述「这个类叫什么、字段在哪、方法在哪、用哪个 class_data_item」。<b>适配点：怎么从 DexFile 里取出第 i 个 ClassDef——8.0 之后这部分结构被重构过</b>（<span class="pill warn">待核实</span>）。',
            state: { '阶段': '遍历 ClassDef', '当前类': 'com/example/App;', '类进度': '1 / 3821', '已 dump 方法': '0' },
            mem: 'class_defs[]\n [0] Lcom/example/App;\n [1] ...'
          },
          {
            code: '    <span class="k">const</span> DexFile::ClassDef&amp; cd = df.<span class="f">GetClassDef</span>(<span class="n">i</span>);',
            note: '<b>取出当前类的定义。</b>到这里你已经拿到了「类」这个维度的全部信息。<b>这一步通常要配合解析 class_data_item</b>——方法列表就在里面，而不是在 ClassDef 的定长字段里。',
            state: { '阶段': '解析类数据', '当前类': 'com/example/App;', '方法数(本类)': '37' }
          },
          {
            code: '    <span class="k">auto</span>* klass = <span class="f">class_linker</span>-&gt;<span class="f">FindClass</span>(df, cd.<span class="f">class_idx_</span>);',
            note: '<b>把「dex 里的类」变成「运行时真正可调用的类」。</b>这一步不能省：只有拿到 ART 内部的类对象，才谈得上遍历它的方法、才谈得上调用。<b>适配点：ClassLinker 的接口在 Android 8.0 有较大调整</b>（<span class="pill warn">具体签名待核实</span>）。',
            state: { '阶段': '解析类(ClassLinker)', '当前类': 'com/example/App;', '类状态': '已解析' }
          },
          {
            code: '    <span class="k">for</span> (<span class="k">auto</span>&amp; m : <span class="f">klass</span>-&gt;<span class="f">GetMethods</span>()) {  <span class="c">// 第 3 层：遍历方法</span>',
            note: '<b>第三层：遍历这个类的所有方法。</b>注意从这一层开始，<b>你面对的不再是 dex 格式，而是 ART 的运行时结构</b>——后面的每一步都直接踩在 <code>ArtMethod</code> 的布局上。<b>这就是移植时最容易崩的地方</b>。',
            state: { '阶段': '遍历方法', '当前类': 'com/example/App;', '当前方法': 'onCreate', '方法进度': '1 / 37' }
          },
          {
            code: '      <span class="t">ArtMethod</span>* am = m;   <span class="c">// 关键结构：版本差异最大的一环</span>',
            note: '<b>整章最脆的一行。</b><code>ArtMethod</code> 描述一个方法：它在哪里、怎么执行、代码在哪。<b>Android 10 为支持 hidden API 策略调整过它；Android 11+ 又把部分信息移到 <code>CodeItemDataAccessor</code> 一类的辅助结构里</b>（<span class="pill warn">字段名与访问器待核实</span>）。<b>它在内存里长什么样，直接决定了你能不能拿到 code item。</b>',
            state: { '阶段': '取方法体访问方式', '当前方法': 'onCreate', '取 code item 方式': '直读字段 / 经访问器？', '已 dump 方法': '0' },
            mem: 'ArtMethod {\n  ...版本相关字段...\n  -> code item ?\n}'
          },
          {
            code: '      <span class="f">Invoke</span>(am);   <span class="c">// 主动调用：强制执行，逼 ART 回填 code item</span>',
            note: '<b>FART 的灵魂动作。</b>为什么一次调用就能让方法体出现？因为 ART 要执行一个方法，<b>必须先把它的方法体准备到位</b>——无论是解释执行时的指令数组，还是被抽取后由壳填回的内存区。<b>你不需要知道壳怎么解密的，你只需要让它不得不执行。</b>这就是主动调用比「找到解密函数再调它」更工程化的地方。',
            state: { '阶段': '主动调用', '当前方法': 'onCreate', '调用结果': '已执行 → 方法体就位', '已 dump 方法': '0' },
            mem: 'code_item:\n  空/被抽取 → 已回填'
          },
          {
            code: '      <span class="f">dump_code_item</span>(am, ...);   <span class="c">// 把已回填的方法体落盘</span>',
            note: '<b>趁热打铁：刚回填完就 dump。</b>这一步是 ② 号功能的产出。常见坑：<b>调用可能抛异常、可能因为参数不对而提前返回</b>，所以真实实现里要处理异常与调用失败的兜底——<b>失败的方法会被漏掉，这正是「脱完之后 App 还有几个方法反编译不出来」的典型原因</b>。',
            state: { '阶段': 'dump code item', '当前方法': 'onCreate', '已 dump 方法': '1', 'dump 目录': '/sdcard/fart/<包名>/' }
          },
          {
            code: '    } } <span class="c">// 三层循环闭合：方法 → 类 → dex</span>',
            note: '<b>三层循环走完，才算「遍历完一遍」。</b>注意复杂度：<b>类数 × 每类方法数</b>，一个中等 App 就是几万次调用。所以 FART 的主动调用天然是慢的——这也解释了为什么「秒脱」这个词不是指这一过程快，而是指<b>你不用再花时间做适配工作了</b>（26.6 节详解）。',
            state: { '阶段': '循环收尾', '已 dump 类': '3821', '已 dump 方法': '41872（示例值）' },
            mem: '方法体合并 → 修复\n → 可反编译的 dex'
          },
          {
            code: '<span class="f">LOG</span>(INFO) &lt;&lt; <span class="s">"fart run over"</span>;   <span class="c">// 标志：一轮脱壳结束</span>',
            note: '<b>记住这个标志。</b>FART 系列跑完会打这一行日志，它是你验证「到底跑没跑完」最直接的信号：<code>adb logcat | grep fart</code> 看到它，再去查 <code>/sdcard/fart/&lt;包名&gt;/</code> 的产物。<b>看不到这行，后面所有验证都是空谈。</b>',
            state: { '阶段': '完成', '日志': 'fart run over', '产物': '/sdcard/fart/<包名>/' },
            mem: 'logcat:\n I/fart: fart run over\n/sdcard/fart/com.example/\n  *.dex  *.bin'
          }
        ]
      },
      after: T.note('key', '🔑 从这段循环里读出的移植地图', '<p>把上面 12 步按「依赖什么」重新归类，移植工作量一目了然：</p>' +
        '<p><b>只依赖 dex 格式</b>（稳定）：读 header、取 ClassDef、解析 class_data_item。<b>依赖 ART 运行时接口</b>（半稳定）：枚举 DexFile、ClassLinker::FindClass。<b>依赖内存布局</b>（最不稳定）：<code>ArtMethod</code> 及「如何从中取得 code item」。</p>' +
        '<p>所以移植时正确的顺序是：<b>先让编译通过（把接口层的新签名对齐）→ 再让循环跑起来（能遍历到类和方法）→ 最后打通取方法体（对齐新结构/新访问器）</b>。反过来做，你会同时面对三个未知问题，连日志都不知道该信哪一条。</p>')
    },

    /* ================= 26.5 ================= */
    {
      h: '26.5',
      title: '移植的完整链路：六步走完 FART10 适配',
      html: '<p>概念讲完了，落到手上就是六个动作。下面这条链路是<b>通用</b>的——把它里的「Android 10」换成任何版本，流程都一样。<b>每一步都标了难点在哪，卡住时对着难点查，比盲目搜索有效得多。</b></p>',
      stage: {
        title: 'FART 移植工作流：从 AOSP 源码到脱壳产物',
        speed: 2100,
        render:
          '<div class="flow-row" style="flex-wrap:wrap;gap:6px">' +
            '<span class="blk" id="w1">① 定版本</span><span class="arrow">→</span>' +
            '<span class="blk" id="w2">② 读源码</span><span class="arrow">→</span>' +
            '<span class="blk" id="w3">③ 插桩</span><span class="arrow">→</span>' +
            '<span class="blk" id="w4">④ 编译</span><span class="arrow">→</span>' +
            '<span class="blk" id="w5">⑤ 刷入</span><span class="arrow">→</span>' +
            '<span class="blk" id="w6">⑥ 验证</span>' +
          '</div>' +
          '<div class="card" style="margin-top:12px"><div class="card-title" id="wtitle">点击「播放」开始</div><div id="wbody" class="small">六步链路：每一步都会告诉你在做什么、难点在哪、怎么判断这一步真的成功了。</div></div>' +
          '<div style="margin-top:10px"><span class="pill" id="wphase">当前：未开始</span></div>',
        reset: function () {
          ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].forEach(function (i) { S(i, ''); });
          SET('wtitle', '点击「播放」开始');
          SET('wbody', '六步链路：每一步都会告诉你在做什么、难点在哪、怎么判断这一步真的成功了。');
          CLS('wphase', 'pill'); SET('wphase', '当前：未开始');
        },
        steps: [
          {
            run: function () {
              ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].forEach(function (i) { S(i, ''); });
              S('w1', 'active');
              SET('wtitle', '① 确定目标 Android 版本，拿到对应版本的 AOSP 源码');
              SET('wbody', '<b>做什么：</b>先把「我要在哪个系统版本上脱壳」钉死——不是「大概 10 左右」，而是具体到 Android 10 的某一个源码版本。然后获取该版本的 AOSP 源码。' +
                '<br><b>难点：</b>版本必须与真机严格对应。同一大版本的不同小版本之间，ART 也可能有差异，<b>源码与设备的版本错位 = 后面所有功夫白费</b>。' +
                '<br><b>成功标志：</b>源码树就位，且你能明确说出「我要编译的 ART 对应设备上的哪一份二进制」。');
              CLS('wphase', 'pill acc'); SET('wphase', '当前：① 定版本');
            },
            note: '<b>第一步就决定了成败概率。</b>移植失败最常见的根因不是技术难题，而是<b>源码版本与目标设备不匹配</b>——你在 A 版本源码上改了代码，编译产物丢到 B 版本的系统里，运行时的行为诡异到你怀疑人生。'
          },
          {
            run: function () {
              S('w1', 'done'); S('w2', 'active');
              SET('wtitle', '② 读 ART 源码，定位 dex 加载流程与 code item 回填点');
              SET('wbody', '<b>做什么：</b>找到两个语义事件在<b>这一版</b>代码里的确切位置：<b>（a）dex 何时加载/映射完成</b>（①号功能的插桩点）；<b>（b）方法体的 code item 何时被填入 ArtMethod</b>（②号功能的插桩点）。相关代码通常位于 <code>art/runtime/</code> 下与 dex 文件、类链接、方法相关的源文件里（<span class="pill warn">具体文件名随版本差异较大，待核实</span>）。' +
                '<br><b>难点：</b>这是<b>整条链路真正的技术活</b>。你要在几十万行 C++ 里，凭语义而非函数名找到那两个点。' +
                '<br><b>成功标志：</b>你能指着某一行说「dex 到这里就已经完整了」「方法体是在这里被填进去的」，并能说出为什么是这里。');
              CLS('wphase', 'pill acc'); SET('wphase', '当前：② 读源码找点');
            },
            note: '<b>这一步才是「读懂 ART 源码」能力的实战检验，也是不会过期的那部分技能。</b>版本从 10 换到 14，函数名会变、目录会挪，但「dex 什么时候变完整」「方法体什么时候就位」这两个问题永远存在。<b>会问这两个问题的人，永远能重建 FART。</b>'
          },
          {
            run: function () {
              S('w2', 'done'); S('w3', 'active');
              SET('wtitle', '③ 把 FART 的插桩代码嵌入到对应位置');
              SET('wbody', '<b>做什么：</b>把三块功能接到刚找到的点上：dump dex 接到「加载完成」处；主动调用循环接到「方法可被调用」的时机；修复组件独立在设备侧/PC 侧运行。' +
                '<br><b>难点：</b>ART 代码对<b>时序与线程状态</b>敏感。插桩位置不对，轻则 dump 到半成品，重则直接把 App 搞崩。' +
                '<br><b>成功标志：</b>代码能编过（第一步的真正含义是接口对齐），且插桩点选得有理由。');
              CLS('wphase', 'pill acc'); SET('wphase', '当前：③ 插桩');
            },
            note: '<b>插桩位置的三个经典坑：</b>① <b>太早</b>——dex 还没映射完就 dump，产物残缺；② <b>太晚</b>——壳已经清理过痕迹，或类已经被 AOT 编译成机器码、根本不需要回填方法体；③ <b>在错误的线程上下文里</b>——主动调用可能因为线程状态不对而失败。<b>「dump 出来是空的」这类问题，八成出在这里，而不是出在修复组件。</b>'
          },
          {
            run: function () {
              S('w3', 'done'); S('w4', 'active');
              SET('wtitle', '④ 编译 ART 模块');
              SET('wbody', '<b>做什么：</b>用 AOSP 的构建系统编译你改过的 ART 部分（AOSP 提供 <code>m</code> / <code>mmm</code> 一类的构建入口，<span class="pill warn">具体命令随源码版本与构建配置而变，待核实</span>）。' +
                '<br><b>难点：</b>编译本身不难，<b>难的是环境</b>：源码树大小、依赖、构建配置、编译时长，都可能让你在这里耗掉一整天。这是移植过程中最「体力活」的一步。' +
                '<br><b>成功标志：</b>产出对应架构的 ART 运行时库文件，且知道它对应设备上的哪个路径。');
              CLS('wphase', 'pill acc'); SET('wphase', '当前：④ 编译');
            },
            note: '<b>把编译当体力活，把找脱壳点当脑力活</b>——这是合理的时间分配。很多人反过来了：在编译报错上死磕三天，却对「我插桩的那个点是不是对的」毫无把握。'
          },
          {
            run: function () {
              S('w4', 'done'); S('w5', 'active');
              SET('wtitle', '⑤ 刷入设备：push 到系统库目录，或用完整 ROM 刷入');
              SET('wbody', '<b>做什么：</b>把编译产物送进设备。常见做法是 push 到系统库目录（<code>/system/lib64/</code> 或对应的架构目录，<span class="pill warn">具体路径随设备与分区方案而变，待核实</span>），或者干脆编译完整 ROM 刷入。' +
                '<br><b>难点：</b>分区与权限。<b>Android 12 引入 <code>init_boot</code> 分区后，ramdisk 的归属变了，老教程里的刷机路径可能整段失效</b>——这也是「版本演进」打在交付环节上的一记重拳。' +
                '<br><b>成功标志：</b>设备能正常开机，且系统跑的是<b>你编译的那一份</b> ART。');
              CLS('wphase', 'pill acc'); SET('wphase', '当前：⑤ 刷入');
            },
            note: '<b>改系统库是高风险动作。</b>务必先确认能回滚（有原厂镜像、有可进入的恢复途径）。真机调试的第一原则：<b>先保证变砖能救，再动手改系统</b>。'
          },
          {
            run: function () {
              S('w5', 'done'); S('w6', 'active');
              SET('wtitle', '⑥ 验证：装 App → 启动 → 看日志 → 查产物');
              SET('wbody', '<b>做什么：</b>按固定顺序验证：安装目标 App → 启动它 → 用 <code>adb logcat</code> 过滤 <code>fart</code> 相关日志，寻找跑完的标志（如 <code>fart run over</code>）→ 检查设备上的输出目录 <code>/sdcard/fart/&lt;包名&gt;/</code>。' +
                '<br><b>难点：</b>「跑完了」不等于「脱干净了」。产物要拿去反编译验证：<b>方法体是真的指令，还是空的 / 全是 nop。</b>' +
                '<br><b>成功标志：</b>日志有完成标志 + 目录里有产物 + <b>反编译能看到真实方法体的代码</b>。三者缺一不算成功。');
              CLS('wphase', 'pill ok'); SET('wphase', '当前：⑥ 验证（链路闭环）');
            },
            note: '<b>把验证拆成两级：</b>一级验证「工具跑完了吗」（日志 + 目录），二级验证「脱出来的东西有用吗」（反编译看方法体）。<b>90% 的假成功都死在一级验证就收工</b>——目录里有文件、文件能打开，但打开是空的。'
          }
        ]
      },
      after: T.note('ok', '✅ 这条链路为什么值得背下来', '<p>因为它对<b>任何版本的 FART 移植</b>都成立，也对<b>任何「往 ART 里插桩」的需求</b>成立（不只是脱壳：动态插桩、API 监控、运行时数据采集，全是这套）。</p>' +
        '<p>六步里只有 ② 需要真正的智力投入，其余五步是熟练度问题。<b>所以「移植 FART」这件事的核心竞争力，就是「能不能在 ART 源码里快速找到那个语义事件」</b>——这恰好就是本课程从第 17 章开始一直在练的能力。</p>')
    },

    /* ================= 26.6 ================= */
    {
      h: '26.6',
      title: '「秒脱」的真相：前期投入与后期效率',
      intuition: {
        tag: '直觉模型 · 老猎人进山',
        body: '<p>两个人同时进山打猎。第一个人背了二十件工具，每种猎物配一套家伙，进山先花半天挑工具；第二个人只带一把刀，但他知道<b>猎物什么时候喝水、走哪条路、脚印长什么样</b>。天黑了，第二个人扛着猎物回来，第一个人还在整理背包。</p>' +
              '<p>「用 FART14 秒脱 DexProtector」听起来像神话，实际上它是<b>第二个人</b>：适配 Android 14 的工作早在几个月前就做完了（26.5 节那六步走了一遍），所以真正面对一个具体 App 时，剩下的动作只有三步——<b>装上去、跑一遍、看产物</b>。几分钟。</p>' +
              '<p>但请注意：<b>这把刀之所以快，是因为握刀的人知道猎物在哪。</b>如果你不知道 dex 在哪里解密、方法体什么时候回填，那么「秒脱」这件事永远不会发生在你身上——你只会有二十件工具和一片空山。</p>'
      },
      html: T.tbl(
        ['对比维度', '前期投入（会过期，但能迁移）', '后期效率（看起来很像神话）'],
        [
          ['时间分布', '读 AOSP 源码、找脱壳点、适配接口、编译刷入验证——<b>以天/周计</b>', '装 App、触发、看日志、取产物——<b>以分钟计</b>'],
          ['面对新壳', '建立一个已经适配好当前系统的工具底座', '把新 App 丢进去跑一遍即出结果'],
          ['失败代价', '失败只是「这次没找到点」，认知在累积', '失败说明底座不适配，要回到前期投入'],
          ['会过期吗', '<b>工具会过期</b>（下个安卓版本就废），<b>找脱壳点的能力不会</b>', '随版本必然失效，属于消耗品'],
          ['护城河', '<b>原理理解 = 真护城河</b>', '工具收藏 = 假安全感']
        ]
      ) +
      T.note('key', '🔑 本章最该带走的一句话', '<p><b>逆向的护城河在于原理理解，不在于工具收藏。</b></p>' +
        '<p>工具会随版本失效——FART 6.0 的二进制不能用在 Android 10 上，FART 10 的也不能直接用在上 14。但「知道 dex 在哪里被解密、方法体什么时候回填、脱壳点该往哪插」这套认知，从 Android 6 到 14 一直在用，往后十年大概也还能用。</p>' +
        '<p>所以看到别人「秒脱」时，不要问「他用的是哪个工具」，要问「他为这个工具提前做了什么」。<b>前者是收藏家的问题，后者是工程师的问题。</b></p>') +
      T.note('warn', '⚠️ 三个关于「秒脱」的误读', '<p><b>误读一：秒脱 = 脱壳技术简单。</b>不是。秒脱的前提是有人已经把最难的部分（找脱壳点 + 适配结构）做完了，而这件事没有任何捷径。</p>' +
        '<p><b>误读二：秒脱 = 一次适配永久有效。</b>不是。FART14 只对 Android 14 那一档系统有效，换到 Android 15 或换一个改动过 ART 的 ROM，可能立刻回到「跑不起来」的状态。</p>' +
        '<p><b>误读三：秒脱 = 能脱一切。</b>不是。<b>遇到 VMP（关键方法虚拟化），FART 这类基于 dex 的脱壳工具会直接失效</b>——因为那些方法的「方法体」根本不再是 dex 指令，你 dump 出来的 code item 里没有可还原的东西。这时候要换第 20 章的思路，或者干脆不脱壳、改走动态 Trace / 黑盒调用。</p>')
    },

    /* ================= 26.6L 动手实验 ================= */
    {
      h: '26.6L', title: '动手实验：判断你的脚本为什么在某个安卓版本上失效',
      html:
        '<p>本章最核心的认知是：<b>每个安卓大版本，ART 内部结构都会变，脱壳点必须重新定位</b>。' +
        '这个实验让你把"版本"和"失效原因"对应起来。</p>',
      lab: {
        title: '实验：ART 版本演进与脚本失效诊断',
        goal: '目标：按版本定位失效原因',
        intro:
          '<p>你手上有一份在<b>某个安卓版本上验证可用</b>的 FART 脱壳脚本。' +
          '现在换到另一台设备上，脚本报错或脱不出东西。</p>' +
          '<p><b>任务：输入目标安卓版本，查出这一代的 ART 关键变化，判断你的脚本最可能踩到哪个坑。</b></p>',
        inputs: [
          { key: 'ver', label: '① 目标设备的 Android 版本（填数字）',
            hint: '例如 5 7 8 9 10 11 12 13 14', ph: '9', value: '9' },
          { key: 'guess', label: '② 你觉得最可能的原因是什么？',
            hint: '想想"结构变了"还是"权限变了"还是"格式变了"', ph: '可能是……', type: 'textarea', rows: 2 }
        ],
        runLabel: '🔍 查询该版本变化',
        autorun: true,
        run: (v) => {
          const L = window.LABX;
          const era = L.artEra(v.ver);
          if (!era) {
            return '<div class="lab-msg warn">未识别该版本。可填 5 / 7 / 8 / 9 / 10 / 11 / 12 / 13 / 14。<br>' +
              '（本表只收录了 ART 结构有<b>显著变化</b>的版本；其余版本变化较小。）</div>';
          }

          let html = '<div class="lab-kv"><span>版本 <b>' + era.label + '</b></span>'
            + '<span>年份 <b>' + era.years + '</b></span></div>';

          html += '<table class="lab-tbl"><tr><th>这一代的关键变化</th></tr>';
          era.keys.forEach(k => { html += '<tr class="diff"><td>' + k + '</td></tr>'; });
          html += '</table>';

          if (era.note) {
            html += '<div class="lab-msg key"><b>💡 对脱壳的影响</b><div class="lab-note">' + era.note + '</div></div>';
          }

          // 版本特有的诊断提示
          const DIAG = {
            5:  '这一代结构相对简单，绝大多数老脚本能直接跑。如果失效，优先怀疑<b>壳的强度</b>而不是系统版本。',
            7:  '<b>VDex 是关键。</b>同一个 dex 可能存在两份（原始 + 验证副本），dump 时要确认你脱的是哪一份。搞错了会得到一个"看起来完整但缺失部分方法"的 dex。',
            8:  '<b>这是最经典的分水岭。</b>DexFile 结构重构 + ClassLinker 接口调整，意味着针对 Android 7 及更早写的脱壳点<b>全部失效</b>。如果你手上的脚本是 2017 年前的，几乎必然在这一代挂掉。',
            9:  '<b>CompactDex 是核心难点。</b>dex 被拆成"指令 + 共享数据"两部分，脱壳时<b>必须同时处理两者</b>，只 dump 指令部分会得到不完整的 dex。而且这种情况从文件头就能看出来（magic 是 039 但结构不同）。',
            10: '<b>hidden API 策略。</b>如果你用的方案里有 Java 层反射调用（比如主动调用某些方法），可能被灰/黑名单拦住。表现为"某些方法调用不生效"而非崩溃。',
            11: '<b>访问方式变了。</b>原来直接读 ArtMethod 字段的代码，现在要改成通过 <code>CodeItemDataAccessor</code> 之类的访问器。表现为<b>编译不过或读出垃圾值</b>。',
            12: '<b>最大的认知陷阱：ART 变成 APEX 模块了。</b>这意味着 <b>Android 版本不再等同于 ART 版本</b>——同一台 Android 12 设备，ART 模块可能被单独升级过。你的"版本对应表"从这里开始不可靠了。',
            13: 'ART 继续模块化。延续 Android 12 的结论：<b>以 ART 模块版本为准，而不是系统版本</b>。',
            14: '<b>init_boot 分区引入</b>会影响刷机方式（不只是脱壳）。另外延续模块化的结论：一定要查实际的 ART 版本。'
          };
          html += '<div class="lab-msg fail"><b>🎯 最可能的失效点</b>'
            + '<div class="lab-note">' + (DIAG[era.v] || '这一代变化较小，按通用流程排查。') + '</div></div>';

          // 通用排查顺序
          html += '<div class="lab-msg model"><b>📋 遇到"换版本就失效"的通用排查顺序</b>'
            + '<div class="lab-note"><b>① 先确认 ART 版本，不是 Android 版本</b><br>'
            + '&nbsp;&nbsp;&nbsp;<code>adb shell getprop ro.bootimage.build.fingerprint</code><br>'
            + '&nbsp;&nbsp;&nbsp;Android 12+ 尤其要看 APEX 里的 ART 模块版本<br><br>'
            + '<b>② 再确认失败形态</b>——不同形态指向不同原因：<br>'
            + '&nbsp;&nbsp;&nbsp;• <b>编译不过</b> → 结构/字段名变了（如 Android 11 的访问器）<br>'
            + '&nbsp;&nbsp;&nbsp;• <b>编译过但读出垃圾</b> → 字段偏移变了<br>'
            + '&nbsp;&nbsp;&nbsp;• <b>能跑但脱不出内容</b> → 脱壳点时机不对，或格式变了（如 CompactDex）<br>'
            + '&nbsp;&nbsp;&nbsp;• <b>部分方法缺失</b> → 可能脱错了副本（如 VDex）<br><br>'
            + '<b>③ 最后回源码</b>——不要在错误的版本上瞎试，去读目标版本的 AOSP 里那个结构体的定义。</div></div>';
          return html;
        },
        expected: (v) => {
          const L = window.LABX;
          const era = L.artEra(v.ver);
          const guess = String(v.guess || '').trim();
          if (!era) return { ok: false, detail: '先填一个有效版本（5/7/8/9/10/11/12/13/14）。' };
          const hitStruct = window.AKKC_hasConcept(guess, ['结构', '字段', '偏移', '访问器', '接口', '变了', '重构']);
          const hitFormat = window.AKKC_hasConcept(guess, ['格式', 'compact', 'cdex', 'vdex', 'dex 格式', '拆分']);
          const hitPerm = window.AKKC_hasConcept(guess, ['权限', 'hidden', 'selinux', '策略', '限制']);
          const any = hitStruct || hitFormat || hitPerm;
          return {
            ok: any,
            detail: any
              ? '<b>方向对了。</b>版本失效的原因基本落在这三类：<br>' +
                '① <b>结构变了</b>（字段名/偏移/访问方式）→ 编译不过或读出垃圾<br>' +
                '② <b>格式变了</b>（CompactDex / VDex）→ 能跑但脱出的内容不对<br>' +
                '③ <b>权限/策略变了</b>（hidden API / SELinux）→ 特定调用不生效<br><br>' +
                '本实验里 ' + era.label + ' 的主要变化是：' + era.keys.join('、') + '。'
              : '<b>还没落到具体机制上。</b>试着从这三类里选：<b>结构变了</b> / <b>格式变了</b> / <b>权限策略变了</b>。<br>' +
                era.label + ' 这一代的关键变化是：' + era.keys.join('、') + '。'
          };
        },
        showAnswer:
          '【ART 版本演进速查表】\n\n' +
          '  Android 5.0 (2014)  ART 取代 Dalvik\n' +
          '    · DexFile 结构初次定型 / oat 为主\n' +
          '    · 早期脱壳方案多基于这一代\n\n' +
          '  Android 7.x (2016)\n' +
          '    · JIT + AOT 混合 / 引入 VDex\n' +
          '    · VDex 意味着同一 dex 可能有两份，注意别脱错\n\n' +
          '  Android 8.0 (2017)  ★ 结构大重构\n' +
          '    · DexFile 重构 / ClassLinker 接口调整\n' +
          '    · 2017 年前写的脱壳点几乎全部失效\n\n' +
          '  Android 9 (2018)\n' +
          '    · 引入 CompactDex（cdex）/ 数据与指令分离\n' +
          '    · 必须同时处理两部分，否则 dex 不完整\n\n' +
          '  Android 10 (2019)\n' +
          '    · hidden API 灰/黑名单\n' +
          '    · 反射型 hook 脚本可能被拦\n\n' +
          '  Android 11 (2020)\n' +
          '    · CodeItemDataAccessor 等访问器抽象\n' +
          '    · 直接读字段的代码要改成通过访问器\n\n' +
          '  Android 12 (2021)  ★ 认知转折点\n' +
          '    · ART 模块化（APEX）\n' +
          '    · 【系统版本不再等同于 ART 版本】\n\n' +
          '  Android 13 / 14\n' +
          '    · 延续模块化；14 引入 init_boot 分区\n\n' +
          '【通用排查顺序】\n' +
          '  ① 查 ART 版本（不是 Android 版本）\n' +
          '  ② 按失败形态定位：\n' +
          '     编译不过   → 结构/字段名变了\n' +
          '     读出垃圾   → 字段偏移变了\n' +
          '     脱不出内容 → 脱壳点时机 或 格式变了\n' +
          '     部分缺失   → 可能脱错了副本\n' +
          '  ③ 回目标版本 AOSP 源码看结构体定义',
        hint:
          '先想一个问题：<b>"失效"有很多种形态</b>，不同形态指向不同原因。<br>' +
          '• 代码<b>编译不过</b> → 说明字段名或接口变了<br>' +
          '• 编译过但<b>读出垃圾值</b> → 说明字段偏移变了<br>' +
          '• 能跑但<b>脱不出内容</b> → 说明脱壳点时机不对，或者 dex 格式变了<br><br>' +
          '再想：Android 8 为什么被称为"分水岭"？Android 9 引入了什么新的 dex 格式？',
        after:
          T.note('key', '🔑 这个实验的真正目的',
            '<p style="margin-bottom:0">不是让你背这张版本表——<b>它一定会过期</b>（Android 15、16 还会有新变化）。<br>' +
            '它要建立的是<b>一个诊断框架</b>：<br><br>' +
            '<b>看到"换版本就失效"，先按形态分类：</b><br>' +
            '编译不过 / 读出垃圾 / 脱不出内容 / 部分缺失 —— ' +
            '这四种形态各自指向不同的根因，排查方向完全不同。<br><br>' +
            '然后再问"这个版本改了什么"。<br><br>' +
            '<span class="hit">还有一个必须记住的转折点：' +
            '<b>从 Android 12 起，ART 变成 APEX 模块，系统版本不再等同于 ART 版本。</b>' +
            '"我这是 Android 12" 这句话从此不足以定位 ART 结构——必须查实际的 ART 模块版本。' +
            '这是本章最容易被忽略、但最容易导致"版本对应表全错"的一点。</span></p>')
      }
    },

    /* ================= 26.7C 实战案例 ================= */
    {
      h: '26.7C', title: '实战案例：Android 16 上 FART 为什么会失效——一次工具迁移的完整记录',
      case: {
        source: 'kanxue',
        title: '[原创] 使用 Kimi K3 进行脱壳工具迁移开发：R0DUMP —— 将 FART 迁移到 Android 16',
        date: '2026-7-21',
        author: 'Ivory0',
        target: 'FART / FART 6.0 → LineageOS 23.2 / Android 16；一加 9（代号 lemonade）；三个 DexProtector 样本 com.vietinbank.ipay / com.vnpay.bidv / com.VCB',
        background:
          '<p><b>这个案例在第 16 章已经出现过一次（16.5C），那里看的是「怎么迁移」；这里换一个角度，把同一份材料当作「ART 版本演进的证据」重看一遍。</b></p>' +
          '<p>作者把 FART / FART 6.0 的主动调用链路搬到 <b>LineageOS 23.2 / Android 16</b> 上，重做了一套工具并取名 <b>R0DUMP</b>，' +
          '在<b>一加 9（代号 lemonade）</b>上用三个 DexProtector 样本（<code>com.vietinbank.ipay</code>、<code>com.vnpay.bidv</code>、<code>com.VCB</code>）验证。</p>' +
          '<p>本章 26.6 节的版本表列了「每一代 ART 改了什么」，但表格容易背下来也容易忘掉。' +
          '这次我们要盯住的是一个<b>具体的失效点</b>：<b>copied / obsolete 的 ArtMethod 身上没有有效的 DexFile</b>——' +
          '看清楚这一处是怎么把旧代码打死的，比记住十行版本摘要都有用。</p>',
        points: [
          'FART 原版依赖的引用链：<code>ActivityThread.fartthread()</code> → <code>dexElements</code> → <code>DexFile.getClassNameList(mCookie)</code> → loadClass → <code>DexFile.dumpMethodCode()</code>。',
          '<b>Android 16 的失效点</b>：<b>copied / obsolete 的 ArtMethod 没有有效的 DexFile</b>——旧代码默认「拿到 ArtMethod 就能顺着它摸到 DexFile」，这条链在新版本断了。',
          '作者的适配手段：改用<b>带 cookie 的 <code>dumpMethodCode()</code> 重载</b>，并用 <b>cookie / class descriptor 选 fallback DexFile</b> 兜底。',
          '受控配置走 <code>Settings.Global</code> 的 <code>r0dump.dump.*</code>。',
          '默认策略是 <code>CLASS_WALK|APP_CREATE|ACTIVITY_CREATE|IN_MEMORY_DEX|DEFINE_CLASS</code>，ART 策略位扩到 <b>32 个</b>。',
          '产物经 MediaStore 写到 <code>Download/R0DUMP/&lt;process&gt;</code>，含 <code>methods_&lt;pid&gt;.jsonl</code>、<code>_r0dump_status.json</code>、<code>dexfixed_*.dex</code>。',
          '验证方式：<b>三组样本 repair 后 JADX 可正常加载</b>——证明迁移链路是通的，而不只是「能编译」。'
        ],
        method: [
          '先复述旧链路，确认它到底依赖什么：<code>fartthread()</code> 从 <code>dexElements</code> 取 DexFile，用 <code>getClassNameList(mCookie)</code> 列类，loadClass 触发回填，最后 <code>dumpMethodCode()</code> 落地。',
          '带着这条链去 Android 16 上跑，观察它断在哪一步——断点不是函数改名，而是 <b>copied / obsolete 的 ArtMethod 取不到有效 DexFile</b>。',
          '顺着新版本的接口改，而不是硬扛旧写法：换成带 cookie 的 <code>dumpMethodCode()</code> 重载。',
          '再补一层兜底：用 cookie / class descriptor 选 fallback DexFile，保证拿不到直接线索时还能反查回正确的 DexFile。',
          '把开关收进 <code>Settings.Global</code> 的 <code>r0dump.dump.*</code>，策略位扩到 32 个，默认 <code>CLASS_WALK|APP_CREATE|ACTIVITY_CREATE|IN_MEMORY_DEX|DEFINE_CLASS</code>。',
          '产物改成经 MediaStore 落到 <code>Download/R0DUMP/&lt;process&gt;</code>，并留下 <code>methods_&lt;pid&gt;.jsonl</code> 与 <code>_r0dump_status.json</code> 供回溯。',
          '验证：三个样本产出的 <code>dexfixed_*.dex</code> 经 repair 之后，用 JADX 加载确认可用。'
        ],
        result:
          '<p>三组样本（<code>com.vietinbank.ipay</code>、<code>com.vnpay.bidv</code>、<code>com.VCB</code>）产出的 <code>dexfixed_*.dex</code> 经 repair 之后，' +
          '<b>JADX 都能正常加载</b>。也就是说，「FART 6.0 的引用链在 Android 16 上不成立」这件事被具体定位到了，并且被一条新写法替代掉了。</p>',
        terms: ['FART', 'R0DUMP', 'ArtMethod', 'copied / obsolete ArtMethod', 'DexFile', 'dexElements', 'getClassNameList', 'dumpMethodCode', 'cookie', 'class descriptor', 'Settings.Global', 'MediaStore', 'DexProtector', 'JADX'],
        limits:
          '<p>① <b>最该记的一条是作者自己的约束</b>：<b>「代码里有策略位」不等于「设备上已验证」</b>——' +
          'oat / vdex、JIT、instrumentation 这几条路径并未全部覆盖。代码里写了分支，不代表真机上那条路径被跑通过。</p>' +
          '<p>② <b>设备单一</b>：验证只在一加 9（lemonade）+ LineageOS 23.2 上做过，其他机型、其他 ROM、其他内核未测。' +
          '而本章 26.6 节刚强调过：<b>从 Android 12 起 ART 是 APEX 模块，系统版本不再等同于 ART 版本</b>——' +
          '换一台设备，ART 模块版本可能就不是同一个了。</p>' +
          '<p>③ <b>样本单一</b>：三个样本都是 DexProtector，<b>不能外推到 VMP 或其他壳型</b>。本章的结论没变——遇到 VMP，基于 dex 的脱壳路线直接失效。</p>' +
          '<p>④ <b>同帖姊妹帖正文未抓取，本站不做内容推测</b>：<b>《ART 底层执行链：从 ArtMethod::Invoke 看 FART 在 Android 12–16 为什么失效》</b>' +
          '（thread-292312，2026-8-5，作者 FinSectech）——抓取时只在列表页看到了它的标题、TID、日期与作者，<b>正文内容未获取</b>。' +
          '既然没读到，就不替它总结，也不猜它讲的是哪几处失效点。<span class="hit">这条注记本身就是本章要教的纪律：' +
          '「我看到这个标题」和「我知道它说了什么」是两件事。</span></p>',
        analysis:
          '<p><b>本章 26.6 节给的是一个诊断框架：看到「换版本就失效」，先按形态分类——编译不过 / 读出垃圾 / 脱不出内容 / 部分缺失。' +
          '这个案例是一次真实兑现，而它的失效形态属于最阴的那一类：不是编译不过，是「脱不出内容」。</b></p>' +
          '<p><b>① 失效的具体形态。</b>旧代码的隐含假设是「拿到一个 ArtMethod，就能顺着它摸到 DexFile，然后 dump 出方法体」。' +
          'Android 16 上这个假设不成立了：<b>copied / obsolete 的 ArtMethod 没有有效的 DexFile</b>。' +
          '注意这意味着什么——<span class="hit">这不是「代码写错了」，而是「你以为稳定的那条引用链，在新版本不再成立」</span>。' +
          '代码一行没改、逻辑一步没错，但它脚下的地板被换掉了。<b>这正是本章那张版本表的现实含义：表里那些「结构重构」「访问器抽象」的条目，' +
          '落到工程里就是「某条你以为永远成立的引用链断了」。</b></p>' +
          '<p><b>② 适配的思路：顺着新版本的接口走，而不是硬扛旧写法。</b>' +
          '作者没有去重建一个假的 DexFile、也没有想办法从别处硬凑一个旧结构，而是<b>改用带 cookie 的 <code>dumpMethodCode()</code> 重载，' +
          '并用 cookie / class descriptor 选 fallback DexFile</b>——新版本既然提供了这条路径，就按它的规则把数据要出来。' +
          '这个动作和第 16 章讲的「知识才是护城河」是同一件事：能这么改，前提是他清楚 cookie 是什么、class descriptor 能反查出什么，' +
          '也就是他读得懂 ART 源码。<b>收藏工具的人在等新版本的工具，理解原理的人在按新版本重定位脱壳点。</b></p>' +
          '<p><b>③ 必须区分「能编译」和「已验证」。</b>作者明确写了一句：<b>「代码里有策略位」不等于「设备上已验证」</b>，' +
          '并列出了 oat / vdex、JIT、instrumentation 三条未全覆盖的路径。' +
          '这跟本章反复强调的纪律是同一条：<b>dump 出来的 dex 能在 JADX 里打开，只证明它可反编译，不证明它是完整的</b>——' +
          '工具会在你没覆盖的路径上安静地给出一个不完整的结果。<br>' +
          '<span class="hit">所以工具的完成度要用覆盖率证明，不能用「我写了这个功能」证明。</span>' +
          '写了一个分支，和这个分支在设备上被跑通、被观察到预期行为，中间隔着一整个测试的工程量。</p>' +
          '<p><b>最后一条，关于这份材料的边界。</b>抓取时同帖的姊妹帖（thread-292312）只有标题、TID、日期和作者可见，正文没拿到。' +
          '<b>正确的处理方式就是不写它</b>——不猜它的技术内容，不替它补结论，只在局限里注明「正文未获取」。' +
          '这和上面第 ③ 点是同一条纪律的两面：对工具要说「未验证」，对材料要说「未读到」。' +
          '<b>本课所有案例都按这个标准处理，你读其他资料时也该按这个标准要求作者。</b></p>',
        link: 'https://bbs.kanxue.com/thread-292107.htm',
        linkNote: '看雪论坛原创帖（第 16 章 16.5C 已从「脱壳流程」角度引用过同一篇，此处聚焦版本演进）'
      }
    },

    /* ================= 26.7 ================= */
    {
      h: '26.7',
      title: '决策演练：接到一个从没见过的加固 App',
      html: '<p>现在把时间轴和链路合起来用。第一个情境是<b>最真实的那种开局</b>：甲方丢给你一个 APK，一句「客户说这个 App 用了国外的加固，你三天内给我结果」。</p>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一 · 限时出结果',
            scenario: '<b>情境：</b>你拿到一个 APK，甲方明确说「用了国外的商业加固，具体是什么不清楚」。你只有 <b>3 天</b>。手上有一台 Android 14 的真机（已刷入适配好的 FART14）和一台 Android 10 的测试机。你甚至不确定它是不是 DexProtector。<br><br><b>你的第一个动作是什么？</b>',
            choices: [
              { t: '先花半天做「壳类型判定」：把 APK 丢进反编译器看 dex 是否完整、方法体是否为空、有没有可疑 native 库，再决定路线', next: 'n1' },
              { t: '不管是什么壳，先把 App 装到 Android 14 真机上跑一遍 FART14，看能不能出产物——反正工具已经现成了', next: 'n2' },
              { t: '直接上第 20 章的 VMP 分析思路，先把 native 层和关键算法拆开看', next: 'n3' },
              { t: '先上网搜这个 App 用了什么加固、有没有人写过现成的脱壳脚本，找到再动手', next: 'n4' }
            ]
          },
          n1: {
            label: '选A · 先判类型', terminal: true, verdict: 'good',
            verdictTitle: '正确：先用十分钟的判断，省掉两天的弯路',
            result: '<b>为什么对：</b>脱壳的路线<b>完全</b>取决于壳的类型，而判类型是有明确观察指标的：<br>' +
              '① <b>dex 能不能被正常反编译，方法体是否为空</b>——整体加密但内存里完整 = 一代壳；结构完整、方法体空或被 nop = 抽取壳；<br>' +
              '② <b>APK 里有没有体积异常大的 native 库</b>——是 VMP 的重要嫌疑信号（但要结合其他证据，不能只凭这一点下结论）；<br>' +
              '③ <b>有没有多出来 dex / assets 里的加密数据</b>。<br>' +
              '<b>认知根源：</b>新手总觉得「分析」和「动手」是对立的，先动手显得更勤奋。但脱壳这件事上，<b>路线选错的代价是「干了两天，发现方向根本不通」</b>。十分钟的判类型，是整个流程里性价比最高的十分钟。<br>' +
              '<b>然后怎么做：</b>判定是抽取壳 → 走 FART 主动调用路线；判定是纯一代壳 → 内存 dump 更快；发现 VMP 特征 → 提前和甲方对齐预期，或者直接准备「不脱壳、走黑盒调用/动态 Trace」的备选方案。'
          },
          n2: {
            label: '选B · 直接跑工具', terminal: true, verdict: 'bad',
            verdictTitle: '不算错得离谱，但你会失去判断力',
            result: '<b>为什么不好：</b>「工具已经现成了，先跑一遍」听起来很务实，而且<b>它确实常常能用</b>——但这正是危险之处：<b>你跑出了产物，却不知道产物为什么能出来，也不知道它缺了什么。</b><br>' +
              '具体后果有两条：<br>' +
              '① <b>没有基线就无法判断「脱干净了没有」</b>。抽取壳的产物经常是「有文件、能打开、方法体残缺」。你手上没有「壳类型」这个参照，就看不出残缺，交付一个半成品。<br>' +
              '② <b>失败时你无法定位原因</b>。跑不出结果，你分不清是 FART14 没适配好、是壳有反调试拦住了、还是它根本就是 VMP。<br>' +
              '<b>认知根源：</b>把「工具」当成黑盒，就会把「工具跑通了」当成「任务完成了」。<b>正确姿势不是不跑，而是「先判类型 → 带着预期去跑 → 用预期去核对产物」。</b>一遍跑完，你既拿到了产物，也验证了自己的判断。'
          },
          n3: {
            label: '选C · 直接上 VMP 思路', terminal: true, verdict: 'bad',
            verdictTitle: '越级操作：在没确认之前就假设了最难的情况',
            result: '<b>为什么错：</b>VMP 是加固里<b>最重</b>的手段，成本极高，厂商通常只用在少数核心方法上，不会全量使用。一上来就假设「它是 VMP」，等于<b>用最贵的方案去打一个可能根本不需要它的目标</b>。<br>' +
              '<b>认知根源：</b>这是「技术炫耀型误判」——学了第 20 章的重型武器，就想找地方用它。<b>判断壳类型的第一原则是「从最简单的可能性开始排除」</b>：先看 dex 完整不完整，再看方法体空不空，最后才考虑 VMP。<br>' +
              '<b>正确顺序：</b>判类型应该在<b>前三十分钟</b>内完成，而不是跳过它直接进重武器。<b>如果判定确实有 VMP</b>，那也要先明确范围：是全部关键算法被虚拟化，还是只有一两个校验函数？范围决定了你是「绕过去」还是「硬啃」。'
          },
          n4: {
            label: '选D · 先搜现成方案', terminal: true, verdict: 'bad',
            verdictTitle: '信息检索不是错，把它当第一步才是错',
            result: '<b>为什么不好：</b>搜索本身是必要动作，但<b>把「找到现成脚本」当作前置条件，会让你把三天预算全押在运气上</b>。海外商业加固的针对性脚本，公开资料本来就稀少；而且就算搜到了，它是给哪个加固、哪个安卓版本的，往往不可考。<br>' +
              '<b>认知根源：</b>这是「工具收藏思维」的直接体现——相信存在一把别人配好的万能钥匙。<b>但加固厂商与脱壳工具的博弈是持续的</b>：今天公开的脚本，明天就被针对性对抗掉了。<br>' +
              '<b>正确姿势：</b>搜索应该<b>服务于你的判断</b>——先自己判出壳类型和大版本适配情况，再用搜索去验证「这类壳的公开资料怎么说」，两者互相印证。<b>不要用搜索代替观察，更不要用它代替原理。</b>'
          }
        }
      }
    },

    /* ================= 26.8 ================= */
    {
      h: '26.8',
      title: '决策演练：判定类型之后，路线怎么选',
      html: '<p>第二个情境接着上一个：<b>你已经判定了类型</b>，现在要在路线之间做取舍。这一节刻意把「反直觉」放在正确选项上——<b>本情境的正确答案是「不脱壳」</b>。</p>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境二 · 反直觉的路线选择',
            scenario: '<b>情境：</b>你按上一节的流程做完了判类型，得到三条关键信息：<br>' +
              '① dex 结构完整，但<b>大量方法体是空的</b> → 抽取特征明确；<br>' +
              '② <b>只有两个核心校验方法</b>反编译出来是一堆看不懂的东西，其余方法体填充后都正常 → 疑似 VMP，但<b>范围极小</b>；<br>' +
              '③ 甲方的真实需求是：<b>「我要知道这个 App 的签名是怎么算出来的」</b>——他们要做接口对接，不是要一份完整源码。<br><br>' +
              '<b>你手上的时间是 3 天，今天已经是第 2 天。你选哪条路？</b>',
            choices: [
              { t: 'FART14 全量脱壳，把整个 App 的方法体都 dump 出来，然后修复成完整 dex 再慢慢看那两处', next: 'n1' },
              { t: '不追求完整脱壳：用 FART 的主动调用只针对那两个关键方法，配合动态 Trace 直接抓它的输入输出，反推签名算法', next: 'n2' },
              { t: '既然有 VMP，就按第 20 章的方法把那两个虚拟化的方法完整还原成等价算法', next: 'n3' },
              { t: '先把全部 native 库拖出来丢进 IDA，从那两个方法的 native 实现里找算法', next: 'n4' }
            ]
          },
          n1: {
            label: '选A · 全量脱壳', terminal: true, verdict: 'bad',
            verdictTitle: '技术正确，但目标错位：你回答了一个没被问的问题',
            result: '<b>为什么不好：</b>全量脱壳本身对抽取壳是有效路线，这里错的是<b>优先级</b>。<br>' +
              '① <b>甲方要的是算法，不是源码</b>。全量 dump 之后，你仍然要面对「那两个方法看不懂」的同一堵墙，只是多花了一天去产出一堆你用不到的东西。<br>' +
              '② <b>主动调用是慢的且有损耗</b>。遍历几万个方法逐个执行，耗时以小时计，还可能因为调用失败漏方法、因为异常把 App 搞崩——<b>这些代价换来的产物，对当前目标几乎没有边际价值</b>。<br>' +
              '<b>认知根源：</b>把「脱壳」当成了目的而不是手段。脱壳只是获取信息的一种途径；<b>当目标只需要少量信息时，全量脱壳是昂贵且低效的</b>。<br>' +
              '<b>什么时候它才对：</b>当需求是「完整还原这个 App 的逻辑」时，全量脱壳就是正确路线。<b>路线没有绝对好坏，只有与目标是否匹配。</b>'
          },
          n2: {
            label: '选B · 定向 + 动态 Trace', terminal: true, verdict: 'good',
            verdictTitle: '正确（反直觉）：不追求脱壳，直接拿结果',
            result: '<b>为什么对：</b>这是本章决策框架里最容易被忽略的一条——<b>脱壳不是唯一出路，甚至常常不是最优出路</b>。<br>' +
              '① <b>目标倒推手段</b>：甲方要「签名怎么算」，那么我需要的是 <b>输入 → 输出</b> 的映射关系，而不是方法体的源码。动态 Trace 直接观测这个映射，成本低得多。<br>' +
              '② <b>VMP 恰好最不怕这个打法</b>：VMP 保护的是「方法体不被读懂」，但它<b>不改变方法的输入输出契约</b>——App 自己还得正常调用它、拿到正确签名。所以对 VMP，<b>黑盒观测往往比硬还原更现实</b>。<br>' +
              '③ <b>FART 依然有用，但用法变了</b>：只对目标方法做定向触发 + dump，用来确认「这个方法在哪、参数长什么样」，剩下的交给 Trace。<b>工具是手段的组合，不是单选题。</b><br>' +
              '<b>认知根源：</b>新手把「脱壳」当成必经关卡，觉得不脱壳就是没本事。<b>成熟的判断是：先问「我要的信息，最短路径是什么」，再问「脱壳能不能提供它」。</b>'
          },
          n3: {
            label: '选C · 硬还原 VMP', terminal: true, verdict: 'bad',
            verdictTitle: '方向没错，但时间预算错得离谱',
            result: '<b>为什么不好：</b>还原虚拟化保护是<b>逆向里最耗时的工程之一</b>，通常以周甚至月计。你现在只剩一天多，这条路在时间上直接不成立。<br>' +
              '<b>认知根源：</b>把「技术上的彻底」误当成「工程上的正确」。<b>实战里最重要的一项能力是估算成本</b>：一条路即使理论可行，如果成本超出预算，它对当前任务就等于不可行。<br>' +
              '<b>正确做法：</b>先评估 VMP 的<b>范围与强度</b>——只有两个方法，属于极小范围，这种情况下「绕过」的性价比远高于「还原」。<b>如果甲方后来真的要求算法级还原，那是一个新项目、新预算，而不是在三天里顺手做完的事。</b>把预期提前对齐，是专业性的体现，不是能力不足。'
          },
          n4: {
            label: '选D · 先拖 native 库', terminal: true, verdict: 'bad',
            verdictTitle: '一个看似合理的动作，但顺序反了',
            result: '<b>为什么不好：</b>「拖 native 库进 IDA」本身是必要的分析动作，问题在于<b>你还没有证据说明这两个方法就在 native 层</b>。<br>' +
              '① <b>VMP 不等于 native</b>。虚拟化保护可以是纯 Java 层实现的解释器 + 自定义字节码，也可以是 native 实现，<b>两者在没验证前都只是假设</b>。<br>' +
              '② <b>先拖进去的代价很高</b>。海外加固的 native 库通常带混淆、字符串加密、反调试，进去就是一片沼泽；<b>花半天毫无产出，第三天就没了</b>。<br>' +
              '<b>认知根源：</b>把「熟悉的手法」当成「通用的第一步」。<b>正确顺序是先用最便宜的观测确认「这个逻辑到底在哪一层」</b>——比如 Trace 一下这个方法的调用，看它是否下探到 native；确认了，再决定要不要进 IDA。<b>先定位，再深挖。</b>'
          }
        }
      }
    },

    /* ================= 26.9 ================= */
    {
      h: '26.9',
      title: '决策演练：移植卡住时，往哪里查',
      html: '<p>最后一个情境把镜头拉回本章的主线——<b>移植本身</b>。这是每个做 FART 版本适配的人都会遇到的真实场景：代码编过了，刷进去了，日志却什么都没打。</p>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境三 · 首次移植卡在验证环节',
            scenario: '<b>情境：</b>你在做 Android 10 的 FART 移植。现在状态是：<br>' +
              '① 按这一版源码改过的 ART <b>编译通过了</b>；<br>' +
              '② 产物已经刷入设备，<b>系统正常开机</b>；<br>' +
              '③ 装了一个普通 App 启动它，<code>adb logcat</code> 过滤后 <b>没有任何输出</b>，<code>/sdcard/fart/</code> 目录压根没生成。<br><br>' +
              '<b>你的下一步排查动作是什么？</b>',
            choices: [
              { t: '回到编译配置与刷入路径，确认设备上真正被加载的 ART 到底是不是我编译的那一份', next: 'n1' },
              { t: '先改代码加更多日志，把插桩点前后都打上输出，重新编译一遍再看', next: 'n2' },
              { t: '怀疑是 art 对开机镜像的校验导致改动没生效，去找改机型 / 签名校验绕过的方法', next: 'n3' },
              { t: '换回上一个已知能跑的 FART 版本，先确认设备和流程本身没问题，再回来对比差异', next: 'n4' }
            ]
          },
          n1: {
            label: '选A · 先确认产物真的生效', terminal: true, verdict: 'good',
            verdictTitle: '正确：先证明「我的代码在跑」，再谈它为什么不输出',
            result: '<b>为什么对：</b>排查的第一原则是<b>从最靠近根因、成本最低的假设开始</b>，而「我编译的东西真的被加载了吗」是所有假设里<b>最底层的一个</b>。<br>' +
              '① 如果设备加载的还是系统自带的 ART，那么<b>你后面做的任何代码修改、任何日志埋点，全都不会被观测到</b>——继续改代码就是纯粹的浪费。<br>' +
              '② 验证方式可以是：在插桩代码里放一个<b>启动时必定被打印的无害标记</b>，或者核对设备上对应库文件的属性/校验值与你的编译产物是否一致。<br>' +
              '<b>认知根源：</b>「代码编过了 + 系统能开机」会给人强烈的「已经生效」错觉。但<b>编译成功只证明代码语法正确，刷入成功只证明没把系统搞坏</b>，两者都不证明你的那份二进制正在运行。<b>这是移植类问题最容易踩、也最容易漏掉的一环。</b>'
          },
          n2: {
            label: '选B · 加日志重新编译', terminal: true, verdict: 'bad',
            verdictTitle: '勤奋的弯路：在一堆未知里加更多未知',
            result: '<b>为什么不好：</b>「没输出就加日志」是本能反应，但它有个前提——<b>你得先确定代码真的在跑</b>。在没确认这一点之前加日志，会出现两种结果：<br>' +
              '① <b>新日志也一条不打</b>。此时你面对的是两个未知（代码没生效 / 插桩点选错），信息量反而更低；<br>' +
              '② <b>新日志打了一堆</b>，把你淹没在噪声里，更难定位。<br>' +
              '而且每次加日志都要<b>重新编译 + 重新刷入</b>，单次循环的成本以小时计——<b>用一个高成本的循环去试一个本该先排除的低层假设，是典型的效率陷阱</b>。<br>' +
              '<b>认知根源：</b>把「动作多」等同于「进度快」。排查的正确姿势是<b>按假设的底层程度排序，从最底层往上逐个排除</b>，而不是同时打开所有可能性。'
          },
          n3: {
            label: '选C · 怀疑校验导致改动不生效', terminal: true, verdict: 'bad',
            verdictTitle: '跳到结论：你连「改动是否送达」都还没验证',
            result: '<b>为什么不好：</b>「系统校验拦住了我的改动」是一个<b>具体的、需要证据的假设</b>，而不是可以默认的前提。在还没确认「产物有没有被加载」的情况下直接跳到「去找绕过校验的方法」，等于<b>为一个未经验证的假设去找解法</b>。<br>' +
              '后果是双重的：<b>时间花在了可能根本不需要的工作上</b>；同时你依然没有排除「代码加载了但插桩点选错了」这个更常见的可能。<br>' +
              '<b>认知根源：</b>把「别人的经验帖」当成「我的现场事实」。论坛里确实常见「刷入不生效」的案例，但<b>你的现场是不是同一类问题，必须用自己的观测来判定</b>。<br>' +
              '<b>正确顺序：</b>先确认产物是否被加载（选 A）→ 若已加载却无输出，再检查插桩点是否被走到 → 若确实被系统拦下，才进入绕过校验的环节。'
          },
          n4: {
            label: '选D · 换回旧版本对照', terminal: true, verdict: 'bad',
            verdictTitle: '被「对照实验」的外表骗了：这里根本没有可用的对照组',
            result: '<b>为什么错：</b>「换回已知能跑的版本」听起来像严谨的对照实验，但在本情境里前提就不成立——<b>你想换回的那个旧版本，是为另一个安卓版本做的移植，本来就不能在 Android 10 上跑</b>。<br>' +
              '「已知能跑」只在你原来的那套系统环境里成立，<b>它不是一个可用的对照组</b>。换回去大概率也是没输出，你会得到「新旧都不行」这种毫无信息量的结论，还多花掉几轮刷机时间。<br>' +
              '<b>认知根源：</b>把科学方法的名词当成方法本身。<b>对照实验成立的前提是「只变一个变量」</b>；当对照组本身在你当前平台上就无效时，做对照只是浪费预算。<br>' +
              '<b>正确做法：</b>先确认「当前这份产物有没有被加载」（选 A），把问题域从「整条链路」缩小到一个点上。<b>排除法的价值在于每一步只排除一个未知。</b>'
          }
        }
      }
    },

    /* ================= 26.10 ================= */
    {
      h: '26.10',
      title: '实战：FART14 秒脱 DexProtector，与「新壳方法论」',
      html: '<p>回到本章标题里的实战。<b>DexProtector 是国外知名的商业加固方案</b>（由波兰的安全公司开发，被大量海外 App 采用），保护强度高、实现闭源、公开资料有限。所以下面这张表要读得小心：<b>左列写的是「这类商业加固通常具备的能力」，不是「DexProtector 内部一定如何实现」</b>——它的具体机制我们没有可靠依据，不做臆测。<b>这张表的用途是训练你的应对思路，而不是当它的产品说明书。</b></p>' +
            '<p>读表前先对齐三个词的用法：' + T.term('VMP', '虚拟化保护。把关键方法的原始指令翻译成自定义字节码，由内置解释器执行。此时方法体不再是 dex 指令，基于 dex 的脱壳工具会直接失效——需改用第 20 章的技术，或走动态 Trace 绕过。') + '指「关键方法被翻译成自定义字节码」，它和「方法体被抽走」是两种不同的问题；' + T.term('主动调用', 'FART 的核心机制：遍历所有方法并逐个强制执行，用「必须执行就必须有方法体」这一因果，逼迫 ART / 壳把被抽取的 code item 回填到内存，再趁机 dump。调用是手段，回填才是目的。') + '是 FART 对付抽取壳的手段；' + T.term('秒脱', '面对一个新壳 App 时几分钟内拿到产物。快的来源不是技术简单，而是「适配目标系统版本」这项前期工作已经提前完成。') + '则描述了前期投入兑现之后的状态。</p>' +
            T.tbl(
              ['保护能力（商业加固的常见手段）', '它想让你卡在哪', '应对思路（方法论，非具体实现）'],
              [
                ['<b>dex 加密 + 运行时解密</b>', '静态打开 APK 时看不到真实 dex', '承认这一点：<b>静态不行就转运行时</b>。在内存里等它解密完成的那一刻做 dump —— 这也是一代壳的经典解法'],
                ['<b>抽取壳（方法体抽取）</b>', 'dump 出来的 dex 结构完整但方法体为空，让你以为「脱成功了」', '<b>必须主动调用触发回填</b>：这正是 FART 主动调用循环存在的理由。同时在验证阶段坚持「反编译看方法体」，不接受「有文件就算成功」'],
                ['<b>VMP（关键方法虚拟化）</b>', '核心方法体不再是 dex 指令，基于 dex 的脱壳手段整体失效', '识别出来就别硬扛：<b>要么上第 20 章的技术，要么走「不脱壳、直接黑盒调用/动态 Trace 拿输入输出」</b>。范围评估决定选哪条'],
                ['<b>反调试 / 反 Frida</b>', '你的注入与 Hook 一挂上去就被发现，App 主动退出或行为异常', '环境对抗是独立课题（见第 15 章）。要点：<b>先确认「是被反调试拦了」还是「我的工具本身有问题」</b>，两者的排查方向完全不同'],
                ['<b>完整性校验</b>', 'APK 被改过、内存被改过就拒绝运行', '改包常常行不通 → <b>尽量不改原文件，改用运行时观测</b>；或先定位校验点再决定处理方式'],
                ['<b>字符串 / 常量加密</b>', '反编译出来一堆无意义字符串，看不出逻辑', '运行时 dump 或动态观测；这也是「脱壳」之外的独立战场，工具与思路都不同'],
                ['<b>针对脱壳工具的对抗</b>', '让你的工具跑不起来 / 产物残缺', '<b>这是持续博弈，不是一次胜负</b>。所以能力必须建立在原理上：工具被封了，你还能回源码重新找脱壳点']
              ]
            ) +
            T.note('key', '🔑 遇到一个新壳时的决策框架（本章最终产出）', '<p>把全章内容压缩成四步，<b>这四步对任何没见过的壳都适用</b>：</p>' +
              '<p><b>① 判类型</b> —— dex 能否正常 dump 出来（一代壳）？方法体是否为空（抽取壳）？关键方法是否为看不懂的自定义字节码（VMP 嫌疑）？<b>这一步必须在前 30 分钟内完成。</b></p>' +
              '<p><b>② 选路线</b> —— 一代壳 → 内存 dump；抽取壳 → 必须主动调用触发回填（FART）；有 VMP → 第 20 章技术，或干脆不脱壳、走动态 Trace 绕过。</p>' +
              '<p><b>③ 没有现成工具时</b> —— 回到 ART 源码，按 26.5 节的六步链路自己找脱壳点。<b>这就是「会读源码」的兑现时刻。</b></p>' +
              '<p><b>④ 实在脱不掉</b> —— 换思路：不脱壳，直接黑盒调用（见第 21 章 unidbg）或动态 Trace 抓输入输出。<b>目标是拿到结果，不是完成脱壳这个动作。</b></p>' +
              '<p>这四步的价值在于：<b>它把「我该怎么办」从一个焦虑问题，变成了一个有顺序的判断题。</b></p>') +
            T.note('ok', '✅ 回到「秒脱」', '<p>为什么课程能演示「用 FART14 快速脱掉 DexProtector」？因为 <b>Android 14 的适配工作在演示之前就已经做完了</b>（26.5 节的六步，一步不少）。演示现场剩下的只是：装 App → 触发它跑起来 → 等主动调用循环走完 → 取产物 → 反编译验证。</p>' +
              '<p><b>这个顺序请你反过来读一遍：如果那六步没做，现场就是另一幅景象</b>——你会盯着一个没输出的 logcat，在三天里反复重编译。所谓「秒脱」，是前期投入的利息，不是技术难度的证明。</p>',
              '<p class="small muted">补充说明：本节刻意不描述 DexProtector 的内部实现细节。对这些闭源商业方案，可靠的做法是<b>用自己的观测去判定它这一版用了哪些手段</b>，而不是拿网上的传闻当事实——<b>这一点本身就是本章方法论的一部分</b>。</p>'),
      quiz: {
        id: 'q12-1', chapter: 12, answer: 2,
        stem: '某加固 App 脱壳后，用反编译器打开 dump 出来的 dex：类名、方法名、字段都齐全，但<b>超过一半的方法点进去是空的</b>（没有指令）。最合理的判断与对策是？',
        options: [
          { t: 'dump 失败了，dex 没抓完整 —— 应该调整 dump 时机，抓得更早一点', why: '方向反了。如果 dex 没抓完整，缺失的会是整个类甚至整段数据，而不是「结构齐全、唯独方法体为空」这种规整的缺失。' },
          { t: '这是 CompactDex 格式，需要先做格式转换才能正常反编译', why: 'CompactDex 影响的是指令的编码方式，会出现反编译乱码/报错，而不是「方法体为空」。这是把两种不同症状混为一谈。' },
          { t: '这是抽取壳：加壳时方法体就被抽走了，没被执行过的方法还没回填 —— 应该用主动调用把方法逐个触发，逼它回填后再 dump', why: '正确。「结构完整但方法体为空」是抽取壳的典型指纹：它保留了 dex 的骨架（类名方法名），抽走的只有 code item。而壳只在方法真正要执行时才填回去，所以被动 dump 拿不到。' },
          { t: '这是 VMP：方法体被虚拟化了，所以看不到指令 —— 应该按第 20 章的方法还原虚拟化', why: '过度判断。VMP 通常只覆盖少数关键方法，不会出现「一半方法都是空」的分布。而且 VMP 的方法体不是「空」，是自定义字节码。' }
        ],
        explain: '<b>「结构完整、方法体为空」是抽取壳的指纹。</b>加固厂商在加壳阶段把方法体（code item）从 dex 里抽走，只留结构；App 运行时，壳在方法真正要执行的前一刻才把方法体解密填回内存。<br><br>' +
          '这条因果直接决定了脱壳策略：<b>你没法「等」它——因为 App 的启动路径只覆盖一部分方法</b>，剩下的大量方法可能永远不被执行，也就永远不会回填。所以 FART 设计的核心就是<b>主动调用</b>：遍历所有类、所有方法，逐个强制执行，用「要执行就必须有方法体」这个硬约束逼 ART / 壳把 code item 填回来，然后立刻 dump。<br><br>' +
          '顺带记住两种「看似相似、其实不同」的症状：<b>CompactDex</b> → 反编译乱码或报错（编码问题）；<b>VMP</b> → 少数关键方法是看不懂的自定义字节码（语义问题）。<b>把症状和成因对上，才不会拿着 A 的方案去治 B 的病。</b>'
      }
    },

    /* ================= 26.11 ================= */
    {
      h: '26.11',
      title: '自测：版本演进的两道判断题',
      html: T.note('', '📝 这两题问的是「为什么会这样」，不是「是什么」', '<p>如果你前面只是把时间轴看了一遍，这两题会有点难；如果你真的理解了「脱壳点依附于 ART 内部结构」这条因果，它们应该是直接推出来的。</p>'),
      quiz: {
        id: 'q12-2', chapter: 12, answer: 1,
        stem: '你为 Android 10 移植好的 FART，在 Android 14 设备上刷入后：系统能正常开机、日志里有你加的启动标记、脱壳流程却<b>在遍历到方法那一步就崩了</b>。最合理的解释是？',
        options: [
          { t: 'Android 14 的反调试机制发现了 FART，主动把进程杀掉了', why: '与现象不符。反调试通常表现为 App 退出或行为异常，而不是「遍历到方法这一步崩在系统 ART 里」；何况这时崩的往往是系统进程。' },
          { t: 'FART 的遍历逻辑直接依赖 ArtMethod 的内存布局，而这个结构在 10→14 之间持续演进（例如部分信息被移到辅助访问结构里），旧代码取方法体的方式已经不成立', why: '正确。这正是「为什么必须持续维护」的最直接体现：加载路径、类链接接口还能靠语义重新定位，但取方法体这一步是拿内存布局说话的，布局变了就必须改用新的访问方式。' },
          { t: 'Android 14 开始禁止第三方代码访问 /sdcard，所以是写文件权限的问题', why: '症状不符。权限问题会在写文件时报错，而不会导致在「遍历方法」这一步崩溃；而且存储权限是应用层问题，与 ART 内部遍历无关。' },
          { t: 'dex 文件格式在 Android 14 变了，导致解析类定义时崩掉', why: 'dex 格式相对稳定，「遍历到方法这一步才崩」也不符合解析阶段崩溃的特征——崩点已经越过了 dex 解析，进入运行时结构。' }
        ],
        explain: '<b>关键在于分清「哪一步依赖什么」。</b>主动调用循环有三层：遍历 DexFile、遍历 ClassDef、遍历方法并取方法体。前两层的接口即使改名重构，你还能<b>按语义</b>在新源码里重新找到（比如「谁负责把 dex 里的类变成可调用的类」）；<b>但第三层是直接读 ArtMethod 的内存布局</b>——这个结构从 Android 10（为 hidden API 策略调整）到 Android 11+（部分信息移到 <code>CodeItemDataAccessor</code> 一类辅助结构，<span class="pill warn">名称待核实</span>）一直在变。<br><br>' +
          '所以「崩在遍历方法那一步」这个现象本身就是一条强线索：<b>它精确地指出了你这次移植失败的位置——接口层你可能是对的，结构层你没有对齐。</b><br><br>' +
          '<b>更重要的推论：</b>这不是「你运气不好碰上了 Android 14」，而是<b>必然会发生的事</b>。任何依赖 ART 内存布局的工具，只要系统还在演进，就必须持续维护。这就是本章反复强调「FART 是要维护的项目，不是成品」的原因。'
      }
    },

    /* ================= 26.12 ================= */
    {
      h: '26.12',
      title: '自测：动手顺序与「秒脱」的本质',
      quiz: {
        id: 'q12-3', chapter: 12, answer: 3,
        stem: '第一次移植 FART 到 Android 10，下面哪种做法最可能让你在有限时间里定位到问题？',
        options: [
          { t: '一次性把三个组件（dex dump / 主动调用 / 修复）全改完，再整体编译刷入一次看结果', why: '看起来高效，实际是最糟的顺序。三个组件同时改动，一旦没结果，你面对的是三个未知叠加，日志里任何一条都可能是假线索。' },
          { t: '先把修复组件写完善，确保 dump 出来的东西一定能合并成可反编译的 dex', why: '优先级错了。修复组件对应的是「产物处理」，是三个组件里最稳的一块（dex 格式相对稳定），也是唯一在没拿到有效 dump 之前无法验证的一块。' },
          { t: '先跑通 dex dump，能看到完整 dex 落盘，就说明移植基本成功', why: '把「dex dump 成功」等同于「移植成功」是本章最想破除的错觉。对抽取壳而言，dump 出来的 dex 结构完整、方法体为空，离可用还差最关键的一步。' },
          { t: '按「编译通过 → 遍历跑通 → 取到方法体」的依赖顺序分阶段验证，每个阶段都有独立的成功标志', why: '正确。这三个阶段恰好对应「接口层 → 逻辑层 → 结构层」三层依赖，逐层推进时每一步只有一个未知，出问题能立刻定位。' }
        ],
        explain: '<b>移植要按依赖层次分阶段，而不是按功能模块分。</b>从 26.4 节的循环可以读出清晰的三层：<br><br>' +
          '<b>第一层·接口层：</b>枚举 DexFile、ClassLinker 接口、各种访问器的签名。这层的成功标志是<b>代码能编过</b>——最便宜、也最该先解决，因为它拦着你验证后面任何东西。<br>' +
          '<b>第二层·逻辑层：</b>遍历能不能真的走完，能不能看到类和方法的数量符合预期。标志是<b>日志能打印出遍历进度</b>。这一层不涉及内存布局，靠语义重定位就能搞定。<br>' +
          '<b>第三层·结构层：</b>能不能从方法拿到正确的 code item。标志是<b>dump 出的方法体是真的指令</b>，而不是空数组。<b>这层最难，因为它直接踩在 ArtMethod 的布局上。</b><br><br>' +
          '<b>反向做法为什么致命：</b>如果你一次改完三个组件再刷机，失败时你这三层全都处于未知状态。而每一次「改代码 → 编译 → 刷入 → 验证」的循环成本是以小时计的——<b>在有限时间里，你的循环次数就是最稀缺的资源，必须让每次循环只排除一个未知。</b>'
      }
    },

    /* ================= 26.13 ================= */
    {
      h: '26.13',
      title: '自测：把「秒脱」的账算清楚',
      quiz: {
        id: 'q12-4', chapter: 12, answer: 1,
        stem: '课程演示用 FART14 在几分钟内脱掉了一个 DexProtector 加壳的 App。关于这件事，下面哪个理解是正确的？',
        options: [
          { t: '说明 DexProtector 的保护强度不如国产加固，所以能被快速脱掉', why: '把「快」归因于「目标弱」是最省事的解释，但也是错的。这属于臆测对手的实现与强度，而这个结论没有任何观测支持。' },
          { t: '「几分钟」只覆盖了运行脱壳工具这一段；适配 Android 14（读源码、重定位脱壳点、编译刷入验证）的前期投入是以天/周计的，只是它发生在演示之前', why: '正确。这是本章最有价值的认知：秒脱是前期投入的利息。前期工作（尤其是「在 ART 源码里重新找到脱壳点」）才是真正的技术活。' },
          { t: '因为 FART 是一次性写好的通用工具，一次适配就能长期使用', why: '与本章主线完全相反。FART 每个安卓大版本都要重新移植，这正是 Android 8 / 9 / 10 / 11+ / 12-14 那条时间轴要说明的事。' },
          { t: '因为脱壳本质上是自动化流程，理解了原理之后工具会自动适配新版本', why: '归因错误。工具不会自动适配——ART 内部结构一变，插桩点就失效。每次适配都需要有人去读那一个版本的源码重新定位。' }
        ],
        explain: '<b>把「秒脱」的账算清楚，是本章的收束。</b><br><br>' +
          '演示现场你看到的是：装 App → 启动 → 主动调用循环跑完 → 取产物 → 反编译。这部分确实只要几分钟。<br>' +
          '但你没看到的是之前发生的事：<b>确定目标版本、下载对应 AOSP 源码、读 ART 源码重新定位 dex 加载点与 code item 回填点、把三个组件的插桩挪过去对齐、编译、刷入、反复验证</b>——这就是 26.5 节的六步链路，以天甚至周计。<br><br>' +
          '<b>所以正确的结论有两层：</b><br>' +
          '① <b>技术难度没有消失，只是被前置了。</b>「秒脱」不是「简单」，而是「难的部分已经做完了」。<br>' +
          '② <b>这个前置投入会过期，但能力不会。</b>FART14 只对 Android 14 那一档有效，下一个大版本到来时又要重来一遍；可每一次重来，你依赖的都是同一套能力——<b>读 ART 源码、找到语义事件、重新定位脱壳点</b>。这套能力从 Android 6 用到 14，大概率还能再用十年。<br><br>' +
          '<b>这就是本章最想留给你的一句话：逆向的护城河在于原理理解，不在于工具收藏。</b>收藏工具的人，每次系统升级都要重新找工具；理解原理的人，每次系统升级只是重新做一遍他早就会做的事。'
      }
    }
  ],
  glossary: [
    { t: 'FART', d: '基于 ART 的安卓脱壳工具，核心由三块组成：dex 文件 dump、code item dump（含主动调用）、修复组件。原始实现基于 Android 6.0，后续版本由社区与个人持续移植。' },
    { t: 'ART 移植', d: '把为某个安卓版本编写的 ART 内部插桩代码，适配到另一个版本上的过程。本质工作是读对应版本 AOSP 源码、重新定位脱壳点、对齐接口与结构、重新编译刷入。' },
    { t: '脱壳点', d: '插桩代码所依附的 ART 内部位置。不是一个固定函数名，而是一个语义事件——例如「dex 加载完成」「方法体 code item 回填完成」。函数名随版本变，语义事件不变。' },
    { t: 'CompactDex', d: 'Android 9 引入的 dex 变体，为节省内存而优化，指令操作数被重新编码。若 dump 到的是它，需要额外转换处理，否则产物无法正常反编译。' },
    { t: 'CodeItemDataAccessor', d: 'Android 11+ 一类用于访问方法体（code item）的辅助结构 <span class="pill warn">名称与职责待核实</span>。它标志着 ART 把内部字段逐步封装、不再允许直读的趋势。' },
    { t: '主动调用（invoke）', d: 'FART 的核心机制：遍历所有方法并逐个强制执行，用「必须执行就必须有方法体」这一因果，逼迫 ART / 壳把被抽取的 code item 回填到内存，再趁机 dump。' },
    { t: '抽取壳', d: '加壳时把方法体从 dex 中抽走，只在方法真正执行前由壳解密填回。它的 dex 结构完整（类名、方法名都在），但方法体为空 —— 因此必须先触发回填才能脱。' },
    { t: 'VMP（虚拟化保护）', d: '把关键方法的原始指令翻译成自定义字节码，由内置解释器执行。此时方法体不再是 dex 指令，基于 dex 的脱壳工具会直接失效，需改用第 20 章的技术或走动态 Trace 绕过。' },
    { t: 'DexProtector', d: '国外知名商业加固方案，保护手段通常包括 dex 加密、抽取、方法虚拟化、反调试、完整性校验、反 Frida 检测等。实现闭源，公开资料有限，具体内部机制不可臆测。' },
    { t: '秒脱', d: '指面对一个新壳 App 时几分钟内拿到产物。快的来源不是技术简单，而是「适配目标系统版本」这项前期工作已经提前完成。' },
    { t: 'init_boot 分区', d: 'Android 12 引入的分区变化，ramdisk 的归属发生调整，导致刷入方式随之改变 —— 属于「只有交付方式变了、插桩逻辑不用动」的那一类版本演进。' },
    { t: '前期投入 vs 后期效率', d: '本章的核心认知模型：读源码、找脱壳点、适配编译是以天/周计的投入，且会随版本过期；但由此获得的原理理解可以迁移，换来的是面对新壳时的分钟级效率。' }
  ],
  teacher: {
    id: 'ch12', chapter: 12,
    name: '追问老师 · 第 26 章',
    sub: '拷问你对「版本演进」与「脱壳点重定位」的理解是否真的成立',
    intro: '<p style="margin:0">这一章最容易产生一种虚假的掌握感：看完了时间轴、看懂了对照表，就以为「我会移植 FART 了」。下面五个问题会逐步逼你回到原理层——尤其后两题，如果你只会背「Android 10 改了 ArtMethod」，是答不上来的。</p>',
    questions: [
      {
        id: 'c12q1', depth: 1, threshold: 0.7,
        q: '为什么一个在 Android 10 上跑得好好的 FART，换到 Android 14 上就不工作了？请从「脱壳点是怎么确定的」这个角度回答。',
        concepts: [
          { label: 'ART 内部结构随版本持续演进', hint: 'ART 本身是活的代码，它每个大版本都在动吗？', any: ['ART 内部结构', '内部结构', '结构变化', '结构变了', '版本差异', '持续演进', '不断变化', '每个版本都在变', '源码变化', '结构演进', 'art 变了', 'art 在变'] },
          { label: '脱壳点必须重新定位', hint: '插桩的位置是由什么决定的？那个东西变了会怎样？', any: ['脱壳点', '重新定位', '重新找', '插桩点', 'hook 点', 'hook点', '定位脱壳点', '重定位', '找点位', '插桩位置', '重新插', '点位变了'] },
          { label: 'FART 是插进 ART 内部的探针，依赖运行时结构', hint: 'FART 不是独立进程，它是嵌在哪里的代码？', any: ['插桩', '探针', '依赖 ART', '依赖art', '嵌入', '运行时结构', '插进 ART', '侵入', '改 art', '改源码'] },
          { label: '所以要读对应版本的 AOSP 源码', hint: '那你怎么知道新版本该插在哪里？', any: ['AOSP', 'aosp', '源码', '读源码', '看源码', 'art 源码', 'source', '对着源码'] }
        ],
        hints: [
          '先想清楚：FART 的代码是「跑在 ART 外面」还是「嵌在 ART 里面」？',
          '插桩的位置不是一个固定地址，它是被什么决定的？那个东西在版本之间稳定吗？'
        ],
        probes: [
          '你说要重新定位脱壳点——那具体要找的是什么？是一个函数名，还是别的东西？',
          '如果原来的函数改了名、甚至搬到了别的文件里，你怎么在新源码里把它认出来？'
        ],
        model: 'FART 不是一个跑在 App 外面的独立工具，它是<b>嵌进 ART 运行时里面的一段插桩代码</b>：在 dex 加载完成的那个点上把完整 dex 落盘，在方法体（code item）回填的那个点上把它 dump 出来。所以「脱壳点插在哪里」这件事，<b>完全由 ART 的内部结构决定</b>——不是由 FART 的作者决定的，也不是由一个可以背下来的地址决定的。<br><br>' +
          '而 ART 的内部结构，从 Android 5 到 14 就没有停过。可以粗分为几种变化类型：<b>加载路径变了</b>（Android 8 的 DexFile 结构重构、ClassLinker 接口调整；Android 10 出现新的 dex 加载路径）——原来 hook 的那个函数可能改名、换签名、甚至搬家；<b>结构布局变了</b>（Android 10 为支持 hidden API 策略调整 ArtMethod；Android 11+ 把部分信息移到 CodeItemDataAccessor 一类的辅助结构里）——原来直接读字段的写法直接失效；<b>产物格式变了</b>（Android 9 引入 CompactDex，指令操作数被重新编码）——dump 出来的东西不再是标准 dex；<b>只有交付方式变了</b>（Android 12 引入 init_boot 分区）——插桩逻辑不用动，但刷入方式要改。<br><br>' +
          '所以「FART 10 换到 14 就不工作」不是运气问题，<b>是必然</b>。这也正是移植的本质工作：<b>打开对应版本的 AOSP 源码，找到「dex 什么时候加载完」「方法体什么时候回填」这两个语义事件在这一版代码里的位置，把插桩挪过去。</b>版本会变、名字会变，但这两个问题是永恒的——会问这两个问题的人，永远能在新版本上重建 FART。',
        after: '<p>如果你只答出「ART 变了所以要改」，那是一句废话；<b>真正要能说出的是「变的是哪一层，所以我要重新找的是什么」</b>。</p>'
      },
      {
        id: 'c12q2', depth: 1, threshold: 0.7,
        q: 'FART 的核心组件可以拆成三块。请说出这三块分别是什么，并指出<b>哪一块的版本差异最大、为什么</b>。',
        concepts: [
          { label: 'dex 文件 dump（在加载完成处落盘完整 dex）', hint: '第一块负责把什么完整地拿出来？在什么时机？', any: ['dex 文件 dump', 'dump dex', 'dex dump', 'dex文件', '整体 dump', '导出 dex', '内存 dump', '第一块', '①'] },
          { label: 'code item dump（含主动调用）', hint: '第二块要拿到的是「方法」的哪一部分？靠什么手段？', any: ['code item', 'codeitem', '方法体', '主动调用', 'invoke', '遍历方法', '方法 dump', '第二块', '②'] },
          { label: '修复组件（合并回 dex、修正头与 map 段）', hint: 'dump 出来的碎片怎么变成能反编译的成品？', any: ['修复', '修复组件', '合并', '文件头', 'map 段', 'map段', '重建 dex', '修正', '第三块', '③'] },
          { label: '主动调用那一块版本差异最大，因为它直接依赖 ArtMethod 的内存布局', hint: '哪一块必须「直接读内存里的结构体字段」？', any: ['ArtMethod', 'artmethod', '方法体那块', '最不稳定', '版本差异最大', '内存布局', '主动调用那块', '取方法体'] }
        ],
        hints: [
          '三块分别解决三个不同的问题：整体在哪、方法体在哪、碎片怎么拼回去。',
          '同样是插桩，有的地方只是调用一个接口，有的地方要直接读结构体字段——哪种更脆弱？'
        ],
        probes: [
          '你说第二块最难——具体难在「遍历」这一步，还是难在「取方法体」这一步？',
          '如果只能先让一块跑通，你会先让哪一块跑通？为什么？'
        ],
        model: 'FART 的三块组件，对应脱壳要回答的三个问题：<br><br>' +
          '<b>① dex 文件 dump</b>——回答「整体在哪」。在 DexFile 完成映射/加载的那个点上，把内存里结构完整的 dex 落盘。需要适配的是 DexFile 的构造、Open 系列方法，或者这一版新的加载入口（随版本变化）。<br><br>' +
          '<b>② code item dump（含主动调用）</b>——回答「方法体在哪、怎么拿到」。遍历所有类与所有方法，逐个触发调用以强制回填，然后 dump 方法体。需要适配三件事：怎么遍历 DexFile 里的 ClassDef、怎么拿到方法的 code_item、以及 <b>ArtMethod 的字段布局</b>。<br><br>' +
          '<b>③ 修复组件</b>——回答「碎片怎么拼回去」。把 dump 出的方法体合并回 dex，修正文件头与 map 段，产出反编译器能打开的成品。dex 格式本身相对稳定，但 CompactDex 这类变体需要额外处理。<br><br>' +
          '<b>版本差异最大的是 ②，因为它直接踩在 ArtMethod 的内存布局上。</b>① 依赖的是「加载路径」，路径再改，你要找的语义事件（dex 加载完成）总归只在少数几个地方；③ 依赖的是 dex 格式规范，那是公开且稳定的东西。<b>只有 ② 是拿内存里结构体的字节布局说话的</b>——而 ArtMethod 从 Android 10（为 hidden API 策略调整）到 Android 11+（部分信息移到 CodeItemDataAccessor 一类辅助结构）一直在动。<br><br>' +
          '<b>实用推论：移植时把大部分时间留给 ②。</b>典型失败场景不是「dump 不出 dex」，而是「dex dump 出来了，方法体全是空的」。'
      },
      {
        id: 'c12q3', depth: 2, threshold: 0.75,
        q: 'FART 为什么要费大力气去「主动调用」每一个方法？为什么不能等壳自己把方法体解密好，然后被动 dump？',
        concepts: [
          { label: '抽取壳只在方法真正执行前才回填方法体', hint: '壳把方法体抽走后，是什么时候、因为什么原因才把它填回去？', any: ['抽取', '抽取壳', '按需', '用到才解密', '执行前', '回填', '懒加载', '延迟解密', '要用才填', '被动'] },
          { label: '没被执行的方法永远不会回填', hint: 'App 启动路径会覆盖到全部方法吗？', any: ['不执行', '没执行', '未执行', '永远不会', '不会被调用', '启动路径', '覆盖率', '跑不到', '走不到', '用不到'] },
          { label: '主动调用强制触发回填', hint: '既然等不到，那就只能怎么办？', any: ['主动调用', 'invoke', '强制执行', '遍历调用', '逼它', '触发', '全量调用', '挨个调用'] },
          { label: '调用是手段，回填才是目的', hint: '你调用这些方法，是为了执行 App 的业务逻辑吗？', any: ['手段', '目的', '副作用', '目的不是执行', '不是为了执行', '只为触发', '不关心结果'] }
        ],
        hints: [
          '壳不是「一次性把方法体全解密」，它是「什么时候需要，什么时候解密」——那没被需要的方法会怎样？',
          '你现在被动等它，等价于赌「App 会执行到所有方法」，这个赌注成立吗？'
        ],
        probes: [
          '如果某个方法被调用了但抛了异常，它算不算「已经回填」？这对你的 dump 完整度意味着什么？',
          '主动调用循环的复杂度是「类数 × 方法数」，这意味着什么代价？这个代价换来了什么？'
        ],
        model: '<b>因为你要脱的是抽取壳，而抽取壳的解密是「按需」的。</b><br><br>' +
          '先用一个反例把问题说清楚：如果是<b>一代壳</b>（整体加密、启动时一次性解密到内存），那么内存里那份 dex 结构完整、方法体齐全，你确实可以被动 dump，什么都不用做。但<b>抽取壳</b>不同：加固厂商在加壳阶段就把方法体（code item）从 dex 里抽走了，dex 只剩下骨架——类名、方法名、字段都在，<b>唯独方法体是空的</b>。壳只在某个方法<b>真正要执行的前一刻</b>，才把它的方法体解密填回内存。<br><br>' +
          '<b>这个机制决定了被动等待必然失败。</b>因为 App 启动时只会执行到一部分方法——那些冷门方法、异常分支、还没被触发到的功能路径，它们的 code item 永远不会回填。你等得再久，dump 出来的也是一份「有文件的空壳」。<br><br>' +
          '<b>FART 的破法是把因果反过来用：</b>既然「方法要执行，就必须有方法体」，那我就<b>主动把每个方法都调用一遍</b>，用强制执行这个硬约束，逼 ART / 壳不得不把 code item 填回来。注意这里最重要的一点——<b>调用是手段，回填才是目的</b>。你根本不关心方法执行出什么结果，甚至不关心它抛不抛异常，你只要那个副作用：方法体出现在内存里。这也正是主动调用比「先找到壳的解密函数、再想办法调它」更工程化的地方：<b>你不需要理解壳的加密算法，你只需要让它不得不干活。</b><br><br>' +
          '代价也很明确：三层循环意味着「类数 × 每类方法数」量级的调用次数，一个中等 App 就是几万次，耗时可观，而且调用失败或异常会被漏掉——这也解释了为什么脱完的 dex 里常有几个方法仍然反编译不出来。',
        after: '<p>反过来记：<b>如果你看到的现象是「dex 完整但方法体大量为空」，那么「主动调用」就是唯一的正解</b>，而不是去调整 dump 时机。</p>'
      },
      {
        id: 'c12q4', depth: 2, threshold: 0.75,
        q: '甲方丢给你一个从没见过的加固 App，只给你三天，要求「搞清签名算法」。请说出你的决策顺序，以及你会先做什么、为什么。',
        concepts: [
          { label: '先判壳的类型（一代壳 / 抽取壳 / 有无 VMP）', hint: '路线完全取决于壳的类型，那第一步该干嘛？', any: ['判类型', '判断类型', '先判断', '壳类型', '分类', '判定', '识别', '是什么壳', '判断壳'] },
          { label: '判类型的观察指标：dex 能否 dump、方法体是否为空、关键方法是否是自定义字节码', hint: '你靠什么现象来判断它属于哪一类？', any: ['方法体为空', '空的', 'dex 完整性', '能否 dump', '自定义字节码', '虚拟化', 'vmp 特征', '观察', '指标', '现象'] },
          { label: '按目标倒推路线，不一定非要脱壳', hint: '甲方要的是「算法」还是「一份完整源码」？', any: ['目标', '需求', '倒推', '不一定要脱壳', '不一定脱壳', '黑盒', '拿结果', '输入输出'] },
          { label: '走不通就换思路：黑盒调用 / 动态 Trace 抓输入输出', hint: 'VMP 让脱壳失效时，还有什么不吃方法体源码的打法？', any: ['unidbg', '黑盒', '动态 trace', 'trace', '不脱壳', '绕过', '输入输出', '抓参数', '观测'] }
        ],
        hints: [
          '三条路线的成本差一个数量级，而选路线的依据只有一个——它是什么壳。',
          '再想一遍甲方那句话：他们需要的是「方法体源码」还是「一个可以复现的输入输出关系」？'
        ],
        probes: [
          '你说先判类型——判类型要花多久？如果半小时内判不出来怎么办？',
          '如果判定它只有两个关键方法被虚拟化，其余都是普通抽取，你会改路线吗？为什么？'
        ],
        model: '<b>决策顺序是四步：判类型 → 选路线 → 没工具就回源码 → 实在不行换思路（不脱壳）。</b><br><br>' +
          '<b>第一步，判类型（必须在前 30 分钟内完成）。</b>这是全流程性价比最高的半小时，因为三条路线的成本差一个数量级，而选路线的唯一依据就是壳的类型。观察指标很具体：把 APK 丢进反编译器看 dex 是否完整、方法体是否为空（结构完整 + 方法体空 = 抽取壳）；看有没有体积异常大的 native 库、关键方法是不是一堆看不懂的自定义字节码（VMP 的嫌疑信号）；看资源里有没有多出来的加密数据。这一步做错，代价是「干了两天发现方向不通」。<br><br>' +
          '<b>第二步，按目标倒推路线。</b>这里有个关键点：<b>先把甲方的需求翻译清楚</b>。他要的是「签名怎么算」，那就意味着你需要的是<b>输入到输出的映射关系</b>，而不是方法的源码。这个翻译会彻底改变你的路线——如果只有两个关键方法可疑，FART 对这两个方法做定向触发 + 动态 Trace 抓输入输出，往往比全量脱壳快得多，而且<b>VMP 恰好最不怕这种打法</b>：虚拟化保护的是「方法体不被读懂」，它并不改变方法的输入输出契约，App 自己还得调用它、还得拿到正确的签名。<br><br>' +
          '<b>第三步，没有现成工具就回源码。</b>如果判出来是常规抽取壳，而你手上没有适配当前系统的 FART，那就按六步链路自己移植：定版本、读 AOSP 源码找脱壳点、插桩、编译、刷入、验证。<b>这就是「会读 ART 源码」这件能力的兑现时刻。</b><br><br>' +
          '<b>第四步，实在脱不掉就换思路。</b>不脱壳，直接黑盒调用（unidbg）或动态 Trace。<b>记住目标是拿到结果，不是完成「脱壳」这个动作。</b>很多新手把脱壳当成必经关卡，反而把自己困住了。',
        after: '<p>这道题的高分答案里一定有「不一定非要脱壳」——<b>能主动放弃一条昂贵路线，是成熟度而不是偷懒</b>。</p>'
      },
      {
        id: 'c12q5', depth: 3, threshold: 0.75,
        q: '有人说：「课程能几分钟脱掉 DexProtector，说明脱壳这件事不难，工具做好了一次就够用。」请完整反驳这个说法，并说明<b>你认为这个领域真正的护城河是什么</b>。',
        concepts: [
          { label: '秒脱是前期投入的结果，不是技术简单', hint: '那几分钟之前，发生过什么？', any: ['前期', '前置', '提前做完', '准备工作', '投入', '已经做完', '不是简单', '利息', '之前做的'] },
          { label: '适配工作量以天/周计，且随版本必然过期', hint: '读源码、重定位、编译刷入这一套要多久？下一个大版本来了会怎样？', any: ['过期', '失效', '要重做', '时间成本', '会失效', '重新移植', '每个版本', '又得改', '维护成本'] },
          { label: '护城河是原理理解与读源码的能力', hint: '什么东西从 Android 6 用到 14 都还有效？', any: ['原理', '护城河', '读源码', '理解', '能力', '迁移', '不会过期', '吃透原理', '底层'] },
          { label: '工具收藏是假安全感；工具被封了还得回源码', hint: '如果别人针对你的工具做了对抗，你还剩什么？', any: ['工具收藏', '收藏', '假安全', '依赖工具', '工具会失效', '工具不是', '现成工具', '搬工具'] }
        ],
        hints: [
          '把「秒脱」拆成时间线：哪一段是几分钟，哪一段是天和周？',
          '再往前一步：那几天的投入，会不会因为下一个安卓大版本而作废？如果会，那到底什么没有作废？'
        ],
        probes: [
          '你说工具会过期、能力不会——请具体举一个「能力」的例子，说明它在 Android 6 和 14 上都成立。',
          '如果明天 Android 16 发布，你手上没有任何人做好的移植，你的第一步是什么？要花多久？'
        ],
        model: '<b>这个说法有两处错，而且错在同一个根源上：把「工具跑起来的那一刻」当成了全部工作。</b><br><br>' +
          '<b>第一处错：把「秒脱」理解成技术简单。</b>演示现场那几分钟，覆盖的是：装 App、启动、等主动调用循环走完、取产物、反编译验证。但在这之前发生的事是——确定目标 Android 版本、下载对应版本的 AOSP 源码、在几十万行 C++ 里找到「dex 加载完成」和「方法体回填」这两个语义事件、把三块组件的插桩挪过去并对齐接口、编译 ART、刷入设备、反复验证直到「反编译能看到真实方法体」。<b>这套工作以天甚至周计。</b>所以正确的表述是：<b>技术难度没有消失，只是被前置了。</b>秒脱是前期投入的利息，不是难度的证明。<br><br>' +
          '<b>第二处错：以为「一次适配长期有效」。</b>这恰恰是本章那条时间轴要推翻的：Android 8 重构 DexFile、Android 9 引入 CompactDex、Android 10 调整 ArtMethod 以支持 hidden API 策略、Android 11+ 把信息移到 CodeItemDataAccessor 一类辅助结构、Android 12 改分区……<b>FART 不是成品，是一个必须跟着系统版本持续维护的项目。</b>FART14 只对 Android 14 那一档有效。<br><br>' +
          '<b>那么真正的护城河是什么？是原理理解，是「读 ART 源码、在任意版本里重新定位脱壳点」的能力。</b>工具会随版本失效，二进制的 FART 6.0 用不到 Android 10 上，FART 10 的也用不到 14 上；但「知道 dex 在哪里被解密、方法体什么时候回填、脱壳点该往哪插、遇到 VMP 该换什么思路」这套认知，从 Android 6 一直用到现在。<br><br>' +
          '<b>所以看到别人秒脱，不要问「他用的是哪个工具」，要问「他为这个工具提前做了什么」。</b>前者是收藏家的问题，后者是工程师的问题。收藏工具的人，每次系统升级都要重新找工具；理解原理的人，每次系统升级只是重新做一遍他早就会做的事。',
        after: '<p>这道题真正想确认的是：<b>你有没有把「工具」和「能力」分开看</b>。凡是把二者混为一谈的答案，都会在下一个安卓版本发布时失效。</p>'
      }
    ]
  }
};
