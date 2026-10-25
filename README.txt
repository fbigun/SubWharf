SubWharf（订阅码头）
======================================================================

一、项目概述
----------------------------------------------------------------------
SubWharf 是部署在 Cloudflare Workers 上的个人订阅中转与管理面板。
登记多个机场订阅与自建节点后，Worker 每天两次定时抓取节点与流量
快照存入 KV，对外通过带随机 token 的链接输出统一的节点订阅。

定位与边界：
  * 只输出节点，不输出机场原有的 rules / proxy-groups / rule-providers。
  * 唯一例外：可选的「绕过中国直连、其余走代理」最小规则。
  * 输出格式必选：Clash(Mihomo YAML) 与 sing-box；另附 base64 / uri。
  * 单管理员 + TOTP 双因子，不开放多用户注册。
  * 全部功能设计在 Cloudflare 免费额度内运行。

二、总体架构
----------------------------------------------------------------------
一个 Worker 同时承担三件事：
  /           静态管理面板（Workers Static Assets 托管）
  /api/*      管理 API（登录、订阅、节点、链接、刷新）
  /s/{token}  公开订阅输出（无需登录，凭 token 取内容）

定时任务：Cron Trigger「0 1,13 * * *」（UTC，即北京 09:00 / 21:00）
每天两次抓取全部启用订阅，写快照入 KV；面板可手动立即刷新。

  浏览器 ──HTTPS──> 静态面板 + /api/*
  Cron   ──触发──> 抓取机场订阅(自定义 UA) ──解析──> KV 快照
  客户端 ──/s/{token}──> 读 KV 快照 ──序列化──> 输出

三、功能说明
----------------------------------------------------------------------
1. 认证
   - 首次访问初始化：SETUP_CODE（部署时设置的 secret）+ 设置密码
     + 生成 TOTP 密钥并展示 otpauth:// 二维码，验证一次完成绑定。
   - 登录 = 密码 + TOTP；密码 PBKDF2 哈希；TOTP 用 Web Crypto 实现。
   - 会话 Cookie：HttpOnly + Secure + SameSite=Strict，TTL 7 天。
   - 登录失败 5 次锁定 15 分钟。

2. 订阅管理
   - 登记项：名称、订阅 URL、自定义 UA、启用开关。
   - 订阅 URL 含敏感 token，AES-GCM 加密落盘，日志脱敏。
   - 抓取时记录响应头 subscription-userinfo（上传/下载/总量/到期），
     面板做流量条与到期提醒。
   - 解析统一为内部节点模型，覆盖 ss / vmess / vless / trojan /
     hysteria2 / tuic；未知协议跳过并在面板提示。
   - 抓取失败保留上次成功快照，记录错误与时间，下次 cron 重试。

3. 自建节点
   - 粘贴标准节点 URI 自动解析入库，与机场节点同模型，合并输出；
     输出时按名称前缀区分来源（如 [机场A] HK-01 / [自建] JP-01）。

4. 对外输出链接
   - 链接模型：128-bit 随机 token、标签、默认 target、是否内置绕华
     规则、来源勾选（哪些机场 + 是否含自建）、启停 / 一键重置。
   - GET /s/{token}?target=clash|singbox|base64|uri&rules=cn
     参数可覆盖链接默认值；响应带 profile-update-interval: 12。
   - target=clash   Mihomo YAML：仅 proxies + 单一 PROXY 组。
   - target=singbox 完整最小配置：inbounds(mixed) + outbounds
                     (PROXY 选择器 + 全部节点) + route.final -> PROXY。
   - rules=cn 绕华规则：
       clash：GEOIP,PRIVATE,DIRECT,no-resolve / GEOSITE,CN,DIRECT /
              GEOIP,CN,DIRECT / MATCH,PROXY
       sing-box：route.rules 引用远程 rule_set geosite-cn、geoip-cn
              直连，final -> PROXY（.srs 取 SagerNet 官方地址，可切换
              jsDelivr 镜像；服务端不内置任何规则数据）。
   - base64 / uri 为附加格式（内部模型副产品，v2rayN 系可用）。

四、KV 数据模型
----------------------------------------------------------------------
  profile        密码哈希、TOTP 密钥（加密）             初始化/改密
  sess:{id}      会话                                    登录，TTL 过期
  login:fail     失败计数/锁定时间                       登录失败
  sub:{id}       订阅元数据（URL 加密）                  面板操作
  snap:{subId}   快照：节点 JSON、userinfo、时间、错误    cron/手动刷新
  node:{id}      自建节点                                面板操作
  link:{token}   输出链接配置                            面板操作

五、部署
----------------------------------------------------------------------
前置：Node 18+、wrangler、Cloudflare 账号、一个 CF 托管域名（推荐）。

  npm install
  npx wrangler kv namespace create KV
  npx wrangler secret put SESSION_KEY     # 会话签名密钥
  npx wrangler secret put WRAP_KEY        # 订阅 URL 加密密钥
  npx wrangler secret put SETUP_CODE      # 首次初始化口令
  npx wrangler deploy

wrangler.jsonc 声明：KV 绑定、crons、assets 目录。
workers.dev 域名在境内被 DNS 污染，务必绑定自定义域名。

自动部署（CNB 流水线）：push 到 main 触发 .cnb.yml——npm ci → 类型检查
→ 测试 → npx wrangler deploy。Cloudflare 凭据经 CNB 密钥仓库注入：创建
密钥仓库 fbigun/secrets，在 Web 界面添加 cloudflare.yml（内容为
CLOUDFLARE_API_TOKEN 与 CLOUDFLARE_ACCOUNT_ID 两行），.cnb.yml 通过
imports 引用；token 用「编辑 Cloudflare Workers」权限模板创建。

六、配额核对（免费版）
----------------------------------------------------------------------
  KV 读    100,000/天    用量约几百/天
  KV 写    1,000/天      用量约 20/天
  子请求   50/次         每次抓 N 个订阅（N << 50）
  CPU      10ms/次       见「七、风险与限制」第 1 条
  Cron     2 次/天       不另计费

七、风险与限制
----------------------------------------------------------------------
1. 免费版 CPU 10ms/次：订阅抓取默认让机场返回 base64/URI 格式
   （UA 配置为 v2rayN 系，解析极轻）；Clash YAML 使用自研受限
   解析器（仅解析 proxies 段，带输入/节点数上限），免费版预算内
   默认启用。个别机场 base64 字段不全时，可将该订阅抓取格式
   切换为 Clash YAML。
2. 少数机场封 Cloudflare 出口 IP，Worker 内无解；UA 拦截类用
   自定义 UA 解决。
3. 个别机场不返回 subscription-userinfo 头，流量显示「未知」。
4. 输出端点与 token 即订阅凭据，泄露可一键重置。

八、安全设计
----------------------------------------------------------------------
  * 订阅 URL / TOTP 密钥 AES-GCM 加密落盘（WRAP_KEY）。
  * secrets 只存 wrangler secret，不入库、不入文档。
  * 管理面登录限速 + 双因子；公开端点只读、不含任何管理信息。
  * 日志不打印订阅 URL 与 token。

九、状态与目录结构
----------------------------------------------------------------------
  v1 已实现（本地编辑 + 云端工作区验证）。目录结构：

    src/index.ts  路由入口
    src/auth.ts   认证与会话
    src/subs.ts   订阅/节点/链接管理与抓取调度
    src/parse.ts  订阅解析（URI / Clash / sing-box -> 内部模型）
    src/render.ts 输出序列化（内部模型 -> clash / singbox / base64 / uri）
    public/       管理面板静态资源
