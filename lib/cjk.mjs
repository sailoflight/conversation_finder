// lib/cjk.mjs — 中文检索的分词策略（本项目唯一需要自己实现的核心算法）
//
// 预研实测（同一句「这是一个关于幂等性的讨论，压缩之后还能不能找回来」）：
//   unicode61（官方所用）: 「幂等」0  「幂等性」0  「压缩之后」0   → 中文不可用
//   trigram              : 「幂等」0  「幂等性」1  「压缩之后」1   → 2 字查询失效
//   CJK bigram（本方案）  : 「幂等」1  「幂等性」1  「压缩之后」1   → 全中
//
// 做法：写入侧把 CJK 连续段切成 bigram 串存进独立列 sh；
//       查询侧把 CJK 词转成 bigram **短语**（"幂等 等性"），拉丁词原样。
const CJK_CHAR = /[\u4e00-\u9fff]/;
const CJK_RUN = /[\u4e00-\u9fff]+/;
// 注意：切 bigram 必须用**全局**正则。用非全局的 String.match 只会返回第一个 CJK 段，
// 导致「POST 请求重复提交…」这类中文跟在 ASCII 之后的文本整段进不了 sh 列，静默漏召回。
const CJK_RUN_G = /[\u4e00-\u9fff]+/g;
const TOKEN = /[\u4e00-\u9fff]+|[A-Za-z0-9_.\-/@:+]+/g;

/** 单字 CJK 在 FTS 里无解（bigram 至少要两个字），退化到 LIKE。 */
export const LIKE_FALLBACK_MIN = 1;

/** 把文本里的 CJK 连续段切成 bigram 串；非 CJK 内容不参与 sh 列。 */
export function bigrams(text) {
  const out = [];
  for (const run of String(text ?? '').matchAll(CJK_RUN_G)) {
    for (let i = 0; i < run[0].length - 1; i += 1) out.push(run[0].slice(i, i + 2));
  }
  return out.join(' ');
}

/**
 * 查询串 → FTS5 MATCH 表达式，或 { like } 表示单字退化。
 * CJK 词转 bigram 短语（顺序敏感，避免「等幂」误命中）；拉丁词小写。
 * @returns {{match: string} | {like: string}}
 */
export function buildMatchQuery(text) {
  const parts = [];
  for (const [token] of String(text ?? '').matchAll(TOKEN)) {
    if (CJK_CHAR.test(token)) {
      if (token.length <= LIKE_FALLBACK_MIN) return { like: token };
      const grams = [];
      for (let i = 0; i < token.length - 1; i += 1) grams.push(token.slice(i, i + 2));
      parts.push(`"${grams.join(' ')}"`);
    } else {
      parts.push(token.toLowerCase());
    }
  }
  if (parts.length === 0) return { like: String(text ?? '') };
  return { match: parts.join(' AND ') };
}

/** 是否含单个 CJK 字符（用于决定 LIKE 兜底）。 */
export function needsLikeFallback(text) {
  return [...String(text ?? '')].some((ch) => CJK_CHAR.test(ch));
}
