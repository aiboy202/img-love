# 截图收藏 · 分类归档（PWA 第一阶段）

## 你现在得到的是什么

一个**纯静态**的 PWA 网页应用（无需 Node/npm），可直接部署到 Vercel 免费版：

- 从相册/文件选择截图导入（Web 平台限制：不能自动读取相册，必须手动选择）
- 本地 OCR（Tesseract.js）提取文字
- 本地关键词规则：自动打“兴趣标签 + 城市”
- IndexedDB 离线存储（刷新/离线仍可查看）
- 每条收藏提供：
  - “路线”（跳转到高德网页路线/搜索）
  - “点评”（跳转大众点评搜索）
- 支持“添加到主屏幕”（beforeinstallprompt + manifest + service worker）

## 文件结构

- `index.html`: 主界面
- `styles.css`: 样式
- `app.js`: 逻辑（OCR/分类/存储/渲染）
- `manifest.webmanifest`: PWA 清单
- `sw.js`: 离线缓存 Service Worker
- `icons/icon.svg`: 图标
- `vercel.json`: Vercel header 配置（确保 sw/manifest 正确）

## 本地运行

用任意静态服务器即可（Windows 也可以用 VSCode Live Server）。

如果你有 Python：

```bash
python -m http.server 5173
```

然后访问 `http://localhost:5173/`。

## 部署到 Vercel（免费）

1. 把这个目录推到 GitHub 仓库
2. Vercel 新建 Project → 选择该仓库
3. Framework 选 **Other**
4. Build Command 留空，Output Directory 留空（使用根目录静态文件）
5. Deploy

## 下一步（第二阶段/增强点）

- 用高德/腾讯的逆地理 API 自动从定位回填“当前城市”
- POI 解析（店名/景点名/地址/人均）更准确：可接入 OCR 后的结构化抽取
- 从截图来源 App（抖音/小红书/大众点评）识别内容结构与字段
- 账号同步（多设备）：需要后端或云存储（会涉及隐私策略与合规）

## SCF（腾讯云云函数）替代 Edge Functions（推荐）

如果 EdgeOne Edge Functions 调用智谱上游经常超时，可以把大模型调用迁到腾讯云 SCF。

- **SCF 代码**：`scf/vision/index.js`
- **需要的 SCF 环境变量**：
  - `BIGMODEL_API_KEY`（必填）
  - `BIGMODEL_VISION_MODEL`（可选，默认 `glm-4.6v`；**不要用 `glm-4.5-air` 做截图**，该模型为纯文本，需多模态如 `glm-4.6v` / `glm-5v-turbo`）
  - `BIGMODEL_TIMEOUT_MS`（可选，默认 60000）
- **触发器**：API 网关 HTTP 或「函数 URL」均可；典型 `event` 含 `httpMethod`、`body`、`isBase64Encoded`；API 网关 3.0 还可能用 `requestContext.http.method`。代码里已做兼容，并支持 `GET` 健康检查、`OPTIONS` 预检。
- **浏览器报 `Failed to fetch`**：多为跨域。函数代码会返回 CORS 头；若前面还有 **API 网关**，请在网关侧开启 CORS 或在「集成响应」里把后端返回的 `Access-Control-*` 透传给浏览器，否则网关错误页不带 CORS 时浏览器仍会显示网络失败。可先在同一浏览器直接访问函数 URL（GET）确认能返回 JSON。
- **执行方法**：可填 `main_handler` 或 `main`（均已导出）。
- **前端配置**：在 `index.html` 里设置 `globalThis.__APP_CONFIG__.VISION_API_URL`。若为 `*.tencentscf.com` 的函数 URL，填根地址即可（前端不会自动追加 `/api/vision`）。

纯文本归类接口（Edge）：`/api/semantic` 默认模型为 **`glm-4.5-air`**（可用环境变量 `BIGMODEL_MODEL` 覆盖）。

