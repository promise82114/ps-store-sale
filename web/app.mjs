import { selectProducts, validateCatalog, catalogForDisplay, buildCatalog } from './src/catalog.mjs';
import { campaignState } from './src/campaigns.mjs';
import { GoogleLogin } from './src/google-login.mjs';
import { personalProducts, rememberProductInfo } from './src/personal-list.mjs';
import { openPersonalStore } from './src/poc04/indexeddb-store.mjs';
import { exportBackup, importBackup, limits } from './src/poc04/personal-data.mjs';
import { planLocalBackup } from './src/poc04/sync-state.mjs';

const $ = selector => document.querySelector(selector), pageSize = 60;
const view = { search: '', campaign: '', platform: '', status: '', sort: 'name', page: 1 };
const testRun = new URLSearchParams(location.search).get('testRun');
const databaseName = /^[a-zA-Z0-9_-]{1,60}$/.test(testRun ?? '')
  ? `ps-store-sale-filter-test-${testRun}` : 'ps-store-sale-filter-v1';
let savedCatalog, catalog, store, local, channel, pendingImport, lifecycleSignature;
let listMode = location.hash === '#my-list' ? 'personal' : 'sales', productInfos = {};
let catalogUnavailable = false, metadataUnavailable = false;
const format = number => number.toLocaleString('zh-TW');
const googleLogin = new GoogleLogin({ Auth: globalThis.SideProjectAuth?.GoogleAuth,
  clientId: globalThis.SIDE_PROJECT_CLOUD_CONFIG?.clientId, onChange: renderGoogle });
function renderGoogle(state = googleLogin.state) {
  const busy = ['preparing', 'authorizing'].includes(state.phase), connected = state.connected;
  const errors = { load: 'Google 服務載入失敗，請確認網路後重試。', config: 'Google 登入設定未就緒。',
    denied: 'Google 授權未完成，請重試並確認授權畫面。', scope: '尚未授予共用模組需要的 Drive 應用程式資料權限。',
    popup: '登入視窗被阻擋或已關閉，請允許彈出視窗，並使用一般瀏覽器重試。',
    cancelled: '已取消連接。', expired: 'Google 授權已到期，請重新登入。', auth: 'Google 授權未完成或逾時，請重新啟用登入。' };
  const messages = { idle: '尚未連接 Google。先啟用登入服務，再按登入選擇帳號。', preparing: '正在載入 Google 登入服務…',
    ready: 'Google 服務已就緒，請按「Google 登入」選擇帳號。', authorizing: '請在 Google 視窗完成登入與授權。',
    connected: 'Google 授權成功。目前尚未讀取或上傳雲端資料。', expired: 'Google 授權已到期，請重新啟用登入。', error: errors[state.error] ?? errors.auth };
  $('#google-open').textContent = connected ? 'Google 已連接' : 'Google 登入';
  $('#google-status').textContent = messages[state.phase];
  if (connected && state.expiresAt) $('#google-status').textContent += ` 授權有效至 ${new Date(state.expiresAt).toLocaleTimeString('zh-TW')}。`;
  $('#google-connect').disabled = busy || connected;
  $('#google-connect').textContent = connected ? '已連接' : busy ? '處理中…' : state.ready ? 'Google 登入' : '啟用 Google 登入';
  $('#google-disconnect').hidden = !busy && !connected && !state.ready;
  $('#google-disconnect').textContent = busy ? '取消連接' : '中斷連接';
}
$('#google-open').addEventListener('click', () => { renderGoogle(); $('#google-dialog').showModal(); });
$('#google-connect').addEventListener('click', () => {
  if (googleLogin.state.ready) void googleLogin.connect(); else void googleLogin.prepare();
});
$('#google-disconnect').addEventListener('click', () => googleLogin.disconnect());
$('#google-close').addEventListener('click', () => $('#google-dialog').close());
$('#google-dialog').addEventListener('close', () => {
  if (['preparing', 'authorizing'].includes(googleLogin.state.phase)) googleLogin.disconnect();
});
window.addEventListener('pageshow', () => renderGoogle());
function notice(text, error = false) {
  $('#notice').textContent = text; $('#notice').classList.toggle('error', error);
  $('#notice').hidden = listMode === 'personal' && !error;
}
function safeUrl(value, image = false) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password
    && (image ? ['image.api.playstation.com', 'gmedia.playstation.com'].includes(url.hostname)
      : url.hostname === 'store.playstation.com' && /^\/[a-z]{2,3}(?:-[a-z0-9]{2,8})+\/product\/[A-Z0-9][A-Z0-9_-]*$/.test(url.pathname)) ? url.href : null; }
  catch { return null; }
}
function renderCampaigns() {
  $('#campaigns').hidden = listMode === 'personal' || catalog.campaigns.length <= 1;
  const list = [{ id: '', label: '全部活動', totalCount: catalog.uniqueProductCount }, ...catalog.campaigns];
  $('#campaigns').replaceChildren(...list.map(campaign => {
    const button = document.createElement('button'); button.type = 'button';
    button.setAttribute('aria-pressed', String(view.campaign === campaign.id));
    const title = document.createElement('strong'), count = document.createElement('span');
    title.textContent = campaign.label; count.textContent = `${format(campaign.totalCount)} 個商品`;
    const period = document.createElement('span');
    period.textContent = campaign.id ? `${stateLabel(campaign)} · ${periodLabel(campaign)}` : '合併重複商品，保留各版本';
    button.append(title, count, period); button.addEventListener('click', () => {
      view.campaign = campaign.id; view.page = 1; renderCampaigns(); render();
    }); return button;
  }));
}
function stateLabel(campaign) {
  return { active: '進行中', upcoming: '尚未開始', ended: '已結束', archived: '已封存' }[campaignState(campaign)];
}
function periodLabel(campaign) {
  if (!campaign.startsAt || !campaign.endsAt) return '期間待補登';
  const formatTime = value => new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${formatTime(campaign.startsAt)} ～ ${formatTime(campaign.endsAt)}（台灣）`;
}
function lifecycle() { return savedCatalog.campaigns.map(campaign => `${campaign.id}:${campaignState(campaign)}`).join('|'); }
async function rememberVisibleProducts() {
  metadataUnavailable = false;
  try { productInfos = await store.rememberProducts(savedCatalog.products); }
  catch {
    metadataUnavailable = true;
    try { productInfos = await store.readProductInfo(); } catch { productInfos = {}; }
  }
}
function refreshDisplay() {
  if (!savedCatalog) return;
  catalog = catalogForDisplay(savedCatalog, { includeHistory: $('#campaign-scope').value === 'all' });
  lifecycleSignature = lifecycle();
  if (view.campaign && !catalog.campaigns.some(campaign => campaign.id === view.campaign)) view.campaign = '';
  const count = catalog.campaigns.length;
  const personal = listMode === 'personal';
  $('#activity-heading').textContent = personal ? '我的清單' : count === 1 ? catalog.campaigns[0].label : count > 1 ? `${count} 個活動，一次看完。` : savedCatalog.campaigns.length ? '目前沒有進行中的活動' : '尚未新增優惠活動';
  $('#activity-period').hidden = personal; $('.intro .eyebrow').hidden = personal;
  $('#campaign-scope').closest('label').hidden = personal;
  $('[data-status="unclassified"]').hidden = personal;
  $('#sales-view').setAttribute('aria-pressed', String(!personal));
  $('#personal-view').setAttribute('aria-pressed', String(personal));
  $('#activity-period').textContent = count === 1 ? periodLabel(catalog.campaigns[0]) : '活動期間各自獨立，跨活動整理你想追蹤的優惠。';
  if (catalogUnavailable) notice('優惠資料暫時無法載入，仍可使用我的清單。', true);
  else if (metadataUnavailable) notice('商品基本資料暫時無法更新，個人標記仍保留。', true);
  else if (store) notice(!savedCatalog.campaigns.length ? '尚未新增活動，完成新增後即可在這裡瀏覽優惠。' : $('#campaign-scope').value === 'all' ? '目前包含尚未開始、已結束與封存活動；價格為各次擷取的歷史資訊。'
    : count ? `${count} 個活動已載入；活動結束會自動從進行中清單退出，不重新抓取。` : '可切換「所有活動」檢視已保存的活動快照。');
  renderCampaigns(); render();
}
function render() {
  if (!catalog) return;
  const marks = local?.document.data.marks ?? {}, personal = listMode === 'personal';
  const products = personal ? personalProducts(savedCatalog, marks, productInfos) : catalog.products;
  const selected = selectProducts({ ...catalog, products }, marks, view);
  const pages = Math.max(1, Math.ceil(selected.length / pageSize)); view.page = Math.min(view.page, pages);
  $('#total').textContent = format(products.length);
  $('#personal-count').textContent = format(Object.values(marks).filter(mark => ['tracked', 'ignored'].includes(mark.status)).length);
  $('#result-count').textContent = `${format(selected.length)} 個結果`;
  $('#tracked-count').textContent = format(products.filter(product => marks[product.key]?.status === 'tracked').length);
  $('#ignored-count').textContent = format(products.filter(product => marks[product.key]?.status === 'ignored').length);
  document.querySelectorAll('[data-status]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.status === view.status)));
  $('#empty').hidden = selected.length > 0;
  const noActivity = catalog.campaigns.length === 0, hasHistory = savedCatalog.campaigns.length > 0;
  $('#empty-title').textContent = personal ? products.length ? '沒有符合條件的商品' : '尚無已處理的商品' : noActivity ? hasHistory ? '目前沒有進行中的活動' : '尚未新增優惠活動' : '沒有符合條件的商品';
  $('#empty-description').textContent = personal ? products.length ? '試試其他關鍵字，或重設篩選條件。' : '追蹤或忽略的商品會顯示在這裡。' : noActivity ? hasHistory ? '已保存的活動仍可從歷史清單查看。' : '新增活動後，商品會顯示在這裡。' : '試試其他關鍵字，或重設篩選條件。';
  $('#reset').textContent = !personal && noActivity && hasHistory ? '查看已保存活動' : '重設篩選';
  $('#reset').hidden = personal ? products.length === 0 : noActivity && !hasHistory;
  const cards = selected.slice((view.page - 1) * pageSize, view.page * pageSize).map(product => {
    const card = $('#product-card').content.firstElementChild.cloneNode(true), url = safeUrl(product.url), image = safeUrl(product.imageUrl, true);
    card.querySelector('.cover-link').setAttribute('aria-label', `檢視 ${product.name}`);
    for (const link of card.querySelectorAll('a')) {
      if (url) link.href = url; else { link.removeAttribute('target'); link.setAttribute('aria-disabled', 'true'); }
    }
    if (image) card.querySelector('img').src = image;
    card.querySelector('.cover-link').hidden = personal && !image;
    card.querySelector('img').addEventListener('error', event => event.target.removeAttribute('src'), { once: true });
    card.querySelector('h2 a').textContent = product.name; card.querySelector('h2 a').title = product.name;
    card.querySelector('.platforms').textContent = product.platforms?.join(' · ') || '平台資訊未提供';
    card.querySelector('.platforms').hidden = personal && !product.platforms?.length;
    const price = product.price;
    card.querySelector('.price').hidden = personal && (!product.offers.length || !(price?.discountedPrice || price?.basePrice));
    card.querySelector('.price strong').textContent = price?.discountedPrice ?? price?.basePrice ?? '價格未提供';
    card.querySelector('.price del').textContent = price?.basePrice !== price?.discountedPrice && price?.discountedPrice ? price.basePrice ?? '' : '';
    card.querySelector('.discount').textContent = price?.discountText ?? '';
    const prices = new Set(product.offers.map(offer => JSON.stringify(offer.price)));
    card.querySelector('.membership').textContent = personal ? product.offers.length ? '活動收錄中' : '' : prices.size > 1 ? '活動價格資訊有差異，請查看商店' : product.campaignIds.length > 1 ? `${product.campaignIds.length} 個活動均有收錄` : catalog.campaigns.find(campaign => campaign.id === product.campaignIds[0]).label;
    card.querySelector('.membership').hidden = personal && !product.offers.length;
    for (const [selector, status, activeLabel, inactiveLabel] of [['.track', 'tracked', '★ 已追蹤', '☆ 追蹤'], ['.ignore', 'ignored', '已忽略', '忽略']]) {
      const button = card.querySelector(selector), active = marks[product.key]?.status === status;
      button.textContent = active ? activeLabel : inactiveLabel;
      button.setAttribute('aria-pressed', String(active)); button.disabled = !store;
      button.setAttribute('aria-label', `${active ? '取消' : ''}${status === 'tracked' ? '追蹤' : '忽略'} ${product.name}`);
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const current = await store.read(), selectedStatus = current.document.data.marks[product.key]?.status === status ? 'unclassified' : status;
          local = await store.classifyProduct(product, selectedStatus, { changeId: crypto.randomUUID(), updatedAt: Date.now() });
          productInfos = rememberProductInfo(productInfos, [product], local.document.data.marks);
          channel?.postMessage('changed'); render();
        } catch { notice('標記儲存失敗，先前資料仍保留；請匯出備份後檢查瀏覽器儲存空間。', true); button.disabled = false; }
      });
    }
    return card;
  });
  $('#products').replaceChildren(...cards);
  const previous = document.createElement('button'), next = document.createElement('button'), label = document.createElement('span');
  previous.textContent = '← 上一頁'; next.textContent = '下一頁 →'; label.textContent = `${view.page} / ${pages}`;
  previous.disabled = view.page === 1; next.disabled = view.page === pages;
  previous.addEventListener('click', () => { view.page--; render(); $('.workspace').scrollIntoView({ block: 'start' }); });
  next.addEventListener('click', () => { view.page++; render(); $('.workspace').scrollIntoView({ block: 'start' }); });
  $('#pagination').replaceChildren(previous, label, next);
}
for (const id of ['search', 'platform', 'sort']) $(`#${id}`).addEventListener(id === 'search' ? 'input' : 'change', event => {
  view[id] = event.target.value; view.page = 1; render();
});
document.querySelectorAll('[data-status]').forEach(button => button.addEventListener('click', () => {
  view.status = button.dataset.status; view.page = 1; render();
}));
$('#reset').addEventListener('click', () => {
  Object.assign(view, { search: '', campaign: '', platform: '', status: '', sort: 'name', page: 1 });
  for (const id of ['search', 'platform', 'sort']) $(`#${id}`).value = view[id];
  if (listMode !== 'personal' && catalog.campaigns.length === 0 && savedCatalog.campaigns.length) {
    $('#campaign-scope').value = 'all'; refreshDisplay();
  } else { renderCampaigns(); render(); }
});
$('#campaign-scope').addEventListener('change', () => { view.campaign = ''; view.page = 1; refreshDisplay(); });
for (const [id, mode] of [['sales-view', 'sales'], ['personal-view', 'personal']]) $('#'+id).addEventListener('click', () => {
  listMode = mode;
  Object.assign(view, { search: '', campaign: '', platform: '', status: '', sort: 'name', page: 1 });
  for (const name of ['search', 'platform', 'sort']) $('#'+name).value = view[name];
  history.replaceState(null, '', location.pathname + location.search + (mode === 'personal' ? '#my-list' : ''));
  refreshDisplay();
});
function downloadBackup(document, prefix = 'ps-store-personal') {
  const blob = new Blob([exportBackup(document)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `${prefix}-${new Date().toISOString().slice(0, 10)}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#export').addEventListener('click', async () => {
  try {
    const state = await store.read(); downloadBackup(state.document);
  } catch { notice('個人標記匯出失敗，請保留目前瀏覽器資料。', true); }
});
$('#import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  try {
    if (file.size > limits.bytes) throw Error('size');
    const document = importBackup(await file.text()), snapshot = await store.read();
    const plan = planLocalBackup(snapshot, document);
    pendingImport = { document, revision: snapshot.localRevision };
    $('#import-summary').textContent = `備份含 ${Object.keys(document.data.marks).length} 筆標記、${Object.keys(document.data.tombstones).length} 筆取消紀錄；有 ${plan.conflicts.length} 筆衝突需依下列選擇處理。`;
    $('#import-choice').value = 'local'; $('#import-dialog').showModal();
  } catch { pendingImport = null; notice('無法匯入：檔案格式、版本或大小不符，或目前工作區不適合匯入。原資料保持不變。', true); }
});
$('#import-cancel').addEventListener('click', () => { pendingImport = null; $('#import-dialog').close(); });
$('#import-dialog').addEventListener('close', () => { pendingImport = null; });
$('#import-confirm').addEventListener('click', async () => {
  if (!pendingImport) return;
  $('#import-confirm').disabled = true;
  try {
    local = await store.importBackup(pendingImport.document, pendingImport.revision, $('#import-choice').value);
    await rememberVisibleProducts();
    pendingImport = null; $('#import-dialog').close(); $('#recovery').hidden = false;
    channel?.postMessage('changed'); render(); notice(metadataUnavailable ? '個人備份已匯入；商品基本資料暫時無法更新。' : '個人備份已合併匯入；匯入前資料已保留，可另外匯出。', metadataUnavailable);
  } catch { pendingImport = null; $('#import-dialog').close(); notice('匯入未完成，先前資料仍保留；若其他分頁已修改，請重新預覽。', true); }
  finally { $('#import-confirm').disabled = false; }
});
$('#recovery').addEventListener('click', async () => {
  try { const backup = await store.readImportBackup(); if (backup) downloadBackup(backup, 'ps-store-personal-before-import'); }
  catch { notice('復原備份讀取失敗，請保留目前瀏覽器資料。', true); }
});
async function start() {
  try {
    const response = await fetch('./data/catalog.json', { cache: 'no-store' });
    if (!response.ok) throw Error('catalog');
    const candidate = await response.json();
    savedCatalog = validateCatalog(candidate);
  } catch {
    savedCatalog = buildCatalog([]); catalogUnavailable = true;
  }
  try {
    store = await openPersonalStore({ name: databaseName }); local = await store.read();
    await rememberVisibleProducts();
    $('#export').disabled = false;
    $('#import').disabled = false; $('#recovery').hidden = !(await store.readImportBackup());
    channel = new BroadcastChannel(databaseName);
    channel.onmessage = async () => { try {
      local = await store.read(); await rememberVisibleProducts(); render();
    } catch { notice('讀取跨分頁標記失敗。', true); } };
  } catch { notice('商品可瀏覽，但此瀏覽器無法儲存標記。', true); }
  $('#updated').textContent = savedCatalog.fetchedAt ? `最近一次活動擷取：${new Date(savedCatalog.fetchedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}（台灣時間）；各活動保存自己的快照，頁面修改不會重抓。` : '尚未新增活動。';
  refreshDisplay();
  setInterval(() => { if (lifecycle() !== lifecycleSignature) refreshDisplay(); }, 30_000);
}
window.addEventListener('pagehide', () => { googleLogin.disconnect(); channel?.close(); store?.close(); });
await start();
