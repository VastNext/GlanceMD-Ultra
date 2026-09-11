---
date: 2026-09-11
topic: glancemd-ultra-icon-concepts
---

# GlanceMD Ultra 图标概念探索

本轮先验证三种产品语义，不直接替换 `assets/icon.png` 或 `assets/icon.ico`。

## 三个方向

1. **G 形视口**：用 Glance 的首字母和“快速浏览窗口”合成一个符号，内部保留极少量文本线。
2. **工作区树形**：用项目树、文件节点和文本光标表达 Ultra 的工作区定位。
3. **折叠页面 + U**：保留 Markdown 文档认知，用折角和底部负形暗示 Ultra，去掉铅笔。

## 当前建议

优先继续细化 **G 形视口**。它比“文档 + 铅笔”更容易形成品牌记忆，也能在 16px、32px、512px 三种尺寸中保持统一轮廓。

工作区树形适合作为第二候选；折叠页面 + U 是迁移成本最低的稳妥方案。

## 预览

打开同目录的 `icon-concepts.svg` 查看三套等比例矢量草案。

## GPT Image 生成记录

本轮使用本地 OpenAI 兼容服务：

- Base URL：`http://localhost:54978/v1`
- Model：`gpt-image-2`
- Endpoint：`POST /images/generations`
- 请求字段：`model`、`prompt`、`n`、`size`
- GPT 图像模型响应使用 `data[].b64_json`，不依赖临时 URL

本地服务当前返回账号池认证失效，因此生成展示使用图像生成工具完成；下面的请求模板可在账号池恢复后直接重试。

```bash
API_KEY='从环境变量读取，不要写入仓库'
curl --noproxy '*' -sS -X POST 'http://localhost:54978/v1/images/generations' \
  -H "Authorization: Bearer ${API_KEY}" \
  -H 'Content-Type: application/json' \
  --data '{
    "model": "gpt-image-2",
    "prompt": "A single square desktop application icon concept for GlanceMD Ultra ...",
    "n": 1,
    "size": "1024x1024"
  }'
```

不要把 API key 写进脚本、Markdown、图片元数据或 Git 历史。
