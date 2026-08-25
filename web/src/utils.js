// Gerador de id sem depender de crypto.randomUUID() — essa API só existe em
// "contextos seguros" (HTTPS, ou localhost). Rodando via IP puro em HTTP
// simples (o caso normal desse app numa rede local industrial, sem
// domínio/certificado — ver CONTEXT.md), o navegador nem expõe
// crypto.randomUUID: chamar ele lança TypeError na hora, silenciosamente,
// já que costuma ser a primeira linha da função, fora de qualquer
// try/catch. Formato de UUID v4 só por convenção/compatibilidade visual —
// não precisa ser criptograficamente seguro, é só um identificador local
// de sessão (chave de ponto/lote/rota).
export function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
