// lib/sources/index.mjs — 多来源适配器的注册表与接口定义
//
// 设计目标：检索层完全不认识任何一家的格式。接一个新 agent = 新增一个适配器文件。
//
// ── 适配器接口（唯一契约）────────────────────────────────────────────────
// 每个适配器导出一个对象：
//
//   id: string                        // 'dsh' | 'claude' | 'codex' | 'opencode'
//   label: string                     // 展示名
//   detect(): boolean                 // 本机是否存在该源的会话数据
//   discover(): FileRef[]             // 列出候选，FileRef = { ref, sessionHint?, size, mtime }
//   readAll(ref): { header, events }  // 读整个会话
//   readFrom?(ref, offset): { events, consumed } | null
//                                     // 可选：增量读；不支持就不实现（整文件重读）
//   toDocs(event): Doc[]              // 事件 → 可检索文档 { kind, body }
//   surfaceOf(events): Map<seq, 'current'|'shadowed'>
//                                     // 哪些内容已被压缩掉（模型看不见但磁盘还在）
//   renderEvent(event): { role, text } // L3 show 用：一条事件渲染成人类可读一行
//
// ── 归一化形状 ───────────────────────────────────────────────────────────
// header = { id, cwd, title, createdAt, agentPreset, parentId }
// event  = { seq, time, type, data }
//   · seq：会话内唯一、单调递增的整数（JSONL 源直接用行号）
//   · data：该源的原生记录，适配器自己解释；检索层不碰
//
// 为什么保留原生 data 而不是提前抹平：`show` 要能显示未索引的事件（如 request/header），
// 提前归一化会丢信息；而 `toDocs` / `renderEvent` 各自解释原生结构，职责更清楚。
import { dshSource } from './dsh.mjs';
import { claudeSource } from './claude.mjs';
import { codexSource } from './codex.mjs';
import { opencodeSource } from './opencode.mjs';

/** 全部已注册的适配器（顺序即展示顺序）。 */
export const ADAPTERS = [dshSource, claudeSource, codexSource, opencodeSource];

/** 按 id 取适配器。 */
export function adapterOf(id) {
  return ADAPTERS.find((adapter) => adapter.id === id);
}

/** 本机实际存在数据、可以扫描的适配器。 */
export function activeAdapters(only) {
  const candidates = only === undefined ? ADAPTERS : ADAPTERS.filter((adapter) => only.includes(adapter.id));
  return candidates.filter((adapter) => {
    try {
      return adapter.detect();
    } catch {
      return false;
    }
  });
}

export const SOURCE_IDS = ADAPTERS.map((adapter) => adapter.id);
