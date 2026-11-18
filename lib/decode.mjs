// lib/decode.mjs — zstd 多帧解码（DSH 会话文件格式的地基）
//
// 关键事实（预研实测，勿改）：
//   · session.v4.jsonl.zstd 是「多帧首尾拼接」，一帧 ≈2 个事件、≈2.2KB。
//   · zstdDecompressSync(整个文件) 只解第一帧且**不报错**（静默截断）。
//   · 唯一正确解：按 magic 切分后逐帧解码；解码失败说明 magic 误命中，并入下一段重试。
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

/** zstd 帧魔数 28 B5 2F FD。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 扫描所有帧起始偏移（可能有误命中，解码时再验证）。 */
export function scanFrameOffsets(raw) {
  const cuts = [];
  for (let i = raw.indexOf(ZSTD_MAGIC); i >= 0; i = raw.indexOf(ZSTD_MAGIC, i + 4)) cuts.push(i);
  return cuts;
}

/**
 * 从 fromByte（必须是帧边界）开始逐帧解码。
 * @returns {{ text: string, consumed: number, frames: number }}
 *   consumed = 已成功解出的字节位置，可直接作为增量水位线（下次从这里继续）。
 *   末尾半截帧（会话正在写入）会被跳过，consumed 停在上一个完整帧边界。
 */
export function decodeFramesFrom(raw, fromByte = 0) {
  const cuts = scanFrameOffsets(raw).filter((offset) => offset >= fromByte);
  if (cuts.length === 0) return { text: '', consumed: fromByte, frames: 0 };
  const bounds = [...cuts, raw.length];
  let text = '';
  let consumed = fromByte;
  let frames = 0;
  let k = 0;
  while (k < bounds.length - 1) {
    let j = k + 1;
    let decoded = null;
    while (j < bounds.length) {
      try {
        decoded = zstdDecompressSync(raw.subarray(bounds[k], bounds[j]));
        break;
      } catch {
        j += 1;
      }
    }
    if (decoded === null) break; // 末帧不完整：保留水位线，下次补
    text += decoded.toString('utf8');
    consumed = bounds[j];
    frames += 1;
    k = j;
  }
  return { text, consumed, frames };
}

/** 解码整个会话文件。 */
export function decodeFile(path) {
  return decodeFramesFrom(readFileSync(path), 0).text;
}

/** 逐行解析 JSONL，坏行（半截/损坏）跳过。 */
export function parseJsonl(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 半截行：跳过 */
    }
  }
  return out;
}

/**
 * 读取一个会话文件。session 事件（首行）作为 header。
 * @returns {{ header: object|null, events: object[], text: string }}
 */
export function readSessionFile(path) {
  const text = decodeFile(path);
  const events = parseJsonl(text);
  const header = events.find((ev) => ev.type === 'session') ?? null;
  return { header, events, text };
}
