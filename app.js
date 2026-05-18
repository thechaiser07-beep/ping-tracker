// ════════════════════════════════════════════════════
//  AIRTABLE CONFIG — paste your values here
// ════════════════════════════════════════════════════
const AT_TOKEN = 'patXq9n6nrQzhBWU6.cbbc392bbe38f2e5c733f8769bb4e114634396d16f0bbcbc6920c01b5a9fc385';
const AT_BASE  = 'appQ6ScbAbIclexoQ';
// ════════════════════════════════════════════════════

const AT_READY = AT_TOKEN !== 'YOUR_PERSONAL_ACCESS_TOKEN';
const AT_URL   = `https://api.airtable.com/v0/${AT_BASE}`;

// ── Airtable helpers ─────────────────────────────────────────────────────────
async function atReq(method, table, idOrQuery = '', body = null) {
    if (!AT_READY) throw new Error('Airtable not configured');
    const url  = `${AT_URL}/${encodeURIComponent(table)}${idOrQuery ? '/' + idOrQuery : ''}`;
    const opts = { method, headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res  = await fetch(url, opts);
    if (!res.ok) { const err = await res.json().catch(()=>{}); throw new Error(err?.error?.message || res.status); }
    return res.json();
}

async function atFind(table, date) {
    const q = `?filterByFormula=${encodeURIComponent(`{Date}="${date}"`)}`;
    const d = await atReq('GET', table, q);
    return d.records?.[0] || null;
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
function cachedId(key) { return REC[key] || null; }

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
const S = {
    pin: null,
    waterGoal:  2500,
    waterToday: [],
    sleepLogs:  [],
    today:      todayStr(),
};

function todayStr() { return new Date().toISOString().slice(0, 10); }
function hhmm()     { return new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:false }); }

// ════════════════════════════════════════════════════
//  LAUNCH
// ════════════════════════════════════════════════════
async function enterApp() {
    document.getElementById('pin-screen').style.display = 'none';
    document.getElementById('app').classList.add('visible');

    document.getElementById('app-date').textContent =
        new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'short', day:'numeric' }).toUpperCase();

    updateGoalDisplay();
    await loadWater();
    await loadSleep();
    drawChart();
}

// ════════════════════════════════════════════════════
//  TABS
// ════════════════════════════════════════════════════
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab + '-panel').classList.add('active');
        if (btn.dataset.tab === 'sleep') setTimeout(drawChart, 60);
    });
});

// ════════════════════════════════════════════════════
//  WATER
// ════════════════════════════════════════════════════
const CIRC = 2 * Math.PI * 82;

function updateRing() {
    const total = S.waterToday.reduce((s, e) => s + e.amount, 0);
    const pct   = Math.min(total / S.waterGoal, 1);
    const fill  = document.getElementById('ring-fill');
    fill.style.strokeDashoffset = CIRC * (1 - pct);
    const done = pct >= 1;
    fill.style.stroke = done ? '#f72585' : '#06d6a0';
    fill.style.filter = 'none';
    document.getElementById('ring-ml').style.color      = 'var(--text-bright)';
    document.getElementById('ring-ml').style.textShadow = 'none';
    document.getElementById('ring-ml').textContent  = total;
    document.getElementById('ring-pct').textContent = Math.round(pct * 100) + '%';
}

function updateGoalDisplay() {
    document.getElementById('goal-display').textContent = S.waterGoal;
    document.getElementById('goal-input').value         = S.waterGoal;
}

async function loadWater() {
    const local = JSON.parse(localStorage.getItem('ping_w_' + S.today) || '[]');

    if (AT_READY) {
        try {
            syncDot('busy');
            const recId = cachedId('w_' + S.today);
            let rec;
            if (recId) {
                try { rec = { id: recId, fields: (await atReq('GET', 'Water', recId)).fields }; }
                catch { rec = await atFind('Water', S.today); }
            } else {
                rec = await atFind('Water', S.today);
            }
            if (rec) {
                cacheRec('w_' + S.today, rec.id);
                S.waterToday = JSON.parse(rec.fields.Entries || '[]');
                localStorage.setItem('ping_w_' + S.today, JSON.stringify(S.waterToday));
            } else {
                S.waterToday = local;
            }
            syncDot('ok');
        } catch { syncDot('err'); S.waterToday = local; }
    } else {
        S.waterToday = local;
    }

    renderWater(); updateRing();
}

async function saveWater(entries) {
    localStorage.setItem('ping_w_' + S.today, JSON.stringify(entries));
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
    renderWater(); updateRing();
    await saveWater(entries);
    toast('+' + ml + ' ml');
}

async function delWater(id) {
    const entries = S.waterToday.filter(e => e.id !== id);
    S.waterToday  = entries;
    renderWater(); updateRing();
    await saveWater(entries);
}

function renderWater() {
    const el = document.getElementById('water-log');
    if (!S.waterToday.length) { el.innerHTML = '<div class="empty-state">NO ENTRIES TODAY</div>'; return; }
    const sorted = [...S.waterToday].sort((a,b) => b.ts - a.ts);
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

async function loadSleep() {
    const local = JSON.parse(localStorage.getItem('ping_sleep') || '[]');

    if (AT_READY) {
        try {
            syncDot('busy');
            const dates = Array.from({ length: 7 }, (_, i) => {
                const d = new Date(); d.setDate(d.getDate() - i);
                return d.toISOString().slice(0, 10);
            });
            const recs = await Promise.all(dates.map(dt => atFind('Sleep', dt).catch(() => null)));
            const logs = recs.filter(Boolean).map(r => {
                cacheRec('s_' + r.fields.Date, r.id);
                return { date: r.fields.Date, bedtime: r.fields.Bedtime, waketime: r.fields.Waketime, duration: r.fields.Duration, quality: r.fields.Quality };
            });
            S.sleepLogs = logs.sort((a,b) => b.date.localeCompare(a.date));
            localStorage.setItem('ping_sleep', JSON.stringify(S.sleepLogs));
            syncDot('ok');
        } catch { syncDot('err'); S.sleepLogs = local; }
    } else {
        S.sleepLogs = local;
    }

    renderSleep();
}

document.getElementById('log-sleep').addEventListener('click', async () => {
    const bed  = document.getElementById('bedtime').value;
    const wake = document.getElementById('waketime').value;
    if (!bed || !wake) { toast('Set both times', true); return; }
    const dur   = calcSleep();
    const key   = todayStr();
    const entry = { date: key, bedtime: bed, waketime: wake, duration: +dur.total.toFixed(2), quality: sleepQuality };

    const idx = S.sleepLogs.findIndex(l => l.date === key);
    if (idx >= 0) S.sleepLogs[idx] = entry; else S.sleepLogs.unshift(entry);
    S.sleepLogs.sort((a,b) => b.date.localeCompare(a.date));
    localStorage.setItem('ping_sleep', JSON.stringify(S.sleepLogs));
    renderSleep(); drawChart();

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

function renderSleep() {
    const el = document.getElementById('sleep-log');
    if (!S.sleepLogs.length) { el.innerHTML = '<div class="empty-state">NO SLEEP LOGGED</div>'; return; }
    el.innerHTML = S.sleepLogs.slice(0, 7).map(l => {
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

// ════════════════════════════════════════════════════
//  SLEEP CHART
// ════════════════════════════════════════════════════
function drawChart() {
    const canvas = document.getElementById('sleepChart');
    const dpr    = window.devicePixelRatio || 1;
    const rect   = canvas.getBoundingClientRect();
    canvas.width  = rect.width  * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    ctx.clearRect(0, 0, W, H);

    const days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(); d.setDate(d.getDate() - (6 - i));
        const key = d.toISOString().slice(0, 10);
        const log = S.sleepLogs.find(l => l.date === key);
        return { label: d.toLocaleDateString('en-US',{weekday:'short'}).slice(0,3).toUpperCase(), hours: log ? log.duration : 0 };
    });

    const pL = 28, pR = 8, pT = 14, pB = 28;
    const cW = W - pL - pR, cH = H - pT - pB, MAX = 10;
    const slot = cW / days.length, bW = slot * 0.55;

    [0,2,4,6,8].forEach(h => {
        const y = pT + cH - (h / MAX) * cH;
        ctx.strokeStyle = 'rgba(42,42,90,.6)'; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
        ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(W - pR, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#6666aa'; ctx.font = "8px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"; ctx.textAlign = 'right';
        ctx.fillText(h + 'h', pL - 4, y + 3);
    });

    const recY = pT + cH - (8 / MAX) * cH;
    ctx.strokeStyle = 'rgba(157,78,221,.25)'; ctx.setLineDash([5,4]);
    ctx.beginPath(); ctx.moveTo(pL, recY); ctx.lineTo(W - pR, recY); ctx.stroke();
    ctx.setLineDash([]);

    days.forEach((day, i) => {
        const x = pL + i * slot + (slot - bW) / 2;
        const bH = (day.hours / MAX) * cH;
        const y  = pT + cH - bH;

        if (day.hours > 0) {
            const grad = ctx.createLinearGradient(x, y, x, pT + cH);
            grad.addColorStop(0, 'rgba(157,78,221,.8)');
            grad.addColorStop(1, 'rgba(157,78,221,.1)');
            ctx.fillStyle = grad; ctx.fillRect(x, y, bW, bH);
            ctx.fillStyle = '#9d4edd'; ctx.fillRect(x, y, bW, 2);
            ctx.fillStyle = 'rgba(240,240,255,.6)'; ctx.font = "7px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"; ctx.textAlign = 'center';
            ctx.fillText(day.hours.toFixed(1) + 'h', x + bW / 2, y - 4);
        } else {
            ctx.fillStyle = 'rgba(28,28,62,.6)'; ctx.fillRect(x, pT + cH - 2, bW, 2);
        }

        ctx.fillStyle = '#6666aa'; ctx.font = "8px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"; ctx.textAlign = 'center';
        ctx.fillText(day.label, x + bW / 2, H - 8);
    });
}

window.addEventListener('resize', () => {
    if (document.getElementById('sleep-panel').classList.contains('active')) drawChart();
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
    updateGoalDisplay(); updateRing();
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
    btn._confirm = false;
    btn.textContent = "CLEAR TODAY'S WATER";
    localStorage.removeItem('ping_w_' + S.today);
    const recId = cachedId('w_' + S.today);
    if (recId && AT_READY) {
        try { await atDelete('Water', recId); delete REC['w_' + S.today]; localStorage.setItem('ping_rec', JSON.stringify(REC)); }
        catch {}
    }
    S.waterToday = []; renderWater(); updateRing();
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

// ════════════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════════════
bootPIN();
