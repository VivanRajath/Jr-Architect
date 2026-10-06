package detect

import "testing"

func TestNormalizeInstall(t *testing.T) {
	cases := map[string]string{
		"npm install && npm run dev -- -H 0.0.0.0":         "npm install --prefer-offline --no-audit --no-fund --progress=false --loglevel=error && npm run dev -- -H 0.0.0.0",
		"pip install -r requirements.txt && python app.py": "pip install --no-input --disable-pip-version-check -r requirements.txt && python app.py",
		"go mod tidy && go run .":                          "go mod tidy && go run .", // untouched
	}
	for in, want := range cases {
		if got := NormalizeInstall(in); got != want {
			t.Errorf("NormalizeInstall(%q)\n got  %q\n want %q", in, got, want)
		}
	}
	// Idempotent: already-flagged command is left alone.
	flagged := "npm install --no-audit && npm run dev"
	if got := NormalizeInstall(flagged); got != flagged {
		t.Errorf("NormalizeInstall should be idempotent, got %q", got)
	}
}
