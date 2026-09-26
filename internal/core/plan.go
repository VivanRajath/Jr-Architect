package core

// One runnable thing in the repo. A monorepo has several; most repos have one.
// It lives here rather than in detect because the registry, the server and the
// detector all speak it.
type Service struct {
	Name          string `json:"name"`
	Dir           string `json:"dir"` // repo-relative, forward slashes; "" is the root
	Stack         string `json:"stack"`
	Framework     string `json:"framework"`
	ContainerPort int    `json:"port"` // 0 means the service serves no HTTP
	HostPort      int    `json:"hostPort"`
	Install       string `json:"install"`
	Start         string `json:"start"`
	Primary       bool   `json:"primary"`
	Enabled       bool   `json:"enabled"`
}

// What a scan found, and what it would take to run it.
type Plan struct {
	Services   []Service `json:"services"`
	Stacks     []string  `json:"stacks"`
	Image      string    `json:"image"`
	NeedsBuild bool      `json:"needsBuild"`
}

// Install and Start rejoined, for the callers that want one string.
func (s Service) FullCommand() string {
	if s.Install == "" {
		return s.Start
	}
	return s.Install + " && " + s.Start
}

func (p Plan) Primary() (Service, bool) {
	for _, s := range p.Services {
		if s.Primary && s.Enabled {
			return s, true
		}
	}
	for _, s := range p.Services {
		if s.Enabled {
			return s, true
		}
	}
	if len(p.Services) > 0 {
		return p.Services[0], true
	}
	return Service{}, false
}

// Every service the user left switched on, in plan order.
func (p Plan) Enabled() []Service {
	var out []Service
	for _, s := range p.Services {
		if s.Enabled {
			out = append(out, s)
		}
	}
	return out
}
