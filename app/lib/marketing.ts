export type CampaignGoal =
  | "Oferta relâmpago"
  | "Lançamento"
  | "Dor e solução"
  | "Prova social";

export type PlatformTarget = "TikTok" | "Instagram Reels" | "Shopee Video";

export type CampaignScene = {
  label: string;
  text: string;
};

export type MarketingCampaign = {
  hook: string;
  benefit: string;
  offer: string;
  cta: string;
  caption: string;
  scenes: CampaignScene[];
  provider: "demo";
  generatedAt: string;
};

export type MarketingInput = {
  product: string;
  goal: CampaignGoal;
  platform: PlatformTarget;
  price?: string;
  originalPrice?: string;
};

export interface MarketingContentProvider {
  generate(input: MarketingInput): Promise<MarketingCampaign>;
}

export function createOfferText(product: string, price?: string, originalPrice?: string): string {
  if (!price) return `Saiba mais sobre ${product}.`;
  if (originalPrice) return `Confira por R$ ${price} (antes R$ ${originalPrice}).`;
  return `Confira por R$ ${price}.`;
}

export function generateDemoCampaign(input: MarketingInput): MarketingCampaign {
  const product = input.product.trim();
  const hook = `Conheça ${product}`;
  const benefit = `Veja os detalhes de ${product} e descubra se combina com o que você procura.`;
  const offer = createOfferText(product, input.price, input.originalPrice);
  const ctaByGoal: Record<CampaignGoal, string> = {
    "Oferta relâmpago": "Confira a oferta",
    Lançamento: "Conheça a novidade",
    "Dor e solução": "Descubra mais",
    "Prova social": "Veja os detalhes",
  };
  const cta = ctaByGoal[input.goal];
  const caption = `${product}\n${benefit}\n${offer}\n${cta}.\n#novidade #comprasonline`;

  return {
    hook,
    benefit,
    offer,
    cta,
    caption,
    scenes: [
      { label: "GANCHO · 0–3s", text: hook },
      { label: "APRESENTAÇÃO · 3–12s", text: benefit },
      { label: "OFERTA · 12–18s", text: `${offer} ${cta}.` },
    ],
    provider: "demo",
    generatedAt: new Date().toISOString(),
  };
}

export class DemoMarketingProvider implements MarketingContentProvider {
  async generate(input: MarketingInput): Promise<MarketingCampaign> {
    return generateDemoCampaign(input);
  }
}
