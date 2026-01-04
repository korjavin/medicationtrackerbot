package rxnorm

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	httpClient *http.Client
}

func New() *Client {
	return &Client{
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// SearchRxNorm searches for a medication by name and returns the RxCUI and normalized name.
// It returns empty strings if not found or if the API fails, behaving gracefully.
func (c *Client) SearchRxNorm(name string) (string, string, error) {
	// 1. Get RxCUI (Exact Match)
	// URL: https://rxnav.nlm.nih.gov/REST/rxcui.json?name=...
	searchURL := fmt.Sprintf("https://rxnav.nlm.nih.gov/REST/rxcui.json?name=%s", url.QueryEscape(name))
	resp, err := c.httpClient.Get(searchURL)
	if err != nil {
		return "", "", fmt.Errorf("failed to search rxnorm: %w", err)
	}
	defer resp.Body.Close()

	var searchResp struct {
		IdGroup struct {
			RxNormId []string `json:"rxnormId"`
		} `json:"idGroup"`
	}

	rxcui := ""
	if err := json.NewDecoder(resp.Body).Decode(&searchResp); err == nil && len(searchResp.IdGroup.RxNormId) > 0 {
		rxcui = searchResp.IdGroup.RxNormId[0]
	}

	// 1b. Fallback to Approximate Match if exact failed
	if rxcui == "" {
		rxcui = c.searchApproximate(name)
	}

	if rxcui == "" {
		return "", "", nil // Not found
	}

	// 2. Get Properties (Normalized Name)
	// URL: https://rxnav.nlm.nih.gov/REST/rxcui/{rxcui}/properties.json
	propURL := fmt.Sprintf("https://rxnav.nlm.nih.gov/REST/rxcui/%s/properties.json", rxcui)
	respProp, err := c.httpClient.Get(propURL)
	if err != nil {
		// If we got ID but failed to get name, just return ID
		return rxcui, "", nil
	}
	defer respProp.Body.Close()

	var propResp struct {
		Properties struct {
			Name string `json:"name"`
		} `json:"properties"`
	}
	if err := json.NewDecoder(respProp.Body).Decode(&propResp); err == nil {
		return rxcui, propResp.Properties.Name, nil
	}

	return rxcui, "", nil
}

func (c *Client) searchApproximate(term string) string {
	// URL: https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=...&maxEntries=1
	searchURL := fmt.Sprintf("https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=%s&maxEntries=1", url.QueryEscape(term))
	resp, err := c.httpClient.Get(searchURL)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return ""
	}

	var approxResp struct {
		ApproximateGroup struct {
			Candidate []struct {
				Rxcui string `json:"rxcui"`
				Score string `json:"score"` // Score is string in JSON? often int, checking docs... it's usually string "66"
			} `json:"candidate"`
		} `json:"approximateGroup"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&approxResp); err == nil && len(approxResp.ApproximateGroup.Candidate) > 0 {
		return approxResp.ApproximateGroup.Candidate[0].Rxcui
	}
	return ""
}

// CheckInteractions checks for drug-drug interactions between a list of RxCUIs.
// Returns a list of warning messages.
func (c *Client) CheckInteractions(rxcuis []string) ([]string, error) {
	if len(rxcuis) < 2 {
		return nil, nil
	}

	// URL: https://lhncbc.nlm.nih.gov/RxNav/APIs/api/interaction/list.json?rxcuis=...
	ids := strings.Join(rxcuis, "+")
	checkURL := fmt.Sprintf("https://lhncbc.nlm.nih.gov/RxNav/APIs/api/interaction/list.json?rxcuis=%s", ids)

	resp, err := c.httpClient.Get(checkURL)
	if err != nil {
		return nil, fmt.Errorf("failed to check interactions: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("interaction api returned status: %d", resp.StatusCode)
	}

	var interactionResp struct {
		FullInteractionTypeGroup []struct {
			FullInteractionType []struct {
				InteractionPair []struct {
					InteractionConcept []struct {
						MinConceptItem struct {
							Name  string `json:"name"`
							Rxcui string `json:"rxcui"`
						} `json:"minConceptItem"`
					} `json:"interactionConcept"`
					Description string `json:"description"`
				} `json:"interactionPair"`
			} `json:"fullInteractionType"`
		} `json:"fullInteractionTypeGroup"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&interactionResp); err != nil {
		return nil, fmt.Errorf("failed to decode interaction response: %w", err)
	}

	var warnings []string
	seen := make(map[string]bool)

	for _, group := range interactionResp.FullInteractionTypeGroup {
		for _, fit := range group.FullInteractionType {
			for _, pair := range fit.InteractionPair {
				if len(pair.InteractionConcept) >= 2 {
					m1 := pair.InteractionConcept[0].MinConceptItem.Name
					m2 := pair.InteractionConcept[1].MinConceptItem.Name
					desc := pair.Description

					// De-duplicate because API might return same pair twice
					key := fmt.Sprintf("%s-%s", m1, m2)
					if seen[key] {
						continue
					}
					seen[key] = true

					warnings = append(warnings, fmt.Sprintf("Interaction between %s and %s: %s", m1, m2, desc))
				}
			}
		}
	}

	return warnings, nil
}
