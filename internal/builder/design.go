package builder

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

// Rules every stack shares; the look itself comes from the app's own design direction, never from a fixed template.
const designRules = `
DESIGN:
- Follow the DESIGN DIRECTION and each page's SCREEN PLAN: they decide the layout, the regions and their order. Build what they say, at the polish of a top SaaS product.
- Build every signature component it names, and make the first screen the most striking one: it is the first thing the user sees.
- Colours, fonts and corner radius are already set in the theme tokens for this app. Use the theme classes and tokens only; never hard-code colours. Gradients are fine when built from the tokens.
- Display text (titles, hero lines, big numbers) uses the font-heading class so it takes the app's heading face.
- There are no image files and no image URLs: never reference .jpg, .png or remote images. Draw artwork (covers, thumbnails, hero art) as a block filled with a gradient from the theme colours holding a large icon that fits the item (the kit's .cover class in plain HTML), varying the icon per item.
- Every action has an icon; icons also mark empty states and section headings. No emoji.
- Show state: an empty state (icon, title, one line, action) when a list is empty; a spinner or skeletons while waiting; a toast after saving, deleting or when something fails.
- Responsive and mobile first: nothing overflows at 375px wide, grids collapse to one column, navigation stays reachable on phones.
- Seed 4-8 realistic, specific records (real dish names, real lesson titles, real amounts) so the first screen looks alive, and make every control work.`

const kitReference = `
UI KIT (ui.css and ui.js already exist; do NOT generate them). Build screens from these classes and compose them into the layout the design direction describes:
- Shell: .app > header.app-header > .container (.brand > .brand-mark + name, .spacer, buttons); main.app-main > .container. Navigation: aside.sidebar inside .layout (240px + main) with a.nav-item; nav.topnav with links; nav.bottomnav fixed at the bottom (add class has-bottomnav to .app). Active links get class active.
- Composition: .hero (a tinted banner for the screen's headline), .cover (a block filled with the primary colour that holds a large icon, for card artwork), .page-header > (div > h1.page-title + p.page-description) + .row of buttons, .stack, .stack-sm, .row, .between, .spacer, .grid (auto-fill cards), .grid-2/.grid-3/.grid-4, .layout.layout-wide-aside (main + 360px aside), .font-heading.
- Card: .card > .card-header(.card-title, .card-description) + .card-content + .card-footer; .interactive for clickable cards. Stats: .stat-label + .stat-value inside .card-content.
- Buttons: .btn (primary), .btn-secondary, .btn-outline, .btn-ghost, .btn-destructive, .btn-link; sizes .btn-sm, .btn-lg, .btn-block. .btn-icon is ONLY for icon-only buttons (give them aria-label).
- Forms: .field > label.label + .input / .textarea / select.select + .hint. .input-group > <i data-icon="search"></i> + .input. input.switch[type=checkbox], input.checkbox.
- Badges: .badge, .badge-secondary, .badge-outline, .badge-success, .badge-warning, .badge-destructive.
- Tabs: div[data-tabs] > .tabs-list > button[data-tab="x"] ... and div[data-panel="x"] for each tab (ui.js wires them).
- Lists: .card > .list > .list-item (.list-item-title, .list-item-meta; aria-current="true" for the selected one). Tables: .table-wrap > table.table.
- Others: .avatar, .separator, .skeleton (give it a height), .progress > div[style=width:x%], .alert, .empty > .empty-icon + .empty-title + .empty-text + button, .spinner, .kbd, .muted, .text-sm, .text-xs, .font-medium, .truncate, .hide-mobile.
- Dialog: <dialog class="dialog" id="x"> with .dialog-title, .dialog-description, .dialog-body, .dialog-footer; open with a button[data-dialog-open="x"], close with [data-dialog-close].
- Icons: <i data-icon="NAME"></i> (also inside HTML you build in JS; they render automatically). Names: plus x check trash pencil search settings inbox mail send sparkles copy download upload star heart calendar clock user users home list grid filter chevron-right chevron-down arrow-right arrow-left more bell bookmark tag file-text image link moon sun refresh alert-circle check-circle info external-link play zap chart message folder menu map-pin shopping-cart wallet book target trending-up activity utensils bot layout log-out.
- JS helpers: ui.toast(title, {description, variant: "destructive"}), ui.busy(button, true|false) for loading buttons, ui.openDialog(id), ui.closeDialog(id). Put <button class="btn btn-ghost btn-icon" data-theme-toggle></button> in the header for dark mode.`

func shadcnReference(ext, alias string) string {
	return fmt.Sprintf(`
SHADCN/UI COMPONENTS (already in %[2]scomponents/ui; do NOT generate them). Named imports only, lowercase paths:
  import { Button } from "%[2]scomponents/ui/button"            // variant: default|secondary|outline|ghost|destructive|link, size: default|sm|lg|icon
  import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "%[2]scomponents/ui/card"
  import { Input } from "%[2]scomponents/ui/input"
  import { Textarea } from "%[2]scomponents/ui/textarea"
  import { Label } from "%[2]scomponents/ui/label"
  import { Select } from "%[2]scomponents/ui/select"            // native select: <Select value={v} onChange={(e) => setV(e.target.value)}><option value="a">A</option></Select>
  import { Badge } from "%[2]scomponents/ui/badge"              // variant: default|secondary|outline|success|warning|destructive
  import { Tabs, TabsList, TabsTrigger, TabsContent } from "%[2]scomponents/ui/tabs"
  import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "%[2]scomponents/ui/dialog"
  import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "%[2]scomponents/ui/table"
  import { Switch } from "%[2]scomponents/ui/switch"            // <Switch checked={on} onCheckedChange={setOn} />
  import { Separator } from "%[2]scomponents/ui/separator"
  import { Skeleton } from "%[2]scomponents/ui/skeleton"
  import { Progress } from "%[2]scomponents/ui/progress"
  import { Avatar, AvatarFallback } from "%[2]scomponents/ui/avatar"
  import { EmptyState } from "%[2]scomponents/ui/empty-state"   // <EmptyState icon={<Inbox />} title="..." description="..." action={<Button>..</Button>} />
  import { Checkbox } from "%[2]scomponents/ui/checkbox"        // <Checkbox checked={on} onCheckedChange={setOn} />
  import { Slider } from "%[2]scomponents/ui/slider"            // <Slider value={[n]} min={0} max={10} step={1} onValueChange={([v]) => setN(v)} />
  import { RadioGroup, RadioGroupItem } from "%[2]scomponents/ui/radio-group"
  import { Alert, AlertTitle, AlertDescription } from "%[2]scomponents/ui/alert"
  import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "%[2]scomponents/ui/accordion"
  import { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from "%[2]scomponents/ui/sheet"   // side: right|left|top|bottom
  import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "%[2]scomponents/ui/dropdown-menu"
  import { Popover, PopoverTrigger, PopoverContent } from "%[2]scomponents/ui/popover"
  import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "%[2]scomponents/ui/tooltip"
  import { ScrollArea } from "%[2]scomponents/ui/scroll-area"
  import { ThemeToggle } from "%[2]scomponents/ui/theme-toggle"
  import { toast } from "%[2]scomponents/ui/toast"              // toast("Saved") or toast("Failed", { description, variant: "destructive" }); the Toaster is already mounted
  import { cn } from "%[2]slib/utils"
Icons: import { Plus, Trash2, Search, Sparkles, ... } from "lucide-react" (any Lucide icon name). Put icons inside Buttons directly; they size themselves.
Style with Tailwind theme classes only: bg-background, bg-card, bg-muted, bg-accent, text-foreground, text-muted-foreground, text-primary, bg-primary, text-primary-foreground, border, ring-ring, rounded-lg (follows the app's radius), font-heading, opacity modifiers like bg-primary/10, gradients from them (bg-gradient-to-br from-primary/20 to-accent), and responsive prefixes (sm:, md:, lg:). Never use arbitrary colours (no bg-[#...], no bg-blue-500, no text-gray-*). Components are %[1]s files.`, ext, alias)
}

// The art director's plan for one app: navigation, layout, signature pieces and a full palette, so every app looks like its subject.
type DesignDirection struct {
	Concept     string   `json:"concept"`
	Inspiration string   `json:"inspiration,omitempty"`
	Navigation  string   `json:"navigation"`
	Layout      string   `json:"layout"`
	Signature   []string `json:"signature,omitempty"`
	Mood        string   `json:"mood,omitempty"`
	HeadingFont string   `json:"heading_font,omitempty"`
	BodyFont    string   `json:"body_font,omitempty"`
	Radius      string   `json:"radius,omitempty"`
	Density     string   `json:"density,omitempty"`
	Light       *Palette `json:"light,omitempty"`
	Dark        *Palette `json:"dark,omitempty"`
	BrandIcon   string   `json:"brand_icon,omitempty"`
	// One plan per page: its layout pattern and its regions top to bottom.
	Screens []ScreenPlan `json:"screens,omitempty"`
}

type ScreenPlan struct {
	Route    string   `json:"route"`
	Layout   string   `json:"layout"`
	Sections []string `json:"sections"`
}

type Palette struct {
	Background      string `json:"background"`
	Foreground      string `json:"foreground"`
	Card            string `json:"card"`
	Muted           string `json:"muted"`
	MutedForeground string `json:"muted_foreground"`
	Primary         string `json:"primary"`
	Accent          string `json:"accent"`
	Border          string `json:"border"`
}

const designSystem = `You are the design lead at a studio that builds category-leading SaaS products. Given a product spec, you decide this app's visual identity and the complete layout of every screen, at the level of Linear, Notion, Stripe or Airbnb: a clear hierarchy, generous structure, the right pattern for each screen's job, nothing generic.

Think first (silently, never output this): what do the best products in this domain look like, and what does each screen need to help the user do first? Which pattern serves that job best (a dashboard of what matters today, a gallery to browse, a table to manage many records, a list and detail to triage, a board to move work through stages, a focused editor, a step-by-step wizard, a conversation)? Which 3-5 visual pieces would make someone recognise the app from one screenshot?

The look comes from the subject, never from a template. A cookbook is a warm food magazine: cream paper, serif headlines, big recipe cards with cover art, a calm full-screen cook mode. A coding tutor is a focused studio with the editor at its heart. A fitness tracker is energetic, with bold numbers and progress rings. A journaling app is quiet and literary. A finance tool is a crisp, dense dashboard. Only admin and analytics products should look like a SaaS dashboard. The user's look-and-feel decision, when given, is binding.

Return ONLY a JSON object, no code fences and no prose:
{
  "concept": "Two sentences: the visual idea and how it feels to use",
  "inspiration": "2-3 real products or publications it borrows from",
  "navigation": "top | sidebar | bottom | none",
  "layout": "How the first screen is composed, region by region, and how the other screens follow it",
  "signature": ["3-5 distinctive components and exactly how each looks"],
  "mood": "3-4 adjectives",
  "heading_font": "serif | sans | rounded | geometric | humanist | mono",
  "body_font": "sans | serif | rounded | humanist",
  "radius": "none | small | medium | large",
  "density": "airy | balanced | compact",
  "brand_icon": "A lucide-react icon name for the logo, e.g. ChefHat, GraduationCap, Wallet, Dumbbell",
  "screens": [{"route": "the page's route from the spec", "layout": "dashboard | gallery | table | list-detail | board | editor | wizard | feed | detail | settings | chat | split", "sections": ["Each region top to bottom: the block it uses and exactly what it shows, e.g. 'Hero: tonight's dish, its cook time and a Start cooking button'"]}],
  "light": {"background": "#hex", "foreground": "#hex", "card": "#hex", "muted": "#hex", "muted_foreground": "#hex", "primary": "#hex", "accent": "#hex", "border": "#hex"},
  "dark": {"background": "#hex", "foreground": "#hex", "card": "#hex", "muted": "#hex", "muted_foreground": "#hex", "primary": "#hex", "accent": "#hex", "border": "#hex"}
}
Screens are built from these blocks, so plan with them: Page header (title, description, actions), Hero banner, StatGrid of StatCards (number, change, trend), Section (titled card), BarChart, Sparkline, ProgressRing, DataTable (search, sort), CardGrid of MediaCards (drawn cover art, meta, badges), ListDetail, SplitLayout (main column plus a side column), FilterBar with ChipGroup, Board (drag between columns), Stepper, Timeline, AIPanel (an AI feature with its result), ChatPanel.

Rules:
- Plan every page in the spec in "screens", with 3-6 sections each. Pick each screen's layout for its job, and make screens differ where their jobs differ. The first screen is the most useful one: what the user needs right now, not a list of links.
- Put every AI feature where it is used, in an AIPanel or ChatPanel next to the content it works on.
- navigation: sidebar for tools and workspaces (most SaaS apps), top for content apps with 3-6 sections, bottom for phone-first companions and habit apps, none for a single-screen tool.
- The palette belongs to the subject, not grey plus one accent. Backgrounds may be tinted (cream, paper, sage, slate, deep navy). primary is the brand colour; accent is a soft tint for highlights and selected states; muted is a quiet surface; border is subtle.
- Text must be easy to read: foreground on background and on card at 4.5:1 or more, muted_foreground on background at 3.5:1 or more. The dark palette is the same identity at night, not inverted grey.`

// Asks the art director for this app's look; a failure leaves the app on the neutral theme with a subject-led brief.
func designDirection(prd *PRD, decisions string) *DesignDirection {
	spec, _ := json.Marshal(prdForCode(prd))
	msg := "Product spec:\n" + string(spec) + "\n\nThe user's design decisions:\n" + decisions + "\nDesign this app's look."
	var d DesignDirection
	if err := askJSON(designSystem, msg, 5000, &d); err != nil || strings.TrimSpace(d.Concept) == "" {
		return nil
	}
	switch d.Navigation {
	case "top", "sidebar", "bottom", "none":
	default:
		d.Navigation = "top"
	}
	return &d
}

var navigationNotes = map[string]string{
	"top":     "a header with the app name and a row of section links (icon + label) under or beside it; on phones the links scroll sideways",
	"sidebar": "a sidebar of section links (icon + label) beside the content on desktop; on phones it becomes a scrolling row of tabs",
	"bottom":  "a bottom tab bar with icon + label for each section, fixed to the bottom on every screen size, and a slim header",
	"none":    "no navigation bar: one screen, with secondary panels opened in place (dialogs, drawers or tabs)",
}

// The direction as prompt text; with none, the model is still told to design for the subject.
func designBrief(d *DesignDirection) string {
	if d == nil {
		return "\n\nDESIGN DIRECTION: design for this app's subject (what the best product in its category looks like), not a generic admin dashboard. Navigation: " + navigationNotes["top"] + "."
	}
	var b strings.Builder
	b.WriteString("\n\nDESIGN DIRECTION (this app's own look; follow it closely, it is what makes the app recognisably about its subject):\n")
	fmt.Fprintf(&b, "- Concept: %s\n", d.Concept)
	if d.Inspiration != "" {
		fmt.Fprintf(&b, "- Inspiration: %s\n", d.Inspiration)
	}
	if d.Mood != "" || d.Density != "" {
		fmt.Fprintf(&b, "- Mood: %s; density: %s\n", d.Mood, d.Density)
	}
	fmt.Fprintf(&b, "- Navigation: %s.\n", navigationNotes[d.Navigation])
	fmt.Fprintf(&b, "- Layout: %s\n", d.Layout)
	if len(d.Signature) > 0 {
		b.WriteString("- Signature components (build each one):\n")
		for _, s := range d.Signature {
			fmt.Fprintf(&b, "  - %s\n", s)
		}
	}
	fmt.Fprintf(&b, "- Type: display text uses font-heading (a %s face); body text uses the %s face.\n", orDefault(d.HeadingFont, "sans"), orDefault(d.BodyFont, "sans"))
	b.WriteString("- The palette, fonts and corner radius are already in the theme tokens, so theme classes come out in this app's colours.")
	return b.String()
}

func orDefault(s, d string) string {
	if strings.TrimSpace(s) == "" {
		return d
	}
	return s
}

// System font stacks only: generated apps load no remote fonts.
var fontStacks = map[string]string{
	"sans":      `"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`,
	"serif":     `"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, Cambria, serif`,
	"rounded":   `ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", "Segoe UI", system-ui, sans-serif`,
	"geometric": `"Avenir Next", Avenir, "Montserrat", "Century Gothic", "Segoe UI", system-ui, sans-serif`,
	"humanist":  `"Seravek", "Gill Sans Nova", "Gill Sans", "Segoe UI", Ubuntu, Calibri, sans-serif`,
	"mono":      `ui-monospace, "JetBrains Mono", "SF Mono", "Cascadia Code", Consolas, monospace`,
}

var radii = map[string]string{"none": "0.25rem", "small": "0.375rem", "medium": "0.75rem", "large": "1.25rem"}

type rgb struct{ r, g, b float64 }

func parseHex(s string) (rgb, bool) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "#")
	if len(s) == 3 {
		s = string([]byte{s[0], s[0], s[1], s[1], s[2], s[2]})
	}
	if len(s) != 6 {
		return rgb{}, false
	}
	v, err := strconv.ParseUint(s, 16, 32)
	if err != nil {
		return rgb{}, false
	}
	return rgb{float64(v>>16&255) / 255, float64(v>>8&255) / 255, float64(v&255) / 255}, true
}

func (c rgb) luminance() float64 {
	lin := func(v float64) float64 {
		if v <= 0.03928 {
			return v / 12.92
		}
		return math.Pow((v+0.055)/1.055, 2.4)
	}
	return 0.2126*lin(c.r) + 0.7152*lin(c.g) + 0.0722*lin(c.b)
}

func contrast(a, b rgb) float64 {
	la, lb := a.luminance(), b.luminance()
	if la < lb {
		la, lb = lb, la
	}
	return (la + 0.05) / (lb + 0.05)
}

func mix(a, b rgb, t float64) rgb {
	return rgb{a.r + (b.r-a.r)*t, a.g + (b.g-a.g)*t, a.b + (b.b-a.b)*t}
}

// shadcn tokens hold "H S% L%" without the hsl() wrapper.
func (c rgb) hsl() string {
	max, min := math.Max(c.r, math.Max(c.g, c.b)), math.Min(c.r, math.Min(c.g, c.b))
	l := (max + min) / 2
	var h, s float64
	if d := max - min; d > 0 {
		if l > 0.5 {
			s = d / (2 - max - min)
		} else {
			s = d / (max + min)
		}
		switch max {
		case c.r:
			h = math.Mod((c.g-c.b)/d, 6)
		case c.g:
			h = (c.b-c.r)/d + 2
		default:
			h = (c.r-c.g)/d + 4
		}
		h *= 60
		if h < 0 {
			h += 360
		}
	}
	return fmt.Sprintf("%.1f %.1f%% %.1f%%", h, s*100, l*100)
}

var (
	white = rgb{1, 1, 1}
	ink   = rgb{0.07, 0.07, 0.08}
)

// The text colour that reads best on c.
func readableOn(c rgb) rgb {
	if contrast(white, c) >= contrast(ink, c) {
		return white
	}
	return ink
}

// One palette as token overrides; an unreadable or incomplete palette returns "" and the template's neutral one stays.
func paletteCSS(sel string, p *Palette) string {
	if p == nil {
		return ""
	}
	var c [8]rgb
	for i, hex := range []string{p.Background, p.Foreground, p.Card, p.Muted, p.MutedForeground, p.Primary, p.Accent, p.Border} {
		v, ok := parseHex(hex)
		if !ok {
			return ""
		}
		c[i] = v
	}
	bg, fg, card, muted, mutedFg, primary, accent, border := c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]
	if contrast(fg, bg) < 4.5 || contrast(fg, card) < 4.5 {
		return ""
	}
	for t := 0.1; contrast(mutedFg, bg) < 3.5 && t <= 1; t += 0.1 {
		mutedFg = mix(mutedFg, fg, t)
	}
	accentFg := fg
	if contrast(fg, accent) < 4.5 {
		accentFg = readableOn(accent)
	}
	tokens := [][2]string{
		{"background", bg.hsl()}, {"foreground", fg.hsl()}, {"card", card.hsl()}, {"card-foreground", fg.hsl()},
		{"popover", card.hsl()}, {"popover-foreground", fg.hsl()}, {"muted", muted.hsl()}, {"muted-foreground", mutedFg.hsl()},
		{"primary", primary.hsl()}, {"primary-foreground", readableOn(primary).hsl()}, {"secondary", muted.hsl()}, {"secondary-foreground", fg.hsl()},
		{"accent", accent.hsl()}, {"accent-foreground", accentFg.hsl()}, {"border", border.hsl()}, {"input", border.hsl()}, {"ring", primary.hsl()},
	}
	var b strings.Builder
	b.WriteString(sel + " {")
	for _, t := range tokens {
		fmt.Fprintf(&b, " --%s: %s;", t[0], t[1])
	}
	b.WriteString(" }\n")
	return b.String()
}

// shadcn's official accent themes, for an app without a design direction; the style note picks one.
var accentThemes = []struct {
	words       []string
	light, dark [3]string
}{
	{[]string{"blue", "ocean", "sky", "navy", "corporate", "trust"}, [3]string{"221.2 83.2% 53.3%", "210 40% 98%", "221.2 83.2% 53.3%"}, [3]string{"217.2 91.2% 59.8%", "222.2 47.4% 11.2%", "224.3 76.3% 48%"}},
	{[]string{"violet", "purple", "indigo", "lavender", "creative"}, [3]string{"262.1 83.3% 57.8%", "210 20% 98%", "262.1 83.3% 57.8%"}, [3]string{"263.4 70% 50.4%", "210 20% 98%", "263.4 70% 50.4%"}},
	{[]string{"green", "emerald", "nature", "eco", "health", "fresh", "mint"}, [3]string{"142.1 76.2% 36.3%", "355.7 100% 97.3%", "142.1 76.2% 36.3%"}, [3]string{"142.1 70.6% 45.3%", "144.9 80.4% 10%", "142.4 71.8% 29.2%"}},
	{[]string{"orange", "amber", "warm", "food", "energetic", "sunset"}, [3]string{"24.6 95% 53.1%", "60 9.1% 97.8%", "24.6 95% 53.1%"}, [3]string{"20.5 90.2% 48.2%", "60 9.1% 97.8%", "20.5 90.2% 48.2%"}},
	{[]string{"rose", "pink", "red", "romantic", "bold"}, [3]string{"346.8 77.2% 49.8%", "355.7 100% 97.3%", "346.8 77.2% 49.8%"}, [3]string{"346.8 77.2% 49.8%", "355.7 100% 97.3%", "346.8 77.2% 49.8%"}},
}

func accentCSS(uiNote string) string {
	note := strings.ToLower(uiNote)
	for _, t := range accentThemes {
		for _, w := range t.words {
			if strings.Contains(note, w) {
				return fmt.Sprintf(":root { --primary: %s; --primary-foreground: %s; --ring: %s; }\n.dark { --primary: %s; --primary-foreground: %s; --ring: %s; }\n",
					t.light[0], t.light[1], t.light[2], t.dark[0], t.dark[1], t.dark[2])
			}
		}
	}
	return ""
}

// The app's theme, appended after the template's tokens so it wins: the direction's palettes, fonts and radius, else an accent from the style note.
func themeCSS(prd *PRD) string {
	d := prd.Design
	colours := ""
	if d != nil {
		colours = paletteCSS(":root", d.Light) + paletteCSS(".dark", d.Dark)
	}
	if colours == "" {
		colours = accentCSS(prd.UINote)
	}
	shape := ""
	if d != nil {
		heading, body := fontStacks[d.HeadingFont], fontStacks[d.BodyFont]
		if heading == "" {
			heading = fontStacks["sans"]
		}
		if body == "" {
			body = fontStacks["sans"]
		}
		shape = fmt.Sprintf(":root { --font-heading: %s; --font-body: %s; --font: %s;", heading, body, body)
		if r := radii[d.Radius]; r != "" {
			shape += " --radius: " + r + ";"
		}
		shape += " }\nbody, .font-sans { font-family: var(--font-body); }\nh1, h2, h3, .page-title, .card-title, .font-heading { font-family: var(--font-heading); letter-spacing: -0.01em; }\n"
	}
	if colours == "" && shape == "" {
		return ""
	}
	return "\n/* This app's theme, from Build mode's design direction. */\n" + colours + shape
}

func appendTheme(file string, prd *PRD) {
	css := themeCSS(prd)
	if css == "" {
		return
	}
	if f, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0644); err == nil {
		f.WriteString(css)
		f.Close()
	}
}

// Copies one embedded template file or directory to dst.
func copyTemplate(src, dst string) error {
	root := "builder-template/" + src
	return fs.WalkDir(templateFS, root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(strings.TrimPrefix(p, root), "/")
		target := filepath.Join(dst, filepath.FromSlash(rel))
		if d.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		data, err := fs.ReadFile(templateFS, p)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		return os.WriteFile(target, data, 0644)
	})
}

// Puts the stack's design system in place: shadcn/ui for the Vite app (shared with the Next.js template), the CSS kit for plain HTML.
func installDesignSystem(workdir string, stack Stack, prd *PRD) error {
	switch stack.UI {
	case "react":
		pairs := [][2]string{
			{"nextjs/components/ui", "src/components/ui"},
			{"nextjs/components/blocks", "src/components/blocks"},
			{"nextjs/lib/utils.ts", "src/lib/utils.ts"},
			{"nextjs/app/globals.css", "src/index.css"},
			{"nextjs/tailwind.config.ts", "tailwind.config.ts"},
		}
		for _, p := range pairs {
			if err := copyTemplate(p[0], filepath.Join(workdir, filepath.FromSlash(p[1]))); err != nil {
				return err
			}
		}
		appendTheme(filepath.Join(workdir, "src", "index.css"), prd)
	case "vanilla":
		dir := filepath.Join(workdir, filepath.FromSlash(stack.UIDir))
		for _, f := range []string{"ui.css", "ui.js"} {
			if err := copyTemplate(path.Join("_kit", f), filepath.Join(dir, f)); err != nil {
				return err
			}
		}
		appendTheme(filepath.Join(dir, "ui.css"), prd)
	}
	return nil
}
