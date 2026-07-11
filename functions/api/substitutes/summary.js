/**
 * GET /api/substitutes/summary?drug_id=XXXX&atc_depth=5
 *
 * ── Level 定義（以分類分組名稱解析為核心）─────────────────────────
 *
 * 健保「分類分組名稱」格式：「成分 , 標準化劑型 , 劑量」 (逗號與空格可能混用，如半形或全形逗號)
 * 例：DIAZEPAM , 一般錠劑膠囊劑 , 5.00 MG
 *
 * L1: 分類分組名稱完全相同（同成分＋同標準化劑型＋同劑量）
 * L2: 成分＋標準化劑型相同，但劑量不同（排除 L1）
 * L3: 成分相同，標準化劑型不同（排除 L1 與 L2）
 * L4: ATC 前 N 碼相同但 7 碼不同（不同成分，同藥理類別）
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

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
  const t0 = Date.now();
  const { searchParams } = new URL(request.url);
  const drug_id   = (searchParams.get('drug_id') || '').trim();
  const atc_depth = Math.min(5, Math.max(3, parseInt(searchParams.get('atc_depth') || '5')));

  if (!drug_id) return json({ error: '缺少必要參數 drug_id' }, 400);

  try {
    // ── 1. 取得原藥品資料 ────────────────────────────────────────
    const target = await env.DB.prepare(
      `SELECT * FROM nhi_drugs WHERE "藥品代號" = ? LIMIT 1`
    ).bind(drug_id).first();

    if (!target) return json({ error: `找不到藥品代號 ${drug_id}` }, 404);

    const groupName = target['分類分組名稱'] || '';
    const atc       = (target['ATC代碼'] || '').trim();
    const atcFull   = atc;
    const atcPrefix = atc.slice(0, atc_depth);

    // ── 解析分類分組名稱結構 ──────────────────────────────────
    // 支援半形或全形逗號分隔，並自動 trim 除去前後空格
    const groupParts      = groupName.split(/[，,]/).map(s => s.trim());
    const groupIngredient = groupParts[0] || '';
    const groupStdForm    = groupParts.length >= 2 ? groupParts[1] : '';

    // ── 2. 各 Level 候選數量 ────────────────────────────────────
    const [l1Row, l2Row, l3Row, l4Row] = await Promise.all([

      // L1: 分類分組名稱完全相同（排除自身）
      groupName
        ? env.DB.prepare(
            `SELECT COUNT(*) AS c FROM nhi_drugs
             WHERE "分類分組名稱" = ? AND "藥品代號" != ?`
          ).bind(groupName, drug_id).first()
        : Promise.resolve({ c: 0 }),

      // L2: 同成分＋同標準化劑型，不同劑量
      // LIKE '成分%' AND LIKE '%劑型%' 且排除 L1
      (groupIngredient && groupStdForm)
        ? env.DB.prepare(
            `SELECT COUNT(*) AS c FROM nhi_drugs
             WHERE "分類分組名稱" LIKE ? ESCAPE '\\'
               AND "分類分組名稱" LIKE ? ESCAPE '\\'
               AND "分類分組名稱" != ?
               AND "藥品代號" != ?`
          ).bind(`${escapeLike(groupIngredient)}%`, `%${escapeLike(groupStdForm)}%`, groupName, drug_id).first()
        : Promise.resolve({ c: 0 }),

      // L3: 同成分，不同標準化劑型
      // LIKE '成分%' AND NOT LIKE '%劑型%'
      groupIngredient
        ? env.DB.prepare(
            `SELECT COUNT(*) AS c FROM nhi_drugs
             WHERE "分類分組名稱" LIKE ? ESCAPE '\\'
               AND "分類分組名稱" NOT LIKE ? ESCAPE '\\'
               AND "藥品代號" != ?`
          ).bind(`${escapeLike(groupIngredient)}%`, `%${escapeLike(groupStdForm)}%`, drug_id).first()
        : Promise.resolve({ c: 0 }),

      // L4: ATC 前 N 碼相同但 7 碼不同（不同成分，同藥理類別）
      atcPrefix
        ? env.DB.prepare(
            `SELECT COUNT(*) AS c FROM nhi_drugs
             WHERE "ATC代碼" LIKE ?
               AND "ATC代碼" != ?
               AND "藥品代號" != ?`
          ).bind(`${atcPrefix}%`, atcFull, drug_id).first()
        : Promise.resolve({ c: 0 }),
    ]);

    const responseMs = Date.now() - t0;

    return json({
      target,
      levels: {
        level1: {
          count:      l1Row?.c ?? 0,
          label:      '健保同分組候選',
          definition: `分類分組名稱完全相同：${groupName || '（無資料）'}`,
          warning:    '依健保分類分組產生，請確認適應症、給付條件與院內供應狀態。',
        },
        level2: {
          count:      l2Row?.c ?? 0,
          label:      '同成分同劑型異劑量候選',
          definition: (groupIngredient && groupStdForm)
            ? `同成分（${groupIngredient}）與同劑型類別（${groupStdForm}），但規格劑量不同；已排除 Level 1`
            : '（原藥品分類分組名稱格式不符，無法解析）',
          warning:    '含量規格不同，使用前請確認劑量換算與給付條件。',
        },
        level3: {
          count:      l3Row?.c ?? 0,
          label:      '同成分異劑型候選',
          definition: groupIngredient
            ? `同成分（${groupIngredient}），但劑型類別非（${groupStdForm || '—'}）；已排除 Level 1`
            : '（原藥品分類分組名稱格式不符，無法解析）',
          warning:    '劑型不同，請確認給藥途徑、釋放特性與臨床可替代性。',
        },
        level4: {
          count:      l4Row?.c ?? 0,
          label:      `同ATC${atc_depth}碼類別候選`,
          definition: `ATC 前 ${atc_depth} 碼（${atcPrefix || '—'}）相同，但活性成分不同`,
          warning:    '不同成分，僅供治療替代參考。請重新評估適應症、劑量、禁忌、交互作用與健保給付條件。',
          atc_depth,
        },
      },
      meta: {
        has_group_name:    !!groupName,
        group_ingredient:  groupIngredient,
        group_std_form:    groupStdForm,
        has_atc:           !!atc,
        atc_full:          atcFull,
        atc_depth,
        api_response_time_ms: responseMs,
      }
    });

  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
