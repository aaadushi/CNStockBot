/**
 * 极简 JSON 文件存储（MVP 用，零依赖）。
 * 后续可替换为 SQLite（better-sqlite3 / node:sqlite），只需保持本文件暴露的方法签名不变。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

interface StoreData {
  /** userId -> 自选股代码列表（6 位代码字符串） */
  watchlists: Record<string, string[]>;
}

export class Store {
  private file: string;
  private data: StoreData;

  constructor() {
    mkdirSync(config.dataDir, { recursive: true });
    this.file = path.join(config.dataDir, 'store.json');
    this.data = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, 'utf-8')) as StoreData)
      : { watchlists: {} };
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  getWatchlist(userId: string): string[] {
    return this.data.watchlists[userId] ?? [];
  }

  addToWatchlist(userId: string, code: string): boolean {
    const list = this.getWatchlist(userId);
    if (list.includes(code)) return false;
    this.data.watchlists[userId] = [...list, code];
    this.save();
    return true;
  }

  removeFromWatchlist(userId: string, code: string): boolean {
    const list = this.getWatchlist(userId);
    if (!list.includes(code)) return false;
    this.data.watchlists[userId] = list.filter((c) => c !== code);
    this.save();
    return true;
  }

  /** 所有有自选股列表的用户（定时推送用） */
  allUsers(): string[] {
    return Object.keys(this.data.watchlists).filter((u) => this.data.watchlists[u].length > 0);
  }
}
