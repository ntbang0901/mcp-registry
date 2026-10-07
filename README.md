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

Yêu cầu Node.js ≥ 20 (và `uvx` nếu dùng server Python như code-graph).

```bash
git clone https://github.com/ntbang0901/mcp-registry ~/code/mcp-registry
cd ~/code/mcp-registry && npm install && npm run build && npm link   # cài lệnh `loadout`

loadout init --registry ~/code/mcp-registry --workspace ~/code
```

`init` ghi `~/.config/loadout/config.yaml`:

```yaml
registry: /home/me/code/mcp-registry
workspaces: [/home/me/code]        # nơi `sync --all` đi tìm repo
targets: [claude-code, cursor]     # client cần sinh config
```

## Giao diện web

```bash
loadout ui            # mở http://127.0.0.1:4870/?token=… trên trình duyệt
```

- **Add MCP server**: dán JSON copy từ README của MCP server (`{"mcpServers": …}`, dạng VS Code `{"servers": …}`, hoặc một entry), hoặc điền form (URL remote / lệnh local + header/env). Có preview file YAML sẽ tạo; API key tự được tách thành biến môi trường, không bao giờ lưu giá trị.
- **Repositories**: bảng repo × server, tick để gắn/bỏ — clone local được sync lại ngay. Repo local chưa có trong registry hiện ra để thêm bằng 1 click.
- **Servers**: danh sách server, biến môi trường cần export, số repo đang dùng; xoá server không còn ai dùng.
- **Commit**: banner báo thay đổi chưa commit trong registry, commit ngay trên UI (push vẫn làm bằng git).

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

### Chuyển repo đang có config viết tay

```bash
cd ~/code/repo-a
loadout import            # đọc .mcp.json / .cursor/mcp.json → servers/*.yaml + bindings.yaml
loadout sync --force      # thay file viết tay bằng file sinh ra (giữ bản .bak)
git rm --cached .mcp.json .cursor/mcp.json   # nếu trước đây đã commit chúng
```

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
npm run typecheck && npm test && npm run build && npm run validate
```
