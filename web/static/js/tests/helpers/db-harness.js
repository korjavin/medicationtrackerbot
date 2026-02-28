import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const DB_JS = path.join(REPO_ROOT, 'web/static/js/db.js');

function deepClone(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function compareValues(a, b) {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  return a > b ? 1 : -1;
}

class FakeCollection {
  constructor(items) {
    this.items = items;
    this._reversed = false;
    this._limit = null;
  }

  reverse() {
    this._reversed = !this._reversed;
    return this;
  }

  limit(value) {
    this._limit = value;
    return this;
  }

  async toArray() {
    let results = this.items.map((item) => deepClone(item));
    if (this._reversed) {
      results = results.reverse();
    }
    if (typeof this._limit === 'number') {
      results = results.slice(0, this._limit);
    }
    return results;
  }

  async count() {
    return this.items.length;
  }
}

class FakeWhereClause {
  constructor(table, field) {
    this.table = table;
    this.field = field;
  }

  equals(value) {
    const matched = this.table._values().filter((item) => item[this.field] === value);
    return new FakeCollection(matched);
  }

  between(start, end) {
    const matched = this.table._values().filter((item) => item[this.field] >= start && item[this.field] <= end);
    return new FakeCollection(matched);
  }
}

class FakeTable {
  constructor(primaryKey, autoIncrement) {
    this.primaryKey = primaryKey;
    this.autoIncrement = autoIncrement;
    this.rows = new Map();
    this.nextId = 1;
  }

  _values() {
    return [...this.rows.values()];
  }

  _assignPrimaryKey(record) {
    let key = record[this.primaryKey];
    if ((key === undefined || key === null) && this.autoIncrement) {
      key = this.nextId;
      this.nextId += 1;
      record[this.primaryKey] = key;
      return key;
    }

    if (this.autoIncrement && Number.isFinite(Number(key))) {
      this.nextId = Math.max(this.nextId, Number(key) + 1);
    }

    if (key === undefined || key === null) {
      throw new Error(`Missing primary key: ${this.primaryKey}`);
    }

    return key;
  }

  async add(record) {
    const cloned = deepClone(record);
    const key = this._assignPrimaryKey(cloned);
    this.rows.set(key, cloned);
    return key;
  }

  async put(record) {
    const cloned = deepClone(record);
    const key = this._assignPrimaryKey(cloned);
    this.rows.set(key, cloned);
    return key;
  }

  async get(key) {
    const value = this.rows.get(key);
    return value ? deepClone(value) : undefined;
  }

  async update(key, changes) {
    const existing = this.rows.get(key);
    if (!existing) return 0;
    this.rows.set(key, { ...existing, ...deepClone(changes) });
    return 1;
  }

  async delete(key) {
    this.rows.delete(key);
  }

  async clear() {
    this.rows.clear();
  }

  where(field) {
    return new FakeWhereClause(this, field);
  }

  orderBy(field) {
    const sorted = this._values().slice().sort((a, b) => compareValues(a[field], b[field]));
    return new FakeCollection(sorted);
  }

  async toArray() {
    return this._values().map((item) => deepClone(item));
  }
}

class FakeDexie {
  constructor(name) {
    this.name = name;
    this.tables = {};
  }

  version() {
    return {
      stores: (schema) => {
        for (const [tableName, schemaText] of Object.entries(schema)) {
          const firstToken = schemaText.split(',')[0].trim();
          const autoIncrement = firstToken.startsWith('++');
          const primaryKey = firstToken
            .replace(/^\+\+/, '')
            .replace(/[&*]/g, '')
            .trim();

          if (!this.tables[tableName]) {
            this.tables[tableName] = new FakeTable(primaryKey, autoIncrement);
          }
          this[tableName] = this.tables[tableName];
        }
      }
    };
  }
}

function evalWithSourceURL(window, source, scriptPath) {
  window.eval(`${source}\n//# sourceURL=file://${scriptPath}`);
}

export function loadDbEnv() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });

  const { window } = dom;
  window.Dexie = FakeDexie;
  window.SyncDebug = { info() {} };

  const source = fs.readFileSync(DB_JS, 'utf8');
  evalWithSourceURL(window, source, DB_JS);

  return {
    window,
    cleanup: () => dom.window.close()
  };
}
