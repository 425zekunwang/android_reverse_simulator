/* ==========================================================================
   validate-missions.mjs —— 实战关卡引擎自检
   --------------------------------------------------------------------------
   实战关卡的产物是**现场生成的**：ELF 字节、算子表、logcat、shell 输出。
   这些东西错了不会在浏览器里报错，只会让玩家拿到一个自相矛盾的靶场。
   所以必须有一道无头校验 —— 和 validate-chapters.mjs 是同一个思路，
   只不过那边校验的是"数据长得对不对"，这边校验的是"仿真跑不跑得通"。

   本机通常没有 readelf，所以 ELF 的合法性在这里用**逐字段断言**验证
   （等价于 readelf -h / -S / -s 会检查的东西）；
   同时把生成的 .so 落盘，方便你用任何外部工具复核。

   用法：
     node validate-missions.mjs                 # 校验全部关卡
     node validate-missions.mjs m22-1           # 只校验指定关卡
     node validate-missions.mjs --quiet         # 只输出问题
     node validate-missions.mjs --dump <dir>    # 把生成的产物落盘
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');
const PRINT = args.includes('--print');
const dumpIdx = args.indexOf('--dump');
const DUMP = dumpIdx >= 0 ? args[dumpIdx + 1] : null;
const only = args.filter(a => /^m\d+-\d+$/.test(a));

/* ---------------------------------------------------------------- 报告 */
const problems = [];   // { level: 'error'|'warn', mission, msg }
const notes = [];
const err = (mission, msg) => problems.push({ level: 'error', mission, msg });
const warn = (mission, msg) => problems.push({ level: 'warn', mission, msg });
const note = msg => { notes.push(msg); if (!QUIET) console.log('  ' + msg); };
let checks = 0;
const ok = cond => { checks++; if (!cond) throw new Error('断言失败'); return true; };

/* ---------------------------------------------------------------- 沙箱 */
function makeSandbox() {
  const sb = { console };
  sb.TextEncoder = TextEncoder;
  sb.TextDecoder = TextDecoder;
  sb.window = sb;
  vm.createContext(sb);
  const run = f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f });
  run('assets/labs.js');                       // window.CRYPTO（真算法）
  run('assets/sim/simelf.js');                 // window.SIMELF
  run('assets/sim/simnative.js');              // window.SIMNATIVE（依赖 CRYPTO）
  run('assets/sim/simdevice.js');              // window.SIMDEVICE
  run('assets/sim/forge.js');                  // window.FORGE
  run('assets/sim/missions.js');               // window.SIM_MISSIONS
  return sb;
}

/* ------------------------------------------------------- ELF 结构断言 */
/* 这些断言一一对应 readelf 会读的字段。任何一条不过，生成的 .so 就是坏的。 */
function assertElf(mission, bytes) {
  const b = bytes;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const fail = m => { err(mission, 'ELF: ' + m); return false; };

  const size = b.length;

  /* --- 文件头 --- */
  if (!(b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46)) return fail('magic 不是 \\x7fELF');
  if (b[4] !== 2) return fail('EI_CLASS 应为 2(ELF64)，实际 ' + b[4]);
  if (b[5] !== 1) return fail('EI_DATA 应为 1(小端)，实际 ' + b[5]);
  if (b[6] !== 1) return fail('EI_VERSION 应为 1，实际 ' + b[6]);

  const e_type = dv.getUint16(16, true);
  const e_machine = dv.getUint16(18, true);
  const e_version = dv.getUint32(20, true);
  const e_phoff = Number(dv.getBigUint64(32, true));
  const e_shoff = Number(dv.getBigUint64(40, true));
  const e_ehsize = dv.getUint16(52, true);
  const e_phentsize = dv.getUint16(54, true);
  const e_phnum = dv.getUint16(56, true);
  const e_shentsize = dv.getUint16(58, true);
  const e_shnum = dv.getUint16(60, true);
  const e_shstrndx = dv.getUint16(62, true);

  if (e_type !== 3) return fail('e_type 应为 3(ET_DYN)，实际 ' + e_type);
  if (e_machine !== 0xb7) return fail('e_machine 应为 0xB7(AArch64)，实际 0x' + e_machine.toString(16));
  if (e_version !== 1) return fail('e_version 应为 1');
  if (e_ehsize !== 64) return fail('e_ehsize 应为 64，实际 ' + e_ehsize);
  if (e_phentsize !== 56) return fail('e_phentsize 应为 56，实际 ' + e_phentsize);
  if (e_shentsize !== 64) return fail('e_shentsize 应为 64，实际 ' + e_shentsize);
  if (e_phoff + e_phnum * e_phentsize > size) return fail('程序头表越界');
  if (e_shoff + e_shnum * e_shentsize > size) return fail('节头表越界（e_shoff=' + e_shoff + ' shnum=' + e_shnum + ' 文件=' + size + '）');
  if (e_shstrndx === 0 || e_shstrndx >= e_shnum) return fail('e_shstrndx 非法：' + e_shstrndx);

  /* --- 程序头 --- */
  for (let i = 0; i < e_phnum; i++) {
    const o = e_phoff + i * e_phentsize;
    const p_type = dv.getUint32(o, true);
    const p_offset = Number(dv.getBigUint64(o + 8, true));
    const p_vaddr = Number(dv.getBigUint64(o + 16, true));
    const p_filesz = Number(dv.getBigUint64(o + 32, true));
    const p_memsz = Number(dv.getBigUint64(o + 40, true));
    const p_align = Number(dv.getBigUint64(o + 48, true));
    if (p_type !== 1) { fail('程序头 ' + i + ' 不是 PT_LOAD'); continue; }
    if (p_offset % p_align !== p_vaddr % p_align) fail('程序头 ' + i + ' 的 p_offset/p_vaddr 不同余于 p_align（readelf 会认为段错位）');
    if (p_filesz > p_memsz) fail('程序头 ' + i + ' 的 p_filesz > p_memsz');
    if (p_offset + p_filesz > size) fail('程序头 ' + i + ' 越界');
  }

  /* --- 节头 --- */
  const secs = [];
  for (let i = 0; i < e_shnum; i++) {
    const o = e_shoff + i * e_shentsize;
    secs.push({
      i, nameOff: dv.getUint32(o, true), type: dv.getUint32(o + 4, true),
      flags: Number(dv.getBigUint64(o + 8, true)),
      addr: Number(dv.getBigUint64(o + 16, true)),
      offset: Number(dv.getBigUint64(o + 24, true)),
      size: Number(dv.getBigUint64(o + 32, true)),
      link: dv.getUint32(o + 40, true), info: dv.getUint32(o + 44, true),
      align: Number(dv.getBigUint64(o + 48, true)), entsize: Number(dv.getBigUint64(o + 56, true))
    });
  }
  const shstr = secs[e_shstrndx];
  if (shstr.offset + shstr.size > size) return fail('.shstrtab 越界');
  const cstr = (sec, off) => {
    let s = '';
    for (let i = sec.offset + off; i < sec.offset + sec.size && b[i] !== 0; i++) s += String.fromCharCode(b[i]);
    return s;
  };
  secs.forEach(s => { s.name = s.i === 0 ? '(NULL)' : cstr(shstr, s.nameOff); });

  const want = ['.text', '.rodata', '.dynstr', '.dynsym', '.strtab', '.symtab', '.shstrtab'];
  const got = secs.slice(1).map(s => s.name);
  for (const w of want) if (!got.includes(w)) fail('缺少节 ' + w + '（实际：' + got.join(',') + '）');
  if (secs[0].type !== 0) fail('第 0 节必须是 SHT_NULL');

  const byName = {};
  secs.forEach(s => { byName[s.name] = s; });

  /* 每个节的越界与对齐 */
  secs.forEach(s => {
    if (s.type === 0) return;
    if (s.offset + s.size > size) fail('节 ' + s.name + ' 越界');
    if (s.align > 1 && s.offset % s.align !== 0) fail('节 ' + s.name + ' 没有按 sh_addralign=' + s.align + ' 对齐');
    if (s.flags & 0x2) {  /* SHF_ALLOC */
      if (s.addr !== s.offset) fail('节 ' + s.name + ' 是 ALLOC，生成时要求 sh_addr === sh_offset');
    } else if (s.addr !== 0) fail('节 ' + s.name + ' 非 ALLOC，sh_addr 应为 0');
  });

  /* 符号表链接 */
  if (byName['.dynsym'].entsize !== 24) fail('.dynsym 的 sh_entsize 应为 24');
  if (secs[byName['.dynsym'].link].name !== '.dynstr') fail('.dynsym 的 sh_link 应指向 .dynstr');
  if (byName['.dynsym'].size % 24 !== 0) fail('.dynsym 大小不是 24 的整数倍');
  if (byName['.dynsym'].info !== 1) fail('.dynsym 的 sh_info 应为 1（首个全局符号下标）');
  if (byName['.symtab'].entsize !== 24) fail('.symtab 的 sh_entsize 应为 24');
  if (secs[byName['.symtab'].link].name !== '.strtab') fail('.symtab 的 sh_link 应指向 .strtab');

  /* 符号逐个解析 */
  function readSyms(secName, strName) {
    const sec = byName[secName], str = byName[strName], out = [];
    for (let o = sec.offset; o < sec.offset + sec.size; o += sec.entsize) {
      const info = b[o + 4];
      const shndx = dv.getUint16(o + 6, true);
      out.push({
        name: cstr(str, dv.getUint32(o, true)),
        bind: info >> 4, type: info & 0xf, shndx,
        value: Number(dv.getBigUint64(o + 8, true)),
        size: Number(dv.getBigUint64(o + 16, true)),
        secName: shndx < secs.length ? secs[shndx].name : '(越界)'
      });
    }
    return out;
  }
  const dyn = readSyms('.dynsym', '.dynstr');
  if (!dyn.length) return fail('.dynsym 里一个符号都没有');
  if (dyn[0].name !== '' || dyn[0].value !== 0) fail('.dynsym[0] 必须是全零的空符号');
  const named = dyn.filter(s => s.name);
  if (!named.length) fail('.dynsym 里没有具名符号');
  named.forEach(s => {
    if (s.shndx >= secs.length) fail('符号 ' + s.name + ' 的 st_shndx 越界：' + s.shndx);
    if (s.value < byName[s.secName].offset || s.value >= byName[s.secName].offset + byName[s.secName].size)
      fail('符号 ' + s.name + ' 的 st_value 落在 ' + s.secName + ' 之外');
  });
  const sym = readSyms('.symtab', '.strtab');
  if (sym.filter(s => s.name).length !== named.length) warn(mission, '.symtab 与 .dynsym 的具名符号个数不一致');

  return true;
}

/* ------------------------------------------------- readelf 等价视图 */
/* 本机常常没有 readelf，所以由校验器自己把生成物"读"一遍并打印出来。
   它读的是原始字节，不经过 SIMELF.parse —— 与生成器独立。 */
function printElf(bytes, label) {
  const b = bytes;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const hex = n => '0x' + Number(n).toString(16);
  console.log('\n──────── ' + label + '（readelf 等价视图，' + b.length + ' 字节）────────');

  const secOff = Number(dv.getBigUint64(40, true));
  const shnum = dv.getUint16(60, true);
  const shent = dv.getUint16(58, true);
  const shstrndx = dv.getUint16(62, true);
  const secOf = i => {
    const o = secOff + i * shent;
    return {
      nameOff: dv.getUint32(o, true), type: dv.getUint32(o + 4, true),
      flags: Number(dv.getBigUint64(o + 8, true)),
      addr: Number(dv.getBigUint64(o + 16, true)),
      offset: Number(dv.getBigUint64(o + 24, true)),
      size: Number(dv.getBigUint64(o + 32, true)),
      link: dv.getUint32(o + 40, true), info: dv.getUint32(o + 44, true),
      align: Number(dv.getBigUint64(o + 48, true)), entsize: Number(dv.getBigUint64(o + 56, true))
    };
  };
  const shstr = secOf(shstrndx);
  const cstr = (sec, off) => {
    let s = '';
    for (let i = sec.offset + off; i < sec.offset + sec.size && b[i] !== 0; i++) s += String.fromCharCode(b[i]);
    return s;
  };
  const secName = i => i === 0 ? '' : cstr(shstr, secOf(i).nameOff);
  const idxOf = name => { for (let i = 1; i < shnum; i++) if (secName(i) === name) return i; return -1; };
  const TYPE = { 0: 'NULL', 1: 'PROGBITS', 2: 'SYMTAB', 3: 'STRTAB', 4: 'RELA', 8: 'NOBITS', 11: 'DYNSYM' };

  console.log('\nELF 头:');
  console.log('  Class:      ELF64');
  console.log('  Data:       2\'s complement, little endian');
  console.log('  Type:       ' + (dv.getUint16(16, true) === 3 ? 'DYN (共享对象文件)' : dv.getUint16(16, true)));
  console.log('  Machine:    ' + (dv.getUint16(18, true) === 0xb7 ? 'AArch64' : hex(dv.getUint16(18, true))));
  console.log('  Entry:      ' + hex(dv.getBigUint64(24, true)));
  console.log('  Start of program headers: ' + Number(dv.getBigUint64(32, true)) + ' (' + dv.getUint16(56, true) + ' 项, 每项 ' + dv.getUint16(54, true) + ' 字节)');
  console.log('  Start of section headers: ' + secOff + ' (' + shnum + ' 项, 每项 ' + shent + ' 字节)');
  console.log('  Section header string table index: ' + shstrndx);

  console.log('\n节头:');
  console.log('  [Nr] Name              Type       Address   Off    Size   Flags  Align');
  for (let i = 0; i < shnum; i++) {
    const s = secOf(i);
    const fl = [];
    if (s.flags & 0x2) fl.push('A');
    if (s.flags & 0x4) fl.push('X');
    if (s.flags & 0x1) fl.push('W');
    console.log('  [' + String(i).padStart(2) + '] ' +
      secName(i).padEnd(17) + (TYPE[s.type] || s.type).padEnd(11) +
      hex(s.addr).padEnd(10) + hex(s.offset).padEnd(7) + hex(s.size).padEnd(7) +
      (fl.join('') || '-').padEnd(7) + String(s.align));
  }

  console.log('\n符号表 (.dynsym):');
  console.log('  Num  Value      Size  Bind     Type    Ndx Name');
  function syms(secIdx, strIdx, tag) {
    const sec = secOf(secIdx), str = secOf(strIdx);
    for (let o = sec.offset, n = 0; o < sec.offset + sec.size; o += sec.entsize, n++) {
      const info = b[o + 4];
      const bind = ['LOCAL', 'GLOBAL', 'WEAK'][info >> 4] || '?';
      const type = ['NOTYPE', 'OBJECT', 'FUNC', 'SECTION', 'FILE'][info & 0xf] || '?';
      const ndx = dv.getUint16(o + 6, true);
      const name = cstr(str, dv.getUint32(o, true));
      console.log('  ' + String(n).padStart(3) + '  ' + hex(dv.getBigUint64(o + 8, true)).padEnd(10) +
        String(Number(dv.getBigUint64(o + 16, true))).padEnd(6) + bind.padEnd(9) + type.padEnd(8) +
        String(ndx).padEnd(4) + (name || '(空符号)'));
    }
  }
  syms(idxOf('.dynsym'), idxOf('.dynstr'), '.dynsym');
  console.log('\n符号表 (.symtab):');
  console.log('  Num  Value      Size  Bind     Type    Ndx Name');
  syms(idxOf('.symtab'), idxOf('.strtab'), '.symtab');

  console.log('\n.rodata 内容（前 48 字节）:');
  const ro = secOf(idxOf('.rodata'));
  console.log('  ' + hex(ro.addr) + ': ' +
    Array.from(b.subarray(ro.offset, ro.offset + Math.min(48, ro.size)))
      .map(x => x.toString(16).padStart(2, '0')).join(' '));
}

/* ---------------------------------------------------------------- 主流程 */
const sb = makeSandbox();
const MISSIONS = sb.SIM_MISSIONS_LIST || [];
const targets = only.length ? MISSIONS.filter(m => only.includes(m.id)) : MISSIONS;

if (!targets.length) {
  console.error('没有找到要校验的关卡' + (only.length ? '：' + only.join(', ') : ''));
  process.exit(1);
}

const L = m => '[' + m.id + ']';
const autosolveSeeds = [2201, 1, 77777, 999999];

for (const mission of targets) {
  if (!QUIET) console.log('\n' + L(mission) + ' ' + mission.title);

  /* ---------- ① 确定性：同 seed 逐字节相同 ---------- */
  try {
    const a1 = sb.FORGE.build(mission.spec, mission.spec && 2201);
    const a2 = sb.FORGE.build(mission.spec, 2201);
    const p1 = a1.public.soPath;
    const b1 = a1.images[p1], b2 = a2.images[p1];
    ok(b1.length === b2.length && b1.every((v, i) => v === b2[i]));
    note('① 确定性：同 seed 两次生成，映像 ' + b1.length + ' 字节逐字节一致');
  } catch (e) { err(mission.id, '① 确定性检查失败：' + e.message); }

  /* ---------- ② ELF 结构 ---------- */
  let art = null;
  try {
    art = sb.FORGE.build(mission.spec, 2201);
    const p = art.public.soPath;
    assertElf(mission.id, art.images[p]);
    /* 与 SIMELF.parse 自身往返一致 */
    const parsed = sb.SIMELF.parse(art.images[p]);
    ok(parsed.ok === true);
    ok(parsed.header.type === 3 && parsed.header.machine === 0xb7);
    note('② ELF 结构：' + art.images[p].length + ' 字节，' +
         parsed.sections.length + ' 节，' + parsed.dynsyms.length + ' 个动态符号，' +
         '段表 ' + parsed.phdrs.length + ' 项 —— 全部断言通过');
    if (PRINT) printElf(art.images[p], mission.id + ' · ' + mission.title);
  } catch (e) { err(mission.id, '② ELF 结构检查失败：' + e.message); }

  /* ---------- ③ 设备 + shell 端到端 ---------- */
  try {
    const dev = sb.SIMDEVICE.boot(art.world, art.imgs);
    ok(dev.meta.abi === 'arm64-v8a');

    /* 未知命令必须明确报错，不能静默成功 */
    const bad = dev.shell('reboot bootloader');
    ok(bad.code === 127 && /未知命令/.test(bad.err));

    /* 参考解法要用的命令，逐条真的执行 */
    let last = null;
    for (const line of mission.reference.walkthrough) {
      last = dev.shell(line);
      if (last.code !== 0) { err(mission.id, '③ shell 命令失败：「' + line + '」→ ' + last.err); }
    }

    /* strings 必须真的从字节里扫出 .dynstr 的符号名，而不是别的什么 */
    const sy = dev.shell('strings ' + art.public.soPath);
    if (!/JNI_OnLoad/.test(sy.out) || !/Native_check/.test(sy.out) || !/g_const/.test(sy.out)) {
      err(mission.id, '③ strings 没能从映像里扫出符号名（输出：' + JSON.stringify(sy.out.slice(0, 120)) + '）');
    }
    /* hexdump 必须真的按给定偏移输出 */
    const hd = dev.shell('hexdump ' + art.public.soPath + ' 0x1000 16');
    if (!/^00001000\s/.test(hd.out)) {
      err(mission.id, '③ hexdump 没有按偏移 0x1000 输出（输出首行：' + JSON.stringify(hd.out.split('\n')[0]) + '）');
    }

    /* am start 之后，logcat 里必须出现真算出来的摘要 */
    const lc = dev.shell('logcat -s ' + (mission.spec.app.logTag || 'Native'));
    ok(lc.code === 0);
    const mm = /digest = ([0-9a-f]{32})/.exec(lc.out) || /([0-9a-f]{32})/.exec(lc.out);
    if (!mm) err(mission.id, '③ logcat 里没有出现 32 位十六进制摘要');
    else {
      /* ★ 关键保真断言：logcat 里的值必须是"真的算出来的" */
      const truthIv = art.truth.ivWords;
      const want = sb.CRYPTO.toHex(sb.CRYPTO.md5(art.truth.appInput, { iv: truthIv }));
      if (mm[1] !== want) err(mission.id, '③ logcat 摘要与独立复算不一致（logcat=' + mm[1] + ' 复算=' + want + '）—— 说明不是真执行');
      else note('③ 设备端到端：' + mission.reference.walkthrough.length + ' 条命令全部执行，logcat 摘要经独立复算一致（真执行，非回放）');
    }

    /* ★ 改映像必须真的改变结果（证明执行是真读内存的） */
    const art2 = sb.FORGE.build(mission.spec, 2201);
    const img2 = art2.imgs[art2.public.soPath];
    const constAddr = img2.rodataAddr + art2.truth.constOffset;
    const before = img2.call(art2.truth.op, art2.truth.appInput);
    ok(img2.patch(constAddr, new Uint8Array([0xde, 0xad, 0xbe, 0xef])));
    const after = img2.call(art2.truth.op, art2.truth.appInput);
    if (before === after) err(mission.id, '③ patch .rodata 之后结果没变 —— 说明样例是写死的，不是真算');
    else note('   · 改 4 字节 .rodata → 摘要跟着变，确认执行路径真读内存');

    /* 落盘，供外部 readelf 复核 */
    if (DUMP) {
      fs.mkdirSync(DUMP, { recursive: true });
      fs.writeFileSync(path.join(DUMP, mission.id + '-libtarget.so'), Buffer.from(art.images[art.public.soPath]));
    }
  } catch (e) { err(mission.id, '③ 设备端到端检查失败：' + e.message); }

  /* ---------- ④ 官方参考解法通关 ---------- */
  try {
    const sol = mission.reference.solve(art);
    ok(Array.isArray(sol.words) && sol.words.length === 4);

    /* 参考解法只用公开数据；这里额外断言它确实"猜对了"标准 IV 的 3 个字 */
    if (sol.matchedStandardWords !== 3) {
      warn(mission.id, '④ 参考解法只对上了 ' + sol.matchedStandardWords + ' 个标准 IV 字（预期 3：恰好改 1 个）');
    }

    const r = mission.objective.run(sol.words, art);
    if (!r.ok) err(mission.id, '④ 参考解法没能通关：' + r.detail);
    else note('④ 参考解法：常量扫描命中 .rodata 偏移 0x' + sol.rodataOff.toString(16) +
              '，8 组向量对拍通过 —— ' + r.detail);
  } catch (e) { err(mission.id, '④ 参考解法检查失败：' + e.message); }

  /* ---------- ⑤ 反例：错的答案必须被拒 ---------- */
  try {
    const truth = art.truth.ivWords.slice();
    const wrong = truth.slice(); wrong[0] = (wrong[0] ^ 1) >>> 0;
    const r = mission.objective.run(wrong, art);
    if (r.ok) err(mission.id, '⑤ 只改了 1 位的错误答案竟然通过了 —— 对拍是假的');
    else note('   · 反例检查：改 1 位的答案被正确拒绝（' + r.detail + '）');

    if (mission.objective.parse({ w0: 'zz', w1: '0', w2: '0', w3: '0' }) !== null) {
      err(mission.id, '⑤ objective.parse 接受了非法十六进制输入');
    }
    ok(mission.objective.parse({ w0: '67452301', w1: 'efcdab89', w2: '98badcfe', w3: '10325476' }) !== null);
  } catch (e) { err(mission.id, '⑤ 反例检查失败：' + e.message); }

  /* ---------- ⑥ 换 seed 仍然可解（答案不是写死的） ---------- */
  try {
    const seen = new Set();
    for (const s of autosolveSeeds) {
      const a = sb.FORGE.build(mission.spec, s);
      const sol = mission.reference.solve(a);
      const r = mission.objective.run(sol.words, a);
      if (!r.ok) { err(mission.id, '⑥ seed=' + s + ' 无法通关：' + r.detail); continue; }
      /* 顺带确认不同 seed 真的产出不同答案 */
      seen.add(a.truth.ivWords.join(','));
      /* 而这个 seed 的答案，放在别的 seed 的靶场上必须通不过 */
      if (s !== autosolveSeeds[0]) {
        const other = sb.FORGE.build(mission.spec, autosolveSeeds[0]);
        if (mission.objective.run(sol.words, other).ok) {
          err(mission.id, '⑥ seed=' + s + ' 的答案在 seed=' + autosolveSeeds[0] + ' 的靶场上也通过了 —— 判定没有跟着靶场走');
        }
      }
    }
    if (seen.size < autosolveSeeds.length) {
      err(mission.id, '⑥ 不同 seed 产出了相同答案（' + seen.size + '/' + autosolveSeeds.length + ' 种）—— 派生器没有真的用 seed');
    } else {
      note('⑥ 跨 seed：' + autosolveSeeds.length + ' 个种子全部可解，且答案各不相同、互不通用');
    }
  } catch (e) { err(mission.id, '⑥ 跨 seed 检查失败：' + e.message); }
}

/* ------------------------------------------------- ⑦ 章节交接卡 ↔ 关卡定义 */
/* 章节里的 lab.mission 是工单的"正门"，missions.js 里的定义是工单本体。
   两边靠 id 对齐、靠 title 保持一致；任何一边改了另一边没跟上，玩家就会
   看到一张指向不存在工单的卡片，或者一个谁也找不到入口的孤儿工单。

   ★ 章节文件依赖 DOM，不能丢进 vm 执行 —— 这里只扫源码文本。
     块用带字符串状态的括号配对切出来，免得 line 文案里的花括号把块切歪。 */
const DEFS = sb.SIM_MISSIONS || {};
const cards = [];             // { file, line, id, title }
let crossBad = 0;             // 本组问题数：为 0 才敢说"全部对得上"

function scanCards(file, src) {
  const head = /mission\s*:\s*/g;
  let hit;
  while ((hit = head.exec(src))) {
    let i = head.lastIndex;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '{') continue;                 /* 注释里提到 mission: 的不算卡片 */
    let depth = 0, end = -1, q = null;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      if (q) {
        if (c === '\\') { j++; continue; }        /* 跳过字符串里的转义字符 */
        if (c === q) q = null;
      } else if (c === '"' || c === "'" || c === '`') q = c;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { end = j; break; }
    }
    if (end < 0) { err(file, 'mission: 的花括号没有配对，交接卡被截断'); crossBad++; break; }
    head.lastIndex = end + 1;

    const block = src.slice(i, end + 1);
    /* id / title 取块里最先出现的那一次 —— 约定写在 line 文案之前 */
    const im = /\bid\s*:\s*(['"])([\s\S]*?)\1/.exec(block);
    const tm = /\btitle\s*:\s*(['"])([\s\S]*?)\1/.exec(block);
    if (!im) { err(file, 'mission 块里没有 id，交接卡不知道该指向哪张工单'); crossBad++; continue; }
    cards.push({ file, line: src.slice(0, i).split('\n').length, id: im[2], title: tm ? tm[2] : null });
  }
}

try {
  const dir = path.join(ROOT, 'chapters');
  for (const f of fs.readdirSync(dir).filter(f => /\.js$/.test(f)).sort()) {
    scanCards('chapters/' + f, fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  /* ① 卡片 → 工单：引用的 id 必须真的存在 */
  const refs = {};                              // id → [卡片, ...]
  for (const c of cards) (refs[c.id] = refs[c.id] || []).push(c);
  const where = c => c.file + ':' + c.line;
  for (const id of Object.keys(refs)) {
    if (DEFS[id]) continue;
    err(refs[id][0].file, '第 ' + refs[id][0].line + ' 行的交接卡引用的工单 id「' + id + '」在 SIM_MISSIONS 里不存在（打错字，或工单被删了）');
    crossBad++;
  }

  /* ② 一个工单只能有一张交接卡（一个正门） */
  for (const id of Object.keys(refs)) {
    if (refs[id].length < 2) continue;
    for (let i = 1; i < refs[id].length; i++) {
      const dup = refs[id][i];
      err(dup.file, '第 ' + dup.line + ' 行的交接卡和 ' + refs[id].slice(0, i).map(where).join('、') +
          ' 引用了同一个工单「' + id + '」—— 一个工单只能有一个正门');
      crossBad++;
    }
  }

  /* ③ 工单 → 卡片：没人引用的工单等于没有入口 */
  for (const m of MISSIONS) {
    if (refs[m.id]) continue;
    err(m.id, '没有任何章节交接卡指向「' + m.title + '」—— 玩家找不到入口（孤儿工单）');
    crossBad++;
  }

  /* ④ 标题漂移：两边文案不一致，玩家会看到两个名字 */
  for (const c of cards) {
    const def = DEFS[c.id];
    if (!def) continue;                          /* id 不存在已由 ① 报过 */
    if (c.title === null) { warn(c.file, '第 ' + c.line + ' 行的交接卡没写 title，无法与工单定义核对'); crossBad++; continue; }
    if (c.title !== def.title) {
      warn(c.file, '第 ' + c.line + ' 行的交接卡标题「' + c.title + '」与工单定义「' + def.title + '」不一致 —— 两边文案会漂移');
      crossBad++;
    }
  }

  if (!crossBad) {
    note('⑦ 章节交接卡：' + MISSIONS.length + ' 个工单，' + cards.length + ' 张卡片，id 与标题全部对得上');
  }
} catch (e) { err('chapters', '⑦ 章节交接卡检查失败：' + e.message); }

/* ---------------------------------------------------------------- 汇总 */
if (!QUIET) console.log('');
const errors = problems.filter(p => p.level === 'error');
const warns = problems.filter(p => p.level === 'warn');
for (const p of problems) {
  console.log((p.level === 'error' ? '✗ ' : '⚠ ') + '[' + p.mission + '] ' + p.msg);
}
console.log('校验 ' + targets.length + ' 个关卡，' + checks + ' 条断言：' +
            errors.length + ' 个错误，' + warns.length + ' 个警告');
const cardIds = new Set(cards.map(c => c.id));
const covered = MISSIONS.filter(m => cardIds.has(m.id)).length;
console.log('交接卡覆盖率：' + covered + '/' + MISSIONS.length + ' 个工单有章节入口（' + cards.length + ' 张卡片）');
if (DUMP) console.log('产物已落盘：' + DUMP + '（可用 readelf -h / -S / -s 复核）');
process.exit(errors.length ? 1 : 0);
