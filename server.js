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
  if (!req.session.steamId) return res.status(401).json({ error: 'Não autenticado' });
  next();
;

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
  req.session.destroy(() => res.json({ ok: true }));
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
  const r = await pool.query(
    'SELECT * FROM inventory WHERE steam_id=$1 ORDER BY acquired_at DESC LIMIT 100',
    [req.session.steamId]
  );
  res.json({ items: r.rows });
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
  const { cases, playerCount } = req.body;
  if (!cases || !cases.length || !playerCount) return res.status(400).json({ error: 'Dados inválidos' });

  const totalValue = cases.reduce((s,c) => s+c.price, 0) * playerCount;
  const userCost = cases.reduce((s,c) => s+c.price, 0);

  const balance = await getBalance(req.session.steamId);
  if (balance < userCost) return res.status(400).json({ error: 'Saldo insuficiente' });

  const newBalance = await adjustBalance(req.session.steamId, -userCost);
  await logTransaction(req.session.steamId, 'battle_loss', -userCost, 'Entrada em batalha');

  // Create battle
  const battleRes = await pool.query(
    'INSERT INTO battles(player_count,cases_json,total_value,created_by,status) VALUES($1,$2,$3,$4,$5) RETURNING *',
    [playerCount, JSON.stringify(cases), totalValue, req.session.steamId, 'open']
  );
  const battle = battleRes.rows[0];

  // Add creator as slot 0
  await pool.query(
    'INSERT INTO battle_players(battle_id,steam_id,slot_index) VALUES($1,$2,$3)',
    [battle.id, req.session.steamId, 0]
  );

  req.session.user.balance = newBalance;
  res.json({ ok: true, battleId: battle.id, balance: newBalance });
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
      // Save skins to inventory
      for (const skin of r.skins) {
        await client.query(
          'INSERT INTO inventory(steam_id,item_name,item_img,item_value,wear,source) VALUES($1,$2,$3,$4,$5,$6)',
          [r.steamId, skin.name, skin.img, skin.val, skin.wear||'', 'battle']
        );
      }
    }

    // Credit winner
    await client.query('UPDATE users SET balance=balance+$1 WHERE steam_id=$2', [battle.total_value, winner.steamId]);
    await client.query('INSERT INTO transactions(steam_id,type,amount,description) VALUES($1,$2,$3,$4)',
      [winner.steamId,'battle_win', battle.total_value, 'Vitória na batalha #'+battleId]);

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

  // Roll item (weighted by rarity)
  const drops = CASE_DROPS[caseId] || CASE_DROPS['prisma'];
  const weights = [40, 25, 15, 10, 7, 3];
  const roll = Math.random() * 100;
  let acc = 0, itemIdx = 0;
  for (let i = 0; i < weights.length; i++) { acc += weights[i]; if (roll < acc) { itemIdx = i; break; } }
  const item = drops[Math.min(itemIdx, drops.length - 1)];

  const newBalance = await adjustBalance(req.session.steamId, -price);
  await logTransaction(req.session.steamId, 'case_open', -price, `Caixa: ${caseId}`);

  // Save to inventory (non-critical)
  try {
    await pool.query(
      'INSERT INTO inventory(steam_id,item_name,item_img,item_value,wear,source) VALUES($1,$2,$3,$4,$5,$6)',
      [req.session.steamId, item.name, item.img||'', item.val, item.wear||'', 'case_open']
    );
  } catch {}

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
const IMAGE_HASHES = {
  'cases/prisma':     'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_fr3cV6vT9avBvefWWDDGTxbZ14rhsTX7qkE90sDiHwt2pdC-TblJ2DsB1QPlK7Ee9riHKAA',
  'cases/revolution': 'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_frnAVvfb6aqduc_TFVjTCxbx05OU4S3jilE9w4DzRnImtIy2Sa1JzDJEhRPlK7EcO4U8gfA',
  'cases/fracture':   'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_fr3QV7aD7OP01IfbGDzPCmbsm4LU5GnvkzUsi4WvUmIqtci_CPQNyApsjE_lK7EfrhW545A',
  'cases/riptide':    'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_fr3sVtvD2O_Q9dqfEXTWSlepz4bA5THnikx915z6BytmuIHiXaAdyDpEhTflK7EdW-TaRMg',
  'cases/snakebite':  'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_fr3oVvvT4bfI4dvTLCGTCmLl16ec7TX_mk08k42iHwtqscy-WPVUmCZJ4R_lK7Ed8Q6OYtw',
  'cases/clutch':     'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_frHsVtqr8a_dsdKTAWDWVxLgjsrAwHSvgwEQk4m-ByYuqIC2eO1VyD5QiR_lK7EcxQQPYQA',
  'cases/spectrum2':  'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_frHoVu6D7PaA0JaDACjKUwOom47VrTSzrw0Vx4W_Sydz9JC7FZgckCZYjRPlK7EcPuDAQzw',
  'skins/ak47_asiimov':        '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujYbnWnBB0ucl93-rB_I20jlGx_kVlNjmkdI6LcFI4MlMkuA',
  'skins/awp_asiimov':         '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujYbnWn3lS5cB1g7jEp9-k2lLi_UdvZmimcdKRMlhkGYGV2w',
  'skins/ak47_fireserpent':    '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujNbCFnzpS5cB1hL_CoN_2ilDt_UJvYWilINeLMlhJ9XNgpw',
  'skins/deagle_blaze':        '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujNbCFnzpS5MB1i7mTpd6h0VK2_kI-ZWykd9KRMlhqMXGmEA',
  'skins/usps_printstream':    '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujNLnWm3lS5cB1g7fAo9_y3VDi_UY6ZWundYWXdlhiNfEHKg',
  'skins/m4a1s_printstream':   '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujNLnWm3lS5cB1g7fF9tWk3FDi_UY9YW6ndYWXcFhiNfEtYw',
  'skins/butterfly_fade':      '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujYbnWn3lS5cB1g7zHotyh3Fri_UVpZm6icddKXMlhBDPsHoA',
  'skins/p90_asiimov':         '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujYbnWn3lS5cB1g7TUo9mi2FDs-UVpYmincdKXMlhniPIFzw',
  'skins/ak47_bloodsport':     '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujNbCFnzpS5cB1i7-Bp4ms3lfi_kduZGqhd4-RMlhcjCR5tg',
  'skins/glock_fade':          '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujYbnWn3lS5cB1g7rFpYqijlHh-kc-Nj-nddeLMlhuMtfF4A',
  'skins/karambit_doppler':    '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujYbnWn3lS5cB1hLzAoNus3Fri_0VuMmrxdYSWdA1rjg7V-tA',
};

const imgMemCache = {};

app.get('/img/:type/:name', async (req, res) => {
  const key = `${req.params.type}/${req.params.name.replace('.png','')}`;
  const hash = IMAGE_HASHES[key];
  if (!hash) return res.status(404).send('');

  // Memory cache
  if (imgMemCache[key]) {
    res.set('Content-Type','image/png');res.set('Cache-Control','public,max-age=86400');
    return res.send(imgMemCache[key]);
  }

  // DB cache
  try {
    const cached = await pool.query('SELECT data,content_type FROM image_cache WHERE key=$1', [key]);
    if (cached.rows[0] && cached.rows[0].data) {
      const buf = Buffer.from(cached.rows[0].data);
      imgMemCache[key] = buf;
      res.set('Content-Type', cached.rows[0].content_type||'image/png');
      res.set('Cache-Control','public,max-age=86400');
      return res.send(buf);
    }
  } catch {}

  // Fetch from Steam
  try {
    const url = `https://steamcommunity-a.akamaihd.net/economy/image/${hash}/200fx200f`;
    const r = await axios.get(url, {
      responseType:'arraybuffer', timeout:10000,
      headers:{'User-Agent':'Mozilla/5.0','Referer':'https://steamcommunity.com'}
    });
    const buf = Buffer.from(r.data);
    const ct = r.headers['content-type']||'image/png';
    imgMemCache[key] = buf;
    // Save to DB
    pool.query('INSERT INTO image_cache(key,url,data,content_type) VALUES($1,$2,$3,$4) ON CONFLICT(key) DO UPDATE SET data=EXCLUDED.data,cached_at=NOW()',
      [key, url, buf, ct]).catch(()=>{});
    res.set('Content-Type',ct);res.set('Cache-Control','public,max-age=86400');
    res.send(buf);
  } catch (e) {
    res.status(502).send('');
  }
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
app.listen(PORT, async () => {
  await initDB();
  console.log(`\n🎮 DROPZONE v2 rodando em ${BASE}`);
  console.log(`   PostgreSQL: ${process.env.DATABASE_URL ? '✓' : '✗ DATABASE_URL não configurada'}`);
  console.log(`   Steam Key : ${STEAM_API_KEY ? '✓' : '✗ não configurada'}\n`);
});