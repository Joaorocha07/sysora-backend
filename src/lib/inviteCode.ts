import crypto from 'crypto';
import { prisma } from './prisma';

// Sem caracteres fáceis de confundir ao digitar (0/O, 1/I/L).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(length = 8): string {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

export async function uniqueInviteCode(): Promise<string> {
  for (;;) {
    const code = randomCode();
    // eslint-disable-next-line no-await-in-loop
    if (!(await prisma.company.findUnique({ where: { inviteCode: code } }))) return code;
  }
}

// O funcionário pode digitar com espaços, hífen ou minúsculas.
export const normalizeInviteCode = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
