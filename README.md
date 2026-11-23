<!-- newmax-app:app-f73ecc67-75cb-4381-b4ea-e829470dba1b:start -->
# 映读

[built by newmax](https://newmax.ai)

订阅 YouTube 频道，将视频字幕变成可阅读、可解析、可对话的学习资料。

## 功能 / Features

- 独立临时视频目录支持粘贴YouTube单视频链接并获取信息与字幕，无须订阅频道；按视频ID去重、保存归类并复用解析/对话/图文，错误可恢复，移出目录保留资料，不自动调用AI或付费接口。
- 输入 YouTube 频道，通过已授权的本地连接器定时同步近期视频并获取可用字幕；同步保存真实频道头像用于订阅列表，失败时回退字母圆标。
- 支持字幕导入、检索、时间戳跳转、频道筛选、待读与收藏；当前列表可确认数量后全部标记已读，保存失败恢复原状态，并提供本窗口撤销。
- 频道只在有未读时显示数量，不以正常同步绿点冒充未读；桌面频道栏和视频列表均支持拖拽、键盘调宽与各自恢复默认，两处分隔统一单条细线、无选中外框，宽度独立本地保存，窄屏保持抽屉。
- 解析和对话默认提供完整文稿、采用自动输出预算，不固定限制为8000；保留真实结束状态与未完成草稿，旧宿主在生成前阻止请求。
- 本地保存阅读进度、文稿、解析及对话；当前 Windows 用户登录后静默启动连接器，不自动调用付费 AI。
- 解析、AI回复及未完成草稿采用本地安全Markdown排版，保留完整正文与时间戳跳转。
- 打开应用默认选中首个订阅频道的首条视频，切换频道同步展示首条内容；自动选中不标记已读，后台更新不覆盖手动选择。

## 源码 / Source

- [浏览应用源码 / Browse source](newmax-apps/app-f73ecc67-75cb-4381-b4ea-e829470dba1b/)
- [应用原始文档 / App documentation](newmax-apps/app-f73ecc67-75cb-4381-b4ea-e829470dba1b/README.md)
- 版本 / Version: 1\.0\.0
- NewMax runtime: ^1\.0\.0
- 权限 / Permissions: ai\.chat, ai\.stream, data\.kv, files\.appData, notifications, desktopShortcut
- [本次发布 / Release](https://github.com/yangyixxxx/youread/releases/tag/app-12bff077-5e86-4be3-92a9-d3ee83a29c34)

## 安装 / Install

1. 安装并打开 / Install and open [NewMax](https://newmax.ai).
2. 本地应用 → 激活应用。 / Local apps → Activate app.
3. 粘贴下方完整口令，等待下载校验。 / Paste the full code below and wait for verification.
4. 检查来源与权限后，点击「信任并安装」。 / Review the publisher and permissions, then choose Trust and install.

```text
NEWMAX-APP:1:yangyixxxx/youread/app-12bff077-5e86-4be3-92a9-d3ee83a29c34:a2687cb331d4b58aefebcf43d8f708dc8bab0e2b7084e87596c8d90306f2e329
```

无需 GitHub 登录；安装后需手动打开应用。口令对应此版本，旧口令不会自动升级。
No GitHub sign-in is required. Open the app manually after installation. Each code installs a fixed snapshot.

## 使用说明 / Notes

这是依赖 NewMax 的应用源码，不是独立系统安装程序。个人数据、账号密钥与开发对话不随包分发；外部服务、连接器和依赖可能需要自行配置。
This app requires NewMax. Personal data, credentials and development chats are not included. External services, connectors and dependencies may need separate setup.

许可证请查看源码中的 LICENSE 或原始文档；此发布流程不会自动添加或修改许可。
See the source LICENSE or original documentation for licensing. Publishing does not assign or change a license.
<!-- newmax-app:app-f73ecc67-75cb-4381-b4ea-e829470dba1b:end -->

# youread
Public NewMax local app shares
