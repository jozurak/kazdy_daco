const firebaseConfig = {
    apiKey: "AIzaSyDQ3_Xv6qKnSz4jCUTOZKRfBPGi3tgJ7nU",
    authDomain: "kazdy-daco.firebaseapp.com",
    databaseURL: "https://kazdy-daco-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "kazdy-daco",
    storageBucket: "kazdy-daco.firebasestorage.app",
    messagingSenderId: "500427141172",
    appId: "1:500427141172:web:4addb7f4166465a0625a61"
};

// Initialize Firebase using the Compat API (available globally via window.firebase)
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// --- State ---
let dbTeams = {};
let dbSettings = {};
let selectedStationStats = new Set(['obrana', 'útok']); // Default selected

const ALL_STATS = ['obrana', 'útok', 'munícia', 'hlad', 'smäd', 'mentalita', 'ľudia', 'šťastie'];
const BATTLE_EXCLUDED_STATS = ['ľudia', 'peniaze'];
const TICK_STATS = ALL_STATS; // All except money, which is not in ALL_STATS array anyway

const PRESET_TEAMS = [
    { name: "Žůžo", color: "#ec4899" }, // ružová
    { name: "Smurf", color: "#3b82f6" }, // modrá
    { name: "Grzogorz Brzszyszczykiewicz", color: "#ef4444" }, // červená
    { name: "Body count 67", color: "#10b981" }, // zelená
    { name: "Panáčik", color: "#eab308" }, // žltá
    { name: "BIBI", color: "#f97316" } // oranžová
];

// Battle State
let battleState = {
    active: false,
    challenger: null,
    challenged: null,
    challengerPeople: 0,
    challengedPeople: 0,
    challengerRerollsUsed: 0,
    challengedRerollsUsed: 0,
    currentTurn: null, // 'challenger' or 'challenged'
    currentStat: null
};

// --- Initial Setup & Listeners ---
const teamsRef = db.ref('teams');
const settingsRef = db.ref('settings');

teamsRef.on('value', (snapshot) => {
    if (snapshot.exists()) {
        dbTeams = snapshot.val();
        renderStationView();
        renderAdminView();
        updateBattleSelectors();
        
        if(battleState.active) {
            updateBattleUI(); // Update UI in case stats changed real-time during battle
        }
    } else {
        // Init default data if empty
        initDefaultDB();
    }
});

settingsRef.on('value', (snapshot) => {
    if (snapshot.exists()) {
        dbSettings = snapshot.val();
        updateSetupView();
    }
});

// Tick Engine
setInterval(() => {
    if(!dbSettings.tickIntervals) return;
    
    const now = Date.now();
    const mode = dbSettings.tickMode || 'global';
    
    if (mode === 'global') {
        const lastTick = dbSettings.lastTickTimes?.global || dbSettings.lastTickTime || now;
        const intervalMs = (dbSettings.tickIntervals.global || 180) * 1000;
        const nextTick = lastTick + intervalMs;
        
        const timeLeft = Math.max(0, Math.floor((nextTick - now) / 1000));
        const countdownEl = document.getElementById('tick-countdown');
        if(countdownEl) countdownEl.textContent = `${timeLeft}s`;

        if (now >= nextTick) {
            // Execute tick
            executeGlobalTick(nextTick);
        }
    } else {
        // Individual mode
        const indCdEl = document.getElementById('individual-tick-countdown');
        let countdownTexts = [];
        let updates = {};
        let statsDecreased = [];
        
        for (const stat of TICK_STATS) {
            const lastTick = dbSettings.lastTickTimes?.individual?.[stat] || now;
            const intervalMs = (dbSettings.tickIntervals?.individual?.[stat] || 180) * 1000;
            const nextTick = lastTick + intervalMs;
            
            const timeLeft = Math.max(0, Math.floor((nextTick - now) / 1000));
            countdownTexts.push(`${stat}: ${timeLeft}s`);
            
            if (now >= nextTick) {
                // decrease stat for all teams
                Object.entries(dbTeams).forEach(([tId, team]) => {
                    let newVal = Math.max(0, (team.stats[stat] || 0) - 1);
                    updates[`teams/${tId}/stats/${stat}`] = newVal;
                });
                updates[`settings/lastTickTimes/individual/${stat}`] = Date.now();
                statsDecreased.push(stat);
            }
        }
        
        if(indCdEl) indCdEl.innerHTML = countdownTexts.join(' | ');
        
        if (Object.keys(updates).length > 0) {
            db.ref().update(updates);
            showToast(`Staty znížené: ${statsDecreased.join(', ')}`, 'warning');
        }
    }
}, 1000);

async function executeGlobalTick(newTimestamp) {
    try {
        const snapshot = await teamsRef.get();
        if (!snapshot.exists()) return;
        
        let updates = {};
        const teams = snapshot.val();
        
        for (const [tId, team] of Object.entries(teams)) {
            for (const stat of TICK_STATS) {
                let newVal = Math.max(0, (team.stats[stat] || 0) - 1);
                updates[`teams/${tId}/stats/${stat}`] = newVal;
            }
        }
        
        updates['settings/lastTickTimes/global'] = Date.now();
        updates['settings/lastTickTime'] = Date.now(); // fallback for old structures
        
        await db.ref().update(updates);
        showToast('Staty boli plošne znížené o 1.', 'warning');
    } catch (e) {
        console.error("Tick error", e);
    }
}

async function initDefaultDB() {
    let teams = {};
    for (let i = 1; i <= 6; i++) {
        let stats = {};
        ALL_STATS.forEach(s => stats[s] = 10);
        stats['peniaze'] = 1000;
        
        let preset = PRESET_TEAMS[i-1];
        teams[`t${i}`] = {
            id: `t${i}`,
            name: preset.name,
            color: preset.color,
            stats: stats,
            cooldowns: { canAttackAfter: 0, canBeAttackedAfter: 0 }
        };
    }
    
    let indIntervals = {};
    let indLastTicks = {};
    TICK_STATS.forEach(s => { indIntervals[s] = 180; indLastTicks[s] = Date.now(); });
    
    let settings = {
        tickMode: 'global',
        tickIntervals: { global: 180, individual: indIntervals },
        lastTickTimes: { global: Date.now(), individual: indLastTicks },
        lastTickTime: Date.now(),
        moneyLossPercent: 25,
        cooldowns: {
            challenger: { cantAttack: 5, cantBeAttacked: 5 },
            challenged: { cantAttack: 8, cantBeAttacked: 3 }
        }
    };
    
    await db.ref('teams').set(teams);
    await db.ref('settings').set(settings);
    showToast('Databáza inicializovaná.');
}

// --- Navigation ---
document.querySelectorAll('.nav-links a').forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('.nav-links a').forEach(l => l.classList.remove('active'));
        e.target.closest('a').classList.add('active');
        
        const targetId = e.target.closest('a').dataset.target;
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById(targetId).classList.add('active');
        
        if(window.innerWidth <= 768) {
            document.querySelector('.nav-links').classList.remove('active');
        }
    });
});

document.querySelector('.hamburger').addEventListener('click', () => {
    document.querySelector('.nav-links').classList.toggle('active');
});

// --- UI Rendering ---

function renderStationFilters() {
    const container = document.getElementById('station-stat-filters');
    container.innerHTML = '';
    
    ALL_STATS.forEach(stat => {
        const wrapper = document.createElement('div');
        wrapper.className = 'checkbox-wrapper';
        
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = `filter-${stat}`;
        input.value = stat;
        input.checked = selectedStationStats.has(stat);
        
        input.addEventListener('change', (e) => {
            if (e.target.checked) selectedStationStats.add(stat);
            else selectedStationStats.delete(stat);
            renderStationView();
        });
        
        const label = document.createElement('label');
        label.htmlFor = `filter-${stat}`;
        label.textContent = stat.charAt(0).toUpperCase() + stat.slice(1);
        
        wrapper.appendChild(input);
        wrapper.appendChild(label);
        container.appendChild(wrapper);
    });
}
renderStationFilters(); // Init once

function renderStationView() {
    const container = document.getElementById('station-teams-grid');
    if(!container) return;
    container.innerHTML = '';
    
    Object.values(dbTeams).forEach(team => {
        const card = document.createElement('div');
        card.className = 'team-card';
        card.style.borderColor = team.color;
        
        let statsHtml = '';
        ALL_STATS.forEach(stat => {
            if (selectedStationStats.has(stat)) {
                statsHtml += `
                    <div class="stat-row">
                        <span class="stat-name">${stat}</span>
                        <div class="stat-controls">
                            <button class="btn btn-icon btn-danger" onclick="updateStat('${team.id}', '${stat}', -1)">-</button>
                            <span class="stat-value">${team.stats[stat] || 0}</span>
                            <button class="btn btn-icon btn-success" onclick="updateStat('${team.id}', '${stat}', 1)">+</button>
                        </div>
                    </div>
                `;
            }
        });
        
        card.innerHTML = `
            <div class="team-header" style="background-color: ${team.color}40">${team.name}</div>
            <div class="team-stats">${statsHtml || '<p class="text-sm" style="text-align:center;">Žiadne staty nie sú vybrané.</p>'}</div>
        `;
        container.appendChild(card);
    });
}

function renderAdminView() {
    const container = document.getElementById('admin-teams-grid');
    if(!container) return;
    container.innerHTML = '';
    
    Object.values(dbTeams).forEach(team => {
        const card = document.createElement('div');
        card.className = 'team-card';
        card.style.borderColor = team.color;
        
        let statsHtml = '';
        [...ALL_STATS, 'peniaze'].forEach(stat => {
            statsHtml += `
                <div class="stat-row">
                    <span class="stat-name">${stat}</span>
                    <div class="admin-controls">
                        <input type="number" id="admin-in-${team.id}-${stat}" class="admin-input" placeholder="0" onkeypress="handleAdminInput(event, '${team.id}', '${stat}')">
                        <button class="btn btn-icon btn-danger" onclick="updateStat('${team.id}', '${stat}', -1)">-</button>
                        <span class="stat-value">${team.stats[stat] || 0}</span>
                        <button class="btn btn-icon btn-success" onclick="updateStat('${team.id}', '${stat}', 1)">+</button>
                    </div>
                </div>
            `;
        });
        
        card.innerHTML = `
            <div class="team-header" style="background-color: ${team.color}40">
                <input type="text" value="${team.name}" class="admin-input" style="width:auto; font-weight:bold" onchange="updateTeamName('${team.id}', this.value)">
                <input type="color" value="${team.color}" onchange="updateTeamColor('${team.id}', this.value)">
            </div>
            <div class="team-stats">${statsHtml}</div>
        `;
        container.appendChild(card);
    });
}

// Make functions globally available for inline onclick handlers
window.updateStat = async (teamId, stat, delta) => {
    const current = dbTeams[teamId].stats[stat] || 0;
    const newVal = Math.max(0, current + delta);
    await db.ref(`teams/${teamId}/stats/${stat}`).set(newVal);
};

window.handleAdminInput = async (e, teamId, stat) => {
    if (e.key === 'Enter') {
        const input = document.getElementById(`admin-in-${teamId}-${stat}`);
        const val = parseInt(input.value);
        if(!isNaN(val)) {
            const current = dbTeams[teamId].stats[stat] || 0;
            // Prirátavame, ak používateľ zadá +5 tak sa pripočíta, ak zadá -3, tak sa odpočíta
            const newVal = Math.max(0, current + val); 
            await db.ref(`teams/${teamId}/stats/${stat}`).set(newVal);
            input.value = '';
        }
    }
};

window.updateTeamName = async (teamId, name) => {
    await db.ref(`teams/${teamId}/name`).set(name);
}

window.updateTeamColor = async (teamId, color) => {
    await db.ref(`teams/${teamId}/color`).set(color);
}

// --- Setup View Logic ---
function updateSetupView() {
    if(!dbSettings.tickIntervals) return;
    const mode = dbSettings.tickMode || 'global';
    document.getElementById('setup-tick-mode').value = mode;
    
    // UI pre prepínanie pohľadov podľa režimu
    if(mode === 'global') {
        document.getElementById('setup-card-global').style.display = 'block';
        document.getElementById('setup-card-individual').style.display = 'none';
    } else {
        document.getElementById('setup-card-global').style.display = 'none';
        document.getElementById('setup-card-individual').style.display = 'block';
    }
    
    document.getElementById('setup-global-tick').value = dbSettings.tickIntervals.global || 180;
    
    // Vykresliť individuálne vstupy
    const indContainer = document.getElementById('specific-ticks-container');
    indContainer.innerHTML = '';
    
    TICK_STATS.forEach(stat => {
        const val = dbSettings.tickIntervals.individual?.[stat] || 180;
        indContainer.innerHTML += `
            <div class="setting-item">
                <label style="text-transform: capitalize;">${stat}</label>
                <div class="input-group">
                    <input type="number" id="setup-ind-${stat}" value="${val}" min="10">
                    <span class="input-addon">s</span>
                </div>
            </div>
        `;
    });
    
    if(dbSettings.cooldowns) {
        document.getElementById('setup-challenger-no-attack').value = dbSettings.cooldowns.challenger.cantAttack || 5;
        document.getElementById('setup-challenger-no-be-attacked').value = dbSettings.cooldowns.challenger.cantBeAttacked || 5;
        document.getElementById('setup-challenged-no-attack').value = dbSettings.cooldowns.challenged.cantAttack || 8;
        document.getElementById('setup-challenged-no-be-attacked').value = dbSettings.cooldowns.challenged.cantBeAttacked || 3;
    }
}

document.getElementById('btn-save-tick-mode').addEventListener('click', async () => {
    const mode = document.getElementById('setup-tick-mode').value;
    await db.ref('settings/tickMode').set(mode);
    showToast('Režim klesania aktualizovaný', 'success');
});

document.getElementById('btn-save-global-tick').addEventListener('click', async () => {
    const val = parseInt(document.getElementById('setup-global-tick').value) || 180;
    await db.ref('settings/tickIntervals/global').set(val);
    showToast('Globálny časovač aktualizovaný', 'success');
});

document.getElementById('btn-save-individual-tick').addEventListener('click', async () => {
    let updates = {};
    TICK_STATS.forEach(stat => {
        const val = parseInt(document.getElementById(`setup-ind-${stat}`).value) || 180;
        updates[`settings/tickIntervals/individual/${stat}`] = val;
    });
    await db.ref().update(updates);
    showToast('Individuálne časy aktualizované', 'success');
});

document.getElementById('btn-save-economy').addEventListener('click', async () => {
    const updates = {
        'settings/moneyLossPercent': parseInt(document.getElementById('setup-money-loss').value) || 25,
        'settings/cooldowns/challenger/cantAttack': parseInt(document.getElementById('setup-challenger-no-attack').value) || 5,
        'settings/cooldowns/challenger/cantBeAttacked': parseInt(document.getElementById('setup-challenger-no-be-attacked').value) || 5,
        'settings/cooldowns/challenged/cantAttack': parseInt(document.getElementById('setup-challenged-no-attack').value) || 8,
        'settings/cooldowns/challenged/cantBeAttacked': parseInt(document.getElementById('setup-challenged-no-be-attacked').value) || 3,
    };
    await db.ref().update(updates);
    showToast('Nastavenia ekonomiky uložené', 'success');
});

document.getElementById('btn-reset-db').addEventListener('click', () => {
    if(confirm('Naozaj chcete resetovať celú databázu? Všetok postup sa stratí!')) {
        initDefaultDB();
    }
});

// --- Battle Logic ---
function updateBattleSelectors() {
    if(battleState.active) return; // Nedotykaj sa selectov počas súboja
    
    const selChal = document.getElementById('challenger-select');
    const selChd = document.getElementById('challenged-select');
    
    const vChal = selChal.value;
    const vChd = selChd.value;
    
    let html = '<option value="">Vyberte tím...</option>';
    
    Object.values(dbTeams).forEach(t => {
        html += `<option value="${t.id}">${t.name}</option>`;
    });
    
    selChal.innerHTML = html;
    selChd.innerHTML = html;
    
    if(dbTeams[vChal]) selChal.value = vChal;
    if(dbTeams[vChd]) selChd.value = vChd;
    
    checkBattleReady();
}

document.getElementById('challenger-select').addEventListener('change', checkBattleReady);
document.getElementById('challenged-select').addEventListener('change', checkBattleReady);

function formatCooldown(ms) {
    if(ms <= 0) return '';
    const min = Math.ceil(ms / 60000);
    return min > 0 ? `${min} min` : '';
}

function checkBattleReady() {
    const chalId = document.getElementById('challenger-select').value;
    const chdId = document.getElementById('challenged-select').value;
    const btn = document.getElementById('btn-start-battle');
    
    const chalCdEl = document.getElementById('challenger-cooldown');
    const chdCdEl = document.getElementById('challenged-cooldown');
    chalCdEl.textContent = '';
    chdCdEl.textContent = '';
    
    let ready = true;
    let now = Date.now();
    
    if(chalId) {
        let t = dbTeams[chalId];
        let cantAtt = t.cooldowns?.canAttackAfter - now;
        if(cantAtt > 0) {
            chalCdEl.textContent = `Nemôže vyzývať ešte ${formatCooldown(cantAtt)}`;
            ready = false;
        }
    } else ready = false;
    
    if(chdId) {
        let t = dbTeams[chdId];
        let cantBeAtt = t.cooldowns?.canBeAttackedAfter - now;
        if(cantBeAtt > 0) {
            chdCdEl.textContent = `Nemôže byť vyzvaný ešte ${formatCooldown(cantBeAtt)}`;
            ready = false;
        }
    } else ready = false;
    
    if(chalId === chdId && chalId !== '') {
        ready = false;
        chdCdEl.textContent = 'Rovnaký tím!';
    }
    
    btn.disabled = !ready;
}

document.getElementById('btn-start-battle').addEventListener('click', () => {
    const chalId = document.getElementById('challenger-select').value;
    const chdId = document.getElementById('challenged-select').value;
    
    battleState = {
        active: true,
        challenger: chalId,
        challenged: chdId,
        challengerPeople: dbTeams[chalId].stats['ľudia'] || 0,
        challengedPeople: dbTeams[chdId].stats['ľudia'] || 0,
        challengerRerollsUsed: 0,
        challengedRerollsUsed: 0,
        currentTurn: 'challenged', // Podľa zadania začína vyzvaný (challenged)
        currentStat: null
    };
    
    document.getElementById('battle-setup').classList.remove('active');
    document.getElementById('battle-arena').classList.add('active');
    
    updateBattleUI();
    generateBattleStat();
});

function updateBattleUI() {
    const cT = dbTeams[battleState.challenger];
    const dT = dbTeams[battleState.challenged];
    
    // Challenger Card
    const cCard = document.getElementById('arena-challenger');
    cCard.style.borderColor = cT.color;
    cCard.querySelector('.team-name').textContent = cT.name;
    cCard.querySelector('.people-count .count').textContent = battleState.challengerPeople;
    
    let cLuck = cT.stats['šťastie'] || 0;
    cCard.querySelector('.luck-count .count').textContent = `${cLuck - battleState.challengerRerollsUsed} / ${cLuck}`;
    
    // Challenged Card
    const dCard = document.getElementById('arena-challenged');
    dCard.style.borderColor = dT.color;
    dCard.querySelector('.team-name').textContent = dT.name;
    dCard.querySelector('.people-count .count').textContent = battleState.challengedPeople;
    
    let dLuck = dT.stats['šťastie'] || 0;
    dCard.querySelector('.luck-count .count').textContent = `${dLuck - battleState.challengedRerollsUsed} / ${dLuck}`;
    
    // Turn
    const turnEl = document.querySelector('#turn-indicator span');
    if(battleState.currentTurn === 'challenger') {
        turnEl.textContent = cT.name;
        turnEl.style.color = cT.color;
    } else {
        turnEl.textContent = dT.name;
        turnEl.style.color = dT.color;
    }
    
    // Buttons state
    const btnReroll = document.getElementById('btn-reroll-stat');
    let luckLeft = battleState.currentTurn === 'challenger' ? (cLuck - battleState.challengerRerollsUsed) : (dLuck - battleState.challengedRerollsUsed);
    btnReroll.disabled = luckLeft <= 0;
    
    // Comparison update if stat is active
    if(battleState.currentStat) {
        document.getElementById('generated-stat-name').textContent = battleState.currentStat;
        
        const cStatVal = cT.stats[battleState.currentStat] || 0;
        const dStatVal = dT.stats[battleState.currentStat] || 0;
        
        document.getElementById('stat-comparison').innerHTML = `
            <span style="color: ${cT.color}">${cStatVal}</span>
            <span>-</span>
            <span style="color: ${dT.color}">${dStatVal}</span>
        `;
        
        // Calculate casualties
        let diff = Math.abs(cStatVal - dStatVal);
        let sum = cStatVal + dStatVal;
        
        let cLoss = Math.ceil(sum / 5);
        let dLoss = Math.ceil(sum / 5);
        
        if(cStatVal < dStatVal) {
            cLoss += Math.ceil(diff / 2);
        } else if (dStatVal < cStatVal) {
            dLoss += Math.ceil(diff / 2);
        }
        
        document.getElementById('casualty-prediction').innerHTML = `
            Predikcia strát po prijatí statu:<br>
            <span style="color:${cT.color}">${cT.name} stratí ${cLoss} ľudí</span><br>
            <span style="color:${dT.color}">${dT.name} stratí ${dLoss} ľudí</span>
        `;
    }
}

function generateBattleStat() {
    const availableStats = ALL_STATS.filter(s => !BATTLE_EXCLUDED_STATS.includes(s));
    const randomStat = availableStats[Math.floor(Math.random() * availableStats.length)];
    battleState.currentStat = randomStat;
    updateBattleUI();
}

document.getElementById('btn-reroll-stat').addEventListener('click', () => {
    if(battleState.currentTurn === 'challenger') {
        battleState.challengerRerollsUsed++;
    } else {
        battleState.challengedRerollsUsed++;
    }
    // Užívateľ požadoval, aby "ak sa prehodí stat, stále je na ťahu ten istý."
    generateBattleStat();
});

document.getElementById('btn-next-round').addEventListener('click', () => {
    // Aplikovanie strát z aktuálneho statu
    const cT = dbTeams[battleState.challenger];
    const dT = dbTeams[battleState.challenged];
    const stat = battleState.currentStat;
    
    const cStatVal = cT.stats[stat] || 0;
    const dStatVal = dT.stats[stat] || 0;
    
    let diff = Math.abs(cStatVal - dStatVal);
    let sum = cStatVal + dStatVal;
    
    let cLoss = Math.ceil(sum / 5);
    let dLoss = Math.ceil(sum / 5);
    
    if(cStatVal < dStatVal) cLoss += Math.ceil(diff / 2);
    else if (dStatVal < cStatVal) dLoss += Math.ceil(diff / 2);
    
    battleState.challengerPeople = Math.max(0, battleState.challengerPeople - cLoss);
    battleState.challengedPeople = Math.max(0, battleState.challengedPeople - dLoss);
    
    if(battleState.challengerPeople === 0 && battleState.challengedPeople === 0) {
        handleBattleEnd('draw');
        return;
    } else if(battleState.challengerPeople === 0) {
        handleBattleEnd('challenger');
        return;
    } else if (battleState.challengedPeople === 0) {
        handleBattleEnd('challenged');
        return;
    }
    
    // Switch turn
    battleState.currentTurn = battleState.currentTurn === 'challenger' ? 'challenged' : 'challenger';
    generateBattleStat();
});

document.querySelectorAll('.btn-surrender').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const role = e.target.dataset.role; // 'challenger' alebo 'challenged'
        // Ak sa vzdá pred 0, strati polovicu zostavajucich ludi
        if(role === 'challenger') {
            battleState.challengerPeople = Math.floor(battleState.challengerPeople / 2);
        } else {
            battleState.challengedPeople = Math.floor(battleState.challengedPeople / 2);
        }
        handleBattleEnd(role);
    });
});

let finalBattleResult = {}; // Store results to apply later

function handleBattleEnd(loserRole) {
    document.getElementById('battle-arena').classList.remove('active');
    document.getElementById('battle-result').classList.add('active');
    
    const cT = dbTeams[battleState.challenger];
    const dT = dbTeams[battleState.challenged];

    if (loserRole === 'draw') {
        document.getElementById('battle-winner-text').textContent = `Remíza!`;
        document.getElementById('battle-winner-text').style.color = 'var(--text-main)';
        
        document.getElementById('battle-result-details').innerHTML = `
            Obom družinkám v rovnakom momente klesli ľudia na 0. Remíza!<br>
            Nemenia sa žiadne peniaze.<br><br>
            Konečný stav ľudí:<br>
            ${cT.name}: 0<br>
            ${dT.name}: 0
        `;
        
        finalBattleResult = {
            draw: true,
            cId: cT.id,
            cPeople: 0,
            dId: dT.id,
            dPeople: 0
        };
    } else {
        const winnerRole = loserRole === 'challenger' ? 'challenged' : 'challenger';
        const winnerTeam = winnerRole === 'challenger' ? cT : dT;
        const loserTeam = loserRole === 'challenger' ? cT : dT;
        
        document.getElementById('battle-winner-text').textContent = `Víťaz: ${winnerTeam.name}`;
        document.getElementById('battle-winner-text').style.color = winnerTeam.color;
        
        const lossPercent = dbSettings.moneyLossPercent || 25;
        const loserMoney = loserTeam.stats['peniaze'] || 0;
        const transferredMoney = Math.ceil(loserMoney * (lossPercent / 100));
        
        document.getElementById('battle-result-details').innerHTML = `
            Porazený (${loserTeam.name}) stratil ${transferredMoney} peňazí (${lossPercent}% z ${loserMoney}).<br>
            Víťaz získava ${transferredMoney} peňazí.<br><br>
            Konečný stav ľudí:<br>
            ${cT.name}: ${battleState.challengerPeople}<br>
            ${dT.name}: ${battleState.challengedPeople}
        `;
        
        finalBattleResult = {
            draw: false,
            winnerId: winnerTeam.id,
            loserId: loserTeam.id,
            transferredMoney: transferredMoney,
            cId: cT.id,
            cPeople: battleState.challengerPeople,
            dId: dT.id,
            dPeople: battleState.challengedPeople
        };
    }
}

document.getElementById('btn-end-battle').addEventListener('click', async () => {
    let updates = {};

    if (finalBattleResult.draw) {
        updates[`teams/${finalBattleResult.cId}/stats/ľudia`] = finalBattleResult.cPeople;
        updates[`teams/${finalBattleResult.dId}/stats/ľudia`] = finalBattleResult.dPeople;
    } else {
        // Apply changes to Firebase
        const { winnerId, loserId, transferredMoney, cId, cPeople, dId, dPeople } = finalBattleResult;
        
        // Money
        const wMoney = (dbTeams[winnerId].stats['peniaze'] || 0) + transferredMoney;
        const lMoney = Math.max(0, (dbTeams[loserId].stats['peniaze'] || 0) - transferredMoney);
        
        updates[`teams/${winnerId}/stats/peniaze`] = wMoney;
        updates[`teams/${loserId}/stats/peniaze`] = lMoney;
        
        // People
        updates[`teams/${cId}/stats/ľudia`] = cPeople;
        updates[`teams/${dId}/stats/ľudia`] = dPeople;
    }
    
    // Cooldowns
    const now = Date.now();
    const cds = dbSettings.cooldowns;
    
    const chalCantAttack = now + (cds.challenger.cantAttack * 60000);
    const chalCantBeAttacked = now + (cds.challenger.cantBeAttacked * 60000);
    const chdCantAttack = now + (cds.challenged.cantAttack * 60000);
    const chdCantBeAttacked = now + (cds.challenged.cantBeAttacked * 60000);
    
    // Apply cooldowns to specific roles in THIS battle
    updates[`teams/${battleState.challenger}/cooldowns/canAttackAfter`] = chalCantAttack;
    updates[`teams/${battleState.challenger}/cooldowns/canBeAttackedAfter`] = chalCantBeAttacked;
    
    updates[`teams/${battleState.challenged}/cooldowns/canAttackAfter`] = chdCantAttack;
    updates[`teams/${battleState.challenged}/cooldowns/canBeAttackedAfter`] = chdCantBeAttacked;
    
    await db.ref().update(updates);
    showToast('Výsledky súboja uložené!', 'success');
    
    // Reset battle view
    document.getElementById('battle-result').classList.remove('active');
    document.getElementById('battle-setup').classList.add('active');
    battleState.active = false;
    updateBattleSelectors();
});

// --- Toast Utility ---
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add('hiding');
        toast.addEventListener('animationend', () => toast.remove());
    }, 3000);
}
