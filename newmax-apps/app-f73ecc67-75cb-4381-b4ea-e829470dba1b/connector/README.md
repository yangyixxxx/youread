# Python 本地 YouTube 连接器

此连接器独立于 NewMax frontend/backend action 运行。2026-10-15 按用户要求新增**当前 Windows 用户登录静默启动**；不安装系统服务，不自动调用 AI。关闭 NewMax 窗口不等于停止连接器。

## 启动与停止

常规入口：`enable-connector-autostart.cmd` 安装当前用户 Startup 快捷方式并立即静默启动。快捷方式直接运行 `.venv/Scripts/pythonw.exe -I -X utf8 connector/background.py`，没有常驻控制台；设置中的「停止后台更新」通过认证 `/shutdown` 优雅结束，队列保留。`disable-connector-autostart.cmd` 只取消下次登录启动，不结束当前进程。手动恢复使用 `start-connector-silent.vbs`。启动失败请查应用数据目录 `connector/background.log`（512 KB 轮转，保留两份）。进程异常退出后可手动恢复，下次登录也会启动；未实现系统服务或无限自动重试。

`manage-connector.ps1 -Action Enable|Disable|Start|Stop|Status` 管理当前安装；测试可传独立 `-DataDir` 与 `-StartupDirectory`，绝不能针对真实用户资料执行测试删除。重复启动的健康检查、background.lock 和 instance.lock 防止重复实例。后台启动不安装依赖，不结束未知占用进程。

以下为**可见终端诊断/依赖修复方式**（并非日常必需）：在本应用目录双击 `start-connector.cmd`，或在 PowerShell 中运行：

```powershell
.\start-connector.cmd
```

启动脚本使用 `connector/.venv`，缺少环境时创建独立虚拟环境，缺少指定依赖时安装 `connector/requirements.txt`。已验证 Python 3.12.8、Node 22.23.1、`yt-dlp[default]==2026.8.19`；default extras 包含本地 EJS 包，不远程下载脚本。脚本不每次更新依赖、不安装 Skill、不更改系统自启动配置。CMD 中的 PowerShell 执行策略参数仅作用于该次进程，不修改系统策略。

保留启动终端。**按 Ctrl+C 停止**；正常退出会中止活动网络子进程，保留待处理任务，以便下次启动恢复。也可以关闭该终端；强制终止时磁盘上的 pending/syncing/fetching 状态在下次启动恢复。单实例文件锁防止重复实例同时写入；端口被占用时明确报错，不换端口或暴露到局域网。

开发者可直接启动前台诊断服务：

```powershell
.\connector\.venv\Scripts\python.exe -I -X utf8 .\connector\server.py
```

只有显式测试需要才使用 `--data-dir <临时应用数据目录>`；它仍只监听 `127.0.0.1:18743`，无法通过参数更改监听地址或端口。

## 数据与安全

固定应用数据目录：

```text
C:/Users/admin/.newmax/app-data/app-f73ecc67-75cb-4381-b4ea-e829470dba1b
```

连接器只写其中的：

- `connector/connection.json`：`{url,token}`，256-bit 随机 token，首次成功绑定服务后写入；后续启动复用已有 token，不在控制台、HTTP 错误或源码中输出。
- `connector/library.json`：频道、视频、同步设置、状态与内部去重信息。
- `connector/transcripts/<videoId>.json`：字幕正文与标准化时间段。
- `connector/instance.lock`：进程存活期间的文件锁，文件本身无需手动删除。

原子临时文件替换、写前 fsync、进程锁和线程锁保护持久化；已有资料不自动删除，损坏资料库/连接凭据会拒绝启动而不是静默覆盖。文件位于用户独立应用数据目录，继承该目录的系统访问权限；不要共享这个目录或 token。

服务只绑定 IPv4 `127.0.0.1`。Host 必须精确为 `127.0.0.1:18743` 或 `localhost:18743`。所有业务端点（包括 health、未知路径）均要求：

```http
Authorization: Bearer <从 sdk.files 读取的本地 token>
```

CORS 只允许序列化的 `null` origin，以及 HTTP(S) localhost、127.0.0.1、[::1] origins；不允许远程网站、用户信息、路径或伪造 localhost 后缀。**唯一无认证例外是浏览器 CORS OPTIONS 预检**：浏览器不会在预检中发送 Bearer token，故合法 Host/origin/method/header 的预检返回空 204，仅声明允许的头与方法，不返回数据。无 token 的真实请求始终 401，包括来自 null origin 的请求。

请求 JSON 上限 8 KB、16 个同时 HTTP 连接、连接读超时 5 秒。输入仅接受 `@handle`、UC 频道 ID、YouTube 的 `/@handle`、`/channel/UC…`、`/c/name`、`/user/name` 频道主页（可带 videos/shorts/streams/featured 末尾标签）。拒绝其他域、端口、凭据、查询参数、片段、视频和播放列表 URL；抓取 URL 重新构造，不将用户输入拼接到 shell。

不读取浏览器 Cookies、不使用账号凭据、不下载音视频、不绕过登录或访问限制。yt-dlp 通过隔离 Python 子进程和参数数组调用，HTTP 日志、第三方 stderr 和异常详情均不外泄。字幕下载限 HTTPS YouTube/Googlevideo 域名，每次重定向也校验域名，限 8 MB。

## 同步规则

- 添加频道立即持久化并返回 202，外部请求由单个 worker 异步执行，不在 HTTP 请求线程抓取。
- 默认每 30 分钟检查；worker 每 15 秒检查到期状态，已排队/执行的工作不重复加入。
- yt-dlp flat playlist 最多读取最新 20 个条目，不抓取频道全部历史。
- 每次成功同步最多对 **3 条首次发现的新视频** 自动获取字幕。已有失败视频不会每轮自动反复抓取，用户可点击字幕重试。
- handle 忽略大小写去重；UC ID 保留大小写。解析得到 canonical channel ID 后合并同一频道的不同输入，保留已有频道 ID，将视频归属迁移到保留项。
- 视频按 YouTube video ID 去重。取消订阅保留已抓取视频和字幕；进行中的频道结果不会复活已取消的订阅。重订阅时重新关联保留视频。
- 中英文优先，同一语言组人工字幕优先；支持 json3 和 VTT，剔除自动翻译轨道。滚动字幕按相邻段落的前后重叠去重，保留远处的真实重复内容。
- flat 响应无法提供精确发布日期时 `publishedAt: null`，不伪造日期或字幕。
- 单次连接 socket timeout 12 秒，常规/提取器重试各最多 1 次。整个频道子进程上限 75 秒，字幕子进程上限 90 秒。
- 网络失败、不可访问内容、无字幕和解析失败都有中文可恢复状态；异常不会阻塞后续队列。关闭时打断的工作恢复为 pending。

## API（与 BUILD_PLAN 的精确对接）

所有非 OPTIONS 请求都需 Bearer；JSON 请求需 `Content-Type: application/json`。

| 方法与路径 | HTTP/返回 |
|---|---|
| `GET /health` | 200 `{ok:true,version,workerRunning,pid,background}` |
| `POST /shutdown` `{}` | 200 `{ok:true,stopping:true}`，沿用全部认证/Host/CORS/请求体限制，优雅关闭 worker |
| `GET /library` | 200 `{channels,videos,settings,lastSync}`；本地写入失败时额外返回中文 `error` |
| `POST /channels` `{url}` | 202 `{ok:true,channel,duplicate}`；重复输入仍返回 202，不增加重复任务 |
| `POST /sync` `{channelId?}` | 202 `{ok:true,queued}`；空 body、`{}` 或 `channelId:null` 均同步全部已订阅频道 |
| `DELETE /channels/:id` | 200 `{ok:true,retainedVideos:true}` |
| `PATCH /settings` `{intervalMinutes?,autoCaptions?}` | 200 `{ok:true,settings}`；间隔为 5～1440 的整数分钟，自动字幕开关为 boolean |
| `POST /videos/:id/transcript` | 202 `{ok:true,videoId,status}`；支持失败/无字幕重试；已 ready 不重复抓取 |
| `GET /videos/:id/transcript` | 200 `{segments:[{start,end,text}],language,source,raw,format}`；未就绪 409 |

通用频道字段严格保留：`{id,url,title,youtubeId,status,error,lastSync}`，状态 `pending/syncing/ready/error`。`id` 为本地稳定标识，不等同于 YouTube channel ID；`youtubeId` 在解析完成前为 null。合并别名时后添加的频道可能从下次 `/library` 消失，前端应以返回的频道列表为准。

通用视频字段严格保留：`{id,title,channelId,channelTitle,url,publishedAt,duration,thumbnail,transcriptStatus,transcriptError}`；状态 `none/pending/fetching/ready/unavailable/error`。`publishedAt` 是 UTC ISO 字符串或 null，duration 为秒或 null。字幕 `start/end` 为秒，source 为 `manual/automatic`，format 为 `json3/vtt`。内部下划线字段不通过 `/library` 返回。

错误统一为：

```json
{"ok":false,"code":"NETWORK_TIMEOUT","error":"YouTube 请求超时，请检查网络后点击重试。","retryable":true}
```

常见 HTTP：400 参数无效，401 凭据缺失/不匹配，403 Host/origin 不允许，404 记录/接口不存在，409 字幕未就绪，413 请求过大，415 Content-Type 错误，500 本地存储错误。异步外网失败体现为 `/library` 的频道 `error` 或视频 `transcriptError`，不是伪造 200 成功数据。`POST /sync` 和字幕 POST 是重试入口。

**无协议端点删除/改名。补充点**：明确了上述 POST/PATCH/DELETE 响应体、重复输入 202、设置范围和错误 envelope；唯一认证例外是无数据 OPTIONS 预检。不提供自动 backend action 或无需认证的诊断接口；2026-10-15 新增经过原有认证的 /shutdown 服务停止 API。

## 验证

在应用根目录运行（测试使用独立临时目录和 fake backend，不会自动访问外网）：

```powershell
.\connector\.venv\Scripts\python.exe -m unittest connector.test_server -v
```

测试覆盖输入/URL 校验、所有业务端点认证、Host/DNS-rebinding 防护、CORS、空预检、请求大小与类型、随机 token/单实例锁、并发去重、canonical ID 合并、保留数据、30 分钟定时、20/3 限额、原子写失败、重启恢复、停止恢复、异常队列、字幕重试、json3/VTT/中英文滚动重叠、字幕语言选择、外网异常脱敏、参数数组与子进程超时。

2026-10-14 真实网络探测（与模拟 unittest 分开，均只使用临时子进程输出，未创建实际用户订阅）：

- `@YouTube` → canonical ID `UCBR8-60-B28hp2BmDPdntcQ`，获取 20 条 flat 视频，4.39 秒。
- 同一公开频道首条视频 `71ya_JC_IbM` → 英文人工 json3 字幕，解析 436 段；频道+字幕合计 5.42 秒。

这仅证明当次公开内容可访问，不保证所有地区/频道/未来请求可用。网络不可用时必须保留真实 error/unavailable 状态，不能把联网失败当作测试通过。

## 恢复操作

- 连接不上：先运行 `start-connector-silent.vbs`，不需要终端。仍失败查看 `connector/background.log`；UI 会重新读取 `connector/connection.json`，不要把 token 粘贴到错误日志。
- 端口占用/重复实例：健康实例直接复用；要重启可先从设置停止，再运行静默入口。不要随意结束未知占用程序。
- 网络/字幕失败：检查网络，点击刷新频道/重新获取字幕；仍失败可手动导入文稿，不会伪造结果。
- 依赖问题：在该虚拟环境中重新运行 `python -I -m pip install -r connector/requirements.txt`。更新版本应显式修改该文件并重新执行测试，不静默安装未知版本。
- 资料库损坏：先备份整个应用数据目录并修复 `connector/library.json`；程序不会覆盖损坏文件。不要直接删除仍需要的资料。
- 凭据损坏：备份并移走 `connector/connection.json`，重启后生成新 token，让 UI 重新读取即可；不必删除频道、视频或字幕。

## 已核对的官方参考

通过宿主只读浏览器核对官方仓库 README、`yt_dlp/YoutubeDL.py`、Extractors/EJS wiki 和 YouTube 提取器源码。`extract_info(download=False)` 返回元信息/字幕 URL，不返回字幕正文；flat playlist 不保证完整视频详情。`playlistend` 是兼容旧参数，以 `playlist_items='1:20'` 为主。Node 使用 `js_runtimes={'node':{}}`，EJS 由本地 default extras 提供；不启用 remote_components。`skip=translated_subs` 不能单独保证排除全部 ASR 翻译，因此额外检查字幕 URL 的 `tlang`。

```text
https://github.com/yt-dlp/yt-dlp#embedding-yt-dlp
https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/YoutubeDL.py
https://github.com/yt-dlp/yt-dlp/wiki/Extractors
https://github.com/yt-dlp/yt-dlp/wiki/EJS
https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_video.py
```
