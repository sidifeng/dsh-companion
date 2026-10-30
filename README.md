# DSH Companion

专门服务于 QQ 官方机器人的 DeepSeek Harness 插件。默认是自然、温和的朋友，不固定名字。使用官方 AppID/AppSecret，不登录个人 QQ，不依赖 OneBot。

当前为 **0.3.0-alpha.2 预览版**，面向 DSH **0.2.1-rc.2**、Node.js **>=22.13**。安装时默认关闭，配置并停用旧 QQ 接入后启用。不是腾讯或 DeepSeek 官方产品。

## 能力与验证范围

| 能力 | 当前实现 |
| --- | --- |
| 私聊、群聊 | 官方 WebSocket；仅 OpenID 白名单，群聊默认需要 @；真实收发已验证 |
| 连续短消息 | 默认最多 3 个气泡、间隔 1.2 秒；群聊两个独立气泡已验证 |
| 图片 | 本轮附件交给已配置的视觉模型；QQ 私聊识图已验证 |
| 长期记忆 | SQLite 持久化，明确保存、自动整理、更正、删除和关闭自动记忆；QQ 自动整理已验证 |
| 人物关系 | 按人和场景积累熟悉度、缓慢衰减的情绪；不因缺席惩罚用户 |
| 视频 | FFmpeg 抽取最多 3 个时间点，再调用视觉模型；默认仅前 180 秒。QQ 视频描述已验证；不分析音轨，不代表连续观看 |
| 语音 | 本机 WAV 转 QQ SILK 后发送；QQ 私聊接收和播放已验证 |
| B站 | 热门、BV 标题/简介、公开字幕、公开短视频画面抽样；限 180 秒/25 MB、无需登录付费的单段 MP4。QQ 画面描述已获用户确认 |
| 唱歌 | 本机 ACE-Step.cpp 音乐规划模型生成音频编码，再合成原创中文短歌并转 SILK 发送；默认 30 秒。RX 6800 XT 约 16 秒生成 29 秒样本；用户已确认新版 QQ 语音能正常播放、听清唱词 |
| 自主浏览 | 后台从公开热门列表挑选未看过的短视频，抽帧、记录所见和感想；每两小时一次、每天最多七次尝试；真实单次浏览及 QQ 动态展示已获用户确认，尚无连续多日运行数据 |
| 主动聊天 | 独立官方主动消息，不借用旧消息 ID；按时区、安静时段、间隔、每日预算和平台权限决定是否发送。定时群主动已获用户确认；默认关闭，管理员配置后启用 |

自主浏览限公开短视频画面抽样，不登录 B站账号，不点赞、评论或关注；完整音视频理解尚未完成，唱歌限短片段。自主活动依赖宿主持续运行，不会在电脑关机时工作。

## 安装与更新

源码：[sidifeng/dsh-companion](https://github.com/sidifeng/dsh-companion)。

### 已安装 dshmarket 的用户

可先在宿主「插件 → 添加插件」中填入 `github:sidifeng/dsh-companion`，或使用官方命令：

```powershell
npx @deepseek-ai/dsh plugin --profile web add github:sidifeng/dsh-companion
```

保留 GitHub 来源后，进入「插件市场 → 已安装」检查更新，点击本插件的更新按钮。dshmarket 会比较 GitHub 上的版本/提交。`link:` 本地开发目录不支持在线更新，必须先切换到 GitHub 来源。安装代码是原生 ESM，无须运行安装构建脚本。

发现页搜索使用社区目录，需先通过收录审核；本仓库刚创建，按目录要求满一天后才能提交。准备好的条目在 `catalog/sidifeng__dsh-companion.yml`。没有被收录之前，不能承诺默认发现页已能搜索到。

### 使用 DSH 官方 format 1 索引的用户

在支持自定义索引来源的官方插件发现页添加：

```text
https://raw.githubusercontent.com/sidifeng/dsh-companion/market-index/index.json
```

刷新来源，搜索 `dsh-companion`，选择版本安装。**此来源属于官方 format 1 格式，不能直接作为 dshmarket 的社区目录。** 上传 GitHub 不等于自动进入默认市场。

每版固定指向完整 Git 提交 SHA。保留这个索引来源，新版发布后刷新市场并选择新版更新。数据库放在独立数据目录，不随代码更新覆盖。

维护者修改代码后，提高 `package.json` 和锁文件中的版本号（例如 `npm version 0.3.0-alpha.3 --no-git-tag-version`），更新 `RELEASE_NOTES.md`，提交并推送 `main`。Actions 在 Windows/Linux 检查通过后自动更新 `market-index` 分支并创建预览 Release。只上传代码、不提高版本号，不会覆盖已经发布的版本。工作流使用 GitHub 短期令牌，无需上传 QQ 密钥。

## 配置

1. 停用原 `im-qqbot`、个人 QQ 桥接和其他重复回复入口，保留备份。
2. 在本机填写 AppID/AppSecret、DeepSeek provider/model 和测试 OpenID 白名单。数字 QQ 号、群号不能代替 OpenID；私聊与群聊身份不做推测性合并。
3. `companion.dataDir` 指向稳定数据目录；视觉使用 `vision.enabled/provider/model`，需要实际支持图片的模型。
4. 启用 `enabled`，先验收白名单范围。

新增配置字段示例：

```yaml
companion:
  persona: 自然、温和的朋友，没有固定名字。没有依据时不假装记得。
  autoMemory: true
  maxMessages: 3
  intervalMs: 1200
  turnTimeoutMs: 120000
voice:
  enabled: false
  baseUrl: http://127.0.0.1:8765
  voice: huayan
  maxChars: 120
video:
  enabled: true
  ffmpegPath: ffmpeg
  frames: 3
  maxSeconds: 180
bilibili:
  enabled: true
singing:
  enabled: false
  baseUrl: http://127.0.0.1:8085
  synthModel: acestep-v15-turbo-Q8_0.gguf
  lmModel: acestep-5Hz-lm-0.6B-Q8_0.gguf
  maxSeconds: 30
  timeoutMs: 105000
```

语音是独立的本机服务，不随插件打包。兼容接口：`POST /v1/speak/file` 接收 `{text,voice,format:"wav",sr:24000,cache:true}`，返回 WAV 字节。只接受 loopback 地址；服务未启动时如实报错。单段最多 60 秒。视频需要另装 FFmpeg 或填写可执行文件绝对路径。

### 自主聊天与浏览

以下是仅向白名单群主动发言的示例；启用前填写管理员的官方私聊 OpenID。私聊主动发送默认关闭，也不能用聊天命令打开。

```yaml
autonomy:
  enabled: true
  groupEnabled: true
  privateEnabled: false
  browseEnabled: true
  operatorIds: [] # 填本机管理员的官方私聊 OpenID，不填数字 QQ 号
  timezone: Asia/Shanghai
  quietStart: 23
  quietEnd: 9
  chatIntervalMinutes: 30
  groupDaily: 28
  privateDaily: 0
  idleMinutes: 3
  browseIntervalMinutes: 120
  browseDaily: 7
  interests: 猫、生活、科普、音乐
```

每半小时提供一次群主动聊天机会，最多一条短消息；群内三分钟内有消息、正在回复、没有新话题或处于安静时段时跳过。没有新视频时可聊普通兴趣话题；有值得分享的真实画面记录时可分享该经历，并附 BV 号。群主动生成不读取任何人的私聊记忆。最近主动消息会进入该群的聊天上下文，用户追问时能接上。

浏览每两小时挑选一个未看过且符合时长限制的视频，下载成功并经视觉模型观察后才记录所见。每天最多七次尝试，包括失败；手动测试也计入每日浏览预算。点播看过的视频同样参与去重。历史版本未建立统一浏览记录，不自动猜测或重建旧观看历史。

主动发送使用 QQ 官方不带 `msg_id` 的消息接口。先查询群内 `allow_proactive_msg`；接口不可用时以真实发送结果为准，平台拒收或群内关闭主动推送后会暂停该目标，管理员处理后再用 `/群主动 开` 恢复。具体权限与额度以 [官方群消息文档](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)、[单聊消息文档](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html) 为准。发送不确定不重试，也不会伪装成被动回复或绕过群开关。

`autonomy.sqlite` 单独保存公开浏览经历、目标活动时间、开关和主动发送账本。限额和间隔在调用前持久化；重启不重发未确认消息，不补发停机期间积压。关闭开关会取消生成，但已经提交网络的消息无法撤回。后台模型调用使用当前 DeepSeek/视觉服务，不属于免费离线模型。

### 本地唱歌服务

使用 [ACE-Step.cpp](https://github.com/ServeurpersoCom/acestep.cpp) 的 Vulkan 后端；本机验证版本为 `de858d8 (2026-10-16)`。按上游 README 获取 Windows 程序及 Vulkan/CPU DLL，在独立模型目录放入 [GGUF 模型](https://huggingface.co/Serveurperso/ACE-Step-1.5-GGUF/tree/main)中的 `Qwen3-Embedding-0.6B-Q8_0.gguf`、`acestep-v15-turbo-Q8_0.gguf`、`vae-BF16.gguf`、`acestep-5Hz-lm-0.6B-Q8_0.gguf`，共约 4.38 GB。下载后对照模型仓库 SHA256 校验。歌词由 DeepSeek 创作；本机 `/lm` 负责生成音乐音频编码，随后 `/synth` 合成声音。alpha.3 只用直接扩散，实测出现伴奏或无词哼唱；升级后需补充 LM 文件，不能把能播放音频视为唱词已通过。

在程序目录启动，替换模型目录为自己的绝对路径：

```powershell
.\ace-server.exe --host 127.0.0.1 --port 8085 --models "D:\models\ace-step" --device Vulkan0 --max-batch 1
```

确认 `/health` 正常、`/props` 列出的模型名与配置一致，再启用 `singing.enabled`；`video.ffmpegPath` 同时用于歌声转码。引擎只绑定本机，一次生成一段；取消或超时会请求终止原生任务。生成时间取决于硬件和片段长度，语音消息会压缩音质，歌词发音与音乐质量仍由生成模型决定。它不会承诺翻唱整首歌曲。模型、程序和音频不进入 GitHub 发布包。

## 聊天命令

- `记住：我喜欢橘猫` 或 `/记住 内容`：明确保存。
- `/记忆`：列出记忆及 M1、F1 等编号。
- `/纠正 F1 新内容`、`/忘记 F1`、`/忘记全部`：只修改本人当前场景资料，并切换到新上下文。
- `/自动记忆 关` 或 `/自动记忆 开`；`/关系`；`/帮助`。
- `/语音 你好，今天过得怎么样`：生成并发送语音。
- `/唱歌 给我唱一段关于晚风和星光的原创短歌`：启用本地引擎后生成短歌。
- `/回传附件`：回传本轮图片/视频，用于权限验收。
- `/取消`：取消本人正在处理的任务；已发出的消息不能撤回。
- `/自主动态`：查看最近的公开浏览记录和感想。
- 管理员私聊：`/自主状态`、`/自主浏览 开或关`、`/群主动 开或关`。
- 管理员私聊：`/刷B站一次`（跳过两小时间隔，仍计入每日预算）、`/主动试聊`（仍遵守安静时段和主动发送预算）。

也可自然地请求看图、描述短视频、发语音或读取 B站公开资料。

## 记忆与数据

按 AppID、场景、目标和发送者隔离记忆与模型上下文。自动整理每轮额外调用一次 DeepSeek，最多 5 条事实，要求当前原文证据、本人归属和较高置信度；仍可能误记，可查看、更正和删除。不把模型回复当作用户经历。检索在权限过滤后，从最多 400 条近期候选选出 6 条。

关系状态只控制表达，不奖励隐私披露。自动记忆开启时每 24 次已整理交流换一段上下文，靠长期记忆延续资料；关闭后不产生新事实和关系评分。

目前关系状态是简单的熟悉度与情绪惯性；尚无经长期验证的关系学习、跨场景身份确认或大规模语义记忆检索。自主经历能增加聊天连续性，但不代表具有意识或真人式情感。群内非 @ 消息只用于记录最近活动时间、避免打断，不自动提取全群话题或成员资料。

后续提升陪伴体验的重点是：跨措辞的语义记忆检索和旧事回访、连续群话题理解、根据长期相处缓慢变化的关系与表达策略。当前也尚未接入入站语音转写、视频音轨理解、可控情绪语音或无人值守的开机启动。半小时是主动发言上限；高频本身并不等于自然，实际体验仍需连续使用验证。

默认目录为 `$DSH_HOME/companion/<AppID哈希>/memory.sqlite`，未设置 DSH_HOME 时用 `~/.dsh`。Schema 1 升级至 2 前自动创建一致性备份；旧代码不能直接读取更高 schema，回退需停止宿主并恢复对应备份。

忘记命令删除本插件的活动记忆及相关修订记录，旧会话不再作为当前上下文使用；**不删除 DSH 历史日志、备份或已发送的 QQ 消息**。备份含历史记忆，由设备所有者管理。

媒体保存在数据目录 `media/`，启动及每小时清理超过 24 小时的自有 UUID 文件。下载限制大小、超时和公网地址，禁止重定向。QQ 工具仅能读本轮附件，不能调用宿主终端或任意文件工具。

发送次数和序号持久化，文字与媒体共用预算。发送不确定时不重发，被动窗口过期不转主动消息。取消能阻止后续发送，已提交网络的请求可能已经送达。

## 开发与启动

```powershell
npm ci --ignore-scripts
npm run check
npm test
npm run demo
```

腾讯内部接口集中在 `src/upstream.js`，锁定 0.5.3；升级需重新验收。`DSH_TEST_HOST_PACKAGE` 配合 `node --import ./scripts/use-host.mjs --test` 可使用实际宿主模块验证。自动测试中的 QQ/模型是模拟对象，不代表账号权限已通过。

正常启动：`npx @deepseek-ai/dsh web`。源码目录的 Windows 用户也可双击 `启动机器人.cmd`：如果 3080 已由 DSH 使用，直接打开现有页面；其他程序占用时停止并提示，不另起重复实例。若存在本机自建的 `.local/acestep/start-local-services.ps1`，会先调用它恢复本地语音/唱歌服务；其他安装者需自行启动这些服务。

报 `EADDRINUSE 127.0.0.1:3080` 表示已有进程监听。源码更新需重载后端，仅刷新网页不会加载新代码；dshmarket 更新后的“立即重启”已验证。关闭网页不等于关闭 DSH，电脑关机后仍需重新启动 DSH 和本机服务。

## 来源

- [腾讯 QQ 插件](https://github.com/tencent-connect/dsh-qqbot)、[QQ 开放平台](https://bot.q.qq.com/wiki/)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- 第三方许可证见 `THIRD_PARTY_NOTICES.md` 和各依赖包。
