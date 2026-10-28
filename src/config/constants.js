const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET e obrigatorio. Defina a variavel de ambiente antes de iniciar o servidor.');
}

// Com Embedded Signup o webhook do WhatsApp passa a validar assinatura com um
// segredo global. Enquanto WHATSAPP_LEGACY_PER_TENANT_SECRET estiver ligado, os
// segredos por tenant ainda servem de fallback e o global e opcional. Ao
// desligar a flag ele vira obrigatorio: sem ele o webhook rejeitaria tudo, e
// falhar no boot e melhor do que perder mensagem de cliente em silencio.
const WHATSAPP_LEGACY_SECRETS = String(
  process.env.WHATSAPP_LEGACY_PER_TENANT_SECRET || 'true'
).toLowerCase() === 'true';

if (!WHATSAPP_LEGACY_SECRETS && !process.env.WHATSAPP_APP_SECRET) {
  throw new Error(
    'WHATSAPP_APP_SECRET e obrigatorio quando WHATSAPP_LEGACY_PER_TENANT_SECRET=false. '
    + 'Defina o segredo do app Meta ou mantenha a flag de legado ligada.'
  );
}

export const JWT_SECRET_VALUE = JWT_SECRET;
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';
export const PORT = process.env.PORT || 3001;
export const MAX_LOGS = 500;
