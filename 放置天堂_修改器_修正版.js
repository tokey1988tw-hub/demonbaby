(function () {
    "use strict";

    // ===== 0. 取得遊戲全域（遊戲的 let/const 在全域語彙環境，主控台可直接以裸名存取）=====
    const G = (name) => { try { return eval(name); } catch (e) { return undefined; } };
    const hasFn = (name) => typeof G(name) === 'function';

    // ===== 1. 環境檢查 =====
    if (typeof DB === 'undefined' || !DB.items || typeof player === 'undefined') {
        alert("❌ 偵測失敗！請確定你正打開著「放置天堂」遊戲頁面，且已進入遊戲畫面再執行。");
        return;
    }

    // 取得真正的存檔位與存檔 key（修正：所有存檔位都是 lineage_idle_save_<slot>）
    const getSlot = () => {
        let s = G('currentSlot');
        if (s === undefined) s = window.currentSlot;
        return s || 1;
    };
    const slotKey = () => 'lineage_idle_save_' + getSlot();

    // 正確寫檔：優先用遊戲自帶 saveGame()（會寫對 key 與 {v,p,ms,ticks} 結構）；
    // 失敗才以正確結構手動寫入，避免掉版本號/地圖/tick。
    const doSave = () => {
        if (hasFn('saveGame')) {
            try { saveGame(); return true; } catch (e) { /* 落到手動 */ }
        }
        try {
            let ver = (typeof G('SAVE_VERSION') !== 'undefined') ? G('SAVE_VERSION') : 2;
            let ms = G('mapState') || {};
            let ticks = (G('state') && G('state').ticks) || 0;
            localStorage.setItem(slotKey(), JSON.stringify({ v: ver, p: player, ms: ms, ticks: ticks }));
            return true;
        } catch (e) { return false; }
    };

    // 即時刷新（不重整）：重算衍生值 + 刷新 UI
    const liveRefresh = () => {
        try { if (hasFn('calcStats')) calcStats(); else if (hasFn('recomputeStats')) recomputeStats(); } catch (e) {}
        try { if (hasFn('updateUI')) updateUI(); } catch (e) {}
        try { if (hasFn('renderTabs')) renderTabs(true); } catch (e) {}   // 強制重繪分頁（技能列表等）：確保解鎖/改動即時反映到 UI
    };

    // ===== 1c. 自訂魔法武器：localStorage 持久化 + 啟動時重新注入 DB.items =====
    // 存檔只存物品實例(id/en)，不存武器本體定義；故把自訂規格存 localStorage，
    // 每次修改器載入時重新寫回 DB.items，確保重整後武器仍可用（須再次執行修改器）。
    const CW_KEY = 'geo_custom_weapons';
    const loadCustomWeapons = () => {
        try { return JSON.parse(localStorage.getItem(CW_KEY)) || {}; }
        catch (e) { return {}; }
    };
    const saveCustomWeapons = (obj) => {
        try { localStorage.setItem(CW_KEY, JSON.stringify(obj)); return true; }
        catch (e) { return false; }
    };
    // 把一筆規格組成 DB.items 條目（spellProc：發動率1%+強化×1%，傷害骰子×(1+強化/10)）
    const buildWeaponDef = (spec) => {
        // 發動機率：固定模式 → procRateBase=固定值, procRatePerEn=0；隨強化模式 → base=1, perEn=1（預設）
        const rateBase = (spec.procMode === 'fixed') ? (spec.procFixed || 1) : 1;
        const ratePerEn = (spec.procMode === 'fixed') ? 0 : 1;
        const def = {
            n: spec.n, type: 'wpn',
            dmgS: spec.dmgS, dmgL: spec.dmgL, hit: spec.hit || 0,
            dmgBonus: spec.dmgBonus || 0, spd: spec.spd, req: spec.req || 'all',
            safe: 6, p: 1, legend: true, gachaWeight: 0,
            procRateBase: rateBase, procRatePerEn: ratePerEn,
            spellProc: { skn: spec.skn, dice: [spec.diceN, spec.diceF], ele: spec.ele },
            d: ''
        };
        // 發動率描述
        if (spec.procMode === 'fixed') def.d = `固定 ${rateBase}% 機率額外施放【${spec.skn}】（不隨強化變）`;
        else def.d = `1%機率額外施放【${spec.skn}】，每+1發動機率增加1%`;
        def.d += `；特效傷害 ${spec.diceN}D${spec.diceF}${spec.diceF>1?'×(1+強化/10)':''}，受魔法傷害影響${spec.ele !== 'none' ? '，含屬性剋制' : ''}`;
        // 🌐 攻擊全體
        if (spec.aoe) { def.spellProc.aoe = true; def.d += `；特效對敵方全體施放`; }
        def.d += '。';
        if (spec.isBow) { def.isBow = true; def.ranged = true; }
        if (spec.w2h) def.w2h = true;
        // 🩸 吸血/吸魔（引擎原生）
        if (spec.vampPct) { def.vampPct = spec.vampPct; def.d += ` 吸取一般攻擊傷害 ${Math.round(spec.vampPct * 100)}% 為 HP。`; }
        if (spec.mpOnHit) { def.mpOnHit = true; def.d += ` 命中時恢復 MP（1+max(0,強化-6)）。`; }
        if (spec.spHeal)  { def.spellProc.heal = spec.spHeal; def.d += ` 施放特效時回復特效傷害 ${Math.round(spec.spHeal * 100)}% 的 HP。`; }
        return def;
    };
    // 啟動時重新注入所有自訂武器
    (function reinjectCustomWeapons() {
        const all = loadCustomWeapons();
        let n = 0;
        Object.entries(all).forEach(([id, spec]) => { DB.items[id] = buildWeaponDef(spec); n++; });
        if (n > 0) console.log(`[修改器] 已重新注入 ${n} 把自訂魔法武器到 DB.items`);
    })();

    // ===== 1d. 妖精全屬性魔法解鎖（C 方案：拔除 DB.skills 的 reqEle/reqEleAny）=====
    // 原理：屬性檢查全是 `sk.reqEle && elfEle !== sk.reqEle`，把 reqEle 設為 undefined → 整段 falsy 跳過，
    // 屬性限制失效；但等級(needLv)、MP、是否已學完全不受影響（仍須符合）。
    // reqEle 屬 DB 層，重整會還原 → 每次載入修改器自動重拔（與自訂武器同模式）。
    const ELF_ELE_KEY = 'geo_elf_all_ele';
    const isElfEleUnlocked = () => { try { return localStorage.getItem(ELF_ELE_KEY) === '1'; } catch (e) { return false; } };
    // 備份原始 reqEle/reqEleAny，方便還原
    const _elfEleBackup = {};
    const applyElfAllEle = () => {
        if (!DB.skills) return 0;
        let n = 0;
        for (let id in DB.skills) {
            let sk = DB.skills[id];
            if (sk && (sk.reqEle || sk.reqEleAny)) {
                if (!(id in _elfEleBackup)) _elfEleBackup[id] = { reqEle: sk.reqEle, reqEleAny: sk.reqEleAny };
                delete sk.reqEle; delete sk.reqEleAny;
                n++;
            }
        }
        return n;
    };
    const restoreElfAllEle = () => {
        let n = 0;
        for (let id in _elfEleBackup) {
            let b = _elfEleBackup[id];
            if (DB.skills[id]) {
                if (b.reqEle !== undefined) DB.skills[id].reqEle = b.reqEle;
                if (b.reqEleAny !== undefined) DB.skills[id].reqEleAny = b.reqEleAny;
                n++;
            }
        }
        return n;
    };
    // 啟動時：若已開啟則自動套用
    if (isElfEleUnlocked()) {
        let n = applyElfAllEle();
        if (n > 0) console.log(`[修改器] 妖精全屬性魔法已解鎖（拔除 ${n} 個技能的屬性限制）`);
    }

    // ===== 1e. 六圍突破 80：hook 效果表，80 以上線性外推（越高越強）=====
    // 遊戲在 recomputeStats 把 d.str..cha 夾到 ≤80，且效果表(getStrMeleeDmg…)80封頂。
    // 作法：包裝各效果表函式，偵測到玩家「真實六圍」(base+alloc+panacea) >80 時，改用真實值線性外推。
    // 純公式型(getConGrowth/getWisGrowth)本就無上限，但被夾擠擋住 → 另在 recompute 後補回 HP/MP 成長差額。
    const STAT_CAP_KEY = 'geo_stat_break80';
    const isStatBreakOn = () => { try { return localStorage.getItem(STAT_CAP_KEY) === '1'; } catch (e) { return false; } };
    // 真實六圍（不受夾擠影響）
    const realStat = (k) => {
        try {
            let b = player.base || {}, a = player.alloc || {}, pn = player.panacea || {};
            return (b[k] || 0) + (a[k] || 0) + (pn[k] || 0);
        } catch (e) { return 0; }
    };
    // 效果表外推設定：函式名 → { stat:對應六圍, base:80封頂值, per:每點增量 }
    const EXTRAP = {
        getStrMeleeDmg:   { s: 'str', base: 45, per: 0.5 },
        getStrMeleeHit:   { s: 'str', base: 60, per: 1.0 },
        getStrMeleeCrit:  { s: 'str', base: 9,  per: 0.1 },
        getDexRangedDmg:  { s: 'dex', base: 36, per: 0.5 },
        getDexRangedHit:  { s: 'dex', base: 74, per: 1.0 },
        getDexRangedCrit: { s: 'dex', base: 8,  per: 0.1 },
        getIntMagicDmg:   { s: 'int', base: 25, per: 0.5 },
        getIntMagicHit:   { s: 'int', base: 25, per: 0.5 },
        getIntMagicCrit:  { s: 'int', base: 11, per: 0.1 },
        getIntExtraMp:    { s: 'int', base: 25, per: 0.5 },
        getConHpRegenMax: { s: 'con', base: 45, per: 0.5 },
        getConPotionPct:  { s: 'con', base: 13, per: 0.1 },
        getWisMpRegen:    { s: 'wis', base: 27, per: 0.5 },
        getWisMpOnKill:   { s: 'wis', base: 16, per: 0.3 },
        getWisBlueBonus:  { s: 'wis', base: 38, per: 0.5 }
        // 註：getDexER(封60)、getWisMR(封60)、getIntMpReduce(封45)為設計硬上限，不外推
    };
    const _statHookOrig = {};   // 原始函式備份
    const applyStatBreak = () => {
        let n = 0;
        for (let fn in EXTRAP) {
            if (typeof window[fn] !== 'function') continue;
            if (!_statHookOrig[fn]) _statHookOrig[fn] = window[fn];
            const orig = _statHookOrig[fn];
            const cfg = EXTRAP[fn];
            window[fn] = function (v) {
                // 若玩家真實六圍 > 80，改用真實值外推；否則原樣
                let rv = realStat(cfg.s);
                if (rv > 80) return Math.floor(cfg.base + (rv - 80) * cfg.per);
                return orig(v);
            };
            n++;
        }
        // 純公式型 HP/MP 成長（本無上限，但被夾擠擋住）：改讀真實 con/wis
        if (typeof window.getConGrowth === 'function') {
            if (!_statHookOrig.getConGrowth) _statHookOrig.getConGrowth = window.getConGrowth;
            const oc = _statHookOrig.getConGrowth;
            window.getConGrowth = function (con, cls) { let rv = realStat('con'); return oc(rv > 80 ? rv : con, cls); };
            n++;
        }
        if (typeof window.getWisGrowth === 'function') {
            if (!_statHookOrig.getWisGrowth) _statHookOrig.getWisGrowth = window.getWisGrowth;
            const ow = _statHookOrig.getWisGrowth;
            window.getWisGrowth = function (wis) { let rv = realStat('wis'); return ow(rv > 80 ? rv : wis); };
            n++;
        }
        return n;
    };
    const restoreStatBreak = () => {
        let n = 0;
        for (let fn in _statHookOrig) { window[fn] = _statHookOrig[fn]; n++; }
        return n;
    };
    if (isStatBreakOn()) {
        let n = applyStatBreak();
        if (n > 0) console.log(`[修改器] 六圍突破80已啟用（${n} 個效果表改為線性外推）`);
    }

    // ===== 1f. 戰鬥節奏修改（攻擊間隔/施法冷卻/硬直）+ 怪物重生加速 =====
    // 前三者為 recomputeStats 衍生值(d.aspd/d.castLock/d.hitstun)，每次重算會被覆蓋 → hook recompute 後補寫。
    // 怪物重生用獨立 setInterval 壓 mapState.spawnAt（不碰變身系統），BOSS房/軍王之室不加速。
    const TEMPO_KEY = 'geo_combat_tempo';
    const loadTempo = () => {
        try { return JSON.parse(localStorage.getItem(TEMPO_KEY)) || {}; } catch (e) { return {}; }
    };
    const saveTempo = (o) => { try { localStorage.setItem(TEMPO_KEY, JSON.stringify(o)); } catch (e) {} };
    // 套用戰鬥節奏到 player.d（在 recompute 之後呼叫）。值為空字串/undefined = 不改該項。
    const applyTempoToStats = () => {
        const t = loadTempo();
        if (!t.on || !player || !player.d) return;
        // 攻擊間隔（秒）：下限 0.1（引擎 aspdTicks=max(1,floor(aspd*10)) → 0.1秒=1tick 為極限）
        if (t.aspd !== '' && t.aspd != null) player.d.aspd = Math.max(0.1, Number(t.aspd));
        // 施法冷卻（tick）：下限 0
        if (t.castLock !== '' && t.castLock != null) player.d.castLock = Math.max(0, Math.floor(Number(t.castLock)));
        // 硬直（tick）：下限 0
        if (t.hitstun !== '' && t.hitstun != null) player.d.hitstun = Math.max(0, Math.floor(Number(t.hitstun)));
    };
    // 怪物重生加速：定時把未來排程壓成「當前 tick」讓其立即重生（BOSS房不動）
    let _respawnTimer = null;
    const startRespawnAccel = () => {
        if (_respawnTimer) return;
        _respawnTimer = setInterval(() => {
            try {
                const t = loadTempo();
                if (!t.on || !t.fastRespawn) return;
                if (typeof mapState === 'undefined' || !mapState || !Array.isArray(mapState.spawnAt)) return;
                // BOSS 房 / 軍王之室不加速（維持遊戲節奏與鑰匙機制）
                if (typeof KING_ROOMS !== 'undefined' && KING_ROOMS[mapState.current]) return;
                if (typeof PURE_BOSS_MAPS !== 'undefined' && PURE_BOSS_MAPS.indexOf && PURE_BOSS_MAPS.indexOf(mapState.current) >= 0) return;
                const now = (typeof state !== 'undefined' && state) ? state.ticks : null;
                if (now == null) return;
                for (let i = 0; i < mapState.spawnAt.length; i++) {
                    if (mapState.spawnAt[i] != null && mapState.spawnAt[i] > now) mapState.spawnAt[i] = now;   // 壓成當前 tick → 下個 tick 立即重生
                }
            } catch (e) {}
        }, 200);   // 每 0.2 秒巡一次
    };
    const stopRespawnAccel = () => { if (_respawnTimer) { clearInterval(_respawnTimer); _respawnTimer = null; } };
    // 啟動時：若開著就掛 recompute hook + 重生加速
    const _origRecompute_tempo = (typeof window.recomputeStats === 'function') ? window.recomputeStats : null;
    (function initTempo() {
        const t = loadTempo();
        if (!t.on) return;
        // hook recomputeStats：跑完原邏輯後補寫戰鬥節奏
        if (_origRecompute_tempo && !window._tempoHooked) {
            window.recomputeStats = function () { let r = _origRecompute_tempo.apply(this, arguments); applyTempoToStats(); return r; };
            window._tempoHooked = true;
        }
        applyTempoToStats();
        startRespawnAccel();
        console.log('[修改器] 戰鬥節奏修改已套用');
    })();

    // ===== 1g. 傭兵上限修改（hook allyActiveCap，可自訂同時上場人數）=====
    // 遊戲 ALLY_ACTIVE_MAX=3 為 const 改不到，但 allyActiveCap() 為全域函式可覆寫。
    const ALLYCAP_KEY = 'geo_ally_cap';
    const loadAllyCap = () => { try { return localStorage.getItem(ALLYCAP_KEY); } catch (e) { return null; } };
    const _origAllyCap = (typeof window.allyActiveCap === 'function') ? window.allyActiveCap : null;
    const applyAllyCap = (n) => {
        window.allyActiveCap = function () { return n; };
    };
    const restoreAllyCap = () => { if (_origAllyCap) window.allyActiveCap = _origAllyCap; };
    (function initAllyCap() {
        const v = loadAllyCap();
        if (v == null) return;
        const n = parseInt(v);
        if (n > 0) { applyAllyCap(n); console.log(`[修改器] 傭兵上限已改為 ${n} 名`); }
    })();

    // ===== 2. 移除舊面板 =====
    let oldPanel = document.getElementById('geo-mod-panel');
    if (oldPanel) oldPanel.remove();

    // ===== 3. 外殼 =====
    let panel = document.createElement('div');
    panel.id = 'geo-mod-panel';
    panel.style.cssText = `
        position: fixed; top: 10px; right: 10px; width: 460px; max-height: 92vh;
        background: linear-gradient(180deg, #1e293b 0%, #0f172a 100%);
        border: 3px solid #3b82f6; border-radius: 12px; z-index: 999999;
        box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); color: #f8fafc;
        font-family: sans-serif; display: flex; flex-direction: column; overflow: hidden;`;

    // ===== 4. 道具分類下拉 =====
    let categorised = { "⚔️ 武器庫": [], "🛡️ 防具/盾牌": [], "💍 首飾/配件": [], "📜 卷軸/藥水/其他": [] };
    for (let id in DB.items) {
        let item = DB.items[id], type = item.type || '';
        if (type === 'wpn') categorised["⚔️ 武器庫"].push({ id, n: item.n });
        else if (type === 'arm') categorised["🛡️ 防具/盾牌"].push({ id, n: item.n });
        else if (type === 'acc') categorised["💍 首飾/配件"].push({ id, n: item.n });
        else categorised["📜 卷軸/藥水/其他"].push({ id, n: item.n });
    }
    let selectHtml = "";
    for (let cat in categorised) {
        selectHtml += `<optgroup label="${cat}" style="background:#0f172a; color:#94a3b8;">`;
        categorised[cat].forEach(i => { selectHtml += `<option value="${i.id}">${i.n} (${i.id})</option>`; });
        selectHtml += `</optgroup>`;
    }

    // 🔥 v3.0.77 屬性新制（代碼 fr/wa/wi/ea × 5階，名稱與遊戲 ATTR_AFFIX 一致）
    // key = 遊戲實際寫入 item.attr 的代碼；名稱為遊戲顯示名（tier1~5：傷害+1/3/5/7/9）
    const ATTR_MAP = {
        fr1:"火之", fr2:"爆炎", fr3:"火靈", fr4:"赤炎", fr5:"帕格里奧",
        wa1:"水之", wa2:"海嘯", wa3:"水靈", wa4:"霜凍", wa5:"伊娃",
        wi1:"風之", wi2:"暴風", wi3:"風靈", wi4:"蒼蘭", wi5:"沙哈",
        ea1:"地之", ea2:"崩裂", ea3:"地靈", ea4:"輝岩", ea5:"馬普勒"
    };
    // 元素 → 代碼字首（與遊戲 ATTR_ELE_PREFIX 一致）
    const ATTR_PREFIX = { fire: 'fr', water: 'wa', wind: 'wi', earth: 'ea' };

    // 六圍欄位定義（修正：補上「精神 WIS」，且改用 base+alloc+panacea 模型）
    const STATS = [
        { k: 'str', label: '力 STR', color: '#f87171' },
        { k: 'dex', label: '敏 DEX', color: '#34d399' },
        { k: 'con', label: '體 CON', color: '#fbbf24' },
        { k: 'int', label: '智 INT', color: '#60a5fa' },
        { k: 'wis', label: '精神 WIS', color: '#c084fc' },
        { k: 'cha', label: '魅 CHA', color: '#f472b6' }
    ];
    // 目前「有效值」= d 物件（顯示值）；改不到時退回 base+alloc+panacea
    const effStat = (k) => {
        if (player.d && typeof player.d[k] === 'number') return player.d[k];
        return (player.base?.[k] || 0) + (player.alloc?.[k] || 0) + (player.panacea?.[k] || 0);
    };
    let statInputs = STATS.map(s => `
        <div>${s.label}: <input type="number" id="mod-${s.k}" min="0" max="255"
            style="width:55px; background:#000; color:${s.color}; border:1px solid #475569; padding:2px;"
            value="${effStat(s.k)}"></div>`).join('');

    let attrOptions = '<option value="false" style="color:#fff;">無屬性</option>';
    [["fire","🔥"],["water","💧"],["earth","🪨"],["wind","⚡"]].forEach(([e, ic]) => {
        let pf = ATTR_PREFIX[e];
        for (let t = 5; t >= 1; t--) attrOptions += `<option value="${pf}${t}">${ic} ${ATTR_MAP[pf + t]}（${t}階）</option>`;
    });

    // 🔮 席琳套裝詞綴（seteff，40 種，8 組 × 5 件；組名＝前兩字）
    // 優先讀遊戲現有的 SHERINE_EFFECTS（隨遊戲更新自動同步），讀不到才用內建備份。
    const FALLBACK_SHERINE = [
        '紅獅的誓言','紅獅的壯志','紅獅的復仇','紅獅的熱情','紅獅的單思',
        '白鳥的誓言','白鳥的依戀','白鳥的夢想','白鳥的情愫','白鳥的犧牲',
        '鐵衛的誓言','鐵衛的象徵','鐵衛的盟約','鐵衛的奮戰','鐵衛的守護',
        '麗人的誓言','麗人的加護','麗人的期盼','麗人的依靠','麗人的單戀',
        '疾風的誓言','疾風的灑脫','疾風的傳說','疾風的襲擊','疾風的迅捷',
        '月光的誓言','月光的隱情','月光的幽蔽','月光的純潔','月光的消逝',
        '學徒的誓言','學徒的好奇','學徒的研究','學徒的夢想','學徒的智慧',
        '魔女的誓言','魔女的哀戚','魔女的束縛','魔女的瘋狂','魔女的冷冽'
    ];
    let SET_EFFECTS = (Array.isArray(G('SHERINE_EFFECTS')) && G('SHERINE_EFFECTS').length) ? G('SHERINE_EFFECTS') : FALLBACK_SHERINE;
    // 依組名(前兩字)分組做 optgroup
    let setGroups = {};
    SET_EFFECTS.forEach(name => { let g = name.slice(0, 2); (setGroups[g] = setGroups[g] || []).push(name); });
    let seteffOptions = '<option value="false" style="color:#fff;">無套裝詞綴</option>';
    for (let g in setGroups) {
        seteffOptions += `<optgroup label="✦ ${g}套裝" style="background:#052e16; color:#86efac;">`;
        setGroups[g].forEach(name => { seteffOptions += `<option value="${name}" style="color:#4ade80;">${name}</option>`; });
        seteffOptions += `</optgroup>`;
    }

    // ===== 已穿戴裝備：欄位定義、值轉換、選單建構 =====
    const SLOT_DEFS = [
        ['wpn','武器'],['helm','頭盔'],['armor','盔甲'],['shield','盾牌'],['cloak','斗篷'],
        ['tshirt','內衣'],['gloves','手套'],['boots','長靴'],['ring1','戒指1'],['ring2','戒指2'],
        ['ring3','戒指3'],['ring4','戒指4'],['amulet','項鍊'],['belt','腰帶'],['ear1','耳環1'],['ear2','耳環2'],['pet','寵物裝備'],['doll','魔法娃娃'],['arrow','箭矢']
    ];
    // 物品實際值 → 下拉 value
    const ancToVal = (a) => a === true ? 'true' : (['eternal','immortal','primordial'].includes(a) ? a : 'none');
    const blessToVal = (b) => b === true ? 'bless' : (b === 'cursed' ? 'cursed' : 'none');
    // 下拉 value → 物品實際值
    const valToAnc = (v) => v === 'true' ? true : (['eternal','immortal','primordial'].includes(v) ? v : false);
    const valToBless = (v) => v === 'bless' ? true : (v === 'cursed' ? 'cursed' : false);
    // 帶 selected 的選單建構：items = [[value, 標籤, 顏色]]
    const buildSel = (id, items, current, extra) => {
        let h = `<select id="${id}" style="background:#000; color:#fff; border:1px solid #475569; padding:1px; font-size:11px; ${extra || ''}">`;
        items.forEach(([v, label, color]) => {
            h += `<option value="${v}"${String(v) === String(current) ? ' selected' : ''} style="color:${color || '#fff'};">${label}</option>`;
        });
        return h + '</select>';
    };
    const TIER_ITEMS = [['none','一般','#fff'],['true','🔮遠古','#a855f7'],['eternal','💥永恆','#ef4444'],['immortal','🔱不朽','#22c55e'],['primordial','🌌太初','#3b82f6']];
    const STATUS_ITEMS = [['none','無','#fff'],['bless','✨祝福','#22c55e'],['cursed','💀詛咒','#ef4444']];
    let ATTR_ITEMS = [['false','無屬性','#fff']];
    [["fire","🔥"],["water","💧"],["earth","🪨"],["wind","⚡"]].forEach(([e, ic]) => { let pf = ATTR_PREFIX[e]; for (let t = 5; t >= 1; t--) ATTR_ITEMS.push([pf + t, ic + ATTR_MAP[pf + t] + '（' + t + '階）', '#60a5fa']); });
    let SETEFF_ITEMS = [['false','無套裝詞綴','#fff']];
    SET_EFFECTS.forEach(name => SETEFF_ITEMS.push([name, '✦' + name, '#4ade80']));

    // ===== 5. 面板內容 =====
    panel.innerHTML = `
        <div style="background:#1e3a8a; padding:12px; font-weight:bold; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #2563eb;">
            <span>🏰 放置天堂【精準相容管理面板 v3】<span style="font-size:11px; color:#93c5fd;"> 存檔位:${getSlot()}</span></span>
            <button onclick="document.getElementById('geo-mod-panel').remove()" style="background:#ef4444; color:white; border:none; padding:2px 8px; border-radius:4px; cursor:pointer;">❌</button>
        </div>

        <div style="padding:15px; flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:12px; font-size:13px;">

            <div style="font-weight:bold; color:#a855f7;">✨ 雙向存檔管理器（已修正寫對存檔位）</div>
            <div style="background:rgba(168,85,247,0.1); border:1px solid #a855f7; padding:10px; border-radius:6px; display:flex; flex-direction:column; gap:6px;">
                <button id="btn-export-now" style="width:100%; background:#7c3aed; color:white; border:none; padding:6px; border-radius:4px; font-weight:bold; cursor:pointer;">📋 提取並複製「當前存檔位」存檔</button>
                <button id="btn-import-now" style="width:100%; background:#2563eb; color:white; border:none; padding:6px; border-radius:4px; font-weight:bold; cursor:pointer;">📥 貼上外部代碼匯入到此存檔位</button>
            </div>

            <div style="font-weight:bold; color:#f59e0b;">📊 基礎數值（金幣 / 等級 / 經驗 / 點數）</div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; background:rgba(0,0,0,0.2); padding:10px; border-radius:6px;">
                <div>金幣: <input type="number" id="mod-gold" style="width:80%; background:#000; color:#f59e0b; border:1px solid #475569; padding:2px;" value="${player.gold || 0}"></div>
                <div>等級: <input type="number" id="mod-lv" style="width:70%; background:#000; color:#10b981; border:1px solid #475569; padding:2px;" value="${player.lv || 1}"></div>
                <div>經驗: <input type="number" id="mod-exp" style="width:80%; background:#000; color:#93c5fd; border:1px solid #475569; padding:2px;" value="${player.exp || 0}"></div>
                <div>剩餘點數: <input type="number" id="mod-bonus" style="width:55%; background:#000; color:#facc15; border:1px solid #475569; padding:2px;" value="${player.bonus || 0}"></div>
            </div>

            <div style="font-weight:bold; color:#c084fc;">🧬 六圍屬性（改 alloc，即時生效；新版超過 60 仍會提升能力）
                <button id="btn-all60" style="float:right; background:#7c3aed; color:#fff; border:none; padding:1px 8px; border-radius:4px; cursor:pointer; font-size:11px;">全部設 99</button>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; background:rgba(0,0,0,0.2); padding:10px; border-radius:6px;">
                ${statInputs}
            </div>
            <div style="display:flex; gap:6px; align-items:center; background:rgba(192,132,252,0.08); border:1px solid #9333ea; padding:8px; border-radius:6px;">
                <button id="btn-stat-break" style="flex:1; background:#7c3aed; color:#fff; border:none; padding:7px; border-radius:4px; cursor:pointer; font-weight:bold;">💪 六圍突破80：<span id="stat-break-state">關閉</span></button>
                <span style="font-size:11px; color:#64748b;">80以上線性外推，越高越強</span>
            </div>

            <div style="font-weight:bold; color:#f59e0b;">⚡ 戰鬥節奏修改</div>
            <div style="background:rgba(245,158,11,0.08); border:1px solid #d97706; padding:10px; border-radius:6px; display:flex; flex-direction:column; gap:6px;">
                <div style="display:flex; gap:6px; align-items:center;">
                    <span style="width:90px; font-size:12px;">攻擊間隔(秒):</span>
                    <input type="number" id="tempo-aspd" step="0.1" min="0.1" placeholder="不改" style="width:70px; background:#000; color:#fde68a; text-align:center; border:1px solid #475569;">
                    <span style="font-size:11px; color:#64748b;">越小越快·下限0.1</span>
                </div>
                <div style="display:flex; gap:6px; align-items:center;">
                    <span style="width:90px; font-size:12px;">施法冷卻(tick):</span>
                    <input type="number" id="tempo-cast" step="1" min="0" placeholder="不改" style="width:70px; background:#000; color:#fde68a; text-align:center; border:1px solid #475569;">
                    <span style="font-size:11px; color:#64748b;">0=無冷卻</span>
                </div>
                <div style="display:flex; gap:6px; align-items:center;">
                    <span style="width:90px; font-size:12px;">被擊硬直(tick):</span>
                    <input type="number" id="tempo-stun" step="1" min="0" placeholder="不改" style="width:70px; background:#000; color:#fde68a; text-align:center; border:1px solid #475569;">
                    <span style="font-size:11px; color:#64748b;">0=免硬直</span>
                </div>
                <label style="display:flex; align-items:center; gap:4px; font-size:12px;">
                    <input type="checkbox" id="tempo-respawn"> 🐾 怪物立即重生（BOSS房/軍王之室不加速）
                </label>
                <div style="display:flex; gap:6px;">
                    <button id="btn-tempo-apply" style="flex:1; background:#d97706; color:#fff; border:none; padding:7px; border-radius:4px; cursor:pointer; font-weight:bold;">⚡ 套用：<span id="tempo-state">關閉</span></button>
                    <button id="btn-tempo-preset" style="flex:1; background:#b45309; color:#fff; border:none; padding:7px; border-radius:4px; cursor:pointer; font-weight:bold;">🚀 一鍵極速</button>
                </div>
                <div style="font-size:11px; color:#64748b; line-height:1.5;">
                    ※ 留空＝不改該項。全部有引擎保底，設合理極限不會出錯。<br>
                    ※ 每次進遊戲後須再執行修改器，此設定才會持續生效。
                </div>
            </div>

            <div style="font-weight:bold; color:#38bdf8;">🤝 傭兵上限修改</div>
            <div style="background:rgba(56,189,248,0.08); border:1px solid #0284c7; padding:10px; border-radius:6px; display:flex; flex-direction:column; gap:6px;">
                <div style="display:flex; gap:6px; align-items:center;">
                    <span style="width:110px; font-size:12px;">同時上場人數:</span>
                    <input type="number" id="ally-cap" min="1" max="99" placeholder="預設3" style="width:60px; background:#000; color:#fde68a; text-align:center; border:1px solid #475569;">
                    <button id="btn-ally-cap" style="flex:1; background:#0284c7; color:#fff; border:none; padding:7px; border-radius:4px; cursor:pointer; font-weight:bold;">🤝 套用：<span id="ally-cap-state">關閉</span></button>
                </div>
                <div style="font-size:11px; color:#64748b; line-height:1.5;">
                    ※ 遊戲原本上限 3 名。設更高可同時帶更多傭兵。<br>
                    ※ 每次進遊戲後須再執行修改器才會持續生效。
                </div>
            </div>
            <div style="display:flex; gap:6px; flex-wrap:wrap; background:rgba(0,0,0,0.2); padding:10px; border-radius:6px;">
                <button id="btn-fill-hpmp" style="flex:1; background:#16a34a; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">補滿 HP/MP</button>
                <button id="btn-consolidate" style="flex:1; background:#0891b2; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">整理背包</button>
                <button id="btn-clear-inv" style="flex:1; background:#b91c1c; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">清空背包</button>
                <button id="btn-give-proof" style="flex:1; background:#1d4ed8; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">🏅 給精通之證</button>
            </div>

            <div style="font-weight:bold; color:#f472b6;">🎓 職業技能<span id="mod-cls-info" style="font-size:11px; color:#94a3b8; font-weight:normal;"></span></div>
            <div style="display:flex; gap:6px; flex-wrap:wrap; background:rgba(0,0,0,0.2); padding:10px; border-radius:6px;">
                <button id="btn-learn-class" style="flex:1; background:#db2777; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">學會本職全部技能</button>
                <button id="btn-learn-all" style="flex:1; background:#9333ea; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">學會全部技能</button>
                <button id="btn-clear-skills" style="flex:1; background:#b91c1c; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">清空已學</button>
            </div>
            <div style="display:flex; gap:6px; align-items:center; background:rgba(16,185,129,0.08); border:1px solid #059669; padding:8px; border-radius:6px;">
                <button id="btn-elf-allele" style="flex:1; background:#059669; color:#fff; border:none; padding:7px; border-radius:4px; cursor:pointer; font-weight:bold;">🧝 妖精全屬性魔法：<span id="elf-allele-state">關閉</span></button>
                <span style="font-size:11px; color:#64748b;">解除「一生一屬性」限制（等級/MP照舊）</span>
            </div>

            <div style="font-weight:bold; color:#4ade80;">🧿 已穿戴裝備詞綴即時修改
                <button id="btn-apply-eq" style="float:right; background:#16a34a; color:#fff; border:none; padding:1px 10px; border-radius:4px; cursor:pointer; font-size:11px; font-weight:bold;">套用穿戴改動</button>
            </div>
            <div id="mod-eq-container" style="background:#020617; border:1px solid #166534; border-radius:6px; min-height:60px; max-height:260px; overflow-y:auto; padding:6px; display:flex; flex-direction:column; gap:6px; flex-shrink:0;"></div>

            <div style="font-weight:bold; color:#3b82f6;">⚔️ 100% 相容道具產生器</div>
            <div style="background:rgba(0,0,0,0.2); padding:10px; border-radius:6px; display:flex; flex-direction:column; gap:6px;">
                <div>🔍 搜尋: <input type="text" id="add-search" placeholder="輸入物品名稱或ID關鍵字…" style="width:73%; background:#000; color:#fde68a; padding:3px; border:1px solid #b45309;"></div>
                <div>選道具: <select id="add-id" style="width:75%; background:#000; color:white; padding:2px; border:1px solid #475569;">${selectHtml}</select> <span id="add-count" style="font-size:11px; color:#64748b;"></span></div>
                <div>階級:
                    <select id="add-tier" style="width:33%; background:#000; color:#ec4899; padding:2px; border:1px solid #475569; font-weight:bold;">
                        <option value="none" style="color:#fff;">一般裝備</option>
                        <option value="true" style="color:#a855f7;">🔮 遠古</option>
                        <option value="eternal" style="color:#ef4444;">💥 永恆</option>
                        <option value="immortal" style="color:#22c55e;">🔱 不朽</option>
                        <option value="primordial" style="color:#3b82f6;">🌌 太初</option>
                    </select>
                    狀態:
                    <select id="add-status" style="width:33%; background:#000; color:#22c55e; padding:2px; border:1px solid #475569; font-weight:bold;">
                        <option value="none" style="color:#fff;">無狀態</option>
                        <option value="bless" style="color:#22c55e;">✨ 祝福的</option>
                        <option value="cursed" style="color:#ef4444;">💀 詛咒的</option>
                    </select>
                </div>
                <div>強化 +: <input type="number" id="add-en" value="9" style="width:45px; background:#000; text-align:center; border:1px solid #475569;">
                     數量: <input type="number" id="add-cnt" value="1" style="width:50px; background:#000; text-align:center; border:1px solid #475569;">
                     <label style="font-size:11px; color:#94a3b8;"><input type="checkbox" id="add-lock"> 鎖定</label>
                </div>
                <div>屬性: <select id="add-attr" style="width:75%; background:#000; color:#3b82f6; padding:2px; border:1px solid #475569; font-weight:bold;">${attrOptions}</select></div>
                <div>套裝詞綴: <select id="add-seteff" style="width:72%; background:#000; color:#4ade80; padding:2px; border:1px solid #166534; font-weight:bold;">${seteffOptions}</select></div>
                <div style="font-size:11px; color:#64748b;">※ 套裝詞綴只在「武器/頭盔/盔甲/手套/長靴/斗篷/腰帶」且已裝備時才計入套裝加成。</div>
                <button id="btn-add-item" style="background:#2563eb; color:white; border:none; padding:6px; border-radius:4px; font-weight:bold; cursor:pointer; margin-top:4px;">⚡ 生成並放入背包</button>
            </div>

            <div style="font-weight:bold; color:#e879f9;">🔮 自訂魔法武器產生器（特效隨強化提升）</div>
            <div style="background:rgba(168,85,247,0.08); border:1px solid #9333ea; padding:10px; border-radius:6px; display:flex; flex-direction:column; gap:6px;">
                <div>武器名稱: <input type="text" id="cw-name" value="我的魔法弓" maxlength="12" style="width:60%; background:#000; color:#fde68a; padding:2px; border:1px solid #475569;"></div>
                <div>武器型態:
                    <select id="cw-base" style="width:60%; background:#000; color:#fde68a; padding:2px; border:1px solid #475569; font-weight:bold;">
                        <option value="bow" selected>🏹 弓（遠程）</option>
                        <option value="sword">🗡 單手劍（高單擊）</option>
                        <option value="dual">⚔ 雙刀/爪（高速雙手）</option>
                        <option value="spear">🔱 矛（長距）</option>
                        <option value="hammer">🔨 錘（重擊雙手）</option>
                        <option value="staff">🪄 魔法杖（法師）</option>
                        <option value="katana">🪒 刀</option>
                    </select>
                </div>
                <div>特效名稱: <input type="text" id="cw-skn" value="星辰爆" maxlength="8" style="width:40%; background:#000; color:#fde68a; padding:2px; border:1px solid #475569;">
                    屬性:
                    <select id="cw-ele" style="width:28%; background:#000; color:#60a5fa; padding:2px; border:1px solid #475569; font-weight:bold;">
                        <option value="none">⚪ 無屬性</option>
                        <option value="fire">🔥 火</option>
                        <option value="water">💧 水</option>
                        <option value="earth">🪨 地</option>
                        <option value="wind" selected>⚡ 風</option>
                    </select>
                </div>
                <div>基礎傷害（覆寫型態預設）:
                    小型 <input type="number" id="cw-dmgs" placeholder="自動" min="0" style="width:50px; background:#000; color:#fff; text-align:center; border:1px solid #475569;">
                    大型 <input type="number" id="cw-dmgl" placeholder="自動" min="0" style="width:50px; background:#000; color:#fff; text-align:center; border:1px solid #475569;">
                    <span style="font-size:11px; color:#64748b;">（留空＝用型態預設）</span>
                </div>
                <div>特效傷害模式:
                    <select id="cw-dmgmode" style="background:#000; color:#fde68a; padding:2px; border:1px solid #475569; font-weight:bold;">
                        <option value="dice" selected>🎲 骰子（×強化倍率）</option>
                        <option value="fixed">🔢 固定數值</option>
                    </select>
                </div>
                <div id="cw-dice-row">特效傷害骰子:
                    <input type="number" id="cw-dicen" value="10" min="1" style="width:42px; background:#000; color:#fff; text-align:center; border:1px solid #475569;"> D
                    <input type="number" id="cw-dicef" value="20" min="1" style="width:48px; background:#000; color:#fff; text-align:center; border:1px solid #475569;">
                    <span style="font-size:11px; color:#64748b;">（如 10D20）</span>
                </div>
                <div id="cw-fixed-row" style="display:none;">特效固定傷害:
                    <input type="number" id="cw-fixeddmg" value="500" min="1" style="width:70px; background:#000; color:#fff; text-align:center; border:1px solid #475569;">
                    <span style="font-size:11px; color:#64748b;">（每次特效固定此值，仍×強化倍率與魔攻）</span>
                </div>
                <div style="border-top:1px dashed #475569; padding-top:6px; display:flex; flex-direction:column; gap:4px;">
                    <div style="color:#a78bfa; font-weight:bold; font-size:12px;">✨ 特效發動設定</div>
                    <label style="display:flex; align-items:center; gap:4px;">
                        <input type="checkbox" id="cw-aoe"> 🌐 攻擊全體：特效對敵方全體施放（同地獄火）
                    </label>
                    <div>發動機率模式:
                        <select id="cw-procmode" style="background:#000; color:#fde68a; padding:2px; border:1px solid #475569; font-weight:bold;">
                            <option value="scale" selected>📈 隨強化（1%+強化×1%）</option>
                            <option value="fixed">🔒 固定機率</option>
                        </select>
                    </div>
                    <div id="cw-procfixed-row" style="display:none;">固定發動機率:
                        <input type="number" id="cw-procfixed" value="100" min="1" max="100" style="width:50px; background:#000; color:#fff; text-align:center; border:1px solid #475569;">%
                        <span style="font-size:11px; color:#64748b;">（不隨強化變，例如 100% 必定發動）</span>
                    </div>
                </div>
                <div style="border-top:1px dashed #475569; padding-top:6px; display:flex; flex-direction:column; gap:4px;">
                    <div style="color:#f87171; font-weight:bold; font-size:12px;">🩸 吸血 / 吸魔（引擎原生特性）</div>
                    <label style="display:flex; align-items:center; gap:4px;">
                        <input type="checkbox" id="cw-vamp"> 吸血：一般攻擊吸取傷害
                        <input type="number" id="cw-vamp-pct" value="5" min="1" max="100" style="width:46px; background:#000; color:#fca5a5; text-align:center; border:1px solid #475569;">% 為 HP
                    </label>
                    <label style="display:flex; align-items:center; gap:4px;">
                        <input type="checkbox" id="cw-mponhit"> 吸魔：命中恢復 MP
                        <span style="font-size:11px; color:#64748b;">（量＝1+max(0,強化-6)，引擎固定）</span>
                    </label>
                    <label style="display:flex; align-items:center; gap:4px;">
                        <input type="checkbox" id="cw-spheal"> 特效吸血：施放特效時回
                        <input type="number" id="cw-spheal-pct" value="20" min="1" max="100" style="width:46px; background:#000; color:#fca5a5; text-align:center; border:1px solid #475569;">% 特效傷害為 HP
                    </label>
                    <span style="font-size:11px; color:#64748b;">※ 特效吸血需有上方特效骰子才有意義。</span>
                </div>
                <div>職業限制:
                    <select id="cw-req" style="width:45%; background:#000; color:#93c5fd; padding:2px; border:1px solid #475569;">
                        <option value="all" selected>全職業</option>
                        <option value="knight">騎士</option>
                        <option value="mage">法師</option>
                        <option value="elf">妖精</option>
                        <option value="dark">黑暗妖精</option>
                        <option value="illusion">幻術士</option>
                        <option value="dragon">龍騎士</option>
                        <option value="warrior">狂戰士</option>
                        <option value="royal">王族</option>
                    </select>
                    強化+: <input type="number" id="cw-en" value="9" min="0" style="width:45px; background:#000; text-align:center; border:1px solid #475569;">
                </div>
                <div style="font-size:11px; color:#a78bfa; line-height:1.5;">
                    📊 預估：發動率 <span id="cw-preview-rate" style="color:#fde68a;">10%</span>　·　特效傷害倍率 <span id="cw-preview-dmg" style="color:#fde68a;">×1.9</span>（未計魔攻加成）
                </div>
                <button id="btn-add-cw" style="background:#9333ea; color:white; border:none; padding:6px; border-radius:4px; font-weight:bold; cursor:pointer; margin-top:2px;">🔮 鍛造並放入背包</button>
                <div style="font-size:11px; color:#64748b; line-height:1.5;">
                    ※ 規格存於瀏覽器（localStorage），<b style="color:#f87171;">每次進遊戲後須再執行一次本修改器</b>，自訂武器才會生效（會自動重新注入）。<br>
                    ※ 發動率 = 1% + 強化×1%；特效傷害 = 骰子 ×(1+強化/10)，再受魔法傷害加成與屬性剋制。
                </div>
                <button id="btn-clear-cw" style="background:#7f1d1d; color:#fca5a5; border:none; padding:4px; border-radius:4px; font-size:11px; cursor:pointer;">🗑 清除所有自訂武器規格</button>
            </div>

            <div style="font-weight:bold; color:#94a3b8;">🎒 目前背包內容（<span id="mod-inv-count">0</span>）</div>
            <div id="mod-inv-container" style="background:#020617; border:1px solid #334155; border-radius:6px; min-height:120px; max-height:240px; overflow-y:auto; padding:6px; display:flex; flex-direction:column; gap:4px; flex-shrink:0;"></div>
        </div>

        <div style="padding:10px; background:#1e293b; border-top:1px solid #334155; display:flex; gap:8px;">
            <button id="btn-apply-live" style="flex:1; background:#0ea5e9; color:white; border:none; padding:10px; border-radius:6px; font-weight:bold; cursor:pointer;">⚡ 即時套用<br><span style="font-size:10px;">(不重整)</span></button>
            <button id="btn-save-all" style="flex:1.4; background:#10b981; color:white; border:none; padding:10px; border-radius:6px; font-weight:bold; font-size:14px; cursor:pointer;">💾 套用並存檔重整</button>
        </div>`;
    document.body.appendChild(panel);

    // ===== 6. 匯出存檔（修正 key）=====
    document.getElementById('btn-export-now').onclick = function () {
        let data = localStorage.getItem(slotKey());
        if (!data) { // 退路：當前記憶體狀態
            let ver = (typeof G('SAVE_VERSION') !== 'undefined') ? G('SAVE_VERSION') : 2;
            data = JSON.stringify({ v: ver, p: player, ms: G('mapState') || {}, ticks: (G('state') && G('state').ticks) || 0 });
        }
        navigator.clipboard.writeText(data)
            .then(() => alert("📋 已複製「存檔位 " + getSlot() + "」的存檔到剪貼簿。"))
            .catch(() => prompt("請手動複製下方存檔代碼：", data));
    };

    // ===== 7. 匯入存檔（修正 key）=====
    document.getElementById('btn-import-now').onclick = function () {
        let code = prompt("請貼上要匯入的存檔字串（JSON）：");
        if (!code) return;
        try {
            let clean = code.trim();
            JSON.parse(clean); // 驗證
            localStorage.setItem(slotKey(), clean);
            alert("📥 已匯入到存檔位 " + getSlot() + "！即將重新整理加載。");
            location.reload();
        } catch (e) { alert("❌ 匯入失敗，請確認是完整的 JSON 存檔字串。"); }
    };

    // ===== 8. 背包即時預覽 =====
    function updateInvPanel() {
        let c = document.getElementById('mod-inv-container');
        c.innerHTML = '';
        if (!player.inv || !player.inv.length) {
            c.innerHTML = '<span style="color:#64748b; font-style:italic;">背包空無一物</span>';
            document.getElementById('mod-inv-count').innerText = 0;
            return;
        }
        document.getElementById('mod-inv-count').innerText = player.inv.length;
        player.inv.forEach((item, index) => {
            let db = DB.items[item.id] || { n: "未知" };
            let tier = item.anc === 'eternal' ? "永恆 " : item.anc === 'immortal' ? "不朽 "
                : item.anc === 'primordial' ? "太初 " : item.anc === true ? "遠古 " : "";
            let status = item.bless === 'cursed' ? "詛咒的 " : item.bless === true ? "祝福的 " : "";
            let en = item.en > 0 ? `+${item.en} ` : "";
            // 屬性顯示：支援新碼(fr/wa/wi/ea)與舊碼(fire1等)自動映射
            let ATTR_LEGACY = { fire1:'fr1', fire3:'fr2', fire5:'fr3', water1:'wa1', water3:'wa2', water5:'wa3', wind1:'wi1', wind3:'wi2', wind5:'wi3', earth1:'ea1', earth3:'ea2', earth5:'ea3' };
            let attrCode = item.attr ? (ATTR_MAP[item.attr] ? item.attr : ATTR_LEGACY[item.attr]) : null;
            let attr = (attrCode && ATTR_MAP[attrCode]) ? ATTR_MAP[attrCode] + " " : "";
            let cnt = item.cnt > 1 ? ` x${item.cnt}` : "";
            let lock = item.lock ? "🔒" : "";
            let seteff = item.seteff ? `<span style="color:#4ade80;"> ✦${item.seteff}</span>` : "";
            let row = document.createElement('div');
            let lc = item.seteff ? "#22c55e" : item.anc === 'eternal' ? "#ef4444" : item.anc === 'immortal' ? "#22c55e"
                : item.anc === 'primordial' ? "#3b82f6" : item.anc === true ? "#a855f7" : "#3b82f6";
            row.style.cssText = `display:flex; justify-content:space-between; align-items:center; background:#1e293b; padding:4px 8px; border-radius:4px; font-size:12px; border-left:3px solid ${lc};`;
            row.innerHTML = `<span style="color:#f1f5f9;">${lock}${attr}${tier}${status}${en}${db.n}${cnt}${seteff}</span>
                <button data-idx="${index}" class="btn-del-item" style="background:#451a03; color:#f87171; border:1px solid #991b1b; padding:1px 6px; border-radius:3px; cursor:pointer;">移除</button>`;
            c.appendChild(row);
        });
        c.querySelectorAll('.btn-del-item').forEach(btn => {
            btn.onclick = function () { player.inv.splice(parseInt(this.getAttribute('data-idx')), 1); updateInvPanel(); };
        });
    }

    // ===== 8a-2. 裝備本體切換：slot → 合法候選裝備清單 =====
    // 判斷某 slot 該列哪些 DB.items（依 type / slot / isArrow）
    function slotCandidates(slot) {
        const out = [];
        const myCls = player.cls; // knight / mage / elf / dark
        const reqOK = (req) => {
            if (!req) return true;                 // 無限制
            const list = String(req).split(',').map(s => s.trim());
            if (list.includes('all')) return true;
            return myCls ? list.includes(myCls) : true; // 無職業資訊時全列
        };
        Object.entries(DB.items).forEach(([id, v]) => {
            let match = false;
            if (slot === 'wpn')        match = (v.type === 'wpn' && !v.isArrow);
            else if (slot === 'arrow') match = (v.type === 'wpn' && v.isArrow === true);
            else if (slot === 'ring1' || slot === 'ring2' || slot === 'ring3' || slot === 'ring4') match = (v.type === 'acc' && v.slot === 'ring');
            else if (slot === 'amulet') match = (v.type === 'acc' && v.slot === 'amulet');
            else if (slot === 'belt')   match = (v.type === 'acc' && v.slot === 'belt');
            else if (slot === 'pet')    match = (v.type === 'acc' && v.slot === 'pet');
            else if (slot === 'ear1' || slot === 'ear2') match = (v.type === 'acc' && v.slot === 'ear');
            else if (slot === 'doll')   match = (v.type === 'acc' && v.slot === 'doll');
            else match = (v.type === 'arm' && v.slot === slot); // helm/armor/shield/cloak/tshirt/gloves/boots
            if (match && reqOK(v.req)) out.push([id, v.n || id]);
        });
        // 依名稱排序，方便尋找
        out.sort((a, b) => a[1].localeCompare(b[1], 'zh-Hant'));
        return out;
    }
    // 本體切換下拉（與 buildSel 同風格，但選項是 [id, 名稱]）
    const buildItemSel = (selId, cands, currentId) => {
        let h = `<select id="${selId}" style="background:#03122b; color:#fde68a; border:1px solid #b45309; padding:1px; font-size:11px; max-width:150px;">`;
        let hasCurrent = cands.some(([id]) => id === currentId);
        if (!hasCurrent) {
            const cn = (DB.items[currentId] && DB.items[currentId].n) || currentId;
            h += `<option value="${currentId}" selected style="color:#f87171;">⚠ ${cn}（非本職/特殊）</option>`;
        }
        cands.forEach(([id, name]) => {
            h += `<option value="${id}"${id === currentId ? ' selected' : ''} style="color:#fde68a;">${name}</option>`;
        });
        return h + '</select>';
    };

    // ===== 8b. 已穿戴裝備詞綴渲染 =====
    function renderEquipPanel() {
        let box = document.getElementById('mod-eq-container');
        box.innerHTML = '';
        let any = false;
        SLOT_DEFS.forEach(([slot, label]) => {
            let it = player.eq && player.eq[slot];
            if (!it) return;
            any = true;
            let db = DB.items[it.id] || { n: '未知' };
            let isDoll = (slot === 'doll') || (db.noEnhance === true);   // 魔法娃娃：不可強化，隱藏詞綴列
            let row = document.createElement('div');
            row.style.cssText = 'background:#0b1220; border:1px solid #1e3a8a; border-radius:5px; padding:6px;';
            row.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                    <span style="color:#93c5fd; font-weight:bold; font-size:12px;">[${label}] ${db.n}${it.seteff ? `<span style="color:#4ade80;"> ✦${it.seteff}</span>` : ''}</span>
                </div>
                <div style="display:flex; flex-wrap:wrap; gap:4px; align-items:center; font-size:11px; color:#94a3b8; margin-bottom:4px;">
                    <span style="color:#fbbf24;">種類:</span>${buildItemSel(`eq-${slot}-id`, slotCandidates(slot), it.id)}
                </div>
                ${isDoll ? `<div style="font-size:11px; color:#64748b;">此部位不可強化，只能切換種類。</div>` : `
                <div style="display:flex; flex-wrap:wrap; gap:4px; align-items:center; font-size:11px; color:#94a3b8;">
                    +<input type="number" id="eq-${slot}-en" value="${it.en || 0}" style="width:42px; background:#000; color:#fff; text-align:center; border:1px solid #475569;">
                    ${buildSel(`eq-${slot}-tier`, TIER_ITEMS, ancToVal(it.anc), 'width:78px;')}
                    ${buildSel(`eq-${slot}-status`, STATUS_ITEMS, blessToVal(it.bless), 'width:70px;')}
                    ${buildSel(`eq-${slot}-attr`, ATTR_ITEMS, (it.attr || 'false'), 'width:96px;')}
                    ${buildSel(`eq-${slot}-seteff`, SETEFF_ITEMS, (it.seteff || 'false'), 'width:112px;')}
                </div>`}`;
            box.appendChild(row);
        });
        if (!any) box.innerHTML = '<span style="color:#64748b; font-style:italic;">目前沒有穿戴任何裝備。</span>';
    }

    // 套用穿戴裝備的詞綴改動（就地寫回 player.eq[slot]，保留 id/uid/cnt）
    document.getElementById('btn-apply-eq').onclick = function () {
        let changed = 0;
        SLOT_DEFS.forEach(([slot]) => {
            let it = player.eq && player.eq[slot];
            if (!it) return;
            // 本體種類切換（所有格皆可，含娃娃）：只換 id，詞綴全保留；換成功補 uid
            let idEl = document.getElementById(`eq-${slot}-id`);
            if (idEl && idEl.value && idEl.value !== it.id) {
                it.id = idEl.value;
                if (hasFn('uid')) it.uid = uid(); // 換本體後重編 uid 避免穿戴判定衝突
                changed++;
            }
            // 詞綴列（娃娃等 noEnhance 部位沒有這些輸入 → 跳過，只換種類）
            let enEl = document.getElementById(`eq-${slot}-en`);
            if (!enEl) return;
            it.en = parseInt(enEl.value) || 0;
            it.anc = valToAnc(document.getElementById(`eq-${slot}-tier`).value);
            it.bless = valToBless(document.getElementById(`eq-${slot}-status`).value);
            let av = document.getElementById(`eq-${slot}-attr`).value; it.attr = av === 'false' ? false : av;
            let sv = document.getElementById(`eq-${slot}-seteff`).value; it.seteff = sv === 'false' ? false : sv;
            changed++;
        });
        liveRefresh();          // 重算屬性 + 套裝加成 + 刷新遊戲 UI
        renderEquipPanel();     // 重繪面板（同步顯示）
        alert(`🧿 已即時套用 ${changed} 件穿戴裝備的詞綴改動（尚未寫檔，按底部綠色鈕固化）。`);
    };

    // ===== 9. 生成道具 =====
    // 🔍 道具搜尋：即時過濾下拉選項（保留 optgroup，依名稱/ID 關鍵字隱藏不符項）
    (function setupItemSearch() {
        const sel = document.getElementById('add-id');
        const box = document.getElementById('add-search');
        const cnt = document.getElementById('add-count');
        if (!sel || !box) return;
        // 記錄原始全部 optgroup/option（HTML 字串），方便重建
        const fullHtml = sel.innerHTML;
        const doFilter = () => {
            const kw = box.value.trim().toLowerCase();
            if (!kw) { sel.innerHTML = fullHtml; if (cnt) cnt.textContent = ''; return; }
            // 解析全部 option，比對名稱或 id
            const tmp = document.createElement('select');
            tmp.innerHTML = fullHtml;
            let shown = 0, html = '';
            tmp.querySelectorAll('optgroup').forEach(og => {
                let opts = '';
                og.querySelectorAll('option').forEach(o => {
                    if (o.textContent.toLowerCase().includes(kw) || o.value.toLowerCase().includes(kw)) {
                        opts += `<option value="${o.value}">${o.textContent}</option>`;
                        shown++;
                    }
                });
                if (opts) html += `<optgroup label="${og.label}" style="background:#0f172a; color:#94a3b8;">${opts}</optgroup>`;
            });
            sel.innerHTML = html || '<option value="">（無符合項目）</option>';
            if (cnt) cnt.textContent = `符合 ${shown} 項`;
        };
        box.addEventListener('input', doFilter);
    })();

    document.getElementById('btn-add-item').onclick = function () {
        let id = document.getElementById('add-id').value;
        let tier = document.getElementById('add-tier').value;
        let status = document.getElementById('add-status').value;
        let en = parseInt(document.getElementById('add-en').value) || 0;
        let cnt = parseInt(document.getElementById('add-cnt').value) || 1;
        let attrVal = document.getElementById('add-attr').value;
        let seteffVal = document.getElementById('add-seteff').value;
        let lock = document.getElementById('add-lock').checked;

        let newItem = {
            id, cnt, en,
            bless: status === 'bless' ? true : status === 'cursed' ? 'cursed' : false,
            anc: tier === 'true' ? true : ['eternal', 'immortal', 'primordial'].includes(tier) ? tier : false,
            attr: attrVal === 'false' ? false : attrVal,
            seteff: seteffVal === 'false' ? false : seteffVal,
            lock, junk: false
        };
        if (hasFn('uid')) newItem.uid = uid();   // 補 uid：避免之後在遊戲裡穿戴/堆疊判定出錯
        if (!player.inv) player.inv = [];
        player.inv.push(newItem);
        updateInvPanel();
    };

    // ===== 9b. 自訂魔法武器產生器 =====
    // 各武器型態的基礎數值（取自遊戲既有武器當基準）
    const CW_BASE = {
        bow:    { dmgS: 2,  dmgL: 2,  spd: 1.0, isBow: true,  w2h: false, hit: 0 },
        sword:  { dmgS: 15, dmgL: 11, spd: 1.0, isBow: false, w2h: false, hit: 5 },
        dual:   { dmgS: 12, dmgL: 12, spd: 0.8, isBow: false, w2h: true,  hit: 0 },
        spear:  { dmgS: 6,  dmgL: 10, spd: 1.0, isBow: false, w2h: true,  hit: 0 },
        hammer: { dmgS: 9,  dmgL: 11, spd: 1.0, isBow: false, w2h: true,  hit: 0 },
        staff:  { dmgS: 4,  dmgL: 5,  spd: 1.0, isBow: false, w2h: false, hit: 0 },
        katana: { dmgS: 10, dmgL: 12, spd: 1.1, isBow: false, w2h: false, hit: 1 }
    };
    // 即時預覽（發動率 / 傷害倍率）
    const cwUpdatePreview = () => {
        const en = parseInt(document.getElementById('cw-en').value) || 0;
        const rEl = document.getElementById('cw-preview-rate');
        const dEl = document.getElementById('cw-preview-dmg');
        const procMode = document.getElementById('cw-procmode') ? document.getElementById('cw-procmode').value : 'scale';
        if (rEl) {
            if (procMode === 'fixed') {
                const pf = parseInt(document.getElementById('cw-procfixed').value) || 1;
                rEl.textContent = pf + '%（固定）';
            } else {
                rEl.textContent = (1 + en) + '%';
            }
        }
        if (dEl) dEl.textContent = '×' + (1 + en / 10).toFixed(1);
    };
    ['cw-en','cw-procfixed'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', cwUpdatePreview);
    });
    // 特效傷害模式切換：顯示/隱藏 骰子列 vs 固定值列
    const cwDmgMode = document.getElementById('cw-dmgmode');
    if (cwDmgMode) {
        cwDmgMode.addEventListener('change', function () {
            const fixed = this.value === 'fixed';
            const diceRow = document.getElementById('cw-dice-row');
            const fixedRow = document.getElementById('cw-fixed-row');
            if (diceRow) diceRow.style.display = fixed ? 'none' : '';
            if (fixedRow) fixedRow.style.display = fixed ? '' : 'none';
        });
    }
    // 發動機率模式切換：顯示/隱藏 固定機率列
    const cwProcMode = document.getElementById('cw-procmode');
    if (cwProcMode) {
        cwProcMode.addEventListener('change', function () {
            const fixed = this.value === 'fixed';
            const row = document.getElementById('cw-procfixed-row');
            if (row) row.style.display = fixed ? '' : 'none';
            cwUpdatePreview();
        });
    }

    document.getElementById('btn-add-cw').onclick = function () {
        const name = (document.getElementById('cw-name').value || '我的魔法武器').trim();
        const base = document.getElementById('cw-base').value;
        const skn  = (document.getElementById('cw-skn').value || '魔法爆發').trim();
        const ele  = document.getElementById('cw-ele').value;
        // 特效傷害：骰子 或 固定值（固定值＝dice:[N,1]，roll(N,1)=N）
        const dmgMode = document.getElementById('cw-dmgmode').value;
        let diceN, diceF;
        if (dmgMode === 'fixed') {
            diceN = Math.max(1, parseInt(document.getElementById('cw-fixeddmg').value) || 1);
            diceF = 1;
        } else {
            diceN = Math.max(1, parseInt(document.getElementById('cw-dicen').value) || 1);
            diceF = Math.max(1, parseInt(document.getElementById('cw-dicef').value) || 1);
        }
        const req  = document.getElementById('cw-req').value;
        const en   = Math.max(0, parseInt(document.getElementById('cw-en').value) || 0);
        // 基礎傷害覆寫（留空＝用型態預設）
        const dmgsRaw = document.getElementById('cw-dmgs').value.trim();
        const dmglRaw = document.getElementById('cw-dmgl').value.trim();

        // 🩸 吸血/吸魔
        const vamp = document.getElementById('cw-vamp').checked
            ? Math.min(1, Math.max(0.01, (parseInt(document.getElementById('cw-vamp-pct').value) || 5) / 100)) : 0;
        const mpOnHit = document.getElementById('cw-mponhit').checked;
        const spHeal = document.getElementById('cw-spheal').checked
            ? Math.min(1, Math.max(0.01, (parseInt(document.getElementById('cw-spheal-pct').value) || 20) / 100)) : 0;

        // 🌐 攻擊全體 + 發動機率模式
        const aoe = document.getElementById('cw-aoe').checked;
        const procMode = document.getElementById('cw-procmode').value;
        const procFixed = Math.min(100, Math.max(1, parseInt(document.getElementById('cw-procfixed').value) || 100));

        const b = CW_BASE[base] || CW_BASE.bow;
        // 唯一 id：固定前綴 + 時間戳
        const cwId = 'wpn_custom_' + Date.now().toString(36);
        const spec = {
            n: name, skn, ele, diceN, diceF, req,
            dmgS: dmgsRaw !== '' ? Math.max(0, parseInt(dmgsRaw) || 0) : b.dmgS,
            dmgL: dmglRaw !== '' ? Math.max(0, parseInt(dmglRaw) || 0) : b.dmgL,
            spd: b.spd, hit: b.hit,
            isBow: b.isBow, w2h: b.w2h,
            vampPct: vamp, mpOnHit: mpOnHit, spHeal: spHeal,
            aoe: aoe, procMode: procMode, procFixed: procFixed
        };

        // 1) 注入 DB.items（本次 session 立即可用）
        DB.items[cwId] = buildWeaponDef(spec);
        // 2) 存 localStorage（持久化，下次載入修改器自動重新注入）
        const all = loadCustomWeapons();
        all[cwId] = spec;
        saveCustomWeapons(all);
        // 3) 產生物品實例放入背包（屬性用新制代碼 fr5/wa5/wi5/ea5）
        let attrCode = (ele !== 'none' && ATTR_PREFIX[ele]) ? (ATTR_PREFIX[ele] + '5') : false;
        let newItem = { id: cwId, cnt: 1, en, bless: false, anc: false, attr: attrCode, seteff: false, lock: true, junk: false };
        if (hasFn('uid')) newItem.uid = uid();
        if (!player.inv) player.inv = [];
        player.inv.push(newItem);
        updateInvPanel();
        liveRefresh();
        let extra = '';
        if (aoe) extra += `\n🌐 特效攻擊全體`;
        if (vamp) extra += `\n🩸 吸血 ${Math.round(vamp * 100)}%`;
        if (mpOnHit) extra += `\n💧 命中回MP`;
        if (spHeal) extra += `\n✨ 特效吸血 ${Math.round(spHeal * 100)}%`;
        let rateText = (procMode === 'fixed') ? `固定 ${procFixed}%` : `${1 + en}%（隨強化）`;
        alert(`🔮 已鍛造「${name}」+${en}！\n發動率 ${rateText}、特效傷害 ${diceN}D${diceF}${diceF>1?'×'+(1 + en / 10).toFixed(1):''}（${skn}）。${extra}\n已放入背包並存入瀏覽器，記得按底部綠色鈕寫檔。\n\n⚠ 下次進遊戲後請再執行一次修改器，武器才會生效。`);
    };

    document.getElementById('btn-clear-cw').onclick = function () {
        if (!confirm("確定清除所有自訂武器規格？\n已放進背包/穿在身上的自訂武器，重整後將失效（變成未知物品）。")) return;
        try { localStorage.removeItem(CW_KEY); } catch (e) {}
        alert("🗑 已清除所有自訂武器規格。");
    };

    // ===== 10. 快捷操作 =====
    document.getElementById('btn-fill-hpmp').onclick = function () {
        liveRefresh(); // 先重算出最新 mhp/mmp
        player.hp = player.mhp; player.mp = player.mmp;
        liveRefresh();
        alert("❤️ HP/MP 已補滿。");
    };
    document.getElementById('btn-consolidate').onclick = function () {
        if (hasFn('consolidateInventory')) { try { consolidateInventory(); } catch (e) {} }
        updateInvPanel(); liveRefresh();
        alert("🧹 背包已整理（合併同性質未強化物品）。");
    };
    document.getElementById('btn-clear-inv').onclick = function () {
        if (!confirm("確定清空整個背包？此動作無法復原（除非你先匯出存檔）。")) return;
        player.inv = []; updateInvPanel(); liveRefresh();
    };
    document.getElementById('btn-give-proof').onclick = function () {
        if (!DB.items['item_mastery_proof']) { alert("❌ 此版本找不到「精通之證」(item_mastery_proof)。"); return; }
        if (!player.inv) player.inv = [];
        if (player.inv.some(i => i.id === 'item_mastery_proof')) { alert("ℹ️ 背包已有一枚精通之證，無需重複。"); return; }
        player.inv.push({ id: 'item_mastery_proof', cnt: 1, en: 0, bless: false, anc: false, attr: false, seteff: false, lock: false, junk: false });
        updateInvPanel();
        alert("🏅 已放入「精通之證」，回威頓村找「漢」交付即可開啟精通。");
    };
    document.getElementById('btn-all60').onclick = function () {
        STATS.forEach(s => { let el = document.getElementById('mod-' + s.k); if (el) el.value = 99; });
    };
    // 💪 六圍突破80 開關
    const syncStatBreakBtn = () => {
        let el = document.getElementById('stat-break-state');
        if (el) { let on = isStatBreakOn(); el.textContent = on ? '開啟 ✅' : '關閉'; el.parentElement.style.background = on ? '#6d28d9' : '#7c3aed'; }
    };
    document.getElementById('btn-stat-break').onclick = function () {
        let on = isStatBreakOn();
        if (on) {
            try { localStorage.setItem(STAT_CAP_KEY, '0'); } catch (e) {}
            restoreStatBreak();
            liveRefresh();
            alert("💪 六圍突破80已【關閉】，恢復原本 80 上限。");
        } else {
            try { localStorage.setItem(STAT_CAP_KEY, '1'); } catch (e) {}
            let n = applyStatBreak();
            liveRefresh();
            alert(`💪 六圍突破80已【開啟】！\n${n} 個能力效果表改為線性外推，六圍 80 以上將繼續提升能力（越高越強）。\n\n範例：力量100→近戰傷害+55、力量150→+80；智力100→魔法傷害+35。\nHP/MP 成長也一併突破（體質/精神越高血魔越多）。\n\n⚠ 下次進遊戲後請再執行一次修改器，此突破才會持續生效。`);
        }
        syncStatBreakBtn();
    };
    syncStatBreakBtn();

    // ⚡ 戰鬥節奏修改
    const syncTempoUI = () => {
        const t = loadTempo();
        let aEl = document.getElementById('tempo-aspd'), cEl = document.getElementById('tempo-cast'),
            sEl = document.getElementById('tempo-stun'), rEl = document.getElementById('tempo-respawn'),
            stEl = document.getElementById('tempo-state');
        if (aEl) aEl.value = (t.aspd != null ? t.aspd : '');
        if (cEl) cEl.value = (t.castLock != null ? t.castLock : '');
        if (sEl) sEl.value = (t.hitstun != null ? t.hitstun : '');
        if (rEl) rEl.checked = !!t.fastRespawn;
        if (stEl) { stEl.textContent = t.on ? '開啟 ✅' : '關閉'; stEl.parentElement.style.background = t.on ? '#b45309' : '#d97706'; }
    };
    const _hookTempoRecompute = () => {
        if (!window._tempoHooked && typeof window.recomputeStats === 'function') {
            const orig = window.recomputeStats;
            window.recomputeStats = function () { let r = orig.apply(this, arguments); applyTempoToStats(); return r; };
            window._tempoHooked = true;
        }
    };
    document.getElementById('btn-tempo-apply').onclick = function () {
        let t = loadTempo();
        const rd = (id) => { let v = document.getElementById(id).value.trim(); return v === '' ? null : v; };
        t.aspd = rd('tempo-aspd');
        t.castLock = rd('tempo-cast');
        t.hitstun = rd('tempo-stun');
        t.fastRespawn = document.getElementById('tempo-respawn').checked;
        t.on = !t.on;   // 切換開關
        saveTempo(t);
        if (t.on) {
            _hookTempoRecompute();
            applyTempoToStats();
            startRespawnAccel();
            liveRefresh();
            let parts = [];
            if (t.aspd != null) parts.push(`攻擊間隔 ${t.aspd}秒`);
            if (t.castLock != null) parts.push(`施法冷卻 ${t.castLock}tick`);
            if (t.hitstun != null) parts.push(`硬直 ${t.hitstun}tick`);
            if (t.fastRespawn) parts.push('怪物立即重生');
            alert(`⚡ 戰鬥節奏已【開啟】！\n${parts.length ? parts.join('、') : '（未設定任何項目）'}\n\n⚠ 下次進遊戲後請再執行一次修改器，此設定才會持續生效。`);
        } else {
            stopRespawnAccel();
            liveRefresh();   // 重算恢復原值
            alert("⚡ 戰鬥節奏已【關閉】，恢復遊戲原本數值。");
        }
        syncTempoUI();
    };
    document.getElementById('btn-tempo-preset').onclick = function () {
        // 一鍵極速：攻擊間隔0.1秒、施法0、硬直0、怪物立即重生
        document.getElementById('tempo-aspd').value = '0.1';
        document.getElementById('tempo-cast').value = '0';
        document.getElementById('tempo-stun').value = '0';
        document.getElementById('tempo-respawn').checked = true;
        alert("🚀 已填入極速數值，按「套用」開啟生效。");
    };
    syncTempoUI();

    // 🤝 傭兵上限
    const syncAllyCapUI = () => {
        const v = loadAllyCap();
        let inp = document.getElementById('ally-cap'), st = document.getElementById('ally-cap-state');
        if (inp && v != null) inp.value = v;
        if (st) { let on = (v != null); st.textContent = on ? ('開啟 ✅（' + v + '名）') : '關閉'; st.parentElement.style.background = on ? '#0369a1' : '#0284c7'; }
    };
    document.getElementById('btn-ally-cap').onclick = function () {
        const on = (loadAllyCap() != null);
        if (on) {
            try { localStorage.removeItem(ALLYCAP_KEY); } catch (e) {}
            restoreAllyCap();
            alert("🤝 傭兵上限已【關閉】，恢復遊戲原本 3 名。");
        } else {
            let n = Math.max(1, Math.min(99, parseInt(document.getElementById('ally-cap').value) || 3));
            try { localStorage.setItem(ALLYCAP_KEY, String(n)); } catch (e) {}
            applyAllyCap(n);
            alert(`🤝 傭兵上限已【開啟】！\n同時上場人數上限改為 ${n} 名。\n（到招募 NPC 招募即可帶更多；已在場的不受影響）\n\n⚠ 下次進遊戲後請再執行一次修改器，此設定才會持續生效。`);
        }
        syncAllyCapUI();
    };
    syncAllyCapUI();

    const CLS_REQ = { knight: 'reqK', mage: 'reqM', elf: 'reqE', dark: 'reqD', illusion: 'reqI', dragon: 'reqDk', warrior: 'reqW', royal: 'reqRoy' };
    const CLS_NAME = { knight: '騎士', mage: '法師', elf: '妖精', dark: '黑暗妖精', illusion: '幻術士', dragon: '龍騎士', warrior: '狂戰士', royal: '王族' };
    function refreshClsInfo() {
        let el = document.getElementById('mod-cls-info');
        if (!el) return;
        let cls = player.cls || '未選擇';
        let cnt = (player.skills && player.skills.length) || 0;
        el.innerText = `（目前職業：${CLS_NAME[player.cls] || cls}，已學 ${cnt} 個）`;
    }
    function learnSkills(filterByClass) {
        if (!DB.skills) { alert("❌ 此版本找不到技能資料(DB.skills)。"); return; }
        if (!Array.isArray(player.skills)) player.skills = [];
        let reqF = CLS_REQ[player.cls];
        if (filterByClass && !reqF) { alert("❌ 無法判斷目前職業，請改用「學會全部技能」。"); return; }
        let added = 0;
        for (let id in DB.skills) {
            if (filterByClass && DB.skills[id][reqF] == null) continue;   // 該職業不可學
            if (!player.skills.includes(id)) { player.skills.push(id); added++; }
        }
        liveRefresh(); refreshClsInfo();
        alert(`🎓 已學會 ${added} 個技能（${filterByClass ? CLS_NAME[player.cls] + '本職' : '全部'}）。`);
    }
    document.getElementById('btn-learn-class').onclick = function () { learnSkills(true); };
    document.getElementById('btn-learn-all').onclick = function () { learnSkills(false); };
    document.getElementById('btn-clear-skills').onclick = function () {
        if (!confirm("確定清空所有已學技能？")) return;
        player.skills = []; liveRefresh(); refreshClsInfo();
    };
    // 🧝 妖精全屬性魔法開關
    const syncElfEleBtn = () => {
        let el = document.getElementById('elf-allele-state');
        if (el) { let on = isElfEleUnlocked(); el.textContent = on ? '開啟 ✅' : '關閉'; el.parentElement.style.background = on ? '#047857' : '#059669'; }
    };
    document.getElementById('btn-elf-allele').onclick = function () {
        let on = isElfEleUnlocked();
        if (on) {
            try { localStorage.setItem(ELF_ELE_KEY, '0'); } catch (e) {}
            restoreElfAllEle();
            liveRefresh();
            alert("🧝 妖精全屬性魔法已【關閉】，恢復原本屬性限制。");
        } else {
            try { localStorage.setItem(ELF_ELE_KEY, '1'); } catch (e) {}
            let n = applyElfAllEle();
            liveRefresh();
            alert(`🧝 妖精全屬性魔法已【開啟】！\n已解除 ${n} 個屬性魔法的「一生一屬性」限制，技能列表已即時刷新。\n\n所有屬性魔法（火/水/地/風）現在只要等級達標即可使用，不再受單一屬性綁定。\n\n⚠ 下次進遊戲後請再執行一次修改器，此解鎖才會持續生效。`);
        }
        syncElfEleBtn();
    };
    syncElfEleBtn();
    refreshClsInfo();

    // ===== 11. 寫入核心數值（共用）=====
    function applyCore() {
        player.gold = parseInt(document.getElementById('mod-gold').value) || 0;
        player.lv = parseInt(document.getElementById('mod-lv').value) || 1;
        player.exp = parseInt(document.getElementById('mod-exp').value) || 0;
        player.bonus = parseInt(document.getElementById('mod-bonus').value) || 0;
        // 六圍：把目標有效值回推成 alloc（有效 = base + alloc + panacea）
        player.alloc = player.alloc || { str:0,dex:0,con:0,int:0,wis:0,cha:0 };
        STATS.forEach(s => {
            let target = parseInt(document.getElementById('mod-' + s.k).value);
            if (isNaN(target)) return;
            let baseVal = (player.base?.[s.k] || 0) + (player.panacea?.[s.k] || 0);
            player.alloc[s.k] = Math.max(0, target - baseVal);
        });
    }

    // ⚡ 即時套用（不重整）
    document.getElementById('btn-apply-live').onclick = function () {
        applyCore(); liveRefresh(); updateInvPanel();
        // 同步輸入框顯示為實際生效值
        STATS.forEach(s => { let el = document.getElementById('mod-' + s.k); if (el) el.value = effStat(s.k); });
        alert("⚡ 已即時套用（尚未寫入存檔，建議再按「套用並存檔」固化）。");
    };

    // 💾 套用並存檔重整
    document.getElementById('btn-save-all').onclick = function () {
        applyCore(); liveRefresh();
        doSave();
        alert("💾 已套用並寫入存檔位 " + getSlot() + "！即將重新整理加載。");
        location.reload();
    };

    updateInvPanel();
    renderEquipPanel();
})();
