/**
 * Python 数据微服务客户端（data-service/，基于 AKShare）。
 * 适合新闻、公告、财报等东财公开接口不便覆盖的数据。
 */
import { config } from '../config.js';
import type { DataProvider, NewsItem, Quote } from './provider.js';

export class PythonServiceProvider implements DataProvider {
  readonly name = 'python-akshare';
  private base = config.pythonServiceUrl;

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`数据服务请求失败 ${res.status}: ${body.slice(0, 200)}（请确认 data-service 已启动）`);
    }
    return (await res.json()) as T;
  }

  async getQuote(code: string): Promise<Quote> {
    return this.get<Quote>(`/quote/${code}`);
  }

  async getNews(code: string, limit = 10): Promise<NewsItem[]> {
    return this.get<NewsItem[]>(`/news/${code}?limit=${limit}`);
  }

  async search(keyword: string): Promise<{ code: string; name: string }[]> {
    return this.get<{ code: string; name: string }[]>(`/search?keyword=${encodeURIComponent(keyword)}`);
  }
}
