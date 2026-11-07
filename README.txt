SubWharf（订阅码头）
======================================================================

一、项目概述
----------------------------------------------------------------------
SubWharf 是部署在 Cloudflare Workers 上的个人订阅中转与管理面板。
登记多个机场订阅与自建节点后，Worker 每天两次定时抓取节点与流量
快照存入 KV，对外通过带随机 token 的链接输出统一的节点订阅。

定位与边界：
  * 只输出节点，不输出机场原有的 rules / proxy-groups / rule-providers。
  * 例外一：可选的「绕过中国直连、其余走代理」最小规则。
  * 例外二：用户显式配置的 singbox 模板，保留其 inbounds / DNS /
    route / 分组（模板由用户提供，非机场配置透传）。
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
每天两次抓取全部启用订阅，写快照入 KV；同时重新拉取输出模板并为每个
输出链接重建模板配置；面板可手动立即刷新。

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
   - 登记项：名称、订阅 URL、自定义 UA、启用开关、节点名包含/排除
     正则（作用于原始节点名）、名称清洗开关（默认开启）。
   - 节点名清洗：按中文/英文/国旗/城市别名识别地区并统一为中文地区
     名；保留倍率（0.1x、x0.2、6x、3倍 → n×）与家宽/IPLC/ˣ² 等标
     识；识别不到地区时保留原名。输出统一加 [订阅名] 前缀并置于最前。
   - 订阅 URL 含敏感 token，AES-GCM 加密落盘，日志脱敏。
   - 抓取时记录响应头 subscription-userinfo（上传/下载/总量/到期），
     面板做流量条与到期提醒。
   - 解析统一为内部节点模型，覆盖 ss / vmess / vless / trojan /
     hysteria2 / tuic；未知协议跳过并在面板提示。
   - 抓取失败保留上次成功快照，记录错误与时间，下次 cron 重试。
   - 原始节点名保存在快照中，面板「查看节点」显示原名。

3. 节点池与去重
   - 面板「节点池」Tab 汇总全部启用订阅按各自筛选/清洗规则处理后
     的节点名（含自建节点），可正则筛选。
   - 内容完全相同的节点只保留第一个；同名但内容不同的节点追加
     #2、#3 序号，保证 Clash / sing-box 名称唯一。
   - 链接级包含/排除正则同时匹配清洗后名称与原始名（含来源前缀）。

4. 自建节点
   - 粘贴标准节点 URI 自动解析入库，与机场节点同模型，合并输出；
     输出时按名称前缀区分来源（如 [机场A] 香港 / [自建] JP-01）。

5. 对外输出链接
   - 链接模型：128-bit 随机 token、标签、默认 target、是否内置绕华
     规则、来源勾选（哪些机场 + 是否含自建）、绑定模板（仅 singbox）、
     启停 / 一键重置。
   - GET /s/{token}?target=clash|singbox|base64|uri&rules=cn
     参数可覆盖链接默认值；响应带 profile-update-interval: 12。
   - target=clash   Mihomo YAML：仅 proxies + 单一 PROXY 组。
   - target=singbox 未配置模板时为完整最小配置：inbounds(mixed) +
                     outbounds (PROXY 选择器 + 全部节点) + route.final ->
                     PROXY；配置模板后改用模板生成结果（见下条）。
   - rules=cn 绕华规则：
       clash：GEOIP,PRIVATE,DIRECT,no-resolve / GEOSITE,CN,DIRECT /
              GEOIP,CN,DIRECT / MATCH,PROXY
       sing-box：route.rules 引用远程 rule_set geosite-cn、geoip-cn
              直连，final -> PROXY（.srs 取 SagerNet 官方地址，可切换
              jsDelivr 镜像；服务端不内置任何规则数据）。
   - base64 / uri 为附加格式（内部模型副产品，v2rayN 系可用）。

6. 输出模板（sing-box）
   - 面板「模板」Tab 维护多个模板（名称 + JSON 地址，CNB 文件页 /-/blob/
     地址自动转为 /-/git/raw/）；仅 singbox 格式的输出链接可绑定模板，
     未绑定或非 singbox 链接使用对应格式的内置输出。
   - 拉取后保留模板的 inbounds / DNS / route / rule_set，将绑定链接的节点
     注入 outbounds。
   - 分组填充沿用模板脚本语义：香港 / 日本 / 美国分组按节点名正则匹配，
     自动选择 / 手动切换填全部节点；无匹配或模板留空的分组回退到共享的
     COMPATIBLE 直连出口；已有静态成员的分组保持不变。
   - 生成结果按输出链接（token）缓存在 KV，客户端拉取时直接返回；
     模板输出以模板 route 为准，忽略链接规则选项与 ?rules 参数。
   - 控制台支持单个模板刷新 / 刷新全部模板 / 编辑 / 删除；cron 每天两次
     重新拉取全部模板并重建绑定链接的缓存，拉取失败保留上次成功模板；
     删除模板会解除链接绑定并清除对应缓存。

四、KV 数据模型
----------------------------------------------------------------------
  profile        密码哈希、TOTP 密钥（加密）             初始化/改密
  sess:{id}      会话                                    登录，TTL 过期
  login:fail     失败计数/锁定时间                       登录失败
  sub:{id}       订阅元数据（URL 加密）                  面板操作
  snap:{subId}   快照：节点 JSON、userinfo、时间、错误    cron/手动刷新
  node:{id}      自建节点                                面板操作
  link:{token}   输出链接配置（含模板绑定）              面板操作
  template:{id}  模板名称、地址、原文、拉取时间/错误     面板/cron
  tpl:{token}    模板生成结果（config JSON）              面板/cron/按需

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

自动部署（CNB 流水线）：push 到 main 并行触发两条独立流水线：
  1) 同步源码到 GitHub（https://github.com/fbigun/SubWharf）
  2) 构建与部署：npm ci → 类型检查 → 测试 → 自动确保 KV →
     npx wrangler deploy → 写入 secrets
两条流水线互不影响：构建失败不阻止源码同步，同步失败也不影响部署。
凭据经 CNB 密钥仓库注入：在密钥仓库添加 cloudflare.yml 与 github.yml：

  cloudflare.yml:
    CLOUDFLARE_API_TOKEN: 「编辑 Cloudflare Workers」模板 token
    CLOUDFLARE_ACCOUNT_ID: 账号 ID（控制台首页右侧栏）
    SESSION_KEY:  任意随机串（openssl rand -hex 32）
    WRAP_KEY:     任意随机串（openssl rand -hex 32）
    SETUP_CODE:   自定的初始化口令

  github.yml:
    GITHUB_TOKEN: GitHub PAT（Contents: Read and write）；未配置则跳过
                  GitHub 同步，不影响部署

GitHub 为只读镜像，改动请统一走 CNB（直接提交可能被镜像覆盖）。

首次部署时流水线自动创建 KV namespace 并回写 id，无需手动操作；
.cnb.yml 里 imports 的密钥仓库路径（fbigun/secrets）需替换为你自己的。

Fork 部署清单（fork 后按自己账号部署）：
  1. Cloudflare 创建 API Token（「编辑 Cloudflare Workers」模板）
  2. CNB 自建密钥仓库，按上方格式添加 cloudflare.yml 与可选的
     github.yml（不需要 GitHub 镜像时可省略 github.yml；
     .cnb.yml 的 imports 路径改为你的密钥仓库——个人环境
     变量仅对云原生开发环境生效，对 CI 无效）
  3. push 到 main 即并行完成源码同步与 KV 创建、部署、secrets 写入
  4. 自定义域名在控制台 Workers & Pages → subwharf → Settings →
     Domains & Routes 绑定（自动建 DNS 与证书，无需改仓库配置）

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
    src/template.ts 模板拉取、节点注入与按链接缓存
    src/parse.ts  订阅解析（URI / Clash / sing-box -> 内部模型）
    src/rename.ts 节点名清洗（地区识别、倍率与标识保留）
    src/render.ts 输出序列化（内部模型 -> clash / singbox / base64 / uri）
    public/       管理面板静态资源
