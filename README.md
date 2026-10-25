# PS 優惠探索

整理台灣 PlayStation Store 優惠活動，支援任意數量活動、搜尋、平台篩選、排序、分頁及本機追蹤／忽略清單。這是個人工具，非 PlayStation 官方網站。已接入 EDF 的共用 Google 登入模組，先供正式站授權測試；雲端同步尚未啟用，個人標記只存在瀏覽器，不進 Git。

## 我的清單

頁面上方切換「我的清單」，可管理所有已追蹤／忽略的商品，與目前有哪些活動分開。可搜尋、篩選平台、切換追蹤／忽略，以及更改或取消標記；直接開啟網址的 `#my-list` 會回到這個檢視。

有進行中活動收錄時，顯示該活動快照中的價格與「活動收錄中」。沒有進行中活動收錄時，只保留名稱、封面、平台、商店連結及標記按鈕，不顯示舊價格或額外狀態文字。活動到期、封存或同活動 refetch 移除商品，都不會讓個人清單中的標記消失；不增加多版本快照。

商品基本資料只存本機 IndexedDB 的獨立 product-info 記錄，與標記交易一同保存，不保存價格。舊版標記在商品仍有來源資料時會自動補上基本資訊。若匯入的標記從未在此瀏覽器收錄過，且當前資料也找不到商品，先以商品 ID 與官方連結顯示，仍可修改或取消標記。

既有個人 JSON／雲端資料格式不變；基本資料快取不隨個人標記備份跨瀏覽器移轉。快取維護不更動標記 revision、Tombstone、Base、Outbox 或匯入前復原備份。個人資料與基本資料快取不加入 Git，也不會因這個功能發出額外商品抓取或 Google 請求。

## 新增活動：用 GitHub Actions 填表

進入 [Manage one sale campaign](https://github.com/promise82114/ps-store-sale/actions/workflows/manage-campaign.yml)，選 **Run workflow**、分支 **main**：

| 欄位 | 新增時填寫 |
| --- | --- |
| operation | `add` |
| campaign_id | 新活動 Category UUID，或完整的台灣活動第一頁網址 |
| name | 活動名稱 |
| starts_at | 開始時間，例如 `2026-10-25 00:00` |
| ends_at | 停止顯示的時刻，例如 `2026-10-28 00:00` |

時間一律為台灣時間，格式 `YYYY-MM-DD HH:mm`；開始包含該時刻，結束不包含該時刻。例如上述表示 10/25 起至 10/27 當天結束。必須提供正確起訖，程式不猜測官方期間。每次活動即使只有三天，也獨立登錄。中途新增活動同樣執行 `add`。

新增只擷取這個 ID，完整驗證成功後，將設定及完整商品快照保存回 Repo，接著直接建置、發布 GitHub Pages。已存在的 ID 不能重複新增；既有活動不重抓。每次等待此次 Run 完成後再送下一次操作。

## 修改、封存與重抓

同一表單的 operation：

| 操作 | 欄位及效果 | PS Store 請求 |
| --- | --- | --- |
| `edit` | ID 必填；名稱／起訖可選，空白保持原值。至少改一欄 | 0 |
| `archive` | 只填 ID，從進行中清單隱藏，保存快照 | 0 |
| `restore` | 只填 ID，恢復啟用；仍依期間判斷是否進行中 | 0 |
| `refetch` | 只填 ID，明確要求重新擷取該活動，替換該份完整快照 | 只抓指定 ID |

其他操作不填名稱及時間。舊活動尚無起訖時，第一次補登需同時填開始與結束時間。修改頁面、樣式或部署不會擷取活動。沒有六小時排程或其他定期抓取。

網站預設顯示進行中活動；已結束、尚未開始、封存的活動可切換「所有活動（含歷史）」查看。0／1／多個活動都支援，單活動不顯示多餘分頁。頁面每 30 秒只檢查本機時鐘，讓到期活動退出進行中清單，不發送資料更新請求。個人標記不因活動退出而刪除。歷史價格只代表各次擷取結果，實際條件以官方商店為準。

活動自然到期時不會執行抓取、commit 或刪除快照；只是瀏覽器依期間切換顯示。要提前隱藏用 archive；restore 不會改變原結束時間，已過期活動若確實延期，另外用 edit 修正期間。新一檔活動使用新 ID 執行 add。

## 資料保存與發布

- `data/campaigns.json`：活動 ID、名稱、起訖、啟用狀態。
- `data/campaign-snapshots/<ID>.json`：各活動獨立的完整商品快照；只含公開商品資料，不含個人標記。
- `data/catalog.json`：用已存快照產生的合併索引，保留各活動個別報價和擷取時間。
- `data/refresh-status.json`：已保存資料的驗證結果；重建時間與商品擷取時間分開記錄。
- `web/`：頁面；`src/`：抓取、活動及本機資料模組；`tools/`：固定白名單靜態建置。

兩份 workflow 各自負責：

1. **Manage one sale campaign**（僅手動）：離線回歸 → 操作指定活動 → 驗證建置 → Bot 只 commit／push 活動資料 → 同次 Run 部署。需要 `contents: write` 保存資料；只有部署 job 需要 Pages 權限。若 main 在操作途中改變，停止、不強推，請從最新 main 重試。抓取／驗證／保存失敗時不部署，網站保留上次成功版本。
2. **Publish saved sales to GitHub Pages**（main push 或手動）：離線回歸 → 使用已保存的資料建置 → 部署。**不呼叫活動抓取程式**，修改頁面可直接發布。

共用部署併發鎖，避免同時發布。管理流程在同次 Run 完成部署，因 [GitHub 的 GITHUB_TOKEN push 不會觸發另一個 push workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。不需要 PAT 或新增 Secrets。Repo 的 Pages Source 使用 **GitHub Actions**。

每個新活動仍做完整分頁、首尾重驗及有界重試；請求至少間隔 750ms。遇封鎖、認證或結構異常停止，保留既有完整資料，不使用登入憑證繞過。診斷 Artifact 保留 7 天；正式快照保存在 Git，不依賴 Artifact 保存期限。

活動清單由使用者透過 Actions 新增／更新。早期三份缺正式名稱與期間的暫填資料曾清空，原資料仍可從 99ff16b 還原；目前已由使用者重新登錄正式活動，新增不會重抓其他活動。

## Google 登入測試

正式上線後，以一般 Chrome／Edge 開啟本站，按右上角「Google 登入」：

1. 按「啟用 Google 登入」載入官方 GIS。
2. 服務就緒後，再按「Google 登入」，在 Google 視窗選擇帳號並授權。
3. 本站顯示「Google 授權成功」即表示本次 Token Flow 通過；可按「中斷連接」，或等授權到期。重新整理後須重新連接。

沿用 `edfwb2-checklist/dist/shared/google-auth.js` 原樣副本（EDF 兩個專案一致），以及 EDF／PS Game Base 的同一公開 Web Client ID，設定在 `web/cloud-config.js`。只請求既有 `drive.appdata` scope。這是授權測試入口，尚未進行帳號識別、讀取 Drive、上傳、同步或跨帳號資料搬移；登入不改動現有本機工作區。

開頁及開面板不聯絡 Google，按啟用才載入 GIS；按登入才開彈窗，保留點擊手勢。Token 只留在共用模組私有記憶體，不放入 localStorage／IDB／JSON／日誌；中斷、到期或離頁即清除。本專案在取消後丟棄舊 Auth instance，遲到回呼不能恢復舊連接。中斷不撤銷整個共用 Client 的權限，不影響其他專案。

按 [Google 的來源設定方式](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid)，正式 origin 是 `https://promise82114.github.io`，不包含 `/ps-store-sale/`。與 EDF／PS Game Base 同 origin；若共用 Client 已核准此來源，通常可沿用。這次未讀取或修改 Cloud Console，實際授權仍待使用者上線測試；遇 origin／測試使用者限制時依 Google 畫面核對，無須提供 Token 或 Client Secret。

已依 [Google GIS 設定說明](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid) 在 HTML 與本機預覽開放固定 GIS script／frame／connect／style 路徑，使用 `strict-origin-when-cross-origin` Referrer Policy；未開放任意腳本來源。先前內建瀏覽器的彈窗失敗不作為正式站驗收結果。

## 本機開發

需要 Node.js >=20.18 與 npm：

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
npm run preview
```

預覽 [本機網站](http://127.0.0.1:4186/ps-store-sale/)，使用與 Pages 相同的 Repo 子路徑。test、build 及 preview 不連 PS Store。build 核對 registry、每份快照及合併索引一致，只輸出固定公開白名單至可重建的 artifacts/site/。artifacts/、.local/、node_modules/ 不提交；data/ 是必須追蹤的正式資料。

直接修改活動設定檔時，可執行 `npm run build:catalog` 從既有快照重建合併索引，再建置；它不連外。一般使用 Actions 表單即可。

個人資料採 locale:ProductID，清除標記保留 Tombstone。正式 IDB 為 ps-store-sale-filter-v1。備份匯入會預覽、保留兩端獨有資料、要求選擇衝突，並在同一筆交易保存匯入前復原備份；不覆蓋其他 origin 的個人資料。

正式網址為 [PS 優惠探索](https://promise82114.github.io/ps-store-sale/)。已獲使用者授權提交並推送正式版；部署結果以 [Pages Actions](https://github.com/promise82114/ps-store-sale/actions/workflows/publish.yml) 為準。Google 真實帳號授權由使用者上線後測試，詳見 [交接紀錄](docs/HANDOFF.md)。
