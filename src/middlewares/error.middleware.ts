import { NextFunction, Request, Response } from 'express';
import { MercadoPagoError } from 'mercadopago';
import { ZodError } from 'zod';
import { HttpError } from '../lib/httpError';
import { env } from '../config/env';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Dados inválidos.',
        details: err.flatten(),
      },
    });
  }

  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  if (err instanceof MercadoPagoError) {
    console.error(err);
    const { status, message } = paymentErrorMessage(err);
    return res.status(status).json({ error: { code: 'PAYMENT_ERROR', message } });
  }

  console.error(err);
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Erro interno do servidor.',
      ...(env.NODE_ENV !== 'production' && err instanceof Error ? { debug: err.message } : {}),
    },
  });
}

// Traduz erros do Mercado Pago para mensagens que o usuário entende.
function paymentErrorMessage(err: MercadoPagoError): { status: number; message: string } {
  const text = `${err.message} ${err.error} ${JSON.stringify(err.causes ?? [])}`;

  if (/CC_VAL_433|credit card validation|cc_rejected/i.test(text)) {
    return { status: 400, message: 'Cartão recusado pelo banco. Verifique os dados ou use outro cartão.' };
  }
  if (/card[_ ]token/i.test(text)) {
    return { status: 400, message: 'Os dados do cartão expiraram. Preencha o cartão novamente.' };
  }
  if (err.status === 401 || err.status === 403) {
    return { status: 502, message: 'Pagamento indisponível no momento. Entre em contato com o suporte.' };
  }
  if (err.status >= 400 && err.status < 500) {
    return { status: 400, message: 'Não foi possível processar o pagamento. Verifique os dados e tente novamente.' };
  }
  return { status: 502, message: 'O Mercado Pago está instável no momento. Tente novamente em instantes.' };
}
