const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      -- Usuários (logados via Steam)
      CREATE TABLE IF NOT EXISTS users (
        steam_id        TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        avatar          TEXT,
        profile_url     TEXT,
        country_code    TEXT DEFAULT '',
        real_name       TEXT DEFAULT '',
        steam_level     INTEGER DEFAULT 0,
        balance         NUMERIC(10,2) DEFAULT 500.00,
        trade_link      TEXT DEFAULT '',
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        last_login      TIMESTAMPTZ DEFAULT NOW()
      );

      -- Batalhas
      CREATE TABLE IF NOT EXISTS battles (
        id              SERIAL PRIMARY KEY,
        status          TEXT DEFAULT 'open',  -- open | live | done
        player_count    INTEGER NOT NULL,
        cases_json      JSONB NOT NULL,
        total_value     NUMERIC(10,2) NOT NULL,
        winner_steam_id TEXT DEFAULT NULL,
        created_by      TEXT REFERENCES users(steam_id),
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        finished_at     TIMESTAMPTZ DEFAULT NULL
      );

      -- Slots de jogadores por batalha
      CREATE TABLE IF NOT EXISTS battle_players (
        id              SERIAL PRIMARY KEY,
        battle_id       INTEGER REFERENCES battles(id) ON DELETE CASCADE,
        steam_id        TEXT REFERENCES users(steam_id),
        slot_index      INTEGER NOT NULL,
        skins_json      JSONB DEFAULT '[]',
        total_won       NUMERIC(10,2) DEFAULT 0,
        joined_at       TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(battle_id, slot_index)
      );

      -- Inventário do usuário (skins ganhas)
      CREATE TABLE IF NOT EXISTS inventory (
        id              SERIAL PRIMARY KEY,
        steam_id        TEXT REFERENCES users(steam_id),
        item_name       TEXT NOT NULL,
        item_img        TEXT,
        item_value      NUMERIC(10,2),
        rarity_color    TEXT DEFAULT '#888',
        wear            TEXT DEFAULT '',
        tradable        BOOLEAN DEFAULT TRUE,
        source          TEXT DEFAULT 'battle',  -- battle | case_open
        acquired_at     TIMESTAMPTZ DEFAULT NOW()
      );

      -- Cache de imagens (base64 ou URL verificada)
      CREATE TABLE IF NOT EXISTS image_cache (
        key             TEXT PRIMARY KEY,
        url             TEXT NOT NULL,
        data            BYTEA,
        content_type    TEXT DEFAULT 'image/png',
        cached_at       TIMESTAMPTZ DEFAULT NOW()
      );

      -- Histórico de transações de saldo
      CREATE TABLE IF NOT EXISTS transactions (
        id              SERIAL PRIMARY KEY,
        steam_id        TEXT REFERENCES users(steam_id),
        type            TEXT NOT NULL, -- deposit | battle_win | battle_loss | case_open | deposit
        amount          NUMERIC(10,2) NOT NULL,
        description     TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✓ Banco de dados inicializado');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
