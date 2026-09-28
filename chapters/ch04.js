/* 第 4 章 · 安卓应用安全风险与审计
   ---------------------------------------------------------------------------
   本文件由 write + 多次 edit 拼装而成。
   视角声明（与前面各章的边界）：
     · 第 1–25 章讲的是「作为分析方，我怎么突破一个 App 的防护」；
       本章讲的是「App 自己有哪些缺陷、怎么把它审出来」——属于 MASVS / MASTG 那一侧。
     · 所有复现命令一律只针对自造的最小 Demo（com.example.vulnapp）与授权测试环境，
       不针对任何具体线上产品，也不给"攻击某个 App"的操作手册。
   事实纪律：
     · 各 API / 属性的**默认值随 Android 版本变化**的部分，一律加 <span class="pill warn">待核实</span>
       并写清不确定的是什么（哪个版本边界、哪个默认值）；
     · 判定结论由 sec29Manifest() / sec29Traverse() / sec29Intent() 三张真实规则表算出，
       不写死结论字符串；
     · 案例只收可访问、可复现的来源（GitHub 原始 README，已用 Node fetch 逐一验证正文可读）。
       看雪 thread-NNNNN-1.htm 本次尝试的 4 个帖子全部命中「安全验证」墙（textarea 长度 0），
       因此不作案例来源，具体见 4.15。 */

/* ==========================================================================
   判定引擎 1 —— AndroidManifest 片段 → 攻击面清单
   规则来自平台语义，不是查表命中：
     ① exported 显式值优先；
     ② 未声明时：有 <intent-filter> → 导出，没有 → 不导出（这是历史默认值的行为）；
     ③ targetSdk ≥ 31 且声明了 intent-filter 却没写 exported → 构建/安装直接被拦
        （Android 12 的强制显式声明）；
     ④ 组件上的 permission 只有在 protectionLevel 是 signature / system 时才真正拦得住第三方；
        normal / dangerous 级别的权限，第三方在自己的清单里声明一下就能申请。
   ========================================================================== */
function sec29Attr(attrs, name) {
  var m = new RegExp('android:' + name + '\\s*=\\s*"([^"]*)"').exec(String(attrs));
  return m ? m[1].trim() : null;
}
function sec29Short(name) {
  var s = String(name == null ? '' : name);
  var parts = s.split('.');
  return (parts[parts.length - 1] || s).toLowerCase();
}

function sec29Manifest(xml) {
  var src = String(xml == null ? '' : xml).replace(/<!--[\s\S]*?-->/g, '');
  var out = { targetSdk: 0, perms: {}, comps: [], exported: [], exposed: [], guarded: [], buildBlock: [],
              noFilterNoDecl: [], providerOpenWrite: [], fingerprint: '' };

  var sm = /<uses-sdk(?=[\s\/>])([^>]*)>/.exec(src);
  if (sm) {
    var tv = sec29Attr(sm[1], 'targetSdkVersion');
    if (tv) out.targetSdk = parseInt(tv.replace(/[^0-9]/g, ''), 10) || 0;
  }

  var pr = /<permission(?=[\s\/>])([^>]*)>/g, pm;
  while ((pm = pr.exec(src))) {
    var pn = sec29Attr(pm[1], 'name');
    if (pn) out.perms[pn] = sec29Attr(pm[1], 'protectionLevel') || 'normal（未声明，平台默认）';
  }

  var re = /<(activity|activity-alias|service|receiver|provider)(?=[\s\/>])([\s\S]*?)(\/?)>/g, m;
  while ((m = re.exec(src))) {
    var tag = m[1], attrs = m[2], selfClose = (m[3] === '/');
    var body = '';
    if (!selfClose) {
      var closeAt = src.indexOf('</' + tag + '>', re.lastIndex);
      var nextOpen = src.slice(re.lastIndex).search(/<(?:activity|activity-alias|service|receiver|provider|application)(?=[\s\/>])/);
      var end = closeAt >= 0 ? closeAt : (nextOpen >= 0 ? re.lastIndex + nextOpen : src.length);
      body = src.slice(re.lastIndex, end);
    }
    var c = {
      tag: tag,
      name: sec29Attr(attrs, 'name') || '（未命名）',
      exportedRaw: sec29Attr(attrs, 'exported'),
      permission: sec29Attr(attrs, 'permission'),
      readPermission: sec29Attr(attrs, 'readPermission'),
      writePermission: sec29Attr(attrs, 'writePermission'),
      authorities: sec29Attr(attrs, 'authorities'),
      grant: sec29Attr(attrs, 'grantUriPermissions'),
      hasFilter: /<intent-filter/.test(body)
    };

    var explicit = c.exportedRaw === 'true' ? true : (c.exportedRaw === 'false' ? false : null);
    var refExport = (c.exportedRaw !== null && explicit === null);
    var eff = explicit !== null ? explicit : c.hasFilter;

    /* 组件上的权限：provider 还分读/写两个方向 */
    var permName = null, permKind = '';
    if (c.tag === 'provider') {
      if (c.writePermission) { permName = c.writePermission; permKind = '写'; }
      else if (c.readPermission) { permName = c.readPermission; permKind = '读'; }
      else if (c.permission) { permName = c.permission; permKind = '读+写'; }
    } else if (c.permission) { permName = c.permission; }

    var pl = permName ? (out.perms[permName] || '清单里没有对应的 <permission> 声明') : null;
    var plL = pl ? String(pl).toLowerCase() : '';
    var strong = !!permName && /signature|system/.test(plL);
    var weak = !!permName && !strong;
    if (refExport) { strong = false; weak = false; }

    var why = [], lvl = '低';
    if (refExport) {
      lvl = '中';
      why.push('android:exported 写的是资源引用（' + c.exportedRaw + '）而不是 true/false —— 真实值在别的文件里，静态看这一份 Manifest 判不出来。');
    } else if (!eff) {
      if (c.hasFilter && explicit === false) {
        why.push('有 intent-filter，但显式写了 exported="false" —— 这是最不容易出错的写法，其他 App 拉不起来。');
      } else if (explicit === false) {
        why.push('显式关闭；系统按「只有同 UID / 被显式授权者可用」处理。');
      } else {
        why.push('既没有 intent-filter、也没有声明 exported —— 平台默认不导出。');
        why.push('但没有写死：将来有人加一个 intent-filter，它会<b>静默变成导出</b>，而 diff 里只多了一个 filter。');
        out.noFilterNoDecl.push(c);
      }
    } else {
      out.exported.push(c);
      if (strong) {
        lvl = '低';
        why.push('导出，但由 ' + permName + '（' + permKind + '，protectionLevel=' + pl + '）保护 —— 第三方拿不到这个权限，等于门上装了只有自家钥匙的锁。');
        out.guarded.push(c);
      } else if (weak) {
        lvl = '高';
        why.push('导出，也有权限声明，但 protectionLevel=<b>' + pl + '</b> —— ' +
          (/dangerous/.test(plL)
            ? 'dangerous 级别只需要诱导用户点一次「允许」，第三方就能拿到。'
            : (/normal/.test(plL)
              ? 'normal 级别是「声明即得」：第三方在自己的清单里写一行 &lt;uses-permission&gt; 就申请到了，用户根本看不到提示。'
              : '级别不明或自定义，必须人工确认它到底拦不拦得住第三方。')));
      } else if (permName) {
        lvl = '中';
        why.push('导出且有权限名 ' + permName + '，但清单里找不到对应的 &lt;permission&gt; 声明 —— 无法判断 protectionLevel，按「可能拦不住」处理，需要人工核实。');
      } else {
        lvl = '高';
        why.push(c.tag === 'provider'
          ? '裸导出：任何 App 都能用 content:// URI 通过 ContentResolver 访问它。'
          : '裸导出：任何 App 都能用一个显式 Intent 直接拉起/触发它，不需要任何权限。');
      }
      if (!strong) out.exposed.push(c);
      if (c.tag === 'provider' && !c.writePermission && !strong) {
        out.providerOpenWrite.push(c);
        why.push('Provider 连 writePermission 都没有 —— 写入方向同样对外开放（不只是读）。');
      }
      if (c.grant === 'true') {
        why.push('grantUriPermissions="true"：还会额外允许通过带 FLAG_GRANT_*_URI_PERMISSION 的 Intent 把该 Provider 的 URI 临时授权给第三方。');
      }
    }

    if (c.hasFilter && explicit === null && !refExport && out.targetSdk >= 31) {
      out.buildBlock.push(c);
      why.push('★ targetSdk=' + out.targetSdk + ' 且声明了 intent-filter，却没有显式写 android:exported —— 这份清单在构建期就会被 manifest 合并拦下（Android 12 起的强制要求）。');
    }

    c.eff = eff;
    c.level = lvl;
    c.why = why;
    c.permName = permName;
    c.pl = pl;
    c.strong = strong;
    out.comps.push(c);
  }

  /* 攻击面指纹：把「哪些组件、以什么形态暴露」压成一个短摘要。
     用途是版本对比 —— 升级前后指纹变了，说明攻击面变了，值得复查一遍。 */
  try {
    var sig = out.comps.map(function (c) {
      return c.tag + ':' + sec29Short(c.name) + '=' + (c.eff ? 'E' : 'N') + (c.strong ? 'S' : (c.permName ? 'W' : '-'));
    }).sort().join('\n');
    out.fingerprint = window.CRYPTO.toHex(window.CRYPTO.md5(window.CRYPTO.toBytes(sig))).slice(0, 16);
  } catch (e) { out.fingerprint = '（无法计算）'; }
  return out;
}

/* 渲染引擎 1 的结果 */
function sec29ManifestHtml(r) {
  var order = { '高': 0, '中': 1, '低': 2 };
  var list = r.comps.slice().sort(function (a, b) {
    if (order[a.level] !== order[b.level]) return order[a.level] - order[b.level];
    return a.name < b.name ? -1 : 1;
  });
  var h = '<div class="lab-kv">' +
    '<span>targetSdkVersion <b>' + (r.targetSdk || '未读到') + '</b></span>' +
    '<span>解析到组件 <b>' + r.comps.length + '</b> 个</span>' +
    '<span>导出的组件 <b>' + r.exported.length + '</b> 个</span>' +
    '<span>可被任意 App 调用 <b>' + r.exposed.length + '</b> 个</span>' +
    '<span>真正受保护 <b>' + r.guarded.length + '</b> 个</span>' +
    '<span>构建就会被拦 <b>' + r.buildBlock.length + '</b> 个</span></div>';

  if (!r.comps.length) {
    return h + '<div class="lab-msg warn"><b>没有解析到任何组件</b><div class="lab-note">' +
      '请贴入一段 &lt;application&gt; 里含 &lt;activity&gt; / &lt;service&gt; / &lt;receiver&gt; / &lt;provider&gt; 的清单片段。' +
      '注释里的示例会被自动忽略。</div></div>';
  }

  h += '<table class="lab-tbl"><tr><th>组件</th><th>类型</th><th>exported 从哪来</th>' +
       '<th>权限保护</th><th>任意 App 可调用</th><th>等级</th><th>依据</th></tr>';
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    var src;
    if (c.exportedRaw === 'true') src = '显式 true';
    else if (c.exportedRaw === 'false') src = '显式 false';
    else if (c.exportedRaw) src = '资源引用 ' + c.exportedRaw;
    else src = c.hasFilter ? '未声明 + 有 filter → 默认导出' : '未声明 + 无 filter → 默认不导出';
    var cls = c.level === '高' ? ' class="diff"' : '';
    h += '<tr' + cls + '><td style="font-family:var(--mono);font-size:11.5px">' + c.name + '</td>' +
      '<td>' + c.tag + '</td>' +
      '<td style="font-family:var(--sans);font-size:12px">' + src + '</td>' +
      '<td style="font-family:var(--sans);font-size:12px">' + (c.permName ? c.permName + '<br><span class="muted">' + c.permKind + ' / ' + c.pl + '</span>' : '<span class="muted">无</span>') + '</td>' +
      '<td style="text-align:center">' + ((c.eff && !c.strong) ? '<span class="hit">是</span>' : (c.strong ? '受保护' : '否')) + '</td>' +
      '<td style="text-align:center">' + c.level + '</td>' +
      '<td style="font-family:var(--sans);font-size:12px;line-height:1.7">' + c.why.join('<br>') + '</td></tr>';
  }
  h += '</table>';

  h += '<div class="lab-msg key"><b>📐 这张表是按什么算出来的</b><div class="lab-note">' +
    '① <b>导出</b>：显式值优先；没写时「有 intent-filter → 导出，没有 → 不导出」。' +
    '这条默认值本身就是历史包袱，也是 CWE-926 的成因。<br>' +
    '② <b>保护</b>：只有 <code>signature</code> / <code>system</code> 级别的权限才算真的把第三方挡在门外；' +
    '<code>normal</code> 是声明即得，<code>dangerous</code> 是一次点击。<b>「有权限」不等于「安全」。</b><br>' +
    '③ <b>可被任意 App 调用</b> = 导出 且 没有做到 signature 级保护。<br>' +
    '④ <b>构建拦截</b>：targetSdk ≥ 31 时，有 filter 就必须显式声明 exported，否则清单合并阶段直接失败。</div></div>';

  if (r.buildBlock.length) {
    h += '<div class="lab-msg fail"><b>⛔ ' + r.buildBlock.length + ' 个组件会让这份清单打包失败</b><div class="lab-note">' +
      r.buildBlock.map(function (c) { return '· ' + c.name; }).join('<br>') +
      '<br><br>报错形状（<b>文案随 AGP / 平台版本变化</b>，<span class="pill warn">待核实</span>）：<br>' +
      '<span class="mono">android:exported needs to be explicitly specified for element &lt;activity#…&gt;. ' +
      'Apps targeting Android 12 and higher are required to specify an explicit value for android:exported ' +
      'when the corresponding component has an intent-filter defined.</span><br><br>' +
      '所以现实里你几乎不会见到"没写 exported 却带着 filter 的线上包"——但<b>它大量存在于老代码的历史提交里</b>，' +
      '而且这正是"升级 targetSdk 时突然编不过"的经典原因。</div></div>';
  }

  if (r.providerOpenWrite.length) {
    h += '<div class="lab-msg warn"><b>⚠️ Provider 的写方向也是开的</b><div class="lab-note">' +
      r.providerOpenWrite.map(function (c) { return '· ' + c.name + (c.authorities ? '（authorities=' + c.authorities + '）' : ''); }).join('<br>') +
      '<br>只设 readPermission 而忘了 writePermission，是 Provider 上最常见的半个防护。</div></div>';
  }

  h += '<div class="lab-msg model"><b>🔖 攻击面指纹：<span class="mono">' + r.fingerprint + '</span></b>' +
    '<div class="lab-note">把「组件 + 是否导出 + 保护强度」排序后做 MD5 取前 16 位。它的用处只有一个：' +
    '<b>拿两个版本的 APK 各算一次，指纹一样说明攻击面没变</b>，不一样就说明有人动了组件声明，' +
    '值得把上面的表 diff 一遍。审计报告里写这个比写「已检查 Manifest」有用得多。</div></div>';
  return h;
}

/* ==========================================================================
   判定引擎 2 —— ContentProvider openFile 的路径穿越判定
   按真实规则算，不查表：
     ① Uri 解析：authority + path（Android 的 Uri.getPath() 返回**已解码**的路径）；
     ② 拼接：File(parent, child) 只是把字符串接起来，child 里的 ".." **不会被消除**，
        前导 "/" 也不会把它变成绝对路径；
     ③ 归一化：内核在 open() 时才按 ".." 逐级回退，所以真正决定读到哪个文件的是
        「归一化之后」的路径；
     ④ 白名单：必须在归一化之后比较，而且必须带上路径分隔符的边界；
     ⑤ 符号链接：getCanonicalPath() 会解析它，纯字符串/纯词法归一化（Path.normalize）不会。
   ========================================================================== */
var SEC29_ROOT = '/data/user/0/com.example.vulnapp/files/shared';
var SEC29_SYMLINKS = { '/data/user/0/com.example.vulnapp/files/shared/link': '/data/user/0/com.example.vulnapp/databases' };

function sec29Normalize(p) {
  var abs = String(p).charAt(0) === '/';
  var segs = String(p).split('/');
  var out = [];
  for (var i = 0; i < segs.length; i++) {
    var s = segs[i];
    if (s === '' || s === '.') continue;
    if (s === '..') { if (out.length) out.pop(); continue; }
    out.push(s);
  }
  return (abs ? '/' : '') + out.join('/');
}

function sec29Decode(rawPath) {
  var once = rawPath, twice = rawPath, flag = '';
  try { once = decodeURIComponent(rawPath); } catch (e) { flag = '（解码失败，按原样处理）'; }
  try { twice = decodeURIComponent(once); } catch (e) { /* 忽略 */ }
  if (twice !== once && /%2e|%2f|%2F/i.test(once)) flag = '★ 解一次还剩 %2e/%2f —— 如果代码里解码了两次，第二次会把它们变成真正的 ".." 和 "/"';
  return { once: once, twice: twice, flag: flag };
}

function sec29Traverse(uri, rootOverride) {
  var ROOT = rootOverride || SEC29_ROOT;
  var raw = String(uri == null ? '' : uri).trim();
  var r = { uri: raw, ok: false, authority: '', rawPath: '', decoded: '', joined: '', lexical: '',
            canonical: '', naivePass: false, strictPass: false, escaped: false, note: [], sha1: '', symlink: '' };
  if (!raw) { r.note.push('空输入'); return r; }

  var body = raw.replace(/^content:\/\//i, '');
  var slash = body.indexOf('/');
  r.authority = slash < 0 ? body : body.slice(0, slash);
  r.rawPath = slash < 0 ? '/' : body.slice(slash);
  r.ok = /^content:\/\//i.test(raw);

  var d = sec29Decode(r.rawPath);
  r.decoded = d.once;
  if (d.flag) r.note.push(d.flag);
  if (d.twice !== d.once) r.note.push('二次解码结果：' + d.twice);

  /* File(parent, child)：就是字符串拼接。child 开头的 "/" 不会重置根。 */
  r.joined = ROOT + '/'.slice(0, 0) + (String(r.decoded).charAt(0) === '/' ? '' : '/') + r.decoded;
  r.lexical = sec29Normalize(r.joined);

  /* 符号链接解析（真实世界里由 getCanonicalPath 完成） */
  r.canonical = r.lexical;
  for (var k in SEC29_SYMLINKS) {
    if (Object.prototype.hasOwnProperty.call(SEC29_SYMLINKS, k)) {
      if (r.canonical === k || r.canonical.indexOf(k + '/') === 0) {
        r.symlink = k + ' → ' + SEC29_SYMLINKS[k];
        r.canonical = SEC29_SYMLINKS[k] + r.canonical.slice(k.length);
        r.note.push('路径经过符号链接 ' + r.symlink);
      }
    }
  }

  /* 三种白名单写法 —— 这是本引擎最想让人看清楚的对照。
     ① naivePass：不归一化、也不加分隔符边界（最常见的那种"安全检查"）
     ② normNoBoundary：归一化了，但没有分隔符边界（漏掉 shared-notes 这类兄弟目录）
     ③ strictPass：归一化 + 边界（正确写法） */
  r.naivePass = r.joined.indexOf(ROOT) === 0;
  r.normNoBoundary = r.canonical.indexOf(ROOT) === 0;
  r.strictPass = (r.canonical === ROOT) || (r.canonical.indexOf(ROOT + '/') === 0);
  r.escaped = !r.strictPass;

  if (r.escaped && r.naivePass && r.normNoBoundary) {
    r.note.push('★ 两种"安全检查"都放行了：不归一化的前缀检查看不见 <span class="mono">..</span>；' +
      '归一化后不加分隔符边界的检查被<b>同名前缀的兄弟目录</b>骗过去了。');
  } else if (r.escaped && r.naivePass) {
    r.note.push('★ 典型假阴性：不归一化的前缀检查放行了（<span class="mono">..</span> 在字符串里还是普通字符），' +
      '归一化之后才发现跑到了目录外。');
  } else if (r.escaped && r.normNoBoundary) {
    r.note.push('★ 归一化过了，但仍然逃逸：说明问题出在<b>没有分隔符边界</b>（或符号链接），不是出在 <span class="mono">..</span> 上。');
  } else if (!r.escaped) {
    r.note.push('正常请求：归一化之后确实落在根目录内（这与它是"看着像绝对路径"还是"看着像相对路径"无关）。');
  }
  if (r.symlink) r.note.push('★ 这一条只有 getCanonicalPath 才拦得住：纯词法归一化（Path.normalize）不会解析符号链接。');

  try {
    r.sha1 = window.CRYPTO.toHex(window.CRYPTO.sha1(window.CRYPTO.toBytes(r.canonical))).slice(0, 16);
  } catch (e) { r.sha1 = '（无法计算）'; }
  return r;
}

/* 渲染引擎 2 的结果 */
function sec29TraverseHtml(v) {
  var lines = String(v.uris == null ? '' : v.uris).split(/\r?\n/).map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
  if (!lines.length) {
    return '<div class="lab-msg warn"><b>先贴几个候选 Uri</b><div class="lab-note">' +
      '一行一个。判定器会按真实的路径规则算出每一个请求最终打到哪个文件。</div></div>';
  }
  var rows = lines.map(function (u) { return sec29Traverse(u, String(v.root || '').trim() || SEC29_ROOT); });
  var escaped = rows.filter(function (x) { return x.escaped; });
  var h = '<div class="lab-kv"><span>候选 Uri <b>' + rows.length + '</b> 条</span>' +
    '<span>越权读到根目录之外 <b>' + escaped.length + '</b> 条</span>' +
    '<span>根目录 <b class="mono">' + (String(v.root || '').trim() || SEC29_ROOT) + '</b></span></div>';

  h += '<table class="lab-tbl"><tr><th>请求</th><th>authority</th><th>解码后的 path</th>' +
       '<th>归一化后的真实路径</th><th>canonical 指纹</th>' +
       '<th>不归一化检查</th><th>归一化无边界</th><th>正确检查</th><th>说明</th></tr>';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    h += '<tr' + (r.escaped ? ' class="diff"' : '') + '>' +
      '<td style="font-family:var(--mono);font-size:11px">' + r.uri + '</td>' +
      '<td style="font-family:var(--mono);font-size:11px">' + r.authority + '</td>' +
      '<td style="font-family:var(--mono);font-size:11px">' + r.decoded + '</td>' +
      '<td style="font-family:var(--mono);font-size:11px">' + r.canonical + '</td>' +
      '<td class="mono" style="font-size:11px">' + r.sha1 + '</td>' +
      '<td style="text-align:center">' + (r.naivePass ? '<span class="miss">放行</span>' : '<span class="hit">拒绝</span>') + '</td>' +
      '<td style="text-align:center">' + (r.normNoBoundary ? '<span class="miss">放行</span>' : '<span class="hit">拒绝</span>') + '</td>' +
      '<td style="text-align:center">' + (r.strictPass ? '<span class="hit">放行</span>' : '<span class="miss">拒绝</span>') + '</td>' +
      '<td style="font-family:var(--sans);font-size:12px;line-height:1.7">' + (r.note.join('<br>') || '—') + '</td></tr>';
  }
  h += '</table>';

  h += '<div class="lab-msg key"><b>📐 这个判定器体现的三条真实规则</b><div class="lab-note">' +
    '① <b>拼接不消除 <span class="mono">..</span></b>：<code>new File(parent, child)</code> 只是接字符串，' +
    '前导 <span class="mono">/</span> 也不会把 child 变成绝对路径 —— 于是 <span class="mono">..</span> 被原样带进 open()，' +
    '由内核在打开文件时逐级回退。<b>漏洞就发生在「检查过之后、打开之前」这段窗口里。</b><br>' +
    '② <b>白名单必须在归一化之后比，而且要带分隔符边界</b>：' +
    '<span class="mono">startsWith(root)</span> 这种写法同时漏掉两件事 —— ' +
    '<span class="mono">shared/../databases</span> 和 <span class="mono">shared-notes</span> 都能过。<br>' +
    '③ <b>canonical 指纹那一列是重点</b>：同一个文件的不同写法（<span class="mono">../</span>、' +
    '<span class="mono">%2e%2e/</span>、<span class="mono">subdir/../../</span>）会算出<b>同一个指纹</b>。' +
    '这说明「按字符串比 Uri」永远不可能严密 —— <b>唯一可靠的比较对象是归一化后的真实路径。</b></div></div>';

  if (escaped.length) {
    h += '<div class="lab-msg fail"><b>🚨 ' + escaped.length + ' 条请求打到了根目录之外</b><div class="lab-note">' +
      escaped.map(function (x) { return '· <span class="mono">' + x.uri + '</span> → <span class="mono">' + x.canonical + '</span>'; }).join('<br>') +
      '<br><br>注意最后一条的形态：<b>越权的目标不是随机文件，而是这个 App 自己的 private 数据区</b>' +
      '（<span class="mono">databases/</span>、<span class="mono">shared_prefs/</span>）。' +
      '这就是为什么"目录遍历"在移动端往往直接等于"敏感数据泄露"。</div></div>';
  }
  return h;
}

/* ==========================================================================
   判定引擎 3 —— 畸形 Intent 参数字典 → 哪一个真的会崩
   这张表的每一行都是一个「类型不匹配」的真实组合。
   重点是那几条**看着危险其实不崩**的（Bundle 的原始类型 getter 会 catch 掉 CCE 并返回默认值）。
   版本相关的行为一律在输出里标待核实。
   ========================================================================== */
function sec29IntentRows() {
  return [
    { id: 1, value: 'String "abc"', api: 'getIntExtra("uid", 0)', crash: false, trap: true,
      why: 'Bundle 的原始类型 getter 内部会捕获 ClassCastException，打一条 typeWarning 后<b>返回默认值</b>。' +
           '所以这一行不会崩 —— 但它会<b>静默拿到错的值</b>，比崩溃更难查。这是本表里唯一的"看着危险其实不崩"。' },
    { id: 2, value: 'String "abc"', api: 'Integer.parseInt(getStringExtra("uid"))', crash: true,
      why: '类型对得上（确实是 String），内容对不上：<b>NumberFormatException</b>。这是最容易被外部触发的崩溃之一，' +
           '因为校验「类型」的人很多，校验「格式」的人很少。' },
    { id: 3, value: '（没有这个 key）', api: 'getStringExtra("token").length()', crash: true,
      why: '没有这个 extra 时返回 <b>null</b>，直接调方法就是 <b>NullPointerException</b>。' +
           '空值是最廉价、最容易被构造的畸形输入 —— 攻击者只要不发那个 extra。' },
    { id: 4, value: 'String', api: '(UserParcel) getParcelableExtra("user")', crash: true,
      why: '类型不匹配的强制转换 → <b>ClassCastException</b>。' +
           '注意：Parcelable 的跨进程传递本身还有「类必须存在于目标进程」的前置条件（Android 13 起官方建议用带 Class 参数的重载，版本细节待核实）。' },
    { id: 5, value: 'int 42', api: 'getIntExtra("uid", 0)', crash: false,
      why: '完全匹配的正常路径。它出现在这张表里是作为<b>对照组</b>：' +
           '如果一份清单里所有行都是这一种，说明这个组件对参数做了约定并遵守了它。' },
    { id: 6, value: 'byte[]（大小可调）', api: 'getByteArrayExtra("blob")', crash: true,
      why: '<b>不是类型问题，是体积问题</b>：Intent 的 extras 要跨 Binder 传递，事务缓冲区有上限，' +
           '超限会抛 <b>TransactionTooLargeException</b>。它通常崩在"传递"环节，' +
           '所以发送方、接收方、甚至系统服务都可能报这个错 —— 排查时最容易找错人。' },
    { id: 7, value: 'ArrayList&lt;Integer&gt;', api: 'getStringArrayListExtra("tags")', crash: true,
      why: '泛型在运行时被擦除，但集合的<b>元素类型</b>没有：取出来当 ArrayList&lt;String&gt; 用，' +
           '第一次 get() 并强转就 <b>ClassCastException</b>。' +
           '这类「看着是集合、其实是异构集合」的输入，静态扫描基本发现不了。' }
  ];
}

function sec29IntentEval(v) {
  var rows = sec29IntentRows();
  var bytes = parseInt(String(v.blobBytes == null ? '' : v.blobBytes).replace(/[^0-9]/g, ''), 10);
  if (isNaN(bytes)) bytes = 8000000;
  var limit = 1024 * 1024;                     /* 教学用上限：1 MiB（真实阈值随版本/设备变化） */
  var overLimit = bytes > limit;
  var count = 0;
  var res = rows.map(function (r) {
    var crash = r.crash;
    var extra = '';
    if (r.id === 6) {
      crash = overLimit;
      extra = '当前载荷 <b>' + bytes.toLocaleString() + '</b> 字节，' +
        (overLimit ? '超过' : '未超过') + '教学上限 ' + limit.toLocaleString() + ' 字节 → ' +
        (overLimit ? '<b>会</b>' : '<b>不会</b>') + '触发 TransactionTooLargeException';
    }
    if (crash) count++;
    return { id: r.id, value: r.value, api: r.api, crash: crash, trap: !!r.trap, why: r.why, extra: extra };
  });
  var safe = res.filter(function (x) { return !x.crash; });
  var traps = res.filter(function (x) { return x.trap && !x.crash; }).map(function (x) { return x.id; });
  var crc = '—';
  try {
    var n = Math.min(bytes, 4096);
    var buf = new Uint8Array(n);
    for (var i = 0; i < n; i++) buf[i] = (i * 31 + (bytes & 0xff)) & 0xff;
    crc = '0x' + window.CRYPTO.crc32(buf).toString(16).padStart(8, '0') + '（前 ' + n + ' 字节）';
  } catch (e) { crc = '（无法计算）'; }
  return { rows: res, count: count, total: res.length, safe: safe, traps: traps,
           bytes: bytes, limit: limit, overLimit: overLimit, crc: crc };
}

/* 渲染引擎 3 的结果 */
function sec29IntentHtml(r) {
  var h = '<div class="lab-kv"><span>候选组合 <b>' + r.total + '</b> 行</span>' +
    '<span>会崩 <b>' + r.count + '</b> 行</span>' +
    '<span>不崩 <b>' + r.safe.length + '</b> 行（其中"看着危险其实不崩" <b>' + r.traps.length + '</b> 行）</span>' +
    '<span>byte[] 载荷 <b>' + r.bytes.toLocaleString() + '</b> 字节</span>' +
    '<span>载荷前 4KB 的 CRC32 <b class="mono">' + r.crc + '</b></span></div>';

  h += '<table class="lab-tbl"><tr><th>#</th><th>调用方塞进去的值</th><th>组件里的写法</th><th>结果</th><th>为什么</th></tr>';
  for (var i = 0; i < r.rows.length; i++) {
    var x = r.rows[i];
    h += '<tr' + (x.crash ? ' class="diff"' : '') + '><td>' + x.id + '</td>' +
      '<td style="font-family:var(--mono);font-size:11px">' + x.value + '</td>' +
      '<td style="font-family:var(--mono);font-size:11px">' + x.api + '</td>' +
      '<td style="text-align:center">' + (x.crash ? '<span class="miss">异常</span>' : '<span class="hit">不崩</span>') + '</td>' +
      '<td style="font-family:var(--sans);font-size:12px;line-height:1.7">' + x.why +
      (x.extra ? '<br><b>' + x.extra + '</b>' : '') + '</td></tr>';
  }
  h += '</table>';

  h += '<div class="lab-msg key"><b>📐 这张表的两条判据</b><div class="lab-note">' +
    '① <b>「不崩」不等于「没问题」</b>：第 1 行拿到的是默认值 0，业务逻辑照样往下走 —— ' +
    '一个 uid=0 的请求可能比一次崩溃更糟（崩溃至少会被崩溃平台统计到）。<br>' +
    '② <b>要崩得先落地</b>：真正会崩的地方，是"取出来的值被当成另一种东西用"的那一步，' +
    '不是"取"的那一步。所以审计组件时不要只盯着 <code>getXxxExtra</code>，' +
    '要顺着这个值往下看到<b>第一个转换点</b>（parseInt / 强转 / 当索引 / 当路径 / 当 SQL 参数）。<br>' +
    '③ 第 6 行的阈值是<b>教学值</b>：真实上限随 Android 版本、设备内存与 Binder 实现变化，' +
    '<span class="pill warn">待核实</span>。</div></div>';
  return h;
}

/* ==========================================================================
   实验素材 —— 教学构造的 AndroidManifest 片段
   注意：这段 XML 是**故意混合**的，四种东西各占几个：
     · 真的危险（裸导出）
     · 看着危险其实安全（有 filter 但显式 false）
     · 看着安全其实危险（有权限但 protectionLevel=normal）
     · 会让打包失败的遗留写法（有 filter 却没写 exported）
   写法本身是真实语法；组件名与包名都是自造的。
   ========================================================================== */
var SEC29_MANIFEST_SAMPLE = [
  '<manifest xmlns:android="http://schemas.android.com/apk/res/android"',
  '          package="com.example.vulnapp">',
  '',
  '  <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="33" />',
  '',
  '  <!-- 自定义权限：一个"声明即得"，一个"必须同签名" -->',
  '  <permission android:name="com.example.vulnapp.permission.ADMIN"',
  '              android:protectionLevel="normal" />',
  '  <permission android:name="com.example.vulnapp.permission.INTERNAL"',
  '              android:protectionLevel="signature" />',
  '',
  '  <application android:allowBackup="true" android:debuggable="false">',
  '',
  '    <!-- ① 有 LAUNCHER filter，但没写 exported -->',
  '    <activity android:name=".ui.SplashActivity">',
  '      <intent-filter>',
  '        <action android:name="android.intent.action.MAIN" />',
  '        <category android:name="android.intent.category.LAUNCHER" />',
  '      </intent-filter>',
  '    </activity>',
  '',
  '    <!-- ② 有 filter，但显式关闭 -->',
  '    <activity android:name=".ui.PayConfirmActivity" android:exported="false">',
  '      <intent-filter>',
  '        <action android:name="com.example.vulnapp.action.PAY_CONFIRM" />',
  '      </intent-filter>',
  '    </activity>',
  '',
  '    <!-- ③ 导出 + 权限（normal） -->',
  '    <activity android:name=".admin.AdminPanelActivity"',
  '              android:exported="true"',
  '              android:permission="com.example.vulnapp.permission.ADMIN" />',
  '',
  '    <!-- ④ 导出 + 权限（signature） -->',
  '    <service android:name=".sync.SyncService"',
  '             android:exported="true"',
  '             android:permission="com.example.vulnapp.permission.INTERNAL" />',
  '',
  '    <!-- ⑤ 裸导出 -->',
  '    <service android:name=".net.DownloadService" android:exported="true" />',
  '',
  '    <!-- ⑥ 无 filter、无 exported -->',
  '    <receiver android:name=".push.InternalReceiver" />',
  '',
  '    <!-- ⑦ 有 filter、没写 exported -->',
  '    <receiver android:name=".push.PushReceiver">',
  '      <intent-filter>',
  '        <action android:name="com.example.vulnapp.PUSH_TOKEN" />',
  '      </intent-filter>',
  '    </receiver>',
  '',
  '    <!-- ⑧ 导出 + 权限（normal） -->',
  '    <receiver android:name=".push.DebugReceiver"',
  '              android:exported="true"',
  '              android:permission="com.example.vulnapp.permission.ADMIN" />',
  '',
  '    <!-- ⑨ 导出的 Provider，没读也没写权限 -->',
  '    <provider android:name=".data.SecureFileProvider"',
  '              android:authorities="com.example.vulnapp.files"',
  '              android:exported="true"',
  '              android:grantUriPermissions="true" />',
  '',
  '    <!-- ⑩ 导出，但用的是资源引用而不是字面量 -->',
  '    <activity android:name=".debug.TraceActivity" android:exported="@bool/exported_debug" />',
  '',
  '  </application>',
  '</manifest>'
].join('\n');

/* ==========================================================================
   第 4 章数据
   ========================================================================== */
window.CHAPTER = {
  no: 4,
  title: '安卓应用安全风险与审计',
  lede: '前面每一章都在回答「我怎么突破它」；这一章换一个座位：<strong>假设这个 App 是我写的，它会从哪里被撬开</strong>。' +
        '七类高频风险——重打包、明文存数据、Activity 越权、WebView 跨域、Provider 目录遍历、组件拒绝服务、广播伪造——' +
        '它们的根其实是同一件事：<strong>组件的「导出」就是攻击面</strong>。',
  meta: [
    '核心问题：<b>一个 App 自己有哪些缺陷，怎么在半小时内审出来？</b>',
    '关键机制：<b>android:exported 语义 / 权限级别 / 路径归一化 / Intent 参数校验</b>',
    '对手：<b>你自己代码里的默认值</b>（不是某个加固厂商）'
  ],

  sections: [
    /* ============================================================ 4.1 */
    {
      h: '4.1', title: '总纲：组件的「导出」就是攻击面',
      intuition: {
        tag: '直觉模型 · 一栋楼的门禁等级',
        body:
          '<p>把 App 想象成一栋楼，四大组件是楼里的房间。问题只有一个：<strong>哪些房间是"任何人都能推开"的？</strong></p>' +
          '<ul>' +
          '<li><span class="mono">android:exported="true"</span> —— 房间没锁。走廊上任何一个人（其他 App）都能进来。</li>' +
          '<li><span class="mono">android:exported="false"</span> —— 只有本部门员工（同一个 App / 同一个 UID）能进。</li>' +
          '<li><span class="mono">android:permission="…"</span> —— 门上装了刷卡器。<strong>但刷卡器的等级（protectionLevel）才决定它管不管用</strong>：' +
          '<span class="mono">normal</span> 是"自己印一张卡就能刷"，<span class="mono">signature</span> 才是"只有配发的钥匙能开"。</li>' +
          '</ul>' +
          '<p>本章讲的七类风险，每一类的入口都落在这栋楼的某个房间上。所以先把这个开关的语义彻底搞清，后面七节都是在它的基础上分岔。</p>'
      },
      html:
        '<p>"导出"（exported）这个词在 Android 里只有一个意思：<b>这个组件能不能被"别的 App"（更准确地说，是不同 UID 的进程）调用</b>。' +
        '它和"组件是 public 还是 private"完全无关，也不受 Java 访问修饰符影响——<span class="hit">这是新手最容易错的地方：' +
        '把 Activity 写成包内可见（package-private），一样会被导出的语义放行，因为调用方根本不经过 Java 的可见性检查</span>。</p>' +

        T.card('谁来决定一个组件是不是导出的',
          T.tbl(['组件声明了什么', '结果', '谁在做这个判断'],
            [
              ['<span class="mono">android:exported="true"</span>', '导出（可被其他 App 调用）', '清单里写死的'],
              ['<span class="mono">android:exported="false"</span>', '不导出，<b>即使它有 intent-filter</b>', '清单里写死的'],
              ['没写 exported，但<b>有</b> <span class="mono">&lt;intent-filter&gt;</span>', '<b>导出</b>（这是平台的历史默认值）',
               '系统的隐式规则 —— 也就是 CWE-926 的成因'],
              ['没写 exported，也<b>没有</b> intent-filter', '不导出', '系统的隐式规则'],
              ['<span class="mono">android:exported="@bool/x"</span>', '值在别处，静态看这一份清单判不出来',
               '<b>审计时要当成"未知"而不是"安全"</b>']
            ])) +

        T.note('key', '🔑 这条默认值值得单独记住',
          '<p style="margin-bottom:0">"有 intent-filter 就默认导出"是 Android 从第一版就带着的设计：' +
          '它为了让「隐式 Intent」能用起来（你能用 <span class="mono">ACTION_SEND</span> 唤起别人写的分享界面）。' +
          '代价是：<b>你为了让组件能被系统或别的 App 唤起，顺手加了一个 intent-filter，就等于顺手把它开放了</b>——' +
          '很多人根本没意识到自己做过这个动作。<br>' +
          '这类"不当导出组件"在 CWE 里有专门条目：' +
          '<a href="https://cwe.mitre.org/data/definitions/926.html" target="_blank" rel="noopener">CWE-926: Improper Export of Android Application Components</a>。' +
          '值得一提的是它里面点出的一个历史事实——见下面那条提醒。</p>') +
        T.note('warn', '⚠️ ContentProvider 的默认值历史上和别的组件不一样',
          '<p style="margin-bottom:0">CWE-926 明确提到：<b>在 Android 4.2（API 17）之前，ContentProvider 会被自动导出</b>，' +
          '除非显式声明为不导出——也就是说它当年<b>不看有没有 intent-filter</b>。' +
          '之后的默认行为才与其它组件统一。<br>' +
          '<span class="pill warn">待核实</span> <b>不确定点</b>：确切的版本边界、以及各厂商定制是否改过这一默认值。<br>' +
          '这对审计有直接后果：<b>如果一个老包的目标版本很低，你的 Provider 可能"什么都没写"却是导出的</b>。' +
          '所以本章的判定器对"未声明"的组件一律把依据写出来（而不是只给结论）——' +
          '看到"默认不导出"这种结论时，你要能追问一句"这是哪个默认值"。</p>') +

        '<h3>Android 12 把"默认"这件事终结了</h3>' +
        '<p>从 <b>targetSdkVersion = 31（Android 12）</b> 开始，规则变成：只要组件声明了 intent-filter，' +
        '<b>就必须显式写出 <span class="mono">android:exported</span></b>。不写会怎样？' +
        '不是"运行时报警"，而是<b>在构建阶段就被拦下</b>：manifest merger 直接报错，产不出包；' +
        '即便你用别的方式绕过构建，targetSdk ≥ 31 的设备在安装时也会拒绝。' +
        '<span class="pill warn">待核实</span> 具体报错文案随 AGP / 平台版本变化，但"编不过"这个结果不变。</p>' +
        T.note('ok', '✅ 这件事对审计的意义',
          '<p style="margin-bottom:0">你在线上包里几乎看不到"有 filter 却没写 exported"的组件——' +
          '<b>但你在老项目的历史提交里会大量看到它</b>。所以这条规则在审计里的真实用途是两个：' +
          '① 判断一个包的 <span class="mono">targetSdkVersion</span> 是不是被迫升级过（看清单有没有大面积补 exported）；' +
          '② 排查"升 targetSdk 之后突然编不过了"。</p>') +

        '<h3>权限不是安全，级别才是</h3>' +
        '<p>组件上可以挂 <span class="mono">android:permission</span>（Provider 还可以分别挂 <span class="mono">readPermission</span> / ' +
        '<span class="mono">writePermission</span>）。看到它别急着判"安全"，先去看这个权限的 ' +
        T.term('protectionLevel', '权限的保护级别，决定谁能拿到这个权限；Android 的标准级别有 normal / dangerous / signature / signatureOrSystem 等。') +
        '：</p>' +
        T.tbl(['protectionLevel', '第三方 App 想调用你的组件，需要付什么代价', '审计结论'],
          [
            ['<span class="mono">normal</span>', '<b>什么都不用付</b>：在自己清单里写一行 <span class="mono">&lt;uses-permission&gt;</span> 就申请到了，用户看不到任何提示',
             '<b>等于没保护</b>（这是最会骗人的一种写法）'],
            ['<span class="mono">dangerous</span>', '需要用户点一次「允许」——而这一步是可以用界面诱导的', '弱保护，不能当安全边界'],
            ['<span class="mono">signature</span>', '必须和你的 App <b>用同一个签名</b>（通常是自家产品线内部）', '真正拦得住第三方'],
            ['<span class="mono">signatureOrSystem</span>', '同签名或系统应用', '同上（且更严）'],
            ['（自定义字符串 / 没声明）', '未知', '<b>当成拦不住</b>，并列入待人工确认']
          ]) +
        T.note('bad', '🔥 最典型的假安全写法',
          '<p style="margin-bottom:0">' +
          '<span class="mono">&lt;permission android:name="com.example.vulnapp.permission.ADMIN" android:protectionLevel="normal" /&gt;</span><br>' +
          '<span class="mono">&lt;activity android:name=".admin.AdminPanelActivity" android:exported="true" ' +
          'android:permission="com.example.vulnapp.permission.ADMIN" /&gt;</span><br><br>' +
          '这份声明<b>看起来是"管理员面板 + 管理员权限"</b>，实际上任何 App 都能进。' +
          '4.3 的实验里会再遇到它——它专门用来骗"扫一眼报告就签字"的人。</p>') +

        '<h3>为什么这一章要从"组件"开始，而不是从"加密"开始</h3>' +
        '<p>因为绝大多数移动端被真正利用的缺陷，不在密码学上，而在<b>边界没画</b>上。' +
        '密钥用了 AES-256、传输用了 TLS 1.3，然后一个导出的 Provider 把整个私有目录读出去了——这种事在真实评估里比"算法被破"常见得多。</p>' +
        T.grid(2, [
          '<b>攻击面清单 = 审计清单 = 逆向入口清单</b>' +
          '<p style="margin-bottom:0">本节这张"哪些组件开放"的表有三重身份：' +
          '对安全评审它是<b>风险清单</b>；对你加固时它是<b>该收的边界</b>；' +
          '而对一个正在做的事是"读懂这个 App"的人（比如第 1、5 章的你），它是<b>入口清单</b>——' +
          '导出的 Activity 往往就是关键业务逻辑的第一现场，因为它必须能被"非本进程"拉起。</p>',
          '<b>本章与前后章节的分工</b>' +
          '<p style="margin-bottom:0">第 8 章（加固/完整性校验）与第 12 章（抓包对抗）站在<b>对抗分析方</b>的位置：' +
          '对手是人，手段是提高你的成本。本章站在<b>开发者/评审方</b>的位置：对手是你自己的默认值，' +
          '手段是把边界一条条标出来。<b>同一个 App，两个视角看到的是完全不同的东西。</b></p>'
        ]) +
        T.note('warn', '⚠️ 本章所有复现手法都只用于你有授权的应用',
          '<p style="margin-bottom:0">下面出现的 <span class="mono">adb am start</span>、' +
          '<span class="mono">content query</span>、Drozer 一类命令，示例一律针对自造的 ' +
          '<span class="mono">com.example.vulnapp</span> 或公开靶场 App（4.15 案例）。' +
          '<b>拿这些命令去试别人的线上 App 是另一件事，本章不提供那条路径。</b></p>'),
      quiz: {
        id: 'q29-1', chapter: 29, answer: 1,
        stem: '一个 <span class="mono">&lt;activity&gt;</span> 声明了 <span class="mono">&lt;intent-filter&gt;</span>，' +
              '但整个清单里没有 <span class="mono">android:exported</span>。这个 App 的 <span class="mono">targetSdkVersion</span> 是 33。会发生什么？',
        options: [
          { t: '系统按「有 intent-filter 就导出」的默认值处理，这个 Activity 会被导出', why: '这条默认值确实存在，但它在 targetSdk ≥ 31 时已经用不上了——因为这份清单根本走不到设备上。' },
          { t: '构建阶段就会失败（manifest 合并 / lint 报 <span class="mono">android:exported needs to be explicitly specified</span>），产不出包', why: '✅ 正确。Android 12 起，有 intent-filter 的组件必须显式声明 exported，否则构建就被拦住；即便绕过构建，targetSdk ≥ 31 的设备也会在安装时拒绝。<b>报错文案随 AGP 版本变化</b>。' },
          { t: '能正常编译和安装，只在运行时抛 SecurityException', why: '不存在这种运行时检查。导出与否是安装时就确定的静态属性，不会等到运行。' },
          { t: '只会输出一条 lint warning，不影响打包与安装', why: '这条规则的目标就是"不让你上线"，不是"提醒你注意"。把强制项当提醒，是升级 targetSdk 时最常见的误判。' }
        ],
        explain: '这一题考的不是"默认值是什么"，而是<b>你对规则生效时机的认知</b>。' +
          '"默认导出"是平台语义，"必须显式声明"是构建/安装门槛，两者叠加的结果是：在 targetSdk ≥ 31 的世界里，' +
          '这份清单<b>连存在的机会都没有</b>。所以当你在审计中看到一份"没写 exported 却有 filter"的清单时，' +
          '首先要问的是：<b>这份清单是从哪来的</b>——是老代码、还是被人为改过的产物？'
      },
      after: T.note('ok', '✅ 这一节的收获',
        '<p style="margin-bottom:0">你现在有了本章的坐标系：<b>任何一个组件风险，都可以先问三个问题</b>——' +
        '① 它导出吗？② 保护它的权限是什么级别？③ 它拿到外部输入之后做了什么？' +
        '后面七节，全部是这三个问题的展开。</p>')
    },

    /* ============================================================ 4.2 */
    {
      h: '4.2', title: '动画：一次跨 App 调用要过几道门',
      html:
        '<p>下面这个动画把一个"外部 App 调用你的组件"的完整过程拆成 8 步。' +
        '注意看：<b>七类风险分别住在哪一步</b>——第③④道门是"越权"和"目录遍历"的家，' +
        '第⑦步是"组件 DoS"的家，而"重打包"和"明文存数据"根本不走这条链（它们是静态的和落盘的问题）。</p>' +
        '<p>把这条链记住，实战里排查任何一个组件问题，都能先定位到"它是在哪一道门上出的"。' +
        '所有命令只在自造 Demo（<span class="mono">com.example.vulnapp</span>）与授权环境中验证。</p>',
      stage: {
        title: '跨 App 调用链 · 五道门与七类风险的位置',
        speed: 1600,
        render:
          '<div class="flow-col" style="gap:9px">' +
            '<div class="flow-row"><span class="pill mono">攻击者 App</span><span class="arrow">→</span>' +
              '<span class="blk" id="g0">① 发出一个 Intent</span></div>' +
            '<div class="flow-row" style="margin-left:20px"><span class="arrow">↓ 交给系统</span></div>' +
            '<div class="flow-row"><span class="blk" id="g1">② AMS/PMS 解析出目标组件</span>' +
              '<span class="arrow">→</span><span class="blk" id="g2">③ 门一：导出判定（exported）</span></div>' +
            '<div class="flow-row" style="margin-left:20px"><span class="arrow">↓ 通过</span></div>' +
            '<div class="flow-row"><span class="blk" id="g3">④ 门二：权限判定（permission + protectionLevel）</span>' +
              '<span class="arrow">→</span><span class="blk" id="g4">⑤ 拉起目标 App 的进程</span></div>' +
            '<div class="flow-row" style="margin-left:20px"><span class="arrow">↓</span></div>' +
            '<div class="flow-row"><span class="blk" id="g5">⑥ 组件回调拿到 Intent</span>' +
              '<span class="arrow">→</span><span class="blk" id="g6">⑦ 组件内部：这些参数怎么用</span></div>' +
            '<div class="flow-row" style="margin-top:6px;padding-top:10px;border-top:1px dashed var(--line)">' +
              '<span class="pill" id="gmark">点「单步」开始</span></div>' +
          '</div>',
        reset: function () {
          ['g0', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6'].forEach(function (i) { S(i, ''); });
          CLS('gmark', 'pill');
          SET('gmark', '点「单步」开始');
        },
        steps: [
          { run: function () { S('g0', 'hot'); SET('gmark', '① 攻击面从这里开始'); },
            note: '<b>攻击者只需要能写代码、能装 App。</b>他塞进 Intent 的东西可以是任意值：一个字符串、一个不存在的 key、一个 8MB 的 byte[]、' +
              '一个指向你私有目录的 <span class="mono">content://</span> URI。<span class="hit">这些东西在"发出"这一步全都是合法的</span>——系统不会替你校验内容。' },
          { run: function () { S('g0', 'done'); S('g1', 'active'); SET('gmark', '② 系统只做寻址，不做业务校验'); },
            note: '<b>AMS/PMS 干的事是"找组件"，不是"审内容"。</b>显式 Intent（带 ComponentName）是精确找人；' +
              '隐式 Intent 是按 action/category/data 匹配所有声明过 intent-filter 的组件。' +
              '匹配上的那一刻，<b>这个组件的存在就已经被第三方知道了</b>——这也是"攻击面清单"能被打出来的原因。' },
          { run: function () { S('g1', 'done'); S('g2', 'active'); SET('gmark', '③ 门一：exported'); },
            note: '<b>门一：exported 判定。</b>不导出 → 到此为止（SecurityException：Permission Denial）。' +
              '导出 → 放行。<br><b>这一道门是整章的根：</b>Activity 越权、Provider 目录遍历、Receiver 伪造广播，' +
              '全部以"这道门被打开"为前提。<span class="hit">门一不开，后面那些漏洞连触发的机会都没有。</span>' },
          { run: function () { S('g2', 'done'); S('g3', 'active'); SET('gmark', '④ 门二：权限级别'); },
            note: '<b>门二：权限判定。</b>组件上挂了权限，就看调用方有没有这个权限。<br>' +
              '关键是 <span class="mono">protectionLevel</span>：<b>signature 级别的权限在这里是硬墙，normal 级别在这里是纸墙</b>——' +
              '因为调用方可以在自己的清单里声明 <span class="mono">&lt;uses-permission&gt;</span> 直接拿到 normal 权限。' +
              '现实里大量"导出了、也加权限了、还是被打穿"的组件，都倒在这一步。' },
          { run: function () { S('g3', 'done'); S('g4', 'active'); SET('gmark', '⑤ 系统替你拉起进程'); },
            note: '<b>目标进程被拉起（或唤醒）。</b>这一步有个容易被忽略的后果：<b>攻击者可以放大你的进程启动次数</b>——' +
              '反复拉起一个重量级 Service/Activity，就能做出"合法"的资源消耗（这是组件 DoS 的一种温和形态，见 4.10）。' },
          { run: function () { S('g4', 'done'); S('g5', 'active'); SET('gmark', '⑥ 你的代码拿到外部数据'); },
            note: '<b>你的组件回调被执行，Intent 里的 extras 现在在你的进程里了。</b>' +
              '注意这里的心理陷阱：<b>很多开发者潜意识里认为"能被系统调起来 = 输入是可信的"</b>。' +
              '不是。系统只保证"是谁发的"，不保证"发的内容是什么"。' },
          { run: function () { S('g5', 'done'); S('g6', 'active'); SET('gmark', '⑦ 组件内部：最危险的一步'); },
            note: '<b>★ 七类风险里最容易被低估的一步：拿到参数之后你怎么用。</b><br>' +
              '· <b>不校验就强转</b> → ClassCastException（4.10）<br>' +
              '· <b>不判空就用</b> → NullPointerException<br>' +
              '· <b>直接当路径拼</b> → 目录遍历（4.8）<br>' +
              '· <b>直接当 SQL 参数拼</b> → SQL 注入（Provider 场景）<br>' +
              '· <b>直接当 URL 交给 WebView</b> → 任意页面加载 / 桥接暴露（4.7）<br>' +
              '<span class="hit">前六步都是系统在做判定，只有这一步是你自己在做判定——</span>而漏洞也几乎都在这一步。' },
          { run: function () { S('g6', 'cool'); CLS('gmark', 'pill ok'); SET('gmark', '✅ 五道门走通：风险的位置已经标出来了'); },
            note: '<b>收口：把七类风险按"住在这条链的哪一步"重新排一次。</b><br>' +
              '· <b>门一/门二（③④）</b>：Activity 越权、Provider 目录遍历、Receiver 伪造广播 → <b>边界问题</b><br>' +
              '· <b>第⑦步</b>：组件 DoS、WebView 跨域、注入类问题 → <b>输入处理问题</b><br>' +
              '· <b>不在这条链上</b>：重打包（静态产物问题）、敏感数据明文保存（落盘问题）→ ' +
              '<span class="hit">它们不需要攻击者调用你的组件，只需要拿到你的 APK 或你的设备</span><br>' +
              '这个分类很有用：<b>边界问题可以"关掉"，输入处理问题只能"改代码"</b>——前者的修复成本常常低一个数量级。' }
        ]
      }
    },

    /* ============================================================ 4.3 */
    {
      h: '4.3', title: '动手实验：从 Manifest 判攻击面',
      html:
        '<p>下面是一段教学构造的清单片段（<b>属性与写法都是真实语法</b>，组件名是自造的）。' +
        '里面故意混了四种东西：<b>真的危险、看着危险其实安全、看着安全其实危险、以及一条会让打包失败的历史遗留</b>。</p>' +
        '<p>这个实验的判定不是"看名字凶不凶"，而是<b>按平台规则算</b>：导出与否怎么推、权限级别算不算拦得住、' +
        '哪些组件连包都产不出来。你要做的是把这三个问题的答案写下来。</p>',
      lab: {
        title: '实验：Manifest 攻击面判定器',
        goal: '目标：按真实规则推出"谁能被调用"',
        intro:
          '<p>先点「🔍 判定攻击面」看规则表算出来的结果，再回答三个问题。</p>' +
          '<p><b>别用名字猜</b>——这段清单里有好几个名字很唬人但其实是安全的，也有名字很正常的其实是敞开的。</p>',
        inputs: [
          {
            key: 'manifest', label: 'AndroidManifest.xml 片段', hint: '可以直接改，判定会跟着变',
            type: 'textarea', rows: 16,
            value: SEC29_MANIFEST_SAMPLE
          },
          {
            key: 'callable', label: '① 哪些组件"任何 App 都能调用"？', hint: '写组件名（写类名最后一段即可），逗号分隔',
            ph: '例如 AdminPanelActivity, DownloadService', value: ''
          },
          {
            key: 'safeOne', label: '② 哪个组件"看着危险其实安全"，为什么？', hint: '指出组件名 + 它安全在什么地方',
            type: 'textarea', rows: 3, ph: '例如：…… 之所以安全，是因为……', value: ''
          },
          {
            key: 'dangerOne', label: '③ 哪个组件"看着安全其实危险"，为什么？', hint: '指出组件名 + 保护为什么失效',
            type: 'textarea', rows: 3, ph: '例如：…… 看起来有权限保护，但实际上……', value: ''
          }
        ],
        runLabel: '🔍 判定攻击面',
        autorun: true,
        run: function (v) { return sec29ManifestHtml(sec29Manifest(v.manifest)); },
        expected: function (v) {
          var r = sec29Manifest(v.manifest);
          var truth = r.exposed.map(function (c) { return sec29Short(c.name); });
          truth = truth.filter(function (x, i) { return truth.indexOf(x) === i; }).sort();
          var got = String(v.callable == null ? '' : v.callable).split(/[,，、;；\s]+/)
            .map(function (s) { return sec29Short(s); }).filter(function (s) { return /[a-z0-9_]/.test(s); });
          got = got.filter(function (x, i) { return got.indexOf(x) === i; }).sort();
          var miss = truth.filter(function (x) { return got.indexOf(x) < 0; });
          var extra = got.filter(function (x) { return truth.indexOf(x) < 0; });
          var setOk = truth.length > 0 && got.length > 0 && !miss.length && !extra.length;

          var safeText = String(v.safeOne == null ? '' : v.safeOne);
          var hasSafeName = window.AKKC_hasConcept(safeText, ['PayConfirmActivity', 'payconfirm', '支付确认']);
          var hasSafeWhy = window.AKKC_hasConcept(safeText, ['显式', '写死', '明确关闭', '关掉', 'false', '不论有 filter', '即使有 intent-filter']);
          var safeOk = hasSafeName && hasSafeWhy;

          var dangerText = String(v.dangerOne == null ? '' : v.dangerOne);
          var hasDangerName = window.AKKC_hasConcept(dangerText, ['AdminPanel', 'DebugReceiver', 'admin', '管理员']);
          var hasDangerWhy = window.AKKC_hasConcept(dangerText, ['normal', 'protectionLevel', '级别', '任何应用都能申请', '声明即得', '普通权限', '不是 signature', '签名级']);
          var dangerOk = hasDangerName && hasDangerWhy;

          var ok = setOk && safeOk && dangerOk;
          var d = '判定器算出的"任意 App 可调用"清单：<b>' + (truth.join('、') || '（空）') + '</b>（共 ' + truth.length + ' 个）。<br>';
          d += setOk ? '✅ ① 完整且没有多写。' :
            '❌ ① ' + (got.length ? '' : '这一栏还没填。') +
            (miss.length ? '漏了：<b>' + miss.join('、') + '</b>。' : '') +
            (extra.length ? '多写了：<b>' + extra.join('、') + '</b>（它们要么没导出，要么由 signature 级权限保护着）。' : '');
          d += '<br>' + (safeOk ? '✅ ② 说对了：PayConfirmActivity 有 intent-filter 但显式写了 exported="false" —— filter 只是"能被隐式匹配到"的声明，导不导出由 exported 说了算。'
            : '❌ ② 需要点出 <b>PayConfirmActivity</b>，并说清"安全"的原因是<b>它的 exported 被显式写成了 false</b>（有 intent-filter 并不等于导出）。');
          d += '<br>' + (dangerOk ? '✅ ③ 说对了：AdminPanelActivity / DebugReceiver 挂着权限，但那个权限的 protectionLevel 是 normal —— 第三方声明一下就能拿到。'
            : '❌ ③ 需要点出 <b>AdminPanelActivity</b>（或 DebugReceiver），并说清原因：<b>protectionLevel=normal 的权限挡不住第三方</b>，必须有 signature 级才算保护。');
          return { ok: ok, detail: d };
        },
        showAnswer:
          '【预填清单的判定结果】\n' +
          '  targetSdkVersion = 33\n' +
          '  ① SplashActivity        —— 有 LAUNCHER filter、没写 exported → 默认导出；且 targetSdk≥31 → 构建就会被拦\n' +
          '  ② PayConfirmActivity     —— 有 filter，但显式 exported="false" → 不导出（看着危险，其实安全）\n' +
          '  ③ AdminPanelActivity     —— exported=true + ADMIN 权限（protectionLevel=normal）→ 任何 App 可调用\n' +
          '  ④ SyncService            —— exported=true + INTERNAL 权限（signature）→ 真受保护\n' +
          '  ⑤ DownloadService        —— exported=true + 无权限 → 裸导出\n' +
          '  ⑥ InternalReceiver       —— 无 filter、无 exported → 默认不导出（但没有写死，有可维护性风险）\n' +
          '  ⑦ PushReceiver           —— 有 filter、没写 exported → 默认导出 + 构建被拦\n' +
          '  ⑧ DebugReceiver          —— exported=true + ADMIN（normal）→ 任何 App 可调用\n' +
          '  ⑨ SecureFileProvider     —— exported=true + 无读写权限 → 任何 App 可用 content:// 访问（且写方向也开着）\n' +
          '  ⑩ TraceActivity          —— exported 写的是 @bool/exported_debug → 静态判不出来，按"中"处理，需人工核实\n' +
          '  → 任何 App 都能调用：SplashActivity、AdminPanelActivity、DownloadService、PushReceiver、DebugReceiver、SecureFileProvider\n' +
          '  → 真正受保护：SyncService\n' +
          '  → 构建就会被拦：SplashActivity、PushReceiver\n\n' +
          '【三条比答案更重要的判据】\n' +
          '  · 「有权限」≠「安全」：决定生死的是 protectionLevel。normal = 声明即得。\n' +
          '  · 「没写 exported」≠「不导出」：要看有没有 intent-filter。反过来，老代码里"没写"是最常见的状态。\n' +
          '  · 「读到 @bool/xxx」≠「安全」：值在别处，静态判不出来 —— 审计要把"未知"和"安全"分开。\n\n' +
          '【动手改一改，看排序怎么翻转】\n' +
          '  把 ③ 的权限名换成 INTERNAL（signature 级），它的等级立刻从"高"掉到"低"；\n' +
          '  把 ② 的 exported="false" 删掉，它会立刻变成高风险的导出组件（而且 targetSdk=33 下打包失败）。\n' +
          '  —— 这就是判定器的意义：它演示的是规则，不是一张需要背的表。',
        hint:
          '<b>先看三件事，顺序不要乱：</b><br>' +
          '① <b>有没有 intent-filter</b>？有 filter 且没写 exported → 默认导出（这也是打包会失败的那种）。<br>' +
          '② <b>写了 exported 吗</b>？写死的值永远优先于默认值。<br>' +
          '③ <b>挂了权限的话，那个权限是什么级别</b>？去清单顶部的 <span class="mono">&lt;permission&gt;</span> 声明里找 ' +
          '<span class="mono">protectionLevel</span>：<b>signature 才是真保护，normal / dangerous 都拦不住第三方</b>。<br><br>' +
          'Provider 还有一条额外的：它分读、写两个方向，只设了 readPermission 的话，写入方向仍然是开的。',
        after: T.note('ok', '✅ 实验的收获',
          '<p style="margin-bottom:0">你刚做的事情，就是把 MobSF 那份"Manifest 风险项"报告<b>手工算了一遍</b>。' +
          '区别在于：现在你能回答"<span class="hit">它凭什么说这个是高危</span>"——' +
          '而这正是后面选择"先修哪一个"时唯一的依据。</p>')
      }
    },
    /* ============================================================ 4.4 */
    {
      h: '4.4', title: '风险一：应用重打包',
      intuition: {
        tag: '直觉模型 · 复印机与署名',
        body:
          '<p>你写了一本书。有人把它拿去复印，在中间插了两页广告，然后放在书店里卖——<strong>封面上还是你的名字，读者也以为是你加的</strong>。</p>' +
          '<p>这就是重打包对开发者的真实含义：它不是"代码被别人读懂了"，而是' +
          '<strong>"你的产品被复制成了一份你控制不了的产物，而且用户分不清"</strong>。</p>' +
          '<p>和本章其他风险不同的是：重打包<strong>不需要攻击者碰你的服务器，也不需要碰用户设备上的其他 App</strong>——' +
          '他只需要拿到那个 APK 文件。所以它是唯一一类"你什么都没做错，只要发过包就可能中招"的风险。</p>'
      },
      html:
        '<p>先把边界划清楚，因为这一节很容易写偏：<b>改包的具体手法（反编译、改 smali、重签名）在第 2 章讲，' +
        '签名校验与完整性校验的原理在第 8 章讲。</b>本节只回答一个开发者视角的问题：' +
        '<span class="hit">重打包到底会造成什么后果，我该怎么评估它、怎么防</span>。</p>' +

        T.card('重打包能造成什么（按动机分，不是按技术分）',
          T.tbl(['动机', '他会怎么做', '对你的实际伤害'],
            [
              ['<b>植入后门 / 广告 / 扣费</b>', '在启动链路或某个界面上插代码，把你的 App 变成他的流量或扣费通道',
               '<b>最严重的一类</b>：用户看到的是你的品牌，干的却是他的事；投诉、差评、监管风险全落到你头上'],
              ['<b>盗版与二次分发</b>', '去掉付费校验、内购校验，重新签名后放到小渠道',
               '直接收入损失；且这些渠道的用户你完全看不到'],
              ['<b>去广告 / 破解 VIP</b>', '把你自己的付费点改掉', '对工具类、会员制产品的伤害最直接'],
              ['<b>钓鱼变体</b>', '保留你的界面外观，替换登录逻辑，把账号密码发到自己服务器',
               '<b>用户凭据泄漏</b>，而用户会认为是"你们家 App 出问题了"'],
              ['<b>绕过你的更新通道</b>', '关掉版本检查，让用户永远停在老版本', '你修好的漏洞永远送不到这批用户手上']
            ])) +

        T.note('key', '🔑 为什么这门"技术含量不高"的攻击值得当真',
          '<p style="margin-bottom:0">因为它的成本结构对攻击者极其有利：<b>批量、可自动化、用户无法分辨</b>。' +
          '一个改包脚本可以对一百个 App 跑一遍，而用户的判断依据通常只有"图标像不像、名字对不对"——' +
          '这两样东西在重打包后<b>完全可以一模一样</b>（甚至包名也必须一样，否则覆盖安装不了，' +
          '这反而让假包更难被识破）。<br>' +
          '所以评估重打包风险时，不要用"技术难度"当权重，要用<b>动机强度 × 你的可发现性</b>——' +
          '一个日活高、有付费点、品牌知名的 App，即使代码没有任何缺陷，也天然处在这条风险的前排。</p>') +

        '<h3>它作为攻击手法的边界：一条签名校验就能让它失效</h3>' +
        '<p>重打包的整条链路都建立在一个前提上：<b>改完的包你愿意重新签名，并且目标 App 不检查签名</b>。' +
        '一旦 App 里有签名校验或完整性校验，攻击者的成本曲线立刻变陡：他要么去定位并绕过校验（这是第 8 章讲的那场对抗），' +
        '要么放弃这个目标换下一个。</p>' +
        T.tbl(['你在客户端做的防护', '它实际挡住了什么', '它的边界（挡不住什么）'],
          [
            ['签名校验（Java 层读 PackageInfo.signatures 比对）', '拦住"下载一个自动化改包脚本跑一遍"的低成本攻击',
             '能改 smali 的人可以把它一起改掉；校验点越多越难全部找到，但确实只是"提高成本"'],
            ['签名校验（native 层 + 多校验点 + 交叉验证）', '把绕过成本推到"需要动态调试 + 定位所有校验点"的量级',
             '仍然挡不住有针对性的人力分析；且你要自己承担误报风险（渠道重签名、企业分发会改变签名）'],
            ['完整性校验（dex/so/资源的摘要比对）', '发现"包被改动过"这件事本身，而不只是"签名变了"',
             '摘要值放在客户端 = 攻击者可以连同摘要一起改；真正的锚点必须在服务端'],
            ['服务端校验关键判断', '<b>这是最有效的一条</b>：把"用户有没有权限做这件事"的最终判定放到服务端',
             '前提是你的关键业务真的依赖服务端——纯离线的功能无法这样保护'],
            ['应用签名方案（App Signing / 平台侧签名）', '让攻击者拿不到你的私钥，也无法伪装成官方渠道发布',
             '不影响他在第三方渠道分发改过的包；服务可用性与政策会变，<span class="pill warn">待核实</span>']
          ]) +
        T.note('bad', '🔥 一个常见的误判：把签名校验当成"安全边界"',
          '<p style="margin-bottom:0">签名校验的本质是<b>成本门槛</b>，不是不可逾越的墙。如果你把它当成边界，' +
          '就会得出"我已经防住了重打包"这种结论，从而跳过后面的动作——' +
          '而真正该做的两件事是：<b>① 让关键判断服务端化；② 建立"发现假包"的运营能力</b>' +
          '（渠道巡检、用户举报入口、崩溃/日志里出现异常签名时告警）。' +
          '<span class="hit">技术上挡不住的攻击，要靠"发现得快"来减少损失</span>，这是安全工程里很常见的一种分工。</p>') +
        T.grid(2, [
          '<b>重打包 vs 第 8 章的"三类威胁模型"</b>' +
          '<p style="margin-bottom:0">重打包属于第 8 章讲的<b>第三类威胁（防二次打包）</b>：' +
          '它的成功标准不是"你看不懂我"，而是"你改完就崩"。' +
          '所以它的对手不是混淆和加密，而是<b>完整性</b>——必须有一个"预期值"去比对。<br>' +
          '这解释了一个常见困惑：<b>为什么混淆度很高的 App 依然会被重打包？</b>' +
          '因为混淆提高的是"读懂代码"的成本，它完全不阻止"改一行常量再签名"。</p>',
          '<b>本章的视角差在哪里</b>' +
          '<p style="margin-bottom:0">第 2 章会教你怎么改一个包、第 8 章会教你判定壳的类型——' +
          '那些章节的读者是"要突破的人"。<br>' +
          '本章问的是另一组问题：<b>这个风险在我的产品里排第几？我投入一周期去做完整性校验，' +
          '比投入一周去做组件收敛，哪个更值？</b>' +
          '这是评审视角，它的产出不是技术方案，而是<b>优先级</b>。</p>'
        ]),
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一',
            scenario: '<b>情境：</b>你的 App 上线三周，某个第三方渠道出现了一个图标、名称、包名都和你一样的安装包。' +
                      '有用户反馈"装了之后老是弹广告"。你下载下来一看：签名不是你的，但界面和你的产品一模一样。',
            q: '你的第一反应是什么？',
            choices: [
              { t: '先取证：把样本存下来、比对签名与 dex 差异、记录分发渠道与时间，同时启动侵权下架流程', next: 'n1' },
              { t: '立刻在下一版加上签名校验，尽快全量推送给用户', next: 'n2' },
              { t: '在 App 里加一段"检测到广告 SDK 就自动退出"的逻辑', next: 'n3' },
              { t: '先不管：影响的是盗版渠道的用户，等它自己消失', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'good',
            verdictTitle: '正确：先固定证据、再止损、最后才是技术加固',
            result: '<b>取证必须排在第一，而且它有时间窗口。</b>假包随时可能被下架或换版本，' +
              '而<b>签名指纹、dex 差异、渠道与时间戳</b>这些东西一旦错过就补不回来，' +
              '它们既是法务/平台投诉的凭据，也是你判断"他改了什么"的唯一材料。<br><br>' +
              '更关键的是：取证会告诉你<b>这到底是哪一类重打包</b>——' +
              '只是去广告？插了数据采集？还是替换了登录逻辑（那就是凭据泄漏，等级完全不同）。' +
              '<span class="hit">不先分类就动手加固，你很可能在防一个不存在的问题，同时漏掉真正在发生的问题。</span><br><br>' +
              '止损优先级：平台投诉下架（用户触达面）→ 应用内提醒/公告 → 再排技术加固。' +
              '技术加固（签名校验、完整性校验）永远排在"止血"之后，因为它对已经装上的假包无效。'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'bad',
            verdictTitle: '方向对，但顺序错了——而且它救不了已经中招的人',
            result: '<b>签名校验是"下一版"的事，但它拦不住任何已经装了假包的用户。</b><br><br>' +
              '原因很简单：签名校验运行在<b>你的包</b>里。用户装的是<b>他的包</b>——' +
              '那个包里没有你的校验逻辑，或者说，他可以顺手把它删掉。<br>' +
              '所以这条路的真实效果只有两个：① 让<b>未来的</b>攻击者成本变高；② 让<b>未来</b>从正规渠道下载的用户更安全。' +
              '它对你此刻的处境（假包已经在流通）几乎没有帮助。<br><br>' +
              '而且你还漏了一步：<b>没有取证就没有投诉材料</b>。等你想走平台流程时，样本已经找不到了。<br><br>' +
              '<b>认知根源：</b>把"技术手段"默认成了第一动作。安全事件的第一动作永远是' +
              '<b>搞清楚发生了什么、留下了什么证据</b>——技术加固是第三步。'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '在自己的包里防别人的包，必然误伤自己',
            result: '这段逻辑跑在<b>你的 APK</b> 里，但假包是<b>别人的 APK</b>——你的代码根本不在里面运行。' +
              '所以它对假包<b>零效果</b>。<br><br>' +
              '反过来，它对你自己的代价却是实打实的：' +
              '广告 SDK 的类名会随版本变、你可能自己也会接广告 SDK、加固/热修复/插件化会改变类加载路径……' +
              '<span class="hit">在客户端写"检测到 X 就自杀"，误伤率通常远高于命中率</span>，' +
              '而且它会给线上带来一类极难排查的"用户莫名闪退"。<br><br>' +
              '<b>认知根源：</b>用"我能写这段代码"代替了"这段代码会运行在谁那里"。' +
              '分析任何防护方案的第一步，都是先问<b>它运行在哪个进程、由谁控制</b>。'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '把品牌与凭据风险当成了"用户的选择"',
            result: '<b>盗版渠道的用户也是你的用户。</b>他们的差评、投诉、以及"你们 App 有病毒"的传播，' +
              '最终都记在你的品牌上——而这类口碑伤害的修复成本远高于技术加固。<br><br>' +
              '更严重的是，如果这个假包<b>替换了登录逻辑</b>（这是重打包最常见的升级形态），' +
              '那么泄漏的是<b>用户在你这里的账号密码</b>。这些用户接下来会在你的正版 App 里用同一套凭据登录——' +
              '<span class="hit">损失就从"品牌"升级成了"你自己的账号体系被撞库"</span>。<br><br>' +
              '另外，"等它自己消失"这个假设通常不成立：低成本的攻击不会因为你不理它就停止，' +
              '只会在你注意不到的地方继续分发。'
          }
        }
      }
    },

    /* ============================================================ 4.5 */
    {
      h: '4.5', title: '风险二：敏感数据明文保存',
      intuition: {
        tag: '直觉模型 · 花盆底下的钥匙',
        body:
          '<p>你给门换了把装甲锁，然后把钥匙压在门口花盆底下。</p>' +
          '<p>移动端的"明文保存"就是这个花盆：<strong>传输层用了 TLS 1.3，服务端做了风控，' +
          '然后 token 明文写在 shared_prefs 的一个 XML 文件里</strong>——' +
          '而那个文件，在 root 设备上、在备份里、在恶意 App 能碰到的地方，都是可读的。</p>' +
          '<p>更麻烦的是它的形态：明文保存造成的泄漏<strong>不是"一次事件"，而是"一个持续存在的可读面"</strong>——' +
          '只要数据还在那里，任何一个能读到它的路径都是一次泄漏。</p>'
      },
      html:
        '<p>这一节的目标很具体：<b>把"明文保存"从一个模糊的印象，变成一张可以逐项勾选的清单</b>。' +
        '下面六个落点覆盖了实战中绝大多数情况，每一行都给出<b>典型路径/字段形态</b>、' +
        '<b>谁能拿到</b>、<b>怎么审出来</b>、<b>怎么修</b>。</p>' +

        T.tbl(['落点', '典型形态（路径 / 字段名）', '谁能拿到', '怎么审', '怎么修'],
          [
            ['<b>SharedPreferences</b>',
             '<span class="mono">/data/data/&lt;pkg&gt;/shared_prefs/*.xml</span><br>' +
             '键名常见：<span class="mono">token</span>、<span class="mono">uid</span>、<span class="mono">password</span>、' +
             '<span class="mono">session</span>、<span class="mono">device_id</span>',
             'root / 调试设备上的其他进程；<span class="mono">adb backup</span>（见落点 ⑥）；' +
             '你自己 App 里任何一处能读文件的代码',
             '拉出来直接看（见下方 stepper）；MobSF 静态扫关键字；<span class="mono">grep -r "getSharedPreferences"</span>',
             'EncryptedSharedPreferences；或把凭据换成"短期 + 可撤销"的设计（见下方）'],
            ['<b>SQLite</b>',
             '<span class="mono">/data/data/&lt;pkg&gt;/databases/*.db</span>（另有 -wal / -shm）<br>' +
             '表名常见：<span class="mono">users</span>、<span class="mono">sessions</span>、<span class="mono">messages</span>',
             '同 SharedPreferences；数据库还可能被第三方 SDK 备份/上传',
             '<span class="mono">sqlite3</span> 打开看表结构与内容；注意 <span class="mono">-wal</span> 里可能残留已删数据',
             '敏感列加密（应用层字段级加密）；或存"引用"而不是"内容"（真正的数据留在服务端）'],
            ['<b>日志 logcat</b>',
             '<span class="mono">Log.d(TAG, "resp=" + json)</span> / 第三方 SDK 的网络日志',
             '<span class="pill warn">待核实</span> Android 4.1 起其他 App 不能再读别人的 logcat，' +
             '但 <b>adb logcat、日志采集 SDK、以及被授予日志权限的工具</b>仍能拿到',
             '<span class="mono">adb logcat | grep -iE "token\|phone\|id_card\|authorization"</span>；' +
             '注意 release 包里是否还留着调试日志',
             'release 构建关闭调试日志（构建类型区分）；上线前脱敏（打印前替换敏感字段）；' +
             '禁止整段打印响应体'],
            ['<b>外部存储</b>',
             '<span class="mono">/sdcard/</span>、<span class="mono">/storage/emulated/0/Android/data/&lt;pkg&gt;/</span>、' +
             '导出的相册/下载/缓存目录',
             '<span class="pill warn">待核实</span> 分区存储（Android 10 引入、Android 11 收紧）之后其他 App 对 ' +
             '<span class="mono">Android/data</span> 的访问被限制，但设备连接电脑、文件管理器、部分厂商工具仍可读',
             '在设备上翻这几个目录；搜 <span class="mono">getExternalStorageDirectory</span> / ' +
             '<span class="mono">getExternalFilesDir</span> 的调用点',
             '敏感数据一律放 app 私有目录；需要共享给其他 App 时走 FileProvider 并按需授权；' +
             '缓存目录里的临时文件用完即删'],
            ['<b>硬编码密钥 / 凭据</b>',
             '<span class="mono">BuildConfig</span> 常量、<span class="mono">strings.xml</span>、源码字符串常量、' +
             '<span class="mono">.so</span> 里的常量表<br>常见：<span class="mono">apiSecret</span>、' +
             '<span class="mono">AES_KEY</span>、<span class="mono">sign_salt</span>、第三方推送/地图 key',
             '<b>任何拿到 APK 的人</b>——不需要 root，不需要设备，只要把包下载下来',
             'MobSF 的硬编码密钥扫描；<span class="mono">strings</span> 扫 so；搜 16/24/32 位十六进制串与 base64 长串',
             '<b>客户端不放长期密钥</b>：需要签名的操作改为服务端签，或使用"每设备派生 + 服务端校验"的方案；' +
             '必须放前端的 key 要假设它已公开'],
            ['<b>备份通道</b>',
             '<span class="mono">android:allowBackup="true"</span>（不写时的默认值随版本变化，' +
             '<span class="pill warn">待核实</span>）<br>' +
             '<span class="mono">adb backup</span> 产物；云备份数据',
             '任何能在设备上执行 adb（或拿到备份文件）的人；' +
             '<span class="pill warn">待核实</span> Android 12 起对 <span class="mono">adb backup</span> 有所收紧，' +
             '具体条件（debuggable / targetSdk）需按目标版本确认',
             '读清单里的 <span class="mono">allowBackup</span> 与 backup rules；' +
             '<span class="mono">adb backup -f out.ab &lt;pkg&gt;</span> 试一次（授权设备上）',
             '<span class="mono">allowBackup="false"</span>（或配置 backup rules 排除敏感文件）；' +
             '不要把"备份后仍然有效"的凭据长期留在设备上']
          ]) +

        T.note('key', '🔑 审计这一步的真正难点：不是"找得到"，而是"判断得了"',
          '<p style="margin-bottom:0">上面每个落点都"能找到"，难的是<b>判断它算不算问题</b>。判据只有一条：' +
          '<span class="hit">这个地方的内容泄漏之后，攻击者能做什么？</span><br>' +
          '· 泄漏一个 <b>30 秒后过期的验证码</b> → 影响极小；<br>' +
          '· 泄漏一个 <b>长期有效的登录 token</b> → 可以冒充用户，影响大；<br>' +
          '· 泄漏一个 <b>能签名所有请求的固定密钥</b> → 可以伪造任何用户的请求，影响<b>最大且无法通过"改密码"挽回</b>。<br>' +
          '所以评估明文保存时，不要只列"哪里存了明文"，要同时标注<b>这个数据的生命周期与可撤销性</b>——' +
          '这才是决定优先级的依据。</p>') +

        '<h3>修的顺序：先缩影响，再加密</h3>' +
        '<p>很多团队一上来就去找加密库，其实性价比最高的动作是<b>先让泄漏的后果变小</b>：</p>' +
        T.grid(2, [
          '<b>第一步（几乎零成本）：缩短期限与权限</b>' +
          '<p style="margin-bottom:0">把长期 token 换成短期 access token + 可撤销的 refresh；' +
          '日志脱敏；<span class="mono">allowBackup="false"</span>；把敏感文件从外部存储挪回私有目录。<br>' +
          '这些改动<b>不碰业务逻辑</b>，但直接把"一次泄漏 = 永久失守"降级成"一次泄漏 = 几十分钟的窗口"。</p>',
          '<b>第二步：加密落盘（注意库的维护状态）</b>' +
          '<p style="margin-bottom:0">Android 侧的标准做法是 <b>Keystore</b>（密钥材料不出安全环境，硬件支持时在 TEE/StrongBox 里）+ ' +
          '<b>EncryptedSharedPreferences</b> 之类的封装。<br>' +
          '<span class="pill warn">待核实</span> Jetpack Security（<span class="mono">androidx.security:security-crypto</span>）' +
          '的维护状态近年有变化，选型前请确认当前推荐方案与你目标的 minSdk。<br>' +
          '另注意一个常见误解：<b>把密钥硬编码在代码里再"加密"数据，等于没加密</b>——' +
          '因为读 APK 就能拿到密钥。密钥必须来自 Keystore 或服务端。</p>'
        ]) +
        T.note('warn', '⚠️ 不要把"敏感"两个字推到极端',
          '<p style="margin-bottom:0">客户端<b>不存在</b>"绝对安全的本地存储"：只要数据必须在本机被使用，' +
          '一个拥有 root 或能调试该进程的人最终都能拿到它。所以正确的目标不是"做到绝对安全"，而是：' +
          '<b>提高获取成本 + 缩小泄漏的影响面 + 让泄漏可被发现</b>。<br>' +
          '把这三条写进评审结论，比写一句"建议对本地数据加密"有用得多——' +
          '因为前者能排优先级，后者只能进待办清单。</p>'),
      stepper: {
        title: '一次 ADB 取证的推演（授权设备 / 自造 Demo）',
        lines: [
          { code: 'adb shell run-as com.example.vulnapp ls -l shared_prefs/',
            note: '<b>第一步不是找漏洞，是先确认"能不能读"。</b><span class="mono">run-as</span> 只对<b>可调试</b>的包有效；' +
                  '对 release 包它会被拒（这正是它作为审计手段的边界，也是为什么它同时是"开发者的自查工具"）。' +
                  '<span class="pill warn">待核实</span> 不同设备/系统版本对 run-as 的限制有差异。',
            state: { '目标包': 'com.example.vulnapp', '是否可调试': 'debug 版：是', '读到的文件': '待列目录' },
            mem: '<b>为什么先做这一步：</b>它同时回答两个问题——「有没有敏感文件」和「这个包是不是 debuggable」。' +
                 '线上包带 <span class="mono">debuggable="true"</span> 本身就是一条独立的清单风险项。' },
          { code: 'adb shell run-as com.example.vulnapp cat shared_prefs/auth.xml',
            note: '<b>看到明文了。</b>这类文件的形态很固定：<span class="mono">&lt;string name="token"&gt;eyJhbGci…&lt;/string&gt;</span>。' +
                  '<span class="hit">注意这一步的判据不是"它 readable"，而是"这个值泄漏之后能干什么"</span>——' +
                  '如果它是一枚长期 token，这一条就是高危；如果它是一个 5 分钟后过期的 nonce，危害小得多。',
            state: { 'token': '明文（JWT 形态）', 'uid': '明文', '是否加密': '否', '有效期': '需要看 JWT 的 exp' },
            mem: '<b>顺手看一眼有效期：</b>把 token 粘到 JWT 解析里读 <span class="mono">exp</span>。' +
                 '"长期有效 + 无刷新机制"是这一条升为高危的关键条件。' },
          { code: 'adb shell run-as com.example.vulnapp ls -l databases/',
            note: '<b>数据库也要看，而且要看全三个文件</b>：<span class="mono">app.db</span>、' +
                  '<span class="mono">app.db-wal</span>、<span class="mono">app.db-shm</span>。' +
                  'WAL 文件里可能残留<b>已经被删除的行</b>——你以为"删掉了"的数据，可能还躺在那里。',
            state: { '数据库': 'app.db（含 -wal / -shm）', '大小': '非 0，说明有真实数据' },
            mem: '<b>一个容易忽略的点：</b>审计数据库时如果只看主库文件，会漏掉 WAL 里的残留。' },
          { code: 'sqlite3 app.db ".tables"  →  users  sessions  messages',
            note: '<b>先看表名，就能猜出这个 App 把什么存在了本地。</b>' +
                  '<span class="mono">sessions</span> 这种表名几乎可以直接断定"本地存了会话凭据"。' +
                  '这一步也是"数据本地化程度"的度量：<b>落在本地的表越多，一次设备失守的损失越大</b>。',
            state: { '表': 'users / sessions / messages', '本机留存度': '高（会话、消息都在本地）' },
            mem: '<b>评审写法：</b>"本地留存了 3 类敏感实体"，比"数据库未加密"更能说明影响。' },
          { code: 'sqlite3 app.db "select uid, token, expire from sessions limit 3"',
            note: '<b>确认明文。</b>到这一步你已经能给出完整结论：<b>一份凭据以明文形态落在本地文件系统里</b>，' +
                  '只要设备被 root、被备份、或进程被调试，它就可被读出。',
            state: { 'token 列': '明文', 'expire 列': '3 天后（偏长）', '结论': '高危（可冒充用户且窗口期长）' },
            mem: '<b>注意 expire 这一列的价值：</b>它决定了这条风险的"自愈窗口"。如果它是 30 分钟，同样一段明文的风险等级会降一档。' },
          { code: 'adb logcat -d | grep -iE "token|authorization|phone" | head -20',
            note: '<b>最后一处：日志。</b>日志的问题在于它<b>会离开设备</b>——被日志采集 SDK 上传、' +
                  '被用户截图贴到反馈群、被 adb 抓到测试机的日志文件里。' +
                  '<span class="hit">同一份 token 出现在三个地方，影响面不是相加而是三倍放大。</span>',
            state: { '日志命中': '3 行（含完整 token）', '是否 release 版': '是（调试日志没被裁掉）' },
            mem: '<b>常见的根因：</b>日志开关用了一个 <span class="mono">BuildConfig.DEBUG</span> 之外的常量，' +
                 '或者第三方 SDK 的网络日志默认开启。审计时要问一句"这条日志在 release 包里还在吗"。' },
          { code: '# 汇总：同一枚凭据的可读路径 = 3 条  →  修复顺序：日志 → 备份 → 存储 → 有效期',
            note: '<b>收口：把"发现"整理成"影响 + 顺序"。</b>这里给出的是一个可辩护的修复顺序：' +
                  '① 先关日志（零成本、零回归风险）；② 关备份 / 收窄备份范围（改一行清单）；' +
                  '③ 落盘加密（需要改代码，注意加密库与 Keystore 的选型）；' +
                  '④ 缩短凭据有效期并支持服务端撤销（改服务端，影响最大也最值）。' +
                  '<span class="hit">顺序的依据是"每单位成本能削减多少风险"，而不是"哪条听起来最严重"。</span>',
            state: { '可读路径': '3 条（prefs / db / log）', '建议第一批修': '日志 + 备份', '建议第二批': '落盘加密 + 有效期' },
            mem: '<b>这一节最想留下的肌肉记忆：</b>看到一个明文存储点，先问"它泄漏之后攻击者能做什么"，' +
                 '再问"修它的成本是多少"，两个答案放在一起，优先级自然就出来了。' }
        ]
      },
      quiz: {
        id: 'q29-2', chapter: 29, answer: 1,
        stem: '下面四个"明文保存"的位置，哪一个的<b>影响面最大、而且最无法通过事后补救挽回</b>？',
        options: [
          { t: '调试日志里打印了完整的登录响应体', why: '影响的是"被打印的那几次请求"，可以通过关日志、脱敏来止血，且日志通常不会长期留存。' },
          { t: 'APK 里硬编码了一枚用于给所有请求签名的固定密钥', why: '✅ 正确。它泄漏的是<b>整个系统的信任根</b>：任何拿到 APK 的人都能用它伪造<b>任意用户</b>的请求；而且它无法像密码那样"改一下就行"——改了要全量升级客户端，没升级的旧版本还得继续兼容它。' },
          { t: '把用户手机号写进了外部存储的一个 txt 文件', why: '影响是"某台设备上的这批数据"，属于单点泄漏，可以通过迁移目录、删除文件来收口。' },
          { t: 'SharedPreferences 里明文存了一个 uid', why: 'uid 本身不是凭据，危害取决于它搭配了什么（比如"只要传 uid 就能查数据"的接口——那问题在接口而不在存储）。' }
        ],
        explain: '这一题的关键不在"哪里存了明文"，而在<b>泄漏的东西是什么级别</b>。判断依据是两条：' +
          '<b>① 影响范围</b>（单个用户 / 一个设备 / 全部用户）和<b>② 可撤销性</b>（改密码就能作废 / 改了也要等所有客户端升级）。' +
          '硬编码密钥在这两条上都是最差的：它影响全部用户，而且撤销成本极高。' +
          '<span class="hit">这就是为什么"客户端不放长期密钥"是一条原则，而不是一条建议。</span>'
      }
    },

    /* ============================================================ 4.6 */
    {
      h: '4.6', title: '风险三：Activity 组件越权',
      html:
        '<p>"越权"这个词在移动端的含义比 Web 窄，也更具体：<b>一个本该在"登录之后、按业务流程"才能到达的界面，' +
        '被外部 App 用一个 Intent 直接拉起来了。</b></p>' +
        '<p>它通常表现为三种形态，危害依次递增：</p>' +
        T.tbl(['形态', '现象', '为什么危险'],
          [
            ['<b>跳过流程</b>', '直接 <span class="mono">am start</span> 到"订单确认页"、"支付结果页"、"内部调试页"',
             '看页面本身也许无害，但它<b>破坏了你的状态机假设</b>——后续代码可能在一个它从未预期过的状态下执行'],
            ['<b>带特权参数执行操作</b>', 'Intent 里塞 <span class="mono">--es uid 1</span>、<span class="mono">--ez is_admin true</span>，' +
             '而 Activity 直接读这些参数去查数据/改数据',
             '<b>这是真正的越权</b>：攻击者不需要登录，只要参数对，就能拿到别人的数据或替别人执行操作'],
            ['<b>直接取数据</b>', 'Intent 里带一个 <span class="mono">content://</span> URI 或一个文件路径，组件照着读',
             '把组件变成了一个"读任意文件/任意 Provider 的通用工具"，等价于给攻击者开了一个洞']
          ]) +

        T.note('key', '🔑 一句必须记住的话：登录页不是访问控制',
          '<p style="margin-bottom:0">"我的 App 打开就是登录页，不登录进不去"——这句话<b>只对正常用户成立</b>。' +
          '对另一个 App 来说，它根本不需要经过你的登录页：<b>它可以直接把目标 Activity 拉起来</b>。' +
          '因为 AMS 只会检查"这个组件是不是导出的"，不会检查"调用方有没有走过你的业务流程"。<br>' +
          '<span class="hit">访问控制必须做在"每一个出口"上，而不是做在"入口"上。</span></p>') +

        '<h3>怎么复现（只在自己的 Demo / 授权环境上）</h3>' +
        '<p>组件越权的复现之所以简单，是因为 <span class="mono">am</span> 本身就是一个"外部 App"的等价物：' +
        '它通过 AMS 发起调用，走的是和其他 App 完全一样的路径。下面这个终端演示针对自造的 ' +
        '<span class="mono">com.example.vulnapp</span>。</p>' +
        T.tbl(['命令片段', '在做什么'],
          [
            ['<span class="mono">am start -n 包名/组件全名</span>',
             '<b>显式 Intent</b>：直接点名组件。这是复现越权最主要的方式——只要组件导出，它就能被点名'],
            ['<span class="mono">-a &lt;action&gt; -c &lt;category&gt; -d &lt;uri&gt;</span>',
             '<b>隐式 Intent</b>：按 action/data 匹配。用来测试 intent-filter 暴露出来的入口'],
            ['<span class="mono">--es k v</span> / <span class="mono">--ei k 1</span> / <span class="mono">--ez k true</span>',
             '塞 String / int / boolean 型 extra。<b>越权的关键往往在这一段</b>：组件信任了这些值'],
            ['<span class="mono">--esa k a,b</span> / <span class="mono">-f &lt;flags&gt;</span>',
             '塞字符串数组 / 设置 flag（比如让组件进入新的任务栈）'],
            ['<span class="mono">--user 0</span>', '指定用户空间（多用户设备上换一个身份试）']
          ]) +
        T.note('warn', '⚠️ 命令只用于授权目标',
          '<p style="margin-bottom:0">上面这些参数是 <span class="mono">adb</span> 的公开文档行为，本身没有任何攻击性——' +
          '它们就是开发者日常调试用的东西。<b>但拿它们去试别人线上 App 的组件，就不是调试了。</b>' +
          '本章的所有命令都请只在你自己的应用、你自己的设备、或专门为此设计的靶场 App 上使用。</p>'),
      term: {
        title: '组件越权复现（授权 Demo：com.example.vulnapp）',
        lines: [
          { t: 'p', s: 'adb shell pm list packages | grep vulnapp', note: '先确认目标已安装。审计自己的 App 时，这一步也顺便确认了包名（多 flavor / 多渠道会改包名后缀）。' },
          { t: 'o', s: 'package:com.example.vulnapp', note: '有输出说明设备上装的是这个包。' },
          { t: 'p', s: 'adb shell dumpsys package com.example.vulnapp | grep -A2 "Activity Resolver Table"', note: '从系统的角度看看这个包里"能被匹配到的组件"有哪些。这一步是静态清单的动态对照物。' },
          { t: 'o', s: 'com.example.vulnapp/.admin.AdminPanelActivity filter ...', note: '注意：清单里导出的组件在这里才会出现。<b>两份清单（静态 + 动态）不一致时，以动态为准</b>——因为系统解析的结果才是真正生效的。' },
          { t: 'p', s: 'adb shell am start -n com.example.vulnapp/.admin.AdminPanelActivity', note: '<b>核心一步：直接点名拉起。</b>如果它真的起来了，说明这个界面没有对"调用方身份"做任何检查。' },
          { t: 'o', s: 'Starting: Intent { cmp=com.example.vulnapp/.admin.AdminPanelActivity }', note: '成功拉起。<b>此刻你就是"另一个 App"</b>——你没有登录、没有走你的业务流程，但管理面板开了。' },
          { t: 'p', s: 'adb shell am start -n com.example.vulnapp/.admin.AdminPanelActivity --es uid 1 --ez is_admin true', note: '再往前一步：<b>试试组件是否信任外部参数</b>。很多越权的真实危害不在"页面能打开"，而在"参数能改数据"。' },
          { t: 'w', s: '（若界面显示 uid=1 的数据，则参数被直接信任 → 越权读取他人数据）', note: '这一条就把风险等级从"流程被跳过"提升到"数据被越权访问"。<b>审计报告里这两者必须分开写。</b>' },
          { t: 'p', s: 'adb shell am start -n com.example.vulnapp/.ui.PayConfirmActivity', note: '对照组：试一个显式 exported="false" 的组件，看看拒绝长什么样。' },
          { t: 'e', s: 'java.lang.SecurityException: Permission Denial: starting Intent { cmp=com.example.vulnapp/.ui.PayConfirmActivity } from null (pid=..., uid=2000) not exported from uid 10xxx', note: '<b>这就是"修好了"的样子。</b>记住这条报错的形状——4.14 的复验环节要靠它来证明修复生效（<span class="pill warn">待核实</span>：文案与字段随平台版本略有差异）。' },
          { t: 'd', s: '结论：AdminPanelActivity 可被任意 App 直接拉起（高危）；PayConfirmActivity 不可导出（正确写法）。', note: '一份最小可交付的组件越权结论。注意它包含三件事：<b>哪个组件、什么条件下、证据是什么</b>。' }
        ]
      },
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一',
            scenario: '<b>情境：</b>你审出自己的 App 里有一个导出的 <span class="mono">AdminPanelActivity</span>。' +
                      '开发者解释："它内部第一步就是 <span class="mono">if (!SessionManager.isLoggedIn()) { finish(); return; }</span>，' +
                      '没登录根本进不去，所以不算漏洞。"',
            q: '这个说法成立吗？你的评估结论是什么？',
            choices: [
              { t: '成立：有登录检查就挡住了未登录的攻击者，风险可以降级', next: 'n1' },
              { t: '不成立：攻击者不需要登录，因为受害者通常处于已登录状态——它仍然是高危，但要把"利用前提"写清楚', next: 'n2' },
              { t: '不成立：应该让开发把所有 Activity 都加上 exported="false"，包括启动页', next: 'n3' },
              { t: '不好判断：登录检查的实现细节看不出来，先不写结论', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'bad',
            verdictTitle: '把"未登录的攻击者"当成了唯一的攻击者',
            result: '<b>这段检查挡的是"没登录的人"，而攻击者 App 根本不需要登录——它借用的是受害者的登录态。</b><br><br>' +
              '想一下现实场景：用户装了你的 App，正常登录（这是<b>常态</b>），手机里同时还装了那个恶意 App。' +
              '恶意 App 拉起 <span class="mono">AdminPanelActivity</span> 时，' +
              '<span class="mono">SessionManager.isLoggedIn()</span> 返回的是<b>用户自己的登录态</b>——检查通过，面板打开。<br><br>' +
              '<b>所以这个检查对越权几乎不起作用</b>：它保护的是"设备上没登录的你"，而攻击场景是"设备上已登录的用户"。' +
              '<span class="hit">判断一个检查是否构成访问控制，要问的是"它区分的是谁"——它区分了登录与否，但没有区分调用方是谁。</span><br><br>' +
              '<b>认知根源：</b>把"业务状态检查"当成了"调用方身份检查"。' +
              '前者防的是用户误操作，后者才防越权——这两件事在代码里长得像，语义完全不同。'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'good',
            verdictTitle: '正确：保留高危，但把利用前提写进结论里',
            result: '<b>这是可辩护的评估结论。</b>理由链条是：<br>' +
              '① 组件导出 → 任意 App 可拉起（这是可观测的事实，不需要猜）；<br>' +
              '② 组件内的检查是<b>业务状态检查</b>（是否登录），不是<b>调用方身份检查</b>（谁在调用）；<br>' +
              '③ 因此利用前提是"设备上已登录"——而这几乎是所有真实用户的常态，前提极易满足；<br>' +
              '④ 结论：<b>高危</b>，但要写明前提。<br><br>' +
              '<b>为什么要把前提写清楚</b>：因为修复方案取决于它。如果前提是"需要用户已登录"，' +
              '那么最有效的修复就是<b>把身份校验换成对调用方的校验</b>——' +
              '加 signature 级权限、或要求一个只能由本 App 生成的 token；' +
              '而不是简单地"再加一层登录判断"（那是同一个无效检查的复制）。<br><br>' +
              '<span class="hit">"在什么条件下成立"比"是不是漏洞"更有交付价值</span>——前者能直接变成修复方案和回归用例。'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '一刀切会砸掉产品功能',
            result: '"把所有 Activity 都设成不导出"确实能消掉组件越权，但它同时会砸掉：<br>' +
              '· <b>启动页</b>（LAUNCHER 必须能被系统/桌面唤起，设 false 后点图标都打不开）；<br>' +
              '· <b>分享、打开文件、扫码回调</b>这类必须由外部唤起的入口；<br>' +
              '· <b>深链与推送落地页</b>（它们依赖隐式 Intent 或外部跳转）。<br><br>' +
              '正确的做法是<b>逐个判定</b>：能关的关掉（首选）；确实必须导出的，加<b>能区分调用方</b>的保护；' +
              '需要接受外部 URI 的，用 <span class="mono">FileProvider</span> 并只暴露必要目录。<br><br>' +
              '<b>认知根源：</b>把"降低风险"理解成了"消灭入口"。安全评审的产出是<b>收敛到必要的最小集合</b>，' +
              '不是把所有门都焊死——焊死之后产品会用别的方式（更不安全的方式）绕过去。'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '用"看不出来"回避判断，等于把风险留给读者',
            result: '<b>你不需要看懂那段检查的全部实现，也能给出结论。</b>因为判定越权所需的三个事实都已经有了：' +
              '① 组件导出（清单里写着）；② 组件内有特权行为（管理面板，名字与位置都表明了）；' +
              '③ 唯一的门是业务状态检查，不是调用方身份检查（这是代码结构层面就能确认的）。<br><br>' +
              '如果确实需要更多信息，正确写法是给<b>条件结论</b>：' +
              '"若 <span class="mono">isLoggedIn()</span> 只读取本进程的会话状态，则该组件可被任意已登录环境下的第三方 App 拉起，判高危；' +
              '若它额外校验了调用方签名（<span class="mono">checkCallingPermission</span> 一类），则降为中"——' +
              '<span class="hit">并把"需要确认哪一行代码"明确写出来。</span><br><br>' +
              '<b>认知根源：</b>把"我不确定"和"没有结论"混为一谈。评审里允许不确定，但不允许没有结论——' +
              '因为你交出去的那份报告，会被人当成"这里没问题"。'
          }
        }
      },
      quiz: {
        id: 'q29-3', chapter: 29, answer: 2,
        stem: '一个 Activity 既没有 <span class="mono">intent-filter</span>，也没有写 <span class="mono">android:exported</span>。' +
              '下面哪个说法是对的？',
        options: [
          { t: '它会被导出，因为系统默认导出所有组件', why: '反了。没有 filter 时默认是<b>不</b>导出。' },
          { t: '它会被导出，只要攻击者用显式 Intent 点名就能拉起', why: '显式 Intent 能点名，但它仍然要过"导出"这道门——不导出的组件无法被其他 UID 的进程点名拉起。' },
          { t: '它不会被导出；但因为没有把 <span class="mono">false</span> 写死，将来有人给它加一个 intent-filter 时，它会静默变成导出', why: '✅ 正确。这就是"隐式默认值"的危害形状：今天的结论和安全一致，但结论的依据是一个会随需求变化而翻转的规则。' },
          { t: '它不会被导出，而且这个写法是最推荐的', why: '"默认不导出"和"显式说明不导出"在安全性上等价，但在<b>可维护性</b>上不等价——安全审计关心的是"半年后它还是不是安全的"。' }
        ],
        explain: '这一题考的是<b>默认值的稳定性</b>。平台给的默认值在"当前这一版清单"上是安全的，' +
          '但它的安全性依赖一个前提：<b>没人动过 intent-filter</b>。而这个前提非常脆弱——' +
          '加一个 filter 通常只是"为了让某个功能能用"的小改动，review 时几乎不会有人把它和"组件开放"联系起来。<br>' +
          '所以在审计里有个通用做法：<b>把"依赖默认值"的项单独标出来</b>，写成"当前安全，但依据是默认值，建议显式声明"。' +
          '这类"低危但建议改"的条目，是评审质量的分水岭。'
      }
    },

    /* ============================================================ 4.7 */
    {
      h: '4.7', title: '风险四：WebView 的跨域与桥接',
      html:
        '<p>WebView 是 App 里唯一一个"<b>执行外来代码</b>"的组件。它的风险也因此和别处不同：' +
        '其他组件要担心的是"外部传进来的数据"，WebView 要担心的是"<b>外部传进来的代码</b>"。</p>' +
        '<p>这一节拆三个东西：<b>桥（addJavascriptInterface）</b>、<b>三个 file 域开关</b>、' +
        '<b>URL 的可控性（shouldOverrideUrlLoading / 深链）</b>。三者单独看都不致命，' +
        '<span class="hit">但它们组合起来就是移动端最经典的 RCE 与数据读取路径</span>。</p>' +

        '<h3>① 桥：把 Java 对象交给 JS</h3>' +
        '<p><span class="mono">addJavascriptInterface(obj, "bridge")</span> 会把一个 Java 对象注入到页面的 JS 上下文里，' +
        '页面里就能写 <span class="mono">window.bridge.xxx()</span>。这个设计本身没错——错的是<b>它能被谁调用</b>：' +
        '只要这个页面能被替换、被劫持，或者干脆是外部页面，桥就交到了别人手里。</p>' +
        T.note('bad', '🔥 经典问题：低版本上的反射逃逸',
          '<p style="margin-bottom:0">在 <b>Android 4.2（API 17）之前</b>，注入的 Java 对象<b>所有 public 方法</b>都能被 JS 调到——' +
          '包括从 <span class="mono">Object</span> 继承来的 <span class="mono">getClass()</span>。' +
          '而拿到 <span class="mono">Class</span> 对象之后，就能一路反射到 <span class="mono">Runtime.exec()</span>，' +
          '把"读一个字段"的桥变成<b>任意命令执行</b>。<br>' +
          'API 17 起，只有标了 <span class="mono">@JavascriptInterface</span> 注解的方法才会被暴露，这条路被堵住了。<br>' +
          '<span class="pill warn">待核实</span> 具体到你目标的系统版本，还要确认：WebView 是否被独立更新过（不同 WebView 版本的行为差异）、' +
          '以及厂商定制是否改动过相关行为。<b>结论"API 17 是分界线"是文档层面的，不是"你在任何设备上都能复现/复现不了"的保证。</b></p>') +

        '<h3>② 三个开关：它们管的根本不是同一件事</h3>' +
        T.tbl(['开关', '它到底在管什么', '打开之后的实际后果'],
          [
            ['<span class="mono">setAllowFileAccess</span>',
             'WebView <b>能不能加载 file:// 协议的 URL</b>',
             '关掉之后 WebView 连本地文件都不读了（有些依赖加载本地 HTML 的混合应用会直接坏掉）'],
            ['<span class="mono">setAllowFileAccessFromFileURLs</span>',
             '<b>file:// 页面之间</b>能不能互相读（同源策略在 file 域上的放宽）',
             '一个本地 HTML 可以用 XHR 读到<b>其他本地文件</b>——包括你自己私有目录里的 shared_prefs / databases'],
            ['<span class="mono">setAllowUniversalAccessFromFileURLs</span>',
             'file:// 页面能不能访问 <b>任意来源</b>（含 http/https）',
             '把本地页面变成一个"能对外发请求、能读本地文件"的跳板——数据外传的组合拳就是它 + 上面那个']
          ]) +
        T.note('warn', '⚠️ 这三个默认值的历史包袱很重（必须标注不确定性）',
          '<p style="margin-bottom:0">两个 <span class="mono">FromFileURLs</span> 开关的默认值<b>随 targetSdkVersion 变化过</b>：' +
          '社区与文档里常见的说法是"targetSdk 15 及以下默认 true，16 及以上默认 false"，' +
          '而 <span class="mono">setAllowFileAccess</span> 的默认值在更近的版本里也被收紧过。<br>' +
          '<span class="pill warn">待核实</span> <b>不确定点写清楚</b>：① 每个开关的确切版本边界；' +
          '② 默认值是跟 <span class="mono">targetSdkVersion</span> 走还是跟<b>设备系统版本</b>走（这两者不是一回事）；' +
          '③ 不同 WebView 实现（系统 WebView 被独立更新）是否改变过默认行为。<br>' +
          '<span class="hit">审计时的正确做法不是背默认值，而是：在代码里显式写出来，并且只关心"有没有人显式打开过它"。</span></p>') +

        '<h3>③ URL 可控性：桥可以被送到互联网上</h3>' +
        '<p>这是最容易被忽略的一环，也是把前两个问题"放大"的环节。只要满足下面任一条，' +
        '你的桥就不再只服务于你自己的页面：</p>' +
        '<ul>' +
        '<li><span class="mono">shouldOverrideUrlLoading</span> 里不校验域名就直接 <span class="mono">loadUrl</span>——' +
        '页面里的一个链接就能把 WebView 带到任意外部站点；</li>' +
        '<li>深链（deep link）或推送落地页把 URL 当参数传进来，直接 load；</li>' +
        '<li>Intent 里带一个 URL 交给 WebView 打开（这也是"Intent 重定向"在 WebView 上的形态）。</li>' +
        '</ul>' +
        '<p><b>后果：</b>一个外部 https 页面此时运行在<b>已经注入过桥</b>的 WebView 里，' +
        '它可以直接调 <span class="mono">window.bridge.*</span>。' +
        '<span class="hit">"桥只暴露了安全的方法"这个假设，在页面本身不可信时就失效了</span>——' +
        '哪怕每个方法都很克制，组合起来也可能读出不该读的东西。</p>' +
        T.card('修复清单（按性价比排）',
          T.tbl(['动作', '成本', '拦住什么'],
            [
              ['<b>只加载白名单域名</b>（https + 明确的 host 列表），在 <span class="mono">shouldOverrideUrlLoading</span> / ' +
              '<span class="mono">shouldInterceptRequest</span> 里统一校验，非白名单一律交给系统浏览器',
               '低（改一个拦截函数）', '绝大多数"桥被送到互联网"的场景'],
              ['<b>关掉 file 域</b>：显式 <span class="mono">setAllowFileAccess(false)</span>、' +
              '两个 FromFileURLs 显式设为 false', '低（三行配置）', 'file:// 页面的越权读与本地跳板'],
              ['<b>桥不传敏感数据、只传动作</b>，且每个方法都在 Java 侧重新校验（不信任 JS 传来的 uid/金额）',
               '中（改接口设计）', '即使桥被调用，也拿不到高权限行为'],
              ['<b>改用更窄的通道</b>（如 WebMessage 通道 / 原生与 JS 的消息约定）替代宽泛的桥对象',
               '中高（要改前后端约定）', '减少暴露面。具体 API 与可用性随版本变化，<span class="pill warn">待核实</span>'],
              ['<b>不让外部 URL 进入同一个 WebView 实例</b>：敏感页面用独立实例，且不注入桥',
               '中', '把"外部页面"和"有桥的页面"物理隔开——这是最彻底的一条']
            ])),
      stage: {
        title: 'WebView 的三个开关 · 谁在管哪一段',
        speed: 1500,
        render:
          '<div class="flow-col" style="gap:9px">' +
            '<div class="flow-row"><span class="blk" id="w0">WebView 实例（已 setJavaScriptEnabled）</span></div>' +
            '<div class="flow-row"><span class="arrow">↓ 注入桥</span><span class="blk" id="w1">addJavascriptInterface(obj, "bridge")</span></div>' +
            '<div class="flow-row" style="margin-top:6px"><span class="pill mono">开关一</span>' +
              '<span class="blk" id="w2">setAllowFileAccess</span>' +
              '<span class="arrow">→</span><span class="blk" id="w3">页面能不能加载 file://</span></div>' +
            '<div class="flow-row"><span class="pill mono">开关二</span>' +
              '<span class="blk" id="w4">setAllowFileAccessFromFileURLs</span>' +
              '<span class="arrow">→</span><span class="blk" id="w5">file:// 页面能不能读别的 file://</span></div>' +
            '<div class="flow-row"><span class="pill mono">开关三</span>' +
              '<span class="blk" id="w6">setAllowUniversalAccessFromFileURLs</span>' +
              '<span class="arrow">→</span><span class="blk" id="w7">file:// 页面能不能读任意来源</span></div>' +
            '<div class="flow-row" style="margin-left:20px"><span class="arrow">↓ 还有一个变量：页面是谁的</span></div>' +
            '<div class="flow-row"><span class="blk" id="w8">页面来源：本地资产 / 白名单域名 / 任意外部 URL</span></div>' +
            '<div class="flow-row" style="margin-top:6px;padding-top:10px;border-top:1px dashed var(--line)">' +
              '<span class="pill" id="wmark">点「单步」开始</span></div>' +
          '</div>',
        reset: function () {
          ['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8'].forEach(function (i) { S(i, ''); });
          CLS('wmark', 'pill');
          SET('wmark', '点「单步」开始');
        },
        steps: [
          { run: function () { S('w0', 'hot'); SET('wmark', '① 先问：这个 WebView 要执行谁写的代码？'); },
            note: '<b>WebView 的独特之处：它是 App 里唯一执行"外来代码"的地方。</b>' +
              '所以它的风险评估要从"页面的来源"开始，而不是从"打开了哪些开关"开始。' },
          { run: function () { S('w0', 'done'); S('w1', 'active'); SET('wmark', '② 注入桥 = 给页面一批 Java 能力'); },
            note: '<b>桥是"把 App 的能力租给页面"。</b>租给谁、租多少，是这一节全部风险的根。' +
              '<span class="pill warn">待核实</span>：API 17 起只有 <span class="mono">@JavascriptInterface</span> 标注的方法可被调用（各 WebView 实现与厂商定制可能有差异）。' },
          { run: function () { S('w1', 'done'); S('w2', 'active'); S('w3', 'active'); SET('wmark', '③ 开关一：file:// 还能不能用'); },
            note: '<b>开关一决定"本地文件还能不能被加载"。</b>关掉它，很多混合应用会直接坏掉——' +
              '所以它是三个开关里最常被"不得不打开"的那个。' +
              '<span class="hit">而它一打开，后面两个开关的重要性立刻上升</span>：因为此时"本地页面"这个攻击面回来了。' },
          { run: function () { S('w2', 'done'); S('w3', 'done'); S('w4', 'active'); S('w5', 'active'); SET('wmark', '④ 开关二：file 域之间能不能互相读'); },
            note: '<b>开关二决定：一个本地页面能不能读到<b>其他本地文件</b>。</b>' +
              '打开它，一个能注入进本地页面的 XHR 就能读到你自己私有目录里的 shared_prefs（明文 token 就住在那儿）。' +
              '<span class="pill warn">待核实</span> 默认值随 targetSdk 变化的边界。' },
          { run: function () { S('w4', 'done'); S('w5', 'done'); S('w6', 'active'); S('w7', 'active'); SET('wmark', '⑤ 开关三：本地页面能不能读任意来源'); },
            note: '<b>开关三决定"数据能不能出去"。</b>它和开关二组合起来，就是一条完整的数据外传链路：' +
              '读本地文件 → 发到外部服务器。单独看任何一个开关都"还好"，<b>组合起来才是完整的攻击路径</b>。' },
          { run: function () { S('w6', 'done'); S('w7', 'done'); S('w8', 'active'); SET('wmark', '⑥ 关键变量：页面是谁的'); },
            note: '<b>现在把三个开关全部放一边，问一个更重要的问题：这个 WebView 会加载哪些 URL？</b><br>' +
              '· 只有打包在 assets 里的本地页面 → 攻击者需要先能改你的 APK（成本高）；<br>' +
              '· 只有白名单域名 → 攻击者需要拿到那个域名的控制权（成本高）；<br>' +
              '· <b>任何 URL 都能进来</b>（深链、推送、Intent 参数、页面内跳转不校验）→ ' +
              '<span class="miss">攻击者只需要一个有公网域名的页面</span>。' },
          { run: function () { S('w8', 'hot'); SET('wmark', '⑦ 最危险的组合出现了'); },
            note: '<b>任意 URL 可加载 + 桥已注入 = 桥被送给了互联网。</b>' +
              '此时"我桥上的方法都很克制"这个辩解就不成立了——因为调用者是攻击者，他会按自己的需要组合这些方法。' +
              '<span class="hit">这一条是 WebView 风险里优先级最高的：它把"本地问题"变成了"远程可利用"。</span>' },
          { run: function () { S('w8', 'done'); CLS('wmark', 'pill ok'); SET('wmark', '✅ 收口：先控页面来源，再谈开关'); },
            note: '<b>修复顺序就此确定：</b><br>' +
              '① <b>控来源</b>（白名单 + 拦截所有非白名单跳转）——成本最低、收益最大；<br>' +
              '② <b>收敛桥</b>（不传敏感数据、Java 侧重新校验、敏感页面用独立实例）；<br>' +
              '③ <b>关 file 域开关</b>（显式关掉，并且不要依赖默认值）；<br>' +
              '④ <b>不用外部 URL 打开带桥的实例</b>。<br>' +
              '<span class="hit">注意顺序：先控来源，是因为它把"能不能被远程触发"这个问题直接掐断了；' +
              '而调开关只是缩小后果。</span>' }
        ]
      },
      stepper: {
        title: '桥的反射逃逸链（API 17 之前的行为，示意）',
        lines: [
          { code: '// Java 侧：一个"看起来无害"的桥\nwebView.addJavascriptInterface(new JsBridge(), "bridge");\npublic class JsBridge { public String getVersion() { return "15.0"; } }',
            note: '<b>起点：一个只暴露了一个只读方法的桥。</b>开发者的心理模型是"我什么都没给，就给了个版本号"。' +
                  '<b>这个模型在 API 17 之后基本成立，在之前不成立。</b>',
            state: { '暴露的方法': 'getVersion()', '开发者预期': 'JS 只能读版本号' },
            mem: '<b>为什么从"预期"开始看：</b>安全评审要对比的是"代码实际暴露了什么"和"开发者以为暴露了什么"，两者的差就是缺陷。' },
          { code: '// 页面里（或注入进来的脚本里）\nbridge.getClass()',
            note: '<b>JS 侧第一跳：拿到 Class 对象。</b><span class="mono">getClass()</span> 是 ' +
                  '<span class="mono">Object</span> 的方法——<b>你没有写它，但它继承了它</b>。' +
                  '这就是"暴露 public 方法"和"暴露你写的方法"之间的差别。',
            state: { '调用': 'bridge.getClass()', '得到': 'java.lang.Class', '是否开发者写的': '否（继承自 Object）' },
            mem: '<b>关键判据：</b>当暴露面是"对象"而不是"方法列表"时，继承来的成员也一起暴露了。' },
          { code: 'bridge.getClass().forName("java.lang.Runtime")',
            note: '<b>第二跳：用 Class 的 forName 去取任意类。</b>到这里，桥已经不再"只暴露一个方法"了——' +
                  '<span class="hit">它变成了一个能访问整个 Java 类空间的入口。</span>',
            state: { '调用': 'Class.forName("java.lang.Runtime")', '得到': 'Runtime 类引用' },
            mem: '<b>这一跳为什么能成立：</b>因为它用的全是 Class 对象自己的 public 方法，而这些方法不在你"想暴露"的清单里。' },
          { code: 'Runtime.getRuntime().exec(...)  // 或读文件、读属性、反射调其它类',
            note: '<b>终点：从"读版本号"变成"执行命令"。</b>这就是为什么历史上的这个缺陷被归到 RCE 级别——' +
                  '<b>它不是"信息泄漏"，而是"拿到了 App 的全部能力"</b>（包括 App 自己的权限：读写私有目录、访问网络）。',
            state: { '影响': '任意命令执行 / 任意文件读取', '所需前提': '页面可控（外部 URL 或被注入）' },
            mem: '<b>注意两个前提缺一不可：</b>① 系统版本允许反射（API < 17）；② 页面可控。' +
                  '这也是为什么修复可以两头做——升级 targetSdk 或收紧页面来源，任一都能断掉这条链。' },
          { code: '// Android 4.2（API 17）之后的规则：\npublic class JsBridge { @JavascriptInterface public String getVersion() { ... } }',
            note: '<b>补救：只有标了 <span class="mono">@JavascriptInterface</span> 的方法被暴露。</b>' +
                  '继承来的方法、以及没标注的方法都不再可达，反射逃逸这条链在默认情况下被切断。' +
                  '<span class="pill warn">待核实</span> 该行为的实际边界（WebView 独立更新、厂商定制、以及"标了注解但方法本身很危险"的情况）需要按目标设备确认。',
            state: { '暴露面': '只有显式标注的方法', '反射逃逸': '默认不可达（待按设备核实）' },
            mem: '<b>但注意：注解只解决了"暴露哪些方法"，没解决"谁能调用"。</b>' +
                  '如果页面是外部 URL，攻击者照样能调用你标注过的那些方法——<b>所以页面来源的控制不可省。</b>' },
          { code: '# 结论：桥的风险 = 暴露面 × 页面可控性 × 系统版本',
            note: '<b>把这一节压缩成一个乘法式：</b>暴露面越小、页面越不可控（越可信）、系统版本越新，风险越低。' +
                  '三个因子<b>任何一个为零，风险就可以忽略</b>——这正是修复的着力点：' +
                  '你不需要三个都做到完美，你只需要把其中一个做到位。',
            state: { '最高性价比': '控制页面来源（把"页面可控性"打到最低）', '次高': '收敛桥的暴露面', '辅助': '提高 minSdk / 显式关掉 file 域开关' },
            mem: '<b>这种"乘法式"的思考方式可以复用到本章所有风险上：</b>' +
                  '风险 = 可达性 × 保护缺口 × 后果严重度。找到那个"最小代价就能归零"的因子，就是找到了修复优先级。' }
        ]
      },
      quiz: {
        id: 'q29-4', chapter: 29, answer: 3,
        stem: '一个 App 的 WebView 开着 JavaScript、注入了桥、并且在 <span class="mono">shouldOverrideUrlLoading</span> 里' +
              '不做任何校验就 <span class="mono">loadUrl(url)</span>。桥本身只暴露了一个"读取当前版本号"的方法。' +
              '你的评估是？',
        options: [
          { t: '低危：桥只暴露了版本号，没有敏感能力', why: '这是"按方法清单评估"的思路，但它漏掉了最关键的变量——<b>谁在调用</b>。' },
          { t: '低危：只要把两个 file 域开关关掉就安全了', why: '关掉 file 域能削弱"读本地文件"，但拦不住"外部页面调用桥"这条路——桥的能力与开关无关。' },
          { t: '中危：属于加固建议，不构成实际风险', why: '"任意 URL + 已注入桥"是一个完整的远程可利用路径，把它归到"建议"会低估它。' },
          { t: '高危：任意 URL 可加载意味着桥被交给了互联网；"只暴露版本号"这个前提在页面不可信时不成立，且 API 17 之前还有反射逃逸', why: '✅ 正确。判据是"页面可控性"这个因子拉满了：外部页面进了带桥的实例，桥就按攻击者的需要被调用。再加上低版本上的反射逃逸（待按设备核实），这条链的上限是命令执行。' }
        ],
        explain: '这一题考的是<b>评估的风险因子有没有找全</b>。很多人评估 WebView 时的默认顺序是"看配置"——' +
          'JS 有没有开、文件域有没有关、桥暴露了什么。但真正决定"能不能被远程触发"的是<b>页面来源</b>。<br>' +
          '一个很实用的自查问法：<b>"把恶意网页塞进我的 WebView，需要什么条件？"</b>' +
          '如果答案是"只需要一个链接"，那这个 WebView 的风险就是远程可达的。' +
          '<span class="hit">远程可达 + 已注入桥 + 低版本系统 = 这条链的上限是任意代码执行，不是信息泄漏。</span>'
      }
    },
    /* ============================================================ 4.8 */
    {
      h: '4.8', title: '风险五：ContentProvider 的目录遍历',
      html:
        '<p>ContentProvider 是四大组件里唯一一个"<b>直接对外提供数据</b>"的组件。它的暴露面比 Activity 大得多：' +
        'Activity 被拉起只影响一个界面，而一个导出的 Provider 可以让别的 App <b>查询、插入、更新、删除</b>，' +
        '甚至在 <span class="mono">openFile</span> 的实现有缺陷时<b>读取整个 App 私有目录里的任意文件</b>。</p>' +
        '<p>这一节专讲最后那种：<b>目录遍历（path traversal）</b>。它的成因非常集中，' +
        '集中到可以用一句话说完——</p>' +
        T.note('bad', '🔥 一句话版本',
          '<p style="margin-bottom:0">开发者做了一个"安全检查"，<b>检查的是字符串，打开的是文件</b>。' +
          '这两件事在路径里不是一回事：字符串里的 <span class="mono">..</span> 只是一个名字，' +
          '而文件系统在 <span class="mono">open()</span> 时会把它解释成"回到上一级"。</p>') +

        '<h3>典型的易受攻击实现（示意，不是可编译的完整代码）</h3>' +
        T.code(
          '@Override\n' +
          'public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {\n' +
          '    File root = new File(getContext().getFilesDir(), "shared");\n' +
          '    // ❌ 直接把 Uri 的 path 拼到根目录后面\n' +
          '    File f = new File(root, uri.getPath());\n' +
          '    // ❌ 这个"检查"同时犯三个错误：不归一化、不加分隔符、检查与打开的对象不一致\n' +
          '    if (!f.getAbsolutePath().startsWith(root.getAbsolutePath())) {\n' +
          '        throw new SecurityException("forbidden");\n' +
          '    }\n' +
          '    return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);\n' +
          '}'
        ) +
        '<p>三个错误逐条对上：<b>① <span class="mono">new File(parent, child)</span> 只是把字符串接起来</b>，' +
        '<span class="mono">..</span> 被原样保留；' +
        '<b>② <span class="mono">getAbsolutePath()</span> 只补当前工作目录，不消除 <span class="mono">..</span></b>；' +
        '<b>③ <span class="mono">startsWith</span> 没有分隔符边界</b>，' +
        '所以 <span class="mono">shared-notes</span> 这种同前缀的兄弟目录也会被放行。</p>' +

        '<h3>Uri 的三段结构，以及"谁能决定哪一段"</h3>' +
        T.tbl(['组成部分', '形态', '攻击者能不能控制', '风险点'],
          [
            ['scheme', '<span class="mono">content://</span>', '不能（除非你把 <span class="mono">android:scheme</span> 配得很宽）', '低'],
            ['authority', '<span class="mono">com.example.vulnapp.files</span>', '不能选中别人的 authority，但能选中你注册过的任意一个', '如果有多个 Provider，注意每个的导出配置'],
            ['path', '<span class="mono">/report.pdf</span>、<span class="mono">/../../databases/app.db</span>', '<b>完全可控</b>', '<b>这就是漏洞发生的地方</b>'],
            ['query 参数', '<span class="mono">?name=../../x</span>', '完全可控', '如果 <span class="mono">displayName</span> / <span class="mono">_data</span> 之类的列被当路径用，同样是入口']
          ]) +
        T.note('warn', '⚠️ 一个容易被忽略的细节：解码是在你之前完成的',
          '<p style="margin-bottom:0">Android 的 <span class="mono">Uri.getPath()</span> 返回的是<b>已解码</b>的路径，' +
          '<span class="mono">getEncodedPath()</span> 才是原始（未解码）形式。' +
          '这意味着 <span class="mono">%2e%2e%2f</span> 这类写法在你的代码里<b>已经变成了 </b>' +
          '<span class="mono">../</span>，你看到的是"看得见"的 <span class="mono">..</span>，' +
          '但你如果只在字符串层面过滤（比如检查"有没有 .. 子串"），攻击者还有编码、二次编码、' +
          '以及不同 Uri 解析路径的差异可以利用。<br>' +
          '<span class="pill warn">待核实</span> 不确定点：各种编码绕过手法在不同 Android 版本 / 不同 URI 解析路径下的实际表现。' +
          '<b>所以正确的结论不是"过滤 .. 就够了"，而是"不要用外部输入拼路径"。</b></p>') +

        '<h3>怎么审计（两条路，互相验证）</h3>' +
        T.grid(2, [
          '<b>静态：读 openFile / query 的实现</b>' +
          '<p style="margin-bottom:0">在反编译产物里搜 <span class="mono">openFile</span>、' +
          '<span class="mono">getPath()</span>、<span class="mono">getLastPathSegment</span>、' +
          '<span class="mono">new File(</span> 的组合。<br>' +
          '关键不是"有没有做检查"，而是<b>检查发生在归一化之前还是之后</b>——' +
          '这是静态审 Provider 目录遍历时唯一需要盯的点。</p>',
          '<b>动态：直接要一个 URL 试试</b>' +
          '<p style="margin-bottom:0"><span class="mono">content query</span> 能读表；' +
          '<span class="mono">openFile</span> 这条路要用能发 <span class="mono">ContentResolver.openInputStream</span> 的调用方去试。' +
          'Drozer 的 provider 模块会把"可访问的 URI / 可读写的路径"枚举出来。<br>' +
          '<span class="pill warn">待核实</span> Drozer 各模块与命令的具体形态随版本变化（见 4.12）。</p>'
        ]) +
        '<p>修复只有一句话，但要做到才算数：<b>把检查对象从"字符串"换成"归一化之后的真实路径"，' +
        '并且彻底取消"由外部输入决定路径"这件事</b>——把 Uri 当成 ID，用查表映射到固定文件；' +
        '或者直接改用 <span class="mono">FileProvider</span> 并只暴露 <span class="mono">cache-path</span> 这类必要目录。</p>',
      stage: {
        title: 'openFile 的路径解析 · 检查与打开为何不是同一个对象',
        speed: 1500,
        render:
          '<div class="flow-col" style="gap:9px">' +
            '<div class="flow-row"><span class="pill mono">请求</span>' +
              '<span class="blk" id="p0">content://…files/../../databases/app.db</span></div>' +
            '<div class="flow-row" style="margin-left:20px"><span class="arrow">↓ Uri 解析（getPath 已解码）</span></div>' +
            '<div class="flow-row"><span class="blk" id="p1">path = /../../databases/app.db</span></div>' +
            '<div class="flow-row" style="margin-left:20px"><span class="arrow">↓ new File(root, path)：只是字符串拼接</span></div>' +
            '<div class="flow-row"><span class="blk" id="p2">/data/user/0/com.example.vulnapp/files/shared/../../databases/app.db</span></div>' +
            '<div class="flow-row" style="margin-left:20px"><span class="arrow">↓ 字符串前缀检查（不归一化）</span></div>' +
            '<div class="flow-row"><span class="blk" id="p3">以 root 开头？通过 → 进入 open()</span></div>' +
            '<div class="flow-row" style="margin-left:20px"><span class="arrow">↓ 内核在 open() 时逐级回退 ..</span></div>' +
            '<div class="flow-row"><span class="blk" id="p4">/data/user/0/com.example.vulnapp/databases/app.db</span>' +
              '<span class="arrow">→</span><span class="blk" id="p5">越权读到私有数据库</span></div>' +
            '<div class="flow-row" style="margin-top:6px;padding-top:10px;border-top:1px dashed var(--line)">' +
              '<span class="pill" id="pmark">点「单步」开始</span></div>' +
          '</div>',
        reset: function () {
          ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'].forEach(function (i) { S(i, ''); });
          CLS('pmark', 'pill');
          SET('pmark', '点「单步」开始');
        },
        steps: [
          { run: function () { S('p0', 'hot'); SET('pmark', '① 攻击者能控制的只有 path'); },
            note: '<b>注意 authority 是合法的</b>——攻击者在访问"你注册过的那个 Provider"，' +
              '他不是在伪造请求，而是在正常使用它的接口。<span class="hit">这正是导出组件风险的典型形态：' +
              '接口本身合法，输入的内容不合法。</span>' },
          { run: function () { S('p0', 'done'); S('p1', 'active'); SET('pmark', '② path 是解码后的字符串'); },
            note: '<b>Uri.getPath() 给到你的已经是解码后的值。</b>所以你在日志里能"看见" <span class="mono">..</span>——' +
              '这也是为什么很多开发者认为自己已经"检查过了"。' },
          { run: function () { S('p1', 'done'); S('p2', 'active'); SET('pmark', '③ 拼接不会消除 ..'); },
            note: '<b>★ 关键点：<span class="mono">new File(parent, child)</span> 不解析路径。</b>' +
              '它做的是"如果 child 不以 / 开头就补一个分隔符，然后接起来"。' +
              '所以 <span class="mono">..</span> 原样留在这个<b>字符串</b>里——' +
              '<span class="hit">此刻它还不是一个"位置"，只是一个名字。</span>' },
          { run: function () { S('p2', 'done'); S('p3', 'active'); SET('pmark', '④ 检查通过（检查的是字符串）'); },
            note: '<b>检查通过了，而且它"看起来是对的"。</b>因为检查的字符串确实以根目录开头。' +
              '如果这里用的是 <span class="mono">getCanonicalPath()</span>，结果会完全不同——' +
              '归一化之后它会变成 <span class="mono">…/databases/app.db</span>，前缀检查立刻失败。' +
              '<span class="hit">漏洞不在"有没有检查"，而在"检查的是哪个字符串"。</span>' },
          { run: function () { S('p3', 'done'); S('p4', 'active'); SET('pmark', '⑤ 内核解释了 .. 的含义'); },
            note: '<b>真正的解析发生在 open() 里。</b>内核按目录项逐级处理：遇到 <span class="mono">..</span> 就回到父目录。' +
              '于是同一个字符串<b>在读的时候变成了另一个位置</b>。' +
              '<span class="hit">"检查时"和"使用时"是两个时刻——这就是 TOCTOU 类问题的移动端变体。</span>' },
          { run: function () { S('p4', 'done'); S('p5', 'miss'); SET('pmark', '⑥ 越权的不是随机文件，是 App 自己的私有目录'); },
            note: '<b>收口：为什么这个漏洞在移动端特别值钱。</b>因为 Provider 与业务数据住在<b>同一个 App 沙箱</b>里：' +
              '一次 <span class="mono">..</span> 就能从"共享文件目录"走到 <span class="mono">databases/</span>、' +
              '<span class="mono">shared_prefs/</span>、甚至 <span class="mono">/data/data/&lt;pkg&gt;/</span> 下的任意位置。' +
              '换句话说：<b>目录遍历在移动端通常等价于"把 4.5 那一节的明文数据全部读走"。</b>' },
          { run: function () { S('p5', 'done'); CLS('pmark', 'pill ok'); SET('pmark', '✅ 修法：归一化后再比，且不要用外部输入拼路径'); },
            note: '<b>三种修法，强烈程度递增：</b><br>' +
              '① <span class="mono">getCanonicalPath()</span> + 分隔符边界的白名单（最低要求，能挡住 <span class="mono">..</span> 和符号链接）；<br>' +
              '② 只用 <span class="mono">getLastPathSegment()</span> 取文件名，自己拼到固定目录（挡住路径结构本身）；<br>' +
              '③ <b>不让 Uri 决定路径</b>：Uri 当 ID 查表映射，或改用 FileProvider 只暴露必要目录（<span class="hit">最彻底</span>）。<br>' +
              '为什么推荐 ③：因为 ① 和 ② 都要求你把所有归一化细节想周全，而 ③ 让这类问题在结构上不可能出现。' }
        ]
      },
      term: {
        title: 'Provider 审计会话（授权 Demo：com.example.vulnapp.files）',
        lines: [
          { t: 'p', s: 'adb shell content query --uri content://com.example.vulnapp.files/config', note: '<span class="mono">content</span> 是系统自带的调试工具，它就是一个"外部 App"的等价物——用它验证 Provider 是否真的可从外部访问。' },
          { t: 'o', s: 'Row: 0 name=api_env, value=prod', note: '能读到内容 → 这个 Provider 至少对 query 是开放的。注意这里读的是<b>表</b>，不是文件。' },
          { t: 'p', s: 'adb shell content query --uri content://com.example.vulnapp.files/config --projection "name,value"', note: '指定列名再查一次。审计时列名本身就是情报：出现 <span class="mono">token</span>、<span class="mono">path</span>、<span class="mono">_data</span> 这类列名要重点看它们会不会被当路径用。' },
          { t: 'o', s: '（同上）', note: '投影参数能正常工作，说明这个 Provider 走的是标准 SQLite 查询接口。' },
          { t: 'p', s: 'adb shell content call --uri content://com.example.vulnapp.files --method getFile --arg /etc/hosts', note: '<b>自定义方法（call）是审计的重点</b>：很多"为了内部方便"加的 method 会接收一个路径参数，而入口处没有做任何校验。' },
          { t: 'w', s: '(若返回文件内容或异常栈里含真实路径，说明参数被直接用于文件访问)', note: '这一步的判据不是"崩没崩"，而是<b>返回内容或异常信息里有没有出现你预期的路径之外的东西</b>。' },
          { t: 'p', s: 'adb shell content query --uri content://com.example.vulnapp.files/config --where "name=1"', note: '<span class="mono">--where</span> 直接拼进 SQL：如果实现里把 where 参数<b>字符串拼接</b>到查询里，这里可以试出注入。' },
          { t: 'e', s: 'Error: near "1": syntax error  (SQLiteException)', note: '<b>异常信息本身就是证据</b>：它说明 your where 子句进入了 SQL 解析器。审计报告里要写清"探测语句 + 返回的异常形状"，而不是只写一句"疑似 SQL 注入"。' },
          { t: 'p', s: 'adb shell dumpsys package com.example.vulnapp | grep -A3 "Providers:"', note: '从系统视角看 Provider 的授权与权限配置——这是静态清单的动态对照物。' },
          { t: 'o', s: 'Provider{... com.example.vulnapp.files}  readPermission=null writePermission=null exported=true', note: '<b>两个 permission 都是 null 且 exported=true</b>：读和写都对外开放。这一行就是"高危"的硬证据。' },
          { t: 'd', s: '结论：config 表可被任意 App 读取；where 子句疑似拼接进 SQL；自定义 method getFile 需要人工确认参数校验。', note: '注意结论的措辞：<b>"可读取"是已证实的，"疑似注入"和"需要确认"是待定的</b>——把已证实和待确认分开写，是审计报告可信度的来源。' }
        ]
      }
    },

    /* ============================================================ 4.9 */
    {
      h: '4.9', title: '动手实验：ContentProvider 路径穿越判定器',
      html:
        '<p>这个实验把 4.8 讲的那套规则变成一台机器：你给它一批候选 Uri，' +
        '它按<b>真实的路径处理顺序</b>（Uri 解码 → 字符串拼接 → 词法归一化 → 符号链接解析）算出每一个请求最终打到哪个文件，' +
        '并且同时给出<b>三种"白名单检查"各自的判定结果</b>。</p>' +
        '<p>请特别关注对照关系：<b>有的请求三种检查全都放行</b>（真的越权），' +
        '有的<b>只有正确写法拦得住</b>，还有的<b>看着像绝对路径其实老老实实待在根目录里</b>。</p>',
      lab: {
        title: '实验：ContentProvider 路径穿越判定器',
        goal: '目标：按真实路径规则判越权并给修法',
        intro:
          '<p>预填了 7 个候选 Uri，覆盖了正常请求、<span class="mono">..</span> 逃逸、URL 编码、' +
          '同前缀兄弟目录、符号链接、以及"看着像绝对路径"的干扰项。</p>' +
          '<p><b>任务：</b>① 点「🔍 逐条判定」看每个请求的最终落点；' +
          '② 填出<b>真正越权（读到根目录之外）</b>的那些；③ 写出修复方案。</p>',
        inputs: [
          { key: 'root', label: 'Provider 的根目录（可改，判定会跟着变）', hint: 'openFile 里那个 root 的绝对路径', value: SEC29_ROOT },
          {
            key: 'uris', label: '候选 Uri（一行一个）', hint: '可以直接增删，判定会跟着变',
            type: 'textarea', rows: 9,
            value: [
              'content://com.example.vulnapp.files/report.pdf',
              'content://com.example.vulnapp.files/../../databases/app.db',
              'content://com.example.vulnapp.files/%2e%2e%2f%2e%2e%2fdatabases/app.db',
              'content://com.example.vulnapp.files/subdir/../../../databases/app.db',
              'content://com.example.vulnapp.files/../shared-notes/plan.txt',
              'content://com.example.vulnapp.files//etc/hosts',
              'content://com.example.vulnapp.files/link/leak.db'
            ].join('\n')
          },
          {
            key: 'escaped', label: '① 哪些请求最终读到了根目录之外？', hint: '写行号（如 2,3,5）或把 Uri 原样贴上，逗号/换行分隔',
            type: 'textarea', rows: 3, ph: '例如 2,3,5,7', value: ''
          },
          {
            key: 'fix', label: '② 修复方案（你会怎么改这段 openFile）', hint: '要写到"具体怎么做"，不要写"加强校验"',
            type: 'textarea', rows: 4, ph: '例如：先……再……，并且……', value: ''
          }
        ],
        runLabel: '🔍 逐条判定',
        autorun: true,
        run: function (v) { return sec29TraverseHtml(v); },
        expected: function (v) {
          var root = String(v.root == null ? '' : v.root).trim() || SEC29_ROOT;
          var lines = String(v.uris == null ? '' : v.uris).split(/\r?\n/).map(function (s) { return s.trim(); })
            .filter(function (s) { return s.length > 0; });
          var rows = lines.map(function (u) { return sec29Traverse(u, root); });
          var truth = [];
          for (var i = 0; i < rows.length; i++) { if (rows[i].escaped) truth.push({ idx: i + 1, uri: rows[i].uri }); }
          var tokens = String(v.escaped == null ? '' : v.escaped).split(/[,，、;；\s]+/)
            .map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
          var used = {}, miss = [], extra = [];
          for (var t = 0; t < tokens.length; t++) {
            var tok = tokens[t], hitIdx = -1;
            if (/^#?[0-9]+$/.test(tok)) {
              var n = parseInt(tok.replace(/[^0-9]/g, ''), 10);
              for (var q = 0; q < truth.length; q++) { if (truth[q].idx === n) { hitIdx = q; break; } }
            } else {
              for (var w = 0; w < truth.length; w++) {
                if (used[w]) continue;
                if (truth[w].uri.indexOf(tok) >= 0 || tok.indexOf(truth[w].uri) >= 0) { hitIdx = w; break; }
              }
            }
            if (hitIdx >= 0) used[hitIdx] = true;
            else extra.push(tok);
          }
          for (var k = 0; k < truth.length; k++) { if (!used[k]) miss.push('第 ' + truth[k].idx + ' 行'); }
          var setOk = truth.length > 0 && miss.length === 0 && extra.length === 0;

          var fixText = String(v.fix == null ? '' : v.fix);
          var f1 = window.AKKC_hasConcept(fixText, ['getCanonicalPath', 'canonical', '归一化', '规范化', 'realpath', '真实路径']);
          var f2 = window.AKKC_hasConcept(fixText, ['白名单', '允许列表', '映射', 'id', '查表', 'fileprovider', '固定目录', '不用 uri 拼', '不拼路径']);
          var f3 = window.AKKC_hasConcept(fixText, ['分隔符', 'separator', '边界', '等于根', '前缀加', '斜杠']);
          var fixOk = f1 && (f2 || f3);

          var ok = setOk && fixOk;
          var d = '判定器算出真正越权的请求：<b>' + (truth.map(function (x) { return '第 ' + x.idx + ' 行'; }).join('、') || '（无）') + '</b>（共 ' + truth.length + ' 条）。<br>';
          d += setOk ? '✅ ① 全部找对，也没有多报。' :
            '❌ ① ' + (tokens.length ? '' : '这一栏还没填。') +
            (miss.length ? '漏了：<b>' + miss.join('、') + '</b>。' : '') +
            (extra.length ? '多报了：<b>' + extra.join('、') + '</b>（这些请求归一化之后仍然落在根目录内）。' : '');
          d += '<br>' + (fixOk ? '✅ ② 修复方向对：' +
            (f1 ? '提到了归一化（canonical）' : '') + (f2 ? '、白名单/映射' : '') + (f3 ? '、分隔符边界' : '') + '。'
            : '❌ ② 修复方案还差关键点：' +
              (f1 ? '' : '必须<b>先归一化</b>（getCanonicalPath / realpath）再比较；') +
              (f2 || f3 ? '' : '比较时要有<b>分隔符边界</b>，或者更彻底地<b>不让 Uri 参与路径拼接</b>（ID 映射白名单 / FileProvider）。'));
          return { ok: ok, detail: d };
        },
        showAnswer:
          '【预填 7 条的判定（根目录 = ' + SEC29_ROOT + '）】\n' +
          '  1  report.pdf                             → 根目录内，正常\n' +
          '  2  ../../databases/app.db                 → 越权 → /data/user/0/com.example.vulnapp/databases/app.db\n' +
          '  3  %2e%2e%2f%2e%2e%2fdatabases/app.db     → 解码后同第 2 条，越权（同一条风险的不同写法）\n' +
          '  4  subdir/../../../databases/app.db       → 越权（多一层子目录，回退次数够一样出去）\n' +
          '  5  ../shared-notes/plan.txt               → 越权 → …/files/shared-notes/plan.txt\n' +
          '       ★ 这一条专门用来暴露"归一化了但没有分隔符边界"的检查：\n' +
          '         /…/files/shared-notes 是以 /…/files/shared 开头的字符串，但没有边界就拦不住。\n' +
          '  6  //etc/hosts                            → 看着像绝对路径，其实还是相对：落点是 …/shared//etc/hosts，在根目录内\n' +
          '  7  link/leak.db                           → 越权：词法归一化看不出问题，符号链接把它带到 databases/\n' +
          '  → 真正越权：2、3、4、5、7（共 5 条）\n\n' +
          '【为什么第 6 条不越权 —— 这条比答案更值钱】\n' +
          '  new File(parent, child) 不会因为 child 以 "/" 开头就把它当绝对路径。\n' +
          '  所以"看着像绝对路径"和"实际落在哪"是两件事 —— 只有归一化之后才知道。\n\n' +
          '【修复方案（按强度递增）】\n' +
          '  ① 最低要求：先 getCanonicalPath() 归一化（它会同时解析符号链接），\n' +
          '     再判断 canonical.equals(root) || canonical.startsWith(root + File.separator)；任何异常都拒绝。\n' +
          '  ② 更稳：只用 getLastPathSegment() 取文件名，自己拼到固定目录下 —— 路径结构由你的代码决定。\n' +
          '  ③ 最彻底：不要让 Uri 参与路径拼接。Uri 当 ID 查表映射到固定文件；\n' +
          '     或改用 FileProvider，只暴露必要目录。\n\n' +
          '【动手改一改】\n' +
          '  把第 5 条改成 ../sharedX/plan.txt 再跑一次：它会被"有边界"的检查拦住 ——\n' +
          '  这能让你亲眼看到"分隔符边界"到底在拦什么。',
        hint:
          '<b>看表的时候按这三步读：</b><br>' +
          '① <b>"归一化后的真实路径"</b>那一列才有决定权 —— 它就是 open() 最终会打到的地方；' +
          '不在根目录下就是越权。<br>' +
          '② <b>"不归一化检查"</b>这一列几乎总是放行：因为 <span class="mono">..</span> 在字符串里只是普通字符。' +
          '如果你的判定只依赖这一列，你会漏掉全部越权。<br>' +
          '③ <b>"canonical 指纹"</b>那一列：同一个文件的不同写法会给出同一个指纹 —— ' +
          '这证明"按字符串比 Uri"没有出路。<br><br>' +
          '特别看两个干扰项：<span class="mono">//etc/hosts</span>（像绝对路径，其实在根目录内）和 ' +
          '<span class="mono">link/leak.db</span>（词法上看不出问题，符号链接才让它跑出去）。',
        after: T.note('ok', '✅ 实验的收获',
          '<p style="margin-bottom:0">你现在能解释一件在很多报告里被写错的事：' +
          '<b>目录遍历的根因不是"忘了过滤 .."，而是"检查与使用不是同一个对象"</b>。' +
          '这个认知可以直接迁移到别的地方——<span class="hit">任何"检查字符串、使用资源"的组合都值得怀疑：' +
          '检查 URL 却请求原串、检查文件名却按路径打开、检查域名却解析后再连接。</span></p>')
      }
    },

    /* ============================================================ 4.10 */
    {
      h: '4.10', title: '风险六：组件拒绝服务（Doze / 畸形参数）',
      html:
        '<p>"拒绝服务"在移动端不是指流量打满带宽，而是很朴素的一件事：<b>让这个 App 崩，或者卡住。</b>' +
        '对一个导出的组件来说，攻击者不需要任何权限，只要<b>发一个它没预料到的 Intent</b>。</p>' +
        '<p>要理解为什么这类缺陷这么高发，先接受一个不太舒服的事实：</p>' +
        T.note('bad', '🔥 高发的根因：取参数的地方和用参数的地方，隔着几十行',
          '<p style="margin-bottom:0">几乎没有人会"忘记校验"——他们只是<b>在校验别的东西</b>。' +
          '典型情况是：入口处校验了"用户有没有登录"、"参数是不是我期望的那个 key"，' +
          '然后把值交给下游的业务方法，而下游把它当成"一定合法"的东西：直接强转、直接 parseInt、直接当索引、直接当路径。<br>' +
          '<span class="hit">所以审计组件输入时，不要停在 <span class="mono">getXxxExtra</span> 那一行——' +
          '要顺着这个值找到"第一个转换点"。</span></p>') +

        T.tbl(['输入形态', '组件里常见的写法', '可能的结果', '为什么'],
          [
            ['缺失的 key', '<span class="mono">getStringExtra("token").trim()</span>', 'NullPointerException',
             '没发这个 extra 时返回 null。<b>空值是最廉价、最容易构造的畸形输入</b>——攻击者只要不发'],
            ['String 但不是数字', '<span class="mono">Integer.parseInt(getStringExtra("uid"))</span>', 'NumberFormatException',
             '类型对了，格式不对。校验"类型"的人多，校验"格式"的人少'],
            ['类型不符', '<span class="mono">(UserParcel) getParcelableExtra("user")</span>', 'ClassCastException',
             '强制转换失败；集合（<span class="mono">ArrayList&lt;Integer&gt;</span> 当字符串集合用）同理'],
            ['String 送进原始类型 getter', '<span class="mono">getIntExtra("uid", 0)</span>', '<b>不崩</b>，静默返回 0',
             'Bundle 内部捕获了 CCE 并返回默认值，只打一条 typeWarning。' +
             '<span class="pill warn">待核实</span> 具体日志形状与是否所有原始类型一致，按目标平台确认。<b>比崩溃更危险：后续逻辑带着错值继续跑</b>'],
            ['超大 byte[] / 长数组', '<span class="mono">getByteArrayExtra("blob")</span>', 'TransactionTooLargeException',
             'extras 要跨 Binder，事务缓冲区有上限。它可能崩在发送方、接收方或系统服务，' +
             '<span class="pill warn">待核实</span> 上限随版本/设备变化（教学里常用 1 MiB 作参照）'],
            ['超大对象 / 大量 key', '反序列化一个巨大的 Serializable / Bundle', 'OOM 或解析失败',
             '解析发生在你的进程里，内存是你的。加壳/加固环境下这条更容易触发'],
            ['伪造的 Parcelable / 不可解析结构', '<span class="mono">getParcelableExtra</span> 解析外部 Parcel', 'BadParcelableException / 解析异常',
             '<span class="pill warn">待核实</span> 异常类型与各版本的处理策略（有的版本会包装成别的异常）'],
            ['Uri 参数', '直接把外部 Uri 交给 <span class="mono">openInputStream</span> 或 WebView', '读任意内容 / 崩溃',
             'Uri 是"能力"，不是"数据"：它可能指向你没预期的位置']
          ]) +

        '<h3>怎么修：把"不信任"落实到代码结构上</h3>' +
        T.grid(2, [
          '<b>三条最短路径（成本极低）</b>' +
          '<p style="margin-bottom:0">① <b>先判空再解析</b>：缺失的 extra 一律走默认分支，不要直接调方法；<br>' +
          '② <b>用 try/catch 包住所有来自外部的解析</b>，把异常转换成"参数无效"的返回，而不是放任上抛；<br>' +
          '③ <b>组件入口处做一次"参数契约"检查</b>：类型、范围、长度上限，不合格直接 finish/return。</p>',
          '<b>一条结构性建议（更值得做）</b>' +
          '<p style="margin-bottom:0">把"来自外部的 Intent"和"内部调用"<b>在代码上分开</b>：' +
          '导出的组件只做一件事——把外部输入规范化成一个内部数据结构，交给不导出、也不接受 Intent 的业务层。<br>' +
          '<span class="hit">这样"不可信输入"的边界在代码里是可见的，而不是散落在几十个 getXxxExtra 调用点上。</span></p>'
        ]) +
        T.note('warn', '⚠️ 审计报告里的一个措辞纪律',
          '<p style="margin-bottom:0">"组件可以被外部 App 崩溃"和"组件可以被外部 App 越权读取数据"是两种不同的结论，' +
          '<b>不要合并成一句"组件存在高危"</b>。<br>' +
          'DoS 类问题的可利用性通常很高（一条命令就能复现），但影响面是"服务不可用"；' +
          '越权类问题复现门槛略高，影响面却是数据泄漏。' +
          '<span class="hit">把可利用性和影响分开写，读报告的人才能自己排优先级</span>——' +
          '这也是 4.15 那张排序表的输入。</p>'),
      lab: {
        title: '实验：畸形 Intent 参数字典（哪一行真的会崩）',
        goal: '目标：按真实规则判异常与静默失败',
        intro:
          '<p>下面 7 行是"调用方塞进去的值 × 组件里的写法"的真实组合。' +
          '其中<b>有两行看着危险其实不崩</b>——找到它们比数对总数更重要。</p>' +
          '<p><b>任务：</b>① 点「🔍 推演」看每一行的结果；② 填出会崩的行数；' +
          '③ 填出"看着危险其实不崩"的行号，并说清它为什么不崩、以及为什么它反而更麻烦。</p>',
        inputs: [
          { key: 'blobBytes', label: 'byte[] 载荷大小（字节）', hint: '第 6 行的体积，改大改小结果会变', value: '8000000' },
          { key: 'crashCount', label: '① 会崩的行数', hint: '给一个数字', ph: '例如 5', value: '' },
          { key: 'safeRow', label: '② "看着危险其实不崩"的行号', hint: '给行号（可能不止一行，用逗号分隔）', ph: '例如 1', value: '' },
          { key: 'why', label: '③ 它为什么不崩？为什么这比崩了更麻烦？', type: 'textarea', rows: 3, ph: '例如：因为……，所以……；更麻烦的地方在于……', value: '' }
        ],
        runLabel: '🔍 推演每一条',
        autorun: true,
        run: function (v) { return sec29IntentHtml(sec29IntentEval(v)); },
        expected: function (v) {
          var r = sec29IntentEval(v);
          var n = parseInt(String(v.crashCount == null ? '' : v.crashCount).replace(/[^0-9]/g, ''), 10);
          var countOk = (n === r.count);
          var safeTruth = r.traps.slice().sort(function (a, b) { return a - b; });
          var gotSafe = String(v.safeRow == null ? '' : v.safeRow).split(/[^0-9]+/)
            .filter(function (s) { return s !== ''; }).map(Number)
            .filter(function (x, i, a) { return a.indexOf(x) === i; }).sort(function (a, b) { return a - b; });
          var safeOk = safeTruth.length === gotSafe.length &&
            safeTruth.every(function (x) { return gotSafe.indexOf(x) >= 0; });
          var whyText = String(v.why == null ? '' : v.why);
          var w1 = window.AKKC_hasConcept(whyText, ['getIntExtra', '原始类型', '默认值', '返回 0', 'typewarning',
            '捕获', 'catch', 'classcastexception', '不崩', '吞掉']);
          var w2 = window.AKKC_hasConcept(whyText, ['静默', '错值', '错误的值', '继续跑', '不报错', '没有崩溃', '更难查',
            '查不出', '隐藏', '不记录', '崩溃平台', '监控', '后续逻辑']);
          var whyOk = w1 && w2;
          var ok = countOk && safeOk && whyOk;
          var d = '当前参数下，判定器算出：<b>' + r.count + '</b> / ' + r.total + ' 行会崩；' +
            '不崩的是第 <b>' + r.safe.map(function (x) { return x.id; }).join('、') + '</b> 行，' +
            '其中"看着危险其实不崩"的是第 <b>' + (safeTruth.join('、') || '（无）') + '</b> 行。<br>';
          d += countOk ? '✅ ① 行数正确。' : '❌ ① 行数不对（你填 ' + (isNaN(n) ? '空' : n) + '，实际 ' + r.count + '）。' +
            (r.overLimit ? '注意 byte[] 载荷超过了教学上限 ' + r.limit.toLocaleString() + ' 字节，第 6 行会崩。'
                         : '当前 byte[] 载荷<b>没超过</b>教学上限，第 6 行不会崩——这正是"结果跟着输入变"的地方。');
          d += '<br>' + (safeOk ? '✅ ② 找到了那一行（第 ' + safeTruth.join('、') + ' 行）。'
            : '❌ ② 应该是第 <b>' + safeTruth.join('、') + '</b> 行——' +
              '"看着危险其实不崩"专指那一条原始类型 getter 的写法（你填的是 ' + (gotSafe.join('、') || '空') + '）。' +
              '注意：不崩的行里还有一条是对照组（本来类型就匹配），它不属于"看着危险"。');
          d += '<br>' + (whyOk ? '✅ ③ 说清了"不崩"的机制与它更危险的原因。'
            : '❌ ③ 还差两个点：' + (w1 ? '' : '要说明<b>它为什么不崩</b>（原始类型 getter 捕获了类型异常并返回默认值）；') +
              (w2 ? '' : '以及<b>为什么这比崩溃更麻烦</b>（静默拿到错值、后续逻辑继续跑、监控里看不到）。'));
          return { ok: ok, detail: d };
        },
        showAnswer:
          '【7 行的判定】\n' +
          '  1  String 送进 getIntExtra("uid", 0)          → 不崩（返回默认值 0 + typeWarning）★看着危险其实不崩\n' +
          '  2  String "abc" 送进 Integer.parseInt          → NumberFormatException（崩）\n' +
          '  3  缺 key 时 getStringExtra("token").length() → NullPointerException（崩）\n' +
          '  4  String 强转成 Parcelable                   → ClassCastException（崩）\n' +
          '  5  int 42 送进 getIntExtra("uid", 0)          → 正常（对照组，不崩）\n' +
          '  6  byte[]（默认 8,000,000 字节）送进 getByteArrayExtra → 超过教学上限 1 MiB → TransactionTooLargeException（崩）\n' +
          '  7  ArrayList<Integer> 当字符串集合取          → ClassCastException（崩）\n' +
          '  → 会崩：2、3、4、6、7 共 5 行；不崩：1、5\n' +
          '  → 「看着危险其实不崩」的是第 1 行（第 5 行本来就正常，不属于"看着危险"）\n\n' +
          '【第 1 行为什么最值得讲】\n' +
          '  它不崩，是因为 Bundle 的原始类型 getter 内部捕获了 ClassCastException 并返回默认值。\n' +
          '  但结果是 uid 变成了 0，业务逻辑带着一个错值继续往下跑：\n' +
          '  · 崩溃平台里没有记录 → 你根本不知道有人这样打过你的组件；\n' +
          '  · 错值可能被当成"合法输入"使用（uid=0 的越权查询、金额=0 的订单）；\n' +
          '  · 排查时最难的方向就是"没有异常、数据不对"。\n' +
          '  → 结论：静默失败往往比显式崩溃更需要优先修，因为它剥夺了你发现问题的能力。\n\n' +
          '【动手改一改】\n' +
          '  把 byte[] 载荷改成 500000 → 第 6 行变成"不崩"，会崩行数变成 4。\n' +
          '  这就是"阈值型缺陷"的特点：它的严重程度依赖运行时参数，不是一个固定的标签。',
        hint:
          '<b>先分两类，再逐行判：</b><br>' +
          '① <b>内容/类型类</b>：缺 key → null；格式不符 → parseInt 抛异常；类型不符 → 强转抛 CCE。<br>' +
          '② <b>体积类</b>：只有第 6 行属于这一类，而且它的结果<b>取决于你填的字节数</b>——' +
          '先想想"Intent 的 extras 是怎么传到另一个进程的"，再想想那条通道有没有上限。<br><br>' +
          '最容易判错的是第 1 行：<span class="mono">getIntExtra</span> 遇到字符串会怎样？' +
          '如果它会崩，那这个 API 在真实世界里早就被骂爆了——所以它一定是<b>不崩</b>的。那代价是什么？',
        after: T.note('ok', '✅ 实验的收获',
          '<p style="margin-bottom:0">你刚学到的不是几个异常类名，而是一条审计动作：' +
          '<b>对每一个外部输入，问"如果它是 null / 类型不对 / 太大 / 是别的子类，会发生什么"</b>。' +
          '这四个问题问完，绝大多数组件级崩溃都能提前发现。<br>' +
          '<span class="hit">进一步：把"不崩"也当成一种失败来审——静默的错误值往往比抛异常更贵。</span></p>')
      },
      quiz: {
        id: 'q29-5', chapter: 29, answer: 2,
        stem: '一个导出的 Activity 在 <span class="mono">onCreate</span> 里写：' +
              '<span class="mono">int uid = getIntent().getIntExtra("uid", 0);</span>，然后直接用 uid 去查数据。' +
              '外部 App 传了一个字符串 <span class="mono">"abc"</span> 给这个 extra。结果是什么？',
        options: [
          { t: '抛 ClassCastException，App 崩溃', why: '这是对 API 行为的常见误判。原始类型的 getter 并不会把类型错误暴露成异常。' },
          { t: '抛 IllegalArgumentException，参数被拒绝', why: '这类 getter 不做参数合法性判定，也不会抛出这个异常。' },
          { t: '不崩，uid 得到默认值 0，业务逻辑带着错的值继续执行', why: '✅ 正确。原始类型 getter 内部会捕获类型异常、打一条 typeWarning、返回默认值。危害在于"静默"：监控里看不到，但可能已经查了 uid=0 的数据。' },
          { t: '抛出 SecurityException，因为调用方没有权限', why: '权限判定发生在 AMS 层（组件是否导出、调用方是否有权限），与参数类型无关。' }
        ],
        explain: '这一题的价值在于<b>纠正一个直觉</b>：很多人以为"类型不对 → 崩"，于是把"不崩"当成安全信号。' +
          '实际上原始类型 getter 的行为是"容错返回默认值"。<br>' +
          '这类"<b>看着会崩其实不崩</b>"的地方，在审计里要单独成项，因为它的危害形态不同：' +
          '崩溃是可观测的、会被上报的；错值是静默的、可能被当成合法输入使用。' +
          '<span class="hit">同一个缺陷，若换成 <span class="mono">Integer.parseInt(getStringExtra("uid"))</span>，' +
          '就一定会崩——所以审计必须看"值被怎么用"，而不是只看"值怎么取的"。</span>'
      }
    },
    /* ============================================================ 4.11 */
    {
      h: '4.11', title: '风险七：BroadcastReceiver 导出',
      html:
        '<p>广播（Broadcast）是四大组件里最容易被轻视的一个：它不返回数据、界面看不见、' +
        '很多开发者觉得"无非是收个通知"。这恰好是它危险的原因——' +
        '<b>广播的语义是"谁都能发"，而很多人把"能收到"理解成了"只有我能发"。</b></p>' +

        '<h3>先分清两件完全不同的事：动态注册 vs 静态注册</h3>' +
        T.tbl(['', '动态注册（代码里 registerReceiver）', '静态注册（清单里 &lt;receiver&gt;）'],
          [
            ['<b>生效时机</b>', '只有注册之后、且进程活着的时候才收得到', '进程没起来也能被系统唤起（这是它的价值）'],
            ['<b>导出的默认值</b>', '<b>取决于调用哪个重载</b>：新版 API 上有必须显式指定导出标志的重载' +
             '（<span class="mono">RECEIVER_EXPORTED</span> / <span class="mono">RECEIVER_NOT_EXPORTED</span> 一类）；' +
             '旧写法没有这个标志，语义上更接近"可被外部发送"', '和 Activity/Service 一样的规则：有 intent-filter 默认导出'],
            ['<b>谁能发给你</b>', '同一进程内的 <span class="mono">sendBroadcast</span>；' +
             '如果注册时可被外部命中，则其他 App 也能发', '<b>任何 App 只要知道 action 就能发</b>'],
            ['<b>典型风险</b>', '被外部伪造成"内部事件"（比如"已登录"、"支付成功"）', '进程被反复唤起 + 被伪造广播触发内部动作'],
            ['<b>审计要点</b>', '看注册时有没有限制发送方（权限 / 是否限定包名 / 是否用进程内机制）', '看清单里的 exported 与 intent-filter'],
          ]) +
        T.note('bad', '🔥 最典型的缺陷形状：把广播当成"内部信号"',
          '<p style="margin-bottom:0">代码里写着 <span class="mono">if ("com.example.vulnapp.ACTION_LOGIN_OK".equals(intent.getAction())) { ... 设置登录态 ... }</span>，' +
          '开发者脑子里想的是"我自己的登录模块会发这个广播"。<br>' +
          '但广播是<b>公开信道</b>：任何 App 都能构造一个 action 相同的 Intent 发出去。' +
          '<span class="hit">于是"内部信号"变成了"外部可以按下的按钮"</span>——' +
          '如果那个分支里做的事是"标记已登录"、"解锁某功能"、"触发同步"，它就是一个完整的越权路径。</p>') +

        '<h3>三个层次的处理办法，按可靠性排</h3>' +
        T.grid(2, [
          '<b>① 进程内通信：不经过系统（最可靠）</b>' +
          '<p style="margin-bottom:0">如果收发双方都在同一个进程里，就不要用系统广播。' +
          '<span class="mono">LocalBroadcastManager</span> 是历史上最常见的选择，它的广播<b>根本不经过系统</b>，' +
          '其他 App 无法发送也无法接收。<br>' +
          '<span class="pill warn">待核实</span> 该类的维护状态与新项目推荐方案（官方文档已标注为可选/替代方案，' +
          '新版建议考虑其它进程内通信方式）；<b>不确定的是"推荐用什么替代"，不确定的不是"进程内比系统广播安全"。</b></p>',
          '<b>② 必须用系统广播时：把"谁能发"写死</b>' +
          '<p style="margin-bottom:0">· 注册时用能<b>指定权限</b>或<b>限定包名</b>的参数（让系统替你做发送方过滤）；<br>' +
          '· 或者对广播里的内容<b>做签名/一次性令牌校验</b>（内容可伪造，签名不可伪造）；<br>' +
          '· 静态注册的 Receiver 一律显式写 <span class="mono">android:exported="false"</span>，' +
          '并确认确实没有 intent-filter（有 filter 时这两者会冲突）。</p>'
        ]) +
        T.note('warn', '⚠️ 两个容易写错的地方',
          '<p style="margin-bottom:0">' +
          '<b>一、有序广播的 <span class="mono">abortBroadcast()</span>。</b>' +
          '有序广播会按优先级依次投递，任何一环都可以 <span class="mono">abortBroadcast()</span> 掉它，后面的接收者就收不到了。' +
          '如果一条有序广播链上<b>混进了外部 App 的 Receiver</b>（优先级还比你高），它就能"掐断"你的业务广播。' +
          '所以审计有序广播时，除了看自己，还要看<b>谁能插进这条链</b>。<br><br>' +
          '<b>二、动态注册的 Receiver 泄漏。</b>' +
          '<span class="mono">registerReceiver</span> 之后忘了 <span class="mono">unregisterReceiver</span>，' +
          '在 Activity 销毁后仍然持有它——这不只是内存泄漏：<b>一个"本该已经下线"的接收者还在接收外部广播</b>。' +
          '审计时的检查点很机械：每一个 register，找它配对的 unregister 在哪个生命周期回调里。<br><br>' +
          '<b>三、新版本收紧了动态注册。</b>近年的 Android 版本要求（对目标版本 ≥ 34 的应用）在为<b>非系统广播</b>注册 Receiver 时' +
          '显式表明导出意图（<span class="mono">RECEIVER_EXPORTED</span> / <span class="mono">RECEIVER_NOT_EXPORTED</span>），' +
          '否则直接抛异常。<span class="pill warn">待核实</span> <b>不确定点</b>：确切的版本边界、' +
          '"系统广播"的豁免范围、以及旧代码在新系统上被豁免还是被拦。<b>这条提醒的意义是：注册时必须显式表态，别依赖默认。</b></p>'),
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一',
            scenario: '<b>情境：</b>你审出一个 App 里有这样一段代码：<br>' +
                      '<span class="mono">registerReceiver(new Receiver() { onReceive(...) { if (ACTION_SYNC.equals(intent.getAction())) doSync(); } }, new IntentFilter(ACTION_SYNC));</span><br>' +
                      '开发者说："这个 action 是我们自己定义的长字符串，别人猜不到，而且同步一下又没有什么危害。"',
            q: '你怎么评估？',
            choices: [
              { t: '低危：action 名是自定义的长字符串，外部猜不到；而且同步本身无害', next: 'n1' },
              { t: '需要看这个 doSync 做什么，以及 action 名是否出现在反编译产物里——但"猜不到"从来不是判据', next: 'n2' },
              { t: '高危：所有广播都应该改成 LocalBroadcastManager', next: 'n3' },
              { t: '无法判断：动态注册的行为依赖运行时状态，静态看不出来', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'bad',
            verdictTitle: '把"字符串长度"当成了访问控制',
            result: '<b>action 名不是秘密。</b>它就写在你自己的 APK 里——任何人反编译一下（甚至只用 ' +
              '<span class="mono">aapt dump</span> / <span class="mono">strings</span>）就能读到它。' +
              '<span class="hit">"别人猜不到"这类判断，在客户端代码里一次都不成立</span>：' +
              '客户端的一切都是可读的，只要它出现在你的产物里。<br><br>' +
              '而"同步一下没有危害"这个判断也需要证据：同步会不会<b>覆盖本地数据</b>？' +
              '会不会带着服务端下发的指令？会不会触发网络请求（被反复触发就是一种放大攻击）？' +
              '这些都不是靠"它叫 sync"能推出来的。<br><br>' +
              '<b>认知根源：</b>把"安全的隐蔽性"（security by obscurity）当成了安全边界。' +
              '隐蔽可以作为<b>额外一层</b>降低被发现的概率，但绝不能作为<b>唯一一层</b>。'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'good',
            verdictTitle: '正确：先把"猜不到"这个伪判据丢掉，再去看真实后果',
            result: '<b>这是可辩护的评估路径。</b>两个动作：<br>' +
              '① <b>确认 action 名可被读到</b>：在反编译产物或资源里搜它。能搜到 → "猜不到"这个理由作废，' +
              '这个 Receiver 就是外部可达的。<br>' +
              '② <b>看 <span class="mono">doSync()</span> 做什么</b>：读外部输入？写本地数据？发起网络请求？' +
              '触发上传？——它决定了这条风险的<b>影响</b>，也就是等级。<br><br>' +
              '把这两条合起来才能给结论：外部可达 + 有实际副作用 = 真风险；外部可达 + 只更新一个内存标志 = 低危但仍应改。' +
              '<span class="hit">"外部可达"回答可利用性，"doSync 做什么"回答影响——两者缺一不可。</span><br><br>' +
              '<b>为什么这条路径比选 A 好：</b>它不依赖任何对攻击者能力的猜测，只依赖可验证的事实（能不能搜到、代码做了什么）。' +
              '这正是评审和"觉得"之间的分界线。'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '结论太满：跨进程广播有时是必需的',
            result: '<span class="mono">LocalBroadcastManager</span> 确实更安全，但<b>"所有广播都该改"</b>这个结论会撞上现实需求：<br>' +
              '· 需要<b>跨进程</b>通知（比如你的另一个 App、或一个独立进程的推送服务）；<br>' +
              '· 需要<b>进程未启动时被唤起</b>（静态注册的正当用途）；<br>' +
              '· 需要接入系统事件（开机完成、网络变化、时间变更）。<br><br>' +
              '这些场景用进程内机制实现不了。正确的说法是：<b>「同进程内的广播优先用进程内机制；必须用系统广播时，' +
              '要把发送方限制写死」</b>——而不是一句"全部改掉"。<br><br>' +
              '<b>认知根源：</b>把一个正确方向推广成了绝对规则。评审意见如果不可执行，开发就会整体忽略它——' +
              '<span class="hit">一个"全都改"的结论，实际效果常常等于"一个都不改"。</span>'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '用"运行时相关"回避了静态就能定的部分',
            result: '这段代码里有一半的事实是<b>纯静态可判</b>的：<br>' +
              '· 它注册了哪个 action（字面量就在代码里）；<br>' +
              '· 这个 action 能不能在产物里被搜到（搜一下就知道）；<br>' +
              '· 它调用的是哪个方法（<span class="mono">doSync()</span> 的实现就在那里）。<br><br>' +
              '真正需要运行时确认的只有一件事：<b>注册发生的时机与 unregister 是否配套</b>（这决定窗口期）。' +
              '把所有内容都推给"运行时"会让你的报告失去可执行性。<br><br>' +
              '正确写法是<b>分层结论</b>："该 Receiver 的 action 可从产物中读取，' +
              '外部 App 可构造同 action 广播；<span class="mono">doSync()</span> 会发起网络同步，' +
              '因此外部可反复触发（判中危；若同步会覆盖本地数据则升为高危）。注册时机与注销逻辑需运行时确认。"'
          }
        }
      },
      quiz: {
        id: 'q29-6', chapter: 29, answer: 1,
        stem: '关于"导出的 BroadcastReceiver 被伪造广播触发"，下面哪个判据是<b>站得住脚</b>的？',
        options: [
          { t: 'action 字符串是自定义的长随机串，外部 App 猜不到，所以不可触发', why: 'action 名写在你的 APK 里，反编译或 strings 一下就能读到。"猜不到"在客户端代码上不成立。' },
          { t: 'action 名可以从你的产物里被读到，因此"外部可发送"这一条成立；再根据收到广播后做的事情来定等级', why: '✅ 正确。可利用性用"能不能读到 action"判定（可验证），影响用"收到之后做什么"判定（可读代码）。两条合起来才是结论。' },
          { t: '只要用了 LocalBroadcastManager 就没有这个问题，所以任何广播都该改用它', why: '方向对但结论太满：跨进程通知、进程未启动时被唤起、接入系统事件这些场景用不了进程内机制。' },
          { t: '动态注册的 Receiver 只能收到本进程发的广播，所以不存在伪造问题', why: '动态注册的 Receiver 同样可能被外部广播命中（取决于注册时是否限定了发送方）。' }
        ],
        explain: '这一题的考点是<b>"不可猜测性"什么时候能当判据</b>。答案很干脆：' +
          '在客户端代码里<b>永远不能</b>——因为它必须存在于产物中，而产物在攻击者手上。<br>' +
          '同样的道理适用于"接口路径是自定义的"、"参数名带了一个随机后缀"、"请求头里有个魔法值"这些自我安慰式的防护。' +
          '<span class="hit">判据必须建立在"攻击者能观测到什么"之上，而不是"他猜不到什么"。</span>'
      }
    },

    /* ============================================================ 4.12 */
    {
      h: '4.12', title: '审计工具（一）：Drozer',
      html:
        '<p>前面几节讲的复现都要手写 <span class="mono">adb</span> 命令。Drozer 把这些动作<b>系统化</b>了，' +
        '而且它做了一件 <span class="mono">adb</span> 做不到的事：</p>' +
        T.note('key', '🔑 Drozer 的核心价值：它自己就是一个 App',
          '<p style="margin-bottom:0"><span class="mono">adb shell am start</span> 是以 <b>shell 用户（uid 2000）</b>的身份发起的；' +
          '而 Drozer 用一个<b>真实的、已安装的 App</b> 作为代理去调用你的组件。<br>' +
          '这两者的差别在真实评估里很关键：<b>权限判定、UID 比对、导出判定，全都要看调用方的身份</b>。' +
          '<span class="hit">用 shell 试"不成功"，不等于"其他 App 也进不去"</span>——' +
          '反过来也一样：有些组件对 shell 开放、对其他 App 反而受限。' +
          '所以要判断"一个普通第三方 App 能不能碰到我的组件"，就得用一个普通第三方 App 去碰。</p>') +

        '<h3>它能做到什么</h3>' +
        T.tbl(['能力', '说明', '对应本章哪一节'],
          [
            ['枚举攻击面', '把一个包里所有导出的组件（Activity / Service / Receiver / Provider）列出来，并标注可交互性',
             '4.1 / 4.3：这是"攻击面清单"的自动化版本'],
            ['实际调用组件', '以 App 身份启动 Activity、发广播、启动 Service、查询/读写 Provider',
             '4.6 / 4.8 / 4.11：把"应该能调"变成"确实调到了"'],
            ['扫描 Provider', '枚举 content URI、可读写的路径、疑似目录遍历、SQL 注入点',
             '4.8 / 4.9：实验里手工推的路径规则，这里是自动化探测'],
            ['模块化扩展', '攻击面、扫描器、信息收集、工具类模块可分门别类地跑；可以自己写模块',
             '把本章的判定规则固化成可重复执行的脚本'],
            ['获取运行时事实', '读取当前进程/包的实际状态（不是读清单猜），比如实际生效的权限配置',
             '4.6：静态清单与动态事实的交叉验证']
          ]) +
        T.note('warn', '⚠️ 安装与版本必须自己核实（这一节最容易过期）',
          '<p style="margin-bottom:0">Drozer 的生态这些年变动过几次：换过维护方、有过 2.x / 3.x 的差异、' +
          '装法在"控制台 + agent APK"与"Python 包 / 容器镜像"之间变化过，模块名和参数也随版本调整。' +
          '<br><span class="pill warn">待核实</span> <b>具体不确定的是什么</b>：' +
          '① 当前是谁在维护、最新发布形态（源码 / wheel / 镜像）；② 支持的 Python 版本；' +
          '③ 官方发布的 agent APK 与主机端控制台是否仍配套；④ 模块名与命令语法（<span class="mono">scanner.provider.*</span> 一类）在当前版本里的实际名称。' +
          '<br><br><span class="hit">正确做法：以官方仓库的 Releases / README 为准，别照抄任何一篇博客里的版本号和命令。</span>' +
          '下面终端里的命令是<b>形状示意</b>，不是可以直接复制的清单。</p>') +
        '<p>还有一条纪律：<b>Drozer 需要把它的 agent 装到你的设备上，并让它以 App 身份运行。</b>' +
        '这个动作只应该发生在你自己的测试设备或明确授权的评估环境里。</p>',
      term: {
        title: 'Drozer 会话形状（示意，命令与模块名以你的版本为准）',
        lines: [
          { t: 'p', s: 'drozer console connect', note: '<b>连接控制台</b>：这里只是形状示意，不同版本的连接方式不同（有的是先 adb forward 再连本地端口，有的是容器里执行）。<span class="pill warn">待核实</span> 以官方文档为准。' },
          { t: 'o', s: 'Selecting <device-id>  (drozer agent running)', note: '看到 agent 已在设备上运行，说明"以 App 身份调用"这条路通了——这是 Drozer 相对 adb 的全部意义所在。' },
          { t: 'p', s: 'run app.package.list -f vulnapp', note: '先找到包名。审计自己的 App 时这一步用来确认多 flavor / 多渠道的包名后缀。' },
          { t: 'o', s: 'com.example.vulnapp (Vuln Demo)', note: '' },
          { t: 'p', s: 'run app.package.attacksurface com.example.vulnapp', note: '<b>核心命令：枚举攻击面。</b>它会列出导出的 Activity / Service / Receiver / Provider 的数量与名字——这就是 4.3 实验里你手工推的那张表。' },
          { t: 'o', s: '3 activities exported\n1 broadcast receivers exported\n2 content providers exported\n1 services exported', note: '<b>先看数字，再看清单。</b>数字本身就是可交付的结论："这个包对外暴露了 3 个 Activity、2 个 Provider…"——比"存在组件导出风险"具体得多。' },
          { t: 'p', s: 'run app.activity.info -a com.example.vulnapp', note: '把导出的 Activity 逐个列出来（含权限信息）。这一步的产出直接对应 4.6 的判定。' },
          { t: 'o', s: 'com.example.vulnapp.admin.AdminPanelActivity\n  Permission: com.example.vulnapp.permission.ADMIN\n  Exported: true', note: '<b>注意 Drozer 会把权限名一起列出来。</b>但"保护强度"它不会替你判断——' +
              'protectionLevel 是 normal 还是 signature，要你回到清单（或 <span class="mono">dumpsys</span>）去核实。<span class="hit">工具给事实，强度判断是你的工作。</span>' },
          { t: 'p', s: 'run scanner.provider.finduris -a com.example.vulnapp', note: '枚举可访问的 content URI。这一步能发现"文档里没写、但代码里注册了"的 Provider 入口。' },
          { t: 'o', s: 'Unable to find any content providers for com.example.vulnapp', note: '<b>注意这条"什么都没找到"。</b>它可能是真的没有可访问的 Provider，也可能是模块没跑通、URI 枚举方式不匹配、或目标被加固/反调试挡住。' +
              '<span class="hit">把它当"未发现"，不要当"不存在"</span>——这是 4.13 决策演练的题眼。' },
          { t: 'p', s: 'run scanner.provider.traversal -a com.example.vulnapp', note: '目录遍历扫描：它会用一批 <span class="mono">../</span> 变体去试你的 Provider。' +
              '<b>这正是 4.9 实验手工做的事</b>——区别是 Drozer 会在真实运行时上打这批请求。' },
          { t: 'w', s: '(若报告某路径可读且返回内容)：确认返回的是预期目录之外的文件 → 目录遍历成立', note: '自动化扫描的结论也要人工确认：拿到"疑似"之后，用返回内容判断它是真的读到了目录外，还是工具把"路径存在"误判成了"路径可越权"。' },
          { t: 'p', s: 'run app.broadcast.info -a com.example.vulnapp', note: '列出导出/可接收的广播。对应 4.11：哪些 Receiver 能被外部伪造广播命中。' },
          { t: 'p', s: 'run app.activity.start --component com.example.vulnapp com.example.vulnapp.admin.AdminPanelActivity --extra string uid 1', note: '<b>真正调用它。</b>形状是"组件 + 附加参数"，具体参数写法随版本变化（<span class="pill warn">待核实</span>）。' },
          { t: 'd', s: '结论：AdminPanelActivity 导出（权限 ADMIN 级别待核实）且可被 App 身份启动 → 高危候选；Provider 扫描未发现可访问 URI → 记为"未发现"而非"不存在"。', note: '<b>把"已证实"和"未发现"分开写。</b>这条结论既可以被复现，也标明了它的边界——这才是能交给别人的审计结论。' }
        ]
      }
    },

    /* ============================================================ 4.13 */
    {
      h: '4.13', title: '审计工具（二）：MobSF',
      html:
        '<p>如果说 Drozer 是"<b>动态的一把手术刀</b>"，MobSF 就是"<b>进门先拍一张全身 X 光</b>"。' +
        '它把 APK 拆开，把静态面上所有值得看一眼的东西摊在一份报告里。</p>' +
        '<p>它的最大价值不是"发现问题"，而是<b>把 20 分钟的翻文件时间压缩到 2 分钟</b>，' +
        '让你能把省下的时间用在真正需要判断的地方（4.14 的第 4 步）。</p>' +

        '<h3>它能给你的（静态分析面）</h3>' +
        T.tbl(['报告里的板块', '它实际在说什么', '怎么用'],
          [
            ['<b>Manifest 分析 / 组件与权限</b>', '导出的组件、<span class="mono">allowBackup</span>、' +
             '<span class="mono">debuggable</span>、<span class="mono">usesCleartextTraffic</span>、权限清单',
             '直接对账 4.3 实验那张表；但<b>保护强度（protectionLevel）要你自己判</b>'],
            ['<b>硬编码密钥 / 字符串</b>', '在 dex / 资源 / so 里命中常见密钥形态（云服务 key、SDK key、疑似口令）',
             '每一条都要人工确认"它是不是真的密钥、泄漏之后能做什么"——误报率不低'],
            ['<b>API 与调用面</b>', '使用了哪些敏感 API（文件、加密、网络、反射、动态加载）',
             '用来快速定位"哪里可能出问题"，然后去读那段代码'],
            ['<b>第三方 SDK / 库清单</b>', '识别出的第三方组件与版本',
             '<b>很实用</b>：第三方 SDK 自带的导出组件、明文流量、旧版本漏洞都从这里入手'],
            ['<b>证书与签名信息</b>', '签名算法、证书信息', '对比不同版本 / 不同渠道的签名是否被换过'],
            ['<b>文件与资源结构</b>', 'dex 数量、assets 里的可疑文件、native 库清单',
             '和 4.4 的重打包判定衔接：改动过的产物在这里会有异常'],
          ]) +
        T.note('bad', '🔥 它给不出的东西（这一节真正要记的部分）',
          '<p style="margin-bottom:0">' +
          '① <b>真正的业务逻辑缺陷</b>——"这个接口只要传别人的 uid 就能查到别人的订单"这类问题，' +
          '静态扫描器读不出来，因为它需要理解你的业务语义；<br>' +
          '② <b>运行时行为</b>——组件被拉起之后会发生什么、WebView 实际加载了什么、' +
          '加密是在哪一层做的、有没有反调试在拦你；<br>' +
          '③ <b>可利用性</b>——它标"导出组件"是一个事实，但"能不能真的调到、调了能干什么"要靠动态验证；<br>' +
          '④ <b>服务端的问题</b>——它只看客户端，而后端不校验恰恰是最常见的越权来源。<br><br>' +
          '<span class="hit">一句话：MobSF 给你候选清单，结论仍然要你自己下。</span>' +
          '把报告原文当成审计结论交出去，是这一节最想拦住的错误。</p>') +
        '<h3>起服务（命令来自官方 README，已核对）</h3>' +
        T.code(
          '# 官方 README 的 Quick setup with docker\n' +
          'docker pull opensecurity/mobile-security-framework-mobsf:latest\n' +
          'docker run -it --rm -p 8000:8000 opensecurity/mobile-security-framework-mobsf:latest\n' +
          '\n' +
          '# 默认用户名 / 密码：mobsf / mobsf'
        ) +
        '<p>起来之后浏览器打开 <span class="mono">http://localhost:8000</span>，上传 APK，等报告生成。' +
        'README 里同时强调了它的 REST API 与 CLI 能力——这意味着<b>它可以接进 CI</b>：' +
        '每次构建自动跑一次静态扫描，把"新引入的导出组件/新出现的硬编码字符串"当成构建产物的一部分来对比。' +
        '<span class="pill warn">待核实</span> API/CLI 的具体调用形态与鉴权方式随版本变化，接 CI 前请以你所用版本的文档为准。</p>' +
        '<p><b>动态分析</b>部分 README 也提到了（需要可配合的 Android 环境 / iOS 环境）：' +
        '它提供交互式插桩、运行时数据与网络流量观察。本文不展开，因为它的前置条件（设备、证书、代理）' +
        '在第 12、5 章有更完整的铺垫，而且这一层的信息量在真实评审里通常靠 Drozer + 手工验证补齐。</p>',
      case: {
        source: 'github',
        title: 'Mobile Security Framework (MobSF) —— 移动应用安全研究平台（APK / IPA / APPX + 源码）',
        author: 'MobSF 开源项目（README 的署名区为 Collaborators 名单）',
        target: 'MobSF（官方 Docker 镜像 opensecurity/mobile-security-framework-mobsf:latest）',
        background:
          '<p>README 原文的自我定位：它是一个面向 Android / iOS / Windows Mobile 应用的<b>安全研究平台</b>，' +
          '用途包括移动应用安全、渗透测试、恶意软件分析和隐私分析。' +
          '静态分析器支持 APK / IPA / APPX 与源码；动态分析器支持 Android 与 iOS，' +
          '提供交互式插桩、运行时数据与网络流量分析。README 同时强调它能通过 REST API 和 CLI ' +
          '接进 DevSecOps / CI-CD 流程。</p>',
        points: [
          '<b>静态分析（Android）</b>：把 Manifest、权限、组件、硬编码字符串、API 使用面、第三方库摊成报告——' +
          '本章 4.3 / 4.5 手工做的事，它一次跑完',
          '<b>动态分析（Android / iOS）</b>：交互式插桩 + 运行时数据 + 网络流量（需要配套设备环境）',
          '<b>官方 Docker 起法</b>：<span class="mono">docker pull / docker run -p 8000:8000 opensecurity/mobile-security-framework-mobsf:latest</span>，' +
          '默认账号 <span class="mono">mobsf/mobsf</span>（以上两条来自 README 原文，已核对）',
          '<b>可编程</b>：REST API + CLI，所以它能成为流水线的一环，而不只是"某次人工评估用的工具"'
        ],
        method: [
          '按 README 的 quick setup 用 Docker 拉起服务（两条命令 + 默认账号），浏览器打开本地 8000 端口',
          '上传目标 APK，等静态报告生成',
          '按本章 4.14 的顺序读报告：先看 Manifest / 组件，再看待确认的硬编码字符串，再看第三方 SDK',
          '把报告里每一条"可疑"重新过一遍可利用性判断（能不能被外部触发、触发后影响什么）',
          '需要运行时结论的部分，切到动态分析或 Drozer（4.12）——静态报告不能替代这一步',
          '如果要接 CI：用 README 提到的 REST API / CLI，把"两次构建之间的新增风险项"做成门禁'
        ],
        result:
          '<p>一次上传就能得到本课 4.14 清单里第 2、3 步的全部输入：导出组件清单、' +
          '<span class="mono">allowBackup</span> / <span class="mono">debuggable</span> / 明文流量配置、' +
          '硬编码字符串候选、权限清单、第三方 SDK 清单。省下的时间是实打实的——但它交给你的是<b>候选</b>。</p>',
        terms: ['静态分析', '硬编码密钥', 'Manifest 风险项', 'Docker', 'DevSecOps', 'REST API'],
        limits:
          '<p>README 里<b>没有</b>给出误报率、覆盖率或"能查出哪类漏洞"的边界说明——' +
          '它把自身定位成 platform（平台）而不是审计结论的替代品。' +
          '本文下列判断来自阅读 README 与本章方法论，<b>不是作者原话</b>：' +
          '它给不出业务逻辑缺陷、给不出运行时行为、给不出可利用性结论，也看不到服务端。<br>' +
          '<span class="pill warn">待核实</span> 本文引用的 Docker 两条命令与默认账号取自 README 的 ' +
          'Quick setup 段落；<b>镜像标签、端口、默认凭据都可能随版本调整</b>，使用前请以官方 README / 文档为准。</p>',
        analysis:
          '<p><b>用本课方法论拆解：</b>MobSF 精确覆盖了 4.14 清单的<b>第 2 步（静态扫敏感面）</b>，' +
          '部分覆盖<b>第 1 步（组件/权限清单）</b>——但它在第 1 步留下了一个必须由人补的缺口：' +
          '<b>它会告诉你"这个组件导出了，且挂着权限"，但不会告诉你"那个权限的 protectionLevel 是 normal 还是 signature"</b>。' +
          '而本章 4.3 的实验已经证明：这一字之差决定了它是高危还是可接受。</p>' +
          '<p>它在<b>第 4 步（动态验证）</b>上是空的——这正是 4.12 用 Drozer 补的位置。' +
          '所以这两款工具在本章的方法论里不是"二选一"，而是<b>一条流水线的两段</b>：' +
          'MobSF 负责把静态面摊开、Drozer 负责把"外部能不能真的碰到"这件事坐实。</p>' +
          '<p>最值得带走的一条：<span class="hit">工具的产出是候选清单，报告的可信度取决于你对每一条做的' +
          '可利用性判断——这也是 4.15 排序表的唯一输入。</span></p>',
        link: 'https://github.com/MobSF/Mobile-Security-Framework-MobSF',
        linkNote: '正文可读性验证：用 Node fetch 取 raw README（11997 字节，HTTP 200），' +
          '并逐行核对了 Docker 命令与默认账号所在行'
      },
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            label: '情境一',
            scenario: '<b>情境：</b>周一你接到一个 App 的评审任务。MobSF 跑完，报告里 20 条"高危"：' +
                      '包括"应用可备份"、"检测到调试标志"、"存在导出的 Provider"、"疑似硬编码密钥"……' +
                      '同一时间 Drozer 跑了一遍组件扫描，<b>一条组件问题都没报</b>。' +
                      '周五要交结论。',
            q: '你先做什么？',
            choices: [
              { t: '先把 20 条高危整理进报告，把 Drozer 的结果写成"未发现组件安全风险"', next: 'n1' },
              { t: '先把 20 条按"可利用性"分三类，再针对导出组件手工复现一次，最后把 Drozer 的结论改写成"未发现"并注明覆盖范围', next: 'n2' },
              { t: '先修最贵的那个（重写 Provider 的 openFile），反正早晚要修', next: 'n3' },
              { t: 'Drozer 没扫到说明组件确实没问题，重点转向那 20 条静态项', next: 'n4' }
            ]
          },
          n1: {
            label: '选A', terminal: true, verdict: 'bad',
            verdictTitle: '把工具的措辞直接抄进了交付物',
            result: '<b>两个措辞问题，都是评审里的硬伤。</b><br><br>' +
              '① <b>"20 条高危"直接交出去</b>：其中至少一半是"可疑但不是可利用"。' +
              '把所有项都标高危，读报告的人无法判断该先修哪个——<span class="hit">等于把排序工作退回了需求方</span>，' +
              '而他们没有你的上下文。<br>' +
              '② <b>"未发现组件安全风险"</b>：这是把工具的沉默当成了结论。' +
              'Drozer 没报可能是真的没有，也可能是模块没跑通、目标被加固挡住、或你用的命令没覆盖到那类组件。' +
              '<b>报告里必须写"未发现"而不是"不存在"，并写明覆盖范围</b>。<br><br>' +
              '<b>认知根源：</b>把工具的原始输出当成了自己的结论。评审的价值恰恰在于"从工具输出到结论"这一段加工。'
          },
          n2: {
            label: '选B', terminal: true, verdict: 'good',
            verdictTitle: '正确：分类 → 验证 → 明确边界',
            result: '<b>这是可交付的顺序。</b>三步各自解决一个问题：<br>' +
              '① <b>分类</b>把"20 条候选"变成"5 条真需要修 + 8 条降级 + 7 条顺手改"。' +
              '分类依据只有一个：<b>能不能被外部（不需要 root、不需要特殊权限的普通 App）触发</b>。<br>' +
              '② <b>手工复现导出组件</b>：用 <span class="mono">am start</span> / <span class="mono">content query</span> / ' +
              '以 App 身份调用，把"应该能调"变成"确实调到了"。这一步同时验证 Drozer 的结果——' +
              '如果手工能调到而 Drozer 没报，你就发现了一个<b>工具盲区</b>，这本身是很有价值的结论。<br>' +
              '③ <b>把 Drozer 的结论写清楚</b>："未发现" + 覆盖范围（跑了哪些模块、什么版本、目标是否加固）+ 已知盲区。<br><br>' +
              '<span class="hit">这三个动作的顺序不可颠倒：先分类才知道要验证什么，先验证才能对工具的结论下判断。</span>'
          },
          n3: {
            label: '选C', terminal: true, verdict: 'bad',
            verdictTitle: '先挑最贵的修，是拿成本而不是风险做排序',
            result: '<b>"早晚要修"不是排序依据。</b>把最贵的先修，会带来三个现实问题：<br>' +
              '· 它可能<b>不是最危险的</b>（比如那个 Provider 其实压根没导出，或者 openFile 只返回固定文件）；<br>' +
              '· 改动最大 = 回归风险最大，最容易在评审周期内引出新问题；<br>' +
              '· 它挤掉了那些<b>改一行就能消掉一半攻击面</b>的动作（关导出、升权限级别、关备份）。<br><br>' +
              '正确的第一批永远是"<b>成本极低 + 削减攻击面明显</b>"的那些：关掉裸导出的组件、把内部权限升到 signature、' +
              '关掉 <span class="mono">allowBackup</span>、关掉 WebView 的 file 域开关。' +
              '这些不碰业务逻辑，回归成本接近零。<br><br>' +
              '<b>认知根源：</b>把"技术难度"当成了"风险大小"的代名词。' +
              '评审排序用的是<b>可利用性 × 影响 ÷ 修复成本</b>，成本在分母上——越便宜越该先做。'
          },
          n4: {
            label: '选D', terminal: true, verdict: 'bad',
            verdictTitle: '把"工具没报"当成了"没有问题"',
            result: '<b>Drozer 没扫到，至少有四种解释</b>，你一条都没排除：<br>' +
              '① 真的没有可访问的组件（那就该验证一下它到底跑了哪些模块）；<br>' +
              '② 组件扫描模块没跑通 / 权限不够 / agent 没装上；<br>' +
              '③ 目标做了加固或反调试，Drozer 的调用被拦了；<br>' +
              '④ 漏洞需要特定参数或特定业务状态才触发，扫描器没试到那个组合。<br><br>' +
              '而且更要紧的是：<span class="hit">"没扫到"和"扫了但没看懂"在工具输出里长得一模一样。</span>' +
              '所以正确的动作不是"转向 20 条静态项"，而是<b>用另一条路径（手工 adb / 自己写一个最小的调用 App）去交叉验证</b>。' +
              '两条独立路径都没发现，才敢写"未发现"。<br><br>' +
              '<b>认知根源：</b>把"我没有证据表明有问题"当成了"我有证据表明没问题"。' +
              '这两句话在安全评审里的分量差得很远。'
          }
        }
      }
    },

    /* ============================================================ 4.14 */
    {
      h: '4.14', title: '收口（上）：半小时能查完的清单',
      html:
        '<p>把前面九节的判定规则压缩成一张<b>可以照着走的清单</b>。' +
        '顺序不是随意的：<b>每一步都建立在前一步的产出上，而且每一步的成本递增</b>——' +
        '所以如果你只有十分钟，砍掉的一定是后面的步骤。</p>' +
        T.tbl(['#', '步骤', '具体动作', '能查出什么', '查不出什么'],
          [
            ['1', '<b>拆清单，列攻击面</b>（2 分钟）',
             '<span class="mono">apktool d</span> 或直接解压取 AndroidManifest；' +
             '把每个组件的 exported / intent-filter / permission 三列对齐',
             '哪些组件对外开放、以什么形式开放（4.1 / 4.3）',
             '组件内部拿到输入后做了什么（越权的后果完全在这一层）'],
            ['2', '<b>判定权限强度</b>（3 分钟）',
             '找到每个权限的 <span class="mono">&lt;permission&gt;</span> 声明，读 ' +
             '<span class="mono">protectionLevel</span>；找不到声明的按"拦不住"处理',
             '哪些"有权限"的组件其实挡不住第三方（4.1 的 normal 陷阱）',
             '第三方 SDK 提供权限的真实级别（要去查提供方）'],
            ['3', '<b>静态扫敏感面</b>（8 分钟）',
             'MobSF 跑一遍；或手工搜：硬编码字符串、<span class="mono">allowBackup</span>、' +
             '<span class="mono">debuggable</span>、<span class="mono">usesCleartextTraffic</span>、' +
             'WebView 三开关、日志输出',
             '配置与代码层面的"可疑点清单"（4.4 / 4.5 / 4.7）',
             '这些可疑点里哪些真的能被外部触发'],
            ['4', '<b>动态验证导出组件</b>（10 分钟，需要设备）',
             '<span class="mono">am start</span> 起 Activity、<span class="mono">content query</span> 读 Provider、' +
             'Drozer 跑攻击面与 provider 扫描；用一个"最小调用 App"或 shell 身份各试一次',
             '能不能真的调到、读到、崩掉（4.6 / 4.8 / 4.10 / 4.11）',
             '业务逻辑层面的越权判断（要读懂业务）'],
            ['5', '<b>看别人的代码</b>（4 分钟）',
             '第三方 SDK 清单 + 网络配置（明文流量、证书校验位置）',
             '外部依赖引入的额外攻击面（SDK 自带的导出组件最容易被漏）',
             'SDK 内部的运行时行为（要单独测）'],
            ['6', '<b>写清边界</b>（3 分钟）',
             '明确列出本次未覆盖的部分：后端校验、动态下发、加固后的 native、需要特定业务状态的路径',
             '<b>让读者知道你的结论在哪里成立</b>',
             '（这一步的作用不是"查出什么"，而是防止别人把"未发现"读成"不存在"）']
          ]) +
        T.note('key', '🔑 这条清单的使用方式：不是"跑完就完"，而是"跑完能排序"',
          '<p style="margin-bottom:0">六步之后你手上会有三类东西：<b>已证实的可利用问题</b>、' +
          '<b>可疑但未验证的项</b>、<b>明确的盲区</b>。' +
          '第 4.15 节就是教你怎么把这三类排成一张有说服力的优先级表。<br>' +
          '<span class="hit">没有这一步，六步跑出来的东西只是一堆观察；有了这一步，它才是一份评审。</span></p>') +
        T.grid(2, [
          '<b>如果你只有 10 分钟</b>' +
          '<p style="margin-bottom:0">做第 1、2 步，外加第 4 步里最便宜的那一条：' +
          '用 <span class="mono">am start</span> 把每个导出的 Activity 点一遍。<br>' +
          '理由：这三件事覆盖了"边界类"风险的全部——而边界类恰好是<b>修复成本最低</b>的那一类。' +
          '静默的输入处理问题（DoS、路径、桥）在没有明确线索时，10 分钟内几乎不可能查全。</p>',
          '<b>如果你有三天</b>' +
          '<p style="margin-bottom:0">在六步之外补两件事：<br>' +
          '① <b>读代码而不是读报告</b>：把每个导出组件的入口方法完整读一遍，' +
          '顺着外部输入找到它的第一个转换点；<br>' +
          '② <b>把动态验证做深</b>：用一个自己写的调用 App 去试参数组合（而不是只用 shell 命令），' +
          '因为"以 App 身份"才是真实的攻击者身份。<br>' +
          '这两件事的价值在于：它们能发现<b>扫描器原理上就发现不了</b>的问题。</p>'
        ])
    },

    /* ============================================================ 4.15 */
    {
      h: '4.15', title: '收口（下）：风险怎么排，以及一个可以合法练手的靶场',
      html:
        '<p>这一节回答本章最后、也是最容易被做砸的一个问题：<b>手上十条风险，先修哪三条？</b></p>' +
        T.note('bad', '🔥 先把一种做法排除掉',
          '<p style="margin-bottom:0">把所有项都标"高危"。这看起来像是"严谨"，实际效果是' +
          '<b>把排序工作原封不动地推给了读报告的人</b>——而他们没有你的上下文（不知道哪条能被外部触发、' +
          '不知道哪条改一行就能修）。<br>' +
          '<span class="hit">一份十项全高危的报告，和一份什么都没说的报告，在可执行性上是等价的。</span></p>') +

        '<h3>排序公式</h3>' +
        T.card('优先级 = 可利用性 × 影响 ÷ 修复成本',
          T.tbl(['因子', '怎么取值（低/中/高）', '取值依据'],
            [
              ['<b>可利用性</b>', '高：任何 App 可用一条命令触发；中：需要特定参数/业务状态或用户交互；低：需要 root、物理接触或已攻破的前置条件',
               '来自 4.14 第 4 步的实测结果，而不是清单上的字段'],
              ['<b>影响</b>', '高：读取/篡改敏感数据、可远程代码执行、影响全部用户；中：影响单个用户或单个功能；低：仅信息暴露或仅影响可用性',
               '来自"这个组件碰的是什么数据/能做什么操作"'],
              ['<b>修复成本</b>', '低：改清单/改一行配置，不碰业务逻辑（回归成本≈0）；中：需要改代码并回归测试；高：需要改架构或服务端配合',
               '来自"修改是否改变既有行为"'],
            ])) +
        '<p>三个因子的乘积决定了顺序。举三个本章出现过的例子，看看差异有多大：</p>' +
        T.tbl(['典型问题', '可利用性', '影响', '修复成本', '结论'],
          [
            ['裸导出的 <span class="mono">DownloadService</span>（无权限、任意 App 可拉起）', '高', '中～高（取决于它下载什么）',
             '<b>低</b>（改一行 <span class="mono">exported="false"</span>）',
             '<b>第一批修</b>：成本几乎为零，收益是把一个入口直接关掉'],
            ['<span class="mono">normal</span> 级权限保护的 <span class="mono">AdminPanelActivity</span>', '高', '高（管理功能）',
             '<b>低</b>（把 protectionLevel 改成 signature，或直接关导出）',
             '<b>第一批修</b>：这是"看着做了防护"的典型，改一行就有效'],
            ['Provider 的 <span class="mono">openFile</span> 路径遍历', '中～高（要看 URI 是否易被猜到）', '高（可读私有目录任意文件）',
             '<b>中</b>（要改代码 + 回归既有 URI 行为）',
             '<b>第一批或第二批</b>：如果第 4 步已实测读到敏感文件，就该进第一批；否则排第二批'],
            ['日志里打印了响应体', '低（需要 adb 或日志采集能力）', '中（单用户数据）',
             '<b>低</b>（构建配置里关掉）',
             '<b>顺手修</b>：放在第一批一起做掉，但不必单独排期'],
            ['硬编码了一枚给所有请求签名的密钥', '中（需要拿到 APK，不需要设备）', '<b>高</b>（可伪造任意用户请求，且难以撤销）',
             '<b>高</b>（要改服务端 + 客户端双端方案）',
             '<b>必须单独立项</b>：它的修复成本高，但影响的量级和"不可撤销性"决定了它不能被排在后面']
          ]) +
        T.note('ok', '✅ 排序的输出长什么样',
          '<p style="margin-bottom:0">一份可执行的结论应该是这个形状：' +
          '<b>"第一批（本周，成本≈0）：关掉 A、B、C 三个组件的导出，把 D 的权限升到 signature；' +
          '第二批（需回归）：修复 Provider 的路径处理，补齐 E 的输入校验；' +
          '单独立项：硬编码签名密钥的整改（涉及服务端）；顺手：关闭日志输出与备份。"</b><br>' +
          '注意它包含三件事：<b>做什么、为什么是现在、以及代价是什么</b>。' +
          '这就是本章从 4.1 到 4.14 一直在训练的那种判断力——不是"知道很多风险"，而是"能在代价约束下排出顺序"。</p>'),
      case: {
        source: 'github',
        title: 'DIVA Android —— Damn insecure and vulnerable App（作者照 README：Aseem Jakhar / Payatu）',
        author: 'Aseem Jakhar（README 的 Author 段落署名）',
        target: 'DIVA Android（故意不安全的安卓靶场 App，源码开放、可自行编译）',
        background:
          '<p>README 原文的定位：这是一个<b>故意被设计成不安全</b>的 App，' +
          '目的是教开发者 / QA / 安全人员认识"由于糟糕或不当的编码习惯而普遍存在的缺陷"。' +
          '作者的动机很实际：给开发者的安卓安全培训"理论太多、动手太少"，' +
          '所以他把这些缺陷做成一个可以逐个去玩的 App——用 README 的话说，它把安全开发学习"游戏化"了。' +
          'README 同时点明它覆盖的范围：<b>从不安全存储、输入校验，到访问控制问题</b>，' +
          '并且<b>源代码在手</b>，所以既能看到"错在哪"，也能看到"应该怎么写"。</p>',
        points: [
          'README 列出的挑战清单（照抄）：Insecure Logging；Hardcoding Issues 1 / 2；' +
          'Insecure Data Storage 1–4；Input Validation Issues 1–3；Access Control Issues 1–3',
          '<b>和本章的对应关系</b>：Insecure Logging / Insecure Data Storage / Hardcoding → 4.5（敏感数据明文保存）；' +
          'Access Control Issues → 4.6（Activity 组件越权）；Input Validation Issues → 4.8 / 4.10（输入校验与畸形参数）',
          'README 说明它<b>同时包含 Java 与 native 两层的缺陷</b>（"few vulnerabilities in native code"），' +
          '所以第 3 章那类文件格式/native 的知识在这里也有用武之地',
          '它自带源码，因此可以对着"错误实现"读一遍，再按本章的修复清单改一遍——' +
          '这比在别人的 App 上猜实现有用得多'
        ],
        method: [
          '按 README 的 How to compile：下载源码 → Android Studio 打开 → 先编译 native 库' +
          '（<span class="mono">cd app/src/main/jni &amp;&amp; make</span>，它会产出 jniLibs）',
          '按 README 的 How to run：开启 USB 调试 → <span class="mono">adb install &lt;apk&gt;</span> → 在设备上开始玩',
          '带着本章 4.14 的清单走一遍：先拆它的 Manifest 列攻击面，再逐条对 Access Control 类挑战做动态验证',
          '对每个挑战回答三个问题：外部能不能触发、影响的资产是什么、正确的实现应该怎么写',
          '最后用自己的话复述一遍修复方案（这才是这个靶场真正的产出，不是"通关"）'
        ],
        result:
          '<p>你得到一个<b>可以合法地把本章七类风险跑一遍</b>的环境，而且每个缺陷都能对着源码看实现。' +
          '对"知道风险但没见过真实代码长什么样"的学习者来说，这是补齐从"名词"到"手感"那一步最省事的路径。</p>',
        terms: ['靶场 App', 'Insecure Data Storage', 'Access Control', 'Input Validation', 'adb', 'native'],
        limits:
          '<p>README 里作者自述的一句：<b>"I am sure I have missed out on some vulnerabilities."</b>' +
          '（他确信自己漏掉了一些缺陷，并欢迎别人提交补充。）——这句照录，不做延伸。<br>' +
          '另外两点是本文的观察，<b>不是作者原话</b>：① 这是一个较早的项目，' +
          '部分挑战在高版本 Android 上的表现可能与当年不同（尤其是涉及外部存储与日志的挑战）；' +
          '② README 没有声明它适配到哪个 Android 版本。<br>' +
          '<span class="pill warn">待核实</span> 具体到你手上的设备与系统版本，哪些挑战仍能原样复现——' +
          '这需要你自己跑一遍，而不是相信任何一篇教程（包括本文）。</p>',
        analysis:
          '<p><b>用本课方法论拆解：</b>DIVA 的价值不在于"它有漏洞"，而在于它的挑战清单' +
          '<b>几乎就是本章七类风险的一张考卷</b>——README 自己给出的分类（logging / storage / hardcoding / ' +
          'input validation / access control）与本章的组织方式高度重合，这不是巧合：' +
          '这两套分类都是从同一个源头来的（OWASP 移动安全那一侧的知识体系，' +
          'MASVS 定义"应该满足什么控制项"、MASTG 定义"怎么验证"）。</p>' +
          '<p>但用这个靶场时有一个陷阱要避开：<b>不要"随机点挑战"，而要带着 4.14 的清单走</b>。' +
          '因为靶场的缺陷是被人为设计出来的、位置已知；而真实 App 里同样的缺陷藏在几万个方法中，' +
          '你必须靠"先列攻击面、再判权限强度、再动态验证"这套顺序去<em>找</em>它。' +
          '<span class="hit">靶场训练的是"认出缺陷、说清原理"，清单训练的是"找到缺陷"——' +
          '这两件事都要练，但别把它们混为一谈。</span></p>' +
          '<p>还有一条值得对照的：DIVA 里那些 Access Control 挑战之所以成立，' +
          '前提都是 4.1 讲的同一件事——<b>组件被导出了，而组件内部没有校验"谁在调用"</b>。' +
          '你在靶场里看到的每一种形态，在真实评审里都会以别的名字再出现一次。</p>',
        link: 'https://github.com/payatu/diva-android',
        linkNote: '正文可读性验证：用 Node fetch 取 raw README（HTTP 200，原始 4498 字节 HTML 内含完整正文），' +
          '挑战清单、Author、How to compile / How to run、以及作者自述的局限均逐条核对原文'
      },
      after: T.note('ok', '✅ 本章的收束',
        '<p style="margin-bottom:0">回头看一遍本章的骨架：<b>4.1 建立坐标系（导出 = 攻击面）→ 4.2 把调用链拆成五道门 → ' +
        '4.4～4.11 七类风险各就各位 → 4.12/4.13 两款工具补上静态与动态 → 4.14/4.15 收成清单与顺序。</b><br>' +
        '你会发现在这条链上，真正需要"技术"的地方并不多——大多数缺陷的成因是' +
        '<b>默认值、保护级别的误判、以及"检查的对象和使用对象不是同一个"</b>。' +
        '<span class="hit">这也解释了为什么这一章的视角和前面完全不同：前面各章在提高攻击者的成本，' +
        '而这一章在减少自己的错误。两者用的知识是同一批，站位却是相反的。</span></p>')
    }
  ],

  glossary: [
    { t: 'exported', d: '组件属性：该组件能否被其他 App（不同 UID 的进程）调用。显式值优先；未声明时「有 intent-filter 就导出」。' },
    { t: 'intent-filter', d: '声明组件能响应哪些隐式 Intent（action/category/data 的组合）。它不影响导出与否（Android 12 起必须配合显式 exported）。' },
    { t: 'protectionLevel', d: '权限的保护级别。signature 级别只有同签名应用能获得，normal 级别是"声明即得"，dangerous 需要用户授权。' },
    { t: '攻击面（attack surface）', d: '一个 App 暴露给外部（其他 App、系统、用户可触达的界面）的全部入口集合。本章中它等于"所有导出的组件 + 权限级别"。' },
    { t: '重打包', d: '把 APK 反编译、修改后重新签名分发。它危害的是产物完整性；遇到签名校验/完整性校验会失效。' },
    { t: 'allowBackup', d: '清单属性。为 true 时应用数据可被系统备份机制导出（是否可被 adb backup 还受 Android 版本与 debuggable 影响，待核实）。' },
    { t: 'EncryptedSharedPreferences', d: 'Jetpack Security 提供的加密 SharedPreferences 封装，密钥由 Keystore 托管。注意该库的维护状态近年有变化，选型前需核实。' },
    { t: 'addJavascriptInterface', d: '把 Java 对象注入 WebView 的 JS 上下文。Android 4.2（API 17）起只有标了 @JavascriptInterface 的方法可被调用。' },
    { t: 'setAllowUniversalAccessFromFileURLs', d: 'WebSettings 开关：允许 file:// 页面用 XHR 访问任意来源（含 http/https）。默认值随 targetSdk 变化，见 4.7。' },
    { t: '目录遍历（path traversal）', d: '用 ../ 一类相对路径逃出预期目录，读到部署者没打算开放的文件。在 Provider 里通常出现在 openFile 的路径拼接。' },
    { t: 'canonical path', d: '归一化并解析过符号链接之后的真实路径。getCanonicalPath() 会解析符号链接，纯词法归一化（Path.normalize）不会。' },
    { t: 'grantUriPermissions', d: 'Provider 属性。为 true 时，可通过带 FLAG_GRANT_*_URI_PERMISSION 的 Intent 把某个 URI 临时授权给第三方。' },
    { t: 'TransactionTooLargeException', d: 'Intent extras 跨 Binder 传递时超出事务缓冲区上限抛出的异常。上限随版本/设备变化，教学里常用 1 MiB 作参照。' },
    { t: 'LocalBroadcastManager', d: '进程内广播机制，广播不经过系统，其他 App 无法发送或接收（现已被官方标记为可选替代方案，新代码可用其它进程内通信）。' },
    { t: 'Drozer', d: '在真实设备上以"攻击者 App"的身份调用目标组件的动态审计框架，能发现静态扫描发现不了的运行时问题。' },
    { t: 'MobSF', d: 'Mobile Security Framework：APK/IPA 静态分析 + 动态分析平台，输出 Manifest 风险项、硬编码密钥、API 清单、权限与第三方 SDK 等。' },
    { t: 'MASVS / MASTG', d: 'OWASP 的移动应用安全验证标准与测试指南：前者是"应该满足什么控制项"，后者是"怎么验证"。' }
  ],

  teacher: {
    id: 't29', chapter: 29,
    name: '安全评审官',
    sub: '把"高危"三个字说出口之前，先告诉我它凭什么',
    intro: '<p style="margin:0">我不考你背 API 名，也不考你记住哪个属性默认是 true——那些东西查文档就有。<br>' +
           '我考的是：<b>给你一个现象，你能不能算出它的风险等级、说清它在什么条件下真的可被利用、以及你凭什么这么判。</b><br>' +
           '记住一件事：<span class="hit">把所有项都标高危，等于没有排序，也就等于没有评审。</span></p>',
    questions: [
      {
        id: 'c29q1', depth: 1, threshold: 0.7,
        q: '一个组件的 <span class="mono">android:exported</span> 到底在管什么？请说清：没写这个属性时系统怎么判断，以及 Android 12 改变了什么。',
        concepts: [
          { label: '管的是"能不能被其他 App（不同 UID 的进程）调用"，不是 Java 可见性', hint: '它不是一个语言层面的 public/private。', any: ['其他应用', '其他 App', '第三方', '别的应用', '不同 UID', '跨进程', '外部应用', '不是 java', '访问修饰符'] },
          { label: '未声明时：有 intent-filter → 导出，没有 → 不导出（历史默认值）', hint: '默认值和 intent-filter 有关。', any: ['intent-filter', 'filter', '隐式', '默认导出', '默认是 true', '有 filter'] },
          { label: '显式值优先：写了 false 就是 false，哪怕有 intent-filter', hint: '写死的值和推断的值谁大？', any: ['显式', '优先', '写死', 'false 就是', '以显式为准', '覆盖'] },
          { label: 'Android 12（targetSdk 31）起：有 intent-filter 必须显式声明 exported，否则构建/安装被拦', hint: '从某个版本起，"默认"这条路被堵了。', any: ['android 12', 'targetsdk 31', 'api 31', '31', '强制', '必须显式', '构建失败', '装不上', '安装失败'] },
          { label: '改动的动机：默认值太容易被"顺手加个 filter"变成开放，属于安全默认值反转', hint: '为什么要强制？因为默认值自己会"变坏"。', any: ['默认值', '安全默认', '顺手', '不经意', '静默', '容易出错', 'cwe-926', '历史包袱'] }
        ],
        hints: [
          '先把它和 Java 的访问修饰符彻底切开：调用方是另一个进程，运行时它压根不看你的 Java 可见性。',
          '再想"没写的时候系统靠什么猜"——这个猜测依据是 intent-filter 的存在与否。'
        ],
        probes: [
          '追问：如果一个 Activity 没有 intent-filter，但写了 exported="true"，它还能被别的 App 调用吗？怎么调？',
          '再追问：为什么"为了让系统能唤起我"这个正当需求，会顺带把组件开放出去？'
        ],
        model: '<b>exported 管的是跨应用可见性，只此一件事。</b><br><br>' +
          '它的判定对象不是"代码里的类"，而是"清单里这个组件声明"。' +
          '调用方是另一个进程，走的是 Binder 到 AMS，再由 AMS 检查目标组件是不是允许被外部访问——' +
          '所以你把 Activity 写成包内可见也没有任何意义，<b>Java 的可见性根本不在这条路径上</b>。<br><br>' +
          '<b>未声明时的规则：有 <span class="mono">&lt;intent-filter&gt;</span> 就导出，没有就不导出。</b>' +
          '有 filter 意味着"我希望能被隐式 Intent 匹配到"，历史设计上就等同于"我愿意被外部唤起"。' +
          '写死 <span class="mono">exported="false"</span> 时显式值优先——filter 只影响"能不能被隐式匹配到"，不影响"能不能被调用"。<br><br>' +
          '<b>Android 12（targetSdk ≥ 31）的改变是"取消默认"：</b>只要组件带 intent-filter，就必须显式写出 exported，' +
          '否则 manifest 合并阶段直接报错（构建产不出包），绕过构建在 targetSdk ≥ 31 的设备上也装不上。<br><br>' +
          '<b>为什么平台要动这一刀：</b>因为"有 filter 就导出"这条默认值会随着需求演进<b>静默变坏</b>——' +
          '你只是加了一个 filter，风险等级却从"不导出"跳到了"导出"，而 diff 里只多了一个你不知道危害的块。' +
          '<span class="hit">安全默认值的原则是：危险的事情必须被显式选择，而不是被隐式继承。</span>'
      },
      {
        id: 'c29q2', depth: 2, threshold: 0.7,
        q: '一个导出的 Activity 挂了 <span class="mono">android:permission="com.example.app.permission.ADMIN"</span>。' +
          '这算不算"已经做了访问控制"？请说清你的判断依据，以及你会怎么核实。',
        concepts: [
          { label: '不算：权限能不能拦住第三方，取决于它的 protectionLevel，而不是权限名', hint: '名字叫 ADMIN 不代表它管用。', any: ['protectionlevel', '级别', '保护级别', '不取决于名字', '名字不代表', '看级别'] },
          { label: 'normal 级别是"声明即得"：第三方写一行 uses-permission 就拿到，用户无感', hint: '有一种权限，申请了就直接给你。', any: ['normal', '声明即得', '自己声明', 'uses-permission', '无需用户', '没有提示', '自动授予'] },
          { label: 'dangerous 级别需要用户点一次允许，可以被界面诱导 → 只能算弱保护', hint: '需要用户点一下，但点一下并不难。', any: ['dangerous', '用户授权', '点一次', '诱导', '弹窗', '弱保护', '不能当边界'] },
          { label: '只有 signature（或 signatureOrSystem）才真正把第三方挡在外面', hint: '哪种级别要求"和你同一个签名"？', any: ['signature', '签名', '同一个签名', '同一签名', '自家', 'system'] },
          { label: '核实方法：去清单里找 permission 声明读 protectionLevel；找不到声明就按"拦不住"处理', hint: '权限也可能根本没被声明过。', any: ['清单', 'manifest', '找声明', '声明在哪', '读 protectionlevel', '找不到', '未声明', '人工核实', 'adb', 'dumpsys', 'drozer'] }
        ],
        hints: [
          '把问题从"有没有权限"改成"这个权限谁拿得到"。',
          '如果第三方 App 自己在清单里写一行 uses-permission 就能拿到，那这道门挡的是谁？'
        ],
        probes: [
          '追问：如果这个权限在清单里根本没有 <span class="mono">&lt;permission&gt;</span> 声明，会发生什么？',
          '再追问：同一份代码，把 protectionLevel 改成 signature 之后，你的风险评估结论应该怎么变？'
        ],
        model: '<b>不算。有一个权限名，和"有访问控制"，是两件事。</b><br><br>' +
          '权限的强度由 <span class="mono">protectionLevel</span> 决定：<br>' +
          '· <b>normal</b>：第三方 App 在自己的清单里声明 <span class="mono">&lt;uses-permission android:name="…"&gt;</span> 就<b>自动获得</b>，用户看不到任何提示。' +
          '这道门是纸糊的——<span class="hit">"声明即得"是移动端最会骗人的一种安全写法</span>。<br>' +
          '· <b>dangerous</b>：需要用户点一次同意。听起来有门槛，但一次界面诱导（"为了改善体验请允许…"）就能过，不能当安全边界。<br>' +
          '· <b>signature / signatureOrSystem</b>：要求调用方和你的 App 用同一个签名。第三方做不到这件事——<b>这才是真的墙。</b><br><br>' +
          '<b>核实顺序（这是本题真正考的东西）：</b><br>' +
          '① 在清单里搜这个权限名，找到 <span class="mono">&lt;permission&gt;</span> 声明，读它的 protectionLevel；<br>' +
          '② 如果权限名是别的 App 提供的（比如系统权限或第三方 SDK 的权限），去看提供方声明的级别；<br>' +
          '③ <b>如果根本搜不到声明，就按"拦不住"处理</b>，并列入待人工确认——因为一个没有被声明的权限名，其实际行为是不可依赖的；' +
          '④ 有条件时用 Drozer 之类的工具<b>真的去调一次</b>（以攻击者 App 的身份），比读清单更硬。<br><br>' +
          '<span class="hit">这一题的方法论价值：审计里"看起来做了防护"必须被打回成"防护的强度是多少"。</span>' +
          '你只要养成这个反射，就能躲开报告里一大半的假阳性/假阴性。'
      },
      {
        id: 'c29q3', depth: 2, threshold: 0.7,
        q: 'Provider 的 <span class="mono">openFile</span> 里，开发者做了这个"安全检查"：' +
          '<span class="mono">new File(root, uri.getPath()).getAbsolutePath().startsWith(root.getAbsolutePath())</span>。' +
          '请说清它<b>两种</b>被绕过的方式，以及正确的写法。',
        concepts: [
          { label: '绕过一：没有归一化，path 里的 ../ 在字符串上仍在白名单前缀内', hint: '字符串比的时候，.. 还是普通字符。', any: ['归一化', '..', '上溯', '父目录', '没有消除', '字符串', 'prefix', 'getcanonical', 'absolutepath'] },
          { label: '绕过二：没有路径分隔符边界，share 前缀命中了 shared-notes 这类兄弟目录', hint: '前缀相等和"在同一目录下"不是一回事。', any: ['分隔符', '边界', 'shared-notes', '前缀', '兄弟', 'separator', '目录边界', 'startsWith 不加斜杠'] },
          { label: '正确的检查时机：先归一化（getCanonicalPath / 解析符号链接）再比较', hint: '比较必须发生在"真实路径"上。', any: ['getcanonicalpath', 'canonical', '归一化后', '先归一化', '真实路径', 'realpath'] },
          { label: '正确的比较方式：等于根，或根 + File.separator 开头', hint: '边界要写进比较里。', any: ['separator', '斜杠', 'root +', '加上分隔符', '等于根', '边界'] },
          { label: '符号链接：纯词法归一化（Path.normalize）不解析符号链接，getCanonicalPath 才会', hint: '还有一类逃逸不靠 ..。', any: ['符号链接', 'symlink', '软链接', 'link', 'normalize 不解析', 'canonical 解析'] },
          { label: '更好的修法：不要用外部输入拼路径——用 ID 映射到白名单，或交给 FileProvider', hint: '最彻底的修复是不让 Uri 直接决定路径。', any: ['白名单', '映射', 'id 映射', 'fileprovider', '不从 uri 拼', '固定文件名', '查表'] }
        ],
        hints: [
          '第一种绕过和"字符串和文件系统不是一回事"有关；第二种绕过和"前缀"这个词的定义有关。',
          '再想想：就算归一化了，什么样的文件系统特性还能让它跑出去？'
        ],
        probes: [
          '追问：把 getAbsolutePath() 换成 getCanonicalPath() 之后，第二种绕过还在吗？',
          '再追问：如果这个 Provider 的 Uri 是从别的 App 转发过来的（grantUriPermissions），你的白名单还够用吗？'
        ],
        model: '<b>这段代码两种绕过，而且很常见：</b><br><br>' +
          '<b>① 没有归一化。</b><span class="mono">getAbsolutePath()</span> 只做"补上当前工作目录"，' +
          '<b>不会消除 <span class="mono">..</span></b>。所以 ' +
          '<span class="mono">' + SEC29_ROOT + '/../../databases/app.db</span> 这个字符串，' +
          '它以根目录开头 → 检查通过；而内核在 <span class="mono">open()</span> 时逐级回退 ' +
          '<span class="mono">..</span> → 真正打开的是根目录外的文件。<b>检查的和打开的不是同一个字符串。</b><br><br>' +
          '<b>② 没有分隔符边界。</b>假设根目录是 <span class="mono">/…/shared</span>，' +
          '那么 <span class="mono">/…/shared-notes/x</span> 也满足 <span class="mono">startsWith(root)</span>——' +
          '因为"前缀相同"不等于"在同一个目录里"。要拦住它，比较对象必须是 ' +
          '<span class="mono">root + File.separator</span>。<br><br>' +
          '<b>正确写法（顺序很重要）：</b><br>' +
          '· 先 <span class="mono">getCanonicalPath()</span>（它会归一化 <b>并</b>解析符号链接）；<br>' +
          '· 再判断 <span class="mono">canonical.equals(rootCanonical) || canonical.startsWith(rootCanonical + File.separator)</span>；<br>' +
          '· 任何一步抛异常都<b>拒绝</b>，不要降级放行。<br><br>' +
          '<b>注意第三层：</b>纯词法归一化（比如 <span class="mono">java.nio.file.Path.normalize()</span>）' +
          '只处理 <span class="mono">.</span> 和 <span class="mono">..</span>，<b>不解析符号链接</b>——' +
          '如果攻击者能影响目录内容（比如上传一个压缩包并解压），一个软链接就能让"已经归一化过"的路径再次跑出去。' +
          '<span class="mono">getCanonicalPath()</span> 会解析它，这也是它比 normalize 更可靠的原因。<br><br>' +
          '<span class="hit">最彻底的修法不是把检查写对，而是取消"用 Uri 拼路径"这件事本身</span>：' +
          '把 Uri 当成一个 ID，用查表映射到固定文件；或者干脆改用 FileProvider 并只暴露必要的目录。' +
          '只要外部输入还能参与路径拼接，你就永远在追着归一化的边界跑。'
      },
      {
        id: 'c29q4', depth: 2, threshold: 0.7,
        q: '为什么说"组件里取 Intent 参数不校验"是高发缺陷？请举出至少两类<b>实际会崩</b>的输入，' +
          '并说明为什么"取的时候崩"往往不是最糟的结果。',
        concepts: [
          { label: '外部 App 可以自由构造 extras 的类型、缺失与体积，系统不校验内容', hint: '系统只保证"谁发的"，不保证"发了什么"。', any: ['外部', '任意', '构造', '类型', '不校验', '系统不管', 'extras', '内容'] },
          { label: '具体会崩的例子：空值（缺失 key）→ NPE；格式不符 → NumberFormatException', hint: '最便宜的两类畸形输入。', any: ['null', '空值', '缺失', 'npe', 'nullpointer', 'numberformatexception', 'parseint', '格式', '非数字'] },
          { label: '具体会崩的例子：类型不符的强转 → ClassCastException；集合元素类型不符同理', hint: '泛型擦除之后，元素类型还在。', any: ['classcastexception', '强转', '类型不符', '泛型', '擦除', 'arraylist', '集合', 'parcelable', 'serializable'] },
          { label: '体积型：超大 extras 触发 TransactionTooLargeException（崩在传递环节）', hint: '有一类崩溃和"类型"无关。', any: ['transactiontoolarge', '体积', '大小', '太大', 'binder', '1m', '缓冲区', '上限', 'byte[]', 'oom'] },
          { label: '"取的时候不崩"可能更糟：Bundle 的原始类型 getter 会吞掉 CCE 返回默认值，静默拿到错值', hint: '有一种写法，看着会崩其实不崩——这比崩了更麻烦。', any: ['getintextra', '不崩', '返回默认值', '默认值', '吞掉', 'typewarning', '静默', '错值'] },
          { label: '真正的判别点是"值被第一次转换/使用"的那一步（parseInt / 强转 / 当索引 / 当路径）', hint: '审计要看的是第一个转换点。', any: ['转换点', '使用处', '第一次用', '当索引', '当路径', 'sql', '往下看', '调用点'] }
        ],
        hints: [
          '先分两类：一类是"内容/类型不对"，一类是"体积不对"。',
          '再想一个问题：如果 <span class="mono">getIntExtra</span> 遇到字符串会崩，那你觉得它设计上会不会崩？为什么？'
        ],
        probes: [
          '追问：<span class="mono">getIntExtra("uid", 0)</span> 拿到一个字符串时会发生什么？为什么这个行为反而更危险？',
          '再追问：如果崩溃发生在系统服务或发送方进程，你的崩溃平台能收到吗？会指向谁？'
        ],
        model: '<b>为什么高发：</b>因为这类组件的输入边界是"任何装了 App 的人"，' +
          '而开发者在写这段代码时脑子里想的是"我自己的另一个界面会用 Intent 把 uid 传进来"。' +
          '<span class="hit">把"内部调用方"的心理模型套到"跨应用入口"上，是这类缺陷的总根源。</span><br><br>' +
          '<b>会崩的两大类：</b><br>' +
          '· <b>内容/类型不对</b>：缺失的 key → <span class="mono">getStringExtra</span> 返回 null，直接 <span class="mono">.length()</span> 就是 <b>NPE</b>；' +
          '字符串 <span class="mono">"abc"</span> 送进 <span class="mono">Integer.parseInt</span> → <b>NumberFormatException</b>；' +
          '把 String 当 Parcelable 强转 → <b>ClassCastException</b>；' +
          '把 <span class="mono">ArrayList&lt;Integer&gt;</span> 当字符串集合取 → 第一个元素强转时 <b>CCE</b>（泛型擦除擦掉的是泛型参数，不是元素类型）。<br>' +
          '· <b>体积不对</b>：塞一个几 MB 的 byte[]，Intent 的 extras 要跨 Binder，超出事务缓冲区直接 ' +
          '<b>TransactionTooLargeException</b>。它可能崩在发送方、也可能崩在接收方，排查时最容易找错责任人。<br><br>' +
          '<b>为什么"取的时候不崩"更糟：</b>因为 Bundle 的原始类型 getter（<span class="mono">getIntExtra</span> / ' +
          '<span class="mono">getBooleanExtra</span> 一类）内部<b>捕获了 ClassCastException 并返回默认值</b>，' +
          '只打一条 typeWarning 日志。于是 <span class="mono">uid</span> 会变成 <b>0</b>，' +
          '业务逻辑带着一个错的值继续往下跑——这可能变成"越权访问了 uid=0 的数据"，' +
          '而且<b>没有任何崩溃记录指向它</b>。<br>' +
          '<span class="pill warn">待核实</span> 这个 catch 行为的具体版本细节（日志形状、是否所有原始类型都如此）建议以你目标平台的实际表现验证。<br><br>' +
          '<b>结论性判据：</b>审计时不要停在 <span class="mono">getXxxExtra</span> 这一行，' +
          '要顺着这个值往下找到<b>第一个转换点</b>：parseInt、强转、当索引、当文件名、当 SQL 参数、当 URL。' +
          '那里才是会崩、或者会被滥用（注入）的地方。'
      },
      {
        id: 'c29q5', depth: 3, threshold: 0.7,
        q: '<b>综合题：</b>给你一个从没见过的 APK，要求你在 <b>30 分钟内</b>交出一份"这个 App 自己有哪些风险"的清单。' +
          '请说出你的审计顺序（至少六步），以及<b>每一步能查出什么、查不出什么</b>。',
        concepts: [
          { label: '第一步零成本：拆 Manifest，把导出的组件全部列出来（exported / filter / permission 三者一起看）', hint: '最便宜、信息量最大的一步应该先做。', any: ['manifest', '清单', '导出', 'exported', '组件', '第一步', '先看', '拆包', 'unzip', 'apktool'] },
          { label: '第二步：把权限的 protectionLevel 对上，区分"真保护"和"纸糊保护"', hint: '把"有权限"变成"保护强度是多少"。', any: ['protectionlevel', '权限级别', 'signature', 'normal', '真保护', '纸糊', '对上'] },
          { label: '第三步：静态扫敏感面——硬编码密钥/明文存储点/allowBackup/WebView 开关/日志', hint: '这一步不需要设备。', any: ['硬编码', '密钥', '明文', 'allowbackup', 'webview', '日志', 'log', '静态', '扫描', 'mobsf'] },
          { label: '第四步：动态验证导出的组件（以攻击者 App 身份真的调一次），而不是只信静态扫描', hint: '哪些问题只有运行时才看得见？', any: ['动态', '真机', '调一次', 'drozer', 'am start', 'content query', '运行时', '验证'] },
          { label: '第五步：对第三方库/SDK 与网络配置看一眼（导出组件、明文流量、调试开关）', hint: '你自己的代码之外，还有一堆别人的代码。', any: ['第三方', 'sdk', '库', 'usescleartexttraffic', 'debuggable', '网络配置', 'network security config'] },
          { label: '边界一：静态查不出真正的业务逻辑越权（例如"前端校验、后端不校验"），只能靠读代码+动态', hint: '有一类问题不是配置问题，是逻辑问题。', any: ['业务逻辑', '逻辑缺陷', '查不出', '读代码', '无法自动化', '后端', '越权逻辑'] },
          { label: '边界二：查不到的问题也要写清（没扫到 ≠ 没有），并给出证据与"未覆盖范围"', hint: '一份没有边界的报告是不可信的。', any: ['没扫到', '不等于', '不能断定', '未覆盖', '盲区', '证据', '边界', '局限'] },
          { label: '排序：不要把所有项标高危，按"可利用性 × 影响 × 修复成本"排', hint: '排序本身就是专业能力。', any: ['排序', '优先级', '可利用性', '影响', '修复成本', '不要都高危', '先修'] }
        ],
        hints: [
          '30 分钟的第一原则是"先做零成本的、能排除最多可能的那一步"。哪一步不需要设备、也不需要装工具？',
          '再想最后一件事：报告里"我查了什么"和"我没查什么"，哪个更需要写清楚？'
        ],
        probes: [
          '追问：如果时间只够做两件事，你会砍掉哪四步？为什么砍它们不心疼？',
          '再追问：Drozer 扫了一圈，什么都没报。你能不能在报告里写"未发现组件漏洞"？'
        ],
        model: '<b>六步顺序（每步都带"能查到 / 查不到"）：</b><br><br>' +
          '<b>第 1 步（2 分钟）：拆 Manifest，列攻击面。</b><span class="mono">apktool d</span> 或直接解压看清单，' +
          '把每个组件的 exported / intent-filter / permission 三列对齐。<br>' +
          '· 查得到：哪些组件对外开放、开放的形式是什么。<br>' +
          '· 查不到：组件<b>内部</b>拿到数据之后做了什么（越权的后果完全在这一层）。<br><br>' +
          '<b>第 2 步（3 分钟）：把权限的 protectionLevel 对上。</b>这一小步能把报告里一半的假阳性消掉——' +
          'signature 级权限保护的组件不是高危，normal 级保护的组件是高危。<br>' +
          '· 查得到：保护强度。<br>· 查不到：权限名由第三方 SDK 提供时的真实级别（要去查提供方）。<br><br>' +
          '<b>第 3 步（8 分钟）：静态扫敏感面。</b>硬编码密钥/账号、' +
          '<span class="mono">allowBackup</span>、<span class="mono">debuggable</span>、WebView 相关开关、日志输出、' +
          '明文存储的字段名与文件路径。MobSF 一次就能把这一层摊开。<br>' +
          '· 查得到：配置与代码层面的"可疑点清单"。<br>' +
          '· 查不到：这些"可疑点"里哪些真的能被外部触发（第 4 步才回答）。<br><br>' +
          '<b>第 4 步（10 分钟，需要设备）：动态验证导出的组件。</b>以攻击者 App 的身份去调：' +
          '<span class="mono">am start</span> 起导出 Activity、<span class="mono">content query</span> 读 Provider、' +
          'Drozer 跑一遍 <span class="mono">app.package.attacksurface</span> 与 provider 扫描。<br>' +
          '· 查得到：能不能真的拉起、能不能真的读到、能不能真的崩。<br>' +
          '· 查不到：业务逻辑层面的越权（比如"能进管理页但不能改数据"这类需要理解业务的判断）。<br><br>' +
          '<b>第 5 步（4 分钟）：看别人的代码和网络配置。</b>第三方 SDK 往往自带导出组件与明文流量；' +
          '<span class="mono">usesCleartextTraffic</span> / network security config 决定能不能降级到 HTTP。<br>' +
          '· 查得到：外部依赖引入的额外攻击面。<br>' +
          '· 查不到：SDK 内部的运行时行为（要单独测）。<br><br>' +
          '<b>第 6 步（3 分钟）：把没查到的东西写成交付边界。</b>明确写"本次未覆盖：后端校验逻辑、' +
          '运行时动态下发、加固后的 native 逻辑"等。<br>' +
          '· 这一条不是凑数：<b>一份没有边界的审计报告，读的人会默认它是全覆盖的</b>，那是比漏报更严重的问题。<br><br>' +
          '<b>最后一步（排序）：</b>不要把所有项标"高危"。排序依据是三个乘法因子——' +
          '<b>可利用性</b>（需不需要装 App、需不需要用户交互、需不需要 root）× ' +
          '<b>影响</b>（读数据 / 改数据 / 崩服务）× <b>修复成本</b>（改一行清单 vs 改架构）。' +
          '<span class="hit">排序本身就是专业能力：把所有东西都标高危，等于告诉对方"我不知道哪个重要"。</span>'
      },
      {
        id: 'c29q6', depth: 3, threshold: 0.7,
        q: '<b>综合题：</b>同一份代码，两个评审员给出完全不同的结论。甲说"导出的组件太多，是重大风险"；' +
          '乙说"导出是产品需求，风险可控"。请说清：<b>什么条件下甲对，什么条件下乙对</b>，' +
          '以及你会用哪几个可观测的事实来裁决这场争论。',
        concepts: [
          { label: '"导出多"本身不是风险，风险 = 导出 × 缺保护 × 内部行为危险', hint: '三个因子都要成立才算真风险。', any: ['三个', '组合', '缺保护', '内部行为', '不只是导出', '条件', '乘法'] },
          { label: '甲对的条件：导出且权限保护无效（normal/无权限），且组件内部接受外部输入并做了危险操作', hint: '什么样的导出组件才真的危险？', any: ['normal', '无权限', '裸导出', '危险操作', '外部输入', '越权', '拼接', '注入'] },
          { label: '乙对的条件：导出是该产品架构的一部分，但由 signature 权限/共享 UID/FileProvider 收窄了访问范围', hint: '产品线内部互通是一种正当需求。', any: ['signature', '同一签名', '共享 uid', 'shareduserid', 'fileprovider', '收窄', '内部互通', '自家'] },
          { label: '裁决依据一：能不能实测触发（动态调一次），而不是读名字猜', hint: '争论要靠证据结束。', any: ['实测', '动态', '调一次', 'drozer', 'am start', 'content query', '复现', '验证'] },
          { label: '裁决依据二：看权限声明的 protectionLevel 与调用方是否真的需要（共享 UID 会绕过导出限制）', hint: '有一个机制会让"不导出"也变成可访问。', any: ['protectionlevel', 'shareduserid', '共享 uid', '同 uid', '绕过', '调用方'] },
          { label: '裁决依据三：看这个组件泄露/改动的数据是什么级别（这是"影响"，决定最终排序）', hint: '同样是越权，读到什么才算重要？', any: ['影响', '数据级别', '敏感', 'token', '凭据', '个人', '业务数据', '后果'] },
          { label: '方法论：把结论从"是/否"改成"在什么前提下成立"，并写明未验证的部分', hint: '两句话都不算错，但都不完整。', any: ['前提', '条件', '成立的条件', '未验证', '边界', '假设', '写清'] }
        ],
        hints: [
          '两个人说的其实都不是"风险"，而是"现象"和"需求"。把风险拆成因子，争论就会自动收敛。',
          '想一个具体的机制：有没有一种情况，组件明明没导出，别的 App 照样能访问？'
        ],
        probes: [
          '追问：什么机制会让"exported=false"的组件仍然能被外部访问？这对你的判定有什么影响？',
          '再追问：如果这个组件只是把一段公开的静态文本返回给调用方，你还会把它列为高危吗？为什么？'
        ],
        model: '<b>两个人说的都不是风险，甲说的是现象（导出多），乙说的是动机（产品需求）。</b>' +
          '裁决要把它们拆成因子。<br><br>' +
          '<b>风险的因子形式：风险 = 导出 × 保护缺口 × 内部行为的危险性。</b>三者缺一，等级就会掉下来。<br><br>' +
          '<b>甲对的条件：</b>导出、且保护无效（无权限，或权限是 normal/dangerous 级）、' +
          '且组件内部拿外部输入做了危险动作（拼路径、拼 SQL、当 URL 加载、当命令参数、直接改数据）。' +
          '三者同时成立时，这就是一个"任何 App 都能利用"的入口，高危没有争议。<br><br>' +
          '<b>乙对的条件：</b>导出确实是架构需求（比如自家两个 App 互通、或者要响应系统的隐式 Intent），' +
          '<b>但访问范围被真正收窄了</b>——signature 级权限、<span class="mono">sharedUserId</span>（同 UID 互信）、' +
          '或改用 FileProvider 只暴露一个子目录。这时候"导出"是设计的一部分，不是缺陷。<br><br>' +
          '<b>裁决用的三个可观测事实：</b><br>' +
          '① <b>能不能实测触发</b>：用 <span class="mono">am start</span> / <span class="mono">content query</span> / Drozer ' +
          '以第三方 App 身份真的调一次。能拉起 ≠ 能利用（可能还有权限检查），但"拉不起来"能直接结束争论。<br>' +
          '② <b>权限的真实级别 + 调用方是谁</b>：注意一个容易被忽略的机制——<b>同 UID（sharedUserId）的进程不受 exported 限制</b>，' +
          '所以"不导出"在共享 UID 的架构里本来就不是边界。审计时必须先确认有没有共享 UID。<br>' +
          '③ <b>这个组件碰的是什么数据</b>：越权读一段公开的帮助文本，和越权读 token/凭据/业务数据，影响差几个数量级。' +
          '把影响这一维加上，顺序才会稳定。<br><br>' +
          '<b>方法论上的收口：</b>这场争论的真正问题是两个人的结论都写成了"是/否"的断言。' +
          '正确的表达是<b>"在什么前提下成立"</b>：<span class="hit">' +
          '"如果 AdminPanel 的权限是 normal 级，任何 App 都能进，属高危；若是 signature 级，则只是架构选择，风险可接受（需确认无 sharedUserId）"</span>' +
          '——一句话就把两个人的条件都覆盖了，也把未验证的部分标了出来。' +
          '这就是评审意见和观点之间的差别。'
      },
      {
        id: 'c29q7', depth: 3, threshold: 0.7,
        q: '<b>综合题：</b>审计报告里 MobSF 报了 20 个"高危"，Drozer 一个组件问题都没扫出来。' +
          '请你设计一个能落地的处理方案：<b>怎么排序、先修什么、怎么验证修好了、以及 Drozer 没扫到这件事应该怎么写进报告</b>。',
        concepts: [
          { label: '先给报告"去噪"：静态扫描的高危里混着大量"可疑但不是可利用"，要人工过一遍可利用性', hint: '扫描器给的是候选，不是结论。', any: ['误报', '假阳性', '去噪', '人工', '可利用性', '候选', '筛选', '确认'] },
          { label: '排序因子：可利用性 × 影响 × 修复成本（导出且无保护 + 敏感数据 → 最前面）', hint: '用三个乘法因子排，不要按工具给的顺序。', any: ['可利用性', '影响', '修复成本', '排序', '优先级', '先修', '敏感数据'] },
          { label: '第一批修的：边界类、成本极低的（清单里把 exported 关掉 / 把权限升到 signature / 加 allowBackup=false）', hint: '有一类修复只要改一行。', any: ['改清单', 'exported', 'signature', 'allowbackup', '一行', '低成本的先做', '收敛边界'] },
          { label: '第二批：需要改代码的输入校验与路径/URL 处理（要做回归测试）', hint: '这一批的修复会碰业务逻辑。', any: ['输入校验', '路径', '归一化', 'url', '改代码', '回归', '测试'] },
          { label: '验证方法：修复后用"同一套动态手段"复验（am start 失败 / content query 被拒 / 无崩溃），并留下证据', hint: '修完要有反向证据。', any: ['复验', '验证', '再调一次', 'am start', 'content query', 'drozer', '被拒', 'securityexception', '证据'] },
          { label: 'Drozer 没扫到的正确写法：写"未发现"而不是"不存在"，注明覆盖范围、版本、以及它查不到的类型', hint: '工具的沉默不是证据。', any: ['未发现', '不等于不存在', '不能断定', '覆盖范围', '局限', '查不到', '业务逻辑', '版本'] },
          { label: '说明工具盲区的具体内容：Drozer 依赖模块与目标可交互，业务逻辑越权、需特定参数的路径、加固后的 native 逻辑它都覆盖不到', hint: '具体说出它查不到什么。', any: ['业务逻辑', '参数', 'native', '加固', '模块', '权限', '需要特定', '扫不到'] }
        ],
        hints: [
          '先把"20 个高危"当成 20 个候选，而不是 20 个结论。第一个动作是分类，不是动手修。',
          '再想：Drozer 扫不到，可能是"没有漏洞"，也可能是"它没能力发现"——这两种情况在报告里的写法完全不同。'
        ],
        probes: [
          '追问：如果修复必须排期三周，你会怎么和产品负责人解释"哪三个必须先修"？',
          '再追问：修完之后你怎么证明"它真的修好了"，而不是"这次没复现"？'
        ],
        model: '<b>处理方案分四段：分类 → 排序 → 修 → 复验。</b><br><br>' +
          '<b>① 分类（不要跳过这一步）。</b>把 MobSF 的 20 个"高危"重排成三类：<br>' +
          '· <b>真可利用</b>：导出且无有效保护，且组件内部做了危险操作 → 这是要修的；<br>' +
          '· <b>可疑但不可利用</b>：导出了但组件只显示静态内容、或需要系统级权限、或根本不是外部可达的路径 → 降级并写明理由；<br>' +
          '· <b>配置噪声</b>：意义有限但修起来极便宜（比如 <span class="mono">allowBackup</span>、' +
          '<span class="mono">debuggable</span> 残留、日志输出）→ 归到"顺手修"里。<br>' +
          '<span class="hit">扫描器给你的是候选清单，把它变成结论是你的工作。</span><br><br>' +
          '<b>② 排序：可利用性 × 影响 × 修复成本。先修同时满足"外部任意 App 可触发 + 碰敏感数据/可改状态 + 改一行清单"的项。</b><br>' +
          '典型第一批：把裸导出的组件 <span class="mono">exported="false"</span>；把内部互通用的权限升到 signature；' +
          '<span class="mono">allowBackup="false"</span>；关掉 WebView 的 file 域开关。' +
          '这一批的特点是<b>改清单/改一行配置、不碰业务逻辑、回归成本几乎为零</b>——所以应该第一个做，' +
          '它会立刻砍掉报告里最大的一块攻击面。<br><br>' +
          '<b>③ 第二批：需要改代码的输入校验、路径归一化、URL 白名单、Provider 的 openFile 重写。</b>' +
          '这一批要配回归测试，因为它会改变既有行为（比如原本能打开的 URI 现在被拒了）。<br><br>' +
          '<b>④ 复验（这一段的证据比修复本身更重要）。</b>用<b>同一套动态手段</b>再跑一遍：' +
          '导出的 Activity 现在 <span class="mono">am start</span> 应该报 SecurityException（Permission Denial）；' +
          '<span class="mono">content query</span> 读敏感表应该被拒；畸形 Intent 应该被静默丢弃而不是崩。' +
          '把命令和输出都留档——<b>"我修了"和"我证明它不可达了"是两份不同的交付。</b><br><br>' +
          '<b>⑤ Drozer 没扫到，报告里怎么写。</b>写"<b>未发现</b>"，不要写"不存在"。' +
          '并明确列出覆盖范围与盲区：<br>' +
          '· Drozer 的结论依赖它在你这个目标上能加载的模块、目标是否可交互、以及它有没有被反调试/加固挡住；' +
          '· <b>它查不到的典型类型</b>：需要特定业务参数才触发的越权、后端不校验导致的逻辑越权、' +
          '加固后的 native 逻辑、以及"组件能进但进去之后干什么"这一层。<br>' +
          '<span class="hit">工具的沉默只能证明"用这套手段没看见"，不能证明"没有"。</span>' +
          '把这句话写进报告，比多报一个高危更有价值——因为它决定了读报告的人下一次该补什么手段。'
      }
    ]
  }
};
