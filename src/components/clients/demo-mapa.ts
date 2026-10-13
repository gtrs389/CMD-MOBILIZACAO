'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/repositories/http/api';

/**
 * Ajudantes de tela do Time DEMO: o tamanho do catalogo de escolas e o
 * "completar o mapa" depois de criar ou refazer.
 */

/** De onde vem as escolas, e quantas ha (GET /api/clients/demo/catalogo). */
export interface DemoCatalogo {
  source: 'TSE' | 'CATALOGO';
  schools: number;
  cities: number;
}

/**
 * O tamanho do catalogo, lido uma vez. Nulo enquanto carrega ou se a leitura
 * falhar — a tela cai no texto generico, e o servidor continua sendo quem
 * decide o teto.
 */
export function useDemoCatalogo(enabled = true): DemoCatalogo | null {
  const [catalogo, setCatalogo] = useState<DemoCatalogo | null>(null);

  useEffect(() => {
    // Fechado, nao pergunta nada: o dialogo de "Refazer dados" fica montado
    // na pagina de qualquer time, e so o ADMIN geral, com ele aberto, precisa
    // disto.
    if (!enabled) return;
    const controller = new AbortController();
    api<DemoCatalogo>('/api/clients/demo/catalogo', { signal: controller.signal })
      .then(setCatalogo)
      .catch(() => undefined);
    return () => controller.abort();
  }, [enabled]);

  return catalogo;
}

export interface ProgressoDoMapa {
  /** Moradias que ganharam ponto ate agora. */
  resolvidos: number;
  /** Quantas ainda podem ganhar. */
  faltam: number;
}

/** Passadas no maximo: cada uma gasta ate uns dez segundos no servidor. */
const MAX_PASSADAS = 30;

/**
 * Completa a camada "Pessoas" de um Time DEMO, chamando o servidor ate nao
 * sobrar o que resolver.
 *
 * Para sozinho quando uma passada nao anda (sem chave do provedor, credito
 * esgotado): insistir so gastaria tempo. Nunca lanca — o mapa
 * incompleto nao e erro da criacao, e "Refazer dados" ou uma nova chamada
 * continuam de onde parou.
 */
export async function completarMapaDemo(
  clientId: string,
  aoAvancar?: (progresso: ProgressoDoMapa) => void,
  parar?: () => boolean,
): Promise<ProgressoDoMapa> {
  const progresso: ProgressoDoMapa = { resolvidos: 0, faltam: 0 };

  for (let passada = 0; passada < MAX_PASSADAS; passada += 1) {
    if (parar?.()) break;

    let resposta: { resolved: number; remaining: number; processed: number };
    try {
      resposta = await api<{ resolved: number; remaining: number; processed: number }>(
        `/api/clients/demo/${clientId}/mapa`,
        { method: 'POST' },
      );
    } catch {
      break;
    }

    progresso.resolvidos += resposta.resolved;
    progresso.faltam = resposta.remaining;
    aoAvancar?.({ ...progresso });

    if (resposta.remaining === 0 || resposta.processed === 0) break;
  }

  return progresso;
}
