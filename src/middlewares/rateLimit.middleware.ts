import rateLimit from 'express-rate-limit';

const tooMany = (message: string) => ({ error: { code: 'TOO_MANY_REQUESTS', message } });

// Login, seleção de empresa e recuperação de senha: dificulta força bruta.
// Só as tentativas que falham contam para o limite.
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany('Muitas tentativas. Tente novamente em alguns minutos.'),
});

// Renovação da sessão: roda a cada carregamento de página, então tem um
// limite próprio e bem mais folgado (não disputa com o de login).
export const refreshRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany('Muitas requisições. Tente novamente em instantes.'),
});

// Cadastro público (empresa ou funcionário): conta todas as tentativas,
// inclusive as que dão certo, para ninguém criar contas em massa.
export const signupRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany('Muitos cadastros a partir desta rede. Tente novamente mais tarde.'),
});

// Agendamento pela página pública do link do bot: poucas marcações por IP.
export const bookingRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany('Muitas tentativas de agendamento. Tente novamente em alguns minutos.'),
});

export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  // O webhook do WhatsApp oficial chega dos servidores da Meta com as mensagens
  // de todas as empresas (e é autenticado pela assinatura).
  skip: (req) => req.originalUrl.startsWith('/api/webhooks/whatsapp'),
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany('Muitas requisições. Tente novamente em instantes.'),
});
