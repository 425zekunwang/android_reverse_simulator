/* ==========================================================================
   SimELF —— 真 ELF64 的生成与解析（AArch64 / ET_DYN / 小端）
   --------------------------------------------------------------------------
   实战关卡里的 libtarget.so 由本模块现场生成。它是一份**结构合法的 ELF64**：
   外部工具（readelf -h / readelf -S / readelf -s）能正常读出。

   ⚠ 诚实边界（见 PRACTICE-SPEC.md §5.3）：
     .text 里放的**不是可执行 ARM 指令**，而是「算子表」——
     一个 {算子ID → .rodata 偏移, 参数个数} 的映射。
     本模块**不反汇编 ARM**，也永远不要声称它能。

   挂到 window.SIMELF
   ========================================================================== */
(function (global) {
  'use strict';

  const EHDR = 64, PHDR = 56, SHDR = 64, SYM = 24;
  const EM_AARCH64 = 0xb7;
  const PAGE = 0x1000;

  const SHT = { NULL: 0, PROGBITS: 1, SYMTAB: 2, STRTAB: 3, DYNSYM: 11 };
  const SHF = { ALLOC: 0x2, EXEC: 0x4 };
  const STB = { LOCAL: 0, GLOBAL: 1 };
  const STT = { NOTYPE: 0, OBJECT: 1, FUNC: 2 };
  const PT = { LOAD: 1 };

  /* 段索引固定，解析与生成共用一张表 */
  const SEC_ORDER = ['.text', '.rodata', '.dynstr', '.dynsym', '.strtab', '.symtab', '.shstrtab'];
  const SEC_INDEX = { '.text': 1, '.rodata': 2, '.dynstr': 3, '.dynsym': 4, '.strtab': 5, '.symtab': 6, '.shstrtab': 7 };

  const enc = s => new TextEncoder().encode(s);
  const align = (n, a) => Math.ceil(n / a) * a;

  /* ---------------- 字符串表：去重、返回 name → offset ---------------- */
  function makeStrtab(names) {
    const parts = [new Uint8Array([0])];
    let size = 1;
    const off = {};
    for (const n of names) {
      if (off[n] !== undefined) continue;
      off[n] = size;
      const b = enc(n + '\0');
      parts.push(b);
      size += b.length;
    }
    const bytes = new Uint8Array(size);
    let p = 0;
    for (const b of parts) { bytes.set(b, p); p += b.length; }
    return { bytes, off };
  }

  /* ======================================================================
     生成
     spec = {
       text:   Uint8Array,                                     // 算子表字节
       rodata: Uint8Array,                                     // 常量区
       symbols: [{ name, section: '.text'|'.rodata', off, size, type }]
     }
     ====================================================================== */
  function build(spec) {
    const text = spec.text || new Uint8Array(0);
    const rodata = spec.rodata || new Uint8Array(0);
    const symbols = (spec.symbols || []).slice();

    /* ---- 字符串表 ---- */
    const symNames = ['', ...symbols.map(s => s.name)];
    const dynstr = makeStrtab(symNames);
    const strtab = makeStrtab(symNames);
    const shstr = makeStrtab(SEC_ORDER);

    /* ---- 布局 ---- */
    const phnum = 2;
    const textOff = EHDR + phnum * PHDR;
    const textEnd = textOff + text.length;
    const rodataOff = align(textEnd, PAGE);              // 第二段起点，页对齐
    const rodataEnd = rodataOff + rodata.length;
    const dynstrOff = align(rodataEnd, 8);
    const dynsymOff = align(dynstrOff + dynstr.bytes.length, 8);
    const symCount = symbols.length + 1;                 // +1 个空符号
    const dynsymSize = symCount * SYM;
    const seg2End = align(dynsymOff + dynsymSize, 8);
    const strtabOff = align(seg2End, 8);
    const symtabOff = align(strtabOff + strtab.bytes.length, 8);
    const symtabSize = symCount * SYM;
    const shstrOff = align(symtabOff + symtabSize, 8);
    const shoff = align(shstrOff + shstr.bytes.length, 8);
    const shnum = SEC_ORDER.length + 1;                  // +1 个 NULL 节
    const total = shoff + shnum * SHDR;

    const buf = new Uint8Array(total);
    const dv = new DataView(buf.buffer);
    const u16 = (o, v) => dv.setUint16(o, v, true);
    const u32 = (o, v) => dv.setUint32(o, v, true);
    const u64 = (o, v) => dv.setBigUint64(o, BigInt(v), true);

    /* ---- ELF header ---- */
    buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46;   // \x7fELF
    buf[4] = 2;      // EI_CLASS  = ELFCLASS64
    buf[5] = 1;      // EI_DATA   = ELFDATA2LSB
    buf[6] = 1;      // EI_VERSION
    buf[7] = 0;      // EI_OSABI  = SYSV
    u16(16, 3);                       // e_type = ET_DYN
    u16(18, EM_AARCH64);              // e_machine
    u32(20, 1);                       // e_version
    u64(24, 0);                       // e_entry
    u64(32, EHDR);                    // e_phoff
    u64(40, shoff);                   // e_shoff
    u32(48, 0);                       // e_flags
    u16(52, EHDR);
    u16(54, PHDR);
    u16(56, phnum);
    u16(58, SHDR);
    u16(60, shnum);
    u16(62, SEC_INDEX['.shstrtab']);

    /* ---- program headers ---- */
    // #1 R|X：ELF 头 + 程序头 + .text
    let p = EHDR;
    u32(p + 0, PT.LOAD); u32(p + 4, 5);
    u64(p + 8, 0); u64(p + 16, 0); u64(p + 24, 0);
    u64(p + 32, PAGE); u64(p + 40, PAGE); u64(p + 48, PAGE);
    // #2 R：.rodata + .dynstr + .dynsym
    p += PHDR;
    u32(p + 0, PT.LOAD); u32(p + 4, 4);
    u64(p + 8, rodataOff); u64(p + 16, rodataOff); u64(p + 24, rodataOff);
    u64(p + 32, seg2End - rodataOff); u64(p + 40, seg2End - rodataOff); u64(p + 48, PAGE);

    /* ---- 节内容 ---- */
    buf.set(text, textOff);
    buf.set(rodata, rodataOff);
    buf.set(dynstr.bytes, dynstrOff);
    buf.set(strtab.bytes, strtabOff);
    buf.set(shstr.bytes, shstrOff);

    /* ---- 符号表（.dynsym 与 .symtab 同构） ---- */
    // 值 = 节偏移 + 节内偏移；因为生成时 sh_addr === sh_offset，所以段内地址就等于文件偏移
    const secBase = { '.text': textOff, '.rodata': rodataOff };
    const symBuf = new Uint8Array(symtabSize);
    const sdv = new DataView(symBuf.buffer);
    symbols.forEach((s, i) => {
      const o = (i + 1) * SYM;
      sdv.setUint32(o + 0, dynstr.off[s.name] || 0, true);
      sdv.setUint8(o + 4, ((s.bind === undefined ? STB.GLOBAL : s.bind) << 4) | (s.type === undefined ? STT.FUNC : s.type));
      sdv.setUint8(o + 5, 0);
      sdv.setUint16(o + 6, SEC_INDEX[s.section] || 0, true);
      sdv.setBigUint64(o + 8, BigInt((secBase[s.section] || 0) + (s.off || 0)), true);
      sdv.setBigUint64(o + 16, BigInt(s.size || 0), true);
    });
    buf.set(symBuf, dynsymOff);
    buf.set(symBuf, symtabOff);

    /* ---- 节头表 ---- */
    const sh = new Uint8Array(shnum * SHDR);
    const v = new DataView(sh.buffer);
    const put = (i, o) => {
      const b = i * SHDR;
      v.setUint32(b + 0, o.name || 0, true);
      v.setUint32(b + 4, o.type || 0, true);
      v.setBigUint64(b + 8, BigInt(o.flags || 0), true);
      v.setBigUint64(b + 16, BigInt(o.addr || 0), true);
      v.setBigUint64(b + 24, BigInt(o.offset || 0), true);
      v.setBigUint64(b + 32, BigInt(o.size || 0), true);
      v.setUint32(b + 40, o.link || 0, true);
      v.setUint32(b + 44, o.info || 0, true);
      v.setBigUint64(b + 48, BigInt(o.align || 1), true);
      v.setBigUint64(b + 56, BigInt(o.entsize || 0), true);
    };
    put(0, {});                                                              // NULL
    put(1, { name: shstr.off['.text'], type: SHT.PROGBITS, flags: SHF.ALLOC | SHF.EXEC,
             addr: textOff, offset: textOff, size: text.length, align: 16 });
    put(2, { name: shstr.off['.rodata'], type: SHT.PROGBITS, flags: SHF.ALLOC,
             addr: rodataOff, offset: rodataOff, size: rodata.length, align: 16 });
    put(3, { name: shstr.off['.dynstr'], type: SHT.STRTAB, flags: SHF.ALLOC,
             addr: dynstrOff, offset: dynstrOff, size: dynstr.bytes.length, align: 1 });
    put(4, { name: shstr.off['.dynsym'], type: SHT.DYNSYM, flags: SHF.ALLOC,
             addr: dynsymOff, offset: dynsymOff, size: dynsymSize,
             link: SEC_INDEX['.dynstr'], info: 1, align: 8, entsize: SYM });
    put(5, { name: shstr.off['.strtab'], type: SHT.STRTAB,
             offset: strtabOff, size: strtab.bytes.length, align: 1 });
    put(6, { name: shstr.off['.symtab'], type: SHT.SYMTAB,
             offset: symtabOff, size: symtabSize,
             link: SEC_INDEX['.strtab'], info: 1, align: 8, entsize: SYM });
    put(7, { name: shstr.off['.shstrtab'], type: SHT.STRTAB,
             offset: shstrOff, size: shstr.bytes.length, align: 1 });
    buf.set(sh, shoff);

    return buf;
  }

  /* ======================================================================
     解析
     ====================================================================== */
  function parse(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);

    if (!(b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46)) {
      return { ok: false, err: '不是 ELF 文件（magic 不匹配）' };
    }
    const cls = b[4], dat = b[5];
    if (cls !== 2) return { ok: false, err: '只支持 ELF64（EI_CLASS=' + cls + '）' };
    if (dat !== 1) return { ok: false, err: '只支持小端（EI_DATA=' + dat + '）' };

    const header = {
      type: dv.getUint16(16, true),
      machine: dv.getUint16(18, true),
      version: dv.getUint32(20, true),
      entry: Number(dv.getBigUint64(24, true)),
      phoff: Number(dv.getBigUint64(32, true)),
      shoff: Number(dv.getBigUint64(40, true)),
      flags: dv.getUint32(48, true),
      ehsize: dv.getUint16(52, true),
      phentsize: dv.getUint16(54, true),
      phnum: dv.getUint16(56, true),
      shentsize: dv.getUint16(58, true),
      shnum: dv.getUint16(60, true),
      shstrndx: dv.getUint16(62, true)
    };
    header.typeName = header.type === 3 ? 'DYN (共享对象)' : header.type === 2 ? 'EXEC (可执行)' : header.type === 1 ? 'REL (可重定位)' : '未知';
    header.machineName = header.machine === EM_AARCH64 ? 'AArch64' : ('0x' + header.machine.toString(16));

    /* ---- 程序头 ---- */
    const phdrs = [];
    for (let i = 0; i < header.phnum; i++) {
      const o = header.phoff + i * header.phentsize;
      phdrs.push({
        type: dv.getUint32(o, true),
        typeName: dv.getUint32(o, true) === PT.LOAD ? 'LOAD' : ('0x' + dv.getUint32(o, true).toString(16)),
        flags: dv.getUint32(o + 4, true),
        offset: Number(dv.getBigUint64(o + 8, true)),
        vaddr: Number(dv.getBigUint64(o + 16, true)),
        filesz: Number(dv.getBigUint64(o + 32, true)),
        memsz: Number(dv.getBigUint64(o + 40, true)),
        align: Number(dv.getBigUint64(o + 48, true))
      });
    }

    /* ---- 节头 ---- */
    const raw = [];
    for (let i = 0; i < header.shnum; i++) {
      const o = header.shoff + i * header.shentsize;
      raw.push({
        nameOff: dv.getUint32(o, true),
        type: dv.getUint32(o + 4, true),
        flags: Number(dv.getBigUint64(o + 8, true)),
        addr: Number(dv.getBigUint64(o + 16, true)),
        offset: Number(dv.getBigUint64(o + 24, true)),
        size: Number(dv.getBigUint64(o + 32, true)),
        link: dv.getUint32(o + 40, true),
        info: dv.getUint32(o + 44, true),
        align: Number(dv.getBigUint64(o + 48, true)),
        entsize: Number(dv.getBigUint64(o + 56, true))
      });
    }
    const shstrSec = raw[header.shstrndx];
    const cstr = (sec, off) => {
      if (!sec || off >= sec.size) return '';
      let s = '';
      for (let i = sec.offset + off; i < sec.offset + sec.size && b[i] !== 0; i++) s += String.fromCharCode(b[i]);
      return s;
    };
    const sections = raw.map((r, i) => ({
      index: i,
      name: i === 0 ? '(NULL)' : cstr(shstrSec, r.nameOff),
      type: r.type, flags: r.flags, addr: r.addr, offset: r.offset, size: r.size,
      link: r.link, info: r.info, align: r.align, entsize: r.entsize
    }));

    /* ---- 符号 ---- */
    function symsOf(secIdx, strSecIdx) {
      const sec = sections[secIdx], str = sections[strSecIdx];
      if (!sec || !str || !sec.entsize) return [];
      const out = [];
      for (let o = sec.offset; o + SYM <= sec.offset + sec.size; o += sec.entsize) {
        const info = b[o + 4];
        out.push({
          name: cstr(str, dv.getUint32(o, true)),
          info, bind: info >> 4, type: info & 0xf,
          shndx: dv.getUint16(o + 6, true),
          value: Number(dv.getBigUint64(o + 8, true)),
          size: Number(dv.getBigUint64(o + 16, true)),
          section: (sections[dv.getUint16(o + 6, true)] || {}).name || ''
        });
      }
      return out;
    }

    return {
      ok: true,
      bytes: b,
      header, phdrs, sections,
      dynsyms: symsOf(SEC_INDEX['.dynsym'], SEC_INDEX['.dynstr']).filter(s => s.name),
      syms: symsOf(SEC_INDEX['.symtab'], SEC_INDEX['.strtab']).filter(s => s.name),
      /* 一段数据在映像里的真实字节（按文件偏移，因为生成时 addr === offset） */
      read(addr, n) { return b.subarray(addr, addr + n); },
      section(name) { return sections.find(s => s.name === name) || null; }
    };
  }

  global.SIMELF = {
    build, parse,
    EHDR, PHDR, SHDR, SYM, PAGE,
    SHT, SHF, STB, STT, PT,
    EM_AARCH64, SEC_ORDER, SEC_INDEX
  };
})(window);
