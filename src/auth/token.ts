/**
 * 会话 token 生成与哈希。
 * 明文 token 只返回给客户端一次；数据库中只存 SHA-256 hash。
 */
import { randomBytes, createHash } from 'node:crypto';

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
