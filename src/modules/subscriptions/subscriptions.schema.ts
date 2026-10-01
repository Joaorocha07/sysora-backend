import { Plan } from '@prisma/client';
import { z } from 'zod';

export const checkoutSchema = z.object({
  cardTokenId: z.string().min(1, 'Token do cartão ausente.'),
  payerEmail: z.string().email('E-mail inválido.'),
  plan: z.nativeEnum(Plan),
});

export const pixSchema = z.object({
  payerEmail: z.string().email('E-mail inválido.'),
  plan: z.nativeEnum(Plan),
});
