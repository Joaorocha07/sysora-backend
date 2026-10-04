import * as cloud from './whatsapp.cloud';
import * as qr from './whatsapp.connection';

// Por onde sai a mensagem de cada empresa: API oficial da Meta (quando a
// empresa conectou por ela) ou QR Code / WhatsApp Web (whatsapp.connection.ts).
// Uma empresa usa só um dos dois por vez.

export type Provider = 'cloud' | 'qr';

export async function providerOf(companyId: string): Promise<Provider | null> {
  if (await cloud.getCloudAccount(companyId)) return 'cloud';
  return qr.isConnected(companyId) ? 'qr' : null;
}

export async function isReady(companyId: string): Promise<boolean> {
  return (await providerOf(companyId)) !== null;
}

// `contact` é o whatsappId do cliente (só dígitos) ou, no QR Code, um JID.
export async function sendText(companyId: string, contact: string, text: string): Promise<void> {
  if (await cloud.getCloudAccount(companyId)) return cloud.sendCloudText(companyId, contact, text);
  return qr.sendText(companyId, contact, text);
}

// Empresa desativada ou excluída: desliga as duas formas de conexão.
export async function disconnectAll(companyId: string): Promise<void> {
  await Promise.all([cloud.disconnectCloud(companyId).catch(() => {}), qr.disconnect(companyId).catch(() => {})]);
}
