import { describe, it, expect } from 'vitest';
import {
  validateUsername,
  validatePassword,
  hashPassword,
  verifyPassword,
} from '../../src/auth/password.js';

describe('auth/password', () => {
  it('用户名格式校验通过', () => {
    expect(validateUsername('alice_123')).toBe('alice_123');
    expect(validateUsername('  bob-99  ')).toBe('bob-99');
  });

  it('用户名非法抛出错误', () => {
    expect(() => validateUsername('ab')).toThrow();
    expect(() => validateUsername('a'.repeat(33))).toThrow();
    expect(() => validateUsername('alice@')).toThrow();
  });

  it('密码强度校验通过', () => {
    expect(validatePassword('helloWorld1')).toBe('helloWorld1');
  });

  it('弱密码被拒绝', () => {
    expect(() => validatePassword('short1')).toThrow('密码长度');
    expect(() => validatePassword('onlyletters')).toThrow('字母和数字');
    expect(() => validatePassword('12345678')).toThrow('字母和数字');
  });

  it('bcryptjs 哈希可校验，明文不存', async () => {
    const hash = await hashPassword('myP@ssw0rd');
    expect(hash).not.toContain('myP@ssw0rd');
    // bcryptjs 输出 $2b$ 前缀
    expect(hash.startsWith('$2b$')).toBe(true);
    expect(await verifyPassword('myP@ssw0rd', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
});
