import { Plan } from '@prisma/client';
import { z } from 'zod';

export const email = z.string().trim().email('E-mail inválido.').toLowerCase();
export const password = z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres.');

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Informe a senha.'),
});

export const selectCompanySchema = z.object({
  preAuthToken: z.string().min(1, 'Token de pré-autenticação ausente.'),
  companyId: z.string().uuid('Empresa inválida.'),
});

// companyId nulo: admin master voltando ao painel master.
export const switchCompanySchema = z.object({
  companyId: z.string().uuid('Empresa inválida.').nullable(),
});

const phone = z.string().trim().max(30).nullish();

// Cadastro com e-mail e senha, ou só com o token do login com Google
// (googleToken), que já traz o e-mail confirmado.
const credentials = {
  email: email.optional(),
  password: password.optional(),
  googleToken: z.string().min(1).optional(),
};

export const registerCompanySchema = z.object({
  plan: z.nativeEnum(Plan).default(Plan.INICIAL),
  companyName: z.string().trim().min(2, 'Informe o nome da empresa.').max(120),
  name: z.string().trim().min(2, 'Informe seu nome completo.').max(120),
  phone,
  ...credentials,
});

export const registerEmployeeSchema = z.object({
  inviteCode: z.string().trim().min(4, 'Informe o código da empresa.').max(20),
  name: z.string().trim().min(2, 'Informe seu nome completo.').max(120),
  phone,
  ...credentials,
});

export const googleLoginSchema = z.object({
  accessToken: z.string().min(1, 'Token do Google ausente.'),
  // 'join': veio do cadastro de funcionário (convite). Mesmo com conta existente,
  // devolve o token de cadastro para pedir acesso à empresa do convite.
  intent: z.enum(['login', 'join']).optional(),
});

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token ausente.'),
  password,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Informe a senha atual.'),
  newPassword: password,
});
