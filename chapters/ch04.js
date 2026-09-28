/* 第 4 章 · C++11 & ART 打造动态分析沙箱
   数据文件（浏览器脚本，ES 模块语法在此不可用） */
window.CHAPTER = {
  no: 4,
  title: 'C++11 & ART 打造动态分析沙箱',
  lede: '前面几章我们一直在<strong>用</strong>别人的工具。这一章换一个身份：不再当工具的用户，而是当虚拟机的作者——自己读 ART 源码、自己插桩、自己编译，把 Android 变成一个「你说什么都记下来」的<strong>动态分析沙箱</strong>。',
  meta: [
    '核心问题：<b>一次 Java 方法调用在 Native 层到底走了几层指针？为什么读懂 ART 必须先过 C++11？</b>',
    '关键工具：<b>auto / decltype / lambda / 模板 / RAII · mirror::Object · mirror::Class · ArtMethod · RegisterNatives</b>',
    '对手：<b>动态注册 + 抽取壳。符号表被抹掉、真实地址运行时才产生，静态分析从这里断线</b>'
  ],

  sections: [
    /* ================= 4.1 ================= */
    {
      h: '4.1',
      title: '换一个身份：从工具使用者到虚拟机作者',
      intuition: {
        tag: '直觉模型 · 换掉地基而不是换家具',
        body: '<p>别人给的房子，你只能挪家具：装个 Frida 脚本、改改 smali，房东（ART 虚拟机）不高兴就把你赶出去。' +
              '自己盖房子，你可以<strong>在地基里埋传感器</strong>——哪根管子流过什么，你天生就知道。' +
              '本章说的「定制 ART」，就是自己浇一遍地基。</p>' +
              '<p>代价是：地基是 C++ 写的，而且是<strong>现代 C++</strong>。你连图纸都读不懂，就别谈改图纸。</p>'
      },
      html:
        T.note('key', '🔑 本章主线',
          '<p>整章只干三件事：<b>①</b> 能读懂 ART 的 C++ 代码（<span class="term" data-def="C++11 及以后的标准，AOSP 的 ART 大量使用其语法">C++11</span> 语法关）；' +
          '<b>②</b> 看懂 ART 把 Java 对象和方法放在内存的哪里（对象模型关）；' +
          '<b>③</b> 在 JNI 动态注册那一刻埋一个记录点（插桩实战关）。</p>') +
        '<p>为什么非得自己编译虚拟机？因为 <strong>Native 保护的战场上，符号和地址正在消失</strong>：' +
        '<span class="term" data-def="JNI 函数不是靠名字导出，而是在运行时用 RegisterNatives 把函数地址交给虚拟机">动态注册</span> 让导出表里空空如也，' +
        '抽取壳把方法体抽走让静态反编译看到一具空壳。静态分析断线的地方，只有运行时能接上——' +
        '而运行时里最权威的位置，不是 hook 框架，是<strong>虚拟机内部的注册函数本身</strong>。</p>' +
        T.grid(2, [
          '<div class="card"><div class="card-title">👤 工具使用者</div><p>在 <span class="mono">JNI_OnLoad</span> 外面挂 hook，' +
          '指望自己比目标先抢到函数；被检测、被杀、被反调试绕开。你控制的是<b>外部</b>。</p></div>',
          '<div class="card"><div class="card-title">🛠️ 虚拟机作者</div><p>在 ART 源码里给 <span class="mono">RegisterNatives</span> 加两行日志，' +
          'Java 方法与 Native 地址的映射在你眼前自动铺开。你控制的是<b>内部</b>。</p></div>'
        ]),
      after: T.note('', '🧭 一句话总结这层的差别',
        '<p>Hook 是在<strong>别人家的流程上加旁路</strong>，天生要与反调试对抗；定制虚拟机是<strong>改流程本身</strong>。' +
        '前者拼隐蔽，后者拼信息完备——从「生成侧」看，注册这一事实在发生的那一刻就是完全公开的。</p>')
    },

    /* ================= 4.2 ================= */
    {
      h: '4.2',
      title: 'ART 对象模型：一条指针链走完一次方法调用',
      html:
        '<p>Java 世界里 <span class="mono">new</span> 出来的对象、<span class="mono">.method()</span> 的调用，在 Native 层全是结构体和指针。' +
        'ART 用三层结构描述这件事，把这三层记牢，后面读源码就像看地图。</p>' +
        T.tbl(['层级', 'C++ 类型', '它回答的问题'], [
          ['对象头', 'mirror::Object', '「我是什么类？」—— 含 klass_ 指针与 monitor 锁信息'],
          ['类镜像', 'mirror::Class', '「我有哪些方法和字段？」—— 方法表、字段表、vtable、接口表'],
          ['方法元数据', 'ArtMethod', '「我这个方法怎么执行？」—— 声明类、访问标志、Dex 偏移、执行入口']
        ]) +
        T.note('key', '🔑 关键类比',
          '<p>这套分层与 HotSpot 的「对象头 = mark word + klass pointer」是同一个思路：对象本身不携带方法代码，' +
          '只携带一个<strong>指向自己类描述的指针</strong>。方法是「类的属性」，不是「对象的属性」。</p>') +
        '<p>下面把这条链一步步走一遍。注意右侧内存表格里<strong>每一次写入</strong>——那些就是你在 <span class="mono">gdb</span> 里真正会看到的东西。</p>',
      stage: {
        title: '一次 Java 方法调用的完整寻址路径',
        speed: 1600,
        render:
          '<div class="flow-row" style="flex-wrap:wrap;gap:8px;align-items:center">' +
            '<span class="blk" id="b_obj">Java 对象<br><span class="small">MyBean 实例</span></span>' +
            '<span class="arrow" id="a1">—</span>' +
            '<span class="blk" id="b_mo">mirror::Object<br><span class="small">对象头</span></span>' +
            '<span class="arrow" id="a2">—</span>' +
            '<span class="blk" id="b_mc">mirror::Class<br><span class="small">类镜像</span></span>' +
            '<span class="arrow" id="a3">—</span>' +
            '<span class="blk" id="b_am">ArtMethod<br><span class="small">方法元数据</span></span>' +
          '</div>' +
          '<div style="margin-top:10px"><span class="pill" id="clsbox">类尚未解析</span></div>' +
          '<div class="grid2" style="margin-top:10px">' +
            '<div><div class="card-title">对象实例内存（64 位）</div><div class="memgrid">' +
              '<div class="memrow"><span class="addr">+0x00</span><span class="cell" id="o_klass">klass_ = ?</span></div>' +
              '<div class="memrow"><span class="addr">+0x08</span><span class="cell" id="o_mon">monitor_ = ?</span></div>' +
              '<div class="memrow"><span class="addr">+0x10</span><span class="cell" id="o_name">name = ?</span></div>' +
              '<div class="memrow"><span class="addr">+0x18</span><span class="cell" id="o_age">age = ?</span></div>' +
            '</div></div>' +
            '<div><div class="card-title">ArtMethod 内存</div><div class="memgrid">' +
              '<div class="memrow"><span class="addr">+0x00</span><span class="cell" id="m_dc">declaring_class_ = ?</span></div>' +
              '<div class="memrow"><span class="addr">+0x08</span><span class="cell" id="m_af">access_flags_ = ?</span></div>' +
              '<div class="memrow"><span class="addr">+0x10</span><span class="cell" id="m_dex">dex_code_item_offset_ = ?</span></div>' +
              '<div class="memrow"><span class="addr">+0x18</span><span class="cell" id="m_entry">entry_point_..._code_ = ?</span></div>' +
            '</div></div>' +
          '</div>',
        reset: () => {
          S('b_obj', ''); S('b_mo', ''); S('b_mc', ''); S('b_am', '');
          CLS('a1', 'arrow'); CLS('a2', 'arrow'); CLS('a3', 'arrow');
          SET('a1', '—'); SET('a2', '—'); SET('a3', '—');
          CLS('clsbox', 'pill'); SET('clsbox', '类尚未解析');
          const cells = ['o_klass', 'o_mon', 'o_name', 'o_age', 'm_dc', 'm_af', 'm_dex', 'm_entry'];
          for (const c of cells) CLS(c, 'cell');
          SET('o_klass', 'klass_ = ?'); SET('o_mon', 'monitor_ = ?');
          SET('o_name', 'name = ?'); SET('o_age', 'age = ?');
          SET('m_dc', 'declaring_class_ = ?'); SET('m_af', 'access_flags_ = ?');
          SET('m_dex', 'dex_code_item_offset_ = ?'); SET('m_entry', 'entry_point_..._code_ = ?');
        },
        steps: [
          { run: () => { S('b_obj', 'active'); },
            note: '<b>起点：栈上有一个对象引用。</b>Java 代码里写下 <span class="mono">b.getName()</span>，到 Native 层只剩一个指针——它不是「对象本体」，而是<b>指向堆上对象内存的地址</b>。',
            state: { '阶段': '取对象地址', '类型': 'mirror::Object*' } },
          { run: () => { S('b_obj', 'active'); CLS('o_klass', 'cell hi'); SET('o_klass', 'klass_ = 0x7f2a1000'); },
            note: '<b>第一跳：读对象头里的 klass_。</b>对象内存最开头的字段就是 <span class="mono">klass_</span>，类型是 <span class="mono">mirror::Class*</span>。它回答「我是什么类」。',
            state: { '读地址': 'obj + 0x00', '得到': 'mirror::Class*' } },
          { run: () => { S('b_obj', 'done'); S('b_mo', 'active'); CLS('o_mon', 'cell wr'); SET('o_mon', 'monitor_ = 0x0（未锁）'); },
            note: '<b>对象头的另一半：monitor 锁信息。</b>和 HotSpot 的 mark word 一样，锁状态、哈希、GC 标记这些「与类无关」的信息也塞在头部。此刻没人持有锁，值为空。',
            state: { '锁状态': 'unlocked' } },
          { run: () => { SET('a1', '—klass_→'); CLS('a1', 'arrow'); S('b_mo', 'done'); S('b_mc', 'active'); CLS('clsbox', 'pill acc'); SET('clsbox', 'MyBean.class → 0x7f2a1000'); },
            note: '<b>第二跳：拿到 mirror::Class。</b>这就是 <span class="mono">MyBean.class</span> 在 Native 层的真身：整个 JVM 里 <b>MyBean 只有一份</b> Class 对象，所有 MyBean 实例共享它。',
            state: { '实例数': 'N 个', 'Class 对象数': '1 个' } },
          { run: () => { SET('a2', '→ 方法表'); S('b_mc', 'active'); CLS('clsbox', 'pill ok'); SET('clsbox', '解析 getName() 的方法表槽位'); },
            note: '<b>第三跳：在类里找方法。</b>mirror::Class 里存着方法表（methods_）和 vtable（虚方法表）。调用 <span class="mono">getName()</span> 就是在这些表里定位到一个 <span class="mono">ArtMethod</span> 槽位。',
            state: { '查找': 'method table / vtable', '结果': 'ArtMethod*' } },
          { run: () => { S('b_mc', 'done'); S('b_am', 'active'); CLS('m_dc', 'cell hi'); SET('m_dc', 'declaring_class_ = 0x7f2a1000'); },
            note: '<b>落到 ArtMethod：declaring_class_。</b>每个 Java 方法在 ART 里是一个 <span class="mono">ArtMethod</span> 结构体。第一个字段告诉你「我声明在哪个类里」——这也是 Hook 时用来判断有没有找错方法的关键。',
            state: { '字段': 'declaring_class_' } },
          { run: () => { CLS('m_af', 'cell wr'); SET('m_af', 'access_flags_ = 0x0001 (public)'); },
            note: '<b>access_flags_：方法的访问标志。</b>public / static / final / native / synchronized 全挤在这一个位图里。记住这个字段——<b>后面 Hook 的第一刀就砍在这里</b>。',
            state: { 'flags': '0x0001' } },
          { run: () => { CLS('m_dex', 'cell'); SET('m_dex', 'dex_code_item_offset_ = 0x1a4c'); },
            note: '<b>dex_code_item_offset_：源码在哪里。</b>指向该方法在 DEX 文件里 code_item 的偏移。壳如果把方法体抽走，这个偏移指向的就是空壳——<b>静态分析断线的正是这里</b>。',
            state: { '指向': 'DEX code_item' } },
          { run: () => { CLS('m_entry', 'cell hi'); SET('m_entry', 'entry = 0x7f6c9e40'); S('b_am', 'hot'); },
            note: '<b>entry_point_from_quick_compiled_code_：真正会执行的地址。</b>这是整条链的终点，也是最有价值的一个字段。它可能是解释器入口、JIT 编译后的机器码、或 AOT 产物——取决于运行时。',
            state: { '入口类型': '解释器 / JIT / AOT' } },
          { run: () => { S('b_am', 'hot'); CLS('clsbox', 'pill ok'); SET('clsbox', '获取到可执行入口 → 跳转执行'); },
            note: '<b>最后一个动作：跳过去。</b>ART 并不「解释」这个字段，它直接把它当函数指针调用。所以谁能改这个字段，谁就能改变这个 Java 方法的行为。',
            state: { '调用': 'jump entry' } },
          { run: () => { S('b_obj', 'cool'); S('b_mo', 'cool'); S('b_mc', 'cool'); S('b_am', 'cool'); CLS('clsbox', 'pill ok'); SET('clsbox', '一次调用完成：3 次指针解引用'); },
            note: '<b>回顾整条链：对象 → klass_ → 方法表 → ArtMethod → 入口。</b>3 次指针解引用就是一次 Java 方法调用在 Native 层的全部寻址成本。理解这条链，就理解了后面所有 Hook 手段的地基。',
            state: { '解引用次数': '3', '最短 Hook 点': 'ArtMethod.entry' } }
        ]
      },
      after: T.note('warn', '⚠️ 版本差异提醒',
        '<p>ArtMethod 的字段名与偏移在 AOSP 不同版本间改过（例如入口字段的命名与拆分方式）。' +
        '字段<strong>语义</strong>是稳定的（声明类 / 标志 / Dex 偏移 / 执行入口），但具体<strong>名字和偏移</strong>请以你手上的版本源码为准。' +
        '<span class="pill warn">待核实</span></p>')
    },

    /* ================= 4.2L 动手实验 ================= */
    {
      h: '4.2L', title: '动手实验：推演双亲委派，定位"类找不到"',
      html:
        '<p>第 1 章里那个 <code>ClassNotFoundException</code>，本质是<b>双亲委派规则</b>的必然结果。' +
        '这个实验让你把委托链走一遍，亲眼看到它为什么找不到。</p>',
      lab: {
        title: '实验：ClassLoader 委托链推演',
        goal: '目标：判断该用哪个加载器',
        intro:
          '<p>一个加固 App 的加载器布局如下：</p>' +
          '<div class="tbl-wrap" style="margin:12px 0"><table class="tbl">' +
          '<thead><tr><th>加载器</th><th>负责加载什么</th><th>它认识的类</th></tr></thead><tbody>' +
          '<tr><td><code>BootClassLoader</code></td><td>系统核心类</td><td><code>java.lang.String</code>、<code>android.app.Activity</code></td></tr>' +
          '<tr><td><code>PathClassLoader</code>（默认）</td><td>APK 里原始的 dex</td><td><code>com.shell.StubApp</code>、<code>com.shell.ProxyApplication</code></td></tr>' +
          '<tr><td><code>DexClassLoader</code>（壳的）</td><td>运行时解密的真 dex</td><td><code>com.example.Crypto</code>、<code>com.example.Sign</code></td></tr>' +
          '</tbody></table></div>' +
          '<p><b>任务：你要 hook <code>com.example.Crypto</code>，用 <code>Java.use</code> 直接写会怎样？该怎么解决？</b></p>',
        inputs: [
          { key: 'target', label: '① 你要找的类名', hint: '填实验里那个目标类', ph: 'com.example.XXX', value: 'com.example.Crypto' },
          { key: 'result', label: '② 默认加载器能找到它吗？为什么？', hint: '想想双亲委派的顺序', ph: '能/不能，因为……', type: 'textarea', rows: 2 }
        ],
        runLabel: '🔍 推演委托链',
        run: (v) => {
          const L = window.LABX;
          const target = String(v.target || '').trim() || 'com.example.Crypto';
          const chain = L.classLoaderChain(target, {
            boot: ['java.lang.String', 'android.app.Activity'],
            path: ['com.shell.StubApp', 'com.shell.ProxyApplication'],
            custom: ['com.example.Crypto', 'com.example.Sign']
          });

          let html = '<div class="lab-kv"><span>目标类 <b>' + target + '</b></span>'
            + '<span>委派顺序 <b>Boot → Path → Custom</b></span></div>';

          html += '<table class="lab-tbl"><tr><th>#</th><th>加载器</th><th>职责</th><th>认识目标类？</th></tr>';
          chain.trace.forEach((t, i) => {
            html += '<tr class="' + (t.hit ? 'same' : '') + '"><td>' + (i + 1) + '</td>'
              + '<td><code>' + t.loader + '</code></td>'
              + '<td style="font-size:12px">' + t.role + '</td>'
              + '<td>' + (t.hit ? '✅ 命中，停止委派' : '❌ 不认识，继续往下') + '</td></tr>';
          });
          html += '</table>';

          if (chain.delegated) {
            html += '<div class="lab-msg fail"><b>❌ 默认加载器（PathClassLoader）找不到它</b>'
              + '<div class="lab-note">这是双亲委派的必然结果：<br>'
              + '<code>Java.use</code> 默认用 <code>Java.classFactory.loader</code>，也就是 App 的 <b>PathClassLoader</b>。'
              + '它只能看到 APK 里原始的 dex（壳的代码）。<br>'
              + '而真 dex 是 <b>壳自己 new 出来的 DexClassLoader</b> 加载的 —— '
              + '两者是<b>平级</b>的加载器，<b>Path 看不到 Custom 加载的类</b>。</div>'
              + '<div class="lab-note"><b>解法：</b>遍历所有加载器，找到能加载目标类的那一个，然后切换：<br>'
              + '<code>Java.enumerateClassLoaders({ onMatch: l =&gt; { if (l.findClass("' + target + '")) Java.classFactory.loader = l; } })</code>'
              + '</div></div>';
          } else {
            html += '<div class="lab-msg pass"><b>✅ 默认加载器就能找到它</b>'
              + '<div class="lab-note">这个类属于壳自己的 dex（或普通未加固的 App），'
              + 'PathClassLoader 直接可见，不需要切换加载器。</div></div>';
          }

          html += '<div class="lab-msg key"><b>🔑 记住这条诊断规则</b>'
            + '<div class="lab-note"><b>报 <code>ClassNotFoundException</code> 时，先别怀疑类名写错了</code></b>——'
            + '99% 是<b>用错了加载器</b>。<br><br>'
            + '判断方法：问自己"这个类是谁加载的？"<br>'
            + '• 系统类 → BootClassLoader（Java.use 能直接拿到）<br>'
            + '• App 自己的类（未加固）→ PathClassLoader（能直接拿到）<br>'
            + '• <b>加固后的业务类 → 壳的 DexClassLoader（拿不到，必须切换）</b></div></div>';
          return html;
        },
        expected: (v) => {
          const res = String(v.result || '').trim();
          if (!res) return { ok: false, detail: '先回答第②问：默认加载器能找到它吗？' };
          const saysNo = window.AKKC_hasConcept(res, ['不能', '找不到', '看不到', '不行', 'no', '无法']);
          const saysWhy = window.AKKC_hasConcept(res, ['双亲委派', '委派', '自定义', 'DexClassLoader', '壳', '平级', '不同的加载器', '默认']);
          const ok = saysNo && saysWhy;
          return {
            ok,
            detail: ok
              ? '<b>完全正确。</b>默认加载器（PathClassLoader）<b>看不到</b>壳的自定义 DexClassLoader 加载的类 —— ' +
                '因为双亲委派保证的是"向上委托"，而<b>平级加载器之间互相不可见</b>。<br>' +
                '解法：<code>Java.enumerateClassLoaders</code> 遍历找对的那一个，再设 <code>Java.classFactory.loader</code>。'
              : (!saysNo
                  ? '<b>结论错了：默认加载器找不到它。</b>' +
                    '因为真 dex 不是 APK 里那个，而是壳运行时用自定义 DexClassLoader 加载的。'
                  : '<b>结论对，但理由不够。</b>补上关键机制：<b>双亲委派只向上委托，平级加载器互不可见</b>。' +
                    '所以 PathClassLoader 看不到 DexClassLoader 加载的类。')
          };
        },
        showAnswer:
          '【① 目标类】com.example.Crypto\n\n' +
          '【② 默认加载器能找到吗】不能。\n\n' +
          '推演委托链（Java.use 默认用 PathClassLoader）：\n' +
          '  1. PathClassLoader 收到请求\n' +
          '  2. 先委托父加载器 BootClassLoader\n' +
          '     → Boot 只认识 java.* / android.*，不认识 com.example.Crypto → 失败\n' +
          '  3. 父加载器都失败了，PathClassLoader 自己动手\n' +
          '     → 它只加载 APK 里原始的 dex（壳的代码：com.shell.*）→ 失败\n' +
          '  4. 抛出 ClassNotFoundException\n\n' +
          '关键：真 dex 是由【壳自己创建的 DexClassLoader】加载的。\n' +
          '      它与 PathClassLoader 是【平级】关系，\n' +
          '      而双亲委派只保证"向上委托"，【平级加载器之间互相不可见】。\n\n' +
          '【解法】切换加载器：\n' +
          '  Java.enumerateClassLoaders({\n' +
          '    onMatch: function (loader) {\n' +
          '      try {\n' +
          '        if (loader.findClass("com.example.Crypto")) {\n' +
          '          Java.classFactory.loader = loader;   // 切换\n' +
          '        }\n' +
          '      } catch (e) {}\n' +
          '    }, onComplete: function () {}\n' +
          '  });\n' +
          '  然后 Java.use("com.example.Crypto") 就能用了。',
        hint:
          '关键在于理解<b>双亲委派的方向性</b>：它只保证"<b>向上</b>委托父加载器"，' +
          '但<b>没有规定平级加载器之间能互相看见</b>。<br><br>' +
          '问自己两个问题：<br>' +
          '① 真 dex 是谁加载的？是 APK 里那个 PathClassLoader，还是壳自己 new 出来的另一个？<br>' +
          '② 如果它们是两个平级的加载器，PathClassLoader 能看见另一个加载的类吗？',
        after:
          T.note('ok', '✅ 实验的收获',
            '<p style="margin-bottom:0">你现在有了一个<b>可复用的诊断流程</b>：<br>' +
            '遇到 <code>ClassNotFoundException</code> → <b>不要先怀疑类名</b> → ' +
            '直接上 <code>Java.enumerateClassLoaders</code> 找对的加载器。<br><br>' +
            '<span class="hit">这个判断在第 1、2、4、10 章反复用到，是本课程最实用的技巧之一。</span><br>' +
            '本质上你用的还是那条元原则：<b>先诊断（这个类归谁管），再动手（用哪个加载器）。</b></p>')
      }
    },

    /* ================= 4.3C 实战案例 ================= */
    {
      h: '4.3C', title: '实战案例：从 ELF-Loader 到自定义 Linker',
      case: {
        source: 'kanxue',
        title: '[原创]Android从ELF-Loader到自定义Linker的实现及原理',
        date: '2026-4-4',
        author: '东方玻璃',
        target: '作者自研 SelfDefineLoader / ELF-Loader；测试样本 libtestdemo.so + 宿主 libselfdefineloader.so；参考真实样本 zgcbank-4.5.1',
        background:
          '<p>本课一直在讲「把观测点放到更低的层级」。这篇帖子把它做成了工程：作者从零写了一个 <b>ELF Loader</b>，' +
          '再把它推进成 <b>自定义 Linker</b>（SelfDefineLoader），用来加载自己的 <code>libtestdemo.so</code>，' +
          '宿主是 <code>libselfdefineloader.so</code>，参考样本是 <b>zgcbank-4.5.1</b>。</p>' +
          '<p>它的路线很朴素：<b>先拿 200 多行 x86 代码把「装载一个 ELF」这件事完整打通，再移植到 AArch64</b>。' +
          '这条路上有两个坑特别典型——<b>一个是缓存一致性，一个是 maps 里看不见自己</b>。下面按原帖复述。</p>',
        points: [
          '第一步用 <b>200 多行 x86</b> 代码打通 <b>9 步</b>流程：<code>mapFile</code> → <code>checkElfHeader</code> → <code>allocImage</code> → <code>loadSegments</code>（含 BSS 清零）→ <code>parseDynamic</code> → <code>loadDeps</code> → <code>relocate</code> → <code>setProtection</code> → 跳到 <code>e_entry</code>。',
          '移植到 <b>AArch64</b> 有 <b>5 处</b>差异：<code>EM_AARCH64=183</code>、<code>PAGE_START</code>/<code>PAGE_END</code> 宏、额外解析 <code>DT_GNU_HASH</code>/<code>DT_HASH</code>、改用 <code>Elf64_Rela</code> 且多出 <code>R_AARCH64_ABS64</code>。',
          '<b>第 5 处差异最要命</b>：写完代码段之后<b>必须调用 <code>__builtin___clear_cache</code></b>，否则 <b>D-Cache 与 I-Cache 不一致，直接 SIGILL</b>。',
          '<code>callInit</code> 分三层依次调用：<code>.init</code> → <code>.init_array</code> → <code>getSymbol("JNI_OnLoad")</code>。',
          '用 <code>constructor(101)</code> / <code>constructor(102)</code> / 不带优先级三个函数验证 <code>.init_array</code> 的<b>顺序与次数</b>，期望结果是 <code>initFlag=1</code>、<code>initArrayCount=101</code>。',
          '构建上，CMake 用 <code>EXCLUDE_FROM_ALL</code> 让它<b>不被打进包里</b>；<code>adb push</code> 到 <code>/data/local/tmp</code> 后需要 <code>setenforce 0</code> 才能加载。',
          '加载效果的直接证据：<b><code>/proc/self/maps</code> 里没有文件路径</b>——so 是从匿名内存起来的。',
          '配套给出 <code>scan_hidden_modules.js</code>：用 <code>enumerateRanges</code> 找 r-x 段 + 校验 ELF magic，用 <code>enumerateModules</code> 做白名单排除，再解析 Phdr 算出 fullSize 后 dump，最后交给 <b>SoFixer</b> 修复。',
          '对抗侧的手段叫 <code>wipeElfHeaders</code>：抹掉 ELF Header / Phdr / Dynamic，并且<b>先 mprotect 改权限、再恢复回去</b>。该功能在原帖代码中<b>默认是注释掉的</b>。',
          '源码阅读上做了版本对照：<b>Android 4.4.4_r1</b>（32 位，<code>find_library_internal</code> 是串行的）对比 <b>Android 10.0.0_r47</b>（<code>android_dlopen_ext</code> + <code>find_libraries</code> 随机序的 LoadTask 7 步流程）。'
        ],
        method: [
          '先在 x86 上把 Loader 打通：<code>mapFile</code> 读文件、<code>checkElfHeader</code> 验头、<code>allocImage</code> 申请镜像、<code>loadSegments</code> 搬段并清零 BSS、<code>parseDynamic</code> 解动态段、<code>loadDeps</code> 递归加载依赖、<code>relocate</code> 做重定位、<code>setProtection</code> 落权限，最后跳 <code>e_entry</code>。',
          '移植到 AArch64，逐条对齐 5 处差异：<code>EM_AARCH64=183</code>、<code>PAGE_START</code>/<code>PAGE_END</code> 宏、补上 <code>DT_GNU_HASH</code>/<code>DT_HASH</code> 解析、把重定位条目换成 <code>Elf64_Rela</code> 并处理 <code>R_AARCH64_ABS64</code>。',
          '补上 <code>__builtin___clear_cache</code>：写完全新的代码段之后，必须显式同步指令缓存，否则取指会拿到旧内容并触发 <b>SIGILL</b>。',
          '按三层顺序跑初始化：<code>.init</code> → <code>.init_array</code> → <code>getSymbol("JNI_OnLoad")</code>，并用 <code>constructor(101)</code>/<code>constructor(102)</code>/无优先级三个函数验证顺序与次数（<code>initFlag=1</code>、<code>initArrayCount=101</code>）。',
          '部署验证：CMake 里用 <code>EXCLUDE_FROM_ALL</code> 避免打进包，<code>adb push</code> 到 <code>/data/local/tmp</code>，<code>setenforce 0</code> 后加载，再看 <code>/proc/self/maps</code> 确认没有文件路径。',
          '做检测与修复的闭环：跑 <code>scan_hidden_modules.js</code>（<code>enumerateRanges</code> 找 r-x + ELF magic，<code>enumerateModules</code> 排白名单，解析 Phdr 算 fullSize dump），再用 SoFixer 修好 dump 出来的 so。',
          '读 AOSP 源码做版本对照：Android 4.4.4_r1 的 <code>find_library_internal</code>（32 位、串行）对比 Android 10.0.0_r47 的 <code>android_dlopen_ext</code> + <code>find_libraries</code>（随机序 LoadTask 共 7 步）。',
          '最后才碰对抗手段：把 <code>wipeElfHeaders</code>（抹 ELF Header / Phdr / Dynamic，先 mprotect 再恢复权限）的注释去掉，观察检测脚本的表现变化。'
        ],
        result:
          '<p>Loader 与 Linker 都能把目标 <code>libtestdemo.so</code> 加载起来并跑通初始化，' +
          '<b>最直观的产物是 <code>/proc/self/maps</code> 里没有对应的文件路径</b>——这段代码不是从文件映射进来的，而是落在匿名内存里。</p>' +
          '<p>同时作者给出了配套的检测与修复链（<code>scan_hidden_modules.js</code> + SoFixer），' +
          '说明这套加载方式<b>既有对抗价值，也有确定的检测特征</b>。</p>',
        terms: ['ELF Loader', '自定义 Linker', 'e_entry', 'DT_GNU_HASH', 'Elf64_Rela', 'R_AARCH64_ABS64', '__builtin___clear_cache', '.init_array', 'JNI_OnLoad', 'SoFixer', 'android_dlopen_ext'],
        limits:
          '<p>作者对局限说得很直白，原帖明示：<b>代码里存在诸多 bug，实现并不完备，并且有 AI 辅助</b>。他自己列了三条不足：</p>' +
          '<p>① <b>Loader / Linker 的功能有限</b>，只覆盖了装载与链接的主干，比不了系统 linker；</p>' +
          '<p>② <b>自定义 Linker 只能处理动态注册的 JNI 函数</b>——静态注册（沿用 <code>Java_包名_类名_方法名</code> 命名约定、由运行时按名字去库里找符号那一套）' +
          '<b>没有被处理</b>，所以碰到只做静态注册的 so，这条路走不通；</p>' +
          '<p>③ <b>Hash Table 的查找算法等细节没有深入</b>，符号查找只是够用。</p>' +
          '<p>另外两点工程上的硬约束：<code>wipeElfHeaders</code> 在代码里<b>默认是注释掉的</b>；' +
          '以及 Loader 的对象<b>必须用 new 放在堆上</b>，否则会直接 <b>SIGSEGV</b>。</p>',
        analysis:
          '<p><b>这个案例是第 4 章「把观测点放到更低层级」的工程实证。</b>本课讲定制 ART 是为了抢在 Hook 框架够不到的地方插桩；' +
          '这里的手法更进一步——<b>干脆不用系统的 linker</b>，自己把 so 从文件读进匿名内存、自己做重定位、自己跳 <code>e_entry</code>。' +
          '层级下沉之后，你能看见的东西就多了一层。</p>' +
          '<p>先看那个最值得记住的坑。<b>第 5 处移植差异是必须在写完全新的代码段之后调用 <code>__builtin___clear_cache</code>，否则 D-Cache 与 I-Cache 不一致，直接 SIGILL。</b>' +
          '这条正是本课第 3 章讲「内存里写代码」时必须处理的硬件一致性问题：<b>数据写入走 D-Cache，取指走 I-Cache，两者不是同一份</b>；' +
          '你把新指令当数据写进去了，CPU 却可能从 I-Cache 里取到旧内容。' +
          '<span class="hit">这不是 API 用错，是硬件层面的必然——凡是「运行时自己造代码」的技术（SMC、inline hook、自定义 Loader、JIT）都要付这笔账。</span>' +
          '对照本课第 10 章那个案例：厂商的 shellcode 用 mmap RWX 之后直接执行，同样绕不开这一步。' +
          '<b>所以看到「代码在内存里生成」时，第一反应就该是「谁负责刷缓存」。</b></p>' +
          '<p>第二个重点是这个技术的<b>天然副作用</b>：<b>加载完成后 maps 里没有文件路径</b>。' +
          '系统 linker 加载 so 会留下 <code>/data/app/.../libxxx.so</code> 这样的映射项，而自定义 Loader 从匿名内存起来，' +
          '这一行天然不存在。<b>换句话说，第 10 章讲的那些靠扫 maps 找模块的检测手法的对手，在这里是被「顺便」绕过的</b>——' +
          '作者甚至不需要专门做隐藏。但帖子里同时给出了 <code>scan_hidden_modules.js</code>，把检测方式也补全了：' +
          '<b>不看路径，就看「有 r-x 段、有 ELF magic，却不在 <code>enumerateModules</code> 列表里」的内存</b>。' +
          '<span class="hit">攻防两边都摆出来，比只讲怎么藏要有价值得多：任何隐藏都有特征，问题只是特征在哪一层。</span></p>' +
          '<p>最后必须点出作者自列的那条限制：<b>「自定义 Linker 只能处理动态注册的 JNI 函数，静态注册未处理」</b>。' +
          '这是这类工具的真实边界——它替换的是 linker 的<b>装载与链接</b>职责，' +
          '而静态注册的方法表是编译期就固化在 so 里的，走的是另一条路。' +
          '<b>第 4 章在讲 RegisterNatives 时强调过「动态注册才是主线」，这个案例从工具侧印证了这句话的分量：搞不定动态注册，等于放弃了绝大多数真实加固样本。</b>' +
          '把边界写清楚，比把工具吹成通用方案诚实，也更有用。</p>' +
          '<p>顺带一个方法论：作者先写 <b>200 多行 x86</b> 把 9 步流程跑通，再移植到 AArch64——' +
          '<b>先用最熟悉的架构把「机制」验证完，再让「架构差异」变成一个只有 5 条的清单</b>。' +
          '这和第 4 章一贯的思路一致：把不可控的大问题，拆成可控的小问题。</p>',
        link: 'https://bbs.kanxue.com/thread-290643.htm',
        linkNote: '看雪论坛原创帖'
      }
    },

    {
      h: '4.3',
      title: '读 ART 源码的六件武器：C++11 速通',
      html:
        '<p>ART 是 C++ 写的，而且是「现代 C++」。如果你只学过 C++98，第一次打开 ART 源码的感受是：<strong>每个词都认识，凑起来不知道在干嘛</strong>。' +
        '下面六件武器，是从「看不懂」到「看得懂」的最短路径。</p>' +
        T.tbl(['武器', '长什么样', '在 ART 里解决什么问题'], [
          ['auto / decltype', 'auto p = obj->GetClass();', '类型名长到没法手写（模板嵌套），让编译器推导'],
          ['nullptr', 'if (ptr == nullptr)', 'NULL 就是整数 0，重载时会产生歧义；nullptr 是真正的空指针类型'],
          ['范围 for', 'for (auto& m : methods)', '遍历方法表/字段表不用再写下标和边界'],
          ['lambda', '[=] / [&] 的匿名回调', '把一小段逻辑当参数传进去，ART 里到处都是'],
          ['模板', 'Handle&lt;T&gt; / ObjPtr&lt;T&gt;', '编译期多态，零运行时开销；同时保证 GC 安全'],
          ['RAII', 'ScopedObjectAccess / MutexLock', '构造时获取资源，析构时自动释放，异常也不泄漏']
        ]) +
        '<p>其中 <span class="term" data-def="编译期把类型填进去，运行时不查表、不分发">模板</span> 和 ' +
        '<span class="term" data-def="Resource Acquisition Is Initialization，资源获取即初始化">RAII</span> 是 ART 的两条命脉：' +
        '前者让 <span class="mono">Handle&lt;T&gt;</span> 这类 GC 安全句柄既好用又不慢，后者让线程状态、锁、GC 临界区不会因为一条提前 return 就漏掉。</p>' +
        T.grid(2, [
          '<div class="card"><div class="card-title">编译期多态 vs 运行时分发</div>' +
          '<p>虚函数要在对象里塞 <span class="mono">vptr</span>，调用时查 vtable——有内存开销也有性能开销。' +
          '模板在<b>编译时</b>就把类型填死了，生成的机器码里没有任何「查表」动作。</p>' +
          '<p>代价是：<b>代码膨胀</b>。同一个模板每实例化一种类型，就多一份机器码。</p></div>',
          '<div class="card"><div class="card-title">RAII 为什么在虚拟机里是刚需</div>' +
          '<p>虚拟机代码路径极长，中间任何一处提前返回、抛异常、GC 打断，都可能把锁或线程状态留在半路。' +
          'RAII 把「释放」绑在<b>栈对象的生命周期</b>上，作用域一退出必然执行。</p>' +
          '<p><span class="mono">MutexLock</span> 就是典型：构造加锁，析构解锁，你写代码时根本不用想「什么时候解锁」。</p></div>'
        ]),
      stepper: {
        title: '六件武器在 ART 里的真实样子（逐行读）',
        lines: [
          { code: '<span class="c">// ① auto：类型太长，交给编译器</span>\n<span class="k">auto</span>* klass = obj-><span class="f">GetClass</span>();',
            note: '<b>auto 不是为了少打字，是为了不被类型名淹没。</b>ART 里一个类型可能写成 <span class="mono">Handle&lt;mirror::Class&gt;</span>，手写既易错又难读。注意：auto 推导的是<b>静态类型</b>，你省掉的只是书写，不是类型本身。',
            state: { '推导结果': 'mirror::Class*' } },
          { code: '<span class="c">// ② decltype：反着来，从表达式问「你是什么类型」</span>\n<span class="k">decltype</span>(obj-><span class="f">GetClass</span>()) other;',
            note: '<b>decltype 让你从「值」反推「类型」。</b>写模板代码时特别有用：你不知道调用者会传什么进来，但你能让编译器去问那个表达式。和 auto 的区别是——auto 需要一个初始值，decltype 不需要。',
            state: { '推导结果': 'mirror::Class*（同表达式）' } },
          { code: '<span class="c">// ③ nullptr：NULL 是 0，会撞上整数重载</span>\n<span class="k">void</span> <span class="f">Foo</span>(<span class="k">int</span>);\n<span class="k">void</span> <span class="f">Foo</span>(<span class="k">char</span>*);\n<span class="f">Foo</span>(<span class="k">NULL</span>);   <span class="c">// 调哪个？</span>\n<span class="f">Foo</span>(<span class="k">nullptr</span>); <span class="c">// 明确：char*</span>',
            note: '<b>nullptr 解决的是重载歧义，不是「写法好看」。</b>因为 <span class="mono">NULL</span> 在 C++ 里就是整数 0，<span class="mono">Foo(NULL)</span> 会优先匹配 <span class="mono">int</span> 版本——一个语义上的空指针变成了整数运算，bug 就此埋下。ART 里指针重载很多，所以全量改用 nullptr。',
            state: { 'NULL 的真实类型': '整数 0', 'nullptr': 'std::nullptr_t' } },
          { code: '<span class="c">// ④ 范围 for：遍历方法表</span>\n<span class="k">for</span> (<span class="k">auto</span>&amp; m : klass-><span class="f">GetMethods</span>()) {\n  <span class="f">Visit</span>(m);\n}',
            note: '<b>范围 for 是语法糖，本质还是迭代器。</b>注意这里的 <span class="mono">&amp;</span>：用引用避免拷贝一个完整的 ArtMethod。如果写成 <span class="mono">auto m</span>，你改的是副本，改动不会回写——这是新手很常见的沉默 bug。',
            state: { '注意': 'auto& 才是引用' } },
          { code: '<span class="c">// ⑤ 模板：GC 安全句柄</span>\n<span class="t">Handle</span>&lt;<span class="t">mirror::Object</span>&gt; h = ...;\n<span class="t">ObjPtr</span>&lt;<span class="t">mirror::Class</span>&gt; c = ...;',
            note: '<b>Handle&lt;T&gt; / ObjPtr&lt;T&gt; 是「GC 安全」的指针包装。</b>GC 会移动对象，裸指针会失效；句柄让 GC 知道「这里还有一个引用」并帮你更新。类型 T 通过模板参数传进去，编译期就完全确定，运行时零额外开销。',
            state: { '作用': 'GC 移动对象时不悬垂', '开销': '编译期解析' } },
          { code: '<span class="c">// ⑥ RAII：构造获取，析构释放</span>\n{\n  <span class="t">MutexLock</span> lock(mutex_);\n  <span class="c">// ... 中间 return / 抛异常都无所谓</span>\n}  <span class="c">// 到这里自动解锁</span>',
            note: '<b>RAII 把「配对操作」变成「作用域」。</b>加锁/解锁、进入/退出 GC 安全区、Attach/Detach 线程，全部靠栈对象的构造与析构自动配对。你不再需要记住「每条返回路径都要解锁」。',
            state: { '进入作用域': '构造 → 加锁', '离开作用域': '析构 → 解锁' } },
          { code: '<span class="c">// 智能指针：谁拥有这块内存</span>\n<span class="k">auto</span> p = std::<span class="f">make_unique</span>&lt;<span class="t">Foo</span>&gt;();\nstd::<span class="t">shared_ptr</span>&lt;<span class="t">Bar</span>&gt; s = ...;',
            note: '<b>unique_ptr 是独占所有权，shared_ptr 是引用计数共享。</b>ART 的长期数据结构多用前者——独占意味着没有并发析构的悬念。记住原则：能用 unique_ptr 就别用 shared_ptr，引用计数是有成本的。',
            state: { 'unique_ptr': '独占，零额外开销', 'shared_ptr': '共享，带计数' } },
          { code: '<span class="c">// 见到这个就该警觉</span>\n<span class="k">auto</span> cb = [&amp;]() { <span class="f">Use</span>(local_var); };\n<span class="f">PostDelayedTask</span>(cb, <span class="n">5000</span>);',
            note: '<b>危险信号出现了：引用捕获 + 延后执行。</b>下一节我们把这段 lambda 拆成匿名类和内存布局，看看 5 秒后 <span class="mono">local_var</span> 还在不在。',
            state: { '风险': '悬垂引用（见 4.4）' } }
        ]
      },
      after: T.note('warn', '⚠️ 学 C++11 的正确姿势',
        '<p>不要抱着语法书从头背。ART 源码里 <span class="mono">auto</span> / <span class="mono">nullptr</span> / 范围 for 出现的密度极高，' +
        '你在真实代码里撞见三次，比背十条规则有用。真正的门槛只有两个：<strong>lambda 捕获了什么</strong>，和 <strong>模板在编译期做了什么</strong>。</p>')
    },

    /* ================= 4.4 ================= */
    {
      h: '4.4',
      title: 'lambda 的内存真相：捕获列表就是成员变量',
      html:
        '<p>很多人对 lambda 的认知停在「匿名函数」。这个认知会让你在 ART 里踩一个经典坑。' +
        '真相是：<strong>编译器把你的 lambda 变成了一个匿名类</strong>，捕获的变量成了这个类的<strong>成员变量</strong>。</p>' +
        T.note('key', '🔑 lambda 三句话',
          '<p><b>①</b> <span class="mono">[=]</span> 值捕获：把变量的<b>当前值拷贝</b>进匿名类成员——之后原变量怎么变都与你无关。' +
          '<b>②</b> <span class="mono">[&amp;]</span> 引用捕获：把变量的<b>地址</b>存进匿名类成员——本质就是一个指针。' +
          '<b>③</b> 一旦「引用捕获」遇上「延后执行」，那就是一颗定时炸弹：<b>匿名类活过了它引用的那个栈变量</b>。</p>' +
          '<p>这三句不是背的，下面直接看内存。</p>') +
        '<p>看这段代码，它同时包含两种捕获，且回调会在<strong>很久以后</strong>执行：</p>' +
        T.code(
          '<span class="k">void</span> <span class="f">ScheduleWork</span>() {\n' +
          '  <span class="k">int</span> local_id = <span class="n">42</span>;\n' +
          '  std::string local_name = <span class="s">&quot;MyBean&quot;</span>;\n\n' +
          '  <span class="c">// [=] 值捕获：拷贝两份成员进匿名类</span>\n' +
          '  <span class="k">auto</span> byValue = [=]() { <span class="f">Use</span>(local_id, local_name); };\n\n' +
          '  <span class="c">// [&amp;] 引用捕获：只存两个地址</span>\n' +
          '  <span class="k">auto</span> byRef   = [&amp;]() { <span class="f">Use</span>(local_id, local_name); };\n\n' +
          '  <span class="f">PostDelayedTask</span>(byValue, <span class="n">5000</span>);\n' +
          '  <span class="f">PostDelayedTask</span>(byRef,   <span class="n">5000</span>);\n' +
          '}  <span class="c">// ← local_id / local_name 在这里被销毁</span>'),
      stage: {
        title: '两种捕获在内存里的真身（含悬垂现场）',
        speed: 1700,
        render:
          '<div class="flow-row" style="flex-wrap:wrap;gap:10px;align-items:flex-start">' +
            '<div><div class="card-title">栈 · ScheduleWork 帧</div><div class="memgrid">' +
              '<div class="memrow"><span class="addr">sp+0x00</span><span class="cell" id="l_id">local_id = 42</span></div>' +
              '<div class="memrow"><span class="addr">sp+0x08</span><span class="cell" id="l_name">local_name = &quot;MyBean&quot;</span></div>' +
              '<div class="memrow"><span class="addr">sp+0x40</span><span class="cell" id="l_state">栈帧：存活</span></div>' +
            '</div></div>' +
            '<div><div class="card-title">堆 · 匿名类对象 A（[=]）</div><div class="memgrid">' +
              '<div class="memrow"><span class="addr">+0x00</span><span class="cell" id="v_id">成员 id = ?</span></div>' +
              '<div class="memrow"><span class="addr">+0x08</span><span class="cell" id="v_name">成员 name = ?</span></div>' +
            '</div></div>' +
            '<div><div class="card-title">堆 · 匿名类对象 B（[&amp;]）</div><div class="memgrid">' +
              '<div class="memrow"><span class="addr">+0x00</span><span class="cell" id="r_id">成员 &amp;id = ?</span></div>' +
              '<div class="memrow"><span class="addr">+0x08</span><span class="cell" id="r_name">成员 &amp;name = ?</span></div>' +
            '</div></div>' +
          '</div>' +
          '<div style="margin-top:12px" class="flow-row">' +
            '<span class="blk" id="b_task">5 秒后执行的回调</span>' +
            '<span class="arrow">→</span>' +
            '<span class="pill" id="verdict">等待</span>' +
          '</div>',
        reset: () => {
          CLS('l_id', 'cell'); SET('l_id', 'local_id = 42');
          CLS('l_name', 'cell'); SET('l_name', 'local_name = &quot;MyBean&quot;');
          CLS('l_state', 'cell'); SET('l_state', '栈帧：存活');
          CLS('v_id', 'cell'); SET('v_id', '成员 id = ?');
          CLS('v_name', 'cell'); SET('v_name', '成员 name = ?');
          CLS('r_id', 'cell'); SET('r_id', '成员 &amp;id = ?');
          CLS('r_name', 'cell'); SET('r_name', '成员 &amp;name = ?');
          S('b_task', ''); CLS('verdict', 'pill'); SET('verdict', '等待');
        },
        steps: [
          { run: () => { CLS('l_id', 'cell hi'); CLS('l_name', 'cell hi'); },
            note: '<b>先看原变量在哪。</b>local_id 和 local_name 都是 <span class="mono">ScheduleWork</span> 的局部变量，住在<b>栈帧</b>里。它们的生命周期由这个函数决定——函数返回，栈帧回收，它们就不存在了。',
            state: { '位置': '栈', '生命周期': '函数作用域' } },
          { run: () => { CLS('v_id', 'cell wr'); SET('v_id', '成员 id = 42'); CLS('v_name', 'cell wr'); SET('v_name', '成员 name = &quot;MyBean&quot;'); },
            note: '<b>[=] 值捕获：拷贝进成员。</b>编译器生成的匿名类里有两个成员变量，lambda 定义的那一刻就把 42 和 &quot;MyBean&quot; <b>复制</b>了进去。这是真正的拷贝——字符串内容也在堆上另存了一份。',
            state: { '捕获方式': '值（拷贝）', '成员类型': 'int / std::string' } },
          { run: () => { CLS('r_id', 'cell hi'); SET('r_id', '成员 &amp;id = 0x7ffd1240'); CLS('r_name', 'cell hi'); SET('r_name', '成员 &amp;name = 0x7ffd1248'); },
            note: '<b>[&amp;] 引用捕获：只存地址。</b>注意这里存的是 <span class="mono">0x7ffd1240</span> 这样的栈地址，<b>本质就是一个指针</b>。字符串没有被拷贝，lambda 里用的还是外面那一份。',
            state: { '捕获方式': '引用（指针）', '成员类型': 'int&amp; → int*' } },
          { run: () => { S('b_task', 'active'); },
            note: '<b>两个回调都被丢进任务队列，5 秒后执行。</b>排队的是匿名类对象本身（堆上），而不是栈上的局部变量。此刻一切正常，两边都还没出问题。',
            state: { '队列': 'byValue, byRef', '延迟': '5000 ms' } },
          { run: () => { S('b_task', 'done'); CLS('l_state', 'cell wr'); SET('l_state', '栈帧：已销毁 ✗'); S('b_task', 'hot'); },
            note: '<b>关键一步：ScheduleWork 返回了。</b>栈帧被回收，<span class="mono">local_id</span> 和 <span class="mono">local_name</span> 的内存<b>不再属于你</b>——它可能已经被别的函数覆盖成完全无关的字节。',
            state: { '栈帧': '已销毁', '那块内存': '可能已被复用' } },
          { run: () => { CLS('v_id', 'cell ok'); SET('v_id', '成员 id = 42 ✓'); CLS('v_name', 'cell ok'); SET('v_name', '成员 name = &quot;MyBean&quot; ✓'); },
            note: '<b>值捕获的这个活下来了。</b>因为它手里是<b>自己的拷贝</b>，原变量死活与它无关。这就是为什么回调里要长期使用一个值，就该用 <span class="mono">[=]</span> 而不是 <span class="mono">[&amp;]</span>。',
            state: { 'byValue': '安全 ✓' } },
          { run: () => { CLS('r_id', 'cell bad'); SET('r_id', '成员 &amp;id = 0x7ffd1240 ✗ 悬垂'); CLS('r_name', 'cell bad'); SET('r_name', '成员 &amp;name = 0x7ffd1248 ✗ 悬垂'); CLS('verdict', 'pill bad'); SET('verdict', '悬垂引用 · 崩或不崩看运气'); },
            note: '<b>灾难现场：引用捕获的回调指向一块已经死掉的内存。</b>它依然能读到「某个值」，但那个值已经不是你写下的 42。这就是 <span class="term" data-def="指针/引用指向了生命周期已经结束的对象">悬垂引用</span>——最恶劣的一类 bug，因为它<b>不一定立刻崩</b>。',
            state: { 'byRef': '悬垂 ✗', '典型症状': '偶发崩溃 / 读到脏数据' } },
          { run: () => { S('b_task', 'hot'); CLS('verdict', 'pill bad'); SET('verdict', '延迟越久，越可能被覆盖'); },
            note: '<b>为什么这类 bug 特别难查？</b>因为延迟越长，那块栈内存被别的调用覆盖的概率越大。压测不崩、线上偶发；改了无关代码就复现——症状与原因之间隔着一整条时间线。',
            state: { '复现难度': '极高' } },
          { run: () => { S('b_task', 'cool'); CLS('verdict', 'pill ok'); SET('verdict', '正确做法：按生命周期选捕获方式'); },
            note: '<b>结论：捕获方式的选择标准是「谁活得更久」。</b>回调比原变量活得久 → 用值捕获，或用 shared_ptr 共享所有权；只在同步调用内立即用完 → 引用捕获才是安全且高效的。ART 这种长期运行的系统里，任务队列、GC 回调、事件通知都是高危区。',
            state: { '同步立即用': '[&] 安全', '异步延后用': '[=] 或 shared_ptr' } }
        ]
      },
      after:
        T.note('bad', '🚫 ART 里的真实后果',
          '<p>这不是教科书里的理论风险。<span class="mono">[&amp;]</span> 捕获局部变量后延后执行，在长期运行的虚拟机里会表现为：' +
          '<b>GC 期间的偶发崩溃</b>、<b>线程池里的随机野指针</b>、<b>只在特定时序下出现的类解析错误</b>——' +
          '而且栈回溯往往指向一个和 bug 毫无关系的函数。</p>') +
        T.tbl(['场景', '该用哪种捕获', '理由'], [
          ['同步调用，函数内立即用完', '[&amp;] 引用捕获', '零拷贝、零开销，且生命周期安全'],
          ['丢进队列，稍后执行', '[=] 值捕获', '拷贝出自己的副本，与原变量解耦'],
          ['共享大对象且需长期持有', 'shared_ptr 捕获', '用引用计数把生命周期绑在一起，别赌'],
          ['循环里创建多个回调', '显式捕获所需变量', '避免 [&amp;] 在循环变量上集体踩雷']
        ]) +
        T.term('闭包', 'lambda 生成的匿名类对象；捕获的变量成为它的成员。') + ' ' +
        T.term('悬垂引用', '引用指向的对象已销毁，访问行为未定义。') + ' ' +
        T.term('生命周期', '对象从构造到析构的有效期；捕获方式必须按它来选。')
    },
    ,
    /* ================= 4.5 ================= */
    {
      h: '4.5',
      title: '核心实战：在 RegisterNatives 那一刻抓住映射',
      html:
        '<p>先分清两种 JNI 注册方式，这决定了你的对手长什么样。</p>' +
        T.grid(2, [
          '<div class="card"><div class="card-title">📌 静态注册</div>' +
          '<p>函数名必须写成 <span class="mono">Java_包名_类名_方法名</span>（下划线要转义），虚拟机会按名字去动态库里找。</p>' +
          '<p><b>对逆向的影响：</b>符号表里明晃晃写着 <span class="mono">Java_com_demo_MyBean_getName</span>，' +
          '<span class="mono">nm</span> / IDA 一看就知道哪个 Java 方法对应哪个 Native 函数。<b>不需要跑起来就能分析。</b></p></div>',
          '<div class="card"><div class="card-title">📌 动态注册</div>' +
          '<p>在 <span class="mono">JNI_OnLoad</span> 里调用 <span class="mono">env-&gt;RegisterNatives(clazz, methods, nMethods)</span>，' +
          '把一张 <span class="mono">{名字, 签名, 函数地址}</span> 的表交给虚拟机。</p>' +
          '<p><b>对逆向的影响：</b>函数名可以是任意字符串（根本不进符号表），地址运行时才产生。' +
          '<b>静态分析到这里彻底断线。</b>加固方案偏爱它，正是因为这个。</b></p></div>'
        ]) +
        '<p>那张表的结构体就是三件事：</p>' +
        T.code(
          '<span class="k">typedef</span> <span class="k">struct</span> {\n' +
          '  <span class="k">const</span> <span class="k">char</span>* name;       <span class="c">// Java 方法名</span>\n' +
          '  <span class="k">const</span> <span class="k">char</span>* signature;  <span class="c">// 方法签名，如 (I)Ljava/lang/String;</span>\n' +
          '  <span class="k">void</span>*       fnPtr;      <span class="c">// native 函数真实地址</span>\n' +
          '} <span class="t">JNINativeMethod</span>;') +
        T.note('key', '🔑 从「生成侧」动手',
          '<p>既然映射是在 <span class="mono">RegisterNatives</span> 里被交给虚拟机的，那我们就在<b>那个函数内部</b>加一行日志。' +
          '此刻 Java 方法、签名、函数地址三者同时在手上——<strong>这是整个系统里信息最完备的一瞬间</strong>。</p>' +
          '<p>比起 hook <span class="mono">RegisterNatives</span> 这个 API（会被反调试发现 hook 框架的存在），' +
          '直接改虚拟机源码<b>在代码里就完成了记录</b>，没有额外痕迹需要隐藏。</p>'),
      stepper: {
        title: '给 ART 的 RegisterNatives 插一行探针（右侧看映射逐条累积）',
        lines: [
          { code: '<span class="c">// ① 目标：ART 源码里 JNI 的 RegisterNatives 实现处</span>\n' +
                  '<span class="c">// 文件名/函数签名随 AOSP 版本变化 <span class="pill warn">待核实</span></span>\n' +
                  '<span class="k">static</span> jint <span class="f">RegisterNatives</span>(JNIEnv* env,\n' +
                  '        jclass java_class, <span class="k">const</span> <span class="t">JNINativeMethod</span>* methods,\n' +
                  '        jint method_count) {',
            note: '<b>先找到入口。</b>这是 ART 处理动态注册的唯一入口，所有 <span class="mono">env-&gt;RegisterNatives</span> 调用最终都会落到这里。找到它，就等于找到了所有加固 App 的「注册咽喉」。',
            state: { '阶段': '定位插桩点' } },
          { code: '  <span class="t">ScopedObjectAccess</span> soa(env);',
            note: '<b>RAII 进场。</b>这一行同时做两件事：把当前线程切换到「可以安全访问 Java 对象」的状态，并在函数返回时<b>自动还原</b>。如果这里手写加锁/解锁，中间任何一条提前 return 都会漏掉解锁——所以 ART 用 RAII。',
            state: { '机制': 'RAII', '进入': '对象访问安全态' } },
          { code: '  <span class="t">mirror::Class</span>* c = soa.<span class="f">Decode</span>&lt;<span class="t">mirror::Class</span>&gt;(java_class);',
            note: '<b>把 jclass 解成 ART 内部类型。</b>模板参数 <span class="mono">&lt;mirror::Class&gt;</span> 在编译期把返回类型钉死，运行时只是一次指针转换——这就是模板「零开销」的含义。到这里我们拿到了类的镜像。',
            state: { '获得': 'mirror::Class* c' } },
          { code: '  <span class="k">for</span> (jint i = <span class="n">0</span>; i &lt; method_count; ++i) {\n' +
                  '    <span class="k">const</span> <span class="k">char</span>* name = methods[i].name;\n' +
                  '    <span class="k">const</span> <span class="k">char</span>* sig  = methods[i].signature;\n' +
                  '    <span class="k">void</span>*       fn   = methods[i].fnPtr;',
            note: '<b>循环取下一样。</b>注意这里三个值同时到手：Java 方法名、签名、native 函数地址。<b>签名必须一起记</b>——因为 Java 支持方法重载，光有名字无法唯一确定一个方法。',
            state: { 'i': '0', 'name': 'getName', 'sig': '()Ljava/lang/String;' } },
          { code: '    <span class="t">ArtMethod</span>* m = c-&gt;<span class="f">FindDirectMethod</span>(name, sig);',
            note: '<b>在类里反查 ArtMethod。</b>回看 4.2 的指针链：Class → 方法表 → ArtMethod。这里是同一条链的<b>反向使用</b>——用名字找槽位，而不是从槽位读名字。',
            state: { '查表': 'Class::methods_', '命中': 'ArtMethod* m' } },
          { code: '    <span class="c">// ★★★ 我们插入的探针（唯一改动）</span>\n' +
                  '    <span class="f">LOG</span>(INFO) &lt;&lt; <span class="s">&quot;[TRACE] &quot;</span> &lt;&lt; c-&gt;<span class="f">PrettyDescriptor</span>()\n' +
                  '               &lt;&lt; <span class="s">&quot;.&quot;</span> &lt;&lt; name &lt;&lt; sig &lt;&lt; <span class="s">&quot; -&gt; &quot;</span> &lt;&lt; fn;',
            note: '<b>这就是全部改动。</b>一行日志，把「Java 方法 → native 地址」永久记录下来。注意探针位置在 <span class="mono">FindDirectMethod</span> 之后——此时类名、方法名、签名、目标地址<b>四要素齐全</b>。',
            state: { '① com.demo.MyBean.getName()Ljava/lang/String;': '0x7f6c9e40' } },
          { code: '    m-&gt;<span class="f">RegisterNative</span>(fn);\n' +
                  '  }',
            note: '<b>虚拟机自己完成绑定。</b>把 <span class="mono">fn</span> 写进 ArtMethod 的执行入口（并同步位置换 access_flags 的 native 位）。我们没有干扰它的逻辑——<b>只旁观，不改变行为</b>，这是插桩最重要的纪律。',
            state: { '① com.demo.MyBean.getName()Ljava/lang/String;': '0x7f6c9e40',
                     'ArtMethod 入口': '0x7f6c9e40 (native)' } },
          { code: '    <span class="c">// i = 1</span>\n' +
                  '    name = <span class="s">&quot;setAge&quot;</span>; sig = <span class="s">&quot;(I)V&quot;</span>; fn = <span class="n">0x7f6ca100</span>;',
            note: '<b>第二条来了。</b>注意签名 <span class="mono">(I)V</span>：入参一个 int，返回 void。同一个 <span class="mono">setAge</span> 如果还有一个 <span class="mono">(J)V</span> 的重载，光看名字根本区分不了——这就是为什么探针必须带上签名。',
            state: { '① com.demo.MyBean.getName()Ljava/lang/String;': '0x7f6c9e40',
                     '② com.demo.MyBean.setAge(I)V': '0x7f6ca100' } },
          { code: '    <span class="c">// i = 2 —— 名字被刻意混淆过</span>\n' +
                  '    name = <span class="s">&quot;a&quot;</span>; sig = <span class="s">&quot;([B)[B&quot;</span>; fn = <span class="n">0x7f6ca880</span>;',
            note: '<b>加固的痕迹出现了。</b>方法名被压成一个字母 <span class="mono">a</span>，入参出参都是字节数组 <span class="mono">[B</span>——' +
                  '这几乎必然是一个<b>加解密/校验函数</b>。静态分析看到这种名字毫无办法，而我们的探针把它的<b>真实地址</b>交了出来。',
            state: { '① com.demo.MyBean.getName()Ljava/lang/String;': '0x7f6c9e40',
                     '② com.demo.MyBean.setAge(I)V': '0x7f6ca100',
                     '③ com.demo.MyBean.a([B)[B': '0x7f6ca880' } },
          { code: '    <span class="c">// i = 3</span>\n' +
                  '    name = <span class="s">&quot;nativeCheck&quot;</span>; sig = <span class="s">&quot;()Z&quot;</span>; fn = <span class="n">0x7f6cab00</span>;',
            note: '<b>一条更值钱的记录。</b><span class="mono">nativeCheck()Z</span> 返回 boolean——这是典型的<b>完整性校验/root 检测</b>入口。拿到地址，就能直接去看它的实现，不用再猜入口在哪。',
            state: { '① com.demo.MyBean.getName()Ljava/lang/String;': '0x7f6c9e40',
                     '② com.demo.MyBean.setAge(I)V': '0x7f6ca100',
                     '③ com.demo.MyBean.a([B)[B': '0x7f6ca880',
                     '④ com.demo.MyBean.nativeCheck()Z': '0x7f6cab00' } },
          { code: '  <span class="k">return</span> JNI_OK;\n}',
            note: '<b>注册结束，虚拟机继续正常工作。</b>整个过程目标 App 毫无感知——没有 hook、没有注入、没有额外的线程或内存特征可供检测。',
            state: { '输出': '4 条映射已落盘', '目标感知': '无' } },
          { code: '<span class="c"># 沙箱侧的产物：一份纯文本映射表</span>\n' +
                  '<span class="c"># 直接喂给 IDA / Ghidra，或在 gdb 里下断</span>',
            note: '<b>这就是产物。</b>一份「Java 方法 ↔ native 地址」的对照表，是后续所有动态调试的入口清单。<b>注册那一刻天然知道全部信息，这就是从生成侧动手的价值。</b>',
            mem: '[TRACE] com.demo.MyBean.getName()Ljava/lang/String; -> 0x7f6c9e40\n' +
                 '[TRACE] com.demo.MyBean.setAge(I)V                -> 0x7f6ca100\n' +
                 '[TRACE] com.demo.MyBean.a([B)[B                  -> 0x7f6ca880\n' +
                 '[TRACE] com.demo.MyBean.nativeCheck()Z           -> 0x7f6cab00\n' +
                 '--- 4 bindings recorded (sandbox log) ---',
            state: { '落盘位置': '/data/local/tmp/art-trace.log', '格式': 'name+sig → addr' } }
        ]
      },
      after: T.note('warn', '⚠️ 这几处细节随版本变化，务必以你手上的源码为准',
        '<p>下列内容在 AOSP 不同版本间<b>改过名字或位置</b>，写代码前先在本地源码里搜一遍，不要照抄：' +
        '处理 JNI 注册的具体<b>文件名</b>、函数所在<b>命名空间</b>、查找方法用的<b>辅助函数名</b>、日志宏的用法。' +
        '<span class="pill warn">待核实</span></p>' +
        '<p><b>通用方法：</b>在 ART 源码根目录搜 <span class="mono">RegisterNatives</span> 与 <span class="mono">JNINativeMethod</span>，' +
        '能同时命中两者的那个文件就是你的插桩点。</p>') +
        '<div class="note ok"><div class="note-h">✅ 插桩的三条纪律</div>' +
        '<p><b>①</b> 只读不改：探针不得改变原有控制流与返回值；<b>②</b> 别在持锁路径里做重活：日志要够轻，或先写入内存缓冲；' +
        '<b>③</b> 记录必须含签名：同名重载会让只有名字的映射表彻底失效。</p></div>',
      quiz: {
        id: 'q4-1', chapter: 4, answer: 1,
        stem: '一个加固 App 的 <span class="mono">libnative.so</span> 里，符号表只剩寥寥几个导出函数，但运行时相关 Java native 方法明显都能正常工作。下面哪个判断最准确？',
        options: [
          { t: '这个库被整体加密了，需要在内存里 dump 出解密后的 so', why: '整体加密的库连 JNI_OnLoad 都跑不起来。而且符号少不等于内容加密——动态注册本来就不需要导出符号。' },
          { t: '库很可能使用动态注册：函数名不出现在符号表里，地址由运行时注册', why: '正确。动态注册的核心特征就是「符号表干净但功能正常」，因为 Java 方法与函数的对应关系只存在于运行时的那张 JNINativeMethod 表里。' },
          { t: '这些方法其实是 Java 层实现的，只是名字像 native', why: '可以验证：反射读 ArtMethod 的 access_flags 是否带 native 位。在功能确实由 so 提供的前提下，这个解释不成立。' },
          { t: '必须用 Frida 才能确认，静态工具完全无能为力', why: '静态工具依然能看 JNI_OnLoad 里的 RegisterNatives 调用与那张表的初始化过程，只是拿不到最终地址。说「完全无能为力」是过头了。' }
        ],
        explain: '<b>动态注册的判据是「符号缺失 + 功能正常」。</b>静态注册时函数名必须是 <span class="mono">Java_</span> 前缀，' +
                 '符号表会直接暴露映射关系；动态注册把这张关系表在运行时交给虚拟机，导出表自然空空如也。' +
                 '要恢复映射，要么在运行时观察 <span class="mono">RegisterNatives</span>，要么像本章一样直接在虚拟机内部记录它。'
      }
    },

    /* ================= 4.6 ================= */
    {
      h: '4.6',
      title: 'ArtMethod：所有 Java Hook 的公共抓手',
      html:
        '<p>回看 4.2 的最后一格：ART 把 <span class="mono">entry_point_from_quick_compiled_code_</span> 当函数指针直接调用。' +
        '<strong>谁能写这个字段，谁就能改变这个 Java 方法的行为。</strong>市面上所有 Java 层 Hook 框架，最终都落在这里。</p>' +
        T.note('key', '🔑 一句话记住',
          '<p>Frida 的 <span class="mono">Java.use()</span> 听起来很高层，本质就是：<b>找到那个 ArtMethod，把 access_flags 改成 native，' +
          '把执行入口换成自己的 trampoline，并保存原始值以便还原。</b></p>' +
          '<p>理解这一点，你就能解释很多「玄学现象」——比如 Hook 之后反射看到方法种类变了、或者某些 ROM 上 Hook 崩溃。</p>') +
        '<p>下面把这条路径逐步走完，右侧跟着 ArtMethod 的字段变化。</p>',
      stepper: {
        title: 'Frida Java.use 在 ArtMethod 上到底改了什么',
        lines: [
          { code: '<span class="c">// JS 侧：看起来很无害的一行</span>\n<span class="k">var</span> MyBean = Java.<span class="f">use</span>(<span class="s">&quot;com.demo.MyBean&quot;</span>);',
            note: '<b>这一行背后发生了什么？</b>它并不是「拿到一个 Java 类」，而是让 Frida 去 ART 里定位到 <span class="mono">com.demo.MyBean</span> 对应的 <span class="mono">mirror::Class</span>，并缓存下来。寻址路径就是 4.2 里那条链的前两跳。',
            state: { '定位': 'mirror::Class* (com.demo.MyBean)' } },
          { code: '<span class="c">// 再找到具体方法，拿到 ArtMethod 槽位</span>\n<span class="k">var</span> m = MyBean.getName;',
            note: '<b>第三跳：Class → 方法表 → ArtMethod。</b>到这里，<span class="mono">m</span> 背后就是一个实实在在的 ArtMethod 结构体地址。后面所有的操作都是对这个结构体的读写。',
            state: { 'ArtMethod': '0x7f3b2040', 'access_flags_': '0x0001 (public)' } },
          { code: '<span class="c">// ① 保存原始值 —— 决定性的一步</span>\n<span class="c">// original_flags, original_entry 存起来</span>',
            note: '<b>先备份，再动手。</b>这一步决定了 Hook 能不能干净地卸载。任何「改状态」的操作，第一步永远是保存原始值——这不仅适用于 Hook，也是运行时插桩的通用纪律。',
            state: { '备份': 'flags=0x0001, entry=0x7f6c9e40' } },
          { code: '<span class="c">// ② 把 access_flags 里的 native 位置 1</span>\nkAccNative = <span class="n">0x0100</span>;\nflags |= kAccNative;',
            note: '<b>关键手法：伪装成 native 方法。</b>为什么？因为 ART 对 native 方法的调用路径<b>最简单</b>——它不查 Dex 代码、不做解释执行，直接把 ArtMethod 上的函数指针拿去调。把普通 Java 方法「变成」native，就等于把它原有的执行路径彻底短路。',
            state: { 'access_flags_': '0x0101 (public | native)' } },
          { code: '<span class="c">// ③ 替换执行入口为我们的 trampoline</span>\nentry_point = my_trampoline;',
            note: '<b>第三跳的终点被改写了。</b>回到 4.2：这个字段是「真正会执行的地址」。现在它指向 Frida 的 trampoline，虚拟机一调用就进了我们的代码。',
            state: { 'entry_point_..._code_': '0x7f90be00 (trampoline)' } },
          { code: '<span class="c">// ④ trampoline 内部：转给我们真正的 JS 实现</span>\n<span class="c">// 参数从 Java 调用约定转换后交给 handler</span>',
            note: '<b>trampoline 是「转接器」。</b>它负责把 Java 层的调用约定翻译成 Frida 的调用约定，再把参数交给你写的 <span class="mono">implementation</span>。这一层是 Frida 的实现细节，但也是 Hook 开销与崩溃的主要来源。',
            state: { '调用链': 'ART → trampoline → JS handler' } },
          { code: '<span class="c">// ⑤ Java 侧再次调用时</span>\n<span class="k">String</span> n = bean.<span class="f">getName</span>();  <span class="c">// 进入我们的代码</span>',
            note: '<b>生效了。</b>Java 代码毫无变化，但执行流已经改道。注意：改的是<b>类的元数据</b>而不是某个对象——所以这个类的<b>所有实例</b>都受影响。',
            state: { '影响范围': '该类的全部实例' } },
          { code: '<span class="c">// ⑥ 还原</span>\nflags = original_flags; entry_point = original_entry;',
            note: '<b>把两个字段写回去就卸载完成。</b>所以备份必须是<b>两个字段都备</b>：只还原 entry 不还原 flags，方法在 ART 眼里仍然是 native，会走错执行路径——这是很多「卸载 Hook 后崩溃」的真凶。',
            state: { '还原': 'flags / entry 双双复位' } },
          { code: '<span class="c">// ⑦ 为什么有时会崩</span>\n<span class="c">// 入口被改后，若 GC 或并发执行正在读这个 ArtMethod…</span>',
            note: '<b>玄学现象的解释。</b>ArtMethod 是<b>多线程共享</b>的元数据。你改它的同时，其他线程可能正在读它或正在其中执行。这就是为什么 Hook 要挑时机、要注意内存可见性——也是 ART 内部要给这类操作加同步的原因。',
            state: { '并发风险': '多线程共享元数据', '表现': '偶发崩溃' } },
          { code: '<span class="c">// ⑧ 同样的手法，用于定制 ART 时</span>\n<span class="c">// 我们不改 entry，只在入口处加记录点</span>',
            note: '<b>回到本章的主线。</b>同样的位置，两种用法：Hook 框架<b>改写</b>入口以改变行为（会被检测、会崩）；定制 ART 可以只在入口<b>记录</b>而不改变逻辑——这就是「沙箱」与「Hook」的差别：前者要的是观测，后者要的是控制。',
            state: { 'Hook': '改写，追求控制', '沙箱插桩': '只读，追求观测' } }
        ]
      },
      after: T.tbl(['问题现象', '底层原因', '该往哪查'], [
        ['Hook 后反射看到方法变成 native', 'access_flags 的 native 位被置 1', '检查 Hook 框架是否暴露了原始 flags'],
        ['卸载 Hook 后调用崩溃', '只还原了入口，没还原 flags', '两个字段都要备份与还原'],
        ['Hook 生效但偶发崩溃', 'ArtMethod 是多线程共享元数据', '检查 Hook 时机与并发访问'],
        ['某些 ROM 上 Hook 完全无效', '入口字段的布局/语义随版本变化', '对照该版本 AOSP 的 ArtMethod 定义']
      ]) + ' ' + T.note('', '💡 对逆向实战的意义',
        '<p>知道 Hook 的抓手是 ArtMethod，你就能<b>反着用</b>：检测方面可以校验 ArtMethod 的 flags 与入口是否被改过；' +
        '分析方面，遇到 Hook 失效时也知道该去核对哪个字段。</p>'),
      quiz: {
        id: 'q4-2', chapter: 4, answer: 2,
        stem: 'Java Hook 框架把一个普通 Java 方法的 <span class="mono">access_flags</span> 置上 native 位、并替换执行入口。它为什么要<b>先改成 native</b>，而不是只替换入口了事？',
        options: [
          { t: '因为只有 native 方法才允许修改执行入口', why: '入口字段本身没有这样的权限限制，这不是原因。' },
          { t: '因为 native 方法的调用路径最短，能绕开解释器与 Dex 代码查找', why: '这是主要原因。改成 native 后 ART 不再去查 Dex 代码、不再走解释执行，直接取函数指针调用，替换入口才真正生效且开销最小。' },
          { t: '为了让方法在反射时看起来像系统方法，避免被检测', why: '恰好相反——这会让反射结果出现「本该是 Java 方法却显示 native」的破绽，反而是检测点。' },
          { t: '为了触发 GC 重新分配方法的内存', why: '与 GC 无关。ArtMethod 是类的元数据，不随对象分配移动。' }
        ],
        explain: '<b>核心是「短路原有的执行路径」。</b>普通 Java 方法的调用要经过 Dex 代码定位、解释器或已编译代码的进入逻辑；' +
                 'native 方法则简单得多——虚拟机直接使用 ArtMethod 上记录的函数指针。把方法伪装成 native，' +
                 '等于同时关掉了原路径、打开了新路径，替换入口才能干净生效。代价是留下「flags 与实际实现不符」这个可被检测的特征。'
      }
    },
    ,
    /* ================= 4.7 ================= */
    {
      h: '4.7',
      title: 'inline 的代价：函数在二进制里根本不存在',
      html:
        '<p>你写了一个函数，下了断点，跑起来——<strong>断点不生效</strong>。你以为断点打错了地方，反复确认。真相可能是：这个函数<strong>已经不在二进制里了</strong>。</p>' +
        T.note('key', '🔑 inline 的本质',
          '<p>编译器把函数体<b>展开到每一个调用处</b>，从而消除调用开销（压栈、跳转、返回）。' +
          '但 <span class="mono">inline</span> 关键字<b>只是建议</b>，真正拍板的是编译器的优化决策：函数体够小 + 开了 <span class="mono">-O2</span>/<span class="mono">-O3</span>，' +
          '它就会内联，<b>你写不写 inline 都可能被内联</b>。</p>') +
        '<p>这带来三个连锁后果，它们全都发生在<strong>调试期</strong>，而根源在<strong>编译期</strong>：</p>',
      stage: {
        title: 'inline 之后，调试器看到的和你想的不一样',
        speed: 1600,
        render:
          '<div class="grid2">' +
            '<div><div class="card-title">源代码（你写的）</div><div class="memgrid">' +
              '<div class="memrow"><span class="addr">L10</span><span class="cell" id="s_helper">int helper(int x) {</span></div>' +
              '<div class="memrow"><span class="addr">L11</span><span class="cell" id="s_body">  return x * 2 + 1;</span></div>' +
              '<div class="memrow"><span class="addr">L12</span><span class="cell" id="s_end">}</span></div>' +
              '<div class="memrow"><span class="addr">L20</span><span class="cell" id="s_call">y = helper(a);</span></div>' +
            '</div></div>' +
            '<div><div class="card-title">编译后的机器码</div><div class="memgrid">' +
              '<div class="memrow"><span class="addr">0x1000</span><span class="cell" id="b_main">main 入口</span></div>' +
              '<div class="memrow"><span class="addr">0x1010</span><span class="cell" id="b_inl">内联后的表达式</span></div>' +
              '<div class="memrow"><span class="addr">0x1020</span><span class="cell" id="b_next">后续指令</span></div>' +
            '</div>' +
            '<div style="margin-top:10px"><span class="pill" id="sym">符号表：helper 存在</span></div></div>' +
          '</div>' +
          '<div style="margin-top:12px" class="flow-row"><span class="blk" id="bp">🔴 断点@L10</span><span class="arrow">→</span><span class="pill" id="bpst">等待</span></div>',
        reset: () => {
          const ids = ['s_helper', 's_body', 's_end', 's_call', 'b_main', 'b_inl', 'b_next'];
          for (const i of ids) CLS(i, 'cell');
          CLS('sym', 'pill'); SET('sym', '符号表：helper 存在');
          S('bp', ''); CLS('bpst', 'pill'); SET('bpst', '等待');
        },
        steps: [
          { run: () => { CLS('s_helper', 'cell hi'); CLS('s_body', 'cell hi'); CLS('s_end', 'cell hi'); },
            note: '<b>先看你的意图。</b>helper 是个只有一行的小函数。你希望它作为一个独立函数存在，这样能在第 10 行下断点、单步进入、看 x 的值。这是<b>读代码的人</b>的心智模型。',
            state: { '期望': 'helper 是独立函数' } },
          { run: () => { CLS('s_call', 'cell hi'); },
            note: '<b>调用点在第 20 行。</b>按照你的模型，这里应该生成一条 <span class="mono">call helper</span> 指令，跳到另一块代码去，执行完再回来。',
            state: { '期望指令': 'call helper' } },
          { run: () => { CLS('b_inl', 'cell wr'); SET('b_inl', 'x*2+1 展开在这里'); CLS('s_call', 'cell'); },
            note: '<b>编译器的决定：不生成 call，直接把函数体抄过来。</b>0x1010 处是 <span class="mono">helper</span> 的表达式本身，而不是一条调用指令。省下了一次压栈/跳转/返回。',
            state: { '实际指令': '无 call，指令直接内联' } },
          { run: () => { CLS('b_inl', 'cell wr'); CLS('s_body', 'cell miss'); SET('s_body', '  （此函数体无独立代码）'); },
            note: '<b>后果一：断点打不上。</b>调试断点的本质是「在某个<b>地址</b>上插一条陷阱指令」。helper 已经没有自己的地址了——你让它把断点插在哪？调试器要么拒绝，要么把它挪到最近的合法地址，于是你看到的停靠位置莫名其妙。',
            state: { '断点@L10': '无处安放 ✗' } },
          { run: () => { S('bp', 'hot'); CLS('bpst', 'pill bad'); SET('bpst', '断点未命中 · helper 无独立入口'); },
            note: '<b>现象确认。</b>程序跑过去了，断点一次都没停。新手的第一反应通常是「我断点位置不对」或「调试器坏了」——真实原因是<b>这个函数在机器码层面不存在</b>。',
            state: { '误判方向': '调试器/断点位置', '真实原因': '编译期内联' } },
          { run: () => { CLS('s_helper', 'cell miss'); SET('s_helper', 'int helper(int x) {  ← 已展开'); },
            note: '<b>后果二：变量看不到。</b>内联之后，参数 x 和局部变量会被尽量塞进<b>寄存器</b>，或者干脆在优化中被消除（比如常量折叠后不再需要这个值）。调试器想显示它们时只能输出 <span class="mono">&lt;optimized out&gt;</span>。',
            state: { '变量 x': '<optimized out>' } },
          { run: () => { CLS('b_main', 'cell'); CLS('b_inl', 'cell'); CLS('b_next', 'cell wr'); SET('b_next', '后续指令（无 call/ret 边界）'); },
            note: '<b>后果三：调用栈不完整。</b>栈回溯是靠「压栈的返回地址」串起来的。内联没有调用，也就没有返回地址——helper 这一帧在栈上<b>从来不存在</b>。注意 0x1010 与 0x1020 <b>之间没有任何函数边界</b>，你在崩溃日志里看到的调用关系，会直接跳过 helper。',
            state: { '栈帧': 'helper 帧不存在' } },
          { run: () => { CLS('sym', 'pill warn'); SET('sym', '符号表：helper 仍在（调试信息）'); },
            note: '<b>一个反直觉的细节：符号可能还在。</b>调试信息（DWARF）会记录「这段指令原本来自 helper」，用 <span class="mono">DW_TAG_inlined_subroutine</span> 表示内联进来的子程序。所以在 GDB 里 <span class="mono">info frame</span> 有时仍能看到它——<b>但它不是一个真实的栈帧</b>。',
            state: { 'DWARF': 'DW_TAG_inlined_subroutine', 'GDB': 'info frame 可显示' } },
          { run: () => { CLS('b_inl', 'cell cool'); CLS('bpst', 'pill ok'); SET('bpst', '用 GDB 看内联帧 / 或禁止内联'); },
            note: '<b>两条出路。</b>要么接受内联、改用 GDB 的内联帧视图去观察；要么在编译期就禁止它——加 <span class="mono">-fno-inline</span>、给函数加 <span class="mono">__attribute__((noinline))</span>、或临时降低优化等级。',
            state: { '出路1': 'GDB info frame', '出路2': 'noinline / 降优化' } },
          { run: () => { CLS('bpst', 'pill bad'); SET('bpst', '反向应用：Native Hook 静默失效'); },
            note: '<b>把这件事反过来看，就是逆向的坑。</b>你想 Hook 一个 native 函数，地址算出来了，Frida 也 attach 上了，<b>但什么反应都没有</b>——因为这个函数在编译时已经被内联进它的调用者，二进制里<b>压根没有这个函数</b>。你 Hook 的是一个不存在的地址。',
            state: { '症状': 'Hook 无报错但无效果', '原因': '目标已被内联' } },
          { run: () => { S('bp', 'cool'); CLS('bpst', 'pill ok'); SET('bpst', '对策：Hook 调用者 / 搜索内联后的指令序列'); },
            note: '<b>正确对策。</b>目标函数不存在时，只能往上走一层：Hook 它的<b>调用者</b>，或者在二进制里搜索内联展开后的<b>指令特征</b>。' +
                  '这也解释了为什么有些加固会主动利用内联——它免费获得了「让 Hook 找不到落点」的效果。',
            state: { 'Hook 落点': '调用者 / 指令特征', '加固收益': '增加 Hook 难度' } }
        ]
      },
      after: T.tbl(['症状', '成因', '对策'], [
        ['断点打不上 / 停靠位置怪异', '函数被内联，无独立入口地址', '-fno-inline、__attribute__((noinline))、降优化等级'],
        ['变量显示 &lt;optimized out&gt;', '变量被放进寄存器或优化消除', '降优化等级；在汇编层看寄存器'],
        ['调用栈缺少某一帧', '内联没有产生栈帧', 'GDB info frame 看 DW_TAG_inlined_subroutine'],
        ['Hook 静默失效（无报错无效果）', '目标函数在二进制中不存在', 'Hook 调用者，或按内联后的指令特征定位']
      ]) + ' ' + T.note('', '💡 这是「理论与实战的接缝」',
        '<p>inline 看上去是编译原理的细节，实际直接决定你的 Native Hook 能不能落地。' +
        '<b>排查顺序建议：</b>先确认符号/地址是否真实存在（反汇编看那里是不是一个函数入口），再怀疑 Hook 框架，最后才怀疑自己的代码。</p>'),
      quiz: {
        id: 'q4-3', chapter: 4, answer: 3,
        stem: '你用 Frida 对某个 native 函数做了 Hook（地址计算准确、attach 无报错），但目标程序行为毫无变化，也没有任何异常输出。下面哪个原因<b>最可能</b>？',
        options: [
          { t: 'Frida 版本与目标不兼容，Hook 静默失败了', why: '版本不兼容通常会报错或崩溃，而不是「安静地什么都不发生」。' },
          { t: '这个函数在程序里从未被调用过', why: '有可能，但这属于「逻辑上没执行」；相比编译期内联，它更少见，而且你可以通过调用者路径很快证伪。' },
          { t: '函数有反调试保护，检测到 Frida 后跳过了自身逻辑', why: '反调试通常会主动崩溃或退出，而不是保留完整功能却不执行你的 Hook。' },
          { t: '该函数已被编译器内联进调用者，二进制里没有独立函数体', why: '这正是「无报错、无效果」的最典型成因。你 Hook 的地址处根本没有那个函数，替换自然毫无影响。' }
        ],
        explain: '<b>先建立正确的排查顺序：地址真实性 → 框架 → 自己的代码。</b>' +
                 '内联是编译器在<b>优化期</b>做的决定，函数体被展开进调用者之后就不再存在独立入口。' +
                 '此时你算出的「函数地址」可能落在调用者中间、或落在相邻函数的边界上——Hook 能装上，却永远不会被走到。' +
                 '对策是 Hook 调用者，或按内联后指令序列的特征去搜索真正的执行位置。'
      }
    },

    /* ================= 4.8 ================= */
    {
      h: '4.8',
      title: '定制 ART 的方案比较与实施流程',
      html:
        '<p>「定制 ART」听上去很重，实际有<strong>不同重量级</strong>的做法。先选路线，再谈流程——选错路线会让你在编译上浪费几周。</p>' +
        T.tbl(['方案', '做法', '成本', '适用场景'], [
          ['运行时 Hook（Frida 等）', '不改源码，挂载时改写 ArtMethod', '低，分钟级', '快速验证、单点观察、样本量小'],
          ['改 ART 源码并编译', '插桩后重新编译 art 模块，刷入设备', '高，天到周级', '需要完整、稳定、不可被检测的记录能力'],
          ['使用现成定制 ROM', '基于他人已改好的产物二次开发', '中', '通用需求（如整体方法跟踪），无特殊插桩点'],
          ['模拟器 / 容器内运行', '把 App 放进可控环境执行', '中', '批量自动化分析；但环境特征明显，易被识别']
        ]) +
        T.note('key', '🔑 选择的第一原则：先问「我要观测什么」',
          '<p>如果你只是想知道「这个方法有没有被调用」，运行时 Hook 就够了，别去编译 ART。' +
          '只有当你要观测的东西<b>发生在 Hook 框架能够介入之前</b>（比如注册那一刻本身），或者你需要<b>环境本身不可被发现</b>时，改虚拟机才有意义。</p>') +
        T.grid(2, [
          '<div class="card"><div class="card-title">✅ 定制 ART 的收益</div>' +
          '<p>· 记录点在你自己的代码里，不依赖 hook 框架<br>' +
          '· 没有 Frida/注入的进程特征可供检测<br>' +
          '· 能看到框架看不到的东西（如注册映射的生成过程）<br>' +
          '· 一次插桩，长期复用；可做成产品化的沙箱</p></div>',
          '<div class="card"><div class="card-title">⚠️ 定制 ART 的代价</div>' +
          '<p>· <b>编译环境</b>：AOSP 体积大、依赖多，首次搭建最痛<br>' +
          '· <b>版本绑定</b>：源码随 AOSP 版本变化，换版本要重新定位插桩点<br>' +
          '· <b>刷机风险</b>：刷错会导致设备无法启动<br>' +
          '· <b>完整性校验</b>：部分 App 会校验系统镜像，定制 ROM 可能被拒</p></div>'
        ]) +
        '<p>下面用终端把整个流程走一遍。注意每一步的<b>失败信号</b>——出问题时按这个顺序回查最快。</p>',
      term: {
        title: '定制 ART 沙箱的实施流程（概念层）',
        lines: [
          { t: 'd', s: '# 步骤 1：确定目标版本 —— 版本必须与设备/目标严格对应' },
          { t: 'p', s: 'adb shell getprop ro.build.version.release && getprop ro.build.version.sdk', note: '<b>先问清楚设备是什么版本。</b>ART 源码随 AOSP 版本变化很大，插桩点必须和设备的 SDK/版本对得上。若用真机，还需确认设备的 Build ID 与源码分支一致。' },
          { t: 'o', s: '12\n31' },
          { t: 'd', s: '# 步骤 2：下载并准备 AOSP 源码（体积大，首次最耗时）' },
          { t: 'p', s: 'repo init -u <AOSP_MANIFEST_URL> -b <对应分支>', note: '<b>分支要和步骤 1 的版本对应。</b>具体 manifest 地址与分支名请以官方文档为准。这一步的主要成本是磁盘与时间。' },
          { t: 'w', s: 'warning: 源码树体积可达上百 GB，请预留足够磁盘空间', note: '<b>提前规划磁盘。</b>中途磁盘满会导致 sync 中断，排查起来很费时间。' },
          { t: 'd', s: '# 步骤 3：定位插桩点（本章的 RegisterNatives）' },
          { t: 'p', s: 'grep -rn "RegisterNatives" art/ | grep -i "JNINativeMethod"', note: '<b>用两个关键词交叉搜索。</b>能同时命中 <span class="mono">RegisterNatives</span> 与 <span class="mono">JNINativeMethod</span> 的那个文件，就是处理动态注册的地方。<span class="pill warn">具体文件名随版本变化，待核实</span>' },
          { t: 'o', s: 'art/runtime/jni/jni_internal.cc: ... RegisterNatives(...)' },
          { t: 'd', s: '# 步骤 4：插桩 —— 在循环体里加一行只读日志' },
          { t: 'p', s: 'vim art/runtime/jni/jni_internal.cc', note: '<b>只加记录，不改逻辑。</b>这是最重要的纪律：探针必须保证虚拟机行为完全不变，否则你的沙箱本身就成了不可信环境。' },
          { t: 'd', s: '# 步骤 5：只编译 art 模块（不要全量编译 AOSP）' },
          { t: 'p', s: 'source build/envsetup.sh && lunch <对应产品>' },
          { t: 'p', s: 'm art  # 或 mm -j$(nproc)', note: '<b>关键技巧：只编 art。</b>全量编译 AOSP 动辄数小时；只编译 art 模块通常在可接受范围内，迭代插桩时这一点决定了你的效率。' },
          { t: 'e', s: 'error: 依赖缺失 / 头文件路径不对', note: '<b>最常见的失败。</b>多是因为没执行 <span class="mono">lunch</span> 选对产品，或环境变量未 source。看到这类错误先回查环境初始化步骤。' },
          { t: 'd', s: '# 步骤 6：把产物送到设备并生效' },
          { t: 'p', s: 'adb root && adb remount && adb push <art 相关产物> /system/lib64/', note: '<b>注意位与 ABI。</b>32/64 位产物路径不同，推错会导致开机失败。<b>强烈建议先在模拟器或可恢复的设备上验证。</b>刷入前务必确认有回滚手段（备份原文件/可重刷的镜像）。' },
          { t: 'w', s: 'warning: 修改系统分区有变砖风险，请先备份原始产物', note: '<b>这不是客套话。</b>ART 是系统启动的关键组件，替换错误会让设备卡在开机动画。' },
          { t: 'd', s: '# 步骤 7：验证插桩是否生效' },
          { t: 'p', s: 'adb logcat | grep TRACE', note: '<b>验证信号：日志里出现你插桩时打的标记。</b>如果没有输出，按「编译有没有真的重新生成产物 → 推入的文件有没有生效 → 目标 App 是否真的触发了 RegisterNatives」的顺序回查。' },
          { t: 'o', s: '[TRACE] com.demo.MyBean.getName()Ljava/lang/String; -> 0x7f6c9e40' },
          { t: 'o', s: '[TRACE] com.demo.MyBean.nativeCheck()Z           -> 0x7f6cab00' },
          { t: 'd', s: '# 步骤 8：把日志变成可用的分析输入' },
          { t: 'p', s: 'adb pull /data/local/tmp/art-trace.log ./bindings.txt', note: '<b>产物落地。</b>把映射表拉回主机，交给 IDA/Ghidra 标注函数名，或在 gdb 里按地址下断——沙箱的价值最终体现在这张表上。' },
          { t: 'o', s: '--- 4 bindings recorded ---', note: '<b>到这里，动态分析沙箱的最小闭环就通了。</b>你有了一套自己掌控、能记录关键事件的运行环境。' }
        ]
      },
      after: T.note('warn', '⚠️ 本章所有源码细节的定位方法',
        '<p>本节刻意只给出<b>方法</b>而不给出<b>确定的行号与文件名</b>——因为 AOSP 结构随版本变化很大，写死细节等于制造错误。' +
        '凡标注 <span class="pill warn">待核实</span> 的地方，请在<b>你手上那个版本</b>的源码里用关键词搜索确认。</p>' +
        '<p><b>通用检索词：</b><span class="mono">RegisterNatives</span>、<span class="mono">JNINativeMethod</span>、' +
        '<span class="mono">ArtMethod</span>、<span class="mono">RegisterNative</span>。</p>') +
        T.note('', '💡 沙箱的终局形态',
        '<p>插一个点只是开始。同一套方法可以扩展成：JNI 注册跟踪、类加载跟踪、方法调用跟踪、反射调用跟踪……' +
        '当这些记录点都在你自己编译的虚拟机里，你得到的就不只是一个工具，而是一个<b>可编程的观测平台</b>——' +
        '这就是「<span class="term" data-def="一套你自己掌控、能记录一切关键事件的 Android 运行环境">动态分析沙箱</span>」的真正含义。</p>')
    },

    /* ================= 4.9 ================= */
    {
      h: '4.9',
      title: '决策演练①：目标 so 的符号表是空的',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一',
            scenario: '<b>情境：</b>你接到一个加固样本。用 IDA 打开它的 <span class="mono">libprotect.so</span>，导出表里只有 ' +
                      '<span class="mono">JNI_OnLoad</span> 和 <span class="mono">JNI_OnUnload</span>，' +
                      '所有 <span class="mono">Java_</span> 前缀的函数一个都没有。但 App 的 native 功能运行完全正常。<br><br>' +
                      '<b>你的第一步是什么？</b>',
            choices: [
              { t: '先跑起来，用 Frida 脚本列出这个 so 里所有已注册的 native 方法', next: 'n1' },
              { t: '用脱壳工具先脱壳，把真正的 dex 和 so dump 出来再说', next: 'n2' },
              { t: '猜测函数在 JNI_OnLoad 里被手动调用，试着跟 JNI_OnLoad 的控制流', next: 'n3' },
              { t: '在 IDA 里按字符串搜索加密算法特征（如 AES S-box）来定位关键函数', next: 'n4' }
            ]
          },
          n1: {
            label: '选 A', terminal: true, verdict: 'good',
            verdictTitle: '正确：先确认「注册」这件事本身',
            result: '<b>符号表为空 + 功能正常 = 动态注册的教科书特征。</b>正确的第一步是<b>确认并枚举</b>注册关系，' +
                    '而不是急着去 dump 或猜函数。<br><br>' +
                    '具体做法有两层：用 Frida hook <span class="mono">RegisterNatives</span> 看参数，' +
                    '或直接 hook <span class="mono">JNI_OnLoad</span> 的返回值；更彻底的，就是本章的路子——' +
                    '在自己编译的 ART 里把注册映射记下来。<br><br>' +
                    '<b>为什么这是最优解：</b>它直接产出「Java 方法 ↔ native 地址」的对照表，' +
                    '让后续所有分析都有了锚点。你会知道哪个地址对应哪个 Java 方法，而不是面对一堆无名函数。'
          },
          n2: {
            label: '选 B', terminal: true, verdict: 'bad',
            verdictTitle: '方向偏了：这里的问题不是壳，是注册方式',
            result: '<b>你把「符号表为空」误判成了「内容被加密」。</b>这是很常见的条件反射——见到看不懂的就上脱壳工具。<br><br>' +
                    '<b>认知根源：</b>混淆了两件不同的事。<b>动态注册</b>是 JNI 的正常机制，函数本来就不需要导出符号；' +
                    '<b>加壳</b>是另一回事。符号表干净不代表代码被加密——IDA 里那些函数体很可能清清楚楚，' +
                    '只是没有名字，你不知道哪个是哪个。<br><br>' +
                    '脱壳工具在这里既解决不了问题（没有壳可脱），又会浪费大量时间。<b>先判断问题类型，再选工具。</b>'
          },
          n3: {
            label: '选 C', terminal: true, verdict: 'bad',
            verdictTitle: '不算错但效率低：你会淹死在指针运算里',
            result: '<b>方向对了一半，但手段选错了。</b>动态注册确实发生在 <span class="mono">JNI_OnLoad</span> 的执行过程中，' +
                    '跟着它的控制流理论上能看到注册。<br><br>' +
                    '<b>问题在于量级：</b>JNI_OnLoad 里往往是一长串初始化逻辑——解密字符串、拼装 <span class="mono">JNINativeMethod</span> 数组、' +
                    '可能还有反调试。静态跟下来，你要在汇编里手工推算出每个 <span class="mono">fnPtr</span> 的值（常常是运行时计算的，静态根本算不出），' +
                    '成本极高。<br><br>' +
                    '<b>正确姿势：</b>让虚拟机在运行时把结果告诉你。同一件事，动态观测的成本低几个数量级。'
          },
          n4: {
            label: '选 D', terminal: true, verdict: 'bad',
            verdictTitle: '方向错了：先建映射，再找算法',
            result: '<b>这是「跳过地图直接找宝藏」。</b>按算法特征搜字符串确实是实用技巧，但它解决的是「我已知要找什么」的问题。<br><br>' +
                    '<b>现在你连有哪些函数都不知道。</b>一个加密函数可能用了自定义 S-box、可能用了白盒、可能压根不是标准实现——' +
                    '特征搜索的命中率极低。就算侥幸命中，你也不知道它被哪个 Java 方法调用、在业务里扮演什么角色。<br><br>' +
                    '<b>顺序应该是：</b>先拿到「Java 方法 → native 地址」的映射表（建立地图），再针对可疑方法（比如名字叫 <span class="mono">check</span>、' +
                    '签名返回 boolean 的那些）深入分析。有了地图，搜索范围能缩小一两个数量级。'
          }
        }
      }
    },
    ,
    /* ================= 4.10 ================= */
    {
      h: '4.10',
      title: '决策演练②：那个偶发崩溃的回调',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境二',
            scenario: '<b>情境：</b>你在给一个定制 ART 写功能：需要在类加载完成后，<b>延迟一段时间</b>再去检查某个类的状态。' +
                      '你写了这样一段代码：<br><br>' +
                      '<span class="mono">void OnClassLoaded(mirror::Class* c) {</span><br>' +
                      '<span class="mono">&nbsp;&nbsp;std::string name = c-&gt;PrettyDescriptor();</span><br>' +
                      '<span class="mono">&nbsp;&nbsp;auto task = [&amp;]() { Check(name); };</span><br>' +
                      '<span class="mono">&nbsp;&nbsp;PostDelayedTask(task, 2000);</span><br>' +
                      '<span class="mono">}</span><br><br>' +
                      '编译通过，功能大部分时候正常，但<b>偶尔崩溃</b>，栈回溯指向一些毫不相关的函数。<br><br>' +
                      '<b>你判断问题出在哪？</b>',
            choices: [
              { t: 'ART 的线程模型有问题，回调没有在正确的线程上执行', next: 'n1' },
              { t: 'lambda 用了 [&] 按引用捕获局部变量 name，而回调在它销毁之后才执行', next: 'n2' },
              { t: 'PostDelayedTask 的延迟时间太短，任务队列还没准备好', next: 'n3' },
              { t: 'mirror::Class* 的类对象在 GC 中被移动了，需要改成 Handle', next: 'n4' }
            ]
          },
          n1: {
            label: '选 A', terminal: true, verdict: 'bad',
            verdictTitle: '误判：把生命周期问题当成了线程问题',
            result: '<b>线程确实要注意，但它解释不了「大部分时候正常」。</b>线程问题通常表现为更稳定的错误：数据竞争、断言失败、或者干脆必然崩溃。<br><br>' +
                    '<b>认知根源：</b>「偶发 + 栈回溯乱」很容易被归因为并发。但请注意这里的<b>时间结构</b>：' +
                    '延迟 2 秒后执行，而局部变量在函数返回时就没了——这是一个<b>确定的时序缺陷</b>，' +
                    '只是因为那块栈内存「有时还没被覆盖」，所以有时侥幸不崩。<br><br>' +
                    '<b>怎么区分：</b>并发 bug 与负载/核数相关；生命周期 bug 与<b>栈使用深度、调用时序</b>相关。' +
                    '把延迟调长、或在内层多嵌套几层函数调用，如果崩溃率显著上升，就是生命周期问题。'
          },
          n2: {
            label: '选 B', terminal: true, verdict: 'good',
            verdictTitle: '正确：这是典型的悬垂引用',
            result: '<b>正是这一处。</b><span class="mono">[&amp;]</span> 会生成一个匿名类，把 <span class="mono">name</span> 的<b>地址</b>存成成员变量。' +
                    '<span class="mono">OnClassLoaded</span> 返回后，<span class="mono">name</span> 所在的栈帧被回收。' +
                    '2 秒后回调执行，读的是一个<b>已经失效的地址</b>。<br><br>' +
                    '<b>为什么难查：</b>那块内存可能还留着原来的字节（侥幸正常），也可能早被后续调用覆盖成任意内容。' +
                    '崩溃时栈回溯指向「正在覆盖那块内存的无辜函数」，所以看起来毫不相关。<br><br>' +
                    '<b>正确改法：</b>把捕获改成值捕获 <span class="mono">[name]</span> 或 <span class="mono">[=]</span>，' +
                    '让匿名类持有<b>自己的拷贝</b>；如果代价太大（比如是很大的对象），就用 <span class="mono">shared_ptr</span> 共享所有权，' +
                    '把生命周期显式绑在一起。<br><br>' +
                    '<b>在 ART 里还要多问一句：</b>捕获的东西里如果有裸的 Java 对象指针，还要考虑 GC 移动的问题——' +
                    '值捕获只解决栈生命周期，不解决 GC 移动。'
          },
          n3: {
            label: '选 C', terminal: true, verdict: 'bad',
            verdictTitle: '误判：任务队列不会因为「太早」而崩',
            result: '<b>任务队列的成熟度不是崩溃原因。</b>队列要么可用、要么根本没法提交任务，不会表现出「2 秒后偶发段错误」。<br><br>' +
                    '<b>认知根源：</b>把「延迟参数」当成了可疑变量。延迟时间影响的是<b>什么时候</b>执行，' +
                    '而这里的问题是<b>执行时访问的内存已经无效</b>——把延迟改成 1 秒或 10 秒，bug 依然存在，只是概率变化。<br><br>' +
                    '<b>一个有用的习惯：</b>面对偶发 bug，先问「这件事在时间轴上的依赖关系是什么」。' +
                    '如果答案是「A 的数据比 A 自己活得更久」，那十有八九是生命周期问题，而不是调度问题。'
          },
          n4: {
            label: '选 D', terminal: true, verdict: 'bad',
            verdictTitle: '抓错了对象：问题不在参数，在捕获列表',
            result: '<b>方向有道理，但没找对位置。</b>GC 移动对象确实要求用 <span class="mono">Handle&lt;T&gt;</span> / ' +
                    '<span class="mono">ObjPtr&lt;T&gt;</span> 这类 GC 安全句柄——这个知识点本身是对的，' +
                    '而且在 ART 里极其重要。<br><br>' +
                    '<b>但这里的问题不在这儿：</b>注意代码里 <span class="mono">name</span> 是 <span class="mono">std::string</span>，' +
                    '一个 C++ 对象，不是 Java 对象引用，GC 根本不管它。它的死因是<b>栈帧销毁</b>，不是 GC 移动。<br><br>' +
                    '<b>认知根源：</b>学到「ART 里要注意 GC 移动」之后，容易到处套用。' +
                    '诊断时要先分清：这个崩溃涉及的是 <b>C++ 对象的生命周期</b>，还是 <b>Java 对象的 GC 生命周期</b>？' +
                    '两者都可能出问题，但对策完全不同——前者靠捕获方式与智能指针，后者靠 Handle/ObjPtr。'
          }
        }
      }
    },

    /* ================= 4.11 ================= */
    {
      h: '4.11',
      title: '决策演练③：断点打不上的那个函数',
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境三',
            scenario: '<b>情境：</b>你怀疑目标 App 的一个 native 函数 <span class="mono">verify_signature</span> 是校验入口。' +
                      '你用 gdb attach 上去，在 <span class="mono">verify_signature</span> 上下了断点。' +
                      '程序能正常跑完整个校验流程（不符合预期时会弹提示框，说明确实执行了校验），' +
                      '<b>但断点一次都没命中</b>。<br><br>' +
                      '而且你注意到：在这个函数里定义的局部变量，就算在别处断下来也看不到。<br><br>' +
                      '<b>你的下一步是？</b>',
            choices: [
              { t: '怀疑是反调试：目标检测到 gdb 后让断点失效，先去做反反调试', next: 'n1' },
              { t: '先反汇编确认那个地址上到底有没有一个独立函数，再决定改在哪里下断', next: 'n2' },
              { t: '换个更强的调试器，比如 IDA 的远程调试服务', next: 'n3' },
              { t: '在函数入口的地址上直接改内存插一条断点指令，绕过 gdb 的符号处理', next: 'n4' }
            ]
          },
          n1: {
            label: '选 A', terminal: true, verdict: 'bad',
            verdictTitle: '过早归因于对抗：还有一个更平淡的解释',
            result: '<b>反调试确实存在，但你跳过了最便宜的那个排查步骤。</b>注意情境里的第二条线索：' +
                    '<b>局部变量也看不到</b>。反调试通常只影响「能不能停住」，不会让变量消失。<br><br>' +
                    '<b>认知根源：</b>一旦把逆向当成「人 vs 人」的对抗，就容易把所有异常都解读为对方的招数。' +
                    '但这里的两个症状——断点不命中 + 变量不可见——指向同一个<b>编译期</b>原因：函数被内联了，' +
                    '既没有独立入口可供下断，局部变量也被优化进了寄存器或直接消除。<br><br>' +
                    '<b>正确顺序：</b>先排除非对抗性解释（编译优化、符号缺失、地址算错），再考虑对抗。' +
                    '否则你会花几天做反反调试，最后发现对手根本没出手。'
          },
          n2: {
            label: '选 B', terminal: true, verdict: 'good',
            verdictTitle: '正确：先验证「这个函数在二进制里存在吗」',
            result: '<b>这是最省时间的下一步。</b>在反汇编视图里跳到 <span class="mono">verify_signature</span> 的地址，' +
                    '看那里到底是什么：<br><br>' +
                    '<b>·</b> 如果是标准的函数序言（保存寄存器、调整栈指针）→ 函数真实存在，问题在调试器/符号侧；<br>' +
                    '<b>·</b> 如果落在一段普通指令中间、或者跟相邻函数没有边界 → <b>它被内联了</b>，' +
                    '二进制里没有这个函数体。<br><br>' +
                    '<b>为什么这个顺序对：</b>它用一次反汇编就区分了两类完全不同的原因，' +
                    '而两类原因的后续动作差别巨大（一个去调调试器，一个去改 Hook 落点）。' +
                    '加上「局部变量不可见」这条线索，答案几乎已经写出来了：<b>这是内联的典型症状组合</b>。<br><br>' +
                    '<b>后续动作：</b>往上找<b>调用者</b>——校验一定会被某处调用，在那层的函数边界上下断；' +
                    '或者按内联展开后的指令特征去搜索。'
          },
          n3: {
            label: '选 C', terminal: true, verdict: 'bad',
            verdictTitle: '换工具解决不了不存在的东西',
            result: '<b>如果目标函数在二进制里根本不存在，任何调试器都断不下来。</b>换 IDA、换 lldb、换硬件断点，结果都一样。<br><br>' +
                    '<b>认知根源：</b>把「调试器不好用」当成根因。工具差异确实存在（比如对符号、对内联帧的支持程度不同），' +
                    '但那是<b>观测能力</b>的差异，不是<b>观测对象存在与否</b>的差异。<br><br>' +
                    '有意思的是：某些调试器确实能更好地显示内联帧（靠 DWARF 的 <span class="mono">DW_TAG_inlined_subroutine</span>），' +
                    '所以换工具<b>可能让你看到更多信息</b>——但前提是你已经知道问题是内联。' +
                    '顺序应该是：先诊断，再换工具，而不是用换工具来替代诊断。'
          },
          n4: {
            label: '选 D', terminal: true, verdict: 'bad',
            verdictTitle: '手段升级了，但目标地址依然是错的',
            result: '<b>这是「用更硬的手段做同一件错事」。</b>手工往内存里写断点指令（比如 ARM64 的 <span class="mono">BRK</span>）确实能绕过调试器的一些机制，' +
                    '如果真的是反调试在捣鬼，这招有用。<br><br>' +
                    '<b>但这里的问题是地址本身没有意义。</b>如果函数被内联，你算出的地址落在调用者的指令流中间——' +
                    '在那里插断点，要么破坏了一条正常指令导致崩溃，要么停在一个语义上毫无意义的位置，' +
                    '让你误以为「断点生效了」而看到一堆看不懂的寄存器。<br><br>' +
                    '<b>更糟的是它掩盖了真相：</b>你会以为问题解决了，然后在错误的方向上继续投入。' +
                    '记住：<b>对抗性手段的前提是诊断已经完成。</b>没搞清楚对手是谁之前，升级手段只会让排查更难。'
          }
        }
      }
    },

    /* ================= 4.12 ================= */
    {
      h: '4.12',
      title: '自测：把三件事连起来',
      quiz: {
        id: 'q4-4', chapter: 4, answer: [0, 2],
        stem: '<b>多选：</b>关于「定制 ART 来跟踪 JNI 注册」相比「用 Frida hook RegisterNatives」，下面哪些说法是正确的？',
        options: [
          { t: '定制 ART 的记录发生在虚拟机代码内部，不引入可在运行时被检测的 hook 框架特征', why: '正确。探针是你编译进虚拟机的普通代码，进程里没有额外的注入模块或 hook 框架痕迹。' },
          { t: '定制 ART 可以在不改变目标程序行为的前提下完成记录', why: '正确，但这不是定制独有的优势——Frida hook 同样可以只观测不改写。所以这条不构成两者的区别（本项为干扰项）。' },
          { t: '定制 ART 能拿到 Java 方法名、签名与 native 地址的完整对应关系', why: '正确。注册那一刻这三者同时在手上，这正是插桩点选在 RegisterNatives 里的原因。' },
          { t: '定制 ART 不需要编译，因此比 Frida 更快落地', why: '错误，正好相反。定制 ART 需要准备 AOSP 环境并编译、刷入，落地成本远高于 Frida。' }
        ],
        explain: '<b>定制 ART 的核心优势只有一个词：位置。</b>你的记录点位于虚拟机<b>内部</b>——' +
                 '① 没有 hook 框架特征可供检测；② 天然掌握注册的全部四要素（类、方法名、签名、地址）。<br><br>' +
                 '<b>而它的代价是工程成本</b>：AOSP 环境、编译、刷机、版本绑定。所以要按需选择：' +
                 '只是想快速看一个方法有没有被调用，Frida 是更理性的选择；需要长期、稳定、不可被发现的观测能力时，才值得去编译虚拟机。<br><br>' +
                 '注意 B 选项是一个典型干扰项：<b>「只观测不改写」是插桩纪律，不是定制 ART 的独有优势</b>。'
      }
    },
  ],
  glossary: [
    { t: 'mirror::Object', d: 'Java 对象在 Native 层的镜像结构，也是所有 Java 对象的内存头部。第一个字段 klass_ 指向该对象的 mirror::Class，另有 monitor 锁信息。类似 HotSpot 的 mark word + klass pointer。' },
    { t: 'mirror::Class', d: 'Java 类的镜像，描述「这个类有哪些方法和字段」。含方法表、字段表、vtable、接口表。同一个类在虚拟机里只有一份，全部实例共享。' },
    { t: 'ArtMethod', d: '单个 Java 方法的元数据。关键字段：declaring_class_（声明类）、access_flags_（访问标志）、dex_code_item_offset_（Dex 代码偏移）、entry_point_from_quick_compiled_code_（实际执行入口，可为解释器/JIT/AOT）。是所有 Java Hook 的底层抓手。' },
    { t: 'JNINativeMethod', d: 'JNI 动态注册用的结构体，三个字段：name（Java 方法名）、signature（方法签名）、fnPtr（native 函数地址）。' },
    { t: 'RegisterNatives', d: 'JNI 函数，在 JNI_OnLoad 中被调用，把一张 JNINativeMethod 表交给虚拟机完成绑定。动态注册的唯一入口，也是本章的插桩点。' },
    { t: '动态注册', d: '不在符号表中暴露 Java_ 前缀函数名，而在运行时用 RegisterNatives 把「方法名 + 签名 + 函数地址」交给虚拟机。函数名可为任意字符串，地址运行时才定，静态分析难以恢复映射。' },
    { t: 'lambda 捕获', d: 'lambda 编译后生成匿名类（闭包类型），捕获的变量成为该类的成员变量。[=] 值捕获把值拷贝进成员；[&] 引用捕获把地址（本质是指针）存进成员。' },
    { t: '悬垂引用', d: '引用或指针指向的对象生命周期已结束。[&] 捕获局部变量后延后执行是典型成因：匿名类活过了它引用的栈变量。症状是偶发崩溃或读到脏数据，不一定立刻崩。' },
    { t: 'RAII', d: 'Resource Acquisition Is Initialization。构造时获取资源、析构时释放，把「配对操作」绑定到栈对象的生命周期上。ART 中用 ScopedObjectAccess、MutexLock 等保证异常与提前返回时也不泄漏。' },
    { t: 'Handle&lt;T&gt; / ObjPtr&lt;T&gt;', d: 'ART 的 GC 安全句柄。GC 会移动对象，裸指针会失效；句柄让 GC 知道这里还有一个引用并帮忙更新。类型 T 由模板参数在编译期确定，运行时零额外开销。' },
    { t: 'inline（内联）', d: '编译器把函数体展开到每个调用处以消除调用开销。关键字只是建议，真正决定的是优化决策（函数体小 + -O2/-O3）。后果：断点打不上、局部变量显示 optimized out、调用栈缺帧。' },
    { t: '动态分析沙箱', d: '一套你自己掌控、能记录一切关键事件的 Android 运行环境。虚拟机是你自己编译的，想记录什么就插桩记录什么，不依赖外部 hook 框架。' }
  ],
  teacher: {
    id: 'ch4', chapter: 4,
    name: '追问老师 · 第 4 章',
    sub: 'C++11 不是装饰品，ART 对象模型也不是背诵题——这里只问「为什么」。',
    intro: '<p style="margin:0">这一章的内容很容易被背成名词表。所以我的问题不会问你「ArtMethod 有哪些字段」，' +
           '而会问你「如果那个字段不存在，会发生什么」。答不上来我会给提示，两次之后给追问——三次都答不上，我会把标准答案讲给你听，但你的进度条不会动。</p>',
    questions: [
      /* ---------- 第 1 题 ---------- */
      {
        id: 'c4q1', depth: 1, threshold: 0.7,
        q: '一个 Java 对象在 Native 层就是一块内存。这块内存的<b>最开头</b>放着什么？为什么对象本体里<b>不直接存方法代码</b>，而要多绕一层？',
        concepts: [
          { label: '对象头第一个字段是 klass_，指向 mirror::Class',
            hint: '对象头里有一个指针，它回答「我是什么类」。',
            any: ['klass_', 'klass', '类指针', '指向类', '指向 class', 'mirror::class', '类镜像', 'class 指针', '对象头', '头部'] },
          { label: '同一个类的 Class 只有一份，被所有实例共享',
            hint: '如果每个实例都存一份自己的方法表，内存会怎样？',
            any: ['共享', '共用', '只有一份', '一份', '同一个类', '所有实例', '复用', '单例', 'unique'] },
          { label: '方法属于类，通过类里的方法表 / vtable 查找',
            hint: '方法是「类的属性」还是「对象的属性」？',
            any: ['方法表', 'method table', 'vtable', '虚方法表', '类里', '类中', '元数据', '方法属于类', '方法在类'] },
          { label: '对象头还含 monitor 锁等与类无关的信息',
            hint: '除了「我是什么类」，对象头还要记什么状态？',
            any: ['monitor', '锁', 'lock', 'mark word', '锁信息', '哈希', 'hash', 'gc 标记'] }
        ],
        hints: [
          '先想「对象」和「类」在内存里分别是什么：一个是实例数据，一个是描述。',
          '如果每个对象都自带一份方法表，100 万个对象要浪费多少内存？'
        ],
        probes: [
          '那你说说，从对象引用出发，要经过几次指针解引用才能拿到真正可执行的入口？',
          '如果把 klass_ 改成指向别的类，会发生什么？'
        ],
        model: 'Java 对象在 Native 层就是一块连续内存，<b>最开头是对象头</b>，而对象头的第一个字段是 <span class="mono">klass_</span>——' +
               '一个指向 <span class="mono">mirror::Class</span> 的指针，它回答「我是什么类」。对象头里还有一个 monitor 字段，' +
               '记录锁状态、GC 标记这类与「类」无关的信息。这套布局和 HotSpot 的 mark word + klass pointer 是同一个思路。<br><br>' +
               '<b>为什么方法不放在对象里？</b>因为方法属于<b>类</b>，不属于对象。同一个类可以创建一百万个实例，' +
               '它们的字段值各不相同，但方法代码完全一样。如果把方法表放进每个对象，内存会爆炸。' +
               '所以虚拟机把所有「类级别」的信息——方法表、字段表、vtable、接口表——集中放在一份 <span class="mono">mirror::Class</span> 里，' +
               '所有实例通过 <span class="mono">klass_</span> 共享它。<br><br>' +
               '这也解释了为什么「改一个类的元数据会影响它的所有实例」——这是后面理解 Hook 影响范围的关键。',
        after: '<p>三次指针解引用：<b>对象 → klass_ → 方法表 → ArtMethod → 入口</b>。这条链是本章所有内容的骨架。</p>'
      },

      /* ---------- 第 2 题 ---------- */
      {
        id: 'c4q2', depth: 1, threshold: 0.7,
        q: '你在 ART 里看到 <span class="mono">auto cb = [&amp;]() { Use(local); };</span>，然后这个 cb 被丢进队列延迟执行。' +
           '<b>编译器为这个 lambda 生成了什么？</b>它和 <span class="mono">[=]</span> 生成的有什么本质区别？为什么延迟执行时 <span class="mono">[&amp;]</span> 危险？',
        concepts: [
          { label: 'lambda 编译后生成一个匿名类（闭包类型）',
            hint: 'lambda 不是「函数」，编译后它变成了一个什么东西？',
            any: ['匿名类', '闭包', 'closure', 'functor', '仿函数', '生成类', '类对象', '一个类', '对象'] },
          { label: '捕获的变量成为该匿名类的成员变量',
            hint: 'lambda 要能访问外部变量，这些变量存在哪里？',
            any: ['成员变量', '成员', '字段', 'member', '变成成员', '存进'] },
          { label: '[=] 值捕获：把值拷贝进成员',
            hint: '一个存的是内容，一个存的是位置。',
            any: ['拷贝', '复制', '副本', 'copy', '值捕获', '按值', '值拷贝'] },
          { label: '[&] 引用捕获：成员里存的是地址（本质是指针）',
            hint: '引用在机器层面是什么？',
            any: ['地址', '指针', 'pointer', 'address', '引用捕获', '按引用', '存地址'] },
          { label: '延迟执行导致悬垂引用：局部变量已随栈帧销毁',
            hint: '函数返回后，栈上的局部变量去哪了？',
            any: ['悬垂', '野指针', 'dangling', '失效', '已销毁', '生命周期', '栈帧销毁', '局部变量销毁', '已释放', '死掉'] }
        ],
        hints: [
          '不要把 lambda 当函数看，把它当一个「带成员变量的对象」看。',
          '函数返回时栈帧被回收，局部变量的内存会发生什么？'
        ],
        probes: [
          '那为什么这个 bug 经常表现为「偶发」而不是「必崩」？',
          '值捕获一定安全吗？如果捕获的是一个 Java 对象指针呢？'
        ],
        model: 'lambda 的真相是：<b>编译器为它生成了一个匿名类</b>（闭包类型），lambda 体成为这个类的调用运算符，' +
               '而<b>捕获的变量成为这个类的成员变量</b>。所谓「捕获方式」，就是决定这些成员变量存的是什么。<br><br>' +
               '<span class="mono">[=]</span> 是值捕获：lambda 定义的那一刻，把变量的<b>值拷贝</b>进成员。此后原变量怎么变、' +
               '甚至被销毁，都不影响 lambda 里的那份副本。<span class="mono">[&amp;]</span> 是引用捕获：成员里存的是变量的<b>地址</b>，' +
               '本质就是一个指针——它不拥有任何数据，只是记住「东西在哪」。<br><br>' +
               '危险就在这个组合里：<b>引用捕获 + 延后执行</b>。回调被丢进队列时，它记住的是<b>栈上的地址</b>；' +
               '而函数一旦返回，栈帧被回收，那块内存不再属于你——可能立刻被别的调用覆盖成完全无关的字节。' +
               '这就是<span class="term" data-def="指针指向的对象已销毁，访问行为未定义">悬垂引用</span>。<br><br>' +
               '<b>为什么它特别难查？</b>因为那块内存「有时还没被覆盖」，所以有时侥幸正常、有时读到垃圾、有时直接段错误。' +
               '崩溃时的栈回溯会指向「正在覆盖那块内存的无辜函数」，和真正的病灶隔着一整条时间线。<br><br>' +
               '<b>正确做法：</b>按生命周期选捕获方式。同步立即用完 → 引用捕获高效安全；会活过原变量 → 值捕获，' +
               '或用 <span class="mono">shared_ptr</span> 显式共享所有权。ART 这种长期运行的系统里，任务队列、GC 回调、事件通知全是高危区。'
      },

      /* ---------- 第 3 题 ---------- */
      {
        id: 'c4q3', depth: 2, threshold: 0.7,
        q: '一个加固 App 的 so 里没有任何 <span class="mono">Java_</span> 前缀的导出函数，但 Java 层的 native 方法都能正常工作。' +
           '<b>请解释这是怎么做到的，以及你怎么把丢失的映射关系找回来。</b>再说说：为什么「改 ART 源码」比「用 Frida hook 注册函数」更彻底？',
        concepts: [
          { label: '动态注册：名字不出现在符号表，映射运行时才建立',
            hint: '如果函数不是靠名字被找到的，那它是靠什么？',
            any: ['动态注册', 'registerNatives', 'register natives', '运行时注册', '注册表'] },
          { label: 'JNINativeMethod 三元组：名字 + 签名 + 函数地址',
            hint: '注册时交给虚拟机的那张表，每一行有几个字段？',
            any: ['jninativemethod', '签名', 'signature', '函数地址', 'fnptr', '三元组', '名字和签名'] },
          { label: '在 RegisterNatives 处插桩，记录完整映射',
            hint: '映射是在哪个函数的执行过程中被交给虚拟机的？',
            any: ['插桩', '记录', '注册那一刻', '源码', '改 art', '定制 art', '编译', '虚拟机内部', 'log'] },
          { label: '不依赖 hook 框架，不引入可被检测的运行时特征',
            hint: 'Frida 在进程里会留下什么？改虚拟机又留下什么？',
            any: ['检测', '被发现', 'hook 框架', 'frida', '痕迹', '隐蔽', '反调试', '特征', '无痕', '不引入'] },
          { label: '必须在注册发生的那一刻就位，事后 hook 可能错过时机',
            hint: '如果注册在你 attach 之前就完成了呢？',
            any: ['时机', '错过', '来不及', '先于', '早于', '刚启动', 'jni_onload', '竞态'] }
        ],
        hints: [
          '符号表为空但功能正常——这说明函数不是靠「名字」被找到的。',
          '映射关系是在哪个函数里、什么时刻被交给虚拟机的？'
        ],
        probes: [
          '那为什么记录时必须带上方法签名，只有方法名行不行？',
          '如果目标 App 会校验系统镜像的完整性，你的定制 ROM 怎么办？'
        ],
        model: '这是<b>动态注册</b>。静态注册要求函数名写成 <span class="mono">Java_包名_类名_方法名</span>，虚拟机会按名字去动态库里找；' +
               '而动态注册是在 <span class="mono">JNI_OnLoad</span> 里调用 <span class="mono">env-&gt;RegisterNatives(clazz, methods, nMethods)</span>，' +
               '主动把一张表交给虚拟机。表里每一行是一个 <span class="mono">JNINativeMethod</span>：' +
               '<span class="mono">{name, signature, fnPtr}</span>。<br><br>' +
               '于是<b>函数名可以是任意字符串</b>（根本不进符号表），<b>地址是运行时才产生的</b>（常常是计算或解密出来的）。' +
               '静态分析在这里彻底断线：IDA 里一堆无名函数，你不知道哪个对应哪个 Java 方法。<br><br>' +
               '<b>映射怎么找回来？</b>关键洞察是：不管怎么混淆，注册这一动作<b>必须经过虚拟机的 RegisterNatives</b>。' +
               '所以我们在 ART 源码的这个函数里插一行日志——此刻类名、方法名、签名、目标地址<b>四要素齐全</b>。' +
               '注意<b>签名必须一起记</b>：Java 支持重载，光有名字无法唯一确定一个方法。<br><br>' +
               '<b>为什么比 Frida hook 更彻底？</b>三个层面：<br>' +
               '<b>① 位置</b>——记录代码在虚拟机内部，进程里没有额外的注入模块或 hook 框架痕迹可供检测；<br>' +
               '<b>② 时机</b>——无论 App 什么时候注册、注册多少次，都在你的观测范围内，不存在「attach 晚了」的竞态；<br>' +
               '<b>③ 完备性</b>——你是从<b>生成侧</b>看的，注册这一事实在发生的那一刻就是完全公开的，不需要去推断或猜测。<br><br>' +
               '<b>代价也要说清楚：</b>需要 AOSP 编译环境、源码随版本变化要重新定位插桩点、刷机有风险，' +
               '部分 App 还会校验系统镜像完整性。<b>所以它适合「需要长期稳定且不可被发现的观测能力」的场景，不适合快速验证。</b>',
        after: '<p>一句话记住：<b>Hook 是在别人的流程上加旁路，定制虚拟机是改流程本身。</b></p>'
      },

      /* ---------- 第 4 题 ---------- */
      {
        id: 'c4q4', depth: 2, threshold: 0.7,
        q: '你给一个 native 函数下了断点，程序明明执行了那段逻辑，断点却一次都没命中；而且这个函数里的局部变量也看不到。' +
           '<b>请解释原因，并说明这件事对 Native Hook 意味着什么。</b>',
        concepts: [
          { label: '函数被内联：函数体被展开到调用处',
            hint: '如果编译器把函数体直接抄到了调用点，原函数还需要存在吗？',
            any: ['内联', 'inline', '展开', '抄到调用', '内联展开'] },
          { label: '断点本质是在地址上插指令，函数无独立入口就打不上',
            hint: '断点是怎么实现的？它需要一个什么？',
            any: ['地址', '没有地址', '无入口', '找不到入口', '独立入口', '不存在', '没入口'] },
          { label: '局部变量被放进寄存器或被优化消除（optimized out）',
            hint: '内联后参数和局部变量会去哪？',
            any: ['寄存器', '优化', '消除', 'optimized out', '常量折叠', '看不到'] },
          { label: '没有调用就没有栈帧，调用栈缺帧',
            hint: '栈回溯是靠什么串起来的？',
            any: ['栈帧', '返回地址', '调用栈', '帧', '不完整', '缺少'] },
          { label: '对策：-fno-inline / __attribute__((noinline)) / 降优化等级',
            hint: '想让编译器别内联，有哪些开关？',
            any: ['noinline', 'fno-inline', 'fno inline', '降优化', '关闭优化', 'o0', 'attribute', '禁止内联'] },
          { label: '对 Hook 的启示：被内联的函数在二进制里根本不存在，Hook 会静默失效',
            hint: '你要 Hook 的地址上如果没有函数，会发生什么？',
            any: ['hook', '失效', '无效', '不生效', '没反应', '不存在', '静默', 'hook 不到', '目标不存在'] }
        ],
        hints: [
          '注意两个症状是同时出现的：断点不命中 + 变量看不到。它们有共同的根源。',
          '如果函数体被抄进了调用者，那么「那个函数」在二进制里还需要存在吗？'
        ],
        probes: [
          '那 gdb 里为什么有时还能看到这个函数的名字？',
          '既然 Hook 不到，正确的做法是什么？'
        ],
        model: '根源是<b>内联</b>。编译器为了消除调用开销（压栈、跳转、返回），把函数体<b>直接展开到每一个调用处</b>。' +
               '注意 <span class="mono">inline</span> 关键字只是<b>建议</b>，真正拍板的是优化决策——函数体够小、开了 <span class="mono">-O2</span>/<span class="mono">-O3</span>，' +
               '它就会内联，你写不写关键字都可能被内联。<br><br>' +
               '<b>三个连锁后果：</b><br>' +
               '<b>① 断点打不上</b>——断点的本质是「在某个地址上插一条陷阱指令」。函数被展开后没有自己的地址，断点无处安放；<br>' +
               '<b>② 变量看不到</b>——参数和局部变量被尽量塞进寄存器，或在优化中被消除，调试器只能显示 <span class="mono">&lt;optimized out&gt;</span>；<br>' +
               '<b>③ 调用栈不完整</b>——栈回溯靠压栈的返回地址串联，内联没有调用也就没有返回地址，这一帧在栈上从来不存在。<br><br>' +
               '<b>一个反直觉的细节：</b>符号和调试信息可能还在。DWARF 用 <span class="mono">DW_TAG_inlined_subroutine</span> 记录' +
               '「这段指令原本来自哪个函数」，GDB 的 <span class="mono">info frame</span> 有时仍能看到它的名字——但它不是一个真实的栈帧。<br><br>' +
               '<b>对 Native Hook 的意义（这才是重点）：</b>内联会让 Hook <b>静默失效</b>。你地址算得准、Frida attach 成功、没有任何报错，' +
               '但目标行为毫无变化——因为你 Hook 的地址上根本没有那个函数。遇到这种情况，<b>排查顺序应该是：' +
               '先反汇编确认那里是不是一个真实的函数入口 → 再怀疑框架 → 最后才怀疑自己的代码</b>。' +
               '正确的对策是往上走一层：Hook 它的<b>调用者</b>，或按内联展开后的<b>指令特征</b>去搜索。' +
               '也正因为如此，有些加固会有意利用内联——它免费获得了「让 Hook 找不到落点」的效果。',
        after: '<p><b>编译期的决定，决定调试期的能力。</b>这是本章最值得带走的一句话。</p>'
      },

      /* ---------- 第 5 题（综合，depth 3） ---------- */
      {
        id: 'c4q5', depth: 3, threshold: 0.6,
        q: '<b>综合题。</b>有人说：「定制 ART 和用 Frida hook RegisterNatives，拿到的信息是一样的，只是实现方式不同。」<br>' +
           '请从<b>信息完备性</b>和<b>可检测性</b>两个角度评价这句话，并说明：如果你要建一套长期使用的动态分析沙箱，' +
           '你会怎么设计插桩点，以及必须遵守什么纪律？最后说说这套方案的代价。',
        concepts: [
          { label: '信息在「生成时刻」是完备的，不需要推断',
            hint: '注册这件事，是谁「产生」了那条映射？',
            any: ['完备', '完整', '全部', '天然', '生成侧', '源头', '第一手', '本质', '产生', '不遗漏'] },
          { label: 'Hook 是事后观测，存在时机竞态 / 可能错过',
            hint: '如果 App 在你 attach 之前就注册完了呢？',
            any: ['事后', '错过', '时机', '竞态', '来不及', '先于', 'attach', '晚了', '追赶'] },
          { label: '定制 ART 不引入可在运行时被检测的 hook 框架特征',
            hint: 'Frida 必须在目标进程里留下什么？',
            any: ['检测', '特征', '痕迹', 'frida', 'hook 框架', '隐蔽', '不引入', '无痕', '反调试', '进程特征'] },
          { label: '插桩必须是只读的，不改变虚拟机原有行为',
            hint: '探针如果影响了控制流或返回值，你的沙箱还可信吗？',
            any: ['只读', '不改变', '不改逻辑', '观测', '不影响', '行为不变', '旁观', '无副作用', '原逻辑'] },
          { label: '记录必须在四要素齐全的位置：类 + 方法名 + 签名 + 地址',
            hint: '为什么不能只记名字？',
            any: ['签名', 'signature', '四要素', '重载', '唯一', '类名', '方法名', '地址', '完整信息'] },
          { label: '代价：编译环境 / 版本绑定 / 刷机风险 / 完整性校验',
            hint: '这条路不是免费的，成本在哪？',
            any: ['编译', 'aosp', '版本', '刷机', '成本', '环境', '维护', '风险', '校验', '完整性', '变砖'] }
        ],
        hints: [
          '先问一个更基础的问题：「注册」这个事实，是谁产生的？观测者和产生者，谁的信息更全？',
          '再从对抗角度想：Frida 要在目标进程里存在，定制 ART 不需要——这带来什么差别？'
        ],
        probes: [
          '如果目标 App 会校验系统镜像完整性，你的沙箱还能用吗？有什么出路？',
          '插桩点除了 RegisterNatives，你还会选哪些位置？判断标准是什么？'
        ],
        model: '<b>这句话只对了一半，而错的那一半恰恰是关键的。</b><br><br>' +
               '<b>先说对的部分：</b>两者确实都能拿到「Java 方法 → native 地址」的映射。如果目标 App 注册得比较晚、你在它注册前就 attach 上了，' +
               'Frida hook <span class="mono">RegisterNatives</span> 也能看到完整参数，此时信息确实等价。<br><br>' +
               '<b>错的部分在「完备性」这个词上。</b>Hook 是<b>事后观测</b>：你在外面加一个拦截点，赌自己比目标先就位。' +
               '而注册这件事是虚拟机<b>自己产生</b>的——在生成侧，这条映射在产生的那一刻就是<b>完全公开、无需推断</b>的。' +
               '这个差别在两种情况下会变成决定性的：一是目标在极早期（比如 <span class="mono">JNI_OnLoad</span> 阶段、甚至你还没 attach）就完成注册；' +
               '二是目标主动检测并规避 hook 框架，此时你的拦截点可能压根没装上，而你<b>不知道</b>自己漏了什么——' +
               '观测者最怕的不是看到错的东西，而是以为自己看到了全部。<br><br>' +
               '<b>可检测性上差别更明显。</b>Frida 必须把代码注入目标进程，必然留下可枚举的痕迹：模块、线程、内存特征、' +
               '被改写过的 ArtMethod 标志。定制 ART 则是把记录逻辑<b>编译进了虚拟机本身</b>，进程里没有多出任何东西——' +
               '对目标而言，这就是一台普通的 Android。<br><br>' +
               '<b>插桩点的设计原则：</b>选在<b>四要素齐全</b>的位置（类、方法名、签名、地址同时在手），' +
               '<span class="mono">RegisterNatives</span> 的循环体正是这样的位置；签名绝不能省，否则方法重载会让映射表出现歧义。' +
               '同类候选还有类加载、方法入口等——判断标准是「那一刻我要的全部信息是否都已就位、且不需要推断」。<br><br>' +
               '<b>必须遵守的纪律：</b><b>①</b> <b>只读不改</b>——探针不得改变控制流、返回值或时序，否则你观测的是一个被你改变过的系统；' +
               '<b>②</b> <b>轻量</b>——不要在高频或持锁路径里做重活，宁可先写内存缓冲再统一落盘；' +
               '<b>③</b> <b>可关闭</b>——插桩要能一键关掉，用于对照验证（关掉后行为应当完全一致）。<br><br>' +
               '<b>代价必须讲清楚：</b>要搭 AOSP 编译环境（首次最痛）、源码随版本变化导致插桩点要重新定位、刷机有变砖风险、' +
               '而且部分 App 会校验系统镜像完整性——定制 ROM 本身就是一个可被识别的特征。' +
               '<b>所以结论是：</b>需要快速验证用 Frida，需要长期、稳定、不可被发现的观测能力才上定制 ART。' +
               '把它当成一种「昂贵但信息完备」的手段，而不是默认选择。',
        after: '<p><b>动态分析沙箱的终点不是一个工具，而是一个可编程的观测平台。</b>插一个点是开始，' +
               '把类加载、方法调用、反射调用都纳入进来，你才真正拥有了「想记录什么就记录什么」的能力。</p>'
      }
    ]
  }
};
