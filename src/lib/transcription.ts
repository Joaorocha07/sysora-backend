import { env } from '../config/env';
import { recordAiCost } from './aiUsage';

// Transcrição dos áudios que o cliente manda no WhatsApp. Usa uma API
// compatível com a da OpenAI (/audio/transcriptions): por padrão a Groq com o
// Whisper, que custa centavos de dólar por hora de áudio. O texto transcrito
// segue o atendimento como se o cliente tivesse digitado.

export const transcriptionEnabled = () => Boolean(env.TRANSCRIBE_API_KEY);

export async function transcribeAudio(companyId: string, audio: Buffer, mimetype: string, seconds: number): Promise<string | null> {
  if (!env.TRANSCRIBE_API_KEY) return null;
  const ext = mimetype.includes('mpeg') ? 'mp3' : mimetype.includes('mp4') ? 'm4a' : 'ogg';
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimetype.split(';')[0] || 'audio/ogg' }), `audio.${ext}`);
  form.append('model', env.TRANSCRIBE_MODEL);
  form.append('language', 'pt');
  form.append('response_format', 'json');

  const response = await fetch(`${env.TRANSCRIBE_API_URL.replace(/\/$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TRANSCRIBE_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Transcrição falhou (${response.status}): ${(await response.text()).slice(0, 200)}`);
  const { text } = (await response.json()) as { text?: string };

  // A Groq cobra no mínimo 10 s por áudio.
  const billed = Math.max(seconds, 10);
  await recordAiCost(companyId, 'audio', env.TRANSCRIBE_MODEL, (billed / 3600) * env.TRANSCRIBE_USD_PER_HOUR * 1_000_000);
  return text?.trim() || null;
}
