/* 二维码生成（字节模式 + 纠错等级 M，版本 1~20），无第三方依赖。
   与本地工具 v2ray-to-clash/qr.py 是同一套算法的 JS 版本，改动需两边同步。 */
(function (global) {
  "use strict";

  // ── GF(256) 有限域 ────────────────────────────────────────
  const EXP = new Array(512).fill(0);
  const LOG = new Array(256).fill(0);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d; // 本原多项式
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  function polyMul(a, b) {
    const r = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) {
      if (!a[i]) continue;
      for (let j = 0; j < b.length; j++) r[i + j] ^= mul(a[i], b[j]);
    }
    return r;
  }

  function genPoly(n) {
    let g = [1];
    for (let i = 0; i < n; i++) g = polyMul(g, [1, EXP[i]]);
    return g;
  }

  function rsEncode(data, ecLen) {
    const gen = genPoly(ecLen);
    const res = data.concat(new Array(ecLen).fill(0));
    for (let i = 0; i < data.length; i++) {
      const coef = res[i];
      if (coef) for (let j = 0; j < gen.length; j++) res[i + j] ^= mul(gen[j], coef);
    }
    return res.slice(data.length);
  }

  // ── 版本参数表（纠错等级 M）──────────────────────────────
  // 版本 -> [每块纠错码字数, 组1块数, 组1每块数据码字, 组2块数, 组2每块数据码字]
  const EC_M = {
    1: [10, 1, 16, 0, 0], 2: [16, 1, 28, 0, 0], 3: [26, 1, 44, 0, 0],
    4: [18, 2, 32, 0, 0], 5: [24, 2, 43, 0, 0], 6: [16, 4, 27, 0, 0],
    7: [18, 4, 31, 0, 0], 8: [22, 2, 38, 2, 39], 9: [22, 3, 36, 2, 37],
    10: [26, 4, 43, 1, 44], 11: [30, 1, 50, 4, 51], 12: [22, 6, 36, 2, 37],
    13: [22, 8, 37, 1, 38], 14: [24, 4, 40, 5, 41], 15: [24, 5, 41, 5, 42],
    16: [28, 7, 45, 3, 46], 17: [28, 10, 46, 1, 47], 18: [26, 9, 43, 4, 44],
    19: [26, 3, 44, 11, 45], 20: [26, 3, 41, 13, 42],
  };

  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
    15: [6, 26, 48, 70], 16: [6, 26, 50, 74], 17: [6, 30, 54, 78],
    18: [6, 30, 56, 82], 19: [6, 30, 58, 86], 20: [6, 34, 62, 90],
  };

  const dataCapacity = (v) => EC_M[v][1] * EC_M[v][2] + EC_M[v][3] * EC_M[v][4];

  function pickVersion(byteLen) {
    for (let v = 1; v <= 20; v++) {
      const countBits = v <= 9 ? 8 : 16;
      if (4 + countBits + byteLen * 8 <= dataCapacity(v) * 8) return v;
    }
    throw new Error("内容太长，超出二维码容量（最多约 660 字节）");
  }

  // ── BCH 纠错（格式信息 / 版本信息）──────────────────────
  function bchFormat(data5) {
    let d = data5 << 10;
    for (let i = 14; i >= 10; i--) if (d & (1 << i)) d ^= 0x537 << (i - 10);
    return ((data5 << 10) | d) ^ 0x5412;
  }

  function bchVersion(version) {
    let d = version << 12;
    for (let i = 17; i >= 12; i--) if (d & (1 << i)) d ^= 0x1f25 << (i - 12);
    return (version << 12) | d;
  }

  // ── 掩码 ────────────────────────────────────────────────
  function maskFn(p, r, c) {
    switch (p) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  }

  function penalty(m, size) {
    let score = 0;

    // 规则1：同色连续 5 格以上
    const lines = [];
    for (let r = 0; r < size; r++) lines.push(m[r]);
    for (let c = 0; c < size; c++) {
      const col = [];
      for (let r = 0; r < size; r++) col.push(m[r][c]);
      lines.push(col);
    }
    for (const line of lines) {
      let run = 1;
      for (let i = 1; i < size; i++) {
        if (line[i] === line[i - 1]) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }

    // 规则2：2x2 同色块
    for (let r = 0; r < size - 1; r++)
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }

    // 规则3：1:1:3:1:1 特征串
    const p1 = [true, false, true, true, true, false, true, false, false, false, false];
    const p2 = p1.slice().reverse();
    const eq = (a, b) => a.every((v, i) => v === b[i]);
    for (let r = 0; r < size; r++)
      for (let c = 0; c <= size - 11; c++) {
        const seg = [];
        for (let k = 0; k < 11; k++) seg.push(m[r][c + k]);
        if (eq(seg, p1) || eq(seg, p2)) score += 40;
      }
    for (let c = 0; c < size; c++)
      for (let r = 0; r <= size - 11; r++) {
        const seg = [];
        for (let k = 0; k < 11; k++) seg.push(m[r + k][c]);
        if (eq(seg, p1) || eq(seg, p2)) score += 40;
      }

    // 规则4：黑白比例偏离 50%
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
    const ratio = Math.floor((dark * 100) / (size * size));
    score += 10 * Math.min(Math.floor(Math.abs(ratio - 50) / 5), 100);
    return score;
  }

  // ── 矩阵构建 ────────────────────────────────────────────
  function setupPatterns(m, size, version) {
    const reserved = [];
    for (let i = 0; i < size; i++) reserved.push(new Array(size).fill(false));
    const put = (r, c, v) => { m[r][c] = v; reserved[r][c] = true; };

    // 定位图形 + 分隔带
    for (const [br, bc] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
      for (let r = -1; r <= 7; r++)
        for (let c = -1; c <= 7; c++) {
          const rr = br + r, cc = bc + c;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          const inner =
            (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
            (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
            (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          put(rr, cc, inner);
        }
    }

    // 定时图形
    for (let i = 8; i < size - 8; i++) {
      put(6, i, i % 2 === 0);
      put(i, 6, i % 2 === 0);
    }

    // 校正图形
    const pos = ALIGN[version];
    const n = pos.length;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (let dr = -2; dr <= 2; dr++)
          for (let dc = -2; dc <= 2; dc++)
            put(pos[i] + dr, pos[j] + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
      }

    put(size - 8, 8, true); // 固定黑点

    // 预留格式信息区
    for (let i = 0; i <= 8; i++) {
      if (!reserved[8][i]) put(8, i, false);
      if (!reserved[i][8]) put(i, 8, false);
    }
    for (let i = 0; i < 8; i++) {
      put(8, size - 1 - i, false);
      put(size - 1 - i, 8, false);
    }

    // 预留版本信息区
    if (version >= 7)
      for (let i = 0; i < 18; i++) {
        put(Math.floor(i / 3), (i % 3) + size - 11, false);
        put((i % 3) + size - 11, Math.floor(i / 3), false);
      }

    return reserved;
  }

  function placeData(m, reserved, size, bits, mask) {
    let idx = 0, inc = -1, row = size - 1, col = size - 1;
    while (col > 0) {
      if (col === 6) col--;
      for (;;) {
        for (let k = 0; k < 2; k++) {
          const c = col - k;
          if (!reserved[row][c]) {
            let bit = idx < bits.length ? bits[idx] : 0;
            idx++;
            if (maskFn(mask, row, c)) bit ^= 1;
            m[row][c] = bit === 1;
          }
        }
        row += inc;
        if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
      }
      col -= 2;
    }
  }

  function placeFormat(m, size, mask) {
    const bits = bchFormat((0b00 << 3) | mask); // 纠错等级 M = 0b00
    for (let i = 0; i < 15; i++) {
      const v = ((bits >> i) & 1) === 1;
      if (i < 6) m[i][8] = v;
      else if (i < 8) m[i + 1][8] = v;
      else m[size - 15 + i][8] = v;
    }
    for (let i = 0; i < 15; i++) {
      const v = ((bits >> i) & 1) === 1;
      if (i < 8) m[8][size - i - 1] = v;
      else if (i < 9) m[8][15 - i] = v;
      else m[8][14 - i] = v;
    }
    m[size - 8][8] = true;
  }

  function placeVersion(m, size, version) {
    if (version < 7) return;
    const bits = bchVersion(version);
    for (let i = 0; i < 18; i++) {
      const v = ((bits >> i) & 1) === 1;
      m[Math.floor(i / 3)][(i % 3) + size - 11] = v;
      m[(i % 3) + size - 11][Math.floor(i / 3)] = v;
    }
  }

  function makeMatrix(text) {
    const raw = new TextEncoder().encode(text);
    const version = pickVersion(raw.length);
    const [ecLen, b1, d1, b2, d2] = EC_M[version];
    const totalData = dataCapacity(version);

    // 组装比特流
    const bits = [];
    const push = (value, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
    };
    push(0b0100, 4);                              // 字节模式
    push(raw.length, version <= 9 ? 8 : 16);      // 字符数
    for (const b of raw) push(b, 8);
    for (let i = 0, n = Math.min(4, totalData * 8 - bits.length); i < n; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);

    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      codewords.push(byte);
    }
    const pad = [0xec, 0x11];
    for (let i = 0; codewords.length < totalData; i++) codewords.push(pad[i % 2]);

    // 分块 + 纠错
    const blocks = [], ecs = [];
    let p = 0;
    for (let i = 0; i < b1; i++) { blocks.push(codewords.slice(p, p + d1)); p += d1; }
    for (let i = 0; i < b2; i++) { blocks.push(codewords.slice(p, p + d2)); p += d2; }
    for (const blk of blocks) ecs.push(rsEncode(blk, ecLen));

    // 交织
    const final = [];
    const maxLen = Math.max(...blocks.map((b) => b.length));
    for (let i = 0; i < maxLen; i++)
      for (const b of blocks) if (i < b.length) final.push(b[i]);
    for (let i = 0; i < ecLen; i++) for (const e of ecs) final.push(e[i]);

    const dataBits = [];
    for (const b of final) for (let i = 7; i >= 0; i--) dataBits.push((b >> i) & 1);

    // 8 种掩码取惩罚分最低的
    const size = 17 + 4 * version;
    let best = null, bestScore = null;
    for (let mask = 0; mask < 8; mask++) {
      const m = [];
      for (let i = 0; i < size; i++) m.push(new Array(size).fill(false));
      const reserved = setupPatterns(m, size, version);
      placeData(m, reserved, size, dataBits, mask);
      placeFormat(m, size, mask);
      placeVersion(m, size, version);
      const s = penalty(m, size);
      if (bestScore === null || s < bestScore) { best = m; bestScore = s; }
    }
    return best;
  }

  function makeSvg(text, opts) {
    opts = opts || {};
    const scale = opts.scale || 8;
    const border = opts.border == null ? 4 : opts.border;
    const dark = opts.dark || "#111111";
    const light = opts.light || "#ffffff";
    const m = makeMatrix(text);
    const size = m.length;
    const dim = (size + border * 2) * scale;
    const d = [];
    for (let r = 0; r < size; r++) {
      let c = 0;
      while (c < size) {
        if (m[r][c]) {
          const start = c;
          while (c < size && m[r][c]) c++;
          const x = (start + border) * scale;
          const y = (r + border) * scale;
          const w = (c - start) * scale;
          d.push(`M${x} ${y}h${w}v${scale}h-${w}z`);
        } else c++;
      }
    }
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" ` +
      `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
      `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
      `<path fill="${dark}" d="${d.join("")}"/></svg>`
    );
  }

  global.QR = { makeMatrix, makeSvg };
})(window);
