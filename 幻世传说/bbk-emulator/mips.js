// Minimal Big-Endian MIPS32 interpreter + BBK/ECOFF loader (PoC)
// Prove: load a 步步高 native .exe image, execute REAL instructions, trap OS/API calls.
'use strict';

function indexOf(hay, needle, from) {
  for (let i = from; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}
// high 32 bits of the unsigned 32x32->64 product (exact via 16-bit decomposition)
function mulhu(au, bu) {
  const aH = au >>> 16, aL = au & 0xffff, bH = bu >>> 16, bL = bu & 0xffff;
  const lL = aL * bL, lH = aL * bH, hL = aH * bL, hH = aH * bH;
  const mid = (lL >>> 16) + (lH & 0xffff) + (hL & 0xffff);
  return (hH + (lH >>> 16) + (hL >>> 16) + (mid >>> 16)) >>> 0;
}

function loadBBK(buf) {
  const ab = buf instanceof ArrayBuffer ? buf : buf.buffer;
  const off = buf instanceof ArrayBuffer ? 0 : buf.byteOffset;
  const len = buf.byteLength;
  const d = new Uint8Array(ab, off, len);
  const dv = new DataView(ab, off, len);
  if (d[0] !== 0x42 || d[1] !== 0x42 || d[2] !== 0x4b) throw new Error('not BBK');
  const u16 = (o) => dv.getUint16(o, false);
  const u32 = (o) => dv.getUint32(o, false);
  // Locate the embedded big-endian MIPS ECOFF a.out: scan for filehdr magic 0x0160
  let base = -1;
  for (let i = 0x40; i < 0x600; i += 4) { if (u16(i) === 0x0160 && u16(i + 2) >= 1 && u16(i + 2) <= 12) { base = i; break; } }
  if (base < 0) throw new Error('ecoff magic not found');
  const nscns = u16(base + 2);
  const symptr = u32(base + 8), nsyms = u32(base + 12), opthdr = u16(base + 16);
  const A = base + 20; // aouthdr
  const entryRaw = u32(A + 4);   // vmaStart (unreliable for BBK containers)
  const gpvalue = u32(A + 24);
  const secstart = A + opthdr;
  const secs = {};
  const order = [];
  for (let s = 0; s < nscns; s++) {
    const o = secstart + s * 40;
    let name = ''; for (let c = 0; c < 8 && d[o + c]; c++) name += String.fromCharCode(d[o + c]);
    const rec = { name, vaddr: u32(o + 12), size: u32(o + 16), scnptr: u32(o + 20), relptr: u32(o + 24), nreloc: u16(o + 32) };
    secs[name] = rec; order.push(rec);
  }
  let imgEnd = 0;
  for (const s of order) if (s.size) imgEnd = Math.max(imgEnd, s.vaddr + s.size);
  const ARENA = 0x10000000; // 256MB flat: image + COMMON(0x600000+) + heap(0x700000..0xf000000) + FB(0xfe00000); stack <0x400000  (游戏菜单渲染会反复 malloc 大块且几乎不 free, 故把堆扩到 ~240MB 容纳)
  const memSize = Math.max(imgEnd + 0x40, ARENA);
  const mem = new Uint8Array(memSize);
  for (const s of order) {
    if (!s.size || !s.scnptr) continue;
    mem.set(d.subarray(base + s.scnptr, base + s.scnptr + s.size), s.vaddr);
  }
  const text = secs['.text'];
  const codeEnd = text ? text.vaddr + text.size : imgEnd;
  const entry = text ? text.vaddr : entryRaw; // BBK games start at .text base (initLoadedAP@0); vmaStart field is unreliable here
  return { mem, imgEnd, codeEnd, entry, entryRaw, gpvalue, secs, base, nscns, symptr, nsyms };
}

class Mips {
  constructor(mem, codeEnd, opts = {}) {
    this.mem = mem; this.codeEnd = codeEnd;
    this.r = new Int32Array(32); this.hi = 0; this.lo = 0; this.pc = 0;
    this.STACK = 0x00400000; this.r[29] = this.STACK;
    this.EXIT = 0x7fffffff;
    this.API_BASE = 0x80000000; this.API_SIZE = 0x2000; // OS dispatch window
    this.apiTable = new Int32Array(this.API_SIZE / 4);
    for (let i = 0; i < this.apiTable.length; i++) this.apiTable[i] = this.API_BASE + i * 4; // identity sentinel
    this.steps = 0; this.maxSteps = opts.maxSteps || 5000000;
    this.external = new Map(); this.log = opts.log || (() => {});
    this.apiOrder = []; // chronological external call targets
    this.trace = opts.trace || 0; this.running = true;
    this.onApi = opts.onApi || null; // fn(slot, this) -> v0 value | undefined
    this._pend = null; this._pendGen = -1;
    this.fbWrites = 0;
    this.hist = opts.hist ? new Map() : null; // per-PC execution histogram
    this.hookPC = opts.hookPC || null; // Map(pc->label): log each hit with ra/v0/a0..a3
    this.hits = [];
    this.watch = opts.watch || null; // {lo,hi}: log stores whose pc in [lo,hi)
    this.storeLog = [];
    this.codeMon = null; this.codeWrites = []; this.curPC = 0; // {lo,hi}: record any store into [lo,hi) with source pc
    this.protectCode = false; this.codeStart = 0; this.codeProtectHits = 0; this.codeProtectLog = null; // drop stores into [codeStart,codeEnd) to prevent code corruption
    this.storehist = opts.storehist ? new Map() : null; // page(4KB) -> store count
  }
  rd8(a) { a >>>= 0; if (a >= this.API_BASE && a < this.API_BASE + this.API_SIZE) { const w = this.apiTable[(a - this.API_BASE) >> 2]; return (w >> (24 - (a & 3) * 8)) & 0xff; } return a < this.mem.length ? this.mem[a] : 0; }
  rd16(a) { a >>>= 0; if (a >= this.API_BASE && a < this.API_BASE + this.API_SIZE) { const w = this.apiTable[(a - this.API_BASE) >> 2]; return (w >> (16 - (a & 2) * 8)) & 0xffff; } return a + 1 < this.mem.length ? (this.mem[a] << 8) | this.mem[a + 1] : 0; }
  rd32(a) { a >>>= 0; if (a >= this.API_BASE && a < this.API_BASE + this.API_SIZE) return this.apiTable[(a - this.API_BASE) >> 2] | 0; return a + 3 < this.mem.length ? ((this.mem[a] << 24) | (this.mem[a + 1] << 16) | (this.mem[a + 2] << 8) | this.mem[a + 3]) | 0 : 0; }
  wr8(a, v) { a >>>= 0; if (this.protectCode && a >= this.codeStart && a < this.codeEnd) { this.codeProtectHits = (this.codeProtectHits || 0) + 1; if (this.codeProtectLog && this.codeProtectLog.length < 40) this.codeProtectLog.push({ pc: this.curPC >>> 0, a, v: v & 0xff, steps: this.steps }); return; } if (a >= this.API_BASE && a < this.API_BASE + this.API_SIZE) { const i = (a - this.API_BASE) >> 2, w = this.apiTable[i]; this.apiTable[i] = (w & ~(0xff << (24 - (a & 3) * 8))) | ((v & 0xff) << (24 - (a & 3) * 8)); return; } if (a < this.mem.length) { if (this.codeMon && a >= this.codeMon.lo && a < this.codeMon.hi && this.codeWrites.length < 400) this.codeWrites.push({ pc: this.curPC >>> 0, addr: a, v: v & 0xff, kind: 8, steps: this.steps }); this.mem[a] = v & 0xff; if (this.nzhist && (v & 0xff)) this.nzhist.set(a >>> 12, (this.nzhist.get(a >>> 12) || 0) + 1); if (this.addrHi != null && a >= this.addrLo && a < this.addrHi) { this.addrWrites = (this.addrWrites || 0) + 1; if (v & 0xff) { this.addrNonzero = (this.addrNonzero || 0) + 1; (this.addrPeak = this.addrPeak || new Map()).set(a, v & 0xff); } } } }
  wr16(a, v) { a >>>= 0; if (this.protectCode && a >= this.codeStart && a < this.codeEnd) { this.codeProtectHits = (this.codeProtectHits || 0) + 1; return; } if (a >= this.API_BASE && a < this.API_BASE + this.API_SIZE) { const i = (a - this.API_BASE) >> 2, w = this.apiTable[i]; this.apiTable[i] = (w & ~(0xffff << (16 - (a & 2) * 8))) | ((v & 0xffff) << (16 - (a & 2) * 8)); return; } if (a + 1 < this.mem.length) { this.mem[a] = (v >> 8) & 0xff; this.mem[a + 1] = v & 0xff; if (this.nzhist && (v & 0xffff)) this.nzhist.set(a >>> 12, (this.nzhist.get(a >>> 12) || 0) + 1); } }
  wr32(a, v) { a >>>= 0; if (this.protectCode && a >= this.codeStart && a < this.codeEnd) { this.codeProtectHits = (this.codeProtectHits || 0) + 1; if (this.codeProtectLog && this.codeProtectLog.length < 40) this.codeProtectLog.push({ pc: this.curPC >>> 0, a, v: v >>> 0, steps: this.steps }); return; } if (a >= this.API_BASE && a < this.API_BASE + this.API_SIZE) { this.apiTable[(a - this.API_BASE) >> 2] = v | 0; return; } if (a + 3 < this.mem.length) { if (this.codeMon && a >= this.codeMon.lo && a < this.codeMon.hi && this.codeWrites.length < 400) this.codeWrites.push({ pc: this.curPC >>> 0, addr: a, v: v >>> 0, kind: 32, steps: this.steps }); this.mem[a] = (v >> 24) & 0xff; this.mem[a + 1] = (v >> 16) & 0xff; this.mem[a + 2] = (v >> 8) & 0xff; this.mem[a + 3] = v & 0xff; if (this.nzhist && (v | 0)) this.nzhist.set(a >>> 12, (this.nzhist.get(a >>> 12) || 0) + 1); } }

  jump(target, link, here) {
    // redirect applied AFTER the delay slot (the instruction at here+4)
    target >>>= 0;
    if (link) this.r[31] = (here + 8) | 0;
    if (this.jring) { this.jring.push(here + '>' + target + (link ? '' : ' jr') + ' ra=0x' + (this.r[31] >>> 0).toString(16)); if (this.jring.length > 50) this.jring.shift(); }
    if (target >= this.codeEnd) {
      this.external.set('0x' + target.toString(16), (this.external.get('0x' + target.toString(16)) || 0) + 1);
      if (this.apiOrder.length < 4000) this.apiOrder.push(target >>> 0);
      const ra = this.r[31] >>> 0;
      if (this.onApi && target >= this.API_BASE && target < this.API_BASE + this.API_SIZE) {
        // DEFER the OS shim until AFTER the delay-slot instruction runs, so arguments set in the
        // delay slot (e.g. `jalr v0` + `addiu a1,s8,16`) are visible to the handler. Landing on the
        // API window in step() fires onApi with final registers, then returns to ra.
        this._pend = target; this._pendGen = this.steps; return;
      }
      this.r[2] = 0;
      if (ra >= this.codeEnd) { this.exitJump = { here, target, ra, steps: this.steps, a0: this.r[4] >>> 0, a1: this.r[5] >>> 0 }; this.running = false; return; }
      this._pend = ra; this._pendGen = this.steps; return;
    }
    this._pend = target; this._pendGen = this.steps;
    if (target >= 0x600000 && !this.dataJump) this.dataJump = { here, target, ra: this.r[31] >>> 0, steps: this.steps, a0: this.r[4] >>> 0, a1: this.r[5] >>> 0 };
  }

  step() {
    const here = this.pc >>> 0;
    this.curPC = here;
    if (here >= this.API_BASE && here < this.API_BASE + this.API_SIZE) {
      // External OS API landing (deferred from jump): the delay-slot instruction has now run, so
      // argument registers are final. Fire the shim, publish v0, then return to ra.
      this.steps++;
      let rv = 0;
      if (this.onApi) rv = this.onApi(here - this.API_BASE, this) | 0;
      // 实时阻塞: shim 置 _block 表示"暂无消息/事件, 请挂起等待"。保持 pc 停在 API 地址(不返回到 ra), 下一帧重新进入本调用。
      if (this._block) { this._block = false; this._blockedNow = true; this.steps--; return; }
      this.r[2] = rv | 0; this.r[0] = 0;
      const ra = this.r[31] >>> 0;
      if (ra >= this.codeEnd) { this.exitJump = { here, target: here, ra, steps: this.steps, a0: this.r[4] >>> 0, a1: this.r[5] >>> 0 }; this.running = false; this.pc = ra >>> 0; return; }
      this.pc = ra >>> 0; return;
    }
    const w = this.rd32(here) >>> 0;
    this.pc = here + 4; // default: fall through to delay slot / next
    if (this._after != null) { /* shouldn't happen here */ }
    if (this.steps < this.trace) this.log(`0x${here.toString(16)}: ${w.toString(16).padStart(8, '0')}`);
    this.steps++;
    if (this.hist) this.hist.set(here, (this.hist.get(here) || 0) + 1);
    if (this.hookPC && this.hookPC.has(here)) { const lbl=this.hookPC.get(here); const ra=this.r[31]>>>0; (this.pcCaller=this.pcCaller||new Map()).set(lbl+'|0x'+ra.toString(16),(this.pcCaller.get(lbl+'|0x'+ra.toString(16))||0)+1); if (this.hits.length < 200) this.hits.push({ pc: here, label: lbl, ra, v0: this.r[2] >>> 0, a0: this.r[4] >>> 0, a1: this.r[5] >>> 0, steps: this.steps }); }
    if (this.pcHooks && this.pcHooks.has(here)) this.pcHooks.get(here)(this);
    const r = this.r;
    const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31;
    const sh = (w >>> 6) & 31, fn = w & 0x3f, imm = w & 0xffff, simm = (imm << 16) >> 16;
    const branch = (cond) => { this._pend = cond ? (here + 4 + (simm << 2)) : (here + 8); this._pendGen = this.steps; }; // applied after delay slot
    // handle delay slot for branches/jumps by executing next instr then redirecting (simplified: no delay exec)
    switch (op) {
      case 0x00:
        switch (fn) {
          case 0x00: r[rd] = (r[rt] << sh) | 0; break;
          case 0x02: r[rd] = (r[rt] >>> sh) | 0; break;
          case 0x03: r[rd] = r[rt] >> sh; break;
          case 0x04: r[rd] = (r[rt] << (r[rs] & 31)) | 0; break; // SLLV (variable shift)
          case 0x06: r[rd] = (r[rt] >>> 0) >>> (r[rs] & 31) | 0; break; // SRLV
          case 0x07: r[rd] = r[rt] >> (r[rs] & 31); break; // SRAV (arithmetic)
          case 0x08: this.jump(r[rs] >>> 0, false, here); break; // jr
          case 0x09: this.jump(r[rs] >>> 0, true, here); break; // jalr
          case 0x0c: this.syscall(); break;
          case 0x10: r[rd] = this.hi; break; // mfhi
          case 0x11: this.hi = r[rs]; break; // mthi
          case 0x12: r[rd] = this.lo; break; // mflo
          case 0x13: this.lo = r[rs]; break; // mtlo
          case 0x18: { const a = r[rs] | 0, b = r[rt] | 0, au = a >>> 0, bu = b >>> 0; const lo = Math.imul(a, b) >>> 0; const hi = (mulhu(au, bu) - (a < 0 ? bu : 0) - (b < 0 ? au : 0)) >>> 0; this.lo = lo | 0; this.hi = hi | 0; break; } // MULT (signed 32x32->64)
          case 0x19: { const au = r[rs] >>> 0, bu = r[rt] >>> 0; this.lo = (Math.imul(au, bu) >>> 0) | 0; this.hi = mulhu(au, bu) | 0; break; } // MULTU (unsigned 32x32->64)
          case 0x1a: { const d = r[rt] | 0; if (d !== 0) { const n = r[rs] | 0; const q = Math.trunc(n / d); this.lo = q | 0; this.hi = (n - q * d) | 0; } break; } // DIV (signed)
          case 0x1b: { const d = r[rt] >>> 0; if (d !== 0) { const n = r[rs] >>> 0; const q = Math.trunc(n / d); this.lo = (q >>> 0) | 0; this.hi = (n - q * d) >>> 0 | 0; } break; } // DIVU (unsigned)
          case 0x20: case 0x21: r[rd] = (r[rs] + r[rt]) | 0; break;
          case 0x22: case 0x23: r[rd] = (r[rs] - r[rt]) | 0; break;
          case 0x24: r[rd] = r[rs] & r[rt]; break;
          case 0x25: r[rd] = r[rs] | r[rt]; break;
          case 0x26: r[rd] = r[rs] ^ r[rt]; break;
          case 0x27: r[rd] = ~(r[rs] | r[rt]); break;
          case 0x2a: r[rd] = r[rs] < r[rt] ? 1 : 0; break; // slt
          case 0x2b: r[rd] = (r[rs] >>> 0) < (r[rt] >>> 0) ? 1 : 0; break; // sltu
          default: if (this.unimp) { const k = '00:' + fn.toString(16); if (!this.unimp.has(k)) this.unimp.set(k, { n: 0, pc: here, w }); this.unimp.get(k).n++; } break;
        }
        break;
      case 0x01: {
        const t = rt & 0x1f;
        if (t === 0x00) branch(r[rs] < 0); else if (t === 0x01) branch(r[rs] >= 0);
        else if (t === 0x11) branch(r[rs] <= 0); else if (t === 0x10) branch(r[rs] > 0);
        break;
      }
      case 0x02: this.jump((((w & 0x03ffffff) << 2) | (this.pc & 0xf0000000)) >>> 0, false, here); break; // j  (26-bit target index, NOT imm16)
      case 0x03: this.jump((((w & 0x03ffffff) << 2) | (this.pc & 0xf0000000)) >>> 0, true, here); break; // jal (26-bit target index, NOT imm16)
      case 0x04: branch(r[rs] === r[rt]); break;
      case 0x05: branch(r[rs] !== r[rt]); break;
      case 0x06: branch(r[rs] <= 0); break;
      case 0x07: branch(r[rs] > 0); break;
      case 0x08: case 0x09: r[rt] = (r[rs] + simm) | 0; break;
      case 0x0a: r[rt] = r[rs] < simm ? 1 : 0; break;
      case 0x0b: r[rt] = (r[rs] >>> 0) < (simm >>> 0) ? 1 : 0; break;
      case 0x0c: r[rt] = r[rs] & imm; break;
      case 0x0d: r[rt] = r[rs] | imm; break;
      case 0x0e: r[rt] = r[rs] ^ imm; break;
      case 0x0f: r[rt] = (imm << 16) | 0; break; // lui
      case 0x20: r[rt] = (this.rd8(r[rs] + simm) << 24) >> 24; break;
      case 0x21: r[rt] = (this.rd16(r[rs] + simm) << 16) >> 16; break;
      case 0x23: r[rt] = this.rd32(r[rs] + simm); break;
      case 0x24: r[rt] = this.rd8(r[rs] + simm) & 0xff; break;
      case 0x25: r[rt] = this.rd16(r[rs] + simm) & 0xffff; break;
      case 0x22: { // LWL (big-endian): load high bytes of word at unaligned addr a
        const a = (r[rs] + simm) >>> 0, off = a & 3, n = 4 - off; let t = r[rt] | 0;
        for (let j = 0; j < n; j++) { const b = this.rd8((a + j) >>> 0), k = 3 - j; t = (t & ~(0xff << (k * 8))) | ((b & 0xff) << (k * 8)); }
        r[rt] = t | 0; break;
      }
      case 0x26: { // LWR (big-endian): load low bytes of word at unaligned addr a
        const a = (r[rs] + simm) >>> 0, al = (a & ~3) >>> 0, off = a & 3, n = off + 1; let t = r[rt] | 0;
        for (let j = 0; j < n; j++) { const b = this.rd8((al + j) >>> 0), k = n - 1 - j; t = (t & ~(0xff << (k * 8))) | ((b & 0xff) << (k * 8)); }
        r[rt] = t | 0; break;
      }
      case 0x28: { const ea = (r[rs] + simm) >>> 0; this.wr8(ea, r[rt]); if (this.storehist) this.storehist.set(ea >>> 12, (this.storehist.get(ea >>> 12) || 0) + 1); if (this.watch && here >= this.watch.lo && here < this.watch.hi && this.storeLog.length < 4000) this.storeLog.push({ pc: here, ea, v: r[rt] & 0xff, sz: 1 }); break; } // SB
      case 0x29: { const ea = (r[rs] + simm) >>> 0; this.wr16(ea, r[rt]); if (this.storehist) this.storehist.set(ea >>> 12, (this.storehist.get(ea >>> 12) || 0) + 1); if (this.watch && here >= this.watch.lo && here < this.watch.hi && this.storeLog.length < 4000) this.storeLog.push({ pc: here, ea, v: r[rt] & 0xffff, sz: 2 }); break; } // SH
      case 0x2a: { // SWL (big-endian): store high bytes of word to unaligned addr a
        const a = (r[rs] + simm) >>> 0, off = a & 3, n = 4 - off;
        for (let j = 0; j < n; j++) { const k = 3 - j; this.wr8((a + j) >>> 0, (r[rt] >> (k * 8)) & 0xff); }
        if (this.storehist) this.storehist.set(a >>> 12, (this.storehist.get(a >>> 12) || 0) + 1);
        if (this.watch && here >= this.watch.lo && here < this.watch.hi && this.storeLog.length < 4000) this.storeLog.push({ pc: here, ea: a, v: r[rt] | 0, sz: 'L' }); break;
      }
      case 0x2b: { const ea = (r[rs] + simm) >>> 0; this.wr32(ea, r[rt]); if (this.storehist) this.storehist.set(ea >>> 12, (this.storehist.get(ea >>> 12) || 0) + 1); if (this.watch && here >= this.watch.lo && here < this.watch.hi && this.storeLog.length < 4000) this.storeLog.push({ pc: here, ea, v: r[rt] | 0, sz: 4 }); break; } // SW
      case 0x2e: { // SWR (big-endian): store low bytes of word to unaligned addr a
        const a = (r[rs] + simm) >>> 0, al = (a & ~3) >>> 0, off = a & 3, n = off + 1;
        for (let j = 0; j < n; j++) { const k = n - 1 - j; this.wr8((al + j) >>> 0, (r[rt] >> (k * 8)) & 0xff); }
        if (this.storehist) this.storehist.set(a >>> 12, (this.storehist.get(a >>> 12) || 0) + 1);
        if (this.watch && here >= this.watch.lo && here < this.watch.hi && this.storeLog.length < 4000) this.storeLog.push({ pc: here, ea: al, v: r[rt] | 0, sz: 'R' }); break;
      }
      default: if (this.unimp) { const k = op.toString(16) + ':' + ((op === 0x1c || op === 0x1d) ? rs.toString(16) : fn.toString(16)); if (!this.unimp.has(k)) this.unimp.set(k, { n: 0, pc: here, w }); this.unimp.get(k).n++; } break;
    }
    r[0] = 0;
    if (this._pend != null && this.steps > this._pendGen) { this.pc = this._pend >>> 0; this._pend = null; }
  }

  syscall() {
    const n = this.r[2] >>> 0;
    this.external.set('syscall:0x' + n.toString(16), (this.external.get('syscall:0x' + n.toString(16)) || 0) + 1);
    this.r[2] = 0;
  }

  run(entry) {
    this.pc = entry >>> 0; this.r[31] = this.EXIT;
    while (this.running && this.steps < this.maxSteps) this.step();
    return { steps: this.steps, reason: this.running ? 'maxSteps' : 'exit', external: this.external };
  }
}

// Node + browser compatible export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { loadBBK, Mips };
} else if (typeof window !== 'undefined') {
  window.BBK = { loadBBK, Mips };
}
