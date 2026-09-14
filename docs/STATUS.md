# 功能与问题清单（STATUS）

> **本文件的用途**：让接手的 agent / 工程师在 5 分钟内看清——哪些功能已能用、哪些没做、
> 当前最痛的已知问题是什么。**每次完成功能或发现新问题都要更新本文件。**
>
> 分工：架构原理看 [ARCHITECTURE.md](ARCHITECTURE.md)；每个功能"怎么实现的、代码在哪"
> 看 [FEATURES.md](FEATURES.md)；踩过的坑看 [PITFALLS.md](PITFALLS.md)；
> 数据源接口细节看 [DATA_SOURCES.md](DATA_SOURCES.md)。

最后更新：2026-09-14

---

## 一、已实现功能

| 功能 | 入口 | 状态 | 备注 |
|---|---|---|---|
| 对话主循环（LLM + function calling） | `src/agent/loop.ts` | ✅ 可用 | 会话历史在内存，重启丢失（见问题 P1） |
| 技能框架（SKILL.md + 注册表） | `src/skills/` | ✅ 可用 | 新增技能四步见 CLAUDE.md |
| 实时行情查询 `get_stock_quote` | `src/skills/bundled/quote/` | ✅ 可用 | 东财公开接口，免 key |
| 新闻查询 `get_stock_news` | `src/skills/bundled/news/` | ✅ 可用 | 依赖 Python data-service 运行 |
| 自选股管理 `manage_watchlist` | `src/skills/bundled/watchlist/` | ✅ 可用 | JSON 文件持久化，按 userId 隔离 |
| 股票搜索 `search_stock` | `src/skills/bundled/search/` | ✅ 可用 | Python 全量表优先，东财 suggest 降级；2026-09 新增 |
| 公告查询 `get_stock_announcements` | `src/skills/bundled/announcement/` | ✅ 可用 | 巨潮资讯个股公告，依赖 Python data-service 运行；2026-09-14 新增 |
| 财报查询 `get_stock_financials` | `src/skills/bundled/financials/` | ✅ 可用 | 新浪财务摘要（按报告期），依赖 Python data-service 运行；2026-09-14 新增 |
| WebChat 网页聊天 | `src/channels/webchat.ts` + `public/webchat/` | ✅ 可用 | 无鉴权（见问题 P5） |
| 离线通知收件箱（/api/inbox 轮询） | `src/channels/webchat.ts` | ✅ 可用 | 内存存储，重启丢失 |
| 收盘日报定时推送（交易日 15:30） | `src/alerts/scheduler.ts` | ✅ 可用 | 不跳法定节假日（见问题 P2） |
| Python 数据微服务（行情/新闻/搜索） | `data-service/main.py` | ✅ 可用 | FastAPI + AKShare |
| 飞书渠道 | `src/channels/feishu.ts` | ⚠️ 骨架 | 只收消息，回复/推送/验签全是 TODO |

## 二、待实现功能（按优先级）

1. **飞书渠道补完**：验签、tenant_access_token 缓存、notify 主动推送、消息去重（`feishu.ts` 头部 TODO）
2. **会话历史持久化** + Store 换 SQLite（用 `node:sqlite` 内置模块，免原生编译）
3. **异动提醒**：自选股涨跌幅超阈值主动推送（scheduler 增加盘中轮询任务）
4. **大盘指数行情**：上证指数等（注意指数与个股 secid 规则不同，见 PITFALLS.md 东财条目）

## 三、已知问题（按痛感排序）

> 每条给出：影响、根因、建议修法。解决后从本节移除并记入更新日志。

### P1 会话历史进程重启即丢失
- **影响**：用户重启服务后，机器人"失忆"，多轮对话上下文断裂。
- **根因**：`Agent.histories` 是内存 Map（`src/agent/loop.ts:24`）。
- **建议修法**：落到 Store（连带做待办第 2 条的 SQLite 化）；注意存取格式与现有
  `ChatMessage[]` 对齐，写入时机在 `handleMessage` 末尾。

### P2 收盘日报不跳法定节假日
- **影响**：春节/国庆等休市日照常推送，内容是昨日（或停牌前）行情，误导用户。
- **根因**：`msUntilNextRun` 只跳过周末（`src/alerts/scheduler.ts:19`）。
- **建议修法**：维护法定节假日列表（可硬编码年度列表，或 AKShare 有
  `ak.tool_trade_date_hist_sina()` 交易日历可走 data-service）；触发时先判断当日是否交易日。

### P3 会话历史丢失工具调用上下文
- **影响**：用户追问"它为什么涨"时，LLM 看不到上一轮工具返回的原始数据，只能凭
  上一轮自己的文字总结回答，细节（具体数字、新闻标题）可能记不全。
- **根因**：历史只保留 user/assistant 问答对，tool 消息被丢弃（`src/agent/loop.ts:67`）。
- **建议修法**：可接受的 MVP 取舍。若要做，把完整 messages（含 tool）持久化，注意
  裁剪 token 量（tool 结果往往很长）。

### P4 东财接口是非官方公开接口，随时可能变
- **影响**：字段编码变化会导致行情/搜索静默出错或解析出错值。
- **根因**：见 PITFALLS.md 东财条目（含 Referer、×100、`"-"` 等已知行为）。
- **建议修法**：出错时先按 PITFALLS.md 排查；长期可考虑给关键路径加健康探针
  （定时查一只常青股票如 600519，失败即告警）。

### P5 无任何鉴权，userId 由前端自报
- **影响**：任何人改个 userId 参数就能查/改别人的自选股、消耗 LLM 额度。
  仅局域网/自用部署时可接受，**暴露公网前必须解决**。
- **根因**：`/api/chat`、`/api/inbox` 直接信任请求里的 userId（`src/channels/webchat.ts`）。
- **建议修法**：最小方案是启动时生成访问口令，前端带 token 头；完整方案接飞书等
  渠道后以渠道身份为准，webchat 降级为调试入口。

### P6 无自动化测试
- **影响**：重构数据源/技能时只能靠手测，回归风险高。
- **建议修法**：优先给纯函数补单测（`toSecid`、调度器时间换算、搜索排序），
  用 vitest；外部接口层用录制好的响应做 fixture。

### P7 多进程/多实例部署会互相覆盖数据
- **影响**：水平扩展或误开两个实例时，自选股数据互相覆盖丢失。
- **根因**：JSON 单文件存储，整文件读改写（`src/storage/store.ts`）。
- **建议修法**：随待办第 2 条换 SQLite 自然解决（单文件锁）；或干脆声明"单实例部署"。

---

## 更新日志

- 2026-09-14：get_stock_financials 技能上线（新浪财务摘要，按报告期倒序，默认 4 期）；
  data-service 新增 `/financials/{code}` 端点；下一任务建议从待办第 1 条（飞书渠道补完）开始。
- 2026-09-14：get_stock_announcements 技能上线（巨潮资讯个股公告，近 30 天）；
  data-service 新增 `/announcements/{code}` 端点；get_stock_news 职责收窄为新闻/资讯，
  与公告技能分工；下一任务建议从待办第 1 条（财报技能）开始。
- 2026-09-14：search_stock 技能上线（名称→代码）；SYSTEM_PROMPT 增加先搜后查与
  搜不到禁止凭记忆作答的约束；建立 STATUS/FEATURES/PITFALLS/AUDIT 文档体系。
  **本日起项目开发交接给新 agent**，下一任务建议从待办第 1 条（公告技能）开始。
