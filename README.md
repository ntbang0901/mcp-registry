# mcp-registry (`loadout`)

Registry trung tâm cho MCP: **định nghĩa MCP server một lần**, **map server → repository** ở một chỗ, rồi tự sinh config cho từng AI client (Claude Code, Cursor) trong mỗi repo.

```text
mcp-registry/                     repo-a/                       repo-b/
├── servers/                      ├── .mcp.json        ◄─┐      ├── .mcp.json        ◄─┐
│   ├── context7.yaml             └── .cursor/mcp.json ◄─┤      └── .cursor/mcp.json ◄─┤
│   ├── linkup.yaml                   (generated, git-ignored)  (generated, git-ignored)
│   └── code-graph.yaml                                  │                             │
└── bindings.yaml  ── loadout sync ──────────────────────┴─────────────────────────────┘
```

Repo không commit gì liên quan tới MCP. Mọi thay đổi (thêm/bớt server, đổi version, đổi key) làm ở registry rồi `loadout sync`.

Thiết kế và lý do: [`docs/architecture-brainstorm.md`](docs/architecture-brainstorm.md).

## Cài đặt

Cần Node.js ≥ 20. Project viết bằng TypeScript; chỉ cần `uvx` nếu bạn dùng server chạy bằng Python (ví dụ code-graph).

```bash
# 1. Cài lệnh `loadout` — bản đã build sẵn từ GitHub Release, không cần clone hay build
npm install -g https://github.com/ntbang0901/mcp-registry/releases/latest/download/mcp-loadout.tgz

# 2. Lấy dữ liệu registry về máy (tự clone vào ~/.local/share/loadout/registry) và cấu hình
loadout init --from https://github.com/ntbang0901/mcp-registry.git --workspace ~/code
```

Dữ liệu registry (`servers/`, `repos/`, `bindings.yaml`) vẫn là một bản git trên máy, vì UI và CLI sửa các file đó và bạn commit/push để chia sẻ. `init --from` chỉ làm hộ bước clone.

Cách khác: `npm install -g github:ntbang0901/mcp-registry` (npm tự clone và build từ nhánh mặc định), hoặc clone rồi `npm install && npm link` khi muốn sửa code của chính công cụ.

`init` ghi `~/.config/loadout/config.yaml`:

```yaml
registry: /home/me/.local/share/loadout/registry
workspaces: [/home/me/code]        # nơi `sync --all` và UI đi tìm repo
targets: [claude-code, cursor]     # client cần sinh config
```

### Phát hành bản mới của công cụ

Không cần clone: trên GitHub vào **Actions → release → Run workflow** (branch `main`). Workflow lấy version trong `package.json`, chạy `npm run ci`, đóng gói, cài thử gói rồi tạo tag `vX.Y.Z` và GitHub Release kèm `mcp-loadout.tgz` và checksum. Muốn ra bản mới thì tăng `version` trong `package.json` (sửa ngay trên web GitHub cũng được), merge vào `main`, rồi bấm lại nút đó.

Cách khác, từ máy có clone: `npm version patch && git push --follow-tags`.

Link `releases/latest/download/mcp-loadout.tgz` luôn trỏ tới bản mới nhất; cài lại bằng đúng lệnh ở bước 1 để cập nhật.

### Nhập một lượt mọi repo đang có config MCP viết tay

```bash
loadout import --all --dry-run   # quét các workspace, liệt kê repo có .mcp.json / .cursor/mcp.json viết tay và việc sẽ làm
loadout import --all --sync      # nhập tất cả rồi thay các file viết tay bằng file sinh ra (giữ bản .bak)
```

Hoặc trên `loadout ui`: mục **MCP configs to import** ở Overview, nút **Import all**.

Khi nhiều repo có server trùng tên:

| Trường hợp | Xử lý |
|---|---|
| Tên chưa có trong registry | Tạo server dùng chung |
| Đã có, nội dung giống hệt | Dùng lại |
| Đã có, khác nội dung, chưa repo nào dùng (ví dụ server mẫu) | Thay bằng định nghĩa của repo |
| Đã có, khác nội dung, repo khác đang dùng | Giữ thành server riêng của repo này, để không repo nào bị đổi cấu hình |

Sau đó có thể gộp các bản riêng giống nhau bằng tham số (`{{ params.x }}`) trên trang server.

### Chuyển một repo đang có config MCP viết tay

```bash
cd ~/code/my-api
loadout import                                  # .mcp.json / .cursor/mcp.json → registry (API key không bị chép)
loadout sync --force                            # thay file viết tay bằng file sinh ra (giữ bản .bak)
git rm --cached .mcp.json .cursor/mcp.json      # nếu trước đây đã commit chúng
git commit -m "Move MCP config to the registry"
export LINKUP_API_KEY=…                         # các biến `import` báo cần export (đặt trong ~/.zshrc hoặc ~/.bashrc)

cd ~/.local/share/loadout/registry && git add -A && git commit -m "Import my-api" && git push
```

Sau đó mở `loadout ui` để quản lý tiếp (nút **Commit** trên UI làm hộ phần commit; push vẫn dùng git). Trên máy khác: chạy lại 2 lệnh cài đặt ở trên, rồi `loadout sync --all`.

## Giao diện web

```bash
loadout ui            # mở http://127.0.0.1:4870/?token=… trên trình duyệt
```

- **Sidebar**: danh sách repository (chấm màu = trạng thái: xanh đã sync, vàng lệch, đỏ cần xử lý, rỗng = chưa clone trên máy) và server; cuối sidebar là thay đổi chưa commit + nút **Commit**, **Sync all repositories**.
- **Overview**: việc cần xử lý (repo lệch, file viết tay, thiếu tham số, lỗi registry), bảng repo × server, repo trên máy chưa có trong registry.
- **Trang repository**: các server đang dùng, tham số của từng server sửa ngay tại chỗ (tham số tuỳ chọn gấp trong *More options*), **+ Add server** (chọn server có sẵn hoặc tạo mới), server riêng của repo, biến môi trường cần export, trạng thái file `.mcp.json` / `.cursor/mcp.json`.
- **Trang server**: định nghĩa, bảng tham số, repo nào đang dùng với giá trị gì; **Edit definition** (YAML, kiểm tra cả registry trước khi lưu), chuyển dùng chung ↔ riêng, xoá.
- **New server** (panel bên phải): dán JSON từ README hoặc điền form, xem trước file YAML; chọn dùng chung hay riêng cho một repo. Server có tham số bắt buộc được thêm vào repo sau khi nhập giá trị trên trang repo đó.

UI chỉ lắng nghe trên `127.0.0.1` và yêu cầu token trong URL (in ra khi chạy lệnh), nên trang web khác không gọi được vào nó.

## Server dùng chung và server riêng của repo

| | Dùng chung | Riêng của một repo |
|---|---|---|
| Lưu ở | `servers/<name>.yaml` | `repos/<host>/<owner>/<name>/<server>.yaml` |
| Gắn vào repo | liệt kê trong `bindings.yaml` (tick trên UI) | tự động — chỉ áp dụng cho repo đó |
| Khi nào dùng | context7, linkup… nhiều repo cùng dùng | script MCP nằm trong repo, DB riêng, server nội bộ của service đó |

Tên server riêng không đụng với repo khác (repo A và repo B đều có thể có `db` riêng). Chuyển qua lại bất cứ lúc nào:

```bash
loadout add db --repo-only -- node scripts/db-mcp.js   # tạo server riêng cho repo hiện tại
loadout import --repo-only                             # nhập config hiện có thành server riêng
loadout share db                                       # riêng → dùng chung (vẫn gắn vào repo này)
loadout unshare code-graph                             # dùng chung nhưng chỉ 1 repo dùng → riêng của repo đó
loadout remove db                                      # xoá server riêng của repo hiện tại
```

Trên UI: chọn **Only for &lt;repo&gt;** khi thêm server; danh sách server có nút **Make shared** / **Make repo-only**; bảng repo có cột **Repo-only**.

## Tham số riêng cho từng repo

Cùng một server nhưng mỗi repo một giá trị (database, Jira project, tenant…): viết `{{ params.<tên> }}` ở chỗ giá trị thay đổi khi thêm server — tool tự khai báo tham số đó (bắt buộc; ở vị trí secret như `PGPASSWORD` thì là tham số `secret`).

```text
Command:  npx -y @acme/pg-mcp@1.0.0 --database {{ params.database }}
Env:      PGPASSWORD={{ params.password }}
```

Rồi nhập giá trị cho từng repo:

- **UI**: tick server trong bảng → form tham số tự mở nếu có tham số bắt buộc; nút **⚙** cạnh ô đã tick để sửa sau (**⚙ !** đỏ = còn thiếu tham số bắt buộc, **⚙ 2** = đã đặt 2 giá trị). Ô trống = dùng giá trị mặc định.
- **CLI**:

  ```bash
  loadout set postgres database=promotion_db password=env://PROMO_DB_PASSWORD   # repo hiện tại
  loadout set postgres --repo github.com/ntbang0901/seller-center database=seller_db
  loadout set postgres                       # xem giá trị hiện tại
  loadout set postgres --unset database      # bỏ, dùng mặc định
  ```

Tham số `secret` chỉ nhận tham chiếu `env://TÊN_BIẾN` — mỗi repo có thể trỏ tới biến khác nhau, giá trị thật vẫn nằm trong shell. Giá trị được kiểm tra trước khi ghi (sai kiểu, thiếu tham số bắt buộc, dán key thật → báo lỗi, không ghi gì).

Muốn thêm tham số cho server đã có: nút **Edit** trên UI mở file YAML của server; khi lưu, toàn bộ registry được kiểm tra lại và thay đổi bị từ chối nếu làm hỏng một repo (ví dụ thêm tham số bắt buộc mà repo đang dùng chưa đặt giá trị).

## Thêm server bằng CLI

```bash
pbpaste | loadout add                                   # JSON copy từ README
loadout add context7 --url https://mcp.context7.com/mcp
loadout add linkup --url https://mcp.linkup.so/mcp --header "Authorization=Bearer sk-..."   # key → ${LINKUP_TOKEN}
loadout add code-graph -- uvx code-graph-mcp==1.2.4 --project-root .
loadout add linkup --url … --attach                     # thêm và gắn luôn vào repo hiện tại
loadout add … --dry-run                                 # chỉ xem file sẽ tạo
loadout remove <name>                                   # xoá server dùng chung không còn repo nào dùng
```

## Dùng hằng ngày

```bash
loadout matrix                         # repo nào dùng server nào
cd ~/code/repo-c
loadout attach linkup context7         # sửa bindings.yaml + sinh config cho repo hiện tại
loadout detach context7
loadout attach code-graph --repo github.com/ntbang0901/repo-a   # sửa repo khác (không sync)
loadout sync                           # sinh lại config cho repo hiện tại
loadout sync --all                     # sinh lại cho mọi repo đã clone trong workspaces
loadout status [--all]                 # config đã cập nhật chưa (exit 1 nếu chưa)
loadout validate                       # kiểm tra registry (chạy trong CI)
```

Sau khi `attach`/`detach`/sửa `servers/*.yaml`: **commit registry** (`git -C ~/code/mcp-registry commit -am "..."`).

`import` **không bao giờ chép giá trị secret** vào registry: API key trong env, header, query (`?apiKey=`) hay argument được thay bằng tham chiếu `env://NAME`, và in ra biến môi trường bạn cần export.

## Định dạng

### `servers/<name>.yaml`

```yaml
name: linkup
description: Web search via Linkup
transport:
  type: http                       # hoặc stdio
  url: https://mcp.linkup.so/mcp
  headers:
    Authorization: "Bearer {{ params.apiKey }}"
params:
  apiKey:
    type: secret                   # string | number | boolean | secret
    default: env://LINKUP_API_KEY
```

```yaml
name: code-graph
transport:
  type: stdio
  package: { registry: pypi, name: code-graph-mcp, version: 1.2.4 }   # npm → npx, pypi → uvx; version phải pin chính xác
  args: ["--project-root", "{{ repo.root }}"]
```

Template chỉ có hai loại biến, không có logic:

- `{{ params.<name> }}` — tham số khai báo trong `params`.
- `{{ repo.root | id | host | slug | owner | name }}` — suy ra từ repo đang sync.

Tham số `secret` chỉ nhận tham chiếu `env://NAME` (v0.1); file sinh ra dùng cú pháp của từng client (`${NAME}` cho Claude Code, `${env:NAME}` cho Cursor), nên giá trị thật không bao giờ nằm trên đĩa. Một entry (header/env/arg) tham chiếu tham số tuỳ chọn chưa set sẽ bị bỏ đi.

`validate` chặn: schema sai, version không pin, giá trị trông như secret viết thẳng (header `Authorization`, env `*_TOKEN`, query `apiKey`…), tham số không khai báo, server không tồn tại.

### `bindings.yaml`

```yaml
repositories:
  github.com/ntbang0901/repo-a: [context7, linkup]
  github.com/ntbang0901/repo-b:                     # dạng map khi cần tham số riêng
    code-graph:
    context7: { params: { apiKey: env://CONTEXT7_API_KEY } }
```

Key là `host/owner/name`; dán thẳng git URL (`git@github.com:x/y.git`) cũng được. Repo được nhận diện qua `git remote origin`.

## Cách `sync` ghi file

- Chỉ ghi đè file do chính `loadout` sinh ra (theo dõi bằng hash trong `~/.local/state/loadout/state.json`). File viết tay hoặc bị sửa tay → bỏ qua, cần `--force` (giữ `.bak`).
- File sinh ra được ignore qua `.git/info/exclude`, nên không phải sửa `.gitignore` của repo.
- Repo không còn server nào → xoá file đã sinh.
- Cảnh báo nếu biến môi trường secret chưa được set trong shell hiện tại.

## Phát triển

```bash
npm install
npx playwright install chromium   # một lần, cho test giao diện
npm run ci                        # chạy toàn bộ: lint, format, typecheck, unit test, build, validate, smoke CLI, test UI
```

CI trên GitHub chạy đúng lệnh `npm run ci` này trong một job. Release (`git push --follow-tags` sau `npm version …`) chạy lại `npm run ci`, đóng gói, cài thử chính file `.tgz` đó rồi mới tạo GitHub Release kèm checksum.
