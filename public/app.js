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
      ${d['藥品分類'] ? `<div class="detail-row">
        <span class="detail-row-label">藥品分類</span>
        <span class="field-tag" data-field="藥品分類" data-value="${esc(d['藥品分類'])}">${esc(d['藥品分類'])}${svgPlus()}</span>
      </div>` : ''}
      ${d['分類分組名稱'] ? `<div class="detail-row">
        <span class="detail-row-label">分類分組</span>
        <span class="field-tag" data-field="分類分組名稱" data-value="${esc(d['分類分組名稱'])}">${esc(d['分類分組名稱'])}${svgPlus()}</span>
      </div>` : ''}
      ${d['ATC代碼'] ? `<div class="detail-row">
        <span class="detail-row-label">ATC 代碼</span>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="field-tag" data-field="ATC代碼" data-value="${esc(d['ATC代碼'])}">${esc(d['ATC代碼'])}${svgPlus()}</span>
          <a class="btn-action btn-action--ext" href="https://atcddd.fhi.no/atc_ddd_index/?code=${encodeURIComponent(d['ATC代碼'])}&showdescription=no" target="_blank" rel="noopener">
            ${svgExternalLink()} ATC 分類查詢
          </a>
        </div>
      </div>` : ''}
    </div>

    <!-- 有效期間 (緊湊 inline) -->
    ${start || end ? `<div class="detail-section detail-section--compact">
      <span class="detail-inline-label">有效期間</span>
      <span class="detail-inline-value">${esc(formatDateYYY(start)) || '—'} → ${esc(formatDateYYY(end)) || '持續有效'}</span>
    </div>` : ''}

    <!-- 廠商與許可 -->
    <div class="detail-section">
      <div class="detail-section-title">廠商與許可</div>
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
  try {
    const res = await fetch(
      `https://epi.mingtc.com/api/v1/labels?licenseNo=${encodeURIComponent(licNo)}&sec=indication&format=json`
    );
    const data = await res.json();
    if (!data.success) throw new Error(data.error?.message || '查無資料');

    const text = data.data?.sections?.indication?.text || '';
    el.className = '';
    if (text) {
      // 去掉行首數字標號（如 1. 2. (1) 等），並過濾空行
      const cleaned = text
        .split('\n')
        .map(line => line.replace(/^\s*(\d+[.)、]|[（(]\d+[)）])\s*/, '').trim())
        .filter(Boolean)
        .join('\n');
      el.innerHTML = `<div class="epi-block-text">${esc(cleaned)}</div>`;
    } else {
      el.innerHTML = '<p class="epi-none">此藥品無適應症資料</p>';
    }
  } catch (err) {
    el.className = '';
    el.innerHTML = `<p class="epi-none">資料載入失敗：${esc(err.message)}</p>`;
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
