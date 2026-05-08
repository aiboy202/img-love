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

