import { z } from 'zod';

// CPF ou CNPJ da empresa. Aceita o CNPJ alfanumérico (Receita Federal, a partir
// de julho de 2026): 12 posições com letras e números + 2 dígitos verificadores
// numéricos; no cálculo cada caractere vale o código ASCII - 48. Guarda com a
// máscara (000.000.000-00 ou XX.XXX.XXX/XXXX-00). Mesma regra no frontend
// (src/lib/document.ts).

const normalize = (value: string) => value.toUpperCase().replace(/[^0-9A-Z]/g, '');

export function isValidCpf(value: string): boolean {
  const d = value.replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const check = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === Number(d[9]) && check(10) === Number(d[10]);
}

export function isValidCnpj(value: string): boolean {
  const c = normalize(value);
  if (!/^[0-9A-Z]{12}\d{2}$/.test(c) || /^(.)\1{13}$/.test(c)) return false;
  const check = (len: number) => {
    let sum = 0;
    let weight = 2;
    for (let i = len - 1; i >= 0; i--) {
      sum += (c.charCodeAt(i) - 48) * weight;
      weight = weight === 9 ? 2 : weight + 1;
    }
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return check(12) === Number(c[12]) && check(13) === Number(c[13]);
}

export function formatDocument(value: string): string {
  const c = normalize(value);
  return c.length === 11
    ? c.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')
    : c.replace(/^(.{2})(.{3})(.{3})(.{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

// Campo opcional: vazio vira null; preenchido precisa ser CPF ou CNPJ válido.
export const documentField = z
  .string()
  .trim()
  .max(30)
  .nullish()
  .transform((value) => (value ? normalize(value) : null))
  .refine((value) => !value || (value.length === 11 ? isValidCpf(value) : isValidCnpj(value)), 'CPF ou CNPJ inválido. Confira os números.')
  .transform((value) => (value ? formatDocument(value) : null));
