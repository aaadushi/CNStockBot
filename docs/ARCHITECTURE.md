# 架构说明

## 一次消息的生命周期

```
用户在 WebChat 输入 "我买了 300750，帮我加自选"
  │
  ▼
POST /api/chat { userId, message }              (channels/webchat.ts)
  │
  ▼
Agent.handleMessage(userId, text)               (agent/loop.ts)
  │  组装 messages = [system, ...历史, user]
  │  附带全部技能的 tools 定义
  ▼
LLM 返回 tool_calls: manage_watchlist(action=add, code=300750)
  │
  ▼
registry 找到技能 → skill.execute(args, ctx)    (skills/bundled/watchlist/)
  │  内部调用 ctx.data.getQuote 验证代码         (data/eastmoney.ts)
  │  写入 ctx.store                             (storage/store.ts)
  ▼
结果作为 tool message 回传 LLM → 生成最终中文回复
  │
  ▼
返回 { reply }，前端渲染
```

## 三条边界（改代码时遵守）

1. **渠道不认识技能**：channel 只调 `agent.handleMessage(userId, text)` 和接收 `notify()`。
2. **技能不认识渠道**：skill 只拿到 `SkillContext { userId, store, data }`。
3. **数据不认识 LLM**：DataProvider 返回结构化对象，文案格式化在技能层做。

这样换渠道、换数据源、换 LLM 互不影响。

## 数据源分层

```
        DataProvider 接口
       /                \
EastmoneyProvider    PythonServiceProvider
（行情，直连）        （新闻/公告/财报，HTTP 调用 data-service）
       \                /
        CompositeProvider（默认：各取所长）
```

东财 secid 规则：沪市（60xxxx/68xxxx/9xxxxx）→ `1.代码`，深市（00/30）与北交所（4/8）→ `0.代码`。
