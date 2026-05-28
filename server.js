require('dotenv').config();
const express     = require('express');
const session     = require('express-session');
const PgSession   = require('connect-pg-simple')(session);
const axios       = require('axios');
const path        = require('path');
const qs          = require('querystring');
const { pool, initDB } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;
const BASE = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const STEAM_API_KEY = process.env.STEAM_API_KEY || '';

// ── Middlewares ───────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const isProd = process.env.NODE_ENV === 'production';

app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dropzone_dev_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: isProd, sameSite: isProd ? 'none' : 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ── DB helper with fallback ────────────────────────────────────────────────────
const memBalances = {}; // in-memory fallback when DB is unavailable
const memInventory = {}; // platform inventory fallback when DB writes are unavailable

const HOUSE_BOT = {
  steamId: 'BOT_HOUSE',
  name: 'BOT DA CASA',
  avatar: '',
};
const onlineUsers = new Map();
const ONLINE_TTL_MS = 5 * 60 * 1000;

const RARITY_COLORS = {'ri-gray':'#888888','ri-blue':'#4D79FF','ri-purple':'#9B4DFF','ri-gold':'#FFD700'};

function normalizeInventoryItem(steamId, item, source = 'battle') {
  return {
    id: Date.now() + Math.floor(Math.random() * 100000),
    steam_id: steamId,
    item_name: item.item_name || item.name || 'Item',
    item_img: item.item_img || item.img || '',
    item_value: parseFloat(item.item_value ?? item.val ?? 0),
    rarity_color: item.rarity_color || RARITY_COLORS[item.cl] || '#888888',
    wear: item.wear || '',
    tradable: item.tradable !== false,
    source,
    acquired_at: new Date().toISOString(),
  };
}

async function addInventoryItem(steamId, item, source = 'battle', client = pool) {
  if (!steamId) return null;
  const invItem = normalizeInventoryItem(steamId, item, source);
  try {
    const r = await client.query(
      `INSERT INTO inventory(steam_id,item_name,item_img,item_value,rarity_color,wear,source)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, item_name, item_img, item_value, rarity_color, wear, tradable, source, acquired_at`,
      [steamId, invItem.item_name, invItem.item_img, invItem.item_value, invItem.rarity_color, invItem.wear, source]
    );
    return r.rows[0];
  } catch (e) {
    console.warn('DB inventory insert failed, using memory:', e.message);
    memInventory[steamId] = memInventory[steamId] || [];
    memInventory[steamId].unshift(invItem);
    return invItem;
  }
}

async function ensureHouseBot(client = pool) {
  await client.query(
    `INSERT INTO users (steam_id, name, avatar, balance)
     VALUES ($1,$2,$3,0)
     ON CONFLICT (steam_id) DO UPDATE SET name=EXCLUDED.name, avatar=EXCLUDED.avatar`,
    [HOUSE_BOT.steamId, HOUSE_BOT.name, HOUSE_BOT.avatar]
  );
}

async function getBalance(steamId) {
  try {
    const r = await pool.query('SELECT balance FROM users WHERE steam_id=$1', [steamId]);
    return r.rows[0] ? parseFloat(r.rows[0].balance) : (memBalances[steamId] || 500);
  } catch {
    return memBalances[steamId] || 500;
  }
}

async function adjustBalance(steamId, delta) {
  try {
    const r = await pool.query('UPDATE users SET balance=balance+$1 WHERE steam_id=$2 RETURNING balance', [delta, steamId]);
    if (r.rows[0]) {
      memBalances[steamId] = parseFloat(r.rows[0].balance);
      return memBalances[steamId];
    }
  } catch (e) {
    console.warn('DB balance update failed, using memory:', e.message);
  }
  // Memory fallback
  memBalances[steamId] = (memBalances[steamId] || 500) + delta;
  return memBalances[steamId];
}

async function logTransaction(steamId, type, amount, description) {
  try {
    await pool.query('INSERT INTO transactions(steam_id,type,amount,description) VALUES($1,$2,$3,$4)',
      [steamId, type, amount, description]);
  } catch {} // non-critical
}

const requireAuth = (req, res, next) => {
  if (!req.session.steamId) return res.status(401).json({ error: 'Não autenticado' });
  next();
};

function touchOnline(steamId) {
  if (steamId && steamId !== HOUSE_BOT.steamId) onlineUsers.set(steamId, Date.now());
}

function getOnlineCount() {
  const cutoff = Date.now() - ONLINE_TTL_MS;
  for (const [steamId, lastSeen] of onlineUsers) {
    if (lastSeen < cutoff) onlineUsers.delete(steamId);
  }
  return onlineUsers.size;
}

app.use((req, res, next) => {
  touchOnline(req.session?.steamId);
  next();
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEAM OPENID
// ═══════════════════════════════════════════════════════════════════════════════
const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const RETURN_URL   = `${BASE}/auth/steam/return`;

app.get('/auth/steam', (req, res) => {
  const params = {
    'openid.ns':         'http://specs.openid.net/auth/2.0',
    'openid.mode':       'checkid_setup',
    'openid.return_to':  RETURN_URL,
    'openid.realm':      BASE,
    'openid.identity':   'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  };
  res.redirect(`${STEAM_OPENID}?${qs.stringify(params)}`);
});

app.get('/auth/steam/return', async (req, res) => {
  const query = req.query;
  if (query['openid.mode'] !== 'id_res') return res.redirect('/?login_error=1');

  // Verify with Steam
  try {
    const verifyRes = await axios.post(STEAM_OPENID, qs.stringify({ ...query, 'openid.mode': 'check_authentication' }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000,
    });
    if (!verifyRes.data.includes('is_valid:true')) return res.redirect('/?login_error=1');
  } catch { return res.redirect('/?login_error=1'); }

  const steamIdMatch = (query['openid.claimed_id'] || '').match(/\/(\d{17,})$/);
  if (!steamIdMatch) return res.redirect('/?login_error=1');
  const steamId = steamIdMatch[1];

  try {
    // Fetch Steam profile
    const profileRes = await axios.get('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/', {
      params: { key: STEAM_API_KEY, steamids: steamId }, timeout: 8000
    });
    const player = profileRes.data?.response?.players?.[0];
    if (!player) return res.redirect('/?login_error=1');

    // Steam level
    let steamLevel = 0;
    try {
      const lvl = await axios.get('https://api.steampowered.com/IPlayerService/GetSteamLevel/v1/', {
        params: { key: STEAM_API_KEY, steamid: steamId }, timeout: 5000
      });
      steamLevel = lvl.data?.response?.player_level || 0;
    } catch {}

    // Recent games
    let recentGames = [];
    try {
      const games = await axios.get('https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/', {
        params: { key: STEAM_API_KEY, steamid: steamId, count: 3 }, timeout: 5000
      });
      recentGames = (games.data?.response?.games || []).map(g => ({
        name: g.name, playtime: Math.round((g.playtime_2weeks||0)/60)+'h', appid: g.appid
      }));
    } catch {}

    // CS2 Inventory
    let inventory = [];
    try {
      const invRes = await axios.get(`https://steamcommunity.com/inventory/${steamId}/730/2`, {
        params: { l: 'brazilian', count: 150 }, timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (invRes.data?.assets) inventory = parseInventory(invRes.data);
    } catch {}

    // Upsert user in DB
    const result = await pool.query(`
      INSERT INTO users (steam_id, name, avatar, profile_url, country_code, real_name, steam_level, last_login)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (steam_id) DO UPDATE SET
        name=EXCLUDED.name, avatar=EXCLUDED.avatar, profile_url=EXCLUDED.profile_url,
        country_code=EXCLUDED.country_code, real_name=EXCLUDED.real_name,
        steam_level=EXCLUDED.steam_level, last_login=NOW()
      RETURNING *`,
      [steamId, player.personaname, player.avatarfull||player.avatar,
       player.profileurl, player.loccountrycode||'', player.realname||'', steamLevel]
    );
    const dbUser = result.rows[0];

    req.session.steamId = steamId;
    req.session.user = {
      steamId, name: player.personaname,
      avatar: player.avatarfull||player.avatarmedium||player.avatar,
      profileUrl: player.profileurl, countryCode: player.loccountrycode||'',
      realName: player.realname||'', steamLevel, recentGames,
      steamInventory: inventory, balance: parseFloat(dbUser.balance),
      tradeLink: dbUser.trade_link||'',
    };
    touchOnline(steamId);

    console.log(`✓ Login: ${player.personaname} (${steamId})`);
    res.redirect('/?welcome=1');
  } catch (e) {
    console.error('Erro login Steam:', e.message);
    res.redirect('/?login_error=1');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API — USUÁRIO
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/me', async (req, res) => {
  if (!req.session.steamId) return res.json({ loggedIn: false });
  touchOnline(req.session.steamId);
  const balance = await getBalance(req.session.steamId);
  req.session.user.balance = balance;
  memBalances[req.session.steamId] = balance;
  try {
    const r = await pool.query('SELECT trade_link FROM users WHERE steam_id=$1', [req.session.steamId]);
    if (r.rows[0]) req.session.user.tradeLink = r.rows[0].trade_link||'';
  } catch {}
  res.json({ loggedIn: true, user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  if (req.session.steamId) onlineUsers.delete(req.session.steamId);
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/online', (req, res) => {
  touchOnline(req.session?.steamId);
  res.json({ online: getOnlineCount() });
});

app.post('/api/tradelink', requireAuth, async (req, res) => {
  const { tradeLink } = req.body;
  if (!tradeLink || !tradeLink.includes('steamcommunity.com/tradeoffer'))
    return res.status(400).json({ error: 'Trade link inválido' });
  await pool.query('UPDATE users SET trade_link=$1 WHERE steam_id=$2', [tradeLink, req.session.steamId]);
  req.session.user.tradeLink = tradeLink;
  res.json({ ok: true });
});

app.post('/api/deposit', requireAuth, async (req, res) => {
  const amount = parseFloat(req.body.amount);
  if (!amount || amount < 10) return res.status(400).json({ error: 'Valor mínimo R$10' });
  const newBalance = await adjustBalance(req.session.steamId, amount);
  await logTransaction(req.session.steamId, 'deposit', amount, 'Depósito');
  req.session.user.balance = newBalance;
  res.json({ ok: true, balance: newBalance });
});

// ── Inventário do usuário na plataforma
app.get('/api/inventory', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, item_name, item_img, item_value, rarity_color, wear, tradable, source,
              acquired_at
       FROM inventory WHERE steam_id=$1 ORDER BY acquired_at DESC LIMIT 200`,
      [req.session.steamId]
    );
    res.json({ items: r.rows });
  } catch(e) {
    const items = (memInventory[req.session.steamId] || []).slice(0, 200);
    res.json({ items });
  }
});

// ── Histórico
app.get('/api/history', requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT b.id, b.status, b.total_value, b.created_at, b.winner_steam_id,
           bp.total_won, bp.skins_json
    FROM battle_players bp
    JOIN battles b ON b.id=bp.battle_id
    WHERE bp.steam_id=$1
    ORDER BY b.created_at DESC LIMIT 50`,
    [req.session.steamId]
  );
  res.json({ history: r.rows });
});

// ═══════════════════════════════════════════════════════════════════════════════
// API — BATALHAS
// ═══════════════════════════════════════════════════════════════════════════════

// Listar batalhas
app.get('/api/battles', async (req, res) => {
  const r = await pool.query(`
    SELECT b.*,
      json_agg(json_build_object(
        'steam_id', bp.steam_id, 'slot_index', bp.slot_index,
        'total_won', bp.total_won,
        'name', u.name, 'avatar', u.avatar
      ) ORDER BY bp.slot_index) as players
    FROM battles b
    LEFT JOIN battle_players bp ON bp.battle_id=b.id
    LEFT JOIN users u ON u.steam_id=bp.steam_id
    WHERE b.created_at > NOW() - INTERVAL '2 hours'
    GROUP BY b.id
    ORDER BY b.created_at DESC
    LIMIT 30`);
  res.json({ battles: r.rows });
});

// Criar batalha
app.post('/api/battles', requireAuth, async (req, res) => {
  const { cases } = req.body;
  const botMode = req.body.botMode === true || req.body.botMode === 'true';
  let playerCount = parseInt(req.body.playerCount, 10);
  if (botMode) playerCount = 2;
  if (!cases || !cases.length || !playerCount || playerCount < 2 || playerCount > 4)
    return res.status(400).json({ error: 'Dados inválidos' });

  const totalValue = cases.reduce((s,c) => s+c.price, 0) * playerCount;
  const userCost = cases.reduce((s,c) => s+c.price, 0);

  const balance = await getBalance(req.session.steamId);
  if (balance < userCost) return res.status(400).json({ error: 'Saldo insuficiente' });

  const newBalance = await adjustBalance(req.session.steamId, -userCost);
  await logTransaction(req.session.steamId, 'battle_loss', -userCost, 'Entrada em batalha');

  if (botMode) await ensureHouseBot();

  // Create battle
  const battleRes = await pool.query(
    'INSERT INTO battles(player_count,cases_json,total_value,created_by,status) VALUES($1,$2,$3,$4,$5) RETURNING *',
    [playerCount, JSON.stringify(cases), totalValue, req.session.steamId, botMode ? 'live' : 'open']
  );
  const battle = battleRes.rows[0];

  // Add creator as slot 0
  await pool.query(
    'INSERT INTO battle_players(battle_id,steam_id,slot_index) VALUES($1,$2,$3)',
    [battle.id, req.session.steamId, 0]
  );

  if (botMode) {
    await pool.query(
      'INSERT INTO battle_players(battle_id,steam_id,slot_index) VALUES($1,$2,$3)',
      [battle.id, HOUSE_BOT.steamId, 1]
    );
  }

  req.session.user.balance = newBalance;
  res.json({ ok: true, battleId: battle.id, balance: newBalance, status: battle.status, botMode: !!botMode });
});

// Entrar em batalha
app.post('/api/battles/:id/join', requireAuth, async (req, res) => {
  const battleId = parseInt(req.params.id);
  const steamId = req.session.steamId;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const battleRes = await client.query('SELECT * FROM battles WHERE id=$1 FOR UPDATE', [battleId]);
    const battle = battleRes.rows[0];
    if (!battle || battle.status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Batalha não disponível' });
    }

    // Check if already in
    const alreadyIn = await client.query('SELECT 1 FROM battle_players WHERE battle_id=$1 AND steam_id=$2', [battleId, steamId]);
    if (alreadyIn.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Já está nesta batalha' }); }

    // Find next open slot
    const slots = await client.query('SELECT slot_index FROM battle_players WHERE battle_id=$1', [battleId]);
    const usedSlots = slots.rows.map(r => r.slot_index);
    let nextSlot = -1;
    for (let i=0; i<battle.player_count; i++) { if (!usedSlots.includes(i)) { nextSlot=i; break; } }
    if (nextSlot < 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Batalha cheia' }); }

    // Cost = cases total / playerCount (each player pays their share)
    const cases = battle.cases_json;
    const userCost = cases.reduce((s,c) => s+c.price, 0);

    const balRes = await client.query('SELECT balance FROM users WHERE steam_id=$1 FOR UPDATE', [steamId]);
    const balance = parseFloat(balRes.rows[0]?.balance || memBalances[steamId] || 0);
    if (balance < userCost) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Saldo insuficiente' }); }

    await client.query('UPDATE users SET balance=balance-$1 WHERE steam_id=$2', [userCost, steamId]);
    await client.query('INSERT INTO battle_players(battle_id,steam_id,slot_index) VALUES($1,$2,$3)', [battleId, steamId, nextSlot]);
    await logTransaction(steamId, 'battle_loss', -userCost, 'Entrada em batalha #'+battleId);

    // Check if full → start
    const newCount = usedSlots.length + 1;
    if (newCount >= battle.player_count) {
      await client.query("UPDATE battles SET status='live' WHERE id=$1", [battleId]);
    }

    await client.query('COMMIT');
    memBalances[steamId] = balance - userCost;
    req.session.user.balance = memBalances[steamId];
    res.json({ ok: true, slot: nextSlot, balance: memBalances[steamId] });
  } catch(e) {
    await client.query('ROLLBACK');
    console.error('Join battle error:', e.message);
    res.status(500).json({ error: 'Erro interno' });
  } finally { client.release(); }
});

// Finalizar batalha (salvar resultado)
app.post('/api/battles/:id/finish', requireAuth, async (req, res) => {
  const battleId = parseInt(req.params.id);
  const { results } = req.body; // [{steamId, skins, totalWon}]
  if (!results) return res.status(400).json({ error: 'Sem resultados' });

  const battleRes = await pool.query('SELECT * FROM battles WHERE id=$1', [battleId]);
  const battle = battleRes.rows[0];
  if (!battle || battle.status === 'done') return res.status(400).json({ error: 'Batalha já finalizada' });

  // Find winner
  let winner = results[0];
  results.forEach(r => { if (r.totalWon > winner.totalWon) winner = r; });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update battle
    await client.query(
      "UPDATE battles SET status='done', winner_steam_id=$1, finished_at=NOW() WHERE id=$2",
      [winner.steamId, battleId]
    );

    // Update each player's result
    for (const r of results) {
      await client.query(
        'UPDATE battle_players SET skins_json=$1, total_won=$2 WHERE battle_id=$3 AND steam_id=$4',
        [JSON.stringify(r.skins), r.totalWon, battleId, r.steamId]
      );
    }

    // Winner takes all rolled skins in a case battle.
    const prizeSkins = results.flatMap(r => r.skins || []);
    for (const skin of prizeSkins) {
      await addInventoryItem(winner.steamId, skin, 'battle', client);
    }

    // Credit winner
    if (winner.steamId !== HOUSE_BOT.steamId) {
      await client.query('UPDATE users SET balance=balance+$1 WHERE steam_id=$2', [battle.total_value, winner.steamId]);
      await client.query('INSERT INTO transactions(steam_id,type,amount,description) VALUES($1,$2,$3,$4)',
        [winner.steamId,'battle_win', battle.total_value, 'Vitória na batalha #'+battleId]);
    }

    await client.query('COMMIT');
    res.json({ ok: true, winner: winner.steamId });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API — ABRIR CAIXA (solo)
// ═══════════════════════════════════════════════════════════════════════════════
const CASE_DROPS = {
  'prisma':     [
    {name:'AK-47 | Uncharted',val:8,wear:'Field-Tested',cl:'ri-gray',img:'/img/skins/ak47_bloodsport.png'},
    {name:'USP-S | Cortex',val:12,wear:'Minimal Wear',cl:'ri-blue',img:'/img/skins/usps_printstream.png'},
    {name:'M4A1-S | Decimator',val:18,wear:'Factory New',cl:'ri-blue',img:'/img/skins/m4a1s_printstream.png'},
    {name:'Glock-18 | Warhawk',val:35,wear:'Factory New',cl:'ri-purple',img:'/img/skins/glock_fade.png'},
    {name:'AK-47 | Neon Rider',val:95,wear:'Factory New',cl:'ri-purple',img:'/img/skins/ak47_asiimov.png'},
    {name:'M4A1-S | Nightmare',val:180,wear:'Factory New',cl:'ri-gold',img:'/img/skins/m4a1s_printstream.png'},
  ],
  'revolution': [
    {name:'AK-47 | Slate',val:15,wear:'Field-Tested',cl:'ri-gray',img:'/img/skins/ak47_bloodsport.png'},
    {name:'USP-S | Jawbreaker',val:20,wear:'Minimal Wear',cl:'ri-blue',img:'/img/skins/usps_printstream.png'},
    {name:'M4A4 | Temukau',val:45,wear:'Factory New',cl:'ri-blue',img:'/img/skins/m4a1s_printstream.png'},
    {name:'AWP | Duality',val:90,wear:'Factory New',cl:'ri-purple',img:'/img/skins/awp_asiimov.png'},
    {name:'AK-47 | Inheritance',val:210,wear:'Factory New',cl:'ri-purple',img:'/img/skins/ak47_asiimov.png'},
    {name:'M4A1-S | Blackwater',val:450,wear:'Factory New',cl:'ri-gold',img:'/img/skins/butterfly_fade.png'},
  ],
  'dreams':     [
    {name:'MP9 | Starlight Protector',val:12,wear:'Field-Tested',cl:'ri-gray',img:'/img/skins/p90_asiimov.png'},
    {name:'MAC-10 | Light Box',val:18,wear:'Minimal Wear',cl:'ri-blue',img:'/img/skins/ak47_bloodsport.png'},
    {name:'P90 | Neoqueen',val:30,wear:'Factory New',cl:'ri-blue',img:'/img/skins/p90_asiimov.png'},
    {name:'AK-47 | Head Shot',val:65,wear:'Factory New',cl:'ri-purple',img:'/img/skins/ak47_asiimov.png'},
    {name:'USP-S | The Traitor',val:140,wear:'Factory New',cl:'ri-purple',img:'/img/skins/usps_printstream.png'},
    {name:'M4A1-S | Illusion',val:380,wear:'Factory New',cl:'ri-gold',img:'/img/skins/butterfly_fade.png'},
  ],
  'fracture':   [
    {name:'PP-Bizon | Runic',val:8,wear:'Field-Tested',cl:'ri-gray',img:'/img/skins/p90_asiimov.png'},
    {name:'Five-SeveN | Fairy Tale',val:14,wear:'Minimal Wear',cl:'ri-blue',img:'/img/skins/glock_fade.png'},
    {name:'AK-47 | Legion of Anubis',val:40,wear:'Factory New',cl:'ri-blue',img:'/img/skins/ak47_bloodsport.png'},
    {name:'M4A1-S | Printstream',val:185,wear:'Factory New',cl:'ri-purple',img:'/img/skins/m4a1s_printstream.png'},
    {name:'Desert Eagle | Printstream',val:220,wear:'Factory New',cl:'ri-purple',img:'/img/skins/deagle_blaze.png'},
    {name:'Glock-18 | Vogue',val:95,wear:'Factory New',cl:'ri-gold',img:'/img/skins/glock_fade.png'},
  ],
  'riptide':    [
    {name:'Glock-18 | Winterized',val:10,wear:'Field-Tested',cl:'ri-gray',img:'/img/skins/glock_fade.png'},
    {name:'MP9 | Hydra',val:16,wear:'Minimal Wear',cl:'ri-blue',img:'/img/skins/p90_asiimov.png'},
    {name:'AK-47 | Aquamarine Revenge',val:55,wear:'Factory New',cl:'ri-blue',img:'/img/skins/ak47_bloodsport.png'},
    {name:'AWP | Aquamarine Revenge',val:85,wear:'Factory New',cl:'ri-purple',img:'/img/skins/awp_asiimov.png'},
    {name:'M4A1-S | Imminent Danger',val:130,wear:'Factory New',cl:'ri-purple',img:'/img/skins/m4a1s_printstream.png'},
    {name:'Karambit | Doppler',val:900,wear:'Factory New',cl:'ri-gold',img:'/img/skins/karambit_doppler.png'},
  ],
  'snakebite':  [
    {name:'CZ75-Auto | Vendetta',val:9,wear:'Field-Tested',cl:'ri-gray',img:'/img/skins/glock_fade.png'},
    {name:'AK-47 | Slate',val:14,wear:'Minimal Wear',cl:'ri-blue',img:'/img/skins/ak47_bloodsport.png'},
    {name:'M4A1-S | Dirt Drop',val:22,wear:'Factory New',cl:'ri-blue',img:'/img/skins/m4a1s_printstream.png'},
    {name:'Ursus Knife | Doppler',val:180,wear:'Factory New',cl:'ri-purple',img:'/img/skins/karambit_doppler.png'},
    {name:'Skeleton Knife | Safari Mesh',val:250,wear:'Factory New',cl:'ri-purple',img:'/img/skins/butterfly_fade.png'},
    {name:'Talon Knife | Fade',val:700,wear:'Factory New',cl:'ri-gold',img:'/img/skins/butterfly_fade.png'},
  ],
  'clutch':     [
    {name:'M4A4 | Neo-Noir',val:22,wear:'Field-Tested',cl:'ri-gray',img:'/img/skins/m4a1s_printstream.png'},
    {name:'AK-47 | Neon Rider',val:85,wear:'Minimal Wear',cl:'ri-blue',img:'/img/skins/ak47_asiimov.png'},
    {name:'AWP | Hyper Beast',val:110,wear:'Factory New',cl:'ri-blue',img:'/img/skins/awp_asiimov.png'},
    {name:'M4A1-S | Nightmare',val:175,wear:'Factory New',cl:'ri-purple',img:'/img/skins/m4a1s_printstream.png'},
    {name:'USP-S | Caiman',val:28,wear:'Factory New',cl:'ri-purple',img:'/img/skins/usps_printstream.png'},
    {name:'Butterfly Knife | Fade',val:1200,wear:'Factory New',cl:'ri-gold',img:'/img/skins/butterfly_fade.png'},
  ],
  'spectrum2':  [
    {name:'AK-47 | Bloodsport',val:45,wear:'Field-Tested',cl:'ri-gray',img:'/img/skins/ak47_bloodsport.png'},
    {name:'Glock-18 | Twilight Galaxy',val:30,wear:'Minimal Wear',cl:'ri-blue',img:'/img/skins/glock_fade.png'},
    {name:'M4A4 | Neo-Noir',val:68,wear:'Factory New',cl:'ri-blue',img:'/img/skins/m4a1s_printstream.png'},
    {name:'AWP | Fever Dream',val:120,wear:'Factory New',cl:'ri-purple',img:'/img/skins/awp_asiimov.png'},
    {name:'M4A4 | Neo-Noir FN',val:200,wear:'Factory New',cl:'ri-purple',img:'/img/skins/m4a1s_printstream.png'},
    {name:'Butterfly Knife | Crimson Web',val:850,wear:'Factory New',cl:'ri-gold',img:'/img/skins/butterfly_fade.png'},
  ],
};

app.post('/api/cases/:caseId/open', requireAuth, async (req, res) => {
  const caseId = req.params.caseId;
  const CASES_PRICES = {prisma:8.90,revolution:25.50,dreams:41.20,fracture:18.70,riptide:33.00,snakebite:12.40,clutch:7.60,spectrum2:55.00};
  const price = CASES_PRICES[caseId];
  if (!price) return res.status(400).json({ error: 'Caixa inválida' });

  const balance = await getBalance(req.session.steamId);
  if (balance < price) return res.status(400).json({ error: 'Saldo insuficiente' });

  // ── Fair weighted probability by rarity ──────────────────────────────────
  // Mil-Spec(gray) 40% | Restricted(blue) 25% | Classified(purple) 15% | Covert(gold) 10%
  // With "StatTrak" bonus chance 5% and knife 5%
  const drops = CASE_DROPS[caseId] || CASE_DROPS['prisma'];
  
  // Group by rarity
  const byRarity = {
    'ri-gray':   drops.filter(d=>d.cl==='ri-gray'),
    'ri-blue':   drops.filter(d=>d.cl==='ri-blue'),
    'ri-purple': drops.filter(d=>d.cl==='ri-purple'),
    'ri-gold':   drops.filter(d=>d.cl==='ri-gold'),
  };
  
  // Weighted roll
  const roll = Math.random() * 100;
  let rarity;
  if      (roll < 40) rarity = 'ri-gray';
  else if (roll < 65) rarity = 'ri-blue';
  else if (roll < 80) rarity = 'ri-purple';
  else                rarity = 'ri-gold';
  
  const pool = byRarity[rarity];
  const item = pool && pool.length > 0 
    ? pool[Math.floor(Math.random() * pool.length)]
    : drops[Math.floor(Math.random() * drops.length)];

  const newBalance = await adjustBalance(req.session.steamId, -price);
  await logTransaction(req.session.steamId, 'case_open', -price, `Caixa: ${caseId}`);

  await addInventoryItem(req.session.steamId, item, 'case_open');

  req.session.user.balance = newBalance;
  res.json({ ok: true, item, balance: newBalance });
});

// ═══════════════════════════════════════════════════════════════════════════════
// API — INVENTÁRIO REFRESH STEAM
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/steam-inventory', requireAuth, async (req, res) => {
  const steamId = req.session.steamId;
  try {
    const invRes = await axios.get(`https://steamcommunity.com/inventory/${steamId}/730/2`, {
      params: { l: 'brazilian', count: 200 }, timeout: 12000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!invRes.data?.assets) return res.json({ items: [], error: 'Inventário privado' });
    const items = parseInventory(invRes.data);
    req.session.user.steamInventory = items;
    res.json({ items });
  } catch { res.json({ items: [], error: 'Inventário privado ou inacessível' }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// IMAGENS — proxy com cache no DB
// ═══════════════════════════════════════════════════════════════════════════════
const fs_module = require('fs');
const imgMemCache = {};

app.get('/img/:type/:name', async (req, res) => {
  const key = `${req.params.type}/${req.params.name.replace('.png','')}`;
  const diskPath = path.join(__dirname, 'public', 'img', req.params.type, req.params.name.replace('.png','') + '.png');

  // 1. Disk (fastest)
  if (fs_module.existsSync(diskPath) && fs_module.statSync(diskPath).size > 500) {
    res.set('Cache-Control','public,max-age=86400');
    return res.sendFile(diskPath);
  }

  // 2. Memory cache
  if (imgMemCache[key]) {
    res.set('Content-Type','image/png');res.set('Cache-Control','public,max-age=86400');
    return res.send(imgMemCache[key]);
  }

  // 3. DB cache → restore to disk
  try {
    const cached = await pool.query('SELECT data,content_type FROM image_cache WHERE key=$1', [key]);
    if (cached.rows[0]?.data && cached.rows[0].data.length > 500) {
      const buf = Buffer.from(cached.rows[0].data);
      imgMemCache[key] = buf;
      fs_module.mkdirSync(path.dirname(diskPath), {recursive:true});
      fs_module.writeFileSync(diskPath, buf);
      res.set('Content-Type', cached.rows[0].content_type||'image/png');
      res.set('Cache-Control','public,max-age=86400');
      return res.send(buf);
    }
  } catch {}

  // 4. Try to download now (case or skin)
  const caseHash = CASE_HASHES[key];
  if (caseHash) {
    try {
      const url = `https://steamcommunity-a.akamaihd.net/economy/image/${caseHash}/200fx200f`;
      const r = await axios.get(url, { responseType:'arraybuffer', timeout:10000, headers:{'User-Agent':'Mozilla/5.0','Referer':'https://steamcommunity.com'} });
      const buf = Buffer.from(r.data);
      if (buf.length > 500) {
        imgMemCache[key] = buf;
        fs_module.mkdirSync(path.dirname(diskPath), {recursive:true});
        fs_module.writeFileSync(diskPath, buf);
        pool.query('INSERT INTO image_cache(key,url,data,content_type) VALUES($1,$2,$3,$4) ON CONFLICT(key) DO UPDATE SET data=EXCLUDED.data,cached_at=NOW()', [key,'',buf,'image/png']).catch(()=>{});
        res.set('Content-Type','image/png');res.set('Cache-Control','public,max-age=86400');
        return res.send(buf);
      }
    } catch {}
  }

  // For skins, redirect to a known working skin as fallback
  return res.redirect('/img/skins/ak47_bloodsport.png');
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseInventory(json) {
  if (!json?.assets || !json?.descriptions) return [];
  const descMap = {};
  json.descriptions.forEach(d => { descMap[`${d.classid}_${d.instanceid}`] = d; });
  return json.assets.slice(0,100).map(asset => {
    const desc = descMap[`${asset.classid}_${asset.instanceid}`] || {};
    const tags = desc.tags || [];
    const getTag = cat => tags.find(t => t.category===cat);
    return {
      name: desc.market_name||desc.name||'Item',
      iconUrl: desc.icon_url ? `https://community.akamai.steamstatic.com/economy/image/${desc.icon_url}/96fx96f` : null,
      rarityColor: desc.name_color ? `#${desc.name_color}` : '#666',
      rarity: getTag('Rarity')?.localized_tag_name||'',
      type: getTag('Type')?.localized_tag_name||'',
      exterior: getTag('Exterior')?.localized_tag_name||'',
      tradable: desc.tradable===1, marketable: desc.marketable===1,
    };
  }).filter(i=>i.name&&i.name!=='Item');
}

// ── Fallback ──────────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname,'public','index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP — Auto-download/restore images
// ═══════════════════════════════════════════════════════════════════════════════
const CASE_HASHES = {
  'cases/prisma':    'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_fr3cV6vT9avBvefWWDDGTxbZ14rhsTX7qkE90sDiHwt2pdC-TblJ2DsB1QPlK7Ee9riHKAA',
  'cases/revolution':'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_frnAVvfb6aqduc_TFVjTCxbx05OU4S3jilE9w4DzRnImtIy2Sa1JzDJEhRPlK7EcO4U8gfA',
  'cases/dreams':    'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_frnIV7Kb5OaU-JqfHDzXFle0u4LY8Gy_kkRgisGzcm4v4J3vDOAQmDMdyRvlK7EcmeCU3yw',
  'cases/fracture':  'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_fr3QV7aD7OP01IfbGDzPCmbsm4LU5GnvkzUsi4WvUmIqtci_CPQNyApsjE_lK7EfrhW545A',
  'cases/riptide':   'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_fr3sVtvD2O_Q9dqfEXTWSlepz4bA5THnikx915z6BytmuIHiXaAdyDpEhTflK7EdW-TaRMg',
  'cases/snakebite': 'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_fr3oVvvT4bfI4dvTLCGTCmLl16ec7TX_mk08k42iHwtqscy-WPVUmCZJ4R_lK7Ed8Q6OYtw',
  'cases/clutch':    'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_frHsVtqr8a_dsdKTAWDWVxLgjsrAwHSvgwEQk4m-ByYuqIC2eO1VyD5QiR_lK7EcxQQPYQA',
  'cases/spectrum2': 'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_frHoVu6D7PaA0JaDACjKUwOom47VrTSzrw0Vx4W_Sydz9JC7FZgckCZYjRPlK7EcPuDAQzw',
};

const SKIN_QUERIES = [
  ['skins/ak47_asiimov',        'AK-47 | Asiimov (Field-Tested)'],
  ['skins/awp_asiimov',         'AWP | Asiimov (Field-Tested)'],
  ['skins/m4a1s_printstream',   'M4A1-S | Printstream (Factory New)'],
  ['skins/usps_printstream',    'USP-S | Printstream (Factory New)'],
  ['skins/ak47_bloodsport',     'AK-47 | Bloodsport (Factory New)'],
  ['skins/p90_asiimov',         'P90 | Asiimov (Field-Tested)'],
  ['skins/butterfly_fade',      'Butterfly Knife | Fade (Factory New)'],
  ['skins/glock_fade',          'Glock-18 | Fade (Factory New)'],
  ['skins/deagle_blaze',        'Desert Eagle | Blaze (Factory New)'],
  ['skins/karambit_doppler',    'Karambit | Doppler (Factory New)'],
  ['skins/ak47_fireserpent',    'AK-47 | Fire Serpent (Field-Tested)'],
  ['skins/awp_medusa',          'AWP | Medusa (Field-Tested)'],
  ['skins/m4a4_howl',           'M4A4 | Howl (Field-Tested)'],
  ['skins/fiveseven_hyperbeast','Five-SeveN | Hyper Beast (Factory New)'],
  ['skins/glock_waterelemental','Glock-18 | Water Elemental (Factory New)'],
  ['skins/m4a1s_nightmare',     'M4A1-S | Nightmare (Factory New)'],
  ['skins/awp_hyperbeast',      'AWP | Hyper Beast (Factory New)'],
  ['skins/ak47_neonrider',      'AK-47 | Neon Rider (Factory New)'],
  ['skins/m4a4_neonoir',        'M4A4 | Neo-Noir (Factory New)'],
  ['skins/usp_caiman',          'USP-S | Caiman (Factory New)'],
];

async function ensureImages() {
  const HDR = { 'User-Agent':'Mozilla/5.0','Referer':'https://steamcommunity.com/market/' };
  let restored = 0, downloaded = 0, skipped = 0;

  async function saveImg(key, buf, ct) {
    const diskPath = path.join(__dirname, 'public', 'img', key + '.png');
    fs_module.mkdirSync(path.dirname(diskPath), { recursive: true });
    fs_module.writeFileSync(diskPath, buf);
    // Save to DB for persistence across restarts
    try {
      await pool.query(
        `INSERT INTO image_cache(key,url,data,content_type) VALUES($1,$2,$3,$4)
         ON CONFLICT(key) DO UPDATE SET data=EXCLUDED.data, cached_at=NOW()`,
        [key, '', buf, ct || 'image/png']
      );
    } catch {}
  }

  async function fetchFromSteam(hash) {
    const url = `https://steamcommunity-a.akamaihd.net/economy/image/${hash}/200fx200f`;
    const r = await axios.get(url, { responseType:'arraybuffer', timeout:12000, headers: HDR });
    if (r.data.byteLength < 500) throw new Error('empty');
    return Buffer.from(r.data);
  }

  // Process cases (known hashes)
  for (const [key, hash] of Object.entries(CASE_HASHES)) {
    const diskPath = path.join(__dirname, 'public', 'img', key + '.png');
    if (fs_module.existsSync(diskPath) && fs_module.statSync(diskPath).size > 500) { skipped++; continue; }
    // Try DB first
    try {
      const row = await pool.query('SELECT data FROM image_cache WHERE key=$1', [key]);
      if (row.rows[0]?.data) {
        const buf = Buffer.from(row.rows[0].data);
        fs_module.mkdirSync(path.dirname(diskPath), { recursive: true });
        fs_module.writeFileSync(diskPath, buf);
        restored++; continue;
      }
    } catch {}
    // Download from Steam
    try {
      const buf = await fetchFromSteam(hash);
      await saveImg(key, buf, 'image/png');
      downloaded++;
    } catch(e) { console.warn(`img fail ${key}: ${e.message}`); }
  }

  // Process skins (need to search Steam Market for hash)
  for (const [key, query] of SKIN_QUERIES) {
    const diskPath = path.join(__dirname, 'public', 'img', key + '.png');
    if (fs_module.existsSync(diskPath) && fs_module.statSync(diskPath).size > 500) { skipped++; continue; }
    // Try DB first
    try {
      const row = await pool.query('SELECT data FROM image_cache WHERE key=$1', [key]);
      if (row.rows[0]?.data) {
        const buf = Buffer.from(row.rows[0].data);
        fs_module.mkdirSync(path.dirname(diskPath), { recursive: true });
        fs_module.writeFileSync(diskPath, buf);
        restored++; continue;
      }
    } catch {}
    // Search Steam Market for hash then download
    try {
      await new Promise(r => setTimeout(r, 300));
      const searchRes = await axios.get('https://steamcommunity.com/market/search/render/', {
        params: { query, appid: 730, count: 1, norender: 1 },
        headers: HDR, timeout: 10000,
      });
      const item = searchRes.data?.results?.[0];
      if (!item?.asset_description?.icon_url) throw new Error('not found');
      const buf = await fetchFromSteam(item.asset_description.icon_url);
      await saveImg(key, buf, 'image/png');
      downloaded++;
    } catch(e) { console.warn(`skin fail ${key}: ${e.message}`); }
  }

  if (downloaded > 0 || restored > 0)
    console.log(`✓ Images: ${skipped} skip, ${restored} restored from DB, ${downloaded} downloaded`);
}

app.listen(PORT, async () => {
  await initDB();
  // Restore/download images in background (non-blocking)
  ensureImages().catch(e => console.warn('ensureImages error:', e.message));
  console.log(`\n🎮 DROPZONE v2 rodando em ${BASE}`);
  console.log(`   PostgreSQL: ${process.env.DATABASE_URL ? '✓' : '✗ DATABASE_URL não configurada'}`);
  console.log(`   Steam Key : ${STEAM_API_KEY ? '✓' : '✗ não configurada'}\n`);
});
