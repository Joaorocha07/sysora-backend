import { Role } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        companyId: string | null;
        role: Role | null;
        isSuperAdmin: boolean;
      };
      // Corpo original, guardado só no webhook do WhatsApp para conferir a assinatura da Meta.
      rawBody?: Buffer;
    }
  }
}

export {};
