# REQ-Dev-Tunnel：自测临时公网隧道（Cloudflare Quick Tunnel 演示脚本）

> 需求文档（开发自测工具，非用户可见功能）。依据 2026-10-10 用户决策：
> 项目处于"自测阶段"，公网发布前的演示/外出测试用免费临时隧道，不买服务器。

## 背景与目标

- 背景：F7 公网发布前，用户需要**临时把本机服务暴露到公网**（外出用手机 App
  实测、给少数人演示）。家宽入站 80/443 被封、无固定公网 IP，传统端口映射不可行。
- 目标：一条命令把本机主服务映射为 `https://xxx.trycloudflare.com` 临时地址，
  成本为零；脚本做好前置检查（cloudflared 存在、主服务已运行），降低使用门槛。
- 定位：**仅限自测/演示**。正式发布的域名 + 云主机方案（docs/deploy/HTTPS.md）
  不受影响，本工具与其是"阶段 1 ↔ 阶段 3"的关系。

## 范围

**做**：
- `scripts/tunnel-demo.bat`（Windows，用户主环境）+ `scripts/tunnel-demo.sh`
  （Linux/macOS 等价物，与 start-all.bat/.sh 成对惯例一致）
- 端口解析顺序：命令行参数 > `.env` 的 `PORT` > 默认 18790
- 前置检查：cloudflared 在 PATH（缺失时给出 winget 安装提示）、主服务
  `/health` 可通（缺失时提示先跑 start-all）
- 运行 cloudflared 前台输出，临时 URL 由 cloudflared 自身打印到控制台

**明确不做**：
- 不做固定隧道（Named Tunnel）/ 域名绑定（属阶段 2，需购买域名后另行配置）
- 不做崩溃自动拉起、不做开机自启（同 S3-4 的进程管理边界）
- 不改任何应用代码、配置项、API；不引入新依赖
- 不解析/抓取 URL 输出做二次处理（cloudflared 自带打印，够用）
- 不写进 App 默认服务器地址（临时 URL 随时失效，写死会造成用户困惑）

## 功能需求

1. 双击/执行脚本即可启动隧道，控制台可见临时 https URL。
2. 缺 cloudflared → 报错并提示安装命令（`winget install cloudflare.cloudflared`）。
3. 主服务未运行 → 报错并提示先运行 `scripts\start-all.bat`。
4. 脚本退出即隧道关闭（cloudflared 前台进程语义，与 start-all 一致）。

## 非功能需求

- bat/sh 两个脚本行为等价。
- **bat 纯 ASCII + CRLF 行尾**：cmd.exe 对 LF 行尾与 `chcp 65001`+中文混排均有
  解析错乱 bug（2026-10-10 实测三雷叠加，已回填 PITFALLS），提示文案用英文，
  中文使用说明全部放配套文档。改动后必须 `cmd /c` 实测。
- 幂等可重复执行：cloudflared 本身可多开，脚本不做占用预检（同一服务开多条
  隧道是合法用途，如同时给两个人演示）。
- 零依赖：只依赖用户自行安装的 cloudflared 单文件。

## 数据模型 / API / 前端改动

无（纯运维脚本 + 文档）。

## 文档改动

- 新增 `docs/deploy/local-tunnel.md`：用途定位、URL 生命周期语义
  （进程活着 URL 不变；进程退出/电脑重启/休眠/断网久置可能失效）、
  安装与用法、安全注意（电脑即服务器期间的密码强度自查）、与正式部署路线的关系。
- README.md"一键启动双服务"与"公网部署"之间加一节指向该文档。
- `docs/deploy/HTTPS.md` 底部相关文档加链接。
- STATUS.md 更新日志追加批次。

## 验收标准

- [x] `scripts/tunnel-demo.bat` 在 Windows 可直接执行；缺 cloudflared / 主服务
      未运行时分别给出对应中文提示并以非零码退出
- [x] `scripts/tunnel-demo.sh` 行为等价
- [x] 端口解析：参数 > .env PORT > 18790 默认值
- [x] `npm run typecheck` 与 `npm test` 通过（本改动无 TS/测试代码，验证零回归）
- [x] 文档三处（新文档/README/HTTPS.md）与实际脚本行为一致

## 审计要点

- 脚本不得包含任何凭证/密钥；不得修改监听地址或鉴权逻辑
- 不得把临时 URL 语义描述为"稳定可用"（文档必须明示随时失效）
- 安全提示必须到位：隧道 = 本机服务对公网开放，依赖 S4-1 的密码与登录限速兜底
