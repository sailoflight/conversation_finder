# 待接入的会话材料

把**原始**会话材料丢进这个目录即可，不要手工改写格式 —— 我需要看到各家真实形状。

## 各源最想要的东西

| 目标源 | 直接拷这些目录/文件 | 说明 |
|---|---|---|
| Claude Code | `~/.claude/projects/` 整个目录 | 每会话一个 `.jsonl`，不压缩，直接读 |
| Codex | `~/.codex/sessions/` 整个目录 | 注意 `.jsonl` 与 `.jsonl.zst` 两种形态可能并存 |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite；拷 db  +  -wal/-shm 一起更保险 |
| DSH（已有） | `$DSH_HOME/sessions/` | 已支持，无需再给 |

## 建议放法

```
samples/
  claude-code/        # 放 .jsonl（1~3 个真实会话足够）
  codex/              # 放 rollout-*.jsonl 或 .jsonl.zst
  opencode/           # 放 opencode.db
```

## 不用做的

- 不用脱敏到"面目全非"：我需要真实结构（字段名、嵌套形状、压缩标记）。如果内容敏感，
  把文本替换成占位词即可，**但请保留字段名与嵌套层级**。
- 不用转成统一格式：归一化是适配器的事。
- 不用压缩成大包：散文件就行（我能直接读）。

## 拿到之后我会做什么

1. 先写一个只读探测脚本，把真实字段打印出来（不猜格式）
2. 抽出该源的适配器（`lib/sources/<源>.mjs`），实现 `read` / `toDocs` / `surfaceOf`
3. 用真实会话验证召回，尤其是「被压缩掉的内容还能不能搜到」
