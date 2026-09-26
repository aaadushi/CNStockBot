/**
 * 会话鉴权中间件：解析 Authorization: Bearer <token>，
 * 查 sessions 表后将 { userId, username } 挂到 req.user。
 * S4-1 多用户体系核心中间件。
 */
import type { Request, Response, NextFunction } from 'express';
import { AuthService } from './service.js';
import { hashToken } from './token.js';

export interface AuthUser {
  userId: string;
  username: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function requireSession(authService: AuthService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      res.status(401).json({ error: '未授权：请先登录' });
      return;
    }
    const session = authService.getSessionByTokenHash(hashToken(token));
    if (!session) {
      res.status(401).json({ error: '未授权：登录已过期或无效' });
      return;
    }
    req.user = { userId: session.userId, username: session.username };
    next();
  };
}
