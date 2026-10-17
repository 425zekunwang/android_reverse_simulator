/* ==========================================================================
   SimNative —— 原生映像的加载、读、改、调用
   --------------------------------------------------------------------------
   负责两件事：

   ① 把 SIMELF 生成的 libtarget.so 装载成"可操作的内存映像"：
      read(addr,n) / patch(addr,bytes) / 定位算子表

   ② 维护 SIM_NATIVE_OPS 算子白名单（见 PRACTICE-SPEC.md §5.3）。
      .text 里放的**不是 ARM 指令**，而是 {算子名 → .rodata 常量偏移} 的映射；
      算子本体只允许来自白名单，且只能调用 CRYPTO / LABX。

   硬规矩：关卡不能往产物里内联任意 JS。想加算子 → 往白名单加一条 + 在规范里登记。

   挂到 window.SIMNATIVE
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------------
     .text 算子表二进制格式（24 字节/条）
       offset 0 : 'SIM0'          4 字节 magic
       offset 4 : u32 version
       offset 8 : u32 count
       offset 12: count × { char name[16]; u32 constSize; u32 rodataOff }
     --------------------------------------------------------------------- */
  const TABLE_MAGIC = 0x53494d30;   // 'SIM0' 小端读出来就是这个数
  const TABLE_VER = 1;
  const ENTRY = 24;
  const TABLE_HEAD = 12;

  function tableSize(count) { return TABLE_HEAD + count * ENTRY; }

  function writeTable(count) {
    const b = new Uint8Array(tableSize(count));
    const dv = new DataView(b.buffer);
    dv.setUint32(0, TABLE_MAGIC, true);
    dv.setUint32(4, TABLE_VER, true);
    dv.setUint32(8, count, true);
    return b;
  }

  /* 往表里写第 i 条。name 必须 ≤15 字节 ASCII */
  function writeEntry(table, i, name, constSize, rodataOff) {
    const o = TABLE_HEAD + i * ENTRY;
    const nb = new TextEncoder().encode(name);
    if (nb.length > 15) throw new Error('算子名太长（≤15 字节）：' + name);
    table.set(nb, o);
    const dv = new DataView(table.buffer);
    dv.setUint32(o + 16, constSize, true);
    dv.setUint32(o + 20, rodataOff, true);
    return table;
  }

  /* =====================================================================
     算子白名单
     run(K, input) —— K 是 .rodata 里该算子的常量区，input 是输入字节
     ===================================================================== */
  const C = global.CRYPTO;
  const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const leWords = b => [le32(b, 0), le32(b, 4), le32(b, 8), le32(b, 12)];

  const SIM_NATIVE_OPS = {
    /* 魔改 IV 的摘要：K = 4 个小端 32 位初始状态字 */
    'md5-iv': {
      constSize: 16,
      desc: 'MD5（初始状态字由常量区给出）',
      run: (K, input) => C.toHex(C.md5(input, { iv: leWords(K) }))
    },
    /* 魔改多项式的 CRC32：K = 4 字节小端多项式 */
    'crc32-poly': {
      constSize: 4,
      desc: 'CRC32（多项式由常量区给出）',
      run: (K, input) => C.crc32(input, { poly: le32(K, 0) }).toString(16).padStart(8, '0')
    },
    /* 流密码：K = 变长密钥 */
    'rc4': {
      constSize: 0,          // 0 表示"长度由关卡在 sidecar 里给出"
      desc: 'RC4（密钥由常量区给出）',
      run: (K, input) => C.toHex(C.rc4(K, input))
    },
    /* 单块 AES：K = 16 字节密钥 */
    'aes-ecb': {
      constSize: 16,
      desc: 'AES 单块加密（密钥由常量区给出）',
      run: (K, input) => C.toHex(C.aesEncryptBlock(input.subarray(0, 16), C.aesKeyExpansion(K)))
    },
    /* 换表 Base64：K = 64 字节字母表 */
    'b64-custom': {
      constSize: 64,
      desc: 'Base64（字母表由常量区给出）',
      run: (K, input) => C.base64Encode(input, Array.from(K).map(x => String.fromCharCode(x)).join(''))
    }
  };

  /* =====================================================================
     装载
     ===================================================================== */
  function load(bytes) {
    const elf = global.SIMELF.parse(bytes);
    if (!elf.ok) throw new Error('装载失败：' + elf.err);

    const textSec = elf.section('.text');
    const rodataSec = elf.section('.rodata');
    if (!textSec) throw new Error('装载失败：缺少 .text 节');

    const dv = new DataView(elf.bytes.buffer, elf.bytes.byteOffset, elf.bytes.byteLength);
    if (dv.getUint32(textSec.offset, true) !== TABLE_MAGIC) throw new Error('装载失败：.text 算子表 magic 不匹配');
    const ver = dv.getUint32(textSec.offset + 4, true);
    if (ver !== TABLE_VER) throw new Error('装载失败：算子表版本 ' + ver + ' 不受支持');
    const count = dv.getUint32(textSec.offset + 8, true);

    const ops = [];
    for (let i = 0; i < count; i++) {
      const o = textSec.offset + TABLE_HEAD + i * ENTRY;
      let name = '';
      for (let k = 0; k < 16 && elf.bytes[o + k]; k++) name += String.fromCharCode(elf.bytes[o + k]);
      const constSize = dv.getUint32(o + 16, true);
      const rodataOff = dv.getUint32(o + 20, true);
      const spec = SIM_NATIVE_OPS[name];
      ops.push({
        name, constSize, rodataOff,
        known: !!spec,
        desc: spec ? spec.desc : '未知算子（不在白名单里）',
        addr: textSec.addr + TABLE_HEAD + i * ENTRY
      });
    }

    const img = {
      elf,
      bytes: elf.bytes,                 // 可变映像（patch 直接改这里）
      textAddr: textSec.addr,
      textSize: textSec.size,
      rodataAddr: rodataSec ? rodataSec.addr : 0,
      rodataSize: rodataSec ? rodataSec.size : 0,
      ops,
      /* —— 评分轴用的计数（PRACTICE-SPEC §5.8） —— */
      stats: { patchCount: 0, patchBytes: 0, hookCount: 0 },

      read(addr, n) { return this.bytes.subarray(addr, addr + n); },

      readRo(rodataOff, n) { return this.bytes.subarray(this.rodataAddr + rodataOff, this.rodataAddr + rodataOff + n); },

      /* 改映像。返回 false 表示越界 —— 关卡应当如实报错，不要静默成功 */
      patch(addr, data) {
        if (addr < 0 || addr + data.length > this.bytes.length) return false;
        this.bytes.set(data, addr);
        this.stats.patchCount++;
        this.stats.patchBytes += data.length;
        return true;
      },

      /* 取某个算子的常量区 */
      constOf(opName) {
        const op = this.ops.find(o => o.name === opName);
        if (!op) return null;
        const spec = SIM_NATIVE_OPS[opName];
        const n = spec && spec.constSize ? spec.constSize : op.constSize;
        return { op, bytes: this.readRo(op.rodataOff, n) };
      },

      /* 真调用：真的跑算法，不是查表。
         opts.instrumented = true 表示"这是你从外部插进去的调用"（Hook 控制台），
         只有这种才计入「注入面」。应用自己跑自己的例行不算注入 —— 那是它本来就会做的事。 */
      call(opName, input, opts) {
        const spec = SIM_NATIVE_OPS[opName];
        if (!spec) throw new Error('算子「' + opName + '」不在白名单里，拒绝执行');
        const got = this.constOf(opName);
        if (!got) throw new Error('映像里没有算子「' + opName + '」');
        if (opts && opts.instrumented) this.stats.hookCount++;
        return spec.run(got.bytes, input);
      }
    };

    return img;
  }

  global.SIMNATIVE = {
    load, writeTable, writeEntry, tableSize,
    SIM_NATIVE_OPS, le32, leWords,
    TABLE_MAGIC, TABLE_VER, ENTRY, TABLE_HEAD
  };
})(window);
