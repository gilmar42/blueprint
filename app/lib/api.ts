import type { CampaignGoal, MarketingCampaign, MarketingInput, PlatformTarget } from "./marketing";

export type ProjectStatus = "completed" | "processing" | "queued" | "preview" | "failed";
export type VideoRatio = "9:16" | "1:1" | "4:5" | "16:9";

export type Project = {
  id: string;
  title: string;
  product: string;
  goal: CampaignGoal;
  platform: PlatformTarget;
  ratio: VideoRatio;
  price: string;
  originalPrice?: string;
  headline: string;
  campaign: MarketingCampaign;
  imageKey?: string;
  imageKeys?: string[];
  imageUrl?: string;
  modelUrl?: string;
  videoUrl?: string;
  status: ProjectStatus;
  progress: number;
  errorMessage?: string;
  createdAt: string;
  version: number;
  background: number;
  jobId?: string;
};

export type Job = {
  id: string;
  projectId: string;
  status: "queued" | "processing" | "completed" | "failed";
  progress: number;
  error?: string;
};

export type AuthUser = { id: string; name: string; email: string };

export type LegacyProjectInput = Omit<Project, "imageUrl" | "jobId"> & {
  legacyId: string;
};

export type CreateCampaignInput = MarketingInput & {
  ratio: VideoRatio;
  imageKeys: string[];
  textNotes?: string;
};

export async function getCurrentUser(): Promise<AuthUser> {
  const result = await request<{ user: AuthUser }>("/api/v1/auth/me");
  return result.user;
}

export async function signUp(name: string, email: string, password: string): Promise<AuthUser> {
  const result = await request<{ user: AuthUser }>("/api/v1/auth/signup", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email, password }),
  });
  return result.user;
}

export async function logIn(email: string, password: string): Promise<AuthUser> {
  const result = await request<{ user: AuthUser }>("/api/v1/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  return result.user;
}

export async function logOut(): Promise<void> {
  await request<void>("/api/v1/auth/logout", { method: "POST" });
}

export async function requestPasswordReset(email: string): Promise<void> {
  await request("/api/v1/auth/forgot-password", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
  });
}

export async function resetPassword(token: string, password: string): Promise<void> {
  await request("/api/v1/auth/reset-password", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password }),
  });
}

type APIErrorBody = { error?: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store", ...init });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("Não foi possível conectar à API. Verifique se o serviço local está ativo na porta 8080.");
    }
    throw error;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.ok) throw new Error("A API local retornou uma resposta inválida.");
    body = null;
  }
  if (!response.ok) {
    const message = isAPIErrorBody(body) && body.error ? body.error : `A API respondeu com erro (${response.status}).`;
    throw new Error(message);
  }
  return body as T;
}

function isAPIErrorBody(value: unknown): value is APIErrorBody {
  return typeof value === "object" && value !== null &&
    (!("error" in value) || typeof value.error === "string");
}

function displayDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(parsed);
}

function presentProject(project: Project): Project {
  return { ...project, createdAt: displayDate(project.createdAt) };
}

export async function uploadProductImage(file: File): Promise<{ imageKey: string; imageUrl: string }> {
  const form = new FormData();
  form.append("image", file);
  return request("/api/v1/uploads", { method: "POST", body: form });
}

export async function createCampaign(input: CreateCampaignInput): Promise<{ project: Project; jobId: string }> {
  const result = await request<{ project: Project; jobId: string }>("/api/v1/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return { ...result, project: presentProject(result.project) };
}

export async function listProjects(): Promise<Project[]> {
  const result = await request<{ projects: Project[] }>("/api/v1/projects");
  return result.projects.map(presentProject);
}

export async function getJob(id: string): Promise<Job> {
  const result = await request<{ job: Job }>(`/api/v1/jobs/${encodeURIComponent(id)}`);
  return result.job;
}

export async function updateProject(project: Project): Promise<Project> {
  const result = await request<{ project: Project }>(`/api/v1/projects/${encodeURIComponent(project.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      price: project.price,
      ratio: project.ratio,
      headline: project.headline,
      campaign: project.campaign,
      background: project.background,
      version: project.version,
    }),
  });
  return presentProject(result.project);
}

export async function importLegacyProject(project: LegacyProjectInput): Promise<Project> {
  const {
    legacyId, title, product, goal, platform, ratio, price, originalPrice,
    headline, campaign, imageKey, version, background, createdAt,
  } = project;
  const result = await request<{ project: Project }>("/api/v1/projects/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      legacyId, title, product, goal, platform, ratio, price, originalPrice,
      headline, campaign, imageKey, version, background, createdAt,
    }),
  });
  return presentProject(result.project);
}
