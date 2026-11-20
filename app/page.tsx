"use client";

import {
  ArrowDown,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  Clapperboard,
  Download,
  ExternalLink,
  FileImage,
  Film,
  ImagePlus,
  LayoutDashboard,
  MoreHorizontal,
  Moon,
  Palette,
  Plus,
  Copy,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  Upload,
  Video,
  WandSparkles,
  X,
} from "lucide-react";
import { ChangeEvent, DragEvent, useEffect, useMemo, useState } from "react";
import {
  createCampaign,
  getCurrentUser,
  getJob,
  importLegacyProject,
  logIn,
  logOut,
  listProjects,
  AuthUser,
  Project,
  ProjectStatus,
  updateProject as persistProject,
  uploadProductImage,
  signUp,
  requestPasswordReset,
  resetPassword,
  VideoRatio,
} from "./lib/api";
import {
  CampaignGoal,
  createOfferText,
  generateDemoCampaign,
  MarketingCampaign,
  MarketingInput,
  PlatformTarget,
} from "./lib/marketing";
import { getProductImage } from "./lib/product-image-store";

type Goal = CampaignGoal;
type Ratio = VideoRatio;
type BrandKit = {
  name: string;
  primary: string;
  secondary: string;
  voice: string;
};
type View = "overview" | "projects" | "brand" | "settings";
type CreateProjectInput = MarketingInput & {
  ratio: Ratio;
  image: File;
};

const defaultBrand: BrandKit = {
  name: "Minha marca",
  primary: "#6F5AE8",
  secondary: "#FFFFFF",
  voice: "Feminina · Natural",
};

const goals: Goal[] = [
  "Oferta relâmpago",
  "Lançamento",
  "Dor e solução",
  "Prova social",
];
const ratios: Ratio[] = ["9:16", "1:1", "4:5", "16:9"];

function readStored<T>(key: string, fallback: T): T {
  try {
    const stored = window.localStorage.getItem(key);
    return stored ? (JSON.parse(stored) as T) : fallback;
  } catch {
    return fallback;
  }
}

function ProductTile({
  product,
  compact = false,
}: {
  product: string;
  compact?: boolean;
}) {
  const icon = product.toLowerCase().includes("fone") ? "⌁" : product.toLowerCase().includes("skincare") ? "✳" : "◉";
  return (
    <div className={`product-tile${compact ? " product-tile-compact" : ""}`}>
      <span className="product-orbit product-orbit-one" />
      <span className="product-orbit product-orbit-two" />
      <span className="product-object">{icon}</span>
      <span className="tile-label">{product}</span>
    </div>
  );
}

function ProjectStatusPill({ status }: { status: ProjectStatus }) {
  const labels = {
    completed: "Pronto",
    processing: "Gerando",
    queued: "Na fila",
    preview: "Prévia",
    failed: "Falhou",
  };
  return (
    <span className={`status-pill status-${status}`}>
      {status === "completed" ? <CheckCircle2 size={13} /> : status === "failed" ? <X size={13} /> : <span className="status-dot" />}
      {labels[status]}
    </span>
  );
}

export default function Home() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [view, setView] = useState<View>("overview");
  const [projects, setProjects] = useState<Project[]>([]);
  const [brand, setBrand] = useState<BrandKit>(defaultBrand);
  const [credits, setCredits] = useState(28.5);
  const [hydrated, setHydrated] = useState(false);
  const [backendError, setBackendError] = useState("");
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [selectedImageUrl, setSelectedImageUrl] = useState("");

  useEffect(() => {
    void getCurrentUser().then(setAuthUser).catch(() => setAuthUser(null)).finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    if (!authUser) return;
    let cancelled = false;
    const storedProjects = window.localStorage.getItem("vitrine.projects");
    let legacyProjects: Project[] = [];
    let legacyReadError = "";
    if (storedProjects) {
      try {
        const parsed: unknown = JSON.parse(storedProjects);
        if (!Array.isArray(parsed)) throw new Error("O armazenamento local de projetos está inválido.");
        legacyProjects = parsed.map((entry: Partial<Project>) => {
          const platform = entry.platform ?? "TikTok";
          const campaign = entry.campaign ?? generateDemoCampaign({
            product: entry.product || entry.title || "Produto",
            goal: entry.goal ?? "Oferta relâmpago",
            platform,
            price: entry.price || undefined,
            originalPrice: entry.originalPrice,
          });
          return {
            ...entry,
            id: entry.id ?? crypto.randomUUID(),
            title: entry.title ?? entry.product ?? "Projeto local",
            product: entry.product ?? entry.title ?? "Produto",
            goal: entry.goal ?? "Oferta relâmpago",
            platform,
            ratio: entry.ratio ?? "9:16",
            price: entry.price ?? "",
            headline: entry.headline ?? campaign.hook,
            campaign,
            status: campaign.provider === "demo" ? "preview" : entry.status ?? "preview",
            progress: entry.progress ?? 100,
            createdAt: entry.createdAt ?? new Date().toISOString(),
            version: entry.version ?? 1,
            background: entry.background ?? 0,
          } as Project;
        });
        setProjects(legacyProjects);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Não foi possível ler os projetos locais.";
        legacyReadError = message;
        setBackendError(message);
      }
    }
    setBrand(readStored("vitrine.brand", defaultBrand));
    setCredits(readStored("vitrine.credits", 28.5));
    setTheme(readStored("vitrine.theme", "light"));
    setHydrated(true);

    void (async () => {
      try {
        if (legacyReadError) throw new Error(legacyReadError);
        let migrationWarning = "";
        if (storedProjects && window.localStorage.getItem("vitrine.projects.migration.v1") !== "complete") {
          for (const project of legacyProjects) {
            let imageKey: string | undefined;
            if (project.imageKey) {
              const image = await getProductImage(project.imageKey);
              if (!image) {
                migrationWarning = "Um projeto foi importado sem a foto local, que não estava mais disponível neste navegador.";
              } else {
                const uploaded = await uploadProductImage(new File([image], "product-image", { type: image.type }));
                imageKey = uploaded.imageKey;
              }
            }
            await importLegacyProject({
              ...project,
              legacyId: project.id,
              imageKey,
            });
          }
        }
        const serverProjects = await listProjects();
        if (cancelled) return;
        if (storedProjects) {
          window.localStorage.setItem("vitrine.projects.migration.v1", "complete");
          window.localStorage.removeItem("vitrine.projects");
        }
        setProjects(serverProjects);
        setBackendError(migrationWarning);
      } catch (error) {
        if (!cancelled) {
          setBackendError(error instanceof Error ? error.message : "Não foi possível conectar à API local.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authUser]);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem("vitrine.brand", JSON.stringify(brand));
    window.localStorage.setItem("vitrine.credits", JSON.stringify(credits));
    window.localStorage.setItem("vitrine.theme", JSON.stringify(theme));
  }, [brand, credits, theme, hydrated]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const selected = projects.find((project) => project.id === selectedProject) ?? null;
  useEffect(() => {
    let objectUrl = "";
    let cancelled = false;
    setSelectedImageUrl("");

    if (selected?.imageUrl) {
      setSelectedImageUrl(selected.imageUrl);
      return;
    }
    if (!selected?.imageKey) return;

    void getProductImage(selected.imageKey)
      .then((image) => {
        if (!image) throw new Error("A imagem salva deste projeto não foi encontrada neste navegador.");
        objectUrl = URL.createObjectURL(image);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setSelectedImageUrl(objectUrl);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setToast(error instanceof Error ? error.message : "Não foi possível carregar a imagem do projeto.");
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [selected?.imageKey, selected?.imageUrl]);

  const pendingJobIds = projects.flatMap((project) =>
    project.jobId && (project.status === "queued" || project.status === "processing") ? [project.jobId] : [],
  ).sort();
  const pendingJobKey = pendingJobIds.join(",");
  useEffect(() => {
    if (!pendingJobKey) return;
    const ids = pendingJobKey.split(",");
    let cancelled = false;
    const poll = async () => {
      try {
        const jobs = await Promise.all(ids.map((id) => getJob(id)));
        if (cancelled) return;
        if (jobs.some((job) => job.status === "completed" || job.status === "failed")) {
          setProjects(await listProjects());
        } else {
          setProjects((current) => current.map((project) => {
            const job = jobs.find((item) => item.id === project.jobId);
            return job ? { ...project, status: job.status, progress: job.progress } : project;
          }));
        }
        setBackendError("");
      } catch (error) {
        if (!cancelled) setBackendError(error instanceof Error ? error.message : "Não foi possível consultar a fila.");
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pendingJobKey]);

  const filteredProjects = useMemo(
    () => projects.filter((project) => project.title.toLowerCase().includes(search.toLowerCase())),
    [projects, search],
  );
  const campaignCount = projects.filter((project) => project.status === "completed" || project.status === "preview").length;

  async function createProject(input: CreateProjectInput) {
    const uploaded = await uploadProductImage(input.image);
    const { image: _image, ...campaignInput } = input;
    const result = await createCampaign({ ...campaignInput, imageKey: uploaded.imageKey });
    const nextProject = result.project;
    setProjects((current) => [nextProject, ...current]);
    setNewProjectOpen(false);
    setView("projects");
    setSelectedProject(nextProject.id);
    setToast("Campanha enviada para a fila local. O roteiro será gerado em seguida.");
  }

  if (!authChecked) return <div className="auth-loading">Carregando sua conta…</div>;
  if (!authUser) return <AuthScreen onAuthenticated={setAuthUser} />;

  async function updateProject(updated: Project, message: string) {
    try {
      const saved = await persistProject(updated);
      setProjects((current) => current.map((project) => (project.id === saved.id ? saved : project)));
      setSelectedProject(saved.id);
      setToast(message);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Não foi possível salvar as alterações.");
    }
  }

  return (
    <main className="app-shell" data-theme={theme}>
      <aside className="sidebar">
        <a className="brand-lockup" href="#" onClick={() => setView("overview")}>
          <span className="brand-symbol"><Clapperboard size={19} strokeWidth={2.2} /></span>
          <span className="brand-word">vitrine<span>.</span></span>
        </a>
        <div className="workspace-switcher">
          <span className="workspace-avatar">M</span>
          <span className="workspace-copy"><strong>Minha loja</strong><small>Plano Starter</small></span>
          <ChevronDown size={15} />
        </div>
        <div className="nav-caption">WORKSPACE</div>
        <nav className="main-nav" aria-label="Navegação principal">
          <button className={view === "overview" ? "nav-item active" : "nav-item"} onClick={() => setView("overview")}>
            <LayoutDashboard size={17} /> Visão geral
          </button>
          <button className={view === "projects" ? "nav-item active" : "nav-item"} onClick={() => setView("projects")}>
            <Film size={17} /> Meus projetos <span className="nav-count">{projects.length}</span>
          </button>
          <button className={view === "brand" ? "nav-item active" : "nav-item"} onClick={() => setView("brand")}>
            <Palette size={17} /> Identidade da marca
          </button>
        </nav>
        <div className="nav-caption nav-caption-tools">PREFERÊNCIAS</div>
        <nav className="main-nav">
          <button className={view === "settings" ? "nav-item active" : "nav-item"} onClick={() => setView("settings")}>
            <Settings2 size={17} /> Configurações
          </button>
          <button className="nav-item" onClick={() => setToast("Central de ajuda disponível em breve.")}>
            <CircleHelp size={17} /> Central de ajuda
          </button>
        </nav>
        <div className="sidebar-spacer" />
        <div className="credit-card">
          <div className="credit-card-top"><span className="credit-icon"><Sparkles size={14} /></span><span>Seus créditos</span><button aria-label="Ver créditos" onClick={() => setView("settings")}><ArrowUpRight size={14} /></button></div>
          <div className="credit-balance">{credits.toFixed(1).replace(".", ",")} <small>créditos</small></div>
          <div className="credit-track"><span style={{ width: `${Math.min((credits / 50) * 100, 100)}%` }} /></div>
          <button className="credit-add" onClick={() => setToast("A recarga será habilitada quando o billing estiver conectado.")}>
            <Plus size={14} /> Adicionar créditos
          </button>
        </div>
        <button className="profile-button" onClick={() => setView("settings")}>
          <span className="profile-avatar">GC</span><span className="profile-name"><strong>Gilmar Costa</strong><small>Administrador</small></span><MoreHorizontal size={18} />
        </button>
      </aside>

      <section className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span className="crumb-slash">/</span><strong>{viewLabel(view)}</strong></div>
          <div className="topbar-actions">
            <span className="demo-badge"><span /> Modo demonstração</span>
            <button className="icon-button theme-toggle" aria-label={theme === "dark" ? "Ativar tema claro" : "Ativar tema escuro"} title={theme === "dark" ? "Ativar tema claro" : "Ativar tema escuro"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}</button>
            <button className="icon-button notification-button" aria-label="Notificações" onClick={() => setToast("Você está em dia! Nenhuma notificação nova.")}><Bell size={18} /><i /></button>
            <span className="topbar-divider" />
            <button className="help-link" onClick={() => setToast("Central de ajuda disponível em breve.")}>Precisa de ajuda? <ExternalLink size={13} /></button>
          </div>
        </header>

        {backendError && <div className="backend-error" role="alert"><ShieldCheck size={16} /><span>{backendError}</span></div>}

        {view === "overview" && (
          <div className="page-content">
            <div className="welcome-row">
              <div><div className="eyebrow"><span className="live-dot" /> QUARTA-FEIRA, 18 DE NOVEMBRO</div><h1>Bom dia, Gilmar <span className="wave">✦</span></h1><p>Vamos transformar seus produtos em vídeos que vendem?</p></div>
              <button className="button-primary" onClick={() => setNewProjectOpen(true)}><Plus size={17} /> Criar campanha</button>
            </div>
            <div className="metric-grid">
              <MetricCard icon={<Video size={17} />} label="Campanhas criadas" value={String(campaignCount).padStart(2, "0")} note="neste workspace" trend="+12%" positive />
              <MetricCard icon={<Clock3 size={17} />} label="Tempo economizado" value="8,4h" note="estimativa este mês" trend="+2,1h" positive />
              <MetricCard icon={<Sparkles size={17} />} label="Créditos disponíveis" value={credits.toFixed(1).replace(".", ",")} note="renovam em 01 dez" trend="Starter" />
              <MetricCard icon={<ArrowDownRight size={17} />} label="Taxa de conclusão" value="98,2%" note="últimos 30 dias" trend="+4,6%" positive />
            </div>
            <div className="content-grid">
              <section className="panel activity-panel">
                <div className="panel-heading"><div><h2>Atividade de criação</h2><p>Acompanhe a produção dos seus criativos</p></div><button className="select-button" onClick={() => setView("projects")}>Últimos 7 dias <ChevronDown size={14} /></button></div>
                <ActivityChart />
                <div className="chart-legend"><span><i className="legend-purple" /> Vídeos gerados</span><span><i className="legend-gray" /> Meta semanal</span><strong>12 vídeos <small>nesta semana</small></strong></div>
              </section>
              <section className="panel quick-panel">
                <div className="panel-heading"><div><h2>Comece por aqui</h2><p>Seu próximo criativo está a poucos cliques</p></div><span className="sparkle-soft"><WandSparkles size={18} /></span></div>
                <div className="quick-preview">
                  <div className="preview-glow" /><div className="mini-phone"><div className="mini-screen"><span className="mini-product">◉</span><span className="mini-copy">FEITO PARA<br />O SEU DIA</span><span className="mini-price">R$ 89,90</span><span className="mini-cta">COMPRE AGORA</span></div></div>
                  <div className="preview-tags"><span>9:16</span><span>Texto editável</span><span>PT-BR</span></div>
                </div>
                <button className="button-dark full-button" onClick={() => setNewProjectOpen(true)}>Criar minha primeira campanha <ArrowRight size={16} /></button>
              </section>
            </div>
            <section className="panel recent-panel">
              <div className="panel-heading"><div><h2>Projetos recentes</h2><p>Seus últimos vídeos e campanhas</p></div><button className="text-button" onClick={() => setView("projects")}>Ver todos <ArrowRight size={15} /></button></div>
              <ProjectRows projects={projects.slice(0, 3)} onSelect={setSelectedProject} />
            </section>
            <div className="trust-note"><ShieldCheck size={15} /> A foto original é mantida na prévia. O roteiro usa apenas os dados informados por você.</div>
          </div>
        )}

        {view === "projects" && (
          <div className="page-content">
            <div className="page-title-row"><div><div className="eyebrow">SEU CONTEÚDO, EM UM SÓ LUGAR</div><h1>Meus projetos</h1><p>Gerencie, edite e adapte seus vídeos para cada canal.</p></div><button className="button-primary" onClick={() => setNewProjectOpen(true)}><Plus size={17} /> Novo projeto</button></div>
            <div className="projects-toolbar"><div className="search-field"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar projetos..." /></div><button className="select-button" onClick={() => setToast("Exibindo todos os projetos.")}>Todos os projetos <ChevronDown size={14} /></button></div>
            <section className="panel project-list-panel"><ProjectRows projects={filteredProjects} onSelect={setSelectedProject} emptyText="Nenhum projeto encontrado. Tente outra busca ou crie um novo vídeo." /></section>
          </div>
        )}

        {view === "brand" && (
          <div className="page-content">
            <div className="page-title-row"><div><div className="eyebrow">CONSISTÊNCIA EM CADA CRIATIVO</div><h1>Identidade da marca</h1><p>Defina os elementos que serão aplicados aos seus vídeos.</p></div></div>
            <div className="brand-layout">
              <section className="panel brand-form">
                <div className="panel-heading"><div><h2>Brand kit principal</h2><p>Aplicado por padrão aos novos projetos</p></div><span className="default-chip"><Check size={12} /> PADRÃO</span></div>
                <label className="form-label">Nome da marca<input className="text-input" value={brand.name} onChange={(event) => setBrand({ ...brand, name: event.target.value })} /></label>
                <div className="color-fields"><label className="form-label">Cor principal<div className="color-input"><input type="color" value={brand.primary} onChange={(event) => setBrand({ ...brand, primary: event.target.value })} /><input value={brand.primary.toUpperCase()} onChange={(event) => /^#[0-9A-Fa-f]{0,6}$/.test(event.target.value) && setBrand({ ...brand, primary: event.target.value })} /></div></label><label className="form-label">Cor de apoio<div className="color-input"><input type="color" value={brand.secondary} onChange={(event) => setBrand({ ...brand, secondary: event.target.value })} /><input value={brand.secondary.toUpperCase()} onChange={(event) => /^#[0-9A-Fa-f]{0,6}$/.test(event.target.value) && setBrand({ ...brand, secondary: event.target.value })} /></div></label></div>
                <label className="form-label">Voz padrão<select className="text-input select-input" value={brand.voice} onChange={(event) => setBrand({ ...brand, voice: event.target.value })}><option>Feminina · Natural</option><option>Masculina · Confiante</option><option>Feminina · Energética</option><option>Masculina · Natural</option></select></label>
                <div className="logo-upload" onClick={() => setToast("O upload de logo será habilitado na integração com storage.")}><span className="logo-upload-icon"><ImagePlus size={19} /></span><span><strong>Logo da marca</strong><small>PNG transparente · até 5 MB</small></span><button className="button-outline">Adicionar logo</button></div>
                <div className="save-note"><CheckCircle2 size={15} /> Suas alterações são salvas automaticamente neste navegador.</div>
              </section>
              <section className="panel brand-preview-panel"><div className="panel-heading"><div><h2>Prévia da marca</h2><p>Assim seus elementos aparecem no vídeo</p></div><span className="ratio-tag">9:16</span></div><div className="brand-preview" style={{ background: `linear-gradient(145deg, ${brand.primary} 0%, #211b45 100%)` }}><div className="brand-preview-glow" /><span className="brand-preview-logo">{brand.name || "Sua marca"}</span><div className="brand-preview-product">◉</div><div className="brand-preview-copy">MAIS TEMPO<br />PARA VOCÊ</div><div className="brand-preview-pill" style={{ color: brand.primary }}>COMPRE AGORA <ArrowRight size={12} /></div><span className="brand-preview-caption">Legenda dinâmica palavra por palavra</span></div><div className="preview-caption"><span><span className="green-dot" /> Pré-visualização ilustrativa</span><button onClick={() => setNewProjectOpen(true)}>Testar em um vídeo <ArrowRight size={14} /></button></div></section>
            </div>
          </div>
        )}

        {view === "settings" && (
          <div className="page-content">
            <div className="page-title-row"><div><div className="eyebrow">CONTROLE DA SUA CONTA</div><h1>Configurações</h1><p>Plano, créditos e preferências do workspace.</p><small className="account-email">{authUser.email}</small></div><button className="button-outline" onClick={async () => { await logOut(); setAuthUser(null); }}>Sair da conta</button></div>
            <section className="panel settings-card"><div className="settings-card-icon"><Moon size={18} /></div><div className="settings-card-copy"><h2>Aparência</h2><p>Escolha o tema que prefere usar. A seleção fica salva neste navegador.</p></div><div className="theme-switch" role="group" aria-label="Tema da interface"><button className={theme === "light" ? "theme-choice selected" : "theme-choice"} aria-pressed={theme === "light"} onClick={() => setTheme("light")}><Sun size={14} /> Claro</button><button className={theme === "dark" ? "theme-choice selected" : "theme-choice"} aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}><Moon size={14} /> Escuro</button></div></section>
            <section className="panel settings-card"><div className="settings-card-icon"><Sparkles size={18} /></div><div className="settings-card-copy"><h2>Plano Starter</h2><p>Você tem <strong>{credits.toFixed(1).replace(".", ",")} créditos</strong> disponíveis. Seus créditos serão renovados em 01 de dezembro.</p></div><button className="button-outline" onClick={() => setToast("A gestão de plano será habilitada na integração de billing.")}>Gerenciar plano <ArrowUpRight size={14} /></button></section>
            <section className="panel settings-card"><div className="settings-card-icon settings-icon-muted"><ShieldCheck size={18} /></div><div className="settings-card-copy"><h2>Privacidade e dados</h2><p>Campanhas e imagens ficam nos serviços locais; tema e identidade da marca permanecem neste navegador.</p></div><button className="button-outline" onClick={() => { window.localStorage.removeItem("vitrine.brand"); window.localStorage.removeItem("vitrine.credits"); setBrand(defaultBrand); setCredits(28.5); setToast("Marca e créditos locais restaurados."); }}>Restaurar marca e créditos</button></section>
            <div className="demo-disclaimer"><CircleHelp size={17} /><div><strong>Sobre este ambiente</strong><p>Esta versão demonstra a experiência do produto. Processamento de IA, geração de arquivos MP4, autenticação, pagamentos e sincronização na nuvem ainda não estão conectados.</p></div></div>
          </div>
        )}

        <footer className="app-footer"><span>© 2026 Vitrine Commerce</span><span><span className="green-dot" /> Todos os sistemas operacionais</span><span>Feito para vender melhor <span className="footer-heart">✦</span></span></footer>
      </section>

      {newProjectOpen && <NewProjectModal onClose={() => setNewProjectOpen(false)} onCreate={createProject} brand={brand} />}
      {selected && <ProjectModal key={`${selected.id}:${selected.status}:${selected.version}`} project={selected} brand={brand} imageUrl={selectedImageUrl} onClose={() => setSelectedProject(null)} onSave={updateProject} onCopyMessage={setToast} />}
      {toast && <div className="toast"><CheckCircle2 size={17} />{toast}<button onClick={() => setToast("")} aria-label="Fechar"><X size={15} /></button></div>}
    </main>
  );
}

function viewLabel(view: View) {
  return { overview: "Visão geral", projects: "Meus projetos", brand: "Identidade da marca", settings: "Configurações" }[view];
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const resetToken = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("token") ?? "";
  const [mode, setMode] = useState<"login" | "signup" | "forgot" | "reset">(resetToken ? "reset" : "login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      if (mode === "forgot") {
        await requestPasswordReset(email);
        setMessage("Se o e-mail estiver cadastrado, as instruções foram registradas para envio.");
      } else if (mode === "reset") {
        await resetPassword(resetToken, password);
        setMessage("Senha redefinida com sucesso. Agora você já pode entrar.");
        setMode("login");
      } else {
        const user = mode === "login" ? await logIn(email, password) : await signUp(name, email, password);
        onAuthenticated(user);
      }
    } catch (submitError) { setError(submitError instanceof Error ? submitError.message : "Não foi possível concluir a operação."); }
    finally { setBusy(false); }
  }

  return <main className="auth-shell"><section className="auth-card">
    <div className="auth-brand"><span className="brand-symbol"><Clapperboard size={19} /></span><span className="brand-word">vitrine<span>.</span></span></div>
    <div className="modal-title"><div className="eyebrow">WORKSPACE SEGURO</div><h1>{mode === "login" ? "Bem-vindo de volta" : mode === "signup" ? "Crie sua conta" : mode === "reset" ? "Defina uma nova senha" : "Recupere sua senha"}</h1><p>{mode === "forgot" ? "Informe seu e-mail e enviaremos um link para redefinir sua senha." : mode === "reset" ? "Escolha uma senha nova para proteger sua conta." : "Acesse suas campanhas e mantenha seu trabalho sincronizado."}</p></div>
    <form className="auth-form" onSubmit={submit}>
      {mode === "signup" && <label className="form-label">Seu nome<input className="text-input" value={name} onChange={(event) => setName(event.target.value)} required minLength={2} maxLength={120} autoComplete="name" /></label>}
      <label className="form-label">E-mail<input className="text-input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" /></label>
      {mode !== "forgot" && <label className="form-label">Senha<input className="text-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} maxLength={72} autoComplete={mode === "login" ? "current-password" : "new-password"} /></label>}
      {error && <div className="form-error" role="alert">{error}</div>}{message && <div className="form-success" role="status">{message}</div>}
      <button className="button-primary auth-submit" disabled={busy}>{busy ? "Aguarde…" : mode === "login" ? "Entrar" : mode === "signup" ? "Criar conta" : mode === "reset" ? "Redefinir senha" : "Enviar instruções"}</button>
    </form>
    <div className="auth-links">{mode === "login" && <button className="button-text" onClick={() => setMode("forgot")}>Esqueci minha senha</button>}{mode !== "login" && <button className="button-text" onClick={() => setMode("login")}>Voltar para entrar</button>}{mode === "login" && <button className="button-text" onClick={() => setMode("signup")}>Criar uma conta</button>}{mode === "signup" && <button className="button-text" onClick={() => setMode("login")}>Já tenho uma conta</button>}</div>
  </section></main>;
}

function MetricCard({ icon, label, value, note, trend, positive = false }: { icon: React.ReactNode; label: string; value: string; note: string; trend: string; positive?: boolean }) {
  return <article className="metric-card"><div className="metric-card-top"><span className="metric-icon">{icon}</span><span className={positive ? "metric-trend positive" : "metric-trend"}>{positive && <ArrowUpRight size={12} />}{trend}</span></div><div className="metric-value">{value}</div><div className="metric-label">{label}</div><div className="metric-note">{note}</div></article>;
}

function ActivityChart() {
  return <div className="chart-wrap"><div className="chart-y-labels"><span>16</span><span>12</span><span>8</span><span>4</span><span>0</span></div><div className="chart-main"><div className="chart-grid"><i /><i /><i /><i /><i /></div><svg className="chart-svg" viewBox="0 0 640 174" preserveAspectRatio="none" aria-label="Gráfico de vídeos gerados na semana"><defs><linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#7967ec" stopOpacity=".18" /><stop offset="100%" stopColor="#7967ec" stopOpacity="0" /></linearGradient></defs><path d="M0 139 C42 131 55 124 90 129 S141 103 181 111 S228 113 272 88 S322 101 365 78 S413 82 456 61 S508 78 548 46 S600 48 640 24 L640 174 L0 174Z" fill="url(#chartFill)" /><path d="M0 139 C42 131 55 124 90 129 S141 103 181 111 S228 113 272 88 S322 101 365 78 S413 82 456 61 S508 78 548 46 S600 48 640 24" fill="none" stroke="#7663e8" strokeWidth="3" vectorEffect="non-scaling-stroke" strokeLinecap="round" /><circle cx="548" cy="46" r="5" fill="#fff" stroke="#7663e8" strokeWidth="3" vectorEffect="non-scaling-stroke" /></svg><div className="chart-x-labels"><span>Seg, 12</span><span>Ter, 13</span><span>Qua, 14</span><span>Qui, 15</span><span>Sex, 16</span><span>Sáb, 17</span><span>Dom, 18</span></div></div></div>;
}

function ProjectRows({ projects, onSelect, emptyText = "Seu primeiro vídeo começa com um produto. Crie um projeto para ver seus resultados aqui." }: { projects: Project[]; onSelect: (id: string) => void; emptyText?: string }) {
  if (!projects.length) return <div className="empty-state"><span><FileImage size={21} /></span><strong>Nenhum projeto por aqui</strong><p>{emptyText}</p></div>;
  return <div className="project-table"><div className="project-table-head"><span>PROJETO</span><span>FORMATO</span><span>CRIADO EM</span><span>STATUS</span><span /></div>{projects.map((project) => <button className="project-row" key={project.id} onClick={() => onSelect(project.id)}><span className="project-name-cell"><ProductTile product={project.product} compact /><span><strong>{project.title}</strong><small>{project.goal}</small></span></span><span><span className="ratio-tag">{project.ratio}</span></span><span className="date-cell">{project.createdAt}</span><span className="status-cell"><ProjectStatusPill status={project.status} />{project.status === "processing" && <span className="row-progress">{project.progress}%</span>}</span><span className="row-arrow"><ArrowRight size={16} /></span></button>)}</div>;
}

function NewProjectModal({
  onClose,
  onCreate,
  brand,
}: {
  onClose: () => void;
  onCreate: (project: CreateProjectInput) => Promise<void>;
  brand: BrandKit;
}) {
  const [step, setStep] = useState(1);
  const [product, setProduct] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState("");
  const [goal, setGoal] = useState<Goal>("Oferta relâmpago");
  const [platform, setPlatform] = useState<PlatformTarget>("TikTok");
  const [ratio, setRatio] = useState<Ratio>("9:16");
  const [price, setPrice] = useState("");
  const [originalPrice, setOriginalPrice] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => () => {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
  }, [imagePreview]);

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0];
    if (selectedFile) validateFile(selectedFile);
  }
  function validateFile(selectedFile: File) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(selectedFile.type)) {
      setError("Use uma imagem JPG, PNG ou WebP.");
      return;
    }
    if (selectedFile.size > 15 * 1024 * 1024) {
      setError("A imagem deve ter no máximo 15 MB.");
      return;
    }
    setError("");
    setFile(selectedFile);
    setImagePreview(URL.createObjectURL(selectedFile));
  }

  function parsePrice(value: string): number | undefined {
    if (!value.trim()) return undefined;
    if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(value.trim())) return NaN;
    return Number(value.replace(/\./g, "").replace(",", "."));
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped) validateFile(dropped);
  }
  async function submit() {
    if (!product.trim()) {
      setError("Dê um nome ao produto para continuar.");
      setStep(1);
      return;
    }
    if (!file) {
      setError("Adicione uma foto do produto para continuar.");
      setStep(1);
      return;
    }
    const parsedPrice = parsePrice(price);
    const parsedOriginalPrice = parsePrice(originalPrice);
    if (Number.isNaN(parsedPrice) || Number.isNaN(parsedOriginalPrice)) {
      setError("Informe os preços no formato 89,90.");
      return;
    }
    if (parsedPrice !== undefined && parsedPrice <= 0) {
      setError("O preço promocional deve ser maior que zero.");
      return;
    }
    if (parsedOriginalPrice !== undefined && parsedOriginalPrice <= 0) {
      setError("O preço original deve ser maior que zero.");
      return;
    }
    if (parsedPrice !== undefined && parsedOriginalPrice !== undefined && parsedPrice >= parsedOriginalPrice) {
      setError("O preço promocional deve ser menor que o preço original.");
      return;
    }
    if (!file) {
      setError("Adicione uma foto do produto para continuar.");
      setStep(1);
      return;
    }

    setIsSubmitting(true);
    setError("");
    try {
      await onCreate({
        product: product.trim(),
        goal,
        platform,
        ratio,
        price: price.trim() || undefined,
        originalPrice: originalPrice.trim() || undefined,
        image: file,
      });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Não foi possível criar a prévia da campanha.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal wizard-modal" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
      <div className="modal-top"><span className="modal-kicker"><Sparkles size={14} /> NOVA CAMPANHA</span><button className="icon-button" onClick={onClose} aria-label="Fechar"><X size={19} /></button></div>
      <div className="wizard-progress"><span className={step >= 1 ? "step-active" : ""} /><span className={step >= 2 ? "step-active" : ""} /><span className={step >= 3 ? "step-active" : ""} /><small>ETAPA {step} DE 3</small></div>
      {step === 1 && (
        <>
          <div className="modal-title"><h2 id="wizard-title">Sobre qual produto vamos falar?</h2><p>Uma foto e o nome do produto já são suficientes para começar.</p></div>
          <div className="wizard-body">
            <label className="form-label">Nome do produto<input className="text-input" value={product} onChange={(event) => setProduct(event.target.value)} placeholder="Ex.: Garrafa térmica Flow" autoFocus maxLength={120} /></label>
            <label className={`drop-zone${dragging ? " drop-zone-active" : ""}${imagePreview ? " has-image" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={handleDrop}>
              {imagePreview ? <><img src={imagePreview} alt="Prévia do produto enviado" /><span className="drop-overlay"><Upload size={15} /> Trocar imagem</span></> : <><span className="drop-icon"><ImagePlus size={20} /></span><strong>Arraste uma foto ou <em>escolha um arquivo</em></strong><small>JPG, PNG ou WebP · até 15 MB</small></>}
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseFile} />
            </label>
            <div className="secure-upload"><ShieldCheck size={14} /> A imagem será armazenada no serviço local para sua prévia.</div>
          </div>
        </>
      )}
      {step === 2 && (
        <>
          <div className="modal-title"><h2 id="wizard-title">Onde você quer divulgar?</h2><p>Escolha o objetivo e o canal. Você pode ajustar os textos antes de publicar.</p></div>
          <div className="wizard-body">
            <div className="form-label">Canal de destino<div className="platform-options">{(["TikTok", "Instagram Reels", "Shopee Video"] as PlatformTarget[]).map((option) => <button key={option} className={platform === option ? "platform-option selected" : "platform-option"} onClick={() => setPlatform(option)}>{option}{platform === option && <Check size={13} />}</button>)}</div></div>
            <div className="form-label">Objetivo da campanha<div className="goal-grid">{goals.map((option, index) => <button key={option} className={`goal-option${goal === option ? " goal-selected" : ""}`} onClick={() => setGoal(option)}><span className="goal-icon">{[<Sparkles key="s" />, <ArrowUpRight key="a" />, <ArrowDown key="d" />, <CheckCircle2 key="c" />][index]}</span><strong>{option}</strong><small>{["Destaque a oferta informada", "Apresente o produto", "Mostre os detalhes", "Facilite a descoberta"][index]}</small>{goal === option && <span className="goal-check"><Check size={12} /></span>}</button>)}</div></div>
            <div className="field-row"><label className="form-label">Preço de venda <span className="optional">opcional</span><div className="price-input"><span>R$</span><input value={price} onChange={(event) => setPrice(event.target.value)} placeholder="89,90" inputMode="decimal" /></div></label><label className="form-label">Preço original <span className="optional">opcional</span><div className="price-input"><span>R$</span><input value={originalPrice} onChange={(event) => setOriginalPrice(event.target.value)} placeholder="129,90" inputMode="decimal" /></div></label></div>
            <div className="form-label">Formato<div className="ratio-options">{ratios.map((option) => <button key={option} className={ratio === option ? "ratio-option ratio-option-active" : "ratio-option"} onClick={() => setRatio(option)}><span className={`ratio-shape shape-${option.replace(":", "-")}`} />{option}</button>)}</div></div>
          </div>
        </>
      )}
      {step === 3 && (
        <>
          <div className="modal-title"><h2 id="wizard-title">Sua campanha está pronta para revisar</h2><p>Vamos criar um roteiro e uma legenda demonstrativos para você editar.</p></div>
          <div className="wizard-body review-card"><div className="review-product">{imagePreview ? <img src={imagePreview} alt="" /> : <ProductTile product={product} />}</div><div className="review-details"><strong>{product}</strong><span>{platform} · {goal} · {ratio}</span><span>{price ? `R$ ${price}` : "Sem preço informado"}{originalPrice ? ` · De R$ ${originalPrice}` : ""}</span><span className="brand-applied"><span style={{ background: brand.primary }} /> Identidade: {brand.name}</span></div></div>
          <div className="compliance-note"><ShieldCheck size={16} /><span><strong>Texto editável, sem atributos inventados.</strong> O roteiro só usa os dados informados por você.</span></div>
          <div className="demo-inline-note">Prévia demonstrativa: não consome créditos e não gera arquivo MP4.</div>
        </>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-footer">
        {step > 1 ? <button className="button-text" disabled={isSubmitting} onClick={() => { setError(""); setStep(step - 1); }}><ArrowLeft size={15} /> Voltar</button> : <span className="credit-hint"><Sparkles size={13} /> Sem custo nesta demonstração</span>}
        {step < 3
          ? <button className="button-primary" onClick={() => {
            setError("");
            if (step === 1 && (!product.trim() || !file)) { setError(!product.trim() ? "Informe o nome do produto para continuar." : "Adicione uma foto do produto para continuar."); return; }
            setStep(step + 1);
          }}>Continuar <ArrowRight size={15} /></button>
          : <button className="button-primary" disabled={isSubmitting} onClick={submit}>{isSubmitting ? <><span className="button-spinner" /> Preparando prévia...</> : <><WandSparkles size={16} /> Criar campanha</>}</button>}
      </div>
      </section>
    </div>
  );
}

function ProjectModal({
  project,
  brand,
  imageUrl,
  onClose,
  onSave,
  onCopyMessage,
}: {
  project: Project;
  brand: BrandKit;
  imageUrl: string;
  onClose: () => void;
  onSave: (project: Project, message: string) => void;
  onCopyMessage: (message: string) => void;
}) {
  const [price, setPrice] = useState(project.price);
  const [headline, setHeadline] = useState(project.campaign.hook);
  const [benefit, setBenefit] = useState(project.campaign.benefit);
  const [offer, setOffer] = useState(project.campaign.offer);
  const [cta, setCta] = useState(project.campaign.cta);
  const [caption, setCaption] = useState(project.campaign.caption);
  const [offerCustomized, setOfferCustomized] = useState(false);
  const [captionCustomized, setCaptionCustomized] = useState(false);
  const [ratio, setRatio] = useState<Ratio>(project.ratio);
  const [background, setBackground] = useState(project.background);
  const [isSaving, setIsSaving] = useState(false);

  function makeCaption(nextBenefit: string, nextOffer: string, nextCta: string) {
    return `${project.product}\n${nextBenefit}\n${nextOffer}\n${nextCta}.\n#novidade #comprasonline`;
  }

  function updatePrice(value: string) {
    setPrice(value);
    if (offerCustomized) return;
    const nextOffer = createOfferText(project.product, value.trim() || undefined, project.originalPrice);
    setOffer(nextOffer);
    if (!captionCustomized) setCaption(makeCaption(benefit, nextOffer, cta));
  }

  function updateBenefit(value: string) {
    setBenefit(value);
    if (!captionCustomized) setCaption(makeCaption(value, offer, cta));
  }

  function updateOffer(value: string) {
    setOffer(value);
    setOfferCustomized(true);
    if (!captionCustomized) setCaption(makeCaption(benefit, value, cta));
  }

  function updateCta(value: string) {
    setCta(value);
    if (!captionCustomized) setCaption(makeCaption(benefit, offer, value));
  }

  async function save() {
    if (!headline.trim() || !benefit.trim() || !offer.trim() || !cta.trim() || !caption.trim()) {
      onCopyMessage("Preencha o gancho, benefício, oferta, CTA e legenda antes de salvar.");
      return;
    }
    const campaign: MarketingCampaign = {
      ...project.campaign,
      hook: headline.trim(),
      benefit: benefit.trim(),
      offer: offer.trim(),
      cta: cta.trim(),
      caption: caption.trim(),
      scenes: [
        { label: "GANCHO · 0–3s", text: headline.trim() },
        { label: "APRESENTAÇÃO · 3–12s", text: benefit.trim() },
        { label: "OFERTA · 12–18s", text: `${offer.trim()} ${cta.trim()}` },
      ],
    };
    setIsSaving(true);
    try {
      await onSave({
        ...project,
        price: price.trim(),
        headline: headline.trim(),
        campaign,
        ratio,
        background,
        version: project.version,
      }, "Textos e prévia atualizados.");
    } finally {
      setIsSaving(false);
    }
  }

  async function copyCampaign() {
    const text = `${headline}\n\n${benefit}\n\n${offer}\n${cta}\n\nLegenda:\n${caption}`;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("A cópia automática não está disponível neste navegador.");
      await navigator.clipboard.writeText(text);
      onCopyMessage("Roteiro e legenda copiados.");
    } catch (error) {
      onCopyMessage(error instanceof Error ? error.message : "Não foi possível copiar o conteúdo.");
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal project-modal" role="dialog" aria-modal="true" aria-labelledby="project-title">
        <div className="project-modal-header">
          <div>
            <button className="back-link" onClick={onClose}><ArrowLeft size={14} /> Voltar aos projetos</button>
            <h2 id="project-title">{project.title}</h2>
            <span className="project-modal-subtitle">{project.platform} <span>·</span> {project.goal} <span>·</span> v{project.version} <span>·</span> <ProjectStatusPill status={project.status} /></span>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Fechar"><X size={19} /></button>
        </div>
        <div className="project-editor">
          <div className="video-preview-wrap">
            <div className={`video-preview ratio-preview-${ratio.replace(":", "-")}`} style={{ background: background === 1 ? "linear-gradient(145deg,#d4e5e3,#839e9a 48%,#293b39)" : background === 2 ? "linear-gradient(145deg,#f5c5b9,#df8b80 52%,#824f57)" : "linear-gradient(145deg,#dbd7ff,#9889da 50%,#4c427e)" }}>
              <div className="video-noise" />
              <span className="video-brand">{brand.name || "Minha marca"}</span>
              {imageUrl ? <img className="video-preview-product-image" src={imageUrl} alt={`Produto ${project.product}`} /> : <span className="video-preview-product">◉</span>}
              <span className="video-headline">{headline || project.headline}</span>
              {price && <span className="video-price">R$ {price}</span>}
              <span className="video-cta">{cta} <ArrowRight size={11} /></span>
              <span className="video-caption">{caption.split("\n")[0]}</span>
              <span className="video-play"><span /></span>
            </div>
            <div className="preview-toolbar"><span><span className="green-dot" /> Prévia de campanha</span><span>{ratio} · 18s · demonstração</span></div>
          </div>
          <div className="editor-controls">
            <div className="editor-section-head"><span className="editor-section-icon"><Settings2 size={15} /></span><div><strong>Edite sua campanha</strong><small>Alterações salvas no workspace local</small></div></div>
            {(project.status === "queued" || project.status === "processing") && <div className="form-error" role="status">A campanha está na fila local. Os textos ficam disponíveis quando o processamento terminar.</div>}
            {project.status === "failed" && <div className="form-error" role="alert">{project.errorMessage || "O processamento falhou. Consulte os logs do worker para mais detalhes."}</div>}
            <label className="form-label">Gancho principal<input className="text-input" value={headline} onChange={(event) => setHeadline(event.target.value)} maxLength={80} /><span className="char-count">{headline.length}/80</span></label>
            <label className="form-label">Benefício ou apresentação<textarea className="text-input campaign-textarea" value={benefit} onChange={(event) => updateBenefit(event.target.value)} maxLength={280} /></label>
            <label className="form-label">Oferta<textarea className="text-input campaign-textarea campaign-textarea-short" value={offer} onChange={(event) => updateOffer(event.target.value)} maxLength={180} /></label>
            <label className="form-label">Chamada para ação<input className="text-input" value={cta} onChange={(event) => updateCta(event.target.value)} maxLength={60} /></label>
            <label className="form-label">Preço promocional <span className="optional">opcional</span><div className="price-input"><span>R$</span><input value={price} onChange={(event) => updatePrice(event.target.value)} placeholder="89,90" /></div></label>
            <label className="form-label">Legenda<textarea className="text-input campaign-textarea caption-textarea" value={caption} onChange={(event) => { setCaption(event.target.value); setCaptionCustomized(true); }} maxLength={1000} /></label>
            <div className="form-label">Cenário<div className="scene-options">{["Estúdio lilás", "Lifestyle natural", "Coral suave"].map((scene, index) => <button key={scene} className={`scene-choice${background === index ? " scene-selected" : ""}`} onClick={() => setBackground(index)}><span className={`scene-swatch scene-${index}`} />{scene}{background === index && <Check size={13} />}</button>)}</div></div>
            <div className="form-label">Formato<div className="ratio-options editor-ratios">{ratios.map((option) => <button key={option} className={ratio === option ? "ratio-option ratio-option-active" : "ratio-option"} onClick={() => setRatio(option)}><span className={`ratio-shape shape-${option.replace(":", "-")}`} />{option}</button>)}</div></div>
            <div className="campaign-scenes">
              <div className="campaign-scenes-heading"><strong>Roteiro sugerido</strong><span>DEMONSTRAÇÃO</span></div>
              <div className="campaign-scenes-list">{[
                { label: "GANCHO · 0–3s", text: headline },
                { label: "APRESENTAÇÃO · 3–12s", text: benefit },
                { label: "OFERTA · 12–18s", text: `${offer} ${cta}` },
              ].map((scene) => <div className="campaign-scene" key={scene.label}><small>{scene.label}</small><span>{scene.text}</span></div>)}</div>
              <div className="campaign-note">Revise preços e informações antes de publicar. Nenhum recurso foi renderizado como vídeo.</div>
            </div>
            <div className="editor-note"><Sparkles size={14} /><span>Edição da prévia demonstrativa sem custo.</span></div>
            <button className="button-primary full-button" onClick={save} disabled={isSaving || project.status === "queued" || project.status === "processing" || project.status === "failed"}>{isSaving ? <><span className="button-spinner" /> Salvando...</> : <><Check size={16} /> Salvar alterações</>}</button>
            <button className="copy-campaign-button" onClick={copyCampaign}><Copy size={14} /> Copiar roteiro e legenda</button>
            <button className="download-button" disabled><Download size={15} /> Exportar MP4 <span>indisponível na demonstração</span></button>
          </div>
        </div>
        <div className="project-modal-foot"><span><Clock3 size={13} /> Criado {project.createdAt}</span><span>Conteúdo para {project.platform}</span></div>
      </section>
    </div>
  );
}
