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

/**
 * 管理员鉴权（REQ-Feedback-Admin）：必须挂在 requireSession 之后使用，
 * 按登录用户名实时判定是否在 ADMIN_USERS 配置集合内。
 * 集合为空（未配置 ADMIN_USERS）时 fail-closed——无人可访问管理 API。
 */
export function requireAdmin(adminUsernames: ReadonlySet<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: '未授权：请先登录' });
      return;
    }
    if (!adminUsernames.has(user.username)) {
      res.status(403).json({ error: '无权访问：需要管理员账号' });
      return;
    }
    next();
  };
}
