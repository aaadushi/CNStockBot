# 提交规范与版本管理（WORKFLOW）

> **本文件的用途**：约定 Git 分支模型、提交信息格式、PR 流程与回退方法。
> **所有后续 agent/开发者必须遵守**：改动一律走"新分支 → 推送 → PR 合并 main"，
> 不直接提交到 main，保证任何一条出问题都能干净回退。

## 1. 分支模型

- `main`：主干，**只接受 PR 合入**，始终保持可运行（typecheck + 测试全绿）。
- 功能分支命名：`feat/<短横线小写描述>`（如 `feat/stock-browse-page`）
- 修复分支：`fix/<描述>`（如 `fix/llm-429-retry`）
- 文档分支：`docs/<描述>`；审计/重构：`chore/<描述>`

标准流程：

```bash
git checkout -b feat/xxx        # 1. 从最新 main 切分支（先 git pull）
# ... 改代码 + 按 CLAUDE.md 验收清单验证（typecheck / test / 文档同步）...
git add -A && git commit        # 2. 提交（格式见下）
git push -u origin feat/xxx     # 3. 推送分支
gh pr create --base main        # 4. 开 PR，描述改动与验证结果
# 5. 合并后本地切回 main 并拉取：git checkout main && git pull
```

## 2. 提交信息规范

沿用仓库现有风格：**中文一句话摘要开头**，必要时跟若干 `-` 要点行，结尾带署名行：

```
行情链路加腾讯行情自动降级（东财 IP 限流托底）

- 新增 src/data/tencent.ts：……
- CompositeProvider 东财失败自动切腾讯……

Co-Authored-By: Claude Code <noreply@anthropic.com>
```

规则：
- 第一行 ≤ 50 字，说清"做了什么"而不是"改了哪些文件"
- 一个提交只做一件事；功能、修复、文档尽量分开提交
- 解决 STATUS 的 P 编号 / AUDIT 的 A 编号问题时，在正文里引用编号（如"A-501"）

## 3. PR 规范

- 标题 = 提交第一行；正文写：**改动摘要 + 验证结果**（typecheck/测试/实测截图描述）+
  文档同步情况（STATUS/FEATURES/PITFALLS 哪些动了）
- 改动大时分多个小 PR，不要攒一个巨型 PR
- 合并方式：GitHub 默认 merge commit 即可（保留分支历史，便于按分支回退）
- 合并后删除远程分支（`gh pr merge --delete-branch` 或网页按钮）

## 4. 回退方法（分支/版本出错时）

**场景 A：某个 PR 合入后发现问题**

```bash
git checkout main && git pull
git revert -m 1 <merge-commit-sha>   # 生成一个"反向"提交，不改写历史，安全
git push origin main                 # （回退属紧急修复，可直接推 main，但最好也走 PR）
```

**场景 B：想回到某个历史版本查看/取代码**

```bash
git log --oneline                    # 找到目标提交
git checkout <sha>                   # 查看（游离 HEAD，只读浏览）
git checkout -b fix/restore-xxx <sha> # 从该点切分支继续开发
```

**场景 C：分支自己改乱了** → 直接删掉重来（分支没合并前随便删）：

```bash
git checkout main && git branch -D feat/xxx && git push origin --delete feat/xxx
```

**禁止**：对已推送的 main 做 `git reset --hard` + `git push --force`（改写共享历史，
其他副本会冲突）。回退一律用 `git revert`。

## 5. 里程碑打 tag

完成一组功能（如 F1/F2 这种路线图条目）后打 tag，作为可回退的"存档点"：

```bash
git tag -a v0.2.0 -m "F1/F2：股票浏览页 + 详情页 + 页内搜索"
git push origin v0.2.0
```

版本号规则（语义化）：破坏性改动升 major（v1.0.0），新功能升 minor（v0.2.0），
修复升 patch（v0.1.1）。tag 与 `package.json` 的 version 保持一致。
