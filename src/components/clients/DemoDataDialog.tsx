'use client';

import { useState } from 'react';
import { api } from '@/lib/repositories/http/api';
import { DEMO_DEFAULTS, DEMO_LIMITS } from '@/lib/domain/demo';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import type { Client } from '@/lib/types';
import { completarMapaDemo, useDemoCatalogo, type ProgressoDoMapa } from './demo-mapa';

interface DemoRefreshReport {
  removed: number;
  people: number;
  places: number;
  cities: number;
  source: 'TSE' | 'CATALOGO';
  points: { resolved: number; missing: number };
}

interface DemoDataDialogProps {
  open: boolean;
  client: Client | null;
  onCancel: () => void;
  onDone?: () => void;
}

/**
 * Corrige os dados gerados de um Time DEMO ja criado.
 *
 * Existe porque a primeira versao do gerador inventava escola, endereco e
 * coordenada — e punha marcador em outro estado e no mar. Esta acao troca
 * aquela geracao pela atual, com locais de votacao reais de Alagoas e
 * coordenadas obtidas pela consulta de endereco do proprio sistema.
 *
 * O aviso diz exatamente o que sai e o que fica, porque e disso que a pessoa
 * precisa para decidir: nenhum administrador, acesso, link ou configuracao e
 * tocado, e ninguem cadastrado a mao e removido.
 */
export function DemoDataDialog({ open, client, onCancel, onDone }: DemoDataDialogProps) {
  const toast = useToast();
  const catalogo = useDemoCatalogo(open);
  // Vazio em "pessoas" mantem o tamanho atual do time: e o que a correcao
  // sempre fez, e ninguem perde gente sem pedir.
  const [people, setPeople] = useState('');
  const [places, setPlaces] = useState(String(DEMO_DEFAULTS.places));
  const [mapa, setMapa] = useState<ProgressoDoMapa | null>(null);
  if (!client) return null;

  const tetoDeEscolas = Math.min(DEMO_LIMITS.maxPlaces, catalogo?.schools ?? DEMO_LIMITS.maxPlaces);

  async function handleConfirm() {
    if (!client) return;

    const pessoas = people.trim() ? Number(people) : undefined;
    const escolas = places.trim() ? Number(places) : undefined;
    if (
      (pessoas !== undefined && !Number.isInteger(pessoas)) ||
      (escolas !== undefined && !Number.isInteger(escolas))
    ) {
      toast.error('Informe apenas números inteiros nas quantidades.');
      return;
    }

    try {
      const { report } = await api<{ report: DemoRefreshReport }>(
        `/api/clients/demo/${client.id}/dados`,
        { method: 'POST', body: { people: pessoas, places: escolas } },
      );

      // As escolas ja voltam com ponto; as ruas de moradia que nao couberam
      // no prazo sao completadas agora, com o progresso a vista.
      setMapa({ resolvidos: 0, faltam: 0 });
      const final = await completarMapaDemo(client.id, setMapa);
      setMapa(null);

      const onde =
        report.source === 'TSE'
          ? `${report.places} escolas reais do TSE em ${report.cities} municípios`
          : `${report.places} locais de Alagoas`;
      toast.success(
        final.faltam > 0
          ? `Dados refeitos: ${report.people} pessoas em ${onde}. ` +
              `${final.faltam} pessoa(s) ainda sem ponto de moradia no mapa.`
          : `Dados refeitos: ${report.people} pessoas em ${onde}.`,
      );
      onDone?.();
    } catch (falha) {
      setMapa(null);
      toast.error(
        falha instanceof Error && falha.message
          ? falha.message
          : 'Não foi possível refazer os dados do Time DEMO.',
      );
    }
  }

  return (
    <ConfirmDialog
      open={open}
      tone="brand"
      title="Refazer dados de demonstração"
      description={`As pessoas fictícias de "${client.name}" são geradas de novo, com escolas e endereços reais de Alagoas.`}
      confirmLabel="Refazer dados"
      onCancel={onCancel}
      onConfirm={handleConfirm}
      details={
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id="demo-refazer-pessoas"
              label="Pessoas fictícias"
              help={`Em branco mantém o tamanho atual. Até ${DEMO_LIMITS.maxPeople.toLocaleString('pt-BR')}.`}
            >
              <Input
                id="demo-refazer-pessoas"
                value={people}
                inputMode="numeric"
                placeholder="Manter"
                disabled={mapa !== null}
                onChange={(event) => setPeople(event.target.value.replace(/\D/g, ''))}
              />
            </Field>
            <Field
              id="demo-refazer-escolas"
              label="Escolas"
              help={
                catalogo?.source === 'TSE'
                  ? `Até ${tetoDeEscolas}, da tabela oficial do TSE.`
                  : `Até ${catalogo?.schools ?? tetoDeEscolas}.`
              }
            >
              <Input
                id="demo-refazer-escolas"
                value={places}
                inputMode="numeric"
                disabled={mapa !== null}
                onChange={(event) => setPlaces(event.target.value.replace(/\D/g, ''))}
              />
            </Field>
          </div>

          {mapa ? (
            <p role="status" className="rounded-control border border-line bg-brand-50 p-3 text-sm text-brand-800">
              Dados refeitos. Completando o mapa das pessoas...
              {mapa.resolvidos > 0 || mapa.faltam > 0
                ? ` ${mapa.resolvidos} já no mapa${mapa.faltam > 0 ? `, ${mapa.faltam} a caminho` : ''}.`
                : ''}
            </p>
          ) : null}

          <ul className="space-y-1.5 rounded-control bg-ink-50 p-3 text-sm text-ink-700">
            <li>Saem as pessoas fictícias da geração anterior, com os pinos dela.</li>
            <li>
              Entram pessoas fictícias em escolas reais de Alagoas
              {catalogo?.source === 'TSE' ? ', sorteadas da tabela oficial do TSE, com zona e seção' : ''}.
            </li>
            <li>
              <strong className="text-ink-900">Não são tocados:</strong> o time, os
              administradores, os acessos deles, os links, o formulário e as configurações.
            </li>
            <li>Ninguém cadastrado à mão neste time é removido.</li>
          </ul>
        </div>
      }
    />
  );
}
