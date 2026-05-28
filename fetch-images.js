// Roda no VPS: node fetch-images.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Hashes verificados que retornam 200 no VPS
const IMAGES = {
  // CAIXAS - hashes confirmados anteriormente
  'public/img/cases/prisma.png':    'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_fr3cV6vT9avBvefWWDDGTxbZ14rhsTX7qkE90sDiHwt2pdC-TblJ2DsB1QPlK7Ee9riHKAA',
  'public/img/cases/revolution.png':'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_frnAVvfb6aqduc_TFVjTCxbx05OU4S3jilE9w4DzRnImtIy2Sa1JzDJEhRPlK7EcO4U8gfA',
  'public/img/cases/fracture.png':  'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_fr3QV7aD7OP01IfbGDzPCmbsm4LU5GnvkzUsi4WvUmIqtci_CPQNyApsjE_lK7EfrhW545A',
  'public/img/cases/riptide.png':   'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_fr3sVtvD2O_Q9dqfEXTWSlepz4bA5THnikx915z6BytmuIHiXaAdyDpEhTflK7EdW-TaRMg',
  'public/img/cases/snakebite.png': 'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_fr3oVvvT4bfI4dvTLCGTCmLl16ec7TX_mk08k42iHwtqscy-WPVUmCZJ4R_lK7Ed8Q6OYtw',
  'public/img/cases/clutch.png':    'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_frHsVtqr8a_dsdKTAWDWVxLgjsrAwHSvgwEQk4m-ByYuqIC2eO1VyD5QiR_lK7EcxQQPYQA',
  'public/img/cases/spectrum2.png': 'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_frHoVu6D7PaA0JaDACjKUwOom47VrTSzrw0Vx4W_Sydz9JC7FZgckCZYjRPlK7EcPuDAQzw',
};

// Para skins - busca hashes via Steam Market Search
const SKIN_QUERIES = [
  ['ak47_asiimov',       'AK-47 | Asiimov (Field-Tested)'],
  ['awp_asiimov',        'AWP | Asiimov (Field-Tested)'],
  ['m4a1s_printstream',  'M4A1-S | Printstream (Factory New)'],
  ['usps_printstream',   'USP-S | Printstream (Factory New)'],
  ['ak47_bloodsport',    'AK-47 | Bloodsport (Factory New)'],
  ['p90_asiimov',        'P90 | Asiimov (Field-Tested)'],
  ['butterfly_fade',     'Butterfly Knife | Fade (Factory New)'],
  ['glock_fade',         'Glock-18 | Fade (Factory New)'],
  ['deagle_blaze',       'Desert Eagle | Blaze (Factory New)'],
  ['karambit_doppler',   'Karambit | Doppler (Factory New)'],
  ['ak47_fireserpent',   'AK-47 | Fire Serpent (Field-Tested)'],
  ['awp_medusa',         'AWP | Medusa (Field-Tested)'],
  ['m4a4_howl',          'M4A4 | Howl (Field-Tested)'],
];

async function downloadImage(filePath, hash) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const url = `https://steamcommunity-a.akamaihd.net/economy/image/${hash}/200fx200f`;
  const r = await axios.get(url, {
    responseType: 'arraybuffer', timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://steamcommunity.com' }
  });
  if (r.data.byteLength < 500) throw new Error('Empty response');
  fs.writeFileSync(filePath, Buffer.from(r.data));
  return r.data.byteLength;
}

async function fetchSkinHash(query) {
  const r = await axios.get('https://steamcommunity.com/market/search/render/', {
    params: { query, appid: 730, count: 1, norender: 1 },
    timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const res = r.data.results && r.data.results[0];
  if (!res) throw new Error('Not found');
  return res.asset_description.icon_url;
}

async function main() {
  console.log('=== Baixando imagens das caixas ===');
  for (const [filePath, hash] of Object.entries(IMAGES)) {
    try {
      const bytes = await downloadImage(filePath, hash);
      console.log(`✓ ${filePath} (${bytes}b)`);
    } catch(e) { console.log(`✗ ${filePath}: ${e.message}`); }
  }

  console.log('\n=== Buscando e baixando skins ===');
  const skinHashes = {};
  for (const [name, query] of SKIN_QUERIES) {
    try {
      const hash = await fetchSkinHash(query);
      skinHashes[name] = hash;
      const filePath = `public/img/skins/${name}.png`;
      const bytes = await downloadImage(filePath, hash);
      console.log(`✓ ${name} (${bytes}b)`);
      await new Promise(r => setTimeout(r, 500));
    } catch(e) { console.log(`✗ ${name}: ${e.message}`); }
  }

  console.log('\n=== Hashes obtidos ===');
  console.log(JSON.stringify(skinHashes, null, 2));
  console.log('\nPronto! Imagens salvas em public/img/');
}

main();
