// lib/interface.mjs — 接口预算的**唯一事实来源**
//
// 规则（用户定的，很对）：
//   与 grep 同款的参数**不算限制** —— agent 早就内化了 `-r/-C/-l/-m/-E`，
//   它们不产生认知负担，只是把已知动作接到新数据源上。
//   真正要克制的是**新概念**：grep 里没有的东西，agent 得先学会。
//
// 所以预算不是「参数总数 ≤ N」，而是「**新概念** ≤ N」。
// 这个文件把映射写死，测试据此机械校验 —— 否则「这个参数算不算 grep 同款」
// 就变成每次都要人吵一架的主观判断。

/**
 * 与 grep / ripgrep 一一对应的参数。
 * key = 我们的参数名，value = grep 里等价的东西（用于文档与测试报错信息）。
 */
export const GREP_PARITY = {
  query: 'pattern',
  all: '-r',
  context: '-C',
  list: '-l',
  limit: '-m',
};

/**
 * grep 没有的新概念 —— 这才是需要克制的东西。
 *
 * `exclude`：grep 只能按文件过滤，会话语料里还有「工具输出 / 思考 / 答复」这一层。
 *
 * 注意 `regex` 不在表里 —— 它不再是参数，而是**默认语义**（pattern 就是正则）。
 * 收进参数意味着"另一种模式"，而 grep 用户不会去想"要不要开正则"。
 * `deep`：grep 没有"再扫一遍低精度启发式"这回事。
 *
 * 注意：同义词扩展**不是参数**，所以不出现在这里 —— 它默认开、
 * 行为对 grep 用户透明（只在精确为 0 时生效），且能用 `--no-synonym` 关掉。
 * 做成参数反而会让 agent 多一次"要不要开"的决策，而它没有足够信息去决定。
 */
export const NOVEL = {
  exclude: '按区域排除（grep 只有文件这一层）',
  deep: '连熵启发式一起扫（能抓无固定前缀的凭据，代价是误报）',
};

/** 新概念的预算。想加第三个之前，先想清楚它能不能变成 grep 的一个 flag。 */
export const NOVEL_BUDGET = 2;

/** 接口税上限（token）。与"认知负担"是两件事：不熟也要花钱，熟悉了也要花钱。 */
export const TAX_BUDGET = 500;

/** 粗粒度 token 估算：CJK 按 1.5 字符/token，其余按 4 字符/token。 */
export function approxTokens(text) {
  const source = String(text ?? '');
  const cjk = (source.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return Math.round(cjk / 1.5 + (source.length - cjk) / 4);
}

/**
 * 审计一份工具定义。
 *
 * @param {object[]} tools MCP 的 tools/list 输出
 * @returns {{params: string[], grep: string[], novel: string[], unknown: string[],
 *            missing: string[], tax: number}}
 *   unknown：既不在 GREP_PARITY 也不在 NOVEL 里的参数 —— 说明有人加了东西却没归类。
 *   missing：登记了却没人用 —— 说明映射过期了。
 */
export function auditInterface(tools) {
  const params = tools.flatMap((tool) => Object.keys(tool.inputSchema?.properties ?? {}));
  const unique = [...new Set(params)];
  return {
    params: unique,
    grep: unique.filter((name) => name in GREP_PARITY),
    novel: unique.filter((name) => name in NOVEL),
    unknown: unique.filter((name) => !(name in GREP_PARITY) && !(name in NOVEL)),
    missing: Object.keys(NOVEL).filter((name) => !unique.includes(name)),
    tax: tools.reduce(
      (sum, tool) => sum + approxTokens(tool.description ?? '') + approxTokens(JSON.stringify(tool.inputSchema)),
      0,
    ),
  };
}
