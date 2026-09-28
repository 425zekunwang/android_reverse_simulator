/* 第 16 章数据 —— Frida + FART 全自动脱壳机 */
window.CHAPTER = {
  no: 16,
  title: 'Frida + FART 全自动脱壳机',
  lede: '脱壳这件事，说穿了只有一句话：<strong>在壳把真 dex 解密到内存、但还没来得及藏回去的那一刻，把它抢出来</strong>。' +
        '但"那一刻"到底在哪、抢出来的东西为什么是空的、怎么让它变完整——这三问构成了本章的全部。',
  meta: [
    '核心问题：<b>怎么把壳藏起来的真代码挖出来？</b>',
    '关键机制：<b>双亲委派 / dex 加载 / 主动调用</b>',
    '对手：<b>整体加密壳、抽取壳</b>'
  ],

  sections: [
    /* ============================================================ 16.1 */
    {
      h: '16.1', title: '先建立直觉：壳到底把东西藏哪了',
      intuition: {
        tag: '直觉模型 · 保险柜与复印机',
        body:
          '<p>想象一份重要文件（真 dex）。为了保护它，你把它锁进保险柜（加密），然后把保险柜搬进办公室（APK）。</p>' +
          '<p>但问题是：<strong>你终究要用这份文件</strong>。所以每天上班时，你得打开保险柜、把文件拿出来摊在桌上用；下班再收回去。</p>' +
          '<p>于是"脱壳"就有了两种完全不同的思路：</p>' +
          '<ul>' +
          '<li><strong>思路 A：撬保险柜</strong>（静态脱壳）——直接破解加密算法。问题是算法可能很强，或者密钥来自服务端。</li>' +
          '<li><strong>思路 B：等它自己打开</strong>（动态脱壳）——不碰保险柜，就蹲在办公室里，等文件摊在桌上的那一刻拍照。<em>这就是本章的全部技术路线。</em></li>' +
          '</ul>' +
          '<p>而 FART 的贡献在于，它发现光蹲着还不够——有些文件被抽走了几页（抽取壳），你得<strong>主动要求翻阅每一页</strong>，逼对方把缺的页补回来。</p>'
      },
      html:
        T.note('key', '🔑 本章的主线',
          '<p style="margin-bottom:0">文件什么时候在桌上（<b>dex 加载流程</b>）→ 怎么拍照（<b>脱壳点</b>）→ ' +
          '为什么拍到的是残页（<b>抽取壳</b>）→ 怎么逼它补全（<b>主动调用</b>）。</p>') +
        '<p>要理解"文件什么时候在桌上"，你必须先理解 Android 是怎么找文件的——这就是双亲委派。</p>'
    },

    /* ============================================================ 16.2 */
    {
      h: '16.2', title: '双亲委派：Android 找类的规矩',
      html:
        '<p>当 App 需要用到某个类（比如 <code>com.example.Crypto</code>），它不会自己去找，而是委托给 ' +
        T.term('ClassLoader', '类加载器。Android 中负责把 dex 里的类定义加载成运行时可用的 Class 对象。') + '。规矩是这样的：</p>' +
        T.tbl(
          ['步骤', '发生了什么', '为什么这么设计'],
          [
            ['1', 'ClassLoader 收到加载请求，<b>先交给父加载器</b>', '保证核心类库的唯一性'],
            ['2', '父加载器再交给它的父加载器……一路向上到 <code>BootClassLoader</code>', '形成一条委托链'],
            ['3', '父加载器能加载就返回结果，子加载器不再插手', '防止用户自定义类覆盖系统类'],
            ['4', '<b>父加载器都加载不了，才由自己加载</b>（调用 <code>findClass</code>）', '这才是"自己动手"的时机']
          ]
        ) +
        T.note('warn', '⚠️ 这条规矩带来一个致命后果',
          '<p style="margin-bottom:0">App 默认用的是 <code>PathClassLoader</code>，它只知道 APK 里<b>原始的那个 dex</b>。' +
          '但加固 App 的真 dex 是壳在运行时解密出来的、由<b>自定义 ClassLoader</b> 加载的。<br>' +
          '于是你用 Frida 的 <code>Java.use</code>（走默认加载器）去找业务类——<b>当然找不到</b>。</p>') +
        T.card('Android 的 ClassLoader 家族',
          T.tbl(['类', '加载什么', '典型用途'],
            [
              ['<code>BootClassLoader</code>', '系统核心类库', 'Android 框架自身的类'],
              ['<code>PathClassLoader</code>', '已安装 APK 的 dex', '<b>App 的默认加载器</b>'],
              ['<code>DexClassLoader</code>', '任意路径的 dex / jar / apk', '插件化框架、<b>加固壳</b>']
            ])) +
        T.acc('🔧 遇到"ClassNotFoundException"怎么办（第 15 章情境一的完整解法）',
          '<p>不要怀疑类名写错了。99% 的情况是<b>用错了加载器</b>。标准解法是遍历所有 ClassLoader，找到那个能加载目标类的：</p>' +
          T.code(
            '<span class="f">Java.perform</span>(<span class="k">function</span> () {\n' +
            '  <span class="f">Java.enumerateClassLoaders</span>({\n' +
            '    <span class="f">onMatch</span>: <span class="k">function</span> (loader) {\n' +
            '      <span class="k">try</span> {\n' +
            '        <span class="c">// 试探这个加载器认不认识目标类</span>\n' +
            '        <span class="k">if</span> (loader.<span class="f">findClass</span>(<span class="s">"com.example.Crypto"</span>)) {\n' +
            '          <span class="f">Java.classFactory</span>.loader = loader;   <span class="c">// 切换加载器</span>\n' +
            '          <span class="f">console.log</span>(<span class="s">"[+] 找到正确的 ClassLoader"</span>);\n' +
            '        }\n' +
            '      } <span class="k">catch</span> (e) { <span class="c">/* 这个 loader 不认识，继续 */</span> }\n' +
            '    },\n' +
            '    <span class="f">onComplete</span>: <span class="k">function</span> () {}\n' +
            '  });\n' +
            '  <span class="k">var</span> C = <span class="f">Java.use</span>(<span class="s">"com.example.Crypto"</span>);  <span class="c">// 现在能用了</span>\n' +
            '});'
          ) +
          '<p style="margin-bottom:0">切换之后，<code>Java.use</code> 就会用新加载器，业务类立刻可见。' +
          '<b>这个技巧在第 16、18、24 章会反复用到。</b></p>')
    },

    /* ============================================================ 16.3 动画 */
    {
      h: '16.3', title: '动画：加壳 App 的启动全过程',
      html: '<p>下面这个动画把加壳 App 从点击图标到代码跑起来的过程拆成 10 步。' +
            '请特别关注 <strong>第 6 步</strong>——那是整个脱壳技术的"命门"。</p>',
      stage: {
        title: '加壳 App 启动流程 · 脱壳时机在哪里',
        speed: 1700,
        render:
          '<div class="flow-col" style="gap:9px">' +
            '<div class="flow-row"><span class="pill mono">APK 文件</span><span class="arrow">→</span>' +
              '<span class="blk" id="d1">classes.dex（加密）</span>' +
              '<span class="blk" id="d2">壳的 dex（明文）</span></div>' +
            '<div class="flow-row" style="margin-left:20px"><span class="arrow">↓ 应用启动</span></div>' +
            '<div class="flow-row"><span class="blk" id="s1">壳的 Application 先启动</span></div>' +
            '<div class="flow-row" style="margin-left:20px"><span class="arrow">↓</span></div>' +
            '<div class="flow-row"><span class="blk" id="s2">壳解密真 dex</span>' +
              '<span class="arrow">→</span><span class="blk" id="s3">内存中出现明文 dex</span></div>' +
            '<div class="flow-row" style="margin-left:20px"><span class="arrow">↓</span></div>' +
            '<div class="flow-row"><span class="blk" id="s4">自定义 ClassLoader 加载它</span>' +
              '<span class="arrow">→</span><span class="blk" id="s5">ART 映射 dex 进内存</span></div>' +
            '<div class="flow-row" style="margin-left:20px"><span class="arrow">↓</span></div>' +
            '<div class="flow-row"><span class="blk" id="s6">ART 校验 dex</span>' +
              '<span class="arrow">→</span><span class="blk" id="s7">定义类 / 链接</span>' +
              '<span class="arrow">→</span><span class="blk" id="s8">方法被执行</span></div>' +
            '<div class="flow-row" style="margin-top:6px;padding-top:10px;border-top:1px dashed var(--line)">' +
              '<span class="pill bad" id="mark">🎯 脱壳点就在 s5 / s6 之间</span></div>' +
          '</div>',
        reset: () => {
          ['d1','d2','s1','s2','s3','s4','s5','s6','s7','s8'].forEach(i => S(i, ''));
          CLS('mark', 'pill bad');
          SET('mark', '🎯 脱壳点就在 s5 / s6 之间');
        },
        steps: [
          { run: () => S('d1', 'hot'), note: '<b>APK 里的真 dex 是加密的。</b>用 jadx 直接打开会看到乱码或只有壳的代码。这是"一代壳"（整体加密壳）的基本形态。' },
          { run: () => { S('d1', 'done'); S('d2', 'cool'); }, note: '<b>壳自己的 dex 是明文的。</b>所以 APK 里能看到壳的代码——这就是为什么静态分析只能看到壳，看不到业务逻辑。壳的 dex 负责"解密"和"加载"两件事。' },
          { run: () => { S('d2', 'done'); S('s1', 'active'); }, note: '<b>App 启动时，先跑的是壳的 Application。</b>它在 AndroidManifest 里把自己注册成入口，抢在真正的业务代码之前拿到控制权。这是所有壳的第一招。' },
          { run: () => { S('s1', 'done'); S('s2', 'active'); }, note: '<b>壳执行解密算法。</b>密钥可能硬编码在壳的 so 里，也可能从服务端下发，甚至由设备信息推导。这一步在 Native 层完成（so 里），所以比 Java 层难跟。' },
          { run: () => { S('s2', 'done'); S('s3', 'active'); }, note: '<b>内存中出现明文 dex。</b>⚠️ 注意：此刻它是"游离"的——还没被 ART 接管，只是一块内存数据。<span class="hit">有些脱壳工具就选在这个时刻 dump。</span>' },
          { run: () => { S('s3', 'done'); S('s4', 'active'); }, note: '<b>壳用自定义的 ClassLoader 加载这块内存。</b>这就是 16.2 节讲的：它不走默认加载器，所以你的 <code>Java.use</code> 找不到业务类。' },
          { run: () => { S('s4', 'done'); S('s5', 'active'); }, note: '<b>★ 关键时刻：ART 把 dex 映射进内存。</b>从这里开始，dex 有了 ART 认得的完整结构（DexFile 对象、方法表、字符串表）。<span class="hit">这是最经典的通用脱壳点</span>——因为此时内容已解密、结构已完整，dump 出来直接可用。' },
          { run: () => S('s5', 'done'), note: '<b>脱壳点的选择逻辑（本节核心）：</b><br>• 太早（s3 之前）→ 还没解密完，dump 出来是密文<br>• 太晚（s7 之后）→ 可能已被壳再次保护，或方法体已被抽走<br>• <b>就在 s5/s6 之间</b> → 明文 + 完整结构，最优窗口<br>实际实现时，这个点对应 ART 源码里某个具体函数，<b>每个安卓版本都可能变</b>（第 26 章会展开）。' },
          { run: () => { S('s6', 'active'); }, note: '<b>ART 校验 dex。</b>检查魔数、checksum、map 段结构。校验通过才会被正式加载。<br>⚠️ 这里埋着一个坑：如果你 dump 的时机或方式不对，dump 出的 dex 结构有损坏，<b>jadx 会拒绝反编译</b>——第 24 章讲的"定制 jadx"就是解决这个。' },
          { run: () => { S('s6', 'done'); S('s7', 'active'); }, note: '<b>定义类、链接方法。</b>ART 把 dex 里的类定义变成运行时的 <code>mirror::Class</code> 对象，方法变成 <code>ArtMethod</code>。<br>如果是<b>抽取壳</b>，到这一步你会发现：方法的 code_item 是空的！真正的指令要等首次执行才回填——这就是下一节的内容。' },
          { run: () => { S('s7', 'done'); S('s8', 'cool'); CLS('mark', 'pill ok'); SET('mark', '✅ 完整流程走通，现在你知道脱壳点为什么在那里了'); }, note: '<b>方法被执行，业务逻辑真正跑起来。</b><br>到这里，你已经理解了脱壳的"时机"问题。<span class="hit">但还有第二个问题：为什么 dump 出来的 dex 里，方法都是空的？</span>——那是抽取壳，见 16.5 节。' }
        ]
      }
    },

    /* ============================================================ 16.4 */
    {
      h: '16.4', title: '一代壳 vs 抽取壳：两个不同的问题',
      html:
        T.tbl(['', '一代壳（整体加密壳）', '抽取壳（二代壳）'],
          [
            ['<b>藏什么</b>', '整个 dex 文件加密', '只抽走方法体的 <code>code_item</code>'],
            ['<b>dex 结构</b>', '完全不可见（整体是密文）', '<b>结构完整可见</b>：类名、方法名、字段都在'],
            ['<b>运行时行为</b>', '解密 → 加载', '加载后，方法<b>首次被调用时</b>才回填真指令'],
            ['<b>脱壳后拿到什么</b>', '完整的 dex ✅', '<b>空方法的 dex</b> ❌（反编译只有 return）'],
            ['<b>破解要点</b>', '找对 dump 时机', '<b>必须主动触发每个方法的回填</b>'],
            ['<b>对应技术</b>', '内存 dump（fdex2 / FART 的 dex dump 部分）', '<b>主动调用（FART 的核心）</b>']
          ]) +
        T.note('bad', '🔥 新手最常卡住的地方',
          '<p>很多人第一次脱壳"成功"了——文件也 dump 出来了，jadx 也能打开，<b>但所有方法体都是空的</b>，' +
          '或者只有一行 <code>return null;</code>。</p>' +
          '<p style="margin-bottom:0">然后就开始怀疑工具、怀疑姿势、怀疑人生。<br>' +
          '其实原因很简单：<strong>你脱的是抽取壳，而你没有触发方法回填。</strong><br>' +
          '方法没被执行过 → 它的 code_item 就还是空的 → 你 dump 到的就是空方法。' +
          '这不是工具的问题，是你对抽取壳机制的理解缺了一块。</p>') +
        T.card('为什么"空方法"这个现象如此重要',
          '<p>因为它<a>直接指认了壳的类型</a>，也就直接决定了你的技术路线：</p>' +
          T.tbl(['你观察到', '说明', '该走哪条路'],
            [
              ['jadx 打不开 APK 里的 dex，只有壳的代码', '一代壳', '内存 dump，找加载时机'],
              ['dex <b>能</b>脱出来，但方法体全空', '<b>抽取壳</b>', '主动调用触发回填'],
              ['dex 正常，但关键函数是自定义字节码', 'VMP', '第 20 章的技术，或动态 Trace 绕过'],
              ['方法体不全，只有部分方法有内容', '抽取壳 + 只跑了部分功能', '<b>把 App 所有功能点一遍再脱</b>']
            ]) +
          '<p style="margin-bottom:0">最后一行是一个很实用的实战技巧：<b>抽取壳只回填"被调用过"的方法</b>。' +
          '所以脱壳前把 App 的每个界面、每个按钮都点一遍，能显著提高脱壳完整度。</p>')
    },

    /* ============================================================ 16.4L 动手实验 */
    {
      h: '16.4L', title: '动手实验：读 dex 文件头，判断脱壳是否成功',
      html:
        '<p>脱壳拿到一个 dex 文件后，很多人直接丢给 jadx，报错就以为失败了。' +
        '其实<b>文件头里就有答案</b>——这个实验让你自己读一遍。</p>',
      lab: {
        title: '实验：解析 dex 文件头（112 字节）',
        goal: '目标：从文件头判断版本与完整性',
        intro:
          '<p>dex 文件最开头是固定 <b>112 字节</b>的 <code>header_item</code>。' +
          '把它的十六进制贴进来，系统会解析出各个字段。</p>' +
          '<p>下面预填了一份真实结构的头部（magic + 校验值 + 文件大小 + 各索引区大小）。' +
          '<b>任务：① 它是哪个 Android 版本？② 为什么 jadx 会报 checksum 错误？</b></p>',
        inputs: [
          {
            key: 'hex',
            label: 'dex 文件头（前 112 字节的十六进制）',
            hint: '支持带空格/换行/0x 前缀',
            type: 'textarea', rows: 6,
            value:
              '64 65 78 0a 30 33 39 00 ' +          // magic: dex\n039\0
              '3f 8a 1c 5e ' +                       // checksum (Adler-32, 小端)
              '9a 2b 4c 6d 8e 0f 1a 3b 5c 7d 9e 0f 2a 4b 6c 8d 1e 3f 5a 7b ' + // signature (SHA-1, 20 字节)
              '80 1f 03 00 ' +                       // file_size  = 0x00031f80 = 204672
              '70 00 00 00 ' +                       // header_size = 0x70 = 112
              '78 56 34 12 ' +                       // endian_tag = 0x12345678
              '00 00 00 00 ' +                       // link_size
              '00 00 00 00 ' +                       // link_off
              '80 1e 03 00 ' +                       // map_off
              '2c 0b 00 00 ' +                       // string_ids_size = 2860
              '70 00 00 00 ' +                       // string_ids_off = 112
              'a1 04 00 00 ' +                       // type_ids_size = 1185
              '50 2d 00 00 ' +                       // type_ids_off
              'd2 03 00 00 ' +                       // proto_ids_size = 978
              '50 36 00 00 ' +                       // proto_ids_off
              '0a 02 00 00 ' +                       // field_ids_size = 522
              '00 00 00 00 ' +                       // field_ids_off
              'b4 07 00 00 ' +                       // method_ids_size = 1972
              '00 00 00 00 ' +                       // method_ids_off
              '3d 02 00 00 ' +                       // class_defs_size = 573
              '00 00 00 00 ' +                       // class_defs_off
              '00 00 00 00 00 00 00 00 ' +           // data_size (8 字节)
              '00 00 00 00'                          // data_off
          },
          { key: 'ver', label: '① 这是哪个 Android 版本的 dex？', hint: '看 magic 的版本号', ph: '例如 Android 9.0+' },
          { key: 'why', label: '② 如果这份 dex 是内存 dump 出来的，jadx 为什么可能报 checksum 错误？',
            hint: '想想 dump 时内容变了、但哪个字段没跟着更新', ph: '因为……', type: 'textarea', rows: 2 }
        ],
        runLabel: '🔍 解析文件头',
        autorun: true,
        run: (v) => {
          const L = window.LABX, C = window.CRYPTO;
          const h = L.dexHeader(v.hex || '');
          if (!h.ok) return '<div class="lab-msg warn">' + h.err + '</div>';

          const hex8 = n => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
          let html = '<div class="lab-kv">'
            + '<span>magic <b>' + h.magicPretty + '</b></span>'
            + '<span>版本 <b>' + h.versionLabel + '</b></span>'
            + '<span>header_size <b>' + h.headerSize + '</b>' + (h.headerSize === 112 ? ' ✅' : ' ⚠️') + '</span></div>';

          html += '<table class="lab-tbl"><tr><th>字段</th><th>偏移</th><th>值</th><th>含义</th></tr>'
            + '<tr><td>magic</td><td>0x00</td><td><code>' + h.magicPretty + '</code></td><td>版本标识（dex\\n + 3 位版本 + \\0）</td></tr>'
            + '<tr class="diff"><td>checksum</td><td>0x08</td><td><code>' + hex8(h.checksum) + '</code></td>'
            + '<td><b>Adler-32</b>（注意不是 CRC32！）覆盖 magic 之后的全部内容</td></tr>'
            + '<tr><td>signature</td><td>0x0C</td><td style="font-size:11px"><code>' + h.signature + '</code></td>'
            + '<td><b>SHA-1</b> 签名，覆盖 signature 之后的全部内容</td></tr>'
            + '<tr><td>file_size</td><td>0x20</td><td><code>' + hex8(h.fileSize) + '</code> = ' + h.fileSize + ' 字节</td><td>整个 dex 的大小</td></tr>'
            + '<tr><td>header_size</td><td>0x24</td><td><code>' + hex8(h.headerSize) + '</code> = ' + h.headerSize + '</td><td><b>固定 0x70 = 112</b></td></tr>'
            + '<tr><td>endian_tag</td><td>0x28</td><td><code>' + hex8(h.endianTag) + '</code></td><td>0x12345678 = 小端</td></tr>'
            + '<tr><td>map_off</td><td>0x34</td><td><code>' + hex8(h.mapOff) + '</code></td><td>map 段偏移（反编译器依赖它）</td></tr>'
            + '<tr><td>string_ids_size</td><td>0x38</td><td><code>' + h.stringIdsSize + '</code></td><td>字符串数量</td></tr>'
            + '<tr><td>method_ids_size</td><td>0x58</td><td><code>' + h.methodIdsSize + '</code></td><td>方法引用数量</td></tr>'
            + '<tr><td>class_defs_size</td><td>0x60</td><td><code>' + h.classDefsSize + '</code></td><td><b>类定义数量</b>（脱壳成功与否看这个）</td></tr>'
            + '</table>';

          html += '<div class="lab-msg key"><b>🔑 三个最有用的字段</b><div class="lab-note">'
            + '<b>① <code>magic</code></b> → 判断 dex 版本是否与目标系统匹配<br>'
            + '<b>② <code>checksum</code> / <code>signature</code></b> → 判断文件有没有被改过（dump 后必然失配）<br>'
            + '<b>③ <code>class_defs_size</code></b> → 类定义数量。'
            + '一个正常 App 的 dex 通常有<b>几百到几千</b>个类。如果你 dump 出的 dex 这个值是 <b>0 或个位数</b>，'
            + '说明<b>根本没脱到东西</b>。</div></div>';

          html += '<div class="lab-msg fail"><b>💡 为什么内存 dump 的 dex 会让 jadx 报 checksum 错误</b>'
            + '<div class="lab-note">'
            + '<code>checksum</code> = 对 <b>magic 之后的全部内容</b>算一遍 Adler-32；<br>'
            + '<code>signature</code> = 对 <b>signature 之后的全部内容</b>算一遍 SHA-1。<br><br>'
            + '内存 dump 时，内容变了（尤其是抽取壳的方法体被回填），'
            + '但文件头里这两个字段<b>还是原始 dex 的值，没有跟着更新</b> → 校验必然失配。<br><br>'
            + '<b>这不是脱壳失败，恰恰说明你 dump 到了真东西。</b>'
            + '对比一下：如果 dump 到的是密文或垃圾，jadx 会报"不是有效的 dex"（magic 都不对），' +
            '而不是 checksum 错误。<br>'
            + '<b>解法：</b>重新计算这两个字段并写回（修复），或用定制版 jadx 跳过校验。</div></div>';
          return html;
        },
        expected: (v) => {
          const ver = String(v.ver || '').trim();
          const why = String(v.why || '').trim();
          const verOk = window.AKKC_hasConcept(ver, ['23.0', '9', '039', '安卓9', 'android 9']);
          const whyOk = window.AKKC_hasConcept(why, ['checksum', '校验', '没更新', '失配', '不对', '内容变了', '回填', 'adler', 'signature']);
          return {
            ok: verOk && whyOk,
            detail: (verOk ? '✅ 版本正确：magic 结尾是 <code>039</code> → Android 9.0+。'
                           : '❌ 版本看错了。看 magic 的<b>倒数第 2 位数字</b>：<code>dex\\n039\\0</code> 里的 <code>039</code>。')
              + '<br>'
              + (whyOk ? '✅ 原因说对了：dump 后内容变了，但 checksum/signature 字段没跟着更新。'
                        : '❌ 原因还差一点。关键：<code>checksum</code> 和 <code>signature</code> 是'
                          + '<b>文件头里存的固定值</b>，dump 时内容变了、它们没变 → 校验失败。')
          };
        },
        showAnswer:
          '【① 版本】Android 9.0+\n' +
          '  magic = 64 65 78 0a 30 33 39 00 = "dex\\n039\\0"\n' +
          '  版本号看中间三位数字：035 / 037 / 038 / 039 / 040\n' +
          '    035 → Android 16.2–4.4（Dalvik）\n' +
          '    037 → Android 5.0–6.0\n' +
          '    038 → Android 7.0–8.0\n' +
          '    039 → Android 9.0+\n' +
          '    040 → Android 10+（CompactDex 相关）\n\n' +
          '【② 为什么报 checksum 错误】\n' +
          '  dex 文件头有两个校验字段（都在前 32 字节内）：\n' +
          '    偏移 0x08  checksum  = Adler-32（注意：不是 CRC32）\n' +
          '               覆盖范围 = magic 之后的全部文件内容\n' +
          '    偏移 0x0C  signature = SHA-1（20 字节）\n' +
          '               覆盖范围 = signature 之后的全部文件内容\n\n' +
          '  内存 dump 的过程改变了内容（尤其是抽取壳回填方法体），\n' +
          '  但这两个字段还是原始 dex 里的旧值 → 重新计算必然对不上。\n\n' +
          '  【关键判断】这不是脱壳失败！\n' +
          '    - magic 不对 → 那是真的没脱到东西\n' +
          '    - 只有 checksum 错 → 内容是对的，只是"包装"过期了\n\n' +
          '  解法：① 重算并写回（修复）② 用定制 jadx 跳过校验\n' +
          '  另外可以看 class_defs_size：正常 App 有几百~几千个类，\n' +
          '  如果这个值是 0 或个位数，说明根本没脱到东西。',
        hint:
          '<b>版本号藏在 magic 里。</b>dex 的 magic 是 8 字节：<code>dex\\n</code> + 三位数字 + <code>\\0</code>。' +
          '把 <code>64 65 78 0a 30 33 39 00</code> 逐个查 ASCII 表，'
          + '<code>0x30 0x33 0x39</code> 就是字符 <code>"039"</code>。<br><br>'
          + '<b>第②问的方向：</b>文件头里有两个字段是<b>用来校验内容</b>的。'
          + '想想 dump 之后内容变了，这两个字段会不会自动更新？',
        after:
          T.note('ok', '✅ 实验的收获',
            '<p style="margin-bottom:0">你现在能<b>不依赖任何工具</b>，只凭十六进制就判断一份 dex 的健康状况：<br>' +
            '① <b>magic</b> → 版本对不对<br>' +
            '② <b>checksum/signature</b> → 内容有没有被改（dump 后必然"被改"）<br>' +
            '③ <b>class_defs_size</b> → 有没有真脱到东西<br><br>' +
            '<span class="hit">这个能力在实战中很有用：当 jadx 报错时，你不会再盲目重脱，' +
            '而是能分辨"内容问题"和"包装问题"——两者的解法完全不同。</span></p>')
      }
    },

    /* ============================================================ 16.5C 实战案例 */
    {
      h: '16.5C', title: '实战案例：把 FART 迁移到 Android 16',
      case: {
        source: 'kanxue',
        title: '[原创] 使用 Kimi K3 进行脱壳工具迁移开发：R0DUMP —— 将 FART 迁移到 Android 16',
        date: '2026-7-21',
        author: 'Ivory0',
        target: 'FART / FART 6.0 → LineageOS 23.2 / Android 16；一加 9（代号 lemonade）；三个 DexProtector 样本 com.vietinbank.ipay / com.vnpay.bidv / com.VCB',
        background:
          '<p>第 26 章有一句话：<b>每个安卓大版本，ART 内部结构都会变，脱壳点必须重新定位</b>。' +
          '这篇帖子是那句话的一次完整兑现——作者把 FART / FART 6.0 的主动调用链路搬到 <b>LineageOS 23.2 / Android 16</b> 上，' +
          '重做了一套工具并取名 <b>R0DUMP</b>，在<b>一加 9（代号 lemonade）</b>上用三个 DexProtector 样本' +
          '（<code>com.vietinbank.ipay</code>、<code>com.vnpay.bidv</code>、<code>com.VCB</code>）验证。</p>' +
          '<p>值得学的不是「工具做出来了」，而是<b>它具体卡在哪一步</b>，以及<b>作者怎么描述自己结论的边界</b>。下面按原帖信息逐条复述。</p>',
        points: [
          'FART 原版链路：<code>ActivityThread.fartthread()</code> 先 sleep 60s，再走 <code>dexElements</code> → <code>DexFile.getClassNameList(mCookie)</code> → loadClass → <code>DexFile.dumpMethodCode()</code>。',
          'native 侧靠 <code>NATIVE_METHOD(DexFile, dumpMethodCode, "(Ljava/lang/Object;)V")</code> 注册，用 <code>ArtMethod::FromReflectedMethod</code> 取到 ArtMethod，再让 <code>myfartInvoke</code> 传 <code>self = nullptr</code>，逼 <code>ArtMethod::Invoke()</code> 走进 <code>dumpArtMethod(this)</code> 那条分支。',
          'dump 产物落在 <code>/sdcard/fart/&lt;process&gt;/&lt;dex_size&gt;_dexfile.dex</code> 与 <code>&lt;dex_size&gt;_&lt;tid&gt;.bin</code>；配套的 <code>fart.py</code> 还是 <b>Python 16.7</b> 写的。',
          '<b>Android 16 适配的关键一处</b>：改用<b>带 cookie 的 <code>dumpMethodCode()</code> 重载</b>，并用 <b>cookie / class descriptor 选 fallback DexFile</b> —— 因为 copied / obsolete 的 ArtMethod 身上<b>没有有效的 DexFile</b>。',
          '受控配置走 <code>Settings.Global</code> 的 <code>r0dump.dump.*</code>；产物经 MediaStore 写到 <code>Download/R0DUMP/&lt;process&gt;</code>，不再直写 <code>/sdcard</code>。',
          '默认策略是 <code>CLASS_WALK|APP_CREATE|ACTIVITY_CREATE|IN_MEMORY_DEX|DEFINE_CLASS</code>，ART 策略位扩到 <b>32 个</b>。',
          '产物清单：<code>methods_&lt;pid&gt;.jsonl</code>、<code>_r0dump_status.json</code>、<code>dexfixed_*.dex</code>，日志统一打 <code>[R0DUMP]</code> 前缀。'
        ],
        method: [
          '先读通 FART 原版链路：<code>fartthread()</code> 睡 60s 等目标跑起来，再从 <code>dexElements</code> 拿 DexFile，<code>getClassNameList(mCookie)</code> 列类，loadClass 触发回填，最后由 <code>dumpMethodCode()</code> 落地。',
          '把 native 侧的注册与调用补齐：<code>NATIVE_METHOD</code> 宏注册 <code>dumpMethodCode</code>，<code>ArtMethod::FromReflectedMethod</code> 取 ArtMethod，<code>myfartInvoke</code> 故意传 <code>self = nullptr</code>，把执行引到 <code>dumpArtMethod(this)</code>。',
          '在 Android 16 上重新定位取数路径：改用带 cookie 的 <code>dumpMethodCode()</code> 重载，并以 cookie / class descriptor 兜底反查 DexFile —— 这一步就是在处理 copied / obsolete ArtMethod 拿不到有效 DexFile 的问题。',
          '把配置与产物改成受控路径：<code>Settings.Global</code> 的 <code>r0dump.dump.*</code> 做开关，产物经 MediaStore 写入 <code>Download/R0DUMP/&lt;process&gt;</code>。',
          '补齐策略位与状态记录：默认 <code>CLASS_WALK|APP_CREATE|ACTIVITY_CREATE|IN_MEMORY_DEX|DEFINE_CLASS</code>，ART 策略位扩到 32 个，另写 <code>methods_&lt;pid&gt;.jsonl</code> 与 <code>_r0dump_status.json</code> 供回溯。',
          '验证：三个 DexProtector 样本产出的 <code>dexfixed_*.dex</code> 经 repair 之后，JADX 能正常加载。'
        ],
        result:
          '<p>三组样本（<code>com.vietinbank.ipay</code>、<code>com.vnpay.bidv</code>、<code>com.VCB</code>）的产物在 repair 之后，' +
          '<b>JADX 都能正常加载</b>——从 FART 6.0 到 Android 16 这条迁移链路是通的。</p>',
        terms: ['FART', '主动调用', 'ArtMethod', 'dexElements', 'DexFile', 'copied / obsolete ArtMethod', 'dumpMethodCode', 'DexProtector', 'Settings.Global', 'MediaStore', 'JADX'],
        limits:
          '<p>作者对局限的交代相当充分，逐条照录：</p>' +
          '<p>① <b>不保证覆盖面</b>：native 化、VMP、强对抗样本都不在保证范围内，工具本身也<b>没有任何特征隐藏</b>；' +
          '② <b>设备单一</b>：只在一加 9 上验证，其他机型与内核未测；' +
          '③ <b>刷机风险自担</b>：原帖明确强调 <b>anti-rollback 与 bootloader 解锁</b>的风险；' +
          '④ <b>最该记的一条</b>——作者点明：<b>「代码里有策略位」不等于「设备上已验证」</b>，' +
          'oat / vdex、JIT、instrumentation 这几条路径并未全部覆盖；' +
          '⑤ 原帖<b>没有附独立的 <code>repair_dex.py</code></b>，修复环节要自己补齐。</p>',
        analysis:
          '<p><b>本课第 16 章的元原则是：脱壳的本质，是抢在解密完成的那一刻把它取出来。</b>这个案例里没有一处新魔法——' +
          '主动调用的骨架（<code>getClassNameList(mCookie)</code> → loadClass → <code>dumpMethodCode()</code>）一步没变，' +
          '它做的全部事情仍然是<b>逼壳把方法体回填出来，然后趁回填好的那一刻把 code item 取走</b>。变的只有「那一刻」在 Android 16 上对应的具体接口。</p>' +
          '<p><b>而这正是第 26 章那句话的现场兑现：每个安卓大版本，ART 结构都会变，脱壳点必须重新定位。</b>' +
          '案例里最具体的那个坑是——<b>copied / obsolete 的 ArtMethod 没有有效的 DexFile</b>。' +
          '旧代码默认「拿到 ArtMethod 就能顺着它摸到 DexFile」，而 ART 演进之后，被复制、被废弃的方法对象身上这条线索断了；' +
          '作者的解法是<b>换用带 cookie 的 <code>dumpMethodCode()</code> 重载，并用 cookie / class descriptor 兜底反查 DexFile</b>。' +
          '<span class="hit">这就是「版本演进的坑」最标准的形态：不是函数改名，而是<b>你以为稳定的那条引用链，在新版本里不再成立</b>。</span>' +
          '第 26 章让你「按语义事件而不是按函数名去定位脱壳点」，这个案例补上了后半句——<b>定位到了之后，还得重新确认数据从哪来</b>。</p>' +
          '<p>第二件值得学的是<b>结论的诚实性</b>。作者专门写了一句：<b>「代码里有策略位」≠「设备上已验证」</b>——' +
          '代码里写了 oat / vdex 的分支，不代表真机上这条路径被跑通过，JIT 与 instrumentation 同理。' +
          '这和本课实验里那条纪律是同一条：<b>没跑出来的结论，只能标注成「未验证」，不能写成「已支持」。</b>' +
          '脱壳工具最容易骗人的地方恰恰在这里——<b>它会在你没覆盖的路径上安静地给出一个不完整的 dex</b>，' +
          '而光看 <code>class_defs_size</code> 是看不出少了哪个类的。</p>' +
          '<p>最后一条方法论：帖子标题写明「使用 Kimi K3 进行脱壳工具迁移开发」。' +
          'AI 在版本迁移里的价值很实在——<b>把「旧版本怎么写的、新版本改成什么了」这种对照工作加速</b>；' +
          '但上面那个适配点是谁发现的、有没有在设备上验证过，<b>仍然只能由人负责</b>。' +
          '<span class="hit">记住这条分工：AI 负责提出改法，人负责给出证据。</span></p>',
        link: 'https://bbs.kanxue.com/thread-292107.htm',
        linkNote: '看雪论坛原创帖'
      }
    },

    /* ============================================================ 16.5 步进器 */
    {
      h: '16.5', title: '代码推演：FART 的主动调用是怎么做的',
      html: '<p>既然抽取壳只回填"被调用过"的方法，那破解思路就很直接了：' +
            '<strong>让它认为所有方法都被调用过</strong>。这就是 FART 的核心——' +
            T.term('主动调用（Active Call）', 'FART 的核心机制：遍历 dex 中所有类、所有方法，逐个强制触发调用，迫使抽取壳完成方法体回填，然后再 dump code item。') +
            '。</p>' +
            '<p>下面把 FART 的主动调用流程拆成 10 步。注意它是个<strong>三层嵌套循环</strong>——这是理解它的关键。</p>',
      stepper: {
        title: 'FART 主动调用（Active Call）执行流程',
        lines: [
          {
            code: '<span class="c">// 第 0 层：拿到目标 dex 的句柄</span>',
            note: '<b>一切从拿到 DexFile 开始。</b>FART 在 dex 加载完成时（16.3 节讲的脱壳点）已经记录下了 DexFile 对象。现在要遍历它。<br>注意：一个 App 可能有<b>多个</b> dex（多 dex 机制），所以要循环处理每个 DexFile。',
            state: { '当前 DexFile': '#1 / 共 3 个', '类总数': '1847（已解析）', '脱壳阶段': '① 定位 dex' }
          },
          {
            code: '<span class="k">for</span> (每个 DexFile) {',
            note: '遍历所有 dex。<b>为什么不能只处理第一个？</b>因为加固常把关键代码放在后面的 dex 里，甚至动态加载新的 dex。漏掉任何一个，脱壳结果都是不完整的。',
            state: { '当前 DexFile': '#1', '已处理': '0/3', '脱壳阶段': '① 定位 dex' }
          },
          {
            code: '  <span class="k">for</span> (每个 ClassDef) {',
            note: '<b>第二层循环：遍历 dex 里的每个类。</b>从 dex 头的 <code>class_defs</code> 数组逐个读取。<br>这一步只是"列出类"，还没有碰方法体——所以很快。',
            state: { '当前 DexFile': '#1', '当前类': 'com/example/Crypto', '进度': '12/1847', '脱壳阶段': '② 遍历类' }
          },
          {
            code: '    <span class="k">for</span> (每个 DirectMethod + VirtualMethod) {',
            note: '<b>第三层循环：遍历类里的每个方法。</b><br>⚠️ 关键细节：dex 把方法分成 <code>direct_methods</code>（私有/构造/静态）和 <code>virtual_methods</code>（可重写）两组，<b>两组都要遍历</b>。只处理一组是常见的实现 bug。',
            state: { '当前类': 'com/example/Crypto', '当前方法': 'encode', '方法总数': '14', '脱壳阶段': '③ 遍历方法' }
          },
          {
            code: '      <span class="c">// ★ 核心：强制调用这个方法</span>',
            note: '<b>这里是 FART 的灵魂。</b>对每个方法，构造一个调用并执行它。这一步会触发抽取壳的"首次调用"逻辑，把真正的方法体回填进内存。<br><span class="hit">没有这一步，你 dump 到的永远是空方法。</span>',
            state: { '当前方法': 'encode', '方法体状态': '空（未回填）', '脱壳阶段': '★ 主动调用' }
          },
          {
            code: '      <span class="f">Invoke</span>(method);',
            note: '<b>执行调用。</b>这里有个现实问题：<b>方法需要参数</b>。FART 的做法是传默认值（0、null、空字符串）。<br>所以调用大概率会抛异常或返回错误——<b>但没关系</b>！我们的目的不是拿到正确结果，而是<b>触发回填这个副作用</b>。<br>⚠️ 因此必须做好异常处理，不能因为一个方法抛异常就中断整个流程。',
            state: { '当前方法': 'encode', '传入参数': 'null / 0（默认值）', '返回': '异常（预期内）', '副作用': '✅ 方法体已回填' },
            mem: '方法体回填前后对比\n\n回填前（code_item 为空）：\n  insns_size = 0\n  insns      = []          ← dump 出来是空的\n\n回填后（壳写入真指令）：\n  insns_size = 42\n  insns      = [0x1a01, 0x2b03, ...]  ← 真指令！'
          },
          {
            code: '      <span class="c">// dump 这个方法体的指令</span>',
            note: '<b>回填完成后立即 dump。</b>把 CodeItem 的 <code>insns</code> 数组和 <code>insns_size</code> 写到一个 bin 文件里。<br>FART 的做法是每 dump 一个方法就写一条记录，最后统一合并——这样即使中途崩溃，已 dump 的部分也不会丢。',
            state: { '当前方法': 'encode', 'dump 内容': '42 条指令', '输出文件': 'bin 文件', '累计已 dump': '187/1847', '脱壳阶段': '④ dump 方法体' }
          },
          {
            code: '    }',
            note: '方法循环结束。<b>一个类的所有方法处理完了。</b><br>此时这个类的所有 CodeItem 都已被 dump。',
            state: { '当前类': 'com/example/Crypto', '该类 dump 数': '14', '累计已 dump': '187', '脱壳阶段': '④ dump 方法体' }
          },
          {
            code: '  }',
            note: '类循环结束。<b>一个 dex 处理完了。</b><br>所有小文件（每个方法体的 bin）都写到了 sdcard 上。',
            state: { '当前 DexFile': '#1 完成', '累计已 dump': '1847', '脱壳阶段': '④ dump 方法体' }
          },
          {
            code: '}  <span class="c">// 然后：把 bin 合并回 dex，修复文件头</span>',
            note: '<b>最后一步：修复。</b>dump 出来的是一堆散装的方法体，必须合并回 dex 的正确位置，并修正：<br>• 文件头的 <code>checksum</code>（Adler-32）<br>• <code>signature</code>（SHA-1）<br>• map 段<br><br>修好之后，jadx 才能正常反编译。<span class="hit">FART 完成时会打印 "fart run over"，产物在 /sdcard/fart/&lt;包名&gt;/ 下。</span>',
            state: { '当前 DexFile': '全部 3 个完成', '总 dump 方法': '5213', '修复状态': '✅ 完成', '脱壳阶段': '✅ 完成' },
            mem: '脱壳产物目录结构\n/sdcard/fart/com.example.app/\n├── 1.dex          ← dump 的 dex\n├── 2.dex\n├── 3.dex\n└── bin/\n    ├── 0.bin      ← 方法体（按索引）\n    ├── 1.bin\n    └── ...'
          }
        ]
      },
      after:
        T.note('ok', '✅ 三个必须记住的细节',
          '<ol style="margin-bottom:0">' +
          '<li><b>遍历要全</b>：所有 DexFile × 所有类 × 所有方法（direct + virtual 两组）。漏一组，脱壳就不完整。</li>' +
          '<li><b>调用会失败，但没关系</b>：传默认参数必然导致异常，我们要的是"回填"这个副作用。异常必须捕获，否则流程中断。</li>' +
          '<li><b>dump 完还要修复</b>：散装方法体 + 修正文件头，才能得到可反编译的 dex。这一步不做，jadx 会拒绝打开。</li>' +
          '</ol>')
    },

    /* ============================================================ 16.6 决策 */
    {
      h: '16.6', title: '决策演练：真实工程里怎么选',
      html: '<p>下面三个情境都来自真实工作。请认真选——选错了我不会只告诉你答案，还会讲清错在哪。</p>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一',
            scenario: '<b>情境：</b>你拿到一个加壳 App，用 FART 脱壳成功，产物 dex 用 jadx 能打开，' +
                      '但发现 <code>CryptoUtil.encrypt()</code> 这个你<strong>最关心的方法</strong>是空的，' +
                      '而同一个类里其他方法都有正常代码。',
            q: '最可能的原因是什么？',
            choices: [
              { t: '脱壳工具坏了，换个工具重脱', next: 'n1' },
              { t: '这个方法在脱壳过程中没被调用过，所以壳没回填它', next: 'n2' },
              { t: 'jadx 的版本太老，换个新版本', next: 'n3' },
              { t: '这个方法被 VMP 保护了，需要更强的工具', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：现象已经指明了原因',
            result: '<b>注意到关键线索了吗？</b>"同一个类里<b>其他方法都有正常代码</b>"——' +
              '如果工具坏了，应该整批都是空的；如果 dex 结构损坏，jadx 根本打不开。<br><br>' +
              '现在是<b>精确的单个方法为空</b>，这是抽取壳的典型特征，不是工具问题。<br><br>' +
              '<b>换工具是浪费时间。</b>任何工具都遵循同一个物理规律：壳只回填"被调用过"的方法。'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'good',
            verdictTitle: '正确：抽取壳只回填"被调用过"的方法',
            result: '<b>这就是抽取壳的工作机制。</b>方法体的回填发生在<b>首次调用</b>时。' +
              '如果 <code>encrypt()</code> 在你的脱壳过程中从未被触发，它的 code_item 就一直是空的。<br><br>' +
              '<b>为什么其他方法有代码？</b>因为它们被调用了（比如构造方法、onCreate、初始化逻辑等，App 一启动就会跑）。<br><br>' +
              '<b>怎么解决：</b><ol>' +
              '<li><b>脱壳前跑一遍 App 的完整功能</b>——把每个界面、每个按钮、每个功能点都操作一遍，让尽可能多的方法被执行</li>' +
              '<li>如果是 FART，确认主动调用确实覆盖了它——检查是不是 direct/virtual 分组的问题</li>' +
              '<li>如果它确实无法被自然触发（比如需要特定参数才走到的分支），用 Frida 手动调用它一次：<br>' +
              '<code>Java.perform(() =&gt; { Java.use("...CryptoUtil").encrypt("test"); });</code></li>' +
              '</ol>' +
              '<span class="hit">记住这个规律：抽取壳的完整度 = 你触发过的代码路径覆盖度。</span>'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '判断错了：这不是反编译器的能力问题',
            result: 'jadx 能打开这个 dex、能正常显示<b>其他方法</b>的代码，说明它工作正常。<br><br>' +
              '如果 jadx 版本有问题，你会看到<b>报错</b>或<b>所有方法都异常</b>，而不是精确地只有一个方法为空。<br><br>' +
              '<b>关键区分点：</b><br>' +
              '• <b>jadx 打不开 / 报 checksum 错误</b> → 那是 dex 结构损坏问题（第 24 章的定制 jadx）<br>' +
              '• <b>能打开，但某些方法体为空</b> → 那是抽取壳没回填（本情境）<br><br>' +
              '现象不同，根因完全不同，别混为一谈。'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '想多了：VMP 和"空方法"是两种不同现象',
            result: 'VMP 和抽取壳的表现<b>完全不同</b>，可以清楚区分：<br><br>' +
              '• <b>抽取壳（未回填）</b>：方法体是<b>空的</b>，jadx 显示为空或只有 <code>return</code><br>' +
              '• <b>VMP</b>：方法体<b>有代码</b>，但代码是"跳进解释器 + 一堆数据"，看不懂逻辑<br><br>' +
              '你这个现象是"空"，所以是抽取壳未回填，不是 VMP。<br><br>' +
              '<b>而且即使真是 VMP，换"更强的工具"通常也没用</b>——VMP 的破解靠的是理解解释器结构、构建映射表（第 20 章），' +
              '不是靠换个工具一键搞定。'
          }
        }
      }
    },

    {
      html: '<div id="decision-2"></div>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境二',
            scenario: '<b>情境：</b>你要给团队搭一套脱壳流程。目标 App 每周更新一次，' +
                      '加固方案不变（是抽取壳），但代码一直在改。你发现之前写的、基于固定函数偏移的 Frida 脱壳脚本' +
                      '<strong>每次 App 更新就失效</strong>。',
            q: '怎么让这套流程稳定下来？',
            choices: [
              { t: '每次更新后重新分析，更新脚本里的偏移', next: 'n1' },
              { t: '改用 FART 这种基于 ART 原理的方案，而不是依赖具体地址', next: 'n2' },
              { t: '干脆每次手动脱壳，反正一周才一次', next: 'n3' },
              { t: '让 App 不要更新（锁定版本）', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'bad',
            verdictTitle: '能跑，但你在给自己制造永久的技术债',
            result: '<b>这是最常见的"能跑但很糟"的方案。</b>每次更新都要：重新逆向定位、算新偏移、改脚本、测试。<br><br>' +
              '<b>问题在于：</b>你维护的不是"脱壳能力"，而是"针对某个具体版本的补丁"。' +
              '一旦离职交接，下一个人的成本极高；一旦加固方案微调，你的整套脚本可能全废。<br><br>' +
              '<b>更根本的问题：</b>偏移会变，是因为代码变了。<b>但 ART 加载 dex 的机制没变。</b>' +
              '你应该把脚本建立在不变量上，而不是变量上。'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'good',
            verdictTitle: '正确：把方案建立在不变量上',
            result: '<b>这是本章（以及整个第 18、26 章）的核心思想。</b><br><br>' +
              '<b>什么是变量：</b>函数偏移、符号名、代码结构、字符串常量——这些每次编译都可能变。<br>' +
              '<b>什么是不变量：</b>ART 加载 dex 的流程、抽取壳"首次调用才回填"的机制、方法必须遍历才能触发。<br><br>' +
              'FART 之所以稳定，正因为它建立在不变量上：<b>它不关心你的代码长什么样，它只是遍历所有方法并调用</b>。<br><br>' +
              '<span class="hit">判断一个方案好不好，看它依赖的是机制还是特征。</span><br><br>' +
              '<b>但要注意：</b>"机制不变"也有边界——安卓大版本升级时 ART 内部结构会变（第 26 章），' +
              'FART 也需要移植。<b>区别在于：框架移植一次能用很久，而偏移补丁每周都要修。</b>'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '短期省事，长期不可持续',
            result: '<b>手动脱壳的问题不是"慢"，而是"不可规模化、不可靠、不可交接"。</b><br><br>' +
              '• 一次手动脱壳可能 30 分钟，但你需要分析的样本可能不止一个<br>' +
              '• 手动操作会出错、会遗漏（比如忘了跑某个功能点导致方法没回填）<br>' +
              '• 没有人在你休假时能接手<br>' +
              '• 无法纳入自动化流水线<br><br>' +
              '<b>而且"一周一次"是个危险的假设</b>——真到需要应急响应（比如 App 紧急更新）时，' +
              '手动流程会成为瓶颈。<br><br>' +
              '正确做法是<b>把 FART 的脱壳+修复流程脚本化</b>，让它能一键运行。'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '这通常不是你能决定的，而且是在逃避问题',
            result: '<b>先从可行性说：</b>你大概率没有权力要求业务方停止更新 App。<br><br>' +
              '<b>再从必要性说：</b>即使能锁版本，你也只是推迟了问题——迟早要面对新版。<br><br>' +
              '<b>更重要的认知：</b>如果对方更新了加固方案（比如从抽取壳升级到 VMP），' +
              '你锁定旧版本等于<b>放弃了对新版本的了解</b>，风险更大。<br><br>' +
              '<b>正确的心态：</b>把"应对版本变化"当成流程设计的一部分，' +
              '用基于机制的方案（选项 B）降低变化带来的成本。'
          }
        }
      }
    },

    {
      html: '<div id="decision-3"></div>',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境三',
            scenario: '<b>情境：</b>你用 FART 脱壳，logcat 里已经看到 "fart run over"，产物目录也有文件。' +
                      '但用 jadx 打开 dump 出的 dex，报错 <code>Invalid dex file / checksum mismatch</code>，直接拒绝加载。',
            q: '你的处理思路是？',
            choices: [
              { t: '重新脱一次，可能是这次没脱干净', next: 'n1' },
              { t: '用定制版 jadx（放宽校验），或者先用修复工具修 dex', next: 'n2' },
              { t: '说明脱壳失败了，换别的脱壳工具', next: 'n3' },
              { t: '把 dex 文件头的前 12 个字节删掉再试', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'bad',
            verdictTitle: '大概率会得到同样的结果',
            result: '<b>checksum mismatch 不是"随机失败"，而是结构性的。</b><br><br>' +
              'dump 出来的 dex 之所以校验不通过，通常是因为：<br>' +
              '• 方法体被回填后，内容变了，但文件头的 <code>checksum</code>（Adler-32）没更新<br>' +
              '• <code>signature</code>（SHA-1）同样是旧的<br>' +
              '• map 段可能缺失或错位<br><br>' +
              '这些是<b>必然出现</b>的，不是随机事件。重脱一百次结果都一样。<br><br>' +
              '<b>除非</b>：你怀疑是这次脱壳过程中 App 崩了导致文件写了一半。那可以先检查文件大小是否合理（正常 dex 有几个 MB，写了一半的会明显偏小）。'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'good',
            verdictTitle: '正确：修复或放宽校验，两条路都可行',
            result: '<b>你已经正确识别了问题性质：内容是对的，只是"包装"坏了。</b><br><br>' +
              '<b>路线一：先修复再分析（推荐）</b><br>' +
              '用工具重新计算 checksum 与 signature、补全 map 段。FART 自带的修复组件就是干这个的。' +
              '修好之后标准 jadx 也能打开，而且分析体验更好（不会有残缺的伪代码）。<br><br>' +
              '<b>路线二：用定制版 jadx（快速验证）</b><br>' +
              '放宽校验直接打开。<b>优点</b>：快，能立刻看到内容。<b>缺点</b>：jadx 依赖 map 段做反编译，' +
              'map 段有问题时产出的伪代码可能不完整或有错。<br><br>' +
              '<b>实战建议：</b>先修复，修不好再上定制 jadx。<br><br>' +
              '<b>补充：</b>还有一个选择是用 <code>baksmali</code> 反汇编成 smali——它对结构问题的容忍度通常比 jadx 高，' +
              '虽然可读性差一些，但至少能看到真实的指令。'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '误判：这恰恰说明脱壳基本成功了',
            result: '<b>注意区分两种失败：</b><br><br>' +
              '• <b>脱壳失败</b>：产物是空的、全是垃圾数据、或者根本没有方法体 → 那才需要换工具<br>' +
              '• <b>脱壳成功但结构损坏</b>：文件有内容、能看出是 dex、只是校验不过 → <b>这是正常现象</b><br><br>' +
              '你遇到的是第二种。<b>所有内存 dump 出来的 dex 都会有这个问题</b>，因为 dump 的过程必然破坏文件头的完整性。<br><br>' +
              '<b>换工具也解决不了</b>——除非那个工具自带修复步骤。所以问题不在工具，在于你漏了"修复"这一环。'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '危险操作：这会彻底毁掉文件',
            result: '<b>千万不要这么做。</b>dex 文件头的 112 字节（<code>header_item</code>）包含了解析整个文件所必需的信息：<br><br>' +
              '<code>magic</code>（魔数 "dex\\n035\\0"）、<code>checksum</code>、<code>signature</code>、' +
              '<code>file_size</code>、<code>header_size</code>、<code>map_off</code>（map 段偏移）、' +
              '以及各个索引区（string_ids、type_ids、proto_ids、field_ids、method_ids、class_defs）的<b>偏移和大小</b>。<br><br>' +
              '删掉前 12 字节，等于把魔数、校验和、签名全丢了，<b>文件彻底无法解析</b>，而且因为内部所有偏移都基于文件起始位置，' +
              '整个文件的结构全部错位。<br><br>' +
              '<b>正确做法：</b>不是"删"，而是"<b>重新计算并写回正确值</b>"。这就是修复工具做的事。'
          }
        }
      }
    },

    /* ============================================================ 16.7 测验 */
    {
      h: '16.7', title: '自测：检查你的模型有没有歪',
      quiz: {
        id: 'q2-1', chapter: 2, answer: 1,
        stem: '为什么 <code>Java.use</code> 在加固 App 上经常报 <code>ClassNotFoundException</code>？',
        options: [
          { t: '因为类名写错了', why: '99% 的情况不是类名问题，而是加载器问题。' },
          { t: '因为默认 ClassLoader 看不到壳用自己的 ClassLoader 加载的真 dex', why: '正确。这是双亲委派机制 + 自定义加载器导致的。' },
          { t: '因为 Frida 版本太老', why: '与 Frida 版本无关。' },
          { t: '因为方法被内联了', why: '内联影响的是 Native Hook，且表现为"hook 不触发"而非"类找不到"。' }
        ],
        explain: '<code>Java.use</code> 默认使用 App 的 <code>PathClassLoader</code>，它只认识 APK 里原始的 dex。<br>' +
          '而加固壳把真 dex 解密到内存后，用<b>自定义的 <code>DexClassLoader</code></b> 加载它。' +
          '由于双亲委派的限制，默认加载器根本看不到这部分类。<br><br>' +
          '<b>解法：</b>用 <code>Java.enumerateClassLoaders</code> 遍历所有加载器，' +
          '找到能用 <code>findClass</code> 加载目标类的那一个，然后设 <code>Java.classFactory.loader = loader</code>。'
      }
    },
    {
      html: '<div id="quiz2"></div>',
      quiz: {
        id: 'q2-2', chapter: 2, answer: 2,
        stem: '抽取壳的"抽取"指的是抽走了什么？',
        options: [
          { t: '整个 dex 文件，运行时才解密', why: '那是一代壳（整体加密壳）。' },
          { t: '类的名字和方法签名', why: '恰恰相反——抽取壳保留了完整的结构，这样才能正常加载类。' },
          { t: '方法体的 code_item（insns 指令数组）', why: '正确。结构保留，只抽走真正的指令。' },
          { t: 'dex 的字符串常量表', why: '那是字符串加密，不是抽取壳。' }
        ],
        explain: '<b>抽取壳保留 dex 的完整结构</b>——类名、方法名、字段、签名全都在，所以 ART 能正常加载和链接类。<br><br>' +
          '但每个方法的 <code>code_item</code>（真正存放 dalvik 字节码指令的 <code>insns</code> 数组）被抽走，' +
          '<code>insns_size</code> 变成 0 或被填充成 nop。<br><br>' +
          '运行时，当方法<b>首次被调用</b>时，壳的解密逻辑才把真指令回填进去。<br><br>' +
          '<b>这就是为什么普通内存 dump 拿到的是"空方法"</b>——你没调用过它，它就还没被回填。'
      }
    },
    {
      html: '<div id="quiz3"></div>',
      quiz: {
        id: 'q2-3', chapter: 2, answer: 1,
        stem: 'FART 的"主动调用"遍历方法时，为什么即使调用抛出异常也没关系？',
        options: [
          { t: '因为异常会被 ART 自动忽略', why: '不会。异常需要你自己捕获，否则会中断流程。' },
          { t: '因为目的是触发"回填"这个副作用，而不是拿到正确的返回值', why: '正确。这是理解 FART 的关键。' },
          { t: '因为 FART 会先修复方法再调用', why: '顺序反了——是先调用触发回填，再 dump。' },
          { t: '因为异常的方法不会被 dump', why: '错误。异常不影响 dump，回填已经完成。' }
        ],
        explain: '<b>这是 FART 最容易被误解的地方。</b><br><br>' +
          'FART 调用方法时传的是默认参数（0、null、空字符串），所以方法几乎必然抛异常或返回错误结果。' +
          '<b>但这不是目的。</b><br><br>' +
          '我们的目标是让抽取壳认为"这个方法要被使用了"，从而触发它的回填逻辑，把真指令写进 code_item。' +
          '回填是<b>调用这个动作的副作用</b>，一旦发生，dump 就能拿到真代码。<br><br>' +
          '<b>工程上的后果：</b>必须给每次调用加异常捕获（try/catch），否则一个方法抛异常就会中断整个遍历，' +
          '后面的方法全都 dump 不到。'
      }
    },
    {
      html: '<div id="quiz4"></div>',
      quiz: {
        id: 'q2-4', chapter: 2, answer: 0,
        stem: '脱壳后准备用 jadx 分析，但报 <code>checksum mismatch</code>。正确的理解是？',
        options: [
          { t: '正常现象：内存 dump 破坏了文件头完整性，需要修复或放宽校验', why: '正确。这是内存 dump 的固有副作用。' },
          { t: '脱壳失败，需要重新脱', why: '重脱结果一样，这是结构性问题。' },
          { t: '目标 App 用了 VMP', why: 'VMP 的表现是"有代码但看不懂"，不是校验失败。' },
          { t: 'jadx 版本太老', why: '与版本无关，标准 jadx 就是会做严格校验。' }
        ],
        explain: 'dex 文件头包含 <code>checksum</code>（Adler-32，覆盖 magic 之后的全部内容）和 ' +
          '<code>signature</code>（SHA-1，覆盖 signature 之后的全部内容）。<br><br>' +
          '内存 dump 时，方法体被回填、内容发生变化，但文件头里记录的还是旧值 → 校验必然失败。<br><br>' +
          '<b>两条出路：</b><br>' +
          '① <b>修复</b>：重新计算 checksum 与 signature，补全 map 段（推荐，修完标准工具都能用）<br>' +
          '② <b>放宽</b>：用定制版 jadx 跳过校验（快速，但 map 段有问题时伪代码可能不完整）<br><br>' +
          '另外可以试 <code>baksmali</code>，它对结构问题的容忍度更高。'
      }
    }
  ],

  /* ============================================================== 名词表 */
  glossary: [
    { t: 'ClassLoader', d: '类加载器。把 dex 里的类定义加载成运行时可用的 Class 对象。加固壳用自定义 ClassLoader 加载真 dex，导致默认加载器看不到业务类。' },
    { t: '双亲委派', d: 'ClassLoader 收到加载请求时先委托父加载器，父加载器加载不了才自己加载。保证核心类库唯一性。' },
    { t: 'PathClassLoader', d: 'Android App 的<b>默认</b>类加载器，加载已安装 APK 的 dex。' },
    { t: 'DexClassLoader', d: '可加载任意路径的 dex/jar/apk。插件化框架与加固壳常用。' },
    { t: '一代壳', d: '整体加密壳。整个 dex 加密存储，运行时解密到内存再加载。脱壳关键是找对 dump 时机。' },
    { t: '抽取壳', d: '二代壳。保留 dex 完整结构，但抽走方法体的 code_item，首次调用时才回填。所以普通 dump 得到的是空方法。' },
    { t: 'code_item', d: 'dex 中存放方法体的结构，核心是 insns（dalvik 字节码指令数组）与 insns_size。抽取壳抽的就是它。' },
    { t: '脱壳点', d: '选择在 ART 加载 dex 流程中的哪个时刻执行 dump。最优窗口是"已解密 + 结构完整"的那一刻（16.3 节的 s5/s6 之间）。' },
    { t: '主动调用', d: 'Active Call。FART 的核心：遍历所有类与所有方法逐个强制调用，触发抽取壳回填，再 dump code item。' },
    { t: 'FART', d: 'ART 环境下基于主动调用的自动化脱壳方案。基于 Android 6.0，可移植到其他 ART 版本。产物在 /sdcard/fart/&lt;包名&gt;/。' },
    { t: 'checksum / signature', d: 'dex 文件头的两种校验值（Adler-32 / SHA-1）。内存 dump 后必然失配，需要修复或放宽校验。' },
    { t: 'fart run over', d: 'FART 完成脱壳时在 logcat 中打印的标志（tag 为 ActivityThread），看到它表示主动调用流程结束。' }
  ],

  /* ============================================================== 严师 */
  teacher: {
    id: 'ch2', chapter: 2,
    name: '追问老师 · 第二章',
    sub: '时机、机制、现象——分不清这三样，脱壳就永远靠运气',
    intro: '<p style="margin:0">我不问你 FART 怎么用（那个看文档就行）。我考的是：<b>你为什么在那个时刻 dump？' +
           '为什么拿到的是空方法？看到某个现象你能推出什么？</b><br>' +
           '下面每道题都要用自己的话说全关键点。含糊我会追问，追问三次我直接给答案——但那不算你过关。</p>',
    questions: [
      {
        id: 'c2q1', depth: 1, threshold: 0.7,
        q: '请解释：为什么在加固 App 上直接用 <code>Java.use</code> 会报 <code>ClassNotFoundException</code>？' +
           '要说到<b>机制层面</b>，不能只说"加载器不对"。',
        concepts: [
          { label: '双亲委派机制：先委托父加载器，父加载不了才自己加载', hint: 'ClassLoader 找类的顺序是什么？', any: ['双亲委派', '委托父', '父加载器', 'parent', '向上', '委托链'] },
          { label: 'Java.use 默认用 PathClassLoader，它只认识 APK 里原始的 dex', hint: 'Java.use 默认用的是哪个加载器？它能看到什么？', any: ['PathClassLoader', '默认加载器', '默认的加载器', '原始 dex', 'APK 里的 dex', 'classFactory'] },
          { label: '加固壳用自定义 ClassLoader 加载解密后的真 dex，默认加载器看不到这部分', hint: '真 dex 是谁加载的？', any: ['自定义', 'DexClassLoader', '壳的加载器', '自己的 ClassLoader', '真 dex'] }
        ],
        hints: [
          '想想双亲委派的规则：一个加载器能不能看到"兄弟"加载器加载的类？',
          '真 dex 不是 APK 里那个，它是运行时解密出来的，由谁负责加载它？'
        ],
        probes: [
          '那我再问：如果壳把真 dex 也交给了 PathClassLoader 加载，还会有这个问题吗？为什么？',
          '你切了 Java.classFactory.loader 之后，之前用旧 loader 拿到的类对象还有效吗？'
        ],
        model: '<b>完整机制链条：</b><br><br>' +
          '<b>第一步，理解双亲委派。</b>ClassLoader 收到加载请求时，<b>首先委托父加载器</b>，' +
          '一路向上直到 <code>BootClassLoader</code>；只有当所有父加载器都加载不了时，才调用自己的 <code>findClass</code> 去加载。' +
          '这个设计保证系统核心类不会被用户自定义类覆盖。<br><br>' +
          '<b>第二步，理解 Frida 的默认行为。</b><code>Java.use("com.example.Crypto")</code> 走的是 ' +
          '<code>Java.classFactory.loader</code>，默认值就是 App 的 <code>PathClassLoader</code>。' +
          '而 <code>PathClassLoader</code> 只认识 <b>APK 里原始的 dex</b>（也就是壳的那部分）。<br><br>' +
          '<b>第三步，理解加固壳的做法。</b>壳在运行时解密出真 dex，它<b>不会</b>把真 dex 交给 PathClassLoader，' +
          '而是创建自己的 <code>DexClassLoader</code>（或自定义子类）来加载。' +
          '这是两个<b>平级</b>的加载器——按双亲委派规则，PathClassLoader 看不到 DexClassLoader 加载的类。<br><br>' +
          '<b>结论：</b>不是类名错了，是"你问错了人"。<br><br>' +
          '<b>解法：</b>遍历所有 ClassLoader（<code>Java.enumerateClassLoaders</code>），' +
          '用 <code>loader.findClass(类名)</code> 试探哪个认识目标类，然后 ' +
          '<code>Java.classFactory.loader = loader</code> 切换过去。'
      },
      {
        id: 'c2q2', depth: 2, threshold: 0.75,
        q: '<b>一代壳</b>和<b>抽取壳</b>的本质区别是什么？为什么这个区别决定了你必须用完全不同的技术路线？',
        concepts: [
          { label: '一代壳：整个 dex 被加密，运行时才解密', hint: '一代壳藏的是什么？', any: ['整体加密', '一代壳', '整个 dex', '全部加密', '整体'] },
          { label: '抽取壳：dex 结构完整，只抽走方法体的 code_item（insns）', hint: '抽取壳保留了结构，抽走的是什么？', any: ['code_item', '方法体', 'insns', '指令数组', '结构完整', '抽走'] },
          { label: '一代壳脱壳后直接可用，抽取壳脱壳后是空方法', hint: '两者脱壳结果有什么不同？', any: ['空方法', '空的', '不可用', '空的', 'return', '没代码'] },
          { label: '抽取壳必须主动触发出回填（调用），一代壳只需要找对 dump 时机', hint: '为什么解决手段不一样？', any: ['回填', '主动调用', '触发', '调用', '首次调用', 'Active Call'] }
        ],
        hints: [
          '一个藏的是"整份文件"，一个藏的是"文件里的某几页"。这对你的脱壳方式意味着什么？',
          '如果你只是静静地 dump 内存，能拿到抽取壳的方法体吗？为什么？'
        ],
        probes: [
          '追问：抽取壳的方法体是"什么时候"被回填的？这个时机对你的脱壳策略有什么影响？',
          '如果抽取壳的某个方法永远不被调用（比如是一个冷门分支），你能拿到它的代码吗？怎么办？'
        ],
        model: '<b>本质区别在于"藏什么"和"什么时候给"。</b><br><br>' +
          '<b>一代壳（整体加密壳）：</b><br>' +
          '藏的是<b>整个 dex 文件</b>。APK 里那份是密文，静态分析完全无效。运行时壳解密出完整的 dex，' +
          '再交给 ART 加载。<br>' +
          '<b>→ 脱壳策略：</b>找对 dump 时机。只要在"解密完成 + 结构完整"的窗口把内存抢出来，' +
          '拿到的就是<b>完整可用</b>的 dex。<b>不需要触发任何东西</b>，静静等就行。<br><br>' +
          '<b>抽取壳（二代壳）：</b><br>' +
          '藏的是<b>方法体的 code_item</b>。dex 的结构完整保留——类名、方法名、字段、签名全在，' +
          '所以 ART 能正常加载和链接类。但每个方法的 <code>insns</code>（真正的 dalvik 字节码指令）被抽走了。<br>' +
          '回填发生在方法<b>首次被调用</b>时。<br>' +
          '<b>→ 脱壳策略：</b>光 dump 没用！你 dump 到的所有方法都是空的，因为<b>它们还没被调用过</b>。' +
          '必须<b>主动遍历所有方法并强制调用</b>（Active Call），让壳认为"这个方法要被用了"，从而触发回填，' +
          '然后再 dump。<b>这就是 FART 存在的全部理由。</b><br><br>' +
          '<b>一句话总结：</b><br>' +
          '一代壳的问题是"<b>什么时候</b>dump"（时机问题）<br>' +
          '抽取壳的问题是"<b>怎么让它先给我</b>"（触发问题）<br><br>' +
          '所以：<b>看到"空方法"就说明是抽取壳，必须主动调用；看到"打不开的 dex"才是一代壳，找时机即可。</b>' +
          '<span class="hit">现象直接指认路线——这是本章最实用的诊断技能。</span>',
        after: '<p style="margin-bottom:0">你抓住了本章的核心分野。<b>以后拿到任何一个壳，先问自己：' +
               '我 dump 到的是"打不开"还是"空的"？</b>这一个问题就能定下整条技术路线。</p>'
      },
      {
        id: 'c2q3', depth: 2, threshold: 0.7,
        q: 'FART 的主动调用为什么要用<b>三层嵌套循环</b>？请说出每一层遍历的是什么，以及为什么不能省略任何一层。',
        concepts: [
          { label: '第一层：遍历所有 DexFile（多 dex 机制）', hint: '一个 App 只有一个 dex 吗？', any: ['dex', 'DexFile', '多 dex', '多个 dex', '所有 dex'] },
          { label: '第二层：遍历 DexFile 中所有 ClassDef（类）', hint: '怎么从 dex 到方法？', any: ['类', 'class', 'ClassDef', 'class_defs'] },
          { label: '第三层：遍历类中所有方法，且 direct_methods 与 virtual_methods 两组都要', hint: 'dex 里方法分成几组？', any: ['方法', 'method', 'direct', 'virtual', '两组', '所有方法'] },
          { label: '任何一层漏掉都会导致脱壳不完整', hint: '漏掉会怎样？', any: ['不完整', '遗漏', '漏', '缺失', '不全'] }
        ],
        hints: [
          '从"文件"到"代码"，中间的层级是什么？一层层数下来。',
          'dex 格式里，方法被分成了几组存放？'
        ],
        probes: [
          '追问：如果加固在运行时又动态加载了一个新 dex（不在最初的列表里），FART 的遍历能覆盖到吗？',
          '为什么"每个方法都要单独 dump"而不是"最后统一 dump 整个 dex"？'
        ],
        model: '<b>三层循环对应"文件 → 类 → 方法"的层级结构：</b><br><br>' +
          '<b>第一层：遍历所有 DexFile。</b><br>' +
          '一个 App 可以有<b>多个 dex</b>（Android 的多 dex 机制，方法数超过 65536 时必须分包）。' +
          '加固还会把关键代码放在后面的 dex，甚至运行时动态加载新 dex。' +
          '只处理第一个 dex，脱壳结果必然不完整。<br><br>' +
          '<b>第二层：遍历每个 DexFile 中的所有 ClassDef。</b><br>' +
          'dex 头部的 <code>class_defs</code> 数组记录了所有类定义。逐个读取，得到类列表。<br><br>' +
          '<b>第三层：遍历类中的所有方法。</b><br>' +
          '这里有个<b>极易出错</b>的细节：dex 把方法分成两组存放——' +
          '<code>direct_methods</code>（私有方法、构造方法、静态方法）和 ' +
          '<code>virtual_methods</code>（可被重写的实例方法）。' +
          '<b>两组都必须遍历</b>。只处理一组是最常见的实现 bug，会导致大量方法漏掉。<br><br>' +
          '<b>为什么不能省任何一层：</b><br>' +
          '因为抽取壳的<b>回填是逐方法发生的</b>。你少遍历一个方法，它就永远不会被回填，' +
          'dump 出来就是空的。<b>脱壳完整度 = 遍历覆盖率</b>，没有捷径。<br><br>' +
          '<b>补充一个工程细节：</b>为什么要"每 dump 一个方法就写一次文件"而不是最后统一写？' +
          '因为遍历过程很长（几千个方法），中间可能崩溃。<b>增量 dump 保证已拿到的部分不会丢</b>——' +
          '这是可靠性的考虑。'
      },
      {
        id: 'c2q4', depth: 3, threshold: 0.7,
        q: '<b>综合题：</b>你拿到一个从没见过的加固 App。请描述你的<b>完整诊断与脱壳流程</b>——' +
           '从判断壳的类型开始，到最终能反编译看到代码为止。要说清每一步"根据什么现象做什么判断"。',
        concepts: [
          { label: '先用 jadx/静态分析看 APK 里的 dex，判断是一代壳还是能看到结构', hint: '第一步做什么？', any: ['jadx', '静态', '先看', '打开', 'APK', '判断'] },
          { label: '脱壳（内存 dump / FART），观察产物：打不开→一代壳，空方法→抽取壳', hint: '怎么根据现象判断壳类型？', any: ['空方法', '打不开', '判断', '现象', '一代壳', '抽取壳'] },
          { label: '如果是抽取壳，脱壳前先跑遍 App 所有功能，提高回填覆盖率', hint: '抽取壳有什么提权完整度的技巧？', any: ['跑一遍', '点一遍', '所有功能', '遍历功能', '覆盖率', '触发'] },
          { label: '修复 dex（checksum/signature/map）或用定制 jadx 放宽校验', hint: 'dump 出的 dex 为什么打不开？', any: ['修复', 'checksum', 'signature', 'map', '定制 jadx', '校验'] },
          { label: '如果方法体仍缺失，用 Frida 手动调用目标方法补触发', hint: '冷门方法拿不到怎么办？', any: ['手动调用', 'Frida 调用', '主动', '补', '调用一次'] }
        ],
        hints: [
          '第一件事不是脱壳，是"看清楚对手是什么"。你怎么用最便宜的手段判断壳的类型？',
          '抽取壳的完整度和什么成正比？你可以在脱壳前做什么来提升它？'
        ],
        probes: [
          '如果跑遍所有功能后，你最关心的那个方法依然是空的，你会怎么想、怎么做？',
          '如果发现关键函数是自定义字节码（不是空方法，而是看不懂的跳转），你的路线要怎么变？'
        ],
        model: '<b>完整诊断与脱壳流程（六步）：</b><br><br>' +
          '<b>第一步：静态侦察（最便宜的一步先做）。</b><br>' +
          '用 jadx 直接打开 APK。<br>' +
          '• 如果只能看到壳的代码，业务类完全不可见 → <b>疑似一代壳</b><br>' +
          '• 如果能看到完整的类名、方法名、字段，但方法体是空的 → <b>抽取壳</b><br>' +
          '• 如果结构完整、方法体也有，但代码是"跳进解释器"的样子 → <b>VMP</b><br>' +
          '这一步零成本，却能定下整条路线。<br><br>' +
          '<b>第二步：判断是否需要先跑一遍 App。</b><br>' +
          '如果是抽取壳 → <b>脱壳前把 App 的每个界面、每个按钮、每个功能点都操作一遍</b>。' +
          '因为抽取壳只回填"被调用过"的方法，你跑得越全，脱壳越完整。<br>' +
          '这一步常被忽略，但效果显著。<br><br>' +
          '<b>第三步：执行脱壳。</b><br>' +
          '• 一代壳 → 内存 dump（找加载时机，或在 ART 加载 dex 的点截获）<br>' +
          '• 抽取壳 → FART 主动调用（遍历所有 DexFile × 类 × 方法，强制调用触发回填）<br>' +
          'FART 完成时 logcat 会打印 <code>fart run over</code>，产物在 <code>/sdcard/fart/&lt;包名&gt;/</code>。<br><br>' +
          '<b>第四步：检查产物，验证脱壳质量。</b><br>' +
          '• 产物文件大小是否合理？（太小说明没脱到东西）<br>' +
          '• 有多少方法体是非空的？（覆盖率够不够）<br>' +
          '• 目标方法有没有内容？<br><br>' +
          '<b>第五步：修复 dex。</b><br>' +
          'dump 出的 dex 必然有 <code>checksum</code> / <code>signature</code> 失配、map 段可能缺失的问题。' +
          '用修复工具重新计算并写回，或用<b>定制版 jadx</b> 放宽校验。<br>' +
          '（另有 <code>baksmali</code> 可选，对结构问题容忍度更高。）<br><br>' +
          '<b>第六步：补齐遗漏的方法。</b><br>' +
          '如果目标方法仍为空（冷门分支、需要特定参数才走到），用 Frida 手动调用它一次：<br>' +
          '<code>Java.perform(() =&gt; { Java.use("...").targetMethod("test"); });</code><br>' +
          '然后再脱一次。<br><br>' +
          '<b>如果卡在 VMP：</b>路线完全不同——需要理解解释器结构、动态 Trace 构建映射表（第 20 章），' +
          '或者放弃脱壳，直接用 unidbg 黑盒调用拿结果（第 21 章）。<br><br>' +
          '<span class="hit">整个流程的核心思想：<b>用最便宜的手段先判断类型，再选路线；' +
          '每完成一步都验证现象，根据现象调整下一步。</b></span>'
      },
      {
        id: 'c2q5', depth: 1, threshold: 0.7,
        q: '为什么内存 dump 出来的 dex 用 jadx 打开会报 checksum 错误？这是脱壳失败了吗？',
        concepts: [
          { label: 'dex 文件头有 checksum（Adler-32）和 signature（SHA-1）校验值', hint: '文件头里存了什么校验信息？', any: ['checksum', 'signature', '校验', 'adler', 'sha', '文件头'] },
          { label: '内存 dump 时内容变了（方法体回填），但文件头记录的还是旧值', hint: '为什么校验会失配？', any: ['内容变了', '回填', '没更新', '旧值', '不一致', '改了'] },
          { label: '不是失败——这恰恰说明脱壳基本成功，只需要修复或放宽校验', hint: '这是失败还是正常现象？', any: ['正常', '不是失败', '成功', '修复', '放宽', '定制 jadx'] }
        ],
        hints: [
          '文件头里存了用来校验的数值。如果内容变了但数值没变，会怎样？',
          '如果整个文件都是垃圾，jadx 会报什么错？和 checksum 错误一样吗？'
        ],
        probes: [
          '追问：既然校验值错了，为什么不干脆把它删掉或者填 0？',
          '除了 checksum，修复时还要注意什么？'
        ],
        model: '<b>先解释校验机制：</b><br><br>' +
          'dex 文件头（<code>header_item</code>）里有两个校验字段：<br>' +
          '• <code>checksum</code>：Adler-32 校验，覆盖 magic 之后的全部文件内容<br>' +
          '• <code>signature</code>：SHA-1 签名，覆盖 signature 字段之后的全部内容<br><br>' +
          '<b>为什么会失配：</b><br>' +
          '内存 dump 的过程中，内容发生了变化——最典型的是抽取壳的方法体被回填（空的 code_item 变成了真指令）。' +
          '但文件头里记录的 checksum / signature <b>还是原始 dex 的值，没有跟着更新</b>。<br>' +
          '于是校验一算，对不上。<br><br>' +
          '<b>这不是脱壳失败——恰恰相反，它说明你 dump 到的是真东西。</b><br>' +
          '对比一下：如果脱壳彻底失败（dump 到的是密文或垃圾），jadx 会报"不是有效的 dex 文件"（魔数都不对）。' +
          '而 checksum 错误意味着<b>文件结构是对的、内容是 dex，只是校验值过期了</b>。<br><br>' +
          '<b>两条出路：</b><br>' +
          '① <b>修复</b>（推荐）：重新计算 checksum 与 signature 并写回，同时补全 map 段。修完标准 jadx 就能打开。' +
          'FART 自带的修复组件做这件事。<br>' +
          '② <b>放宽</b>：用定制版 jadx 跳过校验。快，但 map 段有问题时反编译结果可能不完整。<br><br>' +
          '<b>为什么不直接删掉校验值：</b>因为 <code>header_size</code>、<code>map_off</code> 以及各索引区的偏移' +
          '都基于文件起始位置计算，删字节会让<b>整个文件结构错位</b>，彻底无法解析。正确做法是"重算并写回"，而不是"删除"。'
      }
    ]
  }
};
