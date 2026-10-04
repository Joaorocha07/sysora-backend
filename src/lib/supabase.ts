import { createClient, type SupabaseClient, type User as SupabaseUser } from '@supabase/supabase-js';
import { env } from '../config/env';
import { HttpError } from './httpError';

// O Supabase só é usado para o login com Google: o frontend faz o OAuth pelo
// Supabase Auth e manda o access token dele; aqui conferimos esse token com o
// Supabase e o backend emite a sessão própria da Sysora.
let client: SupabaseClient | null = null;

export const isGoogleLoginEnabled = () => Boolean(env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY);

function supabase(): SupabaseClient {
  if (!isGoogleLoginEnabled()) throw HttpError.badRequest('O login com Google não está configurado no servidor.');
  client ??= createClient(env.SUPABASE_URL!, env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return client;
}

export type GoogleProfile = { email: string; name: string; avatarUrl: string | null };

export async function verifyGoogleAccessToken(accessToken: string): Promise<GoogleProfile> {
  const { data, error } = await supabase().auth.getUser(accessToken);
  if (error || !data.user) throw HttpError.unauthorized('Login com Google expirado ou inválido. Tente novamente.');

  const user: SupabaseUser = data.user;
  // Só aceita e-mail confirmado pelo próprio Google: uma conta de e-mail/senha
  // do Supabase com o mesmo endereço não serve para entrar na Sysora.
  const fromGoogle = user.identities?.some((identity) => identity.provider === 'google');
  if (!fromGoogle || !user.email || !user.email_confirmed_at) {
    throw HttpError.unauthorized('Não foi possível confirmar o seu e-mail com o Google.');
  }

  const meta = user.user_metadata ?? {};
  const name = String(meta.full_name || meta.name || user.email.split('@')[0]).trim().slice(0, 120);
  const picture = meta.avatar_url || meta.picture;
  const avatarUrl = typeof picture === 'string' && picture.startsWith('https://') ? picture : null;
  return { email: user.email.toLowerCase(), name, avatarUrl };
}
