# Central de Automações — Portal Executivo de Gestão

Portal em Google Apps Script (Web App) que reúne controles de liderança, indicadores, planilhas e automações, com **perfis, permissões por recurso, favoritos pessoais e auditoria**.

## Estrutura

```
src/
  Codigo.gs        # backend (identidade, permissões, leitura/gravação na planilha)
  Index.html       # interface (portal + painel de administração)
  appsscript.json  # manifesto (Web App: executa como o dono, acesso no domínio)
.github/workflows/deploy.yml  # deploy automático a cada push na main
```

## Deploy automático

Cada push em `main` que altere `src/` executa `clasp push` e atualiza a implantação existente (mesma URL).

Secrets do repositório (Settings › Secrets and variables › Actions):

| Secret | Conteúdo |
|---|---|
| `CLASPRC_JSON` | conteúdo do `~/.clasprc.json` gerado por `clasp login` |
| `SCRIPT_ID` | ID do projeto Apps Script (Configurações do projeto) |
| `DEPLOYMENT_ID` | ID da implantação do Web App (Implantar › Gerenciar implantações) |

## Primeira execução

1. Após o primeiro deploy, abra o editor do Apps Script e execute `setup()` uma vez.
   Ele cria as abas **Usuarios**, **Favoritos** e **Log**, cadastra o dono como ADMIN e gera IDs para os recursos.
2. Abra o portal › 🛠️ Administração e cadastre os líderes.

## Planilha (aba `Config`)

| Coluna | Uso |
|---|---|
| A–G | Categoria, Destaque (S/N), Ícone, Nome, Descrição, Tags, Link (igual à v2) |
| `Acesso` | quem vê: vazio/`TODOS`, perfil (`LIDER` = líderes e admins), grupo (ex.: `Fiscal`) ou e-mail — separados por vírgula |
| `Ativo (S/N)` | vazio = ativo |
| `ID Portal` | gerado automaticamente — não editar |

As colunas `Acesso`, `Ativo (S/N)` e `ID Portal` são localizadas pelo nome e, se não existirem, criadas no fim da linha 1. Colunas extras já existentes (ex.: `Planilha`, `Versao 1`) não são alteradas.

## Perfis

- **ADMIN** — vê tudo e gerencia recursos/usuários. O dono do script é sempre ADMIN.
- **LIDER** — vê recursos liberados para todos, para `LIDER` ou para seus grupos.
- **COLABORADOR** — vê recursos liberados para todos ou para seus grupos.

> O portal controla quem **vê** cada link. O acesso real a cada planilha/sistema continua dependendo do compartilhamento no Drive/Jira.
