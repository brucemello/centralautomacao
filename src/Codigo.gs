/**
 * Portal Executivo de Gestão e Automações
 * Apps Script Web App v3.0 — Multi-líder com perfis, permissões, favoritos pessoais e auditoria
 *
 * IMPLANTAÇÃO (Implantar > Nova implantação > App da Web):
 *   - Executar como: Eu (dono do script)
 *   - Quem pode acessar: Qualquer pessoa em <seu domínio corporativo>
 *
 * PRIMEIRA VEZ: execute a função setup() uma vez pelo editor.
 * Deploy automático via GitHub Actions (ver README.md).
 */

const PLANILHA_ID = '1jG5B4WurfXUdSLkVYgEk-rWIaYQwawupVp4a1E7PFLg';
const VERSAO = 'v3.0';

const ABAS = { RECURSOS: 'Config', USUARIOS: 'Usuarios', FAVORITOS: 'Favoritos', LOG: 'Log' };

// Aba Config — colunas A..G iguais à v2.x (posição fixa).
// As colunas novas (Acesso, Ativo, ID) são localizadas pelo NOME do cabeçalho;
// se não existirem, são criadas no fim da linha 1, sem mexer em colunas já usadas (ex.: Planilha, Versao 1).
const COL_R = { CATEGORIA: 0, DESTAQUE: 1, ICONE: 2, NOME: 3, DESCRICAO: 4, TAGS: 5, LINK: 6 };
const COLS_EXTRAS = { ACESSO: 'Acesso', ATIVO: 'Ativo (S/N)', ID: 'ID Portal' };

// Aba Usuarios
const CAB_U = ['Email', 'Nome', 'Perfil', 'Grupos', 'Ativo (S/N)'];

// Perfis em ordem hierárquica: um recurso liberado para LIDER também aparece para ADMIN
const PERFIS = ['ADMIN', 'LIDER', 'COLABORADOR'];
const NIVEL = { ADMIN: 3, LIDER: 2, COLABORADOR: 1 };

const CACHE_USUARIOS = 'usuarios_v3';
const CACHE_RECURSOS = 'recursos_v3';

/* ============================== ENTRADA ============================== */

function doGet() {
  const t = HtmlService.createTemplateFromFile('Index');
  t.boot = JSON.stringify(montarBoot_()).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle('Portal de Gestão e Automações')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function montarBoot_() {
  const u = usuarioAtual_();
  if (!u.autorizado) {
    registrarLog_(u.email || '(não identificado)', 'ACESSO_NEGADO', '');
    return { versao: VERSAO, autorizado: false, email: u.email || '' };
  }
  registrarLog_(u.email, 'LOGIN', '');
  return {
    versao: VERSAO,
    autorizado: true,
    usuario: { email: u.email, nome: u.nome, perfil: u.perfil, grupos: u.grupos, admin: u.admin },
    recursos: recursosVisiveis_(u),
    favoritos: lerFavoritos_(u.email)
  };
}

/* ============================== API DO PORTAL ============================== */

function portalDados() {
  const u = exigirUsuario_();
  return { recursos: recursosVisiveis_(u), favoritos: lerFavoritos_(u.email) };
}

function registrarAcesso(id) {
  const u = exigirUsuario_();
  const r = lerRecursos_().find(x => x.id === id);
  if (!r || !podeVer_(u, r)) throw new Error('Sem permissão para este recurso.');
  registrarLog_(u.email, 'ABRIR_RECURSO', r.nome);
  return true;
}

function alternarFavorito(id) {
  const u = exigirUsuario_();
  const r = lerRecursos_().find(x => x.id === id);
  if (!r || !podeVer_(u, r)) throw new Error('Recurso indisponível.');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = garantirAba_(ABAS.FAVORITOS, ['Email', 'Favoritos (IDs)']);
    const dados = sh.getDataRange().getValues();
    const idx = dados.findIndex((l, i) => i > 0 && str_(l[0]).toLowerCase() === u.email);
    let favs = idx > 0 ? lista_(dados[idx][1]) : [];
    favs = favs.includes(id) ? favs.filter(f => f !== id) : favs.concat(id);
    if (idx > 0) sh.getRange(idx + 1, 2).setValue(favs.join(','));
    else sh.appendRow([u.email, favs.join(',')]);
    return favs;
  } finally {
    lock.releaseLock();
  }
}

/* ============================== API DE ADMINISTRAÇÃO ============================== */

function adminDados() {
  exigirAdmin_();
  const recursos = lerRecursos_();
  const usuarios = lerUsuarios_();
  const grupos = [...new Set(usuarios.flatMap(u => u.grupos))].sort();
  const categorias = [...new Set(recursos.map(r => r.categoria))].sort();

  let log = [];
  const sh = aba_(ABAS.LOG);
  if (sh && sh.getLastRow() > 1) {
    const n = Math.min(300, sh.getLastRow() - 1);
    const tz = Session.getScriptTimeZone();
    log = sh.getRange(sh.getLastRow() - n + 1, 1, n, 4).getValues().reverse().map(l => ({
      data: l[0] instanceof Date ? Utilities.formatDate(l[0], tz, 'dd/MM/yyyy HH:mm') : str_(l[0]),
      email: str_(l[1]), acao: str_(l[2]), detalhe: str_(l[3])
    }));
  }

  const contagem = {};
  log.filter(l => l.acao === 'ABRIR_RECURSO').forEach(l => { contagem[l.detalhe] = (contagem[l.detalhe] || 0) + 1; });
  const ranking = Object.keys(contagem).map(nome => ({ nome, total: contagem[nome] }))
    .sort((a, b) => b.total - a.total).slice(0, 8);

  return { recursos, usuarios, grupos, categorias, perfis: PERFIS, log, ranking };
}

function adminSalvarRecurso(r) {
  const admin = exigirAdmin_();
  const nome = str_(r.nome);
  const link = str_(r.link);
  if (!nome) throw new Error('Informe o nome do recurso.');
  if (!/^https?:\/\//i.test(link)) throw new Error('O link deve começar com http:// ou https://');

  const id = str_(r.id) || novoId_();
  const base = [
    str_(r.categoria) || 'Geral',
    r.destaque ? 'S' : 'N',
    str_(r.icone) || '🔗',
    nome,
    str_(r.descricao),
    lista_(r.tags).join(', '),
    link
  ];

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = aba_(ABAS.RECURSOS);
    const col = colunasConfig_(sh);
    let linhaPlanilha;
    if (r.id) {
      const total = Math.max(sh.getLastRow() - 1, 1);
      const ids = sh.getRange(2, col.ID + 1, total, 1).getValues().map(l => str_(l[0]));
      const i = ids.indexOf(r.id);
      if (i < 0) throw new Error('Recurso não encontrado na planilha.');
      linhaPlanilha = i + 2;
    } else {
      linhaPlanilha = Math.max(sh.getLastRow(), 1) + 1;
    }
    // Grava só as colunas do portal; demais colunas (ex.: Planilha, Versao 1) ficam intactas
    sh.getRange(linhaPlanilha, 1, 1, base.length).setValues([base]);
    sh.getRange(linhaPlanilha, col.ACESSO + 1).setValue(lista_(r.acesso).join(', '));
    sh.getRange(linhaPlanilha, col.ATIVO + 1).setValue(r.ativo ? 'S' : 'N');
    sh.getRange(linhaPlanilha, col.ID + 1).setValue(id);
  } finally {
    lock.releaseLock();
  }
  invalidarCache_();
  registrarLog_(admin.email, r.id ? 'ADMIN_EDITOU_RECURSO' : 'ADMIN_CRIOU_RECURSO', nome);
  return id;
}

function adminSalvarUsuario(x) {
  const admin = exigirAdmin_();
  const email = str_(x.email).toLowerCase();
  const perfil = str_(x.perfil).toUpperCase();
  const ativo = !!x.ativo;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('E-mail inválido.');
  if (!PERFIS.includes(perfil)) throw new Error('Perfil inválido.');
  if (email === admin.email && !admin.dono && (perfil !== 'ADMIN' || !ativo)) {
    throw new Error('Você não pode remover o seu próprio acesso de administrador.');
  }

  const linha = [email, str_(x.nome), perfil, lista_(x.grupos).join(', '), ativo ? 'S' : 'N'];
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = garantirAba_(ABAS.USUARIOS, CAB_U);
    const dados = sh.getDataRange().getValues();
    const idx = dados.findIndex((l, i) => i > 0 && str_(l[0]).toLowerCase() === email);
    if (x.novo && idx > 0) throw new Error('Este e-mail já está cadastrado.');
    if (idx > 0) sh.getRange(idx + 1, 1, 1, linha.length).setValues([linha]);
    else sh.appendRow(linha);
  } finally {
    lock.releaseLock();
  }
  invalidarCache_();
  registrarLog_(admin.email, 'ADMIN_SALVOU_USUARIO', email + ' → ' + perfil + (ativo ? '' : ' (inativo)'));
  return true;
}

/* ============================== IDENTIDADE E PERMISSÕES ============================== */

function usuarioAtual_() {
  const email = str_(Session.getActiveUser().getEmail()).toLowerCase();
  if (!email) return { autorizado: false, email: '' };

  const dono = str_(Session.getEffectiveUser().getEmail()).toLowerCase();
  const cadastro = lerUsuarios_().find(u => u.email === email);

  // O dono do script é sempre ADMIN (evita ficar trancado para fora)
  if (email === dono) {
    return {
      email, nome: (cadastro && cadastro.nome) || 'Proprietário', perfil: 'ADMIN',
      grupos: cadastro ? cadastro.grupos : [], autorizado: true, admin: true, dono: true
    };
  }
  if (cadastro && cadastro.ativo) {
    return Object.assign({}, cadastro, { autorizado: true, admin: cadastro.perfil === 'ADMIN', dono: false });
  }
  return { autorizado: false, email };
}

function exigirUsuario_() {
  const u = usuarioAtual_();
  if (!u.autorizado) throw new Error('Acesso não autorizado.');
  return u;
}

function exigirAdmin_() {
  const u = exigirUsuario_();
  if (!u.admin) throw new Error('Apenas administradores podem fazer isso.');
  return u;
}

/**
 * Regras da coluna "Acesso" (H), separadas por vírgula:
 *   vazio ou TODOS  → qualquer usuário cadastrado
 *   ADMIN/LIDER/COLABORADOR → esse perfil e os superiores
 *   nome de grupo (ex.: Fiscal) → usuários com esse grupo
 *   e-mail → apenas essa pessoa
 */
function podeVer_(u, r) {
  if (!r.ativo) return false;
  if (u.admin) return true;
  if (!r.acesso.length) return true;

  const email = u.email.toUpperCase();
  const grupos = u.grupos.map(g => g.toUpperCase());
  const nivel = NIVEL[u.perfil] || 1;

  return r.acesso.some(tok => {
    const t = tok.toUpperCase();
    if (t === 'TODOS') return true;
    if (NIVEL[t]) return nivel >= NIVEL[t];
    return t === email || grupos.includes(t);
  });
}

function recursosVisiveis_(u) {
  return lerRecursos_().filter(r => podeVer_(u, r)).map(r => ({
    id: r.id, categoria: r.categoria, destaque: r.destaque, icone: r.icone,
    nome: r.nome, descricao: r.descricao, tags: r.tags, link: r.link
  }));
}

/* ============================== LEITURA DA PLANILHA ============================== */

function lerRecursos_() {
  const cache = CacheService.getScriptCache();
  const c = cache.get(CACHE_RECURSOS);
  if (c) return JSON.parse(c);

  const sh = aba_(ABAS.RECURSOS);
  if (!sh) throw new Error('A aba "Config" não foi encontrada.');
  const col = colunasConfig_(sh);
  const dados = sh.getDataRange().getValues();
  dados.shift();

  const lista = [];
  dados.forEach((l, i) => {
    const nome = str_(l[COL_R.NOME]);
    const link = str_(l[COL_R.LINK]);
    if (!nome || !link || link === '#') return;

    let id = str_(l[col.ID]);
    if (!id) {
      id = novoId_();
      sh.getRange(i + 2, col.ID + 1).setValue(id);
    }
    lista.push({
      id,
      categoria: str_(l[COL_R.CATEGORIA]) || 'Geral',
      destaque: sim_(l[COL_R.DESTAQUE]),
      icone: str_(l[COL_R.ICONE]) || '🔗',
      nome,
      descricao: str_(l[COL_R.DESCRICAO]),
      tags: lista_(l[COL_R.TAGS]),
      link,
      acesso: lista_(l[col.ACESSO]),
      ativo: str_(l[col.ATIVO]) === '' ? true : sim_(l[col.ATIVO])
    });
  });

  try { cache.put(CACHE_RECURSOS, JSON.stringify(lista), 120); } catch (e) { /* lista grande demais p/ cache */ }
  return lista;
}

function lerUsuarios_() {
  const cache = CacheService.getScriptCache();
  const c = cache.get(CACHE_USUARIOS);
  if (c) return JSON.parse(c);

  const sh = aba_(ABAS.USUARIOS);
  if (!sh) return [];
  const dados = sh.getDataRange().getValues();
  dados.shift();

  const lista = dados.map(l => {
    const perfil = str_(l[2]).toUpperCase();
    return {
      email: str_(l[0]).toLowerCase(),
      nome: str_(l[1]),
      perfil: PERFIS.includes(perfil) ? perfil : 'COLABORADOR',
      grupos: lista_(l[3]),
      ativo: str_(l[4]) === '' ? true : sim_(l[4])
    };
  }).filter(u => u.email);

  try { cache.put(CACHE_USUARIOS, JSON.stringify(lista), 300); } catch (e) {}
  return lista;
}

function lerFavoritos_(email) {
  const sh = aba_(ABAS.FAVORITOS);
  if (!sh) return [];
  const linha = sh.getDataRange().getValues().find((l, i) => i > 0 && str_(l[0]).toLowerCase() === email);
  return linha ? lista_(linha[1]) : [];
}

/* ============================== AUDITORIA ============================== */

function registrarLog_(email, acao, detalhe) {
  try {
    const sh = garantirAba_(ABAS.LOG, ['Data/Hora', 'Email', 'Ação', 'Detalhe']);
    sh.appendRow([new Date(), email, acao, detalhe]);
    if (sh.getLastRow() > 6000) sh.deleteRows(2, 1000); // mantém o log enxuto
  } catch (e) {
    console.error('Falha ao registrar log: ' + e);
  }
}

/* ============================== SETUP (executar 1x) ============================== */

function setup() {
  const ss = planilha_();
  const config = ss.getSheetByName(ABAS.RECURSOS);
  if (!config) throw new Error('A aba "Config" não foi encontrada.');
  colunasConfig_(config); // cria Acesso / Ativo / ID Portal no fim, se faltarem

  const usuarios = garantirAba_(ABAS.USUARIOS, CAB_U);
  garantirAba_(ABAS.FAVORITOS, ['Email', 'Favoritos (IDs)']);
  garantirAba_(ABAS.LOG, ['Data/Hora', 'Email', 'Ação', 'Detalhe']);

  const dono = Session.getEffectiveUser().getEmail();
  if (usuarios.getLastRow() < 2) usuarios.appendRow([dono, 'Proprietário', 'ADMIN', '', 'S']);

  const regraPerfil = SpreadsheetApp.newDataValidation().requireValueInList(PERFIS, true).build();
  usuarios.getRange('C2:C').setDataValidation(regraPerfil);
  const regraSN = SpreadsheetApp.newDataValidation().requireValueInList(['S', 'N'], true).build();
  usuarios.getRange('E2:E').setDataValidation(regraSN);

  invalidarCache_();
  lerRecursos_(); // gera IDs para as linhas existentes
  Logger.log('Setup concluído. Admin inicial: ' + dono);
}

/* ============================== UTILITÁRIOS ============================== */

let _ss = null;
function planilha_() { return _ss || (_ss = SpreadsheetApp.openById(PLANILHA_ID)); }
function aba_(nome) { return planilha_().getSheetByName(nome); }

function garantirAba_(nome, cabecalho) {
  let sh = aba_(nome);
  if (!sh) {
    sh = planilha_().insertSheet(nome);
    sh.getRange(1, 1, 1, cabecalho.length).setValues([cabecalho]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/**
 * Localiza (pelo nome do cabeçalho) as colunas Acesso, Ativo e ID Portal da aba Config.
 * As que não existirem são criadas após a última coluna preenchida da linha 1.
 * Retorna índices base 0.
 */
function colunasConfig_(sh) {
  const ultima = Math.max(sh.getLastColumn(), COL_R.LINK + 1);
  const cab = sh.getRange(1, 1, 1, ultima).getValues()[0].map(normalizar_);
  let proxima = cab.length;
  while (proxima > 0 && cab[proxima - 1] === '') proxima--;

  const res = {};
  Object.keys(COLS_EXTRAS).forEach(k => {
    const nome = COLS_EXTRAS[k];
    const alvo = normalizar_(nome);
    const curto = normalizar_(nome.replace(/\s*\(.*\)$/, ''));
    let idx = cab.findIndex((h, i) => i > COL_R.LINK && (h === alvo || h === curto));
    if (idx < 0) {
      idx = Math.max(proxima, COL_R.LINK + 1);
      sh.getRange(1, idx + 1).setValue(nome).setFontWeight('bold');
      cab[idx] = alvo;
      proxima = idx + 1;
    }
    res[k] = idx;
  });
  return res;
}

function normalizar_(v) {
  return str_(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function invalidarCache_() {
  CacheService.getScriptCache().removeAll([CACHE_USUARIOS, CACHE_RECURSOS]);
}

function novoId_() { return 'R' + Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase(); }
function str_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function sim_(v) { return ['S', 'SIM', 'TRUE', 'Y', 'X'].includes(str_(v).toUpperCase()); }
function lista_(v) {
  if (Array.isArray(v)) return v.map(str_).filter(Boolean);
  return str_(v).split(',').map(s => s.trim()).filter(Boolean);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
