package gitagent

import (
	"strings"
	"testing"
)

// Detection maps a Django repo to the "django" stack, so the guidance keyed to that name has to exist or the agent falls back to generic Python advice.
func TestDjangoStackGuidance(t *testing.T) {
	cases := map[string]struct {
		got  string
		want string
	}{
		"Rules":       {Rules("django"), "urls.py"},
		"Layout":      {Layout("django"), "manage.py"},
		"Conventions": {Conventions("django"), "csrf_token"},
		"UIFilePaths": {UIFilePaths("django"), "templates/"},
	}
	for name, c := range cases {
		if !strings.Contains(c.got, c.want) {
			t.Errorf("%s(\"django\") = %q, want it to mention %q", name, c.got, c.want)
		}
	}
}
