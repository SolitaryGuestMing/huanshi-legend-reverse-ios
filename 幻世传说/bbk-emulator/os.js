// os.js — BBK "飞天" OS shim for the MIPS PoC (Node + browser)
// Intercepts calls landing in the 0x80000000 OS-dispatch window.
// Convention (confirmed on bhq/cdz/hss): game does
//   lui $v1,0x8000 ; lw $v1,0xa0($v1)  -> cb = *(0x800000a0)
//   addiu $v0,$v1,+field ; lw $s0,($v0) ; jalr $s0
// With identity API window, cb resolves to 0x800000a0 so the intercepted
// slot (target - 0x80000000) == 0xa0 + cb_field_offset.
'use strict';

// ---- 16x16 / 8x16 中文点阵字库 (来自 FMJ font.c -> font.bin) ----
// 索引公式逆向自 Fmj/fmj_c_engine/middle.c: 一级汉字 offset=(b1-0xA1+(b0-0xB0)*94)*32
let FONT = null;
try { const _fs = require('fs'); const _p = require('path'); FONT = new Uint8Array(_fs.readFileSync(_p.join(__dirname, 'font.bin'))); } catch (e) { FONT = null; }
function setFont(u8) { FONT = u8; } // 浏览器下 require('fs') 不可用→FONT=null, 由宿主 fetch font.bin 后注入
function glyphOff(b0, b1) { // -> {off, w} or null
  if (b0 < 0x80) return { off: 0x3D740 + b0 * 0x10, w: 8 };                                   // ASCII 8x16 (16B)
  if (b0 >= 0xB0 && b0 <= 0xF7 && b1 >= 0xA1 && b1 <= 0xFE) return { off: (b1 - 0xA1 + (b0 - 0xB0) * 0x5E) * 0x20, w: 16 }; // 一级汉字
  if (b0 >= 0xA1 && b0 <= 0xA9 && b1 >= 0xA1 && b1 <= 0xFE) return { off: 0x34E00 + (b1 - 0xA1 + (b0 - 0xA1) * 0x5E) * 0x20, w: 16 }; // 符号区
  return null;
}

// cb field offset -> slot = 0xa0 + off.  Canonical leaf-stub offsets (authoritative).
const CB = {
  malloc:0x40, free:0x44, GetSystemTime:0x4c,
  EnQMessage:0xa8, GetMessage:0xac, Delay:0xac,
  MessageBox:0x108, InputDialog:0x10c,
  SetTimer:0x26c, SetTimer2:0x270, KillTimer:0x274, KillTimer2:0x27c,
  DrawPixel:0x2f4, DrawLine:0x2f8, DrawRect:0x2fc, FillRect:0x300,
  ReverseDDLcd:0x304, DrawCircle:0x308, FillCircle:0x30c, FillDDLcd:0x328,
  GetTextMetrics:0x350, GetTextMetrics2:0x354, PrintString:0x348, DrawText:0x368,
  fopen:0x430, fclose:0x434, fread:0x438, fwrite:0x43c, fseek:0x440, ftell:0x444,
  memcpy:0x5ec, memmove:0x5f0, memset:0x5f4, strcat:0x5f8, strncat:0x5fc,
  strcmp:0x600, strcpy:0x608, strlen:0x614,
  itoa:0x714, CreateCDD:0x720, DeleteCDD:0x724, ScrDDBltDesDD:0x728,
  DetectKeyState:0x73c, ClearDDLcd:0x740, PutString:0x760, rand:0x768, srand:0x76c,
  // object getters observed in E9188MainWin init (return pointers into synthetic device tree):
  get730:0x730, winGet:0xb4, getBC:0xbc,
};
const SLOT = {};            // slot -> name
for (const k in CB) SLOT[(0xa0 + CB[k]) | 0] = k;
const CB_SLOT = {};         // name -> slot
for (const k in CB) CB_SLOT[k] = (0xa0 + CB[k]) | 0;

function makeOS(m, opts) {
  opts = opts || {};
  const S = {
    heap: 0x00700000,
    heapEnd: 0x0f000000,
    counts: new Map(),      // slot -> count
    order: [],              // ordered slot list (capped)
    calls: [],              // {slot,name,a0..a3,sp,pc} first N
    maxLog: opts.maxLog || 600,
    msgCount: 0,
    msgMax: opts.msgMax == null ? 4 : opts.msgMax, // feed N messages then -1
    frame: null,            // framebuffer model for GDI
    fw: opts.fw || 240, fh: opts.fh || 160,
    presentCount: 0,
    drawCount: 0,
    unknown: new Map(),     // slot -> count of unhandled
    tick: 0,
    randState: 0x12345678,
    openFiles: new Map(),   // fd -> {buf,pos}
    fdSeq: 3,
    vfs: opts.vfs || null,   // { byName:Map(name->Uint8Array), default:Uint8Array }
    surfaces: new Map(),    // handle -> {w,h,px}
    cddSeq: 0x220000,       // surface handle 分配区(避开游戏帧buffer 0x200000 及游戏dataptr 0x210000)
  };
  // ---- 存档持久化(浏览器 localStorage; node 诊断下无 localStorage 则纯内存) ----
  //   游戏 fwrite a:\fml.sav 存进度 → 写进 S.savStore(Uint8Array) 并 persistSav 到 localStorage; fread 读档 → 回吐 S.savStore。
  //   多槽由 realtime.js 存取面板管理(复制 S.savStore ↔ localStorage 槽位)。S.savStore 长度=0 表示无存档。
  S.LSKEY = 'hss_sav_current';
  S.loadSav = function () { try { if (typeof localStorage !== 'undefined') { const b = localStorage.getItem(S.LSKEY); if (b) { const u = atob(b); const a = new Uint8Array(u.length); for (let i = 0; i < u.length; i++) a[i] = u.charCodeAt(i); return a; } } } catch (e) {} return new Uint8Array(0); };
  S.persistSav = function () { try { if (typeof localStorage !== 'undefined' && S.savStore && S.savStore.length) { let s = ''; const CH = 8192; const st = S.savStore; for (let i = 0; i < st.length; i += CH) s += String.fromCharCode.apply(null, st.subarray(i, i + CH)); localStorage.setItem(S.LSKEY, btoa(s)); S.savDirty = false; } } catch (e) {} };
  S.savStore = S.loadSav();
  // ---- real surface/framebuffer model ----
  // LCD is 320x200, 4-level grayscale = 2bpp, stored row-interleaved (80B/row: 40B low plane + 40B high plane) = 16000 bytes.
  // The game's physical screen back-buffer lives at a COMMON global (~0x644000) which it composes into directly.
  // gamScrDDBltDesDD reads the "screen DC handle" from absolute address 0 (lui $a1,0; lw $a1,0($a1)); we must
  // store a valid OS handle there whose surface dataptr is a readable LCD framebuffer.
  S.lcdW = opts.fw || 320; S.lcdH = opts.fh || 200;
  S.FB = 0x0fe00000;                    // dedicated LCD framebuffer region (16000 bytes), above the enlarged heap
  S.textMask = new Uint8Array(320 * 240); // 文字像素掩码: blitGlyph 标记, render 时用蓝色替代
  S.surfaces.set(S.FB, { ptr: S.FB, w: S.lcdW, h: S.lcdH, size: S.lcdW * S.lcdH / 4, lcd: true });
  S.surfaces.set(0x700000, { ptr: S.FB, w: S.lcdW, h: S.lcdH, size: 0x10000, screen: true }); // 游戏以0x700000为"屏幕DC handle"传ScrDDBltDesDD(从不写它), 映射到真实LCD framebuffer(S.FB)
  S.screenHnd = S.FB;                   // the OS handle the game stores/reads for the physical screen
  m.wr32(0x0, S.screenHnd >>> 0);       // *(0x0) = screen DC handle (was 0 -> broke all to-screen blits)

  function rdStr(a) { let s=''; a>>>=0; for(let i=0;i<256;i++){const c=m.rd8(a+i); if(!c)break; s+=String.fromCharCode(c);} return s; }
  let _gbk=null; function rdGB(a){ const byts=[]; a>>>=0; for(let i=0;i<128;i++){const c=m.rd8(a+i); if(!c)break; byts.push(c);} try{ if(!_gbk)_gbk=new TextDecoder('gbk',{fatal:false}); return _gbk.decode(Uint8Array.from(byts)); }catch(e){ return byts.map(x=>('0'+x.toString(16)).slice(-2)).join(' '); } }
  function alloc(sz) { sz=(sz+15)&~15; const p=S.heap; S.heap=(S.heap+sz)&~15; if(S.heap>=S.heapEnd) throw new Error('heap exhausted'); return p; }
  // ---- 带 free-list 的真实分配器 ----
  // 旧 alloc 只 bump、free 为空操作 → 游戏“malloc/free 循环”(新建游戏/角色创建等)会永久泄漏 → heap exhausted 抛异常 → 主循环冻结。
  // 现改为 16B 头 + first-fit 回收 + 相邻合并。liveAlloc 记录 userPtr→{addr,size}, 只回收本分配器发出的指针(其余 free 安全忽略)。
  S.freeList = []; S.liveAlloc = new Map();
  function halloc(sz) {
    const rawSz = sz;
    sz = (sz + 15) & ~15; if (sz < 16) sz = 16;
    if ((S.allocLog = S.allocLog || []).length < 80) S.allocLog.push({ sz: rawSz, ra: m.r[31] >>> 0, caller: (m.rd32(((m.r[29] + 28) >>> 0)) >>> 0), heap: S.heap >>> 0 });
    const fl = S.freeList;
    for (let i = 0; i < fl.length; i++) {
      const blk = fl[i];
      if (blk.size >= sz + 16) {                       // 从块尾切一刀, 保留 blk.addr 稳定
        blk.size -= (sz + 16);
        const hdr = (blk.addr + blk.size) >>> 0;
        S.liveAlloc.set((hdr + 16) >>> 0, { addr: hdr, size: sz });
        return (hdr + 16) >>> 0;
      } else if (blk.size >= sz) {                      // 整块用尽(不够再留 16B 头)
        fl.splice(i, 1);
        S.liveAlloc.set((blk.addr + 16) >>> 0, { addr: blk.addr, size: blk.size - 16 });
        return (blk.addr + 16) >>> 0;
      }
    }
    const hdr = S.heap; S.heap = (S.heap + sz + 16) & ~15;
    // 堆耗尽不再抛异常冻结主循环(那会导致 pc 飞掉、GetMessage 停摆、所有按键无反应)。
    // 改为回退: 回收最老的一块(近似真机固定资源缓存的 LRU 复用), 保证始终返回合法可写指针、循环继续跑。
    if (S.heap >= S.heapEnd) {
      S.heapExhausted = (S.heapExhausted || 0) + 1;
      let oldest = null;
      for (const v of S.liveAlloc.values()) { if (v.size >= sz) { if (!oldest || v.addr < oldest.addr) oldest = v; } }
      if (oldest) { S.liveAlloc.delete(oldest.addr + 16 >>> 0); S.heap = (oldest.addr + sz + 16) & ~15; S.liveAlloc.set((oldest.addr + 16) >>> 0, { addr: oldest.addr, size: sz }); return (oldest.addr + 16) >>> 0; }
      S.heap = S.heapEnd; // 无大块可回收: 复位指针, 下方仍返回 hdr(游戏会降级, 但不冻结)
    }
    S.liveAlloc.set((hdr + 16) >>> 0, { addr: hdr, size: sz });
    if ((S.allocStack = S.allocStack || []).length < 600) S.allocStack.push({ sz, ra: m.r[31] >>> 0, caller: (m.rd32(((m.r[29] + 28) >>> 0)) >>> 0) });
    return (hdr + 16) >>> 0;
  }
  function hfree(p) {
    p = p >>> 0; if (!p) return;
    const info = S.liveAlloc.get(p); if (!info) return;   // 非本分配器指针 → 安全忽略
    S.liveAlloc.delete(p);
    const fl = S.freeList; fl.push({ addr: info.addr, size: info.size + 16 });
    fl.sort((a, b) => a.addr - b.addr);
    for (let i = 0; i < fl.length - 1; i++) { const a = fl[i], b = fl[i + 1]; if (((a.addr + a.size) >>> 0) === b.addr) { a.size += b.size; fl.splice(i + 1, 1); i--; } }
  }

  // ---- 2bpp 行交织(stride80: 40B低平面+40B高平面, 320x240) 像素写入 ----
  function putPix2(base, x, y, val) { // val 0..3
    if (x < 0 || y < 0 || x >= 320 || y >= 240) return;
    const rb = (base + y * 80) >>> 0, bit = 7 - (x & 7), byt = x >> 3;
    let b = m.rd8((rb + byt) >>> 0); b = (val & 1) ? (b | (1 << bit)) : (b & ~(1 << bit)); m.wr8((rb + byt) >>> 0, b);
    b = m.rd8((rb + 40 + byt) >>> 0); b = ((val >> 1) & 1) ? (b | (1 << bit)) : (b & ~(1 << bit)); m.wr8((rb + 40 + byt) >>> 0, b);
  }
  function putPixPacked(base, x, y, val) { // packed 2bpp: 字节=base+y*80+(x>>2), bit7-6=最左像素(游戏setpic布局)
    if (x < 0 || y < 0 || x >= 320 || y >= 240) return;
    const addr = (base + y * 80 + (x >> 2)) >>> 0, shift = 6 - (x & 3) * 2;
    const b = m.rd8(addr); m.wr8(addr, ((b & ~(3 << shift)) | ((val & 3) << shift)) >>> 0);
  }
  // ★矩形像素操作(packed 2bpp FB)★ 供 FillDDLcd(擦除/填充) 与 ReverseDDLcd(反显高亮) 复用。
  //   游戏 OS 约定: 参数为 (hdc, x1, y1, x2, y2), 闭区间像素坐标; y2 走栈(第5参), 由调用处读出后传入。
  //   op: 'set' → 用 val 填充; 'inv' → 每像素 v→3-v(反显)。越界像素自动裁剪。
  function rectOp(base, x1, y1, x2, y2, op, val) {
    if (x2 < x1) { const t = x1; x1 = x2; x2 = t; }
    if (y2 < y1) { const t = y1; y1 = y2; y2 = t; }
    if (x1 < 0) x1 = 0; if (y1 < 0) y1 = 0; if (x2 > 319) x2 = 319; if (y2 > 239) y2 = 239;
    for (let y = y1; y <= y2; y++) {
      const rb = (base + y * 80) >>> 0;
      for (let x = x1; x <= x2; x++) {
        const addr = (rb + (x >> 2)) >>> 0, shift = 6 - (x & 3) * 2, b = m.rd8(addr), v = (b >> shift) & 3;
        const nv = op === 'inv' ? (3 - v) : (val & 3);
        m.wr8(addr, ((b & ~(3 << shift)) | (nv << shift)) >>> 0);
      }
    }
  }
  function blitGlyph(base, x, y, g, darkVal, lightVal) { // 画一个点阵字, 返回字宽像素
    const nb = g.w;
    const tm = S.textMask;
    for (let r = 0; r < 16; r++) {
      let bits;
      if (nb === 16) bits = ((FONT[g.off + r * 2] << 8) | FONT[g.off + r * 2 + 1]) >>> 0;
      else bits = FONT[g.off + r] << 8; // ascii 8bit 左对齐到16
      for (let c = 0; c < nb; c++) {
        const on = (bits >> (15 - c)) & 1;
        if (lightVal != null) { putPixPacked(base, x + c, y + r, on ? darkVal : lightVal); if (tm && x+c>=0 && x+c<320 && y+r>=0 && y+r<240) tm[(y+r)*320+x+c]=1; }
        else if (on) { putPixPacked(base, x + c, y + r, darkVal); if (tm && x+c>=0 && x+c<320 && y+r>=0 && y+r<240) tm[(y+r)*320+x+c]=1; }
      }
    }
    return nb;
  }
  function resolveTarget(hdc) { const s = S.surfaces.get(hdc >>> 0); return s ? (s.ptr >>> 0) : (S.FB >>> 0); }

  // ★键码投递布局(实测钉死)★ gamGetMessage@0x32c 将 OS 结构字段拷到 GamMainMenu 的 gameBuf。
  //   GamMainMenu: 0x22838 lbu gameBuf[0]=消息类型(=0 走按键路径); 0x22850 lh v0,42(fp)=读 gameBuf[2..3] 半字作键码(不是 lw!)。
  //   包装层 gameBuf[2]=lhu(a1+2)。故键码必须作为 16 位半字写到 a1+2 → gameBuf[2..3]=code → lh 读到 code。
  //   (误写到 a1+4 会落到 gameBuf[4..5], 而 GamMainMenu 读 gameBuf[2..3] → v0=0 → 菜单不响应。)
  function feedKey(a1, code) { a1 >>>= 0; m.wr16(a1, 0); m.wr16((a1 + 2) >>> 0, code & 0xffff); m.wr16((a1 + 4) >>> 0, 0); }

  // GDI pixel write (into default frame)
  function ensureFrame(){ if(!S.frame){ S.frame=new Uint8Array(S.fw*S.fh); m._os=S; } }
  ensureFrame();

  // synthetic window/device object tree so getters return valid pointers
  S.win = alloc(0x400); S.dev = alloc(0x400); S.dev2 = alloc(0x400);
  m.wr32((S.win + 36) >>> 0, S.dev >>> 0);   // E9188MainWin reads *(win+36) then calls cb+0xbc with it
  m.wr32((S.win + 4) >>> 0, S.dev >>> 0);
  m.wr32((S.dev + 36) >>> 0, S.dev2 >>> 0);
  // register the window DC (0x700000) as the on-screen device backed by the framebuffer
  S.surfaces.set(S.win, { ptr: S.FB, w: S.lcdW, h: S.lcdH, size: S.lcdW * S.lcdH, lcd: true });

  function h(slot) {
    const r = m.r;
    const a0=r[4]>>>0, a1=r[5]>>>0, a2=r[6]>>>0, a3=r[7]>>>0;
    const name = SLOT[slot];
    switch (name) {
      case 'malloc': return halloc(a0);
      case 'free': return hfree(a0);
      case 'memcpy': case 'memmove': { for(let i=0;i<a2;i++) m.wr8((a0+i)>>>0, m.rd8((a1+i)>>>0)); if((S.memcpyLog=S.memcpyLog||[]).length<300) S.memcpyLog.push({dst:a0>>>0,src:a1>>>0,n:a2,ra:m.r[31]>>>0}); return a0; }
      case 'memset': { for(let i=0;i<a2;i++) m.wr8((a0+i)>>>0, a1&0xff); if(a2>=0x800&&(S.memsetLog=S.memsetLog||[]).length<80) S.memsetLog.push({a0:a0>>>0,n:a2,v:a1&0xff,ra:m.r[31]>>>0}); return a0; }
      case 'strlen': { let n=0; while(m.rd8((a0+n)>>>0)) n++; return n; }
      case 'strcpy': { let i=0,c; do{c=m.rd8((a1+i)>>>0); m.wr8((a0+i)>>>0,c); i++;}while(c); return a0; }
      case 'strcat': { let i=0; while(m.rd8((a0+i)>>>0)) i++; let j=0,c; do{c=m.rd8((a1+j)>>>0); m.wr8((a0+i+j)>>>0,c); j++;}while(c); return a0; }
      case 'GetSystemTime': return S.tick++;
      case 'DetectKeyState': { const k=a0>>>0; (S.keyPoll=S.keyPoll||new Map()).set(k,(S.keyPoll.get(k)||0)+1); if(S.keysAll) return 1; // 脚本化瞬时按下(方向键等走此通道): S.dkQ=[{key,hold}],游戏轮询到目标键时连续hold帧返回1
        if(S.dk && S.dk.key===k){ if(S.dk.hold>0){ S.dk.hold--; return 1; } S.dk=null; }
        if(!S.dk && S.dkQ && S.dkQ.length && k===S.dkQ[0].key){ const p=S.dkQ.shift(); S.dk={key:p.key, hold:(p.hold||4)-1}; if((S.dkFed=(S.dkFed||0)+1)<=30) console.log('  [dkPress] steps='+m.steps+' key='+p.key); return 1; }
        if(S.keysDown && S.keysDown.has(k)){ S.keysHit = (S.keysHit||new Set()).add(k); return 1; } return 0; }
      case 'rand': { S.randState = (S.randState*1103515245+12345)&0x7fffffff; return S.randState; }
      case 'srand': { S.randState = a0||1; return 0; }
      case 'GetMessage': case 'Delay': {
        // MSG layout (matches gamGetMessage wrapper): [msg:u16 @a1+0, wParam:u16 @a1+2, lParam:u16 @a1+4]
        if (S.queue && S.queue.length) {
          const q = S.queue.shift();
          feedKey(a1, q.wp); // ★键码写单字节到 a1+4(见 feedKey 注释)★
          S.msgCount++;
          if ((S.kqLog = S.kqLog || []).length < 30) S.kqLog.push({ code: q.wp, a1: a1 >>> 0, pumpRA: (S.pumpRA | 0) >>> 0, bytes: [m.rd8(a1 >>> 0), m.rd8((a1 + 2) >>> 0), m.rd8((a1 + 4) >>> 0)], ra: m.r[31] >>> 0 });
          if ((S.msgLog = S.msgLog || []).length < 40) S.msgLog.push({ msg: q.msg, wp: q.wp, lp: q.lp });
          return 1; // message retrieved
        }
        // caller-aware: harness sets S.pumpRA to gamGetMessage's caller RA. GamMainMenu(RA 0x22838) consumes msg==0/wParam==keycode to navigate.
        const pra = (S.pumpRA | 0);
        // movie skip: ShowMovieRes(RA 0x3f340) exits on wParam==7/150. ★必须移到 realtime 判定之前★: 否则实时模式会先 return, 电影跳过永不生效。
        if (S.skipMovies && pra === (S.movieRA | 0)) {
          const wp = (S.movieExitKey | 0) || 7;
          m.wr16(a1 >>> 0, 0); m.wr16((a1 + 2) >>> 0, wp); m.wr16((a1 + 4) >>> 0, 0);
          S.msgCount++;
          (S.movieSkips = (S.movieSkips || 0) + 1);
          if ((S.msgLog = S.msgLog || []).length < 60) S.msgLog.push({ msg: 0, wp, lp: 0, key: true, pra, movie: true });
          return 1;
        }
        if (S.realtime) {
          // 阶段1 boot: keyScript 未消费完 → 沿用离线"快速 tick + 门控脚本键"时序(不受真实时间节流)。
          // boot 开场动画/状态机需要成千上万个 tick 才能推进到主菜单, 若按真实时间节流会被饿死成"初始化失败"。
          if (S.keyScript && S.keyScript.length) {
            if (S.pumpKeyRAs && S.pumpKeyRAs.has((S.pumpRA | 0))) {
              const wp = S.keyScript.shift();
              m.wr16(a1 >>> 0, 0); m.wr16((a1 + 2) >>> 0, wp); m.wr16((a1 + 4) >>> 0, 0); S.msgCount++;
              return 1;
            }
            S.msgCount++; m.wr16(a1 >>> 0, 294); m.wr16((a1 + 2) >>> 0, 0); m.wr16((a1 + 4) >>> 0, 0);
            return 1;
          }
          // 阶段2 play: keyScript 已跑完(已到大地图) → 真实时间节奏: 到点发 tick, 否则置 _block 让出等待用户输入(像真机 GetMessage 阻塞)。
          const now = (opts.now ? opts.now() : Date.now());
          if (now - (S.lastTick || 0) >= (S.tickInterval || 40)) {
            S.lastTick = now; S.msgCount++;
            m.wr16(a1 >>> 0, 294); m.wr16((a1 + 2) >>> 0, 0); m.wr16((a1 + 4) >>> 0, 0);
            return 1;
          }
          m._block = true; return 0;
        }
        // caller-aware: 以下均为非实时(离线)分支; 实时模式已在上方 return。
        if (S.keyScript && S.keyScript.length && S.pumpKeyRAs && S.pumpKeyRAs.has(pra)) {
          const wp = S.keyScript.shift();
          m.wr16(a1 >>> 0, 0); m.wr16((a1 + 2) >>> 0, wp); m.wr16((a1 + 4) >>> 0, 0);
          S.msgCount++;
          if (S.onKey) S.onKey(wp, pra);
          if ((S.keyFeed = (S.keyFeed || 0) + 1) <= 40) console.log(`  [keyFeed] steps=${m.steps} pra=0x${(pra>>>0).toString(16)} a1=0x${(a1>>>0).toString(16)} wp=${wp}`);
          if ((S.msgLog = S.msgLog || []).length < 60) S.msgLog.push({ msg: 0, wp, lp: 0, key: true, pra });
          return 1;
        }
        // queue drained: synthesize the game's timer/movie tick (ShowMovieRes waits for msg 294=0x126)
        if (S.msgCount < S.msgMax) {
          S.msgCount++;
          const synth = (opts.tickMsg != null ? opts.tickMsg : 294);
          if (synth) { m.wr16(a1 >>> 0, synth); m.wr16((a1 + 2) >>> 0, 0); m.wr16((a1 + 4) >>> 0, 0); if ((S.msgLog = S.msgLog || []).length < 40) S.msgLog.push({ msg: synth, wp: 0, lp: 0, synth: true }); return 1; }
          return 0;
        }
        return -1; // no more messages -> main loop should unwind
      }
      case 'EnQMessage': {
        // a0=hwnd, a1=&{msg:u16,wParam:u16,lParam:u16}
        const msg = m.rd16(a1 >>> 0), wp = m.rd16((a1 + 2) >>> 0), lp = m.rd16((a1 + 4) >>> 0);
        (S.queue = S.queue || []).push({ hwnd: a0, msg, wp, lp });
        S.lastMsgCode = msg;
        if ((S.enqLog = S.enqLog || []).length < 40) S.enqLog.push({ hwnd: a0, msg, wp, lp });
        return 1;
      }
      case 'SetTimer': case 'SetTimer2': return 1;
      case 'KillTimer': case 'KillTimer2': return 0;
      case 'MessageBox': return 1;
      case 'InputDialog': {
        // Signature (confirmed via gamInputDialog 0x5170 / GamGetPlayerParam 0x3daa0):
        //   a0=prompt/template ptr, a1=INPUT RESULT buffer, a2=maxLen, a3=0.
        // Real OS blocks for keyboard entry and writes a NUL-terminated string into a1;
        // GamGetPlayerParam loops calling strlen(a1) and only advances when strlen>0.
        // ★浏览器实时(S.requestInput): 弹 iOS 键盘异步采集角色姓名。首次进入置 S.awaitInput 并阻塞
        //   (复用 GetMessage 的 m._block 挂起机制, pc 停在 API 地址), realtime 采到文本写入 S.pendingInput
        //   并清 awaitInput → 重入本调用时把文本落盘到 a1 缓冲再返回。node 诊断(requestInput 未置)走同步默认值。
        const maxLen = (a2 >>> 0) || 16;
        if (S.requestInput && !S.pendingInput && !S._inputSkip) {
          if (!S.awaitInput) { S.awaitInput = { buf: a1 >>> 0, maxLen, prompt: a0 >>> 0 }; if (S.onInputOpen) S.onInputOpen(S.awaitInput); }
          m._block = true; return 0;
        }
        const txt = (S.pendingInput != null) ? String(S.pendingInput) : (S.inputDefault != null ? S.inputDefault : 'PLAYER1');
        S.pendingInput = null; S.awaitInput = null;
        let i = 0; for (; i < txt.length && i < maxLen - 1; i++) m.wr8((a1 + i) >>> 0, txt.charCodeAt(i) & 0xff);
        m.wr8((a1 + i) >>> 0, 0); // NUL-terminate
        S.inputCount = (S.inputCount || 0) + 1;
        if ((S.inputLog = S.inputLog || []).length < 24) S.inputLog.push({ a0, a1, maxLen, wrote: txt });
        return 1; // confirm/OK
      }
      case 'CreateCDD': { const size=0x8000; const hnd=S.cddSeq>>>0; S.cddSeq=(S.cddSeq+size)>>>0; // g4f: 反汇编gamCreateCDD@0xba8证实—游戏把CreateCDD返回值存进对象offset0当dataptr,且直接当setpic的dst -> handle自身必须是可绘像素buffer(ptr=hnd,不用脏a1,不wr32污染buffer头)
        S.surfaces.set(hnd,{ptr:hnd,w:S.lcdW,h:S.lcdH,size,fmt:a0,cdd:true}); if((S.cddCalls=S.cddCalls||[]).length<24) S.cddCalls.push([a0,a1,a2,a3,hnd]); return hnd; }
      case 'DeleteCDD': return 0;
      case 'ClearDDLcd': { const p=S.FB; const n=a0||0; for(let i=0;i<Math.min(n||0, S.lcdW*S.lcdH);i++) m.wr8((p+i)>>>0, 0); if(S.textMask) S.textMask.fill(0); S.clears=(S.clears||0)+1; return 0; }
      // ★FillDDLcd(hdc, x1, y1, x2, y2): 游戏用它擦除/填充矩形(角色创建切换男/女前清空旧值就靠它)。
      //   实测签名: a0=hdc(0=物理LCD), a1=x1, a2=y1, a3=x2, 第5参 y2 在栈 sp+16。无颜色参 → 语义为擦成背景(值0)。
      //   (旧实现落到 default 什么都不做 → 切换时旧字不被擦 → 用户反馈的"男女文字重合"真因。)
      case 'FillDDLcd': { const sp=r[29]>>>0; const y2=m.rd32((sp+16)>>>0)&0xffff; rectOp(S.FB>>>0, a1|0, a2|0, a3|0, y2|0, 'set', 0); (S.fillDD=(S.fillDD||0)+1); return 0; }
      // ★ReverseDDLcd(hdc, x1, y1, x2, y2): 反显一个矩形 = 真机 STN-LCD 的"选中高亮"机制(反白当前行/项)。
      //   与 FillDDLcd 同签名(y2 在 sp+16)。之前未实现 → 面板选中项看不到高亮(用户问题4)。实现后所有走反显的面板自动高亮。
      case 'ReverseDDLcd': { const sp=r[29]>>>0; const y2=m.rd32((sp+16)>>>0)&0xffff; rectOp(S.FB>>>0, a1|0, a2|0, a3|0, y2|0, 'inv'); (S.revDD=(S.revDD||0)+1); return 0; }
      // ★g2g3c-a3定论: 反汇编gamScrDDBltDesDD@0xccc钉死—它只接(a0源obj,a1目标obj)两个参数,转调OS ScrDDBltDesDD也只传2参(a0/a1),从不设a2/a3! OS的ScrDDBltDesDD没有尺寸/偏移参数,总是整块surface拷贝。之前用寄存器残值a2(54/205)当拷贝长度=文字残留真凶(每次只刷几十字节,屏幕刷不干净)。present分支:a0==0→ScrDDBltDesDD(*(a1obj),gComPhyScr);save:a1==0→ScrDDBltDesDD(gComPhyScr,*(a0obj))
      // ★g2g3c 定论(反汇编钉死): gamScrDDBltDesDD@0xccc 与直接调用点@0x1cbc 都是把“数据指针(dataptr)”传给 OS ScrDDBltDesDD——
      //   包装层先 `lw a0,0(v1)` 把句柄解引用成 dataptr 再调 OS。故 OS 收到的 a0/a1 已是像素地址, 不应再解引用!
      //   旧 rdp 对未注册句柄做 rd32(h) → 把 0x228140(位于 0x228000 CDD 内的精灵/擦除源像素地址)当指针二次解引用得垃圾 → n=0 → 走路每步擦除失效 → 竖直拖影。
      //   修正: 未注册但本身落在合法 RAM 区间的地址直接当 dataptr 用; 否则再退回解引用(兼容个别句柄语义)。
      case 'ScrDDBltDesDD': { S.presentCount++; S.lastBlt={a0,a1,a2,a3}; const ok=a=>a>=0x1000&&a<0x4000000; const surf=h=>S.surfaces.get(h>>>0); const rdp=h=>{const s=surf(h); if(s)return s.ptr>>>0; const hu=h>>>0; if(ok(hu))return hu; const dv=m.rd32(hu)>>>0; return ok(dv)?dv:0;}; const sb=rdp(a0), db=rdp(a1); let copied=0; if(sb&&db){ const ss=surf(a0), ds=surf(a1); const full=S.lcdW*S.lcdH/4; let bytes=full; if(ss&&ds) bytes=Math.min(ss.size,ds.size); else if(ss||ds) bytes=Math.max(ss?ss.size:0, ds?ds.size:0); if(bytes<full||bytes>0x100000) bytes=full; const mem=m.mem; if(db+bytes<=mem.length && sb+bytes<=mem.length && !(m.protectCode && db<m.codeEnd && db+bytes>m.codeStart)){ mem.set(mem.subarray(sb, sb+bytes), db); } else { for(let i=0;i<bytes;i++) m.wr8((db+i)>>>0, m.rd8((sb+i)>>>0)); } copied=bytes; if(db===(S.FB>>>0)){if(S.textMask)S.textMask.fill(0);S.lastFrameBytes=copied;if(S.onPresent)S.onPresent();} } if((S.blitLog=S.blitLog||[]).length<240) S.blitLog.push({srcHnd:a0>>>0,dstHnd:a1>>>0,sb:sb>>>0,db:db>>>0,n:copied,a0In:S.surfaces.has(a0>>>0),a1In:S.surfaces.has(a1>>>0),rawDst:a1?(m.rd32(a1>>>0)>>>0):0,ra:m.r[31]>>>0,a2:a2>>>0,a3:a3>>>0}); return 0; }
      case 'DrawPixel': { ensureFrame(); S.drawCount++; if(S.drawCount<=8) S.pxSample=S.pxSample||[]; if((S.pxSample||[]).length<8) S.pxSample.push({a0,a1,a2,a3}); return 0; }
      case 'FillRect': case 'DrawRect': case 'DrawLine': case 'FillCircle': case 'DrawCircle': { S.drawCount++; return 0; }
      case 'PrintString': case 'PutString': { const str=rdStr(a1||a0); (S.strings=S.strings||new Set()).add(str);
              // 渲染文字到 FB(与 DrawText 相同逻辑): 参数布局 a0=DC, a1=str, a2=x, a3=y
              if(FONT && !S.noBlit && (a2|0)<=320 && (a3|0)<=240){ const base=S.drawTarget!=null?(S.drawTarget>>>0):resolveTarget(a0); const dk=(S.dtDark==null?0:S.dtDark), lt=(S.dtLight==null?null:S.dtLight);
                let x=a2|0, y=a3|0, p=(a1||a0)>>>0;
                for(let guard=0;guard<160;guard++){ const b0=m.rd8(p>>>0); if(!b0)break; const b1=b0<0x80?0:m.rd8((p+1)>>>0); const g=glyphOff(b0,b1); if(g) x+=blitGlyph(base,x,y,g,dk,lt); else x+=(b0<0x80?8:16); p+=(b0<0x80?1:2); }
              }
              S.drawCount++; return 0; }
      case 'DrawText': { const s=rdGB(a1); (S.texts=S.texts||[]).push({s,x:a2,y:a3});
              if(FONT && !S.noBlit){ const base=S.drawTarget!=null?(S.drawTarget>>>0):resolveTarget(a0); const dk=(S.dtDark==null?0:S.dtDark), lt=(S.dtLight==null?null:S.dtLight);
                let x=a2|0, y=a3|0, p=a1>>>0;
                for(let guard=0;guard<160;guard++){ const b0=m.rd8(p>>>0); if(!b0)break; const b1=b0<0x80?0:m.rd8((p+1)>>>0); const g=glyphOff(b0,b1); if(g) x+=blitGlyph(base,x,y,g,dk,lt); else x+=(b0<0x80?8:16); p+=(b0<0x80?1:2); }
                if((S._dt=(S._dt||0)+1)<=8) console.log('  [DrawText->buf] #'+S._dt+' base=0x'+base.toString(16)+' x='+a2+' y='+a3+' "'+s+'"');
              } else if((S._dt=(S._dt||0)+1)<=40) console.log('  [DrawText] #'+S._dt+' x='+a2+' y='+a3+' "'+s+'"');
              S.drawCount++; return 0; }
      case 'itoa': { // ABI: (a0=dst_buf, a1=src_table, a2=flag, a3=value) → 格式化 a3 十进制到 a0
        const v = a3 >>> 0; const s = String(v);
        let i = 0; for (; i < s.length; i++) m.wr8((a0 + i) >>> 0, s.charCodeAt(i));
        m.wr8((a0 + i) >>> 0, 0); return a0;
      }
      case 'get730': return S.win;
      case 'winGet': return S.win;
      case 'getBC': return S.dev;
      case 'fopen': {
        const nm = rdStr(a0); (S.opened = S.opened || []).push(nm);
        let buf = null;
        // ★存档文件(.sav): 透明可读写代理。游戏 fwrite 存进度→写进 S.savStore 并持久化; fread 读档→回吐 S.savStore。多槽由 realtime.js 面板管理。
        if (/\.sav/i.test(nm)) { const fd = S.fdSeq++; S.openFiles.set(fd, { savRef: true, pos: 0 }); return fd; }
        else if (S.vfs) {
          if (S.vfs.byName) for (const [k, v] of S.vfs.byName) { if (nm.indexOf(k) >= 0 || k.indexOf(nm) >= 0) { buf = v; break; } }
          if (!buf) buf = S.vfs.default || null;
        }
        if (!buf) return 0;
        const fd = S.fdSeq++; S.openFiles.set(fd, { buf, pos: 0 }); return fd;
      }
      case 'fread': { // a0=fd, a1=ptr, a2=size
        const f = S.openFiles.get(a0 >>> 0); if (!f) { if((S.badFd=S.badFd||[]).length<40) S.badFd.push({fd:a0>>>0,ptr:a1>>>0,n:a2>>>0,ra:m.r[31]>>>0}); return 0; }
        if (f.savRef) {
          const store = S.savStore || new Uint8Array(0);
          if (store.length === 0) { let nn = a2 >>> 0; if (nn > 0x00ffffff) nn = 0; for (let i = 0; i < nn; i++) m.wr8((a1 + i) >>> 0, 0); f.pos += nn; return nn; }  // 无存档: 清零+报告读满, 破游戏读档死循环
          let n = a2 >>> 0; if (n > 0x00ffffff) n = 0; const end = Math.min(f.pos + n, store.length); let cnt = 0;
          for (let p = f.pos; p < end; p++) { m.wr8((a1 + cnt) >>> 0, store[p]); cnt++; } f.pos = end;
          if ((S.fileLog = S.fileLog || []).length < 48) S.fileLog.push({ op: 'savread', pos: f.pos, n: cnt, size: store.length });
          return cnt;
        }
        let n = a2 >>> 0; if (n > 0x00ffffff) n = 0; const end = Math.min(f.pos + n, f.buf.length);
        const from = f.pos;
        let cnt = 0; for (let p = f.pos; p < end; p++) { m.wr8((a1 + cnt) >>> 0, f.buf[p]); cnt++; } f.pos = end;
        if (a1 >>> 0 >= 0x63ddd0 && a1 >>> 0 < 0x63ddf0 && (S.ddeReads = S.ddeReads || []).length < 20) S.ddeReads.push({ fd: a0 >>> 0, from: from >>> 0, n, ptr: a1 >>> 0, head: Array.from(f.buf.slice(from, Math.min(from + 16, f.buf.length))) });
        if ((S.fileLog = S.fileLog || []).length < 48) S.fileLog.push({ op: 'read', fd: a0 >>> 0, pos: from, n, ptr: a1 >>> 0, head: Array.from(f.buf.slice(from, Math.min(from + 8, f.buf.length))) });
        return cnt;
      }
      case 'fwrite': { const f = S.openFiles.get(a0 >>> 0); if (!f) return 0; let n = a2 >>> 0; if (n > 0x00ffffff) n = 0;
                if (f.savRef) { let store = S.savStore || new Uint8Array(0); const need = f.pos + n; if (need > store.length) { const ns = new Uint8Array(need); ns.set(store); store = ns; S.savStore = store; } for (let i = 0; i < n; i++) store[f.pos + i] = m.rd8((a1 + i) >>> 0); f.pos += n; S.savDirty = true; if (S.persistSav) S.persistSav(); S._savSaved = Date.now(); if ((S.fileLog = S.fileLog || []).length < 48) S.fileLog.push({ op: 'savwrite', pos: f.pos, n, size: store.length }); return n; }
        const need = f.pos + n; if (need > f.buf.length) { const ns = new Uint8Array(need); ns.set(f.buf); f.buf = ns; } for (let i = 0; i < n; i++) f.buf[f.pos + i] = m.rd8((a1 + i) >>> 0); f.pos += n; return n; }
      case 'fseek': { const f = S.openFiles.get(a0 >>> 0); if (!f) return -1; const sz = f.savRef ? (S.savStore ? S.savStore.length : 0) : f.buf.length; const base = a2 === 2 ? sz : a2 === 1 ? f.pos : 0; let np = base + (a1 | 0); if (np < 0) np = 0; f.pos = np; if ((S.fileLog = S.fileLog || []).length < 48) S.fileLog.push({ op: 'seek', fd: a0 >>> 0, to: np, whence: a2, off: a1 | 0 }); return 0; }
      case 'ftell': { const f = S.openFiles.get(a0 >>> 0); const wsz = f ? (f.savRef ? (S.savStore ? S.savStore.length : 0) : f.buf.length) : -1; if ((S.fileLog = S.fileLog || []).length < 48) S.fileLog.push({ op: 'tell', fd: a0 >>> 0, pos: f ? f.pos : -1, size: wsz }); return f ? f.pos : -1; }
      case 'feof': { const f = S.openFiles.get(a0 >>> 0); const sz = f ? (f.savRef ? (S.savStore ? S.savStore.length : 0) : f.buf.length) : 0; return f && f.pos >= sz ? 1 : 0; }
      case 'fclose': { const f = S.openFiles.get(a0 >>> 0); if (f && f.savRef && S.persistSav) S.persistSav(); S.openFiles.delete(a0 >>> 0); return 0; }
      default: return undefined;
    }
  }

  function onApi(slot, mm) {
    slot = slot | 0;
    S.counts.set(slot, (S.counts.get(slot)||0)+1);
    if (S.order.length < 4000) S.order.push(slot);
    if (S.calls.length < S.maxLog) S.calls.push({slot, name:SLOT[slot]||('0x'+slot.toString(16)), a0:mm.r[4]>>>0, a1:mm.r[5]>>>0, a2:mm.r[6]>>>0, a3:mm.r[7]>>>0, pc:mm.pc>>>0});
    const v = h(slot);
    if (v === undefined) { S.unknown.set(slot,(S.unknown.get(slot)||0)+1); return 0; }
    return v|0;
  }

  return { onApi, S, SLOT, CB, CB_SLOT };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { makeOS, CB, SLOT, setFont };
else if (typeof window !== 'undefined') window.BBK_OS = { makeOS, CB, SLOT, setFont };
