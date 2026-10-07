# MCP Registry — Architecture Brainstorm

> Trạng thái: **brainstorm / chưa chốt**. Tài liệu này không chứa implementation.
> Mục tiêu: làm rõ vấn đề, challenge các giả định ban đầu, so sánh phương án, và liệt kê các quyết định cần chốt trước khi viết code.
>
> Quy ước: trong tài liệu, CLI được gọi tạm là `loadout` (lý do chọn tên ở §17). Ở những chỗ so sánh với đề xuất ban đầu thì vẫn dùng `mcp-manager`.

---

## 0. TL;DR — 7 điểm challenge quan trọng nhất

1. **Đây không phải "Registry" theo nghĩa của hệ sinh thái MCP.** "MCP Registry" (registry.modelcontextprotocol.io, GitHub MCP Registry) là nơi *publish & discover* server. Thứ bạn cần là **Configuration Manager có catalog nội bộ** — gần với *package manager cho MCP config* (catalog + manifest + lockfile + renderer) hơn là registry.
2. **Mapping repo → MCP nên thuộc về repo, không thuộc registry trung tâm.** Registry giữ *định nghĩa* (server, profile, policy). Repo giữ *nhu cầu* (dùng server nào, với tham số gì). Giống `package.json` + npm registry. Đặt 500 file `repositories/*.yaml` trong registry trung tâm biến platform team thành bottleneck và tách mapping khỏi vòng đời code.
3. **Registry phải nằm trên "change path", không bao giờ nằm trên "run path".** Khi dev mở Cursor/Claude Code, không được có network call nào tới registry. Registry chết ⇒ không ai bị ảnh hưởng cho tới lần thay đổi config kế tiếp.
4. **Registry không phải security boundary.** Ai cũng có thể tự tay viết `.mcp.json`. Boundary thật là **credential + network + quyền phía server** (DB user read-only, GitHub token scope). Registry chỉ làm governance và DX. *Config được share; identity là của từng người.*
5. **Override bằng tham số khai báo, không bằng patch.** Server định nghĩa schema tham số (`database`, `readOnly`, `password: secret`). Repo chỉ được set tham số. Không ai được override `command`/`args` tuỳ ý. Điều này loại bỏ 80% độ phức tạp của inheritance.
6. **Environment không nên là một tầng trong hierarchy.** Nó là *runtime selection* (overlay) và *policy dimension* (production bị cấm mặc định). Model C (`repo → env → profile → servers`) sẽ nổ tổ hợp ở 500 repo.
7. **`.claude/settings.json` không phải nơi khai báo MCP server của project.** Với Claude Code, project-scoped server nằm ở `.mcp.json` ở root repo; `settings.json` chỉ chứa permissions / bật-tắt server. Mỗi client có format khác nhau (VS Code dùng key `servers` + `inputs`, Codex dùng TOML) ⇒ cần một **Intermediate Representation + adapter** cho từng client.

---

## A. Problem Definition (§2)

### A.1 Vấn đề thực sự là gì?

Phát biểu lại một cách chính xác:

> Với N repository và M MCP server, mỗi repo cần một **tập con** các server, mỗi server cần **tham số riêng theo repo** (database nào, Jira project nào), và **credential riêng theo người dùng**. Hiện tại thông tin này bị copy/paste vào từng repo theo format riêng của từng AI client, dẫn tới: drift, không biết repo nào dùng gì, khó update version, secret dễ bị lộ, không có review.

Tách ra thành 4 vấn đề con:

| # | Vấn đề con | Câu hỏi nó trả lời |
|---|---|---|
| P1 | **Catalog** | Tổ chức có những MCP server nào được phép dùng, ai sở hữu, version nào, an toàn không? |
| P2 | **Binding** | Repo X dùng server nào, với tham số gì? |
| P3 | **Rendering / Distribution** | Biến binding thành file mà Cursor / Claude Code / VS Code hiểu được, và giữ nó đồng bộ. |
| P4 | **Secret resolution** | Server cần credential — lấy từ đâu lúc runtime mà không bao giờ nằm plaintext trong Git? |

Giá trị lớn nhất **không** nằm ở P1 (danh sách server — cái đó official registry đã làm), mà ở **P2 + P3 + P4**: tham số hoá theo repo, render đa client, và secret.

### A.2 Phân biệt các khái niệm

Dùng 2 trục: **design-time vs runtime** và **metadata vs data plane**.

```text
                    DESIGN-TIME (change path)          RUNTIME (run path)
                ┌────────────────────────────────┬──────────────────────────────┐
  METADATA      │ Server Registry (what exists)  │                              │
  / CONFIG      │ Repository Registry (inventory)│                              │
                │ Configuration Manager          │ Workspace Manager            │
                │   (desired state → files)      │   (session / dev env)        │
                ├────────────────────────────────┼──────────────────────────────┤
  DATA PLANE    │                                │ Orchestrator (process mgmt)  │
                │                                │ Gateway (proxy tool calls)   │
                └────────────────────────────────┴──────────────────────────────┘
                     Control Plane = quản lý desired state + policy cho cả data plane
```

| Khái niệm | Định nghĩa | Ví dụ | Có phải project này? |
|---|---|---|---|
| **MCP Server Registry** | Danh mục server: metadata, package, version. Publish & discover. | Official MCP Registry, Docker MCP Catalog | **Một phần** — catalog nội bộ được curate |
| **MCP Configuration Manager** | Quản lý desired-state config và render ra file cho client. | Giống Helm values / Renovate / dotfiles manager | **Có — đây là lõi** |
| **MCP Repository Registry** | Inventory các repo + owner. | Backstage catalog, GitHub org | **Không nên build** — tái sử dụng GitHub/Backstage |
| **MCP Workspace Manager** | Quản lý phiên làm việc: mở repo nào, devcontainer, multi-root. | devcontainer, Coder, Gitpod | Không |
| **MCP Orchestrator** | Lifecycle process server: start/stop/restart/health/scale. | Docker MCP Toolkit, supervisor | Không (client tự spawn stdio server) |
| **MCP Gateway** | Proxy runtime: auth, routing, aggregate nhiều server thành một, audit từng tool call. | Các MCP gateway/proxy | **Không ở MVP** — Level 3 |
| **MCP Control Plane** | Desired state + policy + secret + phân phối cho data plane (gateway). | Mô hình Envoy/Istio áp vào MCP | Đích đến xa (Level 3), không phải điểm xuất phát |

**Kết luận phân loại:** Project này là **MCP Configuration Manager có catalog nội bộ** — chính xác hơn là *"dependency manager cho MCP config"*:

```text
catalog (registry repo)  +  manifest (mỗi repo)  +  lockfile  +  renderer (adapter cho client)  +  secret launcher
```

Lý do: toàn bộ giá trị nằm ở design-time; runtime vẫn do AI client tự spawn server. Không có process nào của chúng ta phải chạy liên tục. Đó cũng là lý do MVP rẻ và không có SPOF.

---

## B. Core Concepts — Domain model (§3)

### B.1 Đánh giá từng entity được gợi ý

| Entity | Cần? | Lý do |
|---|---|---|
| **MCP Server (definition)** | ✅ Cần | Đơn vị reuse. Mô tả *phần mềm* + transport + schema tham số. |
| **Repository** | ⚠️ Không phải entity được author | Identity suy ra từ git remote. Trong registry trung tâm, Repository chỉ là **read-model** (inventory được index), không phải file người ta viết tay. |
| **Mapping / Binding** | ✅ Cần, nhưng là **value object** | Không phải entity độc lập có ID riêng. Nó là `(serverRef, params)` nằm trong manifest của repo. |
| **Profile** | ⚠️ Tuỳ chọn | Hữu ích ở quy mô lớn, nhưng chỉ là **macro/bundle** — không có inheritance nhiều tầng. |
| **MCP Tool** | ❌ Không author | Tool do server tự expose qua `tools/list`. Model hoá thủ công sẽ drift ngay. Chỉ nên là **dữ liệu dẫn xuất** (capability snapshot từ introspection). |
| **Environment** | ❌ Không ở MVP | Là overlay lúc runtime + chiều policy, không phải tầng hierarchy (xem §12). |
| **Credential / Secret** | ❌ Không lưu | Chỉ có **SecretRef** (value object, URI). Registry không bao giờ thấy giá trị. |
| **Version** | ⚠️ Là thuộc tính, không phải entity | `version` trên Server + **Lockfile** ở repo. |
| **Tag** | ❌ Không phải entity | Thuộc tính của Server (list string). |
| **Team / Owner** | ❌ Không model | Tham chiếu tới GitHub team / IdP đã có. |
| **Policy** | ✅ Cần (nhỏ) | Quy tắc allow/deny ở cấp tổ chức (vd. cấm production, server `restricted`). |
| **Target / Client Adapter** | ✅ Cần, nhưng là **code**, không phải data | Mỗi client một adapter: IR → `.mcp.json`, `.cursor/mcp.json`, ... |

### B.2 Domain model đề xuất

```text
                       ┌─────────────────────── REGISTRY REPO (central) ───────────────────────┐
                       │                                                                         │
                       │  Server ─────────────┐        Profile                Policy             │
                       │   name, version       │         name                   rules             │
                       │   owner (team ref)    │         servers: [ServerRef    (allow/deny)      │
                       │   transport           │                  + default                       │
                       │   params schema ◄─────┼──────────         params]                         │
                       │   metadata/tags       │                                                  │
                       │   status              │                                                  │
                       └───────────▲───────────┴──────────────▲──────────────────────────────────┘
                                   │ ServerRef(name[@range])  │ ProfileRef
                       ┌───────────┴──────────── CONSUMER REPO ┴──────────────────────────────────┐
                       │  Manifest (loadout.yaml)                                                 │
                       │    profiles: [ProfileRef]                                                │
                       │    servers:  { name → Binding(params, SecretRef...) }                    │
                       │    targets:  [claude-code, cursor, ...]                                  │
                       │                                                                          │
                       │  Lockfile (loadout.lock)  = danh sách phẳng Binding đã resolve           │
                       │    (exact version, content hash, registry commit)                        │
                       │                                                                          │
                       │  Generated: .mcp.json, .cursor/mcp.json, ...  (output của adapter)      │
                       └──────────────────────────────────────────────────────────────────────────┘
```

Quan hệ:
- `Server 1 — * Binding` (một server được bind ở nhiều repo, mỗi nơi tham số khác).
- `Profile * — * Server` (bundle).
- `Manifest 1 — * Binding`, `Manifest * — * Profile`.
- `Lockfile` = phép chiếu phẳng (Model A) của Manifest sau khi resolve profile.

### B.3 So sánh "Repo → Mapping → Server" vs "Repo → Profile → Servers"

Không cần chọn một. Đề xuất: **Profile là authoring sugar, Binding phẳng là sự thật.** Repo có thể include profile *và* khai báo binding trực tiếp; lockfile luôn là danh sách phẳng để review/diff/grep.

---

## C. Repository Mapping — Model A / B / C (§4)

Giả định quy mô: 500 repo, ~30 server, trung bình 4 server/repo ⇒ ~2000 binding.

| Tiêu chí | **Model A** `repo → server` | **Model B** `repo → profile → servers` | **Model C** `repo → env → profile → servers` |
|---|---|---|---|
| Độ tường minh | Cao nhất — đọc 1 file biết hết | Trung bình — phải mở profile | Thấp — phải resolve 3 tầng |
| Số dòng config | ~2000 binding | Ít hơn nhiều | Ít/env nhưng × số env |
| "Thêm sentry-mcp cho mọi backend" | 300 PR (bot làm được) | Sửa 1 profile | Sửa N profile × env |
| Blast radius khi đổi | Nhỏ, cục bộ | **Lớn**: 1 commit ảnh hưởng 300 repo cùng lúc | Rất lớn và khó dự đoán |
| Rủi ro dài hạn | Lặp lại | **Profile explosion** (`backend`, `backend-no-jira`, `backend-es`...) | Ma trận tổ hợp, không ai hiểu nổi |
| Tham số theo repo (db name) | Tự nhiên | Vẫn phải khai báo ở repo — profile không giúp | Như B |
| Grep "repo nào dùng postgres?" | Dễ | Phải resolve | Khó |

Nhận xét quan trọng: **profile không loại bỏ được binding theo repo**, vì phần khác biệt thật sự (database, Jira project) là dữ liệu riêng của repo. Profile chỉ tiết kiệm được các server "không tham số" hoặc tham số suy ra được (github, jira org).

**Khuyến nghị cho 50–500 repo: Hybrid A+B.**
- Authoring: repo có thể `profiles: [backend]` + `servers: {...}` + `exclude: [...]`.
- Profile **chỉ một tầng**, không profile-extends-profile; số lượng profile được giới hạn (gợi ý ≤ 5–8 profile toàn tổ chức, do platform sở hữu).
- Truth: **lockfile phẳng (Model A)**, commit vào repo ⇒ thay đổi profile **không tự lan** sang 300 repo; nó tới từng repo qua `loadout update` / bot PR, được review từng nơi.
- Model C bị loại; environment xử lý ở §12.

Một kỹ thuật giảm số binding hơn cả profile: **context variables**. Server definition có thể dùng biến suy ra từ repo, ví dụ `{{ repo.slug }}`, `{{ repo.owner }}`. Khi đó `github` không cần tham số nào ở repo — nó tự trỏ đúng repo.

---

## D. Scope / Isolation / Inheritance (§5)

### D.1 Các tầng — cố định, tối đa 4, thứ tự không đổi

```text
1. Server defaults            (server owner)      registry/servers/postgres/server.yaml
2. Profile defaults           (platform)          registry/profiles/backend.yaml        [tuỳ chọn]
3. Repo binding params        (repo team)         <repo>/loadout.yaml                    [commit]
4. Developer local override   (từng dev)          <repo>/loadout.local.yaml              [gitignore]
   (+ Environment overlay — phase 2, là một lựa chọn trong tầng 3, không phải tầng mới)
```

**Có nên hỗ trợ inheritance không?** Có, nhưng là *parameter layering*, không phải *object inheritance*. Quy tắc để không vượt tầm kiểm soát:

1. **Chỉ override tham số đã khai báo.** Server khai báo `params` (có type, required, default). Tầng 2–4 chỉ được set giá trị cho các key đó. `command`, `args`, `transport` là bất biến ngoài server definition.
2. **Độ sâu cố định**, không có `extends` tuỳ ý, không có chain.
3. **Merge semantics đơn giản và được document:** map → merge theo key; list → **replace** (không bao giờ merge list); `null` → unset về default.
4. **Param bị khoá:** server owner có thể đánh dấu `overridable: false` (vd. `readOnly: true` cho postgres) hoặc policy yêu cầu điều đó.
5. **Param kiểu `secret` chỉ chấp nhận SecretRef**, không chấp nhận literal — validator chặn.
6. **Tầng 4 (local) chỉ cho phép một số param** được server đánh dấu `localOverride: true` (vd. `host` → `localhost`), để dev không âm thầm trỏ sang DB khác.
7. **Provenance luôn tra được:** `loadout explain postgres` in ra từng field lấy giá trị từ tầng nào.

### D.2 Ví dụ isolation

```text
promotion-engine                      seller-center
  postgres                              postgres
    host      = pg-dev.internal  (3)      host      = pg-dev.internal  (3)
    database  = promotion_db     (3)      database  = seller_db        (3)
    readOnly  = true             (1, locked)
    password  = secret://...promotion... (3)   password = secret://...seller... (3)
  github                                github
    repo      = {{repo.slug}} → promotion-engine (1)   → seller-center (1)
  jira
    project   = PE               (3)
```

### D.3 Permission boundary

Registry/CLI **không** cấp quyền. Ba lớp bảo vệ thật:
- **Credential**: mỗi dev dùng identity của mình để resolve SecretRef ⇒ secret manager quyết định ai đọc được `promotion/db-readonly`.
- **Phía server**: DB user read-only, GitHub token scope tối thiểu, Jira permission scheme.
- **Network**: production không reachable từ laptop.

Registry chỉ thêm lớp **governance** (policy fail CI, cảnh báo) — hữu ích nhưng không thay thế được ba lớp trên.

---

## E. Configuration Ownership (§6)

| Đối tượng | Owner đề xuất | Cơ chế |
|---|---|---|
| Server generic (github, jira, postgres, redis, elasticsearch) | Platform / DevEx team | CODEOWNERS trên `servers/<name>/` |
| Server domain-specific (vd. `pricing-service-mcp` do team tự viết) | Team viết ra server đó | CODEOWNERS |
| Profile | Platform | CODEOWNERS trên `profiles/` |
| Policy | Platform + Security | CODEOWNERS trên `policy/` |
| Binding (repo dùng gì, tham số gì) | **Team sở hữu repo** | Nằm trong repo, review như code |
| Local override | Từng developer | gitignored |

**Challenge "promotion-db-mcp owner: promotion-team":** nếu nó chỉ là postgres MCP trỏ vào `promotion_db` thì **nó không phải một server mới** — nó là binding của server `postgres`. Chỉ tạo server definition mới khi *phần mềm* khác nhau. Nếu không, bạn sẽ có 40 bản copy của postgres definition — đúng cái anti-pattern đang muốn loại bỏ.

**Repo có dùng MCP của team khác được không?**
- Server generic: **được** — nó chỉ là phần mềm; quyền truy cập dữ liệu do credential quyết định.
- Server có `visibility: restricted`: chỉ repo/team trong `allowedConsumers` (owner duyệt qua CODEOWNERS khi sửa danh sách). Enforcement ở CI của repo consumer + CLI.

**Có cần ACL/RBAC không?**
- Level 1: **Không tự build RBAC.** Git (CODEOWNERS, branch protection) + secret manager ACL là đủ.
- Level 2+: khi có Web UI/API ghi dữ liệu thì mới cần RBAC — và nên map từ IdP/GitHub teams, không tạo user store riêng.

---

## F. Secrets (§7)

### F.1 Nguyên tắc

```text
Registry / manifest / lockfile / generated files  →  chỉ chứa SecretRef (URI)
Giá trị secret                                   →  chỉ tồn tại trong memory/env của process MCP server
```

Định dạng SecretRef đề xuất — URI có scheme theo provider, để pluggable:

```text
env://PG_PASSWORD
keychain://loadout/promotion-db
op://Engineering/promotion-db-readonly/password       (giữ nguyên format native của 1Password)
vault://kv/dev/promotion/db#password
aws-sm://dev/promotion/db#password
```

### F.2 Ba chiến lược resolve (quan trọng hơn chuyện chọn vendor)

| Chiến lược | Cách hoạt động | Ưu | Nhược |
|---|---|---|---|
| **S1. Env interpolation** | File generated chứa `"PGPASSWORD": "${PGPASSWORD}"` (Claude Code: `${VAR}`; Cursor: `${env:VAR}`; VS Code: `${input:...}`/`envFile`). Dev tự export env (direnv, `op run`...). | Không phụ thuộc CLI lúc runtime | **App GUI (Cursor mở từ Dock) không kế thừa env của shell**; secret nằm trong env của editor ⇒ **agent chạy lệnh shell có thể `env` ra secret**; mỗi client cú pháp khác |
| **S2. Exec launcher** | File generated: `command: loadout, args: [exec, --secret, PGPASSWORD=vault://..., --, <real server cmd>]`. Launcher resolve secret lúc spawn rồi `exec` server thật (giống `op run`, `aws-vault exec`). | Secret chỉ nằm trong env của *process server*, không lộ cho agent; hoạt động với app GUI; một điểm resolve cho mọi client; dễ thêm short-lived credential | Mọi máy chạy agent phải cài CLI (kể cả cloud agent/CI); thêm một hop khi debug; latency/prompt mỗi lần spawn nếu provider chậm |
| **S3. Remote MCP + OAuth** | Server là HTTP remote (vd. GitHub, Atlassian có remote MCP), client tự làm OAuth. | **Không có secret nào** cần quản lý | Chỉ áp dụng cho server có bản remote; phụ thuộc client hỗ trợ OAuth |

**Khuyến nghị:** ưu tiên **S3 > S2 > S1**. S2 là mặc định cho stdio server có secret; S1 là fallback cho môi trường không cài được CLI.

Lưu ý riêng cho bối cảnh AI agent: **secret trong file của workspace (`.env`) tệ hơn bình thường**, vì agent có quyền đọc file trong repo. Tương tự, secret trong env của editor process có thể bị agent đọc qua tool shell.

### F.3 So sánh backend

| Backend | Phù hợp | Không phù hợp | Ghi chú |
|---|---|---|---|
| `.env` | Prototype cá nhân | Mọi thứ khác | Plaintext trên đĩa, nằm trong workspace mà agent đọc được, dễ commit nhầm |
| Environment variables | CI, container | Laptop với app GUI | Kế thừa sang mọi child process |
| OS keychain | Secret cá nhân trên laptop | Chia sẻ team, rotation | Tốt làm **cache** cho provider khác |
| 1Password (CLI) | Team nhỏ–vừa, secret dùng chung, có biometric | Credential động | `op://` reference rất hợp với mô hình SecretRef |
| Vault | Credential **động, ngắn hạn** (DB user tạo theo phiên) — lý tưởng cho postgres | Team không có người vận hành Vault | Chi phí vận hành cao nhất |
| AWS Secrets Manager | Tổ chức AWS-native, dev đã có SSO | Multi-cloud / dev không có AWS creds | IAM làm ACL |
| Kubernetes Secret | MCP server chạy **trong cluster** (Level 3, gateway) | Laptop dev | Không phải lựa chọn cho local |
| Local credential store tự build | — | **Không bao giờ** | Đừng tự viết crypto/storage |

**Quyết định cần chốt:** provider đầu tiên mà tổ chức thực sự đang dùng (MVP chỉ cần `env://` + **một** provider thật).

---

## G. Developer Experience (§8)

### G.1 Challenge command design ban đầu

```bash
mcp-manager repo add promotion-engine
mcp-manager repo attach promotion-engine postgres
```

Các lệnh này giả định có một **state trung tâm mutable** (DB) và cho phép người ở repo A sửa mapping của repo B. Điều đó ngược với Git-first và ownership theo repo.

**Nguyên tắc đề xuất:**
1. **CLI là stateless, file là sự thật.** Mọi lệnh "ghi" chỉ sửa file trong repo hiện tại và in diff.
2. **Scope theo thư mục hiện tại** (như `npm`, `cargo`, `uv`) — không cần truyền tên repo.
3. Lệnh dùng thường xuyên là động từ top-level; lệnh của maintainer registry nằm trong namespace.

### G.2 Command set

```bash
# Consumer (trong một repo)
loadout init                       # tạo loadout.yaml, detect repo từ git remote, gợi ý profile
loadout search <query> [--tag t]   # tìm trong catalog (offline, từ cache)
loadout info <server>              # mô tả, owner, params, versions, tools, status
loadout add <server> [--set k=v]   # thêm binding → validate → lock → render
loadout remove <server>
loadout sync                       # resolve → loadout.lock → render file cho các target
loadout update [<server>]          # nâng version đã lock (giống npm update)
loadout status                     # drift: manifest vs lock vs file generated vs registry mới nhất
loadout explain <server>           # provenance từng field
loadout doctor                     # runtime check: runtime có chưa, secret resolve được không, server handshake OK
loadout check                      # cho CI: validate + đảm bảo file generated khớp (--frozen)
loadout exec <server> -- ...       # launcher resolve secret (được gọi bởi file generated)

# Maintainer registry
loadout server new <name>          # scaffold server.yaml
loadout server test <name>         # spawn trong sandbox, initialize, tools/list, snapshot capability

# Phase 2
loadout inventory [--server postgres]   # repo nào dùng gì, version nào
```

### G.3 So sánh các interface

| Interface | Ưu | Nhược | Khi nào |
|---|---|---|---|
| **CLI** | Nhanh, scriptable, chạy trong CI, offline | Discoverability kém với người mới | MVP |
| **Config file (YAML)** | Review được, diff được, rollback bằng git | Lỗi cú pháp, cần schema | MVP — là nguồn sự thật |
| **Git workflow (PR)** | Audit, approval, CODEOWNERS miễn phí | Vòng lặp chậm cho thay đổi nhỏ | MVP |
| **Web UI** | Discovery, dashboard "ai dùng gì", người không dùng CLI | Tốn công build; dễ thành nguồn sự thật thứ hai | Phase 2, **read-only**. Nếu đã có Backstage thì làm plugin thay vì UI riêng |
| **API** | Tích hợp bot, dashboard, gateway | Phải vận hành, auth, uptime | Phase 2 dạng read-model; ghi vẫn qua Git |

---

## H. Repository Configuration — Option A / B / C (§9)

| | **A. Không có file** | **B. File identity** (`repository: x, profile: y`) | **C. File khai báo nhu cầu** |
|---|---|---|---|
| Nguồn sự thật mapping | Registry trung tâm | Registry trung tâm | **Repo** |
| Thay đổi đi cùng code? | Không | Không | **Có** — PR thêm Elasticsearch có thể thêm luôn ES MCP |
| Branch-aware | Không | Không | **Có** |
| Offline / cloud agent clone repo mới | Phụ thuộc registry | Phụ thuộc registry | Có lockfile + file generated ⇒ không phụ thuộc |
| Ownership | Platform (bottleneck) | Platform | Team của repo |
| Visibility toàn tổ chức | Sẵn có | Sẵn có | Cần indexer quét repo (phase 2) |
| Rename repo | Mapping gãy nếu key theo tên | Gãy | Không ảnh hưởng (identity từ git remote) |

Nhận xét về Option B: trường `repository: promotion-engine` là **dư thừa và nguy hiểm** — git remote đã là identity; trường tên tay sẽ lệch khi rename/fork.

**Khuyến nghị: Option C mở rộng ("C+")** — repo chứa manifest *nhỏ* khai báo profile/server + tham số + target, **không bao giờ** chứa server definition; kèm lockfile. Visibility toàn cục giải quyết bằng indexer (đọc `loadout.lock` của mọi repo) — đó là read-model, không phải nguồn sự thật thứ hai.

---

## I. Generated Configuration (§10)

### I.1 Ba mô hình

| Mô hình | Mô tả | Đánh giá |
|---|---|---|
| **Registry → generate local config** | CLI render file native cho từng client | ✅ **Khuyến nghị.** Client hiện nay đọc file tĩnh; đây là đường duy nhất hoạt động với mọi client mà không cần client hỗ trợ gì đặc biệt |
| **Registry → CLI → AI Client** | Client gọi CLI để lấy config lúc khởi động | ❌ Không client nào có hook "lấy config từ lệnh"; phần "CLI lúc runtime" chỉ hợp lý ở dạng launcher cho từng server (S2) |
| **AI Client → Registry API** | Client đọc config từ API | ❌ Hiện không phải tính năng chuẩn của client. Muốn vậy phải dựng **một MCP proxy/gateway** đứng giữa — đó là Level 3, với trade-off: một điểm lỗi, namespacing tool, phá OAuth native của từng server, thêm latency |

### I.2 Thực tế các client (cần kiểm tra lại docs hiện hành khi implement — format thay đổi nhanh)

| Client | File project-scoped | Khác biệt chính |
|---|---|---|
| Claude Code | `.mcp.json` (root repo), key `mcpServers` | Hỗ trợ `${VAR}` / `${VAR:-default}`; người dùng phải approve server project-scoped; `.claude/settings.json` chỉ chứa permission/bật-tắt, **không** chứa định nghĩa server |
| Cursor | `.cursor/mcp.json`, key `mcpServers` | Interpolation dạng `${env:VAR}`, `${workspaceFolder}`; có `envFile` |
| VS Code (Copilot) | `.vscode/mcp.json`, key **`servers`** | Có `inputs` (prompt secret, `password: true`) → `${input:id}`; field `type: stdio/http` |
| Codex CLI | Chủ yếu `~/.codex/config.toml` (`[mcp_servers.x]`) | TOML, thiên về user-scope |
| Gemini CLI | `.gemini/settings.json`, key `mcpServers` | |
| Windsurf | Chủ yếu config global | Có thể không có project-scope ⇒ adapter phải ghi user-scope hoặc bỏ qua |

Hệ quả kiến trúc:

```text
Manifest + Registry ──resolve──► IR (Intermediate Representation, client-agnostic)
                                   │
                ┌──────────────────┼──────────────────┬───────────────┐
           claude-code          cursor            vscode           codex ...
           adapter              adapter           adapter          adapter
                │                  │                 │
            .mcp.json      .cursor/mcp.json   .vscode/mcp.json
```

- IR là hợp đồng duy nhất; adapter là plugin có golden-file test.
- Adapter phải báo lỗi rõ khi client **không biểu diễn được** một tính năng (vd. client không hỗ trợ HTTP transport).

### I.3 Commit file generated hay gitignore?

| | Commit | Gitignore |
|---|---|---|
| Clone xong dùng được ngay (kể cả cloud agent, người không cài CLI) | ✅ | ❌ phải chạy `sync` |
| Review được output thực sự | ✅ | ❌ |
| Drift / sửa tay | Rủi ro → giải bằng header "GENERATED" + `loadout check --frozen` trong CI | Không drift trong repo, nhưng drift trên máy dev |
| Nhiều file rác cho client không dùng | Chỉ render target được khai báo | — |

**Khuyến nghị:** commit file generated (chỉ cho các `targets` khai báo), CI chặn drift. Đây là quyết định cần chốt (#2 ở §20).

---

## J. Versioning (§11)

Có **hai** thứ có version, đừng nhầm:

1. **Phần mềm server** — npm package `@acme/mcp-postgres@0.6.2`, image `ghcr.io/acme/mcp-jira@sha256:...`.
2. **Definition** — file `server.yaml` (schema params, args, defaults).

Quy tắc:
- Definition **luôn pin exact** phần mềm. Cấm `npx -y pkg` không version, cấm `@latest`, cấm tag image mutable. (Supply chain.)
- Manifest của repo tham chiếu **tên** (`postgres`) hoặc **major** (`postgres@2`), không cần exact.
- **Lockfile** pin exact: version definition + content hash + version phần mềm + registry commit.
- Release đã publish là **immutable**; sửa lỗi = version mới.

So sánh cách reference:

| Reference | Dùng ở đâu |
|---|---|
| `postgres` (floating) | Manifest — tiện, an toàn nhờ lockfile |
| `postgres@2` / `^2` | Manifest — khi có breaking change và cần chạy song song v1/v2 |
| `postgres@1.4.0` | Chỉ trong lockfile (hoặc pin tạm thời có lý do) |
| git commit | Lockfile ghi registry commit để reproduce |
| `latest` | Không bao giờ ở lockfile; không bao giờ cho package phần mềm |

**Lộ trình:**
- **MVP:** version theo *snapshot registry* (commit SHA) + content hash từng server trong lockfile. Breaking change ⇒ tạo definition song song (`servers/postgres@2/`). Đơn giản, đủ cho repo A ở v1, repo B ở v2.
- **Phase 2:** semver độc lập cho từng server, release tự động, changelog, bot PR (kiểu Renovate) khi có version mới.

---

## K. Environment (§12)

Challenge: "environment" trong câu hỏi trộn hai thứ:
- **Nơi agent chạy** (laptop, CI, cloud agent) — quyết định *cách resolve secret*.
- **Hệ thống mà tool trỏ vào** (DB local, dev, staging, prod) — quyết định *tham số*.

Không cái nào cần là một tầng trong hierarchy domain.

Đề xuất:
- **MVP:** không có environment. Mặc định trỏ vào `dev`; dev muốn local thì dùng `loadout.local.yaml` (override `host` → `localhost`).
- **Phase 2:** *overlay có tên* trong manifest, chọn lúc sync/runtime:

```yaml
servers:
  postgres:
    params: { host: pg-dev.internal, database: promotion_db, password: vault://kv/dev/promotion/db#password }
overlays:
  staging:
    postgres:
      params: { host: pg-staging.internal, password: vault://kv/staging/promotion/db#password }
```

- **Production:** policy **deny mặc định**. Nếu thực sự cần agent đọc production, đi qua gateway có audit + credential động (Level 3), không qua file config trên laptop.

Kết luận: Environment là **runtime concern + policy dimension**, không phải entity.

---

## L. Discovery (§13)

Metadata của server:

```yaml
name: postgres
description: PostgreSQL access for AI agents (read-only by default)
category: data                   # 1 giá trị, taxonomy cố định, do platform quản lý
tags: [database, sql, backend]   # tự do nhưng có lint chống trùng nghĩa (db/database)
owner: team-platform
status: stable                   # experimental | stable | deprecated (+ replacedBy) | removed
compatibility:
  transports: [stdio]
  runtime: node>=20
  clients: [claude-code, cursor, vscode]   # adapter đã được test
capabilities:                    # DẪN XUẤT từ tools/list lúc CI, không viết tay
  tools: [query, list_tables, describe_table]
  annotations: { readOnly: true, destructive: false }
```

- **Search MVP:** tìm local trên index đã cache (name, description, tags, category). Không cần server.
- **Capabilities** lấy từ introspection (`tools/list` + tool annotations như `readOnlyHint`/`destructiveHint`). Diff capability được đăng vào PR của registry ⇒ reviewer thấy "version mới thêm tool `execute_sql` có thể ghi".
- **Status lifecycle** giúp deprecate có kiểm soát: `loadout status` cảnh báo repo đang dùng server deprecated.

---

## M. Validation lifecycle (§14)

```text
 Register ──► Validate ──► Publish ──► Attach ──► Sync ──► Runtime
 (PR registry) (CI registry) (merge/tag) (add + CI repo) (render) (doctor/exec)
```

| Giai đoạn | Chạy ở đâu | Kiểm tra |
|---|---|---|
| **Register** | PR vào registry | Schema hợp lệ, tên đúng convention, owner tồn tại, CODEOWNERS |
| **Validate** | CI registry | Package/image tồn tại và **pin exact**; param `secret` khai báo đúng; **smoke test**: spawn trong sandbox → `initialize` → `tools/list`; snapshot + diff capability; policy (vd. server mới mặc định `experimental`) |
| **Publish** | Merge vào main | Build index cho search; release immutable |
| **Attach** | `loadout add` + CI của repo | Server tồn tại & không `removed`; version resolve được; params đủ và đúng type; SecretRef đúng cú pháp/scheme; policy cho phép (visibility, readOnly, env) |
| **Sync** | Local + CI (`--frozen`) | Mọi target biểu diễn được IR; file generated khớp lockfile |
| **Runtime** | Máy dev (`doctor`), launcher (`exec`) | Runtime/binary có sẵn; **secret resolve được với identity hiện tại**; network reachable; handshake thành công |

Lưu ý: "secret resolve được không" **không** kiểm tra được trong CI một cách có ý nghĩa (CI không mang identity của dev). CI chỉ kiểm tra cú pháp + (tuỳ chọn) sự tồn tại của path với identity CI.

---

## N. Architecture Levels (§15)

### Level 1 — Simple (Git + YAML + CLI)

```text
registry repo (Git) ──► CI (lint, smoke test, index) ──► CLI (cache theo commit) ──► repo: manifest + lock + generated files
```

- **Khi nào:** từ vài tới ~100–200 repo, 1 team platform, đã có GitHub/GitLab làm auth.
- **Chi phí:** vài tuần cho 1–2 kỹ sư. Không có service nào cần vận hành.

### Level 2 — Internal Platform

```text
Git (nguồn sự thật) ──► Indexer ──► Read-model DB ──► API (read) ──► Web UI / Backstage plugin / Bot
                                         ▲
                     quét loadout.lock của mọi repo (inventory)
```

- **Khi nào:** > ~100 repo hoặc nhiều team cần discovery; cần dashboard "ai dùng postgres v1"; cần bot PR cập nhật hàng loạt; có người không dùng CLI.
- **Nguyên tắc:** **Git vẫn là nguồn sự thật**; DB chỉ là projection có thể dựng lại từ Git. Ghi vẫn đi qua PR (UI có thể tạo PR hộ).

### Level 3 — Enterprise Control Plane

```text
                MCP Control Plane (desired state, policy, secrets, audit)
                         │ push config
          ┌──────────────┼──────────────┐
       Gateway        Policy engine   Secret broker (dynamic creds)
          │
   Remote MCP servers chạy tập trung (k8s)  ◄── client kết nối qua HTTP + OAuth
```

- **Khi nào:** yêu cầu compliance (audit từng tool call), agent truy cập dữ liệu nhạy cảm/production, cần kill-switch tập trung, nhiều server được host tập trung.
- **Cảnh báo:** đây là **sản phẩm khác** (data plane), không phải "Level 2 thêm tính năng". Chỉ làm khi có yêu cầu cụ thể.

---

## O. GitOps (§16)

### O.1 Đánh giá cấu trúc đề xuất ban đầu

```text
mcp-registry/
├── servers/        ✅ đúng chỗ
├── repositories/   ⚠️ nên chuyển vào từng repo (manifest)
└── profiles/       ✅ đúng chỗ, nhưng giới hạn số lượng
```

Vấn đề với `repositories/` trong registry ở 500 repo:
- Platform team trở thành approver cho mọi thay đổi MCP của mọi team (hoặc CODEOWNERS 500 dòng).
- Thay đổi code cần MCP mới phải mở PR ở **hai** repo, merge không nguyên tử.
- Không branch-aware: không thể thử MCP mới trên feature branch.
- Repo bị rename/archive ⇒ file mồ côi.

Giữ được lợi ích "nhìn tập trung" bằng **inventory được index** (phase 2) thay vì nguồn sự thật tập trung.

### O.2 Ưu / nhược và cách giảm nhược điểm

| Nhược điểm | Giảm thiểu |
|---|---|
| Secrets | Chỉ SecretRef; secret scanning trong CI; validator chặn literal ở param `secret` |
| Thay đổi động (thử nhanh) | `loadout.local.yaml` cho thử nghiệm cá nhân; registry change là việc hiếm |
| DX (phải biết YAML/PR) | CLI sửa file hộ (`add`, `server new`), JSON Schema cho autocomplete trong IDE |
| Đồng bộ (registry đổi → repo chưa đổi) | Lockfile + `loadout status` + bot PR (phase 2). **Không** tự động đẩy thay đổi vào mọi repo |
| Phân phối registry tới CLI | CLI fetch theo commit đã lock, cache local; không cần registry online để chạy |

---

## P. Naming (§17)

Tiêu chí: (1) không va chạm với thuật ngữ đã có nghĩa trong hệ sinh thái MCP; (2) diễn tả được *tập MCP riêng cho mỗi repo*, không chỉ *danh sách server*; (3) CLI ngắn, gõ được; (4) không gắn vendor.

Va chạm cần lưu ý: "MCP Registry" (official + GitHub), "Docker MCP Catalog"/"MCP Toolkit", `mcpm` và một số "mcp-hub" đã tồn tại trong cộng đồng. **Phải kiểm tra trùng tên trên npm/GitHub/nội bộ trước khi chốt.**

| # | Tên | Đánh giá |
|---|---|---|
| 1 | **mcp-loadout** (CLI `loadout`) | "Loadout" = bộ trang bị được chọn cho từng nhiệm vụ ⇒ đúng ý "mỗi repo một bộ MCP". Không va chạm thuật ngữ MCP. CLI ngắn, đọc tự nhiên: `loadout add postgres`, `loadout sync` |
| 2 | **mcp-catalog** | Rõ nghĩa, đúng với phần catalog; nhưng không nói gì về binding, và gần với "Docker MCP Catalog" |
| 3 | **mcpctl** | Quen thuộc kiểu `kubectl`; nhưng gợi ý điều khiển runtime (thứ ta không làm) |
| 4 | **mcp-bindings** | Chính xác về mặt kỹ thuật (binding server ↔ repo); khô, khó thành tên sản phẩm |
| 5 | **switchboard** | Ẩn dụ tốt (nối repo với server); quá chung, nhiều sản phẩm trùng tên |
| 6 | **mcp-manifest** | Nhấn mạnh file khai báo trong repo; dễ nhầm với "manifest" của MCP server (server.json) |
| 7 | **toolbelt** | Thân thiện, DX tốt; không có "mcp" nên mơ hồ ở quy mô tổ chức |
| 8 | **mcp-config** | Mô tả đúng, nhưng quá chung — không thể search, không thể brand |
| 9 | **mcp-hub** | Dễ nhớ; trùng với nhiều project cộng đồng, gợi ý marketplace public |
| 10 | **mcp-registry** | Tên hiện tại của repo. **Gây hiểu lầm**: trong hệ sinh thái MCP, "registry" là nơi publish/discover server; người mới sẽ tưởng đây là sub-registry, và tên che mất giá trị chính (binding + render + secret) |

---

## Q. Anti-patterns (§18)

| Anti-pattern | Vì sao có vẻ hợp lý | Vì sao gây hại |
|---|---|---|
| Copy MCP config vào từng repo | Nhanh, không cần tool | Drift, không update được hàng loạt, không biết ai dùng gì |
| Registry lưu plaintext secret | "Tập trung luôn cho tiện" | Registry trở thành mục tiêu giá trị cao nhất; Git history giữ secret mãi mãi |
| Mapping nhiều tầng (repo→env→profile→server) | "Linh hoạt" | Không ai trả lời được "vì sao repo tôi có server X"; nổ tổ hợp |
| Inheritance động / templating Turing-complete (if/loop trong YAML) | "Một definition cho mọi trường hợp" | Config thành ngôn ngữ lập trình không có test; chỉ cho phép thay thế `{{ params.x }}`, không logic |
| Registry thành MCP Gateway sớm | "Tập trung thì kiểm soát tốt hơn" | Biến tool design-time thành service runtime phải 24/7; phá OAuth native; latency; SPOF |
| Coupling chặt với Cursor / Claude Code | "Team đang dùng cái đó" | Format client đổi nhanh; client mới xuất hiện liên tục ⇒ phải có IR + adapter |
| Mỗi repo tự định nghĩa MCP server | "Tự chủ" | Quay về copy/paste; không review supply chain |
| Registry là SPOF | "Lúc nào cũng gọi API lấy config mới nhất" | Registry chỉ được nằm trên change path; runtime chỉ dùng file local + lockfile |
| `npx -y package` không pin / `@latest` | Định nghĩa ngắn gọn | Supply-chain attack, build không reproducible, version âm thầm thay đổi |
| Tạo server definition riêng cho mỗi DB (`promotion-db-mcp`) | "Mỗi team một server" | N bản copy của cùng một phần mềm; dùng binding params thay vì definition mới |
| Model hoá Tool bằng tay | "Muốn kiểm soát ở cấp tool" | Drift với server thực; dùng introspection |
| Coi registry là security boundary | "Repo không được attach thì không dùng được" | Ai cũng tự viết `.mcp.json` được; boundary thật là credential |
| Lệnh `attach` sửa mapping repo khác | "Admin tiện quản lý" | Phá ownership, cần DB mutable, mất review |
| Profile "cho chắc" gắn mọi server | "Dev có đủ đồ dùng" | Quá nhiều tool làm phình context của LLM và giảm chất lượng chọn tool; mở rộng bề mặt tấn công (prompt injection qua tool output) |
| Tự động đẩy thay đổi registry vào mọi repo | "Luôn up-to-date" | Blast radius toàn tổ chức; một definition lỗi làm hỏng 500 repo cùng lúc |
| Định danh repo bằng chuỗi tên viết tay | Dễ đọc | Gãy khi rename/fork/transfer; dùng git remote |
| Agent production credential trên laptop | "Debug cho nhanh" | Một prompt injection = sự cố production |
| Tự định nghĩa format server riêng hoàn toàn | "Kiểm soát" | Nên căn chỉnh/import từ `server.json` của official registry để tái sử dụng metadata package/transport |

---

## R. Final Recommendation (§19)

### 1. Recommended domain model

```text
REGISTRY (central, Git)
  Server        name, version, owner, status, transport{stdio: package@exact + args | http: url},
                params schema {type, required, default, secret, overridable, localOverride},
                metadata {description, category, tags, compatibility}, capabilities (derived)
  Profile       name, [ServerRef + default params]          -- 1 tầng, số lượng giới hạn
  Policy        rules (deny prod, restricted servers, locked params)

CONSUMER REPO
  Manifest      profiles[], servers{name → Binding{params, SecretRef}}, exclude[], targets[]
  Lockfile      phẳng: [ResolvedBinding{server, version, hash, registryCommit, params}]
  Generated     file native cho từng target (output của adapter)
  Local         override cá nhân (gitignored, chỉ các param cho phép)

VALUE OBJECTS   ServerRef(name[@major]), SecretRef(URI), ContextVar(repo.slug, repo.owner, ...)
DERIVED         Repository inventory, capability snapshot     -- không author
CODE            Client adapters (IR → file), secret providers
```

### 2. Recommended repository structure

Registry:

```text
mcp-loadout/
├── servers/
│   ├── postgres/
│   │   ├── server.yaml
│   │   └── README.md
│   ├── github/server.yaml
│   ├── jira/server.yaml
│   ├── redis/server.yaml
│   └── elasticsearch/server.yaml
├── profiles/
│   └── backend.yaml
├── policy/
│   └── policy.yaml
├── schemas/                 # JSON Schema: server, profile, manifest, lock (IDE autocomplete)
├── .github/
│   ├── CODEOWNERS
│   └── workflows/validate.yml
└── README.md
```

CLI nên ở **repo riêng** (hoặc ít nhất release riêng): data registry thay đổi hằng ngày, CLI thay đổi hiếm — tách vòng đời để update catalog không cần release tool.

Consumer repo:

```text
promotion-engine/
├── loadout.yaml             # viết tay, review như code
├── loadout.lock             # generated, commit
├── loadout.local.yaml       # gitignored
├── .mcp.json                # generated (Claude Code), commit
└── .cursor/mcp.json         # generated (Cursor), commit
```

### 3. Recommended configuration format

`servers/postgres/server.yaml`:

```yaml
apiVersion: loadout/v1
kind: Server
name: postgres
version: 1.4.0
owner: team-platform
status: stable
description: PostgreSQL access for AI agents (read-only by default)
category: data
tags: [database, sql]

transport:
  type: stdio
  package:
    registry: npm
    name: "@acme/mcp-postgres"   # ví dụ; luôn pin exact
    version: 0.6.2

params:
  host:      { type: string,  required: true, localOverride: true }
  database:  { type: string,  required: true }
  readOnly:  { type: boolean, default: true, overridable: false }
  password:  { type: secret,  required: true }

env:
  PGHOST: "{{ params.host }}"
  PGDATABASE: "{{ params.database }}"
  PGPASSWORD: "{{ params.password }}"
  MCP_READ_ONLY: "{{ params.readOnly }}"
```

`servers/github/server.yaml` (remote, không secret):

```yaml
apiVersion: loadout/v1
kind: Server
name: github
version: 1.0.0
owner: team-platform
status: stable
transport:
  type: http
  url: https://<github-remote-mcp-endpoint>   # client tự xử lý OAuth
params:
  repository: { type: string, default: "{{ repo.slug }}" }
```

`profiles/backend.yaml`:

```yaml
apiVersion: loadout/v1
kind: Profile
name: backend
servers:
  github: {}
  jira:
    params: { site: acme.atlassian.net }
```

`loadout.yaml` trong `promotion-engine`:

```yaml
apiVersion: loadout/v1
profiles: [backend]
servers:
  postgres:
    params:
      host: pg-dev.internal
      database: promotion_db
      password: vault://kv/dev/promotion/db#password
  jira:
    params: { project: PE }
  elasticsearch:
    params:
      url: https://es-dev.internal
      apiKey: vault://kv/dev/promotion/es#api_key
targets: [claude-code, cursor]
```

`loadout.lock` (generated, ví dụ rút gọn):

```yaml
registry: { commit: 3f9c2e1 }
servers:
  github:        { version: 1.0.0, hash: sha256:…, from: profile/backend }
  jira:          { version: 2.1.0, hash: sha256:…, from: profile/backend + repo }
  postgres:      { version: 1.4.0, hash: sha256:…, package: "@acme/mcp-postgres@0.6.2" }
  elasticsearch: { version: 0.9.1, hash: sha256:… }
```

### 4. Recommended CLI

```bash
loadout init
loadout search <query>
loadout info <server>
loadout add <server> [--set key=value]
loadout remove <server>
loadout sync
loadout update [<server>]
loadout status
loadout explain <server>
loadout doctor
loadout check            # CI
loadout exec <server> -- <cmd>   # launcher, được gọi từ file generated
loadout server new <name>
loadout server test <name>
```

### 5. Recommended architecture (MVP = Level 1)

```text
┌──────────────────── mcp-loadout (Git) ────────────────────┐
│ servers/  profiles/  policy/  schemas/                     │
│ CI: schema lint → pin check → smoke test → capability diff │
└──────────────────────────┬─────────────────────────────────┘
                           │ fetch theo commit (cache local, offline OK)
                           ▼
                    loadout CLI  (laptop, CI)
   loadout.yaml ──resolve──► loadout.lock ──► IR ──adapters──► .mcp.json / .cursor/mcp.json
                                                                  │ AI client spawn
                                                                  ▼
                                    loadout exec ──► secret provider (env / 1Password / Vault)
                                                                  │
                                                                  ▼
                                                         MCP server process
```

Registry chỉ được chạm khi `add/sync/update`. Mở editor ⇒ không gọi registry.

### 6. MVP (version 1)

Chỉ làm:
1. Registry repo: `servers/`, `profiles/` (1 tầng), `policy/` tối thiểu, JSON Schema, CODEOWNERS.
2. CI registry: schema lint, kiểm tra pin exact, smoke test `initialize` + `tools/list`.
3. Manifest + lockfile + local override.
4. CLI: `init`, `search`, `info`, `add`, `remove`, `sync`, `check`, `doctor`, `exec`.
5. **2 adapter**: hai client mà tổ chức dùng nhiều nhất (đoán: Claude Code + Cursor). IR thiết kế sao cho adapter thứ ba rẻ.
6. Secret: SecretRef + launcher `exec` + 2 provider: `env://` và **một** provider thật của tổ chức.
7. Versioning theo snapshot registry + content hash; breaking change = definition song song.
8. Pilot với 3–5 repo thật (đúng 3 repo trong ví dụ).

Không làm ở MVP: environment overlay, semver từng server, Web UI, API, RBAC, inventory, bot PR, gateway, tool allow/deny, hỗ trợ mọi client.

### 7. Future features

**Phase 2 — Internal Platform**
- Inventory indexer (quét `loadout.lock` toàn org) + dashboard / Backstage plugin read-only.
- Bot PR kiểu Renovate khi server có version mới / bị deprecate.
- Environment overlay (`--env staging`).
- Semver độc lập từng server + changelog.
- Adapter VS Code, Codex, Gemini CLI...
- Capability snapshot → sinh permission allow/deny tool theo client (vd. chặn tool destructive).
- Import/align với `server.json` của official MCP registry.
- Policy engine có cấu trúc (thay vì rule YAML đơn giản).
- Cache secret có TTL trong keychain.

**Phase 3 — Control Plane**
- Gateway cho server remote/được host tập trung, audit từng tool call, kill-switch.
- Credential động, ngắn hạn qua secret broker.
- Telemetry sử dụng (server nào thực sự được dùng).
- API ghi + RBAC map từ IdP.

### 8. Biggest risks (Top 5)

1. **Format client phân mảnh và thay đổi nhanh.** Adapter là phần bảo trì tốn nhất. → IR ổn định, adapter có golden test, theo dõi changelog client, ưu tiên ít target.
2. **Secret: căng thẳng giữa DX và an toàn.** Nếu launcher phiền (prompt liên tục, chậm) dev sẽ quay về `.env`; nếu dễ dãi thì lộ secret cho agent. Cloud agent/CI không có identity của dev. → S3 trước, launcher có cache, document rõ đường cho CI/cloud.
3. **Governance lệch chuẩn.** Hoặc platform thành bottleneck (mọi thứ phải qua họ), hoặc catalog phình thành bãi rác không ai sở hữu. → ownership theo repo cho binding, CODEOWNERS cho server, status lifecycle, giới hạn profile.
4. **Drift giữa các nguồn.** Registry ↔ lockfile ↔ file generated ↔ những gì dev thực sự chạy (server user-scope trong `~/.claude.json`, `~/.cursor/mcp.json` trùng tên và che project-scope). → `check --frozen` trong CI, `status`/`doctor` phát hiện xung đột tên với user-scope.
5. **Scope creep / over-abstraction.** Kéo về gateway, environment hierarchy, templating logic, Web UI ghi dữ liệu trước khi có nhu cầu thật. → giữ nguyên tắc "change path only", mọi tầng mới phải có use case từ pilot.

(Rủi ro ngoài kiến trúc nhưng đáng ghi: **bản thân MCP server là bề mặt tấn công** — prompt injection qua output tool, exfiltration. Catalog được curate tạo cảm giác an toàn giả nếu không có review bảo mật cho server.)

### 9. Final project name

**`mcp-loadout`** — CLI `loadout`.

- Diễn tả đúng giá trị cốt lõi: *mỗi repo có một bộ MCP được chọn riêng* từ một kho trang bị chung — không chỉ là "danh sách server".
- Tránh va chạm với "MCP Registry" / "Catalog" / "Hub" đã có nghĩa trong hệ sinh thái.
- Trung lập vendor, ngắn, đọc thành câu tự nhiên: `loadout add postgres`, `loadout sync`, file `loadout.yaml`.
- Rủi ro: ẩn dụ gaming không phải ai cũng quen; cần kiểm tra trùng tên trên npm/GitHub. Nếu tổ chức ưu tiên tên mô tả thuần tuý hơn tên dễ nhớ, phương án dự phòng là `mcp-catalog`.

---

## 20. Các quyết định cần chốt trước khi implement

| # | Quyết định | Khuyến nghị | Vì sao phải chốt sớm |
|---|---|---|---|
| D1 | Nguồn sự thật của mapping: trong repo hay `repositories/` trung tâm? | Trong repo (manifest) | Quyết định toàn bộ ownership, CLI, GitOps flow |
| D2 | File generated: commit hay gitignore? | Commit + CI chặn drift | Ảnh hưởng cloud agent, onboarding, review |
| D3 | Chiến lược secret: launcher (S2) hay env interpolation (S1)? Provider đầu tiên? | S3 > S2 > S1; provider = cái đang dùng | Quyết định CLI có phải cài ở mọi nơi agent chạy không |
| D4 | Client nào ở MVP? | 2 client dùng nhiều nhất | Quyết định độ phức tạp IR |
| D5 | Versioning: snapshot registry hay semver từng server? | Snapshot cho MVP | Ảnh hưởng format lockfile — khó đổi sau |
| D6 | Format server: tự định nghĩa hay căn chỉnh `server.json` official? | Căn chỉnh phần package/transport | Tránh tự tạo chuẩn riêng |
| D7 | Semantics profile: 1 tầng, chỉ composition? | Có | Ngăn inheritance phức tạp ngay từ đầu |
| D8 | Environment có trong MVP không? | Không (dùng local override) | Tránh Model C |
| D9 | Policy: cảnh báo hay chặn (CI fail)? | Chặn với một số rule cứng (prod, secret literal), cảnh báo phần còn lại | Ảnh hưởng adoption |
| D10 | Phân phối: CLI (npm/brew/binary) và registry data (git clone / tarball theo commit)? | Binary đơn + fetch theo commit | Cloud agent / CI phải cài được |
| D11 | Đã có Backstage / IdP để làm ownership & UI chưa? | Tái sử dụng nếu có | Tránh build Repository Registry/UI thừa |
| D12 | Tỉ lệ server có bản remote (HTTP + OAuth) là bao nhiêu? | Khảo sát trước | Nếu cao, bài toán secret nhỏ đi nhiều |

### Câu hỏi mở cho buổi brainstorm tiếp theo

- MCP cá nhân (dev tự dùng, không gắn repo) có thuộc phạm vi không? Đề xuất: **không** — để ở user-scope của client.
- Monorepo: một repo nhiều service, mỗi service cần MCP khác nhau → manifest ở cấp thư mục con? (Client có hỗ trợ config theo thư mục con không?)
- Cloud agents (agent chạy trong container từ repo clone mới): lấy secret bằng identity nào?
- Ai review bảo mật cho server mới được đưa vào catalog?
