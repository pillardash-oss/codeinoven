package main

// The demo assistants, copied from the desktop's own assistants table: the same
// names, accent colours and stored custom icons, so the phone draws the real
// marks instead of placeholder glyphs. The SVGs are the user-authored drawings,
// kept verbatim.

type seedAssistant struct {
	name        string
	description string
	schedule    string
	color       string
	customSVG   string
	scheduled   bool
	paused      bool
	threads     int
}

// seedAssistants returns the assistants the phone lists, in the order the
// desktop keeps them.
func seedAssistants() []seedAssistant {
	return []seedAssistant{
		{
			name:        "Pildash",
			description: "Watches the product and reports what changed.",
			schedule:    "Product watch",
			color:       "#ffffff",
			customSVG:   "<svg width=\"16\" height=\"16\" viewBox=\"0 0 2060 2060\" xmlns=\"http://www.w3.org/2000/svg\" fill-rule=\"evenodd\"><g transform=\"matrix(1,0,0,1,-18312.8,0)\"><g transform=\"matrix(1.07278,0,0,1.07278,18312.8,0)\"><rect x=\"0\" y=\"0\" width=\"1920\" height=\"1920\" fill=\"none\"/><g transform=\"matrix(9.82712,-1.94045e-17,1.45534e-17,9.82712,-262486,-29870)\"><g transform=\"matrix(-4.52112e-16,-1.28321,0.908395,1.06654e-15,25147.4,37406.9)\"><path d=\"M26724.9,1771.62L26730.6,1792.55L26649.1,1792.55L26649.1,1771.62L26724.9,1771.62Z\" fill=\"currentColor\"/></g><g transform=\"matrix(-5.0686e-16,-1.42621,0.908395,1.22415e-15,25176.3,41217.8)\"><path d=\"M26724.9,1771.62L26730.6,1792.55L26649.1,1792.55L26649.1,1771.62L26724.9,1771.62Z\" fill=\"currentColor\"/></g><g><path d=\"M26780.7,3071.18C26788.8,3065.55 26797.5,3063.84 26808.1,3063.84C26836.4,3063.84 26859.4,3087.55 26859.4,3116.75C26859.4,3142.9 26840.9,3164.64 26816.7,3168.9L26816.7,3168.9L26816.7,3149.6C26826.6,3145.9 26833.7,3140.1 26839,3129.95C26841.1,3125.86 26842.2,3111.92 26839,3103.28C26834.3,3090.93 26816.9,3082.32 26808.1,3082.32C26806.1,3082.32 26802.4,3082.11 26798.6,3082.62C26795.4,3083.04 26792.1,3085.22 26790.7,3085.74L26780.7,3071.18Z\" fill=\"currentColor\"/><g transform=\"matrix(0.646617,4.14441e-17,-7.12688e-16,0.961046,9525,1376.59)\"><path d=\"M26708.5,1756.75L26723.1,1773.18L26649.1,1793.01L26649.1,1771.62C26669.1,1765.82 26689,1760.57 26708.5,1756.75Z\" fill=\"currentColor\"/></g></g></g></g></g></svg>",
			scheduled:   true,
			paused:      false,
			threads:     5,
		},
		{
			name:        "Ola",
			description: "Answers questions about the account and its work.",
			schedule:    "",
			color:       "#f97316",
			customSVG:   "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 200 200\" width=\"16\" height=\"16\"><path d=\"M 100 30 A 66 66 0 0 1 166 96 L 34 96 A 66 66 0 0 1 100 30 Z\" fill=\"currentColor\"/><rect x=\"18\" y=\"112\" width=\"164\" height=\"15\" rx=\"7.5\" fill=\"currentColor\"/><rect x=\"18\" y=\"140\" width=\"104\" height=\"15\" rx=\"7.5\" fill=\"currentColor\"/></svg>",
			scheduled:   false,
			paused:      false,
			threads:     4,
		},
		{
			name:        "Any",
			description: "The general assistant, for anything that has no home yet.",
			schedule:    "",
			color:       "#f59e0b",
			customSVG:   "",
			scheduled:   false,
			paused:      false,
			threads:     11,
		},
		{
			name:        "Dip Reach",
			description: "Finds things out and writes them down.",
			schedule:    "",
			color:       "#6b7280",
			customSVG:   "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"m21 21-4.34-4.34\"/><circle cx=\"11\" cy=\"11\" r=\"8\"/></svg>",
			scheduled:   false,
			paused:      false,
			threads:     6,
		},
		{
			name:        "Amebo",
			description: "Collects the week\\'s threads into one roundup.",
			schedule:    "Amebo's Roundup",
			color:       "#64748b",
			customSVG:   "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 11a9 9 0 0 1 9 9\"/><path d=\"M4 4a16 16 0 0 1 16 16\"/><circle cx=\"5\" cy=\"19\" r=\"1\"/></svg>",
			scheduled:   true,
			paused:      false,
			threads:     5,
		},
	}
}
