import { BillingCycle, Plan } from '@prisma/client';
import { z } from 'zod';

export const checkoutSchema = z.object({
  cardTokenId: z.string().min(1, 'Token do cartão ausente.'),
  payerEmail: z.string().email('E-mail inválido.'),
  plan: z.nativeEnum(Plan),
  cycle: z.nativeEnum(BillingCycle).default(BillingCycle.MONTHLY),
  // Só no anual (pagamento único): a assinatura mensal do Mercado Pago não parcela.
  installments: z.coerce.number().int().min(1).max(12).default(1),
  paymentMethodId: z.string().trim().min(1).optional(),
  issuerId: z.string().trim().min(1).optional(),
});

export const pixSchema = z.object({
  payerEmail: z.string().email('E-mail inválido.'),
  plan: z.nativeEnum(Plan),
  cycle: z.nativeEnum(BillingCycle).default(BillingCycle.MONTHLY),
});
