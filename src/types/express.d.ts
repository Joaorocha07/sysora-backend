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
    }
  }
}

export {};
