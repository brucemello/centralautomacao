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
const VERSAO = 'v3.1';

const ABAS = { RECURSOS: 'Config', USUARIOS: 'Usuarios', FAVORITOS: 'Favoritos', LOG: 'Log', SOLICITACOES: 'Solicitacoes' };

// true = recursos sem permissão aparecem com 🔒 e botão "Solicitar acesso" (o link nunca é enviado ao navegador)
const MOSTRAR_BLOQUEADOS = true;
// Envia e-mail aos administradores a cada nova solicitação e ao solicitante quando ela é decidida
const NOTIFICAR_POR_EMAIL = true;

const CAB_S = ['ID', 'Data', 'Email', 'Nome', 'Tipo', 'Recurso ID', 'Recurso', 'Motivo', 'Status', 'Decidido por', 'Data decisão', 'Observação'];
const TIPOS_SOLIC = { PORTAL: 'Acesso ao portal', RECURSO: 'Recurso bloqueado', LINK: 'Sem acesso ao link' };

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
    const pend = u.email ? lerSolicitacoes_().some(s => s.email === u.email && s.tipo === 'PORTAL' && s.status === 'PENDENTE') : false;
    return { versao: VERSAO, autorizado: false, email: u.email || '', pedidoPendente: pend };
  }
  registrarLog_(u.email, 'LOGIN', '');
  return Object.assign({
    versao: VERSAO,
    autorizado: true,
    usuario: { email: u.email, nome: u.nome, perfil: u.perfil, grupos: u.grupos, admin: u.admin }
  }, dadosPortal_(u));
}

function dadosPortal_(u) {
  const solic = lerSolicitacoes_();
  return {
    recursos: recursosVisiveis_(u),
    favoritos: lerFavoritos_(u.email),
    meusPedidos: solic.filter(s => s.email === u.email && s.status === 'PENDENTE' && s.recursoId).map(s => s.recursoId),
    pendentes: u.admin ? solic.filter(s => s.status === 'PENDENTE').length : 0
  };
}

/* ============================== API DO PORTAL ============================== */

function portalDados() {
  return dadosPortal_(exigirUsuario_());
}

/* ============================== SOLICITAÇÕES DE ACESSO ============================== */

/**
 * tipo PORTAL  → pessoa sem cadastro pede acesso ao portal
 * tipo RECURSO → usuário vê o card bloqueado e pede liberação
 * tipo LINK    → usuário vê o recurso, mas a planilha/sistema recusou o acesso (ex.: Drive)
 */
function solicitarAcesso(tipo, recursoId, motivo) {
  tipo = str_(tipo).toUpperCase();
  if (!TIPOS_SOLIC[tipo]) throw new Error('Tipo de solicitação inválido.');

  const u = usuarioAtual_();
  if (!u.email) throw new Error('Não foi possível identificar sua conta Google.');
  if (tipo !== 'PORTAL' && !u.autorizado) throw new Error('Acesso não autorizado.');

  let recurso = null;
  if (tipo !== 'PORTAL') {
    recurso = lerRecursos_().find(r => r.id === recursoId && r.ativo);
    if (!recurso) throw new Error('Recurso não encontrado.');
    if (tipo === 'RECURSO' && podeVer_(u, recurso)) throw new Error('Você já tem acesso a este recurso.');
    if (tipo === 'LINK' && !podeVer_(u, recurso)) throw new Error('Recurso indisponível.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let sol;
  try {
    const todas = lerSolicitacoes_();
    const minhas = todas.filter(s => s.email === u.email && s.status === 'PENDENTE');
    const duplicada = minhas.find(s => s.tipo === tipo && s.recursoId === (recurso ? recurso.id : ''));
    if (duplicada) return { ok: true, jaExistia: true };
    if (minhas.length >= 15) throw new Error('Você já tem muitas solicitações pendentes. Aguarde a análise.');

    sol = {
      id: 'S' + Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase(),
      email: u.email,
      nome: u.nome || '',
      tipo,
      recursoId: recurso ? recurso.id : '',
      recurso: recurso ? recurso.nome : 'Portal',
      motivo: str_(motivo).slice(0, 500)
    };
    garantirAba_(ABAS.SOLICITACOES, CAB_S).appendRow([
      sol.id, new Date(), sol.email, sol.nome, sol.tipo, sol.recursoId, sol.recurso, sol.motivo, 'PENDENTE', '', '', ''
    ]);
  } finally {
    lock.releaseLock();
  }

  registrarLog_(u.email, 'SOLICITOU_ACESSO', TIPOS_SOLIC[tipo] + (recurso ? ' · ' + recurso.nome : ''));
  notificarAdmins_(sol, recurso);
  return { ok: true };
}

function adminDecidirSolicitacao(id, aprovar, opcoes) {
  const admin = exigirAdmin_();
  opcoes = opcoes || {};
  const sh = aba_(ABAS.SOLICITACOES);
  if (!sh) throw new Error('Nenhuma solicitação encontrada.');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let s, linha, obs = '';
  try {
    const dados = sh.getDataRange().getValues();
    linha = dados.findIndex((l, i) => i > 0 && str_(l[0]) === id);
    if (linha < 0) throw new Error('Solicitação não encontrada.');
    s = linhaSolicitacao_(dados[linha]);
    if (s.status !== 'PENDENTE') throw new Error('Esta solicitação já foi decidida.');
  } finally {
    lock.releaseLock();
  }

  if (aprovar) {
    if (s.tipo === 'PORTAL') {
      const perfil = PERFIS.includes(str_(opcoes.perfil).toUpperCase()) ? str_(opcoes.perfil).toUpperCase() : 'COLABORADOR';
      gravarUsuario_({ email: s.email, nome: s.nome, perfil, grupos: lista_(opcoes.grupos), ativo: true });
      obs = 'Cadastrado como ' + perfil;
    } else if (s.tipo === 'RECURSO') {
      liberarRecursoPara_(s.recursoId, s.email);
      obs = 'Liberado no portal';
    } else {
      obs = 'Acesso ao link concedido';
    }
  }
  if (str_(opcoes.observacao)) obs = (obs ? obs + ' · ' : '') + str_(opcoes.observacao);

  sh.getRange(linha + 1, 9, 1, 4).setValues([[aprovar ? 'APROVADA' : 'NEGADA', admin.email, new Date(), obs]]);
  invalidarCache_();
  registrarLog_(admin.email, aprovar ? 'ADMIN_APROVOU' : 'ADMIN_NEGOU', s.email + ' · ' + s.recurso);
  notificarSolicitante_(s, aprovar, obs);
  return true;
}

function lerSolicitacoes_() {
  const sh = aba_(ABAS.SOLICITACOES);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getDataRange().getValues().slice(1).map(linhaSolicitacao_).filter(s => s.id);
}

function linhaSolicitacao_(l) {
  const tz = Session.getScriptTimeZone();
  const fmt = d => d instanceof Date ? Utilities.formatDate(d, tz, 'dd/MM/yyyy HH:mm') : str_(d);
  return {
    id: str_(l[0]), data: fmt(l[1]), email: str_(l[2]).toLowerCase(), nome: str_(l[3]),
    tipo: str_(l[4]).toUpperCase(), recursoId: str_(l[5]), recurso: str_(l[6]), motivo: str_(l[7]),
    status: str_(l[8]).toUpperCase(), decididoPor: str_(l[9]), dataDecisao: fmt(l[10]), obs: str_(l[11])
  };
}

/** Acrescenta o e-mail na coluna "Acesso" do recurso (preserva as regras existentes). */
function liberarRecursoPara_(recursoId, email) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = aba_(ABAS.RECURSOS);
    const col = colunasConfig_(sh);
    const total = Math.max(sh.getLastRow() - 1, 1);
    const ids = sh.getRange(2, col.ID + 1, total, 1).getValues().map(l => str_(l[0]));
    const i = ids.indexOf(recursoId);
    if (i < 0) throw new Error('Recurso não encontrado na planilha.');
    const cel = sh.getRange(i + 2, col.ACESSO + 1);
    const atual = lista_(cel.getValue());
    // Recurso sem regra já é visível a todos; só grava se houver restrição
    if (atual.length && !atual.some(a => a.toLowerCase() === email)) {
      cel.setValue(atual.concat(email).join(', '));
    }
  } finally {
    lock.releaseLock();
  }
}

/* ============================== E-MAILS ============================== */

function urlPortal_() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

function emailsAdmins_() {
  const dono = str_(Session.getEffectiveUser().getEmail()).toLowerCase();
  const admins = lerUsuarios_().filter(u => u.ativo && u.perfil === 'ADMIN').map(u => u.email);
  return [...new Set([dono].concat(admins).filter(Boolean))];
}

function enviarEmail_(para, assunto, titulo, corpoHtml, botao, copia) {
  if (!NOTIFICAR_POR_EMAIL || !para) return;
  const url = urlPortal_();
  const html = `
  <div style="background:#070a1a;padding:28px 12px;font-family:Segoe UI,Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto;background:#0e1330;border:1px solid #2a2f5a;border-radius:18px;overflow:hidden">
      <div style="height:5px;background:linear-gradient(90deg,#7c3aed,#06b6d4,#f472b6)"></div>
      <div style="padding:26px 28px;color:#e2e8ff">
        <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#22d3ee;font-weight:700">Portal Executivo de Gestão</div>
        <h2 style="margin:10px 0 14px;font-size:22px;color:#fff">${titulo}</h2>
        <div style="font-size:15px;line-height:1.65;color:#c7cdf3">${corpoHtml}</div>
        ${url ? `<a href="${url}" style="display:inline-block;margin-top:22px;padding:13px 22px;border-radius:12px;background:linear-gradient(135deg,#7c3aed,#06b6d4);color:#fff;text-decoration:none;font-weight:700">${botao || 'Abrir o portal'} →</a>` : ''}
      </div>
    </div>
  </div>`;
  try {
    const msg = { to: para, subject: assunto, htmlBody: html, name: 'Portal de Gestão' };
    if (copia && str_(copia).toLowerCase() !== str_(para).toLowerCase()) msg.cc = copia;
    MailApp.sendEmail(msg);
  } catch (e) {
    console.error('Falha ao enviar e-mail: ' + e);
  }
}

function notificarAdmins_(s, recurso) {
  const quem = esc_(s.nome ? s.nome + ' (' + s.email + ')' : s.email);
  let corpo = `<b>${quem}</b> pediu: <b>${esc_(TIPOS_SOLIC[s.tipo])}</b>`;
  if (recurso) corpo += `<br>Recurso: <b>${esc_(recurso.icone + ' ' + recurso.nome)}</b>`;
  if (s.motivo) corpo += `<br><br><i>“${esc_(s.motivo)}”</i>`;
  if (s.tipo === 'LINK' && recurso) {
    corpo += `<br><br>O recurso já aparece no portal para essa pessoa, mas o sistema de destino recusou o acesso. Compartilhe o arquivo diretamente:<br><a href="${esc_(recurso.link)}" style="color:#22d3ee">${esc_(recurso.link)}</a>`;
  }
  corpo += '<br><br>Aprove ou negue em <b>Administração › Solicitações</b>.';
  enviarEmail_(emailsAdmins_().join(','), '🔔 Solicitação de acesso · ' + s.recurso, 'Nova solicitação de acesso', corpo, 'Analisar no portal');
}

function notificarSolicitante_(s, aprovado, obs) {
  const corpo = aprovado
    ? `Sua solicitação <b>${esc_(TIPOS_SOLIC[s.tipo])}</b>${s.recursoId ? ' para <b>' + esc_(s.recurso) + '</b>' : ''} foi <b style="color:#34d399">aprovada</b>.` + (obs ? `<br><br>${esc_(obs)}` : '')
    : `Sua solicitação <b>${esc_(TIPOS_SOLIC[s.tipo])}</b>${s.recursoId ? ' para <b>' + esc_(s.recurso) + '</b>' : ''} não foi aprovada.` + (obs ? `<br><br>${esc_(obs)}` : '');
  enviarEmail_(s.email, (aprovado ? '✅ Acesso liberado · ' : 'Solicitação de acesso · ') + s.recurso,
    aprovado ? 'Acesso liberado' : 'Solicitação analisada', corpo);
}

function enviarConvite_(email, nome, perfil, admin) {
  const primeiro = esc_((nome || email).split(/[ @]/)[0]);
  const corpo = `Olá, ${primeiro}!<br><br><b>${esc_(admin.nome || admin.email)}</b> liberou seu acesso ao <b>Portal Executivo de Gestão</b> com o perfil <b>${esc_(perfil)}</b>.<br><br>`
    + 'Lá você encontra num só lugar os controles de liderança, indicadores, planilhas de gestão e automações do time. Entre com a sua conta Google corporativa e marque ☆ nos recursos que mais usa para criar seu acesso rápido.';
  // Quem convidou recebe cópia (Cc)
  enviarEmail_(email, '🚀 Convite · Portal Executivo de Gestão', 'Você foi convidado para o portal', corpo, 'Acessar o portal', admin.email);
}

function adminReenviarConvite(email) {
  const admin = exigirAdmin_();
  const u = lerUsuarios_().find(x => x.email === str_(email).toLowerCase());
  if (!u || !u.ativo) throw new Error('Usuário não encontrado ou inativo.');
  enviarConvite_(u.email, u.nome, u.perfil, admin);
  registrarLog_(admin.email, 'ADMIN_ENVIOU_CONVITE', u.email);
  return true;
}

function nomeDoEmail_(email) {
  return str_(email).split('@')[0].split(/[._-]+/).filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ') || 'Administrador';
}

function esc_(v) {
  return str_(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

  const solicitacoes = lerSolicitacoes_().reverse().slice(0, 300);
  const pendentes = solicitacoes.filter(x => x.status === 'PENDENTE').length;

  return { recursos, usuarios, grupos, categorias, perfis: PERFIS, log, ranking, solicitacoes, pendentes, tipos: TIPOS_SOLIC };
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
  if (email === admin.email && !admin.dono && (perfil !== 'ADMIN' || !ativo)) {
    throw new Error('Você não pode remover o seu próprio acesso de administrador.');
  }
  gravarUsuario_({ email, nome: x.nome, perfil, grupos: x.grupos, ativo, novo: !!x.novo });
  registrarLog_(admin.email, 'ADMIN_SALVOU_USUARIO', email + ' → ' + perfil + (ativo ? '' : ' (inativo)'));

  let convite = false;
  if (x.convite && ativo) {
    enviarConvite_(email, str_(x.nome), perfil, admin);
    registrarLog_(admin.email, 'ADMIN_ENVIOU_CONVITE', email);
    convite = true;
  }
  return { ok: true, convite };
}

function gravarUsuario_(x) {
  const email = str_(x.email).toLowerCase();
  const perfil = str_(x.perfil).toUpperCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('E-mail inválido.');
  if (!PERFIS.includes(perfil)) throw new Error('Perfil inválido.');

  const linha = [email, str_(x.nome), perfil, lista_(x.grupos).join(', '), x.ativo ? 'S' : 'N'];
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
      email, nome: (cadastro && cadastro.nome) || nomeDoEmail_(email), perfil: 'ADMIN',
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

/** Recursos liberados (com link) + recursos bloqueados (sem link, para solicitar acesso). */
function recursosVisiveis_(u) {
  const lista = [];
  lerRecursos_().forEach(r => {
    if (!r.ativo) return;
    const base = { id: r.id, categoria: r.categoria, destaque: r.destaque, icone: r.icone, nome: r.nome, descricao: r.descricao, tags: r.tags };
    if (podeVer_(u, r)) lista.push(Object.assign(base, { link: r.link, bloqueado: false }));
    else if (MOSTRAR_BLOQUEADOS) lista.push(Object.assign(base, { link: '', bloqueado: true, destaque: false }));
  });
  return lista;
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
  garantirAba_(ABAS.SOLICITACOES, CAB_S);

  const dono = Session.getEffectiveUser().getEmail();
  if (usuarios.getLastRow() < 2) usuarios.appendRow([dono, nomeDoEmail_(dono), 'ADMIN', '', 'S']);

  const regraPerfil = SpreadsheetApp.newDataValidation().requireValueInList(PERFIS, true).build();
  usuarios.getRange('C2:C').setDataValidation(regraPerfil);
  const regraSN = SpreadsheetApp.newDataValidation().requireValueInList(['S', 'N'], true).build();
  usuarios.getRange('E2:E').setDataValidation(regraSN);

  invalidarCache_();
  lerRecursos_(); // gera IDs para as linhas existentes
  // Força a autorização do envio de e-mails (convites e notificações)
  Logger.log('Cota de e-mails restante hoje: ' + MailApp.getRemainingDailyQuota());
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
