import { ehVerificacao } from '@/lib/domain/verificacoes-de-inconsistencia';
import { z } from 'zod';
import { appConfig } from '@/config/app.config';
import { API_KEY_NAME_MAX } from '@/lib/domain/api-key';
import { DEMO_DEFAULTS, DEMO_LIMITS } from '@/lib/domain/demo';
import {
  DEMO_RECRUITERS_DEFAULT,
  DEMO_RECRUITERS_MAX,
} from '@/lib/domain/demo-recruiters';
import { FIELD_TYPES, SYSTEM_FIELD_KEYS } from '@/lib/types';
import {
  GENDER_VALUES,
  SECTION_MAX_LENGTH,
  UF_OPTIONS,
  ZONE_MAX_LENGTH,
  isValidCpf,
} from '@/lib/utils/documents';
import { isValidPhone, normalizePhone } from '@/lib/utils/phone';

/**
 * Validacao de tudo que chega ao servidor.
 *
 * Nenhuma rota confia no navegador: o corpo de cada requisicao passa por um
 * destes esquemas antes de tocar no banco ou no Storage.
 */

/** Data URL de imagem ja comprimida, ou a URL assinada devolvida antes. */
const photoValue = z
  .string()
  .max(Math.ceil(appConfig.limits.maxStoredImageBytes * 1.4), 'Imagem muito grande.')
  .nullable();

const trimmed = (max: number) => z.string().trim().max(max);

/** As 27 siglas, na unica lista do sistema. Usada pelo time e pelo integrante. */
const UF_CODES = UF_OPTIONS.map((option) => option.id) as [string, ...string[]];

/**
 * Pessoa do time: registro interno do ADMIN, sem relacao com integrantes
 * recrutados nem com acesso ao sistema. `id` ausente indica pessoa nova.
 */
const MAX_TEAM_PEOPLE = 200;

const teamPersonSchema = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  name: trimmed(120).min(2, 'Informe o nome da pessoa.'),
  phone: trimmed(30)
    .min(1, 'Informe o telefone.')
    .refine((value) => isValidPhone(value), 'Telefone inválido.'),
  photo: photoValue,
});

/**
 * Cadastro do time.
 *
 * Sem e-mail: quem entra no painel do time e sempre um administrador, pelo
 * link do time + telefone. Por isso todo time novo precisa de pelo menos um.
 */
/**
 * Estado do time: a SIGLA, sempre.
 *
 * Um estado escrito a mao ("Sao Paulo", "sp ") nunca cruzaria com o endereco
 * dos integrantes, que o sistema ja grava pela sigla — e cruzar as duas
 * coisas e a razao de o campo existir. A lista e a mesma do resto do
 * sistema, e o banco repete o `check` na 038: a tela nunca e a unica
 * barreira.
 */
const ufValue = z
  .string()
  .trim()
  .toUpperCase()
  .refine((value) => UF_CODES.includes(value), 'Selecione o estado do time.');

/**
 * Municipios onde o time atua. Opcional e PLURAL, de proposito: uma operacao
 * raramente cabe em um municipio so, e obrigar a escolher um seria pedir uma
 * resposta errada. Vazio quer dizer "nao restringiu".
 */
const citiesValue = z
  .array(trimmed(120).min(1))
  .max(200, 'Municípios demais.')
  // Escolher o mesmo municipio duas vezes na tela nao pode virar dois no
  // banco.
  .transform((lista) => Array.from(new Set(lista)));

export const clientCreateSchema = z.object({
  name: trimmed(80).min(2, 'Informe o nome do time.'),
  photo: photoValue.default(null),
  notes: trimmed(500).default(''),
  // Obrigatorio no time NOVO. Na edicao (`clientUpdateSchema`) ele fica
  // opcional, porque os times criados antes da 038 nao tem estado e
  // recusa-los seria trancar a propria tela que os conserta.
  stateUf: ufValue,
  cities: citiesValue.default([]),
  people: z
    .array(teamPersonSchema)
    .min(1, 'Cadastre pelo menos um administrador do time.')
    .max(MAX_TEAM_PEOPLE),
});

/**
 * Estampa do banner: tudo em porcentagem da propria imagem.
 *
 * Os limites repetem os `check` da migration 022 — a tela nunca e a unica
 * barreira, e o banco recusa de novo o que passar daqui.
 */
export const bannerTagSchema = z.object({
  left: z.number().min(0).max(100),
  width: z.number().min(1).max(100),
  top: z.number().min(0).max(100),
  size: z.number().min(0.3).max(20),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Informe uma cor em hexadecimal, como #0b5c2c.'),
});

/**
 * Edicao do time: SO o que foi enviado.
 *
 * `photo` e `notes` sao redeclarados SEM `.default()`, e essa e a linha
 * inteira do arquivo que importa aqui.
 *
 * `.partial()` torna o campo opcional, mas NAO tira o `.default()` que ele
 * herda de `clientCreateSchema`: com a chave ausente, o padrao e aplicado
 * do mesmo jeito. Na criacao isso esta certo — time novo sem foto e
 * `photo: null`. Numa edicao PARCIAL vira outra coisa: salvar so a estampa
 * do banner chegava ao servidor como
 *
 *     { bannerTag: {...}, photo: null, notes: '' }
 *
 * e `photo: null` nao quer dizer "nao mexi", quer dizer "REMOVA A FOTO" —
 * `updateClient` apagava a imagem do Storage e zerava a coluna. `notes: ''`
 * levava as anotacoes junto, sem ninguem notar. Mexer no banner apagava a
 * foto do time.
 *
 * Por isso a edicao nao herda padrao NENHUM: aqui, ausente tem de continuar
 * ausente ate o servico, que e quem sabe que `null` remove, data URL sobe
 * imagem nova, e qualquer outro valor e a URL assinada de antes — "nao
 * mudou". `memberUpdateSchema` ja fazia assim, redeclarando os campos em
 * vez de derivar do schema de criacao.
 */
export const clientUpdateSchema = clientCreateSchema.partial().extend({
  photo: photoValue.optional(),
  notes: trimmed(500).optional(),
  // Mesmo motivo do `photo` e do `notes` acima: `.partial()` nao tira o
  // `.default([])` herdado, e uma edicao que nao mandou municipio nenhum
  // apagaria a lista do time sem ninguem pedir.
  cities: citiesValue.optional(),
  bannerTag: bannerTagSchema.optional(),
  banner: photoValue.optional(),
});

const fieldOptionSchema = z.object({
  id: z.string().min(1).max(64),
  label: trimmed(80),
});

const customFieldSchema = z.object({
  id: z.string().min(1).max(64),
  // O servidor preserva o `system_key` gravado: o valor enviado nunca troca
  // um campo padrao de lugar. A lista completa fica em SYSTEM_FIELD_KEYS.
  systemKey: z.enum(SYSTEM_FIELD_KEYS).nullable(),
  type: z.enum(FIELD_TYPES),
  label: trimmed(80),
  placeholder: trimmed(80),
  helpText: trimmed(160),
  required: z.boolean(),
  enabled: z.boolean(),
  order: z.number().int().min(0).max(999),
  options: z.array(fieldOptionSchema).max(appConfig.limits.maxOptionsPerField),
});

const privacySchema = z.object({
  enabled: z.boolean(),
  title: trimmed(80),
  text: trimmed(4000),
  requireConsent: z.boolean(),
  consentLabel: trimmed(200),
});

export const formUpdateSchema = z
  .object({
    fields: z.array(customFieldSchema).max(appConfig.limits.maxFieldsPerForm),
    privacy: privacySchema,
    introText: trimmed(1000),
    successMessage: trimmed(200),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Nada para atualizar.');

export const inviteActiveSchema = z.object({ active: z.boolean() });

const fieldValueSchema = z.union([
  z.string().max(4000),
  z.number(),
  z.boolean(),
  z.array(z.string().max(200)).max(appConfig.limits.maxOptionsPerField),
  z.null(),
]);

const responsesSchema = z
  .array(z.object({ fieldId: z.string().min(1).max(64), value: fieldValueSchema }))
  .max(appConfig.limits.maxFieldsPerForm);


/** Vazio conta como nao informado, e nao como valor invalido. */
const opcional = <T extends z.ZodType>(schema: T) =>
  z
    .union([schema, z.literal(''), z.null()])
    .optional()
    .transform((value) => (value === '' || value === undefined ? null : value));

/**
 * So os digitos do que veio, ou nulo.
 *
 * CPF, titulo, zona e secao entram como vierem — com digito a menos, a mais
 * ou que nao fecham. NADA disso recusa o cadastro: a pessoa entra e a ficha
 * nasce com a etiqueta "Conferir" (`domain/conferencia.ts`). O limite de
 * tamanho e so o que o banco guarda; a normalizacao final acontece no
 * servico, antes de gravar.
 */
const numeros = (maximo: number) =>
  opcional(
    z
      .string()
      .trim()
      .max(40)
      .transform((value) => value.replace(/\D/g, '').slice(0, maximo) || null),
  );

/** Campos padrao com regra brasileira. Todos opcionais, e nenhum barra. */
const standardMemberFields = {
  gender: opcional(z.enum(GENDER_VALUES)),
  cpf: numeros(14),
  voterId: numeros(14),
  zone: numeros(ZONE_MAX_LENGTH + 4),
  section: numeros(SECTION_MAX_LENGTH + 4),
  state: opcional(z.string().trim().toUpperCase().pipe(z.enum(UF_CODES))),
  city: opcional(z.string().trim().min(1).max(120)),
  district: opcional(z.string().trim().min(1).max(120)),
  street: opcional(z.string().trim().min(1).max(120)),
  relationshipOptionId: opcional(z.string().trim().max(64).regex(/^[A-Za-z0-9_-]+$/)),
  relationshipLabel: opcional(z.string().trim().min(1).max(80)),
};

/**
 * Telefone do integrante: campo padrao obrigatorio.
 *
 * E ele que identifica a pessoa no acesso pelo link do time, mas o cadastro
 * nao para por causa de um digito faltando: o numero incompleto entra, e
 * quem fica sem acesso e so ele, ate o ADMIN corrigir o numero na ficha.
 * A normalizacao (somente digitos) acontece no servico, antes de gravar e
 * antes de qualquer comparacao.
 *
 * O e-mail saiu do cadastro: o integrante nao tem endereco nem senha. Os
 * enderecos ja gravados sao preservados, mas nao autenticam ninguem.
 */
const memberPhone = trimmed(30)
  .min(1, 'Informe o telefone.')
  // Qualquer quantidade de digitos entra: o incompleto ganha a etiqueta
  // "Conferir" e fica sem acesso ao painel ate ser corrigido.
  .refine((value) => normalizePhone(value).length > 0, 'Use apenas números no telefone.');

/**
 * O mesmo telefone, podendo faltar por inteiro.
 *
 * Vale nos caminhos do PAINEL — cadastro a mao, Formulario 2 e planilha —,
 * onde a lista chega pronta de fora e vem com buracos. A pessoa entra sem
 * telefone, a ficha dela fica marcada como incompleta e o acesso so nasce
 * quando o numero for preenchido.
 *
 * No FORMULARIO PUBLICO continua obrigatorio: ali quem preenche e a propria
 * pessoa, com o telefone na mao, e e por ele que ela entra depois.
 *
 * SEM `default` aqui: em `memberUpdateSchema`, que e `.partial()`, um valor
 * de fabrica faria a chave aparecer mesmo quando ninguem a enviou — e
 * editar so o nome APAGARIA o telefone da pessoa. Quem cria e que aplica o
 * `default('')`, onde a ausencia realmente significa "sem telefone".
 */
const memberPhoneOpcional = z.union([memberPhone, z.literal('')]);

/** Campos comuns ao cadastro pelo painel e pelo link publico. */
const memberBase = {
  ...standardMemberFields,
  name: trimmed(120).min(2, 'Informe o nome completo.'),
  phone: memberPhone,
  photo: photoValue.default(null),
  responses: responsesSchema.default([]),
  consentAt: z.iso.datetime().nullable().default(null),
};

export const memberCreateSchema = z.object({
  clientId: z.uuid('Time inválido.'),
  ...memberBase,
  // Cadastro pelo painel: o telefone pode faltar (ver `memberPhoneOpcional`).
  phone: memberPhoneOpcional.default(''),
  /**
   * Veio de uma planilha (cadastro em lote).
   *
   * Muda UMA coisa, e nao afrouxa permissao nenhuma: telefone ja usado no
   * time deixa de recusar a pessoa e passa a apenas nao criar o acesso
   * dela. Em uma lista de mutirao, familia que compartilha numero e comum, e
   * perder a segunda pessoa e pior do que registra-la sem acesso.
   */
  bulkImport: z.boolean().default(false),
  /** "VERIFICADO POR FOTO" da planilha (migration 050). Nulo: nao informado. */
  photoVerified: z.boolean().nullable().default(null),
  /** "REFERÊNCIA" da planilha (migration 051). Vazio: a pessoa nao tem. */
  reference: z.string().trim().max(200).nullable().default(null),
});

export const memberUpdateSchema = z
  .object({
    ...standardMemberFields,
    name: trimmed(120).min(2, 'Informe o nome completo.'),
    // Corrigir a ficha inclui APAGAR um numero errado: quem edita esta
    // olhando para o cadastro e sabe o que esta fazendo.
    phone: memberPhoneOpcional,
    photo: photoValue,
    responses: responsesSchema,
    consentAt: z.iso.datetime().nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Nada para atualizar.');

/**
 * Sinais tecnicos do aparelho enviados pela pagina publica.
 *
 * Tudo opcional: a ausencia de qualquer campo nunca impede o cadastro.
 * O que vem de cabecalho (User-Agent, Client Hints, IP, geo) e lido no
 * servidor e nao entra neste esquema.
 */
export const deviceSignalsSchema = z
  .object({
    platform: trimmed(64),
    isMobile: z.boolean(),
    language: trimmed(32),
    timezone: trimmed(64),
    screenWidth: z.number().int().min(1).max(100000),
    screenHeight: z.number().int().min(1).max(100000),
    maxTouchPoints: z.number().int().min(0).max(64),
  })
  .partial();

/**
 * Acesso pelo link do time: apenas o telefone.
 *
 * Atende os dois perfis daquele time — Administrador do time e membro da
 * equipe. O token vem da propria URL e nunca do corpo; o telefone e
 * normalizado no servidor antes de qualquer comparacao.
 */
export const teamPhoneLoginSchema = z.object({
  phone: trimmed(30).min(1, 'Informe o telefone.'),
  /**
   * Sinais do aparelho, apenas para auditoria do vinculo. Quem autoriza o
   * acesso e a credencial secreta do cookie: nada daqui decide nada, e
   * qualquer campo fora desta lista e descartado.
   */
  device: deviceSignalsSchema.optional(),
});

/**
 * Complementacao dos sinais do aparelho do primeiro acesso ao convite.
 *
 * Reaproveita exatamente o mesmo esquema do restante do sistema: nenhum
 * campo novo e aceito. O convite e a reserva vem dos cookies `HttpOnly`,
 * nunca do corpo.
 */
const inviteClickSignalsSchema = deviceSignalsSchema
  .extend({
    /** Area visivel da pagina, em pixels. So existe no clique (migration 021). */
    viewportWidth: z.number().int().min(1).max(100000),
    viewportHeight: z.number().int().min(1).max(100000),
    /** Idiomas do navegador, ja juntados pela pagina. */
    languages: trimmed(128),
  })
  .partial();

export const inviteDeviceSignalsSchema = z.object({
  device: inviteClickSignalsSchema.optional(),
});

export type InviteClickSignalsInput = z.infer<typeof inviteClickSignalsSchema>;

/**
 * Comprovantes cifrados da confirmacao de CPF e titulo, feita durante o
 * preenchimento. Opacos para o navegador: ele so devolve o que recebeu.
 */
const verificationTokenSchema = z.string().min(1).max(4000).nullable().optional();

/** Confirmacao do CPF, durante o preenchimento do link publico. */
export const inviteCpfLookupSchema = z.object({
  cpf: z
    .string()
    .trim()
    .max(20)
    .refine((value) => isValidCpf(value), 'CPF inválido.'),
});

/** Confirmacao do titulo de eleitor: usa o token da confirmacao do CPF. */
export const inviteTseLookupSchema = z.object({
  cpfToken: z.string().min(1).max(4000).nullable(),
});

/** Envio pelo link publico: o cliente vem do token, nunca do corpo. */
export const publicSubmissionSchema = z.object({
  ...memberBase,
  device: deviceSignalsSchema.optional(),
  cpfToken: verificationTokenSchema,
  tseToken: verificationTokenSchema,
});

/**
 * Duracao dos links, enviada pelo ADMIN.
 *
 * Quantidade inteira e unidade fechada em uma lista: nenhum texto do usuario
 * chega perto de um intervalo SQL. A conversao para segundos acontece no
 * servidor, e o banco ainda confere os limites no proprio check da coluna.
 */
export const inviteExpirationSchema = z.object({
  candidate: z.object({
    amount: z.number().int().min(1).max(525_600),
    unit: z.enum(['minutes', 'hours', 'days']),
  }),
  team: z.object({
    amount: z.number().int().min(1).max(525_600),
    unit: z.enum(['minutes', 'hours', 'days']),
  }),
});

export type InviteExpirationInputSchema = z.infer<typeof inviteExpirationSchema>;

export type DeviceSignalsInput = z.infer<typeof deviceSignalsSchema>;

export type ClientCreateInput = z.infer<typeof clientCreateSchema>;
export type FormUpdateInput = z.infer<typeof formUpdateSchema>;
export type MemberCreateInput = z.infer<typeof memberCreateSchema>;
export type PublicSubmissionInput = z.infer<typeof publicSubmissionSchema>;

/* -------------------------------------------------------------------------
   Questionario do time (migration 023)
   ------------------------------------------------------------------------- */

/**
 * Pergunta do questionario.
 *
 * Sem `systemKey` e sem o tipo `photo`: toda pergunta e livre, e o
 * questionario nao recebe arquivo. O banco recusa `photo` de qualquer forma;
 * aqui a recusa chega com mensagem legivel.
 */
const surveyFieldSchema = z.object({
  id: z.string().min(1).max(64),
  // Campo padrao correspondente (migration 026). No Formulario 2 ele decide
  // apenas o desenho e a validacao — mascara, lista de genero e de UF, envio
  // da foto. Nenhuma consulta externa e acionada.
  systemKey: z.enum(SYSTEM_FIELD_KEYS).nullable().optional().default(null),
  type: z.enum(FIELD_TYPES),
  label: trimmed(80),
  placeholder: trimmed(80),
  helpText: trimmed(160),
  required: z.boolean(),
  enabled: z.boolean(),
  order: z.number().int().min(0).max(999),
  options: z.array(fieldOptionSchema).max(appConfig.limits.maxOptionsPerField),
});

/** Configuracao enviada pelo ADMIN geral. Tudo opcional: so o que mudou. */
export const surveyUpdateSchema = z
  .object({
    active: z.boolean(),
    title: z.string().trim().min(1, 'O Formulário 2 precisa de um título.').max(120),
    introText: trimmed(2000),
    successMessage: trimmed(400),
    fields: z.array(surveyFieldSchema).max(appConfig.limits.maxFieldsPerForm),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Nada para atualizar.');

/**
 * Valor de uma resposta do Formulario 2.
 *
 * Igual ao do cadastro, com uma diferenca: o texto pode ser uma imagem
 * embutida (data URL) quando o campo e de foto. Por isso o limite de
 * tamanho e o da imagem, e nao o de um texto comum — com 4.000 caracteres o
 * envio de qualquer foto seria recusado antes de chegar ao servidor.
 */
const surveyValueSchema = z.union([
  z.string().max(Math.ceil(appConfig.limits.maxStoredImageBytes * 1.4)),
  z.number(),
  z.boolean(),
  z.array(z.string().max(200)).max(appConfig.limits.maxOptionsPerField),
  z.null(),
]);

/**
 * Resposta enviada pelo link publico.
 *
 * Nome e telefone de quem respondeu, e nada mais: o time, o remetente e o
 * rotulo de cada campo sao resolvidos no servidor, a partir do token do
 * link.
 */
export const surveyAnswerSchema = z.object({
  name: z.string().trim().min(2, 'Informe seu nome.').max(120),
  phone: z
    .string()
    .trim()
    // Mesma regra do cadastro: numero incompleto entra, e nao derruba quem
    // esta respondendo.
    .refine((value) => normalizePhone(value).length > 0, 'Informe o telefone.'),
  answers: z
    .array(z.object({ fieldId: z.string().min(1).max(64), value: surveyValueSchema }))
    .max(appConfig.limits.maxFieldsPerForm),
});

/**
 * Cadastro feito pelo lider com o FORMULARIO 2, dentro do painel
 * (migration 044).
 *
 * Duas metades, e elas vao para lugares diferentes de proposito: o que e
 * campo padrao vira o INTEGRANTE — e por isso a pessoa aparece na equipe de
 * quem a cadastrou —, e `answers` sao as perguntas proprias do Formulario 2,
 * que continuam na tabela de respostas.
 *
 * Sem `clientId`: o time vem da sessao. Sem `responses`: pergunta do
 * Formulario 2 nao e resposta de integrante, e o banco recusaria.
 */
export const surveyMemberSchema = z.object({
  ...standardMemberFields,
  name: trimmed(120).min(2, 'Informe o nome completo.'),
  // Tambem e caminho de painel, e a planilha passa por ele.
  phone: memberPhoneOpcional.default(''),
  /** Veio de uma planilha: telefone repetido nao recusa a pessoa. */
  bulkImport: z.boolean().default(false),
  /** "VERIFICADO POR FOTO" da planilha (migration 050). Nulo: nao informado. */
  photoVerified: z.boolean().nullable().default(null),
  /** "REFERÊNCIA" da planilha (migration 051). Vazio: a pessoa nao tem. */
  reference: z.string().trim().max(200).nullable().default(null),
  photo: photoValue.default(null),
  consentAt: z.iso.datetime().nullable().default(null),
  answers: z
    .array(z.object({ fieldId: z.string().min(1).max(64), value: surveyValueSchema }))
    .max(appConfig.limits.maxFieldsPerForm)
    .default([]),
});

export type SurveyMemberInput = z.infer<typeof surveyMemberSchema>;


/**
 * Destino de quem chega ao dominio publico sem um link valido.
 *
 * Vazio desliga o redirecionamento. Preenchido, tem de ser um endereco
 * absoluto `http(s)`: qualquer outro esquema — `javascript:`, `data:` —
 * viraria um redirecionamento perigoso em uma tela que qualquer pessoa
 * abre. O banco confere de novo, no `check` da coluna.
 */
export const publicEntrySchema = z
  .object({
    redirectUrl: z
      .string()
      .trim()
      .max(2000)
      .refine(
        (value) => value === '' || /^https?:\/\/[^\s]+$/.test(value),
        'Informe um endereço completo, começando com http:// ou https://.',
      ),
    /**
     * Endereco publico usado nos links enviados. So esquema, dominio e, se
     * houver, porta: um valor com caminho montaria um link quebrado em cada
     * convite. Vazio manda deduzir do proprio painel.
     */
    linkOrigin: z
      .string()
      .trim()
      .max(255)
      .refine(
        (value) => value === '' || /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?\/?$/.test(value),
        'Informe apenas o endereço, como https://www.seudominio.com.br.',
      ),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Nada para atualizar.');

/* -------------------------------------------------------------------------
   API de links de cadastro (migrations 029, 030 e 031)
   ------------------------------------------------------------------------- */

/**
 * Criacao de chave da API, so pelo ADMIN geral.
 *
 * Nome, time e administrador chegam juntos: nao existe chave sem vinculo. O
 * segredo nao passa por aqui — ele nasce no servidor.
 *
 * Quem confere se o administrador existe, esta ativo, tem o perfil certo e
 * pertence AQUELE time e o banco, em `createApiKey`: a tela nunca decide
 * vinculo.
 */
export const apiKeyCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Dê um nome para identificar a chave.')
    .max(API_KEY_NAME_MAX, `O nome deve ter até ${API_KEY_NAME_MAX} caracteres.`),
  clientId: z.string().trim().min(1, 'Escolha o time.').max(64, 'Identificador inválido.'),
  actingUserId: z
    .string()
    .trim()
    .min(1, 'Escolha o administrador do time.')
    .max(64, 'Identificador inválido.'),
});

/* -------------------------------------------------------------------------
   Time DEMO (migration 033)
   ------------------------------------------------------------------------- */

/**
 * Criacao do Time DEMO, so pelo ADMIN geral.
 *
 * Os administradores chegam como em qualquer time: nome, telefone e foto
 * opcional — e o acesso deles e o mesmo dos times reais (link do time +
 * telefone). As quantidades tem teto para uma apresentacao nao virar uma
 * carga de milhares de linhas por engano.
 *
 * `seedKey` e a chave de idempotencia criada pelo navegador: e ela que
 * impede um duplo clique de criar dois times.
 */
/** Chave de acesso do Time DEMO: so o valor, e nada mais. */
export const demoAccessSchema = z.object({ enabled: z.boolean() });

/**
 * Duplicar um time (migration 049). O nome e opcional: vazio, a copia se
 * chama "<nome do oficial> (duplicado)".
 */
/**
 * Planilha do Google Sheets do time duplicado (migration 052): o
 * interruptor e o link. O link e conferido e limpo no servidor.
 */
export const sheetSettingsSchema = z.object({
  enabled: z.boolean(),
  url: z.string().trim().max(500).default(''),
});

export const teamDuplicateSchema = z.object({
  name: trimmed(120).optional().default(''),
});

/**
 * Quantidade de links de um lote (migration 043).
 *
 * Sem teto de produto: quem pede e o painel do ADMIN, e nao cabe ao sistema
 * dizer quantas pessoas uma equipe vai convidar hoje. O numero grande existe
 * so para o corpo da requisicao ter um fim — e um limite de maquina, nao uma
 * regra de negocio.
 */
export const inviteBatchSchema = z.object({
  quantidade: z.number().int().min(1, 'Gere ao menos um link.').max(10_000),
});

/** Confirmacao de dados pela FonteData (migration 041): so o valor. */
export const verificationToggleSchema = z.object({ enabled: z.boolean() });

/** Verificacoes de inconsistencia desligadas no time (053): so ids conhecidos. */
export const inconsistenciasDesligadasSchema = z.object({
  desligadas: z
    .array(z.string().max(40))
    .max(50)
    .refine((ids) => ids.every(ehVerificacao), 'Verificação desconhecida.'),
});

export const demoTeamCreateSchema = z.object({
  name: trimmed(80).min(2, 'Dê um nome ao Time DEMO.'),
  photo: photoValue.default(null),
  // Banner do celular do proprio Time DEMO. Sem ele, a tela publica do time
  // cai na faixa de convite comum — nunca no banner de producao de um
  // cliente real.
  banner: photoValue.default(null),
  admins: z
    .array(
      z.object({
        name: trimmed(120).min(2, 'Informe o nome do administrador.'),
        phone: trimmed(30)
          .min(1, 'Informe o telefone.')
          .refine((value) => isValidPhone(value), 'Telefone inválido.'),
        photo: photoValue.default(null),
      }),
    )
    // Sem teto: sao cadastrados um a um pelo ADMIN geral, e cada um passa
    // pelas mesmas regras de nome e telefone de qualquer time.
    .min(1, 'Cadastre pelo menos um administrador do time.'),
  people: z
    .number()
    .int('Informe um número inteiro de pessoas.')
    .min(DEMO_LIMITS.minPeople)
    .max(DEMO_LIMITS.maxPeople, `O máximo é ${DEMO_LIMITS.maxPeople} pessoas.`)
    .default(DEMO_DEFAULTS.people),
  /**
   * Segunda camada: quantas pessoas do time TAMBEM recrutam.
   *
   * OPCIONAL, e zero por padrao — um Time DEMO continua nascendo de uma
   * camada so, como sempre nasceu. Quem quiser a segunda pede aqui, ou
   * ajusta depois na pagina do time, quantas vezes quiser.
   */
  recruiters: z
    .number()
    .int('Informe um número inteiro.')
    .min(0)
    .max(DEMO_RECRUITERS_MAX, `O máximo é ${DEMO_RECRUITERS_MAX}.`)
    .default(DEMO_RECRUITERS_DEFAULT),
  /** Quantas pessoas a segunda camada traz. Zero em qualquer um dos dois
   *  numeros deixa o time com uma camada so. */
  recruiterPeople: z
    .number()
    .int('Informe um número inteiro de pessoas.')
    .min(0)
    .max(DEMO_LIMITS.maxPeople, `O máximo é ${DEMO_LIMITS.maxPeople} pessoas.`)
    .default(0),
  places: z
    .number()
    .int('Informe um número inteiro de locais.')
    .min(DEMO_LIMITS.minPlaces)
    .max(DEMO_LIMITS.maxPlaces, `O máximo é ${DEMO_LIMITS.maxPlaces} locais de votação.`)
    .default(DEMO_DEFAULTS.places),
  seedKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,64}$/, 'Chave de criação inválida.'),
});

/**
 * "Refazer dados" de um Time DEMO: o tamanho da nova geracao. Os dois sao
 * opcionais — sem eles, a correcao mantem o tamanho do time e usa o padrao
 * de escolas, como sempre fez.
 */
export const demoRefreshSchema = z.object({
  people: z
    .number()
    .int('Informe um número inteiro de pessoas.')
    .min(DEMO_LIMITS.minPeople)
    .max(DEMO_LIMITS.maxPeople, `O máximo é ${DEMO_LIMITS.maxPeople} pessoas.`)
    .optional(),
  places: z
    .number()
    .int('Informe um número inteiro de locais.')
    .min(DEMO_LIMITS.minPlaces)
    .max(DEMO_LIMITS.maxPlaces, `O máximo é ${DEMO_LIMITS.maxPlaces} locais de votação.`)
    .optional(),
});

/**
 * Segunda camada do Time DEMO, ajustada depois da criacao.
 *
 * Dois numeros: quantas pessoas recrutam, e quantas elas TRAZEM. O segundo e
 * gente nova — a segunda camada acrescenta ao time, nao reparte quem ja
 * estava nele.
 */
export const demoRecruitersSchema = z.object({
  recruiters: z
    .number()
    .int('Informe um número inteiro.')
    .min(0)
    .max(DEMO_RECRUITERS_MAX, `O máximo é ${DEMO_RECRUITERS_MAX}.`),
  people: z
    .number()
    .int('Informe um número inteiro de pessoas.')
    .min(0)
    .max(DEMO_LIMITS.maxPeople, `O máximo é ${DEMO_LIMITS.maxPeople} pessoas.`),
});
