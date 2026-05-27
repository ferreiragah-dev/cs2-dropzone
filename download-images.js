// Roda uma vez para baixar todas as imagens do Steam
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const IMAGES = {
  'public/img/cases/prisma.png':      '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pISdlJmKkGJiYDlB6dPhyomZkqKulDpfppV07rOI9rDyiIy72VDi_0ZpZjv2IJSdegY4NVzR_VS5xu27jMO6uc6S6HY',
  'public/img/cases/revolution.png':  '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pISdlJmKkGJiYDlB6dPhyomZkqKulDpfppV07rOI9rDyiIy72VDi_0ZpZjv2IJSdegY4NVzR_VS5xu27jMO6uc6S6HY',
  'public/img/cases/dreams.png':      '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pISdlJmKkGJiYDlB6dPhyomZkqOhvDpfppV07rOI9rDyiIy72VDi_0ZqZj2ndouReg8_NlKK',
  'public/img/cases/fracture.png':    '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pISdlJmKkGJiYDlB6dPhyomZkqKulDpfppV07rOI9rDyiIy72VDi_0ZpZjv2IJSdegY4NVzR_VS5xu27jMO6uc6S6HY',
  'public/img/cases/riptide.png':     '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pISdlJmKkGJiYDlB6dPhyomZkqKulDpfppV07rOI9rDyiIy72VDi_0ZpZjv2IJSdegY4NVzR_VS5xu27jMO6uc6S6HY',
  'public/img/cases/snakebite.png':   '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pISdlJmKkGJiYDlB6dPhyomZkqOhvDpfppV07rOI9rDyiIy72VDi_0ZqZj2ndouReg8_NlKK',
  'public/img/cases/clutch.png':      '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pISdlJmKkGJiYDlB6dPhyomZkqKulDpfppV07rOI9rDyiIy72VDi_0ZpZjv2IJSdegY4NVzR_VS5xu27jMO6uc6S6HY',
  'public/img/cases/spectrum2.png':   '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pISdlJmKkGJiYDlB6dPhyomZkqOhvDpfppV07rOI9rDyiIy72VDi_0ZqZj2ndouReg8_NlKK',
  'public/img/skins/ak47_asiimov.png':       '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujYbnWnBB0ucl93-rB_I20jlGx_kVlNjmkdI6LcFI4MlMkuA',
  'public/img/skins/awp_medusa.png':         '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujNLnWm3lS5cB1g77A9I2k21e1-kRlaj2ldNKcdlI-MwnW_g',
  'public/img/skins/m4a4_howl.png':          '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujYbnWn3lS5cB1iqjAoNqs2lDh-ENrNj37dteLMlhs2VQ',
  'public/img/skins/glock_fade.png':         '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujYbnWn3lS5cB1g7rFpYqijlHh-kc-Nj-nddeLMlhuMtfF4A',
  'public/img/skins/ak47_fireserpent.png':   '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujNbCFnzpS5cB1hL_CoN_2ilDt_UJvYWilINeLMlhJ9XNgpw',
  'public/img/skins/karambit_doppler.png':   '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujYbnWn3lS5cB1hLzAoNus3Fri_0VuMmrxdYSWdA1rjg7V-tA',
  'public/img/skins/deagle_blaze.png':       '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujNbCFnzpS5MB1i7mTpd6h0VK2_kI-ZWykd9KRMlhqMXGmEA',
  'public/img/skins/usps_printstream.png':   '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujNLnWm3lS5cB1g7fAo9_y3VDi_UY6ZWundYWXdlhiNfEHKg',
  'public/img/skins/m4a1s_printstream.png':  '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujNLnWm3lS5cB1g7fF9tWk3FDi_UY9YW6ndYWXcFhiNfEtYw',
  'public/img/skins/ak47_bloodsport.png':    '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujNbCFnzpS5cB1i7-Bp4ms3lfi_kduZGqhd4-RMlhcjCR5tg',
  'public/img/skins/awp_asiimov.png':        '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujYbnWn3lS5cB1g7jEp9-k2lLi_UdvZmimcdKRMlhkGYGV2w',
  'public/img/skins/p90_asiimov.png':        '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujYbnWn3lS5cB1g7TUo9mi2FDs-UVpYmincdKXMlhniPIFzw',
  'public/img/skins/butterfly_fade.png':     '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujYbnWn3lS5cB1g7zHotyh3Fri_UVpZm6icddKXMlhBDPsHoA',
  'public/img/skins/glock_waterelemental.png':'-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujNbCFnzpS5cB1i7fEpN-j3FDi-0VsZW6icZaWYMlhilfAU5A',
  'public/img/skins/fiveseven_hyperbeast.png':'-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I4hwwW1RiZiFlFsIWhBR3ePTHsHJe1o6-xmDaQJFHS5u3mNjjNBRRYTn7pIOS1uKkJGJiZDlHtImxwNiKwqujNbCFnzpS5MB1i7iAotui3VLi_UY9ZWundYWXMlhijY5LzQ',
};

async function download() {
  for (const [filePath, hash] of Object.entries(IMAGES)) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
      console.log(`✓ skip ${filePath}`);
      continue;
    }
    const url = `https://steamcommunity-a.akamaihd.net/economy/image/${hash}/200fx200f`;
    try {
      const r = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://steamcommunity.com' }
      });
      fs.writeFileSync(filePath, Buffer.from(r.data));
      console.log(`✓ ${filePath} (${r.data.byteLength} bytes)`);
    } catch(e) {
      console.error(`✗ ${filePath}: ${e.message}`);
    }
  }
  console.log('\nDone!');
}

download();