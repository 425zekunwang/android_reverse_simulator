/* ==========================================================================
   实验用算法库 —— 供各章 Lab 组件调用
   全部为真实实现（不是伪代码），读者输入能算出真实结果。
   挂在 window.CRYPTO 上。
   ========================================================================== */
(function (global) {
  'use strict';

  const HEX = '0123456789abcdef';
  const toHex = bytes => Array.from(bytes).map(b => HEX[b >> 4] + HEX[b & 15]).join('');
  const fromHex = s => {
    const t = String(s).replace(/[^0-9a-fA-F]/g, '');
    if (t.length % 2) throw new Error('十六进制长度必须是偶数（当前 ' + t.length + ' 位）');
    const out = new Uint8Array(t.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(t.substr(i * 2, 2), 16);
    return out;
  };
  const toBytes = s => new TextEncoder().encode(s);
  const normHex = s => String(s).replace(/0x/gi, '').replace(/[\s,]/g, '').toLowerCase();

  /* ---------------- CRC32 ---------------- */
  function crc32Table(poly) {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (poly ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  }
  function crc32(bytes, { poly = 0xEDB88320, init = 0xFFFFFFFF, xorout = 0xFFFFFFFF } = {}) {
    const t = crc32Table(poly >>> 0);
    let c = init >>> 0;
    for (let i = 0; i < bytes.length; i++) c = (t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
    return ((c ^ xorout) >>> 0);
  }

  /* ---------------- MD5（可改 IV/K/移位表，用于演示魔改） ---------------- */
  function md5K() {
    const K = new Uint32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    return K;
  }
  function md5(bytes, opt = {}) {
    const IV = opt.iv || [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    const K = opt.k || md5K();
    const S = opt.shift || [
      7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
      5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
      4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
      6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21
    ];
    // padding
    const ml = bytes.length;
    const withOne = ml + 1;
    const padLen = ((withOne + 8 + 63) & ~63);
    const msg = new Uint8Array(padLen);
    msg.set(bytes); msg[ml] = 0x80;
    const bitLen = ml * 8;
    const dv = new DataView(msg.buffer);
    dv.setUint32(padLen - 8, bitLen >>> 0, true);
    dv.setUint32(padLen - 4, Math.floor(bitLen / 4294967296), true);

    let [a0, b0, c0, d0] = IV.map(x => x >>> 0);
    const rl = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;
    for (let off = 0; off < padLen; off += 64) {
      const M = new Uint32Array(16);
      for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16)      { F = (B & C) | (~B & D);        g = i; }
        else if (i < 32) { F = (D & B) | (~D & C);        g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D;                 g = (3 * i + 5) % 16; }
        else             { F = C ^ (B | ~D);              g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + rl(F, S[i])) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const out = new Uint8Array(16);
    const odv = new DataView(out.buffer);
    odv.setUint32(0, a0, true); odv.setUint32(4, b0, true);
    odv.setUint32(8, c0, true); odv.setUint32(12, d0, true);
    return out;
  }

  /* ---------------- SHA-1 ---------------- */
  function sha1(bytes) {
    const ml = bytes.length, bitLen = ml * 8;
    const padLen = ((ml + 1 + 8 + 63) & ~63);
    const msg = new Uint8Array(padLen);
    msg.set(bytes); msg[ml] = 0x80;
    const dv = new DataView(msg.buffer);
    dv.setUint32(padLen - 8, Math.floor(bitLen / 4294967296), false);
    dv.setUint32(padLen - 4, bitLen >>> 0, false);

    let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    const rl = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;
    for (let off = 0; off < padLen; off += 64) {
      const w = new Uint32Array(80);
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
      for (let i = 16; i < 80; i++) w[i] = rl(w[i-3] ^ w[i-8] ^ w[i-14] ^ w[i-16], 1);
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let i = 0; i < 80; i++) {
        let f, k;
        if (i < 20)      { f = (b & c) | (~b & d);           k = 0x5A827999; }
        else if (i < 40) { f = b ^ c ^ d;                    k = 0x6ED9EBA1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d);  k = 0x8F1BBCDC; }
        else             { f = b ^ c ^ d;                    k = 0xCA62C1D6; }
        const t = (rl(a, 5) + f + e + k + w[i]) >>> 0;
        e = d; d = c; c = rl(b, 30); b = a; a = t;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0;
      h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    const out = new Uint8Array(20), o = new DataView(out.buffer);
    [h0,h1,h2,h3,h4].forEach((h, i) => o.setUint32(i * 4, h, false));
    return out;
  }

  /* ---------------- Adler-32（dex 文件头校验用，注意不是 CRC32） ---------------- */
  function adler32(bytes) {
    let a = 1, b = 0;
    const MOD = 65521;
    for (let i = 0; i < bytes.length; i++) {
      a = (a + bytes[i]) % MOD;
      b = (b + a) % MOD;
    }
    return (((b << 16) | a) >>> 0);
  }

  /* ---------------- Base64（可换表） ---------------- */
  const B64_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function base64Encode(bytes, table = B64_STD, pad = '=') {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      const n = (b0 << 16) | ((b1 || 0) << 8) | (b2 || 0);
      out += table[(n >> 18) & 63] + table[(n >> 12) & 63];
      out += (i + 1 < bytes.length) ? table[(n >> 6) & 63] : pad;
      out += (i + 2 < bytes.length) ? table[n & 63] : pad;
    }
    return out;
  }

  /* ---------------- RC4 ---------------- */
  function rc4(keyBytes, dataBytes, opt = {}) {
    const S = new Uint8Array(256);
    for (let i = 0; i < 256; i++) S[i] = opt.identity === false ? 0 : i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + S[i] + keyBytes[i % keyBytes.length]) & 255;
      const t = S[i]; S[i] = S[j]; S[j] = t;
    }
    const out = new Uint8Array(dataBytes.length);
    let i = 0; j = 0;
    for (let k = 0; k < dataBytes.length; k++) {
      i = (i + 1) & 255;
      j = (j + S[i]) & 255;
      const t = S[i]; S[i] = S[j]; S[j] = t;
      out[k] = dataBytes[k] ^ S[(S[i] + S[j]) & 255];
    }
    return out;
  }

  /* ---------------- HMAC ---------------- */
  function hmac(hashFn, blockSize, keyBytes, msgBytes) {
    let k = keyBytes;
    if (k.length > blockSize) k = hashFn(k);
    if (k.length < blockSize) {
      const p = new Uint8Array(blockSize); p.set(k); k = p;
    }
    const ipad = new Uint8Array(blockSize), opad = new Uint8Array(blockSize);
    for (let i = 0; i < blockSize; i++) { ipad[i] = k[i] ^ 0x36; opad[i] = k[i] ^ 0x5c; }
    const inner = new Uint8Array(blockSize + msgBytes.length);
    inner.set(ipad); inner.set(msgBytes, blockSize);
    const ih = hashFn(inner);
    const outer = new Uint8Array(blockSize + ih.length);
    outer.set(opad); outer.set(ih, blockSize);
    return hashFn(outer);
  }

  /* ---------------- AES（加密核心：SubBytes/ShiftRows/MixColumns/AddRoundKey） ---------------- */
  // 用标准算法现场生成 S 盒（不硬编码 256 字节，避免抄错）
  function aesSbox() {
    const sbox = new Uint8Array(256), inv = new Uint8Array(256);
    // GF(2^8) 乘法
    const xtime = a => ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff;
    const mul = (a, b) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xtime(a); b >>= 1; } return r & 0xff; };
    // 求乘法逆元（暴力，够快）
    const inv8 = new Uint8Array(256);
    for (let a = 1; a < 256; a++) for (let b = 1; b < 256; b++) if (mul(a, b) === 1) { inv8[a] = b; break; }
    for (let i = 0; i < 256; i++) {
      const x = inv8[i];
      // 仿射变换
      const y = x ^ ((x << 1) | (x >>> 7)) ^ ((x << 2) | (x >>> 6)) ^
                ((x << 3) | (x >>> 5)) ^ ((x << 4) | (x >>> 4)) ^ 0x63;
      sbox[i] = y & 0xff;
    }
    for (let i = 0; i < 256; i++) inv[sbox[i]] = i;
    return { sbox, inv };
  }
  const AES = aesSbox();

  function aesKeyExpansion(key) {
    const Nk = key.length / 4, Nr = Nk + 6;
    const w = new Uint8Array(16 * (Nr + 1));
    w.set(key);
    let rcon = 1;
    for (let i = Nk; i < 4 * (Nr + 1); i++) {
      let t = [w[(i-1)*4], w[(i-1)*4+1], w[(i-1)*4+2], w[(i-1)*4+3]];
      if (i % Nk === 0) {
        t = [t[1], t[2], t[3], t[0]].map(b => AES.sbox[b]);
        t[0] ^= rcon;
        rcon = ((rcon << 1) ^ ((rcon & 0x80) ? 0x1b : 0)) & 0xff;
      } else if (Nk > 6 && i % Nk === 4) {
        t = t.map(b => AES.sbox[b]);
      }
      for (let k = 0; k < 4; k++) w[i*4+k] = w[(i-Nk)*4+k] ^ t[k];
    }
    return { w, Nr };
  }

  function aesEncryptBlock(block, roundKeys) {
    const { w, Nr } = roundKeys;
    const xtime = a => ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff;
    const mul = (a, b) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xtime(a); b >>= 1; } return r & 0xff; };
    let s = Uint8Array.from(block);
    const addRK = r => { for (let i = 0; i < 16; i++) s[i] ^= w[r*16+i]; };
    addRK(0);
    for (let round = 1; round <= Nr; round++) {
      for (let i = 0; i < 16; i++) s[i] = AES.sbox[s[i]];              // SubBytes
      const t = Uint8Array.from(s);                                    // ShiftRows（列优先：行 r 左移 r）
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) s[c*4+r] = t[((c + r) % 4)*4 + r];
      if (round !== Nr) {                                              // MixColumns
        for (let c = 0; c < 4; c++) {
          const a = [s[c*4], s[c*4+1], s[c*4+2], s[c*4+3]];
          s[c*4]   = mul(a[0],2) ^ mul(a[1],3) ^ a[2] ^ a[3];
          s[c*4+1] = a[0] ^ mul(a[1],2) ^ mul(a[2],3) ^ a[3];
          s[c*4+2] = a[0] ^ a[1] ^ mul(a[2],2) ^ mul(a[3],3);
          s[c*4+3] = mul(a[0],3) ^ a[1] ^ a[2] ^ mul(a[3],2);
        }
      }
      addRK(round);
    }
    return s;
  }

  global.CRYPTO = {
    toHex, fromHex, toBytes, normHex,
    crc32, crc32Table, adler32, md5, md5K, sha1, base64Encode, B64_STD, rc4, hmac,
    AES, aesKeyExpansion, aesEncryptBlock
  };
})(window);
