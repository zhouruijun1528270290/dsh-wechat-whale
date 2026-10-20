# 部署说明（给 AI 助手看）

你要把这份项目装到用户自己的电脑上，让它成为一个能用的微信聊天机器人。

**用户大概率不懂技术。** 你的任务是：能自己判断的全部自己判断，只在下面第 1 重点名的地方问他。每完成一个阶段，用一句人话说结果，不要贴大段命令输出。

---

## 0. 这是什么

两个常驻 Node 进程 + 一个被反复调用的 DSH 引擎。**项目自己的代码零 npm 依赖**，不需要 `npm install`。

```
微信手机端
   ↕ 腾讯 iLink 机器人接口（长轮询 getupdates）
src/bridge.mjs        常驻：收发 / 去重 / 排队 / 分片 / 限速 / 表情包 / 日报推送
   ↕ 每条消息 spawn 一次（串行，不能并发）
dsh headless          独立 DSH_HOME，读 AGENTS.md（人格 + 记忆段）
   ↕ 每天凌晨
src/distill.mjs       蒸馏记忆 / 梗 / 好感度，写回 AGENTS.md
```

可选：`src/admin.mjs` 提供本地管理台（`127.0.0.1:8787`）。

**这个项目依赖 DSH（DeepSeek Harness）**，用它的 `dsh headless` 做推理。如果用户没有 DSH，见第 12 节。

---

## 1. 先问他三件事（只问这三件）

1. **DeepSeek API key**：去 `platform.deepseek.com` 申请，形如 `sk-...`。不要让他把 key 贴到公开地方。
2. **微信**：装好后需要用手机微信扫一次码，把机器人绑到 iLink 通道。问他「手机在手边吗」。
3. **人设要不要换**：默认是「小鲸鱼」—— 一个爱睡觉、嘴硬心软的鲸鱼妹妹，也叫「本鲸鱼」。如果他想要别的性格（猫、管家、毒舌同事…），先装好能跑，再按第 9 节改。

其余（路径、端口、并行度、预算）你自己按默认值决定，不要问他。

---

## 2. 环境检查

在你的 shell 里跑，逐条确认：

| 检查 | 命令 | 通过判据 |
|---|---|---|
| Node | `node -v` | `v18` 或更高 |
| DSH | `dsh --version` 或找 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js` | 存在即可，0.2.x |
| 目录 | 项目根下有 `src/`、`personas/`、`AGENTS.md`、`config.json` | 都在 |
| 端口 | `netstat -ano \| findstr :8787` | 没被别的程序占用（占用了就改 `admin.port`） |

**缺 Node** → 让他装 LTS 版（`nodejs.org`），装完重开终端。
**缺 DSH** → `npm i -g @deepseek-ai/dsh`，装完确认 `dsh --version` 有输出。

---

## 3. 配置

```powershell
cd <项目目录>
Copy-Item config.example.json config.json
```

逐字段（只列需要动的，其余保持默认）：

| 字段 | 填什么 | 说明 |
|---|---|---|
| `dshBin` | DSH 的 `lib/bin.js` 绝对路径；留空则自动找 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js` | 用户装的路径可能不同 |
| `dshHome` | **`.dsh-home`（项目内）** | **绝对不要指向 `~/.dsh`** |
| `cwd` | `.` | 人格文件 `AGENTS.md` 所在目录 |
| `bili.enabled` | 保持 `false` | 除非用户明确要 B 站日报，见第 10 节 |
| `allowUsers` | `[]` | 空 = 任何人都能加它聊；想只允许自己，填自己的 wxid（登录后在 `state\ilink-state.json` 能看到 `ownerUserId`） |

**为什么 `dshHome` 必须隔离**：机器人会把会话、凭据、记忆全写进那个 home。跟用户日常用的 DSH 混在一起，迟早把用户自己的配置写坏。这是本项目最痛的教训。

---

## 4. 凭据

**把 key 写进项目自己的 home，不要写进 `config.json`**（那份文件是要发给别人看的）。

文件：`<dshHome>/.credentials.yaml`

```yaml
version: 1
refs:
  DEEPSEEK_API_KEY: sk-xxxx
```

**也可以用管理台的「密钥」页填**（起桥后访问 `127.0.0.1:8787/?t=<token>`），它会自己写这个文件。

⚠️ 解析优先级：**环境变量 > `$DSH_HOME/.credentials.yaml` > `<cwd>/.env` > `$DSH_HOME/.env`**。
如果用户的系统环境里已经有 `DEEPSEEK_API_KEY`，文件里写的**不会生效**。桥在 spawn 子进程时会把继承来的同名变量摘掉，但你自己手工测试时要注意这一点。

---

## 5. 起桥 + 扫码

```powershell
.\start.cmd
```

- 首次启动生成 `state\admin-token.txt`
- 管理台：`http://127.0.0.1:8787/?t=<token>`（token 从那个文件读）
- 未登录时会出二维码 → **让用户用手机微信扫**，确认页选「记住我 / 长期」
- 二维码 **2 分钟过期**，页面每 5 秒自动刷新。过期了就让他刷新页面重扫

扫完之后，机器人在微信里就是一个**联系人**，只能私聊。

> 如果 `start.cmd` 一闪就关：见第 11 节第 1 条。

---

## 6. 验收（按顺序跑，全绿才算完）

```powershell
# ① 桥在线
node -e "const s=require('./state/status.json');console.log('online',s.online,'pid',s.pid)"

# ② 已登录（ownerUserId 非空 = 扫过码了）
node -e "const s=require('./state/ilink-state.json');console.log('owner',s.ownerUserId,'token?',!!s.token)"

# ③ 单测（应该全 PASS）
node _probe\test-bili.mjs
node _probe\test-image.mjs
node _probe\test-share.mjs
```

然后让用户**在微信里发一句「你好」**，再查：

```powershell
node -e "const s=require('./state/status.json');console.log('received',s.counters.received,'replied',s.counters.replied,'failed',s.counters.failed)"
```

- `online: true`、`ownerUserId` 非空、`replied` 涨了 → **装好了**，告诉他可以在微信里聊了。
- `received` 涨但 `replied` 不涨 → 看 `logs\bridge-<今天>.jsonl` 尾部，通常是 key 无效（见第 11 节）。

---

## 7. 常驻

`start.cmd` 是守卫循环，退出码含义：

| 退出码 | 含义 | 行为 |
|---|---|---|
| 0 | 用户点了停止 | 不再拉起 |
| 42 | 改了配置要重载 | 重读配置后重启 |
| 3 | 已经有一个在跑 | 单实例锁 `state\bridge.lock` |
| 其他 | 崩了 | 3 秒后自动重来 |

**开机自启**（可选，问他要不要）：

```powershell
.\install-autostart.cmd      # 装
.\uninstall-autostart.cmd    # 撤
```

⚠️ 不要用后台任务/`Start-Job` 长期托管桥：进程被杀时会留下孤儿占着单实例锁，用户下次双击只会看到「已经有一个在跑了」。要停就按 pid 杀干净并删 `state\bridge.lock`。

---

## 8. 人设怎么改

人格文件是两处：

| 文件 | 作用 |
|---|---|
| `personas\小鲸鱼.md` | 完整人格卡（21KB，人看的） |
| `AGENTS.md` 里的 `<!-- PERSONA:BEGIN -->…<!-- PERSONA:END -->` | 运行时真正生效的摘录 |

**改哪一个**：运行时只读 `AGENTS.md` 的 PERSONA 段。改 `personas\` 只是留档，不会生效。

**可以改**：身份、称呼、性格、癖好、口头禅、示例对话。
**不要删**这四块（它们是「像不像人」的关键）：

1. **情绪档位**（互怼 → 嘴硬心软 → 认真）：三级、升档信号、降档条件。
   不要写成「温柔/毒舌」开关 —— 模型会在一句话里同时完成，很假。
2. **说话方式**：1–2 句、整条一个句号都不要、不用 Markdown、口头禅 5–8 轮一次。
3. **少样本后的禁止照抄声明**：每条例句后面必须有「这些句子一个字都不许照抄」。
   没有这行，模型会背课文 —— 我们踩过。
4. **记忆段标记** `<!-- MEMORY:BEGIN -->` / `<!-- MEMORY:END -->`：蒸馏器靠它定位。
   删了标记，蒸馏会**拒绝改写**（故意的，防止它冲掉手改内容）。

**改完要重启桥**（管理台点重启，或退出码 42）。

---

## 9. 如果他要 B 站日报推送

这部分是可选的，而且**要装另一个插件**才完整：

1. 在 DSH 桌面端的插件管理器里装 `dsh-bili-scroll`（它负责定时刷 B 站、读字幕、写日报到 `%USERPROFILE%\.dsh\bili-duty\out\<日期>.md`）。
2. 在它的设置页：填工作区 = 本项目目录（这样它按人设说话）、点「装依赖」、点「扫码登录」用 B 站 App 扫码。
3. 本项目这边把 `config.json` 的 `bili.enabled` 改成 `true`。

推送策略（都是默认值，别乱调）：空闲 20 分钟才发、随机间隔 15–240 分钟、23:30–09:00 静默、一次一条、不带封面图。

**为什么这么保守**：iLink 通道在一条入站消息之后连发到第 5 条就会拒（`-2 prepare failed`），而且是通道级、跟内容无关。所以「一次说一件事」是硬要求。

---

## 10. 改动代码时必须守住的不变量

| 不变量 | 原因 |
|---|---|
| `state\session.json`、`state\users\*` 的会话**不能并发跑** | DSH 不允许两条进程同时开同一个会话 |
| `AGENTS.md` 的写入**必须走 `src\lib\sections.mjs` 的 `spliceSection`** | 这个文件有三个写入者（蒸馏 / 表情包清单 / 人手改），各写各的会互相冲掉 |
| 写 `AGENTS.md` 要「写临时文件 → 校验 → 原子 rename」，写前重读，留 `.bak`，断言无 BOM | 半截文件会让人格整段消失 |
| 表情包清单段（`STICKERS:BEGIN/END`）**是自动生成的** | 手改会被下次同步覆盖 |
| 一个微信气泡里**不能只用单个 `\n`** 分行 | 微信 bot 气泡会把单换行吞成空格，必须 `\n\n` |
| 发送失败**只排队不丢**，通道级错误退避 ≥10 分钟 | 不排队就永久丢；不退避会一直撞限流 |

---

## 11. 错误签名表

| 报错 / 现象 | 含义 | 怎么修 |
|---|---|---|
| 黑窗口一闪就没，伴随 `'xxx' is not recognized as an internal or external command` | `.cmd` 文件是 LF 换行，`cmd.exe` 解析错乱 | 全转 CRLF：`node -e "const fs=require('fs');for(const f of fs.readdirSync('.').filter(x=>/\.cmd$/i.test(x)))fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\r?\n/g,'\r\n'))"` |
| `SyntaxError: Unexpected token '﻿'` / profile 启动即崩 | JSON 被写进了 UTF-8 BOM（文件头 `EF BB BF`） | 用 Node 重写该文件；**永远不要用 PowerShell 的 `Set-Content -Encoding utf8` 写 JSON** |
| `EPERM: operation not permitted, mkdir 'C:\Users\<你>\.dsh\...'` | 没设 `DSH_HOME`，写到用户日常的 DSH 目录去了 | 确认 `config.json` 的 `dshHome` 是 `.dsh-home` 并且桥用绝对路径传下去 |
| 日志里 `dsh: AUTH: Authentication Fails, Your api key: ****0000 is invalid` | key 无效或没生效 | 检查 `.credentials.yaml` 内容；检查系统环境里有没有同名的旧 `DEEPSEEK_API_KEY` 在抢 |
| `iLink 错误 -14` | `context_token` 过期 | 正常现象。等用户再说一句话，token 会刷新；推送逻辑会自动排队重试 |
| `iLink 错误 -2：prepare failed` | 通道级限流（连发太多） | 退避 10 分钟；把一次发送的条数降到 1–2 |
| 收到消息但 `replied` 不涨 | headless 调用失败/超时 | 看 `logs\headless-*.out.jsonl` 与 `logs\headless-*.err.txt` |
| `spawn EPERM` | DSH 沙箱不允许管道 stdio | 子进程输出改用文件描述符：`openSync(out,'w')` + `stdio:['ignore',fd,fd]` |
| 管理台打不开 | 端口被占 / 没在跑 | `netstat -ano \| findstr :8787`；改 `admin.port` |
| 二维码老是过期 | 超过 2 分钟没扫 | 让他刷新管理台页面重扫 |

---

## 12. 绝对不要做的事

1. **不要**把 `dshHome` 指向 `~/.dsh`。
2. **不要**把 API key 写进 `config.json`。
3. **不要**用 PowerShell 写任何 JSON（BOM）。
4. **不要**手改 `AGENTS.md` 的表情包段（会被覆盖）或删记忆段标记（蒸馏会拒绝工作）。
5. **不要**承诺头像、群聊、撤回、主动加好友 —— iLink 通道根本没有这些端点（只有 9 个：`get_bot_qrcode` / `get_qrcode_status` / `getupdates` / `getconfig` / `sendtyping` / `sendmessage` / `getuploadurl` / `msg/notifystart` / `msg/notifystop`）。
6. **不要**用后台任务长期托管桥（会留孤儿进程占锁）。
7. **不要**在没有入站消息的情况下设计「定时主动推送」—— 没有 `context_token` 发不出去。
8. **不要**一次性连发超过 4 条消息。
9. **不要**替用户装或改 DSH 的 profile 文件（`~/.dsh/profiles/*`），那是应用独占的，绕过它等于跳过版本兼容检查。

---

## 13. 能力边界（提前跟用户说清，别让他期待落空）

| 做不到 | 原因 |
|---|---|
| 换头像 | 接口没有改资料的端点，只能换 bot 账号（会丢登录态和会话） |
| 群聊 | iLink 机器人只有私聊 |
| 撤回消息 | 没有这个端点 |
| 主动加好友 / 起会话 | 只能等对方先说话 |
| 出站语音条 | 接口接受、微信客户端不渲染（我们实测 4 种变体都被静默丢弃） |
| 朋友圈 | 没有 |

**能做到**：文字、图片（收 + 发）、分享卡片里的链接、表情包发送、跨天记忆、好感度、时间感、文件/日报推送。

---

## 14. 如果没有 DSH

只有一个函数要换：`src/bridge.mjs` 里的 `runHeadless()` —— 它的契约是「给一段文本任务，返回一段文本」。任何模型 API 都能顶替，人格卡和记忆机制跟 DSH 无关，DSH 只是省了上下文管理和工具调用。

换的时候注意保留：串行调用（同一会话不能并发）、超时、`--json` 那种结构化输出的解析位置。

---

## 15. 完成标准

- [ ] `node -v` ≥ 18，`dsh` 可用
- [ ] `config.json` 存在，`dshHome` 是项目内的 `.dsh-home`
- [ ] `.credentials.yaml` 里有有效的 `DEEPSEEK_API_KEY`
- [ ] `state\status.json` 的 `online` 为 `true`
- [ ] `state\ilink-state.json` 的 `ownerUserId` 非空（扫过码）
- [ ] 微信里发一句话，`counters.replied` 增加
- [ ] 三个单测文件全 PASS
- [ ] 用户知道怎么停（关掉那个黑窗口，或管理台点停止）

全绿 → 用一句人话告诉他「可以了，微信里跟她说话就行」，然后**不要再动配置**。
