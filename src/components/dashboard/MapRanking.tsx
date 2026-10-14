'use client';

import { Crosshair, Trophy } from 'lucide-react';
import type { PollingPlacePin } from '@/lib/domain/map-pin';
import { ESTIMATED_VOTES_HINT } from '@/lib/domain/map-pin';
import { rankPlaces, sectionsInZone } from '@/lib/domain/map-filters';
import { cn } from '@/lib/utils/cn';
import { BotaoDePdf } from './BotaoDePdf';
import { formatNumber } from '@/lib/utils/text';

/**
 * Onde a campanha tem mais voto.
 *
 * O mapa mostra ONDE as pessoas estao; esta lista responde a pergunta que
 * vem depois: em quais locais de votacao vale a pena gastar o dia. Por isso
 * ela e ordenada pela estimativa, nao pelo nome, e cada linha carrega a
 * barra do tamanho relativo ao primeiro colocado — a diferenca entre o 1o e
 * o 7o lugar se enxerga antes de ler qualquer numero.
 *
 * A lista obedece ao MESMO recorte do mapa, inclusive na contagem: com uma
 * zona eleitoral escolhida, cada escola aparece com os votos daquela zona, e
 * nao com o total dela. Clicar em uma linha leva o mapa ate o local.
 *
 * Nenhum nome de pessoa aparece aqui: o local de votacao e um lugar, e a
 * lista de quem vota nele continua atras do "Ver pessoas".
 */

interface MapRankingProps {
  places: readonly PollingPlacePin[];
  /** Zona escolhida no filtro. Recorta a contagem de cada linha. */
  zone: string | null;
  /** Local em foco: fica destacado na lista. */
  activeId?: string | null;
  onFocus: (place: PollingPlacePin) => void;
  /** Baixa este ranking em PDF (escolas, zonas e secoes). */
  onDownload?: () => Promise<void>;
  /** Baixa, em PDF, quem vota em cada local: zona, secao e Lider de cada pessoa. */
  onDownloadPeople?: () => Promise<void>;
  /** Baixa, em PDF, as secoes onde o time tem gente cadastrada, com os Lideres de cada uma. */
  onDownloadSections?: () => Promise<void>;
  /** Titulo da lista. Na votacao do TSE: "Onde Fulano teve mais votos". */
  titulo?: string;
  /** Rodape: de onde o numero vem. */
  nota?: string;
  /** Votacao do TSE: escolas onde o time tinha estimativa (pino -> estimativa). */
  destaques?: ReadonlyMap<string, { estimativa: number }>;
  className?: string;
}

export function MapRanking({
  places,
  zone,
  activeId,
  onFocus,
  onDownload,
  onDownloadPeople,
  onDownloadSections,
  titulo = 'Onde você tem mais votos',
  nota = ESTIMATED_VOTES_HINT,
  destaques,
  className,
}: MapRankingProps) {
  const ranking = rankPlaces(places, zone).filter((item) => item.votes > 0);
  const total = ranking.reduce((soma, item) => soma + item.votes, 0);

  return (
    <div className={cn('flex min-h-0 flex-col bg-surface', className)}>
      <header className="border-b border-line px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-900">
            <Trophy aria-hidden="true" className="size-4 shrink-0 text-brand-700" />
            <span className="min-w-0">{titulo}</span>
          </h3>
          {ranking.length > 0 && (onDownload || onDownloadPeople || onDownloadSections) ? (
            <div className="flex items-center gap-1.5">
              {onDownload ? (
                <BotaoDePdf onClick={onDownload} rotulo="PDF" titulo="Baixar o ranking de locais, zonas e seções em PDF" />
              ) : null}
              {onDownloadPeople ? (
                <BotaoDePdf
                  onClick={onDownloadPeople}
                  rotulo="Pessoas"
                  titulo="Baixar em PDF quem vota em cada local, com zona, seção e Líder de cada pessoa"
                />
              ) : null}
              {onDownloadSections ? (
                <BotaoDePdf
                  onClick={onDownloadSections}
                  rotulo="Seções"
                  titulo="Baixar em PDF as seções com gente cadastrada, com quantas pessoas cada Líder cadastrou (filtre por Líder ou referência)"
                />
              ) : null}
            </div>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs text-ink-500">
          {ranking.length > 0
            ? `${formatNumber(total)} votos em ${formatNumber(ranking.length)} ${
                ranking.length === 1 ? 'local' : 'locais'
              }${zone ? ` · Zona ${zone}` : ''}`
            : 'Nenhum local no filtro atual.'}
        </p>
      </header>

      {ranking.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-ink-500">
          Ajuste os filtros para ver os locais de votação.
        </p>
      ) : (
        <ol className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
          {ranking.map((item) => {
            const secoes = sectionsInZone(item.place, zone);
            const ativo = item.place.locationId === activeId;

            return (
              <li key={item.place.locationId}>
                <button
                  type="button"
                  onClick={() => onFocus(item.place)}
                  aria-current={ativo || undefined}
                  className={cn(
                    'group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
                    ativo ? 'bg-brand-50' : 'hover:bg-ink-50',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-bold tabular-nums',
                      item.position <= 3
                        ? 'bg-brand-700 text-white'
                        : 'bg-ink-100 text-ink-500',
                    )}
                  >
                    {item.position}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 wrap-break-word text-[0.8125rem] font-semibold text-ink-900">
                        {item.place.title ?? 'Local de votação'}
                      </span>
                      <span className="shrink-0 text-sm font-bold text-brand-800 tabular-nums">
                        {formatNumber(item.votes)}
                      </span>
                    </span>

                    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-500">
                      <span className="wrap-break-word">{[item.place.city, item.place.state].filter(Boolean).join('/') || '--'}</span>
                      {destaques?.get(item.place.locationId) ? (
                        <span className="shrink-0 rounded-pill bg-navy-900 px-1.5 py-px text-[0.625rem] font-bold text-gold-400">
                          est. {formatNumber(destaques.get(item.place.locationId)!.estimativa)}
                        </span>
                      ) : null}
                    </span>

                    {/* A barra e comparativa, nao percentual: ela mede este
                        local contra o primeiro colocado do recorte. */}
                    <span
                      aria-hidden="true"
                      className="mt-1.5 block h-1.5 w-full overflow-hidden rounded-pill bg-ink-100"
                    >
                      <span
                        className="block h-full rounded-pill bg-brand-600"
                        style={{ width: `${Math.max(4, Math.round(item.share * 100))}%` }}
                      />
                    </span>

                    {secoes.length > 0 ? (
                      <span className="mt-1.5 flex flex-wrap gap-1">
                        {secoes.slice(0, 3).map((label) => (
                          <span
                            key={label}
                            className="rounded-pill bg-ink-50 px-1.5 py-0.5 text-[0.625rem] text-ink-500"
                          >
                            {label}
                          </span>
                        ))}
                        {secoes.length > 3 ? (
                          <span className="px-1 py-0.5 text-[0.625rem] text-ink-400">
                            +{secoes.length - 3}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </span>

                  <Crosshair
                    aria-hidden="true"
                    className={cn(
                      'mt-0.5 size-4 shrink-0 transition-colors',
                      ativo ? 'text-brand-700' : 'text-ink-300 group-hover:text-brand-700',
                    )}
                  />
                </button>
              </li>
            );
          })}
        </ol>
      )}

      <p className="border-t border-line px-4 py-2 text-[0.625rem] text-ink-500 italic">
        {nota}
      </p>
    </div>
  );
}
