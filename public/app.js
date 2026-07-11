/* ═══════════════════════════════════════════════════════════════
   NHI 健保藥品查詢系統 - app.js
   功能：搜尋、URL Deep Link、無限捲動、Tag 點擊、詳情 Panel
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ─── 常數 ────────────────────────────────────────────────────────
const API_BASE = '/api';
const PAGE_SIZE = 100;

// 欄位 → API 參數名稱對照
const TAG_FIELD_MAP = {
  '成分':          '成分',
  '劑型':          '劑型',
  '藥品分類':      '藥品分類',
  '分類分組名稱':  '分類分組名稱',
  '單複方':        '單複方',
  'ATC代碼':       'ATC代碼',
};

// ─── 狀態 ────────────────────────────────────────────────────────
let state = {
  query: {},          // 所有搜尋條件
  results: [],        // 目前已載入的結果
  total: 0,           // 總筆數
  page: 1,
  hasMore: false,
  loading: false,
  loadingMore: false,
  viewMode: 'card',   // 'card' | 'table'
  sortBy: '',         // 排序欄位
  sortOrder: 'asc',   // 排序方向
  ingredients: [],    // 累加的成分篩選條件
};

// ─── DOM 參照 ─────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const searchInput        = $('searchInput');
const searchBtn          = $('searchBtn');
const advancedToggle     = $('advancedToggle');
const advancedFilters    = $('advancedFilters');
const filterDosageForm   = $('filterDosageForm');
const filterCategory     = $('filterCategory');
const filterSubCategory  = $('filterSubCategory');
const filterATC          = $('filterATC');
const filterPriceMin     = $('filterPriceMin');
const filterPriceMax     = $('filterPriceMax');
const activeFilters      = $('activeFilters');
const activeFilterTags   = $('activeFilterTags');
const clearAllBtn        = $('clearAllBtn');
const resultsMeta        = $('resultsMeta');
const resultsCount       = $('resultsCount');
const emptyState         = $('emptyState');
const loadingState       = $('loadingState');
const noResults          = $('noResults');
const resultsList        = $('resultsList');
const resultsTableWrap   = $('resultsTableWrap');
const resultsTableBody   = $('resultsTableBody');
const sentinel           = $('infiniteScrollSentinel');
const loadMoreIndicator  = $('loadMoreIndicator');
const resultsView        = $('resultsView');
const detailView         = $('detailView');
const detailBody         = $('detailBody');
const detailClose        = $('detailClose');
const viewCard           = $('viewCard');
const viewTable          = $('viewTable');
const syncInfo           = $('syncInfo');
const footerSync         = $('footerSync');
const toastContainer     = $('toastContainer');

// ─── 初始化 ────────────────────────────────────────────────────────
async function init() {
  // 優先偵測與寫入 Pro Mode 授權狀態（避免後續 URL 被清除）
  if (typeof isProMode === 'function') {
    isProMode();
  }
  await loadOptions();
  loadSyncInfo();
  readUrlAndSearch();
  setupEventListeners();
  setupInfiniteScroll();
}

// ─── 載入下拉選項 ─────────────────────────────────────────────────
async function loadOptions() {
  try {
    const res = await fetch(`${API_BASE}/options`);
    const data = await res.json();
    populateSelect(filterDosageForm, data['劑型'] || []);
    populateSelect(filterCategory,   data['藥品分類'] || []);
    // 分類分組聯動
    const allSubCats = data['分類分組名稱'] || [];
    filterCategory.addEventListener('change', () => {
      // 未來可做聯動過濾，目前直接全部顯示
      populateSelect(filterSubCategory, allSubCats);
    });
    populateSelect(filterSubCategory, allSubCats);
  } catch (e) { console.warn('Failed to load options:', e); }
}

function populateSelect(sel, options) {
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部</option>';
  options.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = v;
    sel.appendChild(opt);
  });
  if (cur) sel.value = cur;
}

// ─── 同步時間 ──────────────────────────────────────────────────────
async function loadSyncInfo() {
  try {
    const res = await fetch(`${API_BASE}/sync`);
    const data = await res.json();
    if (data.sync_time) {
      const dt = new Date(data.sync_time);
      const fmt = dt.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const info = `最後更新 ${fmt}，共 ${Number(data.total_records).toLocaleString()} 筆`;
      syncInfo.textContent = info;
      footerSync.textContent = info;
    }
  } catch (e) { syncInfo.textContent = ''; }
}

// ─── URL 解析 & 初始搜尋 ─────────────────────────────────────────
function readUrlAndSearch() {
  const urlParams = new URLSearchParams(window.location.search);
  const codeParam = urlParams.get('code');

  // 若有 code，直接查單筆後展開詳情
  if (codeParam) {
    loadAndOpenDetail(codeParam);
    return;
  }

  // 讀取搜尋條件
  const q = urlParams.get('q') || '';
  if (q) searchInput.value = q;
  // 從 URL 還原成分篩選（支援多成分，逗號分隔）
  const ingredientParam = urlParams.get('成分') || '';
  if (ingredientParam) {
    state.ingredients = ingredientParam.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (urlParams.get('ATC代碼'))      filterATC.value = urlParams.get('ATC代碼') || '';
  if (urlParams.get('劑型'))         filterDosageForm.value = urlParams.get('劑型') || '';
  if (urlParams.get('藥品分類'))     filterCategory.value = urlParams.get('藥品分類') || '';
  if (urlParams.get('分類分組名稱')) filterSubCategory.value = urlParams.get('分類分組名稱') || '';
  if (urlParams.get('單複方'))       document.querySelector(`[name="singleCompound"][value="${urlParams.get('單複方')}"]`).checked = true;
  if (urlParams.get('支付價_min'))   filterPriceMin.value = urlParams.get('支付價_min') || '';
  if (urlParams.get('支付價_max'))   filterPriceMax.value = urlParams.get('支付價_max') || '';

  // 有任何條件就執行搜尋
  const hasAnyParam = [...urlParams.keys()].some(k => k !== 'code');
  if (hasAnyParam) doSearch();
}

// ─── 收集搜尋條件 ─────────────────────────────────────────────────
function collectQuery() {
  const q = {};
  const kw = searchInput.value.trim();
  if (kw) q.q = kw;
  // 將累加的成分以逗號分隔傳給 API
  if (state.ingredients.length > 0) q['成分'] = state.ingredients.join(',');
  const dosage = filterDosageForm.value;
  if (dosage) q['劑型'] = dosage;
  const cat = filterCategory.value;
  if (cat) q['藥品分類'] = cat;
  const sub = filterSubCategory.value;
  if (sub) q['分類分組名稱'] = sub;
  const sc = document.querySelector('[name="singleCompound"]:checked')?.value;
  if (sc) q['單複方'] = sc;
  const atc = filterATC.value.trim();
  if (atc) q['ATC代碼'] = atc;
  const pMin = filterPriceMin.value;
  if (pMin !== '') q['支付價_min'] = pMin;
  const pMax = filterPriceMax.value;
  if (pMax !== '') q['支付價_max'] = pMax;
  return q;
}

// ─── 更新 URL ────────────────────────────────────────────────────
function updateUrl(query) {
  const params = new URLSearchParams(query);
  const url = params.toString() ? `?${params.toString()}` : window.location.pathname;
  history.replaceState(null, '', url);
}

// ─── 主搜尋 ──────────────────────────────────────────────────────
async function doSearch(resetPage = true) {
  if (state.loading) return;
  const query = collectQuery();
  state.query = query;
  if (resetPage) {
    state.page = 1;
    state.results = [];
  }
  updateUrl(query);
  updateActiveFilterTags(query);
  await fetchResults();
}

async function fetchResults(append = false) {
  state.loading = true;
  if (!append) showState('loading');
  else {
    loadMoreIndicator.hidden = false;
    state.loadingMore = true;
  }

  const params = new URLSearchParams({ ...state.query, page: state.page });
  if (state.sortBy) {
    params.set('sort_by', state.sortBy);
    params.set('order', state.sortOrder);
  }
  
  try {
    const res = await fetch(`${API_BASE}/drugs?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'API 錯誤');

    state.total = data.total;
    state.hasMore = data.has_more;
    if (append) {
      state.results = [...state.results, ...data.data];
    } else {
      state.results = data.data;
    }
    renderResults(append);
  } catch (err) {
    showToast('搜尋失敗：' + err.message, 'error');
    if (!append) showState('error');
  } finally {
    state.loading = false;
    state.loadingMore = false;
    loadMoreIndicator.hidden = true;
  }
}

// ─── 渲染結果 ─────────────────────────────────────────────────────
function renderResults(append = false) {
  const hasResults = state.results.length > 0;

  if (!hasResults) { showState('noResults'); return; }

  // 明確隱藏所有非結果狀態元素，避免競態條件
  emptyState.hidden    = true;
  loadingState.hidden  = true;
  noResults.hidden     = true;
  resultsMeta.hidden   = false;
  resultsCount.textContent = `共 ${Number(state.total).toLocaleString()} 筆，顯示 ${state.results.length} 筆`;

  if (state.viewMode === 'card') {
    resultsTableWrap.hidden = true;
    if (!append) resultsList.innerHTML = '';
    const items = append ? state.results.slice(-100) : state.results;
    const frag = document.createDocumentFragment();
    items.forEach(drug => frag.appendChild(createDrugCard(drug)));
    resultsList.appendChild(frag);
    resultsList.hidden = false;
  } else {
    resultsList.hidden = true;
    if (!append) resultsTableBody.innerHTML = '';
    const items = append ? state.results.slice(-100) : state.results;
    const frag = document.createDocumentFragment();
    items.forEach(drug => frag.appendChild(createTableRow(drug)));
    resultsTableBody.appendChild(frag);
    resultsTableWrap.hidden = false;
  }
}

// ─── 英文名數字加粗斜體 ────────────────────────────────────────────
function formatDrugNameEn(rawName) {
  if (!rawName) return '';
  // 先跳脫 HTML，再針對數字（含小數點、空格前後）加粗斜體
  return esc(rawName).replace(/(\d[\d.,]*)/g, '<strong><em>$1</em></strong>');
}

// ─── 藥品卡片 ─────────────────────────────────────────────────────
function createDrugCard(drug) {
  const card = document.createElement('div');
  card.className = 'drug-card';
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', `${drug['藥品中文名稱']}，詳細資訊`);

  const nameZh = esc(drug['藥品中文名稱'] || '');
  const nameEnRaw = drug['藥品英文名稱'] || '';
  const nameEnFormatted = formatDrugNameEn(nameEnRaw);
  const price = drug['支付價'] ? `＄ ${drug['支付價']}` : '—';
  const code = esc(drug['藥品代號'] || '');

  card.innerHTML = `
    <div class="drug-card-header">
      <span class="drug-name-en-main">${nameEnFormatted || code}</span>
      <span class="drug-price">${price}</span>
    </div>
    <div class="drug-name-zh-sub">${nameZh}</div>
    <div class="drug-tags">
      ${tagBtn('劑型', drug['劑型'])}
      ${tagBtn('單複方', drug['單複方'])}
      ${tagBtn('藥品分類', drug['藥品分類'])}
      ${tagBtn('分類分組名稱', drug['分類分組名稱'])}
      ${tagBtn('ATC代碼', drug['ATC代碼'])}
      ${drug['成分'] ? `<span class="field-tag" data-field="成分" data-value="${esc(drug['成分'])}" title="${esc(drug['成分'])}">
        ${svgPlus()}
        ${trunc(drug['成分'], 24)}
      </span>` : ''}
      <button class="detail-btn" data-code="${code}" aria-label="查看詳細">
        詳細
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
    </div>
  `;

  // 點擊 detail-btn
  card.querySelector('.detail-btn').addEventListener('click', e => {
    e.stopPropagation();
    openDetailByCode(code, drug);
  });
  // 點擊 tag
  card.querySelectorAll('.field-tag[data-field]').forEach(tag => {
    tag.addEventListener('click', e => {
      e.stopPropagation();
      applyTagToFilter(tag.dataset.field, tag.dataset.value);
    });
  });
  // 點擊卡片
  card.addEventListener('click', () => openDetailByCode(code, drug));
  card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') openDetailByCode(code, drug); });

  // Pro Mode：注入「尋找候選替代品項」按鈕
  injectSubstituteBtn(card, code);

  return card;
}

function tagBtn(field, value) {
  if (!value) return '';
  return `<span class="field-tag" data-field="${esc(field)}" data-value="${esc(value)}">${esc(trunc(value, 16))}${svgPlus()}</span>`;
}

// ─── 表格行 ──────────────────────────────────────────────────────
function createTableRow(drug) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="code-cell">${esc(drug['藥品代號'] || '')}</td>
    <td class="name-cell">${esc(drug['藥品中文名稱'] || '')}</td>
    <td class="ingredient-cell" title="${esc(drug['成分'] || '')}">${esc(trunc(drug['成分'] || '', 30))}</td>
    <td>${drug['劑型'] ? `<span class="badge badge-blue">${esc(drug['劑型'])}</span>` : '—'}</td>
    <td>${esc(drug['ATC代碼'] || '—')}</td>
    <td class="price-cell">${drug['支付價'] ? `＄ ${drug['支付價']}` : '—'}</td>
    <td>
      <button class="detail-btn" data-code="${esc(drug['藥品代號'] || '')}" aria-label="查看詳細">詳細</button>
    </td>
  `;
  tr.querySelector('.detail-btn').addEventListener('click', e => {
    e.stopPropagation();
    openDetailByCode(drug['藥品代號'], drug);
  });
  tr.addEventListener('click', () => openDetailByCode(drug['藥品代號'], drug));
  return tr;
}

// ─── 詳情 Panel ───────────────────────────────────────────────────
async function loadAndOpenDetail(code) {
  try {
    const res = await fetch(`${API_BASE}/drugs/${encodeURIComponent(code)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    openDetailPanel(data.data);
  } catch (err) {
    showToast('無法載入藥品資料：' + err.message, 'error');
  }
}

function openDetailByCode(code, cachedDrug = null) {
  if (cachedDrug) {
    openDetailPanel(cachedDrug);
  } else {
    loadAndOpenDetail(code);
  }
}

function openDetailPanel(drug) {
  detailBody.innerHTML = buildDetailHTML(drug);

  // 綁定 tag 點擊與成分加入按鈕
  detailBody.querySelectorAll('.field-tag[data-field], .filter-add-btn[data-field]').forEach(btn => {
    btn.addEventListener('click', () => {
      applyTagToFilter(btn.dataset.field, btn.dataset.value);
    });
  });

  // 顯示
  resultsView.hidden = true;
  detailView.hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Pro Mode：注入「尋找候選替代品項」按鈕到詳情 Header
  injectSubstituteBtnDetail(drug['藥品代號']);

  // 非同步載入 EPI 仿單資料
  if (drug['許可證字號']) {
    loadEpiData(drug['許可證字號']);
  }
}

function closeDetailPanel() {
  detailView.hidden = true;
  resultsView.hidden = false;
}

// ─── 詳情 HTML 建構 ───────────────────────────────────────────────
function buildDetailHTML(d) {
  const parseChapters = (chapStr) => {
    if (!chapStr) return [];
    return chapStr.split(',').map(url => {
      url = url.trim();
      try {
        const u = new URL(url);
        const fn = u.searchParams.get('DurgFileName') || '';
        const match = fn.match(/^([\d.]+)\./);
        const chapter = match ? match[1] : fn.split('_')[0] || '章節';
        return { url, chapter };
      } catch {
        return { url, chapter: '章節' };
      }
    }).filter(x => x.url);
  };

  const chapters = parseChapters(d['給付規定章節連結']);
  const start = d['有效起日'] || '';
  const end   = d['有效迄日'] || '';
  const licNo = d['許可證字號'] || '';

  return `
    <!-- 核心資訊 -->
    <div class="detail-section">
      <div class="detail-core-header">
        <div class="detail-name-en">${formatDrugNameEn(d['藥品英文名稱'] || '')}</div>
        <div class="detail-name-zh">${esc(d['藥品中文名稱'] || '')}</div>
        <div class="detail-price-row">
          <div>
            <div class="detail-price-label">支付價格</div>
            <div class="detail-price">${d['支付價'] ? `＄ ${d['支付價']}` : '未設定'}</div>
          </div>
          ${d['劑型'] ? `<span class="badge badge-blue">${esc(d['劑型'])}</span>` : ''}
          ${d['單複方'] ? `<span class="badge badge-green">${esc(d['單複方'])}</span>` : ''}
        </div>
      </div>
      <div class="detail-row">
        <span class="detail-row-label">藥品代號</span>
        <div class="copy-wrap">
          <code class="detail-row-value" style="font-family:monospace;font-size:.88rem">${esc(d['藥品代號'] || '')}</code>
          <button class="copy-btn" onclick="copyText('${esc(d['藥品代號'] || '')}', this)">
            ${svgCopy()} 複製
          </button>
        </div>
      </div>
      ${d['規格量'] || d['規格單位'] ? `<div class="detail-row">
        <span class="detail-row-label">規格</span>
        <span class="detail-row-value">${esc(d['規格量'] || '')} ${esc(d['規格單位'] || '')}</span>
      </div>` : ''}
    </div>

    <!-- 成分與分類 -->
    <div class="detail-section">
      <div class="detail-section-title">成分與分類</div>
      ${d['成分'] ? `<div class="detail-row" style="flex-direction: column; gap: 4px;">
        <span class="detail-row-label" style="margin-bottom: 2px;">成分</span>
        <div class="ingredient-list">
          ${d['成分'].split(/[,/;，+]/).map(s => s.trim()).filter(Boolean).map(s =>
            `<div class="ingredient-item">
               <div class="ingredient-text">${esc(s)}</div>
               <button class="filter-add-btn" data-field="成分" data-value="${esc(s)}" title="點擊帶入搜尋" aria-label="帶入 ${esc(s)} 作為搜尋條件">${svgPlus()}</button>
             </div>`
          ).join('')}
        </div>
      </div>` : ''}
      ${d['藥品分類'] ? `<div class="detail-row" style="flex-direction: column; gap: 4px;">
        <span class="detail-row-label" style="margin-bottom: 2px;">藥品分類</span>
        <div class="ingredient-list">
          <div class="ingredient-item">
            <div class="ingredient-text">${esc(d['藥品分類'])}</div>
            <button class="filter-add-btn" data-field="藥品分類" data-value="${esc(d['藥品分類'])}" title="點擊帶入搜尋" aria-label="帶入 ${esc(d['藥品分類'])} 作為搜尋條件">${svgPlus()}</button>
          </div>
        </div>
      </div>` : ''}
      ${d['分類分組名稱'] ? `<div class="detail-row" style="flex-direction: column; gap: 4px;">
        <span class="detail-row-label" style="margin-bottom: 2px;">分類分組</span>
        <div class="ingredient-list">
          <div class="ingredient-item">
            <div class="ingredient-text">${esc(d['分類分組名稱'])}</div>
            <button class="filter-add-btn" data-field="分類分組名稱" data-value="${esc(d['分類分組名稱'])}" title="點擊帶入搜尋" aria-label="帶入 ${esc(d['分類分組名稱'])} 作為搜尋條件">${svgPlus()}</button>
          </div>
        </div>
      </div>` : ''}
      ${d['ATC代碼'] ? `<div class="detail-row" style="flex-direction: column; gap: 4px;">
        <span class="detail-row-label" style="margin-bottom: 2px;">ATC 代碼</span>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <div class="ingredient-item" style="margin-bottom:0">
            <div class="ingredient-text">${esc(d['ATC代碼'])}</div>
            <button class="filter-add-btn" data-field="ATC代碼" data-value="${esc(d['ATC代碼'])}" title="點擊帶入搜尋" aria-label="帶入 ${esc(d['ATC代碼'])} 作為搜尋條件">${svgPlus()}</button>
          </div>
          <a class="btn-action btn-action--ext" href="https://atcddd.fhi.no/atc_ddd_index/?code=${encodeURIComponent(d['ATC代碼'])}&showdescription=no" target="_blank" rel="noopener">
            ${svgExternalLink()} ATC 分類查詢
          </a>
        </div>
      </div>` : ''}
    </div>

    <!-- 廠商與許可 -->
    <div class="detail-section">
      <div class="detail-section-title">廠商與許可</div>
      ${start || end ? `<div class="detail-row"><span class="detail-row-label">有效起訖</span><span class="detail-row-value" style="font-family:'Figtree', monospace; font-weight:600;">${esc(formatDateYYY(start)) || '—'} → ${esc(formatDateYYY(end)) || '持續有效'}</span></div>` : ''}
      ${d['藥商'] ? `<div class="detail-row"><span class="detail-row-label">藥商</span><span class="detail-row-value">${esc(d['藥商'])}</span></div>` : ''}
      ${d['製造廠名稱'] ? `<div class="detail-row"><span class="detail-row-label">製造廠</span><span class="detail-row-value">${esc(d['製造廠名稱'])}</span></div>` : ''}
      ${licNo ? `<div class="detail-row">
        <span class="detail-row-label">許可字號</span>
        <div class="copy-wrap">
          <span class="detail-row-value" style="font-family:monospace;font-size:.85rem">${esc(licNo)}</span>
          <button class="copy-btn" onclick="copyText('${esc(licNo)}', this)">${svgCopy()} 複製</button>
        </div>
      </div>
      ` : ''}
    </div>

    <!-- EPI 適應症（非同步載入）+ 延伸按鈕 -->
    ${licNo ? `<div class="detail-section" id="epiSection">
      <div class="detail-section-title">適應症</div>
      <div id="epiContent" class="epi-loading">
        <div class="spinner spinner--sm"></div>
        <span>載入中...</span>
      </div>
      <div class="action-buttons" style="margin-top:14px">
        <a class="btn-action btn-action--ext" href="https://epi.mingster.workers.dev/?q=${encodeURIComponent(licNo)}" target="_blank" rel="noopener">
          ${svgExternalLink()} 電子仿單資訊應用平台
        </a>
        <a class="btn-action btn-action--ext" href="https://mcp.fda.gov.tw/im_shape/${encodeURIComponent(licNo)}" target="_blank" rel="noopener">
          ${svgExternalLink()} 藥品外觀查詢
        </a>
      </div>
    </div>` : ''}

    <!-- 給付規定 -->
    ${chapters.length > 0 ? `<div class="detail-section">
      <div class="detail-section-title">給付規定章節</div>
      <div class="action-buttons">
        ${chapters.map(({ url, chapter }) =>
          `<a class="btn-action btn-action--pdf" href="${esc(url)}" target="_blank" rel="noopener">
            ${svgPdf()} 章節 ${esc(chapter)}
          </a>`
        ).join('')}
      </div>
    </div>` : ''}
  `;
}

// ─── EPI API 非同步載入（只取適應症）────────────────────────────────
async function loadEpiData(licNo) {
  const el = document.getElementById('epiContent');
  if (!el) return;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 秒 Timeout
  
  try {
    const res = await fetch(
      `https://epi.mingtc.com/api/v1/labels?licenseNo=${encodeURIComponent(licNo)}&sec=indication&format=json`,
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);
    
    const data = await res.json();
    if (!data.success) throw new Error(data.error?.message || '查無資料');

    const text = data.data?.sections?.indication?.text || '';
    el.className = '';
    
    if (text) {
      // 移除開頭可能獨立存在的標題（如 "2" 或 "適應症" 等）
      let cleanedText = text.trim().replace(/^(?:[\d\s]*(?:2|二)\.?\s*|適應症\s*[:：]?\s*)/i, '');
      
      // 去掉行首數字標號（如 1. 2. (1) 等），並過濾冗餘的「適應症」單行與空行
      const cleaned = cleanedText
        .split('\n')
        .map(line => line.replace(/^\s*(\d+[.)、]|[（(]\d+[)）])\s*/, '').trim())
        .filter(line => line && !/^適應症\s*[:：]?$/i.test(line))
        .join('\n');
        
      el.innerHTML = cleaned ? `<div class="epi-block-text">${esc(cleaned)}</div>` : '<p class="epi-none">此藥品無適應症資料</p>';
    } else {
      el.innerHTML = '<p class="epi-none">此藥品無適應症資料</p>';
    }
  } catch (err) {
    clearTimeout(timeoutId);
    el.className = '';
    // 若為 Timeout，顯示網路連線逾時
    if (err.name === 'AbortError') {
      el.innerHTML = `<p class="epi-none">伺服器回應過慢，載入適應症逾時。請稍後再試。</p>`;
    } else {
      el.innerHTML = `<p class="epi-none">資料載入失敗：${esc(err.message)}</p>`;
    }
  }
}

// ─── Tag 帶入篩選 ─────────────────────────────────────────────────
function applyTagToFilter(field, value) {
  let applied = false;
  switch(field) {
    case '成分':
      // 成分累加到 state.ingredients（去重）
      if (!state.ingredients.includes(value)) {
        state.ingredients.push(value);
      }
      applied = true;
      break;
    case '劑型':          filterDosageForm.value  = value; applied = true; break;
    case '藥品分類':      filterCategory.value    = value; applied = true; break;
    case '分類分組名稱':  filterSubCategory.value = value; applied = true; break;
    case '單複方': {
      const radio = document.querySelector(`[name="singleCompound"][value="${value}"]`);
      if (radio) { radio.checked = true; applied = true; }
      break;
    }
    case 'ATC代碼':       filterATC.value = value; applied = true; break;
  }
  if (applied) {
    // 展開進階篩選（若條件在進階區）
    if (['劑型','藥品分類','分類分組名稱','單複方','ATC代碼'].includes(field)) {
      advancedFilters.classList.add('open');
      advancedToggle.setAttribute('aria-expanded', 'true');
    }
    showToast(`已帶入「${field}」作為搜尋條件`);
    updateActiveFilterTags(collectQuery());
    doSearch(true); // 自動在背景重搜
  }
}

// ─── 作用中條件 Tags ─────────────────────────────────────────────
function updateActiveFilterTags(query) {
  const tags = [];
  if (query.q) tags.push({ label: `關鍵字：${query.q}`, field: 'q' });
  // 每個成分獨立顯示為一個 tag
  state.ingredients.forEach((ing, idx) => {
    tags.push({ label: `成分：${ing}`, field: `成分_${idx}`, ingredientIndex: idx });
  });
  if (query['劑型'])         tags.push({ label: `劑型：${query['劑型']}`, field: '劑型' });
  if (query['藥品分類'])     tags.push({ label: `分類：${query['藥品分類']}`, field: '藥品分類' });
  if (query['分類分組名稱']) tags.push({ label: `分組：${query['分類分組名稱']}`, field: '分類分組名稱' });
  if (query['單複方'])       tags.push({ label: query['單複方'], field: '單複方' });
  if (query['ATC代碼'])      tags.push({ label: `ATC：${query['ATC代碼']}`, field: 'ATC代碼' });
  if (query['支付價_min'])   tags.push({ label: `最低 ＄${query['支付價_min']}`, field: '支付價_min' });
  if (query['支付價_max'])   tags.push({ label: `最高 ＄${query['支付價_max']}`, field: '支付價_max' });

  if (tags.length === 0) { activeFilters.hidden = true; return; }
  activeFilters.hidden = false;
  activeFilterTags.innerHTML = tags.map(t => `
    <span class="filter-tag">
      ${esc(t.label)}
      <button onclick="removeFilter('${esc(t.field)}')" aria-label="移除 ${esc(t.label)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </span>
  `).join('');
}

window.removeFilter = function(field) {
  // 檢查是否為成分 tag（格式：成分_0, 成分_1, ...）
  const ingredientMatch = field.match(/^成分_(\d+)$/);
  if (ingredientMatch) {
    const idx = parseInt(ingredientMatch[1]);
    state.ingredients.splice(idx, 1);
    doSearch();
    return;
  }
  switch(field) {
    case 'q': searchInput.value = ''; break;
    case '劑型':         filterDosageForm.value = ''; break;
    case '藥品分類':     filterCategory.value = ''; break;
    case '分類分組名稱': filterSubCategory.value = ''; break;
    case '單複方':       document.querySelector('[name="singleCompound"][value=""]').checked = true; break;
    case 'ATC代碼':      filterATC.value = ''; break;
    case '支付價_min':   filterPriceMin.value = ''; break;
    case '支付價_max':   filterPriceMax.value = ''; break;
  }
  doSearch();
};

// ─── 無限捲動 ─────────────────────────────────────────────────────
function setupInfiniteScroll() {
  const observer = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting && state.hasMore && !state.loading && !state.loadingMore && state.results.length > 0) {
      state.page++;
      fetchResults(true);
    }
  }, { rootMargin: '300px' }); // 距底 300px 前觸發（大約 3 筆卡片高度）
  observer.observe(sentinel);
}

// ─── 顯示狀態切換 ─────────────────────────────────────────────────
function showState(mode) {
  emptyState.hidden          = mode !== 'empty';
  loadingState.hidden        = mode !== 'loading';
  noResults.hidden           = mode !== 'noResults';
  resultsMeta.hidden         = mode !== 'results';

  const isResults = mode === 'results';
  const isCard    = isResults && state.viewMode === 'card';
  const isTable   = isResults && state.viewMode === 'table';
  resultsList.hidden         = !isCard;
  resultsTableWrap.hidden    = !isTable;
}

// ─── 視圖切換 ────────────────────────────────────────────────────
function setViewMode(mode) {
  state.viewMode = mode;
  viewCard.classList.toggle('active', mode === 'card');
  viewTable.classList.toggle('active', mode === 'table');
  if (state.results.length > 0) renderResults();
}

// ─── 事件監聽 ─────────────────────────────────────────────────────
function setupEventListeners() {
  searchBtn.addEventListener('click', () => doSearch());
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  advancedToggle.addEventListener('click', () => {
    const open = advancedFilters.classList.toggle('open');
    advancedToggle.setAttribute('aria-expanded', open);
  });
  clearAllBtn.addEventListener('click', () => {
    searchInput.value = '';
    state.ingredients = [];  // 清除所有成分條件
    filterDosageForm.value = '';
    filterCategory.value = '';
    filterSubCategory.value = '';
    filterATC.value = '';
    filterPriceMin.value = '';
    filterPriceMax.value = '';
    document.querySelector('[name="singleCompound"][value=""]').checked = true;
    doSearch();
  });
  detailClose.addEventListener('click', closeDetailPanel);
  document.addEventListener('keydown', e => { 
    if (e.key === 'Escape' && !detailView.hidden) closeDetailPanel(); 
  });
  viewCard.addEventListener('click', () => setViewMode('card'));
  viewTable.addEventListener('click', () => setViewMode('table'));

  // 排序事件
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (state.sortBy === field) {
        state.sortOrder = state.sortOrder === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortBy = field;
        state.sortOrder = 'asc';
      }
      updateSortUi();
      doSearch();
    });
  });

  // 匯出 CSV 事件
  const exportBtn = $('exportCsvBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const params = new URLSearchParams(state.query);
      if (state.sortBy) {
        params.set('sort_by', state.sortBy);
        params.set('order', state.sortOrder);
      }
      params.set('export', 'csv');
      window.open(`${API_BASE}/drugs?${params}`, '_blank');
    });
  }
}

function updateSortUi() {
  document.querySelectorAll('th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === state.sortBy) {
      th.classList.add(state.sortOrder === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

// ─── 工具函式 ─────────────────────────────────────────────────────
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function trunc(str, len) {
  return str && str.length > len ? str.slice(0, len) + '…' : (str || '');
}
function formatDate(str) {
  if (!str) return '';
  const m = String(str).match(/(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : str;
}
// 民國年格式 YYY/MM/DD（資料已是民國年 YYYMMDD 格式）
function formatDateYYY(str) {
  if (!str) return '';
  const s = String(str).trim();
  // 可能是 7 位 YYYMMDD 或 8 位 YYYYMMDD (西元)
  if (s.length === 7) {
    // 民國年 7 碼：YYY MM DD
    return `${s.slice(0,3)}/${s.slice(3,5)}/${s.slice(5,7)}`;
  }
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    // 西元年 8 碼，轉民國
    const yyy = parseInt(m[1], 10) - 1911;
    return `${yyy}/${m[2]}/${m[3]}`;
  }
  return str;
}
function dateProgress(start, end) {
  try {
    const s = new Date(start), e = new Date(end), n = new Date();
    if (!e || isNaN(s) || isNaN(e)) return 50;
    return Math.min(100, Math.max(0, Math.round((n - s) / (e - s) * 100)));
  } catch { return 50; }
}

window.copyText = function(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.innerHTML;
    btn.innerHTML = `${svgCheck()} 已複製`;
    setTimeout(() => { btn.innerHTML = orig; }, 1800);
  }).catch(() => showToast('複製失敗', 'error'));
};

function showToast(msg, type = 'default') {
  const t = document.createElement('div');
  t.className = `toast ${type === 'success' ? 'toast-success' : type === 'error' ? 'toast-error' : ''}`;
  const ico = type === 'error'
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  t.innerHTML = ico + esc(msg);
  toastContainer.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ─── SVG 圖示 (inline) ───────────────────────────────────────────
function svgPlus() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
}
function svgCopy() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
}
function svgCheck() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px"><polyline points="20 6 9 17 4 12"/></svg>`;
}
function svgExternalLink() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
}
function svgPdf() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`;
}

// ─── 啟動 ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);


/* ═══════════════════════════════════════════════════════════════
   ██████╗ ██████╗  ██████╗     ███╗   ███╗ ██████╗ ██████╗ ███████╗
   ██╔══██╗██╔══██╗██╔═══██╗    ████╗ ████║██╔═══██╗██╔══██╗██╔════╝
   ██████╔╝██████╔╝██║   ██║    ██╔████╔██║██║   ██║██║  ██║█████╗
   ██╔═══╝ ██╔══██╗██║   ██║    ██║╚██╔╝██║██║   ██║██║  ██║██╔══╝
   ██║     ██║  ██║╚██████╔╝    ██║ ╚═╝ ██║╚██████╔╝██████╔╝███████╗
   ╚═╝     ╚═╝  ╚═╝ ╚═════╝     ╚═╝     ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝
   候選替代品項搜尋與決策檢核平台 — Pro Mode
   僅在 ?mode=pro 或 localStorage 有授權時顯示
   ═══════════════════════════════════════════════════════════════ */

// ─── Pro Mode 偵測與授權 ─────────────────────────────────────────
const PRO_STORAGE_KEY = 'nhi_pro_mode';
const PRO_URL_PARAM   = 'mode';
const PRO_URL_VALUE   = 'pro';

/** 偵測當前是否為 Pro Mode */
function isProMode() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get(PRO_URL_PARAM) === PRO_URL_VALUE) {
    // 寫入 localStorage，下次免打參數
    try { localStorage.setItem(PRO_STORAGE_KEY, '1'); } catch (_) {}
    return true;
  }
  try { return localStorage.getItem(PRO_STORAGE_KEY) === '1'; } catch (_) {}
  return false;
}

// ─── Pro Mode 按鈕注入 ───────────────────────────────────────────
/** 注入「尋找候選替代品項」按鈕到藥品卡片 */
function injectSubstituteBtn(card, drugCode) {
  if (!isProMode()) return;
  const btn = document.createElement('button');
  btn.className = 'sub-trigger-btn';
  btn.dataset.code = drugCode;
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      <line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
    </svg>
    尋找候選替代品項
  `;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    openSubstituteModal(drugCode);
  });
  const tagsDiv = card.querySelector('.drug-tags');
  if (tagsDiv) tagsDiv.insertBefore(btn, tagsDiv.firstChild);
}

/** 注入「尋找候選替代品項」按鈕到詳情 Panel */
function injectSubstituteBtnDetail(drugCode) {
  if (!isProMode()) return;
  const existing = document.getElementById('subDetailBtn');
  if (existing) existing.remove();
  const btn = document.createElement('button');
  btn.id = 'subDetailBtn';
  btn.className = 'sub-trigger-btn sub-trigger-btn--detail';
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      <line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
    </svg>
    尋找候選替代品項
  `;
  btn.addEventListener('click', () => openSubstituteModal(drugCode));
  const detailHeader = document.querySelector('.detail-header-actions');
  if (detailHeader) detailHeader.appendChild(btn);
}

// ─── Substitute Modal 狀態 ───────────────────────────────────────
const subState = {
  targetDrugId: null,
  currentLevel: 1,
  currentPage: 1,
  pageSize: 20,
  totalItems: 0,
  selectedIds: new Set(),
  filters: { drug_class: '', dosage_form: '', has_license: '' },
  sort: '',
  order: 'asc',
  atcDepth: 5,
  levelWarnings: {
    1: '依健保分類分組產生，請確認適應症、給付條件與院內供應狀態。',
    2: '含量規格不同，使用前請確認劑量換算與給付條件。',
    3: '劑型不同，請確認給藥途徑、釋放特性與臨床可替代性。',
    4: '不同成分，僅供治療替代參考。請重新評估適應症、劑量、禁忌、交互作用與健保給付條件。',
  },
  levelEmptyMessages: {
    1: { title: '此藥品無健保同分組候選', desc: '在健保資料中，未找到分類分組名稱完全相同的其他市售品項。' },
    2: { title: '此藥品無同劑型異劑量候選', desc: '在健保資料中，未找到相同成分與標準劑型類別、但劑量不同的市售品項。' },
    3: { title: '此藥品無同成分異劑型候選', desc: '在健保資料中，未找到相同成分但劑型類別不同的市售品項。' },
    4: { title: '此 ATC 類別無其他成分候選', desc: '在健保資料中，未找到相同 ATC 廣品理分類下、不同成分的市售品項。' },
  },
};


// ─── DOM refs for Modal ──────────────────────────────────────────
const subModal          = document.getElementById('substituteModal');
const subModalClose     = document.getElementById('subModalClose');
const subTargetInfo     = document.getElementById('subTargetInfo');
const subTabs           = document.getElementById('subTabs');
const subWarningBar     = document.getElementById('subWarningBar');
const subWarningText    = document.getElementById('subWarningText');
const subListLoading    = document.getElementById('subListLoading');
const subListEmpty      = document.getElementById('subListEmpty');
const subTable          = document.getElementById('subTable');
const subTableBody      = document.getElementById('subTableBody');
const subPagination     = document.getElementById('subPagination');
const subPageInfo       = document.getElementById('subPageInfo');
const subPrevPage       = document.getElementById('subPrevPage');
const subNextPage       = document.getElementById('subNextPage');
const subSelectedCount  = document.getElementById('subSelectedCount');
const subGenerateCompare = document.getElementById('subGenerateCompare');
const subClearSelected  = document.getElementById('subClearSelected');
const subCheckAll       = document.getElementById('subCheckAll');
const subFilterClass    = document.getElementById('subFilterClass');
const subFilterForm     = document.getElementById('subFilterForm');
const subFilterLicense  = document.getElementById('subFilterLicense');
const subFilterClear    = document.getElementById('subFilterClear');
const subFilterCount    = document.getElementById('subFilterCount');
const subAtcDepthWrap   = document.getElementById('subAtcDepthWrap');
const subAtcDepth       = document.getElementById('subAtcDepth');
const subEmptyTitle     = document.getElementById('subEmptyTitle');
const subEmptyDesc      = document.getElementById('subEmptyDesc');
const compareModal      = document.getElementById('compareModal');
const compareModalClose = document.getElementById('compareModalClose');
const compareLoading    = document.getElementById('compareLoading');
const compareBody       = document.getElementById('compareBody');

// ─── 開啟 Substitute Modal ───────────────────────────────────────
async function openSubstituteModal(drugId) {
  subState.targetDrugId = drugId;
  subState.currentLevel = 1;
  subState.currentPage  = 1;
  subState.selectedIds  = new Set();
  subState.filters      = { drug_class: '', dosage_form: '', has_license: '' };
  subState.atcDepth     = 5;
  subState.sort         = '';
  subState.order        = 'asc';
  updateSortIcons();
  updateSelectedCount();

  // 重置篩選器
  if (subFilterClass)   subFilterClass.value   = '';
  if (subFilterForm)    subFilterForm.value     = '';
  if (subFilterLicense) subFilterLicense.value  = '';
  if (subAtcDepth)      subAtcDepth.value       = '5';

  // 重置 Tabs
  subTabs.querySelectorAll('.sub-tab').forEach(t => {
    t.classList.toggle('sub-tab--active', parseInt(t.dataset.level) === 1);
    t.setAttribute('aria-selected', String(parseInt(t.dataset.level) === 1));
  });
  [1,2,3,4].forEach(l => {
    const el = document.getElementById(`subCount${l}`);
    if (el) el.textContent = '…';
  });

  // 重置清單
  showSubListState('loading');
  subModal.hidden = false;
  document.body.style.overflow = 'hidden';
  updateWarningBar();

  // 取得摘要數量
  try {
    const summaryParams = new URLSearchParams({ drug_id: drugId, atc_depth: subState.atcDepth });
    const summaryRes = await fetch(`${API_BASE}/substitutes/summary?${summaryParams}`);
    const summary    = await summaryRes.json();
    if (!summaryRes.ok) throw new Error(summary.error || '摘要載入失敗');

    // 顯示原藥品資訊
    const t = summary.target || {};
    subTargetInfo.innerHTML = `
      <div class="sub-target-name-en">${esc(t['藥品英文名稱'] || t['藥品代號'] || '—')}</div>
      <div class="sub-target-name-zh">${esc(t['藥品中文名稱'] || '')}</div>
      <div class="sub-target-meta">
        ${t['成分']         ? `<span class="badge badge-blue">${esc(trunc(t['成分'], 30))}</span>` : ''}
        ${t['劑型']         ? `<span class="badge badge-green">${esc(t['劑型'])}</span>` : ''}
        ${t['分類分組名稱'] ? `<span class="badge badge-gray">${esc(trunc(t['分類分組名稱'], 30))}</span>` : ''}
        ${t['ATC代碼']      ? `<span class="badge badge-gray">ATC: ${esc(t['ATC代碼'])}</span>` : ''}
      </div>
    `;

    // 填入各 Level 數量
    const lvls = summary.levels || {};
    [1,2,3,4].forEach(l => {
      const el = document.getElementById(`subCount${l}`);
      if (el) el.textContent = (lvls[`level${l}`]?.count ?? 0).toLocaleString();
    });

    // 載入 Level 1 清單
    await loadSubList();

  } catch (err) {
    showToast('載入候選摘要失敗：' + err.message, 'error');
    showSubListState('empty');
  }
}

// ─── 載入候選清單 ────────────────────────────────────────────────
async function loadSubList() {
  showSubListState('loading');
  const params = new URLSearchParams({
    drug_id:  subState.targetDrugId,
    level:    subState.currentLevel,
    page:     subState.currentPage,
    pageSize: subState.pageSize,
  });
  // Level 4 傳入 ATC 深度
  if (subState.currentLevel === 4) params.set('atc_depth', subState.atcDepth);
  if (subState.filters.drug_class)  params.set('drug_class',  subState.filters.drug_class);
  if (subState.filters.dosage_form) params.set('dosage_form', subState.filters.dosage_form);
  if (subState.filters.has_license !== '') params.set('has_license', subState.filters.has_license);
  if (subState.sort)  params.set('sort',  subState.sort);
  if (subState.order) params.set('order', subState.order);

  try {
    const res  = await fetch(`${API_BASE}/substitutes?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '清單載入失敗');

    subState.totalItems = data.total || 0;

    if (!data.items || data.items.length === 0) {
      showSubListState('empty');
      subFilterCount.textContent = '';
      return;
    }

    renderSubList(data.items);
    updateSubPagination(data.total, data.page, data.pageSize);
    subFilterCount.textContent = `共 ${data.total.toLocaleString()} 筆`;
    showSubListState('table');
    
    // 更新篩選器選單
    if (data.filters) populateFilterDropdowns(data.filters);

  } catch (err) {
    showToast('載入候選清單失敗：' + err.message, 'error');
    showSubListState('empty');
  }
}

// ─── 渲染候選清單 ────────────────────────────────────────────────
function renderSubList(items) {
  subTableBody.innerHTML = '';
  const frag = document.createDocumentFragment();

  items.forEach(drug => {
    const code = drug['藥品代號'] || '';
    const isChecked = subState.selectedIds.has(code);
    const hasLic = !!(drug['許可證字號']);
    const hasReim = !!(drug['給付規定章節連結']);

    const tr = document.createElement('tr');
    if (isChecked) tr.classList.add('sub-row--selected');
    tr.innerHTML = `
      <td class="sub-td-check">
        <input type="checkbox" class="sub-row-check" data-code="${esc(code)}" ${isChecked ? 'checked' : ''}
          ${subState.selectedIds.size >= 5 && !isChecked ? 'disabled' : ''}>
      </td>
      <td><code class="sub-code">${esc(code)}</code></td>
      <td>
        <div class="sub-name-en">${esc(trunc(drug['藥品英文名稱'] || '—', 30))}</div>
        <div class="sub-name-zh">${esc(drug['藥品中文名稱'] || '')}</div>
      </td>
      <td class="sub-td-wrap" title="${esc(drug['成分'] || '')}">${esc(trunc(drug['成分'] || '—', 28))}</td>
      <td>${drug['劑型'] ? `<span class="badge badge-blue">${esc(drug['劑型'])}</span>` : '—'}</td>
      <td>${esc((drug['規格量'] || '') + ' ' + (drug['規格單位'] || ''))}</td>
      <td>${esc(drug['藥品分類'] || '—')}</td>
      <td><code>${esc(drug['ATC代碼'] || '—')}</code></td>
      <td>${hasLic
        ? `<span class="badge badge-green sub-lic" title="${esc(drug['許可證字號'])}">有</span>`
        : '<span class="badge badge-gray">無</span>'}</td>
      <td>${hasReim
        ? `<a href="${esc(drug['給付規定章節連結'].split(',')[0].trim())}" target="_blank" rel="noopener" class="sub-link">查看 ${svgExternalLink()}</a>`
        : '—'}</td>
    `;

    tr.querySelector('.sub-row-check').addEventListener('change', e => {
      toggleSubSelection(code, e.target.checked, tr);
    });

    frag.appendChild(tr);
  });

  subTableBody.appendChild(frag);
  // 同步全選 checkbox 狀態
  subCheckAll.checked = items.length > 0 && items.every(d => subState.selectedIds.has(d['藥品代號'] || ''));
  subCheckAll.indeterminate = !subCheckAll.checked && items.some(d => subState.selectedIds.has(d['藥品代號'] || ''));
}

// ─── 勾選管理 ───────────────────────────────────────────────────
function toggleSubSelection(code, checked, tr) {
  if (checked) {
    if (subState.selectedIds.size >= 5) {
      showToast('比較品項過多會降低判讀效率，最多選擇 5 個品項進行比較。', 'error');
      // 取消這次勾選
      tr.querySelector('.sub-row-check').checked = false;
      return;
    }
    subState.selectedIds.add(code);
    tr.classList.add('sub-row--selected');
  } else {
    subState.selectedIds.delete(code);
    tr.classList.remove('sub-row--selected');
  }
  updateSelectedCount();
  // 重新渲染以更新 disabled 狀態
  const rows = subTableBody.querySelectorAll('.sub-row-check');
  rows.forEach(cb => {
    if (!cb.checked) cb.disabled = subState.selectedIds.size >= 5;
  });
}

function updateSelectedCount() {
  const count = subState.selectedIds.size;
  subSelectedCount.textContent = count;
  subGenerateCompare.disabled = count < 2;
}

// ─── 分頁控制 ────────────────────────────────────────────────────
function updateSubPagination(total, page, pageSize) {
  const totalPages = Math.ceil(total / pageSize);
  subPagination.hidden = totalPages <= 1;
  subPageInfo.textContent = `第 ${page} / ${totalPages} 頁`;
  subPrevPage.disabled = page <= 1;
  subNextPage.disabled = page >= totalPages;
}

// ─── 警示列 ─────────────────────────────────────────────────────
function updateWarningBar() {
  const isL4 = subState.currentLevel === 4;
  const warning = subState.levelWarnings[subState.currentLevel] || '';
  subWarningText.textContent = warning;
  subWarningBar.className = `sub-warning-bar ${isL4 ? 'sub-warning-bar--l4' : ''}`;
  // L4 專屬：顯示/隱藏 ATC 深度選擇器
  if (subAtcDepthWrap) subAtcDepthWrap.hidden = !isL4;
  // 更新 L4 Tab 的標籤，反映目前選擇的碼數
  const l4Tab = subTabs.querySelector('[data-level="4"] .sub-tab-label');
  if (l4Tab) l4Tab.innerHTML = `同ATC<b>${subState.atcDepth}</b>碼類別`;
}

// ─── 顯示狀態 ───────────────────────────────────────────────────
function showSubListState(state) {
  subListLoading.hidden = state !== 'loading';
  subListEmpty.hidden   = state !== 'empty';
  subTable.hidden       = state !== 'table';
  subPagination.hidden  = state !== 'table';
  if (state === 'empty') {
    const msg = subState.levelEmptyMessages[subState.currentLevel];
    if (msg) {
      if (subEmptyTitle) subEmptyTitle.textContent = msg.title;
      if (subEmptyDesc)  subEmptyDesc.textContent  = msg.desc;
    }
  }
}

// ─── 排序圖示更新 ────────────────────────────────────────────────
function updateSortIcons() {
  document.querySelectorAll('.sub-sort-icon').forEach(el => {
    const col = el.dataset.col;
    if (col === subState.sort) {
      el.textContent = subState.order === 'asc' ? ' ▲' : ' ▼';
    } else {
      el.textContent = ' ▵';
    }
  });
}

// ─── 動態填入篩選器選項 ──────────────────────────────────────────
function populateFilterDropdowns(filters) {
  if (subFilterClass && filters.drug_classes) {
    const currentVal = subFilterClass.value;
    subFilterClass.innerHTML = '<option value="">全部藥品分類</option>';
    filters.drug_classes.forEach(cls => {
      const opt = document.createElement('option');
      opt.value = cls;
      opt.textContent = cls;
      if (cls === currentVal) opt.selected = true;
      subFilterClass.appendChild(opt);
    });
  }
  if (subFilterForm && filters.dosage_forms) {
    const currentVal = subFilterForm.value;
    subFilterForm.innerHTML = '<option value="">全部劑型</option>';
    filters.dosage_forms.forEach(form => {
      const opt = document.createElement('option');
      opt.value = form;
      opt.textContent = form;
      if (form === currentVal) opt.selected = true;
      subFilterForm.appendChild(opt);
    });
  }
}

// ─── 比較表產生 ──────────────────────────────────────────────────
async function generateCompareTable() {
  if (subState.selectedIds.size < 2) return;
  compareLoading.hidden = false;
  compareBody.hidden    = true;
  subModal.hidden       = true;
  compareModal.hidden   = false;

  const candidateIds = [...subState.selectedIds].join(',');
  const url = `${API_BASE}/substitutes/compare?target_id=${encodeURIComponent(subState.targetDrugId)}&candidate_ids=${encodeURIComponent(candidateIds)}`;

  try {
    const res  = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '比較表產生失敗');
    renderCompareTable(data.target, data.candidates);
    compareLoading.hidden = true;
    compareBody.hidden    = false;
  } catch (err) {
    showToast('產生比較表失敗：' + err.message, 'error');
    compareModal.hidden = true;
    subModal.hidden     = false;
  }
}

// ─── 比較表渲染 ──────────────────────────────────────────────────
const LEVEL_COLORS = { 0: '', 1: 'sub-level-1', 2: 'sub-level-2', 3: 'sub-level-3', 4: 'sub-level-4' };

function renderCompareTable(target, candidates) {
  const all = [target, ...candidates];
  const FIELDS = [
    ['替代層級', d => d.level === 0 ? '<span class="badge badge-gray">目標原藥</span>' : `<span class="badge ${LEVEL_COLORS[d.level] || ''}">${esc(d.level_label || '')}</span>`],
    ['替代理由', d => esc(d.reason || '—')],
    ['系統提醒', d => d.warning ? `<span class="compare-warning-cell">${esc(d.warning)}</span>` : '—'],
    ['藥品代號', d => `<code>${esc(d['藥品代號'] || '—')}</code>`],
    ['藥品英文名稱', d => esc(d['藥品英文名稱'] || '—')],
    ['藥品中文名稱', d => esc(d['藥品中文名稱'] || '—')],
    ['成分', d => `<span title="${esc(d['成分'] || '')}">${esc(trunc(d['成分'] || '—', 40))}</span>`],
    ['劑型', d => d['劑型'] ? `<span class="badge badge-blue">${esc(d['劑型'])}</span>` : '—'],
    ['規格', d => esc((d['規格量'] || '') + ' ' + (d['規格單位'] || ''))],
    ['分類分組名稱', d => `<span title="${esc(d['分類分組名稱'] || '')}">${esc(trunc(d['分類分組名稱'] || '—', 35))}</span>`],
    ['藥品分類', d => esc(d['藥品分類'] || '—')],
    ['ATC代碼', d => `<code>${esc(d['ATC代碼'] || '—')}</code>`],
    ['許可證字號', d => esc(d['許可證字號'] || '—')],
    ['健保給付規範', d => {
      const url = (d['給付規定章節連結'] || '').split(',')[0].trim();
      return url ? `<a href="${esc(url)}" target="_blank" rel="noopener" class="sub-link">查看 ${svgExternalLink()}</a>` : '—';
    }],
  ];

  const colHeaders = all.map((d, i) => {
    const cls = i === 0 ? 'compare-th-target' : LEVEL_COLORS[d.level] || '';
    return `<th class="${cls}">${esc(trunc(d['藥品英文名稱'] || d['藥品代號'] || '—', 20))}</th>`;
  }).join('');

  const rows = FIELDS.map(([label, fn]) => {
    const cells = all.map((d, i) => {
      const cls = i === 0 ? 'compare-td-target' : '';
      return `<td class="${cls}">${fn(d)}</td>`;
    }).join('');
    return `<tr><th class="compare-row-label">${label}</th>${cells}</tr>`;
  }).join('');

  compareBody.innerHTML = `
    <div class="compare-scroll-hint">← 橫向捲動查看全部欄位 →</div>
    <div class="compare-table-wrap">
      <table class="compare-table">
        <thead><tr><th class="compare-corner"></th>${colHeaders}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${candidates.some(c => c.level === 4) ? `
      <div class="compare-l4-notice">
        ⚠️ 比較表中含有「同ATC類別候選」（橘色標記欄位），為不同成分之藥品，僅供治療替代方向參考，不代表可直接替代。
      </div>` : ''}
  `;
}

// ─── Modal 事件綁定 ──────────────────────────────────────────────
(function initSubstituteFeature() {
  // Tab 切換
  subTabs.addEventListener('click', async e => {
    const tab = e.target.closest('.sub-tab');
    if (!tab) return;
    const level = parseInt(tab.dataset.level);
    subState.currentLevel = level;
    subState.currentPage  = 1;
    subState.sort         = '';  // Tab 切換時重置排序
    subState.order        = 'asc';
    updateSortIcons();
    subTabs.querySelectorAll('.sub-tab').forEach(t => {
      t.classList.toggle('sub-tab--active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    });
    updateWarningBar();
    await loadSubList();
  });

  // ATC 深度切換（Level 4 專屬）
  if (subAtcDepth) {
    subAtcDepth.addEventListener('change', async () => {
      subState.atcDepth = parseInt(subAtcDepth.value);
      subState.currentPage = 1;
      updateWarningBar();
      // 重新撤回摘要數量（L4 count 可能變小）
      const summaryParams = new URLSearchParams({ drug_id: subState.targetDrugId, atc_depth: subState.atcDepth });
      const summaryRes = await fetch(`${API_BASE}/substitutes/summary?${summaryParams}`).catch(() => null);
      if (summaryRes?.ok) {
        const summary = await summaryRes.json();
        const el = document.getElementById('subCount4');
        if (el) el.textContent = (summary.levels?.level4?.count ?? 0).toLocaleString();
      }
      await loadSubList();
    });
  }

  // 分頁按鈕
  subPrevPage.addEventListener('click', async () => {
    if (subState.currentPage > 1) { subState.currentPage--; await loadSubList(); }
  });
  subNextPage.addEventListener('click', async () => {
    const totalPages = Math.ceil(subState.totalItems / subState.pageSize);
    if (subState.currentPage < totalPages) { subState.currentPage++; await loadSubList(); }
  });

  // 全選
  subCheckAll.addEventListener('change', () => {
    subTableBody.querySelectorAll('.sub-row-check').forEach(cb => {
      const code = cb.dataset.code;
      if (subCheckAll.checked) {
        if (!subState.selectedIds.has(code) && subState.selectedIds.size < 5) {
          subState.selectedIds.add(code);
          cb.closest('tr').classList.add('sub-row--selected');
        }
      } else {
        subState.selectedIds.delete(code);
        cb.closest('tr').classList.remove('sub-row--selected');
      }
      cb.checked = subState.selectedIds.has(code);
    });
    updateSelectedCount();
  });

  // 篩選
  [subFilterClass, subFilterForm, subFilterLicense].forEach(sel => {
    if (!sel) return;
    sel.addEventListener('change', async () => {
      subState.filters.drug_class  = subFilterClass.value;
      subState.filters.dosage_form = subFilterForm.value;
      subState.filters.has_license = subFilterLicense.value;
      subState.currentPage = 1;
      await loadSubList();
    });
  });

  if (subFilterClear) {
    subFilterClear.addEventListener('click', async () => {
      subFilterClass.value   = '';
      subFilterForm.value    = '';
      subFilterLicense.value = '';
      subState.filters = { drug_class: '', dosage_form: '', has_license: '' };
      subState.currentPage   = 1;
      await loadSubList();
    });
  }

  // 表頭排序
  document.getElementById('subTable')?.addEventListener('click', async e => {
    const th = e.target.closest('.sub-th-sort');
    if (!th) return;
    const col = th.dataset.sort;
    if (!col) return;
    if (subState.sort === col) {
      subState.order = subState.order === 'asc' ? 'desc' : 'asc';
    } else {
      subState.sort  = col;
      subState.order = 'asc';
    }
    subState.currentPage = 1;
    updateSortIcons();
    await loadSubList();
  });

  // 清除勾選
  subClearSelected.addEventListener('click', () => {
    subState.selectedIds.clear();
    updateSelectedCount();
    subTableBody.querySelectorAll('.sub-row-check').forEach(cb => {
      cb.checked = false;
      cb.disabled = false;
      cb.closest('tr').classList.remove('sub-row--selected');
    });
    subCheckAll.checked = false;
  });

  // 產生比較表
  subGenerateCompare.addEventListener('click', generateCompareTable);

  // 關閉 Substitute Modal
  subModalClose.addEventListener('click', () => {
    subModal.hidden = true;
    document.body.style.overflow = '';
  });
  subModal.addEventListener('click', e => {
    if (e.target === subModal) { subModal.hidden = true; document.body.style.overflow = ''; }
  });

  // 關閉 Compare Modal
  compareModalClose.addEventListener('click', () => {
    compareModal.hidden = true;
    subModal.hidden     = false;
  });
  compareModal.addEventListener('click', e => {
    if (e.target === compareModal) { compareModal.hidden = true; subModal.hidden = false; }
  });

  // ESC 關閉
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!compareModal.hidden) { compareModal.hidden = true; subModal.hidden = false; }
    else if (!subModal.hidden) { subModal.hidden = true; document.body.style.overflow = ''; }
  });
})();


