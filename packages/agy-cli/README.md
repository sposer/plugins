# agy-cli

把本机的 Antigravity CLI（`agy`）接成 Magpie 里的一个模型 provider。OpenCode、Claude Code
等客户端经由 Magpie 发送 Anthropic Messages 请求；插件启动 `agy` 的原生交互终端（TUI）生成回复。
模型能否使用由 agy 和 Google 决定。

**[English → README.en.md](README.en.md)** ｜ 来源、版权与迁移说明见 [NOTICE.md](NOTICE.md)

## 环境要求

- 运行插件的主机必须是 Linux，并在 `/usr/bin/script` 提供 util-linux 版 `script`。客户端不受这个平台限制。
- 需要 Antigravity CLI（`agy`）；原生 TUI 已用 agy 1.5.18 在隔离环境验证。
- 需要 Magpie 0.1.4246 或更新版本。

## 安装与使用

在 Magpie 的 Plugins 页找到「Antigravity (local agy CLI)」点安装，或在终端运行：

```sh
magpie plugin add @magpie-community/opencode-agy-cli-auth
```

如果还没安装 agy，Magpie 的 **Sign in** 会先下载 Google 官方安装脚本使用的发行包，校验
SHA-512 后安装到 `$XDG_DATA_HOME/magpie-agy-cli/agy`（默认 `~/.local/share/magpie-agy-cli/agy`）。
已有的 agy 优先使用。插件只更新自己安装且正在使用的副本，不会替换你自行安装的 agy。

1. 在 Magpie 的 Providers 页找到 `agy-cli`，点 **Sign in** 并选择登录方式：
   - **使用 Google 登录**：复用 agy CLI 已有的文件令牌或显式配置的 ADC 凭据。仅存于系统钥匙环的登录不能复用，插件会发起新的原生登录。
   - **添加另一个 Google 账号**：始终发起新的原生登录，不改已有账号。
   - **OAuth 配置授权登录**：按表单填写 OAuth 客户端、已注册的回调地址和权限范围，
     或留空使用 agy 的默认配置。
   - **填写 OAuth Token 登录**：填入 Google OAuth 刷新令牌及对应的客户端配置，插件会在保存前检查令牌能否刷新。

   发起新的原生 Google 登录时，插件主机须运行 Linux，且插件所用的 Bun 须支持 `Bun.Terminal`。
   插件在 agy 的交互终端菜单中选择 **Google OAuth**；手动打开 Magpie 显示的授权链接，登录后把
   授权码或完整回调 URL 粘贴回 Magpie。复用已有 CLI 凭据、配置式 OAuth 和文件导入不需要启动这个登录终端。
2. 在客户端选用 `agy-cli/<模型>`。agy 为同一模型的不同思考等级提供多个 ID 时，Magpie 将它们
   显示为一个模型的多个变体。插件按 Magpie 选定的等级映射到最接近的 agy ID，不从翻译后的 token
   预算反推；直接指定带档位的模型 ID 则固定该档位。

通过新登录或文件导入添加的账号使用 `~/.local/state/magpie-agy-bridge/accounts/`（或
`$XDG_STATE_HOME` 对应位置）下独立的 agy 主目录，不改用户原有凭据。插件用 `agy models`
验证账号能否列出模型。模型和额度查询使用所选账号；生成时，临时终端使用该账号的文件令牌
或已配置的 ADC 凭据。登录成功不代表账号具备某个模型的资格。

已退役 Antigravity 插件（`antigravity`）的账号仍可用 **Move** 迁入。
**Import accounts from a file…** 接受该插件的登录记录或 agy 的 `antigravity-oauth-token` 文件。
账号通过 agy 检查后才加入；已有邮箱不会重复添加。取消导入只清理本批未保存的账号目录。

## 模型与额度

模型目录来自各账号的 `agy models`。成功列出的目录缓存在
`~/.local/state/magpie-agy-bridge/models.json`（或 `$XDG_STATE_HOME` 对应位置）。agy 支持
`--settings` 时，插件传入 `{"modelProvider":""}`，按 Google 账号列出模型，不沿用用户设置里的
AI Studio 密钥。AI Studio 密钥可以在 Magpie 的 Providers 页作为 Google Gemini 添加。

```sh
magpie quota agy-cli --json
magpie quota refresh agy-cli --json
```

额度数据来自所选账号的 agy `/usage` 报告，按模型组列出订阅窗口。没有可测量数据的窗口显示 “Limits not available”，而不是 0% 或 100%。额度查询不改写凭据；查询结果仅供查看，不会主动拦截生成请求。

登录令牌临近过期或 agy 因地区限制拒绝 `/usage` 时，插件直接向 Google 查询配额，并只在内存中续期访问令牌。地区限制导致的查询再次失败时，显示 agy 的拒绝原因，不显示数字。没有可用登录态时，后台查询不会启动交互登录。其他额度查询失败后从 10 分钟起退避，每次翻倍，最长 6 小时。

## 原生 TUI

- **回合与隔离**：每个新用户回合启动一个临时 agy 终端，在提示词字节预算内重放历史。终端使用独立主目录和工作目录，不加载原主目录的设置和 MCP 配置。回合结束后清理进程及临时目录。历史中的控制字符以 Unicode 控制图形（如 `␛`）作为普通文字送入编辑器。
- **工具**：插件通过私有 MCP 连接把 agy 的原生调用转给客户端执行。agy 逐个发出调用；每次收到匹配的 `tool_result`，原生回合继续。工具结果包含图片时，插件会将实际结果和图片放进一个新的原生回合。原生回合已结束、已让出名额或属于另一会话时，工具结果同样在新原生回合里随历史重放。
- **用量**：每个响应报告自上一个响应以来完成的原生步骤的输入、输出和缓存读取 token；没有新步骤的响应报告 0。agy 不记录缓存写入量，`cache_creation_input_tokens` 恒为 0。
- **图片**：接受内联 base64 的 PNG、JPEG 和 WebP，不接受 GIF 或图片 URL。agy 通过剪贴板入口接收附件，将其放在整段文字后；插件在图片原位置加上序号。
- **流式输出**：客户端请求流式输出时收到 SSE。agy 在工具步骤里记录了思考时，插件随该步骤的第一个工具调用返回，不等整个回合结束。正文和思考都来自已完成的转录条目，不是逐 token 推送。终端可能把制表符展开成空格。
- **结构化输出与助手预填**：结构化输出采用提示词指令，上游不强制校验 schema。请求以纯文本 assistant 消息结尾时，插件把文本加到提示词末尾，请模型接着写，不是原生 assistant 前缀。与未应答工具调用或同轮 `tool_result` 一起提交的预填可能被拒绝。

agy 只读文字和图片。文本文档（纯文本或 base64 的文本、JSON、XML）按文字发送；URL 文档只发送网址。直接附上的 PDF 返回 HTTP 400，请改为粘贴文字或把页面作为图片附上。工具结果中的 PDF 会转成提示，请模型另行提取文字。

## 并发与超时

- 插件最多同时运行 16 个生成回合，可用 `AGY_BRIDGE_MAX_PROCS` 调整。等待工具结果的回合占用一个名额。名额用满时，客户端持有工具调用最久且超过 30 秒的回合让出名额，该客户端之后送回的结果在新原生回合里重放。
- 回合超时限制原生回合连续多久没有新的转录条目，等待客户端工具结果的时间不计入；单个工具结果另有等待上限。agy 启动和接收提示词各最多 30 秒。超时返回 HTTP 504。
- Magpie 的 Providers 页有单独的 **Concurrency** 设置，默认 16，可填 0–1000，0 表示不限制 Magpie 的并发。插件没有空余名额时返回 HTTP 503；提高页面并发不会提高插件上限。

## 环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `AGY_PATH` | 按 PATH 查找 | 指定 agy 可执行文件 |
| `AGY_BRIDGE_MAX_PROCS` | 16 | 同时运行的生成回合上限 |
| `AGY_BRIDGE_TURN_TIMEOUT_MS` | 300000 | 原生回合没有新转录条目的最长时间（毫秒），不含等待工具结果 |
| `AGY_BRIDGE_TOOL_TIMEOUT_MS` | 1800000 | 原生回合等待单个客户端工具结果的最长时间（毫秒） |
| `AGY_BRIDGE_MAX_PROMPT_BYTES` | 114688（112 KiB） | 重放历史提示词的字节预算 |
| `AGY_BRIDGE_THINKING` | 开启 | 设为 `0` 不返回 `thinking` 块；单次请求也可指定 `thinking: { "type": "disabled" }` |
| `AGY_BRIDGE_EFFORT` | 未设置 | 强制思考等级：`minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `AGY_BRIDGE_USAGE_TIMEOUT_MS` | 15000 | 额度查询的总时间预算（毫秒），最高 18000 |
| `AGY_BRIDGE_STORED_SIGNIN` | 未设置 | 设为 `skip` 时插件不读 agy 存的登录 |
| `AGY_BRIDGE_PREFILL` | 开启 | 设为 `0` 时拒绝助手预填并返回 HTTP 400 |
| `AGY_BRIDGE_PREFILL_CARRIER_NOTE` | 英文提示行 | 自定义预填文本前发给模型的提示行 |
| `AGY_BRIDGE_MCP_TRACE` | 未设置 | 将 MCP 通道流量写入指定文件，仅用于排查 |
| `AGY_BRIDGE_EVENTS` | 开启 | 设为 `0` 时不向 stderr 写 `[agy-bridge]` 回合事件；事件不含提示词、参数和结果，每分钟最多 30 行 |
| `AGY_CLI_DISABLE_AUTO_UPDATE` | 插件启动的 agy 默认设为 `true` | 避免生成进程并发更新同一个可执行文件；用户已设置时保留该值 |

## 常见排查

- **找不到 agy**：确认 `agy` 在插件主机的 PATH 里，或将 `AGY_PATH` 指向可执行文件。
- **无法启动 TUI**：确认插件运行在 Linux 上，且容器或主机的 `/usr/bin/script` 来自 util-linux。
- **“You do not have a valid license of this product”**：这是 agy 报告的账号资格拒绝。用相同账号核对 `agy models` 的结果。
- **工具结果返回 HTTP 409**：同一原生回合还有请求在读取时又收到了它的工具结果，通常是客户端在上一个请求结束前重试。等上一个请求结束后再送回结果。
- **HTTP 504**：错误信息区分 agy 未就绪、未接收提示词和回合无进展。stderr 中 `[agy-bridge]` 的 `turn_end` 行给出 `reason`、`phase` 和各阶段耗时。
- **额度显示 “Limits not available” 或报版本错误**：前者表示该窗口没有可测量数据；报告版本过低时请将 agy 更新至 1.1.11 或以上。

## 开发

在仓库根目录运行：

```sh
bun test packages/agy-cli
bun scripts/check.mjs agy-cli
```

## License

MIT。版权声明见 [LICENSE](LICENSE)，上游来源与逐项变更见 [NOTICE.md](NOTICE.md)。
