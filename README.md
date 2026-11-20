# upscale-2api

把 upscaleaistudio.com 的账号池包成 OpenAI 兼容网关。零依赖，Node 20+，单进程。

```
客户端 ──sk-xxx──▶ 网关 ──账号池轮询──▶ Supabase Edge Functions ──▶ 各家模型
                     │
                     ├─ keys.json    下游密钥（哈希存储，带额度/限速/白名单）
                     ├─ accounts.json 上游账号（RT/AT，自动刷新）
                     └─ files/        产物落盘（上游签名只 1 小时，这里长期可读）
```

## 启动

```bash
cp .env.example .env          # 填 SUPABASE_ANON、ADMIN_KEY
node server.mjs               # 或 npm start
```

面板 `http://127.0.0.1:8787/admin`，`admin key` 输 `ADMIN_KEY`。
自检：`ADMIN_KEY=admin node scripts/smoke.mjs`（生成类用例会真花积分）。

Docker：

```bash
docker build -t upscale-2api . && docker run -d --env-file .env -p 8787:8787 -v $PWD/data:/app/data upscale-2api
```

## 目录

```
server.mjs               HTTP 入口、路由分发、优雅退出
src/config.mjs           环境变量 + .env 解析
src/http.mjs             CORS / JSON / multipart / 错误格式
src/session.mjs          上游账号：登录、刷新、调用、签名、上传
src/pool.mjs             选号、并发、429/401/失败重试
src/keys.mjs             下游密钥：生成、校验、限速、额度
src/files.mjs            产物落盘、索引、过期清理
src/logs.mjs             请求环形日志
src/routes/openai.mjs    /v1/* 兼容层
src/routes/admin.mjs     /admin/api/*
public/admin.html        管理面板
scripts/smoke.mjs        端到端自检
data/                    运行时数据（0600）
```

## 密钥体系

面板「密钥」页生成，或 API：

```bash
curl -X POST localhost:8787/admin/api/keys -H 'x-admin-key: admin' -H 'Content-Type: application/json' -d '{
  "name":"团队A", "count":3, "rpm":60, "credits_quota":5000,
  "daily_requests":2000, "expires_days":30, "models":["z-image-turbo","nano-banana"]
}'
```

返回的 `created[].key` 是明文，**只此一次**；库内只存 sha256 和前缀。
- `rpm` 每分钟请求数，滑窗；超了返回 429 + `retry-after`
- `credits_quota` 积分总额，用完 402 `quota_exhausted`
- `daily_requests` 每日请求数，跨天自动归零
- `models` 白名单，空 = 全部
- 支持停用、换发（旧 key 立刻失效）、删除

## 上游账号

```bash
# RT
-d '{"input":"<refresh_token>"}'
# 整段 localStorage JSON
-d '{"input":{"refresh_token":"…","access_token":"…"}}'
# 邮箱密码
-d '{"input":"{{EMAIL_grpmluvq}}:pw"}'
# 直接注册新号
-d '{"email":"new@x.com","password":"…","signup":true}'
```

调度规则：可用优先 → 当前并发最少 → 最久未用；每号并发上限 `PER_ACCOUNT_CONCURRENCY`（站点硬上限 2）。
401 先刷新 AT 再原地重试；刷新失败剔出池子。429 冷却 2.5s 换号；积分不足冷却 30 分钟；套餐锁模型则对该号拉黑该模型；生成类瞬时错误重试 2 次。

AT 生命周期：请求前剩余 < 2 分钟自动刷新，后台每 5 分钟扫一遍、剩余不足 15 分钟提前刷。新 RT 立刻写回磁盘。

## 接口

鉴权 `Authorization: Bearer sk-…` 或 `x-api-key`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` `/readyz` | 存活 / 就绪 |
| GET | `/v1/models` | 模型列表（含别名） |
| GET | `/v1/models/{id}` | 单模型探测，客户端启动常用 |
| POST | `/v1/images/generations` | 生图，`n`/`size`/`quality`/`response_format` |
| POST | `/v1/images/edits` | 同上，`image` 支持 URL / data URL / multipart 文件 |
| POST | `/v1/chat/completions` | 聊天壳子，返回 `![](url)`，支持 `stream` |
| POST | `/v1/responses` | Responses API 最小实现 |
| POST | `/v1/upscale` | 放大，`engine` 见 `/admin/api/models` |
| POST | `/v1/enhance` | 提示词增强 |
| POST | `/v1/raw/{fn}` | 直通任意 edge function |
| GET | `/v1/credits` | 上游余额 + 本 key 额度 |
| GET | `/v1/usage` | 本 key 用量 |
| GET | `/v1/dashboard/billing/credit_grants` | 兼容 one-api 类客户端的额度探测 |
| GET | `/files/{name}` | 产物 |

错误严格 OpenAI 格式：`{"error":{"message","type","param","code"}}`。

### 客户端

```python
from openai import OpenAI
c = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-ups-…")
r = c.images.generate(model="dall-e-3", prompt="a lighthouse in fog", size="1024x1024")
print(r.data[0].url)
```

别名：`dall-e-3→nano-banana-pro`、`gpt-image-1→gpt-image-1.5`、`flux→flux-2-pro`、`mj→nano-banana-pro` 等；也可直接写站点模型 id。

## 管理 API

`x-admin-key: <ADMIN_KEY>`

```
GET    /admin/api/stats
GET    /admin/api/accounts         POST /admin/api/accounts
DELETE /admin/api/accounts/{id}    POST /admin/api/accounts/{id}/refresh
POST   /admin/api/accounts/{id}/purge     注销上游账号
GET    /admin/api/keys             POST /admin/api/keys
PATCH  /admin/api/keys/{id}        DELETE /admin/api/keys/{id}
POST   /admin/api/keys/{id}/rotate
GET    /admin/api/models  /admin/api/logs  /admin/api/files  /admin/api/config
POST   /admin/api/files/upload  /admin/api/files/cleanup
```

## 注意

- 一个 RT 只有一个持有者。网关刷新后浏览器那头会掉线。
- 生成失败不扣上游积分，网关也不计费。
- 产物默认保留 30 天（`FILE_RETENTION_DAYS`），每 6 小时清理一次。
- 视频要单独 video pack，Pro 调 `generate-video` 返回 `VIDEO_ACCESS_DENIED`；走 `/v1/raw/generate-video` 可直连。
