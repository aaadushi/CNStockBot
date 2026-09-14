/**
 * 组合数据源：行情走东财直连（免 key、实时），
 * 新闻/公告走 Python AKShare 微服务（如果已启动，否则给出友好提示）。
 * DATA_PROVIDER=python 时全部走微服务。
 */
import { config } from '../config.js';
import { EastmoneyProvider } from './eastmoney.js';
import { PythonServiceProvider } from './pythonService.js';
import type { DataProvider, NewsItem, Quote } from './provider.js';

class CompositeProvider implements DataProvider {
  readonly name = 'composite(eastmoney+python)';
  private quote = new EastmoneyProvider();
  private python = new PythonServiceProvider();

  getQuote(code: string): Promise<Quote> {
    return this.quote.getQuote(code);
  }

  async getNews(code: string, limit = 10): Promise<NewsItem[]> {
    try {
      return await this.python.getNews(code, limit);
    } catch (err) {
      throw new Error(
        `新闻数据不可用：${err instanceof Error ? err.message : String(err)}\n` +
          '提示：进入 data-service 目录运行 `pip install -r requirements.txt && uvicorn main:app` 启动数据微服务。',
      );
    }
  }

  /** 搜索优先走 Python 微服务（全量代码表，匹配更准）；未启动时降级到东财搜索建议接口 */
  async search(keyword: string): Promise<{ code: string; name: string }[]> {
    try {
      return await this.python.search(keyword);
    } catch {
      return this.quote.search(keyword);
    }
  }
}

export function createProvider(): DataProvider {
  if (config.dataProvider === 'python') return new PythonServiceProvider();
  return new CompositeProvider();
}
