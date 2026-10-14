import { describe, expect, it } from 'vitest';
import type { PollingPlacePin } from '@/lib/domain/map-pin';
import { placeOfLeader } from '@/lib/domain/map-filters';
import { relatorioDeGente, votosPorSecao } from '@/lib/domain/secoes-com-gente';

const lider = (id: string, name: string, sections: { zone: string | null; section: string | null; total: number }[]) => ({
  id,
  name,
  total: sections.reduce((t, s) => t + s.total, 0),
  men: 0,
  women: 0,
  others: 0,
  sections,
});

const escola = (
  locationId: string,
  title: string,
  sections: { zone: string | null; section: string | null; total: number }[],
  leaders: ReturnType<typeof lider>[],
): PollingPlacePin => ({
  locationId,
  latitude: 0,
  longitude: 0,
  title,
  address: 'Rua A',
  city: 'Arapiraca',
  state: 'AL',
  imageUrl: null,
  total: sections.reduce((t, s) => t + s.total, 0),
  men: 0,
  women: 0,
  others: 0,
  sections,
  leaders,
});

const campanha = [
  escola(
    'a',
    'ESCOLA A',
    [
      { zone: '10', section: '97', total: 3 },
      { zone: '10', section: '12', total: 5 },
      { zone: null, section: null, total: 1 },
    ],
    [
      lider('jailma', 'Jailma Souza', [
        { zone: '10', section: '12', total: 4 },
        { zone: null, section: null, total: 1 },
      ]),
      lider('beto', 'Beto Lima', [{ zone: '10', section: '97', total: 3 }]),
    ],
  ),
  escola('b', 'ESCOLA B', [{ zone: '22', section: '5', total: 12 }], [lider('jailma', 'Jailma Souza', [{ zone: '22', section: '5', total: 12 }])]),
];

describe('secoes com gente cadastrada', () => {
  it('escola por escola, do maior para o menor, com as secoes em ordem e os Lideres de cada uma', () => {
    const r = relatorioDeGente(campanha, { jailma: 'ROBERVAL' });

    expect(r.escolas.map((e) => [e.titulo, e.gente])).toEqual([
      ['ESCOLA B', 12],
      ['ESCOLA A', 9],
    ]);
    const a = r.escolas[1];
    expect(a.secoes.map((s) => [s.secao, s.gente])).toEqual([
      ['12', 5],
      ['97', 3],
    ]);
    expect(a.semSecao).toBe(1);
    // Na secao 12 a Jailma cadastrou 4 de 5: o que falta e "sem lider" no PDF.
    expect(a.secoes[0].lideres).toEqual([{ id: 'jailma', nome: 'Jailma Souza', pessoas: 4, referencia: 'ROBERVAL' }]);
    expect(a.secoes[1].lideres).toEqual([{ id: 'beto', nome: 'Beto Lima', pessoas: 3, referencia: null }]);
    expect(a.lideres.map((l) => [l.nome, l.pessoas])).toEqual([
      ['Jailma Souza', 5],
      ['Beto Lima', 3],
    ]);

    expect(r.totais).toEqual({ escolas: 2, secoes: 3, pessoas: 21, lideres: 2, votosPorCandidato: [] });
    expect(r.lideres.map((l) => [l.nome, l.pessoas, l.secoes, l.escolas])).toEqual([
      ['Jailma Souza', 17, 2, 2],
      ['Beto Lima', 3, 1, 1],
    ]);
  });

  it('com o filtro de Lider no mapa, so as secoes onde ELE tem gente', () => {
    const doBeto = campanha.map((p) => placeOfLeader(p, 'beto')).filter((p): p is PollingPlacePin => p !== null);
    const r = relatorioDeGente(doBeto);

    expect(r.escolas).toHaveLength(1);
    expect(r.escolas[0].secoes.map((s) => [s.zona, s.secao, s.gente])).toEqual([['10', '97', 3]]);
    expect(r.totais).toEqual({ escolas: 1, secoes: 1, pessoas: 3, lideres: 1, votosPorCandidato: [] });
    // Sem as referencias do time, o PDF nao mostra o selo.
    expect(r.escolas[0].secoes[0].lideres[0]).not.toHaveProperty('referencia');
  });

  it('com zona no filtro, so as secoes dela (e quem nao tem zona no cadastro fica de fora)', () => {
    const r = relatorioDeGente(campanha, undefined, '010');

    expect(r.escolas.map((e) => e.titulo)).toEqual(['ESCOLA A']);
    expect(r.escolas[0].gente).toBe(8);
    expect(r.escolas[0].semSecao).toBe(0);
    expect(r.lideres.map((l) => [l.nome, l.pessoas])).toEqual([
      ['Jailma Souza', 4],
      ['Beto Lima', 3],
    ]);
  });

  it('com candidatos, cada secao com gente traz os votos de cada um (0 onde ele nao teve voto)', () => {
    // Votacao do TSE: a zona escrita "010" e a secao 97 sao a mesma secao do cadastro.
    const federal = votosPorSecao([
      { sections: [{ zone: '010', section: '97', total: 40 }, { zone: '22', section: '5', total: 7 }] },
      { sections: [{ zone: '10', section: '97', total: 2 }, { zone: '30', section: '1', total: 99 }] },
    ]);
    const estadual = votosPorSecao([{ sections: [{ zone: '10', section: '12', total: 15 }] }]);
    const r = relatorioDeGente(campanha, undefined, null, [federal, estadual]);

    // As secoes continuam sendo as com gente: a 30/1 so tem voto e nao entra.
    expect(r.escolas.flatMap((e) => e.secoes.map((s) => [s.zona, s.secao, s.votos]))).toEqual([
      ['22', '5', [7, 0]],
      ['10', '12', [0, 15]],
      ['10', '97', [42, 0]],
    ]);
    expect(r.escolas.map((e) => [e.titulo, e.votosNasSecoes])).toEqual([
      ['ESCOLA B', [7, 0]],
      ['ESCOLA A', [42, 15]],
    ]);
    expect(r.totais.votosPorCandidato).toEqual([49, 15]);
    // A escala da escola cobre a maior barra, de gente ou de voto.
    expect(r.escolas[1].escala).toBe(42);
  });
});
