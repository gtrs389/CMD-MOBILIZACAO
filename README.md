# Cadastro Mobilização Digital (CMD)

Sistema de cadastro e gerenciamento de equipes. O ADMIN cadastra clientes, monta
o formulário de cada cliente e compartilha um link individual de convite; quem
recebe o link preenche o cadastro pelo celular, de qualquer aparelho, e o
registro aparece no painel do ADMIN.

Nos espaços compactos o sistema aparece como **CMD**; o nome completo fica no
login e nos títulos principais. Nome, logotipo e textos institucionais ficam em
`src/config/app.config.ts`. A paleta e os demais tokens visuais ficam no bloco
`TOKENS DE IDENTIDADE VISUAL` de `src/app/globals.css`.

---

## Banco de dados

A fonte oficial dos dados é o **Supabase**. Todo acesso acontece no servidor do
Next.js, por Route Handlers e serviços `server-only`. **Nenhuma tela ou
componente cliente consulta o Supabase diretamente.**

O projeto **não usa Supabase Authentication** em nenhum ponto: nada de
`supabase.auth`, `auth.users`, Auth.js, usuários criados pelo painel
Authentication ou políticas baseadas em `auth.uid()`. Usuários, níveis de
acesso, senhas e sessões vivem nas tabelas `cmd_users` e `cmd_sessions`.

O `localStorage` permanece apenas para o rascunho temporário do formulário
público, apagado assim que o cadastro é enviado.

Antes de rodar, siga [`supabase/SETUP.md`](supabase/SETUP.md): ele traz a ordem
exata dos SQLs, como gerar o hash do primeiro ADMIN e como configurar as
variáveis na Vercel.

### Tabelas

| Tabela | Papel |
| --- | --- |
| `cmd_users` | Usuários do painel. Senha em `scrypt$salt$hash` |
| `cmd_sessions` | Sessões ativas. Guarda apenas o hash SHA-256 do token do cookie |
| `cmd_clients` | Clientes e configuração do formulário público |
| `cmd_form_fields` | Campos do formulário, com `system_key` nos campos nativos |
| `cmd_members` | Integrantes cadastrados |
| `cmd_member_responses` | Respostas por campo. Chaves estrangeiras compostas impedem vínculo entre clientes diferentes |
| `cmd_invites` | Convites. Guarda apenas o hash SHA-256 do token do link |
| `cmd_api_keys` | Chaves da API de links de cadastro. Guarda apenas o hash SHA-256 do segredo |
| `cmd_api_key_events` | O que cada chave fez: operação, em nome de quem, resultado e motivo da recusa |
| `cmd_demo_seeds` | Chaves de idempotência da criação de Time DEMO |
| `cmd_impersonations` | Cada vez que o ADMIN entrou no painel de alguém: quem, em nome de quem, quando começou e quando terminou |
| `cmd_team_files` | Repositório de Arquivos de cada time (migration 059): caminho no bucket privado `cmd-arquivos`, nome, tipo, tamanho e quem enviou |

Todas ficam com RLS habilitado e **sem nenhuma policy**. O acesso de `PUBLIC`,
`anon` e `authenticated` é revogado, e o `service_role` recebe explicitamente só
o necessário. As fotos vão para o bucket privado `cmd-media`: as tabelas guardam
somente o caminho e os metadados, e o navegador recebe URLs assinadas geradas no
servidor.

O bucket não é criado por SQL. Depois da migration, rode
`npm run configurar-storage` (ou crie o bucket pelo painel, conforme o
`SETUP.md`).

O Repositório de Arquivos usa um bucket próprio, também privado:
`cmd-arquivos` (imagens, vídeos, áudios e documentos, até 500 MB por arquivo).
A migration 059 cria esse bucket, e o servidor o cria sozinho no primeiro
envio se ele ainda não existir. O arquivo vai do navegador direto para o
bucket por uma URL de envio assinada, de uso único, emitida pelo servidor
depois de conferir tipo, tamanho e permissão; o servidor confere no bucket
que o arquivo chegou antes de registrá-lo. O plano do Supabase pode impor um
teto por arquivo menor que 500 MB (no plano gratuito, 50 MB).

Junto de cada integrante que consentiu fica a evidência do aceite: data do
servidor, texto do aviso exatamente como estava valendo, hash SHA-256 desse
texto e versão do formulário. O texto canônico é montado no servidor a partir
de `cmd_clients`; nada disso vem do navegador.

### Variáveis de ambiente

| Variável | Obrigatória | Para que serve |
| --- | --- | --- |
| `SUPABASE_URL` | sim | Endereço https do projeto Supabase |
| `SUPABASE_SECRET_KEY` | sim | Chave secreta (`sb_secret_...`). Somente no servidor |
| `SUPABASE_SERVICE_ROLE_KEY` | não | Reserva legada, para projetos que ainda usam a chave `service_role` em formato JWT |

Nenhuma usa o prefixo `NEXT_PUBLIC_`. Sem elas o sistema falha de forma segura:
o login é recusado e a tela de entrada exibe o aviso de configuração ausente.
Uma chave publicável é recusada na inicialização.

Na Vercel, a chave do banco de produção vai **somente** no ambiente Production.
Preview e Development usam projetos Supabase separados ou ficam sem
configuração. O `SETUP.md` explica o motivo.

---

## Como executar

Requisitos: Node.js 20.9 ou superior.

```bash
npm install
cp .env.example .env.local     # preencha SUPABASE_URL e SUPABASE_SECRET_KEY
npm run dev                    # http://localhost:3000
```

Execute os SQLs de `supabase/` antes do primeiro login. Veja
[`supabase/SETUP.md`](supabase/SETUP.md).

### Scripts

| Comando | O que faz |
| --- | --- |
| `npm run dev` | Servidor de desenvolvimento |
| `npm run build` | Build de produção |
| `npm start` | Sobe o build de produção |
| `npm run lint` | ESLint |
| `npm run typecheck` | Gera os tipos de rota e roda `tsc --noEmit` |
| `npm test` | Testes da camada de regras (Vitest) |
| `npm run verificar` | Lint + tipos + testes + build, em sequência |
| `npm run gerar-hash` | Pergunta e-mail e senha (oculta) e imprime o SQL do ADMIN |
| `npm run configurar-storage` | Cria ou confere o bucket privado `cmd-media` pela API do Storage |
| `npm run importar-locais` | Carrega o CSV de locais de votação do TSE em `cmd_polling_places` |

---

## Autenticação própria

Somente o perfil **ADMIN** tem login e painel nesta etapa. A autenticação é
própria, sobre `cmd_users` e `cmd_sessions`.

Como funciona:

1. A tela de login envia e-mail e senha para `POST /api/auth/login`.
2. O servidor busca o usuário em `cmd_users` e confere a senha com `scrypt`,
   salt aleatório por usuário e comparação em tempo constante. O `scrypt` roda
   mesmo quando o e-mail não existe, para o tempo de resposta não denunciar
   nada.
3. Em caso de sucesso é gerado um token de sessão criptograficamente seguro.
   O banco guarda **apenas o hash SHA-256** do token; o valor original vai para
   um cookie `httpOnly`, `Secure` em produção, `SameSite=Lax`, válido por 8
   horas.
4. Cada rota administrativa confere a sessão no servidor antes de qualquer
   operação, via `requirePermission` em `src/lib/server/guard.ts`. O
   `src/proxy.ts` apenas melhora a navegação olhando a presença do cookie.

Proteções:

- `password_hash` nunca é devolvido ao navegador.
- Login inválido responde sempre com a mesma mensagem genérica.
- Cinco tentativas seguidas bloqueiam a conta por 15 minutos.
- Logout revoga a sessão no banco e limpa as sessões expiradas.
- **Não existe login padrão.** O antigo `admin@exemplo.com / equipe123` foi
  removido; sem as variáveis do Supabase, nenhum login é aceito.

### Primeiro administrador

```bash
npm run gerar-hash
```

O comando pergunta o e-mail, o nome exibido e a senha. A senha é digitada de
forma oculta e confirmada em seguida. Ao final ele imprime o `INSERT` pronto
para colar no SQL Editor do Supabase.

A senha não é aceita por argumento e o comando exige um terminal interativo:
uma senha na linha de comando ficaria no histórico do terminal e visível na
lista de processos. Ela também não aparece na tela, não é gravada em disco e não
entra em log algum, nem vai para o banco, para o repositório ou para o
navegador.

### Perfis

| Perfil | Nesta etapa |
| --- | --- |
| `ADMIN` | Login, painel, CRUD de clientes, construtor de formulário, gestão de equipes e convites |
| `CANDIDATE` | Na tela, **Administrador do time**. Entra pelo link do time + telefone e cadastra os Líderes |
| `EQUIPE` | Na tela, **Líder** ou **Equipe** — ver [Líderes e Equipe](#líderes-e-equipe) |

Quem abre o link público não vê clientes, integrantes nem qualquer área
administrativa. Toda verificação passa por `src/lib/permissions/index.ts`.

---

## Líderes e Equipe

Abaixo do Administrador do time existem dois níveis:

| Nível | Quem é | O que faz |
| --- | --- | --- |
| **Líder** | Quem o Administrador do time cadastra | Entra no painel ("Minha mobilização"), cadastra a própria Equipe e envia o Formulário 2 |
| **Equipe** | Quem um Líder cadastra | **Não cadastra ninguém** — a hierarquia termina aqui |

O Líder vê somente quem ele mesmo cadastrou. O Administrador do time vê todos,
dos dois níveis.

**O nível não é gravado.** Ele sai de quem cadastrou a pessoa
(`recruited_by_role`, que existe em todo cadastro desde a migration 012):
cadastrado por alguém do perfil `EQUIPE` — que é o Líder — é Equipe; qualquer
outra origem é Líder. Isso inclui o ADMIN geral cadastrando pela página do
time e o cadastro antigo, anterior ao rastreamento: ninguém é rebaixado a
Equipe sem evidência. Por isso quem já estava cadastrado foi reclassificado
sozinho, sem uma linha reescrita, e a troca de responsável muda o nível junto.
A regra vive em `src/lib/domain/team-tier.ts`.

No banco os dois continuam sendo o perfil `EQUIPE`. O que muda com o nível:

- **permissões** — a Equipe perde `member.create`, `invite.view`,
  `invite.renew` e `survey.send` (`permissionsOf(role, tier)`). Ela continua
  entrando no painel e vendo o que já tinha;
- **cadastro** — `createMember`, por onde passa todo cadastro (painel,
  Formulário 2, link público), recusa responsável que é da Equipe;
- **links** — quem é da Equipe não ganha link pessoal, e um link antigo dela
  para de aceitar cadastro na hora (`resolveInvite`);
- **troca de responsável** — a Equipe não recebe cadastro, e um Líder que já
  tem Equipe não passa para baixo de outro Líder (a Equipe dele ficaria num
  terceiro nível que não existe);
- **banco** — a migration `046_lideres_e_equipe.sql` repete as duas últimas
  regras num gatilho em `cmd_members`. Ela é opcional para o sistema
  funcionar (o servidor já confere tudo antes de gravar), mas fecha a porta
  para qualquer escrita que não passe pelo servidor.

**Na tela.** O perfil `EQUIPE` aparece como "Líder" (`ROLE_LABELS`) e, quando o
nível é conhecido e é Equipe, como "Equipe" (`roleLabel`). A lista do time
mostra a etiqueta de cada pessoa e filtra por nível; o quadro de ranking do
time virou **Ranking dos Líderes**, porque só eles cadastram.

**O que já estava gravado não muda.** Um cadastro feito antes da separação
por alguém que hoje é Equipe continua onde está; em "Cadastrado por" ele
aparece como `Fulano · Equipe`.

### Tag do Líder

O ADMIN geral coloca uma tag curta no Líder — "ZONA NORTE", "IGREJA" — pelo
painel do Líder ou pela ficha dele ("Colocar tag"). A tag aparece ao lado do
nome do Líder e de **cada pessoa da Equipe dele**: na lista do time, no painel
do Líder, na ficha e no Ranking dos Líderes. A busca da lista também acha pela
tag.

**Filtrar pela tag.** A lista do time ganha o seletor **Tag**, ao lado do
filtro de responsável, com cada tag do time e quantas pessoas a mostram — o
Líder e a Equipe dele juntos — e "Sem tag" por último. Clicar na tag de uma
linha filtra a lista por ela. O seletor só aparece quando algum Líder do time
tem tag, e as opções saem da própria lista (`opcoesDeTag`): tag que ninguém
mais tem some sozinha.

**Só o Líder guarda a tag** (coluna `tag` em `cmd_members`, migration
`048_tag_do_lider.sql`). A Equipe não tem cópia: o servidor lê a tag do Líder
na mesma consulta que já traz a foto e o nível dele, e ela chega em
`recruitedBy.tag`. Por isso trocar a tag do Líder muda a Equipe inteira na
hora, e passar alguém para outro Líder faz a pessoa assumir a tag do novo
Líder. A tag é gravada limpa e em maiúsculas, com até 24 caracteres; vazia
tira a tag. A rota é `PATCH /api/members/[id]/tag` (`member.update`, só ADMIN
geral), e ela recusa tag em quem é da Equipe. A regra vive em
`src/lib/domain/tag-do-lider.ts`.

---

## Rotas

| Rota | Acesso | Descrição |
| --- | --- | --- |
| `/` | Pública | Redireciona para o painel ou para o login |
| `/login` | Pública | Login do ADMIN |
| `/dashboard` | ADMIN | Totais, cadastros recentes e clientes recentes |
| `/clientes` | ADMIN | Lista, busca e CRUD de clientes |
| `/clientes/[id]` | ADMIN | Visão geral, Equipe, Formulário e Link de convite |
| `/convite/[token]` | Pública | Formulário de cadastro da equipe |
| `/api/auth/login` | Pública | Valida credenciais e abre a sessão |
| `/api/auth/logout` | Pública | Revoga a sessão e limpa o cookie |
| `/api/auth/session` | Pública | Devolve a sessão atual (recuperação visual) |
| `/api/clients` | ADMIN | Lista e cria clientes |
| `/api/clients/[id]` | ADMIN | Lê, atualiza e exclui um cliente |
| `/api/clients/[id]/form` | ADMIN | Atualiza campos, privacidade e textos |
| `/api/clients/[id]/invite` | ADMIN | Ativa/desativa e renova o convite |
| `/api/clients/[id]/invite/lote` | ADMIN | Gera vários links de cadastro de uma vez |
| `/api/questionario/resposta` | EQUIPE / time | Cadastra um integrante pelo Formulário 2, no painel |
| `/api/clients/[id]/verificacao` | ADMIN geral | Liga e desliga a confirmação de dados do time |
| `/api/clients/[id]/members` | ADMIN | Equipe de um cliente |
| `/api/members` | ADMIN | Lista e cadastra integrantes pelo painel |
| `/api/members/[id]` | ADMIN | Atualiza e exclui um integrante |
| `/api/public/convite/[token]` | Pública | Resolve o convite pelo token do link |
| `/api/public/convite/[token]/membros` | Pública | Recebe o cadastro do formulário |
| `/api/configuracoes/chaves` | ADMIN geral | Lista e cria chaves da API (com vínculo) |
| `/api/configuracoes/chaves/opcoes` | ADMIN geral | Times e administradores para vincular |
| `/api/clients/demo` | ADMIN geral | Cria um Time DEMO completo |
| `/api/clients/demo/:id/dados` | ADMIN geral | Refaz os dados gerados de um Time DEMO |
| `/api/clients/demo/:id/acesso` | ADMIN geral | Liga e desliga o acesso de um Time DEMO |
| `/api/clients/demo/:id/mapa` | ADMIN geral | Completa as moradias do mapa de um Time DEMO, um pedaço por chamada |
| `/api/clients/demo/catalogo` | ADMIN geral | De onde vêm as escolas do Time DEMO (TSE ou catálogo) e quantas há |
| `/api/clients/[id]/duplicar` | ADMIN geral | Duplica um time (administradores, Líderes, formulários e configurações) |
| `/api/configuracoes/chaves/[id]` | ADMIN geral | Revoga uma chave da API |
| `/api/configuracoes/chaves/[id]/atividade` | ADMIN geral | Ações registradas de uma chave |
| `/api/v1/links` | Chave da API | Gera e lista o link do administrador vinculado |
| `/api/v1/links/[id]` | Chave da API | Consulta e revoga um link daquele administrador |
| `/api/v1/vinculo` | Chave da API | Time e administrador vinculados à chave |
| `/api/usuarios/[id]/inspecionar` | ADMIN geral | Autoriza entrar no painel daquela pessoa |
| `/inspecionar/[token]` | Autorização | Troca a autorização pela sessão, no painel |
| `/api/inspecionar/sair` | Sessão de inspeção | Encerra a visita e fecha o registro |

O token do convite é opaco e aleatório: **nenhum dado pessoal vai para a URL**.
O banco guarda apenas o hash SHA-256 dele, por isso o endereço completo aparece
uma única vez, no momento em que é gerado. Para obter um link visível de novo,
use **Gerar novo token** — o anterior deixa de funcionar na hora.

---

## Entrar no painel de uma pessoa

O ADMIN geral abre a ficha de um integrante e clica em **Entrar no painel**. A
partir dali ele usa o sistema **como aquela pessoa**: a mesma tela, a mesma
equipe, o mesmo link, as mesmas permissões — nada é simulado.

Como a sessão é de verdade, três coisas foram escritas junto com o botão.

**A visita fica registrada.** Cada entrada grava uma linha em
`cmd_impersonations`: quem abriu, em nome de quem, de que time, quando começou
e quando terminou. O registro não se reescreve e não se apaga enquanto o time
existir — só o consumo e o encerramento mudam, uma vez cada.

**A tela avisa, o tempo todo.** Uma faixa fixa no rodapé diz de quem é o painel
e lembra que o que for feito ali fica no nome dela. Ela não rola para fora: um
aviso que some é um aviso que aparece quando já não importa.

**O link gerado durante a visita diz a verdade.** O dono continua sendo a
pessoa — é ela que recebe os cadastros —, mas quem consta como **gerador** é o
ADMIN. O histórico de convites já separava as duas coisas desde a migration
020, e é para isso que a separação existe. Um cadastro feito durante a visita,
porém, fica em "Cadastrado por" com o nome dela: é o que significa agir como
alguém.

O que a inspeção **não** faz: não entra no painel de outro ADMIN geral (a
recusa está na rota e na função do banco), não toca no aparelho autorizado da
pessoa, não derruba as sessões dela e não muda nada no cadastro. Sair da
inspeção encerra apenas a sessão que o ADMIN abriu.

Em produção os endereços são separados: o ADMIN trabalha no endereço exclusivo
dele e o painel da equipe é `painel.`. Um cookie não atravessa essa fronteira,
então o botão não abre a sessão direto — ele emite uma **autorização de uso
único**, válida por três minutos, que o outro endereço troca por sessão. É o
mesmo desenho do link de acesso do time. Do token só existe o hash.

---

## API de links de cadastro

O link de cadastro — o endereço que o Administrador do time envia para as
pessoas se cadastrarem — também pode ser gerado por programa, em `/api/v1`.

É a **mesma operação do painel**, e não um segundo sistema de links: mesmo
convite único por usuário, mesmo prazo configurado em Configurações, mesmo
token opaco gerado no servidor, mesma geração anterior derrubada na hora e
mesmo histórico imutável. O que a API acrescenta é o pedido por programa e a
revogação avulsa (`DELETE /api/v1/links/[id]`), que derruba um link enviado por
engano sem colocar outro no lugar.

### A identidade vem da chave

Cada chave pertence a **um administrador de um time**, escolhidos pelo ADMIN
geral no momento da criação (Configurações → Chaves da API). O vínculo é
imutável: para trocar o administrador, revoga-se a chave e cria-se outra — o
gatilho `cmd_api_keys_guard` recusa qualquer alteração no banco.

Nenhum endpoint recebe `donoId` ou `timeId`; corpo com campos é recusado com
400. `POST /api/v1/links` gera o link **daquele** administrador, e as demais
rotas só alcançam links dele: para uma chave do João, o link da Maria responde
404, e não 403.

**A API age como o dono.** Gerar pela API é exatamente o que aconteceria se
aquele administrador entrasse no painel e clicasse em "Gerar link": ele consta
como dono **e** como quem gerou, com data e hora do servidor, prazo do perfil
dele e os mesmos eventos. A rota do painel chama
`issuePersonalInvite(user.id, user.id)` e a API faz a mesma chamada — no
histórico do link não há como distinguir os dois caminhos, e é esse o objetivo.

### Quem pode o quê

Criar, listar, ver atividade e revogar chaves é **exclusivo do ADMIN geral**
(`settings.manage` + perfil ADMIN). O Administrador do time não cria, não vê,
não vincula e não escolhe em nome de quem a API atua — ele apenas continua
gerando e copiando o próprio link pelo painel, como sempre.

Nas rotas `/api/v1` a **sessão do painel não vale**: só o cabeçalho
`Authorization: Bearer cmd_...`. A cada chamada o banco reconfere o vínculo
inteiro — chave não revogada, ADMIN geral ativo, administrador ativo com perfil
de Administrador do time, ainda ligado ao mesmo time, e o time ainda existindo.
Qualquer falha derruba a chave na hora, e a resposta é sempre o mesmo 401, sem
dizer qual conferência falhou.

O segredo aparece **uma única vez**, na criação: o banco guarda apenas o
SHA-256 e o prefixo público (`cmd_` + 8 caracteres).

### Auditoria em dois lugares

Como o histórico do link é, de propósito, indistinguível de um clique humano, o
rastro da API vive em `cmd_api_key_events`: qual chave, sob qual ADMIN geral, em
nome de qual administrador, qual time, qual operação, o resultado e o instante —
incluindo as chamadas **recusadas**, com o motivo que a resposta nunca revela.
Isso aparece em Configurações, no botão **Ver atividade** de cada chave.

Revogação é a exceção do "agir como dono": como não existe esse botão no painel,
ela consta no histórico do link como ação da administração.

### Chaves antigas

Chaves criadas antes do vínculo (migration 029) **não funcionam mais** e nenhum
administrador é escolhido por elas: `cmd_api_key_resolve` recusa com o motivo
`sem vinculo`, e a tela marca "Vínculo obrigatório". O ADMIN geral revoga e cria
outra escolhendo time e administrador.

A documentação completa — endpoints, parâmetros, exemplos de requisição e de
resposta, estados do link e tabela de erros — fica em **Configurações**, na
própria tela do sistema, e nasce de `src/lib/domain/api-docs.ts`. Ela é
conferida por teste (`tests/api-docs.test.ts`): endpoint documentado precisa
existir como rota e exportar o método descrito, e todo exemplo de resposta
precisa ser JSON válido.

A API é servida no endereço do **painel**. O domínio público não a serve — ele
só serve os links enviados. Já os links que ela devolve apontam para o domínio
público, que é o endereço que as pessoas recebem.

Requer as migrations `029_api_links_cadastro.sql`, `030_api_agir_como_dono.sql`
e `031_api_chave_vinculada.sql`.

---

## Links de cadastro em lote

Cada link de cadastro vale para **uma pessoa**: é reservado pelo primeiro
navegador que o abre e consumido quando o cadastro é enviado. Até aqui cada
dono podia ter **um** link por vez — um índice único garantia isso, e gerar um
novo revogava o anterior na hora. Mandar o cadastro para dez pessoas eram dez
idas ao painel: gerar, enviar, esperar a pessoa se cadastrar, gerar de novo.

O botão **"Gerar em lote"**, no cabeçalho do time, gera quantos links forem
pedidos de uma vez (migration 043). Não há teto de produto: o número grande no
schema existe só para o corpo da requisição ter um fim.

Os links que já existiam **continuam valendo** — o lote não revoga nenhum. O
dono continua sendo o Administrador do time, e é o nome dele que permanece em
"Cadastrado por". Cada link mantém o mesmo prazo, a mesma reserva por navegador
e o mesmo histórico de sempre.

**A cor diz o que falta.** Na lista, verde é o link que ainda não foi copiado;
cinza, o que já foi. Quem está distribuindo trinta endereços precisa saber, de
relance, onde parou. Há um **"Copiar todos"**, que copia um por linha — o
formato que se cola em planilha, bloco de notas ou conversa. Esse estado vive
só naquela tela: "já copiei este" é assunto de quem está copiando agora, não um
dado do cadastro.

Os endereços aparecem **uma única vez**, porque o banco guarda apenas o hash de
cada token — por isso a tela avisa antes de fechar com algum ainda por copiar.

O botão "Gerar link" de sempre continua fazendo o de sempre: um link novo,
revogando o anterior. O que mudou foi **qual** anterior — agora é sempre o mais
recente do dono, e não uma linha qualquer entre os vários que ele pode ter. A
numeração das gerações segue o dono, para o histórico dele continuar sendo uma
linha do tempo só.

---

## Confirmação dos dados pela FonteData

Todo cadastro que chega pelo **Formulário 1** passava, sem exceção, por duas
consultas pagas à FonteData: o CPF, que confere e corrige o nome, e a situação
eleitoral, que preenche **zona e seção** sozinha, a partir do título.

Nem todo time quer — ou pode — pagar por isso. Na aba **Formulários** do time,
em "Confirmação dos dados", o ADMIN geral liga e desliga essa conferência
**time a time** (migration 041, `cmd_clients.verification_enabled`). O padrão é
ligado: nenhum time que já existia mudou de comportamento.

Desligada, para os cadastros **daquele time**:

- **nenhuma consulta à FonteData acontece, em lugar nenhum.** Nem durante o
  preenchimento (`/api/public/convite/cpf` e `/titulo` respondem vazio **sem
  chegar ao fornecedor**), nem depois do envio (`runVerification` não roda e
  nem chega a nascer verificação pendente), nem pelo botão "Consultar de novo"
  da ficha do integrante, que é recusado no servidor. Cada consulta é cobrada,
  então esconder o botão na tela nunca seria a proteção: quem decide é o
  servidor, em cada ponto que chegaria na FonteData;
- **o formulário continua perguntando** se o CPF e o título digitados estão
  corretos. A pergunta não é enfeite da consulta: com a confirmação desligada
  ela passa a ser a **única** conferência daqueles números, e agora é de quem
  preenche. Confirmado, a pessoa segue preenchendo normalmente;
- **zona e seção viram campos obrigatórios**, ligados e digitados à mão. Sem
  consulta que os preencha, o que ninguém digitar simplesmente não existiria no
  cadastro. A regra é conferida **também no servidor**, no envio: um formulário
  público montado à mão não passa sem os dois.

O formulário montado pelo ADMIN **não é reescrito**. A obrigatoriedade é
derivada do interruptor a cada abertura do link (`withVerificationRules`, em
`src/lib/domain/form-config.ts`), e é a mesma função que a prévia do construtor
usa — o que o ADMIN vê na prévia é o que quem abre o link recebe. Religar a
confirmação devolve o formulário exatamente como ele foi montado.

O que **não** para junto: nem a moradia aproximada nem o local de votação, que
desde a migration 042 não dependem mais da FonteData nem de consulta paga
nenhuma — a escola sai da nossa própria tabela, achada pela zona e pela seção
que a pessoa digitou. É a seção seguinte.

Na ficha do integrante, a **Verificação cadastral** diz que a confirmação está
desligada naquele time, em vez de ficar eternamente "aguardando" uma consulta
que nunca vai acontecer. As verificações já feitas antes de desligar continuam
onde estão: nada é apagado nem reescrito.

---

## Locais de votação: a escola sai do nosso banco

A escola onde a pessoa vota era descoberta **consultando o Google**, pela
SerpAPI: montava-se o endereço que a Justiça Eleitoral tinha devolvido e
perguntava-se as coordenadas ao provedor. Isso custava uma consulta paga por
escola e devolvia o palpite do buscador para aquele texto — não o ponto
oficial.

O TSE publica a lista completa dos locais de votação, com a coordenada de cada
um. Ela agora vive em `cmd_polling_places` (migration 042), e a escola deixou
de ser uma pergunta: é uma consulta ao próprio banco, de graça, instantânea e
exata.

**A SerpAPI continua servindo apenas a moradia aproximada da pessoa** — o
único endereço que ninguém publica em tabela, porque é digitado no cadastro.
Não existe mais caminho que leve a escola a um provedor: a função que montava
aquela consulta foi removida, e não só deixou de ser chamada.

### Como se acha o local de uma pessoa

Por **UF + zona + seção**. A seção é a unidade: cada uma existe em um único
local, e por isso as seções ficam numa lista dentro da linha do local — a
forma da própria planilha ("Seções neste local: 1, 2, 3…"), com um índice GIN
para a busca não varrer a tabela.

A UF entra porque **número de zona se repete entre estados**: a zona 39 existe
em Alagoas e em São Paulo, e são locais diferentes. De onde vêm os três, em
ordem:

1. a **consulta eleitoral**, quando o time confirma dados e ela deu certo — é
   a resposta da própria Justiça Eleitoral;
2. o que está no **cadastro**, com a **UF do time**. Zona e seção foram
   digitadas por quem preencheu (obrigatórias no time sem confirmação,
   migration 041), e o estado do time já é informado no cadastro dele
   (migration 038);
3. a UF declarada pela pessoa, quando o time é antigo e não tem estado.

Faltando qualquer um dos três, não há busca. **Não encontrado quer dizer não
encontrado**: aquela UF ainda não foi importada, a seção é nova, ou o número
digitado não existe. Nenhuma consulta paga tenta adivinhar — o integrante fica
no mapa pela moradia, e o painel mostra que o local não foi encontrado, que é
a verdade. Local sem coordenada na planilha é encontrado, mas não vira pino:
inventar um ponto seria pior do que não ter nenhum.

### Carregar a planilha

```bash
npm run importar-locais -- supabase/dados/locais-de-votacao.csv --conferir
npm run importar-locais -- supabase/dados/locais-de-votacao.csv
```

Quem preferir não sair do navegador tem o mesmo resultado em três passos no
SQL Editor, por `supabase/dados/carga-pelo-painel.sql`. O que **não** funciona
é importar o CSV direto na tabela pelo painel: o importador entrega o texto cru
ao Postgres e a coordenada em vírgula decimal (`-9,25912678`) não é número para
ele — é exatamente para isso que existem o comando e aquele arquivo.

As colunas são encontradas **pelo nome** (acento, caixa, pontuação e ordem não
importam), e separador, aspas, BOM do Excel e coordenada com vírgula decimal
são reconhecidos sozinhos. A carga é **idempotente**: a chave é UF + município
+ zona + local, então rodar de novo — ou carregar mais um estado — atualiza no
lugar, nunca duplica e nunca apaga. Estado por estado funciona: um CSV por UF,
na ordem que quiser. Os detalhes estão em `supabase/dados/README.md`.

O CSV não é versionado: é dado público e grande. O que é versionado é o
comando que o carrega.

---

## Time DEMO

Um time de demonstração é um time **de verdade**: mesmas tabelas, mesmas
telas, mesmos serviços. Não existe tela falsa, tabela DEMO paralela nem
número chumbado em componente — a página do Time DEMO lê exatamente as mesmas
consultas que a de um time real.

O que ele tem de diferente é um sinal, `cmd_clients.is_demo`, e o fato de que
as **pessoas** dele são geradas no servidor a partir de listas fictícias
(`src/lib/domain/demo.ts`): nome, gênero e telefone de uma faixa de
demonstração com DDD 82. Nunca há CPF, título de eleitor, e-mail ou telefone
de pessoa real.

Os **lugares não são fictícios**. As escolas saem da **tabela oficial do TSE**
(`cmd_polling_places`, migration 042) — a mesma que põe a escola de um
integrante real no mapa —, com nome, endereço, zona, seções e a coordenada
oficial de cada local. Com a tabela de Alagoas carregada, um Time DEMO sorteia
entre **centenas de escolas em dezenas de municípios** (`src/lib/domain/demo-tse.ts`):

- **municípios**: Maceió e Arapiraca entram sempre; os demais são sorteados com
  peso pelo eleitorado (soma das seções), então o sertão e o litoral também
  aparecem. Doze escolas cobrem 8 municípios; sessenta, 17; trezentas, 38;
- **escolas por município**: em proporção ao eleitorado, amaciada, para a
  capital não engolir o mapa; toda cidade escolhida tem ao menos uma escola;
- **quais escolas**: sorteadas com peso pelo número de seções, e o colégio
  grande recebe mais gente do que a escola rural de duas seções;
- **cada pessoa** recebe a zona e uma seção **que existem** na escola dela —
  zona + seção acham a escola pelo mesmo caminho do cadastro real, e é por
  isso que o mapa por seção, a Sala de Apuração e o Seção por seção funcionam
  no Time DEMO como num time real.

O sorteio é determinístico: a mesma semente e a mesma quantidade devolvem as
mesmas escolas, e o "Refazer dados" reproduz o time que o ADMIN já conhece.

Sem a tabela carregada (ou com menos de 40 escolas utilizáveis), vale o
catálogo conferido de `src/lib/domain/demo-catalog.ts`: 33 locais reais em 17
municípios, divulgados pelo TRE/AL, com a fonte anotada linha a linha.

**O Time DEMO só lê a tabela oficial.** Nenhuma linha dela é gravada, alterada
ou apagada. O pino de cada escola é gravado no cache de coordenadas no
**mesmo formato do caminho real** (mesma chave, título e endereço): se um time
real já tem gente naquela escola, o Time DEMO aponta para a linha que já
existe, sem reescrevê-la — e essas linhas nunca entram no desfazer de uma
criação que falhou nem na limpeza do "Refazer dados".

Rua, bairro, zona e seção aparecem **somente onde a fonte os publicou**. Onde
não publicou, o campo fica vazio — que é a verdade —, e a consulta de
coordenada usa o nome do local + município + UF, que é como a própria Justiça
Eleitoral identifica o local. Completar endereço de cabeça seria invenção.

Um Time DEMO é **inteiro de Alagoas**: não há âncora de outro estado em lugar
nenhum do gerador. Cada pessoa **mora no município em que vota** — quem vota
em Arapiraca não mora em Penedo —, e a moradia cai na rua, no bairro ou no
município, conforme até onde o endereço publicado chega.

O time vai de 1 a **5.000 pessoas** (padrão 120). As escritas vão em lotes de
500 linhas (`insertRowsInChunks`): um envio único de milhares de linhas não
falha por limite de linhas, falha pelo tamanho do corpo e pelo tempo da
requisição — e, quando falha, não grava nada, o que significaria perder a
criação inteira no fim.

As pessoas se dividem entre os locais **com peso**, sorteado pela semente:
divisão igual é o jeito mais rápido de a demonstração parecer falsa, porque o
ranking "onde você tem mais votos" empata em tudo e o mapa vira um tabuleiro
regular. Nenhum local fica vazio, e a soma fecha com o total do time.

### Onde se cria

**Times → "Criar Time DEMO"**, ao lado de "Novo time". O botão só aparece
para o ADMIN geral, e a rota confere de novo (`client.create` + perfil
ADMIN): administrador do time e integrante recebem 403.

O diálogo pede nome, foto, os administradores (quantos forem necessários,
cada um com nome, telefone e foto opcional) e as quantidades de pessoas e de
locais de votação — padrão de **600 pessoas em 60 escolas**, até 5.000 pessoas
e 400 escolas. A ajuda do campo mostra quantas escolas a fonte tem
(`GET /api/clients/demo/catalogo`).

Ao concluir, as escolas já estão no mapa (coordenada oficial, sem consulta).
As **moradias** são ruas reais das próprias escolas do município (no máximo 4
por município, as do catálogo conferido primeiro, que já estão no cache), e a
consulta de cada rua inédita tem prazo na criação. O que não coube é
completado em seguida, no próprio diálogo, com o progresso à vista
(`POST /api/clients/demo/:id/mapa`, chamado até não sobrar nada); o botão
"Abrir o time agora" pula essa etapa. Cada rua inédita é uma consulta paga,
**uma vez no sistema todo**.

Os administradores do Time DEMO entram pelo **mesmo fluxo dos times reais**:
link de acesso do time + telefone. Não há segundo sistema de autenticação, e
não há limite de quantos administradores o time pode ter.

### Quem tem acesso

**Somente os administradores cadastrados à mão pelo ADMIN geral.** As pessoas
fictícias são dados de demonstração: existem em `cmd_members` e em nenhum
outro lugar — sem usuário, sem senha, sem sessão, sem link de acesso, sem
aparelho vinculado e sem convite pessoal. Não há por onde entrar nem o que
gerar em nome delas.

Por isso elas também não aparecem em **Configurações → Usuários do sistema**:
não estão com acesso pendente, foram criadas sem acesso de propósito, e a
consulta dos pendentes exclui os times com `is_demo = true`. A alternativa —
criar trinta contas para calar o aviso — seria fabricar acesso que ninguém
pediu.

Na ficha, dentro da página do próprio Time DEMO, o estado delas é
**"Sem acesso — demonstração"** (`DEMO_NO_ACCESS`), em aparência neutra: não
é pendência e não há nada a resolver.

A recusa vive em `createMemberAccess`, que é por onde **todo** caminho de
concessão passa — cadastro pelo painel, envio do formulário público e a
sincronização do acesso quando o telefone muda. Recusar em uma rota e
esquecer de outra concederia acesso pela porta esquecida. Recusar não é
falhar: o cadastro continua e a função devolve `null`, porque derrubar o envio
público quebraria justamente a demonstração do formulário.

### Mapa: nenhuma coordenada inventada

**Nenhuma coordenada é escrita à mão e nenhuma é calculada.** Cada ponto vem
da mesma consulta de endereço que põe um integrante real no mapa
(`src/lib/server/demo-locations.ts` → `lookupPlace`), e fica no cache de
`cmd_map_locations`, com a chave do **endereço** — não do time. Como o
catálogo é curto, o primeiro Time DEMO resolve cada endereço uma vez e todos
os seguintes aproveitam a linha gravada, sem nova consulta e sem nova
cobrança.

Foi exatamente isto que corrigiu o mapa: antes, as coordenadas eram âncoras
digitadas de memória mais um deslocamento aleatório — e o resultado eram
marcadores em Recife e no mar. O deslocamento deixou de existir e as âncoras
também.

Três barreiras antes de um ponto ser aceito:

1. o provedor só devolve resultado cujo endereço bate com o município e a UF
   pedidos (`parsePlace`);
2. `isUsableDemoCoordinate` recusa nula, `NaN`, `0,0` e **qualquer ponto fora
   de Alagoas** — e o que é recusado nem entra no cache, para não estragar a
   consulta de um time real;
3. o que não passa **não vira ponto**: o vínculo fica `NOT_FOUND` (sem
   resultado confiável) ou `FAILED` (consulta impossível), a tela conta a
   pessoa como pendente, e o mapa não ganha um pino que não corresponde a
   lugar nenhum.

Os vínculos em `cmd_member_locations` nascem `SUCCESS` quando a coordenada
existe: uma linha de moradia (camada "Pessoas") e uma de local de votação
(pino agrupado da escola) por pessoa.

A coordenada da moradia é a **da rua**, compartilhada por quem mora nela —
o mesmo comportamento do cache real, e o que faz os pinos se agruparem em vez
de virar um borrão de pontos soltos.

No mapa, o enquadramento (`fitBounds`) considera **somente coordenadas
utilizáveis**: nula, `NaN`, fora da faixa ou `0,0` ficam de fora, porque um
único ponto desses estica o enquadramento por meio planeta. Sem nenhum pino
ainda resolvido, a página de um Time DEMO abre no **centro de Alagoas**; o
mapa geral continua abrindo no centro do país.

### Corrigir um Time DEMO já criado

Na página do time, menu de ações → **"Refazer dados de demonstração"** (só o
ADMIN geral vê), ou `POST /api/clients/demo/:id/dados`.

A rotina refaz **somente o que o gerador criou**: as linhas marcadas em
`cmd_members.demo_seed` com a versão do catálogo. O time, os administradores,
os acessos deles, os links, o formulário, o questionário, as configurações e
qualquer pessoa cadastrada à mão continuam exatamente como estão. Um time
real não passa daqui.

Rodar duas vezes **não duplica**: a geração anterior sai antes de a nova
entrar, e a semente é a mesma (a chave da criação original), então o resultado
é idêntico. Os pontos `DEMO_SEED` que sobram sem dono — as coordenadas
inventadas da versão antiga — são removidos do cache.

O diálogo deixa escolher o tamanho da nova geração: **pessoas** (em branco
mantém o tamanho atual — a correção nunca encolhe a equipe sem pedido) e
**escolas** (padrão 60, da tabela oficial; sem ela, o catálogo inteiro). É
assim que um Time DEMO antigo, de 33 escolas, passa para as escolas oficiais
do TSE. Depois de refazer, o mapa das moradias é completado do mesmo jeito da
criação.

A segunda camada (pessoas trazidas pela equipe) vota nas **mesmas escolas**
do time, lidas das próprias pessoas dele por zona + seção — nunca em um
sorteio novo.

### Fora dos números reais

Os dados DEMO não entram em nenhuma métrica da operação. O recorte vive em um
lugar só, `src/lib/server/demo-scope.ts`, e dele dependem o total de times, o
total de integrantes, os cadastros do dia, o gráfico, o mapa geral, a lista de
pessoas de um local e a API `/api/v1` (um Time DEMO não recebe chave). Sem
nenhum Time DEMO cadastrado, nenhuma consulta ganha uma cláusula sequer.

Na listagem de Times o ADMIN geral vê o Time DEMO com o selo **DEMO**, mas os
dois indicadores acima da lista continuam somando apenas `is_demo = false`.
Dentro da página do próprio time, tudo aparece normalmente: total de pessoas,
gráfico, cadastros de hoje e dos sete dias, listas, mapa, locais de votação e
contagens por gênero e por responsável.

No **rastreamento de links** os eventos DEMO não são apagados nem escondidos —
eles seguem úteis para demonstrar e diagnosticar. A listagem começa em
**Reais**, cada linha de um Time DEMO leva o selo, e o ADMIN geral alterna
entre `Reais`, `DEMO` e `Todos`.

### O banner do celular

O banner que aparece para quem abre o link de cadastro **no telefone** era um
só, o mesmo arquivo para o sistema inteiro, com o endereço escrito dentro do
próprio componente. Com um Time DEMO na mesma tela, a demonstração passou a
exibir o **banner de produção de um cliente real** — a arte dele, o nome dele,
na apresentação de outra pessoa.

Agora cada time pode ter o seu (`cmd_clients.banner_path`, migration 035),
enviado na página do time → menu de ações → **"Banner do celular"**, ou já na
criação do Time DEMO. A imagem vive no Storage privado, como toda imagem do
sistema, e é servida por URL assinada.

A escolha do arquivo é uma regra só, em `src/lib/domain/invite-banner.ts`:

| Situação | O que aparece |
| --- | --- |
| O time subiu o seu | O banner dele, sempre |
| Time DEMO sem banner próprio | **Nenhum** — a tela cai na faixa de convite comum |
| Qualquer outro time | O banner padrão do sistema, como sempre foi |

O caso do meio é o ponto: emprestar a arte de produção de um cliente real para
uma demonstração é pior do que não ter banner nenhum.

O arquivo sobe **como veio**, sem redimensionar nem reencodar — o banner é
arte chapada, larga, com letra fina, e o tratamento das fotos de perfil (720 px,
JPEG) borraria o texto e transformaria um fundo transparente em preto. Só
acima do teto do Storage (2 MB) ele passa por compressão, e ainda assim com o
dobro da resolução usada nas fotos.

### Ligar e desligar o acesso

Na página do Time DEMO, ao lado dos links, o ADMIN geral tem a chave **"Acesso
ao sistema"** (migration 036, `cmd_clients.demo_access_enabled`). Desligada:

- **nenhuma sessão daquele time resolve** — a conferência vive em
  `resolveSessionState`, o único ponto por onde passam todas as páginas e
  todas as rotas de API, então não há tela, botão ou URL que escape;
- **nenhum login novo passa** pelo link do time, e a recusa diz o motivo em
  vez de repetir o erro genérico: quem tem o link na mão já sabe de que time
  se trata, e esconder isso só faria a pessoa tentar o telefone de novo
  achando que errou;
- **quem está dentro é avisado na hora.** O painel mantém um batimento com o
  servidor (`GET /api/auth/session`) e, ao ver a sessão bloqueada, cobre a
  tela com **"Conta desconectada"** e o motivo. Não redireciona sozinho para
  o login: sumir sem explicação é o que faz alguém achar que o sistema
  quebrou.

O batimento é de **5 segundos** para administradores de time — quem pode ser
desligado — e de 30 para o ADMIN geral, que não pertence a time nenhum. Ele só
corre com a aba à vista, e ao voltar para a aba a conferência é imediata.
Falha de rede não decide nada: derrubar alguém porque a conexão piscou seria
pior do que o problema que isso resolve. Não há conexão permanente — o sistema
roda em funções que nascem e morrem a cada requisição, onde uma conexão aberta
por aba custaria uma função viva o tempo todo.

**Desligar não destrói nada:** nenhum usuário é desativado, nenhuma sessão é
revogada, nenhuma senha muda. Por isso religar devolve as pessoas exatamente
onde estavam — o aviso some sozinho e a tela se recompõe, sem ninguém precisar
entrar de novo. É também por isso que a chave é conferida **antes** do aparelho
autorizado: recusa por aparelho revoga a sessão, e aí religar não traria
ninguém de volta.

A rota é própria (`PATCH /api/clients/demo/:id/acesso`, ADMIN geral) e não um
campo em "editar time": `client.update` também pertence ao Administrador do
time, que religaria o próprio acesso. E o `check` da migration recusa desligar
um time real — uma operação de verdade não fica sem acesso por um clique em
uma tela de demonstração.

### O que o banco garante

`is_demo` é **imutável**: o gatilho `cmd_clients_demo_guard` recusa converter
um time real em DEMO e um DEMO em real, venha de onde vier. A criação é
idempotente: a chave enviada pelo navegador é reservada em `cmd_demo_seeds`
antes de qualquer escrita, então um duplo clique devolve o mesmo time em vez
de criar outro. Qualquer falha no meio desfaz tudo — o time é excluído (a
cascata leva campos, acessos, pessoas e vínculos) e as coordenadas semeadas
são removidas.

A marca da geração vive em `cmd_members.demo_seed`, e o gatilho
`cmd_members_demo_seed_guard` recusa marcá-la em quem não pertence a um Time
DEMO — sem isso, um erro de código poderia levar a rotina de correção a apagar
um cadastro de verdade.

Requer as migrations `033_time_demo.sql`, `034_time_demo_alagoas.sql`,
`035_banner_do_time.sql` e `036_acesso_do_time_demo.sql`.

---

## Time duplicado

O ADMIN geral abre a página de um time e, no menu de ações, escolhe **Duplicar
time**. Serve para mostrar, na prática, a diferença entre a informação que os
Líderes mandam certa e a que mandam errada: na cópia, a planilha dos Líderes
sobe normalmente, e o oficial fica intacto ao lado.

| Vai para a cópia | Fica só no oficial |
| --- | --- |
| Configurações do time (textos, privacidade, recrutamento, confirmação de dados, banner, estado e municípios) | A **Equipe** de cada Líder |
| Formulário 1 e Formulário 2 | Links já gerados e histórico de links |
| Administradores do time, com acesso próprio na cópia | Respostas do questionário que chegaram por link |
| **Líderes**, com respostas, tag, confirmação, verificação já concluída, pontos do mapa e acesso próprio na cópia | Aparelhos, sessões e visitas de inspeção |

**O oficial nunca é tocado.** A duplicação só LÊ o oficial. Toda linha
escrita é nova e leva o `client_id` da cópia; nenhuma chave estrangeira aponta
da cópia para o oficial (`copy_of_client_id` é só informativo). As fotos são
**copiadas para arquivos próprios** no Storage: se a cópia reaproveitasse o
caminho do oficial, trocar a foto na cópia — ou excluir a cópia — apagaria o
arquivo do oficial. Falha no meio desfaz só a cópia. Tudo isso é conferido em
`tests/time-duplicado.test.ts`, que fotografa o oficial antes e compara
depois.

**Fora da Visão geral.** A cópia tem os mesmos Líderes do oficial; somada aos
números, contaria cada um duas vezes. Por isso ela entra no mesmo recorte do
Time DEMO (`demo-scope.ts`): fora do total de times e integrantes, gráficos,
mapa geral, rankings e da API `/api/v1`. Em **Times** ela aparece com o selo
**Duplicado**, e a página dela diz de qual time veio.

**O que não é copiado por segurança:** o e-mail dos Líderes (é único no
sistema) e verificação ainda pendente (a cópia pagaria de novo uma consulta
que o oficial já pagou). Líder com telefone incompleto ou repetido fica sem
acesso na cópia, exatamente como no oficial.

### Planilha do Google Sheets na cópia

No menu de ações do time duplicado (**⋯** ao lado de "Editar time"), o ADMIN
geral abre **Planilha do Google Sheets**: um interruptor e o link. Ligado, a **Equipe de
cada Líder da cópia vem da planilha, lida ao vivo**.

**Nada da planilha é gravado no Supabase.** O banco guarda só o interruptor e
o link. Cada vez que a lista do time é aberta, a planilha é lida do Google e a
Equipe é montada na memória do servidor — quem atualiza a planilha vê a
mudança no sistema, sem importar nada. **Sempre a versão atual:** nenhuma
leitura é reaproveitada de uma requisição para outra; editou a planilha e
atualizou a página, a página mostra a planilha editada. Só pedidos que chegam
juntos (a lista e o mapa da mesma página) dividem a mesma ida ao Google.
A linha do próprio Líder na aba dele vale para os dados dele na tela: o que
estiver preenchido ali (título, zona, seção, telefone, referência, verificado
por foto) aparece no lugar do que o banco da cópia tem.

- **Uma aba por Líder.** O nome da aba é comparado com os Líderes da cópia sem
  diferença de maiúscula, acento ou espaço ("FELIX SILVA TARGINO" = "Félix
  Silva Targino"). Se não bater, tenta o nome da coluna LÍDER. Se nem assim, o
  sistema **cria o Líder**, com o nome completo da coluna LÍDER (ou o da aba,
  quando a coluna vier vazia).
- **Colunas, nesta ordem:** NOME, TITULO, ZONA, SEÇÃO, TELEFONE, LÍDER,
  REFERÊNCIA, VERIFICADO POR FOTO. Com a linha de cabeçalho, a leitura vai pelo
  nome da coluna; sem ela, pela ordem. Aba oculta e linha sem nome ficam de
  fora; a linha do próprio Líder na aba dele não vira Equipe dele mesmo.
- **Ligada**, a Equipe que estava no banco da cópia fica **escondida**, e a da
  planilha aparece — na lista, no painel do Líder e no relatório. **Desligada**,
  a cópia volta a mostrar o banco. Ligar e desligar **não apaga nada**.
- O Líder que a planilha "cria" também só existe na tela.
- As pessoas da planilha aparecem com o selo **"Da planilha"** e são só
  leitura: editar, excluir, trocar responsável, tag e "Entrar no painel" não se
  aplicam a elas. Para corrigir, corrige-se na planilha.
- **No mapa, as escolas contam a Equipe da planilha.** O local de votação de
  cada pessoa sai da zona + seção dela, procurado na tabela do TSE do próprio
  sistema — na hora, só leitura, sem consulta paga e sem gravar nada. A pessoa
  soma no pino da escola (junto com quem já está no banco, no mesmo pino), nas
  seções e em "Ver pessoas", onde aparece com "Da planilha". Quem não tem zona
  e seção, ou tem uma que a tabela não conhece, conta como local não
  encontrado. O pino de **casa** não existe para elas: a planilha não tem
  endereço.
- O cartão mostra o que a planilha tem agora: Líderes reconhecidos, os só da
  planilha, quantas pessoas e o que ficou de fora, com o motivo. Se o Google
  não responder, a lista do time continua abrindo, sem a Equipe da planilha,
  e o cartão diz por quê.

**Literal, como a planilha mostra.** Número guardado com formato de exibição
vale pelo que aparece na tela: um título digitado como número e formatado
"0000 0000 0000" aparece como "0240 5979 1708" — e é assim que entra, com o
zero do começo (o número cru, 24059791708, teria 11 dígitos e viraria uma
inconsistência falsa). Nada é inventado: a planilha não tem endereço, então a
pessoa não tem estado, município, bairro nem rua. E só se cobra dela o que a
planilha traz — título, zona, seção e telefone; do Líder que só existe na
planilha, nada (ela só traz o nome dele). Acesso ao painel e origem do
cadastro também não se aplicam. O que vier errado de verdade na planilha
continua apontado.

**Como o sistema lê:** o Google exporta a planilha inteira como .xlsx por um
endereço público, e o servidor lê todas as abas dali (`src/lib/server/xlsx.ts`,
sem biblioteca nova). Por isso a planilha precisa estar compartilhada como
**"Qualquer pessoa com o link" — Leitor**. O servidor só baixa de
`docs.google.com`, montando o endereço a partir do id da planilha.

**O oficial continua intocável, e o banco garante:** o interruptor só liga em
cópia (`check`). Ler a planilha não escreve nada em tabela nenhuma — o teste
`tests/planilha-do-sheets.test.ts` registra toda escrita que chega ao banco e
confere que a leitura não gera nenhuma. Requer a migration
`052_planilha_do_sheets.sql` (depois da 049, 050 e 051), que só acrescenta o
interruptor e o link.

Time DEMO não é duplicado. O sinal `is_copy` é imutável: o gatilho da
migration recusa transformar um time oficial em cópia ou uma cópia em
oficial.

Requer a migration `049_time_duplicado.sql`. Sem ela, o botão responde com o
nome da migration a executar, e o resto do sistema continua funcionando.

---

## Exportar a equipe em planilha

O botão **Exportar**, na barra da equipe do time, baixa a lista em `.csv` com
**três colunas**, e nenhuma outra:

| Coluna | O que traz |
| --- | --- |
| `Nome` | O nome completo do cadastro |
| `Telefone` | Com máscara — `(82) 99999-0001`. Sem telefone, a célula fica **vazia**, para o filtro da planilha achar de uma vez quem está sem número |
| `Cadastrado por` | O MESMO texto da tela: `José Pereira · Líder`, `Ana Costa · Administração do time`, `Cadastro anterior ao rastreamento` |

"Cadastrado por" sai de `recruiterText`, a mesma função que a tela usa. O texto
vem do snapshot gravado no momento do cadastro: continua correto mesmo depois
que o usuário responsável é excluído — aí com o sufixo `(acesso removido)` — e
registro sem evidência nenhuma nunca é atribuído a alguém.

**Sai o que está na tela.** Sem pesquisa e sem filtro — que é como a página
abre —, sai o time inteiro. Com o filtro de "Cadastrado por" ligado, sai o
recorte que está à vista, e o aviso diz quantas pessoas foram. Exportar uma
lista diferente da que a pessoa está olhando seria a pior das duas opções.

**É do ADMIN geral.** A permissão `member.export` existe separada de
`member.view` porque a lista inteira em um arquivo é outra coisa que a mesma
lista na tela: ela vai para a pasta de downloads, o WhatsApp e o e-mail de quem
baixou, e não volta. O Administrador do time e o integrante veem a equipe, mas
não exportam.

**Nenhuma rota nova.** O arquivo é montado no navegador sobre a lista que a
página já recebeu — com o recorte de hierarquia que o servidor aplicou ao
enviar. A exportação não alcança uma linha a mais do que a tela, e nada volta
ao servidor para baixar.

O arquivo sai como `integrantes-<time>-<data>.csv`, com BOM e ponto e vírgula:
sem os dois, o Excel em português abre tudo em uma coluna só e com os acentos
trocados. É a mesma exigência do modelo de importação (`csv-import.ts`), agora
em um único lugar — `src/lib/utils/download.ts`.

Nome que começa por `=`, `+`, `-` ou `@` chega à planilha **como texto**, com um
apóstrofo na frente. Nome vindo do link público não passa por ninguém, e fórmula
em planilha alheia é execução de algo que quem abriu não escreveu.

---

## Relatório do NEO

Na página do time, o botão **Relatório do NEO** gera um PDF com tudo o que o
sistema sabe daquele time, e com a análise escrita pelo **NEO**, o analista do
sistema (API da OpenAI, modelo `gpt-5.4-mini`).

O relatório tem esta estrutura:

| Parte | O que traz |
| --- | --- |
| Capa | O time, a manchete do NEO e os quatro números que importam: pessoas, Líderes, Equipe e saúde do cadastro |
| 1. Resumo executivo | O **índice NEO** (0 a 100), o resumo, o que está indo bem e o que preocupa |
| 2. O time em números | Hoje, 7 e 30 dias, ritmo diário, a estrutura Administradores → Líderes → Equipe, crescimento de 12 semanas, origem e gênero |
| 3. Líderes e Administração | A leitura do NEO sobre cada Líder que merece comentário (Motor, Constante, Parado…), o ranking completo e os Administradores |
| 4. Território | Bairros, zonas e seções com mais gente, e onde há vazio |
| 5. Qualidade e inconsistências | Saúde do cadastro, cada repetido com quem cadastrou e quando, o que falta, o que conferir e cada problema com nome e responsável |
| 6. Plano de ação | O que fazer, por quem e até quando, e as perguntas para a próxima reunião |
| Anexo | Quem é cada pessoa, agrupada sob o Líder que a trouxe, com telefone, bairro, zona/seção e situação |

**O NEO não conta.** Os números saem do cadastro (`src/lib/domain/dossie.ts`).
O NEO recebe esses números prontos e só os interpreta. As instruções proíbem
inventar quantidade, e o PDF desenha cada contagem a partir do dossiê, nunca do
texto dele. A resposta chega em formato fixo (Structured Outputs, modo strict) e
é conferida de novo no servidor: qualquer coisa fora do formato vira "sem
análise", e nunca um relatório torto.

**O NEO não vê dado sensível.** Para a OpenAI vão só números agregados e os nomes
de Administradores e Líderes (`resumoParaONeo`). Telefone, CPF, título, endereço
e a lista da Equipe não saem do sistema. A conversa é enviada com
`store: false`. O PDF, que tem o anexo com as pessoas, é montado **no navegador**
de quem pediu: nenhum servidor de PDF, nenhuma cópia guardada.

**Sem o NEO, o relatório sai do mesmo jeito.** Sem `OPENAI_API_KEY`, ou com a
OpenAI fora do ar, o PDF traz todos os números, as inconsistências e o anexo; os
trechos do NEO dizem que a análise não foi escrita.

**É do ADMIN geral** (`member.export`), pela mesma razão da planilha: o relatório
leva a lista inteira do time para fora do sistema.

Configuração (ver `.env.example`):

| Variável | Obrigatória | Para que serve |
| --- | --- | --- |
| `OPENAI_API_KEY` | para a análise | Chave da OpenAI, somente no servidor |
| `OPENAI_MODEL` | não | Troca o modelo; o padrão é `gpt-5.4-mini` |

---

## Dado torto entra marcado

**Nenhum dado errado impede um cadastro.** CPF que não fecha, título com dígito
a menos, telefone curto ou com dígito a mais, bairro de uma letra, CPF ou título
que já existem no time, telefone que já é de outra pessoa: a pessoa **entra**,
seja Líder ou Equipe, e a ficha nasce com uma etiqueta. Recusar por um número mal
copiado perde a pessoa, que fecha a página e não volta.

São duas etiquetas, porque são duas correções diferentes:

| Etiqueta | Quando | Regra |
| --- | --- | --- |
| **Incompleto** | Falta o dado | `src/lib/domain/member-completeness.ts` |
| **Conferir** | O dado está preenchido, mas não pode existir assim | `src/lib/domain/conferencia.ts` |

As duas são **calculadas**, nunca gravadas: corrigir a ficha tira a etiqueta
na hora. A regra de "Conferir" é uma só e vale em todo lugar: no aviso amarelo
embaixo do campo enquanto se preenche ("CPF não confere. Pode enviar assim
mesmo"), na lista da equipe (com o filtro **Situação**), na ficha (campo a
campo), na conferência da planilha e no quadro de inconsistências.

O que continua sendo exigido:

- **o nome**, que o banco exige. Sem ele ninguém sabe quem é a pessoa;
- **algum dígito** no telefone do formulário público, porque é por ele que a
  pessoa entra;
- **zona e seção**, quando o time está sem a confirmação da FonteData. É
  configuração do time, e não um dado torto.

Como cada caso é tratado:

- **Telefone com dígito a mais** fica **inteiro**, como veio
  (`digitosDoTelefone`): cortar daria um número que parece certo e liga para
  outra pessoa.
- **Telefone já usado no time** deixa entrar e não cria o acesso: o número
  continua sendo a credencial de uma pessoa só. A ficha mostra "telefone
  repetido no time". A exceção é a **edição**: quem edita está corrigindo, e
  gravar ali o telefone de outra pessoa derrubaria o acesso dela.
- **CPF que não fecha não vai para a FonteData.** A consulta é paga, e a resposta
  para um número que não existe já é sabida; a etapa eleitoral, que depende
  dele, também não acontece.
- **CPF e título repetidos** entram, e o quadro de inconsistências mostra os dois
  registros lado a lado.

Requer a migration `047_dado_torto_entra_marcado.sql`: sem ela, o banco ainda
recusa CPF fora de 11 dígitos, título fora de 12 e CPF ou título repetidos.

---

## Quadro de inconsistências

A página do time tem a aba **Inconsistências**, com um contador do que precisa de
atenção. Na **Visão geral**, uma faixa avisa assim que existe alguma coisa, porque
um cadastro repetido infla o total e o ranking que estão logo abaixo.

No topo fica a **saúde do cadastro**: a fração da equipe sem nenhum problema
sério. Ela é seguida pelas seções, da mais cara para a mais leve:

| Seção | O que mostra |
| --- | --- |
| Cadastrados mais de uma vez | A mesma pessoa em mais de um registro, com a linha do tempo de cada um: quando, por quem, pelo link ou pelo painel, onde mora e onde vota. Avisa quando a pessoa conta para dois responsáveis no ranking e em que os registros discordam |
| Cadastros incompletos | O que mais falta, de quem são os cadastros incompletos (em % de cada responsável) e quem completar |
| Dados que não fecham | Título, CPF ou telefone que não podem existir como estão; zona sem seção e vice-versa |
| Endereço fora do município | Outro estado ou município que não o da operação |
| Líderes sem acesso ao painel | Líder sem telefone válido, com número repetido ou com acesso desativado |
| Cadastrados por quem é da Equipe | O terceiro nível, de antes da regra Líder/Equipe |
| Responsável sem acesso | Cadastros cujo responsável foi removido: ninguém acompanha a pessoa |
| Pode ser a mesma pessoa | Mesmo nome e nada mais em comum. É uma pergunta, e não um erro |
| Telefone compartilhado | Pessoas diferentes com o mesmo número |
| Sem origem registrada | Cadastros de antes do rastreamento |

**Como a repetição é achada.** São cinco evidências, da mais forte para a mais
fraca: mesmo título, mesmo CPF, mesmo nome e telefone, mesmo nome e seção, e
mesmo nome. O nome é comparado sem acento, caixa, pontuação nem conectivo:
"José da Silva" e "JOSE SILVA" são o mesmo. A união é transitiva: se A tem o
título de B, e B tem o nome e o telefone de C, os três formam um grupo. O grupo
recebe a certeza da evidência mais forte que tem. A busca é por chave, e não
cada pessoa contra cada outra: cinco mil pessoas levam milissegundos.

**Nada é gravado.** O quadro é calculado no navegador, sobre a mesma lista que a
página já recebeu, com o mesmo recorte de hierarquia. Corrigir a ficha tira a
pessoa do quadro na hora. Cada nome abre a ficha, onde a correção acontece. O
filtro por responsável mostra só o que passa pelos cadastros dele, e um grupo de
repetidos aparece se *qualquer* registro for dele. O ADMIN geral baixa o quadro
inteiro em `.csv` (**Baixar relatório**). A regra fica em
`src/lib/domain/inconsistencias.ts`.

---

## Cadastrar a equipe por planilha

O botão **Planilha**, na barra da equipe, lê um `.csv` com **sete colunas**:

| Coluna | Observação |
| --- | --- |
| `Nome` | Única obrigatória: o banco não aceita cadastro sem nome |
| `Telefone` | Sem máscara ou com; dígito a mais é marcado para correção, nunca cortado |
| `Título` | Título de eleitor |
| `Zona` / `Seção` | O zero à frente sai, como na ficha |
| `Bairro` / `Rua` | Cada um na sua coluna |

**Estado e município são fixos:** Alagoas e Palmeira dos Índios
(`ENDERECO_FIXO`, em `src/lib/domain/csv-import.ts`). A planilha nem tem essas
colunas, e a conferência os mostra travados.

**Faltar não impede.** Célula vazia, ou coluna que nem existe no arquivo, vira
falta: a pessoa entra e a ficha nasce com a etiqueta **Incompleto**, que some
sozinha quando o dado é preenchido (`member-completeness.ts`).

As colunas são achadas pelo nome — ordem, acento e caixa não importam — e
coluna a mais é ignorada. A planilha antiga, com o endereço inteiro numa coluna
`Endereço`, continua aceita: sem `Bairro` e `Rua`, o texto é separado nos dois.
O botão **Baixar modelo** entrega o arquivo já no formato novo.

---

### Coluna VERIFICADO POR FOTO

A planilha aceita a coluna **VERIFICADO POR FOTO**, com `SIM` ou `NÃO` por
pessoa (maiúscula, minúscula ou sem acento, tanto faz). Em branco, ou qualquer
outro valor, conta como "não informado" — nunca como SIM. Na conferência, cada
linha mostra o valor e deixa trocar antes de cadastrar; a ficha da pessoa
mostra "Verificado por foto: SIM/NÃO". Vale pelos dois caminhos da planilha
(página do time e painel do Líder). O modelo para baixar já traz a coluna.

Grava em `cmd_members.photo_verified` (`true`, `false` ou nulo) e requer a
migration `050_verificado_por_foto.sql`. Sem ela, a linha com SIM/NÃO é
recusada com o nome da migration a executar, em vez de perder o valor calada.

### Coluna REFERÊNCIA

A planilha também aceita a coluna **REFERÊNCIA** (ou "Referencia", "Ponto de
referência", "Ref"), texto livre de até 200 caracteres. Quem tem, entra com
ela preenchida; quem não tem fica em branco **sem aviso nenhum** — não é
falta, não conta como incompleto e não pede conferência. Na conferência ela
aparece editável, e na ficha da pessoa só aparece quando existe.

Grava em `cmd_members.reference` e requer a migration `051_referencia.sql`.
Sem ela, a linha que traz referência é recusada com o nome da migration a
executar; a que não traz entra normalmente.

---

## Estrutura

```
src/
├── config/
│   ├── app.config.ts          Nome, logotipo, limites e textos de privacidade
│   └── theme.ts               Tokens lidos por código (movimento, breakpoints)
├── app/
│   ├── globals.css            TOKENS DE IDENTIDADE VISUAL + base + utilitários
│   ├── layout.tsx             Fonte, metadados, viewport e provider de avisos
│   ├── login/                 Tela de login
│   ├── (admin)/               Área protegida (dashboard e clientes)
│   ├── convite/[token]/       Rota pública de cadastro
│   └── api/                   Route Handlers: auth, clientes, integrantes
│                              e as rotas públicas do convite
├── proxy.ts                   Redirecionamento das rotas administrativas
├── components/
│   ├── ui/                    Biblioteca visual (sem regra de negócio)
│   ├── layout/                Casca do painel, sidebar, menu móvel, sessão
│   ├── auth/                  Formulário de login
│   ├── dashboard/             Painel inicial
│   ├── clients/               CRUD, página do cliente e convite
│   ├── fields/                Construtor de formulário e pré-visualização
│   ├── members/               Gestão da equipe
│   ├── form-renderer/         Renderização dos campos dinâmicos
│   ├── common/                Foto e cópia de link
│   └── public/                Página pública de convite
├── hooks/                     Consultas aos repositórios e utilidades de UI
└── lib/
    ├── types/                 Usuário, perfil, cliente, integrante, campo,
    │                          resposta e convite
    ├── permissions/           Matriz central de permissões
    ├── validation/            Schemas zod + validação dinâmica do formulário
    ├── domain/                Regras do construtor de formulário
    ├── repositories/          Interfaces + implementação HTTP (fonte oficial)
    │                          e a implementação local de referência
    ├── supabase/              Cliente PostgREST, Storage privado e variáveis
    ├── server/                Serviços server-only, guarda de permissão e
    │                          respostas de erro das rotas
    ├── mock/                  Dados de exemplo
    ├── auth/                  Senha scrypt, tokens e sessão do servidor
    └── utils/                 Telefone, data, imagem, texto, ID, área de transferência
```

### Principais arquivos

| Arquivo | Papel |
| --- | --- |
| `src/config/app.config.ts` | Identidade do sistema em um único lugar |
| `src/app/globals.css` | Tokens visuais e regras de acessibilidade |
| `src/lib/permissions/index.ts` | Matriz de permissões (ponto único de expansão) |
| `src/lib/repositories/types.ts` | Contratos de persistência |
| `src/lib/repositories/index.ts` | Fábrica de repositórios (ponto de troca) |
| `src/lib/validation/dynamic-form.ts` | Schema tipado gerado a partir dos campos |
| `src/lib/domain/form-config.ts` | Regras de campos, ordem e duplicação |
| `src/lib/domain/csv-export.ts` | As três colunas da planilha exportada da equipe |
| `src/lib/server/auth.service.ts` | Login, sessão e revogação sobre `cmd_users`/`cmd_sessions` |
| `src/lib/server/guard.ts` | Confere sessão e permissão em toda rota administrativa |
| `src/lib/supabase/rest.ts` | Único caminho até o banco, sempre no servidor |
| `src/lib/supabase/storage.ts` | Upload, exclusão e URL assinada do bucket privado |
| `src/lib/server/consent.ts` | Texto canônico e evidência do consentimento |
| `scripts/configurar-storage.mjs` | Criação idempotente do bucket pela API oficial |
| `src/lib/validation/server.schema.ts` | Zod de tudo que chega ao servidor |
| `src/lib/domain/api-docs.ts` | Documentação da API exibida em Configurações e conferida por teste |
| `src/lib/server/api-guard.ts` | Porta da API: chave `Bearer` ou sessão, sempre ADMIN geral |
| `src/lib/server/api-link.service.ts` | Geração, consulta e revogação dos links pela API |
| `supabase/migrations/001_cmd_initial.sql` | Estrutura completa do banco |
| `src/proxy.ts` | Redirecionamento das rotas administrativas |

---

## Decisões de arquitetura

**Repositórios assíncronos.** As telas conversam apenas com as interfaces
`ClientRepository` e `MemberRepository`. A implementação ativa fala com as rotas
de API do próprio Next.js, que são o único caminho até o Supabase. A troca de
persistência não alterou nenhum componente de tela.

**Campos com ID estável.** Cada campo do formulário tem um ID interno que nunca
muda. As respostas são gravadas por ID, não por título — renomear um campo não
quebra os dados já coletados. Antes de excluir um campo, o sistema informa
quantos integrantes já responderam a ele.

**Campos nativos.** Foto, nome e telefone existem em todo formulário. Podem ser
renomeados e reordenados; nome e telefone não podem ser desativados e o nome
permanece obrigatório, porque identifica o integrante.

**Fotos.** A imagem é validada (JPG, PNG, WEBP), redimensionada e comprimida no
navegador. O servidor valida tipo e tamanho outra vez, grava o arquivo no bucket
privado `cmd-media` e guarda no banco apenas o caminho e os metadados. O
navegador só recebe URLs assinadas, com validade curta.

**Movimento.** As animações são curtas e o CSS respeita
`prefers-reduced-motion`. O conteúdo de página anima apenas o deslocamento, sem
transparência, para nunca ficar invisível caso o navegador congele a animação
(aba em segundo plano, impressão, captura).

**Responsividade.** Layout verificado de 320 px a 1440 px, sem rolagem
horizontal indevida. Sidebar fixa a partir de `lg`, menu lateral deslizante no
celular, modais como painel inferior em telas pequenas, tabela de equipe apenas
no desktop e cartões no celular, alvos de toque de no mínimo 44 px e respeito às
áreas seguras do iPhone.

---

## Verificações executadas

- `npm run lint` — sem erros
- `npm run typecheck` — sem erros
- `npm test` — 38 testes (telefone, permissões, regras de formulário, validação
  dinâmica e repositórios)
- `npm run build` — build de produção concluído, sem avisos
- Conferência de que nenhuma chave secreta aparece no pacote enviado ao
  navegador

**Não verificado nesta etapa:** o banco não foi executado nem testado
remotamente. Os SQLs de `supabase/` precisam ser aplicados no seu projeto
Supabase e o fluxo ponta a ponta conferido no navegador, conforme o passo 6 de
[`supabase/SETUP.md`](supabase/SETUP.md).

---

## Próximos passos

1. **Perfil EQUIPE** — acrescentar as permissões em
   `src/lib/permissions/index.ts` e criar as rotas correspondentes; a navegação
   já é filtrada por permissão e `cmd_users.role` já aceita `EQUIPE`.
2. **Gestão de usuários pelo painel** — criar e desativar ADMINs pela interface,
   reaproveitando `src/lib/auth/password.ts`.
3. ~~**Exportação de dados** — CSV da equipe de um cliente~~ — **feito**, ver
   [Exportar a equipe em planilha](#exportar-a-equipe-em-planilha). O arquivo é
   montado no navegador, sobre a lista que a página já recebeu: uma rota de
   servidor só passa a ser necessária no dia em que a exportação precisar ir
   além do que a tela carrega.
