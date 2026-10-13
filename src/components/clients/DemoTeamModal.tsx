'use client';

import { useRef, useState } from 'react';
import { FlaskConical, Plus, Trash2 } from 'lucide-react';
import type { ClientSummary, TeamAccessLinks } from '@/lib/types';
import { DEMO_DEFAULTS, DEMO_LIMITS } from '@/lib/domain/demo';
import { DEMO_CITIES, DEMO_POLLING_PLACES } from '@/lib/domain/demo-catalog';
import {
  DEMO_RECRUITERS_DEFAULT,
  DEMO_RECRUITERS_MAX,
} from '@/lib/domain/demo-recruiters';
import { api } from '@/lib/repositories/http/api';
import { createId } from '@/lib/utils/id';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { PhotoUpload } from '@/components/common/PhotoUpload';
import { BannerUpload } from '@/components/common/BannerUpload';
import { completarMapaDemo, useDemoCatalogo, type ProgressoDoMapa } from './demo-mapa';

/**
 * Criacao do Time DEMO. EXCLUSIVO do ADMIN geral.
 *
 * O time nasce pronto para apresentacao — administradores, pessoas,
 * enderecos, locais de votacao e mapa —, mas nao e uma tela falsa: ele usa
 * as mesmas paginas, servicos e tabelas de um time real, e por isso abre no
 * proprio endereco do time quando termina.
 *
 * A chave de idempotencia nasce AQUI, uma por tentativa, e e reservada no
 * banco antes de qualquer escrita: dois cliques no botao nao criam dois
 * times. Ela so e trocada depois de uma criacao concluida — repetir depois
 * de uma falha reaproveita a mesma chave, e o servidor sabe que a anterior
 * nao terminou.
 */

interface DemoAdmin {
  key: string;
  name: string;
  phone: string;
  photo: string | null;
}

interface DemoTeamModalProps {
  onClose: () => void;
  /** Recebe o time criado, com os enderecos de acesso. */
  onCreated: (result: { client: ClientSummary; accessLinks: TeamAccessLinks | null }) => void;
}

function novoAdministrador(): DemoAdmin {
  return { key: createId('adm'), name: '', phone: '', photo: null };
}

export function DemoTeamModal({ onClose, onCreated }: DemoTeamModalProps) {
  const toast = useToast();

  const [name, setName] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [admins, setAdmins] = useState<DemoAdmin[]>([novoAdministrador()]);
  const [people, setPeople] = useState(String(DEMO_DEFAULTS.people));
  const [places, setPlaces] = useState(String(DEMO_DEFAULTS.places));
  const [recruiters, setRecruiters] = useState(String(DEMO_RECRUITERS_DEFAULT));
  const [recruiterPeople, setRecruiterPeople] = useState('0');
  /**
   * Chave de idempotencia desta tentativa.
   *
   * Nasce com o dialogo — que a pagina monta so quando abre, entao cada
   * abertura comeca limpa e com uma chave propria. Ela NAO e trocada a cada
   * clique: e justamente repetindo a mesma chave que um duplo envio
   * (ou um "tentar de novo" depois de uma falha) deixa de criar um segundo
   * time.
   */
  const [seedKey] = useState(() => createId('demo'));
  const [saving, setSaving] = useState(false);
  const catalogo = useDemoCatalogo();
  /**
   * Depois de criado, o time completa a camada "Pessoas" do mapa aqui mesmo,
   * com o progresso a vista. Nulo enquanto o time nao existe.
   */
  const [mapa, setMapa] = useState<ProgressoDoMapa | null>(null);
  const criadoRef = useRef<{ client: ClientSummary; accessLinks: TeamAccessLinks | null } | null>(
    null,
  );
  const entregueRef = useRef(false);

  /** Abre o time criado. Uma vez so, venha do fim do mapa ou do botao. */
  function abrirTime() {
    if (entregueRef.current || !criadoRef.current) return;
    entregueRef.current = true;
    onCreated(criadoRef.current);
  }

  function alterar(key: string, patch: Partial<DemoAdmin>) {
    setAdmins((atual) =>
      atual.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  }

  async function criar() {
    if (saving) return;

    const nome = name.trim();
    if (nome.length < 2) {
      toast.error('Dê um nome ao Time DEMO.');
      return;
    }

    const equipe = admins
      .map((item) => ({ name: item.name.trim(), phone: item.phone.trim(), photo: item.photo }))
      .filter((item) => item.name || item.phone);

    if (equipe.length === 0 || equipe.some((item) => !item.name || !item.phone)) {
      toast.error('Preencha nome e telefone de cada administrador.');
      return;
    }

    const pessoas = Number(people);
    const locais = Number(places);
    if (!Number.isInteger(pessoas) || !Number.isInteger(locais)) {
      toast.error('Informe apenas números inteiros nas quantidades.');
      return;
    }

    setSaving(true);
    try {
      const result = await api<{ client: ClientSummary; accessLinks: TeamAccessLinks }>(
        '/api/clients/demo',
        {
          method: 'POST',
          body: {
            name: nome,
            photo,
            banner,
            admins: equipe,
            people: pessoas,
            places: locais,
            recruiters: Number(recruiters) || 0,
            recruiterPeople: Number(recruiterPeople) || 0,
            // Repetir a requisicao com esta chave devolve o mesmo time.
            seedKey,
          },
        },
      );

      toast.success('Time DEMO criado com sucesso.');
      criadoRef.current = { client: result.client, accessLinks: result.accessLinks ?? null };

      // As escolas ja nascem no mapa (coordenada oficial do TSE). As ruas de
      // moradia que nao couberam no prazo da criacao sao completadas agora,
      // com o progresso a vista — e o botao "Abrir o time agora" pula isso.
      setMapa({ resolvidos: 0, faltam: 0 });
      await completarMapaDemo(result.client.id, setMapa, () => entregueRef.current);
      abrirTime();
    } catch (falha) {
      toast.error(
        falha instanceof Error && falha.message
          ? falha.message
          : 'Não foi possível criar o Time DEMO.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      busy={saving}
      title="Criar Time DEMO"
      description="Um time completo para apresentação: pessoas, endereços, locais de votação e mapa. Os dados são fictícios e ficam fora dos números reais."
      footer={
        mapa ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button onClick={abrirTime}>Abrir o time agora</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void criar()} loading={saving}>
              {!saving ? <FlaskConical aria-hidden="true" className="size-4" /> : null}
              {saving ? 'Criando Time DEMO...' : 'Criar Time DEMO'}
            </Button>
          </div>
        )
      }
    >
      <div className="space-y-5">
        {mapa ? (
          <div
            role="status"
            className="space-y-1 rounded-control border border-line bg-brand-50 p-3 text-sm text-brand-800"
          >
            <p className="flex items-center gap-2 font-medium">
              <Spinner className="size-4" />
              Time criado. Completando o mapa das pessoas...
            </p>
            <p className="text-xs text-brand-700">
              {mapa.resolvidos > 0 || mapa.faltam > 0
                ? `${mapa.resolvidos} pessoa(s) já no mapa${mapa.faltam > 0 ? `, ${mapa.faltam} a caminho` : ''}.`
                : 'As escolas já estão no mapa; agora as ruas onde as pessoas moram.'}{' '}
              Pode abrir o time agora: o que faltar continua em &quot;Refazer dados&quot;.
            </p>
          </div>
        ) : saving ? (
          <p className="flex items-center gap-2 rounded-control border border-line bg-brand-50 p-3 text-sm text-brand-800">
            <Spinner className="size-4" />
            Criando Time DEMO... gerando pessoas, endereços e locais de votação.
          </p>
        ) : null}

        <Field id="demo-nome" label="Nome do Time DEMO" required>
          <Input
            id="demo-nome"
            value={name}
            maxLength={80}
            placeholder="Time Demonstração"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <div>
          <p className="mb-2 text-sm font-medium text-ink-700">Foto do time</p>
          <PhotoUpload value={photo} onChange={setPhoto} onError={(message) => toast.error(message)} />
        </div>

        <div>
          <p className="mb-1 text-sm font-medium text-ink-700">Banner do celular</p>
          <p className="mb-2 text-xs text-ink-500">
            É o que a pessoa vê ao abrir o link de cadastro no telefone. Sem banner próprio, o
            Time DEMO mostra a faixa de convite comum — nunca o banner de produção de um time
            real. Dá para trocar depois, na página do time.
          </p>
          <BannerUpload
            value={banner}
            teamName={name || 'Time Demonstração'}
            onChange={setBanner}
            onError={(message) => toast.error(message)}
            onNotice={(message) => toast.info(message)}
          />
        </div>

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-ink-900">Administradores do time</h3>
              <p className="text-xs text-ink-500">
                Entram pelo mesmo caminho dos times reais: link do time + telefone. As pessoas
                fictícias são divididas entre eles em &quot;Cadastrado por&quot;.
              </p>
            </div>
            {/* Sem limite: quantos administradores o time precisar. */}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setAdmins((atual) => [...atual, novoAdministrador()])}
            >
              <Plus aria-hidden="true" className="size-4" />
              Adicionar administrador
            </Button>
          </div>

          <ul className="space-y-3">
            {admins.map((item, index) => (
              <li key={item.key} className="rounded-control border border-line p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-xs font-semibold tracking-wide text-ink-500 uppercase">
                    Administrador {index + 1}
                  </p>
                  {admins.length > 1 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setAdmins((atual) => atual.filter((row) => row.key !== item.key))
                      }
                      className="inline-flex min-h-9 items-center gap-1.5 text-xs font-semibold text-danger-700 hover:text-danger-600"
                    >
                      <Trash2 aria-hidden="true" className="size-3.5" />
                      Remover
                    </button>
                  ) : null}
                </div>

                <div className="mt-2 flex flex-col gap-3 sm:flex-row">
                  <div className="sm:w-40">
                    <PhotoUpload
                      value={item.photo}
                      onChange={(value) => alterar(item.key, { photo: value })}
                      onError={(message) => toast.error(message)}
                    />
                  </div>

                  <div className="flex-1 space-y-3">
                    <Field id={`demo-admin-nome-${item.key}`} label="Nome" required>
                      <Input
                        id={`demo-admin-nome-${item.key}`}
                        value={item.name}
                        maxLength={120}
                        onChange={(event) => alterar(item.key, { name: event.target.value })}
                      />
                    </Field>
                    <Field id={`demo-admin-fone-${item.key}`} label="Telefone" required>
                      <Input
                        id={`demo-admin-fone-${item.key}`}
                        value={item.phone}
                        inputMode="numeric"
                        maxLength={30}
                        placeholder="(11) 99999-0000"
                        onChange={(event) => alterar(item.key, { phone: event.target.value })}
                      />
                    </Field>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id="demo-pessoas"
            label="Pessoas fictícias"
            help={`De ${DEMO_LIMITS.minPeople} a ${DEMO_LIMITS.maxPeople}.`}
          >
            <Input
              id="demo-pessoas"
              value={people}
              inputMode="numeric"
              onChange={(event) => setPeople(event.target.value.replace(/\D/g, ''))}
            />
          </Field>

          {/* Segunda camada. OPCIONAL: zero em qualquer um dos dois numeros e
              o time nasce como sempre nasceu — todo mundo cadastrado pelo
              administrador. Ajustavel depois, na pagina do time. */}
          <Field
            id="demo-recrutadores"
            label="Pessoas que também recrutam"
            help={`Opcional, até ${DEMO_RECRUITERS_MAX}. Enche o ranking da equipe.`}
          >
            <Input
              id="demo-recrutadores"
              value={recruiters}
              inputMode="numeric"
              placeholder="0"
              onChange={(event) => setRecruiters(event.target.value.replace(/\D/g, ''))}
            />
          </Field>

          <Field
            id="demo-recrutadores-pessoas"
            label="Quantas pessoas elas trazem"
            help="Pessoas NOVAS, somadas às de cima. Entram no mapa como as outras."
          >
            <Input
              id="demo-recrutadores-pessoas"
              value={recruiterPeople}
              inputMode="numeric"
              placeholder="0"
              onChange={(event) => setRecruiterPeople(event.target.value.replace(/\D/g, ''))}
            />
          </Field>

          <Field
            id="demo-locais"
            label="Locais de votação"
            // O teto nao e uma escolha de tela: sao as escolas que existem na
            // fonte — a tabela oficial do TSE ou, sem ela, o catalogo
            // conferido. Pedir mais nao inventa a proxima.
            help={
              catalogo?.source === 'TSE'
                ? `De ${DEMO_LIMITS.minPlaces} a ${Math.min(DEMO_LIMITS.maxPlaces, catalogo.schools)}. ` +
                  `Escolas reais da tabela oficial do TSE: ${catalogo.schools.toLocaleString('pt-BR')} ` +
                  `em ${catalogo.cities} municípios de Alagoas, com zona e seção.`
                : `De ${DEMO_LIMITS.minPlaces} a ${catalogo?.schools ?? DEMO_POLLING_PLACES.length}, ` +
                  `em ${catalogo?.cities ?? DEMO_CITIES.length} municípios de Alagoas.`
            }
          >
            <Input
              id="demo-locais"
              value={places}
              inputMode="numeric"
              onChange={(event) => setPlaces(event.target.value.replace(/\D/g, ''))}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
