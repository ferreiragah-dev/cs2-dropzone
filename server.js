require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const axios    = require('axios');
const https    = require('https');
const path     = require('path');
const qs       = require('querystring');

const app  = express();
const PORT = process.env.PORT || 3000;
const BASE = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const STEAM_API_KEY = process.env.STEAM_API_KEY || '';

// ── Middlewares ───────────────────────────────────────────────────────────────
// Necessário para funcionar atrás do proxy reverso do Easypanel/Nginx
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const isProd = process.env.NODE_ENV === 'production';

app.use(session({
  secret: process.env.SESSION_SECRET || 'dropzone_dev_secret_mude_isso',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: isProd, sameSite: isProd ? 'none' : 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ═══════════════════════════════════════════════════════════════════════════════
// STEAM OPENID — implementação manual (sem pacote externo)
// Spec: https://openid.net/specs/openid-authentication-2_0.html
// ═══════════════════════════════════════════════════════════════════════════════

const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const RETURN_URL   = `${BASE}/auth/steam/return`;
const REALM        = BASE;

// ── ROTA: Iniciar login → redireciona para Steam ───────────────────────────
app.get('/auth/steam', (req, res) => {
  const params = {
    'openid.ns':         'http://specs.openid.net/auth/2.0',
    'openid.mode':       'checkid_setup',
    'openid.return_to':  RETURN_URL,
    'openid.realm':      REALM,
    'openid.identity':   'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  };
  res.redirect(`${STEAM_OPENID}?${qs.stringify(params)}`);
});

// ── ROTA: Callback Steam ───────────────────────────────────────────────────
app.get('/auth/steam/return', async (req, res) => {
  // 1. Pega os parâmetros que a Steam enviou de volta
  const query = req.query;

  if (query['openid.mode'] !== 'id_res') {
    return res.redirect('/?login_error=1');
  }

  // 2. Verifica autenticidade com a Steam (check_authentication)
  const verifyParams = { ...query, 'openid.mode': 'check_authentication' };

  try {
    const verifyRes = await axios.post(STEAM_OPENID, qs.stringify(verifyParams), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 8000,
    });

    if (!verifyRes.data.includes('is_valid:true')) {
      console.error('Steam OpenID inválido:', verifyRes.data);
      return res.redirect('/?login_error=1');
    }
  } catch (e) {
    console.error('Erro verificando OpenID:', e.message);
    return res.redirect('/?login_error=1');
  }

  // 3. Extrai SteamID64 da claimed_id
  const claimedId = query['openid.claimed_id'] || '';
  const steamIdMatch = claimedId.match(/\/(\d{17,})$/);
  if (!steamIdMatch) return res.redirect('/?login_error=1');
  const steamId = steamIdMatch[1];

  try {
    // 4. Busca perfil
    const profileRes = await axios.get(
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/`,
      { params: { key: STEAM_API_KEY, steamids: steamId }, timeout: 8000 }
    );
    const player = profileRes.data?.response?.players?.[0];
    if (!player) return res.redirect('/?login_error=1');

    // 5. Busca nível Steam
    let steamLevel = 0;
    try {
      const lvlRes = await axios.get(
        `https://api.steampowered.com/IPlayerService/GetSteamLevel/v1/`,
        { params: { key: STEAM_API_KEY, steamid: steamId }, timeout: 5000 }
      );
      steamLevel = lvlRes.data?.response?.player_level || 0;
    } catch {}

    // 6. Busca jogos recentes
    let recentGames = [];
    try {
      const gamesRes = await axios.get(
        `https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/`,
        { params: { key: STEAM_API_KEY, steamid: steamId, count: 3 }, timeout: 5000 }
      );
      recentGames = (gamesRes.data?.response?.games || []).map(g => ({
        name:     g.name,
        playtime: Math.round((g.playtime_2weeks || 0) / 60) + 'h',
        appid:    g.appid,
        imgIcon:  g.img_icon_url
          ? `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_icon_url}.jpg`
          : null,
      }));
    } catch {}

    // 7. Busca inventário CS2 (appid 730, context 2)
    let inventory = [];
    try {
      const invRes = await axios.get(
        `https://steamcommunity.com/inventory/${steamId}/730/2`,
        {
          params: { l: 'brazilian', count: 150 },
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        }
      );
      if (invRes.data && invRes.data.assets) {
        inventory = parseInventory(invRes.data);
      }
    } catch (invErr) {
      console.warn('Inventário CS2 inacessível (privado?):', invErr.message);
    }

    // 8. Salva na sessão
    req.session.user = {
      steamId,
      name:         player.personaname,
      avatar:       player.avatarfull || player.avatarmedium || player.avatar,
      avatarMedium: player.avatarmedium,
      profileUrl:   player.profileurl,
      countryCode:  player.loccountrycode || '',
      realName:     player.realname || '',
      steamLevel,
      recentGames,
      inventory,
      tradeLink:    '',
      createdAt:    new Date().toISOString(),
    };

    console.log(`✓ Login: ${player.personaname} (${steamId}) — ${inventory.length} itens CS2`);
    res.redirect('/?welcome=1');

  } catch (e) {
    console.error('Erro buscando dados Steam:', e.message);
    res.redirect('/?login_error=1');
  }
});

// ─── API: dados do usuário logado ─────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, user: req.session.user });
});

// ─── API: logout ──────────────────────────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ─── API: salvar trade link ───────────────────────────────────────────────────
app.post('/api/tradelink', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
  const { tradeLink } = req.body;
  if (!tradeLink || !tradeLink.includes('steamcommunity.com/tradeoffer')) {
    return res.status(400).json({ error: 'Trade link inválido' });
  }
  req.session.user.tradeLink = tradeLink;
  res.json({ ok: true });
});

// ─── API: proxy de imagens Steam (evita CORS) ─────────────────────────────────
app.get('/imgproxy', async (req, res) => {
  const url = req.query.url;
  if (!url || !url.includes('steamstatic.com') && !url.includes('steamcommunity.com')) {
    return res.status(400).send('URL inválida');
  }
  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://steamcommunity.com' }
    });
    const ct = r.headers['content-type'] || 'image/png';
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(r.data);
  } catch (e) {
    res.status(502).send('Erro ao buscar imagem');
  }
});
app.get('/api/inventory/refresh', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
  const { steamId } = req.session.user;
  try {
    const invRes = await axios.get(
      `https://steamcommunity.com/inventory/${steamId}/730/2`,
      {
        params: { l: 'brazilian', count: 200 },
        timeout: 12000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }
    );
    if (!invRes.data || !invRes.data.assets) {
      return res.json({ items: [], error: 'Inventário privado ou vazio' });
    }
    const inventory = parseInventory(invRes.data);
    req.session.user.inventory = inventory;
    res.json({ items: inventory });
  } catch (e) {
    res.json({ items: [], error: 'Inventário privado ou inacessível' });
  }
});

// ─── HELPER: parse inventário Steam ──────────────────────────────────────────
function parseInventory(json) {
  if (!json?.assets || !json?.descriptions) return [];

  const descMap = {};
  json.descriptions.forEach(d => {
    descMap[`${d.classid}_${d.instanceid}`] = d;
  });

  return json.assets.slice(0, 100).map(asset => {
    const desc = descMap[`${asset.classid}_${asset.instanceid}`] || {};
    const tags  = desc.tags || [];

    const getTag = cat => tags.find(t => t.category === cat);
    const rarityTag  = getTag('Rarity');
    const typeTag    = getTag('Type');
    const weaponTag  = getTag('Weapon');
    const qualityTag = getTag('Quality');
    const extTag     = getTag('Exterior');

    return {
      assetId:    asset.assetid,
      classId:    asset.classid,
      name:       desc.market_name || desc.name || 'Item Desconhecido',
      iconUrl:    desc.icon_url
        ? `https://community.akamai.steamstatic.com/economy/image/${desc.icon_url}/96fx96f`
        : null,
      rarityColor: desc.name_color ? `#${desc.name_color}` : '#666',
      rarity:     rarityTag?.localized_tag_name  || rarityTag?.tag_name  || '',
      type:       typeTag?.localized_tag_name    || typeTag?.tag_name    || '',
      weapon:     weaponTag?.localized_tag_name  || weaponTag?.tag_name  || '',
      quality:    qualityTag?.localized_tag_name || qualityTag?.tag_name || '',
      exterior:   extTag?.localized_tag_name     || extTag?.tag_name     || '',
      tradable:   desc.tradable  === 1,
      marketable: desc.marketable === 1,
    };
  }).filter(i => i.name && i.name !== 'Item Desconhecido');
}

// ─── Fallback → index.html ────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════╗');
  console.log(`║  🎮  DROPZONE rodando em ${BASE.padEnd(13)}║`);
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Steam API Key : ${STEAM_API_KEY ? '✓ Configurada   ' : '✗ FALTA NO .env '}║`);
  console.log(`║  Login Steam   : ${BASE}/auth/steam`);
  console.log('╚══════════════════════════════════════╝\n');
  if (!STEAM_API_KEY) {
    console.warn('⚠️  Configure STEAM_API_KEY no arquivo .env');
    console.warn('   Obtenha em: https://steamcommunity.com/dev/apikey\n');
  }
});