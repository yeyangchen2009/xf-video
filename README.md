# xf-video

`xf-video` 是面向本人已获授权内容的小鹅通、飞书视频下载 CLI。日常命令使用 **`xfv`**，完整命令 `xf-video` 等价。

- npm 包：<https://www.npmjs.com/package/xf-video>
- 源码仓库：<https://github.com/yeyangchen2009/xf-video>
- 当前版本：0.1.2

> 支持范围以实际验收结果为准（见下方验收状态表），不提供 DRM、验证码或权限绕过。

## 环境与安装

- Windows 10/11，Node.js 22+
- 本机 Microsoft Edge
- 本机 FFmpeg 和 FFprobe，已加入 PATH，或通过参数指定
- 登录由用户本人在 Edge 中扫码或完成，不导出 Cookie

```bash
npm install -g xf-video
xfv doctor
```

不想全局安装时可用 npx，显式指定版本与简写命令：

```bash
npx --yes --package xf-video@0.1.2 xfv doctor
```

## 使用

```bash
# 登录并保存到默认持久 profile
xfv login "https://example.com/course" --profile default

# 自动识别小鹅通或飞书页面
xfv get "https://example.com/video" -o "课程.mp4"
xfv get "https://example.com/video" --site xiaoe --output-dir "./downloads"
xfv get "https://example.com/replay" --site xiaoe-live

# aipoju 卡片序号从 1 开始，多项时不能指定 -o
xfv get "https://example.com/list" --site aipoju --index 1,3

# 复用已有浏览器 profile
xfv get "https://example.com/video" --profile-dir "D:\existing-profile"
```

`get` 的自动站点识别只覆盖明确已知域名；无法识别时使用 `--site`。`/v4/course/alive/` 回放链接默认进入直播适配器：页面发标准 m3u8 时自动回退标准嗅探，只有 `confusion_index` 混淆回放才走解混淆路径，通常不需要手动指定 `--site`。

### 验收状态

| 通路 | 状态 |
| --- | --- |
| 飞书妙记 MP4 | 已用授权样本完成端到端验收：原生嗅探、断流保留、重试和 538,519,978 字节视频的 FFprobe/整段解码均通过。该服务支持 Range 但不返回 ETag/Last-Modified，因此重试按安全策略全量重下；带校验器的 206 追加由本地自动化覆盖 |
| 通用 HLS/AES | 本地动态清单已覆盖鉴权、相对 key/MAP、跨域凭证隔离、401、短视频和完整解码；真实飞书 HLS 样本仍待补验 |
| 小鹅通标准课 | 已用授权样本完成端到端验收：HLS AES-128 嗅探、key 与分片鉴权、461,844,894 字节（99.4 分钟）视频的 FFprobe/整段解码均通过 |
| 小鹅通直播回放（标准 HLS 型） | 已用授权专栏样本完成端到端验收：28 场 alive 回放均为 `encrypt-k-vod` 标准 m3u8，适配器按页面实际媒体请求自动回退标准嗅探，968,504,696 字节（49.1 分钟）样本整段解码通过 |
| 小鹅通直播回放（confusion 混淆型） | `confusion_index` 解混淆和清单重建有固定向量测试，并在 2026-07 旧样本上验证过一次；第二个授权样本待补验 |
| aipoju 跳飞书 | 域名、卡片、序号和新页/同页跳转逻辑已接入，等待真实列表端到端验收 |

未完成真实端到端验收的通路不代表不可用，但不把它表述成“已完整支持”。

HLS 下载与整段解码期间，FFmpeg 通过 `-progress` 每 5 秒上报一次已处理时间与速度；进入 FFprobe、解码等阶段时另有提示，长任务不再零输出。账号无权播放时（服务端重写到 `goods_detail` 商品页或页面只有「前往购买」），会直接提示登录或购买问题，而不是笼统报“未嗅探到媒体”。

### JSON 批量

```json
[
  {
    "url": "https://tenant.example.com/course/1",
    "site": "xiaoe",
    "name": "001-示例课程"
  },
  {
    "url": "https://list.example.com/replays",
    "site": "aipoju",
    "index": 2,
    "name": "002-示例回放"
  }
]
```

```bash
xfv batch jobs.json --offset 0 --limit 3 --output-dir "./downloads"
```

manifest 只接受 `url/site/name/index`，每项产出一个视频。任务串行执行，单项失败最后会计入非零退出码。

## 文件与隐私

- 默认输出为当前目录 `downloads`，profile 位于用户目录 `.xf-video/profiles`。
- `XF_VIDEO_HOME`、`XF_VIDEO_TEMP`、`XF_VIDEO_EDGE`、`XF_VIDEO_FFMPEG`、`XF_VIDEO_FFPROBE` 可覆盖默认路径。
- 下载先写 `name.part.mp4`，MP4 只有收到匹配的 `206 Content-Range` 才追加；服务器返回 `200` 时从头写。`name.part.json` 只保存 ETag/Last-Modified 续传校验器，不保存签名 URL；缺少校验器的旧半成品会从头下载。
- HLS 通过仅监听 `127.0.0.1` 随机端口的本机代理逐请求转发，清单、key、MAP 和分片按原始地址解析；同源保留鉴权，跨 origin 删除凭证，远程签名 URL 不进入 FFmpeg 参数。
- 正式文件通过 FFprobe 和 FFmpeg 整段解码后，以不覆盖已有文件的方式发布；已存在且有效的文件会跳过，损坏文件不会被自动覆盖。
- 日志默认移除媒体签名参数、鉴权头以及本机代理 URL 中的随机 token/资源 ID。登录态、媒体签名和下载内容仍属于本机敏感数据，不要共享 profile 或输出目录。
- 当前版本的输出冲突预留只在单个进程内生效；不要同时启动两个 `xfv` 进程写同一输出路径。跨进程 lockfile 留待后续版本，正式文件的不覆盖发布仍是最后兜底。
- `XF_VIDEO_TEMP` 目前用于 `doctor` 的临时 Edge 预检 profile；正常下载的 HLS 清单只保存在代理内存中。
- 不做全站课程发现、并发下载、HLS 续传、清晰度选择或 B 站下载。

## 开发

从源码安装本地链接：

```bash
git clone https://github.com/yeyangchen2009/xf-video.git
cd xf-video
npm install
npm link
```

测试与打包自检：

```bash
npm test
npm run test:edge
npm pack --dry-run
```

真实平台测试不进入默认测试，不接受仓库内的私人 URL 或 Cookie。测试媒体由本地 FFmpeg 动态生成。
