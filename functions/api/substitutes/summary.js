/**
 * GET /api/substitutes/summary?drug_id=XXXX&atc_depth=5
 *
 * 回傳原藥品資料 + 各 Level 候選數量摘要。
 *
 * ── Level 定義（不重複設計）──────────────────────────────────────
 * L1: 同「分類分組名稱」                    → 健保官方同組（含同成分/劑型/劑量）
 * L2: 同成分 + 同劑型 + 不同規格量            → 相同途徑，不同劑量，排除 L1
 * L3: 同成分 + 不同劑型                      → 成分相同，給藥途徑不同，排除 L1
 * L4: 同 ATC 前 N 碼（預設5，可選3~5）+ 不同成分 → 藥理同類但不同成分
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

/** 將 groupName 排除條件抽成通用片段（排除 L1 品項） */
function excludeL1Clause() {
  return `("分類分組名稱" IS NULL OR "分類分組名稱" = '' OR "分類分組名稱" != ?)`;
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

    const groupName  = target['分類分組名稱'] || '';
    const ingredient = target['成分'] || '';
    const form       = target['劑型'] || '';
    const dosage     = target['規格量'] || '';
    const atc        = target['ATC代碼'] || '';
    const atcPrefix  = atc.slice(0, atc_depth);

    // ── 2. 各 Level 候選數量 ────────────────────────────────────
    const [l1Row, l2Row, l3Row, l4Row] = await Promise.all([

      // L1: 同分類分組名稱（排除自身）
      groupName
        ? env.DB.prepare(
            `SELECT COUNT(*) AS c FROM nhi_drugs
             WHERE "分類分組名稱" = ? AND "藥品代號" != ?`
          ).bind(groupName, drug_id).first()
        : Promise.resolve({ c: 0 }),

      // L2: 同成分 + 同劑型 + 不同規格量，排除 L1
      (ingredient && form)
        ? env.DB.prepare(
            `SELECT COUNT(*) AS c FROM nhi_drugs
             WHERE "成分" = ?
               AND "劑型" = ?
               AND "規格量" != ?
               AND "藥品代號" != ?
               AND ${excludeL1Clause()}`
          ).bind(ingredient, form, dosage, drug_id, groupName).first()
        : Promise.resolve({ c: 0 }),

      // L3: 同成分 + 不同劑型，排除 L1
      ingredient
        ? env.DB.prepare(
            `SELECT COUNT(*) AS c FROM nhi_drugs
             WHERE "成分" = ?
               AND "劑型" != ?
               AND "藥品代號" != ?
               AND ${excludeL1Clause()}`
          ).bind(ingredient, form, drug_id, groupName).first()
        : Promise.resolve({ c: 0 }),

      // L4: 同 ATC 前 N 碼 + 不同成分（排除 L1）
      atcPrefix
        ? env.DB.prepare(
            `SELECT COUNT(*) AS c FROM nhi_drugs
             WHERE "ATC代碼" LIKE ?
               AND "成分" != ?
               AND "藥品代號" != ?
               AND ${excludeL1Clause()}`
          ).bind(`${atcPrefix}%`, ingredient, drug_id, groupName).first()
        : Promise.resolve({ c: 0 }),
    ]);

    const responseMs = Date.now() - t0;

    return json({
      target,
      levels: {
        level1: {
          count: l1Row?.c ?? 0,
          label: '健保同分組候選',
          definition: '同「分類分組名稱」（健保官方同組，通常含同成分、同劑型、同劑量）',
          warning: '依健保分類分組產生，請確認適應症、給付條件與院內供應狀態。',
        },
        level2: {
          count: l2Row?.c ?? 0,
          label: '同成分同劑型異劑量候選',
          definition: '同成分、同劑型，但規格量不同，已排除 Level 1 品項',
          warning: '含量規格不同，使用前請確認劑量換算與給付條件。',
        },
        level3: {
          count: l3Row?.c ?? 0,
          label: '同成分異劑型候選',
          definition: '同成分，但劑型不同，已排除 Level 1 品項',
          warning: '劑型不同，請確認給藥途徑、釋放特性與臨床可替代性。',
        },
        level4: {
          count: l4Row?.c ?? 0,
          label: `同ATC${atc_depth}碼類別候選`,
          definition: `ATC 代碼前 ${atc_depth} 碼相同、不同成分，已排除 Level 1 品項`,
          warning: '不同成分，僅供治療替代參考。請重新評估適應症、劑量、禁忌、交互作用與健保給付條件。',
          atc_depth,
        },
      },
      meta: {
        has_group_name: !!groupName,
        has_atc: !!atc,
        atc_depth,
        api_response_time_ms: responseMs,
      }
    });

  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
