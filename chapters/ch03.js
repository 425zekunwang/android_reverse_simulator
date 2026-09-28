/* 第 3 章数据 —— APK / DEX / ELF 文件格式解析
   --------------------------------------------------------------------------
   本章所有实验都是真算：下面的 FF28 按规范里的字段布局拼出样本字节，
   解析全部在 lab 的 run / expected 里逐字节进行，没有任何写死的结果。
   -------------------------------------------------------------------------- */
const FF28 = (function () {
  'use strict';
  const C = window.CRYPTO;

  /* ------------------------------------------------------------ 基础工具 */
  function norm(s) { return C.normHex(s || ''); }

  function toBytes(hex) {
    const h = norm(hex);
    if (!h.length) return null;
    if (h.length % 2) return null;
    const b = new Uint8Array(h.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
    return b;
  }
  function dv(b) { return new DataView(b.buffer, b.byteOffset, b.byteLength); }
  function u16at(d, o) { return d.getUint16(o, true); }
  function u32at(d, o) { return d.getUint32(o, true); }
  /* 本样本里所有 64 位字段都小于 2^32，所以高低两半分开读就够，
     不需要 BigInt —— 顺带说明：真实解析器必须按无符号 64 位处理。 */
  function u64at(d, o) { return d.getUint32(o, true) + d.getUint32(o + 4, true) * 4294967296; }
  function hexN(v, w) {
    let s = (v >>> 0).toString(16).toUpperCase();
    while (s.length < (w || 8)) s = '0' + s;
    return '0x' + s;
  }
  function hexLines(bytes, per) {
    const out = [];
    for (let i = 0; i < bytes.length; i += (per || 16)) {
      let s = '';
      for (let k = i; k < Math.min(bytes.length, i + (per || 16)); k++) {
        s += (s ? ' ' : '') + bytes[k].toString(16).padStart(2, '0');
      }
      out.push(s);
    }
    return out.join('\n');
  }

  /* ------------------------------------------------- 样本一：ELF 头部与两张表 */
  /* 这段字节是照 glibc elf.h 里的 Elf64_Ehdr / Elf64_Phdr / Elf64_Shdr 定义
     逐字段拼出来的「示教样本」，不是某个真实 .so 的 dump：
     为了让一次实验就能看全三张表，程序头表和节表被紧凑地排在头后面
     （真实 so 里节表通常贴在文件末尾）。字段的语义、宽度、顺序全部照规范。 */
  function elfBytes() {
    const a = [];
    const p = x => a.push(x & 0xff);
    const w16 = v => { p(v); p(v >>> 8); };
    const w32 = v => { p(v); p(v >>> 8); p(v >>> 16); p(v >>> 24); };
    const w64 = v => { w32(v); w32(0); };

    /* --- Elf64_Ehdr（0x00，共 64 字节） --- */
    p(0x7f); p(0x45); p(0x4c); p(0x46);   // EI_MAG0..3 = 7f 'E' 'L' 'F'
    p(2);                                  // EI_CLASS   = ELFCLASS64
    p(1);                                  // EI_DATA    = ELFDATA2LSB
    p(1);                                  // EI_VERSION = EV_CURRENT
    p(0);                                  // EI_OSABI   = ELFOSABI_SYSV
    p(0);                                  // EI_ABIVERSION
    for (let i = 0; i < 7; i++) p(0);      // EI_PAD
    w16(3);          // 0x10 e_type    = ET_DYN
    w16(183);        // 0x12 e_machine = EM_AARCH64（0xB7）
    w32(1);          // 0x14 e_version
    w64(0);          // 0x18 e_entry   —— so 的入口通常是 0
    w64(0x40);       // 0x20 e_phoff
    w64(0xe8);       // 0x28 e_shoff
    w32(0);          // 0x30 e_flags
    w16(64);         // 0x34 e_ehsize
    w16(56);         // 0x36 e_phentsize
    w16(3);          // 0x38 e_phnum
    w16(64);         // 0x3A e_shentsize
    w16(6);          // 0x3C e_shnum
    w16(5);          // 0x3E e_shstrndx

    /* --- 程序头表（0x40，3 × 56 字节） --- */
    const ph = (type, flags, off, vaddr, filesz, memsz, align) => {
      w32(type); w32(flags); w64(off); w64(vaddr); w64(vaddr); w64(filesz); w64(memsz); w64(align);
    };
    ph(1, 5, 0x0, 0x0, 0x2a10, 0x2a10, 0x1000);             // PT_LOAD   R+X
    ph(1, 6, 0x2a10, 0x3a10, 0x180, 0x2a0, 0x1000);         // PT_LOAD   R+W（memsz > filesz）
    ph(0x6474e552, 4, 0x2a10, 0x3a10, 0x180, 0x180, 1);     // PT_GNU_RELRO

    /* --- 节表（0xe8，6 × 64 字节） --- */
    const sh = (name, type, flags, addr, off, size, align) => {
      w32(name); w32(type); w64(flags); w64(addr); w64(off); w64(size);
      w32(0); w32(0); w64(align); w64(0);
    };
    sh(0, 0, 0x0, 0x0, 0x0, 0x0, 0);            // [0] SHT_NULL
    sh(1, 1, 0x6, 0x1a10, 0x1a10, 0x800, 4);    // [1] .text  ALLOC|EXECINSTR
    sh(7, 1, 0x2, 0x2210, 0x2210, 0x300, 8);    // [2] .rodata
    sh(15, 1, 0x3, 0x3a10, 0x2a10, 0x180, 8);   // [3] .data
    sh(21, 8, 0x3, 0x3b90, 0x2b90, 0x120, 8);   // [4] .bss（SHT_NOBITS）
    sh(26, 3, 0x0, 0x0, 0x2b90, 0x24, 1);       // [5] .shstrtab
    return a;
  }

  const PT_NAME = {
    0: 'PT_NULL', 1: 'PT_LOAD', 2: 'PT_DYNAMIC', 3: 'PT_INTERP', 4: 'PT_NOTE',
    6: 'PT_PHDR', 7: 'PT_TLS', 0x6474e550: 'PT_GNU_EH_FRAME',
    0x6474e551: 'PT_GNU_STACK', 0x6474e552: 'PT_GNU_RELRO', 0x6474e553: 'PT_GNU_PROPERTY'
  };
  const SHT_NAME = {
    0: 'SHT_NULL', 1: 'SHT_PROGBITS', 2: 'SHT_SYMTAB', 3: 'SHT_STRTAB', 4: 'SHT_RELA',
    6: 'SHT_DYNAMIC', 7: 'SHT_NOTE', 8: 'SHT_NOBITS', 9: 'SHT_REL', 11: 'SHT_DYNSYM',
    14: 'SHT_INIT_ARRAY', 15: 'SHT_FINI_ARRAY', 16: 'SHT_PREINIT_ARRAY', 17: 'SHT_GROUP'
  };
  function pFlags(f) {
    return (f & 4 ? 'R' : '-') + (f & 2 ? 'W' : '-') + (f & 1 ? 'X' : '-');
  }
  function shFlagText(f) {
    const o = [];
    if (f & 0x1) o.push('W');
    if (f & 0x2) o.push('A');
    if (f & 0x4) o.push('X');
    return o.length ? o.join('|') : '—';
  }

  /* ELF 头 + 两张表的解析器 —— 和实验里跑的是同一份代码 */
  function parseElf(hex) {
    const b = toBytes(hex);
    if (!b) return { ok: false, err: '十六进制不完整（位数必须是偶数，且不能为空）' };
    if (b.length < 64) return { ok: false, err: '至少需要 64 字节的 ELF 头，当前只有 ' + b.length + ' 字节' };
    const d = dv(b);
    if (!(b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46)) {
      return { ok: false, err: '开头不是 7f 45 4c 46（ELF 魔数），这不是一份 ELF 字节' };
    }
    const eh = {
      cls: b[4], data: b[5], version: b[6], osabi: b[7], abiver: b[8],
      type: u16at(d, 0x10), machine: u16at(d, 0x12), eversion: u32at(d, 0x14),
      entry: u64at(d, 0x18), phoff: u64at(d, 0x20), shoff: u64at(d, 0x28),
      flags: u32at(d, 0x30), ehsize: u16at(d, 0x34), phentsize: u16at(d, 0x36),
      phnum: u16at(d, 0x38), shentsize: u16at(d, 0x3a), shnum: u16at(d, 0x3c),
      shstrndx: u16at(d, 0x3e)
    };
    const phs = [];
    for (let i = 0; i < eh.phnum; i++) {
      const o = eh.phoff + i * eh.phentsize;
      if (o + 56 > b.length) break;
      phs.push({
        i: i, type: u32at(d, o), flags: u32at(d, o + 4),
        off: u64at(d, o + 8), vaddr: u64at(d, o + 0x10), paddr: u64at(d, o + 0x18),
        filesz: u64at(d, o + 0x20), memsz: u64at(d, o + 0x28), align: u64at(d, o + 0x30)
      });
    }
    const shs = [];
    for (let i = 0; i < eh.shnum; i++) {
      const o = eh.shoff + i * eh.shentsize;
      if (o + 64 > b.length) break;
      shs.push({
        i: i, name: u32at(d, o), type: u32at(d, o + 4), flags: u64at(d, o + 8),
        addr: u64at(d, o + 0x10), off: u64at(d, o + 0x18), size: u64at(d, o + 0x20),
        link: u32at(d, o + 0x28), info: u32at(d, o + 0x2c),
        addralign: u64at(d, o + 0x30), entsize: u64at(d, o + 0x38)
      });
    }
    const loads = phs.filter(x => x.type === 1);
    /* .text 这类节在这里没有名字可用（节名在 .shstrtab 里，不在本样本中），
       所以只能靠 SHF_EXECINSTR(0x4) 标志认出来 —— 这本身就是个知识点。 */
    const execs = shs.filter(x => x.flags & 0x4);
    const gaps = phs.filter(x => x.memsz > x.filesz);
    return {
      ok: true, bytes: b.length, eh: eh, phs: phs, shs: shs,
      loads: loads, execs: execs, gaps: gaps,
      bssGap: gaps.length ? gaps[0].memsz - gaps[0].filesz : 0,
      text: execs.length ? execs[0] : null
    };
  }

  /* ------------------------------------------------- 样本二：DEX 索引区片段 */
  /* 这是从一份 dex 里「切」出来的索引区 + 字符串数据片段，
     不含 header。布局（相对于片段起点）在实验说明里给出。 */
  const DEX_FRAG = {
    sidsOff: 0x00, sidsCount: 6,
    tidsOff: 0x18, tidsCount: 2,
    pidsOff: 0x20, pidsCount: 1,
    midsOff: 0x2c, midsCount: 1
  };
  const DEX_STR_BASE = 'https://api.example.com/v2/device/register?channel=google&locale=zh-CN&build=';
  function dexStrings() {
    let long = DEX_STR_BASE;
    while (long.length < 130) long += 'a';
    return ['getSign', 'Lcom/example/app/Sign;', 'Ljava/lang/String;', 'L', long, '签名校验'];
  }
  function dexBytes() {
    const strs = dexStrings();
    const L = DEX_FRAG;
    const dataOff = L.midsOff + L.midsCount * 8;
    const offs = [];
    let cur = dataOff;
    strs.forEach(s => {
      offs.push(cur);
      const u = utf16Size(s);
      cur += ulebSize(u) + utf8Len(s) + 1;
    });
    const a = [];
    const p = x => a.push(x & 0xff);
    const w16 = v => { p(v); p(v >>> 8); };
    const w32 = v => { p(v); p(v >>> 8); p(v >>> 16); p(v >>> 24); };
    offs.forEach(o => w32(o));                  // string_ids[6]
    w32(1); w32(2);                             // type_ids[2] → s1 / s2
    w32(3); w32(1); w32(0);                     // proto_ids[0]: shorty=s3, return=type1
    w16(0); w16(0); w32(0);                     // method_ids[0]: class=0, proto=0, name=s0
    strs.forEach(s => {
      const u = utf16Size(s);
      let v = u, first = true;
      while (v > 0x7f) { p((v & 0x7f) | 0x80); v = v >>> 7; first = false; }
      p(v & 0x7f);
      mutf8Bytes(s).forEach(x => p(x));
      p(0);
    });
    return a;
  }
  function utf16Size(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) { n += 2; i++; } else n += 1;
    }
    return n;
  }
  function ulebSize(v) { let n = 1; while (v > 0x7f) { v = v >>> 7; n++; } return n; }
  function utf8Len(s) { return mutf8Bytes(s).length; }
  /* MUTF-8：BMP 字符与 UTF-8 相同；U+0000 编成 C0 80，增补平面用代理对
     （每半各 3 字节）。这里只处理教学样本用到的 BMP 情况。 */
  function mutf8Bytes(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 0) { out.push(0xc0, 0x80); }
      else if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }
  function readMutf8(b, off, len) {
    let s = '', i = off, end = off + len;
    while (i < end) {
      const b0 = b[i];
      if (b0 < 0x80) { s += String.fromCharCode(b0); i += 1; }
      else if ((b0 & 0xe0) === 0xc0) { s += String.fromCharCode(((b0 & 0x1f) << 6) | (b[i + 1] & 0x3f)); i += 2; }
      else if ((b0 & 0xf0) === 0xe0) {
        s += String.fromCharCode(((b0 & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f)); i += 3;
      } else { s += '?'; i += 1; }
    }
    return s;
  }
  function uleb(b, off) {
    let r = 0, shift = 0, n = 0, x;
    do {
      x = b[off + n];
      r += (x & 0x7f) * Math.pow(2, shift);
      shift += 7; n++;
      if (n > 5) break;
    } while (x & 0x80);
    return { v: r, n: n };
  }

  function parseDexFrag(hex) {
    const b = toBytes(hex);
    if (!b) return { ok: false, err: '十六进制不完整（位数必须是偶数，且不能为空）' };
    const L = DEX_FRAG;
    if (b.length < L.midsOff + 8) return { ok: false, err: '片段太短：至少需要 ' + (L.midsOff + 8) + ' 字节' };
    const d = dv(b);
    const sids = [];
    for (let i = 0; i < L.sidsCount; i++) sids.push(u32at(d, L.sidsOff + i * 4));
    const tids = [];
    for (let i = 0; i < L.tidsCount; i++) tids.push(u32at(d, L.tidsOff + i * 4));
    const pids = [];
    for (let i = 0; i < L.pidsCount; i++) {
      const o = L.pidsOff + i * 12;
      pids.push({ shorty: u32at(d, o), ret: u32at(d, o + 4), params: u32at(d, o + 8) });
    }
    const mids = [];
    for (let i = 0; i < L.midsCount; i++) {
      const o = L.midsOff + i * 8;
      mids.push({ cls: u16at(d, o), proto: u16at(d, o + 2), name: u32at(d, o + 4) });
    }
    const strings = sids.map(off => {
      if (off >= b.length) return { bad: true, off: off };
      const u = uleb(b, off);
      /* 用 MUTF-8 编出来的字符串里不会出现 0x00 字节，所以第一个 0 就是结尾 */
      let n = 0;
      while (off + u.n + n < b.length && b[off + u.n + n] !== 0) n++;
      return { off: off, utf16: u.v, ulebBytes: u.n, byteLen: n, s: readMutf8(b, off + u.n, n) };
    });
    const m0 = mids[0];
    /* strings[i] 就是「第 i 个字符串」，所以 char/type/proto 里的下标要直接当数组下标用；
       而 string_ids[i] 里存的是偏移，不是下标 —— 这两件事容易混。 */
    const name = strings[m0.name];
    const cls = strings[tids[m0.cls]];
    const proto = pids[m0.proto];
    const ret = strings[tids[proto.ret]];
    const shorty = strings[proto.shorty];
    return {
      ok: true, bytes: b.length, sids: sids, tids: tids, pids: pids, mids: mids,
      strings: strings, dataOff: L.midsOff + L.midsCount * 8,
      name: name, cls: cls, ret: ret, shorty: shorty, proto: proto
    };
  }

  /* ------------------------------------------------- 样本三：APK 末尾 256 字节 */
  function apkSample() {
    const FILE_SIZE = 0x4000, TAIL = 0x100;
    /* 中央目录里一条 classes.dex 的记录：46 字节定长头 + 11 字节文件名 = 57 */
    const cdRec = [];
    const p = x => cdRec.push(x & 0xff);
    const w16 = v => { p(v); p(v >>> 8); };
    const w32 = v => { p(v); p(v >>> 8); p(v >>> 16); p(v >>> 24); };
    w32(0x02014b50); w16(0x0014); w16(0x0014); w16(0); w16(8); w16(0); w16(0x21);
    w32(0x12345678); w32(0x1000); w32(0x2000); w16(11); w16(0); w16(0); w16(0); w16(0);
    w32(0); w32(0);
    'classes.dex'.split('').forEach(ch => p(ch.charCodeAt(0)));
    const cdSize = cdRec.length;
    const eocdOff = FILE_SIZE - 22;
    const cdOff = eocdOff - cdSize;
    const pairs = 72;
    const blockSize = 8 + pairs + 8 + 16 - 8;
    const blockStart = cdOff - 8 - blockSize;
    const a = [];
    const q = x => a.push(x & 0xff);
    const q16 = v => { q(v); q(v >>> 8); };
    const q32 = v => { q(v); q(v >>> 8); q(v >>> 16); q(v >>> 24); };
    const q64 = v => { q32(v); q32(0); };
    while (a.length < blockStart) q(0x11);
    q64(blockSize);
    q64(4 + 60);            // id-value 对的 length（含 4 字节 ID）
    q32(0x7109871a);        // APK Signature Scheme v2 的 block ID
    for (let i = 0; i < 60; i++) q(0xab);
    q64(blockSize);
    'APK Sig Block 42'.split('').forEach(ch => q(ch.charCodeAt(0)));
    cdRec.forEach(x => q(x));
    q32(0x06054b50); q16(0); q16(0); q16(1); q16(1);
    q32(cdSize); q32(cdOff); q16(0);
    const tail = a.slice(FILE_SIZE - TAIL);
    return { tail: tail, fileSize: FILE_SIZE, tailStart: FILE_SIZE - TAIL, cdSize: cdSize, cdOff: cdOff, eocdOff: eocdOff, blockStart: blockStart, blockSize: blockSize };
  }

  function findEocd(b) {
    const d = dv(b);
    for (let i = b.length - 22; i >= 0; i--) if (u32at(d, i) === 0x06054b50) return i;
    return -1;
  }

  function parseApkTail(hex, fileSize) {
    const b = toBytes(hex);
    if (!b) return { ok: false, err: '十六进制不完整（位数必须是偶数，且不能为空）' };
    if (b.length < 22) return { ok: false, err: '末尾片段至少要 22 字节（EOCD 的最小长度）' };
    const size = Number(fileSize);
    if (!size || size < b.length) return { ok: false, err: '文件总大小必须填一个不小于片段长度的数字（可直接填十进制字节数，如 16384）' };
    const d = dv(b);
    const eocdIn = findEocd(b);
    if (eocdIn < 0) return { ok: false, err: '在这段字节里找不到 EOCD 签名 50 4b 05 06' };
    const commentLen = u16at(d, eocdIn + 20);
    const eocdOff = size - 22 - commentLen;
    const tailStart = size - b.length;
    if (eocdOff < tailStart) {
      return { ok: false, err: '按「文件大小 − 22 − 注释长度」算出的 EOCD 位置（' + eocdOff + '）落在给定片段之前，说明文件大小或片段给错了' };
    }
    const cdSize = u32at(d, eocdIn + 12);
    const cdOff = u32at(d, eocdIn + 16);
    const at = cdOff - tailStart;
    let magic = '', blockStart = -1, blockSize = -1, sigId = -1, sigIdOff = -1;
    if (at - 16 >= 0 && at <= b.length) {
      for (let i = 0; i < 16; i++) magic += String.fromCharCode(b[at - 16 + i]);
      if (magic === 'APK Sig Block 42') {
        if (at - 24 >= 0) {
          blockSize = u64at(d, at - 24);
          blockStart = cdOff - blockSize - 8;
          if (at - 8 >= 0) {
            /* 从块首往后走 ID-value 对，找 v2 的 block ID。
               注意 at 已经是「片段内偏移」，所以 cur 也是片段内偏移。 */
            const pairsStart = at - blockSize;
            const pairsEnd = at - 24;
            let cur = pairsStart;
            while (cur + 12 <= pairsEnd && cur + 12 <= b.length) {
              const len = u64at(d, cur);
              const id = u32at(d, cur + 8);
              if (sigId < 0) { sigId = id; sigIdOff = cur; }
              if (len < 8) break;
              cur += 8 + len;
            }
          }
        }
      }
    }
    return {
      ok: true, bytes: b.length, fileSize: size, tailStart: tailStart,
      eocdIn: eocdIn, eocdOff: eocdOff, commentLen: commentLen,
      cdSize: cdSize, cdOff: cdOff, magic: magic,
      blockStart: blockStart, blockSize: blockSize, sigId: sigId
    };
  }

  return {
    elfBytes: elfBytes, elfHex: function () { return hexLines(elfBytes(), 16); },
    dexBytes: dexBytes, dexHex: function () { return hexLines(dexBytes(), 16); },
    apkSample: apkSample, apkHex: function () { return hexLines(apkSample().tail, 16); },
    parseElf: parseElf, parseDexFrag: parseDexFrag, parseApkTail: parseApkTail,
    PT_NAME: PT_NAME, SHT_NAME: SHT_NAME, pFlags: pFlags, shFlagText: shFlagText,
    hexN: hexN, hexLines: hexLines, DEX_FRAG: DEX_FRAG,
    uleb: uleb, ulebSize: ulebSize
  };
})();

window.CHAPTER = {
  no: 3,
  title: 'APK / DEX / ELF 文件格式解析',
  lede: '逆向遇到的第一个问题永远是「东西在哪」。' +
        '<strong>APK 是信封，DEX 是信纸，so 是随信附的一张只有机器看得懂的图纸</strong>——' +
        '三种格式管三件完全不同的事，混在一起就会在最基础的地方反复卡住。' +
        '这一章把三者都拆到字节：谁在哪个偏移上放了什么，以及每个字段能帮你判断什么。',
  meta: [
    '核心问题：<b>拿到一个 APK，从哪里开始看？</b>',
    '关键机制：<b>zip 三段结构 / dex 索引区 / ELF 的段与节</b>',
    '对手：<b>重打包后的签名校验、抽取壳、被抹掉节表的 so</b>'
  ],

  sections: [
    /* ============================================================ 3.1 */
    {
      h: '3.1', title: '三种格式的关系：先建立一张地图',
      intuition: {
        tag: '直觉模型 · 集装箱、信纸、零件图纸',
        body:
          '<p>把一次 Android 安装想象成一次海运：</p>' +
          '<ul>' +
          '<li><b>APK 是集装箱</b>——它自己不装货，只负责把东西按规矩码好、贴上报关单（签名），让系统能一次验完、一次拆完。' +
          '它用的就是最普通的 zip 格式，所以任何一个解压工具都能打开它。</li>' +
          '<li><b>DEX 是装在箱子里的信纸</b>——写给 ART 看的，是与 CPU 无关的字节码。同一份 dex，在 ARM 手机和 x86 模拟器上跑的是同一条指令流。</li>' +
          '<li><b>so（ELF）是随信附的一张精密图纸</b>——写给 CPU 看的机器码。它不认 ART，只认寄存器、栈和指令编码。</li>' +
          '</ul>' +
          '<p>这个类比真正的用处，是它直接决定<b>你该去哪一层找答案</b>：想知道 App 有几个入口、有没有加固，看集装箱；' +
          '想改一行逻辑，动信纸（dex）；想找加密算法的实现，翻图纸（so）。' +
          '<span class="hit">用错层，是这类工作里最浪费时间的错。</span></p>'
      },
      html:
        '<p>先把三者的分工摆清楚。这张表值得你先记住「谁生成、谁消费、逆向时在哪一步用」三列——' +
        '后面每一节都是在填这张表的细节。</p>' +
        T.tbl(
          ['', 'APK', 'DEX', 'so（ELF）'],
          [
            ['<b>本质</b>', 'zip 归档（容器）', 'Dalvik 字节码 + 索引元数据', '机器码 + 链接信息'],
            ['<b>谁生成</b>', '<code>aapt2</code> / <code>d8</code> / <code>zipalign</code> / <code>apksigner</code>',
             '<code>d8</code> 或 <code>R8</code>（编译期）', '<code>clang</code>（NDK 工具链）'],
            ['<b>谁消费</b>', 'PackageManager、ART', 'ART（解释 / JIT / AOT）', 'linker + CPU'],
            ['<b>管什么</b>', '打包、对齐、签名', '类 / 方法 / 字段 / 字符串', '段 / 节 / 符号 / 重定位'],
            ['<b>逆向第一步看它</b>', '有几个 dex、几个 so、有没有签名块',
             '<code>magic</code> 版本、<code>class_defs_size</code>', '<code>e_machine</code>、<code>PT_LOAD</code> 权限、节表在不在'],
            ['<b>典型对手</b>', '重打包后的签名校验', '抽取壳（抽走 <code>insns</code>）', '抹节表 / 整体加密 / 自定义 Loader']
          ]
        ) +
        T.note('key', '🔑 三者之间的边界，比它们的内部结构更重要',
          '<p>三条边界值得先记住，它们决定了「什么问题只能在哪一层解决」：</p>' +
          '<p style="margin-bottom:0">' +
          '① <b>dex 里没有机器码</b>。dex 是给虚拟机看的中间表示，反编译出的 Java 代码和最终执行的指令之间隔着一层 ART。' +
          '所以「dex 里看不到算法细节」是正常的，不是被加密了。<br>' +
          '② <b>so 里没有类和方法的语义</b>。ELF 只有符号和地址；<code>Java_com_x_y_Method</code> 这种名字只是<b>一个字符串</b>，' +
          '是约定的命名规则让它有了意义（第 9 章）。<br>' +
          '③ <b>APK 不认识 dex，也不认识 ELF</b>。它只按 zip 的规矩装东西；' +
          '所以「APK 打不开」和「dex 解不开」是两个完全不同的问题，排查方向也完全不同。</p>') +
        '<p>下面这份演示稿把这章的知识骨架先铺一遍。如果你完全没接触过这三种格式，' +
        '先翻完它再往下读，会比直接啃字段表轻松很多。</p>',
      deck: {
        title: '知识骨架 · 三种容器格式的一张总图',
        slides: [
          {
            kicker: 'CH28 · 地图',
            title: '三种容器，三件不同的事',
            body:
              '<p><b>APK</b>：zip 归档，负责打包与签名。<br>' +
              '<b>DEX</b>：与 CPU 无关的字节码 + 索引元数据，给 ART 用。<br>' +
              '<b>so（ELF）</b>：机器码 + 链接信息，给 linker 和 CPU 用。</p>' +
              '<p>它们不是同一个东西的三个版本，而是<b>三层不同的抽象</b>。' +
              '任何一句「这个 App 用了 XX 加固」，都要先落到其中一层，才知道该动什么。</p>',
            foot: '先分层，再谈技术'
          },
          {
            kicker: 'CH28 · APK',
            title: 'APK = zip 三段 + 一个签名块',
            body:
              '<p>zip 永远是三段：<b>本地文件头+数据</b>（每个 entry 一组）→ <b>中央目录</b>（entry 索引）→ ' +
              '<b>EOCD</b>（索引的索引，在文件最末尾）。</p>' +
              '<p>Android 在中间插了一手：<b>APK Signing Block</b> 被插在中央目录之前，装 v2/v3 签名。' +
              '这一个动作就是「改完 APK 就装不上」的全部原因。</p>',
            foot: '结构决定后果'
          },
          {
            kicker: 'CH28 · DEX',
            title: 'DEX = 索引区 + 数据区',
            body:
              '<p>112 字节 header 之后，是六个<b>定长索引区</b>：字符串、类型、原型、字段、方法、类定义。' +
              '索引区里不存内容，只存「到数据区的偏移」。</p>' +
              '<p>这样做的收益是<b>去重 + 定长寻址</b>；代价是每次取值都要多跳一次，' +
              '而且字符串长度不定，必须用 <b>uleb128</b> 当前缀。</p>',
            foot: '一切设计都有代价'
          },
          {
            kicker: 'CH28 · ELF',
            title: 'ELF 有两套视角：段和节',
            body:
              '<p><b>段（program header）</b>给装载器看：运行时要按页映射、要设置权限，所以段必须是页对齐的粗粒度块。</p>' +
              '<p><b>节（section header）</b>给链接器和分析者看：代码、数据、符号表、重定位表，粒度细、有语义。</p>' +
              '<p>所以 <b>strip 只影响节，不影响段</b>；加固抹掉节表，程序照样能跑。</p>',
            foot: '运行时按段，分析时按节'
          },
          {
            kicker: 'CH28 · 判断',
            title: '拿到一个 APK，先用字段做排除法',
            body:
              '<p>不装任何工具也能判断很多事：<code>classes.dex</code> 的 <code>class_defs_size</code> 是不是个位数、' +
              '<code>method_ids_size</code> 和代码规模是否匹配、<code>insns_size</code> 是否成片为 0。</p>' +
              '<p>so 那边看 <code>e_machine</code> 对不对、<code>PT_LOAD</code> 权限是不是 rwx、节表还在不在。</p>',
            foot: '本章最后会把这张体检表列全'
          }
        ]
      },
      after:
        T.note('ok', '✅ 这一节要留下的东西',
          '<p style="margin-bottom:0">你不是要背下 zip 或 ELF 的字段表，而是要建立一条<b>定位反射</b>：' +
          '看到「App 装不上」先想到签名块，看到「方法体是空的」先想到 dex 的 <code>code_item</code>，' +
          '看到「so 读不出函数名」先分清是节表没了还是符号表没了。' +
          '<span class="hit">本章后面每一节，都是给其中一条反射补上字节级的证据。</span></p>')
    },

    /* ============================================================ 3.2 */
    {
      h: '3.2', title: 'APK 的 zip 布局：三段结构和一个反着读的习惯',
      html:
        '<p>APK 就是一个 zip。这句话听着简单，但它带来一个非常实际的操作习惯：' +
        '<strong>解析 zip 要从文件尾部往前读</strong>，而不是从头往后读。</p>' +
        '<p>原因是 zip 的三段结构本身就是为「追加写」设计的：</p>' +
        '<ol>' +
        '<li><b>本地文件头 + 数据</b>：每一个被打包的文件都有一份自己的头（30 字节定长 + 文件名 + 扩展字段），后面紧跟着它的数据。' +
        '这一段是「边写边追加」的，头部里并不记录整包有几项。</li>' +
        '<li><b>中央目录（Central Directory）</b>：全部文件写完以后，再回头写一张总索引，每条记录 46 字节定长 + 文件名 + 扩展字段，' +
        '并且记录每个文件「本地头在文件里的偏移」。</li>' +
        '<li><b>EOCD（End Of Central Directory）</b>：最后 22 字节（不含注释），记录中央目录的<b>偏移</b>和<b>大小</b>、' +
        '条目总数、以及一段可变长度的注释。</li>' +
        '</ol>' +
        '<p>于是就有了那条习惯：<b>找 EOCD → 读出中央目录的偏移和大小 → 顺着中央目录拿到每个文件的位置</b>。' +
        '反过来从文件头开始扫，你会在「数据里恰好出现 50 4b 03 04」这种假签名上不断翻车。</p>' +
        T.tbl(
          ['结构', '签名（小端）', '定长部分', '里面最关键的东西'],
          [
            ['本地文件头', '<code>50 4b 03 04</code>（<code>PK\\x03\\x04</code>，0x04034b50）', '30 字节',
             '压缩方法、压缩/未压缩大小、<b>文件名</b>、扩展字段长度（zipalign 的对齐填充藏在扩展字段里）'],
            ['中央目录项', '<code>50 4b 01 02</code>（0x02014b50）', '46 字节',
             '<b>本地头在文件里的偏移</b>、外部属性、注释长度'],
            ['中央目录结束', '<code>50 4b 05 06</code>（0x06054b50）', '22 字节',
             '<b>中央目录大小与偏移</b>、条目总数、注释长度']
          ]
        ) +
        T.card('EOCD 的 22 个字节，逐字段排一遍',
          T.tbl(
            ['偏移', '宽度', '字段', '为什么重要'],
            [
              ['0x00', '4', 'signature = 0x06054b50', '从文件尾部往前搜它，是定位一切的第一步'],
              ['0x04', '2', '本磁盘号', '分卷 zip 才用；APK 里恒为 0'],
              ['0x06', '2', '中央目录起始磁盘号', '同上'],
              ['0x08', '2', '本磁盘条目数', 'APK 里与总数相同'],
              ['0x0A', '2', '条目总数', '可用来交叉验证你解析中央目录的结果'],
              ['0x0C', '4', '中央目录大小', '配合偏移算出中央目录区间'],
              ['0x10', '4', '中央目录偏移', '<b>最关键的一个字段</b>——签名块就贴在它前面'],
              ['0x14', '2', '注释长度', '决定「文件末尾 22 字节」这个假设对不对']
            ]
          ) +
          '<p style="margin-bottom:0">注意最后一行：<b>注释长度是可变的</b>，所以 EOCD 并不一定在文件的最后 22 字节，' +
          '它的位置是「文件末尾 22 + 注释长度」。正确做法是从尾部往前最多搜 65557 字节（22 + 65535 找签名），' +
          '而不是只看最后 22 字节。这一点在下一节的实验里会真实算一遍。</p>') +
        T.note('warn', '⚠️ APK 的 zip 和「普通 zip」的三处差异',
          '<p style="margin-bottom:0">' +
          '① <b>对齐</b>：<code>zipalign</code> 会在每个文件的扩展字段里插填充，让数据的起始偏移按 4 字节（或页）对齐。' +
          '这是为了让 <code>mmap</code> 能直接映射不压缩的资源，也意味着<b>扩展字段长度不是你能随手改的</b>。<br>' +
          '② <b>不压缩的条目</b>：<code>resources.arsc</code>、「已经是压缩格式」的资源和某些 <code>classes.dex</code> 会以' +
          '<code>method = 0</code>（stored）方式存放，方便直接映射。<br>' +
          '③ <b>多出来的一块</b>：Android 7.0 之后，中央目录前面会多一个 <b>APK Signing Block</b>。' +
          '它不在 zip 规范里，是 Android 自己加的「夹层」——下一节整节讲它。</p>'),
      quiz: {
        id: 'q28-1', chapter: 28, answer: 1,
        stem: '你要手工解析一个 APK 的 zip 结构。为什么第一步应该从文件<b>末尾</b>往前找 EOCD，而不是从文件开头往后扫？',
        options: [
          { t: '因为 zip 的数据是倒着存的，从后往前读效率更高。',
            why: 'zip 里没有任何数据是倒着存的。中央目录和 EOCD 都在后面，但每个文件的数据仍然是正序的。' },
          { t: '因为文件开头的本地文件头里不记录「一共有多少项、中央目录在哪」，这两件事只有文件末尾的 EOCD 知道。',
            why: '<b>正确。</b>zip 是追加写格式：写的时候并不知道最终有几项，所以总数与中央目录位置只能在收尾时写进 EOCD。' },
          { t: '因为 EOCD 里有文件大小，先读它才能知道要读多少字节。',
            why: 'EOCD 里其实没有「文件大小」这个字段（APK Signing Block 里有一个 size，但不是文件大小）。文件大小来自文件系统，不来自 zip 结构。' },
          { t: '因为很多 APK 的头部被加固改了，只有尾部是可信的。',
            why: '「头部被改」不是 zip 解析必须从尾部开始的原因。即使一个完全正常的、未加固的 zip，也必须从尾部开始定位。' }
        ],
        explain:
          '<p>zip 的三段结构本质上是<b>「先写内容、最后写索引」</b>。' +
          '本地文件头里只有「我自己这一项」的信息（名字、大小、压缩方法），它<b>不知道全局</b>；' +
          '全局信息（条目总数、中央目录位置与长度）全部集中在 EOCD。</p>' +
          '<p>所以正确的读取顺序是：<br>' +
          '① 从文件尾部往前搜 <code>50 4b 05 06</code>；<br>' +
          '② 用「文件大小 − 22 − 注释长度」校验这个 EOCD 的位置是否自洽；<br>' +
          '③ 读出中央目录偏移与大小；<br>' +
          '④ 顺着中央目录逐项读，每一项再用「本地头偏移」回到前半部分取数据。</p>' +
          '<p><b>顺带记住那两个可变长度</b>：EOCD 后面可以有注释（所以 EOCD 不在最后 22 字节处），' +
          '本地头和中央目录记录后面都可以有扩展字段（所以定长部分之后不是数据，而是「文件名 + 扩展字段」）。' +
          '任何按「定长之后立刻是数据」写的解析器，一定会在真实的 APK 上崩掉。</p>'
      }
    },

    /* ============================================================ 3.3 */
    {
      h: '3.3', title: 'APK 里到底装了什么：二进制 XML、资源表、dex 和 so',
      html:
        '<p>把 APK 解开，你看到的目录结构其实非常固定。先把清单过一遍，然后重点说前两项——' +
        '它们是新手最容易踩坑的地方。</p>' +
        T.tbl(
          ['路径', '是什么', '逆向时怎么用'],
          [
            ['<code>AndroidManifest.xml</code>', '<b>编译后的二进制 XML</b>（不是文本！）',
             '入口 Activity、权限、组件导出属性、<code>application:name</code>（壳的入口常常写在这里）'],
            ['<code>resources.arsc</code>', '编译后的资源表（二进制）',
             '字符串、尺寸、颜色等资源的「ID → 值」映射；加固常在这里塞猫腻'],
            ['<code>res/</code>', '资源文件（图片、布局 XML 的二进制版）', '界面定位、敏感字符串'],
            ['<code>classes.dex</code> / <code>classes2.dex</code> …', 'Dalvik 字节码（多 dex）',
             '<b>主战场</b>。第 16 章讲 header，本节之后讲全貌'],
            ['<code>lib/&lt;abi&gt;/lib*.so</code>', '按 ABI 分目录的 ELF 共享库',
             '算法、协议签名、反调试、加固壳的核心通常在这里'],
            ['<code>assets/</code>', '原样打包的任意文件（不参与资源编译）',
             '壳常把加密后的真 dex 放这里；插件化框架也用它'],
            ['<code>META-INF/</code>', 'v1（JAR）签名与清单', '<code>MANIFEST.MF</code> / <code>CERT.SF</code> / <code>CERT.RSA</code>'],
            ['<code>kotlin/</code> / <code>org/</code> / <code>okhttp3/</code> …', '第三方库自带的资源或元数据', '用于快速判断用了哪些框架']
          ]
        ) +
        T.note('bad', '🔥 第一个坑：AndroidManifest.xml 不是文本文件',
          '<p>用编辑器打开它，你看到的是乱码——因为它是 <b>编译后的二进制 XML（AXML）</b>。' +
          '不是「被加密了」，也不是「被加固了」，而是 aapt2 在编译期做了两件事：</p>' +
          '<p style="margin-bottom:0">' +
          '① <b>字符串池化</b>：所有标签名、属性名、字符串值被收集到一张字符串池里，正文里只留下池内下标；<br>' +
          '② <b>属性名替换成资源 ID</b>：<code>android:name</code> 这类属性在文件里是一个 4 字节整数（形如 <code>0x0101xxxx</code>），' +
          '不再是一段文本。</p>' +
          '<p>所以「看懂 AndroidManifest」这件事，本质上就是<b>先解 chunk、再把下标查回字符串</b>。' +
          '这也是为什么几乎所有工具（apktool、jadx、aapt2）都能还原它——还原规则是完全公开的。</p>') +
        T.card('二进制 XML 的 chunk 结构（值取自 AOSP <code>ResourceTypes.h</code>）',
          '<p>整个文件是一串 chunk，每个 chunk 的头部固定 8 字节：<code>type</code>（u2）、<code>headerSize</code>（u2）、' +
          '<code>size</code>（u4，含头部本身）。文件第一个 chunk 的 <code>type</code> 一定是 <code>0x0003</code>（<code>RES_XML_TYPE</code>），' +
          '所以 <code>AndroidManifest.xml</code> 的<b>前 4 个字节是 <code>03 00 08 00</code></b>（type=3、headerSize=8）。</p>' +
          T.tbl(
            ['常量', '值', '含义'],
            [
              ['<code>RES_STRING_POOL_TYPE</code>', '<code>0x0001</code>', '字符串池（紧跟文件头）'],
              ['<code>RES_XML_TYPE</code>', '<code>0x0003</code>', '整个二进制 XML 的根 chunk'],
              ['<code>RES_XML_START_NAMESPACE_TYPE</code>', '<code>0x0100</code>', '命名空间开始'],
              ['<code>RES_XML_END_NAMESPACE_TYPE</code>', '<code>0x0101</code>', '命名空间结束'],
              ['<code>RES_XML_START_ELEMENT_TYPE</code>', '<code>0x0102</code>', '<b>开始标签</b>（属性挂在它下面）'],
              ['<code>RES_XML_END_ELEMENT_TYPE</code>', '<code>0x0103</code>', '结束标签'],
              ['<code>RES_XML_CDATA_TYPE</code>', '<code>0x0104</code>', '文本节点'],
              ['<code>RES_XML_RESOURCE_MAP_TYPE</code>', '<code>0x0180</code>', '「属性资源 ID → 字符串池下标」的映射表'],
              ['<code>RES_TABLE_TYPE</code>', '<code>0x0002</code>', '<code>resources.arsc</code> 的根 chunk']
            ]
          )) +
        T.note('key', '🔑 resources.arsc 的前 4 个字节是 02 00 0C 00',
          '<p style="margin-bottom:0">它的根 chunk 是 <code>RES_TABLE_TYPE</code>（<code>0x0002</code>），' +
          '头部比普通的 8 字节多一个 <code>packageCount</code>（u4），所以 <code>headerSize = 12</code>。' +
          '于是文件开头是 <code>02 00 0C 00</code>——<span class="hit">这是一个很好用的快速指纹</span>：' +
          '拿到一个未知文件，看前 4 字节就能区分「二进制 XML（03 00 08 00）」和「资源表（02 00 0C 00）」。<br>' +
          '资源表内部再分成「包 → 类型 → 配置」三层，每层的 chunk type 见上表最后一行往外延伸（<code>0x0200</code> 包、' +
          '<code>0x0201</code> 类型数据、<code>0x0202</code> 类型规格）。</p>') +
        T.note('warn', '⚠️ 一个反复出现的误区：apktool 能还原 ≠ apktool 还原后还是原来那个 APK',
          '<p style="margin-bottom:0">apktool 把二进制 XML 还原成可读文本，改完再重新编译打包。' +
          '但「重新打包」意味着 zip 结构被重写：条目顺序、扩展字段、对齐填充、中央目录偏移，全都会变。' +
          '这直接导致 v2/v3 签名失效——这是下一节的主题。' +
          '<span class="hit">所以「改完资源后装不上」绝大多数不是改错了，而是签名问题。</span></p>')
    },

    /* ============================================================ 3.4 */
    {
      h: '3.4', title: 'v1 / v2 / v3 签名：为什么「改完 APK 就装不上」',
      html:
        '<p>这是本章最实用的一节。很多人第一次改 APK 的体验都是：改一个字符串 → 重新打包 → 安装失败。' +
        '然后开始怀疑人生。其实原因非常结构化，而且完全可以从字节上看出来。</p>' +
        T.tbl(
          ['', 'v1（JAR 签名）', 'v2（APK Signature Scheme v2）', 'v3（v2 + 密钥轮替）'],
          [
            ['引入版本', '一直都有', '<b>Android 7.0</b>', '<b>Android 9</b>'],
            ['保护范围', '每个 entry 的<b>内容摘要</b>（写在 <code>META-INF/MANIFEST.MF</code>）',
             '<b>全文件</b>：entry 数据 + 中央目录 + EOCD 三段一起摘要', '同 v2，另加密钥轮替证明'],
            ['zip 元数据', '<b>不保护</b>（可以插未签名文件、改扩展字段）', '<b>全部覆盖</b>', '<b>全部覆盖</b>'],
            ['签名放哪', '<code>META-INF/</code> 下的三个文件', '中央目录<b>之前</b>的 APK Signing Block', '同一个 Signing Block，不同 block ID'],
            ['被绕过的经典手法', '往 zip 里塞 <code>MANIFEST.MF</code> 不覆盖的文件（Janus 漏洞）', '无（改一个字节就废）', '同 v2'],
            ['改完重打包怎么办', '重新生成三个签名文件', '<b>必须用 <code>apksigner</code> 重新签</b>', '<b>同 v2</b>']
          ]
        ) +
        T.card('APK Signing Block 的结构：一前一后各一个 size，中间是 ID-value 对',
          '<p>它的格式非常短，全部记住只要四行：</p>' +
          T.code(
            '<span class="c">// APK Signing Block 的布局（全部小端）</span>\n' +
            'uint64  size          <span class="c">// 本块长度，不含这个字段自己</span>\n' +
            '<span class="c">// 一串 ID-value 对，紧挨着：</span>\n' +
            'uint64    pairLength  <span class="c">// 本对长度，含下面 4 字节的 ID</span>\n' +
            'uint32    pairId      <span class="c">// 0x7109871a = v2；0xf05368c0 = v3</span>\n' +
            'byte[]    pairValue   <span class="c">// 长度 = pairLength - 4</span>\n' +
            'uint64  size          <span class="c">// 与第一个 size 相同（重复一遍）</span>\n' +
            'byte[16] magic        <span class="c">// ASCII "APK Sig Block 42"</span>'
          ) +
          '<p style="margin-bottom:0">两个 size 字段是刻意重复的：验证方从<b>尾部</b>先读 magic 确认这里确实是签名块，' +
          '再读第二个 size 得到块长度，然后跳到块首，用第一个 size 做<b>交叉校验</b>。' +
          '两头对得上，才说明这个块是完整的。</p>') +
        T.note('key', '🔑 五分钟记住的定位算法（下一节的实验会让你真的算一遍）',
          '<p style="margin-bottom:0">' +
          '① 从文件尾往前找 EOCD（<code>50 4b 05 06</code>）；<br>' +
          '② 从 EOCD 读出中央目录偏移 <code>cdOffset</code>；<br>' +
          '③ 看 <code>cdOffset − 16</code> 起的 16 字节是不是 <code>APK Sig Block 42</code>——是，就说明有 v2/v3 签名；<br>' +
          '④ 读 <code>cdOffset − 24</code> 处的 u64（第二个 size）；<br>' +
          '⑤ 块起始位置 = <code>cdOffset − 8 − size</code>。' +
          '<span class="hit">五步全是加减法，不需要任何工具。</span></p>') +
        '<p>把这几步画出来，就很容易理解「为什么改了内容签名就废」：</p>',
      stage: {
        title: 'APK 的三段结构与签名块：改一个字节，谁发现了',
        speed: 1700,
        render:
          '<div class="flow-col" style="gap:9px">' +
            '<div class="flow-row">' +
              '<span class="pill mono">文件开头</span>' +
              '<span class="blk" id="a1">本地文件头 + 数据（classes.dex / res / lib…）</span>' +
              '<span class="blk" id="a2">APK Signing Block</span>' +
              '<span class="blk" id="a3">中央目录</span>' +
              '<span class="blk" id="a4">EOCD</span>' +
            '</div>' +
            '<div class="flow-row" style="margin-left:6px">' +
              '<span class="arrow">↑ 位置关系：</span>' +
              '<span class="blk" id="a5">签名块夹在「数据」和「中央目录」之间</span>' +
            '</div>' +
            '<div class="flow-row" style="padding-top:8px;border-top:1px dashed var(--line)">' +
              '<span class="blk" id="b1">改一个字节：dex 里的字符串</span>' +
            '</div>' +
            '<div class="flow-row" style="margin-left:20px"><span class="arrow">↓</span></div>' +
            '<div class="flow-row">' +
              '<span class="blk" id="b2">v1（JAR）：只比对 MANIFEST 里记的摘要 → 可能发现</span>' +
              '<span class="arrow">/</span>' +
              '<span class="blk" id="b3">v2 / v3：全文件摘要 → 必然失效</span>' +
            '</div>' +
            '<div class="flow-row" style="margin-top:6px">' +
              '<span class="pill bad" id="mark">结论：重打包必须重新签名</span>' +
            '</div>' +
          '</div>',
        reset: () => {
          ['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2', 'b3'].forEach(i => S(i, ''));
          CLS('mark', 'pill bad');
          SET('mark', '结论：重打包必须重新签名');
        },
        steps: [
          { run: () => S('a1', 'active'),
            note: '<b>先看正常 APK 的样子。</b>文件绝大部分是「本地文件头 + 数据」：每个 entry 一份头（30 字节定长 + 文件名 + 扩展字段），' +
                  '后面跟着它的数据。这一段的顺序、对齐、压缩方式，全部由打包工具决定。' },
          { run: () => { S('a1', 'done'); S('a2', 'hot'); },
            note: '<b>v2/v3 的签名块插进来了。</b>它不在 zip 规范里，是 Android 自己加的夹层，' +
                  '位置<b>精确地</b>在中央目录之前。<span class="hit">这个位置不是随便选的</span>：' +
                  '这样它既能覆盖前面的数据区，又能让老版本系统（只认 zip）把它当成「中央目录之前的垃圾数据」忽略掉——' +
                  '这是 v2 能兼容旧系统的关键。' },
          { run: () => { S('a2', 'done'); S('a3', 'active'); },
            note: '<b>中央目录。</b>它是 entry 的总索引：每条 46 字节，记录文件名、压缩方式、以及每个 entry 本地头在文件里的偏移。' +
                  '签名块插在它前面，会<b>把中央目录整体往后推</b>——所以 EOCD 里记录的 <code>cdOffset</code> 也随之改变。' },
          { run: () => { S('a3', 'done'); S('a4', 'active'); },
            note: '<b>EOCD。</b>22 字节，记录中央目录的偏移和大小。定位签名块的入口就在这里：' +
                  '先从尾部找到 EOCD，读出 <code>cdOffset</code>，再往它前面 16 字节看有没有 <code>APK Sig Block 42</code>。' },
          { run: () => { S('a4', 'done'); S('a5', 'cool'); },
            note: '<b>位置关系固定下来。</b>于是「这个 APK 有没有 v2/v3 签名」变成了一道纯算术题：' +
                  '看 <code>cdOffset − 16</code> 那 16 个字节。有就是有，没有就是没有，不需要任何工具。' },
          { run: () => { S('a5', 'done'); S('b1', 'hot'); },
            note: '<b>现在动手改一个字节。</b>假设你把 dex 里某个字符串改了（这也是最常做的事）。' +
                  '<span class="hit">注意：你只改了数据区里的一个字节，zip 的三段结构没有动。</span>' },
          { run: () => { S('b2', 'active'); S('b3', 'active'); },
            note: '<b>v1 和 v2 的分岔点就在这里。</b>' +
                  'v1 只保护「每个 entry 的内容摘要」——它<b>理论上</b>能发现 dex 被改了，' +
                  '但它<b>不保护 zip 的元数据</b>：你可以往包里插一个 MANIFEST 没有列的文件，v1 完全看不见。' +
                  'v2/v3 则把「entry 数据 + 中央目录 + EOCD」当一整块做摘要，' +
                  '<b>而且签名块自身被排除在摘要之外</b>（否则就成了循环依赖）。' },
          { run: () => { S('b1', 'done'); S('b2', 'done'); S('b3', 'bad'); CLS('mark', 'pill bad'); SET('mark', 'v2/v3：改一个字节 = 摘要全变 = 签名作废'); },
            note: '<b>为什么 v2 是「必然失效」。</b>因为摘要覆盖了数据区，改一个字节哈希就完全变了。' +
                  '这不是「校验很严」的问题，而是<b>全文件签名的定义</b>。' +
                  '所以结论只有一句：<span class="hit">重打包之后必须用 apksigner 重新签一遍，没有例外。</span>' },
          { run: () => { S('b3', 'done'); CLS('mark', 'pill ok'); SET('mark', '✅ 重签即可安装——但「能装上」不等于「能跑」'); },
            note: '<b>但是——</b>重新签名会改变签名本身。如果 App（或它的服务端）拿<b>签名摘要</b>当身份标识，' +
                  '你重签之后身份就变了：轻则功能异常，重则直接被判定为篡改。' +
                  '<span class="hit">「能装上」和「能跑通」是两件事，这一步是很多人在第 4 章才会撞上的墙。</span>' }
        ]
      },
      lab: {
        title: '实验：只用一段末尾字节，定位 APK Signing Block',
        goal: '目标：算出 EOCD / 中央目录 / 签名块的位置',
        intro:
          '<p>下面是一个 APK 文件<b>最后 256 字节</b>的十六进制（不是整个文件）。这段字节里包含三样东西：' +
          'APK Signing Block 的开头部分、中央目录里一条 <code>classes.dex</code> 的记录、以及 EOCD。</p>' +
          '<p><b>已知条件：</b>整个文件大小是 <code>16384</code> 字节（十进制）；文件末尾没有 zip 注释。</p>' +
          '<p><b>任务：</b>① 算出 EOCD 在文件里的绝对偏移；② 从 EOCD 里读出中央目录的偏移；' +
          '③ 顺着 <code>中央目录偏移 − 16</code> 处的 <code>APK Sig Block 42</code> 魔数，' +
          '算出签名块的<b>起始偏移</b>；④ 用自己的话说清「为什么改完 APK 重打包就装不上」。</p>' +
          '<p class="muted">提示：所有数字都可以写成十六进制（带 <code>0x</code> 或不带都行）或十进制。' +
          '偏移是从<b>文件开头</b>算的，不是从这段片段开头算的。</p>',
        inputs: [
          { key: 'tail', label: '文件末尾 256 字节（十六进制）',
            hint: '按 16 字节一行读起来最省事', type: 'textarea', rows: 8,
            value: FF28.apkHex() },
          { key: 'size', label: '① 文件总大小（字节）', hint: '题面已给：16384', ph: '例如 16384' },
          { key: 'eocd', label: '② EOCD 的绝对偏移', hint: '文件大小 − 22 − 注释长度', ph: '例如 0x3FEA' },
          { key: 'cd', label: '③ 中央目录的偏移（从 EOCD 里读）', hint: 'EOCD 偏移 0x10 处的 u32', ph: '例如 0x3FB1' },
          { key: 'sign', label: '④ 签名块的起始偏移', hint: '中央目录偏移 − 8 − 末尾那个 u64', ph: '例如 0x3F49' },
          { key: 'why', label: '⑤ 为什么改完 APK 重新打包就装不上？',
            hint: '要说清「谁保护了什么」', type: 'textarea', rows: 3, ph: '因为……' }
        ],
        runLabel: '🔍 解析末尾字节',
        autorun: true,
        run: v => {
          const r = FF28.parseApkTail(v.tail || '', v.size || '');
          if (!r.ok) return '<div class="lab-msg warn"><b>先别急</b><div class="lab-note">' + r.err + '</div></div>';
          const h = x => FF28.hexN(x, 8);
          let out = '<div class="lab-kv">' +
            '<span>片段长度 <b>' + r.bytes + '</b> 字节</span>' +
            '<span>文件总大小 <b>' + r.fileSize + '</b></span>' +
            '<span>片段起点 <b>' + h(r.tailStart) + '</b></span></div>';
          out += '<table class="lab-tbl"><tr><th>步骤</th><th>算式</th><th>结果</th></tr>' +
            '<tr><td>搜到 EOCD 签名</td><td>片段内偏移 0x' + r.eocdIn.toString(16).toUpperCase() + '</td>' +
              '<td>绝对偏移 <code>' + h(r.eocdOff) + '</code> = ' + r.eocdOff + '</td></tr>' +
            '<tr><td>注释长度</td><td>EOCD + 0x14 处的 u16</td><td><code>' + r.commentLen + '</code></td></tr>' +
            '<tr class="diff"><td><b>中央目录</b></td><td>EOCD + 0x10 处的 u32</td>' +
              '<td><code>' + h(r.cdOff) + '</code> = ' + r.cdOff + '，大小 <code>' + r.cdSize + '</code> 字节</td></tr>' +
            '<tr><td>魔数检查</td><td>中央目录偏移 − 16 起的 16 字节</td>' +
              '<td>' + (r.magic === 'APK Sig Block 42'
                ? '<code>"' + r.magic + '"</code> ✅ 有签名块'
                : '<code>"' + r.magic + '"</code> ❌ 不是签名块') + '</td></tr>' +
            (r.blockStart >= 0
              ? '<tr class="diff"><td><b>签名块起点</b></td><td>' + h(r.cdOff) + ' − 8 − ' + h(r.blockSize) + '</td>' +
                '<td><code>' + h(r.blockStart) + '</code> = ' + r.blockStart + '</td></tr>' +
                '<tr><td>块内第一个 ID-value 对</td><td>块首 + 8 处的 u64 / + 16 处的 u32</td>' +
                '<td>ID <code>' + h(r.sigId) + '</code>' + (r.sigId === 0x7109871a ? ' → APK Signature Scheme v2 ✅' : '') + '</td></tr>'
              : '<tr><td>签名块</td><td>—</td><td>这个 APK 没有 v2/v3 签名块</td></tr>') +
            '</table>';
          out += '<div class="lab-msg key"><b>🔑 这一串算式的意义</b><div class="lab-note">' +
            '签名块的位置<b>完全由中央目录的偏移决定</b>，而中央目录的偏移又写在 EOCD 里。' +
            '这意味着：只要你动了数据区（哪怕一个字节），v2/v3 的全文件摘要就变了；' +
            '而只要你重新打包，中央目录和 EOCD 也会变——<b>两头都躲不掉</b>。</div></div>';
          return out;
        },
        expected: v => {
          const r = FF28.parseApkTail(v.tail || '', v.size || '');
          if (!r.ok) return { ok: false, detail: '解析失败：' + r.err + '<br>先把上面的「文件总大小」填对（16384），片段不要改动。' };
          const eq = (ans, val) => {
            const s = String(ans == null ? '' : ans).replace(/[\s,]/g, '').replace(/^0x/i, '').toLowerCase();
            if (!s) return false;
            const hx = parseInt(s, 16);
            const de = parseInt(s, 10);
            return hx === val || de === val;
          };
          const sizeOk = eq(v.size, r.fileSize);
          const eocdOk = eq(v.eocd, r.eocdOff);
          const cdOk = eq(v.cd, r.cdOff);
          const signOk = eq(v.sign, r.blockStart);
          const whyOk = window.AKKC_hasConcept(v.why || '',
            ['全文件', '整个文件', '签名块', '签名分块', '摘要', '哈希', 'hash', 'digest', '中央目录', 'EOCD',
             'v2', 'v3', '重新签名', '重签', 'apksigner', '任何一个字节', '改一个字节', '内容变了']);
          const one = (ok, good, bad) => ok ? '✅ ' + good : '❌ ' + bad;
          return {
            ok: sizeOk && eocdOk && cdOk && signOk && whyOk,
            detail:
              one(sizeOk, '文件大小对', '文件大小应是 <b>' + r.fileSize + '</b>（题面已给）') + '<br>' +
              one(eocdOk, 'EOCD 偏移对：' + r.eocdOff + '（' + FF28.hexN(r.eocdOff, 8) + '）',
                'EOCD 偏移 = 文件大小 − 22 − 注释长度 = ' + r.fileSize + ' − 22 − ' + r.commentLen + ' = <b>' + r.eocdOff + '</b>') + '<br>' +
              one(cdOk, '中央目录偏移对：' + r.cdOff + '（' + FF28.hexN(r.cdOff, 8) + '）',
                '中央目录偏移在 EOCD 的 +0x10 处，应读成 <b>' + r.cdOff + '</b>（' + FF28.hexN(r.cdOff, 8) + '）') + '<br>' +
              one(signOk, '签名块起点对：' + r.blockStart + '（' + FF28.hexN(r.blockStart, 8) + '）',
                '签名块起点 = 中央目录偏移 − 8 − 末尾 size = ' + r.cdOff + ' − 8 − ' + r.blockSize + ' = <b>' + r.blockStart + '</b>') + '<br>' +
              one(whyOk, '原因说到了关键：全文件摘要 + 重打包改变了中央目录/EOCD',
                '原因要说到：v2/v3 是对「entry 数据 + 中央目录 + EOCD」做<b>全文件摘要</b>，改内容或重新打包都会让摘要变，' +
                '签名随之失效，必须重新签。')
          };
        },
        showAnswer:
          '【已知】文件大小 = 16384（0x4000）；注释长度 = 0\n\n' +
          '① EOCD 偏移\n' +
          '   = 文件大小 − 22 − 注释长度\n' +
          '   = 16384 − 22 − 0 = 16362 = 0x3FEA\n' +
          '   （在给定的 256 字节片段里，它位于片段内偏移 0xEA 处）\n\n' +
          '② 中央目录偏移：读 EOCD 的 +0x10 字段（u32，小端）\n' +
          '   字节：B1 3F 00 00  →  0x00003FB1 = 16305\n' +
          '   中央目录大小：EOCD 的 +0x0C（u32）= 0x39 = 57 字节\n' +
          '   （57 = 46 字节定长记录 + 11 字节文件名 "classes.dex"，没有扩展字段）\n\n' +
          '③ 签名块起点\n' +
          '   a. 看 中央目录偏移 − 16 = 16305 − 16 = 16289 起 16 字节\n' +
          '      = "APK Sig Block 42"  ✅ 这里确实有签名块\n' +
          '   b. 读 中央目录偏移 − 24 = 16281 处的 u64 = 0x60 = 96\n' +
          '      （这是块长度，不含最前面那个 size 字段）\n' +
          '   c. 签名块起点 = 中央目录偏移 − 8 − 96\n' +
          '                = 16305 − 104 = 16201 = 0x3F49\n' +
          '   校验：块内第一个 ID-value 对的 ID = 0x7109871a → 这正是 v2\n\n' +
          '④ 为什么改完重打包就装不上\n' +
          '   v2/v3 是【全文件签名】：它把「entry 数据 + 中央目录 + EOCD」\n' +
          '   三段一起做摘要，签名块自身被排除（避免循环依赖）。\n' +
          '   于是两种改动都会失效：\n' +
          '     · 改了 dex 里一个字节 → 数据区变了 → 摘要变\n' +
          '     · 用 apktool 重新打包 → 中央目录、EOCD 全被重写 → 摘要变\n' +
          '   唯一出路是用 apksigner 重新签一遍。\n' +
          '   但注意：重签会换掉签名本身，靠签名摘要做身份校验的 App 会立刻发现。',
        hint:
          '<b>第一步不是找签名块，是找 EOCD。</b>EOCD 的签名是 <code>50 4b 05 06</code>，' +
          '在给出的片段里从后往前搜就能看到。<br><br>' +
          '<b>第二个提示：</b>片段是「文件末尾 256 字节」，所以「片段内偏移 + 片段起点」才是绝对偏移。' +
          '片段起点 = 文件大小 − 256 = 16384 − 256 = 16128 = 0x3F00。<br><br>' +
          '<b>第三个提示：</b>签名块末尾固定是 16 字节魔数 + 8 字节 size。所以它的起点要从中央目录偏移往前倒推：' +
          '<code>cdOffset − 8 − size</code>。',
        after:
          T.note('ok', '✅ 实验的收获',
            '<p style="margin-bottom:0">你现在可以<b>不打开任何工具</b>，只靠一段十六进制回答三个问题：' +
            '这个 APK 有没有 v2/v3 签名、签名块在哪、我改完要做什么。<br>' +
            '<span class="hit">更重要的是你理解了「结构性原因」和「操作建议」的区别：' +
            '前者是签名算法覆盖了哪些字节，后者才是「用 apksigner 重签」。' +
            '只记住操作建议的人，遇到 v4 签名或者自定义校验时会完全不知道该怎么办。</span></p>')
      }
    },

    /* ============================================================ 3.5 */
    {
      h: '3.5', title: 'DEX 结构总览：索引区这个设计解决了什么问题',
      intuition: {
        tag: '直觉模型 · 图书馆的索引卡柜',
        body:
          '<p>想象一座图书馆。书是随便堆的（长度不一、位置不定），但门口有一排<b>索引卡柜</b>：' +
          '每个柜子的抽屉<b>尺寸完全一样</b>，第 N 号抽屉里放着一张卡片，写着「书名在书库的第几米处」。</p>' +
          '<p>要找第 1327 号方法名，你不需要从头翻书库，只要：' +
          '抽第 1327 号抽屉（<b>一步到位，因为抽屉等宽</b>）→ 拿到书库偏移 → 走过去，' +
          '先在书脊上读一个「长度」标签（因为书的长短不一）→ 再读书名。</p>' +
          '<p>dex 的六个索引区就是这排柜子，<code>data</code> 区就是书库。' +
          '<span class="hit">等宽抽屉换来 O(1) 定位，代价是每次都要多跳一次，而且书库里每本书必须自带长度标签。</span>' +
          '这个设计取舍解释了你后面会遇到的几乎每一个 dex 细节。</p>'
      },
      html:
        '<p>第 16 章已经把 112 字节的 <code>header_item</code> 逐字段拆过一遍，这里不重复。' +
        '本节只回答一个问题：<b>header 之后，一个 dex 到底是怎么组织的？</b></p>' +
        '<p>完整的布局顺序是这样的（偏移全部来自 header 里的字段）：</p>' +
        T.code(
          '<span class="c">// dex 文件的自上而下布局</span>\n' +
          'header_item        <span class="c">// 0x00，固定 112 字节 —— 它就是整份文件的「地图」</span>\n' +
          'string_ids[]       <span class="c">// 每条 4 字节：指向 string_data_item 的偏移</span>\n' +
          'type_ids[]         <span class="c">// 每条 4 字节：指向 string_ids 的下标（类型描述符）</span>\n' +
          'proto_ids[]        <span class="c">// 每条 12 字节：shorty / 返回类型 / 参数列表</span>\n' +
          'field_ids[]        <span class="c">// 每条 8 字节：类 / 类型 / 名字，各是一个下标</span>\n' +
          'method_ids[]       <span class="c">// 每条 8 字节：类 / 原型 / 名字，各是一个下标</span>\n' +
          'class_defs[]       <span class="c">// 每条 32 字节：类的完整定义（含 class_data_off / code 的入口）</span>\n' +
          'data[]             <span class="c">// 变长数据：字符串、code_item、重定位表、调试信息……</span>\n' +
          'map_list           <span class="c">// 一条 map_item 数组，声明「上面这些东西各自在哪、有多大」</span>'
        ) +
        T.tbl(
          ['索引区', '单条大小', '一条里装的是什么', '要跳几次才能拿到真东西'],
          [
            ['<code>string_ids</code>', '4 字节', '一个偏移 → <code>string_data_item</code>', '2 跳（索引 → 偏移 → uleb128 + MUTF-8）'],
            ['<code>type_ids</code>', '4 字节', '一个下标 → <code>string_ids</code>', '3 跳（类型 → 字符串索引 → 偏移 → 内容）'],
            ['<code>proto_ids</code>', '12 字节', '<code>shorty_idx</code> / <code>return_type_idx</code> / <code>parameters_off</code>', '3–4 跳'],
            ['<code>field_ids</code>', '8 字节', '<code>class_idx</code>(u2) / <code>type_idx</code>(u2) / <code>name_idx</code>(u4)', '3 跳'],
            ['<code>method_ids</code>', '8 字节', '<code>class_idx</code>(u2) / <code>proto_idx</code>(u2) / <code>name_idx</code>(u4)', '3 跳'],
            ['<code>class_defs</code>', '32 字节', '类定义本身：8 个 u4，含 <code>class_data_off</code>、<code>source_file_idx</code> 等', '结构最重，第 3.6 节专门拆']
          ]
        ) +
        T.note('key', '🔑 为什么 dex 不直接存字符串',
          '<p>如果每个方法名都直接写在自己的记录里，会有两个后果：</p>' +
          '<p>① <b>同一个名字会被存很多遍</b>。一个 App 里 <code>toString</code> 可能被几千个地方引用，' +
          '直接内联就意味着几千份拷贝。<b>索引 + 一张全局字符串表</b>让同名只存一份——这是压缩，也是后续「按字符串搜索」能成立的前提。<br>' +
          '② <b>记录会变长，就没法随机访问</b>。只要记录里有不定长的字符串，' +
          '「第 1327 条在哪」就必须从头扫。索引区把变长部分全部赶到 <code>data</code> 区，' +
          '索引区自己保持<b>等宽</b>，于是 <code>第 n 条的地址 = 基址 + n × 单条大小</code>，一步到位。</p>' +
          '<p style="margin-bottom:0">代价同样真实：<b>每次取值都要多跳一次内存</b>，而且不定长的内容必须自带长度。' +
          '这就是下一节实验里你会亲手解的那个 <b>uleb128 长度前缀</b>——它不是「加密」，是<b>变长编码</b>。' +
          '<span class="hit">把 uleb128 当成加密，是新手最常见的误判之一。</span></p>') +
        T.card('map_list：整份 dex 的目录',
          '<p><code>map_list</code> 的位置由 header 的 <code>map_off</code> 给出。它的结构简单到只有两种：</p>' +
          T.code(
            'map_list:\n' +
            '  uint32  size                 <span class="c">// 后面跟多少条 map_item</span>\n' +
            '  map_item[size]:\n' +
            '    uint16  type               <span class="c">// 这一项是什么（见下表）</span>\n' +
            '    uint16  unused             <span class="c">// 恒为 0</span>\n' +
            '    uint32  item_count         <span class="c">// 有多少条</span>\n' +
            '    uint32  offset             <span class="c">// 从文件开头算的偏移</span>'
          ) +
          T.tbl(
            ['<code>type</code>', '含义', '出现在文件的哪一段'],
            [
              ['<code>0x0000</code>', 'header_item', '文件开头'],
              ['<code>0x0001</code> / <code>0x0002</code>', 'string_id_item / type_id_item', '索引区'],
              ['<code>0x0003</code> / <code>0x0004</code> / <code>0x0005</code>', 'proto_id_item / field_id_item / method_id_item', '索引区'],
              ['<code>0x0006</code>', 'class_def_item', '索引区末尾'],
              ['<code>0x0007</code> / <code>0x0008</code>', 'call_site_id_item / method_handle_item', '较新版本 dex 才有 <span class="pill warn">待核实</span>（具体起始版本以目标 dex 的 magic 为准）'],
              ['<code>0x1000</code> / <code>0x1001</code>', 'map_list / type_list', '结构表'],
              ['<code>0x2000</code> / <code>0x2001</code>', 'class_data_item / code_item', '<b>data 区（方法体在这里）</b>'],
              ['<code>0x2002</code> / <code>0x2003</code>', 'string_data_item / debug_info_item', 'data 区'],
              ['<code>0x2004</code> / <code>0x2005</code> / <code>0x2006</code>', 'annotation_item / encoded_array_item / annotations_directory_item', 'data 区'],
              ['<code>0xF000</code> <span class="pill warn">待核实</span>', 'hiddenapi_class_data_item', '较新的 ART 版本引入，数值请以目标版本的 <code>dex_file.h</code> 为准']
            ]
          ) +
          '<p style="margin-bottom:0">很多反编译器（jadx / baksmali）会<b>先读 map_list</b>，而不是只信 header：' +
          '因为 map_list 是对「整份文件都有什么」的完整声明。' +
          '当你从内存里 dump 出一份 dex 却发现工具打不开时，<b>map_list 与实际偏移不一致</b>是最常见的原因之一——' +
          '这件事第 16 章和第 24 章都踩过。</p>')
    },

    /* ============================================================ 3.6 */
    {
      h: '3.6', title: '从 class_defs 到 code_item：一个方法体藏在哪',
      html:
        '<p>这一节回答一个非常具体的问题：<b>给你一个类名和一个方法名，怎么在字节层面找到它的方法体？</b>' +
        '搞清这条链路，你就同时理解了两件事——Smali 里的 <code>.registers</code> 是从哪来的，' +
        '以及抽取壳抽走的到底是哪几个字节。</p>' +
        '<p>链路一共六步，中间有三个容易记错的地方，我在下面标出来了。</p>',
      stepper: {
        title: 'DEX 里定位一个方法体的六步链路',
        lines: [
          {
            code: '<span class="c">// ① 从 header 拿到类定义表的位置</span>\n' +
                  'class_defs_size = <span class="f">read_u4</span>(hdr, <span class="n">0x60</span>);\n' +
                  'class_defs_off  = <span class="f">read_u4</span>(hdr, <span class="n">0x64</span>);',
            note: '<b>一切从 header 的两个字段开始。</b>它的作用不是「存数据」，而是「告诉你数据在哪」——' +
                  '所以第 16 章说 header 是整份 dex 的地图。后面所有遍历都靠这两个值起步。',
            state: { class_defs_size: '573（示例）', class_defs_off: '0x2D50' },
            mem: '<div class="mono muted">class_def_item 每条固定 32 字节 → 第 n 条的地址 = off + n × 32</div>'
          },
          {
            code: '<span class="c">// ② 遍历 class_defs，比对类的描述符</span>\n' +
                  '<span class="k">for</span> (i = <span class="n">0</span>; i &lt; class_defs_size; i++) {\n' +
                  '    cd = class_defs + i * <span class="n">32</span>;\n' +
                  '    idx  = <span class="f">read_u4</span>(cd, <span class="n">0x00</span>);  <span class="c">// class_idx → type_ids</span>\n' +
                  '    sIdx = <span class="f">read_u4</span>(type_ids + idx * <span class="n">4</span>, <span class="n">0</span>);\n' +
                  '    name = <span class="f">string_at</span>(sIdx);   <span class="c">// → "Lcom/example/app/Sign;"</span>\n' +
                  '}',
            note: '<b>两步解引用才拿到类名。</b><code>class_idx</code> 是 <code>type_ids</code> 的下标，' +
                  '<code>type_ids[idx]</code> 又是 <code>string_ids</code> 的下标，最后才是字符串偏移。' +
                  '这就是「索引区」设计的代价：<span class="hit">多跳几次，换来等宽和去重。</span>' +
                  '注意类描述符格式是 <code>L包名/类名;</code>——首尾的 L 和分号是类型描述符的语法，不是类名的一部分。',
            state: { 当前类: 'com.example.app.Sign', class_idx: '1187', type_ids_值: '2036' },
            mem: '<div class="mono muted">类描述符：L + 全限定名（点换成斜杠） + ;</div>'
          },
          {
            code: '<span class="c">// ③ 命中目标类 → 取它的类数据</span>\n' +
                  'class_data_off = <span class="f">read_u4</span>(cd, <span class="n">0x18</span>);',
            note: '<b>class_def_item 的 8 个 u4 字段。</b>第一个是 <code>class_idx</code>（0x00），' +
                  '往后依次是 <code>access_flags</code>、<code>superclass_idx</code>、<code>interfaces_off</code>、' +
                  '<code>source_file_idx</code>、<code>annotations_off</code>、<b><code>class_data_off</code></b>、' +
                  '<code>static_values_off</code>。<code>class_data_off</code> 在后面几个，' +
                  '<span class="hit">它是「类定义」和「类的成员」之间的唯一入口。</span>' +
                  '如果它是 0，说明这个类没有字段也没有方法（空类或接口）。',
            state: { class_data_off: '0x31A4', access_flags: '0x0001（ACC_PUBLIC）' },
            mem: '<div class="mono muted">class_def_item：8 × u4 = 32 字节</div>'
          },
          {
            code: '<span class="c">// ④ 解析 class_data_item：四个 uleb128 计数</span>\n' +
                  'static_fields_size   = <span class="f">uleb128</span>(p);\n' +
                  'instance_fields_size = <span class="f">uleb128</span>(p);\n' +
                  'direct_methods_size  = <span class="f">uleb128</span>(p);\n' +
                  'virtual_methods_size = <span class="f">uleb128</span>(p);',
            note: '<b>从这里开始，全部是 uleb128。</b>为什么要用变长编码？因为这些计数字段绝大多数很小（0～几十），' +
                  '固定 4 字节会浪费；而个别类可能有几百个方法。<span class="hit">uleb128 就是「小的省空间，大的也能装」。</span><br>' +
                  '注意方法被分成两组：<b>direct</b>（private / static / 构造方法）和 <b>virtual</b>（可被重写的实例方法）。' +
                  '这不是可选的分类——<b>两组都要遍历</b>，只处理一组是脱壳工具最常见的漏方法原因（第 16 章）。',
            state: { static_fields: '0', instance_fields: '2', direct_methods: '2', virtual_methods: '3' },
            mem: '<div class="mono muted">uleb128：每字节低 7 位是数据，最高位是「还有下一字节」的标志</div>'
          },
          {
            code: '<span class="c">// ⑤ 遍历 encoded_method（每条 3 个 uleb128）</span>\n' +
                  '<span class="k">for</span> (j = <span class="n">0</span>; j &lt; direct + virtual; j++) {\n' +
                  '    diff  = <span class="f">uleb128</span>(p);   <span class="c">// ← 差值，不是下标！</span>\n' +
                  '    flags = <span class="f">uleb128</span>(p);\n' +
                  '    code_off = <span class="f">uleb128</span>(p);\n' +
                  '    method_idx += diff;              <span class="c">// 必须累加还原</span>\n' +
                  '}',
            note: '<b>这里是最容易写错的一处。</b><code>method_idx_diff</code> 是<b>与上一个方法的索引之差</b>，' +
                  '不是绝对下标。因为同类的相邻方法在 <code>method_ids</code> 里通常挨得很近，存差值往往只要 1 字节。' +
                  '<span class="hit">忘记累加，就会把索引解错——而且在自己造的小样本上常常看不出来。</span><br>' +
                  '<code>code_off</code> 才是方法体的入口；<b>它为 0 表示这个方法没有代码</b>（<code>abstract</code> 或 <code>native</code>），' +
                  '这是完全合法的，不是被壳抽了。',
            state: { method_idx_累计: '4821 → 4821 → 4823', 当前: 'getSign', code_off: '0x4C20' },
            mem: '<div class="mono muted">method_idx 是「累加得到」的，code_off 是「从文件头算起的绝对偏移」</div>'
          },
          {
            code: '<span class="c">// ⑥ code_off → code_item 的头部（16 字节）</span>\n' +
                  'registers_size = <span class="f">read_u2</span>(ci, <span class="n">0x00</span>);\n' +
                  'ins_size       = <span class="f">read_u2</span>(ci, <span class="n">0x02</span>);\n' +
                  'outs_size      = <span class="f">read_u2</span>(ci, <span class="n">0x04</span>);\n' +
                  'tries_size     = <span class="f">read_u2</span>(ci, <span class="n">0x06</span>);\n' +
                  'debug_info_off = <span class="f">read_u4</span>(ci, <span class="n">0x08</span>);\n' +
                  'insns_size     = <span class="f">read_u4</span>(ci, <span class="n">0x0C</span>);',
            note: '<b>code_item 的 16 字节头部，六个字段。</b>后面紧跟的就是 <code>insns</code>：' +
                  '<code>insns_size</code> 个 <b>16 位</b>的 code unit（注意单位是 u2，不是字节——' +
                  '<span class="hit">换算成字节要 ×2</span>）。<br>' +
                  '如果 <code>tries_size ≠ 0</code> 且 <code>insns_size</code> 是奇数，指令数组后面还有一个 2 字节的对齐填充，' +
                  '然后才是 try/catch 表和 handler 表。这个填充是很多人对齐错位的根源。',
            state: { registers_size: '6', ins_size: '3', outs_size: '2', tries_size: '0', insns_size: '0x28（40 个 code unit）' },
            mem: '<div class="mono muted">insns 实际字节数 = insns_size × 2 = 0x50</div>'
          },
          {
            code: '<span class="c">// 这六个字段和 Smali 的对应关系</span>\n' +
                  '<span class="c">// .registers 6            ← registers_size</span>\n' +
                  '<span class="c">// .param p1, "x"  ...     ← ins_size 个「字」的参数区（含 this）</span>\n' +
                  '<span class="c">// invoke-virtual …        ← 被调方法的参数总字数受 outs_size 限制</span>',
            note: '<b>Smali 的 <code>.registers N</code> 就是 <code>registers_size</code>，一一对应。</b>' +
                  '非静态方法的 <code>ins_size</code> 里<b>包含 <code>this</code></b>，' +
                  '所以「本地变量数 = <code>registers_size − ins_size</code>」——这正是 Smali 里 <code>.locals</code> 的来历。' +
                  '<br>另外：寄存器编号是<b>从参数区往本地区递增</b>的，' +
                  '<span class="hit">所以参数占用的是<b>高位</b>寄存器（p0 = registers_size − ins_size 起）</span>。' +
                  '这个方向感如果不清楚，看 Smali 时会一直别扭。',
            state: { '.registers': '6', '.locals': '3', p0: 'v3（即 this）', p1: 'v4', p2: 'v5' },
            mem: '<div class="mono muted">寄存器分配顺序：v0..v(locals-1) 是局部变量，v(locals)..v(registers-1) 是参数</div>'
          },
          {
            code: '<span class="c">// 抽取壳动的是哪几个字节？</span>\n' +
                  '<span class="c">// 正常：code_off → 完整 code_item（头部 + insns）</span>\n' +
                  '<span class="c">// 抽取：insns 被搬空/搬走，方法体变成空</span>\n' +
                  '<span class="c">// 也有整段 code_item 都不在原位的情况</span>',
            note: '<b>抽取壳抽走的就是 <code>insns</code> 这段指令数组</b>——有时候连同 <code>code_item</code> 一起搬走，' +
                  '把 <code>code_off</code> 指到别处或留一个空壳。<br>' +
                  '所以「脱壳后方法体是空的」这件事，在文件格式层面有明确的表现：' +
                  '<b><code>insns_size</code> 成片为 0</b>，或者 <code>code_off</code> 指向的区域里没有真实指令。' +
                  '<span class="hit">这和第 16、26、8 章讲的「主动调用触发回填」是同一个现象的两个视角：' +
                  '那几章讲怎么把指令逼回来，这一节讲你凭什么知道它没回来。</span><br>' +
                  '申明一下边界：本节只讲结构，脱壳战术不在本章范围内。',
            state: { 正常方法: 'insns_size = 40', 被抽取: 'insns_size = 0 或 code_off = 0' },
            mem: '<div class="mono muted">判断依据：不是看类名有几条，而是看 insns 的覆盖率</div>'
          }
        ]
      },
      quiz: {
        id: 'q28-2', chapter: 28, answer: 2,
        stem: 'Smali 里一个非静态方法写着 <code>.registers 6</code> 和 <code>.locals 3</code>。' +
              '对应到 dex 的 <code>code_item</code>，下面哪一组字段是自洽的？',
        options: [
          { t: '<code>registers_size = 6</code>，<code>ins_size = 3</code>，<code>outs_size = 3</code>',
            why: '<code>registers_size</code> 和 <code>ins_size</code> 对，但 <code>outs_size</code> 与 .locals 无关——' +
                 '它描述的是「这个方法<b>调用别人</b>时最多需要多少个参数寄存器」，不是本地变量数。' },
          { t: '<code>registers_size = 6</code>，<code>ins_size = 3</code>，<code>insns_size = 6</code>',
            why: '<code>insns_size</code> 是<b>指令数组的长度（单位是 16 位 code unit）</b>，和寄存器数量没有任何换算关系。这里凑成 6 是典型的把两个不相干的字段硬绑在一起。' },
          { t: '<code>registers_size = 6</code>，<code>ins_size = 3</code>，<code>outs_size</code> 由被调用方法的签名决定',
            why: '<b>正确。</b><code>locals = registers − ins = 6 − 3 = 3</code> 自洽；' +
                 '<code>outs_size</code> 取决于方法内部调用链里<b>参数最多</b>的那次调用（含 <code>this</code>），而不是本方法的参数。' },
          { t: '<code>registers_size = 3</code>，<code>ins_size = 6</code>，<code>outs_size = 0</code>',
            why: '<code>ins_size</code> 不可能大于 <code>registers_size</code>——参数寄存器是「寄存器文件的一部分」，' +
                 '不是另外一块空间。这两个字段写反了。' }
        ],
        explain:
          '<p>把三个字段的分工一次说清：</p>' +
          '<ul>' +
          '<li><code>registers_size</code>：这个方法总共用到多少个寄存器（对应 Smali 的 <code>.registers</code>）。</li>' +
          '<li><code>ins_size</code>：<b>进来</b>的参数占多少个「字」。非静态方法的第一个字是 <code>this</code>，' +
          '所以 Smali 的 <code>.locals = registers_size − ins_size</code>。</li>' +
          '<li><code>outs_size</code>：这个方法<b>出去</b>调用别人时，最多要占用多少个参数寄存器。' +
          '它由「内部参数最多的那次 invoke」决定，与自己的参数个数无关。</li>' +
          '<li><code>insns_size</code>：指令数组长度，单位是 <b>u2（16 位）</b>，不是字节。</li>' +
          '</ul>' +
          '<p><b>为什么这个区分在实战里有用？</b>因为抽取壳抽的是 <code>insns</code>，' +
          '所以当你 dump 出一份 dex 想判断「脱干净了没有」时，看的是 <b><code>insns_size</code> 的分布</b>，' +
          '而不是 <code>registers_size</code>。一个方法即使 <code>registers_size</code> 正常，' +
          '<code>insns_size = 0</code> 也说明它是个空壳。</p>' +
          '<p>顺带记住那条容易忘的：<b>寄存器是向高位生长的</b>——局部变量从 v0 开始，参数在最高的 <code>ins_size</code> 个寄存器里。' +
          '所以 Smali 里 <code>p0</code> 的编号是 <code>registers_size − ins_size</code>，不是 0。</p>'
      }
    },

    /* ============================================================ 3.7 */
    {
      h: '3.7', title: '实验：DEX 索引区解引用与 uleb128 解码',
      html:
        '<p>上面两节讲的都是「结构」，现在上手算一次。这个实验给的是一份 dex 里<b>切出来的索引区片段</b>' +
        '（不含 header），你要从字节里把方法名、类描述符、返回类型全都解出来。</p>' +
        '<p>片段布局（已知条件，相对于片段起点）——这是你在调试器里看内存时最常遇到的形式：' +
        '没有 header 可读，只有一段被标注过的字节：</p>' +
        T.tbl(
          ['偏移', '内容', '条数', '每条大小'],
          [
            ['<code>0x00</code>', '<code>string_ids</code>', '6', '4 字节（u4 偏移）'],
            ['<code>0x18</code>', '<code>type_ids</code>', '2', '4 字节（u4 → string_ids 下标）'],
            ['<code>0x20</code>', '<code>proto_ids</code>', '1', '12 字节（3 个 u4）'],
            ['<code>0x2C</code>', '<code>method_ids</code>', '1', '8 字节（u2 + u2 + u4）'],
            ['<code>0x34</code>', '字符串数据（<code>string_data_item</code> 顺序排列）', '6', '变长']
          ]
        ) +
        T.note('key', '🔑 string_data_item 的形状',
          '<p style="margin-bottom:0">每个字符串数据项都是：<b>uleb128 的 utf16_size</b> + <b>MUTF-8 字节</b> + <b>一个 0x00 结尾</b>。<br>' +
          '这里有个必须分清的差别：<span class="hit">uleb128 存的是「UTF-16 码元个数」，不是字节数。</span>' +
          '纯 ASCII 时两者恰好相等，所以很多人一直以为它存的是长度——直到遇到中文或 emoji 才发现对不上。' +
          '实验最后一问就是专门考这个。</p>'),
      lab: {
        title: '实验：解出 method_ids[0] 指向的方法名与签名',
        goal: '目标：索引解引用 + uleb128 真解码',
        intro:
          '<p>下面预填了这段索引区与字符串数据的真实字节。<b>任务：顺着索引一路解引用，把方法名、' +
          '类描述符、返回类型解出来；再解一个两字节的 uleb128，以及一个「uleb128 数字和实际字节数不一致」的字符串。</b></p>' +
          '<p class="muted">注意：所有「偏移」在 <code>string_ids</code> 里都是<b>从文件（这里是片段）开头算起</b>的绝对偏移，' +
          '不是相对于数据区的偏移。这是 dex 里的统一约定。</p>',
        inputs: [
          { key: 'hex', label: '索引区 + 字符串数据（十六进制）',
            hint: '每个字符串数据项 = uleb128 长度 + MUTF-8 字节 + 00', type: 'textarea', rows: 8,
            value: FF28.dexHex() },
          { key: 'name', label: '① method_ids[0] 的方法名', hint: 'name_idx → string_ids → 偏移 → 解出字符串', ph: '例如 getSign' },
          { key: 'cls', label: '② 这个方法的类描述符', hint: 'class_idx → type_ids → string_ids', ph: '例如 Lcom/example/app/Sign;' },
          { key: 'ret', label: '③ proto_ids[0] 的返回类型描述符', hint: 'return_type_idx → type_ids → string_ids', ph: '例如 Ljava/lang/String;' },
          { key: 'ulen', label: '④ string_ids[4] 那个字符串的 uleb128 长度前缀，解出来是多少？（十进制）',
            hint: '它的长度前缀占 2 字节，不是 1 字节', ph: '例如 130' },
          { key: 'diff', label: '⑤ string_ids[5] 那个字符串：uleb128 说的是几个 UTF-16 码元？它实际占了几个字节？',
            hint: '两个数字都要写，例如「4 和 12」', type: 'textarea', rows: 2, ph: '例如 4 和 12' }
        ],
        runLabel: '🔍 解引用并解码',
        autorun: true,
        run: v => {
          const r = FF28.parseDexFrag(v.hex || '');
          if (!r.ok) return '<div class="lab-msg warn"><b>先别急</b><div class="lab-note">' + r.err + '</div></div>';
          const h2 = x => '0x' + x.toString(16).toUpperCase();
          let out = '<div class="lab-kv">' +
            '<span>片段 <b>' + r.bytes + '</b> 字节</span>' +
            '<span>字符串数据区起点 <b>' + h2(r.dataOff) + '</b></span>' +
            '<span>字符串 <b>' + r.strings.length + '</b> 条</span></div>';
          out += '<table class="lab-tbl"><tr><th>#</th><th>string_ids 里的偏移</th><th>uleb128 说的码元数</th>' +
            '<th>实际字节数</th><th>解出来的字符串</th></tr>';
          r.strings.forEach((s, i) => {
            const hot = (i === 4 || i === 5);
            out += '<tr' + (hot ? ' class="diff"' : '') + '><td>' + i + '</td><td><code>' + h2(s.off) + '</code></td>' +
              '<td>' + s.utf16 + '</td><td>' + s.byteLen + '</td>' +
              '<td><code>' + s.s.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</code></td></tr>';
          });
          out += '</table>';
          out += '<table class="lab-tbl"><tr><th>解引用链</th><th>读到的值</th><th>结果</th></tr>' +
            '<tr><td>method_ids[0]</td><td>class_idx=' + r.mids[0].cls + '，proto_idx=' + r.mids[0].proto + '，name_idx=<b>' + r.mids[0].name + '</b></td><td>—</td></tr>' +
            '<tr class="same"><td>→ string_ids[' + r.mids[0].name + ']</td><td>偏移 <code>' + h2(r.strings[r.mids[0].name].off) + '</code></td>' +
              '<td><b>方法名 = ' + r.name.s + '</b></td></tr>' +
            '<tr><td>→ type_ids[' + r.mids[0].cls + ']</td><td>string_ids 下标 ' + r.tids[r.mids[0].cls] + '</td>' +
              '<td><b>类 = ' + r.cls.s + '</b></td></tr>' +
            '<tr><td>→ proto_ids[' + r.mids[0].proto + ']</td><td>shorty_idx=' + r.proto.shorty + '，return_type_idx=' + r.proto.ret + '</td>' +
              '<td><b>返回类型 = ' + r.ret.s + '</b>（shorty = ' + r.shorty.s + '）</td></tr>' +
            '</table>';
          out += '<div class="lab-msg key"><b>🔑 注意最后两行的差别</b><div class="lab-note">' +
            '第 5 条字符串的 uleb128 说它是 <b>' + r.strings[5].utf16 + '</b> 个 UTF-16 码元，' +
            '但它在文件里实打实占了 <b>' + r.strings[5].byteLen + '</b> 个字节——因为它是中文，MUTF-8 下一个汉字 3 字节。<br>' +
            '如果你按「uleb128 的值 = 字节数」去读，指针立刻会错位，后面所有字符串全部读串。' +
            '<span class="hit">这是解析 dex 时最经典的一个错。</span></div></div>';
          return out;
        },
        expected: v => {
          const r = FF28.parseDexFrag(v.hex || '');
          if (!r.ok) return { ok: false, detail: '解析失败：' + r.err };
          const t = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '');
          const nameOk = t(v.name) === t(r.name.s);
          const clsOk = t(v.cls) === t(r.cls.s);
          const retOk = t(v.ret) === t(r.ret.s);
          const ulenOk = String(v.ulen || '').replace(/[\s,]/g, '') === String(r.strings[4].utf16);
          const nums = String(v.diff || '').match(/\d+/g) || [];
          const diffOk = nums.length >= 2 && Number(nums[0]) === r.strings[5].utf16 && Number(nums[1]) === r.strings[5].byteLen;
          const one = (ok, good, bad) => ok ? '✅ ' + good : '❌ ' + bad;
          return {
            ok: nameOk && clsOk && retOk && ulenOk && diffOk,
            detail:
              one(nameOk, '① 方法名对：<code>' + r.name.s + '</code>', '① 方法名不对。method_ids[0] 的 name_idx = ' + r.mids[0].name + '，去 string_ids 里取第 ' + r.mids[0].name + ' 项，得到偏移 ' + FF28.hexN(r.strings[r.mids[0].name].off, 4) + '，在那里解出字符串。') + '<br>' +
              one(clsOk, '② 类描述符对：<code>' + r.cls.s + '</code>', '② 类描述符不对。要经过 <b>class_idx → type_ids → string_ids</b> 两次跳转，别只跳一次。') + '<br>' +
              one(retOk, '③ 返回类型对：<code>' + r.ret.s + '</code>', '③ 返回类型不对。proto_id_item 的三个 u4 依次是 shorty_idx、<b>return_type_idx</b>、parameters_off；返回类型是第二个。') + '<br>' +
              one(ulenOk, '④ 两字节 uleb128 解对了：' + r.strings[4].utf16, '④ 不对。这个长度前缀是 2 字节：<code>82 01</code> → (0x02) + (0x01 × 128) = <b>' + r.strings[4].utf16 + '</b>。') + '<br>' +
              one(diffOk, '⑤ 码元数与字节数都对了：' + r.strings[5].utf16 + ' 个码元 / ' + r.strings[5].byteLen + ' 字节',
                '⑤ 不对。第 6 条字符串是中文，uleb128 存的是 UTF-16 码元数（' + r.strings[5].utf16 + '），实际字节数是 ' + r.strings[5].byteLen + '。')
          };
        },
        showAnswer:
          '【① 方法名】\n' +
          '  method_ids[0] 在 0x2C：class_idx=0x0000, proto_idx=0x0000, name_idx=0x00000000\n' +
          '  name_idx = 0 → string_ids[0] = 0x00000034（偏移 0x34）\n' +
          '  0x34: 07 "getSign" 00     → 方法名 = getSign\n\n' +
          '【② 类描述符】\n' +
          '  class_idx = 0 → type_ids[0] = 0x00000001\n' +
          '  → string_ids[1] = 0x0000003D\n' +
          '  0x3D: 16 "Lcom/example/app/Sign;" 00\n' +
          '  → 类描述符 = Lcom/example/app/Sign;\n\n' +
          '【③ 返回类型】\n' +
          '  proto_ids[0] 在 0x20：shorty_idx=3, return_type_idx=1, parameters_off=0\n' +
          '  return_type_idx = 1 → type_ids[1] = 2 → string_ids[2] = 0x55\n' +
          '  0x55: 12 "Ljava/lang/String;" 00\n' +
          '  → 返回类型 = Ljava/lang/String;（shorty = string_ids[3] = "L"）\n\n' +
          '【④ string_ids[4] 的长度前缀】\n' +
          '  string_ids[4] = 0x6C，那里是：82 01 ...\n' +
          '  82 = 0b1000_0010 → 低 7 位 = 0x02，最高位 = 1（还有下一字节）\n' +
          '  01 = 0b0000_0001 → 低 7 位 = 0x01，最高位 = 0（结束）\n' +
          '  值 = 0x02 | (0x01 << 7) = 2 + 128 = 130\n' +
          '  单字节 uleb128 只能表示 0..127，所以 130 必须用两字节。\n\n' +
          '【⑤ 码元数 vs 字节数】\n' +
          '  string_ids[5] = 0xF1，那里是：04 E7ADBE E5908D E6A0A1 E9AA8C 00\n' +
          '  uleb128 = 0x04 → 「4 个 UTF-16 码元」\n' +
          '  实际字节 = 12（"签名校验" 四个汉字，MUTF-8 下每个 3 字节）\n' +
          '  ★ 结论：uleb128 的值不是字节数。按字节数用会立刻错位。',
        hint:
          '<b>先把三张表的位置标出来：</b><code>string_ids</code> 在 0x00（6 条 × 4 字节）、<code>type_ids</code> 在 0x18、' +
          '<code>proto_ids</code> 在 0x20、<code>method_ids</code> 在 0x2C。<br><br>' +
          '<b>解引用的方向是固定的：</b>方法记录里的三个字段分别是「类的下标、原型的下标、名字的下标」，' +
          '它们指向的是 <code>type_ids</code> / <code>proto_ids</code> / <code>string_ids</code>，不是直接指向字符串。<br><br>' +
          '<b>uleb128 的读法：</b>每个字节只用低 7 位放数据，最高位是「后面还有」的标志位；' +
          '第 2 个字节的数据要左移 7 位，第 3 个左移 14 位……所以 <code>82 01</code> = 2 + (1 &lt;&lt; 7) = 130。<br><br>' +
          '<b>第 ⑤ 问的方向：</b>数一数从长度标签之后、到那个 <code>00</code> 之前，一共几个字节；' +
          '再和 uleb128 解出来的数字比一比。',
        after:
          T.note('ok', '✅ 实验的收获',
            '<p style="margin-bottom:0">你现在能徒手完成 dex 解析器最核心的那个动作：' +
            '<b>顺着定长索引跳进变长数据区，并且知道变长数据的第一件事是读长度</b>。<br>' +
            '这就是 jadx / baksmali 每天在做的事。区别只在于它们把结果缓存起来，你这里每次重算。' +
            '<span class="hit">更关键的是你亲眼看到了「uleb128 存的是码元数、不是字节数」——' +
            '这一条如果不真算一次，几乎一定会记错。</span></p>')
      }
    },

    /* ============================================================ 3.8 */
    {
      h: '3.8', title: 'ELF 基本结构：段与节，两套视角别搞混',
      intuition: {
        tag: '直觉模型 · 搬家施工图与零件清单',
        body:
          '<p>同一个 so 文件，有两拨人要用它，而他们关心的东西完全不同。</p>' +
          '<p><b>第一拨是「搬家工人」</b>（操作系统装载器）。他只关心：哪些片要搬进内存、搬到哪个地址、' +
          '每片多大、搬进去之后是「只能看」「能改」还是「能执行」。至于片子里面装的是代码还是常数，他不关心。' +
          '他看的是<b>程序头表（program header table）</b>，里面的每一片叫<b>段（segment）</b>。</p>' +
          '<p><b>第二拨是「工程师」</b>（链接器和逆向分析者）。他关心：哪一块是代码、哪一块是只读常数、' +
          '符号表在哪、重定位表在哪、初始化函数数组在哪。他看的是<b>节头表（section header table）</b>，' +
          '里面的每一块叫<b>节（section）</b>。</p>' +
          '<p><span class="hit">「段」是运行时的真相，「节」是分析时的真相。</span>' +
          '很多困惑（比如「为什么抹掉节表程序还能跑」「为什么 strip 之后函数名没了但代码还在」）' +
          '都是因为把这两套视角当成了一套。</p>'
      },
      html:
        '<p>ELF 文件的开头永远是 <code>Elf64_Ehdr</code>（64 字节），它像一个总目录，' +
        '给出两张表的位置和条数：</p>' +
        T.tbl(
          ['表', '谁读它', '一条多大', '一条描述什么', '能不能省'],
          [
            ['<b>程序头表</b><br><code>program header table</code>', '<b>装载器</b>（内核 / linker）', '56 字节（<code>Elf64_Phdr</code>）',
             '一个<b>段</b>：文件从哪读、映射到哪个虚拟地址、多大、什么权限', '<b>不能</b>——没有它就无法运行'],
            ['<b>节头表</b><br><code>section header table</code>', '<b>链接器 / 分析者</b>（ld、IDA、readelf）', '64 字节（<code>Elf64_Shdr</code>）',
             '一个<b>节</b>：名字、类型、偏移、大小、标志', '<b>能</b>——抹掉它程序照样跑（只是没人看得懂结构了）']
          ]
        ) +
        T.note('key', '🔑 两者不是「粗粒度 vs 细粒度」这么简单',
          '<p>它们回答的是<b>两个不同的问题</b>：</p>' +
          '<p>① <b>段回答「怎么装进内存」</b>。所以段必须满足内核的映射条件：偏移和虚拟地址都要<b>页对齐</b>（4KB），' +
          '同一页里不能混着两种权限。这也是为什么通常只有 2～4 个 <code>PT_LOAD</code>：' +
          '一片放「只读 + 可执行」（代码和只读常量），一片放「可读写」（数据），仅此而已。</p>' +
          '<p style="margin-bottom:0">② <b>节回答「文件里有什么」</b>。所以节可以非常细：代码、只读常量、已初始化数据、' +
          '未初始化数据、符号表、字符串表、重定位表、初始化函数指针数组……' +
          '一个节的边界完全由链接脚本和编译器决定，<b>不需要</b>满足页对齐，也不需要能被映射。<br>' +
          '<span class="hit">推论：一个节可以完全不属于任何段</span>——比如 <code>.symtab</code>、<code>.strtab</code>、' +
          '<code>.comment</code>：它们只在文件里有，运行时根本不进内存。这正是「strip 之后程序照跑」的原因。</p>') +
        '<p>下面这个动画把两个视角并排摆出来，逐项对应一遍。</p>',
      stage: {
        title: '同一个 so 的两种视角：程序头（段）与节头（节）',
        speed: 1800,
        render:
          '<div class="flow-col" style="gap:10px">' +
            '<div class="flow-row" style="align-items:flex-start;gap:18px">' +
              '<div style="flex:1;min-width:230px">' +
                '<div class="pill acc mono" style="margin-bottom:6px">装载器的视角 · program headers</div>' +
                '<div class="blk" id="p1">PT_LOAD #1 · R-X · 代码与只读常量</div>' +
                '<div class="blk" id="p2">PT_LOAD #2 · RW- · 已初始化数据 + BSS</div>' +
                '<div class="blk" id="p3">PT_GNU_RELRO · 重定位后转只读</div>' +
                '<div class="blk" id="p4">PT_DYNAMIC · 动态链接信息</div>' +
                '<div class="blk" id="p5">PT_TLS / PT_GNU_EH_FRAME …</div>' +
              '</div>' +
              '<div style="flex:1;min-width:230px">' +
                '<div class="pill mono" style="margin-bottom:6px">分析者的视角 · section headers</div>' +
                '<div class="blk" id="s1">.text · 代码</div>' +
                '<div class="blk" id="s2">.rodata · 只读常量</div>' +
                '<div class="blk" id="s3">.data · 已初始化数据</div>' +
                '<div class="blk" id="s4">.bss · 未初始化数据</div>' +
                '<div class="blk" id="s5">.dynsym / .dynstr · 动态符号</div>' +
                '<div class="blk" id="s6">.rela.dyn / .rela.plt · 重定位</div>' +
                '<div class="blk" id="s7">.init_array · 初始化函数指针</div>' +
                '<div class="blk" id="s8">.symtab / .strtab / .comment · <b>不进内存</b></div>' +
              '</div>' +
            '</div>' +
            '<div class="flow-row" style="margin-top:6px;padding-top:10px;border-top:1px dashed var(--line)">' +
              '<span class="pill" id="mark">点「播放」开始对照</span>' +
            '</div>' +
          '</div>',
        reset: () => {
          ['p1', 'p2', 'p3', 'p4', 'p5', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'].forEach(i => S(i, ''));
          CLS('mark', 'pill');
          SET('mark', '点「播放」开始对照');
        },
        steps: [
          { run: () => { S('p1', 'active'); S('s1', 'active'); S('s2', 'active'); },
            note: '<b>第一对：PT_LOAD(R-X) ↔ .text + .rodata。</b>' +
                  '装载器眼里只有「这一片要映射成只读可执行」；分析者眼里这是两个语义完全不同的节：' +
                  '一个是代码，一个是常量数据。它们能合进同一个段，是因为<b>权限相同</b>。' +
                  '<span class="hit">段的划分依据是权限，节的划分依据是语义。</span>' },
          { run: () => { S('p1', 'done'); S('s1', 'done'); S('s2', 'done'); S('p2', 'active'); S('s3', 'active'); S('s4', 'active'); },
            note: '<b>第二对：PT_LOAD(RW-) ↔ .data + .bss。</b>这一对里藏着本章一个重要的字节级事实：' +
                  '段头里 <code>p_memsz &gt; p_filesz</code> 时，<b>多出来的那部分就是 .bss</b>——' +
                  '文件里不占空间，加载时补零（下一节会专门算一遍）。' },
          { run: () => { S('p2', 'done'); S('s3', 'done'); S('s4', 'done'); S('p3', 'active'); },
            note: '<b>PT_GNU_RELRO 不是一段新数据</b>，它是「给某一段区域改权限」的声明：' +
                  '重定位做完之后，把这片（通常是 GOT 的一部分和 .data 的开头）改成<b>只读</b>，' +
                  '让攻击者不能靠改 GOT 劫持控制流。<br>' +
                  '注意它在节的视角里<b>没有对应物</b>——它是一段区间，不是一个节。' },
          { run: () => { S('p3', 'done'); S('p4', 'active'); S('s5', 'active'); S('s6', 'active'); },
            note: '<b>PT_DYNAMIC ↔ .dynamic，再往下引出 .dynsym / .dynstr / .rela.*。</b>' +
                  '动态段里是一串 <code>(tag, value)</code> 对：从哪找符号表（<code>DT_SYMTAB</code>）、' +
                  '从哪找字符串表（<code>DT_STRTAB</code>）、重定位表在哪（<code>DT_RELA</code> / <code>DT_JMPREL</code>）。' +
                  '<span class="hit">这是运行时的「链接信息入口」</span>——第 18 章的自定义 Linker 就是从这里开始解析的。' },
          { run: () => { S('p4', 'done'); S('s5', 'done'); S('s6', 'done'); S('s7', 'active'); },
            note: '<b>.init_array / .fini_array：函数指针数组。</b>loader 在重定位完成后逐个调用它们，' +
                  '这是 so 里「谁先跑」的真正答案——不是 <code>e_entry</code>。' +
                  '<span class="hit">JNI 的 <code>JNI_OnLoad</code> 也常常挂在这条链上（取决于注册方式）。</span>' },
          { run: () => { S('p5', 'active'); S('s7', 'done'); },
            note: '<b>PT_TLS / PT_GNU_EH_FRAME / PT_GNU_STACK 这些「非数据段」</b>：' +
                  'TLS 是线程局部存储的模板，EH_FRAME 是异常回溯需要的表，GNU_STACK 只是声明「栈要不要可执行」（一个安全开关）。' +
                  '它们的存在说明程序头表不只描述「要搬的数据」。' },
          { run: () => { S('p5', 'done'); S('s8', 'hot'); CLS('mark', 'pill bad'); SET('mark', '关键：.symtab / .strtab 不属于任何段——它们不进内存'); },
            note: '<b>最后看最右边这一条，这是本节的核心结论。</b>' +
                  '<code>.symtab</code>、<code>.strtab</code>、<code>.comment</code> 这些节<b>不属于任何 PT_LOAD 段</b>，' +
                  '所以装载器根本不会把它们映射进内存。<br>' +
                  '推论一：<b>strip 掉 .symtab，程序运行完全不受影响</b>，但 IDA 里函数名全变成 <code>sub_xxxx</code>。<br>' +
                  '推论二：<b>反过来抹掉整个节头表，程序照样能跑</b>——因为装载器只看程序头表。' +
                  '<span class="hit">第 8 章讲「节表异常怎么判定加固」，依据就是这一条；本章给你的是「节表本来该长什么样」。</span>' },
          { run: () => { S('s8', 'done'); CLS('mark', 'pill ok'); SET('mark', '✅ 段给装载器，节给分析者——两套视角各有各的用途'); },
            note: '<b>所以逆向时的策略也随之分叉：</b><br>' +
                  '• 想判断「这个 so 还能不能跑」→ 看<b>程序头</b>（段是否完整、权限是否合理、入口是否合法）。<br>' +
                  '• 想理解「代码和数据分别在文件哪里」→ 看<b>节头</b>（更细、更有语义）。<br>' +
                  '• 遇到「节表被抹了」→ 不要下结论说文件坏了，先用程序头把它当 ELF 处理，' +
                  '必要时再用 SoFixer 一类工具重建节表（第 18 章）。' }
        ]
      },
      after:
        T.note('ok', '✅ 这一节要留下的东西',
          '<p style="margin-bottom:0">只留一句话也够用：<b>段决定「怎么进内存」，节决定「里面是什么」</b>。' +
          '以后凡是遇到「抹掉 / 重建 / strip / 加密」这类动作，先问一句：<span class="hit">它动的是段还是节？</span>' +
          '动了段，程序就跑不起来；只动了节，程序照跑，但你的分析工具会瞎。</p>')
    },

    /* ============================================================ 3.9 */
    {
      h: '3.9', title: '解析 ELF 头：64 个字节里的全部信息',
      html:
        '<p>ELF 头固定 64 字节（ELF64）。下面这张表里的偏移不是背下来的，' +
        '是从 glibc <code>elf.h</code> 的 <code>Elf64_Ehdr</code> 定义逐字段推出来的——' +
        '<span class="hit">你可以自己对着字段宽度加一遍，加起来正好 64。</span></p>' +
        T.tbl(
          ['偏移', '宽度', '字段', '说明'],
          [
            ['<code>0x00</code>', '16', '<code>e_ident[16]</code>', '魔数与若干标识字节，见下一张表'],
            ['<code>0x10</code>', '2', '<code>e_type</code>', '文件类型：1=ET_REL，2=ET_EXEC，3=ET_DYN（so 和 PIE），4=ET_CORE'],
            ['<code>0x12</code>', '2', '<code>e_machine</code>', '目标架构：183=EM_AARCH64（0xB7），40=EM_ARM，62=EM_X86_64，3=EM_386'],
            ['<code>0x14</code>', '4', '<code>e_version</code>', '固定 1（EV_CURRENT）'],
            ['<code>0x18</code>', '8', '<code>e_entry</code>', '入口虚拟地址。<b>共享库通常是 0</b>——它不是从头执行的'],
            ['<code>0x20</code>', '8', '<code>e_phoff</code>', '程序头表在文件里的偏移'],
            ['<code>0x28</code>', '8', '<code>e_shoff</code>', '节头表在文件里的偏移'],
            ['<code>0x30</code>', '4', '<code>e_flags</code>', '处理器相关标志（架构相关，AArch64 上多为 0）'],
            ['<code>0x34</code>', '2', '<code>e_ehsize</code>', 'ELF 头本身的大小，<b>固定 64</b>'],
            ['<code>0x36</code>', '2', '<code>e_phentsize</code>', '程序头表一条的大小，<b>固定 56</b>'],
            ['<code>0x38</code>', '2', '<code>e_phnum</code>', '程序头表有几条'],
            ['<code>0x3A</code>', '2', '<code>e_shentsize</code>', '节头表一条的大小，<b>固定 64</b>'],
            ['<code>0x3C</code>', '2', '<code>e_shnum</code>', '节头表有几条'],
            ['<code>0x3E</code>', '2', '<code>e_shstrndx</code>', '节名字符串表是第几个节']
          ]
        ) +
        T.card('e_ident 的 16 个字节：前 4 个是魔数，中间 4 个是格式声明，后面 8 个是补充',
          T.tbl(
            ['下标', '名字', '常见取值'],
            [
              ['0–3', '<code>EI_MAG0..3</code>', '<code>7f 45 4c 46</code> —— 就是 <code>\\x7fELF</code>，<b>这是唯一的身份认证</b>'],
              ['4', '<code>EI_CLASS</code>', '1 = ELFCLASS32，<b>2 = ELFCLASS64</b>'],
              ['5', '<code>EI_DATA</code>', '1 = ELFDATA2LSB（小端，Android 全部是它），2 = ELFDATA2MSB'],
              ['6', '<code>EI_VERSION</code>', '1 = EV_CURRENT'],
              ['7', '<code>EI_OSABI</code>', '0 = ELFOSABI_SYSV，3 = ELFOSABI_GNU/LINUX（多数 NDK 产物是 0）'],
              ['8', '<code>EI_ABIVERSION</code>', '通常 0'],
              ['9–15', '<code>EI_PAD</code>', '填充，通常全 0']
            ]
          ) +
          '<p style="margin-bottom:0">这 16 个字节值得单独记，因为<b>它决定了你后面用什么宽度、什么端序去读其余 48 个字节</b>。' +
          '把 <code>EI_CLASS</code> 读错（当成 32 位处理），后面所有字段全是乱的——这是自写解析器最典型的第一个 bug。</p>') +
        T.note('warn', '⚠️ 三个「看起来该有、其实没有」的东西',
          '<p style="margin-bottom:0">' +
          '① <b>ELF 头里没有文件总大小</b>。要知道文件多大只能问文件系统。<br>' +
          '② <b>ELF 头里没有节的名字</b>。节名统一存在 <code>.shstrtab</code> 这个节里，' +
          '<code>sh_name</code> 只是它的下标——所以节表被抹掉时，名字也一起没了。<br>' +
          '③ <b>ELF 头里没有「哪个节是 .text」这种语义</b>。名字只是约定，' +
          '真正决定「这块要不要进内存、能不能执行」的是 <code>sh_flags</code>。' +
          '<span class="hit">所以下一节的实验里，我们只能靠 SHF_EXECINSTR 标志找出「代码节」，而不是靠名字。</span></p>'),
      lab: {
        title: '实验：手写一个 ELF 头 / 程序头 / 节表解析器',
        goal: '目标：把 616 字节解析成三张表',
        intro:
          '<p>下面预填的是一份<b>示教样本</b>：ELF 头（64 字节）+ 程序头表（3 × 56 字节）+ 节头表（6 × 64 字节），' +
          '一共 616 字节。字段的语义、宽度、顺序全部按规范填写；' +
          '为了让一次实验就能看全三张表，两张表被紧凑地排在头后面' +
          '（真实 so 里节表通常贴在文件末尾，这里 <code>e_shoff</code> 指向 0xE8）。</p>' +
          '<p><b>任务：</b>① <code>e_machine</code> 是多少？② <code>e_entry</code> 是多少（想一想共享库为什么是这个值）？' +
          '③ 程序头表里有几个 <code>PT_LOAD</code>？④ 哪个段的 <code>p_memsz</code> 大于 <code>p_filesz</code>，差多少字节？' +
          '⑤ 带 <code>SHF_EXECINSTR</code> 标志的那个节（也就是代码节），它的文件偏移和大小分别是多少？</p>' +
          '<p class="muted">注意：本样本里没有 <code>.shstrtab</code> 的内容，所以节<b>名字</b>解不出来——' +
          '这恰好说明「节名存在别处」，也说明判断一块是不是代码必须靠 <code>sh_flags</code>。</p>',
        inputs: [
          { key: 'hex', label: 'ELF 头 + 程序头表 + 节头表（十六进制）',
            hint: 'e_phoff=0x40，e_shoff=0xE8', type: 'textarea', rows: 8,
            value: FF28.elfHex() },
          { key: 'machine', label: '① e_machine 的值（十进制，例如 183）', hint: 'AArch64 = 0xB7', ph: '例如 183' },
          { key: 'entry', label: '② e_entry 的值（十六进制或十进制）', hint: '想想共享库为什么这样填', ph: '例如 0' },
          { key: 'nload', label: '③ 有几个 PT_LOAD 段？', hint: 'p_type == 1', ph: '例如 2' },
          { key: 'memsz', label: '④ p_memsz 比 p_filesz 多出来的字节数（十六进制）', hint: '多出来的就是 .bss', ph: '例如 0x120' },
          { key: 'text', label: '⑤ 代码节的 sh_offset 和 sh_size（两个十六进制数）', hint: '带 SHF_EXECINSTR(0x4) 的那个节', ph: '例如 0x1A10 0x800' }
        ],
        runLabel: '🔍 解析三张表',
        autorun: true,
        run: v => {
          const r = FF28.parseElf(v.hex || '');
          if (!r.ok) return '<div class="lab-msg warn"><b>先别急</b><div class="lab-note">' + r.err + '</div></div>';
          const H = x => FF28.hexN(x, 8);
          const e = r.eh;
          let out = '<div class="lab-kv">' +
            '<span>样本长度 <b>' + r.bytes + '</b> 字节</span>' +
            '<span>Class <b>' + (e.cls === 2 ? 'ELF64' : e.cls === 1 ? 'ELF32' : '?') + '</b></span>' +
            '<span>Data <b>' + (e.data === 1 ? '小端' : e.data === 2 ? '大端' : '?') + '</b></span>' +
            '<span>e_type <b>' + e.type + '</b>' + (e.type === 3 ? '（ET_DYN）' : '') + '</span>' +
            '<span>e_machine <b>' + e.machine + '</b>' + (e.machine === 183 ? '（EM_AARCH64）' : '') + '</span>' +
            '<span>e_entry <b>' + H(e.entry) + '</b></span>' +
            '<span>程序头 <b>' + e.phnum + '</b> 条 @ ' + H(e.phoff) + '</span>' +
            '<span>节头 <b>' + e.shnum + '</b> 条 @ ' + H(e.shoff) + '</span></div>';

          out += '<table class="lab-tbl"><tr><th>#</th><th>p_type</th><th>p_flags</th><th>p_offset</th>' +
            '<th>p_vaddr</th><th>p_filesz</th><th>p_memsz</th><th>p_align</th></tr>';
          r.phs.forEach(p => {
            const hot = p.memsz > p.filesz;
            out += '<tr' + (hot ? ' class="diff"' : '') + '><td>' + p.i + '</td>' +
              '<td><code>' + H(p.type) + '</code> ' + (FF28.PT_NAME[p.type] || '?') + '</td>' +
              '<td><code>' + FF28.pFlags(p.flags) + '</code></td>' +
              '<td><code>' + H(p.off) + '</code></td><td><code>' + H(p.vaddr) + '</code></td>' +
              '<td><code>' + H(p.filesz) + '</code></td>' +
              '<td><code>' + H(p.memsz) + '</code>' + (hot ? ' <b>← 比 filesz 大 ' + H(p.memsz - p.filesz) + '</b>' : '') + '</td>' +
              '<td><code>' + H(p.align) + '</code></td></tr>';
          });
          out += '</table>';

          out += '<table class="lab-tbl"><tr><th>#</th><th>sh_name</th><th>sh_type</th><th>sh_flags</th>' +
            '<th>sh_addr</th><th>sh_offset</th><th>sh_size</th></tr>';
          r.shs.forEach(s => {
            const hot = !!(s.flags & 0x4);
            out += '<tr' + (hot ? ' class="diff"' : '') + '><td>' + s.i + '</td>' +
              '<td>' + s.name + '</td>' +
              '<td><code>' + FF28.hexN(s.type, 4) + '</code> ' + (FF28.SHT_NAME[s.type] || '?') + '</td>' +
              '<td><code>' + FF28.shFlagText(s.flags) + '</code></td>' +
              '<td><code>' + H(s.addr) + '</code></td><td><code>' + H(s.off) + '</code></td>' +
              '<td><code>' + H(s.size) + '</code>' + (hot ? ' <b>← 唯一带 X 的节</b>' : '') + '</td></tr>';
          });
          out += '</table>';

          out += '<div class="lab-msg key"><b>🔑 三张表读出来的结论</b><div class="lab-note">' +
            '• <b>' + r.loads.length + ' 个 PT_LOAD</b>：一个 R-X 放代码与只读常量，一个 RW- 放数据。<br>' +
            '• 第 2 个段的 <code>p_memsz</code> 比 <code>p_filesz</code> 大 <b>' + H(r.bssGap) + '</b> 字节——' +
            '文件里没有这部分内容，加载时补零，这就是 <code>.bss</code>（节表里第 4 项正是它）。<br>' +
            '• 带 <code>SHF_EXECINSTR</code> 的节 <code>sh_offset = ' + H(r.text ? r.text.off : 0) + '</code>，' +
            '<code>sh_size = ' + H(r.text ? r.text.size : 0) + '</code>——它落在第一个 PT_LOAD 的区间里。<br>' +
            '• <code>e_entry = ' + H(e.entry) + '</code>：共享库的入口通常是 0，' +
            '初始化靠 <code>.init_array</code> / <code>DT_INIT</code>，不靠「从头执行」。</div></div>';
          return out;
        },
        expected: v => {
          const r = FF28.parseElf(v.hex || '');
          if (!r.ok) return { ok: false, detail: '解析失败：' + r.err + '<br>确认样本没有被改动（616 字节）。' };
          const eq = (ans, val) => {
            const s = String(ans == null ? '' : ans).replace(/[\s,]/g, '').replace(/^0x/i, '').toLowerCase();
            if (!s) return false;
            return parseInt(s, 16) === val || parseInt(s, 10) === val;
          };
          const nums = String(v.text || '').match(/(?:0x)?[0-9a-fA-F]+/g) || [];
          const textOff = nums.length ? parseInt(nums[0].replace(/^0x/i, ''), 16) : NaN;
          const textSize = nums.length > 1 ? parseInt(nums[1].replace(/^0x/i, ''), 16) : NaN;
          const mOk = eq(v.machine, r.eh.machine);
          const eOk = eq(v.entry, r.eh.entry);
          const nOk = eq(v.nload, r.loads.length);
          const szOk = eq(v.memsz, r.bssGap);
          const tOk = r.text && textOff === r.text.off && textSize === r.text.size;
          const H = x => FF28.hexN(x, 8);
          const one = (ok, good, bad) => ok ? '✅ ' + good : '❌ ' + bad;
          return {
            ok: mOk && eOk && nOk && szOk && tOk,
            detail:
              one(mOk, '① e_machine = ' + r.eh.machine + '（EM_AARCH64，0xB7）', '① 不对。e_machine 在偏移 <b>0x12</b>，u2 小端，应为 <b>' + r.eh.machine + '</b>。') + '<br>' +
              one(eOk, '② e_entry = ' + H(r.eh.entry) + '（共享库的入口通常为 0）', '② 不对。e_entry 在偏移 <b>0x18</b>，u8，本样本是 <b>' + H(r.eh.entry) + '</b>。') + '<br>' +
              one(nOk, '③ PT_LOAD 段数 = ' + r.loads.length, '③ 不对。程序头表在 0x40，每条 56 字节，<code>p_type == 1</code> 的才是 PT_LOAD，本样本有 <b>' + r.loads.length + '</b> 个。') + '<br>' +
              one(szOk, '④ .bss 的来源：p_memsz − p_filesz = ' + H(r.bssGap), '④ 不对。第 2 个 PT_LOAD 的 memsz − filesz = <b>' + H(r.bssGap) + '</b>。') + '<br>' +
              one(tOk, '⑤ 代码节：sh_offset = ' + H(r.text.off) + '，sh_size = ' + H(r.text.size),
                '⑤ 不对。带 <code>SHF_EXECINSTR</code>(0x4) 的节 sh_offset = <b>' + H(r.text.off) + '</b>，sh_size = <b>' + H(r.text.size) + '</b>。')
          };
        },
        showAnswer:
          '【样本布局】\n' +
          '  0x000  Elf64_Ehdr      64 字节\n' +
          '  0x040  程序头表          3 × 56 = 168 字节  → 到 0x0E8\n' +
          '  0x0E8  节头表            6 × 64 = 384 字节  → 到 0x268（共 616 字节）\n\n' +
          '【① e_machine】偏移 0x12，u2 小端 = B7 00 → 0x00B7 = 183 = EM_AARCH64\n\n' +
          '【② e_entry】偏移 0x18，u8 = 全 0 → 0\n' +
          '  为什么是 0：so 不是「从头开始执行」的。它的初始化走 .init_array /\n' +
          '  DT_INIT / JNI_OnLoad；e_entry 只在 ET_EXEC（可执行文件）里才有意义。\n' +
          '  → 所以「看 e_entry 判断 so 的入口」这件事本身就是错的。\n\n' +
          '【③ PT_LOAD 个数】程序头表 3 条：\n' +
          '  #0 p_type=1  PT_LOAD      p_flags=5 (R-X)\n' +
          '  #1 p_type=1  PT_LOAD      p_flags=6 (RW-)\n' +
          '  #2 p_type=0x6474E552  PT_GNU_RELRO  p_flags=4 (R--)\n' +
          '  → PT_LOAD 有 2 个\n\n' +
          '【④ p_memsz > p_filesz 的那个段】第 1 个 PT_LOAD：\n' +
          '  p_filesz = 0x180（文件里真实存在的字节）\n' +
          '  p_memsz  = 0x2A0（内存里占的空间）\n' +
          '  差 = 0x2A0 − 0x180 = 0x120 = 288 字节\n' +
          '  → 这段就是 .bss：文件里不占空间，加载时 memset 为 0\n' +
          '  交叉验证：节表第 4 项 type=8(SHT_NOBITS)，size=0x120 —— 正好对上。\n\n' +
          '【⑤ 代码节】节表里唯一带 SHF_EXECINSTR(0x4) 的是第 1 项：\n' +
          '  sh_flags = 0x6 = ALLOC(0x2) | EXECINSTR(0x4)\n' +
          '  sh_addr   = 0x0000000000001A10\n' +
          '  sh_offset = 0x0000000000001A10\n' +
          '  sh_size   = 0x0000000000000800\n' +
          '  注意 addr 与 offset 相等，是因为它属于第一个 PT_LOAD（p_offset=0, p_vaddr=0）。\n' +
          '  另外：它的名字（本应是 .text）在本样本里解不出来——节名存在 .shstrtab 里。',
        hint:
          '<b>先把三张表的边界画出来：</b>ELF 头 0x00–0x3F；程序头表从 <code>e_phoff = 0x40</code> 开始，' +
          '每条 <code>e_phentsize = 56</code> 字节；节头表从 <code>e_shoff = 0xE8</code> 开始，每条 64 字节。<br><br>' +
          '<b>字段位置提示：</b>e_machine 在头内偏移 0x12（u2），e_entry 在 0x18（u8）；' +
          '程序头里 p_type 在 +0x00（u4）、p_flags 在 +0x04（u4）、p_offset 在 +0x08（u8）、' +
          'p_filesz 在 +0x20（u8）、p_memsz 在 +0x28（u8）。<br><br>' +
          '<b>第 ⑤ 问提示：</b>不要找名字——本样本没有节名字符串表。' +
          '判断「哪个是代码」只能看 <code>sh_flags</code> 里有没有 <code>0x4</code>（SHF_EXECINSTR）。' +
          'sh_flags 在节头项的 +0x08（u8），sh_offset 在 +0x18，sh_size 在 +0x20。',
        after:
          T.note('ok', '✅ 实验的收获',
            '<p style="margin-bottom:0">你现在能只凭一段十六进制回答三个实战问题：' +
            '<b>这是什么架构的 so</b>（e_machine）、<b>它能不能被加载</b>（有几个合法 PT_LOAD、权限是否合理）、' +
            '<b>代码在文件的哪一段</b>（带 X 标志的节）。<br>' +
            '<span class="hit">这三问正是第 8 章「so 是否被加密」判定的前置条件：先确认结构正常，再谈内容是否可读。</span>' +
            '下一节把程序头单独放大，因为它是装载器唯一真正读的东西。</p>')
      }
    },

    /* ============================================================ 3.10 */
    {
      h: '3.10', title: '解析程序头：PT_LOAD、.bss 的来源与页对齐',
      html:
        '<p>程序头表是<b>装载器唯一真正读的那张表</b>。内核和 linker 拿到一个 so，' +
        '基本只做三件事：读 ELF 头 → 读程序头表 → 按 <code>PT_LOAD</code> 做 <code>mmap</code>。' +
        '所以这张表错了，文件从「数据」变成「废纸」。</p>' +
        T.card('Elf64_Phdr 的 56 字节（注意字段顺序和节头表不一样）',
          T.code(
            'uint32  p_type    <span class="c">// +0x00  段的类型</span>\n' +
            'uint32  p_flags   <span class="c">// +0x04  R=4 / W=2 / X=1 —— 注意它在 offset 前面！</span>\n' +
            'uint64  p_offset  <span class="c">// +0x08  这一段在文件里的偏移</span>\n' +
            'uint64  p_vaddr   <span class="c">// +0x10  映射到哪个虚拟地址</span>\n' +
            'uint64  p_paddr   <span class="c">// +0x18  物理地址（用户态基本不用）</span>\n' +
            'uint64  p_filesz  <span class="c">// +0x20  文件里有几个字节</span>\n' +
            'uint64  p_memsz   <span class="c">// +0x28  内存里占几个字节</span>\n' +
            'uint64  p_align   <span class="c">// +0x30  对齐要求</span>'
          ) +
          '<p style="margin-bottom:0"><b>为什么特意标出 p_flags 的位置？</b>因为 32 位的 <code>Elf32_Phdr</code> 里，' +
          '<code>p_flags</code> 是<b>最后一个字段</b>，而 64 位把它挪到了第二位。' +
          '照 32 位的顺序去解 64 位的段头，读出来的偏移和大小会全部错位——' +
          '<span class="hit">这是「凭印象写解析器」最典型的翻车点之一。</span></p>') +
        T.tbl(
          ['p_type', '值', '含义', '说明'],
          [
            ['<code>PT_LOAD</code>', '<code>1</code>', '<b>要映射进内存的一段</b>', '最重要。一个 so 通常 2 个（R-X 和 RW-）'],
            ['<code>PT_DYNAMIC</code>', '<code>2</code>', '动态链接信息', '指向 <code>.dynamic</code>，是一串 <code>(tag, value)</code>'],
            ['<code>PT_INTERP</code>', '<code>3</code>', '解释器路径', '可执行文件才有，指向 <code>/system/bin/linker64</code> 一类字符串'],
            ['<code>PT_NOTE</code>', '<code>4</code>', '辅助信息', '构建 ID、GNU 属性（BTI/PAC 声明）等'],
            ['<code>PT_PHDR</code>', '<code>6</code>', '程序头表自身', '把这张表也映射进内存，方便运行时自省'],
            ['<code>PT_TLS</code>', '<code>7</code>', '线程局部存储模板', '每个线程启动时按这块模板初始化 TLS 区'],
            ['<code>PT_GNU_EH_FRAME</code>', '<code>0x6474e550</code>', '异常回溯表', '指向 <code>.eh_frame_hdr</code>'],
            ['<code>PT_GNU_STACK</code>', '<code>0x6474e551</code>', '栈权限声明', '<code>p_flags</code> 含 X 就表示栈可执行（现代系统都要求不可执行）'],
            ['<code>PT_GNU_RELRO</code>', '<code>0x6474e552</code>', '重定位后转只读的区域', '只声明一段区间，不是一段新数据'],
            ['<code>PT_GNU_PROPERTY</code>', '<code>0x6474e553</code>', 'GNU 属性', 'AArch64 上常用来声明 BTI/PAC 支持']
          ]
        ) +
        T.note('key', '🔑 p_memsz > p_filesz 的那部分，就是 .bss',
          '<p>装载器处理一个 <code>PT_LOAD</code> 的动作可以拆成三步：</p>' +
          '<p style="margin-bottom:0">' +
          '① 按 <code>p_memsz</code>（不是 <code>p_filesz</code>！）申请 <code>p_memsz</code> 大小的内存；<br>' +
          '② 从文件 <code>p_offset</code> 处读 <code>p_filesz</code> 个字节填进去；<br>' +
          '③ 剩下的 <code>p_memsz − p_filesz</code> 个字节<b>补零</b>。</p>' +
          '<p>这第三步补出来的区域就是 <code>.bss</code>——C 语言里那些「未初始化的全局变量 / static 变量」。' +
          '它们在文件里不占空间（因为值都是 0，没必要存），只在内存里占。<br>' +
          '<span class="hit">所以看到 <code>p_memsz &gt; p_filesz</code>，不要怀疑文件被截断了——那是完全正常的 .bss。</span>' +
          '反过来，如果 <code>p_memsz &lt; p_filesz</code>，那才是真有问题（内存里装不下文件里的内容）。</p>') +
        T.card('页对齐：为什么这件事在逆向里很重要',
          '<p>内存映射的最小单位是<b>页</b>（AArch64 Linux 上通常 4KB）。这带来两条硬约束：</p>' +
          '<p>① <b><code>p_vaddr</code> 与 <code>p_offset</code> 必须同余于 <code>p_align</code></b>' +
          '（也就是 <code>p_vaddr ≡ p_offset (mod p_align)</code>，实际实现里还要求页对齐）。' +
          '否则装载器无法用一次 <code>mmap</code> 把「文件偏移」和「虚拟地址」对上。' +
          '本样本里 <code>p_offset = 0x2A10</code>、<code>p_vaddr = 0x3A10</code>，' +
          '两者相差 0x1000（正好是页大小），所以对得上——<span class="hit">你可以在实验里自己验算这一条。</span></p>' +
          '<p style="margin-bottom:0">② <b>权限是按页设的，不是按段设的</b>。如果你有两个权限不同的段恰好落在同一页里，' +
          '内核只能取「较大的权限」或者拆开映射。这解释了为什么链接器要费劲地把可执行段和数据段<b>按页对齐</b>分开——' +
          '否则就会出现「为了能执行代码，把数据页也设成可执行」这种 rwx 页。<br>' +
          '<span class="hit">第 8 章讲「从 /proc/self/maps 里挑出可疑映射」，看的就是页权限；' +
          '而页权限为什么会长成那样，答案就在这里。</span></p>'),
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            scenario: '你在分析一个从 APK 里取出的 <code>libnative.so</code>。用脚本解析它的程序头表，' +
                      '发现第一个 <code>PT_LOAD</code> 的 <code>p_filesz = 0x4A10</code>、<code>p_memsz = 0x4C80</code>，' +
                      '第二个 <code>PT_LOAD</code> 是 <code>0x180 / 0x2A0</code>。',
            q: '第一个段的 <code>p_memsz</code> 比 <code>p_filesz</code> 大了 0x270 字节。你怎么解释这个差值？',
            choices: [
              { t: '文件被截断了，少了 0x270 字节，得重新取一份完整的 so。', next: 'n1' },
              { t: '这是正常的：多出来的部分是要补零的 .bss（未初始化数据），文件里本来就不存。', next: 'n2' },
              { t: '说明这个 so 被加固了，加密数据占了这部分空间。', next: 'n3' },
              { t: '先交叉验证一下：去节表里找一个 type 为 SHT_NOBITS(8) 的节，看它的 size 是不是 0x270。', next: 'n4' }
            ]
          },
          n1: {
            terminal: true, verdict: 'bad', verdictTitle: '把「正常的 .bss」当成了「文件损坏」',
            result: '<p><b>这条路会浪费你一整个下午。</b>你会去重新下载、重新提取、换工具，' +
                    '但每次拿到的文件都一样——因为它本来就是完整的。</p>' +
                    '<p><b>认知根源：</b>你把「文件字节数」和「内存占用」当成了同一个量。' +
                    'ELF 里这两个量是分开的：<code>p_filesz</code> 是文件里真实存在的字节，' +
                    '<code>p_memsz</code> 是运行时需要的内存。' +
                    '而<b>全零的数据没必要存在文件里</b>，这就是 <code>.bss</code>。</p>' +
                    '<p>真正该警觉的是<b>反过来</b>：<code>p_memsz &lt; p_filesz</code>，' +
                    '或者 <code>p_offset + p_filesz</code> 超出了文件的实际大小——那才叫截断。</p>'
          },
          n2: {
            scenario: '你判断这是 .bss，接着往下走。你还需要确认一件事：这个 so 的结构是否整体自洽？',
            q: '下面哪一件事最能一次性确认「这个 ELF 的结构没有被破坏」？',
            choices: [
              { t: '看 ELF 魔数是不是 7f 45 4c 46。', next: 'n5' },
              { t: '把所有 PT_LOAD 的 p_offset + p_filesz 加起来，看有没有超出文件大小；再检查每个段的 p_vaddr ≡ p_offset (mod p_align)。', next: 'n6' },
              { t: '用 file 命令看它是不是识别成 ELF。', next: 'n5' }
            ]
          },
          n3: {
            terminal: true, verdict: 'bad', verdictTitle: '把结构特征误读成了加固特征',
            result: '<p>「<code>p_memsz &gt; p_filesz</code>」是<b>每一个</b>带全局变量的 C/C++ 程序都有的现象，' +
                    '和加固没有任何关系。用这个当加固依据，你几乎会把所有 so 都判成加固。</p>' +
                    '<p><b>认知根源：</b>你在找「能证明加固的证据」时，抓了一个<b>没有区分度</b>的特征。' +
                    '判断加固要看的特征必须满足一条：<span class="hit">正常文件不会有，被处理过的文件才会有。</span><br>' +
                    '比如「节表被抹掉但代码段仍有成规模的内容」「<code>.dynsym</code> 几乎为空但 <code>.text</code> 很大」' +
                    '——这些才是有区分度的（第 8 章）。</p>' +
                    '<p>如果你确实怀疑加固，正确的动作是：先确认结构正常（这样排除了「文件坏了」），' +
                    '再看内容是否可读、符号是否正常——两步分开做。</p>'
          },
          n4: {
            scenario: '你去节表里找到了一个 <code>type = 8</code>（SHT_NOBITS）的节，<code>sh_size = 0x270</code>，' +
                      '正好等于差值。但你也注意到：这个 so 的节表<b>存在</b>，说明它没被 strip 掉节表。',
            q: '这一步交叉验证说明了什么？接下来最有价值的动作是什么？',
            choices: [
              { t: '说明结构自洽。接着去解引用 <code>.dynsym</code>，看导出符号里有没有 <code>Java_</code> 开头的名字。', next: 'n7' },
              { t: '既然结构正常，那就可以断定这个 so 没有加固，直接开始反编译代码。', next: 'n8' },
              { t: '节表存在说明它一定没被处理过，可以跳过结构分析。', next: 'n8' }
            ]
          },
          n5: {
            terminal: true, verdict: 'bad', verdictTitle: '验证强度太弱，等于没验证',
            result: '<p>魔数只有 4 个字节，<code>file</code> 命令也主要看头部。' +
                    '<b>加固工具完全可以保留一个合法的 ELF 头</b>，把后面全加密——' +
                    '这时魔数是对的、<code>file</code> 也认，但段表是假的。</p>' +
                    '<p><b>认知根源：</b>你选了一个「通过它也不能推出结论」的检查。' +
                    '结构验证要挑<b>能覆盖全局的约束</b>：段的偏移与大小是否越界、' +
                    '虚拟地址与文件偏移的对齐关系是否成立、各表的条数与位置是否落在文件内。' +
                    '<span class="hit">魔数只能证明「这是个 ELF 开头」，不能证明「这是个能加载的 ELF」。</span></p>'
          },
          n6: {
            scenario: '两件事都通过了：所有 <code>PT_LOAD</code> 的 <code>p_offset + p_filesz</code> 都没超出文件大小，' +
                      '每个段的 <code>p_vaddr ≡ p_offset (mod p_align)</code> 也成立。你用的是同一份十六进制，' +
                      '没有依赖任何工具。',
            q: '结构自洽之后，判断「这个 so 有没有被动过手脚」，最有效的下一步是哪个？',
            choices: [
              { t: '去读 <code>.dynsym</code>：看导出符号是否正常（有没有 <code>Java_</code> / <code>JNI_OnLoad</code>），' +
                   '同时看 <code>.text</code> 的规模——「符号少但代码多」是有区分度的信号。', next: 'n7' },
              { t: '既然结构都对了，那这个 so 一定是原版，可以直接用 IDA 反编译。', next: 'n8' }
            ]
          },
          n7: {
            terminal: true, verdict: 'good', verdictTitle: '结构验证 → 内容验证，两步分开，这才是对的顺序',
            result: '<p><b>你的路径是对的，而且是可以复用的：</b></p>' +
                    '<p>① <b>先用全局约束证明「结构没坏」</b>——段偏移不越界、对齐关系成立。' +
                    '这一步排除了「文件损坏 / 半截 dump」这一类原因，也顺带识别出 <code>.bss</code> 这种正常现象。<br>' +
                    '② <b>再看内容有没有被处理</b>——符号表的密度、代码段的规模、节表的完整性。' +
                    '「<code>.dynsym</code> 近乎为空但 <code>.text</code> 里代码成规模」，' +
                    '说明是<b>抹掉名字</b>而不是<b>抹掉内容</b>，两者的应对方式完全不同（第 8 章）。</p>' +
                    '<p><b>为什么这个顺序重要：</b>如果先看内容再看结构，你很容易把「结构正常但符号少」误判成加固，' +
                    '也容易把「结构损坏」当成加密。<span class="hit">先排除最平凡的解释，再考虑最复杂的解释。</span></p>'
          },
          n8: {
            terminal: true, verdict: 'bad', verdictTitle: '把「没发现问题」当成了「没有问题」',
            result: '<p>结构自洽只说明<b>「这个 ELF 是完整的」</b>，它完全不排除加固。' +
                    '加固方最擅长的恰恰是<b>保留一个合法的 ELF 结构</b>，让你以为一切正常。</p>' +
                    '<p><b>认知根源：</b>你把「验证通过」当成了「结论」。</p>' +
                    '<p>结构检查的作用是<b>排除一类原因</b>，不是<b>给出结论</b>。' +
                    '它排除的是「文件坏了 / dump 不完整」；它证明不了「内容没被处理过」。' +
                    '<span class="hit">要判断内容，就得去看内容：符号密度、代码规模、字符串可读性。' +
                    '这两步是独立的，缺一不可。</span></p>'
          }
        }
      },
      quiz: {
        id: 'q28-3', chapter: 28, answer: 1,
        stem: '一个 AArch64 的 so，某个 <code>PT_LOAD</code> 的 <code>p_filesz = 0x180</code>、<code>p_memsz = 0x2A0</code>。' +
              '这个差值 <code>0x120</code> 最准确的解释是什么？',
        options: [
          { t: '文件被截断了，缺了 0x120 字节，需要重新获取。',
            why: '如果真是截断，表现应该是 <code>p_offset + p_filesz</code> 超出文件实际大小，' +
                 '而不是 <code>p_memsz</code> 大于 <code>p_filesz</code>。这两个现象方向正好相反。' },
          { t: '这 0x120 字节是加载时补零的未初始化数据（.bss），文件里本来就不存放。',
            why: '<b>正确。</b>装载器按 <code>p_memsz</code> 申请内存、写入 <code>p_filesz</code> 字节、其余补零；' +
                 '补零的区域就是 .bss。可以在节表里找到 <code>SHT_NOBITS</code> 的节来交叉验证。' },
          { t: '多出来的部分是 TLS 区，用于线程局部存储。',
            why: 'TLS 有自己独立的段类型 <code>PT_TLS</code>，不会以「同一个 PT_LOAD 里 memsz 比 filesz 大」的形式出现。' },
          { t: '说明该段在内存里被加密数据填充，是加固特征。',
            why: '这是把一个所有 C/C++ 程序都有的正常现象当成了加固特征。' +
                 '判断加固要找「正常文件不会有」的特征，<code>p_memsz &gt; p_filesz</code> 显然不是。' }
        ],
        explain:
          '<p>装载器处理一个 <code>PT_LOAD</code> 的动作是固定的三步：</p>' +
          '<ol>' +
          '<li>按 <b><code>p_memsz</code></b> 申请内存（不是 <code>p_filesz</code>）；</li>' +
          '<li>从文件 <code>p_offset</code> 读 <b><code>p_filesz</code></b> 个字节写进去；</li>' +
          '<li>剩下的 <code>p_memsz − p_filesz</code> 个字节<b>补零</b>。</li>' +
          '</ol>' +
          '<p>第 3 步补出来的就是 <code>.bss</code>：未初始化的全局变量和 static 变量。' +
          '它们的值全是 0，而一整片 0 没必要占文件空间——所以只在内存里占。' +
          '这就是「文件里 0x180 字节，内存里 0x2A0 字节」的全部含义。</p>' +
          '<p><b>为什么这个知识点在实战里反复出现？</b>因为从内存 dump 出来的 so（第 18 章、第 8 章）经常出现' +
          '「<code>p_filesz</code> 和 <code>p_memsz</code> 不匹配」「<code>p_offset</code> 对不上」这类现象。' +
          '分得清「正常 bss」和「dump 出来的错位」，才能判断手里的 so 是需要修复还是根本没问题。</p>' +
          '<p>顺带把方向记住：<b><code>p_memsz ≥ p_filesz</code> 是常态</b>，' +
          '反过来（<code>p_memsz &lt; p_filesz</code>）才是异常。' +
          '另外，页对齐约束 <code>p_vaddr ≡ p_offset (mod p_align)</code> 可以用来批量验证一个 so 的段表是否自洽——' +
          '这是不需要任何工具就能做的完整性检查。</p>'
      }
    },

    /* ============================================================ 3.11 */
    {
      h: '3.11', title: '解析节表：分析者的索引，以及 rwx 是从哪来的',
      html:
        '<p>节表是<b>逆向时你最常看的那张表</b>。它一条 64 字节，给出每个节的名字、类型、偏移、大小和标志。' +
        '这里有个必须先说清的事实：<b>节的名字不在节里</b>。</p>' +
        T.card('Elf64_Shdr 的 64 字节',
          T.code(
            'uint32  sh_name      <span class="c">// +0x00  只是 .shstrtab 里的一个偏移！</span>\n' +
            'uint32  sh_type      <span class="c">// +0x04  节类型（PROGBITS / NOBITS / DYNSYM / RELA …）</span>\n' +
            'uint64  sh_flags     <span class="c">// +0x08  标志位：W=1 / A=2 / X=4 …</span>\n' +
            'uint64  sh_addr      <span class="c">// +0x10  运行时虚拟地址（不加载的节这里是 0）</span>\n' +
            'uint64  sh_offset    <span class="c">// +0x18  文件里的偏移</span>\n' +
            'uint64  sh_size      <span class="c">// +0x20  大小</span>\n' +
            'uint32  sh_link      <span class="c">// +0x28  关联的另一个节的下标</span>\n' +
            'uint32  sh_info      <span class="c">// +0x2C  附加信息</span>\n' +
            'uint64  sh_addralign <span class="c">// +0x30  对齐</span>\n' +
            'uint64  sh_entsize   <span class="c">// +0x38  如果是表，一条多大</span>'
          ) +
          '<p style="margin-bottom:0"><b>sh_name 是偏移不是名字。</b>所有节名集中在 <code>.shstrtab</code> 这个节里，' +
          '<code>sh_name</code> 只是它在 <code>.shstrtab</code> 里的下标，而 <code>.shstrtab</code> 是第几个节由 ELF 头的 ' +
          '<code>e_shstrndx</code> 给出。<span class="hit">所以一旦节表被抹掉，名字也就一起没了——这是同时发生的两件事。</span></p>') +
        T.tbl(
          ['节名', '典型类型', '典型标志', '里面是什么', '进内存吗'],
          [
            ['<code>.text</code>', 'PROGBITS', 'A + X', '<b>机器码</b>', '是'],
            ['<code>.rodata</code>', 'PROGBITS', 'A', '只读常量（字符串字面量、常量表）', '是'],
            ['<code>.data</code>', 'PROGBITS', 'A + W', '已初始化的全局 / 静态变量', '是'],
            ['<code>.bss</code>', 'NOBITS', 'A + W', '未初始化数据（<b>文件里不占空间</b>）', '是（补零）'],
            ['<code>.dynsym</code>', 'DYNSYM', 'A', '<b>动态符号表</b>（运行时用）', '是'],
            ['<code>.dynstr</code>', 'STRTAB', 'A', '动态符号的名字字符串', '是'],
            ['<code>.symtab</code>', 'SYMTAB', '—', '完整符号表（<b>只给链接器 / 调试器</b>）', '<b>否</b>'],
            ['<code>.strtab</code>', 'STRTAB', '—', '<code>.symtab</code> 的名字字符串', '<b>否</b>'],
            ['<code>.rela.dyn</code>', 'RELA', 'A', '数据类重定位（GOT、函数指针、绝对地址）', '是'],
            ['<code>.rela.plt</code>', 'RELA', 'A + I', 'PLT 用的重定位（跳转槽）', '是'],
            ['<code>.init_array</code>', 'INIT_ARRAY', 'A + W', '<b>初始化函数指针数组</b>（谁先跑的答案）', '是'],
            ['<code>.fini_array</code>', 'FINI_ARRAY', 'A + W', '退出时的函数指针数组', '是'],
            ['<code>.dynamic</code>', 'DYNAMIC', 'A + W', '<code>(tag, value)</code> 数组，链接信息的入口', '是'],
            ['<code>.got</code> / <code>.got.plt</code>', 'PROGBITS', 'A + W', '全局偏移表（重定位的落点）', '是'],
            ['<code>.plt</code>', 'PROGBITS', 'A + X', '跳转桩（延迟绑定的第一跳）', '是'],
            ['<code>.shstrtab</code>', 'STRTAB', '—', '节名字符串表', '<b>否</b>'],
            ['<code>.comment</code>', 'PROGBITS', '—', '编译器版本字符串', '<b>否</b>']
          ]
        ) +
        T.note('key', '🔑 sh_flags 决定了它在 /proc/self/maps 里长什么样',
          '<p><code>sh_flags</code> 里三个位最要紧：<code>SHF_WRITE = 0x1</code>、<code>SHF_ALLOC = 0x2</code>、' +
          '<code>SHF_EXECINSTR = 0x4</code>。它们和程序头的 <code>p_flags</code>（<code>R=4</code> / <code>W=2</code> / <code>X=1</code>）' +
          '是两套独立的标志位，<b>数值也不一样</b>，很容易记混。</p>' +
          '<p style="margin-bottom:0">它们的关系是：<b><code>sh_flags &amp; SHF_ALLOC</code> 决定这个节会不会被装进内存</b>；' +
          '进了内存之后，具体落成 <code>r--</code> 还是 <code>rw-</code> 还是 <code>r-x</code>，' +
          '由它所属的 <code>PT_LOAD</code> 段的 <code>p_flags</code> 决定。<br>' +
          '<span class="hit">所以「某个节是可写的」不等于「运行时那一页一定是 rw」——' +
          '页权限是按段设的，粒度粗得多。</span>' +
          '第 8 章从 <code>/proc/self/maps</code> 里读到的 rwx，就是这里的段权限在运行时的最终形态；' +
          '一旦出现 <code>rwx</code> 同页，通常意味着链接器没能把可执行段和数据段按页分开。' +
          '另外别忘了一个更常见的 rw 页来源：<b><code>PT_GNU_RELRO</code></b> 会把重定位后的区域改成只读，' +
          '于是 GOT 在 <code>maps</code> 里表现成一个独立的 <code>r--</code> 页——这常常是分析时的干扰项。</p>') +
        '<p>下面用终端模拟走一遍「用 <code>readelf</code> 看一个 so」的典型过程。' +
        '<span class="pill warn">示意输出</span> 列名与节名是真实的，具体偏移、条数会随样本变化。</p>',
      term: {
        title: '用 readelf 看一个 AArch64 so 的节表与符号（示意）',
        lines: [
          { t: 'p', s: 'readelf -h libnative.so',
            note: '<b>第一步永远先看 ELF 头。</b>这里就能确认「是不是 ELF64、是不是小端、是不是 AArch64、是不是 ET_DYN」。' +
                  '如果连这一步都报错，说明文件不是 ELF 或已被整体加密——那是另一个问题（第 8 章）。' },
          { t: 'o', s: 'ELF Header:',
            note: '' },
          { t: 'o', s: '  Magic:   7f 45 4c 46 02 01 01 00 00 00 00 00 00 00 00 00',
            note: 'Magic 之后那 4 个字节就是 e_ident 的 class/data/version/osabi：<code>02</code>=ELF64、<code>01</code>=小端、<code>01</code>=版本 1、<code>00</code>=SYSV。' },
          { t: 'o', s: '  Class:                             ELF64',
            note: 'ELF64 → 后面所有指针 / 偏移都是 8 字节。这一行读错，后面全错。' },
          { t: 'o', s: '  Data:                              2\'s complement, little endian',
            note: '小端。Android 目前所有主流 ABI 都是小端。' },
          { t: 'o', s: '  Type:                              DYN (Shared object file)',
            note: '<code>ET_DYN</code>（值 3）：这是可被 <code>dlopen</code> 的共享库（也可能是 PIE 可执行文件，两者都是 ET_DYN）。' },
          { t: 'o', s: '  Machine:                           AArch64',
            note: '<code>e_machine = 183</code>。和你的设备 / 模拟器架构不匹配的 so 是装不上的。' },
          { t: 'o', s: '  Entry point address:               0x0',
            note: '<b>入口是 0，这很正常。</b>共享库不是「从头执行」的，初始化走 <code>.init_array</code> / <code>DT_INIT</code>。' },
          { t: 'o', s: '  Start of program headers:          64 (bytes into file)',
            note: '程序头表紧跟 ELF 头（64 = ELF 头的大小）。<b>装载器只读这张表。</b>' },
          { t: 'o', s: '  Number of program headers:         7',
            note: '段的数量。通常 5～9 个：2 个 PT_LOAD 加上 DYNAMIC / GNU_RELRO / GNU_STACK / NOTE 等。' },
          { t: 'o', s: '  Number of section headers:         27',
            note: '节的数量。<b>这个数字可以为 0</b>——抹掉节表的 so 依然能运行。' },
          { t: 'o', s: '  Section header string table index: 26',
            note: '第 26 个节是 <code>.shstrtab</code>，所有节名都在它里面。这就是 <code>sh_name</code> 需要的那张表。' },
          { t: 'p', s: 'readelf -S -W libnative.so',
            note: '<b>第二步看节表。</b>如果这一步输出「There are no sections」或者条数为 0，' +
                  '不要立刻下「被加密」的结论——先用 <code>-l</code> 看程序头是否完整（本节的决策演练会走这个判断）。' },
          { t: 'o', s: 'There are 27 section headers, starting at offset 0x25b0:',
            note: '节表本身的文件偏移。它通常贴在文件末尾，在所有节数据之后。' },
          { t: 'o', s: '  [Nr] Name              Type            Address          Off    Size   ES Flg Lk Inf Al',
            note: '列的含义：<code>ES</code> 是「一条表项多大」（表类型的节才有），<code>Flg</code> 是标志位，<code>Lk/Inf</code> 是链接信息，<code>Al</code> 是对齐。' },
          { t: 'o', s: '  [ 1] .note.gnu.build-id NOTE            0000000000000238 000238 000024 00   A  0   0  4',
            note: '<code>A</code> = SHF_ALLOC，会进内存。build-id 是构建指纹，加固方有时会把它抹掉。' },
          { t: 'o', s: '  [ 3] .dynsym           DYNSYM          0000000000000278 000278 0001b0 18   A  4   1  8',
            note: '<b>动态符号表。</b><code>ES = 0x18 = 24</code> 字节，正好是 <code>Elf64_Sym</code> 的大小。' +
                  '<code>Lk = 4</code> 表示它的名字字符串在第 4 个节（<code>.dynstr</code>）里。' },
          { t: 'o', s: '  [ 4] .dynstr           STRTAB          0000000000000428 000428 0001f4 00   A  0   0  1',
            note: '动态字符串表。<b>它和 <code>.dynsym</code> 是一对，运行时必须存在</b>——删了这两个，程序根本起不来。' },
          { t: 'o', s: '  [ 5] .rela.dyn         RELA            0000000000000618 000618 0001e0 18   A  3   0  8',
            note: '数据重定位表，<code>ES = 0x18 = 24</code>，对应 <code>Elf64_Rela</code>。<code>Lk = 3</code> 指向 <code>.dynsym</code>。' },
          { t: 'o', s: '  [ 6] .rela.plt         RELA            00000000000007f8 0007f8 000060 18  AI  3  20  8',
            note: '<code>Flg</code> 里的 <code>I</code> 表示 <code>SHF_INFO_LINK</code>：这一节的 <code>sh_info</code> 有意义，' +
                  '这里 <code>Inf = 20</code> 指向它作用的目标节（<code>.got.plt</code> 一类）。' },
          { t: 'o', s: '  [ 8] .text             PROGBITS        0000000000000940 000940 0015c0 00  AX  0   0 16',
            note: '<b>代码节。</b><code>AX</code> = ALLOC + EXECINSTR。' +
                  '<span class="hit">注意 addr 与 off 相等——因为这个 so 的第一个 PT_LOAD 是 p_offset = p_vaddr = 0。</span>' },
          { t: 'o', s: '  [20] .init_array       INIT_ARRAY      0000000000003b90 002b90 000010 08  WA  0   0  8',
            note: '<code>ES = 8</code>：这是一个<b>指针数组</b>，每个元素 8 字节，内容是要被调用的初始化函数地址。' +
                  'loader 会在重定位完成后逐个调用。' },
          { t: 'o', s: '  [25] .bss              NOBITS          0000000000003ec0 002ec0 000120 00  WA  0   0  8',
            note: '<code>NOBITS</code> 表示这一节<b>在文件里不占字节</b>，<code>Off</code> 只是「如果占的话会在哪」。' +
                  '它对应的就是某个 <code>PT_LOAD</code> 里 <code>p_memsz − p_filesz</code> 补零的那一段。' },
          { t: 'o', s: '  [26] .shstrtab         STRTAB          0000000000000000 002ec0 0000fd 00      0   0  1',
            note: '节名字符串表。<b>没有 <code>A</code> 标志 → 不进内存。</b>' +
                  '抹掉节表时它也会一起消失，于是所有节名都没了。' },
          { t: 'p', s: 'readelf --dyn-syms -W libnative.so',
            note: '<b>第三步看动态符号。</b><code>--dyn-syms</code> 只列 <code>.dynsym</code>，也就是运行时真正需要的那份。' },
          { t: 'o', s: 'Symbol table \'.dynsym\' contains 18 entries:',
            note: '18 条 = <code>.dynsym</code> 的 <code>Size 0x1b0 ÷ ES 0x18</code>。两个数字能互相验证。' },
          { t: 'o', s: '   Num:    Value          Size Type    Bind   Vis      Ndx Name',
            note: '<code>Bind</code> 是 LOCAL/GLOBAL/WEAK，<code>Ndx</code> 是它定义在哪个节，<code>UND</code> 表示未定义（即导入）。' },
          { t: 'o', s: '     0: 0000000000000000     0 NOTYPE  LOCAL  DEFAULT  UND',
            note: '第 0 条永远是空符号（全是 0），这是规范要求的占位项。所以「有 18 条」里真正有效的通常是 17 条。' },
          { t: 'o', s: '     1: 0000000000000940   120 FUNC    GLOBAL DEFAULT    8 Java_com_example_app_Sign_getSign',
            note: '<b>这一行就是逆向的入口路标。</b><code>FUNC</code> + <code>GLOBAL</code> + 具体的节号（8 = <code>.text</code>）' +
                  '表示「这个 so 导出了一个函数」。<code>Java_</code> 前缀说明它是<b>静态注册</b>的 JNI 函数，' +
                  '名字直接编码了 Java 侧的包名、类名、方法名（第 9 章）。' },
          { t: 'o', s: '    12: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND __android_log_print',
            note: '<code>UND</code> = 未定义 = <b>导入符号</b>。这个 so 依赖外部的 <code>__android_log_print</code>，' +
                  '运行时由 linker 在 liblog 里找，并把地址填进 GOT——这就是下一节重定位要讲的事。' },
          { t: 'w', s: '（如果这个 so 被 strip 过：--dyn-syms 依然有内容，但 readelf -s 几乎没有输出）',
            note: '<b>这一行是本节最该带走的一句话。</b>strip 掉的是 <code>.symtab</code>，不是 <code>.dynsym</code>。' +
                  '所以「符号表空了」这个观察必须问清是哪一个符号表。' }
        ]
      },
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            scenario: '你手上有一个从 APK 里取出的 so。执行 <code>readelf -h libx.so</code>，' +
                      '头部一切正常：ELF64、小端、AArch64、<code>ET_DYN</code>、程序头 7 个。' +
                      '但接着执行 <code>readelf -S libx.so</code>，输出是「<b>There are no sections in this file.</b>」',
            q: '看到「没有节表」，你的第一反应应该是什么？',
            choices: [
              { t: 'so 被整体加密了，得去做内存 dump。', next: 'n1' },
              { t: '先别下结论：用 <code>readelf -l</code> 看程序头表是否完整，并检查段的偏移/大小是否越界。', next: 'n2' },
              { t: '文件损坏了，重新从 APK 里解压一次。', next: 'n3' },
              { t: '直接用 IDA 打开，看它能不能自动识别出函数。', next: 'n4' }
            ]
          },
          n1: {
            terminal: true, verdict: 'bad', verdictTitle: '跳过验证，直接跳到最刺激的解释',
            result: '<p>「没有节表」和「内容加密」是<b>两件不同的事</b>，而且前者是一个<b>完全合法</b>的 ELF 状态。' +
                    'ELF 规范里节表是<b>可选</b>的：装载器只看程序头表。</p>' +
                    '<p><b>这条路会在什么情况下失败：</b>当你遇到一个大体积（几 MB）、程序头完全正常、' +
                    '代码段里代码成规模、只是节表被工具抹掉的 so 时，' +
                    '你会白白去跑一遍内存 dump，最后发现 dump 出来的东西和文件里的一模一样。</p>' +
                    '<p><b>认知根源：</b>你把「我熟悉的那个工具失效了」当成了「文件结构被破坏了」。' +
                    '<span class="hit">工具失效（readelf 列不出节）和文件失效（没法加载）是两个层次的事。</span>' +
                    '先分清这两层，再谈加固。</p>'
          },
          n2: {
            scenario: '你执行 <code>readelf -l libx.so</code>：7 个程序头都在，2 个 <code>PT_LOAD</code>（一个 R-X、一个 RW-），' +
                      '所有 <code>p_offset + p_filesz</code> 都没超出文件大小，<code>p_vaddr ≡ p_offset (mod p_align)</code> 也成立。' +
                      '用脚本扫描文件，在代码段区间里找到了大量连续、看起来像指令的字节。',
            q: '这些证据合起来说明什么？下一步该查什么？',
            choices: [
              { t: '结构完整 + 代码段有内容 → 是「节表被抹」而不是「内容被加密」。接着去看 <code>.dynamic</code> / <code>PT_DYNAMIC</code> 是否完整，以及动态符号表还在不在。', next: 'n5' },
              { t: '既然代码段有内容，说明没加固，可以直接反编译了。', next: 'n6' },
              { t: '节表没了就没法反编译，必须先用工具重建节表，重建之前什么都做不了。', next: 'n7' }
            ]
          },
          n3: {
            terminal: true, verdict: 'bad', verdictTitle: '把「正常现象」当成「文件损坏」',
            result: '<p>重新解压之后你会拿到一个一模一样的文件——因为 <b>APK 里那份本来就是没有节表的</b>。' +
                    '很多加固方案就是这么做的：抹掉节表，让静态分析工具无从下手，但程序照样能跑。</p>' +
                    '<p><b>认知根源：</b>你默认了「正常的 ELF 一定有节表」。事实上节表在整个加载流程里' +
                    '<b>一步都不参与</b>：内核和 linker 只读程序头表。' +
                    '<span class="hit">节表是给链接器和分析者准备的，属于「可选的元数据」。</span></p>'
          },
          n4: {
            terminal: true, verdict: 'bad', verdictTitle: '把工具当成了判据',
            result: '<p>IDA、Ghidra 这类工具在没有节表时确实还是能反汇编——因为它们同样会退回去读程序头。' +
                    '但这解决的是「我能不能干活」，不解决「这个文件被做了什么」。</p>' +
                    '<p><b>认知根源：</b>你用「工具能不能用」替代了「结构说明了什么」。' +
                    '而这个判断的价值恰恰在于它<b>分层</b>：<br>' +
                    '• 结构层：能不能加载、代码在不在 → 决定要不要去内存 dump；<br>' +
                    '• 符号层：名字还在不在 → 决定要不要做符号恢复；<br>' +
                    '• 内容层：代码是不是真的 → 决定要不要做指令级分析。</p>' +
                    '<p>直接跳过前两层，你会在错误的层面上花掉最多的时间。</p>'
          },
          n5: {
            terminal: true, verdict: 'good', verdictTitle: '先分层验证，再决定路线',
            result: '<p><b>这就是对的顺序。</b>你把「节表没了」拆成了三个独立的问题：</p>' +
                    '<p>① <b>程序头完整吗？</b>——决定它<b>能不能被加载</b>。2 个 PT_LOAD、权限合理、偏移不越界，说明能。<br>' +
                    '② <b>代码段有内容吗？</b>——决定内容<b>是不是被整体加密</b>。有连续成规模的代码，说明没有。<br>' +
                    '③ <b>动态链接信息还在吗？</b>——<code>PT_DYNAMIC</code>、<code>.dynsym</code>、<code>.dynstr</code> 这些' +
                    '<b>运行时必须存在</b>的东西如果也被破坏了，那才是真的动到了运行的根基（也意味着这个 so 只能靠修复才能加载）。</p>' +
                    '<p>结论先写成一句话：<span class="hit">「节表被抹掉了，但内容和加载所需的结构都是完整的」</span>——' +
                    '这是一种非常常见的加固形态，处理方式是「用程序头当坐标系继续分析」，' +
                    '必要时再用 SoFixer 一类工具重建节表（第 18 章），而不是去 dump 内存。</p>' +
                    '<p>顺便记住这个判断的可复用性：<b>「工具看不到」不等于「东西不在」</b>。' +
                    '同名的问题在 dex 那边也一样——<code>jadx</code> 看不到类，可能是 class_defs 被抽了，' +
                    '也可能是加载器的问题（第 16 章）。</p>'
          },
          n6: {
            terminal: true, verdict: 'bad', verdictTitle: '把「能反编译」当成了「分析完成」',
            result: '<p>「代码段有内容」只能排除<b>整体加密</b>这一种情况。' +
                    '抹节表、抹符号、字符串加密、代码虚拟化——这些都不会影响「代码段看起来有指令」。</p>' +
                    '<p><b>认知根源：</b>你用一个证据去支撑了一个它力不能及的结论。' +
                    '每个观测点只能排除有限的几种可能：<br>' +
                    '• 代码段有指令 → 排除「整体加密」；<br>' +
                    '• <code>.dynsym</code> 为空但代码规模正常 → 指向「抹名字」；<br>' +
                    '• 字符串区读不出可打印内容 → 指向「字符串加密」；<br>' +
                    '• 大量跳进同一个分发器 → 指向「VMP」。</p>' +
                    '<p>单独任何一条都不足以定性，<span class="hit">加固判定永远是「多个观测点收敛到同一个解释」的过程（第 8 章）。</span></p>'
          },
          n7: {
            terminal: true, verdict: 'bad', verdictTitle: '把「重建节表」当成了前置条件',
            result: '<p>重建节表对<b>分析</b>有帮助（IDA 的节名、<code>.plt</code> 识别、重定位解析都更顺），' +
                    '但它不是<b>前置条件</b>。程序头表已经给了你完整的坐标系：哪些区间进内存、什么权限、代码在哪一段。</p>' +
                    '<p><b>认知根源：</b>你把「工具的习惯」当成了「数据的依赖」。' +
                    'readelf / IDA 平时都按节名工作，于是你下意识以为「没有节表就无从下手」。' +
                    '<span class="hit">实际上真正决定可分析性的是：段在不在、代码在不在、符号还剩多少。</span></p>' +
                    '<p>更实际的做法：先用程序头把段区间标出来，直接在这些区间上做反汇编和字符串搜索；' +
                    '把「要不要重建节表」当成<b>后续的可选优化</b>，而不是开工的门槛。</p>'
          }
        }
      }
    },

    /* ============================================================ 3.12 */
    {
      h: '3.12', title: '解析符号表：.dynsym 与 .symtab 的分工',
      html:
        '<p>符号表是 so 里最像「文档」的东西：它把地址和名字对应起来。' +
        '理解它的关键是一句话：<strong>一个 so 里可以有两份符号表，它们服务的对象完全不同。</strong></p>' +
        T.card('Elf64_Sym 的 24 字节',
          T.code(
            'uint32  st_name   <span class="c">// +0x00  在对应字符串表里的偏移（.dynstr 或 .strtab）</span>\n' +
            'uint8   st_info   <span class="c">// +0x04  高 4 位 = 绑定类型，低 4 位 = 符号类型</span>\n' +
            'uint8   st_other  <span class="c">// +0x05  可见性（DEFAULT / HIDDEN / PROTECTED）</span>\n' +
            'uint16  st_shndx  <span class="c">// +0x06  定义在哪个节；0 (SHN_UNDEF) = 未定义 = 导入</span>\n' +
            'uint64  st_value  <span class="c">// +0x08  值（ET_DYN 里是相对基址的虚拟地址）</span>\n' +
            'uint64  st_size   <span class="c">// +0x10  符号占据的大小</span>'
          ) +
          '<p style="margin-bottom:0">注意 <code>st_info</code> 是<b>一个字节装两个信息</b>：' +
          '<code>bind = st_info &gt;&gt; 4</code>、<code>type = st_info &amp; 0x0f</code>。' +
          '所以 <code>0x12</code> 表示 <code>GLOBAL</code>（1）+ <code>FUNC</code>（2）。' +
          '<span class="hit">把 st_info 当成一个枚举直接比较，是最常见的解析错误。</span></p>') +
        T.tbl(
          ['', '<code>.dynsym</code> + <code>.dynstr</code>', '<code>.symtab</code> + <code>.strtab</code>'],
          [
            ['<b>谁需要它</b>', '<b>运行时</b>：linker 要靠它做符号解析和 GOT 重定位', '<b>链接与调试</b>：静态链接器、调试器、反汇编工具'],
            ['<b>怎么被找到</b>', '通过 <code>.dynamic</code> 里的 <code>DT_SYMTAB</code> / <code>DT_STRTAB</code>',
             '只能通过节表（<code>sh_link</code> 指向 <code>.strtab</code>）'],
            ['<b>内容范围</b>', '只包含<b>需要跨模块可见</b>的符号（导出的 + 导入的）', '包含<b>所有</b>符号，含本地函数、静态变量、文件名符号'],
            ['<b>strip 会删吗</b>', '<b>不会</b>——删了程序就跑不起来', '<b>会</b>——这是 strip 的主要动作之一'],
            ['<b>不进内存？</b>', '进内存（有 <code>SHF_ALLOC</code>）', '<b>不进内存</b>（没有 <code>SHF_ALLOC</code>）'],
            ['<b>对逆向的价值</b>', '路标：<code>Java_*</code>、<code>JNI_OnLoad</code>、导入的 libc 函数',
             '金矿：本地函数名、源文件名、静态变量名（前提是没被 strip）']
          ]
        ) +
        T.note('key', '🔑 导入符号与导出符号怎么一眼分开',
          '<p>同一个 <code>.dynsym</code> 里，导入和导出是混在一起的。判别只看一个字段：<b><code>st_shndx</code></b>。</p>' +
          '<p style="margin-bottom:0">' +
          '• <code>st_shndx == 0</code>（<code>SHN_UNDEF</code>）→ <b>导入</b>：这个名字在<b>别的</b>模块里，' +
          '本模块只在 GOT 里留一个槽等 linker 填。比如 <code>__android_log_print</code>、<code>memcpy</code>。<br>' +
          '• <code>st_shndx</code> 是一个具体节号 → <b>定义在本文件</b>：' +
          '配合 <code>st_info</code> 的绑定类型（<code>GLOBAL</code> 或 <code>WEAK</code>）和可见性（<code>DEFAULT</code>），' +
          '就成为<b>导出符号</b>，别的模块能按名字找到它。</p>' +
          '<p>还有一个容易忽略的点：<code>st_value</code> 在 <code>ET_DYN</code>（so）里存的是' +
          '<b>相对加载基址的虚拟地址</b>，不是文件偏移。' +
          '要知道它在文件里的位置，还得减掉所属段的 <code>p_vaddr</code> 再加上 <code>p_offset</code>。' +
          '<span class="hit">「符号的地址」和「符号在文件里的位置」是两个值——这是从内存 dump 里恢复 so 时必须处理的换算。</span></p>') +
        T.note('bad', '🔥 为什么 Java_ 开头的导出符号是路标（和第 9 章对上）',
          '<p>JNI 有两种注册方式：<b>静态注册</b>和<b>动态注册</b>。静态注册靠命名约定：' +
          'Java 侧 <code>com.example.app.Sign.getSign()</code> 对应 native 侧的' +
          '<code>Java_com_example_app_Sign_getSign</code>——把点换成下划线，再加上 <code>Java_</code> 前缀。' +
          '为了让虚拟机按名字找到它，这个符号<b>必须是导出的</b>（在 <code>.dynsym</code> 里、可见性 <code>DEFAULT</code>）。</p>' +
          '<p style="margin-bottom:0">所以：<b>只要你在 <code>.dynsym</code> 里看到 <code>Java_</code> 开头的 GLOBAL FUNC，' +
          '就等于拿到了一张「Java 方法 → native 实现」的对照表</b>，连参数都不用猜。<br>' +
          '而动态注册（<code>JNI_OnLoad</code> + <code>RegisterNatives</code>）会把这张表藏起来：' +
          '<code>.dynsym</code> 里只留下一个 <code>JNI_OnLoad</code>，方法名到函数地址的映射变成运行时才建立的一张表，' +
          '静态根本看不到。<span class="hit">「导出符号表就是不完整的索引」这件事本身，就是判断注册方式的第一手证据（第 9 章）。</span></p>') +
        T.note('warn', '⚠️ 加固在这一层的常见手法是「抹名字」，不是「抹内容」',
          '<p style="margin-bottom:0">' +
          '① <b>隐藏可见性</b>：把导出符号的 <code>st_other</code> 从 <code>DEFAULT</code> 改成 <code>HIDDEN</code>，' +
          '或者干脆把 <code>.dynsym</code> 里的名字项清空——<b>代码一个字节没动</b>，只是别人按名字找不到它了。<br>' +
          '② <b>改名字</b>：把 <code>Java_</code> 前缀的函数改名，或者交给动态注册。<br>' +
          '③ <b>整体 strip</b>：删掉 <code>.symtab</code>。这只影响本地符号名，对运行时毫无影响，' +
          '所以它<b>更像「减少信息量」而不是「加固」</b>。<br>' +
          '这三种手法的共同点是：<b><code>.text</code> 的规模不变，变的是符号密度。</b>' +
          '所以判断依据永远是「符号密度 vs 代码规模」这一对，而不是「符号表是不是空的」。</p>'),
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            scenario: '你要分析一个自己写的 so 里的算法，但不想让别人轻易找到那几个关键函数。' +
                      '你手上只有 <code>strip</code> 和 <code>objcopy</code> 这类常规工具，' +
                      '运行环境是正常的 Android（不做任何自定义 linker 或加固框架）。',
            q: '你决定先把符号处理一遍。下面哪个做法最接近「有效且不破坏运行」？',
            choices: [
              { t: '对整个 so 执行 <code>strip --strip-all</code>，把能删的符号全删掉。', next: 'n1' },
              { t: '只删 <code>.symtab</code> / <code>.strtab</code>，保留 <code>.dynsym</code> / <code>.dynstr</code>。', next: 'n2' },
              { t: '把 <code>.dynsym</code> 也一起清空，让任何人都拿不到名字。', next: 'n3' },
              { t: '先想清楚「防的是谁」：如果目的是不让别人按名字定位，真正有效的动作是把关键函数改成 <code>static</code> / 隐藏可见性，或者改成动态注册。', next: 'n4' }
            ]
          },
          n1: {
            scenario: '你执行了 <code>strip --strip-all libx.so</code>，然后用 IDA 打开，发现本地函数名确实没了，' +
                      '全变成了 <code>sub_xxxx</code>。但你在 <code>.dynsym</code> 里依然一眼看到了那几个关键函数名。',
            q: '这说明 <code>strip --strip-all</code> 做了什么、没做什么？',
            choices: [
              { t: '它删掉了 <code>.symtab</code> 等非加载节，但<b>不能</b>删 <code>.dynsym</code>——因为运行时 linker 需要它。', next: 'n5' },
              { t: '它失败了，需要加 <code>--strip-unneeded</code> 才能删干净。', next: 'n6' },
              { t: '它删掉了 <code>.dynsym</code> 的内容但被某种保护机制挡住了。', next: 'n6' }
            ]
          },
          n2: {
            scenario: '你只删了 <code>.symtab</code> / <code>.strtab</code>，程序运行正常。' +
                      '但你也注意到：<code>.dynsym</code> 里仍然有那几个导出函数的名字，任何人 <code>readelf --dyn-syms</code> 一下就看到了。',
            q: '这个结果符合你的目标吗？下一步更有价值的是什么？',
            choices: [
              { t: '不符合。真正决定「别人能不能按名字找到」的是 <code>.dynsym</code> 里的导出项和可见性，' +
                   '所以应该去处理函数的可见性 / 注册方式，而不是只删本地符号。', next: 'n4' },
              { t: '符合。IDA 里名字都没了，目的就达到了。', next: 'n7' }
            ]
          },
          n3: {
            terminal: true, verdict: 'bad', verdictTitle: '删错了东西：把运行时依赖当成了可选信息',
            result: '<p>清空 <code>.dynsym</code> 会让这个 so <b>直接加载不起来</b>：' +
                    'linker 要靠它解析导入符号（<code>memcpy</code>、<code>__android_log_print</code>…），' +
                    '也要靠它让别的模块按名字找到本模块的导出函数。' +
                    '清空的直接后果是符号解析失败——通常表现为加载时或首次调用时崩溃，而且报错信息往往很含糊。</p>' +
                    '<p><b>认知根源：</b>你把「名字」当成了纯粹的附加信息。' +
                    '但在这份表里，名字是<b>协议的一部分</b>：linker 就是按名字匹配的。' +
                    '<span class="hit">删掉它，等于把双方约定的命名规则单方面作废。</span></p>' +
                    '<p>如果确实要让别人拿不到名字，正确方向不是「删表」，而是' +
                    '<b>「让这个名字不再必要」</b>：把函数改成内部可见（<code>static</code> / <code>HIDDEN</code>），' +
                    '或者走动态注册让映射变成运行时才建立。</p>'
          },
          n4: {
            terminal: true, verdict: 'good', verdictTitle: '先定目标，再选手段',
            result: '<p><b>这条路对在两点上。</b></p>' +
                    '<p>① <b>先问「防谁」。</b>你想防的是「别人按名字定位关键函数」，' +
                    '那么有效手段就是<b>让名字不再出现在 <code>.dynsym</code> 里</b>：' +
                    '把关键函数改成文件内可见（<code>static</code> 或 <code>-fvisibility=hidden</code>），' +
                    'JNI 入口改成 <code>JNI_OnLoad</code> + <code>RegisterNatives</code> 动态注册。' +
                    '这比「删表」精细得多，也不破坏运行时。</p>' +
                    '<p>② <b>知道每种手段的实际效果边界。</b><code>strip</code> 只能减少<b>本地</b>符号，' +
                    '让 IDA 里少一些 <code>sub_xxxx</code> 对应的真名；' +
                    '它<b>完全没有办法</b>去掉导出符号——那是运行时的硬需求。' +
                    '<span class="hit">所以「strip 一下就安全了」这个想法，在导出符号这一层是不成立的。</span></p>' +
                    '<p>把这条结论推广一下：<b>任何「让分析变难」的动作，都要先问「它动的是可选的元数据，还是运行时必需的协议」。</b>' +
                    '动前者是提高成本，动后者是直接把功能弄坏。这个判断在第 8 章讲加固方案时同样适用。</p>'
          },
          n5: {
            terminal: true, verdict: 'good', verdictTitle: '分清了「本地符号」和「动态符号」',
            result: '<p>你的观察和结论都准确：<code>strip</code> 删的是<b>不进内存的那部分节</b>' +
                    '（<code>.symtab</code>、<code>.strtab</code>、调试节等），' +
                    '而 <code>.dynsym</code> / <code>.dynstr</code> 带着 <code>SHF_ALLOC</code>，' +
                    '是运行时结构，任何常规 strip 都不会碰它。</p>' +
                    '<p>这也解释了一个很常见的现象：<b>一个 so 被 strip 之后，IDA 里满屏 <code>sub_xxxx</code>，' +
                    '但 <code>readelf --dyn-syms</code> 还是能看到 <code>Java_*</code>。</b>' +
                    '很多人因此以为「strip 没用」，其实 strip 用在了它该用的地方——' +
                    '它去掉的是<b>内部结构信息</b>，减少了你理解代码的线索。</p>' +
                    '<p>下一步顺着这条线走下去：<b>导出符号的密度</b>是判断注册方式的最好证据。' +
                    '导出里全是 <code>Java_*</code> → 静态注册；只有一个 <code>JNI_OnLoad</code> → 大概率的动态注册。' +
                    '<span class="hit">这是第 9 章的核心判断，而它的全部依据就是本节这张 24 字节的表。</span></p>'
          },
          n6: {
            terminal: true, verdict: 'bad', verdictTitle: '把工具选项当成了原因',
            result: '<p>问题不在 strip 的参数上。<code>--strip-all</code> 已经是能删得最彻底的档位，' +
                    '它依然不会动 <code>.dynsym</code>——因为那不是「能不能删」的问题，' +
                    '而是<b>删了程序就加载不起来</b>。</p>' +
                    '<p><b>认知根源：</b>你在工具层面找答案，而问题的答案在<b>数据依赖</b>层面。' +
                    '遇到「为什么这个没被删掉」这类问题时，先问一句：' +
                    '<span class="hit">这东西是不是运行时被谁引用着？</span>' +
                    '<code>.dynsym</code> 被 <code>.dynamic</code> 里的 <code>DT_SYMTAB</code> 引用，' +
                    '是在加载路径上的关键数据。</p>'
          },
          n7: {
            terminal: true, verdict: 'bad', verdictTitle: '用「工具里的观感」替代了「实际的可定位性」',
            result: '<p>IDA 里名字少了，不代表别人定位不到关键函数。' +
                    '只要 <code>.dynsym</code> 里还有 <code>Java_com_example_app_Sign_getSign</code> 这样一行，' +
                    '任何人都能在三秒内跳过去；即使没有名字，靠字符串引用、' +
                    '<code>JNI_OnLoad</code> 的调用关系、<code>.init_array</code> 的入口，也一样能找到。</p>' +
                    '<p><b>认知根源：</b>你把「我这一个工具里的观感」当成了「攻击者的实际成本」。</p>' +
                    '<p>评估这类改动时，有效的问法是：<b>去掉这条线索之后，还有几条别的路能到同一个地方？</b>' +
                    '只有当所有路径的成本都被抬高，改动才算有效。' +
                    '<span class="hit">单点删名字几乎从来不改变实际成本，这也是为什么真正的加固都做在更深的层次上。</span></p>'
          }
        }
      }
    },

    /* ============================================================ 3.13 */
    {
      h: '3.13', title: '重定位：GOT 和 PLT 是怎么被填上的',
      html:
        '<p>前面所有内容到这里收口：<b>符号表告诉你「这个名字存在」，重定位表告诉你「这个地址要写到哪里去」。</b>' +
        '一个 so 被加载进内存的最后一公里，就是重定位。</p>' +
        '<p>先看重定位项的 24 字节结构：</p>' +
        T.code(
          'Elf64_Rela（24 字节）:\n' +
          'uint64  r_offset   <span class="c">// 要写的位置。ET_DYN 里这是「相对基址的虚拟地址」</span>\n' +
          'uint64  r_info     <span class="c">// 高位 = 符号下标，低位 = 重定位类型</span>\n' +
          'int64   r_addend   <span class="c">// 加数（.rela 有它；.rel 没有，加数在目标位置里）</span>\n\n' +
          '<span class="c">// r_info 的拆法（ELF64）：</span>\n' +
          'symbol_index = r_info &gt;&gt; 32\n' +
          'reloc_type   = r_info &amp; 0xffffffff'
        ) +
        T.note('key', '🔑 r_offset 是虚拟地址，不是文件偏移',
          '<p style="margin-bottom:0">这一点必须单独强调，因为写「从文件里应用重定位」的工具时它是个硬坑：' +
          '<b>在 <code>ET_DYN</code>（so）里，<code>r_offset</code> 是相对加载基址的虚拟地址。</b><br>' +
          '要把它换算成文件偏移，得先找到包含这个地址的 <code>PT_LOAD</code>：' +
          '<code>文件偏移 = r_offset − p_vaddr + p_offset</code>。<br>' +
          '而在 <code>ET_REL</code>（.o 目标文件）里，<code>r_offset</code> 是<b>相对于所在节的偏移</b>——又不一样。' +
          '<span class="hit">同一个字段，在两种文件类型里是两种语义。不区分这两者，是 so 修复工具最常见的第一处 bug。</span></p>') +
        T.tbl(
          ['重定位类型', '值', '出现在哪张表', '含义'],
          [
            ['<code>R_AARCH64_ABS64</code>', '<code>0x101</code>', '<code>.rela.dyn</code>', '写入一个 64 位绝对地址（符号地址 + 加数）'],
            ['<code>R_AARCH64_GLOB_DAT</code>', '<code>0x401</code>', '<code>.rela.dyn</code>',
             '<b>往 GOT 里填一个数据符号的地址</b>（全局变量、函数指针变量）'],
            ['<code>R_AARCH64_JUMP_SLOT</code>', '<code>0x402</code>', '<code>.rela.plt</code>',
             '<b>往 GOT 里填一个函数的地址</b>——这就是 PLT 机制的核心'],
            ['<code>R_AARCH64_RELATIVE</code>', '<code>0x403</code>', '<code>.rela.dyn</code>',
             '<b>不需要查符号</b>：写入「加载基址 + 加数」。so 修复工具最关键的一条'],
            ['<code>R_AARCH64_IRELATIVE</code>', '<code>0x408</code>', '<code>.rela.dyn</code>',
             '调用一个解析函数，用它的返回值填入（ifunc 机制）'],
            ['<code>R_AARCH64_COPY</code>', '<code>0x400</code>', '<code>.rela.dyn</code>', '把符号内容从别的模块复制过来（多见于可执行文件）'],
            ['<code>R_AARCH64_ADR_PREL_PG_HI21</code>', '<code>0x113</code>', '（目标文件里的代码重定位）', 'ADRP 指令的页偏移编码'],
            ['<code>R_AARCH64_ADD_ABS_LO12_NC</code>', '<code>0x115</code>', '同上', 'ADD 指令的页内偏移编码'],
            ['<code>R_AARCH64_ADR_GOT_PAGE</code>', '<code>0x137</code>', '同上', 'ADRP 取 GOT 页'],
            ['<code>R_AARCH64_LD64_GOT_LO12_NC</code>', '<code>0x138</code>', '同上', 'LDR 从 GOT 页内取 8 字节']
          ]
        ) +
        T.note('warn', '⚠️ 关于这张表的数值，有一条纪律要交代清楚',
          '<p style="margin-bottom:0">上面这些数值取自 LLVM 的 <code>llvm/BinaryFormat/ELFRelocs/AArch64.def</code>' +
          '（该文件标注其依据是 ARM 发布的 ABI 文档）。' +
          '<b>重定位常量绝对不能凭印象写</b>——本章 3.14 的案例里，一位作者就是因为把' +
          '<code>R_AARCH64_*</code> 的一段常量整体写错位了一位，导致 ADRP 指令被当成 MOVW 去改，' +
          '最终表现为「打印字符串变成乱码」这种完全不指向根因的现象。' +
          '<span class="hit">碰到这类数值，去查 ARM ABI、binutils 的 <code>include/elf/aarch64.h</code> ' +
          '或 LLVM 的 <code>AArch64.def</code>，不要背。</span></p>') +
        '<p>有了这些，就能把「一个 so 是怎么被接上外部世界的」画出来了。下面这个动画逐步走完一次调用：</p>',
      stage: {
        title: 'GOT / PLT：第一次调用的全过程',
        speed: 1900,
        render:
          '<div class="flow-col" style="gap:9px">' +
            '<div class="flow-row"><span class="blk" id="g1">.text 里的调用点：<span class="mono">bl printf@plt</span></span></div>' +
            '<div class="flow-row" style="margin-left:20px"><span class="arrow">↓</span></div>' +
            '<div class="flow-row"><span class="blk" id="g2">.plt 桩：<span class="mono">adrp x16 / ldr x17 / br x17</span></span>' +
              '<span class="arrow">→</span><span class="blk" id="g3">.got.plt 里的槽</span></div>' +
            '<div class="flow-row" style="margin-left:20px"><span class="arrow">↓ 首次调用时这个槽指向解析器</span></div>' +
            '<div class="flow-row"><span class="blk" id="g4">linker 的解析器</span>' +
              '<span class="arrow">查</span><span class="blk" id="g5">.dynsym / .dynstr</span>' +
              '<span class="arrow">+</span><span class="blk" id="g6">.rela.plt</span></div>' +
            '<div class="flow-row" style="margin-left:20px"><span class="arrow">↓ 找到真实地址后回填</span></div>' +
            '<div class="flow-row"><span class="blk" id="g7">回写 .got.plt 槽 = printf 的真实地址</span></div>' +
            '<div class="flow-row" style="margin-top:6px;padding-top:10px;border-top:1px dashed var(--line)">' +
              '<span class="pill" id="mark">点「播放」开始</span></div>' +
          '</div>',
        reset: () => {
          ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'].forEach(i => S(i, ''));
          CLS('mark', 'pill');
          SET('mark', '点「播放」开始');
        },
        steps: [
          { run: () => S('g1', 'active'),
            note: '<b>起点是代码里的一次调用。</b>编译器不会把 <code>printf</code> 的真实地址编进指令里——' +
                  '因为 so 可以被加载到任意基址，而且 <code>printf</code> 到底在哪要等运行时才知道。' +
                  '<span class="hit">所以编译器只留下一个「跳到一个桩」的指令。</span>' },
          { run: () => { S('g1', 'done'); S('g2', 'active'); },
            note: '<b>PLT 桩登场。</b>典型的三条指令：<code>adrp</code> 算出 GOT 所在页、' +
                  '<code>ldr</code> 从 GOT 里取出目标地址、<code>br</code> 跳过去。' +
                  '所以「跳到 PLT 桩」实际上等价于「跳到 GOT 里存的那个地址」。' },
          { run: () => { S('g2', 'done'); S('g3', 'active'); },
            note: '<b>GOT 是可写的。</b>这一条决定了后面所有的事情：' +
                  'linker 可以在运行时把地址写进去，攻击者（或你的 hook 脚本）也能改。' +
                  '<span class="hit">第 21 章「改写 GOT 做 import hook」的全部结构基础，就是这一句话。</span>' },
          { run: () => { S('g3', 'hot'); S('g4', 'active'); },
            note: '<b>首次调用时，GOT 槽里还不是 <code>printf</code> 的地址</b>，' +
                  '而是指回 PLT 的一段「解析器桩」，由它跳到动态链接器的解析函数。' +
                  '这就是<b>延迟绑定（lazy binding）</b>：不用一开始就把所有外部函数都解析一遍。' },
          { run: () => { S('g4', 'done'); S('g5', 'active'); S('g6', 'active'); },
            note: '<b>linker 要知道「printf 是谁」。</b>它需要三样东西：' +
                  '① <code>.rela.plt</code> 里那条 <code>R_AARCH64_JUMP_SLOT</code> 记录，' +
                  '告诉它「哪个符号、往哪个地址写」；② <code>.dynsym</code> 里那个符号项；' +
                  '③ <code>.dynstr</code> 里那个符号的名字字符串。<br>' +
                  '<span class="hit">所以 <code>.dynsym</code> 和 <code>.dynstr</code> 是加载路径上的关键数据，删不得。</span>' },
          { run: () => { S('g5', 'done'); S('g6', 'done'); S('g7', 'active'); },
            note: '<b>找到地址之后回填。</b>linker 把 <code>printf</code> 的真实地址写进 GOT 槽。' +
                  '从此这个槽就「热」了——<b>再次调用时，PLT 桩里那条 <code>ldr</code> 直接取到真地址，不再经过解析器。</b>' +
                  '这就是为什么 hook GOT 必须考虑「第一次调用之前还是之后」这个时机问题。' },
          { run: () => { S('g7', 'cool'); CLS('mark', 'pill ok'); SET('mark', '✅ 一次调用之后，GOT 槽 = 真实地址，直到有人改它'); },
            note: '<b>把整条链收成一句话：</b>代码 → PLT 桩 → GOT 槽 →（首次）解析器 → linker 查 .dynsym/.dynstr/.rela.plt → 回填 GOT。<br>' +
                  '<b>两个实用推论：</b><br>' +
                  '① 如果你能改 GOT 槽，就能把 <code>printf</code> 换成自己的函数——这是最经典的 import hook。<br>' +
                  '② 如果 so 开了完整 RELRO（<code>PT_GNU_RELRO</code> + <code>-z now</code>），' +
                  '重定位做完后 GOT 会被改成<b>只读</b>，改它之前必须先 <code>mprotect</code>。' +
                  '<span class="hit">「为什么 hook GOT 有时要 mprotect、有时不用」的答案就在 RELRO 这一条上。</span>' }
        ]
      },
      quiz: {
        id: 'q28-4', chapter: 28, answer: 2,
        stem: '你在解析一个 so 的 <code>.rela.dyn</code>，看到一条记录：' +
              '<code>r_offset = 0x3E40</code>、<code>r_info</code> 的低 32 位 = <code>0x403</code>、<code>r_addend = 0x1A20</code>。' +
              '这个 so 被加载到基址 <code>0x7F00000000</code>。下面哪个描述是对的？',
        options: [
          { t: '它要把符号 <code>#0</code> 的地址写进文件偏移 <code>0x3E40</code> 处。',
            why: '两处错：<code>0x403</code> 是 <code>R_AARCH64_RELATIVE</code>，<b>不需要查符号</b>（符号下标通常是 0，但没有意义）；' +
                 '而且 <code>r_offset</code> 在 ET_DYN 里是<b>虚拟地址</b>，不是文件偏移。' },
          { t: '它要把 <code>0x1A20</code> 这个值写进内存地址 <code>0x3E40</code> 处。',
            why: '<code>R_AARCH64_RELATIVE</code> 写的不是加数本身，而是<b>基址 + 加数</b>。少了加载基址，重定位结果会偏掉一整个模块的距离。' },
          { t: '它要把 <code>0x7F00000000 + 0x1A20</code> 写进虚拟地址 <code>0x3E40</code> 处（加载后即 <code>0x7F00000000 + 0x3E40</code>）。',
            why: '<b>正确。</b><code>RELATIVE</code> 的语义就是「基址 + 加数」；<code>r_offset</code> 也是相对基址的虚拟地址，' +
                 '所以运行时真正被写的地址是「基址 + 0x3E40」。' },
          { t: '它是 <code>R_AARCH64_JUMP_SLOT</code>，应该出现在 <code>.rela.plt</code> 里。',
            why: '<code>0x402</code> 才是 <code>JUMP_SLOT</code>，<code>0x403</code> 是 <code>RELATIVE</code>。' +
                 '差 1 就换了语义——这正是「重定位常量必须查规范」的原因。' }
        ],
        explain:
          '<p>一条 <code>Elf64_Rela</code> 只有三个字段，但每个都有坑：</p>' +
          '<ul>' +
          '<li><b><code>r_info</code></b>：高 32 位是符号下标，低 32 位是类型。这里低 32 位是 <code>0x403</code>，' +
          '正是 <code>R_AARCH64_RELATIVE</code>。</li>' +
          '<li><b><code>r_offset</code></b>：在 <code>ET_DYN</code>（so）里是<b>相对加载基址的虚拟地址</b>。' +
          '所以最终被写的内存地址是 <code>base + 0x3E40</code>。要换算文件偏移还得经过 <code>PT_LOAD</code> 映射。</li>' +
          '<li><b><code>r_addend</code></b>：<code>RELATIVE</code> 的语义是「写 <code>base + addend</code>」。' +
          '所以写进去的值是 <code>0x7F00000000 + 0x1A20</code>。</li>' +
          '</ul>' +
          '<p><b>为什么 <code>RELATIVE</code> 是 so 修复工具最关心的类型？</b>' +
          '因为它<b>不依赖任何外部符号</b>：只要知道加载基址，就能算出应该填什么。' +
          '从内存里 dump 出来的 so，绝大多数需要修的就是这一类重定位——' +
          '工具（比如 SoFixer 一类）会从镜像里反推出基址，然后重算这些项，写回成「相对基址的偏移」，' +
          '让文件重新变得可链接。</p>' +
          '<p>顺带记住那两个会出现在 <code>.rela.dyn</code> 里的类型：' +
          '<code>GLOB_DAT(0x401)</code> 是给<b>数据</b>符号填 GOT，<code>JUMP_SLOT(0x402)</code> 是给<b>函数</b>填 GOT' +
          '（并且它通常住在 <code>.rela.plt</code> 里）。' +
          '两个值只差 1，含义完全不同——这也是「重定位常量必须查表」这条纪律的来源。</p>'
      }
    },

    /* ============================================================ 3.14 */
    {
      h: '3.14', title: '实战案例：自己写 Loader，才知道 ELF 每个字段都有人管',
      case: {
        source: 'kanxue',
        title: '[原创]把 .o 变成 .ko（三）：自己写 Loader 才知道的事',
        date: '2026-5-4',
        author: '孤木落',
        target: '自研内核模块加载器 KPM Loader（Android GKI / ARM64；系列第三篇，前两篇讲 ELF 格式转换与 GKI 安全特性）',
        background:
          '<p>本章一直在讲「字段是什么」，但很少有人真的被字段咬过一口。这篇帖子是一份<b>被咬过 15 次的现场记录</b>。</p>' +
          '<p>作者的目标很明确：不要让目标设备依赖内核原生的模块加载器。' +
          '前两篇已经解决了「怎么把一个用户空间编译产物在格式上伪装成内核认识的 <code>.ko</code>」，' +
          '但那些转换、section 修补、符号处理和重定位修复<b>全都必须在开发机上离线完成</b>。' +
          '于是作者写了 KPM Loader——一个跑在<b>内核空间</b>的迷你模块加载器，' +
          '通过 <code>/proc</code> 接收一种自定义格式的二进制，在设备上完成：' +
          '<b>ELF 解析 → section 布局 → 符号解析 → 重定位 → 内存权限切换 → 指令缓存刷新 → 入口调用</b>。</p>' +
          '<p>换句话说：<b>内核原生加载器走过的每一步，他都得自己走一遍。</b>' +
          '帖子把原始记录的第 21 到第 39 个坑，复盘合并成第 21 到第 34 个核心坑，' +
          '最后在总结里收敛为第 21 到第 35 个。下面挑和本章直接相关的几条。<span class="pill warn">核心事实均有原文依据</span></p>',
        points: [
          '<b>坑 26 · 重定位常量错位</b>：作者自写的 <code>R_AARCH64_*</code> 常量表从 <code>MOVW_PREL_G0</code> 起整体偏移了一位，' +
          '导致真实的 <code>ADR_PREL_PG_HI21</code>（<code>type = 275 = 0x113</code>）被匹配进 MOVW 分支，' +
          '用 MOVW 的编码逻辑去改 ADRP 指令，结果 ADRP 从 <code>0xB0000000</code> 被写成 <code>0x9001FF00</code>，' +
          '指向约 8MB 外的随机页；<b>表面症状只是「打印出来的字符串是乱码」</b>。',
          '<b>坑 27 · 非 SHF_ALLOC 段的 sh_addr 是 0</b>：<code>ET_REL</code> 文件里 section header 的 <code>sh_addr</code> 通常是 0，' +
          '因为它还没被最终链接。但重定位引擎需要访问 <code>.symtab</code> / <code>.strtab</code> / <code>.rela.text</code> / <code>.rela.data</code> 这些' +
          '<b>非 <code>SHF_ALLOC</code></b> 段——作者的原话是「重定位处理不仅需要访问 SHF_ALLOC 段，也需要访问非 SHF_ALLOC 的符号表、字符串表和 relocation 表」。' +
          '他手动给这些段补上 <code>sh_addr = hdr + sh_offset</code>。',
          '<b>坑 28 · 字符串指针的换算基准</b>：把 section 内部指针从「文件地址」换算成「运行时地址」时，' +
          '作者一开始以整个 ELF 文件头为基准做减法，结果把 <code>section_offset</code> 也算进去了，指针偏移过头；' +
          '现象是 <code>loading module \'\' version \'\'</code>——名字和版本都是空串。' +
          '正确基准是「该 section 在文件里的起始地址」。',
          '<b>坑 23 / 24 · 权限与写入时序</b>：ARM64 GKI 上 <code>module_alloc()</code> 返回的通常是 RW/NX（PXN 生效），' +
          '不能直接执行；而部分硬件支持 WXN（写与执行互斥），所以<b>所有 patch 必须在 RW 阶段完成</b>，' +
          '切换成 RX 之后不能再写 <code>.text</code>。',
          '<b>坑 25 · 符号可见性</b>：Android GKI 严格限制导出符号，<code>module_alloc</code>、<code>set_memory_x</code>、' +
          '<code>__flush_icache_range</code> 等「在 <code>/proc/kallsyms</code> 里看得到、但普通模块不能直接引用」的符号，' +
          '只能通过传入的 <code>kallsyms_lookup_name</code> 地址在初始化阶段统一解析并缓存。',
          '<b>坑 34 · GOT 双重解引用与地址层级</b>：复杂 KPM 用 <code>-fPIC -mcmodel=large</code> 编译会产生 GOT 重定位' +
          '（<code>unsupported RELA type 312</code> 就是 <code>R_AARCH64_LD64_GOT_LO12_NC</code>）；' +
          '更麻烦的是，外部符号的访问可能是<b>双重解引用</b>——GOT 槽里放的不是函数地址，而是「函数指针变量的地址」。' +
          '作者的核心结论：<b>外部符号解析不能只问「这个符号的地址是多少」，还要问「KPM 的编译器认为这个符号是什么」</b>' +
          '（函数？函数指针变量？数据对象？需要 GOT 包装的引用？），因为声明类型不同，编译器生成的访问模式完全不同。',
          '<b>坑 35 · local_syms 表错位</b>：符号表声明和初始化代码是两份平行维护的列表，' +
          '从某个索引开始整体错位，导致「想解析 printk，实际拿到 sp_el0_is_current」。' +
          '作者的结论是要做「单一事实来源」（X-Macro 或集中式表定义）。'
        ],
        method: [
          '先在 x86 环境把「离线转换」这条路打通（系列第一篇，坑 1–13）：section 白名单与黑名单、<code>.modinfo</code> 构造、' +
          '符号表修复、relocation 映射 —— 解决「格式上像不像 <code>.ko</code>」。',
          '再逐条对齐 Android GKI 的硬件与内核安全特性（系列第二篇，坑 14–20）：SELinux、vermagic、BTI、PAC、SCS、' +
          'CFI_ICALL 与 kCFI 的差异、以及厂商驱动对非标准 <code>.text.*</code> section 布局的敏感 —— 解决「能不能真的加载」。',
          '把加载动作搬进内核（本篇）：用 <code>/proc</code> 接收自定义二进制，在内核空间完成 ELF 解析、section 搬迁、符号解析、重定位与权限切换。',
          '按「现象 → 根因 → 解决 → 教训」四段式记录每一个坑。' +
          '这篇帖子最有价值的地方就在这里：<b>它记录的是症状和根因之间的距离有多远</b>——' +
          '比如「字符串乱码」的根因是重定位常量错位一位，「模块名是空串」的根因是减法基准用错了。',
          '重定位引擎按规范逐条修正常量，并且明确写下纪律：<b>ELF relocation type 常量不能凭记忆手写</b>，' +
          '必须和 ARM ELF ABI、binutils 的 <code>include/elf/aarch64.h</code>、LLVM 的 AArch64 relocation 定义交叉验证。',
          '把所有「必须分阶段完成」的动作排成严格顺序：RW 阶段 → 复制 section、解析符号、生成 PLT/GOT、应用重定位、写 thunk；' +
          'RX 阶段 → 切换权限、刷新 icache；最后才调用入口。'
        ],
        result:
          '<p>KPM 加载流程最终跑通：section 搬迁和 relocation 都正确。' +
          '但这篇帖子真正的结论不在「跑通了」，而在它的结语：</p>' +
          '<p><b>「当你试图绕开成熟的内核构建与加载体系时，原本被工具链、内核 loader、链接器和架构代码替你处理掉的细节，' +
          '会一个不漏地回到你面前。」</b>作者列出的「真正困难的部分」是：架构安全特性、内核符号可见性、' +
          '<b>relocation 语义</b>、内存权限模型、CFI / BTI / PAC 边界、厂商驱动假设、编译器生成代码模式、' +
          '以及 loader 自身数据结构的一致性。而 <b>「ELF 格式只是第一层」</b>——这是他的原话。</p>' +
          '<p>他还补了一句关于调试体验的话：内核开发的残酷在于很少给清晰错误提示，' +
          '「一个 relocation 常量写错、一个地址多解引用一次、一个函数入口少了 <code>bti c</code>」，' +
          '最终表现都只是静默重启、Instruction Abort、Translation Fault、Kernel panic。</p>',
        terms: ['ELF', 'section header', 'SHF_ALLOC', 'sh_addr', 'ET_REL', 'relocation', 'R_AARCH64_ADR_PREL_PG_HI21',
                'R_AARCH64_LD64_GOT_LO12_NC', 'GOT 双重解引用', '符号表', 'PT_LOAD 权限', 'RW/RX 分阶段',
                'PT_GNU_RELRO', 'module_alloc', 'PXN / WXN', 'BTI', 'CFI', 'kallsyms'],
        limits:
          '<p>作者对自己局限的交代很直接，逐条照录：</p>' +
          '<p>① 这是系列第三篇，<b>只覆盖自研 Loader 这一段</b>；前面的格式转换与 GKI 适配在另外两篇里，' +
          '单看这篇无法复现完整链路。</p>' +
          '<p>② 坑的编号经过合并（原始记录第 21–39 → 整理后第 21–34 → 总结时收敛为 21–35），' +
          '说明这份清单是<b>复盘后的归纳</b>，不是原始调试流水。</p>' +
          '<p>③ 全文没有给出完整的 KPM Loader 源码，代码片段都是<b>示意性</b>的（结构、调用顺序示意），' +
          '不能直接编译。</p>' +
          '<p>④ 验证环境是 ARM64 Android GKI 设备；x86 上开发时「这类问题经常不会暴露」（作者原话），' +
          '所以文中的部分结论<b>只在 ARM64 GKI 上成立</b>。</p>' +
          '<p>⑤ 作者没有说这套方案在对抗环境下是否够用——帖子的定位是「内核开发、调试和研究」，' +
          '不是绕过某类检测。</p>',
        analysis:
          '<p><b>这篇案例是本章全部内容的「反面证明」：本章讲的每一个字段，都有人在真实的加载路径上被它咬过。</b>' +
          '把它和本章对齐着看，能看清楚三件事。</p>' +
          '<p><b>第一，偏移和数值这类「硬事实」，错一位就是灾难。</b>坑 26 里作者把 <code>R_AARCH64_*</code> 的一段常量整体写错了一位，' +
          '于是 <code>0x113</code>（<code>ADR_PREL_PG_HI21</code>）被当成 MOVW 家族的类型去处理，' +
          '用 MOVW 的编码逻辑去改 ADRP 指令——结果是一条 4 字节的 ADRP 被写成了指向 8MB 外的地址，' +
          '而<b>表现出来的症状只是「打印的字符串是乱码」</b>。' +
          '<span class="hit">这就是本章反复强调「重定位常量必须查规范」的原因：错误的症状和根因之间隔着好几层。</span></p>' +
          '<p>这里还有一处必须诚实指出的细节。<b>作者给出的「正确值」里，<code>R_AARCH64_MOVW_PREL_G0 = 0x111</code> 与当前权威定义不符。</b>' +
          '按 LLVM 的 <code>AArch64.def</code>（该文件注明依据是 ARM 发布的 ABI 文档）：<code>0x111</code> 是 ' +
          '<code>R_AARCH64_LD_PREL_LO19</code>，而 <code>R_AARCH64_MOVW_PREL_G0</code> 是 <code>0x11f</code>。' +
          '作者表里后半段（<code>0x113 ADR_PREL_PG_HI21</code>、<code>0x115 ADD_ABS_LO12_NC</code>、<code>0x117 TSTBR14</code>、' +
          '<code>0x118 CONDBR19</code>）与权威定义是<b>一致</b>的，差异集中在前两项。' +
          '合理的解释是：他这次真正被踩到的是 <code>ADR_PREL_PG_HI21</code> 那一段，' +
          '<code>MOVW_PREL_*</code> 这两个常量在他的样本里<b>从未被真正执行到</b>，所以没有再次暴露。' +
          '<span class="pill warn">待核实</span>（这是我的推断，作者原文没有说明；但结论是可验证的：这两处数值与 LLVM/ARM ABI 不一致）。<br>' +
          '而这恰恰把作者自己的教训<b>又加强了一层</b>：他说「常量不能凭记忆手写」，' +
          '结果他修正后的表里仍然留着两个没被验证过的值。' +
          '<span class="hit">本章的纪律就是这样来的：凡记不准的，宁可标注「待核实」，也不要写出一个看起来很像的数字。</span></p>' +
          '<p><b>第二，段和节的区别不是学术问题，而是「我的代码能不能访问到这块数据」。</b>坑 27 是本章 3.8 节那条结论的现场版：' +
          '<code>.symtab</code>、<code>.strtab</code>、<code>.rela.text</code> 这些节<b>没有 <code>SHF_ALLOC</code> 标志</b>，' +
          '所以它们不进内存、<code>sh_addr</code> 是 0。系统 loader 会替你补上这个地址（把文件缓冲区的位置填进去），' +
          '而自研 loader 不补，重定位阶段就会去访问空指针。' +
          '<span class="hit">「哪些节会进内存」这个问题，在写 loader 时直接决定你会不会崩。</span></p>' +
          '<p><b>第三，「符号的地址」是一个需要澄清的问题，而不是一个数字。</b>坑 34 里，作者的 KPM 对外部符号做了两次解引用，' +
          '而 loader 一开始只提供了「函数地址」这一种层级，于是两次 <code>ldr</code> 把函数开头的机器码当成了指针来读。' +
          '这和本章 3.12 节的结论是同一条：<code>st_value</code> 只是一个值，它的<b>含义</b>取决于符号的类型（FUNC / OBJECT）' +
          '和调用方编译器对它的<u>声明</u>。' +
          '作者把它总结成一句可以直接搬走的话：' +
          '<b>不要只问「这个符号的地址是多少」，还要问「使用方认为它是什么」。</b></p>' +
          '<p>最后一条方法论上的收获：这份帖子的形态值得学。' +
          '它没有写「我用 XX 技术搞定了 XX」，而是<b>逐坑记录「现象 → 根因 → 解决 → 教训」</b>，' +
          '并且明确区分了「代码里写了」和「设备上验证过」。' +
          '本章的实验之所以要求你真算一遍 uleb128、真数一遍 PT_LOAD，就是同一个道理：' +
          '<span class="hit">看懂了不等于算过了，算过了才可能在别人的字节上不翻车。</span></p>',
        link: 'https://bbs.kanxue.com/thread-291097.htm',
        linkNote: '看雪论坛原创帖 · 系列第三篇（正文约 25.9 KB，已用 Node fetch 校验 textarea 正文可读）'
      }
    },

    /* ============================================================ 3.15 */
    {
      h: '3.15', title: '收口：拿到一个 APK，先看哪几个字段',
      html:
        '<p>这一章讲了很多字段。但实战里你不可能每次都把所有字段看一遍——' +
        '你需要的是<b>一张按「信息量 / 成本」排序的体检表</b>：只花几十秒，就能把可能性收窄到一两条。</p>' +
        '<p>下面三张表是本章的收口。它们的顺序就是建议的查看顺序。</p>' +
        T.card('① APK 层：30 秒能给结论的三个观察',
          T.tbl(
            ['看什么', '在哪看', '能推出什么'],
            [
              ['<code>classes.dex</code>、<code>classes2.dex</code>… 的数量与各自大小',
               '中央目录里的文件名列表',
               '只有 1 个 dex 且只有几十 KB → 极可能不是业务代码，去看 <code>assets/</code> 里有没有大文件；' +
               '十几个 dex → 典型的大型 App 或壳的分片策略'],
              ['<code>lib/&lt;abi&gt;/</code> 下 so 的数量与名字',
               '中央目录里的路径',
               '只有 1 个 <code>libxxx.so</code> 却有好几 MB → 加密 / 协议 / 加固的核心很可能都在里面；' +
               '按 7 种 ABI 都放了一份 → 说明有 NDK 模块'],
              ['中央目录偏移 − 16 处是不是 <code>APK Sig Block 42</code>',
               '末尾字节（本章 3.4 实验）',
               '有 → v2/v3 签名，改完必须重签；没有 → 只有 v1，某些改动可能被容忍（但也说明这个包可能来路不正）']
            ]
          )) +
        T.card('② DEX 层：判断「脱没脱干净」的四个字段',
          T.tbl(
            ['字段', '位置', '判据'],
            [
              ['<code>magic</code>', '文件头 0x00（8 字节）', '版本号是否与目标系统匹配；不是 <code>dex\\n0xx\\0</code> 就根本不该按 dex 解析'],
              ['<code>class_defs_size</code>', '文件头 0x60', '正常 App 是<b>几百到几千</b>；个位数或 0 → 基本没脱到东西（第 16 章）'],
              ['<code>method_ids_size</code>', '文件头 0x58', '与 <code>class_defs_size</code> 的比例大致稳定；比例严重失调说明结构被动过'],
              ['<code>insns_size</code> 的分布', '每个 <code>code_item</code> 的 +0x0C',
               '<b>成片为 0</b> → 抽取壳（方法体还没回填）。这是「抽取壳」在格式层最直接的证据（本章 3.6）']
            ]
          )) +
        T.card('③ ELF 层：分三步，先排除平凡解释',
          T.tbl(
            ['步骤', '看什么', '结论方向'],
            [
              ['第一步：是不是 ELF', '<code>e_ident</code> 的魔数、<code>EI_CLASS</code>、<code>EI_DATA</code>',
               '魔数不对 → 不是 ELF，或已被整体加密；class/data 不对 → 后面全部读错'],
              ['第二步：结构自不自洽', '<code>e_type</code>、<code>e_machine</code>、<code>e_phoff/e_phnum</code>、' +
               '每个 <code>PT_LOAD</code> 的偏移/大小/对齐',
               '自洽 → 排除「文件损坏 / dump 不完整」；<code>p_memsz &gt; p_filesz</code> 是正常的 .bss，别当异常'],
              ['第三步：内容被处理过没有', '节表在不在；<code>.dynsym</code> 的条目数 vs <code>.text</code> 的规模',
               '节表没了但代码成规模 → 抹节表；符号近乎为空但代码成规模 → 抹名字；' +
               '两者都没有 → 大概率是原版']
            ]
          )) +
        T.note('key', '🔑 这一章真正想留下的「定位反射」',
          '<p style="margin-bottom:0">' +
          '• 看到<b>装不上</b> → 先想签名块（v2/v3 覆盖了哪些字节）。<br>' +
          '• 看到<b>方法体是空的</b> → 先想抽取壳，证据是 <code>code_item</code> 的 <code>insns_size</code>。<br>' +
          '• 看到<b>工具读不出结构</b> → 先分清是<b>段</b>的问题还是<b>节</b>的问题：段的完整性决定能不能运行，' +
          '节的完整性只决定好不好分析。<br>' +
          '• 看到<b>符号表是空的</b> → 先问是哪一张符号表：<code>.dynsym</code> 空了是大事，<code>.symtab</code> 空了是 strip。<br>' +
          '• 看到<b>一个字段的数值不确定</b> → 去查规范，不要凭印象写。案例里有人为此付出了「字符串乱码」到「重定位引擎」的距离。' +
          '</p>'),
      decision: {
        start: 'n0',
        nodes: {
          n0: {
            scenario: '面试/交接场景：同事把一个 APK 丢给你，说「这是我们竞品的新版本，你看看它是不是加了壳、用了什么 native 库」。' +
                      '你手边只有一台装了 jadx 的机器，以及本章教的那些字节级手段。<b>你只有几十秒。</b>',
            q: '第一步做什么？',
            choices: [
              { t: '先把 APK 装到手机上跑一遍，看行为。', next: 'n1' },
              { t: '先用最便宜的手段看结构：列 zip 条目（dex 数量与大小、<code>lib/</code> 下的 so 清单），' +
                   '再确认有没有 <code>APK Sig Block 42</code>。', next: 'n2' },
              { t: '直接用 jadx 打开，看有没有报错。', next: 'n3' },
              { t: '先解包出 <code>AndroidManifest.xml</code>，看 <code>application:name</code>。', next: 'n4' }
            ]
          },
          n1: {
            terminal: true, verdict: 'bad', verdictTitle: '把最贵的手段放在了第一位',
            result: '<p>装包运行成本最高（要设备、要签名一致、可能触发反调试），而且给出的信息最模糊——' +
                    '「跑起来了」说明不了任何结构问题。</p>' +
                    '<p><b>认知根源：</b>你把「信息量最大的手段」和「最该先用的手段」混为一谈了。' +
                    '在侦察阶段，正确的排序依据是<b>成本 / 信息量</b>：结构类观察几乎零成本，' +
                    '而且<b>能直接排除一整类可能性</b>——比如「只有一个几十 KB 的 dex」这一条，' +
                    '当场就把「业务逻辑在 Java 层」这个假设排除掉了，根本不需要运行。</p>' +
                    '<p><span class="hit">几十秒的场景里，先做减法，不做验证。</span></p>'
          },
          n2: {
            scenario: '你列了 zip 条目：<code>classes.dex</code> 只有 68 KB，<code>classes2.dex</code> 有 4.2 MB，' +
                      '<code>lib/arm64-v8a/libnative.so</code> 有 6.8 MB，<code>lib/armeabi-v7a/</code> 下同名文件 5.1 MB；' +
                      '<code>assets/</code> 下有一个 <code>data.bin</code> 3.9 MB。中央目录偏移 − 16 处是 <code>APK Sig Block 42</code>。' +
                      'jadx 能打开，能看到大量类名和方法名，但方法体大多是空的或只有一行。',
            q: '基于这些观察，最合理的判断是什么？',
            choices: [
              { t: '是抽取壳：dex 的类结构完整（所以类名都看得到）但方法体被抽走（所以只有 return）；' +
                   'native 侧有 6.8 MB 的 so，算法/校验大概率在里面；<code>assets/data.bin</code> 值得单独看。下一步去验证 <code>insns_size</code> 的分布。', next: 'n5' },
              { t: '是一代壳：dex 整体加密了，所以要去做内存 dump。', next: 'n6' },
              { t: '没加固：jadx 能打开就说明没加固，方法体空是因为 R8 做了裁剪。', next: 'n7' }
            ]
          },
          n3: {
            terminal: true, verdict: 'bad', verdictTitle: '把工具的输出当成了判据',
            result: '<p>jadx 能打开 / 打不开，只能说明「它能不能按自己的期望解析这份 dex」——' +
                    '这是一个<b>工具层的结论</b>，不是结构层的结论。</p>' +
                    '<p><b>这条路会在什么情况下失败：</b>遇到「jadx 打开了、类名全在、方法体全空」的抽取壳时，' +
                    '你会以为一切正常；而遇到「map_list 与实际偏移对不上」的 dump 产物时，你会以为是壳，其实是文件没修好。</p>' +
                    '<p><b>认知根源：</b>你跳过了「先看结构」这一步，直接用工具结果替代了观测。' +
                    '<span class="hit">工具会成功也会失败，但结构不会骗人——' +
                    'dex 数量、大小、<code>class_defs_size</code>、<code>insns_size</code> 这些数字，' +
                    '在任何工具里看都是一样的。</span></p>'
          },
          n4: {
            terminal: true, verdict: 'bad', verdictTitle: '抓了一个没有区分度的特征',
            result: '<p>看 <code>application:name</code> 确实是老手的习惯——<b>在已知是加固的情况下</b>，' +
                    '它常常能直接告诉你壳是哪一家（很多壳会把自己的 Application 写在这里）。' +
                    '但在「还不知道有没有加固」的阶段，这一条没有区分度：</p>' +
                    '<p>大量正常 App 也会自定义 Application（做初始化、埋点、多进程管理），' +
                    '你无法从「它自定义了 Application」推出「它加固了」。</p>' +
                    '<p><b>认知根源：</b>你抓的是一条「有信息但无判别力」的线索。' +
                    '判定类问题的第一步，永远要选<b>能把可能性劈成两半</b>的观测点：' +
                    '<span class="hit">「dex 有几个、多大」能劈开「业务在 Java 还是在 native」；' +
                    '「方法体有没有内容」能劈开「一代壳 / 抽取壳 / 没壳」。' +
                    '而 Application 名字只能告诉你是哪一家，不能告诉你有没有。</span></p>' +
                    '<p>顺带说清顺序：等你确认了是壳，再看 Application 名字就能省下大量时间——' +
                    '所以它是<b>第二阶段</b>的好线索，不是第一阶段的。</p>'
          },
          n5: {
            terminal: true, verdict: 'good', verdictTitle: '用结构做减法，用字段收敛结论',
            result: '<p><b>这条路径完整、可复用，而且每一步都指向一个具体字段：</b></p>' +
                    '<p>① <b>zip 条目</b> → 「<code>classes2.dex</code> 4.2 MB 而 <code>classes.dex</code> 只有 68 KB」' +
                    '说明业务代码被挪到了第二个 dex，第一个只是壳/入口——这是壳的典型签名。<br>' +
                    '② <b>签名块</b> → 有 v2/v3，意味着后续任何改动都要重签，别在这上面浪费时间。<br>' +
                    '③ <b>jadx 的现象</b>（类名全、方法体空）→ 直接指向<b>抽取壳</b>，' +
                    '而不是一代壳。一代壳的表现是「连类名都看不到」。<br>' +
                    '④ <b><code>lib/arm64-v8a/libnative.so</code> 6.8 MB</b> → 这个体积远超普通 JNI 桥接库，' +
                    '算法 / 协议 / 校验大概率在里面。而 <code>assets/data.bin</code> 3.9 MB 是另一个可疑点。<br>' +
                    '⑤ <b>下一步验证</b>：按本章 3.6，去看 <code>code_item</code> 的 <code>insns_size</code> 分布；' +
                    '如果成片为 0，抽取壳的判断就被字节级证据坐实了。</p>' +
                    '<p><span class="hit">注意这条路径的形状：先做减法（把「没加固」「一代壳」「业务在 Java 层」这些可能性排除掉），' +
                    '再用字段收敛到一条具体路线上。它不需要任何高级工具，也不需要运行 App。</span></p>'
          },
          n6: {
            terminal: true, verdict: 'bad', verdictTitle: '把现象归类错了，后面整条路线都会错',
            result: '<p>一代壳（整体加密壳）的定义是：<b>整个 dex 被加密，静态看不到任何结构</b>。' +
                    '而你的观察恰恰相反——jadx 能看到<b>大量类名和方法名</b>，说明结构是完整的。</p>' +
                    '<p>「结构完整 + 方法体为空」是<b>抽取壳</b>的签名。</p>' +
                    '<p><b>认知根源：</b>你把「反编译结果不完整」笼统地归成了「dex 被加密」。' +
                    '但这两件事在<b>结构层</b>上的表现完全不同：<br>' +
                    '• 一代壳：连 <code>class_defs</code> 都读不出来，类名一个都看不到；<br>' +
                    '• 抽取壳：类名、方法签名、字段全在，只有 <code>code_item</code> 里的 <code>insns</code> 是空的。</p>' +
                    '<p><span class="hit">分类的依据必须是「结构层观测」，而不是「我觉得它被保护了」。</span>' +
                    '这个误判的代价很大：一代壳要去做内存 dump，抽取壳要做主动调用触发回填（第 16 章）——' +
                    '路线完全不同，走错方向会浪费掉大量时间。</p>'
          },
          n7: {
            terminal: true, verdict: 'bad', verdictTitle: '用「一个可能的良性解释」否掉了整条线索',
            result: '<p>R8 的裁剪确实会产生「方法体变空」的情况，但它<b>不会让几千个方法同时变空</b>，' +
                    '而且 R8 裁掉的类不会留在 dex 里——你观察到的现象是<b>类还在、方法体没了</b>，' +
                    '这和裁剪的表现正好相反。</p>' +
                    '<p><b>认知根源：</b>你给一个强烈的异常现象找到了一个「听起来专业」的良性解释，然后就停下来了。' +
                    '这类错误很难自我发现，因为它让你<b>感觉</b>自己已经解释清楚了。</p>' +
                    '<p>有效的做法是给每个良性解释配一个<b>可验证的预期</b>：' +
                    '如果真是 R8 裁剪，那么被裁的方法应该<b>连方法项都不存在</b>（<code>method_ids</code> 里没有），' +
                    '而不是「方法项在、<code>insns_size</code> 为 0」。' +
                    '<span class="hit">这一验证只要去数一下 <code>code_item</code> 就够了——成本极低，' +
                    '但能把「裁剪」和「抽取」彻底分开。</span></p>'
          }
        }
      },
      quiz: {
        id: 'q28-5', chapter: 28, answer: 3,
        stem: '下面四个判断里，哪一个<b>不能</b>从文件字节直接得出（也就是说，它是一个「看起来有依据、其实推不出来」的结论）？',
        options: [
          { t: '这个 APK 带 v2/v3 签名——依据是中央目录偏移 − 16 处是 <code>APK Sig Block 42</code>。',
            why: '这是可以得出的：一个魔数检查加一次减法，结论与证据之间存在硬对应关系。' },
          { t: '这个 so 的节表被抹掉了——依据是 <code>e_shnum</code> 为 0，而程序头表完整、代码段有成规模内容。',
            why: '这是可以得出的：它同时用到了「节表状态」和「段表状态」两个独立观测点，并且给出了「不是内容被加密」的排除依据。' },
          { t: '这个 dex 大概率是抽取壳产物——依据是类名与方法名完整、而大量 <code>code_item</code> 的 <code>insns_size</code> 为 0。',
            why: '这是可以得出的，而且正是抽取壳最直接的格式层证据：结构在、指令不在。' },
          { t: '这个 so 没有加固——依据是 ELF 头合法、两个 <code>PT_LOAD</code> 的偏移和大小都没有越界。',
            why: '<b>正确（这就是推不出来的那一个）。</b>这些条件只能证明「结构自洽」，' +
                   '也就是排除了「文件损坏 / dump 不完整」这一类原因；' +
                   '它对「内容有没有被处理过」完全没有发言权——抹节表、抹符号、字符串加密都会保留一个完全合法的头。' }
        ],
        explain:
          '<p>这道题考的是本章最后想说的一件事：<b>分清「排除了什么」和「证明了什么」。</b></p>' +
          '<p>每一项观测的证明力都是有边界的：</p>' +
          '<ul>' +
          '<li>「有签名块」→ 证明<b>签名机制存在</b>，并且能推出「改动必须重签」。硬对应，成立。</li>' +
          '<li>「节表没了 + 段表完整 + 代码成规模」→ 这是<b>两个独立观测点</b>交叉出来的结论：' +
          '段表完整排除了「加载结构被破坏」，代码成规模排除了「内容被整体加密」，' +
          '剩下最合理的解释就是「只抹掉了分析用的元数据」。成立。</li>' +
          '<li>「结构与符号都在、指令不在」→ 直接对应抽取壳的定义。成立。</li>' +
          '<li>「头合法、段不越界」→ 只说明<b>这个 ELF 在结构上是完整的</b>。' +
          '它排除的是「文件坏了」，不是「内容没被动过」。' +
          '<span class="hit">把一个「排除性证据」当成「确认性结论」，是加固判定里最常见的越界。</span></li>' +
          '</ul>' +
          '<p>所以给一个可操作的纪律：每次下判断前，把结论写成两句话——' +
          '<b>「我观测到了什么」</b>和<b>「这个观测能排除什么」</b>。' +
          '如果第二句里的「排除」覆盖不了第一句里的「结论」，那这个结论就是借来的。</p>' +
          '<p>这条纪律在本章每个实验里都出现过：<br>' +
          '• 3.4 的实验里，「改一个字节 → 摘要变」是<b>定义</b>（全文件签名的定义），所以结论成立；<br>' +
          '• 3.9 的实验里，「代码节落在第一个 PT_LOAD 区间内」是<b>交叉验证</b>，能和段表互相印证；<br>' +
          '• 3.10 的决策演练里，「结构自洽」被明确标成<b>只能排除一类原因</b>，不构成结论。</p>'
      },
      after:
        T.note('ok', '✅ 本章的收束',
          '<p style="margin-bottom:0">如果你只带走三句话：<br>' +
          '① <b>APK 是 zip 三段 + 一个夹在中间的签名块</b>，所以「改内容」和「重新打包」都会破坏 v2/v3 签名；<br>' +
          '② <b>DEX 是索引区 + 数据区</b>，索引定长所以多跳一次，数据变长所以要读 uleb128 长度前缀，' +
          '而抽取壳抽走的正是 <code>code_item</code> 里的 <code>insns</code>；<br>' +
          '③ <b>ELF 的段给装载器、节给分析者</b>，所以「抹掉节表程序照跑」「strip 掉 <code>.symtab</code> 不影响运行」，' +
          '而重定位常量这类数值必须查规范。<br><br>' +
          '<span class="hit">剩下的部分——怎么脱壳、怎么补环境、怎么写 hook——分别在第 16、21、24、8、9 章。' +
          '本章的作用是让那些章节里出现的每一个术语，在你脑子里都有一个确切的字节位置。</span></p>')
    }
  ],

  /* ============================================================== 名词表 */
  glossary: [
    { t: 'EOCD', d: 'End Of Central Directory。zip 文件末尾 22 字节（不含注释）的收尾结构，记录中央目录的偏移与大小。解析 zip 必须从它开始，因为本地文件头里没有全局信息。' },
    { t: '中央目录', d: 'zip 里所有 entry 的总索引，每条 46 字节定长 + 文件名 + 扩展字段，记录每个 entry 的本地头在文件里的偏移。' },
    { t: 'zipalign', d: '对 APK 内各条目做偏移对齐的工具，靠往扩展字段里插填充实现，目的是让不压缩的资源能被直接 mmap。' },
    { t: 'APK Signing Block', d: 'Android 7.0 起插在「中央目录之前」的签名夹层，格式为 size + ID-value 对 + size + 16 字节魔数 "APK Sig Block 42"。v2 的 block ID 是 0x7109871a，v3 是 0xf05368c0。' },
    { t: '全文件签名（v2/v3）', d: '对「entry 数据 + 中央目录 + EOCD」三段统一做摘要并签名，签名块自身被排除。这是「改一个字节就装不上」的结构性原因。' },
    { t: 'v1（JAR 签名）', d: '基于 META-INF/MANIFEST.MF 的逐条目内容摘要签名，不保护 zip 元数据，因此可以插入 MANIFEST 未列出的文件（Janus 类问题）。' },
    { t: 'AXML', d: 'Android 二进制 XML。AndroidManifest.xml 在 APK 里是编译后的形式，开头 4 字节为 03 00 08 00（RES_XML_TYPE，headerSize=8），字符串池化、属性名替换为资源 ID。' },
    { t: 'resources.arsc', d: '编译后的资源表，根 chunk 为 RES_TABLE_TYPE（0x0002），headerSize 为 12，所以文件开头是 02 00 0C 00。' },
    { t: 'string_ids / type_ids / proto_ids / field_ids / method_ids / class_defs', d: 'dex 的六个定长索引区。索引区只存下标或偏移，真实内容都在 data 区，这样既去重又能 O(1) 定位。' },
    { t: 'uleb128', d: '变长无符号整数编码：每字节低 7 位是数据，最高位表示「还有下一字节」。dex 的字符串数据项用它存 UTF-16 码元数——注意不是字节数。' },
    { t: 'class_data_item', d: 'class_def_item 通过 class_data_off 指向它，用四个 uleb128 给出静态字段、实例字段、直接方法、虚方法的数量，后面是编码后的字段与方法列表。' },
    { t: 'method_idx_diff', d: 'encoded_method 里表示方法索引的字段，存的是与上一个方法的<b>差值</b>而不是绝对下标，解析时必须累加还原。' },
    { t: 'code_item', d: '方法体的载体。头部 16 字节：registers_size / ins_size / outs_size / tries_size / debug_info_off / insns_size，后面是 insns 指令数组。抽取壳抽走的就是 insns。' },
    { t: 'map_list', d: 'dex 里声明「整份文件都有哪些结构、各自在哪、多大」的目录，反编译器常先读它。它与实际偏移不一致，是 dump 出来的 dex 打不开的常见原因。' },
    { t: 'Elf64_Ehdr / Phdr / Shdr / Sym', d: 'ELF 的四个核心结构，大小分别为 64 / 56 / 64 / 24 字节。注意 Elf64_Phdr 里 p_flags 在 offset 之前，而 32 位版本里它在最后。' },
    { t: '程序头表 / 段（segment）', d: '给装载器看的表，描述「文件里的哪一段映射到哪个虚拟地址、多大、什么权限」。粒度必须页对齐，通常只有 2–4 个 PT_LOAD。' },
    { t: '节头表 / 节（section）', d: '给链接器和分析者看的表，描述代码、数据、符号、重定位等有语义的块。节是可选的，且可以不属于任何段。' },
    { t: 'PT_LOAD', d: '需要映射进内存的段。装载器按 p_memsz 申请内存、写入 p_filesz 字节、其余补零。' },
    { t: '.bss', d: '未初始化数据。在文件里不占空间（SHT_NOBITS），在内存里占 p_memsz − p_filesz 那么多且全为 0。所以 p_memsz 大于 p_filesz 是完全正常的。' },
    { t: 'PT_GNU_RELRO', d: '声明一段区域在重定位完成后改为只读，常用来自保 GOT。它是「一段区间」，不是一段新数据，在节的视角里没有对应物。' },
    { t: '.shstrtab', d: '节名字符串表。sh_name 只是它的下标，所以节表被抹掉时节名也一起消失。由 ELF 头的 e_shstrndx 指出它是第几个节。' },
    { t: '.dynsym / .dynstr', d: '动态符号表与它的字符串表，带 SHF_ALLOC、会进内存，由 .dynamic 里的 DT_SYMTAB / DT_STRTAB 指向。运行时链接必须依赖它们，strip 不会删除。' },
    { t: '.symtab / .strtab', d: '完整符号表与字符串表，不带 SHF_ALLOC、不进内存，只给链接器和调试器用。strip 删掉的就是它。' },
    { t: 'SHN_UNDEF', d: 'st_shndx == 0，表示符号未定义，也就是「导入符号」——这个名字在别的模块里，本模块只在 GOT 里留槽等 linker 填。' },
    { t: 'st_info', d: 'Elf64_Sym 里的一个字节，高 4 位是绑定类型（LOCAL=0 / GLOBAL=1 / WEAK=2），低 4 位是符号类型（NOTYPE=0 / OBJECT=1 / FUNC=2 …）。' },
    { t: 'Elf64_Rela', d: '重定位项，24 字节：r_offset（要写的位置）、r_info（高位符号下标 + 低位类型）、r_addend（加数）。' },
    { t: 'R_AARCH64_RELATIVE', d: '值 0x403。不查符号，直接写「加载基址 + 加数」。so 修复工具最关心的一类重定位。' },
    { t: 'R_AARCH64_GLOB_DAT / JUMP_SLOT', d: '值 0x401 / 0x402。分别用来往 GOT 里填数据符号和函数符号的地址，后者通常住在 .rela.plt 里。' },
    { t: 'PLT / GOT', d: 'PLT 是跳转桩（adrp / ldr / br 三条指令），GOT 是可写的地址表。首次调用时 GOT 槽指向解析器，linker 找到真实地址后回填。改写 GOT 就是最经典的 import hook。' },
    { t: '延迟绑定', d: 'lazy binding。外部函数的地址不在加载时全部解析，而在第一次被调用时才解析并回填 GOT。' },
    { t: 'SO 修复', d: '把从内存 dump 出来的 so 重新整理成可加载文件的过程，核心工作包括重建节表、重算 RELATIVE 重定位、修正段偏移。' }
  ],

  /* ============================================================== 严师 */
  teacher: {
    id: 't28', chapter: 28,
    name: '追问老师 · 文件格式看着呢',
    sub: '三种容器，三套偏移表——说不清字段，就别谈分析',
    intro:
      '<p style="margin:0">这一章没有「技巧」，只有<b>事实</b>。所以我的问题也都指向事实：' +
      '<b>这个字节在哪个偏移、这个字段管什么、你凭什么这么判断。</b><br>' +
      '含糊的回答我会追问，追问三次我直接给答案——但那不算你过关。' +
      '特别提醒：如果你说「大概是 0x…」这种话，我不会接受，你只能说「我确定」或者「这个我要去查规范」。</p>',
    questions: [
      {
        id: 'c28q1', depth: 1, threshold: 0.7,
        q: '一个 APK 里的 <code>AndroidManifest.xml</code>，用文本编辑器打开是乱码。' +
           '这是不是说明这个 APK 加固了？如果不是，那它到底是什么？',
        concepts: [
          { label: '它是编译后的二进制 XML（AXML），不是被加密',
            hint: '如果一份 XML 被"编译"过，会变成什么形态？',
            any: ['二进制', 'axml', '编译后', '编译过', '二进制xml', '不是加密', '没有被加密', 'aapt'] },
          { label: '编译期做了字符串池化，正文里只留下标',
            hint: '一堆重复出现的标签名和字符串值，编译器会怎么处理？',
            any: ['字符串池', 'string pool', '池化', '下标', '索引', '去重', '共享字符串'] },
          { label: '属性名被替换成了资源 ID（一个 4 字节整数）',
            hint: 'android:name 这类属性名，在文件里还是文本吗？',
            any: ['资源id', '资源 id', '属性名', '0x0101', '整数', '替换', 'resource id'] },
          { label: '它的结构是 chunk 串：8 字节头（type / headerSize / size），前 4 字节是 03 00 08 00',
            hint: '二进制 XML 的每个块头部固定几个字节？开头是什么？',
            any: ['chunk', '0300', '0x0003', '前四个字节', '8字节', '8 字节', '头部'] },
          { label: '判断加固要靠别的特征（dex 结构 / so / 壳的入口），不能靠这个现象',
            hint: '那"加固"该怎么判断？',
            any: ['dex', 'so', '壳', '别的特征', '其他特征', '判定', '入口', 'application'] }
        ],
        hints: [
          '如果它不是"加密"，那它是"被编译"——编译会丢掉什么、保留什么？',
          '一个 XML 里同一个标签名会出现很多次。编译器会为每一次都存一份字符串吗？'
        ],
        probes: [
          '追问：那你怎么判断"这个 APK 加固了"？说说你会看哪些东西。',
          '追问：aapt2 / apktool 能把二进制 XML 还原成文本。这个还原过程是"解密"吗？为什么？'
        ],
        model:
          '<b>它没有被加密，它是被编译过的。</b><br><br>' +
          '<b>第一步：分清"加密"和"编译"。</b>加密是让内容不可读、需要密钥才能还原；' +
          '编译是把内容换成另一种更紧凑的表示。二进制 XML 属于后者——还原它不需要任何密钥，' +
          '规则完全公开，所以 apktool、jadx、aapt2 都能还原。<br><br>' +
          '<b>第二步：编译到底做了什么。</b>主要是两件事：<br>' +
          '① <b>字符串池化</b>：所有标签名、属性名、字符串值被收集进一张字符串池，正文里只留下"池内下标"。' +
          '这样一个重复出现的名字只存一份。<br>' +
          '② <b>属性名替换成资源 ID</b>：<code>android:name</code> 这类属性名在文件里变成一个 4 字节整数' +
          '（形如 <code>0x0101xxxx</code>），不再是一段文本。<br><br>' +
          '<b>第三步：文件的结构。</b>整个文件是一串 chunk，每个 chunk 的头部固定 8 字节：' +
          '<code>type</code>(u2) + <code>headerSize</code>(u2) + <code>size</code>(u4)。' +
          '文件第一个 chunk 的 type 一定是 <code>0x0003</code>（RES_XML_TYPE），headerSize = 8，' +
          '所以<b>前 4 个字节是 <code>03 00 08 00</code></b>。第二个 chunk 通常是字符串池（<code>0x0001</code>）。<br>' +
          '<span class="hit">顺带记一个好用的指纹：<code>resources.arsc</code> 的开头是 <code>02 00 0C 00</code>' +
          '（RES_TABLE_TYPE，headerSize 多一个 packageCount 所以是 12）。</span><br><br>' +
          '<b>结论：</b>看到乱码就喊"加固"，是把"我不认识的编码"当成了"被保护的内容"。' +
          '判断加固要看的是 dex 的结构完整性、so 的可读性、以及是否有壳的加载行为——' +
          '而"AndroidManifest 是二进制"是所有正常 APK 的共同特征，没有区分度。'
      },
      {
        id: 'c28q2', depth: 2, threshold: 0.75,
        q: '用 apktool 改了一个字符串，重新打包之后 App 装不上。请从<b>结构层面</b>说清原因，' +
           '并给出至少两条出路（以及各自的代价）。',
        concepts: [
          { label: 'v2/v3 是"全文件签名"：对 entry 数据 + 中央目录 + EOCD 三段一起做摘要，签名块自身被排除',
            hint: 'v2 的摘要覆盖了哪几段？',
            any: ['全文件', '整文件', '整个文件', 'v2', 'v3', '中央目录', 'eocd', '摘要', '哈希', 'hash', 'digest'] },
          { label: '两种改动都会破坏它：改内容改了数据区；重新打包重写了中央目录和 EOCD',
            hint: 'apktool 重新打包，除了你改的那个字符，还有什么是变的？',
            any: ['重新打包', '重写', '中央目录', 'eocd', '偏移', '顺序', '对齐', '变了', '两个都'] },
          { label: '出路一：用 apksigner 重新签名（这也是唯一的必做动作）',
            hint: '结构改不了，那就换签名——用什么工具？',
            any: ['重新签名', '重签', 'apksigner', '重新签', 'sign'] },
          { label: '代价：重签会换掉签名本身，靠签名摘要做身份校验的 App 会拒绝',
            hint: '重签之后，App 眼里的"你"还是原来那个吗？',
            any: ['签名变了', '换了签名', '校验', '检测', '摘要比对', '身份', '不匹配', '拒绝', '服务器校验'] },
          { label: 'v1 与 v2 的差别：v1 只保护条目内容摘要、不保护 zip 元数据，所以 Janus 类问题才可能出现',
            hint: '在 v2 之前，往包里塞一个 MANIFEST 没有的文件会被发现吗？',
            any: ['v1', 'jar', 'manifest', '不保护', 'zip 元数据', '未签名', 'janus', '插入'] }
        ],
        hints: [
          '问题不在你改的那一个字符上——apktool 重新打包时，zip 里还有什么是被重写的？',
          '想清楚"签名覆盖了哪些字节"，答案就出来了：既然覆盖范围比你以为的大，那么改哪些东西会撞上它？'
        ],
        probes: [
          '追问：如果我只改 <code>resources.arsc</code> 里的一个字符串，用一个"能保持 zip 结构不变"的工具原地改，签名还有效吗？为什么？',
          '追问：怎么在不打开任何工具的情况下，先从字节上判断这个 APK 到底有没有 v2 签名？'
        ],
        model:
          '<b>根因：你触碰了一个覆盖范围比你想象大得多的签名。</b><br><br>' +
          '<b>第一步：v2/v3 的覆盖范围。</b>v2（Android 7.0 引入）是"全文件签名"：' +
          '它对 <b>entry 数据 + 中央目录 + EOCD</b> 三段一起做摘要，' +
          '而把 <b>APK Signing Block 自身排除在外</b>（否则就循环依赖了）。' +
          'v3（Android 9）在此基础上加了密钥轮替证明，block ID 不同，覆盖方式一样。<br><br>' +
          '<b>第二步：为什么 apktool 重打包必然失效。</b>你改的那一个字符串确实改动了数据区；' +
          '但更关键的是——apktool 重新打包会<b>重写整个 zip 结构</b>：条目顺序、扩展字段、对齐填充、' +
          '中央目录的每条记录、EOCD 里记录的中央目录偏移，全都会变。' +
          '签名块的位置又是靠"中央目录偏移"定位的，所以连它自己的位置都变了。' +
          '<span class="hit">改内容 + 重打包 = 两头都撞上，没有侥幸。</span><br><br>' +
          '<b>第三步：出路一——重新签名。</b>用 <code>apksigner</code>（或 Android Studio 的签名流程）' +
          '对整个 APK 重新签一遍 v1/v2/v3。这是唯一能让你装上设备的动作。<br>' +
          '<b>代价：</b>签名本身变了。如果 App 或它的服务端拿签名摘要当身份标识（很多金融、游戏类都这么做），' +
          '重签之后会被判定为"非官方版本"——轻则功能受限，重则直接拒绝。' +
          '所以"能装上"和"能跑通"是两件事。<br><br>' +
          '<b>第四步：出路二——只改不改结构的部分。</b>如果你确实只想改一点数据，' +
          '可以考虑"原地替换等长字节"（长度完全一致，不重排任何结构）。' +
          '但这只在<b>极少数</b>情况下可行：只要长度变了，<code>sh_offset</code>、' +
          '中央目录里的 <code>compressed size</code>、EOCD 都要跟着改，等于又回到重打包。' +
          '而且即使原地替换，只要你替换的是被摘要覆盖的区域，v2 依然会失效。' +
          '<span class="hit">所以"原地改字节"能保住签名的前提，是那段字节<b>不在摘要覆盖范围内</b>——' +
          '这在 v2 之后几乎不存在。</span><br><br>' +
          '<b>为什么 v1 时代不一样：</b>v1（JAR 签名）只对每个 entry 的<b>内容摘要</b>签名，' +
          '<b>不保护 zip 元数据</b>。所以当年可以往包里插一个 MANIFEST 里没有列的文件，' +
          'Android 照样按 v1 验证通过——这就是 Janus 一类问题的根源，也是 v2 被引入的直接原因。<br><br>' +
          '<b>顺带回答"怎么从字节上判断有没有 v2"：</b>读 EOCD 拿到中央目录偏移，' +
          '看这个偏移减 16 的 16 个字节是不是 <code>APK Sig Block 42</code>。是就有，不是就没有。'
      },
      {
        id: 'c28q3', depth: 2, threshold: 0.7,
        q: 'ELF 的<b>段</b>和<b>节</b>到底有什么区别？为什么装载器只看段？请顺便解释：' +
           '为什么"抹掉节表"的 so 还是能正常运行？',
        concepts: [
          { label: '段由程序头表描述，是运行时的映射单位：页对齐、按页设权限',
            hint: '段是按什么划分的？粒度受什么限制？',
            any: ['程序头', 'program header', '映射', '页', 'page', '权限', '装载', 'segment', '4k', '4096'] },
          { label: '节由节头表描述，是链接器与分析者的语义单位（代码 / 数据 / 符号 / 重定位）',
            hint: '节是按什么划分的？谁用它？',
            any: ['节头', 'section header', '语义', '符号表', '重定位', '链接器', '分析', '代码', '数据'] },
          { label: '划分依据不同：段看权限，节看语义；两者不是粗粒度与细粒度的关系',
            hint: '同一段里的两个节，为什么权限一定相同？',
            any: ['权限', '语义', '依据', '不同', '不是粗细', '独立', '两套'] },
          { label: '存在不属于任何段的节（.symtab / .strtab / .comment），它们根本不进内存',
            hint: '哪些节在文件里有、运行时却没有？',
            any: ['symtab', 'strtab', 'comment', '不属于', '不进内存', '不分配', 'alloc'] },
          { label: '装载器只读程序头表，所以节表是可选的；strip 只影响节，不影响段',
            hint: '内核和 linker 拿到 so 会读哪张表？',
            any: ['只读程序头', '程序头表', '可选', '不影响运行', 'strip', '照跑', '抹掉', '能跑', '不参与'] }
        ],
        hints: [
          '把同一个 so 想象成两份文档：一份给搬家工人，一份给工程师。他们各自关心什么？',
          '"抹掉节表程序还能跑"这个事实，本身就说明节表不在加载路径上。那加载路径上是什么？'
        ],
        probes: [
          '追问：既然段表才是运行必需的，那为什么几乎所有分析工具（IDA、readelf -S）都优先看节表？',
          '追问：如果加固方想隐藏自己动过手脚的痕迹，他更应该动段还是动节？各自的后果是什么？'
        ],
        model:
          '<b>它们是两套独立的视角，回答两个不同的问题。</b><br><br>' +
          '<b>一、段：回答"怎么装进内存"。</b><br>' +
          '段由<b>程序头表</b>（program header table）描述，每条 56 字节。' +
          '一个段说的是：从文件哪个偏移读、映射到哪个虚拟地址、占多大、什么权限。' +
          '因为要交给内核做 <code>mmap</code>，所以它受两个硬约束：' +
          '<b>必须页对齐</b>（AArch64 Linux 通常 4KB），而且<b>权限是按页设置的</b>——' +
          '所以同一页里不能混着两种权限。这直接导致一个 so 通常只有 2 个 <code>PT_LOAD</code>：' +
          '一个 R-X（代码和只读常量），一个 RW-（数据）。' +
          '<span class="hit">段的划分依据是"权限"，不是"用途"。</span><br><br>' +
          '<b>二、节：回答"文件里有什么"。</b><br>' +
          '节由<b>节头表</b>描述，每条 64 字节。它给出名字、类型、偏移、大小和标志。' +
          '<code>.text</code> 是代码、<code>.rodata</code> 是只读常量、<code>.dynsym</code> 是动态符号表、' +
          '<code>.rela.dyn</code> 是数据重定位表——这些都是<b>语义</b>层面的区分。' +
          '节的边界由链接脚本和编译器决定，<b>不需要页对齐，也不需要能被映射</b>。<br>' +
          '<span class="hit">所以：同一段里的两个节，权限一定相同（.text 和 .rodata 都在 R-X 段里）；' +
          '但不同节可以完全不属于任何段。</span><br><br>' +
          '<b>三、为什么装载器只看段。</b>内核和 linker 的任务只有一件事：把这个 so 映射进内存、' +
          '把重定位做完、然后跳进去。这个过程里它们只需要"哪些字节要放到哪、什么权限"。' +
          '<b>它们完全不需要知道"这块是代码还是常量"</b>——那是人（和链接器）才关心的事。' +
          '而且 ELF 规范里节头表本来就是<b>可选</b>的（<code>e_shnum</code> 可以为 0）。<br><br>' +
          '<b>四、于是"抹掉节表还能跑"就顺理成章了。</b>' +
          '更具体一点：<code>.symtab</code>、<code>.strtab</code>、<code>.comment</code> 这些节' +
          '<b>连 <code>SHF_ALLOC</code> 标志都没有</b>，也就是说它们在设计上就不进内存，' +
          '只在文件里存在。删掉它们，运行时的内存镜像<b>一个字节都不变</b>。' +
          '这就是 <code>strip</code> 的原理：它删的是"分析用的元数据"。<br><br>' +
          '<b>五、那分析工具为什么反而爱看节表？</b>因为节表信息量大得多且更可靠：' +
          '它直接告诉你哪块是代码、符号表在哪、重定位表怎么组织。' +
          '<span class="hit">结论就是本章那句话：<b>段决定能不能跑，节决定好不好分析。</b></span>'
      },
      {
        id: 'c28q4', depth: 2, threshold: 0.7,
        q: '你从一个 so 里发现"符号表几乎是空的"。请说清：你要先确认哪件事，才不至于误判？' +
           '另外，<code>strip</code> 删掉的为什么是 <code>.symtab</code> 而不是 <code>.dynsym</code>？',
        concepts: [
          { label: '先确认是哪一个符号表：.dynsym 空了是大事，.symtab 空了是 strip 的正常结果',
            hint: '一个 so 里有几份符号表？',
            any: ['dynsym', 'symtab', '哪一个', '两张', '两份', '区分', '动态符号', '静态符号'] },
          { label: '.dynsym / .dynstr 是运行时必需的：由 .dynamic 里的 DT_SYMTAB / DT_STRTAB 指向，linker 靠它解析导入导出',
            hint: '运行时谁在读符号表？它怎么找到符号表？',
            any: ['dt_symtab', 'dt_strtab', 'dynamic', '运行时', 'linker', '链接器', '导入', '导出', '解析'] },
          { label: '.symtab / .strtab 只给链接器和调试器用，没有 SHF_ALLOC、不进内存，删掉不影响运行',
            hint: '这两张表会进内存吗？',
            any: ['不进内存', 'alloc', '调试', '链接器', '不影响', '本地符号', '调试信息'] },
          { label: '判断要看"符号密度 vs 代码规模"：.dynsym 为空但 .text 成规模 → 抹名字而不是抹内容',
            hint: '如果名字没了，代码还在不在？怎么验证代码还在？',
            any: ['密度', '规模', 'text', '代码段', '名字', '内容', '不匹配', '成规模'] },
          { label: '导出符号里的 Java_* / JNI_OnLoad 是路标，能指认 JNI 注册方式',
            hint: '哪一类导出符号对逆向最有用？',
            any: ['java_', 'jni_onload', '导出', '静态注册', '动态注册', 'registerNatives', '路标'] }
        ],
        hints: [
          '一个 so 里可以有两份符号表，它们服务的对象完全不同。你说的"空"，是哪一份空了？',
          '"名字没了"和"内容没了"是两件事。你要用什么证据把这两件事分开？'
        ],
        probes: [
          '追问：如果加固方把 <code>.dynsym</code> 里某个导出符号的名字清空、但保留结构，运行时还正常吗？他从这件事里得到了什么？',
          '追问：导入符号和导出符号在 <code>.dynsym</code> 里是混在一起的。你怎么用字段把它们分开？'
        ],
        model:
          '<b>先分清两张表，再谈"空不空"。</b><br><br>' +
          '<b>一、一个 so 里可以有两份符号表。</b><br>' +
          '• <b><code>.dynsym</code> + <code>.dynstr</code></b>：<b>运行时</b>用。' +
          '它们带 <code>SHF_ALLOC</code>、会进内存，由 <code>.dynamic</code> 里的 ' +
          '<code>DT_SYMTAB</code> / <code>DT_STRTAB</code> 指向。linker 靠它做符号解析和 GOT 重定位。' +
          '内容只包含"需要跨模块可见"的符号：本模块导出的、以及本模块从别处导入的。<br>' +
          '• <b><code>.symtab</code> + <code>.strtab</code></b>：<b>链接与调试</b>用。' +
          '没有 <code>SHF_ALLOC</code>，<b>不进内存</b>，只能通过节表找到。' +
          '内容包含所有符号，包括本地函数、静态变量、文件符号。<br><br>' +
          '<b>二、所以 <code>strip</code> 删的必然是 <code>.symtab</code>。</b>' +
          '原因不是"它更重要/更不重要"，而是<b>它的缺失不影响运行</b>：' +
          '删掉一个不进内存的节，运行时的内存镜像一个字节都不变。' +
          '而 <code>.dynsym</code> 一旦被破坏，linker 找不到导入的 <code>memcpy</code>、' +
          '也找不到本模块的导出函数，程序直接加载失败——<b>那不是"更难分析"，那是"根本跑不起来"</b>。<br>' +
          '<span class="hit">一句话：strip 动的是"可选的元数据"，不是"必需的协议"。</span><br><br>' +
          '<b>三、所以"符号表空了"这个观察必须先分清对象：</b><br>' +
          '• <code>.dynsym</code> 也空了 → 严重。要么文件被破坏（加载不了），' +
          '要么是加固方做了"清名字保结构"的处理（运行时能跑，但静态看不到导出名）。<br>' +
          '• 只有 <code>.symtab</code> 空了 → 这是正常 strip，<b>说明不了加固</b>。' +
          'IDA 里满屏 <code>sub_xxxx</code> 就是这个现象。<br><br>' +
          '<b>四、判断动手脚的正确依据是"密度 vs 规模"。</b>' +
          '把 <code>.dynsym</code> 的条目数和 <code>.text</code> 的字节数放在一起看：' +
          '正常 so 导出的符号数量与代码规模有一个大致的比例关系。' +
          '如果 <code>.dynsym</code> 几乎为空、而 <code>.text</code> 依然有几十 KB 的成规模代码，' +
          '那就说明<b>名字被抹了，内容还在</b>——这是"抹名字"型加固的典型指纹。<br>' +
          '<span class="hit">关键是这个判断不需要任何高级工具：一张表的条数、另一张表的大小，都是文件里的数字。</span><br><br>' +
          '<b>五、导出符号里最值得先看的是 <code>Java_*</code> 和 <code>JNI_OnLoad</code>。</b>' +
          '<code>Java_</code> 前缀是<b>静态注册</b>的命名约定：' +
          '<code>Java_com_example_app_Sign_getSign</code> 直接编码了 Java 侧的包名、类名、方法名。' +
          '而如果导出里只有一个 <code>JNI_OnLoad</code>、没有任何 <code>Java_*</code>，' +
          '那几乎可以肯定用的是<b>动态注册</b>（<code>RegisterNatives</code>），' +
          '方法名到函数地址的映射是运行时才建立的（第 9 章）。' +
          '<b>导出符号表就是不完整的索引——它的"不完整"本身就是证据。</b>'
      },
      {
        id: 'c28q5', depth: 3, threshold: 0.75,
        q: '<b>综合题。</b>你手上只有一段十六进制：某个 so 的 ELF 头 + 完整的程序头表。' +
           '请逐步说清<b>你如何手工判断它能不能被 dlopen</b>——每一步看哪个字段、排除什么、' +
           '最后你的结论能说到什么程度。',
        concepts: [
          { label: '第一步读 e_ident：魔数 7f 45 4c 46 确认是 ELF，EI_CLASS(2=ELF64) / EI_DATA(1=小端) 决定后面用什么宽度和端序',
            hint: '在读任何偏移之前，你必须先确定什么？',
            any: ['magic', '魔数', 'e_ident', '7f45', 'class', 'elf64', 'data', '小端', '端序', '宽度'] },
          { label: 'e_type 必须是 ET_DYN(3)（可被 dlopen 的共享库/PIE），e_machine 必须与目标设备匹配（AArch64 = 183）',
            hint: '哪种 e_type 才能被 dlopen？架构不匹配会怎样？',
            any: ['e_type', 'et_dyn', '3', '共享库', 'e_machine', '183', 'aarch64', '架构', '匹配'] },
          { label: '用 e_phoff / e_phnum / e_phentsize 遍历程序头表，逐个检查 PT_LOAD：p_offset + p_filesz 不能越界；p_vaddr ≡ p_offset (mod p_align)',
            hint: '段表的哪几个字段可以做完整性校验？',
            any: ['e_phoff', 'phnum', 'phentsize', 'pt_load', 'p_offset', 'p_filesz', '越界', 'p_align', '对齐', '同余'] },
          { label: '权限合理性：至少要有一个可执行段和一个可写段；出现 rwx 同页很可疑（因为权限是按页设的）',
            hint: '什么权限组合是正常的？什么组合值得怀疑？',
            any: ['可执行', 'r-x', 'rw', '权限', 'rwx', '页', '可疑', '组合'] },
          { label: 'p_memsz > p_filesz 是正常的 .bss（加载时补零），不是损坏；反过来 p_memsz < p_filesz 才是异常',
            hint: '哪个方向才是异常？',
            any: ['memsz', 'filesz', 'bss', '补零', '正常', '截断', '反过来'] },
          { label: '节表不是必需的：e_shnum 可以为 0，没有节表也能 dlopen；但 .dynamic / .dynsym 这些运行时结构必须存在',
            hint: 'dlopen 需要节表吗？那它需要什么？',
            any: ['节表', '不是必须', '可选', 'e_shnum', 'dynsym', 'dynamic', '运行时', '不需要'] },
          { label: '结论的边界：光看头和段表只能证明"加载结构自洽"，不能证明"内容没被处理过"——那要看 .text 是否成规模、符号是否正常',
            hint: '这套检查能排除什么、不能排除什么？',
            any: ['不能证明', '只能排除', '边界', '内容', 'text', '规模', '符号', '还需', '不够'] }
        ],
        hints: [
          '顺序很重要：在读任何字段之前，你必须先确定"用什么宽度、什么端序去读"。这一步看什么？',
          '段表的完整性可以用两个数学关系来批量验证——一个是"不越界"，一个是"同余"。它们分别是什么？'
        ],
        probes: [
          '追问：如果程序头完全自洽，但 <code>.dynsym</code> 是空的、<code>.text</code> 里有大量代码，你怎么改你的结论？',
          '追问：这套检查做下来，你能不能说"这个 so 没有加固"？为什么？'
        ],
        model:
          '<b>完整流程（七步），每一步都说明"看什么"和"排除什么"。</b><br><br>' +
          '<b>第 0 步：确定读取方式。</b>先读 <code>e_ident</code> 的 16 个字节：' +
          '① 前 4 字节是不是 <code>7f 45 4c 46</code>——不是就根本不是 ELF；' +
          '② <code>EI_CLASS</code>（下标 4）：1 = ELF32，2 = ELF64，决定后面所有指针/偏移是 4 字节还是 8 字节；' +
          '③ <code>EI_DATA</code>（下标 5）：1 = 小端，2 = 大端，决定所有多字节字段的字节序。' +
          '<span class="hit">这一步错了，后面每个字段都是乱码——这是自写解析器的第一大 bug 源。</span><br><br>' +
          '<b>第 1 步：e_type。</b>偏移 0x10，u2。<b>必须是 <code>ET_DYN</code>(3)</b>——' +
          '共享库和 PIE 可执行文件都是它。如果是 <code>ET_EXEC</code>(2)，那是固定地址的可执行文件，' +
          '一般不该被 <code>dlopen</code>；如果是 <code>ET_REL</code>(1)，那是还没链接的目标文件（.o）。<br><br>' +
          '<b>第 2 步：e_machine。</b>偏移 0x12，u2。Android 上要看目标 ABI：' +
          '<b>AArch64 = 183</b>、ARM = 40、x86_64 = 62。架构不匹配的东西加载会直接失败——' +
          '这一条能立刻排除"下错 ABI 的包"。<br><br>' +
          '<b>第 3 步：拿到段表的位置和条数。</b><code>e_phoff</code>（0x20，u8）、' +
          '<code>e_phnum</code>（0x38，u2）、<code>e_phentsize</code>（0x36，u2，正常是 56）。' +
          '三个值要先自检：<code>e_phoff + e_phnum × e_phentsize</code> 不能超出文件大小；' +
          '<code>e_phentsize</code> 应该是 56。<br><br>' +
          '<b>第 4 步：逐条检查 PT_LOAD。</b>每条 56 字节，字段位置：' +
          '<code>p_type</code>(+0x00)、<code>p_flags</code>(+0x04)、<code>p_offset</code>(+0x08)、' +
          '<code>p_vaddr</code>(+0x10)、<code>p_filesz</code>(+0x20)、<code>p_memsz</code>(+0x28)、' +
          '<code>p_align</code>(+0x30)。两条硬校验：<br>' +
          '• <b>不越界</b>：对每个 <code>PT_LOAD</code>，<code>p_offset + p_filesz</code> 必须 ≤ 文件大小；<br>' +
          '• <b>同余</b>：<code>p_vaddr ≡ p_offset (mod p_align)</code> 必须成立——' +
          '否则装载器没法把"文件偏移"和"虚拟地址"用一次 mmap 对上。<br>' +
          '<b>这两条同时通过，说明段表自洽、文件没有半截。</b><br><br>' +
          '<b>第 5 步：权限是否合理。</b>合并成权限视图看：至少要有一个可执行段（R-X，放代码）' +
          '和一个可写段（RW-，放数据）。如果某个 <code>PT_LOAD</code> 的 <code>p_flags</code> 是 7（rwx），' +
          '说明链接器没能把可执行段和数据段按页分开——<b>这值得怀疑，但不是加固的充分证据</b>' +
          '（有些老工具链或特殊构建会这样）。<br><br>' +
          '<b>第 6 步：别把 .bss 当损坏。</b>某个段 <code>p_memsz &gt; p_filesz</code> 是<b>正常</b>的：' +
          '多出来的部分是加载时补零的未初始化数据。' +
          '真正异常的是<b>反过来</b>（<code>p_memsz &lt; p_filesz</code>），' +
          '或者 <code>p_offset + p_filesz</code> 越界。<br><br>' +
          '<b>第 7 步：明确结论的边界。</b>这一步最容易被忽略，但它是这道题的重点。<br>' +
          '上面六步全部通过，你能得到的结论只有一句：' +
          '<b>「这个 ELF 的加载结构是自洽的，可以被 dlopen。」</b><br>' +
          '你<b>不能</b>说「它没有加固」，因为：<br>' +
          '• 节表不是必需项（<code>e_shnum</code> 可以是 0），抹掉节表照样通过上面所有检查；<br>' +
          '• 符号被抹掉、字符串被加密、代码被虚拟化，都不会破坏段表的自洽性；' +
          '• 你甚至没有检查内容——没有看 <code>.text</code> 是否成规模、没有看 <code>.dynsym</code> 是否正常。<br>' +
          '<span class="hit">所以在这套检查之后，如果你想继续判断"内容有没有被处理"，' +
          '还要补一次内容层的观察：<code>.dynsym</code> 的条目数 vs <code>.text</code> 的大小、' +
          '字符串区是否可读。这两层是独立的，缺一不可。</span><br><br>' +
          '<b>把这条方法论记下来：</b>结构检查的作用是<b>排除一类原因</b>（文件坏了、ABI 错了、dump 不完整），' +
          '不是<b>给出最终结论</b>。把"排除"说成"证明"，就是这道题最容易犯的错。'
      },
      {
        id: 'c28q6', depth: 3, threshold: 0.75,
        q: '<b>综合题。</b>给你一个 APK，<b>不装任何额外工具</b>（只有十六进制编辑器和文件系统）。' +
           '请说清你如何分三层判断：APK 是否加固、dex 是否被抽取、so 是否被加密。<br>' +
           '要求：每层都要说出<b>看哪个字段</b>，以及这个字段能得出什么、<b>不能</b>得出什么。',
        concepts: [
          { label: 'APK 层：读 EOCD 拿中央目录偏移与条目列表 → dex 的数量/大小、lib/<abi>/ 下的 so 清单、有没有 APK Sig Block 42',
            hint: 'zip 结构里最省事的三个观察是什么？',
            any: ['eocd', '中央目录', '条目', 'classes.dex', '数量', '大小', 'lib', 'abi', '签名块', 'sig block'] },
          { label: 'DEX 层：header 的 magic 版本 / class_defs_size / method_ids_size；以及 map_list 与 header 声明的偏移是否一致',
            hint: 'dex 头部里哪两个计数最能说明"有没有东西"？',
            any: ['magic', 'class_defs_size', 'method_ids_size', 'map_list', 'map_off', '版本', '计数'] },
          { label: '抽取壳的判据是 code_item 的 insns 覆盖率（insns_size 成片为 0 或 code_off 指向空壳），不是"类名有没有"',
            hint: '抽取壳抽走的是哪一段字节？在哪个结构里看？',
            any: ['insns', 'code_item', 'code_off', '覆盖率', '为 0', '空', '方法体', '指令'] },
          { label: 'SO 层第一步：ELF 头是否合法 + 程序头是否自洽（偏移越界 / 对齐同余）→ 先排除"文件坏了 / dump 不完整"',
            hint: '在看内容之前，先要排除什么？',
            any: ['elf头', '程序头', '越界', '对齐', '同余', '自洽', '损坏', '排除'] },
          { label: 'SO 层第二步：节表在不在；.dynsym 的条目数 vs .text 的规模是否匹配 → 区分"抹名字"与"抹内容"',
            hint: '"名字没了"和"内容没了"怎么分开？',
            any: ['节表', 'dynsym', 'text', '规模', '密度', '名字', '内容', '匹配'] },
          { label: '顺序纪律：先排除最平凡的解释（文件损坏 / ABI 不对 / dump 不完整），再考虑加密与加固',
            hint: '遇到异常时，先想简单的还是复杂的？',
            any: ['先排除', '平凡', '简单', '损坏', '顺序', '先结构'] },
          { label: '结论的边界：每一层的观测只能排除有限的可能，"结构正常"不等于"没有加固"，要分层表述',
            hint: '做完这些检查，你能下什么结论、不能下什么结论？',
            any: ['不能证明', '边界', '排除', '分层', '不等于', '结构正常', '只能'] }
        ],
        hints: [
          '三层里最便宜的是 APK 层（只要列条目），最贵的是 so 层（要逐字段算）。所以顺序是什么？',
          '每一层都要回答两个问题：这个观测排除了什么？它还留下了哪些可能？'
        ],
        probes: [
          '追问：如果三层都"看起来正常"，你能不能说这个 App 没加固？还需要补什么观察？',
          '追问：假设 dex 那一层你发现 class_defs_size 只有 12，而 lib/ 下有一个 6 MB 的 so。你会怎么安排接下来的工作？'
        ],
        model:
          '<b>三层，从最便宜的开始，每层只回答"排除了什么"。</b><br><br>' +
          '<b>第 0 层（最便宜）：APK 这个 zip。</b><br>' +
          '从文件尾部找 EOCD（<code>50 4b 05 06</code>），读出中央目录偏移与大小，列出所有条目。三个观察：<br>' +
          '① <b>dex 的数量与大小</b>：只有一个几十 KB 的 <code>classes.dex</code>，说明业务代码不在这里——' +
          '要么在 <code>assets/</code>，要么在 so 里。多个大 dex 则说明是常规多 dex 结构。<br>' +
          '② <b><code>lib/&lt;abi&gt;/</code> 下的 so 清单</b>：只有一个却是数 MB，说明算法/校验/加固核心都在里面。<br>' +
          '③ <b>中央目录偏移 − 16 处是不是 <code>APK Sig Block 42</code></b>：决定后面改动要不要重签。<br>' +
          '<span class="hit">这一层能排除的是"业务逻辑在哪一层"，不能告诉你"有没有加固"。</span><br><br>' +
          '<b>第 1 层：dex 的结构。</b><br>' +
          '对每个 dex 读 112 字节 header：<br>' +
          '① <code>magic</code>（0x00）：确认是 <code>dex\\n0xx\\0</code>，版本与目标系统是否匹配。' +
          'magic 都不对说明根本不是 dex。<br>' +
          '② <code>class_defs_size</code>（0x60）：正常 App 几百到几千。个位数或 0 → 基本没脱到东西。<br>' +
          '③ <code>method_ids_size</code>（0x58）：与 <code>class_defs_size</code> 的比例严重失调，说明结构被动过。<br>' +
          '④ <code>map_off</code> 指向的 <code>map_list</code>：它是对整份文件的完整声明。' +
          '如果它声明的偏移与实际对不上，那说明这份 dex 是"拼出来的"（dump 后没修好），而不是"被加固了"。<br>' +
          '<b>判断抽取壳的关键在下一步：</b>顺着 <code>class_defs</code> → <code>class_data_item</code> → ' +
          '<code>encoded_method</code> 找到每个 <code>code_off</code>，看 <code>code_item</code> 的 ' +
          '<code>insns_size</code>（+0x0C）。<b>成片为 0</b> → 抽取壳（方法体还没回填）；' +
          '<code>code_off</code> 为 0 是合法的（abstract / native），不要误判。<br>' +
          '<span class="hit">这一层的准确判据是"指令覆盖率"，不是"类名在不在"。' +
          '类名全在、方法体全空，恰恰是抽取壳最典型的样子。</span><br><br>' +
          '<b>第 2 层：so。分两步，不能跳。</b><br>' +
          '<b>第一步——结构自洽性（排除"文件坏了"）：</b>' +
          '读 ELF 头确认魔数 / class / data；确认 <code>e_type</code> 是 <code>ET_DYN</code>、' +
          '<code>e_machine</code> 与目标 ABI 匹配；遍历程序头表的每个 <code>PT_LOAD</code>，' +
          '校验 <code>p_offset + p_filesz</code> 不越界、<code>p_vaddr ≡ p_offset (mod p_align)</code>。' +
          '<code>p_memsz &gt; p_filesz</code> 是正常的 .bss。<br>' +
          '<b>第二步——内容是否被动过：</b>' +
          '① <b>节表在不在</b>（<code>e_shnum</code> 是否为 0）。没了但代码段成规模 → 抹节表型加固。<br>' +
          '② <b><code>.dynsym</code> 的条目数 vs <code>.text</code> 的规模</b>。' +
          '几乎为空但代码成规模 → 抹名字型加固。<br>' +
          '③ <b>字符串区是否可读</b>（<code>.rodata</code> 或 <code>.dynstr</code> 里能不能看到可打印字符）。' +
          '整片高熵 → 字符串加密。<br>' +
          '<span class="hit">这两步的分工是：第一步排除"文件坏了/ABI 错了"，第二步才谈"被处理过"。' +
          '顺序颠倒，你就会把 dump 不完整的 so 当成加固样本，或者反过来。</span><br><br>' +
          '<b>三条纪律，比上面任何一个字段都重要：</b><br>' +
          '① <b>先排除最平凡的解释。</b>文件损坏、ABI 不匹配、dump 半截——这些都比"加固"常见，' +
          '而且检查成本最低。<br>' +
          '② <b>每个观测都要说清"排除了什么"。</b>"结构自洽"排除的是"文件坏了"，' +
          '不排除"内容被加密"。把排除说成证明，是这类判断里最常见的越界。<br>' +
          '③ <b>结论分层表述。</b>不要说"这个 App 加固了"，要说：' +
          '"APK 层是常规多 dex；dex 层结构完整但 <code>insns_size</code> 成片为 0，指向抽取壳；' +
          'so 层结构自洽、节表完整、<code>.dynsym</code> 正常，暂时没看到被动过的迹象"。' +
          '<span class="hit">分层的结论可以被验证，笼统的结论只能被争论。</span>'
      },
      {
        id: 'c28q7', depth: 1, threshold: 0.7,
        q: 'dex 里每个字符串数据项前面都有一个 <b>uleb128</b>。请说清：它是什么编码、' +
           '为什么字符串前面要放它、以及<b>它存的到底是什么</b>。',
        concepts: [
          { label: '变长无符号整数编码：每字节低 7 位是数据，最高位是"还有下一字节"的续接标志',
            hint: '一个字节里，哪几位放数据、哪一位做标志？',
            any: ['变长', 'uleb128', '低7位', '低 7 位', '最高位', '续接', '标志位', 'continuation', 'leb128'] },
          { label: '收益：小数值只占 1 字节（省空间），大数值也能表示（不设上限）',
            hint: '为什么不用固定 4 字节？',
            any: ['省空间', '节省', '小的', '变长', '不浪费', '压缩', '1字节', '一个字节'] },
          { label: '它存的是 UTF-16 码元个数，不是字节数',
            hint: '"签名校验"这四个字，uleb128 里写的是 4 还是 12？',
            any: ['utf-16', 'utf16', '码元', '字符数', '不是字节', '字数', 'unicode'] },
          { label: '因为字符串是变长的：解析器必须先读长度，才能知道内容有多长、下一个数据项从哪开始',
            hint: '如果你不知道这个字符串有多长，怎么找到下一个字符串？',
            any: ['变长', '不定长', '长度', '下一个', '定位', '前进', '边界', '遍历'] },
          { label: '它是普通编码，不是加密/混淆（不要把它当成保护手段）',
            hint: '看到变长编码，是不是该往"加密"上想？',
            any: ['不是加密', '不是混淆', '编码', '明文', '公开', '规范', '标准'] }
        ],
        hints: [
          '一个字节只有 8 位。如果要表示很大的数，又不想浪费空间，你会怎么分配这 8 位？',
          '纯 ASCII 时，"码元数"和"字节数"恰好相等——这就是很多人误以为它存字节数的原因。遇到中文呢？'
        ],
        probes: [
          '追问：那你怎么知道一个 uleb128 到底占几个字节？读到什么时候停？',
          '追问：既然它是变长编码，解析器在读它的时候有什么风险？（提示：想想一个恶意构造的文件）'
        ],
        model:
          '<b>它是 uleb128：一种变长无符号整数编码。</b><br><br>' +
          '<b>一、编码规则。</b>每个字节只用<b>低 7 位</b>放数据，<b>最高位</b>是标志位：' +
          '1 表示"后面还有字节"，0 表示"到此结束"。' +
          '第一个字节放最低 7 位，第二个字节左移 7 位，第三个左移 14 位……<br>' +
          '例：<code>82 01</code> → 第一字节 <code>0x82</code>，低 7 位 = 2，最高位为 1（继续）；' +
          '第二字节 <code>0x01</code>，低 7 位 = 1，最高位为 0（结束）→ 值 = 2 + (1 × 128) = <b>130</b>。<br>' +
          '<span class="hit">单字节最多表示 0–127，所以 130 必须用两字节。</span><br><br>' +
          '<b>二、为什么要变长。</b>因为 dex 里这类"计数 / 长度 / 偏移差"的数值，分布极度不均：' +
          '绝大多数很小（0、1、2、几十），但偶尔会有几百上千。' +
          '固定 4 字节的话，几万个小数值每个浪费 3 字节，累计起来很可观；' +
          '而变长编码让"小的省空间、大的也能装"，不需要设上限。<br><br>' +
          '<b>三、为什么放在字符串前面。</b>因为<b>字符串是变长的</b>。' +
          '如果不知道这个字符串有多长，解析器就不知道内容在哪儿结束、下一个数据项从哪开始——' +
          '而 dex 的字符串数据区是一条挨着一条存的（每条是：uleb128 长度 + MUTF-8 字节 + 一个 0x00 结尾）。' +
          '长度就是用来"走一步"的。<br>' +
          '<span class="hit">这就是"索引定长、数据变长"这个设计的代价：索引区可以 O(1) 跳，' +
          '但进了数据区就必须顺序读长度、逐条前进。</span><br><br>' +
          '<b>四、最关键的一点：它存的不是字节数，是"UTF-16 码元个数"。</b>' +
          '纯 ASCII 时两者恰好相等（每个字符 1 码元、1 字节），所以很多人一直以为它存的是长度——' +
          '直到遇到中文才发现对不上。' +
          '比如"签名校验"：uleb128 里写的是 <b>4</b>（4 个 UTF-16 码元），' +
          '而它在文件里实打实占 <b>12</b> 个字节（MUTF-8 下每个汉字 3 字节）。' +
          '<b>如果有人按"长度 = 字节数"去读，指针立刻错位，后面所有字符串全部读串。</b>' +
          '这就是本章 3.7 的实验最后一问要你亲手算一遍的原因。<br><br>' +
          '<b>五、最后澄清一个常见误解：它不是加密。</b>' +
          'uleb128 是完全公开的标准编码，没有任何密钥，' +
          '而且解码后就是明文字符串。看到别人 dump 出来的 dex 里字符串"看起来是乱码"，' +
          '先想想是不是自己把长度前缀当成内容读进去了——' +
          '<span class="hit">"我没解析对"和"它被加密了"，是两种完全不同的问题。</span>'
      }
    ]
  }
};
