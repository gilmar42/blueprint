package domain

import (
	"fmt"
	"strings"
	"time"
)

type Input struct {
	Product       string `json:"product"`
	Goal          string `json:"goal"`
	Platform      string `json:"platform"`
	Ratio         string `json:"ratio"`
	Price         string `json:"price,omitempty"`
	OriginalPrice string `json:"originalPrice,omitempty"`
}

type Scene struct {
	Label string `json:"label"`
	Text  string `json:"text"`
}

type Campaign struct {
	Hook        string    `json:"hook"`
	Benefit     string    `json:"benefit"`
	Offer       string    `json:"offer"`
	CTA         string    `json:"cta"`
	Caption     string    `json:"caption"`
	Scenes      []Scene   `json:"scenes"`
	Provider    string    `json:"provider"`
	GeneratedAt time.Time `json:"generatedAt"`
}

func GenerateCampaign(input Input) Campaign {
	product := strings.TrimSpace(input.Product)
	hook := "Conheça " + product
	benefit := fmt.Sprintf("Veja os detalhes de %s e descubra se combina com o que você procura.", product)
	offer := "Saiba mais sobre " + product + "."
	if input.Price != "" {
		offer = "Confira por R$ " + input.Price + "."
		if input.OriginalPrice != "" {
			offer = fmt.Sprintf("Confira por R$ %s (antes R$ %s).", input.Price, input.OriginalPrice)
		}
	}
	ctaByGoal := map[string]string{
		"Oferta relâmpago": "Confira a oferta",
		"Lançamento":       "Conheça a novidade",
		"Dor e solução":    "Descubra mais",
		"Prova social":     "Veja os detalhes",
	}
	cta := ctaByGoal[input.Goal]
	caption := fmt.Sprintf("%s\n%s\n%s\n%s.\n#novidade #comprasonline", product, benefit, offer, cta)

	return Campaign{
		Hook:    hook,
		Benefit: benefit,
		Offer:   offer,
		CTA:     cta,
		Caption: caption,
		Scenes: []Scene{
			{Label: "GANCHO · 0–3s", Text: hook},
			{Label: "APRESENTAÇÃO · 3–12s", Text: benefit},
			{Label: "OFERTA · 12–18s", Text: offer + " " + cta + "."},
		},
		Provider:    "demo",
		GeneratedAt: time.Now().UTC(),
	}
}
