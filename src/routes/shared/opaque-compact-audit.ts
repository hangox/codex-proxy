/**
 * 审计日志用的不可逆账号标签。
 *
 * 冻结的隐私合同要求 opaque compact 的审计输出不含账号标识。但运维排障确实
 * 需要"这两条日志是不是同一个账号"这种可关联性，所以不能简单删掉。
 *
 * 折中：用进程级随机盐做 HMAC，取 8 个十六进制字符。
 * - 同一进程内同账号 → 同标签，可关联；
 * - 跨进程重启 → 标签变化，无法长期追踪；
 * - 盐只在内存中，日志泄漏也无法反推 entryId（且 8 字符也不足以承载原值）。
 */

import { createHmac, randomBytes } from "node:crypto";

const AUDIT_SALT = randomBytes(32);

/** 把 accountEntryId 折叠成不可逆短标签，供日志使用。 */
export function auditAccountTag(accountEntryId: string): string {
  return createHmac("sha256", AUDIT_SALT).update(accountEntryId).digest("hex").slice(0, 8);
}

/**
 * 把 Claude Code session id（clientConversationId）折叠成不可逆短标签。
 *
 * 复用同一份进程级盐，但用 `session:` 前缀做域分离——同一个字符串偶然既是
 * 某个 accountEntryId 又是某个 session id 时，两者的标签仍然不同，不会互相
 * 冒充或被关联到一起。8.6 的结构化日志白名单只允许这个标签，不允许原始
 * session id。
 */
export function auditSessionTag(clientConversationId: string): string {
  return createHmac("sha256", AUDIT_SALT).update(`session:${clientConversationId}`).digest("hex").slice(0, 8);
}

/**
 * 统一的日志账号呈现。
 *
 * opaque compact 的 hard-bound 请求会流经通用 proxy 链路（usage/ws/重试/错误
 * 等日志都在那里），因此不能只改 compact 自己的日志——必须把"这条请求受隐私
 * 合同约束"的信号一路带下去。`sensitive=true` 时只输出不可逆短标签，
 * 绝不输出 entryId 或邮箱。
 */
export function formatAccount(
  entryId: string,
  sensitive: boolean | undefined,
  email?: string,
): string {
  if (sensitive === true) return `acct=${auditAccountTag(entryId)}`;
  return email === undefined ? `Account ${entryId}` : `Account ${entryId} (${email})`;
}
