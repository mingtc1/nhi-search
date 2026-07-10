/**
 * GET /api/substitutes?drug_id=XXXX&level=1&page=1&pageSize=20&atc_depth=5
 *
 * ── Level 定義（不重複設計）──────────────────────────────────────
 * L1: 同「分類分組名稱」
 * L2: 同成分 + 同劑型 + 不同規格量，排除 L1
 * L3: 同成分 + 不同劑型，排除 L1
 * L4: 同 ATC 前 N 碼（預設5，可選3~5）+ 不同成分，排除 L1
 *
 * 支援其他參數：
 *   page, pageSize, drug_class, dosage_form, has_license,
 *   has_reimbursement, sort, order, atc_depth（L4 專用，預設5）
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
};

const LEVEL_META = {
  1: {
    label: '健保同分組候選',
    reason: '分類分組名稱相同（健保官方同組）',
    warning: '依健保分類分組產生，請確認適應症、給付條件與院內供應狀態。',
  },
  2: {
    label: '同成分同劑型異劑量候選',
    reason: '成分與劑型相同，但規格量不同',
    warning: '含量規格不同，使用前請確認劑量換算與給付條件。',
  },
  3: {
    label: '同成分異劑型候選',
    reason: '成分相同，但劑型不同',
    warning: '劑型不同，請確認給藥途徑、釋放特性與臨床可替代性。',
  },
  4: {
    label: '同ATC類別候選',
    reason: '同ATC藥理分類，不同成分',
    warning: '不同成分，僅供治療替代參考。請重新評估適應症、劑量、禁忌、交互作用與健保給付條件。',
  },
};

const VALID_SORT = ['藥品代號', '藥品中文名稱', '成分', '劑型', '規格量', 'ATC代碼', '支付價', '藥品分類'];
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

/** 將排除 L1 的條件抽成通用 SQL 片段 */
function excludeL1Clause() {
  return `("分類分組名稱" IS NULL OR "分類分組名稱" = '' OR "分類分組名稱" != ?)`;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const { searchParams } = new URL(request.url);

  const drug_id    = (searchParams.get('drug_id') || '').trim();
  const level      = parseInt(searchParams.get('level') || '0');
  const page       = Math.max(1, parseInt(searchParams.get('page') || '1'));
  const pageSize   = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(searchParams.get('pageSize') || `${DEFAULT_PAGE_SIZE}`)));
  const offset     = (page - 1) * pageSize;
  const atc_depth  = Math.min(5, Math.max(3, parseInt(searchParams.get('atc_depth') || '5')));

  // 篩選參數
  const drug_class    = searchParams.get('drug_class') || '';
  const dosage_form   = searchParams.get('dosage_form') || '';
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

    const groupName  = target['分類分組名稱'] || '';
    const ingredient = target['成分'] || '';
    const form       = target['劑型'] || '';
    const dosage     = target['規格量'] || '';
    const atc        = target['ATC代碼'] || '';
    const atcPrefix  = atc.slice(0, atc_depth);

    // ── 建構各 Level 的核心 WHERE 條件 ────────────────────────────
    let coreWhere = '';
    const coreParams = [];

    if (level === 1) {
      // L1: 同分類分組名稱（排除自身）
      if (!groupName) {
        return json({
          level, page, pageSize, total: 0, items: [],
          warning: '原藥品無分類分組名稱資料，無法搜尋 Level 1 候選',
        });
      }
      coreWhere = `"分類分組名稱" = ? AND "藥品代號" != ?`;
      coreParams.push(groupName, drug_id);

    } else if (level === 2) {
      // L2: 同成分 + 同劑型 + 不同規格量，排除 L1
      if (!ingredient || !form) {
        return json({ level, page, pageSize, total: 0, items: [], warning: '原藥品缺少成分或劑型資料' });
      }
      coreWhere = `"成分" = ? AND "劑型" = ? AND "規格量" != ? AND "藥品代號" != ? AND ${excludeL1Clause()}`;
      coreParams.push(ingredient, form, dosage, drug_id, groupName);

    } else if (level === 3) {
      // L3: 同成分 + 不同劑型，排除 L1
      if (!ingredient) {
        return json({ level, page, pageSize, total: 0, items: [], warning: '原藥品缺少成分資料' });
      }
      coreWhere = `"成分" = ? AND "劑型" != ? AND "藥品代號" != ? AND ${excludeL1Clause()}`;
      coreParams.push(ingredient, form, drug_id, groupName);

    } else if (level === 4) {
      // L4: 同 ATC 前 N 碼 + 不同成分，排除 L1
      if (!atcPrefix) {
        return json({
          level, page, pageSize, total: 0, items: [],
          warning: '原藥品無 ATC 代碼資料，無法搜尋 Level 4 候選',
        });
      }
      coreWhere = `"ATC代碼" LIKE ? AND "成分" != ? AND "藥品代號" != ? AND ${excludeL1Clause()}`;
      coreParams.push(`${atcPrefix}%`, ingredient, drug_id, groupName);
    }

    // ── 附加篩選條件 ─────────────────────────────────────────────
    const filterClauses = [];
    const filterParams  = [];

    if (drug_class) {
      filterClauses.push(`"藥品分類" = ?`);
      filterParams.push(drug_class);
    }
    if (dosage_form) {
      filterClauses.push(`"劑型" = ?`);
      filterParams.push(dosage_form);
    }
    if (has_license === '1') {
      filterClauses.push(`("許可證字號" IS NOT NULL AND "許可證字號" != '')`);
    } else if (has_license === '0') {
      filterClauses.push(`("許可證字號" IS NULL OR "許可證字號" = '')`);
    }
    if (has_reimburse === '1') {
      filterClauses.push(`("給付規定章節連結" IS NOT NULL AND "給付規定章節連結" != '')`);
    } else if (has_reimburse === '0') {
      filterClauses.push(`("給付規定章節連結" IS NULL OR "給付規定章節連結" = '')`);
    }

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
      meta.reason = `ATC 代碼前 ${atc_depth} 碼相同，不同成分`;
    }

    // ── 組裝結果 ─────────────────────────────────────────────────
    const items = (dataRows.results || []).map(row => ({
      ...row,
      level,
      level_label: meta.label,
      reason:      meta.reason,
      warning:     meta.warning,
    }));

    return json({
      level,
      page,
      pageSize,
      total,
      has_more: offset + items.length < total,
      items,
      // 提供回應資訊供前端顯示
      level_meta: meta,
      atc_depth: level === 4 ? atc_depth : undefined,
    });

  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
