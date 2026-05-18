// ════════════════════════════════════════════════════
//  AIRTABLE CONFIG
// ════════════════════════════════════════════════════
const AT_TOKEN = 'patXq9n6nrQzhBWU6.cbbc392bbe38f2e5c733f8769bb4e114634396d16f0bbcbc6920c01b5a9fc385';
const AT_BASE  = 'appQ6ScbAbIclexoQ';
const AT_READY = AT_TOKEN !== 'YOUR_PERSONAL_ACCESS_TOKEN';
const AT_URL   = `https://api.airtable.com/v0/${AT_BASE}`;

// ── Airtable helpers ──────────────────────────────────────────────────────────
async function atReq(method, table, idOrQuery = '', body = null) {
    if (!AT_READY) throw new Error('Airtable not configured');
    const url  = `${AT_URL}/${encodeURIComponent(table)}${idOrQuery ? '/' + idOrQuery : ''}`;
    const opts = { method, headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res  = await fetch(url, opts);
    if (!res.ok) { const err = await res.json().catch(()=>{}); throw new Error(err?.error?.message || res.status); }
    return res.json();
}

async function atFindSetting(key) {
    const q = `?filterByFormula=${encodeURIComponent(`{Key}="${key}"`)}`;
    const d = await atReq('GET', 'Settings', q);
    return d.records?.[0] || null;
}

async function atCreate(table, fields) {
    const d = await atReq('POST', table, '', { records: [{ fields }] });
    return d.records?.[0] || null;
}

async function atUpdate(table, recId, fields) {
    return atReq('PATCH', table, recId, { fields });
}

async function atDelete(table, recId) {
    return atReq('DELETE', table, recId);
}

// ── Record ID cache ───────────────────────────────────────────────────────────
const REC = JSON.parse(localStorage.getItem('ping_rec') || '{}');
function cacheRec(key, id) { REC[key] = id; localStorage.setItem('ping_rec', JSON.stringify(REC)); }
function cachedId(key)     { return REC[key] || null; }

// ── Sync dot ─────────────────────────────────────────────────────────────────
function syncDot(state) {
    const el = document.getElementById('sync-dot');
    el.className = 'sync-dot' + (state ? ' ' + state : '');
}

// ════════════════════════════════════════════════════
//  PIN
// ════════════════════════════════════════════════════
async function sha256(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str + ':ping1'));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
}

let pinInput = '', pinMode = 'check', setupFirst = null;

function pinStatus(msg) { document.getElementById('pin-status').textContent = msg; }

function pinDots(n, err = false) {
    for (let i = 0; i < 4; i++) {
        const d = document.getElementById('pd' + i);
        d.className = 'pin-dot' + (i < n ? (err ? ' error' : ' filled') : '');
    }
}

async function bootPIN() {
    let saved = localStorage.getItem('ping_pin');

    if (!saved && AT_READY) {
        try {
            syncDot('busy');
            const rec = await atFindSetting('config');
            if (rec?.fields?.Value) {
                const cfg = JSON.parse(rec.fields.Value);
                if (cfg.pinHash)   { saved = cfg.pinHash; localStorage.setItem('ping_pin', saved); }
                if (cfg.waterGoal) S.waterGoal = cfg.waterGoal;
                if (rec.id)        cacheRec('settings', rec.id);
            }
            syncDot('ok');
        } catch { syncDot('err'); }
    }

    if (!saved) {
        pinMode = 'setup';
        pinStatus('SET YOUR 4-DIGIT PIN');
    } else {
        S.pin   = saved;
        pinMode = 'check';
        pinStatus('ENTER PIN');
    }
}

document.querySelectorAll('.pin-key[data-v]').forEach(k => {
    k.addEventListener('click', async () => {
        if (pinInput.length >= 4) return;
        k.classList.add('active');
        setTimeout(() => k.classList.remove('active'), 120);
        pinInput += k.dataset.v;
        pinDots(pinInput.length);
        if (pinInput.length === 4) await submitPIN();
    });
});

document.getElementById('pin-del').addEventListener('click', () => {
    if (!pinInput.length) return;
    pinInput = pinInput.slice(0, -1);
    pinDots(pinInput.length);
});

async function submitPIN() {
    const hash = await sha256(pinInput);
    if (pinMode === 'setup') {
        if (!setupFirst) {
            setupFirst = hash; pinInput = ''; pinDots(0);
            pinStatus('CONFIRM PIN');
        } else if (hash === setupFirst) {
            await persistPIN(hash);
            enterApp();
        } else {
            setupFirst = null; pinInput = ''; pinDots(0, true);
            pinStatus('MISMATCH — TRY AGAIN');
            setTimeout(() => { pinDots(0); pinStatus('SET YOUR 4-DIGIT PIN'); }, 1600);
        }
    } else {
        if (hash === S.pin) {
            enterApp();
        } else {
            pinInput = ''; pinDots(0, true);
            pinStatus('WRONG PIN');
            setTimeout(() => { pinDots(0); pinStatus('ENTER PIN'); }, 1500);
        }
    }
}

async function persistPIN(hash) {
    S.pin = hash;
    localStorage.setItem('ping_pin', hash);
    await saveSettings({ pinHash: hash, waterGoal: S.waterGoal });
}

async function saveSettings(obj) {
    if (!AT_READY) return;
    const value = JSON.stringify(obj);
    const recId = cachedId('settings');
    try {
        syncDot('busy');
        if (recId) {
            await atUpdate('Settings', recId, { Value: value });
        } else {
            const rec = await atCreate('Settings', { Key: 'config', Value: value });
            if (rec) cacheRec('settings', rec.id);
        }
        syncDot('ok');
    } catch { syncDot('err'); }
}

// ════════════════════════════════════════════════════
//  APP STATE
// ════════════════════════════════════════════════════
const NOW = new Date();
const S = {
    pin:        null,
    waterGoal:  2500,
    waterToday: [],
    sleepLogs:  [],
    today:      todayStr(),
};

let viewWY = NOW.getFullYear(), viewWM = NOW.getMonth() + 1;
let viewSY = NOW.getFullYear(), viewSM = NOW.getMonth() + 1;

const monthWater  = JSON.parse(localStorage.getItem('ping_mw') || '{}');
const monthSleep  = JSON.parse(localStorage.getItem('ping_ms') || '{}');
const loadedMonths = new Set(JSON.parse(localStorage.getItem('ping_lm') || '[]'));

const CIRC = 2 * Math.PI * 82; // ring circumference

function todayStr() { return new Date().toISOString().slice(0, 10); }
function hhmm()     { return new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:false }); }
function pad2(n)    { return String(n).padStart(2, '0'); }
function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
function monthKey(y, m)    { return `${y}-${pad2(m)}`; }

// ════════════════════════════════════════════════════
//  LAUNCH
// ════════════════════════════════════════════════════
async function enterApp() {
    document.getElementById('pin-screen').style.display = 'none';
    document.getElementById('app').classList.add('visible');

    document.getElementById('app-date').textContent =
        new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'short', day:'numeric' }).toUpperCase();

    document.getElementById('goal-input').value = S.waterGoal;
    document.getElementById('ring-goal').textContent = `/ ${S.waterGoal} ml`;

    // Load today's water from localStorage instantly
    S.waterToday = JSON.parse(localStorage.getItem('ping_w_' + S.today) || '[]');
    monthWater[S.today] = S.waterToday.reduce((s, e) => s + e.amount, 0);

    // Load sleep logs from localStorage instantly
    S.sleepLogs = JSON.parse(localStorage.getItem('ping_sleep') || '[]');

    renderWater();
    updateRing();
    renderWaterStats();
    renderSleepLog();
    updateSleepRing();
    renderSleepStats();
    renderSleepPixelGrid();

    // Chart renders after a tick so canvas has layout dimensions
    requestAnimationFrame(() => {
        renderWaterChart();
    });

    // Fetch current month from Airtable in background
    await loadMonthData(viewWY, viewWM);

    renderWater();
    updateRing();
    renderWaterStats();
    renderWaterChart();
    updateSleepRing();
    renderSleepStats();
    renderSleepPixelGrid();

    // Rebuild sleep log from freshly fetched data
    const logs = Object.entries(monthSleep)
        .map(([date, v]) => ({ date, ...v }))
        .sort((a, b) => b.date.localeCompare(a.date));
    if (logs.length) {
        S.sleepLogs = logs;
        localStorage.setItem('ping_sleep', JSON.stringify(S.sleepLogs));
        renderSleepLog();
        updateSleepRing();
    }
}

// ════════════════════════════════════════════════════
//  MONTHLY DATA LOADING
// ════════════════════════════════════════════════════
async function loadMonthData(y, m) {
    const mk             = monthKey(y, m);
    const isCurrentMonth = (y === NOW.getFullYear() && m === NOW.getMonth() + 1);

    if (loadedMonths.has(mk) && !isCurrentMonth) return;
    if (!AT_READY) return;

    const start   = `${y}-${pad2(m)}-01`;
    const end     = `${y}-${pad2(m)}-${pad2(daysInMonth(y, m))}`;
    const formula = encodeURIComponent(`AND({Date}>="${start}",{Date}<="${end}")`);

    try {
        syncDot('busy');
        const [wData, sData] = await Promise.all([
            atReq('GET', 'Water', `?filterByFormula=${formula}`).catch(() => ({ records: [] })),
            atReq('GET', 'Sleep', `?filterByFormula=${formula}`).catch(() => ({ records: [] }))
        ]);

        for (const rec of wData.records) {
            const dt      = rec.fields.Date;
            const entries = JSON.parse(rec.fields.Entries || '[]');
            monthWater[dt] = entries.reduce((s, e) => s + e.amount, 0);
            cacheRec('w_' + dt, rec.id);
            if (dt === S.today) {
                S.waterToday = entries;
                localStorage.setItem('ping_w_' + dt, JSON.stringify(entries));
            }
        }

        for (const rec of sData.records) {
            const dt = rec.fields.Date;
            monthSleep[dt] = {
                duration: rec.fields.Duration,
                quality:  rec.fields.Quality,
                bedtime:  rec.fields.Bedtime,
                waketime: rec.fields.Waketime,
            };
            cacheRec('s_' + dt, rec.id);
        }

        loadedMonths.add(mk);
        localStorage.setItem('ping_mw', JSON.stringify(monthWater));
        localStorage.setItem('ping_ms', JSON.stringify(monthSleep));
        localStorage.setItem('ping_lm', JSON.stringify([...loadedMonths]));
        syncDot('ok');
    } catch { syncDot('err'); }
}

// ════════════════════════════════════════════════════
//  SIDEBAR NAVIGATION
// ════════════════════════════════════════════════════
document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn[data-tab]').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab + '-page').classList.add('active');
        if (btn.dataset.tab === 'water') requestAnimationFrame(renderWaterChart);
    });
});

// ════════════════════════════════════════════════════
//  WATER RING
// ════════════════════════════════════════════════════
function updateRing() {
    const total = S.waterToday.reduce((s, e) => s + e.amount, 0);
    const pct   = Math.min(total / S.waterGoal, 1);
    const fill  = document.getElementById('ring-fill');
    fill.style.strokeDashoffset = CIRC * (1 - pct);
    fill.style.stroke = pct >= 1 ? '#f72585' : '#06d6a0';

    document.getElementById('ring-ml').textContent  = total >= 1000
        ? (total / 1000).toFixed(1) + 'L'
        : total;
    document.getElementById('ring-unit').textContent = total >= 1000 ? '' : 'ml';
    document.getElementById('ring-pct').textContent  = Math.round(pct * 100) + '%';
}

// ════════════════════════════════════════════════════
//  SLEEP RING
// ════════════════════════════════════════════════════
const SLEEP_GOAL_H = 8;

function updateSleepRing() {
    // Use most recent logged sleep
    const recent = S.sleepLogs[0]
        || Object.entries(monthSleep)
            .map(([date, v]) => ({ date, ...v }))
            .sort((a, b) => b.date.localeCompare(a.date))[0];

    const fill   = document.getElementById('sleep-ring-fill');
    const hoursEl = document.getElementById('sleep-ring-hours');
    const pctEl   = document.getElementById('sleep-ring-pct');

    if (!recent || !recent.duration) {
        fill.style.strokeDashoffset = CIRC;
        hoursEl.textContent = '—';
        pctEl.textContent   = '0%';
        return;
    }

    const hours = recent.duration;
    const pct   = Math.min(hours / SLEEP_GOAL_H, 1);
    fill.style.strokeDashoffset = CIRC * (1 - pct);
    fill.style.stroke = pct >= 1 ? '#06d6a0' : '#9d4edd';

    const h = Math.floor(hours), m = Math.round((hours - h) * 60);
    hoursEl.textContent = `${h}h${m ? ' ' + m + 'm' : ''}`;
    pctEl.textContent   = Math.round(pct * 100) + '%';
}

// ════════════════════════════════════════════════════
//  WATER
// ════════════════════════════════════════════════════
async function saveWater(entries) {
    localStorage.setItem('ping_w_' + S.today, JSON.stringify(entries));
    monthWater[S.today] = entries.reduce((s, e) => s + e.amount, 0);
    localStorage.setItem('ping_mw', JSON.stringify(monthWater));

    if (!AT_READY) return;
    syncDot('busy');
    try {
        const payload = { Date: S.today, Entries: JSON.stringify(entries) };
        const recId   = cachedId('w_' + S.today);
        if (recId) {
            await atUpdate('Water', recId, payload);
        } else {
            const rec = await atCreate('Water', payload);
            if (rec) cacheRec('w_' + S.today, rec.id);
        }
        syncDot('ok');
    } catch { syncDot('err'); }
}

async function addWater(ml) {
    const entry   = { id: Date.now().toString(), amount: +ml, time: hhmm(), ts: Date.now() };
    const entries = [...S.waterToday, entry];
    S.waterToday  = entries;
    renderWater(); updateRing(); renderWaterStats(); renderWaterChart();
    await saveWater(entries);
    toast('+' + ml + ' ml');
}

async function delWater(id) {
    const entries = S.waterToday.filter(e => e.id !== id);
    S.waterToday  = entries;
    renderWater(); updateRing(); renderWaterStats(); renderWaterChart();
    await saveWater(entries);
}

function renderWater() {
    const el = document.getElementById('water-log');
    if (!S.waterToday.length) { el.innerHTML = '<div class="empty-state">NO ENTRIES TODAY</div>'; return; }
    const sorted = [...S.waterToday].sort((a, b) => b.ts - a.ts);
    el.innerHTML = sorted.map(e => `
        <div class="log-item">
            <span class="log-time">${e.time}</span>
            <span class="log-amount">${e.amount} ml</span>
            <button class="log-del" data-id="${e.id}">✕</button>
        </div>`).join('');
}

document.getElementById('water-log').addEventListener('click', e => {
    const btn = e.target.closest('.log-del');
    if (btn) delWater(btn.dataset.id);
});

document.querySelectorAll('.add-btn').forEach(b => b.addEventListener('click', () => addWater(b.dataset.ml)));

document.getElementById('custom-add').addEventListener('click', () => {
    const v = parseInt(document.getElementById('custom-ml').value);
    if (!v || v < 1 || v > 5000) { toast('Enter 1–5000 ml', true); return; }
    addWater(v);
    document.getElementById('custom-ml').value = '';
});

document.getElementById('custom-ml').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('custom-add').click();
});

// ── Water stats ───────────────────────────────────────────────────────────────
function renderWaterStats() {
    const todayTotal = S.waterToday.reduce((s, e) => s + e.amount, 0);

    let streak = 0;
    const ref = new Date();
    for (let i = 0; i < 366; i++) {
        const key = ref.toISOString().slice(0, 10);
        const ml  = key === S.today ? todayTotal : (monthWater[key] || 0);
        if (ml >= S.waterGoal) streak++;
        else break;
        ref.setDate(ref.getDate() - 1);
    }
    document.getElementById('stat-water-streak').textContent = streak + (streak === 1 ? ' day' : ' days');

    const days = daysInMonth(viewWY, viewWM);
    let met = 0;
    for (let d = 1; d <= days; d++) {
        const key = `${viewWY}-${pad2(viewWM)}-${pad2(d)}`;
        const ml  = key === S.today ? todayTotal : (monthWater[key] || 0);
        if (ml >= S.waterGoal) met++;
    }
    document.getElementById('stat-water-month').textContent = met + (met === 1 ? ' day' : ' days');
}

// ── Water chart ───────────────────────────────────────────────────────────────
function renderWaterChart() {
    const canvas = document.getElementById('waterChart');
    if (!canvas) return;
    const dpr  = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;

    canvas.width  = rect.width  * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    ctx.clearRect(0, 0, W, H);

    const label = new Date(viewWY, viewWM - 1, 1)
        .toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();
    document.getElementById('water-month-label').textContent = label;

    const days       = daysInMonth(viewWY, viewWM);
    const todayTotal = S.waterToday.reduce((s, e) => s + e.amount, 0);
    const vals       = [];
    for (let d = 1; d <= days; d++) {
        const key = `${viewWY}-${pad2(viewWM)}-${pad2(d)}`;
        vals.push(key === S.today ? todayTotal : (monthWater[key] || 0));
    }

    const MAX  = Math.max(S.waterGoal * 1.4, ...vals, 500);
    const pL = 30, pR = 6, pT = 12, pB = 22;
    const cW = W - pL - pR, cH = H - pT - pB;
    const slot = cW / days;
    const bW   = Math.max(slot * 0.72, 2);
    const FONT = `8px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;

    // Grid lines
    [0, S.waterGoal / 2, S.waterGoal].forEach(v => {
        const y = pT + cH - (v / MAX) * cH;
        ctx.strokeStyle = 'rgba(42,42,90,.5)'; ctx.setLineDash([3,3]); ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(W - pR, y); ctx.stroke();
        ctx.setLineDash([]);
        if (v > 0) {
            ctx.fillStyle = '#6666aa'; ctx.font = FONT; ctx.textAlign = 'right';
            ctx.fillText(v >= 1000 ? (v/1000).toFixed(1)+'L' : v, pL - 2, y + 3);
        }
    });

    // Goal line
    const goalY = pT + cH - (S.waterGoal / MAX) * cH;
    ctx.strokeStyle = 'rgba(157,78,221,.5)'; ctx.setLineDash([4,3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pL, goalY); ctx.lineTo(W - pR, goalY); ctx.stroke();
    ctx.setLineDash([]);

    const cy = NOW.getFullYear(), cm = NOW.getMonth() + 1, cd = NOW.getDate();

    vals.forEach((ml, i) => {
        const x       = pL + i * slot + (slot - bW) / 2;
        const bH      = (ml / MAX) * cH;
        const y       = pT + cH - bH;
        const met     = ml >= S.waterGoal;
        const isToday = viewWY === cy && viewWM === cm && (i + 1) === cd;

        if (ml > 0) {
            const grad = ctx.createLinearGradient(x, y, x, pT + cH);
            if (met) {
                grad.addColorStop(0, 'rgba(6,214,160,.9)');
                grad.addColorStop(1, 'rgba(6,214,160,.1)');
            } else {
                grad.addColorStop(0, 'rgba(157,78,221,.8)');
                grad.addColorStop(1, 'rgba(157,78,221,.08)');
            }
            ctx.fillStyle = grad; ctx.fillRect(x, y, bW, bH);
            ctx.fillStyle = met ? '#06d6a0' : '#9d4edd';
            ctx.fillRect(x, y, bW, 2);
        } else {
            ctx.fillStyle = 'rgba(28,28,62,.8)'; ctx.fillRect(x, pT + cH - 2, bW, 2);
        }

        if (isToday) {
            ctx.strokeStyle = 'rgba(240,240,255,.3)'; ctx.lineWidth = 1; ctx.setLineDash([]);
            ctx.strokeRect(x - 1, pT, bW + 2, cH);
        }

        if (i === 0 || (i + 1) % 5 === 0 || i === days - 1) {
            ctx.fillStyle = isToday ? '#c084fc' : '#6666aa';
            ctx.font = FONT; ctx.textAlign = 'center';
            ctx.fillText(i + 1, x + bW / 2, H - 5);
        }
    });
}

// ── Month navigation (water) ──────────────────────────────────────────────────
document.getElementById('water-prev').addEventListener('click', async () => {
    viewWM--; if (viewWM < 1) { viewWM = 12; viewWY--; }
    await loadMonthData(viewWY, viewWM);
    renderWaterStats(); renderWaterChart();
});

document.getElementById('water-next').addEventListener('click', async () => {
    if (viewWY >= NOW.getFullYear() && viewWM >= NOW.getMonth() + 1) return;
    viewWM++; if (viewWM > 12) { viewWM = 1; viewWY++; }
    await loadMonthData(viewWY, viewWM);
    renderWaterStats(); renderWaterChart();
});

// ════════════════════════════════════════════════════
//  SLEEP
// ════════════════════════════════════════════════════
let sleepQuality = 5;

document.querySelectorAll('.star').forEach(s => {
    s.addEventListener('click', () => {
        sleepQuality = +s.dataset.v;
        document.querySelectorAll('.star').forEach((x, i) => x.classList.toggle('active', i < sleepQuality));
    });
});

function calcSleep() {
    const [bh, bm] = document.getElementById('bedtime').value.split(':').map(Number);
    const [wh, wm] = document.getElementById('waketime').value.split(':').map(Number);
    let mins = (wh * 60 + wm) - (bh * 60 + bm);
    if (mins <= 0) mins += 1440;
    return { h: Math.floor(mins / 60), m: mins % 60, total: mins / 60 };
}

function refreshDur() {
    const d = calcSleep();
    document.getElementById('sleep-dur').textContent = `${d.h}h ${d.m}m`;
}

document.getElementById('bedtime').addEventListener('input',  refreshDur);
document.getElementById('waketime').addEventListener('input', refreshDur);

document.getElementById('log-sleep').addEventListener('click', async () => {
    const bed  = document.getElementById('bedtime').value;
    const wake = document.getElementById('waketime').value;
    if (!bed || !wake) { toast('Set both times', true); return; }
    const dur   = calcSleep();
    const key   = todayStr();
    const entry = { date: key, bedtime: bed, waketime: wake, duration: +dur.total.toFixed(2), quality: sleepQuality };

    monthSleep[key] = { duration: entry.duration, quality: sleepQuality, bedtime: bed, waketime: wake };
    localStorage.setItem('ping_ms', JSON.stringify(monthSleep));

    const idx = S.sleepLogs.findIndex(l => l.date === key);
    if (idx >= 0) S.sleepLogs[idx] = entry; else S.sleepLogs.unshift(entry);
    S.sleepLogs.sort((a, b) => b.date.localeCompare(a.date));
    localStorage.setItem('ping_sleep', JSON.stringify(S.sleepLogs));

    renderSleepLog(); updateSleepRing(); renderSleepStats(); renderSleepPixelGrid();

    if (AT_READY) {
        syncDot('busy');
        try {
            const fields = { Date: key, Bedtime: bed, Waketime: wake, Duration: entry.duration, Quality: sleepQuality };
            const recId  = cachedId('s_' + key);
            if (recId) {
                await atUpdate('Sleep', recId, fields);
            } else {
                const rec = await atCreate('Sleep', fields);
                if (rec) cacheRec('s_' + key, rec.id);
            }
            syncDot('ok');
        } catch { syncDot('err'); }
    }

    toast('Sleep logged!');
});

function renderSleepLog() {
    const el = document.getElementById('sleep-log');
    if (!S.sleepLogs.length) { el.innerHTML = '<div class="empty-state">NO SLEEP LOGGED</div>'; return; }
    el.innerHTML = S.sleepLogs.slice(0, 10).map(l => {
        const h = Math.floor(l.duration), m = Math.round((l.duration - h) * 60);
        const stars = '★'.repeat(l.quality) + '☆'.repeat(5 - l.quality);
        return `
            <div class="sleep-log-item">
                <div class="sleep-log-row">
                    <span class="sleep-log-date">${l.date}</span>
                    <span class="sleep-log-stars">${stars}</span>
                </div>
                <div class="sleep-log-detail">${l.bedtime} → ${l.waketime} &nbsp;|&nbsp; ${h}h ${m}m</div>
            </div>`;
    }).join('');
}

// ── Sleep stats ───────────────────────────────────────────────────────────────
function renderSleepStats() {
    const label = new Date(viewSY, viewSM - 1, 1)
        .toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();
    document.getElementById('sleep-month-label').textContent = label;

    // streak
    let streak = 0;
    const ref = new Date();
    for (let i = 0; i < 366; i++) {
        if (monthSleep[ref.toISOString().slice(0, 10)]) streak++;
        else break;
        ref.setDate(ref.getDate() - 1);
    }
    document.getElementById('stat-sleep-streak').textContent = streak + (streak === 1 ? ' day' : ' days');

    // avg quality for viewed month
    const days    = daysInMonth(viewSY, viewSM);
    const entries = [];
    for (let d = 1; d <= days; d++) {
        const key = `${viewSY}-${pad2(viewSM)}-${pad2(d)}`;
        if (monthSleep[key]) entries.push(monthSleep[key]);
    }
    const avgQ = entries.length
        ? entries.reduce((s, e) => s + (e.quality || 0), 0) / entries.length : 0;
    document.getElementById('stat-sleep-quality').textContent = avgQ ? avgQ.toFixed(1) + ' ★' : '—';
}

// ── Sleep pixel grid ──────────────────────────────────────────────────────────
const QUALITY_COLORS = ['#1c1c3e', '#4a1a6a', '#7b2fbe', '#9d4edd', '#c084fc', '#06d6a0'];

function renderSleepPixelGrid() {
    const label = new Date(viewSY, viewSM - 1, 1)
        .toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();
    document.getElementById('sleep-month-label').textContent = label;

    const grid  = document.getElementById('sleep-pixel-grid');
    const days  = daysInMonth(viewSY, viewSM);
    const first = new Date(viewSY, viewSM - 1, 1).getDay();

    let html = '';
    for (let i = 0; i < first; i++) {
        html += '<div class="pixel-cell" style="background:transparent;pointer-events:none"></div>';
    }
    for (let d = 1; d <= days; d++) {
        const key     = `${viewSY}-${pad2(viewSM)}-${pad2(d)}`;
        const entry   = monthSleep[key];
        const quality = entry ? Math.min(Math.max(Math.round(entry.quality), 1), 5) : 0;
        const color   = QUALITY_COLORS[quality];
        const isToday = key === S.today;
        const tip     = entry
            ? `${key}: ${entry.duration?.toFixed(1)}h · quality ${entry.quality}★`
            : key;
        html += `<div class="pixel-cell${isToday ? ' today-cell' : ''}" style="background:${color}" title="${tip}"></div>`;
    }
    grid.innerHTML = html;
}

// ── Month navigation (sleep) ──────────────────────────────────────────────────
document.getElementById('sleep-prev').addEventListener('click', async () => {
    viewSM--; if (viewSM < 1) { viewSM = 12; viewSY--; }
    await loadMonthData(viewSY, viewSM);
    renderSleepStats(); renderSleepPixelGrid();
});

document.getElementById('sleep-next').addEventListener('click', async () => {
    if (viewSY >= NOW.getFullYear() && viewSM >= NOW.getMonth() + 1) return;
    viewSM++; if (viewSM > 12) { viewSM = 1; viewSY++; }
    await loadMonthData(viewSY, viewSM);
    renderSleepStats(); renderSleepPixelGrid();
});

// ════════════════════════════════════════════════════
//  SETTINGS
// ════════════════════════════════════════════════════
document.getElementById('settings-btn').addEventListener('click', () =>
    document.getElementById('settings-overlay').classList.add('visible'));

document.getElementById('modal-close').addEventListener('click', () =>
    document.getElementById('settings-overlay').classList.remove('visible'));

document.getElementById('settings-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('settings-overlay'))
        document.getElementById('settings-overlay').classList.remove('visible');
});

document.getElementById('save-goal').addEventListener('click', async () => {
    const v = parseInt(document.getElementById('goal-input').value);
    if (!v || v < 500 || v > 10000) { toast('Enter 500–10000', true); return; }
    S.waterGoal = v;
    document.getElementById('goal-input').value  = v;
    document.getElementById('ring-goal').textContent = `/ ${v} ml`;
    updateRing(); renderWaterStats(); renderWaterChart();
    await saveSettings({ pinHash: S.pin, waterGoal: v });
    toast('Goal updated!');
});

document.getElementById('save-pin').addEventListener('click', async () => {
    const v = document.getElementById('new-pin').value;
    if (!/^\d{4}$/.test(v)) { toast('4 digits required', true); return; }
    await persistPIN(await sha256(v));
    document.getElementById('new-pin').value = '';
    toast('PIN updated!');
});

document.getElementById('clear-water').addEventListener('click', async () => {
    document.getElementById('settings-overlay').classList.remove('visible');
    const btn = document.getElementById('clear-water');
    if (!btn._confirm) {
        btn.textContent = 'TAP AGAIN TO CONFIRM';
        btn._confirm = true;
        setTimeout(() => { btn.textContent = "CLEAR TODAY'S WATER"; btn._confirm = false; }, 3000);
        return;
    }
    btn._confirm = false; btn.textContent = "CLEAR TODAY'S WATER";
    localStorage.removeItem('ping_w_' + S.today);
    delete monthWater[S.today];
    localStorage.setItem('ping_mw', JSON.stringify(monthWater));
    const recId = cachedId('w_' + S.today);
    if (recId && AT_READY) {
        try {
            await atDelete('Water', recId);
            delete REC['w_' + S.today];
            localStorage.setItem('ping_rec', JSON.stringify(REC));
        } catch {}
    }
    S.waterToday = [];
    renderWater(); updateRing(); renderWaterStats(); renderWaterChart();
    toast('Today cleared');
});

// ════════════════════════════════════════════════════
//  UTILS
// ════════════════════════════════════════════════════
function toast(msg, err = false) {
    const el = document.createElement('div');
    el.className = 'toast' + (err ? ' err' : '');
    el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), 2600);
}

window.addEventListener('resize', renderWaterChart);

// ════════════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════════════
bootPIN();
