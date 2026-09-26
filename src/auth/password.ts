/**
 * 密码工具：强度校验、bcryptjs 哈希、安全比较。
 * S4-1 多用户体系使用 bcryptjs（纯 JS，无原生编译依赖）。
 */
import bcrypt from 'bcryptjs';
import { config } from '../config.js';

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;

export function validateUsername(username: unknown): string {
  if (typeof username !== 'string') throw new Error('用户名必须是字符串');
  const trimmed = username.trim();
  if (!USERNAME_RE.test(trimmed)) {
    throw new Error('用户名 3~32 个字符，只能包含字母、数字、下划线、连字符');
  }
  return trimmed;
}

export function validatePassword(password: unknown): string {
  if (typeof password !== 'string') throw new Error('密码必须是字符串');
  if (password.length < 8 || password.length > 128) {
    throw new Error('密码长度 8~128 位');
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error('密码必须同时包含字母和数字');
  }
  return password;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, config.auth.bcryptRounds);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
