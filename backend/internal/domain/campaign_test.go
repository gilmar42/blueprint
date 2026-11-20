package domain

import "testing"

func TestGenerateCampaignUsesProvidedOfferAndGoal(t *testing.T) {
	campaign := GenerateCampaign(Input{
		Product:       "Garrafa Flow",
		Goal:          "Oferta relâmpago",
		Platform:      "TikTok",
		Price:         "89,90",
		OriginalPrice: "129,90",
	})

	if campaign.Hook != "Conheça Garrafa Flow" {
		t.Fatalf("unexpected hook: %q", campaign.Hook)
	}
	if campaign.Offer != "Confira por R$ 89,90 (antes R$ 129,90)." {
		t.Fatalf("unexpected offer: %q", campaign.Offer)
	}
	if campaign.CTA != "Confira a oferta" {
		t.Fatalf("unexpected CTA: %q", campaign.CTA)
	}
	if campaign.Provider != "demo" || len(campaign.Scenes) != 3 {
		t.Fatalf("unexpected demo campaign metadata: %#v", campaign)
	}
}

func TestGenerateCampaignWithoutPriceDoesNotInventOffer(t *testing.T) {
	campaign := GenerateCampaign(Input{Product: "Produto", Goal: "Lançamento"})

	if campaign.Offer != "Saiba mais sobre Produto." {
		t.Fatalf("unexpected offer: %q", campaign.Offer)
	}
	if campaign.Caption == "" {
		t.Fatal("expected a campaign caption")
	}
}
