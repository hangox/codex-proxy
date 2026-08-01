/**
 * 通用的"单备份文件"JSONL 轮转——从 `error-log.ts` 抽出来的独立工具。
 *
 * 8.10：新增的 `compact-outcome-log.ts` 需要同一套"按字节数轮转、单份
 * 备份"逻辑，但落在不同的文件名上。不复制粘贴一份，抽成一个不依赖具体
 * 文件名的小工具，两处共用同一份已经在生产验证过的轮转实现（含 Windows
 * 上 rename-onto-existing 失败的兜底）。
 *
 * 只做轮转判断本身，不管配置读取/序列化/写入——调用方决定何时调用、
 * 写什么内容，这个函数只回答"现在该不该把 current 挪到 backup"。
 */

import { existsSync, renameSync, statSync, writeFileSync } from "fs";

/**
 * 如果 `currentPath` 的大小超过 `maxBytes`，把它整体重命名为 `backupPath`
 * （覆盖旧备份），调用方随后写入的新内容会落进一个全新的 `currentPath`。
 *
 * 必须在写入新内容**之前**调用——保证新写入的这一条记录永远落在轮转后的
 * `currentPath` 里，不会被跨着备份边界切开。
 */
export function rotateJsonlIfNeeded(
  currentPath: string,
  backupPath: string,
  maxBytes: number,
): void {
  if (!existsSync(currentPath)) return;
  const size = statSync(currentPath).size;
  if (size <= maxBytes) return;
  // renameSync overwrites the destination on POSIX; on Windows the
  // backup is removed first because rename-onto-existing fails there.
  if (existsSync(backupPath) && process.platform === "win32") {
    try {
      writeFileSync(backupPath, "");
    } catch {
      /* fall through; renameSync will surface the real error */
    }
  }
  renameSync(currentPath, backupPath);
}
