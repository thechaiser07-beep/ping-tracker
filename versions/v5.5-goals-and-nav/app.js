// ════════════════════════════════════════════════════
//  AIRTABLE CONFIG  (stored in localStorage, not in code)
// ════════════════════════════════════════════════════
let AT_TOKEN = localStorage.getItem('ping_at_token') || '';
let AT_BASE  = localStorage.getItem('ping_at_base')  || '';
const AT_READY = () => !!(AT_TOKEN && AT_BASE);
const AT_URL   = () => `https://api.airtable.com/v0/${AT_BASE}`;

// ── Airtable helpers ──────────────────────────────────────────────────────────
async function atReq(method, table, idOrQuery = '', body = null) {
    if (!AT_READY()) throw new Error('Airtable not configured');
    const url  = `${AT_URL()}/${encodeURIComponent(table)}${idOrQuery ? '/' + idOrQuery : ''}`;
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

    if (!saved && AT_READY()) {
        try {
            syncDot('busy');
            const rec = await atFindSetting('config');
            if (rec?.fields?.Value) {
                const cfg = JSON.parse(rec.fields.Value);
                if (cfg.pinHash) { saved = cfg.pinHash; localStorage.setItem('ping_pin', saved); }
                if (cfg.bSize)   S.bSize  = cfg.bSize;
                if (cfg.wGoal)   S.wGoal  = cfg.wGoal;
                if (rec.id)      cacheRec('settings', rec.id);
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
    await saveSettings({ pinHash: hash, bSize: S.bSize, wGoal: S.wGoal });
}

async function saveSettings(obj) {
    if (!AT_READY()) return;
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
    bSize:      parseInt(localStorage.getItem('ping_bsize')    || '500'), // ml per bottle
    wGoal:      parseInt(localStorage.getItem('ping_wgoal')    || '4'),   // goal in bottles
    sGoal:      parseFloat(localStorage.getItem('ping_sgoal')  || '8'),   // sleep goal in hours
    caffGoal:   parseInt(localStorage.getItem('ping_caffgoal') || '400'), // caffeine limit in mg
    waterToday: [],
    sleepLogs:  [],
    today:      todayStr(),
};

let viewWY = NOW.getFullYear(), viewWM = NOW.getMonth() + 1;
let viewSY = NOW.getFullYear(), viewSM = NOW.getMonth() + 1;
let waterGoalMet    = false; // tracks previous full state for celebration
let reminderTimer   = null;

// Custom quick-add bottle values (bottles, not ml)
const QUICK_DEFAULTS = [0.5, 1, 1.5, 2];
let quickVals = JSON.parse(localStorage.getItem('ping_quick') || 'null') || [...QUICK_DEFAULTS];

// date → total ml (water) / date → {duration, quality, ...} (sleep)
const monthWater  = JSON.parse(localStorage.getItem('ping_mw') || '{}');
const monthSleep  = JSON.parse(localStorage.getItem('ping_ms') || '{}');
const monthCaff   = JSON.parse(localStorage.getItem('ping_mc') || '{}');
const loadedMonths = new Set(JSON.parse(localStorage.getItem('ping_lm') || '[]'));

const CIRC = 2 * Math.PI * 82;

function todayStr() { return new Date().toISOString().slice(0, 10); }
function hhmm()     { return new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12: true }); }
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

    // Set sleep date picker default to today
    document.getElementById('sleep-date').value = S.today;

    // Reset rings to empty so CSS transition animates in from zero
    const ringFill = document.getElementById('ring-fill');
    const sleepFill = document.getElementById('sleep-ring-fill');
    ringFill.style.transition = 'none';
    sleepFill.style.transition = 'none';
    ringFill.style.strokeDashoffset = CIRC;
    sleepFill.style.strokeDashoffset = CIRC;
    ringFill.getBoundingClientRect(); // force reflow
    ringFill.style.transition = '';
    sleepFill.style.transition = '';

    // Load today's water from localStorage instantly
    S.waterToday = JSON.parse(localStorage.getItem('ping_w_' + S.today) || '[]');
    monthWater[S.today] = todayMl();

    // Load sleep logs
    S.sleepLogs = JSON.parse(localStorage.getItem('ping_sleep') || '[]');

    applyBottleSettings();
    applySleepGoal();
    applyCaffGoal();
    renderQuickAdd();
    renderCaff();
    renderWater();
    updateRing();
    renderWaterStats();
    renderSleepLog();
    updateSleepRing();
    renderSleepStats();

    requestAnimationFrame(renderWaterChart);
    requestAnimationFrame(renderSleepChart);

    // Fetch current month from Airtable
    await loadMonthData(viewWY, viewWM);

    renderWater();
    updateRing();
    renderWaterStats();
    renderWaterChart();
    updateSleepRing();
    renderSleepStats();
    renderSleepChart();

    renderDashboard();

    // Rebuild sleep log from fetched monthSleep
    const logs = Object.entries(monthSleep)
        .map(([date, v]) => ({ date, ...v }))
        .sort((a, b) => b.date.localeCompare(a.date));
    if (logs.length) {
        S.sleepLogs = logs;
        localStorage.setItem('ping_sleep', JSON.stringify(S.sleepLogs));
        renderSleepLog();
        updateSleepRing();
        renderSleepChart();
    }
}

// ════════════════════════════════════════════════════
//  MONTHLY DATA LOADING
// ════════════════════════════════════════════════════
async function loadMonthData(y, m) {
    const mk             = monthKey(y, m);
    const isCurrentMonth = (y === NOW.getFullYear() && m === NOW.getMonth() + 1);

    if (loadedMonths.has(mk) && !isCurrentMonth) return;
    if (!AT_READY()) return;

    const start   = `${y}-${pad2(m)}-01`;
    const end     = `${y}-${pad2(m)}-${pad2(daysInMonth(y, m))}`;
    const formula = encodeURIComponent(`AND({Date}>="${start}",{Date}<="${end}")`);

    try {
        syncDot('busy');
        const [wData, sData, cData] = await Promise.all([
            atReq('GET', 'Water',    `?filterByFormula=${formula}`).catch(() => ({ records: [] })),
            atReq('GET', 'Sleep',    `?filterByFormula=${formula}`).catch(() => ({ records: [] })),
            atReq('GET', 'Caffeine', `?filterByFormula=${formula}`).catch(() => ({ records: [] }))
        ]);

        for (const rec of wData.records) {
            const dt      = rec.fields.Date;
            const entries = JSON.parse(rec.fields.Entries || '[]');
            // support both {ml} and legacy {amount}
            monthWater[dt] = entries.reduce((s, e) => s + (e.ml ?? e.amount ?? 0), 0);
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
                notes:    rec.fields.Notes || '',
                type:     rec.fields.Type || 'night',
            };
            cacheRec('s_' + dt, rec.id);
        }

        for (const rec of cData.records) {
            const dt      = rec.fields.Date;
            const entries = JSON.parse(rec.fields.Entries || '[]');
            monthCaff[dt] = { total: rec.fields.Total || 0, entries };
            cacheRec('c_' + dt, rec.id);
            if (dt === S.today) localStorage.setItem('ping_caff_' + dt, JSON.stringify(entries));
        }

        loadedMonths.add(mk);
        localStorage.setItem('ping_mw', JSON.stringify(monthWater));
        localStorage.setItem('ping_ms', JSON.stringify(monthSleep));
        localStorage.setItem('ping_mc', JSON.stringify(monthCaff));
        localStorage.setItem('ping_lm', JSON.stringify([...loadedMonths]));
        syncDot('ok');
    } catch { syncDot('err'); }
}

// ════════════════════════════════════════════════════
//  CORRELATION
// ════════════════════════════════════════════════════
function calcCorrelation() {
    const goalMl  = S.wGoal * S.bSize;
    const goalQ   = [];   // sleep quality on days water goal was met
    const noGoalQ = [];   // sleep quality on days water goal was missed (but water tracked)

    for (const [date, wml] of Object.entries(monthWater)) {
        if (!wml || wml <= 0) continue;
        const sl = monthSleep[date];
        if (!sl || sl.type === 'nap' || !sl.quality) continue;
        if (wml >= goalMl) goalQ.push(sl.quality);
        else               noGoalQ.push(sl.quality);
    }

    const MIN = 3; // need at least 3 days in each bucket to be meaningful
    if (goalQ.length < MIN || noGoalQ.length < MIN) return null;

    const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    return {
        goalAvgQ:   avg(goalQ),
        noGoalAvgQ: avg(noGoalQ),
        goalDays:   goalQ.length,
        noGoalDays: noGoalQ.length,
    };
}

// ════════════════════════════════════════════════════
//  DASHBOARD
// ════════════════════════════════════════════════════
function renderDashboard() {
    // Date header
    document.getElementById('dash-date').textContent =
        new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'short', day:'numeric' }).toUpperCase();

    // Water mini ring
    const bottles = todayBottles();
    const wPct    = Math.min(bottles / S.wGoal, 1);
    const dwFill  = document.getElementById('dash-water-fill');
    dwFill.style.strokeDashoffset = CIRC * (1 - wPct);
    dwFill.style.stroke = wPct >= 1 ? '#f72585' : '#06d6a0';
    document.getElementById('dash-water-ml').textContent  = bottles.toFixed(1);
    document.getElementById('dash-water-pct').textContent = Math.round(wPct * 100) + '%';

    // Sleep mini ring
    const recentSleep = S.sleepLogs.find(l => l.type !== 'nap');
    const dsFill = document.getElementById('dash-sleep-fill');
    if (recentSleep?.duration) {
        const sPct = Math.min(recentSleep.duration / S.sGoal, 1);
        dsFill.style.strokeDashoffset = CIRC * (1 - sPct);
        dsFill.style.stroke = sPct >= 1 ? '#06d6a0' : '#9d4edd';
        const h = Math.floor(recentSleep.duration), m = Math.round((recentSleep.duration - h) * 60);
        document.getElementById('dash-sleep-hours').textContent = `${h}h${m ? ' '+m+'m' : ''}`;
        document.getElementById('dash-sleep-pct').textContent   = Math.round(sPct * 100) + '%';
    } else {
        dsFill.style.strokeDashoffset = CIRC;
        document.getElementById('dash-sleep-hours').textContent = '—';
        document.getElementById('dash-sleep-pct').textContent   = '0%';
    }

    // Quick-add buttons (mirror from main water page)
    const dq = document.getElementById('dash-quick-add');
    dq.innerHTML = quickVals.map(b => {
        const ml = Math.round(b * S.bSize);
        return `<button class="dash-add-btn" data-b="${b}">
            <span>+${b}</span>
            <small>${ml >= 1000 ? (ml/1000).toFixed(1)+'L' : ml+'ml'}</small>
        </button>`;
    }).join('');
    dq.querySelectorAll('.dash-add-btn').forEach(btn =>
        btn.addEventListener('click', () => addWater(parseFloat(btn.dataset.b)))
    );

    // Stats strip
    const goalMl = S.wGoal * S.bSize;
    let wStreak = 0;
    const wr = new Date();
    for (let i = 0; i < 366; i++) {
        const key = wr.toISOString().slice(0, 10);
        const ml  = key === S.today ? todayMl() : (monthWater[key] || 0);
        if (ml >= goalMl) wStreak++; else break;
        wr.setDate(wr.getDate() - 1);
    }
    let sStreak = 0;
    const sr = new Date();
    for (let i = 0; i < 366; i++) {
        const e = monthSleep[sr.toISOString().slice(0, 10)];
        if (e && e.type !== 'nap') sStreak++; else break;
        sr.setDate(sr.getDate() - 1);
    }
    const debt  = calcSleepDebt7();
    const score = recentSleep ? calcSleepScore(recentSleep) : null;
    const caffToday = getCaffToday();

    document.getElementById('ds-wstreak').textContent = wStreak + 'd';
    document.getElementById('ds-sstreak').textContent = sStreak + 'd';
    document.getElementById('ds-debt').textContent    = debt > 0 ? debt.toFixed(1) + 'h' : '0h';
    document.getElementById('ds-score').textContent   = score !== null ? score + '/100' : '—';
    document.getElementById('ds-caff').textContent    = caffToday + 'mg';

    // Insight card — water/sleep correlation
    const corr       = calcCorrelation();
    const insightCard = document.getElementById('insight-card');
    if (corr) {
        const diff = corr.goalAvgQ - corr.noGoalAvgQ;
        let text, sub;
        if (Math.abs(diff) < 0.15) {
            text = `Your sleep quality averages ${corr.goalAvgQ.toFixed(1)}/5 on hydrated days — and ${corr.noGoalAvgQ.toFixed(1)}/5 on others.`;
            sub  = 'Your habits are very consistent — great discipline!';
        } else if (diff > 0) {
            text = `On days you hit your water goal, your sleep quality averages ${corr.goalAvgQ.toFixed(1)}/5 — vs ${corr.noGoalAvgQ.toFixed(1)}/5 on other days.`;
            sub  = `That's ${diff.toFixed(1)} point${diff >= 1.5 ? 's' : ''} better when you stay hydrated 💪`;
        } else {
            text = `Sleep quality is ${corr.goalAvgQ.toFixed(1)}/5 on hydrated days vs ${corr.noGoalAvgQ.toFixed(1)}/5 on non-goal days.`;
            sub  = 'Keep logging — more data will reveal stronger patterns.';
        }
        document.getElementById('insight-text').textContent = text;
        document.getElementById('insight-sub').textContent  = sub;
        insightCard.style.display = '';
    } else {
        insightCard.style.display = 'none';
    }

    // Recent activity
    renderRecentActivity();
}

function renderRecentActivity() {
    const el   = document.getElementById('recent-list');
    const items = [];

    // Last 3 water entries today (newest first)
    const sorted = [...S.waterToday].sort((a, b) => b.ts - a.ts).slice(0, 3);
    for (const e of sorted) {
        const ml = e.ml ?? e.amount ?? 0;
        items.push({ icon: '💧', text: `${e.bottles?.toFixed(1) ?? (ml/S.bSize).toFixed(1)} bottle${e.bottles !== 1 ? 's' : ''} (${ml}ml)`, meta: e.time, ts: e.ts });
    }

    // Last sleep entry
    const lastSleep = S.sleepLogs[0];
    if (lastSleep) {
        const h = Math.floor(lastSleep.duration), m = Math.round((lastSleep.duration - h) * 60);
        items.push({ icon: '🌙', text: `${lastSleep.bedtime} → ${lastSleep.waketime}  ·  ${h}h${m ? ' '+m+'m' : ''}`, meta: lastSleep.date, ts: 0 });
    }

    if (!items.length) {
        el.innerHTML = '<div class="empty-state"><span class="empty-label">Nothing logged yet today</span></div>';
        return;
    }

    el.innerHTML = items.map(i => `
        <div class="recent-item">
            <span class="recent-icon">${i.icon}</span>
            <span class="recent-text">${i.text}</span>
            <span class="recent-meta">${i.meta}</span>
        </div>`).join('');
}

// ════════════════════════════════════════════════════
//  SIDEBAR NAVIGATION
// ════════════════════════════════════════════════════
function closeMobileSidebar() {
    document.querySelector('.sidebar').classList.remove('mobile-open');
    document.getElementById('sidebar-backdrop').classList.remove('visible');
}

document.getElementById('menu-toggle').addEventListener('click', () => {
    document.querySelector('.sidebar').classList.toggle('mobile-open');
    document.getElementById('sidebar-backdrop').classList.toggle('visible');
});

document.getElementById('sidebar-backdrop').addEventListener('click', closeMobileSidebar);

document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn[data-tab]').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab + '-page').classList.add('active');
        if (btn.dataset.tab === 'dashboard') renderDashboard();
        if (btn.dataset.tab === 'water') requestAnimationFrame(renderWaterChart);
        if (btn.dataset.tab === 'sleep') requestAnimationFrame(renderSleepChart);
        closeMobileSidebar();
    });
});

// ════════════════════════════════════════════════════
//  BOTTLE / GOAL SETTINGS
// ════════════════════════════════════════════════════
function applySleepGoal() {
    localStorage.setItem('ping_sgoal', S.sGoal);
    document.querySelectorAll('#sgoal-presets .preset-btn').forEach(btn =>
        btn.classList.toggle('active', parseFloat(btn.dataset.sgoal) === S.sGoal));
    const goalEl = document.querySelector('#sleep-page .ring-goal');
    if (goalEl) goalEl.textContent = `/ ${S.sGoal}h goal`;
}

function applyCaffGoal() {
    localStorage.setItem('ping_caffgoal', S.caffGoal);
    document.querySelectorAll('#caffgoal-presets .preset-btn').forEach(btn =>
        btn.classList.toggle('active', parseInt(btn.dataset.caffgoal) === S.caffGoal));
}

document.querySelectorAll('#sgoal-presets .preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        S.sGoal = parseFloat(btn.dataset.sgoal);
        applySleepGoal();
        updateSleepRing();
        renderSleepStats();
        renderSleepChart();
        renderDashboard();
        toast(`Sleep goal: ${S.sGoal}h`);
    });
});

document.querySelectorAll('#caffgoal-presets .preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        S.caffGoal = parseInt(btn.dataset.caffgoal);
        applyCaffGoal();
        renderCaff();
        renderDashboard();
        toast(`Caffeine limit: ${S.caffGoal}mg`);
    });
});

function applyBottleSettings() {
    localStorage.setItem('ping_bsize', S.bSize);
    localStorage.setItem('ping_wgoal', S.wGoal);

    // Rebuild dynamic quick-add buttons (updates ml labels automatically)
    renderQuickAdd();

    // Update ring goal text
    document.getElementById('ring-goal').textContent = `/ ${S.wGoal} bottles`;

    // Highlight active presets in settings
    document.querySelectorAll('#bsize-presets .preset-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.bsize) === S.bSize);
    });
    document.querySelectorAll('#wgoal-presets .preset-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.wgoal) === S.wGoal);
    });
}

document.querySelectorAll('#bsize-presets .preset-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
        S.bSize = parseInt(btn.dataset.bsize);
        applyBottleSettings();
        updateRing();
        renderWaterStats();
        renderWaterChart();
        await saveSettings({ pinHash: S.pin, bSize: S.bSize, wGoal: S.wGoal });
        toast(`Bottle size: ${S.bSize}ml`);
    });
});

document.querySelectorAll('#wgoal-presets .preset-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
        S.wGoal = parseInt(btn.dataset.wgoal);
        applyBottleSettings();
        updateRing();
        renderWaterStats();
        renderWaterChart();
        await saveSettings({ pinHash: S.pin, bSize: S.bSize, wGoal: S.wGoal });
        toast(`Goal: ${S.wGoal} bottles`);
    });
});

// ════════════════════════════════════════════════════
//  WATER RING
// ════════════════════════════════════════════════════
function todayMl() {
    return S.waterToday.reduce((s, e) => s + (e.ml ?? e.amount ?? 0), 0);
}

function todayBottles() {
    return S.bSize > 0 ? todayMl() / S.bSize : 0;
}

function updateRing() {
    const bottles = todayBottles();
    const pct     = Math.min(bottles / S.wGoal, 1);
    const fill    = document.getElementById('ring-fill');
    fill.style.strokeDashoffset = CIRC * (1 - pct);
    fill.style.stroke = pct >= 1 ? '#f72585' : '#06d6a0';

    document.getElementById('ring-ml').textContent   = bottles.toFixed(1);
    document.getElementById('ring-unit').textContent  = 'bottles';
    document.getElementById('ring-pct').textContent   = Math.round(pct * 100) + '%';

    const isFull = pct >= 1;
    if (isFull && !waterGoalMet) celebrateWaterGoal();
    waterGoalMet = isFull;
}

function celebrateWaterGoal() {
    // Pulse the ring
    const wrapper = document.querySelector('#water-page .ring-wrapper');
    wrapper.classList.remove('celebrate');
    void wrapper.offsetWidth;
    wrapper.classList.add('celebrate');

    // Confetti burst from ring center
    const rect   = wrapper.getBoundingClientRect();
    const cx     = rect.left + rect.width  / 2;
    const cy     = rect.top  + rect.height / 2;
    const colors = ['#06d6a0', '#9d4edd', '#f72585', '#ffbe0b', '#c084fc', '#06d6a0'];
    for (let i = 0; i < 22; i++) {
        const el = document.createElement('div');
        el.className = 'confetti-piece';
        const size = 4 + Math.random() * 6;
        el.style.cssText = `
            left:${cx + (Math.random() - 0.5) * 120}px;
            top:${cy + (Math.random() - 0.5) * 40}px;
            width:${size}px; height:${size}px;
            background:${colors[i % colors.length]};
            border-radius:${Math.random() > .5 ? '50%' : '2px'};
            animation-delay:${(Math.random() * .35).toFixed(2)}s;
            animation-duration:${(.9 + Math.random() * .7).toFixed(2)}s;
        `;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 1800);
    }
}

// ════════════════════════════════════════════════════
//  SLEEP RING
// ════════════════════════════════════════════════════
function updateSleepRing() {
    const recent = S.sleepLogs.find(l => l.type !== 'nap')
        || Object.entries(monthSleep)
            .filter(([, v]) => v.type !== 'nap')
            .map(([date, v]) => ({ date, ...v }))
            .sort((a, b) => b.date.localeCompare(a.date))[0];

    const fill    = document.getElementById('sleep-ring-fill');
    const hoursEl = document.getElementById('sleep-ring-hours');
    const pctEl   = document.getElementById('sleep-ring-pct');

    if (!recent?.duration) {
        fill.style.strokeDashoffset = CIRC;
        hoursEl.textContent = '—';
        pctEl.textContent   = '0%';
        return;
    }

    const hours = recent.duration;
    const pct   = Math.min(hours / S.sGoal, 1);
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
    const total = entries.reduce((s, e) => s + (e.ml ?? e.amount ?? 0), 0);
    monthWater[S.today] = total;
    localStorage.setItem('ping_mw', JSON.stringify(monthWater));

    if (!AT_READY()) return;
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

// Add water by bottle count
async function addWater(bottles) {
    const ml    = Math.round(bottles * S.bSize);
    const entry = { id: Date.now().toString(), ml, bottles, time: hhmm(), ts: Date.now() };
    const entries = [...S.waterToday, entry];
    S.waterToday = entries;
    refreshWaterUI();
    await saveWater(entries);
    toast(`+${bottles} bottle${bottles !== 1 ? 's' : ''} (${ml}ml)`);
}

// Add water by ml (custom input)
async function addWaterMl(ml) {
    const bottles = S.bSize > 0 ? +(ml / S.bSize).toFixed(2) : 0;
    const entry   = { id: Date.now().toString(), ml, bottles, time: hhmm(), ts: Date.now() };
    const entries = [...S.waterToday, entry];
    S.waterToday  = entries;
    refreshWaterUI();
    await saveWater(entries);
    toast(`+${ml}ml`);
}

// Remove the most recent today entry
async function undoLastWater() {
    if (!S.waterToday.length) return;
    const sorted  = [...S.waterToday].sort((a, b) => b.ts - a.ts);
    const entries = S.waterToday.filter(e => e.id !== sorted[0].id);
    S.waterToday  = entries;
    refreshWaterUI();
    await saveWater(entries);
    toast('Last entry removed');
}

async function deleteWater(id) {
    const entries = S.waterToday.filter(e => e.id !== id);
    S.waterToday  = entries;
    refreshWaterUI();
    await saveWater(entries);
}

// ════════════════════════════════════════════════════
//  CAFFEINE TRACKER
// ════════════════════════════════════════════════════
function getCaffToday() {
    const entries = JSON.parse(localStorage.getItem('ping_caff_' + S.today) || '[]');
    return entries.reduce((s, e) => s + (e.mg || 0), 0);
}

async function logCaff(mg, name) {
    const entries = JSON.parse(localStorage.getItem('ping_caff_' + S.today) || '[]');
    entries.push({ id: Date.now().toString(), mg, name, time: hhmm(), ts: Date.now() });
    localStorage.setItem('ping_caff_' + S.today, JSON.stringify(entries));
    renderCaff();
    renderDashboard();
    toast(`+${mg}mg caffeine`);
    await saveCaff(S.today);
}

async function saveCaff(date) {
    const entries = JSON.parse(localStorage.getItem('ping_caff_' + date) || '[]');
    const total   = entries.reduce((s, e) => s + (e.mg || 0), 0);
    monthCaff[date] = { total, entries };
    localStorage.setItem('ping_mc', JSON.stringify(monthCaff));
    if (!AT_READY()) return;
    syncDot('busy');
    try {
        const payload = { Date: date, Total: total, Entries: JSON.stringify(entries) };
        const recId   = cachedId('c_' + date);
        if (recId) {
            await atUpdate('Caffeine', recId, payload);
        } else {
            const rec = await atCreate('Caffeine', payload);
            if (rec) cacheRec('c_' + date, rec.id);
        }
        syncDot('ok');
    } catch { syncDot('err'); }
}

function renderCaff() {
    const entries = JSON.parse(localStorage.getItem('ping_caff_' + S.today) || '[]');
    const total   = entries.reduce((s, e) => s + (e.mg || 0), 0);
    document.getElementById('caff-total').textContent = total + 'mg';

    // Goal progress bar + label
    const gl  = document.getElementById('caff-goal-label');
    const bar = document.getElementById('caff-progress-fill');
    if (S.caffGoal > 0) {
        gl.textContent      = `/ ${S.caffGoal}mg limit`;
        const pct           = Math.min(total / S.caffGoal, 1);
        const over          = total > S.caffGoal;
        const near          = !over && pct >= 0.8;
        bar.style.width     = (pct * 100) + '%';
        bar.style.background = over ? 'var(--pink)' : near ? '#f7a325' : 'var(--yellow)';
    } else {
        gl.textContent  = '';
        bar.style.width = '0';
    }

    // Over-limit warning
    document.getElementById('caff-limit-warning')
        .classList.toggle('visible', S.caffGoal > 0 && total > S.caffGoal);

    // Bedtime-cutoff warning (within 6h of target bedtime)
    const sched = getSchedule();
    let warn = false;
    if (sched.bed) {
        const [th, tm] = sched.bed.split(':').map(Number);
        let cutoff = th * 60 + tm - 360;
        if (cutoff < 0) cutoff += 1440;
        for (const e of entries) {
            const d = new Date(e.ts);
            const entryMins = d.getHours() * 60 + d.getMinutes();
            if (entryMins >= cutoff) { warn = true; break; }
        }
    }
    document.getElementById('caff-warning').classList.toggle('visible', warn);

    const log = document.getElementById('caff-log');
    if (!entries.length) { log.innerHTML = ''; return; }
    log.innerHTML = [...entries].reverse().map(e => `
        <div class="caff-item">
            <span class="caff-item-name">${e.name}</span>
            <span class="caff-item-mg">${e.mg}mg</span>
            <span class="caff-item-time">${e.time}</span>
        </div>`).join('');
}

document.querySelectorAll('.caff-btn[data-mg]').forEach(btn =>
    btn.addEventListener('click', () => logCaff(parseInt(btn.dataset.mg), btn.dataset.name))
);

document.getElementById('caff-custom-add').addEventListener('click', () => {
    const v = parseInt(document.getElementById('caff-custom-mg').value);
    if (!v || v < 1 || v > 1000) { toast('Enter 1–1000 mg', true); return; }
    logCaff(v, 'Custom');
    document.getElementById('caff-custom-mg').value = '';
});

function refreshWaterUI() {
    renderWater();
    updateRing();
    renderWaterStats();
    renderWaterChart();
    renderDashboard();
    document.getElementById('undo-water').disabled = S.waterToday.length === 0;
}

function renderWater() {
    const el = document.getElementById('water-log');
    if (!S.waterToday.length) {
        el.innerHTML = `<div class="empty-state">
            <svg class="empty-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#9d4edd" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2L5.5 13A7 7 0 1 0 18.5 13L12 2z"/>
            </svg>
            <span class="empty-label">No drinks logged yet</span>
            <span class="empty-hint">Tap a quick add button above</span>
        </div>`;
    } else {
        const sorted = [...S.waterToday].sort((a, b) => b.ts - a.ts);
        el.innerHTML = sorted.map(e => {
            const ml      = e.ml ?? e.amount ?? 0;
            const bottles = e.bottles ?? (S.bSize > 0 ? +(ml / S.bSize).toFixed(2) : 0);
            return `
            <div class="log-item">
                <span class="log-time">${e.time}</span>
                <span class="log-amount">${bottles.toFixed(1)} bottle${bottles !== 1 ? 's' : ''} <span style="color:var(--text-dim);font-size:11px">(${ml}ml)</span></span>
                <button class="log-del" data-id="${e.id}">✕</button>
            </div>`;
        }).join('');
    }
    document.getElementById('undo-water').disabled = S.waterToday.length === 0;
}

document.getElementById('water-log').addEventListener('click', e => {
    const btn = e.target.closest('.log-del');
    if (btn) deleteWater(btn.dataset.id);
});

document.getElementById('undo-water').addEventListener('click', undoLastWater);

// ── Dynamic quick-add buttons ─────────────────────────────────────────────────
function renderQuickAdd() {
    const grid = document.getElementById('quick-add-grid');
    grid.innerHTML = quickVals.map((bottles, i) => {
        const ml = Math.round(bottles * S.bSize);
        return `<button class="add-btn" data-bottles="${bottles}" data-qi="${i}">
            <span>+${bottles % 1 === 0 ? bottles : bottles}</span>
            <small class="add-ml">${ml >= 1000 ? (ml/1000).toFixed(1)+'L' : ml+'ml'}</small>
        </button>`;
    }).join('');
    grid.querySelectorAll('.add-btn').forEach(b =>
        b.addEventListener('click', () => addWater(parseFloat(b.dataset.bottles))));

    // Sync edit inputs
    quickVals.forEach((v, i) => {
        const inp = document.getElementById('qe' + i);
        if (inp) inp.value = v;
    });
}

// Custom quick-add edit toggle
document.getElementById('edit-quick-btn').addEventListener('click', () => {
    const panel = document.getElementById('quick-add-edit');
    const isOpen = panel.classList.toggle('visible');
    document.getElementById('edit-quick-btn').textContent = isOpen ? '✓ Done' : '✎ Customise Buttons';
    if (!isOpen) {
        // Save on close
        quickVals = [0,1,2,3].map(i => {
            const v = parseFloat(document.getElementById('qe'+i).value);
            return (!isNaN(v) && v > 0) ? v : QUICK_DEFAULTS[i];
        });
        localStorage.setItem('ping_quick', JSON.stringify(quickVals));
        renderQuickAdd();
        toast('Quick-add buttons updated');
    }
});

document.getElementById('custom-add').addEventListener('click', () => {
    const v = parseInt(document.getElementById('custom-ml').value);
    if (!v || v < 1 || v > 5000) { toast('Enter 1–5000 ml', true); return; }
    addWaterMl(v);
    document.getElementById('custom-ml').value = '';
});

document.getElementById('custom-ml').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('custom-add').click();
});

// ── Water stats ───────────────────────────────────────────────────────────────
function renderWaterStats() {
    const ml     = todayMl();
    const goalMl = S.wGoal * S.bSize;

    // Current streak
    let streak = 0;
    const ref = new Date();
    for (let i = 0; i < 366; i++) {
        const key   = ref.toISOString().slice(0, 10);
        const dayMl = key === S.today ? ml : (monthWater[key] || 0);
        if (dayMl >= goalMl) streak++;
        else break;
        ref.setDate(ref.getDate() - 1);
    }
    document.getElementById('stat-water-streak').textContent = streak + (streak === 1 ? ' day' : ' days');

    // Best streak
    const prevBest = parseInt(localStorage.getItem('ping_wbest') || '0');
    const best     = Math.max(streak, prevBest);
    if (best > prevBest) localStorage.setItem('ping_wbest', best);
    document.getElementById('stat-water-best').textContent = best + (best === 1 ? ' day' : ' days');

    // Goal met this month
    const days = daysInMonth(viewWY, viewWM);
    let met = 0;
    for (let d = 1; d <= days; d++) {
        const key   = `${viewWY}-${pad2(viewWM)}-${pad2(d)}`;
        const dayMl = key === S.today ? ml : (monthWater[key] || 0);
        if (dayMl >= goalMl) met++;
    }
    document.getElementById('stat-water-month').textContent = met + (met === 1 ? ' day' : ' days');

    // Weekly summary
    renderWaterWeekly(goalMl);
}

function renderWaterWeekly(goalMl) {
    const todayMlVal = todayMl();
    let total = 0, bestDay = 0, metDays = 0;
    for (let i = 0; i < 7; i++) {
        const d   = new Date(); d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        const ml  = key === S.today ? todayMlVal : (monthWater[key] || 0);
        total  += ml;
        if (ml > bestDay) bestDay = ml;
        if (ml >= goalMl) metDays++;
    }
    const avg = total / 7;
    const fmt = v => v >= 1000 ? (v / 1000).toFixed(1) + 'L' : Math.round(v) + 'ml';
    document.getElementById('wk-water-avg').textContent      = fmt(avg);
    document.getElementById('wk-water-best-day').textContent = fmt(bestDay);
    document.getElementById('wk-water-days-met').textContent = metDays + ' / 7';
    document.getElementById('wk-water-total').textContent    = (total / 1000).toFixed(1);
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

    const days    = daysInMonth(viewWY, viewWM);
    const goalMl  = S.wGoal * S.bSize;
    const todayMlVal = todayMl();
    const vals    = [];
    for (let d = 1; d <= days; d++) {
        const key = `${viewWY}-${pad2(viewWM)}-${pad2(d)}`;
        vals.push(key === S.today ? todayMlVal : (monthWater[key] || 0));
    }

    const MAX  = Math.max(goalMl * 1.4, ...vals, 500);
    const pL = 30, pR = 6, pT = 12, pB = 22;
    const cW = W - pL - pR, cH = H - pT - pB;
    const slot = cW / days, bW = Math.max(slot * 0.72, 2);
    const FONT = `8px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;

    [0, goalMl / 2, goalMl].forEach(v => {
        const y = pT + cH - (v / MAX) * cH;
        ctx.strokeStyle = 'rgba(42,42,90,.5)'; ctx.setLineDash([3,3]); ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(W - pR, y); ctx.stroke();
        ctx.setLineDash([]);
        if (v > 0) {
            ctx.fillStyle = '#6666aa'; ctx.font = FONT; ctx.textAlign = 'right';
            ctx.fillText(v >= 1000 ? (v/1000).toFixed(1)+'L' : v, pL - 2, y + 3);
        }
    });

    const goalY = pT + cH - (goalMl / MAX) * cH;
    ctx.strokeStyle = 'rgba(157,78,221,.5)'; ctx.setLineDash([4,3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pL, goalY); ctx.lineTo(W - pR, goalY); ctx.stroke();
    ctx.setLineDash([]);

    const cy = NOW.getFullYear(), cm = NOW.getMonth() + 1, cd = NOW.getDate();

    // 7-day rolling average trend line
    const trendPts = vals.map((_, i) => {
        const slice = vals.slice(Math.max(0, i - 6), i + 1);
        return slice.reduce((a, b) => a + b, 0) / slice.length;
    });
    ctx.strokeStyle = 'rgba(247,37,133,.6)'; ctx.setLineDash([3,2]); ctx.lineWidth = 1.5;
    ctx.beginPath();
    trendPts.forEach((v, i) => {
        const x = pL + i * slot + slot / 2;
        const y = pT + cH - (v / MAX) * cH;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke(); ctx.setLineDash([]);

    vals.forEach((ml, i) => {
        const x       = pL + i * slot + (slot - bW) / 2;
        const bH      = (ml / MAX) * cH;
        const y       = pT + cH - bH;
        const met     = ml >= goalMl;
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
            ctx.fillStyle = met ? '#06d6a0' : '#9d4edd'; ctx.fillRect(x, y, bW, 2);
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

// ── Water heatmap (rolling 16 weeks) ─────────────────────────────────────────
function renderWaterHeatmap() {
    const canvas = document.getElementById('waterHeatmap');
    if (!canvas || !canvas.classList.contains('visible')) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    canvas.width  = rect.width  * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    ctx.clearRect(0, 0, W, H);

    const WEEKS = 16, COLS = WEEKS, ROWS = 7;
    const goalMl = S.wGoal * S.bSize;
    const pad = 2, cellW = (W - 24) / COLS, cellH = (H - 4) / ROWS;
    const days = ['S','M','T','W','T','F','S'];

    // Day labels
    ctx.fillStyle = '#6666aa';
    ctx.font = `7px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
    ctx.textAlign = 'right';
    for (let r = 0; r < ROWS; r++) {
        if (r % 2 === 1) ctx.fillText(days[r], 18, 4 + r * cellH + cellH * .65);
    }

    // Cells — walk backwards WEEKS*7 days from today
    const ref = new Date();
    ref.setDate(ref.getDate() - (WEEKS * 7 - 1));
    for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; r++) {
            const key   = ref.toISOString().slice(0, 10);
            const ml    = key === S.today ? todayMl() : (monthWater[key] || 0);
            const ratio = goalMl > 0 ? Math.min(ml / goalMl, 1) : 0;
            const x     = 22 + c * cellW + pad / 2;
            const y     = 2  + r * cellH + pad / 2;
            const w     = cellW - pad, h = cellH - pad;
            const alpha = ratio === 0 ? 0.08 : 0.15 + ratio * 0.85;
            ctx.fillStyle = ratio >= 1
                ? `rgba(6,214,160,${alpha})`
                : `rgba(157,78,221,${alpha})`;
            ctx.beginPath();
            ctx.roundRect(x, y, w, h, 2);
            ctx.fill();
            ref.setDate(ref.getDate() + 1);
        }
        // Reset inner row loop - ref already advanced by ROWS days
        ref.setDate(ref.getDate() - ROWS); // undo inner, will re-advance below
        ref.setDate(ref.getDate() + ROWS);
    }
    // Redo — walk day by day properly
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#6666aa';
    ctx.font = `7px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
    ctx.textAlign = 'right';
    for (let r = 0; r < ROWS; r++) {
        if (r % 2 === 1) ctx.fillText(days[r], 18, 4 + r * cellH + cellH * .65);
    }
    const start = new Date();
    start.setDate(start.getDate() - (COLS * ROWS - 1));
    for (let i = 0; i < COLS * ROWS; i++) {
        const d   = new Date(start); d.setDate(start.getDate() + i);
        const key = d.toISOString().slice(0, 10);
        const col = Math.floor(i / ROWS);
        const row = i % ROWS;
        const ml  = key === S.today ? todayMl() : (monthWater[key] || 0);
        const ratio = goalMl > 0 ? Math.min(ml / goalMl, 1) : 0;
        const x   = 22 + col * cellW + pad / 2;
        const y   = 2  + row * cellH + pad / 2;
        const w   = cellW - pad, h = cellH - pad;
        const isToday = key === S.today;
        const alpha = ratio === 0 ? 0.07 : 0.14 + ratio * 0.86;
        ctx.fillStyle = ratio >= 1
            ? `rgba(6,214,160,${alpha})`
            : ratio > 0
                ? `rgba(157,78,221,${alpha})`
                : 'rgba(42,42,90,0.4)';
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 2);
        ctx.fill();
        if (isToday) {
            ctx.strokeStyle = 'rgba(240,240,255,.5)';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.roundRect(x, y, w, h, 2); ctx.stroke();
        }
    }
}

// ── Sleep heatmap (rolling 16 weeks) ─────────────────────────────────────────
function renderSleepHeatmap() {
    const canvas = document.getElementById('sleepHeatmap');
    if (!canvas || !canvas.classList.contains('visible')) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    canvas.width  = rect.width  * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    ctx.clearRect(0, 0, W, H);

    const COLS = 16, ROWS = 7, GOAL = S.sGoal;
    const pad = 2, cellW = (W - 24) / COLS, cellH = (H - 4) / ROWS;
    const days = ['S','M','T','W','T','F','S'];

    ctx.fillStyle = '#6666aa';
    ctx.font = `7px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
    ctx.textAlign = 'right';
    for (let r = 0; r < ROWS; r++) {
        if (r % 2 === 1) ctx.fillText(days[r], 18, 4 + r * cellH + cellH * .65);
    }

    const start = new Date();
    start.setDate(start.getDate() - (COLS * ROWS - 1));
    for (let i = 0; i < COLS * ROWS; i++) {
        const d     = new Date(start); d.setDate(start.getDate() + i);
        const key   = d.toISOString().slice(0, 10);
        const entry = monthSleep[key];
        const dur   = entry?.duration || 0;
        const isNap = entry?.type === 'nap';
        const ratio = Math.min(dur / GOAL, 1);
        const col   = Math.floor(i / ROWS);
        const row   = i % ROWS;
        const x     = 22 + col * cellW + pad / 2;
        const y     = 2  + row * cellH + pad / 2;
        const w     = cellW - pad, h = cellH - pad;
        const isToday = key === S.today;
        const alpha = ratio === 0 ? 0.07 : 0.14 + ratio * 0.86;
        ctx.fillStyle = isNap
            ? `rgba(6,214,160,${alpha})`
            : ratio >= 1
                ? `rgba(192,132,252,${alpha})`
                : ratio > 0
                    ? `rgba(157,78,221,${alpha})`
                    : 'rgba(42,42,90,0.4)';
        ctx.beginPath(); ctx.roundRect(x, y, w, h, 2); ctx.fill();
        if (isToday) {
            ctx.strokeStyle = 'rgba(240,240,255,.5)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.roundRect(x, y, w, h, 2); ctx.stroke();
        }
    }
}

// ── Chart view toggles ────────────────────────────────────────────────────────
let waterView = 'bars', sleepView = 'bars';

document.getElementById('water-bars-btn').addEventListener('click', () => {
    waterView = 'bars';
    document.getElementById('water-bars-btn').classList.add('active');
    document.getElementById('water-heat-btn').classList.remove('active');
    document.getElementById('waterChart').style.display   = 'block';
    document.getElementById('waterHeatmap').classList.remove('visible');
    renderWaterChart();
});
document.getElementById('water-heat-btn').addEventListener('click', () => {
    waterView = 'heat';
    document.getElementById('water-heat-btn').classList.add('active');
    document.getElementById('water-bars-btn').classList.remove('active');
    document.getElementById('waterChart').style.display   = 'none';
    document.getElementById('waterHeatmap').classList.add('visible');
    requestAnimationFrame(renderWaterHeatmap);
});

document.getElementById('sleep-bars-btn').addEventListener('click', () => {
    sleepView = 'bars';
    document.getElementById('sleep-bars-btn').classList.add('active');
    document.getElementById('sleep-heat-btn').classList.remove('active');
    document.getElementById('sleepChart').style.display   = 'block';
    document.getElementById('sleepHeatmap').classList.remove('visible');
    renderSleepChart();
});
document.getElementById('sleep-heat-btn').addEventListener('click', () => {
    sleepView = 'heat';
    document.getElementById('sleep-heat-btn').classList.add('active');
    document.getElementById('sleep-bars-btn').classList.remove('active');
    document.getElementById('sleepChart').style.display   = 'none';
    document.getElementById('sleepHeatmap').classList.add('visible');
    requestAnimationFrame(renderSleepHeatmap);
});

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
let sleepType = 'night';

document.getElementById('sleep-type').addEventListener('change', e => {
    sleepType = e.target.value;
});

document.querySelectorAll('.q-dot').forEach(dot => {
    dot.addEventListener('click', () => {
        sleepQuality = +dot.dataset.v;
        document.querySelectorAll('.q-dot').forEach((d, i) => d.classList.toggle('active', i < sleepQuality));
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
    const bed   = document.getElementById('bedtime').value;
    const wake  = document.getElementById('waketime').value;
    const date  = document.getElementById('sleep-date').value || S.today;
    const notes = document.getElementById('sleep-notes').value.trim();

    if (!bed || !wake) { toast('Set both times', true); return; }

    const dur   = calcSleep();
    const entry = { date, bedtime: bed, waketime: wake, duration: +dur.total.toFixed(2), quality: sleepQuality, notes, type: sleepType };

    // Replace same-date entry if it exists
    monthSleep[date] = { duration: entry.duration, quality: sleepQuality, bedtime: bed, waketime: wake, notes, type: sleepType };
    localStorage.setItem('ping_ms', JSON.stringify(monthSleep));

    const idx = S.sleepLogs.findIndex(l => l.date === date);
    if (idx >= 0) S.sleepLogs[idx] = entry; else S.sleepLogs.unshift(entry);
    S.sleepLogs.sort((a, b) => b.date.localeCompare(a.date));
    localStorage.setItem('ping_sleep', JSON.stringify(S.sleepLogs));

    renderSleepLog();
    updateSleepRing();
    renderSleepStats();
    renderSleepChart();
    renderDashboard();

    if (AT_READY()) {
        syncDot('busy');
        try {
            const fields = { Date: date, Bedtime: bed, Waketime: wake, Duration: entry.duration, Quality: sleepQuality, Notes: notes, Type: sleepType };
            const recId  = cachedId('s_' + date);
            if (recId) {
                await atUpdate('Sleep', recId, fields);
            } else {
                const rec = await atCreate('Sleep', fields);
                if (rec) cacheRec('s_' + date, rec.id);
            }
            syncDot('ok');
        } catch { syncDot('err'); }
    }

    // Reset form
    document.getElementById('sleep-notes').value = '';
    document.getElementById('sleep-date').value  = S.today;
    sleepQuality = 5;
    sleepType    = 'night';
    document.getElementById('sleep-type').value = 'night';
    document.querySelectorAll('.q-dot').forEach((d, i) => d.classList.toggle('active', i < sleepQuality));
    toast('Sleep logged!');
});

async function deleteSleep(date) {
    S.sleepLogs = S.sleepLogs.filter(l => l.date !== date);
    delete monthSleep[date];
    localStorage.setItem('ping_sleep', JSON.stringify(S.sleepLogs));
    localStorage.setItem('ping_ms', JSON.stringify(monthSleep));

    renderSleepLog();
    updateSleepRing();
    renderSleepStats();
    renderSleepChart();

    const recId = cachedId('s_' + date);
    if (recId && AT_READY()) {
        try { await atDelete('Sleep', recId); delete REC['s_' + date]; localStorage.setItem('ping_rec', JSON.stringify(REC)); }
        catch {}
    }
}

function renderSleepLog() {
    const el = document.getElementById('sleep-log');
    if (!S.sleepLogs.length) {
        el.innerHTML = `<div class="empty-state">
            <svg class="empty-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#9d4edd" stroke-width="1.4" stroke-linecap="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
            <span class="empty-label">No sleep logged yet</span>
            <span class="empty-hint">Fill in the form above to log your first night</span>
        </div>`;
        return;
    }
    el.innerHTML = S.sleepLogs.slice(0, 14).map(l => {
        const h     = Math.floor(l.duration), m = Math.round((l.duration - h) * 60);
        const qual  = Math.round(l.quality || 0);
        const dots  = Array.from({length: 5}, (_, i) =>
            `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${i < qual ? 'var(--accent)' : 'var(--border-mid)'};margin-right:2px"></span>`
        ).join('');
        const isNap = l.type === 'nap';
        const badge = `<span class="sleep-type-badge${isNap ? ' nap' : ''}">${isNap ? 'NAP' : 'NIGHT'}</span>`;
        const notes = l.notes ? `<div class="sleep-log-notes">${l.notes}</div>` : '';
        const sched  = getSchedule();
        const offset = !isNap ? bedtimeOffset(l.bedtime, sched.bed) : null;
        let offsetTag = '';
        if (offset !== null) {
            const abs = Math.abs(Math.round(offset));
            if (abs <= 10)        offsetTag = `<span class="offset-tag offset-on">On time</span>`;
            else if (offset > 0)  offsetTag = `<span class="offset-tag offset-late">+${abs}m late</span>`;
            else                  offsetTag = `<span class="offset-tag offset-early">${abs}m early</span>`;
        }
        return `
            <div class="sleep-log-item">
                <div class="sleep-log-row">
                    <span class="sleep-log-date">${l.date} ${badge}</span>
                    <span style="display:flex;align-items:center;gap:4px">${dots}${offsetTag}</span>
                    <button class="log-del" data-date="${l.date}">✕</button>
                </div>
                <div class="sleep-log-detail">${l.bedtime} → ${l.waketime} &nbsp;|&nbsp; ${h}h ${m}m</div>
                ${notes}
            </div>`;
    }).join('');
}

document.getElementById('sleep-log').addEventListener('click', e => {
    const btn = e.target.closest('.log-del');
    if (btn) deleteSleep(btn.dataset.date);
});

// ── Sleep helpers ─────────────────────────────────────────────────────────────
function calcSleepScore(entry) {
    if (!entry || !entry.duration) return null;
    const durScore  = Math.min(entry.duration / S.sGoal, 1) * 60;
    const qualScore = ((entry.quality || 0) / 5) * 40;
    return Math.round(durScore + qualScore);
}

function calcSleepDebt7() {
    let debt = 0;
    for (let i = 0; i < 7; i++) {
        const d     = new Date(); d.setDate(d.getDate() - i);
        const key   = d.toISOString().slice(0, 10);
        const entry = monthSleep[key];
        if (entry && entry.type !== 'nap' && entry.duration) {
            debt += Math.max(0, S.sGoal - entry.duration);
        } else if (!entry) {
            debt += S.sGoal;
        }
    }
    return debt;
}

function calcBedtimeConsistency() {
    const entries = Object.values(monthSleep)
        .filter(e => e.type !== 'nap' && e.bedtime);
    if (entries.length < 3) return null;
    const mins = entries.map(e => {
        const [h, m] = e.bedtime.split(':').map(Number);
        let t = h * 60 + m;
        if (t < 12 * 60) t += 24 * 60; // past midnight → normalize
        return t;
    });
    const avg    = mins.reduce((a, b) => a + b, 0) / mins.length;
    const stdDev = Math.sqrt(mins.reduce((s, m) => s + (m - avg) ** 2, 0) / mins.length);
    if (stdDev <= 20) return 'Excellent';
    if (stdDev <= 45) return 'Good';
    if (stdDev <= 90) return 'Fair';
    return 'Irregular';
}

// ── Sleep stats ───────────────────────────────────────────────────────────────
function renderSleepStats() {
    // Current streak (night only)
    let streak = 0;
    const ref = new Date();
    for (let i = 0; i < 366; i++) {
        const key   = ref.toISOString().slice(0, 10);
        const entry = monthSleep[key];
        if (entry && entry.type !== 'nap') streak++;
        else break;
        ref.setDate(ref.getDate() - 1);
    }
    document.getElementById('stat-sleep-streak').textContent = streak + (streak === 1 ? ' day' : ' days');

    // Best streak
    const prevBest = parseInt(localStorage.getItem('ping_sbest') || '0');
    const best     = Math.max(streak, prevBest);
    if (best > prevBest) localStorage.setItem('ping_sbest', best);
    document.getElementById('stat-sleep-best').textContent = best + (best === 1 ? ' day' : ' days');

    // Avg quality (nights only)
    const nightEntries = Object.values(monthSleep).filter(e => e.type !== 'nap');
    const avgQ = nightEntries.length
        ? nightEntries.reduce((s, e) => s + (e.quality || 0), 0) / nightEntries.length : 0;
    document.getElementById('stat-sleep-quality').textContent = avgQ ? avgQ.toFixed(1) : '—';

    // Weekly summary
    renderSleepWeekly();
}

function renderSleepWeekly() {
    let totalDur = 0, totalScore = 0, scoreDays = 0;
    for (let i = 0; i < 7; i++) {
        const d     = new Date(); d.setDate(d.getDate() - i);
        const entry = monthSleep[d.toISOString().slice(0, 10)];
        if (entry && entry.type !== 'nap' && entry.duration) {
            totalDur += entry.duration;
            const sc  = calcSleepScore(entry);
            if (sc !== null) { totalScore += sc; scoreDays++; }
        }
    }
    const avgDur   = totalDur / 7;
    const avgScore = scoreDays ? Math.round(totalScore / scoreDays) : null;
    const debt     = calcSleepDebt7();
    const consist  = calcBedtimeConsistency();

    const fmtH = v => { const h = Math.floor(v), m = Math.round((v - h) * 60); return m ? `${h}h ${m}m` : `${h}h`; };
    document.getElementById('wk-sleep-avg').textContent         = avgDur   ? fmtH(avgDur)           : '—';
    document.getElementById('wk-sleep-score').textContent       = avgScore !== null ? avgScore + '/100' : '—';
    document.getElementById('wk-sleep-debt').textContent        = debt > 0  ? fmtH(debt)             : '0h';
    document.getElementById('wk-sleep-consistency').textContent = consist   || '—';
}

// ── Sleep chart (monthly view) ────────────────────────────────────────────────
function renderSleepChart() {
    const canvas = document.getElementById('sleepChart');
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

    const label = new Date(viewSY, viewSM - 1, 1)
        .toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();
    document.getElementById('sleep-month-label').textContent = label;

    const days = daysInMonth(viewSY, viewSM);
    const GOAL = S.sGoal;
    const vals = [], types = [];
    for (let d = 1; d <= days; d++) {
        const key   = `${viewSY}-${pad2(viewSM)}-${pad2(d)}`;
        const entry = monthSleep[key];
        vals.push(entry?.duration || 0);
        types.push(entry?.type || 'night');
    }

    const MAX  = Math.max(GOAL * 1.2, ...vals, 4);
    const pL = 28, pR = 6, pT = 10, pB = 22;
    const cW = W - pL - pR, cH = H - pT - pB;
    const slot = cW / days, bW = Math.max(slot * 0.72, 2);
    const FONT = `8px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;

    [0, GOAL / 2, GOAL].forEach(v => {
        const y = pT + cH - (v / MAX) * cH;
        ctx.strokeStyle = 'rgba(42,42,90,.5)'; ctx.setLineDash([3,3]); ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(W - pR, y); ctx.stroke();
        ctx.setLineDash([]);
        if (v > 0) {
            ctx.fillStyle = '#6666aa'; ctx.font = FONT; ctx.textAlign = 'right';
            ctx.fillText(v + 'h', pL - 2, y + 3);
        }
    });

    const goalY = pT + cH - (GOAL / MAX) * cH;
    ctx.strokeStyle = 'rgba(157,78,221,.5)'; ctx.setLineDash([4,3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pL, goalY); ctx.lineTo(W - pR, goalY); ctx.stroke();
    ctx.setLineDash([]);

    const cy = NOW.getFullYear(), cm = NOW.getMonth() + 1, cd = NOW.getDate();

    // 7-day rolling average trend line (nights only)
    const sTrendPts = vals.map((_, i) => {
        const slice = vals.slice(Math.max(0, i - 6), i + 1).filter((v, j) => types[Math.max(0, i - 6) + j] !== 'nap');
        return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : 0;
    });
    ctx.strokeStyle = 'rgba(192,132,252,.6)'; ctx.setLineDash([3,2]); ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    sTrendPts.forEach((v, i) => {
        if (!v) return;
        const x = pL + i * slot + slot / 2;
        const y = pT + cH - (v / MAX) * cH;
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    });
    ctx.stroke(); ctx.setLineDash([]);

    vals.forEach((dur, i) => {
        const x       = pL + i * slot + (slot - bW) / 2;
        const bH      = (dur / MAX) * cH;
        const y       = pT + cH - bH;
        const isNap   = types[i] === 'nap';
        const met     = !isNap && dur >= GOAL;
        const isToday = viewSY === cy && viewSM === cm && (i + 1) === cd;

        if (dur > 0) {
            const grad = ctx.createLinearGradient(x, y, x, pT + cH);
            grad.addColorStop(0, isNap ? 'rgba(6,214,160,.8)' : (met ? 'rgba(192,132,252,.8)' : 'rgba(157,78,221,.8)'));
            grad.addColorStop(1, isNap ? 'rgba(6,214,160,.08)' : 'rgba(157,78,221,.06)');
            ctx.fillStyle = grad; ctx.fillRect(x, y, bW, bH);
            ctx.fillStyle = isNap ? '#06d6a0' : (met ? '#c084fc' : '#9d4edd');
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

// ── Month navigation (sleep) ──────────────────────────────────────────────────
document.getElementById('sleep-prev').addEventListener('click', async () => {
    viewSM--; if (viewSM < 1) { viewSM = 12; viewSY--; }
    await loadMonthData(viewSY, viewSM);
    renderSleepStats(); renderSleepChart();
});

document.getElementById('sleep-next').addEventListener('click', async () => {
    if (viewSY >= NOW.getFullYear() && viewSM >= NOW.getMonth() + 1) return;
    viewSM++; if (viewSM > 12) { viewSM = 1; viewSY++; }
    await loadMonthData(viewSY, viewSM);
    renderSleepStats(); renderSleepChart();
});

// ════════════════════════════════════════════════════
//  NAP TIMER
// ════════════════════════════════════════════════════
let napStartTime   = null;
let napClockTimer  = null;

document.getElementById('nap-timer-btn').addEventListener('click', () => {
    if (!napStartTime) {
        // Start
        napStartTime = new Date();
        // Pre-fill bedtime with now
        document.getElementById('sleep-date').value = S.today;
        sleepType = 'nap';
        document.getElementById('sleep-type').value = 'nap';
        document.getElementById('bedtime').value =
            `${pad2(napStartTime.getHours())}:${pad2(napStartTime.getMinutes())}`;

        document.getElementById('nap-timer-btn').textContent = '■ STOP NAP';
        document.getElementById('nap-timer-btn').classList.add('running');

        napClockTimer = setInterval(() => {
            const elapsed = Math.floor((Date.now() - napStartTime) / 1000);
            const m = Math.floor(elapsed / 60), s = elapsed % 60;
            document.getElementById('nap-display').textContent = `${pad2(m)}:${pad2(s)}`;
        }, 1000);
    } else {
        // Stop — fill wake time and duration
        const now = new Date();
        document.getElementById('waketime').value =
            `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
        refreshDur();

        clearInterval(napClockTimer);
        napStartTime  = null;
        napClockTimer = null;
        document.getElementById('nap-timer-btn').textContent = '▶ START NAP';
        document.getElementById('nap-timer-btn').classList.remove('running');
        document.getElementById('nap-display').textContent = '';
        toast('Nap stopped — review and tap LOG SLEEP');
    }
});

// ════════════════════════════════════════════════════
//  CSV EXPORT
// ════════════════════════════════════════════════════
document.getElementById('export-csv').addEventListener('click', () => {
    const allDates = new Set([
        ...Object.keys(monthWater),
        ...Object.keys(monthSleep),
    ]);
    if (!allDates.size) { toast('No data to export', true); return; }

    const rows = ['Date,Water (ml),Sleep Duration (h),Sleep Quality,Bedtime,Wake Time,Sleep Type,Notes'];
    [...allDates].sort().forEach(date => {
        const ml    = monthWater[date] || '';
        const sl    = monthSleep[date] || {};
        const notes = (sl.notes || '').replace(/,/g, ';').replace(/\n/g, ' ');
        rows.push([
            date, ml,
            sl.duration || '', sl.quality || '',
            sl.bedtime  || '', sl.waketime || '',
            sl.type     || '', notes,
        ].join(','));
    });

    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `ping-tracker-${S.today}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast('CSV downloaded!');
});

// ════════════════════════════════════════════════════
//  MONTHLY REPORT
// ════════════════════════════════════════════════════
function openMonthlyReport() {
    const y = NOW.getFullYear(), m = NOW.getMonth() + 1;
    const days  = daysInMonth(y, m);
    const goalMl = S.wGoal * S.bSize;

    let waterDays = 0, waterTotal = 0;
    let sleepNights = 0, sleepDurTotal = 0, sleepQualTotal = 0, sleepScoreTotal = 0;

    for (let d = 1; d <= days; d++) {
        const key = `${y}-${pad2(m)}-${pad2(d)}`;
        const wml = key === S.today ? todayMl() : (monthWater[key] || 0);
        if (wml >= goalMl) waterDays++;
        waterTotal += wml;

        const sl = monthSleep[key];
        if (sl && sl.type !== 'nap' && sl.duration) {
            sleepNights++;
            sleepDurTotal  += sl.duration;
            sleepQualTotal += (sl.quality || 0);
            const sc = calcSleepScore(sl);
            if (sc !== null) sleepScoreTotal += sc;
        }
    }

    const monthName = new Date(y, m - 1, 1)
        .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    // Current streaks
    let wStreak = 0;
    const wr = new Date();
    for (let i = 0; i < 366; i++) {
        const key = wr.toISOString().slice(0, 10);
        const ml  = key === S.today ? todayMl() : (monthWater[key] || 0);
        if (ml >= goalMl) wStreak++; else break;
        wr.setDate(wr.getDate() - 1);
    }
    let sStreak = 0;
    const sr = new Date();
    for (let i = 0; i < 366; i++) {
        const e = monthSleep[sr.toISOString().slice(0, 10)];
        if (e && e.type !== 'nap') sStreak++; else break;
        sr.setDate(sr.getDate() - 1);
    }

    const corr = calcCorrelation();
    const debt = calcSleepDebt7();

    const reportData = {
        monthName, days, waterDays,
        avgWater:      days      > 0 ? waterTotal     / days      : 0,
        sleepNights,
        avgSleepDur:   sleepNights > 0 ? sleepDurTotal  / sleepNights : 0,
        avgSleepQual:  sleepNights > 0 ? sleepQualTotal / sleepNights : 0,
        avgSleepScore: sleepNights > 0 ? sleepScoreTotal/ sleepNights : 0,
        wStreak, sStreak, debt, corr,
    };

    // Show overlay first so canvas has layout dimensions, then draw
    document.getElementById('report-overlay').classList.add('visible');
    requestAnimationFrame(() => renderReportCanvas(reportData));
}

function renderReportCanvas({ monthName, days, waterDays, avgWater,
    sleepNights, avgSleepDur, avgSleepQual, avgSleepScore,
    wStreak, sStreak, debt, corr }) {

    const canvas = document.getElementById('report-canvas');
    const DPR    = 2; // fixed 2× for crisp PNG download
    const W = 340, H = 470;
    canvas.width  = W * DPR;
    canvas.height = H * DPR;
    const ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);

    const FONT = '"Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif';
    const fmtH  = v => {
        if (!v) return '—';
        const h = Math.floor(v), m = Math.round((v - h) * 60);
        return m ? `${h}h ${m}m` : `${h}h`;
    };
    const fmtMl = v => !v ? '—'
        : v >= 1000 ? (v / 1000).toFixed(1) + 'L'
        : Math.round(v) + 'ml';

    // ── Background ──
    ctx.fillStyle = '#07071a'; ctx.fillRect(0, 0, W, H);
    const bgGrad = ctx.createLinearGradient(0, 0, W, H);
    bgGrad.addColorStop(0, 'rgba(157,78,221,0.09)');
    bgGrad.addColorStop(1, 'rgba(6,214,160,0.04)');
    ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, W, H);

    // Border
    ctx.strokeStyle = 'rgba(157,78,221,0.3)'; ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

    // ── Header ──
    ctx.fillStyle = 'rgba(157,78,221,0.18)'; ctx.fillRect(0, 0, W, 54);
    ctx.fillStyle = '#c084fc'; ctx.font = `bold 10px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('PING  ·  MONTHLY REPORT', W / 2, 19);
    ctx.fillStyle = '#f0f0ff'; ctx.font = `bold 21px ${FONT}`;
    ctx.fillText(monthName.toUpperCase(), W / 2, 44);

    // ── Layout helpers ──
    let y = 66;
    const pad = 22, ROW = 18;

    const hLine = () => {
        ctx.strokeStyle = 'rgba(42,42,90,0.8)'; ctx.lineWidth = 0.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
        ctx.setLineDash([]);
        y += 11;
    };

    const secHead = (icon, title, color) => {
        ctx.fillStyle = color; ctx.font = `bold 9px ${FONT}`; ctx.textAlign = 'left';
        ctx.fillText(`${icon}  ${title}`, pad, y);
        y += 14;
    };

    const statRow = (label, value, valColor = '#f0f0ff') => {
        ctx.fillStyle = 'rgba(136,136,187,0.85)'; ctx.font = `9px ${FONT}`; ctx.textAlign = 'left';
        ctx.fillText(label, pad + 6, y);
        ctx.fillStyle = valColor; ctx.font = `bold 9px ${FONT}`; ctx.textAlign = 'right';
        ctx.fillText(value, W - pad, y);
        y += ROW;
    };

    // ── WATER ──
    secHead('💧', 'WATER', '#06d6a0');
    statRow('Goal days met',  `${waterDays} / ${days}  (${Math.round(waterDays / days * 100)}%)`, '#06d6a0');
    statRow('Average per day', fmtMl(avgWater));
    y += 4; hLine();

    // ── SLEEP ──
    secHead('🌙', 'SLEEP', '#9d4edd');
    if (sleepNights > 0) {
        statRow('Nights logged', `${sleepNights} / ${days}`);
        statRow('Avg duration',  fmtH(avgSleepDur),                    '#c084fc');
        statRow('Avg quality',   `${avgSleepQual.toFixed(1)} / 5`);
        statRow('Avg score',     `${Math.round(avgSleepScore)} / 100`);
    } else {
        ctx.fillStyle = 'rgba(136,136,187,0.5)'; ctx.font = `9px ${FONT}`; ctx.textAlign = 'left';
        ctx.fillText('No nights logged this month', pad + 6, y); y += ROW;
    }
    y += 4; hLine();

    // ── STREAKS ──
    secHead('🔥', 'STREAKS & TRENDS', '#f72585');
    statRow('Water streak',     `${wStreak} day${wStreak !== 1 ? 's' : ''}`, '#06d6a0');
    statRow('Sleep streak',     `${sStreak} day${sStreak !== 1 ? 's' : ''}`, '#c084fc');
    statRow('Sleep debt (7d)',  debt > 0 ? fmtH(debt) : '0h  ✓', debt > 2 ? '#ffbe0b' : '#06d6a0');
    y += 4;

    // ── INSIGHT ──
    if (corr && corr.goalAvgQ !== null && corr.noGoalAvgQ !== null) {
        hLine();
        secHead('💡', 'INSIGHT', '#f72585');
        const diff = corr.goalAvgQ - corr.noGoalAvgQ;
        const txt  = Math.abs(diff) < 0.15
            ? `Sleep quality is consistent at ~${corr.goalAvgQ.toFixed(1)}/5 regardless of hydration — great habits!`
            : diff > 0
                ? `Hydrated days → sleep quality ${corr.goalAvgQ.toFixed(1)}/5 vs ${corr.noGoalAvgQ.toFixed(1)}/5 on non-goal days  (+${diff.toFixed(1)} pts)`
                : `Sleep quality ${corr.goalAvgQ.toFixed(1)}/5 on goal days vs ${corr.noGoalAvgQ.toFixed(1)}/5 on other days.`;

        ctx.fillStyle = '#c0c0e8'; ctx.font = `9px ${FONT}`; ctx.textAlign = 'left';
        const maxLineW = W - pad * 2 - 6;
        const words = txt.split(' ');
        let line = '';
        for (const word of words) {
            const test = line + word + ' ';
            if (ctx.measureText(test).width > maxLineW && line) {
                ctx.fillText(line.trim(), pad + 6, y);
                line = word + ' '; y += 14;
            } else {
                line = test;
            }
        }
        if (line.trim()) { ctx.fillText(line.trim(), pad + 6, y); y += 14; }
        y += 4;
    }

    // ── Footer ──
    ctx.fillStyle = 'rgba(102,102,170,0.45)'; ctx.font = `8px ${FONT}`; ctx.textAlign = 'center';
    ctx.fillText('Generated by PING — Sleep & Water Tracker', W / 2, H - 11);
}

function downloadReport() {
    const canvas = document.getElementById('report-canvas');
    const a = document.createElement('a');
    a.href     = canvas.toDataURL('image/png');
    a.download = `ping-report-${S.today.slice(0, 7)}.png`;
    a.click();
    toast('Report saved!');
}

document.getElementById('open-report').addEventListener('click', () => {
    document.getElementById('settings-overlay').classList.remove('visible');
    openMonthlyReport();
});

document.getElementById('report-close').addEventListener('click', () =>
    document.getElementById('report-overlay').classList.remove('visible'));

document.getElementById('report-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('report-overlay'))
        document.getElementById('report-overlay').classList.remove('visible');
});

document.getElementById('download-report').addEventListener('click', downloadReport);

// ════════════════════════════════════════════════════
//  SETTINGS
// ════════════════════════════════════════════════════
document.getElementById('settings-btn').addEventListener('click', () => {
    closeMobileSidebar();
    applyBottleSettings();
    applySleepGoal();
    applyCaffGoal();
    document.getElementById('at-token').value = AT_TOKEN;
    document.getElementById('at-base').value  = AT_BASE;
    // Restore sleep schedule
    const sched = getSchedule();
    if (sched.bed)  document.getElementById('target-bed').value  = sched.bed;
    if (sched.wake) document.getElementById('target-wake').value = sched.wake;
    // Restore reminder select
    const savedH = localStorage.getItem('ping_reminder_h') || '0';
    document.getElementById('reminder-interval').value = savedH;
    document.getElementById('settings-overlay').classList.add('visible');
});

document.getElementById('modal-close').addEventListener('click', () =>
    document.getElementById('settings-overlay').classList.remove('visible'));

document.getElementById('settings-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('settings-overlay'))
        document.getElementById('settings-overlay').classList.remove('visible');
});

document.getElementById('save-pin').addEventListener('click', async () => {
    const v = document.getElementById('new-pin').value;
    if (!/^\d{4}$/.test(v)) { toast('4 digits required', true); return; }
    await persistPIN(await sha256(v));
    document.getElementById('new-pin').value = '';
    toast('PIN updated!');
});

// ── Sleep schedule ────────────────────────────────────────────────────────────
function getSchedule() {
    return {
        bed:  localStorage.getItem('ping_target_bed')  || '',
        wake: localStorage.getItem('ping_target_wake') || '',
    };
}

function bedtimeOffset(actual, target) {
    if (!actual || !target) return null;
    const toMins = t => { const [h,m] = t.split(':').map(Number); let v = h*60+m; if (v < 12*60) v += 1440; return v; };
    const diff = toMins(actual) - toMins(target); // positive = late
    return diff; // minutes
}

document.getElementById('save-schedule').addEventListener('click', () => {
    const bed  = document.getElementById('target-bed').value;
    const wake = document.getElementById('target-wake').value;
    localStorage.setItem('ping_target_bed',  bed);
    localStorage.setItem('ping_target_wake', wake);
    toast('Sleep schedule saved!');
    renderSleepLog();
});

// ── Hydration reminders ───────────────────────────────────────────────────────
function startReminders(hours) {
    if (reminderTimer) { clearInterval(reminderTimer); reminderTimer = null; }
    if (!hours || hours <= 0) return;
    if (!('Notification' in window)) { toast('Notifications not supported', true); return; }
    Notification.requestPermission().then(perm => {
        if (perm !== 'granted') { toast('Notification permission denied', true); return; }
        reminderTimer = setInterval(() => {
            const bottles = todayBottles();
            new Notification('💧 Time to drink water!', {
                body: `You've had ${bottles.toFixed(1)} of ${S.wGoal} bottles today. Keep it up!`,
                silent: false,
            });
        }, hours * 60 * 60 * 1000);
        localStorage.setItem('ping_reminder_h', hours);
        toast(`Reminders set every ${hours}h`);
    });
}

document.getElementById('reminder-interval').addEventListener('change', e => {
    const h = parseFloat(e.target.value);
    startReminders(h);
    if (!h) { localStorage.removeItem('ping_reminder_h'); toast('Reminders off'); }
});

document.getElementById('save-airtable').addEventListener('click', () => {
    const token = document.getElementById('at-token').value.trim();
    const base  = document.getElementById('at-base').value.trim();
    if (!token || !base) { toast('Enter both token and base ID', true); return; }
    AT_TOKEN = token;
    AT_BASE  = base;
    localStorage.setItem('ping_at_token', AT_TOKEN);
    localStorage.setItem('ping_at_base',  AT_BASE);
    toast('Airtable config saved!');
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
    if (recId && AT_READY()) {
        try {
            await atDelete('Water', recId);
            delete REC['w_' + S.today];
            localStorage.setItem('ping_rec', JSON.stringify(REC));
        } catch {}
    }
    S.waterToday = [];
    refreshWaterUI();
    toast('Today cleared');
});

// ════════════════════════════════════════════════════
//  UTILS
// ════════════════════════════════════════════════════
// Add notes style to sleep log (inline so no extra CSS file needed)
const noteStyle = document.createElement('style');
noteStyle.textContent = '.sleep-log-notes{font-size:11px;color:var(--accent);margin-top:3px;font-style:italic;}';
document.head.appendChild(noteStyle);

function toast(msg, err = false) {
    const el = document.createElement('div');
    el.className = 'toast' + (err ? ' err' : '');
    el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), 2600);
}

window.addEventListener('resize', () => {
    renderWaterChart(); renderWaterHeatmap();
    renderSleepChart(); renderSleepHeatmap();
});

// ════════════════════════════════════════════════════
//  PWA — SERVICE WORKER
// ════════════════════════════════════════════════════
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () =>
        navigator.serviceWorker.register('./sw.js')
            .catch(err => console.warn('SW registration failed:', err))
    );
}

// ════════════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════════════
// Restore hydration reminder if previously set
const _savedReminderH = parseFloat(localStorage.getItem('ping_reminder_h') || '0');
if (_savedReminderH > 0) startReminders(_savedReminderH);

bootPIN();
