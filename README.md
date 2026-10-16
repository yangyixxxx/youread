<!-- newmax-app:app-f73ecc67-75cb-4381-b4ea-e829470dba1b:start -->
# 映读

[built by newmax](https://newmax.ai)

订阅 YouTube 频道，将视频字幕变成可阅读、可解析、可对话的学习资料。

## 功能 / Features

- 输入 YouTube 频道，通过已授权的本地连接器定时同步近期视频并获取可用字幕；同步保存真实频道头像用于订阅列表，失败时回退字母圆标。
- 支持字幕导入、检索、时间戳跳转、频道筛选、待读与收藏。
- 解析和对话默认提供完整文稿、采用自动输出预算，不固定限制为8000；保留真实结束状态与未完成草稿，旧宿主在生成前阻止请求。
- 本地保存阅读进度、文稿、解析及对话；当前 Windows 用户登录后静默启动连接器，不自动调用付费 AI。
- 解析、AI回复及未完成草稿采用本地安全Markdown排版，保留完整正文与时间戳跳转。
- 打开应用默认选中首个订阅频道的首条视频，切换频道同步展示首条内容；自动选中不标记已读，后台更新不覆盖手动选择。
- 解析与阅读对话接收真实流式正文并增量Markdown展示，定期保存草稿，正常结束才视为完成；中断保留内容且不自动重试。
- 重新解析在原正文位置流式替换，旧解析默认收起作为失败备份；对话在本次助手消息内输出，不叠加独立生成面板。

## 源码 / Source

- [浏览应用源码 / Browse source](newmax-apps/app-f73ecc67-75cb-4381-b4ea-e829470dba1b/)
- [应用原始文档 / App documentation](newmax-apps/app-f73ecc67-75cb-4381-b4ea-e829470dba1b/README.md)
- 版本 / Version: 0\.1\.0
- NewMax runtime: ^1\.0\.0
- 权限 / Permissions: ai\.chat, ai\.stream, data\.kv, files\.appData, notifications, desktopShortcut
- [本次发布 / Release](https://github.com/yangyixxxx/youread/releases/tag/app-fc667a41-c84f-495e-8794-acf5512ba538)

## 安装 / Install

1. 安装并打开 / Install and open [NewMax](https://newmax.ai).
2. 本地应用 → 激活应用。 / Local apps → Activate app.
3. 粘贴下方完整口令，等待下载校验。 / Paste the full code below and wait for verification.
4. 检查来源与权限后，点击「信任并安装」。 / Review the publisher and permissions, then choose Trust and install.

```text
NEWMAX-APP:1:yangyixxxx/youread/app-fc667a41-c84f-495e-8794-acf5512ba538:f8686683617fb1b4d4dff69e1177e276e4c8b0bc8ea7eb77521ae2e361d5ffae
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
