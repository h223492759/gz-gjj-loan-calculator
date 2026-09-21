'use strict';

/**
 * 本地存储层（SQLite）
 * ------------------------------------------------------------------
 * 数据全部落在 DATA_DIR（默认 ./data）下的 SQLite 文件里，
 * 不联网、不上传、无遥测。容器删了数据还在（compose 里挂载出来）。
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'gz-gjj.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS records (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    payload     TEXT    NOT NULL,   -- 输入参数（JSON），重新打开时按最新政策重算
    snapshot    TEXT,               -- 保存当时的结果摘要（JSON），用于历史对比
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS presets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    rate        REAL    NOT NULL UNIQUE,
    label       TEXT,
    created_at  TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_records_updated ON records(updated_at DESC);
`);

module.exports = { db, DATA_DIR, DB_FILE };
