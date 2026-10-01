import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { authRateLimiter, refreshRateLimiter, signupRateLimiter } from '../../middlewares/rateLimit.middleware';
import { validate } from '../../middlewares/validate.middleware';
import * as controller from './auth.controller';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  googleLoginSchema,
  loginSchema,
  registerCompanySchema,
  registerEmployeeSchema,
  resetPasswordSchema,
  selectCompanySchema,
  switchCompanySchema,
} from './auth.schema';

export const authRouter = Router();

authRouter.post('/login', authRateLimiter, validate(loginSchema), controller.login);
authRouter.post('/google', authRateLimiter, validate(googleLoginSchema), controller.googleLogin);
authRouter.post('/login/company', authRateLimiter, validate(selectCompanySchema), controller.selectCompany);
authRouter.post('/refresh', refreshRateLimiter, controller.refresh);
authRouter.post('/logout', controller.logout);

authRouter.get('/signup-config', controller.signupConfig);
authRouter.post('/register', signupRateLimiter, validate(registerCompanySchema), controller.registerCompany);
authRouter.post('/register-employee', signupRateLimiter, validate(registerEmployeeSchema), controller.registerEmployee);
authRouter.get('/invite/:code', authRateLimiter, controller.lookupInvite);

authRouter.post('/forgot-password', authRateLimiter, validate(forgotPasswordSchema), controller.forgotPassword);
authRouter.post('/reset-password', authRateLimiter, validate(resetPasswordSchema), controller.resetPassword);

authRouter.get('/me', authenticate, controller.me);
authRouter.get('/companies', authenticate, controller.myCompanies);
authRouter.get('/memberships', authenticate, controller.myMemberships);
authRouter.post('/switch-company', authenticate, validate(switchCompanySchema), controller.switchCompany);
authRouter.post('/change-password', authenticate, validate(changePasswordSchema), controller.changePassword);
