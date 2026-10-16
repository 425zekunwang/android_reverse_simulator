/* ==========================================================================
   Missions —— 实战关卡定义（数据）
   --------------------------------------------------------------------------
   引擎在 forge.js，关卡在这里。M1 阶段的关卡定义暂时放在本文件；
   M3 迁移时会挪进 chapters/chNN.js 的 lab.mission 字段（PRACTICE-SPEC.md §6）。

   每个关卡包含三段：
     spec        靶场产物怎么生成（喂给 FORGE.build）
     objective   怎么判对（value / state / differential）
     reference   官方参考解法 —— 它**只使用公开可见的数据**
                 （映像字节 / shell 输出），绝不读 art.truth。
                 否则校验就成了自证。

   挂到 window.SIM_MISSIONS
   ========================================================================== */
(function (global) {
  'use strict';

  const C = global.CRYPTO;
  const enc = s => new TextEncoder().encode(s);

  /* 从字节流里按小端读一个 u32 */
  const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  /* ======================================================================
     M22-1 · 从 libtarget.so 还原摘要算法 IV
     ----------------------------------------------------------------------
     设备上有个保险箱 App，它调用 libtarget.so 里的摘要例行校验口令。
     该例行用的是**被魔改过的初始状态字**。工单要求：把 4 个字还原出来。

     玩家路径：elfinfo 看节表 → hexdump 读 .rodata → 与标准 MD5 IV 比对
               → 发现只有 1 个字不同 → 提交。
     ====================================================================== */
  const M22_1 = {
    id: 'm22-1',
    chapter: 22,
    seed: 2201,                       // 决定靶场产物；换 seed 则答案跟着变（见 validate-missions ⑥）
    title: '从 libtarget.so 还原摘要算法 IV',
    /* 本关开放哪些面板。工单与提交面板永远在。 */
    tools: ['device', 'shell', 'image', 'hook'],
    brief: [
      '目标设备：Pixel 6 / Android 12 / arm64-v8a',
      '涉事应用：com.example.vault（保险箱）',
      '该应用启动时会调用 libtarget.so 里的摘要例行校验口令。',
      '例行内部的初始状态字被改过 —— 这是它和标准实现行为不一致的原因。',
      '你的任务：把这 4 个 32 位初始状态字还原出来。'
    ],
    acceptance: '提交 4 个 32 位初始状态字（各 8 位十六进制）。系统会用 8 组随机向量做功能对拍 —— 只有行为完全等价才算过。',
    hint: '先在 <b>映像</b> 面板把 <code>.rodata</code> 转储出来。里面有一个 16 字节的常量藏在噪声里，' +
          '和标准 MD5 的初始状态字（<code>67452301 efcdab89 98badcfe 10325476</code>）逐字比一比，' +
          '你会发现只有一个字不一样。',

    spec: {
      id: 'm22-1',
      device: { model: 'Pixel 6', sdk: 31, abi: 'arm64-v8a' },
      so: {
        path: '/data/app/com.example.vault/lib/arm64/libtarget.so',
        op: 'md5-iv',
        derive: 'md5-iv-mutate'
      },
      app: {
        pkg: 'com.example.vault',
        label: '保险箱',
        input: 'vault-unlock-key',
        logTag: 'vault-native',
        logFmt: 'check() digest = {out}'
      },
      props: {
        'ro.product.brand': 'sim',
        'ro.build.version.release': '12',
        'ro.build.version.security_patch': '2022-01-05'
      },
      bootTrace: [
        'init: 模拟设备启动（SimDevice）',
        'Zygote: 预加载完成',
        'SystemServer: 就绪',
        'PackageManager: 扫描到 1 个应用'
      ]
    },

    objective: {
      kind: 'differential',
      prompt: '提交 4 个 32 位初始状态字（十六进制，各 8 位）',
      fields: ['w0', 'w1', 'w2', 'w3'],

      /* 玩家提交的表单 → 4 个字。格式不对返回 null */
      parse: submit => {
        const out = [];
        for (const k of ['w0', 'w1', 'w2', 'w3']) {
          const s = String((submit || {})[k] || '').trim().replace(/^0[xX]/, '');
          if (!/^[0-9a-fA-F]{1,8}$/.test(s)) return null;
          out.push(parseInt(s, 16) >>> 0);
        }
        return out;
      },

      /* ★ 真的对拍：拿玩家的 IV 与真相的 IV，跑同一批随机消息 */
      run: (words, art) => {
        if (!words) return { ok: false, detail: '四个字都要填，且必须是 1–8 位十六进制' };
        const truth = art.truth.ivWords;
        const rng = global.FORGE.makeRng((art.seed ^ 0x5eed1234) >>> 0);
        const N = 8;
        for (let i = 0; i < N; i++) {
          const msg = rng.bytes(8 + rng.int(56));
          const got = C.toHex(C.md5(msg, { iv: words }));
          const want = C.toHex(C.md5(msg, { iv: truth }));
          if (got !== want) {
            return { ok: false, detail: '第 ' + (i + 1) + '/' + N + ' 组随机向量对不上 —— 行为不等价' };
          }
        }
        return { ok: true, detail: '8 组随机向量全部一致 —— 你还原的实现与目标行为等价' };
      }
    },

    /* ==================================================================
       官方参考解法
       ================================================================== */
    reference: {
      /* 玩家在模拟设备上会敲的命令（校验器会真的执行它们） */
      walkthrough: [
        'uname -a',
        'pm list packages',
        'am start com.example.vault',
        'logcat -s vault-native',
        'ls /data/app/com.example.vault/lib/arm64',
        'strings /data/app/com.example.vault/lib/arm64/libtarget.so',
        'hexdump /data/app/com.example.vault/lib/arm64/libtarget.so 0x1000 80'
      ],

      /* 作者在工作台里的路线。
         ★ 它是**可执行的操作表**，不是描述 —— 每个 op 对应工作台里一个真动作。
         「作者基线」由 SIMSCORE.replay 把这张表走一遍算出来，没有手写的数字；
         validate-missions 会真的重放它，并核对三轴与"这条路线确实能通关"。

         它是纯静态的：只查一次映像，一次都不碰目标。
         中间那条是人在脑子里的比对 —— 它不产生工具操作，所以不记步数，
         这正是"分析"和"敲命令"的区别，也是这条路线能做到 1 步的原因。 */
      route: [
        { op: 'image.hexdump', addr: 0x1000, len: 128,
          label: '映像 · 转储 .rodata（0x1000 起 128 字节）' },
        { op: 'note',
          label: '把 0x1020 起 16 字节与标准 MD5 IV 逐字比对' },
        { op: 'submit',
          label: '提交 4 个状态字' }
      ],

      /* ★ 解法：常量扫描。只读映像字节，不碰 art.truth。 */
      solve: art => {
        const soPath = art.public.soPath;
        const elf = global.SIMELF.parse(art.images[soPath]);
        if (!elf.ok) throw new Error('参考解法：ELF 解析失败 ' + elf.err);

        const ro = elf.section('.rodata');
        if (!ro) throw new Error('参考解法：映像里没有 .rodata');

        const STD = global.FORGE.MD5_STD_IV;
        let best = null;
        /* 逐字节滑动，找与标准 MD5 IV「最像」的 16 字节窗口 */
        for (let off = 0; off + 16 <= ro.size; off++) {
          let score = 0;
          const words = [];
          for (let i = 0; i < 4; i++) {
            const w = le32(elf.bytes, ro.offset + off + i * 4);
            words.push(w);
            if (w === STD[i]) score++;
          }
          if (!best || score > best.score) best = { off, score, words };
        }
        if (!best) throw new Error('参考解法：.rodata 太短');
        return { words: best.words, rodataOff: best.off, matchedStandardWords: best.score };
      }
    }
  };

  global.SIM_MISSIONS = { 'm22-1': M22_1 };
  global.SIM_MISSIONS_LIST = [M22_1];
})(window);
