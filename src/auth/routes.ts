/**
 * 认证路由：注册 / 登录 / 登出。
 * S4-1 多用户体系公开 API（在 requireSession 之前挂载）。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { AuthService } from './service.js';
import { validateUsername, validatePassword, hashPassword, verifyPassword } from './password.js';
import { hashToken } from './token.js';
import * as rateLimit from './rateLimit.js';

export function createAuthRouter(authService: AuthService): Router {
  const router = Router();

  function clientIp(req: Request): string {
    return (req.ip ?? req.socket.remoteAddress ?? 'unknown') as string;
  }

  router.post('/register', async (req: Request, res: Response) => {
    try {
      const username = validateUsername(req.body.username);
      const password = validatePassword(req.body.password);
      const passwordHash = await hashPassword(password);
      const user = authService.createUser(username, passwordHash);
      if (!user) {
        res.status(409).json({ error: '用户名已存在' });
        return;
      }
      const { session, token } = authService.createSession(user.id);
      res.status(201).json({
        user: { id: user.id, username: user.username, created_at: user.createdAt },
        token,
        expires_at: session.expiresAt,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : '参数错误' });
    }
  });

  router.post('/login', async (req: Request, res: Response) => {
    const ip = clientIp(req);
    if (rateLimit.isRateLimited(ip)) {
      res.status(429).json({ error: '登录尝试过多，请稍后再试' });
      return;
    }

    let username: string;
    let password: string;
    try {
      username = validateUsername(req.body.username);
      password = validatePassword(req.body.password);
    } catch (err) {
      // 统一返回 401，不暴露用户名是否存在或密码格式问题
      rateLimit.recordFailure(ip);
      res.status(401).json({ error: '用户名或密码错误' });
      return;
    }

    const user = authService.getUserByUsername(username);
    if (!user) {
      rateLimit.recordFailure(ip);
      res.status(401).json({ error: '用户名或密码错误' });
      return;
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      rateLimit.recordFailure(ip);
      res.status(401).json({ error: '用户名或密码错误' });
      return;
    }

    rateLimit.recordSuccess(ip);
    const { session, token } = authService.createSession(user.id);
    res.status(200).json({
      user: { id: user.id, username: user.username, created_at: user.createdAt },
      token,
      expires_at: session.expiresAt,
    });
  });

  router.post('/logout', (req: Request, res: Response) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token) authService.deleteSession(hashToken(token));
    res.status(200).json({ ok: true });
  });

  return router;
}
