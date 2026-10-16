// realtime.js — 幻世传说 浏览器实时可玩 harness (iOS WKWebView 可直接复用)
// 装载原生 hss.exe → JS 大端 MIPS 解释器逐指令执行 → 飞天OS shim 拦截 → 实时帧循环 + canvas 平滑渲染 + 键盘/触摸双通道输入。
(function () {
  'use strict';
  const { loadBBK, Mips } = window.BBK;
  const { makeOS, setFont } = window.BBK_OS;

  // 真机 STN-LCD 四灰阶调色板(按 buffer 值 V 索引): 低值=亮(真机极性); V0/V1 拉近以打散游戏抖动→地面平滑; 窄对比+青灰调→舒适
  const PAL = [[206, 213, 201], [180, 188, 176], [112, 122, 112], [42, 48, 46]];
  const TEXT_COLOR = [0, 120, 237]; // DrawText 文字专用蓝色(通过 textMask 标记, 不影响地图/角色等)
  const W = 320, H = 240, FBSTRIDE = 80;

  // 键码: 方向走 DetectKeyState(轮询"当前是否按住"), 其余离散键走 GetMessage 队列
  const DIR = { ArrowUp: 146, ArrowDown: 152, ArrowLeft: 145, ArrowRight: 153 };
  window.__capOn = (new URLSearchParams(location.search).get('cap') === '1');
  const KEY_CONFIRM = 7, KEY_BACK = 150, KEY_FUNC = 112;

  let m = null, S = null, running = false, frameCount = 0, presentCount = 0;
  let lastNZ = 0;           // 上一"有效帧"的非零字节数, 用于 render 的清屏中间态保护(防走路闪烁)
  let offCanvas, offCtx, dispCanvas, dispCtx, imgData;

  // ★主菜单高亮★ 幻世传说主菜单的选中态靠真机 STN-LCD 硬件反显当前行, 既不写回 framebuffer、也无任何带坐标的绘制/反显 API
  //   (实测: 每次按方向键游戏只 blit 一次不含光标的同一张背景, FB hash 恒定)。软件层拿不到真实光标位置,
  //   故由模拟器自维护一个光标 index, 在 canvas 上叠加高亮框+箭头。启动默认第2项"再入尘世"(用户实测), 上下循环。
  const MENU_ROWS = [0.083, 0.326, 0.556, 0.785];   // 4 个选项牌匾 y 中心比例(实测主菜单图 320x240)
  const MENU_MAIN_RA = 0x22838;                      // GamMainMenu 调 GetMessage 的返回地址 → 判定当前处于主菜单
  let menuIdx = 1, menuWasIn = false;
  function inMainMenu() { return !!S && (S.pumpRA >>> 0) === MENU_MAIN_RA; }
  function menuMove(dir) { menuIdx = (menuIdx + dir + MENU_ROWS.length) % MENU_ROWS.length; }

  // ---- 交互面板通用高亮(硬件反显不可见, 自绘琥珀色三角) ----
  // 排除列表: 大地图/主菜单/角色创建/剧情对白/电影/状态面板(只读) 不走面板高亮
  const NON_PANEL_RAS = new Set([0x11b2c, 0x22838, 0x22834, 0x3dd30, 0x56ec, 0x5704, 0x3f340, 0x44c38, 0x312f8]);
  // 交易界面(0x312f8): 商品网格二维光标
  const TRADE_RA = 0x312f8;
  const TRADE_COLS = 5, TRADE_ROWS = 4; // 商品网格 5列×4行
  const TRADE_GRID = { x: 0.55, y: 0.23, w: 0.42, h: 0.60 }; // 网格区域(比例)
  let tradeCol = 0, tradeRow = 0, tradeWasIn = false;
  function inTrade() { return !!S && (S.pumpRA >>> 0) === TRADE_RA; }
  // 面板选项配置: RA→选项数; 未知交互面板默认4项
  const PANEL_N_MAP = { 0x18648: 4, 0x1102c: 4, 0x2534c: 4 };
  const PANEL_CY_DEF = [0.22, 0.40, 0.58, 0.76]; // 4项的 y 中心比例
  let panelCursor = 0, panelWasIn = false;
  function isPanelScene() { return !!S && presentCount >= 1 && !NON_PANEL_RAS.has(S.pumpRA >>> 0) && !inMainMenu(); }
  function panelN() { const ra = S ? (S.pumpRA >>> 0) : 0; return PANEL_N_MAP[ra] || 4; }
  function panelCY() { return PANEL_CY_DEF; } // 暂用默认比例, 后续可按 RA 微调
  function panelMove(dir) { panelCursor = (panelCursor + dir + panelN()) % panelN(); }

  const logEl = () => document.getElementById('out');
  function log(s) { const e = logEl(); if (e) { e.textContent += s + '\n'; e.scrollTop = e.scrollHeight; } }

  async function fetchBuf(url) { const r = await fetch(url); if (!r.ok) throw new Error('fetch ' + url + ' -> ' + r.status); return await r.arrayBuffer(); }
  async function fetchJson(url) { const r = await fetch(url); if (!r.ok) throw new Error('fetch ' + url + ' -> ' + r.status); return await r.json(); }

  // ★带进度的下载(读 Content-Length + 流式累计), from~to 映射到总进度区间★
  async function fetchProg(url, label, from, to) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('fetch ' + url + ' -> ' + r.status);
    const total = parseInt(r.headers.get('Content-Length') || '0', 10);
    if (!r.body || !r.body.getReader || !total) { const buf = await r.arrayBuffer(); setBoot(label, to); return buf; }
    const reader = r.body.getReader(); const chunks = []; let loaded = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; loaded += value.length; chunks.push(value); setBoot(label, from + (to - from) * Math.min(1, loaded / total)); }
    const out = new Uint8Array(loaded); let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    setBoot(label, to); return out.buffer;
  }

  // 加载层 UI 更新(找不到元素则静默)
  function setBoot(text, pct) {
    const l = document.getElementById('bootText'); const b = document.getElementById('bootBar'); const p = document.getElementById('bootPct');
    if (l && text != null) l.textContent = text;
    if (b && pct != null) b.style.width = Math.round(Math.max(0, Math.min(1, pct)) * 100) + '%';
    if (p && pct != null) p.textContent = Math.round(Math.max(0, Math.min(1, pct)) * 100) + '%';
  }
  let bootHidden = false;
  function hideBoot() { if (bootHidden) return; bootHidden = true; const e = document.getElementById('booting'); if (e) { e.classList.add('hidden'); setTimeout(() => { e.style.display = 'none'; }, 400); } }

  // 重定位(仅对 COMMON 符号施加) — 与 play.js 一致
  function applyRelocs(R) {
    const s16 = x => (x & 0xffff) >= 0x8000 ? (x & 0xffff) - 0x10000 : (x & 0xffff);
    const cs = new Set(Object.keys(R.comaddr));
    for (const [pc, typ, sym, val] of R.relocs) {
      const vv = val >>> 0; if (!(cs.has(sym) || (vv >= 0x600000 && vv < 0x700000))) continue;
      const w = m.rd32(pc) >>> 0;
      if (typ === 'REFHI') { const ad = s16(w); let v = (val + ad) >>> 0; if ((v & 0xffff) >= 0x8000) v += 0x10000; m.wr32(pc, ((w & 0xffff0000) | ((v >>> 16) & 0xffff)) >>> 0); }
      else if (typ === 'REFLO') { const ad = s16(w); m.wr32(pc, ((w & 0xffff0000) | (((val + ad) >>> 0) & 0xffff)) >>> 0); }
      else if (typ === 'JMPADDR') { const ad = (w & 0x03ffffff) | ((w & 0x02000000) ? 0xfc000000 : 0); const t = (val + (ad << 2)) >>> 0; m.wr32(pc, ((w & 0xfc000000) | ((t >>> 2) & 0x03ffffff)) >>> 0); }
    }
  }

  async function boot() {
    const btn = document.getElementById('run'); if (btn) { btn.disabled = true; btn.hidden = true; }
    try {
      setBoot('下载游戏程序…', 0);
      const exeBuf = await fetchProg('hss.exe', '下载游戏程序', 0, 0.6);
      setBoot('下载字体资源…', 0.6);
      const fontBuf = new Uint8Array(await fetchProg('font.bin', '下载字体资源', 0.6, 0.75));
      const R = await fetchJson('hss_reloc_resolved.json');
      setBoot('装载字体…', 0.78);
      setFont(fontBuf);
      setBoot('解析程序结构…', 0.82);
      const L = loadBBK(exeBuf);
      setBoot('初始化引擎…', 0.85);
      log(`装载: entry=0x${L.entry.toString(16)} codeEnd=0x${L.codeEnd.toString(16)} imgEnd=0x${L.imgEnd.toString(16)}`);
      m = new Mips(L.mem, L.codeEnd, { maxSteps: Number.MAX_SAFE_INTEGER });
      m.unimp = new Map();
      // ★代码段写保护必须在 applyRelocs 之后再开启★
      // (重定位靠 m.wr32 往代码段写补丁; 若先开 protectCode, 补丁会被丢弃 → 跳转地址未修正 → boot 洪水崩溃)
      const os = makeOS(m, { msgMax: Infinity, vfs: { default: new Uint8Array(exeBuf) } });
      S = os.S; m.onApi = os.onApi;

      // 实时输入/渲染配置 — boot 阶段直接复用离线的 GetMessage 路径(队列→动画跳过→脚本键门控→合成tick)。
      // 关键教训: 实时"阻塞+节流tick"会把开场动画泵饿死/洪水→游戏状态机跳进崩溃自旋向量(pc=0x24<->0x34)。
      // 离线整个开场只需 16 个脚本键 + 十来个消息(msgCount~31)即到大地图, 之后引擎靠 DetectKeyState 轮询自驱。
      S.keysDown = new Set();          // DetectKeyState 读它(当前按住的方向键) — 实时移动通道
      S.queue = S.queue || [];         // 离散键(确认/返回)经 GetMessage 消费 — 实时菜单/对话通道
      S.realtime = (new URLSearchParams(location.search).get('rt') !== '0'); // ★启用实时 GetMessage: 队列优先→开场电影跳过→阶段2 真实时间 tick/阻塞。修复“无限 294 洪水直接冲进女娲开场、跳过主菜单”
      S.drawTarget = 0xfe00000;        // 直接写屏的文字画到 LCD framebuffer (须与 os.js 的 S.FB 一致)
      S.dtDark = 3;                    // 笔画=高值(真机面板高值=暗墨)
      // ★角色创建姓名: 启用 iOS 键盘异步输入。os.js InputDialog 检测 requestInput 会阻塞并回调 onInputOpen,
      //   由 showNameInput 弹输入框; 用户提交后写 S.pendingInput, loop 恢复步进 → InputDialog 重入落盘姓名。
      S.requestInput = true;
      S.onInputOpen = (info) => showNameInput(info);
      // 开场动画跳过(离线必需配置! 缺此则 boot 动画泵 ra=0x3f340 收不到退出键而洪水崩溃):
      S.movieRA = 0x3f340; S.skipMovies = (new URLSearchParams(location.search).get('noskip') !== '1'); S.movieExitKey = 7;
      S.onPresent = () => { presentCount++; if (window.__capOn) captureFB(); };
      m.pcHooks = new Map([
        [0x22ac4, (mm) => { if (!S._ngFired) { S._ngFired = 1; S._afterNG = true; } }],
        [0x32c, (mm) => { S.pumpRA = mm.r[31] >>> 0; }], // gamGetMessage 调用者(供开场脚本键门控)
      ]);
      // 开场自动导航(与离线一致): 依次点过 boot/主菜单/角色创建 到达大地图, 之后交给实时输入
      // 开场自动导航: 仅用于跳过 boot 开场(落到游戏主菜单), 不再自动穿过主菜单/角色创建。
      // 空数组 = 游戏停在主菜单(重新修炼/再入尘世/设置游戏/制作群组), 由用户用屏幕按键自行选择进入。
      S.pumpKeyRAs = new Set([0x22838, 0x22834, 0x3dd30, 0x56ec, 0x5704, 0x11b2c, 0x18648, 0x44c38, 0x1102c, 0x2534c, 0x312f8]);
      S.keyScript = (new URLSearchParams(location.search).get('auto') === '1') ? [146, 7, 7, 7, 152, 7, 152, 152, 7, 7, 7, 7, 7, 7, 7, 7] : [];
      window.__rt = { press: discrete, hold: pressDir, char: charKey, release: releaseDir, _m: () => m, _S: () => S, st: () => ({ steps: m.steps, pc: m.pc >>> 0, running: m.running, present: presentCount, msg: S.msgCount, pumpRA: S.pumpRA >>> 0, lastTickAgo: S.lastTick ? (Date.now() - S.lastTick) : -1, keysDown: [...S.keysDown], qLen: S.queue.length, scriptLeft: S.keyScript.length }) };

      setBoot('重定位补丁…', 0.88);
      applyRelocs(R);
      // 调试: ?watch=1 监视菜单背景句柄地址区的写入(定位 0xffffffff 来源)。
      if (new URLSearchParams(location.search).get('watch') === '1') { m.codeMon = { lo: 0x63dd00, hi: 0x63de00 }; m.codeWrites = []; }
      // 重定位完成后才上代码写保护(与离线 play.js 顺序一致): 丢弃运行期对代码区的越界写, 防止 setpic 污染指令。
      m.codeStart = L.entry >>> 0; m.protectCode = true;
      log('重定位完成, 启动实时循环。用方向键移动、确认键推进。');
      setBoot('启动引擎…', 0.95);

      // canvas
      offCanvas = document.createElement('canvas'); offCanvas.width = W; offCanvas.height = H; offCtx = offCanvas.getContext('2d');
      imgData = offCtx.createImageData(W, H);
      dispCanvas = document.getElementById('fb'); dispCtx = dispCanvas.getContext('2d');

      running = true; m.pc = L.entry >>> 0; m.r[31] = m.EXIT;
      requestAnimationFrame(loop);
    } catch (e) { log('启动失败: ' + e.message + '\n' + (e.stack || '')); setBoot('启动失败: ' + ((e && e.message) ? e.message : String(e)), null); const btn = document.getElementById('run'); if (btn) { btn.disabled = false; btn.hidden = false; } }
  }

  let _lastSavSaved = 0;
  function loop() {
    if (!running) return;
    // 等待 iOS 键盘输入姓名: 游戏阻塞在 InputDialog, 暂停步进(仅保持渲染上一帧), 等 overlay 提交后自动恢复。
    if (S && S.awaitInput) { render(); requestAnimationFrame(loop); return; }
    const t0 = performance.now();
    const budget = 11; // ms/帧 的模拟步数预算(保持 UI 60fps 与输入响应)
    while (m.running && (performance.now() - t0) < budget) {
      let blocked = false;
      for (let i = 0; i < 4000 && m.running; i++) { m.step(); if (m._blockedNow) { m._blockedNow = false; blocked = true; break; } }
      if (blocked) break; // 游戏在 GetMessage 阻塞等输入/下一 tick → 让出本帧, 等真实时间推进
    }
    if (!m.running) { log('主循环退出(reason=exit), 停止。steps=' + m.steps); running = false; }
    // 刚进入主菜单(首次到达或从子界面返回)→光标复位到默认第2项, 与游戏启动默认对齐
    const nowIn = inMainMenu();
    if (nowIn && !menuWasIn) menuIdx = 1;
    menuWasIn = nowIn;
    const nowInP = isPanelScene();
    if (nowInP && !panelWasIn) panelCursor = 0;
    panelWasIn = nowInP;
    const nowInT = inTrade();
    if (nowInT && !tradeWasIn) { tradeCol = 0; tradeRow = 0; }
    tradeWasIn = nowInT;
    render();
    frameCount++;
    if (!bootHidden && (presentCount >= 1 || frameCount >= 120)) hideBoot();
    if (frameCount % 30 === 0) updateHud();
    // 游戏内存档自动保存后弹提示
    if (S._savSaved && S._savSaved !== _lastSavSaved) { _lastSavSaved = S._savSaved; toast('已自动保存 ✓'); }
    requestAnimationFrame(loop);
  }

  // 每帧从 FB 解码到 canvas。两类画面更新都要捕获: (1)游戏整屏 blit 到 FB(走路/场景); (2)游戏直接写 FB 内存(主菜单光标移动, 不触发 blit/onPresent)。
  // 闪烁防护: 游戏常在 blit 前先 ClearDDLcd 清空 FB; 若 render 撞上"已清空未回填"的中间态就会闪黑。故统计本帧 FB 非零字节 nz,
  // 相比上一有效帧骤降(<40%)即判为清屏中间态 → 跳过本次重绘保持上一帧。菜单光标移动 nz 稳定, 正常刷新 → 修复"方向键没反应"。
  function render() {
    if (!S || !dispCtx || !imgData) return;
    const off = S.FB >>> 0, d = imgData.data, mem = m.mem;
    const tm = S.textMask; // 文字像素掩码(1=DrawText画的字)
    let nz = 0;
    for (let y = 0; y < H; y++) {
      const rb = off + y * FBSTRIDE;
      const tmb = y * W;
      for (let x = 0; x < W; x += 4) {
        const byte = mem[rb + (x >> 2)]; if (byte) nz++;
        for (let k = 0; k < 4; k++) {
          const v = ((byte >> (6 - k * 2)) & 3);
          const px = tmb + x + k;
          const c = (tm && tm[px]) ? TEXT_COLOR : PAL[v];
          const p = px * 4;
          d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = 255;
        }
      }
    }
    if (lastNZ > 2000 && nz < 150) return;   // 仅当 FB 几乎全空(游戏 ClearDDLcd 清屏后尚未 blit 回填的瞬态, nz≈0)才跳过保持上一帧防闪黑。
    //   ★必须用绝对低阈值而非"相对上一帧比例": 角色创建等合法稳态画面像素很稀疏(实测 nz 仅~507, 远低于主菜单~18050), 用 nz<lastNZ*0.4 会把它误判成清屏而整帧不显示(用户反馈"看不到角色创建界面"的真因)。
    lastNZ = nz;
    offCtx.putImageData(imgData, 0, 0);
    dispCtx.imageSmoothingEnabled = true; dispCtx.imageSmoothingQuality = 'high';
    dispCtx.clearRect(0, 0, dispCanvas.width, dispCanvas.height);
    dispCtx.drawImage(offCanvas, 0, 0, dispCanvas.width, dispCanvas.height);
    if (inMainMenu()) drawMenuHighlight();
    if (isPanelScene()) drawPanelHighlight();
    if (inTrade()) drawTradeCursor();
    if (_dbgOn) drawDebugOverlay();
  }

  // 在主菜单当前选中项上叠加高亮框 + 左侧箭头(琥珀色, 醒目但不遮挡文字)
  // 菜单面板高亮(硬件反显不可见, 自绘半透明背景条+左侧三角)
  function drawPanelHighlight() {
    const cw = dispCanvas.width, ch = dispCanvas.height;
    const cy = panelCY()[panelCursor] * ch;
    const rowH = ch * 0.14; // 行高约14%画面
    dispCtx.save();
    // 半透明背景条
    dispCtx.fillStyle = 'rgba(255,214,90,0.18)';
    dispCtx.fillRect(cw * 0.08, cy - rowH / 2, cw * 0.84, rowH);
    // 左侧三角
    dispCtx.fillStyle = 'rgba(255,214,90,0.95)';
    const s = cw * 0.018;
    const ax = cw * 0.05;
    dispCtx.beginPath(); dispCtx.moveTo(ax, cy - s); dispCtx.lineTo(ax + s * 1.5, cy); dispCtx.lineTo(ax, cy + s); dispCtx.closePath(); dispCtx.fill();
    dispCtx.restore();
  }

  // 交易界面商品网格光标(琥珀色矩形框)
  function drawTradeCursor() {
    const cw = dispCanvas.width, ch = dispCanvas.height;
    const gx = TRADE_GRID.x * cw, gy = TRADE_GRID.y * ch;
    const gw = TRADE_GRID.w * cw, gh = TRADE_GRID.h * ch;
    const cellW = gw / TRADE_COLS, cellH = gh / TRADE_ROWS;
    const cx = gx + tradeCol * cellW, cy = gy + tradeRow * cellH;
    dispCtx.save();
    dispCtx.strokeStyle = 'rgba(255,214,90,0.92)'; dispCtx.lineWidth = Math.max(2, cw * 0.008);
    dispCtx.strokeRect(cx + 2, cy + 2, cellW - 4, cellH - 4);
    dispCtx.restore();
  }

  function drawMenuHighlight() {
    const cw = dispCanvas.width, ch = dispCanvas.height;
    const disabled = (menuIdx === 1) && !(S && S.savStore && S.savStore.length);   // "再入尘世"=读档: 无存档时标灰不可用, 载入过存档后恢复可用(琥珀色)
    const col = disabled ? 'rgba(214,218,214,0.96)' : 'rgba(255,214,90,0.95)';
    const cy = MENU_ROWS[menuIdx] * ch, hh = 0.058 * ch, hw = 0.185 * cw, cx = 0.5 * cw;
    dispCtx.save();
    dispCtx.strokeStyle = col; dispCtx.lineWidth = Math.max(2, cw * 0.007);
    dispCtx.strokeRect(cx - hw, cy - hh, hw * 2, hh * 2);
    dispCtx.fillStyle = col;
    const ax = cx - hw - cw * 0.02, s = cw * 0.018;
    dispCtx.beginPath(); dispCtx.moveTo(ax, cy - s); dispCtx.lineTo(ax + s * 1.5, cy); dispCtx.lineTo(ax, cy + s); dispCtx.closePath(); dispCtx.fill();
    if (disabled) {
      const tip = '「再入尘世」无存档';
      dispCtx.font = 'bold ' + Math.max(11, Math.round(cw * 0.04)) + 'px -apple-system, "PingFang SC", sans-serif';
      dispCtx.textBaseline = 'middle'; dispCtx.textAlign = 'center';
      const ty = ch * 0.93, tw = dispCtx.measureText(tip).width;
      dispCtx.fillStyle = 'rgba(0,0,0,0.6)'; dispCtx.fillRect(cx - tw / 2 - 6, ty - ch * 0.038, tw + 12, ch * 0.076);
      dispCtx.fillStyle = 'rgba(255,178,150,0.98)'; dispCtx.fillText(tip, cx, ty);
    }
    dispCtx.restore();
  }

  // ---- 角色创建姓名: iOS 键盘输入 overlay (由 os.js InputDialog 的 onInputOpen 回调拉起) ----
  //   受 16x16 GBK 点阵字库限制, 本框仅接受 ASCII(英文/数字); 中文需 GBK 编码表, 列为后续。
  let _nameEl = null;
  function showNameInput(info) {
    if (!_nameEl) {
      const wrap = document.createElement('div'); wrap.id = 'nameInput';
      wrap.style.cssText = 'display:none;position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.72);align-items:center;justify-content:center;';
      wrap.innerHTML = '<div style="width:82%;max-width:340px;background:#1b2028;border:1px solid #3a424d;border-radius:12px;padding:18px;color:#dfe7ef;font:14px/1.5 -apple-system;">'
        + '<div style="font-weight:700;font-size:17px;color:#e8c46a;margin-bottom:12px;">输入角色姓名</div>'
        + '<input id="nameInputField" type="text" maxlength="12" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="如 HERO01" style="width:100%;box-sizing:border-box;background:#0e1319;border:1px solid #3a424d;border-radius:8px;color:#fff;font:17px/1 -apple-system;padding:12px;outline:none;" />'
        + '<div style="font-size:11px;opacity:.6;margin-top:9px;">姓名请用英文/数字(点阵字库暂不支持中文)</div>'
        + '<div style="display:flex;gap:10px;margin-top:16px;"><button id="nameInputOk" style="flex:1;background:#2d5aa8;border:0;border-radius:8px;color:#fff;font:600 16px/1 -apple-system;padding:13px;">确定</button></div>'
        + '</div>';
      document.body.appendChild(wrap); _nameEl = wrap;
      const field = wrap.querySelector('#nameInputField');
      const commit = () => { const v = (field.value || '').replace(/[^\x20-\x7e]/g, '').slice(0, Math.max(1, (S._nameMaxLen || 16) - 1)); S.pendingInput = v || 'PLAYER1'; S.awaitInput = null; wrap.style.display = 'none'; if (field.blur) field.blur(); };
      wrap.querySelector('#nameInputOk').onclick = commit;
      field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
    }
    S._nameMaxLen = (info && info.maxLen) || 16;
    const field = _nameEl.querySelector('#nameInputField'); field.value = '';
    _nameEl.style.display = 'flex';
    setTimeout(() => { try { field.focus(); } catch (e) {} }, 80);
  }

  // ---- 调试叠加: 直接画到 canvas 画面左上角(避免被 iPhone 状态栏/刘海遮挡 DOM 元素) ----
  //   坐标 X=16bit@0x69322c(实测右走 100→124、左走回落 100); Y 地址待真机校准(先给候选 0x69322e)。
  const SCENE = { 0x22838: '主菜单', 0x22834: '主菜单', 0x3dd30: '角色创建', 0x11b2c: '世界·女娲宫', 0x18648: '菜单/游戏选项', 0x44c38: '状态面板', 0x2534c: '行囊面板', 0x45de4: '技能面板', 0x1102c: '任务面板', 0x188e0: '系统面板', 0x56ec: '剧情对白' };
  let _dbgOn = true;
  function drawDebugOverlay() {
    if (!dispCtx || !S) return;
    const cw = dispCanvas.width, ch = dispCanvas.height;
    const ra = (S.pumpRA >>> 0) || 0;
    const scene = SCENE[ra] || ('0x' + ra.toString(16));
    let x = '?';
    try { if (m) { x = m.rd16(0x69322c) >>> 0; } } catch (e) {}
    const sav = (S.savStore && S.savStore.length) ? (S.savStore.length + 'B') : '无';
    const txt = scene + '  X=' + x + '  档:' + sav;
    dispCtx.save();
    dispCtx.font = 'bold ' + Math.max(12, Math.round(cw * 0.028)) + 'px ui-monospace,Menlo,monospace';
    dispCtx.textBaseline = 'top';
    const tw = dispCtx.measureText(txt).width;
    dispCtx.fillStyle = 'rgba(0,0,0,0.62)'; dispCtx.fillRect(2, 2, tw + 10, 20);
    dispCtx.fillStyle = '#7dffb0'; dispCtx.fillText(txt, 7, 5);
    dispCtx.restore();
  }

  // ---- 存档系统(简化版: 游戏内"存储"自动持久化, "再入尘世"自动读取) ----
  //   游戏 fwrite a:\fml.sav → os.js 代理写入 S.savStore + localStorage('hss_sav_current')
  //   游戏 fread a:\fml.sav → os.js 从 S.savStore 返回 → 无需手动操作
  //   本按钮只用于查看存档状态 / 清空(重新开始)
  function _curSavSize() { return (S && S.savStore && S.savStore.length) ? S.savStore.length : 0; }
  let _toastT = 0;
  function toast(msg) { let t = document.getElementById('savToast'); if (!t) { t = document.createElement('div'); t.id = 'savToast'; t.style.cssText = 'position:fixed;left:50%;top:14%;transform:translateX(-50%);z-index:70;background:rgba(0,0,0,.86);color:#ffd66b;font:14px/1.4 -apple-system;padding:8px 14px;border-radius:8px;pointer-events:none;max-width:88vw;text-align:center;'; document.body.appendChild(t); } t.textContent = msg; t.style.display = 'block'; clearTimeout(_toastT); _toastT = setTimeout(function () { t.style.display = 'none'; }, 2400); }
  function toggleSavPanel(show) { const p = document.getElementById('savPanel'); if (!p) return; const on = (show != null) ? show : (p.style.display === 'none' || !p.style.display); p.style.display = on ? 'flex' : 'none'; }
  function renderSavInfo() { const el = document.getElementById('savPanelInner'); if (!el) return; const sz = _curSavSize(); let h = '<div style="font-weight:700;font-size:16px;color:#e8c46a;margin-bottom:10px">存档状态</div>'; if (sz) { h += '<div style="margin-bottom:8px">当前有存档: <b>' + (sz / 1024).toFixed(1) + ' KB</b></div>'; h += '<div style="font-size:12px;opacity:.7;margin-bottom:12px">游戏内点"存储"即自动保存，回主菜单点"再入尘世"即自动读取。</div>'; h += '<button id="savClear" style="background:#a03030;border:0;border-radius:6px;color:#fff;font:600 13px/1 -apple-system;padding:8px 14px">清空存档(重新开始)</button>'; } else { h += '<div style="margin-bottom:8px">当前无存档</div>'; h += '<div style="font-size:12px;opacity:.7">在游戏中菜单点"存储"即可保存进度。</div>'; } h += '<button id="savClose" style="width:100%;margin-top:14px;background:#3a424d;border:0;border-radius:6px;color:#fff;font:600 13px/1 -apple-system;padding:8px 14px">关闭</button>'; el.innerHTML = h; const clr = document.getElementById('savClear'); if (clr) clr.onclick = function () { S.savStore = new Uint8Array(0); try { localStorage.removeItem(S.LSKEY); } catch (e) {} renderSavInfo(); toast('存档已清空'); }; document.getElementById('savClose').onclick = function () { toggleSavPanel(false); }; }
  function initSavUI() { if (document.getElementById('savBtn')) return; const btn = document.createElement('div'); btn.id = 'savBtn'; btn.textContent = '存档'; btn.className = 'btn'; btn.style.color = '#e8c46a'; btn.onclick = function () { toggleSavPanel(); renderSavInfo(); }; const padTop = document.getElementById('padTop'); if (padTop) padTop.appendChild(btn); else { btn.style.position = 'fixed'; btn.style.bottom = '10px'; btn.style.right = '10px'; btn.style.zIndex = '40'; document.body.appendChild(btn); } const p = document.createElement('div'); p.id = 'savPanel'; p.style.cssText = 'display:none;position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.72);align-items:center;justify-content:center;'; const box = document.createElement('div'); box.style.cssText = 'width:80%;max-width:300px;background:#1b2028;border:1px solid #3a424d;border-radius:12px;padding:18px;color:#dfe7ef;font:13px/1.6 -apple-system;text-align:center;'; box.innerHTML = '<div id="savPanelInner"></div>'; p.appendChild(box); p.onclick = function (ev) { if (ev.target === p) toggleSavPanel(false); }; document.body.appendChild(p); }

  // 帧捕获: 每次 blit-to-FB 当下从内存读 FB 快照(不依赖 offCanvas, boot 早期即可用), 去重后存 window.__caps。
  let _capCtx = null, _capImg = null;
  function captureFB() {
    if ((window.__caps || (window.__caps = [])).length >= 48) return;
    if (!_capCtx) { const c = document.createElement('canvas'); c.width = W; c.height = H; _capCtx = c.getContext('2d'); _capImg = _capCtx.createImageData(W, H); }
    const off = S.FB >>> 0, d = _capImg.data; let hash = 2166136261;
    for (let y = 0; y < H; y++) { const rb = off + y * FBSTRIDE;
      for (let x = 0; x < W; x++) { const byte = m.rd8((rb + (x >> 2)) >>> 0); const v = ((byte >> (6 - (x & 3) * 2)) & 3); const c = PAL[v]; const p = (y * W + x) * 4; d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = 255; } }
    for (let i = 0; i < d.length; i += 101) { hash ^= d[i]; hash = Math.imul(hash, 16777619); } hash >>>= 0;
    if (!window.__capSeen) window.__capSeen = new Set();
    if (window.__capSeen.has(hash)) return; window.__capSeen.add(hash);
    _capCtx.putImageData(_capImg, 0, 0); const c2 = document.createElement('canvas'); c2.width = W; c2.height = H; c2.getContext('2d').drawImage(_capCtx.canvas, 0, 0);
    window.__caps.push({ n: window.__caps.length, t: Math.round(performance.now()), steps: m.steps, hash, url: c2.toDataURL('image/png') });
  }

  function updateHud() {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('kSteps', (m && m.steps ? m.steps : 0).toLocaleString());
    set('kPresent', presentCount.toLocaleString());
    set('kMsg', (S && S.msgCount ? S.msgCount : 0).toLocaleString());
  }

  // ---- 输入 ----
  // 方向键双通道: 按住→keysDown(DetectKeyState, 大地图连续走动); 按下瞬间→离散键入队(GetMessage, 菜单/对话导航)。两通道互不干扰(各自场景只读自己那条)。
  function pressDir(code, down) { if (!S) return; if (down) S.keysDown.add(code); else S.keysDown.delete(code); }
  // DetectKeyState 脉冲保持: 面板/对话场景用轮询而非 GetMessage, 需保持 keysDown 一段时间让游戏检测到
  const _dkHold = {};
  function dirPress(code) { if (inMainMenu()) { if (code === 146) menuMove(-1); else if (code === 152) menuMove(1); } else if (inTrade()) { if (code === 146) tradeRow = Math.max(0, tradeRow - 1); else if (code === 152) tradeRow = Math.min(TRADE_ROWS - 1, tradeRow + 1); else if (code === 145) tradeCol = Math.max(0, tradeCol - 1); else if (code === 153) tradeCol = Math.min(TRADE_COLS - 1, tradeCol + 1); } else if (isPanelScene()) { if (code === 146) panelMove(-1); else if (code === 152) panelMove(1); } pressDir(code, true); discrete(code); if (!inMainMenu() && (S.pumpRA>>>0)!==0x11b2c) { clearTimeout(_dkHold[code]); _dkHold[code] = setTimeout(function(){ pressDir(code, false); }, 400); } }
  function discrete(code) { if (!S) return;
    // ★"再入尘世"(主菜单 idx1)=读取存档。当前模拟器未把存档 fwrite 持久化到 iOS 文件系统, 永远无有效存档; 放游戏进读档会因全零存档进入空白世界(易被误认为崩溃)。
    //   故主菜单光标停在"再入尘世"时吞掉确认键, 配合高亮框"无存档"标注引导用户改选"重新修炼"。(os.js fread savEmpty 仍兜底防任何读档路径死循环)
    if (code === KEY_CONFIRM && inMainMenu() && menuIdx === 1 && !(S.savStore && S.savStore.length)) return;   // 无存档时吞掉"再入尘世"确认; 已载入槽(S.savStore 非空)时放行→游戏 fread 读取该存档
    S.queue.push({ hwnd: 0, msg: 0, wp: code, lp: 0 }); }
  // 功能/战斗键(charKey): 离散入队(带 char 标记, os.js GetMessage 消费时走 feedChar 双半字) + 短暂置按下
  function charKey(code) { if (!S) return;
    // ★游戏功能/战斗快捷键读的是小写 ASCII(实测钉死: i=状态 o=行囊 t=任务 v=系统 j=技能 m=小地图 q/w/e/r=技能键1-4 a/s=吃药1-2 d=普攻 f=技攻)。
    //   UI 按钮 [data-char] 传的是大写字母 charCodeAt(如 I=73/T=84), 游戏不识别 → 用户反馈"除确认/返回/方向外都没反应"的真因。统一转小写(+32)再投递。
    if (code >= 65 && code <= 90) code += 32;
    S.queue.push({ hwnd: 0, msg: 0, wp: code, lp: 0, char: true }); S.keysDown.add(code); setTimeout(() => { S.keysDown.delete(code); }, 90); }
  function releaseDir(code) { pressDir(code, false); }

  function bindInput() {
    window.addEventListener('keydown', e => {
      if (DIR[e.key]) { if (!e.repeat) dirPress(DIR[e.key]); else pressDir(DIR[e.key], true); e.preventDefault(); }
      else if (e.key === 'Enter' || e.key === ' ') { discrete(KEY_CONFIRM); e.preventDefault(); }
      else if (e.key === 'Escape' || e.key === 'Backspace') { discrete(KEY_BACK); e.preventDefault(); }
      else if (e.key === 'f' || e.key === 'F') { discrete(KEY_FUNC); }
    });
    window.addEventListener('keyup', e => { if (DIR[e.key]) { pressDir(DIR[e.key], false); e.preventDefault(); } });

    // 触屏方向键(按住)
    document.querySelectorAll('[data-dir]').forEach(el => {
      const code = parseInt(el.getAttribute('data-dir'), 10);
      const on = ev => { ev.preventDefault(); dirPress(code); el.classList.add('on'); };
      const off = ev => { ev.preventDefault(); pressDir(code, false); el.classList.remove('on'); };
      el.addEventListener('touchstart', on, { passive: false }); el.addEventListener('touchend', off); el.addEventListener('touchcancel', off);
      el.addEventListener('mousedown', on); el.addEventListener('mouseup', off); el.addEventListener('mouseleave', off);
    });
    // 触屏动作键(点按) — 确认/返回/功能(data-key 数字)
    document.querySelectorAll('[data-key]').forEach(el => {
      const code = parseInt(el.getAttribute('data-key'), 10);
      el.addEventListener('touchstart', ev => { ev.preventDefault(); discrete(code); flash(el); }, { passive: false });
      el.addEventListener('mousedown', ev => { ev.preventDefault(); discrete(code); flash(el); });
    });
    // ★data-char 按钮(任务/地图/状态/行囊/技能/系统 + 战斗键): 用事件委托, 不依赖绑定时序★
    //   旧方案(index.html setInterval 轮询)在 boot 加载慢时过期→按钮永远无反应。
    document.addEventListener('pointerdown', function(e) {
      const el = e.target.closest('[data-char]');
      if (!el || !S) return;
      e.preventDefault();
      const code = el.getAttribute('data-char').charCodeAt(0);
      charKey(code);
      el.classList.add('on');
      setTimeout(function(){ el.classList.remove('on'); }, 120);
    });
    initSavUI();   // 存档多槽存取面板(悬浮"存档"按钮)
  }
  function flash(el) { el.classList.add('on'); setTimeout(() => el.classList.remove('on'), 120); }

  window.addEventListener('DOMContentLoaded', () => {
    const runBtn = document.getElementById('run');
    if (runBtn) runBtn.addEventListener('click', boot);
    bindInput();
    // iOS: 进入界面即自动装载(失败时保留「装载并开始」按钮可手动重试)
    boot();
  });
})();
