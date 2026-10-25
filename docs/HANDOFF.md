# 正式頁面交接

日期：2026-10-25（Asia/Taipei），目標 G:\git\ps-store-sale，Repo promise82114/ps-store-sale，main 基準 HEAD 3a2eb0b。POC 歷史及既有使用者資料保留。

## 2026-10-25 首次正式發布

使用者已明確授權 commit、push 及 GitHub Pages 正式發布。此次提交包含正式商品頁、手動活動管理／快照保存、共用 Google 登入及回歸測試；沿用 main，不提交 POC 的私人工作目錄、個人備份或暫存授權。

- 發布前已通過完整 Node 170 項測試及靜態建置，版本 d75278db2b32d8f5，使用三份已保存活動快照，共 2243 個唯一商品。
- 推送觸發 publish.yml，只讀既有快照，不重新抓取活動。部署狀態查看 https://github.com/promise82114/ps-store-sale/actions/workflows/publish.yml ，正式網址 https://promise82114.github.io/ps-store-sale/ 。
- 正式網站的頁面／登入入口會另行驗證，Git push 成功與 Pages 部署成功分別確認；真實 Google 帳號選擇及授權由使用者上線後測試，尚不宣稱通過。
- Google 授權入口不讀寫 Drive、不改個人本機工作區。現有三檔名稱及期間仍可用 Actions edit 補登。

以下為移植與本機驗證期間的紀錄，其中「未 commit／push」是該階段狀態；本次已取得正式發布授權。

## 2026-10-25 Google 共用登入接入

使用者要求試著套用其他專案共用 Google 登入模組，正式上線後由使用者實測。此決策覆寫先前「登入暫緩」部分；雲端同步仍未啟用。

- 原樣複製 EDFWB2 `dist/shared/google-auth.js`；EDF 兩份副本 SHA256 同為 D0F017BE23E3D763DC12143F5B2E33897866AE11CFC08958DA23779E9E61AC98。PS Game Base 使用較早版本的同一 API；本次採 EDF 已含有效期限資訊的版本，未修改任何來源 Repo。
- `web/cloud-config.js` 沿用使用者先前指定的共用公開 Client ID，獨立 projectId ps-store-sale、預留檔名 ps-store-sale-filter.json；沒有 Client Secret。正式站右上角面板先啟用 GIS，再以第二次按鈕點擊開啟選帳號，保留手勢。
- `src/google-login.mjs` 包裝原模組的世代、取消、遲到回呼、到期及固定錯誤訊息。Token 不向 UI 暴露，不寫入任何持久儲存；中斷及重試使用獨立 Auth instance，防止舊回呼污染新連接。
- 只測授權，不識別帳號、不讀寫 Drive、不綁定／轉移本機 IDB、不改標記或既有備份。現有 3 活動保存／Actions 管理與頁面發布流程不變。
- HTML／預覽一致允許固定 Google GIS CSP 路徑及適用 Referrer Policy，靜態白名單增加設定、共用模組及 wrapper，三者皆加快取版本。不引入新套件。
- 合成回歸使用真正的共用模組搭配 VM 模擬 GIS：開頁零呼叫、載入時機、同步手勢、授權成功／拒絕／缺 scope、取消載入、彈窗失敗重試、取消後舊回呼、到期、多次點擊、零 API 讀寫及零儲存。全套 170 項通過；不是 Google 真實帳號驗收。
- 原生瀏覽器以獨立 testRun 工作區驗證開啟面板、實際官方 GIS 載入並顯示就緒、中斷回初始態、Escape 關閉及桌面／390px 面板。未點第二次 Google 登入、未開帳號授權視窗。畫面證據在 POC artifacts/google-login；建置成功輸出 17 個白名單公開檔案。
- Google 真實授權與正式 Pages 待使用者上線後測試；未執行真實登入、Drive 呼叫、Cloud Console 設定變更或遠端發布。本機未 commit／push。

以下保留上一階段活動管理的交接結果；其中「無 Google OAuth」是當時狀態，以本節為準。

## 本次需求與實作

使用者指定 GitHub Actions 作為活動管理面板，手動新增 ID、名稱、期間；新增只抓新活動一次並永久保存，頁面修改不能重抓所有活動。已將固定三活動批次更新改為：

- manage-campaign.yml 手動輸入 add／edit／archive／restore／refetch。add 必填 ID、名稱及台灣起訖；其他編輯不發送 PS Store 請求，只有 refetch 允許明確重抓指定活動。
- data/campaigns.json + 每活動 campaign-snapshots/<ID>.json 是資料來源。新資料先完整驗證，再保存設定、該份快照與衍生索引；其他快照不改寫。
- Actions 管理 Run 只 Bot commit／push 資料，接著同次 Run 部署，避免 GITHUB_TOKEN push 不觸發第二個 workflow。main 途中有新 commit 時停止，不 force push。
- publish.yml 的 main push／手動發布只跑離線回歸、使用已保存資料建置並部署。無 schedule；移除原固定三活動全抓入口。
- 頁面顯示任意活動數、單活動簡化導覽、台灣期間及歷史範圍；本機時間每 30 秒判斷到期，不抓資料。活動退出清單不刪個人標記，保留既有備份預覽、衝突與復原流程。
- 沒有 Google OAuth、雲端同步、PAT 或新的 Secrets。只有管理 job 需要 contents write 保存資料；部署 job 使用 Pages 權限。

既有三份真實快照由前次成功擷取的公開來源轉存，這次沒有重新抓取：2026-10-25 台灣時間 15:10～15:13，2243／717／1730 筆，4690 筆活動收錄、2243 個唯一商品。名稱仍為「優惠專頁 1～3」，起訖為 null，頁面明示待補登；不猜官方期間。可在 Actions edit 時一起填入兩個時間。

## 驗證與限制

- Node 24.19.0、npm 10.8.2，唯一套件 graphql 15.10.3 不變；Node 離線回歸 158 項通過，未包含真實 Google 驗收。
- 管理流程以合成完整來源注入驗證：只呼叫新 ID 一次、重複新增拒絕、編輯／封存／恢復不抓取、顯式 refetch 只改一份快照、抓取或驗證失敗不改既有資料、台灣時間／邊界及零／單／多活動、歷史報價隔離。
- 靜態建置核對已保存 registry／快照與合併索引一致，使用 Repo 子路徑及模組版本；不公開管理設定、診斷或個人資料。
- 兩份 Workflow 已用獨立 YAML 解析器核對事件、權限、保存後部署、共用併發鎖及 publish 不執行抓取；一般發布 checkout 最新 main，避免排隊後回退到較舊資料。
- 實際瀏覽器驗證三活動篩選（717 筆）、歷史切換、單活動日期與隱藏導覽、零活動及直接查看已保存活動入口；桌面與 390px 手機版皆可操作。0／1 活動情境僅修改可重建預覽產物，正式快照未改。證據在 POC artifacts/manual-campaign。
- 先前唯讀 Pages API 已確認 Source 為 workflow，正式 URL https://promise82114.github.io/ps-store-sale/。本次未修改遠端設定，未執行新版遠端 Actions；仍須首次遠端 Run 才能驗證平台權限與部署。

## 交付狀態

本機變更可檢查，**未 commit／push**。G:\git\AGENTS.md 要求使用者明確授權後才提交／推送；本次不自行執行。新版 workflow 推上 main 後，Actions 表單才會出現。

操作方式見 README。首次上線先使用保存資料發布，再用 edit 補既有三活動名稱與期間；新一檔用 add。每次等待 Run 完成再送下一次；失敗不部署，保留線上前一版。若 GitHub environment 有人工核准或 branch protection，沿用既有規則，不繞過。

資料原始來源及本機驗證產物在忽略的 artifacts／POC .local 目錄，Git 僅保存公開正式快照及程式。Google 同步依使用者決定暫緩。
