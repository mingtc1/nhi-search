/**
 * GET /api/substitutes?drug_id=XXXX&level=1&page=1&pageSize=20&atc_depth=5
 *
 * ── Level 定義（以分類分組名稱解析為核心）─────────────────────────
 *
 * 健保「分類分組名稱」格式：「成分 , 標準化劑型 , 劑量」 (逗號與空格可能混用，如半形或全形逗號)
 * 例：DIAZEPAM , 一般錠劑膠囊劑 , 5.00 MG
 *
 * L1: 分類分組名稱完全相同（同成分＋同標準化劑型＋同劑量）
 * L2: 成分＋標準化劑型相同，但劑量不同（LIKE '成分%' AND LIKE '%劑型%'，排除 L1）
 * L3: 成分相同，標準化劑型不同（LIKE '成分%' AND NOT LIKE '%劑型%'）
 * L4: ATC 前 N 碼相同但 7 碼不同（不同成分，同藥理類別）
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

const LEVEL_META = {
  1: {
    label:   '健保同分組候選',
    reason:  '分類分組名稱完全相同（健保官方同組）',
    warning: '依健保分類分組產生，請確認適應症、給付條件與院內供應狀態。',
  },
  2: {
    label:   '同成分同劑型異劑量候選',
    reason:  '分類分組成分與標準化劑型相同，劑量不同',
    warning: '含量規格不同，使用前請確認劑量換算與給付條件。',
  },
  3: {
    label:   '同成分異劑型候選',
    reason:  '分類分組成分相同，但標準化劑型不同',
    warning: '劑型不同，請確認給藥途徑、釋放特性與臨床可替代性。',
  },
  4: {
    label:   '同ATC類別候選',
    reason:  '同ATC藥理分類，不同活性成分',
    warning: '不同成分，僅供治療替代參考。請重新評估適應症、劑量、禁忌、交互作用與健保給付條件。',
  },
};

const VALID_SORT    = ['藥品代號', '藥品中文名稱', '成分', '劑型', '規格量', 'ATC代碼', '支付價', '藥品分類', '藥商'];
const DEFAULT_PAGE  = 20;
const MAX_PAGE_SIZE = 100;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

/** 轉義 LIKE 查詢中的特殊字元（%, _, \） */
function escapeLike(str) {
  return str.replace(/[\\%_]/g, '\\$&');
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const { searchParams } = new URL(request.url);

  const drug_id   = (searchParams.get('drug_id') || '').trim();
  const level     = parseInt(searchParams.get('level') || '0');
  const page      = Math.max(1, parseInt(searchParams.get('page') || '1'));
  const pageSize  = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(searchParams.get('pageSize') || `${DEFAULT_PAGE}`)));
  const offset    = (page - 1) * pageSize;
  const atc_depth = Math.min(5, Math.max(3, parseInt(searchParams.get('atc_depth') || '5')));

  // 篩選
  const drug_class    = searchParams.get('drug_class') || '';
  const dosage_form   = searchParams.get('dosage_form') || '';
  const manufacturer  = searchParams.get('manufacturer') || '';
  const has_license   = searchParams.get('has_license');
  const has_reimburse = searchParams.get('has_reimbursement');

  // 排序
  const sortField = VALID_SORT.includes(searchParams.get('sort') || '') ? searchParams.get('sort') : '';
  const sortOrder = (searchParams.get('order') || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  if (!drug_id) return json({ error: '缺少必要參數 drug_id' }, 400);
  if (![1, 2, 3, 4].includes(level)) return json({ error: 'level 必須為 1~4' }, 400);

  try {
    // ── 取得原藥品資料 ────────────────────────────────────────────
    const target = await env.DB.prepare(
      `SELECT * FROM nhi_drugs WHERE "藥品代號" = ? LIMIT 1`
    ).bind(drug_id).first();

    if (!target) return json({ error: `找不到藥品代號 ${drug_id}` }, 404);

    const groupName = target['分類分組名稱'] || '';
    const atc       = (target['ATC代碼'] || '').trim();
    const atcFull   = atc;
    const atcPrefix = atc.slice(0, atc_depth);

    // ── 解析分類分組名稱結構 ──────────────────────────────────
    const groupParts      = groupName.split(/[，,]/).map(s => s.trim());
    const groupIngredient = groupParts[0] || '';
    const groupStdForm    = groupParts.length >= 2 ? groupParts[1] : '';

    // ── 建構各 Level 的核心 WHERE 條件 ────────────────────────────
    let coreWhere = '';
    const coreParams = [];

    if (level === 1) {
      if (!groupName) {
        return json({ level, page, pageSize, total: 0, items: [],
          warning: '原藥品無分類分組名稱資料，無法搜尋 Level 1 候選' });
      }
      coreWhere = `"分類分組名稱" = ? AND "藥品代號" != ?`;
      coreParams.push(groupName, drug_id);

    } else if (level === 2) {
      if (!groupIngredient || !groupStdForm) {
        return json({ level, page, pageSize, total: 0, items: [],
          warning: '原藥品分類分組名稱格式不符（需含成分與標準化劑型），無法搜尋 Level 2' });
      }
      // LIKE '成分%' AND LIKE '%劑型%' 且排除 L1
      coreWhere = `"分類分組名稱" LIKE ? ESCAPE '\\' AND "分類分組名稱" LIKE ? ESCAPE '\\' AND "分類分組名稱" != ? AND "藥品代號" != ?`;
      coreParams.push(`${escapeLike(groupIngredient)}%`, `%${escapeLike(groupStdForm)}%`, groupName, drug_id);

    } else if (level === 3) {
      if (!groupIngredient) {
        return json({ level, page, pageSize, total: 0, items: [],
          warning: '原藥品分類分組名稱格式不符（需含成分），無法搜尋 Level 3' });
      }
      // LIKE '成分%' AND NOT LIKE '%劑型%'
      coreWhere = `"分類分組名稱" LIKE ? ESCAPE '\\' AND "分類分組名稱" NOT LIKE ? ESCAPE '\\' AND "藥品代號" != ?`;
      coreParams.push(`${escapeLike(groupIngredient)}%`, `%${escapeLike(groupStdForm)}%`, drug_id);

    } else if (level === 4) {
      if (!atcPrefix) {
        return json({ level, page, pageSize, total: 0, items: [],
          warning: '原藥品無 ATC 代碼資料，無法搜尋 Level 4 候選' });
      }
      // ATC 前 N 碼相同但 7 碼不同（不同成分）
      coreWhere = `"ATC代碼" LIKE ? AND "ATC代碼" != ? AND "藥品代號" != ?`;
      coreParams.push(`${atcPrefix}%`, atcFull, drug_id);
    }

    // ── 附加篩選條件 ─────────────────────────────────────────────
    const filterClauses = [];
    const filterParams  = [];

    if (drug_class) { filterClauses.push(`"藥品分類" = ?`); filterParams.push(drug_class); }
    if (dosage_form) { filterClauses.push(`"劑型" = ?`); filterParams.push(dosage_form); }
    if (manufacturer) { filterClauses.push(`"藥商" = ?`); filterParams.push(manufacturer); }
    if (has_license === '1') filterClauses.push(`("許可證字號" IS NOT NULL AND "許可證字號" != '')`);
    else if (has_license === '0') filterClauses.push(`("許可證字號" IS NULL OR "許可證字號" = '')`);
    if (has_reimburse === '1') filterClauses.push(`("給付規定章節連結" IS NOT NULL AND "給付規定章節連結" != '')`);
    else if (has_reimburse === '0') filterClauses.push(`("給付規定章節連結" IS NULL OR "給付規定章節連結" = '')`);

    const allWhere  = [coreWhere, ...filterClauses].filter(Boolean).join(' AND ');
    const allParams = [...coreParams, ...filterParams];

    // ── 排序 ─────────────────────────────────────────────────────
    let orderClause = `ORDER BY "藥品代號" ASC`;
    if (sortField) {
      if (sortField === '支付價' || sortField === '規格量') {
        orderClause = `ORDER BY CAST("${sortField}" AS REAL) ${sortOrder}, "藥品代號" ASC`;
      } else {
        orderClause = `ORDER BY "${sortField}" ${sortOrder}, "藥品代號" ASC`;
      }
    }

    // ── 同時查詢總數與資料 ───────────────────────────────────────
    const [countRow, dataRows] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) AS total FROM nhi_drugs WHERE ${allWhere}`)
            .bind(...allParams).first(),
      env.DB.prepare(`SELECT * FROM nhi_drugs WHERE ${allWhere} ${orderClause} LIMIT ? OFFSET ?`)
            .bind(...allParams, pageSize, offset).all(),
    ]);

    const total = countRow?.total ?? 0;
    const meta  = { ...LEVEL_META[level] };
    if (level === 4) {
      meta.label  = `同ATC${atc_depth}碼類別候選`;
      meta.reason = `ATC 前 ${atc_depth} 碼（${atcPrefix}）相同，活性成分不同`;
    }

    const items = (dataRows.results || []).map(row => ({
      ...row,
      level,
      level_label: meta.label,
      reason:      meta.reason,
      warning:     meta.warning,
    }));

    // ── 從結果集中取得篩選器可用選項 ──────────────────────────────
    // 只在第一頁且無篩選時回傳（避免每次都多一次 query）
    let filtersData = undefined;
    if (page === 1 && !drug_class && !dosage_form && !manufacturer) {
      const [classRows, formRows, manufacturerRows] = await Promise.all([
        env.DB.prepare(`SELECT DISTINCT "藥品分類" FROM nhi_drugs WHERE ${coreWhere} AND "藥品分類" IS NOT NULL AND "藥品分類" != '' ORDER BY "藥品分類"`)
              .bind(...coreParams).all(),
        env.DB.prepare(`SELECT DISTINCT "劑型" FROM nhi_drugs WHERE ${coreWhere} AND "劑型" IS NOT NULL AND "劑型" != '' ORDER BY "劑型"`)
              .bind(...coreParams).all(),
        env.DB.prepare(`SELECT DISTINCT "藥商" FROM nhi_drugs WHERE ${coreWhere} AND "藥商" IS NOT NULL AND "藥商" != '' ORDER BY "藥商"`)
              .bind(...coreParams).all(),
      ]);
      filtersData = {
        drug_classes:  (classRows.results || []).map(r => r['藥品分類']),
        dosage_forms:  (formRows.results  || []).map(r => r['劑型']),
        manufacturers: (manufacturerRows.results || []).map(r => r['藥商']),
      };
    }

    return json({
      level,
      page,
      pageSize,
      total,
      has_more:   offset + items.length < total,
      items,
      level_meta: meta,
      atc_depth:  level === 4 ? atc_depth : undefined,
      filters:    filtersData,
    });


  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
