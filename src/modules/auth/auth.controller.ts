import { Request, Response } from 'express';
import { env } from '../../config/env';
import { asyncHandler } from '../../lib/asyncHandler';
import { HttpError } from '../../lib/httpError';
import { appUrl, isMailConfigured, passwordResetEmail, sendMail } from '../../lib/mailer';
import { getPlatformSettings } from '../../lib/platformSettings';
import * as authService from './auth.service';

function cookieOptions() {
  // Com frontend e backend em domínios diferentes o cookie precisa de
  // SameSite=None, e navegadores exigem Secure junto.
  const crossSite = env.CROSS_SITE_COOKIES;
  return {
    httpOnly: true,
    secure: crossSite ? true : env.COOKIE_SECURE,
    sameSite: crossSite ? ('none' as const) : ('lax' as const),
    path: '/api/auth',
  };
}

function sessionResponse(res: Response, session: authService.SessionResult) {
  res.cookie(env.REFRESH_COOKIE_NAME, session.refreshToken, { ...cookieOptions(), expires: session.refreshTokenExpiresAt });
  return res.json({ accessToken: session.accessToken, user: session.user, company: session.company, role: session.role, subscription: session.subscription });
}

export const login = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.login(req.body);
  if (result.status === 'select-company') {
    return res.json({ status: 'select-company', preAuthToken: result.preAuthToken, companies: result.companies });
  }
  return sessionResponse(res, result.session);
});

export const googleLogin = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.loginWithGoogle(req.body.accessToken);
  if (result.status === 'select-company') {
    return res.json({ status: 'select-company', preAuthToken: result.preAuthToken, companies: result.companies });
  }
  if (result.status === 'signup-required') {
    return res.json({ status: 'signup-required', signupToken: result.signupToken, email: result.email, name: result.name, avatarUrl: result.avatarUrl });
  }
  return sessionResponse(res, result.session);
});

// O admin master liga/desliga o cadastro público no painel (Configurações).
export const signupConfig = asyncHandler(async (_req: Request, res: Response) => {
  const { publicSignupEnabled } = await getPlatformSettings();
  return res.json({ companySignup: publicSignupEnabled });
});

export const registerCompany = asyncHandler(async (req: Request, res: Response) => {
  const { publicSignupEnabled } = await getPlatformSettings();
  if (!publicSignupEnabled) throw HttpError.forbidden('O cadastro de novas empresas está fechado. Fale com a equipe do Sysora.');
  return sessionResponse(res.status(201), await authService.registerCompany(req.body));
});

export const registerEmployee = asyncHandler(async (req: Request, res: Response) => {
  const { companyName } = await authService.registerEmployee(req.body);
  return res.status(201).json({ message: `Pedido enviado para ${companyName}. Você poderá entrar assim que o administrador aprovar.` });
});

// Consulta pública: um código errado não revela nada além de "não encontrado".
export const lookupInvite = asyncHandler(async (req: Request, res: Response) => {
  return res.json(await authService.lookupInvite(req.params.code));
});

export const selectCompany = asyncHandler(async (req: Request, res: Response) => {
  return sessionResponse(res, await authService.selectCompany(req.body));
});

export const switchCompany = asyncHandler(async (req: Request, res: Response) => {
  return sessionResponse(res, await authService.switchCompany(req.auth!.userId, req.body.companyId));
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.[env.REFRESH_COOKIE_NAME];
  if (!token) throw HttpError.unauthorized('Refresh token ausente.');
  return sessionResponse(res, await authService.refreshSession(token));
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.[env.REFRESH_COOKIE_NAME];
  if (token) await authService.revokeRefreshToken(token);
  res.clearCookie(env.REFRESH_COOKIE_NAME, cookieOptions());
  return res.status(204).send();
});

export const me = asyncHandler(async (req: Request, res: Response) => {
  return res.json(await authService.me(req.auth!));
});

export const myCompanies = asyncHandler(async (req: Request, res: Response) => {
  const companies = await authService.listMyCompanies(req.auth!.userId, req.auth!.isSuperAdmin);
  return res.json({ companies });
});

export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.requestPasswordReset(req.body.email);
  if (result) {
    const link = `${appUrl()}/redefinir-senha?token=${result.token}`;
    if (isMailConfigured()) {
      // Em segundo plano: a resposta não pode demorar mais quando o e-mail
      // existe (senão dá para descobrir quais e-mails estão cadastrados).
      const email = passwordResetEmail(result.name, link, authService.PASSWORD_RESET_MINUTES);
      sendMail({ to: req.body.email, ...email }).catch((err) => {
        console.error(`Falha ao enviar o e-mail de recuperação para ${req.body.email}:`, err);
      });
    } else if (env.NODE_ENV !== 'production') {
      console.log(`[dev] SMTP não configurado. Link de recuperação de senha para ${req.body.email}: ${link}`);
    } else {
      console.error('SMTP não configurado: não foi possível enviar o e-mail de recuperação de senha.');
    }
  }
  return res.json({ message: 'Se o e-mail existir em nossa base, enviaremos instruções de recuperação.' });
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  await authService.resetPassword(req.body.token, req.body.password);
  return res.json({ message: 'Senha redefinida com sucesso.' });
});

export const changePassword = asyncHandler(async (req: Request, res: Response) => {
  await authService.changePassword(req.auth!.userId, req.body.currentPassword, req.body.newPassword);
  return res.json({ message: 'Senha atualizada com sucesso.' });
});
