# SearXNG 搜索后端(demo 用)

SearXNG 是开源元搜索引擎,聚合 Google/Bing/DuckDuckGo/Brave/百度 等几十个引擎,
本地 Docker 一键起,**免 API Key**,实时搜索。本目录是给 lll-web-agent demo 演示
"MCP 对接本地搜索服务"用的。

## 启动 SearXNG

```bash
# 从仓库根目录运行
docker run -d --name searxng-demo \
  -p 8888:8080 \
  -v "$(pwd)/demo/searxng:/etc/searxng" \
  -e "INSTANCE_NAME=lll-demo" \
  searxng/searxng:latest

# 验证(应返回 JSON 搜索结果)
curl "http://localhost:8888/search?q=hello&format=json" | head -c 200
```

## 在 demo 里使用

1. 启动 SearXNG(上面的 docker run)
2. 启动 demo server: `node demo/server.js`
3. 打开 http://localhost:3000/browser
4. MCP 面板选「🌐 SearXNG 搜索」点「挂载」
5. 填 LLM key,点「连接」,就能让 Agent 用 SearXNG 搜索了

## 停止 / 清理

```bash
docker stop searxng-demo && docker rm searxng-demo
```

## 配置说明

`settings.yml` 的关键点:
- `search.formats` 必须含 `json` —— 否则 MCP server 调 API 会被 403 拒绝
- `server.limiter: false` —— 关闭限流(本地单用户 demo)
- 引擎默认全开;国内网络下 Google/DuckDuckGo 可能超时,SearXNG 会自动跳过
  失败引擎,仍能从 Bing/百度 等可用引擎聚合结果

## 不想用 Docker?

demo 还提供「⭐ 内置搜索」预设(`demo/mcp-servers/web-search.js`),
直接爬搜狗,零依赖零 Docker,搜索质量略逊但开箱即用。
