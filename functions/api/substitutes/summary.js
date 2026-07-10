/**
 * GET /api/substitutes/summary?drug_id=XXXX
 *
 * 回傳原藥品資料 + 各 Level 候選數量摘要。
 * 前端先呼叫此 API 取得 count，再按需呼叫 /api/substitutes 取得清單。
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const t0 = Date.now();
  const { searchParams } = new URL(request.url);
  const drug_id = (searchParams.get('drug_id') || '').trim();

  if (!drug_id) {
    return json({ error: '缺少必要參數 drug_id' }, 400);
  }

  try {
    // ── 1. 取得原藥品資料 ────────────────────────────────────────
    const target = await env.DB.prepare(
      `SELECT * FROM nhi_drugs WHERE "藥品代號" = ? LIMIT 1`
    ).bind(drug_id).first();

    if (!target) {
      return json({ error: `找不到藥品代號 ${drug_id}` }, 404);
    }

    const groupName  = target['分類分組名稱'] || '';
    const ingredient = target['成分'] || '';
    const form       = target['劑型'] || '';
    const atc        = target['ATC代碼'] || '';
    const atc5       = atc.slice(0, 5);

    // ── 2. 各 Level 候選數量 (排除自身) ─────────────────────────

    // L1: 同分類分組名稱
    const l1Count = groupName
      ? (await env.DB.prepare(
          `SELECT COUNT(*) as c FROM nhi_drugs
           WHERE "分類分組名稱" = ? AND "藥品代號" != ?`
        ).bind(groupName, drug_id).first())?.c ?? 0
      : 0;

    // 取得 L1 的藥品代號集合，供後續層級排除用
    // （用子查詢方式在 SQL 內部排除，避免在 JS 傳遞大量 id）

    // L2: 同成分同劑型，排除 L1
    const l2Count = (ingredient && form)
      ? (await env.DB.prepare(
          `SELECT COUNT(*) as c FROM nhi_drugs
           WHERE "成分" = ? AND "劑型" = ? AND "藥品代號" != ?
           AND ("分類分組名稱" != ? OR "分類分組名稱" IS NULL OR "分類分組名稱" = '')`
        ).bind(ingredient, form, drug_id, groupName).first())?.c ?? 0
      : 0;

    // L3: 同成分不同劑型，排除 L1
    const l3Count = ingredient
      ? (await env.DB.prepare(
          `SELECT COUNT(*) as c FROM nhi_drugs
           WHERE "成分" = ? AND "劑型" != ? AND "藥品代號" != ?
           AND ("分類分組名稱" != ? OR "分類分組名稱" IS NULL OR "分類分組名稱" = '')`
        ).bind(ingredient, form, drug_id, groupName).first())?.c ?? 0
      : 0;

    // L4: 同 ATC 前 5 碼，不同成分，排除 L1/L2/L3
    const l4Count = atc5
      ? (await env.DB.prepare(
          `SELECT COUNT(*) as c FROM nhi_drugs
           WHERE "ATC代碼" LIKE ? AND "成分" != ? AND "藥品代號" != ?
           AND ("分類分組名稱" != ? OR "分類分組名稱" IS NULL OR "分類分組名稱" = '')`
        ).bind(`${atc5}%`, ingredient, drug_id, groupName).first())?.c ?? 0
      : 0;

    const responseMs = Date.now() - t0;

    return json({
      target,
      levels: {
        level1: { count: l1Count,  label: '健保同分組候選',    warning: '依健保分類分組產生，請確認適應症、給付條件與院內供應狀態。' },
        level2: { count: l2Count,  label: '同成分同劑型候選',  warning: '規格或含量可能不同，請確認是否需劑量換算。' },
        level3: { count: l3Count,  label: '同成分不同劑型候選', warning: '劑型不同，請確認給藥途徑、釋放特性與臨床可替代性。' },
        level4: { count: l4Count,  label: '同ATC類別候選',     warning: '不同成分，僅供治療替代參考。請重新評估適應症、劑量、禁忌、交互作用與健保給付條件。' },
      },
      meta: {
        has_group_name: !!groupName,
        has_atc: !!atc,
        api_response_time_ms: responseMs,
      }
    });

  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
