# SubWharf（订阅码头）项目规则

> Cloudflare Workers 上的个人订阅中转与管理面板。完整设计与背景见 [README.txt](README.txt)。
> 本文件为项目级规则，优先于用户级全局规则；未覆盖事项遵循全局 AGENTS.md。

## 技术栈与结构

- Cloudflare Workers（TypeScript）+ KV + Cron Triggers + Workers Static Assets；前端原生 JS，不引入构建链与后端框架。
- 目标目录：`src/index.ts`（路由）、`src/auth.ts`、`src/subs.ts`、`src/template.ts`、`src/parse.ts`、`src/rename.ts`、`src/render.ts`、`public/`、`wrangler.jsonc`。

## 命令

- 本地开发：`npx wrangler dev`
- 部署：`npx wrangler deploy`（发布操作，经用户确认后执行）
- secrets：`npx wrangler secret put SESSION_KEY|WRAP_KEY|SETUP_CODE`

## 关键设计决策（变更前必须与用户确认）

1. 输出格式：Clash(Mihomo YAML) 与 sing-box 必选，base64/uri 附加。
2. 只输出节点；机场原 rules / proxy-groups / rule-providers 一律不透传。例外：`rules=cn` 的绕华直连最小规则；用户显式配置的 singbox 模板（保留模板自带 inbounds / route / 分组）。
3. 节点统一内部模型，Clash / sing-box / URI 同源序列化。新增协议必须三种表示都能生成，或明确降级为跳过并在面板提示。
4. 订阅 URL、TOTP 密钥等敏感数据一律 AES-GCM 加密落盘（密钥 WRAP_KEY）；日志脱敏；secrets 不入库、不入文档。
5. 免费版 CPU 10ms/次：订阅抓取默认 base64/URI 轻解析；Clash YAML 使用自研受限子集解析器（仅 proxies 段，带输入/节点数上限），经用户确认默认启用（2026-10-25）。
6. 单管理员 + TOTP 双因子，不开放注册与多用户。

## 工作约定

- `parse.ts` / `rename.ts` / `render.ts` 是正确性核心，改动必须附带可复现的验证样例（真实订阅片段或构造节点）并跑通。
- 改动后用 `wrangler dev` 过一遍受影响路径再交付；涉及输出格式的改动，用真实客户端（Clash / sing-box）导入验证。
- 依赖从简：新增依赖先说明必要性；不为一次性功能搭抽象层。
- 提交遵循中文 Conventional Commits，分支 `{类型}/{简短描述}`。
