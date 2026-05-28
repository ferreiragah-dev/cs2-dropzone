/**
 * DROPZONE — Image Downloader
 * Roda no VPS: node get-all-images.js
 * Busca hashes corretos do Steam Market e baixa todas as imagens
 */
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://steamcommunity.com/market/',
};

const BASE_URL = 'https://steamcommunity-a.akamaihd.net/economy/image';

// ── Caixas (hashes já confirmados) ───────────────────────────────────────────
const CASE_HASHES = {
  'prisma':    'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_fr3cV6vT9avBvefWWDDGTxbZ14rhsTX7qkE90sDiHwt2pdC-TblJ2DsB1QPlK7Ee9riHKAA',
  'revolution':'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_frnAVvfb6aqduc_TFVjTCxbx05OU4S3jilE9w4DzRnImtIy2Sa1JzDJEhRPlK7EcO4U8gfA',
  'dreams':    'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_frnIV7Kb5OaU-JqfHDzXFle0u4LY8Gy_kkRgisGzcm4v4J3vDOAQmDMdyRvlK7EcmeCU3yw',
  'fracture':  'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_fr3QV7aD7OP01IfbGDzPCmbsm4LU5GnvkzUsi4WvUmIqtci_CPQNyApsjE_lK7EfrhW545A',
  'riptide':   'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_fr3sVtvD2O_Q9dqfEXTWSlepz4bA5THnikx915z6BytmuIHiXaAdyDpEhTflK7EdW-TaRMg',
  'snakebite': 'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_fr3oVvvT4bfI4dvTLCGTCmLl16ec7TX_mk08k42iHwtqscy-WPVUmCZJ4R_lK7Ed8Q6OYtw',
  'clutch':    'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_frHsVtqr8a_dsdKTAWDWVxLgjsrAwHSvgwEQk4m-ByYuqIC2eO1VyD5QiR_lK7EcxQQPYQA',
  'spectrum2': 'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_frHoVu6D7PaA0JaDACjKUwOom47VrTSzrw0Vx4W_Sydz9JC7FZgckCZYjRPlK7EcPuDAQzw',
};

// ── Skins — busca hash via Steam Market Search ────────────────────────────────
const SKIN_QUERIES = [
  // [filename, exact market_hash_name]
  ['ak47_asiimov',        'AK-47 | Asiimov (Field-Tested)'],
  ['awp_asiimov',         'AWP | Asiimov (Field-Tested)'],
  ['m4a1s_printstream',   'M4A1-S | Printstream (Factory New)'],
  ['usps_printstream',    'USP-S | Printstream (Factory New)'],
  ['ak47_bloodsport',     'AK-47 | Bloodsport (Factory New)'],
  ['p90_asiimov',         'P90 | Asiimov (Field-Tested)'],
  ['butterfly_fade',      'Butterfly Knife | Fade (Factory New)'],
  ['glock_fade',          'Glock-18 | Fade (Factory New)'],
  ['deagle_blaze',        'Desert Eagle | Blaze (Factory New)'],
  ['karambit_doppler',    'Karambit | Doppler (Factory New)'],
  ['ak47_fireserpent',    'AK-47 | Fire Serpent (Field-Tested)'],
  ['awp_medusa',          'AWP | Medusa (Field-Tested)'],
  ['m4a4_howl',           'M4A4 | Howl (Field-Tested)'],
  ['fiveseven_hyperbeast','Five-SeveN | Hyper Beast (Factory New)'],
  ['glock_waterelemental','Glock-18 | Water Elemental (Factory New)'],
  ['m4a1s_nightmare',     'M4A1-S | Nightmare (Factory New)'],
  ['awp_hyperbeast',      'AWP | Hyper Beast (Factory New)'],
  ['ak47_neonrider',      'AK-47 | Neon Rider (Factory New)'],
  ['m4a4_neonoir',        'M4A4 | Neo-Noir (Factory New)'],
  ['usp_caiman',          'USP-S | Caiman (Factory New)'],
];

async function download(filePath, hash, size='200fx200f') {
  const url = `${BASE_URL}/${hash}/${size}`;
  const res = await axios.get(url, { responseType:'arraybuffer', headers: HEADERS, timeout: 12000 });
  if (res.data.byteLength < 500) throw new Error(`Too small: ${res.data.byteLength}b`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(res.data));
  return res.data.byteLength;
}

async function searchSteamMarket(query) {
  const url = 'https://steamcommunity.com/market/search/render/';
  const res = await axios.get(url, {
    params: { query, appid: 730, count: 1, norender: 1, search_descriptions: 0 },
    headers: HEADERS, timeout: 10000,
  });
  const item = res.data?.results?.[0];
  if (!item?.asset_description?.icon_url) throw new Error('Not found');
  return {
    hash: item.asset_description.icon_url,
    name: item.asset_description.market_hash_name,
  };
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const results = { cases: {}, skins: {} };
  let ok = 0, fail = 0;

  // ── Download cases ────────────────────────────────────────────────────────
  console.log('\n╔══ BAIXANDO CAIXAS ══╗');
  for (const [name, hash] of Object.entries(CASE_HASHES)) {
    const file = `public/img/cases/${name}.png`;
    if (fs.existsSync(file) && fs.statSync(file).size > 500) {
      console.log(`  skip  ${name} (já existe)`);
      results.cases[name] = `/img/cases/${name}.png`;
      ok++; continue;
    }
    try {
      const bytes = await download(file, hash);
      console.log(`  ✓  ${name.padEnd(12)} ${bytes}b`);
      results.cases[name] = `/img/cases/${name}.png`;
      ok++;
    } catch(e) {
      console.log(`  ✗  ${name.padEnd(12)} ${e.message}`);
      fail++;
    }
    await sleep(200);
  }

  // ── Search & download skins ───────────────────────────────────────────────
  console.log('\n╔══ BAIXANDO SKINS ══╗');
  for (const [fname, query] of SKIN_QUERIES) {
    const file = `public/img/skins/${fname}.png`;
    if (fs.existsSync(file) && fs.statSync(file).size > 500) {
      console.log(`  skip  ${fname} (já existe)`);
      results.skins[fname] = `/img/skins/${fname}.png`;
      ok++; continue;
    }
    try {
      // Step 1: get hash from Steam Market
      const { hash, name } = await searchSteamMarket(query);
      // Step 2: download image
      const bytes = await download(file, hash);
      console.log(`  ✓  ${fname.padEnd(22)} ${bytes}b  →  ${name}`);
      results.skins[fname] = `/img/skins/${fname}.png`;
      ok++;
    } catch(e) {
      console.log(`  ✗  ${fname.padEnd(22)} ${e.message}`);
      fail++;
    }
    await sleep(400); // rate limit Steam Market
  }

  // ── Generate JS snippet with correct paths ────────────────────────────────
  console.log('\n╔══ RESULTADO ══╗');
  console.log(`  ✓ ${ok} imagens baixadas`);
  console.log(`  ✗ ${fail} falhas`);
  console.log('\nArquivos em public/img/:');
  const cases_files = fs.readdirSync('public/img/cases/').map(f => `public/img/cases/${f}`);
  const skins_files = fs.readdirSync('public/img/skins/').map(f => `public/img/skins/${f}`);
  [...cases_files, ...skins_files].forEach(f => {
    const size = fs.statSync(f).size;
    console.log(`  ${size > 500 ? '✓' : '✗'} ${f} (${size}b)`);
  });
}

main().catch(console.error);