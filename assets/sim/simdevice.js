/* ==========================================================================
   SimDevice —— 假设备：虚拟文件系统 / 进程表 / logcat / 受控 shell
   --------------------------------------------------------------------------
   它不是 Linux。它是一张**明确的命令表**，每条命令都在虚拟文件系统上真操作；
   未知命令**明确报错**，不假装支持（见 PRACTICE-SPEC.md §5.4）。

   它也不是"事件回放器"：`am start` 会真的调用 SimNative 执行 native 算子，
   logcat 里的那个摘要值是真的算出来的。

   挂到 window.SIMDEVICE
   ========================================================================== */
(function (global) {
  'use strict';

  const dec = new TextDecoder('utf-8', { fatal: false });
  const enc = s => new TextEncoder().encode(s);
  const basename = p => p.replace(/\/+$/, '').split('/').pop();
  const dirname = p => { const t = p.replace(/\/+$/, ''); const i = t.lastIndexOf('/'); return i <= 0 ? '/' : t.slice(0, i); };

  /* 可打印才当文本显示，否则退回十六进制 —— 不猜、不美化 */
  function renderBytes(b, max) {
    const n = Math.min(b.length, max || 4096);
    let printable = 0;
    for (let i = 0; i < n; i++) if (b[i] === 9 || b[i] === 10 || (b[i] >= 32 && b[i] < 127)) printable++;
    if (n && printable / n > 0.9) return dec.decode(b.subarray(0, n));
    return hexdump(b, 0, n);
  }

  const HEX = '0123456789abcdef';
  function hexdump(b, off, len) {
    off = off || 0; len = Math.min(len === undefined ? 128 : len, b.length - off);
    let out = '';
    for (let i = 0; i < len; i += 16) {
      let ascii = '';
      const row = [];
      for (let j = 0; j < 16; j++) {
        const k = i + j;
        if (k < len) {
          const v = b[off + k];
          row.push(HEX[v >> 4] + HEX[v & 15]);
          ascii += (v >= 32 && v < 127) ? String.fromCharCode(v) : '.';
        } else { row.push('  '); ascii += ' '; }
      }
      out += (off + i).toString(16).padStart(8, '0') + '  ' + row.join(' ') + '  |' + ascii + '|\n';
    }
    return out.replace(/\n$/, '');
  }

  const SUPPORTED = ['ls', 'cat', 'strings', 'hexdump', 'ps', 'logcat', 'pm', 'am', 'getprop', 'id', 'uname', 'echo', 'help'];

  /* =====================================================================
     boot
       world = {
         device: { model, sdk, abi, serial },
         files:  { '/path': Uint8Array },
         apps:   [{ pkg, label, apkPath, soPath, native: { op, input, tag, fmt } }],
         props:  { 'ro.build.version.sdk': '31', ... },
         bootTrace: ['...', ...]
       }
       images = { '/path/to/libtarget.so': <SimNative 映像> }
     ===================================================================== */
  function boot(world, images) {
    const imgs = images || {};
    let clock = 0;

    const dev = {
      meta: Object.assign({ model: 'Pixel 6', sdk: 31, abi: 'arm64-v8a', serial: 'SIM0000' }, world.device || {}),
      files: {},
      logs: [],
      proc: [{ pid: 1, name: 'init', pkg: null }],
      bootTrace: (world.bootTrace || []).slice(),
      stats: { shellCalls: 0, launches: 0, failedLaunches: 0 }
    };
    for (const [p, v] of Object.entries(world.files || {})) dev.files[p] = v;
    dev.props = Object.assign({ 'ro.product.model': dev.meta.model, 'ro.build.version.sdk': String(dev.meta.sdk) }, world.props || {});

    const log = (tag, msg) => { dev.logs.push({ t: clock++, tag, msg: String(msg) }); };

    /* ---- 启动序列：真的写进 logcat ---- */
    for (const line of dev.bootTrace) log('boot', line);

    function pathsUnder(dir) {
      const d = dir.replace(/\/+$/, '');
      const out = [];
      for (const p of Object.keys(dev.files)) if (dirname(p) === (d || '/')) out.push(p);
      return out;
    }

    /* ---- 受控命令表 ---- */
    const cmds = {
      help: () => '支持的模拟命令：' + SUPPORTED.join(' / ') +
                  '\n（这是模拟 shell，不是真 Android shell。不支持的命令会明确报错。）',

      ls: a => {
        const dir = a[0] || '/';
        const files = pathsUnder(dir);
        if (!files.length) return { err: 'ls: ' + dir + ': 没有这个目录或目录为空', code: 1 };
        return files.map(p => basename(p)).sort().join('\n');
      },

      cat: a => {
        const f = dev.files[a[0]];
        if (!f) return { err: 'cat: ' + (a[0] || '') + ': 没有这个文件', code: 1 };
        return renderBytes(f);
      },

      strings: a => {
        const f = dev.files[a[0]];
        if (!f) return { err: 'strings: ' + (a[0] || '') + ': 没有这个文件', code: 1 };
        /* 从**原始字节**里扫可打印串，不是在 hexdump 输出里找 —— 那样找出来的是十六进制字符 */
        const out = [];
        let cur = '', start = 0;
        for (let i = 0; i <= f.length; i++) {
          const v = i < f.length ? f[i] : -1;
          if (v >= 32 && v < 127) { if (!cur) start = i; cur += String.fromCharCode(v); }
          else { if (cur.length >= 4) out.push((start.toString(16)).padStart(6, '0') + '  ' + cur); cur = ''; }
        }
        return out.length ? out.join('\n') : '(没有找到长度 ≥4 的可打印串)';
      },

      hexdump: a => {
        const f = dev.files[a[0]];
        if (!f) return { err: 'hexdump: ' + (a[0] || '') + ': 没有这个文件', code: 1 };
        const off = a[1] ? parseInt(a[1], 16) : 0;
        return hexdump(f, off, a[2] ? parseInt(a[2], 10) : 128);
      },

      ps: () => dev.proc.map(p => String(p.pid).padStart(6) + '  ' + (p.name || '') + (p.pkg ? '  (' + p.pkg + ')' : '')).join('\n'),

      logcat: a => {
        let rows = dev.logs;
        const si = a.indexOf('-s');
        if (si >= 0 && a[si + 1]) rows = rows.filter(r => r.tag === a[si + 1]);
        if (!rows.length) return '(logcat 为空)';
        return rows.map(r => String(r.t).padStart(6, '0') + '  ' + r.tag.padEnd(10) + '  ' + r.msg).join('\n');
      },

      pm: a => {
        if (a[0] !== 'list') return { err: "pm: 只支持 'pm list packages'", code: 1 };
        return (world.apps || []).map(x => 'package:' + x.pkg).join('\n') || '(没有已安装的应用)';
      },

      am: a => {
        if (a[0] !== 'start') return { err: "am: 只支持 'am start <包名>'", code: 1 };
        const pkg = a[1];
        const app = (world.apps || []).find(x => x.pkg === pkg);
        if (!app) return { err: 'am: 找不到包 ' + (pkg || ''), code: 1 };
        return launch(app);
      },

      getprop: a => {
        if (!a[0]) return Object.entries(dev.props).map(([k, v]) => '[' + k + ']: [' + v + ']').sort().join('\n');
        const v = dev.props[a[0]];
        return v === undefined ? '' : String(v);
      },

      id: () => 'uid=10123(u0_a123) gid=10123(u0_a123) groups=10123(u0_a123),3003(inet)',
      uname: () => 'Linux localhost 5.10.43-android12 ' + (dev.meta.abi || 'arm64-v8a') + ' #1 SMP PREEMPT',
      echo: a => a.join(' ')
    };

    /* ---- 启动应用：真的跑 native 算子 ---- */
    function launch(app) {
      dev.stats.launches++;
      const pid = 1000 + dev.stats.launches;
      dev.proc.push({ pid, name: app.label || app.pkg, pkg: app.pkg });
      log(app.pkg, 'ActivityManager: Start proc ' + pid + ':' + app.pkg);
      log(app.pkg, 'ActivityThread: Activity onCreate');

      const n = app.native;
      if (!n) { log(app.pkg, 'native 库未声明，应用停在 Java 层'); return 'Starting: Intent { act=android.intent.action.MAIN }'; }

      const img = imgs[app.soPath];
      if (!img) {
        dev.stats.failedLaunches++;
        log(app.pkg, 'Linker: 无法加载 ' + (app.soPath || '(未指定)'));
        return 'Starting: Intent { ... }  ⚠ native 库加载失败，详见 logcat';
      }

      let out;
      try {
        out = img.call(n.op, n.input);            // ← 真执行
      } catch (e) {
        dev.stats.failedLaunches++;
        log(app.pkg, 'Native: 调用 ' + n.op + ' 失败：' + e.message);
        return 'Starting: Intent { ... }  ⚠ native 调用失败，详见 logcat';
      }
      log(n.tag || 'Native', String(n.fmt || 'check() -> {out}').replace('{out}', out));
      return 'Starting: Intent { act=android.intent.action.MAIN cat=[android.intent.category.LAUNCHER] pkg=' + app.pkg + ' }';
    }

    /* ---- shell ---- */
    dev.shell = function (line) {
      dev.stats.shellCalls++;
      const s = String(line).trim();
      if (!s) return { out: '', err: '', code: 0 };
      const parts = s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
      const name = parts[0];
      const args = parts.slice(1).map(x => x.replace(/^["']|["']$/g, ''));
      const fn = cmds[name];
      if (!fn) {
        return { out: '', err: name + ': 未知命令（模拟 shell 不支持）\n支持：' + SUPPORTED.join(' / '), code: 127 };
      }
      try {
        const r = fn(args);
        if (r && typeof r === 'object' && r.err !== undefined) return { out: '', err: r.err, code: r.code || 1 };
        return { out: String(r), err: '', code: 0 };
      } catch (e) {
        return { out: '', err: name + ': ' + e.message, code: 1 };
      }
    };

    dev.launch = launch;
    dev.logcat = () => dev.logs.slice();
    dev.hexdump = hexdump;
    dev.renderBytes = renderBytes;
    return dev;
  }

  global.SIMDEVICE = { boot, hexdump, renderBytes, SUPPORTED };
})(window);
