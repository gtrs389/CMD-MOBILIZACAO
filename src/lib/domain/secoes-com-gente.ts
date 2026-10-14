import type { PollingPlacePin } from './map-pin';
import { chaveDaSecao } from './confronto';
import { normalizeZone, referenciaDoLider } from './map-filters';

/**
 * Secoes com gente cadastrada: onde o time TEM pessoas, escola por escola e
 * secao por secao, com quantas cada Lider cadastrou em cada uma.
 *
 * Nao e voto: e cadastro. Sai dos pinos de escola da campanha, ja no recorte
 * do mapa — com Lider ou referencia no filtro, cada pino ja vem so com a
 * gente deles, e o relatorio mostra so onde eles tem gente.
 */

export interface LiderNaSecao {
  id: string;
  nome: string;
  pessoas: number;
  /** A referencia do Lider; ausente quando o mapa nao traz referencias. */
  referencia?: string | null;
}

export interface SecaoComGente {
  chave: string;
  zona: string;
  secao: string;
  /** Pessoas do time que votam na secao (todas, com ou sem Lider). */
  gente: number;
  /** Quanto cada Lider cadastrou na secao, do maior para o menor. */
  lideres: LiderNaSecao[];
}

export interface EscolaComGente {
  chave: string;
  titulo: string;
  endereco: string | null;
  cidade: string | null;
  zonas: string[];
  /** Na ordem de zona e secao. */
  secoes: SecaoComGente[];
  /** Pessoas do time na escola, com as sem zona ou secao no cadastro. */
  gente: number;
  /** Quem nao tem zona ou secao no cadastro: conta na escola, nao numa secao. */
  semSecao: number;
  /** Quanto cada Lider cadastrou na escola, do maior para o menor. */
  lideres: LiderNaSecao[];
  /** A maior secao da escola: as barras da escola na mesma escala. */
  escala: number;
}

export interface LiderNoRelatorioDeGente {
  id: string;
  nome: string;
  referencia?: string | null;
  pessoas: number;
  secoes: number;
  escolas: number;
}

export interface RelatorioDeGente {
  escolas: EscolaComGente[];
  totais: { escolas: number; secoes: number; pessoas: number; lideres: number };
  lideres: LiderNoRelatorioDeGente[];
}

const porNumero = (a: string, b: string) => Number(a) - Number(b) || a.localeCompare(b);
const doMaiorParaOMenor = <T extends { pessoas: number; nome: string }>(a: T, b: T) =>
  b.pessoas - a.pessoas || a.nome.localeCompare(b.nome, 'pt-BR');

/**
 * As escolas e secoes onde o time tem gente cadastrada. `zona`: o filtro de
 * zona do mapa — so as secoes dela entram (a escola pode ter outras).
 */
export function relatorioDeGente(
  campanha: readonly PollingPlacePin[],
  /** As referencias dos Lideres do time (`MapOverviewPayload.referencias`). */
  referencias?: Readonly<Record<string, string>>,
  zona?: string | null,
): RelatorioDeGente {
  const comReferencia = (l: { id: string; name: string }) => (referencias ? { referencia: referenciaDoLider(referencias, l) } : {});
  const naZona = (z: string | null | undefined) => !zona || normalizeZone(z) === normalizeZone(zona);
  const temSecao = (s: { zone: string | null; section: string | null }) => Boolean(s.zone?.trim() && s.section?.trim());

  const escolas: EscolaComGente[] = [];
  const porLider = new Map<string, { id: string; nome: string; referencia?: string | null; pessoas: number; secoes: Set<string>; escolas: Set<string> }>();
  const geralDo = (l: { id: string; name: string }) => {
    const atual = porLider.get(l.id) ?? { id: l.id, nome: l.name, pessoas: 0, secoes: new Set<string>(), escolas: new Set<string>(), ...comReferencia(l) };
    porLider.set(l.id, atual);
    return atual;
  };

  for (const p of campanha) {
    const secoes = new Map<string, SecaoComGente>();
    let semSecao = 0;
    for (const s of p.sections) {
      if (s.total <= 0) continue;
      if (!temSecao(s)) {
        // Sem zona no cadastro, a pessoa nao tem como estar na zona do filtro.
        if (!zona) semSecao += s.total;
        continue;
      }
      if (!naZona(s.zone)) continue;
      const chave = chaveDaSecao(s.zone, s.section);
      const atual = secoes.get(chave) ?? { chave, zona: s.zone!.trim(), secao: s.section!.trim(), gente: 0, lideres: [] };
      atual.gente += s.total;
      secoes.set(chave, atual);
    }

    const lideresDaEscola = new Map<string, LiderNaSecao>();
    for (const l of p.leaders ?? []) {
      let naEscola = 0;
      for (const s of l.sections) {
        if (s.total <= 0) continue;
        if (!temSecao(s)) {
          if (!zona) naEscola += s.total;
          continue;
        }
        const secao = secoes.get(chaveDaSecao(s.zone, s.section));
        if (!secao) continue;
        const mesmo = secao.lideres.find((x) => x.id === l.id);
        if (mesmo) mesmo.pessoas += s.total;
        else secao.lideres.push({ id: l.id, nome: l.name, pessoas: s.total, ...comReferencia(l) });
        naEscola += s.total;
        geralDo(l).secoes.add(`${p.locationId}|${secao.chave}`);
      }
      if (naEscola <= 0) continue;
      const atual = lideresDaEscola.get(l.id) ?? { id: l.id, nome: l.name, pessoas: 0, ...comReferencia(l) };
      atual.pessoas += naEscola;
      lideresDaEscola.set(l.id, atual);

      const geral = geralDo(l);
      geral.pessoas += naEscola;
      geral.escolas.add(p.locationId);
    }

    const lista = [...secoes.values()].sort((a, b) => porNumero(a.zona, b.zona) || porNumero(a.secao, b.secao));
    for (const s of lista) s.lideres.sort(doMaiorParaOMenor);
    const gente = lista.reduce((t, s) => t + s.gente, 0) + semSecao;
    if (gente <= 0) continue;

    escolas.push({
      chave: p.locationId,
      titulo: p.title ?? 'Local de votação',
      endereco: p.address,
      cidade: p.city,
      zonas: [...new Set(lista.map((s) => s.zona))],
      secoes: lista,
      gente,
      semSecao,
      lideres: [...lideresDaEscola.values()].sort(doMaiorParaOMenor),
      escala: Math.max(1, ...lista.map((s) => s.gente)),
    });
  }

  // Primeiro onde o time tem mais gente.
  escolas.sort((a, b) => b.gente - a.gente || a.titulo.localeCompare(b.titulo, 'pt-BR'));

  const lideres: LiderNoRelatorioDeGente[] = [...porLider.values()]
    .filter((l) => l.pessoas > 0)
    .map((l) => ({ ...l, secoes: l.secoes.size, escolas: l.escolas.size }))
    .sort(doMaiorParaOMenor);

  return {
    escolas,
    totais: {
      escolas: escolas.length,
      secoes: escolas.reduce((t, e) => t + e.secoes.length, 0),
      pessoas: escolas.reduce((t, e) => t + e.gente, 0),
      lideres: lideres.length,
    },
    lideres,
  };
}
